import type { InvocationRunReceipt } from "../../shared/types";
import { UNCONFIRMED_MAX_RESENDS, UNCONFIRMED_VERIFY_CONTINUATIONS, unconfirmedRunShouldBeSentAgain } from "./earlier-attempt";
import { ownerSpokeAfter } from "./host-recovery";
import { readRunTurnPlacement } from "./turn-placement";
import { queueWillStartRunAgain } from "./queue-retry-fact";

/**
 * Will the app send the owner's message of this just-failed run again by itself, and has it already? The failure line a run leaves
 * (and the error event the stream and the phone draw) must say the true thing about that: "send it again" is true only when the app
 * will not, "the app is sending it again" only when it will. The decision itself is the send queue's (pending-chat-sends.ts
 * settleStarting, renderer-send-queue.ts resendLostDirectRun); this reads the same durable facts the moment the run fails, before the
 * queue looks:
 *  - "now": the app sends this message once more by itself (a first attempt of an owner message that is plain enough to carry again);
 *  - "spent": the app already sent it once more and it ended the same way, so nothing more is sent automatically;
 *  - "none": no automatic send (the placement is proven, the failure has a cause of its own, the input is a one-use attachment the
 *    queue cannot carry again, or the run was not started by a message the queue holds).
 * Stop always wins: this only forecasts, the queue still checks the owner's Stop, a steering interrupt and a newer message before it
 * sends. A forecast of "now" for a message the owner then stops is followed by no failure line at all (a cancelled run says nothing).
 */
export type ResendForecast = "now" | "spent" | "none";

type Db = { prepare(sql: string): { get(...args: unknown[]): unknown } };

/** Main keeps the request of a message the composer started directly until its run settles (renderer-send-queue.ts); the daemon never does. */
const directStartsKept = new Set<string>();
const DIRECT_STARTS_REMEMBERED = 32;
export function noteDirectStartKept(runId: string): void {
  directStartsKept.add(runId);
  while (directStartsKept.size > DIRECT_STARTS_REMEMBERED) directStartsKept.delete(directStartsKept.values().next().value as string);
}
export function forgetDirectStartKept(runId: string): void { directStartsKept.delete(runId); }

type FailureFacts = Pick<InvocationRunReceipt, "errorCode" | "runtimeFailure" | "hostInternalFailure">;

export function forecastAppResend(db: Db, runId: string | undefined | null, facts: FailureFacts): ResendForecast {
  if (!runId) return "none";
  try {
    const placement = readRunTurnPlacement(runId);
    if (placement === "placed") return "none";
    const receiptLike = { status: "failed" as const, ...facts };
    if (placement === "not-dispatched") {
      // Nothing reached the model: the queue's own start-again rule (a bounded number of silent tries for the app's own state).
      return queueWillStartRunAgain(db, { runId, ...receiptLike }, "not-dispatched") ? "now" : "none";
    }
    // Dispatched and not proven: the one resend of earlier-attempt.ts, for the classes of failure it names.
    if (!unconfirmedRunShouldBeSentAgain(receiptLike)) return "none";
    const row = db.prepare("SELECT id, chat_id, uncertain_resends, resend_since, updated_at, request_json FROM pending_chat_sends WHERE run_id = ? AND state = 'starting'")
      .get(runId) as { id: string; chat_id: string; uncertain_resends: number | null; resend_since: number | null; updated_at: number | null; request_json: string } | undefined;
    if (row) {
      const resends = row.uncertain_resends ?? 0;
      if (resends >= UNCONFIRMED_MAX_RESENDS + UNCONFIRMED_VERIFY_CONTINUATIONS) return "spent";
      // The plain resend is spent: the verify-first send follows (pending-chat-sends.ts) unless the owner has written something newer.
      if (resends >= UNCONFIRMED_MAX_RESENDS
        && ownerSpokeAfter(db as unknown as Parameters<typeof ownerSpokeAfter>[0], row.chat_id, null, new Date(row.resend_since ?? row.updated_at ?? 0).toISOString())) return "spent";
      const request = JSON.parse(row.request_json) as { oneAttachmentRef?: unknown; oneTeamPreflightRef?: unknown };
      if (request.oneAttachmentRef || request.oneTeamPreflightRef) return "none";
      let custody = false;
      try { custody = Boolean(db.prepare("SELECT 1 FROM invocation_followup_custody WHERE queue_id = ?").get(row.id)); } catch { custody = false; }
      return custody ? "none" : "now";
    }
    // The personal One window sends through the supervisor, not the send queue (one/supervisor-service.ts resendUnconfirmedReply).
    const supervised = supervisorReplyForecast(db, runId);
    if (supervised) return supervised;
    return directStartsKept.has(runId) ? "now" : "none";
  } catch { return "none"; }
}

/**
 * A reply typed in the personal One window (or the phone's One chat) is a supervisor row, not a queue row: the supervisor sends it once more
 * through the same rule (resendUnconfirmedReply: the first loss is sent again with the earlier-attempt line, a second ends as it always did).
 * "now" for a first attempt, "spent" for the resend itself, "none" for what the supervisor never sends again: a host review, an ordinary
 * composer turn the supervisor only observes, a Goal-bound reply, a reply the owner pressed Stop on. Like the queue's, this only forecasts:
 * the supervisor still checks that the owner has not written a newer message before it sends.
 */
function supervisorReplyForecast(db: Db, runId: string): ResendForecast | null {
  try {
    const row = db.prepare("SELECT one_id, payload_json, user_message_id FROM one_supervisor_requests WHERE run_id = ? AND kind = 'reply' AND state IN ('dispatching','accepted','held') LIMIT 1")
      .get(runId) as { one_id: string; payload_json: string; user_message_id: string | null } | undefined;
    if (!row) return null;
    if (!row.user_message_id) return "none"; // a host review has no owner message
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { return "none"; }
    if (Object.prototype.hasOwnProperty.call(payload, "ordinaryNative") || payload.boundGoalId) return "none";
    if (Number(payload.unconfirmedResends ?? 0) >= UNCONFIRMED_MAX_RESENDS + UNCONFIRMED_VERIFY_CONTINUATIONS) return "spent";
    if (db.prepare("SELECT 1 FROM one_supervisor_requests WHERE one_id = ? AND kind = 'stop-reply' AND run_id = ? LIMIT 1").get(row.one_id, runId)) return "none";
    return "now";
  } catch { return null; }
}
