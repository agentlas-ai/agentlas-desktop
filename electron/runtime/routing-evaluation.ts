import { createHash } from "node:crypto";
import type { RuntimeStatus } from "../../shared/types";
import {
  ROUTING_EVALUATION_SCHEMA_VERSION,
  type RoutingEvaluationReceipt,
  type RoutingEvaluationSegment,
} from "../../shared/routing-evaluation";

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function buildShadowRoutingEvaluation(input: {
  allocationDecisionId: string;
  runtime: RuntimeStatus;
  observedUsage?: { inputTokens: number; outputTokens: number } | null;
  modelRevision?: string | null;
  engineVersion?: string | null;
  hardwareProfileId?: string | null;
  promptSchemaHash?: `sha256:${string}` | null;
  toolSchemaHash?: `sha256:${string}` | null;
}): RoutingEvaluationReceipt {
  const segment: RoutingEvaluationSegment = {
    runtimeKind: input.runtime.kind,
    runtimeBackend: input.runtime.backend ?? null,
    sourceHash: sha256(input.runtime.source ?? ""),
    modelId: input.runtime.model ?? null,
    modelRevision: input.modelRevision ?? null,
    engineVersion: input.engineVersion ?? null,
    hardwareProfileId: input.hardwareProfileId ?? null,
    promptSchemaHash: input.promptSchemaHash ?? null,
    toolSchemaHash: input.toolSchemaHash ?? null,
  };
  const segmentHash = sha256(JSON.stringify(segment));
  const missing = Object.entries(segment)
    .filter(([key, value]) => !["runtimeKind", "sourceHash"].includes(key) && value === null)
    .map(([key]) => `calibration_segment_${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_missing`);
  if (!input.runtime.source) missing.push("calibration_segment_source_missing");
  const usage = input.observedUsage
    && Number.isInteger(input.observedUsage.inputTokens) && input.observedUsage.inputTokens >= 0
    && Number.isInteger(input.observedUsage.outputTokens) && input.observedUsage.outputTokens >= 0
    ? input.observedUsage
    : null;
  return {
    schemaVersion: ROUTING_EVALUATION_SCHEMA_VERSION,
    evaluationId: `routing-evaluation:${segmentHash.slice(7, 31)}:${input.allocationDecisionId.slice(-12)}`,
    allocationDecisionId: input.allocationDecisionId,
    mode: "shadow",
    authority: "current-selector",
    segment,
    segmentHash,
    prediction: null,
    outcome: {
      status: usage ? "usage_observed" : "pending",
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    },
    reasonCodes: ["shadow_did_not_change_selection", "calibrator_not_available", ...missing],
    privacy: { rawPromptIncluded: false, rawTranscriptIncluded: false, rawToolPayloadIncluded: false },
  };
}
