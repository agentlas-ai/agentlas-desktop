import { nodeCouldHaveActedOutside } from "../../shared/graph-node-protocol";
import { isHostPreflightTool } from "../../shared/tool-activity";
import {
  canonicalJsonValue,
  graphExecutionDigest,
  sha256Value,
} from "../../shared/graph-execution-digest";
import type {
  Automation,
  AutomationGraphReconcileInput,
  AutomationGraphReconcileResult,
  AutomationGraphReconciliation,
  AutomationGraphReconciliationDecision,
  AutomationGraphReconciliationEvent,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeRunState,
} from "../../shared/types";
import {
  isReadOnlyCheckpointTool,
  parseGraphCheckpoint,
  type GraphCheckpoint,
} from "../workflow/run-graph";
import { emitDesktopStoreChange } from "./change-bus";
import { computeNextRun, getAutomation } from "./automations";
import { getDb } from "./db";
import { recordRunEvent, tryRecordRunEvent } from "./run-events";
import { synthesizeLegacyGraph } from "../automation-emitter";

const GRAPH_CHECKPOINT_SCHEMA = "agentlas.automation-graph-checkpoint.v3";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const MAX_RECONCILED_OUTPUT_BYTES = 256 * 1024;
const EVENT_OCCURRENCE_PREFIX = "trigger-event:";

interface LatestRunRow {
  id: string;
  automation_id: string;
  started_at: string | null;
  last_activity_at: string | null;
  status: string | null;
  node_states_json: string | null;
  occurrence_id: string | null;
  graph_digest: string | null;
  checkpoint_json: string | null;
  dry_run: number;
}

interface BoundEventRow {
  id: string;
  trigger_kind: AutomationGraphReconciliationEvent["triggerKind"];
  status: string;
  updated_at: string;
}

interface LoadedReconciliation {
  automation: Automation;
  graph: WorkflowGraph;
  run: LatestRunRow;
  checkpoint: GraphCheckpoint;
  checkpointJson: string | null;
  nodeStates: Record<string, WorkflowNodeRunState>;
  boundEvent: BoundEventRow | null;
  view: AutomationGraphReconciliation;
  /** The run failed under a graph/execution digest that has since been revised. */
  revisedGraph?: true;
}

function legacyOccurrenceId(run: LatestRunRow): string {
  return `legacy-occurrence:${sha256Value({
    automationId: run.automation_id,
    runId: run.id,
  }).slice("sha256:".length)}`;
}

function durableTimestamp(run: LatestRunRow): string {
  const candidate = run.last_activity_at ?? run.started_at;
  if (!candidate || !Number.isFinite(Date.parse(candidate))) {
    throw new Error("automation_graph_reconciliation_time_invalid");
  }
  return new Date(candidate).toISOString();
}

function occurrenceVars(automationId: string, occurrenceId: string): Record<string, unknown> {
  if (!occurrenceId.startsWith(EVENT_OCCURRENCE_PREFIX)) return {};
  const eventId = occurrenceId.slice(EVENT_OCCURRENCE_PREFIX.length);
  if (!validId(eventId)) throw new Error("automation_graph_reconciliation_bound_event_malformed");
  const row = getDb().prepare(
    `SELECT payload_json
     FROM automation_trigger_events
     WHERE id = ? AND automation_id = ?`,
  ).get(eventId, automationId) as { payload_json: string } | undefined;
  if (!row) throw new Error("automation_graph_reconciliation_bound_event_missing");
  try {
    const value = JSON.parse(row.payload_json) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // The bound event stays parked. A damaged payload can never authorize a retry.
  }
  throw new Error("automation_graph_reconciliation_bound_event_malformed");
}

// canonicalJsonValue / sha256Value / graphExecutionDigest live in
// shared/graph-execution-digest.ts. They used to be private copies here and in
// electron/workflow/run-graph.ts; changing one without the other made every
// in-flight resume fail as graph drift.

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

/**
 * The graph a run actually executed. A prompt-only (legacy) automation — every
 * Goal continuation is one — runs through runGraph with an in-memory two-node
 * graph (automation-scheduler: synthesizeLegacyGraph) that is never stored.
 * graphExecutionDigest ignores automation.graph, so the stored run digest
 * matches this reconstruction exactly; a mismatch still fails as graph drift.
 */
function executionGraphAutomation(automation: Automation): Automation {
  return automation.graph && automation.graph.nodes.length > 0
    ? automation
    : { ...automation, graph: synthesizeLegacyGraph(automation) };
}

function strictGraph(automation: Automation): WorkflowGraph {
  const graph = automation.graph;
  if (!graph || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("automation_graph_reconciliation_graph_unavailable");
  }
  const nodeIds = graph.nodes.map((node) => node.id);
  const edgeIds = graph.edges.map((edge) => edge.id);
  if (
    nodeIds.length < 1 || nodeIds.some((id) => !validId(id)) ||
    edgeIds.some((id) => !validId(id)) ||
    new Set(nodeIds).size !== nodeIds.length || new Set(edgeIds).size !== edgeIds.length ||
    graph.edges.some((edge) => !nodeIds.includes(edge.source) || !nodeIds.includes(edge.target))
  ) {
    throw new Error("automation_graph_reconciliation_graph_malformed");
  }
  return graph;
}

function parseNodeStates(raw: string | null, nodeIds: ReadonlySet<string>): Record<string, WorkflowNodeRunState> {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error("automation_graph_reconciliation_node_states_malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("automation_graph_reconciliation_node_states_malformed");
  }
  const states = value as Record<string, unknown>;
  const allowed = new Set(["pending", "running", "done", "failed", "skipped"]);
  if (
    Object.keys(states).some((nodeId) => !nodeIds.has(nodeId)) ||
    Object.values(states).some((state) => typeof state !== "string" || !allowed.has(state))
  ) {
    throw new Error("automation_graph_reconciliation_node_states_malformed");
  }
  return states as Record<string, WorkflowNodeRunState>;
}

function nodeProduces(node: WorkflowNode): string | null {
  const value = node.config?.produces;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function synthesizeLegacyCheckpoint(
  automationId: string,
  graph: WorkflowGraph,
  run: LatestRunRow,
  graphDigest: string,
  nodeStates: Record<string, WorkflowNodeRunState>,
): GraphCheckpoint | null {
  const effectNodeIds = graph.nodes
    .filter((node) => nodeCouldHaveActedOutside(node))
    .map((node) => node.id)
    .sort();
  const effects = new Set(effectNodeIds);
  if (!graph.nodes.some((node) => effects.has(node.id) && nodeStates[node.id] === "done")) {
    return null;
  }
  const ambiguousNodeIds = graph.nodes
    .filter((node) => effects.has(node.id) && (nodeStates[node.id] === "done" || nodeStates[node.id] === "failed"))
    .map((node) => node.id)
    .sort();
  const inFlightNodeIds = graph.nodes
    .filter((node) => effects.has(node.id) && nodeStates[node.id] === "running")
    .map((node) => node.id)
    .sort();
  if (ambiguousNodeIds.length === 0 && inFlightNodeIds.length === 0) return null;

  const occurrenceId = run.occurrence_id ?? legacyOccurrenceId(run);
  const completedNodeIds = graph.nodes
    .filter((node) => !effects.has(node.id) && nodeStates[node.id] === "done" && nodeProduces(node) === null)
    .map((node) => node.id)
    .sort();
  const checkpoint: GraphCheckpoint = {
    schemaVersion: GRAPH_CHECKPOINT_SCHEMA,
    occurrenceId,
    graphDigest,
    effectNodeIds,
    completedNodeIds,
    skippedNodeIds: graph.nodes
      .filter((node) => nodeStates[node.id] === "skipped")
      .map((node) => node.id)
      .sort(),
    blockedEdgeIds: [],
    inFlightNodeIds,
    ambiguousNodeIds,
    outputs: {},
    vars: occurrenceVars(automationId, occurrenceId),
    nodeInputDigests: {},
    toolReceipts: {},
    prepareReceipts: {},
    updatedAt: durableTimestamp(run),
    checkpointDigest: "sha256:" + "0".repeat(64),
  };
  return sealCheckpoint(checkpoint, checkpoint.updatedAt);
}

function boundEventForOccurrence(
  automationId: string,
  occurrenceId: string,
): BoundEventRow | null {
  if (!occurrenceId.startsWith(EVENT_OCCURRENCE_PREFIX)) return null;
  const eventId = occurrenceId.slice(EVENT_OCCURRENCE_PREFIX.length);
  if (!validId(eventId)) throw new Error("automation_graph_reconciliation_bound_event_malformed");
  const row = getDb().prepare(
    `SELECT id, trigger_kind, status, updated_at
     FROM automation_trigger_events
     WHERE id = ? AND automation_id = ?`,
  ).get(eventId, automationId) as BoundEventRow | undefined;
  if (!row) throw new Error("automation_graph_reconciliation_bound_event_missing");
  if (row.status === "claimed") throw new Error("automation_graph_reconciliation_bound_event_active");
  if (row.status !== "pending" && row.status !== "parked") {
    throw new Error("automation_graph_reconciliation_bound_event_state_invalid");
  }
  return row;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => validId(id)) : [];
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).filter(validId) : [];
}

/** Label/type of a node the current graph no longer has, from the newest saved version that had it. */
function revisedNodeDescriptors(
  automationId: string,
  currentGraph: WorkflowGraph,
  nodeIds: readonly string[],
): Map<string, { label: string; type: WorkflowNode["type"] }> {
  const found = new Map<string, { label: string; type: WorkflowNode["type"] }>();
  const take = (graph: WorkflowGraph | null): void => {
    for (const node of graph?.nodes ?? []) {
      if (!node || !nodeIds.includes(node.id) || found.has(node.id)) continue;
      found.set(node.id, { label: node.label?.trim() || node.id, type: node.type });
    }
  };
  take(currentGraph);
  if (found.size < nodeIds.length) {
    const rows = getDb().prepare(
      `SELECT graph_json FROM automation_graph_versions
       WHERE automation_id = ? ORDER BY saved_at DESC, id DESC LIMIT 20`,
    ).all(automationId) as Array<{ graph_json: string }>;
    for (const row of rows) {
      if (found.size >= nodeIds.length) break;
      try { take(JSON.parse(row.graph_json) as WorkflowGraph); } catch { /* a damaged version names nothing */ }
    }
  }
  return found;
}

/**
 * ★그래프(또는 실행 필드 — 런타임·권한·도구 모드)가 **실패한 실행 뒤에 바뀌면** 그 실행의
 *   미확인 부수효과는 영영 재조정할 수 없었다. 재조정 좌표를 "지금 그래프"로 검증했기 때문이다.
 *
 *   실측(설치본 DB, 2026-08-25~09-25): 모호한 실패 뒤 digest 가 바뀐 경우가 5번(자동화 2개).
 *   f7a61706(Threads) 2026-09-23: 13:55Z 앱 재시작이 `report` 단계를 모호하게 끊었고, 15:10Z
 *   목표 턴이 그래프를 새로 썼다(audit/engage/publish/report → inspect/strategy/content/publish/
 *   measure). 그 뒤로 재조정은 graph_drift, 실행은 partial_graph_changed, 효과 관찰은 보류를
 *   못 읽어(getAutomationEffectHold 가 던짐) 조용히 건너뛰었다 — 오너가 "처음부터"를 누를 때까지
 *   예약이 멈춰 있었다. 그리고 digest 에는 runtimeSelection 이 들어 있어, 오너가 모델만 바꿔도
 *   같은 막다른 길이 된다.
 *
 *   "그 단계가 바깥에서 일어났는가"는 **그 실행이 스스로 기록한 것**에 대한 질문이다 — 지금
 *   그래프와 무관하다. 체크포인트는 자기 해시로 봉인돼 있으므로(checkpointDigest) 그래프 없이도
 *   무결성을 검증할 수 있다. 그래서 바뀐 그래프에서는 체크포인트 자신의 노드 집합으로 검증하고,
 *   관찰(묻기 전에 직접 본다)·오너의 재조정이 그대로 닫을 수 있게 한다. 닫힌 옛 발생은 재개하지
 *   않는다(바뀐 그래프로 이어 붙일 좌표가 없다) — 다음 실행은 새 그래프로 새로 돈다.
 *
 *   잊는 것이 아니다: 결정은 workflow_node_reconciled 로 남고, 옛 실행 기록은 그대로다.
 *   트리거 이벤트에 묶인 발생·시뮬레이션·봉인 없는 레거시 행은 지금처럼 사람 몫으로 둔다
 *   ("unsupported" → graph_drift).
 */
function loadRevisedGraphReconciliation(
  automation: Automation,
  currentGraph: WorkflowGraph,
  run: LatestRunRow,
  exact?: { runId: string; occurrenceId: string },
): LoadedReconciliation | null | "unsupported" {
  if (run.dry_run === 1 || !run.graph_digest || !run.checkpoint_json) return "unsupported";
  if (Buffer.byteLength(run.checkpoint_json, "utf8") > MAX_CHECKPOINT_BYTES) return "unsupported";
  let raw: Record<string, unknown>;
  try {
    const value = JSON.parse(run.checkpoint_json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "unsupported";
    raw = value as Record<string, unknown>;
  } catch {
    return "unsupported";
  }
  if (typeof raw.occurrenceId !== "string" || raw.occurrenceId.startsWith(EVENT_OCCURRENCE_PREFIX)) return "unsupported";
  let rawStates: unknown;
  try { rawStates = run.node_states_json ? JSON.parse(run.node_states_json) : {}; } catch { return "unsupported"; }
  const universe = new Set<string>([
    ...stringIds(raw.effectNodeIds), ...stringIds(raw.completedNodeIds), ...stringIds(raw.skippedNodeIds),
    ...stringIds(raw.inFlightNodeIds), ...stringIds(raw.ambiguousNodeIds),
    ...objectKeys(raw.outputs), ...objectKeys(raw.nodeInputDigests), ...objectKeys(raw.toolReceipts),
    ...objectKeys(raw.prepareReceipts), ...objectKeys(rawStates),
  ]);
  if (universe.size === 0) return "unsupported";
  const blockedEdgeIds = stringIds(raw.blockedEdgeIds);
  const checkpoint = parseGraphCheckpoint(
    raw,
    run.graph_digest,
    run.occurrence_id ?? raw.occurrenceId,
    universe,
    new Set(blockedEdgeIds),
    new Set(stringIds(raw.effectNodeIds)),
  );
  if (!checkpoint) return "unsupported";
  if (exact && checkpoint.occurrenceId !== exact.occurrenceId) {
    throw new Error("automation_graph_reconciliation_conflict");
  }
  const nodeStates = parseNodeStates(run.node_states_json ?? "{}", universe);
  const ambiguous = new Set(checkpoint.ambiguousNodeIds);
  const inFlight = new Set(checkpoint.inFlightNodeIds);
  const unresolvedIds = [...universe].filter((id) => ambiguous.has(id) || inFlight.has(id)).sort();
  if (unresolvedIds.length === 0) return null;
  const descriptors = revisedNodeDescriptors(automation.id, currentGraph, [...universe]);
  const anchor = [...universe][0];
  // A self-described graph of the old run: identities only. No node declares
  // `produces` — outputs of the old graph cannot feed the revised one.
  const graph: WorkflowGraph = {
    version: 1,
    nodes: [...universe].sort().map((id) => ({
      id,
      type: descriptors.get(id)?.type ?? "agent",
      position: { x: 0, y: 0 },
      config: {},
      label: descriptors.get(id)?.label ?? id,
    })),
    edges: blockedEdgeIds.map((id) => ({ id, source: anchor, target: anchor })),
  };
  return {
    automation,
    graph,
    run,
    checkpoint,
    checkpointJson: run.checkpoint_json,
    nodeStates,
    boundEvent: null,
    revisedGraph: true,
    view: {
      automationId: automation.id,
      runId: run.id,
      occurrenceId: checkpoint.occurrenceId,
      graphDigest: run.graph_digest,
      checkpointDigest: checkpoint.checkpointDigest,
      updatedAt: checkpoint.updatedAt,
      simulation: false,
      triggerEvent: null,
      graphRevisedSinceRun: true,
      nodes: unresolvedIds.map((id) => ({
        nodeId: id,
        label: descriptors.get(id)?.label ?? id,
        nodeType: descriptors.get(id)?.type ?? "agent",
        uncertainty: ambiguous.has(id) ? "ambiguous" as const : "in_flight" as const,
        produces: null,
        outputRequired: false,
        hasRecordedOutput: Object.prototype.hasOwnProperty.call(checkpoint.outputs, id),
      })),
    },
  };
}

function loadReconciliation(
  automationId: string,
  exact?: { runId: string; occurrenceId: string },
): LoadedReconciliation | null {
  if (!validId(automationId)) throw new Error("automation_graph_reconciliation_input_invalid");
  const automation = getAutomation(automationId);
  if (!automation) throw new Error("automation_graph_reconciliation_automation_missing");
  const graph = strictGraph(executionGraphAutomation(automation));
  const run = exact
    ? getDb().prepare(
        `SELECT id, automation_id, started_at, last_activity_at, status, node_states_json,
                occurrence_id, graph_digest, checkpoint_json, dry_run
         FROM automation_runs
         WHERE automation_id = ? AND id = ?`,
      ).get(automationId, exact.runId) as LatestRunRow | undefined
    : getDb().prepare(
        `SELECT id, automation_id, started_at, last_activity_at, status, node_states_json,
                occurrence_id, graph_digest, checkpoint_json, dry_run
         FROM automation_runs
         WHERE automation_id = ?
         ORDER BY started_at DESC, rowid DESC
         LIMIT 1`,
      ).get(automationId) as LatestRunRow | undefined;
  if (!run || run.status !== "error") return null;

  const currentGraphDigest = graphExecutionDigest(automation, graph);
  if (run.graph_digest && run.graph_digest !== currentGraphDigest) {
    const revised = loadRevisedGraphReconciliation(automation, graph, run, exact);
    if (revised !== "unsupported") return revised;
  }
  if (!run.graph_digest || run.graph_digest !== currentGraphDigest) {
    throw new Error("automation_graph_reconciliation_graph_drift");
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const effectNodeIds = new Set(
    graph.nodes
      .filter((node) => nodeCouldHaveActedOutside(node))
      .map((node) => node.id),
  );
  const nodeStates = parseNodeStates(run.node_states_json, nodeIds);
  let rawCheckpoint: unknown = null;
  if (run.checkpoint_json) {
    try {
      rawCheckpoint = JSON.parse(run.checkpoint_json);
    } catch {
      rawCheckpoint = null;
    }
  }
  const parsedCheckpoint = parseGraphCheckpoint(
    rawCheckpoint,
    currentGraphDigest,
    run.occurrence_id,
    nodeIds,
    edgeIds,
    effectNodeIds,
  );
  const checkpoint = parsedCheckpoint ?? synthesizeLegacyCheckpoint(
    automationId,
    graph,
    run,
    currentGraphDigest,
    nodeStates,
  );
  if (!checkpoint) throw new Error("automation_graph_reconciliation_checkpoint_malformed");
  if (exact && checkpoint.occurrenceId !== exact.occurrenceId) {
    throw new Error("automation_graph_reconciliation_conflict");
  }
  const ambiguous = new Set(checkpoint.ambiguousNodeIds);
  const inFlight = new Set(checkpoint.inFlightNodeIds);
  const unresolvedNodes = graph.nodes.filter((node) => ambiguous.has(node.id) || inFlight.has(node.id));
  if (unresolvedNodes.length === 0) return null;
  const boundEvent = boundEventForOccurrence(automationId, checkpoint.occurrenceId);
  if (run.dry_run === 1 && boundEvent) {
    throw new Error("automation_graph_reconciliation_simulation_event_invalid");
  }
  return {
    automation,
    graph,
    run,
    checkpoint,
    checkpointJson: run.checkpoint_json,
    nodeStates,
    boundEvent,
    view: {
      automationId,
      runId: run.id,
      occurrenceId: checkpoint.occurrenceId,
      graphDigest: currentGraphDigest,
      checkpointDigest: checkpoint.checkpointDigest,
      updatedAt: checkpoint.updatedAt,
      simulation: run.dry_run === 1,
      triggerEvent: boundEvent ? {
        id: boundEvent.id,
        triggerKind: boundEvent.trigger_kind,
        status: boundEvent.status as AutomationGraphReconciliationEvent["status"],
        updatedAt: boundEvent.updated_at,
      } : null,
      nodes: unresolvedNodes.map((node) => {
        const produces = nodeProduces(node);
        return {
          nodeId: node.id,
          label: node.label?.trim() || node.id,
          nodeType: node.type,
          uncertainty: ambiguous.has(node.id) ? "ambiguous" : "in_flight",
          produces,
          outputRequired: produces !== null,
          hasRecordedOutput: Object.prototype.hasOwnProperty.call(checkpoint.outputs, node.id),
        };
      }),
    },
  };
}

function validateOutput(decision: AutomationGraphReconciliationDecision, produces: string | null): void {
  if (decision.output !== undefined && typeof decision.output !== "string") {
    throw new Error("automation_graph_reconciliation_output_invalid");
  }
  if (decision.resolution === "completed" && produces && !decision.output?.trim()) {
    throw new Error(`automation_graph_reconciliation_output_required:${decision.nodeId}`);
  }
  if (
    typeof decision.output === "string" &&
    Buffer.byteLength(decision.output, "utf8") > MAX_RECONCILED_OUTPUT_BYTES
  ) {
    throw new Error(`automation_graph_reconciliation_output_too_large:${decision.nodeId}`);
  }
}

function nextUpdatedAt(previous: string, now: Date): string {
  const previousMs = Date.parse(previous);
  const nowMs = now.getTime();
  if (!Number.isFinite(previousMs) || !Number.isFinite(nowMs)) {
    throw new Error("automation_graph_reconciliation_time_invalid");
  }
  return new Date(Math.max(nowMs, previousMs + 1)).toISOString();
}

function sealCheckpoint(checkpoint: GraphCheckpoint, updatedAt: string): GraphCheckpoint {
  checkpoint.updatedAt = updatedAt;
  const { checkpointDigest: _oldDigest, ...payload } = checkpoint;
  checkpoint.checkpointDigest = sha256Value(payload);
  return checkpoint;
}

function outputEvidence(output: string | undefined): { digest: string | null; bytes: number } {
  if (output === undefined) return { digest: null, bytes: 0 };
  return { digest: sha256Value(output), bytes: Buffer.byteLength(output, "utf8") };
}

function exactDecisionMap(
  loaded: LoadedReconciliation,
  decisions: AutomationGraphReconciliationDecision[],
): Map<string, AutomationGraphReconciliationDecision> {
  if (!Array.isArray(decisions) || decisions.length !== loaded.view.nodes.length) {
    throw new Error("automation_graph_reconciliation_decisions_incomplete");
  }
  const map = new Map<string, AutomationGraphReconciliationDecision>();
  for (const decision of decisions) {
    if (
      !decision || !validId(decision.nodeId) ||
      (decision.resolution !== "completed" && decision.resolution !== "retry") ||
      map.has(decision.nodeId)
    ) {
      throw new Error("automation_graph_reconciliation_decisions_invalid");
    }
    map.set(decision.nodeId, decision);
  }
  for (const node of loaded.view.nodes) {
    const decision = map.get(node.nodeId);
    if (!decision) throw new Error("automation_graph_reconciliation_decisions_incomplete");
    validateOutput(decision, node.produces);
  }
  if ([...map.keys()].some((nodeId) => !loaded.view.nodes.some((node) => node.nodeId === nodeId))) {
    throw new Error("automation_graph_reconciliation_node_invalid");
  }
  return map;
}

/**
 * A scheduled occurrence with unresolved side effects must not keep entering
 * the runner on a timer. Keep the automation enabled, but remove its due time
 * until the explicit reconciliation commit restores the regular schedule.
 */
export function suspendAutomationForGraphReconciliation(automationId: string): boolean {
  if (!validId(automationId)) return false;
  const result = getDb().prepare(
    `UPDATE automations
     SET next_run_at = NULL
     WHERE id = ? AND enabled = 1 AND COALESCE(trigger_type, 'schedule') = 'schedule'
       AND next_run_at IS NOT NULL`,
  ).run(automationId);
  if (result.changes > 0) emitDesktopStoreChange({ entity: "automation", id: automationId });
  return result.changes > 0;
}

export function getAutomationGraphReconciliation(
  automationId: string,
): AutomationGraphReconciliation | null {
  if (!validId(automationId)) throw new Error("automation_graph_reconciliation_input_invalid");
  // Form-created automations intentionally begin with a renderer-synthesized graph.
  // With no durable graph there can be no receipt-backed node reconciliation yet.
  // This is an ordinary empty state, not a recovery failure.
  const automation = getAutomation(automationId);
  if (!automation) throw new Error("automation_graph_reconciliation_automation_missing");
  if (!automation.graph) return null;
  // A newer manual/scheduled occurrence must not hide an older parked source
  // occurrence. For each bound event, inspect only its newest run; a later
  // successful resume supersedes older failed snapshots for that occurrence.
  const boundRows = getDb().prepare(
    `SELECT r.id, r.occurrence_id, r.status
     FROM automation_trigger_events e
     JOIN automation_runs r
       ON r.automation_id = e.automation_id
      AND r.occurrence_id = ('trigger-event:' || e.id)
     WHERE e.automation_id = ? AND e.status IN ('pending', 'parked')
     ORDER BY r.started_at DESC, r.rowid DESC`,
  ).all(automationId) as Array<{ id: string; occurrence_id: string | null; status: string | null }>;
  const seenOccurrences = new Set<string>();
  const inspectedRunIds = new Set<string>();
  for (const row of boundRows) {
    if (!row.occurrence_id || seenOccurrences.has(row.occurrence_id)) continue;
    seenOccurrences.add(row.occurrence_id);
    if (row.status !== "error") continue;
    inspectedRunIds.add(row.id);
    const loaded = loadReconciliation(automationId, { runId: row.id, occurrenceId: row.occurrence_id });
    if (loaded) return loaded.view;
  }
  const latest = loadReconciliation(automationId);
  if (!latest || inspectedRunIds.has(latest.run.id)) return null;
  return latest.view;
}

/**
 * Effect-observation seam (owner 2026-09-23 "look before asking"): the same
 * exact reconciliation view, including prompt-only automations whose run used
 * the synthesized legacy graph. The renderer-facing getter above keeps its
 * historical empty state for graphless rows; reconcileAutomationGraph accepts
 * both because it re-loads through the same executionGraphAutomation.
 */
export function getAutomationEffectHold(automationId: string): AutomationGraphReconciliation | null {
  if (!validId(automationId)) throw new Error("automation_graph_reconciliation_input_invalid");
  const automation = getAutomation(automationId);
  if (!automation) throw new Error("automation_graph_reconciliation_automation_missing");
  if (automation.graph && automation.graph.nodes.length > 0) return getAutomationGraphReconciliation(automationId);
  const latest = loadReconciliation(automationId);
  return latest?.view ?? null;
}

/**
 * Reconcile every uncertain node and its bound source occurrence in one
 * IMMEDIATE SQLite transaction. A stale renderer can never consume a newer
 * checkpoint, and an outbox peer can never claim between checkpoint and event
 * updates.
 */
/**
 * 그래프를 고친 뒤 **실행도 재조정도 안 되는** 상태를 사람이 스스로 푼다.
 *
 * 실측 2026-08-20. 부수효과를 남기고 실패한 실행이 있는 상태에서 그래프를 고치면:
 *   · 실행 → `automation_partial_graph_changed` (바뀐 그래프로 재생할 수 없다)
 *   · 재조정 → `automation_graph_reconciliation_graph_drift` (좌표가 그 그래프의 것이 아니다)
 * 둘 다 옳은 거절인데, 합치면 **그 자동화는 영구히 잠긴다.** 그래프를 편집한 사람은
 * 누구나 이 상태에 빠질 수 있고, 빠져나갈 문이 없었다.
 *
 * 문은 하나면 된다 — 사람이 "이전 실행은 잊고 처음부터"라고 말하는 것. 그건 위험을
 * 아는 사람만 할 수 있는 결정이라 자동으로 하지 않는다. 부르는 쪽이 그 뜻을 사용자에게
 * 분명히 말한 뒤에만 부른다: **이전 실행이 이미 한 일은 다시 일어날 수 있다.**
 *
 * 그래프가 실제로 바뀌지 않았으면 거절한다 — 그때는 재조정이 옳은 길이고, 이 문으로
 * 나가면 이미 일어난 일을 한 번 더 하게 된다.
 */
export function forgetStaleGraphCheckpoint(
  automationId: string,
  currentGraphDigest: string,
): { forgot: boolean; reason?: string } {
  const db = getDb();
  const row = db.prepare(
    "SELECT id, status, graph_digest FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
  ).get(automationId) as { id: string; status: string; graph_digest: string | null } | undefined;
  if (!row) return { forgot: false, reason: "no_run" };
  if (row.status !== "error") return { forgot: false, reason: "latest_run_did_not_fail" };
  if (!row.graph_digest) return { forgot: false, reason: "no_recorded_graph" };
  if (row.graph_digest === currentGraphDigest) return { forgot: false, reason: "graph_unchanged" };
  db.prepare(
    `UPDATE automation_runs
        SET status = 'skipped', node_states_json = '{}', checkpoint_json = NULL,
            node_failures_json = NULL, graph_digest = ?, resume_consumed_at = NULL
      WHERE id = ?`,
  ).run(currentGraphDigest, row.id);
  return { forgot: true };
}

export function reconcileAutomationGraph(
  input: AutomationGraphReconcileInput & { now?: Date },
): AutomationGraphReconcileResult {
  if (
    !validId(input.automationId) || !validId(input.runId) || !validId(input.occurrenceId) ||
    !SHA256_RE.test(input.graphDigest) || !SHA256_RE.test(input.checkpointDigest) ||
    typeof input.expectedUpdatedAt !== "string"
  ) {
    throw new Error("automation_graph_reconciliation_input_invalid");
  }
  const db = getDb();
  const now = input.now ?? new Date();
  let result: AutomationGraphReconcileResult | null = null;
  const commit = db.transaction(() => {
    const loaded = loadReconciliation(input.automationId, {
      runId: input.runId,
      occurrenceId: input.occurrenceId,
    });
    if (!loaded) throw new Error("automation_graph_reconciliation_conflict");
    if (
      loaded.run.id !== input.runId ||
      loaded.checkpoint.occurrenceId !== input.occurrenceId ||
      loaded.view.graphDigest !== input.graphDigest ||
      loaded.checkpoint.checkpointDigest !== input.checkpointDigest ||
      loaded.checkpoint.updatedAt !== input.expectedUpdatedAt
    ) {
      throw new Error("automation_graph_reconciliation_conflict");
    }
    if (loaded.boundEvent) {
      if (
        input.eventId !== loaded.boundEvent.id ||
        input.expectedEventUpdatedAt !== loaded.boundEvent.updated_at
      ) {
        throw new Error("automation_graph_reconciliation_event_conflict");
      }
    } else if (input.eventId != null || input.expectedEventUpdatedAt != null) {
      throw new Error("automation_graph_reconciliation_event_conflict");
    }

    const decisions = exactDecisionMap(loaded, input.decisions);
    const checkpoint = structuredClone(loaded.checkpoint);
    const completed = new Set(checkpoint.completedNodeIds);
    const skipped = new Set(checkpoint.skippedNodeIds);
    const unresolved = new Set([...checkpoint.ambiguousNodeIds, ...checkpoint.inFlightNodeIds]);
    const completedByUser: string[] = [];
    const retryByUser: string[] = [];

    for (const node of loaded.graph.nodes) {
      if (!unresolved.has(node.id)) continue;
      const decision = decisions.get(node.id)!;
      const produces = nodeProduces(node);
      const priorOutput = checkpoint.outputs[node.id];
      const priorOutputEvidence = outputEvidence(priorOutput);
      const priorInputDigest = checkpoint.nodeInputDigests[node.id] ?? null;
      const priorToolReceipts = checkpoint.toolReceipts[node.id] ?? [];
      const priorPrepareReceipts = checkpoint.prepareReceipts[node.id] ?? [];

      completed.delete(node.id);
      skipped.delete(node.id);
      delete checkpoint.outputs[node.id];
      if (produces) delete checkpoint.vars[produces];

      if (decision.resolution === "completed") {
        completed.add(node.id);
        completedByUser.push(node.id);
        loaded.nodeStates[node.id] = "done";
        if (decision.output !== undefined) checkpoint.outputs[node.id] = decision.output;
        if (produces) checkpoint.vars[produces] = decision.output!;
      } else {
        retryByUser.push(node.id);
        loaded.nodeStates[node.id] = "failed";
        delete checkpoint.nodeInputDigests[node.id];
        delete checkpoint.toolReceipts[node.id];
        delete checkpoint.prepareReceipts[node.id];
      }

      const manualOutputEvidence = outputEvidence(decision.output);
      recordRunEvent({
        runId: loaded.run.id,
        kind: "workflow_node_reconciled",
        automationId: loaded.automation.id,
        nodeId: node.id,
        payload: {
          resolution: decision.resolution,
          previousCheckpointDigest: loaded.checkpoint.checkpointDigest,
          priorOutputDigest: priorOutputEvidence.digest,
          priorOutputBytes: priorOutputEvidence.bytes,
          priorInputDigest,
          priorToolReceiptNames: priorToolReceipts.map((receipt) => receipt.name),
          priorToolReceiptDigests: priorToolReceipts.map((receipt) => receipt.resultDigest),
          priorPrepareReceiptIds: priorPrepareReceipts.map((receipt) => receipt.preparationReceiptId),
          priorPrepareReceiptDigests: priorPrepareReceipts.map((receipt) => receipt.receiptDigest),
          manualOutputDigest: manualOutputEvidence.digest,
          manualOutputBytes: manualOutputEvidence.bytes,
          produces,
        },
      });
    }

    checkpoint.completedNodeIds = [...completed].sort();
    checkpoint.skippedNodeIds = [...skipped].sort();
    checkpoint.ambiguousNodeIds = checkpoint.ambiguousNodeIds.filter((nodeId) => !unresolved.has(nodeId));
    checkpoint.inFlightNodeIds = checkpoint.inFlightNodeIds.filter((nodeId) => !unresolved.has(nodeId));
    const updatedAt = nextUpdatedAt(checkpoint.updatedAt, now);
    sealCheckpoint(checkpoint, updatedAt);
    const checkpointJson = JSON.stringify(checkpoint);
    if (Buffer.byteLength(checkpointJson, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new Error("automation_graph_reconciliation_checkpoint_too_large");
    }

    const revalidated = parseGraphCheckpoint(
      checkpoint,
      loaded.view.graphDigest,
      checkpoint.occurrenceId,
      new Set(loaded.graph.nodes.map((node) => node.id)),
      new Set(loaded.graph.edges.map((edge) => edge.id)),
      new Set(checkpoint.effectNodeIds),
    );
    if (!revalidated) throw new Error("automation_graph_reconciliation_checkpoint_invalid_after_update");

    const runUpdated = db.prepare(
      `UPDATE automation_runs
       SET occurrence_id = ?, checkpoint_json = ?, node_states_json = ?, last_activity_at = ?
       WHERE id = ? AND automation_id = ? AND status = 'error'
         AND graph_digest = ? AND occurrence_id IS ? AND checkpoint_json IS ?`,
    ).run(
      checkpoint.occurrenceId,
      checkpointJson,
      JSON.stringify(loaded.nodeStates),
      updatedAt,
      loaded.run.id,
      loaded.automation.id,
      loaded.view.graphDigest,
      loaded.run.occurrence_id,
      loaded.checkpointJson,
    );
    if (runUpdated.changes !== 1) throw new Error("automation_graph_reconciliation_conflict");

    const terminalNodeIds = new Set([...checkpoint.completedNodeIds, ...checkpoint.skippedNodeIds]);
    const allNodesTerminal = loaded.graph.nodes.every((node) => terminalNodeIds.has(node.id));
    let eventStatus: AutomationGraphReconcileResult["eventStatus"] = null;
    if (loaded.boundEvent) {
      eventStatus = allNodesTerminal ? "delivered" : "pending";
      const eventUpdated = allNodesTerminal
        ? db.prepare(
            `UPDATE automation_trigger_events
             SET status = 'delivered', claim_owner = NULL, claimed_until = NULL,
                 run_id = ?, delivered_at = ?, last_error = NULL, updated_at = ?
             WHERE id = ? AND automation_id = ? AND status = ? AND updated_at = ?`,
          ).run(
            loaded.run.id,
            updatedAt,
            updatedAt,
            loaded.boundEvent.id,
            loaded.automation.id,
            loaded.boundEvent.status,
            loaded.boundEvent.updated_at,
          )
        : db.prepare(
            `UPDATE automation_trigger_events
             SET status = 'pending', claim_owner = NULL, claimed_until = NULL,
                 attempt_count = 0, next_attempt_at = ?, run_id = NULL, run_outcome = NULL,
                 delivered_at = NULL, last_error = NULL, updated_at = ?
             WHERE id = ? AND automation_id = ? AND status = ? AND updated_at = ?`,
          ).run(
            updatedAt,
            updatedAt,
            loaded.boundEvent.id,
            loaded.automation.id,
            loaded.boundEvent.status,
            loaded.boundEvent.updated_at,
          );
      if (eventUpdated.changes !== 1) {
        throw new Error("automation_graph_reconciliation_event_conflict");
      }
    }

    let restoredNextRunAt: string | null = null;
    if (
      (loaded.automation.triggerType ?? "schedule") === "schedule" &&
      loaded.automation.enabled
    ) {
      restoredNextRunAt = computeNextRun(loaded.automation.scheduleHuman, now, {
        scheduleJson: loaded.automation.scheduleSpec
          ? JSON.stringify(loaded.automation.scheduleSpec)
          : null,
        timezone: loaded.automation.timezone ?? null,
      });
      const scheduleUpdated = db.prepare(
        `UPDATE automations
         SET next_run_at = ?
         WHERE id = ? AND enabled = 1 AND COALESCE(trigger_type, 'schedule') = 'schedule'`,
      ).run(restoredNextRunAt, loaded.automation.id);
      if (scheduleUpdated.changes !== 1) {
        throw new Error("automation_graph_reconciliation_schedule_conflict");
      }
    }

    recordRunEvent({
      runId: loaded.run.id,
      kind: "workflow_reconciliation_committed",
      automationId: loaded.automation.id,
      payload: {
        previousCheckpointDigest: loaded.checkpoint.checkpointDigest,
        checkpointDigest: checkpoint.checkpointDigest,
        completedNodeIds: completedByUser,
        retryNodeIds: retryByUser,
        triggerEventId: loaded.boundEvent?.id ?? null,
        triggerEventStatus: eventStatus,
        restoredNextRunAt,
        simulation: loaded.run.dry_run === 1,
        // The old occurrence cannot resume under the revised graph; this close
        // lets the next run start fresh (run-graph hasRevisedGraphReconciliationClose).
        ...(loaded.revisedGraph ? { graphRevised: true } : {}),
      },
    });

    result = {
      automationId: loaded.automation.id,
      runId: loaded.run.id,
      checkpointDigest: checkpoint.checkpointDigest,
      updatedAt: checkpoint.updatedAt,
      simulation: loaded.run.dry_run === 1,
      eventStatus,
      resumeRequired: loaded.revisedGraph ? false : !allNodesTerminal,
      completedNodeIds: completedByUser,
      retryNodeIds: retryByUser,
    };
  });
  commit.immediate();
  if (!result) throw new Error("automation_graph_reconciliation_missing_result");
  emitDesktopStoreChange({ entity: "automation", id: input.automationId });
  return result;
}

/**
 * Repair historical Graph suspensions only when the terminal run's durable
 * host events and receipts agree that every unresolved call was observation. Older v3
 * checkpoints marked all browser calls as mutations from their names alone.
 * Use the existing exact-coordinate reconciliation transaction so the schedule
 * and the same occurrence resume together; never edit next_run_at by itself.
 */
export function recoverReadOnlySuspendedGraphs(): AutomationGraphReconcileResult[] {
  const db = getDb();
  const candidates = db.prepare(
    `SELECT id FROM automations
     WHERE enabled = 1 AND next_run_at IS NULL
       AND COALESCE(trigger_type, 'schedule') = 'schedule'`,
  ).all() as Array<{ id: string }>;
  const recovered: AutomationGraphReconcileResult[] = [];
  for (const candidate of candidates) {
    try {
      if (!getAutomation(candidate.id)?.graph) continue;
      const loaded = loadReconciliation(candidate.id);
      if (!loaded || loaded.run.dry_run === 1 || loaded.boundEvent ||
          loaded.checkpoint.schemaVersion !== GRAPH_CHECKPOINT_SCHEMA ||
          loaded.checkpoint.inFlightNodeIds.length > 0 ||
          loaded.checkpoint.ambiguousNodeIds.length === 0 ||
          loaded.view.nodes.some((node) => node.uncertainty !== "ambiguous")) continue;
      const unresolved = new Set(loaded.checkpoint.ambiguousNodeIds);
      const failureRow = db.prepare(
        "SELECT node_failures_json FROM automation_runs WHERE id = ? AND automation_id = ? AND status = 'error'",
      ).get(loaded.run.id, candidate.id) as { node_failures_json: string | null } | undefined;
      if (!failureRow?.node_failures_json) continue;
      const failures = JSON.parse(failureRow.node_failures_json) as Record<string, { code?: unknown }>;
      if ([...unresolved].some((nodeId) => failures[nodeId]?.code !== "MUTATION_UNVERIFIED" ||
          (loaded.checkpoint.prepareReceipts[nodeId]?.length ?? 0) > 0)) continue;

      // 501 is a refusal threshold, not a truncated evidence window. A large
      // ledger cannot establish that every call was checked.
      const rows = db.prepare(
        `SELECT node_id, payload_json FROM run_events
         WHERE run_id = ? AND kind = 'mcp_tool-use' ORDER BY seq ASC LIMIT 501`,
      ).all(loaded.run.id) as Array<{ node_id: string | null; payload_json: string }>;
      if (rows.length === 0 || rows.length >= 501) continue;
      const namesByNode = new Map<string, Set<string>>();
      let allObservedCallsReadOnly = true;
      for (const row of rows) {
        if (!row.node_id) {
          allObservedCallsReadOnly = false;
          break;
        }
        if (!unresolved.has(row.node_id)) continue;
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        const name = payload.toolName;
        const args = payload.toolArgs;
        if (typeof name !== "string" || !name || !isReadOnlyCheckpointTool(name, args) ||
            (!isHostPreflightTool(name) &&
              (typeof payload.toolId !== "string" || !payload.toolId))) {
          allObservedCallsReadOnly = false;
          break;
        }
        const names = namesByNode.get(row.node_id) ?? new Set<string>();
        names.add(name);
        namesByNode.set(row.node_id, names);
      }
      if (!allObservedCallsReadOnly) continue;
      if ([...unresolved].some((nodeId) => {
        const receipts = loaded.checkpoint.toolReceipts[nodeId] ?? [];
        const names = namesByNode.get(nodeId);
        return !names || receipts.length === 0 ||
          receipts.some((receipt) => !names.has(receipt.name));
      })) continue;

      const view = loaded.view;
      const result = reconcileAutomationGraph({
        automationId: candidate.id,
        runId: view.runId,
        occurrenceId: view.occurrenceId,
        graphDigest: view.graphDigest,
        checkpointDigest: view.checkpointDigest,
        expectedUpdatedAt: view.updatedAt,
        decisions: view.nodes.map((node) => ({ nodeId: node.nodeId, resolution: "retry" as const })),
      });
      tryRecordRunEvent({
        runId: result.runId,
        kind: "workflow_readonly_auto_reconciled",
        automationId: candidate.id,
        payload: { retryNodeIds: result.retryNodeIds, priorCheckpointDigest: view.checkpointDigest },
      });
      recovered.push(result);
    } catch (error) {
      // A malformed or concurrently changed run stays suspended. The exact
      // reconciliation UI remains available; one candidate cannot starve the
      // other schedules.
      console.warn(`[automation] read-only graph recovery skipped (${candidate.id}):`, error);
    }
  }
  return recovered;
}
