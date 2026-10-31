import type Database from "better-sqlite3";
import { keepRunToolSummary } from "./run-detail-summary";

/**
 * Trims per-call run detail once a run is settled for `days` days. Owner
 * decision 2026-10-16: 3 days, after which a run keeps its result, cost and
 * error summary.
 *
 * Context: run_events was 750 MB, plus about 430 MB of indexes, of a 1.8 GB
 * DB. The tool-call rows alone were 267k.
 *
 * Settled means two things: the run has a terminal marker, and nothing was
 * written for it since the cutoff. A run with no terminal marker may still
 * resume, so it is left whole.
 *
 * - Model reasoning and thinking text is deleted. It is only ever displayed.
 * - Chat runs (no automation): tool-call and notice rows are deleted, unless
 *   the chat has an active or blocked Goal (Goal facts check for later tool
 *   activity).
 * - Automation runs: tool-call and notice rows stay. Only the large output
 *   fields go. toolArgs stays, because a graph resume compares a node's
 *   arguments with the previous run of the same occurrence before it
 *   re-sends an external action.
 *
 * Domain events, effects, results, accounting and errors are never touched.
 * Before a run on an agent-file revision loses its tool-call rows, a small summary of them (tool names, first failure,
 * output digests) goes onto the run's revision receipt (run-detail-summary.ts), so the revision comparison still counts that
 * run the same way.
 */

export const RUN_DETAIL_TEXT_KINDS = ["mcp_reasoning", "mcp_thinking"] as const;
export const RUN_DETAIL_CALL_KINDS = ["mcp_tool-use", "mcp_notice"] as const;
export const RUN_TERMINAL_KINDS = [
  "invoke_completed", "invoke_failed", "invoke_result", "automation_scheduler_terminal", "workflow_graph_finished",
] as const;
const COMPACT_DROP_FIELDS = ["runtimeEvidence", "toolResultPreview"];
const COMPACT_KEEP_FIELDS = new Set(["toolArgs"]);
const LONG_STRING = 2048;
const COMPACTED_MARK = '"detailCompacted":true';

const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(", ");

export function compactAutomationDetail(payloadJson: string | null): string {
  let parsed: unknown;
  try { parsed = JSON.parse(payloadJson ?? ""); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return JSON.stringify({ detailCompacted: true });
  const payload = parsed as Record<string, unknown>;
  for (const field of COMPACT_DROP_FIELDS) delete payload[field];
  for (const [key, value] of Object.entries(payload)) {
    if (!COMPACT_KEEP_FIELDS.has(key) && typeof value === "string" && value.length > LONG_STRING) delete payload[key];
  }
  payload.detailCompacted = true;
  return JSON.stringify(payload);
}

/** `id` is the run_events TEXT primary key (`evt_…`), not a number. */
export interface RunDetailWatermark { ts: string; id: string }

export interface RunDetailSlice {
  runs: number;
  deleted: number;
  compacted: number;
  /** Resume point for the next slice; terminal markers at or before it are done. */
  watermark: RunDetailWatermark;
  /** True when no settled terminal marker remains past the watermark. */
  done: boolean;
}

/**
 * One bounded slice.
 * - Settled runs are found by walking terminal markers in (ts, id) order from
 *   a stored watermark on the (kind, ts) index.
 * - A slice changes at most `maxRows` rows (default 300) and stops after
 *   `maxMs` (default 50 ms). One large run
 *   rewrote thousands of indexed rows in a single 1.2 s transaction on the
 *   owner's copy, which would freeze the Desktop main thread.
 * - A run larger than the budget continues in the next slice. The watermark
 *   stops before it until the run is finished.
 * - Each chunk is its own short write transaction.
 */
export function retireRunDetailSlice(
  db: Database.Database,
  options: { days: number; now?: number; watermark?: RunDetailWatermark | null; maxRuns?: number; maxRows?: number; maxMs?: number },
): RunDetailSlice {
  const cutoff = new Date((options.now ?? Date.now()) - options.days * 86_400_000).toISOString();
  let watermark: RunDetailWatermark = options.watermark ?? { ts: "", id: "" };
  const slice: RunDetailSlice = { runs: 0, deleted: 0, compacted: 0, watermark, done: false };
  // A blocked Goal resumes into active, so it is protected too (statuses: active, blocked, completed, cancelled).
  const activeGoalChats = `SELECT chat_id FROM chat_goal_contracts WHERE status IN ('active', 'blocked')`;
  const chatCalls = `kind IN (${list(RUN_DETAIL_CALL_KINDS)}) AND automation_id IS NULL
    AND (chat_id IS NULL OR chat_id NOT IN (${activeGoalChats}))`;
  const automationCalls = `kind IN (${list(RUN_DETAIL_CALL_KINDS)}) AND automation_id IS NOT NULL
    AND instr(COALESCE(payload_json, ''), '${COMPACTED_MARK}') = 0`;
  const markers = db.prepare(`SELECT id, run_id, ts FROM run_events
    WHERE kind IN (${list(RUN_TERMINAL_KINDS)}) AND ts < ? AND (ts > ? OR (ts = ? AND id > ?))
    ORDER BY ts, id LIMIT ?`).all(cutoff, watermark.ts, watermark.ts, watermark.id, options.maxRuns ?? 50) as
    Array<{ id: string; run_id: string; ts: string }>;
  // The run's last event by sequence: one index step, where a ts filter would read every row of a long run.
  const lastEventTs = db.prepare("SELECT ts FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1");
  const startedAt = Date.now();
  const maxMs = options.maxMs ?? 50;
  const deleteText = db.prepare(`DELETE FROM run_events WHERE id IN (
    SELECT id FROM run_events WHERE run_id = ? AND kind IN (${list(RUN_DETAIL_TEXT_KINDS)}) LIMIT ?)`);
  const deleteChatCalls = db.prepare(`DELETE FROM run_events WHERE id IN (
    SELECT id FROM run_events WHERE run_id = ? AND ${chatCalls} LIMIT ?)`);
  const automationCallRows = db.prepare(`SELECT id, payload_json FROM run_events WHERE run_id = ? AND ${automationCalls} LIMIT ?`);
  const updatePayload = db.prepare("UPDATE run_events SET payload_json = ? WHERE id = ?");
  let budget = options.maxRows ?? 300;
  const trimChunk = db.transaction((runId: string): void => {
    try { keepRunToolSummary(db, runId); } catch { /* The summary is best effort; the trim itself must go on. */ }
    const removedText = deleteText.run(runId, budget).changes;
    budget -= removedText;
    const removedCalls = budget > 0 ? deleteChatCalls.run(runId, budget).changes : 0;
    budget -= removedCalls;
    slice.deleted += removedText + removedCalls;
    if (budget > 0) {
      for (const row of automationCallRows.all(runId, budget) as Array<{ id: string; payload_json: string | null }>) {
        updatePayload.run(compactAutomationDetail(row.payload_json), row.id);
        slice.compacted += 1;
        budget -= 1;
      }
    }
  });
  const hasDetail = db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND (kind IN (${list(RUN_DETAIL_TEXT_KINDS)})
    OR (${chatCalls}) OR (${automationCalls})) LIMIT 1`);
  const seen = new Set<string>();
  for (const marker of markers) {
    if (!seen.has(marker.run_id)) {
      seen.add(marker.run_id);
      // A run written to since the cutoff is not settled; its next terminal marker brings it back.
      const last = (lastEventTs.get(marker.run_id) as { ts: string } | undefined)?.ts ?? "";
      if (last < cutoff) {
        trimChunk.immediate(marker.run_id);
        slice.runs += 1;
        if (budget <= 0 && hasDetail.get(marker.run_id)) {
          // Budget spent mid-run: resume this run next slice, before its marker.
          slice.watermark = watermark;
          return slice;
        }
      }
    }
    watermark = { ts: marker.ts, id: marker.id };
    if (budget <= 0 || Date.now() - startedAt > maxMs) {
      slice.watermark = watermark;
      return slice;
    }
  }
  slice.watermark = watermark;
  slice.done = markers.length < (options.maxRuns ?? 50);
  return slice;
}
