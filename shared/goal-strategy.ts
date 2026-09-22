import type { GoalAutomationObservation } from "./runtime-plan";

/**
 * Host-owned, proposal-only strategy reflection for an ongoing Goal.
 *
 * This contract is intentionally separate from Graph strategy revisions.  A
 * Goal reflection can describe a possible strategy or cadence change, but it
 * cannot carry a graph patch, permission grant, Goal amendment, or apply
 * authority.  Main binds the durable receipt to the exact Goal revision and
 * settled episode evidence after parsing the model draft.
 */

export const GOAL_STRATEGY_PROPOSAL_DRAFT_SCHEMA =
  "agentlas.goal-strategy-proposal-draft.v1" as const;
export const GOAL_STRATEGY_PROPOSAL_SCHEMA =
  "agentlas.goal-strategy-proposal.v1" as const;
export const GOAL_STRATEGY_REFLECTION_DISPATCH_SCHEMA =
  "agentlas.goal-strategy-reflection-dispatch.v1" as const;

export type GoalStrategyProposalIntent =
  | "hold"
  | "change-strategy"
  | "change-cadence";

export type GoalStrategyConstraintSource =
  | "original-request"
  | "objective"
  | "acceptance-criterion"
  | "authority"
  | "explicit-cadence";

export type GoalStrategyConstraintDisposition =
  | "preserved"
  | "conflict"
  | "uncertain";

export interface GoalStrategyFixedConstraintV1 {
  id: string;
  source: GoalStrategyConstraintSource;
  reference: string;
  text: string;
  /** This is host classification, not a model-issued permission. */
  fixed: true;
}

export interface GoalStrategyConstraintAssessmentV1 {
  id: string;
  disposition: GoalStrategyConstraintDisposition;
  note: string;
}

export interface GoalStrategyStrategyDraftV1 {
  schemaVersion: "agentlas.goal-strategy.v1";
  summary: string;
  change: string;
}

export interface GoalStrategyCadenceDraftV1 {
  kind: "keep" | "suggest";
  /** A null value is a qualitative cadence suggestion, never an apply token. */
  nextWakeAt: string | null;
  change: string;
}

/** A Goal recommendation is advisory evidence for an independently reviewed
 * Graph strategy cycle, never a graph patch or permission to apply one. */
export interface GoalStrategyAutomationRecommendationV1 {
  proposalId: string;
  goalId: string;
  goalRevision: number;
  intent: GoalStrategyProposalIntent;
  rationale: string;
  strategy: GoalStrategyStrategyDraftV1 | null;
  cadence: GoalStrategyCadenceDraftV1 | null;
}

/** Model-facing object. Main adds provenance and authority after parsing. */
export interface GoalStrategyProposalDraftV1 {
  schemaVersion: typeof GOAL_STRATEGY_PROPOSAL_DRAFT_SCHEMA;
  intent: GoalStrategyProposalIntent;
  rationale: string;
  strategy?: GoalStrategyStrategyDraftV1;
  cadence?: GoalStrategyCadenceDraftV1;
  fixedConstraints?: GoalStrategyConstraintAssessmentV1[];
}

export interface GoalStrategySettledBoundaryV1 {
  invocationRunId: string;
  terminalEventId: string;
  receiptEventId: string;
  snapshotDigest: string;
}

export interface GoalStrategyGoalSnapshotV1 {
  goalId: string;
  chatId: string;
  revision: number;
  lifecycle: "ongoing";
  contractStatus: "active";
  originalRequest: { messageId: string; text: string; digest: string };
  objective: { text: string; digest: string };
  acceptanceCriteria: Array<{ id: string; text: string; digest: string }>;
  authorityRefs: string[];
}

export interface GoalStrategyEpisodeSnapshotV1 {
  disposition: "completed" | "cycle_completed" | "retry_required" | "blocked";
  evidenceReady: true;
  metrics: {
    passed: number;
    repairableFailed: number;
    prerequisiteFailed: number;
    otherFailed: number;
    inconclusive: number;
  };
  /** Host-observed, exact-provenance Graph automations available to the
   * existing strategy-cycle route. This is evidence, not authority. */
  automationObservations: GoalAutomationObservation[];
}

export type GoalStrategyAutomationHandoffStatus =
  | "requested"
  | "completed"
  | "held"
  | "unavailable";

export type GoalStrategyAutomationHandoffReason =
  | "automation_strategy_cycle_already_recorded"
  | "goal_strategy_automation_no_terminal_receipt"
  | "goal_strategy_automation_binding_stale"
  | "goal_strategy_automation_source_missing"
  | "goal_strategy_automation_source_boundary_changed"
  | "goal_strategy_automation_effect_unconfirmed"
  | "goal_strategy_automation_cycle_unavailable"
  | "goal_strategy_automation_cycle_failed";

/**
 * Durable bridge from a settled Goal reflection to the existing Graph
 * strategy cycle. It names an already-observed terminal Graph run and its
 * exact Goal provenance; it never contains a fabricated run or an apply
 * authority. The Graph cycle performs its own independent model review and
 * CAS before any strategy revision.
 */
export interface GoalStrategyAutomationHandoffV1 {
  schemaVersion: "agentlas.goal-strategy-automation-handoff.v1";
  eventKind: "goal_strategy_automation_handoff";
  status: GoalStrategyAutomationHandoffStatus;
  proposalId: string;
  longRunId: string;
  goalId: string;
  goalRevision: number;
  source: {
    invocationRunId: string;
    checkpointId: string;
    boundary: GoalStrategySettledBoundaryV1;
  };
  automation: {
    automationId: string;
    terminalRunId: string | null;
    terminalStatus: GoalAutomationObservation["terminalStatus"];
    graphDigest: string | null;
    definitionDigest: string | null;
    bindingState: GoalAutomationObservation["bindingState"];
  };
  route: "existing_graph_strategy_cycle";
  authority: "observation-only";
  reason?: GoalStrategyAutomationHandoffReason;
  createdAt: string;
}

/** Durable append-only receipt. There is deliberately no canApply/apply field. */
export interface GoalStrategyProposalReceiptV1 {
  schemaVersion: typeof GOAL_STRATEGY_PROPOSAL_SCHEMA;
  eventKind: "goal_strategy_proposal";
  proposalId: string;
  inputDigest: string;
  longRunId: string;
  goal: GoalStrategyGoalSnapshotV1;
  source: {
    invocationRunId: string;
    checkpointId: string;
    boundary: GoalStrategySettledBoundaryV1;
    episode: GoalStrategyEpisodeSnapshotV1;
  };
  /** Read-only observation: neither the model nor this receipt grants authority. */
  authority: "observation-only";
  fixedConstraints: GoalStrategyFixedConstraintV1[];
  assessment: GoalStrategyConstraintAssessmentV1[];
  recommendation: {
    intent: GoalStrategyProposalIntent;
    rationale: string;
    strategy: GoalStrategyStrategyDraftV1 | null;
    cadence: GoalStrategyCadenceDraftV1 | null;
  };
  reflection: {
    status: "model";
    route: "configured_orchestrator_pool";
    poolFingerprint: string;
  };
  createdAt: string;
}

/**
 * Durable, observation-only handoff for a background reflection attempt. It
 * makes the non-blocking boundary visible even when the model is unavailable;
 * it is not a proposal and carries no permission to apply anything.
 */
export interface GoalStrategyReflectionDispatchReceiptV1 {
  schemaVersion: typeof GOAL_STRATEGY_REFLECTION_DISPATCH_SCHEMA;
  eventKind: "goal_strategy_reflection_dispatch";
  /** `requested` is an attempt record, not a restartable scheduler job. */
  status: "requested" | "completed" | "unavailable";
  longRunId: string;
  goalId: string;
  goalRevision: number;
  source: {
    invocationRunId: string;
    checkpointId: string;
    boundary: GoalStrategySettledBoundaryV1;
  };
  authority: "observation-only";
  outcome?: {
    proposalId?: string;
    reason?: string;
  };
  createdAt: string;
}
