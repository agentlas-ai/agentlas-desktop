/**
 * What a goal looks like to the owner — one typed rule for One, Work and the sidebar comet.
 *
 * Owner correction 2026-09-28: "시간으로 보면 안 되고, 자동화 계획 따라 안 움직일 수도 있잖아. 그럴 때 일시정지된
 * 거처럼 골 칩을 이상하게 띄우지 말고 작동 중과 똑같게 해 둬야지. 명시적 멈춤이 멈춤 아니냐."
 *
 *  - running      a turn is running, OR the goal is between turns waiting for its next scheduled/continuation run
 *                 (queued, waiting_worker, waiting_tool, a host-owned retry), OR the app paused it by itself
 *                 (app_closed, crash_recovery, runtime_unavailable, agent_paused) and will continue it. Same look.
 *  - paused       only an explicit owner pause (pauseReason "user", or a paused row with no recorded reason).
 *  - needs_owner  explicit owner-needed states: an approval or budget stop, waiting_user, or the goal asked the
 *                 owner a question, or a host review requires a decision.
 *  - blocked      an explicit blocked status with its typed reason.
 *  - terminal     completed / failed / cancelled / cancelling.
 * Nothing here reads a clock.
 */
export type GoalDisplayState = "running" | "paused" | "needs_owner" | "blocked" | "terminal" | "none";

/** Pauses the app took on its own; the goal continues without the owner. */
export const GOAL_HOST_PAUSE_REASONS: ReadonlySet<string> = new Set(["app_closed", "crash_recovery", "runtime_unavailable", "agent_paused"]);
/** Pauses that need the owner's consent or grant. */
export const GOAL_OWNER_NEEDED_PAUSE_REASONS: ReadonlySet<string> = new Set(["approval_required", "budget"]);
/** Blocked reasons that are a question to the owner. */
export const GOAL_OWNER_QUESTION_REASONS: ReadonlySet<string> = new Set(["goal_owner_answer_required"]);

/** A host review has no implied pending question. */
export const GOAL_OWNER_REVIEW_REASONS: ReadonlySet<string> = new Set(["auto_goal_owner_review_required"]);
export type GoalOwnerAttention = "question" | "review" | "approval" | "budget";
export function goalOwnerAttention(input: { status: string | null | undefined; pauseReason?: string | null; blockedReason?: string | null }): GoalOwnerAttention | null {
  if (input.status === "waiting_user") return "question";
  if (input.status === "blocked") {
    if (GOAL_OWNER_QUESTION_REASONS.has(input.blockedReason ?? "")) return "question";
    if (GOAL_OWNER_REVIEW_REASONS.has(input.blockedReason ?? "")) return "review";
  }
  if (input.status === "paused" || input.status === "pausing") {
    if (input.pauseReason === "approval_required") return "approval";
    if (input.pauseReason === "budget" || input.pauseReason?.startsWith("budget_")) return "budget";
  }
  return null;
}

const RUNNING_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "waiting_worker", "waiting_tool", "verifying"]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "cancelling"]);

export function goalDisplayState(input: { status: string | null | undefined; pauseReason?: string | null; blockedReason?: string | null }): GoalDisplayState {
  const status = input.status ?? null;
  const pauseReason = input.pauseReason ?? null;
  if (!status || status === "draft") return "none";
  if (TERMINAL_STATUSES.has(status)) return "terminal";
  if (status === "paused" || status === "pausing") {
    if (pauseReason && GOAL_HOST_PAUSE_REASONS.has(pauseReason)) return "running";
    if (pauseReason && (GOAL_OWNER_NEEDED_PAUSE_REASONS.has(pauseReason) || pauseReason.startsWith("budget_"))) return "needs_owner";
    return status === "pausing" && pauseReason !== "user" ? "running" : "paused";
  }
  if (status === "blocked") return goalOwnerAttention(input) ? "needs_owner" : "blocked";
  if (status === "waiting_user") return "needs_owner";
  if (RUNNING_STATUSES.has(status)) return "running";
  return "none";
}

/** long_runs statuses the sidebar comet spins for between turns (Main SQL list; host pauses are checked by reason). */
export const GOAL_SPINNING_STATUSES = ["queued", "running", "waiting_worker", "waiting_tool", "verifying"] as const;







export function stoppedGoalMessageReopens(goal: { status: string; blockedReason?: string | null },
  taskIntent: string | undefined): { reopens: boolean; ownerAnswer: boolean } {
  if (goal.status !== "blocked" && goal.status !== "paused" && goal.status !== "waiting_tool") return { reopens: false, ownerAnswer: false };
  const ownerAnswer = goal.status === "blocked" && GOAL_OWNER_QUESTION_REASONS.has(goal.blockedReason ?? "");
  return { reopens: taskIntent !== "conversation" || ownerAnswer, ownerAnswer };
}
