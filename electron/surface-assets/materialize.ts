import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentlasSurfaceDataSet,
  AgentlasSurfaceManifest,
  JsonObject,
  JsonValue,
  SurfaceAssetPackGeneratedFile,
  SurfaceAssetPackMaterializeResult,
  SurfaceAssetPackRemoteAsset,
  SurfaceAssetPackRequest,
  SurfaceAssetPackRootRequest,
  SurfaceAssetPackSnapshot,
} from "../../shared/types";

interface MaterializeOptions {
  baseDir: string;
  now?: string;
  downloadRemoteAssets?: boolean;
}

interface PackFile {
  path: string;
  kind: SurfaceAssetPackGeneratedFile["kind"];
  content: string | Buffer;
}

interface LocalAsset {
  id: string;
  label: string;
  path: string;
  mediaType: string;
  evidenceIds?: string[];
  sourceData?: string;
  sourceUrl?: string;
  downloadedAt?: string;
  bytes?: number;
  content?: Buffer;
}

interface AssetPackModel {
  packId: string;
  packName: string;
  createdAt: string;
  sourceSurface: {
    id: string;
    title: string;
    domain: string;
    layout: string;
    actionId?: string;
  };
  brief: JsonValue | undefined;
  shots: JsonObject[];
  exports: JsonObject[];
  launch: JsonObject[];
  localAssets: LocalAsset[];
  remoteAssets: SurfaceAssetPackRemoteAsset[];
  trust: {
    evidence: AgentlasSurfaceManifest["evidence"];
    claims: AgentlasSurfaceManifest["claims"];
    capabilities: AgentlasSurfaceManifest["capabilities"];
    budget: AgentlasSurfaceManifest["budget"];
    jobs: AgentlasSurfaceManifest["jobs"];
    stateSchema: AgentlasSurfaceManifest["stateSchema"];
  };
}

const FORBIDDEN_FILE_CHARS = /[^a-z0-9._-]+/g;
const MAX_INLINE_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_REMOTE_MEDIA_BYTES = 25 * 1024 * 1024;
const REMOTE_FETCH_TIMEOUT_MS = 10_000;

export async function materializeSurfaceAssetPack(
  request: SurfaceAssetPackRequest,
  options: MaterializeOptions,
): Promise<SurfaceAssetPackMaterializeResult> {
  if (!path.isAbsolute(options.baseDir)) {
    throw new Error("Surface asset pack baseDir must be an absolute path.");
  }
  const manifest = request.manifest;
  if (manifest.kind !== "surface") {
    throw new Error("Surface asset packs can only be materialized from Agentlas surfaces.");
  }

  const now = options.now ?? new Date().toISOString();
  const packName = stringValue(manifest.app?.name) || manifest.title || "Agentlas Asset Pack";
  const packId = `${slugify(packName)}-${shortId(`${request.surfaceId}:${request.actionId ?? "pack"}:${now}`)}`;
  const rootPath = path.join(options.baseDir, "agentlas-asset-packs", packId);
  const model = buildPackModel(request, { packId, packName, now });
  if (options.downloadRemoteAssets) {
    await hydrateRemoteAssets(manifest, model, now);
  }
  const files = buildPackFiles(manifest, model);

  await fs.mkdir(rootPath, { recursive: true });
  const written: SurfaceAssetPackGeneratedFile[] = [];
  for (const file of files) {
    const absPath = path.join(rootPath, file.path);
    assertInside(rootPath, absPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, file.content);
    written.push({
      path: file.path,
      kind: file.kind,
      bytes: Buffer.isBuffer(file.content)
        ? file.content.byteLength
        : Buffer.byteLength(file.content, "utf8"),
    });
  }

  const indexPath = path.join(rootPath, "index.html");
  const snapshot: SurfaceAssetPackSnapshot = {
    packId,
    packName,
    rootPath,
    manifestPath: path.join(rootPath, "agentlas.asset-pack.json"),
    indexPath,
    assetsPath: path.join(rootPath, "assets"),
    fileUrl: pathToFileURL(indexPath).toString(),
    createdAt: now,
    files: written,
    remoteAssets: model.remoteAssets,
    summary: `${packName} materialized with ${model.localAssets.length} local assets, ${model.remoteAssets.length} remote references, ${model.shots.length} storyboard shots, and ${model.exports.length} export rows.`,
  };

  return {
    ...snapshot,
    fileUrl: snapshot.fileUrl ?? pathToFileURL(snapshot.indexPath).toString(),
  };
}

export async function archiveSurfaceAssetPack(input: SurfaceAssetPackRootRequest): Promise<{
  rootPath: string;
  archivePath: string;
  manifestPath: string;
  archivedAt: string;
  removed: boolean;
  reversible: boolean;
  summary: string;
}> {
  if (!path.isAbsolute(input.rootPath)) {
    throw new Error("Surface asset pack rootPath must be absolute.");
  }
  const rootPath = path.resolve(input.rootPath);
  const marker = path.join(rootPath, "agentlas.asset-pack.json");
  assertInside(rootPath, marker);
  const definition = JSON.parse(await fs.readFile(marker, "utf8")) as unknown;
  const archivedAt = new Date().toISOString();
  const baseDir = assetPackBaseDir(rootPath);
  const archiveDir = path.join(baseDir, ".agentlas", "archive", "asset-packs");
  const archivePath = await nextArchivePath(archiveDir, path.basename(rootPath), archivedAt);
  assertInside(baseDir, archivePath);
  await fs.mkdir(path.dirname(archivePath), { recursive: true });

  const archiveManifestPath = path.join(rootPath, "agentlas.archive.json");
  await fs.writeFile(
    archiveManifestPath,
    `${JSON.stringify(
      {
        version: "0.1",
        kind: "agentlas-asset-pack-archive",
        originalRootPath: rootPath,
        archivePath,
        archivedAt,
        reversible: true,
        pack: archivePackSummary(definition, rootPath),
        restore: {
          operation: "surfaceAssets.restore",
          rootPath,
        },
        gc: {
          operation: "delete-archive",
          policy: "manual-confirmation-required",
          note: "Generated asset pack archives are retained until the user explicitly purges them.",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.rename(rootPath, archivePath);
  return {
    rootPath,
    archivePath,
    manifestPath: path.join(archivePath, "agentlas.archive.json"),
    archivedAt,
    removed: true,
    reversible: true,
    summary: `Generated asset pack moved to reversible archive: ${archivePath}`,
  };
}

export async function restoreSurfaceAssetPack(input: SurfaceAssetPackRootRequest): Promise<{
  rootPath: string;
  archivePath: string | null;
  restored: boolean;
  restoredAt: string;
  summary: string;
}> {
  if (!path.isAbsolute(input.rootPath)) {
    throw new Error("Surface asset pack rootPath must be absolute.");
  }
  const rootPath = path.resolve(input.rootPath);
  const marker = path.join(rootPath, "agentlas.asset-pack.json");
  assertInside(rootPath, marker);
  if (await exists(marker)) {
    return {
      rootPath,
      archivePath: null,
      restored: false,
      restoredAt: new Date().toISOString(),
      summary: "Generated asset pack already exists at its original root.",
    };
  }

  const archived = await findLatestArchivedAssetPackPath(rootPath);
  if (!archived) {
    throw new Error(`No reversible archive found for generated asset pack: ${rootPath}`);
  }
  const baseDir = assetPackBaseDir(rootPath);
  assertInside(baseDir, archived);
  await fs.mkdir(path.dirname(rootPath), { recursive: true });
  await fs.rename(archived, rootPath);
  const restoredAt = new Date().toISOString();
  return {
    rootPath,
    archivePath: archived,
    restored: true,
    restoredAt,
    summary: `Generated asset pack restored from reversible archive: ${archived}`,
  };
}

function buildPackModel(
  request: SurfaceAssetPackRequest,
  ctx: { packId: string; packName: string; now: string },
): AssetPackModel {
  const manifest = request.manifest;
  const briefData = dataByName(manifest, "brief") ?? firstData(manifest, "json");
  const shotRows = rowsOf(dataByName(manifest, "shots") ?? firstData(manifest, "table"));
  const exportRows = rowsOf(dataByName(manifest, "exports") ?? firstData(manifest, "export-pack"));
  const launchRows = rowsOf(dataByName(manifest, "launch") ?? firstData(manifest, "launch-checklist"));
  const assetRows = rowsOf(dataByName(manifest, "assets") ?? firstData(manifest, "media"));
  const localAssets: LocalAsset[] = [];
  const remoteAssets: SurfaceAssetPackRemoteAsset[] = [];

  assetRows.forEach((row, index) => {
    const normalized = normalizeAssetRow(row, index + 1);
    const inline = inlineMedia(row);
    if (inline) {
      localAssets.push({
        id: normalized.id,
        label: normalized.label,
        path: `assets/${normalized.fileBase}.${extensionFor(inline.mediaType)}`,
        mediaType: inline.mediaType,
        evidenceIds: normalized.evidenceIds,
        sourceData: normalized.sourceData,
        bytes: inline.buffer.byteLength,
        content: inline.buffer,
      });
      return;
    }
    if (normalized.url) {
      remoteAssets.push({
        id: normalized.id,
        label: normalized.label,
        url: normalized.url,
        evidenceIds: normalized.evidenceIds,
        sourceData: normalized.sourceData,
        status: "referenced",
      });
    }
  });

  return {
    packId: ctx.packId,
    packName: ctx.packName,
    createdAt: ctx.now,
    sourceSurface: {
      id: request.surfaceId,
      title: manifest.title,
      domain: manifest.domain,
      layout: manifest.layout,
      actionId: request.actionId,
    },
    brief: briefData?.value ?? briefData?.summary,
    shots: shotRows,
    exports: exportRows,
    launch: launchRows,
    localAssets,
    remoteAssets,
    trust: {
      evidence: manifest.evidence ?? [],
      claims: manifest.claims ?? [],
      capabilities: manifest.capabilities ?? [],
      budget: manifest.budget,
      jobs: manifest.jobs ?? [],
      stateSchema: manifest.stateSchema,
    },
  };
}

function buildPackFiles(manifest: AgentlasSurfaceManifest, model: AssetPackModel): PackFile[] {
  const files: PackFile[] = [
    { path: "README.md", kind: "doc", content: readme(model) },
    { path: "agentlas.asset-pack.json", kind: "manifest", content: prettyJson({ ...serializableModel(model), manifest }) },
    { path: "index.html", kind: "html", content: htmlPreview(model) },
    { path: "metadata/brief.json", kind: "metadata", content: prettyJson(model.brief ?? null) },
    { path: "metadata/storyboard.json", kind: "metadata", content: prettyJson({ shots: model.shots }) },
    { path: "metadata/exports.json", kind: "metadata", content: prettyJson({ exports: model.exports }) },
    { path: "metadata/trust.json", kind: "metadata", content: prettyJson(model.trust) },
    { path: "assets/local-assets.json", kind: "metadata", content: prettyJson({ assets: stripAssetContent(model.localAssets) }) },
    { path: "assets/remote-assets.json", kind: "metadata", content: prettyJson({ assets: model.remoteAssets }) },
  ];

  model.shots.forEach((shot, index) => {
    const title = stringField(shot, "scene") || stringField(shot, "title") || `shot-${index + 1}`;
    const prompt = stringField(shot, "prompt") || stringField(shot, "description") || "";
    const modelName = stringField(shot, "model") || "auto";
    files.push({
      path: `prompts/${String(index + 1).padStart(2, "0")}-${slugify(title)}.md`,
      kind: "prompt",
      content: `# ${md(title)}\n\n- Model: \`${md(modelName)}\`\n- Status: ${md(stringField(shot, "status") || "planned")}\n\n## Prompt\n\n${md(prompt) || "No prompt declared."}\n`,
    });
  });

  model.localAssets.forEach((asset) => {
    if (!asset.content) return;
    files.push({
      path: asset.path,
      kind: "media",
      content: asset.content,
    });
  });

  return files;
}

async function hydrateRemoteAssets(
  manifest: AgentlasSurfaceManifest,
  model: AssetPackModel,
  now: string,
): Promise<void> {
  for (const remote of model.remoteAssets) {
    if (!isAllowedRemoteAsset(manifest, remote.url)) {
      remote.status = "skipped";
      remote.reason = "No declared network/external-api capability allowlist matched this URL.";
      continue;
    }

    try {
      const downloaded = await downloadRemoteAsset(remote.url);
      const pathBase = `remote-${slugify(remote.label)}-${shortId(remote.url)}`;
      const localPath = `assets/${pathBase}.${extensionFor(downloaded.mediaType)}`;
      model.localAssets.push({
        id: `${remote.id}_downloaded`,
        label: `${remote.label} (downloaded)`,
        path: localPath,
        mediaType: downloaded.mediaType,
        evidenceIds: remote.evidenceIds,
        sourceData: remote.sourceData,
        sourceUrl: remote.url,
        downloadedAt: now,
        bytes: downloaded.buffer.byteLength,
        content: downloaded.buffer,
      });
      remote.status = "downloaded";
      remote.downloadedPath = localPath;
      remote.mediaType = downloaded.mediaType;
      remote.bytes = downloaded.buffer.byteLength;
    } catch (error) {
      remote.status = "skipped";
      remote.reason = error instanceof Error ? error.message : "Remote asset download failed.";
    }
  }
}

async function downloadRemoteAsset(url: string): Promise<{ mediaType: string; buffer: Buffer }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Agentlas/0.2 surface-asset-pack" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} while fetching remote media.`);
    }
    const mediaType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!isSupportedRemoteMediaType(mediaType)) {
      throw new Error(`Unsupported remote media type: ${mediaType || "unknown"}.`);
    }
    const declaredLength = Number(res.headers.get("content-length") || "0");
    if (declaredLength > MAX_REMOTE_MEDIA_BYTES) {
      throw new Error(`Remote media exceeds ${MAX_REMOTE_MEDIA_BYTES} bytes.`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.byteLength || buffer.byteLength > MAX_REMOTE_MEDIA_BYTES) {
      throw new Error(`Remote media exceeds ${MAX_REMOTE_MEDIA_BYTES} bytes.`);
    }
    return { mediaType, buffer };
  } finally {
    clearTimeout(timeout);
  }
}

function readme(model: AssetPackModel): string {
  return `# ${md(model.packName)}

Generated by Agentlas Surface Asset Pack on ${model.createdAt}.

## Source Surface

- Title: ${md(model.sourceSurface.title)}
- Domain: ${md(model.sourceSurface.domain)}
- Layout: ${md(model.sourceSurface.layout)}

## Contents

- Local assets: ${model.localAssets.length}
- Remote references: ${model.remoteAssets.length}
- Storyboard shots: ${model.shots.length}
- Export rows: ${model.exports.length}

## Safety Contract

This pack is materialized from declarative surface data. Agentlas does not execute model-generated code or embed secrets while creating it. Remote media is downloaded only when the surface declares a matching network/external-api capability allowlist; every remote reference and download status is recorded in \`assets/remote-assets.json\`.
`;
}

function htmlPreview(model: AssetPackModel): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${html(model.packName)}</title>
    <style>
      :root { color-scheme: light; --ink:#171717; --muted:#6b7068; --paper:#fbfaf7; --line:#dedbd2; --accent:#315f57; --soft:#e8f4ef; }
      * { box-sizing: border-box; }
      body { margin: 0; font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--paper); color: var(--ink); }
      header { padding: 30px; background: #17231f; color: white; }
      header span { color: #a7f3d0; font-size: 12px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
      h1 { margin: 8px 0 10px; font-size: clamp(26px, 5vw, 44px); line-height: 1; }
      main { padding: 24px; display: grid; gap: 18px; max-width: 1180px; margin: 0 auto; }
      section { border: 1px solid var(--line); background: white; border-radius: 8px; padding: 18px; }
      h2 { margin: 0 0 12px; font-size: 16px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
      .asset { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #f7f6f2; }
      .asset img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: #e8e4da; }
      .asset div { padding: 10px; display: grid; gap: 2px; }
      .shot { border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; gap: 6px; }
      .shot strong { font-size: 14px; }
      .shot p { margin: 0; color: var(--muted); }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { border-bottom: 1px solid var(--line); padding: 8px; text-align: left; vertical-align: top; }
      code { background: var(--soft); border-radius: 5px; padding: 2px 5px; }
      .muted { color: var(--muted); }
    </style>
  </head>
  <body>
    <header>
      <span>Agentlas Asset Pack</span>
      <h1>${html(model.packName)}</h1>
      <p>Reusable pack from ${html(model.sourceSurface.title)}. ${model.localAssets.length} local assets, ${model.remoteAssets.length} remote references, ${model.shots.length} shots.</p>
    </header>
    <main>
      <section>
        <h2>Local Assets</h2>
        <div class="grid">
          ${
            model.localAssets
              .map(
                (asset) => `<article class="asset"><img src="./${html(asset.path)}" alt="" /><div><strong>${html(asset.label)}</strong><span class="muted">${html(asset.mediaType)}</span></div></article>`,
              )
              .join("") || '<p class="muted">No inline/local media was declared. Remote references are recorded below.</p>'
          }
        </div>
      </section>
      <section>
        <h2>Storyboard</h2>
        <div class="grid">
          ${
            model.shots
              .map(
                (shot, index) => `<article class="shot"><strong>${index + 1}. ${html(stringField(shot, "scene") || stringField(shot, "title") || "Shot")}</strong><p>${html(stringField(shot, "prompt") || stringField(shot, "description") || "No prompt declared.")}</p><code>${html(stringField(shot, "model") || "auto")}</code></article>`,
              )
              .join("") || '<p class="muted">No storyboard shots declared.</p>'
          }
        </div>
      </section>
      <section>
        <h2>Exports</h2>
        ${table(model.exports)}
      </section>
      <section>
        <h2>Remote References</h2>
        ${table(model.remoteAssets as unknown as JsonObject[])}
      </section>
    </main>
  </body>
</html>
`;
}

function table(rows: JsonObject[]): string {
  if (!rows.length) return '<p class="muted">Nothing declared.</p>';
  const cols = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 6);
  return `<table><thead><tr>${cols.map((col) => `<th>${html(col)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${cols.map((col) => `<td>${html(stringify(row[col]))}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function serializableModel(model: AssetPackModel): Omit<AssetPackModel, "localAssets"> & {
  localAssets: Array<Omit<LocalAsset, "content">>;
} {
  return {
    ...model,
    localAssets: stripAssetContent(model.localAssets),
  };
}

function stripAssetContent(assets: LocalAsset[]): Array<Omit<LocalAsset, "content">> {
  return assets.map(({ content: _content, ...asset }) => asset);
}

function isAllowedRemoteAsset(manifest: AgentlasSurfaceManifest, url: string): boolean {
  const allowed = (manifest.capabilities ?? []).some((capability) => {
    if (capability.type !== "network" && capability.type !== "external-api") return false;
    return (capability.allowlist ?? []).some((entry) => allowlistMatches(entry, url));
  });
  return allowed;
}

function allowlistMatches(entry: string, url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const parsedEntry = new URL(entry);
    if (parsedUrl.origin === parsedEntry.origin) return true;
    return url.startsWith(entry.endsWith("/") ? entry : `${entry}/`);
  } catch {
    return false;
  }
}

function isSupportedRemoteMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType.startsWith("video/");
}

function normalizeAssetRow(row: JsonObject, index: number): {
  id: string;
  label: string;
  fileBase: string;
  url?: string;
  evidenceIds?: string[];
  sourceData?: string;
} {
  const label =
    stringField(row, "title") ||
    stringField(row, "name") ||
    stringField(row, "scene") ||
    stringField(row, "id") ||
    `asset-${index}`;
  const id = stringField(row, "id") || slugify(`${label}-${index}`);
  const url =
    firstUrl(row, ["url", "src", "thumbnail", "previewUrl", "imageUrl", "videoUrl"]) ||
    undefined;
  return {
    id,
    label,
    fileBase: `${String(index).padStart(2, "0")}-${slugify(label)}`,
    url,
    evidenceIds: stringArray(row.evidenceIds),
    sourceData: stringField(row, "source") || stringField(row, "provider"),
  };
}

function inlineMedia(row: JsonObject): { mediaType: string; buffer: Buffer } | null {
  const candidates = ["dataUrl", "src", "url", "thumbnail", "previewUrl", "imageUrl", "videoUrl"];
  for (const key of candidates) {
    const value = stringField(row, key);
    if (!value?.startsWith("data:")) continue;
    const parsed = parseDataUrl(value);
    if (parsed) return parsed;
  }
  const mediaType = stringField(row, "mediaType") || stringField(row, "mimeType") || stringField(row, "mime");
  const data = stringField(row, "data") || stringField(row, "base64");
  if (!mediaType || !data) return null;
  return decodeBase64(mediaType, data);
}

function parseDataUrl(value: string): { mediaType: string; buffer: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) return null;
  return decodeBase64(match[1], match[2]);
}

function decodeBase64(mediaType: string, raw: string): { mediaType: string; buffer: Buffer } | null {
  const cleaned = raw.replace(/\s+/g, "");
  const buffer = Buffer.from(cleaned, "base64");
  if (!buffer.byteLength || buffer.byteLength > MAX_INLINE_MEDIA_BYTES) return null;
  return { mediaType, buffer };
}

function dataByName(manifest: AgentlasSurfaceManifest, name: string): AgentlasSurfaceDataSet | undefined {
  return manifest.data[name];
}

function firstData(manifest: AgentlasSurfaceManifest, type: string): AgentlasSurfaceDataSet | undefined {
  return Object.values(manifest.data).find((data) => data.type === type);
}

function rowsOf(data?: AgentlasSurfaceDataSet): JsonObject[] {
  if (!data) return [];
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function firstUrl(row: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringField(row, key);
    if (value && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function stringField(row: JsonObject, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function extensionFor(mediaType: string): string {
  const normalized = mediaType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("svg")) return "svg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("mpeg")) return "mp3";
  return "bin";
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(FORBIDDEN_FILE_CHARS, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "asset-pack";
}

function shortId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside asset pack root: ${target}`);
  }
}

function assetPackBaseDir(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const packsDir = path.dirname(resolved);
  if (path.basename(packsDir) === "agentlas-asset-packs") {
    return path.dirname(packsDir);
  }
  return path.dirname(resolved);
}

async function nextArchivePath(archiveDir: string, packId: string, archivedAt: string): Promise<string> {
  const suffix = archivedAt.replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
  let candidate = path.join(archiveDir, `${packId}-${suffix}`);
  let i = 1;
  while (await exists(candidate)) {
    candidate = path.join(archiveDir, `${packId}-${suffix}-${i}`);
    i += 1;
  }
  return candidate;
}

async function findLatestArchivedAssetPackPath(rootPath: string): Promise<string | null> {
  const baseDir = assetPackBaseDir(rootPath);
  const archiveDir = path.join(baseDir, ".agentlas", "archive", "asset-packs");
  const packId = path.basename(rootPath);
  if (!(await exists(archiveDir))) return null;
  const entries = await fs.readdir(archiveDir, { withFileTypes: true });
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${packId}-`)) continue;
    const candidate = path.join(archiveDir, entry.name);
    const marker = path.join(candidate, "agentlas.asset-pack.json");
    if (!(await exists(marker))) continue;
    const stat = await fs.stat(candidate);
    matches.push({ path: candidate, mtimeMs: stat.mtimeMs });
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path ?? null;
}

function archivePackSummary(definition: unknown, rootPath: string): JsonObject {
  const parsed = isJsonObject(definition) ? definition : {};
  return {
    id: stringField(parsed, "packId") || path.basename(rootPath),
    name: stringField(parsed, "packName") || path.basename(rootPath),
    sourceSurface: isJsonObject(parsed.sourceSurface) ? parsed.sourceSurface : null,
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function md(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").trim();
}

function html(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
