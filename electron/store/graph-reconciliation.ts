import { nodeCouldHaveActedOutside } from "../../shared/graph-node-protocol";
import { isHostPreflightTool } from "../../shared/tool-activity";
import {
  canonicalJsonValue,
  graphExecutionDigest,
  sha256Value,
  GRAPH_CHECKPOINT_SCHEMA,
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
  reconcileReadOnlyInterruptedAgentNodes,
  type GraphCheckpoint,
} from "../workflow/run-graph";
import { emitDesktopStoreChange } from "./change-bus";
import { computeNextRun, getAutomation, hasDurableActiveAutomationExecution } from "./automations";
import { getDb } from "./db";
import { recordRunEvent, tryRecordRunEvent } from "./run-events";
import { resolveAutomationGraph } from "../../shared/automation-graph-definition";
import { getAutomationDefinitionDigest } from "../long-run/automation-provenance";

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

function legacyOccurrenceId(run: Pick<LatestRunRow, "id" | "automation_id">): string {
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
  return { ...automation, graph: resolveAutomationGraph(automation) };
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
    loginWaits: {},
    updatedAt: durableTimestamp(run),
    checkpointDigest: "sha256:" + "0".repeat(64),
  };
  return sealCheckpoint(checkpoint, checkpoint.updatedAt);
}

function boundEventForOccurrence(
  automationId: string,
  occurrenceId: string,
  evidenceOnly = false,
): BoundEventRow | null {
  if (!occurrenceId.startsWith(EVENT_OCCURRENCE_PREFIX)) return null;
  const eventId = occurrenceId.slice(EVENT_OCCURRENCE_PREFIX.length);
  if (!validId(eventId)) {
    if (evidenceOnly) return null;
    throw new Error("automation_graph_reconciliation_bound_event_malformed");
  }
  const row = getDb().prepare(
    `SELECT id, trigger_kind, status, updated_at
     FROM automation_trigger_events
     WHERE id = ? AND automation_id = ?`,
  ).get(eventId, automationId) as BoundEventRow | undefined;
  // Trigger state does not veto node settlement. A pending/parked trigger can
  // join the existing atomic reducer; every other trigger keeps its own custody.
  return row && ["pending", "parked"].includes(row.status) ? row : null;
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
 *   이벤트 발생도 같은 과거 증거로 정산한다. 바뀐 그래프로 이벤트를 재개하거나 완료 처리하지는
 *   않는다. 이벤트의 재시도·완료는 기존 이벤트 정산 경로가 별도로 결정한다.
 *   시뮬레이션·봉인 없는 레거시 행은 기존 경계를 유지한다.
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
  if (typeof raw.occurrenceId !== "string") return "unsupported";
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
  evidenceOnly = false,
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
  const boundEvent = boundEventForOccurrence(automationId, checkpoint.occurrenceId, evidenceOnly);
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
 * Workspace recovery retains a bounded wake. Effect quarantine is handled
 * separately by recoverGraphScheduleCursors, using the sealed node frontier.
 */
export function suspendAutomationForGraphReconciliation(automationId: string): boolean {
  if (!validId(automationId)) return false;
  const result = getDb().prepare(
    `UPDATE automations
     SET next_run_at = CASE WHEN next_run_at IS NULL OR next_run_at > ? THEN ? ELSE next_run_at END
     WHERE id = ? AND enabled = 1 AND COALESCE(trigger_type, 'schedule') = 'schedule'`,
  ).run(new Date(Date.now() + 60_000).toISOString(), new Date(Date.now() + 60_000).toISOString(), automationId);
  if (result.changes > 0) emitDesktopStoreChange({ entity: "automation", id: automationId });
  return result.changes > 0;
}

/**
 * A held view, or nothing when the old run cannot be reconciled against the graph that runs now.
 *
 * Owner 2026-10-14: the host judges by outcomes, not by settling every earlier tool call ("작업마다 정산하지말고 …
 * 중간에 툴콜 미정산 이런걸 왜보냐"; "새로운 주제 할때마다 터지냐"). An error run whose graph has since changed, with
 * no revised-graph path, used to throw graph_drift out of this listing, so EVERY later run of that automation failed
 * before it started. Measured 2026-10-14 08:06–08:55Z: "X 매일 원글 초안 제안" and four Yotube check automations all
 * failed with automation_graph_reconciliation_graph_drift. The old run stays in the record; the next run starts fresh
 * on the current graph. The owner's explicit reconcile (reconcileAutomationGraph) still reports the drift.
 */
export interface GraphReconciliationReadContext {
  /** Observation only. The owning kernel supplies this after native custody claim. */
  unrelatedToOccurrence: string;
  onUnreadablePriorEvidence?: (source: { runId: string; occurrenceId: string; code: string }) => void;
}
const UNREADABLE_PRIOR_EVIDENCE = new Set([
  "automation_graph_reconciliation_checkpoint_malformed", "automation_graph_reconciliation_node_states_malformed",
  "automation_graph_reconciliation_time_invalid",
  "automation_graph_reconciliation_bound_event_missing", "automation_graph_reconciliation_bound_event_malformed",
  "automation_graph_reconciliation_conflict",
]);
function loadHeldReconciliation(
  automationId: string,
  exact?: { runId: string; occurrenceId: string },
  readContext?: GraphReconciliationReadContext,
): LoadedReconciliation | null {
  try {
    return loadReconciliation(automationId, exact, true);
  } catch (error) {
    if (error instanceof Error && error.message === "automation_graph_reconciliation_graph_drift") return null;
    if (readContext && error instanceof Error && UNREADABLE_PRIOR_EVIDENCE.has(error.message)) {
      // Prove the original source identity from storage, never the failed caller's
      // requested coordinate. Same-source recovery and explicit reducers stay strict.
      const row = exact
        ? getDb().prepare("SELECT id,automation_id,occurrence_id,checkpoint_json FROM automation_runs WHERE automation_id=? AND id=?").get(automationId, exact.runId)
        : getDb().prepare("SELECT id,automation_id,occurrence_id,checkpoint_json FROM automation_runs WHERE automation_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1").get(automationId);
      const source = row as Pick<LatestRunRow, "id" | "automation_id" | "occurrence_id" | "checkpoint_json"> | undefined;
      if (source) {
        let savedOccurrence: unknown;
        try { savedOccurrence = source.checkpoint_json && JSON.parse(source.checkpoint_json)?.occurrenceId; } catch { /* original row remains untouched */ }
        const occurrenceId = source.occurrence_id ?? (typeof savedOccurrence === "string" ? savedOccurrence : legacyOccurrenceId(source));
        if (occurrenceId !== readContext.unrelatedToOccurrence) {
          readContext.onUnreadablePriorEvidence?.({ runId: source.id, occurrenceId, code: error.message });
          return null;
        }
      }
    }
    throw error;
  }
}

export function listAutomationGraphReconciliations(
  automationId: string,
  readContext?: GraphReconciliationReadContext,
): AutomationGraphReconciliation[] {
  if (!validId(automationId)) throw new Error("automation_graph_reconciliation_input_invalid");
  // Form-created automations intentionally begin with a renderer-synthesized graph.
  // With no durable graph there can be no receipt-backed node reconciliation yet.
  // This is an ordinary empty state, not a recovery failure.
  const automation = getAutomation(automationId);
  if (!automation) throw new Error("automation_graph_reconciliation_automation_missing");
  if (!automation.graph) return [];
  // A newer manual/scheduled occurrence must not hide an older parked source
  // occurrence. For each bound event, inspect only its newest run; a later
  // successful resume supersedes older failed snapshots for that occurrence.
  const boundRows = getDb().prepare(
    `SELECT r.id, r.occurrence_id, r.status
     FROM automation_runs r
     WHERE r.automation_id = ? AND r.occurrence_id LIKE 'trigger-event:%'
       AND r.dry_run = 0
     ORDER BY r.started_at DESC, r.rowid DESC`,
  ).all(automationId) as Array<{ id: string; occurrence_id: string | null; status: string | null }>;
  const seenOccurrences = new Set<string>();
  const inspectedRunIds = new Set<string>();
  const views: AutomationGraphReconciliation[] = [];
  for (const row of boundRows) {
    if (!row.occurrence_id || seenOccurrences.has(row.occurrence_id)) continue;
    seenOccurrences.add(row.occurrence_id);
    if (row.status !== "error") continue;
    inspectedRunIds.add(row.id);
    const loaded = loadHeldReconciliation(automationId, { runId: row.id, occurrenceId: row.occurrence_id }, readContext);
    if (loaded) views.push(loaded.view);
  }
  // Manual and scheduled runs also own durable occurrences. A later run of
  // the same automation cannot erase their unknown effects. A successful
  // resume supersedes only the same source occurrence, as it does above for
  // a trigger event. Read identities first; load full checkpoints only for
  // the newest failed run of each occurrence.
  const unboundRows = getDb().prepare(
    `SELECT id, automation_id, occurrence_id, status,
            CASE WHEN json_valid(checkpoint_json)
                 THEN json_extract(checkpoint_json, '$.occurrenceId') END AS checkpoint_occurrence_id
     FROM automation_runs
     WHERE automation_id = ? AND dry_run = 0
       AND (occurrence_id IS NULL OR occurrence_id NOT LIKE 'trigger-event:%')
     ORDER BY started_at DESC, rowid DESC`,
  ).all(automationId) as Array<Pick<LatestRunRow, "id" | "automation_id" | "occurrence_id" | "status"> & {
    checkpoint_occurrence_id: string | null;
  }>;
  for (const row of unboundRows) {
    const occurrenceId = row.occurrence_id ?? row.checkpoint_occurrence_id ?? legacyOccurrenceId(row);
    if (seenOccurrences.has(occurrenceId)) continue;
    seenOccurrences.add(occurrenceId);
    if (row.status !== "error") continue;
    inspectedRunIds.add(row.id);
    const loaded = loadHeldReconciliation(automationId, { runId: row.id, occurrenceId }, readContext);
    if (loaded) views.push(loaded.view);
  }
  const latest = loadHeldReconciliation(automationId, undefined, readContext);
  if (latest && !inspectedRunIds.has(latest.run.id)) views.push(latest.view);
  return views;
}

export function getAutomationGraphReconciliation(automationId: string): AutomationGraphReconciliation | null {
  return listAutomationGraphReconciliations(automationId)[0] ?? null;
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
  const latest = loadHeldReconciliation(automationId);
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
  return db.transaction(() => {
    const automation = getAutomation(automationId);
    if (!automation || !SHA256_RE.test(currentGraphDigest)
      || graphExecutionDigest(automation, resolveAutomationGraph(automation)) !== currentGraphDigest) {
      return { forgot: false, reason: "current_graph_changed" };
    }
    if (hasDurableActiveAutomationExecution(automationId)) return { forgot: false, reason: "active_run" };
    type Source = { id: string; status: string; occurrence_id: string | null; graph_digest: string | null; resume_of_run_id: string | null; dry_run: number; checkpoint_json: string | null };
    const latest = db.prepare(
      "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ).get(automationId) as Source | undefined;
    if (!latest) return { forgot: false, reason: "no_run" };
    if (latest.status !== "error") return { forgot: false, reason: "latest_run_did_not_fail" };
    if (!latest.graph_digest) return { forgot: false, reason: "no_recorded_graph" };
    let source = latest;
    const visited = new Set<string>();
    // Follow only the persisted parent coordinate; never search unrelated history
    // for an older graph or erase it. Every same-graph wrapper must still be held.
    while (source.graph_digest === currentGraphDigest) {
      if (!source.resume_of_run_id) return { forgot: false, reason: "graph_unchanged" };
      if (visited.has(source.id) || visited.size >= 128) return { forgot: false, reason: "source_lineage_invalid" };
      visited.add(source.id);
      const graph = resolveAutomationGraph(automation);
      let checkpoint: GraphCheckpoint | null = null;
      try {
        const saved = JSON.parse(source.checkpoint_json ?? "null");
        checkpoint = parseGraphCheckpoint(saved, currentGraphDigest, source.occurrence_id,
          new Set(graph.nodes.map(node => node.id)), new Set(graph.edges.map(edge => edge.id)),
          new Set(graph.nodes.filter(nodeCouldHaveActedOutside).map(node => node.id)));
      } catch { /* An unbound/corrupt source grants no forgetting authority. */ }
      if (!checkpoint || checkpoint.ambiguousNodeIds.length === 0) return { forgot: false, reason: "source_lineage_unconfirmed" };
      const parent = db.prepare("SELECT * FROM automation_runs WHERE id = ? AND automation_id = ?")
        .get(source.resume_of_run_id, automationId) as Source | undefined;
      if (!parent || parent.status !== "error" || parent.dry_run !== latest.dry_run || !parent.graph_digest) {
        return { forgot: false, reason: "source_lineage_invalid" };
      }
      try {
        const saved = JSON.parse(parent.checkpoint_json ?? "null");
        const { checkpointDigest, ...payload } = saved ?? {};
        if (!saved || saved.graphDigest !== parent.graph_digest || saved.occurrenceId !== parent.occurrence_id
          || checkpointDigest !== sha256Value(payload)) return { forgot: false, reason: "source_lineage_unconfirmed" };
      } catch { return { forgot: false, reason: "source_lineage_unconfirmed" }; }
      source = parent;
    }
    db.prepare(
      `UPDATE automation_runs
          SET status = 'skipped', node_states_json = '{}', checkpoint_json = NULL,
              node_failures_json = NULL, graph_digest = ?, resume_consumed_at = NULL
        WHERE id = ? AND status = 'error'`,
    ).run(currentGraphDigest, latest.id);
    tryRecordRunEvent({ runId: latest.id, automationId, kind: "workflow_stale_checkpoint_forgotten",
      payload: { sourceRunId: source.id, sourceGraphDigest: source.graph_digest, currentGraphDigest, manual: true } });
    return { forgot: true };
  }).immediate();
}

export function reconcileAutomationGraph(
  // Host effect observation settles checkpoint facts without taking scheduling authority.
  input: AutomationGraphReconcileInput & { now?: Date; background?: boolean; retryNow?: boolean },
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
  const background = input.background === true;
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
          ...(background ? { background: true } : {}),
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

    for (const nodeId of unresolved) delete checkpoint.loginWaits[nodeId];
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
    if (loaded.boundEvent && !background) {
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
      !background &&
      (loaded.automation.triggerType ?? "schedule") === "schedule" &&
      loaded.automation.enabled
    ) {
      restoredNextRunAt = computeNextRun(loaded.automation.scheduleHuman, now, {
        scheduleJson: loaded.automation.scheduleSpec
          ? JSON.stringify(loaded.automation.scheduleSpec)
          : null,
        timezone: loaded.automation.timezone ?? null,
      });
      // The held nodes were proven replay-safe (read-only), so the occurrence that was waiting for this
      // reconciliation is simply run again now. Jumping to the next daily slot silently dropped a failed run
      // (production 2026-10-11 15:36 KST: the Threads verification waited a day for its deferred retry).
      if (input.retryNow === true && (restoredNextRunAt === null || Date.parse(restoredNextRunAt) > now.getTime())) {
        restoredNextRunAt = now.toISOString();
      }
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
        ...(background ? { background: true, observedTriggerEventStatus: loaded.boundEvent?.status ?? null } : {}),
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
          Object.keys(loaded.checkpoint.loginWaits).length > 0 ||
          loaded.checkpoint.inFlightNodeIds.length > 0 ||
          loaded.checkpoint.ambiguousNodeIds.length === 0 ||
          loaded.view.nodes.some((node) => node.uncertainty !== "ambiguous")) continue;
      const unresolved = new Set(loaded.checkpoint.ambiguousNodeIds);
      const failureRow = db.prepare(
        "SELECT node_failures_json FROM automation_runs WHERE id = ? AND automation_id = ? AND status = 'error'",
      ).get(loaded.run.id, candidate.id) as { node_failures_json: string | null } | undefined;
      if (!failureRow?.node_failures_json) continue;
      const failures = JSON.parse(failureRow.node_failures_json) as Record<string, { code?: unknown }>;
      if ([...unresolved].some((nodeId) => !["MUTATION_UNVERIFIED", "NODE_TIMEOUT"].includes(String(failures[nodeId]?.code)) ||
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
        retryNow: true,
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


/** Nodes the existing kernel can still reach without replaying a held effect. */
export function graphCheckpointRunnableNodes(graph: WorkflowGraph, checkpoint: GraphCheckpoint): string[] {
  const terminal = new Set([...checkpoint.completedNodeIds, ...checkpoint.skippedNodeIds]);
  const held = new Set([...checkpoint.inFlightNodeIds, ...checkpoint.ambiguousNodeIds]);
  const blockedEdges = new Set(checkpoint.blockedEdgeIds);
  const blocked = new Set(held);
  // A loop may change the frontier after a predicate settles. Do not infer a
  // permanent hold from this deliberately conservative DAG projection.
  if (graph.edges.some((edge) => edge.maxIterations !== undefined)) {
    return graph.nodes.filter((node) => !terminal.has(node.id) && !held.has(node.id)).map((node) => node.id);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const node of graph.nodes) {
      if (terminal.has(node.id) || blocked.has(node.id)) continue;
      if (graph.edges.some((edge) => edge.target === node.id && !blockedEdges.has(edge.id)
          && blocked.has(edge.source)
          && !(held.has(edge.source) && ["error", "timeout", "always"].includes(edge.sourceHandle ?? "")))) {
        blocked.add(node.id); changed = true;
      }
    }
  }
  return graph.nodes.filter((node) => !terminal.has(node.id) && !blocked.has(node.id)).map((node) => node.id);
}

const SCHEDULE_RECOVERY_EVENT = "workflow_schedule_recovery";
/**
 * Host re-arms of a Goal continuation's cursor, written by goal-continuation-hold.ts: the bounded fresh retry after a
 * failed or unfinished pass, and the ledger cadence after a good pass. Neither changes the definition.
 */
const GOAL_CONTINUATION_ARM_EVENTS = ["goal_continuation_advisory_retry", "goal_continuation_cadence_armed"] as const;
const ADVISORY_RECEIPT_LIMIT = 200;

type FailedScheduleRun = LatestRunRow & { checkpoint_json: string; occurrence_id: string };

/** The latest live scheduled occurrence of this automation, whatever its status, or null. */
function latestScheduleRun(automation: Automation): LatestRunRow | null {
  const run = getDb().prepare(`SELECT id, automation_id, started_at, last_activity_at, status, node_states_json,
      occurrence_id, graph_digest, checkpoint_json, dry_run FROM automation_runs
      WHERE automation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(automation.id) as LatestRunRow | undefined;
  return run && run.dry_run !== 1 && run.occurrence_id?.startsWith(`schedule:${automation.id}:`) ? run : null;
}

/** The latest failed live scheduled occurrence of this automation, or null. */
function latestFailedScheduleRun(automation: Automation): FailedScheduleRun | null {
  const run = latestScheduleRun(automation);
  if (!run || run.status !== "error" || !run.checkpoint_json) return null;
  return run as FailedScheduleRun;
}

/**
 * The cursor is the host's own re-arm of a Goal continuation (W1, 2026-10-18). A failed pass is re-armed by
 * scheduleAdvisoryContinuation (goal-continuation-hold.ts) as a fresh episode ("fresh-independent-context", earlier
 * effects unverified); a good pass moves to the ledger's cadence (armContinuationCadence). The cursor recovery read the
 * retry as a held occurrence (and, while the advisory still rewrote the prompt and schedule, as an owner graph revision)
 * and quarantined the continuation for good: production 834c86d9 "Goal continuation · Yotube" 2026-10-11 20:50:45
 * advisory -> 21:06:23 observe_quarantined_effects (graph_definition_reconciliation_pending), next_run_at NULL ever
 * since; fc4396e6, c5ae5890, 444d94f0 the same, 4 of 4.
 * Proof from typed receipts only: the definition the latest run started with (workflow_graph_started.definitionDigest)
 * is the one every re-arm since then recorded and the one stored now, and the latest re-arm wrote this exact cursor.
 * Any other change (an owner edit, a receipt without a definition digest such as the production 10-11 rows) keeps the
 * existing behaviour.
 */
function hostArmedGoalContinuationCursor(automation: Automation, run: LatestRunRow): boolean {
  if (!automation.nextRunAt || !automation.goalId || !run.started_at) return false;
  try {
    const db = getDb();
    const started = db.prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'workflow_graph_started'
      ORDER BY seq ASC LIMIT 1`).get(run.id) as { payload_json: string } | undefined;
    const ran = started ? (JSON.parse(started.payload_json) as Record<string, unknown>).definitionDigest : null;
    if (typeof ran !== "string" || !ran || getAutomationDefinitionDigest(automation.id) !== ran) return false;
    const rows = db.prepare(`SELECT kind, payload_json FROM run_events WHERE automation_id = ? AND kind IN (${
      GOAL_CONTINUATION_ARM_EVENTS.map(() => "?").join(", ")}) AND ts >= ?
      ORDER BY ts ASC, rowid ASC LIMIT ?`).all(automation.id, ...GOAL_CONTINUATION_ARM_EVENTS, run.started_at,
      ADVISORY_RECEIPT_LIMIT) as Array<{ kind: string; payload_json: string }>;
    if (rows.length === 0 || rows.length >= ADVISORY_RECEIPT_LIMIT) return false;
    const receipts = rows.map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
    return receipts.every((receipt) => receipt.definitionDigest === ran)
      && receipts[receipts.length - 1]!.nextAt === automation.nextRunAt;
  } catch {
    return false;
  }
}

function scheduleCheckpoint(automation: Automation, allowRevisedHold = false): { run: LatestRunRow; graph: WorkflowGraph; checkpoint: GraphCheckpoint; revisedGraph?: boolean } | null {
  const run = latestFailedScheduleRun(automation);
  if (!run) return null;
  if (Buffer.byteLength(run.checkpoint_json, "utf8") > MAX_CHECKPOINT_BYTES) return null;
  const graph = strictGraph(executionGraphAutomation(automation));
  const digest = graphExecutionDigest(automation, graph);
  if (run.graph_digest !== digest) {
    // Historical authority can expose its old hold, never execute a new graph.
    const revised = allowRevisedHold ? loadHeldReconciliation(automation.id) : null;
    return revised?.revisedGraph && !Object.keys(revised.checkpoint.loginWaits).length ? revised : null;
  }
  let raw: unknown;
  try { raw = JSON.parse(run.checkpoint_json); } catch { return null; }
  const checkpoint = parseGraphCheckpoint(raw, digest, run.occurrence_id,
    new Set(graph.nodes.map((node) => node.id)), new Set(graph.edges.map((edge) => edge.id)),
    new Set(graph.nodes.filter(nodeCouldHaveActedOutside).map((node) => node.id)));
  if (!checkpoint || Object.keys(checkpoint.loginWaits).length) return null;
  return { run, graph, checkpoint };
}

/**
 * A cursor repair is bound to the saved occurrence even across a missed cron slot. A cursor the host re-armed for a
 * Goal continuation is that next episode's own occurrence. Inside the latest occurrence it would do nothing useful:
 * after a failed pass the uncertain step is held again (run-graph admits a held view of the current occurrence as
 * MUTATION_UNVERIFIED), after a good pass the completed step is not run again. The earlier occurrence keeps its record.
 */
export function recoveredGraphScheduleOccurrence(automation: Automation): string | null {
  const latest = automation.nextRunAt ? latestScheduleRun(automation) : null;
  if (latest && hostArmedGoalContinuationCursor(automation, latest)) return `schedule:${automation.id}:${automation.nextRunAt}`;
  const saved = scheduleCheckpoint(automation);
  if (!saved || !automation.nextRunAt) return null;
  const row = getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND kind = ?
    ORDER BY seq DESC LIMIT 1`).get(saved.run.id, SCHEDULE_RECOVERY_EVENT) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    const receipt = JSON.parse(row.payload_json);
    return receipt.action === "resume_independent_nodes" && receipt.nextRunAt === automation.nextRunAt
      && receipt.checkpointDigest === saved.checkpoint.checkpointDigest
      && receipt.graphDigest === saved.run.graph_digest && receipt.occurrenceId === saved.run.occurrence_id
      ? saved.run.occurrence_id : null;
  } catch { return null; }
}

interface ScheduleCursorHold {
  run: LatestRunRow;
  checkpoint: GraphCheckpoint;
  graphRevised: boolean;
  heldNodeIds: string[];
  replaySafeNodeIds: string[];
  runnableNodeIds: string[];
  observationOnly: boolean;
}

/** The hold the cursor recovery derives from the latest failed scheduled occurrence; null when it has none to apply. */
function scheduleCursorHold(automation: Automation): ScheduleCursorHold | null {
  const db = getDb();
  const saved = scheduleCheckpoint(automation, true);
  if (!saved) return null;
  // The host re-armed this exact cursor for the next Goal continuation episode: the earlier uncertain step is no
  // reason to stop the clock (the failed occurrence keeps its record and reconciliation).
  if (hostArmedGoalContinuationCursor(automation, saved.run)) return null;
  const graphRevised = saved.revisedGraph === true;
  const { run, graph, checkpoint } = saved;
  const heldNodeIds = [...new Set([...checkpoint.inFlightNodeIds, ...checkpoint.ambiguousNodeIds])].sort();
  // Project only replay safety already proved by the same kernel helper.
  // Do not turn missing history into permission to retry a held effect.
  const projection = structuredClone(checkpoint);
  const replaySafeNodeIds = (graphRevised ? [] : reconcileReadOnlyInterruptedAgentNodes(projection, run.id, graph))
    .filter((nodeId) => (checkpoint.toolReceipts[nodeId]?.length ?? 0) > 0
      && Boolean(db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND node_id = ? AND kind = 'mcp_tool-use' LIMIT 1")
        .get(run.id, nodeId)));
  const replaySafe = new Set(replaySafeNodeIds);
  projection.ambiguousNodeIds = checkpoint.ambiguousNodeIds.filter((id) => !replaySafe.has(id));
  projection.inFlightNodeIds = checkpoint.inFlightNodeIds.filter((id) => !replaySafe.has(id));
  const runnableNodeIds = graphRevised ? [] : graphCheckpointRunnableNodes(graph, projection);
  const observationOnly = heldNodeIds.length > 0 && runnableNodeIds.length === 0;
  return { run, checkpoint, graphRevised, heldNodeIds, replaySafeNodeIds, runnableNodeIds, observationOnly };
}

/**
 * Whether this schedule can wake by itself (W1, 2026-10-18): "held" when the cursor recovery quarantines it on its
 * uncertain effects (it clears next_run_at before any dispatch), "unarmed" when it is enabled with no cursor and nothing
 * held, else "ok" (armed, or disabled — enabling computes a cursor). Production: "Goal continuation · Yotube" sat
 * enabled with next_run_at NULL under such a hold and was re-bound to the next /goal Goal, so every turn end of that
 * Goal fell to goal_continuation_unarmed (Yotube 95 + 19 times, 2026-10-12..18).
 */
export function graphScheduleWakeState(automation: Automation): "ok" | "unarmed" | "held" {
  try {
    if (scheduleCursorHold(automation)?.observationOnly) return "held";
  } catch {
    // An unreadable historical occurrence is skipped by the recovery too; it does not hold the cursor.
  }
  return automation.enabled && (automation.triggerType ?? "schedule") === "schedule" && !automation.nextRunAt
    ? "unarmed" : "ok";
}

/**
 * Upgrade old enabled/NULL schedule cursors and stop timer-only quarantine
 * loops. This never reconciles a mutation or changes a checkpoint. The existing
 * effect-observation sweep remains responsible for exact external evidence;
 * its successful reconciliation restores the clock. Other automations and
 * independent nodes keep their own execution authority.
 */
export function recoverGraphScheduleCursors(now = new Date()): Array<{ automationId: string; action: string }> {
  const db = getDb();
  const candidates = db.prepare(`SELECT id FROM automations WHERE enabled = 1
    AND COALESCE(trigger_type, 'schedule') = 'schedule'
    AND (next_run_at IS NULL OR next_run_at <= ?) AND lease_owner IS NULL
    ORDER BY created_at LIMIT 2000`).all(now.toISOString()) as Array<{ id: string }>;
  const changed: Array<{ automationId: string; action: string }> = [];
  for (const candidate of candidates) {
    try {
      db.transaction(() => {
        const automation = getAutomation(candidate.id);
        if (!automation?.enabled || (automation.triggerType ?? "schedule") !== "schedule") return;
        const policy = db.prepare("SELECT end_at, max_runs, run_count FROM automations WHERE id = ?")
          .get(automation.id) as { end_at: string | null; max_runs: number | null; run_count: number } | undefined;
        if (!policy || (policy.end_at && Date.parse(policy.end_at) <= now.getTime())
            || (policy.max_runs != null && policy.run_count >= policy.max_runs)) return;
        const hold = scheduleCursorHold(automation);
        if (!hold) return;
        const { run, checkpoint, graphRevised, heldNodeIds, replaySafeNodeIds, runnableNodeIds, observationOnly } = hold;
        // Empty completed occurrences and ordinary future schedules have no repair
        // authority here. A ready cursor is never advanced or fired twice.
        if (!observationOnly && (automation.nextRunAt !== null || !runnableNodeIds.length)) return;
        const action = observationOnly ? "observe_quarantined_effects" : "resume_independent_nodes";
        const nextRunAt = observationOnly ? null : now.toISOString();
        const sourceEventId = `schedule-recovery:${checkpoint.checkpointDigest}:${action}:${nextRunAt ?? "hold"}`;
        const prior = db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND kind = ?
          AND json_extract(payload_json, '$.checkpointDigest') = ?
          AND json_extract(payload_json, '$.action') = ? LIMIT 1`)
          .get(run.id, SCHEDULE_RECOVERY_EVENT, checkpoint.checkpointDigest, action);
        if (prior && automation.nextRunAt === nextRunAt) return;
        const update = db.prepare(`UPDATE automations SET next_run_at = ?
          WHERE id = ? AND enabled = 1 AND lease_owner IS NULL AND next_run_at IS ?
          AND NOT EXISTS (SELECT 1 FROM automation_runs WHERE automation_id = ? AND status = 'running')`)
          .run(nextRunAt, automation.id, automation.nextRunAt, automation.id);
        if (update.changes !== 1) return;
        recordRunEvent({ runId: run.id, automationId: automation.id, kind: SCHEDULE_RECOVERY_EVENT, sourceEventId,
          payload: { schemaVersion: "agentlas.graph-schedule-recovery.v1", action,
            reasonCode: graphRevised ? "graph_definition_reconciliation_pending"
              : observationOnly ? "graph_effect_observation_pending" : "graph_schedule_cursor_missing",
            graphRevised,
            occurrenceId: run.occurrence_id, graphDigest: run.graph_digest, checkpointDigest: checkpoint.checkpointDigest,
            priorNextRunAt: automation.nextRunAt, nextRunAt, heldNodeIds, runnableNodeIds, replaySafeNodeIds,
            checkpointPreserved: true, executionConsumed: false } });
        changed.push({ automationId: automation.id, action });
      }).immediate();
    } catch (error) {
      // One damaged historical occurrence must not starve other schedules.
      console.warn(`[automation] graph schedule recovery skipped (${candidate.id}):`, error);
    }
  }
  for (const row of changed) emitDesktopStoreChange({ entity: "automation", id: row.automationId });
  return changed;
}
