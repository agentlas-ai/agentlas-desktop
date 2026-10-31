import { getDb } from "../store/db";
import type { AgentWorkspaceOutcomeComparisonRow, AgentWorkspaceOutcomeCounts, AgentWorkspaceRevisionComparison,
  AgentWorkspaceRevisionOutcome, AgentWorkspaceWorkKind } from "../../shared/agent-workspace";

/**
 * What the runs on each agent-file revision ended with, so an applied learning can be compared with the revision it
 * replaced. Every run on a revision writes agent_revision_run_finished with its revisionId (mcp/client.ts). The counted
 * kinds survive the 3-day run-detail trim (storage/run-detail-retention.ts keeps terminals and errors and only removes
 * reasoning text and chat tool-call rows); tool calls and output digests come from the summary on the run's own receipt
 * (storage/run-detail-summary.ts), read by the same query that lists the runs. A run shared by several agents counts for each
 * of them.
 *
 * Runs are also split by the kind of work their start record names (automation, task, conversation), so a change is
 * compared within the same kind of work, not across a mix that happened to differ before and after.
 *
 * Counts only: no threshold decides "better" or "worse" here. The owner reads the numbers side by side.
 */
const COUNTED = ["invoke_completed", "invoke_failed", "mcp_error", "user_steering", "runtime_turn_attempt"] as const;
const MAX_RUNS = 2_000;
const START_WINDOW = 64;
const KIND_ORDER: AgentWorkspaceWorkKind[] = ["task", "conversation", "automation", "other"];

const COUNT_KEYS = ["runs", "completed", "failed", "errors", "steering", "attempts", "toolCalls", "withOutput"] as const satisfies ReadonlyArray<keyof AgentWorkspaceOutcomeCounts>;
const emptyCounts = (): AgentWorkspaceOutcomeCounts => ({ runs: 0, completed: 0, failed: 0, errors: 0, steering: 0, attempts: 0, toolCalls: 0, withOutput: 0 });
function add(into: AgentWorkspaceOutcomeCounts, run: AgentWorkspaceOutcomeCounts): void {
  for (const key of COUNT_KEYS) into[key] += run[key];
}

function workKind(start: { automationId: string | null; intent: unknown } | undefined): AgentWorkspaceWorkKind {
  if (!start) return "other";
  if (start.automationId) return "automation";
  return start.intent === "task" || start.intent === "conversation" ? start.intent : "other";
}

export function agentRevisionOutcomes(agentId: string): Map<string, AgentWorkspaceRevisionOutcome> {
  const outcomes = new Map<string, AgentWorkspaceRevisionOutcome>();
  if (!agentId) return outcomes;
  const db = getDb();
  const runs = db.prepare(`SELECT run_id AS runId, json_extract(payload_json, '$.revisionId') AS revisionId,
    json_extract(payload_json, '$.toolSummary.toolCalls') AS toolCalls, json_array_length(json_extract(payload_json, '$.toolSummary.outputDigests')) AS digests FROM run_events
    WHERE agent_id = ? AND kind = 'agent_revision_run_finished' ORDER BY ts DESC LIMIT ?`).all(agentId, MAX_RUNS) as
    Array<{ runId: string; revisionId: unknown; toolCalls: unknown; digests: unknown }>;
  const revisionOf = new Map<string, string>();
  const tools = new Map<string, { calls: number; withOutput: number }>();
  for (const run of runs) if (typeof run.revisionId === "string" && run.revisionId && !revisionOf.has(run.runId)) {
    revisionOf.set(run.runId, run.revisionId);
    tools.set(run.runId, { calls: Number(run.toolCalls) || 0, withOutput: Number(run.digests) > 0 ? 1 : 0 });
  }
  if (!revisionOf.size) return outcomes;
  const counts = db.prepare(`SELECT kind, COUNT(*) AS n FROM run_events WHERE run_id = ? AND kind IN (${COUNTED.map(() => "?").join(",")}) GROUP BY kind`);
  // invoke_started is one of a run's first events (seq 13 at most on a real ledger), so the lookup stops early; without a
  // bound a run that has none would be read to its end.
  const start = db.prepare(`SELECT automation_id AS automationId, json_extract(payload_json, '$.taskIntent') AS intent FROM run_events
    WHERE run_id = ? AND seq <= ${START_WINDOW} AND kind = 'invoke_started' ORDER BY seq LIMIT 1`);
  for (const [runId, revisionId] of revisionOf) {
    const outcome = outcomes.get(revisionId) ?? { ...emptyCounts(), byKind: {} };
    const byKind = new Map((counts.all(runId, ...COUNTED) as Array<{ kind: string; n: number }>).map(row => [row.kind, Number(row.n)]));
    const summary = tools.get(runId);
    const run: AgentWorkspaceOutcomeCounts = { ...emptyCounts(), runs: 1,
      failed: byKind.get("invoke_failed") ? 1 : 0, completed: !byKind.get("invoke_failed") && byKind.get("invoke_completed") ? 1 : 0,
      errors: byKind.get("mcp_error") ?? 0, steering: byKind.get("user_steering") ?? 0, attempts: byKind.get("runtime_turn_attempt") ?? 0,
      toolCalls: summary?.calls ?? 0, withOutput: summary?.withOutput ?? 0 };
    add(outcome, run);
    const kind = workKind(start.get(runId) as { automationId: string | null; intent: unknown } | undefined);
    add(outcome.byKind[kind] ??= emptyCounts(), run);
    outcomes.set(revisionId, outcome);
  }
  return outcomes;
}

/**
 * The revision a change replaced next to the one it produced, kind by kind. Each row says why it cannot be read as an
 * effect when one side has no runs or only one; otherwise it is numbers for the owner to read. Null when neither has runs.
 */
export function compareRevisionOutcomes(baseRevisionId: string, before: AgentWorkspaceRevisionOutcome | undefined,
  after: AgentWorkspaceRevisionOutcome | undefined): AgentWorkspaceRevisionComparison | null {
  if (!before?.runs && !after?.runs) return null;
  const rows: AgentWorkspaceOutcomeComparisonRow[] = [];
  for (const kind of KIND_ORDER) {
    const b = before?.byKind[kind] ?? null, a = after?.byKind[kind] ?? null;
    if (!b && !a) continue;
    const limit = !b ? "no_runs_before" as const : !a ? "no_runs_after" as const : b.runs < 2 || a.runs < 2 ? "single_run" as const : undefined;
    rows.push({ kind, before: b, after: a, ...(limit ? { limit } : {}) });
  }
  return { baseRevisionId, rows };
}
