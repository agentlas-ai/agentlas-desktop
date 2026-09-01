/** Cross-store projection contract. Science remains canonical in science.sqlite. */
export const SCIENCE_LONG_RUN_PROJECTION_SCHEMA = "agentlas.science-long-run-projection.v2" as const;

export type ScienceLoopProjectionStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface ScienceLoopLongRunProjection {
  schema: typeof SCIENCE_LONG_RUN_PROJECTION_SCHEMA;
  loopSessionId: string;
  scienceProjectId: string;
  runtimeChatId: string | null;
  contractId: string;
  contractVersion: number;
  contractContentSha256: string;
  objective: string;
  successCriteria: readonly string[];
  maxEpisodes: number;
  deadlineAt: string;
  sourceVersion: number;
  sourceStateSha256: string;
  eventCursor: number;
  status: ScienceLoopProjectionStatus;
  pauseReason?: "user" | "app_closed" | "crash_recovery" | "approval_required" | null;
  waitingForDecision?: boolean;
  verifying?: boolean;
  completionReceiptSetSha256?: string | null;
  criterionEvidence?: readonly {
    criterionIndex: number;
    receiptId: string;
    receiptVersion: number;
    criterionTextSha256: string;
    verdict: "passed" | "failed" | "inconclusive";
    evidenceRefs: readonly string[];
    artifactRefs?: readonly string[];
    verifier: {
      method: "research-director-attestation";
      agentId: string;
      agentSlug: string;
      packageVersion: string;
      packageDigest: string;
      systemPromptSha256: string;
      invocationRunId: string;
    };
    summary: string;
    receiptSha256: string;
    provenanceSha256: string;
  }[];
  projectionStatus?: "current" | "stale" | "error";
  lastError?: string | null;
}

export function scienceLongRunId(loopSessionId: string): string {
  return `run_science_${loopSessionId.replace(/-/g, "")}`;
}

export function scienceLongRunGoalId(loopSessionId: string): string {
  return `science-loop:${loopSessionId}`;
}
