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
// Not closable (reported in the receipt, not hidden): plugins that Grok discovers from `~/.claude/plugins` bring
// their MCP servers, hooks and agents; no env switch or `[plugins] disabled` entry removed them in the measurement.
// The same holds for the permission rules of `~/.claude/settings.json` and `settings.local.json` (grok 1.0.60
// `grok inspect --json` with every cell above off: 127 rules loaded from them); Grok reads them under HOME, not
// CLAUDE_CONFIG_DIR, and has no switch for them.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { isMirrorLink, syncConfigHomeMirror } from "./config-home-mirror";
import { allowlistedToml, withCliProductHome } from "./cli-product-homes";
import type { CapabilityItem, CapabilityKind, CapabilitySelection } from "../capabilities/one-capabilities";

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
  return path.resolve(env.GROK_HOME || path.join(env.HOME || os.homedir(), ".grok"));
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
 *   - `telemetry.trace_upload`: the person's choice about uploading session traces; it changes nothing an agent does.
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
  telemetry: new Set(["trace_upload"]),
};

/** The mirror's own config.toml: the allowlisted parts of the person's, One's MCP servers and the skills ignore. */
export function productGrokConfig(text: string, keepServers: ReadonlySet<string>, skillsIgnore: readonly string[]): string {
  const out = allowlistedToml(text, ({ path: [head, second] }) => GROK_KEEP_TABLES.has(head)
    || (second !== undefined && GROK_KEEP_KEYS[head]?.has(second) === true)
    || (head === "mcp_servers" && second !== undefined && keepServers.has(second)));
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
        "config.toml": productGrokConfig(config, keepServers, codexSkillsOn ? [] : [path.join(os.homedir(), ".agents", "skills")]),
        "user-settings.json": productGrokUserSettings(userSettings),
      },
    });
    // hooks/ and skills/ are folders of links to exactly the files One switched on.
    for (const [folder, items] of [["hooks", oneHas(selection, "grok", "hook")], ["skills", oneHas(selection, "grok", "skill")]] as const) {
      const dir = path.join(home, folder);
      const wanted = new Map(items.map((item) => {
        const target = folder === "skills" ? path.dirname(item.path) : item.path;
        return [path.basename(target), target] as const;
      }));
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
    if (!isMirrorLink(home, "auth.json")) return { skip: "links-unavailable" };
  } catch {
    return { skip: "links-unavailable" };
  }
  return { home };
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
  // A GROK_HOME Main chose for this run is kept; only the person's own folder is swapped for its mirror.
  if (env.GROK_HOME && path.resolve(env.GROK_HOME) !== real) return out;
  try {
    const mirror = syncGrokProductHome(real, selection);
    if ("home" in mirror) out.GROK_HOME = mirror.home;
  } catch {
    // No writable app folder (a host outside the app): the run keeps the real folder, with the cells above still off.
  }
  return out;
}
