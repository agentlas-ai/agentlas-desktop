// What the memory_ticket tool tells the MODEL about a refused ticket (; decision, desktop only, no change of what is stored or refused).
//
// The receiver's answer is a machine word (`why: "not_said"`); the model handed it to the person ("...on the grounds of `not_said`") and told the person the line was remembered while it was refused. Two host facts are added to the
// answer the tool returns, after the write path has decided, so nothing here can change what is stored:
//   - `say`: one fixed English sentence per refusal word, saying plainly that the line is NOT in memory (the model words it in the person's language);
//   - `retry: false`: the same ticket (a remove: the same lines; anything else: the same action, scope, lines and wording) was already refused for the same reason earlier in this turn. A turn that wrote the same refused remove three times
//     cost about 400,000 input tokens and 53 seconds; the second answer is closed instead.
// `not_stored` counts the tickets of the call that are not in memory. Nothing reads a word of the owner's request; the memo is process-local, bounded (16 per turn) and dropped with the turn (turn-tools/memory-facts.ts).
import { noteTurnRefused, turnRefusedBefore } from "../turn-tools/memory-facts";
import type { TicketAnswer } from "./ticket-receiver";

export interface WordedAnswer extends TicketAnswer { say?: string; retry?: false }
export interface WordedTicketResult { tickets: WordedAnswer[]; unreadable?: string; not_stored?: number }

const REFUSAL_SAY: Record<string, string> = {
  secret_like: "Not stored: it looks like a secret. Do not say it is remembered.",
  not_said: "Not stored: it was not the person's own words in this turn. Do not say it is remembered.",
  not_here: "Not stored: this conversation cannot keep that line. Do not say it is remembered.",
  needs_approval: "Not stored: a permission is asked with an approval card, not with memory.",
};
export const REFUSAL_REPEAT = "Not stored, and refused the same way earlier in this turn: do not write it again; tell the person plainly that it was not stored.";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const norm = (value: unknown): string => (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().toLowerCase();

/** The identity of each ticket of a call, for the same-refusal check. Null for an entry that has no ticket shape; an empty list when the arguments are not the new shape. */
export function ticketSignatures(args: unknown): Array<string | null> {
  if (!isObject(args) || !Array.isArray(args.tickets)) return [];
  return args.tickets.map((ticket) => {
    if (!isObject(ticket)) return null;
    const action = norm(ticket.action) || "add";
    const targets = (Array.isArray(ticket.targets) ? ticket.targets : []).map(norm).filter(Boolean).sort().join(",");
    return action === "remove" ? `remove|${targets}` : [action, norm(ticket.scope), targets, norm(ticket.en) || norm(ticket.text) || norm(ticket.quote)].join("|");
  });
}

/** The tool's answer as the model reads it. `key` is the turn's `chatId|runId`; `dryRun` leaves the memo alone. */
export function wordTicketResult(key: string, args: unknown, result: { tickets: TicketAnswer[]; unreadable?: string }, dryRun = false): WordedTicketResult {
  const signatures = ticketSignatures(args);
  const tickets = result.tickets.map((answer, index): WordedAnswer => {
    if (answer.status !== "refused") return answer;
    const signature = signatures[index] ?? null;
    if (signature && !dryRun) {
      if (turnRefusedBefore(key, signature, answer.why)) return { ...answer, say: REFUSAL_REPEAT, retry: false };
      noteTurnRefused(key, signature, answer.why);
    }
    const say = REFUSAL_SAY[answer.why ?? ""];
    return say ? { ...answer, say } : answer;
  });
  const notStored = tickets.filter((answer) => answer.status !== "ok").length;
  return { tickets, ...(notStored > 0 ? { not_stored: notStored } : {}), ...(result.unreadable ? { unreadable: result.unreadable } : {}) };
}
