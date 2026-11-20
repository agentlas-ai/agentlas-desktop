/*
 * migration: automations saved before the project stamp have `project_id` empty even though the conversation that made them lives in a
 * project. One pass at Main start fills it from the row's own origin - `monitor.originChatId` in the trigger JSON, which the
 * block registration writes - through the one stamp (scopeStampOfChat). A row with no origin, an origin that is gone or outside every project, or a project
 * that no longer exists stays as it is (standalone is a valid state). Idempotent: a filled row is never touched again, and the pass writes only rows it fills.
 * Reads: the automations table once (a bounded SELECT of empty-project rows). Writes: `project_id` of those rows. Nothing else, no model, no timer.
 */
import type Database from "better-sqlite3";
import { scopeStampOfChat } from "../runtime/approval-scope";

export interface AutomationProjectBackfillResult { scanned: number; filled: number }

export function backfillAutomationProjects(db: Database.Database, projectOf: (chatId: string) => string | null = (chatId) => scopeStampOfChat(chatId)?.project ?? null): AutomationProjectBackfillResult {
  let rows: Array<{ id: string; trigger_json: string | null }> = [];
  try {
    rows = db.prepare("SELECT id, trigger_json FROM automations WHERE (project_id IS NULL OR project_id = '') AND trigger_json IS NOT NULL AND trigger_json LIKE '%originChatId%' LIMIT 5000")
      .all() as Array<{ id: string; trigger_json: string | null }>;
  } catch { return { scanned: 0, filled: 0 }; }   // a store from before the column: nothing to fill
  const exists = db.prepare("SELECT 1 FROM projects WHERE id = ?");
  const fill = db.prepare("UPDATE automations SET project_id = ? WHERE id = ? AND (project_id IS NULL OR project_id = '')");
  let filled = 0;
  for (const row of rows) {
    let origin: unknown;
    try { origin = (JSON.parse(row.trigger_json ?? "null") as { monitor?: { originChatId?: unknown } } | null)?.monitor?.originChatId; } catch { continue; }
    if (typeof origin !== "string" || !origin) continue;
    const projectId = projectOf(origin);
    if (!projectId) continue;
    let known = false;
    try { known = Boolean(exists.get(projectId)); } catch { known = false; }
    if (known && fill.run(projectId, row.id).changes === 1) filled += 1;
  }
  return { scanned: rows.length, filled };
}
