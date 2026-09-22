/** Read-only automation provenance. A terminal receipt is not an external
 * effect proof, and no domain KPI is available from these generic ledgers. */
export interface GoalAutomationObservation {
  automationId: string;
  graphDigest: string | null;
  definitionDigest: string;
  bindingState: "current" | "stale";
  executionState: "unknown" | "terminal-receipt";
  terminalRunId: string | null;
  terminalStatus: "ok" | "partial" | "error" | "skipped" | null;
  effectState: "unknown";
  domainKpiState: "unknown";
}

/** Execution route revisions do not revise the immutable Goal requirements. */
export interface OngoingEpisodeStrategy {
  schemaVersion: "agentlas.ongoing-episode-strategy.v1";
  /** Main-owned provenance; these are observations, never a new permission. */
  invocationRunId: string;
  goalRevision: number;
  effectBoundaryDigest: string | null;
  effectReceiptEventId: string | null;
  metrics: {
    passed: number;
    repairableFailed: number;
    prerequisiteFailed: number;
    otherFailed: number;
    inconclusive: number;
  };
  state: "changed" | "unchanged" | "unknown";
  reasonCode: "action_changed" | "action_unchanged" | "first_observation" | "evidence_unavailable";
  nextAction: "wait_observe" | "repair_verified_failure" | "gather_missing_evidence" | "hold_for_user" | "inspect_before_action";
  nextWakeAt: string | null;
  /** Empty means no explicit revision-bound automation was observed. */
  automationObservations?: GoalAutomationObservation[];
}

/** A no-tools proposal selected after repeated settled observations. It is
 * diagnostic data, not proof of progress or a new permission to act. */
export interface OngoingStallReplan {
  schemaVersion: "agentlas.ongoing-stall-replan.v1";
  sourceCheckpointId: string;
  sourceInvocationRunId: string;
  goalRevision: number;
  progressKey: string;
  effectBoundaryDigest: string;
  effectReceiptEventId: string;
  action: "inspect_read_only" | "wait_backoff" | "needs_person";
  diagnosis: string;
  alternative: string;
  modelFingerprint: string;
  nextWakeAt: string | null;
}

export interface RuntimePlanSnapshot {
  schemaVersion: "agentlas.runtime-plan.v1";
  runId: string; revision: number; parentRevision: number | null; goalRevision: number | null;
  requirementsRef: string; environmentalFindings: string[]; decisions: string[];
  steps: Array<{ taskId: string; title: string; state: string }>;
  evaluation: string[]; rollback: string[]; unresolvedQuestions: string[];
  /** Bounded host-verified episode summary carried into the next checkpoint. */
  episodeStrategy?: OngoingEpisodeStrategy;
  stallReplan?: OngoingStallReplan;
  createdAt: string;
}
export interface CheckpointArtifactVersion {
  artifactId: string; artifactRevision: number | null; sourceDigest: string | null;
  dataDigest: string | null; stateRevision: number | null; stateSchemaDigest: string | null;
}
