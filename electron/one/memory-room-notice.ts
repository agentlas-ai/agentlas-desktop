/*
 * The card "oldest memory deleted": when the set of memory is full and a new line is said, the oldest FACT is let go - this card tells the person once, in the conversation the new line was said in.
 * It is a display row of the chat (`row_scope='view'`, store/chats.ts `upsertViewNoticeRow`): written by the HOST, never by a model, never part of a model's input, and no other conversation shows it.
 * The row's text is a small JSON the chat screen reads (`MemoryRoomCard`); the words of the card are drawn by the screen in the person's language, so nothing here is a sentence.
 *   scope "all"   the shared set was full: the line was let go on every agent ("모든 에이전트에 적용")   scope "own"  this agent's own place was full ("{agent}에만 적용"; `agent` = its name)
 * One card per person's action: the lines let go in the same minute of the same conversation are ONE card (the count grows, the oldest line stays the one shown; "all" wins over "own", the wider side).
 * A line said while offline and sent later (`late`): the card sits at the end of the conversation and its second line names the time of that message.
 * Read by: the chat screen (renderer/components/MemoryRoomCard). Deleted when: the person closes it (the row is removed; the same row is never written again - its id is the minute's) or the conversation's messages go.
 */
import { createHash } from "node:crypto";
import { MEMORY_ROOM_ROW_PREFIX, decodeMemoryRoomCard, encodeMemoryRoomCard, type MemoryRoomCardValue } from "../../shared/memory-room-card";

export { MEMORY_ROOM_ROW_PREFIX };

export type { MemoryRoomCardValue as MemoryRoomCard };
const MINUTE = 60_000;
/** A line sent more than this long after it was said is a late one: its card names the message's time (a person is not told "just now" of something said an hour ago). */
const LATE_AFTER_MS = 2 * MINUTE;
const shorten = (text: string): string => { const one = text.replace(/\s+/g, " ").trim(); return Array.from(one).length > 120 ? `${Array.from(one).slice(0, 119).join("")}…` : one; };

/** Merging two cards of one action: the count adds, the wider scope wins, the line shown is the first one's (the oldest let go is reported first by the server). */
export function mergeMemoryRoomCards(a: MemoryRoomCardValue, b: MemoryRoomCardValue): MemoryRoomCardValue {
  const scope = a.scope === "all" || b.scope === "all" ? "all" : "own";
  return { v: 1, scope, count: a.count + b.count, line: a.line, ...(scope === "own" && (a.agent ?? b.agent) ? { agent: a.agent ?? b.agent } : {}), ...(a.late ? { late: a.late } : b.late ? { late: b.late } : {}) };
}

/** The conversation a memory line was said in (its `chat_id`), and when it was made. */
function lineOrigin(lineId: string): { chatId: string; createdAt: string } | null {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const row = (require("../memory/database") as typeof import("../memory/database")).getMemoryDb().prepare("SELECT chat_id, created_at FROM memory_entries WHERE id=?").get(lineId) as { chat_id: string | null; created_at: string } | undefined;
  return row && row.chat_id ? { chatId: row.chat_id, createdAt: row.created_at } : null;
}

/** Writes (or grows) the card for a line that was let go. Returns what happened; never throws. `lineId` is the NEW line that caused it (its conversation gets the card). */
export function recordMemoryRoomNotice(input: { lineId: string; scope: "all" | "own"; count: number; text: string; saidAt: string | null; agentName?: string; nowMs?: number }): "written" | "updated" | "same" | "refused" {
  try {
    const origin = lineOrigin(input.lineId);
    if (!origin) return "refused";   // a line with no conversation (an import, a line taken from another place): no card, nothing is claimed
    const now = input.nowMs ?? Date.now();
    const made = Date.parse(origin.createdAt);
    const late = Number.isFinite(made) && now - made > LATE_AFTER_MS ? { at: new Date(made).toISOString() } : undefined;
    const card: MemoryRoomCardValue = { v: 1, scope: input.scope, count: Math.max(1, input.count), line: shorten(input.text), ...(input.scope === "own" && input.agentName ? { agent: input.agentName } : {}), ...(late ? { late } : {}) };
    const chats = require("../store/chats") as typeof import("../store/chats");
    const db = (require("../store/db") as typeof import("../store/db")).getDb();
    const id = `${MEMORY_ROOM_ROW_PREFIX}${createHash("sha256").update(`${origin.chatId}:${Math.floor(now / MINUTE)}`).digest("hex").slice(0, 20)}`;
    const existing = db.prepare("SELECT text FROM chat_messages WHERE id = ? AND role = 'system' AND row_scope = 'view'").get(id) as { text: string } | undefined;
    if (!existing) return chats.recordViewNoticeRow({ id, chatId: origin.chatId, text: encodeMemoryRoomCard(card), createdAt: new Date(now).toISOString() }) === "written" ? "written" : "refused";
    // a second card of the same action in the same minute: the same row grows (the count adds, the wider reach wins)
    const prev = decodeMemoryRoomCard(existing.text);
    const text = encodeMemoryRoomCard(prev ? mergeMemoryRoomCards(prev, card) : card);
    if (text === existing.text) return "same";
    const changed = db.prepare("UPDATE chat_messages SET text = ? WHERE id = ? AND role = 'system' AND row_scope = 'view'").run(text, id).changes;
    if (changed) (require("../store/change-bus") as typeof import("../store/change-bus")).emitDesktopStoreChange({ entity: "chat", id: origin.chatId });
    return changed ? "updated" : "refused";
  } catch { return "refused"; }
}
