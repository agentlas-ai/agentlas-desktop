import type Database from "better-sqlite3";
import type { McpInvocationRequest } from "../../shared/types";
import { getDb } from "../store/db";
import { persistQueuedSteer, type DurableQueuedSteer } from "../store/invocation-steers";

/**















 */
export const CARRIED_FOLLOWUP_STEER_PREFIX = "owner-followup:";
export const CARRIED_FOLLOWUP_CODE = "owner_control_next_turn";

/** The ended run's own execution choices, never its one-off flags (goalMode, attachments, targets, runtime pin). */
export function carriedFollowupRequest(source: McpInvocationRequest, text: string): McpInvocationRequest {
  return {
    chatId: source.chatId,
    userPrompt: text,
    taskIntent: "conversation",
    sessionRouting: false,
    ...(source.oneMode === true ? { oneMode: true } : {}),
    ...(source.onePermissionMode ? { onePermissionMode: source.onePermissionMode } : {}),
    ...(source.permissions ? { permissions: source.permissions } : {}),
    ...(source.planMode === true ? { planMode: true } : {}),
    ...(source.locale ? { locale: source.locale } : {}),
  };
}

/** Carry the run's never-dispatched owner directions as one queued next turn; null when there is none. */
export function carryUndeliveredOwnerFollowups(input: {
  chatId: string;
  runId: string;
  request: McpInvocationRequest;
}, db: Database.Database = getDb()): DurableQueuedSteer | null {
  return db.transaction(() => {
    // A receipt read that ran between the run's end and this carry refuses a queued row owner_control_run_settled
    // (invocation-owner-router.ts, InvocationService.currentTurnSteerReceipt), and an episode or loop boundary that
    // never dispatched its batch settles it owner_control_not_dispatched (owner-control-pump.ts): never sent, so carried.
    const rows = db.prepare(`SELECT intent_id, prompt_text FROM invocation_current_turn_steers
      WHERE chat_id = ? AND run_id = ? AND (status = 'queued' OR (status = 'rejected' AND code IN ('owner_control_run_settled','owner_control_not_dispatched')))
      ORDER BY created_at, rowid`).all(input.chatId, input.runId) as Array<{ intent_id: string; prompt_text: string }>;
    const texts = rows.map((row) => row.prompt_text).filter((text) => typeof text === "string" && text.trim());
    if (!rows.length || !texts.length) return null;
    const now = new Date().toISOString();
    const settle = db.prepare(`UPDATE invocation_current_turn_steers SET status = 'rejected', code = ?, updated_at = ?
      WHERE intent_id = ? AND chat_id = ? AND run_id = ?
        AND (status = 'queued' OR (status = 'rejected' AND code IN ('owner_control_run_settled','owner_control_not_dispatched')))`);
    for (const row of rows) {
      if (settle.run(CARRIED_FOLLOWUP_CODE, now, row.intent_id, input.chatId, input.runId).changes !== 1) {
        throw new Error("carried_followup_claim_lost");
      }
    }
    return persistQueuedSteer({
      id: `${CARRIED_FOLLOWUP_STEER_PREFIX}${rows[0]!.intent_id}`,
      chatId: input.chatId,
      originalRunId: input.runId,
      request: carriedFollowupRequest({ ...input.request, chatId: input.chatId }, texts.join("\n\n")),
    });
  }).immediate();
}

/**
 * The owner message rows a run started from a carried direction answers, oldest first ([] for any other run). The run
 * binds the last one as its own user message and leaves all of them out of its history (they are its prompt).
 */
export function carriedFollowupMessageIds(db: Database.Database, chatId: string, runId: string | undefined): string[] {
  if (!runId) return [];
  const steer = db.prepare(`SELECT original_run_id AS originalRunId FROM invocation_steers
    WHERE drained_run_id = ? AND chat_id = ? AND substr(id, 1, ?) = ? LIMIT 1`)
    .get(runId, chatId, CARRIED_FOLLOWUP_STEER_PREFIX.length, CARRIED_FOLLOWUP_STEER_PREFIX) as { originalRunId: string } | undefined;
  if (!steer) return [];
  return (db.prepare(`SELECT message_id AS id FROM invocation_current_turn_steers
    WHERE chat_id = ? AND run_id = ? AND status = 'rejected' AND code = ? ORDER BY created_at, rowid`)
    .all(chatId, steer.originalRunId, CARRIED_FOLLOWUP_CODE) as Array<{ id: string | null }>)
    .flatMap((row) => (typeof row.id === "string" && row.id ? [row.id] : []));
}
