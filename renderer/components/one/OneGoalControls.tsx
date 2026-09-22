"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentlasIpc, ChatContinuitySnapshot, ChatGoalContext, GoalRuntimeSelectionReceipt } from "../../../shared/types";
import { IconEdit, IconTarget, IconTrash } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import { failureMessage } from "@/lib/invocation-failure";
import { classifyGoalSurfaceStatus, goalSurfaceStatusLabel } from "@/lib/goal-surface-status";
import { GoalStrategyStatus } from "./GoalStrategyStatus";
import styles from "./OneGoalControls.module.css";

type GoalAction = "pause" | "delete" | "resume" | "edit";
type GoalView = { goalId: string | null; context: ChatGoalContext | null; continuity: ChatContinuitySnapshot | null; handoff: GoalRuntimeSelectionReceipt | null;
  observedAt: string | null; pending: GoalAction | null; error: string | null;
  errorKind: "observation" | "action" | null; refreshing: boolean };
type GoalBridge = Pick<AgentlasIpc["chats"], "get" | "getGoalContext" | "getGoalRuntimeSelection" | "pauseGoal" | "deleteGoal" | "resumeGoal" | "reviseGoal">
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
  let view: GoalView = { goalId: null, context: null, continuity: null, handoff: null, observedAt: null, pending: null, error: null, errorKind: null, refreshing: false };
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
        publish({ goalId: null, context: null, continuity: null, handoff: null, refreshing: false, error: null, errorKind: null });
        return;
      }
      const goalId = chat.goalId ?? null;
      if (!goalId) { publish({ goalId: null, context: null, continuity: null, handoff: null, refreshing: false, error: null, errorKind: null }); return; }
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
        publish({ goalId: null, context: null, continuity: null, handoff: null, refreshing: false, error: null, errorKind: null });
        return;
      }
      const stateChanged = view.goalId !== goalId || view.context?.version !== context?.version;
      publish({ context, continuity, handoff: handoff?.goalId === goalId ? handoff : null,
        observedAt: new Date().toISOString(), refreshing: false,
        ...(clearError || stateChanged || view.errorKind === "observation"
          ? { error: null, errorKind: null } : {}) });
    } catch (cause) {
      if (fresh()) publish({ refreshing: false, error: failureMessage(cause).slice(0, 240), errorKind: "observation" });
    }
  };
  const act = async (action: GoalAction) => {
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
        publish({ goalId: null, context: null, continuity: null, handoff: null });
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
            await input.api.resumeGoal(input.chatId, latest.version, goalId);
            resumed = true;
          } catch (cause) {
            if (attempt === 0 && /(?:^|:\s*)long_run_resume_version_conflict$/.test(failureMessage(cause))) continue;
            throw cause;
          }
        }
        if (!resumed) throw new Error("long_run_resume_version_conflict");
      }
    } catch (cause) {
      if (fresh()) publish({ error: failureMessage(cause).slice(0, 240), errorKind: "action" });
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
  return { refresh, act, revise, observedRunId: () => view.context?.runId,
    dispose: () => { live = false; ++readGeneration; ++actionGeneration; } };
}

export function OneGoalControls({ chatId, locale, isCurrent, onDeleted, lastConfirmedModel }: {
  chatId: string; locale: "ko" | "en"; isCurrent: () => boolean; onDeleted: () => void;
  /** From the latest durable invocation final, never the composer default. */
  lastConfirmedModel?: string | null;
}) {
  const [view, setView] = useState<GoalView>({ goalId: null, context: null, continuity: null, handoff: null, observedAt: null, pending: null, error: null, errorKind: null, refreshing: false });
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
  return <section className={styles.root} aria-label={ko ? "목표" : "Goal"} data-one-goal-controls="true"
    data-goal-observation={view.error || view.refreshing ? "stale" : observationFresh ? "confirmed" : "pending"}>
    {view.goalId && <div className={styles.bar}>
      <IconTarget size={13} />
      <strong>{ongoing ? (ko ? "지속 목표" : "Ongoing goal") : (ko ? "목표" : "Goal")}</strong>
      <span className={styles.label} title={label} role="status">{label}</span>
      {Boolean(view.context?.acceptanceCriteria.length) && <span className={styles.criteria}
        title={view.context!.acceptanceCriteria.join("\n")}>{ko ? `기준 ${view.context!.acceptanceCriteria.length}개` : `${view.context!.acceptanceCriteria.length} criteria`}</span>}
      {surface.automation.recentRunning > 0 && surface.state !== "active_run" && <span className={styles.criteria} role="status"
        title={ko ? "자동화의 최근 원장 기록은 이 Goal의 실행 증거가 아닙니다." : "A recent automation ledger row is not proof that this Goal is running."}>
        {ko ? `자동화 원장 최근 실행 ${surface.automation.recentRunning}개` : `${surface.automation.recentRunning} automation run(s) recently recorded`}
      </span>}
      {surface.automation.held > 0 && <span className={styles.criteria} role="status"
        title={ko ? "꺼진 예약에 남은 실행 기록은 자동 재실행하지 않습니다." : "A disabled schedule with a remaining run row is not replayed automatically."}>
        {ko ? `보류된 자동화 ${surface.automation.held}개` : `${surface.automation.held} automation(s) held`}
      </span>}
      {surface.automation.reconciliationHold > 0 && <span className={styles.criteria} role="status"
        title={ko ? "자동화 오류 뒤 다음 실행 시각이 없어 실행 내역 확인이 필요합니다." : "The automation errored without a next run time; review its run history before acting."}>
        {ko ? `자동화 조정 보류 ${surface.automation.reconciliationHold}개` : `${surface.automation.reconciliationHold} automation reconciliation hold(s)`}
      </span>}
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
    </div>}
    {view.handoff && <div className={styles.handoff} data-goal-model-state={view.handoff.state} role="status">
      {view.handoff.state === "applied"
        ? (ko ? `다음 실행 모델 적용 확인 · ${view.handoff.effective?.model ?? view.handoff.requested.model ?? view.handoff.requested.kind}`
          : `Next-run model applied · ${view.handoff.effective?.model ?? view.handoff.requested.model ?? view.handoff.requested.kind}`)
        : view.handoff.state === "claimed"
          ? (ko ? `다음 실행 모델 인계 중 · ${view.handoff.requested.model ?? view.handoff.requested.kind}`
            : `Next-run model handoff in progress · ${view.handoff.requested.model ?? view.handoff.requested.kind}`)
          : (ko ? `다음 안전한 실행에 모델 변경 대기 · ${view.handoff.requested.model ?? view.handoff.requested.kind}`
            : `Model change pending at the next safe run · ${view.handoff.requested.model ?? view.handoff.requested.kind}`)}
    </div>}
    {view.continuity && <GoalStrategyStatus continuity={view.continuity} surface={surface} locale={locale} />}
    {lastConfirmedModel && <p className={styles.stale}>{ko ? "최근 완료 실행에서 확인한 모델 · " : "Model confirmed in last finished run · "}{lastConfirmedModel}</p>}
    {view.observedAt && <p className={styles.stale} data-observation={view.error || view.refreshing ? "stale" : "confirmed"}>
      {view.error || view.refreshing ? (ko ? "목표 상태 재확인 중 · 마지막 확인 " : "Rechecking Goal status · last confirmed ")
        : (ko ? "목표 상태 확인 " : "Goal status checked ")}
      <time dateTime={view.observedAt}>{new Date(view.observedAt).toLocaleTimeString(ko ? "ko-KR" : "en-US")}</time>
    </p>}
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
