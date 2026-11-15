// The turn record (Agentlas 2.0 K3'): the receipt that a turn happened - a memory_tickets row and its memory_episodes row - and nothing else.
// Until K3' every turn record was also queued for a model call (the automatic curator's job table); now the record is read once, with the turns around it, by the resting-time gathering (gathering.ts).
// The queue's old rows are retired here (retireCurationQueue), so a job an earlier build left behind neither runs nor sits as a promise nobody keeps.
import { beginMemoryTicket, completeMemoryTicket, type MemoryTicketReport } from "./tickets";
import type { CurationContext } from "./curator";
import { getMemoryDb } from "./database";
import { currentMemorySourceCustody, withMemorySourceCustody } from "./source-custody";

const EMPTY: MemoryTicketReport = { written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 };

/** A canonical Ticket/Episode adapter, not a second durable memory admission: writes the turn record (idempotent for a turn) inside the caller's source custody. No job is queued, no model is called. */
export function recordTurnRecord(input: {
  context: CurationContext;
  turnSummary?: string | null;
  allowDurable?: boolean;
  report?: MemoryTicketReport;
}): { ticketId: string; created: boolean } {
  return withMemorySourceCustody(currentMemorySourceCustody(), () => {
    const ticket = beginMemoryTicket({ context: input.context, emitterStatus: input.allowDurable === false ? "read_only" : "valid", candidateCount: 0, turnSummary: input.turnSummary });
    if (ticket.created) completeMemoryTicket(ticket.ticketId, input.report ?? EMPTY, input.allowDurable === false ? "read_only" : "policy", {
      readOnly: input.allowDurable === false,
      outcome: input.allowDurable === false ? "read_only" : "no_candidates",
    });
    return { ticketId: ticket.ticketId, created: ticket.created };
  });
}

/**
 * Removes what the retired per-turn curation queue left in this store: its jobs (queued, retrying, deferred or half done) and its result cache. Their turns' records are untouched. One look for the table; no model, no
 * timer; safe from two processes at once (a DELETE of rows already gone is nothing). Returns the number of jobs removed (0 on a store that never had the queue).
 */
export function retireCurationQueue(): number {
  try {
    const db = getMemoryDb();
    const has = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    if (!has("memory_curation_jobs")) return 0;
    const removed = db.prepare("DELETE FROM memory_curation_jobs").run().changes;
    if (has("memory_curation_batches")) db.prepare("DELETE FROM memory_curation_batches").run();
    if (removed > 0) console.log(`[memory] retired ${removed} per-turn curation job(s) left by an earlier build`);
    return removed;
  } catch { return 0; /* a busy or unreadable store keeps them for the next start */ }
}
