// The one thing of the old English migration that stays: applying an English wording to a stored line (the engine's English backfill reaches the app through one-import.ts), with the original wording moved to its
// side table (native-text.ts), atomically, only if the row is exactly what was translated (hash) and still live. A forget that happened meanwhile wins.
//
// K3' (Agentlas 2.0): the migration WORKER is gone - the idle scheduler, the translator prompt, the batch runner, the sweep that queued every non-English row, the write-path queue, the daily budget. Nothing queues a
// line for translation any more and nothing calls a model to translate. A line's English is made when the resting-time gathering rewrites or condenses that line (a ticket carries the person's own words and the
// English together: gathering.ts); a line nobody touches stays as it is, and recall reads both channels (native-text.ts nativeRecallFor). The old queue table keeps its rows (K5' clears them); nothing reads them.
import { getMemoryDb as getDb } from "./database";
import { autoLocalEmbedding, type LocalMemoryEmbedding } from "./local-embedding";
import { assertMemoryWriteAllowed, MemoryRevokedError } from "./revocations";
import { serializeNativeEmbedding, translationSourceHash, type TranslationTargetKind } from "./native-text";

type Db = ReturnType<typeof getDb>;

export interface Job {
  kind: TranslationTargetKind;
  id: string;
  sourceHash: string;
  attempts: number;
  /** The row's last reason; only the batch builder reads it (a split cap). */
  reason?: string | null;
}

export interface LoadedJob extends Job {
  text: string;
  sensitivity: string | null;
}

function loadText(db: Db, job: Job): LoadedJob | null {
  if (job.kind === "memory_entry") {
    const row = db.prepare(
      "SELECT content, sensitivity, superseded_at FROM memory_entries WHERE id = ?",
    ).get(job.id) as { content: string; sensitivity: string; superseded_at: string | null } | undefined;
    if (!row || row.superseded_at || !row.content) return null;
    return { ...job, text: row.content, sensitivity: row.sensitivity };
  }
  if (job.kind === "memory_episode") {
    const row = db.prepare("SELECT summary FROM memory_episodes WHERE episode_id = ?").get(job.id) as
      { summary: string | null } | undefined;
    if (!row?.summary) return null;
    return { ...job, text: row.summary, sensitivity: null };
  }
  const row = db.prepare("SELECT summary, sensitivity, status FROM experience_candidates WHERE id = ?").get(job.id) as
    { summary: string; sensitivity: string; status: string } | undefined;
  if (!row || row.status === "rejected" || !row.summary) return null;
  return { ...job, text: row.summary, sensitivity: row.sensitivity };
}

function finishJob(
  db: Db,
  job: Job,
  state: "translated" | "kept_native" | "pending",
  fields: { reason?: string | null; translator?: string | null; backCheck?: number | null; englishHash?: string | null; attempt?: boolean },
): void {
  db.prepare(
    `UPDATE memory_translation_jobs
        SET state = ?, reason = ?, translator = COALESCE(?, translator), back_check = COALESCE(?, back_check),
            english_hash = COALESCE(?, english_hash), attempts = attempts + ?, updated_at = ?
      WHERE target_kind = ? AND target_id = ?`,
  ).run(
    state,
    fields.reason ?? null,
    fields.translator ?? null,
    fields.backCheck ?? null,
    fields.englishHash ?? null,
    fields.attempt ? 1 : 0,
    new Date().toISOString(),
    job.kind,
    job.id,
  );
}

function embeddingColumns(embedding: LocalMemoryEmbedding): unknown[] {
  return [
    embedding.model,
    embedding.adapter,
    embedding.modelSha256,
    embedding.contentHash,
    embedding.dimensions,
    JSON.stringify(embedding.vector),
  ];
}

/**
 * Swap the search surface to English and move the original to its side table,
 * atomically, only if the row is exactly what was translated (hash) and still
 * live. A forget that happened while the model was answering wins.
 */
export function applyTranslation(
  db: Db,
  job: LoadedJob,
  english: string,
  meta: { translator: string; backCheck: number | null; intakeEpoch: number | null },
): "translated" | "stale" | "forgotten" {
  const now = new Date().toISOString();
  const embedding = autoLocalEmbedding(english);
  return db.transaction((): "translated" | "stale" | "forgotten" => {
    const current = loadText(db, job);
    if (!current || translationSourceHash(current.text) !== job.sourceHash) return "stale";
    if (job.kind === "memory_entry") {
      const row = db.prepare(
        `SELECT scope, kind, project_id, project_path, agent_id, chat_id FROM memory_entries WHERE id = ?`,
      ).get(job.id) as { scope: string; kind: string; project_id: string | null; project_path: string | null; agent_id: string | null; chat_id: string | null };
      try {
        assertMemoryWriteAllowed({
          scope: row.scope as never,
          kind: row.kind as never,
          content: english,
          projectId: row.project_id,
          projectPath: row.project_path,
          agentId: row.agent_id,
          chatId: row.chat_id,
          intakeEpoch: meta.intakeEpoch,
        });
      } catch (error) {
        if (error instanceof MemoryRevokedError) return "forgotten";
        throw error;
      }
      db.prepare(
        `UPDATE memory_entries
            SET content = ?, embedding_model = ?, embedding_adapter = ?, embedding_model_sha256 = ?,
                embedding_content_hash = ?, embedding_dimensions = ?, embedding_json = ?
          WHERE id = ?`,
      ).run(english, ...embeddingColumns(embedding), job.id);
      const nativeText = current.text.slice(0, 4_000);
      db.prepare(
        `INSERT OR REPLACE INTO memory_entry_native (entry_id, content_native, created_at, native_embedding)
         VALUES (?, ?, ?, ?)`,
      ).run(job.id, nativeText, now, serializeNativeEmbedding(autoLocalEmbedding(nativeText)));
    } else if (job.kind === "memory_episode") {
      db.prepare(
        `UPDATE memory_episodes
            SET summary = ?, summary_hash = ?, embedding_model = ?, embedding_adapter = ?,
                embedding_model_sha256 = ?, embedding_content_hash = ?, embedding_dimensions = ?, embedding_json = ?
          WHERE episode_id = ?`,
      ).run(english, translationSourceHash(english), ...embeddingColumns(embedding), job.id);
      db.prepare(
        `INSERT OR REPLACE INTO memory_episode_native (episode_id, summary_native, created_at, native_embedding)
         VALUES (?, ?, ?, ?)`,
      ).run(job.id, current.text, now, serializeNativeEmbedding(autoLocalEmbedding(current.text)));
    } else {
      db.prepare(
        `UPDATE experience_candidates
            SET summary = ?, embedding_model = ?, embedding_adapter = ?, embedding_model_sha256 = ?,
                embedding_content_hash = ?, embedding_dimensions = ?, embedding_json = ?
          WHERE id = ?`,
      ).run(english, ...embeddingColumns(embedding), job.id);
      db.prepare(
        `INSERT OR REPLACE INTO experience_candidate_native (candidate_id, summary_native, created_at, native_embedding)
         VALUES (?, ?, ?, ?)`,
      ).run(job.id, current.text, now, serializeNativeEmbedding(autoLocalEmbedding(current.text)));
    }
    finishJob(db, job, "translated", {
      translator: meta.translator,
      backCheck: meta.backCheck,
      englishHash: translationSourceHash(english),
      attempt: true,
    });
    return "translated";
  }).immediate();
}

