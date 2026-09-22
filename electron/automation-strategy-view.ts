import type { AutomationStrategyProposalView } from "../shared/automation-strategy-review";
import { graphExecutionDigest } from "../shared/graph-execution-digest";
import { getAutomationDefinitionDigest } from "./long-run/automation-provenance";
import { getAutomationStrategyProposalApplicability, type AutomationStrategyProposalReceipt } from "./store/automation-strategy-proposals";
import { getAutomation } from "./store/automations";
import { getDb } from "./store/db";
import { getChatGoalRevision } from "./store/chat-goals";
import { getLongRunByGoalId } from "./store/long-runs";
import { describeSchedule } from "../shared/schedule-describe";
import type { JudgmentRuntimeReceipt } from "./system-agents/judgment";

function runtimeView(
  selection: { kind: string; backend?: string | null; model?: string | null } | null | undefined,
  route: "execution_pin" | "configured_orchestrator_pool" | null,
  receipt?: JudgmentRuntimeReceipt | null,
) {
  if (!selection && !receipt) return null;
  const chosen = receipt?.selection ?? selection;
  if (!chosen) return null;
  return {
    kind: chosen.kind,
    backend: chosen.backend ?? null,
    model: chosen.model ?? null,
    route,
    poolFingerprint: receipt?.fingerprint ?? null,
    capability: receipt?.capability ? {
      status: receipt.capability.status,
      enforcement: receipt.capability.enforcement,
      reason: receipt.capability.reason,
    } : null,
  } as const;
}

/** A write receipt and a later execution receipt are distinct user-visible facts. */
function consumptionTime(proposal: AutomationStrategyProposalReceipt): string | null {
  const revision = proposal.revisionReceipt;
  if (!revision) return null;
  const rows = getDb().prepare(`SELECT e.ts, e.payload_json FROM run_events e
    JOIN automation_runs r ON r.id = e.run_id AND r.automation_id = e.automation_id
    WHERE e.automation_id = ? AND e.kind = 'automation_strategy_revision_consumed'
      AND r.dry_run = 0 AND e.ts >= ?
      AND json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END, '$.revision') = ?
      ORDER BY e.ts DESC LIMIT 128`)
    .all(proposal.automationId, revision.appliedAt, revision.revision) as Array<{ ts: string; payload_json: string }>;
  for (const row of rows) {
    try {
      const value = JSON.parse(row.payload_json);
      if (value.status === "consumed" && value.revision === revision.revision
        && value.sourceRunId === revision.sourceRunId
        && value.runGraphDigest === revision.graphDigest
        && value.revisionGraphDigest === revision.graphDigest
        && value.runDefinitionDigest === revision.definitionDigest
        && value.revisionDefinitionDigest === revision.definitionDigest
        && value.strategyDigest === revision.strategyDigest) return row.ts;
    } catch { /* A malformed event is not execution evidence. */ }
  }
  return null;
}

export function automationStrategyProposalView(proposal: AutomationStrategyProposalReceipt): AutomationStrategyProposalView {
  const automation = getAutomation(proposal.automationId);
  const executionRuntime = runtimeView(automation?.runtimeSelection, "execution_pin");
  const judgmentRuntime = runtimeView(
    proposal.adjudication.runtimeReceipt?.selection,
    proposal.adjudication.runtimeReceipt?.route === "orchestrator_pool" ? "configured_orchestrator_pool" : null,
    proposal.adjudication.runtimeReceipt,
  );
  const current = Boolean(automation?.graph
    && graphExecutionDigest(automation, automation.graph) === proposal.expectedGraphDigest
    && getAutomationDefinitionDigest(proposal.automationId) === proposal.expectedDefinitionDigest);
  const changes = (proposal.graphPatch?.ops ?? []).flatMap((op) => {
    if (op.op !== "editNode" || typeof op.nodeId !== "string" || typeof op.config?.prompt !== "string") return [];
    const node = automation?.graph?.nodes.find((item) => item.id === op.nodeId);
    return [{
      label: node?.label || op.nodeId,
      before: current && typeof node?.config?.prompt === "string" ? node.config.prompt : null,
      after: op.config.prompt,
    }];
  });
  if (proposal.schedulePatch) changes.push({
    label: "Schedule",
    before: current && automation?.scheduleSpec
      ? `${describeSchedule(automation.scheduleSpec)} · ${automation.timezone ?? "UTC"}` : null,
    after: `${describeSchedule(proposal.schedulePatch)} · ${proposal.schedulePatch.kind === "cron"
      ? proposal.schedulePatch.tz : automation?.timezone ?? "UTC"}`,
  });
  const applicability = getAutomationStrategyProposalApplicability(proposal);
  const goalRevision = proposal.goalId ? getChatGoalRevision(proposal.goalId) : null;
  const goalRun = proposal.goalId ? getLongRunByGoalId(proposal.goalId) : null;
  return {
    id: proposal.id,
    automationId: proposal.automationId,
    automationName: automation?.name ?? "",
    intent: proposal.intent,
    status: proposal.status,
    conflict: proposal.conflict,
    summary: proposal.strategy?.summary ?? proposal.rationale,
    rationale: proposal.rationale,
    requiresPaymentApproval: proposal.requiresPaymentApproval,
    reviewState: proposal.adjudication.status,
    reviewReason: proposal.adjudication.status === "judged" ? proposal.adjudication.reason : null,
    changes,
    ...applicability,
    goalOwnershipUnverified: proposal.goalOwnershipUnverified,
    originAdoptionRecorded: Boolean(proposal.originAdoption),
    goalAmendmentRequired: applicability.unavailableReason === "goal_amendment_required",
    goalId: proposal.goalId,
    goalRevision: goalRevision?.revision ?? proposal.goalRevision,
    goalRunVersion: goalRun?.version ?? null,
    goalObjective: goalRevision?.objective ?? null,
    goalAcceptanceCriteria: goalRevision?.acceptanceCriteria.map((criterion) => ({ ...criterion })) ?? [],
    goalAmendment: proposal.goalAmendment ? {
      previousRevision: proposal.goalAmendment.previousRevision,
      revision: proposal.goalAmendment.revision,
      sourceMessageId: proposal.goalAmendment.sourceMessageId,
      previousObjective: proposal.goalAmendment.previousObjective,
      objective: proposal.goalAmendment.objective,
      previousAcceptanceCriteria: proposal.goalAmendment.previousAcceptanceCriteria.map((criterion) => ({ ...criterion })),
      acceptanceCriteria: proposal.goalAmendment.acceptanceCriteria.map((criterion) => ({ ...criterion })),
      approvedAt: proposal.goalAmendment.approvedAt,
    } : null,
    executionRuntime,
    judgmentRuntime,
    appliedRevision: proposal.revisionReceipt?.revision ?? null,
    consumedAt: consumptionTime(proposal),
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}
