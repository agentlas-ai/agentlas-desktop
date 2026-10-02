/**
 * The goal panel — one read model for the dedicated Goal tab (One and Work right panel) and the typed owner edits it
 * sends back to Main. Owner 2026-09-28: "목표 전용 패널을 만들어서 미니멀하게 최종목표, 전략전술, 하위목표 등을 짜서
 * 목표 칩 편집 누르면 나오던지".
 *
 * Terms on screen follow the owner's 2026-09-25 wording: 최종목표 · 전략목표 · 하위목표 (the plan's mission · strategies ·
 * tactics). Per node the panel shows its intent (목적, one line), its current method (방법), done_when, a status and the
 * latest AGI action on it.
 *
 * Rules this module encodes (pure — no DB, no clock; Main passes nowMs):
 *  - Status follows shared/goal-display-state.ts: between scheduled runs is running; only an explicit owner pause is
 *    paused (the goal's pauseReason "user", or a branch the owner paused here). Nothing is inferred from time.
 *  - Intent is the owner's: the final goal text, a strategy's aim and a sub-goal's description and done_when. The AGI may
 *    change methods only (electron/agi/actions.ts refuses intent edits as purpose_change); a refused AGI intent edit is
 *    listed as a suggestion the owner can accept.
 */
import { goalDisplayState, goalOwnerAttention, type GoalOwnerAttention, type GoalDisplayState } from "./goal-display-state";
import { goalObjectiveText } from "./auto-goal";
import { goalStopReasonText } from "./goal-stop-reason-text";
import { GOAL_SHAPE_LIMITS, selectActiveTactics, type GoalShapeKind, type LiveGoalPlan, type LiveStrategy, type LiveTactic } from "./goal-shape";

export const GOAL_PANEL_SCHEMA = "agentlas.goal-panel.v1" as const;

export type GoalPanelNodeState = "running" | "paused" | "blocked" | "done";
export interface GoalPanelText { ko: string; en: string }

export interface GoalPanelAgiAction {
  /** Plan node the action was about (tactic id), or null for the goal as a whole. */
  nodeId: string | null;
  at: string;
  text: GoalPanelText;
}

export interface GoalPanelSuggestion {
  /** `<agi action id>:<index>` — stable, so accept/dismiss is replay-safe. */
  id: string;
  nodeId: string | null;
  field: "objective" | "intent" | "done_when";
  text: string;
  at: string;
}

export interface GoalPanelNode {
  id: string;
  kind: "strategy" | "tactic";
  intent: string;
  /** How it is being pursued right now (host/AGI chosen path, cadence, KPI) — null when nothing beyond the intent. */
  method: GoalPanelText | null;
  doneWhen: string;
  state: GoalPanelNodeState;
  /** Plain reason for blocked (never a machine code). */
  stateReason: GoalPanelText | null;
  /** The sub-goal the next turn works on. */
  current: boolean;
  /** Strategy: finished sub-goals / live sub-goals. Tactic: null. */
  progress: { done: number; total: number } | null;
  recurring: boolean;
  runs: number;
  ownerPaused: boolean;
  agi: GoalPanelAgiAction | null;
  suggestions: GoalPanelSuggestion[];
  children: GoalPanelNode[];
}

export interface GoalPanelView {
  schemaVersion: typeof GOAL_PANEL_SCHEMA;
  chatId: string;
  goalId: string;
  lifecycle: "finite" | "ongoing" | null;
  /** The goal contract revision (the owner's intent edits create revisions). */
  revision: number | null;
  /** Concurrency token for plan edits: the plan revision and shape decision the view was read from. */
  plan: { revision: number; planSeq: number } | null;
  /** The plan was made for an older goal revision; the planner re-divides it before the next turn. */
  planBehindRevision: boolean;
  shape: GoalShapeKind | null;
  provisional: boolean;
  state: GoalDisplayState;
  ownerAttention?: GoalOwnerAttention | null;
  stateReason: GoalPanelText | null;
  root: {
    /** The owner's latest statement of the goal (after the last "[Owner update …]" the amendment path appends). */
    intent: string;
    /** The whole revision objective, for the expanded view. */
    intentFull: string;
    /** How many owner updates the objective carries. */
    ownerUpdates: number;
    /** How the final goal is pursued: the plan's shape in numbers (e.g. 3 strategic goals · 12 sub-goals). */
    method: GoalPanelText | null;
    /** The planner's diagnosis (the crux it is working around), when the plan is a tree. */
    diagnosis: string | null;
    doneWhen: string[];
    progress: { done: number; total: number } | null;
    agi: GoalPanelAgiAction | null;
    suggestions: GoalPanelSuggestion[];
  };
  deadlineAt: string | null;
  budget: { maxCycles: number | null; cycleCount: number; maxCostUsd: number | null; costUsedUsd: number; wallclockDeadline: string | null };
  /** Owner intent edits recorded but not yet bound (the run was mid-turn); they apply at its next stop. */
  pendingAmendments: number;
  /** Strategic goals (mission tree) or, for single/list shapes, the sub-goals directly under the final goal. */
  nodes: GoalPanelNode[];
  /** AGI has an open incident on this goal (it is looking into a blocker). */
  agiWorking: { attempts: number } | null;
  /** "나누기": the goal has no structured plan yet (no plan, a provisional one, or a single sub-goal). */
  canShape: boolean;
  shaping: boolean;
  shapeFailed: boolean;
  limits: { strategies: number; tactics: number };
}

export interface GoalPanelBuildInput {
  chatId: string;
  goalId: string;
  nowMs: number;
  run: {
    status: string; pauseReason: string | null; blockedReason: string | null; objective: string;
    budget: { maxCycles: number | null; maxCostUsd: number | null; wallclockDeadline: string | null };
    cycleCount: number; costUsedUsd: number;
  } | null;
  revision: { revision: number; objective: string; lifecycle?: "finite" | "ongoing" | null; acceptanceCriteria: string[] } | null;
  plan: LiveGoalPlan | null;
  deadlineAt: string | null;
  pendingAmendments: number;
  /** Newest first. */
  agiActions: GoalPanelAgiAction[];
  agiIncident: { attempts: number } | null;
  suggestions: GoalPanelSuggestion[];
  shaping: boolean;
  shapeFailed: boolean;
}

const BOUNDARY_TEXT: Record<string, GoalPanelText> = {
  payment: { ko: "결제 결정이 필요해요", en: "Needs your payment decision" },
  credential: { ko: "로그인이나 비밀 정보가 필요해요", en: "Needs a sign-in or secret only you have" },
  security_consent: { ko: "권한·설치 동의가 필요해요", en: "Needs your permission or install consent" },
  owner_stop: { ko: "멈춤 결정이 필요해요", en: "Needs your stop decision" },
  purpose_change: { ko: "목적을 바꿀지 결정이 필요해요", en: "Needs your decision on changing its purpose" },
};

function oneLine(text: string, max: number = GOAL_SHAPE_LIMITS.text): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

const OWNER_UPDATE_MARK = /\[Owner update [^\]\n]{1,64}\]\s*/g;

/** The owner's latest words in an objective built by goal-owner-amendment.ts amendmentObjective (host-written marker). */
export function latestOwnerStatement(objective: string): { latest: string; updates: number } {
  const text = String(objective ?? "");
  const marks = [...text.matchAll(OWNER_UPDATE_MARK)];
  if (!marks.length) return { latest: text.trim(), updates: 0 };
  const last = marks[marks.length - 1]!;
  return { latest: text.slice((last.index ?? 0) + last[0].length).trim(), updates: marks.length };
}

function tacticMethod(tactic: LiveTactic): GoalPanelText | null {
  const g = tactic.guidance;
  const cadence: GoalPanelText | null = tactic.kind === "recurring"
    ? { ko: `반복 · ${tactic.runs}회 했음`, en: `Recurring · done ${tactic.runs}×` } : null;
  if (!g) return cadence;
  const join = (line: GoalPanelText): GoalPanelText => cadence ? { ko: `${line.ko} · ${cadence.ko}`, en: `${line.en} · ${cadence.en}` } : line;
  switch (g.move) {
    case "switch_tool": return join(g.path ? { ko: `다른 방법으로: ${g.path}`, en: `Another way: ${g.path}` } : { ko: "같은 기능의 다른 도구로", en: "An alternative tool with the same capability" });
    case "replan": return join({ ko: "막혀서 다른 방법을 찾는 중", en: "Blocked — finding a different approach" });
    case "observe": return join({ ko: "먼저 현재 상태를 확인해요", en: "Checking the current state first" });
    case "retry_backoff": return join({ ko: "다음 실행에서 다시 해요", en: "Retrying on the next run" });
    case "escalate_boundary": return cadence;
    default: return cadence;
  }
}

function tacticBlockedReason(tactic: LiveTactic): GoalPanelText | null {
  if (tactic.guidance?.move !== "escalate_boundary") return null;
  return BOUNDARY_TEXT[tactic.guidance.boundary ?? ""] ?? { ko: "오너 결정이 필요해요", en: "Needs your decision" };
}

function goalStateReason(state: GoalDisplayState, run: GoalPanelBuildInput["run"]): GoalPanelText | null {
  if (!run) return null;
  if (state === "paused") return { ko: "직접 일시정지했어요", en: "You paused it" };
  if (state === "needs_owner") {
    if (run.pauseReason === "approval_required") return { ko: "승인을 기다려요", en: "Waiting for your approval" };
    if (run.pauseReason === "budget" || (run.pauseReason ?? "").startsWith("budget_")) return { ko: "예산 한도에 닿았어요", en: "It reached its budget limit" };
    if (run.status === "waiting_user") return { ko: "답을 기다려요", en: "Waiting for your answer" };
    return { ko: goalStopReasonText("goal_blocked", run.blockedReason, "ko"), en: goalStopReasonText("goal_blocked", run.blockedReason, "en") };
  }
  if (state === "blocked") return { ko: goalStopReasonText("goal_blocked", run.blockedReason, "ko"), en: goalStopReasonText("goal_blocked", run.blockedReason, "en") };
  if (state === "terminal") {
    if (run.status === "completed") return { ko: "완료했어요", en: "Completed" };
    if (run.status === "failed") return { ko: "끝내지 못하고 멈췄어요", en: "Ended without finishing" };
    return { ko: "종료했어요", en: "Ended" };
  }
  return null;
}

/** Build the panel view from ledger facts. */
export function buildGoalPanelView(input: GoalPanelBuildInput): GoalPanelView {
  const { plan, run, revision } = input;
  const state = run ? goalDisplayState({ status: run.status, pauseReason: run.pauseReason, blockedReason: run.blockedReason }) : "none";
  const goalPaused = state === "paused";
  const agiFor = (nodeId: string) => input.agiActions.find((action) => action.nodeId === nodeId) ?? null;
  const suggestionsFor = (nodeId: string | null) => input.suggestions.filter((s) => s.nodeId === nodeId);
  const current = plan ? selectActiveTactics(plan, { nowMs: input.nowMs })[0]?.id ?? null : null;
  const pausedStrategies = new Set((plan?.strategies ?? []).filter((s) => s.ownerPaused).map((s) => s.id));

  const tacticNode = (tactic: LiveTactic): GoalPanelNode => {
    const branchPaused = tactic.ownerPaused === true || (tactic.strategy_id !== null && pausedStrategies.has(tactic.strategy_id));
    const blocked = tacticBlockedReason(tactic);
    const nodeState: GoalPanelNodeState = tactic.status === "done" ? "done"
      : branchPaused || goalPaused ? "paused"
      : blocked ? "blocked"
      : "running";
    return {
      id: tactic.id, kind: "tactic", intent: oneLine(tactic.description), method: tacticMethod(tactic), doneWhen: oneLine(tactic.done_when),
      state: nodeState, stateReason: nodeState === "blocked" ? blocked : null, current: tactic.id === current,
      progress: null, recurring: tactic.kind === "recurring", runs: tactic.runs, ownerPaused: tactic.ownerPaused === true,
      agi: agiFor(tactic.id), suggestions: suggestionsFor(tactic.id), children: [],
    };
  };
  const liveTactics = (plan?.tactics ?? []).filter((t) => t.status !== "retired").sort((a, b) => a.ord - b.ord);
  const strategyNode = (strategy: LiveStrategy): GoalPanelNode => {
    const children = liveTactics.filter((t) => t.strategy_id === strategy.id).map(tacticNode);
    const done = children.filter((child) => child.state === "done").length;
    const allDone = strategy.status === "done" || (children.length > 0 && done === children.length);
    const open = children.filter((child) => child.state !== "done");
    const nodeState: GoalPanelNodeState = allDone ? "done"
      : strategy.ownerPaused || goalPaused ? "paused"
      : open.length > 0 && open.every((child) => child.state === "blocked") ? "blocked"
      : "running";
    const kpi = oneLine(strategy.kpi, GOAL_SHAPE_LIMITS.shortText);
    const perDay = strategy.actions_per_day;
    const method: GoalPanelText | null = kpi || perDay
      ? { ko: [kpi ? `지표: ${kpi}` : "", perDay ? `하루 ${perDay}회` : ""].filter(Boolean).join(" · "),
        en: [kpi ? `KPI: ${kpi}` : "", perDay ? `${perDay}/day` : ""].filter(Boolean).join(" · ") }
      : null;
    return {
      id: strategy.id, kind: "strategy", intent: oneLine(strategy.hypothesis), method,
      doneWhen: "", state: nodeState,
      stateReason: nodeState === "blocked" ? (open[0]?.stateReason ?? null) : null,
      current: children.some((child) => child.current), progress: { done, total: children.length },
      recurring: false, runs: 0, ownerPaused: strategy.ownerPaused === true,
      // AGI acts on sub-goals; its line shows on that sub-goal (and the latest one on the final goal), not repeated here.
      agi: agiFor(strategy.id),
      suggestions: suggestionsFor(strategy.id), children,
    };
  };

  const nodes: GoalPanelNode[] = !plan ? []
    : plan.shape === "mission_tree"
      ? plan.strategies.filter((s) => s.status !== "retired").sort((a, b) => a.priority - b.priority).map(strategyNode)
      : liveTactics.map(tacticNode);
  const leaves = plan?.shape === "mission_tree" ? nodes.flatMap((node) => node.children) : nodes;
  const planCurrent = plan && revision ? plan.revision === revision.revision : Boolean(plan);
  // The final goal's intent: the current revision's own objective (the owner's words). A plan's mission objective is
  // the planner's restatement — shown only when the plan is for the current revision and no revision is recorded.
  const objective = goalObjectiveText(revision?.objective ?? plan?.mission?.objective ?? run?.objective ?? "");
  const statement = latestOwnerStatement(objective);
  const krLines = (plan?.mission?.key_results ?? []).map((kr) =>
    `${kr.metric} ${kr.target_text || `${kr.target}${kr.unit ? ` ${kr.unit}` : ""}`}${kr.deadline_at ? ` · ${kr.deadline_at.slice(0, 10)}` : ""}`);
  const doneWhen = krLines.length ? krLines
    : plan && goalOwnerAttention(run ?? { status: null }) !== "review" ? [] : (revision?.acceptanceCriteria ?? []).map((line) => oneLine(line));
  return {
    schemaVersion: GOAL_PANEL_SCHEMA,
    chatId: input.chatId,
    goalId: input.goalId,
    lifecycle: revision?.lifecycle ?? null,
    revision: revision?.revision ?? null,
    plan: plan ? { revision: plan.revision, planSeq: plan.planSeq } : null,
    planBehindRevision: Boolean(plan && revision && plan.revision < revision.revision),
    shape: plan?.shape ?? null,
    provisional: plan?.fallback === true,
    state,
    stateReason: goalStateReason(state, run),
    ownerAttention: goalOwnerAttention(run ?? { status: null }),
    root: {
      intent: oneLine(statement.latest, 4_000),
      intentFull: String(objective).trim().slice(0, 12_000),
      ownerUpdates: statement.updates,
      method: !plan ? null : plan.shape === "mission_tree"
        ? { ko: `전략목표 ${nodes.length}개 · 하위목표 ${leaves.length}개로 진행`, en: `${nodes.length} strategic goals · ${leaves.length} sub-goals` }
        : plan.shape === "tactic_list" ? { ko: `하위목표 ${leaves.length}개를 순서대로`, en: `${leaves.length} sub-goals in order` }
        : { ko: "한 번에 끝내는 목표", en: "A single sub-goal" },
      diagnosis: plan?.mission?.diagnosis ? oneLine(plan.mission.diagnosis) : null,
      doneWhen,
      progress: leaves.length ? { done: leaves.filter((leaf) => leaf.state === "done").length, total: leaves.length } : null,
      agi: input.agiActions[0] ?? null,
      suggestions: suggestionsFor(null),
    },
    deadlineAt: input.deadlineAt ?? (planCurrent ? plan?.deadline_at ?? null : null),
    budget: {
      maxCycles: run?.budget.maxCycles ?? null, cycleCount: run?.cycleCount ?? 0,
      maxCostUsd: run?.budget.maxCostUsd ?? null, costUsedUsd: run?.costUsedUsd ?? 0,
      wallclockDeadline: run?.budget.wallclockDeadline ?? null,
    },
    pendingAmendments: input.pendingAmendments,
    nodes,
    agiWorking: input.agiIncident,
    canShape: !plan || plan.fallback || plan.shape === "single_tactic",
    shaping: input.shaping,
    shapeFailed: input.shapeFailed,
    limits: { strategies: GOAL_SHAPE_LIMITS.strategies, tactics: GOAL_SHAPE_LIMITS.tactics },
  };
}

// ── Owner edits (typed; validated in Main before any write) ─────────────────────

export type GoalPanelEdit =
  | { op: "amend_objective"; text: string }
  | { op: "add_tactic"; strategyId: string | null; description: string; doneWhen: string; recurring: boolean }
  | { op: "add_strategy"; aim: string; kpi: string; firstSubGoal: { description: string; doneWhen: string } }
  | { op: "edit_node"; nodeId: string; intent?: string; doneWhen?: string; kpi?: string }
  | { op: "remove_node"; nodeId: string }
  | { op: "move_node"; nodeId: string; direction: "up" | "down" }
  | { op: "pause_node"; nodeId: string }
  | { op: "resume_node"; nodeId: string }
  | { op: "mark_done"; nodeId: string }
  | { op: "accept_suggestion"; suggestionId: string }
  | { op: "dismiss_suggestion"; suggestionId: string };

export interface GoalPanelEditRequest {
  chatId: string;
  expectedGoalId: string;
  /** Required for plan edits: the plan the owner was looking at. */
  expectedPlan?: { revision: number; planSeq: number } | null;
  edit: GoalPanelEdit;
}

export type GoalPanelEditResult =
  | { ok: true; outcome: "applied" | "revised" | "amendment_pending"; view: GoalPanelView | null }
  | { ok: false; code: string; view: GoalPanelView | null };

const NODE_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= max ? text : null;
};

/** Parse an untrusted edit from the renderer. Null = refused (`goal_panel_edit_invalid`). */
export function parseGoalPanelEdit(raw: unknown): GoalPanelEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const node = typeof e.nodeId === "string" && NODE_ID.test(e.nodeId) ? e.nodeId : null;
  const text = GOAL_SHAPE_LIMITS.text;
  switch (e.op) {
    case "amend_objective": { const t = clean(e.text, 12_000); return t ? { op: "amend_objective", text: t } : null; }
    case "add_tactic": {
      const description = clean(e.description, text);
      const doneWhen = clean(e.doneWhen, text);
      const strategyId = e.strategyId === null || e.strategyId === undefined ? null
        : typeof e.strategyId === "string" && NODE_ID.test(e.strategyId) ? e.strategyId : undefined;
      if (!description || !doneWhen || strategyId === undefined) return null;
      return { op: "add_tactic", strategyId, description, doneWhen, recurring: e.recurring === true };
    }
    case "add_strategy": {
      const aim = clean(e.aim, text);
      const kpi = e.kpi === undefined || e.kpi === "" ? "" : clean(e.kpi, GOAL_SHAPE_LIMITS.shortText);
      const first = e.firstSubGoal && typeof e.firstSubGoal === "object" ? e.firstSubGoal as Record<string, unknown> : null;
      const description = clean(first?.description, text);
      const doneWhen = clean(first?.doneWhen, text);
      if (!aim || kpi === null || !description || !doneWhen) return null;
      return { op: "add_strategy", aim, kpi, firstSubGoal: { description, doneWhen } };
    }
    case "edit_node": {
      if (!node) return null;
      const intent = e.intent === undefined ? undefined : clean(e.intent, text);
      const doneWhen = e.doneWhen === undefined ? undefined : clean(e.doneWhen, text);
      const kpi = e.kpi === undefined ? undefined : e.kpi === "" ? "" : clean(e.kpi, GOAL_SHAPE_LIMITS.shortText);
      if (intent === null || doneWhen === null || kpi === null || (intent === undefined && doneWhen === undefined && kpi === undefined)) return null;
      return { op: "edit_node", nodeId: node, ...(intent !== undefined ? { intent } : {}), ...(doneWhen !== undefined ? { doneWhen } : {}), ...(kpi !== undefined ? { kpi } : {}) };
    }
    case "move_node":
      return node && (e.direction === "up" || e.direction === "down") ? { op: "move_node", nodeId: node, direction: e.direction } : null;
    case "remove_node": case "pause_node": case "resume_node": case "mark_done":
      return node ? { op: e.op, nodeId: node } : null;
    case "accept_suggestion": case "dismiss_suggestion": {
      const id = typeof e.suggestionId === "string" && /^[A-Za-z0-9._:-]{8,200}$/.test(e.suggestionId) ? e.suggestionId : null;
      return id ? { op: e.op, suggestionId: id } : null;
    }
    default: return null;
  }
}
