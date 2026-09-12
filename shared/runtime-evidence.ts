/** Additive ledger contract. Missing legacy correlation is unknown, never guessed. */
export const RUNTIME_EVIDENCE_SCHEMA = "agentlas.runtime-evidence.v1" as const;
export type RuntimeEvidencePhase = "requested" | "executed" | "observed" | "verified" | "failed" | "uncertain";
export interface RuntimeCorrelation {
  taskId?: string; goalId?: string; goalRevision?: number; longRunId?: string;
  invocationRunId?: string; workerId?: string; attemptId?: string; actionId?: string;
  environmentId?: string; artifactVersionRef?: string;
}
export interface RuntimeEvidenceEnvelope {
  schemaVersion: typeof RUNTIME_EVIDENCE_SCHEMA;
  sourceEventId: string;
  phase: RuntimeEvidencePhase;
  correlation: RuntimeCorrelation;
}
const phases = new Set<string>(["requested", "executed", "observed", "verified", "failed", "uncertain"]);
const keys = ["taskId", "goalId", "longRunId", "invocationRunId", "workerId", "attemptId", "actionId", "environmentId", "artifactVersionRef"] as const;
export function decodeRuntimeEvidence(value: unknown): RuntimeEvidenceEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== RUNTIME_EVIDENCE_SCHEMA || typeof row.sourceEventId !== "string"
    || !row.sourceEventId || row.sourceEventId.length > 512 || !phases.has(String(row.phase))) return null;
  if (!row.correlation || typeof row.correlation !== "object" || Array.isArray(row.correlation)) return null;
  const source = row.correlation as Record<string, unknown>;
  const correlation: RuntimeCorrelation = {};
  for (const key of keys) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== "string" || !source[key] || (source[key] as string).length > 512) return null;
    correlation[key] = source[key] as string;
  }
  if (source.goalRevision !== undefined) {
    if (!Number.isSafeInteger(source.goalRevision) || Number(source.goalRevision) < 1) return null;
    correlation.goalRevision = Number(source.goalRevision);
  }
  return { schemaVersion: RUNTIME_EVIDENCE_SCHEMA, sourceEventId: row.sourceEventId,
    phase: row.phase as RuntimeEvidencePhase, correlation };
}
/** Kind and typed result facts only; model text cannot manufacture verification. */
export function runtimeEvidencePhase(kind: string, payload: Record<string, unknown> = {}): RuntimeEvidencePhase {
  if (payload.sideEffectState === "uncertain" || payload.state === "uncertain") return "uncertain";
  if (kind === "verification.recorded") return payload.verdict === "passed" ? "verified" : payload.verdict === "failed" ? "failed" : "uncertain";
  if (kind === "mcp_error" || kind === "invoke_failed" || payload.toolIsError === true) return "failed";
  if (kind === "invoke_started" || kind === "worker.attempt_started"
    || (kind === "mcp_tool-use" && typeof payload.toolResultPreview !== "string")) return "requested";
  if (kind === "invoke_completed" || (kind === "mcp_tool-use" && typeof payload.toolResultPreview === "string")) return "executed";
  return "observed";
}
/** Legacy rows retain their row identity and do not acquire guessed Goal IDs. */
export function runtimeEvidenceForRow(row: { id: string; kind: string; payload: Record<string, unknown> }): RuntimeEvidenceEnvelope {
  return decodeRuntimeEvidence(row.payload.runtimeEvidence) ?? {
    schemaVersion: RUNTIME_EVIDENCE_SCHEMA, sourceEventId: row.id,
    phase: runtimeEvidencePhase(row.kind, row.payload), correlation: {},
  };
}
