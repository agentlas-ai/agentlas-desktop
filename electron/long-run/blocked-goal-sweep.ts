import { currentGoalExecutionObligations, prepareGoalObligationContinuation, goalObligationContinuationPrompt, abandonGoalObligationContinuation } from "./goal-obligation-context";
import { applyHostOwnerCardDecision, hostOwnerCardAnswer, OWNER_CARD_STOP_REASON } from "./goal-owner-card-decision";
/** Recover idle Goals through fresh current-context episodes. Checkpoint and
 * effect failures are advisory facts; only an explicit owner hold stops work.
 * Retry spacing still prevents unavailable runtimes from spinning. */
import { applyPendingOwnerGoalAmendments, OWNER_GOAL_AMENDMENT_PENDING_KIND, sweepUnavailableOwnerGoalReviews } from "./goal-owner-amendment";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../../shared/secret-patterns";
import { getDb } from "../store/db";
import { adoptExplicitGoalGrant } from "./explicit-goal-authority";
import { getChat } from "../store/chats";
import { writeAssistantUnlessStopped } from "../chat/chat-stop";
import { getChatGoalRevision } from "../store/chat-goals";
import { invocationRunOwners } from "../store/invocation-run-owners";
import {
  appendLongRunEvent, bindCurrentGoalRevisionToLongRun, getLongRun, liveLongRunAttemptCount, nextBlockedGoalRetrySlot,
  pendingBlockedGoalRetry, reopenDueBlockedGoalRetry, scheduleBlockedGoalRetry, transitionLongRun, goalProviderRetryNotBefore,
  BLOCKED_GOAL_SWEEP_EVENT_KIND, BLOCKED_GOAL_SWEEP_SCHEMA, type LongRunRecord,
  type BlockedGoalRetry,
  longRunOwnerHold, LONG_RUN_OWNER_HOLD_CODE,
  goalOwnerAnswerHold, goalOwnerAnswerPendingSince, releaseGoalOwnerAnswerHold, GOAL_OWNER_ANSWER_PENDING_CODE,
} from "../store/long-runs";
import { automaticGoalReplayBlockerCode, automaticGoalResumeRequest } from "../invocation/automatic-goal";
import {
  assertDesktopLongRunAdmissionOpen, confirmDesktopLongRunResumeDispatched, desktopAppInstanceId,
  failDesktopLongRunResumeDispatch,
} from "./app-runtime-coordinator";
import { latestGoalWaitSubscription } from "./wait-subscriptions";
import { chatWaitsOnPeer } from "../harness/peer-reply-wait";
import { settleNoProgressRest } from "./goal-no-progress-wait";
import { settleDaemonTurnGoals } from "./daemon-turn-goal";
import { reconcileGoalTree } from "./goal-tree-reconcile";
import { type EffectObservationDispatcher } from "./effect-observation-tickets";
import { currentUiLocale } from "../ui-locale";
import { decideGoalContinuationWake, ownerRequestWaiting, recordGoalWake, SAME_CAUSE_WAKE_REASON, unfinishedWakeStreak, type GoalWakeSource } from "./wake-arbiter";
import { GOAL_OWNER_ANSWER_REQUIRED, GOAL_OWNER_GRANT_REQUIRED } from "../../shared/goal-display-state";
import { WORK_PROJECT_RESIDENCY_BUSY_CODE } from "../runtime/project-residency";
import { askOwnerOnce } from "../harness/owner-ask";
import { AGENT_ASK_OPEN } from "../../shared/agent-control-blocks";
import { recordNativeHarnessNote } from "../harness/native-harness-note";
import { browserLadderSignal, browserToolBreakageStops } from "../browser/ladder-signal";
import { goalLifecyclePortFor } from "./goal-lifecycle-port";
import { decideGoalState, type GoalStateFacts, type HarnessDecision } from "../harness/cause";
import { backfillHarnessDue, clearHarnessDue } from "../store/harness-due";
import { closeGoal } from "../store/goal-close";
import { settleLongRunWorkerAttempt } from "../store/long-runs";
import { INVOCATION_BROWSER_LOGIN_WAIT_EVENT } from "../../shared/invocation-browser-login-wait";

export type BlockedGoalSweepAction = "observation_dispatched" | "resumed" | "retry_scheduled" | "cancelled" | "deferred";

export interface BlockedGoalSweepResult {
  runId: string;
  fromReason: string | null;
  action: BlockedGoalSweepAction;
  detail: string;
}

/** Model runs a single sweep may start; the rest wait for the next pass instead of bursting at boot. */
export const BLOCKED_GOAL_SWEEP_MAX_DISPATCHES = 4;

/**
 * No timer sweeps on this period any more (Agentlas 2.0 N3c: harness/due-timer.ts is aimed at the next look, and signals look at one
 * Goal's chat). The number is the grace of a "running" Goal that nothing owns: one that changed less than this long ago may still be
 * starting its own turn, so a full look leaves it for the next one.
 */
export const BLOCKED_GOAL_SWEEP_INTERVAL_MS = 60_000;
/** The same grace for a look at one chat after a signal (a turn just ended there: the follow-up it schedules has been written by then). */
export const BLOCKED_GOAL_SIGNAL_GRACE_MS = 2_000;
/** The typed answer of a look that left a fresh "running" Goal for the next look (the caller looks again after the grace). */
export const BLOCKED_GOAL_RUNNING_GRACE_DETAIL = "running_grace";

/**
 * Why a look happens: startup (the app opened: catches up what a signal missed while it was closed), due (the one timer reached the next
 * look), wake (the machine slept or the clock jumped), signal (one chat: the owner wrote, a card was answered, a turn ended, another
 * process settled), periodic (kept for callers and gates written against the old minute sweep; nothing starts it).
 */
export type BlockedGoalSweepTrigger = "startup" | "periodic" | "due" | "wake" | "signal";

/**
 * Deterministic QA markers only — the fixed prefixes QA sessions put at the very start of the request.
 * No prose is interpreted: a goal that merely mentions QA later in its text is not matched.
 */
export function staleQaGoalMarker(text: string | null | undefined): string | null {
  const value = (text ?? "").trimStart();
  const marker = /^\[QA_MARKER=([A-Za-z0-9._:-]{1,80})\]/.exec(value);
  if (marker) return `qa_marker:${marker[1]}`;
  if (/^Local release QA only\./.test(value)) return "qa_prefix:local-release-qa-only";
  return null;
}

/**
 * `status` is the durable host-status marker: a resumed goal folds into the resumed run's work line
 * (`runId` = that invocation); a closed goal or a failed attempt that will be retried stays prominent.
 */
function notify(run: LongRunRecord, status: "goal-closed" | "effect-retrying", ko: string, en: string, runId: string = run.id): void {
  if (!run.rootChatId) return;
  // A host notice is a new assistant line: none after the person's Stop until they speak or press a Goal control.
  try {
    writeAssistantUnlessStopped(run.rootChatId, currentUiLocale() === "ko" ? ko : en,
      { hostNotice: { purpose: "host-status", runId, status } }, { longRunId: run.id });
  } catch (error) {
    console.warn("[blocked-goal-sweep] chat notice failed:", error);
  }
}

/** Typed cause thrown by transitionLongRun when another live owner holds the run (store/long-runs.ts). */
export const RESUME_LOST_TO_LIVE_OWNER_CODE = "long_run_transition_owner_conflict";

function errorCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[a-z_]+(?::[a-z_0-9-]+)?$/.test(error.message) ? error.message : fallback;
}

/**
 * errorCode() collapses every exception without a machine code into one fallback, which is how an
 * 08:56 resume failure in the Youtube room (2026-10-10) left only `blocked_goal_resume_unavailable`
 * and no way to tell why. Keep the code, but log the real cause (redacted, bounded) to main.log.
 */
function logSweepFailureCause(stage: string, runId: string, code: string, error: unknown): void {
  try {
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.warn(`[blocked-goal-sweep] ${stage} failed run=${runId} code=${code} cause=${redactSecrets(raw).replace(/\s+/g, " ").slice(0, 400)}`);
  } catch { /* diagnostics must never change the retry decision */ }
}

function scheduleRetry(run: LongRunRecord, kind: "observe" | "resume", detail: string, trigger: string,
  options: { fromReason?: string | null; dispatchFailed?: boolean; quiet?: boolean } = {}): BlockedGoalSweepResult {
  const slot = nextBlockedGoalRetrySlot(run.id);
  scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind,
    fromReason: options.fromReason !== undefined ? options.fromReason : run.blockedReason,
    retryIndex: slot.retryIndex, nextAt: slot.nextAt, detail,
    trigger: options.dispatchFailed ? `dispatch-failed:${trigger}` : trigger,
    appInstanceId: desktopAppInstanceId() });
  if (slot.retryIndex === 0 && !options.quiet) {
    const minutes = Math.max(1, Math.round((Date.parse(slot.nextAt) - Date.now()) / 60_000));
    notify(run, "effect-retrying", kind === "observe"
      ? `이전 작업이 반영됐는지 지금은 확인하지 못했어요. ${minutes}분 뒤 앱이 스스로 다시 확인하고 이어갑니다.`
      : `지금은 이 목표를 이어갈 모델을 띄우지 못했어요. ${minutes}분 뒤 앱이 스스로 다시 시도합니다.`,
    kind === "observe"
      ? `I could not check the earlier action right now. The app will look again in ${minutes} min on its own and continue.`
      : `No model could pick this goal up right now. The app will try again in ${minutes} min on its own.`);
  }
  return { runId: run.id, fromReason: run.blockedReason, action: "retry_scheduled", detail };
}

/**
 * No turn is held back by another turn of its Work project any more: a project is shared attribution and only turns that write the
 * same native session queue (runtime/native-writer-admission.ts), so the project-wide admission that refused a Goal's turn with
 * work_project_residency_busy (measured 2026-09-24: the sweep resumed the waiting Goal every 60 s and it failed again) is gone.
 * A Goal still carrying that retired reason resumes like any other blocked Goal. Kept as the named answer `false` for callers and
 * gates written against the old contract.
 */
export function projectHeldByAnotherTurn(_run: LongRunRecord, _dispatcher: EffectObservationDispatcher): boolean {
  return false;
}

/**
 * 같은 자동 루프가 진전 없이 반복되어 막힌 목표. 새 오너 입력만 이 장벽을 풀 수 있으므로,
 * 자동 재시도를 예약해 같은 루프를 늘리지 않는다. 이전 턴의 불확실한 영수증은 이 경로로 오지 않는다.
 * 재시도를 예약하지 않고 대기 상태로 돌려 놓아(sweepOne 은 대기 중이고 예약이 없는 목표를 고르지 않는다) 기계 표식 하나만 남기고,
 * 안내는 같은 장벽에 대해 한 번만 낸다.
 */
export const REPLAY_BARRIER_OWNER_NEEDED_ACTION = "owner_needed";
/** The sweep line that says the owner was asked to sign the runtime in again (once until the owner writes). */
const RUNTIME_AUTH_CODE = "runtime_auth_required";
function replayBarrierToldFor(runId: string, code: string, chatId: string | null): boolean {
  // The newest time this very cause was told to the owner, not the newest sweep event of any kind: a turn that settles or a retry that is
  // scheduled writes sweep events of its own and used to make the same barrier read as "not told" (the grant line came twice, #1).
  // It is told until the owner writes: once the owner has answered, the next time the same cause rests the Goal is a new ask (#3).
  const row = getDb().prepare(`SELECT occurred_at AS at FROM long_run_events WHERE run_id = ? AND kind = ?
    AND json_extract(payload_json, '$.action') = ? AND json_extract(payload_json, '$.detail') = ? ORDER BY seq DESC LIMIT 1`)
    .get(runId, BLOCKED_GOAL_SWEEP_EVENT_KIND, REPLAY_BARRIER_OWNER_NEEDED_ACTION, code) as { at: string } | undefined;
  if (!row) return false;
  if (!chatId) return true;
  return !getDb().prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND created_at > ? LIMIT 1").get(chatId, row.at);
}
/**
 * The runtime's sign-in is gone and no other runtime takes the turn (the cause table's row auth_no_runtime): the Goal waits for the owner, so the owner is
 * asked once, as a card that rings (harness/owner-ask.ts, the existing credential card; no new text). Once until the owner writes: the owner's word that
 * it is ready continues the Goal at once, and the same wait that returns later is a new ask (replayBarrierToldFor reads this very sweep line). Called
 * wherever the same-cause wait is written: the turn's end (invocation/service.ts) and this sweep. Never throws.
 */
export function askRuntimeSignInOnce(runId: string, chatId: string | null, trigger: string): void {
  if (!chatId) return;
  try {
    if (replayBarrierToldFor(runId, RUNTIME_AUTH_CODE, chatId)) return;
    appendLongRunEvent({ runId, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
      payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: REPLAY_BARRIER_OWNER_NEEDED_ACTION, detail: RUNTIME_AUTH_CODE, trigger: trigger.slice(0, 80), appInstanceId: desktopAppInstanceId() } });
    askOwnerOnce({ chatId, key: `owner-ask:${runId}:runtime-auth`, kind: "credential", longRunId: runId });
  } catch (error) { logSweepFailureCause("runtime-auth-card", runId, RUNTIME_AUTH_CODE, error); }
}

function parkForReplayBarrier(run: LongRunRecord, code: string, trigger: string): BlockedGoalSweepResult {
  const told = replayBarrierToldFor(run.id, code, run.rootChatId);
  const parked = getDb().transaction(() => {
    const current = getLongRun(run.id);
    if (!current || current.version !== run.version) throw new Error("blocked_goal_sweep_state_changed");
    if (current.status !== "waiting_tool") {
      // The same resting state scheduleBlockedGoalRetry uses (queued -> waiting_tool is not a transitionLongRun edge).
      const changed = getDb().prepare(`UPDATE long_runs SET status='waiting_tool', pause_reason=NULL, blocked_reason=NULL,
        app_instance_id=COALESCE(?, app_instance_id), paused_at=NULL, updated_at=?, version=version+1
        WHERE id=? AND status=? AND version=?`)
        .run(desktopAppInstanceId(), new Date().toISOString(), current.id, current.status, current.version);
      if (changed.changes !== 1) throw new Error("blocked_goal_sweep_state_changed");
      appendLongRunEvent({ runId: current.id, kind: "run.status_changed", actorKind: "host",
        payload: { from: current.status, to: "waiting_tool", reason: "replay-barrier-owner-needed" } });
    }
    appendLongRunEvent({ runId: current.id, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
      payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: REPLAY_BARRIER_OWNER_NEEDED_ACTION, detail: code,
        trigger: trigger.slice(0, 80), appInstanceId: desktopAppInstanceId() } });
    return getLongRun(current.id) ?? current;
  }).immediate();
  const latest = parked;
  clearHarnessDue(latest.rootChatId);
  if (!told) {
    notify(latest, "effect-retrying", "앞 작업 결과를 확인하지 못해 자동으로 이어가지 않았어요. 이어가기를 누르면 계속합니다.",
      "I could not confirm the result of the earlier step, so I did not continue on my own. Press Resume to continue.");
    // Only the owner's new word releases this barrier: the line above is also a card that rings (rule R-a, harness/owner-ask.ts).
    if (latest.rootChatId) askOwnerOnce({ chatId: latest.rootChatId, key: `owner-ask:${run.id}:${code}`, kind: "owner_stop", longRunId: run.id });
  }
  return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: code };
}

/**
 * A Goal with no recorded owner grant rests in waiting_tool carrying GOAL_OWNER_GRANT_REQUIRED (shared/goal-display-state.ts):
 * shown as "needs you" with a working Resume (the press is the grant, ipc chats:resumeGoal), never as running, and with no
 * retry schedule. One notice per Goal. Any status transition (the owner's Resume or message) clears the code.
 */
function parkForOwnerGrant(run: LongRunRecord, trigger: string): BlockedGoalSweepResult {
  let told = replayBarrierToldFor(run.id, GOAL_OWNER_GRANT_REQUIRED, run.rootChatId);
  const parked = getDb().transaction(() => {
    const current = getLongRun(run.id);
    if (!current || current.version !== run.version) throw new Error("blocked_goal_sweep_state_changed");
    // Already resting for the grant: the owner was told when it began, and a message of theirs that did not grant is not a new ask.
    if (current.status === "waiting_tool" && current.blockedReason === GOAL_OWNER_GRANT_REQUIRED) { told = true; return current; }
    const changed = getDb().prepare(`UPDATE long_runs SET status='waiting_tool', pause_reason=NULL, blocked_reason=?,
      app_instance_id=COALESCE(?, app_instance_id), paused_at=NULL, updated_at=?, version=version+1
      WHERE id=? AND status=? AND version=?`)
      .run(GOAL_OWNER_GRANT_REQUIRED, desktopAppInstanceId(), new Date().toISOString(), current.id, current.status, current.version);
    if (changed.changes !== 1) throw new Error("blocked_goal_sweep_state_changed");
    if (current.status !== "waiting_tool") appendLongRunEvent({ runId: current.id, kind: "run.status_changed", actorKind: "host",
      payload: { from: current.status, to: "waiting_tool", reason: GOAL_OWNER_GRANT_REQUIRED } });
    appendLongRunEvent({ runId: current.id, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
      payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: REPLAY_BARRIER_OWNER_NEEDED_ACTION, detail: GOAL_OWNER_GRANT_REQUIRED,
        fromStatus: current.status, trigger: trigger.slice(0, 80), appInstanceId: desktopAppInstanceId() } });
    return getLongRun(current.id) ?? current;
  }).immediate();
  clearHarnessDue(parked.rootChatId);
  if (!told) {
    notify(parked, "effect-retrying",
      "이 목표는 오너 지시 기록 없이 만들어져 아직 시작하지 않았어요. 목표 칩의 이어가기를 누르거나 이 방에 말씀하시면 바로 이어갑니다.",
      "This goal was set up without an instruction from you, so it has not started. Press Resume on the goal chip or send a message here and it continues.");
    // The owner's word is the grant: a card that rings, once (rule R-a, harness/owner-ask.ts).
    if (parked.rootChatId) askOwnerOnce({ chatId: parked.rootChatId, key: `owner-ask:${run.id}:${GOAL_OWNER_GRANT_REQUIRED}`, kind: "owner_stop", longRunId: run.id });
  }
  return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: GOAL_OWNER_GRANT_REQUIRED };
}

/**
 * The chats with a live turn, read once per sweep (#9: every candidate read the list again, 300 reads for 200 Goals). The sweep is
 * synchronous, so nothing starts or ends between two of its reads except the turns it starts itself, which add their chat (resume). Outside a
 * sweep (the async preparation that finishes later) there is no snapshot and the list is read live.
 */
let sweepActiveChats: Set<string> | null = null;
function chatHasLiveTurn(dispatcher: EffectObservationDispatcher, chatId: string): boolean {
  return sweepActiveChats ? sweepActiveChats.has(chatId) : dispatcher.activeChatIds().includes(chatId);
}

/**
 * The candidates' chats in which the browser ladder said a last word (a "final" event) in the last day, read once per sweep in one query over
 * the (chat, kind, time) index. Rules R-a (third caller) and R-b read the ladder per Goal and per sweep for nothing in nearly every room
 * (#9: two more reads per resting Goal each minute). Null outside a sweep: then the rules read as before.
 */
let sweepLadderChats: Set<string> | null = null;
function ladderMaySpeak(chatId: string): boolean { return sweepLadderChats === null || sweepLadderChats.has(chatId); }

const goalObligationPreparations = new Set<string>();
function resume(run: LongRunRecord, dispatcher: EffectObservationDispatcher, trigger: string): BlockedGoalSweepResult {
  if (goalObligationPreparations.has(run.id)) return { runId: run.id, fromReason: run.blockedReason,
    action: "deferred", detail: "goal_preflight_preparing" };
  const chatId = run.rootChatId!;
  // A turn another process holds in this room (the background service) owns the room's lease: Main cannot start beside it, and
  // trying only schedules a retry the owner is told about. Wait for it quietly; the lease ends with that turn.
  let leased = false;
  try { leased = invocationRunOwners.getActiveOwner(chatId) !== null; } catch { /* an unreadable lease is not a reason to hold the Goal */ }
  if (leased) return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: "chat_busy" };
  const providerAt = goalProviderRetryNotBefore(run.id);
  if (providerAt !== null) {
    scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: "resume", fromReason: "provider_retry_not_due",
      retryIndex: pendingBlockedGoalRetry(run.id)?.retryIndex ?? 0, nextAt: new Date(providerAt).toISOString(),
      detail: "provider_retry_not_due", trigger, appInstanceId: desktopAppInstanceId() });
    return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: "provider_retry_not_due" };
  }
  // Every resume path (sweep, a released project) asks the one wake policy: the owner first,
  // then the daily barrier. A reached barrier parks the Goal until its window frees, visibly.
  const source: GoalWakeSource = trigger === "project-released" ? "project-released"
    : trigger === "startup" ? "startup" : "sweep";
  const verdict = decideGoalContinuationWake({ runId: run.id, chatId, source, gate: dispatcher });
  if (!verdict.start) {
    if (verdict.reason === "wake_budget_reached") {
      try {
        const latest = getLongRun(run.id);
        if (latest && !pendingBlockedGoalRetry(latest.id)) scheduleBlockedGoalRetry({ runId: latest.id, expectedVersion: latest.version,
          kind: "resume", fromReason: "wake_budget_reached", retryIndex: 0, nextAt: verdict.retryAt, detail: "wake_budget_reached",
          trigger, appInstanceId: desktopAppInstanceId() });
      } catch (error) { console.warn("[blocked-goal-sweep] budget park unavailable:", error); }
    }
    if (verdict.reason === SAME_CAUSE_WAKE_REASON) {
      // The same move already failed for this cause: wait with the cause and its wake time instead of a paid start now.
      const marker = `${SAME_CAUSE_WAKE_REASON}:${verdict.cause}`.slice(0, 120);
      try {
        const latest = getLongRun(run.id);
        if (latest && !pendingBlockedGoalRetry(latest.id)) {
          scheduleBlockedGoalRetry({ runId: latest.id, expectedVersion: latest.version,
            kind: "resume", fromReason: marker, retryIndex: verdict.failures, nextAt: verdict.retryAt, detail: marker,
            trigger, appInstanceId: desktopAppInstanceId() });
          console.info("[long-run] same-cause wait", JSON.stringify({ runId: run.id, cause: verdict.cause, failures: verdict.failures, nextAt: verdict.retryAt }));
        }
      } catch (error) { logSweepFailureCause("same-cause-park", run.id, SAME_CAUSE_WAKE_REASON, error); }
      // The runtime's sign-in is gone and no other runtime takes the turn: the Goal waits for the owner, so the owner is asked once, as a card that rings
      // (the table's row auth_no_runtime; the card text is the existing credential card). Once until the owner writes: the owner's word that it is ready
      // continues the Goal at once, and the same wait that returns later is a new ask (replayBarrierToldFor reads this very sweep line).
      if (verdict.row === "auth_no_runtime") askRuntimeSignInOnce(run.id, run.rootChatId, trigger);
      return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: marker };
    }
    return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: verdict.reason };
  }
  let prepared: { request: NonNullable<ReturnType<typeof automaticGoalResumeRequest>>; queuedId: string } | null = null;
  let current = run;
  for (let pass = 0; pass < 2 && !prepared; pass += 1) {
    try {
      // IMMEDIATE: this reads before it writes. Deferred, a commit by the daemon (it writes about every second) between
      // the read and the write failed the upgrade at once with SQLITE_BUSY_SNAPSHOT ("database is locked"), which
      // busy_timeout never waits on. After the 1.3.27 restart the Yotube room Goal failed every pass (2026-10-13 16:44Z).
      prepared = getDb().transaction(() => {
        const latest = getLongRun(current.id);
        if (!latest || latest.version !== current.version || !["blocked", "paused", "queued", "running", "waiting_tool"].includes(latest.status)) {
          throw new Error("blocked_goal_sweep_state_changed");
        }
        const request = automaticGoalResumeRequest(chatId, latest.version, "host");
        if (!request) throw new Error("long_run_resume_dispatch_unavailable");
        getDb().prepare("UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ? WHERE goal_id = ? AND status = 'blocked'")
          .run(new Date().toISOString(), latest.goalId);
        // queued is no edge from running or waiting_tool: a Goal already past the queue only needs this host to own the start.
        const queued = transitionLongRun({ runId: latest.id, to: ["running", "waiting_tool"].includes(latest.status) ? "running" : "queued",
          actorKind: "host", reason: "blocked-sweep-resume", appInstanceId: desktopAppInstanceId(), expectedVersion: latest.version });
        appendLongRunEvent({ runId: latest.id, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
          payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: "resumed", fromReason: run.blockedReason,
            fromStatus: run.status, trigger: trigger.slice(0, 80), appInstanceId: desktopAppInstanceId() } });
        return { request: { ...request, runId: randomUUID() }, queuedId: queued.id };
      }).immediate();
    } catch (error) {
      const code = errorCode(error, "blocked_goal_resume_unavailable");
      // The owner's own turn (or another live holder) owns the run right now: losing to it is not a failure.
      // No retry slot, no notice, no log line; the next periodic pass looks again once that turn has settled.
      // Measured 2026-10-12 group room 8f3e09ee: this was scheduled as a retry and announced as "could not start a model".
      // The cause stays typed: sweepOne gives the dispatch slot back, nothing was started.
      if (code === RESUME_LOST_TO_LIVE_OWNER_CODE) return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: RESUME_LOST_TO_LIVE_OWNER_CODE };
      if (code !== "blocked_goal_sweep_state_changed") logSweepFailureCause("resume-prepare", run.id, code, error);
      const latest = getLongRun(run.id);
      if (!latest || code === "blocked_goal_sweep_state_changed" || !["blocked", "paused", "queued", "running", "waiting_tool"].includes(latest.status)) {
        return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: code };
      }
      // A replay barrier needs the owner's own Resume to release it: park instead of scheduling retries that cannot succeed.
      if (automaticGoalReplayBlockerCode(latest.id) === code) {
        try { return parkForReplayBarrier(latest, code, trigger); }
        catch (parkError) { logSweepFailureCause("replay-barrier-park", run.id, code, parkError); }
      }
      // An edited Goal whose new revision was never bound: bind it (the same binder the chip uses), then retry once.
      if (code === "auto_goal_resume_revision_pending" && pass === 0) {
        try { current = bindCurrentGoalRevisionToLongRun(latest.id, latest.version); continue; }
        catch { /* fall through to a scheduled retry */ }
      }
      return scheduleRetry(latest, "resume", code, trigger);
    }
  }
  if (!prepared) return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: "blocked_goal_resume_unavailable" };
  const obligationGoal = getChatGoalRevision(run.goalId);
  if (obligationGoal && currentGoalExecutionObligations(obligationGoal)) {
    // Keep the public synchronous wake contract. This owned preparation is one
    // episode, not a second sweep; no runtime dispatch occurs before its CAS.
    goalObligationPreparations.add(run.id);
    const claimed = prepared;
    void (async () => {
      try {
        claimed.request = await prepareGoalObligationContinuation(claimed.request, { goalId: obligationGoal.goalId, goalRevision: obligationGoal.revision });
        assertDesktopLongRunAdmissionOpen();
        const now = getLongRun(run.id);
        if (!now || getChat(chatId)?.goalId !== run.goalId || chatHasLiveTurn(dispatcher, chatId)
          || ownerRequestWaiting(chatId, dispatcher) || !automaticGoalResumeRequest(chatId, now.version, "host")) {
          throw new Error("goal_obligation_preparation_changed");
        }
        goalObligationContinuationPrompt(claimed.request);
        dispatcher.start(claimed.request, undefined, undefined, undefined, "goal-continuation");
        confirmDesktopLongRunResumeDispatched(claimed.queuedId);
        recordGoalWake({ runId: run.id, chatId, source, invocationRunId: claimed.request.runId ?? null, cause: run.blockedReason ?? trigger });
      } catch (error) {
        abandonGoalObligationContinuation(claimed.request);
        const typedCode = error && typeof error === "object" && "code" in error ? error.code : null;
        const code = typeof typedCode === "string" && /^[a-z_]{1,64}$/.test(typedCode)
          ? `goal_obligation_${typedCode}` : errorCode(error, "goal_obligation_preparation_unavailable");
        // This catch was silent: a preparation refused on every pass for hours left nothing in main.log (2026-10-30).
        logSweepFailureCause("goal-obligation-preparation", run.id, code, error);
        try { failDesktopLongRunResumeDispatch(claimed.queuedId, code); } catch { /* Preserve the original current owner. */ }
        const now = getLongRun(run.id);
        if (now && getChat(chatId)?.goalId === run.goalId && !longRunOwnerHold(now.id)
          && ["queued", "blocked"].includes(now.status)) {
          const slot = nextBlockedGoalRetrySlot(now.id);
          scheduleBlockedGoalRetry({ runId: now.id, expectedVersion: now.version, kind: "resume", fromReason: run.blockedReason,
            retryIndex: slot.retryIndex, nextAt: slot.nextAt, detail: code, trigger, appInstanceId: desktopAppInstanceId() });
        }
      } finally { goalObligationPreparations.delete(run.id); }
    })().catch(error => logSweepFailureCause("goal-obligation-preparation", run.id, "goal_preflight_failed", error));
    return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: "goal_preflight_preparing" };
  }
  // No chat line for a resume: the resumed run draws its own work line, and the ledger event above is the record.
  // (2026-10-12: the line landed as noise right after the owner's one-line instruction.)
  try {
    dispatcher.start(prepared.request, undefined, undefined, undefined, "goal-continuation");
    sweepActiveChats?.add(chatId);
    confirmDesktopLongRunResumeDispatched(prepared.queuedId);
    recordGoalWake({ runId: run.id, chatId, source, invocationRunId: prepared.request.runId ?? null, cause: run.blockedReason ?? trigger });
    return { runId: run.id, fromReason: run.blockedReason, action: "resumed", detail: prepared.request.runId ?? "dispatched" };
  } catch (error) {
    const code = errorCode(error, "blocked_goal_dispatch_failed");
    logSweepFailureCause("resume-dispatch", run.id, code, error);
    try { failDesktopLongRunResumeDispatch(prepared.queuedId, code); } catch { /* keep the original dispatch failure */ }
    const latest = getLongRun(run.id);
    if (!latest) return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: code };
    return scheduleRetry(latest, "resume", code, trigger, { fromReason: run.blockedReason, dispatchFailed: true });
  }
}

/** A host-paused row the startup checkpoint pass evaluated in this app instance and refused (never a user pause). */
function hostPauseRefusedThisInstance(run: LongRunRecord): boolean {
  if (run.status !== "paused" || !["app_closed", "crash_recovery"].includes(run.pauseReason ?? "")) return false;
  const row = getDb().prepare(`SELECT json_extract(payload_json, '$.status') AS status, json_extract(payload_json, '$.reason') AS reason
    FROM long_run_events WHERE run_id = ? AND kind = 'run.checkpoint_startup'
    AND json_extract(payload_json, '$.appInstanceId') = ? ORDER BY seq DESC LIMIT 1`)
    .get(run.id, desktopAppInstanceId()) as { status: string | null; reason: string | null } | undefined;
  return row?.status === "skipped" && row.reason !== "chat_busy";
}

/**
 * A host pause (app_closed, crash_recovery) written by this very app run: the background service's turn in the Goal's room was cut off and the Goal
 * paused with it. Nothing at start will look at it again (the startup check ran before it existed), so the sweep schedules it. A pause the startup
 * check is still to judge is not this: one of another app run (a Goal that run owned), one that check evaluated (it resumed it, or refused it and
 * hostPauseRefusedThisInstance carries it on), one a registered wait owns, and every pause seen by the startup look itself. A Goal of the
 * background service has no app instance (nobody claimed it); one claimed by this instance is this run's too (defect 2).
 */
function hostPauseOfThisInstance(run: LongRunRecord, trigger: string): boolean {
  if (run.status !== "paused" || !["app_closed", "crash_recovery"].includes(run.pauseReason ?? "") || trigger === "startup") return false;
  if (hostPauseRefusedThisInstance(run)) return false;
  const mine = desktopAppInstanceId();
  if (run.appInstanceId !== null && run.appInstanceId !== mine) return false;
  if (run.appInstanceId === null) {
    const evaluated = getDb().prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = 'run.checkpoint_startup' AND json_extract(payload_json, '$.appInstanceId') = ? LIMIT 1").get(run.id, mine);
    if (evaluated) return false;
  }
  const wait = latestGoalWaitSubscription(run.goalId);
  return !(wait && (wait.state === "pending" || wait.state === "claimed"));
}

/** Release only an obsolete host receipt hold, never a model-requested wait or
 * an unavailable-runtime backoff. The exact immutable event owns the cause. */
function receiptOnlyRetry(runId: string, retry: BlockedGoalRetry): boolean {
  if (retry.requestedBy !== "host") return false;
  const row = getDb().prepare(`SELECT json_extract(payload_json, '$.detail') AS detail
    FROM long_run_events WHERE run_id = ? AND seq = ? AND kind = ?`)
    .get(runId, retry.seq, BLOCKED_GOAL_SWEEP_EVENT_KIND) as { detail: string | null } | undefined;
  return row?.detail === "runtime_turn_unsettled" || row?.detail === "serving_reconciliation_required";
}

/**
 * A Goal run whose chat the owner deleted. long_runs.root_chat_id is ON DELETE SET NULL, so the run outlives the
 * chat with nothing to resume into. The sweep used to read that as goal_chat_binding_missing and schedule a retry for
 * ever (index 60, next in 6 h, measured on the owner's DB 2026-10-05) while AGI filed 65 defect reports on it.
 * No chat holds the Goal any more, so the only honest end is closing it.
 */
function goalOfDeletedChat(run: LongRunRecord): boolean {
  // Only a run the common ledger drives can be "a Goal whose chat was deleted"; a domain run (Science) has no root chat by design.
  if (run.rootChatId || goalLifecyclePortFor(run)?.kind !== "host") return false;
  const held = getDb().prepare("SELECT 1 FROM chats WHERE goal_id = ? LIMIT 1").get(run.goalId);
  return !held;
}

function closeGoalOfDeletedChat(run: LongRunRecord, trigger: string): BlockedGoalSweepResult {
  const detail = "goal_chat_deleted";
  // The one close, unconditionally (Agentlas 2.0 N4): a live attempt of a Goal whose conversation is gone has nothing to resume into and the
  // close does not wait for it. A conversation deleted by this build already took its Goal's records with it (store/goal-close.ts
  // removeGoalRecordsOfChat); what reaches this look is the orphan an older build left. It is closed here and its record is kept for the owner's
  // history until the retention pass removes a closed run that no conversation names, 90 days after it ended (long_runs.orphaned-closed).
  closeGoal(run.goalId, "cancelled", "cleanup", { reason: detail });
  appendLongRunEvent({ runId: run.id, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
    payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: "cancelled", fromReason: run.blockedReason, fromStatus: run.status,
      detail, trigger: trigger.slice(0, 80), appInstanceId: desktopAppInstanceId() } });
  return { runId: run.id, fromReason: run.blockedReason, action: "cancelled", detail };
}

/** The hold's turn (run.owner_answer_pending invocationRunId) asked through a card, and none of its cards waits any more. */
function ownerCardHoldSettled(runId: string, chatId: string): boolean {
  const row = getDb().prepare("SELECT json_extract(payload_json,'$.invocationRunId') AS turn FROM long_run_events WHERE run_id = ? AND kind = 'run.owner_answer_pending' ORDER BY seq DESC LIMIT 1")
    .get(runId) as { turn: unknown } | undefined;
  const turn = typeof row?.turn === "string" ? row.turn : "";
  if (!turn) return false;
  const { conversationUiFacts, turnOwnerWaitInstanceIds } = require("../harness/ui-instances") as typeof import("../harness/ui-instances");
  const facts = conversationUiFacts([chatId])?.get(chatId);
  return Boolean(facts?.ownerWaitTurnIds.has(turn)) && turnOwnerWaitInstanceIds(chatId, turn).length === 0;
}

/**
 * A Goal held for the owner's answer (store/long-runs.ts holdGoalForOwnerAnswer) is woken by nobody. It leaves the hold
 * when the owner answers: the desktop composer reopens it itself (stoppedGoalMessageReopens), but a message that arrives with
 * a workspace binding or execution context (the phone, Telegram) is not a local owner turn and cannot reopen a Goal, so the
 * Goal would rest for ever. This is the one place that notices: the owner wrote in the Goal's chat after it asked. A live turn
 * in the chat, or an owner request about to start, is the owner's own path and is left to finish first.
 */
function releaseAnsweredOwnerHold(run: LongRunRecord, dispatcher: EffectObservationDispatcher): LongRunRecord | "stopped" | null {
  const chatId = run.rootChatId;
  if (!chatId) return null;
  if (chatHasLiveTurn(dispatcher, chatId) || ownerRequestWaiting(chatId, dispatcher)) return null;
  const since = goalOwnerAnswerPendingSince(run.id);
  if (!since) return null;
  const spoke = getDb().prepare("SELECT text FROM chat_messages WHERE chat_id = ? AND role = 'user' AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(chatId, since) as { text: string } | undefined;
  if (!spoke) {
    // A turn that waited on its own card (not a chat question) is answered by the owner's press, which writes no chat message:
    // once none of that turn's cards waits any more (pressed, replaced or closed), the hold ends the same way.
    if (!ownerCardHoldSettled(run.id, chatId)) return null;
    try {
      return releaseGoalOwnerAnswerHold({ runId: run.id, expectedVersion: run.version, reason: "owner-card-settled",
        appInstanceId: desktopAppInstanceId() });
    } catch (error) {
      const code = errorCode(error, "goal_owner_answer_release_unavailable");
      if (code !== "goal_owner_answer_release_state_changed") logSweepFailureCause("owner-card-release", run.id, code, error);
      return null;
    }
  }
  // The owner's newest word picked an option of the Goal's own host card: a stop is applied, never released into a resume.
  try {
    const answer = hostOwnerCardAnswer({ goalId: run.goalId, chatId, reply: spoke.text });
    if (answer && applyHostOwnerCardDecision(answer, { chatId, via: "sweep" }) === "stopped") return "stopped";
  } catch (error) {
    logSweepFailureCause("owner-card-decision", run.id, errorCode(error, "owner_card_decision_unavailable"), error);
  }
  try {
    return releaseGoalOwnerAnswerHold({ runId: run.id, expectedVersion: run.version, reason: "owner-answered-outside-the-composer",
      appInstanceId: desktopAppInstanceId() });
  } catch (error) {
    const code = errorCode(error, "goal_owner_answer_release_unavailable");
    if (code !== "goal_owner_answer_release_state_changed") logSweepFailureCause("owner-answer-release", run.id, code, error);
    return null;
  }
}

/**
 * Rule R-a, third caller: the browser fallback ladder stopped on a human check (the site's, never solved or bypassed) and its own owner
 * card is not in the room. One card, once (the ladder event is the key).
 */
function askForLadderHumanCheck(run: LongRunRecord): void {
  const chatId = run.rootChatId;
  if (!chatId || !ladderMaySpeak(chatId)) return;
  try {
    const ladder = browserLadderSignal(getDb(), chatId, Date.now());
    if (!ladder || ladder.signal.kind !== "boundary") return;
    // The ladder opens its own card for a human check: only when no question card has reached the room since, or the owner already
    // answered the one that did, is a card missing.
    const open = getDb().prepare("SELECT created_at AS at FROM chat_messages WHERE chat_id = ? AND role = 'assistant' AND created_at >= ? AND instr(text, ?) > 0 ORDER BY created_at DESC LIMIT 1")
      .get(chatId, ladder.at, AGENT_ASK_OPEN) as { at: string } | undefined;
    if (open && !getDb().prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND created_at > ? LIMIT 1").get(chatId, open.at)) return;
    askOwnerOnce({ chatId, key: `owner-ask:${ladder.ref}`, kind: "security_consent" });
  } catch (error) { console.warn("[blocked-goal-sweep] ladder human-check card skipped:", error instanceof Error ? error.message : String(error)); }
}

/**
 * Rule R-b: the browser tool of this Goal's room broke twice in a day (ladder stops on a closed list of tool-breakage codes: a verdict
 * about ownership or the owner's own sign-in is never in it). The next turn's plan context then carries one line - use the runtime's own
 * tools for this capability - one line (harness/native-harness-note.ts), written once a day.
 */
function noteBrowserToolBreakage(run: LongRunRecord): void {
  const chatId = run.rootChatId;
  if (!chatId || !ladderMaySpeak(chatId)) return;
  try {
    if (browserToolBreakageStops(getDb(), chatId, Date.now() - 24 * 60 * 60_000) >= 2) recordNativeHarnessNote({ goalId: run.goalId, runId: run.id, capability: "browser" });
  } catch (error) { console.warn("[blocked-goal-sweep] browser tool-breakage note skipped:", error instanceof Error ? error.message : String(error)); }
}

/** The facts of the cause table that nothing has been asked about yet: every one says "no" (harness/cause.ts GoalStateFacts). */
const NO_OTHER_FACTS: Omit<GoalStateFacts, "status" | "pauseReason" | "chatGone" | "ownerHold"> = {
  answerHold: false, grantMissing: false, replayBarrier: false, registeredWait: false, scheduledRetry: false,
  attemptRunning: false, turnLive: false,
};

/** An attempt that says "running" while no turn of the Goal lives is older than this before it is settled (a turn being prepared writes its attempt first). */
const ORPHAN_ATTEMPT_GRACE_MS = 2 * 60_000;
/** A "pausing" that has not moved for this long was never finished (its process died): the sweep finishes it as "paused". */
const PAUSING_NEVER_FINISHED_MS = 2 * 60_000;
const VERIFIER_ALIVE_MS = 30 * 60_000;

/** The Goal's chat has a live turn in this process, or another process holds the chat's lease (the background service). */
function goalTurnLive(run: LongRunRecord, dispatcher: EffectObservationDispatcher): boolean {
  const chatId = run.rootChatId;
  if (!chatId) return false;
  if (chatHasLiveTurn(dispatcher, chatId)) return true;
  try { return invocationRunOwners.getActiveOwner(chatId) !== null; } catch { return false; }
}

/**
 * Audit 44 defect 5 and the "attempt running, no turn" cell: a worker attempt left "running" by a turn whose own finally never settled
 * it holds the Goal for ever (sweepOne deferred it as attempt_running on every pass). With no turn alive in this process or under a lease,
 * an attempt past the grace is settled as interrupted with a typed code; the Goal then continues like any other. Returns how many were
 * settled. A verifier's attempt is not a controller's and is never touched here.
 */
function settleOrphanAttempts(run: LongRunRecord, now = Date.now()): number {
  // A turn parked on the owner's browser sign-in is alive without being in the process's active list: its durable wait says so
  // (the latest login-wait line of the chat is waiting or claimed). Its attempt is the wait's own; the wait ends it.
  if (run.rootChatId && browserLoginWaitOpen(run.rootChatId)) return 0;
  const rows = getDb().prepare(`SELECT a.id AS id, a.updated_at AS at FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id = a.worker_id WHERE a.run_id = ? AND a.state = 'running' AND w.role != 'verifier'`)
    .all(run.id) as Array<{ id: string; at: string }>;
  let settled = 0;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isFinite(at) && now - at < ORPHAN_ATTEMPT_GRACE_MS) continue;
    try { if (settleLongRunWorkerAttempt({ attemptId: row.id, state: "interrupted", errorCode: "attempt_without_turn" })) settled += 1; }
    catch (error) { logSweepFailureCause("orphan-attempt", run.id, "attempt_without_turn", error); }
  }
  return settled;
}

function browserLoginWaitOpen(chatId: string): boolean {
  try {
    const row = getDb().prepare("SELECT json_extract(payload_json, '$.wait.state') AS state FROM run_events WHERE chat_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
      .get(chatId, INVOCATION_BROWSER_LOGIN_WAIT_EVENT) as { state: string | null } | undefined;
    return row?.state === "waiting" || row?.state === "claimed";
  } catch { return true; /* an unreadable journal proves nothing: leave the attempt alone */ }
}

/** A Goal parked for the owner by this sweep (the replay-barrier or grant card): its latest sweep line says so and nothing started it since. */
function restingForOwnerCard(run: LongRunRecord): boolean {
  if (run.status !== "waiting_tool") return false;
  const row = getDb().prepare(`SELECT json_extract(payload_json, '$.action') AS action FROM long_run_events WHERE run_id = ? AND kind = ?
    ORDER BY seq DESC LIMIT 1`).get(run.id, BLOCKED_GOAL_SWEEP_EVENT_KIND) as { action: string | null } | undefined;
  return row?.action === REPLAY_BARRIER_OWNER_NEEDED_ACTION;
}

/** A status no process owns (defect 14): the host never rests a Goal in these, so reaching one means a transition did not finish. */
function statusWithoutOwner(run: LongRunRecord): boolean {
  // The login wall parks its Goal as waiting_user while the owner signs in: that wait is the owner of the status.
  if (run.rootChatId && browserLoginWaitOpen(run.rootChatId)) return false;
  // A verification in flight is the owner of "verifying": its verifier attempt says "running" (a controller's attempt is the other role).
  // One that has not moved for half an hour died with its process; it no longer owns anything.
  if (run.status === "verifying" && getDb().prepare(`SELECT 1 FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id = a.worker_id
    WHERE a.run_id = ? AND a.state = 'running' AND w.role = 'verifier' AND a.updated_at > ? LIMIT 1`).get(run.id, new Date(Date.now() - VERIFIER_ALIVE_MS).toISOString())) return false;
  if (["verifying", "waiting_worker", "waiting_user", "pausing"].includes(run.status)) return true;
  return run.status === "waiting_tool" && (run.blockedReason ?? null) === null && !restingForOwnerCard(run);
}

/** A cancelling Goal whose transition never finished ends as cancelled (the terminal action does not wait on anything else). */
function finishCancelling(run: LongRunRecord, trigger: string): BlockedGoalSweepResult {
  const detail = "cancelling_never_finished";
  closeGoal(run.goalId, "cancelled", "cleanup", { reason: detail });
  appendLongRunEvent({ runId: run.id, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
    payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: "cancelled", fromReason: run.blockedReason, fromStatus: run.status,
      detail, trigger: trigger.slice(0, 80), appInstanceId: desktopAppInstanceId() } });
  return { runId: run.id, fromReason: run.blockedReason, action: "cancelled", detail };
}

/**
 * Acts on the rows of the state table that sweepOne can reach here. Returns a result when the Goal is dealt with, or the (possibly
 * repaired) run to continue with. Rows that stand the Goal down answer with the same typed codes the sweep always returned.
 */
function actOnStateDecision(run: LongRunRecord, decision: HarnessDecision | null, replayBarrierCode: string | null, trigger: string,
  defer: (detail: string) => BlockedGoalSweepResult): { result: BlockedGoalSweepResult | null; run: LongRunRecord } {
  const pass = (current: LongRunRecord) => ({ result: null, run: current });
  if (!decision) return pass(run);
  switch (decision.row) {
    case "turn_live": return { result: defer("chat_busy"), run };
    case "registered_wait": return { result: defer("wait_owns_next_step"), run };
    case "replay_barrier": {
      try { return { result: parkForReplayBarrier(run, replayBarrierCode ?? "automation_replay_barrier", trigger), run }; }
      catch (error) { logSweepFailureCause("replay-barrier-park", run.id, replayBarrierCode ?? "replay_barrier", error); return { result: defer(replayBarrierCode ?? "replay_barrier"), run }; }
    }
    case "attempt_never_closed": {
      settleOrphanAttempts(run);
      // Inside the grace the attempt may belong to a turn still being prepared: this pass leaves it, the next one settles it.
      return liveLongRunAttemptCount(run.id) > 0 ? { result: defer("attempt_running"), run } : pass(getLongRun(run.id) ?? run);
    }
    case "status_without_owner": {
      // A transition in flight writes its status first: a row touched inside the grace is left for the next pass.
      if (Date.now() - Date.parse(run.updatedAt) < ORPHAN_ATTEMPT_GRACE_MS) return { result: defer("status_without_owner_grace"), run };
      try {
        let next = run;
        if (run.status === "pausing") {
          // pausing -> paused is the one edge out of it; a host pause is then the shape the sweep already schedules a retry for.
          next = transitionLongRun({ runId: run.id, to: "paused", actorKind: "host", reason: "runtime_unavailable", expectedVersion: run.version });
        } else if (run.status !== "running") {
          next = transitionLongRun({ runId: run.id, to: "running", actorKind: "host", reason: "harness-status-without-owner",
            appInstanceId: desktopAppInstanceId(), expectedVersion: run.version });
        }
        return pass(next);
      } catch (error) {
        const code = errorCode(error, "status_without_owner_unavailable");
        if (code !== "blocked_goal_sweep_state_changed") logSweepFailureCause("status-without-owner", run.id, code, error);
        return { result: defer(code), run };
      }
    }
    case "owner_stopped_pausing": case "paused_agent_domain": case "draft_is_owners_start": case "paused_budget": case "paused_approval": {
      // A pause is an edge that ends: "pausing" is the only state of it that waits for something. One that has not moved for two minutes lost the
      // process that was finishing it, and it locks the owner's own messages out (goal_stop_in_progress); it ends as "paused" with the same
      // reason the owner or the budget gave. "paused" itself, and the draft, are finished states and are left alone (defect 4).
      if (run.status === "pausing" && run.pauseReason && Date.now() - Date.parse(run.updatedAt) >= PAUSING_NEVER_FINISHED_MS) {
        try { return { result: defer(decision.row), run: transitionLongRun({ runId: run.id, to: "paused", reason: run.pauseReason, actorKind: "host", expectedVersion: run.version }) }; }
        catch (error) { const code = errorCode(error, "pausing_finish_unavailable"); if (code !== "blocked_goal_sweep_state_changed") logSweepFailureCause("pausing-finish", run.id, code, error); }
      }
      return { result: defer(decision.row), run };
    }
    default: return pass(run);
  }
}

function sweepOne(input: LongRunRecord, dispatcher: EffectObservationDispatcher, trigger: string,
  budget: { dispatches: number }): BlockedGoalSweepResult | null {
  let run = input;
  const defer = (detail: string): BlockedGoalSweepResult => ({ runId: run.id, fromReason: run.blockedReason, action: "deferred", detail });
  // A deleted room ends its Goal even when the owner had paused it: the deletion is the owner's later, terminal action, and
  // an owner-paused Goal with no room has no way back (production run_551d4283, the YouTube launch room deleted while the
  // Goal was paused: paused for 15 days, re-owned at every app start). Checked before the owner hold for that reason.
  // The two rows that end or stand down a Goal whatever else is true are the first of the cause table (harness/cause.ts): the chat is
  // gone (close), the owner stopped it (nothing), the Goal is cancelling (finish it). Terminal actions never wait on another state.
  const early = decideGoalState({ ...NO_OTHER_FACTS, status: run.status, pauseReason: run.pauseReason ?? null,
    chatGone: goalOfDeletedChat(run), ownerHold: longRunOwnerHold(run.id) });
  if (early?.action === "close" && early.row === "conversation_gone") return closeGoalOfDeletedChat(run, trigger);
  if (early?.action === "close" && early.row === "cancelling") {
    // A cancel in flight writes its status first and ends it within moments: only one that has not moved for a while never finished.
    if (Date.now() - Date.parse(run.updatedAt) < ORPHAN_ATTEMPT_GRACE_MS) return defer("cancelling_grace");
    return finishCancelling(run, trigger);
  }
  if (early?.action === "none" && early.row === "owner_stopped") return defer(LONG_RUN_OWNER_HOLD_CODE);
  // An explicit (goal-chip) Goal carries its owner grant in its recorded goal-mode turn, not in a stored revision.
  // Every resume path (effect observation, this sweep, the owner's Resume) needs the revision, so adopt it at the
  // first stop the sweep sees — before any observation is dispatched, because adopting appends a ledger event and
  // advances the run version that those paths fence on. No recorded turn → kept as is (never cancelled for it).
  if (["blocked", "paused", "waiting_tool", "queued", "running"].includes(run.status) && !getChatGoalRevision(run.goalId)) {
    if (adoptExplicitGoalGrant(run.goalId)) {
      const adopted = getLongRun(run.id);
      if (!adopted) return defer("explicit_goal_adoption_readback_failed");
      run = adopted;
    }
  }

  // Owner target changes recorded while the Goal was mid-episode are applied
  // at this stop, with the same revision+binding the Goal editor uses. A run
  // parked in waiting_tool is at a stop too when no turn is live in its chat.
  const chatLive = Boolean(run.rootChatId && chatHasLiveTurn(dispatcher, run.rootChatId));
  // Rules R-a (third caller) and R-b read what the browser ladder said while no turn is running in the room.
  if (!chatLive) { askForLadderHumanCheck(run); noteBrowserToolBreakage(run); }
  if (run.status === "blocked" || run.status === "paused" || (["waiting_tool", "queued", "running"].includes(run.status) && !chatLive)) {
    const amendment = applyPendingOwnerGoalAmendments(run.goalId, { noLiveTurn: !chatLive });
    if (amendment.applied) {
      const latest = getLongRun(run.id);
      if (!latest) return defer("owner_amendment_readback_failed");
      run = latest;
    }
  }

  // A Goal that asked the owner a question rests until the owner answers (owner 2026-10-20). Nothing here wakes it: no model
  // start, no retry, no notice. The owner's answer reopens it; an answer given where a Goal cannot reopen ends the hold below.
  if (goalOwnerAnswerHold(run.id)) {
    const released = releaseAnsweredOwnerHold(run, dispatcher);
    if (released === "stopped") return { runId: run.id, fromReason: run.blockedReason, action: "cancelled", detail: OWNER_CARD_STOP_REASON };
    if (!released) return defer(GOAL_OWNER_ANSWER_PENDING_CODE);
    run = released;
  }

  if (run.status !== "blocked") {
    let retry = pendingBlockedGoalRetry(run.id);
    // The provider named a later time than the line says (a limit the line was written before): the line moves to it, once, so the timer is
    // aimed at the time that can start something instead of asking again every minute about a line in the past (defect 13).
    if (retry && Date.parse(retry.nextAt) <= Date.now()) {
      const providerAt = goalProviderRetryNotBefore(run.id);
      if (providerAt !== null && providerAt > Date.now()) {
        try {
          scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: retry.kind, fromReason: retry.fromReason,
            retryIndex: retry.retryIndex, nextAt: new Date(providerAt).toISOString(), detail: "provider_retry_not_due", trigger,
            appInstanceId: desktopAppInstanceId() });
          run = getLongRun(run.id) ?? run;
          retry = pendingBlockedGoalRetry(run.id) ?? retry;
        } catch (error) { logSweepFailureCause("provider-line-move", run.id, errorCode(error, "provider_line_move_failed"), error); }
      }
    }
    if (retry) {
      // A retry that a previous launch put in the future stood on that launch's failure (runtime, login, update).
      // The first sweep of a new launch owes one prompt look; a repeat failure then backs off from index 0.
      // Not for a Goal whose own turn cut the app twice in a row: that wait (same_cause_backoff:host_interrupted_twice) is the ladder's, and an
      // immediate look at every start is exactly the restart loop it ends (defect 11).
      // A host-written wait that rests the Goal because the same cause failed again (waiting_tool, `same_cause_backoff:<cause>`: the six-hour wait of a limit
      // or a sign-in) is looked at once as well, not only a host pause: a relaunch or an update may have healed what failed. Every other wait keeps its time:
      // one the Goal's own turn asked for (requestedBy model), the rest the ordinary beat writes (verification_background, series_next_run) and the daily wall
      // (wake_budget_reached); pulling those made every restart a turn for each resting Goal (defect 2: 200 Goals, 48 turns in 171 s).
      const restartedRetryDue = trigger === "startup" && (run.status === "paused"
        || (run.status === "waiting_tool" && retry.requestedBy === "host" && String(retry.fromReason ?? "").startsWith(`${SAME_CAUSE_WAKE_REASON}:`)))
        && Date.parse(retry.nextAt) > Date.now()
        && !String(retry.fromReason ?? "").startsWith(`${SAME_CAUSE_WAKE_REASON}:host_interrupted`)
        && goalProviderRetryNotBefore(run.id) === null
        && !(run.rootChatId && unfinishedWakeStreak(run.id, run.rootChatId).count >= 2);
      if (goalProviderRetryNotBefore(run.id) !== null
        || (Date.parse(retry.nextAt) > Date.now() && !restartedRetryDue && !receiptOnlyRetry(run.id, retry))) {
        // The host pause at shutdown/startup does not cancel a scheduled retry: keep the app visibly waiting.
        if (run.status === "paused") {
          scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: retry.kind, fromReason: retry.fromReason,
            retryIndex: retry.retryIndex, nextAt: retry.nextAt, detail: "host_pause_carried_retry", trigger,
            appInstanceId: desktopAppInstanceId() });
        }
        return defer(`retry_at:${retry.nextAt}`);
      }
      // A turn is live in the goal's chat (the owner's own message, typically): the retry waits for it.

      // 14:38Z (goal_wait_effects_uncertain while run 89c2e879 was answering the owner's 14:35Z message).
      if (!chatLive && liveLongRunAttemptCount(run.id) > 0 && !goalTurnLive(run, dispatcher)) settleOrphanAttempts(run);
      if (chatLive || liveLongRunAttemptCount(run.id) > 0) {
        return defer("chat_busy");
      }
      if (run.rootChatId && ownerRequestWaiting(run.rootChatId, dispatcher)) return defer("owner_request_queued");
      // The idle-spin rest's time is not a reason to rerun the Goal: the owner first gets the result if it has not reached them, and
      // the Goal then waits for a signal (goal-no-progress-wait.ts). A retry a signal pulled forward still runs.
      if (settleNoProgressRest(run, retry)) return defer("no_progress_rest");
      run = reopenDueBlockedGoalRetry(run.id, run.version);
    } else if (run.status === "paused" && run.pauseReason === "runtime_unavailable") {
      // A host dispatch failure pause is not a person's decision: put it on the automatic retry schedule.
      return scheduleRetry(run, "resume", "host_dispatch_pause", trigger, { fromReason: "invocation_failed", dispatchFailed: true });
    } else if (hostPauseOfThisInstance(run, trigger)) {
      // A pause the host wrote in THIS app run (the background service's turn was cut off, its room closed under it): nothing at start will ever look
      // at it again, so it goes on the same schedule. A pause of an earlier run stays the startup check's (defect 2). Quiet: no notice.
      return scheduleRetry(run, "resume", "host_pause_same_instance", trigger, { fromReason: "invocation_failed", dispatchFailed: true, quiet: true });
    } else if (!["queued", "running"].includes(run.status) && !hostPauseRefusedThisInstance(run) && !statusWithoutOwner(run)) {
      return null;
    }
  }

  // The Goal's state, once, through the cause table (harness/cause.ts decideGoalState). What it answers is acted on here; "no row
  // decides" falls through to the arbiter and the resume below, which carry the last-turn ladders.
  const wait = latestGoalWaitSubscription(run.goalId);
  // A conversation waiting on a peer's answer (or on the owner's card for a message_send) rests too: the reply, the answer or the end of the wait is the signal.
  const registeredWait = Boolean(wait && (wait.state === "pending" || wait.state === "claimed")) || chatWaitsOnPeer(run.rootChatId);
  const turnLive = goalTurnLive(run, dispatcher);
  const replayBarrierCode = turnLive || registeredWait ? null : automaticGoalReplayBlockerCode(run.id);
  const stateDecision = decideGoalState({ status: run.status, pauseReason: run.pauseReason ?? null, chatGone: false, ownerHold: false,
    answerHold: false, grantMissing: false, replayBarrier: replayBarrierCode !== null, registeredWait, scheduledRetry: false,
    attemptRunning: !turnLive && liveLongRunAttemptCount(run.id) > 0, turnLive,
    restingOnOwnerCode: (run.blockedReason ?? null) !== null || restingForOwnerCard(run) });
  const acted = actOnStateDecision(run, stateDecision, replayBarrierCode, trigger, defer);
  if (acted.result) return acted.result;
  run = acted.run;
  if (run.rootChatId && chatHasLiveTurn(dispatcher, run.rootChatId)) return defer("chat_busy");
  // 오너 요청이 줄 서 있으면 그 요청이 먼저다 — 옛 목표를 앞질러 재개하지 않는다.
  if (run.rootChatId && dispatcher.hasQueuedOwnerRequest?.(run.rootChatId)) return defer("owner_request_queued");
  if (liveLongRunAttemptCount(run.id) > 0) return defer("attempt_running");
  // The host does not judge an earlier attempt's outside effects (owner 2026-10-12); the resumed turn checks for itself.

  // 2. Effects are settled (or absent): continue the goal itself.
  const chat = run.rootChatId ? getChat(run.rootChatId) : null;
  if (!chat || chat.goalId !== run.goalId) return scheduleRetry(run, "resume", "goal_chat_binding_missing", trigger);
  // It used to be cancelled here (goal_authority_missing) the first time it stopped — including a real owner Goal
  // paused by quitting mid-turn (reproduced 2026-09-25). An explicit Goal's grant was adopted above; one with no
  // recorded goal-mode turn (defined by IPC only) is kept as it is: the host never invents authority, and never
  // cancels an owner-defined Goal for lacking one — the owner's next message grants it.
  // Waiting for that grant is the owner's decision, not a retry: rest once, visibly, instead of a backoff loop that can
  // never succeed (production 2026-10-24 X Marketing: eight retries in 15 h, each shown as running).
  // The row "no owner instruction is recorded" of the cause table: the owner's word or Resume is the grant, one card, no retry.
  const grantRow = decideGoalState({ ...NO_OTHER_FACTS, status: run.status, pauseReason: run.pauseReason ?? null, chatGone: false,
    ownerHold: false, grantMissing: !getChatGoalRevision(run.goalId) });
  if (grantRow?.row === "grant_missing") {
    try { return parkForOwnerGrant(run, trigger); }
    catch (error) { logSweepFailureCause("owner-grant-park", run.id, GOAL_OWNER_GRANT_REQUIRED, error); return defer(GOAL_OWNER_GRANT_REQUIRED); }
  }
  if (budget.dispatches >= BLOCKED_GOAL_SWEEP_MAX_DISPATCHES) return defer("dispatch_budget");
  budget.dispatches += 1;
  const resumed = resume(run, dispatcher, trigger);
  // A slot is a model start. A Goal that lost to a live holder started nothing, so it must not keep the Goals behind it waiting.
  if (resumed.action === "deferred" && (resumed.detail === "chat_busy" || resumed.detail === RESUME_LOST_TO_LIVE_OWNER_CODE)) budget.dispatches -= 1;
  return resumed;
}

/**
 * Looks at every Goal that may need the host: called once after the startup recovery passes, when the one timer reaches the next look,
 * and when the machine wakes. Idempotent: a row that left 'blocked' is revisited only through its own ledger-recorded retry time.
 * The duties that used to ride on the minute sweep (settle a background-service turn, ask again for a judged-unavailable owner message,
 * reconcile the Goal tree) run here only at startup and wake; their signals are in long-run/goal-signals.ts.
 */
export function sweepBlockedGoals(dispatcher: EffectObservationDispatcher, trigger: BlockedGoalSweepTrigger): BlockedGoalSweepResult[] {
  try { assertDesktopLongRunAdmissionOpen(); } catch { return []; }
  // Once per start: a store with only the old schedule events gets its next-look lines (store/harness-due.ts). A second start writes nothing.
  if (trigger === "startup") {
    try { const created = backfillHarnessDue(); if (created) console.info("[long-run] harness_due lines created from old schedules", { created }); }
    catch (error) { console.warn("[blocked-goal-sweep] harness_due backfill failed:", error); }
  }
  const live = dispatcher.activeChatIds();
  sweepActiveChats = new Set(live);
  try { return sweepBlockedGoalsWithSnapshot(dispatcher, trigger, sweepActiveChats, {}); }
  finally { sweepActiveChats = null; }
}

/** Goal runs whose conversation was deleted (root_chat_id NULL): closed by the look; the deletion of a conversation is the signal. */
export function lookAtOrphanGoals(dispatcher: EffectObservationDispatcher): BlockedGoalSweepResult[] {
  try { assertDesktopLongRunAdmissionOpen(); } catch { return []; }
  sweepActiveChats = new Set(dispatcher.activeChatIds());
  try { return sweepBlockedGoalsWithSnapshot(dispatcher, "signal", sweepActiveChats, { orphansOnly: true, runningGraceMs: BLOCKED_GOAL_SIGNAL_GRACE_MS }); }
  finally { sweepActiveChats = null; }
}

/**
 * One chat's Goal, looked at now (a signal: the owner wrote there, a card was answered, a turn ended, another process settled a turn).
 * The same candidate rule and the same decisions as the full look, for the Goal runs of this chat only, with the short grace.
 */
export function lookAtGoalChat(dispatcher: EffectObservationDispatcher, chatId: string): BlockedGoalSweepResult[] {
  try { assertDesktopLongRunAdmissionOpen(); } catch { return []; }
  sweepActiveChats = new Set(dispatcher.activeChatIds());
  try {
    const results = sweepBlockedGoalsWithSnapshot(dispatcher, "signal", sweepActiveChats, { onlyChatId: chatId, runningGraceMs: BLOCKED_GOAL_SIGNAL_GRACE_MS });
    // A Goal that says "running" and changed inside the grace is left for the next look: say so, so the caller looks again when the grace is over.
    const fresh = getDb().prepare("SELECT id FROM long_runs WHERE root_chat_id = ? AND status = 'running' AND surface IN ('one','work') AND updated_at >= ? LIMIT 1")
      .get(chatId, new Date(Date.now() - BLOCKED_GOAL_SIGNAL_GRACE_MS).toISOString()) as { id: string } | undefined;
    if (fresh) results.push({ runId: fresh.id, fromReason: null, action: "deferred", detail: BLOCKED_GOAL_RUNNING_GRACE_DETAIL });
    return results;
  } finally { sweepActiveChats = null; }
}

/**
 * The rooms a teammate works in: a member or a teammate of a room runs its turns in a child chat of it (kind "division"), and the room's own
 * chat is idle meanwhile. The Goal of such a room is not ownerless (#10: rule R-c started a second turn in the room beside the
 * teammate's work). One query over the live chats, made in the sweep's one read of them.
 */
function roomsWithLiveChildTurns(live: readonly string[]): Set<string> {
  if (!live.length) return new Set();
  try {
    const rows = getDb().prepare(`SELECT DISTINCT parent_chat_id AS id FROM chats WHERE kind = 'division' AND parent_chat_id IS NOT NULL
      AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(live)) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  } catch { return new Set(); }
}

function sweepBlockedGoalsWithSnapshot(dispatcher: EffectObservationDispatcher, trigger: BlockedGoalSweepTrigger, active: ReadonlySet<string>,
  scope: { onlyChatId?: string; orphansOnly?: boolean; runningGraceMs?: number }): BlockedGoalSweepResult[] {
  const busyRooms = roomsWithLiveChildTurns([...active]);
  const dutiesRide = trigger === "startup" || trigger === "wake" || trigger === "periodic";
  // First, close the Goals whose only run was a background-service turn that has ended: below, a queued Goal is a resume
  // candidate, and resuming one whose work already finished would redo it.
  if (dutiesRide) try { settleDaemonTurnGoals(); } catch (error) { console.warn("[blocked-goal-sweep] service-turn Goals could not be settled:", error); }
  // An owner message the judge could not answer earlier is asked again (bounded backoff); a restated target then reaches
  // the pending-amendment path below instead of staying unclassified for ever.
  if (dutiesRide) try { sweepUnavailableOwnerGoalReviews(); } catch (error) { console.warn("[blocked-goal-sweep] unanswered owner reviews could not be re-asked:", error); }
  // Contracts and tasks still open under an ended Goal run take that run's outcome (idempotent; one ledger event per repair).
  // Every close goes through closeGoal now (store/goal-close.ts), so this pass only heals what a build before N4 left: once, at start.
  if (trigger === "startup") try {
    const repaired = reconcileGoalTree();
    if (repaired.length) console.info("[blocked-goal-sweep] goal tree reconciled", JSON.stringify(repaired.map((row) => ({ runId: row.runId, repair: row.repair }))));
  } catch (error) { console.warn("[blocked-goal-sweep] goal tree reconcile failed:", error); }
  const results: BlockedGoalSweepResult[] = [];
  const budget = { dispatches: 0 };
  // The per-sweep dispatch budget is first come, first served, so the order is the fairness rule. Id order always
  // put the same Goals first and starved the rest (a Work Goal sorted last behind four One Goals, measured on the
  // owner's DB 2026-10-03). Longest-waiting first; the id breaks ties so the order stays deterministic.
  const candidates: Array<{ id: string; updatedAt: string; rootChatId?: string | null }> = [];
  // Rule R-c: a Goal that says "running" with no turn, no schedule and no registered wait has no owner (a next-step schedule that threw, a
  // permission-raise approval whose next turn was refused). It is a candidate whether or not the sweep ever recorded it; sweepOne and
  // resume already pass over a live turn, another process's lease, a schedule and a registered wait. A Goal that changed less than one
  // sweep interval ago is skipped once (its own start may still be in flight), so a healthy Goal is never started twice.
  const runningStaleBefore = new Date(Date.now() - (scope.runningGraceMs ?? BLOCKED_GOAL_SWEEP_INTERVAL_MS)).toISOString();
  const onlyChat = scope.onlyChatId ?? null, orphansOnly = scope.orphansOnly ? 1 : 0;
  let afterId = "";
  while (true) {
    const rows = getDb().prepare(`SELECT id, updated_at AS updatedAt, status, root_chat_id AS rootChatId FROM long_runs WHERE id > ?
      AND (? IS NULL OR root_chat_id = ?) AND (? = 0 OR root_chat_id IS NULL)
      AND surface IN ('one','work') AND execution_location = 'desktop-local' AND host_owner_kind = 'desktop'
      AND (status IN ('blocked','queued')
        OR (status = 'paused' AND pause_reason IN ('runtime_unavailable','app_closed','crash_recovery'))
        OR (status = 'waiting_tool' AND blocked_reason = ?)
        OR (root_chat_id IS NULL AND status IN ('draft','paused','pausing','cancelling','waiting_tool','waiting_worker','waiting_user','verifying','running'))
        OR status IN ('verifying','waiting_worker','waiting_user','pausing','cancelling')
        OR (status = 'waiting_tool' AND blocked_reason IS NULL AND COALESCE((SELECT json_extract(e.payload_json,'$.subscription.state') FROM long_run_events e
          WHERE e.run_id = long_runs.id AND e.kind = 'run.wait_subscription' ORDER BY e.seq DESC LIMIT 1), '') NOT IN ('pending','claimed'))
        OR (status = 'running' AND updated_at < ?)
        OR (status IN ('waiting_tool','running') AND EXISTS (SELECT 1 FROM long_run_events e WHERE e.run_id = long_runs.id AND e.kind IN (?, ?))))
      ORDER BY id LIMIT 100`
      ).all(afterId, onlyChat, onlyChat, orphansOnly, GOAL_OWNER_ANSWER_REQUIRED, runningStaleBefore, BLOCKED_GOAL_SWEEP_EVENT_KIND, OWNER_GOAL_AMENDMENT_PENDING_KIND) as Array<{ id: string; updatedAt: string; status: string; rootChatId: string | null }>;
    if (!rows.length) break;
    // A "running" Goal whose room has a turn (its own, or a teammate's in a child chat) is healthy: nothing to read for it (#9, #10).
    candidates.push(...rows.filter((row) => !(["running", "verifying", "waiting_worker", "waiting_user"].includes(row.status) && row.rootChatId
      && (active.has(row.rootChatId) || busyRooms.has(row.rootChatId)))));
    afterId = rows[rows.length - 1].id;
  }
  candidates.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  try {
    const chatIds = [...new Set(candidates.map((row) => row.rootChatId).filter((id): id is string => Boolean(id)))];
    sweepLadderChats = new Set();
    if (chatIds.length) {
      const rows = getDb().prepare(`SELECT DISTINCT chat_id AS id FROM run_events WHERE kind = 'browser_fallback_ladder' AND ts >= ?
        AND json_extract(payload_json, '$.step') = 'final' AND chat_id IN (SELECT value FROM json_each(?))`)
        .all(new Date(Date.now() - 24 * 60 * 60_000).toISOString(), JSON.stringify(chatIds)) as Array<{ id: string }>;
      for (const row of rows) sweepLadderChats.add(row.id);
    }
  } catch { sweepLadderChats = null; /* an unreadable table: each rule reads for itself */ }
  try {
  for (const { id } of candidates) {
    try {
      assertDesktopLongRunAdmissionOpen();
      const run = getLongRun(id);
      if (!run) continue;
      const result = sweepOne(run, dispatcher, trigger, budget);
      if (result) results.push(result);
    } catch (error) {
      results.push({ runId: id, fromReason: null, action: "deferred", detail: errorCode(error, "blocked_goal_sweep_failed") });
    }
  }
  } finally { sweepLadderChats = null; }
  return results;
}

/**
 * Event-driven half of the project wait: called when a turn in a Work project settles. Goals of that
 * project that were refused as work_project_residency_busy continue now instead of on the next minute tick.
 */
export function resumeGoalsWaitingOnProject(dispatcher: EffectObservationDispatcher, projectId: string): BlockedGoalSweepResult[] {
  try { assertDesktopLongRunAdmissionOpen(); } catch { return []; }
  const rows = getDb().prepare(`SELECT l.id FROM long_runs AS l JOIN chats AS c ON c.id = l.root_chat_id
    WHERE l.status IN ('blocked','queued') AND l.blocked_reason = ? AND c.project_id = ?
      AND l.surface IN ('one','work') AND l.execution_location = 'desktop-local' AND l.host_owner_kind = 'desktop'
    ORDER BY l.updated_at LIMIT 10`).all(WORK_PROJECT_RESIDENCY_BUSY_CODE, projectId) as Array<{ id: string }>;
  const results: BlockedGoalSweepResult[] = [];
  const budget = { dispatches: BLOCKED_GOAL_SWEEP_MAX_DISPATCHES - 1 }; // one successor: the project admits one turn
  for (const { id } of rows) {
    try {
      const run = getLongRun(id);
      if (!run) continue;
      const result = sweepOne(run, dispatcher, "project-released", budget);
      if (result) results.push(result);
      if (result?.action === "resumed") break;
    } catch (error) {
      results.push({ runId: id, fromReason: null, action: "deferred", detail: errorCode(error, "blocked_goal_sweep_failed") });
    }
  }
  return results;
}
