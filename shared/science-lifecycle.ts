export const SCIENCE_RESEARCH_LIFECYCLE_SCHEMA = "agentlas.science.research-lifecycle/v1" as const;

export const SCIENCE_RESEARCH_MAIN_PHASES = [
  "intake",
  "literature",
  "hypothesis",
  "analysis_plan_draft",
  "analysis_plan_frozen",
  "execution",
  "evidence_reconciliation",
  "conclusions",
  "manuscript",
  "journal_profile",
  "submission_validation",
  "ready_to_submit",
] as const;

export const SCIENCE_RESEARCH_SIDE_PHASES = ["blocked", "stopped", "failed"] as const;
export const SCIENCE_RESEARCH_LIFECYCLE_PHASES = [...SCIENCE_RESEARCH_MAIN_PHASES, ...SCIENCE_RESEARCH_SIDE_PHASES] as const;

export type ScienceResearchMainPhase = typeof SCIENCE_RESEARCH_MAIN_PHASES[number];
export type ScienceResearchLifecyclePhase = typeof SCIENCE_RESEARCH_LIFECYCLE_PHASES[number];
export type ScienceResearchLifecycleStatus = "active" | "waiting_for_decision" | "blocked" | "complete" | "stopped" | "failed";

export const SCIENCE_RESEARCH_STOP_CODES = [
  "question_not_falsifiable",
  "evidence_unavailable",
  "capability_unavailable",
  "integrity_failure",
  "plan_mismatch",
  "diagnostic_failure",
  "decision_required",
  "authority_withdrawn",
  "resource_limit",
  "user_stop",
] as const;
export type ScienceResearchStopCode = typeof SCIENCE_RESEARCH_STOP_CODES[number];

export interface ScienceResearchStopCondition {
  code: ScienceResearchStopCode;
  reason: string;
  recoveryAction: string;
}

export interface ScienceResearchBlockingDecision {
  id: string;
  code: string;
  summary: string;
  contentSha256: string;
}

export interface ScienceResearchFrozenPlanBinding {
  analysisSpecId: string;
  version: number;
  contentSha256: string;
}

export interface ScienceResearchSubmissionExportBinding {
  submissionExportId: string;
  packageSha256: string;
}

/**
 * `evidenceSha256` is an exact selector for a current, project-bound canonical
 * record. Main re-reads that record at append time; a caller-created digest is
 * never accepted merely because it is syntactically valid.
 *
 * Edge bindings are: lifecycle head, literature evidence manifest, hypothesis
 * manifest, frozen plan, run-backed artifact, claim-gate report, manuscript
 * version, journal-profile version, and journal-validation report respectively.
 */
export type ScienceResearchPhaseGatePreconditions =
  | { kind: "phase_gate"; fromPhase: "intake"; toPhase: "literature"; gateCode: "intake.complete"; evidenceSha256: string }
  | { kind: "phase_gate"; fromPhase: "literature"; toPhase: "hypothesis"; gateCode: "literature.complete"; evidenceSha256: string }
  | { kind: "phase_gate"; fromPhase: "hypothesis"; toPhase: "analysis_plan_draft"; gateCode: "hypothesis.complete"; evidenceSha256: string }
  | { kind: "phase_gate"; fromPhase: "analysis_plan_draft"; toPhase: "analysis_plan_frozen"; gateCode: "analysis_plan.frozen"; evidenceSha256: string }
  | { kind: "phase_gate"; fromPhase: "analysis_plan_frozen"; toPhase: "execution"; gateCode: "analysis_plan.execution_authorized"; evidenceSha256: string }
  | { kind: "phase_gate"; fromPhase: "execution"; toPhase: "evidence_reconciliation"; gateCode: "execution.receipts_verified"; evidenceSha256: string }
  | { kind: "phase_gate"; fromPhase: "evidence_reconciliation"; toPhase: "conclusions"; gateCode: "evidence.reconciled"; evidenceSha256: string;
      claimLedgerId: string; claimLedgerRevision: number; claimLedgerManifestSha256: string; claimGateReportSha256: string; claimPolicyContentSha256: string }
  | { kind: "phase_gate"; fromPhase: "conclusions"; toPhase: "manuscript"; gateCode: "conclusions.bounded"; evidenceSha256: string }
  | { kind: "phase_gate"; fromPhase: "manuscript"; toPhase: "journal_profile"; gateCode: "manuscript.version_bound"; evidenceSha256: string }
  | { kind: "phase_gate"; fromPhase: "journal_profile"; toPhase: "submission_validation"; gateCode: "journal_profile.verified"; evidenceSha256: string }
  | { kind: "phase_gate"; fromPhase: "submission_validation"; toPhase: "ready_to_submit"; gateCode: "submission.package_verified"; evidenceSha256: string };

export type ScienceResearchLifecycleTransitionPreconditions =
  | { kind: "state_update"; reason: "progress" | "decision_opened" | "decision_resolved" | "blocker_changed"; evidenceSha256: string }
  | ScienceResearchPhaseGatePreconditions
  | { kind: "block"; fromPhase: ScienceResearchMainPhase; evidenceSha256: string }
  | { kind: "resume"; resumePhase: ScienceResearchMainPhase; resolutionSha256: string }
  | { kind: "stop"; fromPhase: ScienceResearchMainPhase | "blocked"; evidenceSha256: string }
  | { kind: "fail"; fromPhase: ScienceResearchMainPhase | "blocked"; evidenceSha256: string };

export interface ScienceResearchLifecycleContent {
  schema: typeof SCIENCE_RESEARCH_LIFECYCLE_SCHEMA;
  phase: ScienceResearchLifecyclePhase;
  status: ScienceResearchLifecycleStatus;
  question: string;
  preconditions:
    | { kind: "initialize"; expectedProjectVersion: number }
    | ScienceResearchLifecycleTransitionPreconditions;
  openBlockingDecisions: ScienceResearchBlockingDecision[];
  blockers: string[];
  frozenAnalysisPlan: ScienceResearchFrozenPlanBinding | null;
  submissionExport: ScienceResearchSubmissionExportBinding | null;
  stop: ScienceResearchStopCondition | null;
  resumePhase: ScienceResearchMainPhase | null;
}

export interface ScienceResearchLifecycleRevision extends ScienceResearchLifecycleContent {
  id: string;
  studyId: string;
  projectId: string;
  revision: number;
  previousRevision: number | null;
  previousStateSha256: string | null;
  previousContentSha256: string | null;
  contentSha256: string;
  stateSha256: string;
  createdAt: string;
}

export interface CreateScienceResearchLifecycleInput {
  requestId: string;
  projectId: string;
  expectedProjectVersion: number;
}

export interface AppendScienceResearchLifecycleRevisionInput {
  requestId: string;
  projectId: string;
  studyId: string;
  expectedRevision: number;
  expectedStateSha256: string;
  phase: ScienceResearchLifecyclePhase;
  question: string;
  preconditions: ScienceResearchLifecycleTransitionPreconditions;
  openBlockingDecisions: ScienceResearchBlockingDecision[];
  blockers: string[];
  frozenAnalysisPlan: ScienceResearchFrozenPlanBinding | null;
  submissionExport: ScienceResearchSubmissionExportBinding | null;
  stop: ScienceResearchStopCondition | null;
}

export interface ScienceResearchLifecycleMutationResult {
  revision: ScienceResearchLifecycleRevision;
  replayed: boolean;
}

/**
 * Minimal, integrity-bound projection emitted to renderer subscribers after a
 * committed lifecycle mutation. Consumers must re-read the canonical head;
 * this event is an invalidation notice, not an alternate source of truth.
 */
export interface ScienceResearchLifecycleChanged {
  projectId: string;
  studyId: string;
  revision: number;
  phase: ScienceResearchLifecyclePhase;
  status: ScienceResearchLifecycleStatus;
  stateSha256: string;
}
