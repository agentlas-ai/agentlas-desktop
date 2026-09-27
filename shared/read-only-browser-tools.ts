/**
 * Pure classifier, moved out of electron/mcp-tools/proxy-server.ts (2026-09-27) so the
 * invocation effect-boundary reader can ask the same Main-owned question — "could this
 * browser call have changed the page, the profile or local files?" — without importing the
 * proxy server. proxy-server re-exports both names; behavior is unchanged.
 */
/*
 * ★Read-only observation browser profile — owner rule 2026-09-23: when an
 * external effect is uncertain the app must LOOK (open/refresh the page in the
 * persistent browser) instead of blocking.
 *
 * Plan mode forbids navigation; an observation must navigate and refresh. This
 * profile admits exactly the calls that load and read pages and denies every
 * argument shape that can change the page, the profile or local files:
 * click/type/fill/press/drag/drop/upload/select/hover/dialog, page JavaScript
 * (evaluate, run_code_unsafe, cua repl), skill replay/save, tab close and any
 * `filename` save overload. Main enforces it in the proxy before the arbiter, so
 * a durable "always allow" rule cannot turn a read run into a click.
 */
export const READ_ONLY_BROWSER_TOOLS = Object.freeze([
  "browser_tabs", "browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_take_screenshot",
  "browser_wait_for", "browser_console_messages", "browser_network_requests", "browser_network_request",
  "browser_find", "browser_skill_list",
] as const);

function readOnlyNavigableUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) return false;
  if (value.trim() === "about:blank") return true;
  try { return ["http:", "https:"].includes(new URL(value.trim()).protocol); } catch { return false; }
}

export function readOnlyBrowserToolIsMutating(input: { toolName: string; args?: unknown }): boolean {
  const args = input.args ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return true;
  const a = args as Record<string, unknown>;
  const keys = (...allowed: string[]) => Object.keys(a).every((key) => allowed.includes(key));
  const optional = (key: string, type: string) => a[key] === undefined || typeof a[key] === type;
  switch (input.toolName) {
    case "browser_tabs":
      if (!keys("action", "index", "url") || !optional("index", "number")) return true;
      if (a.action === undefined || a.action === null || a.action === "" || a.action === "list" || a.action === "select") return a.url !== undefined;
      return !(a.action === "new" && (a.url === undefined || readOnlyNavigableUrl(a.url)));
    case "browser_navigate": return !(keys("url") && readOnlyNavigableUrl(a.url));
    case "browser_navigate_back": return !keys();
    case "browser_snapshot": return !(keys("target", "depth", "boxes")
      && optional("target", "string") && optional("boxes", "boolean")
      && (a.depth === undefined || (Number.isSafeInteger(a.depth) && Number(a.depth) >= 0)));
    case "browser_take_screenshot": return !(keys("element", "target", "type", "fullPage", "scale")
      && optional("element", "string") && optional("target", "string") && optional("fullPage", "boolean")
      && (a.type === undefined || a.type === "png" || a.type === "jpeg"));
    case "browser_wait_for": return !(keys("time", "text", "textGone")
      && optional("time", "number") && optional("text", "string") && optional("textGone", "string"));
    case "browser_console_messages": return !(keys("level", "all") && optional("all", "boolean")
      && (a.level === undefined || ["error", "warning", "info", "debug"].includes(String(a.level))));
    case "browser_network_requests": return !(keys("static", "filter")
      && optional("static", "boolean") && optional("filter", "string"));
    case "browser_network_request": return !(keys("index", "part")
      && Number.isSafeInteger(a.index) && Number(a.index) > 0
      && (a.part === undefined || ["request-headers", "request-body", "response-headers", "response-body"].includes(String(a.part))));
    case "browser_find": return !(keys("text", "regex") && optional("text", "string") && optional("regex", "string"));
    case "browser_skill_list": return !keys();
    default: return true;
  }
}
