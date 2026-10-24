/**
 * Deterministic source-surface marker for memory: is this chat an unattended
 * automation's execution ledger?
 *
 * The answer comes from `automation_sessions.ledger_chat_id` (a host-written
 * row), never from the chat title or the memory text. Measured 2026-09-24:
 * hourly runs of one automation wrote their own tactical holds ("hold posting
 * until the peak window", "follow quota met, pause follows") as durable
 * agent_repo procedures with empty evidence; recall then fed them to the next
 * run, which held again. Knowing the surface lets the curator keep a run's own
 * choices in its session and lets recall label them as heuristics.
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
