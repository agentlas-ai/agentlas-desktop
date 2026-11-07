// Personal One: how a reply row becomes message bubbles. No React and no DOM here, so a fake clock can drive it.
//
// The cut and the pacing are shared/chat-cadence.ts (CadenceSession, displayBubbles) and nothing else. This file only
// keeps one session per live reply row and turns the rows ChatContinuationProjector made into one row per bubble.
//  - a reply that is being written now: its session decides which bubbles are out, the dots stay until the last one;
//  - a reply that is already finished (history, reopened window): displayBubbles cuts it at once, no pacing;
//  - a row that must keep its normal rendering (it carries a card) is returned as it was.
// Display only: no stored text, run or bridge payload changes.

import { CadenceSession, displayBubbles, type DisplayBubbles } from "../../shared/chat-cadence";

export interface CadenceClock {
  /** Monotonic milliseconds (performance.now). */
  nowMs(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface CadencePrefs {
  /** "Show instantly": every bubble comes out the moment it closes, no motion. */
  instant: boolean;
  /** System reduce-motion: short flat gaps, no motion. */
  reducedMotion: boolean;
}

/** What one session shows right now. `bubbles` is a copy; `fresh` holds the bubble indexes that just came out and still move in. */
export interface CadenceView {
  plain: boolean;
  bubbles: readonly string[];
  tail: string;
  settled: boolean;
  fresh: ReadonlySet<number>;
}

/** The shape of a row this file may cut. ChatContinuationRow has it. */
export interface CadenceRowShape {
  id: string;
  text: string;
  markdownText?: string;
  continuation: boolean;
  tail: boolean;
  frozen: boolean;
}

/** Set on the rows this file made. A row without it was not touched. */
export interface CadenceRowInfo {
  /** Stable identity of the reply row the bubbles came from. */
  sourceKey: string;
  index: number;
  count: number;
  /** The whole text of the row before it was cut: copy and reply work on the answer, not on one bubble. */
  sourceText: string;
  /** Three dots under this row: the answer is not finished or its last bubble is not out yet. */
  typing: boolean;
  /** This bubble just came out: it moves in. */
  enter: boolean;
}
export type CadenceRow<R extends CadenceRowShape> = R & { cadence?: CadenceRowInfo };

export interface CadenceRowOps<R extends CadenceRowShape> {
  /** The key React draws the row with; it must not change when the live row becomes the saved one. */
  key(row: R): string;
  /** An assistant reply that may be cut into bubbles. False for a user row and for a reply that carries a card. */
  eligible(row: R): boolean;
  /** The reply is being written now (an active run whose saved answer has not arrived). */
  live(row: R): boolean;
  /** How long ago the owner sent the message this row answers. */
  sentAgoMs(row: R): number;
}

/** A session only lives while its row is on screen; settled ones are dropped oldest first beyond this. */
export const CADENCE_MAX_SESSIONS = 8;
/** A row older than this that already has text when first seen was opened again (restart, other page): it shows at once. */
export const CADENCE_REOPENED_AFTER_MS = 5_000;
/**
 * A live reply that stays silent this long shows what it still holds back (its last paragraph is not closed until more text
 * comes): a long tool run or a dead link must not hide written words. Text that comes later is added after it.
 */
export const CADENCE_STALL_MS = 8_000;
/** Cap for the cache of cuts of finished replies. */
const CUT_CACHE_MAX = 400;

export function systemCadenceClock(): CadenceClock {
  return {
    nowMs: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

interface Entry {
  session: CadenceSession;
  /** Bubbles that came out so far, to tell which ones are new. */
  known: number;
  motion: boolean;
  fresh: Set<number>;
  /** The session threw; the row is drawn as one normal message from now on. */
  failed: boolean;
  /** The reply is complete (its saved answer arrived or the row ended): only its pacing is left. */
  done: boolean;
  /** The text last fed, to tell a changed text (re-arms the silence watch) from a repeated one. */
  lastText: string;
  /** The silence watch: one timer, only while the reply is live. */
  stall: unknown;
  /** The watch is waiting for the window to be shown again: a hidden window gets no events, so its silence says nothing. */
  paused: boolean;
}

/**
 * One CadenceSession per live reply row, keyed by the row's stable key. `sync` feeds them from the rows, `view` reads
 * them back. One timer per session at most (the next release); `dispose` leaves none.
 */
export class CadenceRegistry {
  private entries = new Map<string, Entry>();
  private prefs: CadencePrefs;
  private hidden = false;

  constructor(
    private readonly clock: CadenceClock,
    private readonly onChange: () => void,
    prefs: CadencePrefs = { instant: false, reducedMotion: false },
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.prefs = prefs;
  }

  /** New sessions use these; sessions already running keep the ones they started with. */
  setPrefs(prefs: CadencePrefs): void {
    this.prefs = prefs;
  }

  /**
   * The window is hidden or shown. A hidden window stops drawing frames, and the run events that carry the text come in with them:
   * the silence of a live reply is then the window's, not the model's, and cutting its last paragraph short would turn the rest into
   * a plain tail. The silence watch waits (no timer) and starts again, from zero, when the window is shown.
   */
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    for (const entry of this.entries.values()) {
      if (hidden) {
        if (entry.stall !== null) { this.clock.clearTimer(entry.stall); entry.stall = null; entry.paused = true; }
      } else if (entry.paused) {
        this.watch(entry);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  view(key: string): CadenceView | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.failed) return { plain: true, bubbles: [], tail: "", settled: true, fresh: new Set() };
    return { plain: entry.session.plain, bubbles: entry.session.bubbles.slice(), tail: entry.session.tail,
      settled: entry.session.settled, fresh: new Set(entry.fresh) };
  }

  /** The bubble finished moving in. Nothing is drawn again. */
  seen(key: string, index: number): void {
    this.entries.get(key)?.fresh.delete(index);
  }

  /**
   * Feed every eligible row. A live row gets a session on first sight; a finished row only updates a session it has
   * already (so the saved answer settles it). A session whose row left the list is flushed: nothing waits on a row nobody sees.
   */
  sync<R extends CadenceRowShape>(rows: readonly R[], ops: CadenceRowOps<R>): void {
    const present = new Set<string>();
    for (const row of rows) {
      if (!ops.eligible(row)) continue;
      const key = ops.key(row);
      present.add(key);
      const live = ops.live(row);
      let entry = this.entries.get(key);
      if (!entry) {
        if (!live) continue;
        entry = this.create(key, row.text, ops.sentAgoMs(row));
      } else {
        // Most recently used last, so the oldest settled one is the one dropped.
        this.entries.delete(key);
        this.entries.set(key, entry);
      }
      if (entry.failed) continue;
      entry.done = !live;
      // A reply that ended without text on the row (stopped, failed) settles with what was already shown instead of
      // being rewritten to nothing, and its dots go out.
      if (!live && row.text.trim().length === 0) this.act(entry, () => entry!.session.flush());
      else this.act(entry, () => entry!.session.update(row.text, !live));
      if (entry.failed) continue;
      if (live && row.text !== entry.lastText) { entry.lastText = row.text; this.watch(entry); }
      else if (!live) this.unwatch(entry);
      // A row cut off by a follow-up from the owner is frozen: what was queued comes out now.
      if (row.frozen && !entry.failed) this.settle(entry);
      // A reply that completes while the window is hidden is shown in full: nobody watches its bubbles come out.
      if (this.hidden && entry.done && !entry.failed && !entry.session.settled) this.settle(entry);
    }
    for (const [key, entry] of this.entries) {
      if (!present.has(key) && !entry.failed && !entry.session.settled) this.settle(entry);
    }
    this.evict();
  }

  /** Everything queued comes out now and the last text counts as final: only for a run that ended (stop). */
  flush(): void {
    for (const entry of this.entries.values()) {
      if (!entry.failed && !entry.session.settled) this.settle(entry);
    }
  }

  /**
   * The queued bubbles of replies that are already complete come out now (a new message, the window hidden). A reply still being
   * written is left alone: treating its last text as final would cut it mid-sentence and turn the rest into plain text.
   */
  flushFinished(): void {
    for (const entry of this.entries.values()) {
      if (entry.done && !entry.failed && !entry.session.settled) this.settle(entry);
    }
  }

  /** Stop every timer and forget every session. The registry can be used again. */
  dispose(): void {
    for (const entry of this.entries.values()) { this.unwatch(entry); entry.session.dispose(); }
    this.entries.clear();
  }

  private create(key: string, text: string, sentAgoMs: number): Entry {
    const reopened = text.trim().length > 0 && sentAgoMs >= CADENCE_REOPENED_AFTER_MS;
    const instant = this.prefs.instant || reopened;
    const motion = !instant && !this.prefs.reducedMotion;
    const holder: { entry: Entry | null } = { entry: null };
    const session = new CadenceSession({
      sendAtMs: this.clock.nowMs() - Math.max(0, sentAgoMs),
      nowMs: () => this.clock.nowMs(),
      // A release that throws from a timer must not escape into the window's error handler: the row falls back to one normal message.
      setTimer: (callback, ms) => this.clock.setTimer(() => {
        const entry = holder.entry;
        if (entry) this.guard(entry, callback); else callback();
      }, ms),
      clearTimer: (handle) => this.clock.clearTimer(handle),
      instant,
      reducedMotion: this.prefs.reducedMotion,
      onChange: () => {
        const entry = holder.entry;
        if (entry) {
          const count = session.bubbles.length;
          if (session.plain || count < entry.known) { entry.known = count; entry.fresh.clear(); }
          else {
            if (entry.motion) for (let index = entry.known; index < count; index++) entry.fresh.add(index);
            entry.known = count;
          }
        }
        this.onChange();
      },
    });
    const entry: Entry = { session, known: 0, motion, fresh: new Set(), failed: false, done: false, lastText: "", stall: null, paused: false };
    holder.entry = entry;
    this.entries.set(key, entry);
    return entry;
  }

  private guard(entry: Entry, action: () => void): void {
    try {
      action();
    } catch (error) {
      // A throwing session must never leave the reply without a way to be drawn: it turns into one normal message.
      entry.failed = true;
      this.unwatch(entry);
      entry.session.dispose();
      entry.fresh.clear();
      this.onError(error);
      try { this.onChange(); } catch (inner) { this.onError(inner); }
    }
  }

  /** The last text counts as final and everything queued comes out; nothing is watched any more. */
  private settle(entry: Entry): void {
    this.unwatch(entry);
    this.act(entry, () => entry.session.flush());
  }

  /**
   * Run something on a session. A session that settles without showing anything new (an answer with no words, a stop before the
   * first one) calls no onChange itself, yet its dots must go out: the screen is told.
   */
  private act(entry: Entry, action: () => void): void {
    const before = entry.session.settled;
    this.guard(entry, action);
    if (!entry.failed && entry.session.settled !== before) {
      try { this.onChange(); } catch (error) { this.onError(error); }
    }
  }

  /** (Re)start the silence watch: when nothing is written for CADENCE_STALL_MS and some text is still held back, show it. */
  private watch(entry: Entry): void {
    this.unwatch(entry);
    if (entry.done || entry.failed) return;
    if (this.hidden) { entry.paused = true; return; }
    entry.stall = this.clock.setTimer(() => {
      entry.stall = null;
      if (entry.done || entry.failed || !this.holdsBack(entry)) return;
      this.settle(entry);
    }, CADENCE_STALL_MS);
  }

  private unwatch(entry: Entry): void {
    entry.paused = false;
    if (entry.stall !== null) { this.clock.clearTimer(entry.stall); entry.stall = null; }
  }

  /** The text fed holds words that no bubble or tail shows yet. */
  private holdsBack(entry: Entry): boolean {
    if (entry.session.plain) return false;
    const visible = (value: string) => value.replace(/[ \t\n\r\u00a0\u3000\ufeff]/g, "");
    return visible(entry.lastText).length > visible(entry.session.bubbles.join("") + entry.session.tail).length;
  }

  private evict(): void {
    if (this.entries.size <= CADENCE_MAX_SESSIONS) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= CADENCE_MAX_SESSIONS) break;
      // A reply still being written stays even when its session settled (a silence flush): its row has nothing else to show.
      if (entry.failed || (entry.done && entry.session.settled)) { this.unwatch(entry); this.entries.delete(key); }
    }
  }
}

/** Cuts of finished replies, by row key and exact text; a streamed update re-reads the list without cutting every old reply again. */
export class CadenceCutCache {
  private cuts = new Map<string, { text: string; result: DisplayBubbles }>();

  cut(key: string, text: string): DisplayBubbles {
    const hit = this.cuts.get(key);
    if (hit && hit.text === text) return hit.result;
    const result = displayBubbles(text);
    this.cuts.delete(key);
    this.cuts.set(key, { text, result });
    while (this.cuts.size > CUT_CACHE_MAX) this.cuts.delete(this.cuts.keys().next().value!);
    return result;
  }
}

function bubbleRow<R extends CadenceRowShape>(row: R, key: string, index: number, count: number, text: string, last: boolean,
  typing: boolean, enter: boolean): CadenceRow<R> {
  return { ...row, id: index === 0 ? row.id : `${key}:b${index}`, text, markdownText: text,
    continuation: row.continuation || index > 0, tail: last && row.tail,
    cadence: { sourceKey: key, index, count, sourceText: row.text, typing: last && typing, enter } };
}

/**
 * Nothing to draw: no bubble has come out. The dots stay while the reply is being written; a session that has settled without
 * any text (stopped before the first word, an answer that is only a control block or a question card) has none.
 */
function waitingRow<R extends CadenceRowShape>(row: R, key: string, view: CadenceView | null): CadenceRow<R> {
  const typing = row.tail && !row.frozen && (view === null || !view.settled);
  return { ...row, text: "", markdownText: "", cadence: { sourceKey: key, index: 0, count: 1, sourceText: row.text, typing, enter: false } };
}

function fromBubbles<R extends CadenceRowShape>(row: R, key: string, bubbles: readonly string[], tail: string, view: CadenceView | null): CadenceRow<R>[] {
  const pieces = tail ? [...bubbles, tail] : [...bubbles];
  const typing = view !== null && !view.settled && row.tail && !row.frozen;
  return pieces.map((text, index) => bubbleRow(row, key, index, pieces.length, text, index === pieces.length - 1, typing,
    view !== null && view.fresh.has(index) && index < bubbles.length));
}

/**
 * One row per bubble for every eligible assistant row. The first bubble keeps the row's id, later ones are
 * `${key}:b${n}` (a continuation: no sender name), `tail` stays on the last one so attachments, hand-off cards and the
 * failure button still sit under the end of the reply.
 */
export function expandCadenceRows<R extends CadenceRowShape>(rows: readonly R[], ops: CadenceRowOps<R>,
  registry: Pick<CadenceRegistry, "view">, cuts: CadenceCutCache): CadenceRow<R>[] {
  const out: CadenceRow<R>[] = [];
  for (const row of rows) {
    if (!ops.eligible(row)) { out.push(row); continue; }
    const key = ops.key(row);
    const view = registry.view(key);
    if (view) {
      if (view.plain) { out.push(row); continue; }
      if (view.bubbles.length === 0 && !view.tail) { out.push(waitingRow(row, key, view)); continue; }
      out.push(...fromBubbles(row, key, view.bubbles, view.tail, view));
      continue;
    }
    if (ops.live(row)) { out.push(waitingRow(row, key, null)); continue; }
    const cut = cuts.cut(key, row.text);
    if (!cut.conversational || cut.bubbles.length <= 1) { out.push(row); continue; }
    out.push(...fromBubbles(row, key, cut.bubbles, "", null));
  }
  return out;
}
