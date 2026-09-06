/**
 * Provider-neutral long-running work contracts.
 *
 * This file deliberately contains no Electron, Agentlas OS, provider SDK, or
 * database dependency. Desktop and hosted adapters may share the wire shape
 * while keeping their process and persistence policies separate.
 */

export const LONG_RUN_SCHEMA_VERSION = "agentlas.long-run.v1" as const;
export const RUNTIME_ADAPTER_SCHEMA_VERSION = "agentlas.runtime-adapter.v1" as const;

export const LONG_RUN_SURFACES = ["one", "work", "science"] as const;
export type LongRunSurface = (typeof LONG_RUN_SURFACES)[number];

export const LONG_RUN_EXECUTION_LOCATIONS = ["desktop-local", "web-hosted"] as const;
export type LongRunExecutionLocation = (typeof LONG_RUN_EXECUTION_LOCATIONS)[number];

export const LONG_RUN_STATUSES = [
  "draft",
  "queued",
  "running",
  "waiting_worker",
  "waiting_tool",
  "waiting_user",
  "verifying",
  "pausing",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
] as const;
export type LongRunStatus = (typeof LONG_RUN_STATUSES)[number];

export const LONG_RUN_PAUSE_REASONS = [
  "user",
  "app_closed",
  "budget",
  "runtime_unavailable",
  "approval_required",
  "crash_recovery",
] as const;
export type LongRunPauseReason = (typeof LONG_RUN_PAUSE_REASONS)[number];

export const LONG_RUN_TERMINAL_STATUSES: ReadonlySet<LongRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const LONG_RUN_ACTIVE_STATUSES: ReadonlySet<LongRunStatus> = new Set([
  "queued",
  "running",
  "waiting_worker",
  "waiting_tool",
  "waiting_user",
  "verifying",
  "pausing",
  "cancelling",
]);

const LONG_RUN_TRANSITIONS: Readonly<Record<LongRunStatus, ReadonlySet<LongRunStatus>>> = {
  draft: new Set(["queued", "paused", "cancelled"]),
  queued: new Set(["running", "paused", "failed", "cancelling"]),
  running: new Set([
    "waiting_worker",
    "waiting_tool",
    "waiting_user",
    "verifying",
    "pausing",
    "blocked",
    "failed",
    "cancelling",
  ]),
  waiting_worker: new Set(["running", "verifying", "pausing", "blocked", "failed", "cancelling"]),
  waiting_tool: new Set(["running", "verifying", "pausing", "blocked", "failed", "cancelling"]),
  waiting_user: new Set(["running", "pausing", "blocked", "failed", "cancelling"]),
  verifying: new Set(["running", "pausing", "blocked", "completed", "failed", "cancelling"]),
  pausing: new Set(["paused", "failed", "cancelling"]),
  paused: new Set(["queued", "cancelling", "cancelled"]),
  blocked: new Set(["queued", "cancelling", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelling: new Set(["cancelled", "failed"]),
  cancelled: new Set(),
};

export function isLongRunStatus(value: unknown): value is LongRunStatus {
  return typeof value === "string" && (LONG_RUN_STATUSES as readonly string[]).includes(value);
}

export function isLongRunPauseReason(value: unknown): value is LongRunPauseReason {
  return typeof value === "string" && (LONG_RUN_PAUSE_REASONS as readonly string[]).includes(value);
}

export function canTransitionLongRun(from: LongRunStatus, to: LongRunStatus): boolean {
  return from === to || LONG_RUN_TRANSITIONS[from].has(to);
}

export function assertLongRunTransition(from: LongRunStatus, to: LongRunStatus): void {
  if (!canTransitionLongRun(from, to)) {
    throw new Error(`long_run_transition_invalid:${from}->${to}`);
  }
}

export const LONG_RUN_TASK_STATES = [
  "todo",
  "doing",
  "waiting_worker",
  "waiting_tool",
  "waiting_user",
  "verifying",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type LongRunTaskState = (typeof LONG_RUN_TASK_STATES)[number];

export const LONG_RUN_OPEN_TASK_STATES: ReadonlySet<LongRunTaskState> = new Set([
  "todo",
  "doing",
  "waiting_worker",
  "waiting_tool",
  "waiting_user",
  "verifying",
  "blocked",
]);

export const LONG_RUN_WORKER_ROLES = [
  "controller",
  "specialist",
  "verifier",
  "executor",
  "multimodal",
] as const;
export type LongRunWorkerRole = (typeof LONG_RUN_WORKER_ROLES)[number];

export const LONG_RUN_WORKER_STATES = [
  "provisioning",
  "idle",
  "running",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type LongRunWorkerState = (typeof LONG_RUN_WORKER_STATES)[number];

export const LONG_RUN_ATTEMPT_STATES = [
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "uncertain",
] as const;
export type LongRunAttemptState = (typeof LONG_RUN_ATTEMPT_STATES)[number];

export const LONG_RUN_MESSAGE_KINDS = [
  "task",
  "result",
  "question",
  "steer",
  "cancel",
  "receipt",
] as const;
export type LongRunMessageKind = (typeof LONG_RUN_MESSAGE_KINDS)[number];

export const LONG_RUN_VERDICTS = ["passed", "failed", "inconclusive"] as const;
export type LongRunVerificationVerdict = (typeof LONG_RUN_VERDICTS)[number];

export const RUNTIME_FEATURES = [
  "session.resident",
  "session.native_resume",
  "stream.input",
  "stream.output",
  "turn.interrupt",
  "permission.relay",
  "context.compact",
  "snapshot.export",
  "tool.idempotency",
  "worker.child",
  "worker.message",
] as const;
export type RuntimeFeature = (typeof RUNTIME_FEATURES)[number];
export type RuntimeFeatureSupport = "supported" | "unsupported" | "unknown";

export interface RuntimeAdapterDescriptor {
  schemaVersion: typeof RUNTIME_ADAPTER_SCHEMA_VERSION;
  runtimeKind: string;
  executionLocation: LongRunExecutionLocation;
  features: Record<RuntimeFeature, RuntimeFeatureSupport>;
  limits: {
    maxConcurrentTurns?: number;
    maxContextTokens?: number;
  };
  detectedFrom: "live-probe" | "builtin-contract" | "server-registry";
}

export interface LongRunWorkspaceBinding {
  projectId: string | null;
  cwd: string | null;
  revision: string | null;
}

export interface LongRunRuntimeSelection {
  kind: string;
  backend?: string | null;
  model?: string | null;
  effort?: string | null;
  source: "local" | "cloud" | "hub" | "builtin";
  capabilityDescriptorId?: string | null;
}

export interface LongRunWorkerBinding {
  workerId: string;
  runId: string;
  parentWorkerId: string | null;
  taskId: string | null;
  role: LongRunWorkerRole;
  agentDefinitionId: string | null;
  agentRelease: {
    version: string;
    packageHash: string;
    contentHash: string;
  } | null;
  runtimeSelection: LongRunRuntimeSelection;
  workspaceBinding: LongRunWorkspaceBinding;
  permissionProfile: string;
  attempt: number;
  state: LongRunWorkerState;
}

export interface LongRunBudget {
  maxCycles: number | null;
  maxCostUsd: number | null;
  wallclockDeadline: string | null;
  maxWorkers: number | null;
}

export interface ContinuityCapsule {
  schemaVersion: "agentlas.continuity-capsule.v1";
  runId: string;
  workerId: string;
  taskId: string | null;
  attempt: number;
  goalContractRef: string;
  compactedContextRef: string | null;
  openQuestions: string[];
  artifactRefs: string[];
  evidenceRefs: string[];
  toolInvocationRefs: string[];
  workspaceFingerprint: string;
  nativeCoordinate: { kind: string; id: string } | null;
  lastCommittedEventSeq: number;
}

export function defaultRuntimeFeatureMap(): Record<RuntimeFeature, RuntimeFeatureSupport> {
  return Object.fromEntries(RUNTIME_FEATURES.map((feature) => [feature, "unknown"])) as Record<
    RuntimeFeature,
    RuntimeFeatureSupport
  >;
}

export function normalizeLongRunCriteria(value: readonly string[]): string[] {
  return value
    .map((item) => item.replace(/\s+/g, " ").trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 32);
}
