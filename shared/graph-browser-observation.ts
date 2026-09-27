const AGENTLAS_BROWSER_PREFIX = "mcp__agentlas-browser__browser_";
const CODEX_AGENTLAS_BROWSER = /^agentlas-browser\.(browser_[a-z_]+)$/;

/**
 * The bundled browser's tool name in the one spelling this classifier knows.
 *
 * Codex reports MCP tools as `<server>.<tool>` (`agentlas-browser.browser_snapshot`); Claude and
 * the other runtimes report `mcp__<server>__<tool>`. Measured 2026-09-27 on the owner's store:
 * 1,460 codex browser events and not one of them could ever be read as an observation, because
 * the check below only knew the `mcp__` spelling. An update restart that interrupted a Threads
 * automation step which had only taken snapshots therefore left it "may have acted outside" —
 * automation_ambiguous_side_effect, next run null, until a person reconciled it by hand.
 * The argument checks stay exactly as strict; only the name spelling is folded.
 */
export function canonicalAgentlasBrowserToolName(name: string): string {
  const codex = CODEX_AGENTLAS_BROWSER.exec(name);
  return codex ? `mcp__agentlas-browser__${codex[1]}` : name;
}

export function isAgentlasBrowserToolName(name: string): boolean {
  return canonicalAgentlasBrowserToolName(name).startsWith(AGENTLAS_BROWSER_PREFIX);
}

/** A browser tool is replay-safe only when its arguments prove observation. */
export function isReadOnlyGraphBrowserObservation(rawName: string, rawArgs: unknown): boolean {
  const name = canonicalAgentlasBrowserToolName(rawName);
  if (!name.startsWith(AGENTLAS_BROWSER_PREFIX) || typeof rawArgs !== "string") return false;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    args = parsed as Record<string, unknown>;
  } catch { return false; }
  const keysAre = (...allowed: string[]): boolean => Object.keys(args).every((key) => allowed.includes(key));
  if (name === "mcp__agentlas-browser__browser_tabs") {
    // The bundled browser normalizes an omitted action to list.
    return keysAre("action") && (args.action === undefined || args.action === "list");
  }
  if (name === "mcp__agentlas-browser__browser_snapshot") {
    return keysAre("target", "depth", "boxes")
      && (args.target === undefined || typeof args.target === "string")
      && (args.boxes === undefined || typeof args.boxes === "boolean")
      && (args.depth === undefined || (Number.isSafeInteger(args.depth) && Number(args.depth) >= 0));
  }
  if (name === "mcp__agentlas-browser__browser_find") {
    return keysAre("text") && typeof args.text === "string";
  }
  if (name === "mcp__agentlas-browser__browser_navigate") {
    if (!keysAre("url") || typeof args.url !== "string") return false;
    try {
      const url = new URL(args.url);
      // Profile tabs, a post permalink, and the activity tabs are page loads that only show.
      // Search, messages and insights stay out: they carry queries or read-state.
      return url.protocol === "https:" &&
        (url.hostname === "www.threads.net" || url.hostname === "www.threads.com") &&
        !url.username && !url.password && !url.search && !url.hash &&
        (/^\/@[A-Za-z0-9._]+(?:\/(?:replies|reposts|media))?\/?$/.test(url.pathname) ||
          /^\/@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ||
          /^\/activity(?:\/(?:replies|mentions|quotes|reposts|follows))?\/?$/.test(url.pathname));
    } catch { return false; }
  }
  return false;
}
