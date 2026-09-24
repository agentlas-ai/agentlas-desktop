/**
 * 막힌 목표를 남기지 않는다 — 오너 지시 2026-09-23.
 *
 *   "블락되는거 전부다 치워라 … 그럼 막는 경우 단 한건도 없겠지?"
 *   정정: "눌러서 이어가는게 결국 멈춘거 아닌가" — 사람의 단추를 기다리는 일시정지도 멈춤이다.
 *
 * 설치본(1.2.33) DB 실측: One/Work 목표 11건이 'blocked' 로 멈춰 있었고, 앱을 다시 켜도 기존 복구 세 갈래
 * (체크포인트 재개·지속 목표 관찰 복구·레거시 수명 복구)가 거절 사유만 적고 그대로 두었다
 * (workspace_changed · attempt_unsettled · legacy_goal_binding_unavailable). 효과 관찰은 사람이 대화를
 * 열 때만 떴고, 재시작 효과 경계 불확실은 관찰도(no_uncertain_attempts) 사람의 재개도 거절돼 영원히 막혔다.
 *
 * 끝은 두 가지뿐이다: 완료, 또는 기록된 이유로 취소. 그 사이의 모든 멈춤은 앱이 스스로 푼다.
 * 새 길을 만들지 않고 이미 있는 길을 순서대로 부른다(기존 시작 복구 뒤에, 그리고 앱이 도는 동안 주기적으로):
 *
 *  0. 결정적 표식 규칙으로만 취소한다(산문 추측 금지): 목표 원문이 QA 표식([QA_MARKER=…],
 *     "Local release QA only")으로 시작하거나, 목표가 허가받은 작업 폴더가 디스크에서 사라졌다.
 *  1. 바깥 효과가 불확실하다(효과 불확실 사유, 또는 정리 안 된 시도가 남음)
 *       → 읽기 전용 효과 관찰(effect-observation.ts). 있으면 그 뒤부터, 없으면 다시 한다(기존 판정 경로).
 *       → 지금 볼 수 없거나(런타임·한도·이미 본 회차) 모름이면 백오프로 다시 볼 시각을 적는다(새 회차 관찰).
 *  2. 효과는 정리돼 있다(실행 실패·검증 불가·검증 모름·이어가기 실패·레거시 수명 확인 등)
 *       → 원래 권한·예산 그대로 자동 재개(automaticGoalResumeRequest). 재개 턴이 결과를 다시 검증한다.
 *         런타임은 대화의 선택을 따르므로 사용 한도·실행 실패는 기존 폴백 사슬(mcp/client.ts)이 다른 연결
 *         모델로 넘긴다. 재개를 못 띄우면 백오프로 다시 띄울 시각을 적는다.
 *
 * 예약된 재시도 동안 상태는 'waiting_tool'(앱이 기다리는 중)이다. 시각이 되면 원래 사유로 되돌려 같은 판단을
 * 다시 한다. 권한 승격 같은 사람의 동의가 필요한 경계는 여기서 다루지 않는다(기존 승격 칩). 불확실한 효과는
 * 여전히 읽기 전용 관찰만 풀 수 있고, 옛 시도를 조용히 재실행하는 길은 없다. 실행 중인 시도·대기 구독·진행 중
 * 관찰·바쁜 대화는 그 주인이 다음 단계를 가지므로 다음 스윕으로 미룬다.
 */
import { applyPendingOwnerGoalAmendments, OWNER_GOAL_AMENDMENT_PENDING_KIND } from "./goal-owner-amendment";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { getDb } from "../store/db";
import { appendChatMessage, getChat, getChatWorkingFolder, setChatContinuousMode, setChatGoalBinding } from "../store/chats";
import { completeChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { findAutomationByGoalId, toggleAutomation } from "../store/automations";
import {
  appendLongRunEvent, bindCurrentGoalRevisionToLongRun, getLongRun, getLongRunAttemptReview, nextBlockedGoalRetrySlot,
  pendingBlockedGoalRetry, reopenDueBlockedGoalRetry, scheduleBlockedGoalRetry, transitionLongRun,
  BLOCKED_GOAL_SWEEP_EVENT_KIND, BLOCKED_GOAL_SWEEP_SCHEMA, type LongRunRecord,
} from "../store/long-runs";
import { automaticGoalResumeRequest } from "../invocation/automatic-goal";
import {
  assertDesktopLongRunAdmissionOpen, confirmDesktopLongRunResumeDispatched, desktopAppInstanceId,
  failDesktopLongRunResumeDispatch,
} from "./app-runtime-coordinator";
import { latestGoalWaitSubscription } from "./wait-subscriptions";
import { EFFECT_OBSERVATION_EXHAUSTED, isEffectUncertainBlockReason, maybeDispatchEffectObservation } from "./effect-observation";
import { isGoalObserving, type EffectObservationDispatcher } from "./effect-observation-tickets";
import { currentUiLocale } from "../ui-locale";

export type BlockedGoalSweepAction = "observation_dispatched" | "resumed" | "retry_scheduled" | "cancelled" | "deferred";

export interface BlockedGoalSweepResult {
  runId: string;
  fromReason: string | null;
  action: BlockedGoalSweepAction;
  detail: string;
}

/** Skips whose owner acts on its own shortly; the next sweep looks again without writing anything. */
const TRANSIENT_OBSERVATION_SKIPS = new Set(["in_flight", "chat_busy", "attempt_running", "automation_running"]);

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

/** The folder this goal was authorized to work in no longer exists (removable volumes excluded: they come back). */
function missingGoalWorkspace(run: LongRunRecord): string | null {
  const folder = run.rootChatId ? getChatWorkingFolder(run.rootChatId) : null;
  if (!folder || folder.startsWith("/Volumes/")) return null;
  try { statSync(folder); return null; } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "goal_workspace_missing" : null;
  }
}

function notify(run: LongRunRecord, ko: string, en: string): void {
  if (!run.rootChatId) return;
  try {
    appendChatMessage(run.rootChatId, "assistant", currentUiLocale() === "ko" ? ko : en,
      { hostNotice: { purpose: "goal-continuation", runId: run.id } });
  } catch (error) {
    console.warn("[blocked-goal-sweep] chat notice failed:", error);
  }
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[a-z_]+(?::[a-z_0-9-]+)?$/.test(error.message) ? error.message : fallback;
}

function cancel(run: LongRunRecord, rule: string, trigger: string): BlockedGoalSweepResult {
  const chatId = run.rootChatId;
  getDb().transaction(() => {
    let current = getLongRun(run.id);
    if (!current || current.version !== run.version) throw new Error("blocked_goal_sweep_state_changed");
    if (!["blocked", "paused", "draft"].includes(current.status)) {
      current = transitionLongRun({ runId: current.id, to: "cancelling", actorKind: "host", reason: rule, expectedVersion: current.version });
    }
    transitionLongRun({ runId: current.id, to: "cancelled", actorKind: "host", reason: rule, expectedVersion: current.version });
    appendLongRunEvent({ runId: current.id, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
      payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: "cancelled", rule, fromReason: run.blockedReason,
        fromStatus: run.status, trigger: trigger.slice(0, 80), appInstanceId: desktopAppInstanceId() } });
    completeChatGoalContract(run.goalId, "cancelled");
    const continuation = findAutomationByGoalId(run.goalId);
    if (continuation?.enabled) toggleAutomation(continuation.id, false);
    if (chatId && getChat(chatId)?.goalId === run.goalId) {
      setChatGoalBinding(chatId, null);
      setChatContinuousMode(chatId, false);
    }
  })();
  const why = rule.startsWith("qa_")
    ? { ko: "QA 점검용으로 표시된 목표라", en: "it is marked as a QA check" }
    : rule === "goal_workspace_missing"
      ? { ko: "이 목표가 작업하도록 허가받은 폴더가 더 이상 없어서", en: "the folder it was allowed to work in no longer exists" }
      : rule === "goal_chat_binding_missing"
        ? { ko: "이 목표가 속한 대화가 더 이상 이 목표를 가리키지 않아서", en: "its conversation no longer points to it" }
        : rule === "goal_authority_missing"
          ? { ko: "이어갈 때 쓸 원래 권한 기록이 없어서", en: "there is no recorded permission to continue it under" }
          : { ko: "정해 둔 예산을 다 써서", en: "its budget is spent" };
  const again = rule.startsWith("qa_") ? { ko: "", en: "" }
    : { ko: " 다시 하려면 요청을 새로 보내 주세요.", en: " Send the request again to start it fresh." };
  notify(run, `이 목표는 ${why.ko} 정리(취소)했어요. 기록은 남아 있습니다.${again.ko}`,
    `This goal was closed (cancelled) because ${why.en}. Its history is kept.${again.en}`);
  return { runId: run.id, fromReason: run.blockedReason, action: "cancelled", detail: rule };
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
    notify(run, kind === "observe"
      ? `이전 작업이 반영됐는지 지금은 확인하지 못했어요. ${minutes}분 뒤 앱이 스스로 다시 확인하고 이어갑니다.`
      : `지금은 이 목표를 이어갈 모델을 띄우지 못했어요. ${minutes}분 뒤 앱이 스스로 다시 시도합니다.`,
    kind === "observe"
      ? `I could not check the earlier action right now. The app will look again in ${minutes} min on its own and continue.`
      : `No model could pick this goal up right now. The app will try again in ${minutes} min on its own.`);
  }
  return { runId: run.id, fromReason: run.blockedReason, action: "retry_scheduled", detail };
}

const CANCEL_ON_RESUME_REFUSAL: Record<string, string> = {
  auto_goal_budget_exhausted: "budget_spent",
  budget_cost_exhausted: "budget_spent",
  auto_goal_resume_authority_missing: "goal_authority_missing",
  auto_goal_resume_surface_mismatch: "goal_chat_binding_missing",
};

function resume(run: LongRunRecord, dispatcher: EffectObservationDispatcher, trigger: string): BlockedGoalSweepResult {
  const chatId = run.rootChatId!;
  let prepared: { request: NonNullable<ReturnType<typeof automaticGoalResumeRequest>>; queuedId: string } | null = null;
  let current = run;
  for (let pass = 0; pass < 2 && !prepared; pass += 1) {
    try {
      prepared = getDb().transaction(() => {
        const latest = getLongRun(current.id);
        if (!latest || latest.version !== current.version || !["blocked", "paused"].includes(latest.status)) {
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
      if (!latest || code === "blocked_goal_sweep_state_changed" || !["blocked", "paused"].includes(latest.status)) {
        return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: code };
      }
      // An edited Goal whose new revision was never bound: bind it (the same binder the chip uses), then retry once.
      if (code === "auto_goal_resume_revision_pending" && pass === 0) {
        try { current = bindCurrentGoalRevisionToLongRun(latest.id, latest.version); continue; }
        catch { /* fall through to a scheduled retry */ }
      }
      const cancelRule = CANCEL_ON_RESUME_REFUSAL[code] ?? (/^budget_/.test(code) ? "budget_spent" : null);
      if (cancelRule) return cancel(latest, cancelRule, trigger);
      const effectQuestion = code === "auto_goal_resume_attempt_unsettled" || isEffectUncertainBlockReason(latest.blockedReason)
        || code === "goal_wait_claimed_reconciliation_required" || code === "goal_resume_effect_boundary_uncertain";
      return scheduleRetry(latest, effectQuestion ? "observe" : "resume", code, trigger, { effectUncertain: effectQuestion });
    }
  }
  if (!prepared) return { runId: run.id, fromReason: run.blockedReason, action: "deferred", detail: "blocked_goal_resume_unavailable" };
  notify(run, "멈춰 있던 목표를 원래 권한과 예산 그대로 다시 이어갑니다. 결과는 끝나면 다시 검증합니다.",
    "Continuing the stopped goal with its original permissions and budget. The result is verified again when it finishes.");
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

  // 0. Deterministic end rules.
  const qa = staleQaGoalMarker(getChatGoalRevision(run.goalId)?.originalRequest.text ?? run.objective)
    ?? staleQaGoalMarker(run.objective);
  if (qa) return cancel(run, qa, trigger);
  const workspaceGone = missingGoalWorkspace(run);
  if (workspaceGone) return cancel(run, workspaceGone, trigger);

  // Owner target changes recorded while the Goal was mid-episode are applied
  // at this stop, with the same revision+binding the Goal editor uses. A run
  // parked in waiting_tool is at a stop too when no turn is live in its chat.
  const chatLive = Boolean(run.rootChatId && dispatcher.activeChatIds().includes(run.rootChatId));
  if (run.status === "blocked" || run.status === "paused" || (run.status === "waiting_tool" && !chatLive)) {
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
      if (Date.parse(retry.nextAt) > Date.now()) {
        // The host pause at shutdown/startup does not cancel a scheduled retry: keep the app visibly waiting.
        if (run.status === "paused") {
          scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: retry.kind, fromReason: retry.fromReason,
            retryIndex: retry.retryIndex, nextAt: retry.nextAt, detail: "host_pause_carried_retry", trigger,
            effectUncertain: retry.effectUncertain, appInstanceId: desktopAppInstanceId() });
        }
        return defer(`retry_at:${retry.nextAt}`);
      }
      run = reopenDueBlockedGoalRetry(run.id, run.version);
      epoch = retry.retryIndex + 1;
    } else if (run.status === "paused" && run.pauseReason === "runtime_unavailable") {
      // A host dispatch failure pause is not a person's decision: put it on the automatic retry schedule.
      return scheduleRetry(run, "resume", "host_dispatch_pause", trigger, { effectUncertain: false, fromReason: "invocation_failed", dispatchFailed: true });
    } else if (!hostPauseRefusedThisInstance(run)) {
      return null;
    }
  }

  if (isGoalObserving(run.goalId)) return defer("observation_in_flight");
  const wait = latestGoalWaitSubscription(run.goalId);
  if (wait && (wait.state === "pending" || wait.state === "claimed")) return defer("wait_owns_next_step");
  if (run.rootChatId && dispatcher.activeChatIds().includes(run.rootChatId)) return defer("chat_busy");
  const review = getLongRunAttemptReview(run.id);
  if (review.attempts.some((attempt) => attempt.state === "running")) return defer("attempt_running");

  // 1. Uncertain external effect: look before anything else.
  if (run.status === "blocked" && (isEffectUncertainBlockReason(run.blockedReason) || review.attempts.length > 0)) {
    if (budget.dispatches >= BLOCKED_GOAL_SWEEP_MAX_DISPATCHES) return defer("dispatch_budget");
    const observed = maybeDispatchEffectObservation(dispatcher, run.goalId, `blocked-sweep:${trigger}`, { epoch });
    if (observed.status === "dispatched") {
      budget.dispatches += 1;
      return { runId: run.id, fromReason: run.blockedReason, action: "observation_dispatched", detail: observed.runId };
    }
    const current = getLongRun(run.id);
    // A dispatch that failed to start already scheduled its own re-observation (effect-observation.ts).
    if (!current || current.status !== "blocked") {
      return { runId: run.id, fromReason: run.blockedReason, action: "retry_scheduled", detail: observed.reason };
    }
    if (TRANSIENT_OBSERVATION_SKIPS.has(observed.reason)) return defer(observed.reason);
    // The observation cap was reached and the owner was told (effect-observation.ts): no more model looks
    // and no retry notices — the owner's Continue/one sentence is the way out, not another schedule.
    if (observed.reason === EFFECT_OBSERVATION_EXHAUSTED) return defer(observed.reason);
    if (observed.reason === "chat_binding_changed") return cancel(current, "goal_chat_binding_missing", trigger);
    if (observed.reason !== "no_uncertain_attempts" && observed.reason !== "not_blocked_on_uncertain_effects") {
      return scheduleRetry(current, "observe", observed.reason, trigger, { effectUncertain: true });
    }
    // Nothing was ever dispatched from this chat: there is no outside effect to wait for.
    run = current;
  }

  // 2. Effects are settled (or absent): continue the goal itself.
  const chat = run.rootChatId ? getChat(run.rootChatId) : null;
  if (!chat || chat.goalId !== run.goalId) return cancel(run, "goal_chat_binding_missing", trigger);
  // No stored Goal revision means no recorded permission grant to resume under (legacy explicit Goals).
  // The host never invents authority; asking for a new grant is the consent surface, not a stopped Goal.
  if (!getChatGoalRevision(run.goalId)) return cancel(run, "goal_authority_missing", trigger);
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
  if (isGoalObserving(run.goalId)) return deferred("observation_in_flight");
  const wait = latestGoalWaitSubscription(run.goalId);
  if (wait && (wait.state === "pending" || wait.state === "claimed")) return deferred("wait_owns_next_step");
  if (run.rootChatId && dispatcher.activeChatIds().includes(run.rootChatId)) return deferred("chat_busy");
  if (getLongRunAttemptReview(run.id).attempts.some((attempt) => attempt.state === "running")) return deferred("attempt_running");
  const chat = run.rootChatId ? getChat(run.rootChatId) : null;
  if (!chat || chat.goalId !== run.goalId || !getChatGoalRevision(run.goalId)) return deferred("alive_goal_binding_missing");
  return resume(run, dispatcher, "alive");
}

/**
 * Called once after the startup recovery passes, and every BLOCKED_GOAL_SWEEP_INTERVAL_MS while the app runs, so
 * a Goal that stops later is not left there either. Idempotent: a row that left 'blocked' is revisited only through
 * its own ledger-recorded retry time.
 */
export function sweepBlockedGoals(dispatcher: EffectObservationDispatcher, trigger: "startup" | "periodic"): BlockedGoalSweepResult[] {
  try { assertDesktopLongRunAdmissionOpen(); } catch { return []; }
  const results: BlockedGoalSweepResult[] = [];
  const budget = { dispatches: 0 };
  let afterId = "";
  while (true) {
    const rows = getDb().prepare(`SELECT id FROM long_runs WHERE id > ?
      AND surface IN ('one','work') AND execution_location = 'desktop-local' AND host_owner_kind = 'desktop'
      AND (status = 'blocked'
        OR (status = 'paused' AND pause_reason IN ('runtime_unavailable','app_closed','crash_recovery'))
        OR (status = 'waiting_tool' AND EXISTS (SELECT 1 FROM long_run_events e WHERE e.run_id = long_runs.id AND e.kind IN (?, ?))))
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
