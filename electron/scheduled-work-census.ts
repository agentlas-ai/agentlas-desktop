// Scheduled work a quit would silently drop: an enabled automation or reminder whose next run is
// still ahead, and a Goal wait that is still pending. While the app is not running neither fires.
//
// Pure counting (no Electron, no store import) so a plain-Node gate covers the rule; `gatherScheduledWork`
// is the one place that reads the stores. Counts only: nothing is written, nothing is cached.

/** Only what is about to be missed matters for a quit question: a weekly job eight days out is not "lost" by quitting today. */
export const SCHEDULED_WORK_HORIZON_MS = 24 * 60 * 60 * 1000;

export interface ScheduledAutomationFact { enabled: boolean; nextRunAt: string | null }
export interface ScheduledGoalWaitFact { state: string; nextCheckAt: string | null }

function within(iso: string | null, nowMs: number, horizonMs: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  // A past next_run_at is due now: the scheduler fires it on its next tick, so quitting loses it too.
  return Number.isFinite(at) && at <= nowMs + horizonMs;
}

export function countScheduledWork(input: {
  automations: readonly ScheduledAutomationFact[];
  goalWaits: readonly ScheduledGoalWaitFact[];
  nowMs: number;
  horizonMs?: number;
}): number {
  const horizon = input.horizonMs ?? SCHEDULED_WORK_HORIZON_MS;
  let count = 0;
  for (const item of input.automations) if (item.enabled && within(item.nextRunAt, input.nowMs, horizon)) count += 1;
  for (const item of input.goalWaits) if (item.state === "pending" && within(item.nextCheckAt, input.nowMs, horizon)) count += 1;
  return count;
}
