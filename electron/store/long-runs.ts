import { randomUUID } from "node:crypto";
import {
  LONG_RUN_ACTIVE_STATUSES,
  LONG_RUN_OPEN_TASK_STATES,
  LONG_RUN_TERMINAL_STATUSES,
  assertLongRunTransition,
  isLongRunPauseReason,
  isLongRunStatus,
  normalizeLongRunCriteria,
  type ContinuityCapsule,
  type LongRunAttemptState,
  type LongRunBudget,
  type LongRunExecutionLocation,
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
import { emitDesktopStoreChange } from "./change-bus";
import { getDb } from "./db";
import { getChatGoalContract, getChatGoalRevision } from "./chat-goals";

export interface LongRunRecord {
  id: string;
  goalId: string;
  idempotencyKey: string;
  surface: LongRunSurface;
  executionLocation: LongRunExecutionLocation;
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
    lastProgressKey: row.last_progress_key,
    stallStreak: row.stall_streak,
    stallWindow: row.stall_window,
    blockedReason: row.blocked_reason,
    appInstanceId: row.app_instance_id,
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

function appendEventInDb(input: {
  runId: string;
  kind: string;
  actorKind: "host" | "user" | "worker" | "runtime" | "tool" | "system";
  actorId?: string | null;
  payload?: unknown;
  at: string;
}): number {
  const db = getDb();
  const row = db.prepare("SELECT last_event_seq FROM long_runs WHERE id = ?")
    .get(input.runId) as { last_event_seq: number } | undefined;
  if (!row) throw new Error(`long_run_not_found:${input.runId}`);
  const seq = row.last_event_seq + 1;
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
    JSON.stringify(input.payload ?? {}),
    input.at,
  );
  db.prepare(
    "UPDATE long_runs SET last_event_seq = ?, updated_at = ?, version = version + 1 WHERE id = ?",
  ).run(seq, input.at, input.runId);
  return seq;
}

export function appendLongRunEvent(input: Omit<Parameters<typeof appendEventInDb>[0], "at"> & { at?: string }): number {
  const db = getDb();
  const run = db.transaction(() => appendEventInDb({ ...input, at: input.at ?? new Date().toISOString() }));
  const seq = run();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  return seq;
}

export function createLongRun(input: {
  id?: string;
  goalId: string;
  idempotencyKey?: string;
  surface: LongRunSurface;
  executionLocation?: LongRunExecutionLocation;
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
  const goalId = requiredText(input.goalId, "long_run_goal_id_required", 240);
  const objective = requiredText(input.objective, "long_run_objective_required", 2_000);
  const criteria = normalizeLongRunCriteria(input.acceptanceCriteria);
  if (criteria.length === 0) throw new TypeError("long_run_acceptance_criteria_required");
  const idempotencyKey = requiredText(input.idempotencyKey ?? `goal:${goalId}`, "long_run_idempotency_required", 300);
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
        created_at, updated_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      goalId,
      idempotencyKey,
      input.surface,
      input.executionLocation ?? "desktop-local",
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
      payload: { status, surface: input.surface, executionLocation: input.executionLocation ?? "desktop-local" },
      at: now,
    });
  })();
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
  })();
  emitDesktopStoreChange({ entity: "long-run", id: run.id });
  const binding = getLongRunDomainBinding(run.id);
  if (!binding) throw new Error("science_projection_binding_readback_failed");
  return binding;
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
  assertLongRunTransition(current.status, input.to);
  if (current.status === input.to) return current;
  const now = new Date().toISOString();
  if (input.expectedVersion != null && current.version !== input.expectedVersion) {
    throw new Error("long_run_transition_version_conflict");
  }
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
        ? isLongRunPauseReason(input.reason) ? input.reason : "user"
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
  })();
  emitDesktopStoreChange({ entity: "long-run", id: current.id });
  const next = getLongRun(current.id);
  if (!next) throw new Error("long_run_transition_readback_failed");
  return next;
}

export function resumeLongRunByUser(runId: string, appInstanceId: string, expectedVersion: number): LongRunRecord {
  const current = getLongRun(runId);
  if (!current) throw new Error(`long_run_not_found:${runId}`);
  if (current.surface === "science") throw new Error("science_projection_read_only");
  if (current.version !== expectedVersion) throw new Error("long_run_resume_version_conflict");
  if (!["paused", "blocked"].includes(current.status)) {
    throw new Error(`long_run_resume_not_allowed:${current.status}`);
  }
  return transitionLongRun({
    runId,
    to: "queued",
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
  const objective = requiredText(input.objective, "long_run_task_objective_required", 2_000);
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
  })();
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
  })();
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
      JSON.stringify(input.workspaceBinding),
      input.permissionProfile,
      now,
      input.workerId,
    );
    return { ...input, attempt: existing.current_attempt, state: existing.state };
  }
  if (run.budget.maxWorkers != null) {
    const active = getDb().prepare(
      `SELECT COUNT(*) AS count FROM long_run_workers
       WHERE run_id = ? AND state IN ('provisioning','idle','running','waiting')`,
    ).get(input.runId) as { count?: number } | undefined;
    if (Number(active?.count ?? 0) >= run.budget.maxWorkers) {
      throw new Error("long_run_worker_budget_exhausted");
    }
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
    JSON.stringify(input.workspaceBinding),
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
  const worker = db.prepare("SELECT run_id, current_attempt FROM long_run_workers WHERE id = ?")
    .get(input.workerId) as { run_id: string; current_attempt: number } | undefined;
  if (!worker || worker.run_id !== input.runId) throw new Error("long_run_worker_not_found");
  const attempt = worker.current_attempt + 1;
  const attemptId = `attempt_${randomUUID()}`;
  const now = new Date().toISOString();
  db.transaction(() => {
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
    db.prepare(
      `UPDATE long_run_workers
       SET current_attempt = ?, state = 'running', last_heartbeat_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(attempt, now, now, input.workerId);
    if (input.taskId) {
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
  })();
  emitDesktopStoreChange({ entity: "long-run", id: input.runId });
  return { attemptId, attempt };
}

export function settleLongRunWorkerAttempt(input: {
  attemptId: string;
  state: Exclude<LongRunAttemptState, "running">;
  nativeCoordinate?: { kind: string; id: string } | null;
  continuityCapsule?: ContinuityCapsule | null;
  sideEffectState?: "none" | "committed" | "uncertain";
  errorCode?: string | null;
  errorMessage?: string | null;
}): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT run_id, worker_id, task_id, state FROM long_run_worker_attempts WHERE id = ?",
  ).get(input.attemptId) as { run_id: string; worker_id: string; task_id: string | null; state: string } | undefined;
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
      input.sideEffectState ?? (input.state === "uncertain" ? "uncertain" : "none"),
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
    db.prepare("UPDATE long_run_workers SET state = ?, updated_at = ? WHERE id = ?")
      .run(workerState, now, row.worker_id);
    if (row.task_id) {
      const taskState: LongRunTaskState = input.state === "completed"
        ? "verifying"
        : input.state === "cancelled"
          ? "cancelled"
          : input.state === "interrupted"
            ? "todo"
            : "failed";
      db.prepare(
        `UPDATE long_run_tasks SET state = ?, updated_at = ?, completed_at = ?
         WHERE run_id = ? AND id = ?`,
      ).run(
        taskState,
        now,
        ["cancelled", "failed"].includes(taskState) ? now : null,
        row.run_id,
        row.task_id,
      );
    }
    appendEventInDb({
      runId: row.run_id,
      kind: "worker.attempt_settled",
      actorKind: "runtime",
      actorId: row.worker_id,
      payload: { attemptId: input.attemptId, state: input.state, sideEffectState: input.sideEffectState ?? null },
      at: now,
    });
  })();
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
  })();
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
  })();
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

/** Apply a user-authored revision only after work has stopped. Old tasks and
 * receipts remain audit records; none count toward the new contract.
 */
export function bindCurrentGoalRevisionToLongRun(runId: string, expectedVersion: number): LongRunRecord {
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
    if (!["draft", "queued", "paused", "blocked", "waiting_user"].includes(run.status)) throw new Error("long_run_goal_binding_requires_stop");
    const active = db.prepare("SELECT COUNT(*) AS n FROM long_run_worker_attempts WHERE run_id = ? AND state IN ('running','uncertain')")
      .get(runId) as { n: number };
    if (active.n > 0) throw new Error("long_run_goal_binding_attempt_unsettled");
    // The existing projection is bounded. Refuse instead of silently dropping
    // part of the authoritative objective or acceptance criteria.
    const objective = goal.objective.replace(/\s+/g, " ").trim();
    const criteria = goal.acceptanceCriteria.map((criterion) => criterion.text.replace(/\s+/g, " ").trim());
    if (objective.length > 2_000 || criteria.length > 32 || criteria.some((text) => text.length > 500)) {
      throw new Error("long_run_goal_projection_limit");
    }
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
  })();
  const run = getLongRun(runId);
  if (!run) throw new Error("long_run_goal_binding_readback_failed");
  emitDesktopStoreChange({ entity: "long-run", id: runId });
  return run;
}

function latestCriterionVerdicts(runId: string): Map<number, { verdict: string; evidenceRefs: string[]; artifactRefs: string[] }> {
  const binding = getLongRunGoalRevisionBinding(runId);
  const rows = getDb().prepare(
    `SELECT criterion_index, verdict, evidence_refs_json, artifact_refs_json
     FROM long_run_verification_receipts
     WHERE run_id = ? AND rowid > ? ORDER BY created_at DESC, rowid DESC`,
  ).all(runId, binding?.receiptCursor ?? 0) as Array<{
    criterion_index: number;
    verdict: string;
    evidence_refs_json: string;
    artifact_refs_json: string;
  }>;
  const result = new Map<number, { verdict: string; evidenceRefs: string[]; artifactRefs: string[] }>();
  for (const row of rows) {
    if (result.has(row.criterion_index)) continue;
    result.set(row.criterion_index, {
      verdict: row.verdict,
      evidenceRefs: stringArray(row.evidence_refs_json),
      artifactRefs: stringArray(row.artifact_refs_json),
    });
  }
  return result;
}

function maybeCompleteVerifiedTask(runId: string, taskId: string, at: string): void {
  const row = getDb().prepare(
    "SELECT * FROM long_run_tasks WHERE run_id = ? AND id = ?",
  ).get(runId, taskId) as LongRunTaskRow | undefined;
  if (!row || !LONG_RUN_OPEN_TASK_STATES.has(row.state)) return;
  const required = integerArray(row.criterion_indices_json);
  if (required.length === 0) return;
  const latest = latestCriterionVerdicts(runId);
  const passed = required.every((index) => {
    const receipt = latest.get(index);
    return receipt?.verdict === "passed" && (receipt.evidenceRefs.length > 0 || receipt.artifactRefs.length > 0);
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
}): string {
  const run = getLongRun(input.runId);
  if (!run) throw new Error(`long_run_not_found:${input.runId}`);
  const binding = getLongRunGoalRevisionBinding(run.id);
  if (!goalRevisionIsCurrent(run) || (binding && input.goalRevision !== binding.revision)) {
    throw new Error("long_run_verification_goal_revision_conflict");
  }
  if (binding && run.status !== "verifying") throw new Error("long_run_verification_not_active");
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
  db.transaction(() => {
    const current = getLongRun(input.runId)!;
    const currentBinding = getLongRunGoalRevisionBinding(input.runId);
    if (!goalRevisionIsCurrent(current) || (currentBinding && (input.goalRevision !== currentBinding.revision || current.status !== "verifying"))) {
      throw new Error("long_run_verification_goal_revision_conflict");
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
  })();
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
  const pauseReason = input.to === "paused" ? input.pauseReason ?? "user" : null;
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
  })();
  emitDesktopStoreChange({ entity: "long-run", id: current.id });
  const next = getLongRun(current.id);
  if (!next) throw new Error("science_projection_status_readback_failed");
  return next;
}

export function tryCompleteVerifiedLongRun(runId: string): boolean {
  return getDb().transaction(() => {
    const run = getLongRun(runId);
    if (!run || run.status !== "verifying") return false;
    if (run.surface === "science") return false;
    if (!goalRevisionIsCurrent(run)) return false;
    if (listLongRunTasks(runId, true).length > 0) return false;
    const latest = latestCriterionVerdicts(runId);
    const allPassed = run.acceptanceCriteria.every((_, index) => {
      const receipt = latest.get(index);
      return receipt?.verdict === "passed" && (receipt.evidenceRefs.length > 0 || receipt.artifactRefs.length > 0);
    });
    if (!allPassed) return false;
    transitionLongRun({ runId, to: "completed", actorKind: "host", reason: "all-criteria-verified" });
    return true;
  })();
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
  if (run.status === "blocked") return decision(false, "goal_blocked");
  if (["paused", "pausing", "cancelling"].includes(run.status)) {
    return decision(false, "goal_paused");
  }
  if (!goalRevisionIsCurrent(run)) return decision(false, "goal_revision_pending");
  if (["draft", "waiting_user", "waiting_worker", "waiting_tool", "verifying"].includes(run.status)) {
    return decision(false, `goal_${run.status}`);
  }
  const deadline = run.budget.wallclockDeadline ? Date.parse(run.budget.wallclockDeadline) : Number.NaN;
  if (Number.isFinite(deadline) && now.getTime() >= deadline) return decision(false, "budget_wallclock_exhausted");
  if (run.budget.maxCycles != null && run.cycleCount >= run.budget.maxCycles) {
    return decision(false, "budget_cycles_exhausted");
  }
  if (run.budget.maxCostUsd != null && run.costUsedUsd >= run.budget.maxCostUsd) {
    return decision(false, "budget_cost_exhausted");
  }
  if (openTaskCount <= 0) return decision(false, "no_open_tasks");
  return decision(true, "open_tasks_remain");
}

export function recordLongRunCycle(input: {
  goalId: string;
  progressKey?: string | null;
  outcome?: string | null;
  costUsd?: number;
}): LongRunContinueDecision | null {
  const run = getLongRunByGoalId(input.goalId);
  if (!run) return null;
  if (run.surface === "science") throw new Error("science_projection_read_only");
  if (LONG_RUN_TERMINAL_STATUSES.has(run.status) || !["queued", "running"].includes(run.status) || !goalRevisionIsCurrent(run)) {
    return longRunContinueDecision(input.goalId);
  }
  const now = new Date().toISOString();
  const sameProgress = Boolean(input.progressKey && run.lastProgressKey === input.progressKey);
  const stallStreak = sameProgress ? run.stallStreak + 1 : 0;
  const shouldBlock = stallStreak >= run.stallWindow;
  const cost = Math.max(0, Number.isFinite(input.costUsd) ? Number(input.costUsd) : 0);
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE long_runs
       SET cycle_count = cycle_count + 1, cost_used_usd = cost_used_usd + ?,
           last_progress_key = COALESCE(?, last_progress_key), stall_streak = ?,
           status = CASE WHEN ? THEN 'blocked' ELSE status END,
           blocked_reason = CASE WHEN ? THEN 'stall_window_exhausted' ELSE blocked_reason END,
           updated_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(cost, input.progressKey ?? null, stallStreak, shouldBlock ? 1 : 0, shouldBlock ? 1 : 0, now, run.id);
    appendEventInDb({
      runId: run.id,
      kind: "run.cycle_recorded",
      actorKind: "host",
      payload: {
        progressKey: input.progressKey ?? null,
        outcome: input.outcome?.slice(0, 240) ?? null,
        stallStreak,
        blocked: shouldBlock,
      },
      at: now,
    });
  })();
  emitDesktopStoreChange({ entity: "long-run", id: run.id });
  return longRunContinueDecision(input.goalId);
}

export function requestLongRunVerification(goalId: string, evidence?: string | null): boolean {
  return getDb().transaction(() => {
    const run = getLongRunByGoalId(goalId);
    if (!run || !goalRevisionIsCurrent(run)) return false;
    if (run.surface === "science") return false;
    if (run.status === "verifying") return true;
    if (!["running", "waiting_worker", "waiting_tool"].includes(run.status)) return false;
    transitionLongRun({
      runId: run.id,
      to: "verifying",
      actorKind: "worker",
      reason: evidence?.slice(0, 500) ?? "model-requested-verification",
    });
    return true;
  })();
}

function pauseDesktopRuns(reason: "app-quit" | "startup-recovery", appInstanceId?: string): string[] {
  const db = getDb();
  const placeholders = [...LONG_RUN_ACTIVE_STATUSES].map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, status FROM long_runs
     WHERE execution_location = 'desktop-local' AND surface <> 'science' AND status IN (${placeholders})`,
  ).all(...LONG_RUN_ACTIVE_STATUSES) as Array<{ id: string; status: LongRunStatus }>;
  if (rows.length === 0) return [];
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const row of rows) {
      // A durable user stop is never converted into an automatic host resume.
      const userControl = db.prepare("SELECT payload_json FROM long_run_events WHERE run_id = ? AND kind = 'run.user_control' AND actor_kind = 'user' ORDER BY seq DESC LIMIT 1")
        .get(row.id) as { payload_json: string } | undefined;
      const control = userControl ? JSON.parse(userControl.payload_json) : null;
      const action = control?.action ?? control?.command;
      const userPause = row.status === "pausing" && action === "pause";
      const userDelete = row.status === "cancelling";
      db.prepare(
        `UPDATE long_run_worker_attempts
         SET state = 'interrupted',
             side_effect_state = CASE WHEN side_effect_state = 'none' THEN 'uncertain' ELSE side_effect_state END,
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
  })();
  for (const row of rows) emitDesktopStoreChange({ entity: "long-run", id: row.id });
  return rows.map((row) => row.id);
}

export function pauseActiveDesktopLongRunsForAppShutdown(appInstanceId?: string): string[] {
  return pauseDesktopRuns("app-quit", appInstanceId);
}

export function recoverInterruptedDesktopLongRunsAtStartup(appInstanceId?: string): string[] {
  return pauseDesktopRuns("startup-recovery", appInstanceId);
}
