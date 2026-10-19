
























import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { isMirrorLink, syncConfigHomeMirror } from "./config-home-mirror";
import type { CapabilityItem, CapabilityKind, CapabilitySelection } from "../capabilities/one-capabilities";
import { inheritedProductHome, personalHomeDir, productHomeRefusedOnThisHost } from "./product-home-identity";

/** Antigravity's conversation stores (per-conversation brain, annotations, recordings). Never linked into a product mirror. */
const AGY_PERSONAL_SESSION_ENTRIES = new Set(["conversations", "brain", "annotations", "implicit", "html_artifacts",
  "browser_recordings", "code_tracker", "context_state"]);

export type AgyProductHomeSkip = "unsupported-platform" | "no-real-gemini" | "no-sign-in-files" | "links-unavailable" | "unconfigured-host";

function oneGemini(selection: CapabilitySelection | undefined, kind: CapabilityKind): CapabilityItem[] {
  if (selection?.isOne !== true) return [];
  return selection.items.filter((item) => item.source === "gemini" && item.kind === kind && item.enabled);
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const objectOf = (value: unknown): Record<string, unknown> =>
  (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**












 */
const AGY_PRODUCT_USER_SETTINGS_KEYS: ReadonlySet<string> = new Set(["useAiCredits"]);

/**
 * The mirror's own config/config.json: the person's `plugins` cut down to the ones One switched on, and the allowlisted
 * `userSettings`. Every other top-level entry (sidecars, anything a later release adds) is left out by construction.
 */
export function productAgyConfig(config: Record<string, unknown> | null, keepPlugins: ReadonlySet<string>): string {
  const pluginTable = objectOf(config?.plugins);
  const out: Record<string, unknown> = { plugins: Object.fromEntries(Object.entries(pluginTable).filter(([name]) => keepPlugins.has(name))) };
  const settings = Object.fromEntries(Object.entries(objectOf(config?.userSettings)).filter(([key]) => AGY_PRODUCT_USER_SETTINGS_KEYS.has(key)));
  if (Object.keys(settings).length > 0) out.userSettings = settings;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Keys of the person's antigravity-cli/settings.json (agy's own CLI settings) a product run keeps, each for one reason:
 * the provider plumbing a Gemini API key or custom-model account needs to reach its model at all (agy changelog: "Set
 * `modelProvider: \"gemini\"` in settings.json, export GEMINI_API_KEY"; custom models are "configured in settings.json").
 * Headless runs honor this file's `permissions`, file access, sandbox mode, auto-execution and artifact review (agy
 * changelog), and it holds `agentMode`, `trustedWorkspaces` and UI preferences: all of that is the person's and is left
 * out by construction. Agentlas trusts the run's folder itself (GEMINI_CLI_TRUST_WORKSPACE).
 * Plus `enableTelemetry: false` only: the person's telemetry OPT-OUT (owner decision 2026-10-17, every product home:
 * never an opt-in; otherwise the vendor default). The key name is the CLI's own settings key read from the agy 1.4.0
 * binary beside `hideActiveItems` / `seasonalPalette`; not measured against agy's upload.
 */
const AGY_PRODUCT_CLI_SETTINGS_KEYS: ReadonlySet<string> = new Set(["modelProvider", "customModels", "customModelsConfig"]);

export function productAgyCliSettings(settings: Record<string, unknown> | null): string {
  const kept = Object.entries(settings ?? {}).filter(([key, value]) => AGY_PRODUCT_CLI_SETTINGS_KEYS.has(key) || (key === "enableTelemetry" && value === false));
  return `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`;
}

/** The person's project files that agy applies to a run in no project of its own: kept as identity only. */
const AGY_BUILTIN_PROJECTS: ReadonlySet<string> = new Set(["default-cli-project.json", "outside-of-project.json"]);
/** Fields of a built-in project a product run keeps: which project it is and its folders, never its grants or settings. */
const AGY_PROJECT_IDENTITY_KEYS: ReadonlySet<string> = new Set(["id", "name", "projectResources", "isWorkspaceOnly"]);
/** Project files Agentlas itself writes carry this marker prefix (antigravity.ts AGY_BROWSER_*_POLICY_MARKER). */
const AGENTLAS_PROJECT_MARKER = /^agentlas\.desktop\./;

/**







 */
function syncAgyProjects(realDir: string, dir: string): void {
  const links = new Map<string, string>();
  const own = new Map<string, string>();
  let names: string[] = [];
  try { names = fs.readdirSync(realDir).filter((name) => name.endsWith(".json")); } catch { /* the person has none */ }
  for (const name of names) {
    const file = path.join(realDir, name);
    const doc = readJsonObject(file);
    if (!doc) continue;
    if (typeof doc.agentlasOwner === "string" && AGENTLAS_PROJECT_MARKER.test(doc.agentlasOwner)) links.set(name, file);
    else if (AGY_BUILTIN_PROJECTS.has(name)) {
      own.set(name, `${JSON.stringify(Object.fromEntries(Object.entries(doc).filter(([key]) => AGY_PROJECT_IDENTITY_KEYS.has(key))), null, 2)}\n`);
    }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(dir)) {
    const at = path.join(dir, name);
    let link: string | null = null;
    try { link = fs.readlinkSync(at); } catch { continue; /* a file of the mirror's own */ }
    if (links.get(name) !== link) { try { fs.unlinkSync(at); } catch { /* raced */ } }
  }
  for (const [name, target] of links) {
    try { fs.lstatSync(path.join(dir, name)); } catch {
      try { fs.symlinkSync(target, path.join(dir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  }
  for (const [name, text] of own) {
    const at = path.join(dir, name);
    let current: string | null = null;
    try { current = fs.readFileSync(at, "utf8"); } catch { /* none yet */ }
    if (current === text) continue;
    const temp = `${at}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, at);
  }
}

/** Fills a mirror folder with links to exactly `wanted` (name -> target); links it no longer wants are removed. */
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
    try { fs.lstatSync(at); } catch {
      try { fs.symlinkSync(target, at); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  }
}

/**
 * An MCP entry Agentlas wrote (antigravity.ts reconcileAgyMcpServers): its env carries Agentlas's own marker keys, which a
 * server the person registered never has. Same marker family as antigravity.ts isAgentlasWrittenMcpEntry.
 */
export function agentlasWrittenAgyMcpEntry(entry: unknown): boolean {
  const env = objectOf(objectOf(entry).env);
  return Object.keys(env).some((key) => key.startsWith("AGENTLAS_AGY_MCP_") || key.startsWith("AGENTLAS_MCP_PROXY_"));
}

/**







 */
export function productAgyMcpConfig(realMcp: Record<string, unknown> | null, mirrorMcp: Record<string, unknown> | null, oneServers: ReadonlySet<string>): string {
  const personal = new Map(Object.entries(objectOf(realMcp?.mcpServers))
    .filter(([name, entry]) => oneServers.has(name) && !agentlasWrittenAgyMcpEntry(entry)));
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(objectOf(mirrorMcp?.mcpServers))) {
    if (agentlasWrittenAgyMcpEntry(entry)) out[name] = entry;
    else if (personal.has(name)) out[name] = personal.get(name);
  }
  for (const [name, entry] of personal) if (!(name in out)) out[name] = entry;
  return `${JSON.stringify({ mcpServers: out }, null, 2)}\n`;
}

export interface AgyProductHomeInput {
  /** The person's real HOME. */
  realHome: string;
  selection: CapabilitySelection | undefined;
  /** Ignored (kept for older callers): a run's servers are staged into the mirror's own file, not read from the person's. */
  runMcpKeys?: readonly string[];
  mirrorRoot?: string;
}

/** Where the product HOME of `realHome` lives (the One variant carries "-one"); syncAgyProductHome builds it there. */
export function agyProductHomePath(realHome: string, isOne: boolean, mirrorRoot?: string): string {
  const root = mirrorRoot ?? userDataPath("agy-product-home");
  return path.join(root, crypto.createHash("sha256").update(realHome).digest("hex").slice(0, 12) + (isOne ? "-one" : ""));
}

/** Builds or refreshes the product HOME. Never throws; a skip means the run keeps the real HOME. */
export function syncAgyProductHome(input: AgyProductHomeInput): { home: string } | { skip: AgyProductHomeSkip } {
  if (process.platform !== "darwin" && process.platform !== "linux") return { skip: "unsupported-platform" };
  const { realHome, selection } = input;
  // A gate or script (no install identity) never mirrors the account's own home (product-home-identity.ts).
  if (productHomeRefusedOnThisHost(realHome)) return { skip: "unconfigured-host" };
  const realGemini = path.join(realHome, ".gemini");
  if (!fs.existsSync(realGemini)) return { skip: "no-real-gemini" };
  // Without a sign-in file there is nothing proving the CLI's sign-in survives a mirror: keep the real HOME.
  const signInFiles = [path.join(realGemini, "antigravity-cli", "antigravity-oauth-token"), path.join(realGemini, "oauth_creds.json")];
  if (!signInFiles.some((file) => fs.existsSync(file))) return { skip: "no-sign-in-files" };
  const isOne = selection?.isOne === true;
  const home = agyProductHomePath(realHome, isOne, input.mirrorRoot);
  const gemini = path.join(home, ".gemini");
  const realConfig = path.join(realGemini, "config");
  try {
    syncConfigHomeMirror({ realDir: realHome, mirrorDir: home, hide: () => false, folders: [".gemini"] });

    const memory = oneGemini(selection, "memory").find((item) => item.name === "GEMINI.md");
    syncConfigHomeMirror({
      realDir: realGemini,
      mirrorDir: gemini,
      hide: (name) => (/^GEMINI\.md/.test(name) && !(name === "GEMINI.md" && memory))
        || name === "commands" || name === "extensions" || /^extension_integrity\.json/.test(name)
        || /hephaestus-extension-source/.test(name) || /agentlas-router\.lock$/.test(name),
      folders: ["config", "antigravity", "antigravity-cli"],
    });
    





    for (const name of ["antigravity", "antigravity-cli"]) {
      const realDir = path.join(realGemini, name);
      if (!fs.existsSync(realDir)) continue;
      const cli = name === "antigravity-cli";
      syncConfigHomeMirror({
        realDir,
        mirrorDir: path.join(gemini, name),
        hide: (entry) => entry === "knowledge" || entry === "mcp" || entry === "plugin_data" || entry === "global_workflows" || /^mcp_config\.json/.test(entry)
          || AGY_PERSONAL_SESSION_ENTRIES.has(entry) || /^conversation_summaries\.db(?:-wal|-shm)?$/.test(entry) || /_summaries_proto\.pb$/.test(entry)
          || entry === "history.jsonl" || /^settings\.json/.test(entry) || /^user_settings\.pb/.test(entry),
        ...(cli ? { own: { "settings.json": productAgyCliSettings(readJsonObject(path.join(realDir, "settings.json"))) } } : {}),
      });
    }

    // config/: config.json and projects are the mirror's own allowlisted copies; skills/plugins/hooks/MCP are rebuilt.
    const skills = oneGemini(selection, "skill");
    const plugins = oneGemini(selection, "plugin");
    const hooks = oneGemini(selection, "hook");
    const servers = oneGemini(selection, "connector");
    const keepPlugins = new Set(plugins.map((item) => path.basename(item.path)));
    const own: Record<string, string> = { "config.json": productAgyConfig(readJsonObject(path.join(realConfig, "config.json")), keepPlugins) };
    own["mcp_config.json"] = productAgyMcpConfig(readJsonObject(path.join(realConfig, "mcp_config.json")),
      readJsonObject(path.join(gemini, "config", "mcp_config.json")), new Set(servers.map((item) => item.name)));
    const realHooks = readJsonObject(path.join(realConfig, "hooks.json"));
    const keepHooks = new Set(hooks.map((item) => item.name));
    if (realHooks && keepHooks.size > 0) own["hooks.json"] = `${JSON.stringify(Object.fromEntries(Object.entries(realHooks).filter(([name]) => keepHooks.has(name))), null, 2)}\n`;
    else own["hooks.json"] = "{}\n";
    if (fs.existsSync(realConfig)) {
      syncConfigHomeMirror({
        realDir: realConfig,
        mirrorDir: path.join(gemini, "config"),
        hide: (name) => /^(hooks|mcp_config|config)\.json/.test(name) || name === "sidecars",
        folders: ["skills", "plugins", "projects"],
        own,
      });
    }
    syncAgyProjects(path.join(realConfig, "projects"), path.join(gemini, "config", "projects"));
    syncLinkFolder(path.join(gemini, "config", "skills"), new Map(skills.map((item) => {
      const target = path.dirname(item.path);
      return [path.basename(target), target] as const;
    })));
    syncLinkFolder(path.join(gemini, "config", "plugins"), new Map(plugins.map((item) => [path.basename(item.path), item.path] as const)));
    if (!isMirrorLink(home, "Library") && fs.existsSync(path.join(realHome, "Library"))) return { skip: "links-unavailable" };
    if (!signInFiles.every((file) => !fs.existsSync(file) || fs.existsSync(path.join(gemini, path.relative(realGemini, file))))) return { skip: "links-unavailable" };
  } catch {
    return { skip: "links-unavailable" };
  }
  return { home };
}

/** MCP server keys of a run's authorized MCP config file (never throws). */
export function runMcpKeysOf(mcpConfigPath: string | undefined): string[] {
  if (!mcpConfigPath) return [];
  const parsed = readJsonObject(mcpConfigPath);
  const servers = parsed?.mcpServers;
  return servers && typeof servers === "object" ? Object.keys(servers) : [];
}

/**
 * The run environment for agy: HOME points at the product mirror. `env.AGENTLAS_AGY_KEEP_HOME=1` or a missing safe
 * mirror keeps the real HOME. The HOME this returns is the one whose config/mcp_config.json the run's MCP servers are
 * staged into (antigravity.ts agyMcpConfigPath(agySpawnHome(env))), so it may be called before or after that staging; a
 * re-sync keeps every staged entry. The third argument is ignored (kept for older callers).
 */
export function withAgyProductHome(env: NodeJS.ProcessEnv, selection: CapabilitySelection | undefined, _mcpConfigPath?: string): NodeJS.ProcessEnv {
  if (env.AGENTLAS_AGY_KEEP_HOME === "1") return env;
  const realHome = personalHomeDir({ HOME: env.AGENTLAS_AGY_REAL_HOME || os.homedir() });
  // A HOME that is already a product mirror (resident re-entry) is kept; one merely inherited by this process is not.
  if (env.HOME && path.resolve(env.HOME) !== path.resolve(realHome) && !inheritedProductHome(env, "HOME")) return env;
  const mirror = syncAgyProductHome({ realHome, selection });
  if (!("home" in mirror)) return env;
  return { ...env, HOME: mirror.home, AGENTLAS_AGY_REAL_HOME: realHome };
}

/** The HOME an agy process with this environment reads ~/.gemini from. */
export function agySpawnHome(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

/** True when an agy process with this environment reads the person's own ~/.gemini (no product mirror). */
export function agySpawnsInPersonalHome(env: NodeJS.ProcessEnv): boolean {
  const realHome = personalHomeDir({ HOME: env.AGENTLAS_AGY_REAL_HOME || os.homedir() });
  return path.resolve(agySpawnHome(env)) === path.resolve(realHome);
}
