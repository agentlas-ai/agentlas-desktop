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
 * Browser surfaces are narrower and always closed (2026-09-24, owner: "당근
 * 내장브라우저에서 하겠지? 자꾸 외부크롬 켜지는거 같아서"). Every Agentlas run
 * already has an owned browser — the in-app guest for a watched chat, the
 * dedicated Chrome for Testing profile otherwise — so a runtime's own browser
 * plugin (bundled chrome/browser) or a user-level browser-automation MCP server
 * (`@playwright/mcp` defaults to the installed Google Chrome channel) only adds
 * a second, external Chrome window with a different login state. Those close on
 * every run unless Main granted Computer Use; the ChatGPT desktop-control hosts
 * above keep the attended/unattended rule. Owned references: OpenAI Atlas runs
 * its agent in its own StoragePartition; Playwright MCP's persistent profile
 * launches the installed Chrome channel (microsoft/playwright-mcp#1483).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ChatGPT-bundled plugins that control the owner's desktop. */
export const CODEX_DESKTOP_ONLY_PLUGINS = [
  "computer-use@openai-bundled",
  "unified-computer-use@openai-bundled",
  "computer-history@openai-bundled",
] as const;

/** Codex plugins whose only job is to drive a browser other than the Agentlas one. */
export const CODEX_BROWSER_PLUGINS = [
  "chrome@openai-bundled",
  "browser@openai-bundled",
  "playwright@claude-plugins-official",
] as const;

/** Main's own browser server name in `-c mcp_servers.<name>` (mcpConfigKey of the catalog id). */
const AGENTLAS_BROWSER_SERVER = "agentlas-browser";

/** Every vendor desktop/browser plugin closed for unattended or browser-only runs. */
export const CODEX_DESKTOP_CONTROL_PLUGINS = [...CODEX_DESKTOP_ONLY_PLUGINS, ...CODEX_BROWSER_PLUGINS] as const;

/** Names the ChatGPT app writes into the user config for its desktop/browser hosts. */
const DESKTOP_CONTROL_SERVER_NAMES = new Set(["node_repl", "computer-use", "cua_repl"]);
/** Launch evidence of the same hosts under another server name. */
const DESKTOP_CONTROL_SERVER_EVIDENCE = /SKY_CUA_SERVICE_PATH|BROWSER_USE_AVAILABLE_BACKENDS|SkyComputerUseClient|cua_node|cua-repl/;
/** User-level browser-automation servers (they launch their own, usually the installed, Chrome). */
const BROWSER_AUTOMATION_SERVER_NAMES = new Set(["playwright", "chrome-devtools", "puppeteer", "browsermcp", "browser-use"]);
const BROWSER_AUTOMATION_SERVER_EVIDENCE = /@playwright\/mcp|playwright-mcp|chrome-devtools-mcp|@modelcontextprotocol\/server-puppeteer|puppeteer-mcp|@browsermcp\/mcp|browser-use/;

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

/** Whether this run must be kept off browsers other than the Agentlas-owned one. */
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
  return declaredServers(tomlText, BROWSER_AUTOMATION_SERVER_NAMES, BROWSER_AUTOMATION_SERVER_EVIDENCE);
}

function declaredServers(tomlText: string, names: ReadonlySet<string>, evidence: RegExp): string[] {
  const bodies = new Map<string, string>();
  let current: string | null = null;
  for (const line of tomlText.split(/\r?\n/)) {
    const header = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      const m = /^\s*mcp_servers\.("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)(\..*)?$/.exec(header[1]);
      current = m ? unquoteTomlKey(m[1]) : null;
      if (current && !bodies.has(current)) bodies.set(current, "");
      continue;
    }
    if (current) bodies.set(current, `${bodies.get(current)}${line}\n`);
  }
  const out: string[] = [];
  for (const [name, body] of bodies) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue; // cannot be addressed safely as a dotted -c key
    const hasTransport = /^\s*(command|url)\s*=/m.test(body);
    if (!hasTransport) continue; // a bare override would fail Codex bootstrap
    if (names.has(name) || evidence.test(body)) out.push(name);
  }
  return out.sort();
}

function readUserConfigServers(codexHome: string, classify: (toml: string) => string[]): string[] {
  const names = new Set<string>();
  for (const file of ["config.toml", "managed_config.toml"]) {
    try {
      for (const name of classify(fs.readFileSync(path.join(codexHome, file), "utf8"))) names.add(name);
    } catch {
      /* A missing or unreadable file declares nothing. */
    }
  }
  return [...names].sort();
}

/**
 * `-c` overrides that keep this run off Codex's vendor desktop-control surfaces
 * (unattended/browser-only) and off every non-Agentlas browser: bundled browser
 * plugins always, user browser-automation servers when the run is unattended or
 * Main bound the Agentlas browser. Empty only for a Computer Use run.
 */
export function codexDesktopSurfaceArgs(input: CodexDesktopSurfaceInput): CodexDesktopSurfaceDecision {
  const desktopClosed = codexDesktopSurfaceClosed(input);
  const browserClosed = codexBrowserSurfaceClosed(input);
  if (!desktopClosed && !browserClosed) return { args: [], receipt: null };
  const plugins = [...(desktopClosed ? CODEX_DESKTOP_ONLY_PLUGINS : []), ...(browserClosed ? CODEX_BROWSER_PLUGINS : [])];
  const args: string[] = [];
  for (const plugin of plugins) args.push("-c", `plugins.${plugin}.enabled=false`);
  const host = new Set(input.hostServerNames ?? []);
  const servers = new Set<string>();
  if (!input.userConfigIgnored) {
    const home = codexHomeFor(input);
    if (desktopClosed) for (const name of readUserConfigServers(home, declaredDesktopControlServers)) servers.add(name);
    // A user browser-automation server is a second browser beside the Agentlas
    // one Main bound for this run (or on a run nobody watches). An attended turn
    // without a bound browser reads no config at all (hermetic residency gate).
    if (browserClosed && (desktopClosed || host.has(AGENTLAS_BROWSER_SERVER))) {
      for (const name of readUserConfigServers(home, declaredBrowserAutomationServers)) servers.add(name);
    }
  }
  const closedServers = [...servers].filter((name) => !host.has(name)).sort();
  for (const server of closedServers) args.push("-c", `mcp_servers.${server}.enabled=false`);
  const desktop = desktopClosed ? `closed reason=${input.browserOnly ? "browser_only" : "unattended"}` : "open";
  return {
    args,
    receipt: `[codex-surface] desktop_control=${desktop} browser_surface=${browserClosed ? "closed" : "open"} plugins=${plugins.length} user_servers=${closedServers.join("|") || "-"}`,
  };
}
