// Antigravity (agy) product runs: the person's own GEMINI.md, skills, plugins, hooks and MCP servers stay out; only
// One gets back the items the person switched on (owner decision 2026-10-11, all users).
//
// agy has no config-dir flag or env var; it reads ~/.gemini under HOME. So a product run gets a HOME of its own: a
// directory whose entries are symlinks to EVERY entry of the real HOME (Library included, so the login keychain and
// its search list in ~/Library/Preferences resolve exactly as for the person; a bare HOME made macOS show "keychain
// not found" for the 'antigravity' sign-in item on 2026-10-12), except `.gemini`, which is a filtered mirror
// (config-home-mirror.ts). Sign-in (antigravity-cli/antigravity-oauth-token, oauth_creds.json, the keychain item),
// conversations, brain and project registrations stay one and the same file through the links, so a session written
// through the mirror resumes from either side. The real folders are only ever READ here.
//
// Left out of `.gemini` (the context agy would otherwise load): GEMINI.md (+ backups), commands/, extensions/,
// config/{skills,plugins,sidecars,hooks.json,mcp_config.json}, the per-server MCP tool descriptors (mcp/), the
// knowledge store, plugin data and global workflows. MCP servers are the ones this run's own authorized MCP config
// asked for plus the ones One switched on.
//
// The person's policy files are never linked either: config/config.json, antigravity-cli/settings.json and the
// config/projects folder are the mirror's own, holding only an allowlist of the person's (productAgyConfig,
// productAgyCliSettings, syncAgyProjects), and the Antigravity app's own settings (antigravity/settings.json,
// antigravity/user_settings.pb) are absent. Measured 2026-10-17 on agy 1.4.0 through the mirror as it was (every product
// run's log: "applyUserSettings: stored shared config permissions: allow=15 ... from <mirror>/.gemini/config/config.json"):
// a READ product turn, which Agentlas gives no permission flag ("tools: cannot be approved here"), ran `ls -1 .`
// because the owner's own `globalPermissionGrants` allowed `command(ls)`, while `pwd` (not in the owner's grants) was
// denied. Permission for a product run is Agentlas's: the permission flags (antigravityPermissionArgs) and the
// Agentlas-owned browser projects, never the person's grants, auto-execution, file-access or sandbox choices.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { isMirrorLink, syncConfigHomeMirror } from "./config-home-mirror";
import type { CapabilityItem, CapabilityKind, CapabilitySelection } from "../capabilities/one-capabilities";
import { inheritedProductHome, personalHomeDir } from "./product-home-identity";

/** Antigravity's conversation stores (per-conversation brain, annotations, recordings). Never linked into a product mirror. */
const AGY_PERSONAL_SESSION_ENTRIES = new Set(["conversations", "brain", "annotations", "implicit", "html_artifacts",
  "browser_recordings", "code_tracker", "context_state"]);

export type AgyProductHomeSkip = "unsupported-platform" | "no-real-gemini" | "no-sign-in-files" | "links-unavailable";

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
 * `userSettings` keys of the person's config/config.json a product run keeps. An ALLOWLIST (owner 2026-10-06/10-11: the
 * person's settings never drive product agents). The file is "user settings shared with Antigravity"; agy merges its
 * `globalPermissionGrants` into every run and applies its `autoExecutionPolicy`, `nonWorkspaceFileAccessPolicy`,
 * `enableTerminalSandbox` and `artifactReviewMode` (agy changelog: headless runs honor them). Measured 2026-10-17
 * (agy 1.4.0, mirror without those keys): a full-permission run is still unsandboxed (a write outside the workspace
 * succeeded) and a write run is sandboxed by its own `--sandbox`, so Agentlas's flags alone decide; leaving them out
 * changes nothing a product run asked for.
 *   - `useAiCredits`: whether the account spends its AI credits once the free quota is used up (agy: "the CLI inherits
 *     the use_ai_credits setting from global user settings"). Billing plumbing of the account, the way the person's own
 *     agy reaches the model; it grants no tool authority.
 * Everything else (`globalPermissionGrants`, auto-execution, file access, terminal sandbox, artifact review,
 * `remoteControlHostname`, any key a later release adds) is left out by construction.
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
 * The mirror's own config/projects. A non-browser product run uses agy's "CLI Project" (default-cli-project.json; every
 * product run in the logs of 2026-10-16), and agy applies a project's `permissionGrants` and `settings` over the global
 * ones; the person's other projects carry their own grants and policies (the owner's: `outside-of-project` with
 * file access ALLOW, auto-execution EAGER, artifact review TURBO; projects allowing MCP tools and URL reads). So the
 * folder holds: links to the projects Agentlas wrote (the legacy browser project lives in the person's folder), and
 * the two built-in projects as identity only. The person's own projects are not visible. Files agy or Agentlas create
 * in the mirror (the scoped-read browser project, a project agy makes for a new folder) stay the mirror's own.
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

export interface AgyProductHomeInput {
  /** The person's real HOME. */
  realHome: string;
  selection: CapabilitySelection | undefined;
  /** MCP server keys this run's authorized MCP config asked for (their entries are read from the real mcp_config.json). */
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
    // The CLI's own data folders: sign-in and binaries stay linked; the stores that carry the person's memory, MCP tool
    // descriptors and prompt history are hidden, and so are the conversation stores (owner 2026-10-12: Agentlas sessions
    // are kept apart from personal sessions in every app). Antigravity creates its own conversation store in the mirror.
    // The CLI's settings.json is the mirror's own allowlisted file; the Antigravity app's own settings (settings.json
    // with its `permissions.allow`, user_settings.pb) are not the CLI's (measured: a command only that file allows was
    // still denied) and stay out.
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
    const realMcp = readJsonObject(path.join(realConfig, "mcp_config.json"));
    const realServers = (realMcp?.mcpServers && typeof realMcp.mcpServers === "object" ? (realMcp.mcpServers as Record<string, unknown>) : {});
    const wantedServers = new Set([...(input.runMcpKeys ?? []), ...servers.map((item) => item.name)]);
    own["mcp_config.json"] = `${JSON.stringify({ ...(realMcp ?? {}), mcpServers: Object.fromEntries(Object.entries(realServers).filter(([name]) => wantedServers.has(name))) }, null, 2)}\n`;
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
 * mirror keeps the real HOME. Callers must run this AFTER the run's MCP servers were written to the real config.
 */
export function withAgyProductHome(env: NodeJS.ProcessEnv, selection: CapabilitySelection | undefined, mcpConfigPath: string | undefined): NodeJS.ProcessEnv {
  if (env.AGENTLAS_AGY_KEEP_HOME === "1") return env;
  const realHome = personalHomeDir({ HOME: env.AGENTLAS_AGY_REAL_HOME || os.homedir() });
  // A HOME that is already a product mirror (resident re-entry) is kept; one merely inherited by this process is not.
  if (env.HOME && path.resolve(env.HOME) !== path.resolve(realHome) && !inheritedProductHome(env, "HOME")) return env;
  const mirror = syncAgyProductHome({ realHome, selection, runMcpKeys: runMcpKeysOf(mcpConfigPath) });
  if (!("home" in mirror)) return env;
  return { ...env, HOME: mirror.home, AGENTLAS_AGY_REAL_HOME: realHome };
}
