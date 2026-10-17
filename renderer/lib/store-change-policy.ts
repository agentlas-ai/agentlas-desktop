/**
 * How a screen answers Main's `store:changed {entity,id}` notices without re-reading on every one of them
 * (perf review 2026-10-17). The viewed entity refreshes at once; everything else refreshes at most once per window;
 * no notice is dropped; unchanged content does not re-render. Pure: timers and clocks are injectable for tests.
 */

export interface StoreChangeNotice { entity: string; id?: string; projectId?: string | null }

type TimerHandle = ReturnType<typeof setTimeout>;

export interface StoreChangeThrottleOptions {
  /** This notice concerns what the screen shows: run now. */
  immediate: (change: StoreChangeNotice) => boolean;
  /** Every other notice runs at most once per this window (leading and trailing). */
  throttleMs: number;
  run: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/** Leading-and-trailing throttle for background notices; a notice about the shown entity runs synchronously. */
export function createStoreChangeThrottle(options: StoreChangeThrottleOptions): { notify(change: StoreChangeNotice): void; dispose(): void } {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle));
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let timer: TimerHandle | null = null;
  let disposed = false;
  const fire = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    lastRunAt = now();
    options.run();
  };
  return {
    notify(change) {
      if (disposed) return;
      // A run reads everything afresh, so it also answers any background notice still waiting.
      if (options.immediate(change)) { fire(); return; }
      if (timer !== null) return;
      const wait = lastRunAt + options.throttleMs - now();
      if (wait <= 0) { fire(); return; }
      timer = setTimer(() => { timer = null; if (!disposed) fire(); }, wait);
    },
    dispose() {
      disposed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
    },
  };
}

/** Two snapshots carry the same content once the named top-level keys (e.g. a read timestamp) are ignored. */
export function sameSnapshotIgnoring<T extends object>(previous: T | null | undefined, next: T, keys: readonly string[]): boolean {
  if (!previous) return false;
  if (previous === next) return true;
  const ignored = new Set(keys);
  try {
    return JSON.stringify(stripTopLevel(previous, ignored)) === JSON.stringify(stripTopLevel(next, ignored));
  } catch {
    return false;
  }
}

function stripTopLevel(value: object, ignored: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (!ignored.has(key)) out[key] = entry;
  return out;
}

/**
 * Two message lists show the same thing: same length, and each row has the same id and the same content. Exact
 * (a mid-list edit is caught), and cheap next to re-rendering every row.
 */
export function sameMessageList<T extends { id: string; text?: string }>(previous: readonly T[], next: readonly T[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index++) {
    const a = previous[index], b = next[index];
    if (a === b) continue;
    if (a.id !== b.id || a.text !== b.text) return false;
    try { if (JSON.stringify(a) !== JSON.stringify(b)) return false; } catch { return false; }
  }
  return true;
}

/** Whether a per-key action may run now: never run for this key, or its window has passed. Records the run. */
export function shouldRunPerKey(lastRunAt: Map<string, number>, key: string, now: number, windowMs: number): boolean {
  const last = lastRunAt.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  lastRunAt.set(key, now);
  if (lastRunAt.size > 64) lastRunAt.delete(lastRunAt.keys().next().value as string);
  return true;
}

/**
 * Leading-and-trailing throttle per key: the first request runs at once, later ones inside the window collapse into
 * one run at the window's end, so the last request is never lost.
 */
export function createKeyedThrottle(options: {
  windowMs: number;
  run: (key: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}): { request(key: string): void; dispose(): void } {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle));
  const lastRunAt = new Map<string, number>();
  const trailing = new Map<string, TimerHandle>();
  let disposed = false;
  const request = (key: string): void => {
    if (disposed || trailing.has(key)) return;
    if (shouldRunPerKey(lastRunAt, key, now(), options.windowMs)) { options.run(key); return; }
    const wait = (lastRunAt.get(key) ?? now()) + options.windowMs - now();
    trailing.set(key, setTimer(() => { trailing.delete(key); if (!disposed) request(key); }, Math.max(0, wait)));
  };
  return {
    request,
    dispose() { disposed = true; for (const handle of trailing.values()) clearTimer(handle); trailing.clear(); },
  };
}

/**
 * Read-when-dirty with a safety age: shouldRead() answers true after mark() or once maxAgeMs passed since the last
 * read, and records that a read starts (so a mark during the read asks again on the next tick).
 */
export function createDirtyGate(options: { maxAgeMs: number; now?: () => number }): { mark(): void; shouldRead(): boolean } {
  const now = options.now ?? Date.now;
  let dirty = false;
  let lastReadAt = now();
  return {
    mark() { dirty = true; },
    shouldRead() {
      const at = now();
      if (!dirty && at - lastReadAt < options.maxAgeMs) return false;
      dirty = false;
      lastReadAt = at;
      return true;
    },
  };
}

const NO_TURN_IDS: readonly string[] = Object.freeze([]);
const turnIdLists = new Map<string, readonly string[]>();
/**
 * The same one-element array for the same turn id on every render, so a memoized consumer that takes `turnIds`
 * does not re-render because a fresh `[id]` literal arrived. Bounded: the oldest ids are forgotten.
 */
export function stableTurnIds(turnId: string | null | undefined): readonly string[] {
  if (!turnId) return NO_TURN_IDS;
  let list = turnIdLists.get(turnId);
  if (!list) {
    list = Object.freeze([turnId]);
    turnIdLists.set(turnId, list);
    if (turnIdLists.size > 512) turnIdLists.delete(turnIdLists.keys().next().value as string);
  }
  return list;
}

/**
 * Trailing debounce with a ceiling: run waitMs after the last call, and never later than maxWaitMs after the first
 * call of a burst, so a steady stream of notices still converges. cancel() drops a pending run (effect cleanup).
 */
export function createTrailingDebounce(options: {
  waitMs: number;
  maxWaitMs?: number;
  run: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}): { call(): void; cancel(): void } {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle));
  const maxWaitMs = options.maxWaitMs ?? Number.POSITIVE_INFINITY;
  let timer: TimerHandle | null = null;
  let burstStartedAt: number | null = null;
  const fire = () => { timer = null; burstStartedAt = null; options.run(); };
  return {
    call() {
      const at = now();
      if (burstStartedAt === null) burstStartedAt = at;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(fire, Math.max(0, Math.min(options.waitMs, burstStartedAt + maxWaitMs - at)));
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      burstStartedAt = null;
    },
  };
}
