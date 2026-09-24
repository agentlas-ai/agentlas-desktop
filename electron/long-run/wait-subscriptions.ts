import { ownsHostGoalLoop } from "./host-goal-surface";
import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { getDb } from "../store/db";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getAgentSurface } from "../store/agent-surfaces";
import { getChatGoalRevision } from "../store/chat-goals";
import { addLongRunTask, appendLongRunEvent, blockHostPausedClaimedGoalWait, getLongRun, getLongRunByGoalId, getLongRunGoalRevisionBinding, listLongRunTasks, transitionLongRun, unsettledLongRunAttempts } from "../store/long-runs";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { assertDesktopLongRunAdmissionOpen } from "./app-runtime-coordinator";
import { claimCheckpointContinuation, latestTaskCheckpoint, recordTaskCheckpoint } from "./checkpoint";
import { prepareCheckpointContinuation } from "./continuation";
import { ongoingCycleWakeAt } from "./ongoing-wake";
import { latestRuntimePlan, recordOngoingStallReplan } from "./plan";
import { longRunMonetaryRefusal } from "./budget";
import { detectRuntimes } from "../runtime/detect";
import { runtimeCooldownForSelection } from "../runtime/runtime-cooldown";
import { autoHandoffGoalRuntimeAtWait, goalAutoRuntimeRestoreDue } from "./runtime-handoff";
import { withGoalWaitAccounting } from "./accounting-context";
import { reflectOngoingStall, replanModelFingerprint, type StallReplanResult } from "./stall-replan";
import type { OngoingStallReplan } from "../../shared/runtime-plan";
import { parseGoalWaitIntent, type GoalWaitIntent } from "./wait-emitter";

export interface GoalWaitSubscription {
  schemaVersion: "agentlas.goal-wait-subscription.v1";
  waitId: string; runId: string; goalId: string; goalRevision: number; chatId: string;
  revision: number; sourceInvocationId: string; checkpointId: string; intent: GoalWaitIntent;
  subjectRef: string; cursor: string | null; lastObservedDigest: string;
  nextCheckAt: string | null; intervalMs: number; deadline: string | null;
  state: "pending" | "claimed" | "dispatched" | "blocked" | "expired" | "cancelled";
  wakeReason: string | null; successorInvocationId: string | null; executionAvailability: "app-running";
  /** Main-only recovery route. Legacy waits omit these fields. */
  recoveryMode?: "stall_replan" | "stall_backoff";
  recoveryProgressKey?: string;
  /** The first successor after an unverified episode may inspect only. */
  observationOnly?: boolean;
}
export interface GoalWaitObservation { digest: string; cursor: string | null; terminal: boolean; reason: string | null }
export interface GoalWaitDispatch { waitId: string; goalId: string; checkpointId: string; invocationRunId: string; request: McpInvocationRequest }
export interface GoalWaitAttention { waitId: string; goalId: string; chatId: string; reason: string; state: GoalWaitSubscription["state"]; executionAvailability: "app-running" }
export interface GoalWaitHost {
  dispatch(input: GoalWaitDispatch): { runId: string };
  isChatBusy(chatId: string): boolean;
  notify?(input: GoalWaitAttention): void;
}
let host: GoalWaitHost | null = null;
const replanInFlight = new Map<string, AbortController>();
export function interruptGoalWaitReplans(): void {
  for (const controller of replanInFlight.values()) controller.abort(new Error("app_shutdown"));
}
export function goalWaitReplansSettled(): boolean { return replanInFlight.size === 0; }
/** Main installs its single invocation dispatcher after startup bindings are ready. */
export function setGoalWaitHost(value: GoalWaitHost | null): void { host = value; }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (intent: GoalWaitIntent) => intent.subject.kind === "invocation"
  ? `invocation:${intent.subject.invocationRunId}` : intent.subject.kind === "artifact"
    ? `artifact:${intent.subject.artifactId}` : `timer:${intent.subject.notBefore}`;
export function latestGoalWaitSubscription(goalId: string): GoalWaitSubscription | null {
  const run = getLongRunByGoalId(goalId);
  if (!run || run.surface === "science") return null;
  const row = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id=? AND kind='run.wait_subscription' ORDER BY seq DESC LIMIT 1")
    .get(run.id) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json).subscription : null;
}
/** An admitted new invocation supersedes the old wait. Delayed observers must
 * see this durable cancellation instead of dispatching a competing successor. */
export function supersedeGoalWaitForInvocation(goalId: string, invocationRunId: string): void {
  getDb().transaction(() => {
    const wait = latestGoalWaitSubscription(goalId), run = getLongRunByGoalId(goalId);
    if (!wait || wait.state !== "pending" || wait.sourceInvocationId === invocationRunId || !run || run.surface === "science") return;
    persist({ ...wait, revision: wait.revision + 1, state: "cancelled", nextCheckAt: null, wakeReason: "new_invocation" });
    if (run.status === "waiting_tool") transitionLongRun({ runId: run.id, to: "running", actorKind: "host", reason: "goal_wait_superseded" });
  })();
}
function persist(value: GoalWaitSubscription): void {
  appendLongRunEvent({ runId: value.runId, kind: "run.wait_subscription", actorKind: "host",
    sourceEventId: `wait:${value.waitId}:${value.revision}`, payload: { subscription: value } });
}
export function observeGoalWaitSubject(wait: Pick<GoalWaitSubscription, "chatId" | "sourceInvocationId" | "intent">, now = Date.now()): GoalWaitObservation {
  const chat = getChat(wait.chatId);
  if (!chat) throw new Error("goal_wait_chat_missing");
  const subject = wait.intent.subject;
  if (subject.kind === "timer") {
    const due = now >= Date.parse(subject.notBefore);
    return { digest: hash({ notBefore: subject.notBefore, due }), cursor: subject.notBefore, terminal: due, reason: due ? "ongoing_cycle_due" : null };
  }
  if (subject.kind === "artifact") {
    const surface = getAgentSurface(subject.artifactId);
    if (!surface || surface.chatId !== chat.id || surface.artifactRevision == null || surface.stateRevision == null) throw new Error("goal_wait_artifact_binding_invalid");
    const cursor = `${surface.artifactRevision}:${surface.stateRevision}`;
    return { digest: hash({ cursor, sourceDigest: surface.artifactRef?.sourceDigest, dataDigest: surface.artifactRef?.dataDigest }), cursor, terminal: false, reason: null };
  }
  if (subject.invocationRunId === wait.sourceInvocationId) throw new Error("goal_wait_self_subscription");
  const otherChat = getChat(subject.chatId);
  if (!otherChat || otherChat.projectId !== chat.projectId) throw new Error("goal_wait_subject_owner_mismatch");
  const start = getDb().prepare("SELECT payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_started' LIMIT 1")
    .get(subject.invocationRunId, otherChat.id) as { payload_json: string } | undefined;
  if (!start || JSON.parse(start.payload_json).invocationSource === "science") throw new Error("goal_wait_invocation_binding_invalid");
  const event = getDb().prepare("SELECT id, seq, kind FROM run_events WHERE run_id=? AND chat_id=? AND kind IN ('invoke_completed','invoke_failed','invoke_threw','invoke_cancelled','invoke_interrupted') ORDER BY seq DESC LIMIT 1")
    .get(subject.invocationRunId, otherChat.id) as { id: string; seq: number; kind: string } | undefined;
  // invoke_completed can precede adapter drainage. Wake only after the actual
  // service settlement receipt names this exact host terminal, even on failure.
  const settled = event ? getDb().prepare("SELECT id, payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='runtime_effect_boundary' AND json_extract(payload_json,'$.terminalEventId')=? ORDER BY seq DESC LIMIT 1")
    .get(subject.invocationRunId, otherChat.id, event.id) as { id: string; payload_json: string } | undefined : undefined;
  const boundary = settled ? readInvocationEffectBoundary({ invocationRunId: subject.invocationRunId, expectedChatId: otherChat.id }) : null;
  return { digest: hash({ event: event ?? null, receipt: settled?.id ?? null, effects: boundary?.effects ?? "pending" }),
    cursor: settled && event ? `${event.id}:${settled.id}` : event ? `${event.id}:settlement-pending` : null,
    terminal: Boolean(settled), reason: settled ? event?.kind === "invoke_completed" && boundary?.effects !== "settled" ? "invocation_effects_uncertain" : event?.kind ?? null : null };
}

/** Actual service result producer. The request is accepted only after its own
 * host effect receipt is settled; waiting is never a model completion claim. */
export function registerGoalWaitSubscription(input: { goalId: string; invocationRunId: string; intent: GoalWaitIntent; hasTransientAttachments?: boolean; projectDir?: string | null; now?: number;
  recoveryMode?: GoalWaitSubscription["recoveryMode"]; recoveryProgressKey?: string;
  observationOnly?: boolean }): GoalWaitSubscription {
  assertDesktopLongRunAdmissionOpen();
  const validated = parseGoalWaitIntent("```agentlas-goal-wait\n" + JSON.stringify(input.intent) + "\n```").request;
  if (validated?.status !== "requested") throw new Error("goal_wait_request_invalid");
  input = { ...input, intent: validated.intent };
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const run = getLongRunByGoalId(input.goalId), revision = getChatGoalRevision(input.goalId);
    if (!run || !revision || !run.rootChatId || run.surface === "science" || run.status !== "running"
      || getChat(run.rootChatId)?.goalId !== run.goalId) throw new Error("goal_wait_goal_not_running");
    if (!revision.authorityRefs.some(ref => /^invocation:([^:]+):permission:(read|write|full)$/.test(ref))) throw new Error("goal_wait_original_authority_missing");
    if (input.hasTransientAttachments) throw new Error("goal_wait_attachment_refresh_required");
    if (input.intent.deadline && Date.parse(input.intent.deadline) <= now) throw new Error("goal_wait_deadline_elapsed");
    if (input.intent.subject.kind === "timer") {
      if (revision.lifecycle !== "ongoing") throw new Error("goal_wait_ongoing_authority_required");
      const due = Date.parse(input.intent.subject.notBefore);
      if (due < now + 60_000 || (input.intent.deadline && due >= Date.parse(input.intent.deadline))) throw new Error("goal_wait_timer_invalid");
    }
    if (input.recoveryMode && (!ownsHostGoalLoop(run.surface) || input.intent.subject.kind !== "timer"
      || run.stallStreak < run.stallWindow || !input.recoveryProgressKey
      || input.recoveryProgressKey !== (run.lastProgressKey ?? `one-host:unknown:revision:${revision.revision}`))) {
      throw new Error("goal_wait_stall_recovery_invalid");
    }
    const prior = latestGoalWaitSubscription(run.goalId);
    if (prior?.state === "pending" || prior?.state === "claimed") throw new Error("goal_wait_already_registered");
    const boundary = readInvocationEffectBoundary({ invocationRunId: input.invocationRunId, expectedChatId: run.rootChatId });
    if (boundary.effects !== "settled") throw new Error("goal_wait_effects_uncertain");
    const attempt = getDb().prepare("SELECT worker_id, attempt FROM long_run_worker_attempts WHERE invocation_run_id=? AND run_id=?")
      .get(input.invocationRunId, run.id) as { worker_id: string; attempt: number } | undefined;
    if (!attempt) throw new Error("goal_wait_attempt_missing");
    const observation = observeGoalWaitSubject({ chatId: run.rootChatId, sourceInvocationId: input.invocationRunId, intent: input.intent }, now);
    const checkpoint = recordTaskCheckpoint({ goalId: run.goalId, workerId: attempt.worker_id, attempt: attempt.attempt,
      invocationRunId: input.invocationRunId, disposition: "retry_required", verdicts: [{ criterionIndex: 0, verdict: "inconclusive",
        reason: "Waiting for the registered subject; no completion verification has been claimed.", nextAction: input.intent.nextAction }], evidenceRefs: [],
      projectDir: input.projectDir?.trim() || getChatWorkingFolder(run.rootChatId) });
    prepareCheckpointContinuation(checkpoint);
    const subscription: GoalWaitSubscription = { schemaVersion: "agentlas.goal-wait-subscription.v1", waitId: randomUUID(), runId: run.id,
      goalId: run.goalId, goalRevision: revision.revision, chatId: run.rootChatId, revision: 1, sourceInvocationId: input.invocationRunId,
      checkpointId: checkpoint.checkpointId, intent: input.intent, subjectRef: identity(input.intent), cursor: observation.cursor,
      lastObservedDigest: observation.digest, nextCheckAt: input.intent.subject.kind === "timer" ? input.intent.subject.notBefore : new Date(now + 30_000).toISOString(), intervalMs: 30_000,
      deadline: input.intent.deadline, state: "pending", wakeReason: null, successorInvocationId: null, executionAvailability: "app-running" };
    if (input.recoveryMode) {
      subscription.recoveryMode = input.recoveryMode;
      subscription.recoveryProgressKey = input.recoveryProgressKey;
    }
    if (input.observationOnly) subscription.observationOnly = true;
    persist(subscription);
    transitionLongRun({ runId: run.id, to: "waiting_tool", actorKind: "host", reason: `goal_wait:${subscription.waitId}` });
    return subscription;
  })();
}

/** The mandate remains open after verified work. A quiet, durable observation
 * cycle is the fallback; it is not permission to repeat an external action. */
export function registerOngoingGoalCycle(input: { goalId: string; invocationRunId: string; hasTransientAttachments?: boolean; now?: number }): GoalWaitSubscription {
  const now = input.now ?? Date.now();
  // Keep the plan read, receipt validation and wait insertion within one DB
  // transaction so another plan revision cannot sneak between them.
  return getDb().transaction(() => {
    const run = getLongRunByGoalId(input.goalId);
    const revision = getChatGoalRevision(input.goalId);
    let boundary: ReturnType<typeof readInvocationEffectBoundary> | null = null;
    try {
      if (run?.rootChatId) boundary = readInvocationEffectBoundary({ invocationRunId: input.invocationRunId, expectedChatId: run.rootChatId });
    } catch { /* A missing/uncertain receipt cannot set the wake time. Registration still enforces its own receipt. */ }
    const producerCheckpoint = latestTaskCheckpoint(input.goalId);
    const plan = run ? latestRuntimePlan(run.id) : null;
    const priorWait = latestGoalWaitSubscription(input.goalId);
    const justObserved = priorWait?.state === "dispatched"
      && priorWait.successorInvocationId === input.invocationRunId
      && priorWait.observationOnly === true;
    const unresolvedPriorEffects = Boolean(run && getDb().prepare(
      "SELECT 1 FROM long_run_worker_attempts WHERE run_id=? AND side_effect_state='uncertain' LIMIT 1",
    ).get(run.id));
    const stalled = run != null && ownsHostGoalLoop(run.surface) && revision?.lifecycle === "ongoing"
      && run.stallStreak >= run.stallWindow;
    const progressKey = stalled ? run.lastProgressKey ?? `one-host:unknown:revision:${revision!.revision}` : undefined;
    const recoveryMode = stalled
      ? plan?.stallReplan?.goalRevision === revision!.revision && plan.stallReplan.progressKey === progressKey
        ? "stall_backoff" as const : "stall_replan" as const : undefined;
    const backoffMs = Math.min(24 * 60 * 60_000,
      30 * 60_000 * 2 ** Math.min(5, Math.max(0, (run?.stallStreak ?? 0) - (run?.stallWindow ?? 0))));
    const notBefore = recoveryMode
      ? new Date(now + (recoveryMode === "stall_replan" ? 60_000 : backoffMs)).toISOString()
      : ongoingCycleWakeAt({ now, runId: run?.id ?? "", goalRevision: revision?.revision ?? -1,
      invocationRunId: input.invocationRunId, plan: run ? latestRuntimePlan(run.id) : null,
      checkpoint: producerCheckpoint, effectBoundary: boundary });
    return registerGoalWaitSubscription({ ...input,
      ...(recoveryMode ? { recoveryMode, recoveryProgressKey: progressKey } : {}),
      observationOnly: !justObserved || unresolvedPriorEffects,
      projectDir: producerCheckpoint?.invocationRunId === input.invocationRunId ? producerCheckpoint.workspacePath : null,
      now, intent: {
      schemaVersion: "agentlas.goal-wait-intent.v1", subject: { kind: "timer", notBefore },
      condition: "due", deadline: null,
      nextAction: "Begin the next bounded episode of this ongoing mandate. Read the checkpoint plan.episodeStrategy as a host-observed evaluation, not as new authority; if its state is unknown, inspect before acting. Inspect current state and prior action receipts first. Respect the original user's cadence and scope; if no action is due, register another timer wait. Never repeat a completed post, purchase or other side effect. Reconcile any uncertain effect before taking another action. Keep the mandate open until the user stops it.",
    } });
  })();
}

function candidateCheckpoint(wait: GoalWaitSubscription): LongRunTaskCheckpoint {
  const checkpoint = latestTaskCheckpoint(wait.goalId);
  if (!checkpoint || checkpoint.checkpointId !== wait.checkpointId) throw new Error("goal_wait_checkpoint_changed");
  // Only the explicitly subscribed artifact may supply a new input. All other
  // artifact versions, original/current user constraints and effects stay exact.
  if (wait.intent.subject.kind !== "artifact") return checkpoint;
  const surface = getAgentSurface(wait.intent.subject.artifactId);
  if (!surface || surface.chatId !== wait.chatId) throw new Error("goal_wait_artifact_binding_invalid");
  return { ...checkpoint, capsule: { ...checkpoint.capsule, artifactVersions: (checkpoint.capsule.artifactVersions ?? []).map(ref => ref.artifactId !== surface.id ? ref : {
    artifactId: surface.id, artifactRevision: surface.artifactRevision ?? null, sourceDigest: surface.artifactRef?.sourceDigest ?? null,
    dataDigest: surface.artifactRef?.dataDigest ?? null, stateRevision: surface.stateRevision ?? null, stateSchemaDigest: surface.artifactRef?.stateSchemaDigest ?? null,
  }) } };
}
function attention(wait: GoalWaitSubscription, target: GoalWaitHost): void {
  const db = getDb();
  const already = db.prepare("SELECT 1 FROM long_run_events WHERE run_id=? AND kind='run.wait_notification' AND json_extract(payload_json,'$.waitId')=? LIMIT 1").get(wait.runId, wait.waitId);
  if (already) return;
  appendLongRunEvent({ runId: wait.runId, kind: "run.wait_notification", actorKind: "host", sourceEventId: `wait-notify:${wait.waitId}`,
    payload: { waitId: wait.waitId, state: wait.state, reason: wait.wakeReason, delivery: target.notify ? "attempted" : "unavailable" } });
  try { target.notify?.({ waitId: wait.waitId, goalId: wait.goalId, chatId: wait.chatId, reason: wait.wakeReason ?? "changed", state: wait.state, executionAvailability: "app-running" }); }
  catch { /* Persisted at-most-once attempt is not proof of platform delivery. */ }
}

/** A claim is written before calling the invocation service. After a host
 * restart, even the absence of invoke_started is not proof that dispatch did
 * not reach an external runtime. Never reconstruct and replay that request. */
export function reconcileClaimedGoalWaitsAtStartup(target: GoalWaitHost | null = host): GoalWaitAttention[] {
  try { assertDesktopLongRunAdmissionOpen(); } catch { return []; }
  const reconciled: GoalWaitAttention[] = [];
  // This one-time recovery pass must not strand older Goals behind the normal
  // UI listing cap of 500 rows.
  const candidateIds = getDb().prepare(`SELECT id FROM long_runs WHERE status='paused'
    AND execution_location='desktop-local' AND surface<>'science'
    AND pause_reason IN ('app_closed','crash_recovery') ORDER BY id`).all() as Array<{ id: string }>;
  for (const { id } of candidateIds) {
    const candidate = getLongRun(id);
    if (!candidate) continue;
    if (candidate.surface === "science" || !["app_closed", "crash_recovery"].includes(candidate.pauseReason ?? "")) continue;
    let blocked: GoalWaitSubscription | null = null;
    getDb().transaction(() => {
      const current = getLongRun(candidate.id), wait = latestGoalWaitSubscription(candidate.goalId);
      if (!current || current.version !== candidate.version || current.status !== "paused"
        || !["app_closed", "crash_recovery"].includes(current.pauseReason ?? "")
        || !wait || wait.state !== "claimed" || wait.runId !== current.id || wait.goalId !== current.goalId) return;
      const revision = getChatGoalRevision(wait.goalId);
      const checkpoint = latestTaskCheckpoint(wait.goalId);
      const claim = wait.successorInvocationId ? getDb().prepare(`SELECT seq FROM long_run_events
        WHERE run_id=? AND kind='run.checkpoint_continuation'
          AND json_extract(payload_json,'$.checkpointId')=?
          AND json_extract(payload_json,'$.invocationRunId')=? ORDER BY seq DESC LIMIT 1`)
        .get(current.id, wait.checkpointId, wait.successorInvocationId) as { seq: number } | undefined : undefined;
      const bindingExact = revision?.revision === wait.goalRevision
        && current.rootChatId === wait.chatId && getChat(wait.chatId)?.goalId === wait.goalId
        && checkpoint?.checkpointId === wait.checkpointId && Boolean(claim);
      // These are receipts for the *exact* intended successor, not an inference
      // from a chat's most recent invocation or a model's success claim.
      const started = wait.successorInvocationId ? getDb().prepare(
        "SELECT id FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_started' LIMIT 1",
      ).get(wait.successorInvocationId, wait.chatId) as { id: string } | undefined : undefined;
      const attempt = wait.successorInvocationId ? getDb().prepare(
        "SELECT id, state, side_effect_state FROM long_run_worker_attempts WHERE run_id=? AND invocation_run_id=? LIMIT 1",
      ).get(current.id, wait.successorInvocationId) as { id: string; state: string; side_effect_state: string } | undefined : undefined;
      const terminal = wait.successorInvocationId ? getDb().prepare(`SELECT id FROM run_events
        WHERE run_id=? AND chat_id=? AND kind IN ('invoke_completed','invoke_failed','invoke_threw','invoke_cancelled','invoke_interrupted')
        ORDER BY seq DESC LIMIT 1`).get(wait.successorInvocationId, wait.chatId) as { id: string } | undefined : undefined;
      const effect = terminal && wait.successorInvocationId ? getDb().prepare(`SELECT id FROM run_events
        WHERE run_id=? AND chat_id=? AND kind='runtime_effect_boundary'
          AND json_extract(payload_json,'$.terminalEventId')=? ORDER BY seq DESC LIMIT 1`)
        .get(wait.successorInvocationId, wait.chatId, terminal.id) as { id: string } | undefined : undefined;
      // The old claim need not remain an obstacle if the exact successor has
      // already been verified and produced a *new* settled retry checkpoint.
      // Retiring the old wait never replays that successor: the ordinary
      // startup checkpoint path may only claim a fresh invocation from the
      // verifier's newer checkpoint. A terminal/effect receipt alone is not a
      // verification verdict and must keep the existing fail-closed path.
      let settledRetry = false;
      let settledRetryReceiptId: string | null = null;
      if (bindingExact === false && claim && checkpoint && wait.successorInvocationId
        && checkpoint.checkpointId !== wait.checkpointId
        && checkpoint.schemaVersion === "agentlas.task-checkpoint.v2"
        && checkpoint.disposition === "retry_required" && checkpoint.sideEffects.state === "settled"
        && checkpoint.invocationRunId === wait.successorInvocationId
        && checkpoint.goalId === wait.goalId && checkpoint.capsule.runId === current.id
        && checkpoint.goalRevision === wait.goalRevision
        && getLongRunGoalRevisionBinding(current.id)?.revision === wait.goalRevision
        && revision?.revision === wait.goalRevision
        && current.rootChatId === wait.chatId && getChat(wait.chatId)?.goalId === wait.goalId) {
        const completed = getDb().prepare(`SELECT id FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_completed' LIMIT 1`)
          .get(wait.successorInvocationId, wait.chatId) as { id: string } | undefined;
        const controller = getDb().prepare(`SELECT a.id FROM long_run_worker_attempts a
          JOIN long_run_workers w ON w.id=a.worker_id AND w.run_id=a.run_id
          WHERE a.run_id=? AND a.invocation_run_id=? AND w.role='controller'
            AND a.state='completed' AND a.side_effect_state='committed' LIMIT 1`)
          .get(current.id, wait.successorInvocationId) as { id: string } | undefined;
        const verifier = getDb().prepare(`SELECT a.id FROM long_run_worker_attempts a
          JOIN long_run_workers w ON w.id=a.worker_id AND w.run_id=a.run_id
          WHERE a.run_id=? AND a.worker_id=? AND a.attempt=? AND w.role='verifier'
            AND a.state='completed' AND a.side_effect_state<>'uncertain' LIMIT 1`)
          .get(current.id, checkpoint.capsule.workerId, checkpoint.capsule.attempt) as { id: string } | undefined;
        const nextAlreadyClaimed = getDb().prepare(`SELECT 1 FROM long_run_events WHERE run_id=?
          AND kind IN ('run.checkpoint_continuation','run.checkpoint_startup','run.checkpoint_startup_dispatched')
          AND json_extract(payload_json,'$.checkpointId')=?
          AND (kind<>'run.checkpoint_startup' OR json_extract(payload_json,'$.status')='claimed') LIMIT 1`)
          .get(current.id, checkpoint.checkpointId);
        let boundary: ReturnType<typeof readInvocationEffectBoundary> | null = null;
        try { boundary = readInvocationEffectBoundary({ invocationRunId: wait.successorInvocationId, expectedChatId: wait.chatId }); }
        catch { /* Missing or contradictory receipts never retire the claim. */ }
        settledRetry = Boolean(completed && controller && verifier && !nextAlreadyClaimed
          && boundary?.effects === "settled" && boundary.terminalEventId === completed.id
          && boundary.receiptEventId === checkpoint.sideEffects.boundary?.receiptEventId
          && boundary.snapshotDigest === checkpoint.sideEffects.boundary?.snapshotDigest
          && checkpoint.sideEffects.boundary?.terminalEventId === completed.id
          && checkpoint.sideEffects.boundary?.invocationRunId === wait.successorInvocationId);
        if (settledRetry) settledRetryReceiptId = boundary!.receiptEventId;
      }
      if (settledRetry) {
        const retired: GoalWaitSubscription = { ...wait, revision: wait.revision + 1,
          state: "dispatched", nextCheckAt: null, wakeReason: "goal_wait_successor_verified_retry_checkpoint" };
        persist(retired);
        appendLongRunEvent({ runId: current.id, kind: "run.wait_claim_reconciled", actorKind: "host",
          payload: { waitId: wait.waitId, successorInvocationId: wait.successorInvocationId,
            checkpointId: checkpoint!.checkpointId, terminalEventId: terminal?.id ?? null,
            effectBoundaryReceiptId: settledRetryReceiptId, outcome: "verified_retry_checkpoint_no_replay" } });
        return;
      }
      const reason = bindingExact ? "goal_wait_claimed_dispatch_uncertain" : "goal_wait_claimed_binding_changed";
      const next: GoalWaitSubscription = { ...wait, revision: wait.revision + 1, state: "blocked", nextCheckAt: null, wakeReason: reason };
      persist(next);
      appendLongRunEvent({ runId: current.id, kind: "run.wait_claim_reconciled", actorKind: "host",
        payload: { waitId: wait.waitId, goalId: wait.goalId, goalRevision: wait.goalRevision,
          checkpointId: wait.checkpointId, successorInvocationId: wait.successorInvocationId,
          checkpointClaimEventSeq: claim?.seq ?? null, invokeStartedEventId: started?.id ?? null,
          terminalEventId: terminal?.id ?? null, effectBoundaryReceiptId: effect?.id ?? null, attemptId: attempt?.id ?? null,
          attemptState: attempt?.state ?? null, sideEffectState: attempt?.side_effect_state ?? null,
          reason, outcome: "attention_required_no_replay" } });
      // A dedicated CAS blocks this exceptional host pause without inventing
      // queued/running states. A user Stop or pause never matches its predicate.
      blockHostPausedClaimedGoalWait(current.id, getLongRun(current.id)!.version, reason);
      blocked = next;
    })();
    if (blocked) {
      const wait = blocked as GoalWaitSubscription;
      reconciled.push({ waitId: wait.waitId, goalId: wait.goalId, chatId: wait.chatId,
        reason: wait.wakeReason!, state: wait.state, executionAvailability: "app-running" });
      if (target) attention(wait, target);
    }
  }
  return reconciled;
}

/** Scheduler is only the timer. The installed Main service remains the only
 * dispatcher; compare-and-swap snapshots prevent duplicate wakes and Stop races. */
function* goalWaitPollingCandidates(): Generator<NonNullable<ReturnType<typeof getLongRun>>> {
  let afterId = "";
  // The UI listing caps at 500. Stable ID paging ensures an older pending
  // subscription cannot remain invisible on every scheduler tick.
  while (true) {
    const rows = getDb().prepare(`SELECT id FROM long_runs WHERE id > ?
      AND status IN ('waiting_tool','paused') AND execution_location='desktop-local'
      AND surface<>'science' ORDER BY id LIMIT 500`).all(afterId) as Array<{ id: string }>;
    if (!rows.length) return;
    for (const { id } of rows) {
      afterId = id;
      const run = getLongRun(id);
      if (run) yield run;
    }
  }
}

export async function pollGoalWaitSubscriptions(options: { now?: number; clock?: () => number; host?: GoalWaitHost;
  observe?: (wait: GoalWaitSubscription) => GoalWaitObservation | Promise<GoalWaitObservation>;
  /** Synthetic test seam; production always uses the pinned no-tools runner. */
  reflect?: typeof reflectOngoingStall } = {}): Promise<void> {
  const target = options.host ?? host;
  if (!target) return;
  try { assertDesktopLongRunAdmissionOpen(); } catch { return; }
  const clock = options.clock ?? (() => options.now ?? Date.now());
  const now = clock();
  for (const candidate of goalWaitPollingCandidates()) {
    if (candidate.surface === "science") continue;
    const wait = latestGoalWaitSubscription(candidate.goalId);
    if (!wait || wait.state !== "pending" || target.isChatBusy(wait.chatId)) continue;
    if (candidate.status === "paused" && !["app_closed", "crash_recovery"].includes(candidate.pauseReason ?? "")) continue;
    const due = !wait.nextCheckAt || Date.parse(wait.nextCheckAt) <= now || (wait.deadline !== null && Date.parse(wait.deadline) <= now);
    if (!due && candidate.status !== "paused") continue;
    let observation: GoalWaitObservation | null = null, failure: string | null = null;
    let storageBusy = false;
    try { if (due) observation = await (options.observe ? options.observe(wait) : observeGoalWaitSubject(wait, clock())); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(code)) storageBusy = true;
      else failure = error instanceof Error && /^goal_wait_[a-z_]+$/.test(error.message)
        ? error.message : "goal_wait_source_unavailable";
    }
    if (storageBusy) {
      // A concurrent SQLite writer is no evidence that the watched subject or
      // Goal authority changed. Keep the exact pending wait and try the same
      // read later; never dispatch work from a failed observation.
      try {
        getDb().transaction(() => {
          const current = getLongRun(candidate.id), latest = latestGoalWaitSubscription(wait.goalId);
          if (!current || !latest || current.version !== candidate.version
            || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending"
            || !["waiting_tool", "paused"].includes(current.status)) return;
          persist({ ...latest, revision: latest.revision + 1,
            nextCheckAt: new Date(clock() + 30_000).toISOString(), wakeReason: "goal_wait_observation_retry" });
        }).immediate();
      } catch { /* The next poll may retry the still-due original wait. */ }
      continue;
    }
    let replan: StallReplanResult | null = null;
    if (due && !failure && wait.recoveryMode === "stall_replan") {
      // A scheduled no-tools call still spends the Goal's inference budget.
      // Refuse it before dispatch if Main's authority, budget, settled-effect,
      // or app-liveness boundary has changed. The transaction below repeats
      // these checks after the await, so this read is not an execution grant.
      try {
        assertDesktopLongRunAdmissionOpen();
        const current = getLongRun(wait.runId), latest = latestGoalWaitSubscription(wait.goalId);
        const revision = getChatGoalRevision(wait.goalId);
        if (!current || current.version !== candidate.version || !latest
          || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending"
          || !["waiting_tool", "paused"].includes(current.status)
          || (current.status === "paused" && !["app_closed", "crash_recovery"].includes(current.pauseReason ?? ""))
          || target.isChatBusy(wait.chatId)) {
          // Another poll or user/app transition owns this snapshot. Do not
          // turn a stale read into a blocked Goal.
          continue;
        }
        const checkpoint = candidateCheckpoint(wait);
        prepareCheckpointContinuation(checkpoint);
        if (!ownsHostGoalLoop(current.surface) || !revision || revision.lifecycle !== "ongoing"
          || revision.revision !== wait.goalRevision || getChat(wait.chatId)?.goalId !== wait.goalId) {
          failure = "goal_wait_goal_revision_changed";
        } else if (!revision.authorityRefs.some(ref => /^invocation:([^:]+):permission:(read|write|full)$/.test(ref))) {
          failure = "goal_wait_original_authority_missing";
        } else if (checkpoint.sideEffects.state !== "settled" || unsettledLongRunAttempts(current.id).length) {
          failure = "goal_wait_effects_uncertain";
        } else {
          const deadline = current.budget.wallclockDeadline ? Date.parse(current.budget.wallclockDeadline) : Number.NaN;
          failure = Number.isFinite(deadline) && clock() >= deadline ? "budget_wallclock_exhausted"
            : current.budget.maxCycles != null && current.cycleCount >= current.budget.maxCycles ? "budget_cycles_exhausted"
              : longRunMonetaryRefusal(current);
        }
      } catch { failure = "goal_wait_context_changed"; }
    }
    let quotaInventory: Awaited<ReturnType<typeof detectRuntimes>> | null = null;
    let quotaWaitUntil: number | null = null;
    if (due && !failure && ownsHostGoalLoop(candidate.surface) && !wait.recoveryMode) {
      try {
        const checkpoint = candidateCheckpoint(wait);
        const current = prepareCheckpointContinuation(checkpoint).runtimeSelection;
        const cooling = runtimeCooldownForSelection(current, clock());
        if (cooling?.kind === "quota" || goalAutoRuntimeRestoreDue(checkpoint, current, clock())) {
          quotaWaitUntil = cooling?.until ?? clock();
          quotaInventory = await detectRuntimes(true);
        }
      } catch { /* The transaction below owns the exact context refusal. */ }
    }
    if (due && !failure && wait.recoveryMode === "stall_replan") {
      if (replanInFlight.has(wait.waitId)) continue;
      const controller = new AbortController();
      replanInFlight.set(wait.waitId, controller);
      try {
        const checkpoint = latestTaskCheckpoint(wait.goalId);
        replan = checkpoint?.checkpointId === wait.checkpointId
          ? await withGoalWaitAccounting({ waitId: wait.waitId, goalId: wait.goalId,
            goalRevision: wait.goalRevision, checkpointId: wait.checkpointId, chatId: wait.chatId },
            () => (options.reflect ?? reflectOngoingStall)({ checkpoint,
              progressKey: wait.recoveryProgressKey ?? "", stallStreak: candidate.stallStreak,
              previousAction: checkpoint.capsule.plan?.stallReplan?.action
                ?? checkpoint.capsule.plan?.episodeStrategy?.nextAction ?? null,
              previousAlternative: checkpoint.capsule.plan?.stallReplan?.alternative ?? null,
              signal: controller.signal }))
          : { status: "unavailable", reason: "stall_replan_checkpoint_changed" };
      } catch { replan = { status: "unavailable", reason: "stall_replan_runtime_failed" }; }
      finally { replanInFlight.delete(wait.waitId); }
    }
    // Accounted inference legitimately appends Goal usage events while the
    // model is awaited. Compare against the post-call run version, then repeat
    // every authority/status/effect check under the transaction below.
    const expectedVersion = getLongRun(wait.runId)?.version ?? candidate.version;
    let dispatch: GoalWaitDispatch | null = null, notice: GoalWaitSubscription | null = null;
    try { getDb().transaction(() => {
      const current = getLongRun(wait.runId), latest = latestGoalWaitSubscription(wait.goalId);
      try { assertDesktopLongRunAdmissionOpen(); } catch { return; }
      if (!current || !latest || current.version !== expectedVersion || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending"
        || target.isChatBusy(wait.chatId) || !["waiting_tool", "paused"].includes(current.status)) return;
      if (current.status === "paused" && !["app_closed", "crash_recovery"].includes(current.pauseReason ?? "")) return;
      let checkpoint: LongRunTaskCheckpoint | null = null;
      try { checkpoint = candidateCheckpoint(wait); prepareCheckpointContinuation(checkpoint); }
      catch (error) { failure = error instanceof Error && /^checkpoint_[a-z_]+$/.test(error.message) ? error.message : "goal_wait_context_changed"; }
      if (!failure && checkpoint && quotaInventory && quotaWaitUntil && !wait.recoveryMode) {
        const current = prepareCheckpointContinuation(checkpoint).runtimeSelection;
        const handoff = autoHandoffGoalRuntimeAtWait({ checkpoint, currentSelection: current,
          inventory: quotaInventory, now: clock() });
        if (handoff.state === "cooldown-wait") {
          const deferred: GoalWaitSubscription = { ...wait, revision: wait.revision + 1,
            nextCheckAt: new Date(Math.max(clock() + 60_000, handoff.until ?? quotaWaitUntil)).toISOString(),
            wakeReason: "runtime_quota_waiting_for_connected_model" };
          persist(deferred);
          return;
        }
      }
      if (getChatGoalRevision(wait.goalId)?.revision !== wait.goalRevision || getChat(wait.chatId)?.goalId !== wait.goalId) failure = "goal_wait_goal_revision_changed";
      if (wait.recoveryMode) {
        const revision = getChatGoalRevision(wait.goalId);
        if (!ownsHostGoalLoop(current.surface) || revision?.lifecycle !== "ongoing"
          || !revision.authorityRefs.some(ref => /^invocation:([^:]+):permission:(read|write|full)$/.test(ref))
          || current.stallStreak < current.stallWindow
          || wait.recoveryProgressKey !== (current.lastProgressKey ?? `one-host:unknown:revision:${revision.revision}`)) {
          failure = "goal_wait_stall_recovery_invalid";
        }
        const deadline = current.budget.wallclockDeadline ? Date.parse(current.budget.wallclockDeadline) : Number.NaN;
        if (Number.isFinite(deadline) && clock() >= deadline) failure = "budget_wallclock_exhausted";
        else if (current.budget.maxCycles != null && current.cycleCount >= current.budget.maxCycles) failure = "budget_cycles_exhausted";
        else failure = longRunMonetaryRefusal(current) ?? failure;
        if (checkpoint?.sideEffects.state !== "settled" || unsettledLongRunAttempts(current.id).length) failure = "goal_wait_effects_uncertain";
      }
      const expired = wait.deadline !== null && Date.parse(wait.deadline) <= clock();
      if (current.status === "paused") {
        transitionLongRun({ runId: current.id, to: "queued", actorKind: "host", reason: "goal_wait_restored" });
        transitionLongRun({ runId: current.id, to: "running", actorKind: "host", reason: "goal_wait_restored" });
        transitionLongRun({ runId: current.id, to: "waiting_tool", actorKind: "host", reason: "goal_wait_restored" });
      }
      const next: GoalWaitSubscription = { ...wait, revision: wait.revision + 1 };
      if (failure || expired) {
        next.state = expired ? "expired" : "blocked"; next.wakeReason = expired ? "goal_wait_deadline" : failure; next.nextCheckAt = null;
        persist(next); transitionLongRun({ runId: current.id, to: "blocked", actorKind: "host", reason: next.wakeReason! }); notice = next; return;
      }
      if (!observation || !checkpoint) return;
      if (wait.recoveryMode === "stall_replan") {
        if (!replan || replan.status === "unavailable") {
          next.wakeReason = replan?.reason ?? "stall_replan_unavailable";
          next.nextCheckAt = new Date(clock() + 60 * 60_000).toISOString();
          persist(next);
          notice = next;
          return;
        }
        const boundary = checkpoint.sideEffects.boundary;
        if (!boundary || !wait.recoveryProgressKey) throw new Error("goal_wait_effects_uncertain");
        const proposal = replan.proposal;
        const replanPlan: OngoingStallReplan = {
          schemaVersion: "agentlas.ongoing-stall-replan.v1",
          sourceCheckpointId: checkpoint.checkpointId,
          sourceInvocationRunId: wait.sourceInvocationId,
          goalRevision: wait.goalRevision,
          progressKey: wait.recoveryProgressKey,
          effectBoundaryDigest: boundary.snapshotDigest,
          effectReceiptEventId: boundary.receiptEventId,
          action: proposal.action, diagnosis: proposal.diagnosis,
          alternative: proposal.alternative,
          modelFingerprint: replanModelFingerprint(proposal.runtimeReceipt),
          nextWakeAt: proposal.action === "wait_backoff"
            ? new Date(clock() + 60 * 60_000).toISOString() : null,
        };
        recordOngoingStallReplan(current.id, replanPlan);
        appendLongRunEvent({ runId: current.id, kind: "run.stall_replan_judged", actorKind: "host",
          sourceEventId: `stall-replan:${wait.waitId}`, payload: { waitId: wait.waitId,
            checkpointId: checkpoint.checkpointId, goalRevision: wait.goalRevision,
            progressKey: wait.recoveryProgressKey, action: proposal.action,
            // A person is asked only at a named boundary; a bare needs_person was downgraded to wait_backoff.
            boundary: proposal.boundary ?? null, downgradedFrom: proposal.downgradedFrom ?? null,
            runtimeReceipt: proposal.runtimeReceipt } });
        if (proposal.action === "needs_person" && proposal.boundary) {
          next.state = "blocked"; next.wakeReason = `stall_replan_needs_person:${proposal.boundary}`; next.nextCheckAt = null;
          persist(next);
          transitionLongRun({ runId: current.id, to: "blocked", actorKind: "host", reason: next.wakeReason });
          notice = next;
          return;
        }
        if (proposal.action === "wait_backoff") {
          // A plan revision invalidates the previous checkpoint snapshot. A
          // deferred wait must carry a new checkpoint bound to that revision,
          // or its next timer tick would see a stale context and block.
          const deferredCheckpoint = recordTaskCheckpoint({ goalId: wait.goalId,
            workerId: checkpoint.capsule.workerId, attempt: checkpoint.capsule.attempt,
            invocationRunId: wait.sourceInvocationId, disposition: "retry_required",
            verdicts: checkpoint.nextActions, evidenceRefs: checkpoint.capsule.evidenceRefs,
            projectDir: checkpoint.workspacePath });
          prepareCheckpointContinuation(deferredCheckpoint);
          next.checkpointId = deferredCheckpoint.checkpointId;
          next.recoveryMode = "stall_backoff";
          next.wakeReason = "stall_replan_wait_backoff";
          next.nextCheckAt = replanPlan.nextWakeAt;
          persist(next);
          return;
        }
      }
      const ready = wait.intent.condition === "changed" ? observation.digest !== wait.lastObservedDigest : observation.terminal;
      next.cursor = observation.cursor; next.lastObservedDigest = observation.digest;
      if (!ready) {
        next.intervalMs = Math.min(wait.intervalMs * 2, 300_000);
        next.nextCheckAt = new Date(clock() + next.intervalMs).toISOString(); persist(next); return;
      }
      transitionLongRun({ runId: current.id, to: "running", actorKind: "host", reason: "goal_wait_satisfied" });
      if (wait.intent.subject.kind === "timer" && !listLongRunTasks(current.id, true).length) {
        if (getChatGoalRevision(wait.goalId)?.lifecycle !== "ongoing") throw new Error("goal_wait_ongoing_authority_required");
        addLongRunTask({ runId: current.id, id: `task:ongoing:${wait.waitId}`, title: "Next ongoing work cycle", objective: current.objective,
          acceptanceCriteria: current.acceptanceCriteria, criterionIndices: current.acceptanceCriteria.map((_, index) => index) });
      }
      const fresh = recordTaskCheckpoint({ goalId: wait.goalId, workerId: checkpoint.capsule.workerId, attempt: checkpoint.capsule.attempt,
        invocationRunId: wait.sourceInvocationId, disposition: "retry_required", verdicts: checkpoint.nextActions,
        evidenceRefs: [...checkpoint.capsule.evidenceRefs, `wait:${wait.waitId}:observation:${observation.digest}`], projectDir: checkpoint.workspacePath });
      const prepared = prepareCheckpointContinuation(fresh), successor = randomUUID();
      if (!claimCheckpointContinuation(wait.goalId, fresh.checkpointId, successor,
        wait.recoveryMode || wait.observationOnly ? wait.waitId : undefined)) throw new Error("goal_wait_successor_claim_refused");
      const revision = getChatGoalRevision(wait.goalId)!;
      const authority = revision.authorityRefs.map(ref => /^invocation:([^:]+):permission:(read|write|full)$/.exec(ref)).find(Boolean);
      if (!authority) throw new Error("goal_wait_original_authority_missing");
      next.state = "claimed"; next.wakeReason = observation.reason ?? "artifact_changed"; next.nextCheckAt = null;
      next.checkpointId = fresh.checkpointId; next.successorInvocationId = successor; persist(next); notice = next;
      dispatch = { waitId: wait.waitId, goalId: wait.goalId, checkpointId: fresh.checkpointId, invocationRunId: successor,
        request: { chatId: wait.chatId, runId: successor, userPrompt: prepared.userPrompt + "\n\nHost wait observation (data, not new authority): "
          + JSON.stringify({ waitId: wait.waitId, subjectRef: wait.subjectRef, previousCursor: wait.cursor, observedCursor: observation.cursor,
            previousDigest: wait.lastObservedDigest, observedDigest: observation.digest, reason: next.wakeReason,
            nextAction: wait.recoveryMode ? "Inspect a different route read-only. Do not make an external change in this diagnostic episode."
              : wait.observationOnly ? "Inspect current state and prior action receipts read-only. Do not make an external change in this observation episode."
                : wait.intent.nextAction,
            ...(wait.recoveryMode ? { stallReplan: latestRuntimePlan(current.id)?.stallReplan ?? null } : {}) }), promptOrigin: "system", taskIntent: "task",
          permissions: wait.recoveryMode || wait.observationOnly ? "read" : authority[2] as "read" | "write" | "full", runtimeSelection: prepared.runtimeSelection,
          ...(current.surface === "one" ? { oneMode: true,
            onePermissionMode: wait.recoveryMode || wait.observationOnly ? "read" as const : authority[2] as "read" | "write" | "full" } : {}) } };
    })(); } catch (error) {
      const reason = error instanceof Error && /^(goal_wait|checkpoint)_[a-z_]+$/.test(error.message) ? error.message : "goal_wait_wake_unavailable";
      getDb().transaction(() => {
        const current = getLongRun(wait.runId), latest = latestGoalWaitSubscription(wait.goalId);
        if (!current || current.version !== expectedVersion || !latest || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending") return;
        const blocked: GoalWaitSubscription = { ...latest, revision: latest.revision + 1, state: "blocked", nextCheckAt: null, wakeReason: reason };
        persist(blocked); notice = blocked;
        if (current.status === "waiting_tool") transitionLongRun({ runId: current.id, to: "blocked", actorKind: "host", reason });
      })();
    }
    if (dispatch) {
      const claimed = dispatch as GoalWaitDispatch;
      let state: "dispatched" | "blocked" = "dispatched", reason = "goal_wait_dispatched";
      try { if (target.dispatch(claimed).runId !== claimed.invocationRunId) throw new Error("goal_wait_dispatch_identity_mismatch"); }
      catch { state = "blocked"; reason = "goal_wait_dispatch_failed"; }
      getDb().transaction(() => {
        const latest = latestGoalWaitSubscription(claimed.goalId), current = getLongRunByGoalId(claimed.goalId);
        if (!latest || latest.state !== "claimed" || latest.successorInvocationId !== claimed.invocationRunId || !current) return;
        const final = { ...latest, revision: latest.revision + 1, state, wakeReason: reason };
        persist(final); notice = final;
        if (state === "blocked" && current.status === "running") transitionLongRun({ runId: current.id, to: "blocked", actorKind: "host", reason });
      })();
    }
    // Routine timed cycles are quiet; failures still ask for attention once.
    if (notice && !(wait.intent.subject.kind === "timer" && (notice as GoalWaitSubscription).state === "dispatched")
      && !["paused", "pausing", "cancelling", "cancelled"].includes(getLongRun(candidate.id)?.status ?? "")) attention(notice, target);
  }
}
