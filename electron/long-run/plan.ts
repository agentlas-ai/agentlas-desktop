import type { RuntimePlanSnapshot } from "../../shared/runtime-plan";
import { getDb } from "../store/db";
import { appendLongRunEvent, getLongRun, getLongRunGoalRevisionBinding, listLongRunTasks } from "../store/long-runs";
export function latestRuntimePlan(runId: string): RuntimePlanSnapshot | null {
  const row = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.plan_revision' ORDER BY seq DESC LIMIT 1")
    .get(runId) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json).plan : null;
}
export function recordRuntimePlan(input: { runId: string; expectedRevision: number | null;
  environmentalFindings?: string[]; decisions?: string[]; evaluation?: string[]; rollback?: string[]; unresolvedQuestions?: string[] }): RuntimePlanSnapshot {
  return getDb().transaction(() => {
    const run = getLongRun(input.runId);
    if (!run || run.surface === "science") throw new Error("runtime_plan_run_invalid");
    const prior = latestRuntimePlan(run.id);
    if ((prior?.revision ?? null) !== input.expectedRevision) throw new Error("runtime_plan_revision_conflict");
    const goalRevision = getLongRunGoalRevisionBinding(run.id)?.revision ?? null;
    const plan: RuntimePlanSnapshot = { schemaVersion: "agentlas.runtime-plan.v1", runId: run.id,
      revision: (prior?.revision ?? 0) + 1, parentRevision: prior?.revision ?? null, goalRevision,
      requirementsRef: `goal:${run.goalId}${goalRevision ? `:revision:${goalRevision}` : ""}`,
      environmentalFindings: input.environmentalFindings ?? prior?.environmentalFindings ?? [],
      decisions: input.decisions ?? prior?.decisions ?? [], evaluation: input.evaluation ?? prior?.evaluation ?? [],
      rollback: input.rollback ?? prior?.rollback ?? [], unresolvedQuestions: input.unresolvedQuestions ?? prior?.unresolvedQuestions ?? [],
      steps: listLongRunTasks(run.id).map((task) => ({ taskId: task.id, title: task.title, state: task.state })),
      createdAt: new Date().toISOString() };
    appendLongRunEvent({ runId: run.id, kind: "run.plan_revision", actorKind: "host", payload: { plan } });
    return plan;
  })();
}
