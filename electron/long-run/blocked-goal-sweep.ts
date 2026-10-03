/** Recover idle Goals through fresh current-context episodes. Checkpoint and
 * effect failures are advisory facts; only an explicit owner hold stops work.
 * Retry spacing still prevents unavailable runtimes from spinning. */
import { applyPendingOwnerGoalAmendments, OWNER_GOAL_AMENDMENT_PENDING_KIND } from "./goal-owner-amendment";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { adoptExplicitGoalGrant } from "./explicit-goal-authority";
import { appendChatMessage, getChat } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import {
  appendLongRunEvent, bindCurrentGoalRevisionToLongRun, getLongRun, getLongRunAttemptReview, liveLongRunAttemptCount, nextBlockedGoalRetrySlot,
  pendingBlockedGoalRetry, reopenDueBlockedGoalRetry, committedTurnSinceRetry, settleDueBoundaryRetryByTurn, scheduleBlockedGoalRetry, transitionLongRun,
  BLOCKED_GOAL_SWEEP_EVENT_KIND, BLOCKED_GOAL_SWEEP_SCHEMA, type LongRunRecord,
  longRunOwnerHold, LONG_RUN_OWNER_HOLD_CODE,
} from "../store/long-runs";
import { automaticGoalResumeRequest } from "../invocation/automatic-goal";
import {
  assertDesktopLongRunAdmissionOpen, confirmDesktopLongRunResumeDispatched, desktopAppInstanceId,
  failDesktopLongRunResumeDispatch,
} from "./app-runtime-coordinator";
import { latestGoalWaitSubscription } from "./wait-subscriptions";
import { isEffectUncertainBlockReason, maybeDispatchEffectObservation, sweepDueGoalEffectObservations } from "./effect-observation";
import { type EffectObservationDispatcher } from "./effect-observation-tickets";
import { currentUiLocale } from "../ui-locale";
import { holdingAgentResidency } from "../runtime/agent-residency";
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
function notify(run: LongRunRecord, status: "goal-resuming" | "goal-closed" | "effect-retrying", ko: string, en: string, runId: string = run.id): void {
  if (!run.rootChatId) return;
  try {
    appendChatMessage(run.rootChatId, "assistant", currentUiLocale() === "ko" ? ko : en,
      { hostNotice: { purpose: "host-status", runId, status } });
  } catch (error) {
    console.warn("[blocked-goal-sweep] chat notice failed:", error);
  }
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[a-z_]+(?::[a-z_0-9-]+)?$/.test(error.message) ? error.message : fallback;
}

function scheduleRetry(run: LongRunRecord, kind: "observe" | "resume", detail: string, trigger: string,
  options: { effectUncertain: boolean; fromReason?: string | null; dispatchFailed?: boolean }): BlockedGoalSweepResult {
  const slot = nextBlockedGoalRetrySlot(run.id);
  scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind,
    fromReason: options.fromReason !== undefined ? options.fromReason : run.blockedReason,
    retryIndex: slot.retryIndex, nextAt: slot.nextAt, detail,
    trigger: options.dispatchFailed ? `dispatch-failed:${trigger}` : trigger,
    effectUncertain: options.effectUncertain, appInstanceId: desktopAppInstanceId() });
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
 * Another turn in the same Work project holds its provider (the admission that refused this Goal's turn
 * with work_project_residency_busy). Measured 2026-09-24: two Goals in one project made the sweep resume
 * the waiting one every 60 s, fail again, and post the same "continuing" notice each time.
 */
export function projectHeldByAnotherTurn(run: LongRunRecord, dispatcher: EffectObservationDispatcher): boolean {
  const projectId = run.rootChatId ? getChat(run.rootChatId)?.projectId ?? null : null;
  if (!projectId) return false;
  if (holdingAgentResidency().some((entry) => entry.projectId === projectId && entry.inUse && entry.chatId !== run.rootChatId)) return true;
  return dispatcher.activeChatIds().some((chatId) => chatId !== run.rootChatId && getChat(chatId)?.projectId === projectId);
}

/** The previous sweep resume of this run was for the same blocked cause: the person was already told. */
function alreadyToldForCause(run: LongRunRecord): boolean {
  const row = getDb().prepare(`SELECT json_extract(payload_json, '$.fromReason') AS reason FROM long_run_events
    WHERE run_id = ? AND kind = ? AND json_extract(payload_json, '$.action') = 'resumed' ORDER BY seq DESC LIMIT 1`)
    .get(run.id, BLOCKED_GOAL_SWEEP_EVENT_KIND) as { reason: string | null } | undefined;
  return Boolean(row && run.blockedReason && row.reason === run.blockedReason);
}

function resume(run: LongRunRecord, dispatcher: EffectObservationDispatcher, trigger: string): BlockedGoalSweepResult {
  const toldBefore = alreadyToldForCause(run);
  const chatId = run.rootChatId!;
  let prepared: { request: NonNullable<ReturnType<typeof automaticGoalResumeRequest>>; queuedId: string } | null = null;
  let current = run;
  for (let pass = 0; pass < 2 && !prepared; pass += 1) {
    try {
      prepared = getDb().transaction(() => {
        const latest = getLongRun(current.id);
        if (!latest || latest.version !== current.version || !["blocked", "paused", "queued", "running", "waiting_tool"].includes(latest.status)) {
          throw new Error("blocked_goal_sweep_state_changed");
        }
        const request = automaticGoalResumeRequest(chatId, latest.version, "host");
        if (!request) throw new Error("long_run_resume_dispatch_unavailable");
        getDb().prepare("UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ? WHERE goal_id = ? AND status = 'blocked'")
          .run(new Date().toISOString(), latest.goalId);
        const queued = transitionLongRun({ runId: latest.id, to: "queued", actorKind: "host", reason: "blocked-sweep-resume",
          appInstanceId: desktopAppInstanceId(), expectedVersion: latest.version });
        appendLongRunEvent({ runId: latest.id, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
          payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: "resumed", fromReason: run.blockedReason,
            fromStatus: run.status, trigger: trigger.slice(0, 80), appInstanceId: desktopAppInstanceId() } });
        return { request: { ...request, runId: randomUUID() }, queuedId: queued.id };
      })();
    } catch (error) {
      const code = errorCode(error, "blocked_goal_resume_unavailable");
      const latest = getLongRun(run.id);
      if (!latest || code === "blocked_goal_sweep_state_changed" || !["blocked", "paused", "queued", "running", "waiting_tool"].includes(latest.status)) {
        return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: code };
      }
      // An edited Goal whose new revision was never bound: bind it (the same binder the chip uses), then retry once.
      if (code === "auto_goal_resume_revision_pending" && pass === 0) {
        try { current = bindCurrentGoalRevisionToLongRun(latest.id, latest.version); continue; }
        catch { /* fall through to a scheduled retry */ }
      }
      const effectQuestion = code === "auto_goal_resume_attempt_unsettled" || isEffectUncertainBlockReason(latest.blockedReason)
        || code === "goal_wait_claimed_reconciliation_required" || code === "goal_resume_effect_boundary_uncertain";
      return scheduleRetry(latest, "resume", code, trigger, { effectUncertain: effectQuestion });
    }
  }
  if (!prepared) return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: "blocked_goal_resume_unavailable" };
  // Once per blocked cause: a repeat of the same stop is not news to the person.
  if (!toldBefore) notify(run, "goal-resuming", "멈춰 있던 목표를 원래 권한과 예산 그대로 다시 이어갑니다. 결과는 끝나면 다시 검증합니다.",
    "Continuing the stopped goal with its original permissions and budget. The result is verified again when it finishes.",
    prepared.request.runId ?? run.id);
  try {
    dispatcher.start(prepared.request, undefined, undefined, undefined, "goal-continuation");
    confirmDesktopLongRunResumeDispatched(prepared.queuedId);
    return { runId: run.id, fromReason: run.blockedReason, action: "resumed", detail: prepared.request.runId ?? "dispatched" };
  } catch (error) {
    const code = errorCode(error, "blocked_goal_dispatch_failed");
    try { failDesktopLongRunResumeDispatch(prepared.queuedId, code); } catch { /* keep the original dispatch failure */ }
    const latest = getLongRun(run.id);
    if (!latest) return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: code };
    return scheduleRetry(latest, "resume", code, trigger, { effectUncertain: false, fromReason: run.blockedReason, dispatchFailed: true });
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

function sweepOne(input: LongRunRecord, dispatcher: EffectObservationDispatcher, trigger: string,
  budget: { dispatches: number }): BlockedGoalSweepResult | null {
  let run = input;
  const defer = (detail: string): BlockedGoalSweepResult => ({ runId: run.id, fromReason: run.blockedReason, action: "deferred", detail });
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

  let epoch = 0;
  if (run.status !== "blocked") {
    const retry = pendingBlockedGoalRetry(run.id);
    if (retry) {
      // A retry that a previous launch put in the future stood on that launch's failure (runtime, login, update).
      // The first sweep of a new launch owes one prompt look; a repeat failure then backs off from index 0.
      const restartedRetryDue = trigger === "startup" && run.status === "paused" && Date.parse(retry.nextAt) > Date.now();
      if (Date.parse(retry.nextAt) > Date.now() && !restartedRetryDue) {
        // The host pause at shutdown/startup does not cancel a scheduled retry: keep the app visibly waiting.
        if (run.status === "paused") {
          scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: retry.kind, fromReason: retry.fromReason,
            retryIndex: retry.retryIndex, nextAt: retry.nextAt, detail: "host_pause_carried_retry", trigger,
            effectUncertain: retry.effectUncertain, appInstanceId: desktopAppInstanceId() });
        }
        return defer(`retry_at:${retry.nextAt}`);
      }
      // A turn is live in the goal's chat (the owner's own message, typically): the retry waits for it.

      // 14:38Z (goal_wait_effects_uncertain while run 89c2e879 was answering the owner's 14:35Z message).
      if (chatLive || liveLongRunAttemptCount(run.id) > 0) {
        return defer("chat_busy");
      }
      // A turn that ran after this effect-uncertain retry was scheduled and committed is newer evidence than
      // any look: settle the boundary and take the ordinary resume path, instead of re-blocking on it.
      const settledBy = retry.kind === "observe" && isEffectUncertainBlockReason(retry.fromReason)
        && getLongRunAttemptReview(run.id).attempts.length === 0 ? committedTurnSinceRetry(run.id, retry.seq) : null;
      run = settledBy ? settleDueBoundaryRetryByTurn(run.id, run.version, settledBy) : reopenDueBlockedGoalRetry(run.id, run.version);
      epoch = retry.retryIndex + 1;
    } else if (run.status === "paused" && run.pauseReason === "runtime_unavailable") {
      // A host dispatch failure pause is not a person's decision: put it on the automatic retry schedule.
      return scheduleRetry(run, "resume", "host_dispatch_pause", trigger, { effectUncertain: false, fromReason: "invocation_failed", dispatchFailed: true });
    } else if (!["queued", "running"].includes(run.status) && !hostPauseRefusedThisInstance(run)) {
      return null;
    }
  }

  const wait = latestGoalWaitSubscription(run.goalId);
  if (wait && (wait.state === "pending" || wait.state === "claimed")) return defer("wait_owns_next_step");
  if (run.rootChatId && dispatcher.activeChatIds().includes(run.rootChatId)) return defer("chat_busy");
  // 오너 요청이 줄 서 있으면 그 요청이 먼저다 — 옛 목표를 앞질러 재개하지 않는다.
  if (run.rootChatId && dispatcher.hasQueuedOwnerRequest?.(run.rootChatId)) return defer("owner_request_queued");
  const review = getLongRunAttemptReview(run.id);
  if (liveLongRunAttemptCount(run.id) > 0) return defer("attempt_running");

  // Historical effect evidence is observed separately. Its absence, failure
  // or inconclusive result never owns the next Goal episode.
  if (isEffectUncertainBlockReason(run.blockedReason) || review.attempts.some(attempt => attempt.sideEffectState === "uncertain")) {
    try { maybeDispatchEffectObservation(dispatcher, run.goalId, `blocked-sweep:${trigger}`, { epoch }); }
    catch (error) { console.warn("[blocked-goal-sweep] advisory observation unavailable:", error); }
    const current = getLongRun(run.id);
    if (!current || longRunOwnerHold(run.id)) return defer("goal_state_changed");
    run = current;
  }

  // 2a. Its turn was refused because another turn holds this Work project: wait for that turn to end
  // (resumeGoalsWaitingOnProject is called when it settles). No model start, no retry schedule, no notice.
  if (run.status === "blocked" && run.blockedReason === WORK_PROJECT_RESIDENCY_BUSY_CODE && projectHeldByAnotherTurn(run, dispatcher)) {
    return defer("project_held_by_another_turn");
  }
  // 2. Effects are settled (or absent): continue the goal itself.
  const chat = run.rootChatId ? getChat(run.rootChatId) : null;
  if (!chat || chat.goalId !== run.goalId) return scheduleRetry(run, "resume", "goal_chat_binding_missing", trigger, { effectUncertain: false });
  // It used to be cancelled here (goal_authority_missing) the first time it stopped — including a real owner Goal
  // paused by quitting mid-turn (reproduced 2026-09-25). An explicit Goal's grant was adopted above; one with no
  // recorded goal-mode turn (defined by IPC only) is kept as it is: the host never invents authority, and never
  // cancels an owner-defined Goal for lacking one — the owner's next message grants it.
  if (!getChatGoalRevision(run.goalId)) return scheduleRetry(run, "resume", "goal_owner_grant_unrecorded", trigger, { effectUncertain: false });
  if (budget.dispatches >= BLOCKED_GOAL_SWEEP_MAX_DISPATCHES) return defer("dispatch_budget");
  budget.dispatches += 1;
  return resume(run, dispatcher, trigger);
}

/** Host pauses an Alive orchestrator may continue. An owner pause, an approval hold and a budget stop never are. */
export const ALIVE_CONTINUABLE_PAUSE_REASONS: ReadonlySet<string> = new Set(["agent_paused", "runtime_unavailable", "app_closed", "crash_recovery"]);

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
  try { assertDesktopLongRunAdmissionOpen(); } catch { return deferred("desktop_long_run_admission_closed"); }
  const run = getLongRun(runId);
  if (!run || run.version !== expectedVersion || (run.surface !== "one" && run.surface !== "work")
    || run.executionLocation !== "desktop-local" || run.hostOwnerKind !== "desktop") return deferred("alive_goal_state_changed", run?.blockedReason ?? null);
  if (longRunOwnerHold(run.id)) return deferred(LONG_RUN_OWNER_HOLD_CODE, run.blockedReason);
  const budget = { dispatches: 0 };
  if (run.status === "blocked") return sweepOne(run, dispatcher, "alive", budget) ?? deferred("alive_goal_not_continuable", run.blockedReason);
  // A host-scheduled retry owns the next step and its spacing. Isolated live run 2026-09-24: letting the
  // orchestrator bring a pending effect-observation retry forward turned the sweep's growing backoff into a
  // ~30s loop (21 observation runs in 10 minutes, each inconclusive). Alive never overrides that schedule.
  if (pendingBlockedGoalRetry(run.id)) return deferred("retry_owns_next_step", run.blockedReason);
  if (run.status !== "paused" || !ALIVE_CONTINUABLE_PAUSE_REASONS.has(run.pauseReason ?? "")) {
    return deferred("alive_goal_not_continuable", run.blockedReason);
  }
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
  // Observer retries have their own due time and never consume the foreground retry slot.
  try { sweepDueGoalEffectObservations(dispatcher); }
  catch (error) { console.warn("[blocked-goal-sweep] observer sweep unavailable:", error); }
  const results: BlockedGoalSweepResult[] = [];
  const budget = { dispatches: 0 };
  let afterId = "";
  while (true) {
    const rows = getDb().prepare(`SELECT id FROM long_runs WHERE id > ?
      AND surface IN ('one','work') AND execution_location = 'desktop-local' AND host_owner_kind = 'desktop'
      AND (status IN ('blocked','queued')
        OR (status = 'paused' AND pause_reason IN ('runtime_unavailable','app_closed','crash_recovery'))
        OR (status IN ('waiting_tool','running') AND EXISTS (SELECT 1 FROM long_run_events e WHERE e.run_id = long_runs.id AND e.kind IN (?, ?))))
      ORDER BY id LIMIT 100`).all(afterId, BLOCKED_GOAL_SWEEP_EVENT_KIND, OWNER_GOAL_AMENDMENT_PENDING_KIND) as Array<{ id: string }>;
    if (!rows.length) break;
    for (const { id } of rows) {
      afterId = id;
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
