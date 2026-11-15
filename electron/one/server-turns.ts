/*
 * Which conversation words of this computer came from which turn of the SERVER's personal agent (Agentlas 2.0 TH+MT, audit F2).
 *
 * A word taken from the server is stored as `hope-server:<seq>` (server-import.ts). The server forgets by turn (`gone[].turnId` / `turnIds`): the turn's words go from the server. Without a link from the word to its turn, the copy this
 * computer already took stays for ever after the person forgot the turn on the phone. This file is that link: one small table, made on first use (the way supervisor-store.ts makes its tables, no schema version).
 *
 *   one_server_words(message_id PRIMARY KEY -> chat_messages(id) ON DELETE CASCADE, turn_id, + an index on turn_id)
 *   Who writes: `noteServerTurns` (the import of the move and the mirror's take, in the SAME transaction as the words themselves: a word is never stored without its link, audit D2; both name a word's turn, an id already there is left as it is).
 *   Who reads: `forgetServerTurns` (the mirror's `gone` take) and nobody else.
 *   Who deletes: the word's own deletion (the cascade), `forgetServerTurns` (the words of the forgotten turn go, the row with them), and `sweepOrphanServerWords` (a row whose word is gone by a road the cascade did not take - a table rebuild with
 *   the foreign keys off, a restore): called once per process, from the first `settleServerWordsResidue` (the mirror's first signal; no timer).
 *   Size: one row per word taken from the server (about 80 bytes), never more than the words themselves.
 *
 * The words of a forgotten turn leave `chat_messages` with the page bytes zeroed (`secure_delete`, set for the delete only). The rewrite of the file that takes the old bytes out of the main database file (a TRUNCATE checkpoint) is a DEBT, the way
 * memory/stores.ts keeps `forget_residue_pending` (K7''): the delete's own transaction writes the debt (`meta` key `one_server_words_residue`), `settleServerWordsResidue` pays it ONCE per take page, WITHOUT waiting (that call only has `busy_timeout`
 * 0: another connection of the daemon or the terminal engine that holds a read snapshot cannot stop Main for the 15 seconds of db.ts, audit D1), and a busy answer leaves the debt for the next mirror signal or the next start of the app.
 * Who reads the debt: `settleServerWordsResidue` (an in-memory flag after the first read: a signal with no debt reads nothing). Who deletes it: that function, after a clean TRUNCATE. Size: one row, ever.
 * Text from the server never reaches a log line, a prompt module or a tool result from this file (it handles ids only).
 */
import type Database from "better-sqlite3";

const TURN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CHUNK = 400;
/** basis: the server's own ceiling on the turns one stamp names (`turnIds` <= 32, contracts/one-home-mirror.md section 2). At the limit: the rest are named by a later stamp. */
const TURNS_MAX = 32;
export const SERVER_WORDS_RESIDUE_KEY = "one_server_words_residue";

export function ensureServerWordsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS one_server_words (
    message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS one_server_words_turn ON one_server_words(turn_id);`);
}

/** Links words to turns. Only words that exist in `chat_messages` are linked (an id that was not stored is not). Returns how many links were made. A failure is NOT swallowed here (the caller decides: the words are not acknowledged, audit D2). */
export function noteServerTurns(db: Database.Database, pairs: Array<{ id: string; turnId: string }>): number {
  const good = pairs.filter((p) => typeof p.id === "string" && p.id.length > 0 && TURN_RE.test(p.turnId));
  if (!good.length) return 0;
  ensureServerWordsTable(db);
  const insert = db.prepare("INSERT OR IGNORE INTO one_server_words(message_id, turn_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM chat_messages WHERE id=?)");
  let made = 0;
  db.transaction(() => { for (const p of good) made += insert.run(p.id, p.turnId, p.id).changes; })();   // inside the import's transaction this is a savepoint: one atomic step
  return made;
}

/**
 * The words of these turns leave this computer. Returns how many words were deleted (a turn this computer never took deletes nothing). Another turn's words are never touched.
 * It does NOT wait for the file to be rewritten: the delete and the debt (`SERVER_WORDS_RESIDUE_KEY`) are ONE transaction; `settleServerWordsResidue` pays the debt. A `secure_delete` setting that cannot be put back is not swallowed: after the delete
 * (which has happened, with its debt) this throws `words_setting_not_restored`.
 */
export function forgetServerTurns(db: Database.Database, turnIds: string[]): number {
  const turns = [...new Set(turnIds.filter((t) => typeof t === "string" && TURN_RE.test(t)))].slice(0, TURNS_MAX);
  if (!turns.length) return 0;
  ensureServerWordsTable(db);
  let secure: unknown = null; let canSet = true;
  try { secure = db.pragma("secure_delete", { simple: true }); db.pragma("secure_delete = ON"); } catch { canSet = false; /* the delete still runs; the zeroing is lost and the connection keeps what it had */ }
  let deleted = 0;
  try {
    db.transaction(() => {
      for (let i = 0; i < turns.length; i += CHUNK) {
        const part = turns.slice(i, i + CHUNK);
        const marks = part.map(() => "?").join(",");
        deleted += db.prepare(`DELETE FROM chat_messages WHERE id IN (SELECT message_id FROM one_server_words WHERE turn_id IN (${marks}))`).run(...part).changes;
        db.prepare(`DELETE FROM one_server_words WHERE turn_id IN (${marks})`).run(...part);   // a row whose word was already gone
      }
      if (deleted) db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(SERVER_WORDS_RESIDUE_KEY, new Date().toISOString());   // the debt, in the same transaction: a kill keeps it
    }).immediate();
  } finally {
    if (canSet) {
      const back = `secure_delete = ${secure === 1 || secure === true ? "ON" : secure === 2 ? "FAST" : "OFF"}`;
      let restored = false;
      try { db.pragma(back); restored = true; } catch { /* once more below */ }
      if (!restored) { try { db.pragma(back); restored = true; } catch { /* reported below */ } }
      if (!restored) { debtKnown.set(db, true); throw new Error("words_setting_not_restored"); }
    }
  }
  if (deleted) debtKnown.set(db, true);
  return deleted;
}

// ── the debt ──
const debtKnown = new WeakMap<Database.Database, boolean>();
const readDebt = (db: Database.Database): string | null => {
  try { const row = db.prepare("SELECT value FROM meta WHERE key=?").get(SERVER_WORDS_RESIDUE_KEY) as { value?: unknown } | undefined; return typeof row?.value === "string" ? row.value : null; } catch { return null; }
};

/**
 * Pays the debt of the deleted words: a TRUNCATE checkpoint that does NOT wait. `none` = nothing was owed (no query after the first call of the process), `clean` = the file was rewritten and the debt is gone, `busy` = another connection holds
 * the log (the debt stays; the next mirror signal or the next start asks again), `failed` = the checkpoint itself failed (the debt stays). The first call of a process also takes the links of words that are gone by another road (`sweepOrphanServerWords`).
 */
export function settleServerWordsResidue(db: Database.Database): "none" | "clean" | "busy" | "failed" {
  let known = debtKnown.get(db);
  if (known === undefined) { sweepOrphanServerWords(db); known = readDebt(db) !== null; debtKnown.set(db, known); }
  if (!known) return "none";
  const mark = readDebt(db);
  if (mark === null) { debtKnown.set(db, false); return "none"; }
  let previous: number;
  try { previous = Number(db.pragma("busy_timeout", { simple: true })); if (!Number.isFinite(previous) || previous < 0) previous = 0; } catch { return "failed"; }
  let busy = true; let checkpointed = false;
  try {
    db.pragma("busy_timeout = 0");   // this call only: Main never waits for another connection's read snapshot (db.ts's 15 s stays for everything else)
    const row = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>;
    busy = !!row?.[0]?.busy; checkpointed = true;
  } catch { /* failed: the debt stays */ }
  finally {
    const back = `busy_timeout = ${Math.floor(previous)}`;
    try { db.pragma(back); } catch { db.pragma(back); }   // a second try; a second failure is NOT swallowed (a Main with no lock wait would fail every other write)
  }
  if (!checkpointed) return "failed";
  if (busy) return "busy";
  try { db.prepare("DELETE FROM meta WHERE key=? AND value=?").run(SERVER_WORDS_RESIDUE_KEY, mark); } catch { return "failed"; }
  debtKnown.set(db, readDebt(db) !== null);
  return "clean";
}

/** A link whose word is gone by another road (a chat deleted with the foreign keys off, a restore). Bounded by the table itself. Does not make the table: an app that never took a word from the server has nothing to sweep. */
export function sweepOrphanServerWords(db: Database.Database): number {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_server_words'").get()) return 0;
    return db.prepare("DELETE FROM one_server_words WHERE message_id NOT IN (SELECT id FROM chat_messages)").run().changes;
  } catch { return 0; }
}
