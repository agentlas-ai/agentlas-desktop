import { createHash } from "node:crypto";
import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { getDb } from "../store/db";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunAttemptGoalRevision, getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { latestTaskCheckpoint } from "./checkpoint";

export type OngoingGoalProgress = { state: "unknown" | "evidence_observed"; key: string };

/** An unknown episode is repeatable for the stall guard, but is not progress. */
function unknown(revision: number): OngoingGoalProgress {
  return { state: "unknown", key: `one-host:unknown:revision:${revision}` };
}

/**
 * Only stable, typed evidence identities affect the key. Checkpoint ids,
 * invocation ids, timestamps and model wording are deliberately excluded:
 * repeating the same observation is not a new outcome.
 */
export function canonicalOngoingEvidenceKey(input: {
  checkpoint: LongRunTaskCheckpoint;
  goalId: string;
  runId: string;
  revision: number;
  /** Host-resolved receipt content, never bare invocation/message/event ids. */
  evidenceTokens: readonly string[];
  boundary: { effects: "settled" | "uncertain"; terminalEventId: string | null;
    receiptEventId: string | null; snapshotDigest: string | null };
}): OngoingGoalProgress {
  const { checkpoint, boundary } = input;
  const receipt = checkpoint.sideEffects.boundary;
  if (checkpoint.schemaVersion !== "agentlas.task-checkpoint.v2"
    || checkpoint.lifecycle !== "ongoing" || checkpoint.goalId !== input.goalId
    || checkpoint.goalRevision !== input.revision || checkpoint.capsule.runId !== input.runId
    || checkpoint.sideEffects.state !== "settled" || !receipt
    || !checkpoint.invocationRunId || receipt.invocationRunId !== checkpoint.invocationRunId
    || boundary.effects !== "settled" || receipt.terminalEventId !== boundary.terminalEventId
    || receipt.receiptEventId !== boundary.receiptEventId || receipt.snapshotDigest !== boundary.snapshotDigest) {
    return unknown(input.revision);
  }
  const evidenceTokens = [...new Set(input.evidenceTokens)].sort();
  // A new task id is created for every ongoing episode, and a changed route
  // is a plan evaluation rather than a measured outcome. Neither can turn a
  // repeated observation into progress or reset the stall guard.
  if (!evidenceTokens.length) return unknown(input.revision);
  const canonical = JSON.stringify({ schemaVersion: "agentlas.one-goal-evidence.v1", revision: input.revision,
    evidenceTokens });
  return { state: "evidence_observed", key: `one-host:sha256:${createHash("sha256").update(canonical).digest("hex")}` };
}

/** Passed verifier references are resolved to stable result content. An
 * invocation terminal, assistant message, or fresh event id by itself is not
 * progress. A repeated tool observation has the same token across episodes. */
function verifiedEvidenceTokens(runId: string, chatId: string, revision: number,
  receiptCursor: number, checkpointEventSeq: number): string[] {
  const db = getDb();
  const rows = db.prepare(`SELECT r.evidence_refs_json, r.artifact_refs_json FROM long_run_verification_receipts AS r
    JOIN long_run_events AS e ON e.run_id = r.run_id AND e.kind = 'verification.recorded'
      AND json_extract(e.payload_json, '$.receiptId') = r.id
    WHERE r.run_id = ? AND r.rowid > ? AND r.verdict = 'passed' AND e.seq <= ? ORDER BY r.rowid`)
    .all(runId, receiptCursor, checkpointEventSeq) as Array<{ evidence_refs_json: string; artifact_refs_json: string }>;
  const tokens = new Set<string>();
  for (const receipt of rows) {
    let refs: unknown;
    try { refs = [...JSON.parse(receipt.evidence_refs_json), ...JSON.parse(receipt.artifact_refs_json)]; }
    catch { continue; }
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      if (/^artifact:.+:revision:[1-9]\d*$/.test(ref)) { tokens.add(ref); continue; }
      const eventId = /^event:(.+)$/.exec(ref)?.[1];
      if (!eventId) continue;
      const event = db.prepare("SELECT run_id, chat_id, kind, payload_json FROM run_events WHERE id = ?")
        .get(eventId) as { run_id: string; chat_id: string | null; kind: string; payload_json: string } | undefined;
      if (!event || event.chat_id !== chatId) continue;
      const attempts = db.prepare("SELECT id, run_id FROM long_run_worker_attempts WHERE invocation_run_id = ?")
        .all(event.run_id) as Array<{ id: string; run_id: string }>;
      if (!attempts.length || attempts.some(attempt => attempt.run_id !== runId
        || getLongRunAttemptGoalRevision(runId, attempt.id) !== revision)) continue;
      if (event.kind !== "mcp_tool-use") continue;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(event.payload_json); } catch { continue; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      if (typeof payload.toolName !== "string" || typeof payload.toolResultPreview !== "string"
        || typeof payload.toolIsError !== "boolean") continue;
      // toolId/run/time are new on every retry. Only the typed tool outcome
      // and its content enter the fingerprint; identical observations stay
      // identical even when the agent repeats the call with different prose.
      const stablePayload = { toolName: payload.toolName, toolIsError: payload.toolIsError,
        toolFailureCode: typeof payload.toolFailureCode === "string" ? payload.toolFailureCode : null,
        toolResultPreview: payload.toolResultPreview,
        toolSourceUrls: Array.isArray(payload.toolSourceUrls)
          ? payload.toolSourceUrls.filter((value): value is string => typeof value === "string").sort() : [],
        oneArtifacts: Array.isArray(payload.oneArtifacts) ? payload.oneArtifacts : [] };
      const token = createHash("sha256").update(JSON.stringify(stablePayload)).digest("hex");
      tokens.add(`${event.kind}:sha256:${token}`);
    }
  }
  return [...tokens];
}

/** Read-only Main evidence projection for an explicitly ongoing One Goal. */
export function observeOngoingOneGoalProgress(goalId: string): OngoingGoalProgress {
  const run = getLongRunByGoalId(goalId);
  const revision = getChatGoalRevision(goalId);
  const binding = run ? getLongRunGoalRevisionBinding(run.id) : null;
  if (!run || run.surface !== "one" || !run.rootChatId || !revision || revision.lifecycle !== "ongoing"
    || binding?.revision !== revision.revision) {
    return unknown(revision?.revision ?? 0);
  }
  const checkpoint = latestTaskCheckpoint(goalId);
  if (!checkpoint?.invocationRunId) return unknown(revision.revision);
  try {
    const checkpointEventSeq = checkpoint.capsule.lastCommittedEventSeq;
    if (!Number.isSafeInteger(checkpointEventSeq) || checkpointEventSeq < 0) return unknown(revision.revision);
    const boundary = readInvocationEffectBoundary({ invocationRunId: checkpoint.invocationRunId,
      expectedChatId: run.rootChatId });
    const evidenceTokens = verifiedEvidenceTokens(run.id, run.rootChatId, revision.revision,
      binding.receiptCursor, checkpointEventSeq);
    return canonicalOngoingEvidenceKey({ checkpoint, goalId, runId: run.id, revision: revision.revision,
      boundary, evidenceTokens });
  } catch {
    return unknown(revision.revision);
  }
}
