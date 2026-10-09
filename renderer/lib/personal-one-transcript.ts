import type { ChatHistoryEntry } from "../../shared/types";
import type { SupervisorReplyTurn } from "../../shared/one-supervisor";

/** A saved request is not a live model. Recovery deliberately holds uncertain
 * starts, so only the currently owned reply may animate as answering. */
export function personalOneReplyPresentation(
  turn: SupervisorReplyTurn,
  hasAnswer: boolean,
  activeRunId: string | null | undefined,
): "answering" | "queued" | "held" | "failed" | "cancelled" | null {
  if (hasAnswer || turn.state === "completed") return null;
  if (turn.state === "stored") return "queued";
  if (turn.state === "held") return "held";
  if (turn.state === "failed" || turn.state === "cancelled") return turn.state;
  return activeRunId === turn.runId ? "answering" : "held";
}

/** Pair replies with host-sealed ingress IDs; never match by text or timestamps. */
export function personalOneTranscript(messages:ChatHistoryEntry[],turns:SupervisorReplyTurn[]) {
  const answers=new Set(turns.flatMap(turn=>turn.assistantMessageId ? [turn.assistantMessageId] : []));
  const byId=new Map(messages.map(message=>[message.id,message]));
  const byUserId=new Map<string,SupervisorReplyTurn>();
  for(const turn of turns)if(!byUserId.has(turn.userMessageId))byUserId.set(turn.userMessageId,turn);
  return messages.filter(message=>!answers.has(message.id)).map(message=>{
    const turn=byUserId.get(message.id);
    return {message,turn,answer:turn?.assistantMessageId ? byId.get(turn.assistantMessageId) : undefined};
  });
}
