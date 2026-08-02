import type { InvocationRunReceipt } from "./types";

/**
 * One finishes what the user asked for. A run that stops short is One's own
 * problem to route around, not a status report to hand back — so the product
 * retries with a changed approach and only involves the person when retrying
 * would be useless or unsafe.
 *
 * WHAT LIVES HERE vs WHAT THE MODEL DECIDES
 *   This module holds only closed-form facts: enum values the runtime itself
 *   wrote (run status, tool authority) and counters. Deciding what a failure
 *   *means* — is this a wall we can go around, does a person have to unblock
 *   it, could it already have acted on the outside world — is meaning, not
 *   form, and an unbounded space of wordings across every model and locale.
 *   That judgment belongs to the resident judgment engine
 *   (`electron/one/auto-recovery.ts`), never to a keyword list here. This
 *   codebase already removed keyword fallbacks on purpose; re-adding one would
 *   hide a disconnected judge exactly the way it did before.
 *
 * WHY TWO AUTOMATIC RETRIES (three attempts total)
 *   Published self-correction results converge: the first correction carries
 *   most of the gain (~62% → ~70% cumulative success), the third is already
 *   small (~75%), and the fifth saturates (~79%) — under ~2% marginal gain per
 *   attempt past the third. LangGraph's RetryPolicy ships the same default
 *   (max_attempts = 3 including the first). Beyond that, extra attempts mostly
 *   buy latency and raise the odds of the agent reinforcing its own wrong
 *   diagnosis.
 *
 * WHY WRITE AUTHORITY IS A HARD GATE, NOT A JUDGMENT
 *   Retrying an action with side effects is only safe with an idempotency key
 *   that collapses the repeat onto the first attempt. One's tool-execution path
 *   has none today. The classic failure is a timeout on the *response*: the
 *   send/post/write already happened and only the acknowledgement was lost, so
 *   a retry does it twice. Tool authority is a value the runtime recorded, so
 *   it is checked here as form. Until the invocation path supplies an
 *   idempotency key, every write-capable or unknown-authority failure stops
 *   before judgment.
 */

/** Automatic retries after the original attempt. Three attempts total. */
export const ONE_AUTO_RECOVERY_MAX_ATTEMPTS = 2;

/** What the judge may conclude about a run that did not finish. */
export const ONE_RECOVERY_LABELS = [
  "retry_different_approach",
  "needs_person",
  "unsafe_to_repeat",
  "will_not_succeed",
] as const;

export type OneRecoveryLabel = (typeof ONE_RECOVERY_LABELS)[number];

/** What the resident judge may conclude after an automatic retry completes. */
export const ONE_RECOVERY_OUTCOME_LABELS = [
  "verified_original_outcome",
  "retry_different_approach",
  "needs_person",
  "will_not_succeed",
] as const;

export type OneRecoveryOutcomeLabel = (typeof ONE_RECOVERY_OUTCOME_LABELS)[number];

/**
 * Fail-closed unavailable decision. When the model is unavailable the honest move is to hand
 * the run back to the person, never to retry something that might act twice.
 */
export const ONE_RECOVERY_UNAVAILABLE_DECISION: OneRecoveryLabel = "needs_person";

export type OneAutoRecoveryStop =
  | "settled"
  | "stopped-by-user"
  | "needs-person"
  | "unsafe-to-repeat"
  | "will-not-succeed"
  | "no-progress"
  | "exhausted"
  | "undecided";

export type OneAutoRecoveryDecision =
  | { retry: true; attempt: number }
  | { retry: false; reason: OneAutoRecoveryStop };

export type OneRecoveryOutcomeDecision =
  | { verified: true; retry: false }
  | { verified: false; retry: true; attempt: number }
  | { verified: false; retry: false; reason: OneAutoRecoveryStop };

export type OneRunFailureFingerprint = string;

/**
 * Exact bounded identity only. Semantic normalization belongs to the resident
 * judge; code must not use regexes, keyword lists, or a vocabulary to decide
 * that two differently worded failures mean the same thing.
 */
export function oneRunFailureFingerprint(
  receipt: Pick<InvocationRunReceipt, "errorCode" | "errorMessage">,
): OneRunFailureFingerprint {
  const normalized = (receipt.errorMessage ?? "")
    .toLowerCase()
    .trim()
    .slice(0, 200);
  return `${receipt.errorCode ?? ""}::${normalized}`;
}

/**
 * Closed-form gate that runs before the judge is consulted at all.
 * `null` means "nothing decidable from form alone — ask the judge".
 */
export function oneAutoRecoveryFormGate(input: {
  receipt: Pick<InvocationRunReceipt, "status" | "executionPermission">;
  attemptsSpent: number;
  previousFingerprint?: OneRunFailureFingerprint | null;
  currentFingerprint: OneRunFailureFingerprint;
  maxAttempts?: number;
}): OneAutoRecoveryDecision | null {
  const status = input.receipt.status;
  // An explicit stop is an instruction, not a failure to route around.
  if (status === "cancelled") return { retry: false, reason: "stopped-by-user" };
  if (status !== "failed" && status !== "interrupted") {
    return { retry: false, reason: "settled" };
  }
  // Only an explicitly read-only run is safe to repeat automatically. Missing
  // authority is not evidence of safety, and write/full runs currently have no
  // idempotency key that could collapse a duplicate external action.
  if (input.receipt.executionPermission !== "read") {
    return { retry: false, reason: "unsafe-to-repeat" };
  }
  if (input.previousFingerprint && input.previousFingerprint === input.currentFingerprint) {
    // The approach did not actually change, so a further attempt will not either.
    return { retry: false, reason: "no-progress" };
  }
  if (input.attemptsSpent >= (input.maxAttempts ?? ONE_AUTO_RECOVERY_MAX_ATTEMPTS)) {
    return { retry: false, reason: "exhausted" };
  }
  return null;
}

/** Maps a judged label onto the final decision. */
export function oneAutoRecoveryFromLabel(
  label: OneRecoveryLabel,
  attemptsSpent: number,
): OneAutoRecoveryDecision {
  if (label === "retry_different_approach") return { retry: true, attempt: attemptsSpent + 1 };
  if (label === "unsafe_to_repeat") return { retry: false, reason: "unsafe-to-repeat" };
  if (label === "will_not_succeed") return { retry: false, reason: "will-not-succeed" };
  return { retry: false, reason: "needs-person" };
}

/** Maps a semantic outcome judgment onto the bounded recovery state machine. */
export function oneRecoveryOutcomeFromLabel(
  label: OneRecoveryOutcomeLabel,
  attemptsSpent: number,
): OneRecoveryOutcomeDecision {
  if (label === "verified_original_outcome") {
    return { verified: true, retry: false };
  }
  if (label === "retry_different_approach") {
    if (attemptsSpent >= ONE_AUTO_RECOVERY_MAX_ATTEMPTS) {
      return { verified: false, retry: false, reason: "exhausted" };
    }
    return { verified: false, retry: true, attempt: attemptsSpent + 1 };
  }
  if (label === "will_not_succeed") {
    return { verified: false, retry: false, reason: "will-not-succeed" };
  }
  return { verified: false, retry: false, reason: "needs-person" };
}
