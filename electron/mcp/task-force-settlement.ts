import type { ExecutionFailureCause, ExecutionFailureReport } from "../../shared/execution-effect-contract";

/**
 * How an owner-facing team turn ends when its structural verifier did not pass.
 *
 * The room's report (the synthesis plus the host's typed "still to do" note) is already in the transcript, and the ledger already
 * holds the verdict (task_force_execution_receipt, verifierStatus "fail") that the Goal readers key on
 * (long-run/daemon-turn-goal.ts taskForceLeftWork, store/tasks.ts hasPassedTaskForceExecutionVerification). Ending such a turn
 * as a failed run reported our own bookkeeping as a failure of the owner's work: observed in 1.3.105, eight
 * `task-force-verification-failed` turns whose reports were complete.
 *
 * A turn fails only for an execution cause: a step that threw or was refused by a runtime or provider (phase "execution", an HTTP
 * status, a provider code, a retry hint, a wait for capacity), or an outside effect that may or may not have happened. A step that
 * ran and said what is left, a step withheld behind one, a refused admission that never dispatched, an access block and an
 * unmet verification are work left, not a failure.
 */
export function taskForceCauseIsExecutionFailure(cause: ExecutionFailureCause): boolean {
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
