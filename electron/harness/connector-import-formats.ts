import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/*
 * Readers for the connector import formats beyond a host's MCP JSON (native-harness notyet NH30, docs 18 §3):
 * a complete-enough TOML reader (Codex config), the MCPB bundle manifest (directory or .mcpb archive), Claude /
 * OpenAI-portable / legacy Codex plugin directories, and OpenAPI documents. Reading is inert: nothing is installed,
 * started, logged into or called; an archive is only extracted by `extractMcpbArchive`, which the import step calls
 * when the owner registers the bundle. Unsupported constructs are reported by name, never silently dropped.
 * No electron import (the daemon loads the harness).
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function readSmallFile(file: string, max = MAX_FILE_BYTES): Buffer | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > max) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// ── TOML ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TomlParse { value: Record<string, unknown>; unsupported: string[] }

/**
 * TOML 1.0 documents as Codex writes them: tables, arrays of tables, dotted and quoted keys, basic / literal /
 * multi-line strings, integers (incl. 0x/0o/0b and `_`), floats, booleans, date-times (kept as text), arrays and
 * inline tables (nested, multi-line, trailing comma, comments). A construct it cannot read ends that statement and is
 * named in `unsupported`; the rest of the document still parses.
 */
export function parseToml(text: string): TomlParse {
  const root: Record<string, unknown> = {};
  const unsupported: string[] = [];
  let i = 0;
  let table: Record<string, unknown> = root;
  const n = text.length;
  const ws = () => { while (i < n && (text[i] === " " || text[i] === "\t")) i += 1; };
  const skipComment = () => { if (text[i] === "#") while (i < n && text[i] !== "\n") i += 1; };
  const skipAll = () => { for (;;) { ws(); skipComment(); if (text[i] === "\r" || text[i] === "\n") { i += 1; continue; } break; } };
  const fail = (what: string): never => { throw new Error(what); };

  const bareKey = () => { const start = i; while (i < n && /[A-Za-z0-9_-]/.test(text[i])) i += 1; if (start === i) fail("key"); return text.slice(start, i); };
  const basicString = (): string => {
    if (text.startsWith('"""', i)) {
      i += 3; if (text[i] === "\r") i += 1; if (text[i] === "\n") i += 1;
      let out = "";
      while (i < n && !text.startsWith('"""', i)) {
        if (text[i] === "\\") {
          // Line-ending backslash: the newline and following whitespace are trimmed.
          if (/^\\[ \t]*\r?\n/.test(text.slice(i, i + 64))) { i += 1; while (i < n && /\s/.test(text[i])) i += 1; continue; }
          out += escape();
        } else { out += text[i]; i += 1; }
      }
      if (!text.startsWith('"""', i)) fail("multi-line string");
      i += 3;
      return out;
    }
    i += 1;
    let out = "";
    while (i < n && text[i] !== '"') {
      if (text[i] === "\n") fail("string newline");
      if (text[i] === "\\") out += escape(); else { out += text[i]; i += 1; }
    }
    if (text[i] !== '"') fail("string");
    i += 1;
    return out;
  };
  const escape = (): string => {
    const c = text[i + 1]; i += 2;
    const map: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (c in map) return map[c];
    if (c === "u" || c === "U") {
      const len = c === "u" ? 4 : 8; const hex = text.slice(i, i + len); i += len;
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) fail("unicode escape");
      return String.fromCodePoint(parseInt(hex, 16));
    }
    return fail("escape");
  };
  const literalString = (): string => {
    if (text.startsWith("'''", i)) {
      i += 3; if (text[i] === "\r") i += 1; if (text[i] === "\n") i += 1;
      const end = text.indexOf("'''", i); if (end < 0) fail("multi-line literal");
      const out = text.slice(i, end); i = end + 3; return out;
    }
    i += 1; const end = text.indexOf("'", i);
    if (end < 0 || text.slice(i, end).includes("\n")) fail("literal");
    const out = text.slice(i, end); i = end + 1; return out;
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      ws();
      parts.push(text[i] === '"' ? basicString() : text[i] === "'" ? literalString() : bareKey());
      ws();
      if (text[i] === ".") { i += 1; continue; }
      return parts;
    }
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === "[") {
      i += 1; const arr: unknown[] = [];
      for (;;) { skipAll(); if (text[i] === "]") { i += 1; return arr; } arr.push(value()); skipAll(); if (text[i] === ",") { i += 1; continue; } skipAll(); if (text[i] === "]") { i += 1; return arr; } fail("array"); }
    }
    if (c === "{") {
      i += 1; const obj: Record<string, unknown> = {};
      ws(); if (text[i] === "}") { i += 1; return obj; }
      for (;;) {
        const k = key(); ws(); if (text[i] !== "=") fail("inline table"); i += 1;
        assign(obj, k, value()); ws();
        if (text[i] === ",") { i += 1; continue; }
        if (text[i] === "}") { i += 1; return obj; }
        fail("inline table");
      }
    }
    const m = /^(true|false)(?![A-Za-z0-9_])/.exec(text.slice(i, i + 6));
    if (m) { i += m[1].length; return m[1] === "true"; }
    const tok = /^[^\s,\]}#]+/.exec(text.slice(i))?.[0] ?? "";
    if (!tok) fail("value");
    // Date-times keep their text (a space-separated time joins the date).
    const dt = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/.exec(text.slice(i));
    if (dt && dt[0].length >= tok.length) { i += dt[0].length; return dt[0]; }
    i += tok.length;
    const clean = tok.replace(/_/g, "");
    if (/^[+-]?0x[0-9a-fA-F]+$/.test(clean)) return parseInt(clean, 16);
    if (/^[+-]?0o[0-7]+$/.test(clean)) return parseInt(clean.replace("0o", ""), 8);
    if (/^[+-]?0b[01]+$/.test(clean)) return parseInt(clean.replace("0b", ""), 2);
    if (/^[+-]?(inf|nan)$/.test(clean)) return clean.includes("nan") ? NaN : (clean.startsWith("-") ? -Infinity : Infinity);
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(clean)) return Number(clean);
    return fail(`value ${tok.slice(0, 20)}`);
  };
  const assign = (target: Record<string, unknown>, parts: string[], v: unknown) => {
    let cur = target;
    for (const part of parts.slice(0, -1)) {
      if (cur[part] === undefined) cur[part] = {};
      if (!cur[part] || typeof cur[part] !== "object" || Array.isArray(cur[part])) fail("key redefined");
      cur = cur[part] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = v;
  };
  const tableAt = (parts: string[], arrayOfTables: boolean): Record<string, unknown> => {
    let cur: Record<string, unknown> = root;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      if (last && arrayOfTables) {
        if (cur[part] === undefined) cur[part] = [];
        if (!Array.isArray(cur[part])) fail("array of tables");
        const next: Record<string, unknown> = {}; (cur[part] as unknown[]).push(next); cur = next; return;
      }
      if (cur[part] === undefined) cur[part] = {};
      const node = cur[part];
      if (Array.isArray(node)) { cur = node[node.length - 1] as Record<string, unknown>; return; }
      if (!node || typeof node !== "object") fail("table redefined");
      cur = node as Record<string, unknown>;
    });
    return cur;
  };

  while (i < n) {
    skipAll();
    if (i >= n) break;
    const lineStart = i;
    try {
      if (text[i] === "[") {
        const aot = text[i + 1] === "[";
        i += aot ? 2 : 1;
        const parts = key();
        if (text[i] !== "]" || (aot && text[i + 1] !== "]")) fail("table header");
        i += aot ? 2 : 1;
        table = tableAt(parts, aot);
      } else {
        const parts = key(); ws();
        if (text[i] !== "=") fail("expected =");
        i += 1;
        assign(table, parts, value());
      }
      ws(); skipComment();
      if (i < n && text[i] !== "\n" && text[i] !== "\r") fail("trailing text");
    } catch (error) {
      const line = text.slice(0, lineStart).split("\n").length;
      unsupported.push(`toml:line ${line}: ${error instanceof Error ? error.message : "unreadable"}`.slice(0, 120));
      while (i < n && text[i] !== "\n") i += 1;
    }
  }
  return { value: root, unsupported };
}

// ── zip (MCPB archives) ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ZipEntry { name: string; data: Buffer }
const ZIP_MAX_ENTRIES = 4096;
const ZIP_MAX_TOTAL = 256 * 1024 * 1024;

/** Safe relative entry name: no absolute path, drive, backslash, `..` or empty segment. */
export function safeEntryName(name: string): boolean {
  if (!name || name.length > 1024 || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\0")) return false;
  return name.split("/").every((part, index, all) => part !== ".." && part !== "." && (part !== "" || index === all.length - 1));
}

/** Read a zip without extracting: stored and deflate only; zip64, encryption, symlinks and unsafe names are refused. */
export function readZip(buf: Buffer, only?: (name: string) => boolean): ZipEntry[] {
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65_557); p -= 1) if (buf.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
  if (eocd < 0) throw new Error("zip_eocd_missing");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("zip64_unsupported");
  if (count > ZIP_MAX_ENTRIES) throw new Error("zip_too_many_entries");
  const out: ZipEntry[] = [];
  let total = 0;
  for (let k = 0; k < count; k += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip_central_directory_corrupt");
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error("zip_encrypted");
    if (((external >>> 16) & 0o170000) === 0o120000) throw new Error(`zip_symlink:${name.slice(0, 80)}`);
    if (!safeEntryName(name)) throw new Error(`zip_unsafe_name:${name.slice(0, 80)}`);
    if (compSize === 0xffffffff || size === 0xffffffff) throw new Error("zip64_unsupported");
    total += size;
    if (total > ZIP_MAX_TOTAL) throw new Error("zip_too_large");
    if (only && !only(name)) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip_local_header_corrupt");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }) : (() => { throw new Error(`zip_method_${method}`); })();
    if (data.length !== size) throw new Error("zip_size_mismatch");
    out.push({ name, data });
  }
  return out;
}

// ── MCPB bundles ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface McpbBundle {
  manifest: Record<string, unknown>;
  /** Directory the bundle's files live in (an extracted archive's directory is fixed before extraction). */
  root: string;
  archive?: { file: string; sha256: string };
}

/** The bundle at a directory (manifest.json) or a .mcpb/.dxt archive (manifest read without extracting). */
export function readMcpbBundle(location: string, extractRoot: string | null): McpbBundle | null {
  try {
    const stat = fs.statSync(location);
    if (stat.isDirectory()) {
      const manifest = JSON.parse(readSmallFile(path.join(location, "manifest.json"))?.toString("utf8") ?? "null");
      return manifest && typeof manifest === "object" ? { manifest, root: location } : null;
    }
    const buf = readSmallFile(location, ZIP_MAX_TOTAL);
    if (!buf) return null;
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const [entry] = readZip(buf, (name) => name === "manifest.json");
    if (!entry) return null;
    const manifest = JSON.parse(entry.data.toString("utf8"));
    if (!manifest || typeof manifest !== "object") return null;
    return { manifest, root: path.join(extractRoot ?? path.dirname(location), `mcpb-${sha256.slice(0, 16)}`), archive: { file: location, sha256 } };
  } catch {
    return null;
  }
}

/** Extract an archive into its fixed root (idempotent: an existing complete extraction with the same digest is kept). */
export function extractMcpbArchive(bundle: McpbBundle): void {
  if (!bundle.archive) return;
  const marker = path.join(bundle.root, ".agentlas-mcpb-sha256");
  if (readSmallFile(marker)?.toString("utf8") === bundle.archive.sha256) return;
  const buf = readSmallFile(bundle.archive.file, ZIP_MAX_TOTAL);
  if (!buf || createHash("sha256").update(buf).digest("hex") !== bundle.archive.sha256) throw new Error("mcpb_archive_changed");
  const entries = readZip(buf);
  const staging = `${bundle.root}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  for (const entry of entries) {
    const target = path.resolve(staging, entry.name);
    if (!target.startsWith(path.resolve(staging) + path.sep)) throw new Error("mcpb_entry_escapes_root");
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, entry.data, { mode: 0o600 });
    if (/(^|\/)(bin|server)\/[^/]+$|\.(sh|py|js|mjs|cjs)$/.test(entry.name) || entry.name === bundleEntryPoint(bundle.manifest)) fs.chmodSync(target, 0o700);
  }
  fs.writeFileSync(path.join(staging, ".agentlas-mcpb-sha256"), bundle.archive.sha256, { mode: 0o600 });
  fs.rmSync(bundle.root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bundle.root), { recursive: true, mode: 0o700 });
  fs.renameSync(staging, bundle.root);
}

function bundleEntryPoint(manifest: Record<string, unknown>): string | null {
  const server = manifest.server as Record<string, unknown> | undefined;
  return typeof server?.entry_point === "string" ? server.entry_point : null;
}

// ── plugin directories ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PluginServers { root: string; manifest: string; servers: Array<[string, Record<string, unknown>]>; unhandled: string[] }

function jsonAt(file: string): Record<string, unknown> | null {
  try { const v = JSON.parse(readSmallFile(file)?.toString("utf8") ?? "null"); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

function serversOf(doc: Record<string, unknown> | null): Array<[string, Record<string, unknown>]> {
  const map = doc && (doc.mcpServers ?? doc.mcp_servers);
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>).filter((row): row is [string, Record<string, unknown>] => Boolean(row[1]) && typeof row[1] === "object" && !Array.isArray(row[1]));
}

/** Plugin parts this importer does not register (skills, commands, agents, hooks, apps): named so nothing is silently lost. */
function pluginParts(root: string, manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const part of ["skills", "commands", "agents", "hooks", "outputStyles", "lspServers", "apps"]) {
    if (manifest[part] !== undefined || fs.existsSync(path.join(root, part))) out.push(`plugin-part:${part}`);
  }
  for (const file of [".app.json", "hooks/hooks.json"]) if (fs.existsSync(path.join(root, file))) out.push(`plugin-file:${file}`);
  return [...new Set(out)];
}

export function readPluginServers(kind: "claude-plugin" | "openai-plugin" | "codex-plugin", root: string): PluginServers | null {
  const manifestFile = kind === "claude-plugin" ? path.join(root, ".claude-plugin", "plugin.json")
    : kind === "codex-plugin" ? path.join(root, ".codex-plugin", "plugin.json") : path.join(root, "plugin.json");
  const manifest = jsonAt(manifestFile);
  if (!manifest) return null;
  let servers: Array<[string, Record<string, unknown>]> = [];
  const declared = manifest.mcpServers;
  if (declared && typeof declared === "object" && !Array.isArray(declared)) servers = serversOf({ mcpServers: declared });
  else if (typeof declared === "string" && !path.isAbsolute(declared) && !declared.split(/[\\/]/).includes("..")) servers = serversOf(jsonAt(path.join(root, declared)));
  else if (kind === "openai-plugin") servers = serversOf(jsonAt(path.join(root, "mcp.json")));
  if (!servers.length) servers = serversOf(jsonAt(path.join(root, ".mcp.json")));
  // Plugin-root variables point at this directory.
  const substitute = (value: unknown): unknown => typeof value === "string" ? value.replace(/\$\{(CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|CODEX_PLUGIN_ROOT|__dirname)\}/g, root)
    : Array.isArray(value) ? value.map(substitute)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v)])) : value;
  return { root, manifest: manifestFile, servers: servers.map(([name, entry]) => [name, substitute(entry) as Record<string, unknown>]), unhandled: pluginParts(root, manifest) };
}

// ── OpenAPI ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OpenApiSummary { title: string; serverUrl: string | null; operations: number; securitySchemes: string[]; version: string }

/** An OpenAPI 3.x / Swagger 2 document (JSON or YAML), summarised; an API adapter is required to call it (docs 18 §4). */
export function readOpenApi(file: string): OpenApiSummary | null {
  const raw = readSmallFile(file)?.toString("utf8");
  if (!raw) return null;
  let doc: Record<string, unknown> | null = null;
  try { doc = JSON.parse(raw); } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yaml = require("js-yaml") as { load(text: string, options?: unknown): unknown; JSON_SCHEMA: unknown };
      const loaded = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      doc = loaded && typeof loaded === "object" ? loaded as Record<string, unknown> : null;
    } catch { doc = null; }
  }
  if (!doc || (typeof doc.openapi !== "string" && doc.swagger !== "2.0")) return null;
  const paths = doc.paths && typeof doc.paths === "object" ? doc.paths as Record<string, Record<string, unknown>> : {};
  const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
  let operations = 0;
  for (const item of Object.values(paths)) if (item && typeof item === "object") for (const m of Object.keys(item)) if (methods.has(m)) operations += 1;
  const info = doc.info && typeof doc.info === "object" ? doc.info as Record<string, unknown> : {};
  const servers = Array.isArray(doc.servers) ? doc.servers as Array<Record<string, unknown>> : [];
  const components = doc.components && typeof doc.components === "object" ? doc.components as Record<string, unknown> : {};
  const schemes = (components.securitySchemes ?? doc.securityDefinitions) as Record<string, unknown> | undefined;
  return {
    title: typeof info.title === "string" ? info.title.slice(0, 120) : path.basename(file),
    serverUrl: typeof servers[0]?.url === "string" ? servers[0].url as string : typeof doc.host === "string" ? `https://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}` : null,
    operations,
    securitySchemes: schemes && typeof schemes === "object" ? Object.keys(schemes).slice(0, 32) : [],
    version: typeof doc.openapi === "string" ? doc.openapi : "2.0",
  };
}
