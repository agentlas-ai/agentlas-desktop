/** Host-owned result presentation. Model text cannot grant completion. */
export interface GoalResultPresentation {
  goalId: string;
  runId: string | null;
  status: "pending" | "unverified" | "verified" | "legacy";
  verificationScope?: "goal" | "episode";
  verificationState?: "not_requested" | "pending" | "passed" | "inconclusive" | "failed";
}
export function parseGoalResult(value: unknown): GoalResultPresentation | undefined {
  try {
    const v = typeof value === "string" ? JSON.parse(value) : value;
    if (!v || typeof v.goalId !== "string" || !v.goalId.trim()
      || !(v.runId === null || (typeof v.runId === "string" && v.runId.trim()))
      || !["pending", "unverified", "verified", "legacy"].includes(v.status)
      || (v.status === "verified" && !v.runId)) return undefined;
    if (v.verificationScope !== undefined && !["goal", "episode"].includes(v.verificationScope)) return undefined;
    if (v.verificationState !== undefined && (!v.verificationScope
      || !["not_requested", "pending", "passed", "inconclusive", "failed"].includes(v.verificationState)
      || (v.verificationState === "passed") !== (v.status === "verified")
      || (v.verificationState === "pending") !== (v.status === "pending"))) return undefined;
    return { goalId: v.goalId, runId: v.runId, status: v.status,
      ...(v.verificationScope ? { verificationScope: v.verificationScope } : {}),
      ...(v.verificationState ? { verificationState: v.verificationState } : {}) };
  } catch { return undefined; }
}

/** Late pending replays cannot demote a host-verified result for the same exact run. */
export function mergeGoalResults(a?: GoalResultPresentation, b?: GoalResultPresentation): GoalResultPresentation | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.goalId !== b.goalId || (a.runId && b.runId && a.runId !== b.runId)) return a;
  if (a.status === b.status && a.verificationState && !b.verificationState) return a;
  const rank = { legacy: 0, pending: 1, unverified: 2, verified: 3 };
  return rank[b.status] >= rank[a.status] ? b : a;
}
