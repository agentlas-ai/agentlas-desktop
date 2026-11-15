// 2.0 K1: the four nullable columns a memory store made before them gets once (items 1-2; engine twin: Agentlas-OS agentlas_cloud/memory_stores.py `ensure_k1_columns`).
//   memory_entries.origin_class / certainty / derived_by   memory_episodes.detail_json   (all TEXT, NULL for every row that exists)
// ★Nothing reads or writes a new column yet (K2/K3/K5 do). This file only makes the shape the same everywhere: the engine adds them to the stores it opens, the desktop adds them to the ones it opens,
//   whichever opens first, and neither fails when the other was first ("duplicate column" is never an error here).
// ★One meta row (`store_columns` = `k1`) says "done": a marked store costs ONE meta read per open and nothing else. The ALTERs and the marker go in one transaction, so a process killed in the middle
//   leaves either nothing or everything. A locked file is left for the next open (the wait is the connection's own busy timeout, so it ends). The state is a code, never a sentence.
// ★No Electron import (the daemon and the tests open the same files).
import type Database from "better-sqlite3";

export const COLUMNS_KEY = "store_columns";
export const COLUMNS_VALUE = "k1";
export const K1_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["memory_entries", "origin_class"], ["memory_entries", "certainty"], ["memory_entries", "derived_by"], ["memory_episodes", "detail_json"],
];
/** present = marked already (one meta read) · added = columns added and marked · partial = a table of the columns is not in this file yet, the rest was added, no mark (next open looks again) ·
 * locked = another process holds the file or it cannot be written, nothing changed (next open does it) · no_meta = not a memory store. */
export type K1ColumnsState = "present" | "added" | "partial" | "locked" | "no_meta";

const SCHEMA_NAME = /^[A-Za-z_]\w*$/;

/**
 * Add the K1 columns a store lacks, once. `schema` is the attached name of the store on `db` ("agentlas_memory" for the root on the product connection, "main" for a store opened on its own).
 * Safe on every open and from two processes. Never throws over a database error (a store that cannot take the columns now is read and written as it was: no code reads a new column before K2).
 * A transaction the caller already has is joined, not committed.
 */
export function ensureK1Columns(db: Database.Database, schema = "main"): K1ColumnsState {
  if (!SCHEMA_NAME.test(schema)) throw new Error("memory_schema_name_invalid");
  const own = !db.inTransaction;
  let began = false;
  try {
    if (!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name='memory_store_meta'`).get()) return "no_meta";
    const marked = db.prepare(`SELECT value FROM ${schema}.memory_store_meta WHERE key=?`).get(COLUMNS_KEY) as { value?: unknown } | undefined;
    if (marked?.value === COLUMNS_VALUE) return "present";
    if (own) { db.exec("BEGIN IMMEDIATE"); began = true; }
    let complete = true;
    for (const [table, column] of K1_COLUMNS) {
      const have = new Set((db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
      if (!have.size) complete = false;
      else if (!have.has(column)) db.exec(`ALTER TABLE ${schema}.${table} ADD COLUMN ${column} TEXT`);
    }
    if (complete) db.prepare(`INSERT OR REPLACE INTO ${schema}.memory_store_meta(key,value) VALUES(?,?)`).run(COLUMNS_KEY, COLUMNS_VALUE);
    if (began) { db.exec("COMMIT"); began = false; }
    return complete ? "added" : "partial";
  } catch (error) {
    if (began) { try { db.exec("ROLLBACK"); } catch { /* the connection already rolled back */ } }
    // Any SQLite error (busy, locked, a second process that added a column between the look and the ALTER, a read-only file) means "not now": the next open does it.
    if ((error as { name?: string })?.name === "SqliteError" || typeof (error as { code?: unknown })?.code === "string" && String((error as { code: string }).code).startsWith("SQLITE_")) return "locked";
    throw error;
  }
}

/** The four column names as they appear on a row read with `SELECT *`/`m.*`. */
const K1_ROW_KEYS: readonly string[] = K1_COLUMNS.map(([, column]) => column);

/**
 * A row read with `SELECT *` from a store that has the K1 columns, shaped as the same row from a store that does not: a K1 key whose value is NULL is left out. Used where a whole row is hashed
 * (a revision token the screen and the phone hold, a cache fingerprint), so the token of a line does not change because its file gained four empty columns. A key with a value stays (K2 and later).
 */
export function withoutNullK1<T extends object>(row: T): T {
  const record = row as Record<string, unknown>;
  if (!K1_ROW_KEYS.some(key => key in record && record[key] === null)) return row;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (!(K1_ROW_KEYS.includes(key) && value === null)) copy[key] = value;
  return copy as T;
}
