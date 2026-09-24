/**
 * Claude Code's own browser surfaces — kept off every Agentlas run.
 *
 * Owner question (2026-09-24): "당근 내장브라우저에서 하겠지? 자꾸 외부크롬 켜지는거 같아서".
 * Every Agentlas run already has an owned browser (the in-app guest for a watched
 * chat, the dedicated Chrome for Testing profile otherwise). Claude Code, spawned
 * with the owner's HOME and without --strict-mcp-config (native tools are kept on
 * purpose), also loads the owner's own browser surfaces:
 *
 * Measured on claude 2.1.281 via the `system/init` event of `claude -p`:
 *   - the user plugin `playwright@claude-plugins-official` adds 25 tools
 *     (`mcp__plugin_playwright_playwright__*`); `@playwright/mcp` launches the
 *     installed Google Chrome channel — an external window with another login.
 *   - Claude in Chrome (`mcp__claude-in-chrome__*`, drives the owner's real
 *     Chrome) is off in `-p` today even with `claudeInChromeDefaultEnabled`, and
 *     `--chrome` turns it on (22 tools). `--no-chrome` pins it off so a CLI
 *     default change cannot silently open it (codex did exactly that with plugins).
 *   - `--disallowedTools "mcp__*playwright*"` removes every Playwright tool;
 *     `mcp__<server>` removes a whole server; wildcards match the server part too.
 *     A deny also beats `--allowedTools`, so a pattern that would match one of
 *     Main's own bound servers is dropped instead of emitted.
 *   - the engine plugin's `agentlas-browser` (`mcp__plugin_hephaestus_agentlas-browser`)
 *     is a headless duplicate of the Agentlas browser on the same profile/port; it
 *     is closed only when Main bound its own `agentlas-browser` for this run. It is
 *     matched as `mcp__plugin_*_agentlas-browser__*`: a mid-name wildcard without
 *     the trailing `__*` matches nothing.
 *   - with `--chrome` forced, `mcp__claude-in-chrome` in the deny list still removes
 *     all of its tools (init: chrome 0).
 *
 * Only an explicit Computer Use grant keeps these surfaces.
 */

export interface ClaudeBrowserSurfaceInput {
  desktopControlGrant?: boolean;
  /** The no-tools path already passes --no-chrome and --tools "". */
  untrustedNoTools?: boolean;
  /** Main's exact MCP allow list (`mcp__<key>`, `mcp__<key>__*`). */
  hostAllowedTools?: readonly string[];
}

export interface ClaudeBrowserSurfaceDecision {
  args: string[];
  /** Machine-readable receipt, or null when this run keeps the surfaces. */
  receipt: string | null;
}

/** User-level browser-automation servers, matched by tool-name pattern. */
export const CLAUDE_FOREIGN_BROWSER_TOOL_PATTERNS = [
  "mcp__claude-in-chrome",
  "mcp__*playwright*",
  "mcp__*chrome-devtools*",
  "mcp__*puppeteer*",
  "mcp__*browsermcp*",
  "mcp__*browser-use*",
] as const;

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
  if (input.desktopControlGrant || input.untrustedNoTools) return { args: [], receipt: null };
  const keys = hostServerKeys(input.hostAllowedTools ?? []);
  const probes = keys.map((key) => `mcp__${key}__probe`);
  const patterns: string[] = CLAUDE_FOREIGN_BROWSER_TOOL_PATTERNS.filter((pattern) =>
    !probes.some((probe) => globMatches(pattern, probe)));
  if (keys.includes("agentlas-browser")) patterns.push(ENGINE_BROWSER_DUPLICATE);
  return {
    args: ["--no-chrome", ...(patterns.length > 0 ? ["--disallowedTools", patterns.join(",")] : [])],
    receipt: `[claude-surface] browser_surface=closed patterns=${patterns.length} host_browser=${keys.includes("agentlas-browser") ? "bound" : "-"}`,
  };
}
