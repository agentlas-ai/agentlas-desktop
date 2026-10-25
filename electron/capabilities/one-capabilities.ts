// One's capability inventory: every skill, plugin, hook, memory source and connector (MCP server) that the
// person's own Codex, Claude Code and Cursor setups hold, plus Agentlas's own, each with its own on/off.
//
// Owner decision 2026-10-11 (all users):
//   - A product run never carries the person's own memories, skills, plugins, hooks or MCP servers by default.
//   - Only One (the top orchestrator) may use them, and only the items the person switched on. Every other
//     agent (rooms, workers, borrowed agents, Science) never gets any of them.
//   - Personal items (codex / claude / cursor) are OFF until switched on; Agentlas's own are ON.
//   - Owner 2026-10-12: Agentlas's built-in capabilities are always on and never listed. Built-in is an explicit
//     definition, not a name: a plugin package the app bundle ships (dist/plugins/<slug>/plugin.json) or a plugin
//     of the Agentlas engine marketplaces. An Agentlas-named extension installed separately stays listed.
//   - A switch a run cannot enforce is not offered: the item is listed with its limit, and a request to flip it
//     (screen, IPC or One) is refused instead of being stored as if it worked.
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
import { cliUserHome } from "../runtime/product-home-identity";

export type CapabilityKind = "skill" | "plugin" | "hook" | "memory" | "connector";
export type CapabilitySource = "codex" | "claude" | "cursor" | "grok" | "gemini" | "copilot" | "agentlas";

export interface CapabilityItem {
  id: string;
  kind: CapabilityKind;
  source: CapabilitySource;
  name: string;
  /** Display name when it differs from the runtime key in `name` (a plugin key is `slug@marketplace`). */
  title?: string;
  description: string;
  /** Korean display name and description, when the item's own manifest carries them (an Agentlas plugin's surface). */
  titleKo?: string;
  descriptionKo?: string;
  path: string;
  enabled: boolean;
  /** Whether a product run can enforce this item's switch (false: listed with `limit`, never switchable). */
  applies: boolean;
  /** Why the switch is not offered: the runtime loads it on its own, or Agentlas connects it when a turn needs it. */
  limit?: CapabilityLimit;
  /** Personal / CEO scope for a switchable item; absent = both (items stored before scopes existed). */
  role?: CapabilityRole;
}

export type CapabilityLimit = "runtime_reads_itself" | "agentlas_managed" | "personal_runtime";
/** Which One may use an item: the personal conversation, One as CEO (rooms, organization), or both (21 G3). */
export type CapabilityRole = "both" | "personal" | "ceo";
const CAPABILITY_ROLES: readonly CapabilityRole[] = ["both", "personal", "ceo"];

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
  /** Grok's own folder (GROK_HOME, default ~/.grok). */
  grokDir: string;
  /** Antigravity / Gemini CLI's folder (~/.gemini). */
  geminiDir: string;
  /** GitHub Copilot CLI's folder (~/.copilot). */
  copilotDir: string;
  agentlasDir: string;
  /** The plugin packages the app bundle ships (dist/plugins); their installed copies are built-ins. */
  bundledPluginsDir?: string;
}

export const PERSONAL_SOURCES: readonly CapabilitySource[] = ["codex", "claude", "cursor", "grok", "gemini", "copilot"];
export const DETAIL_MAX_BYTES = 64 * 1024;
const MAX_SKILL_DEPTH = 5;
const MAX_ITEMS_PER_KIND = 1500;
/** Marketplaces that are Agentlas's own, in either host: always on. */
const AGENTLAS_MARKETPLACES = new Set(["agentlas-core-engine", "agentlas-sei"]);

export function defaultCapabilityRoots(env: NodeJS.ProcessEnv = process.env): CapabilityRoots {
  const home = path.resolve(cliUserHome(env));
  return {
    home,
    codexHome: path.resolve(env.CODEX_HOME || path.join(home, ".codex")),
    claudeDir: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
    cursorDir: path.join(home, ".cursor"),
    grokDir: path.resolve(env.GROK_HOME || path.join(home, ".grok")),
    geminiDir: path.join(home, ".gemini"),
    copilotDir: path.join(home, ".copilot"),
    agentlasDir: path.join(home, ".agentlas"),
    bundledPluginsDir: BUNDLED_PLUGINS_DIR,
  };
}

/** dist/electron/capabilities -> dist/plugins, the same place plugins/builtin.ts loads the built-in manifests from. */
const BUNDLED_PLUGINS_DIR = path.resolve(__dirname, "..", "..", "plugins");
const CAPABILITY_SOURCES: readonly CapabilitySource[] = ["codex", "claude", "cursor", "grok", "gemini", "copilot", "agentlas"];

/** Slugs of the plugin packages the app ships. Explicit: a package counts only if its own manifest names that slug. */
export function bundledAgentlasPluginSlugs(dir: string = BUNDLED_PLUGINS_DIR): Set<string> {
  const slugs = new Set<string>();
  for (const name of safeReadDir(dir)) {
    const manifest = readJson(path.join(dir, name, "plugin.json")) as Record<string, unknown> | null;
    if (manifest && /^agentlas\.plugin\//.test(str(manifest.schema)) && str(manifest.slug) === name) slugs.add(name);
  }
  return slugs;
}

/* ------------------------------------------------------------------ persisted state */

interface CapabilityState { items: Record<string, boolean>; sources: Partial<Record<CapabilitySource, boolean>>; roles: Record<string, CapabilityRole> }
const STATE_FILE = "one-capabilities.json";
let stateCache: { stamp: string; value: CapabilityState } | null = null;

function emptyState(): CapabilityState { return { items: {}, sources: {}, roles: {} }; }

/**
 * A file in the user data folder, not process memory: Main writes it and both Main and the background service start
 * runs from it. Every read checks the file (a stat; it is re-parsed only when its inode, size or mtime changed), so a
 * switch flipped in Main reaches the service's very next turn. A time-based cache used to hand a live service the
 * old state for up to 2 s.
 */
export function readCapabilityState(options: { fresh?: boolean } = {}): CapabilityState {
  try {
    const file = userDataPath(STATE_FILE);
    const stat = fs.statSync(file);
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (options.fresh || !stateCache || stateCache.stamp !== stamp) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CapabilityState>;
      const state = emptyState();
      for (const [id, on] of Object.entries(raw.items ?? {})) if (typeof on === "boolean") state.items[id] = on;
      for (const [id, role] of Object.entries(raw.roles ?? {})) if (CAPABILITY_ROLES.includes(role as CapabilityRole) && role !== "both") state.roles[id] = role as CapabilityRole;
      for (const source of CAPABILITY_SOURCES) {
        const on = raw.sources?.[source];
        if (typeof on === "boolean") state.sources[source] = on;
      }
      stateCache = { stamp, value: state };
    }
    return stateCache.value;
  } catch {
    stateCache = null;
    return emptyState();
  }
}

function writeCapabilityState(state: CapabilityState): void {
  const file = userDataPath(STATE_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temp, file);
  const stat = fs.statSync(file);
  stateCache = { stamp: `${stat.ino}:${stat.size}:${stat.mtimeMs}`, value: state };
}

export function isPersonalSource(source: CapabilitySource): boolean {
  return source !== "agentlas";
}

/**
 * Personal items default OFF, Agentlas's own ON; a per-item choice beats a per-source choice. An item without an
 * enforceable switch has a fixed answer, whatever an older build stored: an Agentlas extension stays available, and
 * a personal one is never switched on by Agentlas anywhere (its own runtime may still load it; the screen says so).
 * Grok's compatibility cells read these, so a stale ON must not turn them on.
 */
export function capabilityEnabled(item: Pick<CapabilityItem, "id" | "source" | "applies">, state: CapabilityState = readCapabilityState()): boolean {
  // Owner 2026-10-14: product runs use only Agentlas's own skills, plugins and connectors. The Agentlas harness drives
  // each runtime (app-server, claude -p, ACP), so a runtime's personal skills, plugins, hooks, memory and connectors
  // are never switched on, whatever an older build stored ("agentlas 전용 스킬 플러그인 커넥터만 쓸 수있게").
  if (isPersonalSource(item.source)) return false;
  if (!item.applies) return true;
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
      // A skill folder's children are its own parts (nested skills, references), not separate skills.
      if (isFile(file)) { out.push(file); continue; }
      walk(at, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

type Draft = Omit<CapabilityItem, "id" | "enabled"> & { key: string; /** Identity within (source, kind); defaults to key. */ canon?: string; /** Agentlas built-in: always on, never listed. */ builtin?: boolean };

/** Scratch, build output, release-check trees and the OS temp dir are never capabilities. */
const SCRATCH_SEGMENT = /(^|[\\/])(tmp|temp|dist|node_modules|\.next-build|release-check[^\\/]*|relcheck[^\\/]*|rel\d+|[^\\/]*-dist|[^\\/]*\.backup-[^\\/]*)([\\/]|$)/i;
let scratchBases: string[] = [];
/** Never a capability: scratch, build output, release-check trees and the OS temp dir (judged below the person's home when the home is itself under temp). */
export function isScratchPath(file: string): boolean {
  const plain = file.split("#")[0];
  let real = plain;
  try { real = fs.realpathSync(plain); } catch { /* keep the given path */ }
  const temp = [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  for (const candidate of [plain, real]) {
    const base = scratchBases.find((b) => candidate === b || candidate.startsWith(b + path.sep));
    const inHome = Boolean(base);
    if (!inHome && temp.some((root) => candidate === root || candidate.startsWith(root + path.sep))) return true;
    const judged = base ? candidate.slice(base.length) : candidate;
    if (SCRATCH_SEGMENT.test(judged)) return true;
  }
  return false;
}

/** A skill is a SKILL.md with a frontmatter name AND description; anything less is not loaded as a skill. */
function skillDraft(source: CapabilitySource, file: string, applies: boolean): Draft | null {
  if (isScratchPath(file)) return null;
  const fm = frontMatter(readHead(file));
  if (!fm.name || !fm.description) return null;
  return { key: file, canon: fm.name.toLowerCase(), kind: "skill", source, name: fm.name, description: oneLine(fm.description), path: file, applies, ...(applies ? {} : { limit: "runtime_reads_itself" as const }) };
}
function commandDraft(source: CapabilitySource, file: string, applies: boolean): Draft | null {
  if (isScratchPath(file)) return null;
  const fm = frontMatter(readHead(file));
  const slug = path.basename(file).replace(/\.md$/, "");
  if (!fm.description) return null;
  return { key: file, canon: `/${slug}`, kind: "skill", source, name: `/${slug}`, description: oneLine(fm.description), path: file, applies, ...(applies ? {} : { limit: "runtime_reads_itself" as const }) };
}

function str(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function numericLatest(names: string[]): string | undefined {
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
}
interface PluginManifestView { name: string; title: string; description: string }
/** Reads a host plugin manifest; null when it is missing or not a plugin manifest. */
function hostManifest(dir: string, rels: string[]): PluginManifestView | null {
  for (const rel of rels) {
    const json = readJson(path.join(dir, rel)) as Record<string, unknown> | null;
    if (!json || typeof json !== "object" || Array.isArray(json)) continue;
    const name = str(json.name);
    if (!name) continue;
    const ui = (json.interface && typeof json.interface === "object" ? json.interface : {}) as Record<string, unknown>;
    return { name, title: str(ui.displayName) || str(json.displayName) || name,
      description: oneLine(str(json.description) || str(ui.shortDescription) || str(ui.longDescription)) };
  }
  return null;
}
function dirCount(dir: string, accept: (name: string) => boolean): number {
  return safeReadDir(dir).filter((name) => !name.startsWith(".") && accept(name)).length;
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
  for (const root of codexSkillRoots) for (const file of skillFilesUnder(root)) { const draft = skillDraft("codex", file, true); if (draft) out.push(draft); }

  const configPath = path.join(r.codexHome, "config.toml");
  let config = "";
  try { config = fs.readFileSync(configPath, "utf8"); } catch { /* none */ }

  const cache = path.join(r.codexHome, "plugins", "cache");
  const pluginFlags = enabledTomlPlugins(config);
  for (const market of safeReadDir(cache)) {
    if (market.startsWith(".")) continue;
    for (const plugin of safeReadDir(path.join(cache, market))) {
      const dir = path.join(cache, market, plugin);
      if (plugin.startsWith(".") || !isDir(dir)) continue;
      const versions = safeReadDir(dir).filter((v) => !v.startsWith(".") && isDir(path.join(dir, v)));
      const version = numericLatest(versions);
      const at = version ? path.join(dir, version) : dir;
      if (isScratchPath(at)) continue;
      const manifest = hostManifest(at, [".codex-plugin/plugin.json"]);
      if (!manifest) continue;
      const agentlas = AGENTLAS_MARKETPLACES.has(market);
      out.push({
        key: `${plugin}@${market}`, canon: plugin.toLowerCase(), kind: "plugin", source: agentlas ? "agentlas" : "codex", name: `${plugin}@${market}`,
        title: manifest.title,
        description: manifest.description || (pluginFlags.get(`${plugin}@${market}`) === false ? "disabled in Codex" : ""),
        path: at, applies: !agentlas, ...(agentlas ? { builtin: true } : {}),
      });
    }
  }

  const hooksFile = path.join(r.codexHome, "hooks.json");
  for (const h of hookEntries(readJson(hooksFile))) {
    out.push({ key: `${hooksFile}:${h.event}:${h.index}:${h.sub}`, kind: "hook", source: "codex", name: `${h.event} · ${hookScriptName(h.command)}`,
      description: `Codex ${h.event} hook`, path: `${hooksFile}#${h.event}/${h.index}/${h.sub}`, applies: true });
  }

  const mem = path.join(r.codexHome, "memories");
  const memFiles = safeReadDir(mem).filter((name) => name.endsWith(".md") && isFile(path.join(mem, name))).length;
  const v2 = path.join(r.codexHome, "memories_v2", "memory_summary.md");
  const memTotal = memFiles + (isFile(v2) ? 1 : 0);
  if (memTotal > 0) {
    out.push({ key: `${mem}`, kind: "memory", source: "codex", name: "memories", title: `Codex 메모리 (${memTotal}개 파일)`,
      description: "Codex memory folder", path: mem, applies: true });
  }

  for (const c of tomlConnectorNames(config)) {
    out.push({ key: `${configPath}:${c.name}`, kind: "connector", source: "codex", name: c.name, description: `MCP server (${c.transport})`, path: `${configPath}#mcp_servers.${c.name}`, applies: true });
  }
  return out;
}

function claudeItems(r: CapabilityRoots): Draft[] {
  const out: Draft[] = [];
  for (const file of skillFilesUnder(path.join(r.claudeDir, "skills"))) { const draft = skillDraft("claude", file, true); if (draft) out.push(draft); }
  const commands = path.join(r.claudeDir, "commands");
  for (const name of safeReadDir(commands)) {
    const at = path.join(commands, name);
    if (name.endsWith(".md") && isFile(at)) { const draft = commandDraft("claude", at, true); if (draft) out.push(draft); }
  }

  const installed = readJson(path.join(r.claudeDir, "plugins", "installed_plugins.json")) as { plugins?: Record<string, unknown> } | null;
  for (const [id, entry] of Object.entries(installed?.plugins ?? {})) {
    const market = id.split("@")[1] ?? "";
    const slug = id.split("@")[0];
    const record = (Array.isArray(entry) ? entry[0] : entry) as { installPath?: unknown } | undefined;
    const installPath = str(record?.installPath);
    if (!installPath || !isDir(installPath) || isScratchPath(installPath)) continue;
    const manifest = hostManifest(installPath, [".claude-plugin/plugin.json"]);
    if (!manifest) continue;
    const agentlas = AGENTLAS_MARKETPLACES.has(market);
    out.push({ key: id, canon: slug.toLowerCase(), kind: "plugin", source: agentlas ? "agentlas" : "claude", name: id, title: manifest.title,
      description: manifest.description, path: installPath, applies: !agentlas, ...(agentlas ? { builtin: true } : {}) });
  }

  const settingsFile = path.join(r.claudeDir, "settings.json");
  for (const h of hookEntries(readJson(settingsFile))) {
    out.push({ key: `${settingsFile}:${h.event}:${h.index}:${h.sub}`, kind: "hook", source: "claude", name: `${h.event} · ${hookScriptName(h.command)}`,
      description: `Claude Code ${h.event} hook`, path: `${settingsFile}#hooks/${h.event}/${h.index}/${h.sub}`, applies: false, limit: "runtime_reads_itself" });
  }

  const claudeMd = path.join(r.claudeDir, "CLAUDE.md");
  if (isFile(claudeMd)) out.push({ key: claudeMd, kind: "memory", source: "claude", name: "CLAUDE.md", description: "Claude Code personal instructions", path: claudeMd, applies: true });
  const rules = path.join(r.claudeDir, "rules");
  const ruleCount = dirCount(rules, (name) => name.endsWith(".md") && isFile(path.join(rules, name)));
  if (ruleCount > 0) {
    out.push({ key: rules, kind: "memory", source: "claude", name: "rules/", title: `Claude Code 규칙 (${ruleCount}개 파일)`, description: "Claude Code personal rules folder", path: rules, applies: true });
  }
  const projects = path.join(r.claudeDir, "projects");
  const projectMemories = safeReadDir(projects).filter((project) => isFile(path.join(projects, project, "memory", "MEMORY.md"))).length;
  if (projectMemories > 0) {
    out.push({ key: projects, kind: "memory", source: "claude", name: "project-memory", title: `Claude Code 프로젝트 메모리 (${projectMemories}개 프로젝트)`,
      description: "Claude Code per-project memory", path: projects, applies: true });
  }

  const userJson = readJson(path.join(r.home, ".claude.json")) as { mcpServers?: Record<string, unknown> } | null;
  for (const [name, def] of Object.entries(userJson?.mcpServers ?? {})) {
    const transport = def && typeof def === "object" && "url" in def ? "url" : "stdio";
    out.push({ key: `claude-mcp:${name}`, kind: "connector", source: "claude", name, description: `MCP server (${transport})`, path: `${path.join(r.home, ".claude.json")}#mcpServers.${name}`, applies: true });
  }
  return out;
}

function cursorItems(r: CapabilityRoots): Draft[] {
  const out: Draft[] = [];
  for (const file of skillFilesUnder(path.join(r.cursorDir, "skills"))) { const draft = skillDraft("cursor", file, false); if (draft) out.push(draft); }
  const commands = path.join(r.cursorDir, "commands");
  for (const name of safeReadDir(commands)) {
    const at = path.join(commands, name);
    if (name.endsWith(".md") && isFile(at)) { const draft = commandDraft("cursor", at, false); if (draft) out.push(draft); }
  }
  const rules = path.join(r.cursorDir, "rules");
  const cursorRules = dirCount(rules, (name) => /\.(md|mdc)$/.test(name) && isFile(path.join(rules, name)));
  if (cursorRules > 0) {
    out.push({ key: rules, kind: "memory", source: "cursor", name: "rules/", title: `Cursor 규칙 (${cursorRules}개 파일)`, description: "Cursor rules folder", path: rules, applies: false, limit: "runtime_reads_itself" });
  }
  const mcp = readJson(path.join(r.cursorDir, "mcp.json")) as { mcpServers?: Record<string, unknown> } | null;
  for (const [name, def] of Object.entries(mcp?.mcpServers ?? {})) {
    const transport = def && typeof def === "object" && "url" in def ? "url" : "stdio";
    out.push({ key: `cursor-mcp:${name}`, kind: "connector", source: "cursor", name, description: `MCP server (${transport})`, path: `${path.join(r.cursorDir, "mcp.json")}#mcpServers.${name}`, applies: false, limit: "runtime_reads_itself" });
  }
  return out;
}

/** Grok's own folder: Agents.md, memory-v2, skills, hook files and the `[mcp_servers.*]` of its config.toml. */
function grokItems(roots: CapabilityRoots): Draft[] {
  const r = { ...roots, grokDir: roots.grokDir ?? path.join(roots.home, ".grok") };
  const out: Draft[] = [];
  for (const name of ["Agents.md", "AGENTS.md"]) {
    const file = path.join(r.grokDir, name);
    if (isFile(file)) { out.push({ key: file, canon: "agents.md", kind: "memory", source: "grok", name, description: "Grok personal instructions", path: file, applies: true }); break; }
  }
  const v2 = path.join(r.grokDir, "memory-v2");
  if (isDir(v2) && safeReadDir(v2).length > 0) {
    out.push({ key: v2, kind: "memory", source: "grok", name: "memory-v2", title: "Grok 메모리", description: "Grok cross-session memory", path: v2, applies: true });
  }
  for (const file of skillFilesUnder(path.join(r.grokDir, "skills"))) { const draft = skillDraft("grok", file, true); if (draft) out.push(draft); }
  const hooks = path.join(r.grokDir, "hooks");
  for (const name of safeReadDir(hooks)) {
    const at = path.join(hooks, name);
    if (name.endsWith(".json") && isFile(at)) {
      out.push({ key: at, kind: "hook", source: "grok", name, description: "Grok hook file", path: at, applies: true });
    }
  }
  const configPath = path.join(r.grokDir, "config.toml");
  let config = "";
  try { config = fs.readFileSync(configPath, "utf8"); } catch { /* none */ }
  for (const c of tomlConnectorNames(config)) {
    out.push({ key: `${configPath}:${c.name}`, kind: "connector", source: "grok", name: c.name, description: `MCP server (${c.transport})`, path: `${configPath}#mcp_servers.${c.name}`, applies: true });
  }
  return out;
}

/** Antigravity (agy) and Gemini CLI: ~/.gemini/GEMINI.md and the config folder's skills, plugins, hooks and MCP servers. */
function geminiItems(roots: CapabilityRoots): Draft[] {
  const r = { ...roots, geminiDir: roots.geminiDir ?? path.join(roots.home, ".gemini") };
  const out: Draft[] = [];
  const memory = path.join(r.geminiDir, "GEMINI.md");
  if (isFile(memory)) out.push({ key: memory, kind: "memory", source: "gemini", name: "GEMINI.md", description: "Antigravity personal instructions", path: memory, applies: true });
  const config = path.join(r.geminiDir, "config");
  for (const file of skillFilesUnder(path.join(config, "skills"))) { const draft = skillDraft("gemini", file, true); if (draft) out.push(draft); }
  const plugins = path.join(config, "plugins");
  for (const name of safeReadDir(plugins)) {
    const dir = path.join(plugins, name);
    if (name.startsWith(".") || !isDir(dir) || isScratchPath(dir)) continue;
    const manifest = readJson(path.join(dir, "plugin.json")) as Record<string, unknown> | null;
    out.push({ key: dir, canon: name.toLowerCase(), kind: "plugin", source: "gemini", name, title: str(manifest?.name) || name,
      description: oneLine(str(manifest?.description)), path: dir, applies: true });
  }
  const hooksFile = path.join(config, "hooks.json");
  const hooks = readJson(hooksFile);
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    for (const [name, def] of Object.entries(hooks as Record<string, unknown>)) {
      if (def && typeof def === "object") out.push({ key: `${hooksFile}:${name}`, kind: "hook", source: "gemini", name, description: "Antigravity hook set", path: `${hooksFile}#${name}`, applies: true });
    }
  }
  const mcpFile = path.join(config, "mcp_config.json");
  const mcp = readJson(mcpFile) as { mcpServers?: Record<string, unknown> } | null;
  for (const [name, def] of Object.entries(mcp?.mcpServers ?? {})) {
    if (name === "agentlas-browser") continue; // written and removed by the app itself for the run that needs it
    const transport = def && typeof def === "object" && ("url" in def || "serverUrl" in def) ? "url" : "stdio";
    out.push({ key: `gemini-mcp:${name}`, kind: "connector", source: "gemini", name, description: `MCP server (${transport})`, path: `${mcpFile}#mcpServers.${name}`, applies: true });
  }
  return out;
}

/** GitHub Copilot CLI: its MCP servers are listed; no switch for them is verified (the CLI is not installed here). */
function copilotItems(roots: CapabilityRoots): Draft[] {
  const r = { ...roots, copilotDir: roots.copilotDir ?? path.join(roots.home, ".copilot") };
  const out: Draft[] = [];
  const file = path.join(r.copilotDir, "mcp-config.json");
  const mcp = readJson(file) as { mcpServers?: Record<string, unknown> } | null;
  for (const [name, def] of Object.entries(mcp?.mcpServers ?? {})) {
    const transport = def && typeof def === "object" && "url" in def ? "url" : "stdio";
    out.push({ key: `copilot-mcp:${name}`, kind: "connector", source: "copilot", name, description: `MCP server (${transport})`, path: `${file}#mcpServers.${name}`, applies: false, limit: "runtime_reads_itself" });
  }
  return out;
}

function agentlasItems(r: CapabilityRoots): Draft[] {
  const out: Draft[] = [];
  const bundled = bundledAgentlasPluginSlugs(r.bundledPluginsDir ?? BUNDLED_PLUGINS_DIR);
  const plugins = path.join(r.agentlasDir, "plugins");
  for (const name of safeReadDir(plugins)) {
    if (name.startsWith(".")) continue; // `.slug.backup-<id>` are the installer's own backups
    const dir = path.join(plugins, name);
    if (!isDir(dir) || isScratchPath(dir)) continue;
    const manifest = readJson(path.join(dir, "plugin.json")) as Record<string, unknown> | null;
    if (!manifest || typeof manifest !== "object" || !/^agentlas\.plugin\//.test(str(manifest.schema)) || str(manifest.slug) !== name) continue;
    const surface = (manifest.surface && typeof manifest.surface === "object" ? manifest.surface : {}) as Record<string, unknown>;
    const title = str(surface.displayName) || str(manifest.name) || name;
    // The Korean screen showed the English text although the package carries its own Korean (displayNameKo,
    // descriptionKo/taglineKo); the renderer picks by locale (one-capabilities-view.ts).
    const titleKo = str(surface.displayNameKo);
    const descriptionKo = oneLine(str(surface.descriptionKo) || str(surface.taglineKo) || str(manifest.descriptionKo));
    out.push({ key: dir, canon: name.toLowerCase(), kind: "plugin", source: "agentlas", name: title, title,
      description: oneLine(str(surface.description) || str(surface.tagline) || str(manifest.description)), path: dir, applies: false,
      ...(titleKo ? { titleKo } : {}), ...(descriptionKo ? { descriptionKo } : {}),
      ...(bundled.has(name) ? { builtin: true } : { limit: "agentlas_managed" as const }) });
  }
  return out;
}

type InventoryEntry = CapabilityItem & { builtin: boolean };
let inventoryCache: { at: number; key: string; items: InventoryEntry[] } | null = null;
const INVENTORY_MS = 5_000;

/** Every item including the hidden built-ins, with the on/off a run gets. Built-ins are always on. */
function inventory(roots: CapabilityRoots, fresh: boolean): InventoryEntry[] {
  const key = JSON.stringify(roots);
  const now = Date.now();
  const state = readCapabilityState();
  const withState = (list: InventoryEntry[]) => list.map((item) => ({ ...item, enabled: item.builtin || capabilityEnabled(item, state),
    ...(item.applies && !item.builtin ? { role: state.roles[item.id] ?? "both" } : {}) }));
  if (!fresh && inventoryCache && inventoryCache.key === key && now - inventoryCache.at < INVENTORY_MS) return withState(inventoryCache.items);
  const seen = new Set<string>();
  const items: InventoryEntry[] = [];
  scratchBases = [roots.home];
  try { scratchBases.push(fs.realpathSync(roots.home)); } catch { /* home may not exist */ }
  for (const draft of [...codexItems(roots), ...claudeItems(roots), ...cursorItems(roots), ...grokItems(roots), ...geminiItems(roots), ...copilotItems(roots), ...agentlasItems(roots)]) {
    const id = capabilityId(draft.source, draft.kind, draft.key);
    const identity = `${draft.source}|${draft.kind}|${draft.canon ?? draft.key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const { key: _key, canon: _canon, builtin, ...rest } = draft;
    items.push({ id, ...rest, enabled: false, builtin: builtin === true });
  }
  inventoryCache = { at: now, key, items };
  return withState(items);
}

const publicItem = ({ builtin: _builtin, ...item }: InventoryEntry): CapabilityItem => item;

/**
 * The inventory the person sees and switches, with each item's on/off for One. Value-free: no file content.
 * Agentlas built-ins are not part of it (always on, owner 2026-10-12), so lists, counts, search and detail never
 * show them.
 */
export function listCapabilities(roots: CapabilityRoots = defaultCapabilityRoots(), options: { fresh?: boolean } = {}): CapabilityItem[] {
  // Personal runtime items are never used by a product run (capabilityEnabled), so they are not listed or counted
  // either: the screen showed 187 Codex/Claude/Cursor skills, all off, including Agentlas's own CLI copies (owner 2026-10-14).
  return inventory(roots, options.fresh === true).filter((item) => !item.builtin && !isPersonalSource(item.source)).map(publicItem);
}

/** Refusal for a switch no run can enforce: built-ins (always on, unlisted) and items whose runtime loads them itself. */
export class CapabilityNotSwitchableError extends Error {
  readonly code = "capability_not_switchable";
  constructor(readonly id: string, readonly reason: "builtin" | CapabilityLimit) {
    super(`capability_not_switchable: ${reason}`);
  }
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
  if (item.source === "grok") {
    let config = "";
    try { config = fs.readFileSync(path.join(roots.grokDir ?? path.join(roots.home, ".grok"), "config.toml"), "utf8"); } catch { return ""; }
    const lines: string[] = [];
    let on = false;
    for (const line of config.split(/\r?\n/)) {
      const table = /^\s*\[([^\[\]]+)\]/.exec(line);
      if (table) { on = new RegExp(`^mcp_servers\\.("?)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1(\\.|$)`).test(table[1].trim()); }
      if (on) lines.push(line);
    }
    return lines.join("\n");
  }
  const file = item.source === "claude" ? path.join(roots.home, ".claude.json")
    : item.source === "gemini" ? path.join(roots.geminiDir ?? path.join(roots.home, ".gemini"), "config", "mcp_config.json")
      : item.source === "copilot" ? path.join(roots.copilotDir ?? path.join(roots.home, ".copilot"), "mcp-config.json")
        : path.join(roots.cursorDir, "mcp.json");
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
  if (item.source === "grok") return isFile(item.path) && !looksLikeCredentialFile(item.path) ? fs.readFileSync(item.path, "utf8").slice(0, DETAIL_MAX_BYTES) : "";
  if (item.source === "gemini") {
    const at = item.path.lastIndexOf("#");
    const json = readJson(item.path.slice(0, at)) as Record<string, unknown> | null;
    return JSON.stringify(json?.[item.path.slice(at + 1)] ?? null, null, 2);
  }
  const m = /^(.*)#(.+?)\/(\d+)\/(\d+)$/.exec(item.path) ?? /^(.*)#hooks\/(.+?)\/(\d+)\/(\d+)$/.exec(item.path);
  if (!m) return "";
  const json = readJson(m[1]);
  const hook = hookEntries(json).find((h) => h.event === m[2] && h.index === Number(m[3]) && h.sub === Number(m[4]));
  return hook ? hook.command : "";
}

/** A memory folder item has no single file: show what it holds (names and sizes, no content). */
function memoryFolderListing(item: CapabilityItem): string {
  const lines: string[] = [item.path, ""];
  if (item.name === "project-memory") {
    for (const project of safeReadDir(item.path)) {
      const file = path.join(item.path, project, "memory", "MEMORY.md");
      if (isFile(file)) lines.push(`${project}  (${fs.statSync(file).size} bytes)`);
    }
  } else {
    for (const name of safeReadDir(item.path)) {
      const file = path.join(item.path, name);
      if (!name.startsWith(".") && isFile(file)) lines.push(`${name}  (${fs.statSync(file).size} bytes)`);
    }
  }
  return lines.join("\n");
}

export function capabilityDetail(id: string, roots: CapabilityRoots = defaultCapabilityRoots()): CapabilityDetail | null {
  const item = listCapabilities(roots, { fresh: true }).find((candidate) => candidate.id === id);
  if (!item) return null;
  const head = { id: item.id, kind: item.kind, source: item.source, name: item.name, path: item.path };
  let raw: Buffer;
  if (item.kind === "connector") raw = Buffer.from(connectorText(item, roots));
  else if (item.kind === "hook") raw = Buffer.from(hookText(item));
  else if (item.kind === "memory" && isDir(item.path)) raw = Buffer.from(memoryFolderListing(item));
  else if (item.kind === "plugin") {
    const dir = isDir(item.path) ? item.path : "";
    const manifest = dir ? [".codex-plugin/plugin.json", "plugin.json", ".claude-plugin/plugin.json"].map((rel) => path.join(dir, rel)).find(isFile) : "";
    raw = manifest && !looksLikeCredentialFile(manifest) ? fs.readFileSync(manifest) : Buffer.from(`${item.name}\n${item.description}`);
  } else {
    const allowed = [roots.codexHome, roots.claudeDir, roots.cursorDir, roots.grokDir ?? path.join(roots.home, ".grok"), roots.geminiDir ?? path.join(roots.home, ".gemini"), roots.copilotDir ?? path.join(roots.home, ".copilot"), roots.agentlasDir, path.join(roots.home, ".agents")];
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

/** Stored choices only for switches a run enforces: an older build's OFF for a built-in or an unenforceable item is dropped. */
function normalizedState(all: readonly InventoryEntry[], current: CapabilityState): CapabilityState {
  const switchable = new Set(all.filter((item) => item.applies && !item.builtin).map((item) => item.id));
  const items: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(current.items)) if (switchable.has(id)) items[id] = on;
  const sources: CapabilityState["sources"] = {};
  for (const source of CAPABILITY_SOURCES) {
    if (current.sources[source] !== undefined && all.some((item) => item.source === source && item.applies && !item.builtin)) sources[source] = current.sources[source];
  }
  const roles: Record<string, CapabilityRole> = {};
  for (const [id, role] of Object.entries(current.roles)) if (switchable.has(id) && role !== "both") roles[id] = role;
  return { items, sources, roles };
}

/**
 * Switch one item for One. Refused (CapabilityNotSwitchableError) for a built-in or an item no run can enforce, so a
 * stored-but-ignored state is never returned as success. Unknown id: null.
 */
export function setCapabilityEnabled(id: string, enabled: boolean, roots: CapabilityRoots = defaultCapabilityRoots()): CapabilityItem | null {
  const all = inventory(roots, true);
  const item = all.find((candidate) => candidate.id === id);
  if (!item) return null;
  if (item.builtin) throw new CapabilityNotSwitchableError(id, "builtin");
  if (isPersonalSource(item.source)) throw new CapabilityNotSwitchableError(id, "personal_runtime");
  if (!item.applies) throw new CapabilityNotSwitchableError(id, item.limit ?? "runtime_reads_itself");
  // A write starts from the file, not this process's cache: the other process may have written in the last seconds.
  const state = normalizedState(all, readCapabilityState({ fresh: true }));
  state.items[id] = enabled === true;
  writeCapabilityState(state);
  return publicItem({ ...item, enabled: enabled === true });
}

/**
 * Bulk: every enforceable item of a source (optionally one kind) switched together; afterwards they inherit the
 * source default. Items without an enforceable switch are left as they are and not counted. A source with nothing
 * enforceable is refused.
 */
export function setSourceEnabled(source: CapabilitySource, enabled: boolean, kind?: CapabilityKind, roots: CapabilityRoots = defaultCapabilityRoots()): { source: CapabilitySource; changed: number } {
  const all = inventory(roots, true);
  const targets = all.filter((item) => item.source === source && item.applies && !item.builtin && !isPersonalSource(item.source) && (!kind || item.kind === kind));
  if (targets.length === 0) throw new CapabilityNotSwitchableError(`source:${source}`, source === "agentlas" ? "agentlas_managed" : "personal_runtime");
  const state = normalizedState(all, readCapabilityState({ fresh: true }));
  if (!kind) { state.sources[source] = enabled === true; for (const item of targets) delete state.items[item.id]; }
  else for (const item of targets) state.items[item.id] = enabled === true;
  writeCapabilityState(state);
  return { source, changed: targets.length };
}

/** Scope one switchable item to the personal One, One as CEO, or both (21 G3). Same refusals as setCapabilityEnabled. */
export function setCapabilityRole(id: string, role: CapabilityRole, roots: CapabilityRoots = defaultCapabilityRoots()): CapabilityItem | null {
  if (!CAPABILITY_ROLES.includes(role)) throw new Error("capability_role_invalid");
  const all = inventory(roots, true);
  const item = all.find((candidate) => candidate.id === id);
  if (!item) return null;
  if (item.builtin) throw new CapabilityNotSwitchableError(id, "builtin");
  if (isPersonalSource(item.source)) throw new CapabilityNotSwitchableError(id, "personal_runtime");
  if (!item.applies) throw new CapabilityNotSwitchableError(id, item.limit ?? "runtime_reads_itself");
  const state = normalizedState(all, readCapabilityState({ fresh: true }));
  if (role === "both") delete state.roles[id]; else state.roles[id] = role;
  writeCapabilityState(state);
  return publicItem({ ...item, role });
}

/* ------------------------------------------------------------------ run assembly */

export interface CapabilitySelection {
  /** True only for One. */
  isOne: boolean;
  /** One's role in this run: its personal conversation, or CEO everywhere else. Null for every other agent. */
  role: Exclude<CapabilityRole, "both"> | null;
  /** Every inventory item with the on/off this run gets: workers have every personal item off. */
  items: CapabilityItem[];
}

/**
 * The selection a product run assembles from. Only One may have personal items on, and only the ones the
 * person switched on; every other agent (rooms, workers, borrowed agents, Science) gets none of them.
 */
export function selectionFor(agentId: string | undefined, roots: CapabilityRoots = defaultCapabilityRoots(), chatId?: string): CapabilitySelection {
  const isOne = agentId === BUILTIN_ONE_AGENT_ID;
  const role = isOne ? (chatId && personalConversation(chatId) ? "personal" : "ceo") : null;
  const items = inventory(roots, false).map(publicItem).map((item) => (isPersonalSource(item.source) && !isOne)
    || (role && item.role && item.role !== "both" && item.role !== role) ? { ...item, enabled: false } : item);
  return { isOne, role, items };
}

/** The personal One's own conversation (the supervisor binding); a lookup failure counts as CEO. */
function personalConversation(chatId: string): boolean {
  try {
    const { getDb } = require("../store/db") as typeof import("../store/db");
    const { getOneProfile } = require("../store/one-profile") as typeof import("../store/one-profile");
    const { personalSupervisorConversationInDb } = require("../one/supervisor-store") as typeof import("../one/supervisor-store");
    return personalSupervisorConversationInDb(getDb(), getOneProfile().oneId, chatId);
  } catch {
    return false;
  }
}
