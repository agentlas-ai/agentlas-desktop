import type Database from "better-sqlite3";

/**
 * A Goal's continuation is not an automation.
 *
 * Earlier versions wrote a hidden prompt automation ("Goal continuation · <chat>", prompt marked STORMBREAKER_LONG_RUN_MARKER,
 * goal_id set) when a turn ended with work left, and the host treated an enabled one as the owner of the Goal's next step.
 * Such a row could be enabled with next_run_at NULL, so it woke nobody, and a chat could have two.
 * The host already wakes a Goal by itself (InvocationService.scheduleGoalContinuation → blocked-goal sweep), so the
 * turn end now asks for that wake and creates nothing.
 *
 * The rows that exist are history, not jobs: they are switched off once (never deleted, run history kept), with a
 * retirement record in `meta`, kept out of every automation list and of the scheduler, and cannot be switched on.
 * Only `automations.goal_id` plus the long-run marker identify them; client.ts used to be the only writer of `goal_id`
 * (IPC refuses it: automation_workspace_goal_association_untrusted).
 */

/** Same literal as hephaestus/loop-engineering.ts STORMBREAKER_LONG_RUN_MARKER (a gate asserts they match). */
export const GOAL_CONTINUATION_PROMPT_MARKER = "<<stormbreaker-long-run>>";

/** SQL predicate over an `automations` row (optional alias) that is a Goal continuation. */
export function goalContinuationRowSql(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `(${p}goal_id IS NOT NULL AND COALESCE(instr(${p}prompt_template, '${GOAL_CONTINUATION_PROMPT_MARKER}'), 0) > 0)`;
}

export function isGoalContinuationAutomation(row: { goalId?: string | null; promptTemplate?: string | null }): boolean {
  return Boolean(row.goalId && row.promptTemplate?.includes(GOAL_CONTINUATION_PROMPT_MARKER));
}

/** Long-run transition and follow-up reason when a finite Goal turn ends with safe work left (service.ts turn end). */
export const GOAL_CONTINUATION_HOST_WAKE = "goal_continuation_host_wake";

export const GOAL_CONTINUATION_RETIRED_META_PREFIX = "automation.goal-continuation-retired:";
export const GOAL_CONTINUATION_RETIRED_SCHEMA = "agentlas.goal-continuation-retired.v1";
export const GOAL_CONTINUATION_RETIRED_CODE = "goal_continuation_automation_retired";

export interface RetiredGoalContinuation {
  automationId: string;
  goalId: string;
  wasEnabled: boolean;
  nextRunAt: string | null;
}

/**
 * Boot repair (store/db.ts runStoreRepairProjections; owner process only, deferred during update continuity).
 * Idempotent: a row with a retirement record is left as it is; a row without one is switched off and recorded.
 * Never deletes a row, its run history, its receipts or its schedule fields (next_run_at stays as found).
 */
export function retireGoalContinuationAutomationsInDb(db: Database.Database, now = new Date()): RetiredGoalContinuation[] {
  const automationsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automations'").get();
  const metaTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!automationsTable || !metaTable) return [];
  const columns = new Set((db.prepare("PRAGMA table_info(automations)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!columns.has("goal_id") || !columns.has("prompt_template")) return [];
  const rows = db.prepare(`SELECT a.id, a.goal_id AS goalId, a.enabled, a.next_run_at AS nextRunAt, a.run_count AS runCount,
      a.created_at AS createdAt FROM automations a
    WHERE ${goalContinuationRowSql("a")}
      AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = ? || a.id)
    ORDER BY a.created_at`).all(GOAL_CONTINUATION_RETIRED_META_PREFIX) as Array<{
      id: string; goalId: string; enabled: number; nextRunAt: string | null; runCount: number | null; createdAt: string }>;
  const retired: RetiredGoalContinuation[] = [];
  const at = now.toISOString();
  for (const row of rows) {
    if (row.enabled === 1) db.prepare("UPDATE automations SET enabled = 0 WHERE id = ? AND enabled = 1").run(row.id);
    db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING").run(
      `${GOAL_CONTINUATION_RETIRED_META_PREFIX}${row.id}`,
      JSON.stringify({ schema: GOAL_CONTINUATION_RETIRED_SCHEMA, retiredAt: at, reasonCode: GOAL_CONTINUATION_RETIRED_CODE,
        automationId: row.id, goalId: row.goalId, automationCreatedAt: row.createdAt, wasEnabled: row.enabled === 1,
        nextRunAt: row.nextRunAt, runCount: row.runCount ?? 0, wakeOwner: "host-goal-continuation" }),
    );
    retired.push({ automationId: row.id, goalId: row.goalId, wasEnabled: row.enabled === 1, nextRunAt: row.nextRunAt });
  }
  return retired;
}
