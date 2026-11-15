import { AgentWorkspaceError } from "./workspace-snapshot";
import { applyAgentWorkspaceProposal, getAgentWorkspaceDiff, issueAgentWorkspaceApprovalReceipt, withWorkspaceLockPatience } from "./workspace-service";
import { deferOwnerApproval } from "./deferred-apply";
import type { AgentWorkspaceDiff, AgentWorkspaceProposal } from "../../shared/agent-workspace";

/**
 * The owner's approval of one reviewed change, after the surface in front of the owner has shown that exact diff: the Manage Agent window
 * (workspace-ipc.ts, which spends its own review grant first) and the paired phone (mobile-bridge/workspace-v2.ts, which carries the hash of
 * the change it showed). One function, so a phone approval and a Desktop approval take the same steps in the same order:
 * receipt for exactly this hash, then apply. A run that holds the agent keeps the approval and applies it when the run ends.
 * No Electron import: the daemon hosts the phone bridge too.
 */
export async function approveReviewedAgentWorkspaceProposal(input: { proposalId: string; reviewedHash: string }): Promise<AgentWorkspaceProposal | (AgentWorkspaceDiff & { applyWhenIdle: true })> {
  // The review grant is spent by the caller, once; only the two lock-taking steps wait (each refused before it ran anything).
  const approvalReceiptId = await withWorkspaceLockPatience(() => issueAgentWorkspaceApprovalReceipt(input.proposalId, input.reviewedHash));
  try { return await withWorkspaceLockPatience(() => applyAgentWorkspaceProposal({ proposalId: input.proposalId, reviewedHash: input.reviewedHash, approvalReceiptId })); }
  catch (error) {
    // A run holds the agent: keep the owner's approval for this exact diff and apply it when the run ends (deferred-apply.ts).
    if (!(error instanceof AgentWorkspaceError) || error.code !== "run_active") throw error;
    deferOwnerApproval(input.proposalId, input.reviewedHash);
    return { ...(await withWorkspaceLockPatience(() => getAgentWorkspaceDiff(input.proposalId))), applyWhenIdle: true as const };
  }
}
