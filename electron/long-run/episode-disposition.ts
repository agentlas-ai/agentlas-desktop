/** Main-owned rest receipts. Model text is intent, never custody or a wake receipt. */
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { getChat, insertHostNoticeInTransaction, emitHostNoticeCommitted } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, getLongRunAttemptGoalRevision, getLongRunGoalRevisionBinding, listLongRunTasks,
  longRunOwnerHold, appendLongRunEvent, bindLongRunWorker, startLongRunWorkerAttempt } from "../store/long-runs";
import { readGoalPlan, withCurrentGoalPlan, goalPlanInvocationReceipts, goalPlanOwnerControlEpoch, recordGoalPlanDecision } from "../store/goal-plans";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { currentUiLocale } from "../ui-locale";
import { parseGoalWaitIntent, type GoalWaitIntent } from "./wait-emitter";
import { desktopStoreTransaction } from "../store/change-bus";
import { captureEpisodeQuietBaseline, type AgiGoalFactsDeps } from "../agi/goal-facts";
import { latestGoalWaitSubscription } from "./wait-subscriptions";
import type { GoalWaitSubscription } from "./wait-subscriptions";
import { assertDesktopLongRunAdmissionOpen, desktopAppInstanceId } from "./app-runtime-coordinator";
import { captureGoalExecutionControlGeneration, assertGoalExecutionControlGeneration, isGoalDispatchRefusal } from "../automation-execution-control";

/** Process-local Main custody, captured at root runtime selection and never reconstructed at finish. */
export interface GoalProducerAdmission { readonly invocationId: string }
interface ProducerAdmissionSource {
  invocationId: string; chatId: string; startId: string; appInstanceId: string;
  goalId: string | null; runId: string | null; runVersion: number | null;
  runEventSeq: number | null;
  goalRevision: number | null; revisionDigest: string | null; taskId: string | null; ownerControlEpoch: string;
  promptMessageId: string | null; taskDigest: string | null; invocationAdmissionDigest: string | null;
}
const producerAdmissions = new WeakMap<GoalProducerAdmission, ProducerAdmissionSource>();
interface AdmittedProducer {
  goalId: string; runId: string; attemptId: string; workerId: string; taskId: string;
  taskDigest: string; revisionDigest: string; nativeControlGeneration: number;
}
const admittedProducers = new WeakMap<GoalProducerAdmission, AdmittedProducer>();
function assertProducerLifetime(assertLive: () => void): void {
  if (assertLive.constructor.name === "AsyncFunction") throw new Error("goal_episode_admission_async");
  const result: unknown = assertLive();
  if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("goal_episode_admission_async");
  assertDesktopLongRunAdmissionOpen();
}
function producerSource(invocationId: string, chatId: string): {
  startId: string; promptMessageId: string | null; invocationAdmissionDigest: string | null;
} {
  const db = getDb();
  const starts = db.prepare("SELECT id,chat_id FROM run_events WHERE run_id=? AND kind='invoke_started'")
    .all(invocationId) as Array<{ id: string; chat_id: string }>;
  if (starts.length !== 1 || starts[0].chat_id !== chatId
    || db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind IN ('invoke_completed','invoke_threw','invoke_cancelled','invoke_cancel_requested') LIMIT 1").get(invocationId)) {
    throw new Error("goal_episode_admission_source_invalid");
  }
  const prompt = db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='invoke_prompt_bound' ORDER BY rowid DESC LIMIT 1")
    .get(invocationId, chatId) as { payload_json: string } | undefined;
  const promptMessageId: unknown = prompt ? JSON.parse(prompt.payload_json).promptMessageId : null;
  if (promptMessageId !== null && (typeof promptMessageId !== "string"
    || !db.prepare("SELECT 1 FROM chat_messages WHERE id=? AND chat_id=? AND role='user'").get(promptMessageId, chatId))) {
    throw new Error("goal_episode_admission_source_invalid");
  }
  const admission = db.prepare("SELECT chat_id,input_digest,digest_version,owner_process_epoch,status FROM invocation_admissions WHERE run_id=?")
    .get(invocationId) as { chat_id: string; status: string } | undefined;
  if (admission && (admission.chat_id !== chatId || admission.status !== "admitted")) throw new Error("goal_episode_admission_source_invalid");
  return { startId: starts[0].id, promptMessageId: promptMessageId as string | null,
    invocationAdmissionDigest: admission ? digest(admission) : null };
}

export function captureGoalProducerAdmission(input: { invocationId: string; chatId: string; goalId: string | null },
  assertLive: () => void): GoalProducerAdmission {
  assertProducerLifetime(assertLive);
  const source = producerSource(input.invocationId, input.chatId);
  const chat = getChat(input.chatId);
  if (!chat || (chat.originSurface !== "one" && chat.originSurface !== "work")
    || (input.goalId && chat.goalId !== input.goalId)) throw new Error("goal_episode_admission_source_invalid");
  const run = input.goalId ? getLongRunByGoalId(input.goalId) : null;
  const revision = input.goalId ? getChatGoalRevision(input.goalId) : null;
  const task = run ? listLongRunTasks(run.id, true)[0] ?? null : null;
  const token = Object.freeze({ invocationId: input.invocationId });
  producerAdmissions.set(token, { ...input, ...source, appInstanceId: desktopAppInstanceId(),
    runId: run?.id ?? null, runVersion: run?.version ?? null, goalRevision: revision?.revision ?? null,
    revisionDigest: revision ? digest(revision) : null,
    runEventSeq: run?.lastEventSeq ?? null,
    taskId: task?.id ?? null, taskDigest: task ? digest(task) : null,
    ownerControlEpoch: input.goalId ? goalPlanOwnerControlEpoch(input.goalId) : "[]" });
  return token;
}

/** Own the NULL-owner claim and genuine controller start together. Never adopt historical worker custody. */
export function admitGoalProducer(input: { admission: GoalProducerAdmission; goalId: string;
  worker: Parameters<typeof bindLongRunWorker>[0] }, assertLive: () => void): ReturnType<typeof startLongRunWorkerAttempt> {
  const custody = producerAdmissions.get(input.admission);
  if (!custody) throw new Error("goal_episode_admission_missing");
  return desktopStoreTransaction(getDb(), () => {
    assertProducerLifetime(assertLive);
    if (desktopAppInstanceId() !== custody.appInstanceId) throw new Error("goal_episode_admission_owner_changed");
    const db = getDb(), source = producerSource(custody.invocationId, custody.chatId);
    const run = getLongRunByGoalId(input.goalId), revision = getChatGoalRevision(input.goalId);
    const task = run ? listLongRunTasks(run.id, true).find(row => row.id === input.worker.taskId) : null;
    if (source.startId !== custody.startId || source.invocationAdmissionDigest !== custody.invocationAdmissionDigest
      || (custody.promptMessageId && source.promptMessageId !== custody.promptMessageId)
      || !run || !revision || revision.chatId !== custody.chatId || run.rootChatId !== custody.chatId
      || getChat(custody.chatId)?.goalId !== input.goalId || (custody.goalId && custody.goalId !== input.goalId)
      || run.executionLocation !== "desktop-local" || run.hostOwnerKind !== "desktop" || !["one", "work"].includes(run.surface)
      || run.status !== "running" || longRunOwnerHold(run.id)
      || input.worker.runId !== run.id || input.worker.role !== "controller" || input.worker.parentWorkerId !== null
      || !input.worker.taskId || !task
      || getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision) throw new Error("goal_episode_admission_stale");
    // The existing binder may adopt this very turn's explicit grant after selection, before worker start.
    // Permit only that exact single host event; unrelated version/control/task changes remain stale.
    const ownAdoption = custody.goalRevision === null && revision.revision === 1 && custody.runVersion !== null
      && run.version === custody.runVersion + 1 && run.lastEventSeq === (custody.runEventSeq ?? -1) + 1
      && Boolean(db.prepare("SELECT 1 FROM long_run_events WHERE run_id=? AND seq=? AND kind='run.goal_revision_bound' AND actor_kind='host' AND json_extract(payload_json,'$.adoptedFrom')='explicit_goal_turn' AND json_extract(payload_json,'$.sourceMessageId')=?")
        .get(run.id, run.lastEventSeq, source.promptMessageId));
    if (goalPlanOwnerControlEpoch(input.goalId) !== custody.ownerControlEpoch
      || (custody.runId && (run.id !== custody.runId || (run.version !== custody.runVersion && !ownAdoption)
        || input.worker.taskId !== custody.taskId || digest(task) !== custody.taskDigest))
      || (custody.goalRevision !== null && (revision.revision !== custody.goalRevision || digest(revision) !== custody.revisionDigest))) throw new Error("goal_episode_admission_stale");
    if ((run.appInstanceId === null || custody.goalRevision === null) && (!source.promptMessageId
      || revision.sourceMessage.messageId !== source.promptMessageId
      || !revision.authorityRefs.some(ref => ref === `invocation:${custody.invocationId}:permission:${input.worker.permissionProfile}`))) {
      throw new Error("goal_episode_admission_source_invalid");
    }
    if (goalPlanInvocationReceipts(input.goalId, custody.invocationId).some(row => row.kind === "marker_context")) {
      throw new Error("goal_episode_admission_dispatch_started");
    }
    if (db.prepare("SELECT 1 FROM long_run_worker_attempts WHERE invocation_run_id=? LIMIT 1").get(custody.invocationId)) {
      throw new Error("goal_episode_admission_attempt_exists");
    }
    if (db.prepare("SELECT 1 FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id=a.worker_id WHERE a.run_id=? AND w.role='controller' AND a.state='running' LIMIT 1").get(run.id)) {
      throw new Error("goal_episode_admission_attempt_exists");
    }
    if (run.appInstanceId === null) {
      if (db.prepare("SELECT 1 FROM long_run_worker_attempts WHERE run_id=? LIMIT 1").get(run.id)) throw new Error("goal_episode_admission_legacy_owner_unknown");
      const changed = db.prepare("UPDATE long_runs SET app_instance_id=?,version=version+1 WHERE id=? AND version=? AND status='running' AND app_instance_id IS NULL AND host_owner_kind='desktop' AND execution_location='desktop-local'")
        .run(custody.appInstanceId, run.id, run.version);
      if (changed.changes !== 1) throw new Error("goal_episode_admission_stale");
      appendLongRunEvent({ runId: run.id, kind: "run.producer_owner_claimed", actorKind: "host",
        payload: { invocationRunId: custody.invocationId, appInstanceId: custody.appInstanceId, goalRevision: revision.revision } });
    } else if (run.appInstanceId !== custody.appInstanceId) throw new Error("goal_episode_admission_owner_changed");
    bindLongRunWorker(input.worker);
    const started = startLongRunWorkerAttempt({ runId: run.id, workerId: input.worker.workerId, taskId: input.worker.taskId,
      invocationRunId: custody.invocationId, runtimeSelection: input.worker.runtimeSelection, appInstanceId: custody.appInstanceId });
    if (getLongRunAttemptGoalRevision(run.id, started.attemptId) !== revision.revision) throw new Error("goal_episode_admission_stale");
    const boundTask = listLongRunTasks(run.id, true).find(row => row.id === task.id)!;
    admittedProducers.set(input.admission, { goalId: input.goalId, runId: run.id,
      attemptId: started.attemptId, workerId: input.worker.workerId, taskId: task.id,
      taskDigest: digest(boundTask), revisionDigest: digest(revision),
      nativeControlGeneration: captureGoalExecutionControlGeneration({ goalId: input.goalId,
        rootChatId: custody.chatId, longRunId: run.id, expectedRevision: revision.revision }) });
    return started;
  }).immediate();
}

/** The selection token authorizes one genuine controller, not a later owner or
 * revision. Recheck immediately before work even when early binding succeeded. */
export function assertGoalProducerDispatch(input: { admission: GoalProducerAdmission; goalId: string;
  attemptId: string }, assertLive: () => void): void {
  function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
  desktopStoreTransaction(getDb(), () => {
    assertProducerLifetime(assertLive);
    const custody = producerAdmissions.get(input.admission), admitted = admittedProducers.get(input.admission);
    if (!custody || !admitted || admitted.goalId !== input.goalId || admitted.attemptId !== input.attemptId)
      refuse("goal_episode_admission_missing");
    const source = producerSource(custody.invocationId, custody.chatId);
    const run = getLongRunByGoalId(input.goalId), revision = getChatGoalRevision(input.goalId);
    const task = run ? listLongRunTasks(run.id, true).find(row => row.id === admitted.taskId) : null;
    if (!run || run.appInstanceId !== custody.appInstanceId || desktopAppInstanceId() !== custody.appInstanceId)
      refuse("goal_episode_admission_owner_changed");
    // Accounting and host bookkeeping may advance the run event cursor while
    // preparing this turn. Validate execution authority itself, not that cursor.
    if (source.startId !== custody.startId || source.invocationAdmissionDigest !== custody.invocationAdmissionDigest
      || (custody.promptMessageId && source.promptMessageId !== custody.promptMessageId)
      || run.id !== admitted.runId || run.status !== "running"
      || run.executionLocation !== "desktop-local" || run.hostOwnerKind !== "desktop" || !["one", "work"].includes(run.surface)
      || run.rootChatId !== custody.chatId || getChat(custody.chatId)?.goalId !== input.goalId
      || longRunOwnerHold(run.id) || !revision || digest(revision) !== admitted.revisionDigest
      || getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision
      || !task || digest(task) !== admitted.taskDigest
      || goalPlanOwnerControlEpoch(input.goalId) !== custody.ownerControlEpoch)
      refuse("goal_episode_admission_stale");
    assertGoalExecutionControlGeneration({ goalId: input.goalId, rootChatId: custody.chatId,
      longRunId: run.id }, admitted.nativeControlGeneration);
    const attempt = getDb().prepare(`SELECT a.id FROM long_run_worker_attempts a
      JOIN long_run_workers w ON w.id=a.worker_id AND w.run_id=a.run_id
      WHERE a.id=? AND a.run_id=? AND a.worker_id=? AND a.task_id=? AND a.invocation_run_id=?
        AND a.app_instance_id=? AND a.state='running' AND w.role='controller' AND w.parent_worker_id IS NULL
        AND w.current_attempt=a.attempt AND w.state='running'`)
      .get(input.attemptId, run.id, admitted.workerId, admitted.taskId, custody.invocationId, custody.appInstanceId);
    if (!attempt || latestGoalEpisodeProducer(run.id)?.id !== input.attemptId
      || getLongRunAttemptGoalRevision(run.id, input.attemptId) !== revision.revision)
      refuse("goal_episode_admission_stale");
  }).immediate();
}

interface EpisodeCustody {
  schemaVersion: 1; goalId: string; goalRevision: number; runId: string; runVersion: number;
  chatId: string; appInstanceId: string | null; ownerControlEpoch: string; mutationIdentity: string;
  producerInvocationId: string; workerAttemptId: string; boundaryDigest: string;
  hostOwnerKind: string; executionLocation: string; workerAppInstanceId: string; effectsSettled: boolean;
  nativeControlGeneration: number;
}
export interface GoalEpisodeCapture { captureId: string; goalId: string; custody: EpisodeCustody | null; reason: string | null }
export interface GoalEpisodeDisposition {
  requestId: string; captureId: string; goalId: string; status: "decision_recorded" | "wait_registered";
  code: string; waitId: string | null; checkpointId: string | null; requestedUntil: string | null;
  nextCheckAt: string | null; executionAvailability: "app-running" | null;
  quietBaseline?: string;
  waitState?: GoalWaitSubscription["state"]; successorInvocationId?: string | null; replayed?: boolean;
}
type RegisterWait = (input: { goalId: string; invocationRunId: string; intent: GoalWaitIntent; now: number;
  episodeCaptureId: string; episodeRequestId: string; observationOnly?: boolean; projectDir?: string | null; hasTransientAttachments?: boolean }) => GoalWaitSubscription;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);

export function ensureGoalEpisodeSchema(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS goal_episode_captures (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)));
    CREATE TABLE IF NOT EXISTS goal_episode_dispositions (
    id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, intent_digest TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK(json_valid(value_json)));
    CREATE TABLE IF NOT EXISTS goal_episode_notice_outbox (
    disposition_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS goal_episode_notice_pending ON goal_episode_notice_outbox(message_id);`);
}
function typedReason(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (/^SQLITE_(BUSY|LOCKED)/.test(code)) return "goal_episode_busy";
  const message = error instanceof Error ? error.message : "";
  if (/^(goal_episode|goal_plan|goal_revision|goal_wait|checkpoint)_[a-z_]+$/.test(message)) return message;
  return "goal_episode_apply_failed";
}
function readCapture(id: string): GoalEpisodeCapture | null {
  const row = getDb().prepare("SELECT value_json FROM goal_episode_captures WHERE id=?").get(id) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.value_json) as GoalEpisodeCapture;
    const c = value.custody;
    if (value.captureId !== id || !validId(value.goalId) || (c && (c.schemaVersion !== 1 || c.goalId !== value.goalId
      || !validId(c.runId) || !validId(c.chatId) || !validId(c.producerInvocationId) || !validId(c.workerAttemptId)
      || !Number.isSafeInteger(c.goalRevision) || !Number.isSafeInteger(c.runVersion)
      || typeof c.ownerControlEpoch !== "string" || typeof c.mutationIdentity !== "string" || !c.mutationIdentity.startsWith("sha256:")
      || typeof c.boundaryDigest !== "string"))) return null;
    return value;
  } catch { return null; }
}
/** Specialist projections may share Main's invocation, but cannot own its episode.
 * Select the newest root controller first; never search backwards for a requested old producer. */
export function latestGoalEpisodeProducer(runId: string): { id: string; invocation_run_id: string | null; app_instance_id: string | null } | undefined {
  return getDb().prepare(`SELECT a.id,a.invocation_run_id,a.app_instance_id
    FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id=a.worker_id AND w.run_id=a.run_id
    WHERE a.run_id=? AND w.role='controller' AND w.parent_worker_id IS NULL
    ORDER BY a.rowid DESC LIMIT 1`)
    .get(runId) as { id: string; invocation_run_id: string | null; app_instance_id: string | null } | undefined;
}
function boundaryDigest(invocationId: string, chatId: string): string {
  const boundary = readInvocationEffectBoundary({ invocationRunId: invocationId, expectedChatId: chatId });
  if (!boundary.terminal || !boundary.terminalEventId) throw new Error("goal_episode_producer_not_terminal");
  return digest({ terminal: boundary.terminalEventId, receipt: boundary.receiptEventId, snapshot: boundary.snapshotDigest,
    effects: boundary.effects, pending: boundary.pendingEffectRefs });
}

/** AGI calls before facts/model work. Normal output must name its genuine producer;
 * its plan/control identity comes exclusively from the pre-dispatch marker ledger. */
export function captureGoalEpisode(input: { captureId: string; goalId: string; producerInvocationId?: string }): GoalEpisodeCapture {
  if (!validId(input.captureId) || !validId(input.goalId)) throw new Error("goal_episode_capture_invalid");
  ensureGoalEpisodeSchema();
  return getDb().transaction(() => {
    const prior = readCapture(input.captureId);
    if (prior) {
      if (prior.goalId !== input.goalId || (input.producerInvocationId && prior.custody?.producerInvocationId !== input.producerInvocationId)) throw new Error("goal_episode_capture_conflict");
      return prior;
    }
    const capture: GoalEpisodeCapture = { captureId: input.captureId, goalId: input.goalId, custody: null, reason: null };
    try {
      try { assertDesktopLongRunAdmissionOpen(); } catch { throw new Error("goal_episode_admission_closed"); }
      const run = getLongRunByGoalId(input.goalId), plan = readGoalPlan(input.goalId), revision = getChatGoalRevision(input.goalId);
      if (!run || !run.rootChatId || run.surface === "science" || !plan?.mutationIdentity || !revision
        || plan.revision !== revision.revision || getChat(run.rootChatId)?.goalId !== input.goalId) throw new Error("goal_episode_custody_missing");
      const worker = latestGoalEpisodeProducer(run.id);
      if (!worker?.invocation_run_id || (input.producerInvocationId && worker.invocation_run_id !== input.producerInvocationId)) throw new Error("goal_episode_producer_missing");
      if (!worker.app_instance_id || worker.app_instance_id !== run.appInstanceId
        || run.appInstanceId !== desktopAppInstanceId() || run.hostOwnerKind !== "desktop" || run.executionLocation !== "desktop-local"
        || getLongRunAttemptGoalRevision(run.id, worker.id) !== revision.revision) throw new Error("goal_episode_producer_authority_stale");
      let nativeControlGeneration: number;
      try { nativeControlGeneration = captureGoalExecutionControlGeneration({ goalId: input.goalId, rootChatId: run.rootChatId,
        longRunId: run.id, expectedRevision: revision.revision }); }
      catch (error) { if (isGoalDispatchRefusal(error)) throw new Error("goal_episode_native_control_changed"); throw error; }
      let mutationIdentity = plan.mutationIdentity, ownerControlEpoch = goalPlanOwnerControlEpoch(input.goalId);
      if (input.producerInvocationId) {
        const receipts = goalPlanInvocationReceipts(input.goalId, input.producerInvocationId);
        const context = [...receipts].reverse().find(row => row.kind === "marker_context");
        if (!context || typeof context.payload.mutationIdentity !== "string" || typeof context.payload.ownerControlEpoch !== "string") throw new Error("goal_episode_dispatch_custody_missing");
        const rebase = [...receipts].reverse().find(row => row.kind === "marker_apply" && row.payload.contextId === context.id);
        mutationIdentity = typeof rebase?.payload.mutationIdentity === "string" ? rebase.payload.mutationIdentity : context.payload.mutationIdentity;
        ownerControlEpoch = context.payload.ownerControlEpoch;
      }
      capture.custody = { schemaVersion: 1, goalId: input.goalId, goalRevision: revision.revision, runId: run.id, runVersion: run.version,
        chatId: run.rootChatId, appInstanceId: run.appInstanceId, mutationIdentity, ownerControlEpoch,
        hostOwnerKind: run.hostOwnerKind, executionLocation: run.executionLocation, workerAppInstanceId: worker.app_instance_id,
        nativeControlGeneration,
        effectsSettled: readInvocationEffectBoundary({ invocationRunId: worker.invocation_run_id, expectedChatId: run.rootChatId }).effects === "settled",
        producerInvocationId: worker.invocation_run_id, workerAttemptId: worker.id,
        boundaryDigest: boundaryDigest(worker.invocation_run_id, run.rootChatId) };
    } catch (error) { capture.reason = typedReason(error); }
    getDb().prepare("INSERT INTO goal_episode_captures(id,goal_id,value_json) VALUES (?,?,?)")
      .run(input.captureId, input.goalId, JSON.stringify(capture));
    return capture;
  }).immediate();
}
function assertCustody(c: EpisodeCustody, applying: boolean, now: number): void {
  const run = getLongRunByGoalId(c.goalId), revision = getChatGoalRevision(c.goalId), plan = readGoalPlan(c.goalId);
  if (!run || run.id !== c.runId || run.rootChatId !== c.chatId || getChat(c.chatId)?.goalId !== c.goalId
    || revision?.revision !== c.goalRevision || run.hostOwnerKind !== c.hostOwnerKind || run.executionLocation !== c.executionLocation) throw new Error("goal_episode_custody_stale");
  const sameMain = c.appInstanceId === desktopAppInstanceId();
  if (applying) {
    try { assertDesktopLongRunAdmissionOpen(); } catch { throw new Error("goal_episode_admission_closed"); }
    if (!sameMain || c.workerAppInstanceId !== c.appInstanceId
      || c.hostOwnerKind !== "desktop" || c.executionLocation !== "desktop-local") throw new Error("goal_episode_producer_authority_stale");
  }
  if ((applying || sameMain) && (!Number.isSafeInteger(c.nativeControlGeneration) || c.nativeControlGeneration < 0))
    throw new Error("goal_episode_native_control_missing");
  try { assertGoalExecutionControlGeneration({ goalId: c.goalId, rootChatId: c.chatId, longRunId: c.runId },
    applying || sameMain ? c.nativeControlGeneration : null); }
  catch (error) { if (isGoalDispatchRefusal(error)) throw new Error("goal_episode_native_control_changed"); throw error; }
  if (goalPlanOwnerControlEpoch(c.goalId) !== c.ownerControlEpoch) throw new Error("goal_episode_owner_control_changed");
  if (longRunOwnerHold(run.id) || ["pausing", "cancelling", "cancelled", "completed", "failed"].includes(run.status)
    || (run.status === "paused" && !["app_closed", "crash_recovery"].includes(run.pauseReason ?? ""))) throw new Error("goal_episode_owner_held");
  if (applying && (run.status !== "running" || run.version !== c.runVersion || run.appInstanceId !== c.appInstanceId)) throw new Error("goal_episode_run_stale");
  if (plan?.mutationIdentity !== c.mutationIdentity || plan.revision !== c.goalRevision) throw new Error("goal_episode_plan_stale");
  if (applying && plan.deadline_at && Date.parse(plan.deadline_at) <= now) throw new Error("goal_episode_deadline_reached");
  const worker = latestGoalEpisodeProducer(c.runId);
  if (worker?.id !== c.workerAttemptId || worker.invocation_run_id !== c.producerInvocationId
    || worker.app_instance_id !== c.workerAppInstanceId || getLongRunAttemptGoalRevision(c.runId, c.workerAttemptId) !== c.goalRevision) throw new Error("goal_episode_producer_stale");
  if (boundaryDigest(c.producerInvocationId, c.chatId) !== c.boundaryDigest) throw new Error("goal_episode_effect_boundary_changed");
}
/** Reuse the immutable pre-model capsule; never capture current state at apply. */
export function assertGoalEpisodeCapture(captureId: string, now: number): GoalEpisodeCapture {
  ensureGoalEpisodeSchema();
  const capture = readCapture(captureId);
  if (!capture?.custody) throw new Error(capture?.reason ?? "goal_episode_custody_missing");
  assertCustody(capture.custody, true, now);
  return capture;
}
/** A synchronous local self-change can derive only plan/version, inside the same owned commit.
 * Authority, producer, owner control and effect evidence are copied from the original capture. */
export function withGoalEpisodeSelfChange(captureId: string, derivedId: string, now: number, mutate: () => void): GoalEpisodeCapture {
  if (!getDb().inTransaction || mutate.constructor.name === "AsyncFunction") throw new Error("goal_episode_lineage_transaction_required");
  const original = assertGoalEpisodeCapture(captureId, now), before = original.custody!;
  if (!validId(derivedId) || readCapture(derivedId)) throw new Error("goal_episode_capture_conflict");
  const returned: unknown = mutate();
  if (returned && typeof (returned as { then?: unknown }).then === "function") throw new Error("goal_episode_async_registration");
  const run = getLongRunByGoalId(before.goalId), plan = readGoalPlan(before.goalId);
  if (!run || !plan?.mutationIdentity) throw new Error("goal_episode_custody_stale");
  const derived = { ...original, captureId: derivedId, custody: { ...before, runVersion: run.version, mutationIdentity: plan.mutationIdentity } };
  assertCustody(derived.custody, true, now);
  recordGoalPlanDecision({ goalId: before.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "plan_op",
    createdAt: new Date(now).toISOString(), payload: { actor: "strategy-episode", sourceCaptureId: captureId, derivedCaptureId: derivedId,
      beforeMutationIdentity: before.mutationIdentity, afterMutationIdentity: plan.mutationIdentity,
      beforeRunVersion: before.runVersion, afterRunVersion: run.version, producerInvocationId: before.producerInvocationId } });
  getDb().prepare("INSERT INTO goal_episode_captures(id,goal_id,value_json) VALUES (?,?,?)")
    .run(derivedId, before.goalId, JSON.stringify(derived));
  return derived;
}

export function readGoalEpisodeDisposition(requestId: string): GoalEpisodeDisposition | null {
  ensureGoalEpisodeSchema();
  const row = getDb().prepare("SELECT value_json FROM goal_episode_dispositions WHERE id=?").get(requestId) as { value_json: string } | undefined;
  if (!row) return null;
  try { const value = JSON.parse(row.value_json) as GoalEpisodeDisposition; return value.requestId === requestId ? value : null; } catch { return null; }
}
/** One synchronous local unit: wait checkpoint + transition + disposition + outbox.
 * The caller may wrap this in the AGI claim/settlement transaction. Never pass an async registration callback. */
export function applyGoalEpisodeRest(input: { requestId: string; captureId: string; goalId: string; intent: GoalWaitIntent | null;
  signal?: AbortSignal; now?: number; projectDir?: string | null; hasTransientAttachments?: boolean; refusal?: string; latestReceipt?: AgiGoalFactsDeps["latestReceipt"] }, register: RegisterWait): GoalEpisodeDisposition {
  ensureGoalEpisodeSchema();
  if (!validId(input.requestId) || !validId(input.captureId) || !validId(input.goalId)) throw new Error("goal_episode_request_invalid");
  const intentDigest = digest({ captureId: input.captureId, goalId: input.goalId, intent: input.intent, refusal: input.refusal ?? null });
  const now = input.now ?? Date.now();
  const result: GoalEpisodeDisposition = { requestId: input.requestId, captureId: input.captureId, goalId: input.goalId,
    status: "decision_recorded", code: "goal_episode_unscheduled", waitId: null, checkpointId: null,
    requestedUntil: input.intent?.subject.kind === "timer" ? input.intent.subject.notBefore : null, nextCheckAt: null, executionAvailability: null };
  return desktopStoreTransaction(getDb(), () => {
    const prior = getDb().prepare("SELECT intent_digest FROM goal_episode_dispositions WHERE id=?").get(input.requestId) as { intent_digest: string } | undefined;
    if (prior) {
      if (prior.intent_digest !== intentDigest) return { ...result, code: "goal_episode_request_conflict" };
      const replay = readGoalEpisodeDisposition(input.requestId);
      if (!replay) throw new Error("goal_episode_receipt_invalid");
      return { ...replay, replayed: true };
    }
    // A savepoint allows a typed refusal receipt after rolling back every partial
    // registration write; the outer caller still atomically settles its action.
    try { desktopStoreTransaction(getDb(), () => {
      if (register.constructor.name === "AsyncFunction") throw new Error("goal_episode_async_registration");
      if (input.signal?.aborted) throw new Error("goal_episode_cancelled");
      if (input.refusal) throw new Error(input.refusal);
      const capture = readCapture(input.captureId);
      if (!capture || capture.goalId !== input.goalId || !capture.custody) throw new Error(capture?.reason ?? "goal_episode_custody_missing");
      if (!input.intent) throw new Error("goal_episode_no_wait_intent");
      const parsed = parseGoalWaitIntent("```agentlas-goal-wait\n" + JSON.stringify(input.intent) + "\n```").request;
      if (parsed?.status !== "requested") throw new Error("goal_episode_intent_invalid");
      const c = capture.custody;
      withCurrentGoalPlan(c.goalId, c.mutationIdentity, () => {
        assertCustody(c, true, now);
        const wait = register({ goalId: c.goalId, invocationRunId: c.producerInvocationId, intent: parsed.intent, now,
          episodeCaptureId: input.captureId, episodeRequestId: input.requestId, observationOnly: !c.effectsSettled,
          projectDir: input.projectDir, hasTransientAttachments: input.hasTransientAttachments });
        if (!wait || wait.state !== "pending" || wait.sourceInvocationId !== c.producerInvocationId
          || wait.episodeCaptureId !== input.captureId || wait.episodeRequestId !== input.requestId) throw new Error("goal_episode_registration_invalid");
        Object.assign(result, { status: "wait_registered", code: "goal_episode_wait_registered", waitId: wait.waitId,
          checkpointId: wait.checkpointId, nextCheckAt: wait.nextCheckAt, waitState: wait.state, executionAvailability: wait.executionAvailability, quietBaseline: captureEpisodeQuietBaseline(c.goalId, now, input.latestReceipt) });
        getDb().prepare("INSERT INTO goal_episode_notice_outbox(disposition_id,chat_id,created_at) VALUES (?,?,?)")
          .run(input.requestId, c.chatId, new Date(now).toISOString());
      });
    })(); } catch (error) {
      Object.assign(result, { status: "decision_recorded", code: typedReason(error), waitId: null, checkpointId: null, nextCheckAt: null,
        executionAvailability: null, waitState: undefined });
      // Busy/unavailable storage is not a durable refusal; let the caller report
      // failure and retry only the same local request, never an external action.
      if (result.code === "goal_episode_busy" || result.code === "goal_episode_apply_failed") throw new Error(result.code);
    }
    getDb().prepare("INSERT INTO goal_episode_dispositions(id,capture_id,intent_digest,value_json) VALUES (?,?,?,?)")
      .run(input.requestId, input.captureId, intentDigest, JSON.stringify(result));
    return result;
  }).immediate();
}

/** Legacy waits omit episode fields. New waits may not shed one field or use a foreign receipt. */
export function episodeWaitFenceReason(wait: GoalWaitSubscription, now = Date.now()): string | null {
  if (wait.episodeCaptureId === undefined && wait.episodeRequestId === undefined) {
    // A registered episode cannot become a legacy wait by shedding its capsule.
    const db = getDb();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_episode_dispositions'").get()) return null;
    return db.prepare("SELECT 1 FROM goal_episode_dispositions WHERE json_extract(value_json,'$.waitId')=? LIMIT 1").get(wait.waitId)
      ? "goal_episode_wait_custody_invalid" : null;
  }
  try {
    if (!validId(wait.episodeCaptureId) || !validId(wait.episodeRequestId)) return "goal_episode_wait_custody_invalid";
    ensureGoalEpisodeSchema();
    const capture = readCapture(wait.episodeCaptureId), receipt = readGoalEpisodeDisposition(wait.episodeRequestId);
    if (!capture?.custody || !receipt || receipt.status !== "wait_registered" || receipt.waitId !== wait.waitId
      || receipt.captureId !== wait.episodeCaptureId || receipt.goalId !== wait.goalId || receipt.checkpointId !== wait.checkpointId) return "goal_episode_wait_custody_invalid";
    assertCustody(capture.custody, false, now);
    return null;
  } catch (error) { return typedReason(error); }
}
/** Called with the existing wait ledger write, including cancellation/recovery. */
export function recordEpisodeWaitTransition(wait: GoalWaitSubscription): void {
  if (!wait.episodeRequestId) return;
  ensureGoalEpisodeSchema();
  const receipt = readGoalEpisodeDisposition(wait.episodeRequestId);
  if (!receipt) return; // Initial registration precedes its disposition insert in the same transaction.
  if (receipt.waitId !== wait.waitId || receipt.captureId !== wait.episodeCaptureId) throw new Error("goal_episode_wait_custody_invalid");
  getDb().prepare("UPDATE goal_episode_dispositions SET value_json=? WHERE id=?")
    .run(JSON.stringify({ ...receipt, checkpointId: wait.checkpointId, waitState: wait.state, successorInvocationId: wait.successorInvocationId,
      nextCheckAt: wait.nextCheckAt, code: wait.wakeReason ?? receipt.code }), wait.episodeRequestId);
}

/** Bounded drain in the existing wait poller. A committed message ID is delivery
 * to local history, not proof that a renderer or OS notification was seen. */
export function drainGoalEpisodeNotices(limit = 20): void {
  const db = getDb();
  if (db.inTransaction) return;
  ensureGoalEpisodeSchema();
  const pending = db.prepare("SELECT disposition_id FROM goal_episode_notice_outbox WHERE message_id IS NULL ORDER BY rowid LIMIT ?")
    .all(Math.max(1, Math.min(100, limit))) as Array<{ disposition_id: string }>;
  for (const row of pending) {
    let chatId: string | null = null;
    try { db.transaction(() => {
      const item = db.prepare("SELECT chat_id,message_id FROM goal_episode_notice_outbox WHERE disposition_id=?").get(row.disposition_id) as { chat_id: string; message_id: string | null } | undefined;
      if (!item || item.message_id) return;
      const receipt = readGoalEpisodeDisposition(row.disposition_id), capture = receipt ? readCapture(receipt.captureId) : null;
      if (!receipt || !capture?.custody || !getChat(item.chat_id)) return;
      const run = getLongRunByGoalId(capture.goalId);
      const currentWait = latestGoalWaitSubscription(capture.goalId);
      const pendingFence = receipt.waitState === "pending" && (run?.status !== "waiting_tool" || !currentWait || currentWait.waitId !== receipt.waitId
        || currentWait.state !== "pending" || episodeWaitFenceReason(currentWait) !== null);
      const held = pendingFence || !run || longRunOwnerHold(run.id) || goalPlanOwnerControlEpoch(capture.goalId) !== capture.custody.ownerControlEpoch
        || ["paused", "pausing", "cancelled", "cancelling", "failed", "completed"].includes(run.status)
        || ["blocked", "cancelled", "expired"].includes(receipt.waitState ?? "");
      const ko = currentUiLocale() === "ko";
      const text = held ? (ko ? "등록된 대기가 보류되었어요. 현재 권한과 실행 상태를 확인해야 합니다." : "The registered wait is held. Current authority and execution state need review.")
        : receipt.waitState === "dispatched" ? (ko ? "등록된 대기 조건을 확인하고 후속 실행을 접수했어요." : "The registered condition was observed and its successor run was accepted.")
          : receipt.waitState === "claimed" ? (ko ? "대기 조건을 확인했어요. 후속 실행의 접수 여부를 확인 중입니다." : "The wait condition was observed. Successor acceptance is being reconciled.")
            : (ko ? "대기를 등록했어요. 앱 실행 중 확인합니다." : "The wait is registered and checked while the app is running.")
              + (receipt.nextCheckAt ? ` ${receipt.nextCheckAt}` : "");
      const id = randomUUID();
      insertHostNoticeInTransaction({ id, chatId: item.chat_id, text, createdAt: new Date().toISOString(),
        hostNotice: { purpose: "host-status", runId: capture.custody.producerInvocationId, status: held ? "wait-not-scheduled" : "wait-registered" } });
      db.prepare("UPDATE goal_episode_notice_outbox SET message_id=? WHERE disposition_id=? AND message_id IS NULL").run(id, row.disposition_id);
      chatId = item.chat_id;
    }).immediate(); } catch { continue; } // No work is repeated to repair a local notice.
    if (chatId) { try { emitHostNoticeCommitted(chatId); } catch { /* durable history survives an unavailable event sink */ } }
  }
}

/** Only this exact future pending wait owns the next repair. Cursor churn is irrelevant. */
export function readEpisodeQuietBaseline(goalId: string, now: number, db = getDb()): string | null {
  // The facts API also supports independent SQLite projections. They must not
  // accidentally read a different Main store or require Main initialization.
  try { if (db !== getDb()) return null; } catch { return null; }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_episode_dispositions'").get()) return null;
  const wait = latestGoalWaitSubscription(goalId);
  if (!wait?.episodeRequestId || wait.state !== "pending" || !wait.nextCheckAt || Date.parse(wait.nextCheckAt) <= now
    || getLongRunByGoalId(goalId)?.status !== "waiting_tool" || episodeWaitFenceReason(wait, now)) return null;
  const receipt = readGoalEpisodeDisposition(wait.episodeRequestId);
  return typeof receipt?.quietBaseline === "string" ? receipt.quietBaseline : null;
}
