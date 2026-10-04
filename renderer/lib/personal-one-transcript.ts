import type { ChatHistoryEntry } from "../../shared/types";
import type { SupervisorReplyTurn } from "../../shared/one-supervisor";

/** Pair replies with host-sealed ingress IDs; never match by text or timestamps. */
export function personalOneTranscript(messages:ChatHistoryEntry[],turns:SupervisorReplyTurn[]) {
  const answers=new Set(turns.flatMap(turn=>turn.assistantMessageId ? [turn.assistantMessageId] : []));
  const byId=new Map(messages.map(message=>[message.id,message]));
  return messages.filter(message=>!answers.has(message.id)).map(message=>{
    const turn=turns.find(turn=>turn.userMessageId===message.id);
    return {message,turn,answer:turn?.assistantMessageId ? byId.get(turn.assistantMessageId) : undefined};
  });
}
