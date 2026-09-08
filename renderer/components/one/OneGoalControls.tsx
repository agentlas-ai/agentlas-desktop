"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentlasIpc, ChatGoalContext } from "../../../shared/types";
import { IconTarget, IconTrash } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import { failureMessage } from "@/lib/invocation-failure";
import styles from "./OneGoalControls.module.css";

type GoalAction = "pause" | "delete" | "resume";
type GoalView = { goalId: string | null; context: ChatGoalContext | null; pending: GoalAction | null; error: string | null };
type GoalBridge = Pick<AgentlasIpc["chats"], "get" | "getGoalContext" | "pauseGoal" | "deleteGoal" | "resumeGoal">;

/** A mounted view owns observations, never Goal authority. Old reads/actions
 * may finish in Main, but cannot paint a replacement chat or reset its draft. */
export function createOneGoalControlSession(input: {
  chatId: string; api: GoalBridge; isCurrent: () => boolean;
  publish: (view: GoalView) => void; onDeleted: () => void;
}) {
  let live = true;
  let readGeneration = 0;
  let actionGeneration = 0;
  let view: GoalView = { goalId: null, context: null, pending: null, error: null };
  const current = () => live && input.isCurrent();
  const publish = (patch: Partial<GoalView>) => {
    if (!current()) return;
    view = { ...view, ...patch };
    input.publish(view);
  };
  const refresh = async (clearError = false) => {
    const generation = ++readGeneration;
    const fresh = () => current() && generation === readGeneration;
    try {
      const chat = await input.api.get(input.chatId);
      if (!fresh()) return;
      if (!chat || chat.id !== input.chatId || chat.originSurface !== "one") {
        publish({ goalId: null, context: null, ...(clearError ? { error: null } : {}) });
        return;
      }
      const goalId = chat.goalId ?? null;
      if (!goalId) { publish({ goalId: null, context: null, ...(clearError ? { error: null } : {}) }); return; }
      // Keep deletion reachable even when the Goal has not been defined yet.
      publish({ goalId, ...(view.goalId !== goalId ? { context: null } : {}) });
      const context = await input.api.getGoalContext(input.chatId);
      if (!fresh()) return;
      const latest = await input.api.get(input.chatId);
      if (!fresh()) return;
      if (latest?.goalId !== goalId || (context && context.goalId !== goalId)) {
        publish({ goalId: null, context: null });
        return;
      }
      publish({ context, ...(clearError ? { error: null } : {}) });
    } catch (cause) {
      if (fresh()) publish({ error: failureMessage(cause).slice(0, 240) });
    }
  };
  const act = async (action: GoalAction) => {
    if (!current() || !view.goalId || view.pending === action || view.pending === "delete") return;
    const goalId = view.goalId;
    const version = view.context?.version;
    const generation = ++actionGeneration;
    ++readGeneration;
    const fresh = () => current() && generation === actionGeneration;
    publish({ pending: action, error: null });
    try {
      const chat = await input.api.get(input.chatId);
      if (!fresh()) return;
      if (chat?.id !== input.chatId || chat.goalId !== goalId) throw new Error("goal_control_binding_changed");
      if (action === "delete") {
        const updated = await input.api.deleteGoal(input.chatId, goalId);
        if (!fresh()) return;
        if (updated.id !== input.chatId || updated.goalId) throw new Error("goal_control_binding_changed");
        publish({ goalId: null, context: null });
        input.onDeleted();
      } else if (action === "pause") {
        await input.api.pauseGoal(input.chatId, goalId);
      } else {
        if (!version) throw new Error("long_run_resume_version_conflict");
        await input.api.resumeGoal(input.chatId, version, goalId);
      }
    } catch (cause) {
      if (fresh()) publish({ error: failureMessage(cause).slice(0, 240) });
    } finally {
      if (fresh()) {
        publish({ pending: null });
        await refresh();
      }
    }
  };
  return { refresh, act, observedRunId: () => view.context?.runId,
    dispose: () => { live = false; ++readGeneration; ++actionGeneration; } };
}

export function OneGoalControls({ chatId, locale, isCurrent, onDeleted }: {
  chatId: string; locale: "ko" | "en"; isCurrent: () => boolean; onDeleted: () => void;
}) {
  const [view, setView] = useState<GoalView>({ goalId: null, context: null, pending: null, error: null });
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
        || (change.entity === "long-run" && change.id === owner.observedRunId())) {
        schedule();
      }
    });
    refresh();
    return () => { disposed = true; owner.dispose(); unsubscribe?.(); clearTimeout(timer); session.current = null; };
  }, [chatId]);
  if (!view.goalId && !view.error) return null;
  const ko = locale === "ko";
  // Electron serializes IPC failures into an error message. This exact code
  // mapping changes explanation only; Main alone decides whether resume runs.
  const uncertainResume = /(?:^|:\s*)auto_goal_resume_attempt_unsettled$/.test(view.error ?? "");
  const status = view.context?.runStatus;
  const resumable = status === "paused" || status === "blocked";
  const pausable = Boolean(status && !["paused", "pausing", "blocked", "completed", "failed", "cancelled", "cancelling"].includes(status));
  const label = view.pending === "delete" ? (ko ? "목표를 삭제하는 중" : "Deleting goal")
    : status === "pausing" || view.pending === "pause" ? (ko ? "멈추는 중 · 목표는 보존됩니다" : "Stopping · goal preserved")
    : status === "paused" ? (ko ? "일시정지됨" : "Paused")
    : status === "blocked" ? (ko ? "진행이 멈췄습니다 · 재개 전 상태 확인이 필요합니다" : "Blocked · check the outcome before resuming")
    : status === "verifying" ? (ko ? "결과를 성공 기준과 대조하는 중" : "Checking the result against acceptance criteria")
    : view.context?.objective || (ko ? "다음 요청으로 목표를 확정합니다" : "Your next request will define the goal");
  return <section className={styles.root} aria-label={ko ? "목표" : "Goal"} data-one-goal-controls="true">
    {view.goalId && <div className={styles.bar}>
      <IconTarget size={13} />
      <strong>{ko ? "목표" : "Goal"}</strong>
      <span className={styles.label} title={label} role="status">{label}</span>
      {Boolean(view.context?.acceptanceCriteria.length) && <span className={styles.criteria}
        title={view.context!.acceptanceCriteria.join("\n")}>{ko ? `기준 ${view.context!.acceptanceCriteria.length}개` : `${view.context!.acceptanceCriteria.length} criteria`}</span>}
      {pausable && <button type="button" aria-label={ko ? "목표 일시정지" : "Pause goal"}
        onClick={() => { void session.current?.act("pause"); }}>{ko ? "일시정지" : "Pause"}</button>}
      {resumable && <button type="button" disabled={view.pending === "resume" || !view.context?.version}
        aria-label={ko ? "목표 수동 재개" : "Resume goal manually"}
        onClick={() => { void session.current?.act("resume"); }}>{view.pending === "resume" ? (ko ? "확인 중" : "Checking") : ko ? "재개" : "Resume"}</button>}
      <button type="button" aria-label={ko ? "목표 삭제" : "Delete goal"}
        title={ko ? "목표를 삭제합니다. 대화와 작업 파일은 유지됩니다" : "Delete the goal; keep the conversation and files"}
        onClick={() => { void session.current?.act("delete"); }}><IconTrash size={13} /></button>
    </div>}
    {view.error && <p className={styles.error} role="alert">{uncertainResume
      ? (ko ? "이전 실행의 결과를 먼저 확인해야 합니다. 목표와 작업 기록은 보존되어 있습니다." : "The previous action's outcome needs confirmation first. Your goal and work history are preserved.")
      : (ko ? "목표 상태를 확인하거나 변경하지 못했습니다. 상태를 새로고침한 뒤 다시 시도해 주세요." : "The goal could not be checked or changed. Refresh its status, then try again.")}
      <span>{view.error}</span><button type="button" onClick={() => { void session.current?.refresh(true); }}>{ko ? "상태 새로고침" : "Refresh status"}</button></p>}
  </section>;
}
