import type { ExecutionFailureCause, ExecutionFailureReport } from "../../shared/execution-effect-contract";
import type { InvocationRuntimeFailure } from "../../shared/types";
import { PROVIDER_UNAVAILABLE_CODES } from "../../shared/run-failure-notice";

/**
 * How an owner-facing team turn ends when its structural verifier did not pass.
 *
 * The room's report (the synthesis plus the host's typed "still to do" note) is already in the transcript, and the ledger already
 * holds the verdict (task_force_execution_receipt, verifierStatus "fail") that the Goal readers key on
 * (long-run/daemon-turn-goal.ts taskForceLeftWork, store/tasks.ts hasPassedTaskForceExecutionVerification). Ending such a turn
 * as a failed run reported our own bookkeeping as a failure of the owner's work: production 1.3.105, eight
 * `task-force-verification-failed` turns whose reports were complete.
 *
 * A turn fails only for an execution cause: a step that threw or was refused by a runtime or provider (phase "execution", an HTTP
 * status, a provider code, a retry hint, a wait for capacity), or an outside effect that may or may not have happened. The app's own
 * exception inside a step that had not acted outward (cause.internal) is not one: it is run once more, and what remains is work left. A step that
 * ran and said what is left, a step withheld behind one, a refused admission that never dispatched, an access block and an
 * unmet verification are work left, not a failure.
 */
export function taskForceCauseIsExecutionFailure(cause: ExecutionFailureCause): boolean {
  // The app's own exception in a step that had not acted outward (borrowed-task-force.ts taskForceErrorReport): the room ran the step
  // once more, and what is left is work left. The cause stays in the report and the ledger; only the label of the turn changes.
  if (cause.internal === true) return false;
  return cause.phase === "execution"
    || cause.httpStatus !== undefined
    || cause.providerCode !== undefined
    || cause.retryAfterMs !== undefined
    || cause.retryAfterHint !== undefined
    || cause.recovery === "wait-capacity"
    || cause.recovery === "retry-preparation"
    // The step may have acted outside: the owner must be told it failed, not that it is merely unfinished.
    || cause.recovery === "inspect-effect"
    || cause.recovery === "reconcile-effect";
}

export function taskForceUnverifiedSettlesAsReport(input: {
  /** The room's synthesis is in the transcript (the durable assistant message id the final event carries). */
  reportDelivered: boolean;
  /** The owner's own turn: not an automation, graph, site or mail run, a Work session child, an Agent App or a fixed Workforce contract. */
  ownerTurn: boolean;
  failureReport: ExecutionFailureReport | undefined | null;
}): boolean {
  if (!input.reportDelivered || !input.ownerTurn) return false;
  const report = input.failureReport;
  if (!report) return true;
  if (report.causes.some(taskForceCauseIsExecutionFailure)) return false;
  return !report.effects.some((effect) => effect.state === "attempted" || effect.state === "uncertain");
}

/**
 * Why a team turn ended without verifying, as a class the Goal wake and the wording can read instead of the one label
 * `task-force-verification-failed` (kept for compatibility). It is read from the typed failure report, never from prose:
 *  - "login": a step's provider sign-in failed (kind auth from a marker or the exit status, or HTTP 401). Only the owner or time changes it.
 *  - "capacity": the provider is out of quota, throttling or overloaded (quota / rate_limit / unavailable, HTTP 429 / 503 / 529, a wait for
 *    capacity, a Retry-After). It lifts by itself or at a reset the provider names.
 *  - "execution": a step threw or was refused while it ran, with no provider evidence: the app's own side until shown otherwise.
 * null: no cause of the report is an execution failure (work left, a withheld step, an access block): that is not a failed run.
 * login wins over capacity, capacity over execution: the class names the cause that decides what happens next.
 */
export type TaskForceCauseClass = "login" | "capacity" | "execution";

const evidence = (cause: ExecutionFailureCause): boolean => cause.providerSource !== "heuristic";

function causeIsLogin(cause: ExecutionFailureCause): boolean {
  return (cause.providerKind === "auth" && evidence(cause)) || cause.httpStatus === 401;
}

/** The provider could not take the request (an outage, "at capacity"): its typed code, from a marker or the exit status, never from prose. */
function causeIsProviderUnavailable(cause: ExecutionFailureCause): boolean {
  return evidence(cause) && typeof cause.providerCode === "string" && PROVIDER_UNAVAILABLE_CODES.includes(cause.providerCode);
}

function causeIsCapacity(cause: ExecutionFailureCause): boolean {
  return ((cause.providerKind === "quota" || cause.providerKind === "rate_limit" || cause.providerKind === "unavailable") && evidence(cause))
    || causeIsProviderUnavailable(cause)
    || cause.httpStatus === 429 || cause.httpStatus === 503 || cause.httpStatus === 529
    || cause.recovery === "wait-capacity"
    || cause.retryAfterMs !== undefined || cause.retryAfterHint !== undefined;
}

export function taskForceCauseClass(report: ExecutionFailureReport | undefined | null): TaskForceCauseClass | null {
  const causes = report?.causes.filter(taskForceCauseIsExecutionFailure) ?? [];
  if (causes.length === 0) return null;
  if (causes.some(causeIsLogin)) return "login";
  if (causes.some(causeIsCapacity)) return "capacity";
  return "execution";
}

/**
 * The provider's own typed failure behind a "login" or "capacity" class, in the shape a single-runtime run carries on its terminal
 * event (InvocationRuntimeFailure). The terminal ledger row and the Goal wake read its kind and source to tell an outside cause from
 * the app's own (long-run/wake-arbiter.ts EXTERNAL_FAILURE_KINDS); the transcript names the real cause from it. Null unless a step
 * carries a kind the runner decided from a marker or the exit status: nothing is invented from a status code or a guess.
 */
export function taskForceProviderFailure(report: ExecutionFailureReport | undefined | null): InvocationRuntimeFailure | null {
  const causes = report?.causes ?? [];
  const typed = (kind: ExecutionFailureCause["providerKind"]) => causes.find((cause) => cause.providerKind === kind && (cause.providerSource === "marker" || cause.providerSource === "exit"));
  // A provider outage carries the same way a limit does, so the turn that holds the step is told apart from a failure inside the app: the
  // owner-failure classifier reads providerCode (shared/transient-provider-failure.ts), not the kind. Without it the whole turn read as the
  // app's own failure and was retried as one.
  const unavailable = causes.find((cause) => causeIsProviderUnavailable(cause) && cause.providerSource === "marker");
  const cause = typed("auth") ?? typed("quota") ?? typed("rate_limit");
  if (!cause && unavailable) {
    return { kind: "refused", source: "marker", providerCode: unavailable.providerCode,
      ...(unavailable.retryAfterHint ? { retryAfterAt: unavailable.retryAfterHint } : {}) };
  }
  if (!cause || (cause.providerKind !== "auth" && cause.providerKind !== "quota" && cause.providerKind !== "rate_limit")) return null;
  return { kind: cause.providerKind, source: cause.providerSource as "marker" | "exit",
    ...(cause.providerCode ? { providerCode: cause.providerCode } : {}),
    ...(cause.retryAfterHint ? { retryAfterAt: cause.retryAfterHint } : {}) };
}
