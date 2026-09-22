import type { OngoingEpisodeStrategy, OngoingStallReplan, RuntimePlanSnapshot } from "../../shared/runtime-plan";
import type { CheckpointCriterion, GoalVerificationDisposition } from "../../shared/long-run-checkpoint";
import { getDb } from "../store/db";
import { getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRun, getLongRunGoalRevisionBinding, listLongRunTasks } from "../store/long-runs";
import { observeGoalAutomations } from "./automation-provenance";
import { latestTaskCheckpoint } from "./checkpoint";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
export function latestRuntimePlan(runId: string): RuntimePlanSnapshot | null {
  const row = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.plan_revision' ORDER BY seq DESC LIMIT 1")
    .get(runId) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json).plan : null;
}
export function recordRuntimePlan(input: { runId: string; expectedRevision: number | null;
  environmentalFindings?: string[]; decisions?: string[]; evaluation?: string[]; rollback?: string[]; unresolvedQuestions?: string[];
  episodeStrategy?: OngoingEpisodeStrategy; stallReplan?: OngoingStallReplan }): RuntimePlanSnapshot {
  return getDb().transaction(() => {
    const run = getLongRun(input.runId);
    if (!run || run.surface === "science") throw new Error("runtime_plan_run_invalid");
    const prior = latestRuntimePlan(run.id);
    if ((prior?.revision ?? null) !== input.expectedRevision) throw new Error("runtime_plan_revision_conflict");
    const goalRevision = getLongRunGoalRevisionBinding(run.id)?.revision ?? null;
    const currentGoalRevision = getChatGoalRevision(run.goalId)?.revision ?? null;
    const episodeStrategy = input.episodeStrategy
      ?? (prior?.goalRevision === goalRevision && currentGoalRevision === goalRevision ? prior.episodeStrategy : undefined);
    const stallReplan = input.stallReplan
      ?? (prior?.goalRevision === goalRevision && currentGoalRevision === goalRevision ? prior.stallReplan : undefined);
    if ((input.episodeStrategy || input.stallReplan) && currentGoalRevision !== goalRevision) {
      throw new Error("ongoing_strategy_goal_binding_changed");
    }
    if (episodeStrategy && (episodeStrategy.schemaVersion !== "agentlas.ongoing-episode-strategy.v1"
      || episodeStrategy.goalRevision !== goalRevision
      || JSON.stringify(episodeStrategy).length > 2_000)) throw new Error("runtime_plan_episode_strategy_invalid");
    if (stallReplan && (stallReplan.schemaVersion !== "agentlas.ongoing-stall-replan.v1"
      || stallReplan.goalRevision !== goalRevision
      || JSON.stringify(stallReplan).length > 2_000)) throw new Error("runtime_plan_stall_replan_invalid");
    const plan: RuntimePlanSnapshot = { schemaVersion: "agentlas.runtime-plan.v1", runId: run.id,
      revision: (prior?.revision ?? 0) + 1, parentRevision: prior?.revision ?? null, goalRevision,
      requirementsRef: `goal:${run.goalId}${goalRevision ? `:revision:${goalRevision}` : ""}`,
      environmentalFindings: input.environmentalFindings ?? prior?.environmentalFindings ?? [],
      decisions: input.decisions ?? prior?.decisions ?? [], evaluation: input.evaluation ?? prior?.evaluation ?? [],
      rollback: input.rollback ?? prior?.rollback ?? [], unresolvedQuestions: input.unresolvedQuestions ?? prior?.unresolvedQuestions ?? [],
      ...(episodeStrategy ? { episodeStrategy } : {}),
      ...(stallReplan ? { stallReplan } : {}),
      steps: listLongRunTasks(run.id).map((task) => ({ taskId: task.id, title: task.title, state: task.state })),
      createdAt: new Date().toISOString() };
    appendLongRunEvent({ runId: run.id, kind: "run.plan_revision", actorKind: "host", payload: { plan } });
    return plan;
  })();
}

/** Persist a proposal only against the exact settled producer checkpoint and
 * current Goal revision. The model's wording remains descriptive data. */
export function recordOngoingStallReplan(runId: string, replan: OngoingStallReplan): RuntimePlanSnapshot {
  return getDb().transaction(() => {
    const run = getLongRun(runId);
    const revision = run ? getChatGoalRevision(run.goalId) : null;
    const checkpoint = run ? latestTaskCheckpoint(run.goalId) : null;
    const binding = run ? getLongRunGoalRevisionBinding(run.id) : null;
    if (!run || run.surface !== "one" || run.status !== "waiting_tool"
      || revision?.lifecycle !== "ongoing" || revision.revision !== replan.goalRevision
      || binding?.revision !== revision.revision || !checkpoint
      || checkpoint.checkpointId !== replan.sourceCheckpointId
      || checkpoint.invocationRunId !== replan.sourceInvocationRunId
      || checkpoint.disposition !== "retry_required" || checkpoint.sideEffects.state !== "settled"
      || checkpoint.sideEffects.boundary?.snapshotDigest !== replan.effectBoundaryDigest
      || checkpoint.sideEffects.boundary?.receiptEventId !== replan.effectReceiptEventId
      || !replan.progressKey || !replan.modelFingerprint) throw new Error("ongoing_stall_replan_binding_changed");
    const boundary = readInvocationEffectBoundary({ invocationRunId: replan.sourceInvocationRunId,
      expectedChatId: run.rootChatId! });
    if (boundary.effects !== "settled" || boundary.snapshotDigest !== replan.effectBoundaryDigest
      || boundary.receiptEventId !== replan.effectReceiptEventId) throw new Error("ongoing_stall_replan_effect_changed");
    const prior = latestRuntimePlan(runId);
    if (prior?.stallReplan?.sourceCheckpointId === replan.sourceCheckpointId
      && prior.stallReplan.progressKey === replan.progressKey) return prior;
    return recordRuntimePlan({ runId, expectedRevision: prior?.revision ?? null, stallReplan: replan });
  })();
}

/** A bounded *description* of a verified episode, not a new Goal, grant or
 * command. Only typed verifier outcomes and Main's settled effect receipt may
 * change the next action class. Domain KPIs need their own trusted collector;
 * the verifier cannot infer them from a model's success prose. */
export function recordOngoingEpisodeStrategy(input: {
  runId: string;
  expectedGoalRevision: number;
  invocationRunId: string;
  disposition: GoalVerificationDisposition;
  verdicts: readonly CheckpointCriterion[];
  evidenceReady: boolean;
  effectBoundary: { effects: "settled" | "uncertain"; snapshotDigest: string | null; receiptEventId: string | null } | null;
  nextWakeAt: string | null;
}): RuntimePlanSnapshot {
  const run = getLongRun(input.runId);
  const boundRevision = getLongRunGoalRevisionBinding(input.runId)?.revision;
  const currentGoalRevision = run ? getChatGoalRevision(run.goalId) : null;
  if (!run || run.surface === "science" || !run.rootChatId
    || currentGoalRevision?.lifecycle !== "ongoing"
    || currentGoalRevision.revision !== input.expectedGoalRevision
    || boundRevision !== input.expectedGoalRevision
    || !input.invocationRunId.trim() || input.invocationRunId.length > 512) throw new Error("ongoing_strategy_goal_binding_changed");
  const validVerdicts = input.verdicts.length === run.acceptanceCriteria.length
    && new Set(input.verdicts.map(item => item.criterionIndex)).size === run.acceptanceCriteria.length
    && !input.verdicts.some(item => !Number.isSafeInteger(item.criterionIndex)
      || item.criterionIndex < 0 || item.criterionIndex >= run.acceptanceCriteria.length);
  const metrics: OngoingEpisodeStrategy["metrics"] = {
    passed: validVerdicts ? input.verdicts.filter(item => item.verdict === "passed").length : 0,
    repairableFailed: validVerdicts ? input.verdicts.filter(item => item.verdict === "failed" && item.recoveryClass === "repairable").length : 0,
    prerequisiteFailed: validVerdicts ? input.verdicts.filter(item => item.verdict === "failed" && item.recoveryClass === "prerequisite").length : 0,
    otherFailed: validVerdicts ? input.verdicts.filter(item => item.verdict === "failed" && !["repairable", "prerequisite"].includes(item.recoveryClass ?? "unknown")).length : 0,
    inconclusive: validVerdicts ? input.verdicts.filter(item => item.verdict === "inconclusive").length : 0,
  };
  const verified = validVerdicts && input.evidenceReady && input.effectBoundary?.effects === "settled"
    && Boolean(input.effectBoundary.snapshotDigest && input.effectBoundary.receiptEventId);
  let nextAction: OngoingEpisodeStrategy["nextAction"] = "inspect_before_action";
  if (verified && input.disposition === "cycle_completed" && metrics.passed === run.acceptanceCriteria.length) {
    nextAction = "wait_observe";
  } else if (verified && input.disposition === "retry_required" && metrics.repairableFailed > 0) {
    nextAction = "repair_verified_failure";
  } else if (verified && input.disposition === "retry_required" && metrics.inconclusive > 0
    && metrics.repairableFailed === 0 && metrics.prerequisiteFailed === 0 && metrics.otherFailed === 0) {
    nextAction = "gather_missing_evidence";
  } else if (verified && metrics.prerequisiteFailed > 0 && input.disposition === "blocked") {
    nextAction = "hold_for_user";
  }
  const prior = latestRuntimePlan(run.id);
  // A repeated descriptive write is idempotent; the existing checkpoint/wait
  // path must not fail merely because this episode was already summarized.
  if (prior?.goalRevision === boundRevision
    && prior.episodeStrategy?.invocationRunId === input.invocationRunId) return prior;
  const state: OngoingEpisodeStrategy["state"] = !verified || nextAction === "inspect_before_action"
    ? "unknown"
    : prior?.episodeStrategy?.nextAction && prior.episodeStrategy.state !== "unknown"
      ? prior.episodeStrategy.nextAction === nextAction ? "unchanged" : "changed"
      : "unchanged";
  const reasonCode: OngoingEpisodeStrategy["reasonCode"] = state === "unknown" ? "evidence_unavailable"
    : !prior?.episodeStrategy || prior.episodeStrategy.state === "unknown" ? "first_observation"
      : state === "changed" ? "action_changed" : "action_unchanged";
  const nextWakeAt = input.disposition === "cycle_completed" && input.nextWakeAt
    && Number.isFinite(Date.parse(input.nextWakeAt)) && Date.parse(input.nextWakeAt) > Date.now()
    ? input.nextWakeAt : null;
  const episodeStrategy: OngoingEpisodeStrategy = {
    schemaVersion: "agentlas.ongoing-episode-strategy.v1",
    invocationRunId: input.invocationRunId,
    goalRevision: boundRevision,
    effectBoundaryDigest: verified ? input.effectBoundary!.snapshotDigest : null,
    effectReceiptEventId: verified ? input.effectBoundary!.receiptEventId : null,
    metrics,
    state,
    reasonCode,
    nextAction,
    nextWakeAt,
    // An observed scheduler terminal is not a verified external effect or KPI.
    // It is carried for the next episode's inspect/reconcile step only.
    automationObservations: observeGoalAutomations({ goalId: run.goalId,
      expectedGoalRevision: boundRevision, chatId: run.rootChatId }),
  };
  // A later task-state snapshot must retain this exact host evaluation. There
  // are no model-written free-text decisions to copy or execute here.
  return recordRuntimePlan({ runId: run.id, expectedRevision: prior?.revision ?? null, episodeStrategy });
}
