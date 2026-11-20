/**
 * A user message that is already in the transcript when its run finally starts.
 *
 * The owner's message is saved the moment it is accepted, even if the chat is busy and the run starts seconds or
 * minutes later (the message waits in the per-chat send queue). The run's own start path still appends "the user's
 * prompt" to the transcript like it always did. While the queue is starting a message, that one append is answered with
 * the row that is already there instead of inserting a second bubble.
 *
 * The claim is scoped to one start attempt and one chat and is consumed once. It matches by the composer's intent id when both the claim
 * and the append carry one (the id, not the text, says it is the same message:); otherwise by the exact prompt text, as before.
 */
export interface PreparedUserRowClaim<Row> { chatId: string; text: string; row: Row; consumed: boolean; clientIntentId: string | null }

const claims: PreparedUserRowClaim<unknown>[] = [];

export async function withPreparedUserRow<Row, T>(chatId: string, text: string, row: Row, run: () => Promise<T>, clientIntentId: string | null = null): Promise<T> {
  const claim: PreparedUserRowClaim<unknown> = { chatId, text, row, consumed: false, clientIntentId };
  claims.push(claim);
  try { return await run(); }
  finally {
    const index = claims.indexOf(claim);
    if (index >= 0) claims.splice(index, 1);
  }
}

/** Consumes the claim for this chat, if one is active: the same intent id when both sides have one, else the exact text. */
export function takePreparedUserRow<Row>(chatId: string, text: string, clientIntentId: string | null = null): Row | null {
  const claim = claims.find((item) => !item.consumed && item.chatId === chatId
    && (item.clientIntentId && clientIntentId ? item.clientIntentId === clientIntentId : item.text === text));
  if (!claim) return null;
  claim.consumed = true;
  return claim.row as Row;
}

export function preparedUserRowClaimCount(): number { return claims.length; }
