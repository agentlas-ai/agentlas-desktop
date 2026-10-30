import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * What a run's tool calls came to, small enough to keep after the 3-day trim (run-detail-retention.ts) deletes the
 * tool-call rows of a settled chat run: which tools were called how often, where the first failure was, and the output
 * digests the tools recorded (automation-progress-guard.ts toolObservationDigest). Arguments, results and text are not
 * kept.
 *
 * One row per run, written when a run on an agent-file revision finishes (mcp/client.ts, next to its revision receipt) and
 * refreshed by the trim just before it deletes the rows, so a run that went on after its first finish is summarized whole.
 * The revision comparison (electron/agents/revision-outcomes.ts) reads only this row: reading the tool rows themselves
 * took about 250 ms for one agent's 329 runs on one ledger, and the workspace is read at every run start.
 */
export const RUN_DETAIL_SUMMARY_KIND = "run_detail_summary";
const SCHEMA = "agentlas.run-detail-summary.v1";
const MAX_TOOLS = 24;
const MAX_DIGESTS = 16;
const MAX_TEXT = 80;
const DIGEST = /^[a-f0-9]{64}$/;

export interface RunToolSummary {
  schemaVersion: typeof SCHEMA;
  toolCalls: number;
  toolErrors: number;
  tools: Array<{ name: string; calls: number; errors: number }>;
  /** The first tool result marked as an error: the tool, its failure code, and which call of the run it was (1-based). */
  firstFailure: { tool: string; code: string | null; call: number } | null;
  outputDigests: string[];
}

interface ToolRow { name: unknown; done: unknown; isError: unknown; code: unknown; digest: unknown }

const text = (value: unknown): string => String(value).slice(0, MAX_TEXT);

/** From the live tool-call rows; null when the run has none (never had any, or they were trimmed). */
export function summarizeRunToolDetail(db: Database.Database, runId: string): RunToolSummary | null {
  const rows = db.prepare(`SELECT json_extract(payload_json, '$.toolName') AS name, json_extract(payload_json, '$.toolCompleted') AS done,
    json_extract(payload_json, '$.toolIsError') AS isError, json_extract(payload_json, '$.toolFailureCode') AS code,
    json_extract(payload_json, '$.toolObservationDigest') AS digest
    FROM run_events WHERE run_id = ? AND kind = 'mcp_tool-use' AND json_extract(payload_json, '$.toolName') IS NOT NULL ORDER BY seq`)
    .all(runId) as ToolRow[];
  if (!rows.length) return null;
  const tools = new Map<string, { name: string; calls: number; errors: number }>();
  const digests = new Set<string>();
  const summary: RunToolSummary = { schemaVersion: SCHEMA, toolCalls: 0, toolErrors: 0, tools: [], firstFailure: null, outputDigests: [] };
  for (const row of rows) {
    const name = text(row.name);
    const tool = tools.get(name) ?? { name, calls: 0, errors: 0 };
    // A call writes a requested row and a completed row; the requested one counts the call.
    if (Number(row.done) !== 1) { tool.calls += 1; summary.toolCalls += 1; }
    const code = typeof row.code === "string" && row.code ? text(row.code) : null;
    if (Number(row.isError) === 1 || code) {
      tool.errors += 1; summary.toolErrors += 1;
      summary.firstFailure ??= { tool: name, code, call: Math.max(1, summary.toolCalls) };
    }
    if (typeof row.digest === "string" && DIGEST.test(row.digest) && digests.size < MAX_DIGESTS) digests.add(row.digest);
    tools.set(name, tool);
  }
  summary.tools = [...tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, MAX_TOOLS);
  summary.outputDigests = [...digests];
  return summary;
}

function storedRow(db: Database.Database, runId: string): { id: string; payload_json: string } | undefined {
  return db.prepare(`SELECT id, payload_json FROM run_events WHERE run_id = ? AND kind = '${RUN_DETAIL_SUMMARY_KIND}' ORDER BY seq DESC LIMIT 1`)
    .get(runId) as { id: string; payload_json: string } | undefined;
}

/** The kept summary; null for a run that never had one (no tools, or finished before summaries were kept). */
export function readRunToolSummary(db: Database.Database, runId: string): RunToolSummary | null {
  const row = storedRow(db, runId);
  if (!row) return null;
  try {
    const value = JSON.parse(row.payload_json) as RunToolSummary;
    return value?.schemaVersion === SCHEMA ? value : null;
  } catch { return null; }
}

/**
 * Writes or refreshes the run's summary from its live tool rows; returns whether it wrote. Tool rows are only added (a run
 * that went on) or deleted (the trim, which may take a large run over several slices), so a summary that would count
 * fewer calls than the kept one is a partly trimmed run and the kept one stays. A new row takes the run's last timestamp,
 * so a settled run stays settled for the trim.
 */
export function storeRunToolSummary(db: Database.Database, runId: string): boolean {
  const summary = summarizeRunToolDetail(db, runId);
  if (!summary) return false;
  const payload = JSON.stringify(summary), existing = storedRow(db, runId);
  if (existing) {
    if (existing.payload_json === payload) return false;
    const kept = readRunToolSummary(db, runId);
    if (kept && summary.toolCalls + summary.toolErrors < kept.toolCalls + kept.toolErrors) return false;
    db.prepare("UPDATE run_events SET payload_json = ? WHERE id = ?").run(payload, existing.id);
    return true;
  }
  const last = db.prepare("SELECT seq, ts, chat_id FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1").get(runId) as
    { seq: number; ts: string; chat_id: string | null };
  db.prepare(`INSERT INTO run_events (id, run_id, seq, ts, kind, chat_id, automation_id, node_id, agent_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
    .run(`evt_${randomUUID()}`, runId, Number(last.seq) + 1, last.ts, RUN_DETAIL_SUMMARY_KIND, last.chat_id, payload);
  return true;
}

/** Called by the trim inside its write transaction, before a run's tool-call rows are deleted: only revision runs keep one. */
export function keepRunToolSummary(db: Database.Database, runId: string): boolean {
  if (!db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = 'agent_revision_run_finished' LIMIT 1").get(runId)) return false;
  return storeRunToolSummary(db, runId);
}
