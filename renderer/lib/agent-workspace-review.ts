import type { AgentWorkspaceDiff, AgentWorkspaceProposal } from "@shared/agent-workspace";

/**
 * The owner's Approve on a reviewed agent change.
 *
 * Main lets a review pass live five minutes and only for the window that showed the diff. An owner who reads the diff, leaves
 * for a meeting and comes back used to meet "review this change again" with nothing wrong with the change. When the pass is
 * what ran out, ask Main for the same diff again: if it is the same bytes the owner read (same reviewed hash) the press
 * goes through with the new pass; if the change moved meanwhile, the new diff is shown instead of being applied unseen.
 */
export interface ReviewedApprovalApi {
  getDiff(proposalId: string): Promise<AgentWorkspaceDiff>;
  approveAndApply(input: { proposalId: string; reviewedHash: string; reviewToken: string }): Promise<AgentWorkspaceProposal>;
}
export type ReviewedApproval = { kind: "applied"; proposal: AgentWorkspaceProposal } | { kind: "changed"; review: AgentWorkspaceDiff };

const reviewPassEnded = (error: unknown): boolean => /\[review_required\]/.test(error instanceof Error ? error.message : String(error ?? ""));

export async function approveReviewedChange(api: ReviewedApprovalApi, review: AgentWorkspaceDiff): Promise<ReviewedApproval> {
  const attempt = (reviewToken: string) => api.approveAndApply({ proposalId: review.id, reviewedHash: review.reviewedHash, reviewToken });
  try { return { kind: "applied", proposal: await attempt(review.reviewToken ?? "") }; }
  catch (error) {
    if (!reviewPassEnded(error)) throw error;
    const again = await api.getDiff(review.id);
    if (again.status === "applied") return { kind: "applied", proposal: again };
    if (again.status !== "review_ready" || !again.reviewToken || again.reviewedHash !== review.reviewedHash) return { kind: "changed", review: again };
    return { kind: "applied", proposal: await attempt(again.reviewToken) };
  }
}
