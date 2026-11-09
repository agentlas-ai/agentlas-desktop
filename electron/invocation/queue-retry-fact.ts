import type { InvocationRunReceipt } from "../../shared/types";
import { undispatchedInternalFailure } from "../../shared/run-failure-cause";
import { isNonFailureInvocationStop } from "../../shared/invocation-host-stop";
import { UNDISPATCHED_START_MAX_ATTEMPTS, isHostNotReadyRunFailureCode, isOwnerFixableRunFailureCode, isTransientRunFailureCode } from "../../shared/transient-send-refusal";
import { hostNotReadyRunCause } from "../mcp/config-build-retry";
import { hostRecoveryRequested } from "./host-recovery";
import { readRunTurnPlacement, type RunTurnPlacement } from "./turn-placement";

/** pending-chat-sends.ts MAX_NOT_DISPATCHED_RETRIES: the one start-again the queue gives any run that provably sent nothing. A gate drives the real queue against this. */
const LEGACY_NOT_DISPATCHED_RETRIES = 1;

type DbReader = { prepare(sql: string): { get(...args: unknown[]): unknown } };

type FailureFacts = Pick<InvocationRunReceipt, "runId" | "status" | "errorCode" | "runtimeFailure" | "interruptionCause" | "hostStopCause">;

/**
 * A settled run that failed before any model call for the app's own state: the queue starts its message again, silently, up to
 * UNDISPATCHED_START_MAX_ATTEMPTS times. A failed run only (the owner's Stop, a steering interrupt and a host stop are not failures to
 * retry), and the app-side families (a ledger or custody state) count: they are the app's own state too, so they get the same bounded
 * retries as an unknown code instead of the single legacy start-again. The queue's `internalFailure`
 * dependency (renderer-send-queue.ts) and queueWillStartRunAgain below are this one rule.
 */
export function queuedSendInternalFailure(receipt: Pick<InvocationRunReceipt, "status" | "errorCode" | "runtimeFailure" | "interruptionCause" | "hostStopCause"> | null | undefined): boolean {
  return !!receipt && receipt.status === "failed" && !isNonFailureInvocationStop(receipt)
    && undispatchedInternalFailure({ code: receipt.errorCode, runtimeFailure: receipt.runtimeFailure, delivery: "not-dispatched" });
}

/**
 * Will the owner's send queue start the message of this settled run again by itself? Read at the run's settlement, while its
 * row is still `starting` (the queue decides on its next tick, pending-chat-sends.ts settleRun -> kick). It answers with the
 * queue's own rule for a run that provably sent nothing (settleStarting): a "not ready yet" run code, a failure of the app's own
 * state with tries left, or the one legacy start-again. Anything else, a run that reached a model, a run the owner stopped, a
 * message whose tries are spent, is not retried, and is the failure the owner is told about.
 *
 * The owner is told once, about an attempt that finally does not go through: no alert, toast, sound or bounce for each retried
 * attempt (regression review C4, up to 13 "Run failed" alerts for one queued message, each with sound and a Dock bounce,
 * while the line in the chat said "the app will try again by itself"). When unsure, false: the alert is kept.
 */
export function queueWillStartRunAgain(
  db: DbReader,
  receipt: FailureFacts,
  placement: RunTurnPlacement | (() => RunTurnPlacement) = () => readRunTurnPlacement(receipt.runId),
): boolean {
  try {
    if (receipt.status !== "failed" || isNonFailureInvocationStop(receipt)) return false;
    // The host recovers this run itself (host-recovery.ts): not the end of the message, and not the queue's to start again.
    if (hostRecoveryRequested(db as never, receipt.runId)) return true;
    const row = db.prepare("SELECT id, attempts, dispatch_retries, request_json FROM pending_chat_sends WHERE run_id = ? AND state = 'starting'")
      .get(receipt.runId) as { id: string; attempts: number; dispatch_retries: number | null; request_json: string } | undefined;
    if (!row) return false;
    if ((typeof placement === "function" ? placement() : placement) !== "not-dispatched") return false;
    const code = receipt.errorCode ?? null;
    // The owner's folder is gone: nothing the queue does changes that, so it starts nothing again.
    if (isOwnerFixableRunFailureCode(code)) return false;
    // The app's own host was not ready: the queue keeps the message with no cap when the run's own mcp_config_failure event names a cause
    // that clears by itself, and gives any other cause the bounded tries, then holds it for host-recovery (pending-chat-sends.ts).
    if (isHostNotReadyRunFailureCode(code) && row.attempts + 1 >= UNDISPATCHED_START_MAX_ATTEMPTS && !hostNotReadyRunCause(db as never, receipt.runId, code)) return false;
    if (isTransientRunFailureCode(code)) return true;
    if (row.attempts + 1 < UNDISPATCHED_START_MAX_ATTEMPTS && queuedSendInternalFailure(receipt)) return true;
    // The legacy start-again is not given to an input the queue keeps in custody (its one-use refs have their own re-reservation).
    const request = JSON.parse(row.request_json) as { oneAttachmentRef?: unknown; oneTeamPreflightRef?: unknown };
    // A follow-up the queue keeps in custody (renderer-send-queue.ts persistentInput) is held, not started again, when its run failed with any
    // code that is not a "not ready yet" one (settleStarting: persistent && failureCode && !transient -> held). It has no one-use ref in its
    // request, so it is told apart by its custody row (regression review 2, N11: the helper said "will retry" and the failure alert was dropped
    // for a message that was not going to run).
    let followupCustody = false;
    try { followupCustody = Boolean(db.prepare("SELECT 1 FROM invocation_followup_custody WHERE queue_id = ?").get(row.id)); } catch { /* no such table: no follow-up custody */ }
    if (followupCustody && code && !isTransientRunFailureCode(code)) return false;
    return !request.oneAttachmentRef && !request.oneTeamPreflightRef && (row.dispatch_retries ?? 0) < LEGACY_NOT_DISPATCHED_RETRIES;
  } catch {
    return false;
  }
}
