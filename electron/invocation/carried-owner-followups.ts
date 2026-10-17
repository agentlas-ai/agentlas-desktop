import type Database from "better-sqlite3";
import type { McpInvocationRequest } from "../../shared/types";
import { getDb } from "../store/db";
import { persistQueuedSteer, type DurableQueuedSteer } from "../store/invocation-steers";

/**
 * What the owner wrote into a running turn and the turn never took, carried to the chat's next turn.
 *
 * Production 2026-10-17 (1.3.61, YouTube room, run a992ca92): at 09:44:55 the owner sent a style direction for the Goal
 * that was making the day's videos. The run was a team run, which never reads the owner inbox, so the direction waited
 * 81 minutes as `queued` and was refused `owner_control_run_settled` when the run ended. Nothing re-sent it and no screen
 * showed the refusal: 15 videos were made in the old style and the direction was simply gone. A daemon-owned run lost
 * such a direction even sooner (a current-only row was refused at the episode end or as soon as the native handle was
 * unavailable), while the same message to a Desktop-owned run was delivered after the episode.
 *
 * Claude Code and Codex queue what is typed during a turn and send it when the turn ends. Here: when a run ends without
 * the owner stopping it, every direction it never dispatched (still `queued`) becomes ONE next turn, the texts in the
 * order they were written. Its rows are settled `rejected` / `owner_control_next_turn` in the same transaction that
 * persists the queued turn, so a direction is carried at most once and never also replayed into the ended run. The
 * owner's message rows already exist (the claim wrote them); the next turn reuses them instead of writing new bubbles
 * (carriedFollowupMessageIds). A `dispatching` or `uncertain` row may have reached the model and is never carried.
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
    // (invocation-owner-router.ts, InvocationService.currentTurnSteerReceipt): never dispatched either, so carried too.
    const rows = db.prepare(`SELECT intent_id, prompt_text FROM invocation_current_turn_steers
      WHERE chat_id = ? AND run_id = ? AND (status = 'queued' OR (status = 'rejected' AND code = 'owner_control_run_settled'))
      ORDER BY created_at, rowid`).all(input.chatId, input.runId) as Array<{ intent_id: string; prompt_text: string }>;
    const texts = rows.map((row) => row.prompt_text).filter((text) => typeof text === "string" && text.trim());
    if (!rows.length || !texts.length) return null;
    const now = new Date().toISOString();
    const settle = db.prepare(`UPDATE invocation_current_turn_steers SET status = 'rejected', code = ?, updated_at = ?
      WHERE intent_id = ? AND chat_id = ? AND run_id = ?
        AND (status = 'queued' OR (status = 'rejected' AND code = 'owner_control_run_settled'))`);
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
