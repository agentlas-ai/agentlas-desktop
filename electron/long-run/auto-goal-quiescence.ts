import { isAutoMessageGoalId } from "../../shared/auto-goal";

/**
 * Whether a Goal the host admitted from a plain sentence is finished because its invocation ended on the idle yield (the host drove the
 * Goal again and the pass did nothing: client.ts goal_idle_pass_yield). Desktop trial "remember this" was admitted as a
 * multi-turn Goal; the model answered in one reply and never claimed completion, the terminal verification stayed inconclusive on a
 * request that leaves nothing to check, and the Goal then looped, rested on a 5-hour timer and drove 3 main answers into every later
 * ordinary question of that conversation.
 *
 * The close is the one a model-declared completion already gets (service.ts closeGoalOnModelJudgment): unless the verifier returns a
 * positive "failed" verdict, inconclusive or unavailable verification no longer holds the Goal open. Only a finite Goal the host made
 * from a message (auto-message id) qualifies: an explicit Goal the owner started, an ongoing mandate and a Goal that is still driven by
 * its own plan never close here. No model words are read.
 */
export function automaticGoalClosesWhenIdle(input: {
  goalId: string | null | undefined;
  idleYield: boolean;
  lifecycle: string | null | undefined;
}): boolean {
  return input.idleYield && input.lifecycle === "finite" && isAutoMessageGoalId(input.goalId);
}
