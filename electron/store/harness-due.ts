/**
 * harness_due: the one line a conversation has for "when the host looks at this Goal next" (Agentlas 2.0 N3b, decision;
 * docs/Agentlas2.0/audit/39-design-n-agentlas-harness.md section 11). The only table the Agentlas Harness adds, and it adds no column
 * to any other table.
 *
 *   chat_id  primary key, ON DELETE CASCADE: deleting the conversation deletes its line (no cleanup pass exists or is needed).
 *   due_at   the next look, ISO. NULL = taken: the host that started the turn emptied it (only due_at - the cause stays for the audit
 *            until the turn ends and the next decision overwrites or deletes the line).
 *   cause    the closed code the schedule stands on (the blocker the retry stands in for, or the detail code of the schedule).
 *   updated_at
 *
 * WHO WRITES: store/long-runs.ts scheduleBlockedGoalRetry (every schedule, in the same transaction as its ledger event);
 *             claimHarnessDue (the host that starts the turn takes the line); the startup backfill below (old schedules).
 * WHO READS:  store/long-runs.ts pendingBlockedGoalRetry (the next-look time of a Goal resting on a host retry: the sweep, the Goal
 *             panel's "next check" line, the wake planner, the parked-relay pull-forward all read it through that one function);
 *             earliestHarnessDue (the one timer of the harness, long-run/goal-signals.ts, aims at MIN(due_at): the only reader of the
 *             column as a time for the whole table). The `cause` column has no reader: N4's close (store/goal-close.ts) does not read it either (it deletes the line by conversation, whatever the cause), no Goal display and no timer needs it; it is kept for the audit only.
 * WHEN DELETED: the Goal closes (completed, failed, cancelled), the owner stops it or the Goal waits for the owner's answer
 *             (closeGoal in store/goal-close.ts for every close; clearHarnessDue from transitionLongRun / holdGoalForOwnerAnswer / the owner-card parks for the waits), the conversation is deleted
 *             (CASCADE). A turn that starts only empties due_at; a turn that ends with a next decision overwrites the line (one line per
 *             conversation, so nothing accumulates: size = the number of Goals that rest on a schedule); pruneDeadHarnessDue (a line
 *             whose Goal run is finished, deleted by the timer's own look and at startup).
 * The line is a cache of the schedule, never its only copy: the ledger event of the schedule carries the retry index, the blocker and
 * who asked for the time, so a lost or never-written line only costs the next look being read from the event (pendingBlockedGoalRetry
 * falls back to it), and backfillHarnessDue rebuilds every line of a store that has only the old events (1.3.139 and earlier).
 */
import type Database from "better-sqlite3";
import { GOAL_OWNER_ANSWER_REQUIRED } from "../../shared/goal-display-state";
import { getDb } from "./db";

export interface HarnessDueRow {
  chatId: string;
  dueAt: string | null;
  cause: string;
  updatedAt: string;
}

type Db = Database.Database;
const CAUSE_MAX = 120;

export function upsertHarnessDueInDb(db: Db, input: { chatId: string; dueAt: string; cause: string; now?: string }): void {
  const now = input.now ?? new Date().toISOString();
  // The chat can be gone (long_runs.root_chat_id is SET NULL on delete): the foreign key then refuses, and no line is the right answer.
  db.prepare(`INSERT INTO harness_due (chat_id, due_at, cause, updated_at)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chats WHERE id = ?)
    ON CONFLICT(chat_id) DO UPDATE SET due_at = excluded.due_at, cause = excluded.cause, updated_at = excluded.updated_at`)
    .run(input.chatId, input.dueAt, input.cause.slice(0, CAUSE_MAX), now, input.chatId);
}

export function harnessDueFor(chatId: string): HarnessDueRow | null {
  const row = getDb().prepare("SELECT chat_id AS chatId, due_at AS dueAt, cause, updated_at AS updatedAt FROM harness_due WHERE chat_id = ?")
    .get(chatId) as HarnessDueRow | undefined;
  return row ?? null;
}

/**
 * Takes the line: only the caller whose read of due_at is still the stored value wins. The changed-row count is the answer, so two
 * processes (Main and the background service, or two sweeps) that see the same due time start the turn once.
 */
export function claimHarnessDue(db: Db, chatId: string, dueAt: string): boolean {
  return db.prepare("UPDATE harness_due SET due_at = NULL, updated_at = ? WHERE chat_id = ? AND due_at = ?")
    .run(new Date().toISOString(), chatId, dueAt).changes === 1;
}

/** The Goal closed, the owner stopped it, or it waits for the owner: no next look exists. */
export function clearHarnessDueInDb(db: Db, chatId: string | null | undefined): void {
  if (!chatId) return;
  db.prepare("DELETE FROM harness_due WHERE chat_id = ?").run(chatId);
}

export function clearHarnessDue(chatId: string | null | undefined): void {
  clearHarnessDueInDb(getDb(), chatId);
}

/**
 * The line of the earliest next look, or null. One indexed read; the timer of N3c is its only caller. `skipChats` leaves out the
 * conversations whose turn is live in this process: their look is the end of that turn, not a time (a line that fell due behind a
 * running turn would otherwise be asked about again and again until the turn ends).
 */
export function earliestHarnessDue(skipChats?: ReadonlySet<string>): { chatId: string; dueAt: string } | null {
  if (!skipChats || skipChats.size === 0) {
    const row = getDb().prepare("SELECT chat_id AS chatId, due_at AS dueAt FROM harness_due WHERE due_at IS NOT NULL ORDER BY due_at LIMIT 1")
      .get() as { chatId: string; dueAt: string } | undefined;
    return row ?? null;
  }
  const rows = getDb().prepare("SELECT chat_id AS chatId, due_at AS dueAt FROM harness_due WHERE due_at IS NOT NULL ORDER BY due_at LIMIT ?")
    .all(skipChats.size + 1) as Array<{ chatId: string; dueAt: string }>;
  return rows.find((row) => !skipChats.has(row.chatId)) ?? null;
}

/**
 * SAFETY NET since N4 (closeGoal deletes the line of every Goal it closes): what remains for this function is a line an older build left, and a
 * line a late writer (a turn that was ending while the Goal closed) re-created. Lines that no Goal owns any more: the conversation's Goal run is finished (or there is none). Such a line would stay due for ever and the
 * timer would ask about it every minute; a Goal that ends through any path that did not clear its line leaves exactly this. Run by the
 * timer's own look at the lines (long-run/goal-signals.ts) and once at startup; writes only when a line is deleted. Returns the count.
 */
export function pruneDeadHarnessDue(db: Db = getDb()): number {
  return db.prepare(`DELETE FROM harness_due WHERE NOT EXISTS (SELECT 1 FROM long_runs r WHERE r.root_chat_id = harness_due.chat_id
    AND r.status NOT IN ('completed','failed','cancelled'))`).run().changes;
}

/**
 * Startup, once per process, idempotent: a store that has only the old schedule events (written by builds before this table) gets one
 * line for every Goal that rests on such a schedule, with the time of the newest event. Existing lines are never touched, so a second
 * start changes nothing (0 rows written). Returns the number of lines created.
 */
export function backfillHarnessDue(): number {
  const db = getDb();
  const rows = db.prepare(`SELECT r.id AS runId, r.root_chat_id AS chatId,
      json_extract(e.payload_json, '$.nextAt') AS nextAt, COALESCE(json_extract(e.payload_json, '$.fromReason'), json_extract(e.payload_json, '$.detail'), 'retry') AS cause
    FROM long_runs r
    JOIN long_run_events e ON e.run_id = r.id AND e.seq = (SELECT MAX(x.seq) FROM long_run_events x WHERE x.run_id = r.id AND x.kind = 'run.blocked_sweep')
    WHERE (r.status = 'waiting_tool' OR (r.status = 'paused' AND r.pause_reason IN ('app_closed','crash_recovery')))
      AND r.root_chat_id IS NOT NULL AND r.surface IN ('one','work') AND COALESCE(r.blocked_reason, '') != ?
      AND json_extract(e.payload_json, '$.action') = 'retry_scheduled' AND json_extract(e.payload_json, '$.nextAt') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM long_run_events s WHERE s.run_id = r.id AND s.seq > e.seq AND (
        (s.kind = 'run.status_changed' AND json_extract(s.payload_json, '$.to') NOT IN ('waiting_tool','paused'))
        OR s.kind IN ('run.user_control','run.wait_subscription')))
      AND NOT EXISTS (SELECT 1 FROM harness_due d WHERE d.chat_id = r.root_chat_id)
      AND EXISTS (SELECT 1 FROM chats c WHERE c.id = r.root_chat_id)`).all(GOAL_OWNER_ANSWER_REQUIRED) as Array<{ runId: string; chatId: string; nextAt: string; cause: string }>;
  // A line taken more than an hour ago whose turn ended with no next decision (the turn finished the Goal's step and wrote nothing) is
  // dead weight: one row per conversation at most, deleted here once per start and with the conversation.
  db.prepare("DELETE FROM harness_due WHERE due_at IS NULL AND updated_at < ?").run(new Date(Date.now() - 3_600_000).toISOString());
  pruneDeadHarnessDue(db);
  if (!rows.length) return 0;
  let created = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (!Number.isFinite(Date.parse(row.nextAt))) continue;
      upsertHarnessDueInDb(db, { chatId: row.chatId, dueAt: row.nextAt, cause: row.cause });
      created += 1;
    }
  }).immediate();
  return created;
}
