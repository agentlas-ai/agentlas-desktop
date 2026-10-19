













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
