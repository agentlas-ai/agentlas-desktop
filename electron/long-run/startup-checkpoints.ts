import { latestGoalWaitSubscription, registerOngoingGoalCycle, type GoalWaitSubscription } from "./wait-subscriptions";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { McpInvocationRequest } from "../../shared/types";
import type { InstructionSnapshot } from "../../shared/runtime-instructions";
import { automaticGoalResumeRequest } from "../invocation/automatic-goal";
import { exactLegacyGoalLifecycleRuntimeSelection, prepareLegacyGoalLifecycle } from "../invocation/legacy-goal-lifecycle";
import { appendChatMessage, getChat, getChatWorkingFolder } from "../store/chats";
import { getChatGoalRevision, getLegacyGoalLifecycleSnapshot, migrateLegacyGoalLifecycle } from "../store/chat-goals";
import { currentUiLocale } from "../ui-locale";
import { getDb } from "../store/db";
import { prepareCheckpointContinuation } from "./continuation";
import { claimGoalRuntimeSelection } from "./runtime-handoff";
import { compileProjectInstructionSnapshot } from "./instructions";
import { latestRuntimePlan } from "./plan";
import { restoreExactDesktopRuntimeSelection } from "./exact-runtime-binding";
import { listAgentSurfaces } from "../store/agent-surfaces";
import { appendLongRunEvent, getLongRun, getLongRunAttemptGoalRevision, getLongRunGoalRevisionBinding, transitionLongRun,
  blockHostPausedForEffectBoundaryUncertainty, listLongRunTasks, recordLongRunCycle, unsettledLongRunAttemptCount } from "../store/long-runs";
import { desktopAppInstanceId, assertDesktopLongRunAdmissionOpen } from "./app-runtime-coordinator";
import { latestTaskCheckpoint, recordTaskCheckpoint } from "./checkpoint";
import { reconcileHostPausedLongRuns } from "./startup-reconciler";
import { agentRunCwd } from "../runtime/exec";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN } from "../../shared/long-run";

export interface CheckpointStartupDispatcher {
  activeChatIds(): string[];
  start(request: McpInvocationRequest, workspaceBinding?: undefined, executionContext?: undefined, questionContinuation?: undefined, hostNoticePurpose?: "goal-continuation"): { runId: string };
}

export interface CheckpointStartupResult {
  runId: string;
  status: "started" | "scheduled" | "skipped";
  reason: string;
}

/** A lost verifier or failed wait insertion is not a permanent stop for an
 * ongoing mandate. Recover only a current, fully settled producer; schedule
 * observation rather than replaying its actions or promoting the result. */
export function scheduleUnverifiedOngoingGoalCycles(): CheckpointStartupResult[] {
  const results: CheckpointStartupResult[] = [];
  let afterId = "";
  while (true) {
    const rows = getDb().prepare(`SELECT id FROM long_runs WHERE id > ? AND status='blocked'
      AND blocked_reason IN ('verification_unavailable','goal_wait_registration_failed')
      AND surface IN ('one','work')
      AND execution_location='desktop-local' ORDER BY id LIMIT 100`).all(afterId) as Array<{ id: string }>;
    if (!rows.length) break;
    for (const { id } of rows) {
      afterId = id;
      try {
        assertDesktopLongRunAdmissionOpen();
        const candidate = getLongRun(id);
        if (!candidate || candidate.status !== "blocked"
          || !["verification_unavailable", "goal_wait_registration_failed"].includes(candidate.blockedReason ?? "")
          || getChatGoalRevision(candidate.goalId)?.lifecycle !== "ongoing"
          || legacyStartupWaitBlocksRecovery(latestGoalWaitSubscription(candidate.goalId))) continue;
        const producer = preflightMissingStartupCheckpoint(candidate, { unverifiedOngoing: true });
        const result = getDb().transaction(() => {
          const current = getLongRun(id);
          if (!current || current.version !== candidate.version || current.status !== "blocked"
            || current.blockedReason !== candidate.blockedReason
            || unsettledLongRunAttemptCount(id)
            || getChatGoalRevision(current.goalId)?.lifecycle !== "ongoing") throw new Error("ongoing_verification_recovery_changed");
          const effect = readInvocationEffectBoundary({ invocationRunId: producer.invocationRunId,
            expectedChatId: producer.chat.id });
          if (effect.effects !== "settled" || effect.snapshotDigest !== producer.effect.snapshotDigest)
            throw new Error("goal_wait_effects_uncertain");
          transitionLongRun({ runId: id, to: "queued", actorKind: "host",
            reason: "ongoing-observation-recovered", expectedVersion: current.version });
          transitionLongRun({ runId: id, to: "running", actorKind: "host",
            reason: "ongoing-observation-recovered" });
          recordLongRunCycle({ goalId: current.goalId, sourceInvocationId: producer.invocationRunId,
            progressState: "unknown", outcome: "ongoing-episode-unverified" });
          const wait = registerOngoingGoalCycle({ goalId: current.goalId,
            invocationRunId: producer.invocationRunId });
          appendLongRunEvent({ runId: id, kind: "run.ongoing_cycle_unverified", actorKind: "host",
            sourceEventId: `ongoing-unverified:${producer.invocationRunId}`,
            payload: { invocationRunId: producer.invocationRunId, waitId: wait.waitId,
              nextCheckAt: wait.nextCheckAt, recoveredAtStartup: true } });
          return { runId: id, status: "scheduled" as const, reason: "ongoing_observation_scheduled" };
        }).immediate();
        results.push(result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "ongoing_verification_recovery_unavailable";
        results.push({ runId: id, status: "skipped", reason });
      }
    }
  }
  return results;
}

/** A live/pending wait owns the next observation or dispatch boundary. A
 * legacy lifecycle repair must never race either state with a new invocation. */
export function legacyStartupWaitBlocksRecovery(wait: Pick<GoalWaitSubscription, "state"> | null): boolean {
  return wait?.state === "pending" || wait?.state === "claimed";
}

function* startupCheckpointCandidates(): Generator<NonNullable<ReturnType<typeof getLongRun>>> {
  let afterId = "";
  // A UI-sized listing cap can strand older Goals. Page by stable ID instead
  // of OFFSET, because a successful recovery changes each row's status.
  while (true) {
    const ids = getDb().prepare(`SELECT id FROM long_runs WHERE id > ?
      AND execution_location='desktop-local' AND host_owner_kind='desktop' AND surface<>'science'
      AND ((status='paused' AND pause_reason IN ('app_closed','crash_recovery'))
        OR (status='blocked' AND blocked_reason='checkpoint_continuation_failed'))
      ORDER BY id LIMIT 500`)
      .all(afterId) as Array<{ id: string }>;
    if (!ids.length) return;
    for (const { id } of ids) {
      afterId = id;
      const run = getLongRun(id);
      if (run) yield run;
    }
  }
}

class StartupReplayPreflightError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function startupReplayRefusal(reason: string): never {
  throw new StartupReplayPreflightError(reason);
}

function sameJson(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function producerInstructionSnapshot(invocationRunId: string, chatId: string): InstructionSnapshot | null {
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

function workerWorkspace(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as { cwd?: unknown };
    return typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : null;
  } catch { return null; }
}

function parsedRuntimeSelection(raw: string): import("../../shared/long-run").LongRunRuntimeSelection | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value && !Array.isArray(value) && typeof value.kind === "string" && typeof value.source === "string"
      ? value as unknown as import("../../shared/long-run").LongRunRuntimeSelection : null;
  } catch { return null; }
}

/** Read-only authority gate for minting a checkpoint after a host pause. A
 * completed/committed row is insufficient until its invocation receipt,
 * workspace, instructions, runtime and current Goal state all line up. */
function preflightMissingStartupCheckpoint(candidate: NonNullable<ReturnType<typeof getLongRun>>,
  options: { unverifiedOngoing?: boolean } = {}): {
  chat: NonNullable<ReturnType<typeof getChat>>;
  workerId: string;
  attempt: number;
  invocationRunId: string;
  workspacePath: string;
  effect: ReturnType<typeof readInvocationEffectBoundary>;
} {
  const chat = candidate.rootChatId ? getChat(candidate.rootChatId) : null;
  if (!chat || !candidate.rootChatId || chat.goalId !== candidate.goalId || chat.originSurface !== candidate.surface) {
    startupReplayRefusal("chat_binding_changed");
  }

  const revision = getChatGoalRevision(candidate.goalId);
  const binding = getLongRunGoalRevisionBinding(candidate.id);
  if (!revision || revision.chatId !== chat.id || !binding || binding.revision !== revision.revision) {
    startupReplayRefusal("goal_revision_changed");
  }
  for (const source of [revision.originalRequest, revision.sourceMessage]) {
    const message = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(source.messageId) as
      { chat_id: string; role: string; text: string } | undefined;
    if (!message || message.chat_id !== chat.id || message.role !== "user" || message.text !== source.text) {
      startupReplayRefusal("goal_source_changed");
    }
  }
  const newestUser = getDb().prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1")
    .get(chat.id) as { id: string } | undefined;
  if (!options.unverifiedOngoing && newestUser?.id !== revision.sourceMessage.messageId) startupReplayRefusal("newer_user_direction");

  // The missing-checkpoint path has no checkpoint history cursor to reuse, so
  // bind the source to the exact controller invocation before examining any
  // steer rows. A cancelled/failed steer is still a user direction that the
  // old invocation must not cause us to silently replay around.

  const unsettled = unsettledLongRunAttemptCount(candidate.id);
  if (unsettled > 0) startupReplayRefusal("attempt_unsettled");
  const producer = getDb().prepare(`SELECT a.id, a.task_id, a.invocation_run_id, a.state, a.side_effect_state, a.attempt,
      a.runtime_selection_json, w.id AS worker_id, w.runtime_selection_json AS worker_runtime_selection_json,
      w.workspace_binding_json
    FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id = a.worker_id AND w.run_id = a.run_id
    WHERE a.run_id = ? AND w.role = 'controller'
    ORDER BY a.rowid DESC LIMIT 1`).get(candidate.id) as {
      id: string; task_id: string; invocation_run_id: string | null; state: string; side_effect_state: string; attempt: number;
      runtime_selection_json: string; worker_id: string; worker_runtime_selection_json: string; workspace_binding_json: string;
    } | undefined;
  if (!producer || !producer.invocation_run_id || producer.state !== "completed" || producer.side_effect_state !== "committed") {
    startupReplayRefusal("controller_attempt_not_settled");
  }
  if (getLongRunAttemptGoalRevision(candidate.id, producer.id) !== revision.revision) {
    startupReplayRefusal("controller_attempt_revision_changed");
  }
  const invocationIntake = getDb().prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND chat_id = ? AND kind = 'automatic_goal_intake' ORDER BY seq ASC LIMIT 1")
    .get(producer.invocation_run_id, chat.id) as { payload_json: string } | undefined;
  let intakeSourceMessageId: string | null = null;
  try {
    const payload = invocationIntake ? JSON.parse(invocationIntake.payload_json) as { sourceMessageId?: unknown } : null;
    intakeSourceMessageId = typeof payload?.sourceMessageId === "string" ? payload.sourceMessageId : null;
  } catch { intakeSourceMessageId = null; }
  if (options.unverifiedOngoing) {
    // A normal continuation has no automatic_goal_intake event. It may have
    // seen later chat directions than the edited Goal source; require the
    // latest user direction to precede this exact One invocation instead.
    const started = getDb().prepare("SELECT ts, payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_started' ORDER BY seq ASC LIMIT 1")
      .get(producer.invocation_run_id, chat.id) as { ts: string; payload_json: string } | undefined;
    let startPayload: { oneMode?: unknown; latestUserMessageRowId?: unknown } = {};
    try { startPayload = JSON.parse(started?.payload_json ?? "{}"); } catch { /* invalid start */ }
    if (!started || (candidate.surface === "one" && startPayload.oneMode !== true) || !newestUser)
      startupReplayRefusal("history_missing");
    const latestUser = getDb().prepare("SELECT rowid AS cursor, created_at FROM chat_messages WHERE id=? AND chat_id=? AND role='user'")
      .get(newestUser.id, chat.id) as { cursor: number; created_at: string } | undefined;
    if (!latestUser || (typeof startPayload.latestUserMessageRowId === "number"
      ? latestUser.cursor > startPayload.latestUserMessageRowId
      : latestUser.created_at >= started.ts)) startupReplayRefusal("newer_user_direction");
  } else {
    if (!intakeSourceMessageId) startupReplayRefusal("history_missing");
    if (intakeSourceMessageId !== revision.sourceMessage.messageId) startupReplayRefusal("history_changed");
  }
  if (getDb().prepare("SELECT 1 FROM invocation_steers WHERE original_run_id = ? AND status IN ('queued','draining','cancelled','failed') LIMIT 1")
    .get(producer.invocation_run_id)) startupReplayRefusal("newer_user_direction");
  const attemptRuntime = parsedRuntimeSelection(producer.runtime_selection_json);
  const workerRuntime = parsedRuntimeSelection(producer.worker_runtime_selection_json);
  if (!attemptRuntime || !workerRuntime || !sameJson(attemptRuntime, workerRuntime)) startupReplayRefusal("runtime_binding_changed");

  const workspacePath = workerWorkspace(producer.workspace_binding_json);
  const currentWorkspace = getChatWorkingFolder(chat.id) ?? agentRunCwd();
  if (!workspacePath || !currentWorkspace || workspacePath !== currentWorkspace) startupReplayRefusal("workspace_changed");
  try { if (!statSync(workspacePath).isDirectory()) startupReplayRefusal("workspace_changed"); }
  catch { startupReplayRefusal("workspace_changed"); }

  const instructionSnapshot = producerInstructionSnapshot(producer.invocation_run_id, chat.id);
  if (!instructionSnapshot) startupReplayRefusal("instructions_missing");
  let currentInstructions: InstructionSnapshot;
  try { currentInstructions = compileProjectInstructionSnapshot({ projectDir: workspacePath }).snapshot; }
  catch { startupReplayRefusal("instructions_unavailable"); }
  if (currentInstructions.revision !== instructionSnapshot.revision
    || currentInstructions.environmentId !== instructionSnapshot.environmentId) startupReplayRefusal("instructions_changed");

  const plan = latestRuntimePlan(candidate.id);
  const expectedSteps = listLongRunTasks(candidate.id).map((task) => ({ taskId: task.id, title: task.title, state: task.state }));
  const verifierOnlyStateChange = options.unverifiedOngoing && plan?.steps.length === expectedSteps.length
    && plan.steps.every((step, index) => {
      const current = expectedSteps[index];
      return step.taskId === current.taskId && step.title === current.title
        && (step.state === current.state || (step.taskId === producer.task_id
          && step.state === "verifying" && current.state === "failed"));
    });
  if (!plan || plan.schemaVersion !== "agentlas.runtime-plan.v1" || plan.runId !== candidate.id
    || plan.goalRevision !== revision.revision
    || (!sameJson(plan.steps, expectedSteps) && !verifierOnlyStateChange)) startupReplayRefusal("plan_changed");

  let effect: ReturnType<typeof readInvocationEffectBoundary>;
  try { effect = readInvocationEffectBoundary({ invocationRunId: producer.invocation_run_id, expectedChatId: chat.id }); }
  catch { startupReplayRefusal("effect_boundary_uncertain"); }
  if (effect.effects !== "settled" || !effect.receiptEventId || !effect.terminalEventId || !effect.snapshotDigest) {
    startupReplayRefusal("effect_boundary_uncertain");
  }
  const artifacts = listAgentSurfaces(chat.id).map((surface) => ({
    artifactId: surface.id, artifactRevision: surface.artifactRevision ?? null,
    sourceDigest: surface.artifactRef?.sourceDigest ?? null, dataDigest: surface.artifactRef?.dataDigest ?? null,
    stateRevision: surface.stateRevision ?? null, stateSchemaDigest: surface.artifactRef?.stateSchemaDigest ?? null,
  }));
  if (artifacts.some((artifact) => artifact.artifactRevision === null || artifact.stateRevision === null)) {
    startupReplayRefusal("artifacts_changed");
  }
  const artifactRefs = new Set(artifacts.map((artifact) => `artifact:${artifact.artifactId}:revision:${artifact.artifactRevision}`));
  if (effect.artifactRefs.some((ref) => !artifactRefs.has(ref))) startupReplayRefusal("artifacts_changed");

  try { restoreExactDesktopRuntimeSelection({ stored: attemptRuntime, context: {
    invocationRunId: producer.invocation_run_id, longRunId: candidate.id, attemptId: producer.id, chatId: chat.id,
  } }); }
  catch { startupReplayRefusal("runtime_binding_changed"); }
  try {
    if (!automaticGoalResumeRequest(chat.id, candidate.version)) startupReplayRefusal("goal_authority_unavailable");
  } catch (error) {
    startupReplayRefusal(error instanceof Error ? error.message : "goal_authority_unavailable");
  }
  return { chat, workerId: producer.worker_id, attempt: producer.attempt,
    invocationRunId: producer.invocation_run_id, workspacePath, effect };
}

/** A legacy timer refusal is not a user pause. Recover only the missing
 * lifecycle bit, then use a newly validated settled checkpoint for dispatch.
 * No model text, scheduler terminal or Resume click supplies authority. */
export async function resumeLegacyOngoingBlockedGoals(dispatcher: CheckpointStartupDispatcher): Promise<CheckpointStartupResult[]> {
  const results: CheckpointStartupResult[] = [];
  const appInstanceId = desktopAppInstanceId();
  let afterId = "";
  while (true) {
    try { assertDesktopLongRunAdmissionOpen(); } catch { break; }
    const ids = getDb().prepare(`SELECT id FROM long_runs WHERE id > ? AND status = 'blocked'
      AND surface = 'one' AND execution_location = 'desktop-local'
      AND blocked_reason = 'goal_wait_ongoing_authority_required' ORDER BY id LIMIT 100`)
      .all(afterId) as Array<{ id: string }>;
    if (!ids.length) break;
    for (const { id } of ids) {
      afterId = id;
      const refuse = (reason: string): void => {
        appendLongRunEvent({ runId: id, kind: "run.legacy_lifecycle_startup", actorKind: "host",
          payload: { appInstanceId, status: "skipped", reason } });
        results.push({ runId: id, status: "skipped", reason });
      };
      let successorRunId: string | null = null;
      try {
        const candidate = getLongRun(id);
        if (!candidate || candidate.status !== "blocked" || candidate.blockedReason !== "goal_wait_ongoing_authority_required") continue;
        const already = getDb().prepare(`SELECT 1 FROM long_run_events WHERE run_id = ?
          AND kind = 'run.legacy_lifecycle_startup' AND json_extract(payload_json, '$.appInstanceId') = ? LIMIT 1`)
          .get(id, appInstanceId);
        if (already) continue;
        const snapshot = getLegacyGoalLifecycleSnapshot(candidate.goalId);
        const chat = candidate.rootChatId ? getChat(candidate.rootChatId) : null;
        if (!snapshot || !chat || chat.id !== snapshot.revision.chatId || chat.goalId !== candidate.goalId
          || chat.originSurface !== "one" || getLongRunGoalRevisionBinding(id)?.revision !== snapshot.revision.revision) {
          refuse("legacy_goal_binding_unavailable"); continue;
        }
        if (dispatcher.activeChatIds().includes(chat.id)) { refuse("chat_busy"); continue; }
        // A stale wait subscription is an observation/dispatch state of its
        // own. If it is still pending or claimed, the wait reconciler or its
        // exact successor owns the next transition; legacy lifecycle repair
        // must not create a competing invocation from the same blocked run.
        const wait = latestGoalWaitSubscription(candidate.goalId);
        if (legacyStartupWaitBlocksRecovery(wait)) {
          refuse("goal_wait_subscription_recovery_pending"); continue;
        }
        if (unsettledLongRunAttemptCount(id)) { refuse("attempt_unsettled"); continue; }
        const newestUser = getDb().prepare(`SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'user'
          ORDER BY rowid DESC LIMIT 1`).get(chat.id) as { id: string } | undefined;
        if (newestUser?.id !== snapshot.revision.sourceMessage.messageId) { refuse("newer_user_direction"); continue; }
        const producer = getDb().prepare(`SELECT a.id, a.invocation_run_id, a.state, a.side_effect_state,
          a.attempt, w.id AS worker_id, w.workspace_binding_json
          FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id = a.worker_id AND w.run_id = a.run_id
          WHERE a.run_id = ? AND w.role = 'controller' ORDER BY a.rowid DESC LIMIT 1`).get(id) as {
          id: string; invocation_run_id: string | null; state: string; side_effect_state: string;
          attempt: number; worker_id: string; workspace_binding_json: string;
        } | undefined;
        if (!producer?.invocation_run_id || producer.state !== "completed" || producer.side_effect_state !== "committed"
          || getLongRunAttemptGoalRevision(id, producer.id) !== snapshot.revision.revision) {
          refuse("producer_not_settled"); continue;
        }
        const pendingDirection = getDb().prepare(`SELECT 1 FROM invocation_steers WHERE original_run_id = ?
          AND status IN ('queued','draining','cancelled','failed') LIMIT 1`).get(producer.invocation_run_id);
        if (pendingDirection) { refuse("newer_user_direction"); continue; }
        const effect = readInvocationEffectBoundary({ invocationRunId: producer.invocation_run_id, expectedChatId: chat.id });
        if (effect.effects !== "settled") { refuse("effect_boundary_uncertain"); continue; }
        const selection = exactLegacyGoalLifecycleRuntimeSelection({ longRunId: id, chatId: chat.id });
        if (!selection) { refuse("exact_runtime_unavailable"); continue; }
        const prepared = await prepareLegacyGoalLifecycle({ goalId: candidate.goalId, longRunId: id,
          expectedVersion: candidate.version, expectedStatus: "blocked", source: snapshot.revision.sourceMessage,
          runtimeSelection: selection, signal: new AbortController().signal, hostStoredSourceRecovery: true });
        if (!prepared || prepared.verdict !== "ongoing") {
          refuse(prepared?.reasonCode ?? "legacy_lifecycle_judgment_unavailable"); continue;
        }
        const claimed = getDb().transaction(() => {
          assertDesktopLongRunAdmissionOpen();
          const current = getLongRun(id), currentSnapshot = getLegacyGoalLifecycleSnapshot(candidate.goalId);
          const currentChat = getChat(chat.id);
          if (!current || current.version !== candidate.version || current.status !== "blocked"
            || current.blockedReason !== "goal_wait_ongoing_authority_required"
            || !currentSnapshot || currentSnapshot.payloadJson !== prepared.snapshot.payloadJson
            || currentChat?.goalId !== candidate.goalId || currentChat.originSurface !== "one"
            || getLongRunGoalRevisionBinding(id)?.revision !== currentSnapshot.revision.revision
            || unsettledLongRunAttemptCount(id)
            || JSON.stringify(exactLegacyGoalLifecycleRuntimeSelection({ longRunId: id, chatId: chat.id })) !== JSON.stringify(selection)
            || dispatcher.activeChatIds().includes(chat.id)) throw new Error("legacy_lifecycle_startup_conflict");
          const latestUser = getDb().prepare(`SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'user'
            ORDER BY rowid DESC LIMIT 1`).get(chat.id) as { id: string } | undefined;
          if (latestUser?.id !== prepared.source.messageId || getDb().prepare(`SELECT 1 FROM invocation_steers
            WHERE original_run_id = ? AND status IN ('queued','draining','cancelled','failed') LIMIT 1`)
              .get(producer.invocation_run_id)) throw new Error("legacy_lifecycle_newer_direction");
          const currentEffect = readInvocationEffectBoundary({ invocationRunId: producer.invocation_run_id!, expectedChatId: chat.id });
          if (currentEffect.effects !== "settled" || currentEffect.receiptEventId !== effect.receiptEventId
            || currentEffect.snapshotDigest !== effect.snapshotDigest) throw new Error("legacy_lifecycle_effect_changed");
          let workspace: string | null = null;
          try { workspace = JSON.parse(producer.workspace_binding_json)?.cwd ?? null; } catch { /* Reject below. */ }
          if (!workspace || typeof workspace !== "string") throw new Error("legacy_lifecycle_workspace_unavailable");
          migrateLegacyGoalLifecycle({ goalId: candidate.goalId,
            expectedPayloadJson: prepared.snapshot.payloadJson, source: prepared.source, preserveRevision: true });
          appendLongRunEvent({ runId: id, kind: "run.legacy_lifecycle_classified", actorKind: "host",
            payload: { schemaVersion: "agentlas.legacy-goal-lifecycle.v1", sourceMessageId: prepared.source.messageId,
              revision: prepared.snapshot.revision.revision, lifecycle: "ongoing", previousPayloadDigest: prepared.snapshotDigest,
              runtimeReceipt: prepared.runtimeReceipt, verdict: prepared.verdict,
              reasonCode: prepared.reasonCode, trigger: "host-startup-stored-source" } });
          const checkpoint = recordTaskCheckpoint({ goalId: candidate.goalId, workerId: producer.worker_id,
            attempt: producer.attempt, invocationRunId: producer.invocation_run_id,
            disposition: "retry_required", verdicts: [], evidenceRefs: [], projectDir: workspace });
          const continuation = prepareCheckpointContinuation(checkpoint);
          const request = automaticGoalResumeRequest(chat.id, getLongRun(id)!.version);
          if (!request || JSON.stringify(continuation.runtimeSelection) !== JSON.stringify(selection)) {
            throw new Error("legacy_lifecycle_resume_authority_unavailable");
          }
          successorRunId = randomUUID();
          getDb().prepare(`UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ?
            WHERE goal_id = ? AND chat_id = ? AND status = 'blocked'`)
            .run(new Date().toISOString(), candidate.goalId, chat.id);
          transitionLongRun({ runId: id, to: "queued", actorKind: "host",
            reason: "legacy-lifecycle-startup-resume", expectedVersion: getLongRun(id)!.version, appInstanceId });
          appendLongRunEvent({ runId: id, kind: "run.checkpoint_startup", actorKind: "host",
            payload: { appInstanceId, checkpointId: checkpoint.checkpointId,
              invocationRunId: successorRunId, status: "claimed", source: "legacy-lifecycle" } });
          appendLongRunEvent({ runId: id, kind: "run.legacy_lifecycle_startup", actorKind: "host",
            payload: { appInstanceId, status: "claimed", checkpointId: checkpoint.checkpointId,
              invocationRunId: successorRunId } });
          claimGoalRuntimeSelection(checkpoint, successorRunId);
          return { checkpoint, request: { ...request, runId: successorRunId,
            runtimeSelection: continuation.runtimeSelection, userPrompt: continuation.userPrompt } };
        })();
        const started = dispatcher.start(claimed.request, undefined, undefined, undefined, "goal-continuation");
        if (started.runId !== successorRunId) throw new Error("legacy_lifecycle_dispatch_identity_mismatch");
        const current = getLongRun(id);
        if (current?.status === "queued") transitionLongRun({ runId: id, to: "running", actorKind: "host",
          reason: "legacy-lifecycle-startup-dispatched", expectedVersion: current.version, appInstanceId });
        appendLongRunEvent({ runId: id, kind: "run.checkpoint_startup_dispatched", actorKind: "host",
          payload: { appInstanceId, checkpointId: claimed.checkpoint.checkpointId, invocationRunId: successorRunId } });
        results.push({ runId: id, status: "started", reason: "legacy_ongoing_source_restored" });
      } catch (error) {
        try {
          const current = getLongRun(id);
          if (successorRunId && current && ["queued", "running"].includes(current.status)) {
            transitionLongRun({ runId: id, to: "paused", actorKind: "host", reason: "runtime_unavailable" });
          }
        } catch { /* A corrupt run does not prevent checking other Goals. */ }
        const code = error instanceof Error && /^[a-z_]+(?::[a-z_]+)?$/.test(error.message)
          ? error.message : "legacy_lifecycle_startup_unavailable";
        try { refuse(code); } catch { results.push({ runId: id, status: "skipped", reason: code }); }
      }
    }
  }
  return results;
}

/** Called only after auth, plugins, IPC and queued user directions have been
 * reconciled. A host pause or a continuation failure before dispatch can use
 * a settled checkpoint; an uncertain effect or prior dispatch cannot replay. */
export function resumeSettledGoalCheckpoints(dispatcher: CheckpointStartupDispatcher): CheckpointStartupResult[] {
  try {
    assertDesktopLongRunAdmissionOpen();
  } catch (error) {
    // A quit/update handoff can close the coordinator between the startup
    // bootstrap stages and this optional recovery pass. There is no work to
    // admit after that boundary, so treat it as an expected no-op instead of
    // surfacing a second Electron startup error.
    if (error instanceof Error && error.message === "desktop_long_run_admission_closed") return [];
    throw error;
  }
  const appInstanceId = desktopAppInstanceId();
  const results: CheckpointStartupResult[] = [];
  // Include clean-shutdown pauses: they were already paused before boot and
  // therefore are absent from recoverInterruptedDesktopLongRunsAtStartup().
  for (const candidate of startupCheckpointCandidates()) {
    const failedBeforeContinuation = candidate.status === "blocked"
      && candidate.blockedReason === "checkpoint_continuation_failed";
    if (candidate.surface === "science" || candidate.hostOwnerKind !== "desktop"
      || !(failedBeforeContinuation || (candidate.status === "paused"
        && ["app_closed", "crash_recovery"].includes(candidate.pauseReason ?? "")))) continue;
    // Pending subscriptions restore observation, not ordinary inference.
    // A claimed wake without a dispatch receipt is inspectable, never replayed.
    const wait = latestGoalWaitSubscription(candidate.goalId);
    if (wait && ["pending", "claimed"].includes(wait.state)) continue;
    const evaluated = getDb().prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = 'run.checkpoint_startup' AND json_extract(payload_json, '$.appInstanceId') = ? LIMIT 1")
      .get(candidate.id, appInstanceId);
    if (evaluated) continue;
    const refuse = (reason: string): void => {
      appendLongRunEvent({ runId: candidate.id, kind: "run.checkpoint_startup", actorKind: "host",
        payload: { appInstanceId, status: "skipped", reason } });
      results.push({ runId: candidate.id, status: "skipped", reason });
    };
    const blockForReview = (diagnostic: string): boolean => {
      if (failedBeforeContinuation) return false;
      const current = getLongRun(candidate.id);
      if (!current || current.status !== "paused" || !["app_closed", "crash_recovery"].includes(current.pauseReason ?? "")) return false;
      try {
        blockHostPausedForEffectBoundaryUncertainty(candidate.id, current.version);
        appendLongRunEvent({ runId: candidate.id, kind: "run.checkpoint_startup", actorKind: "host",
          payload: { appInstanceId, status: "blocked", reason: GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN, diagnostic } });
        results.push({ runId: candidate.id, status: "skipped", reason: GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN });
        return true;
      } catch { return false; }
    };
    const nonBlockingRefusals = new Set([
      "newer_user_direction", "chat_busy", "budget-spent", "budget-cost-unavailable",
      "not-paused", "not-a-host-pause", "run_missing", "science_surface",
      "checkpoint_newer_user_direction", "checkpoint_source_message_changed",
      "checkpoint_goal_revision_changed", "checkpoint_chat_binding_changed",
      "checkpoint_goal_criteria_changed", "checkpoint_original_constraints_changed",
      "history_changed",
      "auto_goal_resume_revision_pending", "auto_goal_resume_chat_busy", "auto_goal_budget_exhausted",
      "budget_cost_unavailable", "auto_goal_resume_surface_mismatch", "auto_goal_resume_not_stopped",
    ]);
    let successorRunId: string | null = null;
    try {
      if (failedBeforeContinuation) {
        if (unsettledLongRunAttemptCount(candidate.id)) { refuse("attempt-unsettled"); continue; }
      } else {
        const decision = reconcileHostPausedLongRuns([candidate.id])[0]?.decision;
        if (!decision?.resume) {
          const reason = decision && !decision.resume ? decision.reason : "run_missing";
          if (reason === "attempt-unsettled" && blockForReview(reason)) continue;
          refuse(reason);
          continue;
        }
      }
      let checkpoint = latestTaskCheckpoint(candidate.goalId);
      if (!checkpoint) {
        if (failedBeforeContinuation) { refuse("checkpoint_missing"); continue; }
        let preflight: ReturnType<typeof preflightMissingStartupCheckpoint>;
        try { preflight = preflightMissingStartupCheckpoint(candidate); }
        catch (error) {
          const reason = error instanceof StartupReplayPreflightError ? error.reason : "checkpoint_preflight_unavailable";
          if (!nonBlockingRefusals.has(reason) && blockForReview(reason)) continue;
          refuse(reason); continue;
        }
        try {
          checkpoint = recordTaskCheckpoint({
            goalId: candidate.goalId, workerId: preflight.workerId, attempt: preflight.attempt,
            invocationRunId: preflight.invocationRunId, disposition: "retry_required", verdicts: [],
            evidenceRefs: [
              `event:${preflight.effect.receiptEventId}`, `event:${preflight.effect.terminalEventId}`,
              `effect-boundary:${preflight.effect.snapshotDigest}`, ...preflight.effect.artifactRefs,
            ], projectDir: preflight.workspacePath,
          });
        } catch (error) {
          const reason = error instanceof Error && /^[a-z_]+(?::[a-z_]+)?$/.test(error.message)
            ? error.message : "checkpoint_record_unavailable";
          if (blockForReview(reason)) continue;
          refuse(reason); continue;
        }
      }
      if (checkpoint.disposition !== "retry_required") { refuse("checkpoint_not_resumable"); continue; }
      const checkpointBoundary = checkpoint.sideEffects.boundary;
      if (checkpoint.sideEffects.state !== "settled" || !checkpointBoundary
        || checkpointBoundary.invocationRunId !== checkpoint.invocationRunId
        || !checkpointBoundary.receiptEventId || !checkpointBoundary.terminalEventId || !checkpointBoundary.snapshotDigest) {
        if (blockForReview("checkpoint_effect_boundary_uncertain")) continue;
        refuse("checkpoint_effect_boundary_uncertain"); continue;
      }
      // A previous host may have crossed the dispatch boundary and died
      // before recording its outcome. The absence of invoke_started is not
      // proof that the successor never reached an external runtime.
      const priorClaim = getDb().prepare(`SELECT 1 FROM long_run_events WHERE run_id = ?
        AND ((kind = 'run.checkpoint_startup' AND json_extract(payload_json, '$.status') = 'claimed')
          OR kind = 'run.checkpoint_continuation')
        AND json_extract(payload_json, '$.checkpointId') = ? LIMIT 1`)
        .get(candidate.id, checkpoint.checkpointId);
      if (priorClaim) {
        if (blockForReview("checkpoint_prior_dispatch_claim_uncertain")) continue;
        refuse("checkpoint_prior_dispatch_claim_uncertain"); continue;
      }
      const chatId = candidate.rootChatId;
      const chat = chatId ? getChat(chatId) : null;
      if (!chat || chat.goalId !== candidate.goalId || chat.originSurface !== candidate.surface) {
        if (blockForReview("chat_binding_changed")) continue;
        refuse("chat_binding_changed"); continue;
      }
      if (dispatcher.activeChatIds().includes(chat.id)) { refuse("chat_busy"); continue; }
      const explicitCwd = getChatWorkingFolder(chat.id);
      const cwd = explicitCwd ?? (checkpoint.workspacePath === agentRunCwd() ? agentRunCwd() : null);
      let workspaceOk = Boolean(cwd && cwd === checkpoint.workspacePath);
      try { workspaceOk = workspaceOk && statSync(cwd!).isDirectory(); } catch { workspaceOk = false; }
      if (!workspaceOk) {
        if (blockForReview("workspace_changed")) continue;
        refuse("workspace_changed"); continue;
      }
      // A human direction queued during the old invocation must not disappear
      // merely because boot recovery changed its delivery state to cancelled.
      const pendingDirection = getDb().prepare("SELECT 1 FROM invocation_steers WHERE original_run_id = ? AND status IN ('queued','draining','cancelled','failed') LIMIT 1")
        .get(checkpoint.invocationRunId ?? "");
      const newerMessage = getDb().prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND created_at > ? LIMIT 1")
        .get(chat.id, checkpoint.createdAt);
      if (pendingDirection || newerMessage) { refuse("newer_user_direction"); continue; }
      const continuation = prepareCheckpointContinuation(checkpoint);
      // The request helper revalidates the exact current revision, original
      // authority and remaining budget without mutating state or writing a user event.
      const resumeVersion = getLongRun(candidate.id)?.version;
      if (resumeVersion == null) throw new Error("checkpoint_startup_state_changed");
      const request = automaticGoalResumeRequest(chat.id, resumeVersion);
      if (!request) {
        if (blockForReview("goal_authority_unavailable")) continue;
        refuse("goal_authority_unavailable"); continue;
      }
      const selection = continuation.runtimeSelection;
      successorRunId = randomUUID();
      const resumedRequest: McpInvocationRequest = {
        ...request, runId: successorRunId, runtimeSelection: selection,
        ...(request.oneMode ? { onePermissionMode: request.permissions } : {}),
        userPrompt: continuation.userPrompt,
      };
      // The event, CAS transition and fresh invocation identity commit together.
      // No await separates this claim from start, so a person cannot be raced
      // after the final state/binding checks in this host process.
      getDb().transaction(() => {
        const current = getLongRun(candidate.id);
        if (!current || current.version !== resumeVersion
          || (failedBeforeContinuation
            ? current.status !== "blocked" || current.blockedReason !== "checkpoint_continuation_failed"
            : current.status !== "paused" || !["app_closed", "crash_recovery"].includes(current.pauseReason ?? ""))
          || getChat(chat.id)?.goalId !== candidate.goalId) throw new Error("checkpoint_startup_state_changed");
        const currentRevision = getChatGoalRevision(candidate.goalId);
        const latestUser = getDb().prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1")
          .get(chat.id) as { id: string } | undefined;
        if (!currentRevision || currentRevision.chatId !== chat.id || latestUser?.id !== currentRevision.sourceMessage.messageId
          || getDb().prepare("SELECT 1 FROM invocation_steers WHERE original_run_id = ? AND status IN ('queued','draining','cancelled','failed') LIMIT 1")
            .get(checkpoint.invocationRunId ?? "")) throw new Error("checkpoint_newer_user_direction");
        transitionLongRun({ runId: current.id, to: "queued", actorKind: "host",
          reason: "checkpoint-startup-resume", expectedVersion: current.version, appInstanceId });
        appendLongRunEvent({ runId: current.id, kind: "run.checkpoint_startup", actorKind: "host",
          payload: { appInstanceId, checkpointId: checkpoint.checkpointId, invocationRunId: successorRunId, status: "claimed" } });
        claimGoalRuntimeSelection(checkpoint, successorRunId!);
      })();
      /*
       * 재시작 자동 재개는 그 실행의 런타임을 정확히 복원한다(설계). 그 사이 사람이 대화의 모델을 바꿔 두었다면
       * 조용히 옛 모델로 이어가면 안 된다 — 무엇으로 이어가고 지금 선택은 무엇이며 바꾸려면 어떻게 하는지 한 줄(2026-09-14).
       */
      const chosen = getChat(chat.id)?.runtimeSelection ?? null;
      if (chosen && (chosen.kind !== selection.kind || (chosen.model ?? null) !== (selection.model ?? null))) {
        const label = (value: { kind: string; model?: string | null }) => `${value.kind}${value.model ? ` · ${value.model}` : ""}`;
        const text = currentUiLocale() === "ko"
          ? `이 작업은 시작할 때 고른 ${label(selection)} 로 이어갑니다 · 지금 선택은 ${label(chosen)} 입니다 — 새 모델로 하려면 중지한 뒤 다시 보내 주세요.`
          : `This task continues with ${label(selection)}, the runtime it started with · your current choice is ${label(chosen)} — to use the new model, stop and send again.`;
        appendChatMessage(chat.id, "assistant", text, { hostNotice: { purpose: "goal-continuation", runId: successorRunId } });
      }
      const started = dispatcher.start(resumedRequest, undefined, undefined, undefined, "goal-continuation");
      if (started.runId !== successorRunId) throw new Error("checkpoint_startup_dispatch_identity_mismatch");
      const current = getLongRun(candidate.id);
      if (current?.status === "queued") transitionLongRun({ runId: current.id, to: "running", actorKind: "host",
        reason: "checkpoint-startup-dispatched", expectedVersion: current.version, appInstanceId });
      appendLongRunEvent({ runId: candidate.id, kind: "run.checkpoint_startup_dispatched", actorKind: "host",
        payload: { appInstanceId, checkpointId: checkpoint.checkpointId, invocationRunId: successorRunId } });
      results.push({ runId: candidate.id, status: "started", reason: "settled_checkpoint" });
    } catch (error) {
      const current = getLongRun(candidate.id);
      if (successorRunId && current && ["queued", "running"].includes(current.status)) {
        transitionLongRun({ runId: current.id, to: "paused", actorKind: "host", reason: "runtime_unavailable" });
      }
      const code = error instanceof Error && /^[a-z_]+(?::[a-z_]+)?$/.test(error.message)
        ? error.message : "checkpoint_startup_unavailable";
      if (!successorRunId && !nonBlockingRefusals.has(code) && blockForReview(code)) continue;
      refuse(code);
    }
  }
  return results;
}
