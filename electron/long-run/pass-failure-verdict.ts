import type { RunnerFailure } from "../runtime/runner";

/**
 * What a failed continuation pass means for the goal that is driving it.
 *
 * A goal-driven run used to end the moment any pass failed: the loop threw, nothing scheduled a
 * successor, and the person saw a multi-hour goal die on a transient hiccup. Measured against a real
 * long-running orchestration on this machine (189 turns over 25.9 hours), four turns failed —
 * a model at capacity, two unsupported-parameter errors, and a usage limit — and the work continued
 * past every one of them. Surviving a failed turn is not a nicety; it is the difference between a
 * run that lasts an hour and one that lasts a day.
 *
 * The decision is made from the typed failure marker, never from the wording of the notice, because
 * vendor wording changes on every release and a run must not start dying because a sentence moved.
 */
export type PassFailureAction =
  /** Try the same pass again after a wait. The goal stays running. */
  | "retry"
  /** Stop working now but keep the goal alive and resumable, with a reason the person can act on. */
  | "pause"
  /** The goal cannot proceed on its own; a person has to change something. */
  | "block";

export interface PassFailureVerdict {
  action: PassFailureAction;
  /** Machine reason. The UI maps this to words; nothing downstream parses prose. */
  reason: "usage_limited" | "transient" | "unsupported" | "unauthorized" | "refused" | "unknown";
  /** Milliseconds to wait before the next attempt when `action` is "retry". */
  retryAfterMs: number;
  /** Verbatim runtime hint (reset time, and so on) when the runtime supplied one. */
  retryAfterHint?: string;
}

/** Backoff for transient failures: 30s, 2m, 8m. Bounded, and never zero. */
export function transientRetryDelayMs(attempt: number): number {
  const step = Math.max(1, Math.min(3, attempt));
  return [30_000, 120_000, 480_000][step - 1]!;
}

export const MAX_TRANSIENT_RETRIES = 3;

/** Stop/steering must interrupt even the longest retry backoff immediately. */
export function waitForPassRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function passFailureVerdict(
  failure: Pick<RunnerFailure, "kind" | "retryAfterHint">,
  transientAttemptsSoFar: number,
): PassFailureVerdict {
  const hint = failure.retryAfterHint ? { retryAfterHint: failure.retryAfterHint } : {};
  switch (failure.kind) {
    case "quota":
      /*
       * A usage limit is a wait, not an ending. It resolves on the vendor's clock, so the goal parks
       * with the runtime's own reset hint preserved verbatim rather than a number we invented.
       */
      return { action: "pause", reason: "usage_limited", retryAfterMs: 0, ...hint };
    case "auth":
      return { action: "block", reason: "unauthorized", retryAfterMs: 0, ...hint };
    case "refused":
      // The runtime will refuse this same request every time; waiting changes nothing.
      return { action: "block", reason: "refused", retryAfterMs: 0, ...hint };
    case "unsupported":
      /*
       * A rejected parameter is permanent for this request shape but says nothing about the goal.
       * Codex logged two of these mid-run and kept going, so this pauses rather than blocks.
       */
      return { action: "pause", reason: "unsupported", retryAfterMs: 0, ...hint };
    case "timeout":
    case "unavailable":
    case "empty":
    case "exit":
      // Capacity, network, a truncated stream: the same request often succeeds shortly after.
      return transientAttemptsSoFar < MAX_TRANSIENT_RETRIES
        ? {
          action: "retry",
          reason: "transient",
          retryAfterMs: transientRetryDelayMs(transientAttemptsSoFar + 1),
          ...hint,
        }
        : { action: "pause", reason: "transient", retryAfterMs: 0, ...hint };
    default:
      return { action: "pause", reason: "unknown", retryAfterMs: 0, ...hint };
  }
}
