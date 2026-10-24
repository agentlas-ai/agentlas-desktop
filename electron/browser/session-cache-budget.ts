import { app, session } from "electron";

/**
 * Cache ceiling for every Electron session, including the in-app browser
 * partition (persist:agentlas-browser-default). That partition's HTTP cache
 * reached 1.24 GB on 2026-10-16 with no ceiling. Cookies, Local Storage,
 * IndexedDB and sign-ins are not cache and are never touched here.
 */
export const APP_BROWSER_CACHE_BYTES = 256 * 1024 * 1024;

/** Before app ready: Chromium evicts the HTTP cache above this size. */
export function capAppBrowserCache(): void {
  app.commandLine.appendSwitch("disk-cache-size", String(APP_BROWSER_CACHE_BYTES));
}

/**
 * After app ready: a cache that grew before the ceiling existed is cleared once
 * it is over twice the ceiling. Eviction alone would shrink it only as new
 * entries arrive. Failures are ignored; this never blocks startup.
 */
export async function trimOversizedSessionCaches(partitions: readonly string[]): Promise<void> {
  for (const partition of partitions) {
    try {
      const target = session.fromPartition(partition);
      if (await target.getCacheSize() <= 2 * APP_BROWSER_CACHE_BYTES) continue;
      await target.clearCache();
      await target.clearCodeCaches({});
    } catch {
      // A missing or busy partition is retried on the next start.
    }
  }
}
