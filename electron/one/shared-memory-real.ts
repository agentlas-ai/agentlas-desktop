/*
 * The real stores and the real wiring behind the shared-memory sync: lazy requires only, so the sync's logic (shared-memory-sync.ts) can be driven by a fake server and a scratch store.
 * It is the ONLY place that knows how a Personal line is read here and how a card of the server is put in:
 *   - lines: `memory_entries` scope `user_identity`, live = not superseded and not blanked; the two Personal columns `preference` / `fact` (an `identity` or `boundary` the model gave is kept in `context_json.ticket_kind`
 *     with its structure in `context_json.boundary`);
 *   - a card of the server is written through `insertMemoryEntryOnce` with an import receipt (a forgotten card is never written again, the same card never twice) and the source tag `hope-server-fact:<server id>` in its
 *     evidence - the same tag and receipt the old mirror used, so a card taken by the old mirror is "already" here;
 *   - a forget is the owner's own forget path (the same call the memory screen makes): the line is blanked, stamped, and leaves the recall index with it.
 * Nothing is stored here: the record of what the server holds is the sync's own `meta` row.
 * Who starts it: the mobile bridge runtime, in whichever process holds the bridge (Desktop Main or the background service), next to the place link (the same one-process-at-a-time lease).
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { SHARED_SOURCE_TAG, createSharedMemorySync, factFingerprint, type CallAnswer, type CardWrite, type EvictedNote, type PersonalLine, type SharedMemorySync, type SharedStorePort } from "./shared-memory-sync";
import { SHARED_KIND_SQL, deleteSharedIdRows, putSharedIdRow, readSharedIdRows, readSharedMeta, writeSharedMeta, type SharedIdRow } from "../memory/shared-ids";
import type { PluralAnswer } from "../mobile-bridge/places-link";

/* eslint-disable @typescript-eslint/no-require-imports */
const req = <T>(id: string): T => require(id) as T;

const tagOf = (serverId: string): string => `${SHARED_SOURCE_TAG}:${serverId}`;
const sha16 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const SERVER_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const SHARED_STATE_KEY = (userId: string): string => `one_shared_memory:v1:${userId}`;

export function realSharedStore(): SharedStorePort {
  const mem = (): Database.Database => req<typeof import("../memory/database")>("../memory/database").getMemoryDb();

  function rowsMark(): string {
    try { return String((mem().prepare("SELECT value FROM memory_store_meta WHERE key=?").get("revision") as { value?: unknown } | undefined)?.value ?? "0"); } catch { return "0"; }
  }
  function nativeOf(ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    try { for (let i = 0; i < ids.length; i += 400) { const part = ids.slice(i, i + 400); for (const r of mem().prepare(`SELECT entry_id, content_native FROM memory_entry_native WHERE entry_id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ entry_id: string; content_native: string }>) out.set(r.entry_id, r.content_native); } } catch { /* the table is absent on a store that never had an English line */ }
    return out;
  }
  function liveLines(): PersonalLine[] {
    // `readable`: the same filter the ceiling and the recall use (store.ts readableLinesClause) - a line of the old overlay channel or one the owner switched off is live here but is not sent up as the person's words
    const unreadable = req<typeof import("../memory/store")>("../memory/store").readableLinesClause(mem());
    const rows = mem().prepare(`SELECT id, kind, content, context_json, created_at, origin_class, certainty, ${unreadable ? `(1 ${unreadable})` : "1"} AS readable FROM memory_entries WHERE scope='user_identity' AND superseded_at IS NULL AND content<>'' AND kind IN ('preference','fact') ORDER BY created_at, id`).all() as Array<{
      id: string; kind: "preference" | "fact"; content: string; context_json: string | null; created_at: string; origin_class: string | null; certainty: string | null; readable: number }>;
    const natives = nativeOf(rows.map((r) => r.id));
    return rows.map((r) => {
      let ticketKind: PersonalLine["ticketKind"] = null; let boundary: PersonalLine["boundary"] = null; let grounded = r.origin_class === "user";
      try {
        const c = JSON.parse(r.context_json || "{}") as { ticket_kind?: unknown; boundary?: unknown; grounded?: unknown };
        if (typeof c.grounded === "boolean") grounded = c.grounded;
        if (c.ticket_kind === "identity" || c.ticket_kind === "boundary") ticketKind = c.ticket_kind;
        const b = c.boundary as { type?: unknown; from?: unknown; to?: unknown } | undefined;
        if (b && (b.type === "no_proactive" || b.type === "quiet_hours")) boundary = { type: b.type, ...(typeof b.from === "string" ? { from: b.from } : {}), ...(typeof b.to === "string" ? { to: b.to } : {}) };
      } catch { /* no context */ }
      return { id: r.id, kind: r.kind, ticketKind, boundary, content: r.content, native: natives.get(r.id) ?? null, originClass: r.origin_class, certainty: r.certainty, createdAt: r.created_at, grounded, readable: r.readable === 1 };
    });
  }
  function fateOf(id: string): "forgotten" | "replaced" {
    try { if (mem().prepare("SELECT 1 FROM memory_revocation_sources WHERE source_memory_id=? LIMIT 1").get(id)) return "forgotten"; } catch { /* no table: replaced */ }
    return "replaced";
  }
  /** old local id -> the live line that replaced it: the `supersedes` edge (from = the newer line), followed up to eight edits. */
  function successorsOf(oldIds: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const db = mem();
    const next = new Map<string, string>();
    try {
      let frontier = oldIds.slice();
      for (let hop = 0; hop < 8 && frontier.length; hop += 1) {
        const found: Array<{ old: string; next: string }> = [];
        for (let i = 0; i < frontier.length; i += 400) {
          const part = frontier.slice(i, i + 400);
          found.push(...db.prepare(`SELECT to_memory_id AS old, from_memory_id AS next FROM memory_relation_edges WHERE relation_type='supersedes' AND to_memory_id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ old: string; next: string }>);
        }
        frontier = [];
        for (const f of found) { if (!next.has(f.old)) next.set(f.old, f.next); frontier.push(f.next); }
      }
    } catch { return out; }
    const liveIds = new Set<string>();
    const all = [...new Set([...next.values()])];
    try { for (let i = 0; i < all.length; i += 400) { const part = all.slice(i, i + 400); for (const r of db.prepare(`SELECT id FROM memory_entries WHERE scope='user_identity' AND superseded_at IS NULL AND content<>'' AND id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ id: string }>) liveIds.add(r.id); } } catch { return out; }
    for (const old of oldIds) {
      let cur = next.get(old); let guard = 0;
      while (cur !== undefined && !liveIds.has(cur) && guard < 8) { cur = next.get(cur); guard += 1; }
      if (cur !== undefined && liveIds.has(cur)) out.set(old, cur);
    }
    return out;
  }
  // The lines that carry a server card's source tag, by server id: read ONCE per run (one scan of the lines that carry any tag) and kept up to date by this store's own writes. The scan used to run once per card
  // (a 700-card pull scanned the whole table 700+ times). This object lives for one run; a line another process writes meanwhile is found by the next run.
  let tagMap: Map<string, string[]> | null = null;
  function tagIndex(): Map<string, string[]> {
    if (tagMap) return tagMap;
    const map = new Map<string, string[]>();
    const rows = mem().prepare("SELECT id, evidence_json FROM memory_entries WHERE scope='user_identity' AND content<>'' AND evidence_json LIKE ?").all(`%"${SHARED_SOURCE_TAG}:%`) as Array<{ id: string; evidence_json: string }>;
    for (const r of rows) {
      let evidence: unknown = [];
      try { evidence = JSON.parse(r.evidence_json); } catch { /* not a list */ }
      if (Array.isArray(evidence)) for (const e of evidence) if (typeof e === "string" && e.startsWith(`${SHARED_SOURCE_TAG}:`)) { const sid = e.slice(SHARED_SOURCE_TAG.length + 1); (map.get(sid) ?? map.set(sid, []).get(sid)!).push(r.id); }
    }
    return tagMap = map;
  }
  function idsByTag(serverId: string): string[] {
    if (!SERVER_ID_RE.test(serverId)) return [];
    // a line forgotten (blanked) since the scan is not found: one primary-key look per hit
    return (tagIndex().get(serverId) ?? []).filter((id) => mem().prepare("SELECT 1 FROM memory_entries WHERE id=? AND content<>''").get(id) !== undefined);
  }
  /** The owner's own forget path for one Personal line, applied for a forget that came from ANOTHER place. The fences are read fresh from the line itself. */
  function forgetOne(id: string): void {
    const om = req<typeof import("../memory/owner-mutations")>("../memory/owner-mutations");
    const dbm = req<typeof import("../memory/database")>("../memory/database");
    const row = om.ownedMemoryRecord(id);
    om.forgetOwnedMemory({ memoryId: id, ownerRef: om.currentMemoryOwnerRef(), actorId: om.learningActor(row), expectedRevision: om.memoryTargetRevision(row), expectedEpoch: dbm.getMemoryStoreInfo().revocationEpoch }, { remote: true });
  }
  const wordsOf = (x: PersonalLine): string[] => [x.native, x.content].map((t) => (t ? factFingerprint(t) : null)).filter((f): f is string => f !== null);
  /** A forget from another place: the lines of this card, this local id, and every live shared-kind line (S, P, L - never a preference) with the same words. */
  function remoteForget(match: { localId?: string; sid?: string; fp?: string }): string[] {
    const lines = liveLines().filter((l) => sharedKindOfLine(l));
    const byId = new Map(lines.map((l) => [l.id, l]));
    const ids = new Set<string>(); const fps = new Set<string>(match.fp && /^[a-f0-9]{32}$/.test(match.fp) ? [match.fp] : []);
    const take = (id: string): void => { const l = byId.get(id); if (l) { ids.add(id); for (const f of wordsOf(l)) fps.add(f); } };
    if (match.localId) take(match.localId);
    if (match.sid) {
      const rows = readSharedIdRows(mem());
      for (const r of rows.values()) if (r.sid === match.sid) { take(r.memoryId); if (r.fp) fps.add(r.fp); }
      for (const id of idsByTag(match.sid)) take(id);
    }
    if (fps.size) for (const l of lines) if (wordsOf(l).some((f) => fps.has(f))) ids.add(l.id);
    const forgotten: string[] = [];
    for (const id of ids) { try { forgetOne(id); forgotten.push(id); } catch { /* already forgotten, changed a moment ago, or not the owner's */ } }
    // a forget of the same words that was waiting to be sent is now moot: the server forgot them itself
    if (fps.size) { const rows = readSharedIdRows(mem()); deleteSharedIdRows(mem(), [...rows.values()].filter((r) => r.state === "F" && r.fp !== null && fps.has(r.fp)).map((r) => r.memoryId)); }
    return forgotten;
  }
  const sharedKindOfLine = (l: PersonalLine): boolean => l.ticketKind === "identity" || (l.ticketKind === "boundary" ? l.boundary !== null || l.kind === "fact" : l.kind === "fact");
  function remoteForgetAll(beforeIso: string): string[] {
    const rows = mem().prepare(`SELECT id FROM memory_entries WHERE scope='user_identity' AND superseded_at IS NULL AND content<>'' AND created_at<=? AND ${SHARED_KIND_SQL}`).all(beforeIso) as Array<{ id: string }>;
    const forgotten: string[] = [];
    for (const r of rows) { try { forgetOne(r.id); forgotten.push(r.id); } catch { /* as above */ } }
    return forgotten;
  }
  function writeCard(card: CardWrite): { result: "written" | "already" | "rejected"; localId?: string; why?: string } {
    try {
      const store = req<typeof import("../memory/store")>("../memory/store");
      const { importSourceDigest, importSourceKey } = req<typeof import("../memory/import-source-receipt")>("../memory/import-source-receipt");
      const { getMemoryStoreInfo } = req<typeof import("../memory/database")>("../memory/database");
      const { looksSecret, redactSecrets } = req<typeof import("../../shared/secret-patterns")>("../../shared/secret-patterns");
      const prior = idsByTag(card.sid)[0];
      if (prior) return { result: "already", localId: prior };
      const content = redactSecrets(card.content, "[masked]");
      if (looksSecret(content) || !content.split("[masked]").join("").trim()) return { result: "rejected", why: "secret_like" };
      const owner = getMemoryStoreInfo().ownerNamespace;
      const native = card.native ? redactSecrets(card.native, "[masked]") : undefined;
      const entry = store.insertMemoryEntryOnce({
        scope: "user_identity" as never, kind: card.kind as never, content, agentId: "agentlas-one",   // the owner's forget path needs an actor: the same one the personal agent's own lines have
        confidence: "medium", sensitivity: "internal", curationActor: "host_admitted",
        evidence: [SHARED_SOURCE_TAG, tagOf(card.sid)], ...(native ? { contentNative: native } : {}),
        originClass: card.originClass, certainty: card.certainty,
        // a card the server hands over is never held back by a stamp of the same words here: the server takes forgotten words back only when the person said them again, and its answer is that word
        restatedByOwner: true,
        ...(card.ticketKind || card.boundary ? { requestContext: { ...(card.ticketKind ? { ticket_kind: card.ticketKind } : {}), ...(card.boundary ? { boundary: card.boundary } : {}) } as never } : {}),
      }, { key: importSourceKey(owner, "hope-server", sha16(card.sid)), digest: importSourceDigest(card.kind, content, native), ownerNamespace: owner });
      if (!entry) {
        // the receipt exists: this card was taken before (or its words were forgotten here)
        const again = idsByTag(card.sid)[0];
        return again ? { result: "already", localId: again } : { result: "rejected", why: "forgotten_here" };
      }
      (tagIndex().get(card.sid) ?? tagIndex().set(card.sid, []).get(card.sid)!).push(entry.id);
      return { result: "written", localId: entry.id };
    } catch (error) {
      const name = (error as { name?: string } | null)?.name ?? "";
      const message = String((error as { message?: string } | null)?.message ?? "");
      // the owner forgot these exact words here (the stamp), or the receipt says the card was forgotten here
      if (name === "MemoryRevokedError" || /exact-content-revoked|memory_revoked/.test(message)) return { result: "rejected", why: "forgotten_here" };
      return { result: "rejected", why: "write_failed" };
    }
  }
  /** A plain retirement (superseded, kept in the history) of the live lines of a local id / a card (its rows and its source tag): no owner forget, so no stamp: the same words may be written here again. */
  function withdrawMatching(match: { localId?: string; sid?: string }): string[] {
    const ids = new Set<string>();
    if (match.localId) { const r = mem().prepare("SELECT id FROM memory_entries WHERE id=? AND scope='user_identity' AND superseded_at IS NULL AND content<>''").get(match.localId) as { id: string } | undefined; if (r) ids.add(r.id); }
    if (match.sid) {
      for (const id of idsByTag(match.sid)) ids.add(id);
      for (const r of readSharedIdRows(mem()).values()) if (r.sid === match.sid) ids.add(r.memoryId);
    }
    const live = [...ids].filter((id) => mem().prepare("SELECT 1 FROM memory_entries WHERE id=? AND superseded_at IS NULL AND content<>''").get(id));
    if (live.length) req<typeof import("../memory/store")>("../memory/store").supersedeMemoryEntries(live);
    return live;
  }
  /** the lines that came from other places (their source tag) are erased with NO stamp - blanked like a forget but no words are stamped, so a new pairing brings them back by the first merge. What was said here stays. */
  function eraseReceived(): string[] {
    const db = mem();
    const ids = [...tagIndex().values()].flat().filter((id) => db.prepare("SELECT 1 FROM memory_entries WHERE id=? AND content<>''").get(id) !== undefined);
    const now = new Date().toISOString();
    const blank = db.prepare(`UPDATE memory_entries SET content='', evidence_json='[]', context_json='{}', chat_id=NULL, embedding_model=NULL, embedding_adapter=NULL, embedding_model_sha256=NULL,
      embedding_content_hash=NULL, embedding_dimensions=NULL, embedding_json=NULL, superseded_at=COALESCE(superseded_at, ?) WHERE id=?`);
    db.transaction(() => {
      for (const id of ids) {
        db.prepare("DELETE FROM memory_relation_edges WHERE from_memory_id=? OR to_memory_id=?").run(id, id);
        try { db.prepare("DELETE FROM memory_entry_native WHERE entry_id=?").run(id); } catch { /* no table */ }
        blank.run(now, id);
      }
      const rows = readSharedIdRows(db);
      const gone = new Set(ids);
      deleteSharedIdRows(db, [...rows.values()].filter((r) => gone.has(r.memoryId) || r.state === "F").map((r) => r.memoryId));
      for (const r of rows.values()) if (r.state === "S" && !gone.has(r.memoryId)) putSharedIdRow(db, { ...r, sid: null, state: "L", said: 0, by: null });
    }).immediate();
    tagMap = null;
    return ids;
  }
  /** One card in the conversation the line was said in (a display row, never the model's input): shown by the chat screen as "oldest memory deleted". Never throws. */
  function evictedNotice(note: EvictedNote, lineId: string): void {
    try { req<typeof import("./memory-room-notice")>("./memory-room-notice").recordMemoryRoomNotice({ lineId, scope: "all", count: note.count, text: note.text, saidAt: note.saidAt }); } catch { /* a card that cannot be written is a log line at most: the memory itself is already settled */ }
  }
  function takeLegacyRows(userId: string): Array<{ localId: string; sid: string }> | null {
    try {
      const meta = req<typeof import("../store/meta")>("../store/meta");
      const key = SHARED_STATE_KEY(userId);
      const raw = meta.getMeta(key);
      if (!raw) return null;
      let rows: Array<{ localId: string; sid: string }> = [];
      try { const v = JSON.parse(raw) as { rows?: Record<string, { sid?: unknown }> }; rows = Object.entries(v.rows ?? {}).filter(([, r]) => r && typeof r.sid === "string" && SERVER_ID_RE.test(r.sid as string)).map(([localId, r]) => ({ localId, sid: r.sid as string })); } catch { rows = []; }
      meta.setMeta(key, "");
      return rows;
    } catch { return null; }
  }
  /** The old mirror's record of this account goes (an empty value is what the mirror's own `forget` writes). */
  function firstMergeDone(userId: string): void { try { req<typeof import("../store/meta")>("../store/meta").setMeta(`one_mirror:v1:${userId}`, ""); } catch { /* the mirror switch reads off already */ } }
  const idRows = (): Map<string, SharedIdRow> => readSharedIdRows(mem());
  const putIdRow = (row: Omit<SharedIdRow, "at">): void => putSharedIdRow(mem(), row);
  const deleteIdRows = (ids: string[]): void => deleteSharedIdRows(mem(), ids);
  const readMeta = (key: string): string | null => readSharedMeta(mem(), key);
  const writeMeta = (key: string, value: string | null): void => writeSharedMeta(mem(), key, value);
  return { rowsMark, liveLines, idRows, putIdRow, deleteIdRows, readMeta, writeMeta, fateOf, successorsOf, remoteForget, remoteForgetAll, writeCard, withdrawMatching, eraseReceived, evictedNotice, takeLegacyRows, firstMergeDone };
}

export interface SharedMemoryStartDeps {
  /** The web service's origin (no trailing slash). */
  origin(): string;
  /** One request with the login session's cookie (fetchWithHubSession); null when nobody is signed in. */
  request(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }): Promise<{ status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }> | null;
  userId(): string | null;
  /** This desktop's host id (the one its place is registered under): every push and pull names it. */
  hostId(): string;
  log?(line: string): void;
}
/** basis: the web service's own wait for the shared-memory service is 15 s for a push and 10 s for a pull (shared-memory-service-client.ts); 20 s here stays above both. At the limit: the request counts as a timeout and is tried again by the ladder. */
export const SHARED_REQUEST_TIMEOUT_MS = 20_000;

/** The signed request of the real wiring (a fake server in a gate uses the same one over loopback). */
export function realCall(deps: Pick<SharedMemoryStartDeps, "origin" | "request">): (method: "GET" | "POST", route: string, body?: unknown) => Promise<CallAnswer> {
  return async (method, route, body) => {
    const url = `${deps.origin().replace(/\/$/, "")}${route}`;
    try {
      const pending = deps.request(url, { method, headers: { "x-agentlas-client": "desktop", accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (!pending) return { ok: false, status: 401, code: "signed_out" };
      const res = await pending;
      let json: Record<string, unknown> | null = null;
      try { const parsed: unknown = JSON.parse(await res.text()); json = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { json = null; }
      const header = Number(res.headers?.get("retry-after"));
      const bodyWait = Number(json?.retryAfterSeconds ?? json?.retryAfter);
      const seconds = Number.isFinite(header) && header > 0 ? header : Number.isFinite(bodyWait) && bodyWait > 0 ? bodyWait : undefined;
      const ok = res.status >= 200 && res.status < 300;
      return { ok, status: res.status, ...(typeof json?.error === "string" ? { code: json.error } : {}), ...(seconds !== undefined ? { retryAfterMs: Math.round(seconds * 1000) } : {}), body: json };
    } catch { return { ok: false, status: 0, unreachable: true, code: "server_unreachable" }; }
  };
}

/**
 * The bridge's process starts the sync. Triggers, no timer: a Personal line written here (`onMemoryRowsChanged`), a Personal line written by the OTHER process (Main hears the background service through its data_version
 * watch: one/foreign-memory-rows.ts), the plural answer of the place link. Returns the stop.
 */
export function startSharedMemorySync(deps: SharedMemoryStartDeps): { stop(): void; sync: SharedMemorySync } {
  const meta = (): typeof import("../store/meta") => req("../store/meta");
  const sync = createSharedMemorySync({
    now: () => Date.now(),
    userId: deps.userId,
    hostId: deps.hostId,
    store: () => { try { return realSharedStore(); } catch { return null; } },
    call: realCall(deps),
    sleep: (ms) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }),
    ...(deps.log ? { log: deps.log } : {}),
  });
  const stops: Array<() => void> = [];
  const quiet = (fn: () => void): void => { try { fn(); } catch { /* a trigger that cannot be wired leaves the others */ } };
  quiet(() => stops.push(req<typeof import("../memory/memory-written-signal")>("../memory/memory-written-signal").onMemoryRowsChanged(() => { void sync.signal("memory").catch(() => undefined); })));
  quiet(() => { const foreign = req<typeof import("./foreign-memory-rows")>("./foreign-memory-rows").foreignMemoryRows(); stops.push(foreign.onChanged(() => { void sync.signal("memory").catch(() => undefined); })); foreign.start(); });
  quiet(() => {
    const places = req<typeof import("../mobile-bridge/places-link")>("../mobile-bridge/places-link");
    const onAnswer = (a: PluralAnswer): void => { void sync.answer({ sharedSeq: a.sharedSeq, sharedOpen: a.sharedOpen }).catch(() => undefined); };
    stops.push(places.onPluralAnswer(onAnswer));
    const last = places.lastPluralAnswer();
    if (last) onAnswer(last);
  });
  // An explicit sign-out does NOT clear the record: it is the account's own (the key carries the user id) and the account's memory store stays too; a record that is gone makes the next sign-in send every
  // shared line again and bring back a card another place forgot more than 31 days ago (the tombstone's life), on every place.
  return { sync, stop: () => { sync.stop(); for (const stop of stops.splice(0)) quiet(stop); } };
}
