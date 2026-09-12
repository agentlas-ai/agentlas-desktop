export const ROUTING_EVALUATION_SCHEMA_VERSION = "agentlas.routing-evaluation.v1" as const;

export interface RoutingEvaluationSegment {
  runtimeKind: string;
  runtimeBackend: string | null;
  sourceHash: `sha256:${string}`;
  modelId: string | null;
  modelRevision: string | null;
  engineVersion: string | null;
  hardwareProfileId: string | null;
  promptSchemaHash: `sha256:${string}` | null;
  toolSchemaHash: `sha256:${string}` | null;
}

export interface RoutingEvaluationReceipt {
  schemaVersion: typeof ROUTING_EVALUATION_SCHEMA_VERSION;
  evaluationId: string;
  allocationDecisionId: string;
  mode: "shadow";
  authority: "current-selector";
  segment: RoutingEvaluationSegment;
  segmentHash: `sha256:${string}`;
  prediction: null | {
    calibratorVersion: string;
    trainingWindow: { startedAt: string; endedAt: string; sampleCount: number };
    successProbability: number;
    uncertainty: number;
  };
  outcome: {
    status: "pending" | "usage_observed";
    inputTokens: number | null;
    outputTokens: number | null;
  };
  reasonCodes: string[];
  privacy: { rawPromptIncluded: false; rawTranscriptIncluded: false; rawToolPayloadIncluded: false };
}
