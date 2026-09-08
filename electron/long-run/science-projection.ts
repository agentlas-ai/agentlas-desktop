import { createHash } from "node:crypto";
import {
  scienceLongRunGoalId,
  scienceLongRunId,
  type ScienceLoopLongRunProjection,
} from "agentlas-science/dist/contracts/science-long-run";
import { getDb } from "../store/db";
import {
  applyScienceLongRunProjectionStatus,
  createLongRun,
  getLongRun,
  listLongRunTasks,
  recordLongRunVerification,
  upsertLongRunDomainBinding,
  type LongRunRecord,
} from "../store/long-runs";

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function existingMainChatId(runtimeChatId: string | null): string | null {
  if (!runtimeChatId) return null;
  const row = getDb().prepare("SELECT id FROM chats WHERE id = ? LIMIT 1").get(runtimeChatId) as { id?: string } | undefined;
  return row?.id ?? null;
}

/**
 * Idempotently projects a canonical Science loop snapshot into the common
 * Desktop ledger. This function never commands Science execution.
 */
function projectScienceLoopLongRunInTransaction(input: ScienceLoopLongRunProjection): LongRunRecord {
  const schema = String((input as { schema?: unknown }).schema ?? "");
  if (schema !== "agentlas.science-long-run-projection.v1"
    && schema !== "agentlas.science-long-run-projection.v2") throw new Error("science_projection_schema_unsupported");
  const legacyProjection = schema === "agentlas.science-long-run-projection.v1";
  const criteria = input.successCriteria.map((value) => value.trim()).filter(Boolean);
  if (criteria.length === 0) throw new Error("science_projection_success_criteria_required");
  const runId = scienceLongRunId(input.loopSessionId);
  let run = getLongRun(runId) ?? createLongRun({
    id: runId,
    goalId: scienceLongRunGoalId(input.loopSessionId),
    idempotencyKey: scienceLongRunGoalId(input.loopSessionId),
    surface: "science",
    executionLocation: "desktop-local",
    rootChatId: existingMainChatId(input.runtimeChatId),
    projectId: null,
    scienceJobId: input.loopSessionId,
    objective: input.objective,
    acceptanceCriteria: criteria,
    status: input.status === "queued" ? "queued" : "running",
    runtimeFallbackPolicy: "locked",
    budget: {
      maxCycles: input.maxEpisodes,
      wallclockDeadline: input.deadlineAt,
    },
  });

  const binding = upsertLongRunDomainBinding({
    longRunId: run.id,
    domain: "science",
    objectType: "loop_session",
    objectId: input.loopSessionId,
    externalProjectId: input.scienceProjectId,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    contractContentSha256: input.contractContentSha256,
    objectVersion: input.sourceVersion,
    stateSha256: input.sourceStateSha256,
    eventCursor: input.eventCursor,
    projectionStatus: input.projectionStatus ?? "current",
    lastError: input.lastError ?? null,
  });
  if (binding.projectionStatus !== "current") return run;
  if (binding.objectVersion > input.sourceVersion) return run;

  const markProjectionError = (code: string): LongRunRecord => {
    upsertLongRunDomainBinding({
      longRunId: run.id,
      domain: "science",
      objectType: "loop_session",
      objectId: input.loopSessionId,
      externalProjectId: input.scienceProjectId,
      contractId: input.contractId,
      contractVersion: input.contractVersion,
      contractContentSha256: input.contractContentSha256,
      objectVersion: input.sourceVersion,
      stateSha256: input.sourceStateSha256,
      eventCursor: input.eventCursor,
      projectionStatus: "error",
      lastError: code,
    });
    return getLongRun(run.id)!;
  };

  if (["completed", "failed", "cancelled"].includes(run.status)) return run;
  if (input.status === "queued") {
    return applyScienceLongRunProjectionStatus({
      runId: run.id,
      to: "queued",
      sourceVersion: input.sourceVersion,
      sourceStateSha256: input.sourceStateSha256,
    });
  }
  if (input.status === "paused") {
    return applyScienceLongRunProjectionStatus({
      runId: run.id,
      to: "paused",
      pauseReason: input.pauseReason ?? "user",
      sourceVersion: input.sourceVersion,
      sourceStateSha256: input.sourceStateSha256,
    });
  }
  if (input.status === "pausing") {
    return applyScienceLongRunProjectionStatus({
      runId: run.id,
      to: "pausing",
      sourceVersion: input.sourceVersion,
      sourceStateSha256: input.sourceStateSha256,
    });
  }
  if (input.status === "failed" || input.status === "cancelled") {
    return applyScienceLongRunProjectionStatus({
      runId: run.id,
      to: input.status,
      sourceVersion: input.sourceVersion,
      sourceStateSha256: input.sourceStateSha256,
    });
  }
  if (input.status === "completed") {
    run = applyScienceLongRunProjectionStatus({
      runId: run.id,
      to: "verifying",
      sourceVersion: input.sourceVersion,
      sourceStateSha256: input.sourceStateSha256,
    });
    const receipts = [...(input.criterionEvidence ?? [])].sort((a, b) => a.criterionIndex - b.criterionIndex);
    const receiptSetValid = typeof input.completionReceiptSetSha256 === "string"
      && SHA256_RE.test(input.completionReceiptSetSha256)
      && receipts.length === criteria.length
      && receipts.every((receipt, index) => receipt.criterionIndex === index
        && receipt.verdict === "passed"
        && receipt.receiptId.trim().length > 0
        && Number.isSafeInteger(receipt.receiptVersion) && receipt.receiptVersion >= 1
        && receipt.criterionTextSha256 === sha256Text(criteria[index]!)
        && SHA256_RE.test(receipt.receiptSha256)
        && SHA256_RE.test(receipt.provenanceSha256)
        && receipt.verifier?.method === "research-director-attestation"
        && receipt.verifier.agentId.trim().length > 0
        && receipt.verifier.agentSlug.trim().length > 0
        && receipt.verifier.packageVersion.trim().length > 0
        && SHA256_RE.test(receipt.verifier.packageDigest)
        && SHA256_RE.test(receipt.verifier.systemPromptSha256)
        && UUID_RE.test(receipt.verifier.invocationRunId))
      && sha256Json({
        schema: "agentlas.science.loop-criterion-verification-set.v1",
        loopSessionId: input.loopSessionId,
        contractId: input.contractId,
        contractVersion: input.contractVersion,
        contractContentSha256: input.contractContentSha256,
        receipts: receipts.map((receipt) => ({
          criterionIndex: receipt.criterionIndex,
          receiptId: receipt.receiptId,
          receiptSha256: receipt.receiptSha256,
          provenanceSha256: receipt.provenanceSha256,
        })),
      }) === input.completionReceiptSetSha256;
    if (legacyProjection) return markProjectionError("science_projection_v1_completion_forbidden");
    if (!receiptSetValid) return markProjectionError("science_projection_completion_receipt_set_invalid");
    for (const receipt of receipts) {
      const verifierSha256 = sha256Json(receipt.verifier);
      const evidenceRefs = Array.from(new Set([
        ...receipt.evidenceRefs,
        `science-criterion-receipt:${receipt.receiptId}:${receipt.receiptVersion}:${receipt.receiptSha256}:${receipt.provenanceSha256}`,
        `science-criterion-text:${receipt.criterionTextSha256}`,
        `science-completion-receipt-set:${input.completionReceiptSetSha256}`,
        `science-verifier:${receipt.verifier.agentSlug}@${receipt.verifier.packageVersion}:${verifierSha256}`,
        `science-state:${input.sourceStateSha256}`,
        `science-loop-event:${input.loopSessionId}:${input.eventCursor}`,
      ]));
      recordLongRunVerification({
        runId: run.id,
        taskId: "task:bootstrap",
        criterionIndex: receipt.criterionIndex,
        verdict: receipt.verdict,
        evidenceRefs,
        artifactRefs: receipt.artifactRefs ?? [],
        summary: receipt.summary,
        authority: "science-projection",
      });
    }
    if (listLongRunTasks(run.id, true).length > 0) return getLongRun(run.id)!;
    return applyScienceLongRunProjectionStatus({
      runId: run.id,
      to: "completed",
      sourceVersion: input.sourceVersion,
      sourceStateSha256: input.sourceStateSha256,
    });
  }

  return applyScienceLongRunProjectionStatus({
    runId: run.id,
    to: input.waitingForDecision ? "waiting_user" : input.verifying ? "verifying" : "running",
    sourceVersion: input.sourceVersion,
    sourceStateSha256: input.sourceStateSha256,
  });
}

export function projectScienceLoopLongRun(input: ScienceLoopLongRunProjection): LongRunRecord {
  // Nested store helpers use savepoints; this outer transaction makes the
  // binding cursor, projection state, receipts, and event history one commit.
  return getDb().transaction(() => projectScienceLoopLongRunInTransaction(input))();
}
