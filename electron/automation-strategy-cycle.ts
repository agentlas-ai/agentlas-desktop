/**
 * Main-owned strategy cycle shared by scheduled and direct Graph runs.
 *
 * A Graph run only supplies host-observed facts.  The cycle keeps the model
 * call read-only, admits the typed draft through the proposal ledger, and lets
 * the independent Goal/definition/CAS boundary decide whether a revision can
 * be applied.  It is deliberately content-light: raw tool output never enters
 * the strategy ledger.
 */
import { sha256Value } from "../shared/graph-execution-digest";
import type { AutomationRunRecord, RuntimeSelection } from "../shared/types";
import type { GoalStrategyAutomationRecommendationV1 } from "../shared/goal-strategy";
import { getChatGoalContract, getChatGoalRevision } from "./store/chat-goals";
import { getAutomation } from "./store/automations";
import {
  adjudicateAutomationStrategyProposal,
  createAutomationStrategyProposalForRun,
  getAutomationStrategyGoalOrigin,
  type AutomationStrategyProposalObservationV1,
} from "./store/automation-strategy-proposals";
import { getLatestAutomationStrategyRevision } from "./store/automation-strategy-revisions";
import { readCurrentGoalAutomationBinding } from "./long-run/automation-provenance";
import { reflectAutomationStrategyProposal, type AutomationStrategyReflectionInput } from "./automation-strategy-reflection";
import { automationNoActionStreak, recentAutomationRunFacts } from "./automation-progress-facts";
import {
  AUTOMATION_STRATEGY_RUN_EVENT_QUERY_LIMIT,
  buildAutomationStrategyFollowUpEvidence,
  summarizeAutomationStrategyRun,
  type AutomationStrategyRunEventLike,
} from "./automation-strategy-follow-up";
import { observedToolActivity } from "./store/run-events";
import { getDb } from "./store/db";
import { recordRunEvent, tryRecordRunEvent } from "./store/run-events";

/**
 * Keep this gate in the shared cycle so scheduled and direct Graph runs make
 * the same fail-closed decision. The kernel's durable failure vocabulary uses
 * the raw `MUTATION_UNVERIFIED` code; some adapters expose only the older
 * reconciliation message, so both forms remain accepted here.
 */
const STRATEGY_EFFECT_UNCERTAIN_RE = /(?:MUTATION_UNVERIFIED|partial_reconciliation_required|ambiguous_side_effect|automation_partial_graph_changed)/i;

export function requiresGraphReconciliation(detail: string | null | undefined): boolean {
  return STRATEGY_EFFECT_UNCERTAIN_RE.test(detail ?? "");
}

type StrategyEventCoverage = "complete" | "truncated" | "unavailable";

export interface AutomationStrategyCycleInput {
  automationId: string;
  sourceRunId: string;
  status: AutomationRunRecord["status"];
  outcome: AutomationRunRecord["outcome"];
  reasonCode?: string | null;
  output?: string | null;
  /** Scheduler owns this deterministic reconciliation gate; direct Graph runs derive it from error. */
  effectsUnconfirmed?: boolean;
  /** Direct Graph runs can provide the raw kernel error without a scheduler classification. */
  runError?: string | null;
  runtimeSelection?: RuntimeSelection | null;
  /** Main-verified Goal evidence. A separate request identity preserves the
   * ordinary post-run cycle and its original proposal receipt. */
  goalRecommendation?: GoalStrategyAutomationRecommendationV1;
  signal?: AbortSignal;
}

function readStrategyObservationEvents(runId: string): {
  events: AutomationStrategyRunEventLike[];
  coverage: StrategyEventCoverage;
} {
  const rows = getDb()
    .prepare(
      `SELECT kind, node_id, payload_json
       FROM run_events
       WHERE run_id = ? AND kind IN ('workflow_graph_started', 'workflow_node_state',
         'automation_strategy_revision_consumed')
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(runId, AUTOMATION_STRATEGY_RUN_EVENT_QUERY_LIMIT) as Array<{
      kind: string;
      node_id: string | null;
      payload_json: string;
    }>;
  let malformedPayload = false;
  const events = rows.map((row): AutomationStrategyRunEventLike => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      } else {
        malformedPayload = true;
      }
    } catch {
      malformedPayload = true;
    }
    return {
      kind: row.kind,
      ...(row.node_id ? { nodeId: row.node_id } : {}),
      payload,
    };
  });
  return {
    events,
    coverage: rows.length >= AUTOMATION_STRATEGY_RUN_EVENT_QUERY_LIMIT
      ? "truncated"
      : malformedPayload
        ? "unavailable"
        : "complete",
  };
}

function readStrategyToolActivityCoverage(runId: string): StrategyEventCoverage {
  const rows = getDb()
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE run_id = ? AND kind IN ('mcp_tool-use', 'graph_host_effect')
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(runId, AUTOMATION_STRATEGY_RUN_EVENT_QUERY_LIMIT) as Array<{ payload_json: string }>;
  if (rows.length >= AUTOMATION_STRATEGY_RUN_EVENT_QUERY_LIMIT) return "truncated";
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unavailable";
    } catch {
      return "unavailable";
    }
  }
  return "complete";
}

function unavailable(
  input: AutomationStrategyCycleInput,
  reason: string,
  extra: Record<string, unknown> = {},
): void {
  tryRecordRunEvent({
    runId: input.sourceRunId,
    kind: "automation_strategy_reflection_unavailable",
    automationId: input.automationId,
    payload: { reason, status: input.status, outcome: input.outcome,
      ...(input.goalRecommendation ? { goalProposalId: input.goalRecommendation.proposalId } : {}), ...extra },
  });
  console.info("[automation] strategy reflection settled", JSON.stringify({
    automationId: input.automationId,
    sourceRunId: input.sourceRunId,
    status: "unavailable",
    reason,
  }));
}

/** Host-counted no-progress signal carried into the next strategy reflection. */
function readRecentRunProgress(automationId: string): AutomationStrategyReflectionInput["recentRunProgress"] {
  try {
    return {
      noActionStreak: automationNoActionStreak(automationId),
      runs: recentAutomationRunFacts(automationId, 6).map((fact) => ({
        ranAt: fact.ranAt,
        status: fact.status,
        outcome: fact.outcome,
        actionCalls: fact.actionCalls,
        observationCalls: fact.observationCalls,
      })),
    };
  } catch {
    return null;
  }
}

function outputObservation(input: AutomationStrategyCycleInput, metrics: ReturnType<typeof summarizeAutomationStrategyRun>["metrics"]): AutomationStrategyProposalObservationV1 {
  return {
    schemaVersion: "agentlas.automation-strategy-observation.v1",
    status: input.status,
    outcome: input.outcome,
    reasonCode: input.reasonCode ?? null,
    outputDigest: input.output == null ? null : sha256Value(input.output),
    outputLength: input.output?.length ?? 0,
    metrics,
  };
}

/**
 * Complete one post-Graph strategy cycle.  The function is advisory with
 * respect to the already-settled run: all reflection/admission failures are
 * recorded as unavailable and never turn a successful Graph result into an
 * execution failure.
 */
export async function runAutomationStrategyCycle(input: AutomationStrategyCycleInput): Promise<void> {
  let strategyRunEvents: AutomationStrategyRunEventLike[] = [];
  let strategyActivity = { callCount: 0, toolNames: [] as string[] };
  let eventWindowCoverage: StrategyEventCoverage = "unavailable";
  let toolActivityCoverage: StrategyEventCoverage = "unavailable";
  try {
    const observation = readStrategyObservationEvents(input.sourceRunId);
    strategyRunEvents = observation.events;
    eventWindowCoverage = observation.coverage;
    strategyActivity = observedToolActivity(input.sourceRunId);
    toolActivityCoverage = readStrategyToolActivityCoverage(input.sourceRunId);
  } catch (error) {
    console.warn("[automation] strategy run metrics unavailable:", error);
  }

  const strategyRunSummary = summarizeAutomationStrategyRun(
    strategyRunEvents,
    strategyActivity,
    getAutomation(input.automationId)?.nextRunAt ?? null,
    {
      eventWindowCoverage,
      toolActivityCoverage,
    },
  );
  const observation = outputObservation(input, strategyRunSummary.metrics);
  const effectsUnconfirmed = input.effectsUnconfirmed === true
    || requiresGraphReconciliation(input.runError);
  const observationCoverageIncomplete = strategyRunSummary.metrics.coverage !== "complete"
    || strategyRunSummary.metrics.toolActivityCoverage !== "complete";

  if (effectsUnconfirmed) {
    unavailable(input, "source_effects_unconfirmed");
  } else if (observationCoverageIncomplete) {
    unavailable(input, "observation_coverage_incomplete", {
      coverage: strategyRunSummary.metrics.coverage,
      toolActivityCoverage: strategyRunSummary.metrics.toolActivityCoverage,
    });
  } else {
    try {
      const reflectionAutomation = getAutomation(input.automationId);
      if (!reflectionAutomation?.graph) {
        unavailable(input, "reflection_automation_missing");
      } else {
        const binding = readCurrentGoalAutomationBinding(input.automationId);
        const goalId = binding?.goalId ?? reflectionAutomation.goalId ?? null;
        // A legacy monitor may retain Goal chat origin without the exact
        // Goal-created provenance bridge. It is evidence only; the proposal
        // store independently checks ownership before applying a revision.
        const origin = !goalId ? getAutomationStrategyGoalOrigin(input.automationId) : null;
        const reflectionGoalId = goalId ?? origin?.goalId ?? null;
        const goalRevision = reflectionGoalId ? getChatGoalRevision(reflectionGoalId) : null;
        const goalContract = reflectionGoalId ? getChatGoalContract(reflectionGoalId) : null;
        if (input.goalRecommendation && (
          input.goalRecommendation.intent === "hold"
          || !binding
          || binding.goalId !== input.goalRecommendation.goalId
          || binding.goalRevision !== input.goalRecommendation.goalRevision
          || goalRevision?.revision !== input.goalRecommendation.goalRevision
          || goalContract?.status !== "active"
        )) {
          unavailable(input, "goal_recommendation_stale");
          return;
        }
        const reflection = await reflectAutomationStrategyProposal({
          automationId: input.automationId,
          sourceRunId: input.sourceRunId,
          runtimeSelection: reflectionAutomation.runtimeSelection ?? input.runtimeSelection,
          promptTemplate: reflectionAutomation.promptTemplate,
          scheduleSpec: reflectionAutomation.scheduleSpec,
          timezone: reflectionAutomation.timezone,
          triggerType: reflectionAutomation.triggerType,
          graph: reflectionAutomation.graph,
          goal: goalRevision && goalContract ? {
            revision: goalRevision,
            status: goalContract.status,
            authority: goalId ? "verified_binding" : "unverified_origin",
          } : null,
          observation,
          terminalOutput: input.output ?? null,
          previousRevision: getLatestAutomationStrategyRevision(input.automationId),
          recentRunProgress: readRecentRunProgress(input.automationId),
          ...(input.goalRecommendation ? { goalRecommendation: input.goalRecommendation } : {}),
          signal: input.signal,
        });
        if (reflection.status !== "proposal") {
          unavailable(input, reflection.reason);
        } else {
          const proposal = createAutomationStrategyProposalForRun({
            actor: "main",
            automationId: input.automationId,
            sourceRunId: input.sourceRunId,
            requestId: input.goalRecommendation
              ? `strategy-proposal:goal:${input.goalRecommendation.proposalId}:${input.sourceRunId}`
              : `strategy-proposal:reflection:${input.sourceRunId}`,
            intent: reflection.envelope.intent,
            rationale: reflection.envelope.rationale,
            conflict: "uncertain",
            strategy: reflection.envelope.strategy,
            graphPatch: reflection.envelope.graphPatch,
            schedulePatch: reflection.envelope.schedulePatch,
            requiresPaymentApproval: reflection.envelope.requiresPaymentApproval,
            observation,
          });
          const reviewed = await adjudicateAutomationStrategyProposal({
            automationId: input.automationId,
            proposalId: proposal.id,
          });
          tryRecordRunEvent({
            runId: input.sourceRunId,
            kind: "automation_strategy_reflection_proposed",
            automationId: input.automationId,
            payload: {
              proposalId: proposal.id,
              intent: reflection.envelope.intent,
              status: reviewed.status,
              reviewStatus: reviewed.reviewStatus,
              conflict: reviewed.conflict,
              ...(input.goalRecommendation ? { goalProposalId: input.goalRecommendation.proposalId } : {}),
              runtime: reflection.runtimeReceipt ? {
                selection: {
                  kind: reflection.runtimeReceipt.selection.kind,
                  backend: reflection.runtimeReceipt.selection.backend ?? null,
                  model: reflection.runtimeReceipt.selection.model ?? null,
                },
                route: reflection.runtimeReceipt.route,
                execution: reflection.runtimeReceipt.execution,
                fingerprint: reflection.runtimeReceipt.fingerprint,
              } : null,
            },
          });
          console.info("[automation] strategy reflection settled", JSON.stringify({
            automationId: input.automationId,
            sourceRunId: input.sourceRunId,
            status: "proposal",
            proposalId: proposal.id,
            intent: reflection.envelope.intent,
            reviewStatus: reviewed.reviewStatus,
            conflict: reviewed.conflict,
            revisionStatus: reviewed.status,
            runtimeRoute: reflection.runtimeReceipt?.route ?? null,
            runtimeKind: reflection.runtimeReceipt?.selection.kind ?? null,
            runtimeModel: reflection.runtimeReceipt?.selection.model ?? null,
          }));
        }
      }
    } catch (error) {
      unavailable(input, "reflection_handoff_failed");
      console.error("[automation] strategy reflection handoff failed:", error);
    }
  }

  // A revision receipt proves Main changed the graph. This content-free event
  // proves that a later Graph run consumed that exact revision and records the
  // next durable schedule. It is idempotent by source run id.
  try {
    if (!effectsUnconfirmed) {
      const followUp = buildAutomationStrategyFollowUpEvidence({
        automationId: input.automationId,
        runId: input.sourceRunId,
        events: strategyRunEvents,
        activity: strategyActivity,
        nextRunAt: getAutomation(input.automationId)?.nextRunAt ?? null,
        eventWindowCoverage,
        toolActivityCoverage,
      });
      if (followUp) {
        const persisted = recordRunEvent({
          runId: input.sourceRunId,
          kind: "automation_strategy_follow_up",
          automationId: input.automationId,
          sourceEventId: `automation-strategy-follow-up:${input.sourceRunId}`,
          payload: { ...followUp },
        });
        console.info("[automation] strategy follow-up persisted", JSON.stringify({
          automationId: input.automationId,
          runId: input.sourceRunId,
          sourceRunId: followUp.sourceRunId,
          revision: followUp.consumedRevision,
          nextRunAt: followUp.nextRunAt,
          eventId: persisted.id,
        }));
      }
    }
  } catch (error) {
    console.error("[automation] strategy follow-up evidence persistence failed:", error);
  }
}
