// What a product Claude Code run inherits from the person's own ~/.claude (owner decision 2026-10-11, all users):
// nothing, except for One, and for One only the items the person switched on (capabilities/one-capabilities.ts).
//
// Product runs use a config-dir mirror for sessions (claude-product-home.ts: CLAUDE_CONFIG_DIR + an empty
// CLAUDE_SECURESTORAGE_CONFIG_DIR keeps the person's keychain sign-in). The mirror links the person's configuration,
// so which of it a run may use is still decided here, as a `--settings` overlay that wins over the user settings file:
//   - `claudeMdExcludes`   personal CLAUDE.md and rules/*.md that are switched off (was: always, 2026-10-06)
//   - `autoMemoryEnabled`  the project memory (projects/<cwd>/memory/MEMORY.md) only when that item is on
//   - `skillOverrides`     {name: "off"} for each switched-off personal skill / command
//   - `enabledPlugins`     {id: false} for each switched-off personal plugin
// Measured on claude 2.1.296 against a stand-in Messages endpoint (ANTHROPIC_BASE_URL): the memory block
// (8.8k tokens) and 152 personal skills leave the request; plugin tool schemas (46 tools) drop.
// Not enforceable from a settings overlay (listed, `applies:false`): user hooks (arrays merge; `disableAllHooks`
// would also kill the product's own tool-broker hook) and user-scope MCP servers in ~/.claude.json.
import path from "node:path";
import type { CapabilityItem, CapabilitySelection } from "../capabilities/one-capabilities";

function claudeItems(selection: CapabilitySelection | undefined, kind: CapabilityItem["kind"]): CapabilityItem[] {
  return (selection?.items ?? []).filter((item) => item.source === "claude" && item.kind === kind);
}

/** Claude Code names a project's config folder after its working directory: every non-alphanumeric becomes "-". */
export function claudeProjectKey(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

export interface ClaudePersonalOverlay {
  claudeMdExcludes: string[];
  autoMemoryEnabled: boolean;
  skillOverrides: Record<string, "off">;
  enabledPlugins: Record<string, false>;
}

export function claudePersonalOverlay(selection: CapabilitySelection | undefined, claudeDir: string, cwd: string): ClaudePersonalOverlay {
  const memories = claudeItems(selection, "memory");
  const excludes: string[] = [];
  for (const item of memories) {
    if (item.enabled) continue;
    if (item.path === path.join(claudeDir, "CLAUDE.md") || item.path.startsWith(path.join(claudeDir, "rules") + path.sep)) excludes.push(item.path);
  }
  // Rules added after the inventory was taken stay out too.
  if (!memories.some((item) => item.enabled && item.name.startsWith("rules/"))) excludes.push(path.join(claudeDir, "rules", "**", "*.md"));
  const projectMemory = path.join(claudeDir, "projects", claudeProjectKey(cwd), "memory", "MEMORY.md");
  const autoMemoryEnabled = memories.some((item) => item.enabled && (item.path === projectMemory || item.path === path.join(claudeDir, "projects")));
  const skillOverrides: Record<string, "off"> = {};
  for (const item of claudeItems(selection, "skill")) if (!item.enabled) skillOverrides[item.name.replace(/^\//, "")] = "off";
  const enabledPlugins: Record<string, false> = {};
  for (const item of claudeItems(selection, "plugin")) if (!item.enabled) enabledPlugins[item.name] = false;
  return { claudeMdExcludes: [...new Set(excludes)], autoMemoryEnabled, skillOverrides, enabledPlugins };
}

/** The product's `--settings` JSON with the personal overlay merged in. Existing keys of the same name are kept. */
export function withClaudePersonalContext(settings: string, selection: CapabilitySelection | undefined, claudeDir: string, cwd: string): string {
  const base = JSON.parse(settings) as Record<string, unknown>;
  const overlay = claudePersonalOverlay(selection, claudeDir, cwd);
  const existing = Array.isArray(base.claudeMdExcludes) ? base.claudeMdExcludes.filter((item): item is string => typeof item === "string") : [];
  const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  return JSON.stringify({
    ...base,
    claudeMdExcludes: [...new Set([...existing, ...overlay.claudeMdExcludes])],
    autoMemoryEnabled: overlay.autoMemoryEnabled,
    skillOverrides: { ...obj(base.skillOverrides), ...overlay.skillOverrides },
    enabledPlugins: { ...obj(base.enabledPlugins), ...overlay.enabledPlugins },
  });
}

export interface ClaudeMcpIsolation {
  /** Pass `--strict-mcp-config`: only the servers Main binds with `--mcp-config` load. */
  strict: boolean;
  /** When not strict: deny patterns (`mcp__<server>`) for the person's switched-off user-scope servers. */
  deny: string[];
  /** Machine-readable receipt. */
  receipt: string;
}

/**
 * The person's user-scope MCP servers (`~/.claude.json` mcpServers) cannot be switched off from a settings overlay,
 * and `enabledPlugins` only covers plugin servers. Measured on claude 2.1.296 (`system/init` of `claude -p`, stand-in
 * endpoint): without the flag 20 MCP servers / 149 MCP tools loaded (the person's `agentlas` and `lazyweb` plus every
 * plugin's); with `--strict-mcp-config` 0 servers / 0 MCP tools besides the `--mcp-config` ones. Strict also drops
 * plugin servers, so it is withheld in exactly two cases, and the user-scope servers are then denied by name:
 *   - One has a Claude connector or plugin switched on (its servers must load);
 *   - the only Agentlas browser the run can reach is the engine plugin's copy (claude-browser-surface.ts): the
 *     browser would otherwise be gone and the turn would dead-end.
 */
export function claudeMcpIsolation(selection: CapabilitySelection | undefined, hostAllowedTools: readonly string[], pluginBrowserNeeded: boolean): ClaudeMcpIsolation {
  const connectors = claudeItems(selection, "connector");
  const oneNeeds = claudeItems(selection, "connector").some((item) => item.enabled) || claudeItems(selection, "plugin").some((item) => item.enabled);
  const strict = !oneNeeds && !pluginBrowserNeeded;
  const hostKeys = new Set<string>();
  for (const tool of hostAllowedTools) { const m = /^mcp__(.+?)(?:__.*)?$/.exec(tool); if (m) hostKeys.add(m[1]); }
  const deny = strict ? [] : [...new Set(connectors.filter((item) => !item.enabled)
    .map((item) => item.name.replace(/[^A-Za-z0-9_-]/g, "_")).filter((name) => !hostKeys.has(name)).map((name) => `mcp__${name}`))];
  return { strict, deny, receipt: `[claude-mcp] strict=${strict ? "yes" : "no"} one=${selection?.isOne === true ? "yes" : "no"} plugin_browser=${pluginBrowserNeeded ? "yes" : "no"} denied=${deny.length}` };
}

/** Appends deny patterns to the single `--disallowedTools` value of an argument list (adds the flag when absent). */
export function withDisallowedTools(args: readonly string[], extra: readonly string[]): string[] {
  if (extra.length === 0) return [...args];
  const out = [...args];
  const at = out.indexOf("--disallowedTools");
  if (at >= 0 && at + 1 < out.length) out[at + 1] = `${out[at + 1]},${extra.join(",")}`;
  else out.push("--disallowedTools", extra.join(","));
  return out;
}
