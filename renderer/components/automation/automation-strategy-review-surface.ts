import type { AutomationStrategyProposalView } from "@shared/automation-strategy-review";

/**
 * Main's read-only projection is the authority for the human-decision
 * boundary. Every renderer surface that calls itself an approval surface uses
 * this predicate, rather than guessing from summary text or button presence.
 */
export function requiresAutomationStrategyReview(row: AutomationStrategyProposalView): boolean {
  if (!(row.status === "pending" || row.status === "approved")) return false;
  // Strategy and cadence revisions are autonomous by default. Only a real
  // payment/checkout boundary can surface an attention sheet.
  if (!row.requiresPaymentApproval) return false;
  if (row.unavailableReason === "stale" || row.unavailableReason === "no_executable_change") return false;
  return row.conflict === "needs_user_approval"
    || (row.conflict === "uncertain" && row.canApply)
    || row.goalAmendmentRequired
    || row.unavailableReason === "ownership_unverified";
}
