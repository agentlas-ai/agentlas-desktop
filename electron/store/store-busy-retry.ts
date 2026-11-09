/**
 * Bounded re-run of one store operation that the local SQLite store refused because another connection held its lock
 * (`store_busy`, shared/turn-settlement.ts STORE_BUSY_CODE).
 *
 * Why it exists: the model has already answered when the host writes the turn's own bookkeeping (the answer's row, its Goal
 * binding, the terminal receipt). A lock that is gone a few milliseconds later used to end that turn as a failed run
 * ("The Agentlas store was locked by another write, so this turn could not be fully recorded", production and
 * 2026-10-27) although the answer was complete. The failing statement is not the model turn, so it is the statement that
 * runs again, never the turn.
 *
 * What may be passed in: an operation that is safe to run again because a refused attempt left nothing behind (a single
 * statement, or one transaction that SQLite rolled back) or that reads before it writes. What may not: anything that talks to
 * a model, a process or the network.
 *
 * Bounds (the whole cost of the rule): at most DEFAULT_DELAYS_MS.length re-runs (3), waiting 40, 120 and 360 ms between
 * attempts (520 ms in all, on top of the attempts themselves); no re-run after an attempt that itself took SLOW_ATTEMPT_MS
 * or more (that attempt already waited out the store's busy timeout, so the lock is not a passing one and a re-run would
 * stall Main for another full timeout); no re-run inside an open transaction (the outer transaction would be the one to retry).
 * Any other error, and the last store_busy, are rethrown unchanged.
 */
import { STORE_BUSY_CODE, typedCodeChain } from "../../shared/turn-settlement";
import { getDb } from "./db";

export const STORE_BUSY_RETRY_DELAYS_MS: readonly number[] = [40, 120, 360];
export const STORE_BUSY_SLOW_ATTEMPT_MS = 1_000;

/** A store lock refusal anywhere in the error's cause chain (typed driver codes only, never the message). */
export function isStoreBusyError(error: unknown): boolean {
  return typedCodeChain(error).includes(STORE_BUSY_CODE);
}

function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function insideTransaction(): boolean {
  try { return getDb().inTransaction === true; } catch { return false; }
}

export interface StoreBusyRetryOptions {
  delaysMs?: readonly number[];
  slowAttemptMs?: number;
  /** Test seam: replaces the blocking wait. */
  sleep?: (milliseconds: number) => void;
  /** Called before each re-run with the 1-based re-run number. */
  onRetry?: (retry: number, error: unknown) => void;
  /** Test seam: replaces the open-transaction check. */
  inTransaction?: () => boolean;
  now?: () => number;
}

export function runWithStoreBusyRetry<T>(operation: () => T, options: StoreBusyRetryOptions = {}): T {
  const delays = options.delaysMs ?? STORE_BUSY_RETRY_DELAYS_MS;
  const slowAfter = options.slowAttemptMs ?? STORE_BUSY_SLOW_ATTEMPT_MS;
  const sleep = options.sleep ?? sleepSynchronously;
  const now = options.now ?? Date.now;
  for (let attempt = 0; ; attempt += 1) {
    const startedAt = now();
    try {
      return operation();
    } catch (error) {
      const retry = attempt < delays.length
        && isStoreBusyError(error)
        && now() - startedAt < slowAfter
        && !(options.inTransaction ?? insideTransaction)();
      if (!retry) throw error;
      options.onRetry?.(attempt + 1, error);
      sleep(delays[attempt]!);
    }
  }
}

export const STORE_BUSY_PATIENCE_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000];

export interface StoreBusyPatienceOptions {
  delaysMs?: readonly number[];
  /** Test seam: replaces the timer wait (the wait never blocks Main). */
  wait?: (milliseconds: number) => Promise<void>;
  onRetry?: (retry: number, error: unknown) => void;
  /** Test seam: replaces the open-transaction check. */
  inTransaction?: () => boolean;
}

/**
 * The same rule as runWithStoreBusyRetry for the ONE write whose content exists only in memory and has to land: the turn's answer. The turn
 * already ran, so a store that stayed locked past its whole busy wait (the first attempt) must not turn a finished answer into a failed run
 * ("this turn could not be fully recorded", production and). The write runs again after 1 s, 3 s and 8 s, the waits
 * between attempts yield to the event loop (Main is not blocked while it waits), and the answer is held by the caller the whole time. Only a
 * store lock is retried, never inside an open transaction; any other error, and the last lock, are rethrown unchanged.
 */
export async function runWithStoreBusyPatience<T>(operation: () => T | Promise<T>, options: StoreBusyPatienceOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? STORE_BUSY_PATIENCE_DELAYS_MS;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => { const id = setTimeout(resolve, milliseconds); (id as { unref?: () => void }).unref?.(); }));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delays.length || !isStoreBusyError(error) || (options.inTransaction ?? insideTransaction)()) throw error;
      options.onRetry?.(attempt + 1, error);
      await wait(delays[attempt]!);
    }
  }
}
