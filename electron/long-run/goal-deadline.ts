








import { goalCadenceDeadlineAt, type GoalLifecycle } from "../../shared/auto-goal";
import { getChatGoalRevision } from "../store/chat-goals";
import { readGoalPlan } from "../store/goal-plans";

/**
 * The current revision's host-resolved deadline, or null. A plan shaped for an older revision does not count.
 *
 * A bounded series ("1시간에 1회씩 최대 10개") carries its interval and run count on the revision (shared/auto-goal.ts
 * GoalCadence), so it has a deadline from admission on, before any plan exists: the end of its last scheduled run plus one
 * interval. The owner's own stated deadline, when the plan has one, wins.
 */
export function goalDeadlineAt(goalId: string): string | null {
  const revision = getChatGoalRevision(goalId);
  if (!revision) return null;
  const series = revision.cadence ? goalCadenceDeadlineAt(revision.createdAt, revision.cadence) : null;
  let plan: ReturnType<typeof readGoalPlan> = null;
  try { plan = readGoalPlan(goalId, revision.revision); } catch { return series; }
  if (!plan || plan.fallback || !plan.deadline_at || !Number.isFinite(Date.parse(plan.deadline_at))) return series;
  return plan.deadline_at;
}

export type TimerWaitAuthority =
  | { ok: true; lifecycle: GoalLifecycle; deadlineAt: string | null }
  | { ok: false; reason: "goal_wait_ongoing_authority_required" | "goal_wait_goal_deadline_passed"
      | "goal_wait_no_goal" | "goal_wait_goal_not_running" | "goal_wait_original_authority_missing" };

/** A timer is a scheduling request, not a new execution grant or lifecycle judgment.
 * Past classification, receipts and plan deadlines do not suspend registration.
 * Explicit Stop/cancellation is handled by the wait owner, not inferred here. */
export function goalTimerAuthorityForOwner(input: { lifecycle?: GoalLifecycle } = {}, _now?: number): TimerWaitAuthority {
  return { ok: true, lifecycle: input.lifecycle ?? "finite", deadlineAt: null };
}

export function timerWaitAuthority(goalId: string, now: number): TimerWaitAuthority {
  let lifecycle: GoalLifecycle | undefined;
  // Classification is optional display metadata; an old/malformed revision cannot veto a timer.
  try { lifecycle = getChatGoalRevision(goalId)?.lifecycle; } catch { /* keep the scheduling request */ }
  return goalTimerAuthorityForOwner({ lifecycle }, now);
}
