import { createHash } from "node:crypto";
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
import { getAutomation } from "./automations";
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
  checkpointJson: string;
  nodeStates: Record<string, WorkflowNodeRunState>;
  boundEvent: BoundEventRow | null;
  view: AutomationGraphReconciliation;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

function sha256Value(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex")}`;
}

function graphExecutionDigest(automation: Automation, graph: WorkflowGraph): string {
  return sha256Value({
    graph,
    targetType: automation.targetType,
    targetId: automation.targetId,
    targetVersion: automation.targetVersion ?? null,
    promptTemplate: automation.promptTemplate,
    executionPermission: automation.executionPermission ?? "write",
    toolMode: automation.toolMode ?? "auto",
    hubMode: automation.hubMode ?? "hub-allowed",
    runtimeSelection: automation.runtimeSelection ?? null,
  });
}

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
         WHERE automation_id = ? AND id = ? AND occurrence_id = ?`,
      ).get(automationId, exact.runId, exact.occurrenceId) as LatestRunRow | undefined
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
  if (!run.occurrence_id || !run.checkpoint_json) {
    throw new Error("automation_graph_reconciliation_checkpoint_malformed");
  }
  let rawCheckpoint: unknown;
  try {
    rawCheckpoint = JSON.parse(run.checkpoint_json);
  } catch {
    throw new Error("automation_graph_reconciliation_checkpoint_malformed");
  }
  if (
    !rawCheckpoint || typeof rawCheckpoint !== "object" || Array.isArray(rawCheckpoint) ||
    (rawCheckpoint as { schemaVersion?: unknown }).schemaVersion !== GRAPH_CHECKPOINT_SCHEMA
  ) {
    throw new Error("automation_graph_reconciliation_checkpoint_not_v3");
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const effectNodeIds = new Set(
    graph.nodes
      .filter((node) => node.type === "agent" || node.type === "action" || node.type === "output")
      .map((node) => node.id),
  );
  const checkpoint = parseGraphCheckpoint(
    rawCheckpoint,
    currentGraphDigest,
    run.occurrence_id,
    nodeIds,
    edgeIds,
    effectNodeIds,
  );
  if (!checkpoint) throw new Error("automation_graph_reconciliation_checkpoint_malformed");
  const nodeStates = parseNodeStates(run.node_states_json, nodeIds);
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

export function getAutomationGraphReconciliation(
  automationId: string,
): AutomationGraphReconciliation | null {
  if (!validId(automationId)) throw new Error("automation_graph_reconciliation_input_invalid");
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
       SET checkpoint_json = ?, node_states_json = ?, last_activity_at = ?
       WHERE id = ? AND automation_id = ? AND status = 'error'
         AND graph_digest = ? AND checkpoint_json = ?`,
    ).run(
      checkpointJson,
      JSON.stringify(loaded.nodeStates),
      updatedAt,
      loaded.run.id,
      loaded.automation.id,
      loaded.view.graphDigest,
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
