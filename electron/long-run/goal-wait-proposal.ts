import { getDb } from "../store/db";
import { canonicalGoalWaitProposal, getInvocationRunReceipt, getRunEventBySource, recordRunEvent } from "../store/run-events";
import type { ParsedGoalWait } from "./wait-emitter";

export interface GoalWaitProposalSource { sourceInvocationId: string; chatId: string }
const eventId = (source: GoalWaitProposalSource) => `goal-wait-proposed:${source.sourceInvocationId}`;

/** Proposal recovery only. The caller must independently re-read its canonical
 * Goal, source turn, contract, Stop, budget and working scope before acting. */
export function readGoalWaitProposal(source: GoalWaitProposalSource): ParsedGoalWait | null {
  const row = getRunEventBySource(source.sourceInvocationId, eventId(source));
  if (!row || row.kind !== "goal_wait_proposed" || row.runId !== source.sourceInvocationId || row.chatId !== source.chatId) return null;
  return canonicalGoalWaitProposal(row.payload.goalWaitProposal);
}

/** Shared source journal, before terminal publication. It cannot mint a Goal
 * revision, checkpoint, grant, continuation, claim, or wake. */
export function recordGoalWaitProposal(input: GoalWaitProposalSource & { proposal: unknown }): ParsedGoalWait {
  const proposal = canonicalGoalWaitProposal(input.proposal);
  if (!proposal) throw new Error("goal_wait_proposal_invalid");
  return getDb().transaction(() => {
    const receipt = getInvocationRunReceipt(input.sourceInvocationId);
    if (!receipt || receipt.chatId !== input.chatId) throw new Error("goal_wait_source_binding_changed");
    const existing = readGoalWaitProposal(input);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(proposal)) throw new Error("goal_wait_proposal_conflict");
      return existing;
    }
    recordRunEvent({ runId: input.sourceInvocationId, chatId: input.chatId, kind: "goal_wait_proposed",
      sourceEventId: eventId(input), payload: { goalWaitProposal: proposal } });
    const recorded = readGoalWaitProposal(input);
    if (!recorded || JSON.stringify(recorded) !== JSON.stringify(proposal)) throw new Error("goal_wait_proposal_persistence_changed");
    return recorded;
  })();
}
