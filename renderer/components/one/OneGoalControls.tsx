"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentlasIpc, ChatContinuitySnapshot, ChatGoalContext, GoalResumeConfirmation, GoalResumeReview, GoalRuntimeSelectionReceipt } from "../../../shared/types";
import { IconEdit, IconTarget, IconTrash } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import { failureMessage } from "@/lib/invocation-failure";
import { classifyGoalSurfaceStatus, goalSurfaceStatusLabel } from "@/lib/goal-surface-status";
import { GoalStrategyStatus } from "./GoalStrategyStatus";
import { GoalPlanSummary, goalPlanOf } from "@/components/goal/GoalPlanSummary";
import styles from "./OneGoalControls.module.css";

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
  const [helpOpen, setHelpOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
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
    if (view.review) setHelpOpen(false);
  }, [view.review?.attemptSetDigest]);
  // The (?) bubble is a transient explanation: any outside press or Escape closes it.
  useEffect(() => {
    if (!helpOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setHelpOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setHelpOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [helpOpen]);
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
    effectObservationChecking: view.context?.effectObservation === "checking"
      || view.continuity?.goal?.effectObservation === "checking",
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
      ? (ko ? "앱이 결과를 확인하지 못해 다음 작업을 멈췄어요. 작업이 실패했다는 뜻은 아니에요."
        : "The app could not check the result, so it paused further work. This does not mean the task failed.")
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
    : status === "running" ? (ko ? "이 Goal을 실행하고 있습니다" : "This Goal is running")
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
    : surface.state === "checking_effects" ? (ko ? "반영 여부 확인 중" : "Checking…")
    : surface.state === "blocked_uncertain" ? (ko ? "결과 확인 필요" : "Review outcome")
    : surface.state === "blocked" ? (ko ? "조치 필요" : "Needs action")
    : surface.state.startsWith("paused") ? (ko ? "일시정지" : "Paused")
    : surface.state === "verifying" ? (ko ? "검증 중" : "Verifying")
    : surface.state === "completed" ? (ko ? "완료" : "Completed")
    : surface.state === "failed" ? (ko ? "실패" : "Failed")
    : surface.state === "cancelled" ? (ko ? "종료" : "Stopped")
    : (ko ? "상태 확인 중" : "Checking status");
  const review = view.review;
  const closeReview = () => { session.current?.closeReview(); };
  // One sentence per state. Attempt IDs, timestamps and tool previews stay in
  // the ledger; the person only needs to know what happens if they continue.
  const reviewSentence = !review ? null
    : review.blocker === "running"
      ? (ko ? "아직 끝나지 않은 작업이 있어요. 끝나면 다시 눌러 주세요." : "A task is still finishing. Try again once it is done.")
    : review.blocker === "automation"
      ? (ko ? "예약 자동화가 붙은 목표라, 같은 게시가 두 번 나가지 않도록 여기서는 이어가지 않았어요."
        : "This goal has a scheduled automation, so it was not continued here to avoid posting the same thing twice.")
    : review.blocker === "too_many"
      ? (ko ? `멈춘 작업이 ${review.attempts.length}건이라 한 번에 이어갈 수 없어요. 목표는 멈춘 채로 둡니다.`
        : `${review.attempts.length} tasks were interrupted — too many to continue at once. The goal stays paused.`)
    : review.blocker === "missing_activity"
      ? (ko ? "일부 작업의 기록이 없어 안전하게 이어갈 수 없어요. 목표는 멈춘 채로 둡니다."
        : "Some tasks have no record, so it is not safe to continue. The goal stays paused.")
    : (ko ? `멈추기 전 작업 ${review.attempts.length}건은 이미 처리됐을 수 있어 다시 하지 않고, 다음 작업부터 이어갑니다.`
      : `The ${review.attempts.length} interrupted task(s) may already have gone through, so they will not be redone — work continues from the next step.`);
  const plainAutomationNote = surface.automation.reconciliationHold > 0
    ? (ko ? "예약 자동화 하나가 오류 뒤 멈춰 다음 실행이 잡혀 있지 않아요." : "A scheduled automation stopped after an error and has no next run.")
    : surface.automation.held > 0
      ? (ko ? "꺼 둔 예약에 남은 실행은 다시 돌리지 않아요." : "Runs left on a switched-off schedule are not replayed.")
      : null;
  return <section ref={rootRef} className={styles.root} aria-label={ko ? "목표" : "Goal"} data-one-goal-controls="true"
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
        aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}>?</button>
    </div>}
    {helpOpen && <div className={styles.help} role="dialog" data-goal-help="true" aria-label={ko ? "목표 상태 설명" : "Goal status explained"}>
      <p>{label}</p>
      <GoalPlanSummary plan={goalPlanOf(view.context)} locale={locale} />
      {view.context?.acceptanceCriteria.length ? <ul className={styles.helpCriteria} aria-label={ko ? "성공 기준" : "Success criteria"}>
        {view.context.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}
      </ul> : null}
      {plainAutomationNote && <p>{plainAutomationNote}</p>}
      <details className={styles.helpMore}>
        <summary>{ko ? "자세히" : "More"}</summary>
        {view.continuity && <GoalStrategyStatus continuity={view.continuity} surface={surface} locale={locale} />}
        {helpContent}
        {view.handoff && <p>{ko ? "다음 실행 모델" : "Next-run model"}: {view.handoff.effective?.model ?? view.handoff.requested.model ?? view.handoff.requested.kind}</p>}
        {lastConfirmedModel && <p>{ko ? "최근 실행 모델" : "Last run model"}: {lastConfirmedModel}</p>}
      </details>
    </div>}
    {review && <div className={styles.review} role="region" data-goal-review={review.blocker ?? "ready"}
      aria-label={ko ? "멈춘 작업 이어가기" : "Continue interrupted work"}>
      <p className={styles.reviewText}>{reviewSentence}</p>
      <div className={styles.reviewActions}>
        <button type="button" onClick={closeReview}>{review.blocker ? (ko ? "닫기" : "Close") : (ko ? "나중에" : "Not now")}</button>
        {!review.blocker && <button type="button" className={styles.reviewPrimary} data-goal-review-primary="true"
          disabled={view.pending !== null}
          onClick={() => { void session.current?.act("resume", {
            runId: review.runId, version: review.version, attemptIds: review.attemptIds,
            attemptSetDigest: review.attemptSetDigest, reviewedAttemptIds: review.attemptIds,
          }); }}>
          {view.pending === "resume" ? (ko ? "이어가는 중" : "Continuing") : ko ? "이어가기" : "Continue"}
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
        ? (ko ? "그사이 작업 상태가 바뀌었어요. 다시 눌러 주세요." : "The work changed in the meantime. Press it again.")
      : reviewRequired
        ? (ko ? "멈춘 작업을 먼저 정리해야 해요. 재개를 다시 눌러 주세요." : "The interrupted work needs settling first. Press Resume again.")
      : reviewUnverifiable
        ? (ko ? "일부 작업의 기록이 없어 안전하게 이어갈 수 없어요. 목표는 멈춘 채로 둡니다." : "Some tasks have no record, so it is not safe to continue. The goal stays paused.")
      : reviewTooLarge
        ? (ko ? "멈춘 작업이 너무 많아 한 번에 이어갈 수 없어요. 목표는 멈춘 채로 둡니다." : "Too many tasks were interrupted to continue at once. The goal stays paused.")
      : automationReviewRequired
        ? (ko ? "예약 자동화가 붙은 목표라, 같은 게시가 두 번 나가지 않도록 여기서는 이어가지 않았어요." : "This goal has a scheduled automation, so it was not continued here to avoid posting the same thing twice.")
      : uncertainResume
      ? (ko ? "이전 실행의 결과를 먼저 확인해야 합니다. 목표와 작업 기록은 보존되어 있습니다." : "The previous action's outcome needs confirmation first. Your goal and work history are preserved.")
      : lifecycleConfirmationUnavailable
        ? (ko ? "저장된 요청의 지속 목표 여부를 현재 모델로 확인하지 못해 재개하지 않았습니다. 목표와 작업 기록은 그대로 보존되어 있습니다. 모델 연결 상태를 확인한 뒤 다시 시도해 주세요." : "The current model could not confirm whether the saved request is ongoing, so the goal was not resumed. The goal and work history are preserved; check the model connection and try again.")
      : lifecycleNotOngoing
        ? (ko ? "저장된 요청에서 ‘중단 지시 전까지 계속’이라는 명시적 권한을 확인하지 못해 자동 다음 주기를 시작하지 않았습니다. 계속하려면 대화에 지속 기간을 명시해 새 지시를 보내 주세요." : "The saved request does not explicitly authorize continuing until you stop it, so no automatic next cycle was started. Send a new instruction that states the intended duration if you want ongoing work.")
      : (ko ? "목표 상태를 확인하거나 변경하지 못했습니다. 상태를 새로고침한 뒤 다시 시도해 주세요." : "The goal could not be checked or changed. Refresh its status, then try again.")}
      {/* The raw machine code stays reachable on hover for support, never as body text. */}
      {view.error && <span className={styles.errorCode} title={view.error} aria-hidden="true">ⓘ</span>}<button type="button" onClick={() => { void session.current?.refresh(true); }}>{ko ? "상태 새로고침" : "Refresh status"}</button></p>}
  </section>;
}
