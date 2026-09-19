import { prepareCheckpointContinuation } from "./continuation";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { listAgentSurfaces } from "../store/agent-surfaces";
import { latestInvocationInstructionSnapshot } from "./instructions";
import { latestRuntimePlan, recordRuntimePlan } from "./plan";
import { createHash } from "node:crypto";
import type { CheckpointCriterion, GoalVerificationDisposition, LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { getDb } from "../store/db";
import { getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId, getLongRunGoalRevisionBinding, latestLongRunAttemptSafeEpoch,
  listLongRunTasks, longRunContinueDecision, unsettledLongRunAttempts } from "../store/long-runs";
import { agentRunCwd } from "../runtime/exec";

/** The existing append-only event ledger is the checkpoint store. No second
 * mutable goal record or provider transcript is introduced. */
export function recordTaskCheckpoint(input: {
  goalId: string;
  workerId: string;
  attempt: number;
  invocationRunId?: string | null;
  disposition: GoalVerificationDisposition;
  verdicts: CheckpointCriterion[];
  recoveryFingerprint?: string | null;
  recoveryStreak?: number;
  evidenceRefs: string[];
  projectDir?: string | null;
}): LongRunTaskCheckpoint {
  return getDb().transaction(() => {
    const run = getLongRunByGoalId(input.goalId);
    if (!run || run.surface === "science") throw new Error("long_run_checkpoint_run_invalid");
    const tasks = listLongRunTasks(run.id);
    const revision = getChatGoalRevision(run.goalId);
    const attempts = unsettledLongRunAttempts(run.id);
    let boundary: ReturnType<typeof readInvocationEffectBoundary> | null = null;
    if (input.invocationRunId && run.rootChatId) {
      try { boundary = readInvocationEffectBoundary({ invocationRunId: input.invocationRunId, expectedChatId: run.rootChatId }); }
      catch { /* Missing or foreign producer evidence stays uncertain. */ }
    }
    const requestedWorkspacePath = input.projectDir?.trim() || null;
    const instructionSnapshot = run.rootChatId ? latestInvocationInstructionSnapshot(run.rootChatId) : null;
    const currentPlan = latestRuntimePlan(run.id);
    const plan = !currentPlan || currentPlan.goalRevision !== (getLongRunGoalRevisionBinding(run.id)?.revision ?? null)
      || JSON.stringify(currentPlan.steps) !== JSON.stringify(tasks.map((task) => ({ taskId: task.id, title: task.title, state: task.state })))
      ? recordRuntimePlan({ runId: run.id, expectedRevision: currentPlan?.revision ?? null }) : currentPlan;
    const questions = getDb().prepare("SELECT id FROM long_run_messages WHERE run_id = ? AND kind = 'question' AND state IN ('queued','delivered') ORDER BY created_at, id")
      .all(run.id) as Array<{ id: string }>;
    const history = run.rootChatId ? getDb().prepare("SELECT id FROM chat_messages WHERE chat_id = ? ORDER BY created_at, rowid")
      .all(run.rootChatId) as Array<{ id: string }> : [];
    const artifactVersions = run.rootChatId ? listAgentSurfaces(run.rootChatId).map((surface) => ({
      artifactId: surface.id, artifactRevision: surface.artifactRevision ?? null,
      sourceDigest: surface.artifactRef?.sourceDigest ?? null, dataDigest: surface.artifactRef?.dataDigest ?? null,
      stateRevision: surface.stateRevision ?? null, stateSchemaDigest: surface.artifactRef?.stateSchemaDigest ?? null,
    })) : [];
    const effects = getDb().prepare("SELECT id, invocation_run_id, state, side_effect_state, native_coordinate_json FROM long_run_worker_attempts WHERE run_id = ? ORDER BY started_at, id")
      .all(run.id) as Array<{ id: string; invocation_run_id: string | null; state: string; side_effect_state: string; native_coordinate_json: string | null }>;
    const nativeAttempt = effects.find((effect) => effect.invocation_run_id === input.invocationRunId);
    const nativeCoordinate = nativeAttempt?.native_coordinate_json ? JSON.parse(nativeAttempt.native_coordinate_json) : null;
    const observedFiles = instructionSnapshot?.sources.map(({ sourceRef, contentHash }) => ({ sourceRef, contentHash })) ?? [];
    const producer = getDb().prepare(
      `SELECT a.id, a.invocation_run_id, a.state, a.side_effect_state, w.workspace_binding_json
       FROM long_run_worker_attempts AS a
       JOIN long_run_workers AS w ON w.id = a.worker_id AND w.run_id = a.run_id
       WHERE a.run_id = ? AND w.role = 'controller'
       ORDER BY a.rowid DESC LIMIT 1`,
    ).get(run.id) as { id: string; invocation_run_id: string | null; state: string;
      side_effect_state: string; workspace_binding_json: string } | undefined;
    let producerWorkspace: string | null | undefined;
    try {
      const value = producer ? JSON.parse(producer.workspace_binding_json)?.cwd : undefined;
      producerWorkspace = typeof value === "string" && value.trim() ? value.trim() : value === null ? null : undefined;
    } catch { producerWorkspace = undefined; }
    const workspacePath = requestedWorkspacePath ?? producerWorkspace ?? null;
    const defaultWorkspace = requestedWorkspacePath === null && workspacePath === agentRunCwd();
    const instructionBindingExact = requestedWorkspacePath !== null
      ? instructionSnapshot !== null
      : defaultWorkspace && instructionSnapshot === null;
    // A checkpoint may describe uncertainty, but only the newest completed Main
    // controller run with an exact workspace and complete effect receipt can mint
    // settled replay authority.
    const settledProducer = Boolean(input.invocationRunId && producer && workspacePath && instructionBindingExact
      && producer.invocation_run_id === input.invocationRunId
      && producer.state === "completed" && producer.side_effect_state === "committed"
      && producerWorkspace !== undefined && producerWorkspace === workspacePath
      && boundary?.effects === "settled");
    const pathHash = createHash("sha256").update(workspacePath ?? "").digest("hex");
    const eventCursor = getLongRunByGoalId(input.goalId)!.lastEventSeq;
    const checkpointId = `checkpoint:${run.id}:${eventCursor + 1}`;
    const checkpoint: LongRunTaskCheckpoint = {
      schemaVersion: "agentlas.task-checkpoint.v2", checkpointId, goalId: run.goalId,
      goalRevision: getLongRunGoalRevisionBinding(run.id)?.revision ?? null,
      lifecycle: revision?.lifecycle ?? "finite",
      invocationRunId: input.invocationRunId ?? null, disposition: input.disposition,
      objective: run.objective,
      acceptanceCriteria: [...run.acceptanceCriteria],
      workspacePath,
      completedTaskIds: tasks.filter((task) => task.state === "completed").map((task) => task.id),
      currentOperation: "verify_output",
      nextActions: input.verdicts.filter((item) => item.verdict !== "passed"),
      recoveryFingerprint: input.recoveryFingerprint ?? null,
      recoveryStreak: Math.max(0, Math.floor(input.recoveryStreak ?? 0)),
      sideEffects: { state: attempts.length || !settledProducer ? "uncertain" : "settled", attemptRefs: attempts.map((item) => item.id),
        ...(settledProducer && boundary?.terminalEventId && boundary.receiptEventId && boundary.snapshotDigest ? { boundary: {
          invocationRunId: boundary.invocationRunId, terminalEventId: boundary.terminalEventId,
          receiptEventId: boundary.receiptEventId, snapshotDigest: boundary.snapshotDigest,
        } } : {}),
      },
      createdAt: new Date().toISOString(),
      capsule: {
        schemaVersion: "agentlas.continuity-capsule.v2", runId: run.id, workerId: input.workerId,
        taskId: tasks.find((task) => task.state !== "completed")?.id ?? null, attempt: input.attempt,
        goalContractRef: revision ? `goal:${run.goalId}:revision:${revision.revision}` : `goal:${run.goalId}`,
        compactedContextRef: null, openQuestions: [...plan.unresolvedQuestions, ...questions.map((question) => `message:${question.id}`)],
        artifactRefs: artifactVersions.map((artifact) => `artifact:${artifact.artifactId}:revision:${artifact.artifactRevision ?? "unknown"}`), evidenceRefs: input.evidenceRefs,
        artifactVersions, plan, instructionSnapshot,
        originalConstraintsRef: revision ? `message:${revision.originalRequest.messageId}` : null,
        originalConstraints: revision?.originalRequest.text ?? null,
        historyRangeRef: run.rootChatId ? { chatId: run.rootChatId, firstMessageId: history[0]?.id ?? null,
          lastMessageId: history.at(-1)?.id ?? null, messageCount: history.length } : null,
        externalActionReceipts: effects.map((effect) => ({ attemptId: effect.id, invocationRunId: effect.invocation_run_id,
          state: effect.state, sideEffectState: effect.side_effect_state })),
        pathHash, observedContentSnapshot: instructionSnapshot ? { scope: "loaded-instructions", files: observedFiles,
          digest: createHash("sha256").update(JSON.stringify(observedFiles)).digest("hex") } : null,
        toolInvocationRefs: input.invocationRunId ? [`invocation:${input.invocationRunId}`] : [],
        workspaceFingerprint: pathHash,
        nativeCoordinate, lastCommittedEventSeq: eventCursor,
      },
    };
    appendLongRunEvent({ runId: run.id, kind: "run.task_checkpoint", actorKind: "host", payload: { checkpoint } });
    return checkpoint;
  })();
}

export function latestTaskCheckpoint(goalId: string): LongRunTaskCheckpoint | null {
  const run = getLongRunByGoalId(goalId);
  if (!run || run.surface === "science") return null;
  const row = getDb().prepare("SELECT seq, payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.task_checkpoint' ORDER BY seq DESC LIMIT 1")
    .get(run.id) as { seq: number; payload_json: string } | undefined;
  if (!row) return null;
  const safeEpoch = latestLongRunAttemptSafeEpoch(run.id);
  // An acknowledgment invalidates every earlier checkpoint. Only a fresh Main
  // turn may establish the next settled continuation boundary.
  if (safeEpoch && row.seq <= safeEpoch.eventSeq) return null;
  const checkpoint = JSON.parse(row.payload_json).checkpoint as LongRunTaskCheckpoint;
  const revision = getChatGoalRevision(goalId);
  if (!["agentlas.task-checkpoint.v1", "agentlas.task-checkpoint.v2"].includes(checkpoint.schemaVersion) || checkpoint.goalId !== goalId
    || checkpoint.capsule.runId !== run.id
    || (revision && checkpoint.goalRevision !== revision.revision)
    || checkpoint.goalRevision !== (getLongRunGoalRevisionBinding(run.id)?.revision ?? null)) return null;
  // Early v1 checkpoints only carried the goal reference. The revision check
  // above makes the current ledger the exact contract that reference names.
  if (checkpoint.schemaVersion === "agentlas.task-checkpoint.v2") {
    if (checkpoint.capsule.plan?.revision !== latestRuntimePlan(run.id)?.revision) return null;
    const instructions = run.rootChatId ? latestInvocationInstructionSnapshot(run.rootChatId) : null;
    if ((checkpoint.capsule.instructionSnapshot?.revision ?? null) !== (instructions?.revision ?? null)) return null;
    return checkpoint;
  }
  return { ...checkpoint, acceptanceCriteria: checkpoint.acceptanceCriteria ?? run.acceptanceCriteria };
}

/** Claim a successor once, before dispatch. A crash after claiming is never
 * blindly replayed; startup reconciliation sees the durable attempt/receipt. */
export function claimCheckpointContinuation(goalId: string, checkpointId: string, invocationRunId: string): boolean {
  return getDb().transaction(() => {
    const checkpoint = latestTaskCheckpoint(goalId);
    if (!checkpoint || checkpoint.checkpointId !== checkpointId || checkpoint.disposition !== "retry_required"
      || checkpoint.sideEffects.state !== "settled" || !longRunContinueDecision(goalId)?.continue) return false;
    try { prepareCheckpointContinuation(checkpoint); } catch { return false; }
    const db = getDb();
    if (db.prepare("SELECT 1 FROM long_run_worker_attempts WHERE run_id = ? AND (state IN ('running','uncertain') OR side_effect_state = 'uncertain') LIMIT 1")
      .get(checkpoint.capsule.runId)) return false;
    if (db.prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = 'run.checkpoint_continuation' AND json_extract(payload_json, '$.checkpointId') = ?")
      .get(checkpoint.capsule.runId, checkpointId)) return false;
    appendLongRunEvent({ runId: checkpoint.capsule.runId, kind: "run.checkpoint_continuation", actorKind: "host", payload: { checkpointId, invocationRunId } });
    return true;
  })();
}
