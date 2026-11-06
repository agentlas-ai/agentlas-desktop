// Chat cadence: how a short conversational answer is cut into message bubbles and released one by one.
//
// Display layer only. Nothing here touches a run, a transcript, a stored message or the bridge wire: bubbles are
// derived from the answer text every time, so the desktop, the phone and a reopened history show the same cut.
// Mobile mirrors this file in Dart (mobile/app/lib/core/chat/chat_cadence.dart). Both sides are locked to the shared
// golden fixtures mobile/contracts/chat-cadence.fixtures.json; change behavior there first, then in both files.
//
// Rules that keep the two ports byte-identical: no imports, ASCII-only regex classes, integer millisecond math,
// lengths are UTF-16 code units, and trimming uses the fixed character set in `trimCadence`.
//
// Live answers go through `CadenceSession`. A finished conversation (history, reconnect) is drawn with
// `displayBubbles` at once, with no pacing. `nowMs` must be a monotonic clock (performance.now, Stopwatch).

export interface ChatCadenceConfig {
  readonly schema: "agentlas.chat-cadence.v1";
  readonly gap: { readonly baseMs: number; readonly charsPerSec: number; readonly minMs: number; readonly maxMs: number };
  readonly first: { readonly minAfterSendMs: number };
  readonly budget: { readonly maxAddedDelayMs: number; readonly minGapMsWhenCompressed: number };
  readonly gate: {
    readonly maxTotalChars: number;
    readonly maxBubbles: number;
    readonly mergeUnderChars: number;
    readonly mergeUpToChars: number;
    readonly splitOverChars: number;
  };
  readonly reducedMotion: { readonly gapMs: number };
}

export const CHAT_CADENCE: ChatCadenceConfig = {
  schema: "agentlas.chat-cadence.v1",
  gap: { baseMs: 500, charsPerSec: 300, minMs: 500, maxMs: 2000 },
  first: { minAfterSendMs: 600 },
  budget: { maxAddedDelayMs: 3000, minGapMsWhenCompressed: 150 },
  gate: { maxTotalChars: 600, maxBubbles: 5, mergeUnderChars: 30, mergeUpToChars: 90, splitOverChars: 140 },
  reducedMotion: { gapMs: 150 },
};

// ---- text helpers ---------------------------------------------------------------------------------------------

const TRIM_SET = " \t\n\r\u00a0\u3000\ufeff";
const TERMINATORS = ".!?\u2026\u3002\uff01\uff1f";
const FULLWIDTH_TERMINATORS = "\u3002\uff01\uff1f";
const CLOSERS = "\"'\u201d\u2019\u300d\u300f)\uff09]";
const OPENERS = "([\"'\u201c\u2018\u300c\u300e";
const ABBREVIATIONS = ["mr", "mrs", "ms", "dr", "prof", "vs", "etc", "fig", "approx", "inc", "ltd", "jr", "sr"];
// A line this long that does not end a sentence is treated as hard-wrapped text, not as a deliberate line break.
const HARD_WRAP_MIN_CHARS = 60;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_LINE = /^ {0,3}#{1,6}[ \t]/;
const LIST_LINE = /^ {0,3}([-*+]|\d{1,3}[.)])[ \t]+\S/;
const TABLE_LINE = /^ {0,3}\|.*\|[ \t]*$/;
const QUOTE_LINE = /^ {0,3}>/;
const RULE_LINE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const INDENT_LINE = /^( {4,}|\t)/;
const BLANK_LINE = /^[ \t]*$/;

/** Trim only the characters in a fixed set, so Dart and JavaScript cannot disagree about what is whitespace. */
export function trimCadence(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && TRIM_SET.indexOf(value[start]) >= 0) start++;
  while (end > start && TRIM_SET.indexOf(value[end - 1]) >= 0) end--;
  return value.slice(start, end);
}

function trimEndCadence(value: string): string {
  let end = value.length;
  while (end > 0 && TRIM_SET.indexOf(value[end - 1]) >= 0) end--;
  return value.slice(0, end);
}

/** The text without any whitespace: lets a rewrite check ignore blank-line and trailing-space differences. */
function visibleCadence(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) if (TRIM_SET.indexOf(value[i]) < 0) out += value[i];
  return out;
}

/** Offset in `value` right after its `count`-th non-whitespace character. */
function offsetAfterVisible(value: string, count: number): number {
  if (count === 0) return 0;
  let seen = 0;
  for (let i = 0; i < value.length; i++) {
    if (TRIM_SET.indexOf(value[i]) < 0) {
      seen++;
      if (seen === count) return i + 1;
    }
  }
  return value.length;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function isSpaceChar(c: string): boolean {
  return c === " " || c === "\t" || c === "\u00a0" || c === "\u3000";
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = value.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

/** Backticks must pair up and bold markers outside code spans must pair up before a paragraph may end a bubble. */
function strongMarkersOpen(value: string): boolean {
  let ticks = 0;
  let inCode = false;
  let outside = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "`") {
      ticks++;
      inCode = !inCode;
    } else if (!inCode) {
      outside += c;
    }
  }
  return ticks % 2 === 1 || countOccurrences(outside, "**") % 2 === 1;
}

/** Any opener without its closer keeps a sentence from ending a bubble (a lone closer in an emoticon does not). */
function inlineMarkersOpen(value: string): boolean {
  return strongMarkersOpen(value)
    || countOccurrences(value, "(") > countOccurrences(value, ")")
    || countOccurrences(value, "[") > countOccurrences(value, "]")
    || countOccurrences(value, "\"") % 2 === 1
    || countOccurrences(value, "\u201c") > countOccurrences(value, "\u201d")
    || countOccurrences(value, "\u300c") > countOccurrences(value, "\u300d");
}

function isDecorativeToken(token: string): boolean {
  let any = false;
  for (const ch of token) {
    const cp = ch.codePointAt(0)!;
    const ok = cp === 0x314b || cp === 0x314e || cp === 0x3160 || cp === 0x315c || cp === 0x7e || cp === 0x5e
      || cp === 0xfe0f || cp === 0x200d
      || (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff);
    if (!ok) return false;
    any = true;
  }
  return any;
}

/** True when the text already ends a sentence: a closing mark, or laughter/emoji after one. */
function endsSentence(piece: string): boolean {
  if (piece.length === 0) return false;
  const last = piece[piece.length - 1];
  if (TERMINATORS.indexOf(last) >= 0 || CLOSERS.indexOf(last) >= 0) return true;
  let s = piece.length;
  while (s > 0 && !isSpaceChar(piece[s - 1])) s--;
  return isDecorativeToken(piece.slice(s));
}

/** `U.S`, `e.g`: every dot-separated part is one letter. Domains, file names and decimals are not abbreviations. */
function isDottedInitials(token: string): boolean {
  for (const part of token.split(".")) {
    if (part.length !== 1 || !/^[A-Za-z]$/.test(part)) return false;
  }
  return true;
}

function isAbbreviation(block: string, start: number, dotIndex: number): boolean {
  let begin = dotIndex;
  while (begin > start && !isSpaceChar(block[begin - 1]) && block[begin - 1] !== "\n") begin--;
  let token = block.slice(begin, dotIndex);
  while (token.length > 0 && OPENERS.indexOf(token[0]) >= 0) token = token.slice(1);
  if (token.length === 0) return false;
  if (token.indexOf(".") >= 0) return isDottedInitials(token);
  if (token.length === 1 && /^[A-Za-z]$/.test(token)) return true;
  return ABBREVIATIONS.indexOf(token.toLowerCase()) >= 0;
}

// ---- blocks ----------------------------------------------------------------------------------------------------

interface CadenceBlock {
  text: string;
  end: number;
}

/**
 * Paragraph blocks: runs of lines separated by blank lines that are not inside a code fence. `endsClosed` is true
 * when the text ends right after a blank line (the last block is finished); a lone trailing newline does not close.
 * Block text keeps its leading indentation so an indented code block can be recognized.
 */
function scanBlocks(norm: string): { blocks: CadenceBlock[]; endsClosed: boolean } {
  const blocks: CadenceBlock[] = [];
  let fence: { marker: string; length: number } | null = null;
  let curStart = -1;
  let curEnd = -1;
  let offset = 0;
  for (;;) {
    const nl = norm.indexOf("\n", offset);
    const complete = nl >= 0;
    const lineEnd = complete ? nl : norm.length;
    const line = norm.slice(offset, lineEnd);
    const fenceLine = FENCE_LINE.exec(line);
    let content = true;
    if (fenceLine && !fence) {
      fence = { marker: fenceLine[1][0], length: fenceLine[1].length };
    } else if (fenceLine && fence && fenceLine[1][0] === fence.marker
      && fenceLine[1].length >= fence.length && trimCadence(fenceLine[2]) === "") {
      fence = null;
    } else if (!fence && BLANK_LINE.test(line)) {
      content = false;
      if (complete && curStart >= 0) {
        blocks.push({ text: trimEndCadence(norm.slice(curStart, curEnd)), end: curEnd });
        curStart = -1;
      }
    }
    if (content && !(line === "" && !complete)) {
      if (curStart < 0) curStart = offset;
      curEnd = lineEnd;
    }
    if (!complete) break;
    offset = nl + 1;
  }
  let endsClosed = false;
  if (curStart >= 0) {
    blocks.push({ text: trimEndCadence(norm.slice(curStart, curEnd)), end: curEnd });
  } else {
    endsClosed = blocks.length > 0;
  }
  return { blocks, endsClosed };
}

function isStructuredBlock(text: string): boolean {
  for (const line of text.split("\n")) {
    if (FENCE_LINE.test(line) || HEADING_LINE.test(line) || LIST_LINE.test(line)
      || TABLE_LINE.test(line) || QUOTE_LINE.test(line) || RULE_LINE.test(line)
      || (INDENT_LINE.test(line) && !BLANK_LINE.test(line))) return true;
  }
  return false;
}

/**
 * Blocks that must travel together because a bold marker or backtick is still open: a group grows until it closes.
 * `lastOpen` tells that the final group never closed (it may be closed by a block that has not arrived yet).
 */
function groupBlocks(texts: string[]): { groups: string[]; lastOpen: boolean } {
  const groups: string[] = [];
  let lastOpen = false;
  for (let i = 0; i < texts.length; i++) {
    let current = texts[i];
    while (strongMarkersOpen(current) && i + 1 < texts.length) {
      i++;
      current = `${current}\n\n${texts[i]}`;
    }
    groups.push(current);
    lastOpen = strongMarkersOpen(current);
  }
  return { groups, lastOpen };
}

// ---- gate ------------------------------------------------------------------------------------------------------

/**
 * True for a short plain conversational answer. Code (fenced or indented), tables, headings, rules, three or more
 * list items, control markers and long answers keep their normal rendering (one piece, no pacing).
 */
export function isConversational(text: string, config: ChatCadenceConfig = CHAT_CADENCE): boolean {
  const value = normalizeNewlines(text);
  const length = trimCadence(value).length;
  if (length === 0 || length > config.gate.maxTotalChars) return false;
  if (value.indexOf("<<agentlas-") >= 0) return false;
  let listItems = 0;
  for (const line of value.split("\n")) {
    if (FENCE_LINE.test(line) || HEADING_LINE.test(line) || TABLE_LINE.test(line) || RULE_LINE.test(line)) return false;
    if (INDENT_LINE.test(line) && !BLANK_LINE.test(line)) return false;
    if (LIST_LINE.test(line)) listItems++;
  }
  return listItems < 3;
}

// ---- splitting -------------------------------------------------------------------------------------------------

function splitSentences(block: string): string[] {
  const pieces: string[] = [];
  const n = block.length;
  let start = 0;
  let lineStart = 0;
  let i = 0;
  const cut = (end: number): void => {
    const piece = trimCadence(block.slice(start, end));
    if (piece.length > 0) pieces.push(piece);
  };
  while (i < n) {
    const c = block[i];
    if (c === "\n") {
      // A long line that does not end a sentence is hard-wrapped text: keep reading instead of cutting mid-sentence.
      const lineLength = trimCadence(block.slice(lineStart, i)).length;
      if (lineLength >= HARD_WRAP_MIN_CHARS && !endsSentence(trimCadence(block.slice(start, i)))) {
        i++;
        lineStart = i;
        continue;
      }
      cut(i);
      i++;
      start = i;
      lineStart = i;
      continue;
    }
    if (TERMINATORS.indexOf(c) >= 0) {
      let j = i;
      while (j + 1 < n && (TERMINATORS.indexOf(block[j + 1]) >= 0 || CLOSERS.indexOf(block[j + 1]) >= 0)) j++;
      const next = j + 1 < n ? block[j + 1] : "";
      // Fullwidth marks end a sentence even when no space follows (CJK text is written without spaces).
      if (next === "" || next === "\n" || isSpaceChar(next) || FULLWIDTH_TERMINATORS.indexOf(c) >= 0) {
        if (!(c === "." && isAbbreviation(block, start, i))) {
          // Laughter and emoji right after a sentence belong to that sentence.
          let k = j + 1;
          for (;;) {
            let s = k;
            while (s < n && isSpaceChar(block[s])) s++;
            let e = s;
            while (e < n && !isSpaceChar(block[e]) && block[e] !== "\n") e++;
            if (e > s && isDecorativeToken(block.slice(s, e))) k = e;
            else break;
          }
          cut(k);
          i = k;
          start = k;
          continue;
        }
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  cut(n);
  return pieces;
}

function mergeShortPieces(pieces: string[], config: ChatCadenceConfig): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    if (out.length === 0) {
      out.push(piece);
      continue;
    }
    const last = out[out.length - 1];
    const short = last.length < config.gate.mergeUnderChars || piece.length < config.gate.mergeUnderChars;
    // A short piece joins its neighbour only while the bubble stays small; an open marker always joins.
    if (inlineMarkersOpen(last) || (short && last.length + 1 + piece.length <= config.gate.mergeUpToChars)) {
      out[out.length - 1] = `${last} ${piece}`;
    } else {
      out.push(piece);
    }
  }
  return out;
}

function bubblesFromGroup(group: string, config: ChatCadenceConfig): string[] {
  if (isStructuredBlock(group)) return [trimEndCadence(group)];
  const text = trimCadence(group);
  if (text.length <= config.gate.splitOverChars) return [text];
  return mergeShortPieces(splitSentences(text), config);
}

function capBubbles(bubbles: string[], config: ChatCadenceConfig): string[] {
  const max = config.gate.maxBubbles;
  if (bubbles.length <= max) return bubbles;
  return [...bubbles.slice(0, max - 1), bubbles.slice(max - 1).join("\n\n")];
}

/** Cut an answer into bubbles: paragraphs first, then sentences of long paragraphs, short pieces merged, at most `maxBubbles`. */
export function splitBubbles(text: string, config: ChatCadenceConfig = CHAT_CADENCE): string[] {
  const norm = normalizeNewlines(text);
  if (trimCadence(norm).length === 0) return [];
  const { groups } = groupBlocks(scanBlocks(norm).blocks.map((block) => block.text));
  const bubbles: string[] = [];
  for (const group of groups) bubbles.push(...bubblesFromGroup(group, config));
  return capBubbles(bubbles, config);
}

export interface DisplayBubbles {
  conversational: boolean;
  bubbles: string[];
}

/** What a settled answer shows: bubbles when conversational, otherwise the original text as one piece. */
export function displayBubbles(text: string, config: ChatCadenceConfig = CHAT_CADENCE): DisplayBubbles {
  if (trimCadence(text).length === 0) return { conversational: false, bubbles: [] };
  if (!isConversational(text, config)) return { conversational: false, bubbles: [text] };
  return { conversational: true, bubbles: splitBubbles(text, config) };
}

export interface StreamBubbles {
  conversational: boolean;
  /** Bubbles that may be released now. Always a prefix of what `displayBubbles` returns once the answer is done. */
  closed: string[];
  /** Text after the closed bubbles (still being written). When `conversational` is false this is the whole text. */
  tail: string;
  /** Length of the newline-normalized text that the closed bubbles cover; 0 when not conversational. */
  consumed: number;
}

/**
 * Bubbles for a growing (cumulative) answer. Only paragraphs finished by a blank line are released. A group of
 * paragraphs held together by an open marker waits as a whole, and the last bubble slot waits for `done`, so a
 * released bubble is never rewritten when the answer finishes.
 */
export function streamBubbles(text: string, done: boolean, config: ChatCadenceConfig = CHAT_CADENCE): StreamBubbles {
  const norm = normalizeNewlines(text);
  if (!isConversational(norm, config)) return { conversational: false, closed: [], tail: text, consumed: 0 };
  if (done) return { conversational: true, closed: splitBubbles(norm, config), tail: "", consumed: norm.length };
  const { blocks, endsClosed } = scanBlocks(norm);
  const closedBlocks = Math.max(0, endsClosed ? blocks.length : blocks.length - 1);
  const { groups, lastOpen } = groupBlocks(blocks.slice(0, closedBlocks).map((block) => block.text));
  const usable = lastOpen ? groups.length - 1 : groups.length;
  const all: string[] = [];
  for (let g = 0; g < usable; g++) all.push(...bubblesFromGroup(groups[g], config));
  const closed = all.slice(0, config.gate.maxBubbles - 1);
  // The bubbles only drop whitespace, so what they cover is found by counting visible characters.
  const consumed = offsetAfterVisible(norm, visibleCadence(closed.join("")).length);
  return { conversational: true, closed, tail: trimCadence(norm.slice(consumed)), consumed };
}

// ---- release timing --------------------------------------------------------------------------------------------

/** Pause before a bubble of `length` characters follows the previous one. */
export function bubbleGapMs(length: number, config: ChatCadenceConfig = CHAT_CADENCE, reducedMotion = false): number {
  if (reducedMotion) return config.reducedMotion.gapMs;
  const raw = config.gap.baseMs + Math.floor((length * 1000) / config.gap.charsPerSec);
  return Math.min(config.gap.maxMs, Math.max(config.gap.minMs, raw));
}

export interface ReleaseQueueOptions {
  /** When the owner's message left the composer (same monotonic clock as `nowMs`). */
  sendAtMs: number;
  nowMs: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onRelease: (bubble: string, index: number) => void;
  config?: ChatCadenceConfig;
  /** "Show instantly": every bubble is released the moment it closes. */
  instant?: boolean;
  /** System reduce-motion: flat short gaps. */
  reducedMotion?: boolean;
}

interface QueuedBubble {
  text: string;
  closedAtMs: number;
}

/**
 * Releases closed bubbles one at a time. A bubble never waits for anything but its own turn: the first one for
 * `first.minAfterSendMs` after the send, the next ones for `bubbleGapMs` after the previous release. A slow model
 * adds no delay (a bubble is released when it closes). When the answer finishes, the gaps still queued are scaled so
 * the last bubble comes at most `budget.maxAddedDelayMs` after the later of the finish and the first release.
 * One timer at most, set only for the next release; no polling. A clock that jumps back is absorbed: every time
 * anchor is pulled back to `now`, so a bubble never waits longer than one gap. If `onRelease` throws, the remaining
 * bubbles still go out on time and the first error is rethrown afterwards.
 */
export class ReleaseQueue {
  private readonly cfg: ChatCadenceConfig;
  private queue: QueuedBubble[] = [];
  private released = 0;
  private sendAtMs: number;
  private lastReleaseAtMs = 0;
  private timer: unknown = null;
  private finished = false;
  private disposed = false;
  private ticking = false;
  private again = false;
  private scaleNumerator = 0;
  private scaleDenominator = 0;

  constructor(private readonly options: ReleaseQueueOptions) {
    this.cfg = options.config ?? CHAT_CADENCE;
    this.sendAtMs = options.sendAtMs;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** A bubble just closed. Ignored after `finish` or `dispose`. */
  push(bubble: string): void {
    if (this.finished || this.disposed || bubble.length === 0) return;
    this.queue.push({ text: bubble, closedAtMs: this.options.nowMs() });
    if (this.timer === null) this.tick();
  }

  /** The answer is complete: compress what is still queued to fit the delay budget. */
  finish(): void {
    if (this.finished || this.disposed) return;
    this.finished = true;
    let sum = 0;
    this.queue.forEach((bubble, position) => {
      if (this.released + position >= 1) sum += this.gap(bubble.text.length);
    });
    if (sum > this.cfg.budget.maxAddedDelayMs) {
      this.scaleNumerator = this.cfg.budget.maxAddedDelayMs;
      this.scaleDenominator = sum;
    }
    this.tick();
  }

  /** Release everything queued right now (stop, new message, app in background). */
  flush(): void {
    if (this.disposed) return;
    this.clearTimer();
    const now = this.options.nowMs();
    let failure: { error: unknown } | null = null;
    while (this.queue.length > 0) {
      try {
        this.release(now);
      } catch (error) {
        if (failure === null) failure = { error };
      }
    }
    if (failure !== null) throw failure.error;
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.clearTimer();
  }

  private gap(length: number): number {
    const base = bubbleGapMs(length, this.cfg, this.options.reducedMotion === true);
    if (this.scaleDenominator === 0) return base;
    return Math.max(this.cfg.budget.minGapMsWhenCompressed, Math.floor((base * this.scaleNumerator) / this.scaleDenominator));
  }

  /** Every anchor lies in the past on a monotonic clock; if the clock went back, pull the anchors back with it. */
  private absorbClockJump(now: number): void {
    if (this.sendAtMs > now) this.sendAtMs = now;
    if (this.lastReleaseAtMs > now) this.lastReleaseAtMs = now;
    for (const bubble of this.queue) if (bubble.closedAtMs > now) bubble.closedAtMs = now;
  }

  private eligibleAt(head: QueuedBubble): number {
    if (this.options.instant === true) return head.closedAtMs;
    if (this.released === 0) return Math.max(head.closedAtMs, this.sendAtMs + this.cfg.first.minAfterSendMs);
    return Math.max(head.closedAtMs, this.lastReleaseAtMs + this.gap(head.text.length));
  }

  private release(now: number): void {
    const head = this.queue.shift()!;
    this.lastReleaseAtMs = now;
    const index = this.released++;
    this.options.onRelease(head.text, index);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.options.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    let failure: { error: unknown } | null = null;
    try {
      do {
        this.again = false;
        this.clearTimer();
        while (!this.disposed && this.queue.length > 0) {
          const now = this.options.nowMs();
          this.absorbClockJump(now);
          const at = this.eligibleAt(this.queue[0]);
          if (at <= now) {
            try {
              this.release(now);
            } catch (error) {
              if (failure === null) failure = { error };
            }
            continue;
          }
          this.timer = this.options.setTimer(() => {
            this.timer = null;
            this.tick();
          }, at - now);
          break;
        }
      } while (this.again && !this.disposed);
    } finally {
      this.ticking = false;
    }
    if (failure !== null) throw failure.error;
  }
}

// ---- session: cumulative text in, released bubbles out ------------------------------------------------------------

export interface CadenceSessionOptions {
  /** When the owner's message left the composer (same monotonic clock as `nowMs`). */
  sendAtMs: number;
  nowMs: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Something visible changed (a bubble, `plain` or `tail`). Read `bubbles`, `tail` and `plain`. */
  onChange: () => void;
  config?: ChatCadenceConfig;
  instant?: boolean;
  reducedMotion?: boolean;
}

/**
 * The one adapter between a growing answer and what the screen shows, so every surface feeds the queue the same way.
 * Call `update(visibleText, done)` with the cumulative answer text (control blocks already stripped) on every change.
 *
 * What to draw:
 * - `plain` true: the whole text as one normal message (not conversational yet, or the text was rewritten instead of
 *   appended). `bubbles` is empty.
 * - otherwise: `bubbles` one below the other, then, when `tail` is not empty, `tail` as one normal message. `tail` is
 *   the part after the bubbles that is not conversational (a list or code block that arrived late, text appended
 *   after the answer finished); it is shown at once, never paced.
 *
 * A released bubble is never taken back unless the text is rewritten. `flush()` treats the last text as final.
 */
export class CadenceSession {
  private readonly queue: ReleaseQueue;
  private readonly shown: string[] = [];
  private readonly fed: string[] = [];
  private fedVisible = "";
  private lastText: string | null = null;
  private plainMode = false;
  private tailText = "";
  private rewritten = false;
  private finished = false;
  private disposed = false;
  private pendingError: { error: unknown } | null = null;

  constructor(private readonly options: CadenceSessionOptions) {
    this.queue = new ReleaseQueue({
      sendAtMs: options.sendAtMs,
      nowMs: options.nowMs,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      config: options.config,
      instant: options.instant,
      reducedMotion: options.reducedMotion,
      onRelease: (bubble) => {
        this.shown.push(bubble);
        options.onChange();
      },
    });
  }

  get plain(): boolean {
    return this.plainMode;
  }

  get bubbles(): readonly string[] {
    return this.shown;
  }

  /** Plain text to draw after the bubbles; empty when there is none. */
  get tail(): string {
    return this.tailText;
  }

  /** True when nothing more will change: the answer is complete and every bubble is out. */
  get settled(): boolean {
    return this.finished && this.queue.pending === 0;
  }

  /**
   * Feed the cumulative visible text. If `onChange` throws, the session still finishes its own bookkeeping (every
   * bubble queued, `done` applied) and the first error is rethrown at the end.
   */
  update(text: string, done: boolean): void {
    if (this.disposed) return;
    this.lastText = text;
    if (this.rewritten) {
      if (done) this.finished = true;
      return;
    }
    const norm = normalizeNewlines(text);
    // Nothing written yet: wait, do not call it plain.
    if (!done && trimCadence(norm).length === 0) return;
    this.apply(norm, done);
    this.rethrow();
  }

  /** Release everything queued now (stop, new message, app in background) and treat the last text as final. */
  flush(): void {
    if (this.disposed || this.rewritten) return;
    if (!this.finished) {
      const last = this.lastText;
      if (last !== null && trimCadence(last).length > 0) {
        this.run(() => this.update(last, true));
      } else {
        this.finished = true;
        this.run(() => this.queue.finish());
      }
    }
    this.run(() => this.queue.flush());
    this.rethrow();
  }

  dispose(): void {
    this.disposed = true;
    this.queue.dispose();
  }

  private apply(norm: string, done: boolean): void {
    if (this.finished) {
      if (this.plainMode) return;
      if (this.sameVisiblePrefix(norm)) this.showRest(norm);
      else this.rewrite();
      return;
    }
    const out = streamBubbles(norm, done, this.options.config ?? CHAT_CADENCE);
    if (!out.conversational) {
      if (this.fed.length === 0) {
        // Nothing was shown as a bubble: the whole text is plain for now.
        this.show(true, "");
      } else if (this.sameVisiblePrefix(norm)) {
        // The rest is not conversational (a list, code, a heading arrived): keep the bubbles, show the rest at once.
        this.showRest(norm);
      } else {
        this.rewrite();
        if (done) this.finished = true;
        return;
      }
    } else if (this.extendsFed(out.closed)) {
      const fresh = out.closed.slice(this.fed.length);
      for (const bubble of fresh) this.fed.push(bubble);
      this.fedVisible = visibleCadence(norm.slice(0, out.consumed));
      this.show(false, "");
      for (const bubble of fresh) this.run(() => this.queue.push(bubble));
    } else if (this.sameVisiblePrefix(norm)) {
      // The text drifted without being rewritten (spacing changed, a trailing control block was stripped): keep the bubbles.
      this.showRest(norm);
    } else {
      this.rewrite();
      if (done) this.finished = true;
      return;
    }
    if (done) {
      this.finished = true;
      this.run(() => this.queue.finish());
    }
  }

  private extendsFed(closed: string[]): boolean {
    if (closed.length < this.fed.length) return false;
    for (let i = 0; i < this.fed.length; i++) if (closed[i] !== this.fed[i]) return false;
    return true;
  }

  /** The text still starts with what the released bubbles cover, ignoring whitespace. */
  private sameVisiblePrefix(norm: string): boolean {
    return visibleCadence(norm).startsWith(this.fedVisible);
  }

  /** Show what follows the released bubbles at once; queued bubbles go out first so the order stays right. */
  private showRest(norm: string): void {
    const rest = trimCadence(norm.slice(offsetAfterVisible(norm, this.fedVisible.length)));
    if (rest.length > 0) this.run(() => this.queue.flush());
    this.show(false, rest);
  }

  private show(plain: boolean, tail: string): void {
    if (plain === this.plainMode && tail === this.tailText) return;
    this.plainMode = plain;
    this.tailText = tail;
    this.run(() => this.options.onChange());
  }

  private rewrite(): void {
    this.rewritten = true;
    this.queue.dispose();
    this.shown.length = 0;
    this.fed.length = 0;
    this.plainMode = true;
    this.tailText = "";
    this.run(() => this.options.onChange());
  }

  private run(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (this.pendingError === null) this.pendingError = { error };
    }
  }

  private rethrow(): void {
    const pending = this.pendingError;
    this.pendingError = null;
    if (pending !== null) throw pending.error;
  }
}
