/*
 * (contract home-move-phone-card §7 R8): the one place where this computer asks for the pointer without a signal.
 * A computer that asked to become the home from ANOTHER computer waits for the answer of a person on another device (the old computer's confirmation window, the phone's [It was me] / [It was not me]).
 * Nothing tells this computer that answer: the server has no way to reach it. So, only while all of the following hold, one pointer read + one pass is made on a short chain of one-shot timers:
 *   (a) this computer is the receiver of a move from a computer, (b) the pointer's request is this computer's and has not expired, (c) the step waits for the other device (`waiting_sender` / `waiting_redeposit` at `fetched`).
 * It ends when any of them stops holding (an answer came, the request was refused / cancelled / expired, another step began), at a sign-out or account change, and at app exit (the timer is `unref`).
 * Plain module, no Electron import. The constants are the contract's values (R8); a gate asserts them.
 */
/** The first two minutes after the wait began: a phone card shows 3 to 10 seconds after the phone is looked at, and a person answers once, mostly within two minutes. */
export const RESPONSE_WAIT_FAST_MS = 3_000;
export const RESPONSE_WAIT_FAST_FOR_MS = 120_000;
/** After that, until the request's own end (30 minutes on the server): at most 112 reads. */
export const RESPONSE_WAIT_SLOW_MS = 15_000;
/** One last read this long after the request's `expiresAt`: the server says `expired` only on a read, and the deadline timer's read can be coalesced with the one before it. */
export const RESPONSE_WAIT_GRACE_MS = 5_000;

export interface ResponseWait { /** When the move began waiting with the current code. */ sinceMs: number; /** The request's own end (ms). */ expiresAt: number }

/** The wait until the next read, or null when there is nothing to wait for (never a read without a request). */
export function responseWaitDelay(wait: ResponseWait | null, now: number): number | null {
  if (!wait) return null;
  const interval = now - wait.sinceMs < RESPONSE_WAIT_FAST_FOR_MS ? RESPONSE_WAIT_FAST_MS : RESPONSE_WAIT_SLOW_MS;
  const end = wait.expiresAt + RESPONSE_WAIT_GRACE_MS;
  if (now >= end) return null;
  // the last read is aimed at 1.5 s after `expiresAt` (the server counts the request as over by then); a longer interval never skips it
  const last = wait.expiresAt + 1_500;
  return Math.max(1, Math.min(interval, now < last ? last - now : end - now));
}

/** An awaited delay (not a standing timer): the gap between the pointer reads that follow a decision whose answer never came (home.ts `settledByPointer`). */
export const sleepMs = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
