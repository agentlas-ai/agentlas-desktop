/** A browser tool is replay-safe only when its arguments prove observation. */
export function isReadOnlyGraphBrowserObservation(name: string, rawArgs: unknown): boolean {
  if (!name.startsWith("mcp__agentlas-browser__browser_") || typeof rawArgs !== "string") return false;
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
      return url.protocol === "https:" &&
        (url.hostname === "www.threads.net" || url.hostname === "www.threads.com") &&
        !url.username && !url.password && !url.search && !url.hash &&
        (/^\/@[A-Za-z0-9._]+\/?$/.test(url.pathname) ||
          /^\/activity(?:\/replies)?\/?$/.test(url.pathname));
    } catch { return false; }
  }
  return false;
}
