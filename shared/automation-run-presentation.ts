import type { AutomationRunRecord } from "./types";

export type AutomationRunPresentationInput = Pick<AutomationRunRecord, "status" | "outcome" | "acknowledgedAt">;

/** Execution, result quality and a request for intervention are different facts.
 * A rejected result does not establish an execution error or an owner request.
 * Historical receipts remain unchanged; unknown results never become success.
 */
export function automationRunPresentation(run: AutomationRunPresentationInput) {
  const execution = run.status === "ok" ? "completed" as const
    : run.status === "partial" ? "incomplete" as const
      : run.status === "error" ? "failed" as const : run.status;
  const result = run.outcome === "rejected" ? "unmet" as const
    : run.outcome === "unjudged" ? "pending" as const
      : run.outcome ?? "unknown" as const;
  const requiresAttention = !run.acknowledgedAt && (
    run.status === "error" || run.status === "partial" || run.status === "blocked" || run.status === "needs_input"
    || run.outcome === "blocked" || run.outcome === "needs_input"
  );
  return { execution, result, requiresAttention,
    reviewSuggested: !run.acknowledgedAt && result === "unmet" };
}

/** A checkpoint with no credible denominator cannot establish a percentage.
 * In particular, legacy synthesized graphs can have completed steps while the
 * stored graph contains zero nodes. Do not invent a total from today's graph.
 */
export function automationRunProgress(completed: number, total: number | null | undefined) {
  const observed = Number.isSafeInteger(completed) && completed >= 0 ? completed : 0;
  const knownTotal = typeof total === "number" && Number.isSafeInteger(total) && total > 0 && total >= observed
    ? total : null;
  return { completed: observed, total: knownTotal,
    percent: knownTotal === null ? null : Math.round(observed / knownTotal * 100) };
}
