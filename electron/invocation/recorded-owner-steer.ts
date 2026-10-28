import type { InvocationCurrentTurnSteerReceipt, InvocationSteerResult } from "../../shared/types";
import { getDb } from "../store/db";
import { getCurrentTurnSteer } from "../store/current-turn-steers";

/**
 * An owner text the process that hosts the turn (the background service) has ALREADY recorded under this intent.
 *
 * The host records the direction in the shared store (invocation_current_turn_steers: the user row and the once-only claim in one
 * transaction) before it answers. When the signed channel closes or is replaced while that answer is in flight, Main only learns
 * that the call failed; the text may be recorded. The store is shared, so Main can read the host's own record instead of guessing:
 * a recorded direction is delivered by the host (its receipt says how far), and sending the same words again as the next message
 * would deliver them twice.
 */
export interface RecordedOwnerSteer {
  /** The shape invoke:steerCurrentTurn answers. */
  currentTurn: InvocationCurrentTurnSteerReceipt;
  /** The shape invoke:steer / invoke:steerReceipt answer (the same mapping the host's own receipt uses). */
  steer: InvocationSteerResult;
}

/**
 * Rejected rows that are still the owner's text accounted for: withdrawn or returned by the owner, or carried whole into the
 * chat's next turn (carried-owner-followups.ts). Any other rejection (owner_control_run_settled, owner_control_not_dispatched,
 * ...) means the text never reached a model (red-blue regression review A, R2, 2026-10-28).
 */
const OWNER_SETTLED_REJECTIONS: ReadonlySet<string> = new Set([
  "native_owner_text_withdrawn", "owner_recovery_returned", "owner_control_next_turn",
]);

const CARRY_ELIGIBLE_REJECTIONS: ReadonlySet<string> = new Set(["owner_control_run_settled", "owner_control_not_dispatched"]);
/** The row's text went as the chat's next message through the caller's queue (never carried as well). */
export const SENT_AS_NEXT_MESSAGE_CODE = "owner_control_sent_as_next_message";

/** The record for exactly this chat and intent, or null when none exists or the store cannot say (never a guess). Never throws. */
export function readRecordedOwnerSteer(chatId: string, intentId: string): RecordedOwnerSteer | null {
  if (typeof chatId !== "string" || !chatId || typeof intentId !== "string" || !intentId) return null;
  let currentTurn: InvocationCurrentTurnSteerReceipt | null;
  try { currentTurn = getCurrentTurnSteer(chatId, intentId); } catch { return null; } // another chat's intent id, or an unreadable store
  if (!currentTurn) return null;
  // A direction the turn never took (it ended first, or never dispatched its batch) is not delivered: the queued owner text
  // goes as the next message instead of being dropped. Only the owner's own take-back and a carry to the next turn count.
  if (currentTurn.status === "rejected" && !OWNER_SETTLED_REJECTIONS.has(currentTurn.code ?? "")) {
    // The run's end carries exactly these rows into the next turn (takeUndeliveredOwnerDirections). Take this one for the
    // next message instead, in one statement: whichever side takes it first delivers it, so it is neither lost nor sent twice.
    if (!CARRY_ELIGIBLE_REJECTIONS.has(currentTurn.code ?? "")) return null;
    try {
      const taken = getDb().prepare(`UPDATE invocation_current_turn_steers SET code = ?, updated_at = ?
        WHERE intent_id = ? AND chat_id = ? AND status = 'rejected' AND code IN ('owner_control_run_settled','owner_control_not_dispatched')`)
        .run(SENT_AS_NEXT_MESSAGE_CODE, new Date().toISOString(), intentId, chatId).changes === 1;
      if (taken) return null;
      currentTurn = getCurrentTurnSteer(chatId, intentId);
    } catch { return null; }
    if (!currentTurn || currentTurn.status !== "rejected" || !OWNER_SETTLED_REJECTIONS.has(currentTurn.code ?? "")) return null;
  }
  let interruptsCurrent = false;
  try {
    const row = getDb().prepare("SELECT binding_json FROM invocation_current_turn_steers WHERE intent_id = ?").get(intentId) as { binding_json?: string } | undefined;
    interruptsCurrent = (JSON.parse(row?.binding_json ?? "{}") as { requestedMode?: unknown }).requestedMode === "interrupt";
  } catch { /* a text direction that does not interrupt is the default */ }
  const live = currentTurn.status === "queued" || currentTurn.status === "dispatching";
  return {
    currentTurn,
    steer: {
      accepted: true, chatId, queued: live, interruptsCurrent, activeRunId: currentTurn.runId,
      queuedRequestId: `native-owner:${intentId}`, promptHash: currentTurn.promptHash, intentId,
      ...(currentTurn.status === "applied" ? { runId: currentTurn.runId } : {}),
      status: currentTurn.code === "native_owner_text_withdrawn" ? "cancelled" : currentTurn.status === "applied" ? "started"
        : currentTurn.status === "queued" ? "queued" : currentTurn.status === "dispatching" ? "draining" : "held",
    },
  };
}
