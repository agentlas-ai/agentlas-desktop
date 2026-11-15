/*
 * The real stores behind the mirror (Agentlas 2.0 TG): lazy requires only; Main builds it once. A process with no app database (the background service) gets none and the mirror answers `no_store`.
 * It is the ONLY place that knows how a Personal line, a conversation word or the profile is read here and how a card of the server is put in:
 *   - lines: `memory_entries` scope `user_identity`, live = not superseded and not blanked; kinds `preference` / `fact` (an identity or boundary the model gave is kept in `context_json.ticket_kind`, K2b');
 *   - the two host columns `origin_class` / `certainty` travel as the server's `claimType` / `verification` (home-mirror.ts `wireRowOf`);
 *   - a card of the server is written through `insertMemoryEntryOnce` with the import receipt of the move (a forgotten card is never written again, the same card never twice) and the same two columns;
 *   - the conversation is `chat_messages` of the chat the personal agent is bound to (rows with scope NULL or `view`, the same lines the move packs); words that came from the server (`hope-server:<seq>`) are never sent back.
 * Nothing is stored here: the record of what the server has lives in home-mirror.ts's own `meta` row.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { factFingerprint, wireId, type CardWrite, type LocalProfile, type MirrorMessage, type MirrorStorePort, type PersonalRow, type ProfileWords } from "./home-mirror";
import { CHARACTERS, STYLE_LINE, dropOwnWords, phoneWordId, planServerMessages, type LocalProfileView, type ProfilePatch } from "./server-import";
import { serverNameUp } from "../../shared/one-agent-name";

export { phoneWordId };   // the phone's pure function lives in server-import.ts (the move's import uses it too, audit D3)

/* eslint-disable @typescript-eslint/no-require-imports */
const req = <T>(id: string): T => require(id) as T;

const SERVER_TAG = "hope-server-fact";
const tagOf = (serverId: string): string => `${SERVER_TAG}:${serverId}`;
const sha16 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const MARK_KEY = "revision";

/** What a phone's profile change does here (the mirror takes the phone's word: the server only offers a profile the phone changed after the computer last had it). Pure; the gate runs it. */
export function planPhoneProfile(server: unknown, here: LocalProfileView, base: ProfileWords | null = null): ProfilePatch {
  const patch: ProfilePatch = {};
  if (!server || typeof server !== "object" || Array.isArray(server)) return patch;
  const s = server as Record<string, unknown>;
  // Three-way: `base` is what the server last had from this computer. A field the owner changed here since then (here differs from base, and here has a comparable value) is kept: it goes on top at the next send.
  const words = localProfileOf({ displayName: here.displayName, avatarIcon: here.avatarIcon, profileContext: here.profileContext, preferredLocale: here.preferredLocale, timeZone: here.timeZone });
  const edited = (field: "name" | "character" | "style" | "language" | "timeZone"): boolean => { if (field === "language" && here.preferredLocale !== "ko" && here.preferredLocale !== "en") return false; const mine = words[field]; return !!base && base[field] !== undefined && mine !== null && mine !== undefined && mine !== base[field]; };
  // PR-D1: a value the phone did not change since this computer last sent it (the server's value is the one `base` holds) is not written back. This computer may have sent a stand-in for a value its owner never chose
  // (a style when the profile text is empty, a character when the face is a photo, a language that is "system"); the owner's own empty / photo / system choice is not turned into that stand-in by a later change of something else.
  const same = (field: "name" | "character" | "style" | "language" | "timeZone", value: unknown): boolean => !!base && base[field] !== undefined && base[field] === value;
  const name = typeof s.name === "string" ? s.name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim() : "";
  // The name that went UP for an old name over the server's 12 characters is this computer's own stand-in (`words.name`): the server giving it back is not the phone's change, whatever the record of the last send says.
  if (name && Array.from(name).length <= 64 && name !== here.displayName && name !== words.name && !edited("name") && !same("name", name)) patch.displayName = name;
  if (typeof s.character === "string" && CHARACTERS.has(s.character) && `character:${s.character}` !== here.avatarIcon && !edited("character") && !same("character", s.character)) patch.avatarIcon = `character:${s.character}`;
  if ((s.language === "ko" || s.language === "en") && here.preferredLocale !== s.language && !edited("language") && !same("language", s.language)) patch.preferredLocale = s.language;
  if (typeof s.timeZone === "string" && s.timeZone && s.timeZone.length <= 128 && s.timeZone !== here.timeZone && !edited("timeZone")) { try { new Intl.DateTimeFormat("en", { timeZone: s.timeZone }); patch.timeZone = s.timeZone; } catch { /* not a zone */ } }
  // The style has no field of its own here: it is the line of the profile text the move also writes. It replaces an EMPTY text or one of the four lines of the table (what this file or the move wrote); the owner's own words are never overwritten.
  const style = typeof s.style === "string" ? STYLE_LINE[s.style] : undefined;
  if (style) {
    const text = here.profileContext.trim();
    const isTableLine = Object.values(STYLE_LINE).some((l) => l.ko === text || l.en === text);
    const wanted = s.language === "en" ? style.en : style.ko;
    // PR-D1: an EMPTY text whose style the phone did not change since the last send (the style sent was the stand-in for "none chosen") stays empty
    if ((text === "" || isTableLine) && text !== wanted && !edited("style") && !(text === "" && same("style", s.style))) patch.profileContext = wanted;
  }
  return patch;
}

/** The profile as the server's closed words: the character from `character:<id>` when it is in the table (a photo or a custom icon is null), the style from the profile text when it is one of the four lines, else null. */
export function localProfileOf(p: { displayName: string; avatarIcon: string; profileContext: string; preferredLocale: string; timeZone: string | null }): LocalProfile {
  const character = p.avatarIcon.startsWith("character:") && CHARACTERS.has(p.avatarIcon.slice(10)) ? p.avatarIcon.slice(10) : null;
  const text = p.profileContext.trim();
  let style: string | null = null;
  for (const [key, line] of Object.entries(STYLE_LINE)) if (line.ko === text || line.en === text) style = key;
  let language: string = p.preferredLocale === "ko" || p.preferredLocale === "en" ? p.preferredLocale : "en";
  if (p.preferredLocale !== "ko" && p.preferredLocale !== "en") { try { language = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("ko") ? "ko" : "en"; } catch { /* en */ } }
  // The name is what goes up: an old name over the server's 12 characters goes as its first 12 (a stand-in, never written back as the owner's choice); any other name as it is.
  return { name: serverNameUp(p.displayName), character, style, language, timeZone: p.timeZone };
}

export function realMirrorStore(): MirrorStorePort {
  const mem = (): Database.Database => req<typeof import("../memory/database")>("../memory/database").getMemoryDb();
  const app = (): Database.Database => req<typeof import("../store/db")>("../store/db").getDb();
  const profileMod = (): typeof import("../store/one-profile") => req("../store/one-profile");
  const bundle = (): typeof import("./bundle") => req("./bundle");

  // the live Personal lines' words -> id, built once and kept in step with this file's own writes (a foreign write moves the mark and rebuilds it)
  let index: { mark: string; byFp: Map<string, string> } | null = null;

  function rowsMark(): string {
    try { return String((mem().prepare("SELECT value FROM memory_store_meta WHERE key=?").get(MARK_KEY) as { value?: unknown } | undefined)?.value ?? "0"); } catch { return "0"; }
  }
  function nativeOf(ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    try { for (let i = 0; i < ids.length; i += 400) { const part = ids.slice(i, i + 400); for (const r of mem().prepare(`SELECT entry_id, content_native FROM memory_entry_native WHERE entry_id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ entry_id: string; content_native: string }>) out.set(r.entry_id, r.content_native); } } catch { /* the table is absent on a store that never had an English line */ }
    return out;
  }
  function liveRows(): PersonalRow[] {
    const rows = mem().prepare("SELECT id, kind, content, context_json, created_at, origin_class, certainty, evidence_json FROM memory_entries WHERE scope='user_identity' AND superseded_at IS NULL AND content<>'' AND kind IN ('preference','fact') ORDER BY created_at, id").all() as Array<{
      id: string; kind: "preference" | "fact"; content: string; context_json: string | null; created_at: string; origin_class: string | null; certainty: string | null; evidence_json: string | null }>;
    const natives = nativeOf(rows.map((r) => r.id));
    return rows.map((r) => {
      let ticketKind: "identity" | "boundary" | null = null; let boundary: PersonalRow["boundary"] = null; let serverCard: string | null = null;
      try {
        const c = JSON.parse(r.context_json || "{}") as { ticket_kind?: unknown; boundary?: unknown };
        if (c.ticket_kind === "identity" || c.ticket_kind === "boundary") ticketKind = c.ticket_kind;
        const b = c.boundary as { type?: unknown; from?: unknown; to?: unknown } | undefined;
        if (b && (b.type === "no_proactive" || b.type === "quiet_hours")) boundary = { type: b.type, ...(typeof b.from === "string" ? { from: b.from } : {}), ...(typeof b.to === "string" ? { to: b.to } : {}) };
      } catch { /* no context */ }
      try { const e = JSON.parse(r.evidence_json || "[]") as unknown; if (Array.isArray(e)) for (const t of e) if (typeof t === "string" && t.startsWith(`${SERVER_TAG}:`)) serverCard = t.slice(SERVER_TAG.length + 1); } catch { /* no evidence */ }
      return { id: r.id, kind: r.kind, ticketKind, boundary, content: r.content, native: natives.get(r.id) ?? null, originClass: r.origin_class, certainty: r.certainty, createdAt: r.created_at, serverCard };
    });
  }
  function rowFate(id: string): "forgotten" | "replaced" {
    if (id.startsWith("srv:")) return "forgotten";   // a card of the server this computer's owner had forgotten before it was taken (home-mirror.ts)
    try { if (mem().prepare("SELECT 1 FROM memory_revocation_sources WHERE source_memory_id=? LIMIT 1").get(id)) return "forgotten"; } catch { /* no table: replaced */ }
    return "replaced";
  }

  /**
   * K7': the turn a forgotten Personal line was said in, as the mirror names it (`wireId` of the owner's message that started the turn). Read from the line's own links, which a forget keeps (it blanks the words, not the ids):
   * origin link `ticket` -> `memory_tickets.run_id` -> the personal agent's request of that run (`one_supervisor_requests.user_message_id`). Exactly ONE such turn or null - a line the resting-time pass made from several
   * turns, a line with no ticket, a run with no request names no turn, so no conversation is forgotten on a guess.
   */
  function rowTurn(id: string): string | null {
    try {
      const tickets = (mem().prepare("SELECT DISTINCT source_id FROM memory_origin_links WHERE memory_id=? AND source_kind IN ('ticket','memory-ticket')").all(id) as Array<{ source_id: string }>).map((row) => row.source_id);
      if (tickets.length !== 1) return null;
      const run = (mem().prepare("SELECT run_id FROM memory_tickets WHERE ticket_id=?").get(tickets[0]) as { run_id: string | null } | undefined)?.run_id;
      if (!run) return null;
      const requests = app().prepare("SELECT DISTINCT user_message_id FROM one_supervisor_requests WHERE run_id=? AND kind='reply' AND user_message_id IS NOT NULL LIMIT 2").all(run) as Array<{ user_message_id: string }>;
      return requests.length === 1 ? wireId(requests[0].user_message_id) : null;
    } catch { return null; }
  }

  /**
   * TH-web 2 (`gone[].turnIds`): EVERY turn a forgotten line came from, up to 32 (a line the resting-time pass gathered from several turns has several origin tickets; `rowTurn` named none for it, so the server's words of those turns
   * stayed). Each origin ticket -> its run -> the personal agent's request of that run -> the owner's message that started it (`wireId`). A ticket with no run or no request names no turn; the others still do. Distinct, in the order read.
   */
  function rowTurns(id: string): string[] {
    const out: string[] = [];
    try {
      const tickets = (mem().prepare("SELECT DISTINCT source_id FROM memory_origin_links WHERE memory_id=? AND source_kind IN ('ticket','memory-ticket') LIMIT 64").all(id) as Array<{ source_id: string }>).map((row) => row.source_id);
      for (const t of tickets) {
        const run = (mem().prepare("SELECT run_id FROM memory_tickets WHERE ticket_id=?").get(t) as { run_id: string | null } | undefined)?.run_id;
        if (!run) continue;
        const requests = app().prepare("SELECT DISTINCT user_message_id FROM one_supervisor_requests WHERE run_id=? AND kind='reply' AND user_message_id IS NOT NULL LIMIT 2").all(run) as Array<{ user_message_id: string }>;
        if (requests.length !== 1) continue;
        const wire = wireId(requests[0].user_message_id);
        if (!out.includes(wire)) out.push(wire);
        if (out.length >= 32) break;
      }
    } catch { /* the turns read so far are the answer */ }
    return out;
  }
  /** TH+MT F2: the words this computer took from these turns of the server leave (server-turns.ts); the next take of the mirror's own state needs nothing else (a word that came from the server is never sent back). */
  function forgetServerTurns(turnIds: string[]): number { return req<typeof import("./server-turns")>("./server-turns").forgetServerTurns(app(), turnIds); }
  /** Audit D1: pays the debt of the deleted words (a TRUNCATE checkpoint that does not wait), once per take page and at every signal; `none` when nothing is owed. */
  function settleServerWords(): "none" | "clean" | "busy" | "failed" { return req<typeof import("./server-turns")>("./server-turns").settleServerWordsResidue(app()); }

  // ── conversation ──
  function chatOf(): { db: Database.Database; chat: string } | null {
    try {
      const db = app(); const oneId = profileMod().getOneProfile().oneId;
      const chat = bundle().boundPersonalChat(db, oneId);
      return chat ? { db, chat } : null;
    } catch { return null; }
  }
  /**
   * TH-web 2 (one-home-mirror.md section 2, `clientMessageId`): the id the PHONE's word carries at the server. The phone names a word it kept for a computer by its command id and, when it puts the same word on the server, gives it the id
   * `oneHomeServiceWordId(commandId)` (mobile/app/lib/core/one_home/one_home_forward.dart): `moved-<commandId>` when that is an id, else `moved-<first 40 hex of sha-256 of the command id>`. The computer knows the command id of every word it
   * was given (`one_supervisor_requests.command_id` of the request that stored the owner's message); a word with such a request names that id, and the server then keeps ONE line for the same word. A word with no request (an imported
   * one) names none. Pure function of the stored command id - no text is read.
   */
  function clientMessageIds(db: Database.Database, messageIds: string[]): Map<string, string> {
    const out = new Map<string, string>();
    try {
      for (let i = 0; i < messageIds.length; i += 400) {
        const part = messageIds.slice(i, i + 400);
        for (const r of db.prepare(`SELECT user_message_id, command_id FROM one_supervisor_requests WHERE kind='reply' AND user_message_id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ user_message_id: string; command_id: string }>) {
          const cid = phoneWordId(r.command_id); if (cid && !out.has(r.user_message_id)) out.set(r.user_message_id, cid);
        }
      }
    } catch { /* the table is absent on a store that never had the personal agent's requests */ }
    return out;
  }
  const hasRowScope = (db: Database.Database): boolean => (db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>).some((c) => c.name === "row_scope");
  function messages(after: { at: string | null; ids: string[] }, limit: number, from: "newest-kept" | "start"): MirrorMessage[] {
    const c = chatOf(); if (!c) return [];
    const scope = hasRowScope(c.db) ? " AND (row_scope IS NULL OR row_scope='view')" : "";
    const base = `chat_id=? AND text<>'' AND role IN ('user','assistant')${scope} AND id NOT LIKE 'hope-server:%'`;
    let filter = ""; const args: unknown[] = [c.chat];
    if (after.at) {
      const ids = after.ids.slice(0, 400);
      filter = ` AND (created_at > ? OR (created_at = ?${ids.length ? ` AND id NOT IN (${ids.map(() => "?").join(",")})` : ""}))`;
      args.push(after.at, after.at, ...ids);
    } else if (from === "newest-kept") {
      const row = c.db.prepare(`SELECT created_at FROM chat_messages WHERE ${base} ORDER BY created_at DESC, rowid DESC LIMIT 1 OFFSET 4999`).get(c.chat) as { created_at?: string } | undefined;
      if (row?.created_at) { filter = " AND created_at >= ?"; args.push(row.created_at); }
    }
    const rows = c.db.prepare(`SELECT rowid AS rid, id, role, text, created_at FROM chat_messages WHERE ${base}${filter} ORDER BY created_at, rowid LIMIT ?`).all(...args, limit) as Array<{ rid: number; id: string; role: "user" | "assistant"; text: string; created_at: string }>;
    if (!rows.length) return [];
    // the turn the first word belongs to: the person's word before it, and the answer bubbles already between them
    let turn: string | null = null; let bubbles = 0;
    const first = rows[0];
    if (first.role === "assistant") {
      const u = c.db.prepare(`SELECT rowid AS rid, id, created_at FROM chat_messages WHERE ${base} AND role='user' AND (created_at < ? OR (created_at = ? AND rowid < ?)) ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(c.chat, first.created_at, first.created_at, first.rid) as { rid: number; id: string; created_at: string } | undefined;
      if (u) {
        turn = wireId(u.id);
        bubbles = Number((c.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE ${base} AND role='assistant' AND (created_at > ? OR (created_at = ? AND rowid > ?)) AND (created_at < ? OR (created_at = ? AND rowid < ?))`).get(c.chat, u.created_at, u.created_at, u.rid, first.created_at, first.created_at, first.rid) as { n: number }).n) || 0;
      }
    }
    const out: MirrorMessage[] = [];
    const clientIds = clientMessageIds(c.db, rows.filter((r) => r.role === "user").map((r) => r.id));
    for (const r of rows) {
      const made = Date.parse(r.created_at);
      let skip: MirrorMessage["skip"];
      let n = 0;
      if (r.role === "user") { turn = wireId(r.id); bubbles = 0; n = 0; }
      else { if (turn === null) { turn = wireId(`turn:${r.id}`); bubbles = 0; } bubbles += 1; n = bubbles; if (n > 20) skip = "too_many_bubbles"; }
      if (!skip && Array.from(r.text).length > 4_000) skip = "too_long";
      if (!skip && !Number.isFinite(made)) skip = "bad_date";
      out.push({ id: r.id, wire: wireId(r.id), turnId: turn as string, n, role: r.role === "user" ? "user" : "friend", text: r.text, saidAt: Number.isFinite(made) ? new Date(made).toISOString() : "", at: r.created_at, ...(skip ? { skip } : {}),
        ...(r.role === "user" && n === 0 && clientIds.has(r.id) ? { clientMessageId: clientIds.get(r.id) as string } : {}) });
    }
    return out;
  }
  function resting(): boolean {
    try {
      const n = Number((app().prepare("SELECT COUNT(*) AS n FROM one_supervisor_requests WHERE state IN ('stored','dispatching','accepted')").get() as { n: number }).n) || 0;
      return n === 0;
    } catch { return true; }
  }

  // ── profile ──
  function profile(): LocalProfile | null {
    try { const p = profileMod().getOneProfile(); return localProfileOf({ displayName: p.displayName, avatarIcon: p.avatarIcon ?? "", profileContext: p.profileContext ?? "", preferredLocale: p.preferredLocale ?? "system", timeZone: p.timeZone ?? null }); } catch { return null; }
  }
  function applyProfile(server: unknown, base: ProfileWords | null): string[] {
    const mod = profileMod(); const cur = mod.getOneProfile();
    const patch = planPhoneProfile(server, { displayName: cur.displayName, avatarIcon: cur.avatarIcon ?? "", profileContext: cur.profileContext ?? "", preferredLocale: cur.preferredLocale ?? "system", timeZone: cur.timeZone ?? null }, base);
    if (!Object.keys(patch).length) return [];
    mod.updateOneProfile({ oneId: cur.oneId, expectedVersion: cur.version, patch: patch as never });
    return Object.keys(patch);
  }

  // ── taking ──
  function fpIndex(): Map<string, string> {
    const mark = rowsMark();
    if (index && index.mark === mark) return index.byFp;
    const byFp = new Map<string, string>();
    for (const r of liveRows()) { for (const t of [r.native, r.content]) { const fp = t ? factFingerprint(t) : null; if (fp && !byFp.has(fp)) byFp.set(fp, r.id); } }
    index = { mark, byFp };
    return byFp;
  }
  function idsByTag(serverId: string): string[] {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(serverId)) return [];
    return (mem().prepare("SELECT id FROM memory_entries WHERE scope='user_identity' AND content<>'' AND evidence_json LIKE ?").all(`%"${tagOf(serverId)}"%`) as Array<{ id: string }>).map((r) => r.id);
  }
  function forgetMatching(match: { homeId?: string; serverId?: string; fp?: string }): string[] {
    const ids = new Set<string>();
    if (match.homeId && /^[A-Za-z0-9_.:-]{1,64}$/.test(match.homeId)) {
      const r = mem().prepare("SELECT id FROM memory_entries WHERE id=? AND scope='user_identity' AND content<>''").get(match.homeId) as { id: string } | undefined; if (r) ids.add(r.id);
      // a card that this computer's own line IS: the wire id of an untagged line is the line's own id, an id that is not a valid wire id is its hash
      if (!r) for (const x of liveRows()) if (wireId(x.id) === match.homeId) ids.add(x.id);
    }
    if (match.serverId) for (const id of idsByTag(match.serverId)) ids.add(id);
    if (match.fp) for (const x of liveRows()) for (const t of [x.native, x.content]) if (t && factFingerprint(t) === match.fp) ids.add(x.id);
    const forgotten: string[] = [];
    const forget = req<typeof import("./home-move-real")>("./home-move-real").forgetOneOwned;
    for (const id of ids) { try { forget(id); forgotten.push(id); } catch { /* already forgotten, changed a moment ago, or not the owner's */ } }
    if (forgotten.length) index = null;
    return forgotten;
  }
  function writeCard(card: CardWrite): { result: "written" | "already" | "rejected"; localId?: string; own?: boolean; why?: string } {
    try {
      const store = req<typeof import("../memory/store")>("../memory/store");
      const { importSourceDigest, importSourceKey } = req<typeof import("../memory/import-source-receipt")>("../memory/import-source-receipt");
      const { getMemoryStoreInfo } = req<typeof import("../memory/database")>("../memory/database");
      const { looksSecret, redactSecrets } = req<typeof import("../../shared/secret-patterns")>("../../shared/secret-patterns");
      // a card this computer wrote itself, come back under its own id (another computer was the home in between): nothing new
      if (card.homeId) {
        const own = mem().prepare("SELECT id, content, superseded_at FROM memory_entries WHERE id=? AND scope='user_identity'").get(card.homeId) as { id: string; content: string; superseded_at: string | null } | undefined;
        if (own) return own.content !== "" ? { result: "already", localId: own.id, own: true } : { result: "rejected", why: "forgotten_here" };
      }
      const prior = idsByTag(card.serverId)[0];
      if (prior) return { result: "already", localId: prior };
      const content = redactSecrets(card.content, "[masked]");
      if (looksSecret(content) || !content.split("[masked]").join("").trim()) return { result: "rejected", why: "secret_like" };
      const same = card.fp ? fpIndex().get(card.fp) : undefined;
      if (same) return { result: "already", localId: same };
      const owner = getMemoryStoreInfo().ownerNamespace;
      const native = card.native ? redactSecrets(card.native, "[masked]") : undefined;
      const entry = store.insertMemoryEntryOnce({
        scope: "user_identity" as never, kind: card.kind as never, content, agentId: "agentlas-one",   // the owner's forget path needs an actor: the same one the personal agent's own lines have
        confidence: "medium", sensitivity: "internal", curationActor: "host_admitted",
        evidence: [SERVER_TAG, tagOf(card.serverId)], ...(native ? { contentNative: native } : {}),
        originClass: card.originClass, certainty: card.certainty,
        ...(card.ticketKind || card.boundary ? { requestContext: { ...(card.ticketKind ? { ticket_kind: card.ticketKind } : {}), ...(card.boundary ? { boundary: card.boundary } : {}) } as never } : {}),
      }, { key: importSourceKey(owner, "hope-server", sha16(card.serverId)), digest: importSourceDigest(card.kind, content, native), ownerNamespace: owner });
      if (!entry) {
        // the receipt exists: this card was taken before (or its words were forgotten here)
        const again = idsByTag(card.serverId)[0];
        return again ? { result: "already", localId: again } : { result: "rejected", why: "forgotten_here" };
      }
      if (card.fp && index) { index.byFp.set(card.fp, entry.id); index.mark = rowsMark(); }
      return { result: "written", localId: entry.id };
    } catch (error) {
      const name = (error as { name?: string; message?: string })?.name ?? "";
      const message = String((error as { message?: string })?.message ?? "");
      // the owner forgot these exact words here (the stamp), or the receipt says the card was forgotten here
      if (name === "MemoryRevokedError" || /exact-content-revoked|memory_revoked/.test(message)) return { result: "rejected", why: "forgotten_here" };
      return { result: "rejected", why: "write_failed" };
    }
  }
  function supersede(newLocalId: string, ref: string): void {
    const graph = req<typeof import("../memory/graph")>("../memory/graph");
    // `ref` is a card of the server (`f_…`, the line carries its tag) or the id of this computer's own line
    const olds = ref.startsWith(`${SERVER_TAG}:`) ? idsByTag(ref.slice(SERVER_TAG.length + 1)) : [...idsByTag(ref), ...((mem().prepare("SELECT id FROM memory_entries WHERE id=? AND scope='user_identity' AND content<>''").get(ref) as { id: string } | undefined) ? [ref] : [])];
    for (const id of olds) {
      if (id === newLocalId) continue;
      const row = mem().prepare("SELECT content FROM memory_entries WHERE id=? AND superseded_at IS NULL").get(id) as { content: string } | undefined;
      if (row) graph.supersedeExplicitMemory({ id: newLocalId }, graph.memoryBlockKey(row.content));
    }
  }
  function importMessages(items: unknown[]): { inserted: number; dropped: number; why: "bad_word" | "bad_date" | "too_long" | null; linked: boolean } {
    const db = app();
    // audit D3: the phone's word that this computer holds as its own line is not added again - the SAME function the move's import calls (server-import.ts `dropOwnWords`)
    const { kept } = dropOwnWords(db, items);
    const plan = planServerMessages(kept);
    const dropped = plan.dropped.badShape + plan.dropped.badDate + plan.dropped.tooLong;
    const why = plan.dropped.badShape ? "bad_word" as const : plan.dropped.badDate ? "bad_date" as const : plan.dropped.tooLong ? "too_long" as const : null;
    if (!plan.lines.length) return { inserted: 0, dropped, why, linked: true };
    const oneId = profileMod().getOneProfile().oneId;
    const ensure = (): string | null => {
      const sup = req<typeof import("./supervisor-store")>("./supervisor-store");
      return new sup.OneSupervisorStore(db).bindConversation(oneId, () => req<typeof import("../store/chats")>("../store/chats").createChat({ originSurface: "one", taskMode: "conversation", title: profileMod().getOneProfile().displayName }).id);
    };
    // audit D2: the words and the links to their turns are ONE transaction. When the link cannot be made the words still go in (they are the person's) and the caller is told `linked: false`: it does NOT acknowledge this page, so the server gives it
    // again and the words already here are linked then (an id already stored is linked too).
    const link = plan.turns.length ? () => req<typeof import("./server-turns")>("./server-turns").noteServerTurns(db, plan.turns) : undefined;
    let done: { inserted: number }; let linked = true;
    try { done = bundle().importConversation(db, oneId, plan.lines, ensure, 0, {}, link); }
    catch (error) { if (!link) throw error; linked = false; done = bundle().importConversation(db, oneId, plan.lines, ensure); }
    return { inserted: done.inserted, dropped, why, linked };
  }
  function homeRev(): number { return Math.max(1, Number(rowsMark()) || 1); }

  return { rowsMark, liveRows, rowFate, rowTurn, rowTurns, forgetServerTurns, settleServerWords, messages, resting, profile, forgetMatching, writeCard, supersede, importMessages, applyProfile, homeRev };
}
