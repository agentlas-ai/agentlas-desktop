/**
 * When this Goal will next start a model turn, why, and who asked for that time — the one line the owner sees
 * under the Goal ("다음 확인 15:11 · 모델 요청"). Read-only: it reports the arbiter's and the ledger's facts and
 * decides nothing.
 */
import type { GoalNextWake } from "../../shared/goal-wake";
import { getLongRunByGoalId, pendingBlockedGoalRetry } from "../store/long-runs";
import { latestGoalWaitSubscription } from "./wait-subscriptions";
import { GOAL_WAKE_DAILY_BUDGET, goalWakeWindow } from "./wake-arbiter";

export function goalNextWake(goalId: string, now = Date.now()): GoalNextWake | null {
  const run = getLongRunByGoalId(goalId);
  if (!run?.rootChatId || run.surface === "science") return null;
  if (["completed", "cancelled", "cancelling"].includes(run.status)) return null;
  const window = goalWakeWindow(run.id, run.rootChatId, now);
  const base = { wakesToday: window.count, budget: GOAL_WAKE_DAILY_BUDGET };
  const candidates: Array<Omit<GoalNextWake, "wakesToday" | "budget">> = [];
  const retry = pendingBlockedGoalRetry(run.id);
  if (retry) {
    candidates.push({ at: retry.nextAt, cause: retry.fromReason ?? "retry",
      requestedBy: retry.fromReason === "wake_budget_reached" ? "budget" : retry.requestedBy === "model" ? "model" : "host" });
  }
  const wait = latestGoalWaitSubscription(goalId);
  if (wait && wait.state === "pending" && wait.nextCheckAt) {
    candidates.push({ at: wait.nextCheckAt, cause: `wait:${wait.intent.subject.kind}`,
      requestedBy: wait.intent.subject.kind === "automation" ? "monitor" : "model" });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { ...candidates[0], ...base };
}
