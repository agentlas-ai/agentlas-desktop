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
