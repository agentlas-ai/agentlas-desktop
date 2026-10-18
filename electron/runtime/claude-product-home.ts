// The Claude Code config dir a product run uses: the person's ~/.claude minus their sessions and history.
//
// Owner 2026-10-13: every runtime keeps the product's sessions on the Agentlas side; nothing an agent runs may show up in
// the person's own Claude app or `claude --resume` picker, and the person must stay signed in. Claude Code writes every
// conversation under $CLAUDE_CONFIG_DIR/projects/<cwd>/<session>.jsonl, so product runs used to fill ~/.claude/projects.
//
// Sign-in: Claude keys its OS keychain item by the config dir (Claude Code 2.1.296, secure-storage service name:
// `n = CLAUDE_SECURESTORAGE_CONFIG_DIR; plain = n !== undefined ? !n : !CLAUDE_CONFIG_DIR;` the name is
// "Claude Code-credentials" when plain, else suffixed with sha256(dir)). A product run therefore sets CLAUDE_CONFIG_DIR to
// the mirror AND CLAUDE_SECURESTORAGE_CONFIG_DIR="" so the keychain item (macOS) or ~/.claude/.credentials.json
// (Linux/Windows) is the person's own, unchanged. Claude forwards that variable to its own teammate processes, so the
// pair is a supported combination, not a trick.
//
// The mirror links the configuration entries of ~/.claude (CLAUDE.md, rules, skills, commands, plugins — the
// settings overlay in claude-personal-context.ts still decides which of those a run may use) except the session and
// state stores below, which are the mirror's own. settings.json is the mirror's own file holding only the sign-in,
// endpoint and model-default part of the person's (productClaudeSettings): never their hooks, env or permissions.
// `.claude.json` (global config) is the mirror's own file holding only the sign-in, install and first-run part of the
// person's (productClaudeGlobalConfig) plus the user-scope MCP servers One switched on.
// If links cannot be made (Windows without the right), the run keeps the real config dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { inheritedProductHome, personalHomeDir, personalHomeOverride, productHomeRefusedOnThisHost } from "./product-home-identity";

/**
 * Entries of ~/.claude a product run reads as configuration; only these are linked into the mirror. Everything else —
 * projects (sessions), history, todos, shell snapshots, file history, plans, jobs, telemetry, caches, backups, locks —
 * is the person's own and stays out; Claude creates the mirror's own stores. An allowlist, so a store a future Claude
 * version adds never leaks product sessions into the person's dir or the person's into product runs.
 * `agents/` (the person's own subagent definitions) is not linked: no settings key switches a user subagent off and
 * One's capability inventory has no subagent kind, so linked, every product run could delegate to the person's
 * subagents (their prompts, tools and models). A product agent's subagents are Agentlas's.
 */
export const CLAUDE_CONFIG_ENTRIES: readonly string[] = [
  "CLAUDE.md", "rules", "skills", "commands", "plugins", "output-styles",
  "keybindings.json", "policy-limits.json", "remote-settings.json", "managed-settings.json",
];
export function isClaudePersonalSessionEntry(name: string): boolean {
  return !CLAUDE_CONFIG_ENTRIES.includes(name);
}

/**
 * The person's user settings files. Never linked: the mirror's settings.json is its own file holding only
 * productClaudeSettings of them. Linked (until 2026-10-17), every product Claude run loaded the person's `hooks` (the
 * owner's: a PostToolUse gate runner and a SessionEnd/Stop `reap-dev-instances.sh` that ends dev app instances, run at
 * the end of every product session), their `env` (APP_STORE_CONNECT_*, GOOGLE_APPLICATION_CREDENTIALS and
 * GOOGLE_PLAY_KEY_FILE in every product shell: the class of leak Codex's shell environment was closed for on 2026-10-12),
 * `permissions` (pre-approved commands), `language`, `statusLine` and the rest. A `--settings` overlay cannot take hooks
 * or env back out (arrays and objects merge; `disableAllHooks` would also stop the product's own tool-broker hook).
 */
export const CLAUDE_PERSONAL_SETTINGS_FILES: readonly string[] = ["settings.json", "settings.local.json"];
/**
 * Kept from the person's settings, each for one reason: sign-in (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`,
 * `forceLoginMethod`, `forceLoginOrgUUID`: without them an API-key, Bedrock or org-pinned account cannot authenticate) and
 * the model default the app falls back to when it passes no `--model` / `--effort` (`model`, `effortLevel`;
 * cli-default-model.ts shows that `model` as the run's model).
 */
const CLAUDE_SETTINGS_KEYS: ReadonlySet<string> = new Set(["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "forceLoginMethod",
  "forceLoginOrgUUID", "model", "effortLevel"]);
/** `env` entries kept: which endpoint and sign-in Claude uses, and the network path to it. Nothing else of `env`. */
const CLAUDE_ENV_KEYS = /^(?:ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CODE_SKIP_(?:BEDROCK|VERTEX|FOUNDRY)_AUTH|CLAUDE_CODE_CLIENT_(?:CERT|KEY|KEY_PASSPHRASE)|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS)$/;
/**
 * `env` telemetry OPT-OUTS kept when switched on (owner decision 2026-10-17, every product home: a person who turned
 * vendor telemetry off keeps it off in product runs; never an opt-in such as CLAUDE_CODE_ENABLE_TELEMETRY or an OTEL
 * exporter; otherwise the vendor default). They change nothing an agent does.
 */
const CLAUDE_OPT_OUT_ENV_KEYS = /^(?:DISABLE_TELEMETRY|DISABLE_ERROR_REPORTING|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY)$/;
const switchedOn = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && value !== "0" && value !== 0 && value !== false && value !== "false";
/** Cloud credentials kept only when the same settings route Claude through that cloud (else they are the person's own tools'). */
const CLAUDE_CLOUD_ENV_KEYS: ReadonlyArray<{ when: RegExp; keys: RegExp }> = [
  { when: /^CLAUDE_CODE_USE_BEDROCK$/, keys: /^(?:AWS_[A-Z0-9_]+)$/ },
  { when: /^CLAUDE_CODE_USE_VERTEX$/, keys: /^(?:CLOUD_ML_REGION|VERTEX_REGION_[A-Z0-9_]+|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT)$/ },
];
/** Agentlas's own marketplaces (the same set as one-capabilities.ts AGENTLAS_MARKETPLACES): their plugins stay enabled. */
const AGENTLAS_CLAUDE_MARKETPLACES: ReadonlySet<string> = new Set(["agentlas-core-engine", "agentlas-sei"]);

/**
 * The mirror's own settings.json from the person's settings.json and settings.local.json (the latter wins, as in
 * Claude): only CLAUDE_SETTINGS_KEYS, the sign-in/endpoint part of `env` and its telemetry opt-outs, and the Agentlas engine's plugins with their
 * marketplaces (always on for product runs; the engine plugin also carries the browser claude-browser-surface.ts falls
 * back to). Everything else is left out by construction. A file that is not JSON contributes nothing.
 */
export function productClaudeSettings(settingsText: string | null, localText: string | null = null): string {
  const read = (text: string | null): Record<string, unknown> => {
    if (!text) return {};
    try { const v = JSON.parse(text) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
    catch { return {}; }
  };
  const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const out: Record<string, unknown> = {};
  const env: Record<string, unknown> = {};
  const plugins: Record<string, unknown> = {};
  const markets: Record<string, unknown> = {};
  for (const source of [read(settingsText), read(localText)]) {
    for (const [key, value] of Object.entries(source)) if (CLAUDE_SETTINGS_KEYS.has(key)) out[key] = value;
    const personalEnv = obj(source.env);
    for (const [key, value] of Object.entries(personalEnv)) {
      if (CLAUDE_ENV_KEYS.test(key)) env[key] = value;
      if (CLAUDE_OPT_OUT_ENV_KEYS.test(key) && switchedOn(value)) env[key] = value;
      for (const cloud of CLAUDE_CLOUD_ENV_KEYS) {
        const routed = Object.entries(personalEnv).some(([name, on]) => cloud.when.test(name) && on !== "" && on !== "0" && on !== false && on !== "false");
        if (routed && cloud.keys.test(key)) env[key] = value;
      }
    }
    for (const [id, value] of Object.entries(obj(source.enabledPlugins))) {
      if (AGENTLAS_CLAUDE_MARKETPLACES.has(id.slice(id.lastIndexOf("@") + 1))) plugins[id] = value;
    }
    for (const [name, value] of Object.entries(obj(source.extraKnownMarketplaces))) if (AGENTLAS_CLAUDE_MARKETPLACES.has(name)) markets[name] = value;
  }
  if (Object.keys(env).length > 0) out.env = env;
  if (Object.keys(plugins).length > 0) out.enabledPlugins = plugins;
  if (Object.keys(markets).length > 0) out.extraKnownMarketplaces = markets;
  return `${JSON.stringify(out, null, 2)}\n`;
}

export interface ClaudeProductHomeOptions {
  /** User-scope MCP servers (~/.claude.json mcpServers) the run may keep: One's switched-on connectors. */
  keepMcpServers?: readonly string[];
}

export function claudeProductHomeDir(): string {
  return userDataPath("claude-product-home");
}

/** The settings overlay's claudeMdExcludes, also under the mirror's paths (Claude reads CLAUDE.md through the mirror). */
export function withClaudeMirrorExcludes(settings: string, realDir: string, mirror: string): string {
  const base = JSON.parse(settings) as Record<string, unknown>;
  if (!Array.isArray(base.claudeMdExcludes)) return settings;
  const list = base.claudeMdExcludes.filter((item): item is string => typeof item === "string");
  const mapped = list.filter((item) => item === realDir || item.startsWith(realDir + path.sep)).map((item) => mirror + item.slice(realDir.length));
  return JSON.stringify({ ...base, claudeMdExcludes: [...new Set([...list, ...mapped])] });
}

export type ClaudeProductHomeSkip = "no-real-dir" | "links-unavailable" | "unconfigured-host";

export function realClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(personalHomeOverride(env, "CLAUDE_CONFIG_DIR") || path.join(personalHomeDir(env), ".claude"));
}

function quietly(action: () => void): void {
  try { action(); } catch { /* best effort */ }
}

/**
 * Keys of the person's global config (~/.claude.json) a product run keeps, each for one reason:
 *   - sign-in: `oauthAccount` (the signed-in account and organisation the keychain token belongs to), `primaryApiKey`
 *     (an API-key login, kept here where no keychain holds it), `customApiKeyResponses` (which ANTHROPIC_API_KEY the
 *     person approved), `userID`;
 *   - how the Claude Code install the person shares with product runs updates itself: `installMethod`, `autoUpdates`,
 *     `autoUpdatesProtectedForNative` (a product run must not update the person's install against their choice);
 *   - first-run and migration state, so a product run never replays onboarding or the settings migrations:
 *     `hasCompletedOnboarding`, `lastOnboardingVersion`, `migrationVersion`, every `*MigrationComplete` flag.
 * Everything else is left out by construction (the file was copied whole minus `projects` and `mcpServers` until
 * 2026-10-17): the person's Claude in Chrome switches (`claudeInChromeDefaultEnabled`, `chromeExtension`), auto-mode
 * opt-ins, remote-control state, usage counters, tips, caches Claude refetches, `githubRepoPaths`, `projects` (the
 * mirror keeps its own) and any key a later release adds. User-scope MCP servers: only the ones One switched on.
 */
const CLAUDE_GLOBAL_CONFIG_KEYS: ReadonlySet<string> = new Set(["oauthAccount", "primaryApiKey", "customApiKeyResponses", "userID",
  "installMethod", "autoUpdates", "autoUpdatesProtectedForNative", "hasCompletedOnboarding", "lastOnboardingVersion", "migrationVersion"]);

/** The mirror's own global config: the allowlisted keys of the person's, the mirror's own `projects`, One's MCP servers. */
export function productClaudeGlobalConfig(text: string, keep: readonly string[] = [], previousOwn?: string): string {
  const source = JSON.parse(text) as Record<string, unknown>;
  const own = previousOwn ? (() => { try { return JSON.parse(previousOwn) as Record<string, unknown>; } catch { return {}; } })() : {};
  const servers = source.mcpServers && typeof source.mcpServers === "object" ? source.mcpServers as Record<string, unknown> : {};
  const keptServers = Object.fromEntries(Object.entries(servers).filter(([name]) => keep.includes(name)));
  const kept = Object.fromEntries(Object.entries(source).filter(([key]) => CLAUDE_GLOBAL_CONFIG_KEYS.has(key) || /MigrationComplete$/.test(key)));
  return JSON.stringify({ ...kept, ...(own.projects ? { projects: own.projects } : {}), mcpServers: keptServers }, null, 2);
}

function writeIfChanged(at: string, content: string): void {
  try { if (fs.readFileSync(at, "utf8") === content) return; } catch { /* absent */ }
  const tmp = `${at}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, at);
}

/** Claude's global config: inside a custom CLAUDE_CONFIG_DIR, else ~/.claude.json next to the default dir. */
export function personalClaudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(realClaudeConfigDir(env), ".claude.json") : path.join(env.HOME || os.homedir(), ".claude.json");
}

export function syncClaudeProductHome(realDir: string, mirror = claudeProductHomeDir(), options: ClaudeProductHomeOptions = {},
  personalGlobal = path.join(os.homedir(), ".claude.json")): { dir: string } | { skip: ClaudeProductHomeSkip } {
  // A gate or script (no install identity) never mirrors the account's own ~/.claude (product-home-identity.ts).
  if (productHomeRefusedOnThisHost(realDir)) return { skip: "unconfigured-host" };
  if (!fs.existsSync(realDir)) return { skip: "no-real-dir" };
  fs.mkdirSync(mirror, { recursive: true, mode: 0o700 });
  const wanted = new Set(fs.readdirSync(realDir).filter((name) => !isClaudePersonalSessionEntry(name)));
  try {
    for (const name of wanted) {
      const at = path.join(mirror, name), target = path.join(realDir, name);
      let current: string | null = null;
      try { current = fs.readlinkSync(at); } catch { /* absent or not a link */ }
      if (current === target) continue;
      if (current !== null || fs.existsSync(at)) quietly(() => fs.rmSync(at, { recursive: false, force: true }));
      const isDir = fs.statSync(target).isDirectory();
      fs.symlinkSync(target, at, process.platform === "win32" && isDir ? "junction" : undefined);
    }
  } catch {
    return { skip: "links-unavailable" };
  }
  // Links to entries the person removed, or that are no longer linked at all (an older mirror's `agents`), go away; the
  // mirror's own stores are never links and stay.
  for (const name of fs.readdirSync(mirror)) {
    if (wanted.has(name) || name === ".claude.json") continue;
    const at = path.join(mirror, name);
    quietly(() => {
      if (fs.lstatSync(at).isSymbolicLink() && (!isClaudePersonalSessionEntry(name) || fs.readlinkSync(at) === path.join(realDir, name))) fs.unlinkSync(at);
    });
  }
  // The mirror's own settings.json (productClaudeSettings). An older mirror's links to the person's settings files are
  // removed first: written through, the link would replace the person's file, and left alone it keeps their hooks.
  for (const name of CLAUDE_PERSONAL_SETTINGS_FILES) {
    quietly(() => { if (fs.lstatSync(path.join(mirror, name)).isSymbolicLink()) fs.unlinkSync(path.join(mirror, name)); });
  }
  const personalSettings = (name: string): string | null => { try { return fs.readFileSync(path.join(realDir, name), "utf8"); } catch { return null; } };
  // A failed write leaves the mirror without user settings (Claude's defaults), never with the person's.
  quietly(() => writeIfChanged(path.join(mirror, "settings.json"), productClaudeSettings(personalSettings("settings.json"), personalSettings("settings.local.json"))));
  const ownGlobal = path.join(mirror, ".claude.json");
  try {
    const previous = (() => { try { return fs.readFileSync(ownGlobal, "utf8"); } catch { return undefined; } })();
    writeIfChanged(ownGlobal, productClaudeGlobalConfig(fs.readFileSync(personalGlobal, "utf8"), options.keepMcpServers ?? [], previous));
  } catch { /* the person has no global config yet: Claude creates the mirror's own */ }
  return { dir: mirror };
}

/**
 * Env every product Claude Code run carries, on every path (one-shot, resident, Alive, judgment) and whether or not the
 * mirror below can hold. Owner decision 2026-10-16: the collapsed progress checklist Codex shows (turn/plan/updated).
 * Claude Code 2.1.268+ offers its todo tools (TaskCreate, TaskUpdate, TaskList, TaskGet; TodoWrite on older CLIs) only on
 * models up to Opus 4.7 / Sonnet 4.6 unless CLAUDE_CODE_ENABLE_TODO_TOOLS=1; on 2.1.301 with claude-opus-5-5 the
 * system/init tool list has none of them without it (measured 2026-10-16). runtime-plan.ts reads those tools into the
 * one typed plan. This changes the tool list Claude sees, not any prompt text; the task store stays in the mirror (the
 * `tasks` dir is not a linked config entry).
 */
export const CLAUDE_PRODUCT_RUN_ENV: Readonly<Record<string, string>> = Object.freeze({ CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" });

/** `env` itself when it already carries CLAUDE_PRODUCT_RUN_ENV (idempotent), else a copy that does. */
function withClaudeProductRunEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.entries(CLAUDE_PRODUCT_RUN_ENV).every(([key, value]) => env[key] === value) ? env : { ...env, ...CLAUDE_PRODUCT_RUN_ENV };
}

/** The product run's env: the mirror as config dir, the person's own sign-in. Only CLAUDE_PRODUCT_RUN_ENV when the mirror cannot hold. */
export function withClaudeProductHome(env: NodeJS.ProcessEnv = process.env, options: ClaudeProductHomeOptions = {}, mirror?: string): NodeJS.ProcessEnv {
  // already a product env (or the caller chose); a product env merely inherited by this process is not the run's choice
  if (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined && !inheritedProductHome(env, "CLAUDE_CONFIG_DIR")) return withClaudeProductRunEnv(env);
  const real = realClaudeConfigDir(env);
  const result = syncClaudeProductHome(real, mirror, options, personalClaudeGlobalConfigPath(env));
  if (!("dir" in result)) return withClaudeProductRunEnv(env);
  // A person who runs Claude with their own CLAUDE_CONFIG_DIR keeps its keychain item: name that dir for secure storage.
  const secure = env.CLAUDE_CONFIG_DIR ? real : "";
  return { ...env, ...CLAUDE_PRODUCT_RUN_ENV, CLAUDE_CONFIG_DIR: result.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: secure };
}

/** Claude names a project's session folder after its working directory: every non-alphanumeric becomes "-". */
function projectKey(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * A product session an older install wrote into the person's ~/.claude/projects moves into the mirror when it is next
 * resumed, so the conversation continues and leaves the person's Claude app. Returns true when the mirror now holds it.
 */
export function adoptClaudeSessionIntoProductHome(env: NodeJS.ProcessEnv, sessionId: string, cwd: string): boolean {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId) || env.CLAUDE_CONFIG_DIR === undefined || env.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined) return false;
  const mirrorFile = path.join(env.CLAUDE_CONFIG_DIR, "projects", projectKey(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(mirrorFile)) return true;
  const personalDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  const personalFile = path.join(personalDir, "projects", projectKey(cwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(personalFile)) return false;
  fs.mkdirSync(path.dirname(mirrorFile), { recursive: true, mode: 0o700 });
  try { fs.renameSync(personalFile, mirrorFile); }
  catch { fs.copyFileSync(personalFile, mirrorFile); quietly(() => fs.unlinkSync(personalFile)); }
  return true;
}
