"use client";

import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AgentlasIpc, ChatContinuitySnapshot, ChatGoalContext, GoalResumeConfirmation, GoalResumeReview, GoalRuntimeSelectionReceipt } from "../../../shared/types";
import { goalObjectiveText } from "../../../shared/auto-goal";
import { confirmGoalResumeReview } from "../../../shared/goal-resume-review";
import { IconEdit, IconTarget, IconTrash } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import { failureMessage } from "@/lib/invocation-failure";
import { navigate } from "@/lib/navigation";
import { classifyGoalSurfaceStatus, goalSurfaceStatusLabel } from "@/lib/goal-surface-status";
import { GoalStrategyStatus } from "./GoalStrategyStatus";
import { GoalPlanSummary, goalPlanOf } from "@/components/goal/GoalPlanSummary";
import { goalNextWakeLabel, goalNextWakeOf } from "@shared/goal-wake";
import { goalHeldForOwnerGrant } from "@shared/goal-display-state";
import { requestGoalPanelOpen } from "@/components/goal/GoalPanel";
import styles from "./OneGoalControls.module.css";
import { AgiDefectChip } from "../agi/AgiBugReport";

type GoalAction = "pause" | "delete" | "resume" | "edit";

/** Re-read-and-retry passes for a Resume that lost an exact version race to a host write (attempt settlement, a sweep tick). */
const GOAL_RESUME_VERSION_ATTEMPTS = 3;

/** The machine code at the end of an IPC failure message ("Error invoking remote method 'x': Error: code"), or null. */
export function goalErrorCode(message: string | null | undefined): string | null {
  const match = /(?:^|:\s*)([a-z][a-z0-9_]*(?::[a-z0-9_-]+)?)\s*$/.exec(message ?? "");
  return match ? match[1] : null;
}

/**
 * What the Goal bar says after a failed read or action: one plain sentence per machine code, never "refresh and try again"
 * for a state the app settles by itself (owner 2026-10-25: the bar must always be actionable). Main alone decides what
 * runs; this only explains. Unknown codes say what was attempted and that the state shown above is current.
 */
export function goalControlErrorText(input: { code: string | null; kind: "observation" | "action" | null; locale: "ko" | "en" }): string {
  const ko = input.locale === "ko";
  const code = input.code ?? "";
  const family = code.split(":")[0];
  if (input.kind === "observation") {
    return ko ? "목표 상태를 읽지 못했어요. 앱이 몇 초마다 다시 읽고, 읽히면 이 안내는 사라집니다."
      : "The goal's state could not be read. The app reads it again every few seconds; this note clears once it does.";
  }
  switch (family) {
    case "goal_owner_grant_required":
      return ko ? "이 방에서 보내신 지시가 아직 하나도 없어 어떤 권한으로 이어갈지 알 수 없어요. 이 방에 메시지를 보내 주시면 그 메시지로 목표를 이어갑니다."
        : "You have not sent anything in this room yet, so there is no permission on record to continue under. Send a message here and the goal continues from it.";
    case "long_run_resume_version_conflict":
    case "long_run_transition_version_conflict":
    case "long_run_transition_conflict":
    case "long_run_transition_invalid":
    case "long_run_resume_not_allowed":
    case "auto_goal_resume_not_stopped":
    case "goal_edit_state_changed":
    case "goal_stop_in_progress":
      return ko ? "누르는 사이 목표 상태가 바뀌었어요. 위에 보이는 것이 지금 상태이고, 버튼도 그 상태 기준입니다."
        : "The goal changed state while you pressed it. What is shown above is the current state, and the buttons follow it.";
    case "auto_goal_resume_attempt_live":
    case "goal_edit_requires_pause":
    case "long_run_transition_owner_conflict":
      return ko ? "이 목표의 단계 하나가 아직 끝나는 중이에요. 끝나면 목표는 스스로 이어지고, 위 상태가 바뀝니다."
        : "A step of this goal is still finishing. When it ends the goal carries on by itself and the state above updates.";
    case "long_run_resume_dispatch_unavailable":
      return ko ? "지금 바로 실행을 시작하지 못했어요. 목표는 대기열에 남아 있고 앱이 스스로 다시 시작합니다."
        : "A run could not be started right now. The goal stays queued and the app starts it again by itself.";
    case "desktop_long_run_admission_closed":
      return ko ? "앱이 시작하거나 종료하는 중이라 목표 작업을 받지 않았어요. 준비가 끝나면 다시 누를 수 있어요."
        : "The app is starting up or shutting down, so it did not take goal actions. Press again once it is ready.";
    case "goal_control_scope_mismatch":
    case "science_projection_read_only":
      return ko ? "이 목표는 Science가 관리해요. Science 화면에서 멈추거나 이어가 주세요."
        : "Science manages this goal. Pause or continue it from the Science screen.";
    case "goal_control_not_started":
      return ko ? "아직 시작되지 않은 목표라 멈출 것이 없어요." : "This goal has not started, so there is nothing to pause.";
    case "goal_edit_objective_required":
    case "goal_objective_invalid":
      return ko ? "목표 문장을 확인해 주세요." : "Check the goal text.";
    default:
      return ko ? `목표를 바꾸지 못했어요${code ? ` (${code})` : ""}. 위에 보이는 것이 지금 상태예요.`
        : `The goal was not changed${code ? ` (${code})` : ""}. What is shown above is its current state.`;
  }
}
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
  /** Main accepted pause or delete, which also drops the directions queued behind the run (stopGoal). */
  onStopped?: () => void;
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
        input.onStopped?.();
      } else if (action === "pause") {
        await input.api.pauseGoal(input.chatId, goalId);
        if (fresh()) input.onStopped?.();
      } else {
        // Goal events can advance the long-run CAS version after the button
        // rendered (for example, app-close recovery or attempt settlement).
        // Re-read immediately before resume and retry one exact version race;
        // the goal identity is checked on every pass, so this never resumes a
        // replacement Goal or widens the user's command.
        let resumed = false;
        for (let attempt = 0; attempt < GOAL_RESUME_VERSION_ATTEMPTS && !resumed; attempt += 1) {
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
            if (attempt < GOAL_RESUME_VERSION_ATTEMPTS - 1 && /(?:^|:\s*)long_run_resume_version_conflict$/.test(failureMessage(cause))) continue;
            throw cause;
          }
        }
        if (!resumed) throw new Error("long_run_resume_version_conflict");
      }
    } catch (cause) {
      // The chat's Goal changed under the click (replaced, deleted elsewhere, phone): that is new state to show, not a failure
      // to report. The refresh below paints whatever the chat holds now.
      if (fresh() && goalErrorCode(failureMessage(cause)) !== "goal_control_binding_changed") {
        publish({ error: failureMessage(cause).slice(0, 240), errorKind: "action", review: null });
      } else if (fresh()) publish({ review: null });
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

/** Whether the Goal bar may arm Resume/Pause/Edit: a confirmed read exists and the latest READ did not fail. A failed action
 * is followed by a re-read, so it never disarms the controls (see the component's comment). */
export function goalObservationFresh(view: Pick<GoalView, "observedAt" | "context" | "errorKind">): boolean {
  return Boolean(view.observedAt && view.context && view.errorKind !== "observation");
}

/** A queued Goal model change is visible until the durable handoff reports
 * `applied`, or the latest confirmed run already used the requested model. */
export function goalModelChangePending(input: {
  ongoing: boolean; handoff: GoalRuntimeSelectionReceipt | null; lastConfirmedModel?: string | null;
}): boolean {
  const { handoff } = input;
  if (!input.ongoing || !handoff || handoff.state === "applied") return false;
  return !(handoff.requested.model && input.lastConfirmedModel === handoff.requested.model);
}

export function OneGoalControls({ chatId, locale, isCurrent, onDeleted, onStopped, lastConfirmedModel, helpContent, handoffRequestKey }: {
  chatId: string; locale: "ko" | "en"; isCurrent: () => boolean; onDeleted: () => void;
  /** Called after Main accepted pause or delete; directions queued behind the run were dropped with it. */
  onStopped?: () => void;
  /** Bumped by the composer after Main acknowledges a Goal model handoff. */
  handoffRequestKey?: number;
  /** From the latest durable invocation final, never the composer default. */
  lastConfirmedModel?: string | null;
  helpContent?: ReactNode;
}) {
  const [view, setView] = useState<GoalView>({ goalId: null, context: null, continuity: null, handoff: null, observedAt: null, pending: null, error: null, errorKind: null, refreshing: false, review: null });
  const [helpOpen, setHelpOpen] = useState(false);
  const [modelNoteOpen, setModelNoteOpen] = useState(false);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const modelNoteId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const [helpPlacement, setHelpPlacement] = useState<"above" | "below">("above");
  useLayoutEffect(() => {
    if (!helpOpen && !modelNoteOpen) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) setHelpPlacement(rect.top < Math.min(360, window.innerHeight / 2) ? "below" : "above");
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [helpOpen, modelNoteOpen]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const callbacks = useRef({ isCurrent, onDeleted, onStopped });
  callbacks.current = { isCurrent, onDeleted, onStopped };
  const session = useRef<ReturnType<typeof createOneGoalControlSession> | null>(null);
  useEffect(() => {
    const api = ipc();
    if (!api) return;
    const owner = createOneGoalControlSession({ chatId, api: api.chats,
      isCurrent: () => callbacks.current.isCurrent(), publish: setView,
      onDeleted: () => callbacks.current.onDeleted(), onStopped: () => callbacks.current.onStopped?.() });
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
  // The composer's acknowledgement is not a Goal observation: re-read the
  // durable handoff so the pending chip reflects Main, not the click.
  useEffect(() => {
    if (handoffRequestKey) void session.current?.refresh();
  }, [handoffRequestKey]);
  useEffect(() => {
    if (!modelNoteOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setModelNoteOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setModelNoteOpen(false);
      modelChipRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [modelNoteOpen]);
  useEffect(() => {
    if (view.review) setHelpOpen(false);
  }, [view.review?.version]);
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
  const reviewChanged = /(?:^|:\s*)automation_goal_execution_review_changed$/.test(view.error ?? "");
  const reviewRequired = /(?:^|:\s*)automation_goal_execution_review_required$/.test(view.error ?? "");
  const ownershipReviewUnavailable = /(?:^|:\s*)automation_goal_execution_review_unavailable$/.test(view.error ?? "");
  const automationSetupRequired = /(?:^|:\s*)automation_goal_execution_setup_required$/.test(view.error ?? "");
  // goal_owner_grant_required and every other code without its own line below: goalControlErrorText.
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
  // A failed ACTION is different: the session re-reads the Goal right after it, so the context is fresh and the buttons
  // must stay. Before, any action error made the bar say "Checking" with no Resume or Pause until the owner pressed
  // "Refresh status" (production 2026-10-24 X Marketing: "Goal Checking" under a paused Goal). A background re-read in
  // flight does not hide the controls either: every action re-reads and Main fences on the version.
  const observationFresh = goalObservationFresh(view);
  const ownerGrantHeld = goalHeldForOwnerGrant({ status: view.context?.runStatus, blockedReason: view.context?.blockedReason });
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
  const ownershipReviewPending = status === "running" && view.context?.automationOwnershipReviewRequired === true;
  const resumable = observationFresh && (status === "paused" || status === "blocked" || ownershipReviewPending || ownerGrantHeld) && !claimedWaitNeedsReview;
  const pausable = observationFresh && Boolean(status && !["paused", "pausing", "blocked", "completed", "failed", "cancelled", "cancelling"].includes(status));
  const editable = observationFresh && Boolean(view.context?.goalRevision && view.context?.version && (status === "paused" || status === "blocked" || status === "queued" || status === "waiting_user" || status === "draft"));
  const ongoing = view.context?.lifecycle === "ongoing";
  const timedWait = status === "waiting_tool" && view.context?.wait?.state === "pending" && view.context.wait.subjectKind === "timer";
  const nextCheckAt = view.context?.wait?.nextCheckAt;
  const nextCheck = nextCheckAt && Number.isFinite(Date.parse(nextCheckAt))
    ? new Date(nextCheckAt).toLocaleString(ko ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const label = view.pending === "delete" ? (ko ? "목표를 삭제하는 중" : "Deleting goal")
    : view.pending === "pause" ? (ko ? "멈추는 중 · 목표는 보존됩니다" : "Stopping · goal preserved")
    : !observationFresh ? (ko ? "Goal 상태를 다시 확인하는 중" : "Rechecking Goal state")
    : status === "pausing" ? (ko ? "멈추는 중 · 목표는 보존됩니다" : "Stopping · goal preserved")
    : ownerGrantHeld ? (ko ? "오너 지시 없이 만들어진 목표라 아직 시작하지 않았어요 · 이어가기를 누르면 시작합니다"
      : "Set up without an instruction from you, so it has not started · press Resume to start it")
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
    : timedWait ? (ko ? `작동 중 · 다음 확인 ${nextCheck ?? "예정"}` : `Running · next check ${nextCheck ?? "scheduled"}`)
    : status === "waiting_tool" ? (ko ? "이 Goal의 도구 결과 대기 중" : "Waiting for this Goal's tool result")
    : status === "queued" ? (ko ? "이 Goal의 다음 실행 준비 중" : "Preparing this Goal's next run")
    : status === "running" ? (ko ? "이 Goal을 실행하고 있습니다" : "This Goal is running")
    : view.context?.objective || (ko ? "다음 요청으로 목표를 확정합니다" : "Your next request will define the goal");
  const shortStatus = view.pending ? (ko ? "처리 중" : "Working")
    : !observationFresh ? (ko ? "확인 중" : "Checking")
    : status === "blocked" && verificationUnavailable ? (ko ? "검증 오류" : "Verification error")
    // Between turns looks exactly like running (owner 2026-09-28: "작동 중과 똑같게").
    : surface.state === "active_run" || surface.state === "active_idle" ? (ko ? "실행 중" : "Running")
    : surface.state === "needs_owner" ? (ko ? "확인 필요" : "Needs you")
    : surface.state === "active_unconfirmed" ? (ko ? "실행 확인 중" : "Checking run")
    : surface.state === "queued" ? (ko ? "준비 중" : "Queued")
    : surface.state === "waiting_confirmation" ? (ko ? "확인 필요" : "Confirm")
    : surface.state === "checking_effects" ? (ko ? "반영 여부 확인 중" : "Checking…")
    : surface.state === "blocked_uncertain" ? (ko ? "결과 확인 필요" : "Review outcome")
    : surface.state === "blocked" ? (ko ? "조치 필요" : "Needs action")
    : surface.state.startsWith("paused") ? (ko ? "일시정지" : "Paused")
    : surface.state === "verifying" ? (ko ? "검증 중" : "Verifying")
    : surface.state === "completed" ? (ko ? "완료" : "Completed")
    : surface.state === "failed" ? (ko ? "실패" : "Failed")
    : surface.state === "cancelled" ? (ko ? "종료" : "Stopped")
    : (ko ? "상태 확인 중" : "Checking status");
  const modelPending = goalModelChangePending({ ongoing, handoff: view.handoff, lastConfirmedModel });
  const pendingModel = view.handoff?.requested.model ?? view.handoff?.requested.kind ?? null;
  const review = view.review;
  const closeReview = () => { session.current?.closeReview(); };
  // One sentence per state: the person only needs to know what happens if they continue.
  const reviewSentence = !review ? null
    : review.blocker === "running"
      ? (ko ? "아직 끝나지 않은 작업이 있어요. 끝나면 다시 눌러 주세요." : "A task is still finishing. Try again once it is done.")
    : review.blocker === "automation_setup"
      ? review.automationSetup?.reason === "runtime"
        ? (ko ? "자동화가 사용할 모델을 선택해 저장한 뒤 다시 연결을 확인해 주세요." : "Choose and save the automation's model, then return to review its connection.")
        : (ko ? "자동화가 실행할 Hub 버전과 설정을 저장한 뒤 다시 연결을 확인해 주세요." : "Save the automation's Hub version and settings, then return to review its connection.")
    : review.blocker === "automation"
      ? (ko ? "예약 자동화가 붙은 목표라, 같은 게시가 두 번 나가지 않도록 여기서는 이어가지 않았어요."
        : "This goal has a scheduled automation, so it was not continued here to avoid posting the same thing twice.")
    : (ko ? "이 Goal과 함께 재개하고 멈출 자동화를 확인해 주세요." : "Confirm the automation that will resume and stop with this Goal.");
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
      <AgiDefectChip chatId={chatId} locale={locale} />
      {modelPending && <button type="button" ref={modelChipRef} className={styles.modelChip} data-goal-model-pending="true"
        aria-expanded={modelNoteOpen} aria-controls={modelNoteId} aria-describedby={modelNoteOpen ? modelNoteId : undefined}
        aria-label={ko ? "모델 변경 대기 — 설명 보기" : "Model change pending — show details"}
        onClick={() => { setHelpOpen(false); setModelNoteOpen((open) => !open); }}
        onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) { setHelpOpen(false); setModelNoteOpen(true); } }}
        onBlur={(event) => { if (!(event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget))) setModelNoteOpen(false); }}>
        <span className={styles.modelSpinner} aria-hidden="true" />
        <span className={styles.modelChipText}>{ko ? "모델 변경 대기" : "Model change pending"}</span>
      </button>}
      {pausable && <button type="button" aria-label={ko ? "목표 일시정지" : "Pause goal"}
        onClick={() => { void session.current?.act("pause"); }}>{ko ? "일시정지" : "Pause"}</button>}
      {resumable && <button type="button" disabled={view.pending === "resume" || !view.context?.version}
        aria-label={ownershipReviewPending ? (ko ? "자동화 연결 확인" : "Review automation connection") : needsOngoingConfirmation
          ? ongoing
            ? (ko ? "저장된 지속 목표 확인 후 재개" : "Confirm saved ongoing goal and resume")
            : (ko ? "저장된 목표 검토 후 재개" : "Review saved goal before resuming")
          : (ko ? "목표 수동 재개" : "Resume goal manually")}
        onClick={() => { void session.current?.act("resume"); }}>{view.pending === "resume" ? (ko ? "확인 중" : "Checking")
          : ownershipReviewPending ? (ko ? "자동화 연결 확인" : "Review automation connection")
          : ownerGrantHeld ? (ko ? "확인하고 시작" : "Confirm and start")
          : needsOngoingConfirmation && ongoing ? (ko ? "지속 목표 확인 후 재개" : "Confirm ongoing goal")
          : needsOngoingConfirmation ? (ko ? "목표 검토 후 재개" : "Review goal before resuming")
          : ko ? "재개" : "Resume"}</button>}
      {/* 편집 = 오른쪽 "목표" 탭(목표 전용 패널, 오너 2026-09-28). 패널이 없는 화면에서만 예전 편집기. */}
      <button type="button" disabled={view.pending !== null} aria-label={ko ? "목표 편집" : "Edit goal"} data-goal-chip-edit="true"
        title={ko ? "목표 패널에서 편집" : "Edit in the goal panel"}
        onClick={() => { if (!requestGoalPanelOpen(chatId)) { setDraft(goalObjectiveText(view.context?.objective ?? "")); setEditing(true); } }}><IconEdit size={13} /></button>
      <button type="button" aria-label={ko ? "목표 삭제" : "Delete goal"}
        title={ko ? "목표를 삭제합니다. 대화와 작업 파일은 유지됩니다" : "Delete the goal; keep the conversation and files"}
        onClick={() => { void session.current?.act("delete"); }}><IconTrash size={13} /></button>
      <button type="button" className={styles.helpButton} aria-label={ko ? "목표 상태 도움말" : "Goal status help"}
        aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => { setModelNoteOpen(false); setHelpOpen((open) => !open); }}>?</button>
    </div>}
    {view.goalId && (() => {
      // When the host will next start a turn for this Goal and who asked for that time (wake-arbiter).
      const wake = goalNextWakeOf(view.context);
      return wake ? <p className={styles.nextWake} data-goal-next-wake={wake.requestedBy}>{goalNextWakeLabel(wake, locale)}</p> : null;
    })()}
    {modelPending && modelNoteOpen && <div id={modelNoteId} className={styles.help} data-placement={helpPlacement} role="tooltip" data-goal-model-note="true">
      <p><strong>{ko ? "모델 변경 대기 중" : "Model change pending"}</strong>{pendingModel ? ` · ${pendingModel}` : ""}</p>
      <div className={styles.modelTimeline}><span>{ko ? "현재 실행" : "Current run"}<strong>{ko ? "기존 모델" : "Current model"}</strong></span><b aria-hidden="true">→</b><span>{ko ? "다음 안전한 실행" : "Next safe run"}<strong>{pendingModel || (ko ? "새 모델" : "New model")}</strong></span></div>
      <details className={styles.helpMore}><summary>{ko ? "자동화 적용 범위" : "Automation scope"}</summary><p>{ko ? "이 목표가 만든 자동화도 다음 실행부터 적용됩니다. 직접 모델을 지정한 자동화는 유지됩니다." : "Automations created by this Goal follow from their next run. Explicit automation model choices stay unchanged."}</p></details>
    </div>}
    {helpOpen && <div className={styles.help} data-placement={helpPlacement} role="dialog" data-goal-help="true" aria-label={ko ? "목표 상태 설명" : "Goal status explained"}>
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
      {review.automationOwnership && <div style={{ flexBasis: "100%", minWidth: 0, overflowWrap: "anywhere" }} data-goal-automation-owner-review={review.automationOwnership.automationId}>
        <p>{ko ? `‘${review.automationOwnership.title}’ 자동화를 이 Goal에 연결합니다. Goal을 멈추면 이 자동화의 실행도 멈춥니다.`
          : `Connect “${review.automationOwnership.title}” to this Goal. Stopping the Goal will also stop this automation's execution.`}</p>
        <small>{review.automationOwnership.automationId} · {new Date(review.automationOwnership.automationCreatedAt).toLocaleString(locale)}</small>
      </div>}
      <div className={styles.reviewActions}>
        <button type="button" onClick={closeReview}>{review.blocker ? (ko ? "닫기" : "Close") : (ko ? "나중에" : "Not now")}</button>
        {review.blocker === "automation_setup" && review.automationSetup && <button type="button"
          data-goal-automation-setup="true" onClick={() => navigate(review.automationSetup!.reason === "runtime"
            ? `/automation/new?id=${encodeURIComponent(review.automationSetup!.automationId)}#execution-ai`
            : `/automation/flow?id=${encodeURIComponent(review.automationSetup!.automationId)}`)}>
          {ko ? "자동화 설정 열기" : "Open automation settings"}
        </button>}
        {!review.blocker && <button type="button" className={styles.reviewPrimary} data-goal-review-primary="true"
          disabled={view.pending !== null}
          onClick={() => { void session.current?.act("resume", confirmGoalResumeReview(review)); }}>
          {view.pending === "resume" ? (ko ? "이어가는 중" : "Continuing") : review.automationOwnership
            ? (ko ? "연결 확인 후 이어가기" : "Confirm connection and continue") : ko ? "이어가기" : "Continue"}
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
      : reviewChanged
        ? (ko ? "그사이 작업 상태가 바뀌었어요. 다시 눌러 주세요." : "The work changed in the meantime. Press it again.")
      : reviewRequired
        ? (ko ? "자동화 연결을 먼저 확인해야 해요. 재개를 다시 눌러 주세요." : "The automation connection needs review first. Press Resume again.")
      : ownershipReviewUnavailable
        ? (ko ? "자동화와 Goal의 연결을 확인할 수 없습니다. 최신 목표와 자동화 설정을 확인한 뒤 다시 이어가 주세요."
          : "The automation's connection to this Goal could not be verified. Check the current Goal and automation settings, then continue again.")
      : automationSetupRequired
        ? (ko ? "자동화 모델과 실행 대상 설정이 필요합니다. 다시 재개를 누르면 설정 화면을 열 수 있습니다."
          : "The automation's model or target needs configuration. Press Resume again to open its settings.")
      : lifecycleConfirmationUnavailable
        ? (ko ? "저장된 요청의 지속 목표 여부를 현재 모델로 확인하지 못해 재개하지 않았습니다. 목표와 작업 기록은 그대로 보존되어 있습니다. 모델 연결 상태를 확인한 뒤 다시 시도해 주세요." : "The current model could not confirm whether the saved request is ongoing, so the goal was not resumed. The goal and work history are preserved; check the model connection and try again.")
      : lifecycleNotOngoing
        ? (ko ? "저장된 요청에서 ‘중단 지시 전까지 계속’이라는 명시적 권한을 확인하지 못해 자동 다음 주기를 시작하지 않았습니다. 계속하려면 대화에 지속 기간을 명시해 새 지시를 보내 주세요." : "The saved request does not explicitly authorize continuing until you stop it, so no automatic next cycle was started. Send a new instruction that states the intended duration if you want ongoing work.")
      : goalControlErrorText({ code: goalErrorCode(view.error), kind: view.errorKind, locale })}
      {/* The raw machine message stays reachable on hover for support, never as body text. */}
      {view.error && <span className={styles.errorCode} title={view.error} aria-hidden="true">ⓘ</span>}<button type="button" disabled={view.refreshing}
        data-goal-refresh="true" onClick={() => { void session.current?.refresh(true); }}>{view.refreshing ? (ko ? "읽는 중" : "Reading…") : view.errorKind === "action" ? (ko ? "닫기" : "Dismiss") : (ko ? "상태 새로고침" : "Refresh status")}</button></p>}
  </section>;
}
