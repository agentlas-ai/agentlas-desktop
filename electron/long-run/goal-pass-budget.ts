/**
 * Wall-clock bound for one invocation's continuous pass loop.
 *
 * Production 2026-10-10 (Youtube launch room audit): the live pass loop of one invocation ran 93 minutes
 * (957b5262: eight 8-16 minute passes, ended only by the owner's cancel; c115cabb 5,569 s). Over seven days
 * the room's runs averaged 1,124 s against 430 s for Thread Marketing, 12 runs passed an hour, and every
 * owner steer queued behind such a run waited for it (queued steers drain when the invocation ends).
 *
 * The bound is checked only at a pass boundary, where the runtime turn has already ended: no tool is
 * killed and no half-written effect is left. The invocation then ends like any completed turn; the Goal
 * stays open, Main schedules the next invocation (scheduleGoalContinuation) from the Goal ledger and its
 * checkpoints, and the invocation service drains the owner steers queued meanwhile. Nothing is dropped,
 * because the pass that finished was already accounted in the ledger before this check.
 *
 * 20 minutes: about three of Thread Marketing's average runs and 1.3 to 2 of the room's usual passes, so a
 * normal run is untouched while the worst case falls from 93 minutes to the budget plus one pass.
 * A single runtime turn is never interrupted by this bound (only the boundary after it).
 */
export const GOAL_PASS_WALL_CLOCK_BUDGET_MS = 20 * 60_000;

export interface GoalPassBudgetStep {
  /** End this invocation at the boundary instead of starting another pass. */
  yieldNow: boolean;
  elapsedMs: number;
}

export function goalPassBudgetStep(input: {
  /** Only the host-driven continuous loop is bounded. */
  continuousMode: boolean;
  /** Another pass would start if nothing intervenes. */
  passShouldContinue: boolean;
  startedAtMs: number;
  nowMs: number;
  budgetMs?: number;
}): GoalPassBudgetStep {
  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);
  const budgetMs = input.budgetMs ?? GOAL_PASS_WALL_CLOCK_BUDGET_MS;
  return {
    yieldNow: input.continuousMode && input.passShouldContinue && Number.isFinite(elapsedMs) && elapsedMs >= budgetMs,
    elapsedMs,
  };
}
