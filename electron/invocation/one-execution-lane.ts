/**
 * Which execution contract a start runs under, decided from the CONVERSATION's own origin and never from what the request claims.
 *
 *  - A request that asks for the One contract in a conversation One does not own is refused: the One lane (its memory, tools and
 *    permission rule) is only for a One-owned conversation. Unchanged.
 *  - A request with no One flag that reaches a conversation One owns used to be refused ("A One-owned conversation cannot run through
 *    the Work execution contract"), although nothing the owner did is wrong: a caller picked the wrong lane. It now runs under the One
 *    contract, which can only be narrower for it (Auto gives read for a conversation and write for a task, an explicit read is honored,
 *    and the Work-lane permission is never carried over). Only where the One lane is valid at all: no Work-lane binding (a phone or
 *    company-work binding that is not a One boundary keeps its refusal), no Agent App.
 */
export type OneLaneDecision = { oneMode: boolean } | { refuse: "one_execution_requires_one_conversation" | "one_conversation_requires_one_lane" };

export function decideOneExecutionLane(input: {
  originSurface: string | null | undefined;
  requestedOneMode: boolean;
  /** True when no workspace binding is present, or the binding is a One boundary (Mobile One, Telegram One). */
  oneLaneAllowedForBinding: boolean;
  agentAppMode: boolean;
}): OneLaneDecision {
  const oneConversation = input.originSurface === "one";
  if (input.requestedOneMode && !oneConversation) return { refuse: "one_execution_requires_one_conversation" };
  if (oneConversation && !input.requestedOneMode) {
    if (input.oneLaneAllowedForBinding && !input.agentAppMode) return { oneMode: true };
    return { refuse: "one_conversation_requires_one_lane" };
  }
  return { oneMode: input.requestedOneMode && oneConversation && input.oneLaneAllowedForBinding && !input.agentAppMode };
}

export const ONE_LANE_REFUSAL_MESSAGE: Record<"one_execution_requires_one_conversation" | "one_conversation_requires_one_lane", string> = {
  one_execution_requires_one_conversation: "One execution is valid only for a One-owned conversation",
  one_conversation_requires_one_lane: "A One-owned conversation cannot run through the Work execution contract",
};
