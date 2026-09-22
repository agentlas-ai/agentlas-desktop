import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { AutomationStrategyReviewResult } from "../shared/automation-strategy-review";
import { automationStrategyProposalView } from "./automation-strategy-view";
import {
  listAutomationStrategyProposals,
  type AutomationStrategyGoalAmendmentInput,
} from "./store/automation-strategy-proposals";
import { reviewAutomationStrategyProposal } from "./automation-strategy-review";

function parseGoalAmendment(value: unknown): AutomationStrategyGoalAmendmentInput | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amendment = value as Record<string, unknown>;
  if (Object.keys(amendment).some((key) => !["text", "objective", "acceptanceCriteria", "expectedGoalRevision", "expectedRunVersion"].includes(key))
    || typeof amendment.text !== "string" || typeof amendment.objective !== "string"
    || !Array.isArray(amendment.acceptanceCriteria)
    || !Number.isSafeInteger(amendment.expectedGoalRevision)
    || !Number.isSafeInteger(amendment.expectedRunVersion)) return null;
  const acceptanceCriteria = amendment.acceptanceCriteria.map((criterion) => {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) return null;
    const item = criterion as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["id", "text"].includes(key))
      || typeof item.id !== "string" || typeof item.text !== "string") return null;
    return { id: item.id, text: item.text };
  });
  if (acceptanceCriteria.some((criterion) => criterion === null)) return null;
  return {
    text: amendment.text,
    objective: amendment.objective,
    acceptanceCriteria: acceptanceCriteria as Array<{ id: string; text: string }>,
    expectedGoalRevision: amendment.expectedGoalRevision as number,
    expectedRunVersion: amendment.expectedRunVersion as number,
  };
}

export function registerAutomationStrategyIpc(deps: {
  ipc: Pick<IpcMain, "handle">;
  assertTrustedSender: (event: IpcMainInvokeEvent) => unknown;
}): void {
  deps.ipc.handle("automations:listStrategyProposals", (event, automationId: unknown, limit?: unknown) => {
    deps.assertTrustedSender(event);
    if (typeof automationId !== "string" || !automationId.trim() || automationId.length > 512) throw new Error("proposal_automation_invalid");
    const count = typeof limit === "number" && Number.isSafeInteger(limit) ? Math.max(1, Math.min(24, limit)) : 12;
    return listAutomationStrategyProposals(automationId, count).map(automationStrategyProposalView);
  });
  deps.ipc.handle("automations:reviewStrategyProposal", async (event, input: unknown): Promise<AutomationStrategyReviewResult> => {
    deps.assertTrustedSender(event);
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "not_applicable" };
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["automationId", "proposalId", "decision", "goalAmendment"].includes(key))
      || typeof value.automationId !== "string" || !value.automationId.trim() || value.automationId.length > 512
      || typeof value.proposalId !== "string" || !value.proposalId.trim() || value.proposalId.length > 512
      || (value.decision !== "apply" && value.decision !== "reject")) return { ok: false, code: "not_applicable" };
    const goalAmendment = parseGoalAmendment(value.goalAmendment);
    if (goalAmendment === null || (value.decision === "reject" && goalAmendment !== undefined)) {
      return { ok: false, code: "not_applicable" };
    }
    try {
      const proposal = await reviewAutomationStrategyProposal({
        automationId: value.automationId, proposalId: value.proposalId, decision: value.decision,
        ...(goalAmendment ? { goalAmendment } : {}),
      });
      return { ok: true, proposal: automationStrategyProposalView(proposal) };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code)
        : error instanceof Error ? error.message : "";
      if (["proposal_apply_stale", "proposal_review_stale", "proposal_transition_conflict", "automation_strategy_graph_stale",
        "automation_strategy_definition_stale", "automation_strategy_revision_stale",
        "automation_strategy_goal_binding_stale", "automation_strategy_goal_revision_stale"].includes(code)) return { ok: false, code: "stale" };
      if (["proposal_missing", "proposal_automation_missing", "proposal_automation_mismatch"].includes(code)) return { ok: false, code: "not_found" };
      if (["proposal_apply_not_allowlisted", "proposal_apply_graph_patch_risky", "proposal_not_approved",
        "proposal_review_unavailable", "proposal_goal_amendment_required", "proposal_goal_amendment_input_invalid",
        "proposal_goal_amendment_criterion_rewrite", "proposal_goal_amendment_attempt_unsettled",
        "proposal_goal_amendment_run_unavailable", "proposal_goal_amendment_run_binding_failed",
        "proposal_goal_amendment_already_applied", "proposal_goal_amendment_contract_change_required",
        "proposal_goal_amendment_invalid", "proposal_goal_ownership_unverified"].includes(code)) {
        return { ok: false, code: "not_applicable" };
      }
      return { ok: false, code: "failed" };
    }
  });
}
