import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pluginTreeSignature } from "./tree-signature";
import type { InstalledMcpServer, McpToolCatalogEntry } from "../../shared/types";
import { installedPluginsRoot, verifiedInstalledPluginRelease } from "./materialize";

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const TOOL_ID = /^[a-z0-9][a-z0-9_-]{1,127}$/u;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const CATEGORIES = new Set<McpToolCatalogEntry["category"]>([
  "communication", "dev", "productivity", "data", "web", "custom",
]);
const PLATFORMS = new Set(["darwin", "win32", "linux"]);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TOOLS = 128;
const LAUNCHER_BASENAME = "plugin-tool-launcher.js";

type JsonObject = Record<string, unknown>;

export type DedicatedPluginToolFailure = {
  slug: string;
  reason: string;
};

export type DedicatedPluginToolCatalog = {
  entries: McpToolCatalogEntry[];
  failures: DedicatedPluginToolFailure[];
};

function object(value: unknown, reason: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(reason);
  return value as JsonObject;
}

function text(value: unknown, max: number, reason: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(reason);
  }
  return value.trim();
}

function optionalHttpsUrl(value: unknown, reason: string): string | undefined {
  if (value === undefined) return undefined;
  const raw = text(value, 2048, reason);
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(reason);
  return url.toString();
}

function containedPath(root: string, relative: string, reason: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error(reason);
  const target = path.resolve(root, relative);
  const fromRoot = path.relative(root, target);
  if (!fromRoot || fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) throw new Error(reason);
  return target;
}

function assertContainedRealFile(root: string, target: string, reason: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(reason);
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(reason);
}

const manifestIntegrityCache = new Map<string, string>();
function verifyManifestIntegrity(root: string, manifest: JsonObject): void {
  // 같은 트리·같은 무결성 표면 → 마지막 성공 검증을 재사용(내용 해시는 트리가 바뀐 뒤에만 다시 낸다).
  const signature = pluginTreeSignature(root, (name) => name === "plugin.json" || name === ".install.json" || name === ".state");
  const key = signature ? `${signature}\0${createHash("sha256").update(JSON.stringify(manifest.integrity ?? null)).digest("hex")}` : null;
  if (key && manifestIntegrityCache.get(root) === key) return;
  computeVerifyManifestIntegrity(root, manifest);
  if (key) manifestIntegrityCache.set(root, key);
}
function computeVerifyManifestIntegrity(root: string, manifest: JsonObject): void {
  const integrity = object(manifest.integrity, "plugin_manifest_integrity_missing");
  if (integrity.algo !== "sha256" || !Array.isArray(integrity.files) || integrity.files.length === 0 || integrity.files.length > 4096) {
    throw new Error("plugin_manifest_integrity_invalid");
  }
  const declared = new Set<string>();
  for (const raw of integrity.files) {
    const row = object(raw, "plugin_manifest_integrity_invalid");
    const relative = text(row.path, 512, "plugin_manifest_integrity_path_invalid").replaceAll("\\", "/");
    if (declared.has(relative)) throw new Error("plugin_manifest_integrity_duplicate");
    const target = containedPath(root, relative, "plugin_manifest_integrity_path_invalid");
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== row.bytes) throw new Error("plugin_manifest_integrity_mismatch");
    const expected = typeof row.sha256 === "string" ? row.sha256 : "";
    if (!SHA256.test(expected) || createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== expected) {
      throw new Error("plugin_manifest_integrity_mismatch");
    }
    declared.add(relative);
  }

  const visit = (directory: string, relativeDir = ""): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!relativeDir && (entry.name === "plugin.json" || entry.name === ".install.json" || entry.name === ".state")) continue;
      const target = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDir, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error("plugin_manifest_integrity_symlink");
      if (stat.isDirectory()) visit(target, relative);
      else if (!stat.isFile() || !declared.has(relative)) throw new Error("plugin_manifest_integrity_uncovered_file");
    }
  };
  visit(root);
}

function resolvePluginArg(root: string, value: unknown): string {
  const raw = text(value, 4096, "plugin_tool_argument_invalid");
  if (raw === "${pluginDir}") return root;
  if (raw.startsWith("${pluginDir}/")) {
    return containedPath(root, raw.slice("${pluginDir}/".length), "plugin_tool_argument_path_invalid");
  }
  if (raw.includes("${")) throw new Error("plugin_tool_placeholder_unsupported");
  return raw;
}

function envRequirements(value: unknown): McpToolCatalogEntry["envRequirements"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error("plugin_tool_env_keys_invalid");
  const keys = value.map((item) => text(item, 128, "plugin_tool_env_key_invalid"));
  if (new Set(keys).size !== keys.length || keys.some((key) => !ENV_KEY.test(key))) {
    throw new Error("plugin_tool_env_key_invalid");
  }
  return keys.map((key) => ({ key, label: key, labelEn: key, required: true }));
}

function toolEntry(root: string, digest: string, raw: unknown): McpToolCatalogEntry {
  const tool = object(raw, "plugin_tool_invalid");
  const surface = object(tool.surface, "plugin_tool_surface_missing");
  const id = text(tool.id, 128, "plugin_tool_id_invalid");
  if (!TOOL_ID.test(id)) throw new Error("plugin_tool_id_invalid");
  const category = text(surface.category, 32, "plugin_tool_category_invalid") as McpToolCatalogEntry["category"];
  if (!CATEGORIES.has(category)) throw new Error("plugin_tool_category_invalid");
  const brandColor = text(surface.brandColor, 7, "plugin_tool_brand_invalid");
  const mark = text(surface.mark, 2, "plugin_tool_mark_invalid");
  if (!/^#[0-9A-Fa-f]{6}$/u.test(brandColor)) throw new Error("plugin_tool_brand_invalid");
  const docsUrl = optionalHttpsUrl(surface.docsUrl, "plugin_tool_docs_url_invalid");
  const common = {
    id,
    name: text(surface.name, 160, "plugin_tool_name_invalid"),
    nameEn: text(surface.nameEn ?? surface.name, 160, "plugin_tool_name_invalid"),
    description: text(surface.description, 1000, "plugin_tool_description_invalid"),
    descriptionEn: text(surface.descriptionEn ?? surface.description, 1000, "plugin_tool_description_invalid"),
    category,
    trust: "community" as const,
    envRequirements: envRequirements(tool.envKeys),
    brandColor,
    mark,
    ...(docsUrl ? { docsUrl } : {}),
  };

  if (tool.kind === "stdio") {
    if (tool.command !== "${node}" || !Array.isArray(tool.args) || tool.args.length < 1 || tool.args.length > 128) {
      throw new Error("plugin_tool_stdio_contract_unsupported");
    }
    const args = tool.args.map((arg) => resolvePluginArg(root, arg));
    const entry = args[0];
    assertContainedRealFile(root, entry, "plugin_tool_entry_invalid");
    const launcher = path.join(__dirname, LAUNCHER_BASENAME);
    const launcherStat = fs.lstatSync(launcher);
    if (launcherStat.isSymbolicLink() || !launcherStat.isFile()) throw new Error("plugin_tool_launcher_unavailable");
    return {
      ...common,
      transport: "stdio",
      command: process.execPath,
      args: [launcher, "--plugin-root", root, "--release-digest", digest, "--entry", entry, "--", ...args.slice(1)],
    };
  }

  if (tool.kind === "http") {
    const url = optionalHttpsUrl(tool.url, "plugin_tool_http_url_invalid");
    if (!url) throw new Error("plugin_tool_http_url_invalid");
    return { ...common, transport: "http", url };
  }
  throw new Error("plugin_tool_kind_unsupported");
}

function readInstalledPlugin(directory: string, platform: NodeJS.Platform): McpToolCatalogEntry[] {
  const release = verifiedInstalledPluginRelease(directory);
  if (!release) throw new Error("plugin_install_receipt_or_release_invalid");
  const manifestPath = path.join(directory, "plugin.json");
  const stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error("plugin_manifest_invalid");
  const manifest = object(JSON.parse(fs.readFileSync(manifestPath, "utf8")), "plugin_manifest_invalid");
  if (manifest.schema !== "agentlas.plugin/v2" || manifest.builtin !== false || manifest.slug !== release.slug || manifest.version !== release.version) {
    throw new Error("plugin_manifest_identity_invalid");
  }
  if (!SLUG.test(release.slug) || typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    throw new Error("plugin_manifest_identity_invalid");
  }
  const requires = object(manifest.requires, "plugin_manifest_requires_invalid");
  if (!Array.isArray(requires.os) || requires.os.some((item) => typeof item !== "string" || !PLATFORMS.has(item))) {
    throw new Error("plugin_manifest_os_invalid");
  }
  if (!requires.os.includes(platform)) throw new Error("plugin_platform_unsupported");
  verifyManifestIntegrity(directory, manifest);
  const provides = object(manifest.provides, "plugin_manifest_provides_invalid");
  if (!Array.isArray(provides.tools)) return [];
  if (provides.tools.length > MAX_TOOLS) throw new Error("plugin_tool_count_exceeded");
  return provides.tools.map((tool) => toolEntry(directory, release.digest, tool));
}

function mayDeclareDedicatedTools(directory: string): boolean {
  try {
    const manifestPath = path.join(directory, "plugin.json");
    const stat = fs.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return false;
    const manifest = object(JSON.parse(fs.readFileSync(manifestPath, "utf8")), "plugin_manifest_invalid");
    const provides = manifest.provides && typeof manifest.provides === "object" && !Array.isArray(manifest.provides)
      ? manifest.provides as JsonObject
      : null;
    return manifest.builtin === false && Array.isArray(provides?.tools) && provides.tools.length > 0;
  } catch {
    return false;
  }
}

export function loadDedicatedPluginToolCatalog(options: {
  root?: string;
  platform?: NodeJS.Platform;
} = {}): DedicatedPluginToolCatalog {
  const root = path.resolve(options.root ?? installedPluginsRoot());
  const platform = options.platform ?? process.platform;
  const entries: McpToolCatalogEntry[] = [];
  const failures: DedicatedPluginToolFailure[] = [];
  let names: string[] = [];
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("plugin_root_invalid");
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push({ slug: "*", reason: error instanceof Error ? error.message : String(error) });
    return { entries, failures };
  }
  for (const slug of names) {
    const directory = path.join(root, slug);
    if (!mayDeclareDedicatedTools(directory)) continue;
    try {
      entries.push(...readInstalledPlugin(directory, platform));
    } catch (error) {
      failures.push({ slug, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) failures.push({ slug: entry.id, reason: "plugin_tool_id_collision" });
    ids.add(entry.id);
  }
  if (failures.some((failure) => failure.reason === "plugin_tool_id_collision")) {
    const collisions = new Set(failures.filter((failure) => failure.reason === "plugin_tool_id_collision").map((failure) => failure.slug));
    return { entries: entries.filter((entry) => !collisions.has(entry.id)), failures };
  }
  return { entries, failures };
}

export function isDedicatedPluginToolLaunch(server: Pick<InstalledMcpServer, "command" | "args">): boolean {
  // The row can outlive the Desktop build that installed it. In development,
  // or immediately after an update, its command may therefore still point at
  // the previous Agentlas executable. Recognise the signed plugin launcher by
  // its full argument contract; defaults.ts then rewrites the row to this
  // process.execPath before it can be selected. Requiring command equality here
  // made that repair impossible and launched a second full Desktop window.
  return Boolean(server.command)
    && server.args.length >= 8
    && path.basename(server.args[0]) === LAUNCHER_BASENAME
    && server.args[1] === "--plugin-root"
    && server.args[3] === "--release-digest"
    && server.args[5] === "--entry"
    && server.args.includes("--", 7);
}
