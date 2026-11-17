/*
 * The desktop's half of the person's SHARED MEMORY. One personal agent per place, one set of lines about the PERSON that
 * every place reads and adds to: the Personal lines whose kind is `fact`, `identity` or `boundary` (a `preference` - how THIS agent answers - stays on this desktop). The conversation is not shared.
 *
 * The state of a line is a row of `memory_shared_ids` (memory/shared-ids.ts), read here through the store port and nowhere else:
 *   S shared (a cache of a card the server holds, with its `sid`) · L this place only (final: the set had no room, or refused it) · P waiting (a live shared-kind line with NO row - computed, so no way of writing a line can miss it)
 *   · F the person forgot it here and the server has not been told yet.
 * What the transitions are, each one safe to apply again:
 *   P -> S   put ok / same        P -> L   full / refused        P -> forgotten (the server says the words were forgotten and nobody said them again)
 *   S -> out the server let the card go (replaced / room): the line is retired here with NO stamp and NO notice (a notice is the place that said the new line's, once)
 *   S -> F   the person forgot the line here         F -> (gone)  the forget reached the server       S + said: the person said the same words again here (the server's "said at" moves up)
 *   in       a card the server holds that has no row here: written as a line (or adopted by an existing line with the same words), row S
 * ONE RUN = PUSH FIRST, PULL AFTER (the very first run reads first: it holds no card yet, so nothing can be erased). No timer, no polling. Triggers: a Personal line was written / replaced / forgotten (this process or another),
 * the one plural read's answer (it carries `sharedOpen` and `sharedSeq`). Until the server says `sharedOpen` NO request is made at all and nothing here changes (I11); a 404 is one request and then silence until the next answer.
 * Failures mend themselves: a connection error, a timeout, a 5xx or a 429 is tried again 0.5 s, 1 s, 2 s, 4 s, 8 s (the server's retry-after first); only then the run gives up quietly - the work is still in the store.
 * Text from the server is untrusted data: it reaches the memory store through the same writer the old mirror used, never a prompt, a tool result or a log line from this file.
 */
import { FP_RE, ID_RE, WIRE_LIMITS, answerOf, eraOfBody, pullAnswerOf, pushClosed, wordOf, type Boundary, type Card, type PushItem, type SharedKind, type WireRow } from "./shared-memory-wire";
import { factFingerprint } from "../memory/shared-ids";
import type { SharedIdRow } from "../memory/shared-ids";
import { createHash } from "node:crypto";

export { factFingerprint };
export { SHARED_META } from "../memory/shared-ids";
export type { SharedKind, Boundary };

// ───────────────────────── numbers (each with its reason) ─────────────────────────
export const SHARED_LIMITS = Object.freeze({
  ...WIRE_LIMITS,
  /** The retry ladder of the contract (section 4 "재시도", O129): 0.5 s doubling, five tries after the first. */
  retryFirstMs: 500, retries: 5,
  /** The longest a server's own "retry after" is waited for: the top of the same ladder (0.5 s * 2^6). Longer = give up quietly, the next trigger tries again. */
  retryAfterMaxMs: 32_000,
  /** A desktop that has not pulled for this long asks for the whole set again: the same 30 days a replaced card's trail lasts on the server. */
  resetAfterMs: 30 * 86_400_000,
  /** Passes of the push in one run (a `retry` answer): the same five as the ladder. */
  passes: 5,
  /** Pages of one whole-set answer read in one run: 2 MiB a page, 2,000 cards at most in a set (the plan table's largest figure is 10,000: five hundred pages is far above it). */
  pages: 500,
});
export const SHARED_SOURCE_TAG = "hope-server-fact";
const sha = (text: string): Buffer => createHash("sha256").update(text).digest();
const chars = (text: string): number => Array.from(text).length;
/** A local id in the shape the server takes; an id that is not that shape becomes `x_<30 hex of its sha-256>` (deterministic: the same id is the same on every run). */
export function wireId(id: string): string { return ID_RE.test(id) ? id : `x_${sha(id).toString("hex").slice(0, 30)}`; }

/** A Personal line of this desktop, as the store reads it (shared-memory-real.ts). */
export interface PersonalLine {
  id: string;
  /** the two Personal columns */ kind: "preference" | "fact";
  /** the kind the model gave before the desktop folded it (`context_json.ticket_kind`), or null */ ticketKind: "identity" | "boundary" | null;
  /** the structured boundary, or null */ boundary: Boundary | null;
  content: string; native: string | null;
  originClass: string | null; certainty: string | null; createdAt: string;
  /** The line's words rest on the owner's own words (set when it was written; a line without the mark is grounded when its origin is the owner's). */ grounded: boolean;
  /** Can somebody read this line (not a line of the old overlay channel, not switched off by the owner)? A line nobody can read is not sent up as the person's words. */
  readable: boolean;
}
export type RowRefusal = "too_long" | "empty" | "not_shared";

/** Which kind a line is shared as, or null when it is not shared (a `preference`, a `boundary` the model gave without its structure). Computed from columns, never from the words. */
export function sharedKindOf(line: Pick<PersonalLine, "kind" | "ticketKind" | "boundary">): SharedKind | null {
  if (line.ticketKind === "boundary") return line.boundary ? "boundary" : (line.kind === "fact" ? "fact" : null);
  if (line.ticketKind === "identity") return "identity";
  return line.kind === "fact" ? "fact" : null;
}

/** The table of kinds, words and limits. A line that cannot be written within the server's limits is not cut: it is returned as a closed refusal word and stays here. `saidAt` is when the person said it (the line's own time). */
export function wireRowOf(line: PersonalLine, nowIso: string): { ok: true; row: WireRow; fp: string } | { ok: false; why: RowRefusal } {
  const kind = sharedKindOf(line);
  if (kind === null) return { ok: false, why: "not_shared" };
  const native = line.native?.trim() || null;
  const content = line.content.trim();
  let text = native ?? content; let en: string | undefined = native && native !== content ? content : undefined;
  if (!text) return { ok: false, why: "empty" };
  if (chars(text) > SHARED_LIMITS.rowText) {
    // the original is too long for the card: the English line stands in for it when it fits (it is the line this desktop recalls by); else the line stays here
    if (native && content && chars(content) <= SHARED_LIMITS.rowText) { text = content; en = undefined; } else return { ok: false, why: "too_long" };
  }
  if (en !== undefined && chars(en) > SHARED_LIMITS.rowEn) en = undefined;   // the server leaves a long English line out anyway
  const fp = factFingerprint(text);
  if (fp === null) return { ok: false, why: "empty" };
  const claimType = line.originClass === "user" || line.originClass === "observed" || line.originClass === "inferred" ? line.originClass : line.originClass === "result" ? "inferred" : undefined;
  const verification = line.certainty === "self_reported" ? "self_reported" : line.certainty === "unverified" || line.certainty === "run_verified" || line.originClass === "result" ? "unverified" : undefined;
  const made = Date.parse(line.createdAt);
  return {
    ok: true, fp,
    row: { id: wireId(line.id), kind, text, ...(en !== undefined ? { en } : {}), ...(kind === "boundary" && line.boundary ? { boundary: line.boundary } : {}),
      ...(claimType ? { claimType } : {}), ...(verification ? { verification } : {}), saidAt: Number.isFinite(made) ? new Date(made).toISOString() : nowIso, grounded: line.grounded },
  };
}

/** One card of the server -> what to write here (the table the other way round). */
export interface CardWrite {
  sid: string; kind: "preference" | "fact"; ticketKind: "identity" | "boundary" | null; boundary: Boundary | null;
  content: string; native: string | null; originClass: "user" | "observed" | "inferred"; certainty: "self_reported" | "unverified"; fp: string | null; by: string | null;
}
export function cardWriteOf(card: Card): CardWrite {
  // identity -> the fact column, boundary -> the preference column + `ticket_kind` + its structure (the ruleset's fold: one table, here the other way round). The person's words (`text`) are never dropped or replaced; an English line that
  // fits is what this desktop recalls by (`content`, the words kept as `native`).
  return {
    sid: card.sid, kind: card.kind === "boundary" ? "preference" : "fact", ticketKind: card.kind === "identity" || card.kind === "boundary" ? card.kind : null, boundary: card.boundary,
    content: card.en ?? card.text, native: card.en ? card.text : null, originClass: card.claimType, certainty: card.verification, fp: factFingerprint(card.text), by: card.by,
  };
}

// ───────────────────────── ports ─────────────────────────
export interface CallAnswer { ok: boolean; status: number; code?: string; unreachable?: boolean; retryAfterMs?: number; body?: Record<string, unknown> | null }
export interface EvictedNote { count: number; text: string; saidAt: string | null }
export interface SharedStorePort {
  /** Moves whenever a Personal line may have been written, replaced or forgotten (the memory store's revision). */
  rowsMark(): string;
  /** Every live Personal line (both columns), readable or not. */
  liveLines(): PersonalLine[];
  idRows(): Map<string, SharedIdRow>;
  putIdRow(row: Omit<SharedIdRow, "at">): void;
  deleteIdRows(ids: string[]): void;
  /** The store's own small values (cursor, first merge's time, last pull, ...), `null` deletes. */
  readMeta(key: string): string | null;
  writeMeta(key: string, value: string | null): void;
  /** For a line that is no longer live: forgotten (the owner's forget stamp) or replaced (an edit, a merge, a purge). */
  fateOf(id: string): "forgotten" | "replaced";
  /** old (no longer live) local id -> the live line that replaced it (the `supersedes` edge, followed up to a few hops), for the ids that have one. */
  successorsOf(oldIds: string[]): Map<string, string>;
  /**
   * A forget that came from ANOTHER place: the lines of this server card (their row, or the source tag), this local id, and every live shared-kind line (S, P, L; never a `preference`) whose words are the same.
   * The owner's forget path with no fence of a screen and no step of the forget clock (I13). Returns the local ids forgotten; their rows and any pending forget of the same words go.
   */
  remoteForget(match: { localId?: string; sid?: string; fp?: string }): string[];
  /** "Forget everything" came from another place: every live shared-kind line made at or before `beforeIso` (a line written after the answer was asked is the person's newer word and stays). */
  remoteForgetAll(beforeIso: string): string[];
  /** A card of the server -> a line here: `written`, `already` (taken before), `rejected` (the words look like a secret, or the owner forgot them here and has not said them again). */
  writeCard(card: CardWrite): { result: "written" | "already" | "rejected"; localId?: string; why?: string };
  /** The same plain retirement for the lines that carry this card (row or tag) or this local id: no forget stamp, so the same words may come again. Returns the local ids retired. */
  withdrawMatching(match: { localId?: string; sid?: string }): string[];
  /** The place's connection was removed: the lines taken from other places are erased with NO stamp (not the person's forget); the lines said here stay and become L. */
  eraseReceived(): string[];
  /** A line of this place was let go for room (`evicted`): one card in the conversation the line was said in. Never throws. */
  evictedNotice(note: EvictedNote, lineId: string): void;
  /** The first merge succeeded: the old mirror's record of this account (`one_mirror:v1:<user>`, app database) is deleted - from now on the mirror never runs for this account. Never throws. */
  firstMergeDone?(userId: string): void;
  /** The legacy record of the app database (`one_shared_memory:v1:<user>`): its card ids per line, once (then it is deleted). null = none. */
  takeLegacyRows(userId: string): Array<{ localId: string; sid: string }> | null;
}
export interface SharedMemoryPorts {
  now(): number;
  userId(): string | null;
  hostId(): string;
  store(): SharedStorePort | null;
  /** One signed request with the login session. Never throws. */
  call(method: "GET" | "POST", route: string, body?: unknown): Promise<CallAnswer>;
  /** A wait of the retry ladder (a test runs it at once). */
  sleep(ms: number): Promise<void>;
  /** One closed word per change of cause, never a word of a line. */
  log?(line: string): void;
}

export type SharedSignal = "memory" | "start";
export interface RunReport {
  ran: boolean; skipped?: string; calls: number; code?: string;
  up: { put: number; said: number; forget: number; full: number; refused: number; out: number; forgotten: number };
  down: { written: number; adopted: number; out: number; forgotten: number; reset: boolean; cards: number; lost?: boolean; erasedAll?: number };
}
const emptyReport = (): RunReport => ({ ran: false, calls: 0, up: { put: 0, said: 0, forget: 0, full: 0, refused: 0, out: 0, forgotten: 0 }, down: { written: 0, adopted: 0, out: 0, forgotten: 0, reset: false, cards: 0 } });
const KEYS = { cursor: "shared:cursor", mergedAt: "shared:mergedAt", pulledAt: "shared:pulledAt", era: "shared:era" } as const;

export function createSharedMemorySync(ports: SharedMemoryPorts) {
  let running: Promise<RunReport> | null = null;
  let again: { pull: boolean } | null = null;
  let enabled = false;          // no request is made before the server says `sharedOpen` (or this account was merged before)
  let closed = false;           // the shared-memory switch answered 404 (or the place was removed): silence until the next answer
  let stopped = false;
  let lastLine = "";
  let settledMark: string | null = null;   // memory only: the store's mark when the last diff found nothing to send
  const legacyTaken = new Set<string>();
  const say = (line: string): void => { if (line === lastLine) return; lastLine = line; try { ports.log?.(line); } catch { /* a log line never changes the run */ } };
  let runUser: string | null = null;     // the account the running run started for: a request is never made, and an answer never applied, for another one

  // ── one request with the retry ladder ──
  type Verdict = { kind: "ok"; body: Record<string, unknown> } | { kind: "closed" } | { kind: "removed" } | { kind: "refused"; code: string } | { kind: "gave_up"; code: string };
  async function request(report: RunReport, method: "GET" | "POST", route: string, body?: unknown): Promise<Verdict> {
    for (let attempt = 0; ; attempt += 1) {
      if (runUser !== null && ports.userId() !== runUser) return { kind: "gave_up", code: "account_changed" };   // the account changed under a run (a retry ladder lasts minutes): nothing of the old account goes with the new one's cookie
      report.calls += 1;
      const out = await ports.call(method, route, body);
      if (stopped) return { kind: "gave_up", code: "stopped" };
      if (runUser !== null && ports.userId() !== runUser) return { kind: "gave_up", code: "account_changed" };   // and an answer for the old account is not applied to the new one's store
      if (out.ok && out.body && out.body.ok !== false) return { kind: "ok", body: out.body };
      if (out.status === 404) return { kind: "closed" };                     // the switch is closed: nothing, quietly
      if (out.status === 403 && out.code === "place_removed") return { kind: "removed" };   // the phone disconnected this desktop
      const transient = out.unreachable === true || out.status >= 500 || out.status === 429 || out.ok;   // `ok` with `ok:false` in the body is the service's "unavailable"
      if (!transient) return { kind: "refused", code: out.code ?? `http_${out.status}` };   // 400 / 401 / 403 / 409 / 413: the same body would be refused again
      if (attempt >= SHARED_LIMITS.retries) return { kind: "gave_up", code: out.code ?? (out.unreachable ? "server_unreachable" : `http_${out.status}`) };
      let wait = SHARED_LIMITS.retryFirstMs * 2 ** attempt;
      if (out.status === 429 && out.retryAfterMs !== undefined && out.retryAfterMs > 0) {
        if (out.retryAfterMs > SHARED_LIMITS.retryAfterMaxMs) return { kind: "gave_up", code: "rate_limited" };
        wait = out.retryAfterMs;
      }
      await ports.sleep(wait);
      if (stopped) return { kind: "gave_up", code: "stopped" };
      if (runUser !== null && ports.userId() !== runUser) return { kind: "gave_up", code: "account_changed" };
    }
  }

  const num = (v: string | null): number | null => { if (v === null) return null; const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
  /** The era the server last said (a re-open of the switch makes a new one: the next pull is a whole read). Kept; sent back on the next call. */
  const noteEra = (store: SharedStorePort, era: number | null): void => { if (era !== null && num(store.readMeta(KEYS.era)) !== era) store.writeMeta(KEYS.era, String(era)); };
  const cursorOf = (store: SharedStorePort): number | null => num(store.readMeta(KEYS.cursor));

  // ───────────────────────── push ─────────────────────────
  type Planned = { item: PushItem; line?: PersonalLine; rowOf?: string; olds: string[]; old: boolean; local: string; replaceOnly?: boolean };

  /**
   * What goes up this pass, in this order: forgets (the person's), "said again", then the adds (P lines). A put names the cards its line replaced (`replaces`: the old line's row sid).
   * An old line (said before the first merge) goes with `cursor: 0` so a forget it never heard of wins over it; everything else with this desktop's cursor.
   */
  function plan(store: SharedStorePort, nowIso: string, mergedAt: number | null): { items: Planned[]; refusedNow: Array<[string, "full" | "refused"]>; drop: string[] } {
    const rows = store.idRows();
    const lines = store.liveLines();
    const liveBy = new Map(lines.map((l) => [l.id, l]));
    const items: Planned[] = []; const refusedNow: Array<[string, "full" | "refused"]> = []; const drop: string[] = [];
    // the live lines by their words: a re-said line cancels a forget that never left (the person took it back before it was sent)
    const fpsOfLive = new Map<string, PersonalLine>();
    for (const l of lines) { if (sharedKindOf(l) === null) continue; for (const t of [l.native, l.content]) { const fp = t ? factFingerprint(t) : null; if (fp && !fpsOfLive.has(fp)) fpsOfLive.set(fp, l); } }
    // 1. forgets: the F rows, and an S row whose line is not live any more and was forgotten (a door that did not leave an F row)
    const goneRows = [...rows.values()].filter((r) => r.state === "S" && !liveBy.has(r.memoryId));
    const successors = goneRows.length ? store.successorsOf(goneRows.map((r) => r.memoryId)) : new Map<string, string>();
    const replacedBy = new Map<string, SharedIdRow[]>();   // successor local id -> the rows of the lines it replaced
    for (const row of rows.values()) {
      if (row.state === "F") {
        const back = row.fp ? fpsOfLive.get(row.fp) : undefined;
        if (back && Date.parse(back.createdAt) > Date.parse(row.at)) { drop.push(row.memoryId); continue; }   // said again after the forget: the forget is not sent
        if (!row.fp || !FP_RE.test(row.fp)) { drop.push(row.memoryId); continue; }                        // nothing to tell the server by
        items.push({ item: { op: "forget", id: row.sid ?? wireId(row.memoryId), fp: row.fp }, olds: [], old: false, rowOf: row.memoryId, local: row.memoryId });
        continue;
      }
      if (row.state !== "S" || liveBy.has(row.memoryId)) continue;
      if (store.fateOf(row.memoryId) === "forgotten") {
        if (row.fp && FP_RE.test(row.fp)) items.push({ item: { op: "forget", id: row.sid!, fp: row.fp }, olds: [], old: false, rowOf: row.memoryId, local: row.memoryId });
        else drop.push(row.memoryId);
        continue;
      }
      // REPLACED (an edit, a merge, a purge): never a forget. An edit goes up as the successor's own add that names the old card (`replaces`); an old line with no such successor carries nothing: only its row is dropped.
      const next = successors.get(row.memoryId); const successor = next ? liveBy.get(next) : undefined;
      if (successor && sharedKindOf(successor) !== null && !rows.has(successor.id)) { (replacedBy.get(successor.id) ?? replacedBy.set(successor.id, []).get(successor.id)!).push(row); continue; }
      // The successor is ALREADY a shared card (its words were the same as a card another place said, so the edit found them "the same" and wrote no new line): the old card must still go. It goes up as one more put of the
      // successor's words under an id of its own (never the live card's id: the server ignores `replaces` on a put whose id is live) naming the old card; the server knows the words (`same`) and lets the old card go.
      const succRow = successor ? rows.get(successor.id) : undefined;
      if (successor && succRow?.state === "S" && succRow.sid && succRow.sid !== row.sid && row.sid && sharedKindOf(successor) !== null && successor.readable) {
        const built = wireRowOf(successor, nowIso);
        if (built.ok) { items.push({ item: { op: "put", row: { ...built.row, id: wireId(`replace:${successor.id}:${row.sid}`) }, replaces: [row.sid] }, line: successor, olds: [row.memoryId], old: false, local: successor.id, replaceOnly: true }); continue; }
      }
      drop.push(row.memoryId);
    }
    // 2. said again
    for (const row of rows.values()) if (row.state === "S" && row.said === 1 && row.sid && liveBy.has(row.memoryId)) items.push({ item: { op: "said", id: row.sid }, olds: [], old: false, rowOf: row.memoryId, local: row.memoryId });
    // 3. adds: every live shared-kind line with no row (P)
    for (const line of lines) {
      if (rows.has(line.id) || sharedKindOf(line) === null || !line.readable) continue;
      const built = wireRowOf(line, nowIso);
      if (!built.ok) { if (built.why !== "not_shared") refusedNow.push([line.id, "refused"]); continue; }
      const olds = replacedBy.get(line.id) ?? [];
      const sids = olds.map((o) => o.sid).filter((s): s is string => !!s).slice(0, SHARED_LIMITS.replaces);
      const said = Date.parse(built.row.saidAt);
      items.push({ item: { op: "put", row: built.row, ...(sids.length ? { replaces: sids } : {}) }, line, olds: olds.map((o) => o.memoryId), old: mergedAt === null || (Number.isFinite(said) && said < mergedAt), local: line.id });
    }
    // The order the adds go up in: identity and boundary first, then the facts the person said most recently first - the server fills what room is left in the order it is given, so the oldest facts are the ones left out.
    const rank = (p: Planned): number => (p.item.op === "put" && p.item.row.kind === "fact" ? 1 : 0);
    const said = (p: Planned): number => (p.item.op === "put" ? Date.parse(p.item.row.saidAt) || 0 : 0);
    const head = items.filter((p) => p.item.op !== "put"), puts = items.filter((p) => p.item.op === "put").sort((x, y) => rank(x) - rank(y) || said(y) - said(x));
    return { items: [...head, ...puts], refusedNow, drop };
  }

  function chunks(items: Planned[]): Planned[][] {
    const out: Planned[][] = []; let cur: Planned[] = []; let bytes = 0;
    for (const p of items) {
      const b = Buffer.byteLength(JSON.stringify(p.item)) + 2;
      if (cur.length >= SHARED_LIMITS.pushItems || (cur.length > 0 && bytes + b >= SHARED_LIMITS.pushBodyBytes)) { out.push(cur); cur = []; bytes = 0; }
      cur.push(p); bytes += b;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** What one answered item means here. `again` = the item needs another pass (a `retry`); `unsettled` = an unknown word: nothing is marked, the next trigger sends it again. */
  function applyResult(store: SharedStorePort, p: Planned, res: unknown, report: RunReport): { again: boolean; unsettled?: boolean } {
    const it = p.item;
    if (it.op !== "put") {
      const word = wordOf(res);
      if (word === "retry") return { again: true };
      if (!["ok", "same", "out", "forgotten", "gone", "refused", "full"].includes(word)) return { again: false, unsettled: true };
      if (it.op === "forget") {
        // whatever the server answers, the person's forget has been heard (a card that is not there, or already forgotten, is the same end)
        store.deleteIdRows([p.local]); report.up.forget += 1; return { again: false };
      }
      // said
      if (word === "ok" || word === "same") { const row = store.idRows().get(p.local); if (row) store.putIdRow({ ...row, said: 0 }); report.up.said += 1; return { again: false }; }
      if (word === "out") { store.withdrawMatching({ localId: p.local }); store.deleteIdRows([p.local]); report.up.out += 1; return { again: false }; }
      if (word === "forgotten") { forgetFromElsewhere(store, { localId: p.local }, report); return { again: false }; }
      return { again: false };
    }
    const a = answerOf(res);
    if (a.word === "retry") return { again: true };
    if (a.word === "unknown") return { again: false, unsettled: true };
    // put
    const line = p.line!;
    const fp = factFingerprint(line.native ?? line.content);
    if (p.replaceOnly && a.word !== "ok" && a.word !== "same") {   // a second put of an already-shared line must never change that line's own row
      if (a.word === "forgotten") forgetFromElsewhere(store, { localId: line.id }, report);
      store.deleteIdRows(p.olds); return { again: false };
    }
    switch (a.word) {
      case "ok": case "same": {
        if (p.replaceOnly) { store.deleteIdRows(p.olds); report.up.put += 1; if (a.word === "ok") store.putIdRow({ memoryId: line.id, sid: a.sid, state: "S", said: 0, fp, by: null }); return { again: false }; }   // the line keeps its own row; only the old card's row goes
        store.putIdRow({ memoryId: line.id, sid: a.sid, state: "S", said: 0, fp, by: null });
        store.deleteIdRows(p.olds);
        report.up.put += 1;
        if (a.word === "ok" && a.evicted) store.evictedNotice(a.evicted, line.id);
        return { again: false };
      }
      case "out": store.withdrawMatching({ localId: line.id }); store.deleteIdRows([line.id, ...p.olds]); report.up.out += 1; return { again: false };
      case "full": store.putIdRow({ memoryId: line.id, sid: null, state: "L", said: 0, fp, by: null }); store.deleteIdRows(p.olds); report.up.full += 1; return { again: false };
      case "forgotten": forgetFromElsewhere(store, { localId: line.id }, report); store.deleteIdRows(p.olds); return { again: false };
      case "refused": {
        // the server does not trust this desktop: it keeps the line here (L, never sent again). A line the shared secret check refuses is taken out of the recall too.
        if (a.why === "secret_like") store.withdrawMatching({ localId: line.id });
        else store.putIdRow({ memoryId: line.id, sid: null, state: "L", said: 0, fp, by: null });
        store.deleteIdRows(p.olds); report.up.refused += 1; return { again: false };
      }
      default: return { again: false, unsettled: true };
    }
  }

  function forgetFromElsewhere(store: SharedStorePort, match: { localId?: string; sid?: string; fp?: string }, report: RunReport): void {
    const gone = store.remoteForget(match);
    if (gone.length) store.deleteIdRows(gone);
    report.down.forgotten += gone.length; report.up.forgotten += match.localId ? gone.length : 0;
  }

  async function pushPhase(store: SharedStorePort, report: RunReport): Promise<"ok" | "closed" | "failed"> {
    for (let pass = 0; pass < SHARED_LIMITS.passes; pass += 1) {
      const mark = store.rowsMark();
      if (settledMark === mark && pass === 0) return "ok";   // nothing moved since the diff found nothing to send
      const mergedAt = num(store.readMeta(KEYS.mergedAt));
      const { items, refusedNow, drop } = plan(store, new Date(ports.now()).toISOString(), mergedAt);
      if (drop.length) store.deleteIdRows(drop);
      for (const [id, why] of refusedNow) { const l = store.liveLines().find((x) => x.id === id); store.putIdRow({ memoryId: id, sid: null, state: "L", said: 0, fp: l ? factFingerprint(l.native ?? l.content) : null, by: null }); void why; report.up.refused += 1; }
      if (items.length === 0) { settledMark = store.rowsMark() === mark ? mark : null; return "ok"; }
      let needAgain = false, unsettled = false;
      const cursor = cursorOf(store) ?? 0;
      // an old line (said before the first merge) goes with cursor 0; everything else with this desktop's cursor
      for (const group of [items.filter((p) => !p.old), items.filter((p) => p.old)]) {
        for (const part of chunks(group)) {
          const out = await request(report, "POST", "/api/desktop/shared-memory", { hostId: ports.hostId(), cursor: part[0]?.old ? 0 : cursor, ...(num(store.readMeta(KEYS.era)) !== null ? { era: num(store.readMeta(KEYS.era)) } : {}), items: part.map((p) => p.item) });
          if (out.kind === "closed") return "closed";
          if (out.kind === "removed") { removedHere(store, report); return "closed"; }
          if (out.kind !== "ok") { report.code = out.code; return "failed"; }
          if (pushClosed(out.body)) return "closed";   // `open: false`: the memory is not open for this person
          noteEra(store, eraOfBody(out.body));
          const results = Array.isArray(out.body.results) ? out.body.results as unknown[] : [];
          if (results.length !== part.length) { report.code = "answer_mismatch"; return "failed"; }   // an answer that does not add up is not believed: the same body goes again (idempotent)
          for (let i = 0; i < part.length; i += 1) { const r = applyResult(store, part[i], results[i], report); needAgain = needAgain || r.again; unsettled = unsettled || r.unsettled === true; }
        }
      }
      if (!needAgain) { settledMark = !unsettled && store.rowsMark() === mark ? mark : null; return "ok"; }
      await ports.sleep(SHARED_LIMITS.retryFirstMs * 2 ** pass);
      if (stopped) return "failed";
    }
    report.code = "push_not_settled";
    return "failed";   // the work is still in the store: the next trigger sends it
  }

  // ───────────────────────── pull ─────────────────────────
  /** An in-card: a line here already (a row of that sid), a line with the same words and no row (it IS the card: the first merge never makes a second line), or a new line. */
  function takeCard(store: SharedStorePort, card: Card, rows: Map<string, SharedIdRow>, byFp: Map<string, string>, report: RunReport, liveIdOf: (wireId: string) => string | undefined): void {
    const w = cardWriteOf(card);
    const by = card.by === ports.hostId() ? null : card.by;   // a card this very desktop said (it comes back in a whole-set answer) is not "from" anybody
    for (const r of rows.values()) if (r.sid === card.sid && r.state === "S") return;     // already here (applied before)
    const own = card.homeId ? liveIdOf(card.homeId) : undefined;       // a card this desktop said comes back under its own id
    const same = own !== undefined && !rows.has(own) ? own : w.fp ? byFp.get(w.fp) : undefined;
    if (same !== undefined && !rows.has(same)) { const row = { memoryId: same, sid: card.sid, state: "S" as const, said: 0 as const, fp: w.fp, by: null }; store.putIdRow(row); rows.set(same, { ...row, at: "" }); report.down.adopted += 1; return; }
    const written = store.writeCard(w);
    if (written.result === "rejected") return;     // the owner forgot these words here (and has not said them again), or the words look like a secret: the line is not taken, the cursor still passes it
    if (written.result === "written") report.down.written += 1;
    if (written.localId) { const row = { memoryId: written.localId, sid: card.sid, state: "S" as const, said: 0 as const, fp: w.fp, by }; store.putIdRow(row); rows.set(written.localId, { ...row, at: "" }); if (w.fp) byFp.set(w.fp, written.localId); }
  }

  function liveByWords(store: SharedStorePort): Map<string, string> {
    const byFp = new Map<string, string>();
    for (const l of store.liveLines()) { if (sharedKindOf(l) === null) continue; for (const t of [l.native, l.content]) { const fp = t ? factFingerprint(t) : null; if (fp && !byFp.has(fp)) byFp.set(fp, l.id); } }
    return byFp;
  }

  /** The server let go of a card (replaced, or for room): the lines of that card are retired plainly - no stamp, no notice (a notice is the place that said the new line's). */
  function outCard(store: SharedStorePort, sid: string, report: RunReport): void {
    const ids = store.withdrawMatching({ sid });
    store.deleteIdRows([...store.idRows().values()].filter((r) => r.sid === sid).map((r) => r.memoryId));
    report.down.out += ids.length;
  }

  async function pullPhase(store: SharedStorePort, report: RunReport): Promise<"ok" | "closed" | "failed"> {
    const startedAt = ports.now();
    const cursor = cursorOf(store);
    const pulledAt = num(store.readMeta(KEYS.pulledAt));
    // the whole set is asked for again (`cursor=none`) when the last pull is older than the trail of a replaced card (30 days): this desktop decides it, the server takes no clock of ours
    const old = pulledAt !== null && ports.now() - pulledAt > SHARED_LIMITS.resetAfterMs;
    const eraKnown = num(store.readMeta(KEYS.era));
    let query = `hostId=${encodeURIComponent(ports.hostId())}&cursor=${cursor === null ? "none" : cursor}${old && cursor !== null ? "&reset=1" : ""}${eraKnown !== null ? `&era=${eraKnown}` : ""}`;
    let page: string | null = null;
    const held = new Set<string>(); const forgottenSids = new Set<string>();
    let sawReset = false, finalSeq: number | null = null, forgotAll = 0, cursorNow = cursor;
    for (let n = 0; n < SHARED_LIMITS.pages; n += 1) {
      const out = await request(report, "GET", `/api/desktop/shared-memory/pull?${query}${page ? `&page=${encodeURIComponent(page)}` : ""}`);
      if (out.kind === "closed") return "closed";
      if (out.kind === "removed") { removedHere(store, report); return "closed"; }
      if (out.kind !== "ok") { report.code = out.code; return "failed"; }
      const a = pullAnswerOf(out.body);
      if (a === null) { report.code = "answer_not_understood"; return "failed"; }
      if (a.kind === "closed") return "closed";
      noteEra(store, a.era);
      if (a.kind === "lost") {
        // the server lost this desktop's place (numbers below its purge, a new database): what it once gave is no longer known to be held - every S row goes, every line comes back as P and goes up again at cursor 0. Nobody forgot anything.
        const rows = store.idRows();
        store.deleteIdRows([...rows.values()].filter((r) => r.state === "S").map((r) => r.memoryId));
        store.writeMeta(KEYS.cursor, null); report.down.lost = true; settledMark = null;   // the lines are P now: the next push must look again, though no line moved
        return "ok";
      }
      const rows = store.idRows(); const byFp = liveByWords(store);
      const wireIds = new Map(store.liveLines().filter((l) => sharedKindOf(l) !== null).map((l) => [wireId(l.id), l.id]));
      const byWire = (id: string): string | undefined => wireIds.get(id);
      if (a.kind === "reset") {
        sawReset = true; report.down.reset = true; report.down.cards += a.set.length;
        for (const card of a.set) { held.add(card.sid); takeCard(store, card, rows, byFp, report, byWire); }
        for (const id of a.forgotten) forgottenSids.add(id);
        forgotAll = Math.max(forgotAll, a.forgotAllSeq);
        if (a.seq !== null) finalSeq = a.seq;
        if (a.next !== null) { page = a.next; continue; }
        break;
      }
      // events, in the server's own order (a card and a later forget of it come in that order)
      for (const ev of a.events) {
        if (ev.type === "in") takeCard(store, ev.card, rows, byFp, report, byWire);
        else if (ev.type === "out") outCard(store, ev.id, report);
        else forgetFromElsewhere(store, { sid: ev.id }, report);
      }
      finalSeq = a.seq; forgotAll = Math.max(forgotAll, a.forgotAllSeq);
      // the answer was cut at the server's budget (`more`): what was applied is kept (the cursor moves) and the rest is asked for from there
      if (a.more && a.seq > (cursorNow ?? 0)) { store.writeMeta(KEYS.cursor, String(a.seq)); cursorNow = a.seq; query = `hostId=${encodeURIComponent(ports.hostId())}&cursor=${a.seq}${eraKnown !== null ? `&era=${eraKnown}` : ""}`; continue; }
      break;
    }
    if (sawReset) {
      // whole set: what this desktop holds as S and the set no longer holds (and the server did not call forgotten) was let go: it is retired here; what the server says was forgotten is forgotten here. P and L lines stay.
      for (const sid of forgottenSids) forgetFromElsewhere(store, { sid }, report);
      for (const row of store.idRows().values()) if (row.state === "S" && row.sid && !held.has(row.sid) && !forgottenSids.has(row.sid)) outCard(store, row.sid, report);
    }
    // "forget everything" from another place: when this desktop's cursor had not reached it, every shared-kind line that existed before this answer was asked goes
    if (forgotAll > (cursor ?? 0)) { const gone = store.remoteForgetAll(new Date(startedAt).toISOString()); store.deleteIdRows(gone); report.down.erasedAll = gone.length; report.down.forgotten += gone.length; }
    if (finalSeq !== null) store.writeMeta(KEYS.cursor, String(Math.max(cursor ?? 0, finalSeq)));
    store.writeMeta(KEYS.pulledAt, String(ports.now()));
    if (num(store.readMeta(KEYS.mergedAt)) === null) { store.writeMeta(KEYS.mergedAt, String(ports.now())); try { if (runUser) store.firstMergeDone?.(runUser); } catch { /* the mirror switch already reads off once the mark is written */ } }
    settledMark = null;
    return "ok";
  }

  /** The phone disconnected this desktop: sharing stops, what other places gave is erased with no stamp, what was said here stays (L), the cursor and the first-merge mark go (a new pairing merges from the start). */
  function removedHere(store: SharedStorePort, report: RunReport): void {
    closed = true;
    const gone = store.eraseReceived();
    report.down.out += gone.length;
    store.writeMeta(KEYS.cursor, null); store.writeMeta(KEYS.mergedAt, null); store.writeMeta(KEYS.pulledAt, null);
    settledMark = null;
    say("shared memory: this desktop was disconnected");
  }

  // ───────────────────────── one run ─────────────────────────
  async function runOnce(userId: string, wantPull: boolean): Promise<RunReport> {
    const report = emptyReport();
    const store = ports.store();
    if (!store) { report.skipped = "no_store"; return report; }
    report.ran = true;
    runUser = userId;
    try {
      // the record of the old build (one app-database row per account) becomes rows of the table, once, and is deleted
      if (!legacyTaken.has(userId)) {
        legacyTaken.add(userId);
        const legacy = store.takeLegacyRows(userId);
        if (legacy) { const live = new Set(store.liveLines().map((l) => l.id)); for (const r of legacy) if (live.has(r.localId) && !store.idRows().has(r.localId)) store.putIdRow({ memoryId: r.localId, sid: r.sid, state: "S", said: 0, fp: null, by: null }); }
      }
      const firstMerge = cursorOf(store) === null;
      if (firstMerge) {
        // the FIRST MERGE reads before anything goes up: this desktop holds no card yet, so nothing of its own can be erased, and the set is filled only with what it has room for (the server decides: an old line takes only the room that is left)
        const first = await pullPhase(store, report);
        if (first === "closed") { closed = true; return report; }
        if (first === "failed") { say(`shared memory: not taken (${report.code ?? "failed"})`); return report; }
      }
      const pushed = await pushPhase(store, report);
      if (pushed === "closed") { closed = true; return report; }
      if (pushed === "failed") { say(`shared memory: not sent (${report.code ?? "failed"})`); return report; }
      const movedServer = report.up.put + report.up.said + report.up.forget + report.up.full + report.up.refused + report.up.out > 0;
      const lostNow = report.down.lost === true;
      if (!((firstMerge && !lostNow ? false : wantPull || cursorOf(store) === null) || movedServer)) { if (firstMerge) say("shared memory: in step"); return report; }
      const pulled = await pullPhase(store, report);
      if (pulled === "closed") closed = true;
      else if (pulled === "failed") say(`shared memory: not taken (${report.code ?? "failed"})`);
      else if (report.down.lost) {
        // lost: every line is P again and goes up in this same run, then the set is read again from the start
        report.down.lost = false;
        const more = await pushPhase(store, report);
        if (more === "closed") closed = true;
        else if (more === "failed") say(`shared memory: not sent (${report.code ?? "failed"})`);
        else { const last = await pullPhase(store, report); if (last === "closed") closed = true; else say(last === "ok" ? "shared memory: in step" : `shared memory: not taken (${report.code ?? "failed"})`); }
      } else say("shared memory: in step");
    } catch (error) { void error; report.code = "sync_exception"; say("shared memory: stopped by an error"); }
    finally { runUser = null; }
    return report;
  }

  function trigger(pull: boolean): Promise<RunReport> {
    const userId = ports.userId();
    if (stopped || !enabled || closed || !userId) { const early = { ...emptyReport(), skipped: stopped ? "stopped" : !enabled ? "not_open" : closed ? "closed" : "signed_out" }; return Promise.resolve(early); }
    if (running) { again = { pull: (again?.pull ?? false) || pull }; return running; }
    const flight = (async () => {
      let report = await runOnce(userId, pull);
      // a trigger that arrived during the run is served once more, not once per trigger
      while (again && !report.code && !closed && !stopped) { const next = again; again = null; report = await runOnce(userId, next.pull); }
      again = null;
      return report;
    })().finally(() => { running = null; });
    running = flight;
    return flight;
  }

  return {
    /** A Personal line was written, replaced or forgotten (this process or another): the push is looked at. */
    signal(kind: SharedSignal): Promise<RunReport> { return trigger(kind === "start"); },
    /**
     * The one plural read answered. `sharedOpen` (the server: a phone conversation exists, or another desktop is registered) opens the sync; without it - or with the first merge never done - NO request is made.
     * A later answer with another `sharedSeq` than the cursor makes a pull (after the push).
     */
    answer(answer: { sharedSeq: number; sharedOpen?: boolean }): Promise<RunReport> {
      const store = (() => { try { return ports.store(); } catch { return null; } })();
      const merged = store ? num(store.readMeta(KEYS.mergedAt)) !== null : false;
      if (answer.sharedOpen !== true && !merged) { enabled = false; return Promise.resolve({ ...emptyReport(), skipped: "not_open" }); }
      enabled = true; closed = false;
      const cursor = store ? cursorOf(store) : null;
      return trigger(cursor === null || cursor !== answer.sharedSeq);
    },
    /** The place was removed (the plural answer said so): the same end as a 403 `place_removed` of the shared route. */
    removed(): void { const store = ports.store(); if (store) removedHere(store, emptyReport()); },
    stop(): void { stopped = true; again = null; },
    idle: async (): Promise<void> => { while (running) { try { await running; } catch { /* ignore */ } } },
    _peek: () => ({ enabled, closed, stopped, running: running !== null }),
  };
}
export type SharedMemorySync = ReturnType<typeof createSharedMemorySync>;
