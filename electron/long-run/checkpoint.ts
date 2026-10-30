import { claimGoalRuntimeSelection } from "./runtime-handoff";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { listAgentSurfaces } from "../store/agent-surfaces";
import { compileProjectInstructionSnapshot, recordInvocationInstructionSnapshot } from "./instructions";
import { latestRuntimePlan, recordRuntimePlan } from "./plan";
import { createHash } from "node:crypto";
import type { CheckpointCriterion, GoalVerificationDisposition, LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { getDb } from "../store/db";
import { getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId, getLongRunGoalRevisionBinding,
  listLongRunTasks, longRunContinueDecision } from "../store/long-runs";
import type { InstructionSnapshot } from "../../shared/runtime-instructions";

/** Bind a checkpoint to its own Main invocation, never another turn in the chat. */
function producerInstructionSnapshot(invocationRunId: string | null | undefined, chatId: string | null): InstructionSnapshot | null {
  if (!invocationRunId || !chatId) return null;
  const row = getDb().prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND chat_id = ? AND kind = 'instruction_snapshot' ORDER BY seq DESC LIMIT 1")
    .get(invocationRunId, chatId) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    const snapshot = JSON.parse(row.payload_json).instructionSnapshot as InstructionSnapshot | undefined;
    return snapshot?.schemaVersion === "agentlas.instruction-snapshot.v1" && typeof snapshot.revision === "string"
      && typeof snapshot.environmentId === "string" && Array.isArray(snapshot.sources)
      && snapshot.sources.every(source => typeof source.sourceRef === "string" && typeof source.contentHash === "string")
      ? snapshot : null;
  } catch { return null; }
}

/**
 * A producer that never prepared its own instruction snapshot (it failed before dispatch, or took an early team route:
 * mcp/client.ts records the snapshot only on the single-runner path) left a checkpoint that latestTaskCheckpoint and
 * prepareCheckpointContinuation both refuse, so the Goal could neither reflect, wait nor hand its planner a retry
 * checkpoint ("checkpoint_missing" / "checkpoint_instructions_changed"). Observed in use: 172 of 437 checkpoints,
 * every one of them from a failed Goal turn. Record the workspace's snapshot against that invocation now, through the one
 * writer every turn uses (idempotent per run and revision), so the checkpoint carries the instructions in force and later
 * change detection works. This never mints settled replay authority: that still needs the snapshot the producer recorded
 * itself (instructionBindingExact below). An unreadable or oversized instruction source leaves the snapshot absent, as before.
 */
function materializeProducerInstructionSnapshot(invocationRunId: string | null | undefined, chatId: string | null,
  projectDir: string | null): InstructionSnapshot | null {
  if (!invocationRunId || !chatId || !projectDir) return null;
  try {
    // One savepoint: a receipt that fails validation leaves no half-written snapshot row behind.
    return getDb().transaction(() => {
      recordInvocationInstructionSnapshot({ runId: invocationRunId, chatId, projectDir });
      return producerInstructionSnapshot(invocationRunId, chatId);
    })();
  } catch { return null; }
}

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
  noProgressRetries?: number;
  evidenceRefs: string[];
  projectDir?: string | null;
}): LongRunTaskCheckpoint {
  return getDb().transaction(() => {
    const run = getLongRunByGoalId(input.goalId);
    if (!run || run.surface === "science") throw new Error("long_run_checkpoint_run_invalid");
    const tasks = listLongRunTasks(run.id);
    const revision = getChatGoalRevision(run.goalId);
    let boundary: ReturnType<typeof readInvocationEffectBoundary> | null = null;
    if (input.invocationRunId && run.rootChatId) {
      try { boundary = readInvocationEffectBoundary({ invocationRunId: input.invocationRunId, expectedChatId: run.rootChatId }); }
      catch { /* Missing or foreign producer evidence stays uncertain. */ }
    }
    const requestedWorkspacePath = input.projectDir?.trim() || null;
    const recordedInstructionSnapshot = producerInstructionSnapshot(input.invocationRunId, run.rootChatId);
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
    // The native session coordinate is the Goal's controller attempt of this invocation. A task-force specialist shares
    // its parent's invocation id (invocation-projection.ts) and settles without a coordinate, so "the first attempt that
    // names this invocation" is only the controller by start order; the role is stated here, as it is for `producer` below.
    const attemptRows = getDb().prepare(`SELECT a.id, a.invocation_run_id, a.native_coordinate_json
      FROM long_run_worker_attempts AS a
      JOIN long_run_workers AS w ON w.id = a.worker_id AND w.run_id = a.run_id
      WHERE a.run_id = ? AND w.role = 'controller' ORDER BY a.started_at, a.id`)
      .all(run.id) as Array<{ id: string; invocation_run_id: string | null; native_coordinate_json: string | null }>;
    const nativeAttempt = attemptRows.find((attempt) => attempt.invocation_run_id === input.invocationRunId);
    const nativeCoordinate = nativeAttempt?.native_coordinate_json ? JSON.parse(nativeAttempt.native_coordinate_json) : null;
    const producer = getDb().prepare(
      `SELECT a.id, a.invocation_run_id, a.state, w.workspace_binding_json
       FROM long_run_worker_attempts AS a
       JOIN long_run_workers AS w ON w.id = a.worker_id AND w.run_id = a.run_id
       WHERE a.run_id = ? AND w.role = 'controller'
       ORDER BY a.rowid DESC LIMIT 1`,
    ).get(run.id) as { id: string; invocation_run_id: string | null; state: string;
      workspace_binding_json: string } | undefined;
    let producerWorkspace: string | null | undefined;
    try {
      const value = producer ? JSON.parse(producer.workspace_binding_json)?.cwd : undefined;
      producerWorkspace = typeof value === "string" && value.trim() ? value.trim() : value === null ? null : undefined;
    } catch { producerWorkspace = undefined; }
    const workspacePath = requestedWorkspacePath ?? producerWorkspace ?? null;
    const instructionSnapshot = recordedInstructionSnapshot
      ?? materializeProducerInstructionSnapshot(input.invocationRunId, run.rootChatId, workspacePath);
    const observedFiles = instructionSnapshot?.sources.map(({ sourceRef, contentHash }) => ({ sourceRef, contentHash })) ?? [];
    let instructionBindingExact = false;
    if (workspacePath && recordedInstructionSnapshot) {
      try {
        const current = compileProjectInstructionSnapshot({ projectDir: workspacePath }).snapshot;
        instructionBindingExact = current.environmentId === recordedInstructionSnapshot.environmentId
          && current.revision === recordedInstructionSnapshot.revision;
      } catch { /* Changed or unavailable instructions cannot mint settled authority. */ }
    }
    // Only the newest completed Main controller run with an exact workspace and a finished
    // effect receipt can mint settled replay authority.
    const settledProducer = Boolean(input.invocationRunId && producer && workspacePath && instructionBindingExact
      && producer.invocation_run_id === input.invocationRunId
      && producer.state === "completed"
      && producerWorkspace !== undefined && producerWorkspace === workspacePath
      // Finished is enough (owner 2026-10-05, 2026-10-12): the host does not judge outside effects; the next turn checks.
      && boundary?.terminal === true);
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
      noProgressRetries: Math.max(0, Math.floor(input.noProgressRetries ?? 0)),
      sideEffects: { state: settledProducer ? "settled" : "uncertain", attemptRefs: [],
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
    const instructions = producerInstructionSnapshot(checkpoint.invocationRunId, run.rootChatId);
    if (!instructions || checkpoint.capsule.instructionSnapshot?.revision !== instructions.revision
      || checkpoint.capsule.instructionSnapshot.environmentId !== instructions.environmentId) return null;
    return checkpoint;
  }
  return { ...checkpoint, acceptanceCriteria: checkpoint.acceptanceCriteria ?? run.acceptanceCriteria };
}

/** Claim a successor once, before dispatch. A crash after claiming is never
 * blindly replayed; startup reconciliation sees the durable attempt/receipt. */
export function claimCheckpointContinuation(goalId: string, checkpointId: string, invocationRunId: string,
  recoveryWaitId?: string): boolean {
  return getDb().transaction(() => {
    const checkpoint = latestTaskCheckpoint(goalId);
    if (!checkpoint || checkpoint.checkpointId !== checkpointId) return false;
    // Historical recovery observations describe the producer; they do not
    // re-admit the current request. Claim only this checkpoint identity once.
    let recoveryDecision: ReturnType<typeof longRunContinueDecision> | null = null;
    try { recoveryDecision = longRunContinueDecision(goalId); } catch { /* Diagnostic only. */ }
    const db = getDb();
    if (db.prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = 'run.checkpoint_continuation' AND json_extract(payload_json, '$.checkpointId') = ?")
      .get(checkpoint.capsule.runId, checkpointId)) return false;
    appendLongRunEvent({ runId: checkpoint.capsule.runId, kind: "run.checkpoint_continuation", actorKind: "host", payload: { checkpointId, invocationRunId,
      recoveryDiagnostic: { disposition: checkpoint.disposition, sideEffects: checkpoint.sideEffects,
        decision: recoveryDecision, recoveryWaitId: recoveryWaitId ?? null } } });
    claimGoalRuntimeSelection(checkpoint, invocationRunId);
    return true;
  })();
}
