import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HuggingFaceSearchResult, HuggingFaceRepositoryInspection, HuggingFaceModelSummary, LocalModelPackageIdentity } from "../../shared/local-model-hub";
import { assertLocalModelPackageIdentity } from "../../shared/local-model-hub";

const ORIGIN = "https://huggingface.co";
const REPO = /^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/;
const REVISION = /^[a-f0-9]{40}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_BYTES = 4 * 1024 * 1024;
const TTL = 6 * 60 * 60 * 1000;
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown, max = 256): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const size = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
function repository(value: unknown): string {
  if (typeof value !== "string" || !REPO.test(value) || value.split("/").some(v => v === "." || v === "..")) throw new Error("hf_invalid_repository");
  return value;
}
function gating(value: unknown): boolean | "unknown" { return value === false ? false : value === true || value === "auto" || value === "manual" ? true : "unknown"; }
function reason(error: unknown): string { return error instanceof Error && /^hf_[a-z0-9_]+$/.test(error.message) ? error.message : "hf_network_unavailable"; }

/** Public metadata only. No tokens, repository code, scripts or templates are executed. */
export class HuggingFaceModelIndex {
  constructor(private readonly cacheRoot: string, private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000) {}

  private async json(url: URL): Promise<{ value: unknown; link: string | null }> {
    if (url.origin !== ORIGIN || !url.pathname.startsWith("/api/models")) throw new Error("hf_invalid_url");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetchImpl(url, { signal: controller.signal, redirect: "error", headers: { Accept: "application/json" } });
          if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "hf_access_restricted" : response.status === 429 ? "hf_rate_limited" : response.status === 404 ? "hf_not_found" : "hf_http_error");
          if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("hf_response_too_large");
          if (!response.body) throw new Error("hf_empty_response");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = []; let bytes = 0;
          try {
            while (true) {
              const next = await reader.read(); if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > MAX_BYTES) throw new Error("hf_response_too_large");
              chunks.push(next.value);
            }
          } finally { void reader.cancel().catch(() => {}); }
          try { return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, link: response.headers.get("link") }; }
          catch { throw new Error("hf_invalid_json"); }
        })(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("hf_request_timeout")); }, this.timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }

  private async cached<T extends { syncedAt: string | null; source: "live" | "cache"; stale: boolean; reasonCode?: string }>(
    key: string, refresh: boolean, live: () => Promise<T>, empty: (code: string) => T,
  ): Promise<T> {
    const path = join(this.cacheRoot, `${digest(key)}.json`);
    let cached: T | null = null;
    try {
      if ((await stat(path)).size <= MAX_BYTES) {
        const envelope = JSON.parse(await readFile(path, "utf8")) as { key: string; value: T; digest: string };
        if (envelope.key === key && envelope.digest === digest(JSON.stringify(envelope.value)) && Number.isFinite(Date.parse(envelope.value.syncedAt ?? ""))) cached = envelope.value;
      }
    } catch { /* Missing/corrupt cache is never an empty live success. */ }
    if (cached && !refresh && Date.now() >= Date.parse(cached.syncedAt!) && Date.now() - Date.parse(cached.syncedAt!) < TTL) return { ...cached, source: "cache", stale: false };
    let value: T;
    try { value = await live(); }
    catch (error) { return cached ? { ...cached, source: "cache", stale: true, reasonCode: reason(error) } : empty(reason(error)); }
    try {
      await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ key, value, digest: digest(JSON.stringify(value)) }), { mode: 0o600 });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
      const entries = (await readdir(this.cacheRoot)).filter(v => /^[a-f0-9]{64}\.json$/.test(v));
      if (entries.length > 128) {
        const ordered = await Promise.all(entries.map(async name => ({ name, mtime: (await stat(join(this.cacheRoot, name))).mtimeMs })));
        ordered.sort((a, b) => a.mtime - b.mtime);
        await Promise.all(ordered.slice(0, entries.length - 128).map(v => rm(join(this.cacheRoot, v.name), { force: true })));
      }
    } catch { return { ...value, reasonCode: "hf_cache_write_failed" }; }
    return value;
  }

  async searchModels(input: { query: string; cursor?: string; refresh?: boolean }): Promise<HuggingFaceSearchResult> {
    if (typeof input.query !== "string" || input.query.length > 200 || /[\x00-\x1f]/.test(input.query)) throw new Error("hf_invalid_query");
    const query = input.query.trim();
    const url = new URL(`${ORIGIN}/api/models`);
    url.search = new URLSearchParams({ search: query, filter: "gguf", limit: "24", sort: "downloads", direction: "-1", full: "true" }).toString();
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== "string" || input.cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error("hf_invalid_cursor");
      try {
        const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Row;
        if (decoded.query !== query || typeof decoded.token !== "string" || decoded.token.length > 4096 || !/^[A-Za-z0-9+/=_-]+$/.test(decoded.token)) throw new Error();
        url.searchParams.set("cursor", decoded.token);
      } catch { throw new Error("hf_invalid_cursor"); }
    }
    return this.cached<HuggingFaceSearchResult>(url.href, input.refresh === true, async () => {
      const response = await this.json(url);
      if (!Array.isArray(response.value) || response.value.length > 24) throw new Error("hf_invalid_search_response");
      const models: HuggingFaceModelSummary[] = [];
      for (const value of response.value) {
        const item = row(value); if (typeof item.id !== "string" || !REPO.test(item.id)) continue;
        const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string" && tag.length <= 200).slice(0, 80) : [];
        models.push({ repository: item.id, author: text(item.author), gated: gating(item.gated), tags,
          ...(typeof item.downloads === "number" && item.downloads >= 0 ? { downloads: item.downloads } : {}),
          ...(typeof item.likes === "number" && item.likes >= 0 ? { likes: item.likes } : {}),
          ...(text(item.lastModified) ? { updatedAt: String(item.lastModified) } : {}),
          ...(tags.find(v => v.startsWith("license:")) ? { license: tags.find(v => v.startsWith("license:"))!.slice(8) } : {}),
        });
      }
      let nextCursor: string | undefined;
      const next = response.link && /<([^>]+)>;\s*rel="next"/.exec(response.link)?.[1];
      if (next && next.length <= 8192) {
        const nextUrl = new URL(next);
        const token = nextUrl.searchParams.get("cursor");
        nextUrl.searchParams.delete("cursor"); const expected = new URL(url); expected.searchParams.delete("cursor");
        if (nextUrl.href !== expected.href || !token || token.length > 4096 || !/^[A-Za-z0-9+/=_-]+$/.test(token)) throw new Error("hf_invalid_pagination");
        nextCursor = Buffer.from(JSON.stringify({ query, token })).toString("base64url");
      }
      return { models, ...(models.length !== response.value.length ? { reasonCode: "hf_partial_metadata" } : {}), ...(nextCursor ? { nextCursor } : {}), syncedAt: new Date().toISOString(), source: "live", stale: false };
    }, code => ({ models: [], syncedAt: null, source: "cache", stale: true, reasonCode: code }));
  }

  private async inspectLive(repo: string, revision?: string): Promise<HuggingFaceRepositoryInspection> {
    const url = new URL(`${ORIGIN}/api/models/${repo}${revision ? `/revision/${revision}` : ""}?blobs=true`);
    const item = row((await this.json(url)).value);
    if (item.id !== repo || typeof item.sha !== "string" || !REVISION.test(item.sha) || (revision && item.sha !== revision)) throw new Error("hf_revision_mismatch");
    if (!Array.isArray(item.siblings) || item.siblings.length > 5000) throw new Error("hf_invalid_file_list");
    const gated = gating(item.gated); const card = row(item.cardData);
    const files = item.siblings.map(row).filter(v => typeof v.rfilename === "string" && /\.gguf$/i.test(v.rfilename)).map(v => {
      const fileName = String(v.rfilename); const lfs = row(v.lfs);
      const sha256 = typeof lfs.sha256 === "string" && SHA.test(lfs.sha256) ? lfs.sha256 : null;
      const byteLength = size(lfs.size) ?? size(v.size);
      const quantization = /(?:^|[-_.])(IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*|BF16|F16|F32)(?=[-.]|$)/i.exec(fileName)?.[1]?.toUpperCase() ?? null;
      const reasonCodes: string[] = [];
      if (gated !== false) reasonCodes.push(gated === true ? "hf_gated_unsupported" : "hf_gating_unknown");
      if (!/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,255}$/.test(fileName)) reasonCodes.push("hf_nested_file_unsupported");
      if (/\d{5}-of-\d{5}/i.test(fileName)) reasonCodes.push("hf_multishard_unsupported");
      if (/mmproj|vision|projector/i.test(fileName)) reasonCodes.push("hf_projector_unsupported");
      if (!sha256) reasonCodes.push("hf_file_sha256_missing");
      if (!byteLength) reasonCodes.push("hf_file_size_missing");
      if (size(lfs.size) && size(v.size) && lfs.size !== v.size) reasonCodes.push("hf_file_size_conflict");
      return { fileName, byteLength, sha256, quantization, downloadable: reasonCodes.length === 0, reasonCodes };
    });
    return { repository: repo, revision: item.sha, publisher: text(item.author) ?? repo.split("/")[0], creator: null, converter: null,
      architecture: text(row(item.gguf).architecture, 80), license: text(card.license), gated, files,
      reasonCodes: files.length ? [] : ["hf_no_gguf_files"], syncedAt: new Date().toISOString(), source: "live", stale: false };
  }

  async inspectRepository(input: { repository: string; refresh?: boolean }): Promise<HuggingFaceRepositoryInspection> {
    const repo = repository(input.repository);
    return this.cached(`repository:${repo}`, input.refresh === true, () => this.inspectLive(repo), code => ({
      repository: repo, revision: null, publisher: null, creator: null, converter: null, architecture: null, license: null,
      gated: "unknown", files: [], reasonCodes: [code], syncedAt: null, source: "cache", stale: true, reasonCode: code,
    }));
  }

  async resolveModel(input: { repository: string; revision: string; fileName: string }): Promise<LocalModelPackageIdentity> {
    const repo = repository(input.repository);
    if (typeof input.revision !== "string" || !REVISION.test(input.revision)) throw new Error("hf_invalid_revision");
    if (typeof input.fileName !== "string" || input.fileName.length > 256) throw new Error("hf_invalid_file");
    // Always re-read the immutable revision. Offline browse is not registration authority.
    const inspection = await this.inspectLive(repo, input.revision).catch(error => { throw new Error(reason(error)); });
    const file = inspection.files.find(v => v.fileName === input.fileName);
    if (!file) throw new Error("hf_file_not_found");
    if (!file.downloadable || !file.sha256 || !file.byteLength) throw new Error(file.reasonCodes[0] ?? "hf_file_unsupported");
    const identity: LocalModelPackageIdentity = {
      schemaVersion: 1, packageId: `hf:${digest(JSON.stringify([repo, input.revision, file.fileName, file.sha256]))}`,
      repository: repo, revision: input.revision, fileName: file.fileName, format: "gguf",
      architecture: inspection.architecture ?? "unknown", quantization: file.quantization ?? "unknown", byteLength: file.byteLength,
      sha256: file.sha256, license: inspection.license ?? "unknown", gated: false, creator: "unknown", converter: "unknown",
      downloadUrl: `${ORIGIN}/${repo}/resolve/${input.revision}/${file.fileName}`, sourceUrl: `${ORIGIN}/${repo}/tree/${input.revision}`,
    };
    assertLocalModelPackageIdentity(identity);
    return identity;
  }
}
