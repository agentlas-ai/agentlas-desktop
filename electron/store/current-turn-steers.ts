import { appendChatMessage } from "./chats";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import { createCurrentTurnSteerStore } from "./current-turn-steer-core";

const store = createCurrentTurnSteerStore({
  getDb,
  appendUserMessage: (chatId, text) => appendChatMessage(chatId, "user", text),
  onChange: (chatId) => emitDesktopStoreChange({ entity: "chat", id: chatId }),
});

export const validateCurrentTurnSteer = store.validateCurrentTurnSteer;
export const existingCurrentTurnSteer = store.existingCurrentTurnSteer;
export const getCurrentTurnSteer = store.getCurrentTurnSteer;
export const claimCurrentTurnSteer = store.claimCurrentTurnSteer;
export const settleCurrentTurnSteer = store.settleCurrentTurnSteer;
export const takeCurrentTurnSteers = store.takeCurrentTurnSteers;
export const countPendingCurrentTurnSteers = store.countPendingCurrentTurnSteers;

/** code of an owner direction a running turn had not taken yet when the owner stopped that turn (Stop, Goal pause or delete). */
export const CURRENT_TURN_RUN_STOPPED_CODE = "owner_control_run_stopped";

/**





 */
export function rejectQueuedCurrentTurnSteersForStop(chatId: string, runId: string): number {
  if (!chatId || !runId) return 0;
  const changed = getDb().prepare(`UPDATE invocation_current_turn_steers SET status = 'rejected', code = ?, updated_at = ?
    WHERE chat_id = ? AND run_id = ? AND status = 'queued'
      AND NOT (json_valid(binding_json) AND COALESCE(json_extract(binding_json, '$.requestedMode'), '') = 'interrupt')`)
    .run(CURRENT_TURN_RUN_STOPPED_CODE, new Date().toISOString(), chatId, runId).changes;
  if (changed > 0) { try { emitDesktopStoreChange({ entity: "chat", id: chatId }); } catch { /* the settlement is durable */ } }
  return changed;
}

/** One uncertain owner text of a chat: it may have reached the model, is never dispatched again, and goes back to the owner. */
export interface UncertainCurrentTurnSteer { intentId: string; chatId: string; runId: string; promptText: string; promptHash: string; createdAt: string }

/** Every uncertain current-turn owner text of the chat, whatever host or source wrote it, oldest first. */
export function listUncertainCurrentTurnSteers(chatId: string): UncertainCurrentTurnSteer[] {
  return (getDb().prepare(`SELECT intent_id, chat_id, run_id, prompt_text, prompt_hash, created_at FROM invocation_current_turn_steers
    WHERE chat_id = ? AND status = 'uncertain' ORDER BY created_at, rowid`).all(chatId) as Array<{
    intent_id: string; chat_id: string; run_id: string; prompt_text: string; prompt_hash: string; created_at: string;
  }>).map((row) => ({ intentId: row.intent_id, chatId: row.chat_id, runId: row.run_id, promptText: row.prompt_text,
    promptHash: row.prompt_hash, createdAt: row.created_at }));
}
