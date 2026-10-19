import { getDb } from "./db";

/**






 */
export function pruneJudgmentVerdicts(cutoffIso: string, limit = 500): number {
  return getDb().prepare(
    `DELETE FROM judgment_verdicts WHERE rowid IN (
       SELECT rowid FROM judgment_verdicts WHERE last_hit_at < ? LIMIT ?)`,
  ).run(cutoffIso, Math.max(1, Math.floor(limit))).changes;
}
