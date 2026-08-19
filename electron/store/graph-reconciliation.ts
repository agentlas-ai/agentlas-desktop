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
  parseGraphCheckpoint,
  type GraphCheckpoint,
} from "../workflow/run-graph";
import { emitDesktopStoreChange } from "./change-bus";
import { computeNextRun, getAutomation } from "./automations";
import { getDb } from "./db";
import { recordRunEvent } from "./run-events";

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
    .filter((node) => node.type === "agent" || node.type === "action" || node.type === "output")
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

function loadReconciliation(
  automationId: string,
  exact?: { runId: string; occurrenceId: string },
): LoadedReconciliation | null {
  if (!validId(automationId)) throw new Error("automation_graph_reconciliation_input_invalid");
  const automation = getAutomation(automationId);
  if (!automation) throw new Error("automation_graph_reconciliation_automation_missing");
  const graph = strictGraph(automation);
  const run = exact
    ? getDb().prepare(
        `SELECT id, automation_id, started_at, last_activity_at, status, node_states_json,
                occurrence_id, graph_digest, checkpoint_json
         FROM automation_runs
         WHERE automation_id = ? AND id = ?`,
      ).get(automationId, exact.runId) as LatestRunRow | undefined
    : getDb().prepare(
        `SELECT id, automation_id, started_at, last_activity_at, status, node_states_json,
                occurrence_id, graph_digest, checkpoint_json
         FROM automation_runs
         WHERE automation_id = ?
         ORDER BY started_at DESC, rowid DESC
         LIMIT 1`,
      ).get(automationId) as LatestRunRow | undefined;
  if (!run || run.status !== "error") return null;

  const currentGraphDigest = graphExecutionDigest(automation, graph);
  if (!run.graph_digest || run.graph_digest !== currentGraphDigest) {
    throw new Error("automation_graph_reconciliation_graph_drift");
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const effectNodeIds = new Set(
    graph.nodes
      .filter((node) => node.type === "agent" || node.type === "action" || node.type === "output")
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
        SET node_states_json = '{}', checkpoint_json = NULL, graph_digest = ?, resume_consumed_at = NULL
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
      },
    });

    result = {
      automationId: loaded.automation.id,
      runId: loaded.run.id,
      checkpointDigest: checkpoint.checkpointDigest,
      updatedAt: checkpoint.updatedAt,
      eventStatus,
      resumeRequired: !allNodesTerminal,
      completedNodeIds: completedByUser,
      retryNodeIds: retryByUser,
    };
  });
  commit.immediate();
  if (!result) throw new Error("automation_graph_reconciliation_missing_result");
  emitDesktopStoreChange({ entity: "automation", id: input.automationId });
  return result;
}
