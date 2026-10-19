/**







 */
const SAFE_ID = "[A-Za-z0-9._:%-]{1,200}";
const ONE_SCREEN = new RegExp(`^/one(?:\\?(?:personal=1|(?:task|chat|conversation)=${SAFE_ID}))?$`);
const WORK_CONVERSATION = new RegExp(`^/workspace/task\\?id=${SAFE_ID}$`);
const WORK_PAGES: ReadonlySet<string> = new Set([
  "/dashboard", "/automation", "/apps", "/cloud", "/library", "/library/agents", "/library/mcps", "/library/env",
  "/library/toolchains", "/local-models", "/marketplace", "/prompts", "/settings", "/workspace",
]);

export const MAIN_WINDOW_HOME_ROUTE = "/dashboard";

/** `path?query` of a product screen to reopen, or null when this is not a product screen. */
export function restorableProductRoute(pathAndQuery: unknown): string | null {
  if (typeof pathAndQuery !== "string" || !pathAndQuery.startsWith("/") || pathAndQuery.length > 2_048) return null;
  const queryAt = pathAndQuery.indexOf("?");
  const pathname = (queryAt < 0 ? pathAndQuery : pathAndQuery.slice(0, queryAt)).replace(/\.html$/, "").replace(/(.)\/+$/, "$1");
  const query = queryAt < 0 ? "" : pathAndQuery.slice(queryAt);
  const route = `${pathname}${query === "?" ? "" : query}`;
  if (pathname === "/one") return ONE_SCREEN.test(route) ? route : "/one";
  if (pathname === "/science" || pathname.startsWith("/science/")) return "/science";
  if (pathname === "/" || pathname === "/index") return MAIN_WINDOW_HOME_ROUTE;
  if (WORK_CONVERSATION.test(route)) return route;
  if (WORK_PAGES.has(pathname)) return pathname;
  // Other Work screens (a detail page, a builder) open Work home; windows of their own are not product screens.
  if (/^\/(?:automation|project|firm|build|browser|site|business|startup-founder-studio|apps|library|marketplace|workspace|chat)(?:\/|$)/.test(pathname)) {
    return MAIN_WINDOW_HOME_ROUTE;
  }
  return null;
}

/**
 * The main window's product route for a URL it navigated to: the packaged `agentlas://app/...` document, or the
 * development server origin. Placeholders (data:), foreign origins and non-product windows return null.
 */
export function mainWindowRouteFromUrl(url: string, developmentStartUrl?: string | null): string | null {
  let target: URL;
  try { target = new URL(url); } catch { return null; }
  const packaged = target.protocol === "agentlas:" && target.hostname === "app";
  let development = false;
  if (!packaged && developmentStartUrl) {
    try {
      const origin = new URL(developmentStartUrl);
      development = (origin.protocol === "http:" || origin.protocol === "https:") && origin.origin === target.origin;
    } catch { development = false; }
  }
  if (!packaged && !development) return null;
  return restorableProductRoute(`${target.pathname || "/"}${target.search}`);
}

/** The first screen of a new main window: an explicit route or a pending deep link wins over the remembered one. */
export function mainWindowInitialRoute(input: { requested?: string | null; deepLink?: string | null; remembered?: string | null }): string {
  return input.requested || input.deepLink || restorableProductRoute(input.remembered) || MAIN_WINDOW_HOME_ROUTE;
}
