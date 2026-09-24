/**
 * Codex's own desktop-control surfaces — who may reach them.
 *
 * Production 1.2.40 (Runtime Doctor run for Threads automation f7a61706,
 * 2026-09-24 02:02Z): the recovery run used the resident Codex app-server with
 * the owner's ~/.codex/config.toml. That config enables the ChatGPT-bundled
 * `unified-computer-use@openai-bundled` plugin, whose `cua_repl` MCP server
 * drives native apps. The unattended run created a visible tab in the owner's
 * real Google Chrome, typed a URL and pressed Return — although the automation
 * was configured for the Agentlas browser only (tool_mode=browser).
 *
 * Rule: a run that no human is watching (unattended), or a run bounded to the
 * Agentlas browser (browserOnly), never reaches Codex's vendor desktop/browser
 * control surfaces unless Main granted desktop control for this run (the
 * automation/chat explicitly selected Computer Use). The Agentlas browser
 * (its own CDP profile) and Agentlas Computer Use (cua-driver, Main-gated)
 * are bound separately by the host and are not affected.
 *
 * Measured on codex-cli 0.156.1 with `app-server` + `mcpServerStatus/list`:
 *   - `-c plugins.<id>.enabled=false` (UNQUOTED id) removes the plugin's MCP
 *     servers (cua_repl, computer-history). The quoted form
 *     `plugins."<id>".enabled=false` is silently ignored.
 *   - `--disable computer_use|browser_use|browser_use_external|in_app_browser`
 *     removes nothing, so features are not the switch.
 *   - An override for a plugin that is not installed is harmless.
 *   - `-c mcp_servers.<name>.enabled=false` for a server that the user config
 *     does NOT declare fails bootstrap ("invalid transport"), so user-level
 *     servers are disabled only when the user config actually declares them —
 *     and never under `--ignore-user-config` (isolated runs): there the user
 *     config is not loaded, so every such override is a transport-less server.
 *     Dev-app E2E 2026-09-24 (browser-mode Threads automation, isolated exec):
 *     "Error loading config.toml: invalid transport in `mcp_servers.computer-use`".
 *
 * Browser surfaces (2026-09-24, owner: "당근 내장브라우저에서 하겠지? 자꾸 외부크롬
 * 켜지는거 같아서", then "우선순위를 agentlas 플러그인을 우선으로 하자는거지"):
 *   - Bundled chrome@/browser@openai-bundled drive the owner's own browser —
 *     desktop-control class, closed on every run unless Main granted Computer Use.
 *   - User browser-automation servers (`@playwright/mcp` launches the installed
 *     Google Chrome channel) and the Playwright plugin are outside equivalents of
 *     the Agentlas browser (shared/capability-priority.ts): hidden while an
 *     Agentlas browser is reachable in this run (Main bound it, or the user
 *     config declares one / enables a plugin that ships one), kept as the
 *     fallback otherwise so a run that needs a browser never dead-ends.
 *   - An attended turn without a bound browser reads no config at all (hermetic
 *     residency gate test-codex-residency), so its Agentlas state is "unknown"
 *     and the outside browser stays as the fallback.
 * Owned references: OpenAI Atlas runs its agent in its own StoragePartition;
 * Playwright MCP's persistent profile launches the installed Chrome channel
 * (microsoft/playwright-mcp#1483).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capabilityEquivalents,
  outsideProviderPolicy,
  type AgentlasProviderState,
} from "../../shared/capability-priority";

/** ChatGPT-bundled plugins that control the owner's desktop. */
export const CODEX_DESKTOP_ONLY_PLUGINS = [
  "computer-use@openai-bundled",
  "unified-computer-use@openai-bundled",
  "computer-history@openai-bundled",
] as const;

/** Bundled plugins that drive the owner's own browser (desktop-control class). */
export const CODEX_OWNER_BROWSER_PLUGINS = [
  "chrome@openai-bundled",
  "browser@openai-bundled",
] as const;

const BROWSER = capabilityEquivalents("browser")!;

/** Every Codex plugin that drives a browser other than the Agentlas one. */
export const CODEX_BROWSER_PLUGINS: readonly string[] = [...CODEX_OWNER_BROWSER_PLUGINS, ...BROWSER.codexPlugins];

/** Every vendor desktop/browser plugin closed for unattended or browser-only runs. */
export const CODEX_DESKTOP_CONTROL_PLUGINS: readonly string[] = [...CODEX_DESKTOP_ONLY_PLUGINS, ...CODEX_BROWSER_PLUGINS];

/** Names the ChatGPT app writes into the user config for its desktop/browser hosts. */
const DESKTOP_CONTROL_SERVER_NAMES = new Set(["node_repl", "computer-use", "cua_repl"]);
/** Launch evidence of the same hosts under another server name. */
const DESKTOP_CONTROL_SERVER_EVIDENCE = /SKY_CUA_SERVICE_PATH|BROWSER_USE_AVAILABLE_BACKENDS|SkyComputerUseClient|cua_node|cua-repl/;
/** User-level browser-automation servers (they launch their own, usually the installed, Chrome). */
const BROWSER_AUTOMATION_SERVER_NAMES = new Set(BROWSER.codexServerNames);
const BROWSER_AUTOMATION_SERVER_EVIDENCE = BROWSER.codexServerEvidence;
const AGENTLAS_BROWSER_SERVER_NAMES = new Set(BROWSER.agentlasServerNames);
const AGENTLAS_BROWSER_SERVER_EVIDENCE = BROWSER.agentlasServerEvidence ?? /$^/;

export interface CodexDesktopSurfaceInput {
  unattended?: boolean;
  browserOnly?: boolean;
  desktopControlGrant?: boolean;
  /** The spawn passes `--ignore-user-config`: user-declared servers do not exist. */
  userConfigIgnored?: boolean;
  /** Server names Main itself binds for this run (`-c mcp_servers.<name>.*`); never overridden here. */
  hostServerNames?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CodexDesktopSurfaceDecision {
  args: string[];
  /** Machine-readable receipt, or null when this run keeps the vendor surfaces. */
  receipt: string | null;
}

/** Whether this run must be kept off Codex's vendor desktop-control surfaces. */
export function codexDesktopSurfaceClosed(input: CodexDesktopSurfaceInput): boolean {
  if (input.desktopControlGrant) return false;
  return input.unattended === true || input.browserOnly === true;
}

/** Whether this run must be kept off the owner's own browser (bundled chrome/browser plugins). */
export function codexBrowserSurfaceClosed(input: CodexDesktopSurfaceInput): boolean {
  return input.desktopControlGrant !== true;
}

function codexHomeFor(input: CodexDesktopSurfaceInput): string {
  const env = input.env ?? process.env;
  const base = path.resolve(input.cwd ?? process.cwd());
  const home = path.resolve(base, env.HOME || os.homedir());
  return path.resolve(base, env.CODEX_HOME || path.join(home, ".codex"));
}

function unquoteTomlKey(key: string): string {
  const trimmed = key.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Declared `[mcp_servers.<name>]` tables (with their sub-tables) of one TOML
 * file. Only table headers are read; values are matched as launch evidence and
 * never returned or logged.
 */
export function declaredDesktopControlServers(tomlText: string): string[] {
  return declaredServers(tomlText, DESKTOP_CONTROL_SERVER_NAMES, DESKTOP_CONTROL_SERVER_EVIDENCE);
}

/** Declared user-level browser-automation servers (Playwright, DevTools, Puppeteer …). */
export function declaredBrowserAutomationServers(tomlText: string): string[] {
  return declaredServers(tomlText, BROWSER_AUTOMATION_SERVER_NAMES, BROWSER_AUTOMATION_SERVER_EVIDENCE)
    .filter((name) => !declaredAgentlasBrowserServers(tomlText).includes(name));
}

/** Declared user-level servers that are the Agentlas browser (by name or launcher evidence). */
export function declaredAgentlasBrowserServers(tomlText: string): string[] {
  return declaredServers(tomlText, AGENTLAS_BROWSER_SERVER_NAMES, AGENTLAS_BROWSER_SERVER_EVIDENCE);
}

function tomlTables(tomlText: string, prefix: "mcp_servers" | "plugins"): Map<string, string> {
  const bodies = new Map<string, string>();
  const header = new RegExp(`^\\s*${prefix}\\.("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)(\\..*)?$`);
  let current: string | null = null;
  for (const line of tomlText.split(/\r?\n/)) {
    const table = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (table) {
      const m = header.exec(table[1]);
      // A server sub-table (`[mcp_servers.x.env]`) keeps its parent's body; a plugin sub-table is not the plugin.
      current = m && (prefix === "mcp_servers" || !m[2]) ? unquoteTomlKey(m[1]) : null;
      if (current && !bodies.has(current)) bodies.set(current, "");
      continue;
    }
    if (/^\s*\[\[/.test(line)) { current = null; continue; }
    if (current) bodies.set(current, `${bodies.get(current)}${line}\n`);
  }
  return bodies;
}

function declaredServers(tomlText: string, names: ReadonlySet<string>, evidence: RegExp): string[] {
  const out: string[] = [];
  for (const [name, body] of tomlTables(tomlText, "mcp_servers")) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue; // cannot be addressed safely as a dotted -c key
    const hasTransport = /^\s*(command|url)\s*=/m.test(body);
    if (!hasTransport) continue; // a bare override would fail Codex bootstrap
    if (names.has(name) || evidence.test(body)) out.push(name);
  }
  return out.sort();
}

/** Plugin ids the TOML enables (`[plugins."<id>"] enabled = true`). */
export function enabledCodexPlugins(tomlText: string): string[] {
  const out: string[] = [];
  for (const [id, body] of tomlTables(tomlText, "plugins")) {
    if (/^\s*enabled\s*=\s*true\b/m.test(body)) out.push(id);
  }
  return out.sort();
}

function readUserConfigTexts(codexHome: string): string[] {
  const texts: string[] = [];
  for (const file of ["config.toml", "managed_config.toml"]) {
    try {
      texts.push(fs.readFileSync(path.join(codexHome, file), "utf8"));
    } catch {
      /* A missing or unreadable file declares nothing. */
    }
  }
  return texts;
}

function readUserConfigServers(texts: readonly string[], classify: (toml: string) => string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) for (const name of classify(text)) names.add(name);
  return [...names].sort();
}

/** Whether an enabled Codex plugin ships the Agentlas browser (its cached `.mcp.json` declares it). */
function enabledPluginShipsAgentlasBrowser(codexHome: string, texts: readonly string[]): boolean {
  for (const id of new Set(texts.flatMap(enabledCodexPlugins))) {
    const m = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)$/.exec(id);
    if (!m) continue;
    const root = path.join(codexHome, "plugins", "cache", m[2], m[1]);
    let versions: string[] = [];
    try { versions = fs.readdirSync(root).sort().reverse().slice(0, 3); } catch { continue; }
    for (const version of versions) {
      try {
        const json = JSON.parse(fs.readFileSync(path.join(root, version, ".mcp.json"), "utf8")) as Record<string, unknown>;
        const servers = json.mcpServers && typeof json.mcpServers === "object" ? json.mcpServers as Record<string, unknown> : json;
        if (Object.keys(servers).some((name) => AGENTLAS_BROWSER_SERVER_NAMES.has(name))) return true;
      } catch { /* no MCP declaration in this version */ }
    }
  }
  return false;
}

/**
 * `-c` overrides for this run:
 *   - vendor desktop control closed for unattended/browser-only runs;
 *   - the owner's own browser (bundled chrome/browser plugins) closed on every run;
 *   - outside browser equivalents (Playwright plugin, user browser-automation
 *     servers) hidden only while an Agentlas browser is reachable, otherwise kept
 *     as the fallback.
 * Empty only for a Computer Use run.
 */
export function codexDesktopSurfaceArgs(input: CodexDesktopSurfaceInput): CodexDesktopSurfaceDecision {
  const desktopClosed = codexDesktopSurfaceClosed(input);
  const ownerBrowserClosed = codexBrowserSurfaceClosed(input);
  if (!desktopClosed && !ownerBrowserClosed) return { args: [], receipt: null };
  const host = new Set(input.hostServerNames ?? []);
  const hostBound = BROWSER.agentlasServerNames.some((name) => host.has(name));
  // User config is read only where it already was: a run nobody watches /
  // bounded to the browser, or a run Main bound the Agentlas browser for.
  const readConfig = !input.userConfigIgnored && (desktopClosed || hostBound);
  const home = readConfig ? codexHomeFor(input) : "";
  const texts = readConfig ? readUserConfigTexts(home) : [];
  let agentlas: AgentlasProviderState;
  if (hostBound) agentlas = "bound";
  else if (readConfig) {
    agentlas = readUserConfigServers(texts, declaredAgentlasBrowserServers).length > 0
      || enabledPluginShipsAgentlasBrowser(home, texts) ? "available" : "unavailable";
  } else agentlas = input.userConfigIgnored ? "unavailable" : "unknown";
  const policy = outsideProviderPolicy({ explicitGrant: input.desktopControlGrant === true, agentlas });
  const hideOutsideBrowsers = policy === "agentlas-only";

  const plugins = [
    ...(desktopClosed ? CODEX_DESKTOP_ONLY_PLUGINS : []),
    ...(ownerBrowserClosed ? CODEX_OWNER_BROWSER_PLUGINS : []),
    ...(hideOutsideBrowsers ? BROWSER.codexPlugins : []),
  ];
  const args: string[] = [];
  for (const plugin of plugins) args.push("-c", `plugins.${plugin}.enabled=false`);
  const servers = new Set<string>();
  if (readConfig) {
    if (desktopClosed) for (const name of readUserConfigServers(texts, declaredDesktopControlServers)) servers.add(name);
    if (hideOutsideBrowsers) for (const name of readUserConfigServers(texts, declaredBrowserAutomationServers)) servers.add(name);
  }
  const closedServers = [...servers].filter((name) => !host.has(name)).sort();
  for (const server of closedServers) args.push("-c", `mcp_servers.${server}.enabled=false`);
  const desktop = desktopClosed ? `closed reason=${input.browserOnly ? "browser_only" : "unattended"}` : "open";
  return {
    args,
    receipt: `[codex-surface] desktop_control=${desktop} browser_surface=${hideOutsideBrowsers ? "closed" : "fallback"} agentlas_browser=${agentlas} plugins=${plugins.length} user_servers=${closedServers.join("|") || "-"}`,
  };
}
