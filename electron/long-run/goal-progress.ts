import { ownsHostGoalLoop } from "./host-goal-surface";
import { createHash } from "node:crypto";
import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { isEffectStatusOnlyTool } from "../invocation/effect-boundary";
import { callLeftNoOutsideEffect } from "../invocation/no-effect-failure";
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

/**
 * A tool call's stored outcome as a stable token: toolId, run and time are new on every retry, so only the typed outcome and its content
 * enter it. Identical observations stay identical even when the agent repeats the call with different prose. Null for an event that
 * does not carry a typed outcome.
 */
export function toolOutcomeToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  if (typeof data.toolName !== "string" || typeof data.toolResultPreview !== "string" || typeof data.toolIsError !== "boolean") return null;
  const stablePayload = { toolName: data.toolName, toolIsError: data.toolIsError,
    toolFailureCode: typeof data.toolFailureCode === "string" ? data.toolFailureCode : null,
    toolResultPreview: data.toolResultPreview,
    toolSourceUrls: Array.isArray(data.toolSourceUrls)
      ? data.toolSourceUrls.filter((value): value is string => typeof value === "string").sort() : [],
    oneArtifacts: Array.isArray(data.oneArtifacts) ? data.oneArtifacts : [] };
  return `mcp_tool-use:sha256:${createHash("sha256").update(JSON.stringify(stablePayload)).digest("hex")}`;
}

/**
 * The outcomes of this turn's successful calls that may have changed something outside the app (a post, a message, a record written
 * through a connector): the stored result of each, as toolOutcomeToken. A Goal that advances only through such calls changes no file the
 * host reads, so these join the verification's outcome digest. Read-only calls (search, fetch, read) and failed calls are left out: a
 * result that is new on every read, or the same error again, is not progress. The number of calls is never counted, so a turn that
 * repeats one call with one result reads the same as a turn that made it once. Sorted and unique; empty when there is none or the
 * events cannot be read (the digest then has the shape it had before this field).
 */
export function currentTurnEffectOutcomeTokens(invocationRunId: string | null | undefined): string[] {
  if (!invocationRunId) return [];
  try {
    const rows = getDb().prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'mcp_tool-use' ORDER BY seq")
      .all(invocationRunId) as Array<{ payload_json: string }>;
    const tokens = new Set<string>();
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.payload_json); } catch { continue; }
      const token = toolOutcomeToken(payload);
      if (!token || payload.toolIsError !== false || !String(payload.toolResultPreview).trim()) continue;
      if (isEffectStatusOnlyTool({ name: String(payload.toolName), id: payload.toolId, args: payload.toolArgs, isError: payload.toolIsError })) continue;
      if (callLeftNoOutsideEffect({ toolName: payload.toolName, toolArgs: payload.toolArgs })) continue;
      tokens.add(token);
    }
    return [...tokens].sort();
  } catch { return []; }
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
      let payload: unknown;
      try { payload = JSON.parse(event.payload_json); } catch { continue; }
      const token = toolOutcomeToken(payload);
      if (token) tokens.add(token);
    }
  }
  return [...tokens];
}

/** Read-only Main evidence projection for an explicitly ongoing One Goal. */
export function observeOngoingOneGoalProgress(goalId: string): OngoingGoalProgress {
  const run = getLongRunByGoalId(goalId);
  const revision = getChatGoalRevision(goalId);
  const binding = run ? getLongRunGoalRevisionBinding(run.id) : null;
  if (!run || !ownsHostGoalLoop(run.surface) || !run.rootChatId || !revision || revision.lifecycle !== "ongoing"
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
