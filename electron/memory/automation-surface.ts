/**










 */
import { getDb } from "../store/db";

// Ledger identity is fixed when the session is created, so a positive answer
// can be cached for the process lifetime. Negatives are re-read.
const knownLedgers = new Set<string>();

export function isAutomationLedgerChat(chatId: string | null | undefined): boolean {
  const id = String(chatId ?? "").trim();
  if (!id) return false;
  if (knownLedgers.has(id)) return true;
  try {
    const row = getDb().prepare(
      "SELECT 1 AS hit FROM automation_sessions WHERE ledger_chat_id = ? LIMIT 1",
    ).get(id) as { hit: number } | undefined;
    if (row) knownLedgers.add(id);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Batch form for recall: which of these chat ids are automation ledgers. */
export function automationLedgerChatIds(chatIds: ReadonlyArray<string | null | undefined>): Set<string> {
  const unique = [...new Set(chatIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  const hits = new Set<string>();
  for (const id of unique) if (isAutomationLedgerChat(id)) hits.add(id);
  return hits;
}
