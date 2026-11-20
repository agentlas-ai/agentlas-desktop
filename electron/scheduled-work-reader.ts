// Reads the stores for scheduled-work-census.ts. Kept apart so the counting rule stays a plain-Node pure module.
import { getDb } from "./store/db";
import { latestGoalWaitSubscription } from "./long-run/wait-subscriptions";
import { effectiveWaitCheckAt } from "./long-run/wait-engine";
import { countScheduledWork, type ScheduledAutomationFact, type ScheduledGoalWaitFact } from "./scheduled-work-census";

/** How many scheduled items a quit now would stop from firing. Never throws: an unreadable store is "none", the quit must not stall on it. */
export function readScheduledWorkCount(nowMs = Date.now()): number {
  try {
    const db = getDb();
    const automations = (db.prepare("SELECT enabled, next_run_at FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL").all() as Array<{ enabled: number; next_run_at: string | null }>)
      .map((row): ScheduledAutomationFact => ({ enabled: row.enabled === 1, nextRunAt: row.next_run_at }));
    const goalWaits: ScheduledGoalWaitFact[] = [];
    const runs = db.prepare("SELECT goal_id FROM long_runs WHERE status = 'waiting_tool' AND execution_location = 'desktop-local' AND surface != 'science'").all() as Array<{ goal_id: string }>;
    for (const run of runs) {
      const wait = latestGoalWaitSubscription(run.goal_id);
      if (wait) goalWaits.push({ state: wait.state, nextCheckAt: effectiveWaitCheckAt(wait, nowMs) });
    }
    return countScheduledWork({ automations, goalWaits, nowMs });
  } catch { return 0; }
}
