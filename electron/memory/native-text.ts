// Original-language ("native") wording of memory that is indexed in English.
// Plan 2026-09-22 §9-8 + desktop section 2026-09-23: the index, the recall
// query and the capsule sent to models are English; people see the original;
// the original is the authority and is never thrown away.
//
// Every table here is ADDITIVE and created lazily — the versioned schema ladder
// in store/db.ts is shared with concurrent work, and side tables need no step.
// This module is deliberately light (SQL only) so the store, the recall
// ranking and the UI projections can import it without a module cycle.
import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { autoLocalEmbedding, parseLocalEmbedding, type LocalMemoryEmbedding } from "./local-embedding";

type Db = ReturnType<typeof getDb>;

export type TranslationTargetKind = "memory_entry" | "memory_episode" | "experience_candidate";

const NATIVE_TABLES: Record<TranslationTargetKind, { table: string; key: string; column: string }> = {
  memory_entry: { table: "memory_entry_native", key: "entry_id", column: "content_native" },
  memory_episode: { table: "memory_episode_native", key: "episode_id", column: "summary_native" },
  experience_candidate: { table: "experience_candidate_native", key: "candidate_id", column: "summary_native" },
};

// ── language ─────────────────────────────────────────────────────────────────
// Same rule as the engine (Agentlas-OS one_workspace._latin_ratio): the share of
// WORDS written in ASCII, not letters — one long identifier (`mobilePairError`)
// must not make a Korean sentence count as English. Below 0.6 = not English.
const WORD_RE = /[\p{L}\p{M}\p{N}_]+/gu;
const LETTER_RE = /\p{L}/u;
export const ENGLISH_WORD_RATIO_FLOOR = 0.6;

export function asciiWordRatio(text: string): number {
  const words = (String(text ?? "").match(WORD_RE) ?? []).filter((word) => LETTER_RE.test(word));
  if (words.length === 0) return 1;
  // eslint-disable-next-line no-control-regex
  return words.filter((word) => /^[\x00-\x7f]+$/.test(word)).length / words.length;
}

export function isNonEnglishText(text: string | null | undefined): boolean {
  const value = String(text ?? "").trim();
  return value.length > 0 && asciiWordRatio(value) < ENGLISH_WORD_RATIO_FLOOR;
}

export function translationSourceHash(text: string): string {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

// ── tables ───────────────────────────────────────────────────────────────────
let ensuredFor: Db | null = null;

/**
 * Side tables + forget triggers. The triggers live in the database, so they
 * also fire for the terminal peer that shares this store and does not know
 * about the side tables: whenever a summary/content is emptied (the forget
 * paths) or the row is deleted, its original wording goes with it.
 */
export function ensureNativeTextTables(db: Db = getDb()): void {
  if (ensuredFor === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entry_native (
      entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
      content_native TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_episode_native (
      episode_id TEXT PRIMARY KEY,
      summary_native TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS experience_candidate_native (
      candidate_id TEXT PRIMARY KEY,
      summary_native TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_translation_jobs (
      target_kind TEXT NOT NULL
        CHECK(target_kind IN ('memory_entry','memory_episode','experience_candidate')),
      target_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','translated','kept_native')),
      attempts INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      translator TEXT,
      back_check REAL,
      english_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_translation_jobs_due
      ON memory_translation_jobs(state, priority DESC, created_at ASC);
    CREATE TRIGGER IF NOT EXISTS memory_entry_native_forget
      AFTER UPDATE OF content ON memory_entries
      WHEN NEW.content = ''
      BEGIN DELETE FROM memory_entry_native WHERE entry_id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS memory_entry_native_delete
      AFTER DELETE ON memory_entries
      BEGIN DELETE FROM memory_entry_native WHERE entry_id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS memory_episode_native_forget
      AFTER UPDATE OF summary ON memory_episodes
      WHEN NEW.summary IS NULL OR NEW.summary = ''
      BEGIN DELETE FROM memory_episode_native WHERE episode_id = NEW.episode_id; END;
    CREATE TRIGGER IF NOT EXISTS memory_episode_native_delete
      AFTER DELETE ON memory_episodes
      BEGIN DELETE FROM memory_episode_native WHERE episode_id = OLD.episode_id; END;
  `);
  // Vector of the original wording (JSON of the full embedding record), so the
  // recall ranking can take the better of the English and the original match.
  // memory_entry_native predates the column (cb74e874); add it in place.
  for (const { table } of Object.values(NATIVE_TABLES)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "native_embedding")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN native_embedding TEXT`);
    }
  }
  // experience_candidates is created by the experience ladder; a store opened
  // before that step simply has no candidate trigger yet (next open adds it).
  const hasCandidates = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'experience_candidates'",
  ).get();
  if (hasCandidates) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS experience_candidate_native_forget
        AFTER UPDATE OF summary ON experience_candidates
        WHEN NEW.summary IS NULL OR NEW.summary = ''
        BEGIN DELETE FROM experience_candidate_native WHERE candidate_id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS experience_candidate_native_delete
        AFTER DELETE ON experience_candidates
        BEGIN DELETE FROM experience_candidate_native WHERE candidate_id = OLD.id; END;
    `);
  }
  ensuredFor = db;
}

/** Test seam: a fresh store handle must re-run the idempotent DDL. */
export function resetNativeTextTablesForTests(): void {
  ensuredFor = null;
}

// ── reads ────────────────────────────────────────────────────────────────────
/** Original wording by id. Missing table/rows → empty map (English-only store). */
export function nativeTextsFor(kind: TranslationTargetKind, ids: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return result;
  const { table, key, column } = NATIVE_TABLES[kind];
  try {
    const db = getDb();
    // SQLite's default variable limit is 999 on older builds; stay well below.
    for (let offset = 0; offset < unique.length; offset += 400) {
      const chunk = unique.slice(offset, offset + 400);
      const rows = db.prepare(
        `SELECT ${key} AS id, ${column} AS text FROM ${table} WHERE ${key} IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk) as Array<{ id: string; text: string }>;
      for (const row of rows) if (row.text) result.set(row.id, row.text);
    }
  } catch {
    // table absent: nothing was ever translated on this store
  }
  return result;
}

export interface NativeRecall {
  text: string;
  vector: readonly number[];
}

export function serializeNativeEmbedding(embedding: LocalMemoryEmbedding): string {
  return JSON.stringify({
    model: embedding.model,
    adapter: embedding.adapter,
    modelSha256: embedding.modelSha256,
    contentHash: embedding.contentHash,
    dimensions: embedding.dimensions,
    vector: embedding.vector,
  });
}

function parseNativeEmbedding(raw: string | null, text: string): LocalMemoryEmbedding | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return parseLocalEmbedding(value.model, value.dimensions, JSON.stringify(value.vector ?? []), {
      adapter: value.adapter,
      modelSha256: value.modelSha256,
      contentHash: value.contentHash,
      text,
    });
  } catch {
    return null;
  }
}

/**
 * Original wording plus its vector, for the recall ranking's second channel.
 * A missing/stale vector (row written by the envelope path, or an embedding
 * asset update) is computed once and stored back — the same lazy backfill the
 * memory rows use. Missing table → empty map.
 */
export function nativeRecallFor(kind: TranslationTargetKind, ids: readonly string[]): Map<string, NativeRecall> {
  const result = new Map<string, NativeRecall>();
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return result;
  const { table, key, column } = NATIVE_TABLES[kind];
  try {
    const db = getDb();
    ensureNativeTextTables(db);
    const update = db.prepare(`UPDATE ${table} SET native_embedding = ? WHERE ${key} = ?`);
    for (let offset = 0; offset < unique.length; offset += 400) {
      const chunk = unique.slice(offset, offset + 400);
      const rows = db.prepare(
        `SELECT ${key} AS id, ${column} AS text, native_embedding AS embedding
           FROM ${table} WHERE ${key} IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk) as Array<{ id: string; text: string; embedding: string | null }>;
      for (const row of rows) {
        if (!row.text) continue;
        let embedding = parseNativeEmbedding(row.embedding, row.text);
        if (!embedding) {
          embedding = autoLocalEmbedding(row.text);
          try {
            update.run(serializeNativeEmbedding(embedding), row.id);
          } catch {
            // a read stays available under a concurrent peer
          }
        }
        result.set(row.id, { text: row.text, vector: embedding.vector });
      }
    }
  } catch {
    // table absent: nothing was ever translated on this store
  }
  return result;
}

/** What a person sees: the original wording when one exists, else the stored text. */
export function displayText(kind: TranslationTargetKind, id: string, stored: string): string {
  return nativeTextsFor(kind, [id]).get(id) ?? stored;
}

// ── write-path queue ─────────────────────────────────────────────────────────
/**
 * Queue a non-English row for background translation. Never blocks the turn:
 * SQL only, failures are swallowed (the migration sweep re-finds the row).
 */
export function enqueueEnglishTranslation(
  kind: TranslationTargetKind,
  id: string,
  text: string,
  priority = 10,
): boolean {
  if (!id || !isNonEnglishText(text)) return false;
  try {
    const db = getDb();
    ensureNativeTextTables(db);
    const now = new Date().toISOString();
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO memory_translation_jobs
         (target_kind, target_id, source_hash, priority, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(kind, id, translationSourceHash(text), priority, now, now);
    return inserted.changes === 1;
  } catch {
    return false;
  }
}
