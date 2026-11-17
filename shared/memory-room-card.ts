/**
 * The card "oldest memory deleted" a person sees. Pure and import-free: Main writes the row, the renderer draws it, the phone's projector turns it
 * into one plain line. The words are here and nowhere else, Korean and English; no code, no internal word.
 *   a card row   a 'view' row of the conversation the new line was said in (`memory-room:<id>`): the marker + one small closed JSON value. The model never reads a 'view' row.
 *   the words    title "oldest memory deleted"; the deleted line (one line, shortened); a second line saying WHY and for WHOM: "memory full · applies to all agents" (the shared set), or "... · applies to {agent} only" (that
 *                agent's own place); a line sent late (said while offline) names the time of its message instead of "memory full": "{time} message saved · ...". Several in one action: "{n} memories deleted · " in front.
 */
export const MEMORY_ROOM_MARKER = "<<agentlas-memory-room>>";
export const MEMORY_ROOM_ROW_PREFIX = "memory-room:";

export interface MemoryRoomCardValue { v: 1; scope: "all" | "own"; agent?: string; count: number; line: string; late?: { at: string } }

export function encodeMemoryRoomCard(value: MemoryRoomCardValue): string { return `${MEMORY_ROOM_MARKER}${JSON.stringify(value)}`; }
export function decodeMemoryRoomCard(text: string | null | undefined): MemoryRoomCardValue | null {
  if (typeof text !== "string" || !text.startsWith(MEMORY_ROOM_MARKER)) return null;
  try {
    const v = JSON.parse(text.slice(MEMORY_ROOM_MARKER.length)) as Partial<MemoryRoomCardValue>;
    if (!v || v.v !== 1 || (v.scope !== "all" && v.scope !== "own") || typeof v.line !== "string" || !Number.isSafeInteger(v.count) || (v.count as number) < 1) return null;
    return { v: 1, scope: v.scope, count: v.count as number, line: v.line.slice(0, 400), ...(typeof v.agent === "string" && v.agent ? { agent: v.agent.slice(0, 80) } : {}),
      ...(v.late && typeof v.late.at === "string" && Number.isFinite(Date.parse(v.late.at)) ? { late: { at: v.late.at } } : {}) };
  } catch { return null; }
}

export interface MemoryRoomWords { title: string; line: string; reason: string }
const two = (n: number): string => String(n).padStart(2, "0");
/** The card's three lines in the person's language. `timeOf` turns the late message's ISO time into the clock the person reads (the caller's local time zone; default: the runtime's). */
export function memoryRoomWords(value: MemoryRoomCardValue, ko: boolean, timeOf: (iso: string) => string = (iso) => { const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}`; }): MemoryRoomWords {
  const whom = value.scope === "all" ? (ko ? "모든 에이전트에 적용" : "applies to all agents") : ko ? `${value.agent ?? "이 에이전트"}에만 적용` : `applies to ${value.agent ?? "this agent"} only`;
  const why = value.late ? (ko ? `${timeOf(value.late.at)} 메시지 저장 시` : `when the ${timeOf(value.late.at)} message was saved`) : (ko ? "기억 공간 부족" : "memory full");
  const many = value.count > 1 ? (ko ? `기억 ${value.count}개 삭제 · ` : `${value.count} memories deleted · `) : "";
  return { title: ko ? "가장 오래된 기억 삭제" : "Oldest memory deleted", line: value.line, reason: `${many}${why} · ${whom}` };
}
/** One plain line for a phone that does not know the card (172 and older): the same words, joined. */
export function memoryRoomPlainLine(value: MemoryRoomCardValue, ko: boolean): string { const w = memoryRoomWords(value, ko); return `${w.title} · ${w.line} · ${w.reason}`; }
