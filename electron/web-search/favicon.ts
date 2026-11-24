// A source's site icon for the "Sources" button, fetched by Main from the contract's icon address (shared/web-search/web-search.json
// `favicon`). The icon service answers a site it does not know with HTTP 404 AND a grey placeholder picture; an <img> in the
// renderer cannot see that status (the service sends no CORS header) and draws the placeholder. Main reads the status: only a
// 200 image becomes a data: address, anything else is null and the renderer draws the site's first letter, as the phone does
// (Flutter's network image fails on a non-200). Electron-free.
import { WEB_SEARCH_CONTRACT } from "./contract";

// basis: an icon is a few hundred bytes to ~15 KB (measured: 1-15 KB); 64 KB keeps a mis-served page out. At the limit: letter.
const ICON_MAX_BYTES = 64 * 1024;
// basis: the button is drawn after the answer; a slow icon must not hold it. At the limit: letter (the next window asks again).
const ICON_TIMEOUT_MS = 5000;
// basis: one entry per site shown this session; a few hundred sites is far past a day's answers. At the limit: the oldest is dropped.
const CACHE_MAX = 512;

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const cache = new Map<string, Promise<string | null>>();

/** The site icon of `host` as a data: address, or null (unknown site, not an image, too large, slow, offline). */
export function webSourceFavicon(host: unknown, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (typeof host !== "string" || !HOST.test(host)) return Promise.resolve(null);
  const key = host.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = (async () => {
    try {
      const response = await fetchImpl(WEB_SEARCH_CONTRACT.favicon.replace("{host}", key), { redirect: "follow", signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (response.status !== 200 || !type.startsWith("image/")) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > ICON_MAX_BYTES) return null;
      return `data:${type};base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  })();
  cache.set(key, pending);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return pending;
}
