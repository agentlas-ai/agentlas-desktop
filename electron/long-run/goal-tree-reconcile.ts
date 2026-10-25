/**
 * Goal tree consistency pass (owner 2026-10-25: "nothing should get tangled because of harness defects, from the goal tree
 * through every step of the conversation").
 *
 * Runs at the start of every blocked-goal sweep (the startup pass after recovery, then each minute) and is idempotent: every
 * repair moves a row toward the state its ended run
 * already states, only for rows a terminal run owns, and writes one ledger event per repair. Nothing is deleted; the owner's
 * goal history stays. A second run finds nothing to do.
 *
 *  - contract_follows_ended_run: a contract still active/blocked while its run is completed/failed/cancelled (completion
 *    paths that settle the run but not the contract, e.g. mcp/client.ts clears only the chat binding). The contract takes
 *    the run's outcome and the chat's goal pointer to it is cleared, as the owner's own Delete/Stop does.
 *  - tasks_follow_ended_run: open tasks under an ended run (transitionLongRun closes them on cancelled/failed only; model-
 *    declared completion left `waiting_worker` tasks under completed runs: production run_e7cb1b35, run_1cbd619c,
 *    run_00d45b3e; older cancelled runs predate the close).
 * Science runs are projections of Science's own state and are never touched here.
 */
import { getDb } from "../store/db";
import { appendLongRunEvent } from "../store/long-runs";
import { emitDesktopStoreChange } from "../store/change-bus";
import { LONG_RUN_OPEN_TASK_STATES } from "../../shared/long-run";

export const GOAL_TREE_RECONCILED_KIND = "run.goal_tree_reconciled";

export interface GoalTreeRepair { runId: string; goalId: string; repair: "contract_follows_ended_run" | "tasks_follow_ended_run"; detail: Record<string, unknown> }

export function reconcileGoalTree(now = new Date()): GoalTreeRepair[] {
  const db = getDb();
  const stamp = now.toISOString();
  const repairs: GoalTreeRepair[] = [];
  const touchedChats = new Set<string>();

  const contracts = db.prepare(`SELECT c.goal_id AS goalId, c.chat_id AS chatId, c.status, c.updated_at AS updatedAt,
      l.id AS runId, l.status AS runStatus, ch.goal_id AS chatGoalId
    FROM chat_goal_contracts c JOIN long_runs l ON l.goal_id = c.goal_id LEFT JOIN chats ch ON ch.id = c.chat_id
    WHERE c.status IN ('active','blocked') AND l.status IN ('completed','failed','cancelled') AND l.surface IN ('one','work')`)
    .all() as Array<{ goalId: string; chatId: string; status: string; updatedAt: string; runId: string; runStatus: string; chatGoalId: string | null }>;
  for (const row of contracts) {
    const to = row.runStatus === "completed" ? "completed" : "cancelled";
    const applied = db.transaction(() => {
      const changed = db.prepare(`UPDATE chat_goal_contracts SET status = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE goal_id = ? AND status = ? AND updated_at = ?`).run(to, stamp, stamp, row.goalId, row.status, row.updatedAt);
      if (changed.changes !== 1) return false;
      const wasBound = row.chatGoalId === row.goalId;
      if (wasBound) db.prepare("UPDATE chats SET goal_id = NULL, continuous_mode = 0, updated_at = ? WHERE id = ? AND goal_id = ?").run(stamp, row.chatId, row.goalId);
      const detail = { from: row.status, to, runStatus: row.runStatus, chatId: row.chatId, chatWasBound: wasBound, previousUpdatedAt: row.updatedAt };
      appendLongRunEvent({ runId: row.runId, kind: GOAL_TREE_RECONCILED_KIND, actorKind: "host", payload: { repair: "contract_follows_ended_run", ...detail } });
      repairs.push({ runId: row.runId, goalId: row.goalId, repair: "contract_follows_ended_run", detail });
      return wasBound;
    })();
    if (applied) touchedChats.add(row.chatId);
  }

  const states = [...LONG_RUN_OPEN_TASK_STATES];
  const runs = db.prepare(`SELECT DISTINCT l.id AS runId, l.goal_id AS goalId, l.status AS runStatus FROM long_run_tasks t JOIN long_runs l ON l.id = t.run_id
    WHERE l.status IN ('completed','failed','cancelled') AND l.surface IN ('one','work') AND t.state IN (${states.map(() => "?").join(",")})`)
    .all(...states) as Array<{ runId: string; goalId: string; runStatus: string }>;
  for (const run of runs) {
    db.transaction(() => {
      const open = db.prepare(`SELECT id, state FROM long_run_tasks WHERE run_id = ? AND state IN (${states.map(() => "?").join(",")})`)
        .all(run.runId, ...states) as Array<{ id: string; state: string }>;
      if (!open.length) return;
      db.prepare(`UPDATE long_run_tasks SET state = 'cancelled', updated_at = ?, completed_at = COALESCE(completed_at, ?)
        WHERE run_id = ? AND state IN (${states.map(() => "?").join(",")})`).run(stamp, stamp, run.runId, ...states);
      for (const task of open) appendLongRunEvent({ runId: run.runId, kind: "task.status_changed", actorKind: "host",
        payload: { taskId: task.id, from: task.state, to: "cancelled", reason: "run_ended" } });
      const detail = { runStatus: run.runStatus, tasks: open.map((task) => ({ id: task.id, from: task.state })) };
      appendLongRunEvent({ runId: run.runId, kind: GOAL_TREE_RECONCILED_KIND, actorKind: "host", payload: { repair: "tasks_follow_ended_run", ...detail } });
      repairs.push({ runId: run.runId, goalId: run.goalId, repair: "tasks_follow_ended_run", detail });
    })();
  }
  for (const chatId of touchedChats) emitDesktopStoreChange({ entity: "chat", id: chatId });
  return repairs;
}
