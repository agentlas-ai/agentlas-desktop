// The main window remembers the last product screen it showed and reopens it on the next launch
// (shared/restorable-route.ts). Stored in the local meta table; a missing or unreadable value opens Work home.
import { getMeta, setMeta } from "./store/meta";
import { mainWindowRouteFromUrl, restorableProductRoute } from "../shared/restorable-route";

const META_KEY = "main_window.last_route";
let lastWritten: string | null = null;

/** Called for every main-frame navigation of the main window (full loads and client-side route changes). */
export function rememberMainWindowUrl(url: string, developmentStartUrl?: string | null): void {
  const route = mainWindowRouteFromUrl(url, developmentStartUrl);
  if (!route || route === lastWritten) return;
  try {
    setMeta(META_KEY, route);
    lastWritten = route;
  } catch {
    // The store may be closing during quit; the previous value stays.
  }
}

/** The remembered product screen, or null (first launch, unreadable store, or a value that is no longer restorable). */
export function rememberedMainWindowRoute(): string | null {
  try {
    const value = restorableProductRoute(getMeta(META_KEY));
    lastWritten = value;
    return value;
  } catch {
    return null;
  }
}
