/** Host-owned result presentation. Model text cannot grant completion. */
export interface GoalResultPresentation {
  goalId: string;
  runId: string | null;
  status: "pending" | "unverified" | "verified" | "legacy";
}
export function parseGoalResult(value: unknown): GoalResultPresentation | undefined {
  try {
    const v = typeof value === "string" ? JSON.parse(value) : value;
    if (!v || typeof v.goalId !== "string" || !v.goalId.trim()
      || !(v.runId === null || (typeof v.runId === "string" && v.runId.trim()))
      || !["pending", "unverified", "verified", "legacy"].includes(v.status)
      || (v.status === "verified" && !v.runId)) return undefined;
    return { goalId: v.goalId, runId: v.runId, status: v.status };
  } catch { return undefined; }
}

/** Late pending replays cannot demote a host-verified result for the same exact run. */
export function mergeGoalResults(a?: GoalResultPresentation, b?: GoalResultPresentation): GoalResultPresentation | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.goalId !== b.goalId || (a.runId && b.runId && a.runId !== b.runId)) return a;
  const rank = { legacy: 0, pending: 1, unverified: 2, verified: 3 };
  return rank[b.status] >= rank[a.status] ? b : a;
}
