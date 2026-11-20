/*
 * The computer's half of the mirror.
 * The home computer (and only the home) puts what changed in the personal agent's memory lines, conversation words and profile on the server, and takes what the server
 * wrote or deleted while it was away. This file is the ORDER and the RULES; the stores and the signed transport are ports (home-mirror-real.ts, home.ts), so a gate can drive it
 * with a fake server and a scratch store.
 *
 * Signals, no timer: a Personal line was written / replaced / forgotten, a personal-agent turn ended, the profile was saved, the app started, a pointer read followed a restored
 * sign-in or a wake, this computer became the home (a new epoch), or a run ended with a failure (the next signal also takes). Nothing changed = zero requests: what to send is
 * the difference between the store and the small record of what the server already has (`MirrorState`), found only when the store's change mark moved.
 *
 * What is kept (one row of the app database `meta`, key `one_mirror:v1:<userId>`, written here only):
 *   rows        live Personal line id -> the fingerprint of its text (+ `@<wire id>` for a line that IS a server card this computer took), for the lines the server holds
 *   refused     line id -> closed word the server (or this file) refused it with; never sent again (a line is immutable: an edit is a new line). `capacity` is the exception: it is asked
 *               again once per run of the app, and when this run's own deletions made room
 *   msgAt/msgIds the conversation cursor: the creation time of the last word sent and the ids sent at exactly that instant (a bounded set)
 *   profile     the fingerprint of the profile the server has (and the closed words it was built from, for a profile that has no own style field here)
 *   epoch       the home epoch the last full take was made for (a new epoch takes everything again: the server offers a new home all it holds)
 *   behindSince when a run first ended with a failure (cleared by a clean run): the one fact a person may be told ("not matched for a long time")
 * Who reads it: this file. Who deletes it: `forget()` (account slot forgotten / another account signs in) and nothing else; its size is bounded by the live Personal lines (<= 700) plus 200 refusals.
 *
 * Failures mend themselves: every failure leaves the work in the store, so the next signal sends the same bodies again (all ids are idempotent). A 5xx, a network cut, a timeout, 429
 * and a clock refusal back off in memory (15 s doubling to 30 min, or the server's own `retryAfterSeconds`); `stale_epoch` re-reads the pointer and goes on once; a refusal that says
 * "not this home / not now" (`server_fenced`, `home_unconfirmed`, `device_proof_invalid`, a closed switch) holds until the pointer's epoch or trust changes. Nothing is shown to the person
 * except `behindSince` older than STALE_AFTER_MS.
 *
 * TH+MT (contracts/mirror-trust.md, one-home-mirror.md): `held` is the one refusal word of a line that is NOT final: the server holds a forget of it that a place that is not trusted made, until the person answers (here or on the
 * phone). The line stays on this computer and is asked again at the next run (`MirrorState.held`, ids only, bounded by the live lines); `capacity` keeps its once-per-run rule. `waiting: n` on the first page of the `gone` take is kept as
 * ONE number in memory (`status().waiting`): the words, lines and forgets themselves are never stored here (they are read from the server, `waitingList`, when the owner's window is opened, and given to that window as plain text).
 * TH+MT 2 (audit D1-D12): the deleted words' file rewrite is a DEBT paid once per take page without waiting (server-turns.ts); a word and its turn link are one transaction and a page whose link failed is not acknowledged; the first alignment and the
 * ordinary take do not grade a card alike (`cardWriteOf`); the things set aside are COUNTED (`MirrorState.skipped`, read by `status()`); a cut text of the waiting list is read whole before it can be accepted (`waitingItem`).
 * Nothing here reads a word of a line to decide what it means: kinds, words and fingerprints come from columns and closed tables. No model is called. Text from the server is untrusted
 * data: it never reaches a prompt module, a tool result or a log line from this file.
 */
import { createHash } from "node:crypto";
import type { MirrorFiles } from "./mirror-files";

// ───────────────────────── numbers (each with its reason) ─────────────────────────
export const MIRROR_LIMITS = Object.freeze({
  /** Contract §2: gone <= 200, rows <= 200, messages <= 100 per body; the body <= 1 MiB (kept under with room for the signature). */
  gone: 200, rows: 200, messages: 100, bodyBytes: 900_000,
  /** Contract §2: text <= 200 characters, en <= 300, message text <= 4000 characters. */
  rowText: 200, rowEn: 300, messageText: 4_000,
  /** Contract §3: a page is at most 100 items. */
  pull: 100,
  /** Requests of one run. Mirror and ack share the server's write budget (60 / 10 min per key): one run never spends more than 40, the rest waits for the next signal. */
  callsPerRun: 40,
  /** A first upload only needs what the server keeps: the newest 5,000 words (contract §8, the 5,000 trim). */
  messagesKept: 5_000,
  /** The server's id shape (contract §2). */
  idChars: 64,
  /** The refusals kept (a line the server will not take is remembered by id; more than this are not remembered and are asked again later). */
  refusedMax: 200,
  /** A message answer has at most 20 bubbles (slots 1..20). */
  bubbles: 20,
});
/** "Not matched for a long time": the first moment a person could notice a missing memory is when the phone answers (computer off) with a day-old mirror. Not a constant of the server; 24 h is this file's judgment. */
export const STALE_AFTER_MS = 24 * 3_600_000;
const BACKOFF_FIRST_MS = 15_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const SERVER_FACT_PREFIX = "hope-server-fact:";
const SERVER_CARD_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

// ───────────────────────── pure helpers (also the gate's vectors) ─────────────────────────
const sha = (text: string): Buffer => createHash("sha256").update(text).digest();
const chars = (text: string): number => Array.from(text).length;
/** The server's fingerprint of a line's words (companion-one-mirror-ids.mjs `factFingerprint`): letters and digits only (NFKC, lower case), sha-256, first 32 hex; null when nothing is left. */
export function factFingerprint(text: string): string | null {
  const folded = String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return folded === "" ? null : sha(folded).toString("hex").slice(0, 32);
}
/** A local id in the shape the server takes (`^[A-Za-z0-9_.:-]{1,64}$`); an id that is not that shape becomes `x_<30 hex of its sha-256>` (deterministic, so the same id is the same on every run). */
export function wireId(id: string): string { return ID_RE.test(id) ? id : `x_${sha(id).toString("hex").slice(0, 30)}`; }

/** The turns a `gone` item of the server names: `turnId` and `turnIds` (a closed id shape each, at most 32 in all; one that is not an id is not read - the server reads a list with a bad id as not read at all, so does this). */
export function goneTurnsOf(item: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof item.turnId === "string" && ID_RE.test(item.turnId)) out.push(item.turnId);
  if (Array.isArray(item.turnIds) && item.turnIds.every((t) => typeof t === "string" && ID_RE.test(t))) {
    for (const t of item.turnIds as string[]) { if (!out.includes(t)) out.push(t); }
  }
  return out.slice(0, 32);
}

export type ServerKind = "identity" | "preference" | "fact" | "boundary";
/** A Personal line of this computer, as the store reads it (home-mirror-real.ts). */
export interface PersonalRow {
  /** memory_entries.id */ id: string;
  /** `preference` | `fact` (the two Personal columns) */ kind: "preference" | "fact";
  /** the kind the model gave before the computer folded it (`context_json.ticket_kind`), or null */ ticketKind: "identity" | "boundary" | null;
  /** the structured boundary of a card this computer took from the server, or null */ boundary: { type: string; from?: string; to?: string } | null;
  /** the English line (`content`) */ content: string;
  /** the original-language wording, or null */ native: string | null;
  originClass: string | null; certainty: string | null;
  createdAt: string;
  /** the server card this line IS (it was taken from the server: `hope-server-fact:<id>` in its evidence), or null */ serverCard: string | null;
}
export interface WireRow { id: string; kind: ServerKind; text: string; en?: string; boundary?: { type: string; from?: string; to?: string }; claimType?: string; verification?: string; createdAt: string }
export type RowRefusal = "too_long" | "empty";

/** The table of kinds, words and limits. A line that cannot be written within the server's limits is not cut: it is returned as a closed refusal word and stays here. */
export function wireRowOf(row: PersonalRow, nowIso: string): { ok: true; row: WireRow; fp: string } | { ok: false; why: RowRefusal } {
  const native = row.native?.trim() || null;
  const content = row.content.trim();
  let text = native ?? content; let en: string | undefined = native && native !== content ? content : undefined;
  if (!text) return { ok: false, why: "empty" };
  if (chars(text) > MIRROR_LIMITS.rowText) {
    // the original is too long for the server's card: the English line stands in for it when it fits (it is the line this computer recalls by); else the line stays here
    if (native && content && chars(content) <= MIRROR_LIMITS.rowText) { text = content; en = undefined; } else return { ok: false, why: "too_long" };
  }
  if (en !== undefined && chars(en) > MIRROR_LIMITS.rowEn) en = undefined;   // the server leaves a long English line out anyway; the card keeps its text
  const fp = factFingerprint(text);
  if (fp === null) return { ok: false, why: "empty" };
  // kind: a boundary only with its structure (a line the model folded into a preference has no structure and goes as a preference); identity as identity; else the Personal column.
  const kind: ServerKind = row.boundary && row.ticketKind === "boundary" ? "boundary" : row.ticketKind === "identity" ? "identity" : row.kind;
  const claimType = row.originClass === "user" || row.originClass === "observed" || row.originClass === "inferred" ? row.originClass : row.originClass === "result" ? "inferred" : undefined;
  const verification = row.certainty === "self_reported" ? "self_reported" : row.certainty === "unverified" || row.certainty === "run_verified" || row.originClass === "result" ? "unverified" : undefined;
  const made = Date.parse(row.createdAt);
  const out: WireRow = {
    id: row.serverCard ? `${SERVER_FACT_PREFIX}${row.serverCard}` : wireId(row.id), kind, text,
    ...(en !== undefined ? { en } : {}), ...(kind === "boundary" && row.boundary ? { boundary: row.boundary } : {}),
    ...(claimType ? { claimType } : {}), ...(verification ? { verification } : {}),
    createdAt: Number.isFinite(made) ? new Date(made).toISOString() : nowIso,
  };
  return { ok: true, row: out, fp };
}

/** One card of the server's pull -> what to write on this computer (the table of section 2 read the other way), or a closed word. */
export interface CardWrite {
  serverId: string; kind: "preference" | "fact"; ticketKind: "identity" | "boundary" | null; boundary: unknown;
  content: string; native: string | null; originClass: "user" | "observed" | "inferred"; certainty: "self_reported" | "unverified"; replaces: string[]; fp: string | null; wireText: string;
  /** the id the card had on the home that wrote it (a card this computer wrote itself before another computer was the home comes back with its own id) */ homeId: string | null;
}
export type CardRefusal = "bad_card" | "too_long_text";
/**
 * `missing` = what a grade the card does not carry means (audit D5, by the PRESENCE of the field only, never by the words):
 *  - `low` (the ordinary take of the mirror): `observed` / `unverified`. A server that does not know the grades (an older one) or a card made before they existed must not come down as "the person said it themselves"; a server that grades writes both fields on every card it makes.
 *  - `top` (the move's import, `home-move-real.ts`): `user` / `self_reported`. contracts/mirror-trust.md section 5: the first alignment is itself the owner's approval ("everything the server held until then comes down whatever its grade"), so it is NOT changed.
 */
export function cardWriteOf(item: unknown, missing: "low" | "top" = "low"): { ok: true; write: CardWrite } | { ok: false; why: CardRefusal } {
  const raw = (item !== null && typeof item === "object" && !Array.isArray(item) ? item : null) as Record<string, unknown> | null;
  if (!raw || typeof raw.id !== "string" || !SERVER_CARD_ID_RE.test(raw.id) || typeof raw.text !== "string" || !raw.text.trim()) return { ok: false, why: "bad_card" };
  const kind = raw.kind;
  if (kind !== "identity" && kind !== "preference" && kind !== "fact" && kind !== "boundary") return { ok: false, why: "bad_card" };
  const text = raw.text.trim();
  if (text.length > 4_000) return { ok: false, why: "too_long_text" };
  const en = typeof raw.en === "string" && raw.en.trim() ? raw.en.trim() : null;
  const claim: CardWrite["originClass"] = raw.claimType === "user" || raw.claimType === "observed" || raw.claimType === "inferred" ? raw.claimType : missing === "top" ? "user" : "observed";
  const certainty: CardWrite["certainty"] = raw.verification === "self_reported" || raw.verification === "unverified" ? raw.verification : missing === "top" ? "self_reported" : "unverified";
  return {
    ok: true,
    write: {
      serverId: raw.id, kind: kind === "fact" ? "fact" : "preference", ticketKind: kind === "identity" || kind === "boundary" ? kind : null,
      boundary: kind === "boundary" && raw.boundary !== undefined ? raw.boundary : null,
      // The person's words (`text`) are never dropped or replaced. An English line that fits this computer's 200 is what it recalls by (`content`, the words kept as `native`); a longer or absent one is left out and the words are the line (the translation worker fills the English later). A long English line never refuses a card.
      content: en && chars(en) <= MIRROR_LIMITS.rowText ? en : text, native: en && chars(en) <= MIRROR_LIMITS.rowText && en !== text ? text : null, originClass: claim, certainty, wireText: text, fp: factFingerprint(text),
      homeId: raw.origin === "home" && typeof raw.homeId === "string" ? raw.homeId : null,
      replaces: Array.isArray(raw.replaces) ? raw.replaces.filter((r): r is string => typeof r === "string" && r.length <= 128).slice(0, 8) : [],
    },
  };
}

// ───────────────────────── state ─────────────────────────
/** The profile as the server has it: the fingerprint and the closed words it was built from (the base of a three-way take: a field the owner changed here since is kept). */
export interface ProfileWords { fp: string; name?: string; character?: string; style?: string; language?: string; timeZone?: string }
export interface MirrorState {
  v: 1;
  epoch: number | null;
  rows: Record<string, string>;
  refused: Record<string, string>;
  msgAt: string | null; msgIds: string[];
  profile: ProfileWords | null;
  profileRefusedFp: string | null;
  behindSince: number | null;
  /** the store's change mark when the last diff found nothing left to send (a mark that did not move needs no query) */
  settledMark: string | null;
  /** TH+MT: ids of lines the server answered `held` (not final: asked again at the next run); dropped when the line is sent, or is no longer live. */
  held: string[];
  /** Audit D8: what was set aside, as bounded numbers and one closed word - never the thing itself. `words` = words not stored since the account was taken (cumulative; they are acknowledged, the server does not give them again), `cards` = cards the LAST complete take of the
   * facts refused (replaced by each take: those are offered again until fixed), `held` = gone items whose acknowledgement was held back (replaced each take like `cards`), `last` = the closed word of the latest cause. Deleted with the state (`forget`). */
  skipped: { words: number; cards: number; held: number; last: SkipWord | null };
}
/** basis: a count a person could never need past this (the status shows a number); saturates instead of growing for ever. */
const SKIP_COUNT_MAX = 999_999;
/** basis: the live Personal lines' ceiling is 700 (curator ruleset `ceilingRows`); 800 = the number `parseState` always capped the list at. At the limit: a line past it is not in `held` and is sent again by the diff whenever the store's change mark moves. */
const HELD_MAX = 800;
export type SkipWord = "bad_word" | "bad_date" | "too_long" | "bad_card" | "too_long_text" | "secret_like" | "write_failed" | "words_not_deleted" | "words_setting_not_restored" | "words_not_linked";
const SKIP_WORDS: ReadonlySet<string> = new Set(["bad_word", "bad_date", "too_long", "bad_card", "too_long_text", "secret_like", "write_failed", "words_not_deleted", "words_setting_not_restored", "words_not_linked"]);
const zeroSkipped = (): MirrorState["skipped"] => ({ words: 0, cards: 0, held: 0, last: null });
export const emptyState = (): MirrorState => ({ v: 1, epoch: null, rows: {}, refused: {}, msgAt: null, msgIds: [], profile: null, profileRefusedFp: null, behindSince: null, settledMark: null, held: [], skipped: zeroSkipped() });
function parseState(raw: string | null): MirrorState {
  if (!raw) return emptyState();
  try {
    const v = JSON.parse(raw) as Partial<MirrorState>;
    if (!v || v.v !== 1) return emptyState();
    const s = emptyState();
    if (typeof v.epoch === "number" && Number.isSafeInteger(v.epoch)) s.epoch = v.epoch;
    if (v.rows && typeof v.rows === "object") for (const [k, val] of Object.entries(v.rows)) if (typeof val === "string") s.rows[k] = val;
    if (v.refused && typeof v.refused === "object") for (const [k, val] of Object.entries(v.refused)) if (typeof val === "string") s.refused[k] = val;
    if (typeof v.msgAt === "string") s.msgAt = v.msgAt;
    if (Array.isArray(v.msgIds)) s.msgIds = v.msgIds.filter((x): x is string => typeof x === "string").slice(0, 400);
    if (v.profile && typeof v.profile === "object" && typeof v.profile.fp === "string") s.profile = v.profile;
    if (typeof v.profileRefusedFp === "string") s.profileRefusedFp = v.profileRefusedFp;
    if (typeof v.behindSince === "number") s.behindSince = v.behindSince;
    if (typeof v.settledMark === "string") s.settledMark = v.settledMark;
    if (Array.isArray(v.held)) s.held = v.held.filter((x): x is string => typeof x === "string").slice(0, HELD_MAX);
    if (v.skipped && typeof v.skipped === "object") {
      const k = v.skipped as Partial<MirrorState["skipped"]>; const n = (x: unknown): number => (typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? Math.min(x, SKIP_COUNT_MAX) : 0);
      s.skipped = { words: n(k.words), cards: n(k.cards), held: n(k.held), last: typeof k.last === "string" && SKIP_WORDS.has(k.last) ? k.last as SkipWord : null };
    }
    return s;
  } catch { return emptyState(); }
}
const rowFp = (value: string): string => value.split("@")[0];
const rowWire = (localId: string, value: string): string => { const i = value.indexOf("@"); return i < 0 ? wireId(localId) : `${SERVER_FACT_PREFIX}${value.slice(i + 1)}`; };

// ───────────────────────── ports ─────────────────────────
export interface MirrorMessage { id: string; wire: string; turnId: string; n: number; role: "user" | "friend"; text: string; saidAt: string; at: string; skip?: "too_long" | "too_many_bubbles" | "bad_date";
  /** TH-web 2: the id the phone's word carries at the server (one-home-mirror.md section 2), for a person's word (`n` 0) that came from the phone; the server then keeps ONE line for the same word. Absent = none. */ clientMessageId?: string }
export interface LocalProfile { name: string; character: string | null; style: string | null; language: string; timeZone: string | null }
export interface CallAnswer { ok: boolean; status?: number; code?: string; unreachable?: boolean; retryable?: boolean; body?: Record<string, unknown> | null }
export type Standing = { ok: true; epoch: number; key: string } | { ok: false; why: string; key: string };

export interface MirrorStorePort {
  /** Moves whenever a Personal line may have been written, replaced or forgotten (the memory store's revision). */
  rowsMark(): string;
  liveRows(): PersonalRow[];
  /** For a line that is no longer live: forgotten (the owner's forget stamp) or replaced (an edit, a rewrite, a purge). */
  rowFate(id: string): "forgotten" | "replaced";
  /** TH-web 2 (`gone[].turnIds`): ALL the turns a forgotten line came from (a line the resting-time pass gathered from several turns names several), up to 32; the server forgets each turn's words. Absent: `rowTurn`'s one turn only. */
  rowTurns?(id: string): string[];
  /** TH+MT F2: the server forgot these turns: the words this computer took from them leave (server-turns.ts). Returns how many words were deleted. Absent = nothing is linked here. */
  forgetServerTurns?(turnIds: string[]): number;
  /** Audit D1: pays the debt of the deleted words (a TRUNCATE checkpoint that never waits). `none` = nothing owed. Absent = no debt (a gate without it). */
  settleServerWords?(): "none" | "clean" | "busy" | "failed";
  /** K7': for a forgotten line, the wire id of the one turn it was said in (the personal agent's turn whose ticket the line is linked to), or null when that is not exactly one turn. The server then forgets that turn's conversation words too (contract section 2, `gone[].turnId`). */
  rowTurn?(id: string): string | null;
  /** The conversation words after the cursor (creation time + ids sent at exactly that time), oldest first, grouped into turns. `from` = where to start when there is no cursor yet. */
  messages(after: { at: string | null; ids: string[] }, limit: number, from: "newest-kept" | "start"): MirrorMessage[];
  /** No personal-agent turn is in flight (a half-written answer is never sent). */
  resting(): boolean;
  profile(): LocalProfile | null;
  // taking
  forgetMatching(match: { homeId?: string; serverId?: string; fp?: string }): string[];
  /** `own`: the line is one this computer wrote itself (the card came back under its own id), so its id on the server is its own id, not `hope-server-fact:<card>`. */
  writeCard(card: CardWrite): { result: "written" | "already" | "rejected"; localId?: string; own?: boolean; why?: string };
  supersede(newLocalId: string, ref: string): void;
  /** The server's words -> this computer. A number = how many were stored (a gate's fake store); the object also says how many were set aside (`dropped`, with the closed word of one cause) and whether each word was linked to its turn in the same transaction (`linked: false` = this page must NOT be acknowledged, audit D2). */
  importMessages(items: unknown[]): number | { inserted: number; dropped: number; why: "bad_word" | "bad_date" | "too_long" | null; linked: boolean };
  /** The phone's profile -> this computer's. `base` = the profile the server last had from here: a field the owner changed here since then is kept (the owner's edit goes on top at the next send). */
  applyProfile(server: unknown, base: ProfileWords | null): string[];
  homeRev(): number;
}
export interface HomeMirrorPorts {
  now(): number;
  userId(): string | null;
  /** The 2.0 switch (workspace rules on). Off = no request, nothing read. */
  switchOn(): boolean;
  /** Is this computer the confirmed home right now? `key` names the situation (epoch, trust, home): a refusal that holds is lifted when it changes. */
  standing(): Standing;
  /** One signed call; the epoch is added by the caller. Never throws. */
  call(route: "mirror" | "mirror/pull" | "mirror/ack" | "mirror/confirm", fields: Record<string, unknown>): Promise<CallAnswer>;
  /** TH: the standing of a computer that is in the middle of a server-start move and has committed (the record carries the move, so `standing()` says `move_in_progress`): same checks, the move ignored. Absent = `standing()`. */
  standingDuringMove?(): Standing;
  refreshPointer(): Promise<void>;
  loadState(userId: string): string | null;
  saveState(userId: string, json: string): void;
  clearState(userId: string): void;
  store(): MirrorStorePort | null;
  /** VD: the files that come with the bubbles taken (mirror-files.ts). Absent = files are not taken (a gate without them, the background service). */
  files?: MirrorFiles | null;
  /** DD: the connected apps of the server (server-apps.ts). `signal` says which mirror signal came (never waited for); `seen` hands over the `appsRev` of an upload answer. Absent: nothing of this. */
  apps?: { signal(kind: MirrorSignal): void; seen(rev: unknown): void } | null;
}

export type MirrorSignal = "memory" | "turn" | "profile" | "start" | "home";
export interface RunReport {
  ran: boolean; skipped?: string; calls: number; code?: string; more?: boolean;
  up: { gone: number; rows: number; messages: number; profile: boolean; refused: number; held?: number };
  down: { gone: number; cards: number; messages: number; profile: boolean; rejected: number; words?: number };
}
const emptyReport = (): RunReport => ({ ran: false, calls: 0, up: { gone: 0, rows: 0, messages: 0, profile: false, refused: 0 }, down: { gone: 0, cards: 0, messages: 0, profile: false, rejected: 0 } });

const HOLD_CODES = new Set(["server_fenced", "home_is_server", "home_unconfirmed", "device_proof_invalid", "device_proof_unavailable", "one_home_unavailable", "account_deleting", "not_home"]);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export interface MirrorStatus { stale: boolean; behindSince: number | null; holding: string | null;
  /** PR-D2: whether the server holds a profile this computer sent or took (`up`), so it can answer while this computer is not reached. The settings sentence about that is drawn only when `up`. */ profile: "up" | "none";
  /** MT: how many things made by a place that is not trusted wait for the owner's answer (the first `gone` page says it; 0 = none or not yet known). A number only: never a word of them. */ waiting: number;
  /** Audit D8: what was set aside, as numbers and one closed word (see `MirrorState.skipped`). Never a word of the things. */ skipped: { words: number; cards: number; held: number; last: SkipWord | null } }

// ───────────────────────── MT: what waits for the owner ─────────────────────────
/**
 * One thing a place that is not trusted made on the server and the computer was not given (contracts/mirror-trust.md section 3). EVERY `text` is the OTHER side's words: it is untrusted and goes to the owner's eyes only, as PLAIN TEXT
 * (`textOnly: true` says so on every list: the screen shows it with a text node - never as markup, a link, a button or a path). It is never stored here, never logged, never put in a prompt or a tool result.
 */
export type WaitingItem =
  | { t: "fact"; id: string; kind: string; text: string; at: string }
  | { t: "forget"; id: string; homeId?: string; kind?: string; text?: string; chars?: number; cut?: true; at: string }
  | { t: "words"; turnId: string; seq: number; text: string; chars?: number; cut?: true; at: string }
  | { t: "profile"; name: string; at: string };
export interface WaitingList { ok: true; textOnly: true; items: WaitingItem[]; total: number }
export interface WaitingSelection { facts?: string[]; gone?: string[]; turns?: string[]; profile?: boolean }
/** basis: the server's longest word (`maxTextChars` 4000, contracts/one-home-mirror.md section 2): the whole text of one item is at most this. */
const FULL_TEXT_MAX = 4_000;
/** basis: the list shows 200 characters of a text (the server's `WORDS_CHARS` = a card's longest text); a text over it comes with `cut: true` and its length `chars`. */
const LIST_TEXT_MAX = 200;
export type WaitingDecision = "accept" | "reject";
const SELECTION_MAX = 100;     // the server's own per-list limit (contracts/mirror-trust.md section 4: "id <= 100, the same number as ack")
const BIDI_AND_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const plain = (v: unknown, max: number): string => String(v ?? "").replace(BIDI_AND_CONTROL, " ").slice(0, max);
/** A selection in the shape the server takes, or null (a list too long, an id that is not an id, nothing selected, a key that is not one of the four). */
export function cleanSelection(input: unknown): WaitingSelection | null {
  if (!isRecord(input)) return null;
  const out: WaitingSelection = {};
  for (const key of Object.keys(input)) {
    if (key === "profile") { if (input.profile !== true) return null; out.profile = true; continue; }
    if (key !== "facts" && key !== "gone" && key !== "turns") return null;
    const list = input[key];
    if (!Array.isArray(list) || list.length === 0 || list.length > SELECTION_MAX || !list.every((x) => typeof x === "string" && ID_RE.test(x))) return null;
    out[key] = [...new Set(list as string[])];
  }
  return out.facts || out.gone || out.turns || out.profile ? out : null;
}
/** What the server's list answers, cut to the closed shapes (a field that is not one of them is dropped; a text is cut to 200 characters and made plain). */
export function waitingItemsOf(raw: unknown, textMax: number = LIST_TEXT_MAX): WaitingItem[] {
  const out: WaitingItem[] = [];
  if (!Array.isArray(raw)) return out;
  // audit D10 (web `b3371650`): `chars` = the whole length, `cut: true` ONLY when the list shows less than there is (an older server sends neither; the field is not there when the text is whole)
  const lens = (it: Record<string, unknown>): { chars?: number; cut?: true } => ({ ...(Number.isSafeInteger(it.chars) && (it.chars as number) >= 0 ? { chars: Math.min(it.chars as number, FULL_TEXT_MAX) } : {}), ...(it.cut === true ? { cut: true as const } : {}) });
  for (const it of raw.slice(0, SELECTION_MAX)) {
    if (!isRecord(it)) continue;
    const at = typeof it.at === "string" ? it.at.slice(0, 40) : "";
    if (it.t === "fact" && typeof it.id === "string" && ID_RE.test(it.id)) out.push({ t: "fact", id: it.id, kind: plain(it.kind, 16), text: plain(it.text, 200), at });
    else if (it.t === "forget" && typeof it.id === "string" && ID_RE.test(it.id)) out.push({ t: "forget", id: it.id, ...(typeof it.homeId === "string" && ID_RE.test(it.homeId) ? { homeId: it.homeId } : {}), ...(typeof it.kind === "string" ? { kind: plain(it.kind, 16) } : {}), ...(typeof it.text === "string" ? { text: plain(it.text, textMax), ...lens(it) } : {}), at });   // MT-web 2: a held forget of a kept card says which card (text, kind) - the other side's words, plain text
    else if (it.t === "words" && typeof it.turnId === "string" && ID_RE.test(it.turnId) && Number.isSafeInteger(it.seq)) out.push({ t: "words", turnId: it.turnId, seq: it.seq as number, text: plain(it.text, textMax), ...lens(it), at });
    else if (it.t === "profile") out.push({ t: "profile", name: plain(it.name, 64), at });
  }
  return out;
}

export function createHomeMirror(ports: HomeMirrorPorts) {
  // memory only
  let running: Promise<RunReport> | null = null;
  let again: { pull: boolean } | null = null;
  let failures = 0; let nextTryAt = 0;
  let holdKey: string | null = null; let holdCode: string | null = null;
  let needPull = true;                 // the first run of the app takes
  let capacityAsked = false;           // `capacity` lines are asked again once per run of the app
  let cachedUser: string | null = null; let cached: MirrorState | null = null;
  let waiting = 0;                     // MT: the number the first `gone` page said (memory only; a number, never the things)
  // Audit D10: which items of the LAST list the server said it cut (`cut: true`), and which of those were read whole since. Ids only (`<list>:<id>`), at most one page (100), replaced by every list; never a text.
  let cutKeys = new Set<string>(); let readKeys = new Set<string>();

  function state(userId: string): MirrorState {
    if (cachedUser !== userId || !cached) { cached = parseState(ports.loadState(userId)); cachedUser = userId; }
    return cached;
  }
  function save(userId: string, s: MirrorState): void { cached = s; cachedUser = userId; ports.saveState(userId, JSON.stringify(s)); }
  /** Audit D8: the things set aside, as numbers and one closed word. Written only when a number or the word changed (a take that set nothing aside writes nothing). `words` adds; `cards` and `held` replace (what the last take found). */
  function noteSkipped(userId: string, change: { words?: number; cards?: number; held?: number; last?: SkipWord | null }): void {
    const s = state(userId); const k = s.skipped;
    const next = { words: Math.min(SKIP_COUNT_MAX, k.words + (change.words ?? 0)), cards: change.cards ?? k.cards, held: change.held ?? k.held, last: change.last !== undefined && change.last !== null ? change.last : k.last };
    if (next.words === k.words && next.cards === k.cards && next.held === k.held && next.last === k.last) return;
    save(userId, { ...s, skipped: next });
  }
  /** Audit D1: pays the debt of deleted words (never waits, never throws). */
  function payResidue(): void { try { ports.store()?.settleServerWords?.(); } catch { /* a debt that could not be paid stays owed: the next signal asks again */ } }

  function fail(userId: string, out: CallAnswer, report: RunReport, standing: Standing): "stop" | "stale" {
    report.code = out.code ?? (out.unreachable ? "server_unreachable" : "failed");
    const code = out.code ?? "";
    if (code === "stale_epoch") return "stale";
    needPull = true;
    const s = state(userId);
    if (s.behindSince === null) save(userId, { ...s, behindSince: ports.now() });
    if (HOLD_CODES.has(code) || (out.status === 409 && code !== "replayed_request")) { holdKey = standing.key; holdCode = code; return "stop"; }
    failures += 1;
    let wait = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1));
    const retryAfter = Number(out.body?.retryAfterSeconds);
    if (out.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(RETRY_AFTER_MAX_MS, Math.max(wait, retryAfter * 1000));
    nextTryAt = ports.now() + wait;
    return "stop";
  }

  /** `takeOnly` = TH's "one more take" of a move: the same take, no send, the move's own standing (`standingDuringMove`) and the move's own backoff (the mirror's `nextTryAt` is not read). */
  async function runOnce(userId: string, pull: boolean, takeOnly = false): Promise<RunReport> {
    const report = emptyReport();
    const store = ports.store();
    if (!store) { report.skipped = "no_store"; return report; }
    let standing = takeOnly && ports.standingDuringMove ? ports.standingDuringMove() : ports.standing();
    if (!standing.ok) { report.skipped = standing.why; return report; }
    if (holdKey !== null) { if (holdKey === standing.key) { report.skipped = `held:${holdCode ?? ""}`; return report; } holdKey = null; holdCode = null; }
    if (!takeOnly && ports.now() < nextTryAt) { report.skipped = "backoff"; return report; }
    report.ran = true;
    let epoch = standing.epoch;
    const epochOf = (): Record<string, unknown> => ({ epoch });
    let calls = 0;
    const budget = (): boolean => calls < MIRROR_LIMITS.callsPerRun;
    async function call(route: "mirror" | "mirror/pull" | "mirror/ack", fields: Record<string, unknown>): Promise<CallAnswer | "stale" | "stop"> {
      calls += 1; report.calls = calls;
      let out = await ports.call(route, { ...epochOf(), ...fields });
      if (!out.ok) {
        const verdict = fail(userId, out, report, standing);
        if (verdict === "stale") {
          // the home moved under us: read the pointer again; if this computer is still (or again) the home at another epoch the same body is sent once more
          await ports.refreshPointer();
          const again2 = takeOnly && ports.standingDuringMove ? ports.standingDuringMove() : ports.standing();
          if (!again2.ok) { report.skipped = again2.why; return "stop"; }
          standing = again2; epoch = again2.epoch;
          calls += 1; report.calls = calls;
          out = await ports.call(route, { ...epochOf(), ...fields });
          if (!out.ok) { fail(userId, { ...out, code: out.code === "stale_epoch" ? "server_fence_failed" : out.code }, report, standing); return "stop"; }
          return out;
        }
        return "stop";
      }
      return out;
    }
    let s = state(userId);
    const epochChanged = s.epoch !== epoch;
    try {
      // ── take (gone first, so nothing after it can bring a line back) ──
      if (pull || needPull || epochChanged) {
        const took = await takeAll(userId, store, call, report, budget, epochChanged);
        if (took === "stop") return finish(userId, report, false);
        needPull = false;
        s = state(userId);
        if (s.epoch !== epoch) { s = { ...s, epoch }; save(userId, s); }
      }
      if (takeOnly) return finish(userId, report, true);
      // ── send ──
      const sent = await sendAll(userId, store, call, report, budget);
      if (sent === "stop") return finish(userId, report, false);
      return finish(userId, report, true);
    } catch (error) {
      report.code = "mirror_exception";
      void error;
      failures += 1; nextTryAt = ports.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1));
      return finish(userId, report, false);
    }
  }

  function finish(userId: string, report: RunReport, clean: boolean): RunReport {
    if (clean && !report.code) {   // a run that set a closed word (`words_not_linked`) is not clean: the failure count and `behindSince` are not cleared by it
      failures = 0; nextTryAt = 0;
      const s = state(userId);
      if (s.behindSince !== null) save(userId, { ...s, behindSince: null });
      if (!report.more) { /* nothing left over: the mark was saved by the diff */ }
    }
    return report;
  }

  // ───────────────────────── take ─────────────────────────
  type Call = (route: "mirror" | "mirror/pull" | "mirror/ack", fields: Record<string, unknown>) => Promise<CallAnswer | "stale" | "stop">;
  async function takeAll(userId: string, store: MirrorStorePort, call: Call, report: RunReport, budget: () => boolean, newEpoch: boolean): Promise<"ok" | "stop"> {
    void newEpoch;
    const goneIds = new Set<string>(); const goneFps = new Set<string>();
    // 1. gone
    let cursor: string | undefined;
    let heldBack = 0; let heldWhy: SkipWord | null = null;
    for (let page = 0; page < 50 && budget(); page += 1) {
      const wordsBefore = report.down.words ?? 0;
      const out = await call("mirror/pull", { section: "gone", ...(cursor ? { cursor } : {}), limit: MIRROR_LIMITS.pull });
      if (out === "stop" || out === "stale") return "stop";
      // MT: the first page says how many things wait for the owner (nothing is said when none waits). One number; the things are read from the server when the owner opens the window.
      if (!cursor) { const w = Number(out.body?.waiting); waiting = Number.isSafeInteger(w) && w > 0 ? w : 0; }
      const items = Array.isArray(out.body?.items) ? out.body!.items as unknown[] : [];
      const ackIds: string[] = [];
      let s = state(userId);
      for (const raw of items) {
        if (!isRecord(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id)) continue;
        const homeId = typeof raw.homeId === "string" ? raw.homeId : undefined;
        const fp = typeof raw.fp === "string" && /^[a-f0-9]{32}$/.test(raw.fp) ? raw.fp : undefined;
        goneIds.add(raw.id); if (fp) goneFps.add(fp);
        // VD + TH+MT F2: the server forgot these turns (`turnId`, and `turnIds` for a line gathered from several turns, at most 32): the files this computer took with their bubbles go, and so do the WORDS it took from them
        // (`hope-server:<seq>` lines linked to their turn, server-turns.ts) - before anything else is applied. A turn this computer never took deletes nothing; another turn's words are never named.
        const turns = goneTurnsOf(raw);
        for (const t of turns) { try { ports.files?.forgetTurn(userId, t); } catch { /* a file that cannot be removed now is removed by the 90-day sweep */ } }
        if (turns.length && store.forgetServerTurns) {
          try { report.down.words = (report.down.words ?? 0) + store.forgetServerTurns(turns); }
          catch (error) {
            // audit D12: ONE item whose words could not be deleted (a database fault) no longer stops the whole take: this item is skipped and NOT acknowledged (the server offers it again at the next take), the others go on. Counted, never silent.
            heldBack += 1; heldWhy = (error as { message?: string })?.message === "words_setting_not_restored" ? "words_setting_not_restored" : "words_not_deleted";   // counted after the page's own save below (a save of the page's state would overwrite it)
            continue;
          }
        }
        const removed = store.forgetMatching({ serverId: raw.id, ...(homeId ? { homeId } : {}), ...(fp ? { fp } : {}) });
        report.down.gone += removed.length;
        // what was forgotten here because the server said so is not told back (the server made the stamp): it leaves the record of what the server holds
        if (removed.length) { const rows = { ...s.rows }; for (const id of removed) delete rows[id]; s = { ...s, rows }; }
        ackIds.push(raw.id);
      }
      // audit D1: the file rewrite of the words deleted on THIS page is paid ONCE here (not per item), without waiting; a busy answer is a debt kept for the next signal. The acknowledgement does not depend on it (the words are already deleted).
      if ((report.down.words ?? 0) > wordsBefore) payResidue();
      if (ackIds.length) { save(userId, s); const ack = await call("mirror/ack", { section: "gone", ids: ackIds.slice(0, 100) }); if (ack === "stop" || ack === "stale") return "stop"; }
      const next = out.body?.next;
      if (typeof next !== "string" || !next) break; cursor = next;
      if (page === 49) report.more = true;
    }
    noteSkipped(userId, { held: heldBack, ...(heldWhy ? { last: heldWhy } : {}) });
    // 2. profile
    if (budget()) {
      const out = await call("mirror/pull", { section: "profile", limit: 1 });
      if (out === "stop" || out === "stale") return "stop";
      const item = Array.isArray(out.body?.items) ? (out.body!.items as unknown[])[0] : undefined;
      if (isRecord(item) && typeof item.updatedAt === "string") {
        store.applyProfile(item, state(userId).profile);
        report.down.profile = true;
        const ack = await call("mirror/ack", { section: "profile", upto: item.updatedAt.slice(0, 40) });
        if (ack === "stop" || ack === "stale") return "stop";
        // the server now holds what the phone made: that is the record of what the server has; the owner's own edit here, if there is one, goes on top at the next send (its fingerprint differs)
        const words: Omit<ProfileWords, "fp"> = { ...(typeof item.name === "string" ? { name: item.name } : {}), ...(typeof item.character === "string" ? { character: item.character } : {}), ...(typeof item.style === "string" ? { style: item.style } : {}), ...(typeof item.language === "string" ? { language: item.language } : {}), ...(typeof item.timeZone === "string" ? { timeZone: item.timeZone } : {}) };
        const s2 = state(userId);
        save(userId, { ...s2, profileRefusedFp: null, profile: { fp: profileFp({ name: words.name ?? "", character: words.character ?? null, style: words.style ?? null, language: words.language ?? "en", timeZone: words.timeZone ?? null }), ...words } });
      }
    }
    // 3. facts (cards): a card whose id or words were just stamped as gone is not written
    cursor = undefined;
    let refusedCards = 0; let refusedWhy: SkipWord | null = null; let factsDone = false;
    for (let page = 0; page < 50 && budget(); page += 1) {
      const out = await call("mirror/pull", { section: "facts", ...(cursor ? { cursor } : {}), limit: MIRROR_LIMITS.pull });
      if (out === "stop" || out === "stale") return "stop";
      const items = Array.isArray(out.body?.items) ? out.body!.items as unknown[] : [];
      const ackIds: string[] = [];
      let s = state(userId);
      for (const raw of items) {
        const parsed = cardWriteOf(raw);
        if (!parsed.ok) { report.down.rejected += 1; refusedCards += 1; refusedWhy = parsed.why; continue; }     // not acked: the server keeps it (closed word counted, never cut); audit D8: and counted in the state
        const w = parsed.write;
        if (goneIds.has(w.serverId) || (w.fp && goneFps.has(w.fp))) { ackIds.push(w.serverId); continue; }   // the stamp came first: the card is told "taken" so it stops being offered, and nothing is written
        const out2 = store.writeCard(w);
        if (out2.result === "rejected" && out2.why === "forgotten_here") {
          // the owner forgot these words on this computer: the card is told "taken" (it stops being offered) and the next send tells the server it is gone
          s = { ...s, rows: { ...s.rows, [`srv:${w.serverId}`]: `${w.fp ?? ""}@${w.serverId}` } }; ackIds.push(w.serverId); report.down.rejected += 1; continue;
        }
        if (out2.result === "rejected") { report.down.rejected += 1; refusedCards += 1; refusedWhy = out2.why === "secret_like" ? "secret_like" : "write_failed"; continue; }
        if (out2.result === "written") report.down.cards += 1;
        if (out2.localId) {
          s = { ...s, rows: { ...s.rows, [out2.localId]: out2.own ? (w.fp ?? "") : `${w.fp ?? ""}@${w.serverId}` } };
          for (const ref of w.replaces) { try { store.supersede(out2.localId, ref); } catch { /* the new line stands; the older one stays visible */ } }
        }
        ackIds.push(w.serverId);
      }
      save(userId, s);
      if (ackIds.length) { const ack = await call("mirror/ack", { section: "facts", ids: ackIds.slice(0, 100), homeRev: store.homeRev() }); if (ack === "stop" || ack === "stale") return "stop"; }
      const next = out.body?.next;
      if (typeof next !== "string" || !next) { factsDone = true; break; } cursor = next;
      if (page === 49) report.more = true;
    }
    if (factsDone) noteSkipped(userId, { cards: refusedCards, ...(refusedWhy ? { last: refusedWhy } : {}) });   // what a COMPLETE take of the cards found refused (it falls back to 0 once the cause is gone)
    // 4. messages: the words the server wrote while this computer was off
    cursor = undefined; let lastSeq = 0; let unacked = 0; let holdAck = false;
    for (let page = 0; page < 60 && budget(); page += 1) {
      const out = await call("mirror/pull", { section: "messages", ...(cursor ? { cursor } : {}), limit: MIRROR_LIMITS.pull });
      if (out === "stop" || out === "stale") return "stop";
      const items = Array.isArray(out.body?.items) ? out.body!.items as unknown[] : [];
      if (items.length) {
        // VD: a bubble's files are written down (jobs on disk) BEFORE its messages are acknowledged - the server does not offer them again after the acknowledgement. Not written = not acknowledged: the same bubbles come at the next signal.
        if (ports.files) { let filed = true; try { filed = ports.files.plan(userId, items).ok; } catch { filed = false; } if (!filed) { report.code = "files_not_saved"; return "stop"; } }
        const took = store.importMessages(items);
        report.down.messages += typeof took === "number" ? took : took.inserted;
        if (typeof took !== "number") {
          if (took.dropped > 0) noteSkipped(userId, { words: took.dropped, ...(took.why ? { last: took.why } : {}) });   // audit D4/D8: words that are not words are set aside and COUNTED; the acknowledgement still goes (one number, the server does not give them again)
          if (!took.linked) { holdAck = true; noteSkipped(userId, { last: "words_not_linked" }); }   // audit D2: stored, but not linked to their turn: this take does not acknowledge them, the server gives them again and they are linked then
        }
        for (const it of items) if (isRecord(it) && Number.isSafeInteger(it.seq)) lastSeq = Math.max(lastSeq, it.seq as number); unacked += items.length; }
      const next = out.body?.next;
      const held = out.body?.held === true;
      if (typeof next === "string" && /^\d{1,12}$/.test(next)) lastSeq = Math.max(lastSeq, held ? lastSeq : Number(next));
      if (unacked >= 500 || typeof next !== "string" || !next || held) {
        if (lastSeq > 0 && unacked > 0) { if (!holdAck) { const ack = await call("mirror/ack", { section: "messages", upto: lastSeq }); if (ack === "stop" || ack === "stale") return "stop"; } unacked = 0; }
      }
      if (held || typeof next !== "string" || !next) break; cursor = next;
      if (page === 59) report.more = true;
    }
    if (unacked > 0 && lastSeq > 0 && budget() && !holdAck) { const ack = await call("mirror/ack", { section: "messages", upto: lastSeq }); if (ack === "stop" || ack === "stale") return "stop"; }
    if (holdAck) { report.code = "words_not_linked"; const s3 = state(userId); if (s3.behindSince === null) save(userId, { ...s3, behindSince: ports.now() }); }
    return "ok";
  }

  // ───────────────────────── send ─────────────────────────
  interface Pending { gone: Array<{ local: string; wire: { id: string; why: "forgotten" | "replaced"; fp?: string; turnId?: string; turnIds?: string[] } }>; rows: Array<{ local: string; wire: WireRow; fp: string }>; refusedNow: Array<[string, string]> }

  function diff(s: MirrorState, store: MirrorStorePort): { pending: Pending; mark: string; liveIds: Set<string> } {
    const mark = store.rowsMark();
    const pending: Pending = { gone: [], rows: [], refusedNow: [] };
    const live = store.liveRows();
    const liveIds = new Set(live.map((r) => r.id));
    for (const [local, value] of Object.entries(s.rows)) {
      if (liveIds.has(local)) continue;
      const fate = store.rowFate(local);
      const fp = rowFp(value);
      // TH-web 2: a forgotten line names every turn it came from (up to 32; one turn also goes as the old single `turnId`, so an older server forgets it too); a list with one bad id is not sent at all.
      let turns: string[] = [];
      if (fate === "forgotten") {
        if (store.rowTurns) { try { turns = store.rowTurns(local).filter((t, i, all) => typeof t === "string" && ID_RE.test(t) && all.indexOf(t) === i).slice(0, 32); } catch { turns = []; } }
        else { const one = store.rowTurn ? store.rowTurn(local) : null; if (one && ID_RE.test(one)) turns = [one]; }
      }
      pending.gone.push({ local, wire: { id: rowWire(local, value), why: fate, ...(fate === "forgotten" && /^[a-f0-9]{32}$/.test(fp) ? { fp } : {}), ...(turns.length ? { turnId: turns[0] } : {}), ...(turns.length > 1 ? { turnIds: turns } : {}) } });
    }
    const nowIso = new Date(ports.now()).toISOString();
    for (const row of live) {
      if (s.rows[row.id] !== undefined) continue;
      const refused = s.refused[row.id];
      // a `capacity` refusal is asked again once per run of the app, and when this run's own deletions may have made room; every other refusal word is final for that line
      if (refused && !(refused === "capacity" && (!capacityAsked || pending.gone.length > 0))) continue;
      const built = wireRowOf(row, nowIso);
      if (!built.ok) { pending.refusedNow.push([row.id, built.why]); continue; }
      const value = row.serverCard ? `${built.fp}@${row.serverCard}` : built.fp;
      pending.rows.push({ local: row.id, wire: built.row, fp: value });
    }
    // a line that was refused and is no longer live is forgotten from the refusals (bounded)
    return { pending, mark, liveIds };
  }

  async function sendAll(userId: string, store: MirrorStorePort, call: Call, report: RunReport, budget: () => boolean): Promise<"ok" | "stop"> {
    let s = state(userId);
    const mine = store.profile();
    const profile = mine ? profileOf(mine, s) : null;
    const profileDue = !!profile && profile.fp !== s.profile?.fp && profile.fp !== s.profileRefusedFp;
    const mark = store.rowsMark();
    const rowsSettled = s.settledMark === mark && !capacityNeedsAsk(s) && s.held.length === 0;   // a line the server held is asked again at every run (TH+MT): the mark alone does not settle it
    let pending: Pending = { gone: [], rows: [], refusedNow: [] };
    if (!rowsSettled) {
      const d = diff(s, store); pending = d.pending;
      // audit D7: a held id whose line is gone (forgotten or replaced here) is dropped at once, so `rowsSettled` can be true again; the list is bounded
      const alive = s.held.filter((id) => d.liveIds.has(id)).slice(0, HELD_MAX);
      if (alive.length !== s.held.length) { s = { ...s, held: alive }; save(userId, s); }
    }
    if (pending.refusedNow.length) {
      const refused = { ...s.refused }; for (const [id, why] of pending.refusedNow) refused[id] = why;
      s = { ...s, refused: capRefused(refused, store) }; save(userId, s); report.up.refused += pending.refusedNow.length;
    }
    const resting = store.resting();
    const msgs = resting ? store.messages({ at: s.msgAt, ids: s.msgIds }, MIRROR_LIMITS.messages * 20, s.msgAt === null ? "newest-kept" : "start") : [];
    if (!pending.gone.length && !pending.rows.length && !profileDue && !msgs.length) {
      if (!rowsSettled || s.settledMark !== mark) save(userId, { ...s, settledMark: mark });
      return "ok";
    }
    // pack the work in the contract's order: gone -> rows -> profile -> messages, across as many bodies as the limits need
    type Body = { gone: Pending["gone"]; rows: Pending["rows"]; profile: boolean; messages: MirrorMessage[]; bytes: number };
    const bodies: Body[] = [];
    let cur: Body = { gone: [], rows: [], profile: false, messages: [], bytes: 0 };
    const open = (): void => { bodies.push(cur); cur = { gone: [], rows: [], profile: false, messages: [], bytes: 0 }; };
    const fits = (add: number): boolean => cur.bytes + add < MIRROR_LIMITS.bodyBytes;
    const size = (v: unknown): number => Buffer.byteLength(JSON.stringify(v)) + 2;
    const phase = (): number => (cur.messages.length ? 3 : cur.profile ? 2 : cur.rows.length ? 1 : 0);
    for (const g of pending.gone) { const b = size(g.wire); if (cur.gone.length >= MIRROR_LIMITS.gone || !fits(b)) open(); cur.gone.push(g); cur.bytes += b; }
    for (const r of pending.rows) { const b = size(r.wire); if (cur.rows.length >= MIRROR_LIMITS.rows || !fits(b) || phase() > 1) open(); cur.rows.push(r); cur.bytes += b; }
    if (profileDue) { if (phase() > 2) open(); cur.profile = true; cur.bytes += size(profile!.wire); }
    for (const m of msgs) {
      if (m.skip) continue;
      const wireM = { id: m.wire, turnId: m.turnId, n: m.n, role: m.role, text: m.text, saidAt: m.saidAt, ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}) };
      const b = size(wireM);
      if (cur.messages.length >= MIRROR_LIMITS.messages || !fits(b)) open();
      cur.messages.push(m); cur.bytes += b;
    }
    if (cur.gone.length || cur.rows.length || cur.profile || cur.messages.length) open();
    // words that cannot be sent (too long, too many bubbles) are skipped over by the cursor and counted; they stay here
    const skipped = msgs.filter((m) => m.skip);
    let sawCapacity = false;
    let completed = true; let budgetEnded = false;
    for (const body of bodies) {
      if (!budget()) { report.more = true; completed = false; budgetEnded = true; break; }
      const fields: Record<string, unknown> = {
        ...(body.gone.length ? { gone: body.gone.map((g) => g.wire) } : {}),
        ...(body.rows.length ? { rows: body.rows.map((r) => r.wire) } : {}),
        ...(body.profile ? { profile: profile!.wire } : {}),
        ...(body.messages.length ? { messages: body.messages.map((m) => ({ id: m.wire, turnId: m.turnId, n: m.n, role: m.role, text: m.text, saidAt: m.saidAt, ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}) })) } : {}),
      };
      const out = await call("mirror", fields);
      if (out === "stop" || out === "stale") { completed = false; break; }
      const a = out.body ?? {};
      // DD: the server names the revision of the person's connected apps in its answer (read by name only; an older server sends none).
      try { ports.apps?.seen(a.appsRev); } catch { /* a hint never changes the upload */ }
      s = state(userId);
      // gone
      if (body.gone.length) {
        const done = isRecord(a.gone) ? Number(a.gone.done) : NaN;
        if (done === body.gone.length) { const rows = { ...s.rows }; for (const g of body.gone) delete rows[g.local]; s = { ...s, rows }; report.up.gone += body.gone.length; }
      }
      // rows
      if (body.rows.length) {
        const refusedList = isRecord(a.rows) && Array.isArray(a.rows.refused) ? a.rows.refused as unknown[] : [];
        const refusedBy = new Map<string, string>();
        for (const r of refusedList) if (isRecord(r) && typeof r.id === "string" && typeof r.why === "string") refusedBy.set(r.id, r.why);
        const done = isRecord(a.rows) ? Number(a.rows.done) : NaN;
        if (done === body.rows.length - refusedBy.size) {
          const rows = { ...s.rows }; const refused = { ...s.refused }; let held = new Set(s.held);
          for (const r of body.rows) {
            const why = refusedBy.get(r.wire.id);
            if (!why) { rows[r.local] = r.fp; delete refused[r.local]; held.delete(r.local); report.up.rows += 1; continue; }
            // TH+MT: `held` = the server holds a forget of this line made by a place that is not trusted, until the person answers. The line is NOT deleted and NOT refused for good: it is kept in `held` and asked again at the next run
            // (a confirmation that rejects the forget returns its id in `reupload`, which is also sent at once by `confirm`; an accepted forget comes down as a `gone` stamp). Not counted as a refusal.
            if (why === "held") { held.add(r.local); report.up.held = (report.up.held ?? 0) + 1; continue; }
            report.up.refused += 1;
            if (why === "gone") { held.delete(r.local); try { store.forgetMatching({ homeId: r.wire.id }); } catch { /* a line that is not here any more */ } continue; }   // the server's marker says it was forgotten: this computer forgets it too
            if (why === "capacity") sawCapacity = true;
            held.delete(r.local);
            refused[r.local] = ["secret_like", "bad_row", "conflict", "capacity", "forgotten_turn"].includes(why) ? why : "refused";
          }
          const live = new Set(store.liveRows().map((r) => r.id));
          s = { ...s, rows, refused: capRefused(refused, store), held: [...held].filter((id) => live.has(id)).slice(0, HELD_MAX) };
        }   // an answer that does not add up is not believed: nothing is marked sent, the same body is sent again (idempotent)
      }
      // profile
      if (body.profile) {
        const p = a.profile;
        if (p === "applied" || p === "same") { s = { ...s, profile: { fp: profile!.fp, ...profile!.words }, profileRefusedFp: null }; report.up.profile = true; }
        else if (p === "pending") needPull = true;               // the phone changed it first: the next run takes it, then this computer's edit goes on top
        else if (p === "invalid") s = { ...s, profileRefusedFp: profile!.fp };
        else if (p === "held") { /* MT: a profile change a place that is not trusted made is held on the server: this computer's own profile is not refused and not marked sent - it goes again at the next run (no state change) */ report.up.held = (report.up.held ?? 0) + 1; }
      }
      // messages
      if (body.messages.length) {
        const m = isRecord(a.messages) ? a.messages : {};
        const refused = Array.isArray(m.refused) ? m.refused as unknown[] : [];
        const refusedIds = new Set(refused.filter(isRecord).map((r) => String(r.id)));
        const done = Number(m.done);
        if (done === body.messages.length - refusedIds.size) {
          const last = body.messages[body.messages.length - 1];
          s = advanceCursor(s, body.messages, last);
          report.up.messages += body.messages.length - refusedIds.size;
          // a refusal word of a message is final (bad_row, forgotten_turn, conflict): the cursor passes it and the word stays on this computer
        } else { save(userId, s); report.code = "answer_mismatch"; completed = false; break; }   // never pass the cursor over words that were not confirmed
      }
      save(userId, s);
    }
    if (sawCapacity) capacityAsked = true;   // no second try before the app is started again (or a deletion makes room): the computer keeps the line, the server is not asked in a loop
    if (completed) {
      // every body is answered: the skipped words are passed by the cursor (the last message in the batch sets it)
      if (skipped.length && msgs.length) {
        const lastAll = msgs[msgs.length - 1];
        s = state(userId);
        if (lastAll.at >= (s.msgAt ?? "")) s = advanceCursor(s, msgs, lastAll);
      }
      s = state(userId);
      if (msgs.length === MIRROR_LIMITS.messages * 20) report.more = true;
      // the mark is settled only when nothing is waiting for a later run (capacity refusals do not hold it: they are asked again on a new start)
      save(userId, { ...s, settledMark: store.rowsMark() === mark ? mark : null });
      return "ok";
    }
    return budgetEnded ? "ok" : "stop";
  }

  const capacityNeedsAsk = (s: MirrorState): boolean => !capacityAsked && Object.values(s.refused).includes("capacity");
  function capRefused(refused: Record<string, string>, store: MirrorStorePort): Record<string, string> {
    const ids = Object.keys(refused);
    if (ids.length <= MIRROR_LIMITS.refusedMax) return refused;
    const live = new Set(store.liveRows().map((r) => r.id));
    const kept: Record<string, string> = {};
    for (const id of ids) if (live.has(id)) kept[id] = refused[id];
    return kept;
  }
  function advanceCursor(s: MirrorState, batch: MirrorMessage[], upTo: MirrorMessage): MirrorState {
    const at = upTo.at;
    const sameInstant = batch.filter((m) => m.at === at).map((m) => m.id);
    const ids = s.msgAt === at ? [...new Set([...s.msgIds, ...sameInstant])].slice(-400) : sameInstant.slice(-400);
    return { ...s, msgAt: at, msgIds: ids };
  }

  // ───────────────────────── profile ─────────────────────────
  const STAND_IN_CHARACTER = "orange-dino";   // = server-import.ts DEFAULT_AVATAR_ICON without `character:` (a gate holds them equal); in the server's COMPANION_CHARACTERS
  const STAND_IN_STYLE = "polite";            // in the server's COMPANION_STYLES; the only one of the four that is polite in Korean
  const profileFp = (p: LocalProfile): string => sha(JSON.stringify([p.name, p.character, p.style, p.language, p.timeZone])).toString("hex").slice(0, 16);
  /**
   * The profile as the server's closed words: the character and the style the owner chose here when they are in the server's tables, else the last the server held (a phone's choice is not overwritten by a photo or a free-text style here),
   * else (PR-D1, contracts/phone-reach-roads.md R2) the stand-in of the table: the product's own face and the one polite style. A computer that is the home always gives the server a profile, so the server can answer for it while it is
   * not reached; a stand-in goes UP only: the pull never writes it back as the owner's choice (home-mirror-real.ts `planPhoneProfile`, `same`). A name that is empty = nothing is sent (the profile's name is never empty: 1..64 characters).
   */
  function profileOf(p: LocalProfile, s: MirrorState): { fp: string; wire: Record<string, unknown>; words: Omit<ProfileWords, "fp"> } | null {
    const character = p.character ?? s.profile?.character ?? STAND_IN_CHARACTER;
    const style = p.style ?? s.profile?.style ?? STAND_IN_STYLE;
    if (!p.name.trim()) return null;
    const wire: Record<string, unknown> = { name: p.name, character, style, language: p.language, ...(p.timeZone ? { timeZone: p.timeZone } : {}) };
    return { fp: profileFp({ ...p, character, style }), wire, words: { name: p.name, character, style, language: p.language, ...(p.timeZone ? { timeZone: p.timeZone } : {}) } };
  }

  // ───────────────────────── entry points ─────────────────────────
  /**
   * E2E-2: WHY a signal did not upload (a skipped run: signed out, switch off, no pointer, not the home, held, backoff; or a run that ended with a closed failure word), as ONE closed word on ONE trace line, written
   * only when the word changes (and once more when a run goes through clean). The desktop used to leave nothing: a turn ended, no upload followed, and nothing said which rule stood in the way. In memory only: no
   * stored column, no status field (the screens' `status()` shape is unchanged); the line is the diagnostic place the other roads use (companion-take-roads.ts). Never a word of a line: the report's own closed words.
   */
  let lastSkipWord: string | null = null;
  function noteSkip(report: RunReport): void {
    const raw = report.ran ? (report.code ? `failed:${report.code}` : null) : (report.skipped ?? null);
    const word = raw === null ? null : /^[a-z0-9_:]{1,64}$/.test(raw) ? raw : "other";
    if (word === lastSkipWord) return;
    lastSkipWord = word;
    try { console.info(word === null ? "[one-home-mirror] upload ran" : `[one-home-mirror] upload skipped: ${word}`); } catch { /* a trace line never changes its sender */ }
  }
  function signal(kind: MirrorSignal): Promise<RunReport> {
    payResidue();   // audit D1: a debt left by a busy file is asked again at every signal (no timer; nothing is read once it is paid)
    const userId = ports.userId();
    if (!userId || !ports.switchOn()) { const early = { ...emptyReport(), skipped: !userId ? "signed_out" : "switch_off" }; noteSkip(early); return Promise.resolve(early); }
    const pull = kind === "start" || kind === "home";
    // DD: the connected apps' own signal (one list request at most, never a wait): start and home read the list, turn reads the long jobs.
    try { ports.apps?.signal(kind); } catch { /* a signal never changes its sender */ }
    if (running) { again = { pull: (again?.pull ?? false) || pull }; return running; }
    const flight = (async () => {
      let report = await runOnce(userId, pull);
      noteSkip(report);
      // a signal that arrived during the run is served once more, not once per signal
      while (again) {
        const next = again; again = null;
        if (!report.ran || report.code) break;     // nothing ran, or the run failed: the failure's own rule (backoff, hold) decides, not a second try at once
        report = await runOnce(userId, next.pull);
        noteSkip(report);
      }
      // VD: the files of the bubbles taken (and any still waiting) are taken in their own flight, so a long file never holds the next upload of a memory line. A run that did not start (switch off, not the home,
      // backoff) takes no file: `ran` is the same gate as for every other request of this file.
      if (report.ran) { const files = ports.files; if (files) void files.drain(userId).catch(() => undefined); }
      return report;
    })().finally(() => { running = null; });
    running = flight;
    return flight;
  }
  // ───────────────────────── TH: one more take of a move ─────────────────────────
  /**
   * The ordinary take of the mirror (gone, profile, facts, messages with no cursor, acknowledgements) and nothing else, for a server-start move that has imported (contracts/one-home-move.md 16.1 `caughtUp`). It waits for a run in flight,
   * runs under the move's standing (the record still carries the move) and the move's own backoff, and answers `ok` or the mirror's closed word. Switch off = `ok` (nothing can be taken here; the new epoch takes everything at the first signal).
   */
  async function catchUp(): Promise<{ ok: boolean; code?: string }> {
    const userId = ports.userId();
    if (!userId || !ports.switchOn()) return { ok: true };
    while (running) { try { await running; } catch { /* the run's own result is not ours */ } }
    // audit D6: a hold that waits for the pointer to change is lifted by the change itself (`holdKey` is compared with the key of the pointer as it is NOW). No read is made here: every pass of the move is already preceded by a pointer read
    // (`home.ts` refresh -> drive, and the move's one deadline timer -> refresh -> drive), so a second read would be dead code (shown by the gate: the hold lifts with no read of its own, scripts test-thmt2-desktop-move D6b).
    payResidue();
    const flight = runOnce(userId, true, true).finally(() => { if (running === flight) running = null; });
    running = flight;
    const report = await flight;
    if (report.ran && !report.code) return { ok: true };
    return { ok: false, code: String(report.code ?? report.skipped ?? "failed").replace(/[^a-z0-9_]/g, "_").slice(0, 48) || "failed" };
  }

  // ───────────────────────── MT: the owner's list and answer ─────────────────────────
  type Standing2 = { ok: true; epoch: number } | { ok: false; code: string };
  function standingForOwner(): Standing2 {
    if (!ports.userId()) return { ok: false, code: "sign_in_required" };
    if (!ports.switchOn()) return { ok: false, code: "switch_off" };
    const st = ports.standing();
    return st.ok ? { ok: true, epoch: st.epoch } : { ok: false, code: String(st.why).replace(/[^a-z0-9_]/g, "_").slice(0, 48) };
  }
  /** One signed call with the epoch; after `stale_epoch` the pointer is read and the same call made once more. */
  async function ownerCall(route: "mirror/pull" | "mirror/confirm", fields: Record<string, unknown>): Promise<CallAnswer | { code: string }> {
    let st = standingForOwner(); if (!st.ok) return { code: st.code };
    let out = await ports.call(route, { epoch: st.epoch, ...fields });
    if (!out.ok && out.code === "stale_epoch") {
      await ports.refreshPointer();
      st = standingForOwner(); if (!st.ok) return { code: st.code };
      out = await ports.call(route, { epoch: st.epoch, ...fields });
    }
    return out;
  }
  /** The list of what waits for the owner, read from the server now (read-only; nothing is stored). Text-only items. */
  async function waitingList(): Promise<WaitingList | { ok: false; code: string }> {
    const out = await ownerCall("mirror/pull", { section: "waiting", limit: MIRROR_LIMITS.pull });
    if (!("ok" in out)) return { ok: false, code: out.code };
    if (!out.ok) return { ok: false, code: out.code ?? (out.unreachable ? "server_unreachable" : "failed") };
    const items = waitingItemsOf(out.body?.items);
    const total = Number.isSafeInteger(Number(out.body?.total)) ? Number(out.body?.total) : items.length;
    waiting = Math.max(0, total);
    cutKeys = new Set(items.filter((i) => (i.t === "words" || i.t === "forget") && i.cut === true).map((i) => (i.t === "words" ? `turns:${i.turnId}` : `gone:${(i as { id: string }).id}`)));
    readKeys = new Set([...readKeys].filter((k) => cutKeys.has(k)));
    return { ok: true, textOnly: true, items, total };
  }
  /**
   * Audit D10: the WHOLE text of one item the list showed cut (`cut: true`). Only such an item can be asked for (an older server answers `item` with 400 and never says `cut`, so "no `cut` = no `item`" is all the compatibility there is). The text is the other side's words:
   * plain text for the owner's window (`textOnly`), never stored (memory holds the id of an item read, nothing else), never logged. A read marks the item as read: only then can it be accepted.
   */
  async function waitingItem(list: "turns" | "gone", id: string): Promise<{ ok: true; textOnly: true; item: WaitingItem } | { ok: false; code: string }> {
    if (typeof id !== "string" || !ID_RE.test(id) || !cutKeys.has(`${list}:${id}`)) return { ok: false, code: "not_cut" };
    const out = await ownerCall("mirror/pull", { section: "waiting", item: id, limit: 1 });
    if (!("ok" in out)) return { ok: false, code: out.code };
    if (!out.ok) return { ok: false, code: out.code ?? (out.unreachable ? "server_unreachable" : "failed") };
    const found = waitingItemsOf(out.body?.items, FULL_TEXT_MAX).find((i) => (i.t === "words" ? i.turnId === id && list === "turns" : i.t === "forget" && i.id === id && list === "gone"));
    if (!found) return { ok: false, code: "not_waiting" };
    readKeys.add(`${list}:${id}`);
    return { ok: true, textOnly: true, item: found };
  }
  /**
   * Audit D10, the rule of the accept (also the server's: a cut text is answered on its own): what of a selection can be accepted now. An item the server said it cut that was not read whole is left out (`apart`); more than one turn in one answer leaves
   * out every cut one (the server does the same). The ones that stay and were cut are read whole here, so the owner's confirmation window shows the whole text before the yes (`full`). A reject needs no reading (nothing is let in by it).
   */
  async function planAccept(selection: WaitingSelection): Promise<{ ok: true; selection: WaitingSelection; apart: number; full: WaitingItem[] } | { ok: false; code: string }> {
    const next: WaitingSelection = { ...selection }; let apart = 0; const full: WaitingItem[] = [];
    for (const list of ["gone", "turns"] as const) {
      const ids = selection[list]; if (!ids) continue;
      const single = list === "turns" ? ids.length === 1 : true;
      const keep: string[] = [];
      for (const id of ids) {
        if (!cutKeys.has(`${list}:${id}`)) { keep.push(id); continue; }
        if (!single) { apart += 1; continue; }
        const got = await waitingItem(list, id);
        if (!got.ok) return { ok: false, code: got.code };
        full.push(got.item); keep.push(id);
      }
      if (keep.length) next[list] = keep; else delete next[list];
    }
    if (!(next.facts || next.gone || next.turns || next.profile)) return { ok: false, code: "read_one_by_one" };
    return { ok: true, selection: next, apart, full };
  }
  /**
   * The owner's answer about what waits: `accept` ("it was me") or `reject` ("it was not me"). A signed call by the home key (`mirror/confirm`). MT-web 2: a held forget of a card the server KEPT is put back by the server itself on a reject (same id, words and
   * grade; the next take offers it and this computer's own line is "already"); the answer's `reupload` then lists only the lines of THIS computer that an older marker covered with nothing kept: they are marked "not on the server" and sent at once. An accepted forget comes down as a `gone`
   * stamp at the next take (run now). Every id is idempotent: the same answer twice is the same.
   */
  async function confirmWaiting(decision: WaitingDecision, selection: WaitingSelection): Promise<{ ok: true; done: { facts: number; gone: number; turns: number; profile: number; apart?: number; newer?: number }; reupload: number } | { ok: false; code: string }> {
    const userId = ports.userId();
    let sel = cleanSelection(selection);
    if (!userId || !sel || (decision !== "accept" && decision !== "reject")) return { ok: false, code: "invalid_args" };
    // audit D10, Main's own rule: whatever the caller says, a cut item that was not read whole (or that is not alone) is not carried by an accept
    let apartHere = 0;
    if (decision === "accept") {
      const next: WaitingSelection = { ...sel };
      for (const list of ["gone", "turns"] as const) {
        const ids = sel[list]; if (!ids) continue;
        const keep = ids.filter((id) => !cutKeys.has(`${list}:${id}`) || (readKeys.has(`${list}:${id}`) && (list !== "turns" || ids.length === 1)));
        apartHere += ids.length - keep.length;
        if (keep.length) next[list] = keep; else delete next[list];
      }
      sel = cleanSelection(next);
      if (!sel) return { ok: false, code: "read_one_by_one" };
    }
    const out = await ownerCall("mirror/confirm", { [decision]: sel });
    if (!("ok" in out)) return { ok: false, code: out.code };
    if (!out.ok) return { ok: false, code: out.code ?? (out.unreachable ? "server_unreachable" : "failed") };
    const b = out.body ?? {};
    const d = isRecord(b.done) ? b.done : {};
    const n = (v: unknown): number => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Math.min(Number(v), SELECTION_MAX) : 0);
    // MT-web 3: `apart` = cut words the server left waiting (more than one turn in one answer), `newer` = a refused forget that was not undone because a newer trusted card says the same: closed numbers, when there are any (the words are for the screen's own work)
    const done = { facts: n(d.facts), gone: n(d.gone), turns: n(d.turns), profile: n(d.profile), ...(n(d.apart) + apartHere > 0 ? { apart: n(d.apart) + apartHere } : {}), ...(n(d.newer) > 0 ? { newer: n(d.newer) } : {}) };
    waiting = Math.max(0, waiting - (done.facts + done.gone + done.turns + done.profile));
    let again = 0;
    const store = ports.store();
    const wires = Array.isArray(b.reupload) ? (b.reupload as unknown[]).filter((x): x is string => typeof x === "string" && ID_RE.test(x)).slice(0, SELECTION_MAX) : [];
    if (store && wires.length) {
      const want = new Set(wires);
      let s = state(userId);
      const rows = { ...s.rows }; const refused = { ...s.refused }; const held = new Set(s.held);
      for (const row of store.liveRows()) {
        const wire = row.serverCard ? `${SERVER_FACT_PREFIX}${row.serverCard}` : wireId(row.id);
        if (!want.has(wire)) continue;
        delete rows[row.id]; delete refused[row.id]; held.delete(row.id); again += 1;
      }
      if (again) { s = { ...s, rows, refused, held: [...held].slice(0, HELD_MAX), settledMark: null }; save(userId, s); }
    }
    // the take (an accepted forget is now a stamp; an accepted line is now offered) and the send (the lines to put again) - one ordinary run, no cursor, no extra request kind
    if (done.facts + done.gone + done.turns + done.profile > 0 || again > 0) { needPull = true; void signal("memory").catch(() => undefined); }
    return { ok: true, done, reupload: again };
  }

  return {
    signal, catchUp, waitingList, waitingItem, planAccept, confirmWaiting,
    /** For a gate: wait for the run in flight. */
    idle: async (): Promise<void> => { while (running) { try { await running; } catch { /* ignore */ } } },
    status: (): MirrorStatus => {
      const userId = ports.userId();
      const behind = userId ? state(userId).behindSince : null;
      const k = userId ? state(userId).skipped : zeroSkipped();
      const held = userId ? state(userId).profile : null;
      return { stale: behind !== null && ports.now() - behind >= STALE_AFTER_MS, behindSince: behind, profile: held ? "up" : "none", holding: holdKey === null ? null : holdCode, waiting, skipped: { words: k.words, cards: k.cards, held: k.held, last: k.last } };
    },
    /** An account slot is forgotten, or another account signs in: what was kept for it goes, and the memory resets. */
    forget: (userId: string): void => { try { ports.files?.forgetAccount(userId); } catch { /* none */ } try { ports.clearState(userId); } catch { /* none */ } cached = null; cachedUser = null; needPull = true; holdKey = null; holdCode = null; failures = 0; nextTryAt = 0; capacityAsked = false; waiting = 0; cutKeys = new Set(); readKeys = new Set(); },
    /** Memory only: the account changed or the app signed out. */
    reset: (): void => { cached = null; cachedUser = null; needPull = true; holdKey = null; holdCode = null; failures = 0; nextTryAt = 0; capacityAsked = false; waiting = 0; cutKeys = new Set(); readKeys = new Set(); },
    /** A gate's view of the memory (never read by product code). */
    _peek: () => ({ failures, nextTryAt, holdKey, holdCode, needPull, capacityAsked, running: running !== null }),
  };
}
export type HomeMirror = ReturnType<typeof createHomeMirror>;
