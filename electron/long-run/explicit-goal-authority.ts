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
  // The owner's goal-mode turn that materialized this Goal: the earliest goal-mode turn in its root chat whose
  // prompt is the Goal's objective (checked below). No time bound against the ledger row: a Goal bound by the chip
  // gets its row a few ms BEFORE its first turn records invoke_started (measured 2026-09-25 on the owner's copy:
  // row 01:40:56.399Z, turn 01:40:56.409Z), so "started at/before the run" never matched a real chip Goal.
  // Only turns from the Goal's own creation onward (a minute of slack for the chip's row-before-turn order). Reading the
  // chat's 50 oldest turns instead never reached a Goal started in a busy room: production 2026-10-17, the YouTube room
  // had 320 turns, the owner's /goal turn was not among the first 50, and the sweep deferred goal_owner_grant_unrecorded
  // every 10 minutes with 15 videos made and none uploaded.
  const since = new Date(Date.parse(run.created_at) - 60_000).toISOString();
  const starts = db.prepare(`SELECT run_id, payload_json FROM run_events WHERE chat_id = ? AND kind = 'invoke_started'
    AND ts >= ? ORDER BY ts ASC LIMIT 50`).all(run.root_chat_id, since) as Array<{ run_id: string; payload_json: string }>;
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

/**
 * The owner's own message turn that is running now, as the grant of an explicit Goal that has none recorded.
 *
 * Production 2026-10-24, room "X Marketing" (4c724ece): One's teammate defined the room's Goal through app.call
 * chats.defineGoal during an ordinary conversation turn. That path (ipc chats:defineGoal) made the ledger row only: no
 * contract row, no revision, and no goal-mode turn whose text is the objective, so findExplicitGoalGrant had nothing to
 * read. The sweep then told the owner "Send one more message here and it continues from it" — and that message could
 * never be the grant: only a goal-mode turn whose prompt equals the objective counted. Every owner message after that
 * failed in 0 s ("The Goal just changed state") or with goal_episode_admission_missing, with no way out.
 *
 * The owner's message in the Goal's own root chat IS the recorded instruction that notice asks for: its invoke_started
 * (the permission the owner granted this turn) and invoke_prompt_bound (the durable user row) are written before the
 * turn reaches the model. This reads exactly that turn — never an older one, never a system or background turn — and
 * returns revision 1 for the Goal's existing objective and criteria. The caller passes only its own live, owner-authored
 * invocation id; nothing here infers authority from text.
 */
export function findOwnerTurnGoalGrant(db: Database.Database, goalId: string, invocationRunId: string): GoalRevision | null {
  if (!invocationRunId) return null;
  const run = db.prepare("SELECT id, root_chat_id, surface, objective, acceptance_criteria_json FROM long_runs WHERE goal_id = ?")
    .get(goalId) as { id: string; root_chat_id: string | null; surface: string; objective: string; acceptance_criteria_json: string } | undefined;
  if (!run || !run.root_chat_id || (run.surface !== "one" && run.surface !== "work")) return null;
  const chat = db.prepare("SELECT goal_id FROM chats WHERE id = ?").get(run.root_chat_id) as { goal_id: string | null } | undefined;
  if (!chat || chat.goal_id !== goalId) return null;
  const start = db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND chat_id = ? AND kind = 'invoke_started' LIMIT 1")
    .get(invocationRunId, run.root_chat_id) as { payload_json: string } | undefined;
  let payload: Record<string, unknown>;
  try { payload = start ? JSON.parse(start.payload_json) as Record<string, unknown> : {}; } catch { return null; }
  if (!start || payload.background === true || payload.promptOrigin === "system"
    || typeof payload.permissions !== "string" || !PERMISSIONS.has(payload.permissions)) return null;
  const bound = db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'invoke_prompt_bound' LIMIT 1")
    .get(invocationRunId) as { payload_json: string } | undefined;
  let messageId: unknown;
  try { messageId = bound ? (JSON.parse(bound.payload_json) as Record<string, unknown>).promptMessageId : undefined; } catch { messageId = undefined; }
  if (typeof messageId !== "string") return null;
  const message = db.prepare("SELECT id, chat_id, role, text FROM chat_messages WHERE id = ?").get(messageId) as
    { id: string; chat_id: string; role: string; text: string } | undefined;
  if (!message || message.chat_id !== run.root_chat_id || message.role !== "user" || !message.text.trim()) return null;
  const objective = run.objective.replace(/\s+/g, " ").trim();
  if (!objective) return null;
  let criteria: string[] = [];
  try { criteria = (JSON.parse(run.acceptance_criteria_json) as unknown[]).filter((c): c is string => typeof c === "string"); } catch { criteria = []; }
  const source = { chatId: run.root_chat_id, messageId: message.id, role: "user" as const, text: message.text };
  return {
    schemaVersion: AUTO_GOAL_SCHEMA, goalId, chatId: run.root_chat_id, revision: 1, parentRevision: null,
    originalRequest: source, sourceMessage: source, objective, reason: "owner_message_grant",
    lifecycle: resolveGoalLifecycle(undefined),
    acceptanceCriteria: criteria.map((text, index) => ({ id: `explicit-${index + 1}`, text })),
    authorityRefs: [`invocation:${invocationRunId}:permission:${payload.permissions}`],
    createdAt: new Date().toISOString(),
  };
}

/**
 * The contract row an explicit Goal must have, written from its own ledger row when it is missing. A Goal defined
 * through chats:defineGoal (or bound by the chip before its first turn) had a ledger row and no contract, and every
 * reader that needs the contract (the owner-message resume, the revision foreign key) refused it for good.
 * Only for the chat's CURRENT Goal: an older active contract of another goal id in the same chat is an orphan of a
 * cleared binding (armChatGoalContract retires those the same way). True when a row exists afterwards.
 */
export function ensureExplicitGoalContract(db: Database.Database, goalId: string): boolean {
  if (db.prepare("SELECT 1 FROM chat_goal_contracts WHERE goal_id = ? LIMIT 1").get(goalId)) return true;
  const run = db.prepare("SELECT root_chat_id, objective, acceptance_criteria_json, created_at FROM long_runs WHERE goal_id = ?")
    .get(goalId) as { root_chat_id: string | null; objective: string; acceptance_criteria_json: string; created_at: string } | undefined;
  if (!run?.root_chat_id) return false;
  const chat = db.prepare("SELECT goal_id FROM chats WHERE id = ?").get(run.root_chat_id) as { goal_id: string | null } | undefined;
  if (chat?.goal_id !== goalId) return false;
  const objective = run.objective.replace(/\s+/g, " ").trim();
  if (!objective) return false;
  let criteria: string[] = [];
  try { criteria = (JSON.parse(run.acceptance_criteria_json) as unknown[]).filter((c): c is string => typeof c === "string"); } catch { criteria = []; }
  const now = new Date().toISOString();
  db.prepare(`UPDATE chat_goal_contracts SET status = 'cancelled', updated_at = ?, completed_at = ?
    WHERE chat_id = ? AND goal_id <> ? AND status = 'active'`).run(now, now, run.root_chat_id, goalId);
  db.prepare(`INSERT INTO chat_goal_contracts (goal_id, chat_id, objective, acceptance_criteria_json, status, created_at, updated_at, completed_at)
    SELECT ?, ?, ?, ?, 'active', ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM chat_goal_contracts WHERE goal_id = ?)`)
    .run(goalId, run.root_chat_id, objective, JSON.stringify(criteria), run.created_at, now, goalId);
  return Boolean(db.prepare("SELECT 1 FROM chat_goal_contracts WHERE goal_id = ? LIMIT 1").get(goalId));
}

/** Store the recorded grant as revision 1, once. Null when a revision already exists or no grant is recorded.
 * `ownerTurn`: the caller's own live owner-authored invocation; used only when no goal-mode turn of the Goal is recorded. */
export function recoverExplicitGoalRevision(db: Database.Database, goalId: string, ownerTurn?: { invocationRunId: string }): GoalRevision | null {
  if (db.prepare("SELECT 1 FROM chat_goal_revisions WHERE goal_id = ? LIMIT 1").get(goalId)) return null;
  const revision = findExplicitGoalGrant(db, goalId) ?? (ownerTurn ? findOwnerTurnGoalGrant(db, goalId, ownerTurn.invocationRunId) : null);
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
export function adoptExplicitGoalGrant(goalId: string, ownerTurn?: { invocationRunId: string }): GoalRevision | null {
  const db = getDb();
  return db.transaction(() => {
    const revision = recoverExplicitGoalRevision(db, goalId, ownerTurn);
    if (!revision) return null;
    const run = db.prepare("SELECT id FROM long_runs WHERE goal_id = ?").get(goalId) as { id: string } | undefined;
    if (!run) throw new Error("explicit_goal_run_missing");
    // `adoptedFrom` stays the one value the producer admission accepts as this turn's own adoption (episode-disposition.ts);
    // `grant` says which record granted it.
    appendLongRunEvent({ runId: run.id, kind: "run.goal_revision_bound", actorKind: "host",
      payload: { revision: 1, previousRevision: null, receiptCursor: 0, sourceMessageId: revision.sourceMessage.messageId,
        adoptedFrom: "explicit_goal_turn", grant: revision.reason === "owner_message_grant" ? "owner_message" : "goal_mode_turn" } });
    return revision;
  })();
}
