/**
 * Agentlas Desktop Mobile Bridge wire contract.
 *
 * DESKTOP_MOBILE_BRIDGE: This file is intentionally dependency-free so the
 * Electron main process and Flutter protocol generator can share one strict
 * JSON contract. Secrets, absolute paths, private system/provider prompts,
 * environment values, cookies, and provider session identifiers are never part
 * of these DTOs. User-visible transcript text is sanitized and byte-bounded.
 */

export const MOBILE_BRIDGE_PROTOCOL_VERSION = 1 as const;
// Authenticated local-network frames may carry up to four Desktop-compatible
// image attachments (5 MiB each, base64 encoded). Metadata snapshots remain
// separately capped by the projector's much smaller safe-payload budget.
export const MOBILE_BRIDGE_MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
export const MOBILE_BRIDGE_PAIR_EXCHANGE_PATH = "/v1/mobile/pair/exchange";

export type MobileBridgeJsonPrimitive = string | number | boolean | null;
export type MobileBridgeJsonValue =
  | MobileBridgeJsonPrimitive
  | MobileBridgeJsonValue[]
  | { [key: string]: MobileBridgeJsonValue };
export type MobileBridgeJsonObject = { [key: string]: MobileBridgeJsonValue };

export const MOBILE_BRIDGE_METHODS = [
  "snapshot.get",
  "host.status",
  "team.list",
  "firms.list",
  "agentGroups.listResolved",
  "projects.list",
  "chats.listRecent",
  "chats.get",
  "chats.create",
  "chats.rename",
  "chats.archive",
  "chats.unarchive",
  "chats.setContinuousMode",
  "chats.setSwarmMode",
  "chats.setBorrowedAgents",
  "chats.switchAgent",
  "chats.clearContext",
  "workspace.setProject",
  "workspace.clear",
  "composer.context",
  "invoke.history",
  "invoke.start",
  "invoke.steer",
  "invoke.cancel",
  "invoke.attach",
  "invoke.receipt",
  "invoke.activeChats",
  "confirm.listPending",
  "browser.resolveApproval",
  "automations.list",
  "automations.get",
  "automations.toggle",
  "automations.runNow",
  "automations.listRuns",
  "usage.snapshot",
  "runtime.detect",
  "runtime.setActive",
  "hub.borrowable.list",
  "hephaestus.engineToggles",
  "hephaestus.routePreview",
  "ontology.projections.list",
  "ontology.attach.resolve",
  "device.revokeSelf",
] as const;

export type MobileBridgeMethod = (typeof MOBILE_BRIDGE_METHODS)[number];

/** State-changing methods require durable replay protection in Desktop main. */
export const MOBILE_BRIDGE_WRITE_METHODS: ReadonlySet<MobileBridgeMethod> = new Set([
  "device.revokeSelf",
  "chats.create",
  "chats.rename",
  "chats.archive",
  "chats.unarchive",
  "chats.setContinuousMode",
  "chats.setSwarmMode",
  "chats.setBorrowedAgents",
  "chats.switchAgent",
  "chats.clearContext",
  "workspace.setProject",
  "workspace.clear",
  "invoke.start",
  "invoke.steer",
  "invoke.cancel",
  "browser.resolveApproval",
  "automations.toggle",
  "automations.runNow",
  "runtime.setActive",
  "ontology.attach.resolve",
]);

export const MOBILE_BRIDGE_EVENT_NAMES = [
  "bridge.ready",
  "snapshot.updated",
  "invoke.event",
  "invoke.activeChats",
  "confirm.updated",
  "browser.approval",
  "automation.updated",
  "ontology.updated",
] as const;

export type MobileBridgeEventName = (typeof MOBILE_BRIDGE_EVENT_NAMES)[number];

export interface MobileBridgeRpcRequest {
  v: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  type: "request";
  id: string;
  /** Stable across retries. Legacy clients fall back to id, with conflict checks. */
  idempotencyKey?: string;
  method: MobileBridgeMethod;
  params: MobileBridgeJsonObject;
}

/** DESKTOP_MOBILE_BRIDGE: Steering always targets the run the phone actually observed. */
export interface MobileBridgeInvokeSteerParams {
  runId?: string;
  chatId: string;
  userPrompt: string;
  locale?: "ko" | "en";
  permissions?: "read" | "write" | "full";
  planMode?: boolean;
  goalMode?: boolean;
  appsGenerateMode?: boolean;
  borrowAgents?: string[];
  images?: MobileBridgeImageAttachmentDto[];
  expectedQuestionMessageId?: string;
  expectedRunId: string;
}

export interface MobileBridgeImageAttachmentDto {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  name?: string;
  /** Pure base64, never a data URL. Desktop decodes and enforces 5 MiB. */
  data: string;
}

/**
 * DESKTOP_MOBILE_BRIDGE: Pair exchange is deliberately not a regular RPC
 * method. It is the only unauthenticated endpoint and accepts only a short-lived
 * one-time code plus display metadata. It cannot invoke Desktop authority.
 */
export interface MobileBridgePairExchangeRequest {
  v: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  type: "pair.exchange";
  id: string;
  code: string;
  device: {
    name: string;
    platform: "ios" | "android";
    appVersion?: string;
  };
}

/**
 * DESKTOP_MOBILE_BRIDGE: QR/deep-link envelope. The only credential-like value
 * allowed here is the short-lived, one-use pairing code; device bearer tokens
 * are returned only by the pair-exchange response.
 */
export interface MobileBridgePairingPayload {
  version: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  hostId: string;
  displayName: string;
  endpoint: string;
  pairExchangeEndpoint: string;
  code: string;
  expiresAt: string;
  certificateFingerprint: string | null;
  /** Public DER certificate, base64 encoded. Required for pinned WSS/HTTPS. */
  certificateDer: string | null;
}

export interface MobileBridgePairExchangeSuccess {
  v: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  type: "pair.exchange.response";
  id: string;
  ok: true;
  credential: {
    deviceId: string;
    token: string;
    issuedAt: string;
  };
}

export interface MobileBridgePairExchangeFailure {
  v: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  type: "pair.exchange.response";
  id: string | null;
  ok: false;
  error: {
    code: "invalid_pairing_request" | "pairing_denied" | "pairing_expired" | "pairing_unavailable";
    message: string;
  };
}

export type MobileBridgePairExchangeResponse =
  | MobileBridgePairExchangeSuccess
  | MobileBridgePairExchangeFailure;

export interface MobileBridgeRpcSuccess {
  v: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  type: "response";
  id: string;
  ok: true;
  result: MobileBridgeJsonValue;
}

export interface MobileBridgeRpcErrorBody {
  code:
    | "invalid_envelope"
    | "unsupported_version"
    | "invalid_request_id"
    | "method_not_allowed"
    | "invalid_params"
    | "duplicate_request"
    | "too_many_requests"
    | "idempotency_conflict"
    | "idempotency_in_progress"
    | "idempotency_uncertain"
    | "idempotency_unavailable"
    | "authority_error"
    | "response_too_large"
    | "request_timeout";
  message: string;
  retryable: boolean;
}

export interface MobileBridgeRpcFailure {
  v: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  type: "response";
  id: string | null;
  ok: false;
  error: MobileBridgeRpcErrorBody;
}

export interface MobileBridgeEventEnvelope {
  v: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  type: "event";
  seq: number;
  event: MobileBridgeEventName;
  occurredAt: string;
  payload: MobileBridgeJsonValue;
}

export type MobileBridgeServerMessage =
  | MobileBridgeRpcSuccess
  | MobileBridgeRpcFailure
  | MobileBridgeEventEnvelope;

export type MobileBridgeToolPayloadShape =
  | "empty"
  | "text"
  | "json-object"
  | "json-array"
  | "json-scalar";

export type MobileBridgeToolPayloadSize = "empty" | "small" | "medium" | "large";

/**
 * DESKTOP_MOBILE_BRIDGE: Tool bodies never cross the bridge. This describes
 * only non-sensitive structure so Mobile can render a useful collapsed row.
 */
export interface MobileBridgeToolPayloadSummaryDto {
  shape: MobileBridgeToolPayloadShape;
  size: MobileBridgeToolPayloadSize;
  fieldCount?: number;
  itemCount?: number;
  countCapped?: boolean;
}

export interface MobileBridgeInvocationToolDto {
  name: string;
  id: string | null;
  isError: boolean;
  input: MobileBridgeToolPayloadSummaryDto | null;
  output: MobileBridgeToolPayloadSummaryDto | null;
}

export interface MobileBridgeInvocationEventDto {
  kind: "thinking" | "tool-use" | "partial" | "final" | "error" | "surface" | "usage" | "reasoning";
  status?: string;
  text?: string;
  delta?: string;
  textLen?: number;
  error?: { code: string; message: string };
  tool?: MobileBridgeInvocationToolDto;
  tokens?: number;
  agentId?: string;
  agentName?: string;
  role?: string;
  phase?: "plan" | "delegate" | "synthesize";
  reasoning?: { phase: "start" | "end"; durationMs?: number };
}

export interface MobileBridgeHostDto {
  id: string;
  displayName: string;
  platform: "macos" | "windows" | "linux";
  appVersion: string;
  protocolVersion: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  online: true;
  capabilities: string[];
}

export interface MobileBridgeRuntimeDto {
  kind: string;
  backend: string;
  version: string | null;
  active: boolean;
  model: string | null;
  effort: string | null;
  efforts: Array<{ id: string; label: string }>;
  availableModels: string[];
  longContextEnabled: boolean;
}

export interface MobileBridgeAgentDto {
  id: string;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  trustGrade: string;
  installedAt: string;
  tone: string;
  runtimeLabel: string | null;
  assetSource: string | null;
  kind: "agent" | "team";
  visibility: "visible" | "background" | "private";
  requiresSetup: boolean;
  /**
   * Immutable Hub identity. Both fields are emitted together or both omitted.
   * A slug, package hash, or latest release is never used as a substitute.
   */
  agentDefinitionId?: string;
  agentReleaseId?: string;
}

export type MobileBridgeOntologyChipKind = "operational" | "taste";
export type MobileBridgeOntologyProjectionState =
  | "live"
  | "offline"
  | "stale"
  | "conflict"
  | "revoked";
export type MobileBridgeOntologyVerification =
  | "verified"
  | "requested"
  | "unverified"
  | "rejected";
export type MobileBridgeOntologyLoadoutState =
  | "empty"
  | "ready"
  | "pending-approval"
  | "applying"
  | "offline"
  | "stale"
  | "conflict"
  | "revoked";
export type MobileBridgeOntologyAttachmentState =
  | "attached"
  | "update-available"
  | "pending-approval"
  | "scheduled-next-session"
  | "applying"
  | "conflict"
  | "revoked";

export type MobileBridgeTasteAxis =
  | "composition"
  | "color"
  | "typography"
  | "motion"
  | "pacing"
  | "density"
  | "imagery"
  | "editing"
  | "spatial-rhythm";

/** Server-compiled, prompt-injection-scanned Taste material for one exact base. */
export interface MobileBridgeTasteRuntimeOverlayDto {
  schemaVersion: 2;
  chipId: string;
  releaseId: string;
  sourceContentHash: string;
  baseAgentDefinitionId: string;
  baseAgentReleaseId: string;
  taskSignatures: Array<
    | "agentlas.task.v1/design"
    | "agentlas.task.v1/image-generation"
    | "agentlas.task.v1/video-production"
    | "agentlas.task.v1/presentation"
  >;
  rules: Array<{
    ruleId: string;
    axis: MobileBridgeTasteAxis;
    polarity: "prefer" | "avoid";
    attribute: "structure" | "saturation" | "hierarchy" | "intensity" | "tempo" | "information" | "treatment" | "rhythm" | "spacing";
    value: string;
    strength: 1 | 2 | 3;
  }>;
  estimatedTokens: number;
  budgetTokens: 240;
}

export interface MobileBridgeOntologyChipDto {
  chipId: string;
  releaseId: string;
  kind: MobileBridgeOntologyChipKind;
  displayName: string;
  summary: string;
  version: string;
  verification: MobileBridgeOntologyVerification;
  labels: string[];
  /** Reproduced outcome or human pairwise-preference evidence; never a universal score. */
  evidenceLabel: string;
  evidenceCount: number;
  /** Present only for verified Taste chips; never derived from display summary text. */
  runtimeOverlay?: MobileBridgeTasteRuntimeOverlayDto;
}

export interface MobileBridgeOntologyLoadoutEntryDto {
  chipId: string;
  releaseId: string;
  kind: MobileBridgeOntologyChipKind;
  state: MobileBridgeOntologyAttachmentState;
  availableReleaseId?: string;
}

export interface MobileBridgeOntologyLoadoutDto {
  revision: string;
  state: MobileBridgeOntologyLoadoutState;
  entries: MobileBridgeOntologyLoadoutEntryDto[];
  changedAt?: string;
}

/**
 * A Hub-authoritative loadout that has already been approved but will only
 * become active when the agent starts its next session. It is deliberately
 * separate from the current loadout and from pre-decision approvals.
 */
export interface MobileBridgeOntologyScheduledLoadoutDto {
  revision: string;
  state: "pending-next-session";
  entries: MobileBridgeOntologyLoadoutEntryDto[];
  changedAt?: string;
}

export interface MobileBridgeOntologyRecommendationDto {
  recommendationId: string;
  source: string;
  summary: string;
  reasons: string[];
  tradeoffs: string[];
  proposedChips: MobileBridgeOntologyLoadoutEntryDto[];
  requiresApproval: true;
  createdAt: string;
  expiresAt: string;
}

export interface MobileBridgeOntologyPendingAttachDto {
  approvalId: string;
  recommendationId: string;
  expectedLoadoutRevision: string;
  selectedChips: MobileBridgeOntologyLoadoutEntryDto[];
  createdAt: string;
  expiresAt: string;
}

/** Secret-free Hub projection bound to one exact immutable agent release. */
export interface MobileBridgeOntologyProjectionDto {
  schemaVersion: 1;
  agentDefinitionId: string;
  agentReleaseId: string;
  state: MobileBridgeOntologyProjectionState;
  generatedAt: string;
  revision: string;
  operationalChips: MobileBridgeOntologyChipDto[];
  tasteChips: MobileBridgeOntologyChipDto[];
  loadout: MobileBridgeOntologyLoadoutDto;
  scheduledNextSession?: MobileBridgeOntologyScheduledLoadoutDto;
  recommendations: MobileBridgeOntologyRecommendationDto[];
  pendingAttachApprovals: MobileBridgeOntologyPendingAttachDto[];
}

export interface MobileBridgeOntologyAttachReceiptDto {
  schemaVersion: 1;
  approvalId: string;
  outcome:
    | "accepted"
    | "denied"
    | "already-resolved"
    | "offline"
    | "stale"
    | "conflict"
    | "revoked"
    | "outcome-unknown";
  loadoutState: MobileBridgeOntologyLoadoutState;
  loadoutRevision?: string;
  acknowledgedAt: string;
  message: string;
}

export interface MobileBridgeFirmNodeDto {
  agentId: string;
  agentSlug: string;
  role: string;
  reportsTo: string | null;
}

export interface MobileBridgeFirmDto {
  id: string;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  ceoAgentId: string;
  orgChart: MobileBridgeFirmNodeDto[];
  installedAt: string;
}

export interface MobileBridgeAgentGroupMemberDto {
  id: string;
  source: "installed" | "firm-node" | "hub";
  agentId: string | null;
  agentSlug: string | null;
  hubSlug: string | null;
  firmId: string | null;
  nodeId: string | null;
  role: string | null;
  name: string;
  nameEn: string;
  routeLabel: string;
  status: "ok" | "moved" | "missing";
  warnings: string[];
}

export interface MobileBridgeAgentGroupDto {
  id: string;
  name: string;
  description: string;
  orchestratorName: string;
  members: MobileBridgeAgentGroupMemberDto[];
  warningCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MobileBridgeProjectDto {
  id: string;
  name: string;
  description: string | null;
  defaultAgentId: string | null;
  hasWorkingFolder: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MobileBridgeHiredAgentDto {
  slug: string;
  name: string | null;
  source: string | null;
  routeLabel: string | null;
  hiredAt: string;
}

export interface MobileBridgeChatDto {
  id: string;
  projectId: string | null;
  /** Basename only. Absolute Desktop paths never cross the bridge. */
  workingFolderName: string | null;
  firmId: string | null;
  agentGroupId: string | null;
  agentId: string;
  title: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  continuousMode: boolean;
  swarmMode: boolean;
  hiredAgents: MobileBridgeHiredAgentDto[];
  active: boolean;
}

export interface MobileBridgeChatMessageDto {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
}

export interface MobileBridgePendingConfirmationDto {
  chatId: string;
  sourceMessageId: string;
  chatTitle: string;
  question: string;
  header: string | null;
  optionCount: number;
  multiSelect: boolean;
  options: Array<{
    label: string;
    description: string | null;
  }>;
  agentId: string;
  firmId: string | null;
  createdAt: string;
}

/** A reconnect-safe, secret-free view of one live irreversible browser action. */
export interface MobileBridgeBrowserApprovalDto {
  status: "pending";
  requestId: string;
  site: string;
  actionType: string;
  summary: string;
  target: string | null;
  allowAlways: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface MobileBridgeAutomationDto {
  id: string;
  name: string;
  scheduleHuman: string;
  targetType: "agent" | "firm" | "hub";
  targetId: string;
  enabled: boolean;
  createdBy: "user" | "agent";
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  timezone: string | null;
  triggerType: string;
  toolMode: string;
  hubMode: string;
  runState: "unknown" | "idle" | "queued" | "running" | "completed" | "failed";
  /** Stable marker only; raw scheduler errors may contain local paths. */
  lastError: "automation_failed" | null;
}

export interface MobileBridgeUsageWindowDto {
  id: string;
  label: string;
  kind: "5h" | "7d" | "monthly" | "daily";
  usedPercent: number;
  resetAt: number | null;
  model: string | null;
  used: number | null;
  limit: number | null;
  unit: string | null;
}

export interface MobileBridgeUsageProviderDto {
  provider: string;
  backend: string | null;
  label: string;
  status: string;
  windows: MobileBridgeUsageWindowDto[];
  fetchedAt: number;
  error: string | null;
}

export interface MobileBridgeSnapshot {
  schemaVersion: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  generatedAt: string;
  host: MobileBridgeHostDto;
  runtimes: MobileBridgeRuntimeDto[];
  agents: MobileBridgeAgentDto[];
  firms: MobileBridgeFirmDto[];
  groups: MobileBridgeAgentGroupDto[];
  projects: MobileBridgeProjectDto[];
  chats: MobileBridgeChatDto[];
  messages: Record<string, MobileBridgeChatMessageDto[]>;
  pendingConfirmations: MobileBridgePendingConfirmationDto[];
  pendingBrowserApprovals: MobileBridgeBrowserApprovalDto[];
  automations: MobileBridgeAutomationDto[];
  usage: MobileBridgeUsageProviderDto[];
  activeChatIds: string[];
  /** Absent when the authenticated Web producer is not shipped or not proven available. */
  ontologyChipProjections?: MobileBridgeOntologyProjectionDto[];
}

export type MobileBridgeRequestParseResult =
  | { ok: true; value: MobileBridgeRpcRequest }
  | { ok: false; error: MobileBridgeRpcFailure };

const METHOD_SET: ReadonlySet<string> = new Set(MOBILE_BRIDGE_METHODS);
const EVENT_SET: ReadonlySet<string> = new Set(MOBILE_BRIDGE_EVENT_NAMES);
const BLOCKED_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const EMPTY_METHODS: ReadonlySet<MobileBridgeMethod> = new Set([
  "snapshot.get",
  "host.status",
  "team.list",
  "firms.list",
  "agentGroups.listResolved",
  "projects.list",
  "invoke.activeChats",
  "confirm.listPending",
  "automations.list",
  "runtime.detect",
  "hub.borrowable.list",
  "hephaestus.engineToggles",
  "ontology.projections.list",
  "device.revokeSelf",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 256,
): string | null {
  const item = value[key];
  if (typeof item !== "string" || item.length < 1 || item.length > maxLength || /[\u0000-\u001f]/.test(item)) {
    return `${key} must be a non-empty string of at most ${maxLength} characters`;
  }
  return null;
}

function requiredText(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const item = value[key];
  if (
    typeof item !== "string" ||
    item.length < 1 ||
    item.length > maxLength ||
    /[\u0000\u000b\u000c\u000e-\u001f]/.test(item)
  ) {
    return `${key} must be non-empty text of at most ${maxLength} characters`;
  }
  return null;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 256,
): string | null {
  const item = value[key];
  if (item === undefined || item === null) return null;
  if (typeof item !== "string" || item.length > maxLength || /[\u0000-\u001f]/.test(item)) {
    return `${key} must be a string of at most ${maxLength} characters`;
  }
  return null;
}

function optionalBoolean(value: Record<string, unknown>, key: string): string | null {
  return value[key] === undefined || typeof value[key] === "boolean" ? null : `${key} must be a boolean`;
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): string | null {
  const item = value[key];
  if (item === undefined) return null;
  return Number.isInteger(item) && Number(item) >= min && Number(item) <= max
    ? null
    : `${key} must be an integer between ${min} and ${max}`;
}

function validateEnum(
  value: Record<string, unknown>,
  key: string,
  choices: readonly string[],
  optional = true,
): string | null {
  const item = value[key];
  if (item === undefined && optional) return null;
  return typeof item === "string" && choices.includes(item)
    ? null
    : `${key} must be one of: ${choices.join(", ")}`;
}

function firstError(...errors: Array<string | null>): string | null {
  return errors.find((error): error is string => Boolean(error)) ?? null;
}

function validateInvokeOptions(params: Record<string, unknown>): string | null {
  const borrowAgents = params.borrowAgents;
  if (
    borrowAgents !== undefined &&
    (!Array.isArray(borrowAgents) ||
      borrowAgents.length > 8 ||
      borrowAgents.some((item) => typeof item !== "string" || item.length < 1 || item.length > 160))
  ) {
    return "borrowAgents must be an array of at most 8 non-empty strings";
  }
  const images = params.images;
  if (images !== undefined) {
    if (!Array.isArray(images) || images.length > 4) {
      return "images must be an array of at most 4 attachments";
    }
    for (const image of images) {
      if (!isRecord(image) || !hasOnlyKeys(image, ["mediaType", "name", "data"])) {
        return "images contains an unsupported attachment";
      }
      const mediaTypeError = validateEnum(
        image,
        "mediaType",
        ["image/png", "image/jpeg", "image/gif", "image/webp"],
        false,
      );
      if (mediaTypeError) return mediaTypeError;
      const nameError = optionalString(image, "name", 200);
      if (nameError) return nameError;
      if (
        typeof image.data !== "string" ||
        image.data.length < 4 ||
        image.data.length > 7_000_000 ||
        image.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
      ) {
        return "image data must be bounded canonical base64";
      }
    }
  }
  return firstError(
    optionalString(params, "runId", 160),
    requiredString(params, "chatId", 256),
    optionalString(params, "expectedQuestionMessageId", 256),
    requiredText(params, "userPrompt", 200_000),
    validateEnum(params, "locale", ["ko", "en"]),
    validateEnum(params, "permissions", ["read", "write", "full"]),
    optionalBoolean(params, "planMode"),
    optionalBoolean(params, "goalMode"),
    optionalBoolean(params, "appsGenerateMode"),
  );
}

const ONTOLOGY_SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,159}$/;

function ontologyRef(value: unknown, field: string): string | null {
  return typeof value === "string" && ONTOLOGY_SAFE_REF_RE.test(value)
    ? null
    : `${field} must be a portable identifier of at most 160 characters`;
}

function validateOntologyLoadoutEntries(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 2) {
    return "selectedChips must be an array of at most 2 exact releases";
  }
  const chipIds = new Set<string>();
  const kinds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["chipId", "releaseId", "kind", "state", "availableReleaseId"])) {
      return "selectedChips contains an unsupported entry";
    }
    const error = firstError(
      ontologyRef(item.chipId, "chipId"),
      ontologyRef(item.releaseId, "releaseId"),
      validateEnum(item, "kind", ["operational", "taste"], false),
      validateEnum(
        item,
        "state",
        ["pending-approval"],
        false,
      ),
      item.availableReleaseId === undefined
        ? null
        : ontologyRef(item.availableReleaseId, "availableReleaseId"),
    );
    if (error) return error;
    if (chipIds.has(item.chipId as string) || kinds.has(item.kind as string)) {
      return "selectedChips may contain at most one operational and one taste chip";
    }
    chipIds.add(item.chipId as string);
    kinds.add(item.kind as string);
  }
  return null;
}

function validateOntologyAttach(params: Record<string, unknown>): string | null {
  if (!hasOnlyKeys(params, [
    "schemaVersion",
    "approvalId",
    "recommendationId",
    "agentDefinitionId",
    "agentReleaseId",
    "expectedProjectionRevision",
    "expectedLoadoutRevision",
    "decision",
    "selectedChips",
  ])) {
    return "ontology.attach.resolve contains unsupported fields";
  }
  if (params.schemaVersion !== 1) return "ontology.attach.resolve requires schemaVersion 1";
  const error = firstError(
    ontologyRef(params.approvalId, "approvalId"),
    ontologyRef(params.recommendationId, "recommendationId"),
    ontologyRef(params.agentDefinitionId, "agentDefinitionId"),
    ontologyRef(params.agentReleaseId, "agentReleaseId"),
    ontologyRevision(params.expectedProjectionRevision, "expectedProjectionRevision"),
    ontologyRevision(params.expectedLoadoutRevision, "expectedLoadoutRevision"),
    validateEnum(params, "decision", ["approve", "deny"], false),
    validateOntologyLoadoutEntries(params.selectedChips),
  );
  if (error) return error;
  if (params.decision === "approve" && (params.selectedChips as unknown[]).length === 0) {
    return "approve requires at least one exact chip release";
  }
  if (params.decision === "deny" && (params.selectedChips as unknown[]).length !== 0) {
    return "deny must not include selected chips";
  }
  return null;
}

function ontologyRevision(value: unknown, field: string): string | null {
  return typeof value === "string" && /^rev_[a-f0-9]{32}$/.test(value)
    ? null
    : `${field} must be a canonical revision`;
}

function validateParams(method: MobileBridgeMethod, params: Record<string, unknown>): string | null {
  if (!isMobileBridgeJsonValue(params)) return "params must contain only bounded JSON values";
  if (EMPTY_METHODS.has(method)) {
    return Object.keys(params).length === 0 ? null : `${method} does not accept parameters`;
  }

  switch (method) {
    case "chats.listRecent":
      return hasOnlyKeys(params, ["limit"])
        ? optionalInteger(params, "limit", 1, 100)
        : "chats.listRecent accepts only limit";
    case "chats.get":
    case "chats.archive":
    case "chats.unarchive":
    case "chats.clearContext":
      return hasOnlyKeys(params, ["id"]) ? requiredString(params, "id") : `${method} accepts only id`;
    case "chats.create": {
      if (!hasOnlyKeys(params, ["agentId", "firmId", "agentGroupId", "projectId", "title", "continueFromChatId"])) {
        return "chats.create contains unsupported fields";
      }
      const targetCount = [params.agentId, params.firmId, params.agentGroupId].filter(
        (item) => typeof item === "string" && item.length > 0,
      ).length;
      if (targetCount !== 1) return "chats.create requires exactly one of agentId, firmId, or agentGroupId";
      return firstError(
        optionalString(params, "agentId"),
        optionalString(params, "firmId"),
        optionalString(params, "agentGroupId"),
        optionalString(params, "projectId"),
        optionalString(params, "title", 200),
        optionalString(params, "continueFromChatId"),
      );
    }
    case "chats.rename":
      return hasOnlyKeys(params, ["id", "title"])
        ? firstError(requiredString(params, "id"), requiredString(params, "title", 200))
        : "chats.rename accepts only id and title";
    case "chats.setContinuousMode":
    case "chats.setSwarmMode":
      return hasOnlyKeys(params, ["id", "enabled"])
        ? firstError(requiredString(params, "id"), optionalBoolean(params, "enabled"),
            typeof params.enabled === "boolean" ? null : "enabled must be a boolean")
        : `${method} accepts only id and enabled`;
    case "chats.setBorrowedAgents": {
      if (!hasOnlyKeys(params, ["id", "slugs"])) return "chats.setBorrowedAgents accepts only id and slugs";
      const slugs = params.slugs;
      if (!Array.isArray(slugs) || slugs.length > 8 || slugs.some((item) =>
        typeof item !== "string" || item.length < 1 || item.length > 160 || /[\u0000-\u001f]/.test(item))) {
        return "slugs must be an array of at most 8 bounded identifiers";
      }
      return requiredString(params, "id");
    }
    case "chats.switchAgent":
      return hasOnlyKeys(params, ["id", "agentId"])
        ? firstError(requiredString(params, "id"), requiredString(params, "agentId"))
        : "chats.switchAgent accepts only id and agentId";
    case "workspace.setProject":
      return hasOnlyKeys(params, ["chatId", "projectId"])
        ? firstError(requiredString(params, "chatId"), requiredString(params, "projectId"))
        : "workspace.setProject accepts only chatId and projectId";
    case "workspace.clear":
      return hasOnlyKeys(params, ["chatId"])
        ? requiredString(params, "chatId")
        : "workspace.clear accepts only chatId";
    case "invoke.history":
      return hasOnlyKeys(params, ["chatId", "limit"])
        ? firstError(requiredString(params, "chatId"), optionalInteger(params, "limit", 1, 200))
        : "invoke.history accepts only chatId and limit";
    case "composer.context":
      return hasOnlyKeys(params, ["chatId"])
        ? requiredString(params, "chatId")
        : "composer.context accepts only chatId";
    case "invoke.start":
      if (!hasOnlyKeys(params, ["runId", "chatId", "userPrompt", "locale", "permissions", "planMode", "goalMode", "appsGenerateMode", "borrowAgents", "images", "expectedQuestionMessageId"])) {
        return "invoke.start contains unsupported fields";
      }
      return validateInvokeOptions(params);
    case "invoke.steer":
      if (!hasOnlyKeys(params, ["runId", "chatId", "userPrompt", "locale", "permissions", "planMode", "goalMode", "appsGenerateMode", "borrowAgents", "images", "expectedRunId", "expectedQuestionMessageId"])) {
        return "invoke.steer contains unsupported fields";
      }
      return firstError(validateInvokeOptions(params), requiredString(params, "expectedRunId", 160));
    case "invoke.cancel":
    case "invoke.receipt":
      return hasOnlyKeys(params, ["runId"]) ? requiredString(params, "runId", 160) : `${method} accepts only runId`;
    case "invoke.attach":
      return hasOnlyKeys(params, ["chatId"]) ? requiredString(params, "chatId") : "invoke.attach accepts only chatId";
    case "browser.resolveApproval":
      return hasOnlyKeys(params, ["requestId", "decision"])
        ? firstError(
            requiredString(params, "requestId", 160),
            validateEnum(params, "decision", ["once", "always", "deny"], false),
          )
        : "browser.resolveApproval accepts only requestId and decision";
    case "automations.get":
    case "automations.runNow":
      return hasOnlyKeys(params, ["id"]) ? requiredString(params, "id") : `${method} accepts only id`;
    case "automations.toggle":
      return hasOnlyKeys(params, ["id", "enabled"])
        ? firstError(requiredString(params, "id"), params.enabled === true || params.enabled === false ? null : "enabled must be a boolean")
        : "automations.toggle accepts only id and enabled";
    case "automations.listRuns":
      return hasOnlyKeys(params, ["id", "limit"])
        ? firstError(requiredString(params, "id"), optionalInteger(params, "limit", 1, 200))
        : "automations.listRuns accepts only id and limit";
    case "usage.snapshot":
      return hasOnlyKeys(params, ["force"])
        ? optionalBoolean(params, "force")
        : "usage.snapshot accepts only force";
    case "runtime.setActive":
      return hasOnlyKeys(params, ["kind", "backend", "model", "effort", "longContext"])
        ? firstError(
            requiredString(params, "kind", 80),
            optionalString(params, "backend", 80),
            optionalString(params, "model", 200),
            optionalString(params, "effort", 80),
            optionalBoolean(params, "longContext"),
          )
        : "runtime.setActive contains unsupported fields";
    case "hephaestus.routePreview":
      return hasOnlyKeys(params, ["query", "scope", "allowLocal", "offline"])
        ? firstError(
            requiredText(params, "query", 20_000),
            validateEnum(params, "scope", ["network", "cloud"]),
            optionalBoolean(params, "allowLocal"),
            optionalBoolean(params, "offline"),
          )
        : "hephaestus.routePreview contains unsupported fields";
    case "ontology.attach.resolve":
      return validateOntologyAttach(params);
    // Empty-parameter methods returned above. Keep this fail-closed fallback so
    // a future method cannot become callable before it receives a validator.
    default:
      return `unsupported method: ${method}`;
  }
}

export function isMobileBridgeMethod(value: unknown): value is MobileBridgeMethod {
  return typeof value === "string" && METHOD_SET.has(value);
}

export function isMobileBridgeEventName(value: unknown): value is MobileBridgeEventName {
  return typeof value === "string" && EVENT_SET.has(value);
}

/**
 * DESKTOP_MOBILE_BRIDGE: Bounds recursive JSON before it reaches Desktop
 * authority code. Prototype-shaped keys are rejected even when tests call the
 * validator with an object that did not originate from JSON.parse.
 */
export function isMobileBridgeJsonValue(value: unknown, depth = 0): value is MobileBridgeJsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 10_000 && value.every((item) => isMobileBridgeJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 10_000) return false;
  return entries.every(
    ([key, item]) =>
      key.length <= 256 &&
      !BLOCKED_JSON_KEYS.has(key) &&
      isMobileBridgeJsonValue(item, depth + 1),
  );
}

export function mobileBridgeFailure(
  id: string | null,
  code: MobileBridgeRpcErrorBody["code"],
  message: string,
  retryable = false,
): MobileBridgeRpcFailure {
  return {
    v: MOBILE_BRIDGE_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error: { code, message, retryable },
  };
}

/** DESKTOP_MOBILE_BRIDGE: All invalid or unknown envelopes fail closed. */
export function parseMobileBridgeRequest(input: unknown): MobileBridgeRequestParseResult {
  if (!isRecord(input) || !hasOnlyKeys(input, ["v", "type", "id", "idempotencyKey", "method", "params"])) {
    return { ok: false, error: mobileBridgeFailure(null, "invalid_envelope", "Invalid request envelope") };
  }
  const id = typeof input.id === "string" && input.id.length <= 128 ? input.id : null;
  if (input.v !== MOBILE_BRIDGE_PROTOCOL_VERSION) {
    return { ok: false, error: mobileBridgeFailure(id, "unsupported_version", "Unsupported protocol version") };
  }
  if (input.type !== "request") {
    return { ok: false, error: mobileBridgeFailure(id, "invalid_envelope", "Expected a request message") };
  }
  if (!id || /[\u0000-\u001f]/.test(id)) {
    return { ok: false, error: mobileBridgeFailure(null, "invalid_request_id", "Invalid request id") };
  }
  const idempotencyKey = input.idempotencyKey;
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 160 ||
      /[\u0000-\u001f]/.test(idempotencyKey))
  ) {
    return { ok: false, error: mobileBridgeFailure(id, "invalid_envelope", "Invalid idempotency key") };
  }
  if (!isMobileBridgeMethod(input.method)) {
    return { ok: false, error: mobileBridgeFailure(id, "method_not_allowed", "Method is not allowlisted") };
  }
  if (!isRecord(input.params)) {
    return { ok: false, error: mobileBridgeFailure(id, "invalid_params", "params must be an object") };
  }
  const paramsError = validateParams(input.method, input.params);
  if (paramsError) {
    return { ok: false, error: mobileBridgeFailure(id, "invalid_params", paramsError) };
  }
  return {
    ok: true,
    value: {
      v: MOBILE_BRIDGE_PROTOCOL_VERSION,
      type: "request",
      id,
      ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
      method: input.method,
      params: input.params as MobileBridgeJsonObject,
    },
  };
}

export type MobileBridgePairExchangeParseResult =
  | { ok: true; value: MobileBridgePairExchangeRequest }
  | { ok: false; error: MobileBridgePairExchangeFailure };

export function mobileBridgePairFailure(
  id: string | null,
  code: MobileBridgePairExchangeFailure["error"]["code"],
  message: string,
): MobileBridgePairExchangeFailure {
  return {
    v: MOBILE_BRIDGE_PROTOCOL_VERSION,
    type: "pair.exchange.response",
    id,
    ok: false,
    error: { code, message },
  };
}

/** DESKTOP_MOBILE_BRIDGE: Dedicated fail-closed parser for the public exchange endpoint. */
export function parseMobileBridgePairExchangeRequest(
  input: unknown,
): MobileBridgePairExchangeParseResult {
  if (!isRecord(input) || !hasOnlyKeys(input, ["v", "type", "id", "code", "device"])) {
    return { ok: false, error: mobileBridgePairFailure(null, "invalid_pairing_request", "Invalid pairing request") };
  }
  const id = typeof input.id === "string" && input.id.length > 0 && input.id.length <= 128
    ? input.id
    : null;
  if (input.v !== MOBILE_BRIDGE_PROTOCOL_VERSION || input.type !== "pair.exchange" || !id) {
    return { ok: false, error: mobileBridgePairFailure(id, "invalid_pairing_request", "Invalid pairing request") };
  }
  const code = input.code;
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(code)) {
    return { ok: false, error: mobileBridgePairFailure(id, "invalid_pairing_request", "Invalid pairing code") };
  }
  if (!isRecord(input.device) || !hasOnlyKeys(input.device, ["name", "platform", "appVersion"])) {
    return { ok: false, error: mobileBridgePairFailure(id, "invalid_pairing_request", "Invalid device metadata") };
  }
  const nameError = requiredString(input.device, "name", 120);
  const versionError = optionalString(input.device, "appVersion", 80);
  if (nameError || versionError || (input.device.platform !== "ios" && input.device.platform !== "android")) {
    return { ok: false, error: mobileBridgePairFailure(id, "invalid_pairing_request", nameError ?? versionError ?? "Invalid device platform") };
  }
  return {
    ok: true,
    value: {
      v: MOBILE_BRIDGE_PROTOCOL_VERSION,
      type: "pair.exchange",
      id,
      code,
      device: {
        name: input.device.name as string,
        platform: input.device.platform,
        ...(typeof input.device.appVersion === "string" ? { appVersion: input.device.appVersion } : {}),
      },
    },
  };
}

export function mobileBridgeSuccess(
  id: string,
  result: MobileBridgeJsonValue,
): MobileBridgeRpcSuccess {
  if (!isMobileBridgeJsonValue(result)) {
    throw new TypeError("Mobile Bridge authority returned a non-JSON result");
  }
  return {
    v: MOBILE_BRIDGE_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: true,
    result,
  };
}
