"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentlasIpc, ChatContinuitySnapshot, ChatGoalContext, GoalResumeConfirmation, GoalResumeReview, GoalRuntimeSelectionReceipt } from "../../../shared/types";
import { IconEdit, IconTarget, IconTrash } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import { failureMessage } from "@/lib/invocation-failure";
import { classifyGoalSurfaceStatus, goalSurfaceStatusLabel } from "@/lib/goal-surface-status";
import { GoalStrategyStatus } from "./GoalStrategyStatus";
import styles from "./OneGoalControls.module.css";

const MAX_INLINE_REVIEW_ATTEMPTS = 20;
type GoalAction = "pause" | "delete" | "resume" | "edit";
type GoalView = { goalId: string | null; context: ChatGoalContext | null; continuity: ChatContinuitySnapshot | null; handoff: GoalRuntimeSelectionReceipt | null;
  observedAt: string | null; pending: GoalAction | null; error: string | null;
  errorKind: "observation" | "action" | null; refreshing: boolean; review: GoalResumeReview | null };
type GoalBridge = Pick<AgentlasIpc["chats"], "get" | "getGoalContext" | "getGoalRuntimeSelection" | "pauseGoal" | "deleteGoal" | "resumeGoal" | "getGoalResumeReview" | "reviseGoal">
  & { getContinuitySnapshot?: AgentlasIpc["chats"]["getContinuitySnapshot"] };

/** A mounted view owns observations, never Goal authority. Old reads/actions
 * may finish in Main, but cannot paint a replacement chat or reset its draft. */
export function createOneGoalControlSession(input: {
  chatId: string; api: GoalBridge; isCurrent: () => boolean;
  publish: (view: GoalView) => void; onDeleted: () => void;
}) {
  let live = true;
  let readGeneration = 0;
  let actionGeneration = 0;
  let view: GoalView = { goalId: null, context: null, continuity: null, handoff: null, observedAt: null, pending: null, error: null, errorKind: null, refreshing: false, review: null };
  const current = () => live && input.isCurrent();
  const publish = (patch: Partial<GoalView>) => {
    if (!current()) return;
    view = { ...view, ...patch };
    input.publish(view);
  };
  const refresh = async (clearError = false) => {
    const generation = ++readGeneration;
    const fresh = () => current() && generation === readGeneration;
    publish({ refreshing: true });
    try {
      const chat = await input.api.get(input.chatId);
      if (!fresh()) return;
      if (!chat || chat.id !== input.chatId || chat.originSurface !== "one") {
        publish({ goalId: null, context: null, continuity: null, handoff: null, refreshing: false, error: null, errorKind: null, review: null });
        return;
      }
      const goalId = chat.goalId ?? null;
      if (!goalId) { publish({ goalId: null, context: null, continuity: null, handoff: null, refreshing: false, error: null, errorKind: null, review: null }); return; }
      // Keep deletion reachable even when the Goal has not been defined yet.
      publish({ goalId, ...(view.goalId !== goalId ? { context: null, continuity: null, handoff: null } : {}) });
      const context = await input.api.getGoalContext(input.chatId);
      if (!fresh()) return;
      const handoff = await input.api.getGoalRuntimeSelection(input.chatId);
      if (!fresh()) return;
      let continuity: ChatContinuitySnapshot | null = null;
      if (input.api.getContinuitySnapshot) {
        try {
          const candidate = await input.api.getContinuitySnapshot(input.chatId);
          if (candidate?.chatId === input.chatId && candidate.goal?.goalId === goalId) continuity = candidate;
        } catch {
          // Goal controls remain usable from the independently authoritative
          // Goal context when the optional continuity read is unavailable.
        }
      }
      if (!fresh()) return;
      const latest = await input.api.get(input.chatId);
      if (!fresh()) return;
      if (latest?.goalId !== goalId || (context && context.goalId !== goalId)) {
        publish({ goalId: null, context: null, continuity: null, handoff: null, refreshing: false, error: null, errorKind: null, review: null });
        return;
      }
      const stateChanged = view.goalId !== goalId || view.context?.version !== context?.version;
      publish({ context, continuity, handoff: handoff?.goalId === goalId ? handoff : null,
        ...(stateChanged ? { review: null } : {}),
        observedAt: new Date().toISOString(), refreshing: false,
        ...(clearError || stateChanged || view.errorKind === "observation"
          ? { error: null, errorKind: null } : {}) });
    } catch (cause) {
      if (fresh()) publish({ refreshing: false, error: failureMessage(cause).slice(0, 240), errorKind: "observation" });
    }
  };
  const act = async (action: GoalAction, confirmation?: GoalResumeConfirmation) => {
    if (!current() || !view.goalId || view.pending === action || view.pending === "delete") return;
    const goalId = view.goalId;
    const generation = ++actionGeneration;
    ++readGeneration;
    const fresh = () => current() && generation === actionGeneration;
    publish({ pending: action, error: null, errorKind: null });
    try {
      const chat = await input.api.get(input.chatId);
      if (!fresh()) return;
      if (chat?.id !== input.chatId || chat.goalId !== goalId) throw new Error("goal_control_binding_changed");
      if (action === "edit") throw new Error("goal_edit_objective_required");
      if (action === "delete") {
        const updated = await input.api.deleteGoal(input.chatId, goalId);
        if (!fresh()) return;
        if (updated.id !== input.chatId || updated.goalId) throw new Error("goal_control_binding_changed");
        publish({ goalId: null, context: null, continuity: null, handoff: null, review: null });
        input.onDeleted();
      } else if (action === "pause") {
        await input.api.pauseGoal(input.chatId, goalId);
      } else {
        // Goal events can advance the long-run CAS version after the button
        // rendered (for example, app-close recovery or attempt settlement).
        // Re-read immediately before resume and retry one exact version race;
        // the goal identity is checked on every pass, so this never resumes a
        // replacement Goal or widens the user's command.
        let resumed = false;
        for (let attempt = 0; attempt < 2 && !resumed; attempt += 1) {
          const latest = await input.api.getGoalContext(input.chatId);
          if (!fresh()) return;
          if (!latest || latest.goalId !== goalId || !latest.version) {
            throw new Error("goal_control_binding_changed");
          }
          try {
            if (!confirmation) {
              const review = await input.api.getGoalResumeReview(input.chatId, latest.version, goalId);
              if (!fresh()) return;
              if (review) { publish({ review }); return; }
            }
            await input.api.resumeGoal(input.chatId, latest.version, goalId, confirmation);
            resumed = true;
            if (fresh()) publish({ review: null });
          } catch (cause) {
            if (attempt === 0 && /(?:^|:\s*)long_run_resume_version_conflict$/.test(failureMessage(cause))) continue;
            throw cause;
          }
        }
        if (!resumed) throw new Error("long_run_resume_version_conflict");
      }
    } catch (cause) {
      if (fresh()) publish({ error: failureMessage(cause).slice(0, 240), errorKind: "action", review: null });
    } finally {
      if (fresh()) {
        publish({ pending: null });
        await refresh();
      }
    }
  };
  const revise = async (objective: string) => {
    if (!current() || !view.goalId || view.pending || !view.context?.version || !view.context.goalRevision) return;
    const generation = ++actionGeneration;
    ++readGeneration;
    const fresh = () => current() && generation === actionGeneration;
    publish({ pending: "edit", error: null, errorKind: null });
    try {
      const context = await input.api.reviseGoal(input.chatId, {
        expectedGoalId: view.goalId,
        expectedVersion: view.context.version,
        expectedGoalRevision: view.context.goalRevision,
        objective,
      });
      if (fresh()) publish({ context });
    } catch (cause) {
      if (fresh()) publish({ error: failureMessage(cause).slice(0, 240), errorKind: "action" });
    } finally {
      if (fresh()) { publish({ pending: null }); await refresh(); }
    }
  };
  return { refresh, act, revise, closeReview: () => publish({ review: null }), observedRunId: () => view.context?.runId,
    dispose: () => { live = false; ++readGeneration; ++actionGeneration; } };
}

export function OneGoalControls({ chatId, locale, isCurrent, onDeleted, lastConfirmedModel, helpContent }: {
  chatId: string; locale: "ko" | "en"; isCurrent: () => boolean; onDeleted: () => void;
  /** From the latest durable invocation final, never the composer default. */
  lastConfirmedModel?: string | null;
  helpContent?: ReactNode;
}) {
  const [view, setView] = useState<GoalView>({ goalId: null, context: null, continuity: null, handoff: null, observedAt: null, pending: null, error: null, errorKind: null, refreshing: false, review: null });
  const [reviewedAttemptIds, setReviewedAttemptIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const callbacks = useRef({ isCurrent, onDeleted });
  callbacks.current = { isCurrent, onDeleted };
  const session = useRef<ReturnType<typeof createOneGoalControlSession> | null>(null);
  useEffect(() => {
    const api = ipc();
    if (!api) return;
    const owner = createOneGoalControlSession({ chatId, api: api.chats,
      isCurrent: () => callbacks.current.isCurrent(), publish: setView,
      onDeleted: () => callbacks.current.onDeleted() });
    session.current = owner;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let refreshing = false;
    let queued = false;
    const refresh = () => {
      if (disposed) return;
      if (refreshing) { queued = true; return; }
      refreshing = true;
      void owner.refresh().finally(() => {
        refreshing = false;
        if (queued && !disposed) { queued = false; schedule(); }
      });
    };
    const schedule = () => {
      if (!disposed && timer === undefined) timer = setTimeout(() => { timer = undefined; refresh(); }, 250);
    };
    const unsubscribe = ipcEvents()?.onStoreChanged?.((change) => {
      if ((change.entity === "chat" && (!change.id || change.id === chatId))
        || (change.entity === "long-run" && change.id === owner.observedRunId())
        || change.entity === "automation" || change.entity === "run-event") {
        schedule();
      }
    });
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 10_000);
    refresh();
    return () => { disposed = true; owner.dispose(); unsubscribe?.(); clearTimeout(timer); clearInterval(poll); session.current = null; };
  }, [chatId]);
  useEffect(() => {
    setReviewedAttemptIds([]);
    if (view.review) setHelpOpen(false);
  }, [view.review?.attemptSetDigest]);
  if (!view.goalId && !view.error) return null;
  const ko = locale === "ko";
  // Electron serializes IPC failures into an error message. This exact code
  // mapping changes explanation only; Main alone decides whether resume runs.
  const uncertainResume = /(?:^|:\s*)auto_goal_resume_attempt_unsettled$/.test(view.error ?? "");
  const reviewCancelled = /(?:^|:\s*)goal_resume_uncertain_review_cancelled$/.test(view.error ?? "");
  const reviewChanged = /(?:^|:\s*)goal_resume_uncertain_review_changed$/.test(view.error ?? "");
  const reviewRequired = /(?:^|:\s*)goal_resume_uncertain_review_required$/.test(view.error ?? "");
  const reviewUnverifiable = /(?:^|:\s*)goal_resume_uncertain_review_unverifiable$/.test(view.error ?? "");
  const reviewTooLarge = /(?:^|:\s*)goal_resume_uncertain_review_too_large$/.test(view.error ?? "");
  const automationReviewRequired = /(?:^|:\s*)goal_resume_uncertain_automation_reconciliation_required$/.test(view.error ?? "");
  const claimedWaitReconciliation = /(?:^|:\s*)goal_wait_claimed_reconciliation_required$/.test(view.error ?? "");
  const lifecycleConfirmationUnavailable = /(?:^|:\s*)goal_legacy_lifecycle_confirmation_unavailable$/.test(view.error ?? "");
  const lifecycleNotOngoing = /(?:^|:\s*)goal_legacy_lifecycle_not_ongoing$/.test(view.error ?? "");
  const status = view.context?.runStatus;
  const claimedDispatchUncertain = view.context?.blockedReason === "goal_wait_claimed_dispatch_uncertain";
  const claimedBindingChanged = view.context?.blockedReason === "goal_wait_claimed_binding_changed";
  const effectBoundaryUncertain = view.context?.blockedReason === "goal_resume_effect_boundary_uncertain";
  const claimedWaitNeedsReview = claimedDispatchUncertain || claimedBindingChanged || effectBoundaryUncertain;
  const needsOngoingConfirmation = view.context?.blockedReason === "goal_wait_ongoing_authority_required";
  const verificationUnavailable = view.context?.blockedReason === "verification_unavailable";
  // A failed refresh leaves the last confirmed context visible so the Goal is
  // not mistaken for deleted. It must not leave a Resume/Pause/Edit action
  // armed against that old version while an independent schedule continues.
  const observationFresh = Boolean(view.observedAt && view.context && !view.error && !view.refreshing);
  const surface = classifyGoalSurfaceStatus({
    runStatus: status,
    pauseReason: view.context?.pauseReason,
    blockedReason: view.context?.blockedReason,
    wait: view.context?.wait ?? view.continuity?.goal?.wait,
    invocation: view.continuity?.invocation,
    automations: view.continuity?.automations,
    observationFresh,
  });
  const resumable = observationFresh && (status === "paused" || status === "blocked") && !claimedWaitNeedsReview;
  const pausable = observationFresh && Boolean(status && !["paused", "pausing", "blocked", "completed", "failed", "cancelled", "cancelling"].includes(status));
  const editable = observationFresh && Boolean(view.context?.goalRevision && view.context?.version && (status === "paused" || status === "blocked" || status === "queued" || status === "waiting_user" || status === "draft"));
  const ongoing = view.context?.lifecycle === "ongoing";
  const timedWait = status === "waiting_tool" && view.context?.wait?.state === "pending" && view.context.wait.subjectKind === "timer";
  const nextCheckAt = view.context?.wait?.nextCheckAt;
  const nextCheck = nextCheckAt && Number.isFinite(Date.parse(nextCheckAt))
    ? new Date(nextCheckAt).toLocaleString(ko ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const label = view.pending === "delete" ? (ko ? "목표를 삭제하는 중" : "Deleting goal")
    : view.pending === "pause" ? (ko ? "멈추는 중 · 목표는 보존됩니다" : "Stopping · goal preserved")
    : !observationFresh ? (ko ? "Goal 상태 재확인 중 · 실행 여부 미확인" : "Rechecking Goal state · run status unconfirmed")
    : status === "pausing" ? (ko ? "멈추는 중 · 목표는 보존됩니다" : "Stopping · goal preserved")
    : status === "blocked" && verificationUnavailable
      ? (ko ? "앱의 결과 검증이 실패해 다음 자율작업이 멈췄습니다. 작업 자체가 실패한 것으로 확인된 것은 아닙니다. 실제 결과를 확인한 뒤 재개 여부를 결정하세요."
        : "The app could not verify the result, so further autonomous work stopped. This does not confirm that the task itself failed. Check the actual outcome before deciding whether to resume.")
    : observationFresh && surface.state !== "unknown"
      ? goalSurfaceStatusLabel(surface.state, locale)
    : status === "paused" ? (ko ? "일시정지됨" : "Paused")
    : status === "blocked" && needsOngoingConfirmation
      ? (ko ? "이 Goal의 다음 판단 주기는 확인 대기 중입니다 · 별도 예약 Graph 상태는 자동화에서 확인하세요" : "This Goal's next decision cycle awaits confirmation · check Automations for separately scheduled Graph runs")
    : status === "blocked" && claimedDispatchUncertain
      ? (ko ? "이전 호출이 전달됐는지 불확실합니다 · 기록은 보존했고 자동 재실행을 막았습니다" : "Previous dispatch may have reached the runtime · history preserved and automatic replay stopped")
    : status === "blocked" && claimedBindingChanged
      ? (ko ? "Goal 연결이 변경됐습니다 · 기록은 보존했고 자동 재실행을 막았습니다" : "Goal binding changed · history preserved and automatic replay stopped")
    : status === "blocked" && effectBoundaryUncertain
      ? (ko ? "이전 호출의 효과 경계를 확인할 수 없습니다 · 기록은 보존했고 자동 재실행을 막았습니다" : "The previous effect boundary could not be verified · history preserved and automatic replay stopped")
    : status === "blocked" ? (ko ? "진행이 멈췄습니다 · 재개 전 상태 확인이 필요합니다" : "Blocked · check the outcome before resuming")
    : status === "verifying" ? (ko ? "결과를 성공 기준과 대조하는 중" : "Checking the result against acceptance criteria")
    : timedWait ? (ko ? `다음 확인 ${nextCheck ?? "대기 중"} · 앱 실행 중 자동 재개` : `Next check ${nextCheck ?? "pending"} · resumes while app is running`)
    : status === "waiting_tool" ? (ko ? "이 Goal의 도구 결과 대기 중" : "Waiting for this Goal's tool result")
    : status === "queued" ? (ko ? "이 Goal의 다음 실행 준비 중" : "Preparing this Goal's next run")
    : status === "running" ? (ko ? "이 Goal의 실행 중 · Activity에서 단계 확인" : "This Goal is running · check Activity for phase")
    : view.context?.objective || (ko ? "다음 요청으로 목표를 확정합니다" : "Your next request will define the goal");
  const shortStatus = view.pending ? (ko ? "처리 중" : "Working")
    : !observationFresh ? (ko ? "확인 중" : "Checking")
    : status === "blocked" && verificationUnavailable ? (ko ? "검증 오류" : "Verification error")
    : surface.state === "active_run" ? (ko ? "실행 중" : "Running")
    : surface.state === "active_unconfirmed" ? (ko ? "실행 확인 중" : "Checking run")
    : surface.state === "queued" ? (ko ? "준비 중" : "Queued")
    : surface.state === "scheduled_wait" ? (ko ? "예약됨" : "Scheduled")
    : surface.state === "waiting_confirmation" ? (ko ? "확인 필요" : "Confirm")
    : surface.state === "waiting" ? (ko ? "대기 중" : "Waiting")
    : surface.state === "blocked_uncertain" ? (ko ? "결과 확인 필요" : "Review outcome")
    : surface.state === "blocked" ? (ko ? "조치 필요" : "Needs action")
    : surface.state.startsWith("paused") ? (ko ? "일시정지" : "Paused")
    : surface.state === "verifying" ? (ko ? "검증 중" : "Verifying")
    : surface.state === "completed" ? (ko ? "완료" : "Completed")
    : surface.state === "failed" ? (ko ? "실패" : "Failed")
    : surface.state === "cancelled" ? (ko ? "종료" : "Stopped")
    : (ko ? "상태 확인 중" : "Checking status");
  const review = view.review;
  const allReviewed = Boolean(review && review.attemptIds.every((id) => reviewedAttemptIds.includes(id)));
  return <section className={styles.root} aria-label={ko ? "목표" : "Goal"} data-one-goal-controls="true"
    data-goal-observation={view.error || view.refreshing ? "stale" : observationFresh ? "confirmed" : "pending"}>
    {view.goalId && <div className={styles.bar}>
      <IconTarget size={13} />
      <strong>{ongoing ? (ko ? "지속 목표" : "Ongoing goal") : (ko ? "목표" : "Goal")}</strong>
      <span className={styles.label} title={label} role="status">{shortStatus}</span>
      {pausable && <button type="button" aria-label={ko ? "목표 일시정지" : "Pause goal"}
        onClick={() => { void session.current?.act("pause"); }}>{ko ? "일시정지" : "Pause"}</button>}
      {resumable && <button type="button" disabled={view.pending === "resume" || !view.context?.version}
        aria-label={needsOngoingConfirmation
          ? ongoing
            ? (ko ? "저장된 지속 목표 확인 후 재개" : "Confirm saved ongoing goal and resume")
            : (ko ? "저장된 목표 검토 후 재개" : "Review saved goal before resuming")
          : (ko ? "목표 수동 재개" : "Resume goal manually")}
        onClick={() => { void session.current?.act("resume"); }}>{view.pending === "resume" ? (ko ? "확인 중" : "Checking")
          : needsOngoingConfirmation && ongoing ? (ko ? "지속 목표 확인 후 재개" : "Confirm ongoing goal")
          : needsOngoingConfirmation ? (ko ? "목표 검토 후 재개" : "Review goal before resuming")
          : ko ? "재개" : "Resume"}</button>}
      <button type="button" disabled={!editable || view.pending !== null} aria-label={ko ? "목표 편집" : "Edit goal"}
        title={!editable ? (ko ? "실행을 먼저 일시정지하면 편집할 수 있습니다" : "Pause the run before editing") : undefined}
        onClick={() => { setDraft(view.context?.objective ?? ""); setEditing(true); }}><IconEdit size={13} /></button>
      <button type="button" aria-label={ko ? "목표 삭제" : "Delete goal"}
        title={ko ? "목표를 삭제합니다. 대화와 작업 파일은 유지됩니다" : "Delete the goal; keep the conversation and files"}
        onClick={() => { void session.current?.act("delete"); }}><IconTrash size={13} /></button>
      <button type="button" className={styles.helpButton} aria-label={ko ? "목표 상태 도움말" : "Goal status help"}
        aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}>?</button>
    </div>}
    {helpOpen && <div className={styles.help} role="region" aria-label={ko ? "목표 상태 자세히" : "Goal status details"}>
      <p>{label}</p>
      {view.context?.acceptanceCriteria.length ? <p>{ko ? "성공 기준" : "Success criteria"}: {view.context.acceptanceCriteria.join(" · ")}</p> : null}
      {surface.automation.recentRunning > 0 && <p>{ko ? `자동화 원장 최근 실행 ${surface.automation.recentRunning}개` : `${surface.automation.recentRunning} recent automation record(s)`}</p>}
      {surface.automation.held > 0 && <p>{ko ? `보류된 자동화 ${surface.automation.held}개` : `${surface.automation.held} held automation(s)`}</p>}
      {surface.automation.reconciliationHold > 0 && <p>{ko ? `자동화 조정 보류 ${surface.automation.reconciliationHold}개` : `${surface.automation.reconciliationHold} automation reconciliation hold(s)`}</p>}
      {view.handoff && <p>{ko ? "다음 실행 모델" : "Next-run model"}: {view.handoff.effective?.model ?? view.handoff.requested.model ?? view.handoff.requested.kind} ({view.handoff.state})</p>}
      {view.continuity && <GoalStrategyStatus continuity={view.continuity} surface={surface} locale={locale} />}
      {helpContent}
      {lastConfirmedModel && <p>{ko ? "최근 완료 실행 모델" : "Last completed run model"}: {lastConfirmedModel}</p>}
      {view.observedAt && <p>{ko ? "목표 상태 확인" : "Goal status checked"} <time dateTime={view.observedAt}>{new Date(view.observedAt).toLocaleTimeString(ko ? "ko-KR" : "en-US")}</time></p>}
    </div>}
    {review && <div className={styles.review} role="region" aria-label={ko ? "중단된 작업 결과 확인" : "Review interrupted work"}>
      <div className={styles.reviewHeading}>
        <strong>{ko ? `중단된 작업 ${review.attempts.length}건` : `${review.attempts.length} interrupted task(s)`}</strong>
        <button type="button" onClick={() => { session.current?.closeReview(); setReviewedAttemptIds([]); }}>
          {ko ? "닫기" : "Close"}
        </button>
      </div>
      <p className={styles.reviewIntro}>{ko
        ? "앱이 중단 전 작업의 외부 결과를 확인하지 못했습니다. 아래 작업 내용을 보고 실제 결과를 확인해 주세요. 이전 요청은 자동 재실행하지 않습니다."
        : "The app could not confirm these tasks' external results. Review each task and its actual result below. Previous requests will not be replayed automatically."}</p>
      <div className={styles.reviewList}>
        {review.attempts.slice(0, MAX_INLINE_REVIEW_ATTEMPTS).map((attempt, index) => <label className={styles.reviewItem} key={attempt.id}>
          <input type="checkbox" disabled={Boolean(review.blocker) || view.pending !== null}
            checked={reviewedAttemptIds.includes(attempt.id)}
            onChange={(event) => setReviewedAttemptIds((ids) => event.target.checked
              ? [...ids, attempt.id] : ids.filter((id) => id !== attempt.id))} />
          <span>
            <strong>{index + 1}. {attempt.taskTitle}</strong>
            <small>{new Date(attempt.startedAt).toLocaleString(ko ? "ko-KR" : "en-US")}</small>
            {attempt.taskObjective !== attempt.taskTitle && <span className={styles.reviewObjective}>{attempt.taskObjective}</span>}
            {attempt.recordedActivity.length > 0 && <span className={styles.reviewActivity}>
              <b>{ko ? "앱에 남은 작업 기록" : "Activity recorded in the app"}</b>
              {attempt.recordedActivity.map((line, activityIndex) => <span key={`${attempt.id}:${activityIndex}`}>{line}</span>)}
            </span>}
            <span className={styles.reviewUncertain}>{ko
              ? "외부 결과 미확인 · 이 작업의 실제 결과를 확인한 경우에만 체크"
              : "External result unknown · check only after verifying this task's actual result"}</span>
          </span>
        </label>)}
      </div>
      {review.blocker && <p className={styles.reviewBlocker} role="status">{review.blocker === "running"
        ? (ko ? "아직 실행 중인 작업이 있어 재개할 수 없습니다. 완료되거나 중단된 뒤 다시 확인해 주세요." : "A task is still running. Review again once it finishes or stops.")
        : review.blocker === "too_many"
          ? (ko ? "확인해야 할 작업이 한 번에 표시할 수 있는 수를 넘었습니다. 목표는 일시정지 상태로 유지됩니다." : "There are too many tasks to review safely at once. The goal stays paused.")
        : review.blocker === "automation"
          ? (ko ? "연결된 자동화는 다음 동작 전 결과를 안전하게 대조할 수 없어 이 화면에서 재개할 수 없습니다. 목표와 기록은 보존됩니다." : "This automation cannot safely reconcile results before its next action, so it cannot resume here. The goal and history are preserved.")
          : (ko ? "일부 작업의 실행 기록 연결이 없어 안전한 재개를 확인할 수 없습니다. 목표와 기록은 보존됩니다." : "Some tasks lack a linked run record, so safe resume cannot be confirmed. The goal and history are preserved.")}</p>}
      {!review.blocker && <p className={styles.reviewNote}>{ko
        ? "체크는 실제 결과를 확인했다는 사용자 진술로 기록됩니다. 성공 증거로 취급하지 않습니다."
        : "Checks record your statement that you inspected the actual results. They are not proof of success."}</p>}
      <div className={styles.reviewActions}>
        <button type="button" onClick={() => { session.current?.closeReview(); setReviewedAttemptIds([]); }}>{ko ? "일시정지 유지" : "Keep paused"}</button>
        {!review.blocker && <button type="button" className={styles.reviewPrimary} disabled={!allReviewed || view.pending !== null}
          onClick={() => { void session.current?.act("resume", {
            runId: review.runId, version: review.version, attemptIds: review.attemptIds,
            attemptSetDigest: review.attemptSetDigest, reviewedAttemptIds: review.attemptIds,
          }); }}>
          {view.pending === "resume" ? (ko ? "재개 중" : "Resuming") : ko ? "확인 완료 · 새 작업 재개" : "Reviewed · resume new work"}
        </button>}
      </div>
    </div>}
    {editing && <form className={styles.editor} onSubmit={(event) => {
      event.preventDefault();
      if (!editable || !draft.trim()) return;
      void session.current?.revise(draft.trim()).then(() => setEditing(false));
    }}>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus
        aria-label={ko ? "목표 내용" : "Goal objective"} maxLength={12000} />
      {!editable && <p>{ko ? "목표를 일시정지한 뒤 저장할 수 있습니다." : "Pause the goal before saving."}</p>}
      <div><button type="button" onClick={() => setEditing(false)}>{ko ? "취소" : "Cancel"}</button>
        <button type="submit" disabled={!editable || !draft.trim() || view.pending === "edit"}>{view.pending === "edit" ? (ko ? "저장 중" : "Saving") : (ko ? "저장" : "Save")}</button></div>
    </form>}
    {view.error && <p className={styles.error} role="alert">{claimedWaitReconciliation
      ? (ko ? "이전 호출의 전달·실행 결과가 불확실해 재개하지 않았습니다. 실제 결과를 확인할 때까지 목표와 작업 기록을 보존합니다." : "The previous dispatch outcome is uncertain, so the goal was not resumed. The goal and work history are preserved until its actual result is reviewed.")
      : reviewCancelled
        ? (ko ? "확인을 취소했습니다. 목표는 중단 상태이며 기록은 보존됩니다." : "Review cancelled. The goal remains paused and its history is preserved.")
      : reviewChanged
        ? (ko ? "확인 중 이전 실행 기록이 바뀌었습니다. 최신 기록을 확인하고 다시 시도해 주세요." : "The interrupted attempts changed during review. Inspect the latest record and try again.")
      : reviewRequired
        ? (ko ? "이전 실행의 외부 결과 확인이 필요합니다. 목표는 중단 상태입니다." : "Review the interrupted attempts' external outcomes first. The goal remains paused.")
      : reviewUnverifiable
        ? (ko ? "일부 시도에 Activity 호출 ID가 없어 결과 대조가 불가능할 수 있습니다. 자동 재개 없이 목표와 기록을 보존합니다." : "Some attempts lack an Activity invocation ID, so their outcome may be impossible to verify. The goal and history remain preserved without automatic resume.")
      : reviewTooLarge
        ? (ko ? "개별 결과를 이 창에서 빠짐없이 표시할 수 없어 재개하지 않았습니다. Activity에서 확인해 주세요." : "Too many interrupted attempts to display reliably here. The goal remains paused; inspect Activity.")
      : automationReviewRequired
        ? (ko ? "자동화의 외부 결과가 불확실해 재개하지 않았습니다. Activity와 실제 외부 결과를 대조해야 합니다." : "The automation was not resumed because prior external outcomes are unknown. Compare Activity with the actual external result.")
      : uncertainResume
      ? (ko ? "이전 실행의 결과를 먼저 확인해야 합니다. 목표와 작업 기록은 보존되어 있습니다." : "The previous action's outcome needs confirmation first. Your goal and work history are preserved.")
      : lifecycleConfirmationUnavailable
        ? (ko ? "저장된 요청의 지속 목표 여부를 현재 모델로 확인하지 못해 재개하지 않았습니다. 목표와 작업 기록은 그대로 보존되어 있습니다. 모델 연결 상태를 확인한 뒤 다시 시도해 주세요." : "The current model could not confirm whether the saved request is ongoing, so the goal was not resumed. The goal and work history are preserved; check the model connection and try again.")
      : lifecycleNotOngoing
        ? (ko ? "저장된 요청에서 ‘중단 지시 전까지 계속’이라는 명시적 권한을 확인하지 못해 자동 다음 주기를 시작하지 않았습니다. 계속하려면 대화에 지속 기간을 명시해 새 지시를 보내 주세요." : "The saved request does not explicitly authorize continuing until you stop it, so no automatic next cycle was started. Send a new instruction that states the intended duration if you want ongoing work.")
      : (ko ? "목표 상태를 확인하거나 변경하지 못했습니다. 상태를 새로고침한 뒤 다시 시도해 주세요." : "The goal could not be checked or changed. Refresh its status, then try again.")}
      {!reviewCancelled && !reviewChanged && !reviewRequired && !reviewUnverifiable && !reviewTooLarge && !automationReviewRequired && <span>{view.error}</span>}<button type="button" onClick={() => { void session.current?.refresh(true); }}>{ko ? "상태 새로고침" : "Refresh status"}</button></p>}
  </section>;
}
