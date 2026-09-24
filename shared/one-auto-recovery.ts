import type { InvocationRunReceipt, RunEventUi } from "./types";

/**
 * Exact durable evidence that an interrupted run was replaced by a person's
 * new direction. This remains closed-form: an unexplained interruption is
 * still eligible for the normal recovery judgment.
 */
export function isOneSteeringInterruption(
  receipt: Pick<InvocationRunReceipt, "runId" | "chatId" | "status">,
  events: ReadonlyArray<Pick<RunEventUi, "runId" | "chatId" | "kind" | "payload">>,
): boolean {
  if (receipt.status !== "interrupted") return false;
  if (events.some((event) => event.runId !== receipt.runId || (event.chatId && event.chatId !== receipt.chatId))) {
    return false;
  }
  return events.some((event) => event.kind === "user_steering")
    && events.some((event) => event.kind === "invoke_cancel_requested" && event.payload?.reason === "steering")
    && events.some((event) => event.kind === "invoke_interrupted");
}

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

/**
 * The only reasons One may hand a run back to the person (owner direction 2026-09-24: "ask a human only at
 * true boundaries"). A bare "needs a person" is not a label any more — the judge must name the boundary,
 * and that name is the machine-readable reason code (docs/2026-09-24-PLAN-persistent-autonomy-foundation.md
 * P0-6, G5). Anything else is One's own problem to route around.
 */
export const ONE_RECOVERY_BOUNDARY_LABELS = [
  "needs_person_payment",
  "needs_person_credential",
  "needs_person_security_consent",
  "needs_person_purpose",
] as const;

export type OneRecoveryBoundaryLabel = (typeof ONE_RECOVERY_BOUNDARY_LABELS)[number];

export function isOneRecoveryBoundaryLabel(label: string): label is OneRecoveryBoundaryLabel {
  return (ONE_RECOVERY_BOUNDARY_LABELS as readonly string[]).includes(label);
}

/** What the judge may conclude about a run that did not finish. */
export const ONE_RECOVERY_LABELS = [
  "retry_different_approach",
  ...ONE_RECOVERY_BOUNDARY_LABELS,
  "unsafe_to_repeat",
  "will_not_succeed",
] as const;

export type OneRecoveryLabel = (typeof ONE_RECOVERY_LABELS)[number];

/** What the resident judge may conclude after an automatic retry completes. */
export const ONE_RECOVERY_OUTCOME_LABELS = [
  "verified_original_outcome",
  "retry_different_approach",
  ...ONE_RECOVERY_BOUNDARY_LABELS,
  "will_not_succeed",
] as const;

export type OneRecoveryOutcomeLabel = (typeof ONE_RECOVERY_OUTCOME_LABELS)[number];

/**
 * Legacy label-mapping default, kept so older callers that still hand in the bare label map to the same stop.
 * Main no longer uses it as a default: an unavailable judge is decided from host facts
 * (`oneRecoveryHostFactDecision`), and a bare "needs_person" without a boundary name is downgraded the same
 * way (2026-09-24, P0-6). Before that change this default handed every judge outage to the person.
 */
export const ONE_RECOVERY_UNAVAILABLE_DECISION = "needs_person" as const;

/**
 * Host facts, not a judge, decide when no semantic verdict names a boundary. Only reached after the form gate
 * admitted an explicitly read-only run, so a further attempt is itself read-only and cannot duplicate an
 * outside effect: with zero acting calls it is another route; with acting calls recorded (a mislabelled
 * read-only tool) it is an observation of what actually happened first. Bounded by the attempt budget.
 */
export function oneRecoveryHostFactDecision(input: {
  actingCalls: number;
  attemptsSpent: number;
  maxAttempts?: number;
}): { decision: OneAutoRecoveryDecision; approach: "retry_different_route" | "observe_first" } {
  const approach = input.actingCalls > 0 ? "observe_first" as const : "retry_different_route" as const;
  if (input.attemptsSpent >= (input.maxAttempts ?? ONE_AUTO_RECOVERY_MAX_ATTEMPTS)) {
    return { decision: { retry: false, reason: "exhausted" }, approach };
  }
  return { decision: { retry: true, attempt: input.attemptsSpent + 1 }, approach };
}

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
  receipt: Pick<InvocationRunReceipt, "status" | "executionPermission" | "interruptionCause">;
  attemptsSpent: number;
  previousFingerprint?: OneRunFailureFingerprint | null;
  currentFingerprint: OneRunFailureFingerprint;
  maxAttempts?: number;
}): OneAutoRecoveryDecision | null {
  const status = input.receipt.status;
  // Steering is a deliberate replacement, not a failed attempt to route
  // around. The receipt is set only from the exact ledger sequence above.
  if (input.receipt.interruptionCause === "steering") {
    return { retry: false, reason: "settled" };
  }
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

/** Maps a judged label onto the final decision. A boundary label stops for the person; so does any unknown
 * label here (pure mapping stays fail-closed — Main downgrades a bare needs_person before it gets here). */
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
