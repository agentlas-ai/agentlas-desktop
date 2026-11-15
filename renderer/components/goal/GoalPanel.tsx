"use client";

/**
 * 목표 전용 패널 — 오른쪽 패널의 "목표" 탭(One·Work). 오너 2026-09-28: "목표 전용 패널을 만들어서 미니멀하게
 * 최종목표, 전략전술, 하위목표 등을 짜서 목표 칩 편집 누르면 나오던지".
 *
 * Main 읽기 모델(shared/goal-panel.ts GoalPanelView)만 그리고, 바꾸는 것은 전부 형식 있는 편집 하나(goalPanel.edit)로
 * Main 에 보낸다 — 화면은 원장 행을 직접 쓰지 않는다. 무거운 카드 없이 글자 위계·가는 선·기존 토큰만 쓴다.
 * 상태 규칙: 예약 실행 사이는 "실행 중", 오너가 멈춘 것만 "일시정지"(024e17ee).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { createCoalescedRefresh } from "@/lib/one-refresh-coordinator";
import { IconArrowUp, IconCheck, IconEdit, IconPlus, IconTrash } from "@/components/Icon";
import type { GoalPanelEdit, GoalPanelEditResult, GoalPanelNode, GoalPanelText, GoalPanelView } from "@shared/goal-panel";
import styles from "./GoalPanel.module.css";

type Locale = "ko" | "en";

export const GOAL_PANEL_OPEN_EVENT = "agentlas:goal-panel-open";

/** 목표 칩의 편집 — 오른쪽 패널이 떠 있으면 "목표" 탭을 연다. 받는 쪽이 없으면 false(칩은 예전 편집기로). */
export function requestGoalPanelOpen(chatId: string | null | undefined): boolean {
  if (!chatId || typeof window === "undefined") return false;
  const detail = { chatId, handled: false };
  window.dispatchEvent(new CustomEvent(GOAL_PANEL_OPEN_EVENT, { detail }));
  return detail.handled;
}

/** 이 대화의 목표 패널 읽기 모델. store:changed {chat(이 대화)|long-run} 에 다시 읽는다 — 폴링 없음. */
export function useGoalPanel(chatId: string | null): { view: GoalPanelView | null; refresh: () => void; replace: (view: GoalPanelView | null) => void } {
  const [view, setView] = useState<GoalPanelView | null>(null);
  const generation = useRef(0);
  const currentChatId = useRef(chatId);
  currentChatId.current = chatId;
  const readerRef = useRef<{ chatId: string | null; request(): void } | null>(null);
  const refresh = useCallback(() => {
    if (currentChatId.current === chatId && readerRef.current?.chatId === chatId) readerRef.current.request();
  }, [chatId]);
  useEffect(() => {
    let disposed = false;
    const currentChat = () => !disposed && currentChatId.current === chatId;
    const reader = createCoalescedRefresh<number>(async (current) => {
      if (!currentChat() || current !== generation.current) return;
      const read = ipc()?.goalPanel?.view;
      if (!chatId || !read) { setView(null); return; }
      try {
        const next = await read(chatId);
        if (next && next.chatId !== chatId) return;
        if (currentChat() && current === generation.current) setView(next ?? null);
      } catch { /* Keep the last confirmed panel when an observation fails. */ }
    }, (_previous, incoming) => incoming);
    const owner = { chatId, request() {
      if (currentChat()) void reader.request(++generation.current);
    } };
    readerRef.current = owner;
    setView(null);
    owner.request();
    const off = ipcEvents()?.onStoreChanged?.((change) => {
      if ((change.entity === "chat" && (!change.id || change.id === chatId)) || change.entity === "long-run") refresh();
    });
    return () => { disposed = true; ++generation.current; reader.dispose(); off?.(); if (readerRef.current === owner) readerRef.current = null; };
  }, [chatId, refresh]);
  const replace = useCallback((next: GoalPanelView | null) => {
    if (currentChatId.current !== chatId || readerRef.current?.chatId !== chatId || (next && next.chatId !== chatId)) return;
    generation.current += 1;
    setView(next);
  }, [chatId]);
  return { view, refresh, replace };
}

const t = (text: GoalPanelText | null | undefined, locale: Locale) => (text ? text[locale] : "");

function stateLabel(view: GoalPanelView, locale: Locale): string {
  const ko = locale === "ko";
  switch (view.state) {
    case "running": return ko ? "실행 중" : "Running";
    case "paused": return ko ? "일시정지" : "Paused";
    case "needs_owner": return view.ownerAttention === "review" ? (ko ? "완료 조건 검토" : "Review criteria")
      : view.ownerAttention === "question" ? (ko ? "답변 대기" : "Waiting for your answer")
      : view.ownerAttention === "approval" ? (ko ? "승인 대기" : "Waiting for approval")
      : view.ownerAttention === "budget" ? (ko ? "예산 한도" : "Budget limit") : (ko ? "확인 필요" : "Needs you");
    case "blocked": return ko ? "막힘" : "Blocked";
    case "terminal": return t(view.stateReason, locale) || (ko ? "끝남" : "Ended");
    default: return ko ? "준비 중" : "Not started";
  }
}

function nodeStateLabel(node: GoalPanelNode, locale: Locale): string {
  const ko = locale === "ko";
  if (node.state === "done") return ko ? "완료" : "Done";
  if (node.state === "paused") return ko ? "일시정지" : "Paused";
  if (node.state === "blocked") return ko ? "막힘" : "Blocked";
  return ko ? "실행 중" : "Running";
}

const ERROR_TEXT: Record<string, [string, string]> = {
  goal_panel_last_open_node: ["마지막으로 진행 중인 항목은 중지하거나 삭제할 수 없어요.", "The last item in progress cannot be paused or removed here."],
  goal_panel_plan_changed: ["계획이 변경됐어요. 최신 계획으로 다시 시도해 주세요.", "The plan changed. Try again on the latest plan."],
  goal_panel_plan_behind_revision: ["계획을 다시 나눈 뒤에 편집할 수 있어요.", "Edit the plan after it is divided again."],
  goal_panel_goal_ended: ["끝난 목표는 바꿀 수 없어요.", "An ended goal cannot be changed."],
  goal_panel_no_revision: ["이 목표는 여기서 변경할 수 없어요. 대화로 알려 주세요.", "This goal's text cannot be changed here. Tell it in the conversation."],
  goal_panel_no_plan: ["아직 나눈 계획이 없어요. 먼저 나누기를 눌러 주세요.", "There is no plan yet. Press Divide first."],
  goal_panel_node_done: ["끝난 항목은 멈출 수 없어요.", "A finished item cannot be paused."],
  goal_panel_edit_invalid: ["내용을 확인해 주세요.", "Check the text and try again."],
  goal_control_binding_changed: ["이 대화의 목표가 바뀌었어요. 다시 열어 주세요.", "This conversation's goal changed. Reopen the panel."],
  // Codes Main already returned that fell through to "try again" (goal-tree audit 2026-10-25): each says what to do.
  goal_panel_node_not_found: ["항목이 변경됐거나 삭제됐어요.", "That item was changed or removed."],
  goal_plan_node_missing: ["항목이 변경됐거나 삭제됐어요.", "That item was changed or removed."],
  goal_panel_strategy_required: ["하위 목표는 전략 아래에만 추가할 수 있어요.", "A sub-goal can only go under a strategy."],
  goal_panel_not_a_tree: ["이 계획에는 항목으로만 추가할 수 있어요.", "This plan only takes items."],
  prerequisites_invalid: ["선행 항목 연결이 올바르지 않아요.", "The prerequisite links are not valid."],
  goal_panel_amendment_not_recorded: ["목표 문장 변경을 저장하지 못했어요.", "The goal text change was not saved."],
  goal_panel_shape_unavailable: ["여기서는 계획을 나눌 수 없어요. 목표를 맡은 화면에서 나눠 주세요.", "The plan cannot be divided here. Divide it where the goal runs."],
  goal_panel_edit_failed: ["저장하지 못했어요.", "It was not saved."],
};

function errorText(code: string, locale: Locale): string {
  const known = ERROR_TEXT[code];
  if (known) return known[locale === "ko" ? 0 : 1];
  // The machine code is not part of the sentence; it stays on the line's hover title (support reads it there).
  return locale === "ko" ? "변경하지 못했어요."
    : "That change did not go through. What is shown above is what is saved now.";
}

function Mark({ state, current }: { state: GoalPanelNode["state"] | "none"; current?: boolean }) {
  return <span className={styles.mark} data-state={state} data-current={current ? "true" : "false"} aria-hidden="true">
    {state === "done" ? <IconCheck size={10} /> : state === "paused" ? "‖" : state === "blocked" ? "!" : null}
  </span>;
}

function Progress({ progress, locale }: { progress: { done: number; total: number } | null; locale: Locale }) {
  if (!progress || progress.total === 0) return null;
  const pct = Math.round((progress.done / progress.total) * 100);
  return <span className={styles.progress} data-goal-progress={`${progress.done}/${progress.total}`}
    aria-label={locale === "ko" ? `${progress.total}개 중 ${progress.done}개 완료` : `${progress.done} of ${progress.total} done`}>
    <span className={styles.progressTrack} aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
    {progress.done}/{progress.total}
  </span>;
}

function Editor({ fields, onSave, onCancel, locale, busy }: {
  fields: Array<{ key: string; label: string; value: string; multiline?: boolean; optional?: boolean; max?: number }>;
  onSave: (values: Record<string, string>) => void; onCancel: () => void; locale: Locale; busy: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const ready = fields.every((f) => f.optional || values[f.key]?.trim());
  return <form className={styles.editor} data-goal-editor="true" onSubmit={(event) => { event.preventDefault(); if (ready && !busy) onSave(values); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } }}>
    {fields.map((field, index) => <label key={field.key} className={styles.editorField}>
      <span>{field.label}</span>
      {field.multiline
        ? <textarea value={values[field.key]} autoFocus={index === 0} rows={2} maxLength={field.max ?? 600} data-goal-field={field.key}
            onChange={(event) => setValues((v) => ({ ...v, [field.key]: event.target.value }))} />
        : <input value={values[field.key]} autoFocus={index === 0} maxLength={field.max ?? 600} data-goal-field={field.key}
            onChange={(event) => setValues((v) => ({ ...v, [field.key]: event.target.value }))} />}
    </label>)}
    <div className={styles.editorActions}>
      <button type="button" onClick={onCancel}>{locale === "ko" ? "취소" : "Cancel"}</button>
      <button type="submit" className={styles.primary} disabled={!ready || busy} data-goal-save="true">{busy ? (locale === "ko" ? "저장 중" : "Saving") : (locale === "ko" ? "저장" : "Save")}</button>
    </div>
  </form>;
}

export function GoalRailPanel({ view, locale, onView, nowMs: fixedNow }: {
  view: GoalPanelView | null; locale: Locale; onView: (view: GoalPanelView | null) => void; nowMs?: number;
}) {
  const ko = locale === "ko";
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "ok"; text: string; code?: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // "Keep it paused" on the stuck card: a local dismissal for this goal revision (the goal is already stopped; no host call exists or is needed).
  const [keptStopped, setKeptStopped] = useState<string | null>(null);
  const nowMs = fixedNow ?? Date.now();
  useEffect(() => { if (!confirmRemove) return; const timer = setTimeout(() => setConfirmRemove(null), 4000); return () => clearTimeout(timer); }, [confirmRemove]);
  if (!view) return <p className={styles.empty}>{ko ? "이 대화에는 목표가 없어요" : "This conversation has no goal"}</p>;
  const planLocked = view.planBehindRevision || view.state === "terminal";

  const send = async (edit: GoalPanelEdit, okText?: (result: Extract<GoalPanelEditResult, { ok: true }>) => string | null) => {
    const api = ipc()?.goalPanel;
    if (!api || busy) return false;
    setBusy(true); setNotice(null);
    try {
      const result = await api.edit({ chatId: view.chatId, expectedGoalId: view.goalId, expectedPlan: view.plan, edit });
      if (result.view) onView(result.view);
      if (!result.ok) { setNotice({ kind: "error", text: errorText(result.code, locale), code: result.code }); return false; }
      const text = okText?.(result) ?? null;
      if (text) setNotice({ kind: "ok", text });
      return true;
    } catch {
      setNotice({ kind: "error", text: errorText("", locale) });
      return false;
    } finally { setBusy(false); }
  };
  const shape = async () => {
    const api = ipc()?.goalPanel;
    if (!api || busy) return;
    setBusy(true); setNotice(null);
    try {
      const result = await api.shape(view.chatId, view.goalId);
      if (result.view) onView(result.view);
      if (!result.ok) setNotice({ kind: "error", text: errorText(result.code, locale), code: result.code });
    } catch {
      // A thrown shape call left no notice at all (the button just stopped spinning).
      setNotice({ kind: "error", text: errorText("", locale) });
    } finally { setBusy(false); }
  };

  // [Start again]: the same resume the goal bar makes, from the goal's current version. A goal that needs a review first (automation link) is not resumed here:
  // the person is sent to the goal bar's Resume, which owns that review.
  const startAgain = async () => {
    const chats = ipc()?.chats;
    if (!chats || busy) return;
    setBusy(true); setNotice(null);
    try {
      const context = await chats.getGoalContext(view.chatId);
      if (!context?.version) throw new Error("goal_context_missing");
      const review = await chats.getGoalResumeReview(view.chatId, context.version, context.goalId);
      if (review) { setNotice({ kind: "error", text: ko ? "이어가기 전에 확인할 항목이 있어요. 목표 줄의 [재개]로 확인해 주세요." : "There is something to review first. Use Resume in the goal bar." }); return; }
      await chats.resumeGoal(view.chatId, context.version, context.goalId);
      setNotice(null);
    } catch {
      setNotice({ kind: "error", text: ko ? "다시 시작하지 못했어요. 목표 줄의 [재개]로 다시 해 보세요." : "Couldn't start again. Try Resume in the goal bar." });
    } finally { setBusy(false); }
  };
  const stuckKey = `${view.goalId}:${view.revision ?? 0}`;

  const deadline = view.deadlineAt ? (() => {
    const at = new Date(view.deadlineAt);
    const days = Math.ceil((at.getTime() - nowMs) / 86_400_000);
    const date = at.toLocaleDateString(ko ? "ko-KR" : "en-US", { month: "long", day: "numeric" });
    return days >= 0 ? (ko ? `마감 ${date} · ${days}일 남음` : `Due ${date} · ${days}d left`) : (ko ? `마감 ${date} 지남` : `Due ${date} (passed)`);
  })() : (ko ? "마감 없음" : "No deadline");
  const budgetParts = [
    view.budget.maxCycles !== null ? (ko ? `실행 ${view.budget.cycleCount}/${view.budget.maxCycles}회` : `${view.budget.cycleCount}/${view.budget.maxCycles} runs`) : "",
    view.budget.maxCostUsd !== null ? (ko ? `기록 비용 $${view.budget.costUsedUsd.toFixed(2)} / 참고 금액 $${view.budget.maxCostUsd} (자동 중단 없음)` : `Recorded cost $${view.budget.costUsedUsd.toFixed(2)} / guide $${view.budget.maxCostUsd} (does not stop automatically)`) : "",
    view.budget.wallclockDeadline ? (ko ? `시간 한도 ${new Date(view.budget.wallclockDeadline).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })}` : `Time limit ${new Date(view.budget.wallclockDeadline).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`) : "",
  ].filter(Boolean);
  const budget = budgetParts.length ? budgetParts.join(" · ") : (ko ? "예산 한도 없음" : "No budget limit");

  const nodeActions = (node: GoalPanelNode, siblings: GoalPanelNode[]) => {
    const index = siblings.findIndex((n) => n.id === node.id);
    if (planLocked) return null;
    return <span className={styles.actions} data-goal-node-actions={node.id}>
      <button type="button" aria-label={ko ? "편집" : "Edit"} title={ko ? "편집" : "Edit"} onClick={() => { setAdding(null); setEditing(node.id); }}><IconEdit size={12} /></button>
      <button type="button" aria-label={ko ? "위로" : "Move up"} title={ko ? "위로" : "Move up"} disabled={index <= 0 || busy} onClick={() => { void send({ op: "move_node", nodeId: node.id, direction: "up" }); }}><IconArrowUp size={12} /></button>
      <button type="button" className={styles.down} aria-label={ko ? "아래로" : "Move down"} title={ko ? "아래로" : "Move down"} disabled={index >= siblings.length - 1 || busy} onClick={() => { void send({ op: "move_node", nodeId: node.id, direction: "down" }); }}><IconArrowUp size={12} /></button>
      {node.state !== "done" && (node.ownerPaused
        ? <button type="button" data-goal-resume={node.id} aria-label={ko ? "재개" : "Resume"} title={ko ? "재개" : "Resume"} disabled={busy} onClick={() => { void send({ op: "resume_node", nodeId: node.id }); }}>▶</button>
        : <button type="button" data-goal-pause={node.id} aria-label={ko ? "일시정지" : "Pause"} title={ko ? "이 가지만 일시정지" : "Pause this branch"} disabled={busy} onClick={() => { void send({ op: "pause_node", nodeId: node.id }); }}>‖</button>)}
      {node.state !== "done" && <button type="button" data-goal-done={node.id} aria-label={ko ? "완료로 표시" : "Mark done"} title={ko ? "완료로 표시" : "Mark done"} disabled={busy} onClick={() => { void send({ op: "mark_done", nodeId: node.id }); }}><IconCheck size={12} /></button>}
      <button type="button" data-goal-remove={node.id} data-confirm={confirmRemove === node.id ? "true" : "false"}
        aria-label={confirmRemove === node.id ? (ko ? "정말 삭제" : "Confirm remove") : (ko ? "삭제" : "Remove")}
        title={ko ? "삭제" : "Remove"} disabled={busy}
        onClick={() => { if (confirmRemove === node.id) { setConfirmRemove(null); void send({ op: "remove_node", nodeId: node.id }); } else setConfirmRemove(node.id); }}>
        {confirmRemove === node.id ? (ko ? "삭제?" : "Remove?") : <IconTrash size={12} />}
      </button>
    </span>;
  };

  const detail = (label: string, value: ReactNode, key: string) => value ? <div className={styles.detail} data-goal-detail={key}><dt>{label}</dt><dd>{value}</dd></div> : null;

  const renderNode = (node: GoalPanelNode, siblings: GoalPanelNode[]): ReactNode => {
    const isEditing = editing === node.id;
    return <li key={node.id} className={styles.node} data-goal-node={node.id} data-kind={node.kind} data-state={node.state} data-current={node.current ? "true" : "false"}>
      <div className={styles.nodeRow}>
        <Mark state={node.state} current={node.current} />
        <span className={styles.intent} title={node.intent} data-goal-intent="true">{node.intent}</span>
        <span className={styles.meta}>
          {node.kind === "strategy" ? <Progress progress={node.progress} locale={locale} /> : null}
          {node.current && node.state === "running" ? <span className={styles.now}>{ko ? "지금" : "Now"}</span> : null}
          {node.state !== "running" || node.kind === "strategy" ? <span className={styles.stateText} data-goal-node-state={node.state}>{node.kind === "strategy" && node.state === "running" ? "" : nodeStateLabel(node, locale)}</span> : null}
        </span>
        {nodeActions(node, siblings)}
      </div>
      {isEditing
        ? <Editor locale={locale} busy={busy} onCancel={() => setEditing(null)}
            fields={node.kind === "strategy"
              ? [{ key: "intent", label: ko ? "목적" : "Purpose", value: node.intent, multiline: true }, { key: "kpi", label: ko ? "지표" : "KPI", value: "", optional: true, max: 200 }]
              : [{ key: "intent", label: ko ? "목적" : "Purpose", value: node.intent, multiline: true }, { key: "doneWhen", label: ko ? "완료 조건" : "Done when", value: node.doneWhen, multiline: true }]}
            onSave={(values) => {
              const edit: GoalPanelEdit = node.kind === "strategy"
                ? { op: "edit_node", nodeId: node.id, ...(values.intent.trim() !== node.intent ? { intent: values.intent.trim() } : {}), ...(values.kpi?.trim() ? { kpi: values.kpi.trim() } : {}) }
                : { op: "edit_node", nodeId: node.id, ...(values.intent.trim() !== node.intent ? { intent: values.intent.trim() } : {}), ...(values.doneWhen.trim() !== node.doneWhen ? { doneWhen: values.doneWhen.trim() } : {}) };
              if (!("intent" in edit) && !("doneWhen" in edit) && !("kpi" in edit)) { setEditing(null); return; }
              void send(edit).then((ok) => { if (ok) setEditing(null); });
            }} />
        : node.state !== "done" || node.kind === "strategy"
          ? <dl className={styles.details}>
              {detail(ko ? "방법" : "Method", t(node.method, locale), "method")}
              {node.kind === "tactic" && detail(ko ? "완료 조건" : "Done when", node.doneWhen, "done-when")}
              {node.state === "blocked" && detail(ko ? "막힌 이유" : "Blocked", t(node.stateReason, locale), "blocked")}
            </dl>
          : null}
      {node.kind === "strategy" && <ol className={styles.children}>
        {node.children.map((child) => renderNode(child, node.children))}
        {!planLocked && (adding === node.id
          ? <li className={styles.addForm}><Editor locale={locale} busy={busy} onCancel={() => setAdding(null)}
              fields={[{ key: "description", label: ko ? "하위목표" : "Sub-goal", value: "", multiline: true }, { key: "doneWhen", label: ko ? "완료 조건" : "Done when", value: "", multiline: true }]}
              onSave={(values) => { void send({ op: "add_tactic", strategyId: node.id, description: values.description.trim(), doneWhen: values.doneWhen.trim(), recurring: false }).then((ok) => { if (ok) setAdding(null); }); }} /></li>
          : <li><button type="button" className={styles.add} data-goal-add-tactic={node.id} onClick={() => { setEditing(null); setAdding(node.id); }}><IconPlus size={11} />{ko ? "하위목표 추가" : "Add sub-goal"}</button></li>)}
      </ol>}
    </li>;
  };

  const isTree = view.shape === "mission_tree";
  return <div className={styles.panel} data-goal-panel="true" data-goal-shape={view.shape ?? "none"} data-goal-state={view.state}>
    <header className={styles.header}>
      <Mark state={view.state === "running" ? "running" : view.state === "paused" ? "paused" : view.state === "blocked" || view.state === "needs_owner" ? "blocked" : view.state === "terminal" ? "done" : "none"} />
      <strong data-goal-panel-state={view.state}>{stateLabel(view, locale)}</strong>
      {view.stateReason && view.state !== "terminal" && <span className={styles.headerReason}>{t(view.stateReason, locale)}</span>}
      <span className={styles.headerMeta}>
        {view.revision !== null && <span data-goal-revision={view.revision}>{ko ? `버전 ${view.revision}` : `Version ${view.revision}`}</span>}
        {view.lifecycle === "ongoing" && <span>{ko ? "지속" : "Ongoing"}</span>}
      </span>
    </header>

    {view.state === "blocked" && keptStopped !== stuckKey && <section className={styles.stuck} data-goal-stuck="true" aria-label={ko ? "막힌 목표" : "Stuck goal"}>
      <p className={styles.stuckKicker}>{ko ? "막힘 · 일시정지" : "Stuck · paused"}</p>
      <h3>{view.root.intent}</h3>
      {view.stateReason && <p className={styles.stuckReason}>{t(view.stateReason, locale)}</p>}
      <div className={styles.stuckActions}>
        <button type="button" className={styles.stuckButton} disabled={busy} data-goal-keep-paused="true" onClick={() => setKeptStopped(stuckKey)}>{ko ? "일시정지 유지" : "Keep it paused"}</button>
        <button type="button" className={`${styles.stuckButton} ${styles.stuckPrimary}`} disabled={busy} data-goal-start-again="true" onClick={() => { void startAgain(); }}>{ko ? "다시 시작" : "Start again"}</button>
      </div>
    </section>}

    <section className={styles.root} data-goal-root="true">
      <p className={styles.label}>{ko ? "최종목표" : "Final goal"}</p>
      {editing === "root"
        ? <Editor locale={locale} busy={busy} onCancel={() => setEditing(null)}
            fields={[{ key: "text", label: ko ? "목표 (새 버전으로 저장돼요)" : "Goal (saved as a new version)", value: view.root.intent, multiline: true, max: 12000 }]}
            onSave={(values) => {
              const text = values.text.trim();
              if (!text || text === view.root.intent) { setEditing(null); return; }
              void send({ op: "amend_objective", text }, (result) => result.outcome === "revised"
                ? (ko ? "새 버전으로 저장했어요." : "Saved as a new version.")
                : (ko ? "저장했어요. 지금 실행이 끝나면 반영돼요." : "Saved. It applies when the current run ends."))
                .then((ok) => { if (ok) setEditing(null); });
            }} />
        : <div className={styles.rootIntentRow}>
            <button type="button" className={styles.rootIntent} data-expanded={expanded ? "true" : "false"} data-goal-root-intent="true"
              title={view.root.intentFull} onClick={() => setExpanded((v) => !v)}>
              {expanded ? view.root.intentFull : view.root.intent}
            </button>
            {view.state !== "terminal" && <button type="button" className={styles.iconButton} data-goal-edit-root="true" aria-label={ko ? "최종목표 편집" : "Edit final goal"}
              title={ko ? "최종목표 편집" : "Edit final goal"} onClick={() => { setAdding(null); setEditing("root"); }}><IconEdit size={12} /></button>}
          </div>}
      <dl className={styles.details}>
        {detail(ko ? "방법" : "Method", t(view.root.method, locale), "method")}
        {view.root.diagnosis && detail(ko ? "핵심 장애물" : "Crux", <span title={view.root.diagnosis}>{view.root.diagnosis}</span>, "diagnosis")}
        {detail(ko ? "완료 조건" : "Done when", view.root.doneWhen.length
          ? view.root.doneWhen.join(" · ")
          : view.nodes.length ? (ko ? "아래 하위목표가 모두 끝나면" : "When every sub-goal below is done") : "", "done-when")}
        {view.root.progress && detail(ko ? "진행" : "Progress", <Progress progress={view.root.progress} locale={locale} />, "progress")}
      </dl>
      <p className={styles.facts} data-goal-facts="true">
        <span data-goal-deadline={view.deadlineAt ?? "none"}>{deadline}</span>
        <span aria-hidden="true">·</span>
        <span data-goal-budget="true">{budget}</span>
      </p>
      {view.pendingAmendments > 0 && <p className={styles.note} data-goal-pending-amendment={view.pendingAmendments}>{ko ? `목표 수정 ${view.pendingAmendments}건은 지금 실행이 끝나면 반영돼요.` : `${view.pendingAmendments} goal change(s) apply when the current run ends.`}</p>}
      {view.planBehindRevision && <p className={styles.note} data-goal-plan-behind="true">{ko ? "아래는 이전 계획이에요." : "Below is the previous plan."}</p>}
    </section>

    {(view.canShape || view.shaping) && view.state !== "terminal" && <div className={styles.shape} data-goal-shape-cta="true">
      <p>{view.shaping ? (ko ? "계획을 나누는 중이에요…" : "Dividing the plan…")
        : view.shapeFailed ? (ko ? "나누지 못했어요. 다시 눌러 주세요." : "It could not be divided. Try again.")
        : view.provisional ? (ko ? "임시 계획이에요." : "This plan is provisional.")
        : (ko ? "나누지 않은 목표예요." : "This goal is not divided yet.")}</p>
      <button type="button" className={styles.primary} disabled={busy || view.shaping} data-goal-shape="true" onClick={() => { void shape(); }}>{ko ? "나누기" : "Divide"}</button>
    </div>}

    {view.nodes.length > 0 && <section className={styles.tree} data-goal-tree="true">
      <p className={styles.label}>{isTree ? (ko ? "전략목표" : "Strategic goals") : (ko ? "하위목표" : "Sub-goals")}</p>
      <ol className={styles.nodes}>
        {view.nodes.map((node) => renderNode(node, view.nodes))}
        {!planLocked && (adding === "__root"
          ? <li className={styles.addForm}><Editor locale={locale} busy={busy} onCancel={() => setAdding(null)}
              fields={isTree
                ? [{ key: "aim", label: ko ? "전략목표" : "Strategic goal", value: "", multiline: true }, { key: "kpi", label: ko ? "지표 (선택)" : "KPI (optional)", value: "", optional: true, max: 200 },
                  { key: "description", label: ko ? "첫 하위목표" : "First sub-goal", value: "", multiline: true }, { key: "doneWhen", label: ko ? "완료 조건" : "Done when", value: "", multiline: true }]
                : [{ key: "description", label: ko ? "하위목표" : "Sub-goal", value: "", multiline: true }, { key: "doneWhen", label: ko ? "완료 조건" : "Done when", value: "", multiline: true }]}
              onSave={(values) => {
                const edit: GoalPanelEdit = isTree
                  ? { op: "add_strategy", aim: values.aim.trim(), kpi: (values.kpi ?? "").trim(), firstSubGoal: { description: values.description.trim(), doneWhen: values.doneWhen.trim() } }
                  : { op: "add_tactic", strategyId: null, description: values.description.trim(), doneWhen: values.doneWhen.trim(), recurring: false };
                void send(edit).then((ok) => { if (ok) setAdding(null); });
              }} /></li>
          : <li><button type="button" className={styles.add} data-goal-add-root="true" onClick={() => { setEditing(null); setAdding("__root"); }}>
              <IconPlus size={11} />{isTree ? (ko ? "전략목표 추가" : "Add strategic goal") : (ko ? "하위목표 추가" : "Add sub-goal")}</button></li>)}
      </ol>
    </section>}

    {notice && <p className={notice.kind === "error" ? styles.error : styles.ok} role={notice.kind === "error" ? "alert" : "status"} data-goal-notice={notice.kind} title={notice.code || undefined}>{notice.text}</p>}
  </div>;
}
