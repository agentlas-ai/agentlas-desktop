import { sha256Value } from "../../shared/graph-execution-digest";
import { emitDesktopStoreChange } from "./change-bus";
import { getAutomation } from "./automations";
import { getDb } from "./db";
import { recordRunEvent } from "./run-events";
import type {
  AutomationGraphTerminalCloseCandidate,
  AutomationGraphTerminalCloseInput,
  AutomationGraphTerminalCloseReceipt,
} from "../../shared/types";

export type {
  AutomationGraphTerminalCloseCandidate,
  AutomationGraphTerminalCloseInput,
  AutomationGraphTerminalCloseReceipt,
} from "../../shared/types";

/**
 * This event is the durable permission for a fresh occurrence after an old
 * graph run has been reviewed. It is intentionally separate from the
 * automation-wide attention-cleared marker: a dismissal of one card cannot
 * authorize replay of an unrelated run.
 */
export const GRAPH_TERMINAL_CLOSE_EVENT_KIND = "workflow_terminal_close_committed";
export const GRAPH_TERMINAL_CLOSE_SCHEMA = "agentlas.workflow-terminal-close.v1";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

interface TerminalCloseRunRow {
  id: string;
  automation_id: string | null;
  status: string | null;
  occurrence_id: string | null;
  graph_digest: string | null;
  checkpoint_json: string | null;
  dry_run: number;
}

interface TerminalCloseEventPayload {
  schemaVersion: typeof GRAPH_TERMINAL_CLOSE_SCHEMA;
  automationId: string;
  runId: string;
  occurrenceId: string;
  graphDigest: string;
  checkpointDigest: string;
  expectedUpdatedAt: string;
  closedAt: string;
  decision: "reviewed_external_effects";
  consequence: "fresh_occurrence_may_repeat_completed_effects";
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !validId(entry))) return null;
  const values = value as string[];
  return new Set(values).size === values.length ? values : null;
}

function checkpointPayload(checkpoint: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...checkpoint };
  delete payload.checkpointDigest;
  return payload;
}

function candidateFromRow(
  row: TerminalCloseRunRow | undefined,
  automationId: string,
): AutomationGraphTerminalCloseCandidate | null {
  if (!row || row.automation_id !== automationId || row.status !== "error") return null;
  const checkpoint = parseObject(row.checkpoint_json);
  if (!checkpoint) throw new Error("automation_graph_terminal_close_checkpoint_malformed");
  const occurrenceId = typeof checkpoint.occurrenceId === "string" ? checkpoint.occurrenceId : null;
  const graphDigest = typeof checkpoint.graphDigest === "string" ? checkpoint.graphDigest : null;
  const checkpointDigest = typeof checkpoint.checkpointDigest === "string" ? checkpoint.checkpointDigest : null;
  const updatedAt = typeof checkpoint.updatedAt === "string" ? checkpoint.updatedAt : null;
  if (
    !validId(occurrenceId) || !validSha256(graphDigest) || !validSha256(checkpointDigest) ||
    !updatedAt || !Number.isFinite(Date.parse(updatedAt)) ||
    !validSha256(row.graph_digest) || row.graph_digest !== graphDigest ||
    sha256Value(checkpointPayload(checkpoint)) !== checkpointDigest
  ) {
    throw new Error("automation_graph_terminal_close_checkpoint_malformed");
  }
  if (row.occurrence_id !== null && row.occurrence_id !== occurrenceId) {
    throw new Error("automation_graph_terminal_close_occurrence_conflict");
  }
  const inFlightNodeIds = stringArray(checkpoint.inFlightNodeIds);
  const ambiguousNodeIds = stringArray(checkpoint.ambiguousNodeIds);
  const effectNodeIds = stringArray(checkpoint.effectNodeIds);
  const completedNodeIds = stringArray(checkpoint.completedNodeIds);
  if (!inFlightNodeIds || !ambiguousNodeIds || !effectNodeIds || !completedNodeIds) {
    throw new Error("automation_graph_terminal_close_checkpoint_malformed");
  }
  const effects = new Set(effectNodeIds);
  return {
    automationId,
    runId: row.id,
    occurrenceId,
    graphDigest,
    checkpointDigest,
    updatedAt,
    simulation: row.dry_run === 1,
    unresolvedNodeIds: [...new Set([...inFlightNodeIds, ...ambiguousNodeIds])],
    completedEffectNodeIds: completedNodeIds.filter((nodeId) => effects.has(nodeId)),
  };
}

function loadCandidate(
  automationId: string,
  runId?: string,
): AutomationGraphTerminalCloseCandidate | null {
  if (!validId(automationId)) throw new Error("automation_graph_terminal_close_input_invalid");
  const automation = getAutomation(automationId);
  if (!automation) throw new Error("automation_graph_terminal_close_automation_missing");
  const row = (runId
    ? getDb().prepare(
        `SELECT id, automation_id, status, occurrence_id, graph_digest, checkpoint_json, dry_run
         FROM automation_runs WHERE automation_id = ? AND id = ?`,
      ).get(automationId, runId)
    : getDb().prepare(
        `SELECT id, automation_id, status, occurrence_id, graph_digest, checkpoint_json, dry_run
         FROM automation_runs WHERE automation_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      ).get(automationId)) as TerminalCloseRunRow | undefined;
  return candidateFromRow(row, automationId);
}

export function getAutomationGraphTerminalCloseCandidate(
  automationId: string,
): AutomationGraphTerminalCloseCandidate | null {
  return loadCandidate(automationId);
}

function parseTerminalClosePayload(raw: string | null): TerminalCloseEventPayload | null {
  const payload = parseObject(raw);
  if (!payload
    || payload.schemaVersion !== GRAPH_TERMINAL_CLOSE_SCHEMA
    || payload.decision !== "reviewed_external_effects"
    || payload.consequence !== "fresh_occurrence_may_repeat_completed_effects"
    || !validId(payload.automationId) || !validId(payload.runId) || !validId(payload.occurrenceId)
    || !validSha256(payload.graphDigest) || !validSha256(payload.checkpointDigest)
    || typeof payload.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(payload.expectedUpdatedAt))
    || typeof payload.closedAt !== "string" || !Number.isFinite(Date.parse(payload.closedAt))) {
    return null;
  }
  return payload as unknown as TerminalCloseEventPayload;
}

function existingTerminalClose(
  runId: string,
  expected: Pick<AutomationGraphTerminalCloseInput, "automationId" | "runId" | "occurrenceId" | "graphDigest" | "checkpointDigest" | "expectedUpdatedAt">,
): AutomationGraphTerminalCloseReceipt | null {
  const rows = getDb().prepare(
    `SELECT payload_json FROM run_events
     WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 32`,
  ).all(runId, GRAPH_TERMINAL_CLOSE_EVENT_KIND) as Array<{ payload_json: string | null }>;
  for (const row of rows) {
    const payload = parseTerminalClosePayload(row.payload_json);
    if (!payload) throw new Error("automation_graph_terminal_close_event_malformed");
    if (payload.automationId !== expected.automationId) continue;
    if (
      payload.runId !== expected.runId || payload.occurrenceId !== expected.occurrenceId ||
      payload.graphDigest !== expected.graphDigest || payload.checkpointDigest !== expected.checkpointDigest ||
      payload.expectedUpdatedAt !== expected.expectedUpdatedAt
    ) {
      throw new Error("automation_graph_terminal_close_conflict");
    }
    return {
      automationId: payload.automationId,
      runId: payload.runId,
      occurrenceId: payload.occurrenceId,
      graphDigest: payload.graphDigest,
      checkpointDigest: payload.checkpointDigest,
      closedAt: payload.closedAt,
      status: "already-closed",
      consequence: payload.consequence,
    };
  }
  return null;
}

export function hasAutomationGraphTerminalClose(input: Pick<AutomationGraphTerminalCloseInput, "automationId" | "runId" | "occurrenceId" | "graphDigest" | "checkpointDigest">): boolean {
  const rows = getDb().prepare(
    `SELECT payload_json FROM run_events
     WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 32`,
  ).all(input.runId, GRAPH_TERMINAL_CLOSE_EVENT_KIND) as Array<{ payload_json: string | null }>;
  return rows.some((row) => {
    const payload = parseTerminalClosePayload(row.payload_json);
    return Boolean(payload
      && payload.automationId === input.automationId
      && payload.runId === input.runId
      && payload.occurrenceId === input.occurrenceId
      && payload.graphDigest === input.graphDigest
      && payload.checkpointDigest === input.checkpointDigest);
  });
}

export function terminalCloseAutomationGraph(
  input: AutomationGraphTerminalCloseInput,
): AutomationGraphTerminalCloseReceipt {
  if (
    !validId(input?.automationId) || !validId(input?.runId) || !validId(input?.occurrenceId) ||
    !validSha256(input?.graphDigest) || !validSha256(input?.checkpointDigest) ||
    typeof input?.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(input.expectedUpdatedAt)) ||
    input?.decision !== "reviewed_external_effects"
  ) {
    throw new Error("automation_graph_terminal_close_input_invalid");
  }
  const db = getDb();
  const commit = db.transaction(() => {
    const candidate = loadCandidate(input.automationId, input.runId);
    if (!candidate) throw new Error("automation_graph_terminal_close_run_missing");
    if (candidate.simulation) throw new Error("automation_graph_terminal_close_simulation_invalid");
    if (
      candidate.occurrenceId !== input.occurrenceId || candidate.graphDigest !== input.graphDigest ||
      candidate.checkpointDigest !== input.checkpointDigest || candidate.updatedAt !== input.expectedUpdatedAt
    ) {
      throw new Error("automation_graph_terminal_close_conflict");
    }
    const existing = existingTerminalClose(input.runId, input);
    if (existing) return existing;
    if (candidate.unresolvedNodeIds.length > 0) {
      throw new Error(`automation_graph_terminal_close_unresolved_effects:${candidate.unresolvedNodeIds.join(",")}`);
    }
    const closedAt = new Date().toISOString();
    recordRunEvent({
      runId: input.runId,
      kind: GRAPH_TERMINAL_CLOSE_EVENT_KIND,
      automationId: input.automationId,
      payload: {
        schemaVersion: GRAPH_TERMINAL_CLOSE_SCHEMA,
        automationId: input.automationId,
        runId: input.runId,
        occurrenceId: input.occurrenceId,
        graphDigest: input.graphDigest,
        checkpointDigest: input.checkpointDigest,
        expectedUpdatedAt: input.expectedUpdatedAt,
        closedAt,
        decision: "reviewed_external_effects",
        consequence: "fresh_occurrence_may_repeat_completed_effects",
      },
    });
    return {
      automationId: input.automationId,
      runId: input.runId,
      occurrenceId: input.occurrenceId,
      graphDigest: input.graphDigest,
      checkpointDigest: input.checkpointDigest,
      closedAt,
      status: "closed",
      consequence: "fresh_occurrence_may_repeat_completed_effects",
    } satisfies AutomationGraphTerminalCloseReceipt;
  });
  const receipt = commit.immediate() as AutomationGraphTerminalCloseReceipt;
  emitDesktopStoreChange({ entity: "automation", id: input.automationId });
  return receipt;
}
