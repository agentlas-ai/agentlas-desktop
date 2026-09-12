import { statSync } from "node:fs";
import type { RuntimeSelection } from "../../shared/types";
import { compileLongRunCheckpoint, type LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { getDb } from "../store/db";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { listAgentSurfaces } from "../store/agent-surfaces";
import { compileProjectInstructionSnapshot } from "./instructions";
import { latestRuntimePlan } from "./plan";
import { resolveDesktopRuntimeAdapter } from "./runtime-adapters";
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Pure host admission check, shared by live and startup continuation. It uses
 * exact persisted source identities, not model prose or timestamp guesses.
 * Existing client runnerRequestForRuntime delivers the compiled checkpoint in
 * native turnContext or managed systemPrompt; this also checks its full budget
 * before a continuation claim consumes the durable dispatch slot. */
export function prepareCheckpointContinuation(checkpoint: LongRunTaskCheckpoint, dispatchInvocationId?: string): {
  runtimeSelection: RuntimeSelection; context: string; userPrompt: string;
} {
  const run = getLongRunByGoalId(checkpoint.goalId);
  const revision = getChatGoalRevision(checkpoint.goalId);
  if (!run || run.surface === "science" || !run.rootChatId || !revision
    || checkpoint.schemaVersion !== "agentlas.task-checkpoint.v2" || checkpoint.capsule.runId !== run.id
    || checkpoint.goalRevision !== revision.revision || checkpoint.goalRevision !== getLongRunGoalRevisionBinding(run.id)?.revision
    || revision.chatId !== run.rootChatId) throw new Error("checkpoint_goal_revision_changed");
  const chat = getChat(run.rootChatId);
  if (!chat || chat.goalId !== run.goalId || chat.originSurface !== run.surface) throw new Error("checkpoint_chat_binding_changed");
  if (checkpoint.objective !== run.objective || checkpoint.objective !== revision.objective.replace(/\s+/g, " ").trim()
    || !same(checkpoint.acceptanceCriteria, run.acceptanceCriteria)
    || !same(checkpoint.acceptanceCriteria, revision.acceptanceCriteria.map(item => item.text.replace(/\s+/g, " ").trim()))) throw new Error("checkpoint_goal_criteria_changed");
  if (checkpoint.capsule.originalConstraintsRef !== `message:${revision.originalRequest.messageId}`
    || checkpoint.capsule.originalConstraints !== revision.originalRequest.text) throw new Error("checkpoint_original_constraints_changed");
  for (const source of [revision.originalRequest, revision.sourceMessage]) {
    const message = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(source.messageId) as { chat_id: string; role: string; text: string } | undefined;
    if (!message || message.chat_id !== source.chatId || source.chatId !== chat.id || message.role !== "user"
      || message.text !== source.text) throw new Error("checkpoint_source_message_changed");
  }
  const history = checkpoint.capsule.historyRangeRef;
  const cursor = history?.lastMessageId ? getDb().prepare("SELECT rowid AS cursor FROM chat_messages WHERE id = ? AND chat_id = ?")
    .get(history.lastMessageId, chat.id) as { cursor: number } | undefined : undefined;
  if (!history || history.chatId !== chat.id || !cursor) throw new Error("checkpoint_history_cursor_missing");
  if (getDb().prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND rowid > ? LIMIT 1").get(chat.id, cursor.cursor)
    || getDb().prepare("SELECT 1 FROM invocation_steers WHERE original_run_id = ? AND status IN ('queued','draining','cancelled','failed') LIMIT 1")
      .get(checkpoint.invocationRunId ?? "")) throw new Error("checkpoint_newer_user_direction");
  const cwd = getChatWorkingFolder(chat.id);
  if (!cwd || cwd !== checkpoint.workspacePath || !statSync(cwd).isDirectory()) throw new Error("checkpoint_workspace_changed");
  if (!same(checkpoint.capsule.plan, latestRuntimePlan(run.id))) throw new Error("checkpoint_plan_changed");
  const snapshot = compileProjectInstructionSnapshot({ projectDir: cwd }).snapshot;
  if (!checkpoint.capsule.instructionSnapshot || snapshot.revision !== checkpoint.capsule.instructionSnapshot.revision) throw new Error("checkpoint_instructions_changed");
  const artifacts = listAgentSurfaces(chat.id).map(surface => ({ artifactId: surface.id,
    artifactRevision: surface.artifactRevision ?? null, sourceDigest: surface.artifactRef?.sourceDigest ?? null,
    dataDigest: surface.artifactRef?.dataDigest ?? null, stateRevision: surface.stateRevision ?? null,
    stateSchemaDigest: surface.artifactRef?.stateSchemaDigest ?? null })).sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  if (!same(artifacts, [...(checkpoint.capsule.artifactVersions ?? [])].sort((a, b) => a.artifactId.localeCompare(b.artifactId)))
    || artifacts.some(item => item.artifactRevision === null || item.stateRevision === null)) throw new Error("checkpoint_artifacts_changed");
  const expected = checkpoint.sideEffects.boundary;
  if (checkpoint.sideEffects.state !== "settled" || !expected || expected.invocationRunId !== checkpoint.invocationRunId) throw new Error("checkpoint_effect_boundary_missing");
  const boundary = readInvocationEffectBoundary({ invocationRunId: expected.invocationRunId, expectedChatId: chat.id });
  if (boundary.effects !== "settled" || boundary.terminalEventId !== expected.terminalEventId
    || boundary.receiptEventId !== expected.receiptEventId || boundary.snapshotDigest !== expected.snapshotDigest) throw new Error("checkpoint_effect_boundary_changed");
  const newest = getDb().prepare("SELECT invocation_run_id, state FROM long_run_worker_attempts WHERE run_id = ? AND worker_id IN (SELECT id FROM long_run_workers WHERE run_id = ? AND role = 'controller') ORDER BY rowid DESC LIMIT 1")
    .get(run.id, run.id) as { invocation_run_id: string | null; state: string } | undefined;
  if (!newest || newest.invocation_run_id !== checkpoint.invocationRunId) {
    const authorizedDispatch = dispatchInvocationId && newest?.invocation_run_id === dispatchInvocationId && newest.state === "running"
      && getDb().prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND kind IN ('run.checkpoint_continuation','run.checkpoint_startup') AND json_extract(payload_json,'$.checkpointId') = ? AND json_extract(payload_json,'$.invocationRunId') = ? LIMIT 1")
        .get(run.id, checkpoint.checkpointId, dispatchInvocationId);
    if (!authorizedDispatch) throw new Error("checkpoint_newer_attempt_exists");
  }
  const worker = getDb().prepare("SELECT runtime_selection_json FROM long_run_workers WHERE run_id = ? AND role = 'controller' ORDER BY updated_at DESC LIMIT 1")
    .get(run.id) as { runtime_selection_json: string } | undefined;
  if (!worker) throw new Error("checkpoint_runtime_binding_missing");
  const runtimeSelection = JSON.parse(worker.runtime_selection_json) as RuntimeSelection;
  const producer = getDb().prepare("SELECT runtime_selection_json FROM long_run_worker_attempts WHERE invocation_run_id = ? AND worker_id IN (SELECT id FROM long_run_workers WHERE run_id = ? AND role = 'controller') ORDER BY attempt DESC LIMIT 1")
    .get(checkpoint.invocationRunId, run.id) as { runtime_selection_json: string } | undefined;
  if (!producer || !same(runtimeSelection, JSON.parse(producer.runtime_selection_json))) throw new Error("checkpoint_runtime_binding_changed");
  resolveDesktopRuntimeAdapter(runtimeSelection);
  const context = compileLongRunCheckpoint(checkpoint, runtimeSelection.kind);
  return { runtimeSelection, context,
    userPrompt: `Continue the existing goal from host checkpoint ${checkpoint.checkpointId}. Inspect existing results and gather missing verification evidence against every preserved criterion. The host supplies the exact checkpoint context with this turn.` };
}
