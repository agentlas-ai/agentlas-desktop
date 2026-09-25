/**
 * Explicit (goal-chip) Goals had no stored revision, so every host recovery path treated them as "legacy without
 * a recorded grant": the blocked-goal sweep cancelled them (goal_authority_missing) the first time they stopped —
 * including a real owner Goal paused by quitting the app mid-turn — and the owner's Resume could not build a request.
 *
 * Automatic Goals get revision 1 at admission (auto-goal-controller). An explicit Goal's grant is just as real and
 * already recorded: the owner's goal-mode turn that created it (invoke_started with goalMode and its permission,
 * invoke_prompt_bound naming the durable user message). This reads that record — it never invents authority — and
 * stores the equivalent revision 1, once (and its contract row when the chip bound the Goal before its first turn). No such turn (a Goal defined by IPC only) → null: the caller must keep
 * the Goal (never cancel an owner-defined Goal for this) and let the owner's next message grant it.
 */
import type Database from "better-sqlite3";
import { getDb } from "../store/db";
import { appendLongRunEvent } from "../store/long-runs";
import { AUTO_GOAL_SCHEMA, type GoalRevision } from "../../shared/auto-goal";
import { resolveGoalLifecycle } from "../../shared/auto-goal";

const PERMISSIONS = new Set(["read", "write", "full"]);

/** Read-only: the revision this Goal's recorded goal-mode turn grants, or null. Nothing is written. */
export function findExplicitGoalGrant(db: Database.Database, goalId: string): GoalRevision | null {
  const run = db.prepare("SELECT id, root_chat_id, surface, objective, acceptance_criteria_json, created_at FROM long_runs WHERE goal_id = ?")
    .get(goalId) as { id: string; root_chat_id: string | null; surface: string; objective: string; acceptance_criteria_json: string; created_at: string } | undefined;
  if (!run || !run.root_chat_id || (run.surface !== "one" && run.surface !== "work")) return null;
  const chat = db.prepare("SELECT goal_id FROM chats WHERE id = ?").get(run.root_chat_id) as { goal_id: string | null } | undefined;
  if (!chat || chat.goal_id !== goalId) return null;
  // The owner's goal-mode turn that materialized this Goal: the last one in its root chat started at/before the run.
  const starts = db.prepare(`SELECT run_id, payload_json FROM run_events WHERE chat_id = ? AND kind = 'invoke_started' AND ts <= ?
    ORDER BY ts DESC LIMIT 20`).all(run.root_chat_id, run.created_at) as Array<{ run_id: string; payload_json: string }>;
  for (const start of starts) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(start.payload_json) as Record<string, unknown>; } catch { continue; }
    if (payload.goalMode !== true || typeof payload.permissions !== "string" || !PERMISSIONS.has(payload.permissions)) continue;
    const bound = db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'invoke_prompt_bound' LIMIT 1")
      .get(start.run_id) as { payload_json: string } | undefined;
    let messageId: unknown;
    try { messageId = bound ? (JSON.parse(bound.payload_json) as Record<string, unknown>).promptMessageId : undefined; } catch { messageId = undefined; }
    if (typeof messageId !== "string") continue;
    const message = db.prepare("SELECT id, chat_id, role, text FROM chat_messages WHERE id = ?").get(messageId) as
      { id: string; chat_id: string; role: string; text: string } | undefined;
    if (!message || message.chat_id !== run.root_chat_id || message.role !== "user"
      || message.text.replace(/\s+/g, " ").trim() !== run.objective) continue;
    let criteria: string[] = [];
    try { criteria = (JSON.parse(run.acceptance_criteria_json) as unknown[]).filter((c): c is string => typeof c === "string"); } catch { criteria = []; }
    const source = { chatId: run.root_chat_id, messageId: message.id, role: "user" as const, text: message.text };
    const now = new Date().toISOString();
    const revision: GoalRevision = {
      schemaVersion: AUTO_GOAL_SCHEMA, goalId, chatId: run.root_chat_id, revision: 1, parentRevision: null,
      originalRequest: source, sourceMessage: source, objective: message.text, reason: "explicit_goal_turn",
      lifecycle: resolveGoalLifecycle(undefined),
      acceptanceCriteria: criteria.map((text, index) => ({ id: `explicit-${index + 1}`, text })),
      authorityRefs: [`invocation:${start.run_id}:permission:${payload.permissions}`],
      createdAt: now,
    };
    return revision;
  }
  return null;
}

/** Store the recorded grant as revision 1, once. Null when a revision already exists or no grant is recorded. */
export function recoverExplicitGoalRevision(db: Database.Database, goalId: string): GoalRevision | null {
  if (db.prepare("SELECT 1 FROM chat_goal_revisions WHERE goal_id = ? LIMIT 1").get(goalId)) return null;
  const revision = findExplicitGoalGrant(db, goalId);
  if (!revision) return null;
  // A revision hangs off the Goal's contract. A Goal bound by the chip before its first turn got a ledger row but
  // no contract row (that turn found goal_id already set); the contract states the same objective and criteria.
  db.prepare(`INSERT INTO chat_goal_contracts (goal_id, chat_id, objective, acceptance_criteria_json, status, created_at, updated_at, completed_at)
    SELECT ?, ?, ?, ?, 'active', ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM chat_goal_contracts WHERE goal_id = ?)`)
    .run(goalId, revision.chatId, revision.objective.replace(/\s+/g, " ").trim(),
      JSON.stringify(revision.acceptanceCriteria.map((criterion) => criterion.text)), revision.createdAt, revision.createdAt, goalId);
  const inserted = db.prepare(`INSERT INTO chat_goal_revisions (goal_id, revision, source_message_id, payload_json, created_at)
    SELECT ?, 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM chat_goal_revisions WHERE goal_id = ?)`)
    .run(goalId, revision.sourceMessage.messageId, JSON.stringify(revision), revision.createdAt, goalId);
  return inserted.changes === 1 ? revision : null;
}

/**
 * Adopt: store revision 1 and bind it to the Goal's run without resetting its tasks or receipts (receiptCursor 0 —
 * the objective and criteria are the run's own, read from the same turn). The binding event advances the run
 * version like any ledger event, so call it only where no version fence is pending (the sweep, before dispatch).
 * Idempotent; null when no owner grant is recorded (the Goal is kept as it is — never cancelled for this).
 */
export function adoptExplicitGoalGrant(goalId: string): GoalRevision | null {
  const db = getDb();
  return db.transaction(() => {
    const revision = recoverExplicitGoalRevision(db, goalId);
    if (!revision) return null;
    const run = db.prepare("SELECT id FROM long_runs WHERE goal_id = ?").get(goalId) as { id: string } | undefined;
    if (!run) throw new Error("explicit_goal_run_missing");
    appendLongRunEvent({ runId: run.id, kind: "run.goal_revision_bound", actorKind: "host",
      payload: { revision: 1, previousRevision: null, receiptCursor: 0, sourceMessageId: revision.sourceMessage.messageId,
        adoptedFrom: "explicit_goal_turn" } });
    return revision;
  })();
}
