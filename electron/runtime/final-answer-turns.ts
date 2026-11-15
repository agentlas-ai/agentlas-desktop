/**
 * Where the answer of a run starts inside its saved text (a phone alarm opened onto a message that read like a
 * mid-run report, because the saved final opens with the sentences the model wrote before its tool calls).
 *
 * The saved text is NOT shortened (the desktop timeline anchors tool rows to the live text, `anchorTextLen`, so a shorter saved
 * text would put the tool group in the middle of the first line). The answer's start is a position inside it instead, and only the
 * phone and the notification body read it (mobile-bridge: projector.ts, authority.ts).
 *
 * The start is one number in UTF-16 code units (a JS string index, the same unit as the renderer's `anchorTextLen`):
 *  - Codex states a phase per agentMessage (commentary | partial_answer | final_answer): the first message marked as the answer.
 *  - every other runner: the text accumulated when the LAST tool call began; what is written after the last tool call is the answer.
 * A position measured on one copy of the text is found again in another copy (the displayed text, the saved text, a phone event)
 * by a hash of the 32 characters before it, so a marker line removed or a prefix added on the way never points into a word.
 * Whatever cannot be proven falls back to 0, which means the whole text is the answer. Pure; nothing here touches storage.
 */

/** A start position and the hash of the text just before it (not the text itself: the ledger keeps no chat text). */
export interface AnswerMark { at: number; tailHash: number }

const TAIL_WINDOW = 32;
/** How far from the expected position a copy of the text may have shifted (leading whitespace, a prefix, a stripped line). */
const LOCATE_RADIUS = 512;

function fnv1a(text: string, from: number, to: number): number {
  let hash = 0x811c9dc5;
  for (let index = from; index < to; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The hash of the (up to 32) characters before `at`: what a copy of the text must show at the position to prove it. */
export function answerTailHash(text: string, at: number): number {
  return fnv1a(text, Math.max(0, at - TAIL_WINDOW), Math.min(at, text.length));
}

/** The mark of position `at` in `text`; null when there is nothing before it to prove the position by (the whole text is the answer). */
export function answerMarkAt(text: string, at: number): AnswerMark | null {
  if (!Number.isInteger(at) || at <= 0 || at > text.length) return null;
  const from = Math.max(0, at - TAIL_WINDOW);
  if (!text.slice(from, at).trim()) return null;
  return { at, tailHash: fnv1a(text, from, at) };
}

/**
 * The index in `text` where the answer starts, or 0 (the whole text). `near` is where the mark was measured, shifted by whatever
 * the caller knows was added before it. The position must carry the same 32 characters before it; it never lands inside a
 * surrogate pair, skips the whitespace after the tool call, and is 0 if nothing but whitespace would be left.
 */
export function locateAnswerStart(text: string, mark: AnswerMark | null | undefined, near?: number): number {
  if (!mark || !Number.isInteger(mark.at) || mark.at <= 0 || !Number.isFinite(mark.tailHash)) return 0;
  const expected = Number.isInteger(near) && (near as number) > 0 ? (near as number) : mark.at;
  const windowLength = Math.min(mark.at, TAIL_WINDOW);
  let found = -1;
  for (let distance = 0; distance <= LOCATE_RADIUS && found < 0; distance += 1) {
    for (const position of distance === 0 ? [expected] : [expected + distance, expected - distance]) {
      // A mark made near the start of a text has a shorter window (its length is part of the mark: min(at, 32)).
      const from = position - windowLength;
      if (from < 0 || position > text.length) continue;
      if (fnv1a(text, from, position) === mark.tailHash) { found = position; break; }
    }
  }
  if (found <= 0) return 0;
  // A mark cut between the two halves of a surrogate pair (an emoji) moves back: the whole pair belongs to the answer.
  const high = text.charCodeAt(found - 1);
  const low = text.charCodeAt(found);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) found -= 1;
  while (found < text.length && /\s/.test(text[found])) found += 1;
  return found > 0 && found < text.length && text.slice(found).trim() ? found : 0;
}

/** Codex's normalised agentMessage phase: `_`/`-` removed, lowercased ("final_answer" -> "finalanswer"). */
export function normalizeMessagePhase(phase: unknown): string | null {
  return typeof phase === "string" && phase ? phase.replace(/[_-]/g, "").toLowerCase() : null;
}

export interface AgentMessageCounts { commentary: number; partialAnswer: number; finalAnswer: number; unmarked: number }

/**
 * Non-empty agentMessages of one turn by stated phase. A phase this host does not know counts as unmarked (it is joined as
 * before). Diagnostics only: run_events `invoke_result` (agentMessageCommentary/PartialAnswer/FinalAnswer/Unmarked), read by
 * whoever audits a reported answer, kept and deleted with that row by the run-event retention.
 */
export function countAgentMessages(messages: ReadonlyArray<{ text: string; phase: string | null | undefined }>): AgentMessageCounts {
  const counts: AgentMessageCounts = { commentary: 0, partialAnswer: 0, finalAnswer: 0, unmarked: 0 };
  for (const message of messages) {
    if (!message.text) continue;
    if (message.phase === "commentary") counts.commentary += 1;
    else if (message.phase === "partialanswer") counts.partialAnswer += 1;
    else if (message.phase === "finalanswer") counts.finalAnswer += 1;
    else counts.unmarked += 1;
  }
  return counts;
}

/** The message is one the model marked as (part of) its answer. */
export function isMarkedAnswerPhase(phase: string | null | undefined): boolean {
  return phase === "finalanswer" || phase === "partialanswer";
}

/**
 * Codex: where the answer starts in the turn's joined text (`pieces` in order; `joined` = no "\n" before it). The FIRST message
 * marked as the answer starts it (a commentary after that stays inside the answer). A turn with commentary and nothing else says
 * "no answer was marked": the whole text, stated as a mark at 0 so the generic last-tool rule does not replace it. A turn whose
 * messages carry no phase returns undefined: the runner knows nothing and the last-tool rule decides.
 */
export function codexAnswerMark(pieces: ReadonlyArray<{ text: string; phase: string | null | undefined; joined: boolean }>): AnswerMark | undefined {
  let joinedText = "";
  let start = -1;
  let commentary = 0;
  let other = 0;
  for (const piece of pieces) {
    if (!piece.text) continue;
    const separator = joinedText && !piece.joined ? "\n" : "";
    if (start < 0 && isMarkedAnswerPhase(piece.phase)) start = joinedText.length + separator.length;
    if (piece.phase === "commentary") commentary += 1;
    else if (!isMarkedAnswerPhase(piece.phase)) other += 1;
    joinedText += separator + piece.text;
  }
  // The runner trims the joined text; positions are counted on the trimmed copy.
  const lead = joinedText.length - joinedText.trimStart().length;
  if (start >= 0) return answerMarkAt(joinedText.trimStart(), Math.max(0, start - lead)) ?? { at: 0, tailHash: 0 };
  return commentary > 0 && other === 0 ? { at: 0, tailHash: 0 } : undefined;
}

/**
 * Every runner except Codex: the answer is what is written after the LAST tool call. The host sees both streams in one place (the
 * run's event sink), so it keeps the live text at the moment each tool began, as the hash of its last 32 characters (never the text).
 * A tool's start moves the boundary; its later result does not (text written while it ran is not a new boundary).
 * `ids` is bounded; a text that restarted (a retry, a continuation) is caught when the mark is proven against the saved text.
 */
export function createAnswerTracker(): { onPartial(sinkText: string): void; onTool(id?: string): void; mark(): AnswerMark | null } {
  let lastPartial = "";
  let mark: AnswerMark | null = null;
  const started = new Set<string>();
  return {
    onPartial(sinkText) { lastPartial = sinkText; },
    onTool(id) {
      if (id) {
        if (started.has(id)) return;
        if (started.size >= 4096) started.clear();
        started.add(id);
      }
      mark = answerMarkAt(lastPartial, lastPartial.trimEnd().length);
    },
    mark: () => mark,
  };
}
