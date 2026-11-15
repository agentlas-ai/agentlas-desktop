/**
 * "Use the runtime's own tools for this capability" - one plan-decision line the next turn's plan context carries (long-run/goal-shaping.ts
 * activeNativeHarness) for a day. Written by the goal sweep's rule R-b (long-run/blocked-goal-sweep.ts noteBrowserToolBreakage). Without a
 * plan there is no turn context to carry it.
 */
import { readGoalPlan, recordGoalPlanDecision } from "../store/goal-plans";
import { activeNativeHarness, goalAllowsRuntimeOwnTools } from "../long-run/goal-shaping";

export function recordNativeHarnessNote(input: { goalId: string; runId: string; capability: string; defect?: string }):
  { ok: true; recorded: boolean } | { ok: false; code: string } {
  const plan = readGoalPlan(input.goalId);
  if (!plan) return { ok: false, code: "harness.plan-missing" };
  if (!goalAllowsRuntimeOwnTools(input.goalId)) return { ok: false, code: "harness.permission-read" };
  if (activeNativeHarness(input.goalId, Date.now()).some((entry) => entry.capability === input.capability)) return { ok: true, recorded: false };
  recordGoalPlanDecision({ goalId: input.goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "native_harness", createdAt: new Date().toISOString(),
    payload: { capability: input.capability, defect: input.defect ?? "our_defect", actor: "harness", runId: input.runId } });
  return { ok: true, recorded: true };
}
