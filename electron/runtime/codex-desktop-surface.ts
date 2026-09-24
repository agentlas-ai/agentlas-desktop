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
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ChatGPT-bundled plugins that control the owner's desktop or personal Chrome. */
export const CODEX_DESKTOP_CONTROL_PLUGINS = [
  "computer-use@openai-bundled",
  "unified-computer-use@openai-bundled",
  "computer-history@openai-bundled",
  "chrome@openai-bundled",
  "browser@openai-bundled",
] as const;

/** Names the ChatGPT app writes into the user config for its desktop/browser hosts. */
const DESKTOP_CONTROL_SERVER_NAMES = new Set(["node_repl", "computer-use", "cua_repl"]);
/** Launch evidence of the same hosts under another server name. */
const DESKTOP_CONTROL_SERVER_EVIDENCE = /SKY_CUA_SERVICE_PATH|BROWSER_USE_AVAILABLE_BACKENDS|SkyComputerUseClient|cua_node|cua-repl/;

export interface CodexDesktopSurfaceInput {
  unattended?: boolean;
  browserOnly?: boolean;
  desktopControlGrant?: boolean;
  /** The spawn passes `--ignore-user-config`: user-declared servers do not exist. */
  userConfigIgnored?: boolean;
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
    if (DESKTOP_CONTROL_SERVER_NAMES.has(name) || DESKTOP_CONTROL_SERVER_EVIDENCE.test(body)) out.push(name);
  }
  return out.sort();
}

function readUserConfigServers(codexHome: string): string[] {
  const names = new Set<string>();
  for (const file of ["config.toml", "managed_config.toml"]) {
    try {
      for (const name of declaredDesktopControlServers(fs.readFileSync(path.join(codexHome, file), "utf8"))) names.add(name);
    } catch {
      /* A missing or unreadable file declares nothing. */
    }
  }
  return [...names].sort();
}

/**
 * `-c` overrides that keep this run off Codex's vendor desktop-control
 * surfaces. Empty when the run keeps them (attended, or Computer Use granted).
 */
export function codexDesktopSurfaceArgs(input: CodexDesktopSurfaceInput): CodexDesktopSurfaceDecision {
  if (!codexDesktopSurfaceClosed(input)) return { args: [], receipt: null };
  const args: string[] = [];
  for (const plugin of CODEX_DESKTOP_CONTROL_PLUGINS) args.push("-c", `plugins.${plugin}.enabled=false`);
  const servers = input.userConfigIgnored ? [] : readUserConfigServers(codexHomeFor(input));
  for (const server of servers) args.push("-c", `mcp_servers.${server}.enabled=false`);
  const reason = input.browserOnly ? "browser_only" : "unattended";
  return {
    args,
    receipt: `[codex-surface] desktop_control=closed reason=${reason} plugins=${CODEX_DESKTOP_CONTROL_PLUGINS.length} user_servers=${servers.join("|") || "-"}`,
  };
}
