/**
 * The big ledgers of a deleted conversation, removed in small pieces (Agentlas 2.0 N4 carry-over, the "delete chain in batches").
 *
 * Deleting a conversation used to delete its Goal run and its agent-context journal inside the one delete transaction, and the foreign
 * key cascade took every event line and every journal entry with them: 400,000 + 400,000 of them held Main for 2.3 s (the window and
 * the phone bridge stand still while a transaction runs). Now the delete transaction only DETACHES such a ledger, which is one row each:
 *   - a Goal run with more than HEAVY_LEDGER_ROWS event lines keeps its row but loses its Goal: `goal_id` becomes `deleted-goal:<run id>`
 *     (the run is already closed by closeGoal and its chat link is cut by the chat row going), so nothing that looks a Goal up by its
 *     id or lists a conversation's runs can find it;
 *   - a journal head with more than HEAVY_LEDGER_ROWS entries keeps its row but its visibility domain becomes `deleted-chat:<key>`,
 *     so no conversation, agent or handoff read can name it.
 * This module then removes the lines in pieces of DRAIN_CHUNK rows, each step bounded by DRAIN_STEP_BUDGET_MS, one step per event-loop
 * turn with DRAIN_GAP_MS between steps. It is not periodic: a drain starts after a delete that detached something and once after the
 * start (the maintenance pass), runs while something is left and ends. The marker is the detached row itself (read only here, deleted
 * here when its last line is gone), so a process that dies in the middle leaves exactly what the next drain continues from; no table,
 * column or key was added. Both processes may drain: every statement is idempotent.
 */
import { getDb } from "../store/db";

export const HEAVY_LEDGER_ROWS = 2_000;
export const DRAIN_CHUNK = 2_000;
export const DRAIN_STEP_BUDGET_MS = 25;
export const DRAIN_GAP_MS = 15;
export const DELETED_GOAL_PREFIX = "deleted-goal:";
export const DELETED_CHAT_DOMAIN_PREFIX = "deleted-chat:";
const MAX_CONSECUTIVE_ERRORS = 5;

type Db = ReturnType<typeof getDb>;

export const deletedGoalId = (runId: string): string => `${DELETED_GOAL_PREFIX}${runId}`;
export const deletedChatDomain = (contextKey: string): string => `${DELETED_CHAT_DOMAIN_PREFIX}${contextKey}`;

/** True when the run has more than HEAVY_LEDGER_ROWS event lines (an index range read of at most that many entries). */
export function runLedgerIsHeavy(db: Db, runId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM long_run_events WHERE run_id = ? LIMIT 1 OFFSET ?").get(runId, HEAVY_LEDGER_ROWS));
}

/** One step: removes up to the time budget of detached ledger rows. Returns the rows removed and whether anything is left. */
export function drainDeletedChatLedgersStep(db: Db = getDb(), budgetMs = DRAIN_STEP_BUDGET_MS): { rows: number; remaining: boolean } {
  const started = Date.now();
  let rows = 0;
  const over = (): boolean => Date.now() - started >= budgetMs;
  // Goal runs first. A run that is not closed (a state this module did not detach) is never touched.
  for (;;) {
    const run = db.prepare("SELECT id FROM long_runs WHERE goal_id >= ? AND goal_id < ? AND status IN ('completed','failed','cancelled') LIMIT 1")
      .get(DELETED_GOAL_PREFIX, `${DELETED_GOAL_PREFIX}￿`) as { id: string } | undefined;
    if (!run) break;
    for (;;) {
      const removed = db.prepare("DELETE FROM long_run_events WHERE run_id = ? AND seq IN (SELECT seq FROM long_run_events WHERE run_id = ? ORDER BY seq LIMIT ?)")
        .run(run.id, run.id, DRAIN_CHUNK).changes;
      rows += removed;
      if (removed < DRAIN_CHUNK) {
        // The rest of the run (tasks, workers, attempts, messages, receipts) is small: the cascade takes it.
        db.prepare("DELETE FROM long_runs WHERE id = ? AND goal_id >= ? AND goal_id < ?").run(run.id, DELETED_GOAL_PREFIX, `${DELETED_GOAL_PREFIX}￿`);
        break;
      }
      if (over()) return { rows, remaining: true };
    }
    if (over()) return { rows, remaining: true };
  }
  for (;;) {
    const head = db.prepare("SELECT context_key AS key FROM agent_context_heads WHERE json_valid(identity_json) AND json_extract(identity_json, '$.visibilityDomain') >= ? AND json_extract(identity_json, '$.visibilityDomain') < ? LIMIT 1")
      .get(DELETED_CHAT_DOMAIN_PREFIX, `${DELETED_CHAT_DOMAIN_PREFIX}￿`) as { key: string } | undefined;
    if (!head) break;
    for (;;) {
      const removed = db.prepare("DELETE FROM agent_context_entries WHERE rowid IN (SELECT rowid FROM agent_context_entries WHERE context_key = ? LIMIT ?)").run(head.key, DRAIN_CHUNK).changes;
      rows += removed;
      if (removed < DRAIN_CHUNK) {
        // Bindings, deliveries and acknowledged blocks are small: the cascade takes them with the head.
        db.prepare("DELETE FROM agent_context_heads WHERE context_key = ?").run(head.key);
        break;
      }
      if (over()) return { rows, remaining: true };
    }
    if (over()) return { rows, remaining: true };
  }
  return { rows, remaining: false };
}

/** Whether any detached ledger is left (two index reads). */
export function deletedChatLedgersLeft(db: Db = getDb()): boolean {
  if (db.prepare("SELECT 1 FROM long_runs WHERE goal_id >= ? AND goal_id < ? LIMIT 1").get(DELETED_GOAL_PREFIX, `${DELETED_GOAL_PREFIX}￿`)) return true;
  return Boolean(db.prepare("SELECT 1 FROM agent_context_heads WHERE json_valid(identity_json) AND json_extract(identity_json, '$.visibilityDomain') >= ? AND json_extract(identity_json, '$.visibilityDomain') < ? LIMIT 1")
    .get(DELETED_CHAT_DOMAIN_PREFIX, `${DELETED_CHAT_DOMAIN_PREFIX}￿`));
}

let draining = false;
let stopped = false;
let detachedHint = false;

/** A delete transaction detached a ledger (set inside it; a rolled-back transaction leaves a hint that costs one empty step). */
export function noteLedgerDetached(): void { detachedHint = true; }
/** After the delete committed: drain only when something was detached, so an ordinary delete costs nothing here. */
export function scheduleDeletedChatLedgerDrainIfDetached(): void {
  if (!detachedHint) return;
  detachedHint = false;
  scheduleDeletedChatLedgerDrain();
}

/** Starts a drain unless one is running in this process. Self-chaining: one step per timer turn, nothing left means no timer. */
export function scheduleDeletedChatLedgerDrain(delayMs = 0): void {
  if (draining || stopped) return;
  draining = true;
  let errors = 0;
  const step = (): void => {
    if (stopped) { draining = false; return; }
    let remaining = false;
    try {
      remaining = drainDeletedChatLedgersStep().remaining;
      errors = 0;
    } catch {
      // A busy or closing store: a few more tries, then the next start continues from the detached rows.
      errors += 1;
      remaining = errors < MAX_CONSECUTIVE_ERRORS;
    }
    if (!remaining) { draining = false; return; }
    const timer = setTimeout(step, errors > 0 ? 2_000 : DRAIN_GAP_MS);
    timer.unref?.();
  };
  const first = setTimeout(step, Math.max(0, delayMs));
  first.unref?.();
}

/** Test/shutdown seam. */
export function stopDeletedChatLedgerDrain(): void { stopped = true; }
export function resetDeletedChatLedgerDrain(): void { stopped = false; draining = false; }
