import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectionVaultKey, credentialVaultKey, newConnectionCredentialToken } from "../mcp-tools/credential-refs";
import { extractMcpbArchive, parseToml, readMcpbBundle, readOpenApi, readPluginServers, type McpbBundle } from "./connector-import-formats";

/*
 * Connector import (docs/2026-10-13-native-harness/18 §3): bring MCP servers the owner already set up in another
 * host into Agentlas without registering them again by hand.
 *
 *   parse → validate → normalize + compatibility grade → register inert definitions → (connector.connect) → tools
 *
 * Parsing never starts a process, opens a URL, logs in or calls a tool. A secret literal found in the source config
 * (an env value or a bearer header) is moved into the Agentlas Vault and the definition keeps only names; a value is
 * never returned, logged or written anywhere else. Imported definitions are registered switched off: `connector.connect`
 * turns one on. No electron import at top level (the daemon loads the harness).
 *
 * Identity (native-harness notyet NH29, docs 15 §49–57): a definition (endpoint: URL, or command + args) is not an
 * account. Two accounts of one endpoint are two connections. A literal secret is stored under a Vault key this
 * connection alone owns (credential-refs.ts) — never under the global name, where it would either overwrite or, worse,
 * silently run on an unrelated value already saved there. `${VAR}` keeps naming VAR. A source entry is "already
 * registered" only when an installed row has the same endpoint AND reads the very same credential values or references;
 * the comparison happens in memory and no value leaves the import step.
 */

export type ImportSourceKind = "claude-json" | "claude-project" | "codex-toml" | "cursor-json" | "gemini-json" | "copilot-json"
  | "claude-plugin" | "openai-plugin" | "codex-plugin" | "mcpb" | "openapi";
/** A path-based source: the owner points at a plugin directory, an MCPB bundle (directory or archive) or an OpenAPI file. */
export const PATH_IMPORT_KINDS: readonly ImportSourceKind[] = ["claude-plugin", "openai-plugin", "codex-plugin", "mcpb", "openapi"];
export type ImportGrade = "native-compatible" | "converted-equivalent" | "partial" | "adapter-required" | "unsupported";

export interface ImportedDefinition {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  url?: string;
  /** Env key names; a literal value found in the source is listed in `secretKeys` and moved to the Vault on import. */
  envKeys: string[];
  /** Keys whose literal values sit in the source config (never their values). */
  secretKeys: string[];
  /** Keys whose source value names another variable (`API_KEY = "${WORK_TOKEN}"` → { API_KEY: "WORK_TOKEN" }). */
  envRefs: Record<string, string>;
  grade: ImportGrade;
  /** Declarations Agentlas does not carry over (kept as names, never values). */
  loss: string[];
}

export interface ImportSource {
  kind: ImportSourceKind; path: string; definitions: ImportedDefinition[];
  /** Source-level declarations this importer does not register (plugin skills/hooks/apps, unreadable TOML lines). */
  unhandled?: string[];
  /** sha256 of an archive source (MCPB). */
  digest?: string;
}

/** Values are kept out of every returned object; this side map exists only for the import step itself. */
type SecretValues = Map<string, string>;

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

function readText(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** `${VAR}` / `$VAR` exactly → VAR; anything else (a literal or a template) → null. */
function referenceName(value: unknown): string | null {
  const match = typeof value === "string" ? value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/) : null;
  return match && ENV_KEY.test(match[1]) ? match[1] : null;
}

/**
 * Loss first (NH30): any declaration Agentlas cannot carry makes the definition partial, whatever else converted.
 * `was-disabled` is informational (the import registers everything switched off anyway).
 */
function gradeOf(loss: readonly string[], converted: boolean): ImportGrade {
  if (loss.some((item) => item !== "was-disabled")) return "partial";
  return converted ? "converted-equivalent" : "native-compatible";
}

/** One JSON `mcpServers` entry (Claude, Cursor, Gemini, Copilot and plugin `.mcp.json` share this shape). */
function normalizeJsonEntry(name: string, entry: Record<string, unknown>, secrets: SecretValues): ImportedDefinition | null {
  const loss: string[] = [];
  const envKeys: string[] = [];
  const secretKeys: string[] = [];
  const envRefs: Record<string, string> = {};
  const url = typeof entry.url === "string" ? entry.url : typeof entry.httpUrl === "string" ? entry.httpUrl : typeof entry.serverUrl === "string" ? entry.serverUrl : undefined;
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  const command = typeof entry.command === "string" ? entry.command : undefined;
  const remote = !command && Boolean(url);
  // A value keyed by name: literal → moved to the Vault for this connection; `${VAR}` → reads VAR; template → lost.
  const carry = (key: string, value: unknown, lossTag: string) => {
    if (!ENV_KEY.test(key)) { loss.push(`${lossTag}:${key.slice(0, 40)}`); return; }
    const ref = referenceName(value);
    if (ref) { envKeys.push(key); if (ref !== key) envRefs[key] = ref; return; }
    if (typeof value !== "string" || !value) { envKeys.push(key); return; }
    if (/\$\{[^}]+\}/.test(value)) { loss.push(`${lossTag}-template:${key.slice(0, 40)}`); return; }
    envKeys.push(key); secretKeys.push(key); secrets.set(`${name}\u0000${key}`, value);
  };
  const env = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) ? entry.env as Record<string, unknown> : {};
  // Agentlas sends a remote server's keys as HTTP headers of the same name, so env on a URL entry cannot be carried.
  if (remote) { for (const key of Object.keys(env)) loss.push(`env-on-remote:${key.slice(0, 40)}`); }
  else for (const [key, value] of Object.entries(env)) carry(key, value, "env");
  if (entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)) {
    // A header named like an env key (Authorization) is carried; a dashed name (X-Api-Key) is not expressible.
    for (const [key, value] of Object.entries(entry.headers as Record<string, unknown>)) remote ? carry(key, value, "header") : loss.push(`header-on-stdio:${key.slice(0, 40)}`);
  }
  if (typeof entry.cwd === "string") loss.push("cwd");
  const filters = [entry.tools, entry.includeTools, entry.excludeTools, entry.enabled_tools, entry.disabled_tools];
  if (filters.some((list) => Array.isArray(list) && !(list.length === 1 && list[0] === "*"))) loss.push("tools-filter");
  if (entry.disabled === true || entry.enabled === false) loss.push("was-disabled");
  let transport: ImportedDefinition["transport"];
  if (command && (type === "" || type === "stdio" || type === "local")) transport = "stdio";
  else if (url && (type === "sse")) transport = "sse";
  else if (url) transport = "http";
  else return { name, transport: "stdio", args: [], envKeys, secretKeys, envRefs, grade: "unsupported", loss: [...loss, "no command or url"] };
  const grade = gradeOf(loss, secretKeys.length > 0 || Object.keys(envRefs).length > 0);
  return { name, transport, ...(command ? { command } : {}), args: strings(entry.args), ...(url ? { url } : {}), envKeys, secretKeys, envRefs, grade, loss };
}

function jsonServers(text: string): Array<[string, Record<string, unknown>]> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const servers = parsed && typeof parsed === "object" ? (parsed as { mcpServers?: unknown }).mcpServers : null;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers as Record<string, unknown>).filter((row): row is [string, Record<string, unknown>] => Boolean(row[1]) && typeof row[1] === "object" && !Array.isArray(row[1]));
}

// ── Codex config.toml ───────────────────────────────────────────────────────────────────────────────────────────────

/** `[mcp_servers.<name>]` tables of a Codex config.toml (complete TOML reader; unreadable lines are reported). */
export function parseCodexMcpServers(text: string): Array<[string, Record<string, unknown>]> {
  return codexServers(text).servers;
}

function codexServers(text: string): { servers: Array<[string, Record<string, unknown>]>; unsupported: string[] } {
  const { value, unsupported } = parseToml(text);
  const map = value.mcp_servers;
  if (!map || typeof map !== "object" || Array.isArray(map)) return { servers: [], unsupported };
  return { servers: Object.entries(map as Record<string, unknown>).filter((row): row is [string, Record<string, unknown>] => Boolean(row[1]) && typeof row[1] === "object" && !Array.isArray(row[1])), unsupported };
}

function normalizeCodexEntry(name: string, entry: Record<string, unknown>, secrets: SecretValues): ImportedDefinition | null {
  const env = entry.env && typeof entry.env === "object" ? entry.env as Record<string, unknown> : {};
  // env_vars forwards named variables from the parent environment: the same name, read from the Vault here.
  const forwarded = strings(entry.env_vars).filter((key) => ENV_KEY.test(key) && !(key in env));
  const headers: Record<string, unknown> = { ...(entry.http_headers && typeof entry.http_headers === "object" ? entry.http_headers as Record<string, unknown> : {}) };
  // env_http_headers: header value read from a named variable — the same meaning as a header reference here.
  if (entry.env_http_headers && typeof entry.env_http_headers === "object") {
    for (const [header, variable] of Object.entries(entry.env_http_headers as Record<string, unknown>)) if (typeof variable === "string") headers[header] = `\${${variable}}`;
  }
  const json: Record<string, unknown> = {
    command: entry.command, args: entry.args, url: entry.url,
    env: { ...env, ...Object.fromEntries(forwarded.map((key) => [key, `\${${key}}`])) },
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(entry.enabled === false ? { enabled: false } : {}),
    ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
    ...(Array.isArray(entry.enabled_tools) ? { enabled_tools: entry.enabled_tools } : {}),
    ...(Array.isArray(entry.disabled_tools) ? { disabled_tools: entry.disabled_tools } : {}),
  };
  const def = normalizeJsonEntry(name, json, secrets);
  if (!def) return null;
  // bearer_token_env_var holds a bare token; Agentlas's Authorization value carries the scheme, so it cannot be mapped.
  if (typeof entry.bearer_token_env_var === "string") def.loss.push(`bearer-token-env:${entry.bearer_token_env_var.slice(0, 40)}`);
  if (def.grade !== "unsupported") def.grade = gradeOf(def.loss, def.secretKeys.length > 0 || Object.keys(def.envRefs).length > 0);
  return def;
}

// ── MCPB bundles ────────────────────────────────────────────────────────────────────────────────────────────────────

const MCPB_PLATFORMS: Record<string, string> = { darwin: "darwin", win32: "win32", linux: "linux" };

/** The bundle's server as a definition: `${__dirname}` → bundle root, `${user_config.X}` → a key the owner supplies. */
function mcpbDefinition(bundle: McpbBundle, secrets: SecretValues, platform: NodeJS.Platform = process.platform): ImportedDefinition {
  const manifest = bundle.manifest;
  const name = (typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : "mcpb-bundle").slice(0, 80);
  const compat = manifest.compatibility as Record<string, unknown> | undefined;
  const platforms = Array.isArray(compat?.platforms) ? (compat!.platforms as unknown[]).filter((p): p is string => typeof p === "string") : null;
  const server = manifest.server && typeof manifest.server === "object" ? manifest.server as Record<string, unknown> : {};
  const base = server.mcp_config && typeof server.mcp_config === "object" ? server.mcp_config as Record<string, unknown> : {};
  const overrides = base.platform_overrides && typeof base.platform_overrides === "object" ? (base.platform_overrides as Record<string, unknown>)[platform] : undefined;
  const config = { ...base, ...(overrides && typeof overrides === "object" ? overrides as Record<string, unknown> : {}) };
  const userConfig = manifest.user_config && typeof manifest.user_config === "object" ? manifest.user_config as Record<string, Record<string, unknown>> : {};
  const loss: string[] = [];
  const sub = (value: string): string | null => {
    let lost = false;
    const out = value.replace(/\$\{([^}]+)\}/g, (whole, key: string) => {
      if (key === "__dirname") return bundle.root;
      if (key === "HOME") return os.homedir();
      if (key === "/" || key === "pathSeparator") return path.sep;
      const user = /^user_config\.([A-Za-z0-9_]+)$/.exec(key);
      if (user && userConfig[user[1]] && userConfig[user[1]].default !== undefined && userConfig[user[1]].sensitive !== true) return String(userConfig[user[1]].default);
      lost = true; return whole;
    });
    return lost ? null : out;
  };
  const args: string[] = [];
  for (const arg of strings(config.args)) { const v = sub(arg); if (v === null) loss.push(`arg-user-config:${arg.slice(0, 40)}`); else args.push(v); }
  const command = typeof config.command === "string" ? sub(config.command) : null;
  const envKeys: string[] = [], secretKeys: string[] = [], envRefs: Record<string, string> = {};
  const env = config.env && typeof config.env === "object" ? config.env as Record<string, unknown> : {};
  for (const [key, raw] of Object.entries(env)) {
    if (!ENV_KEY.test(key) || typeof raw !== "string") { loss.push(`env:${key.slice(0, 40)}`); continue; }
    const user = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/.exec(raw);
    if (user) {
      const option = userConfig[user[1]] ?? {};
      envKeys.push(key);
      // A non-sensitive default is a value this connection keeps; a sensitive or required option waits for the owner.
      if (option.default !== undefined && option.sensitive !== true) { secretKeys.push(key); secrets.set(`${name}\u0000${key}`, String(option.default)); }
      continue;
    }
    const value = sub(raw);
    if (value === null) { loss.push(`env-template:${key.slice(0, 40)}`); continue; }
    envKeys.push(key); secretKeys.push(key); secrets.set(`${name}\u0000${key}`, value);
  }
  if (platforms && !platforms.includes(MCPB_PLATFORMS[platform] ?? platform)) {
    return { name, transport: "stdio", args: [], envKeys: [], secretKeys: [], envRefs: {}, grade: "unsupported", loss: [`platform:${platform}`] };
  }
  if (!command) return { name, transport: "stdio", args: [], envKeys: [], secretKeys: [], envRefs: {}, grade: "unsupported", loss: [...loss, "no command"] };
  return { name, transport: "stdio", command, args, envKeys, secretKeys, envRefs, grade: gradeOf(loss, secretKeys.length > 0), loss };
}

// ── discovery ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImportSourceOptions {
  home?: string; projectDir?: string | null;
  /** Path-based kinds: the plugin directory, MCPB bundle (directory or .mcpb/.dxt archive) or OpenAPI file. */
  path?: string | null;
  /** Where an MCPB archive is extracted when it is registered (the caller's app data directory). */
  bundleRoot?: string | null;
}

function sourceFiles(options: ImportSourceOptions): Array<{ kind: ImportSourceKind; file: string }> {
  const home = options.home ?? os.homedir();
  const files: Array<{ kind: ImportSourceKind; file: string }> = [
    { kind: "claude-json", file: path.join(home, ".claude.json") },
    { kind: "codex-toml", file: path.join(process.env.CODEX_HOME && options.home === undefined ? process.env.CODEX_HOME : path.join(home, ".codex"), "config.toml") },
    { kind: "cursor-json", file: path.join(home, ".cursor", "mcp.json") },
    { kind: "gemini-json", file: path.join(home, ".gemini", "settings.json") },
    { kind: "copilot-json", file: path.join(home, ".copilot", "mcp-config.json") },
  ];
  if (options.projectDir) files.push({ kind: "claude-project", file: path.join(options.projectDir, ".mcp.json") });
  return files;
}

interface LoadedSource { source: ImportSource; bundle?: McpbBundle }

/** Read one source into definitions (inert). Path kinds read options.path; host kinds read their known file. */
function loadSource(kind: ImportSourceKind, options: ImportSourceOptions, secrets: SecretValues): LoadedSource | null {
  if (PATH_IMPORT_KINDS.includes(kind)) {
    const location = options.path ? path.resolve(options.path) : null;
    if (!location) return null;
    if (kind === "mcpb") {
      const bundle = readMcpbBundle(location, options.bundleRoot ?? null);
      if (!bundle) return null;
      return { source: { kind, path: location, definitions: [mcpbDefinition(bundle, secrets)], ...(bundle.archive ? { digest: bundle.archive.sha256 } : {}) }, bundle };
    }
    if (kind === "openapi") {
      const api = readOpenApi(location);
      if (!api) return null;
      // An OpenAPI service is called through an API adapter (docs 18 §4), not an MCP process: reported, not registered.
      return { source: { kind, path: location, definitions: [{
        name: api.title, transport: "http", args: [], ...(api.serverUrl ? { url: api.serverUrl } : {}), envKeys: [], secretKeys: [], envRefs: {},
        grade: "adapter-required", loss: [`openapi:${api.version}`, `operations:${api.operations}`, ...api.securitySchemes.map((name) => `security:${name.slice(0, 40)}`), "api-adapter-required"],
      }] } };
    }
    const plugin = readPluginServers(kind as "claude-plugin" | "openai-plugin" | "codex-plugin", location);
    if (!plugin) return null;
    const definitions = plugin.servers.map(([name, entry]) => normalizeJsonEntry(name, entry, secrets)).filter((def): def is ImportedDefinition => Boolean(def));
    return { source: { kind, path: plugin.manifest, definitions, ...(plugin.unhandled.length ? { unhandled: plugin.unhandled } : {}) } };
  }
  const file = sourceFiles(options).find((row) => row.kind === kind)?.file;
  const text = file ? readText(file) : null;
  if (!file || text === null) return null;
  if (kind === "codex-toml") {
    const { servers, unsupported } = codexServers(text);
    const definitions = servers.map(([name, entry]) => normalizeCodexEntry(name, entry, secrets)).filter((def): def is ImportedDefinition => Boolean(def));
    return { source: { kind, path: file, definitions, ...(unsupported.length ? { unhandled: unsupported } : {}) } };
  }
  const definitions = jsonServers(text).map(([name, entry]) => normalizeJsonEntry(name, entry, secrets)).filter((def): def is ImportedDefinition => Boolean(def));
  return { source: { kind, path: file, definitions } };
}

/** Inert: read the known host config files (and options.path for the path kinds) and report definitions with grades (never values). */
export function discoverImportSources(options: ImportSourceOptions = {}): ImportSource[] {
  const sources: ImportSource[] = [];
  for (const { kind } of sourceFiles(options)) {
    const loaded = loadSource(kind, options, new Map());
    if (loaded && loaded.source.definitions.length) sources.push(loaded.source);
  }
  if (options.path) {
    for (const kind of PATH_IMPORT_KINDS) {
      const loaded = loadSource(kind, options, new Map());
      if (loaded && (loaded.source.definitions.length || loaded.source.unhandled?.length)) { sources.push(loaded.source); break; }
    }
  }
  return sources;
}

export interface InstalledConnection {
  id: string; command: string | null; args: string[]; url: string | null; name: string;
  envKeys?: string[];
  credentialRefs?: Record<string, string>;
}

export interface ImportPorts {
  listInstalled(): InstalledConnection[];
  install(def: { name: string; transport: "stdio" | "http" | "sse"; command?: string; args?: string[]; url?: string; envKeys?: string[]; credentialRefs?: Record<string, string> }): { id: string };
  disable(id: string): void;
  /** Read only to compare an installed connection's credential with the source's, in memory. */
  readEnv(key: string): Promise<string | null>;
  setEnv(key: string, value: string): Promise<void>;
  deleteEnv(key: string): Promise<void>;
}

export interface ImportOutcome {
  name: string;
  status: "registered" | "already_registered" | "skipped_unsupported" | "skipped_adapter_required" | "failed";
  serverId?: string;
  grade: ImportGrade;
  /** Env key names whose values were stored for this connection alone (never the values). */
  vaultSaved: string[];
  /** Kept for wire compatibility: an unrelated global value is never adopted any more, so this stays empty. */
  vaultKept: string[];
  /** Env key name → the Vault key this connection reads (names only). */
  credentialRefs?: Record<string, string>;
  loss: string[];
  reason?: string;
}

function sameEndpoint(row: InstalledConnection, def: ImportedDefinition): boolean {
  return Boolean((def.url && row.url === def.url) || (def.command && row.command === def.command && JSON.stringify(row.args) === JSON.stringify(def.args)));
}

/** Same account: every source credential (literal value or `${VAR}` reference) is exactly what the row reads. */
async function sameAccount(row: InstalledConnection, def: ImportedDefinition, secrets: SecretValues, ports: ImportPorts): Promise<boolean> {
  const rowKeys = new Set(row.envKeys ?? []);
  for (const [key, target] of Object.entries(def.envRefs)) {
    if (!rowKeys.has(key) || credentialVaultKey(row, key) !== target) return false;
  }
  for (const key of def.secretKeys) {
    const value = secrets.get(`${def.name}\u0000${key}`);
    if (!value || !rowKeys.has(key)) return false;
    const stored = await ports.readEnv(credentialVaultKey(row, key)).catch(() => null);
    if (stored !== value) return false;
  }
  // A row that holds its own credential is an account the source entry does not name.
  if (!def.secretKeys.length && !Object.keys(def.envRefs).length && Object.keys(row.credentialRefs ?? {}).length) return false;
  return true;
}

/**
 * Register the chosen definitions switched off. `names` empty means every importable one in that source.
 * `newConnection` names register a second connection even when an installed one matches (another OAuth account of the
 * same endpoint: its token is kept per connection).
 */
export async function importConnectors(input: { kind: ImportSourceKind; names?: readonly string[]; newConnection?: readonly string[]; options?: ImportSourceOptions; ports: ImportPorts; dryRun?: boolean }): Promise<ImportOutcome[]> {
  const secrets: SecretValues = new Map();
  const loaded = loadSource(input.kind, input.options ?? {}, secrets);
  if (!loaded) { secrets.clear(); return []; }
  const wanted = new Set(input.names ?? []);
  const forceNew = new Set(input.newConnection ?? []);
  const definitions = loaded.source.definitions.filter((def) => wanted.size === 0 || wanted.has(def.name));
  const installed = input.ports.listInstalled();
  const outcomes: ImportOutcome[] = [];
  try {
    for (const def of definitions) {
      const base = { name: def.name, grade: def.grade, loss: def.loss, vaultSaved: [] as string[], vaultKept: [] as string[] };
      if (def.grade === "unsupported") { outcomes.push({ ...base, status: "skipped_unsupported", reason: def.loss.join(", ") }); continue; }
      if (def.grade === "adapter-required") { outcomes.push({ ...base, status: "skipped_adapter_required", reason: def.loss.join(", ") }); continue; }
      let same: InstalledConnection | undefined;
      if (!forceNew.has(def.name)) {
        for (const row of installed.filter((candidate) => sameEndpoint(candidate, def))) {
          if (await sameAccount(row, def, secrets, input.ports)) { same = row; break; }
        }
      }
      if (same) { outcomes.push({ ...base, status: "already_registered", serverId: same.id }); continue; }
      if (input.dryRun) { outcomes.push({ ...base, status: "failed", reason: "dry_run" }); continue; }
      const credentialRefs: Record<string, string> = { ...def.envRefs };
      const stored: string[] = [];
      try {
        // An MCPB archive is extracted into its fixed directory only now, when the owner registers it.
        if (loaded.bundle?.archive) extractMcpbArchive(loaded.bundle);
        // A key the source names but gives no value (an MCPB option the owner fills in) still gets this connection's own slot.
        const token = def.secretKeys.length || (input.kind === "mcpb" && def.envKeys.length) ? newConnectionCredentialToken() : "";
        for (const key of def.secretKeys) {
          const value = secrets.get(`${def.name}\u0000${key}`);
          if (!value) continue;
          const vaultKey = connectionVaultKey(token, key);
          await input.ports.setEnv(vaultKey, value);
          stored.push(vaultKey);
          credentialRefs[key] = vaultKey;
          base.vaultSaved.push(key);
        }
        if (input.kind === "mcpb") for (const key of def.envKeys) if (!credentialRefs[key]) credentialRefs[key] = connectionVaultKey(token, key);
        const server = input.ports.install({ name: def.name, transport: def.transport, ...(def.command ? { command: def.command } : {}), args: def.args, ...(def.url ? { url: def.url } : {}), envKeys: def.envKeys, ...(Object.keys(credentialRefs).length ? { credentialRefs } : {}) });
        input.ports.disable(server.id);
        installed.push({ id: server.id, command: def.command ?? null, args: def.args, url: def.url ?? null, name: def.name, envKeys: def.envKeys, credentialRefs });
        outcomes.push({ ...base, status: "registered", serverId: server.id, ...(Object.keys(credentialRefs).length ? { credentialRefs } : {}) });
      } catch (error) {
        // Nothing half-registered: values stored for a connection that was never created are removed again.
        for (const vaultKey of stored) await input.ports.deleteEnv(vaultKey).catch(() => undefined);
        outcomes.push({ ...base, vaultSaved: [], status: "failed", reason: error instanceof Error ? error.message.slice(0, 200) : "import failed" });
      }
    }
  } finally {
    secrets.clear();
  }
  return outcomes;
}
