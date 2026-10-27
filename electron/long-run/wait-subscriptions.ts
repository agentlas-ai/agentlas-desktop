import { prepareGoalObligationContinuation, abandonGoalObligationContinuation } from "./goal-obligation-context";
import { appendGoalWaitObservation, createGoalWaitObservationData, goalWaitSubjectRef as identity } from "./goal-wait-observation";
import { pollCanonicalGoalWaits, reconcileCanonicalGoalWaits } from "./canonical-owner-waits";
import { normalizeGoalWaitTimer } from "./normalize-timer";
import { claimWaitContinuation, dispatchWaitClaim, reconcileWaitClaim, waitObservationReady, nextWaitObservationAt } from "./wait-engine";
import { desktopStoreTransaction } from "../store/change-bus";
import { episodeWaitFenceReason, recordEpisodeWaitTransition, drainGoalEpisodeNotices } from "./episode-disposition";
import { ownsHostGoalLoop } from "./host-goal-surface";
import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { getDb } from "../store/db";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getAgentSurface } from "../store/agent-surfaces";
import { getChatGoalRevision } from "../store/chat-goals";
import { addLongRunTask, appendLongRunEvent, getLongRun, getLongRunByGoalId, getLongRunGoalRevisionBinding, listLongRunTasks, transitionLongRun, nextBlockedGoalRetrySlot, pendingBlockedGoalRetry, scheduleBlockedGoalRetry, longRunOwnerHold, liveLongRunAttemptCount, goalOwnerAnswerHold } from "../store/long-runs";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { assertDesktopLongRunAdmissionOpen, desktopAppInstanceId } from "./app-runtime-coordinator";
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
import { connectedModelTimeoutMs } from "../system-agents/judgment";
import type { OngoingStallReplan } from "../../shared/runtime-plan";
import { parseGoalWaitIntent, type GoalWaitIntent } from "./wait-emitter";
import { timerWaitAuthority } from "./goal-deadline";
import { decideGoalWake, recordGoalWake } from "./wake-arbiter";
import { getAutomation } from "../store/automations";
import { getInvocationRunReceipt } from "../store/run-events";
import type { LongRunRecord } from "../store/long-runs";

/** Keep the actual producing turn's permission; old Goal metadata is a fallback, never a new approval gate. */
export function goalWaitContinuationPermission(chatId: string, invocationRunId: string,
  revision: { authorityRefs: readonly string[] } | null | undefined): "read" | "write" | "full" | undefined {
  try {
    const source = getInvocationRunReceipt(invocationRunId);
    if (source?.chatId === chatId && ["read", "write", "full"].includes(source.executionPermission ?? "")) {
      return source.executionPermission;
    }
  } catch { /* Retain the saved grant when an older receipt cannot be read. */ }
  const grant = revision?.authorityRefs.map(ref => /^invocation:([^:]+):permission:(read|write|full)$/.exec(ref)).find(Boolean);
  return grant?.[2] as "read" | "write" | "full" | undefined;
}

/** Historical checkpoints and budgets are observations, not an automatic wait veto. */
export function recordGoalWaitDiagnostics(wait: { waitId: string }, current: LongRunRecord,
  checkpoint: Pick<LongRunTaskCheckpoint, "sideEffects"> | null | undefined, now: number): void {
  try {
    const reasons: string[] = [];
    if (checkpoint?.sideEffects.state !== "settled") reasons.push("prior_effects_unsettled");
    const deadline = current.budget.wallclockDeadline ? Date.parse(current.budget.wallclockDeadline) : Number.NaN;
    if (Number.isFinite(deadline) && now >= deadline) reasons.push("past_wallclock_budget");
    if (current.budget.maxCycles != null && current.cycleCount >= current.budget.maxCycles) reasons.push("past_cycle_budget");
    const monetary = longRunMonetaryRefusal(current);
    if (monetary) reasons.push(monetary);
    if (reasons.length) appendLongRunEvent({ runId: current.id, kind: "run.wait_prior_metadata", actorKind: "host",
      payload: { waitId: wait.waitId, reasons } });
  } catch { /* Diagnostic failure never suspends an existing request. */ }
}

export interface GoalWaitSubscription {
  episodeCaptureId?: string; episodeRequestId?: string;
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
  /** Persisted before dispatch; no TTL may transfer an uncertain claim. */
  dispatchOwner?: GoalWaitHostOwner;
  dispatchRunOwnerEpoch?: string | null;
}
export interface GoalWaitHostOwner { kind: "desktop" | "daemon"; epoch: string }
export interface GoalWaitObservation { digest: string; cursor: string | null; terminal: boolean; reason: string | null;
  /** A monitor's latest output, bounded, handed to the woken turn so it does not re-measure. */
  summary?: string }
export interface GoalWaitDispatch { waitId: string; goalId: string; checkpointId: string; invocationRunId: string; request: McpInvocationRequest }
export interface GoalWaitAttention { waitId: string; goalId: string; chatId: string; reason: string; state: GoalWaitSubscription["state"]; executionAvailability: "app-running" }
export interface GoalWaitHost {
  /** Omitted only by the existing GUI host. Explicit hosts must own the exact run epoch. */
  owner?: GoalWaitHostOwner;
  dispatch(input: GoalWaitDispatch): { runId: string };
  isChatBusy(chatId: string): boolean;
  notify?(input: GoalWaitAttention): void;
}
let host: GoalWaitHost | null = null;
function pollOwner(target: GoalWaitHost | null): GoalWaitHostOwner | null {
  const owner = target?.owner === undefined ? { kind: "desktop", epoch: desktopAppInstanceId() } : target.owner;
  return owner && (owner.kind === "desktop" || owner.kind === "daemon")
    && typeof owner.epoch === "string" && owner.epoch.length > 0 && owner.epoch.length <= 128
    && owner.epoch.trim() === owner.epoch && !/[\u0000-\u001f]/.test(owner.epoch)
    ? Object.freeze({ kind: owner.kind, epoch: owner.epoch }) : null;
}
function ownsWaitRun(run: ReturnType<typeof getLongRun>, owner: GoalWaitHostOwner, exactEpoch: boolean): boolean {
  return Boolean(run && run.executionLocation === "desktop-local" && run.surface !== "science"
    && run.hostOwnerKind === owner.kind && (!exactEpoch || run.appInstanceId === owner.epoch));
}
function claimOwnedBy(wait: GoalWaitSubscription, owner: GoalWaitHostOwner): boolean {
  return wait.dispatchOwner?.kind === owner.kind && wait.dispatchOwner.epoch === owner.epoch;
}
const replanInFlight = new Map<string, AbortController>();
export function interruptGoalWaitReplans(): void {
  for (const controller of replanInFlight.values()) controller.abort(new Error("app_shutdown"));
}
export function goalWaitReplansSettled(): boolean { return replanInFlight.size === 0; }
/** Main installs its single invocation dispatcher after startup bindings are ready. */
export function setGoalWaitHost(value: GoalWaitHost | null): void { host = value; }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function latestGoalWaitSubscription(goalId: string): GoalWaitSubscription | null {
  const run = getLongRunByGoalId(goalId);
  if (!run || run.surface === "science") return null;
  const row = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id=? AND kind='run.wait_subscription' ORDER BY seq DESC LIMIT 1")
    .get(run.id) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.payload_json)?.subscription as GoalWaitSubscription | undefined;
    if (!value || value.schemaVersion !== "agentlas.goal-wait-subscription.v1"
      || value.runId !== run.id || value.goalId !== goalId || value.chatId !== run.rootChatId
      || typeof value.waitId !== "string" || !value.waitId || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Number.isSafeInteger(value.goalRevision) || value.goalRevision < 1
      || !["pending", "claimed", "dispatched", "blocked", "expired", "cancelled"].includes(value.state)
      || (value.nextCheckAt !== null && !Number.isFinite(Date.parse(value.nextCheckAt)))
      || (value.deadline !== null && !Number.isFinite(Date.parse(value.deadline)))
      || parseGoalWaitIntent("```agentlas-goal-wait\n" + JSON.stringify(value.intent) + "\n```").request?.status !== "requested") return null;
    return value;
  } catch { return null; } // Keep malformed bytes intact; never revive an older producer's wait.

}
/** An admitted new invocation supersedes the old wait. Delayed observers must
 * see this durable cancellation instead of dispatching a competing successor. */
export interface SupersededGoalWait { previous: GoalWaitSubscription; cancelled: GoalWaitSubscription; runWasWaiting: boolean }

export function supersedeGoalWaitForInvocation(goalId: string, invocationRunId: string): SupersededGoalWait | null {
  return getDb().transaction(() => {
    const wait = latestGoalWaitSubscription(goalId), run = getLongRunByGoalId(goalId);
    if (!wait || wait.state !== "pending" || wait.sourceInvocationId === invocationRunId || !run || run.surface === "science") return null;
    const cancelled: GoalWaitSubscription = { ...wait, revision: wait.revision + 1, state: "cancelled", nextCheckAt: null, wakeReason: "new_invocation" };
    persist(cancelled);
    const runWasWaiting = run.status === "waiting_tool";
    if (runWasWaiting) transitionLongRun({ runId: run.id, to: "running", actorKind: "host", reason: "goal_wait_superseded" });
    return { previous: wait, cancelled, runWasWaiting };
  })();
}

/**
 * The invocation that superseded a wait failed before any provider ran (InvocationService.releaseUndispatchedStart),
 * so the wait it cancelled is still this Goal's next step. Without this the Goal sat "running" with no attempt and no
 * wait until a restart (be78c2a0, "Not covered"). Restores it only when nothing moved since: the cancellation is still
 * the latest record, and no worker attempt is live.
 */
export function restoreGoalWaitAfterUndispatchedStart(superseded: SupersededGoalWait): boolean {
  return getDb().transaction(() => {
    const latest = latestGoalWaitSubscription(superseded.previous.goalId);
    if (!latest || latest.waitId !== superseded.cancelled.waitId || latest.revision !== superseded.cancelled.revision || latest.state !== "cancelled") return false;
    const run = getLongRun(superseded.previous.runId);
    if (!run || liveLongRunAttemptCount(run.id) > 0) return false;
    persist({ ...superseded.previous, revision: latest.revision + 1 });
    // The restored wait owns the next step again, so the Goal rests on it whatever state the failed start found: an owner Resume
    // (or a pause lifted) had already moved it to running before this start, runWasWaiting is false, and a running Goal is never
    // polled for its wait - pending wait, no attempt, nobody to wake it until a restart. queued has no edge to waiting_tool.
    if (run.status === "running" || run.status === "queued") {
      if (run.status === "queued") transitionLongRun({ runId: run.id, to: "running", actorKind: "host", reason: "goal_wait_restored_after_failed_start" });
      transitionLongRun({ runId: run.id, to: "waiting_tool", actorKind: "host", reason: "goal_wait_restored_after_failed_start" });
    }
    return true;
  })();
}
/** Retire only this wait/checkpoint. The next invocation uses current context
 * instead of replaying the old successor. */
function scheduleFreshGoalWaitContinuation(wait: Pick<GoalWaitSubscription, "runId">, reason: string, now = Date.now()): void {
  const run = getLongRun(wait.runId);
  if (!run || longRunOwnerHold(run.id) || goalOwnerAnswerHold(run.id) || ["pausing", "cancelling", "cancelled", "completed"].includes(run.status)
    || (run.status === "paused" && !["app_closed", "crash_recovery", "runtime_unavailable"].includes(run.pauseReason ?? ""))) return;
  if (liveLongRunAttemptCount(run.id) > 0) return;
  // The blocked-goal sweep owns an existing retry, including one already due.
  // Replacing it on each wait poll would move its deadline forward forever.
  if (pendingBlockedGoalRetry(run.id)) return;
  const slot = nextBlockedGoalRetrySlot(run.id, now);
  scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: "resume",
    fromReason: reason, retryIndex: slot.retryIndex, nextAt: slot.nextAt,
    detail: "wait_advisory_fresh_context", trigger: "wait-advisory",
    appInstanceId: desktopAppInstanceId() });
}

async function boundedWaitCheck<T>(operation: () => T | Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("goal_wait_check_timeout")), timeoutMs);
      timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function persist(value: GoalWaitSubscription): void {
  appendLongRunEvent({ runId: value.runId, kind: "run.wait_subscription", actorKind: "host",
    sourceEventId: `wait:${value.waitId}:${value.revision}`, payload: { subscription: value } });
  recordEpisodeWaitTransition(value);
}
export function observeGoalWaitSubject(wait: Pick<GoalWaitSubscription, "chatId" | "sourceInvocationId" | "intent">, now = Date.now(), options: { authorizeInvocation?(subject: {chatId:string;invocationRunId:string}):boolean } = {}): GoalWaitObservation {
  const chat = getChat(wait.chatId);
  if (!chat) throw new Error("goal_wait_chat_missing");
  const subject = wait.intent.subject;
  if (subject.kind === "timer") {
    const due = now >= Date.parse(subject.notBefore);
    return { digest: hash({ notBefore: subject.notBefore, due }), cursor: subject.notBefore, terminal: due, reason: due ? "ongoing_cycle_due" : null };
  }
  if (subject.kind === "automation") {
    // Layer rule (PLAN.md §0): a Goal watches a graph its own room made — never another room's private graph.
    const automation = getAutomation(subject.automationId);
    if (!automation || !automation.graph?.nodes.length || automation.monitor?.originChatId !== chat.id) {
      throw new Error("goal_wait_automation_binding_invalid");
    }
    const latest = getDb().prepare(`SELECT id, checkpoint_json FROM automation_runs WHERE automation_id = ? AND status = 'ok'
      AND COALESCE(dry_run, 0) = 0 ORDER BY started_at DESC LIMIT 1`).get(subject.automationId) as { id: string; checkpoint_json: string | null } | undefined;
    let outputs: unknown = null;
    try { outputs = latest?.checkpoint_json ? JSON.parse(latest.checkpoint_json)?.outputs ?? null : null; } catch { outputs = null; }
    const summary = outputs == null ? undefined : JSON.stringify(outputs).slice(0, 1_200);
    return { digest: hash({ outputs }), cursor: latest?.id ?? null, terminal: false, reason: latest ? "monitor_output_changed" : null,
      ...(summary ? { summary } : {}) };
  }
  if (subject.kind === "artifact") {
    const surface = getAgentSurface(subject.artifactId);
    if (!surface || surface.chatId !== chat.id || surface.artifactRevision == null || surface.stateRevision == null) throw new Error("goal_wait_artifact_binding_invalid");
    const cursor = `${surface.artifactRevision}:${surface.stateRevision}`;
    return { digest: hash({ cursor, sourceDigest: surface.artifactRef?.sourceDigest, dataDigest: surface.artifactRef?.dataDigest }), cursor, terminal: false, reason: null };
  }
  if (subject.invocationRunId === wait.sourceInvocationId) throw new Error("goal_wait_self_subscription");
  const otherChat = getChat(subject.chatId);
  if (!otherChat || (options.authorizeInvocation ? !options.authorizeInvocation(subject) : otherChat.projectId !== chat.projectId)) throw new Error("goal_wait_subject_owner_mismatch");
  const start = getDb().prepare("SELECT payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_started' LIMIT 1")
    .get(subject.invocationRunId, otherChat.id) as { payload_json: string } | undefined;
  if (!start || (!options.authorizeInvocation && JSON.parse(start.payload_json).invocationSource === "science")) throw new Error("goal_wait_invocation_binding_invalid");
  const event = getDb().prepare("SELECT id, seq, kind FROM run_events WHERE run_id=? AND chat_id=? AND kind IN ('invoke_completed','invoke_failed','invoke_threw','invoke_cancelled','invoke_interrupted') ORDER BY seq DESC LIMIT 1")
    .get(subject.invocationRunId, otherChat.id) as { id: string; seq: number; kind: string } | undefined;
  // invoke_completed can precede adapter drainage. Wake only after the actual
  // service settlement receipt names this exact host terminal, even on failure.
  const settled = event ? getDb().prepare("SELECT id, payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='runtime_effect_boundary' AND json_extract(payload_json,'$.terminalEventId')=? ORDER BY seq DESC LIMIT 1")
    .get(subject.invocationRunId, otherChat.id, event.id) as { id: string; payload_json: string } | undefined : undefined;
  const boundary = settled ? readInvocationEffectBoundary({ invocationRunId: subject.invocationRunId, expectedChatId: otherChat.id }) : null;
  return { digest: hash({ event: event ?? null, receipt: settled?.id ?? null, effects: boundary?.effects ?? "pending" }),
    cursor: settled && event ? `${event.id}:${settled.id}` : event ? `${event.id}:settlement-pending` : null,
    terminal: Boolean(settled), reason: settled ? event?.kind ?? null : null };
}

/** Actual service result producer. The request is accepted only after its own
 * host effect receipt is settled; waiting is never a model completion claim. */
export function registerGoalWaitSubscription(input: { goalId: string; invocationRunId: string; intent: GoalWaitIntent; hasTransientAttachments?: boolean; projectDir?: string | null; now?: number;
  recoveryMode?: GoalWaitSubscription["recoveryMode"]; recoveryProgressKey?: string;
  observationOnly?: boolean; episodeCaptureId?: string; episodeRequestId?: string }): GoalWaitSubscription {
  assertDesktopLongRunAdmissionOpen();
  const validated = parseGoalWaitIntent("```agentlas-goal-wait\n" + JSON.stringify(input.intent) + "\n```").request;
  if (validated?.status !== "requested") throw new Error("goal_wait_request_invalid");
  input = { ...input, intent: validated.intent };
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const run = getLongRunByGoalId(input.goalId), revision = getChatGoalRevision(input.goalId);
    if (!run || !revision || !run.rootChatId || run.surface === "science"
      || getChat(run.rootChatId)?.goalId !== run.goalId) throw new Error("goal_wait_goal_not_running");
    if (input.hasTransientAttachments) throw new Error("goal_wait_attachment_refresh_required");
    if (input.intent.deadline && Date.parse(input.intent.deadline) <= now) throw new Error("goal_wait_deadline_elapsed");
    if (input.intent.subject.kind === "timer") {
      // Timer registration uses the requested time, independent of old lifecycle/grant/deadline metadata.
      input = { ...input, intent: normalizeGoalWaitTimer(input.intent, timerWaitAuthority(run.goalId, now), now) };
    }
    if (input.recoveryMode && (!ownsHostGoalLoop(run.surface) || input.intent.subject.kind !== "timer"
      || run.stallStreak < run.stallWindow || !input.recoveryProgressKey
      || input.recoveryProgressKey !== (run.lastProgressKey ?? `one-host:unknown:revision:${revision.revision}`))) {
      throw new Error("goal_wait_stall_recovery_invalid");
    }
    const prior = latestGoalWaitSubscription(run.goalId);
    if (prior?.state === "pending" || prior?.state === "claimed") throw new Error("goal_wait_already_registered");
    const boundary = readInvocationEffectBoundary({ invocationRunId: input.invocationRunId, expectedChatId: run.rootChatId });
    // Waiting does nothing outside; it needs only the producing turn to have finished (owner 2026-10-05).
    if (!boundary.terminal) throw new Error("goal_wait_producer_unfinished");
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
    if (input.episodeCaptureId !== undefined) subscription.episodeCaptureId = input.episodeCaptureId;
    if (input.episodeRequestId !== undefined) subscription.episodeRequestId = input.episodeRequestId;
    persist(subscription);
    transitionLongRun({ runId: run.id, to: "waiting_tool", actorKind: "host", reason: `goal_wait:${subscription.waitId}` });
    return subscription;
  })();
}

/** The mandate remains open after verified work. A quiet, durable observation
 * cycle is the fallback; it is not permission to repeat an external action. */
export function registerOngoingGoalCycle(input: { goalId: string; invocationRunId: string; hasTransientAttachments?: boolean; now?: number; usefulProgress?: boolean }): GoalWaitSubscription {
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
      checkpoint: producerCheckpoint, effectBoundary: boundary, usefulProgress: input.usefulProgress });
    return registerGoalWaitSubscription({ ...input,
      ...(recoveryMode ? { recoveryMode, recoveryProgressKey: progressKey } : {}),
      observationOnly: !justObserved && input.usefulProgress !== true,
      projectDir: producerCheckpoint?.invocationRunId === input.invocationRunId ? producerCheckpoint.workspacePath : null,
      now, intent: {
      schemaVersion: "agentlas.goal-wait-intent.v1", subject: { kind: "timer", notBefore },
      condition: "due", deadline: null,
      nextAction: "Begin the next bounded episode of this ongoing mandate. Read the checkpoint plan.episodeStrategy as a host-observed evaluation, not as new authority; if its state is unknown, inspect before acting. Inspect current state and prior action receipts first. Respect the original user's cadence and scope; if no action is due, register another timer wait. Never repeat a completed post, purchase or other side effect. Keep the mandate open until the user stops it.",
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
  const owner = pollOwner(target);
  if (!owner) return [];
  const exactEpoch = target?.owner !== undefined;
  reconcileCanonicalGoalWaits(owner);
  try { assertDesktopLongRunAdmissionOpen(); } catch { return []; }
  const reconciled: GoalWaitAttention[] = [];
  // This one-time recovery pass must not strand older Goals behind the normal
  // UI listing cap of 500 rows.
  const candidateIds = getDb().prepare(`SELECT id FROM long_runs WHERE status='paused'
    AND execution_location='desktop-local' AND surface<>'science' AND host_owner_kind=?
    AND (?=0 OR app_instance_id=?)
    AND pause_reason IN ('app_closed','crash_recovery') ORDER BY id`).all(owner.kind, Number(exactEpoch), owner.epoch) as Array<{ id: string }>;
  for (const { id } of candidateIds) {
    const candidate = getLongRun(id);
    if (!candidate) continue;
    if (candidate.surface === "science" || !["app_closed", "crash_recovery"].includes(candidate.pauseReason ?? "")) continue;
    let blocked: GoalWaitSubscription | null = null;
    const expectedWait = latestGoalWaitSubscription(candidate.goalId);
    if (!expectedWait) continue;
    reconcileWaitClaim<GoalWaitSubscription>({
      storage: {
        transaction: body => desktopStoreTransaction(getDb(), body)(),
        read: () => latestGoalWaitSubscription(candidate.goalId), persist,
        current: wait => {
          const current = getLongRun(candidate.id);
          return Boolean(current && ownsWaitRun(current, owner, exactEpoch) && current.appInstanceId === candidate.appInstanceId
            && current.version === candidate.version && current.status === "paused"
            && ["app_closed", "crash_recovery"].includes(current.pauseReason ?? "")
            && wait.runId === current.id && wait.goalId === current.goalId);
        },
      }, expected: expectedWait,
      resolve: wait => {
      const current = getLongRun(candidate.id)!;
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
        "SELECT id, state FROM long_run_worker_attempts WHERE run_id=? AND invocation_run_id=? LIMIT 1",
      ).get(current.id, wait.successorInvocationId) as { id: string; state: string } | undefined : undefined;
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
            AND a.state='completed' LIMIT 1`)
          .get(current.id, wait.successorInvocationId) as { id: string } | undefined;
        const verifier = getDb().prepare(`SELECT a.id FROM long_run_worker_attempts a
          JOIN long_run_workers w ON w.id=a.worker_id AND w.run_id=a.run_id
          WHERE a.run_id=? AND a.worker_id=? AND a.attempt=? AND w.role='verifier'
            AND a.state='completed' LIMIT 1`)
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
        return { next: retired, afterPersist: () => {
        appendLongRunEvent({ runId: current.id, kind: "run.wait_claim_reconciled", actorKind: "host",
          payload: { waitId: wait.waitId, successorInvocationId: wait.successorInvocationId,
            checkpointId: checkpoint!.checkpointId, terminalEventId: terminal?.id ?? null,
            effectBoundaryReceiptId: settledRetryReceiptId, outcome: "verified_retry_checkpoint_no_replay" } });
        } };
      }
      const successorOwner = wait.successorInvocationId
        ? invocationRunOwners.getRunOwner(wait.chatId, wait.successorInvocationId) : null;
      const successorExecutionClosed = bindingExact && successorOwner?.state === "released"
        && liveLongRunAttemptCount(current.id) === 0 && !invocationRunOwners.getActiveOwner(wait.chatId)
        && target?.isChatBusy(wait.chatId) !== true;
      if (wait.episodeRequestId && !successorExecutionClosed) {
        // No receipt of a successor is not proof of non-dispatch. Preserve the
        // exact claim across restart; reconciliation never creates a replacement.
        return wait.wakeReason !== "goal_episode_dispatch_unknown" ? { next: { ...wait, revision: wait.revision + 1,
          wakeReason: "goal_episode_dispatch_unknown", nextCheckAt: null } } : null;
      }
      // An exact released successor can leave its result unknown, but cannot
      // own the Goal's next step forever. Retire this claim without changing
      // its successor id and schedule a distinct turn with current context.
      const reason = bindingExact ? "goal_wait_claimed_dispatch_uncertain" : "goal_wait_claimed_binding_changed";
      const next: GoalWaitSubscription = { ...wait, revision: wait.revision + 1, state: "cancelled", nextCheckAt: null, wakeReason: reason };
      return { next, afterPersist: () => {
      appendLongRunEvent({ runId: current.id, kind: "run.wait_claim_reconciled", actorKind: "host",
        payload: { waitId: wait.waitId, goalId: wait.goalId, goalRevision: wait.goalRevision,
          checkpointId: wait.checkpointId, successorInvocationId: wait.successorInvocationId,
          checkpointClaimEventSeq: claim?.seq ?? null, invokeStartedEventId: started?.id ?? null,
          terminalEventId: terminal?.id ?? null, effectBoundaryReceiptId: effect?.id ?? null, attemptId: attempt?.id ?? null,
          attemptState: attempt?.state ?? null,
          reason, outcome: "advisory_fresh_context_no_replay" } });
      // A dedicated CAS blocks this exceptional host pause without inventing
      // queued/running states. A user Stop or pause never matches its predicate.
      scheduleFreshGoalWaitContinuation(next, reason);
      blocked = next;
      } };
      },
    });
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
const RECOVERABLE_RETIRED_WAIT_REASONS = new Set(["goal_wait_pre_dispatch_refused", "goal_wait_dispatch_failed", "goal_wait_deadline"]);
function* goalWaitPollingCandidates(owner: GoalWaitHostOwner, exactEpoch: boolean): Generator<NonNullable<ReturnType<typeof getLongRun>>> {
  let afterId = "";
  // The UI listing caps at 500. Stable ID paging ensures an older pending
  // subscription cannot remain invisible on every scheduler tick.
  while (true) {
    const rows = getDb().prepare(`SELECT id FROM long_runs WHERE id > ?
      AND (status IN ('waiting_tool','paused') OR (status='running' AND (
        ((SELECT json_extract(e.payload_json,'$.subscription.state') FROM long_run_events e
          WHERE e.run_id=long_runs.id AND e.kind='run.wait_subscription' ORDER BY e.seq DESC LIMIT 1)
          IN ('cancelled','expired') AND
        (SELECT json_extract(e.payload_json,'$.subscription.wakeReason') FROM long_run_events e
          WHERE e.run_id=long_runs.id AND e.kind='run.wait_subscription' ORDER BY e.seq DESC LIMIT 1)
          IN (?,?,?))
        -- A pending wait under a running Goal is the zombie an owner Resume with a failed start used to leave.
        OR (SELECT json_extract(e.payload_json,'$.subscription.state') FROM long_run_events e
          WHERE e.run_id=long_runs.id AND e.kind='run.wait_subscription' ORDER BY e.seq DESC LIMIT 1) = 'pending'
      ))) AND execution_location='desktop-local'
      AND surface<>'science' AND host_owner_kind=? AND (?=0 OR app_instance_id=?)
      ORDER BY id LIMIT 500`).all(afterId, ...RECOVERABLE_RETIRED_WAIT_REASONS, owner.kind, Number(exactEpoch), owner.epoch) as Array<{ id: string }>;
    if (!rows.length) return;
    for (const { id } of rows) {
      afterId = id;
      const run = getLongRun(id);
      if (run && ownsWaitRun(run, owner, exactEpoch)) yield run;
    }
  }
}

export async function pollGoalWaitSubscriptions(options: { now?: number; clock?: () => number; host?: GoalWaitHost;
  observe?: (wait: GoalWaitSubscription) => GoalWaitObservation | Promise<GoalWaitObservation>;
  /** Synthetic test seam; production always uses the pinned no-tools runner. */
  reflect?: typeof reflectOngoingStall } = {}): Promise<void> {
  drainGoalEpisodeNotices();
  const target = options.host ?? host;
  if (!target) return;
  const owner = pollOwner(target);
  if (!owner) return;
  const exactEpoch = target.owner !== undefined;
  await pollCanonicalGoalWaits({ now: options.now, clock: options.clock, owner });
  try { assertDesktopLongRunAdmissionOpen(); } catch { return; }
  const clock = options.clock ?? (() => options.now ?? Date.now());
  const now = clock();
  const pollCandidate = async (candidate: NonNullable<ReturnType<typeof getLongRun>>): Promise<void> => {
    if (candidate.surface === "science") return;
    const ownsCandidate = (run: ReturnType<typeof getLongRun>) => ownsWaitRun(run, owner, exactEpoch)
      && run?.appInstanceId === candidate.appInstanceId && !longRunOwnerHold(candidate.id);
    if (candidate.status === "running" && latestGoalWaitSubscription(candidate.goalId)?.state === "pending") {
      // A pending wait is the next step of a Goal nobody works: nothing polls a running Goal, so an owner Resume whose start failed (and
      // older releases for the same failure) left it for ever. Rest it on its wait again - never while a turn is live in the room.
      if (target.isChatBusy(candidate.rootChatId ?? "") || liveLongRunAttemptCount(candidate.id) > 0 || !ownsCandidate(getLongRun(candidate.id))) return;
      try { candidate = transitionLongRun({ runId: candidate.id, to: "waiting_tool", actorKind: "host", reason: "goal_wait_state_repaired", expectedVersion: candidate.version }); }
      catch { return; }
    }
    const wait = latestGoalWaitSubscription(candidate.goalId);
    if (!wait) {
      // A missing or unreadable registration cannot reserve the Goal forever.
      // Use only current Main authority, never fields from the damaged row.
      if (ownsCandidate(getLongRun(candidate.id)) && candidate.rootChatId
        && getChat(candidate.rootChatId)?.goalId === candidate.goalId && !target.isChatBusy(candidate.rootChatId)) {
        scheduleFreshGoalWaitContinuation({ runId: candidate.id }, "goal_wait_registration_unavailable", clock());
      }
      return;
    }
    if (["cancelled", "expired"].includes(wait.state) && RECOVERABLE_RETIRED_WAIT_REASONS.has(wait.wakeReason ?? "")) {
      // Finalization commits before follow-up scheduling. Retry a failed write
      // on the next poll, without reviving or replaying the retired successor.
      if (candidate.appInstanceId === owner.epoch && ownsCandidate(getLongRun(candidate.id))
        && getChat(wait.chatId)?.goalId === wait.goalId && !target.isChatBusy(wait.chatId)) {
        scheduleFreshGoalWaitContinuation(wait, wait.wakeReason ?? "goal_wait_retired", clock());
      }
      return;
    }
    if (wait.state === "claimed" && candidate.status === "paused" && longRunOwnerHold(candidate.id) && wait.dispatchOwner?.kind === owner.kind
      && ownsWaitRun(candidate, owner, false) && liveLongRunAttemptCount(candidate.id) === 0 && !target.isChatBusy(wait.chatId)) {
      // A claim an earlier release left behind when the owner paused while its successor was prepared (dispatchWaitClaim now retires it
      // itself). Under the owner's hold nothing can start from it; retiring it never replays the successor, and the owner's Resume
      // continues from current context instead of finding every later wait refused as already registered.
      try {
        desktopStoreTransaction(getDb(), () => {
          const latest = latestGoalWaitSubscription(wait.goalId), current = getLongRun(candidate.id);
          if (!latest || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "claimed"
            || !current || current.version !== candidate.version || !longRunOwnerHold(current.id)) return;
          persist({ ...latest, revision: latest.revision + 1, state: "cancelled", nextCheckAt: null, wakeReason: "goal_wait_pre_dispatch_refused" });
        }).immediate();
      } catch { /* the next poll retries the same retirement */ }
      return;
    }
    if (wait.state !== "pending" || target.isChatBusy(wait.chatId)) return;
    if (candidate.status === "paused" && !["app_closed", "crash_recovery"].includes(candidate.pauseReason ?? "")) return;
    const due = !wait.nextCheckAt || Date.parse(wait.nextCheckAt) <= now || (wait.deadline !== null && Date.parse(wait.deadline) <= now);
    if (!due && candidate.status !== "paused") return;
    let observation: GoalWaitObservation | null = null, failure: string | null = null;
    let storageBusy = false;
    try { if (due) observation = await boundedWaitCheck(() => options.observe ? options.observe(wait) : observeGoalWaitSubject(wait, clock())); }
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
        desktopStoreTransaction(getDb(), () => {
          const current = getLongRun(candidate.id), latest = latestGoalWaitSubscription(wait.goalId);
          if (!current || !ownsCandidate(current) || !latest || current.version !== candidate.version
            || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending"
            || !["waiting_tool", "paused"].includes(current.status)) return;
          persist({ ...latest, revision: latest.revision + 1,
            nextCheckAt: new Date(clock() + 30_000).toISOString(), wakeReason: "goal_wait_observation_retry" });
        }).immediate();
      } catch { /* The next poll may retry the still-due original wait. */ }
      return;
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
        if (!current || !ownsCandidate(current) || current.version !== candidate.version || !latest
          || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending"
          || !["waiting_tool", "paused"].includes(current.status)
          || (current.status === "paused" && !["app_closed", "crash_recovery"].includes(current.pauseReason ?? ""))
          || target.isChatBusy(wait.chatId)) {
          // Another poll or user/app transition owns this snapshot. Do not
          // turn a stale read into a blocked Goal.
          return;
        }
        const checkpoint = candidateCheckpoint(wait);
        prepareCheckpointContinuation(checkpoint);
        if (!ownsHostGoalLoop(current.surface) || !revision
          || revision.revision !== wait.goalRevision || getChat(wait.chatId)?.goalId !== wait.goalId) {
          failure = "goal_wait_goal_revision_changed";
        }
        recordGoalWaitDiagnostics(wait, current, checkpoint, clock());
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
      if (replanInFlight.has(wait.waitId)) return;
      const controller = new AbortController();
      replanInFlight.set(wait.waitId, controller);
      try {
        const checkpoint = latestTaskCheckpoint(wait.goalId);
        replan = checkpoint?.checkpointId === wait.checkpointId
          ? await boundedWaitCheck(() => withGoalWaitAccounting({ waitId: wait.waitId, goalId: wait.goalId,
            goalRevision: wait.goalRevision, checkpointId: wait.checkpointId, chatId: wait.chatId },
            () => (options.reflect ?? reflectOngoingStall)({ checkpoint,
              progressKey: wait.recoveryProgressKey ?? "", stallStreak: candidate.stallStreak,
              previousAction: checkpoint.capsule.plan?.stallReplan?.action
                ?? checkpoint.capsule.plan?.episodeStrategy?.nextAction ?? null,
              previousAlternative: checkpoint.capsule.plan?.stallReplan?.alternative ?? null,
              signal: controller.signal })), connectedModelTimeoutMs())
          : { status: "unavailable", reason: "stall_replan_checkpoint_changed" };
      } catch { controller.abort(); replan = { status: "unavailable", reason: "stall_replan_runtime_failed" }; }
      finally { replanInFlight.delete(wait.waitId); }
    }
    // Accounted inference legitimately appends Goal usage events while the
    // model is awaited. Compare against the post-call run version, then repeat
    // every authority/status/effect check under the transaction below.
    const expectedVersion = getLongRun(wait.runId)?.version ?? candidate.version;
    let dispatch: GoalWaitDispatch | null = null, notice: GoalWaitSubscription | null = null;
    try { desktopStoreTransaction(getDb(), () => {
      const current = getLongRun(wait.runId), latest = latestGoalWaitSubscription(wait.goalId);
      try { assertDesktopLongRunAdmissionOpen(); } catch { return; }
      if (!current || !ownsCandidate(current) || !latest || current.version !== expectedVersion || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending"
        || target.isChatBusy(wait.chatId) || !["waiting_tool", "paused"].includes(current.status)) return;
      if (current.status === "paused" && !["app_closed", "crash_recovery"].includes(current.pauseReason ?? "")) return;
      const episodeRefusal = episodeWaitFenceReason(latest, clock());
      if (episodeRefusal) {
        const held: GoalWaitSubscription = { ...latest, revision: latest.revision + 1, state: "cancelled", nextCheckAt: null, wakeReason: episodeRefusal };
        persist(held); notice = held; return;
      }
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
        if (!ownsHostGoalLoop(current.surface) || !revision
          || current.stallStreak < current.stallWindow
          || wait.recoveryProgressKey !== (current.lastProgressKey ?? `one-host:unknown:revision:${revision.revision}`)) {
          failure = "goal_wait_stall_recovery_invalid";
        }
        recordGoalWaitDiagnostics(wait, current, checkpoint, clock());
      }
      const expired = wait.deadline !== null && Date.parse(wait.deadline) <= clock();
      if (current.status === "paused") {
        transitionLongRun({ runId: current.id, to: "queued", actorKind: "host", reason: "goal_wait_restored" });
        transitionLongRun({ runId: current.id, to: "running", actorKind: "host", reason: "goal_wait_restored" });
        transitionLongRun({ runId: current.id, to: "waiting_tool", actorKind: "host", reason: "goal_wait_restored" });
      }
      const next: GoalWaitSubscription = { ...wait, revision: wait.revision + 1 };
      if (failure || expired) {
        next.state = expired ? "expired" : "cancelled"; next.wakeReason = expired ? "goal_wait_deadline" : failure; next.nextCheckAt = null;
        persist(next); scheduleFreshGoalWaitContinuation(next, next.wakeReason!, clock()); notice = next; return;
      }
      if (!observation || !checkpoint) return;
      if (wait.recoveryMode === "stall_replan") {
        if (!replan || replan.status === "unavailable") {
          // An unavailable adviser cannot reserve the Goal indefinitely. Retire
          // only this wait; the next episode uses current context
          // instead of replaying the old producer.
          next.state = "cancelled";
          next.wakeReason = replan?.reason ?? "stall_replan_unavailable";
          next.nextCheckAt = null;
          persist(next);
          scheduleFreshGoalWaitContinuation(next, next.wakeReason, clock());
          notice = next;
          return;
        }
        const boundary = checkpoint.sideEffects.boundary;
        if (!boundary || !wait.recoveryProgressKey) throw new Error("goal_wait_checkpoint_not_settled");
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
          next.state = "cancelled"; next.wakeReason = `stall_replan_needs_person:${proposal.boundary}`; next.nextCheckAt = null;
          persist(next);
          scheduleFreshGoalWaitContinuation(next, next.wakeReason, clock());
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
      const ready = waitObservationReady(wait, observation);
      if (ready) {
        // One wake policy (wake-arbiter): the owner first, then the daily barrier. The observed change is not
        // consumed here, so the next poll sees it again once the room is free.
        const verdict = decideGoalWake({ runId: current.id, chatId: wait.chatId, source: "wait",
          gate: { isChatBusy: (chatId) => target.isChatBusy(chatId) } });
        if (!verdict.start) {
          const later = verdict.reason === "wake_budget_reached" ? Math.max(60_000, Date.parse(verdict.retryAt) - clock()) : 60_000;
          next.nextCheckAt = new Date(clock() + later).toISOString(); persist(next); return;
        }
      }
      next.cursor = observation.cursor; next.lastObservedDigest = observation.digest;
      if (!ready) {
        Object.assign(next, nextWaitObservationAt(wait.intervalMs, clock())); persist(next); return;
      }
      dispatch = claimWaitContinuation<GoalWaitSubscription, GoalWaitDispatch>({
        transaction: body => body(), read: () => latestGoalWaitSubscription(wait.goalId), persist,
        current: () => {
          const live = getLongRun(wait.runId);
          return Boolean(live && ownsCandidate(live)
            && !target.isChatBusy(wait.chatId));
        },
      }, wait, () => {
      transitionLongRun({ runId: current.id, to: "running", actorKind: "host", reason: "goal_wait_satisfied" });
      if (wait.intent.subject.kind === "timer" && !listLongRunTasks(current.id, true).length) {
        // The requested timer opens the next work cycle without reinterpreting a prior plan cutoff.
        const authority = timerWaitAuthority(wait.goalId, Date.parse(wait.intent.subject.notBefore) - 1);
        if (!authority.ok) throw new Error(authority.reason);
        addLongRunTask({ runId: current.id, id: `task:ongoing:${wait.waitId}`, title: authority.lifecycle === "ongoing"
          ? "Next ongoing work cycle" : "Next scheduled work cycle", objective: current.objective,
          acceptanceCriteria: current.acceptanceCriteria, criterionIndices: current.acceptanceCriteria.map((_, index) => index) });
      }
      const fresh = recordTaskCheckpoint({ goalId: wait.goalId, workerId: checkpoint.capsule.workerId, attempt: checkpoint.capsule.attempt,
        invocationRunId: wait.sourceInvocationId, disposition: "retry_required", verdicts: checkpoint.nextActions,
        evidenceRefs: [...checkpoint.capsule.evidenceRefs, `wait:${wait.waitId}:observation:${observation.digest}`], projectDir: checkpoint.workspacePath });
      const prepared = prepareCheckpointContinuation(fresh), successor = randomUUID();
      if (!claimCheckpointContinuation(wait.goalId, fresh.checkpointId, successor,
        wait.recoveryMode || wait.observationOnly ? wait.waitId : undefined)) throw new Error("goal_wait_successor_claim_refused");
      const revision = getChatGoalRevision(wait.goalId)!;
      const permission = goalWaitContinuationPermission(wait.chatId, wait.sourceInvocationId, revision);
      next.state = "claimed"; next.wakeReason = observation.reason ?? "artifact_changed"; next.nextCheckAt = null;
      next.checkpointId = fresh.checkpointId; next.successorInvocationId = successor;
      next.dispatchOwner = owner; next.dispatchRunOwnerEpoch = current.appInstanceId;
      notice = next;
      return { next, dispatch: { waitId: wait.waitId, goalId: wait.goalId, checkpointId: fresh.checkpointId, invocationRunId: successor,
        request: { chatId: wait.chatId, runId: successor, userPrompt: appendGoalWaitObservation(prepared.userPrompt, createGoalWaitObservationData({
          waitId:wait.waitId,subjectRef:wait.subjectRef,cursor:wait.cursor,lastObservedDigest:wait.lastObservedDigest,
          observation,reason:next.wakeReason,
          nextAction: wait.intent.nextAction,
          ...(wait.recoveryMode ? {stallReplan:latestRuntimePlan(current.id)?.stallReplan??null}:{}),
        })), promptOrigin: "system", taskIntent: "task",
          permissions: permission, runtimeSelection: prepared.runtimeSelection,
          ...(current.surface === "one" ? { oneMode: true,
            onePermissionMode: permission } : {}) } } };
      });
    }).immediate(); } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      // A competing writer has not refused the Goal or its owner. Leave its
      // pending revision intact for a later observation instead of blocking it.
      if (typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(code)) return;
      const reason = error instanceof Error && /^(goal_wait|checkpoint)_[a-z_]+$/.test(error.message) ? error.message : "goal_wait_wake_unavailable";
      desktopStoreTransaction(getDb(), () => {
        const current = getLongRun(wait.runId), latest = latestGoalWaitSubscription(wait.goalId);
        if (!current || !ownsCandidate(current) || current.version !== expectedVersion || !latest || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending") return;
        const blocked: GoalWaitSubscription = { ...latest, revision: latest.revision + 1, state: "cancelled", nextCheckAt: null, wakeReason: reason };
        persist(blocked); notice = blocked;
        scheduleFreshGoalWaitContinuation(blocked, reason, clock());
      }).immediate();
    }
    if (dispatch) {
      const claimed = dispatch as GoalWaitDispatch;
      let obligationPreparationFailed = false, obligationPreparationError: unknown;
      try { claimed.request = await prepareGoalObligationContinuation(claimed.request, { goalId: wait.goalId, goalRevision: wait.goalRevision }); }
      catch (error) { obligationPreparationFailed = true; obligationPreparationError = error; }
      const expected = latestGoalWaitSubscription(claimed.goalId);
      if (!expected) { abandonGoalObligationContinuation(claimed.request); return; }
      notice = dispatchWaitClaim<GoalWaitSubscription>({
        storage: {
          transaction: body => desktopStoreTransaction(getDb(), body).immediate(),
          read: () => latestGoalWaitSubscription(claimed.goalId), persist,
          current: latest => {
            const current = getLongRunByGoalId(claimed.goalId);
            return Boolean(current && current.status === "running" && ownsCandidate(current)
              && current.appInstanceId === latest.dispatchRunOwnerEpoch
              && latest.successorInvocationId === claimed.invocationRunId);
          },
          // The owner paused (or the room moved) while the successor was prepared: the exact claim of this host may still be
          // recorded as retired, never started, so it cannot hold the Goal's next step for ever.
          receiptCurrent: latest => {
            const live = getLongRunByGoalId(claimed.goalId);
            return Boolean(live && live.id === latest.runId && ownsWaitRun(live, owner, exactEpoch)
              && claimOwnedBy(latest, owner) && latest.successorInvocationId === claimed.invocationRunId);
          },
        }, expected, owner,
        assertStart: latest => {
          // Preparation never dispatched this successor. Retire its claim on
          // refusal; only a failure after target.dispatch may be uncertain.
          if (obligationPreparationFailed) throw obligationPreparationError;
          if (episodeWaitFenceReason(latest, clock())) throw new Error("goal_wait_episode_fenced");
          assertDesktopLongRunAdmissionOpen();
        },
        start: () => ({ start: true, runId: target.dispatch(claimed).runId }),
        preStartFailureReason: "goal_wait_pre_dispatch_refused",
        failureState: expected.episodeRequestId ? "claimed" : "cancelled",
        failureReason: expected.episodeRequestId ? "goal_episode_dispatch_unknown" : "goal_wait_dispatch_failed",
        onStarted: () => recordGoalWake({ runId: expected.runId, chatId: claimed.request.chatId ?? "", source: "wait",
          invocationRunId: claimed.invocationRunId, cause: expected.wakeReason ?? "goal_wait" }),
        onFinal: latest => { if (latest.state === "cancelled") scheduleFreshGoalWaitContinuation(latest, latest.wakeReason!, clock()); },
      });
      if (!notice || (notice as GoalWaitSubscription).state !== "dispatched") abandonGoalObligationContinuation(claimed.request);
    }
    // Routine timed cycles are quiet; failures still ask for attention once.
    if (notice && ownsCandidate(getLongRun(candidate.id))
      && !(wait.intent.subject.kind === "timer" && (notice as GoalWaitSubscription).state === "dispatched")
      && !["paused", "pausing", "cancelling", "cancelled"].includes(getLongRun(candidate.id)?.status ?? "")) attention(notice, target);
  };
  let batch: Promise<void>[] = [];
  for (const candidate of goalWaitPollingCandidates(owner, exactEpoch)) {
    batch.push(pollCandidate(candidate));
    if (batch.length === 4) { await Promise.allSettled(batch); batch = []; }
  }
  await Promise.allSettled(batch);
  drainGoalEpisodeNotices();
}
