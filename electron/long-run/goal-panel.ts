/**
 * Main side of the goal panel (shared/goal-panel.ts): the read model and the owner's typed edits.
 *
 * Every write goes through the existing ledger writers — nothing here writes raw rows from renderer input:
 *  - final-goal text  → an owner message in the goal chat + the owner-amendment path (goal-owner-amendment.ts,
 *    af3a46c4): a pending amendment bound as a new goal revision at the run's next stop. Never an overwrite.
 *  - plan nodes       → goal-plans.ts insertGoalPlanNode / updateGoalPlanNode on the plan the owner was looking at
 *    (revision + plan_seq fence), with an append-only owner_edit receipt for every change.
 *  - "나누기"          → goal-shaping.ts ensureGoalShapeBeforeTurn({ ownerRequested }) (the planner, no tools).
 *
 * Pause is explicit (owner 2026-09-28 "명시적 멈춤이 멈춤"): a branch is paused only by pause_node here, and a paused
 * branch is skipped by selectActiveTactics. The last open branch may be paused or removed here like any other (round 3,
 * refusing the owner's own edit was a dead end); the turn context then tells the Goal that every remaining item is
 * owner-paused, or that every tactic is done or retired, and the Goal's own loop (stall window, verification) takes it from there.
 */
import { getDb } from "../store/db";
import { effectiveAcceptanceCriteria } from "../../shared/goal-scope";
import { appendChatMessage, getChat } from "../store/chats";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getChatGoalRevision } from "../store/chat-goals";
import { adoptExplicitGoalGrant } from "./explicit-goal-authority";
import { getLongRunByGoalId } from "../store/long-runs";
import {
  goalPlanTacticPayload,
  insertGoalPlanNode,
  listGoalPlanDecisions,
  readGoalPlan,
  recordGoalPlanDecision,
  updateGoalPlanNode,
} from "../store/goal-plans";
import { GOAL_SHAPE_LIMITS, type LiveGoalPlan, type LiveTactic } from "../../shared/goal-shape";
import {
  buildGoalPanelView,
  parseGoalPanelEdit,
  type GoalPanelAgiAction,
  type GoalPanelEdit,
  type GoalPanelEditResult,
  type GoalPanelSuggestion,
  type GoalPanelView,
} from "../../shared/goal-panel";
import type { RuntimeSelection } from "../../shared/types";
import { goalDeadlineAt } from "./goal-deadline";
import { applyPendingOwnerGoalAmendments, pendingOwnerGoalAmendmentCount, recordPendingOwnerGoalAmendment } from "./goal-owner-amendment";
import { ensureGoalShapeBeforeTurn } from "./goal-shaping";
import { ownsHostGoalLoop } from "./host-goal-surface";
import { noticeLine } from "../agi/actions";
import type { AgiActionKind } from "../agi/blocker";

const TERMINAL = new Set(["completed", "failed", "cancelled", "cancelling"]);
const PURPOSE_CHANGE_CODE = "agi.plan.purpose-change-boundary";
const shaping = new Map<string, { failed: boolean; running: boolean }>();

function tableExists(name: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function parseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

/** The AGI's latest real actions on this goal (settled ok receipts), as the same plain lines the chat notices use. */
function agiActions(goalId: string): GoalPanelAgiAction[] {
  if (!tableExists("agi_action_receipts")) return [];
  const rows = getDb().prepare(`SELECT action, result_json, settled_at_ms FROM agi_action_receipts
    WHERE goal_id = ? AND status = 'settled' AND ok = 1 AND action NOT IN ('rest','file_defect')
    ORDER BY settled_at_ms DESC LIMIT 40`).all(goalId) as Array<{ action: string; result_json: string | null; settled_at_ms: number | null }>;
  const out: GoalPanelAgiAction[] = [];
  for (const row of rows) {
    const receipt = parseJson(row.result_json);
    const detail = receipt.detail && typeof receipt.detail === "object" ? receipt.detail as Record<string, unknown> : {};
    const line = noticeLine(row.action as AgiActionKind, { actionId: String(receipt.actionId ?? ""), action: row.action, ok: true,
      code: String(receipt.code ?? ""), detail });
    if (!line) continue;
    const strip = (text: string) => text.replace(/^AGI:\s*/, "");
    out.push({ nodeId: typeof detail.nodeId === "string" ? detail.nodeId : null, at: new Date(row.settled_at_ms ?? 0).toISOString(),
      text: { ko: strip(line.ko), en: strip(line.en) } });
  }
  return out;
}

function settledSuggestionIds(goalId: string): Set<string> {
  return new Set(listGoalPlanDecisions(goalId, { kind: "owner_edit", limit: 500 })
    .map((row) => row.payload.suggestionId).filter((id): id is string => typeof id === "string"));
}

/** AGI intent edits refused as purpose_change, kept as suggestions until the owner accepts or dismisses them. */
function agiSuggestions(goalId: string): GoalPanelSuggestion[] {
  if (!tableExists("agi_action_receipts")) return [];
  const settled = settledSuggestionIds(goalId);
  const rows = getDb().prepare(`SELECT action_id, result_json, settled_at_ms FROM agi_action_receipts
    WHERE goal_id = ? AND status = 'settled' AND code = ? ORDER BY settled_at_ms DESC LIMIT 20`)
    .all(goalId, PURPOSE_CHANGE_CODE) as Array<{ action_id: string; result_json: string | null; settled_at_ms: number | null }>;
  const out: GoalPanelSuggestion[] = [];
  for (const row of rows) {
    const detail = parseJson(row.result_json).detail;
    const proposals = detail && typeof detail === "object" && Array.isArray((detail as Record<string, unknown>).proposals)
      ? (detail as { proposals: unknown[] }).proposals : [];
    proposals.forEach((raw, index) => {
      const p = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const id = `${row.action_id}:${index}`;
      const field = p.field === "objective" || p.field === "intent" || p.field === "done_when" ? p.field : null;
      const text = typeof p.text === "string" ? p.text.replace(/\s+/g, " ").trim().slice(0, 600) : "";
      if (!field || !text || settled.has(id)) return;
      out.push({ id, nodeId: field === "objective" ? null : typeof p.nodeId === "string" ? p.nodeId : null, field, text,
        at: new Date(row.settled_at_ms ?? 0).toISOString() });
    });
  }
  return out;
}

function openIncident(goalId: string): { attempts: number } | null {
  if (!tableExists("agi_incidents")) return null;
  // A held incident (the Goal's own work or the host scheduler has the next step, electron/agi/monitor.ts) is not AGI working now.
  const held = (getDb().prepare("PRAGMA table_info(agi_incidents)").all() as Array<{ name: string }>).some((column) => column.name === "held_reason");
  const row = getDb().prepare(`SELECT attempts FROM agi_incidents WHERE goal_id = ? AND status = 'open' ${held ? "AND held_reason IS NULL" : ""}
    ORDER BY updated_at_ms DESC LIMIT 1`).get(goalId) as { attempts: number } | undefined;
  return row ? { attempts: row.attempts } : null;
}

export function readGoalPanel(chatId: string, nowMs = Date.now()): GoalPanelView | null {
  const chat = getChat(chatId);
  const goalId = chat?.goalId ?? null;
  if (!chat || !goalId) return null;
  const run = getLongRunByGoalId(goalId);
  const revision = getChatGoalRevision(goalId);
  let plan: LiveGoalPlan | null = null;
  try { plan = readGoalPlan(goalId); } catch { plan = null; }
  const shape = shaping.get(goalId);
  return buildGoalPanelView({
    chatId, goalId, nowMs,
    run: run ? { status: run.status, pauseReason: run.pauseReason, blockedReason: run.blockedReason, objective: run.objective,
      budget: { maxCycles: run.budget.maxCycles, maxCostUsd: run.budget.maxCostUsd, wallclockDeadline: run.budget.wallclockDeadline },
      cycleCount: run.cycleCount, costUsedUsd: run.costUsedUsd } : null,
    revision: revision ? { revision: revision.revision, objective: revision.objective, lifecycle: revision.lifecycle,
      // A Goal stored before still carries the host-scope sentence: the panel (and One's goalPanel.view) shows what is judged.
      acceptanceCriteria: effectiveAcceptanceCriteria(revision.acceptanceCriteria).map((criterion) => criterion.text) } : null,
    plan,
    deadlineAt: (() => { try { return goalDeadlineAt(goalId); } catch { return null; } })(),
    pendingAmendments: (() => { try { return pendingOwnerGoalAmendmentCount(goalId); } catch { return 0; } })(),
    agiActions: (() => { try { return agiActions(goalId); } catch { return []; } })(),
    agiIncident: (() => { try { return openIncident(goalId); } catch { return null; } })(),
    suggestions: (() => { try { return agiSuggestions(goalId); } catch { return []; } })(),
    shaping: shape?.running === true,
    shapeFailed: shape?.failed === true && shape.running === false,
    // "Divide" is offered only where this app's goal loop runs the Goal (Science and another room's Goal answer goal_panel_shape_unavailable).
    hostRunsGoal: !run || (run.rootChatId === chatId && ownsHostGoalLoop(run.surface)),
  });
}

class PanelRefusal extends Error {}
const refuse = (code: string): never => { throw new PanelRefusal(code); };

function notify(chatId: string, runId: string | null): void {
  if (runId) emitDesktopStoreChange({ entity: "long-run", id: runId });
  emitDesktopStoreChange({ entity: "chat", id: chatId });
}

function nextNodeId(plan: LiveGoalPlan, prefix: "t" | "s"): string {
  const taken = new Set([...plan.tactics.map((t) => t.id), ...plan.strategies.map((s) => s.id)]);
  let n = (prefix === "t" ? plan.tactics.length : plan.strategies.length) + 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** The items a plan edit names (its node, and the strategy a new sub-goal goes under). */
function editedItemIds(edit: GoalPanelEdit): string[] {
  const ids: string[] = [];
  if ("nodeId" in edit && typeof edit.nodeId === "string") ids.push(edit.nodeId);
  if (edit.op === "add_tactic" && edit.strategyId) ids.push(edit.strategyId);
  return ids;
}

/**
 * Whether every item the edit names is, in `now`, the same item it was in `seen`: same kind, same place, same words. Null when it is;
 * otherwise the refusal. A strategy edit that acts on the strategy's CHILDREN (remove_node retires them, mark_done marks them done as
 * "Marked done by the owner") also requires those children to be the ones the owner saw: after a re-division the same strategy words
 * can head tactics the owner never looked at, and completing them would record work as done that nobody judged (regression review C5,
 *). That case is the old plan_changed refusal; the view returned with it shows the current plan.
 */
function planEditMismatch(seen: LiveGoalPlan, now: LiveGoalPlan, edit: GoalPanelEdit): "goal_panel_node_not_found" | "goal_panel_plan_changed" | null {
  let childrenChanged = false;
  const sameItems = editedItemIds(edit).every((id) => {
    const a = seen.tactics.find((t) => t.id === id), b = now.tactics.find((t) => t.id === id);
    if (a || b) return Boolean(a && b && a.strategy_id === b.strategy_id && a.description === b.description && a.done_when === b.done_when);
    const x = seen.strategies.find((s) => s.id === id), y = now.strategies.find((s) => s.id === id);
    if (!(x && y && x.hypothesis === y.hypothesis && JSON.stringify(x.kpi ?? null) === JSON.stringify(y.kpi ?? null))) return false;
    if ((edit.op === "remove_node" || edit.op === "mark_done") && "nodeId" in edit && edit.nodeId === id) {
      const children = (plan: LiveGoalPlan): string => JSON.stringify(plan.tactics.filter((t) => t.strategy_id === id && t.status !== "retired")
        .map((t) => [t.id, t.description, t.done_when]).sort());
      if (children(seen) !== children(now)) childrenChanged = true;
    }
    return true;
  });
  if (!sameItems) return "goal_panel_node_not_found";
  return childrenChanged ? "goal_panel_plan_changed" : null;
}

function applyPlanEdit(plan: LiveGoalPlan, edit: Exclude<GoalPanelEdit, { op: "amend_objective" | "accept_suggestion" | "dismiss_suggestion" }>, at: string): Record<string, unknown> {
  const key = { goalId: plan.goalId, revision: plan.revision, planSeq: plan.planSeq };
  const tactic = "nodeId" in edit ? plan.tactics.find((t) => t.id === edit.nodeId && t.status !== "retired") ?? null : null;
  const strategy = "nodeId" in edit ? plan.strategies.find((s) => s.id === edit.nodeId && s.status !== "retired") ?? null : null;
  const open = (t: LiveTactic) => t.status === "active" || t.status === "proposed";
  const node = () => (tactic ?? strategy ?? refuse("goal_panel_node_not_found"));
  switch (edit.op) {
    case "add_tactic": {
      // The owner's own addition is never refused by a count (owner 2026-10-12: no arbitrary caps on user intent).
      if (plan.shape === "mission_tree") {
        if (!edit.strategyId || !plan.strategies.some((s) => s.id === edit.strategyId && s.status !== "retired")) refuse("goal_panel_strategy_required");
      } else if (edit.strategyId) refuse("goal_panel_not_a_tree");
      const id = nextNodeId(plan, "t");
      const ord = Math.max(-1, ...plan.tactics.map((t) => t.ord)) + 1;
      insertGoalPlanNode(key, { nodeId: id, kind: "tactic", parentId: edit.strategyId, status: "active", ord,
        payload: { ...goalPlanTacticPayload({ id, strategy_id: edit.strategyId, description: edit.description, done_when: edit.doneWhen,
          kind: edit.recurring ? "recurring" : "one_off" }), addedBy: "owner", addedAt: at } });
      return { nodeId: id, strategyId: edit.strategyId };
    }
    case "add_strategy": {
      if (plan.shape !== "mission_tree") refuse("goal_panel_not_a_tree");
      const id = nextNodeId(plan, "s");
      const priority = Math.max(-1, ...plan.strategies.map((s) => s.priority)) + 1;
      insertGoalPlanNode(key, { nodeId: id, kind: "strategy", parentId: plan.mission ? "mission" : null, status: "active", ord: priority,
        payload: { id, hypothesis: edit.aim, serves_krs: [], kpi: edit.kpi, actions_per_day: null,
          timebox_hours: GOAL_SHAPE_LIMITS.defaultTimeboxHours, observation_window_hours: GOAL_SHAPE_LIMITS.defaultTimeboxHours,
          priority, activatedAt: at, addedBy: "owner" } });
      const withStrategy = { ...plan, strategies: [...plan.strategies, { id } as LiveGoalPlan["strategies"][number]] };
      const tid = nextNodeId(withStrategy, "t");
      insertGoalPlanNode(key, { nodeId: tid, kind: "tactic", parentId: id, status: "active", ord: Math.max(-1, ...plan.tactics.map((t) => t.ord)) + 1,
        payload: { ...goalPlanTacticPayload({ id: tid, strategy_id: id, description: edit.firstSubGoal.description, done_when: edit.firstSubGoal.doneWhen, kind: "one_off" }),
          addedBy: "owner", addedAt: at } });
      return { nodeId: id, tacticId: tid };
    }
    case "edit_node": {
      if (tactic) {
        if (edit.kpi !== undefined) refuse("goal_panel_edit_invalid");
        const before = { description: tactic.description, done_when: tactic.done_when };
        updateGoalPlanNode(key, tactic.id, { payload: { ...(edit.intent ? { description: edit.intent } : {}), ...(edit.doneWhen ? { done_when: edit.doneWhen } : {}),
          editedBy: "owner", editedAt: at } });
        return { nodeId: tactic.id, before, after: { description: edit.intent ?? before.description, done_when: edit.doneWhen ?? before.done_when } };
      }
      const s = node() as LiveGoalPlan["strategies"][number];
      if (edit.doneWhen !== undefined) refuse("goal_panel_edit_invalid");
      const before = { hypothesis: s.hypothesis, kpi: s.kpi };
      updateGoalPlanNode(key, s.id, { payload: { ...(edit.intent ? { hypothesis: edit.intent } : {}), ...(edit.kpi !== undefined ? { kpi: edit.kpi } : {}),
        editedBy: "owner", editedAt: at } });
      return { nodeId: s.id, before, after: { hypothesis: edit.intent ?? before.hypothesis, kpi: edit.kpi ?? before.kpi } };
    }
    case "remove_node": {
      const target = node();
      const removed = new Set([target.id, ...(strategy ? plan.tactics.filter((t) => t.strategy_id === strategy.id).map((t) => t.id) : [])]);
      // Removing the last open item is the owner's decision and is applied: the Goal then reads "every tactic done or retired: verify
      // the acceptance criteria; add a tactic if work remains" (goal-shaping.ts turn context) and re-plans or finishes through its own
      // loop. It used to be refused ("cannot be paused or removed here") although nothing in the loop needs an open item.
      if (strategy) {
        for (const t of plan.tactics.filter((t) => t.strategy_id === strategy.id && open(t))) updateGoalPlanNode(key, t.id, { status: "retired", payload: { retiredBy: "owner" } });
      }
      updateGoalPlanNode(key, target.id, { status: "retired", payload: { retiredBy: "owner", retiredAt: at } });
      return { nodeId: target.id };
    }
    case "move_node": {
      if (tactic) {
        const siblings = plan.tactics.filter((t) => t.status !== "retired" && t.strategy_id === tactic.strategy_id).sort((a, b) => a.ord - b.ord);
        const index = siblings.findIndex((t) => t.id === tactic.id);
        const other = siblings[edit.direction === "up" ? index - 1 : index + 1];
        if (!other) return { nodeId: tactic.id, unchanged: true };
        updateGoalPlanNode(key, tactic.id, { ord: other.ord });
        updateGoalPlanNode(key, other.id, { ord: tactic.ord });
        return { nodeId: tactic.id, swappedWith: other.id };
      }
      const s = node() as LiveGoalPlan["strategies"][number];
      const siblings = plan.strategies.filter((x) => x.status !== "retired").sort((a, b) => a.priority - b.priority);
      const index = siblings.findIndex((x) => x.id === s.id);
      const other = siblings[edit.direction === "up" ? index - 1 : index + 1];
      if (!other) return { nodeId: s.id, unchanged: true };
      updateGoalPlanNode(key, s.id, { ord: other.priority, payload: { priority: other.priority } });
      updateGoalPlanNode(key, other.id, { ord: s.priority, payload: { priority: s.priority } });
      return { nodeId: s.id, swappedWith: other.id };
    }
    case "pause_node": {
      const target = node();
      if (target.status === "done") refuse("goal_panel_node_done");
      // Pausing the last open item is applied as well: the turn context then says every remaining item is owner-paused (skip them, do
      // not claim completion, report briefly) and the loop's stall window ends repeated idle turns; the owner lifts it with resume.
      updateGoalPlanNode(key, target.id, { payload: { ownerPaused: true, ownerPausedAt: at } });
      return { nodeId: target.id };
    }
    case "resume_node": {
      const target = node();
      updateGoalPlanNode(key, target.id, { payload: { ownerPaused: false, ownerPausedAt: null } });
      return { nodeId: target.id };
    }
    case "mark_done": {
      const target = node();
      const evidence = "Marked done by the owner in the goal panel.";
      const tactics = tactic ? [tactic] : plan.tactics.filter((t) => t.strategy_id === target.id && open(t));
      for (const t of tactics) {
        updateGoalPlanNode(key, t.id, { status: "done", payload: { evidence, guidance: null, deferredUntil: null, ownerPaused: false, doneBy: "owner" } });
        recordGoalPlanDecision({ ...key, kind: "tactic_status", createdAt: at, payload: { tacticId: t.id, status: "done", evidence, actor: "owner", runId: null } });
      }
      if (strategy) updateGoalPlanNode(key, strategy.id, { status: "done", payload: { doneBy: "owner", doneAt: at } });
      return { nodeId: target.id, tactics: tactics.map((t) => t.id) };
    }
  }
}

/** Owner intent edit of the final goal: an owner message + the owner-amendment path → a goal revision. */
function amendObjective(chatId: string, goalId: string, text: string, liveTurn: boolean, suggestionId?: string): "revised" | "amendment_pending" {
  let revision = getChatGoalRevision(goalId);
  if (!revision) {
    // A Goal defined before it had a contract (chats:defineGoal during an ordinary turn) has a ledger row and no revision. The owner
    // editing it here is the owner's own act, the same as pressing Resume: the permission the owner's newest turn in this room recorded
    // is its grant (goal-owner-resume.ts does exactly this). Only a room where the owner never had a turn has no permission on record, and
    // then the edit is refused with the sentence that tells the owner to say it in the conversation (an owner message there is the grant).
    try { adoptExplicitGoalGrant(goalId, undefined, { ownerResume: true }); } catch { /* the Goal is kept as it is */ }
    revision = getChatGoalRevision(goalId);
  }
  if (!revision) refuse("goal_panel_no_revision");
  const run = getLongRunByGoalId(goalId);
  if (!run || run.rootChatId !== chatId) refuse("goal_control_binding_changed");
  const message = getDb().transaction(() => {
    const appended = appendChatMessage(chatId, "user", text);
    if (!recordPendingOwnerGoalAmendment(goalId, appended.id)) throw new PanelRefusal("goal_panel_amendment_not_recorded");
    return appended;
  })();
  const applied = applyPendingOwnerGoalAmendments(goalId, { noLiveTurn: !liveTurn });
  const current = getChatGoalRevision(goalId);
  const plan = readGoalPlan(goalId);
  if (plan) {
    recordGoalPlanDecision({ goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "owner_edit", payload: {
      actor: "owner", op: suggestionId ? "accept_suggestion" : "amend_objective", ...(suggestionId ? { suggestionId, field: "objective" } : {}),
      sourceMessageId: message.id, fromRevision: revision!.revision, toRevision: current?.revision ?? revision!.revision,
      outcome: applied.applied ? "revised" : `pending:${applied.reason}` } });
  }
  return applied.applied ? "revised" : "amendment_pending";
}

export function editGoalPanel(rawRequest: unknown, deps: { activeChatIds: () => string[]; nowMs?: number; shape?: typeof ensureGoalShapeBeforeTurn }): GoalPanelEditResult {
  const request = rawRequest && typeof rawRequest === "object" ? rawRequest as Record<string, unknown> : {};
  const chatId = typeof request.chatId === "string" ? request.chatId : "";
  const view = () => { try { return readGoalPanel(chatId); } catch { return null; } };
  try {
    const chat = chatId ? getChat(chatId) : null;
    if (!chat?.goalId || request.expectedGoalId !== chat.goalId) refuse("goal_control_binding_changed");
    const goalId = chat!.goalId!;
    const edit = parseGoalPanelEdit(request.edit);
    if (!edit) refuse("goal_panel_edit_invalid");
    const run = getLongRunByGoalId(goalId);
    if (!run || run.rootChatId !== chatId) refuse("goal_control_binding_changed");
    if (TERMINAL.has(run!.status)) refuse("goal_panel_goal_ended");
    const liveTurn = deps.activeChatIds().includes(chatId);
    const at = new Date(deps.nowMs ?? Date.now()).toISOString();
    if (edit!.op === "amend_objective") {
      const outcome = amendObjective(chatId, goalId, edit!.text, liveTurn);
      notify(chatId, run!.id);
      return { ok: true, outcome, view: view() };
    }
    if (edit!.op === "accept_suggestion" || edit!.op === "dismiss_suggestion") {
      const suggestion = agiSuggestions(goalId).find((s) => s.id === (edit as { suggestionId: string }).suggestionId);
      if (!suggestion) refuse("goal_panel_suggestion_not_found");
      if (edit!.op === "accept_suggestion" && suggestion!.field === "objective") {
        const outcome = amendObjective(chatId, goalId, suggestion!.text, liveTurn, suggestion!.id);
        notify(chatId, run!.id);
        return { ok: true, outcome, view: view() };
      }
      const plan = readGoalPlan(goalId);
      if (!plan) refuse("goal_panel_no_plan");
      getDb().transaction(() => {
        const detail = edit!.op === "accept_suggestion"
          ? applyPlanEdit(plan!, { op: "edit_node", nodeId: suggestion!.nodeId ?? "", ...(suggestion!.field === "intent" ? { intent: suggestion!.text } : { doneWhen: suggestion!.text }) }, at)
          : {};
        recordGoalPlanDecision({ goalId, revision: plan!.revision, planSeq: plan!.planSeq, kind: "owner_edit", createdAt: at,
          payload: { actor: "owner", op: edit!.op, suggestionId: suggestion!.id, field: suggestion!.field, ...detail } });
      })();
      notify(chatId, run!.id);
      return { ok: true, outcome: "applied", view: view() };
    }
    const plan = readGoalPlan(goalId);
    if (!plan) refuse("goal_panel_no_plan");
    const revision = getChatGoalRevision(goalId);
    if (revision && plan!.revision < revision.revision) {
      // The plan still belongs to the goal as it was before its last revision; the planner divides the revised goal before the
      // next run. Do not leave that to the next run alone: start it now (the panel, the phone and an agent all see the plan
      // being re-divided, and edits resume on the new plan as soon as it lands).
      healGoalPanelPlan(chatId, deps.shape ? { shape: deps.shape } : {});
      refuse("goal_panel_plan_behind_revision");
    }
    // A caller that names no plan (an agent calling the panel without a view) edits the latest plan by node id; a caller that
    // names one (the panel, the phone) is held to it, because node ids of an older plan can mean other nodes in a newer one.
    const expected = request.expectedPlan && typeof request.expectedPlan === "object" ? request.expectedPlan as Record<string, unknown> : null;
    if (expected && expected.revision !== plan!.revision) refuse("goal_panel_plan_changed");
    // A new shape of the SAME goal revision replaced the plan the owner was looking at (the planner upgrading a fallback plan, a
    // re-division the owner asked for). The edit is no longer refused for that alone: it goes through when every item it names is
    // still that same item in the current plan. Node ids are minted per shape, so an id alone can mean another item now; an item
    // that is gone, or became another one, is "not found" (the view returned with the refusal already shows the current plan).
    if (expected && expected.planSeq !== plan!.planSeq) {
      const seen = typeof expected.planSeq === "number" && Number.isSafeInteger(expected.planSeq)
        ? (() => { try { return readGoalPlan(goalId, plan!.revision, getDb(), expected.planSeq as number); } catch { return null; } })() : null;
      if (!seen) refuse("goal_panel_plan_changed");
      const mismatch = planEditMismatch(seen!, plan!, edit as GoalPanelEdit);
      if (mismatch) refuse(mismatch);
    }
    getDb().transaction(() => {
      const detail = applyPlanEdit(plan!, edit as Parameters<typeof applyPlanEdit>[1], at);
      recordGoalPlanDecision({ goalId, revision: plan!.revision, planSeq: plan!.planSeq, kind: "owner_edit", createdAt: at,
        payload: { actor: "owner", op: edit!.op, ...detail } });
    })();
    notify(chatId, run!.id);
    return { ok: true, outcome: "applied", view: view() };
  } catch (error) {
    if (error instanceof PanelRefusal) return { ok: false, code: error.message, view: view() };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: /^[a-z][a-z0-9_.:-]{2,80}$/.test(message) ? message : "goal_panel_edit_failed", view: view() };
  }
}

function goalRuntimeSelection(runId: string): RuntimeSelection | undefined {
  const row = getDb().prepare(`SELECT a.runtime_selection_json FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id = a.worker_id
    WHERE a.run_id = ? AND w.role = 'controller' ORDER BY a.started_at DESC LIMIT 1`).get(runId) as { runtime_selection_json: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.runtime_selection_json) as RuntimeSelection; } catch { return undefined; }
}

/** The planner call behind "나누기" and behind the automatic re-division of a revised goal. */
function startGoalShape(chatId: string, goalId: string, run: NonNullable<ReturnType<typeof getLongRunByGoalId>>, opts: {
  shape?: typeof ensureGoalShapeBeforeTurn; ownerRequested: boolean;
}): Promise<void> {
  const before = readGoalPlan(goalId);
  shaping.set(goalId, { running: true, failed: false });
  notify(chatId, run.id);
  const objective = getChatGoalRevision(goalId)?.objective ?? run.objective;
  const runtimeSelection = (() => { try { return goalRuntimeSelection(run.id); } catch { return undefined; } })();
  return (opts.shape ?? ensureGoalShapeBeforeTurn)({ goalId, objective, ...(opts.ownerRequested ? { ownerRequested: true } : {}),
    ...(runtimeSelection ? { runtimeSelection } : {}) })
    .then((plan) => {
      const shaped = Boolean(plan && !plan.fallback && (!before || plan.planSeq !== before.planSeq || plan.revision !== before.revision));
      shaping.set(goalId, { running: false, failed: !shaped });
    }, () => { shaping.set(goalId, { running: false, failed: true }); })
    .finally(() => notify(chatId, run.id));
}

/** "나누기": ask the planner to shape this goal into a tree. Returns at once; the view refreshes when it lands. */
export function requestGoalPanelShape(chatId: string, expectedGoalId: unknown, deps: {
  shape?: typeof ensureGoalShapeBeforeTurn;
} = {}): GoalPanelEditResult & { done?: Promise<void> } {
  const view = () => { try { return readGoalPanel(chatId); } catch { return null; } };
  const chat = getChat(chatId);
  if (!chat?.goalId || expectedGoalId !== chat.goalId) return { ok: false, code: "goal_control_binding_changed", view: view() };
  const goalId = chat.goalId;
  const run = getLongRunByGoalId(goalId);
  if (!run || run.rootChatId !== chatId || !ownsHostGoalLoop(run.surface)) return { ok: false, code: "goal_panel_shape_unavailable", view: view() };
  if (TERMINAL.has(run.status)) return { ok: false, code: "goal_panel_goal_ended", view: view() };
  if (shaping.get(goalId)?.running) return { ok: true, outcome: "applied", view: view() };
  const done = startGoalShape(chatId, goalId, run, { ...deps, ownerRequested: true });
  return { ok: true, outcome: "applied", view: view(), done };
}

/** Goal revisions the panel already asked the planner to re-divide in this process (goalId:revision). Bounded: one try each. */
const redivisionAsked = new Set<string>();

/**
 * A goal that was revised keeps showing its previous plan (read-only, "re-divided before the next run") until the planner has
 * divided the new revision, and that only happened when the next turn started — hours for a Goal waiting on a timer. Ask the
 * planner now, once per revision, for a goal that is still going to run (not paused by the owner, not ended, run by this app's
 * goal loop). It is the same call the next turn would make (ensureGoalShapeBeforeTurn is single-flight per goal), only earlier;
 * a failure leaves the provisional plan the next turn retries, exactly as before.
 */
export function healGoalPanelPlan(chatId: string, deps: { shape?: typeof ensureGoalShapeBeforeTurn } = {}): Promise<void> | null {
  try {
    const chat = getChat(chatId);
    const goalId = chat?.goalId ?? null;
    if (!chat || !goalId) return null;
    const run = getLongRunByGoalId(goalId);
    const revision = getChatGoalRevision(goalId);
    if (!run || !revision || run.rootChatId !== chatId || !ownsHostGoalLoop(run.surface)) return null;
    if (TERMINAL.has(run.status) || run.status === "paused" || run.status === "pausing") return null;
    const plan = readGoalPlan(goalId);
    if (!plan || plan.revision >= revision.revision) return null;
    const key = `${goalId}:${revision.revision}`;
    if (redivisionAsked.has(key) || shaping.get(goalId)?.running) return null;
    redivisionAsked.add(key);
    if (redivisionAsked.size > 256) redivisionAsked.delete(redivisionAsked.values().next().value as string);
    return startGoalShape(chatId, goalId, run, { ...deps, ownerRequested: false });
  } catch { return null; }
}
