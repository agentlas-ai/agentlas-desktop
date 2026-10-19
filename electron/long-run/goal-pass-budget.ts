/**
















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
