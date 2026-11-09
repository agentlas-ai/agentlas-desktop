import { agentWorkspaceProposalHeldByRun, applyAgentWorkspaceProposal, issueAgentWorkspaceApprovalReceipt, noteDroppedAgentWorkspaceApproval, onAgentWorkspaceRunLeaseReleased } from "./workspace-service";
import { AgentWorkspaceError } from "./workspace-snapshot";
import { currentUiLocale } from "../ui-locale";

/**
 * The owner approved a reviewed change while a run held the agent's files. A long run (a video render) can hold them for hours,
 * and "finish the run, then press Approve again" asks the owner to remember. Keep the approval and apply it the moment the run is
 * over. The approval is for exactly the reviewed hash: if the change moved, was applied, rejected or the files changed under it,
 * the approval is dropped and nothing is applied that the owner did not read.
 *
 * While a run holds the files a pass does nothing: no approval receipt is written and no folder is hashed (regression review C6,
 * a new never-consumed receipt file and two full tree hashes every 10 s for the length of the run). The pass runs when the run
 * gives the files back (onAgentWorkspaceRunLeaseReleased); a slow check remains for a run that ended without releasing (a dead holder,
 * another process). A dropped approval is told to the owner on the change itself, in one plain line, because the screen said it was kept.
 */
const waiting = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | undefined;
let stopListening: (() => void) | undefined;
const RETRY_MS = 30_000;

export function deferOwnerApproval(proposalId: string, reviewedHash: string): void {
  waiting.set(proposalId, reviewedHash);
  if (!timer) { timer = setInterval(() => { applyDeferredApprovals(); }, RETRY_MS); timer.unref?.(); }
  if (!stopListening) stopListening = onAgentWorkspaceRunLeaseReleased(() => { applyDeferredApprovals(); });
}
export function hasDeferredApproval(proposalId: string): boolean { return waiting.has(proposalId); }

function droppedApprovalLine(): string {
  return currentUiLocale() === "ko"
    ? "승인을 적용하지 못했어요. 에이전트가 실행되는 동안 파일이 바뀌었어요. 바뀐 내용을 다시 확인하고 승인해 주세요."
    : "Your approval was not applied: the agent's files changed while it ran. Review the change again and approve it.";
}

/** One pass over the waiting approvals. Returns the proposals applied now. */
export function applyDeferredApprovals(): string[] {
  const applied: string[] = [];
  for (const [proposalId, reviewedHash] of [...waiting]) {
    // Still running: nothing to issue and nothing to hash; the release of the run (or the slow check) comes back here.
    if (agentWorkspaceProposalHeldByRun(proposalId)) continue;
    try {
      const approvalReceiptId = issueAgentWorkspaceApprovalReceipt(proposalId, reviewedHash);
      const result = applyAgentWorkspaceProposal({ proposalId, reviewedHash, approvalReceiptId });
      waiting.delete(proposalId);
      if (result.status === "applied") applied.push(proposalId);
    } catch (error) {
      if (error instanceof AgentWorkspaceError && error.code === "run_active") continue; // a run began between the check and the apply: try again
      waiting.delete(proposalId); // moved, applied elsewhere, rejected, or the files changed: the owner reads it again
      console.warn("[agent-workspace] a waiting approval was dropped", { proposalId, code: error instanceof AgentWorkspaceError ? error.code : "failed" });
      noteDroppedAgentWorkspaceApproval(proposalId, droppedApprovalLine());
    }
  }
  if (!waiting.size) {
    if (timer) { clearInterval(timer); timer = undefined; }
    if (stopListening) { stopListening(); stopListening = undefined; }
  }
  return applied;
}
