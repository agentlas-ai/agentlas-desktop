/**
 * A Goal-bound chat has its own Main admission and lifecycle authority. The
 * adaptive-team preflight must not turn its canonical Task into a
 * `waiting-decision` Task while a Goal or its scheduled work owns the chat.
 * Keep this policy content-free so it can be exercised without opening the
 * application store or a provider runtime.
 */
const TERMINAL_GOAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isGoalOwnedOneChat(
  goalId: string | null | undefined,
  goalStatus?: string | null,
): boolean {
  // `pending` is a renderer-only optimistic chip value (TaskCockpit uses it
  // while Main is creating the durable Goal). It is not Goal ownership and
  // must not bypass preflight before Main confirms the binding.
  if (typeof goalId !== "string" || goalId.trim().length === 0 || goalId.trim() === "pending") return false;
  // A stale chat row can retain a terminal Goal id until the normal invocation
  // admission clears it. Terminal Goals must not suppress a new independent
  // team request. `undefined` means the status could not be inspected; callers
  // fail closed in that case, while explicit null means no durable Goal exists.
  if (goalStatus === null || (goalStatus !== undefined && TERMINAL_GOAL_STATUSES.has(goalStatus))) return false;
  return true;
}
