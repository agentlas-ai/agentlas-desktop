/** Execution route revisions do not revise the immutable Goal requirements. */
export interface RuntimePlanSnapshot {
  schemaVersion: "agentlas.runtime-plan.v1";
  runId: string; revision: number; parentRevision: number | null; goalRevision: number | null;
  requirementsRef: string; environmentalFindings: string[]; decisions: string[];
  steps: Array<{ taskId: string; title: string; state: string }>;
  evaluation: string[]; rollback: string[]; unresolvedQuestions: string[];
  createdAt: string;
}
export interface CheckpointArtifactVersion {
  artifactId: string; artifactRevision: number | null; sourceDigest: string | null;
  dataDigest: string | null; stateRevision: number | null; stateSchemaDigest: string | null;
}
