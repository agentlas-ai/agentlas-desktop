import { APP_SCREEN_PAGES } from "./app-screen-routes.generated";
import { closestNames } from "./did-you-mean";

/**
 * Which screens app.navigate may open, and what it says about a path that is not a screen.
 *
 * The list of screens is generated from renderer/app (scripts/generate-app-screen-routes.cjs, checked by build:electron); nothing
 * here repeats it. The renderer calls any well-formed path "applied" and Next answers an unknown one with its not-found page, so
 * a model that guessed a path (/company for "the company dashboard") was told it had opened a screen and said so to the owner.
 * The guard is at the door of app.navigate; the renderer bridge is unchanged.
 */

/** Screens that exist and are accepted by name, but are not offered to the model as places to go (and are never suggested). */
const NOT_OFFERED: Readonly<Record<string, string>> = {
  "/": "the root document; Work home is /dashboard",
  "/business": "the organization console is the owner's own screen and the model's app-control catalog does not carry it",
  "/one-vault": "credential input has a window of its own",
  "/surface-preview": "internal preview page",
};

const SCREENS: ReadonlySet<string> = new Set(APP_SCREEN_PAGES);
const OFFERED: readonly string[] = APP_SCREEN_PAGES.filter((screen) => !Object.hasOwn(NOT_OFFERED, screen));
// The harness cuts a refusal at 600 characters (capability-ports.ts, app.call) and the error code leads it ("route-unknown: "), so the text
// has to fit what is left. Its parts: the path shown, the nearest screen, the full list of screens — which leaves a model nothing to invent
// (a list of top-level screens plus "sub-screens such as /library/agents" made it guess /settings/organization, /settings/admin, /site/org) —
// and one sentence for a request that has no screen. The nearest screen is the part that gives way when the text is too long.
const MESSAGE_BUDGET = 600 - "route-unknown: ".length;
const MAX_SHOWN_PATH = 24;
const MAX_CLOSEST = 1;
// Said last, where a model that cannot find what the owner asked for is about to pick a loosely related screen and report it under the asked name.
const NONE_FITS = "If none fits, tell the owner so.";

export type AppScreenVerdict =
  | { known: true; pathname: string; route: string }
  | { known: false; pathname: string; closest: readonly string[]; screens: readonly string[] };

/** The path part of a route, without its query, a trailing slash or `.html` (the static export serves both forms). */
export function appScreenPathname(route: string): string {
  const queryAt = route.indexOf("?");
  const path = queryAt < 0 ? route : route.slice(0, queryAt);
  return path.replace(/\.html$/, "").replace(/(.)\/+$/, "$1");
}

/** The nearest offered screen above a path that is not one: /settings for /settings/organizations. */
function offeredParent(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  for (let length = segments.length - 1; length >= 1; length--) {
    const parent = `/${segments.slice(0, length).join("/")}`;
    if (OFFERED.includes(parent)) return parent;
  }
  return null;
}

/**
 * Whether a route is a screen of the app. A query is not judged; a protocol-relative `//…` is never a screen. A screen asked for
 * as `/settings/` or `/settings.html` comes back in its own spelling (`route`), the one the renderer can confirm.
 */
export function resolveAppScreenRoute(route: string): AppScreenVerdict {
  const pathname = appScreenPathname(route);
  if (!route.startsWith("//") && SCREENS.has(pathname)) {
    const queryAt = route.indexOf("?");
    const query = queryAt < 0 ? "" : route.slice(queryAt);
    return { known: true, pathname, route: `${pathname}${query === "?" ? "" : query}` };
  }
  const parent = offeredParent(pathname);
  const closest = [...(parent ? [parent] : []), ...closestNames(pathname, OFFERED, MAX_CLOSEST).filter((name) => name !== parent)].slice(0, MAX_CLOSEST);
  return { known: false, pathname, closest, screens: OFFERED };
}

/** The refusal the model reads: what was not found, that nothing moved, the nearest screen, every screen there is, and what to do when none fits. */
export function unknownScreenMessage(verdict: Extract<AppScreenVerdict, { known: false }>): string {
  const shown = verdict.pathname.length > MAX_SHOWN_PATH ? `${verdict.pathname.slice(0, MAX_SHOWN_PATH)}…` : verdict.pathname;
  const compose = (closest: string) => `No screen at ${shown}, so nothing was opened.${closest} Screens: ${verdict.screens.join(", ")}. ${NONE_FITS}`;
  const full = compose(verdict.closest.length ? ` Closest: ${verdict.closest.join(", ")}.` : "");
  return full.length <= MESSAGE_BUDGET ? full : compose("");
}
