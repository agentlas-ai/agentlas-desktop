import type { AutomationStrategyProposalView } from "@shared/automation-strategy-review";

/** Whether Main's projection supports a decision that can actually be applied. */
export function canApplyAutomationStrategyReview(row: AutomationStrategyProposalView): boolean {
  if (!(row.status === "pending" || row.status === "approved") || row.reviewState !== "judged") return false;
  if (row.unavailableReason !== null && row.unavailableReason !== "goal_amendment_required") return false;
  if (row.goalAmendmentRequired || row.unavailableReason === "goal_amendment_required") {
    return row.goalAmendmentRequired && row.unavailableReason === "goal_amendment_required"
      && typeof row.goalId === "string" && row.goalId.trim().length > 0
      && Number.isSafeInteger(row.goalRevision) && (row.goalRevision ?? 0) > 0
      && Number.isSafeInteger(row.goalRunVersion) && (row.goalRunVersion ?? -1) >= 0
      && typeof row.goalObjective === "string" && row.goalObjective.trim().length > 0
      && row.goalAcceptanceCriteria.length > 0
      && row.goalAcceptanceCriteria.every((criterion) => criterion.id.trim().length > 0 && criterion.text.trim().length > 0);
  }
  return row.canApply;
}

/** Rejecting a durable proposal does not require its change to be applicable. */
export function canRejectAutomationStrategyReview(row: AutomationStrategyProposalView): boolean {
  return (row.status === "pending" || row.status === "approved") && row.unavailableReason !== "episode_reserved";
}

/** Main's typed projection owns the boundary; proposal prose is never authority. */
export function requiresAutomationStrategyReview(row: AutomationStrategyProposalView): boolean {
  if (!canApplyAutomationStrategyReview(row)) return false;
  // Payment and permission expansion are distinct human authorization boundaries.
  if (row.reviewAuthorization === "user_approval" && row.conflict === "needs_user_approval") return true;
  // A Goal-contract amendment never opens an attention sheet (owner decision 2026-10-20: the AGI keeps the Goal
  // moving by itself, so a question about it is an interruption). The durable panel still shows the held
  // amendment and lets the owner apply it on purpose.
  // Preserve the explicit one-time human delegation gate for legacy origins.
  if (row.goalOwnershipUnverified && !row.originAdoptionRecorded
    && row.conflict === "needs_user_approval" && row.canApply) return true;
  // Older Main projections lack reviewAuthorization; retain their typed payment gate.
  if (!row.requiresPaymentApproval) return false;
  return row.conflict === "needs_user_approval"
    || (row.conflict === "uncertain" && row.canApply);
}
