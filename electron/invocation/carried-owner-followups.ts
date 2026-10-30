import type Database from "better-sqlite3";
import type { McpInvocationRequest } from "../../shared/types";
import { getDb } from "../store/db";
import { persistQueuedSteer, type DurableQueuedSteer } from "../store/invocation-steers";
import { OWNER_INTAKE_STEER_PREFIX } from "./owner-intake";

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

/**
 * Intent ID prefixes of directions a surface takes back itself at its turn's end: a Science direction belongs to Science's
 * next turn (its transcript and research record, PLAN S3), never to a Work turn on the hidden runtime chat. The owner of a
 * direction is in its ID, so the run's end and the restart sweep below carry every other direction unchanged.
 */
export const SURFACE_OWNED_DIRECTION_PREFIXES: readonly string[] = ["science-direction:"];

/**
 * The run's never-dispatched owner directions, settled `rejected` / owner_control_next_turn in one transaction so each is
 * taken at most once, oldest first. A `dispatching` or `uncertain` row may have reached the model and is never taken.
 * `intentPrefix` narrows the take to one surface's directions (Science takes only its own `science-direction:` rows);
 * without it, the directions a surface owns are left for that surface.
 */
export function takeUndeliveredOwnerDirections(input: { chatId: string; runId: string; intentPrefix?: string },
  db: Database.Database = getDb()): Array<{ intentId: string; text: string; messageId: string | null }> {
  return db.transaction(() => {
    // A receipt read that ran between the run's end and this take refuses a queued row owner_control_run_settled
    // (invocation-owner-router.ts, InvocationService.currentTurnSteerReceipt), and an episode or loop boundary that
    // never dispatched its batch settles it owner_control_not_dispatched (owner-control-pump.ts): never sent, so taken.
    const prefix = input.intentPrefix ?? "";
    const hasFollowupCustody = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invocation_followup_custody'").get());
    // V2 owns the exact model/options and original identity. At this terminal
    // boundary release only never-dispatched rows to its own single-input queue;
    // they must not join the legacy text batch or inherit the ended run's model.
    if (hasFollowupCustody && input.intentPrefix === undefined) db.prepare(`UPDATE invocation_current_turn_steers
      SET status='rejected',code='owner_control_run_settled',updated_at=? WHERE chat_id=? AND run_id=? AND status='queued'
      AND intent_id IN (SELECT intent_id FROM invocation_followup_custody WHERE state='entered' AND queue_id IS NULL)`)
      .run(new Date().toISOString(),input.chatId,input.runId);
    const rows = (db.prepare(`SELECT intent_id, prompt_text, message_id FROM invocation_current_turn_steers
      WHERE chat_id = ? AND run_id = ? AND (status = 'queued' OR (status = 'rejected' AND code IN ('owner_control_run_settled','owner_control_not_dispatched')))
        AND substr(intent_id, 1, ?) = ?
      ORDER BY created_at, rowid`).all(input.chatId, input.runId, prefix.length, prefix) as Array<{ intent_id: string; prompt_text: string; message_id: string | null }>)
      .filter((row) => typeof row.prompt_text === "string" && row.prompt_text.trim())
      .filter((row) => !hasFollowupCustody || !db.prepare("SELECT 1 FROM invocation_followup_custody WHERE intent_id=?").get(row.intent_id))
      .filter((row) => input.intentPrefix !== undefined || !SURFACE_OWNED_DIRECTION_PREFIXES.some((owned) => row.intent_id.startsWith(owned)));
    if (!rows.length) return [];
    const now = new Date().toISOString();
    const settle = db.prepare(`UPDATE invocation_current_turn_steers SET status = 'rejected', code = ?, updated_at = ?
      WHERE intent_id = ? AND chat_id = ? AND run_id = ?
        AND (status = 'queued' OR (status = 'rejected' AND code IN ('owner_control_run_settled','owner_control_not_dispatched')))`);
    for (const row of rows) {
      if (settle.run(CARRIED_FOLLOWUP_CODE, now, row.intent_id, input.chatId, input.runId).changes !== 1) {
        throw new Error("carried_followup_claim_lost");
      }
    }
    return rows.map((row) => ({ intentId: row.intent_id, text: row.prompt_text, messageId: row.message_id ?? null }));
  }).immediate();
}

/** Read-only: one surface's owner directions in this chat, oldest first, with their common receipt state. */
export function listOwnerDirections(input: { chatId: string; intentPrefix: string }, db: Database.Database = getDb()): Array<{
  intentId: string; runId: string; text: string; status: "queued" | "dispatching" | "applied" | "rejected" | "uncertain";
  code: string | null; createdAt: string; updatedAt: string;
}> {
  if (!input.intentPrefix) throw new Error("owner_direction_prefix_required");
  return (db.prepare(`SELECT intent_id, run_id, prompt_text, status, code, created_at, updated_at FROM invocation_current_turn_steers
    WHERE chat_id = ? AND substr(intent_id, 1, ?) = ? ORDER BY created_at, rowid LIMIT 500`)
    .all(input.chatId, input.intentPrefix.length, input.intentPrefix) as Array<{ intent_id: string; run_id: string; prompt_text: string;
      status: "queued" | "dispatching" | "applied" | "rejected" | "uncertain"; code: string | null; created_at: string; updated_at: string }>)
    .map((row) => ({ intentId: row.intent_id, runId: row.run_id, text: row.prompt_text, status: row.status, code: row.code ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at }));
}

/** Carry the run's never-dispatched owner directions as one queued next turn; null when there is none. */
export function carryUndeliveredOwnerFollowups(input: {
  chatId: string;
  runId: string;
  request: McpInvocationRequest;
}, db: Database.Database = getDb()): DurableQueuedSteer | null {
  return db.transaction(() => {
    const rows = takeUndeliveredOwnerDirections({ chatId: input.chatId, runId: input.runId }, db);
    if (!rows.length) return null;
    return persistQueuedSteer({
      id: `${CARRIED_FOLLOWUP_STEER_PREFIX}${rows[0]!.intentId}`,
      chatId: input.chatId,
      originalRunId: input.runId,
      request: carriedFollowupRequest({ ...input.request, chatId: input.chatId }, rows.map((row) => row.text).join("\n\n")),
    });
  }).immediate();
}

/**
 * The owner's message row the owner intake saved when it accepted a message its chat could not start yet
 * (owner-intake.ts): the first user row with the queued text written at or after the queue row. The run that later takes
 * the message binds that row instead of writing a second bubble.
 */
function ownerIntakeMessageId(db: Database.Database, chatId: string, runId: string): string | null {
  const steer = db.prepare(`SELECT prompt_text AS text, queued_at AS queuedAt FROM invocation_steers
    WHERE drained_run_id = ? AND chat_id = ? AND substr(id, 1, ?) = ? LIMIT 1`)
    .get(runId, chatId, OWNER_INTAKE_STEER_PREFIX.length, OWNER_INTAKE_STEER_PREFIX) as { text: string; queuedAt: string } | undefined;
  if (!steer) return null;
  const row = db.prepare(`SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'user' AND text = ? AND created_at >= ?
    ORDER BY created_at, rowid LIMIT 1`).get(chatId, steer.text, steer.queuedAt) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The owner message rows a run started from a carried direction answers, oldest first ([] for any other run). The run
 * binds the last one as its own user message and leaves all of them out of its history (they are its prompt).
 */
export function carriedFollowupMessageIds(db: Database.Database, chatId: string, runId: string | undefined): string[] {
  if (!runId) return [];
  const intake = ownerIntakeMessageId(db, chatId, runId);
  if (intake) return [intake];
  const steer = db.prepare(`SELECT original_run_id AS originalRunId FROM invocation_steers
    WHERE drained_run_id = ? AND chat_id = ? AND substr(id, 1, ?) = ? LIMIT 1`)
    .get(runId, chatId, CARRIED_FOLLOWUP_STEER_PREFIX.length, CARRIED_FOLLOWUP_STEER_PREFIX) as { originalRunId: string } | undefined;
  if (!steer) return [];
  return (db.prepare(`SELECT message_id AS id FROM invocation_current_turn_steers
    WHERE chat_id = ? AND run_id = ? AND status = 'rejected' AND code = ? ORDER BY created_at, rowid`)
    .all(chatId, steer.originalRunId, CARRIED_FOLLOWUP_CODE) as Array<{ id: string | null }>)
    .flatMap((row) => (typeof row.id === "string" && row.id ? [row.id] : []));
}
