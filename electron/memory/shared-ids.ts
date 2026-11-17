/*
 * the desktop's one table for the state of a SHARED-kind Personal line - `memory_shared_ids(memory_id PK, sid, state, said, fp, by_place, at)` in the account's own memory store (so an account switch,
 * a sign-out and a copy of the store all carry it with the lines it describes). The state of a line is read from here and nowhere else (a source tag only says where a line came from):
 *   S  shared    a row with a server id `sid` (the desktop's cache of a card the shared set holds)
 *   L  local     a row with no sid, final: this place only (the set had no room, or refused it); never sent again
 *   P  waiting   a live shared-kind line with NO row (computed, so no write path can forget to mark it)
 *   F  forgotten the person forgot the line here and the forget has not reached the server yet (sid or not); its `fp` is what the server is told
 * `said` = 1: the person said the same words again here (the server's "said at" is to be moved up). `by_place` = the place a taken card was said at (display only: "{agent} sent it"), never a decision.
 * Read by: the sync (shared-memory-sync.ts via shared-memory-real.ts), the memory screen's row marks, the delete confirmation. Deleted when: the line's forget reached the server, an `out` was applied, a change reached the server
 * (the old line's row), lost (every S row), the account's memory store goes. Size: one small row per shared line (about 150 bytes), bounded by the lines themselves; a sign-out keeps it.
 * Pure SQL over the memory store handle given: no Electron, no other module of the app (the memory store imports this file).
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type SharedIdState = "S" | "L" | "F";
export interface SharedIdRow { memoryId: string; sid: string | null; state: SharedIdState; said: 0 | 1; fp: string | null; by: string | null; at: string }

const sha = (text: string): Buffer => createHash("sha256").update(text).digest();
/** The server's fingerprint of a line's words (companion-one-mirror-ids.mjs `factFingerprint`): letters and digits only (NFKC, lower case), sha-256, first 32 hex; null when nothing is left. */
export function factFingerprint(text: string): string | null {
  const folded = String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return folded === "" ? null : sha(folded).toString("hex").slice(0, 32);
}

const ready = new WeakSet<object>();
/** The table, made once per store handle (a statement the store's own routing sends to the account's file). */
export function ensureSharedIdsTable(db: Database.Database): void {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS memory_shared_ids(
    memory_id TEXT PRIMARY KEY, sid TEXT, state TEXT NOT NULL CHECK(state IN ('S','L','F')), said INTEGER NOT NULL DEFAULT 0 CHECK(said IN (0,1)),
    fp TEXT, by_place TEXT, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_shared_ids_sid ON memory_shared_ids(sid);`);
  ready.add(db);
}

type Raw = { memory_id: string; sid: string | null; state: SharedIdState; said: number; fp: string | null; by_place: string | null; at: string };
const rowOf = (r: Raw): SharedIdRow => ({ memoryId: r.memory_id, sid: r.sid, state: r.state, said: r.said === 1 ? 1 : 0, fp: r.fp, by: r.by_place, at: r.at });

export function readSharedIdRows(db: Database.Database): Map<string, SharedIdRow> {
  ensureSharedIdsTable(db);
  return new Map((db.prepare("SELECT memory_id, sid, state, said, fp, by_place, at FROM memory_shared_ids").all() as Raw[]).map((r) => [r.memory_id, rowOf(r)]));
}
export function readSharedIdRow(db: Database.Database, memoryId: string): SharedIdRow | null {
  ensureSharedIdsTable(db);
  const r = db.prepare("SELECT memory_id, sid, state, said, fp, by_place, at FROM memory_shared_ids WHERE memory_id=?").get(memoryId) as Raw | undefined;
  return r ? rowOf(r) : null;
}
export function putSharedIdRow(db: Database.Database, row: Omit<SharedIdRow, "at"> & { at?: string }): void {
  ensureSharedIdsTable(db);
  db.prepare(`INSERT INTO memory_shared_ids(memory_id, sid, state, said, fp, by_place, at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(memory_id) DO UPDATE SET sid=excluded.sid, state=excluded.state, said=excluded.said, fp=excluded.fp, by_place=excluded.by_place, at=excluded.at`)
    .run(row.memoryId, row.sid, row.state, row.said, row.fp, row.by, row.at ?? new Date().toISOString());
}
export function deleteSharedIdRows(db: Database.Database, memoryIds: string[]): void {
  if (memoryIds.length === 0) return;
  ensureSharedIdsTable(db);
  const del = db.prepare("DELETE FROM memory_shared_ids WHERE memory_id=?");
  for (const id of memoryIds) del.run(id);
}
export function deleteAllSharedIdRowsOf(db: Database.Database, state: SharedIdState): void {
  ensureSharedIdsTable(db);
  db.prepare("DELETE FROM memory_shared_ids WHERE state=?").run(state);
}
export function sharedIdRowBySid(db: Database.Database, sid: string): SharedIdRow[] {
  ensureSharedIdsTable(db);
  return (db.prepare("SELECT memory_id, sid, state, said, fp, by_place, at FROM memory_shared_ids WHERE sid=?").all(sid) as Raw[]).map(rowOf);
}

// ───────────────────────── store meta (the cursor and the first merge's time) ─────────────────────────
export const SHARED_META = Object.freeze({
  /** the last server number applied (absent = none yet: the first pull is the "first merge") */ cursor: "shared:cursor",
  /** when the first merge happened (ms): the memory's "shared is open here" mark - the recall and the always-loaded piece read it, nothing else does */ mergedAt: "shared:mergedAt",
  /** when the last pull was applied (ms): past 30 days the whole set is asked for again */ pulledAt: "shared:pulledAt",
  /** the largest `forgotAllSeq` applied */ forgotAllSeq: "shared:forgotAllSeq",
});
export function readSharedMeta(db: Database.Database, key: string): string | null {
  try { const r = db.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(key) as { value?: unknown } | undefined; return r?.value === undefined ? null : String(r.value); } catch { return null; }
}
export function writeSharedMeta(db: Database.Database, key: string, value: string | null): void {
  if (value === null) db.prepare("DELETE FROM memory_store_meta WHERE key=?").run(key);
  else db.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
/** "Shared memory is open here": the first merge happened. The one question the recall, the always-loaded piece, the reading range and the check-in gate ask. */
export function sharedOpenHere(db: Database.Database): boolean {
  const v = readSharedMeta(db, SHARED_META.mergedAt);
  return v !== null && Number.isFinite(Number(v)) && Number(v) > 0;
}

// ───────────────────────── which Personal lines are shared kinds (the sync's table, in SQL) ─────────────────────────
const TICKET = "COALESCE(CASE WHEN json_valid(context_json) THEN json_extract(context_json,'$.ticket_kind') END,'')";
const HAS_BOUNDARY = "COALESCE(CASE WHEN json_valid(context_json) THEN json_extract(context_json,'$.boundary') END IS NOT NULL,0)";
/** SQL condition on `memory_entries` (unaliased): the line is a shared kind (fact, identity, or a boundary with its structure; a `boundary` with none stays by its column). */
export const SHARED_KIND_SQL = `(kind='fact' OR ${TICKET}='identity' OR (${TICKET}='boundary' AND ${HAS_BOUNDARY}))`;

/**
 * The person is forgetting this Personal line (the owner's own doors, before the line is blanked): a shared-kind line leaves an `F` row, so the forget is told to the server even when the line never had a card (P) -
 * its words' fingerprint is what the server forgets by. L lines are this place only: forgetting them tells nobody. Run BEFORE the line is blanked (the words are read here).
 */
export function noteHumanForget(db: Database.Database, memoryId: string): void {
  if (!sharedOpenHere(db)) return;   // I11: before the first merge nothing here changes (no table, no row)
  ensureSharedIdsTable(db);
  const line = db.prepare(`SELECT id, content, scope FROM memory_entries WHERE id=? AND scope='user_identity' AND content<>'' AND ${SHARED_KIND_SQL}`).get(memoryId) as { id: string; content: string } | undefined;
  if (!line) return;
  const row = readSharedIdRow(db, memoryId);
  if (row?.state === "L") return;
  let native: string | null = null;
  try { native = (db.prepare("SELECT content_native FROM memory_entry_native WHERE entry_id=?").get(memoryId) as { content_native?: string } | undefined)?.content_native?.trim() || null; } catch { native = null; }
  putSharedIdRow(db, { memoryId, sid: row?.sid ?? null, state: "F", said: 0, fp: factFingerprint(native ?? line.content) ?? row?.fp ?? null, by: row?.by ?? null });
}

/** The same words said again here by the person for a line the server already holds: the row is marked so the next run tells the server. No row (P, L, F) = nothing to mark. */
export function noteSaidAgain(db: Database.Database, memoryId: string): boolean {
  if (!sharedOpenHere(db)) return false;
  const row = readSharedIdRow(db, memoryId);
  if (!row || row.state !== "S" || row.sid === null) return false;
  if (row.said === 1) return true;
  putSharedIdRow(db, { ...row, said: 1 });
  return true;
}
