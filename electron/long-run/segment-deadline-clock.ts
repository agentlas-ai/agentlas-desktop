/**
 * The common budget clock (PLAN S7-4): one timer per key that fires a budget check when a segment's deadline arrives.
 *
 * Science's execution budget used to arm its own in-process timers inside its package; the host now holds them, so the one Goal
 * engine owns every clock a run has. A fire does not decide anything: it calls the check it was armed with (the port's
 * evaluateBudget), which re-reads the live budget. A timer that fires early (a coarse system timer, a deadline moved out by a
 * scheduling hold) re-arms for what is left instead of firing the check.
 */
export interface SegmentDeadlineClockDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** A failed check is reported, never thrown into the timer. */
  onError?: (key: string, error: unknown) => void;
}

/** setTimeout cannot wait longer than this (a larger delay fires at once); a later deadline is reached in steps. */
export const SEGMENT_CLOCK_MAX_DELAY_MS = 2_147_483_647;

export interface SegmentDeadlineClock {
  /** Arms (replacing any earlier arm of the same key) a check at `atMs`. */
  arm(key: string, atMs: number, fire: () => void): void;
  clear(key: string): boolean;
  clearAll(): void;
  /** When the key will fire, or null. */
  armedAt(key: string): number | null;
  size(): number;
}

export function createSegmentDeadlineClock(deps: SegmentDeadlineClockDeps = {}): SegmentDeadlineClock {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); (handle as { unref?: () => void }).unref?.(); return handle; });
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const entries = new Map<string, { atMs: number; handle: unknown; fire: () => void }>();

  function schedule(key: string, atMs: number, fire: () => void): void {
    const delay = Math.min(Math.max(1, atMs - now()), SEGMENT_CLOCK_MAX_DELAY_MS);
    const entry = { atMs, fire, handle: undefined as unknown };
    entry.handle = setTimer(() => {
      if (entries.get(key) !== entry) return;
      if (now() < atMs) { schedule(key, atMs, fire); return; }
      entries.delete(key);
      try { fire(); } catch (error) { try { deps.onError?.(key, error); } catch { /* a reporter that throws cannot break the clock */ } }
    }, delay);
    entries.set(key, entry);
  }

  return {
    arm(key, atMs, fire) {
      if (!Number.isFinite(atMs)) throw new Error("segment_clock_deadline_invalid");
      const prior = entries.get(key);
      if (prior) clearTimer(prior.handle);
      schedule(key, atMs, fire);
    },
    clear(key) {
      const prior = entries.get(key);
      if (!prior) return false;
      clearTimer(prior.handle);
      entries.delete(key);
      return true;
    },
    clearAll() { for (const entry of entries.values()) clearTimer(entry.handle); entries.clear(); },
    armedAt(key) { return entries.get(key)?.atMs ?? null; },
    size() { return entries.size; },
  };
}
