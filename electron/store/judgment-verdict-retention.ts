import { getDb } from "./db";

/**
 * Storage budget (storage/storage-maintenance.ts): removes up to `limit`
 * durable judgment verdicts last used before `cutoffIso`, in one statement
 * served by idx_judgment_verdicts_recency. The table is only a cache of model
 * verdicts (system-agents/judgment.ts durableGet/durablePut): a removed row
 * costs at most one model call the next time the same input is judged. Nothing
 * else removed rows; owner Mac 2026-10-17: 2,602 rows, 60 MB with the key index.
 */
export function pruneJudgmentVerdicts(cutoffIso: string, limit = 500): number {
  return getDb().prepare(
    `DELETE FROM judgment_verdicts WHERE rowid IN (
       SELECT rowid FROM judgment_verdicts WHERE last_hit_at < ? LIMIT ?)`,
  ).run(cutoffIso, Math.max(1, Math.floor(limit))).changes;
}
