/**
 * Goal completion rolls up from the AI's own decomposition — owner 2026-09-25:
 * "기준 5개 하드코딩 이런 거 없어야지 … 하위골 합산 > 전략 달성 > 전략들 달성 > 최종목표 달성."
 *
 * References this follows (cited in the commit):
 *  - WBS 100% rule: the children of a node together are 100% of the parent — no gaps, no overlap.
 *    A parent is done exactly when its children are done.
 *  - OKR roll-up: an objective is achieved when its key results are met; results roll upward.
 *  - HTN / ADaPT: a task is decomposed (as needed) into sub-tasks whose own conditions define success;
 *    decomposition count is the planner's decision, not a fixed template.
 *
 * Leaves are the plan's non-retired tactics (each carries the AI's own done_when) and the mission's key
 * results (owner numbers only, validated in goal-shape.ts R3). There is no fixed number of anything:
 * whatever the planner produced is the checklist. Pure functions; no I/O.
 */
import type { LiveGoalPlan } from "./goal-shape";

export interface DecompositionLeaf {
  nodeId: string;
  /** Where the leaf sits, for the verdict the owner reads (e.g. "s1 › t2", "t1", "KR followers"). */
  label: string;
  strategyId: string | null;
  text: string;
}

export type LeafVerdict = "passed" | "failed" | "inconclusive";

export function decompositionLeaves(plan: LiveGoalPlan): DecompositionLeaf[] {
  const liveStrategies = new Set(plan.strategies.filter((s) => s.status !== "retired").map((s) => s.id));
  const tactics = plan.tactics
    .filter((t) => t.status !== "retired" && (t.strategy_id === null || liveStrategies.has(t.strategy_id)))
    .sort((a, b) => a.ord - b.ord);
  const leaves: DecompositionLeaf[] = tactics.map((t) => ({
    nodeId: `tactic:${t.id}`,
    label: t.strategy_id ? `${t.strategy_id} › ${t.id}` : t.id,
    strategyId: t.strategy_id,
    text: `${t.kind === "recurring" ? "(recurring — this episode) " : ""}${t.description.trim()} — done when: ${t.done_when.trim()}`,
  }));
  for (const kr of plan.mission?.key_results ?? []) {
    leaves.push({
      nodeId: `kr:${kr.id}`,
      label: `KR ${kr.metric}`,
      strategyId: null,
      text: `Key result: ${kr.metric} reaches ${kr.target_text || `${kr.target} ${kr.unit}`.trim()}`
        + `${kr.deadline_at ? ` by ${kr.deadline_at}` : ""}${kr.baseline !== null ? ` (baseline ${kr.baseline})` : ""}.`
        + " Judge only from an observed current value; an unobservable value is inconclusive.",
    });
  }
  return leaves;
}

export interface DecompositionRollup {
  /** Every leaf passed (and so every live strategy and the mission). */
  achieved: boolean;
  /** One line the owner reads: what is achieved, and which node is open and why. */
  summary: string;
  record: {
    leaves: Array<{ nodeId: string; verdict: LeafVerdict; reason: string }>;
    strategies: Array<{ id: string; achieved: boolean; open: string[] }>;
    keyResults: Array<{ nodeId: string; achieved: boolean }>;
    mission: { achieved: boolean };
  };
}

export function rollUpDecomposition(plan: LiveGoalPlan, results: Array<{ nodeId: string; verdict: LeafVerdict; reason: string }>): DecompositionRollup {
  const byId = new Map(results.map((r) => [r.nodeId, r]));
  const leaves = decompositionLeaves(plan);
  const passed = (nodeId: string) => byId.get(nodeId)?.verdict === "passed";
  const strategies = plan.strategies.filter((s) => s.status !== "retired").map((s) => {
    const own = leaves.filter((leaf) => leaf.strategyId === s.id);
    const open = own.filter((leaf) => !passed(leaf.nodeId)).map((leaf) => leaf.label);
    // A strategy with no live sub-goal has nothing proving it: it is open, never vacuously achieved.
    return { id: s.id, achieved: own.length > 0 && open.length === 0, open };
  });
  const keyResults = leaves.filter((leaf) => leaf.nodeId.startsWith("kr:")).map((leaf) => ({ nodeId: leaf.nodeId, achieved: passed(leaf.nodeId) }));
  const achieved = leaves.length > 0 && leaves.every((leaf) => passed(leaf.nodeId)) && strategies.every((s) => s.achieved);
  const openLeaves = leaves.filter((leaf) => !passed(leaf.nodeId));
  const summary = achieved
    ? `All ${leaves.length} sub-goal(s) achieved${strategies.length ? `; strategies ${strategies.map((s) => s.id).join(", ")} achieved` : ""}; the goal is achieved.`
    : `Open: ${openLeaves.slice(0, 6).map((leaf) => `[${leaf.label}] ${(byId.get(leaf.nodeId)?.reason ?? "not verified").replace(/\s+/g, " ").slice(0, 220)}`).join(" | ")}`
      + (openLeaves.length > 6 ? ` (+${openLeaves.length - 6} more)` : "")
      + ` — ${leaves.length - openLeaves.length}/${leaves.length} sub-goal(s) achieved.`;
  return {
    achieved,
    summary: summary.slice(0, 2000),
    record: {
      leaves: leaves.map((leaf) => ({ nodeId: leaf.nodeId, verdict: byId.get(leaf.nodeId)?.verdict ?? "inconclusive",
        reason: (byId.get(leaf.nodeId)?.reason ?? "").slice(0, 400) })),
      strategies,
      keyResults,
      mission: { achieved },
    },
  };
}
