// Adaptive Toolchain learner — run_events → node episodes → crystallization candidates.
//
// Runs in Main, off the hot path (after a graph run settles, debounced, or on an
// explicit owner refresh). It only reads the ledger and writes the per-automation
// toolchain document; it never edits a graph.

import { randomUUID } from "node:crypto";

import {
  applyOutcomeComparison,
  buildNodeEpisodes,
  detectCandidates,
  measurePageReadCost,
  mergeDetectedCandidates,
  nodeDefinitionDigest,
  DEFAULT_DETECT_OPTIONS,
  type EpisodeOutcome,
  type NodeEpisode,
  type RunEventRowLike,
} from "../../shared/toolchain";
import { graphExecutionDigest } from "../../shared/graph-execution-digest";
import type { Automation, WorkflowGraph } from "../../shared/types";
import { getDb } from "../store/db";
import { getAutomation, listAutomations } from "../store/automations";
import { mutateToolchainState, ToolchainStateConflict } from "./store";

export const TOOLCHAIN_NODE_DIGEST_EVENT = "toolchain_node_digest";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** Automatic refreshes per automation are rate-limited (rule R1: bounded generation). */
const AUTO_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const lastAutoRefresh = new Map<string, number>();

/** Nodes that run a model and can therefore carry a crystallization overlay. */
export function overlayEligibleNodes(graph: WorkflowGraph | null | undefined): WorkflowGraph["nodes"] {
  // judgment-exempt: "which nodes receive a model prompt" — not "can this node act
  //   outside". run-graph builds a prompt only for agent/action nodes, and a native
  //   mcpCall step makes no model call, so nothing could carry the overlay there.
  return (graph?.nodes ?? []).filter((node) => (node.type === "agent" || node.type === "action") && !node.config?.mcpCall);
}

function liveNodeDigests(automation: Automation): Map<string, string> {
  const byNodeId = new Map<string, string>();
  for (const node of overlayEligibleNodes(automation.graph)) byNodeId.set(node.id, nodeDefinitionDigest(node));
  return byNodeId;
}

function outcomeFromVerdict(verdict: unknown): EpisodeOutcome | null {
  if (verdict === "ok" || verdict === "skipped" || verdict === "accepted") return "accepted";
  if (verdict === "needs_input") return "needs_input";
  if (verdict === "blocked") return "blocked";
  if (typeof verdict === "string" && verdict && verdict !== "unjudged") return "rejected";
  return null;
}

/**
 * Per-run outcome, strongest evidence first: the run ledger's judged outcome,
 * then the background judgment receipt, then only "the kernel finished".
 */
function runOutcomes(automationId: string, since: string): Map<string, EpisodeOutcome> {
  const db = getDb();
  const outcomes = new Map<string, EpisodeOutcome>();
  const terminal = db.prepare(
    `SELECT run_id, json_extract(payload_json, '$.status') AS status FROM run_events
     WHERE automation_id = ? AND kind = 'automation_scheduler_terminal' AND ts >= ?`,
  ).all(automationId, since) as Array<{ run_id: string; status: string | null }>;
  for (const row of terminal) {
    outcomes.set(row.run_id, row.status === "ok" ? "completed" : row.status === "error" ? "error" : "unjudged");
  }
  const judged = db.prepare(
    `SELECT run_id, json_extract(payload_json, '$.outcome') AS outcome FROM run_events
     WHERE automation_id = ? AND kind = 'automation_background_judgment_completed' AND ts >= ?
       AND json_extract(payload_json, '$.judgmentUnavailable') IS NOT 1`,
  ).all(automationId, since) as Array<{ run_id: string; outcome: string | null }>;
  for (const row of judged) {
    const outcome = outcomeFromVerdict(row.outcome);
    if (outcome) outcomes.set(row.run_id, outcome);
  }
  const history = db.prepare(
    "SELECT id, outcome FROM run_history WHERE automation_id = ? AND ran_at >= ? AND outcome IS NOT NULL",
  ).all(automationId, since) as Array<{ id: string; outcome: string }>;
  for (const row of history) {
    const outcome = outcomeFromVerdict(row.outcome);
    if (outcome) outcomes.set(row.id, outcome);
  }
  return outcomes;
}

/**
 * Node digests for each run. New runs record them (TOOLCHAIN_NODE_DIGEST_EVENT).
 * Older runs are recovered only when their graph digest provably matches a
 * stored graph version; otherwise they stay legacy (grouped by node id, never
 * bound to an overlay).
 */
function runNodeDigests(automation: Automation, since: string): Map<string, Map<string, string>> {
  const db = getDb();
  const byRun = new Map<string, Map<string, string>>();
  const recorded = db.prepare(
    `SELECT run_id, node_id, json_extract(payload_json, '$.nodeDigest') AS digest FROM run_events
     WHERE automation_id = ? AND kind = ? AND ts >= ?`,
  ).all(automation.id, TOOLCHAIN_NODE_DIGEST_EVENT, since) as Array<{ run_id: string; node_id: string | null; digest: string | null }>;
  for (const row of recorded) {
    if (!row.node_id || !row.digest) continue;
    const map = byRun.get(row.run_id) ?? new Map<string, string>();
    map.set(row.node_id, row.digest);
    byRun.set(row.run_id, map);
  }
  const graphs: WorkflowGraph[] = [];
  if (automation.graph) graphs.push(automation.graph);
  const versions = db.prepare("SELECT graph_json FROM automation_graph_versions WHERE automation_id = ?")
    .all(automation.id) as Array<{ graph_json: string }>;
  for (const version of versions) {
    try { graphs.push(JSON.parse(version.graph_json) as WorkflowGraph); } catch { /* unreadable version: skip */ }
  }
  const byGraphDigest = new Map<string, Map<string, string>>();
  for (const graph of graphs) {
    const digests = new Map<string, string>();
    for (const node of overlayEligibleNodes(graph)) digests.set(node.id, nodeDefinitionDigest(node));
    byGraphDigest.set(graphExecutionDigest(automation, graph), digests);
  }
  const runs = db.prepare(
    "SELECT id, graph_digest, dry_run FROM automation_runs WHERE automation_id = ? AND started_at >= ?",
  ).all(automation.id, since) as Array<{ id: string; graph_digest: string | null; dry_run: number }>;
  for (const run of runs) {
    if (run.dry_run === 1) { byRun.set(run.id, new Map([["__dry_run__", "1"]])); continue; }
    if (byRun.has(run.id) || !run.graph_digest) continue;
    const recovered = byGraphDigest.get(run.graph_digest);
    if (recovered) byRun.set(run.id, recovered);
  }
  return byRun;
}

export function collectNodeEpisodes(automation: Automation, now = Date.now()): NodeEpisode[] {
  const since = new Date(now - LOOKBACK_MS).toISOString();
  const db = getDb();
  // Only the fields the learner reads; payloads can be kilobytes each.
  const rows = db.prepare(
    `SELECT run_id, seq, ts, kind, automation_id, node_id,
            json_object(
              'toolName', json_extract(payload_json, '$.toolName'),
              'toolArgs', json_extract(payload_json, '$.toolArgs'),
              'toolCompleted', json_extract(payload_json, '$.toolCompleted'),
              'toolIsError', json_extract(payload_json, '$.toolIsError'),
              'toolResultChars', json_extract(payload_json, '$.toolResultChars')
            ) AS payload_json
     FROM run_events
     WHERE automation_id = ? AND kind = 'mcp_tool-use' AND node_id IS NOT NULL AND ts >= ?
     ORDER BY run_id, seq`,
  ).all(automation.id, since) as RunEventRowLike[];
  // json_object turns JSON true into 1; the episode builder reads booleans.
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (payload.toolCompleted === 1) payload.toolCompleted = true;
      if (payload.toolCompleted === 0) payload.toolCompleted = false;
      if (payload.toolIsError === 1) payload.toolIsError = true;
      if (payload.toolIsError === 0) payload.toolIsError = false;
      row.payload_json = JSON.stringify(payload);
    } catch { /* buildNodeEpisodes skips unreadable rows */ }
  }
  const outcomes = runOutcomes(automation.id, since);
  const digests = runNodeDigests(automation, since);
  const episodes: NodeEpisode[] = [];
  let start = 0;
  while (start < rows.length) {
    let end = start;
    while (end < rows.length && rows[end].run_id === rows[start].run_id) end += 1;
    const runId = rows[start].run_id;
    const runDigests = digests.get(runId);
    if (!runDigests?.has("__dry_run__")) {
      episodes.push(...buildNodeEpisodes({
        rows: rows.slice(start, end),
        outcome: outcomes.get(runId) ?? "unjudged",
        nodeDigestOf: (nodeId) => runDigests?.get(nodeId) ?? null,
      }));
    }
    start = end;
  }
  return episodes;
}

/** Input tokens per (run, node), summed over the node's model attempts. */
function nodeInputTokens(automationId: string, since: string): Map<string, number> {
  const rows = getDb().prepare(
    `SELECT run_id, node_id, json_extract(payload_json, '$.tokens') AS tokens FROM run_events
     WHERE automation_id = ? AND kind = 'runtime_usage_recorded' AND node_id IS NOT NULL AND ts >= ?`,
  ).all(automationId, since) as Array<{ run_id: string; node_id: string; tokens: string | null }>;
  const totals = new Map<string, number>();
  for (const row of rows) {
    try {
      const value = typeof row.tokens === "string" ? JSON.parse(row.tokens) as { inputTokens?: unknown } : null;
      const input = typeof value?.inputTokens === "number" ? value.inputTokens : null;
      if (input === null) continue;
      const key = `${row.run_id}\0${row.node_id}`;
      totals.set(key, (totals.get(key) ?? 0) + input);
    } catch { /* unreadable accounting row */ }
  }
  return totals;
}

function judgedCounts(episodes: NodeEpisode[], nodeDigest: string | null, from: string | null, to: string | null) {
  let accepted = 0;
  let judged = 0;
  for (const episode of episodes) {
    if (episode.nodeDigest !== nodeDigest) continue;
    if (from && episode.startedAt < from) continue;
    if (to && episode.startedAt >= to) continue;
    if (episode.outcome === "accepted") { accepted += 1; judged += 1; }
    else if (episode.outcome === "rejected" || episode.outcome === "blocked" || episode.outcome === "needs_input") judged += 1;
  }
  return { accepted, judged };
}

export function refreshToolchainForAutomation(automationId: string, now = Date.now()): void {
  const automation = getAutomation(automationId);
  if (!automation?.graph) return;
  const episodes = collectNodeEpisodes(automation, now);
  const { candidates, observations } = detectCandidates(episodes, DEFAULT_DETECT_OPTIONS);
  const tokens = nodeInputTokens(automationId, new Date(now - LOOKBACK_MS).toISOString());
  const tokensOf = (runId: string, nodeId: string) => tokens.get(`${runId}\0${nodeId}`) ?? null;
  const live = new Set(liveNodeDigests(automation).values());
  const nowIso = new Date(now).toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mutateToolchainState(automationId, (current) => {
        let crystallizations = mergeDetectedCandidates({
          existing: current.crystallizations,
          detected: candidates,
          liveNodeDigests: live,
          now: nowIso,
          newId: randomUUID,
        });
        crystallizations = crystallizations.map((item) => {
          if (item.kind === "page_read" && item.state === "candidate") {
            const sameCase = episodes.filter((episode) => episode.nodeDigest === item.nodeDigest && episode.outcome === "accepted");
            return { ...item, cost: measurePageReadCost(sameCase, item.target, tokensOf) };
          }
          if (item.state !== "active" || !item.active.appliedAt) return item;
          const withOutcomes = {
            ...item,
            outcomes: {
              before: judgedCounts(episodes, item.nodeDigest, null, item.active.appliedAt),
              after: judgedCounts(episodes, item.nodeDigest, item.active.appliedAt, null),
            },
          };
          return applyOutcomeComparison(withOutcomes, nowIso);
        });
        return { ...current, refreshedAt: nowIso, observations, crystallizations };
      });
      return;
    } catch (error) {
      if (!(error instanceof ToolchainStateConflict)) throw error;
    }
  }
}

/** Owner "analyze now": every graph automation, no rate limit. */
export function refreshAllToolchains(now = Date.now()): void {
  for (const automation of listAutomations()) {
    if (!automation.graph) continue;
    try { refreshToolchainForAutomation(automation.id, now); } catch { /* one bad automation must not hide the rest */ }
  }
}

/** After a graph run settles. Debounced per automation; never throws into the runner. */
export function scheduleToolchainRefresh(automationId: string): void {
  const now = Date.now();
  if (now - (lastAutoRefresh.get(automationId) ?? 0) < AUTO_REFRESH_INTERVAL_MS) return;
  lastAutoRefresh.set(automationId, now);
  const timer = setTimeout(() => {
    try { refreshToolchainForAutomation(automationId); } catch { /* learning is advisory */ }
  }, 5_000);
  timer.unref?.();
}
