/*
 * The words of the shared-memory road in ONE place: what the desktop sends and how it reads every answer. PURE: no store, no network, no Electron. The words are the contract's, one meaning each; this file
 * changes only when the contract's example file (`shared-memory-wire.examples.json`, made from the server's own output) says so.
 *
 *   desktop -> server   POST /api/desktop/shared-memory       { hostId, cursor, items: [ put{row, replaces?} | said{id} | forget{id, fp} ] }
 *   answer              { results: [ ok{sid,seq,evicted?} | same{sid} | out{why} | full | forgotten | refused{why} | retry ], forgotAllSeq }   (one per item, in order)
 *   server -> desktop   GET  /api/desktop/shared-memory/pull?hostId=..&cursor=<n|none>[&page=<next>]
 *                       { seq, events: [ in{card} | out{id,why} | forgotten{id} ] (by number), forgotAllSeq }
 *                     | { reset: { why: new|far_behind|era, set: [card], forgotten: [id], forgotAllSeq, next }, seq }   (the whole set, in pages)
 *                     | { lost: true }
 * Text from the server is untrusted data: a card is read by `cardOf` into closed fields and never reaches a prompt from here.
 */
export type SharedKind = "fact" | "identity" | "boundary";
export type Boundary = { type: "no_proactive" | "quiet_hours"; from?: string; to?: string };
export interface WireRow {
  id: string; kind: SharedKind; text: string; en?: string; quote?: string; boundary?: Boundary;
  claimType?: string; verification?: string; saidAt: string; grounded: boolean;
}
export type PushItem =
  | { op: "put"; row: WireRow; replaces?: string[] }
  | { op: "said"; id: string }
  | { op: "forget"; id: string; fp: string };

export const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const FP_RE = /^[a-f0-9]{32}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const chars = (text: string): number => Array.from(text).length;

export const WIRE_LIMITS = Object.freeze({
  /** a push is at most 100 items and 240,000 bytes (the server's limits, with room for the keys) */ pushItems: 100, pushBodyBytes: 240_000,
  /** a put names at most 8 replaced cards */ replaces: 8,
  /** the card's words: 200 characters (English 300); a card that arrives may be up to 4,000 */ rowText: 200, rowEn: 300, cardText: 4_000,
});

/** A server card, read into closed fields; null when it is not one (never cut, never guessed). */
export interface Card {
  sid: string; kind: SharedKind; text: string; en: string | null; boundary: Boundary | null;
  claimType: "user" | "observed" | "inferred"; verification: "self_reported" | "unverified"; saidAt: string | null; by: string | null; seq: number | null;
  /** the id the adding desktop gave the line (a card this desktop said comes back under it) */ homeId: string | null;
}
export function boundaryOf(raw: unknown): Boundary | null {
  if (!isRecord(raw)) return null;
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (raw.type === "no_proactive") return { type: "no_proactive" };
  if (raw.type === "quiet_hours" && typeof raw.from === "string" && typeof raw.to === "string" && hhmm.test(raw.from) && hhmm.test(raw.to)) return { type: "quiet_hours", from: raw.from, to: raw.to };
  return null;
}
export function cardOf(raw: unknown): Card | null {
  if (!isRecord(raw)) return null;
  const sid = typeof raw.id === "string" ? raw.id : typeof raw.sid === "string" ? raw.sid : null;
  if (sid === null || !ID_RE.test(sid) || typeof raw.text !== "string" || !raw.text.trim()) return null;
  const kind = raw.kind;
  if (kind !== "identity" && kind !== "fact" && kind !== "boundary") return null;   // a `preference` is never shared: one that arrives is not taken
  const text = raw.text.trim();
  if (text.length > WIRE_LIMITS.cardText) return null;
  const en = typeof raw.en === "string" && raw.en.trim() && chars(raw.en.trim()) <= WIRE_LIMITS.rowText ? raw.en.trim() : null;
  return {
    sid, kind, text, en: en !== null && en !== text ? en : null, boundary: kind === "boundary" ? boundaryOf(raw.boundary) : null,
    // a grade the card does not carry means the LOW one (the presence of the field decides, never the words): it must not come down as "the person said it themselves"
    claimType: raw.claimType === "user" || raw.claimType === "observed" || raw.claimType === "inferred" ? raw.claimType : "observed",
    verification: raw.verification === "self_reported" || raw.verification === "unverified" ? raw.verification : "unverified",
    saidAt: typeof raw.saidAt === "string" ? raw.saidAt : null,
    // who said it: `phone` or a desktop's host id; display only. A card without it is read as the phone's.
    by: typeof raw.by === "string" && raw.by.length <= 64 ? raw.by : "phone",
    seq: Number.isSafeInteger(raw.seq) && (raw.seq as number) >= 0 ? raw.seq as number : null,
    homeId: typeof raw.homeId === "string" && ID_RE.test(raw.homeId) ? raw.homeId : null,
  };
}

// ───────────────────────── a push answer ─────────────────────────
export type PutAnswer =
  | { word: "ok"; sid: string; seq: number | null; evicted: { count: number; text: string; saidAt: string | null } | null }
  | { word: "same"; sid: string }
  | { word: "out"; why: string } | { word: "full" } | { word: "forgotten" } | { word: "refused"; why: string } | { word: "retry" } | { word: "unknown" };
/** The word of one answered item (`status`, or `word`), or "". A `forget` and a `said` answer carry no card id, so they are read by the word alone. */
export function wordOf(raw: unknown): string { return isRecord(raw) ? (typeof raw.status === "string" ? raw.status : typeof raw.word === "string" ? raw.word : "") : ""; }
export function answerOf(raw: unknown): PutAnswer {
  if (!isRecord(raw)) return { word: "unknown" };
  const word = typeof raw.status === "string" ? raw.status : typeof raw.word === "string" ? raw.word : "";
  const sid = typeof raw.sid === "string" && ID_RE.test(raw.sid) ? raw.sid : null;
  switch (word) {
    case "ok": {
      if (sid === null) return { word: "retry" };   // an `ok` with no card id is not believed: the same item goes again (an id is idempotent)
      const e = raw.evicted;
      const evicted = isRecord(e) && typeof e.text === "string" && e.text.trim() ? { count: Number.isSafeInteger(e.count) && (e.count as number) > 0 ? e.count as number : 1, text: e.text.trim().slice(0, 400), saidAt: typeof e.saidAt === "string" ? e.saidAt : null } : null;
      return { word: "ok", sid, seq: Number.isSafeInteger(raw.seq) ? raw.seq as number : null, evicted };
    }
    case "same": return sid === null ? { word: "retry" } : { word: "same", sid };
    case "out": return { word: "out", why: typeof raw.why === "string" ? raw.why : "replaced" };
    case "full": return { word: "full" };
    case "forgotten": return { word: "forgotten" };
    case "refused": return { word: "refused", why: typeof raw.why === "string" ? raw.why : "refused" };
    case "retry": return { word: "retry" };
    default: return { word: "unknown" };
  }
}
/** A push answer that says the memory is not open for this person (`open: false`, no results). */
export function pushClosed(body: Record<string, unknown>): boolean { return body.open === false; }
export function eraOfBody(body: Record<string, unknown>): number | null { return Number.isSafeInteger(body.era) && (body.era as number) >= 0 ? body.era as number : null; }
export function forgotAllSeqOf(body: Record<string, unknown> | null | undefined): number {
  const v = body && isRecord(body.reset) && body.reset.forgotAllSeq !== undefined ? body.reset.forgotAllSeq : body?.forgotAllSeq;
  return Number.isSafeInteger(v) && (v as number) > 0 ? v as number : 0;
}

// ───────────────────────── a pull answer ─────────────────────────
export type Event = { seq: number; type: "in"; card: Card } | { seq: number; type: "out"; id: string; why: string } | { seq: number; type: "forgotten"; id: string };
export type PullAnswer =
  | { kind: "lost"; era: number | null }
  | { kind: "events"; seq: number; events: Event[]; forgotAllSeq: number; more: boolean; era: number | null }
  | { kind: "closed" }
  | { kind: "reset"; why: string; seq: number | null; set: Card[]; forgotten: string[]; forgotAllSeq: number; next: string | null; era: number | null };
export function pullAnswerOf(body: Record<string, unknown> | null | undefined): PullAnswer | null {
  if (!isRecord(body)) return null;
  const eraOf = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null);
  if (body.open === false) return { kind: "closed" };   // the server's memory is not open for this person: nothing to read
  if (body.lost === true) return { kind: "lost", era: eraOf(body.era) };
  const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ID_RE.test(x)) : []);
  const r = isRecord(body.reset) ? body.reset : body.reset === true ? body : null;
  if (r) {
    const set = Array.isArray(r.set) ? r.set : [];
    const next = typeof r.next === "string" && r.next ? r.next : null;
    const seqRaw = r.seq !== undefined ? r.seq : body.seq;
    return { kind: "reset", why: typeof r.why === "string" ? r.why : "new", seq: Number.isSafeInteger(seqRaw) && (seqRaw as number) >= 0 ? seqRaw as number : null,
      set: set.map(cardOf).filter((c): c is Card => c !== null), forgotten: idList(r.forgotten), forgotAllSeq: forgotAllSeqOf(body), next, era: eraOf(body.era ?? r.era) };
  }
  if (!Number.isSafeInteger(body.seq) || (body.seq as number) < 0 || !Array.isArray(body.events)) return null;
  const events: Event[] = [];
  for (const raw of body.events as unknown[]) {
    if (!isRecord(raw)) continue;
    const seq = Number.isSafeInteger(raw.seq) ? raw.seq as number : 0;
    const type = typeof raw.ev === "string" ? raw.ev : typeof raw.type === "string" ? raw.type : typeof raw.t === "string" ? raw.t : "";
    if (type === "in") { const card = cardOf(raw.card); if (card) events.push({ seq, type: "in", card }); }
    else if (type === "out" && typeof raw.id === "string" && ID_RE.test(raw.id)) events.push({ seq, type: "out", id: raw.id, why: typeof raw.why === "string" ? raw.why : "replaced" });
    else if (type === "forgotten" && typeof raw.id === "string" && ID_RE.test(raw.id)) events.push({ seq, type: "forgotten", id: raw.id });
  }
  events.sort((a, b) => a.seq - b.seq);
  return { kind: "events", seq: body.seq as number, events, forgotAllSeq: forgotAllSeqOf(body), more: body.more === true, era: eraOf(body.era) };
}
