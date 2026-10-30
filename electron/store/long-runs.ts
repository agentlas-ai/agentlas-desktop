import { managedOneConfigured } from "../managed-one/auth";
import { ownsHostGoalLoop } from "../long-run/host-goal-surface";
import { normalizeLongRunUsage, readLongRunCostAccounting, type LongRunUsageInput, type LongRunCostAccounting } from "../long-run/budget";
import { decodeRuntimeEvidence, runtimeEvidencePhase, type RuntimeCorrelation, type RuntimeEvidencePhase } from "../../shared/runtime-evidence";
import { createHash, randomUUID } from "node:crypto";
import { mcpEffectArgumentsDigest, mcpEffectOutputDigest } from "../mcp-tools/effect-receipts";
import {
  LONG_RUN_ACTIVE_STATUSES,
  LONG_RUN_OPEN_TASK_STATES,
  LONG_RUN_TERMINAL_STATUSES,
  assertLongRunTransition,
  isLongRunPauseReason,
  resolveNonBlockingGoalStatus,
  isLongRunStatus,
  normalizeLongRunCriteria,
  type ContinuityCapsule,
  type LongRunAttemptState,
  type LongRunBudget,
  type LongRunExecutionLocation,
  type LongRunHostOwnerKind,
  type LongRunMessageKind,
  type LongRunPauseReason,
  type LongRunRuntimeSelection,
  type LongRunStatus,
  type LongRunSurface,
  type LongRunTaskState,
  type LongRunVerificationVerdict,
  type LongRunWorkerBinding,
  type LongRunWorkerRole,
  type LongRunWorkerState,
  type LongRunWorkspaceBinding,
} from "../../shared/long-run";
import { GOAL_OWNER_ANSWER_REQUIRED, GOAL_OWNER_HOLD_BLOCKED_REASONS, goalHeldForOwnerAnswer, goalHeldForOwnerGrant } from "../../shared/goal-display-state";
import { desktopStoreTransaction, emitDesktopStoreChange } from "./change-bus";
import { getDb } from "./db";
import { invocationProcessOwner } from "./invocation-run-owners";
import { getChatGoalContract, getChatGoalRevision } from "./chat-goals";
import { agentRunCwd } from "../runtime/exec";
import { scienceLongRunId, type ScienceLoopLongRunProjection as CanonicalScienceLoopLongRunProjection } from "agentlas-science/dist/contracts/science-long-run";

// Additive extension contract: the bundled SDK pin can precede the installed Science extension.
// Keep the validator identical to the canonical SDK contract; no dependency repin is required.
const SCIENCE_LONG_RUN_PROJECTION_SCHEMA = "agentlas.science-long-run-projection.v2" as const;
export type ScienceLoopLongRunProjection = CanonicalScienceLoopLongRunProjection & {
  authorCompletion?: ScienceAuthorCompletionProjection;
};

export interface ScienceAuthorCompletionProjection {
  eventId: string;
  eventSequence: number;
  sourceVersion: number;
  sourceStateSha256: string;
  scientificVerification: "unchecked";
  record: {
    schema: "agentlas.science.author-completion-record.v2";
    authorDeclaredCompletion: true;
    loopSessionId: string;
    contractId: string;
    contractVersion: number;
    contractContentSha256: string;
    receipts: readonly { criterionIndex: number; receiptId: string; receiptSha256: string; provenanceSha256: string }[];
    advisories: readonly { code: string; observed: string; nextAction: string }[];
    manuscriptWritingChecklist: Record<string, unknown> | null;
  };
}

/** Verify the exact canonical declaration, including its limitations, before mirroring it. */
export function scienceAuthorCompletionProjectionValid(input: ScienceLoopLongRunProjection): boolean {
  try {
  const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object"
    && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"));
  const hash = /^[a-f0-9]{64}$/;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const declaration = input.authorCompletion;
  if (input.schema !== SCIENCE_LONG_RUN_PROJECTION_SCHEMA || input.status !== "completed"
    || !exact(declaration, ["eventId", "eventSequence", "sourceVersion", "sourceStateSha256", "scientificVerification", "record"])
    || !uuid.test(declaration.eventId) || !Number.isSafeInteger(declaration.eventSequence) || declaration.eventSequence < 1
    || declaration.eventSequence > input.eventCursor || declaration.sourceVersion !== input.sourceVersion
    || !Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 1 || !Number.isSafeInteger(input.eventCursor)
    || declaration.sourceStateSha256 !== input.sourceStateSha256 || !hash.test(input.sourceStateSha256)
    || declaration.scientificVerification !== "unchecked") return false;
  const record = declaration.record;
  if (!exact(record, ["schema", "authorDeclaredCompletion", "loopSessionId", "contractId", "contractVersion", "contractContentSha256",
    "receipts", "advisories", "manuscriptWritingChecklist"])
    || record.schema !== "agentlas.science.author-completion-record.v2" || record.authorDeclaredCompletion !== true
    || !uuid.test(record.loopSessionId) || !uuid.test(record.contractId)
    || record.loopSessionId !== input.loopSessionId || record.contractId !== input.contractId
    || record.contractVersion !== input.contractVersion || !Number.isSafeInteger(record.contractVersion) || record.contractVersion < 1
    || record.contractContentSha256 !== input.contractContentSha256 || !hash.test(record.contractContentSha256)
    || !Array.isArray(record.receipts) || !Array.isArray(record.advisories)
    || record.manuscriptWritingChecklist !== null && (typeof record.manuscriptWritingChecklist !== "object" || Array.isArray(record.manuscriptWritingChecklist))) return false;
  let previousIndex = -1;
  for (const receipt of record.receipts) {
    if (!exact(receipt, ["criterionIndex", "receiptId", "receiptSha256", "provenanceSha256"])
      || typeof receipt.criterionIndex !== "number" || !Number.isSafeInteger(receipt.criterionIndex) || receipt.criterionIndex <= previousIndex
      || receipt.criterionIndex >= input.successCriteria.length || typeof receipt.receiptId !== "string" || !uuid.test(receipt.receiptId)
      || typeof receipt.receiptSha256 !== "string" || !hash.test(receipt.receiptSha256)
      || typeof receipt.provenanceSha256 !== "string" || !hash.test(receipt.provenanceSha256)) return false;
    previousIndex = receipt.criterionIndex;
  }
  if (record.advisories.some(item => !item || typeof item !== "object" || typeof item.code !== "string"
    || typeof item.observed !== "string" || typeof item.nextAction !== "string")) return false;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return typeof input.completionReceiptSetSha256 === "string" && hash.test(input.completionReceiptSetSha256)
    && createHash("sha256").update(JSON.stringify(canonical(record)), "utf8").digest("hex") === input.completionReceiptSetSha256;
  } catch { return false; }
}

export interface LongRunRecord {
  id: string;
  goalId: string;
  idempotencyKey: string;
  surface: LongRunSurface;
  executionLocation: LongRunExecutionLocation;
  hostOwnerKind: LongRunHostOwnerKind;
  rootChatId: string | null;
  projectId: string | null;
  scienceJobId: string | null;
  objective: string;
  acceptanceCriteria: string[];
  status: LongRunStatus;
  pauseReason: LongRunPauseReason | null;
  runtimeFallbackPolicy: "locked" | "preapproved_safe";
  budget: LongRunBudget;
  cycleCount: number;
  costUsedUsd: number;
  costAccounting: LongRunCostAccounting;
  lastProgressKey: string | null;
  stallStreak: number;
  stallWindow: number;
  blockedReason: string | null;
  appInstanceId: string | null;
  lastEventSeq: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
}

export interface LongRunDomainBindingRecord {
  longRunId: string;
  domain: "science";
  objectType: "loop_session";
  objectId: string;
  externalProjectId: string;
  contractId: string | null;
  contractVersion: number | null;
  contractContentSha256: string | null;
  objectVersion: number;
  stateSha256: string;
  eventCursor: number;
  projectionStatus: "current" | "stale" | "error";
  lastError: string | null;
  syncedAt: string;
}

export interface LongRunTaskRecord {
  runId: string;
  id: string;
  parentTaskId: string | null;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencyIds: string[];
  criterionIndices: number[];
  state: LongRunTaskState;
  assignedWorkerId: string | null;
  attemptCount: number;
  attemptLimit: number | null;
  evidenceRef: string | null;
  blockedReason: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface LongRunContinueDecision {
  runId: string;
  goalId: string;
  continue: boolean;
  reason: string;
  status: LongRunStatus;
  openTaskCount: number;
  cycleCount: number;
  objective: string;
  blockedReason: string | null;
  budget: LongRunBudget & { costUsedUsd: number };
}

type LongRunRow = {
  id: string;
  goal_id: string;
  idempotency_key: string;
  surface: LongRunSurface;
  execution_location: LongRunExecutionLocation;
  host_owner_kind: LongRunHostOwnerKind;
  root_chat_id: string | null;
  project_id: string | null;
  science_job_id: string | null;
  objective: string;
  acceptance_criteria_json: string;
  status: string;
  pause_reason: LongRunPauseReason | null;
  runtime_fallback_policy: "locked" | "preapproved_safe";
  max_cycles: number | null;
  max_cost_usd: number | null;
  wallclock_deadline: string | null;
  max_workers: number | null;
  cycle_count: number;
  cost_used_usd: number;
  last_progress_key: string | null;
  stall_streak: number;
  stall_window: number;
  blocked_reason: string | null;
  app_instance_id: string | null;
  last_event_seq: number;
  version: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
};

type LongRunTaskRow = {
  run_id: string;
  id: string;
  parent_task_id: string | null;
  title: string;
  objective: string;
  acceptance_criteria_json: string;
  dependency_ids_json: string;
  criterion_indices_json: string;
  state: LongRunTaskState;
  assigned_worker_id: string | null;
  attempt_count: number;
  attempt_limit: number | null;
  evidence_ref: string | null;
  blocked_reason: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function jsonArray<T>(raw: string, guard: (value: unknown) => value is T): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

function stringArray(raw: string): string[] {
  return jsonArray(raw, (value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
}

function integerArray(raw: string): number[] {
  return Array.from(new Set(jsonArray(raw, (value): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0,
  ))).sort((left, right) => left - right);
}

function rowToLongRun(row: LongRunRow | undefined): LongRunRecord | null {
  if (!row || !isLongRunStatus(row.status)) return null;
  return {
    id: row.id,
    goalId: row.goal_id,
    idempotencyKey: row.idempotency_key,
    surface: row.surface,
    executionLocation: row.execution_location,
    rootChatId: row.root_chat_id,
    projectId: row.project_id,
    scienceJobId: row.science_job_id,
    objective: row.objective,
    acceptanceCriteria: normalizeLongRunCriteria(stringArray(row.acceptance_criteria_json)),
    status: row.status,
    pauseReason: row.pause_reason,
    runtimeFallbackPolicy: row.runtime_fallback_policy,
    budget: {
      maxCycles: row.max_cycles,
      maxCostUsd: row.max_cost_usd,
      wallclockDeadline: row.wallclock_deadline,
      maxWorkers: row.max_workers,
    },
    cycleCount: row.cycle_count,
    costUsedUsd: row.cost_used_usd,
    costAccounting: readLongRunCostAccounting(row.id, row.cycle_count),
    lastProgressKey: row.last_progress_key,
    stallStreak: row.stall_streak,
    stallWindow: row.stall_window,
    blockedReason: row.blocked_reason,
    appInstanceId: row.app_instance_id,
    hostOwnerKind: row.host_owner_kind,
    lastEventSeq: row.last_event_seq,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    completedAt: row.completed_at,
  };
}

function rowToLongRunTask(row: LongRunTaskRow): LongRunTaskRecord {
  return {
    runId: row.run_id,
    id: row.id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    objective: row.objective,
    acceptanceCriteria: normalizeLongRunCriteria(stringArray(row.acceptance_criteria_json)),
    dependencyIds: stringArray(row.dependency_ids_json),
    criterionIndices: integerArray(row.criterion_indices_json),
    state: row.state,
    assignedWorkerId: row.assigned_worker_id,
    attemptCount: row.attempt_count,
    attemptLimit: row.attempt_limit,
    evidenceRef: row.evidence_ref,
    blockedReason: row.blocked_reason,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function requiredText(value: string, code: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, max);
  if (!normalized) throw new TypeError(code);
  return normalized;
}

function requiredContent(value: string, code: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new TypeError(code);
  return normalized;
}

/** Bind evidence to the contract at the durable attempt-start cursor. A later
 * steering revision cannot relabel output from an older worker. Legacy starts
 * without a prior binding stay unknown. */
export function getLongRunAttemptGoalRevision(runId: string, attemptId: string): number | null {
  const start = getDb().prepare("SELECT seq FROM long_run_events WHERE run_id = ? AND kind = 'worker.attempt_started' AND json_extract(payload_json, '$.attemptId') = ? ORDER BY seq ASC LIMIT 1")
    .get(runId, attemptId) as { seq: number } | undefined;
  if (!start) return null;
  const binding = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.goal_revision_bound' AND seq <= ? ORDER BY seq DESC LIMIT 1")
    .get(runId, start.seq) as { payload_json: string } | undefined;
  const revision = binding ? JSON.parse(binding.payload_json).revision : null;
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function appendEventInDb(input: {
  runId: string;
  kind: string;
  actorKind: "host" | "user" | "worker" | "runtime" | "tool" | "system";
  actorId?: string | null;
  payload?: unknown;
  at: string;
  sourceEventId?: string;
  correlation?: RuntimeCorrelation;
  evidencePhase?: RuntimeEvidencePhase;
}, mutation: "domain" | "inference_accounting" = "domain"): number {
  const db = getDb();
  const row = db.prepare("SELECT last_event_seq FROM long_runs WHERE id = ?")
    .get(input.runId) as { last_event_seq: number } | undefined;
  if (!row) throw new Error(`long_run_not_found:${input.runId}`);
  if (input.sourceEventId) {
    const prior = db.prepare("SELECT seq, kind FROM long_run_events WHERE run_id = ? AND json_extract(payload_json, '$.runtimeEvidence.sourceEventId') = ? LIMIT 1")
      .get(input.runId, input.sourceEventId) as { seq: number; kind: string } | undefined;
    if (prior) {
      if (prior.kind !== input.kind) throw new Error("runtime_source_event_conflict");
      return prior.seq;
    }
  }
  const seq = row.last_event_seq + 1;
  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown> : { value: input.payload ?? null };
  const identity = db.prepare("SELECT goal_id FROM long_runs WHERE id = ?").get(input.runId) as { goal_id: string };
  const binding = input.kind === "run.goal_revision_bound" ? payload.revision
    : typeof payload.attemptId === "string" && input.kind !== "worker.attempt_started"
      ? getLongRunAttemptGoalRevision(input.runId, payload.attemptId)
      : getLongRunGoalRevisionBinding(input.runId)?.revision;
  const payloadCorrelation: RuntimeCorrelation = {};
  for (const key of ["taskId", "workerId", "attemptId", "invocationRunId", "actionId", "environmentId", "artifactVersionRef"] as const) {
    if (typeof payload[key] === "string" && payload[key]) payloadCorrelation[key] = payload[key] as string;
  }
  if (Number.isSafeInteger(binding) && Number(binding) > 0) payloadCorrelation.goalRevision = Number(binding);
  const runtimeEvidence = decodeRuntimeEvidence({ schemaVersion: "agentlas.runtime-evidence.v1",
    sourceEventId: input.sourceEventId ?? `long-run:${input.runId}:event:${seq}`,
    phase: input.evidencePhase ?? runtimeEvidencePhase(input.kind, payload),
    correlation: { ...payloadCorrelation, ...input.correlation, longRunId: input.runId, goalId: identity.goal_id,
      ...(input.actorKind === "worker" && input.actorId ? { workerId: input.actorId } : {}) } });
  if (!runtimeEvidence) throw new Error("runtime_evidence_invalid");
  db.prepare(
    `INSERT INTO long_run_events
      (run_id, seq, kind, actor_kind, actor_id, payload_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    seq,
    requiredText(input.kind, "long_run_event_kind_required", 120),
    input.actorKind,
    input.actorId?.trim() || null,
    JSON.stringify({ ...payload, runtimeEvidence }),
    input.at,
  );
  db.prepare(
    "UPDATE long_runs SET last_event_seq = ?, updated_at = ?, version = version + ? WHERE id = ?",
  ).run(seq, input.at, mutation === "domain" ? 1 : 0, input.runId);
  return seq;
}

/** Live work only. Parallel verification does not own the controller. */
export function liveLongRunAttemptCount(runId: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id = a.worker_id WHERE a.run_id = ? AND a.state = 'running'
    AND w.role != 'verifier'`).get(runId) as { n: number };
  return row.n;
}

export function appendLongRunEvent(input: Omit<Parameters<typeof appendEventInDb>[0], "at"> & { at?: string }): number {
  const db = getDb();
  const run = db.transaction(() => appendEventInDb({ ...input, at: input.at ?? new Date().toISOString() }));
  // IMMEDIATE: the append reads the run's last seq then writes; a deferred read-then-write is refused at once (SQLITE_BUSY) when the
  // daemon wrote in between, without waiting the busy timeout.
  const seq = run.immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  return seq;
}

export function createLongRun(input: {
  id?: string;
  goalId: string;
  idempotencyKey?: string;
  surface: LongRunSurface;
  executionLocation?: LongRunExecutionLocation;
  hostOwnerKind?: LongRunHostOwnerKind;
  rootChatId?: string | null;
  projectId?: string | null;
  scienceJobId?: string | null;
  objective: string;
  acceptanceCriteria: readonly string[];
  status?: Extract<LongRunStatus, "draft" | "queued" | "running">;
  runtimeFallbackPolicy?: "locked" | "preapproved_safe";
  budget?: Partial<LongRunBudget>;
  stallWindow?: number;
  appInstanceId?: string | null;
}): LongRunRecord {
  if (managedOneConfigured()) throw new Error("managed_one_goal_unavailable");
  const goalId = requiredText(input.goalId, "long_run_goal_id_required", 240);
  const objective = requiredContent(input.objective, "long_run_objective_required");
  const criteria = normalizeLongRunCriteria(input.acceptanceCriteria);
  if (criteria.length === 0) throw new TypeError("long_run_acceptance_criteria_required");
  const idempotencyKey = requiredText(input.idempotencyKey ?? `goal:${goalId}`, "long_run_idempotency_required", 300);
  const executionLocation = input.executionLocation ?? "desktop-local";
  const hostOwnerKind = input.hostOwnerKind ?? (executionLocation === "web-hosted" ? "hosted" : "desktop");
  if (!["desktop", "daemon", "hosted"].includes(hostOwnerKind)
    || (hostOwnerKind === "hosted") !== (executionLocation === "web-hosted")) {
    throw new TypeError("long_run_host_owner_kind_invalid");
  }
  if (hostOwnerKind === "daemon" && !input.appInstanceId?.trim()) {
    throw new TypeError("long_run_daemon_owner_epoch_required");
  }
  const existing = getDb().prepare(
    "SELECT * FROM long_runs WHERE goal_id = ? OR idempotency_key = ? LIMIT 1",
  ).get(goalId, idempotencyKey) as LongRunRow | undefined;
  if (existing) {
    const record = rowToLongRun(existing);
    if (!record) throw new Error("long_run_existing_row_invalid");
    return record;
  }

  const now = new Date().toISOString();
  const id = input.id?.trim() || `run_${randomUUID()}`;
  const status = input.status ?? "queued";
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO long_runs (
        id, goal_id, idempotency_key, surface, execution_location,
        root_chat_id, project_id, science_job_id, objective, acceptance_criteria_json,
        status, runtime_fallback_policy, max_cycles, max_cost_usd,
        wallclock_deadline, max_workers, stall_window, app_instance_id,
        created_at, updated_at, started_at, host_owner_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      goalId,
      idempotencyKey,
      input.surface,
      executionLocation,
      input.rootChatId ?? null,
      input.projectId ?? null,
      input.scienceJobId ?? null,
      objective,
      JSON.stringify(criteria),
      status,
      input.runtimeFallbackPolicy ?? "locked",
      input.budget?.maxCycles ?? null,
      input.budget?.maxCostUsd ?? null,
      input.budget?.wallclockDeadline ?? null,
      input.budget?.maxWorkers ?? null,
      Math.max(1, Math.floor(input.stallWindow ?? 3)),
      input.appInstanceId ?? null,
      now,
      now,
      status === "running" ? now : null,
      hostOwnerKind,
    );

    db.prepare(
      `INSERT INTO long_run_tasks (
        run_id, id, parent_task_id, title, objective,
        acceptance_criteria_json, dependency_ids_json, criterion_indices_json,
        state, sort_order, created_at, updated_at
      ) VALUES (?, 'task:bootstrap', NULL, ?, ?, ?, '[]', ?, 'todo', 0, ?, ?)`,
    ).run(
      id,
      objective.slice(0, 240),
      objective,
      JSON.stringify(criteria),
      JSON.stringify(criteria.map((_, index) => index)),
      now,
      now,
    );
    appendEventInDb({
      runId: id,
      kind: "run.created",
      actorKind: "host",
      payload: { status, surface: input.surface, executionLocation, hostOwnerKind },
      at: now,
    });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id });
  const created = getLongRun(id);
  if (!created) throw new Error("long_run_create_readback_failed");
  return created;
}

export function ensureGoalLongRun(input: {
  goalId: string;
  objective: string;
  acceptanceCriteria: readonly string[];
  projectDir?: string | null;
  wallclockDeadline?: string;
  maxCycles?: number;
  maxCostUsd?: number;
  stallWindow?: number;
}): LongRunRecord {
  const goalId = requiredText(input.goalId, "long_run_goal_id_required", 240);
  const db = getDb();
  const chat = db.prepare(
    `SELECT id, project_id, origin_surface
     FROM chats WHERE goal_id = ?
     ORDER BY updated_at DESC LIMIT 1`,
  ).get(goalId) as { id: string; project_id: string | null; origin_surface: string | null } | undefined;
  return createLongRun({
    goalId,
    surface: chat?.origin_surface === "one" ? "one" : "work",
    rootChatId: chat?.id ?? null,
    projectId: chat?.project_id ?? null,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    status: "running",
    budget: {
      maxCycles: input.maxCycles ?? null,
      maxCostUsd: input.maxCostUsd ?? null,
      wallclockDeadline: input.wallclockDeadline ?? null,
      maxWorkers: null,
    },
    stallWindow: input.stallWindow,
  });
}

export function getLongRun(id: string): LongRunRecord | null {
  const row = getDb().prepare("SELECT * FROM long_runs WHERE id = ? LIMIT 1")
    .get(id.trim()) as LongRunRow | undefined;
  return rowToLongRun(row);
}

export function getLongRunByGoalId(goalId: string): LongRunRecord | null {
  const normalized = goalId.trim();
  if (!normalized) return null;
  const row = getDb().prepare("SELECT * FROM long_runs WHERE goal_id = ? LIMIT 1")
    .get(normalized) as LongRunRow | undefined;
  return rowToLongRun(row);
}

export function listLongRuns(input: {
  statuses?: readonly LongRunStatus[];
  executionLocation?: LongRunExecutionLocation;
  limit?: number;
} = {}): LongRunRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.statuses?.length) {
    clauses.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
    params.push(...input.statuses);
  }
  if (input.executionLocation) {
    clauses.push("execution_location = ?");
    params.push(input.executionLocation);
  }
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 500);
  params.push(limit);
  const rows = getDb().prepare(
    `SELECT * FROM long_runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY updated_at DESC LIMIT ?`,
  ).all(...params) as LongRunRow[];
  return rows.flatMap((row) => rowToLongRun(row) ?? []);
}

type LongRunDomainBindingRow = {
  long_run_id: string;
  domain: "science";
  object_type: "loop_session";
  object_id: string;
  external_project_id: string;
  contract_id: string | null;
  contract_version: number | null;
  contract_content_sha256: string | null;
  object_version: number;
  state_sha256: string;
  event_cursor: number;
  projection_status: "current" | "stale" | "error";
  last_error: string | null;
  synced_at: string;
};

function rowToDomainBinding(row: LongRunDomainBindingRow | undefined): LongRunDomainBindingRecord | null {
  return row ? {
    longRunId: row.long_run_id,
    domain: row.domain,
    objectType: row.object_type,
    objectId: row.object_id,
    externalProjectId: row.external_project_id,
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    contractContentSha256: row.contract_content_sha256,
    objectVersion: row.object_version,
    stateSha256: row.state_sha256,
    eventCursor: row.event_cursor,
    projectionStatus: row.projection_status,
    lastError: row.last_error,
    syncedAt: row.synced_at,
  } : null;
}

export function getLongRunDomainBinding(longRunId: string): LongRunDomainBindingRecord | null {
  const row = getDb().prepare("SELECT * FROM long_run_domain_bindings WHERE long_run_id = ?")
    .get(longRunId.trim()) as LongRunDomainBindingRow | undefined;
  return rowToDomainBinding(row);
}

export function upsertLongRunDomainBinding(input: {
  longRunId: string;
  domain: "science";
  objectType: "loop_session";
  objectId: string;
  externalProjectId: string;
  contractId?: string | null;
  contractVersion?: number | null;
  contractContentSha256?: string | null;
  objectVersion: number;
  stateSha256: string;
  eventCursor: number;
  projectionStatus?: "current" | "stale" | "error";
  lastError?: string | null;
}): LongRunDomainBindingRecord {
  const run = getLongRun(input.longRunId);
  if (!run || run.surface !== "science" || run.scienceJobId !== input.objectId) {
    throw new Error("science_projection_binding_scope_invalid");
  }
  if (!Number.isSafeInteger(input.objectVersion) || input.objectVersion < 1) {
    throw new TypeError("science_projection_version_invalid");
  }
  if (!Number.isSafeInteger(input.eventCursor) || input.eventCursor < 0) {
    throw new TypeError("science_projection_cursor_invalid");
  }
  if (!/^[0-9a-f]{64}$/i.test(input.stateSha256)) throw new TypeError("science_projection_state_hash_invalid");
  if (input.contractContentSha256 && !/^[0-9a-f]{64}$/i.test(input.contractContentSha256)) {
    throw new TypeError("science_projection_contract_hash_invalid");
  }
  const objectId = requiredText(input.objectId, "science_projection_object_id_required", 240);
  const externalProjectId = requiredText(input.externalProjectId, "science_projection_project_id_required", 240);
  const now = new Date().toISOString();
  const db = getDb();
  db.transaction(() => {
    const existing = db.prepare("SELECT * FROM long_run_domain_bindings WHERE long_run_id = ?")
      .get(run.id) as LongRunDomainBindingRow | undefined;
    if (existing) {
      if (existing.domain !== input.domain || existing.object_type !== input.objectType
        || existing.object_id !== objectId || existing.external_project_id !== externalProjectId) {
        throw new Error("science_projection_binding_identity_conflict");
      }
      if (input.objectVersion < existing.object_version) return;
      if (input.objectVersion === existing.object_version && input.stateSha256 !== existing.state_sha256) {
        db.prepare(`UPDATE long_run_domain_bindings
          SET projection_status = 'error', last_error = 'science_projection_fork', synced_at = ?
          WHERE long_run_id = ?`).run(now, run.id);
        return;
      }
      db.prepare(`UPDATE long_run_domain_bindings SET
        contract_id = ?, contract_version = ?, contract_content_sha256 = ?,
        object_version = ?, state_sha256 = ?, event_cursor = ?,
        projection_status = ?, last_error = ?, synced_at = ?
        WHERE long_run_id = ?`).run(
        input.contractId ?? null,
        input.contractVersion ?? null,
        input.contractContentSha256 ?? null,
        input.objectVersion,
        input.stateSha256.toLowerCase(),
        Math.max(existing.event_cursor, input.eventCursor),
        input.projectionStatus ?? "current",
        input.lastError?.slice(0, 240) ?? null,
        now,
        run.id,
      );
      return;
    }
    db.prepare(`INSERT INTO long_run_domain_bindings (
      long_run_id, domain, object_type, object_id, external_project_id,
      contract_id, contract_version, contract_content_sha256,
      object_version, state_sha256, event_cursor, projection_status, last_error, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        run.id,
        input.domain,
        input.objectType,
        objectId,
        externalProjectId,
        input.contractId ?? null,
        input.contractVersion ?? null,
        input.contractContentSha256 ?? null,
        input.objectVersion,
        input.stateSha256.toLowerCase(),
        input.eventCursor,
        input.projectionStatus ?? "current",
        input.lastError?.slice(0, 240) ?? null,
        now,
      );
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: run.id });
  const binding = getLongRunDomainBinding(run.id);
  if (!binding) throw new Error("science_projection_binding_readback_failed");
  return binding;
}

/*
 * ★Owner stop is a boundary (owner 2026-09-25). A goal the owner/user paused stays paused until the owner
 * resumes it. Before this, a pause landed as a ledger fact only: pausing a `blocked` goal changed nothing,
 * and the blocked-goal sweep, the effect-observation resume and the app-closed restart path resumed it —
 * isolated live run 2026-09-25 (run_80dc1968 / run_8df1afec) kept spending after two user pauses.
 *
 * The hold is read from the ledger, not from status alone, so a later host re-park (app_closed pause,
 * retry wait) cannot launder it: the latest user pause is held until a later owner resume
 * (user_control resume_with_message / command resume, or a user-actor transition back to queued/running).
 */
export const LONG_RUN_OWNER_HOLD_CODE = "long_run_owner_paused";

/**
 * The room's Goal is stopped until its owner lifts it: an owner pause, an unreleased owner hold, or a budget stop.
 * Owner decision 2026-10-06: a paused room also stops the agent graphs (Toolchains) it made — on 2026-10-05 the
 * paused X Marketing room's schedules kept running and drafting.
 */
export function chatGoalStoppedByOwner(chatId: string): boolean {
  const row = getDb().prepare(`SELECT id, status, pause_reason FROM long_runs WHERE root_chat_id = ?
      AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY updated_at DESC LIMIT 1`)
    .get(chatId) as { id: string; status: string; pause_reason: string | null } | undefined;
  if (!row) return false;
  if (row.status === "paused" && (row.pause_reason === "user" || row.pause_reason === "budget")) return true;
  return longRunOwnerHold(row.id);
}

export function longRunOwnerHold(runId: string): boolean {
  const row = getDb().prepare(`SELECT
      (SELECT MAX(seq) FROM long_run_events WHERE run_id = ? AND kind = 'run.user_control' AND actor_kind = 'user'
        AND (json_extract(payload_json, '$.action') = 'pause' OR json_extract(payload_json, '$.command') = 'pause')) AS paused,
      (SELECT MAX(seq) FROM long_run_events WHERE run_id = ? AND (
        (kind = 'run.user_control' AND actor_kind = 'user'
          AND (json_extract(payload_json, '$.action') = 'resume_with_message' OR json_extract(payload_json, '$.command') = 'resume'))
        OR (kind = 'run.status_changed' AND actor_kind = 'user' AND json_extract(payload_json, '$.to') IN ('queued', 'running')))) AS released`)
    .get(runId, runId) as { paused: number | null; released: number | null } | undefined;
  return typeof row?.paused === "number" && (typeof row.released !== "number" || row.paused > row.released);
}

/**
 * Host settlement of a system-admitted Goal at its retry cap (owner 2026-09-25). Two exits only:
 *  - "settled_with_evidence": every current criterion passed in the latest authorized verifier round,
 *    with resolvable host references. Completion revalidates that exact proof set atomically.
 *  - "owner_review_required": historical compatibility outcome; keeps independent work queued.
 */
export const AUTO_GOAL_SETTLED_WITH_EVIDENCE = "auto_goal_settled_with_evidence";
export const AUTO_GOAL_OWNER_REVIEW_REQUIRED = "auto_goal_owner_review_required";

export function settleAutomaticGoalAtRetryCap(input: {
  runId: string; expectedVersion: number;
  outcome: typeof AUTO_GOAL_SETTLED_WITH_EVIDENCE | typeof AUTO_GOAL_OWNER_REVIEW_REQUIRED;
  retries: number; evidenceRefs: readonly string[]; receiptIds: readonly string[];
}): LongRunRecord {
  const db = getDb();
  db.transaction(() => {
    const current = getLongRun(input.runId);
    if (!current || current.version !== input.expectedVersion || current.surface === "science"
      || !["blocked", "paused", "waiting_tool"].includes(current.status)) throw new Error("auto_goal_retry_cap_state_changed");
    if (input.outcome === AUTO_GOAL_SETTLED_WITH_EVIDENCE) {
      const proof = currentCompleteGoalVerificationEvidence(current.id);
      const sameSet = (actual: readonly string[], expected: readonly string[]) => {
        const values = new Set(actual);
        return values.size === expected.length && expected.every(value => values.has(value));
      };
      if (!proof || !sameSet(input.evidenceRefs, proof.refs) || !sameSet(input.receiptIds, proof.receiptIds)) {
        throw new Error("auto_goal_retry_cap_settlement_not_admissible");
      }
    }
    const now = new Date().toISOString();
    const to = input.outcome === AUTO_GOAL_SETTLED_WITH_EVIDENCE ? "completed" : "queued";
    const changed = db.prepare(`UPDATE long_runs SET status = ?, pause_reason = NULL, blocked_reason = ?, paused_at = NULL,
        completed_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = ? AND version = ?`)
      .run(to, null, to === "completed" ? now : null, now,
        current.id, current.status, current.version);
    if (changed.changes !== 1) throw new Error("auto_goal_retry_cap_state_changed");
    appendEventInDb({ runId: current.id, kind: "run.status_changed", actorKind: "host",
      payload: { from: current.status, to, reason: input.outcome, retries: input.retries,
        evidenceRefs: [...input.evidenceRefs].slice(0, 32), receiptIds: [...input.receiptIds].slice(0, 32) }, at: now });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  const next = getLongRun(input.runId);
  if (!next) throw new Error("long_run_transition_readback_failed");
  return next;
}

export function transitionLongRun(input: {
  runId: string;
  to: LongRunStatus;
  reason?: string | null;
  actorKind?: "host" | "user" | "worker" | "runtime" | "tool" | "system";
  actorId?: string | null;
  appInstanceId?: string | null;
  expectedVersion?: number;
  authority?: "generic" | "science-projection";
}): LongRunRecord {
  const current = getLongRun(input.runId);
  if (!current) throw new Error(`long_run_not_found:${input.runId}`);
  if (current.surface === "science" && input.authority !== "science-projection") {
    throw new Error("science_projection_read_only");
  }
  if (input.to === "completed" && current.surface !== "science" && getChatGoalRevision(current.goalId)?.lifecycle === "ongoing") {
    throw new Error("ongoing_goal_requires_user_stop");
  }
  if (input.to === "completed" && current.surface !== "science"
    && !require("../long-run/goal-obligation-context").currentGoalObligationsSatisfied(current.goalId)) {
    throw new Error("goal_execution_obligations_unmet");
  }
  const requestedTo = input.to;
  const resolvedTo = resolveNonBlockingGoalStatus(current.status, input.to, input.reason, input.actorKind);
  const skipped = requestedTo !== resolvedTo;
  input = { ...input, to: resolvedTo };
  if (input.expectedVersion != null && current.version !== input.expectedVersion) {
    throw new Error("long_run_transition_version_conflict");
  }
  if (!skipped) assertLongRunTransition(current.status, input.to);
  if (current.status === input.to && !skipped) {
    // A status no-op is not an ownership grant. Startup takes custody under
    // the exclusive GUI lock; callers must not silently retain or steal it.
    if (input.appInstanceId != null && input.appInstanceId !== current.appInstanceId) {
      // Only another instance's claim is a conflict. A run nobody owns yet (a Goal Main admitted for another process's turn
      // is queued with no instance) has no live holder to lose to: the first host that asks takes it, compare-and-swap, or
      // every resume of it was refused for ever and each refusal still spent a sweep dispatch slot.
      if (current.appInstanceId != null || current.hostOwnerKind !== "desktop") throw new Error("long_run_transition_owner_conflict");
      const db = getDb();
      db.transaction(() => {
        const claimed = db.prepare("UPDATE long_runs SET app_instance_id = ? WHERE id = ? AND version = ? AND status = ? AND app_instance_id IS NULL")
          .run(input.appInstanceId, current.id, current.version, current.status);
        if (claimed.changes !== 1) throw new Error("long_run_transition_owner_conflict");
        appendEventInDb({ runId: current.id, kind: "run.owner_claimed", actorKind: input.actorKind ?? "host",
          payload: { status: current.status, appInstanceId: input.appInstanceId, from: null }, at: new Date().toISOString() });
      }).immediate();
      emitDesktopStoreChange({ entity: "long-run", id: current.id });
      return getLongRun(current.id) ?? current;
    }
    return current;
  }
  // Only the owner lifts an owner hold; every host/worker path that would start the goal again stops here.
  if ((input.actorKind ?? "host") !== "user" && ["queued", "running", "waiting_tool"].includes(input.to)
    && ["paused", "blocked", "waiting_tool"].includes(current.status) && longRunOwnerHold(current.id)) {
    throw new Error(LONG_RUN_OWNER_HOLD_CODE);
  }
  const now = new Date().toISOString();
  const pausedAt = input.to === "paused" ? now : null;
  const completedAt = LONG_RUN_TERMINAL_STATUSES.has(input.to) ? now : null;
  const db = getDb();
  db.transaction(() => {
    const changed = db.prepare(
      `UPDATE long_runs
       SET status = ?, pause_reason = ?, blocked_reason = ?, app_instance_id = COALESCE(?, app_instance_id),
           paused_at = ?, completed_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND status = ? AND version = ?`,
    ).run(
      input.to,
      input.to === "paused"
        ? isLongRunPauseReason(input.reason) ? input.reason : current.surface === "science" ? "agent_paused" : "user"
        : null,
      input.to === "blocked" ? input.reason?.slice(0, 500) ?? "blocked" : null,
      input.appInstanceId ?? null,
      pausedAt,
      completedAt,
      now,
      current.id,
      current.status,
      current.version,
    );
    if (changed.changes !== 1) throw new Error("long_run_transition_conflict");
    appendEventInDb({
      runId: current.id,
      kind: "run.status_changed",
      actorKind: input.actorKind ?? "host",
      actorId: input.actorId,
      payload: { from: current.status, to: input.to, reason: input.reason ?? null },
      at: now,
    });
    if (skipped) appendEventInDb({ runId: current.id, kind: "run.block_skipped", actorKind: input.actorKind ?? "host",
      payload: { requestedStatus: requestedTo, status: input.to, reason: input.reason ?? null,
        outcome: "unknown", continueIndependentWork: true, replayUncertainEffects: false }, at: now });
    if (input.to === "cancelled" || input.to === "failed") closeOpenTasksOfEndedRun(current.id, now);
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: current.id });
  const next = getLongRun(current.id);
  if (!next) throw new Error("long_run_transition_readback_failed");
  return next;
}

/**
 * A cancelled or failed run owns no open work. Measured 2026-09-27: 11 cancelled runs still held
 * tasks in todo/doing/verifying (run_6d24b328 'doing' since 09-15) because every cancel path — user
 * delete, blocked-goal sweep, MCP cancelRun — changed only long_runs. Nothing read them yet, but any
 * count of open work across runs would have seen phantom work. Callers run inside their transaction.
 */
function closeOpenTasksOfEndedRun(runId: string, now: string): void {
  const db = getDb();
  const states = [...LONG_RUN_OPEN_TASK_STATES];
  const open = db.prepare(`SELECT id, state FROM long_run_tasks WHERE run_id = ?
      AND state IN (${states.map(() => "?").join(",")})`).all(runId, ...states) as Array<{ id: string; state: string }>;
  if (open.length === 0) return;
  db.prepare(`UPDATE long_run_tasks SET state = 'cancelled', updated_at = ?, completed_at = ?
      WHERE run_id = ? AND state IN (${states.map(() => "?").join(",")})`).run(now, now, runId, ...states);
  for (const task of open) {
    appendEventInDb({ runId, kind: "task.status_changed", actorKind: "host",
      payload: { taskId: task.id, from: task.state, to: "cancelled", reason: "run_ended" }, at: now });
  }
}

/** Queue independent recovery after an uncertain startup wait. Its specific
 * external action stays unresolved; a user pause/Stop cannot match. */
export function blockHostPausedClaimedGoalWait(runId: string, expectedVersion: number,
  reason: "goal_wait_claimed_dispatch_uncertain" | "goal_wait_claimed_binding_changed"): LongRunRecord {
  if (longRunOwnerHold(runId)) throw new Error(LONG_RUN_OWNER_HOLD_CODE);
  const db = getDb();
  db.transaction(() => {
    const current = getLongRun(runId);
    if (!current || current.surface === "science" || current.status !== "paused"
      || !["app_closed", "crash_recovery"].includes(current.pauseReason ?? "")
      || current.version !== expectedVersion) throw new Error("goal_wait_claimed_recovery_state_changed");
    const now = new Date().toISOString();
    const changed = db.prepare(`UPDATE long_runs SET status='queued', pause_reason=NULL, blocked_reason=NULL,
      paused_at=NULL, updated_at=?, version=version+1 WHERE id=? AND status='paused' AND version=? AND pause_reason IN ('app_closed','crash_recovery')`)
      .run(now, runId, expectedVersion);
    if (changed.changes !== 1) throw new Error("goal_wait_claimed_recovery_state_changed");
    appendEventInDb({ runId, kind: "run.status_changed", actorKind: "host",
      payload: { from: "paused", to: "queued", skippedStatus: "blocked", reason }, at: now });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: runId });
  const blocked = getLongRun(runId);
  if (!blocked) throw new Error("goal_wait_claimed_recovery_readback_failed");
  return blocked;
}

/** Ledger kind of the host's "no Goal stays blocked" sweep (owner 2026-09-23). */
export const BLOCKED_GOAL_SWEEP_EVENT_KIND = "run.blocked_sweep";
export const BLOCKED_GOAL_SWEEP_SCHEMA = "agentlas.blocked-goal-sweep.v1";

export interface BlockedGoalRetry {
  seq: number;
  /** The blocker this retry stands in for; restored when the retry comes due. */
  fromReason: string | null;
  kind: "observe" | "resume";
  retryIndex: number;
  nextAt: string;
  /** model = the Goal's own turn asked for this time (shown to the owner as such); host = the host's policy. */
  requestedBy: "model" | "host";
}

/**
 * Follow-ups scheduled after Goal turns for the same reason since the owner last spoke (`ownerSince`) or used a
 * Goal control. Each one is a turn that ended without starting new work. Measured on the owner's DB 2026-10-04
 * (Thread Marketing): a fixed 30-second follow-up after every refused wait re-ran a ~247k-token turn 39 times
 * in one hour, all with the same answer ("972 to go, next check 15:11").
 */
export function consecutiveGoalTurnFollowUps(runId: string, reason: string, ownerSince: string | null, now = Date.now(),
  options: { sinceCompletedTurn?: boolean } = {}): number {
  const day = new Date(now - 24 * 60 * 60_000).toISOString();
  const floor = ownerSince && ownerSince > day ? ownerSince : day;
  // With sinceCompletedTurn a turn that completed starts the count over, so only follow-ups after turns that failed
  // or never finished add up (a productive Goal keeps the 30 s step).
  const control = getDb().prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM long_run_events WHERE run_id = ? AND (kind = 'run.user_control'
      OR (? = 1 AND kind = 'worker.attempt_settled' AND json_extract(payload_json, '$.state') = 'completed'))`)
    .get(runId, options.sinceCompletedTurn ? 1 : 0) as { seq: number };
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM long_run_events WHERE run_id = ? AND kind = ? AND seq > ? AND occurred_at > ?
    AND json_extract(payload_json, '$.action') = 'retry_scheduled'
    AND json_extract(payload_json, '$.trigger') = 'goal-turn-background'
    AND json_extract(payload_json, '$.detail') = ?`).get(runId, BLOCKED_GOAL_SWEEP_EVENT_KIND, control.seq, floor, reason) as { n: number };
  return row.n;
}

/** When the next follow-up of a Goal turn may start: 30 s doubling per consecutive repeat (6 h cap), never before
 * the time the turn itself asked for (24 h cap). */
export function goalTurnFollowUpPlan(input: { repeats: number; requestedNotBefore?: string | null; now?: number }): { nextAt: string; requestedBy: "model" | "host" } {
  const now = input.now ?? Date.now();
  const backoff = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(Math.max(input.repeats, 0), 12));
  const requested = input.requestedNotBefore ? Date.parse(input.requestedNotBefore) : Number.NaN;
  const asked = Number.isFinite(requested) ? Math.min(requested - now, 24 * 60 * 60_000) : 0;
  return { nextAt: new Date(now + Math.max(backoff, asked)).toISOString(), requestedBy: asked > backoff ? "model" : "host" };
}

export function goalTurnFollowUpAt(input: { repeats: number; requestedNotBefore?: string | null; now?: number }): string {
  return goalTurnFollowUpPlan(input).nextAt;
}

/** A host-owned retry schedule that no later transition has superseded (a user pause, a new turn, a stop). */
export function pendingBlockedGoalRetry(runId: string): BlockedGoalRetry | null {
  const run = getLongRun(runId);
  if (!run || !(run.status === "waiting_tool"
    || (run.status === "paused" && ["app_closed", "crash_recovery"].includes(run.pauseReason ?? "")))) return null;
  // The owner-answer hold replaces the retry it was taken over (holdGoalForOwnerAnswer): nothing wakes a held Goal, so every
  // reader (next-wake line, Alive, the wait poller, the sweep) sees what it saw for a Goal held from `running`.
  if (goalHeldForOwnerAnswer(run)) return null;
  const row = getDb().prepare(`SELECT seq, payload_json FROM long_run_events WHERE run_id = ? AND kind = ?
    ORDER BY seq DESC LIMIT 1`).get(runId, BLOCKED_GOAL_SWEEP_EVENT_KIND) as { seq: number; payload_json: string } | undefined;
  if (!row) return null;
  const superseded = getDb().prepare(`SELECT 1 FROM long_run_events WHERE run_id = ? AND seq > ? AND (
      (kind = 'run.status_changed' AND json_extract(payload_json, '$.to') NOT IN ('waiting_tool','paused'))
      OR kind IN ('run.user_control','run.wait_subscription')) LIMIT 1`).get(runId, row.seq);
  if (superseded) return null;
  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (payload.action !== "retry_scheduled" || (payload.kind !== "observe" && payload.kind !== "resume")
      || typeof payload.nextAt !== "string" || !Number.isSafeInteger(payload.retryIndex)) return null;
    return { seq: row.seq, fromReason: typeof payload.fromReason === "string" ? payload.fromReason : null,
      kind: payload.kind, retryIndex: Number(payload.retryIndex), nextAt: payload.nextAt,
      requestedBy: payload.requestedBy === "model" ? "model" : "host" };
  } catch { return null; }
}

/**
 * 막힌 목표를 '자동 재시도 예약'으로 옮긴다 — 오너 지시 2026-09-23 "블락되는거 전부다 치워라",
 * 정정 "눌러서 이어가는게 결국 멈춘거 아닌가".
 *
 * 앱이 지금 당장 확인(효과 관찰)도 재개도 못 할 때(런타임 없음·사용 한도·관찰 모름) 사람을 기다리지 않고
 * 스스로 다시 할 시각을 원장에 적는다. 상태는 'waiting_tool'(앱이 기다리는 중)이고, 그 시각이 되면
 * 스윕이 원래 사유로 되돌려(reopenDueBlockedGoalRetry) 같은 판단을 다시 한다. 이 쓰기는 어떤 실행도
 * 허가하지 않는다 — 불확실한 효과는 여전히 읽기 전용 관찰만 풀 수 있다. blocked→waiting_tool 은
 * 일반 전이표에 없으므로 여기서만 CAS 로 쓴다.
 */
export function scheduleBlockedGoalRetry(input: {
  runId: string;
  expectedVersion: number;
  kind: "observe" | "resume";
  fromReason: string | null;
  retryIndex: number;
  nextAt: string;
  detail: string;
  trigger: string;
  appInstanceId?: string | null;
  requestedBy?: "model" | "host";
}): LongRunRecord {
  if (longRunOwnerHold(input.runId)) throw new Error(LONG_RUN_OWNER_HOLD_CODE);
  // A Goal held for the owner's answer is woken by nobody: no scheduler may put a retry under it (it would rewrite the hold).
  if (goalOwnerAnswerHold(input.runId)) throw new Error(GOAL_OWNER_ANSWER_PENDING_CODE);
  const db = getDb();
  db.transaction(() => {
    const current = getLongRun(input.runId);
    // A host-written dispatch failure pause (runtime_unavailable) is the same "try again later" fact:
    // accept it here so no failed dispatch is left waiting for a person.
    const hostDispatchPause = current?.status === "paused"
      && ["runtime_unavailable", "app_closed", "crash_recovery"].includes(current.pauseReason ?? "");
    if (!current || current.surface === "science" || current.version !== input.expectedVersion
      || !(["blocked", "queued", "running", "waiting_tool"].includes(current.status) || hostDispatchPause || pendingBlockedGoalRetry(current.id))) throw new Error("blocked_goal_retry_state_changed");
    if (liveLongRunAttemptCount(input.runId)) throw new Error("blocked_goal_retry_controller_live");
    const now = new Date().toISOString();
    if (current.status !== "waiting_tool") {
      const changed = db.prepare(`UPDATE long_runs SET status='waiting_tool', pause_reason=NULL, blocked_reason=NULL,
        app_instance_id=COALESCE(?, app_instance_id), paused_at=NULL, updated_at=?, version=version+1
        WHERE id=? AND status=? AND version=?`)
        .run(input.appInstanceId ?? null, now, input.runId, current.status, input.expectedVersion);
      if (changed.changes !== 1) throw new Error("blocked_goal_retry_state_changed");
      appendEventInDb({ runId: input.runId, kind: "run.status_changed", actorKind: "host",
        payload: { from: current.status, to: "waiting_tool", reason: "blocked-sweep-retry-scheduled" }, at: now });
    }
    appendEventInDb({ runId: input.runId, kind: BLOCKED_GOAL_SWEEP_EVENT_KIND, actorKind: "host",
      payload: { schemaVersion: BLOCKED_GOAL_SWEEP_SCHEMA, action: "retry_scheduled", kind: input.kind,
        fromReason: input.fromReason, retryIndex: input.retryIndex, nextAt: input.nextAt,
        detail: input.detail.slice(0, 120), trigger: input.trigger.slice(0, 80),
        appInstanceId: input.appInstanceId ?? null,
        ...(input.requestedBy === "model" ? { requestedBy: "model" } : {}) }, at: now });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  const next = getLongRun(input.runId);
  if (!next) throw new Error("blocked_goal_retry_readback_failed");
  return next;
}

/**
 * A Goal that asked the owner a question rests until the owner answers (owner 2026-10-20 "답오기전에 해당작업 보류하며
 * 다른 작업은 진행"). The hold is the row itself: status waiting_tool with the question code in blocked_reason (the host never
 * rests a Goal as blocked/waiting_user, see resolveNonBlockingGoalStatus). Every transition rewrites blocked_reason, so it ends
 * with the state it describes. No retry is scheduled and nothing wakes a held Goal on its own, so it neither re-asks the same
 * card on every wake nor keeps a Work project's provider busy for the owner's other conversations (the spaced follow-up it
 * replaces did both: each wake is a full model turn, and a turn of the project's other chats is refused while one runs).
 */
export const GOAL_OWNER_ANSWER_PENDING_CODE = "goal_owner_answer_pending";

export function goalOwnerAnswerHold(runId: string): boolean {
  const row = getDb().prepare("SELECT status, blocked_reason AS blockedReason FROM long_runs WHERE id = ?")
    .get(runId) as { status: string; blockedReason: string | null } | undefined;
  return Boolean(row && goalHeldForOwnerAnswer(row));
}

/** When the Goal last asked its question (newest run.owner_answer_pending); null if it never did. */
export function goalOwnerAnswerPendingSince(runId: string): string | null {
  const row = getDb().prepare("SELECT occurred_at AS at FROM long_run_events WHERE run_id = ? AND kind = 'run.owner_answer_pending' ORDER BY seq DESC LIMIT 1")
    .get(runId) as { at: string } | undefined;
  return row?.at ?? null;
}

/** waiting_tool on a retry the HOST scheduled and nobody has started (no blocked_reason, a pending host retry). */
function goalRestsOnHostRetry(run: Pick<LongRunRecord, "id" | "status" | "blockedReason">): boolean {
  return run.status === "waiting_tool" && (run.blockedReason ?? null) === null && pendingBlockedGoalRetry(run.id) !== null;
}

/** A Goal the host can rest for the owner's answer: running, or resting on its own scheduled retry (holdGoalForOwnerAnswer). */
export function goalHoldableForOwnerAnswer(run: Pick<LongRunRecord, "id" | "status" | "blockedReason">): boolean {
  return run.status === "running" || goalRestsOnHostRetry(run);
}

/**
 * running -> waiting_tool holding for the owner's answer. A Goal the owner stopped is never moved (that hold is the owner's).
 *
 * A Goal may also be taken from `waiting_tool` when the retry resting it there is one the HOST scheduled and nobody has
 * started (no blocked_reason, a pending host retry): a turn end schedules its spaced follow-up before the terminal verifier
 * answers (InvocationService verification_background), so by the time a verdict asks the owner the Goal is already waiting on
 * that retry. The hold replaces it: only blocked_reason changes, the status stays, and every waker already checks the hold
 * before it looks at a retry (sweep, startup checkpoints, wait poller, Alive).
 */
export function holdGoalForOwnerAnswer(input: { runId: string; expectedVersion?: number; invocationRunId?: string | null; appInstanceId?: string | null }): LongRunRecord {
  const db = getDb();
  db.transaction(() => {
    const current = getLongRun(input.runId);
    const hostRetryResting = current ? goalRestsOnHostRetry(current) : false;
    if (!current || current.surface === "science" || (current.status !== "running" && !hostRetryResting)
      || (input.expectedVersion != null && current.version !== input.expectedVersion)) throw new Error("goal_owner_answer_hold_state_changed");
    if (longRunOwnerHold(input.runId)) throw new Error(LONG_RUN_OWNER_HOLD_CODE);
    if (liveLongRunAttemptCount(input.runId)) throw new Error("goal_owner_answer_hold_controller_live");
    const now = new Date().toISOString();
    const changed = hostRetryResting
      ? db.prepare(`UPDATE long_runs SET blocked_reason=?, app_instance_id=COALESCE(?, app_instance_id), updated_at=?, version=version+1
          WHERE id=? AND status='waiting_tool' AND blocked_reason IS NULL AND version=?`)
        .run(GOAL_OWNER_ANSWER_REQUIRED, input.appInstanceId ?? null, now, current.id, current.version)
      : db.prepare(`UPDATE long_runs SET status='waiting_tool', pause_reason=NULL, blocked_reason=?, paused_at=NULL,
          app_instance_id=COALESCE(?, app_instance_id), updated_at=?, version=version+1 WHERE id=? AND status='running' AND version=?`)
        .run(GOAL_OWNER_ANSWER_REQUIRED, input.appInstanceId ?? null, now, current.id, current.version);
    if (changed.changes !== 1) throw new Error("goal_owner_answer_hold_state_changed");
    if (!hostRetryResting) appendEventInDb({ runId: current.id, kind: "run.status_changed", actorKind: "host",
      payload: { from: "running", to: "waiting_tool", reason: GOAL_OWNER_ANSWER_REQUIRED }, at: now });
    appendEventInDb({ runId: current.id, kind: "run.owner_answer_pending", actorKind: "host",
      payload: { reason: GOAL_OWNER_ANSWER_REQUIRED, ...(input.invocationRunId ? { invocationRunId: input.invocationRunId } : {}) }, at: now });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  const next = getLongRun(input.runId);
  if (!next) throw new Error("goal_owner_answer_hold_readback_failed");
  return next;
}

/**
 * The owner spoke in the Goal's chat through a channel that cannot reopen a Goal (the phone, Telegram, the background
 * service: a turn that carries a workspace binding or execution context is not a local owner turn). The hold ends and the
 * Goal is queued for its ordinary resume. The desktop composer never reaches this: its message reopens the Goal itself
 * (stoppedGoalMessageReopens), and the sweep leaves a chat with a live turn or a waiting owner request alone.
 */
export function releaseGoalOwnerAnswerHold(input: { runId: string; expectedVersion: number; reason: string; appInstanceId?: string | null }): LongRunRecord {
  const db = getDb();
  db.transaction(() => {
    const current = getLongRun(input.runId);
    if (!current || current.version !== input.expectedVersion || !goalHeldForOwnerAnswer(current)) throw new Error("goal_owner_answer_release_state_changed");
    if (liveLongRunAttemptCount(input.runId)) throw new Error("goal_owner_answer_release_controller_live");
    const now = new Date().toISOString();
    // The row keeps the app instance that held it. resume() asks for queued -> queued under this instance, and a status
    // no-op is refused for any other one (long_run_transition_owner_conflict), so a hold from before a restart is re-owned here.
    const changed = db.prepare(`UPDATE long_runs SET status='queued', pause_reason=NULL, blocked_reason=NULL, paused_at=NULL,
      app_instance_id=COALESCE(?, app_instance_id), updated_at=?, version=version+1 WHERE id=? AND status='waiting_tool' AND version=?`)
      .run(input.appInstanceId ?? null, now, current.id, current.version);
    if (changed.changes !== 1) throw new Error("goal_owner_answer_release_state_changed");
    appendEventInDb({ runId: current.id, kind: "run.status_changed", actorKind: "host",
      payload: { from: "waiting_tool", to: "queued", reason: input.reason.slice(0, 120) }, at: now });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  const next = getLongRun(input.runId);
  if (!next) throw new Error("goal_owner_answer_release_readback_failed");
  return next;
}

/**
 * The owner pressed Resume on a Goal resting for them (its question, or its start grant) while another turn runs in the
 * Goal's chat. The press is the owner's instruction, so the hold ends now and the Goal is queued; the blocked-goal sweep
 * starts it once that turn has ended. Before, the press changed nothing and the hold waited for an owner message. Returns
 * the queued run, or null when the Goal is no longer held (nothing to release) or a controller attempt is live.
 */
export function queueOwnerHeldGoalForResume(input: { runId: string; appInstanceId?: string | null }): LongRunRecord | null {
  const db = getDb();
  const queued = db.transaction((): boolean => {
    const current = getLongRun(input.runId);
    if (!current || current.surface === "science" || !(goalHeldForOwnerAnswer(current) || goalHeldForOwnerGrant(current))) return false;
    if (liveLongRunAttemptCount(input.runId)) return false;
    const now = new Date().toISOString();
    const changed = db.prepare(`UPDATE long_runs SET status='queued', pause_reason=NULL, blocked_reason=NULL, paused_at=NULL,
      app_instance_id=COALESCE(?, app_instance_id), updated_at=?, version=version+1 WHERE id=? AND status='waiting_tool' AND version=?`)
      .run(input.appInstanceId ?? null, now, current.id, current.version);
    if (changed.changes !== 1) return false;
    appendEventInDb({ runId: current.id, kind: "run.status_changed", actorKind: "user",
      payload: { from: "waiting_tool", to: "queued", reason: "user-resume", heldFor: current.blockedReason }, at: now });
    return true;
  }).immediate();
  if (!queued) return null;
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  return getLongRun(input.runId);
}

/** Delay of the first retry after the app (re)started: a restart changes what failed before (runtime, login,
 * update), so one prompt look is owed. Later failures of the same launch back off normally. */
export const BLOCKED_GOAL_STARTUP_RETRY_MS = 30_000;

/** Backoff for the next automatic retry: 5 min doubling, capped at 6 h. It counts only the failures this run
 * has had since its last success (a settled completed turn or an owner control) within 24 h. A resume that
 * worked is not a failure: counting it made every healthy Goal that resumes every few minutes sit at the 6 h
 * cap after a single restart (measured 2026-10-03: retryIndex 70 on a 37-cycle Goal, 751 on a spinning one).
 * Carried copies of an existing retry never count either — they re-write the same schedule; so does a retry pulled forward because
 * a relay waits for the Goal's next turn (invocation/parked-relay-delivery.ts): it moves the same retry earlier, it is no failure.
 * The owner's authority being (re)established also starts a fresh count: an adopted grant (run.goal_revision_bound) or
 * a status change the owner made (Resume/Start). Retries before it stood on a host cause that is now gone; counting them
 * put the Yotube Goal's next retry 5 h 20 min out right after 1.3.64 resumed it (2026-10-17: six goal_owner_grant_unrecorded
 * retries before the grant was adopted at 14:39Z; a W7 copy then failed once and was scheduled at retryIndex 6). */
export function nextBlockedGoalRetrySlot(runId: string, now = Date.now(),
  options: { startup?: boolean } = {}): { retryIndex: number; nextAt: string } {
  const since = new Date(now - 24 * 60 * 60_000).toISOString();
  const success = getDb().prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM long_run_events WHERE run_id = ? AND (
      (kind = 'worker.attempt_settled' AND json_extract(payload_json, '$.state') = 'completed') OR kind = 'run.user_control'
      OR kind = 'run.goal_revision_bound' OR (kind = 'run.status_changed' AND actor_kind = 'user'))`)
    .get(runId) as { seq: number };
  const prior = getDb().prepare(`SELECT COUNT(*) AS n FROM long_run_events WHERE run_id = ? AND kind = ? AND seq > ? AND occurred_at > ?
    AND json_extract(payload_json, '$.action') = 'retry_scheduled'
    AND COALESCE(json_extract(payload_json, '$.detail'), '') NOT IN ('host_pause_carried_retry', 'parked_relay_pull_forward')`)
    .get(runId, BLOCKED_GOAL_SWEEP_EVENT_KIND, success.seq, since) as { n: number };
  const retryIndex = prior.n;
  const backoffMs = Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.min(retryIndex, 10));
  const delayMs = options.startup && retryIndex === 0 ? BLOCKED_GOAL_STARTUP_RETRY_MS : backoffMs;
  return { retryIndex, nextAt: new Date(now + delayMs).toISOString() };
}

/** The retry came due: put back the exact blocker it stood in for, so the same (observation/resume) decision runs again. */
export function reopenDueBlockedGoalRetry(runId: string, expectedVersion: number): LongRunRecord {
  if (longRunOwnerHold(runId)) throw new Error(LONG_RUN_OWNER_HOLD_CODE);
  const db = getDb();
  db.transaction(() => {
    const current = getLongRun(runId);
    const retry = current ? pendingBlockedGoalRetry(runId) : null;
    if (!current || !retry || current.version !== expectedVersion) throw new Error("blocked_goal_retry_state_changed");
    const now = new Date().toISOString();
    const reason = retry.fromReason ?? "blocked_goal_retry_due";
    const changed = db.prepare(`UPDATE long_runs SET status='queued', pause_reason=NULL, blocked_reason=NULL,
      paused_at=NULL, updated_at=?, version=version+1 WHERE id=? AND status=? AND version=?`)
      .run(now, runId, current.status, expectedVersion);
    if (changed.changes !== 1) throw new Error("blocked_goal_retry_state_changed");
    appendEventInDb({ runId, kind: "run.status_changed", actorKind: "host",
      payload: { from: current.status, to: "queued", skippedStatus: "blocked", reason, retryDue: true, retryIndex: retry.retryIndex }, at: now });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: runId });
  const next = getLongRun(runId);
  if (!next) throw new Error("blocked_goal_retry_readback_failed");
  return next;
}

/**
 * Which budget of this run is spent, if any. The same three limits the message path refuses on
 * (service.ts "budget" stall) — one answer for every way back in.
 */
export function longRunBudgetExhaustion(run: LongRunRecord, now = Date.now()): string | null {
  // Limits remain available for accounting/UI; they do not stop the Goal loop.
  void run; void now;
  return null;
}

/** Historical diagnostic code retained for existing clients. Budget accounting is advisory. */
export const LONG_RUN_BUDGET_EXHAUSTED_CODE = "long_run_budget_exhausted";

export function resumeLongRunByUser(runId: string, appInstanceId: string, expectedVersion: number): LongRunRecord {
  const current = getLongRun(runId);
  if (!current) throw new Error(`long_run_not_found:${runId}`);
  if (current.surface === "science") throw new Error("science_projection_read_only");
  if (current.version !== expectedVersion) throw new Error("long_run_resume_version_conflict");
  if (!["paused", "blocked", "queued", "running", "waiting_tool", "verifying", "waiting_user"].includes(current.status)) {
    throw new Error(`long_run_resume_not_allowed:${current.status}`);
  }
  if (liveLongRunAttemptCount(runId)) throw new Error("auto_goal_resume_attempt_live");
  return transitionLongRun({
    runId,
    to: ["running", "waiting_tool", "verifying", "waiting_user"].includes(current.status) ? "running" : "queued",
    actorKind: "user",
    reason: "user-resume",
    appInstanceId,
    expectedVersion,
  });
}

export function addLongRunTask(input: {
  runId: string;
  id?: string;
  parentTaskId?: string | null;
  title: string;
  objective: string;
  acceptanceCriteria?: readonly string[];
  dependencyIds?: readonly string[];
  criterionIndices?: readonly number[];
  attemptLimit?: number | null;
  sortOrder?: number;
}): LongRunTaskRecord {
  if (!getLongRun(input.runId)) throw new Error(`long_run_not_found:${input.runId}`);
  const id = input.id?.trim() || `task_${randomUUID()}`;
  const title = requiredText(input.title, "long_run_task_title_required", 240);
  const objective = requiredContent(input.objective, "long_run_task_objective_required");
  const criteria = normalizeLongRunCriteria(input.acceptanceCriteria ?? []);
  const dependencies = Array.from(new Set((input.dependencyIds ?? []).map((value) => value.trim()).filter(Boolean)));
  const criterionIndices = Array.from(new Set((input.criterionIndices ?? [])
    .filter((value) => Number.isSafeInteger(value) && value >= 0))).sort((a, b) => a - b);
  const now = new Date().toISOString();
  const db = getDb();
  const existing = db.prepare("SELECT * FROM long_run_tasks WHERE run_id = ? AND id = ?")
    .get(input.runId, id) as LongRunTaskRow | undefined;
  if (existing) {
    if (
      existing.parent_task_id !== (input.parentTaskId ?? null)
      || existing.title !== title
      || existing.objective !== objective
    ) {
      throw new Error("long_run_task_id_conflict");
    }
    return rowToLongRunTask(existing);
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO long_run_tasks (
        run_id, id, parent_task_id, title, objective, acceptance_criteria_json,
        dependency_ids_json, criterion_indices_json, state, attempt_limit,
        sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
    ).run(
      input.runId,
      id,
      input.parentTaskId ?? null,
      title,
      objective,
      JSON.stringify(criteria),
      JSON.stringify(dependencies),
      JSON.stringify(criterionIndices),
      input.attemptLimit ?? null,
      Math.floor(input.sortOrder ?? 0),
      now,
      now,
    );
    appendEventInDb({
      runId: input.runId,
      kind: "task.created",
      actorKind: "host",
      payload: { taskId: id, parentTaskId: input.parentTaskId ?? null },
      at: now,
    });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  const task = getDb().prepare("SELECT * FROM long_run_tasks WHERE run_id = ? AND id = ?")
    .get(input.runId, id) as LongRunTaskRow | undefined;
  if (!task) throw new Error("long_run_task_create_readback_failed");
  return rowToLongRunTask(task);
}

export function listLongRunTasks(runId: string, openOnly = false): LongRunTaskRecord[] {
  const states = [...LONG_RUN_OPEN_TASK_STATES];
  const rows = getDb().prepare(
    `SELECT * FROM long_run_tasks WHERE run_id = ?
     ${openOnly ? `AND state IN (${states.map(() => "?").join(",")})` : ""}
     ORDER BY sort_order, created_at, id`,
  ).all(runId, ...(openOnly ? states : [])) as LongRunTaskRow[];
  return rows.map(rowToLongRunTask);
}

export function setLongRunTaskState(input: {
  runId: string;
  taskId: string;
  state: LongRunTaskState;
  evidenceRef?: string | null;
  blockedReason?: string | null;
  assignedWorkerId?: string | null;
  actorKind?: "host" | "user" | "worker" | "runtime" | "tool" | "system";
  actorId?: string | null;
  authority?: "generic" | "science-projection";
}): LongRunTaskRecord {
  const run = getLongRun(input.runId);
  if (!run) throw new Error(`long_run_not_found:${input.runId}`);
  if (run.surface === "science" && input.authority !== "science-projection") {
    throw new Error("science_projection_read_only");
  }
  const db = getDb();
  const current = db.prepare("SELECT * FROM long_run_tasks WHERE run_id = ? AND id = ?")
    .get(input.runId, input.taskId) as LongRunTaskRow | undefined;
  if (!current) throw new Error(`long_run_task_not_found:${input.taskId}`);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE long_run_tasks
       SET state = ?, evidence_ref = ?, blocked_reason = ?,
           assigned_worker_id = COALESCE(?, assigned_worker_id), updated_at = ?, completed_at = ?
       WHERE run_id = ? AND id = ?`,
    ).run(
      input.state,
      input.evidenceRef ?? current.evidence_ref,
      input.state === "blocked" ? input.blockedReason?.slice(0, 500) ?? "blocked" : null,
      input.assignedWorkerId ?? null,
      now,
      ["completed", "failed", "cancelled"].includes(input.state) ? now : null,
      input.runId,
      input.taskId,
    );
    appendEventInDb({
      runId: input.runId,
      kind: "task.status_changed",
      actorKind: input.actorKind ?? "host",
      actorId: input.actorId,
      payload: { taskId: input.taskId, from: current.state, to: input.state },
      at: now,
    });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  const row = db.prepare("SELECT * FROM long_run_tasks WHERE run_id = ? AND id = ?")
    .get(input.runId, input.taskId) as LongRunTaskRow;
  return rowToLongRunTask(row);
}

export function bindLongRunWorker(input: Omit<LongRunWorkerBinding, "attempt" | "state"> & {
  state?: LongRunWorkerState;
}): LongRunWorkerBinding {
  const run = getLongRun(input.runId);
  if (!run) throw new Error(`long_run_not_found:${input.runId}`);
  if (run.surface === "science") throw new Error("science_projection_read_only");
  // Native Main adapters all resolve an absent request cwd through the same
  // agentRunCwd() function. Persist that concrete path when the controller is
  // bound so a no-folder One run has an exact producer workspace after restart.
  // Host-managed/in-process adapters stay null: their implicit process cwd is
  // not a workspace receipt and must not gain replay authority by inference.
  const defaultWorkspaceKinds = new Set(["antigravity", "claude-code", "codex", "acp", "kimi", "grok", "cursor"]);
  const workspaceBinding: LongRunWorkspaceBinding = input.role === "controller"
    && !input.workspaceBinding.cwd && defaultWorkspaceKinds.has(input.runtimeSelection.kind)
    ? { ...input.workspaceBinding, cwd: agentRunCwd() }
    : input.workspaceBinding;
  const existing = getDb().prepare(
    `SELECT run_id, parent_worker_id, task_id, role, agent_definition_id,
            current_attempt, state
     FROM long_run_workers WHERE id = ?`,
  ).get(input.workerId) as {
    run_id: string;
    parent_worker_id: string | null;
    task_id: string | null;
    role: LongRunWorkerRole;
    agent_definition_id: string | null;
    current_attempt: number;
    state: LongRunWorkerState;
  } | undefined;
  if (existing) {
    if (
      existing.run_id !== input.runId
      || existing.parent_worker_id !== input.parentWorkerId
      || existing.task_id !== input.taskId
      || existing.role !== input.role
      || existing.agent_definition_id !== input.agentDefinitionId
    ) {
      throw new Error("long_run_worker_id_conflict");
    }
    const now = new Date().toISOString();
    getDb().prepare(
      `UPDATE long_run_workers
       SET agent_release_json = ?, runtime_selection_json = ?, capability_descriptor_id = ?,
           workspace_binding_json = ?, permission_profile = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.agentRelease ? JSON.stringify(input.agentRelease) : null,
      JSON.stringify(input.runtimeSelection),
      input.runtimeSelection.capabilityDescriptorId ?? null,
      JSON.stringify(workspaceBinding),
      input.permissionProfile,
      now,
      input.workerId,
    );
    return { ...input, workspaceBinding, attempt: existing.current_attempt, state: existing.state };
  }
  if (input.parentWorkerId) {
    const parent = getDb().prepare("SELECT run_id FROM long_run_workers WHERE id = ?")
      .get(input.parentWorkerId) as { run_id: string } | undefined;
    if (!parent || parent.run_id !== input.runId) throw new Error("long_run_parent_worker_invalid");
  }
  const now = new Date().toISOString();
  const state = input.state ?? "provisioning";
  getDb().prepare(
    `INSERT INTO long_run_workers (
      id, run_id, parent_worker_id, task_id, role, agent_definition_id,
      agent_release_json, runtime_selection_json, capability_descriptor_id,
      workspace_binding_json, permission_profile, state, current_attempt,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    input.workerId,
    input.runId,
    input.parentWorkerId,
    input.taskId,
    input.role,
    input.agentDefinitionId,
    input.agentRelease ? JSON.stringify(input.agentRelease) : null,
    JSON.stringify(input.runtimeSelection),
    input.runtimeSelection.capabilityDescriptorId ?? null,
    JSON.stringify(workspaceBinding),
    input.permissionProfile,
    state,
    now,
    now,
  );
  appendLongRunEvent({
    runId: input.runId,
    kind: "worker.bound",
    actorKind: "host",
    payload: { workerId: input.workerId, parentWorkerId: input.parentWorkerId, role: input.role },
  });
  if (input.taskId) {
    setLongRunTaskState({
      runId: input.runId,
      taskId: input.taskId,
      state: "waiting_worker",
      assignedWorkerId: input.workerId,
    });
  }
  return {
    ...input,
    workspaceBinding,
    attempt: 0,
    state,
  };
}

export function startLongRunWorkerAttempt(input: {
  runId: string;
  workerId: string;
  taskId?: string | null;
  invocationRunId?: string | null;
  runtimeSelection: LongRunRuntimeSelection;
  appInstanceId?: string | null;
}): { attemptId: string; attempt: number } {
  const run = getLongRun(input.runId);
  if (!run) throw new Error(`long_run_not_found:${input.runId}`);
  if (run.surface === "science") throw new Error("science_projection_read_only");
  const db = getDb();
  let attempt = 0;
  const attemptId = `attempt_${randomUUID()}`;
  const now = new Date().toISOString();
  db.transaction(() => {
    const worker = db.prepare("SELECT run_id, current_attempt, role FROM long_run_workers WHERE id = ?")
      .get(input.workerId) as { run_id: string; current_attempt: number; role: string } | undefined;
    if (!worker || worker.run_id !== input.runId) throw new Error("long_run_worker_not_found");
    if (db.prepare("SELECT 1 FROM long_run_worker_attempts WHERE worker_id=? AND state='running' LIMIT 1")
      .get(input.workerId)) throw new Error("long_run_worker_attempt_live");
    attempt = worker.current_attempt + 1;
    const claimed = db.prepare(`UPDATE long_run_workers SET current_attempt=?,state='running',last_heartbeat_at=?,updated_at=?
      WHERE id=? AND run_id=? AND current_attempt=?`).run(attempt, now, now, input.workerId, input.runId, worker.current_attempt);
    if (claimed.changes !== 1) throw new Error("long_run_worker_attempt_claim_lost");
    db.prepare(
      `INSERT INTO long_run_worker_attempts (
        id, worker_id, run_id, task_id, invocation_run_id, attempt, state, runtime_selection_json,
        app_instance_id, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(
      attemptId,
      input.workerId,
      input.runId,
      input.taskId ?? null,
      input.invocationRunId ?? null,
      attempt,
      JSON.stringify(input.runtimeSelection),
      input.appInstanceId ?? null,
      now,
      now,
    );
    if (input.taskId && worker.role !== "verifier") {
      db.prepare(
        `UPDATE long_run_tasks
         SET state = 'doing', attempt_count = attempt_count + 1,
             assigned_worker_id = ?, updated_at = ?
         WHERE run_id = ? AND id = ?`,
      ).run(input.workerId, now, input.runId, input.taskId);
    }
    appendEventInDb({
      runId: input.runId,
      kind: "worker.attempt_started",
      actorKind: "host",
      payload: { workerId: input.workerId, attemptId, attempt, taskId: input.taskId ?? null },
      at: now,
    });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  return { attemptId, attempt };
}

export function settleLongRunWorkerAttempt(input: {
  attemptId: string;
  state: Exclude<LongRunAttemptState, "running">;
  nativeCoordinate?: { kind: string; id: string } | null;
  continuityCapsule?: ContinuityCapsule | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT a.run_id, a.worker_id, a.task_id, a.state, a.attempt, w.role FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id=a.worker_id WHERE a.id = ?",
  ).get(input.attemptId) as { run_id: string; worker_id: string; task_id: string | null; state: string; attempt: number; role: string } | undefined;
  if (!row) return false;
  if (row.state !== "running") return row.state === input.state;
  const now = new Date().toISOString();
  db.transaction(() => {
    const changed = db.prepare(
      `UPDATE long_run_worker_attempts
       SET state = ?, native_coordinate_json = ?, continuity_capsule_json = ?,
           side_effect_state = ?, error_code = ?, error_message = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND state = 'running'`,
    ).run(
      input.state,
      input.nativeCoordinate ? JSON.stringify(input.nativeCoordinate) : null,
      input.continuityCapsule ? JSON.stringify(input.continuityCapsule) : null,
      "none", // legacy column; the host no longer classifies outside effects (owner 2026-10-12)
      input.errorCode?.slice(0, 120) ?? null,
      input.errorMessage?.slice(0, 1_000) ?? null,
      now,
      now,
      input.attemptId,
    );
    if (changed.changes !== 1) return;
    const workerState: LongRunWorkerState = input.state === "completed"
      ? "completed"
      : input.state === "interrupted"
        ? "interrupted"
        : input.state === "cancelled"
          ? "cancelled"
          : "failed";
    const workerUpdated = db.prepare("UPDATE long_run_workers SET state = ?, updated_at = ? WHERE id = ? AND current_attempt = ?")
      .run(workerState, now, row.worker_id, row.attempt);
    if (workerUpdated.changes === 1 && row.task_id && row.role !== "verifier") {
      const taskState: LongRunTaskState = input.state === "completed"
        ? "verifying"
        : input.state === "cancelled"
          ? "cancelled"
          : input.state === "interrupted"
            ? "todo"
            : "failed";
      db.prepare(
        `UPDATE long_run_tasks SET state = ?, updated_at = ?, completed_at = ?
         WHERE run_id = ? AND id = ? AND assigned_worker_id = ? AND state NOT IN ('completed','cancelled')`,
      ).run(
        taskState,
        now,
        ["cancelled", "failed"].includes(taskState) ? now : null,
        row.run_id,
        row.task_id,
        row.worker_id,
      );
    }
    appendEventInDb({
      runId: row.run_id,
      kind: "worker.attempt_settled",
      actorKind: "runtime",
      actorId: row.worker_id,
      payload: { attemptId: input.attemptId, state: input.state },
      at: now,
    });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: row.run_id });
  return true;
}

export function enqueueLongRunMessage(input: {
  messageId?: string;
  runId: string;
  fromWorkerId: string;
  toWorkerId: string;
  kind: LongRunMessageKind;
  bodyRef: string;
  artifactRefs?: readonly string[];
}): string {
  const id = input.messageId?.trim() || `message_${randomUUID()}`;
  if (!/^message_[a-zA-Z0-9._:-]{1,240}$/.test(id)) throw new Error("long_run_message_id_invalid");
  const now = new Date().toISOString();
  const refs = Array.from(new Set((input.artifactRefs ?? []).map((value) => value.trim()).filter(Boolean)));
  const db = getDb();
  db.transaction(() => {
    const existing = db.prepare(
      "SELECT run_id, from_worker_id, to_worker_id, kind, body_ref FROM long_run_messages WHERE id = ?",
    ).get(id) as {
      run_id: string;
      from_worker_id: string;
      to_worker_id: string;
      kind: string;
      body_ref: string;
    } | undefined;
    if (existing) {
      if (existing.run_id !== input.runId || existing.from_worker_id !== input.fromWorkerId
        || existing.to_worker_id !== input.toWorkerId || existing.kind !== input.kind
        || existing.body_ref !== input.bodyRef) {
        throw new Error("long_run_message_id_conflict");
      }
      return;
    }
    db.prepare(
      `INSERT INTO long_run_messages (
        id, run_id, from_worker_id, to_worker_id, kind, body_ref,
        artifact_refs_json, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      id,
      input.runId,
      input.fromWorkerId,
      input.toWorkerId,
      input.kind,
      requiredText(input.bodyRef, "long_run_message_body_ref_required", 2_000),
      JSON.stringify(refs),
      now,
    );
    appendEventInDb({
      runId: input.runId,
      kind: "worker.message_queued",
      actorKind: "worker",
      actorId: input.fromWorkerId,
      payload: { messageId: id, toWorkerId: input.toWorkerId, kind: input.kind },
      at: now,
    });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  return id;
}

export function settleLongRunMessage(input: {
  messageId: string;
  state: "delivered" | "acknowledged" | "failed" | "cancelled";
}): boolean {
  const now = new Date().toISOString();
  const db = getDb();
  const row = db.prepare("SELECT run_id, state FROM long_run_messages WHERE id = ?")
    .get(input.messageId) as { run_id: string; state: string } | undefined;
  if (!row) return false;
  const result = db.transaction(() => {
    const changed = db.prepare(
      `UPDATE long_run_messages
       SET state = ?, delivered_at = CASE WHEN ? IN ('delivered','acknowledged') THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
           acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE acknowledged_at END
       WHERE id = ? AND state IN ('queued','delivered')`,
    ).run(input.state, input.state, now, input.state, now, input.messageId);
    if (changed.changes === 1) {
      appendEventInDb({
        runId: row.run_id,
        kind: "worker.message_settled",
        actorKind: "host",
        payload: { messageId: input.messageId, from: row.state, to: input.state },
        at: now,
      });
    }
    return changed;
  }).immediate();
  if (result.changes === 1) emitDesktopStoreChange({ entity: "long-run", id: row.run_id });
  return result.changes === 1;
}

export function getLongRunGoalRevisionBinding(runId: string): { revision: number; receiptCursor: number } | null {
  const row = getDb().prepare(`SELECT payload_json FROM long_run_events
    WHERE run_id = ? AND kind = 'run.goal_revision_bound' ORDER BY seq DESC LIMIT 1`).get(runId) as
    { payload_json: string } | undefined;
  if (!row) return null;
  const value = JSON.parse(row.payload_json) as { revision: number; receiptCursor: number };
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.receiptCursor) || value.receiptCursor < 0) {
    throw new Error("long_run_goal_revision_binding_invalid");
  }
  return value;
}

function goalRevisionIsCurrent(run: LongRunRecord): boolean {
  const goal = getChatGoalRevision(run.goalId);
  const binding = getLongRunGoalRevisionBinding(run.id);
  return goal ? getChatGoalContract(run.goalId)?.status === "active" && binding?.revision === goal.revision : binding === null;
}

/** Complete proof for a finite Goal, never a partial or earlier verifier round.
 * Read again inside any settlement transaction: revision bindings, receipts and
 * canonical reference ownership can change after a caller prepares its input. */
export function currentCompleteGoalVerificationEvidence(runId: string): { refs: string[]; receiptIds: string[] } | null {
  const run = getLongRun(runId);
  if (!run || run.surface === "science" || !goalRevisionIsCurrent(run) || !run.acceptanceCriteria.length) return null;
  const goal = getChatGoalRevision(run.goalId), binding = getLongRunGoalRevisionBinding(runId);
  if (!goal || !binding || goal.lifecycle === "ongoing" || goal.chatId !== run.rootChatId) return null;
  if (!require("../long-run/goal-obligation-context").currentGoalObligationsSatisfied(run.goalId)) return null;
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  if (normalize(goal.objective) !== normalize(run.objective)
    || goal.acceptanceCriteria.length !== run.acceptanceCriteria.length
    || goal.acceptanceCriteria.some((criterion, index) => normalize(criterion.text) !== normalize(run.acceptanceCriteria[index]))) return null;
  if (listLongRunTasks(runId, true).length > 0) return null;
  const db = getDb();
  const newest = db.prepare(`SELECT verifier_worker_id FROM long_run_verification_receipts
    WHERE run_id = ? AND rowid > ? ORDER BY rowid DESC LIMIT 1`).get(runId, binding.receiptCursor) as
    { verifier_worker_id: string | null } | undefined;
  if (!newest?.verifier_worker_id) return null;
  const latestVerifier = db.prepare(`SELECT a.worker_id FROM long_run_worker_attempts a
    JOIN long_run_workers w ON w.id = a.worker_id WHERE a.run_id = ? AND w.role = 'verifier'
    ORDER BY a.rowid DESC LIMIT 1`).get(runId) as { worker_id: string } | undefined;
  const unsettled = db.prepare("SELECT COUNT(*) AS n FROM long_run_worker_attempts WHERE run_id = ? AND state IN ('running','uncertain')")
    .get(runId) as { n: number };
  if (latestVerifier?.worker_id !== newest.verifier_worker_id || unsettled.n > 0) return null;
  const worker = db.prepare("SELECT run_id, role, permission_profile FROM long_run_workers WHERE id = ?")
    .get(newest.verifier_worker_id) as { run_id: string; role: string; permission_profile: string } | undefined;
  const attempt = db.prepare(`SELECT id, state FROM long_run_worker_attempts
    WHERE run_id = ? AND worker_id = ? ORDER BY rowid DESC LIMIT 1`).get(runId, newest.verifier_worker_id) as
    { id: string; state: string } | undefined;
  if (worker?.run_id !== runId || worker.role !== "verifier" || worker.permission_profile !== "read-only-verification"
    || attempt?.state !== "completed" || getLongRunAttemptGoalRevision(runId, attempt.id) !== binding.revision) return null;
  const rows = db.prepare(`SELECT id, criterion_index, verdict, evidence_refs_json, artifact_refs_json
    FROM long_run_verification_receipts WHERE run_id = ? AND rowid > ? AND verifier_worker_id = ? ORDER BY rowid DESC`)
    .all(runId, binding.receiptCursor, newest.verifier_worker_id) as Array<{
      id: string; criterion_index: number; verdict: string; evidence_refs_json: string; artifact_refs_json: string;
    }>;
  const latest = new Map<number, typeof rows[number]>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.criterion_index) || row.criterion_index < 0 || row.criterion_index >= run.acceptanceCriteria.length) return null;
    if (!latest.has(row.criterion_index)) latest.set(row.criterion_index, row);
  }
  const refs = new Set<string>(), receiptIds: string[] = [];
  for (let index = 0; index < run.acceptanceCriteria.length; index += 1) {
    const row = latest.get(index);
    if (!row || row.verdict !== "passed") return null;
    let evidenceRefs: unknown, artifactRefs: unknown;
    try { evidenceRefs = JSON.parse(row.evidence_refs_json); artifactRefs = JSON.parse(row.artifact_refs_json); }
    catch { return null; }
    if (!Array.isArray(evidenceRefs) || !Array.isArray(artifactRefs)
      || [...evidenceRefs, ...artifactRefs].some(ref => typeof ref !== "string" || !ref.trim())) return null;
    if (!verificationReferencesResolve(run, { evidenceRefs, artifactRefs })) return null;
    for (const ref of [...evidenceRefs, ...artifactRefs] as string[]) refs.add(ref);
    receiptIds.push(row.id);
  }
  return { refs: [...refs], receiptIds };
}

/** Apply a user-authored revision only after work has stopped. Old tasks and
 * receipts remain audit records; none count toward the new contract.
 */
/**
 * `allowIdleWaiting`: the caller has checked that nothing is in flight for this Goal (no running/uncertain
 * attempt — re-checked here —, no effect observation, no live turn in its chat). A run parked in waiting_tool
 * for a scheduled retry or wait is then at a turn boundary as much as a paused one: the next dispatched turn
 * reads the bound revision.
 */
export function bindCurrentGoalRevisionToLongRun(runId: string, expectedVersion: number, opts?: { allowIdleWaiting?: boolean; allowIdleActive?: boolean }): LongRunRecord {
  const db = getDb();
  db.transaction(() => {
    const run = getLongRun(runId);
    if (!run || run.surface === "science") throw new Error("long_run_goal_binding_not_allowed");
    const goal = getChatGoalRevision(run.goalId);
    if (!goal || goal.chatId !== run.rootChatId) throw new Error("long_run_goal_chat_mismatch");
    if (getChatGoalContract(run.goalId)?.status !== "active") throw new Error("long_run_goal_contract_not_active");
    const binding = getLongRunGoalRevisionBinding(runId);
    if (binding?.revision === goal.revision) return;
    if (run.version !== expectedVersion) throw new Error("long_run_goal_binding_version_conflict");
    const stops = opts?.allowIdleActive ? ["draft", "queued", "running", "verifying", "paused", "blocked", "waiting_user", "waiting_tool", "waiting_worker"] : opts?.allowIdleWaiting ? ["draft", "queued", "paused", "blocked", "waiting_user", "waiting_tool"]
      : ["draft", "queued", "paused", "blocked", "waiting_user"];
    if (!stops.includes(run.status)) throw new Error("long_run_goal_binding_requires_stop");
    if (liveLongRunAttemptCount(runId) > 0) throw new Error("long_run_goal_binding_attempt_live");
    const objective = goal.objective.replace(/\s+/g, " ").trim();
    const criteria = goal.acceptanceCriteria.map((criterion) => criterion.text.replace(/\s+/g, " ").trim());
    const now = new Date().toISOString();
    const cursor = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM long_run_verification_receipts WHERE run_id = ?")
      .get(runId) as { n: number };
    db.prepare(`UPDATE long_run_tasks SET state = 'cancelled', updated_at = ?, completed_at = ?
      WHERE run_id = ? AND state NOT IN ('completed','cancelled','failed')`).run(now, now, runId);
    db.prepare(`UPDATE long_runs SET objective = ?, acceptance_criteria_json = ?, updated_at = ?, version = version + 1
      WHERE id = ?`).run(objective, JSON.stringify(criteria), now, runId);
    addLongRunTask({ runId, id: `task:goal-revision:${goal.revision}`, title: objective.slice(0, 240), objective,
      acceptanceCriteria: criteria, criterionIndices: criteria.map((_, index) => index) });
    appendEventInDb({ runId, kind: "run.goal_revision_bound", actorKind: "host", at: now,
      payload: { revision: goal.revision, previousRevision: binding?.revision ?? null, receiptCursor: cursor.n,
        sourceMessageId: goal.sourceMessage.messageId } });
  }).immediate();
  const run = getLongRun(runId);
  if (!run) throw new Error("long_run_goal_binding_readback_failed");
  emitDesktopStoreChange({ entity: "long-run", id: runId });
  return run;
}

function latestCriterionVerdicts(runId: string): Map<number, { taskId: string | null; verdict: string; evidenceRefs: string[]; artifactRefs: string[] }> {
  const binding = getLongRunGoalRevisionBinding(runId);
  const episode = getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.ongoing_cycle_verified' ORDER BY seq DESC LIMIT 1")
    .get(runId) as { payload_json: string } | undefined;
  const episodeCursor = episode ? JSON.parse(episode.payload_json).receiptCursor : 0;
  const rows = getDb().prepare(
    `SELECT task_id, criterion_index, verdict, evidence_refs_json, artifact_refs_json
     FROM long_run_verification_receipts
     WHERE run_id = ? AND rowid > ? ORDER BY created_at DESC, rowid DESC`,
  ).all(runId, Math.max(binding?.receiptCursor ?? 0, Number.isSafeInteger(episodeCursor) ? episodeCursor : 0)) as Array<{
    task_id: string | null;
    criterion_index: number;
    verdict: string;
    evidence_refs_json: string;
    artifact_refs_json: string;
  }>;
  const result = new Map<number, { taskId: string | null; verdict: string; evidenceRefs: string[]; artifactRefs: string[] }>();
  for (const row of rows) {
    if (result.has(row.criterion_index)) continue;
    result.set(row.criterion_index, {
      taskId: row.task_id,
      verdict: row.verdict,
      evidenceRefs: stringArray(row.evidence_refs_json),
      artifactRefs: stringArray(row.artifact_refs_json),
    });
  }
  return result;
}

/** Resolve required canonical links again at the durable write/complete boundary.
 * The verifier owns semantic and file-integrity checks; a dangling or foreign
 * ledger reference cannot survive those checks as a reusable passed receipt.
 * Science resolves its own references before projecting its signed receipt set. */
function verificationReferencesResolve(run: LongRunRecord, receipt: { evidenceRefs: readonly string[]; artifactRefs: readonly string[] }): boolean {
  const refs = [...receipt.evidenceRefs, ...receipt.artifactRefs];
  if (!refs.length) return false;
  if (run.surface === "science") return true;
  const db = getDb(), binding = getLongRunGoalRevisionBinding(run.id);
  const ownsInvocation = (invocationRunId: string): boolean => {
    const attempts = db.prepare("SELECT id, run_id FROM long_run_worker_attempts WHERE invocation_run_id = ?")
      .all(invocationRunId) as Array<{ id: string; run_id: string }>;
    return attempts.length > 0 && attempts.every(attempt => attempt.run_id === run.id
      && (!binding || getLongRunAttemptGoalRevision(run.id, attempt.id) === binding.revision));
  };
  const eventRow = (id: string) => db.prepare("SELECT run_id, chat_id, seq, kind, payload_json FROM run_events WHERE id = ?")
    .get(id) as { run_id: string; chat_id: string | null; seq: number; kind: string; payload_json: string } | undefined;
  return refs.every(ref => {
    try {
      const event = /^(event|file-proof|download-proof|execution-proof):(.+)$/.exec(ref);
      if (event) {
        const row = eventRow(event[2]);
        if (!row || row.chat_id !== run.rootChatId || (binding && !ownsInvocation(row.run_id))) return false;
        if (event[1] === "event") return true;
        if (event[1] === "execution-proof") {
          if (row.kind !== "runtime_execution_observed" || !binding) return false;
          const payload = JSON.parse(row.payload_json), evidence = decodeRuntimeEvidence(payload.runtimeEvidence);
          const correlation = evidence?.correlation;
          if (payload.schemaVersion !== "agentlas.main-execution-proof.v1"
            || !["time", "native-browser"].includes(payload.contract)
            || typeof payload.tool !== "string" || typeof payload.receiptId !== "string"
            || correlation?.invocationRunId !== row.run_id || correlation.goalId !== run.goalId
            || correlation.goalRevision !== binding.revision || correlation.longRunId !== run.id
            || [payload.scopeStartSeq, payload.scopeEndSeq, payload.toolStartSeq, payload.toolResultSeq]
              .some((value) => !Number.isSafeInteger(value) || value < 0)
            || !(payload.scopeStartSeq < payload.toolStartSeq && payload.toolStartSeq < payload.toolResultSeq
              && payload.toolResultSeq < payload.scopeEndSeq && payload.scopeEndSeq < row.seq)) return false;
          const linked = db.prepare("SELECT run_id, chat_id, seq, kind, payload_json FROM run_events WHERE run_id = ? AND seq IN (?, ?, ?, ?) ORDER BY seq")
            .all(row.run_id, payload.scopeStartSeq, payload.toolStartSeq, payload.toolResultSeq, payload.scopeEndSeq) as Array<{
              run_id: string; chat_id: string | null; seq: number; kind: string; payload_json: string;
            }>;
          if (linked.length !== 4 || linked.some(item => item.chat_id !== row.chat_id)) return false;
          const [scopeStart, toolStart, toolResult, scopeEnd] = linked;
          if (scopeStart.kind !== "runtime_adapter_effect_started" || toolStart.kind !== "mcp_tool-use"
            || toolResult.kind !== "mcp_tool-use" || scopeEnd.kind !== "runtime_adapter_effect_completed") return false;
          const startScope = JSON.parse(scopeStart.payload_json), endScope = JSON.parse(scopeEnd.payload_json);
          const before = JSON.parse(toolStart.payload_json), after = JSON.parse(toolResult.payload_json);
          if (startScope.scopeId !== endScope.scopeId || startScope.rootBound !== true || startScope.chatId !== row.chat_id
            || startScope.adapterKind !== "antigravity" || startScope.purpose !== undefined
            || endScope.report?.complete !== true || endScope.report?.terminal !== "SUCCESS"
            || endScope.report?.protocol !== "agy-stream-json-main-receipts.v2"
            || !Array.isArray(endScope.report.operationIds) || endScope.report.operationIds.filter((id: unknown) => id === before.toolId).length !== 1
            || endScope.report.settledFailureIds?.includes(before.toolId)
            || typeof before.toolId !== "string" || !before.toolId.startsWith(`${startScope.scopeId}:agy-tool:call_mcp_tool:`)
            || before.toolId !== after.toolId || before.toolName !== after.toolName
            || typeof before.toolArgs !== "string" || before.toolArgs !== after.toolArgs
            || typeof before.toolResultPreview === "string" || typeof after.toolResultPreview !== "string" || after.toolIsError !== false
            || !before.toolName.endsWith(`__${payload.tool}`)) return false;
          const hash = (value: string) => createHash("sha256").update(value).digest("hex");
          if (mcpEffectArgumentsDigest(JSON.parse(before.toolArgs)) !== payload.argumentsDigest
            || mcpEffectOutputDigest(after.toolResultPreview) !== payload.outputDigest
            || hash(after.toolResultPreview) !== payload.toolResultDigest
            || typeof payload.toolResultPreview !== "string" || hash(payload.toolResultPreview) !== payload.previewDigest) return false;
          const seals = db.prepare("SELECT seq, payload_json FROM run_events WHERE run_id = ? AND kind = 'runtime_effect_boundary' ORDER BY seq")
            .all(row.run_id) as Array<{ seq: number; payload_json: string }>;
          if (seals.length !== 1 || row.seq >= seals[0].seq) return false;
          const seal = JSON.parse(seals[0].payload_json);
          if (!seal.operations?.some((operation: any) => operation.toolId === before.toolId
            && operation.startObserved === true && operation.resultObserved === true && operation.outcome === "succeeded")
            || !seal.adapterScopes?.some((scope: any) => scope.scopeId === startScope.scopeId
              && scope.rootBound === true && scope.chatId === row.chat_id)) return false;
          const receiptUses = db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE kind = 'runtime_execution_observed' AND json_extract(payload_json, '$.receiptId') = ?")
            .get(payload.receiptId) as { n: number };
          return receiptUses.n === 1;
        }
        if (row.kind !== (event[1] === "file-proof" ? "runtime_file_observed" : "runtime_download_observed")) return false;
        const payload = JSON.parse(row.payload_json);
        if (typeof payload.startEventId !== "string" || typeof payload.resultEventId !== "string"
          || typeof payload.toolId !== "string" || !payload.toolId) return false;
        const start = eventRow(payload.startEventId), result = eventRow(payload.resultEventId);
        if (!start || !result || start.seq >= result.seq || result.seq >= row.seq
          || [start, result].some(tool => tool.kind !== "mcp_tool-use" || tool.run_id !== row.run_id || tool.chat_id !== row.chat_id)) return false;
        const before = JSON.parse(start.payload_json), after = JSON.parse(result.payload_json);
        const toolName = event[1] === "download-proof" ? "browser_download" : payload.toolName;
        if (typeof toolName !== "string" || !toolName || before.toolName !== toolName || after.toolName !== toolName
          || before.toolId !== payload.toolId || after.toolId !== payload.toolId
          || typeof before.toolResultPreview === "string" || typeof after.toolResultPreview !== "string" || after.toolIsError !== false) return false;
        const count = db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND chat_id = ? AND kind = 'mcp_tool-use' AND json_extract(payload_json, '$.toolId') = ?")
          .get(row.run_id, row.chat_id, payload.toolId) as { n: number };
        return count.n === 2;
      }
      const message = /^chat-message:(.+)$/.exec(ref);
      if (message) {
        const row = db.prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(message[1]) as
          { chat_id: string; role: string; text: string } | undefined;
        if (row?.chat_id !== run.rootChatId || row.role !== "assistant" || !row.text.trim()) return false;
        const finals = db.prepare("SELECT DISTINCT run_id FROM run_events WHERE chat_id = ? AND kind = 'mcp_final' AND json_extract(payload_json, '$.durableMessageId') = ?")
          .all(run.rootChatId, message[1]) as Array<{ run_id: string }>;
        return finals.some(final => {
          if (!ownsInvocation(final.run_id)) return false;
          const count = db.prepare(`SELECT COUNT(DISTINCT m.id) AS n FROM run_events e JOIN chat_messages m
            ON m.id = json_extract(e.payload_json, '$.durableMessageId') WHERE e.run_id = ? AND e.chat_id = ?
            AND e.kind = 'mcp_final' AND m.chat_id = ? AND m.role = 'assistant'`)
            .get(final.run_id, run.rootChatId, run.rootChatId) as { n: number };
          return count.n === 1;
        });
      }
      const ledger = /^long-run-event:(.+):([1-9]\d*)$/.exec(ref);
      if (ledger) return ledger[1] === run.id && Number.isSafeInteger(Number(ledger[2]))
        && Boolean(db.prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND seq = ?").get(run.id, Number(ledger[2])));
      const goal = /^goal:(.+):revision:([1-9]\d*)$/.exec(ref);
      if (goal) return goal[1] === run.goalId && Number(goal[2]) === binding?.revision
        && getChatGoalRevision(run.goalId)?.revision === binding.revision;
      const invocation = /^invocation:(.+):completed$/.exec(ref);
      if (invocation) {
        if (!ownsInvocation(invocation[1])) return false;
        const start = db.prepare("SELECT chat_id, seq FROM run_events WHERE run_id = ? AND kind = 'invoke_started' ORDER BY seq LIMIT 1")
          .get(invocation[1]) as { chat_id: string | null; seq: number } | undefined;
        const terminal = db.prepare("SELECT chat_id, seq, kind FROM run_events WHERE run_id = ? AND kind IN ('invoke_completed','mcp_final','invoke_failed','invoke_threw','mcp_error','invoke_cancelled','invoke_interrupted') ORDER BY seq DESC LIMIT 1")
          .get(invocation[1]) as { chat_id: string | null; seq: number; kind: string } | undefined;
        return start?.chat_id === run.rootChatId && terminal?.chat_id === run.rootChatId
          && start.seq < terminal.seq && ["invoke_completed", "mcp_final"].includes(terminal.kind);
      }
      const artifact = /^artifact:(.+):revision:([1-9]\d*)$/.exec(ref);
      if (artifact) {
        if (!Number.isSafeInteger(Number(artifact[2]))) return false;
        const row = db.prepare("SELECT s.chat_id, s.project_id, r.reference_json FROM agent_surface_revisions r JOIN agent_surfaces s ON s.id = r.surface_id WHERE r.surface_id = ? AND r.revision = ?")
          .get(artifact[1], Number(artifact[2])) as { chat_id: string; project_id: string | null; reference_json: string } | undefined;
        if (!row || row.chat_id !== run.rootChatId || row.project_id !== run.projectId) return false;
        const reference = JSON.parse(row.reference_json);
        return reference.artifactId === artifact[1] && reference.revision === Number(artifact[2])
          && reference.owner?.chatId === run.rootChatId && reference.owner?.projectId === run.projectId;
      }
      // Opaque legacy references remain readable. Newly bound Goal contracts
      // require a resolvable typed reference instead of inventing an authority.
      return binding === null;
    } catch { return false; }
  });
}

function maybeCompleteVerifiedTask(runId: string, taskId: string, at: string): void {
  const row = getDb().prepare(
    "SELECT * FROM long_run_tasks WHERE run_id = ? AND id = ?",
  ).get(runId, taskId) as LongRunTaskRow | undefined;
  if (!row || !LONG_RUN_OPEN_TASK_STATES.has(row.state)) return;
  const required = integerArray(row.criterion_indices_json);
  if (required.length === 0) return;
  const run = getLongRun(runId);
  if (!run) return;
  const latest = latestCriterionVerdicts(runId);
  const passed = required.every((index) => {
    const receipt = latest.get(index);
    return receipt?.verdict === "passed" && verificationReferencesResolve(run, receipt);
  });
  if (!passed) return;
  getDb().prepare(
    `UPDATE long_run_tasks
     SET state = 'completed', evidence_ref = 'verification-receipts', updated_at = ?, completed_at = ?
     WHERE run_id = ? AND id = ?`,
  ).run(at, at, runId, taskId);
}

export function recordLongRunVerification(input: {
  runId: string;
  taskId?: string | null;
  criterionIndex: number;
  verifierWorkerId?: string | null;
  verdict: LongRunVerificationVerdict;
  evidenceRefs?: readonly string[];
  artifactRefs?: readonly string[];
  summary: string;
  authority?: "generic" | "science-projection";
  goalRevision?: number;
  background?: boolean;
}): string {
  const run = getLongRun(input.runId);
  if (!run) throw new Error(`long_run_not_found:${input.runId}`);
  const binding = getLongRunGoalRevisionBinding(run.id);
  if (!goalRevisionIsCurrent(run) || (binding && input.goalRevision !== binding.revision)) {
    throw new Error("long_run_verification_goal_revision_conflict");
  }
  if (binding && run.status !== "verifying" && !(input.background && LONG_RUN_ACTIVE_STATUSES.has(run.status) && !longRunOwnerHold(run.id))) throw new Error("long_run_verification_not_active");
  if (run.surface === "science" && input.authority !== "science-projection") {
    throw new Error("science_projection_read_only");
  }
  if (!Number.isSafeInteger(input.criterionIndex) || input.criterionIndex < 0 || input.criterionIndex >= run.acceptanceCriteria.length) {
    throw new RangeError("long_run_criterion_index_invalid");
  }
  const evidenceRefs = Array.from(new Set((input.evidenceRefs ?? []).map((value) => value.trim()).filter(Boolean)));
  const artifactRefs = Array.from(new Set((input.artifactRefs ?? []).map((value) => value.trim()).filter(Boolean)));
  if (input.verdict === "passed" && evidenceRefs.length === 0 && artifactRefs.length === 0) {
    throw new TypeError("long_run_passed_verification_requires_evidence");
  }
  const id = `verify_${randomUUID()}`;
  const now = new Date().toISOString();
  const db = getDb();
  // IMMEDIATE: this reads (and resolves evidence refs) before it writes. Deferred, a daemon commit in between failed
  // the insert with SQLITE_BUSY_SNAPSHOT, which busy_timeout never waits on ("terminal verification failed: database
  // is locked", Yotube room 2026-10-13 18:57Z).
  db.transaction(() => {
    const current = getLongRun(input.runId)!;
    const currentBinding = getLongRunGoalRevisionBinding(input.runId);
    if (!goalRevisionIsCurrent(current) || (currentBinding && (input.goalRevision !== currentBinding.revision || (current.status !== "verifying" && !(input.background && LONG_RUN_ACTIVE_STATUSES.has(current.status) && !longRunOwnerHold(current.id)))))) {
      throw new Error("long_run_verification_goal_revision_conflict");
    }
    if (input.verdict === "passed" && !verificationReferencesResolve(current, { evidenceRefs, artifactRefs })) {
      throw new Error("long_run_verification_reference_unresolved");
    }
    db.prepare(
      `INSERT INTO long_run_verification_receipts (
        id, run_id, task_id, criterion_index, verifier_worker_id, verdict,
        evidence_refs_json, artifact_refs_json, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.runId,
      input.taskId ?? null,
      input.criterionIndex,
      input.verifierWorkerId ?? null,
      input.verdict,
      JSON.stringify(evidenceRefs),
      JSON.stringify(artifactRefs),
      requiredText(input.summary, "long_run_verification_summary_required", 1_000),
      now,
    );
    if (input.taskId) maybeCompleteVerifiedTask(input.runId, input.taskId, now);
    appendEventInDb({
      runId: input.runId,
      kind: "verification.recorded",
      actorKind: input.verifierWorkerId ? "worker" : "host",
      actorId: input.verifierWorkerId,
      payload: { receiptId: id, taskId: input.taskId ?? null, criterionIndex: input.criterionIndex, verdict: input.verdict },
      at: now,
    });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  return id;
}

/**
 * Applies a canonical Science snapshot to its read-only common projection.
 * This deliberately does not use the user-command transition graph: Science
 * has its own OCC/hash state machine and main only mirrors its settled state.
 */
export function applyScienceLongRunProjectionStatus(input: {
  runId: string;
  to: Extract<LongRunStatus,
    "queued" | "running" | "waiting_user" | "verifying" | "pausing" |
    "paused" | "completed" | "failed" | "cancelled">;
  pauseReason?: LongRunPauseReason | null;
  sourceVersion: number;
  sourceStateSha256: string;
}): LongRunRecord {
  const current = getLongRun(input.runId);
  if (!current || current.surface !== "science") throw new Error("science_projection_run_invalid");
  // Science owns execution and pause policy. This read-only projection must
  // preserve its canonical state, including approval waits and failures; the
  // host-owned Goal's nonblocking policy must not relabel them as runnable.
  if (current.status === input.to) return current;
  if (LONG_RUN_TERMINAL_STATUSES.has(current.status)) {
    throw new Error(`science_projection_terminal_conflict:${current.status}->${input.to}`);
  }
  if (input.to === "completed") {
    if (listLongRunTasks(current.id, true).length > 0) throw new Error("science_projection_completion_tasks_open");
    const latest = latestCriterionVerdicts(current.id);
    const allPassed = current.acceptanceCriteria.every((_, index) => {
      const receipt = latest.get(index);
      return receipt?.verdict === "passed" && (receipt.evidenceRefs.length > 0 || receipt.artifactRefs.length > 0);
    });
    if (!allPassed) throw new Error("science_projection_completion_evidence_missing");
  }
  const now = new Date().toISOString();
  const pauseReason = input.to === "paused" ? input.pauseReason ?? "agent_paused" : null;
  const completedAt = LONG_RUN_TERMINAL_STATUSES.has(input.to) ? now : null;
  const db = getDb();
  db.transaction(() => {
    const changed = db.prepare(`UPDATE long_runs SET
      status = ?, pause_reason = ?, blocked_reason = NULL,
      started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
      paused_at = CASE WHEN ? = 'paused' THEN ? ELSE NULL END,
      completed_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND status = ? AND version = ?`).run(
      input.to,
      pauseReason,
      input.to,
      now,
      input.to,
      now,
      completedAt,
      now,
      current.id,
      current.status,
      current.version,
    );
    if (changed.changes !== 1) throw new Error("science_projection_status_conflict");
    appendEventInDb({
      runId: current.id,
      kind: "science.projection_status_changed",
      actorKind: "system",
      actorId: "science-projection",
      payload: {
        from: current.status,
        to: input.to,
        pauseReason,
        sourceVersion: input.sourceVersion,
        sourceStateSha256: input.sourceStateSha256,
      },
      at: now,
    });
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: current.id });
  const next = getLongRun(current.id);
  if (!next) throw new Error("science_projection_status_readback_failed");
  return next;
}

/** Mirror a validated author declaration without issuing any scientific verification receipt. */
export function applyScienceAuthorCompletionProjection(input: ScienceLoopLongRunProjection, owner: {
  hostOwnerKind: "desktop" | "daemon"; appInstanceId?: string; assertOwner?: () => void;
}): LongRunRecord {
  const assertOwner = () => {
    if (owner.hostOwnerKind === "daemon") {
      if (!owner.appInstanceId || typeof owner.assertOwner !== "function") throw new Error("science_projection_owner_invalid");
      owner.assertOwner();
    } else if (owner.hostOwnerKind !== "desktop") throw new Error("science_projection_owner_invalid");
  };
  assertOwner();
  if (!scienceAuthorCompletionProjectionValid(input)) throw new Error("science_projection_author_completion_invalid");
  const db = getDb();
  const result = db.transaction(() => {
    assertOwner();
    const current = getLongRun(scienceLongRunId(input.loopSessionId));
    const binding = current && getLongRunDomainBinding(current.id);
    if (!current || current.surface !== "science" || current.scienceJobId !== input.loopSessionId
      || current.hostOwnerKind !== owner.hostOwnerKind
      || owner.hostOwnerKind === "daemon" && current.appInstanceId !== owner.appInstanceId
      || !binding || binding.projectionStatus !== "current" || binding.domain !== "science" || binding.objectType !== "loop_session"
      || binding.objectId !== input.loopSessionId || binding.externalProjectId !== input.scienceProjectId
      || binding.contractId !== input.contractId || binding.contractVersion !== input.contractVersion
      || binding.contractContentSha256 !== input.contractContentSha256 || binding.objectVersion !== input.sourceVersion
      || binding.stateSha256 !== input.sourceStateSha256 || binding.eventCursor !== input.eventCursor) {
      throw new Error("science_projection_author_completion_binding_invalid");
    }
    if (current.status === "completed") {
      const previous = db.prepare("SELECT payload_json FROM long_run_events WHERE run_id=? AND kind='science.author_completion_projected' ORDER BY seq DESC LIMIT 1")
        .get(current.id) as { payload_json: string } | undefined;
      const payload = previous && JSON.parse(previous.payload_json);
      if (payload?.completionReceiptSetSha256 !== input.completionReceiptSetSha256
        || payload?.authorCompletion?.eventId !== input.authorCompletion?.eventId) throw new Error("science_projection_author_completion_terminal_conflict");
      return current;
    }
    if (LONG_RUN_TERMINAL_STATUSES.has(current.status)) throw new Error("science_projection_author_completion_terminal_conflict");
    if (listLongRunTasks(current.id, true).some(task => task.id !== "task:bootstrap")) {
      throw new Error("science_projection_author_completion_tasks_open");
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE long_run_tasks SET state='completed', evidence_ref=?, blocked_reason=NULL, updated_at=?, completed_at=?
      WHERE run_id=? AND id='task:bootstrap' AND state IN ('todo','doing','waiting_worker','waiting_tool','waiting_user','verifying','blocked')`)
      .run(`science-author-completion:${input.completionReceiptSetSha256}`, now, now, current.id);
    const changed = db.prepare(`UPDATE long_runs SET status='completed', pause_reason=NULL, blocked_reason=NULL,
      completed_at=?, updated_at=?, version=version+1 WHERE id=? AND status=? AND version=?`)
      .run(now, now, current.id, current.status, current.version);
    if (changed.changes !== 1) throw new Error("science_projection_status_conflict");
    appendEventInDb({ runId: current.id, kind: "science.author_completion_projected", actorKind: "system", actorId: "science-projection",
      payload: { from: current.status, to: "completed", completionMeaning: "author-declared", scientificVerification: "unchecked",
        sourceVersion: input.sourceVersion, sourceStateSha256: input.sourceStateSha256,
        completionReceiptSetSha256: input.completionReceiptSetSha256, authorCompletion: input.authorCompletion }, at: now });
    assertOwner();
    return getLongRun(current.id)!;
  }).immediate();
  emitDesktopStoreChange({ entity: "long-run", id: result.id });
  return result;
}

export function tryCompleteVerifiedLongRun(runId: string): boolean {
  const run = getLongRun(runId);
  if (run && getChatGoalRevision(run.goalId)?.lifecycle === "ongoing") return false;
  return settleVerifiedLongRun(runId) === "completed";
}

/** An ongoing mandate verifies episodes, never its own termination. Only the
 * host verifier uses this path; ordinary completion requests remain false. */
export function settleVerifiedLongRun(runId: string, options?: { background?: boolean }): "completed" | "cycle_completed" | null {
  return getDb().transaction(() => {
    const run = getLongRun(runId);
    if (!run || (run.status !== "verifying" && !(options?.background && LONG_RUN_ACTIVE_STATUSES.has(run.status)))) return null;
    if (longRunOwnerHold(run.id) || liveLongRunAttemptCount(run.id)) return null;
    if (run.surface === "science") return null;
    if (!goalRevisionIsCurrent(run)) return null;
    if (!require("../long-run/goal-obligation-context").currentGoalObligationsSatisfied(run.goalId)) return null;
    const latest = latestCriterionVerdicts(runId);
    const unresolved = run.acceptanceCriteria.flatMap((_, index) => {
      const receipt = latest.get(index);
      return receipt?.verdict === "passed" && !verificationReferencesResolve(run, receipt) ? [index] : [];
    });
    if (unresolved.length) {
      const now = new Date().toISOString();
      // Reopen only tasks named by this revision's invalid receipts. Earlier
      // revisions retain their completed audit records, even when indices match.
      const taskIds = new Set(unresolved.map(index => latest.get(index)?.taskId).filter((id): id is string => !!id));
      for (const taskId of taskIds) {
        getDb().prepare("UPDATE long_run_tasks SET state = 'todo', evidence_ref = NULL, completed_at = NULL, updated_at = ? WHERE run_id = ? AND id = ? AND state = 'completed'")
          .run(now, runId, taskId);
      }
      appendEventInDb({ runId, kind: "verification.references_unresolved", actorKind: "host", at: now,
        payload: { criterionIndices: unresolved, goalRevision: getLongRunGoalRevisionBinding(runId)?.revision ?? null } });
      transitionLongRun({ runId, to: "blocked", actorKind: "host", reason: "verification_reference_unresolved" });
      return null;
    }
    if (listLongRunTasks(runId, true).length > 0) return null;
    const allPassed = run.acceptanceCriteria.every((_, index) => {
      const receipt = latest.get(index);
      return receipt?.verdict === "passed";
    });
    if (!allPassed) return null;
    if (getChatGoalRevision(run.goalId)?.lifecycle === "ongoing") {
      const cursor = getDb().prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM long_run_verification_receipts WHERE run_id = ?")
        .get(runId) as { n: number };
      appendEventInDb({ runId, kind: "run.ongoing_cycle_verified", actorKind: "host", at: new Date().toISOString(),
        payload: { receiptCursor: cursor.n, goalRevision: getLongRunGoalRevisionBinding(runId)?.revision } });
      // Legacy Work episodes reset here. One records exactly once after its
      // settled checkpoint; keep the previous fingerprint/streak until that
      // evidence comparison occurs. Consumed cycles and cost stay intact.
      if (!ownsHostGoalLoop(run.surface)) getDb().prepare("UPDATE long_runs SET last_progress_key = NULL, stall_streak = 0 WHERE id = ?").run(runId);
      transitionLongRun({ runId, to: "running", actorKind: "host", reason: "ongoing-cycle-verified" });
      return "cycle_completed";
    }
    if (run.status !== "verifying") transitionLongRun({ runId, to: "verifying", actorKind: "host", reason: "background-verification-settled" });
    transitionLongRun({ runId, to: "completed", actorKind: "host", reason: "all-criteria-verified" });
    return "completed";
  }).immediate();
}

export function longRunContinueDecision(goalId: string, now: Date = new Date()): LongRunContinueDecision | null {
  const run = getLongRunByGoalId(goalId);
  if (!run) return null;
  const openTaskCount = listLongRunTasks(run.id, true).length;
  const decision = (cont: boolean, reason: string): LongRunContinueDecision => ({
    runId: run.id,
    goalId: run.goalId,
    continue: cont,
    reason,
    status: run.status,
    openTaskCount,
    cycleCount: run.cycleCount,
    objective: run.objective,
    blockedReason: run.blockedReason,
    budget: { ...run.budget, costUsedUsd: run.costUsedUsd },
  });
  if (LONG_RUN_TERMINAL_STATUSES.has(run.status)) return decision(false, "goal_terminal");
  if (["cancelling", "pausing"].includes(run.status) || longRunOwnerHold(run.id)
    || (run.status === "paused" && ["user", "app_closed", "crash_recovery"].includes(run.pauseReason ?? ""))) {
    return decision(false, "goal_paused");
  }
  if (run.status === "draft") return decision(false, "goal_draft");
  // A pending receipt, revision, wait, exhausted allowance or empty task list is
  // context for the next planning turn, never proof the user's Goal is finished.
  return decision(true, openTaskCount > 0 ? "open_tasks_remain" : "goal_continue_planning");
}

/** Metered usage changes the accounting ledger, not execution custody. Only a
 * real Main inference-start receipt can use this path; generic events retain
 * their version increment, even if a caller supplies an accounting-like kind. */
export function recordLongRunInferenceStarted(input: {
  goalId: string; sourceId: string; invocationRunId: string; scopeAnchorId: string; attemptId: string | null;
}): void {
  const db = getDb();
  let changedRunId: string | null = null;
  db.transaction(() => {
    const run = getLongRunByGoalId(input.goalId);
    const source = db.prepare(`SELECT ts,payload_json FROM run_events WHERE run_id=?
      AND kind='runtime_usage_started'
      AND json_extract(payload_json,'$.runtimeEvidence.sourceEventId')=? LIMIT 1`)
      .get(input.invocationRunId, `${input.sourceId}:started`) as { ts: string; payload_json: string } | undefined;
    const payload = source ? JSON.parse(source.payload_json) : null;
    // Which check failed, so the next occurrence names its cause (production 1.3.57, 2026-10-17 05:40:15: one goal-wake
    // tool selection threw this once; the stored copy of its source id had been masked as a Telegram token, now kept exact
    // by run-events.ts canonicalInferenceSourceId).
    const failed = !run ? "long_run_missing" : !payload ? "usage_start_row_missing"
      : payload.schemaVersion !== "agentlas.inference-accounting.v1" || payload.attribution !== "goal" ? "usage_start_shape"
      : payload.goalId !== input.goalId || payload.sourceId !== input.sourceId || payload.scopeAnchorId !== input.scopeAnchorId
        || (payload.attemptId ?? null) !== input.attemptId ? "usage_start_identity"
      : !db.prepare("SELECT 1 FROM run_events WHERE id=? AND run_id=?").get(input.scopeAnchorId,input.invocationRunId) ? "scope_anchor_missing"
      : null;
    if (failed || !run) {
      console.warn("[long-run] usage start source mismatch", { check: failed, goalId: input.goalId,
        invocationRunId: input.invocationRunId, scopeAnchorId: input.scopeAnchorId, attemptId: input.attemptId,
        runStatus: run?.status ?? null, sourceFound: Boolean(source) });
      throw new Error("long_run_usage_start_source_mismatch");
    }
    appendEventInDb({ runId: run.id, kind: "run.usage_started", actorKind: "host", at: source!.ts,
      sourceEventId: `${input.sourceId}:started`, payload: { sourceId: input.sourceId,
        invocationRunId: input.invocationRunId, attemptId: input.attemptId } }, "inference_accounting");
    changedRunId = run.id;
  }).immediate();
  if (changedRunId) emitDesktopStoreChange({ entity: "long-run", id: changedRunId });
}

/** Usage survives failure/cancellation, but can never dispatch or change task success. */
export function recordLongRunUsage(goalId: string, input: LongRunUsageInput): void {
  const usage = normalizeLongRunUsage(input);
  const db = getDb();
  let changedRunId: string | null = null;
  db.transaction(() => {
    const run = getLongRunByGoalId(goalId);
    if (!run || run.surface === "science") throw new Error("long_run_usage_scope_invalid");
    const invocation = (usage.scopeAnchorId
      ? db.prepare("SELECT chat_id,kind,payload_json,automation_id,node_id FROM run_events WHERE run_id=? AND id=? AND kind IN ('invoke_started','invoke_preflight_started','verifier_execution_started','goal_wait_replan_started','automation_usage_scope_started','automation_run_accounting_started')")
        .get(usage.invocationRunId, usage.scopeAnchorId)
      : db.prepare("SELECT chat_id,kind,payload_json FROM run_events WHERE run_id = ? AND kind = 'invoke_started' LIMIT 1")
        .get(usage.invocationRunId)) as { chat_id: string | null; kind: string; payload_json: string;
          automation_id?: string | null; node_id?: string | null } | undefined;
    const automationScoped = invocation?.kind === "automation_usage_scope_started"
      || invocation?.kind === "automation_run_accounting_started";
    if (automationScoped) {
      const identity = JSON.parse(invocation!.payload_json);
      // Main minted this anchor after checking the stored graph/schedule or
      // read-only observation receipt. A division chat is not the Goal's root
      // chat; retain the captured owner even if its schedule is later unbound.
      if (identity.schemaVersion !== "agentlas.automation-accounting.v1" || identity.goalId !== goalId
        || !invocation!.automation_id || usage.attemptId
        || (invocation!.kind === "automation_usage_scope_started" && !invocation!.node_id)
        || !db.prepare("SELECT 1 FROM automations WHERE id=?").get(invocation!.automation_id)) {
        throw new Error("long_run_usage_automation_mismatch");
      }
    }
    if (usage.scopeAnchorId && (!invocation || (!automationScoped && invocation.chat_id !== run.rootChatId)
      || (invocation.kind === "invoke_preflight_started" && JSON.parse(invocation.payload_json).goalId !== goalId))) {
      throw new Error("long_run_usage_anchor_mismatch");
    }
    if (invocation?.kind === "verifier_execution_started") {
      const identity = JSON.parse(invocation.payload_json);
      const verifier = usage.attemptId && db.prepare(`SELECT a.id FROM long_run_worker_attempts a
        JOIN long_run_workers w ON w.id=a.worker_id WHERE a.id=? AND a.run_id=?
        AND a.invocation_run_id=? AND w.run_id=a.run_id AND w.role='verifier'`)
        .get(usage.attemptId,run.id,usage.invocationRunId);
      if (!verifier || identity.goalId !== goalId || identity.attemptId !== usage.attemptId) {
        throw new Error("long_run_usage_verifier_mismatch");
      }
    }
    if (invocation?.kind === "goal_wait_replan_started") {
      const identity = JSON.parse(invocation.payload_json);
      const waitRow = db.prepare("SELECT payload_json FROM long_run_events WHERE run_id=? AND kind='run.wait_subscription' AND json_extract(payload_json,'$.subscription.waitId')=? ORDER BY seq ASC LIMIT 1")
        .get(run.id, identity.waitId) as { payload_json: string } | undefined;
      const wait = waitRow ? JSON.parse(waitRow.payload_json).subscription : null;
      if (identity.schemaVersion !== "agentlas.goal-wait-replan-accounting.v1"
        || identity.goalId !== goalId
        || identity.checkpointId !== wait?.checkpointId || wait?.goalId !== goalId
        || wait?.goalRevision !== identity.goalRevision || wait?.chatId !== run.rootChatId
        || wait?.recoveryMode !== "stall_replan" || usage.attemptId) {
        throw new Error("long_run_usage_goal_wait_mismatch");
      }
    }
    // Several specialist attempts may share the controller invocation ID.
    // An explicit child identity must resolve exactly; an unqualified direct
    // provider result may inherit only the controller attempt, never a sibling.
    const child = (usage.attemptId
      ? db.prepare("SELECT id AS attempt_id FROM long_run_worker_attempts WHERE run_id = ? AND invocation_run_id = ? AND id = ?")
        .get(run.id, usage.invocationRunId, usage.attemptId)
      : db.prepare("SELECT a.id AS attempt_id FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id = a.worker_id WHERE a.run_id = ? AND a.invocation_run_id = ? AND w.role = 'controller' ORDER BY a.attempt DESC LIMIT 1")
        .get(run.id, usage.invocationRunId)) as { attempt_id: string } | undefined;
    if ((!invocation || invocation.chat_id !== run.rootChatId) && !child && !automationScoped) throw new Error("long_run_usage_invocation_mismatch");
    if (usage.attemptId && child?.attempt_id !== usage.attemptId) throw new Error("long_run_usage_attempt_mismatch");
    const sourceEventId = `usage:${usage.sourceId}`;
    const prior = db.prepare("SELECT kind, payload_json FROM long_run_events WHERE run_id = ? AND json_extract(payload_json, '$.runtimeEvidence.sourceEventId') = ? LIMIT 1")
      .get(run.id, sourceEventId) as { kind: string; payload_json: string } | undefined;
    if (prior) {
      if (prior.kind !== "run.usage_recorded" || JSON.parse(prior.payload_json).usage?.digest !== usage.digest) throw new Error("long_run_usage_source_conflict");
      return;
    }
    const cost = usage.cost.status === "measured" ? usage.cost.usd! : 0;
    if (!Number.isFinite(run.costUsedUsd + cost)) throw new Error("long_run_usage_cost_overflow");
    db.prepare("UPDATE long_runs SET cost_used_usd = cost_used_usd + ? WHERE id = ?").run(cost, run.id);
    appendEventInDb({runId: run.id, kind: "run.usage_recorded", actorKind: "host", sourceEventId,
      payload: { usage, invocationRunId: usage.invocationRunId, attemptId: usage.attemptId ?? child?.attempt_id ?? null },
      at: new Date().toISOString() }, "inference_accounting");
    changedRunId = run.id;
  }).immediate();
  if (changedRunId) emitDesktopStoreChange({ entity: "long-run", id: changedRunId });
}

export function recordLongRunCycle(input: {
  goalId: string;
  progressKey?: string | null;
  /** Main-owned evidence classification; absent for finite and automation callers. */
  progressState?: "unknown" | "evidence_observed";
  /** Exact settled checkpoint, used only by the host verifier for one episode. */
  verifiedCheckpointId?: string;
  /** Completed invocation for an ongoing episode whose result was not judged. */
  sourceInvocationId?: string;
  outcome?: string | null;
  /** Legacy callers remain unknown unless accompanied by a real billing reference. */
  costUsd?: number;
  usage?: LongRunUsageInput;
}): LongRunContinueDecision | null {
  const db = getDb();
  let changedRunId: string | null = null;
  db.transaction(() => {
    const run = getLongRunByGoalId(input.goalId);
    if (!run) return;
    if (run.surface === "science") throw new Error("science_projection_read_only");
    const usage = input.usage ? normalizeLongRunUsage(input.usage) : null;
    if (input.costUsd !== undefined && (!Number.isFinite(input.costUsd) || input.costUsd < 0)) {
      throw new Error("long_run_usage_cost_invalid");
    }
    if (input.usage) recordLongRunUsage(input.goalId, input.usage);
    if ([input.verifiedCheckpointId, input.sourceInvocationId, usage].filter(Boolean).length > 1) throw new Error("long_run_cycle_source_ambiguous");
    const sourceEventId = usage ? `cycle:${usage.sourceId}`
      : input.verifiedCheckpointId ? `cycle:checkpoint:${input.verifiedCheckpointId}`
      : input.sourceInvocationId ? `cycle:invocation:${input.sourceInvocationId}` : undefined;
    if (sourceEventId) {
      const prior = db.prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND json_extract(payload_json, '$.runtimeEvidence.sourceEventId') = ? LIMIT 1")
        .get(run.id, sourceEventId) as { payload_json: string } | undefined;
      if (prior) {
        if (usage && JSON.parse(prior.payload_json).usage?.digest !== usage.digest) throw new Error("long_run_usage_source_conflict");
        return;
      }
    }
    if (LONG_RUN_TERMINAL_STATUSES.has(run.status) || !["queued", "running"].includes(run.status) || !goalRevisionIsCurrent(run)) return;
    const now = new Date().toISOString();
    // Unknown host evidence is never a fresh observation. Keep the last
    // observed fingerprint and charge the no-progress guard for this cycle.
    const sameProgress = input.progressState === "unknown"
      || Boolean(input.progressKey && run.lastProgressKey === input.progressKey);
    const stallStreak = sameProgress ? run.stallStreak + 1 : 0;
    const replanRequired = stallStreak >= run.stallWindow && ownsHostGoalLoop(run.surface)
      && Boolean((input.verifiedCheckpointId || input.sourceInvocationId) && input.progressState)
      && getChatGoalRevision(run.goalId)?.lifecycle === "ongoing";
    const stalled = stallStreak >= run.stallWindow;
    db.prepare(
      `UPDATE long_runs
       SET cycle_count = cycle_count + 1,
           last_progress_key = COALESCE(?, last_progress_key), stall_streak = ?,
           updated_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(input.progressState === "unknown" ? null : input.progressKey ?? null,
      stallStreak, now, run.id);
    appendEventInDb({
      runId: run.id, kind: "run.cycle_recorded", actorKind: "host", sourceEventId,
      payload: { progressKey: input.progressKey ?? null, ...(input.progressState ? { progressState: input.progressState } : {}),
        outcome: input.outcome?.slice(0, 240) ?? null,
        stallStreak, blocked: false, stalled, replanRequired, usage,
        ...(input.sourceInvocationId ? { invocationRunId: input.sourceInvocationId, verification: "unverified" } : {}),
        ...(usage ? { invocationRunId: usage.invocationRunId, attemptId: usage.attemptId } : {}) },
      at: now,
    });
    changedRunId = run.id;
  }).immediate();
  if (changedRunId) emitDesktopStoreChange({ entity: "long-run", id: changedRunId });
  return longRunContinueDecision(input.goalId);
}

export function requestLongRunVerification(goalId: string, evidence?: string | null, options?: { background?: boolean }): boolean {
  return getDb().transaction(() => {
    const run = getLongRunByGoalId(goalId);
    if (!run || !goalRevisionIsCurrent(run)) return false;
    if (run.surface === "science") return false;
    if (options?.background) {
      if (!LONG_RUN_ACTIVE_STATUSES.has(run.status) || longRunOwnerHold(run.id)) return false;
      appendLongRunEvent({ runId: run.id, kind: "verification.requested", actorKind: "host",
        payload: { background: true, evidence: evidence?.slice(0, 500) ?? null } });
      return true;
    }
    if (run.status === "verifying") return true;
    if (!["running", "waiting_worker", "waiting_tool"].includes(run.status)) return false;
    transitionLongRun({
      runId: run.id,
      to: "verifying",
      actorKind: "worker",
      reason: evidence?.slice(0, 500) ?? "model-requested-verification",
    });
    return true;
  }).immediate();
}

function pauseDesktopRuns(reason: "app-quit" | "startup-recovery", appInstanceId?: string,
  assertExclusive?: () => void, liveDaemonBootId: string | null = null): string[] {
  const db = getDb();
  const placeholders = [...LONG_RUN_ACTIVE_STATUSES].map(() => "?").join(",");
  const now = new Date().toISOString();
  const rows = db.transaction(() => {
    if (reason === "startup-recovery") assertExclusive?.();
    // Desktop's single-instance startup recovers its previous GUI epoch. A
    // daemon has a separate lifetime even on this same machine and database;
    // neither app quit nor restart is evidence that its process has ended.
    // Hold the write lock from selection through settlement so a concurrent
    // owner change cannot slip between the filter and worker/event updates.
    // A Goal held for the owner (the answer to its question, or the grant to start) has no turn to interrupt and nothing to
    // resume: pausing it would turn it into a host pause that startup resumes (a wake that only re-asks the question, or a
    // start the owner never granted), so it stays as it is across quit and restart.
    // Nor a Goal whose only run was a background-service turn that already ended: the follower closes it on its next pass. Paused
    // as crash_recovery it left the follower's reach, and the startup resume then redid the finished work as a new Main episode.
    // The same for a service turn that is still running under the service this Desktop reattached to (`liveDaemonBootId`): this
    // process's empty activeRuns says nothing about a turn another process hosts, and the pause made the finished turn's Goal a
    // resume candidate the follower could no longer reach.
    const ownedRows = (db.prepare(
      `SELECT id, goal_id AS goalId, status FROM long_runs
       WHERE execution_location = 'desktop-local' AND host_owner_kind = 'desktop'
         AND surface <> 'science' AND status IN (${placeholders})
         AND NOT (status = 'waiting_tool' AND IFNULL(blocked_reason, '') IN (${GOAL_OWNER_HOLD_BLOCKED_REASONS.map(() => "?").join(",")}))
         AND (? <> 'app-quit' OR ? IS NULL OR app_instance_id = ?)`,
    ).all(...LONG_RUN_ACTIVE_STATUSES, ...GOAL_OWNER_HOLD_BLOCKED_REASONS, reason, appInstanceId ?? null, appInstanceId ?? null) as Array<{ id: string; goalId: string; status: LongRunStatus }>)
      .filter((row) => !(reason === "startup-recovery" && (row.status === "queued" || row.status === "running")
        && (require("../long-run/daemon-turn-goal") as typeof import("../long-run/daemon-turn-goal")).serviceTurnGoalAwaitsFollower(row.goalId, { liveDaemonBootId })));
    for (const row of ownedRows) {
      // A durable user stop is never converted into an automatic host resume.
      const userControl = db.prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.user_control' AND actor_kind = 'user' ORDER BY seq DESC LIMIT 1")
        .get(row.id) as { payload_json: string } | undefined;
      const control = userControl ? JSON.parse(userControl.payload_json) : null;
      const action = control?.action ?? control?.command;
      // Only an explicit Goal delete ends the Goal at quit. A turn [중지] used to leave `cancelling`
      // behind, and a quit or update right after it turned the owner's Goal into `cancelled`
      // (2026-09-28 "업데이트하면 골이 사라짐"): quit, update and pause-then-quit end paused.
      const userDelete = row.status === "cancelling" && action === "delete";
      const userPause = (row.status === "pausing" && action === "pause") || (row.status === "cancelling" && !userDelete);
      db.prepare(
        `UPDATE long_run_worker_attempts
         SET state = 'interrupted',
             error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
         WHERE run_id = ? AND state = 'running'`,
      ).run(
        reason === "app-quit" ? "app_closed" : "host_restarted",
        reason === "app-quit" ? "Desktop application closed" : "Previous Desktop host ended before settlement",
        now,
        now,
        row.id,
      );
      db.prepare(
        `UPDATE long_run_workers SET state = 'interrupted', updated_at = ?
         WHERE run_id = ? AND state IN ('provisioning','idle','running','waiting')`,
      ).run(now, row.id);
      db.prepare(
        `UPDATE long_runs
         SET status = ?, pause_reason = ?, paused_at = ?, completed_at = ?, updated_at = ?,
             app_instance_id = COALESCE(?, app_instance_id), version = version + 1
         WHERE id = ?`,
      ).run(userDelete ? "cancelled" : "paused", userDelete ? null : userPause ? "user" : reason === "app-quit" ? "app_closed" : "crash_recovery",
        userDelete ? null : now, userDelete ? now : null, now, appInstanceId ?? null, row.id);
      if (userDelete) {
        closeOpenTasksOfEndedRun(row.id, now);
        db.prepare("UPDATE chat_goal_contracts SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE goal_id = (SELECT goal_id FROM long_runs WHERE id = ?) AND status IN ('active','blocked')").run(now, now, row.id);
        db.prepare("UPDATE chats SET goal_id = NULL, continuous_mode = 0, updated_at = ? WHERE goal_id = (SELECT goal_id FROM long_runs WHERE id = ?)").run(now, row.id);
      }
      appendEventInDb({
        runId: row.id,
        kind: reason === "app-quit" ? "run.paused_app_closed" : "run.recovered_after_host_exit",
        actorKind: "host",
        payload: {
          from: row.status,
          to: userDelete ? "cancelled" : "paused",
          pauseReason: userDelete ? null : userPause ? "user" : reason === "app-quit" ? "app_closed" : "crash_recovery",
          automaticResume: false,
        },
        at: now,
      });
    }
    return ownedRows;
  }).immediate();
  for (const row of rows) emitDesktopStoreChange({ entity: "long-run", id: row.id });
  return rows.map((row) => row.id);
}

export function pauseActiveDesktopLongRunsForAppShutdown(appInstanceId?: string): string[] {
  return pauseDesktopRuns("app-quit", appInstanceId);
}

export function recoverInterruptedDesktopLongRunsAtStartup(appInstanceId: string,
  assertExclusive: () => void = () => {
    const electron = require("electron") as { app?: { hasSingleInstanceLock?: () => boolean } };
    if (electron.app?.hasSingleInstanceLock?.() !== true) throw new Error("desktop_startup_custody_not_exclusive");
  }, options: { liveDaemonBootId?: string | null } = {}): string[] {
  const db = getDb();
  return desktopStoreTransaction(db, () => {
    assertExclusive();
    const processOwner = invocationProcessOwner();
    if (processOwner.ownerKind !== "desktop") throw new Error("desktop_startup_custody_not_exclusive");
    const recovered = pauseDesktopRuns("startup-recovery", appInstanceId, assertExclusive, options.liveDaemonBootId ?? null);
    // A paused Goal can still contain an attempt whose Desktop died before
    // settlement. Only an exact released lease proves that attempt is no
    // longer live; a dormant Goal or elapsed time alone proves nothing.
    const stranded = db.prepare(`SELECT id, version, status, app_instance_id, root_chat_id FROM long_runs
      WHERE execution_location='desktop-local' AND host_owner_kind='desktop'
        AND surface IN ('one','work') AND status IN ('paused','blocked')
        AND app_instance_id IS NOT NULL AND app_instance_id <> ?`)
      .all(appInstanceId) as Array<{ id: string; version: number; status: string; app_instance_id: string; root_chat_id: string | null }>;
    for (const row of stranded) {
      const attempts = db.prepare(`SELECT a.id, a.worker_id, a.attempt, a.invocation_run_id, o.owner_id, o.lease_id
        FROM long_run_worker_attempts a JOIN invocation_run_owners o
          ON o.run_id=a.invocation_run_id AND o.chat_id=?
        WHERE a.run_id=? AND a.state='running' AND a.app_instance_id=?
          AND o.owner_kind='desktop' AND o.state='released' AND o.owner_id<>?`)
        .all(row.root_chat_id, row.id, row.app_instance_id, processOwner.ownerId) as Array<{
          id: string; worker_id: string; attempt: number; invocation_run_id: string; owner_id: string; lease_id: string;
        }>;
      if (!attempts.length) continue;
      const now = new Date().toISOString();
      for (const attempt of attempts) {
        assertExclusive();
        const currentOwner = invocationProcessOwner();
        if (currentOwner.ownerKind !== processOwner.ownerKind || currentOwner.ownerId !== processOwner.ownerId) {
          throw new Error("long_run_startup_custody_changed");
        }
        const changed = db.prepare(`UPDATE long_run_worker_attempts
          SET state='interrupted',error_code='host_restarted',
            error_message='Previous Desktop host ended before settlement',updated_at=?,completed_at=?
          WHERE id=? AND run_id=? AND state='running' AND app_instance_id=? AND invocation_run_id=?
            AND EXISTS (SELECT 1 FROM invocation_run_owners o WHERE o.run_id=? AND o.chat_id=?
              AND o.owner_kind='desktop' AND o.state='released' AND o.owner_id=? AND o.lease_id=?)
            AND EXISTS (SELECT 1 FROM long_runs r WHERE r.id=? AND r.version=? AND r.status=?
              AND r.app_instance_id=? AND r.root_chat_id=?
              AND r.execution_location='desktop-local' AND r.host_owner_kind='desktop')`)
          .run(now, now, attempt.id, row.id, row.app_instance_id, attempt.invocation_run_id,
            attempt.invocation_run_id, row.root_chat_id, attempt.owner_id, attempt.lease_id,
            row.id, row.version, row.status, row.app_instance_id, row.root_chat_id);
        if (changed.changes !== 1) throw new Error("long_run_startup_custody_changed");
        db.prepare(`UPDATE long_run_workers SET state='interrupted',updated_at=?
          WHERE id=? AND run_id=? AND current_attempt=? AND state IN ('provisioning','idle','running','waiting')`)
          .run(now, attempt.worker_id, row.id, attempt.attempt);
      }
      // Preserve the user's pause, task outcomes and every external-effect
      // receipt. This is interrupted execution, never completed work or replay.
      appendLongRunEvent({ runId: row.id, kind: "run.orphaned_attempts_interrupted", actorKind: "host",
        payload: { attemptIds: attempts.map(attempt => attempt.id), reason: "host_restarted", automaticResume: false } });
    }
    // Clean shutdown and blocked Goals are already dormant and absent from
    // ACTIVE. Transfer their ledger custody without resuming them or rewriting
    // a historical attempt, wait claim, user hold, or uncertain external effect.
    const dormant = db.prepare(`SELECT id, version, status, app_instance_id FROM long_runs
      WHERE execution_location='desktop-local' AND host_owner_kind='desktop'
        AND surface IN ('one','work') AND status IN ('paused','blocked')
        AND app_instance_id IS NOT NULL AND app_instance_id <> ?
        AND NOT EXISTS (SELECT 1 FROM long_run_worker_attempts a WHERE a.run_id=long_runs.id AND a.state='running')`)
      .all(appInstanceId) as Array<{ id: string; version: number; status: string; app_instance_id: string }>;
    for (const row of dormant) {
      assertExclusive();
      const changed = db.prepare(`UPDATE long_runs SET app_instance_id=?,version=version+1
        WHERE id=? AND version=? AND status=? AND app_instance_id=?
          AND execution_location='desktop-local' AND host_owner_kind='desktop'`)
        .run(appInstanceId, row.id, row.version, row.status, row.app_instance_id);
      if (changed.changes !== 1) throw new Error("long_run_startup_custody_changed");
      appendLongRunEvent({ runId: row.id, kind: "run.startup_owner_transferred", actorKind: "host",
        payload: { previousAppInstanceId: row.app_instance_id, appInstanceId, status: row.status, automaticResume: false } });
      recovered.push(row.id);
    }
    return recovered;
  }).immediate();
}
