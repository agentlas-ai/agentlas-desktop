/*
 * "This turn read what a group room said": those words must not become the personal agent's memory (decision: a group keeps
 * no operating memory of its own and the personal agent is a secretary, not a member; audit N-F12 / item 5).
 *
 * The host - never the model - records the text a room-reading tool returned (team-control-server.ts dispatchOneSupervisorTool, only
 * for tools whose result is room content: see roomContentToolCall). At the end of such a turn the memory step (mcp/client.ts) keeps
 * only the candidates that rest on what the OWNER said in that turn (ownerGroundedEvents below) and drops the rest. Comparing a
 * candidate with the room's text and dropping what "restates" it leaked whenever the model rephrased or translated the room's words
 * (5 of 8 rewrites passed; a memory's `content` is English by contract, so a Korean room mostly passed). Turned around, the
 * miss goes the safe way: a room fact cannot pass, and an owner fact the model worded far from the owner's own words is sometimes
 * not kept (/ direction). A status read without a task, a list of approvals, or `one_chat_send` (a message INTO a room)
 * returns no room content and changes nothing.
 *
 * In memory only: a record lives for the turn's run id, is dropped once the turn has used it, the table is capped (64 turns),
 * each record is capped (32 KB) and ages out (6 h).
 */
import { parseMemoryEvents, type RawMemoryEvent } from "../memory/events";

interface Mark { at: number; text: string }
const marks = new Map<string, Mark>();
const CAP = 64;
const TEXT_CAP = 32 * 1024;
const TTL_MS = 6 * 60 * 60_000;
/** A turn whose run id the binding did not carry is recorded under the chat alone (never silently dropped). */
const ANY_RUN = "*";

const keyOf = (chatId: string, runId: string): string => `${chatId}\u0000${runId}`;

function remember(chatId: string, runId: string, text: string, now: number): void {
  for (const [key, mark] of marks) if (now - mark.at > TTL_MS) marks.delete(key);
  const key = keyOf(chatId, runId);
  const prior = marks.get(key)?.text ?? "";
  marks.set(key, { at: now, text: `${prior}\n${text}`.slice(-TEXT_CAP) });
  while (marks.size > CAP) { const oldest = marks.keys().next().value; if (oldest === undefined) break; marks.delete(oldest); }
}

/** Records the room content a tool returned to this turn. `text` is the tool result as the model saw it. */
export function recordTurnRoomContent(chatId: string | null | undefined, runId: string | null | undefined, text: string, now = Date.now()): void {
  if (!chatId || !text.trim()) return;
  remember(chatId, runId || ANY_RUN, text, now);
}

/** Kept for callers that only know "this turn touched a room": marks the turn without text (its candidates are then judged by an empty record, i.e. kept). */
export function markTurnMemoryExcluded(chatId: string | null | undefined, runId: string | null | undefined, now = Date.now()): void {
  if (!chatId) return;
  remember(chatId, runId || ANY_RUN, " ", now);
}

/** True when the turn recorded room content. Reading consumes nothing here; `forgetTurnMemoryExclusion` ends the record after the turn used it. */
export function turnMemoryExcluded(chatId: string | null | undefined, runId: string | null | undefined): boolean {
  return Boolean(chatId && (marks.has(keyOf(chatId, runId || ANY_RUN)) || marks.has(keyOf(chatId, ANY_RUN))));
}
export function forgetTurnMemoryExclusion(chatId: string | null | undefined, runId: string | null | undefined): void {
  if (!chatId) return;
  marks.delete(keyOf(chatId, runId || ANY_RUN));
  marks.delete(keyOf(chatId, ANY_RUN));
}

const normalize = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const words = (value: string): string[] => normalize(value).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
const WINDOW = 24;

/**
 * Does this memory candidate restate what the room said? A run of 24 characters taken from the room's text, or most of the
 * candidate's own words (at least 4, 60 % or more) found in it. A candidate about something else shares neither.
 */
export function restatesRoomContent(candidate: string, roomText: string): boolean {
  const room = normalize(roomText);
  const text = normalize(candidate);
  if (!room || !text) return false;
  if (text.length <= WINDOW) return text.length >= 8 && room.includes(text);
  for (let at = 0; at + WINDOW <= text.length; at += 6) if (room.includes(text.slice(at, at + WINDOW))) return true;
  const own = [...new Set(words(text))];
  if (own.length < 4) return false;
  const seen = new Set(words(room));
  return own.filter((word) => seen.has(word)).length / own.length >= 0.6;
}

/** The room text recorded for this turn, or null when the turn read no room content. Consumes nothing. */
export function turnRoomContent(chatId: string | null | undefined, runId: string | null | undefined): string | null {
  if (!chatId) return null;
  const parts = [marks.get(keyOf(chatId, runId || ANY_RUN))?.text, marks.get(keyOf(chatId, ANY_RUN))?.text].filter((value): value is string => Boolean(value?.trim()));
  return parts.length ? parts.join("\n") : null;
}

/**
 * Whether a call of the personal agent's tools returns the CONTENT of another conversation (a room's talk, a task's result). A read of
 * state without content (a status list, approvals, a receipt for a sent message) does not.
 */
export function roomContentToolCall(name: string, input: Record<string, unknown>): boolean {
  if (name === "one_supervisor_status") return typeof input.task_id === "string" && input.task_id.trim().length > 0;
  if (name === "one_app_call") {
    const operation = typeof input.operation === "string" ? input.operation : "";
    return operation === "chats.messagesPage" || operation === "chats.recap" || operation === "chats.getContinuitySnapshot";
  }
  return false;
}

/** Superseded by roomContentToolCall (kept as an empty set so an old import compiles; nothing is excluded by tool name alone). */
export const ROOM_CONTENT_SUPERVISOR_TOOLS: ReadonlySet<string> = new Set<string>();

/** A word of the owner's message and a word of a candidate are the same when one begins with the other (Korean particles: "예산" / "예산을"). */
const sameWord = (a: string, b: string): boolean => a === b || (a.length >= 2 && b.length >= 2 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Does this candidate rest on what the owner said in this turn?
 * - most of its words (at least 2, half or more) are the owner's own words in this turn: it says what the owner said; or
 *   - it is about the person (scope `user_identity`, or a `preference`), carries at least one word the owner used that the room's
 *     text does not contain, and does not restate the room's text: a name or a wish the owner brought into the turn.
 * A candidate that rests only on what the room-reading tool returned has neither. Both wordings the model wrote are tried
 * (`content`, and `content_native` in the owner's language). No model call.
 */
export function groundedInOwnerWords(event: Pick<RawMemoryEvent, "content" | "content_native" | "suggested_scope" | "memory_kind">, ownerText: string, roomText: string): boolean {
  const owner = [...new Set(words(ownerText))];
  if (owner.length === 0) return false;
  const room = new Set(words(roomText));
  const personal = event.suggested_scope === "user_identity" || event.memory_kind === "preference";
  for (const wording of [event.content_native, event.content]) {
    const own = [...new Set(words(String(wording ?? "")))];
    if (own.length === 0) continue;
    const shared = own.filter((word) => owner.some((said) => sameWord(said, word)));
    if (shared.length >= 2 && shared.length / own.length >= 0.5) return true;
    if (personal && !restatesRoomContent(String(wording), roomText) && shared.some((word) => ![...room].some((seen) => sameWord(seen, word)))) return true;
  }
  return false;
}

/**
 * The memory step of a turn that read room content: of the model's own candidates (its reply envelope plus the notes it recorded),
 * only those that rest on the owner's words in this turn are kept. `ownerText` is what the owner wrote in this turn ("" when the
 * host wrote the turn's prompt: then nothing the turn learned came from the owner and nothing is kept). Returns the reply text
 * without its envelope and the candidates to keep, to be handed to the ordinary curation as carried events, plus how many were dropped.
 */
export function ownerGroundedEvents(
  replyText: string,
  carried: readonly RawMemoryEvent[],
  roomText: string,
  ownerText: string,
): { replyText: string; events: RawMemoryEvent[]; dropped: number } {
  const parsed = parseMemoryEvents(replyText);
  const all = [...carried, ...parsed.events];
  const events = all.filter((event) => groundedInOwnerWords(event, ownerText, roomText));
  return { replyText: parsed.cleanedText, events, dropped: all.length - events.length };
}
