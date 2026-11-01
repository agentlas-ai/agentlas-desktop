/**
 * Quiet retries for a read, or an idempotent write, that failed for a reason that clears by itself: a store that was busy for a moment,
 * a main process that was restarting, an IPC reply that was lost. The owner never sees these; they see the result.
 *
 * Rule: an internal cause must not show as failed, and anything idempotent is retried instead of being sent back to the
 * owner. A caller keeps its own honest message for the case where every attempt fails (the app really is gone), and bounds the attempts:
 * the schedule below is the whole budget (about 22 seconds for a read-back, about 4 seconds for a load).
 */

/** Waits before each further attempt, so the first try plus these many retries. */
export const QUIET_LOAD_DELAYS_MS: readonly number[] = [400, 1_200, 3_000];
export const QUIET_READBACK_DELAYS_MS: readonly number[] = [300, 900, 2_500, 6_000, 12_000];
export const QUIET_WRITE_DELAYS_MS: readonly number[] = [400, 1_200, 3_000];

const TRANSIENT_RE = /database is locked|SQLITE_BUSY|store_busy|\bEBUSY\b|ECONNRESET|No handler registered|Object has been destroyed|reply was lost|channel closed|timed out/i;

/** A failure that is the app's own momentary state, not a refusal: worth asking again. */
export function isTransientIpcError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return TRANSIENT_RE.test(text);
}

export interface QuietRetryOptions<T> {
  delaysMs?: readonly number[];
  /** Which failures are asked again. Default: every one (right for a read; pass `isTransientIpcError` for a write). */
  retryOn?: (error: unknown) => boolean;
  /** A result that is not good enough is asked for again (a read-back that came back empty). Default: any result is final. */
  accept?: (value: T) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Runs `attempt`, asking again on the schedule; the last failure (or the last unaccepted result as an error) is thrown. */
export async function retryQuietly<T>(attempt: () => Promise<T>, options: QuietRetryOptions<T> = {}): Promise<T> {
  const delays = options.delaysMs ?? QUIET_LOAD_DELAYS_MS;
  const sleep = options.sleep ?? realSleep;
  let last: unknown = new Error("quiet_retry_not_attempted");
  for (let index = 0; index <= delays.length; index += 1) {
    if (index > 0) await sleep(delays[index - 1]!);
    try {
      const value = await attempt();
      if (!options.accept || options.accept(value)) return value;
      last = new Error("quiet_retry_result_not_accepted");
    } catch (error) {
      last = error;
      if (options.retryOn && !options.retryOn(error)) throw error;
    }
  }
  throw last;
}
