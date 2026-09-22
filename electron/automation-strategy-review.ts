/** Main-only strategy review facade used by IPC.  Keep the durable store as
 * the single implementation so renderer callers cannot bypass CAS or review
 * adjudication. */
export {
  listAutomationStrategyProposals,
  reviewAutomationStrategyProposal,
  getAutomationStrategyProposalApplicability,
  type AutomationStrategyProposalReceipt,
  type AutomationStrategyProposalAdjudication,
  type AutomationStrategyProposalApplicability,
  type AutomationStrategyGoalAmendmentInput,
  type AutomationStrategyGoalAmendmentReceipt,
} from "./store/automation-strategy-proposals";
