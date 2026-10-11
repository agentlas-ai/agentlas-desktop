// One's capability inventory: every skill, plugin, hook, memory source and connector (MCP server) that the
// person's own Codex, Claude Code and Cursor setups hold, plus Agentlas's own, each with its own on/off.
//
// Owner decision 2026-10-11 (all users):
//   - A product run never carries the person's own memories, skills, plugins, hooks or MCP servers by default.
//   - Only One (the top orchestrator) may use them, and only the items the person switched on. Every other
//     agent (rooms, workers, borrowed agents, Science) never gets any of them.
//   - Personal items (codex / claude / cursor) are OFF until switched on; Agentlas's own are ON.
//
// This module is the Main-side model: inventory (value-free list), detail (size-capped text, never a
// credential), persisted on/off, and the selection a run assembles from (selectionFor). Products consume
// the selection in codex-personal-context.ts / claude-code.ts.
//
// The list carries names, descriptions taken from a skill's own front matter, and file paths. It never
// carries file content, command lines, headers, environment values or tokens. `detail` returns the text of
// one item, redacted and capped, and refuses credential files by name.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
import { userDataPath } from "../runtime-paths";

export type CapabilityKind = "skill" | "plugin" | "hook" | "memory" | "connector";
export type CapabilitySource = "codex" | "claude" | "cursor" | "agentlas";

export interface CapabilityItem {
  id: string;
  kind: CapabilityKind;
  source: CapabilitySource;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  /** Whether a product run can enforce this item's switch today (false: listed and stored, not yet enforceable). */
  applies: boolean;
}

export interface CapabilityDetail {
  id: string;
  kind: CapabilityKind;
  source: CapabilitySource;
  name: string;
  path: string;
  text: string;
  bytes: number;
  truncated: boolean;
  redacted: boolean;
}

export interface CapabilityRoots {
  home: string;
  codexHome: string;
  claudeDir: string;
  cursorDir: string;
  agentlasDir: string;
}

export const PERSONAL_SOURCES: readonly CapabilitySource[] = ["codex", "claude", "cursor"];
export const DETAIL_MAX_BYTES = 64 * 1024;
const MAX_SKILL_DEPTH = 5;
const MAX_ITEMS_PER_KIND = 1500;
/** Marketplaces that are Agentlas's own, in either host: always on. */
const AGENTLAS_MARKETPLACES = new Set(["agentlas-core-engine", "agentlas-sei"]);

export function defaultCapabilityRoots(env: NodeJS.ProcessEnv = process.env): CapabilityRoots {
  const home = path.resolve(env.HOME || os.homedir());
  return {
    home,
    codexHome: path.resolve(env.CODEX_HOME || path.join(home, ".codex")),
    claudeDir: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
    cursorDir: path.join(home, ".cursor"),
    agentlasDir: path.join(home, ".agentlas"),
  };
}

/* ------------------------------------------------------------------ persisted state */

interface CapabilityState { items: Record<string, boolean>; sources: Partial<Record<CapabilitySource, boolean>> }
const STATE_FILE = "one-capabilities.json";
const RECHECK_MS = 2_000;
let stateCache: { checkedAt: number; mtimeMs: number; value: CapabilityState } | null = null;

function emptyState(): CapabilityState { return { items: {}, sources: {} }; }

/** A file in the user data folder, not process memory: Main and the background service both start runs. */
export function readCapabilityState(): CapabilityState {
  const now = Date.now();
  if (stateCache && now - stateCache.checkedAt < RECHECK_MS) return stateCache.value;
  try {
    const file = userDataPath(STATE_FILE);
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (!stateCache || stateCache.mtimeMs !== mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CapabilityState>;
      const state = emptyState();
      for (const [id, on] of Object.entries(raw.items ?? {})) if (typeof on === "boolean") state.items[id] = on;
      for (const source of ["codex", "claude", "cursor", "agentlas"] as const) {
        const on = raw.sources?.[source];
        if (typeof on === "boolean") state.sources[source] = on;
      }
      stateCache = { checkedAt: now, mtimeMs, value: state };
    } else stateCache.checkedAt = now;
    return stateCache.value;
  } catch {
    return emptyState();
  }
}

function writeCapabilityState(state: CapabilityState): void {
  const file = userDataPath(STATE_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temp, file);
  stateCache = { checkedAt: Date.now(), mtimeMs: fs.statSync(file).mtimeMs, value: state };
}

export function isPersonalSource(source: CapabilitySource): boolean {
  return source !== "agentlas";
}

/** Personal items default OFF, Agentlas's own ON; a per-item choice beats a per-source choice. */
export function capabilityEnabled(item: Pick<CapabilityItem, "id" | "source">, state: CapabilityState = readCapabilityState()): boolean {
  return state.items[item.id] ?? state.sources[item.source] ?? !isPersonalSource(item.source);
}

/* ------------------------------------------------------------------ scanning helpers */

function safeReadDir(dir: string): string[] {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}
function readHead(file: string, bytes = 8192): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, n).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}
function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
function frontMatter(text: string): { name: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const pick = (key: string): string => {
    const line = m ? new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1]) : null;
    return line ? line[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  return { name: pick("name"), description: pick("description") };
}
export function capabilityId(source: CapabilitySource, kind: CapabilityKind, key: string): string {
  return `${source}:${kind}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** Every SKILL.md under a skills root (dot-directories such as `.system` are the host's own bundled skills). */
export function skillFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SKILL_DEPTH || out.length >= MAX_ITEMS_PER_KIND) return;
    for (const name of safeReadDir(dir)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const at = path.join(dir, name);
      if (!isDir(at)) continue;
      const file = path.join(at, "SKILL.md");
      if (isFile(file)) out.push(file);
      walk(at, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

type Draft = Omit<CapabilityItem, "id" | "enabled"> & { key: string };

function skillDraft(source: CapabilitySource, file: string, applies: boolean): Draft {
  const fm = frontMatter(readHead(file));
  return { key: file, kind: "skill", source, name: fm.name || path.basename(path.dirname(file)), description: oneLine(fm.description), path: file, applies };
}

/** `[mcp_servers.<name>]` tables of a TOML text, with the transport kind only. */
export function tomlConnectorNames(text: string): Array<{ name: string; transport: "stdio" | "url" }> {
  const found = new Map<string, { command: boolean; url: boolean }>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (table) {
      const m = /^mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)(\..*)?$/.exec(table[1].trim());
      current = m && !m[2] ? m[1].replace(/^"|"$/g, "") : null;
      if (current && !found.has(current)) found.set(current, { command: false, url: false });
      continue;
    }
    if (/^\s*\[\[/.test(line)) { current = null; continue; }
    if (!current) continue;
    const entry = found.get(current)!;
    if (/^\s*command\s*=/.test(line)) entry.command = true;
    if (/^\s*url\s*=/.test(line)) entry.url = true;
  }
  return [...found].map(([name, t]) => ({ name, transport: t.url && !t.command ? "url" as const : "stdio" as const }));
}

function enabledTomlPlugins(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (table) {
      const m = /^plugins\.("[^"]+"|'[^']+'|[A-Za-z0-9_.@-]+)$/.exec(table[1].trim());
      current = m ? m[1].replace(/^["']|["']$/g, "") : null;
      continue;
    }
    if (/^\s*\[\[/.test(line)) { current = null; continue; }
    const flag = current ? /^\s*enabled\s*=\s*(true|false)\b/.exec(line) : null;
    if (current && flag) out.set(current, flag[1] === "true");
  }
  return out;
}

function hookEntries(json: unknown): Array<{ event: string; index: number; sub: number; command: string }> {
  const out: Array<{ event: string; index: number; sub: number; command: string }> = [];
  const hooks = json && typeof json === "object" ? (json as { hooks?: unknown }).hooks : null;
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      const list = group && typeof group === "object" ? (group as { hooks?: unknown }).hooks : null;
      if (!Array.isArray(list)) return;
      list.forEach((hook, sub) => {
        const command = hook && typeof hook === "object" ? String((hook as { command?: unknown }).command ?? (hook as { url?: unknown }).url ?? "") : "";
        out.push({ event, index, sub, command });
      });
    });
  }
  return out;
}
function hookScriptName(command: string): string {
  const token = command.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, "")).find((t) => t.includes("/") || /\.\w+$/.test(t)) ?? command.split(/\s+/)[0] ?? "hook";
  return path.basename(token) || "hook";
}

/* ------------------------------------------------------------------ inventory */

function codexItems(r: CapabilityRoots): Draft[] {
  const out: Draft[] = [];
  const codexSkillRoots = [path.join(r.codexHome, "skills"), path.join(r.home, ".agents", "skills")];
  for (const root of codexSkillRoots) for (const file of skillFilesUnder(root)) out.push(skillDraft("codex", file, true));

  const configPath = path.join(r.codexHome, "config.toml");
  let config = "";
  try { config = fs.readFileSync(configPath, "utf8"); } catch { /* none */ }

  const cache = path.join(r.codexHome, "plugins", "cache");
  const pluginFlags = enabledTomlPlugins(config);
  for (const market of safeReadDir(cache)) {
    for (const plugin of safeReadDir(path.join(cache, market))) {
      const dir = path.join(cache, market, plugin);
      if (!isDir(dir)) continue;
      const version = safeReadDir(dir).filter((v) => isDir(path.join(dir, v))).sort().pop();
      const at = version ? path.join(dir, version) : dir;
      const manifest = (readJson(path.join(at, ".codex-plugin", "plugin.json")) ?? readJson(path.join(at, "plugin.json"))) as { description?: unknown } | null;
      const agentlas = AGENTLAS_MARKETPLACES.has(market);
      out.push({
        key: `${plugin}@${market}`, kind: "plugin", source: agentlas ? "agentlas" : "codex", name: `${plugin}@${market}`,
        description: oneLine(typeof manifest?.description === "string" ? manifest.description : (pluginFlags.get(`${plugin}@${market}`) === false ? "disabled in Codex" : "")),
        path: at, applies: !agentlas,
      });
    }
  }

  const hooksFile = path.join(r.codexHome, "hooks.json");
  for (const h of hookEntries(readJson(hooksFile))) {
    out.push({ key: `${hooksFile}:${h.event}:${h.index}:${h.sub}`, kind: "hook", source: "codex", name: `${h.event} · ${hookScriptName(h.command)}`,
      description: `Codex ${h.event} hook`, path: `${hooksFile}#${h.event}/${h.index}/${h.sub}`, applies: true });
  }

  const mem = path.join(r.codexHome, "memories");
  for (const name of safeReadDir(mem)) {
    const at = path.join(mem, name);
    if (name.endsWith(".md") && isFile(at)) out.push({ key: at, kind: "memory", source: "codex", name, description: "Codex memory", path: at, applies: true });
  }
  const v2 = path.join(r.codexHome, "memories_v2", "memory_summary.md");
  if (isFile(v2)) out.push({ key: v2, kind: "memory", source: "codex", name: "memory_summary.md (v2)", description: "Codex memory summary", path: v2, applies: true });

  for (const c of tomlConnectorNames(config)) {
    out.push({ key: `${configPath}:${c.name}`, kind: "connector", source: "codex", name: c.name, description: `MCP server (${c.transport})`, path: `${configPath}#mcp_servers.${c.name}`, applies: true });
  }
  return out;
}

function claudeItems(r: CapabilityRoots): Draft[] {
  const out: Draft[] = [];
  for (const file of skillFilesUnder(path.join(r.claudeDir, "skills"))) out.push(skillDraft("claude", file, true));
  const commands = path.join(r.claudeDir, "commands");
  for (const name of safeReadDir(commands)) {
    const at = path.join(commands, name);
    if (name.endsWith(".md") && isFile(at)) {
      const fm = frontMatter(readHead(at));
      out.push({ key: at, kind: "skill", source: "claude", name: `/${name.slice(0, -3)}`, description: oneLine(fm.description), path: at, applies: true });
    }
  }

  const installed = readJson(path.join(r.claudeDir, "plugins", "installed_plugins.json")) as { plugins?: Record<string, unknown> } | null;
  for (const id of Object.keys(installed?.plugins ?? {})) {
    const market = id.split("@")[1] ?? "";
    const agentlas = AGENTLAS_MARKETPLACES.has(market);
    out.push({ key: id, kind: "plugin", source: agentlas ? "agentlas" : "claude", name: id, description: "Claude Code plugin", path: path.join(r.claudeDir, "plugins", "installed_plugins.json") + `#${id}`, applies: !agentlas });
  }

  const settingsFile = path.join(r.claudeDir, "settings.json");
  for (const h of hookEntries(readJson(settingsFile))) {
    out.push({ key: `${settingsFile}:${h.event}:${h.index}:${h.sub}`, kind: "hook", source: "claude", name: `${h.event} · ${hookScriptName(h.command)}`,
      description: `Claude Code ${h.event} hook`, path: `${settingsFile}#hooks/${h.event}/${h.index}/${h.sub}`, applies: false });
  }

  const claudeMd = path.join(r.claudeDir, "CLAUDE.md");
  if (isFile(claudeMd)) out.push({ key: claudeMd, kind: "memory", source: "claude", name: "CLAUDE.md", description: "Claude Code personal instructions", path: claudeMd, applies: true });
  const rules = path.join(r.claudeDir, "rules");
  for (const name of safeReadDir(rules)) {
    const at = path.join(rules, name);
    if (name.endsWith(".md") && isFile(at)) out.push({ key: at, kind: "memory", source: "claude", name: `rules/${name}`, description: "Claude Code personal rule", path: at, applies: true });
  }
  const projects = path.join(r.claudeDir, "projects");
  const memories: Array<{ at: string; project: string; mtime: number }> = [];
  for (const project of safeReadDir(projects)) {
    const at = path.join(projects, project, "memory", "MEMORY.md");
    try { memories.push({ at, project, mtime: fs.statSync(at).mtimeMs }); } catch { /* no memory here */ }
  }
  for (const m of memories.sort((a, b) => b.mtime - a.mtime).slice(0, 300)) {
    out.push({ key: m.at, kind: "memory", source: "claude", name: `memory · ${m.project}`, description: "Claude Code project memory", path: m.at, applies: true });
  }

  const userJson = readJson(path.join(r.home, ".claude.json")) as { mcpServers?: Record<string, unknown> } | null;
  for (const [name, def] of Object.entries(userJson?.mcpServers ?? {})) {
    const transport = def && typeof def === "object" && "url" in def ? "url" : "stdio";
    out.push({ key: `claude-mcp:${name}`, kind: "connector", source: "claude", name, description: `MCP server (${transport})`, path: `${path.join(r.home, ".claude.json")}#mcpServers.${name}`, applies: false });
  }
  return out;
}

function cursorItems(r: CapabilityRoots): Draft[] {
  const out: Draft[] = [];
  for (const file of skillFilesUnder(path.join(r.cursorDir, "skills"))) out.push(skillDraft("cursor", file, false));
  const commands = path.join(r.cursorDir, "commands");
  for (const name of safeReadDir(commands)) {
    const at = path.join(commands, name);
    if (name.endsWith(".md") && isFile(at)) out.push({ key: at, kind: "skill", source: "cursor", name: `/${name.slice(0, -3)}`, description: oneLine(frontMatter(readHead(at)).description), path: at, applies: false });
  }
  const rules = path.join(r.cursorDir, "rules");
  for (const name of safeReadDir(rules)) {
    const at = path.join(rules, name);
    if (isFile(at) && /\.(md|mdc)$/.test(name)) out.push({ key: at, kind: "memory", source: "cursor", name: `rules/${name}`, description: "Cursor rule", path: at, applies: false });
  }
  const mcp = readJson(path.join(r.cursorDir, "mcp.json")) as { mcpServers?: Record<string, unknown> } | null;
  for (const [name, def] of Object.entries(mcp?.mcpServers ?? {})) {
    const transport = def && typeof def === "object" && "url" in def ? "url" : "stdio";
    out.push({ key: `cursor-mcp:${name}`, kind: "connector", source: "cursor", name, description: `MCP server (${transport})`, path: `${path.join(r.cursorDir, "mcp.json")}#mcpServers.${name}`, applies: false });
  }
  return out;
}

function agentlasItems(r: CapabilityRoots): Draft[] {
  const out: Draft[] = [];
  const plugins = path.join(r.agentlasDir, "plugins");
  for (const name of safeReadDir(plugins)) {
    const dir = path.join(plugins, name);
    const manifest = readJson(path.join(dir, "plugin.json")) as { name?: unknown; description?: unknown } | null;
    if (!manifest) continue;
    out.push({ key: dir, kind: "plugin", source: "agentlas", name: typeof manifest.name === "string" ? manifest.name : name,
      description: oneLine(typeof manifest.description === "string" ? manifest.description : ""), path: dir, applies: false });
  }
  return out;
}

let inventoryCache: { at: number; key: string; items: CapabilityItem[] } | null = null;
const INVENTORY_MS = 5_000;

/** The whole inventory with each item's on/off for One. Value-free: no file content. */
export function listCapabilities(roots: CapabilityRoots = defaultCapabilityRoots(), options: { fresh?: boolean } = {}): CapabilityItem[] {
  const key = JSON.stringify(roots);
  const now = Date.now();
  const state = readCapabilityState();
  if (!options.fresh && inventoryCache && inventoryCache.key === key && now - inventoryCache.at < INVENTORY_MS) {
    return inventoryCache.items.map((item) => ({ ...item, enabled: capabilityEnabled(item, state) }));
  }
  const seen = new Set<string>();
  const items: CapabilityItem[] = [];
  for (const draft of [...codexItems(roots), ...claudeItems(roots), ...cursorItems(roots), ...agentlasItems(roots)]) {
    const id = capabilityId(draft.source, draft.kind, draft.key);
    if (seen.has(id)) continue;
    seen.add(id);
    const { key: _key, ...rest } = draft;
    items.push({ id, ...rest, enabled: false });
  }
  inventoryCache = { at: now, key, items };
  return items.map((item) => ({ ...item, enabled: capabilityEnabled(item, state) }));
}

/* ------------------------------------------------------------------ detail */

const CREDENTIAL_NAME = /(^|[\\/._-])(auth|credentials?|secrets?|tokens?|passwd|password|id_rsa|id_ed25519|keychain|cookies?)([\\/._-]|$)|\.env($|\.)|\.(pem|key|p12|pfx|keystore)$/i;
/** True for a path whose name says it holds credentials; detail never reads these. */
export function looksLikeCredentialFile(file: string): boolean {
  return CREDENTIAL_NAME.test(path.basename(file)) || /[\\/]\.ssh[\\/]|[\\/]signing[\\/]|[\\/]credentials[\\/]/.test(file);
}
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /(["']?[\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|authorization|credential)[\w.-]*["']?\s*[:=]\s*)(["']?)[^\s"',}]{6,}\2/gi,
];
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (...m) => {
      redacted = true;
      return typeof m[1] === "string" && m[1].length > 0 && !/^(sk|pk|rk|gh|xox|AKIA|AIza|eyJ|Bearer|Basic)/i.test(m[0]) ? `${m[1]}<redacted>` : "<redacted>";
    });
  }
  return { text: out, redacted };
}

function realInside(file: string, roots: string[]): boolean {
  try {
    const real = fs.realpathSync(file);
    return roots.some((root) => { let r: string; try { r = fs.realpathSync(root); } catch { r = root; } return real === r || real.startsWith(r + path.sep); });
  } catch { return false; }
}

function capText(buffer: Buffer): { text: string; bytes: number; truncated: boolean } {
  const truncated = buffer.length > DETAIL_MAX_BYTES;
  return { text: buffer.subarray(0, DETAIL_MAX_BYTES).toString("utf8"), bytes: buffer.length, truncated };
}

function connectorText(item: CapabilityItem, roots: CapabilityRoots): string {
  const name = item.name;
  if (item.source === "codex") {
    let config = "";
    try { config = fs.readFileSync(path.join(roots.codexHome, "config.toml"), "utf8"); } catch { return ""; }
    const lines: string[] = [];
    let on = false;
    for (const line of config.split(/\r?\n/)) {
      const table = /^\s*\[([^\[\]]+)\]/.exec(line);
      if (table) { on = new RegExp(`^mcp_servers\\.("?)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1(\\.|$)`).test(table[1].trim()); }
      if (on) lines.push(line);
    }
    return lines.join("\n");
  }
  const file = item.source === "claude" ? path.join(roots.home, ".claude.json") : path.join(roots.cursorDir, "mcp.json");
  const json = readJson(file) as { mcpServers?: Record<string, unknown> } | null;
  const def = json?.mcpServers?.[name];
  if (!def || typeof def !== "object") return "";
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def as Record<string, unknown>)) {
    if (k === "env" || k === "headers") safe[k] = Object.fromEntries(Object.keys((v ?? {}) as object).map((key) => [key, "<redacted>"]));
    else safe[k] = v;
  }
  return JSON.stringify(safe, null, 2);
}

function hookText(item: CapabilityItem): string {
  const m = /^(.*)#(.+?)\/(\d+)\/(\d+)$/.exec(item.path) ?? /^(.*)#hooks\/(.+?)\/(\d+)\/(\d+)$/.exec(item.path);
  if (!m) return "";
  const json = readJson(m[1]);
  const hook = hookEntries(json).find((h) => h.event === m[2] && h.index === Number(m[3]) && h.sub === Number(m[4]));
  return hook ? hook.command : "";
}

export function capabilityDetail(id: string, roots: CapabilityRoots = defaultCapabilityRoots()): CapabilityDetail | null {
  const item = listCapabilities(roots, { fresh: true }).find((candidate) => candidate.id === id);
  if (!item) return null;
  const head = { id: item.id, kind: item.kind, source: item.source, name: item.name, path: item.path };
  let raw: Buffer;
  if (item.kind === "connector") raw = Buffer.from(connectorText(item, roots));
  else if (item.kind === "hook") raw = Buffer.from(hookText(item));
  else if (item.kind === "plugin") {
    const dir = isDir(item.path) ? item.path : "";
    const manifest = dir ? [".codex-plugin/plugin.json", "plugin.json", ".claude-plugin/plugin.json"].map((rel) => path.join(dir, rel)).find(isFile) : "";
    raw = manifest && !looksLikeCredentialFile(manifest) ? fs.readFileSync(manifest) : Buffer.from(`${item.name}\n${item.description}`);
  } else {
    const allowed = [roots.codexHome, roots.claudeDir, roots.cursorDir, roots.agentlasDir, path.join(roots.home, ".agents")];
    if (looksLikeCredentialFile(item.path) || !isFile(item.path) || !realInside(item.path, allowed)) {
      return { ...head, text: "", bytes: 0, truncated: false, redacted: false };
    }
    const fd = fs.openSync(item.path, "r");
    try {
      const buffer = Buffer.alloc(DETAIL_MAX_BYTES + 1);
      const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
      raw = buffer.subarray(0, n);
    } finally { fs.closeSync(fd); }
  }
  const capped = capText(raw);
  const safe = redactSecrets(capped.text);
  return { ...head, text: safe.text, bytes: capped.bytes, truncated: capped.truncated, redacted: safe.redacted };
}

/* ------------------------------------------------------------------ switches */

export function setCapabilityEnabled(id: string, enabled: boolean, roots: CapabilityRoots = defaultCapabilityRoots()): CapabilityItem | null {
  const item = listCapabilities(roots, { fresh: true }).find((candidate) => candidate.id === id);
  if (!item) return null;
  const state = { items: { ...readCapabilityState().items }, sources: { ...readCapabilityState().sources } };
  state.items[id] = enabled === true;
  writeCapabilityState(state);
  return { ...item, enabled: enabled === true };
}

/** Bulk: every item of a source (optionally one kind) switched together; items inherit the source default afterwards. */
export function setSourceEnabled(source: CapabilitySource, enabled: boolean, kind?: CapabilityKind, roots: CapabilityRoots = defaultCapabilityRoots()): { source: CapabilitySource; changed: number } {
  const current = readCapabilityState();
  const state = { items: { ...current.items }, sources: { ...current.sources } };
  const targets = listCapabilities(roots, { fresh: true }).filter((item) => item.source === source && (!kind || item.kind === kind));
  if (!kind) { state.sources[source] = enabled === true; for (const item of targets) delete state.items[item.id]; }
  else for (const item of targets) state.items[item.id] = enabled === true;
  writeCapabilityState(state);
  return { source, changed: targets.length };
}

/* ------------------------------------------------------------------ run assembly */

export interface CapabilitySelection {
  /** True only for One. */
  isOne: boolean;
  /** Every inventory item with the on/off this run gets: workers have every personal item off. */
  items: CapabilityItem[];
}

/**
 * The selection a product run assembles from. Only One may have personal items on, and only the ones the
 * person switched on; every other agent (rooms, workers, borrowed agents, Science) gets none of them.
 */
export function selectionFor(agentId: string | undefined, roots: CapabilityRoots = defaultCapabilityRoots()): CapabilitySelection {
  const isOne = agentId === BUILTIN_ONE_AGENT_ID;
  const items = listCapabilities(roots).map((item) => (isPersonalSource(item.source) && !isOne ? { ...item, enabled: false } : item));
  return { isOne, items };
}
