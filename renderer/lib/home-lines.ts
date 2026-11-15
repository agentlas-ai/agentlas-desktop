import { useSyncExternalStore } from "react";
import { HOME_TREE_ID_LIMIT, type HomeLine, type HomeTreeRow } from "@shared/home-tree";
import { homeBridge } from "./home-tree";

/*
 * What the Workspace menu's visible rows draw beyond a `home:tree` row: a preview, faces, a runner name. The rows
 * stay light; this is asked for ONLY the rows in view, once per row state, and nothing is polled:
 *   - a row is read when it becomes visible, and again only when its fingerprint changes (last line time, member count, member
 *     names) - the same fingerprint is never read twice;
 *   - requests made in the same moment share one `home:lines` call (120 ms), one call at a time, at most HOME_TREE_ID_LIMIT ids;
 *   - the cache is capped (CACHE_LIMIT, oldest dropped first), so a 600-room list never keeps 600 previews.
 * A window whose preload has no `lines` channel (an older build) simply never gets previews: rows draw from their title.
 */
const FLUSH_MS = 120;
const CACHE_LIMIT = 400;

interface Entry { fingerprint: string; line: HomeLine | null }
const cache = new Map<string, Entry>();
const pending = new Map<string, string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
/** How many `home:lines` calls this window made - read by the gates, never by the app. */
let calls = 0;

export const homeLinesCallCount = (): number => calls;
export function resetHomeLinesForTest(): void { cache.clear(); pending.clear(); calls = 0; inFlight = false; if (timer) clearTimeout(timer); timer = null; }

/** What makes a row's line stale: the time of its last visible line, how many members it has, and who they are. */
export function lineFingerprint(row: Pick<HomeTreeRow, "updatedAt" | "memberCount" | "agentNames">): string {
  return `${row.updatedAt}|${row.memberCount}|${row.agentNames.join(",")}`;
}

const notify = () => { for (const listener of [...listeners]) listener(); };

function schedule(): void {
  if (timer || inFlight || pending.size === 0) return;
  timer = setTimeout(() => { timer = null; void flush(); }, FLUSH_MS);
}

async function flush(): Promise<void> {
  const bridge = homeBridge();
  const read = bridge?.lines;
  if (!read) { pending.clear(); return; }
  if (inFlight || pending.size === 0) return;
  const batch = [...pending].slice(0, HOME_TREE_ID_LIMIT);
  for (const [id] of batch) pending.delete(id);
  inFlight = true; calls += 1;
  try {
    const lines = await read(batch.map(([id]) => id));
    const byId = new Map(lines.map((line) => [line.id, line]));
    for (const [id, fingerprint] of batch) {
      // Re-insert so the oldest entries are the ones dropped when the cache is full.
      cache.delete(id);
      cache.set(id, { fingerprint, line: byId.get(id) ?? null });
    }
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    notify();
  } catch { /* the rows keep drawing from their titles; the next change of what is visible asks again */ }
  finally { inFlight = false; schedule(); }
}

/** Ask for the lines of rows that are on screen. Rows whose fingerprint is already cached (or already asked) cost nothing. */
export function requestHomeLines(rows: ReadonlyArray<Pick<HomeTreeRow, "id" | "updatedAt" | "memberCount" | "agentNames">>): void {
  if (!homeBridge()?.lines) return;
  let added = false;
  for (const row of rows) {
    const fingerprint = lineFingerprint(row);
    if (cache.get(row.id)?.fingerprint === fingerprint || pending.get(row.id) === fingerprint) continue;
    pending.set(row.id, fingerprint); added = true;
  }
  if (added) schedule();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The cached line of one row (null while it has not been read, or when the read had nothing for it). */
export function useHomeLine(id: string): HomeLine | null {
  return useSyncExternalStore(subscribe, () => cache.get(id)?.line ?? null, () => null);
}
