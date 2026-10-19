import type Database from "better-sqlite3";

/**


















 */
export type SeatFailureVerdict =
  | { stands: true }
  | { stands: false; evidence: "close_after_completed_turn" | "later_completed_turn"; runId: string; eventId: string };

/** The status write precedes the event append on the same thread; the close is recorded within this window. */
const CLOSE_AFTER_STATUS_MS = 60_000;
const CLOCK_SLACK_MS = 1_000;

interface LifecycleRow {
  id: string;
  run_id: string;
  ts: string;
  state: string | null;
  reason: string | null;
  done: number | null;
  direction: string | null;
}

const LIFECYCLE_COLUMNS = `id, run_id, ts,
  json_extract(payload_json, '$.agentProcessState') AS state,
  json_extract(payload_json, '$.agentProcessReason') AS reason,
  json_extract(payload_json, '$.done') AS done,
  json_extract(payload_json, '$.agentMessageDirection') AS direction`;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function completedTurn(row: Pick<LifecycleRow, "state" | "reason" | "done" | "direction">): boolean {
  return (row.state === "idle" && row.reason === "turn-complete")
    || (Number(row.done) === 1 && row.direction === "worker-to-orchestrator");
}

export function seatFailureVerdictInDb(
  db: Database.Database,
  input: { installedAgentId: string; failedAt: string | null },
): SeatFailureVerdict {
  const failedAtMs = input.failedAt ? Date.parse(input.failedAt) : Number.NaN;
  if (!input.installedAgentId || !Number.isFinite(failedAtMs)) return { stands: true };
  try {
    const window = { from: iso(failedAtMs - CLOCK_SLACK_MS), to: iso(failedAtMs + CLOSE_AFTER_STATUS_MS) };
    // The teammate finished a turn after the mark: the seat's latest durable state is that turn, whichever writer
    // left the older mark.
    const later = db.prepare(`
      SELECT ${LIFECYCLE_COLUMNS} FROM run_events
      WHERE agent_id = ? AND kind = 'mcp_tool-use' AND ts > ?
        AND json_extract(payload_json, '$.runtimeAgentId') = ?
        AND ((json_extract(payload_json, '$.agentProcessState') = 'idle'
              AND json_extract(payload_json, '$.agentProcessReason') = 'turn-complete')
          OR (json_extract(payload_json, '$.done') = 1
              AND json_extract(payload_json, '$.agentMessageDirection') = 'worker-to-orchestrator'))
      ORDER BY ts ASC LIMIT 1
    `).get(input.installedAgentId, window.to, input.installedAgentId) as LifecycleRow | undefined;
    if (later && completedTurn(later)) {
      return { stands: false, evidence: "later_completed_turn", runId: later.run_id, eventId: later.id };
    }

    // A failure written by the seat's own settled run carries that run receipt; nothing older clears it.
    const cache = db.prepare(
      "SELECT updated_at FROM one_org_completion_cache WHERE installed_agent_id = ?",
    ).get(input.installedAgentId) as { updated_at?: string } | undefined;
    const cachedAtMs = cache?.updated_at ? Date.parse(cache.updated_at) : Number.NaN;
    if (Number.isFinite(cachedAtMs)
      && cachedAtMs >= failedAtMs - CLOCK_SLACK_MS
      && cachedAtMs <= failedAtMs + CLOSE_AFTER_STATUS_MS) return { stands: true };

    const close = db.prepare(`
      SELECT ${LIFECYCLE_COLUMNS} FROM run_events
      WHERE agent_id = ? AND kind = 'mcp_tool-use' AND ts >= ? AND ts <= ?
        AND json_extract(payload_json, '$.agentProcessSource') = 'cli-process'
        AND json_extract(payload_json, '$.agentProcessState') = 'closed'
        AND json_extract(payload_json, '$.runtimeAgentId') = ?
      ORDER BY ts ASC LIMIT 1
    `).get(input.installedAgentId, window.from, window.to, input.installedAgentId) as LifecycleRow | undefined;
    if (close) {
      const before = db.prepare(`
        SELECT ${LIFECYCLE_COLUMNS} FROM run_events
        WHERE agent_id = ? AND kind = 'mcp_tool-use' AND run_id = ? AND ts <= ? AND id != ?
          AND json_extract(payload_json, '$.agentProcessSource') = 'cli-process'
          AND json_extract(payload_json, '$.runtimeAgentId') = ?
        ORDER BY ts DESC LIMIT 1
      `).get(input.installedAgentId, close.run_id, close.ts, close.id, input.installedAgentId) as LifecycleRow | undefined;
      if (before && before.state === "idle" && before.reason === "turn-complete") {
        return { stands: false, evidence: "close_after_completed_turn", runId: close.run_id, eventId: close.id };
      }
    }
  } catch {
    // A store without the ledger tables cannot disprove anything; the mark stays as written.
  }
  return { stands: true };
}

/**
 * Boot repair: clear seat failure marks the ledger disproves. Idempotent — a cleared seat is `quiet` and is
 * never selected again; a mark that still stands is left exactly as written. Returns the seats it cleared.
 */
export function repairDisprovedSeatFailuresInDb(db: Database.Database, now = new Date()): Array<{
  installedAgentId: string;
  evidence: "close_after_completed_turn" | "later_completed_turn";
  runId: string;
}> {
  let rows: Array<{ id: string; installed_agent_id: string; last_activity_at: string | null }>;
  try {
    rows = db.prepare(
      "SELECT id, installed_agent_id, last_activity_at FROM one_org_members WHERE status_kind = 'failed' AND archived_at IS NULL",
    ).all() as typeof rows;
  } catch {
    return [];
  }
  const cleared: ReturnType<typeof repairDisprovedSeatFailuresInDb> = [];
  const update = db.prepare(
    "UPDATE one_org_members SET status_kind = 'quiet', status_line = '', updated_at = ? WHERE id = ? AND status_kind = 'failed'",
  );
  for (const row of rows) {
    const verdict = seatFailureVerdictInDb(db, { installedAgentId: row.installed_agent_id, failedAt: row.last_activity_at });
    if (verdict.stands) continue;
    if (update.run(now.toISOString(), row.id).changes === 1) {
      cleared.push({ installedAgentId: row.installed_agent_id, evidence: verdict.evidence, runId: verdict.runId });
    }
  }
  return cleared;
}
