








import { getChatGoalRevision } from "../store/chat-goals";
import { readGoalPlan } from "../store/goal-plans";

/** The current revision's host-resolved deadline, or null. A plan shaped for an older revision does not count. */
export function goalDeadlineAt(goalId: string): string | null {
  const revision = getChatGoalRevision(goalId);
  if (!revision) return null;
  let plan: ReturnType<typeof readGoalPlan> = null;
  try { plan = readGoalPlan(goalId, revision.revision); } catch { return null; }
  if (!plan || plan.fallback || !plan.deadline_at || !Number.isFinite(Date.parse(plan.deadline_at))) return null;
  return plan.deadline_at;
}

export type TimerWaitAuthority =
  | { ok: true; lifecycle: "ongoing"; deadlineAt: null }
  | { ok: true; lifecycle: "finite"; deadlineAt: string }
  | { ok: false; reason: "goal_wait_ongoing_authority_required" | "goal_wait_goal_deadline_passed" };

export function timerWaitAuthority(goalId: string, now: number): TimerWaitAuthority {
  const revision = getChatGoalRevision(goalId);
  if (revision?.lifecycle === "ongoing") return { ok: true, lifecycle: "ongoing", deadlineAt: null };
  const deadlineAt = goalDeadlineAt(goalId);
  if (!deadlineAt) return { ok: false, reason: "goal_wait_ongoing_authority_required" };
  if (Date.parse(deadlineAt) <= now) return { ok: false, reason: "goal_wait_goal_deadline_passed" };
  return { ok: true, lifecycle: "finite", deadlineAt };
}
