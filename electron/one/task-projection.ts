import {
  ONE_TASK_PROJECTION_CONTRACT_VERSION,
  assertAgentlasOneTaskProjectionV1,
  sanitizeOneTaskProjectionDisplayText,
  type AgentlasOneTaskProjectionV1,
  type OneTaskProjectionMode,
  type OneTaskProjectionListRequest,
  type OneTaskProjectionMutationMode,
  type OneTaskProjectionPendingIntent,
  type OneTaskProjectionPendingOperation,
  type OneTaskProjectionSemanticAction,
  type OneTaskProjectionStatusValue,
  type OneTaskProjectionSurface,
  type OneTaskProjectionRequest,
} from "../../shared/one-task-projection";
import { isOneProfile, type OneProfile } from "../../shared/one-profile";
import {
  isOneDomainEventV1,
  type OneDomainEventV1,
} from "../../shared/one-domain-events";
import {
  isDurableOneSurfaceManifestV1,
  type DurableOneSurfaceResult,
} from "../../shared/one-surface-durable";
import type { OneSurfaceManifestV1 } from "../../shared/one-surface";
import {
  isOneValueClosureV1,
  type OneValueClosureRecord,
} from "../../shared/one-value-closure";
import { looksSecret } from "../../shared/secret-patterns";
import type {
  CanonicalTask,
  InvocationRunReceipt,
  PendingConfirmation,
} from "../../shared/types";
import { listPendingConfirmations } from "../confirm";
import { chatOriginSurface } from "../store/chats";
import { getOneProfile } from "../store/one-profile";
import { getDurableOneSurfaceResult } from "../store/one-surface-results";
import { getLatestInvocationRunReceipt } from "../store/run-events";
import { getCanonicalTask, listCanonicalTasks } from "../store/tasks";
import { listOneDomainEvents } from "./domain-events";
import { getLatestOneValueClosure } from "./value-closure";

export interface OneTaskProjectionAuthoritySnapshot {
  connection: "online" | "degraded" | "offline";
  lastSyncedAt: string;
  authoritativeHostRef: string;
  executionAuthorityAvailable: boolean;
  mutationMode: OneTaskProjectionMutationMode;
}

export interface OneTaskProjectionReadSources {
  getCanonicalTask(taskId: string): unknown;
  listCanonicalTasks(input: { limit: number; includeArchived: boolean }): unknown;
  getOneProfile(): unknown;
  listPendingConfirmations(): unknown;
  getLatestInvocationRunReceipt(chatId: string): unknown;
  listOneDomainEvents(entityId: string, limit: number): unknown;
  getDurableOneSurfaceResult(input: {
    runId: string;
    chatId: string;
    taskId: string;
  }): unknown;
  getLatestOneValueClosure(taskId: string): unknown;
  listPendingOperations(taskId: string): unknown;
  /** 대화의 origin 표면 — One 목록이 전역 Work 작업으로 오염되지 않게 하는 멤버십 판별. */
  chatOriginSurface(chatId: string): "one" | "work" | null;
}

export interface CreateOneTaskProjectionRuntimeOptions {
  /** Main-owned authority only. Renderer/mobile input must never supply this snapshot. */
  getAuthoritySnapshot(input: {
    taskId: string;
    surface: OneTaskProjectionSurface;
  }): unknown;
  /** Test/host composition seam. Every production default below is read-only. */
  sources?: Partial<OneTaskProjectionReadSources>;
}

export interface OneTaskProjectionRuntime {
  getProjection(
    taskId: string,
    request: OneTaskProjectionRequest,
  ): AgentlasOneTaskProjectionV1 | null;
  listProjections(
    request: OneTaskProjectionListRequest,
  ): AgentlasOneTaskProjectionV1[];
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TASK_STATUSES = new Set<CanonicalTask["status"]>([
  "open", "running", "waiting-decision", "partial", "completed", "failed", "cancelled", "archived",
]);
const INVOCATION_STATUSES = new Set<InvocationRunReceipt["status"]>([
  "running", "cancelling", "completed", "failed", "cancelled", "interrupted",
]);
const PENDING_INTENTS = new Set<OneTaskProjectionPendingIntent>([
  "approve_decision", "reject_decision", "modify_decision", "snooze_decision",
  "cancel_task", "resume_task",
]);
const DECISION_INTENTS = new Set<OneTaskProjectionPendingIntent>([
  "approve_decision", "reject_decision", "modify_decision", "snooze_decision",
]);

const DEFAULT_SOURCES: OneTaskProjectionReadSources = {
  getCanonicalTask,
  listCanonicalTasks: (input) => listCanonicalTasks(input),
  getOneProfile,
  listPendingConfirmations,
  getLatestInvocationRunReceipt,
  listOneDomainEvents,
  getDurableOneSurfaceResult,
  getLatestOneValueClosure,
  listPendingOperations: () => [],
  chatOriginSurface,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasRequiredAndOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_RE.test(value) && !looksSecret(value);
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && ISO_DATE_TIME_RE.test(value)
    && Number.isFinite(Date.parse(value));
}

function canonicalTask(value: unknown): CanonicalTask | null {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(value, [
    "id", "version", "title", "projectId", "firmId", "status", "originChatId",
    "createdAt", "updatedAt", "archivedAt", "participants",
  ])) return null;
  if (
    !isSafeIdentifier(value.id)
    || !Number.isSafeInteger(value.version)
    || Number(value.version) < 1
    || typeof value.title !== "string"
    || value.title.length > 16_000
    || (value.projectId !== null && !isSafeIdentifier(value.projectId))
    || (value.firmId !== null && !isSafeIdentifier(value.firmId))
    || typeof value.status !== "string"
    || !TASK_STATUSES.has(value.status as CanonicalTask["status"])
    || (value.originChatId !== null && !isSafeIdentifier(value.originChatId))
    || !isIsoDateTime(value.createdAt)
    || !isIsoDateTime(value.updatedAt)
    || (value.archivedAt !== null && !isIsoDateTime(value.archivedAt))
    || !Array.isArray(value.participants)
    || value.participants.length > 2_048
    || Date.parse(value.updatedAt) !== value.version
  ) return null;
  return value as unknown as CanonicalTask;
}

function authoritySnapshot(value: unknown): OneTaskProjectionAuthoritySnapshot | null {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(value, [
    "connection", "lastSyncedAt", "authoritativeHostRef", "executionAuthorityAvailable", "mutationMode",
  ])) return null;
  if (
    !["online", "degraded", "offline"].includes(String(value.connection))
    || !isIsoDateTime(value.lastSyncedAt)
    || !isSafeIdentifier(value.authoritativeHostRef)
    || typeof value.executionAuthorityAvailable !== "boolean"
    || !["direct", "queue_only", "read_only"].includes(String(value.mutationMode))
  ) return null;
  const snapshot = value as unknown as OneTaskProjectionAuthoritySnapshot;
  if (snapshot.mutationMode === "direct" && (
    snapshot.connection === "offline" || !snapshot.executionAuthorityAvailable
  )) return null;
  if (snapshot.connection === "offline" && (
    snapshot.executionAuthorityAvailable || snapshot.mutationMode === "direct"
  )) return null;
  return snapshot;
}

function exactReceipt(value: unknown, chatId: string): InvocationRunReceipt | null {
  if (!isRecord(value)) return null;
  if (
    !isSafeIdentifier(value.runId)
    || value.chatId !== chatId
    || typeof value.status !== "string"
    || !INVOCATION_STATUSES.has(value.status as InvocationRunReceipt["status"])
    || !isIsoDateTime(value.startedAt)
    || !isIsoDateTime(value.updatedAt)
    || (value.finishedAt !== undefined && !isIsoDateTime(value.finishedAt))
  ) return null;
  return value as unknown as InvocationRunReceipt;
}

function taskBoundRunStartedEvent(
  value: unknown,
  taskId: string,
  runId: string,
): OneDomainEventV1 | null {
  if (!Array.isArray(value)) return null;
  for (const candidate of value) {
    if (!isOneDomainEventV1(candidate)) continue;
    if (
      candidate.eventType !== "run.started"
      || candidate.entityId !== runId
      || candidate.taskId !== taskId
    ) continue;
    const declaredRunId = candidate.payload.entries.find((entry) => entry.name === "runId")?.value;
    if (declaredRunId === runId) return candidate;
  }
  return null;
}

function exactSurfaceResult(
  value: unknown,
  expected: { runId: string; chatId: string; taskId: string },
): DurableOneSurfaceResult | null {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(
    value,
    ["runId", "chatId", "taskId", "recordedAt", "manifest"],
  )) return null;
  if (
    value.runId !== expected.runId
    || value.chatId !== expected.chatId
    || value.taskId !== expected.taskId
    || !isIsoDateTime(value.recordedAt)
    || !isDurableOneSurfaceManifestV1(value.manifest, expected.taskId)
  ) return null;
  return value as unknown as DurableOneSurfaceResult;
}

function exactValueClosure(value: unknown, task: CanonicalTask): OneValueClosureRecord | null {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(value, [
    "closure", "version", "taskVersion", "trustedEvidenceRefs", "artifactRefs", "estimateRefs",
    "createdAt", "updatedAt",
  ])) return null;
  if (
    !isOneValueClosureV1(value.closure)
    || value.closure.taskId !== task.id
    || value.taskVersion !== task.version
    || !Number.isSafeInteger(value.version)
    || Number(value.version) < 1
    || !Array.isArray(value.artifactRefs)
    || !value.artifactRefs.every(isSafeIdentifier)
    || new Set(value.artifactRefs).size !== value.artifactRefs.length
    || !isIsoDateTime(value.createdAt)
    || !isIsoDateTime(value.updatedAt)
  ) return null;
  return value as unknown as OneValueClosureRecord;
}

function pendingConfirmations(value: unknown, chatId: string): PendingConfirmation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.chatId !== chatId) return [];
    if (
      !isSafeIdentifier(candidate.sourceMessageId)
      || typeof candidate.question !== "string"
      || candidate.question.length < 1
      || candidate.question.length > 4_000
      || !isIsoDateTime(candidate.createdAt)
    ) return [];
    return [candidate as unknown as PendingConfirmation];
  });
}

function safeRead<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function uniqueRefs(values: readonly string[], maximum: number): string[] | null {
  const refs = [...new Set(values)];
  if (refs.length > maximum || !refs.every(isSafeIdentifier)) return null;
  return refs;
}

function manifestArtifactRefs(manifest: OneSurfaceManifestV1): string[] {
  const refs: string[] = manifest.fallback.artifacts.map((item) => item.artifactRef);
  for (const block of manifest.blocks) {
    switch (block.type) {
      case "Comparison":
        refs.push(...block.options.flatMap((item) => item.artifactRef ? [item.artifactRef] : []));
        break;
      case "Gallery":
      case "ArtifactList":
        refs.push(...block.items.map((item) => item.artifactRef));
        break;
      case "Media":
        refs.push(block.primaryArtifactRef, ...block.outputs.map((item) => item.artifactRef));
        break;
      case "Document":
        refs.push(block.artifactRef);
        break;
      default:
        break;
    }
  }
  return refs;
}

function manifestReceiptRefs(manifest: OneSurfaceManifestV1): string[] {
  const refs = manifest.evidence
    .filter((item) => item.kind === "receipt")
    .map((item) => item.evidenceRef);
  for (const block of manifest.blocks) {
    if (block.type === "Status") {
      refs.push(...block.steps.flatMap((step) => step.receiptRef ? [step.receiptRef] : []));
    }
  }
  return refs;
}

function statusValue(status: CanonicalTask["status"]): OneTaskProjectionStatusValue {
  switch (status) {
    case "running": return "working";
    case "waiting-decision": return "decision_required";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "stopped";
    case "archived": return "stopped";
    case "open":
    case "partial":
      return "waiting";
  }
}

function defaultSummary(task: CanonicalTask): string {
  switch (task.status) {
    case "open": return "This Task is ready for the next verified step.";
    case "running": return "Work is in progress on the authoritative host.";
    case "waiting-decision": return "A user decision is required before work can continue.";
    case "partial": return "A result is ready for review before Task completion is accepted.";
    case "completed": return "The canonical Task is complete.";
    case "failed": return "The latest authoritative Task step failed and needs review.";
    case "cancelled": return "The user stopped this Task. Its prior progress remains available to review or resume.";
    case "archived": return "This Task is stopped and archived.";
  }
}

function projectionMode(
  request: OneTaskProjectionRequest,
  hasDecision: boolean,
): OneTaskProjectionMode {
  if (request.surface === "work") return "detailed";
  if (request.mode) return request.mode;
  return hasDecision ? "approval_focused" : "summary";
}

function pendingOperations(
  value: unknown,
  task: CanonicalTask,
  decisionIds: readonly string[],
): OneTaskProjectionPendingOperation[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const operations: OneTaskProjectionPendingOperation[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasRequiredAndOnlyKeys(
      candidate,
      ["operationId", "intent", "state", "baseVersion", "createdAt"],
      ["targetRef", "reason"],
    )) return null;
    if (
      !isSafeIdentifier(candidate.operationId)
      || typeof candidate.intent !== "string"
      || !PENDING_INTENTS.has(candidate.intent as OneTaskProjectionPendingIntent)
      || !["queued", "conflict", "expired"].includes(String(candidate.state))
      || !Number.isSafeInteger(candidate.baseVersion)
      || Number(candidate.baseVersion) < 1
      || !isIsoDateTime(candidate.createdAt)
      || (candidate.targetRef !== undefined && !isSafeIdentifier(candidate.targetRef))
      || (candidate.state === "queued" && candidate.baseVersion !== task.version)
    ) return null;
    const intent = candidate.intent as OneTaskProjectionPendingIntent;
    if (DECISION_INTENTS.has(intent) && (
      typeof candidate.targetRef !== "string" || !decisionIds.includes(candidate.targetRef)
    )) return null;
    if (["cancel_task", "resume_task"].includes(intent) && (
      candidate.targetRef !== undefined && candidate.targetRef !== task.id
    )) return null;
    const reason = candidate.reason === undefined
      ? undefined
      : sanitizeOneTaskProjectionDisplayText(candidate.reason, {
          maximum: 4_000,
          fallback: "The queued operation requires review.",
        });
    operations.push({
      operationId: candidate.operationId,
      intent,
      ...(candidate.targetRef === undefined ? {} : { targetRef: candidate.targetRef }),
      state: candidate.state as OneTaskProjectionPendingOperation["state"],
      baseVersion: candidate.baseVersion as number,
      createdAt: candidate.createdAt,
      ...(reason ? { reason } : {}),
    });
  }
  if (new Set(operations.map((item) => item.operationId)).size !== operations.length) return null;
  return operations;
}

function mutationAction(
  actionId: string,
  intent: OneTaskProjectionSemanticAction["intent"],
  label: string,
  targetRef: string,
  authority: OneTaskProjectionAuthoritySnapshot,
): OneTaskProjectionSemanticAction {
  const enabled = authority.mutationMode === "direct" || authority.mutationMode === "queue_only";
  return {
    actionId,
    intent,
    label: authority.mutationMode === "queue_only" ? `${label} when reconnected` : label,
    targetRef,
    enabled,
    ...(!enabled ? { blockedReason: "The authoritative host is read-only or unavailable." } : {}),
  };
}

function availableActions(input: {
  task: CanonicalTask;
  request: OneTaskProjectionRequest;
  authority: OneTaskProjectionAuthoritySnapshot;
  decisionIds: string[];
  artifactIds: string[];
  receiptIds: string[];
}): OneTaskProjectionSemanticAction[] {
  const actions: OneTaskProjectionSemanticAction[] = [];
  if (input.request.surface === "one" && input.task.originChatId && input.task.projectId) {
    actions.push({
      actionId: "action:open-work",
      intent: "open_work",
      label: "Open in Work",
      targetRef: input.task.id,
      enabled: true,
    });
  }
  for (const decisionId of input.decisionIds.slice(0, 1)) {
    actions.push(
      mutationAction("action:approve-decision", "approve_decision", "Approve decision", decisionId, input.authority),
      mutationAction("action:reject-decision", "reject_decision", "Reject decision", decisionId, input.authority),
      mutationAction("action:modify-decision", "modify_decision", "Modify in Work", decisionId, input.authority),
    );
  }
  if (input.artifactIds[0]) {
    actions.push({
      actionId: "action:open-artifact",
      intent: "open_artifact",
      label: "Open artifact",
      targetRef: input.artifactIds[0],
      enabled: true,
    });
  }
  if (input.receiptIds[0]) {
    actions.push({
      actionId: "action:open-receipt",
      intent: "open_receipt",
      label: "Open receipt",
      targetRef: input.receiptIds[0],
      enabled: true,
    });
  }
  if (input.task.status === "running") {
    actions.push(mutationAction("action:cancel-task", "cancel_task", "Cancel Task", input.task.id, input.authority));
  } else if (input.task.status === "failed") {
    const enabled = input.authority.mutationMode === "direct";
    actions.push({
      actionId: "action:retry-task",
      intent: "retry_failed_step",
      label: "Retry failed step",
      targetRef: input.task.id,
      enabled,
      ...(!enabled ? { blockedReason: "Reconnect to the authoritative host before retrying." } : {}),
    });
  } else if (input.task.status === "archived") {
    actions.push(mutationAction("action:resume-task", "resume_task", "Resume Task", input.task.id, input.authority));
  }
  return actions.slice(0, 12);
}

function buildProjection(
  task: CanonicalTask,
  request: OneTaskProjectionRequest,
  authority: OneTaskProjectionAuthoritySnapshot,
  sources: OneTaskProjectionReadSources,
): AgentlasOneTaskProjectionV1 | null {
  if (authority.connection === "offline" && Date.parse(task.updatedAt) > Date.parse(authority.lastSyncedAt)) {
    // The caller has no cached Task snapshot matching this claimed sync point.
    return null;
  }
  const profileValue = safeRead(() => sources.getOneProfile());
  if (!isOneProfile(profileValue)) return null;
  const profile = profileValue as OneProfile;

  const chatId = task.originChatId;
  const confirmations = chatId
    ? pendingConfirmations(safeRead(() => sources.listPendingConfirmations()), chatId)
    : [];
  const decisionIds = uniqueRefs(confirmations.map((item) => item.sourceMessageId), 64);
  if (!decisionIds) return null;

  const candidateReceipt = chatId
    ? exactReceipt(safeRead(() => sources.getLatestInvocationRunReceipt(chatId)), chatId)
    : null;
  // A chat can exist as a general conversation before it is promoted into a
  // Task. Never project that earlier conversation receipt as Task evidence.
  // The Task-scoped run.started domain event is the durable ownership proof.
  const receipt = candidateReceipt && taskBoundRunStartedEvent(
    safeRead(() => sources.listOneDomainEvents(candidateReceipt.runId, 100)),
    task.id,
    candidateReceipt.runId,
  )
    ? candidateReceipt
    : null;
  const surface = chatId && receipt
    ? exactSurfaceResult(safeRead(() => sources.getDurableOneSurfaceResult({
        runId: receipt.runId,
        chatId,
        taskId: task.id,
      })), {
        runId: receipt.runId,
        chatId,
        taskId: task.id,
      })
    : null;
  const closure = exactValueClosure(
    safeRead(() => sources.getLatestOneValueClosure(task.id)),
    task,
  );

  const artifactIds = uniqueRefs([
    ...(surface ? manifestArtifactRefs(surface.manifest) : []),
    ...(closure ? closure.artifactRefs : []),
  ], 256);
  const receiptIds = uniqueRefs([
    ...(receipt ? [receipt.runId] : []),
    ...(surface ? manifestReceiptRefs(surface.manifest) : []),
    ...(closure ? closure.closure.receiptRefs : []),
  ], 256);
  if (!artifactIds || !receiptIds) return null;

  const operations = pendingOperations(
    safeRead(() => sources.listPendingOperations(task.id)),
    task,
    decisionIds,
  );
  if (!operations) return null;

  const value = statusValue(task.status);
  const preferredSummary = confirmations[0]?.question
    ?? surface?.manifest.summary
    ?? closure?.closure.valueItems[0]?.statement
    ?? defaultSummary(task);
  const title = sanitizeOneTaskProjectionDisplayText(task.title, {
    maximum: 160,
    fallback: "Untitled Task",
  });
  const summary = sanitizeOneTaskProjectionDisplayText(preferredSummary, {
    maximum: 4_000,
    fallback: defaultSummary(task),
  });
  const offline = authority.connection === "offline";
  const mayStart = authority.mutationMode === "direct"
    && authority.executionAuthorityAvailable
    && !["running", "completed", "archived"].includes(task.status);
  const mayClaimCompletion = authority.mutationMode === "direct"
    && authority.executionAuthorityAvailable
    && !["completed", "archived"].includes(task.status);
  const references: AgentlasOneTaskProjectionV1["references"] = {
    ...(receipt ? { teamRunId: receipt.runId } : {}),
    ...(surface ? { manifestId: surface.manifest.manifestId } : {}),
    decisionIds,
    artifactIds,
    receiptIds,
  };
  const projection: AgentlasOneTaskProjectionV1 = {
    contractVersion: ONE_TASK_PROJECTION_CONTRACT_VERSION,
    taskId: task.id,
    canonicalVersion: task.version,
    oneId: profile.oneId,
    projectionSurface: request.surface,
    projectionMode: projectionMode(request, decisionIds.length > 0),
    display: { title, summary },
    status: {
      value,
      source: offline ? "cached_projection" : "authoritative_event",
      asOf: task.updatedAt,
      ...(offline ? {
        reason: "The authoritative host is offline; this is the last synchronized Task state.",
      } : {}),
    },
    sync: {
      ...authority,
      queuedOperationCount: operations.filter((item) => item.state === "queued").length,
    },
    truth: {
      mayStartExecution: offline ? false : mayStart,
      mayClaimNewCompletion: offline ? false : mayClaimCompletion,
    },
    references,
    availableActions: availableActions({
      task,
      request,
      authority,
      decisionIds,
      artifactIds,
      receiptIds,
    }),
    pendingOperations: operations,
  };
  try {
    assertAgentlasOneTaskProjectionV1(projection);
    return projection;
  } catch {
    return null;
  }
}

function validRequest(value: unknown): value is OneTaskProjectionRequest {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(value, ["surface"], ["mode"])) return false;
  return ["one", "work", "mobile"].includes(String(value.surface))
    && (value.mode === undefined || ["summary", "detailed", "approval_focused"].includes(String(value.mode)));
}

function listLimit(value: unknown): number {
  if (!Number.isSafeInteger(value)) return 50;
  return Math.max(1, Math.min(200, Number(value)));
}

/**
 * Main-owned, read-only canonical Task projection composer. It never creates a
 * Task, changes status, resolves a ref, starts execution, or persists a cache.
 */
export function createOneTaskProjectionRuntime(
  options: CreateOneTaskProjectionRuntimeOptions,
): OneTaskProjectionRuntime {
  if (!options || typeof options.getAuthoritySnapshot !== "function") {
    throw new TypeError("Task projection runtime requires a Main-owned authority reader");
  }
  const sources: OneTaskProjectionReadSources = {
    ...DEFAULT_SOURCES,
    ...(options.sources ?? {}),
  };
  const projectionFor = (
    taskId: string,
    request: OneTaskProjectionRequest,
    readSources: OneTaskProjectionReadSources,
  ): AgentlasOneTaskProjectionV1 | null => {
    if (!isSafeIdentifier(taskId) || !validRequest(request)) return null;
    const task = canonicalTask(safeRead(() => readSources.getCanonicalTask(taskId)));
    if (!task || task.id !== taskId) return null;
    // One은 초개인화 표면이다. One이 직접 시작한 대화의 Task만 One에 투영하고,
    // 전역 Work 작업은 절대 One 홈으로 새지 않는다. Work/Mobile 표면은 전체를 본다.
    if (request.surface === "one") {
      const origin = task.originChatId
        ? safeRead(() => readSources.chatOriginSurface(task.originChatId as string))
        : null;
      if (origin !== "one") return null;
    }
    const authority = authoritySnapshot(safeRead(() => options.getAuthoritySnapshot({
      taskId,
      surface: request.surface,
    })));
    if (!authority) return null;
    return buildProjection(task, request, authority, readSources);
  };
  const getProjection = (
    taskId: string,
    request: OneTaskProjectionRequest,
  ): AgentlasOneTaskProjectionV1 | null => projectionFor(taskId, request, sources);

  return {
    getProjection,
    listProjections(request) {
      if (!isRecord(request) || !hasRequiredAndOnlyKeys(
        request,
        ["surface"],
        ["mode", "limit", "includeArchived"],
      )) return [];
      if (!validRequest({ surface: request.surface, ...(request.mode ? { mode: request.mode } : {}) })) return [];
      if (request.includeArchived !== undefined && typeof request.includeArchived !== "boolean") return [];
      const rows = safeRead(() => sources.listCanonicalTasks({
        limit: listLimit(request.limit),
        includeArchived: request.includeArchived === true,
      }));
      if (!Array.isArray(rows)) return [];
      // 확인 요청 스냅샷은 태스크마다 달라지지 않는다. 목록 호출 한 번에 한 번만
      // 읽어 모든 projection이 공유한다 — 원래는 태스크 수만큼 다중 쿼리
      // 스냅샷을 처음부터 다시 만들었다.
      let pendingConfirmationsSnapshot: { value: unknown } | undefined;
      const listSources: OneTaskProjectionReadSources = {
        ...sources,
        listPendingConfirmations: () => {
          if (!pendingConfirmationsSnapshot) {
            pendingConfirmationsSnapshot = { value: sources.listPendingConfirmations() };
          }
          return pendingConfirmationsSnapshot.value;
        },
      };
      return rows.slice(0, listLimit(request.limit)).flatMap((value) => {
        const task = canonicalTask(value);
        if (!task) return [];
        const projection = projectionFor(task.id, {
          surface: request.surface,
          ...(request.mode ? { mode: request.mode } : {}),
        }, listSources);
        return projection ? [projection] : [];
      });
    },
  };
}
