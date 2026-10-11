/**
 * A user message that is already in the transcript when its run finally starts.
 *
 * The owner's message is saved the moment it is accepted, even if the chat is busy and the run starts seconds or
 * minutes later (the message waits in the per-chat send queue). The run's own start path still appends "the user's
 * prompt" to the transcript like it always did. While the queue is starting a message, that one append is answered with
 * the row that is already there instead of inserting a second bubble.
 *
 * The claim is scoped to one start attempt and one chat, matches the exact prompt text, and is consumed once.
 */
export interface PreparedUserRowClaim<Row> { chatId: string; text: string; row: Row; consumed: boolean }

const claims: PreparedUserRowClaim<unknown>[] = [];

export async function withPreparedUserRow<Row, T>(chatId: string, text: string, row: Row, run: () => Promise<T>): Promise<T> {
  const claim: PreparedUserRowClaim<unknown> = { chatId, text, row, consumed: false };
  claims.push(claim);
  try { return await run(); }
  finally {
    const index = claims.indexOf(claim);
    if (index >= 0) claims.splice(index, 1);
  }
}

/** Consumes the claim for this chat and exact text, if one is active. */
export function takePreparedUserRow<Row>(chatId: string, text: string): Row | null {
  const claim = claims.find((item) => !item.consumed && item.chatId === chatId && item.text === text);
  if (!claim) return null;
  claim.consumed = true;
  return claim.row as Row;
}

export function preparedUserRowClaimCount(): number { return claims.length; }
