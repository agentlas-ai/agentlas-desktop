import { randomUUID } from "node:crypto";

import type { WorkflowGraph } from "../../shared/types";
import { graphExecutionDigest, sha256Value } from "../../shared/graph-execution-digest";
import { redactOperationalSecrets } from "../invocation/event-secret-redaction";
import { parseAutomationStrategySchedulePatch, prepareAutomationStrategySchedule,
  type AutomationStrategySchedulePatch } from "../automation-strategy-schedule";
import {
  appendGoalAutomationRevisionBinding,
  getAutomationDefinitionDigest,
  readCurrentGoalAutomationBinding,
  type CurrentGoalAutomationBinding,
} from "../long-run/automation-provenance";
import {
  evaluateGraphPatch,
  graphPatchNeedsApproval,
  type GraphPatch,
} from "../workflow/graph-patch";
import { getDb } from "./db";
import { getAutomation, snapshotGraphVersion } from "./automations";
import { emitDesktopStoreChange } from "./change-bus";
import { getChatGoalContract, getChatGoalRevision } from "./chat-goals";

/**
 * Main-only input for a trusted observation -> proposal caller.
 *
 * This is deliberately not an IPC/preload contract.  A future route must
 * first turn its observation into this typed, bounded value and then call the
 * CAS store below.  Raw model output and `Strategy change:` prose never enter
 * this function.
 */
export interface AutomationStrategyRevisionInput {
  automationId: string;
  sourceRunId: string;
  requestId: string;
  expectedGraphDigest: string;
  expectedDefinitionDigest: string;
  expectedRevision: number;
  /** Main-owned Goal binding CAS. Null is the explicit unbound state. */
  expectedGoalId?: string | null;
  expectedGoalRevision?: number | null;
  expectedGoalBinding?: CurrentGoalAutomationBinding | null;
  strategy: {
    summary: string;
    change: string;
    rationale?: string;
  };
  /** At least one executable prompt or recurring-cadence patch is required. */
  graphPatch?: GraphPatch;
  schedulePatch?: AutomationStrategySchedulePatch;
}

export interface AutomationStrategyV1 {
  schemaVersion: "agentlas.automation-strategy.v1";
  summary: string;
  change: string;
  rationale?: string;
}

export interface AutomationStrategyRevisionReceipt {
  schemaVersion: "agentlas.automation-strategy-revision.v1";
  eventKind: "automation_strategy_revision_applied";
  automationId: string;
  sourceRunId: string;
  requestId: string;
  previousRevision: number;
  revision: number;
  goalId: string | null;
  goalRevision: number | null;
  baseGraphDigest: string;
  graphDigest: string;
  baseDefinitionDigest: string;
  definitionDigest: string;
  strategyDigest: string;
  strategy: AutomationStrategyV1;
  graphPatch: GraphPatch | null;
  schedulePatch?: AutomationStrategySchedulePatch | null;
  nextRunAt?: string | null;
  graphChanged: boolean;
  appliedAt: string;
}

export type AutomationStrategyRevisionConsumptionStatus = "none" | "consumed" | "not_consumed";

export type AutomationStrategyRevisionConsumptionReason =
  | "dry_run"
  | "graph_digest_mismatch"
  | "definition_digest_mismatch"
  | "definition_unavailable"
  | "revision_store_unavailable";

/**
 * Read-only proof that a graph run used the latest durable strategy revision.
 *
 * The run supplies the graph digest it is actually about; the definition token
 * is read again from Main at the same boundary.  A mismatch is reported rather
 * than treated as consumption, so a stale scheduler object cannot claim that a
 * revision was used.  This is intentionally a proof/inspection API only: it
 * does not apply proposals, change cadence, or parse model prose.
 */
export interface AutomationStrategyRevisionConsumption {
  status: AutomationStrategyRevisionConsumptionStatus;
  revision: number | null;
  sourceRunId: string | null;
  runGraphDigest: string | null;
  revisionGraphDigest: string | null;
  runDefinitionDigest: string | null;
  revisionDefinitionDigest: string | null;
  strategyDigest: string | null;
  reason?: AutomationStrategyRevisionConsumptionReason;
}

export type AutomationStrategyRevisionErrorCode =
  | "automation_strategy_revision_input_invalid"
  | "automation_strategy_source_run_missing"
  | "automation_strategy_source_run_mismatch"
  | "automation_strategy_source_run_dry_run"
  | "automation_strategy_source_run_not_terminal"
  | "automation_strategy_source_run_stale"
  | "automation_strategy_goal_binding_stale"
  | "automation_strategy_goal_revision_stale"
  | "automation_strategy_graph_missing"
  | "automation_strategy_graph_stale"
  | "automation_strategy_definition_stale"
  | "automation_strategy_revision_stale"
  | "automation_strategy_idempotency_conflict"
  | "automation_strategy_graph_patch_invalid"
  | "automation_strategy_graph_patch_risky"
  | "automation_strategy_graph_patch_noop"
  | "automation_strategy_schedule_invalid"
  | "automation_strategy_active_run"
  | "automation_strategy_revision_corrupt";

export class AutomationStrategyRevisionError extends Error {
  readonly code: AutomationStrategyRevisionErrorCode;

  constructor(code: AutomationStrategyRevisionErrorCode, message: string = code) {
    super(message);
    this.name = "AutomationStrategyRevisionError";
    this.code = code;
  }
}

const MAX_ID_CHARS = 512;
const MAX_TEXT_CHARS = 2_000;
const MAX_GRAPH_PATCH_OPS = 4;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const DEFINITION_DIGEST_RE = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_ID_CHARS || value.includes("\0")) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", `${field}_invalid`);
  }
  return value.trim();
}

function boundedText(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length > MAX_TEXT_CHARS || value.includes("\0")) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", `${field}_invalid`);
  }
  // This is executable strategy text, not an error fingerprint. In particular
  // do not truncate it to 280 chars or replace URLs, dates and identifiers:
  // that would apply a different instruction than the reviewed proposal.
  const normalized = redactOperationalSecrets(value).trim();
  if (required && !normalized) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", `${field}_empty`);
  }
  return normalized || undefined;
}

function normalizeStrategy(value: unknown): AutomationStrategyV1 {
  if (!isRecord(value)) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "strategy_invalid");
  }
  const unknownKeys = Object.keys(value).filter((key) => !["summary", "change", "rationale"].includes(key));
  if (unknownKeys.length > 0) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "strategy_keys_invalid");
  }
  const summary = boundedText(value.summary, "strategy_summary");
  const change = boundedText(value.change, "strategy_change");
  const rationale = boundedText(value.rationale, "strategy_rationale", false);
  return {
    schemaVersion: "agentlas.automation-strategy.v1",
    summary: summary!,
    change: change!,
    ...(rationale ? { rationale } : {}),
  };
}

function normalizeGraphPatch(value: unknown): GraphPatch {
  if (value === undefined || value === null) {
    throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_invalid", "graph_patch_required");
  }
  if (!isRecord(value)) {
    throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_invalid", "graph_patch_invalid");
  }
  const unknownKeys = Object.keys(value).filter((key) => !["ops", "rationale"].includes(key));
  if (unknownKeys.length > 0 || !Array.isArray(value.ops) || value.ops.length === 0 || value.ops.length > MAX_GRAPH_PATCH_OPS) {
    throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_invalid", "graph_patch_shape_invalid");
  }
  const rationale = boundedText(value.rationale, "graph_patch_rationale", false);
  const nodeIds = new Set<string>();
  const ops: GraphPatch["ops"] = [];
  for (const rawOp of value.ops) {
    if (!isRecord(rawOp) || rawOp.op !== "editNode") {
      // Schedule, trigger, output, tool, edge, and node-creation changes are
      // intentionally not in the unattended strategy allowlist.
      throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_invalid", "graph_patch_operation_not_allowlisted");
    }
    const opKeys = Object.keys(rawOp).filter((key) => !["op", "nodeId", "config"].includes(key));
    const nodeId = identity(rawOp.nodeId, "graph_patch_node_id");
    if (opKeys.length > 0 || nodeIds.has(nodeId) || !isRecord(rawOp.config)) {
      throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_invalid", "graph_patch_operation_shape_invalid");
    }
    nodeIds.add(nodeId);
    const configKeys = Object.keys(rawOp.config);
    if (configKeys.length !== 1 || configKeys[0] !== "prompt") {
      throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_invalid", "graph_patch_config_not_allowlisted");
    }
    const prompt = boundedText(rawOp.config.prompt, "graph_patch_prompt");
    ops.push({ op: "editNode", nodeId, config: { prompt: prompt! } });
  }
  return {
    ops,
    ...(rationale ? { rationale } : {}),
  };
}

function prepareInput(input: AutomationStrategyRevisionInput): {
  automationId: string;
  sourceRunId: string;
  requestId: string;
  expectedGraphDigest: string;
  expectedDefinitionDigest: string;
  expectedRevision: number;
  expectedGoalId: string | null;
  expectedGoalRevision: number | null;
  expectedGoalBinding: CurrentGoalAutomationBinding | null;
  strategy: AutomationStrategyV1;
  graphPatch: GraphPatch | null;
  schedulePatch: AutomationStrategySchedulePatch | null;
  inputDigest: string;
} {
  if (!input || typeof input !== "object") {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "input_invalid");
  }
  const automationId = identity(input.automationId, "automation_id");
  const sourceRunId = identity(input.sourceRunId, "source_run_id");
  const requestId = identity(input.requestId, "request_id");
  if (typeof input.expectedGraphDigest !== "string" || !DIGEST_RE.test(input.expectedGraphDigest)) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "graph_digest_invalid");
  }
  if (typeof input.expectedDefinitionDigest !== "string" || !DEFINITION_DIGEST_RE.test(input.expectedDefinitionDigest)) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "definition_digest_invalid");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "revision_invalid");
  }
  const expectedGoalId = input.expectedGoalId == null ? null : identity(input.expectedGoalId, "goal_id");
  const expectedGoalRevision = input.expectedGoalRevision == null ? null : input.expectedGoalRevision;
  if (expectedGoalId === null && expectedGoalRevision !== null) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "goal_revision_without_goal");
  }
  if (expectedGoalId !== null
    && (typeof expectedGoalRevision !== "number" || !Number.isSafeInteger(expectedGoalRevision) || expectedGoalRevision < 1)) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "goal_revision_invalid");
  }
  const expectedGoalBinding = input.expectedGoalBinding ?? null;
  if (expectedGoalBinding !== null && (expectedGoalBinding.automationId !== automationId
    || !expectedGoalBinding.goalId || !Number.isSafeInteger(expectedGoalBinding.goalRevision)
    || expectedGoalBinding.goalRevision < 1 || !expectedGoalBinding.chatId
    || !expectedGoalBinding.invocationRunId || !expectedGoalBinding.longRunId)) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "goal_binding_invalid");
  }
  if (expectedGoalBinding !== null && expectedGoalId !== null) {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_input_invalid", "goal_binding_owner_conflict");
  }
  const strategy = normalizeStrategy(input.strategy);
  const graphPatch = input.graphPatch === undefined ? null : normalizeGraphPatch(input.graphPatch);
  const schedulePatch = input.schedulePatch === undefined ? null : parseAutomationStrategySchedulePatch(input.schedulePatch);
  if (input.schedulePatch !== undefined && !schedulePatch) {
    throw new AutomationStrategyRevisionError("automation_strategy_schedule_invalid");
  }
  if (!graphPatch && !schedulePatch) {
    throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_invalid", "executable_patch_required");
  }
  const inputDigest = sha256Value({
    schemaVersion: "agentlas.automation-strategy-revision-input.v1",
    automationId,
    sourceRunId,
    requestId,
    expectedGraphDigest: input.expectedGraphDigest,
    expectedDefinitionDigest: input.expectedDefinitionDigest,
    expectedRevision: input.expectedRevision,
    expectedGoalId,
    expectedGoalRevision,
    expectedGoalBinding,
    strategy,
    graphPatch,
    ...(schedulePatch ? { schedulePatch } : {}),
  });
  return {
    automationId,
    sourceRunId,
    requestId,
    expectedGraphDigest: input.expectedGraphDigest,
    expectedDefinitionDigest: input.expectedDefinitionDigest,
    expectedRevision: input.expectedRevision,
    expectedGoalId,
    expectedGoalRevision,
    expectedGoalBinding,
    strategy,
    graphPatch,
    schedulePatch,
    inputDigest,
  };
}

interface SourceGraphRunRow {
  id: string;
  automation_id: string;
  status: string;
  dry_run: number | null;
  graph_digest: string | null;
}

interface AutomationDefinitionRow {
  id: string;
  goal_id: string | null;
  graph_json: string | null;
  schedule: string;
  schedule_json: string | null;
  timezone: string | null;
  next_run_at: string | null;
  end_at: string | null;
  max_runs: number | null;
  run_count: number;
}

interface StoredRevisionRow {
  input_digest: string;
  receipt_json: string;
}

function parseReceipt(raw: string): AutomationStrategyRevisionReceipt {
  try {
    const value = JSON.parse(raw) as AutomationStrategyRevisionReceipt & {
      goalId?: string | null;
      goalRevision?: number | null;
    };
    const receipt = {
      ...value,
      goalId: value.goalId ?? null,
      goalRevision: value.goalRevision ?? null,
    } as AutomationStrategyRevisionReceipt;
    if (receipt?.schemaVersion !== "agentlas.automation-strategy-revision.v1"
      || receipt.eventKind !== "automation_strategy_revision_applied"
      || typeof receipt.automationId !== "string"
      || typeof receipt.sourceRunId !== "string"
      || typeof receipt.requestId !== "string"
      || !Number.isSafeInteger(receipt.revision)
      || !Number.isSafeInteger(receipt.previousRevision)
      || typeof receipt.graphDigest !== "string"
      || typeof receipt.definitionDigest !== "string"
      || !receipt.strategy || receipt.strategy.schemaVersion !== "agentlas.automation-strategy.v1") {
      throw new Error("invalid");
    }
    if ((receipt.goalId !== null && typeof receipt.goalId !== "string")
      || (receipt.goalRevision !== null
        && (!Number.isSafeInteger(receipt.goalRevision) || receipt.goalRevision < 1))) {
      throw new Error("goal_binding_invalid");
    }
    return receipt;
  } catch {
    throw new AutomationStrategyRevisionError("automation_strategy_revision_corrupt");
  }
}

/** Read the latest durable strategy/event without changing execution state. */
export function getLatestAutomationStrategyRevision(automationId: string): AutomationStrategyRevisionReceipt | null {
  const id = identity(automationId, "automation_id");
  const row = getDb().prepare(
    `SELECT receipt_json
     FROM automation_strategy_revision_events
     WHERE automation_id = ? ORDER BY revision DESC LIMIT 1`,
  ).get(id) as { receipt_json?: string } | undefined;
  return row?.receipt_json ? parseReceipt(row.receipt_json) : null;
}

/** Read one immutable revision receipt by its idempotency key for crash recovery. */
export function getAutomationStrategyRevisionByRequestId(requestId: string): AutomationStrategyRevisionReceipt | null {
  const id = identity(requestId, "request_id");
  const row = getDb().prepare(
    "SELECT receipt_json FROM automation_strategy_revision_events WHERE request_id = ?",
  ).get(id) as { receipt_json?: string } | undefined;
  return row?.receipt_json ? parseReceipt(row.receipt_json) : null;
}

/**
 * Inspect the exact graph/definition boundary for one run.  This intentionally
 * fails closed when the revision ledger or definition digest cannot be read;
 * the graph run may continue, but its event must not claim revision use.
 */
export function inspectAutomationStrategyRevisionForRun(input: {
  automationId: string;
  graphDigest: string | null;
  dryRun: boolean;
}): AutomationStrategyRevisionConsumption {
  const base = {
    revision: null,
    sourceRunId: null,
    runGraphDigest: input.graphDigest,
    revisionGraphDigest: null,
    runDefinitionDigest: null,
    revisionDefinitionDigest: null,
    strategyDigest: null,
  } satisfies Omit<AutomationStrategyRevisionConsumption, "status" | "reason">;
  let latest: AutomationStrategyRevisionReceipt | null;
  try {
    latest = getLatestAutomationStrategyRevision(input.automationId);
  } catch {
    return { ...base, status: "not_consumed", reason: "revision_store_unavailable" };
  }
  if (!latest) return { ...base, status: "none" };

  const revisionBase = {
    ...base,
    revision: latest.revision,
    sourceRunId: latest.sourceRunId,
    revisionGraphDigest: latest.graphDigest,
    revisionDefinitionDigest: latest.definitionDigest,
    strategyDigest: latest.strategyDigest,
  };
  if (input.dryRun) return { ...revisionBase, status: "not_consumed", reason: "dry_run" };
  if (!input.graphDigest || latest.graphDigest !== input.graphDigest) {
    return { ...revisionBase, status: "not_consumed", reason: "graph_digest_mismatch" };
  }

  let currentDefinitionDigest: string | null;
  try {
    currentDefinitionDigest = getAutomationDefinitionDigest(input.automationId);
  } catch {
    return { ...revisionBase, status: "not_consumed", reason: "definition_unavailable" };
  }
  if (!currentDefinitionDigest) {
    return { ...revisionBase, status: "not_consumed", reason: "definition_unavailable" };
  }
  const withDefinition = { ...revisionBase, runDefinitionDigest: currentDefinitionDigest };
  if (latest.definitionDigest !== currentDefinitionDigest) {
    return { ...withDefinition, status: "not_consumed", reason: "definition_digest_mismatch" };
  }
  return { ...withDefinition, status: "consumed" };
}

/**
 * Apply one trusted, bounded strategy revision with exact-run and digest CAS.
 * Every write (prior graph snapshot, graph replacement, and revision/event)
 * commits in one immediate SQLite transaction.  A retry with the same request
 * id and identical canonical input returns the original receipt; a different
 * payload with that id is rejected.
 */
export function applyAutomationStrategyRevision(
  input: AutomationStrategyRevisionInput,
  options?: { emitChange?: boolean },
): AutomationStrategyRevisionReceipt {
  const prepared = prepareInput(input);
  const db = getDb();
  const commit = db.transaction(() => {
    const prior = db.prepare(
      "SELECT input_digest, receipt_json FROM automation_strategy_revision_events WHERE request_id = ?",
    ).get(prepared.requestId) as StoredRevisionRow | undefined;
    if (prior) {
      if (prior.input_digest !== prepared.inputDigest) {
        throw new AutomationStrategyRevisionError("automation_strategy_idempotency_conflict");
      }
      return parseReceipt(prior.receipt_json);
    }

    const row = db.prepare(
      `SELECT id, goal_id, graph_json, schedule, schedule_json, timezone,
       next_run_at, end_at, max_runs, run_count FROM automations WHERE id = ?`,
    ).get(prepared.automationId) as AutomationDefinitionRow | undefined;
    if (!row) throw new AutomationStrategyRevisionError("automation_strategy_source_run_missing", "automation_not_found");
    if (row.goal_id !== prepared.expectedGoalId) {
      throw new AutomationStrategyRevisionError("automation_strategy_goal_binding_stale");
    }
    if (row.goal_id !== null) {
      const goalContract = getChatGoalContract(row.goal_id);
      const goalRevision = getChatGoalRevision(row.goal_id);
      if (!goalContract || !goalRevision || goalRevision.revision !== prepared.expectedGoalRevision) {
        throw new AutomationStrategyRevisionError("automation_strategy_goal_revision_stale");
      }
    }
    let goalBinding = prepared.expectedGoalBinding;
    if (goalBinding) {
      const currentBinding = readCurrentGoalAutomationBinding(prepared.automationId);
      if (!currentBinding
        || currentBinding.goalId !== goalBinding.goalId
        || currentBinding.goalRevision !== goalBinding.goalRevision
        || currentBinding.chatId !== goalBinding.chatId
        || currentBinding.invocationRunId !== goalBinding.invocationRunId
        || currentBinding.longRunId !== goalBinding.longRunId
        || currentBinding.definitionDigest !== prepared.expectedDefinitionDigest
        || currentBinding.graphDigest !== prepared.expectedGraphDigest) {
        throw new AutomationStrategyRevisionError("automation_strategy_goal_binding_stale");
      }
      goalBinding = currentBinding;
    }
    const automation = getAutomation(prepared.automationId);
    if (!automation?.graph || !row.graph_json) {
      throw new AutomationStrategyRevisionError("automation_strategy_graph_missing");
    }

    const source = db.prepare(
      `SELECT id, automation_id, status, dry_run, graph_digest
       FROM automation_runs WHERE id = ?`,
    ).get(prepared.sourceRunId) as SourceGraphRunRow | undefined;
    if (!source) throw new AutomationStrategyRevisionError("automation_strategy_source_run_missing");
    if (source.automation_id !== prepared.automationId) {
      throw new AutomationStrategyRevisionError("automation_strategy_source_run_mismatch");
    }
    if (source.dry_run !== 0) {
      throw new AutomationStrategyRevisionError("automation_strategy_source_run_dry_run");
    }
    if (source.status !== "ok" && source.status !== "error") {
      throw new AutomationStrategyRevisionError("automation_strategy_source_run_not_terminal");
    }

    const baseGraphDigest = graphExecutionDigest(automation, automation.graph);
    if (baseGraphDigest !== prepared.expectedGraphDigest) {
      throw new AutomationStrategyRevisionError("automation_strategy_graph_stale");
    }
    if (source.graph_digest !== baseGraphDigest) {
      throw new AutomationStrategyRevisionError("automation_strategy_source_run_stale");
    }
    const baseDefinitionDigest = getAutomationDefinitionDigest(prepared.automationId);
    if (!baseDefinitionDigest || baseDefinitionDigest !== prepared.expectedDefinitionDigest) {
      throw new AutomationStrategyRevisionError("automation_strategy_definition_stale");
    }

    const currentRevision = Number((db.prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM automation_strategy_revision_events WHERE automation_id = ?",
    ).get(prepared.automationId) as { revision?: number } | undefined)?.revision ?? 0);
    if (currentRevision !== prepared.expectedRevision) {
      throw new AutomationStrategyRevisionError("automation_strategy_revision_stale");
    }

    let nextGraph: WorkflowGraph = automation.graph;
    for (const op of prepared.graphPatch?.ops ?? []) {
      const node = automation.graph.nodes.find((candidate) => candidate.id === op.nodeId);
      if (!node || node.type !== "agent") {
        throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_invalid", "graph_patch_target_not_agent");
      }
    }
    if (prepared.graphPatch) {
      const decision = evaluateGraphPatch(automation.graph, prepared.graphPatch);
      if (!decision.ok) {
        throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_invalid", decision.code);
      }
      if (graphPatchNeedsApproval(decision)) {
        throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_risky");
      }
      nextGraph = decision.next;
    }
    let scheduleChange: ReturnType<typeof prepareAutomationStrategySchedule> | null = null;
    if (prepared.schedulePatch) {
      if (db.prepare("SELECT 1 FROM automation_runs WHERE automation_id = ? AND status = 'running' LIMIT 1")
        .get(prepared.automationId)) throw new AutomationStrategyRevisionError("automation_strategy_active_run");
      try {
        scheduleChange = prepareAutomationStrategySchedule(automation, nextGraph, prepared.schedulePatch, new Date());
        nextGraph = scheduleChange.graph;
      } catch (error) {
        throw new AutomationStrategyRevisionError("automation_strategy_schedule_invalid", error instanceof Error ? error.message : undefined);
      }
    }

    const baseGraphJson = JSON.stringify(automation.graph);
    const nextGraphJson = JSON.stringify(nextGraph);
    const graphChanged = baseGraphJson !== nextGraphJson;
    if (!graphChanged) {
      throw new AutomationStrategyRevisionError("automation_strategy_graph_patch_noop");
    }
    const nextGraphDigest = graphExecutionDigest(automation, nextGraph);
    // Do not swallow snapshot errors here: the snapshot, graph CAS, and
    // revision/event must either all commit or all roll back.
    snapshotGraphVersion(prepared.automationId, automation.graph, `Strategy revision ${currentRevision + 1}`);
    const updated = db.prepare(
      `UPDATE automations SET graph_json = ?, schedule = ?, schedule_json = ?, timezone = ?, next_run_at = ?
       WHERE id = ? AND goal_id IS ? AND graph_json = ?`,
    ).run(nextGraphJson, scheduleChange?.schedule ?? row.schedule,
      scheduleChange?.scheduleJson ?? row.schedule_json,
      scheduleChange ? scheduleChange.timezone : row.timezone,
      scheduleChange
        ? ((row.end_at && Date.parse(row.end_at) <= Date.parse(scheduleChange.nextRunAt))
          || (row.max_runs !== null && row.run_count >= row.max_runs) ? null : scheduleChange.nextRunAt)
        : row.next_run_at,
      prepared.automationId, prepared.expectedGoalId, row.graph_json);
    if (updated.changes !== 1) {
      throw new AutomationStrategyRevisionError("automation_strategy_graph_stale");
    }
    const nextDefinitionDigest = getAutomationDefinitionDigest(prepared.automationId) ?? "";
    if (!nextDefinitionDigest) {
      throw new AutomationStrategyRevisionError("automation_strategy_definition_stale");
    }
    if (goalBinding) {
      appendGoalAutomationRevisionBinding({
        binding: goalBinding,
        definitionDigest: nextDefinitionDigest,
        graphDigest: nextGraphDigest,
        sourceEventId: `automation-strategy-revision:${prepared.requestId}`,
      });
    }

    const revision = currentRevision + 1;
    const appliedAt = new Date().toISOString();
    const strategyDigest = sha256Value(prepared.strategy);
    const receipt: AutomationStrategyRevisionReceipt = {
      schemaVersion: "agentlas.automation-strategy-revision.v1",
      eventKind: "automation_strategy_revision_applied",
      automationId: prepared.automationId,
      sourceRunId: prepared.sourceRunId,
      requestId: prepared.requestId,
      previousRevision: currentRevision,
      revision,
      goalId: goalBinding?.goalId ?? prepared.expectedGoalId,
      goalRevision: goalBinding?.goalRevision ?? prepared.expectedGoalRevision,
      baseGraphDigest,
      graphDigest: nextGraphDigest,
      baseDefinitionDigest,
      definitionDigest: nextDefinitionDigest,
      strategyDigest,
      strategy: prepared.strategy,
      graphPatch: prepared.graphPatch,
      ...(prepared.schedulePatch ? {
        schedulePatch: prepared.schedulePatch,
        nextRunAt: getAutomation(prepared.automationId)?.nextRunAt ?? null,
      } : {}),
      graphChanged,
      appliedAt,
    };
    const inserted = db.prepare(
      `INSERT INTO automation_strategy_revision_events
       (id, automation_id, revision, previous_revision, request_id, source_run_id,
        base_graph_digest, graph_digest, base_definition_digest, definition_digest,
        strategy_digest, strategy_json, graph_patch_json, input_digest, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      prepared.automationId,
      revision,
      currentRevision,
      prepared.requestId,
      prepared.sourceRunId,
      baseGraphDigest,
      nextGraphDigest,
      baseDefinitionDigest,
      nextDefinitionDigest,
      strategyDigest,
      JSON.stringify(prepared.strategy),
      JSON.stringify(prepared.graphPatch),
      prepared.inputDigest,
      JSON.stringify(receipt),
      appliedAt,
    );
    if (inserted.changes !== 1) {
      throw new AutomationStrategyRevisionError("automation_strategy_revision_stale");
    }
    return receipt;
  });
  const receipt = commit.immediate() as AutomationStrategyRevisionReceipt;
  // This is a Main-owned store notification only; it does not expose the
  // strategy API to renderer/IPC or wire background model prose into it.
  if ((options?.emitChange ?? true) && receipt.graphChanged) {
    emitDesktopStoreChange({ entity: "automation", id: receipt.automationId });
  }
  return receipt;
}
