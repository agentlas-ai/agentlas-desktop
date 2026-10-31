import type Database from "better-sqlite3";

/**
 * What a run's tool calls came to, small enough to keep after the 3-day trim (run-detail-retention.ts) deletes the
 * tool-call rows of a settled chat run: which tools were called how often, where the first failure was, and the output
 * digests the tools recorded (automation-progress-guard.ts toolObservationDigest). Arguments, results and text are not
 * kept.
 *
 * It lives on the run's own `agent_revision_run_finished` receipt (payload.toolSummary), the row the revision comparison
 * already reads for each run. No new kind of event exists, and the comparison needs no further query: a separate summary row
 * had to be looked up per run, and a lookup that finds nothing reads every event of the run (73,626 events took 297 ms on the
 * a real ledger), at every run start. The receipt gets the summary when the run finishes (mcp/client.ts); the trim adds it
 * to a receipt that has none (a run that finished before the summary existed) just before it deletes the tool rows.
 */
const RECEIPT_KIND = "agent_revision_run_finished";
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
  // The valid rows are set apart first (MATERIALIZED): SQL does not promise to test json_valid before json_extract in one WHERE,
  // and one unreadable payload would throw out of the whole read.
  const rows = db.prepare(`WITH tools AS MATERIALIZED (SELECT seq, payload_json FROM run_events WHERE run_id = ? AND kind = 'mcp_tool-use' AND json_valid(payload_json))
    SELECT json_extract(payload_json, '$.toolName') AS name, json_extract(payload_json, '$.toolCompleted') AS done,
    json_extract(payload_json, '$.toolIsError') AS isError, json_extract(payload_json, '$.toolFailureCode') AS code,
    json_extract(payload_json, '$.toolObservationDigest') AS digest
    FROM tools WHERE json_extract(payload_json, '$.toolName') IS NOT NULL ORDER BY seq`)
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

/**
 * Called by the trim inside its write transaction, before a run's tool-call rows are deleted: puts the summary on the run's
 * receipts that have none. A receipt that already carries one (written when the run finished) is left as it is.
 */
export function keepRunToolSummary(db: Database.Database, runId: string): boolean {
  const select = (hint: string) => db.prepare(`WITH receipts AS MATERIALIZED (SELECT id, payload_json FROM run_events ${hint} WHERE kind = '${RECEIPT_KIND}' AND run_id = ? AND json_valid(payload_json))
    SELECT id FROM receipts WHERE json_type(payload_json, '$.toolSummary') IS NULL`);
  let missing: Array<{ id: string }>;
  // The kind index reads the few hundred receipts; without it the run's own index would read every event of a very large run.
  try { missing = select("INDEXED BY idx_run_events_kind_ts").all(runId) as Array<{ id: string }>; }
  catch { missing = select("").all(runId) as Array<{ id: string }>; }
  if (!missing.length) return false;
  const summary = summarizeRunToolDetail(db, runId);
  if (!summary) return false;
  const update = db.prepare("UPDATE run_events SET payload_json = json_set(payload_json, '$.toolSummary', json(?)) WHERE id = ?");
  const payload = JSON.stringify(summary);
  for (const row of missing) update.run(payload, row.id);
  return true;
}
