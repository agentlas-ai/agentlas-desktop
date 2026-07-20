import type { OneSurfaceManifestV1 } from "./one-surface";
import type { AgentlasOneTaskProjectionV1 } from "./one-task-projection";
import { ONE_DECISION_CONTRACT_VERSION, type OneDecisionViewV1 } from "./one-decision";
import type { OneMobileEcosystemSuggestionV1 } from "./one-mobile-suggestion";

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
export const MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE = "agentlas_desktop_mobile_pair" as const;

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
  "groups.create",
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
  "tasks.latestResult",
  "tasks.acceptResult",
  "one.suggestions.act",
  "workspace.setProject",
  "workspace.clear",
  "composer.context",
  "invoke.history",
  "one.invoke.start",
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
  "agents.cloudUploadPreview",
  "agents.cloudUploadSave",
  "agents.cloudDelete",
  "build.start",
  "build.status",
  "groups.cloudList",
  "groups.cloudSave",
  "device.revokeSelf",
] as const;

export type MobileBridgeMethod = (typeof MOBILE_BRIDGE_METHODS)[number];

/** State-changing methods require durable replay protection in Desktop main. */
export const MOBILE_BRIDGE_WRITE_METHODS: ReadonlySet<MobileBridgeMethod> = new Set([
  "device.revokeSelf",
  "groups.create",
  "chats.create",
  "chats.rename",
  "chats.archive",
  "chats.unarchive",
  "chats.setContinuousMode",
  "chats.setSwarmMode",
  "chats.setBorrowedAgents",
  "chats.switchAgent",
  "chats.clearContext",
  "tasks.acceptResult",
  "one.suggestions.act",
  "workspace.setProject",
  "workspace.clear",
  "one.invoke.start",
  "invoke.start",
  "invoke.steer",
  "invoke.cancel",
  "browser.resolveApproval",
  "automations.toggle",
  "automations.runNow",
  "runtime.setActive",
  "ontology.attach.resolve",
  "agents.cloudUploadSave",
  "agents.cloudDelete",
  "build.start",
  "groups.cloudSave",
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
  "build.event",
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
  expectedTaskId?: string;
  expectedTaskVersion?: number;
  expectedDecisionContractVersion?: typeof ONE_DECISION_CONTRACT_VERSION;
  expectedRunId: string;
}

/**
 * Closed first-turn contract for the consumer-facing One surface on Mobile.
 *
 * The phone deliberately cannot select a chat, agent, firm, group, project,
 * permission, runtime, Hub route, borrowed target, Task, Profile, or Memory
 * capability. Desktop Main creates the conversation and derives every such
 * authority from its current authenticated host state.
 */
export interface MobileBridgeOneInvokeStartParams {
  schemaVersion: 1;
  userPrompt: string;
  images?: MobileBridgeImageAttachmentDto[];
}

/** Exact accepted start identity. Any later Task is projected by snapshot.updated. */
export interface MobileBridgeOneInvokeStartReceiptDto {
  schemaVersion: 1;
  authoritativeHostRef: string;
  chatId: string;
  runId: string;
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
  pairingAttemptId: string;
  deviceNonce: string;
  pairingAssertion: string;
  audience: typeof MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE;
  device: {
    name: string;
    platform: "ios" | "android";
    appVersion?: string;
  };
}

/**
 * DESKTOP_MOBILE_BRIDGE: QR/deep-link envelope. Credential-like values are
 * limited to the short-lived one-use code and the Web-signed Desktop account
 * proof. Session cookies, stable account subjects, and device bearer tokens are
 * forbidden; the bearer token is returned only after assertion consumption.
 */
export interface MobileBridgePairingPayload {
  version: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  hostId: string;
  displayName: string;
  endpoint: string;
  pairExchangeEndpoint: string;
  code: string;
  expiresAt: string;
  /** Fresh Web proof bound to this exact Desktop host and pairing attempt. */
  desktopAccountProof: string;
  pairingAttemptId: string;
  /** Public configured Agentlas Web origin. No cookie or account subject crosses the QR. */
  accountAuthorityOrigin: string;
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
  /** Pair-exchange-bound proof seed. Mobile still waits for a newer host heartbeat and this exact Task projection. */
  verification?: {
    verificationId: string;
    hostId: string;
    issuedAt: string;
    sampleTaskId: string | null;
    sampleTaskVersion: number | null;
  };
  /** Optional zero-storage cloud route. Issued only after local one-time pairing. */
  relay?: {
    endpoint: string;
    secret: string;
  };
}

export interface MobileBridgePairExchangeFailure {
  v: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  type: "pair.exchange.response";
  id: string | null;
  ok: false;
  error: {
    code:
      | "invalid_pairing_request"
      | "pairing_denied"
      | "pairing_expired"
      | "pairing_unavailable"
      | "invalid_account_assertion"
      | "account_mismatch"
      | "binding_mismatch"
      | "assertion_replayed"
      | "account_authority_unavailable";
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
  /** Main-sanitized, non-executable semantic result shared with Flutter. */
  surface?: OneSurfaceManifestV1;
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

/** Entitlement-checked, public-safe Operational material for one Desktop session. */
export interface DesktopOperationalRuntimeOverlayDto {
  schemaVersion: 1;
  chipId: string;
  releaseId: string;
  sourceContentHash: string;
  baseAgentDefinitionId: string;
  baseAgentReleaseId: string;
  taskSignatures: string[];
  instructions: string[];
  estimatedTokens: number;
  budgetTokens: 560;
}

/**
 * Hub-authoritative runtime snapshot. A new Desktop chat may activate an
 * already-approved next-session loadout; no prompt, chat id, or credential is
 * sent to Hub.
 */
export interface DesktopOntologyRuntimeSessionDto {
  schemaVersion: 1;
  agentDefinitionId: string;
  agentReleaseId: string;
  state: "ready" | "empty" | "revoked";
  projectionRevision: string;
  loadoutRevision: string;
  operational: DesktopOperationalRuntimeOverlayDto | null;
  taste: MobileBridgeTasteRuntimeOverlayDto | null;
  generatedAt: string;
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
  source: "installed" | "firm" | "firm-node" | "hub";
  agentId: string | null;
  agentSlug: string | null;
  hubSlug: string | null;
  firmId: string | null;
  nodeId: string | null;
  role: string | null;
  name: string;
  nameEn: string;
  routeLabel: string;
  /** Exact immutable Hub identity when this installed member has one. */
  agentDefinitionId?: string;
  agentReleaseId?: string;
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
  /** Main-owned origin marker. Titles or coordinator names are never used to infer this. */
  oneOrigin: boolean;
  /** Null only for a general One conversation that has not become a Task. */
  taskId: string | null;
  taskVersion: number | null;
  /** Main-owned Task state. Mobile must not infer completion from message text. */
  taskStatus: "open" | "running" | "waiting-decision" | "partial" | "completed" | "failed" | "archived" | null;
  taskUpdatedAt: string | null;
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

/**
 * Read-only, restart-safe projection of the newest completed run for one exact
 * canonical Task. This is intentionally fetched on demand instead of being
 * embedded in every chat snapshot, because a Surface may be up to 512 KiB.
 */
export interface MobileBridgeTaskResultSnapshotDto {
  taskId: string;
  taskVersion: number;
  taskStatus: "partial" | "completed";
  taskUpdatedAt: string;
  chatId: string;
  runId: string;
  receipt: {
    status: "completed";
    startedAt: string;
    updatedAt: string;
    finishedAt: string;
    eventCount: number;
  };
  /** Null for a valid plain-text result that did not produce a semantic Surface. */
  surface: OneSurfaceManifestV1 | null;
}

export interface MobileBridgePairingTaskDto {
  hostId: string;
  taskId: string;
  taskVersion: number;
  updatedAt: string;
}

export interface MobileBridgePendingConfirmationDto {
  /** Durable Task identity shared by Desktop One, Work, and Mobile. */
  taskId: string;
  /** Stable Decision identity. For chat questions this is the source message id. */
  decisionId: string;
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

/**
 * Main-owned Decision projection for One Mobile. The nested view is the exact
 * closed `OneDecisionViewV1` produced by Desktop Main; Mobile must never infer
 * risk, options, or authority from the legacy pending-confirmation DTO.
 */
export interface MobileBridgeOneDecisionDto {
  /** The authenticated Desktop host that produced this exact projection. */
  authoritativeHostRef: string;
  /** Optimistic-concurrency version of `view.taskId` at projection time. */
  canonicalTaskVersion: number;
  /** Exact output of Main's `normalizeOneDecision`, without device recomposition. */
  view: OneDecisionViewV1;
}

export type MobileBridgeOneValueClosurePhase = "discovery" | "preparation" | "execution" | "verification";
export type MobileBridgeOneValueClosurePhaseStatus =
  | "not_started"
  | "prepared"
  | "in_progress"
  | "completed"
  | "failed"
  | "not_applicable";

/**
 * Main-owned, content-free Value Closure summary. Narrative claims, outcome
 * payloads, artifact paths, and evidence identifiers never cross this DTO.
 */
export interface MobileBridgeOneValueClosureDto {
  authoritativeHostRef: string;
  taskId: string;
  canonicalTaskVersion: number;
  valueClosureId: string;
  valueClosureVersion: number;
  generatedAt: string;
  status: "ready";
  verification: {
    outcomeStatus: "verified" | "partially_verified";
    phases: Array<{
      phase: MobileBridgeOneValueClosurePhase;
      status: MobileBridgeOneValueClosurePhaseStatus;
      evidenceCount: number;
    }>;
    receiptCount: number;
    trustedEvidenceCount: number;
  };
  remainingWork: {
    total: number;
    pending: number;
    blocked: number;
    notRequired: number;
    userOwned: number;
    oneOwned: number;
    externalOwned: number;
  };
}

/**
 * Content-free proof that approved experience from an earlier Task was used.
 * Asset ids, source Task ids, Memory text, paths, and evidence bodies stay in
 * Desktop Main. This receipt explicitly does not claim an improvement.
 */
export interface MobileBridgeOneExperienceReuseDto {
  authoritativeHostRef: string;
  taskId: string;
  canonicalTaskVersion: number;
  reuseReceiptId: string;
  reuseReceiptVersion: number;
  valueClosureId: string;
  valueClosureVersion: number;
  createdAt: string;
  reuseStatus: "approved_experience_reused";
  comparisonStatus: "not_yet_measured";
  improvementClaimed: false;
  reusedAssetCount: number;
  sourceTaskCount: number;
  scopes: Array<"personal" | "project" | "agent" | "team">;
}

export interface MobileBridgeOneImprovementReusedAssetDto {
  assetId: string;
  assetVersion: number;
  assetKind: "memory" | "agent" | "team" | "automation";
  sourceTaskId: string;
  sourceTaskVersion: number;
}

export type MobileBridgeOneImprovementMetricDto =
  | {
      type: "measured";
      changeKind: "instruction_reduction" | "time_reduction" | "revision_reduction" | "quality_improvement" | "risk_avoidance";
      baseline: number;
      current: number;
      unit: string;
      comparisonDirection: "lower_is_better" | "higher_is_better";
    }
  | {
      type: "estimate";
      changeKind: "instruction_reduction" | "time_reduction" | "revision_reduction" | "quality_improvement" | "risk_avoidance";
      value: number;
      unit: string;
    }
  | {
      type: "qualitative";
      changeKind: "instruction_reduction" | "time_reduction" | "revision_reduction" | "quality_improvement" | "risk_avoidance";
      baselineRefCount: number;
      currentRefCount: number;
    };

export interface MobileBridgeOneImprovementComparisonDto {
  comparisonRef: string;
  baselineTaskId: string;
  baselineTaskVersion: number;
  currentTaskVersion: number;
  evidenceType: "measured" | "qualitative" | "estimate";
  result: "improved" | "no_change" | "regression";
  receiptRefs: string[];
  evidenceCount: number;
  metric: MobileBridgeOneImprovementMetricDto;
}

/**
 * Projection of an actual persisted Improvement Proof record. Labels,
 * statements, methods, prompts, Surface refs, and Main-only attestations are
 * intentionally absent.
 */
export interface MobileBridgeOneImprovementProofDto {
  authoritativeHostRef: string;
  taskId: string;
  canonicalTaskVersion: number;
  improvementProofId: string;
  improvementProofVersion: number;
  generatedAt: string;
  status: "verified";
  compoundingStep: "remembered" | "reused" | "improved_result";
  attributionStatus: "established" | "not_established";
  reusedAssets: MobileBridgeOneImprovementReusedAssetDto[];
  comparisons: MobileBridgeOneImprovementComparisonDto[];
}

const MOBILE_BRIDGE_PROOF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MOBILE_BRIDGE_HOST_REF_RE = /^host_[a-f0-9]{32}$/;
const MOBILE_BRIDGE_CLOSURE_REF_RE = /^value_closure_[a-f0-9]{32}$/;
const MOBILE_BRIDGE_REUSE_REF_RE = /^one_reuse_receipt_[a-f0-9]{32}$/;
const MOBILE_BRIDGE_IMPROVEMENT_REF_RE = /^improvement_proof_[a-f0-9]{32}$/;
const MOBILE_BRIDGE_UNSAFE_PROOF_LABEL_RE = /(?:<|\b(?:https?|file|javascript|data):(?:\/\/)?|(?:^|[\s("'=:\[{])\/(?:Applications|System|Users|home|private|var|tmp|Volumes|opt|etc|usr|Library|root|mnt|media|srv|run|proc|sys|dev|bin|sbin|workspace|workspaces|app|data)(?:\/|$)|[A-Za-z]:\\|\\\\[^\\]+\\|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|secret|password|token)\s*[:=]|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;
const MOBILE_BRIDGE_VALUE_PHASES: readonly MobileBridgeOneValueClosurePhase[] = [
  "discovery", "preparation", "execution", "verification",
];
const MOBILE_BRIDGE_VALUE_PHASE_STATUSES: readonly MobileBridgeOneValueClosurePhaseStatus[] = [
  "not_started", "prepared", "in_progress", "completed", "failed", "not_applicable",
];
const MOBILE_BRIDGE_IMPROVEMENT_CHANGE_KINDS = [
  "instruction_reduction", "time_reduction", "revision_reduction", "quality_improvement", "risk_avoidance",
] as const;

function mobileBridgeExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  return keys.length === expected.length && keys.every((key) => allowed.has(key));
}

function mobileBridgeRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mobileBridgeProjectionId(value: unknown): value is string {
  return typeof value === "string"
    && MOBILE_BRIDGE_PROOF_ID_RE.test(value)
    && !MOBILE_BRIDGE_UNSAFE_PROOF_LABEL_RE.test(value);
}

function mobileBridgePositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function mobileBridgeBoundedCount(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}

function mobileBridgeTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function mobileBridgeProofUnit(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 160
    && !/[\u0000-\u001F\u007F]/.test(value)
    && !MOBILE_BRIDGE_UNSAFE_PROOF_LABEL_RE.test(value);
}

function mobileBridgeUniqueIds(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every(mobileBridgeProjectionId)
    && new Set(value).size === value.length;
}

export function isMobileBridgeOneValueClosureDto(value: unknown): value is MobileBridgeOneValueClosureDto {
  if (!mobileBridgeRecord(value) || !mobileBridgeExactKeys(value, [
    "authoritativeHostRef", "taskId", "canonicalTaskVersion", "valueClosureId",
    "valueClosureVersion", "generatedAt", "status", "verification", "remainingWork",
  ])) return false;
  if (typeof value.authoritativeHostRef !== "string" || !MOBILE_BRIDGE_HOST_REF_RE.test(value.authoritativeHostRef)) return false;
  if (!mobileBridgeProjectionId(value.taskId) || !mobileBridgePositiveVersion(value.canonicalTaskVersion)) return false;
  if (typeof value.valueClosureId !== "string" || !MOBILE_BRIDGE_CLOSURE_REF_RE.test(value.valueClosureId)) return false;
  if (!mobileBridgePositiveVersion(value.valueClosureVersion) || !mobileBridgeTimestamp(value.generatedAt) || value.status !== "ready") return false;
  if (!mobileBridgeRecord(value.verification) || !mobileBridgeExactKeys(value.verification, [
    "outcomeStatus", "phases", "receiptCount", "trustedEvidenceCount",
  ])) return false;
  if (!["verified", "partially_verified"].includes(String(value.verification.outcomeStatus))) return false;
  if (!mobileBridgeBoundedCount(value.verification.receiptCount, 128)
    || !mobileBridgeBoundedCount(value.verification.trustedEvidenceCount, 128)
    || value.verification.receiptCount !== value.verification.trustedEvidenceCount) return false;
  if (!Array.isArray(value.verification.phases) || value.verification.phases.length !== 4) return false;
  for (let index = 0; index < MOBILE_BRIDGE_VALUE_PHASES.length; index += 1) {
    const phase = value.verification.phases[index];
    if (!mobileBridgeRecord(phase) || !mobileBridgeExactKeys(phase, ["phase", "status", "evidenceCount"])) return false;
    if (phase.phase !== MOBILE_BRIDGE_VALUE_PHASES[index]
      || !MOBILE_BRIDGE_VALUE_PHASE_STATUSES.includes(phase.status as MobileBridgeOneValueClosurePhaseStatus)
      || !mobileBridgeBoundedCount(phase.evidenceCount, 32)) return false;
    if (phase.status === "completed" && phase.evidenceCount < 1) return false;
  }
  const verificationPhase = value.verification.phases[3];
  if (value.verification.outcomeStatus === "verified" && verificationPhase.status !== "completed") return false;
  if (!mobileBridgeRecord(value.remainingWork) || !mobileBridgeExactKeys(value.remainingWork, [
    "total", "pending", "blocked", "notRequired", "userOwned", "oneOwned", "externalOwned",
  ])) return false;
  const counts = [
    value.remainingWork.total, value.remainingWork.pending, value.remainingWork.blocked,
    value.remainingWork.notRequired, value.remainingWork.userOwned, value.remainingWork.oneOwned,
    value.remainingWork.externalOwned,
  ];
  if (!counts.every((count) => mobileBridgeBoundedCount(count, 32))) return false;
  return Number(value.remainingWork.pending) + Number(value.remainingWork.blocked) + Number(value.remainingWork.notRequired) === Number(value.remainingWork.total)
    && Number(value.remainingWork.userOwned) + Number(value.remainingWork.oneOwned) + Number(value.remainingWork.externalOwned) === Number(value.remainingWork.total);
}

export function isMobileBridgeOneExperienceReuseDto(value: unknown): value is MobileBridgeOneExperienceReuseDto {
  if (!mobileBridgeRecord(value) || !mobileBridgeExactKeys(value, [
    "authoritativeHostRef", "taskId", "canonicalTaskVersion", "reuseReceiptId",
    "reuseReceiptVersion", "valueClosureId", "valueClosureVersion", "createdAt", "reuseStatus", "comparisonStatus",
    "improvementClaimed", "reusedAssetCount", "sourceTaskCount", "scopes",
  ])) return false;
  if (typeof value.authoritativeHostRef !== "string" || !MOBILE_BRIDGE_HOST_REF_RE.test(value.authoritativeHostRef)) return false;
  if (!mobileBridgeProjectionId(value.taskId) || !mobileBridgePositiveVersion(value.canonicalTaskVersion)) return false;
  if (typeof value.reuseReceiptId !== "string" || !MOBILE_BRIDGE_REUSE_REF_RE.test(value.reuseReceiptId)) return false;
  if (!mobileBridgePositiveVersion(value.reuseReceiptVersion)
    || typeof value.valueClosureId !== "string"
    || !MOBILE_BRIDGE_CLOSURE_REF_RE.test(value.valueClosureId)
    || !mobileBridgePositiveVersion(value.valueClosureVersion)
    || !mobileBridgeTimestamp(value.createdAt)) return false;
  if (value.reuseStatus !== "approved_experience_reused"
    || value.comparisonStatus !== "not_yet_measured"
    || value.improvementClaimed !== false) return false;
  if (!mobileBridgeBoundedCount(value.reusedAssetCount, 32) || Number(value.reusedAssetCount) < 1) return false;
  if (!mobileBridgeBoundedCount(value.sourceTaskCount, 32)
    || Number(value.sourceTaskCount) < 1
    || Number(value.sourceTaskCount) > Number(value.reusedAssetCount)) return false;
  const scopes = ["personal", "project", "agent", "team"] as const;
  return Array.isArray(value.scopes)
    && value.scopes.length >= 1
    && value.scopes.length <= scopes.length
    && value.scopes.every((item) => scopes.includes(item as typeof scopes[number]))
    && new Set(value.scopes).size === value.scopes.length;
}

function isMobileBridgeOneImprovementMetricDto(value: unknown): value is MobileBridgeOneImprovementMetricDto {
  if (!mobileBridgeRecord(value)
    || !MOBILE_BRIDGE_IMPROVEMENT_CHANGE_KINDS.includes(value.changeKind as typeof MOBILE_BRIDGE_IMPROVEMENT_CHANGE_KINDS[number])) return false;
  if (value.type === "measured") {
    return mobileBridgeExactKeys(value, ["type", "changeKind", "baseline", "current", "unit", "comparisonDirection"])
      && typeof value.baseline === "number" && Number.isFinite(value.baseline)
      && typeof value.current === "number" && Number.isFinite(value.current)
      && mobileBridgeProofUnit(value.unit)
      && ["lower_is_better", "higher_is_better"].includes(String(value.comparisonDirection));
  }
  if (value.type === "estimate") {
    return mobileBridgeExactKeys(value, ["type", "changeKind", "value", "unit"])
      && typeof value.value === "number" && Number.isFinite(value.value)
      && mobileBridgeProofUnit(value.unit);
  }
  if (value.type === "qualitative") {
    return mobileBridgeExactKeys(value, ["type", "changeKind", "baselineRefCount", "currentRefCount"])
      && mobileBridgeBoundedCount(value.baselineRefCount, 32) && Number(value.baselineRefCount) >= 1
      && mobileBridgeBoundedCount(value.currentRefCount, 32) && Number(value.currentRefCount) >= 1;
  }
  return false;
}

export function isMobileBridgeOneImprovementProofDto(value: unknown): value is MobileBridgeOneImprovementProofDto {
  if (!mobileBridgeRecord(value) || !mobileBridgeExactKeys(value, [
    "authoritativeHostRef", "taskId", "canonicalTaskVersion", "improvementProofId",
    "improvementProofVersion", "generatedAt", "status", "compoundingStep", "attributionStatus", "reusedAssets", "comparisons",
  ])) return false;
  if (typeof value.authoritativeHostRef !== "string" || !MOBILE_BRIDGE_HOST_REF_RE.test(value.authoritativeHostRef)) return false;
  if (!mobileBridgeProjectionId(value.taskId) || !mobileBridgePositiveVersion(value.canonicalTaskVersion)) return false;
  if (typeof value.improvementProofId !== "string" || !MOBILE_BRIDGE_IMPROVEMENT_REF_RE.test(value.improvementProofId)) return false;
  if (!mobileBridgePositiveVersion(value.improvementProofVersion) || !mobileBridgeTimestamp(value.generatedAt) || value.status !== "verified") return false;
  if (!["remembered", "reused", "improved_result"].includes(String(value.compoundingStep))) return false;
  if (!["established", "not_established"].includes(String(value.attributionStatus))) return false;
  if (value.compoundingStep === "improved_result" && value.attributionStatus !== "established") return false;
  if (!Array.isArray(value.reusedAssets) || value.reusedAssets.length < 1 || value.reusedAssets.length > 16) return false;
  const assetKeys = new Set<string>();
  for (const asset of value.reusedAssets) {
    if (!mobileBridgeRecord(asset) || !mobileBridgeExactKeys(asset, [
      "assetId", "assetVersion", "assetKind", "sourceTaskId", "sourceTaskVersion",
    ])) return false;
    if (!mobileBridgeProjectionId(asset.assetId) || !mobileBridgePositiveVersion(asset.assetVersion)
      || !["memory", "agent", "team", "automation"].includes(String(asset.assetKind))
      || !mobileBridgeProjectionId(asset.sourceTaskId) || !mobileBridgePositiveVersion(asset.sourceTaskVersion)) return false;
    const key = `${asset.assetId}:${asset.assetVersion}`;
    if (assetKeys.has(key)) return false;
    assetKeys.add(key);
  }
  if (!Array.isArray(value.comparisons) || value.comparisons.length < 1 || value.comparisons.length > 16) return false;
  const comparisonRefs = new Set<string>();
  for (const comparison of value.comparisons) {
    if (!mobileBridgeRecord(comparison) || !mobileBridgeExactKeys(comparison, [
      "comparisonRef", "baselineTaskId", "baselineTaskVersion", "currentTaskVersion",
      "evidenceType", "result", "receiptRefs", "evidenceCount", "metric",
    ])) return false;
    if (!mobileBridgeProjectionId(comparison.comparisonRef) || comparisonRefs.has(comparison.comparisonRef)) return false;
    comparisonRefs.add(comparison.comparisonRef);
    if (!mobileBridgeProjectionId(comparison.baselineTaskId)
      || comparison.baselineTaskId === value.taskId
      || !mobileBridgePositiveVersion(comparison.baselineTaskVersion)
      || comparison.currentTaskVersion !== value.canonicalTaskVersion
      || !["measured", "qualitative", "estimate"].includes(String(comparison.evidenceType))
      || !["improved", "no_change", "regression"].includes(String(comparison.result))
      || !mobileBridgeUniqueIds(comparison.receiptRefs, 1, 32)
      || !mobileBridgeBoundedCount(comparison.evidenceCount, 32) || Number(comparison.evidenceCount) < 1
      || !isMobileBridgeOneImprovementMetricDto(comparison.metric)
      || comparison.metric.type !== comparison.evidenceType) return false;
  }
  const hasImprovement = value.comparisons.some((comparison) => comparison.result === "improved");
  if (value.compoundingStep === "improved_result"
    && (!hasImprovement || value.attributionStatus !== "established")) return false;
  return true;
}

/** Durable-claim acknowledgement only; it never claims the proposed action ran. */
export interface MobileBridgeDecisionAnswerAcknowledgementDto {
  contractVersion: typeof ONE_DECISION_CONTRACT_VERSION;
  decisionId: string;
  taskId: string;
  taskVersion: number;
  status: "answer_claimed";
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
  lastError: "automation_failed" | "automation_partial" | "automation_blocked" | "automation_needs_input" | null;
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
  /**
   * Secret-free sha256(provider:accountIdentity) 앞 16 hex. 같은 구독 계정이
   * 여러 Desktop에 연결됐을 때 Mobile이 사용량 카드를 하나로 병합하는 기준.
   * identity를 모르면 null이고, null끼리는 절대 병합하지 않는다.
   */
  accountFingerprint: string | null;
}

/**
 * DESKTOP_MOBILE_BRIDGE: Cloud passthrough refusal. When the Agent Cloud server
 * refuses an owner action (owner_only, agent_not_found, no_cloud_package,
 * insufficient_credits, …) the exact server code is surfaced verbatim instead
 * of a fake success or a generic authority error. `actionState` is mandatory
 * whenever the server reports that part of a destructive action already
 * committed; callers must not interpret every refusal as a no-op.
 */
export interface MobileBridgeCloudRefusalDto {
  code: string;
  message: string;
  retryable?: boolean;
  expectedRevision?: number;
  currentRevision?: number;
  packageBytesRetained?: boolean;
  actionState?: "not-committed" | "partially-committed" | "unknown";
}

export interface MobileBridgeCloudUploadPreviewDto {
  agentLocalId: string;
  name: string;
  slug: string;
  entityKind: "agent" | "team";
  sourceReady: boolean;
  /** Bounded local estimate; null when the source folder is unavailable. */
  estimatedFileCount: number | null;
  visibility: "private-link";
}

export interface MobileBridgeCloudUploadSaveDto {
  slug: string;
  visibility: "private-link";
  status: "registered" | "registered-recovery-required";
  localSyncStored: boolean;
  recoveryRequired: boolean;
  recovery?: {
    code: "local_revision_receipt_not_saved";
    message: string;
  };
}

export interface MobileBridgeCloudDeleteResultDto {
  schema: "agentlas.agent_cloud.delete.v1";
  deleted: true;
  slug: string;
  scope: "owner-private" | "hub-public";
  operation?: "unpublished" | "already_unpublished";
  deletionMode: "hard-delete" | "soft-unpublish";
  deletedResource: "cloud-package" | "hub-listing";
  packageBytesRetained: boolean;
  reconciled?: boolean;
  revision: string;
  deletedAt: string;
}

export interface MobileBridgeCloudCombinationMemberDto {
  agentDefinitionId: string;
  agentReleaseId: string;
}

/** Owner-scoped cloud combination. Hub release references only; no package bytes. */
export interface MobileBridgeCloudCombinationDto {
  combinationId: string;
  name: string;
  description: string;
  members: MobileBridgeCloudCombinationMemberDto[];
  revision: number;
  updatedAt: string;
}

export interface MobileBridgeBuildQuestionDto {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export type MobileBridgeBuildStatus =
  | "running"
  | "awaiting-input"
  | "done"
  | "failed";

export interface MobileBridgeBuildRefusalDto {
  code:
    | "mobile_build_resume_unsupported"
    | "build_completion_unproven"
    | "desktop_approval_denied"
    | "desktop_approval_unavailable"
    | "desktop_approval_timed_out";
  message: string;
  retryable: boolean;
}

/**
 * DESKTOP_MOBILE_BRIDGE: Hephaestus build progress pushed over the ordered
 * event stream. Local workspace paths, runtime session ids, and raw build
 * results never cross the bridge; `text` is sanitized display copy only.
 */
export interface MobileBridgeBuildEventDto {
  runId: string;
  kind: "log" | "stage" | "partial" | "done" | "error" | "awaiting-input";
  status: MobileBridgeBuildStatus;
  stage?: string;
  text?: string;
  questions?: MobileBridgeBuildQuestionDto[];
  refusal?: MobileBridgeBuildRefusalDto;
  resumable?: false;
}

export interface MobileBridgeBuildStatusDto {
  status: MobileBridgeBuildStatus;
  summary: string | null;
  questions?: MobileBridgeBuildQuestionDto[];
  refusal?: MobileBridgeBuildRefusalDto;
  resumable?: false;
}

/**
 * Minimal, explicit-user-approved One identity projected to a paired device.
 * `profileContext`, principle scope refs, disabled principles, and any value
 * that required redaction are intentionally absent from this contract.
 */
export interface MobileBridgeOneProfileDto {
  contractVersion: "1.0.0";
  oneId: string;
  version: number;
  displayName: string;
  role: string;
  preferredLocale: "system" | "ko" | "en";
  timeZone: string | null;
  updatedAt: string;
  operatingPrinciples: Array<{
    id: string;
    content: string;
    scope: "personal" | "project" | "agent" | "team";
    approvalSource: "explicit_user";
    approvedAt: string;
    updatedAt: string;
  }>;
  omittedOperatingPrincipleCount: number;
}

export interface MobileBridgeOneBriefingCandidateDto {
  contractVersion: "1.0.0";
  candidateId: string;
  kind: "risk" | "opportunity" | "anomaly" | "repetition" | "decision" | "completion";
  reasonCode:
    | "project_folder_missing"
    | "project_folder_unreadable"
    | "project_folder_not_directory"
    | "project_deadline_conflict"
    | "automation_error"
    | "automation_blocked"
    | "automation_needs_input"
    | "automation_partial"
    | "task_waiting_decision_stale"
    | "task_running_without_active_run"
    | "task_failed_repeated"
    | "task_failed_abandoned"
    | "task_partial_abandoned";
  severity: 1 | 2 | 3 | 4;
  source: {
    kind: "project_folder" | "automation_run" | "canonical_task";
    refId: string;
    label: string;
  };
  detectedAt: string;
  expiresAt: string;
  confidence: "high" | "medium" | "low";
  preparedAction: {
    kind: "open_project" | "open_automation" | "open_task";
    targetId: string;
    label: string;
    /** Navigation only. Mobile cannot infer that execution has begun. */
    executionStarted: false;
  };
}

/**
 * Main-owned Briefing decision projected without detector inputs, raw paths,
 * raw scheduler errors, prompts, evidence payloads, or unsupported channels.
 * Mobile renders this exact candidate and never re-runs the detector.
 */
export interface MobileBridgeOneBriefingDto {
  contractVersion: "1.0.0";
  evaluatedAt: string;
  preferences: {
    cadence: "important_only" | "daily" | "weekdays" | "weekly";
    /** Only the channel that is actually implemented across this bridge. */
    channels: ["in_app"];
    quietHours: {
      enabled: boolean;
      startHour: number;
      endHour: number;
    };
    updatedAt: string;
  };
  candidate: MobileBridgeOneBriefingCandidateDto | null;
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
  /** Main-composed Task summaries. Every row is bound to this snapshot's host id. */
  taskProjections?: AgentlasOneTaskProjectionV1[];
  /**
   * Absent on older Desktop builds. New builds emit an empty array when there
   * is no current safe Decision so Mobile can clear stale approval UI.
   */
  oneDecisions?: MobileBridgeOneDecisionDto[];
  /** Absent on older builds; new Desktop builds emit [] to clear stale Mobile cards. */
  oneValueClosures?: MobileBridgeOneValueClosureDto[];
  /** Approved reuse only; no raw Memory or improvement assertion crosses the bridge. */
  oneExperienceReuseReceipts?: MobileBridgeOneExperienceReuseDto[];
  /** Actual persisted proof records only; Surface/result presence never creates a row. */
  oneImprovementProofs?: MobileBridgeOneImprovementProofDto[];
  /** Zero or one Main-selected, review-only ecosystem suggestion. */
  oneEcosystemSuggestions?: OneMobileEcosystemSuggestionV1[];
  /** System-only Task receipt for exact post-exchange pairing verification. */
  pairingVerificationTasks?: MobileBridgePairingTaskDto[];
  /** Absent when the authenticated Web producer is not shipped or not proven available. */
  ontologyChipProjections?: MobileBridgeOntologyProjectionDto[];
  /** Absent on older Desktop builds. Main remains the only profile authority. */
  oneProfile?: MobileBridgeOneProfileDto;
  /** Absent on older Desktop builds. Candidate selection is already complete in Main. */
  oneBriefing?: MobileBridgeOneBriefingDto;
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
  "groups.cloudList",
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

function optionalText(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const item = value[key];
  if (item === undefined || item === null) return null;
  if (
    typeof item !== "string" ||
    item.length > maxLength ||
    /[\u0000\u000b\u000c\u000e-\u001f]/.test(item)
  ) {
    return `${key} must be text of at most ${maxLength} characters`;
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

function validateImageAttachments(images: unknown): string | null {
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
  return null;
}

function validateInvokeOptions(
  params: Record<string, unknown>,
  allowObservedRunQuestion = false,
): string | null {
  const borrowAgents = params.borrowAgents;
  if (
    borrowAgents !== undefined &&
    (!Array.isArray(borrowAgents) ||
      borrowAgents.length > 8 ||
      borrowAgents.some((item) => typeof item !== "string" || item.length < 1 || item.length > 160))
  ) {
    return "borrowAgents must be an array of at most 8 non-empty strings";
  }
  const hasDecisionId = params.expectedQuestionMessageId !== undefined;
  const hasDecisionTaskId = params.expectedTaskId !== undefined;
  const hasDecisionTaskVersion = params.expectedTaskVersion !== undefined;
  const hasDecisionContract = params.expectedDecisionContractVersion !== undefined;
  const hasDecisionTaskBinding = hasDecisionTaskId || hasDecisionTaskVersion || hasDecisionContract;
  let decisionBindingError: string | null = null;
  if (hasDecisionTaskBinding || (hasDecisionId && !allowObservedRunQuestion)) {
    if (!hasDecisionId || !hasDecisionTaskId || !hasDecisionTaskVersion || !hasDecisionContract) {
      decisionBindingError = "Decision answers require expectedQuestionMessageId, expectedTaskId, expectedTaskVersion, and expectedDecisionContractVersion";
    } else if (params.expectedDecisionContractVersion !== ONE_DECISION_CONTRACT_VERSION) {
      decisionBindingError = "expectedDecisionContractVersion is unsupported";
    }
  }
  return firstError(
    validateImageAttachments(params.images),
    optionalString(params, "runId", 160),
    requiredString(params, "chatId", 256),
    optionalString(params, "expectedQuestionMessageId", 256),
    optionalString(params, "expectedTaskId", 256),
    optionalInteger(params, "expectedTaskVersion", 1, Number.MAX_SAFE_INTEGER),
    optionalString(params, "expectedDecisionContractVersion", 32),
    requiredText(params, "userPrompt", 200_000),
    validateEnum(params, "locale", ["ko", "en"]),
    validateEnum(params, "permissions", ["read", "write", "full"]),
    optionalBoolean(params, "planMode"),
    optionalBoolean(params, "goalMode"),
    optionalBoolean(params, "appsGenerateMode"),
    decisionBindingError,
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

/** Cloud combination members are exact immutable Hub release references. */
function validateCloudCombinationMembers(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    return "members must contain 1 to 32 exact Hub release references";
  }
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["agentDefinitionId", "agentReleaseId"])) {
      return "members entries accept only agentDefinitionId and agentReleaseId";
    }
    const error = firstError(
      ontologyRef(item.agentDefinitionId, "agentDefinitionId"),
      ontologyRef(item.agentReleaseId, "agentReleaseId"),
    );
    if (error) return error;
  }
  return null;
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
    case "groups.create": {
      if (!hasOnlyKeys(params, ["name", "description", "orchestratorName", "memberAgentIds"])) {
        return "groups.create contains unsupported fields";
      }
      const memberAgentIds = params.memberAgentIds;
      if (
        !Array.isArray(memberAgentIds) ||
        memberAgentIds.length < 1 ||
        memberAgentIds.length > 32 ||
        memberAgentIds.some(
          (item) =>
            typeof item !== "string" ||
            item.length < 1 ||
            item.length > 256 ||
            /[\u0000-\u001f]/.test(item),
        )
      ) {
        return "memberAgentIds must contain 1 to 32 bounded installed-agent ids";
      }
      return firstError(
        requiredString(params, "name", 120),
        optionalText(params, "description", 1_000),
        optionalString(params, "orchestratorName", 120),
      );
    }
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
      if (targetCount > 1) return "chats.create accepts at most one of agentId, firmId, or agentGroupId";
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
    case "tasks.acceptResult":
      return hasOnlyKeys(params, ["taskId", "expectedVersion", "expectedRunId"])
        ? firstError(
            requiredString(params, "taskId"),
            params.expectedVersion === undefined
              ? "expectedVersion is required"
              : optionalInteger(params, "expectedVersion", 1, Number.MAX_SAFE_INTEGER),
            requiredString(params, "expectedRunId", 160),
          )
        : "tasks.acceptResult accepts only taskId, expectedVersion, and expectedRunId";
    case "tasks.latestResult":
      return hasOnlyKeys(params, ["taskId", "chatId", "expectedVersion"])
        ? firstError(
            requiredString(params, "taskId"),
            requiredString(params, "chatId"),
            params.expectedVersion === undefined
              ? "expectedVersion is required"
              : optionalInteger(params, "expectedVersion", 1, Number.MAX_SAFE_INTEGER),
          )
        : "tasks.latestResult accepts only taskId, chatId, and expectedVersion";
    case "one.suggestions.act": {
      if (!hasOnlyKeys(params, [
        "schemaVersion", "action", "expectedStoreVersion", "suggestionId", "expectedSuggestionVersion",
        "originTaskId", "expectedTaskVersion", "valueClosureId", "expectedValueClosureVersion",
        "confirmedByUser", "reviewOnly",
      ])) return "one.suggestions.act contains unsupported fields";
      return firstError(
        params.schemaVersion === 1 ? null : "one.suggestions.act requires schemaVersion 1",
        validateEnum(params, "action", ["review", "snooze", "dismiss", "never_ask_again"], false),
        params.expectedStoreVersion === undefined
          ? "expectedStoreVersion is required"
          : optionalInteger(params, "expectedStoreVersion", 1, Number.MAX_SAFE_INTEGER),
        requiredString(params, "suggestionId", 160),
        params.expectedSuggestionVersion === undefined
          ? "expectedSuggestionVersion is required"
          : optionalInteger(params, "expectedSuggestionVersion", 1, Number.MAX_SAFE_INTEGER),
        requiredString(params, "originTaskId", 160),
        params.expectedTaskVersion === undefined
          ? "expectedTaskVersion is required"
          : optionalInteger(params, "expectedTaskVersion", 1, Number.MAX_SAFE_INTEGER),
        requiredString(params, "valueClosureId", 160),
        params.expectedValueClosureVersion === undefined
          ? "expectedValueClosureVersion is required"
          : optionalInteger(params, "expectedValueClosureVersion", 1, Number.MAX_SAFE_INTEGER),
        params.confirmedByUser === true ? null : "confirmedByUser must be true",
        params.reviewOnly === true ? null : "reviewOnly must be true",
      );
    }
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
    case "one.invoke.start":
      if (!hasOnlyKeys(params, ["schemaVersion", "userPrompt", "permissions", "images"])) {
        return "one.invoke.start contains unsupported fields";
      }
      return firstError(
        params.schemaVersion === 1 ? null : "one.invoke.start requires schemaVersion 1",
        requiredText(params, "userPrompt", 200_000),
        typeof params.userPrompt === "string" && params.userPrompt.trim().length > 0
          ? null
          : "one.invoke.start userPrompt must contain visible text",
        validateEnum(params, "permissions", ["read", "write", "full"]),
        validateImageAttachments(params.images),
      );
    case "invoke.start":
      if (!hasOnlyKeys(params, ["runId", "chatId", "userPrompt", "locale", "permissions", "planMode", "goalMode", "appsGenerateMode", "borrowAgents", "images", "expectedQuestionMessageId", "expectedTaskId", "expectedTaskVersion", "expectedDecisionContractVersion"])) {
        return "invoke.start contains unsupported fields";
      }
      return validateInvokeOptions(params);
    case "invoke.steer":
      if (!hasOnlyKeys(params, ["runId", "chatId", "userPrompt", "locale", "permissions", "planMode", "goalMode", "appsGenerateMode", "borrowAgents", "images", "expectedRunId", "expectedQuestionMessageId", "expectedTaskId", "expectedTaskVersion", "expectedDecisionContractVersion"])) {
        return "invoke.steer contains unsupported fields";
      }
      return firstError(validateInvokeOptions(params, true), requiredString(params, "expectedRunId", 160));
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
    case "agents.cloudUploadPreview":
      return hasOnlyKeys(params, ["agentLocalId"])
        ? requiredString(params, "agentLocalId")
        : "agents.cloudUploadPreview accepts only agentLocalId";
    case "agents.cloudUploadSave":
      return hasOnlyKeys(params, ["agentLocalId", "idempotencyKey"])
        ? firstError(
            requiredString(params, "agentLocalId"),
            requiredString(params, "idempotencyKey", 160),
          )
        : "agents.cloudUploadSave accepts only agentLocalId and idempotencyKey";
    case "agents.cloudDelete":
      return hasOnlyKeys(params, ["slug", "idempotencyKey"])
        ? firstError(
            requiredString(params, "slug", 160),
            requiredString(params, "idempotencyKey", 160),
          )
        : "agents.cloudDelete accepts only slug and idempotencyKey";
    case "build.start":
      return hasOnlyKeys(params, ["goal", "idempotencyKey"])
        ? firstError(
            requiredText(params, "goal", 20_000),
            requiredString(params, "idempotencyKey", 160),
          )
        : "build.start accepts only goal and idempotencyKey";
    case "build.status":
      return hasOnlyKeys(params, ["runId"])
        ? requiredString(params, "runId", 160)
        : "build.status accepts only runId";
    case "groups.cloudSave": {
      if (!hasOnlyKeys(params, [
        "name",
        "description",
        "members",
        "combinationId",
        "expectedRevision",
        "idempotencyKey",
      ])) {
        return "groups.cloudSave contains unsupported fields";
      }
      const hasCombinationId = params.combinationId !== undefined;
      const hasExpectedRevision = params.expectedRevision !== undefined;
      if (hasCombinationId !== hasExpectedRevision) {
        return "groups.cloudSave updates require combinationId and expectedRevision together";
      }
      const membersError = validateCloudCombinationMembers(params.members);
      if (membersError) return membersError;
      return firstError(
        requiredString(params, "name", 120),
        optionalText(params, "description", 1_000),
        hasCombinationId ? requiredString(params, "combinationId", 128) : null,
        hasExpectedRevision
          ? optionalInteger(params, "expectedRevision", 1, Number.MAX_SAFE_INTEGER)
          : null,
        requiredString(params, "idempotencyKey", 160),
      );
    }
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
  if (!isRecord(input) || !hasOnlyKeys(input, [
    "v",
    "type",
    "id",
    "code",
    "pairingAttemptId",
    "deviceNonce",
    "pairingAssertion",
    "audience",
    "device",
  ])) {
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
  if (
    typeof input.pairingAttemptId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(input.pairingAttemptId) ||
    typeof input.deviceNonce !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.deviceNonce) ||
    typeof input.pairingAssertion !== "string" ||
    input.pairingAssertion.length > 4096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(input.pairingAssertion) ||
    input.audience !== MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE
  ) {
    return { ok: false, error: mobileBridgePairFailure(id, "invalid_pairing_request", "Invalid account assertion binding") };
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
      pairingAttemptId: input.pairingAttemptId,
      deviceNonce: input.deviceNonce,
      pairingAssertion: input.pairingAssertion,
      audience: MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE,
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
