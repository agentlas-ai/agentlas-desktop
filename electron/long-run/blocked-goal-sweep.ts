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
import { appendChatMessage, getChat } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { invocationRunOwners } from "../store/invocation-run-owners";
import {
  appendLongRunEvent, bindCurrentGoalRevisionToLongRun, getLongRun, liveLongRunAttemptCount, nextBlockedGoalRetrySlot,
  pendingBlockedGoalRetry, reopenDueBlockedGoalRetry, scheduleBlockedGoalRetry, transitionLongRun,
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
import { followDaemonTurnGoal, settleDaemonTurnGoals, type DaemonTurnGoalResult } from "./daemon-turn-goal";
import { reconcileGoalTree } from "./goal-tree-reconcile";
import { type EffectObservationDispatcher } from "./effect-observation-tickets";
import { currentUiLocale } from "../ui-locale";
import { decideGoalContinuationWake, ownerRequestWaiting, recordGoalWake, SAME_CAUSE_WAKE_REASON, type GoalWakeSource } from "./wake-arbiter";
import { GOAL_OWNER_ANSWER_REQUIRED, GOAL_OWNER_GRANT_REQUIRED } from "../../shared/goal-display-state";
import { WORK_PROJECT_RESIDENCY_BUSY_CODE } from "../runtime/project-residency";

export type BlockedGoalSweepAction = "observation_dispatched" | "resumed" | "retry_scheduled" | "cancelled" | "deferred";

export interface BlockedGoalSweepResult {
  runId: string;
  fromReason: string | null;
  action: BlockedGoalSweepAction;
  detail: string;
}

/** Model runs a single sweep may start; the rest wait for the next pass instead of bursting at boot. */
export const BLOCKED_GOAL_SWEEP_MAX_DISPATCHES = 4;

/** How often the running app sweeps. Retries themselves are spaced by their own backoff. */
export const BLOCKED_GOAL_SWEEP_INTERVAL_MS = 60_000;

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
  try {
    appendChatMessage(run.rootChatId, "assistant", currentUiLocale() === "ko" ? ko : en,
      { hostNotice: { purpose: "host-status", runId, status } });
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
  options: { fromReason?: string | null; dispatchFailed?: boolean } = {}): BlockedGoalSweepResult {
  const slot = nextBlockedGoalRetrySlot(run.id);
  scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind,
    fromReason: options.fromReason !== undefined ? options.fromReason : run.blockedReason,
    retryIndex: slot.retryIndex, nextAt: slot.nextAt, detail,
    trigger: options.dispatchFailed ? `dispatch-failed:${trigger}` : trigger,
    appInstanceId: desktopAppInstanceId() });
  if (slot.retryIndex === 0) {
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
function replayBarrierToldFor(runId: string, code: string): boolean {
  const row = getDb().prepare(`SELECT json_extract(payload_json, '$.action') AS action, json_extract(payload_json, '$.detail') AS detail
    FROM long_run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1`)
    .get(runId, BLOCKED_GOAL_SWEEP_EVENT_KIND) as { action: string | null; detail: string | null } | undefined;
  return row?.action === REPLAY_BARRIER_OWNER_NEEDED_ACTION && row.detail === code;
}
function parkForReplayBarrier(run: LongRunRecord, code: string, trigger: string): BlockedGoalSweepResult {
  const told = replayBarrierToldFor(run.id, code);
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
  if (!told) notify(latest, "effect-retrying", "앞 작업 결과를 확인하지 못해 자동으로 이어가지 않았어요. 이어가기를 누르면 계속합니다.",
    "I could not confirm the result of the earlier step, so I did not continue on my own. Press Resume to continue.");
  return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: code };
}

/**
 * A Goal with no recorded owner grant rests in waiting_tool carrying GOAL_OWNER_GRANT_REQUIRED (shared/goal-display-state.ts):
 * shown as "needs you" with a working Resume (the press is the grant, ipc chats:resumeGoal), never as running, and with no
 * retry schedule. One notice per Goal. Any status transition (the owner's Resume or message) clears the code.
 */
function parkForOwnerGrant(run: LongRunRecord, trigger: string): BlockedGoalSweepResult {
  const told = replayBarrierToldFor(run.id, GOAL_OWNER_GRANT_REQUIRED);
  const parked = getDb().transaction(() => {
    const current = getLongRun(run.id);
    if (!current || current.version !== run.version) throw new Error("blocked_goal_sweep_state_changed");
    if (current.status === "waiting_tool" && current.blockedReason === GOAL_OWNER_GRANT_REQUIRED) return current;
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
  if (!told) notify(parked, "effect-retrying",
    "이 목표는 오너 지시 기록 없이 만들어져 아직 시작하지 않았어요. 목표 칩의 이어가기를 누르거나 이 방에 말씀하시면 바로 이어갑니다.",
    "This goal was set up without an instruction from you, so it has not started. Press Resume on the goal chip or send a message here and it continues.");
  return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: GOAL_OWNER_GRANT_REQUIRED };
}

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
  // Every resume path (sweep, Alive's continue, a released project) asks the one wake policy: the owner first,
  // then the daily barrier. A reached barrier parks the Goal until its window frees, visibly.
  const source: GoalWakeSource = trigger === "alive" ? "alive" : trigger === "project-released" ? "project-released"
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
        if (!now || getChat(chatId)?.goalId !== run.goalId || dispatcher.activeChatIds().includes(chatId)
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
  if (run.rootChatId || run.surface === "science") return false;
  const held = getDb().prepare("SELECT 1 FROM chats WHERE goal_id = ? LIMIT 1").get(run.goalId);
  return !held;
}

function closeGoalOfDeletedChat(run: LongRunRecord, trigger: string): BlockedGoalSweepResult {
  const detail = "goal_chat_deleted";
  if (liveLongRunAttemptCount(run.id) > 0) return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: "attempt_running" };
  let closed = transitionLongRun({ runId: run.id, actorKind: "host", reason: detail,
    to: ["draft", "paused", "blocked"].includes(run.status) ? "cancelled" : "cancelling" });
  if (closed.status === "cancelling") closed = transitionLongRun({ runId: run.id, to: "cancelled", actorKind: "host", reason: detail });
  appendLongRunEvent({ runId: run.id, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
    payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: "cancelled", fromReason: run.blockedReason, fromStatus: run.status,
      detail, trigger: trigger.slice(0, 80), appInstanceId: desktopAppInstanceId() } });
  return { runId: run.id, fromReason: run.blockedReason, action: "cancelled", detail };
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
  if (dispatcher.activeChatIds().includes(chatId) || ownerRequestWaiting(chatId, dispatcher)) return null;
  const since = goalOwnerAnswerPendingSince(run.id);
  if (!since) return null;
  const spoke = getDb().prepare("SELECT text FROM chat_messages WHERE chat_id = ? AND role = 'user' AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(chatId, since) as { text: string } | undefined;
  if (!spoke) return null;
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

function sweepOne(input: LongRunRecord, dispatcher: EffectObservationDispatcher, trigger: string,
  budget: { dispatches: number }): BlockedGoalSweepResult | null {
  let run = input;
  const defer = (detail: string): BlockedGoalSweepResult => ({ runId: run.id, fromReason: run.blockedReason, action: "deferred", detail });
  // A deleted room ends its Goal even when the owner had paused it: the deletion is the owner's later, terminal action, and
  // an owner-paused Goal with no room has no way back (production run_551d4283, the YouTube launch room deleted while the
  // Goal was paused: paused for 15 days, re-owned at every app start). Checked before the owner hold for that reason.
  if (goalOfDeletedChat(run)) return closeGoalOfDeletedChat(run, trigger);
  // An owner/user pause is a boundary: no observation, retry or resume until the owner resumes it.
  if (longRunOwnerHold(run.id)) return defer(LONG_RUN_OWNER_HOLD_CODE);
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
  const chatLive = Boolean(run.rootChatId && dispatcher.activeChatIds().includes(run.rootChatId));
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
    const retry = pendingBlockedGoalRetry(run.id);
    if (retry) {
      // A retry that a previous launch put in the future stood on that launch's failure (runtime, login, update).
      // The first sweep of a new launch owes one prompt look; a repeat failure then backs off from index 0.
      const restartedRetryDue = trigger === "startup" && run.status === "paused" && Date.parse(retry.nextAt) > Date.now();
      if (Date.parse(retry.nextAt) > Date.now() && !restartedRetryDue && !receiptOnlyRetry(run.id, retry)) {
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
      if (chatLive || liveLongRunAttemptCount(run.id) > 0) {
        return defer("chat_busy");
      }
      run = reopenDueBlockedGoalRetry(run.id, run.version);
    } else if (run.status === "paused" && run.pauseReason === "runtime_unavailable") {
      // A host dispatch failure pause is not a person's decision: put it on the automatic retry schedule.
      return scheduleRetry(run, "resume", "host_dispatch_pause", trigger, { fromReason: "invocation_failed", dispatchFailed: true });
    } else if (!["queued", "running"].includes(run.status) && !hostPauseRefusedThisInstance(run)) {
      return null;
    }
  }

  const wait = latestGoalWaitSubscription(run.goalId);
  if (wait && (wait.state === "pending" || wait.state === "claimed")) return defer("wait_owns_next_step");
  if (run.rootChatId && dispatcher.activeChatIds().includes(run.rootChatId)) return defer("chat_busy");
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
  if (!getChatGoalRevision(run.goalId)) {
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

/** Host pauses an Alive orchestrator may continue. An owner pause, an approval hold and a budget stop never are.
 * One definition, shared with the AGI classifier (shared/goal-continuation.ts). */
export { ALIVE_CONTINUABLE_PAUSE_REASONS } from "../../shared/goal-continuation";
import { ALIVE_CONTINUABLE_PAUSE_REASONS } from "../../shared/goal-continuation";

/**
 * Why continueGoalForAlive would defer this Goal before trying anything (null = it would try now). A pure read, so a caller
 * can skip asking: the AGI unblocker started a work turn on every attempt and the host deferred 7,841 of 7,888 of them
 * (alive_goal_not_continuable 5,119, retry_owns_next_step 2,714; production to 2026-10-20). A null answer is not a promise:
 * sweepOne and resume keep their own guards.
 */
export function aliveGoalContinuationRefusal(runId: string, expectedVersion: number): string | null {
  try { assertDesktopLongRunAdmissionOpen(); } catch { return "desktop_long_run_admission_closed"; }
  const run = getLongRun(runId);
  if (!run || run.version !== expectedVersion || (run.surface !== "one" && run.surface !== "work")
    || run.executionLocation !== "desktop-local" || run.hostOwnerKind !== "desktop") return "alive_goal_state_changed";
  if (longRunOwnerHold(run.id)) return LONG_RUN_OWNER_HOLD_CODE;
  if (goalOwnerAnswerHold(run.id)) return GOAL_OWNER_ANSWER_PENDING_CODE;
  if (run.status === "blocked") return null;
  // A host-scheduled retry owns the next step and its spacing. Isolated live run 2026-09-24: letting the
  // orchestrator bring a pending effect-observation retry forward turned the sweep's growing backoff into a
  // ~30s loop (21 observation runs in 10 minutes, each inconclusive). A historical
  // receipt-only host hold is obsolete; actual retry spacing remains owned here.
  const pendingRetry = pendingBlockedGoalRetry(run.id);
  if (pendingRetry) return receiptOnlyRetry(run.id, pendingRetry) ? null : "retry_owns_next_step";
  if (run.status !== "paused" || !ALIVE_CONTINUABLE_PAUSE_REASONS.has(run.pauseReason ?? "")) return "alive_goal_not_continuable";
  return null;
}

/**
 * The Alive One/Work orchestrator's `goal.continue` — the same continuation path this sweep uses, for one Goal,
 * now, instead of waiting for the next periodic pass. It adds no new way to resume:
 *  - a blocked Goal goes through sweepOne (QA/workspace end rules, owner amendments, effect observation before
 *    any resume, cancel rules, scheduled retries);
 *  - a paused Goal is continued only for a host pause (ALIVE_CONTINUABLE_PAUSE_REASONS) and with the same
 *    guards (observation in flight, wait subscription, busy chat, running attempt, chat binding, stored grant).
 * The fence (runId + version) is re-read here: a stale proposal is deferred, never applied to a newer state.
 */
export function continueGoalForAlive(runId: string, expectedVersion: number, dispatcher: EffectObservationDispatcher): BlockedGoalSweepResult {
  const deferred = (detail: string, fromReason: string | null = null): BlockedGoalSweepResult =>
    ({ runId, fromReason, action: "deferred", detail });
  const refusal = aliveGoalContinuationRefusal(runId, expectedVersion);
  if (refusal) return deferred(refusal, refusal === "desktop_long_run_admission_closed" ? null : getLongRun(runId)?.blockedReason ?? null);
  const run = getLongRun(runId)!;
  const budget = { dispatches: 0 };
  // A Goal parked while its service turn ran on belongs to that turn first (daemon-turn-goal.ts; the sweep settles it before it
  // looks for candidates, this entry point does not go through the sweep): resuming it here would start a second episode over
  // work the service already did, or over the turn that is still running.
  if (run.status === "paused") {
    let followed: DaemonTurnGoalResult | null = null;
    try { followed = followDaemonTurnGoal(run.goalId); } catch { /* the sweep's own settle pass tries again */ }
    if (followed && followed.action !== "skipped") return deferred(followed.action === "unchanged" ? "service_turn_live" : "service_turn_settled");
  }
  if (run.status === "blocked") return sweepOne(run, dispatcher, "alive", budget) ?? deferred("alive_goal_not_continuable", run.blockedReason);
  if (pendingBlockedGoalRetry(run.id)) return sweepOne(run, dispatcher, "alive", budget) ?? deferred("alive_goal_not_continuable", run.blockedReason);
  // A host pause the sweep already owns (runtime_unavailable → scheduled retry, refused startup pause) goes its way.
  const swept = sweepOne(run, dispatcher, "alive", budget);
  if (swept) return swept;
    const wait = latestGoalWaitSubscription(run.goalId);
  if (wait && (wait.state === "pending" || wait.state === "claimed")) return deferred("wait_owns_next_step");
  if (run.rootChatId && dispatcher.activeChatIds().includes(run.rootChatId)) return deferred("chat_busy");
  if (liveLongRunAttemptCount(run.id) > 0) return deferred("attempt_running");
  const chat = run.rootChatId ? getChat(run.rootChatId) : null;
  if (!chat || chat.goalId !== run.goalId) return deferred("alive_goal_binding_missing");
  if (!getChatGoalRevision(run.goalId)) {
    if (!adoptExplicitGoalGrant(run.goalId)) return deferred("goal_owner_grant_unrecorded");
    const adopted = getLongRun(run.id);
    if (!adopted) return deferred("alive_goal_state_changed");
    return resume(adopted, dispatcher, "alive");
  }
  return resume(run, dispatcher, "alive");
}

/**
 * Called once after the startup recovery passes, and every BLOCKED_GOAL_SWEEP_INTERVAL_MS while the app runs, so
 * a Goal that stops later is not left there either. Idempotent: a row that left 'blocked' is revisited only through
 * its own ledger-recorded retry time.
 */
export function sweepBlockedGoals(dispatcher: EffectObservationDispatcher, trigger: "startup" | "periodic"): BlockedGoalSweepResult[] {
  try { assertDesktopLongRunAdmissionOpen(); } catch { return []; }
  // First, close the Goals whose only run was a background-service turn that has ended: below, a queued Goal is a resume
  // candidate, and resuming one whose work already finished would redo it.
  try { settleDaemonTurnGoals(); } catch (error) { console.warn("[blocked-goal-sweep] service-turn Goals could not be settled:", error); }
  // An owner message the judge could not answer earlier is asked again (bounded backoff); a restated target then reaches
  // the pending-amendment path below instead of staying unclassified for ever.
  try { sweepUnavailableOwnerGoalReviews(); } catch (error) { console.warn("[blocked-goal-sweep] unanswered owner reviews could not be re-asked:", error); }
  // Contracts and tasks still open under an ended Goal run take that run's outcome (idempotent; one ledger event per repair).
  try {
    const repaired = reconcileGoalTree();
    if (repaired.length) console.info("[blocked-goal-sweep] goal tree reconciled", JSON.stringify(repaired.map((row) => ({ runId: row.runId, repair: row.repair }))));
  } catch (error) { console.warn("[blocked-goal-sweep] goal tree reconcile failed:", error); }
  const results: BlockedGoalSweepResult[] = [];
  const budget = { dispatches: 0 };
  // The per-sweep dispatch budget is first come, first served, so the order is the fairness rule. Id order always
  // put the same Goals first and starved the rest (a Work Goal sorted last behind four One Goals, measured on the
  // owner's DB 2026-10-03). Longest-waiting first; the id breaks ties so the order stays deterministic.
  const candidates: Array<{ id: string; updatedAt: string }> = [];
  let afterId = "";
  while (true) {
    const rows = getDb().prepare(`SELECT id, updated_at AS updatedAt FROM long_runs WHERE id > ?
      AND surface IN ('one','work') AND execution_location = 'desktop-local' AND host_owner_kind = 'desktop'
      AND (status IN ('blocked','queued')
        OR (status = 'paused' AND pause_reason IN ('runtime_unavailable','app_closed','crash_recovery'))
        OR (status = 'waiting_tool' AND blocked_reason = ?)
        OR (root_chat_id IS NULL AND status IN ('draft','paused','pausing','waiting_tool','waiting_worker','waiting_user','verifying','running'))
        OR (status IN ('waiting_tool','running') AND EXISTS (SELECT 1 FROM long_run_events e WHERE e.run_id = long_runs.id AND e.kind IN (?, ?))))
      ORDER BY id LIMIT 100`).all(afterId, GOAL_OWNER_ANSWER_REQUIRED, BLOCKED_GOAL_SWEEP_EVENT_KIND, OWNER_GOAL_AMENDMENT_PENDING_KIND) as Array<{ id: string; updatedAt: string }>;
    if (!rows.length) break;
    candidates.push(...rows);
    afterId = rows[rows.length - 1].id;
  }
  candidates.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
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
