import { getDb } from "../store/db";
import type { AgentWorkspaceRevisionOutcome } from "../../shared/agent-workspace";

/**
 * What the runs on each agent-file revision ended with, so an applied learning can be compared with the revision it
 * replaced. Every run on a revision writes agent_revision_run_finished with its revisionId (mcp/client.ts). The counted
 * kinds survive the 3-day run-detail trim (storage/run-detail-retention.ts keeps terminals and errors and only removes
 * reasoning text and chat tool-call rows). A run shared by several agents counts for each of them.
 *
 * Counts only: no threshold decides "better" or "worse" here. The owner reads the numbers side by side.
 */
const COUNTED = ["invoke_completed", "invoke_failed", "mcp_error", "user_steering", "runtime_turn_attempt"] as const;
const MAX_RUNS = 2_000;

export function agentRevisionOutcomes(agentId: string): Map<string, AgentWorkspaceRevisionOutcome> {
  const outcomes = new Map<string, AgentWorkspaceRevisionOutcome>();
  if (!agentId) return outcomes;
  const db = getDb();
  const runs = db.prepare(`SELECT run_id AS runId, json_extract(payload_json, '$.revisionId') AS revisionId FROM run_events
    WHERE agent_id = ? AND kind = 'agent_revision_run_finished' ORDER BY ts DESC LIMIT ?`).all(agentId, MAX_RUNS) as Array<{ runId: string; revisionId: unknown }>;
  const revisionOf = new Map<string, string>();
  for (const run of runs) if (typeof run.revisionId === "string" && run.revisionId && !revisionOf.has(run.runId)) revisionOf.set(run.runId, run.revisionId);
  if (!revisionOf.size) return outcomes;
  const counts = db.prepare(`SELECT kind, COUNT(*) AS n FROM run_events WHERE run_id = ? AND kind IN (${COUNTED.map(() => "?").join(",")}) GROUP BY kind`);
  for (const [runId, revisionId] of revisionOf) {
    const outcome = outcomes.get(revisionId) ?? { runs: 0, completed: 0, failed: 0, errors: 0, steering: 0, attempts: 0 };
    const byKind = new Map((counts.all(runId, ...COUNTED) as Array<{ kind: string; n: number }>).map(row => [row.kind, Number(row.n)]));
    outcome.runs += 1;
    if (byKind.get("invoke_failed")) outcome.failed += 1;
    else if (byKind.get("invoke_completed")) outcome.completed += 1;
    outcome.errors += byKind.get("mcp_error") ?? 0;
    outcome.steering += byKind.get("user_steering") ?? 0;
    outcome.attempts += byKind.get("runtime_turn_attempt") ?? 0;
    outcomes.set(revisionId, outcome);
  }
  return outcomes;
}
