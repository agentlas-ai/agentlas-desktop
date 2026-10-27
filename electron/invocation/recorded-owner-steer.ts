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

/** The record for exactly this chat and intent, or null when none exists or the store cannot say (never a guess). Never throws. */
export function readRecordedOwnerSteer(chatId: string, intentId: string): RecordedOwnerSteer | null {
  if (typeof chatId !== "string" || !chatId || typeof intentId !== "string" || !intentId) return null;
  let currentTurn: InvocationCurrentTurnSteerReceipt | null;
  try { currentTurn = getCurrentTurnSteer(chatId, intentId); } catch { return null; } // another chat's intent id, or an unreadable store
  if (!currentTurn) return null;
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
