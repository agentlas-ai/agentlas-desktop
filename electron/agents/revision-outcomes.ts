import { getDb } from "../store/db";
import { readRunToolSummary } from "../storage/run-detail-summary";
import type { AgentWorkspaceOutcomeComparisonRow, AgentWorkspaceOutcomeCounts, AgentWorkspaceRevisionComparison,
  AgentWorkspaceRevisionOutcome, AgentWorkspaceWorkKind } from "../../shared/agent-workspace";

/**
 * What the runs on each agent-file revision ended with, so an applied learning can be compared with the revision it
 * replaced. Every run on a revision writes agent_revision_run_finished with its revisionId (mcp/client.ts). The counted
 * kinds survive the 3-day run-detail trim (storage/run-detail-retention.ts keeps terminals and errors and only removes
 * reasoning text and chat tool-call rows); tool calls and output digests come from the per-run summary written when the
 * run finished and refreshed before the trim (storage/run-detail-summary.ts). A run shared by several agents counts for each
 * of them.
 *
 * Runs are also split by the kind of work their start record names (automation, task, conversation), so a change is
 * compared within the same kind of work, not across a mix that happened to differ before and after.
 *
 * Counts only: no threshold decides "better" or "worse" here. The owner reads the numbers side by side.
 */
const COUNTED = ["invoke_completed", "invoke_failed", "mcp_error", "user_steering", "runtime_turn_attempt"] as const;
const MAX_RUNS = 2_000;
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
  const runs = db.prepare(`SELECT run_id AS runId, json_extract(payload_json, '$.revisionId') AS revisionId FROM run_events
    WHERE agent_id = ? AND kind = 'agent_revision_run_finished' ORDER BY ts DESC LIMIT ?`).all(agentId, MAX_RUNS) as Array<{ runId: string; revisionId: unknown }>;
  const revisionOf = new Map<string, string>();
  for (const run of runs) if (typeof run.revisionId === "string" && run.revisionId && !revisionOf.has(run.runId)) revisionOf.set(run.runId, run.revisionId);
  if (!revisionOf.size) return outcomes;
  const counts = db.prepare(`SELECT kind, COUNT(*) AS n FROM run_events WHERE run_id = ? AND kind IN (${COUNTED.map(() => "?").join(",")}) GROUP BY kind`);
  const start = db.prepare(`SELECT automation_id AS automationId, json_extract(payload_json, '$.taskIntent') AS intent FROM run_events
    WHERE run_id = ? AND kind = 'invoke_started' ORDER BY seq LIMIT 1`);
  for (const [runId, revisionId] of revisionOf) {
    const outcome = outcomes.get(revisionId) ?? { ...emptyCounts(), byKind: {} };
    const byKind = new Map((counts.all(runId, ...COUNTED) as Array<{ kind: string; n: number }>).map(row => [row.kind, Number(row.n)]));
    const tools = readRunToolSummary(db, runId);
    const run: AgentWorkspaceOutcomeCounts = { ...emptyCounts(), runs: 1,
      failed: byKind.get("invoke_failed") ? 1 : 0, completed: !byKind.get("invoke_failed") && byKind.get("invoke_completed") ? 1 : 0,
      errors: byKind.get("mcp_error") ?? 0, steering: byKind.get("user_steering") ?? 0, attempts: byKind.get("runtime_turn_attempt") ?? 0,
      toolCalls: tools?.toolCalls ?? 0, withOutput: tools?.outputDigests.length ? 1 : 0 };
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
