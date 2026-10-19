/**







































 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capabilityEquivalents,
  outsideProviderPolicy,
  type AgentlasProviderState,
} from "../../shared/capability-priority";

export interface ClaudeBrowserSurfaceInput {
  desktopControlGrant?: boolean;
  /** The no-tools path already passes --no-chrome and --tools "". */
  untrustedNoTools?: boolean;
  /** Main's exact MCP allow list (`mcp__<key>`, `mcp__<key>__*`). */
  hostAllowedTools?: readonly string[];
  /**
   * Whether the owner's Claude settings enable a plugin that ships the Agentlas
   * browser (the engine plugin's `agentlas-browser`), measured by
   * `claudeEngineBrowserEnabled`. Undefined means not measured.
   */
  engineBrowserEnabled?: boolean;
}

export interface ClaudeBrowserSurfaceDecision {
  args: string[];
  /** Machine-readable receipt, or null when this run keeps the surfaces. */
  receipt: string | null;
  /**
   * True when the only Agentlas browser this run can reach is the engine plugin's copy (Main bound none): a plugin
   * MCP server the run still needs, so `--strict-mcp-config` (which drops plugin servers too) must not be used.
   */
  pluginBrowserNeeded: boolean;
}

/** The owner's real Chrome (desktop-control class): only a Computer Use grant opens it. */
const CLAUDE_OWNER_CHROME_PATTERN = "mcp__claude-in-chrome";
const BROWSER = capabilityEquivalents("browser")!;

/** Every non-Agentlas browser pattern this module may deny. */
export const CLAUDE_FOREIGN_BROWSER_TOOL_PATTERNS: readonly string[] = [
  CLAUDE_OWNER_CHROME_PATTERN,
  ...BROWSER.claudeToolPatterns,
];

/** The engine plugin's copy of the Agentlas browser (duplicate when Main bound its own). */
const ENGINE_BROWSER_DUPLICATE = "mcp__plugin_*_agentlas-browser__*";

function globMatches(pattern: string, name: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}(?:__.*)?$`).test(name);
}

function hostServerKeys(allowed: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const tool of allowed) {
    const m = /^mcp__(.+?)(?:__.*)?$/.exec(tool);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

export function claudeBrowserSurfaceArgs(input: ClaudeBrowserSurfaceInput): ClaudeBrowserSurfaceDecision {
  if (input.desktopControlGrant || input.untrustedNoTools) return { args: [], receipt: null, pluginBrowserNeeded: input.desktopControlGrant === true };
  const keys = hostServerKeys(input.hostAllowedTools ?? []);
  const probes = keys.map((key) => `mcp__${key}__probe`);
  const hostBound = BROWSER.agentlasServerNames.some((name) => keys.includes(name));
  const agentlas: AgentlasProviderState = hostBound
    ? "bound"
    : input.engineBrowserEnabled === true ? "available"
      : input.engineBrowserEnabled === false ? "unavailable" : "unknown";
  const policy = outsideProviderPolicy({ agentlas });
  const candidates: string[] = [
    CLAUDE_OWNER_CHROME_PATTERN,
    ...(policy === "agentlas-only" ? BROWSER.claudeToolPatterns : []),
  ];
  const patterns = candidates.filter((pattern) => !probes.some((probe) => globMatches(pattern, probe)));
  if (hostBound) patterns.push(ENGINE_BROWSER_DUPLICATE);
  return {
    args: ["--no-chrome", ...(patterns.length > 0 ? ["--disallowedTools", patterns.join(",")] : [])],
    pluginBrowserNeeded: agentlas === "available",
    receipt: `[claude-surface] browser_surface=${policy === "agentlas-only" ? "closed" : "fallback"} agentlas_browser=${agentlas} patterns=${patterns.length} host_browser=${hostBound ? "bound" : "-"}`,
  };
}

function readJson(file: string): unknown {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function declaresAgentlasBrowser(installPath: string): boolean {
  const names = new Set(BROWSER.agentlasServerNames);
  for (const file of [path.join(installPath, ".mcp.json"), path.join(installPath, ".claude-plugin", "plugin.json")]) {
    const json = readJson(file);
    if (!json || typeof json !== "object") continue;
    const record = json as Record<string, unknown>;
    const servers = record.mcpServers && typeof record.mcpServers === "object"
      ? record.mcpServers as Record<string, unknown>
      : record;
    if (Object.keys(servers).some((name) => names.has(name))) return true;
  }
  return false;
}

let engineCache: { key: string; at: number; value: boolean } | null = null;
const ENGINE_CACHE_MS = 5_000;

/**
 * Whether Claude Code, spawned with this HOME/cwd, loads a plugin that ships
 * the Agentlas browser. Reads only the `enabledPlugins` key of the user and
 * project settings layers (later layers win) and each enabled plugin's MCP
 * server names; values are never returned or logged.
 */
export function claudeEngineBrowserEnabled(input: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): boolean {
  const env = input.env ?? process.env;
  const home = env.HOME || os.homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const cwd = input.cwd ? path.resolve(input.cwd) : null;
  const key = `${configDir}\u0000${cwd ?? ""}`;
  const now = Date.now();
  if (engineCache && engineCache.key === key && now - engineCache.at < ENGINE_CACHE_MS) return engineCache.value;
  const enabled = new Map<string, boolean>();
  const layers = [path.join(configDir, "settings.json")];
  if (cwd) layers.push(path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"));
  for (const file of layers) {
    const json = readJson(file) as { enabledPlugins?: unknown } | null;
    const plugins = json?.enabledPlugins;
    if (!plugins || typeof plugins !== "object") continue;
    for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) enabled.set(id, value === true);
  }
  const installed = readJson(path.join(configDir, "plugins", "installed_plugins.json")) as { plugins?: Record<string, unknown> } | null;
  let value = false;
  for (const [id, on] of enabled) {
    if (!on) continue;
    const entries = installed?.plugins?.[id];
    if (!Array.isArray(entries)) continue;
    if (entries.some((entry) => typeof entry?.installPath === "string" && declaresAgentlasBrowser(entry.installPath))) {
      value = true;
      break;
    }
  }
  engineCache = { key, at: now, value };
  return value;
}
