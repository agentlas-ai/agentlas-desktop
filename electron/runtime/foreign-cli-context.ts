// Personal context that a foreign CLI pulls in (owner decision 2026-10-11, all users): a product run carries none of
// the person's own instructions, memory, skills, plugins, hooks or MCP servers; only One gets the items the person
// switched on (capabilities/one-capabilities.ts).
//
// Grok has two separate leaks, closed in two ways (measured on grok 1.0.51 with `grok inspect --json`):
//
//  1. It scans OTHER tools' folders by default ("Claude compatibility ... enabled by default"):
//     `~/.claude/Claude.md`, ~/.claude/settings(.local).json permissions, skills, `~/.claude.json` MCP servers,
//     hooks, and the same for ~/.cursor and ~/.codex. Each scan has an env switch
//     GROK_<CLAUDE|CURSOR|CODEX>_<SKILLS|RULES|AGENTS|MCPS|HOOKS|SESSIONS>_ENABLED. `AGENTS` is the one that
//     governs Claude.md (RULES governs rules/*.md). With every cell false `grok inspect` marks all of them
//     `[disabled]` and the Harness Compatibility table shows OFF (env).
//
//  2. Its OWN folder (GROK_HOME, default ~/.grok): Agents.md (global instructions), memory-v2, skills/, hooks/,
//     hooks-paths, installed-plugins, sandbox.toml and the person's config.toml. No switch exists for the
//     instructions file, so a product run points GROK_HOME at a mirror (config-home-mirror.ts) that links only the
//     entries in GROK_LINKED_ENTRIES (sign-in, binaries, caches, org policy, folder trust: auth.json stays one and the
//     same file, so the sign-in works; the session store is the mirror's own since 2026-10-12). config.toml and
//     user-settings.json are the mirror's own files holding only an allowlist of the person's (productGrokConfig).
//     Until 2026-10-17 every other entry was linked and config.toml was the person's minus five tables, so their
//     `[permission]` rules, `[sandbox]`, `[shell_environment_policy] set` values, `[ui]` (always-approve, notification
//     hook commands, status-line command), `[agent]`, `[paths]`, `[plugins]` and `[session] load_envrc` reached
//     product runs, like the Codex copy did (owner 2026-10-06/10-11: the person's settings never drive product agents).
//     Skills Grok also reads from the generic `~/.agents/skills` root are hidden with `[skills] ignore`.
//     Memory is turned off with GROK_MEMORY=0.
//
//  3. HOME itself (closed 2026-10-17 by a HOME of its own, like Antigravity's). With every cell above off Grok still
//     reads, straight from HOME, with no switch, ignoring CLAUDE_CONFIG_DIR (grok 1.0.60, a fake HOME of marker files and
//     real product turns through the GROK_HOME mirror):
//       - `~/.claude/settings.json` and `settings.local.json`: their permission rules (a personal deny rule denied `pwd`
//         in a product write turn; the owner's files hold 127 rules) and their `env` (a personal value reached the
//         product bash; the owner's carries APP_STORE_CONNECT_*, GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_PLAY_KEY_FILE);
//       - `~/.claude/plugins`: every installed Claude Code plugin with its hooks (SessionStart and UserPromptSubmit ran
//         on a product turn), MCP servers (started) and subagents. `[plugins] disabled` drops a plugin's agents, skills
//         and MCP servers but not its hooks;
//       - `~/.claude/agents`: the person's own subagents.
//     So a product run's HOME is a mirror (syncGrokProductUserHome) in which every entry of the person's HOME is a link
//     (Library too, so the login keychain resolves as for the person; .gitconfig, .ssh and the rest stay the person's
//     for the tools a turn runs) except `.claude`, `.claude.json`, `.agents` and `.grok`, see GROK_USER_HOME_OWN.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { isMirrorLink, syncConfigHomeMirror } from "./config-home-mirror";
import { allowlistedToml, withCliProductHome } from "./cli-product-homes";
import { productClaudeGlobalConfig } from "./claude-product-home";
import type { CapabilityItem, CapabilityKind, CapabilitySelection } from "../capabilities/one-capabilities";
import { inheritedProductHome, personalHomeDir, personalHomeOverride } from "./product-home-identity";

const GROK_CELLS: ReadonlyArray<{ cell: string; kind: CapabilityKind }> = [
  { cell: "SKILLS", kind: "skill" },
  { cell: "RULES", kind: "memory" },
  { cell: "AGENTS", kind: "memory" },
  { cell: "MCPS", kind: "connector" },
  { cell: "HOOKS", kind: "hook" },
];

function oneHas(selection: CapabilitySelection | undefined, source: CapabilityItem["source"], kind?: CapabilityKind): CapabilityItem[] {
  if (selection?.isOne !== true) return [];
  return selection.items.filter((item) => item.source === source && item.enabled && (kind === undefined || item.kind === kind));
}

export function grokCompatEnv(selection: CapabilitySelection | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const source of ["claude", "cursor", "codex"] as const) {
    for (const { cell, kind } of GROK_CELLS) {
      // Codex has no rules/agents/mcps/hooks cells of its own in Grok 1.0.51 except skills, hooks and sessions; the
      // extra variables are harmless where the CLI does not know them.
      if (oneHas(selection, source, kind).length === 0) env[`GROK_${source.toUpperCase()}_${cell}_ENABLED`] = "false";
    }
    // Importing another tool's past sessions is never a product need.
    env[`GROK_${source.toUpperCase()}_SESSIONS_ENABLED`] = "false";
  }
  if (oneHas(selection, "grok", "memory").length === 0) env.GROK_MEMORY = "0";
  return env;
}

export function realGrokHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(personalHomeOverride(env, "GROK_HOME") || path.join(personalHomeDir(env), ".grok"));
}

/**
 * Parts of the person's config.toml a product run keeps (grok 1.0.60 docs/user-guide/26-config-reference.md), each for
 * one reason:
 *   - sign-in and provider plumbing, without which a custom, enterprise or BYOK account cannot reach its model:
 *     `auth.*` / `grok_com_config.*` (its alias: auth provider command, OIDC/OAuth2 issuer, team pin, relay URLs),
 *     `auth_provider.*` (named credential helpers a model uses), `model.*` and `model_providers.*` (custom model
 *     endpoints, wire API, credentials or the env names holding them), the endpoint keys in GROK_ENDPOINT_KEYS (inference,
 *     model list and the deployment's managed-config source; never the feedback or trace-upload destinations), and
 *     `models.extra_headers` (headers every model request carries, e.g. a gateway's tenant tag);
 *   - the model default the CLI falls back to when the app passes no model: `models.default`,
 *     `models.default_reasoning_effort`;
 *   - how the CLI binary the person shares with product runs (bin/ and downloads/ are links) updates itself:
 *     `cli.auto_update`, `cli.installer`, `cli.channel`. A product run must not update the person's install against
 *     their choice;
 *   - the person's telemetry OPT-OUTS, never an opt-in (owner decision 2026-10-17, every product home; otherwise the
 *     vendor default): `telemetry.trace_upload = false`, `features.telemetry = false` / `"off"`,
 *     `diagnostics.error_reporting = false` (GROK_OPT_OUTS). They change nothing an agent does. The OTEL exporters and
 *     the trace-upload destinations are never carried.
 * Plus the MCP servers One switched on. Everything else is left out by construction, including `permission`,
 * `sandbox`, `shell_environment_policy` (its `set` injects values into every bash), `ui` (always-approve, notification
 * hook commands, the status-line command), `hooks`, `agent`, `paths`, `plugins`, `marketplace`, `skills`, `memory`,
 * `features`, `subagents`, `workflows`, `session` (`load_envrc`), `toolset`, `relay`, the telemetry exporters and any
 * table a later release adds.
 */
const GROK_KEEP_TABLES: ReadonlySet<string> = new Set(["auth", "grok_com_config", "auth_provider", "model", "model_providers"]);
const GROK_ENDPOINT_KEYS: ReadonlySet<string> = new Set(["cli_chat_proxy_base_url", "models_base_url", "models_list_url", "models_endpoint",
  "xai_api_base_url", "managed_config_url", "deployment_key"]);
const GROK_KEEP_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  endpoints: GROK_ENDPOINT_KEYS,
  models: new Set(["default", "default_reasoning_effort", "extra_headers"]),
  cli: new Set(["auto_update", "installer", "channel"]),
};
/** The person's telemetry opt-outs a product run keeps: key path -> the values that mean "off" (grok 1.0.60 config reference). */
const GROK_OPT_OUTS: Readonly<Record<string, ReadonlySet<string>>> = {
  "telemetry.trace_upload": new Set(["false"]),
  "features.telemetry": new Set(["false", "\"off\"", "'off'"]),
  "diagnostics.error_reporting": new Set(["false"]),
};

/** The mirror's own config.toml: the allowlisted parts of the person's, One's MCP servers and the skills ignore. */
export function productGrokConfig(text: string, keepServers: ReadonlySet<string>, skillsIgnore: readonly string[],
  /** The mirror's own servers a running legacy grok run added (grok.ts reconcileGrokMcpServers), kept as they are. */
  runServers: string = ""): string {
  const personal = allowlistedToml(text, ({ path: [head, second, ...rest], value }) => GROK_KEEP_TABLES.has(head)
    || (second !== undefined && GROK_KEEP_KEYS[head]?.has(second) === true)
    || (head === "mcp_servers" && second !== undefined && keepServers.has(second))
    || (second !== undefined && rest.length === 0 && GROK_OPT_OUTS[`${head}.${second}`]?.has(value.trim()) === true));
  const out = personal && runServers ? `${personal}${runServers}` : personal || runServers;
  const ignore = skillsIgnore.length > 0 ? `[skills]\nignore = [${skillsIgnore.map((p) => JSON.stringify(p)).join(", ")}]\n` : "";
  return out && ignore ? `${out}\n${ignore}` : out || ignore;
}

/** user-settings.json keys a product run keeps: the model default (`/model` writes it). Nothing else of the file. */
const GROK_USER_SETTINGS_KEYS: readonly string[] = ["defaultModel"];

function productGrokUserSettings(text: string | null): string {
  let source: Record<string, unknown> = {};
  try { const v = text === null ? {} : JSON.parse(text) as unknown; if (v && typeof v === "object" && !Array.isArray(v)) source = v as Record<string, unknown>; }
  catch { /* not JSON: nothing */ }
  return `${JSON.stringify(Object.fromEntries(GROK_USER_SETTINGS_KEYS.filter((key) => key in source).map((key) => [key, source[key]])), null, 2)}\n`;
}

/**
 * The only entries of the person's GROK_HOME a product mirror links: sign-in (auth.json), install identity and version
 * state, the binaries and their vendored libraries, built-in bundles and extracted docs, model and signed remote-settings
 * caches, the organisation's managed policy (managed_config.toml, requirements.toml: a fleet pin still applies), and
 * folder trust (the person's consent for a folder, which headless runs cannot ask for). An ALLOWLIST: the person's
 * instructions, memory, skills, hooks, hooks-paths, plugins, sandbox profiles, pager settings, marketplace caches, the
 * leader socket and every store a later release adds stay out, and so does the session store (grok.db, sessions,
 * delegations, logs...: owner 2026-10-12, Agentlas sessions are kept apart from personal sessions in every app); Grok
 * creates its own copies in the mirror. One gets back the instructions and memory it switched on.
 */
const GROK_LINKED_ENTRIES: ReadonlySet<string> = new Set(["auth.json", "auth.json.lock", "agent_id", "install.json", "version.json",
  ".metadata_version", ".config-init.lock", "bin", "downloads", "lib", "vendor", "bundled", "bundles", "completions", "docs", "README.md",
  "models_cache.json", "settings_cache.json", "managed_config.toml", "managed_config.lock", "requirements.toml",
  "trusted_folders.toml", "trusted_folders.toml.lock", "workspace-trust.json"]);

export type GrokProductHomeSkip = "no-real-home" | "no-file-sign-in" | "links-unavailable";

/** Beside the mirror's config.toml: the MCP keys running legacy grok runs added there (grok.ts reconcileGrokMcpServers). */
export const GROK_RUN_MCP_REGISTRY = "agentlas-run-mcp.json";

/** The `mcp_servers.<key>` tables of the mirror's current config.toml whose keys a running run registered. */
function grokRunServerTables(home: string): string {
  let keys: string[] = [];
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(home, GROK_RUN_MCP_REGISTRY), "utf8")) as Record<string, unknown>;
    keys = registry && typeof registry === "object" && !Array.isArray(registry) ? Object.keys(registry) : [];
  } catch { return ""; }
  if (keys.length === 0) return "";
  let current = "";
  try { current = fs.readFileSync(path.join(home, "config.toml"), "utf8"); } catch { return ""; }
  const wanted = new Set(keys);
  return allowlistedToml(current, ({ path: [head, second] }) => head === "mcp_servers" && second !== undefined && wanted.has(second));
}

export function syncGrokProductHome(realHome: string, selection: CapabilitySelection | undefined, mirrorRoot = userDataPath("grok-product-home")): { home: string } | { skip: GrokProductHomeSkip } {
  let entries: string[];
  try { entries = fs.readdirSync(realHome); } catch { return { skip: "no-real-home" }; }
  if (!entries.includes("auth.json")) return { skip: "no-file-sign-in" };
  const isOne = selection?.isOne === true;
  const memoryFiles = oneHas(selection, "grok", "memory");
  const instructions = memoryFiles.find((item) => item.path === path.join(realHome, item.name) && item.name !== "memory-v2");
  const wantMemoryV2 = memoryFiles.some((item) => item.name === "memory-v2");
  const keepServers = new Set(oneHas(selection, "grok", "connector").map((item) => item.name));
  const codexSkillsOn = oneHas(selection, "codex", "skill").some((item) => item.path.startsWith(path.join(os.homedir(), ".agents", "skills") + path.sep));
  const home = path.join(mirrorRoot, crypto.createHash("sha256").update(realHome).digest("hex").slice(0, 12) + (isOne ? "-one" : ""));
  let config = "";
  try { config = fs.readFileSync(path.join(realHome, "config.toml"), "utf8"); } catch { /* none */ }
  try {
    let userSettings: string | null = null;
    try { userSettings = fs.readFileSync(path.join(realHome, "user-settings.json"), "utf8"); } catch { /* none */ }
    syncConfigHomeMirror({
      realDir: realHome,
      mirrorDir: home,
      hide: (name) => !GROK_LINKED_ENTRIES.has(name) && !(name === instructions?.name) && !(name === "memory-v2" && wantMemoryV2),
      folders: ["hooks", "skills"],
      own: {
        "config.toml": productGrokConfig(config, keepServers, codexSkillsOn ? [] : [path.join(os.homedir(), ".agents", "skills")], grokRunServerTables(home)),
        "user-settings.json": productGrokUserSettings(userSettings),
      },
    });
    // hooks/ and skills/ are folders of links to exactly the files One switched on.
    for (const [folder, items] of [["hooks", oneHas(selection, "grok", "hook")], ["skills", oneHas(selection, "grok", "skill")]] as const) {
      syncLinkFolder(path.join(home, folder), new Map(items.map((item) => {
        const target = folder === "skills" ? path.dirname(item.path) : item.path;
        return [path.basename(target), target] as const;
      })));
    }
    if (!isMirrorLink(home, "auth.json")) return { skip: "links-unavailable" };
  } catch {
    return { skip: "links-unavailable" };
  }
  return { home };
}

/** Fills a mirror folder with links to exactly `wanted` (name -> target); links it no longer wants go, files the CLI made stay. */
function syncLinkFolder(dir: string, wanted: ReadonlyMap<string, string>): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(dir)) {
    const at = path.join(dir, name);
    let link: string | null = null;
    try { link = fs.readlinkSync(at); } catch { /* a file the CLI made: left alone */ }
    if (link !== null && wanted.get(name) !== link) { try { fs.unlinkSync(at); } catch { /* raced */ } }
  }
  for (const [name, target] of wanted) {
    const at = path.join(dir, name);
    try { fs.lstatSync(at); } catch { try { fs.symlinkSync(target, at); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  }
}

/** Writes `text` to `at` when it differs (temp file + rename), or removes `at` when `text` is null. */
function syncOwnFile(at: string, text: string | null): void {
  let current: string | null = null;
  try { current = fs.readFileSync(at, "utf8"); } catch { /* none yet */ }
  if (text === null) { if (current !== null) fs.rmSync(at, { force: true }); return; }
  if (current === text) return;
  fs.mkdirSync(path.dirname(at), { recursive: true, mode: 0o700 });
  const temp = `${at}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, at);
}

/**
 * Entries of the person's HOME a product Grok HOME does not link (everything else is a link to the person's own):
 *   - `.claude`: the mirror's own folder holding links to exactly what One switched on (skills, commands, CLAUDE.md,
 *     rules/) and, for personal Claude plugins One switched on, a plugin list and `enabledPlugins` naming only them.
 *     Never the person's settings files (permission rules, env, hooks), the other plugins, or `agents/` (no switch turns
 *     a user subagent off and One has no subagent kind, the Claude product home's rule). A Claude Code that a turn starts itself
 *     still signs in (its keychain item and `.claude.json` below) and keeps its own sessions inside the mirror;
 *   - `.claude.json`: the mirror's own file, the sign-in, install and first-run part of the person's plus the MCP
 *     servers One switched on (productClaudeGlobalConfig, the Claude product home's rule);
 *   - `.agents`: the mirror's own folder; its `skills` (a generic root Grok scans) holds links to the skills One switched
 *     on, every other entry is a link;
 *   - `.grok`: absent. The run always names its GROK_HOME (the GROK_HOME mirror, or the person's folder when no mirror
 *     can hold), so Grok never falls back to HOME/.grok.
 */
const GROK_USER_HOME_OWN: ReadonlySet<string> = new Set([".claude", ".claude.json", ".agents", ".grok"]);

export type GrokUserHomeSkip = "unsupported-platform" | "no-real-home" | "links-unavailable";

/** Where the product HOME of `realHome` lives (the One variant carries "-one"); syncGrokProductUserHome builds it there. */
export function grokProductUserHomePath(realHome: string, isOne: boolean, mirrorRoot = userDataPath("grok-product-user-home")): string {
  return path.join(mirrorRoot, crypto.createHash("sha256").update(path.resolve(realHome)).digest("hex").slice(0, 12) + (isOne ? "-one" : ""));
}

/**
 * Builds or refreshes the product HOME of a Grok run. Never throws; a skip means the run keeps the person's HOME (with the
 * compat cells still off). macOS and Linux only: a Windows profile cannot be mirrored safely (its top-level files, such
 * as NTUSER.DAT, need the symlink privilege and must never be copied), the same limit as Antigravity's product HOME.
 */
export function syncGrokProductUserHome(realHome: string, selection: CapabilitySelection | undefined, mirrorRoot?: string): { home: string } | { skip: GrokUserHomeSkip } {
  if (process.platform !== "darwin" && process.platform !== "linux") return { skip: "unsupported-platform" };
  try { if (!fs.statSync(realHome).isDirectory()) return { skip: "no-real-home" }; } catch { return { skip: "no-real-home" }; }
  const isOne = selection?.isOne === true;
  const realClaude = path.join(realHome, ".claude");
  const realAgentsSkills = path.join(realHome, ".agents", "skills");
  try {
    const home = grokProductUserHomePath(realHome, isOne, mirrorRoot);
    const own: Record<string, string> = {};
    let global: string | null = null;
    try { global = fs.readFileSync(path.join(realHome, ".claude.json"), "utf8"); } catch { /* the person has none */ }
    if (global !== null) {
      try { own[".claude.json"] = productClaudeGlobalConfig(global, oneHas(selection, "claude", "connector").map((item) => item.name)); }
      catch { /* not JSON: the mirror has none of the person's */ }
    }
    syncConfigHomeMirror({ realDir: realHome, mirrorDir: home, hide: (name) => GROK_USER_HOME_OWN.has(name), folders: [".claude", ".agents"], own });

    // .claude: links to the items One switched on, by their place in the person's ~/.claude.
    const claude = path.join(home, ".claude");
    const inside = (file: string, dir: string): boolean => { const rel = path.relative(dir, file); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };
    const skills = oneHas(selection, "claude", "skill");
    const top = new Map<string, string>();
    for (const item of oneHas(selection, "claude", "memory")) {
      if (item.path === path.join(realClaude, "CLAUDE.md") || item.path === path.join(realClaude, "rules")) top.set(path.basename(item.path), item.path);
    }
    syncLinkFolder(claude, top);
    syncLinkFolder(path.join(claude, "skills"), new Map(skills.filter((item) => inside(item.path, path.join(realClaude, "skills")))
      .map((item) => [path.basename(path.dirname(item.path)), path.dirname(item.path)] as const)));
    syncLinkFolder(path.join(claude, "commands"), new Map(skills.filter((item) => inside(item.path, path.join(realClaude, "commands")))
      .map((item) => [path.basename(item.path), item.path] as const)));
    const plugins = new Set(oneHas(selection, "claude", "plugin").map((item) => item.name));
    // Grok loads a listed plugin's agents and MCP servers only when settings.json enables it (measured), so the mirror's
    // own settings.json holds `enabledPlugins` for those plugins and nothing else; with none chosen there is no settings
    // file at all. settings.local.json is never the mirror's.
    let pluginList: string | null = null;
    let settings: string | null = null;
    if (plugins.size > 0) {
      try {
        const registry = JSON.parse(fs.readFileSync(path.join(realClaude, "plugins", "installed_plugins.json"), "utf8")) as { version?: unknown; plugins?: Record<string, unknown> };
        const kept = Object.fromEntries(Object.entries(registry.plugins ?? {}).filter(([id]) => plugins.has(id)));
        if (Object.keys(kept).length > 0) {
          pluginList = `${JSON.stringify({ version: registry.version ?? 2, plugins: kept }, null, 2)}\n`;
          settings = `${JSON.stringify({ enabledPlugins: Object.fromEntries(Object.keys(kept).map((id) => [id, true])) }, null, 2)}\n`;
        }
      } catch { /* unreadable: no plugin */ }
    }
    syncOwnFile(path.join(claude, "plugins", "installed_plugins.json"), pluginList);
    syncOwnFile(path.join(claude, "settings.json"), settings);
    syncOwnFile(path.join(claude, "settings.local.json"), null);

    // .agents: every entry linked except skills/, which links only the skills One switched on.
    if (fs.existsSync(path.join(realHome, ".agents"))) {
      syncConfigHomeMirror({ realDir: path.join(realHome, ".agents"), mirrorDir: path.join(home, ".agents"), hide: () => false, folders: ["skills"] });
      syncLinkFolder(path.join(home, ".agents", "skills"), new Map(oneHas(selection, "codex", "skill")
        .filter((item) => inside(item.path, realAgentsSkills))
        .map((item) => [path.basename(path.dirname(item.path)), path.dirname(item.path)] as const)));
    }
    if (fs.existsSync(path.join(realHome, "Library")) && !isMirrorLink(home, "Library")) return { skip: "links-unavailable" };
    return { home };
  } catch {
    return { skip: "links-unavailable" };
  }
}

/**
 * HOME for a Grok run: the product HOME of the person's HOME. `AGENTLAS_GROK_KEEP_HOME=1`, a HOME that is already not the
 * person's (a resident re-entry carries the mirror) or a mirror that cannot hold keeps `env.HOME`.
 */
export function withGrokProductUserHome(env: NodeJS.ProcessEnv, selection: CapabilitySelection | undefined): NodeJS.ProcessEnv {
  if (env.AGENTLAS_GROK_KEEP_HOME === "1") return env;
  const realHome = personalHomeDir({ HOME: env.AGENTLAS_GROK_REAL_HOME || os.homedir() });
  if (env.HOME && path.resolve(env.HOME) !== path.resolve(realHome) && !inheritedProductHome(env, "HOME")) return env;
  let mirror: ReturnType<typeof syncGrokProductUserHome>;
  try { mirror = syncGrokProductUserHome(realHome, selection); } catch { return env; /* no app folder (a host outside the app) */ }
  return "home" in mirror ? { ...env, HOME: mirror.home, AGENTLAS_GROK_REAL_HOME: realHome } : env;
}

/** The run environment for an ACP agent: foreign-tool context switched off unless One chose it. */
export function withForeignCliContext(agentKind: string, env: NodeJS.ProcessEnv, selection: CapabilitySelection | undefined): NodeJS.ProcessEnv {
  // Kimi, Cursor and Copilot: their config folder (sessions, instruction files, MCP lists) is a product mirror
  // (cli-product-homes.ts). Never throws: a host without a writable app folder keeps the person's folder.
  if (agentKind === "kimi" || agentKind === "cursor" || agentKind === "github-copilot-cli") {
    try { return withCliProductHome(agentKind, env, selection); } catch { return env; }
  }
  if (agentKind !== "grok") return env;
  const out: NodeJS.ProcessEnv = { ...env, ...grokCompatEnv(selection) };
  const real = realGrokHome(process.env);
  // A GROK_HOME Main chose for this run is kept; only the person's own folder is swapped for its mirror. When no mirror
  // can hold, the run names the person's folder itself: its HOME (below) has no `.grok` to fall back to.
  if (!env.GROK_HOME || path.resolve(env.GROK_HOME) === real) {
    out.GROK_HOME = real;
    try {
      const mirror = syncGrokProductHome(real, selection);
      if ("home" in mirror) out.GROK_HOME = mirror.home;
    } catch {
      // No writable app folder (a host outside the app): the run keeps the real folder, with the cells above still off.
    }
  }
  return withGrokProductUserHome(out, selection);
}
