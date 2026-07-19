import { looksSecret, redactSecrets } from "./secret-patterns";

export const ONE_TASK_PROJECTION_CONTRACT_VERSION = "1.0.0" as const;
export const MAX_ONE_TASK_PROJECTION_BYTES = 256 * 1024;

export type OneTaskProjectionSurface = "one" | "work" | "mobile";
export type OneTaskProjectionMode = "summary" | "detailed" | "approval_focused";
export interface OneTaskProjectionRequest {
  surface: OneTaskProjectionSurface;
  mode?: OneTaskProjectionMode;
}

export interface OneTaskProjectionListRequest extends OneTaskProjectionRequest {
  limit?: number;
  includeArchived?: boolean;
}

export type OneTaskProjectionStatusValue =
  | "waiting"
  | "working"
  | "decision_required"
  | "completed"
  | "failed"
  | "stopped";
export type OneTaskProjectionStatusSource = "authoritative_event" | "cached_projection";
export type OneTaskProjectionConnection = "online" | "degraded" | "offline";
export type OneTaskProjectionMutationMode = "direct" | "queue_only" | "read_only";

export type OneTaskProjectionActionIntent =
  | "open_work"
  | "approve_decision"
  | "reject_decision"
  | "modify_decision"
  | "snooze_decision"
  | "open_artifact"
  | "open_sources"
  | "open_receipt"
  | "retry_failed_step"
  | "cancel_task"
  | "resume_task"
  | "save_result"
  | "change_conditions"
  | "view_details"
  | "edit_asset"
  | "disable_asset"
  | "use_once"
  | "delete_asset"
  | "reopen_intro"
  | "connect_desktop";

export type OneTaskProjectionPendingIntent =
  | "approve_decision"
  | "reject_decision"
  | "modify_decision"
  | "snooze_decision"
  | "cancel_task"
  | "resume_task";

export interface OneTaskProjectionSemanticAction {
  actionId: string;
  intent: OneTaskProjectionActionIntent;
  label: string;
  targetRef?: string;
  enabled: boolean;
  blockedReason?: string;
}

export interface OneTaskProjectionPendingOperation {
  operationId: string;
  intent: OneTaskProjectionPendingIntent;
  targetRef?: string;
  state: "queued" | "conflict" | "expired";
  baseVersion: number;
  createdAt: string;
  reason?: string;
}

/** Closed renderer/mobile DTO defined by task-projection.v1.schema.json. */
export interface AgentlasOneTaskProjectionV1 {
  contractVersion: typeof ONE_TASK_PROJECTION_CONTRACT_VERSION;
  taskId: string;
  canonicalVersion: number;
  oneId: string;
  projectionSurface: OneTaskProjectionSurface;
  projectionMode: OneTaskProjectionMode;
  display: {
    title: string;
    summary: string;
  };
  status: {
    value: OneTaskProjectionStatusValue;
    source: OneTaskProjectionStatusSource;
    asOf: string;
    reason?: string;
  };
  sync: {
    connection: OneTaskProjectionConnection;
    lastSyncedAt: string;
    authoritativeHostRef: string;
    executionAuthorityAvailable: boolean;
    mutationMode: OneTaskProjectionMutationMode;
    queuedOperationCount: number;
  };
  truth: {
    mayStartExecution: boolean;
    mayClaimNewCompletion: boolean;
  };
  references: {
    teamRunId?: string;
    manifestId?: string;
    decisionIds: string[];
    artifactIds: string[];
    receiptIds: string[];
  };
  availableActions: OneTaskProjectionSemanticAction[];
  pendingOperations: OneTaskProjectionPendingOperation[];
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const TRANSPORT_OR_MARKUP_RE = /(?:<|\b(?:https?|file|javascript|data):(?:\/\/)?|dangerouslySetInnerHTML|\bon(?:error|load|click)\s*=)/i;
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s("'=:\[{])\/[^\s,;:"'`<>|}\]]+/m;
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/;
const UNC_PATH_RE = /\\\\[^\\\s,;:"'`<>|}\]]+(?:\\[^\\\s,;:"'`<>|}\]]+)+/;
const TRAVERSAL_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

const ACTION_INTENTS = new Set<OneTaskProjectionActionIntent>([
  "open_work", "approve_decision", "reject_decision", "modify_decision", "snooze_decision",
  "open_artifact", "open_sources", "open_receipt", "retry_failed_step", "cancel_task",
  "resume_task", "save_result", "change_conditions", "view_details", "edit_asset",
  "disable_asset", "use_once", "delete_asset", "reopen_intro", "connect_desktop",
]);
const PENDING_INTENTS = new Set<OneTaskProjectionPendingIntent>([
  "approve_decision", "reject_decision", "modify_decision", "snooze_decision",
  "cancel_task", "resume_task",
]);
const STATUS_VALUES = new Set<OneTaskProjectionStatusValue>([
  "waiting", "working", "decision_required", "completed", "failed", "stopped",
]);
const SURFACES = new Set<OneTaskProjectionSurface>(["one", "work", "mobile"]);
const MODES = new Set<OneTaskProjectionMode>(["summary", "detailed", "approval_focused"]);
const CONNECTIONS = new Set<OneTaskProjectionConnection>(["online", "degraded", "offline"]);
const MUTATION_MODES = new Set<OneTaskProjectionMutationMode>(["direct", "queue_only", "read_only"]);

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

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && ISO_DATE_TIME_RE.test(value)
    && Number.isFinite(Date.parse(value));
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && IDENTIFIER_RE.test(value)
    && !looksSecret(value)
    && !UNSAFE_CONTROL_RE.test(value);
}

function containsUnsafeDisplayContent(value: string): boolean {
  return looksSecret(value)
    || UNSAFE_CONTROL_RE.test(value)
    || TRANSPORT_OR_MARKUP_RE.test(value)
    || POSIX_ABSOLUTE_PATH_RE.test(value)
    || WINDOWS_ABSOLUTE_PATH_RE.test(value)
    || UNC_PATH_RE.test(value)
    || TRAVERSAL_RE.test(value);
}

function isSafeDisplayText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && !containsUnsafeDisplayContent(value);
}

function isUniqueIdentifierArray(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maximum
    && value.every(isSafeIdentifier)
    && new Set(value).size === value.length;
}

function isSemanticAction(value: unknown): value is OneTaskProjectionSemanticAction {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(
    value,
    ["actionId", "intent", "label", "enabled"],
    ["targetRef", "blockedReason"],
  )) return false;
  if (
    !isSafeIdentifier(value.actionId)
    || typeof value.intent !== "string"
    || !ACTION_INTENTS.has(value.intent as OneTaskProjectionActionIntent)
    || !isSafeDisplayText(value.label, 160)
    || typeof value.enabled !== "boolean"
    || (value.targetRef !== undefined && !isSafeIdentifier(value.targetRef))
    || (value.blockedReason !== undefined && !isSafeDisplayText(value.blockedReason, 4_000))
  ) return false;
  return value.enabled || value.blockedReason !== undefined;
}

function isPendingOperation(value: unknown): value is OneTaskProjectionPendingOperation {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(
    value,
    ["operationId", "intent", "state", "baseVersion", "createdAt"],
    ["targetRef", "reason"],
  )) return false;
  return isSafeIdentifier(value.operationId)
    && typeof value.intent === "string"
    && PENDING_INTENTS.has(value.intent as OneTaskProjectionPendingIntent)
    && (value.targetRef === undefined || isSafeIdentifier(value.targetRef))
    && ["queued", "conflict", "expired"].includes(String(value.state))
    && Number.isSafeInteger(value.baseVersion)
    && Number(value.baseVersion) > 0
    && isIsoDateTime(value.createdAt)
    && (value.reason === undefined || isSafeDisplayText(value.reason, 4_000));
}

function utf8Bytes(value: string): number {
  return typeof TextEncoder === "undefined"
    ? value.length * 3
    : new TextEncoder().encode(value).byteLength;
}

/**
 * Display-only sanitizer for Main-owned Task titles and summaries. Opaque refs
 * never pass through this function: an unsafe ref is rejected, not rewritten.
 */
export function sanitizeOneTaskProjectionDisplayText(
  input: unknown,
  options: { maximum: 160 | 4_000; fallback: string },
): string {
  const fallback = options.fallback.trim().slice(0, options.maximum) || "Unavailable";
  if (typeof input !== "string") return fallback;
  let value = redactSecrets(input)
    .replace(/\bhttps?:\/\/[^\s]+/gi, "[redacted-link]")
    .replace(/\b(?:file|javascript|data):(?:\/\/)?[^\s]*/gi, "[redacted-transport]")
    .replace(POSIX_ABSOLUTE_PATH_RE, (_match, prefix: string) => `${prefix}[redacted-local-path]`)
    .replace(WINDOWS_ABSOLUTE_PATH_RE, "[redacted-local-path]")
    .replace(UNC_PATH_RE, "[redacted-local-path]")
    .replace(TRAVERSAL_RE, "[redacted-traversal]")
    .replace(/</g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, options.maximum);
  if (!value) value = fallback;
  return isSafeDisplayText(value, options.maximum) ? value : fallback;
}

export function isAgentlasOneTaskProjectionV1(
  value: unknown,
): value is AgentlasOneTaskProjectionV1 {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(value, [
    "contractVersion", "taskId", "canonicalVersion", "oneId", "projectionSurface",
    "projectionMode", "display", "status", "sync", "truth", "references",
    "availableActions", "pendingOperations",
  ])) return false;
  if (
    value.contractVersion !== ONE_TASK_PROJECTION_CONTRACT_VERSION
    || !isSafeIdentifier(value.taskId)
    || !Number.isSafeInteger(value.canonicalVersion)
    || Number(value.canonicalVersion) < 1
    || !isSafeIdentifier(value.oneId)
    || typeof value.projectionSurface !== "string"
    || !SURFACES.has(value.projectionSurface as OneTaskProjectionSurface)
    || typeof value.projectionMode !== "string"
    || !MODES.has(value.projectionMode as OneTaskProjectionMode)
  ) return false;
  if (value.projectionSurface === "work" && value.projectionMode !== "detailed") return false;

  if (!isRecord(value.display) || !hasRequiredAndOnlyKeys(value.display, ["title", "summary"])) return false;
  if (!isSafeDisplayText(value.display.title, 160) || !isSafeDisplayText(value.display.summary, 4_000)) return false;

  if (!isRecord(value.status) || !hasRequiredAndOnlyKeys(value.status, ["value", "source", "asOf"], ["reason"])) return false;
  if (
    typeof value.status.value !== "string"
    || !STATUS_VALUES.has(value.status.value as OneTaskProjectionStatusValue)
    || !["authoritative_event", "cached_projection"].includes(String(value.status.source))
    || !isIsoDateTime(value.status.asOf)
    || (value.status.reason !== undefined && !isSafeDisplayText(value.status.reason, 4_000))
  ) return false;

  if (!isRecord(value.sync) || !hasRequiredAndOnlyKeys(value.sync, [
    "connection", "lastSyncedAt", "authoritativeHostRef", "executionAuthorityAvailable",
    "mutationMode", "queuedOperationCount",
  ])) return false;
  if (
    typeof value.sync.connection !== "string"
    || !CONNECTIONS.has(value.sync.connection as OneTaskProjectionConnection)
    || !isIsoDateTime(value.sync.lastSyncedAt)
    || !isSafeIdentifier(value.sync.authoritativeHostRef)
    || typeof value.sync.executionAuthorityAvailable !== "boolean"
    || typeof value.sync.mutationMode !== "string"
    || !MUTATION_MODES.has(value.sync.mutationMode as OneTaskProjectionMutationMode)
    || !Number.isSafeInteger(value.sync.queuedOperationCount)
    || Number(value.sync.queuedOperationCount) < 0
  ) return false;

  if (!isRecord(value.truth) || !hasRequiredAndOnlyKeys(value.truth, ["mayStartExecution", "mayClaimNewCompletion"])) return false;
  if (typeof value.truth.mayStartExecution !== "boolean" || typeof value.truth.mayClaimNewCompletion !== "boolean") return false;

  if (!isRecord(value.references) || !hasRequiredAndOnlyKeys(
    value.references,
    ["decisionIds", "artifactIds", "receiptIds"],
    ["teamRunId", "manifestId"],
  )) return false;
  if (
    (value.references.teamRunId !== undefined && !isSafeIdentifier(value.references.teamRunId))
    || (value.references.manifestId !== undefined && !isSafeIdentifier(value.references.manifestId))
    || !isUniqueIdentifierArray(value.references.decisionIds, 64)
    || !isUniqueIdentifierArray(value.references.artifactIds, 256)
    || !isUniqueIdentifierArray(value.references.receiptIds, 256)
  ) return false;

  if (
    !Array.isArray(value.availableActions)
    || value.availableActions.length > 12
    || !value.availableActions.every(isSemanticAction)
    || new Set(value.availableActions.map((item) => item.actionId)).size !== value.availableActions.length
  ) return false;
  if (
    !Array.isArray(value.pendingOperations)
    || value.pendingOperations.length > 64
    || !value.pendingOperations.every(isPendingOperation)
    || new Set(value.pendingOperations.map((item) => item.operationId)).size !== value.pendingOperations.length
  ) return false;

  const queuedCount = value.pendingOperations.filter((item) => item.state === "queued").length;
  if (value.sync.queuedOperationCount !== queuedCount) return false;
  if (value.sync.mutationMode === "direct" && (
    value.sync.connection === "offline" || value.sync.executionAuthorityAvailable !== true
  )) return false;
  if (value.sync.connection === "offline") {
    if (
      value.status.source !== "cached_projection"
      || value.sync.executionAuthorityAvailable !== false
      || !["queue_only", "read_only"].includes(value.sync.mutationMode)
      || value.truth.mayStartExecution !== false
      || value.truth.mayClaimNewCompletion !== false
      || Date.parse(value.status.asOf) > Date.parse(value.sync.lastSyncedAt)
    ) return false;
  }
  return true;
}

export function parseAgentlasOneTaskProjectionV1(
  raw: string,
): AgentlasOneTaskProjectionV1 | null {
  if (typeof raw !== "string" || utf8Bytes(raw) > MAX_ONE_TASK_PROJECTION_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isAgentlasOneTaskProjectionV1(value) ? value : null;
  } catch {
    return null;
  }
}

export function assertAgentlasOneTaskProjectionV1(
  value: unknown,
): asserts value is AgentlasOneTaskProjectionV1 {
  if (!isAgentlasOneTaskProjectionV1(value)) {
    throw new TypeError("Task projection violated the closed renderer contract");
  }
}
