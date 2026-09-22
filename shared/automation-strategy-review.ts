/** User-facing strategy history. Main owns all decisions and mutation receipts. */
export interface AutomationStrategyRuntimeView {
  kind: string;
  backend: string | null;
  model: string | null;
  route: "execution_pin" | "configured_orchestrator_pool" | null;
  poolFingerprint: string | null;
  capability: {
    status: "verified" | "unsupported" | "unknown";
    enforcement: "claude_safe_mode" | "main_tool_payload_omitted" | "unsupported" | "unknown";
    reason: string;
  } | null;
}

export interface AutomationStrategyProposalView {
  id: string;
  automationId: string;
  automationName: string;
  intent: "keep" | "change" | "schedule-change";
  status: "pending" | "approved" | "rejected" | "applied";
  conflict: "within_scope" | "needs_user_approval" | "uncertain";
  summary: string;
  rationale: string;
  /** Human attention is reserved for a real payment/checkout boundary. */
  requiresPaymentApproval: boolean;
  reviewState: "pending" | "judged" | "unavailable";
  reviewReason: string | null;
  changes: Array<{ label: string; before: string | null; after: string }>;
  canApply: boolean;
  unavailableReason: "stale" | "no_executable_change" | "goal_amendment_required" | "ownership_unverified" | null;
  goalOwnershipUnverified: boolean;
  /** A human has already adopted this legacy origin for strategy-only changes. */
  originAdoptionRecorded: boolean;
  goalAmendmentRequired: boolean;
  goalId: string | null;
  goalRevision: number | null;
  goalRunVersion: number | null;
  goalObjective: string | null;
  goalAcceptanceCriteria: Array<{ id: string; text: string }>;
  goalAmendment: {
    previousRevision: number;
    revision: number;
    sourceMessageId: string;
    previousObjective: string;
    objective: string;
    previousAcceptanceCriteria: Array<{ id: string; text: string }>;
    acceptanceCriteria: Array<{ id: string; text: string }>;
    approvedAt: string;
  } | null;
  /** The model that executes the graph; never reused as the judge implicitly. */
  executionRuntime: AutomationStrategyRuntimeView | null;
  /** The configured-pool model that independently judged this proposal. */
  judgmentRuntime: AutomationStrategyRuntimeView | null;
  appliedRevision: number | null;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AutomationStrategyReviewResult =
  | { ok: true; proposal: AutomationStrategyProposalView }
  | { ok: false; code: "stale" | "not_applicable" | "not_found" | "failed" };
