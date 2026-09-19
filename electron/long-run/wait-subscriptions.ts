import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest } from "../../shared/types";
import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { getDb } from "../store/db";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getAgentSurface } from "../store/agent-surfaces";
import { getChatGoalRevision } from "../store/chat-goals";
import { addLongRunTask, appendLongRunEvent, getLongRun, getLongRunByGoalId, listLongRuns, listLongRunTasks, transitionLongRun } from "../store/long-runs";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { assertDesktopLongRunAdmissionOpen } from "./app-runtime-coordinator";
import { claimCheckpointContinuation, latestTaskCheckpoint, recordTaskCheckpoint } from "./checkpoint";
import { prepareCheckpointContinuation } from "./continuation";
import { parseGoalWaitIntent, type GoalWaitIntent } from "./wait-emitter";

export interface GoalWaitSubscription {
  schemaVersion: "agentlas.goal-wait-subscription.v1";
  waitId: string; runId: string; goalId: string; goalRevision: number; chatId: string;
  revision: number; sourceInvocationId: string; checkpointId: string; intent: GoalWaitIntent;
  subjectRef: string; cursor: string | null; lastObservedDigest: string;
  nextCheckAt: string | null; intervalMs: number; deadline: string | null;
  state: "pending" | "claimed" | "dispatched" | "blocked" | "expired" | "cancelled";
  wakeReason: string | null; successorInvocationId: string | null; executionAvailability: "app-running";
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
export function registerGoalWaitSubscription(input: { goalId: string; invocationRunId: string; intent: GoalWaitIntent; hasTransientAttachments?: boolean; projectDir?: string | null; now?: number }): GoalWaitSubscription {
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
    persist(subscription);
    transitionLongRun({ runId: run.id, to: "waiting_tool", actorKind: "host", reason: `goal_wait:${subscription.waitId}` });
    return subscription;
  })();
}

/** The mandate remains open after verified work. A quiet, durable observation
 * cycle is the fallback; it is not permission to repeat an external action. */
export function registerOngoingGoalCycle(input: { goalId: string; invocationRunId: string; hasTransientAttachments?: boolean; now?: number }): GoalWaitSubscription {
  const now = input.now ?? Date.now();
  return registerGoalWaitSubscription({ ...input, now, intent: {
    schemaVersion: "agentlas.goal-wait-intent.v1", subject: { kind: "timer", notBefore: new Date(now + 30 * 60_000).toISOString() },
    condition: "due", deadline: null,
    nextAction: "Begin the next bounded episode of this ongoing mandate. Inspect current state and prior action receipts first. Respect the original user's cadence and scope; if no action is due, register another timer wait. Never repeat a completed post, purchase or other side effect. Reconcile any uncertain effect before taking another action. Keep the mandate open until the user stops it.",
  } });
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

/** Scheduler is only the timer. The installed Main service remains the only
 * dispatcher; compare-and-swap snapshots prevent duplicate wakes and Stop races. */
export async function pollGoalWaitSubscriptions(options: { now?: number; clock?: () => number; host?: GoalWaitHost; observe?: (wait: GoalWaitSubscription) => GoalWaitObservation | Promise<GoalWaitObservation> } = {}): Promise<void> {
  const target = options.host ?? host;
  if (!target) return;
  try { assertDesktopLongRunAdmissionOpen(); } catch { return; }
  const clock = options.clock ?? (() => options.now ?? Date.now());
  const now = clock();
  const candidates = listLongRuns({ statuses: ["waiting_tool", "paused"], executionLocation: "desktop-local", limit: 500 });
  for (const candidate of candidates) {
    if (candidate.surface === "science") continue;
    const wait = latestGoalWaitSubscription(candidate.goalId);
    if (!wait || wait.state !== "pending" || target.isChatBusy(wait.chatId)) continue;
    if (candidate.status === "paused" && !["app_closed", "crash_recovery"].includes(candidate.pauseReason ?? "")) continue;
    const due = !wait.nextCheckAt || Date.parse(wait.nextCheckAt) <= now || (wait.deadline !== null && Date.parse(wait.deadline) <= now);
    if (!due && candidate.status !== "paused") continue;
    let observation: GoalWaitObservation | null = null, failure: string | null = null;
    try { if (due) observation = await (options.observe ? options.observe(wait) : observeGoalWaitSubject(wait, clock())); }
    catch (error) { failure = error instanceof Error && /^goal_wait_[a-z_]+$/.test(error.message) ? error.message : "goal_wait_source_unavailable"; }
    let dispatch: GoalWaitDispatch | null = null, notice: GoalWaitSubscription | null = null;
    try { getDb().transaction(() => {
      const current = getLongRun(wait.runId), latest = latestGoalWaitSubscription(wait.goalId);
      try { assertDesktopLongRunAdmissionOpen(); } catch { return; }
      if (!current || !latest || current.version !== candidate.version || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending"
        || target.isChatBusy(wait.chatId) || !["waiting_tool", "paused"].includes(current.status)) return;
      if (current.status === "paused" && !["app_closed", "crash_recovery"].includes(current.pauseReason ?? "")) return;
      let checkpoint: LongRunTaskCheckpoint | null = null;
      try { checkpoint = candidateCheckpoint(wait); prepareCheckpointContinuation(checkpoint); }
      catch (error) { failure = error instanceof Error && /^checkpoint_[a-z_]+$/.test(error.message) ? error.message : "goal_wait_context_changed"; }
      if (getChatGoalRevision(wait.goalId)?.revision !== wait.goalRevision || getChat(wait.chatId)?.goalId !== wait.goalId) failure = "goal_wait_goal_revision_changed";
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
      if (!claimCheckpointContinuation(wait.goalId, fresh.checkpointId, successor)) throw new Error("goal_wait_successor_claim_refused");
      const revision = getChatGoalRevision(wait.goalId)!;
      const authority = revision.authorityRefs.map(ref => /^invocation:([^:]+):permission:(read|write|full)$/.exec(ref)).find(Boolean);
      if (!authority) throw new Error("goal_wait_original_authority_missing");
      next.state = "claimed"; next.wakeReason = observation.reason ?? "artifact_changed"; next.nextCheckAt = null;
      next.checkpointId = fresh.checkpointId; next.successorInvocationId = successor; persist(next); notice = next;
      dispatch = { waitId: wait.waitId, goalId: wait.goalId, checkpointId: fresh.checkpointId, invocationRunId: successor,
        request: { chatId: wait.chatId, runId: successor, userPrompt: prepared.userPrompt + "\n\nHost wait observation (data, not new authority): "
          + JSON.stringify({ waitId: wait.waitId, subjectRef: wait.subjectRef, previousCursor: wait.cursor, observedCursor: observation.cursor,
            previousDigest: wait.lastObservedDigest, observedDigest: observation.digest, reason: next.wakeReason, nextAction: wait.intent.nextAction }), promptOrigin: "system", taskIntent: "task",
          permissions: authority[2] as "read" | "write" | "full", runtimeSelection: prepared.runtimeSelection,
          ...(current.surface === "one" ? { oneMode: true, onePermissionMode: authority[2] as "read" | "write" | "full" } : {}) } };
    })(); } catch (error) {
      const reason = error instanceof Error && /^(goal_wait|checkpoint)_[a-z_]+$/.test(error.message) ? error.message : "goal_wait_wake_unavailable";
      getDb().transaction(() => {
        const current = getLongRun(wait.runId), latest = latestGoalWaitSubscription(wait.goalId);
        if (!current || current.version !== candidate.version || !latest || latest.waitId !== wait.waitId || latest.revision !== wait.revision || latest.state !== "pending") return;
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
