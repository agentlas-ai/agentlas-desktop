import { createHash } from "node:crypto";
import type { CheckpointCriterion, GoalVerificationDisposition, LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { getDb } from "../store/db";
import { getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId, getLongRunGoalRevisionBinding, listLongRunTasks, longRunContinueDecision } from "../store/long-runs";

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
    const attempts = getDb().prepare("SELECT id, state, side_effect_state FROM long_run_worker_attempts WHERE run_id = ? AND (state IN ('running','uncertain') OR side_effect_state = 'uncertain')")
      .all(run.id) as Array<{ id: string; state: string; side_effect_state: string }>;
    const checkpointId = `checkpoint:${run.id}:${run.lastEventSeq + 1}`;
    const checkpoint: LongRunTaskCheckpoint = {
      schemaVersion: "agentlas.task-checkpoint.v1", checkpointId, goalId: run.goalId,
      goalRevision: getLongRunGoalRevisionBinding(run.id)?.revision ?? null,
      invocationRunId: input.invocationRunId ?? null, disposition: input.disposition,
      objective: run.objective,
      acceptanceCriteria: [...run.acceptanceCriteria],
      workspacePath: input.projectDir ?? null,
      completedTaskIds: tasks.filter((task) => task.state === "completed").map((task) => task.id),
      currentOperation: "verify_output",
      nextActions: input.verdicts.filter((item) => item.verdict !== "passed"),
      recoveryFingerprint: input.recoveryFingerprint ?? null,
      recoveryStreak: Math.max(0, Math.floor(input.recoveryStreak ?? 0)),
      sideEffects: { state: attempts.length ? "uncertain" : "settled", attemptRefs: attempts.map((item) => item.id) },
      createdAt: new Date().toISOString(),
      capsule: {
        schemaVersion: "agentlas.continuity-capsule.v1", runId: run.id, workerId: input.workerId,
        taskId: tasks.find((task) => task.state !== "completed")?.id ?? null, attempt: input.attempt,
        goalContractRef: revision ? `goal:${run.goalId}:revision:${revision.revision}` : `goal:${run.goalId}`,
        compactedContextRef: null, openQuestions: [], artifactRefs: [], evidenceRefs: input.evidenceRefs,
        toolInvocationRefs: input.invocationRunId ? [`invocation:${input.invocationRunId}`] : [],
        workspaceFingerprint: createHash("sha256").update(input.projectDir ?? "").digest("hex"),
        nativeCoordinate: null, lastCommittedEventSeq: run.lastEventSeq,
      },
    };
    appendLongRunEvent({ runId: run.id, kind: "run.task_checkpoint", actorKind: "host", payload: { checkpoint } });
    return checkpoint;
  })();
}

export function latestTaskCheckpoint(goalId: string): LongRunTaskCheckpoint | null {
  const run = getLongRunByGoalId(goalId);
  if (!run || run.surface === "science") return null;
  const row = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.task_checkpoint' ORDER BY seq DESC LIMIT 1")
    .get(run.id) as { payload_json: string } | undefined;
  if (!row) return null;
  const checkpoint = JSON.parse(row.payload_json).checkpoint as LongRunTaskCheckpoint;
  const revision = getChatGoalRevision(goalId);
  if (checkpoint.schemaVersion !== "agentlas.task-checkpoint.v1" || checkpoint.goalId !== goalId
    || checkpoint.capsule.runId !== run.id
    || (revision && checkpoint.goalRevision !== revision.revision)
    || checkpoint.goalRevision !== (getLongRunGoalRevisionBinding(run.id)?.revision ?? null)) return null;
  // Early v1 checkpoints only carried the goal reference. The revision check
  // above makes the current ledger the exact contract that reference names.
  return { ...checkpoint, acceptanceCriteria: run.acceptanceCriteria };
}

/** Claim a successor once, before dispatch. A crash after claiming is never
 * blindly replayed; startup reconciliation sees the durable attempt/receipt. */
export function claimCheckpointContinuation(goalId: string, checkpointId: string, invocationRunId: string): boolean {
  return getDb().transaction(() => {
    const checkpoint = latestTaskCheckpoint(goalId);
    if (!checkpoint || checkpoint.checkpointId !== checkpointId || checkpoint.disposition !== "retry_required"
      || checkpoint.sideEffects.state !== "settled" || !longRunContinueDecision(goalId)?.continue) return false;
    const db = getDb();
    if (db.prepare("SELECT 1 FROM long_run_worker_attempts WHERE run_id = ? AND (state IN ('running','uncertain') OR side_effect_state = 'uncertain') LIMIT 1")
      .get(checkpoint.capsule.runId)) return false;
    if (db.prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = 'run.checkpoint_continuation' AND json_extract(payload_json, '$.checkpointId') = ?")
      .get(checkpoint.capsule.runId, checkpointId)) return false;
    appendLongRunEvent({ runId: checkpoint.capsule.runId, kind: "run.checkpoint_continuation", actorKind: "host", payload: { checkpointId, invocationRunId } });
    return true;
  })();
}
