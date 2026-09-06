/**
 * Transcript hydration can race a terminal event. Keep a settled local answer
 * only when Main supplied the exact durable chat-message id that owns it.
 * Copy, role, run id, and timestamps are deliberately not identities.
 */
export type DurableChatCatchupMessage = {
  id: string;
  durableMessageId?: string;
};

function identities(message: DurableChatCatchupMessage): string[] {
  return [
    `message:${message.id}`,
    ...(message.durableMessageId ? [`message:${message.durableMessageId}`] : []),
  ];
}

function isPendingSettledAnswer(message: DurableChatCatchupMessage): boolean {
  return message.id.startsWith("one-answer:") && Boolean(message.durableMessageId);
}

export function mergeDurableChatCatchup<T extends DurableChatCatchupMessage>(
  current: readonly T[],
  durable: readonly T[],
): T[] {
  if (durable.length === 0) return [...current];
  const durableIdentities = new Set(durable.flatMap(identities));
  const pending = current.filter((message) => (
    isPendingSettledAnswer(message)
    && !identities(message).some((identity) => durableIdentities.has(identity))
  ));
  return pending.length ? [...durable, ...pending] : [...durable];
}
