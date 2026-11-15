import fs from "node:fs";

/*
 * A recursive `fs.watch` whose watched root is deleted (desktop repair 6, Windows W3): on Windows the watcher can keep firing, about 130,000 events a second, without ever raising `error` - one CPU core
 * until it is closed (measured in the Windows VM run; macOS gives one event). The four recursive watchers (live document, trigger paths, build files, managed preview) share this guard: a callback calls
 * `event()` first. Nothing is read for an ordinary event: the root is looked at only when more than `burst` events arrive inside `windowMs`, and at most once per window; a root that is gone closes the watcher
 * (`close`) and `onGone` lets the owner re-make it by the road it already has (the next read, the reconnect/park rules). No timer, no storage; the only state is two numbers per watcher.
 */
export interface WatchGuardOptions {
  root: string;
  /** Closes the watcher. */
  close: () => void;
  /** Called once after `close` when the root is gone. */
  onGone?: () => void;
  burst?: number;
  windowMs?: number;
  exists?: (root: string) => boolean;
  now?: () => number;
}
export function createWatchGuard(options: WatchGuardOptions): { event(): boolean } {
  const burst = options.burst ?? 400, windowMs = options.windowMs ?? 1000;
  const exists = options.exists ?? ((root: string) => { try { fs.statSync(root); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR"; } });
  const now = options.now ?? Date.now;
  let windowStart = 0, count = 0, closed = false;
  return {
    /** True when this event found the root gone and the watcher was closed (the caller returns without handling the event). */
    event(): boolean {
      if (closed) return true;
      const at = now();
      if (at - windowStart > windowMs) { windowStart = at; count = 0; }
      count += 1;
      if (count !== burst + 1) return false;   // looked at once per window, on the event that crosses the limit
      if (exists(options.root)) return false;
      closed = true;
      try { options.close(); } catch { /* already closed */ }
      try { options.onGone?.(); } catch { /* the owner re-makes it on its own road */ }
      return true;
    },
  };
}
