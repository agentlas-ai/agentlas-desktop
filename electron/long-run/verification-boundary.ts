import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { getLongRunAttemptGoalRevision, getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { listAgentSurfaces } from "../store/agent-surfaces";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { compileProjectInstructionSnapshot } from "./instructions";

/** An invocation can contribute to this exact Goal revision only through its
 * durable attempt-start binding. Folder equality is not evidence ownership. */
export function invocationMatchesGoalRevision(invocationRunId: string, goalId: string, revision: number): boolean {
  const rows = getDb().prepare(`SELECT a.id, a.run_id FROM long_run_worker_attempts a
    JOIN long_runs r ON r.id = a.run_id WHERE a.invocation_run_id = ? AND r.goal_id = ?`)
    .all(invocationRunId, goalId) as Array<{id: string; run_id: string}>;
  return rows.length > 0 && rows.every(row => getLongRunAttemptGoalRevision(row.run_id, row.id) === revision);
}

export function captureGoalVerificationBoundary(goalId: string, invocationRunId: string): {
  digest: string; goalRevision: number; refs: string[]; snapshot: Record<string, unknown>;
} {
  const run = getLongRunByGoalId(goalId), revision = getChatGoalRevision(goalId);
  if (!run || run.surface === "science" || !run.rootChatId || !revision
    || getChatGoalContract(goalId)?.status !== "active"
    || getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision
    || revision.chatId !== run.rootChatId || !invocationMatchesGoalRevision(invocationRunId, goalId, revision.revision)) {
    throw new Error("verification_goal_revision_unbound");
  }
  const chat = getChat(run.rootChatId);
  if (!chat || chat.goalId !== goalId || chat.originSurface !== run.surface) throw new Error("verification_chat_binding_changed");
  if (run.objective !== revision.objective.replace(/\s+/g, " ").trim()
    || JSON.stringify(run.acceptanceCriteria) !== JSON.stringify(revision.acceptanceCriteria.map(row => row.text.replace(/\s+/g, " ").trim()))) throw new Error("verification_criteria_changed");
  for (const source of [revision.originalRequest, revision.sourceMessage]) {
    const message = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(source.messageId) as {chat_id: string; role: string; text: string} | undefined;
    if (!message || message.chat_id !== chat.id || source.chatId !== chat.id || message.role !== "user" || message.text !== source.text) throw new Error("verification_source_changed");
  }
  const boundary = readInvocationEffectBoundary({ invocationRunId, expectedChatId: chat.id });
  // A probe that exited non-zero leaves a failed-but-resolved call: nothing is still running, so the current
  // state can be judged (quiesced). Continuation replay keeps requiring fully settled effects.
  if (!boundary.terminal || (boundary.effects !== "settled" && boundary.quiesced !== true)
    || !boundary.receiptEventId || !boundary.snapshotDigest) throw new Error("verification_effects_unconfirmed");
  const controller = getDb().prepare(`SELECT a.id, a.invocation_run_id FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id = a.worker_id WHERE a.run_id = ? AND w.role = 'controller' ORDER BY a.rowid DESC LIMIT 1`)
    .get(run.id) as {id: string; invocation_run_id: string | null} | undefined;
  if (controller?.invocation_run_id !== invocationRunId) throw new Error("verification_newer_controller_attempt");
  if (getDb().prepare("SELECT 1 FROM invocation_steers WHERE original_run_id = ? AND status IN ('queued','draining','failed','cancelled') LIMIT 1").get(invocationRunId)) throw new Error("verification_pending_direction");
  const latestUser = getDb().prepare("SELECT id, text FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1").get(chat.id);
  const workspace = getChatWorkingFolder(chat.id);
  const instructions = workspace ? compileProjectInstructionSnapshot({projectDir: workspace}).snapshot.revision : null;
  const artifacts = listAgentSurfaces(chat.id).map(surface => ({artifactId: surface.id,
    artifactRevision: surface.artifactRevision ?? null, stateRevision: surface.stateRevision ?? null,
    artifactRef: surface.artifactRef ?? null})).sort((a,b) => a.artifactId.localeCompare(b.artifactId));
  const digest = createHash("sha256").update(JSON.stringify({runId: run.id, status: run.status,
    revision, controller, latestUser, workspace, instructions, artifacts, boundary})).digest("hex");
  return { digest,
    snapshot: {schemaVersion: "agentlas.goal-verification-boundary.v1", goalId, goalRevision: revision.revision,
      invocationRunId, digest, effectReceiptRef: `event:${boundary.receiptEventId}`, effectSnapshotDigest: boundary.snapshotDigest,
      sourceRefs: [revision.originalRequest.messageId, revision.sourceMessage.messageId].map(id => `message:${id}`),
      environment: {workspace, instructionRevision: instructions}, artifactVersions: artifacts,
      note: "This pins verification inputs; artifact presence and render readiness do not establish business correctness."},
    goalRevision: revision.revision, refs: [`event:${boundary.receiptEventId}`, `goal:${goalId}:revision:${revision.revision}`] };
}
