import type { OneSurfaceManifestV1 } from "./one-surface";
import type { AgentlasOneTaskProjectionV1 } from "./one-task-projection";
import { ONE_DECISION_CONTRACT_VERSION, type OneDecisionViewV1 } from "./one-decision";
import type { OneMobileEcosystemSuggestionV1 } from "./one-mobile-suggestion";
import { PROJECT_AGENT_POOL_MAX } from "./project-agent-pool";
import {
  ONE_BRIEFING_CONTRACT_VERSION,
  type OneBriefingCadence,
  type OneBriefingConfidence,
  type OneBriefingKind,
  type OneBriefingPreparedActionKind,
  type OneBriefingReasonCode,
  type OneBriefingSourceKind,
} from "./one-briefing-contract.generated";
// runtime-kinds/runtime-backends import nothing but `./types` (type-only), so
// the dependency-free contract below stays dependency-free at runtime.
import { RUNTIME_KINDS } from "./runtime-kinds";
import { RUNTIME_BACKENDS } from "./runtime-backends";

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
  "one.org.get",
  "one.org.add",
  "one.org.openMember",
  "one.org.markRead",
  "firms.list",
  "projects.list",
  "projects.get",
  "projects.setAgentPool",
  "chats.listRecent",
  "chats.get",
  "chats.rename",
  "chats.archive",
  "chats.unarchive",
  "chats.setContinuousMode",
  "chats.setSwarmMode",
  "chats.clearContext",
  "chats.setRuntimeSelection",
  "tasks.createProject",
  "tasks.latestResult",
  // Mobile terminal is deliberately a separate, opt-in authority. The
  // Desktop runtime must inject an existing terminal controller; the bridge
  // never turns an arbitrary string into a shell command by itself.
  "terminal.read",
  "terminal.preview",
  "terminal.takeover",
  "terminal.release",
  "terminal.dispatch",
  "terminal.cancel",
  "one.artifacts.recent",
  "one.artifact.imagePreview",
  "chat.attachment.imagePreview",
  "tasks.acceptResult",
  "one.suggestions.act",
  "workspace.setProject",
  "workspace.clear",
  "composer.context",
  "plugins.list",
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
  // 동기 런타임 질문 — 기존 chat Decision/도구 승인과 섞지 않는다.
  "runtime.submitUserInput",
  // 런타임 도구 승인 — 데스크탑의 승인 칩과 같은 결정을 폰에서도 답한다.
  // 투영만 하고 답을 못 하게 두면 "보이는데 누를 수 없는" 반쪽 배선이 된다.
  "runtime.resolveToolApproval",
  "automations.list",
  "automations.get",
  "automations.toggle",
  "automations.runNow",
  "automations.setRuntime",
  "automations.listRuns",
  "usage.snapshot",
  "runtime.detect",
  "runtime.setActive",
  "runtime.listRoleMembers",
  "runtime.setRoleMembers",
  "hub.borrowable.list",
  "billing.credits",
  "hephaestus.engineToggles",
  "hephaestus.routePreview",
  "ontology.projections.list",
  "ontology.attach.resolve",
  "agents.cloudUploadPreview",
  "agents.cloudUploadSave",
  "agents.cloudPublishHub",
  "cloud.setHubPrices",
  "agents.cloudDelete",
  "build.start",
  "build.status",
  "build.answer",
  "device.revokeSelf",
] as const;

export type MobileBridgeMethod = (typeof MOBILE_BRIDGE_METHODS)[number];

/** State-changing methods require durable replay protection in Desktop main. */
export const MOBILE_BRIDGE_WRITE_METHODS: ReadonlySet<MobileBridgeMethod> = new Set([
  "device.revokeSelf",
  "chats.rename",
  "chats.archive",
  "chats.unarchive",
  "chats.setContinuousMode",
  "chats.setSwarmMode",
  "chats.clearContext",
  "chats.setRuntimeSelection",
  "projects.setAgentPool",
  "one.org.add",
  "one.org.openMember",
  "one.org.markRead",
  "tasks.createProject",
  "tasks.acceptResult",
  "terminal.takeover",
  "terminal.release",
  "terminal.dispatch",
  "terminal.cancel",
  "one.suggestions.act",
  "workspace.setProject",
  "workspace.clear",
  "one.invoke.start",
  "invoke.start",
  "invoke.steer",
  "invoke.cancel",
  "browser.resolveApproval",
  "runtime.submitUserInput",
  "runtime.resolveToolApproval",
  "automations.toggle",
  "automations.runNow",
  "automations.setRuntime",
  "runtime.setActive",
  "runtime.setRoleMembers",
  "ontology.attach.resolve",
  "agents.cloudUploadSave",
  "agents.cloudPublishHub",
  "cloud.setHubPrices",
  "agents.cloudDelete",
  "build.start",
  "build.answer",
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
  /** Interactive One/Work steering settles the current one-shot run after the replacement is durable. */
  steeringMode?: "queue" | "interrupt";
  planMode?: boolean;
  goalMode?: boolean;
  networkMode?: boolean;
  appsGenerateMode?: boolean;
  stormbreakerMode?: boolean;
  taskForceTargets?: MobileBridgeTurnAgentTargetDto[];
  images?: MobileBridgeImageAttachmentDto[];
  expectedQuestionMessageId?: string;
  expectedTaskId?: string;
  expectedTaskVersion?: number;
  expectedDecisionContractVersion?: typeof ONE_DECISION_CONTRACT_VERSION;
  expectedRunId: string;
}

/** Explicit turn-only sub-agent request. It never changes the chat controller. */
export type MobileBridgeTurnAgentTargetDto =
  | { source: "local"; entityKind: "agent"; agentId: string }
  | { source: "cloud" | "hub"; entityKind: "agent"; slug: string };

/**
 * Closed first-turn contract for the consumer-facing One surface on Mobile.
 *
 * The phone deliberately cannot select a chat owner, agent, firm,
 * project, runtime, Hub route, durable borrowed target, Task, Profile, or
 * Memory capability. Desktop Main creates the conversation and derives every
 * such authority from its current authenticated host state. Permission is an
 * optional explicit user override; omission leaves the normal One choice to
 * Desktop Main. Goal, Plan, Network, and Live are also optional explicit
 * overrides. Omission means One decides for that turn.
 */
export interface MobileBridgeOneInvokeStartParams {
  schemaVersion: 1;
  userPrompt: string;
  permissions?: "read" | "write" | "full";
  planMode?: boolean;
  goalMode?: boolean;
  networkMode?: boolean;
  liveMode?: boolean;
  taskForceTargets?: MobileBridgeTurnAgentTargetDto[];
  images?: MobileBridgeImageAttachmentDto[];
}

/** Exact accepted start identity. Any later Task is projected by snapshot.updated. */
export interface MobileBridgeOneInvokeStartReceiptDto {
  schemaVersion: 1;
  authoritativeHostRef: string;
  chatId: string;
  runId: string;
}

/**
 * The Mobile terminal is a capability projection, not a shell transport.
 * Desktop may expose these DTOs only when it already has an authoritative
 * terminal controller. In particular, no cwd, environment, executable path,
 * provider session, or raw process handle crosses this contract.
 */
export type MobileBridgeTerminalOwner = "agent" | "mobile" | "none";
export type MobileBridgeTerminalRisk = "safe" | "dangerous";
export type MobileBridgeTerminalRefusalCode =
  | "terminal_unavailable"
  | "terminal_offline"
  | "terminal_not_found"
  | "terminal_owner_conflict"
  | "terminal_epoch_conflict"
  | "terminal_preview_required"
  | "terminal_preview_expired"
  | "terminal_approval_required"
  | "terminal_request_not_found"
  | "terminal_control_unavailable";

export interface MobileBridgeTerminalRefusalDto {
  schemaVersion: 1;
  status: "refused";
  code: MobileBridgeTerminalRefusalCode;
  message: string;
}

export type MobileBridgeTerminalWriteMethod =
  | "terminal.takeover"
  | "terminal.release"
  | "terminal.dispatch"
  | "terminal.cancel";

/** Exact negative receipt for one protected terminal write. */
export interface MobileBridgeTerminalWriteRefusalDto
  extends MobileBridgeTerminalRefusalDto {
  method: MobileBridgeTerminalWriteMethod;
  terminalId: string;
  idempotencyKey: string;
}

export interface MobileBridgeTerminalLineDto {
  seq: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface MobileBridgeTerminalReadDto {
  schemaVersion: 1;
  terminalId: string;
  status: "ready" | "busy" | "unavailable";
  owner: MobileBridgeTerminalOwner;
  ownerEpoch: number;
  lines: MobileBridgeTerminalLineDto[];
  nextSeq: number;
  truncated: boolean;
  refusal?: MobileBridgeTerminalRefusalDto;
  /** Live previews let Mobile resume the same protected intent after remount. */
  pendingPreviews?: MobileBridgeTerminalPreviewDto[];
  /** Recent exact requests reconcile response loss and restore cancellation. */
  requests?: MobileBridgeTerminalRequestDto[];
}

export interface MobileBridgeTerminalRequestDto {
  requestId: string;
  status: "queued" | "running" | "completed" | "cancelled";
  startedAt: string;
}

export interface MobileBridgeTerminalPreviewDto {
  schemaVersion: 1;
  terminalId: string;
  previewId: string;
  /** Present for dangerous commands that have an outstanding live approval. */
  approvalId?: string;
  command: string;
  risk: MobileBridgeTerminalRisk;
  requiresApproval: boolean;
  ownerEpoch: number;
  expiresAt: string;
}

export interface MobileBridgeTerminalTakeoverDto {
  schemaVersion: 1;
  terminalId: string;
  owner: "mobile";
  ownerEpoch: number;
}

export interface MobileBridgeTerminalReleaseDto {
  schemaVersion: 1;
  terminalId: string;
  owner: "agent";
  ownerEpoch: number;
}

export interface MobileBridgeTerminalDispatchDto {
  schemaVersion: 1;
  terminalId: string;
  requestId: string;
  status: "queued" | "running" | "completed" | "cancelled";
  ownerEpoch: number;
}

export interface MobileBridgeTerminalCancelDto {
  schemaVersion: 1;
  terminalId: string;
  requestId: string;
  status: "cancelled";
  ownerEpoch: number;
}

export interface MobileBridgeImageAttachmentDto {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  name?: string;
  /** Pure base64, never a data URL. Desktop decodes and enforces 5 MiB. */
  data: string;
}

/** Secret-free installed MCP inventory shown in One's Mobile composer. */
export interface MobileBridgePluginDto {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  enabled: boolean;
  ready: boolean;
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

/**
 * DESKTOP_MOBILE_BRIDGE: The one value that identifies a tool call, rendered.
 *
 * Derived on Desktop by the shared `normalizeToolCall` + `buildToolCallDisplay`
 * pair (shared/tool-call-detail.ts) so the phone never re-derives tool
 * semantics from a runner-specific name. Paths are already cwd-relative
 * (`stripCwdPrefix`) and every string passes the bridge sanitizer, so raw args
 * and results still stay on Desktop.
 */
export interface MobileBridgeToolCallDisplayDto {
  /** Runner-independent semantic kind: shell / read / edit / search / … */
  kind: string;
  /**
   * Both locales are always emitted together. The phone has a live EN·KO
   * toggle, so a single-locale projection would render the wrong language for
   * every event already received when the user flips it.
   */
  displayNameKo: string;
  displayNameEn: string;
  /** The single identifying value — command, path, query, or URL. Locale-free. */
  summary?: string;
  /** Trailing facts: `+23 −1`, `exit 0`, `8 files · 31 matches`. */
  factsKo?: string;
  factsEn?: string;
  /**
   * The call failed. A separate flag, not inferred from `errorText`: the
   * failure reason is frequently unsendable (it carries paths or secrets), and
   * a row that drops the reason must still be drawn as a failure rather than
   * as a success.
   */
  failed?: boolean;
  /** Present only when the call failed AND the reason itself is safe to send. */
  errorText?: string;
}

export interface MobileBridgeInvocationToolDto {
  name: string;
  id: string | null;
  isError: boolean;
  input: MobileBridgeToolPayloadSummaryDto | null;
  output: MobileBridgeToolPayloadSummaryDto | null;
  /** Optional so an older Desktop keeps working against a newer phone. */
  display?: MobileBridgeToolCallDisplayDto;
}

export interface MobileBridgeInvocationArtifactDto {
  /** Exact Main-owned binding only; never a local path or preview capability. */
  taskId: string;
  taskVersion: number;
  chatId: string;
  runId: string;
  manifestId: string;
  artifactRef: string;
  label: string;
  type: "document" | "spreadsheet" | "image" | "video" | "audio" | "archive" | "data" | "other";
  sizeBytes?: number;
  /** Optional immutable content identity used to collapse repeated reads. */
  contentSha256?: string;
}

export interface MobileBridgeOneArtifactsPageDto {
  schemaVersion: 1;
  items: MobileBridgeInvocationArtifactDto[];
  nextCursor: string | null;
}

export interface MobileBridgeInvocationEventDto {
  kind: "thinking" | "tool-use" | "partial" | "final" | "error" | "surface" | "usage" | "reasoning" | "notice";
  status?: string;
  /**
   * kind:"notice" only — what the HOST says, with its own severity.
   *
   * A host notice must never be appended to the model's answer string; it gets
   * its own row. Without the severity the phone cannot tell "context compacted"
   * from "the surface could not be parsed", so both are projected together.
   * `display: "divider"` marks a conversation boundary rather than a message.
   */
  noticeLevel?: "info" | "success" | "warning" | "error";
  noticeDisplay?: "row" | "divider";
  /**
   * kind:"notice" only — the same sentence in both product locales.
   *
   * `status` carries the sentence in the locale the RUN used. A run started on
   * the Desktop uses the Desktop's locale, so a phone set to the other language
   * that attaches to it reads a foreign-language row. The sentence is already
   * rendered by the time it reaches this projector, so the producing site emits
   * both and the phone picks its own. Absent for older Desktops — the phone
   * falls back to `status`, which is what it always showed.
   */
  noticeTextKo?: string;
  noticeTextEn?: string;
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
  reasoning?: { phase: "start" | "end"; durationMs?: number; /** end only — the span's bounded, redacted summary text. */ text?: string };
  /** Bounded exact bindings let Mobile keep prior-run outputs without receiving paths. */
  oneArtifacts?: MobileBridgeInvocationArtifactDto[];
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
  /** Secret-free marker for a retained runtime whose credential cannot be read. */
  credentialUnavailable?: boolean;
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
  source: "local" | "agent-cloud" | "hub";
  /** Installed on this Desktop, or merely available from the owner's Cloud shelf. */
  availability: "installed" | "cloud";
  toolLabels: string[];
  kind: "agent" | "team";
  visibility: "visible" | "background" | "private";
  requiresSetup: boolean;
  /**
   * Whether Desktop would accept this agent as a project-pool member.
   * `visibility` alone cannot decide it — a materialized HQ cell with an empty
   * system prompt is also refused — and the prompt itself never crosses the
   * bridge, so the phone must not re-derive this rule.
   */
  projectSelectable: boolean;
  /**
   * Immutable Hub identity. Both fields are emitted together or both omitted.
   * A slug, package hash, or latest release is never used as a substitute.
   */
  agentDefinitionId?: string;
  agentReleaseId?: string;
  /**
   * Agent Cloud shelf identity — a DIFFERENT thing from the Hub binding above.
   *
   * `cargo.search_agents` returns cloudId/manifestId/revision and never a
   * definition/release pair, so requiring a Hub binding to show a cloud row hid
   * the owner's entire shelf (measured: 50 rows, 1 shown). Fabricating
   * `agentDefinitionId` from these values would break the rule directly above,
   * so cloud identity gets its own field instead.
   */
  cloudEntity?: {
    cloudId?: string;
    manifestId?: string;
    revision?: string;
  };
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

export interface MobileBridgeProjectDto {
  id: string;
  name: string;
  description: string | null;
  sourceType: "local" | "github" | "sample";
  /** Safe source identity only: folder basename, repository host/path, or sample id. */
  sourceLabel: string | null;
  systemPrompt: string | null;
  agentPool: Array<{
    entityKind: "agent" | "team";
    targetId: string;
    agentId: string | null;
    firmId: string | null;
    controllerAgentId: string | null;
    name: string;
    source: "local" | "cloud" | "hub";
    releaseId: string | null;
    order: number;
  }>;
  /** @deprecated Project pool rows are tools, not the Work controller. */
  controllerAgentId: string | null;
  controllerName: string | null;
  agentCount: number;
  hasWorkingFolder: boolean;
  files: Array<{
    path: string;
    kind: "file" | "directory";
    updatedAt: string | null;
  }>;
  latestResult: {
    summary: string;
    updatedAt: string;
    taskId: string | null;
  } | null;
  memory: {
    sources: Array<{
      kind: "pm_soul" | "sitemap" | "code_map";
      status: "ready" | "missing" | "invalid" | "unavailable";
    }>;
    entries: Array<{
      id: string;
      summary: string;
      occurredAt: string;
      taskId: string | null;
    }>;
    truncated: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

/** Rich fields are populated only by projects.get, never by snapshot/list projection. */
export type MobileBridgeProjectDetailDto = MobileBridgeProjectDto;

/**
 * One project tool the phone asks Desktop to keep attached.
 *
 * DESKTOP_MOBILE_BRIDGE: the phone deliberately cannot send a display name.
 * Desktop resolves `nameSnapshot` from the installed agent (local) or from the
 * member already bound to this project (cloud/hub), so a mobile write can never
 * relabel an agent or mint a new remote binding.
 */
export interface MobileBridgeProjectAgentPoolMemberInput {
  entityKind: "agent" | "team";
  targetId: string;
  agentId?: string | null;
  firmId?: string | null;
  controllerAgentId?: string | null;
  source: "local" | "cloud" | "hub";
  releaseId?: string | null;
}

export interface MobileBridgeProjectAgentPoolParams {
  projectId: string;
  /** Stable display order only. No pool row owns the Work session. */
  members: MobileBridgeProjectAgentPoolMemberInput[];
  /**
   * Ordered `source:entityKind:targetId:releaseId` keys observed before editing.
   * A mismatch means Desktop restaffed the project meanwhile, and the write is
   * refused instead of overwriting the newer pool.
   */
  expectedMemberKeys: string[];
}

export interface MobileBridgeProjectTaskStartParams {
  projectId: string;
  title?: string;
}

export interface MobileBridgeProjectTaskStartReceiptDto {
  projectId: string;
  taskId: string;
  chatId: string;
  title: string;
  controllerAgentId: string;
  /** Exact durable Work chat created by this action; Mobile must validate it before pin/invoke. */
  chat: MobileBridgeChatDto;
}

export interface MobileBridgeChatDto {
  id: string;
  /** Main-owned origin marker. Titles or coordinator names are never used to infer this. */
  oneOrigin: boolean;
  /** Null only for a general One conversation that has not become a Task. */
  taskId: string | null;
  taskVersion: number | null;
  /** Main-owned Task state. Mobile must not infer completion from message text. */
  taskStatus: "open" | "running" | "waiting-decision" | "partial" | "completed" | "failed" | "cancelled" | "archived" | null;
  taskUpdatedAt: string | null;
  projectId: string | null;
  /** Basename only. Absolute Desktop paths never cross the bridge. */
  workingFolderName: string | null;
  firmId: string | null;
  agentId: string;
  title: string;
  /** Main-bounded latest user/assistant line used by the One session directory. */
  lastMessagePreview?: string;
  /** Durable One seat snapshot. The session remains renderable after a seat is dissolved. */
  seatId?: string | null;
  seatLabel?: string | null;
  seatKind?: "solo" | "group" | null;
  participants?: Array<{
    slot: number;
    agentId: string | null;
    displayName: string;
  }> | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  continuousMode: boolean;
  swarmMode: boolean;
  /** Exact Desktop-owned model pin for this chat; null follows role defaults. */
  runtimeSelection: MobileBridgeRuntimeSelectionDto | null;
  active: boolean;
}

/** Secret-free runtime selection. Desktop source paths never cross Mobile. */
export interface MobileBridgeRuntimeSelectionDto {
  kind: string;
  backend: string | null;
  model: string | null;
  effort: string | null;
  longContext: boolean;
  role: "orchestrator" | "worker";
  inherit: boolean;
}

export interface MobileBridgeRuntimeRoleMemberDto {
  role: "orchestrator" | "worker";
  position: number;
  selection: MobileBridgeRuntimeSelectionDto;
  updatedAt: string;
}

export interface MobileBridgeRuntimeRolePoolSkipDto {
  position: number;
  kind: string;
  model: string | null;
  reason: "runtime-unavailable" | "model-unavailable" | "quota-exceeded";
}

export interface MobileBridgeRuntimeRolePoolPickDto {
  role: "orchestrator" | "worker";
  selection: MobileBridgeRuntimeSelectionDto;
  position: number | null;
  inherited: boolean;
  skipped: MobileBridgeRuntimeRolePoolSkipDto[];
}

export interface MobileBridgeRuntimeRolePoolDto {
  members: {
    orchestrator: MobileBridgeRuntimeRoleMemberDto[];
    worker: MobileBridgeRuntimeRoleMemberDto[];
  };
  picks: {
    orchestrator?: MobileBridgeRuntimeRolePoolPickDto;
    worker?: MobileBridgeRuntimeRolePoolPickDto;
  };
}

export interface MobileBridgeChatImageDto {
  /** Opaque Main-owned attachment identity. It is not a path or renderer URL. */
  attachmentId: string;
}

export interface MobileBridgeChatFileDto {
  /** Opaque Main-owned chat-file identity. It is not a path or renderer URL. */
  attachmentId: string;
  /** Opaque group identity used only to associate files with this user turn. */
  groupId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  kind: "file" | "directory";
  /** Directory entry count only; paths and the manifest never cross the bridge. */
  entryCount?: number;
}

export interface MobileBridgeChatMessageDto {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  /** Bounded references; bytes are fetched only for an exact chat/message binding. */
  images?: MobileBridgeChatImageDto[];
  /** Bounded generic-file metadata; raw paths, URLs, bytes, and manifests stay on Desktop. */
  files?: MobileBridgeChatFileDto[];
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
 * One live Desktop `askUser` request. This is neither a chat Decision nor a
 * permission approval: Mobile may submit exactly one answer (or decline) to
 * the waiting runtime request id.
 */
export interface MobileBridgeUserInputDto {
  requestId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowFreeText: boolean;
  askedBy?: string;
  /** Only chat-bound One/Work questions cross the bridge. */
  chatId: string;
  createdAt: string;
  expiresAt: string;
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

/** 데스크탑 ToolApprovalRequestEvent(shared/types.ts)의 폰 투영 — 값 그대로, 경로·비밀 없음. */
export interface MobileBridgeToolApprovalDto {
  id: string;
  runtime: string;
  tool: string;
  detail?: string;
  cwd?: string;
  mode: "live" | "post-denial";
  deniedBy?: "runtime-headless" | "sandbox";
  requestedAt: string;
  /** Main's exact automatic-denial deadline for live requests. */
  expiresAt?: string;
  chatId?: string;
  /** 능력 클래스(execute|edit|delete|network|other) — "항상 허용"이 무엇을 여는지 카드가 말한다. */
  capability?: string;
  agentId?: string;
}

export interface MobileBridgeAutomationDto {
  id: string;
  name: string;
  /**
   * Stored label. Legacy rows keep a bare cron expression here, which is why
   * `*​/20 * * * *` reached the phone's schedule row verbatim. Prefer the two
   * localized fields below for display and keep this one as the raw fact.
   */
  scheduleHuman: string;
  /** Human sentence per locale. Both ship together — the phone toggles EN·KO live. */
  scheduleHumanKo?: string;
  scheduleHumanEn?: string;
  /**
   * The cron expression when the schedule really is one, so the phone can offer
   * it as secondary detail instead of as the headline.
   */
  scheduleCron?: string;
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
  /** Same preallocated identity in queued, running, history, progress, and final projections. */
  runId: string | null;
  runState: "unknown" | "idle" | "queued" | "running" | "completed" | "failed";
  /** Stable marker only; raw scheduler errors may contain local paths. */
  lastError: "automation_failed" | "automation_partial" | "automation_blocked" | "automation_needs_input" | null;
  /** Secret-free topology only. Node configs, prompts, paths and credentials stay on Desktop. */
  graph: {
    nodes: Array<{ id: string; type: string; label: string; x: number; y: number }>;
    edges: Array<{ id: string; source: string; target: string; label: string | null }>;
  } | null;
  /** Exact Desktop-owned model pin; null follows the automation role default. */
  runtimeSelection: MobileBridgeRuntimeSelectionDto | null;
}

export interface MobileBridgeUsageWindowDto {
  id: string;
  label: string;
  kind: "5h" | "7d" | "monthly" | "daily" | "unknown";
  usedPercent: number;
  resetAt: number | null;
  windowDurationMins: number | null;
  limitId: string | null;
  limitName: string | null;
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

/**
 * DESKTOP_MOBILE_BRIDGE: Public Hub registration receipt for one of the user's
 * OWN registered agents/teams. It reuses the exact Desktop
 * `cloudAgents:publishRegisteredPublic` pipeline (marketplace + static-only
 * local review); every server refusal (fork copies, seat plans, slug identity
 * conflicts, …) surfaces verbatim through `refusal` instead of this DTO.
 */
export interface MobileBridgeHubPublishDto {
  slug: string;
  visibility: "marketplace";
  status: "registered" | "registered-recovery-required";
  /** The server-issued immutable release revision for this exact package. */
  releaseVersion: string;
  packageHash: string;
  marketplaceUrl?: string;
  localSyncStored: boolean;
  recoveryRequired: boolean;
  recovery?: {
    code: "local_revision_receipt_not_saved";
    message: string;
  };
}

export const MOBILE_BRIDGE_HUB_PRICE_KINDS = ["RENT", "INGEST", "FORK"] as const;
export type MobileBridgeHubPriceKind = (typeof MOBILE_BRIDGE_HUB_PRICE_KINDS)[number];

/**
 * Result of the authenticated `/api/account/rates` pricing patch for an
 * already-published Hub listing. A pricing failure is never a failed publish:
 * the listing stays live (and free) exactly like Desktop's own pricing flow.
 * Server bounds/rejections travel inside `refusal` with the server's numbers.
 */
export interface MobileBridgeHubPricesDto {
  ok: true;
  changed: boolean;
  prices: Partial<Record<MobileBridgeHubPriceKind, number>>;
}

export interface MobileBridgeHubPriceRefusalDto {
  code: string;
  message: string;
  kind?: string;
  minCredits?: number;
  maxCredits?: number;
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

export interface MobileBridgeBuildQuestionDto {
  /** Stable within one question set; answers must bind to this id. */
  questionId: string;
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
    | "build_answer_stale"
    | "build_answer_invalid"
    | "build_answer_in_progress"
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
  questionSetId?: string;
  questions?: MobileBridgeBuildQuestionDto[];
  refusal?: MobileBridgeBuildRefusalDto;
  resumable?: boolean;
}

export interface MobileBridgeBuildStatusDto {
  status: MobileBridgeBuildStatus;
  summary: string | null;
  questionSetId?: string;
  questions?: MobileBridgeBuildQuestionDto[];
  refusal?: MobileBridgeBuildRefusalDto;
  resumable?: boolean;
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
  contractVersion: typeof ONE_BRIEFING_CONTRACT_VERSION;
  candidateId: string;
  kind: OneBriefingKind;
  reasonCode: OneBriefingReasonCode;
  severity: 1 | 2 | 3 | 4;
  source: {
    kind: OneBriefingSourceKind;
    refId: string;
    label: string;
  };
  detectedAt: string;
  expiresAt: string;
  confidence: OneBriefingConfidence;
  preparedAction: {
    kind: OneBriefingPreparedActionKind;
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
  contractVersion: typeof ONE_BRIEFING_CONTRACT_VERSION;
  evaluatedAt: string;
  preferences: {
    cadence: OneBriefingCadence;
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

export interface MobileBridgeOneMemoryMapDto {
  contractVersion: "1.0.0";
  generatedAt: string;
  sourceRevision: string;
  clusterCount: number;
  totalNodeCount: number;
  totalEdgeCount: number;
  truncated: boolean;
  nodes: Array<{
    id: string;
    kind: string;
    scope: string;
    projectSlug: string | null;
    x: number;
    y: number;
    density: number;
    /**
     * Counts only — never the memory's content or evidence. Desktop's own map
     * shows these two on hover, and the phone could not mirror that panel
     * without them.
     */
    relationCount: number;
    evidenceCount: number;
  }>;
  edges: Array<{ from: string; to: string; relation: string }>;
}

export interface MobileBridgeSnapshot {
  schemaVersion: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  generatedAt: string;
  host: MobileBridgeHostDto;
  runtimes: MobileBridgeRuntimeDto[];
  agents: MobileBridgeAgentDto[];
  firms: MobileBridgeFirmDto[];
  projects: MobileBridgeProjectDto[];
  chats: MobileBridgeChatDto[];
  messages: Record<string, MobileBridgeChatMessageDto[]>;
  pendingConfirmations: MobileBridgePendingConfirmationDto[];
  pendingBrowserApprovals: MobileBridgeBrowserApprovalDto[];
  /**
   * 실행 전에 사람을 기다리는 런타임 도구 승인. 옛 Desktop 빌드에는 없으므로 optional 이고,
   * 새 빌드는 대기가 없을 때 빈 배열을 보내 폰이 낡은 카드를 지울 수 있게 한다.
   */
  pendingToolApprovals?: MobileBridgeToolApprovalDto[];
  /** Live synchronous runtime questions; [] clears cards resolved elsewhere. */
  pendingUserInputs?: MobileBridgeUserInputDto[];
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
  /** Bounded, content-free mirror of Desktop One's durable memory topology. */
  oneMemoryMap?: MobileBridgeOneMemoryMapDto;
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
  "one.org.get",
  "firms.list",
  "projects.list",
  "plugins.list",
  "invoke.activeChats",
  "confirm.listPending",
  "automations.list",
  "runtime.detect",
  "runtime.listRoleMembers",
  "hub.borrowable.list",
  "billing.credits",
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

// The wire validator must accept exactly the kinds/backends the Desktop can
// run. Both lists used to be hand-typed here, and the hand-typed kinds list
// silently missed "acp": a phone that picked the ACP engine was refused with
// invalid_params in parseMobileBridgeRequest — before authority.ts (which had
// already been derived from the canonical arrays) ever saw the frame. Derive
// them so the next union member is a compile error in runtime-kinds.ts, not a
// wire-level refusal only a paired phone can reproduce.
const MOBILE_RUNTIME_KINDS = RUNTIME_KINDS;

const MOBILE_RUNTIME_BACKENDS = RUNTIME_BACKENDS;

function validateRuntimeSelectionValue(
  value: unknown,
  role?: "orchestrator" | "worker",
): string | null {
  if (!isRecord(value)) return "runtime selection must be an object";
  if (!hasOnlyKeys(value, ["kind", "backend", "model", "effort", "longContext", "role", "inherit"])) {
    return "runtime selection contains unsupported fields";
  }
  const selectedRole = value.role ?? role;
  return firstError(
    validateEnum(value, "kind", MOBILE_RUNTIME_KINDS, false),
    validateEnum(value, "backend", MOBILE_RUNTIME_BACKENDS),
    optionalString(value, "model", 512),
    optionalString(value, "effort", 80),
    optionalBoolean(value, "longContext"),
    validateEnum(value, "role", ["orchestrator", "worker"]),
    optionalBoolean(value, "inherit"),
    role !== undefined && selectedRole !== role
      ? `runtime selection role must be ${role}`
      : null,
    value.inherit === true && selectedRole !== "worker"
      ? "inherit is allowed only for the worker runtime role"
      : null,
  );
}

function validateRuntimeRoleMembers(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 32) {
    return "selections must be an array of at most 32 runtime members";
  }
  for (const selection of value) {
    const error = validateRuntimeSelectionValue(selection);
    if (error) return error;
  }
  return null;
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
  const taskForceTargetsError = validateTurnAgentTargets(params.taskForceTargets);
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
    optionalBoolean(params, "networkMode"),
    optionalBoolean(params, "appsGenerateMode"),
    optionalBoolean(params, "stormbreakerMode"),
    validateEnum(params, "steeringMode", ["queue", "interrupt"]),
    params.runtimeSelection === undefined
      ? null
      : validateRuntimeSelectionValue(params.runtimeSelection, "orchestrator"),
    taskForceTargetsError,
    decisionBindingError,
  );
}

function validateTurnAgentTargets(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 8) {
    return "taskForceTargets must contain at most 8 turn-only agent targets";
  }
  for (const target of value) {
    if (!isRecord(target) || target.entityKind !== "agent") {
      return "taskForceTargets accepts only agent targets";
    }
    if (target.source === "local") {
      if (!hasOnlyKeys(target, ["source", "entityKind", "agentId"])) {
        return "local taskForceTargets accepts only source, entityKind, and agentId";
      }
      const error = requiredString(target, "agentId", 160);
      if (error) return error;
    } else if (target.source === "cloud" || target.source === "hub") {
      if (!hasOnlyKeys(target, ["source", "entityKind", "slug"])) {
        return "remote taskForceTargets accepts only source, entityKind, and slug";
      }
      const error = requiredString(target, "slug", 160);
      if (error) return error;
    } else {
      return "taskForceTargets source is unsupported";
    }
  }
  return null;
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

const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

const PROJECT_POOL_SOURCES = ["local", "cloud", "hub"] as const;

/**
 * DESKTOP_MOBILE_BRIDGE: shape-only gate for a project staffing write. Whether
 * a tool may actually be attached (installed, user-facing, already bound) is
 * decided by Desktop authority, never here.
 */
function validateProjectAgentPool(params: Record<string, unknown>): string | null {
  if (!hasOnlyKeys(params, ["projectId", "members", "expectedMemberKeys"])) {
    return "projects.setAgentPool accepts only projectId, members, and expectedMemberKeys";
  }
  const projectIdError = requiredString(params, "projectId");
  if (projectIdError) return projectIdError;

  const { members } = params;
  if (!Array.isArray(members) || members.length > PROJECT_AGENT_POOL_MAX) {
    return `members must be an ordered array of at most ${PROJECT_AGENT_POOL_MAX} tools`;
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (!isRecord(member) || !hasOnlyKeys(member, ["entityKind", "targetId", "agentId", "firmId", "controllerAgentId", "source", "releaseId"])) {
      return "members contains an unsupported project tool";
    }
    const entityKind = typeof member.entityKind === "string" ? member.entityKind : "agent";
    if (entityKind !== "agent" && entityKind !== "team") return "members contains an unsupported project tool kind";
    const targetId = typeof member.targetId === "string" ? member.targetId : member.agentId;
    if (typeof targetId !== "string" || !targetId.trim()) return "members contains a project tool without targetId";
    const memberError = firstError(
      validateEnum(member, "source", PROJECT_POOL_SOURCES, false),
      optionalString(member, "releaseId", 200),
      optionalString(member, "agentId", 200),
      optionalString(member, "firmId", 200),
      optionalString(member, "controllerAgentId", 200),
    );
    if (memberError) return memberError;
    const key = `${String(member.source)}:${entityKind}:${targetId}:${
      typeof member.releaseId === "string" ? member.releaseId : ""
    }`;
    if (seen.has(key)) return "members must not repeat the same project tool";
    seen.add(key);
  }

  const expected = params.expectedMemberKeys;
  if (!Array.isArray(expected) || expected.length > PROJECT_AGENT_POOL_MAX) {
    return `expectedMemberKeys must be an ordered array of at most ${PROJECT_AGENT_POOL_MAX} keys`;
  }
  for (const key of expected) {
    if (
      typeof key !== "string" ||
      key.length < 1 ||
      key.length > 600 ||
      CONTROL_CHARACTERS.test(key)
    ) {
      return "expectedMemberKeys contains an invalid project pool key";
    }
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
    case "chats.get":
    case "chats.archive":
    case "chats.unarchive":
    case "chats.clearContext":
    // projects.get shipped without a validator and every call fell through to
    // the fail-closed default, so project detail was unreachable from Mobile.
    case "projects.get":
      return hasOnlyKeys(params, ["id"]) ? requiredString(params, "id") : `${method} accepts only id`;
    case "projects.setAgentPool":
      return validateProjectAgentPool(params);
    case "one.org.add":
      return hasOnlyKeys(params, ["installedAgentId", "displayName"])
        ? firstError(
            requiredString(params, "installedAgentId", 240),
            optionalString(params, "displayName", 80),
          )
        : "one.org.add accepts only installedAgentId and displayName";
    case "one.org.openMember":
      return hasOnlyKeys(params, ["id", "expectedRevision"])
        ? firstError(
            requiredString(params, "id", 80),
            optionalInteger(params, "expectedRevision", 1, Number.MAX_SAFE_INTEGER),
          )
        : `${method} accepts only id and expectedRevision`;
    case "one.org.markRead":
      return hasOnlyKeys(params, ["id", "expectedUnreadGeneration"])
        ? firstError(
            requiredString(params, "id", 80),
            optionalInteger(params, "expectedUnreadGeneration", 0, Number.MAX_SAFE_INTEGER),
            Number.isSafeInteger(params.expectedUnreadGeneration)
              ? null
              : "expectedUnreadGeneration is required",
          )
        : `${method} accepts only id and expectedUnreadGeneration`;
    case "tasks.createProject":
      return hasOnlyKeys(params, ["projectId", "title"])
        ? firstError(requiredString(params, "projectId"), optionalString(params, "title", 200))
        : "tasks.createProject accepts only projectId and title";
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
    case "chats.setRuntimeSelection":
      return hasOnlyKeys(params, ["id", "selection"])
        ? firstError(
            requiredString(params, "id"),
            params.selection === null
              ? null
              : validateRuntimeSelectionValue(params.selection, "orchestrator"),
          )
        : "chats.setRuntimeSelection accepts only id and selection";
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
    case "terminal.read":
      return hasOnlyKeys(params, ["terminalId", "sinceSeq", "limit"])
        ? firstError(
            requiredString(params, "terminalId", 160),
            optionalInteger(params, "sinceSeq", 0, Number.MAX_SAFE_INTEGER),
            optionalInteger(params, "limit", 1, 500),
          )
        : "terminal.read accepts only terminalId, sinceSeq, and limit";
    case "terminal.preview":
      return hasOnlyKeys(params, ["terminalId", "command"])
        ? firstError(
            requiredString(params, "terminalId", 160),
            requiredText(params, "command", 4_000),
          )
        : "terminal.preview accepts only terminalId and command";
    case "terminal.takeover":
      return hasOnlyKeys(params, ["terminalId", "expectedOwnerEpoch"])
        ? firstError(
            requiredString(params, "terminalId", 160),
            params.expectedOwnerEpoch === undefined
              ? "expectedOwnerEpoch is required"
              : optionalInteger(params, "expectedOwnerEpoch", 0, Number.MAX_SAFE_INTEGER),
          )
        : "terminal.takeover accepts only terminalId and expectedOwnerEpoch";
    case "terminal.release":
      return hasOnlyKeys(params, ["terminalId", "ownerEpoch"])
        ? firstError(
            requiredString(params, "terminalId", 160),
            params.ownerEpoch === undefined
              ? "ownerEpoch is required"
              : optionalInteger(params, "ownerEpoch", 1, Number.MAX_SAFE_INTEGER),
          )
        : "terminal.release accepts only terminalId and ownerEpoch";
    case "terminal.dispatch":
      return hasOnlyKeys(params, ["terminalId", "ownerEpoch", "previewId", "approvalId"])
        ? firstError(
            requiredString(params, "terminalId", 160),
            params.ownerEpoch === undefined
              ? "ownerEpoch is required"
              : optionalInteger(params, "ownerEpoch", 1, Number.MAX_SAFE_INTEGER),
            requiredString(params, "previewId", 160),
            optionalString(params, "approvalId", 160),
          )
        : "terminal.dispatch accepts only terminalId, ownerEpoch, previewId, and approvalId";
    case "terminal.cancel":
      return hasOnlyKeys(params, ["terminalId", "ownerEpoch", "requestId"])
        ? firstError(
            requiredString(params, "terminalId", 160),
            params.ownerEpoch === undefined
              ? "ownerEpoch is required"
              : optionalInteger(params, "ownerEpoch", 1, Number.MAX_SAFE_INTEGER),
            requiredString(params, "requestId", 160),
          )
        : "terminal.cancel accepts only terminalId, ownerEpoch, and requestId";
    case "one.artifacts.recent":
      return hasOnlyKeys(params, ["chatId", "limit", "cursor"])
        ? firstError(
            requiredString(params, "chatId"),
            optionalInteger(params, "limit", 1, 100),
            params.cursor === undefined
              ? null
              : typeof params.cursor === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(params.cursor)
                ? null
                : "cursor must be an opaque Mobile Bridge cursor",
          )
        : "one.artifacts.recent accepts only chatId, limit, and cursor";
    case "one.artifact.imagePreview":
      return hasOnlyKeys(params, ["taskId", "taskVersion", "chatId", "runId", "manifestId", "artifactRef"])
        ? firstError(
            requiredString(params, "taskId"),
            params.taskVersion === undefined
              ? "taskVersion is required"
              : optionalInteger(params, "taskVersion", 1, Number.MAX_SAFE_INTEGER),
            requiredString(params, "chatId"),
            requiredString(params, "runId", 160),
            requiredString(params, "manifestId"),
            requiredString(params, "artifactRef"),
          )
        : "one.artifact.imagePreview accepts only exact artifact binding fields";
    case "chat.attachment.imagePreview":
      return hasOnlyKeys(params, ["chatId", "messageId", "attachmentId"])
        ? firstError(
            requiredString(params, "chatId", 256),
            requiredString(params, "messageId", 160),
            requiredString(params, "attachmentId", 160),
          )
        : "chat.attachment.imagePreview accepts only exact chat attachment binding fields";
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
      if (!hasOnlyKeys(params, ["schemaVersion", "userPrompt", "permissions", "planMode", "goalMode", "networkMode", "liveMode", "taskForceTargets", "images", "runtimeSelection"])) {
        return "one.invoke.start contains unsupported fields";
      }
      return firstError(
        params.schemaVersion === 1 ? null : "one.invoke.start requires schemaVersion 1",
        requiredText(params, "userPrompt", 200_000),
        typeof params.userPrompt === "string" && params.userPrompt.trim().length > 0
          ? null
          : "one.invoke.start userPrompt must contain visible text",
        validateEnum(params, "permissions", ["read", "write", "full"]),
        optionalBoolean(params, "planMode"),
        optionalBoolean(params, "goalMode"),
        optionalBoolean(params, "networkMode"),
        optionalBoolean(params, "liveMode"),
        validateTurnAgentTargets(params.taskForceTargets),
        validateImageAttachments(params.images),
        params.runtimeSelection === undefined
          ? null
          : validateRuntimeSelectionValue(params.runtimeSelection, "orchestrator"),
      );
    case "invoke.start":
      if (!hasOnlyKeys(params, ["runId", "chatId", "userPrompt", "locale", "permissions", "planMode", "goalMode", "networkMode", "appsGenerateMode", "stormbreakerMode", "taskForceTargets", "images", "runtimeSelection", "expectedQuestionMessageId", "expectedTaskId", "expectedTaskVersion", "expectedDecisionContractVersion"])) {
        return "invoke.start contains unsupported fields";
      }
      return validateInvokeOptions(params);
    case "invoke.steer":
      if (!hasOnlyKeys(params, ["runId", "chatId", "userPrompt", "locale", "permissions", "steeringMode", "planMode", "goalMode", "networkMode", "appsGenerateMode", "stormbreakerMode", "taskForceTargets", "images", "runtimeSelection", "expectedRunId", "expectedQuestionMessageId", "expectedTaskId", "expectedTaskVersion", "expectedDecisionContractVersion"])) {
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
    case "runtime.resolveToolApproval":
      // 결정 4종은 데스크탑 ToolApprovalDecision 과 **같은 값**이다(shared/types.ts).
      // allow_always 는 능력 규칙을 영구 기록하므로 폰에서도 같은 무게를 갖는다.
      return hasOnlyKeys(params, ["id", "decision"])
        ? firstError(
            requiredString(params, "id", 160),
            validateEnum(params, "decision", ["allow_once", "allow_session", "allow_always", "deny"], false),
          )
        : "runtime.resolveToolApproval accepts only id and decision";
    case "runtime.submitUserInput":
      return hasOnlyKeys(params, ["requestId", "answer"])
        ? firstError(
            requiredString(params, "requestId", 160),
            params.answer === null
              ? null
              : requiredString(params, "answer", 4_000),
          )
        : "runtime.submitUserInput accepts only requestId and answer";
    case "automations.get":
    case "automations.runNow":
      return hasOnlyKeys(params, ["id"]) ? requiredString(params, "id") : `${method} accepts only id`;
    case "automations.setRuntime":
      // runtimeSelection은 null(기본 복귀) 또는 {kind,...} 객체. 세부 형태는
      // 메인의 런타임 카탈로그 확인과 함께 검증해, 잘못된 핀이 저장소에 닿지
      // 않게 한다.
      return hasOnlyKeys(params, ["id", "runtimeSelection"])
        ? firstError(
            requiredString(params, "id"),
            params.runtimeSelection === null
              ? null
              : validateRuntimeSelectionValue(params.runtimeSelection, "orchestrator"),
          )
        : "automations.setRuntime accepts only id and runtimeSelection";
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
    case "runtime.setActive": {
      if (!hasOnlyKeys(params, [
        "kind",
        "backend",
        "model",
        "effort",
        "longContext",
        "role",
        "inherit",
      ])) {
        return "runtime.setActive contains unsupported fields";
      }
      const error = firstError(
        validateEnum(params, "kind", MOBILE_RUNTIME_KINDS, false),
        validateEnum(params, "backend", MOBILE_RUNTIME_BACKENDS),
        optionalString(params, "model", 200),
        optionalString(params, "effort", 80),
        optionalBoolean(params, "longContext"),
        validateEnum(params, "role", ["orchestrator", "worker"]),
        optionalBoolean(params, "inherit"),
      );
      if (error) return error;
      return params.inherit === true && params.role !== "worker"
        ? "inherit is allowed only for the worker runtime role"
        : null;
    }
    case "runtime.setRoleMembers": {
      if (!hasOnlyKeys(params, ["role", "selections"])) {
        return "runtime.setRoleMembers accepts only role and selections";
      }
      return firstError(
        validateEnum(params, "role", ["orchestrator", "worker"], false),
        validateRuntimeRoleMembers(params.selections),
      );
    }
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
    // `confirmOverwrite` answers main's one overwrite question about THIS
    // folder. It carries no target: main re-reads the asset it asked about, so
    // a phone can never name which cloud asset gets replaced.
    case "agents.cloudUploadSave":
      return hasOnlyKeys(params, ["agentLocalId", "idempotencyKey", "confirmOverwrite"])
        ? firstError(
            requiredString(params, "agentLocalId"),
            requiredString(params, "idempotencyKey", 160),
            optionalBoolean(params, "confirmOverwrite"),
          )
        : "agents.cloudUploadSave accepts only agentLocalId, idempotencyKey, and confirmOverwrite";
    case "agents.cloudPublishHub":
      return hasOnlyKeys(params, ["agentLocalId", "idempotencyKey", "confirmOverwrite"])
        ? firstError(
            requiredString(params, "agentLocalId"),
            requiredString(params, "idempotencyKey", 160),
            optionalBoolean(params, "confirmOverwrite"),
          )
        : "agents.cloudPublishHub accepts only agentLocalId, idempotencyKey, and confirmOverwrite";
    case "cloud.setHubPrices": {
      if (!hasOnlyKeys(params, ["slug", "prices", "idempotencyKey"])) {
        return "cloud.setHubPrices accepts only slug, prices, and idempotencyKey";
      }
      const base = firstError(
        requiredString(params, "slug", 160),
        requiredString(params, "idempotencyKey", 160),
      );
      if (base) return base;
      const prices = params.prices;
      if (!isRecord(prices) || !hasOnlyKeys(prices, MOBILE_BRIDGE_HUB_PRICE_KINDS)) {
        return "prices accepts only RENT, INGEST, and FORK";
      }
      const kinds = Object.keys(prices);
      if (kinds.length === 0) {
        return "prices must name at least one of RENT, INGEST, or FORK";
      }
      for (const kind of kinds) {
        const value = (prices as Record<string, unknown>)[kind];
        // null removes the price; the SERVER remains the bounds authority.
        if (value === null) continue;
        if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) {
          return `${kind} must be null or an integer credit amount of at least 1`;
        }
      }
      return null;
    }
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
    case "build.answer": {
      if (!hasOnlyKeys(params, ["runId", "questionSetId", "answers", "idempotencyKey"])) {
        return "build.answer contains unsupported fields";
      }
      const answers = params.answers;
      if (!Array.isArray(answers) || answers.length < 1 || answers.length > 7) {
        return "answers must contain between 1 and 7 entries";
      }
      const seenQuestionIds = new Set<string>();
      for (const answer of answers) {
        if (!isRecord(answer) || !hasOnlyKeys(answer, ["questionId", "values"])) {
          return "each answer must contain only questionId and values";
        }
        const questionIdError = requiredString(answer, "questionId", 160);
        if (questionIdError) return questionIdError;
        const questionId = answer.questionId as string;
        if (seenQuestionIds.has(questionId)) return "answers cannot repeat questionId";
        seenQuestionIds.add(questionId);
        if (!Array.isArray(answer.values) || answer.values.length < 1 || answer.values.length > 8) {
          return "each answer values must contain between 1 and 8 entries";
        }
        const seenValues = new Set<string>();
        for (const value of answer.values) {
          if (
            typeof value !== "string" ||
            value.length < 1 ||
            value.length > 200 ||
            /[\u0000-\u001f]/.test(value) ||
            seenValues.has(value)
          ) {
            return "answer values must be unique bounded strings";
          }
          seenValues.add(value);
        }
      }
      return firstError(
        requiredString(params, "runId", 160),
        requiredString(params, "questionSetId", 160),
        requiredString(params, "idempotencyKey", 160),
      );
    }
    case "build.status":
      return hasOnlyKeys(params, ["runId"])
        ? requiredString(params, "runId", 160)
        : "build.status accepts only runId";
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
