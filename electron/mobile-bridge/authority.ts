import { randomUUID } from "node:crypto";
import { RUNTIME_KINDS } from "../../shared/runtime-kinds";
import { RUNTIME_BACKENDS } from "../../shared/runtime-backends";
import {
  extractBuildInterviewQuestions,
  isCompletedBuildTurn,
  type BuildInterviewQuestion,
} from "../../shared/build-turn";
import {
  listPendingToolApprovals,
  onToolApprovalRequested,
  onToolApprovalResolved,
  resolveToolApproval,
} from "../runtime/tool-approval";
import {
  listPendingAskUserRequests,
  onAskUserLifecycle,
  submitAskUserAnswer,
} from "../confirm/ask-user";
import {
  browserResolveApproval,
  listPendingBrowserApprovals,
  onBrowserApprovalLifecycle,
  type BrowserApprovalLifecycleEvent,
  type BrowserPermissionDecision,
} from "../browser/connect";
import { onDesktopStoreChange } from "../store/change-bus";
import {
  acceptCanonicalTaskResult,
  ensurePairingVerificationTask,
  findCanonicalTaskForChat,
  getCanonicalTask,
  getCanonicalTaskForChat,
  hasPassedTaskForceExecutionVerification,
} from "../store/tasks";
import {
  ACCEPTED_RESULT_CLOSURE_FACT_STATEMENTS,
  ensureAcceptedResultValueClosure,
  ensureVerifiedAcceptedResultValueClosure,
} from "../one/accepted-result-value-closure";
import { prejudgeCompletionClaims } from "../one/judged-completion-claim";
import { tryCompleteOneActivationFirstValue } from "../one/activation";
import { ensureOneExperienceReuseReceipt } from "../one/experience-reuse";
import { sealOneMemoryCandidateProvenance } from "../one/memory-candidates";
import { tryProduceAcceptedResultSuggestion } from "../one/completion-suggestion-producer";
import { tryProduceOneImprovementProofForTask } from "../one/improvement-proof-producer";
import { readOneArtifactImagePreview } from "../one/artifact-preview";
import { readBoundChatMessageAttachment } from "../store/chat-message-attachments";
import { performOneMobileSuggestionAction } from "../one/mobile-suggestions";
import { invocationService } from "../invocation/service";
import {
  captureMobileOneInvocationBinding,
  captureInvocationWorkspaceBinding,
  normalizeRemoteInvocationPermission,
} from "../invocation/workspace-binding";
import {
  claimPendingConfirmationAnswer,
  listPendingConfirmations,
  recordCommittedAnswerReceipt,
} from "../confirm";
import {
  ONE_DECISION_CONTRACT_VERSION,
  isPendingConfirmationSnoozed,
  normalizeOneDecision,
} from "../../shared/one-decision";
import { oneDecisionJudgedReaders, prejudgeOneDecision } from "../one/judged-decision";
import { prejudgeOneRequestIntent } from "../one/judged-request-intent";
import { prejudgeOneMemoryIntent } from "../one/memory-detector";
import {
  clearDetectCache,
  detectRuntimes,
  resolveRolePoolPicks,
  setActiveRuntime,
} from "../runtime/detect";
import { listModelRoleMembers, setModelRoleMembers } from "../store/model-roles";
import { listRuntimeCommands } from "../runtime/commands";
import { listInstalledAgents } from "../mcp/registry";
import { addOneOrgMember, getOneOrgState, markOneOrgMemberRead, openOneOrgMember } from "../one/org";
import { MCP_TOOL_CATALOG } from "../mcp-tools/catalog";
import { listInstalledServers } from "../mcp-tools/registry";
import { routeOnly } from "../hephaestus/commands";
import { normalizeRecommendation } from "../hephaestus/recommendation";
import { activeLeasedSlugs } from "../cloud-agents/leases";
import { getEngineToggles } from "../hephaestus/supervisor";
import { listHubAgentBookmarks } from "../store/hub-bookmarks";
import {
  getAutomation,
  listAutomations,
  listRunHistory,
  toggleAutomation,
} from "../store/automations";
import {
  appendChatMessage,
  archiveChat,
  clearChatContext,
  createChat,
  getChat,
  getChatWorkingFolder,
  listRecentChats,
  removeChat,
  renameChat,
  setChatContinuousMode,
  setChatRuntimeSelection,
  setChatSwarmMode,
  setChatWorkingFolder,
  unarchiveChat,
} from "../store/chats";
import { getProject, updateProject } from "../store/projects";
import { getFirm } from "../store/firms";
import {
  PROJECT_AGENT_POOL_MAX,
  isUserFacingProjectAgent,
  projectPoolMemberKey,
} from "../../shared/project-agent-pool";
import { OwnerCloudActionError } from "../marketplace/mcp-source";
import { resumeMobileOneAutoRecovery } from "../one/mobile-auto-recovery";
import { autoResolveOneTeamPreflight, prepareOneTeamPreflight } from "../one/team-preflight";
import {
  isOneInvocationChat,
  iterateRecentChatOneArtifactEvents,
  listRecentOneArtifactsForMobile,
} from "../store/run-events";
import {
  createDesktopMobileBridgeBuildActions,
  createDesktopMobileBridgeCloudAgentActions,
  type MobileBridgeBuildApprovalDecision,
  type MobileBridgeBuildActions,
  type MobileBridgeCloudAgentActions,
} from "./cloud-actions";
import { getUsageSnapshot } from "../usage";
import { getBillingCredits } from "../billing";
import { listInstalledAgentHubBindings } from "../ontology/hub-bindings";
import type { TerminalOntologyLoadoutFeedWriter } from "../ontology/terminal-loadout-feed";
import type {
  Chat,
  CloudAgentRegisteredUploadOption,
  HephaestusBuildEvent,
  ImageAttachment,
  InvocationRunReceipt,
  McpInvocationEvent,
  McpInvocationRequest,
  OrchestrationTarget,
  ProjectAgentPoolMember,
  Recommendation,
  RuntimeBackend,
  RuntimeKind,
  RuntimeRole,
  RuntimeSelection,
  RuntimeStatus,
} from "../../shared/types";
import {
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  isMobileBridgeJsonValue,
  type MobileBridgeBuildEventDto,
  type MobileBridgeBuildQuestionDto,
  type MobileBridgeBuildRefusalDto,
  type MobileBridgeBuildStatus,
  type MobileBridgeCloudDeleteResultDto,
  type MobileBridgeHubPublishDto,
  type MobileBridgeHubPricesDto,
  type MobileBridgeHubPriceRefusalDto,
  MOBILE_BRIDGE_HUB_PRICE_KINDS,
  type MobileBridgeCloudRefusalDto,
  type MobileBridgeCloudUploadSaveDto,
  type MobileBridgeCloudUploadPreviewDto,
  type MobileBridgeInvocationEventDto,
  type MobileBridgeInvocationArtifactDto,
  type MobileBridgeBrowserApprovalDto,
  type MobileBridgeInvokeSteerParams,
  type MobileBridgeJsonValue,
  type MobileBridgeOneInvokeStartReceiptDto,
  type MobileBridgeRpcRequest,
  type MobileBridgeSnapshot,
  type MobileBridgeTerminalCancelDto,
  type MobileBridgeTerminalDispatchDto,
  type MobileBridgeTerminalPreviewDto,
  type MobileBridgeTerminalReadDto,
  type MobileBridgeTerminalRefusalDto,
  type MobileBridgeTerminalWriteRefusalDto,
  type MobileBridgeTerminalReleaseDto,
  type MobileBridgeTerminalTakeoverDto,
  type MobileBridgeToolCallDisplayDto,
  type MobileBridgeToolPayloadSize,
  type MobileBridgeToolPayloadSummaryDto,
  type MobileBridgeUserInputDto,
} from "../../shared/mobile-bridge";
import { buildToolCallDisplay, normalizeToolCall } from "../../shared/tool-call-detail";
import type { MobileBridgeHostIdentity } from "./pairing";
import type { MobileBridgeRevocationCause } from "./pairing";
import {
  projectMobileBridgeAutomation,
  projectMobileBridgeChat,
  projectMobileBridgeConfirmations,
  projectMobileBridgeHistory,
  projectMobileBridgeProject,
  projectMobileBridgeRuntimeRolePool,
  projectMobileBridgeRuntimeSelection,
  projectMobileBridgeRuntimes,
  projectMobileBridgeSnapshot,
  projectMobileBridgeUsage,
} from "./projector";
import {
  MOBILE_BRIDGE_DISPLAY_TEXT_BYTES,
  sanitizeMobileBridgeText,
  stripMobileBridgeControlFences,
} from "./sanitize";
import {
  OntologyHubClient,
  parseOntologyAttachResolveInput,
} from "./ontology-hub-client";
import type {
  MobileBridgeAuthority,
  MobileBridgeAuthorityEvent,
  MobileBridgeConnectionContext,
} from "./server";

const REQUEST_ID_RE = /^[^\u0000-\u001f]{1,128}$/;
const IDENTIFIER_RE = /^[^\u0000-\u001f]{1,256}$/;
const RUN_ID_RE = /^[^\u0000-\u001f]{1,160}$/;
const MOBILE_ONE_ARTIFACT_CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;
/** 도구 승인 id — tool-approval 이 발급하는 `approval:<t>:<rand>` / `denied:<t>:<rand>`. */
const TOOL_APPROVAL_ID_RE = /^(approval|denied):[a-z0-9]{1,16}:[a-z0-9]{1,16}$/;
const TERMINAL_APPROVAL_ID_RE = /^approval:[a-z0-9]{1,16}:[a-z0-9]{1,16}$/;
const ASK_USER_REQUEST_ID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const EVENT_TEXT_MAX_BYTES = 200_000;
const EVENT_DELTA_MAX_BYTES = 64_000;
const EVENT_ONE_ARTIFACT_LIMIT = 32;
const RECENT_ONE_ARTIFACT_LIMIT = 10;
const TOOL_COUNT_CAP = 1_000;
const BUILD_EVENT_TEXT_MAX_BYTES = 16_000;
const BUILD_SUMMARY_MAX_BYTES = 2_000;
const BUILD_RUN_HISTORY_LIMIT = 64;
const BUILD_HISTORY_ENTRY_MAX_BYTES = 16_000;
const BUILD_HISTORY_MAX_ENTRIES = 32;
const MOBILE_RUNTIME_KINDS = RUNTIME_KINDS;
const MOBILE_RUNTIME_BACKENDS = RUNTIME_BACKENDS;

function runtimeCredentialUnavailable(runtime: RuntimeStatus): boolean {
  const access = (
    runtime as RuntimeStatus & { credentialAccess?: { status?: string } }
  ).credentialAccess;
  return access?.status === "unavailable";
}
const MOBILE_RUNTIME_ROLES = ["orchestrator", "worker"] as const;
const BUILD_APPROVAL_TIMEOUT_MS = 90_000;
const TERMINAL_PREVIEW_TTL_MS = 60_000;
// Ontology enriches the Mobile surface, but it is not required to establish a
// Desktop connection. A fetch implementation that ignores AbortSignal (or a
// shared stale in-flight request) must never hold bridge.ready indefinitely.
const INITIAL_ONTOLOGY_BUDGET_MS = 1_500;
// A paired phone can start a full-authority Hephaestus build. Keep that scarce
// operation single-flight per Desktop authority so repeated requests cannot
// fan out unbounded local model/tool processes. Desktop-native builds are not
// part of this registry and remain unaffected.
const MAX_CONCURRENT_MOBILE_BUILDS = 1;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

type InternalMobileBuildStatus = MobileBridgeBuildStatus | "awaiting-approval";

function activeMobileBuildStatus(status: InternalMobileBuildStatus): boolean {
  return status === "awaiting-approval" || status === "running";
}

export interface AgentlasDesktopMobileBridgeAuthorityOptions {
  /** DESKTOP_MOBILE_BRIDGE: Stable identity loaded from the Desktop userData store. */
  hostIdentity: MobileBridgeHostIdentity;
  displayName: string;
  appVersion: string;
  onError?: (error: Error) => void;
  /** Production injects the pairing authority; tests may omit it unless exercising revocation. */
  revokeDevice?: (deviceId: string, cause?: MobileBridgeRevocationCause) => boolean;
  /** Authenticated Hub adapter. Omit to keep the extension unavailable. */
  ontologyHubClient?: OntologyHubClient;
  /** Content-free, private projection consumed only after an explicit Terminal flag. */
  terminalOntologyLoadoutFeedWriter?: TerminalOntologyLoadoutFeedWriter;
  /**
   * Agent Cloud passthrough adapter (upload/delete). Tests inject
   * fakes; production omits it and gets the real Desktop internals.
   */
  cloudAgentActions?: MobileBridgeCloudAgentActions;
  /** Hephaestus build runner adapter. Same injection rule as cloudAgentActions. */
  buildActions?: MobileBridgeBuildActions;
  /**
   * Desktop-owned terminal authority. Production injects the persistent
   * terminal controller (PTY capability is implementation-specific); tests may
   * omit it to prove the structured refusal boundary remains honest on hosts
   * that do not ship terminal support.
   */
  terminalControl?: MobileBridgeTerminalControl;
}

/**
 * Adapter boundary for a real, already-authoritative Desktop terminal.
 * Implementations own the process/session and must pause agent input during
 * takeover. The Mobile Bridge only supplies bounded protocol values; it never
 * derives an executable, cwd, environment, or process handle from the phone.
 */
export interface MobileBridgeTerminalControl {
  read(input: {
    terminalId: string;
    sinceSeq?: number;
    limit?: number;
  }, context: MobileBridgeConnectionContext): Promise<MobileBridgeTerminalReadDto>;
  preview(input: {
    terminalId: string;
    command: string;
    ownerEpoch: number;
  }, context: MobileBridgeConnectionContext): Promise<MobileBridgeTerminalPreviewDto>;
  takeover(input: {
    terminalId: string;
    expectedOwnerEpoch: number;
    nextOwnerEpoch: number;
  }, context: MobileBridgeConnectionContext): Promise<MobileBridgeTerminalTakeoverDto>;
  release(input: {
    terminalId: string;
    ownerEpoch: number;
    nextOwnerEpoch: number;
  }, context: MobileBridgeConnectionContext): Promise<MobileBridgeTerminalReleaseDto>;
  dispatch(input: {
    terminalId: string;
    ownerEpoch: number;
    previewId: string;
    approvalId?: string;
  }, context: MobileBridgeConnectionContext): Promise<MobileBridgeTerminalDispatchDto>;
  cancel(input: {
    terminalId: string;
    ownerEpoch: number;
    requestId: string;
  }, context: MobileBridgeConnectionContext): Promise<MobileBridgeTerminalCancelDto>;
}

export type MobileBridgeAuthorityHandle = MobileBridgeAuthority & { dispose(): void };

type AuthorityListener = (event: MobileBridgeAuthorityEvent) => void;

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function settleOptionalProjectionWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allow.has(key));
  if (extra) throw new TypeError(`${label} contains unsupported field: ${extra}`);
}

function guardedParams(
  request: MobileBridgeRpcRequest,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isRecord(request.params)) throw new TypeError(`${request.method} params must be an object`);
  assertOnlyKeys(request.params, allowed, request.method);
  return request.params;
}

function noParams(request: MobileBridgeRpcRequest): void {
  const params = guardedParams(request, []);
  if (Object.keys(params).length !== 0) throw new TypeError(`${request.method} does not accept params`);
}

function requiredIdentifier(
  params: Record<string, unknown>,
  key: string,
  pattern: RegExp = IDENTIFIER_RE,
): string {
  const value = params[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${key} must be a bounded non-empty string`);
  }
  return value;
}

function requiredBoundedString(
  params: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = params[key];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new TypeError(`${key} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalIdentifier(
  params: Record<string, unknown>,
  key: string,
  maxLength = 256,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new TypeError(`${key} must be a bounded string`);
  }
  return value;
}

function requiredText(params: Record<string, unknown>, key: string, maxLength: number): string {
  const value = params[key];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000\u000b\u000c\u000e-\u001f]/.test(value)
  ) {
    throw new TypeError(`${key} must be bounded non-empty text`);
  }
  return value;
}

function terminalRefusal(
  code: MobileBridgeTerminalRefusalDto["code"],
  message: string,
): MobileBridgeTerminalRefusalDto {
  return { schemaVersion: 1, status: "refused", code, message };
}

function terminalWriteRefusal(
  request: MobileBridgeRpcRequest,
  terminalId: string,
  code: MobileBridgeTerminalRefusalDto["code"],
  message: string,
): MobileBridgeTerminalWriteRefusalDto {
  if (!request.idempotencyKey) {
    throw new TypeError(`${request.method} requires an idempotencyKey`);
  }
  if (
    request.method !== "terminal.takeover"
    && request.method !== "terminal.release"
    && request.method !== "terminal.dispatch"
    && request.method !== "terminal.cancel"
  ) {
    throw new TypeError("terminal refusal method is not a protected write");
  }
  return {
    ...terminalRefusal(code, message),
    method: request.method,
    terminalId,
    idempotencyKey: request.idempotencyKey,
  };
}

interface MobileTerminalPreviewState {
  terminalId: string;
  previewId: string;
  ownerEpoch: number;
  risk: "safe" | "dangerous";
  expiresAt: string;
  expiresAtMs: number;
}

interface MobileTerminalLeaseState {
  owner: "agent" | "mobile";
  ownerEpoch: number;
  ownerDeviceId: string | null;
  previews: Map<string, MobileTerminalPreviewState>;
}

function optionalText(
  params: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    /[\u0000\u000b\u000c\u000e-\u001f]/.test(value)
  ) {
    throw new TypeError(`${key} must be text of at most ${maxLength} characters`);
  }
  return value;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
  return value;
}

function requiredBoolean(params: Record<string, unknown>, key: string): boolean {
  const value = optionalBoolean(params, key);
  if (value === undefined) throw new TypeError(`${key} is required`);
  return value;
}

function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new TypeError(`${key} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function optionalEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  choices: readonly T[],
): T | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new TypeError(`${key} is not allowed`);
  }
  return value as T;
}

function requiredEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  choices: readonly T[],
): T {
  const value = optionalEnum(params, key, choices);
  if (value === undefined) throw new TypeError(`${key} is required`);
  return value;
}

function optionalTurnAgentTargets(params: Record<string, unknown>): OrchestrationTarget[] | undefined {
  const value = params.taskForceTargets;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8) {
    throw new TypeError("taskForceTargets must contain at most 8 turn-only agents");
  }
  return value.map((item, index) => {
    if (!isRecord(item) || item.entityKind !== "agent") {
      throw new TypeError(`taskForceTargets[${index}] must be an agent`);
    }
    if (item.source === "local") {
      assertOnlyKeys(item, ["source", "entityKind", "agentId"], `taskForceTargets[${index}]`);
      const agentId = requiredIdentifier(item, "agentId", RUN_ID_RE);
      if (!listInstalledAgents().some((agent) => agent.id === agentId)) {
        throw new Error("A turn-only local agent is unavailable on this Desktop");
      }
      return { source: "local", entityKind: "agent", agentId };
    }
    if (item.source === "cloud" || item.source === "hub") {
      assertOnlyKeys(item, ["source", "entityKind", "slug"], `taskForceTargets[${index}]`);
      return {
        source: item.source,
        entityKind: "agent",
        slug: requiredIdentifier(item, "slug", RUN_ID_RE),
      };
    }
    throw new TypeError(`taskForceTargets[${index}] source is unsupported`);
  });
}

function optionalImages(params: Record<string, unknown>): ImageAttachment[] | undefined {
  const value = params.images;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4) {
    throw new TypeError("images must contain at most 4 attachments");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`images[${index}] must be an object`);
    assertOnlyKeys(item, ["mediaType", "name", "data"], `images[${index}]`);
    const mediaType = requiredEnum(item, "mediaType", [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ] as const);
    const name = optionalIdentifier(item, "name", 200);
    const data = requiredBoundedString(item, "data", 7_000_000);
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new TypeError(`images[${index}].data must be canonical base64`);
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length < 1 || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== data) {
      throw new TypeError(`images[${index}] exceeds the 5 MiB Desktop image limit`);
    }
    const hasExpectedSignature =
      (mediaType === "image/png" && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
      (mediaType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      (mediaType === "image/gif" && bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) ||
      (mediaType === "image/webp" && bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP");
    if (!hasExpectedSignature) {
      throw new TypeError(`images[${index}] content does not match its mediaType`);
    }
    return { mediaType, ...(name ? { name } : {}), data };
  });
}

function normalizedSlug(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function callableHubBookmarksForMobile() {
  const bookmarks = listHubAgentBookmarks();
  const localSlugs = new Set(listInstalledAgents().map((agent) => normalizedSlug(agent.slug)).filter(Boolean));
  const entityKindsBySlug = new Map<string, Set<string>>();
  for (const bookmark of bookmarks) {
    const slug = normalizedSlug(bookmark.slug || bookmark.listing.slug);
    if (!slug) continue;
    const kinds = entityKindsBySlug.get(slug) ?? new Set<string>();
    kinds.add(String(bookmark.listing.entityKind || "agent").toLowerCase());
    entityKindsBySlug.set(slug, kinds);
  }
  const seen = new Set<string>();
  return bookmarks.filter((bookmark) => {
    const listing = bookmark.listing;
    const slug = normalizedSlug(bookmark.slug || listing.slug);
    if (
      !slug ||
      seen.has(slug) ||
      localSlugs.has(slug) ||
      (entityKindsBySlug.get(slug)?.size ?? 0) > 1 ||
      listing.callable !== true ||
      listing.kind === "install-only" ||
      listing.entityKind === "plugin" ||
      listing.source === "hub-plugin" ||
      listing.routingReady === false
    ) {
      return false;
    }
    seen.add(slug);
    return true;
  });
}

function projectBorrowableHubAgents() {
  return callableHubBookmarksForMobile().map((bookmark) => ({
    slug: normalizedSlug(bookmark.slug || bookmark.listing.slug),
    name: boundedRedactedText(bookmark.listing.name, 512),
    nameEn: boundedRedactedText(bookmark.listing.nameEn, 512),
    entityKind: bookmark.listing.entityKind === "team" ? "team" : "agent",
    perCallCredits:
      typeof bookmark.listing.perCallCredits === "number" && Number.isFinite(bookmark.listing.perCallCredits)
        ? Math.max(0, bookmark.listing.perCallCredits)
        : null,
  }));
}

function projectRouteRecommendation(recommendation: Recommendation) {
  return {
    mode: recommendation.mode,
    agents: recommendation.agents.slice(0, 8).map((agent) => ({
      id: boundedRedactedText(agent.id, 512),
      name: boundedRedactedText(agent.name, 512),
      source: agent.source,
      estCredits: agent.estCredits,
      isFirm: agent.isFirm === true,
    })),
    stages: (recommendation.stages ?? []).slice(0, 12).map((stage) => ({
      order: stage.order,
      kind: boundedRedactedText(stage.kind, 256),
      agentId: typeof stage.agentId === "string" ? boundedRedactedText(stage.agentId, 512) : null,
      agentName: typeof stage.agentName === "string" ? boundedRedactedText(stage.agentName, 512) : null,
      produces: (stage.produces ?? []).slice(0, 20).map((value) => boundedRedactedText(value, 256)),
      consumes: (stage.consumes ?? []).slice(0, 20).map((value) => boundedRedactedText(value, 256)),
      estCredits: stage.estCredits ?? null,
    })),
    totalEstCredits: recommendation.totalEstCredits,
    // 단가 미상 Hub 행이 빠진 합계는 하한이다 — 플래그를 같이 보내지 않으면
    // 모바일도 부분합을 총액으로 표시한다(데스크탑과 같은 고지액 < 실청구액).
    totalEstCreditsPartial: recommendation.totalEstCreditsPartial === true,
    rawAction: boundedRedactedText(recommendation.rawAction, 160),
    clarifyQuestion:
      typeof recommendation.clarifyQuestion === "string"
        ? boundedRedactedText(recommendation.clarifyQuestion, 2_000)
        : null,
    buildReason:
      typeof recommendation.buildReason === "string"
        ? boundedRedactedText(recommendation.buildReason, 2_000)
        : null,
  };
}

function asJsonValue(value: unknown, label: string): MobileBridgeJsonValue {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} is not JSON serializable`);
  }
  if (encoded === undefined) throw new TypeError(`${label} is undefined`);
  const decoded: unknown = JSON.parse(encoded);
  if (!isMobileBridgeJsonValue(decoded)) throw new TypeError(`${label} is not Mobile Bridge JSON`);
  return decoded;
}

function boundedRedactedText(value: string, maxBytes: number): string {
  return sanitizeMobileBridgeText(value, maxBytes);
}

/**
 * Hub credit balance for the phone — same main-process source as Desktop's own
 * CreditBalanceWidget (billing.getCredits → GET /api/billing/credits), cached
 * with the same 60s window the renderer uses (ipc-cache "billing.getCredits").
 * Mobile polls piggyback on snapshot activity, so without this cache every
 * snapshot tick would hit the Hub over the network.
 *
 * The projection is deliberately honest about "unknown": when the host is
 * signed in but the Hub fetch failed (no numeric balance), `available` is
 * omitted instead of being zero-filled — the phone keeps its last known value,
 * exactly like the Desktop widget does.
 */
const MOBILE_BRIDGE_CREDITS_TTL_MS = 60_000;
interface MobileBridgeCreditsProjection {
  authenticated: boolean;
  available?: number;
  earnings?: number;
}
let mobileBridgeCreditsCache: { fetchedAt: number; value: MobileBridgeCreditsProjection } | null =
  null;
let mobileBridgeCreditsFlight: Promise<MobileBridgeCreditsProjection> | null = null;
async function getMobileBridgeCredits(): Promise<MobileBridgeCreditsProjection> {
  const cached = mobileBridgeCreditsCache;
  if (cached && Date.now() - cached.fetchedAt < MOBILE_BRIDGE_CREDITS_TTL_MS) return cached.value;
  const inFlight = mobileBridgeCreditsFlight;
  if (inFlight) return inFlight;
  const flight = (async (): Promise<MobileBridgeCreditsProjection> => {
    const balance = await getBillingCredits();
    const value: MobileBridgeCreditsProjection = { authenticated: balance.authenticated === true };
    if (typeof balance.remainingCredits === "number" && Number.isFinite(balance.remainingCredits)) {
      value.available = Math.max(0, Math.floor(balance.remainingCredits));
      value.earnings =
        typeof balance.earningsCredits === "number" && Number.isFinite(balance.earningsCredits)
          ? Math.max(0, Math.floor(balance.earningsCredits))
          : 0;
    }
    mobileBridgeCreditsCache = { fetchedAt: Date.now(), value };
    return value;
  })();
  mobileBridgeCreditsFlight = flight;
  try {
    return await flight;
  } finally {
    if (mobileBridgeCreditsFlight === flight) mobileBridgeCreditsFlight = null;
  }
}

function requireChat(id: string): Chat {
  const chat = getChat(id);
  if (!chat) throw new Error(`Chat not found: ${id}`);
  return chat;
}

interface MobileDecisionAnswerPrecondition {
  decisionId: string;
  taskId: string;
  taskVersion: number;
  contractVersion: typeof ONE_DECISION_CONTRACT_VERSION;
}

function mobileDecisionAnswerAcknowledgement(expected: MobileDecisionAnswerPrecondition) {
  return {
    contractVersion: expected.contractVersion,
    decisionId: expected.decisionId,
    taskId: expected.taskId,
    taskVersion: expected.taskVersion,
    status: "answer_claimed" as const,
  };
}

/** Warm the judged decision verdicts the synchronous validator peeks. Best-effort. */
async function prejudgePendingDecisionAnswer(chatId: string, decisionId: string): Promise<void> {
  const pending = listPendingConfirmations().find((candidate) =>
    candidate.chatId === chatId && candidate.sourceMessageId === decisionId);
  if (pending) await prejudgeOneDecision(pending).catch(() => undefined);
}

function validateCurrentMobileDecisionAnswer(
  invocation: McpInvocationRequest,
  expected: MobileDecisionAnswerPrecondition,
): void {
  const currentTask = findCanonicalTaskForChat(invocation.chatId);
  if (
    !currentTask
    || currentTask.id !== expected.taskId
    || currentTask.version !== expected.taskVersion
    || currentTask.status !== "waiting-decision"
    || currentTask.archivedAt !== null
    || getCanonicalTask(expected.taskId)?.version !== expected.taskVersion
  ) {
    throw new Error("Decision Task is stale or no longer waiting for this answer");
  }
  const pending = listPendingConfirmations().find((candidate) =>
    candidate.chatId === invocation.chatId
    && candidate.sourceMessageId === expected.decisionId
  );
  if (!pending || isPendingConfirmationSnoozed(pending, Date.now())) {
    throw new Error("Decision is stale, snoozed, or no longer pending");
  }
  // The async invoke paths warm the judged risk/disposition verdicts before this
  // synchronous validation; a cache miss remains fail-closed and cannot create
  // a lexical or static verdict.
  const view = normalizeOneDecision(pending, currentTask.id, oneDecisionJudgedReaders);
  if (
    view.contractVersion !== expected.contractVersion
    || view.decisionId !== expected.decisionId
    || view.taskId !== expected.taskId
    || view.chatId !== invocation.chatId
  ) {
    throw new Error("Decision projection changed; refresh before answering");
  }
  const reply = invocation.userPrompt ?? "";
  const optionAllowed = view.options.some((option) =>
    option.label === reply
    && option.enabled
    && option.disposition !== "modify"
  );
  if (!optionAllowed && reply !== view.controls.reject.reply) {
    throw new Error("Decision reply is not allowed by the current Main contract");
  }
}

function invocationParams(
  request: MobileBridgeRpcRequest,
  steering: false,
): { invocation: McpInvocationRequest; decisionAnswer?: MobileDecisionAnswerPrecondition };
function invocationParams(
  request: MobileBridgeRpcRequest,
  steering: true,
): { invocation: McpInvocationRequest; expectedRunId: string; decisionAnswer?: MobileDecisionAnswerPrecondition };
function invocationParams(
  request: MobileBridgeRpcRequest,
  steering: boolean,
): { invocation: McpInvocationRequest; expectedRunId?: string; decisionAnswer?: MobileDecisionAnswerPrecondition } {
  const params = guardedParams(
    request,
    steering
      ? [
          "runId",
          "chatId",
          "userPrompt",
          "locale",
          "permissions",
          "steeringMode",
          "planMode",
          "goalMode",
          "networkMode",
          "appsGenerateMode",
          "stormbreakerMode",
          "taskForceTargets",
          "images",
          "runtimeSelection",
          "expectedQuestionMessageId",
          "expectedTaskId",
          "expectedTaskVersion",
          "expectedDecisionContractVersion",
          "expectedRunId",
        ]
      : [
          "runId",
          "chatId",
          "userPrompt",
          "locale",
          "permissions",
          "planMode",
          "goalMode",
          "networkMode",
          "appsGenerateMode",
          "stormbreakerMode",
          "taskForceTargets",
          "images",
          "runtimeSelection",
          "expectedQuestionMessageId",
          "expectedTaskId",
          "expectedTaskVersion",
          "expectedDecisionContractVersion",
        ],
  );
  const chatId = requiredIdentifier(params, "chatId");
  const invocation: McpInvocationRequest = {
    chatId,
    userPrompt: requiredText(params, "userPrompt", 200_000),
  };
  const runId = optionalIdentifier(params, "runId", 160);
  const locale = optionalEnum(params, "locale", ["ko", "en"] as const);
  const permissions = optionalEnum(params, "permissions", ["read", "write", "full"] as const);
  const steeringMode = steering
    ? optionalEnum(params, "steeringMode", ["queue", "interrupt"] as const)
    : undefined;
  const planMode = optionalBoolean(params, "planMode");
  const goalMode = optionalBoolean(params, "goalMode");
  const networkMode = optionalBoolean(params, "networkMode");
  const appsGenerateMode = optionalBoolean(params, "appsGenerateMode");
  const stormbreakerMode = optionalBoolean(params, "stormbreakerMode");
  const taskForceTargets = optionalTurnAgentTargets(params);
  const images = optionalImages(params);
  const runtimeSelection = params.runtimeSelection === undefined
    ? undefined
    : mobileRuntimeSelectionFromValue(params.runtimeSelection, "orchestrator");
  const expectedQuestionMessageId = optionalIdentifier(params, "expectedQuestionMessageId");
  const expectedTaskId = optionalIdentifier(params, "expectedTaskId");
  const expectedTaskVersion = optionalInteger(params, "expectedTaskVersion", 1, Number.MAX_SAFE_INTEGER);
  const expectedDecisionContractVersion = optionalIdentifier(params, "expectedDecisionContractVersion", 32);
  const hasDecisionPrecondition = expectedQuestionMessageId !== undefined
    || expectedTaskId !== undefined
    || expectedTaskVersion !== undefined
    || expectedDecisionContractVersion !== undefined;
  let decisionAnswer: MobileDecisionAnswerPrecondition | undefined;
  if (hasDecisionPrecondition) {
    if (
      expectedQuestionMessageId === undefined
      || expectedTaskId === undefined
      || expectedTaskVersion === undefined
      || expectedDecisionContractVersion !== ONE_DECISION_CONTRACT_VERSION
    ) {
      throw new TypeError("Decision answers require exact Decision, Task, version, and contract preconditions");
    }
    decisionAnswer = {
      decisionId: expectedQuestionMessageId,
      taskId: expectedTaskId,
      taskVersion: expectedTaskVersion,
      contractVersion: ONE_DECISION_CONTRACT_VERSION,
    };
  }
  if (runId !== undefined) invocation.runId = runId;
  if (locale !== undefined) invocation.locale = locale;
  if (permissions !== undefined) invocation.permissions = permissions;
  if (steeringMode !== undefined) {
    invocation.steeringMode = steeringMode;
  } else if (steering && getChat(chatId)?.kind === "user") {
    // Older Mobile builds do not know the steeringMode field. Their One/Work
    // steering must still follow the Desktop interactive contract rather than
    // silently falling back to the old additive queue behavior.
    invocation.steeringMode = "interrupt";
  }
  if (planMode !== undefined) invocation.planMode = planMode;
  if (goalMode !== undefined) invocation.goalMode = goalMode;
  if (networkMode !== undefined) invocation.sessionRouting = networkMode;
  if (appsGenerateMode !== undefined) invocation.appsGenerateMode = appsGenerateMode;
  if (stormbreakerMode !== undefined) invocation.stormbreakerMode = stormbreakerMode;
  if (taskForceTargets !== undefined) invocation.taskForceTargets = taskForceTargets;
  if (images !== undefined) invocation.images = images;
  if (runtimeSelection !== undefined) invocation.runtimeSelection = runtimeSelection;
  const expectedRunId: MobileBridgeInvokeSteerParams["expectedRunId"] | undefined = steering
    ? requiredIdentifier(params, "expectedRunId", RUN_ID_RE)
    : undefined;
  return {
    invocation: enforceMobileInvocationPermissionBoundary(invocation),
    ...(expectedRunId !== undefined ? { expectedRunId } : {}),
    ...(decisionAnswer !== undefined ? { decisionAnswer } : {}),
  };
}

export function enforceMobileInvocationPermissionBoundary(
  invocation: McpInvocationRequest,
): McpInvocationRequest {
  return {
    ...invocation,
    permissions: normalizeRemoteInvocationPermission(invocation.permissions),
  };
}

function assertMobileOneDeviceAuthority(context: MobileBridgeConnectionContext): void {
  const explicitDevelopmentBootstrap =
    context.devBootstrap === true
    && context.devicePlatform === "dev"
    && process.env.NODE_ENV === "development"
    && process.env.AGENTLAS_MOBILE_BRIDGE_DEV_BOOTSTRAP === "1";
  if (explicitDevelopmentBootstrap) return;
  if (
    context.devBootstrap
    || context.devicePlatform === "dev"
    || (context.devicePlatform !== "ios" && context.devicePlatform !== "android")
    || !/^device_[a-f0-9]{32}$/.test(context.deviceId)
  ) {
    throw new Error(
      "Mobile One requires an iOS or Android pairing credential issued after account verification",
    );
  }
}

function mobileRuntimeSelectionFromValue(
  value: unknown,
  role: RuntimeRole,
): RuntimeSelection {
  if (!isRecord(value)) throw new TypeError("Runtime selection must be an object");
  assertOnlyKeys(
    value,
    ["kind", "backend", "model", "effort", "longContext", "role", "inherit"],
    "runtime selection",
  );
  const kind = requiredEnum(value, "kind", MOBILE_RUNTIME_KINDS) as RuntimeKind;
  const selectedRole = optionalEnum(value, "role", MOBILE_RUNTIME_ROLES) ?? role;
  if (selectedRole !== role) {
    throw new TypeError(`Runtime selection role must be ${role}`);
  }
  const inherit = optionalBoolean(value, "inherit") ?? false;
  if (role === "orchestrator" && inherit) {
    throw new TypeError("The orchestrator runtime cannot inherit");
  }
  const backend = optionalEnum(value, "backend", MOBILE_RUNTIME_BACKENDS) as RuntimeBackend | undefined;
  const model = optionalIdentifier(value, "model", 512);
  const effort = optionalIdentifier(value, "effort", 80);
  return {
    kind,
    ...(backend !== undefined ? { backend } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    longContext: optionalBoolean(value, "longContext") ?? false,
    role,
    inherit: role === "worker" && inherit,
  };
}

async function resolveMobileRoleSelection(
  selection: RuntimeSelection,
): Promise<RuntimeSelection> {
  const candidates = await detectRuntimes();
  const runtime = candidates.find((candidate) =>
    candidate.kind === selection.kind &&
    (selection.backend === undefined || candidate.backend === selection.backend),
  );
  if (!runtime) throw new Error("The selected Desktop runtime is unavailable");
  if (runtimeCredentialUnavailable(runtime)) {
    throw new Error("The selected Desktop runtime credential is unavailable");
  }
  if (
    selection.model &&
    (runtime.availableModels?.length ?? 0) > 0 &&
    !runtime.availableModels!.includes(selection.model)
  ) {
    throw new Error("The selected model is unavailable on this Desktop runtime");
  }
  if (
    selection.effort &&
    (runtime.efforts?.length ?? 0) > 0 &&
    !runtime.efforts!.some((item) => item.id === selection.effort)
  ) {
    throw new Error("The selected effort is unavailable on this Desktop runtime");
  }
  return {
    ...selection,
    backend: runtime.backend,
    source: runtime.source,
  };
}

async function mobileRuntimeRolePoolDto() {
  const picks = await resolveRolePoolPicks();
  return projectMobileBridgeRuntimeRolePool({
    members: {
      orchestrator: listModelRoleMembers("orchestrator"),
      worker: listModelRoleMembers("worker"),
      // 모바일은 대화 역할만 조작한다(MOBILE_RUNTIME_ROLES). 멀티모달 슬롯은
      // 데스크탑에서 정하므로 여기서는 빈 목록으로 투영한다 —
      // shared/runtime-roles.ts 의 mobileEditable=false 가 그 계약이다.
      multimodal: [],
    },
    picks,
  });
}

function mobileOneStartParams(request: MobileBridgeRpcRequest): {
  userPrompt: string;
  permissions: "read" | "write" | "full";
  planMode?: true;
  goalMode?: true;
  networkMode?: true;
  liveMode?: true;
  images?: ImageAttachment[];
  taskForceTargets?: OrchestrationTarget[];
  runtimeSelection?: RuntimeSelection;
} {
  const params = guardedParams(request, [
    "schemaVersion",
    "userPrompt",
    "permissions",
    "planMode",
    "goalMode",
    "networkMode",
    "liveMode",
    "taskForceTargets",
    "images",
    "runtimeSelection",
  ]);
  if (params.schemaVersion !== 1) {
    throw new TypeError("one.invoke.start requires schemaVersion 1");
  }
  const userPrompt = requiredText(params, "userPrompt", 200_000);
  if (userPrompt.trim().length === 0) {
    throw new TypeError("one.invoke.start userPrompt must contain visible text");
  }
  const permissions = normalizeRemoteInvocationPermission(
    optionalEnum(params, "permissions", ["read", "write", "full"] as const),
  );
  const planMode = optionalBoolean(params, "planMode");
  const goalMode = optionalBoolean(params, "goalMode");
  const networkMode = optionalBoolean(params, "networkMode");
  const liveMode = optionalBoolean(params, "liveMode");
  const images = optionalImages(params);
  const taskForceTargets = optionalTurnAgentTargets(params);
  const runtimeSelection = params.runtimeSelection === undefined
    ? undefined
    : mobileRuntimeSelectionFromValue(params.runtimeSelection, "orchestrator");
  return {
    userPrompt,
    permissions,
    ...(planMode === true ? { planMode: true as const } : {}),
    ...(goalMode === true ? { goalMode: true as const } : {}),
    ...(networkMode === true ? { networkMode: true as const } : {}),
    ...(liveMode === true ? { liveMode: true as const } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(runtimeSelection !== undefined ? { runtimeSelection } : {}),
    ...(taskForceTargets !== undefined ? { taskForceTargets } : {}),
    ...(runtimeSelection !== undefined ? { runtimeSelection } : {}),
  };
}

function mobileOneConversationTitle(userPrompt: string): string {
  const firstLine = userPrompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return (firstLine || "One").slice(0, 200);
}

async function bindMobileOneTurn(
  invocation: McpInvocationRequest,
): Promise<McpInvocationRequest> {
  const targets = invocation.taskForceTargets ?? [];
  const oneInvocation: McpInvocationRequest = {
    ...invocation,
    oneMode: true,
    taskForceTargets: undefined,
  };
  if (targets.length === 0) return oneInvocation;
  if (!targets.every((target) => target.source === "local" && target.entityKind === "agent")) {
    throw new Error("A turn-only remote agent requires an exact prepared Workforce release");
  }
  const task = findCanonicalTaskForChat(invocation.chatId);
  const prepared = await prepareOneTeamPreflight({
    chatId: invocation.chatId,
    userPrompt: invocation.userPrompt,
    expectedTaskId: task?.id ?? null,
    expectedTaskVersion: task?.version ?? null,
    requestedAgentIds: targets.map((target) => target.agentId),
    permission: invocation.permissions === "read" ? "read" : "write",
  });
  if (prepared.kind !== "proposal" || !prepared.proposal.canConfirmTeam) {
    throw new Error("The exact turn-only agent roster could not be prepared");
  }
  const resolved = await autoResolveOneTeamPreflight({
    proposalId: prepared.proposal.proposalId,
    expectedProposalVersion: prepared.proposal.version,
    requestedRunId: invocation.runId ?? randomUUID(),
  });
  if (resolved.kind !== "reserved") {
    throw new Error("The exact turn-only agent roster was not reserved");
  }
  return {
    ...oneInvocation,
    runId: resolved.ref.reservedRunId,
    oneTeamPreflightRef: resolved.ref,
  };
}

/** DESKTOP_MOBILE_BRIDGE: History strips in-memory data URLs; generic files cross as bounded metadata only. */
function projectInvocationHistory(
  history: ReturnType<typeof invocationService.history>,
  limit: number,
  chatId: string,
): MobileBridgeJsonValue {
  return asJsonValue(projectMobileBridgeHistory(history, limit, undefined, chatId), "invoke.history");
}

/** DESKTOP_MOBILE_BRIDGE: resultFolder is a local absolute path and is never projected. */
function projectInvocationReceipt(receipt: InvocationRunReceipt | null): MobileBridgeJsonValue {
  if (!receipt) return null;
  return asJsonValue(
    {
      runId: receipt.runId,
      chatId: receipt.chatId,
      status: receipt.status,
      startedAt: receipt.startedAt,
      updatedAt: receipt.updatedAt,
      finishedAt: receipt.finishedAt ?? null,
      eventCount: receipt.eventCount,
      hasImages: receipt.hasImages ?? false,
      // Mobile receives execution state only. Failure evidence remains on the
      // Desktop host for One/project-controller recovery judgment.
      errorCode: null,
      errorMessage: null,
    },
    "invoke.receipt",
  );
}

function toolPayloadSize(length: number): MobileBridgeToolPayloadSize {
  if (length === 0) return "empty";
  if (length <= 256) return "small";
  if (length <= 4_096) return "medium";
  return "large";
}

/** 표시용 도구 라벨의 길이 상한. 한 줄에 들어갈 만큼만 보낸다. */
const TOOL_DISPLAY_SUMMARY_BYTES = 512;
const TOOL_DISPLAY_LABEL_BYTES = 160;

/**
 * 도구 인자에서 뽑은 값은 **깨끗할 때만** 건넌다.
 *
 * "도구 본문은 브리지를 건너지 않는다"는 기존 경계를 넓히지 않기 위해서다. 값에
 * 비밀·로컬 경로·data URL 이 하나라도 섞여 있으면 `[local-path]` 같은 흔적을
 * 보내는 대신 **그 값을 통째로 버린다**. 폰은 그 줄을 이름과 사실만으로 그린다.
 */
function cleanToolDisplayValue(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return undefined;
  const safe = sanitizeMobileBridgeText(value, maxBytes);
  if (safe.includes("[local-path]") || safe.includes("[redacted-")) return undefined;
  return safe.trim() || undefined;
}

/**
 * 도구 행의 **의미**를 폰으로 넘긴다.
 *
 * 판별은 shared/tool-call-detail.ts 한 벌이 소유한다 — 폰이 러너별 도구 이름을
 * 보고 다시 추측하면 두 표면이 갈라진다(2026-08-08 실측 사고: 렌더러가 Claude Code
 * 도구명만 알아 codex/antigravity/ollama/MCP를 전부 "기타"로 그렸고, bash는 실제 명령을
 * 버렸다).
 *
 * 이름과 사실(`exit 0`, `+23 −1`, `8 files · 31 matches`)은 집계값이라 늘 안전하다.
 * 식별값(summary)만 cleanToolDisplayValue 를 통과해야 하고, 원문 args·result 는
 * 예나 지금이나 브리지를 건너지 않는다.
 */
function projectToolCallDisplay(
  tool: NonNullable<McpInvocationEvent["tool"]>,
  cwd?: string,
): MobileBridgeToolCallDisplayDto | undefined {
  let detail: ReturnType<typeof normalizeToolCall>;
  try {
    // `cwd` is what makes a file row survive. Without it every Read/Edit/Write
    // summary is an ABSOLUTE path, sanitize turns it into `[local-path]`, and
    // cleanToolDisplayValue then drops the whole value — so the phone drew
    // "파일 읽기" with no file at all. Relative to the run's own folder
    // (`lib/features/chat/foo.dart`) the path is both safe and the entire point
    // of the row.
    detail = normalizeToolCall({ name: tool.name, args: tool.args, result: tool.result, cwd });
  } catch {
    return undefined;
  }
  const failed = tool.isError === true;
  const status = failed ? "failed" as const : "completed" as const;
  // buildToolCallDisplay only returns errorText when it is GIVEN one. Not
  // passing the result meant `errorText` could never be set, so the phone —
  // which inferred failure from its presence — drew every failed tool call as a
  // success.
  const rawErrorText = failed ? tool.result : undefined;
  const ko = buildToolCallDisplay({ name: tool.name, detail, status, errorText: rawErrorText, locale: "ko" });
  const en = buildToolCallDisplay({ name: tool.name, detail, status, errorText: rawErrorText, locale: "en" });
  const displayNameKo = cleanToolDisplayValue(ko.displayName, TOOL_DISPLAY_LABEL_BYTES);
  const displayNameEn = cleanToolDisplayValue(en.displayName, TOOL_DISPLAY_LABEL_BYTES);
  // 이름조차 깨끗하지 않으면(도구 이름이 경로인 경우 등) 행 의미를 보내지 않는다.
  if (!displayNameKo || !displayNameEn) return undefined;
  const summary = cleanToolDisplayValue(ko.summary, TOOL_DISPLAY_SUMMARY_BYTES);
  const factsKo = cleanToolDisplayValue(ko.facts, TOOL_DISPLAY_LABEL_BYTES);
  const factsEn = cleanToolDisplayValue(en.facts, TOOL_DISPLAY_LABEL_BYTES);
  const errorText = cleanToolDisplayValue(ko.errorText, TOOL_DISPLAY_SUMMARY_BYTES);
  return {
    kind: detail.type,
    displayNameKo,
    displayNameEn,
    ...(summary ? { summary } : {}),
    ...(factsKo ? { factsKo } : {}),
    ...(factsEn ? { factsEn } : {}),
    // The flag travels even when the reason cannot: a dropped reason must not
    // silently turn a failure into a success.
    ...(failed ? { failed: true } : {}),
    ...(errorText ? { errorText } : {}),
  };
}

/**
 * 이 채팅이 실제로 돌고 있는 폴더. 도구 행의 경로를 상대경로로 줄이는 데만 쓴다 —
 * 이 값 자체는 폰으로 건너가지 않는다.
 *
 * 우선순위: 채팅에 고정된 작업 폴더 → 프로젝트 폴더. 둘 다 없으면 undefined 이고,
 * 그때는 예전처럼 경로가 통째로 버려진다(안전한 쪽으로 실패).
 */
function resolveChatCwd(chatId: string): string | undefined {
  try {
    const working = getChatWorkingFolder(chatId);
    if (working && working.trim()) return working.trim();
    const projectId = getChat(chatId)?.projectId;
    if (!projectId) return undefined;
    const folder = getProject(projectId)?.folderPath;
    return folder && folder.trim() ? folder.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * runId → {cwd, taskId}. 라이브 이벤트는 토큰마다 오지만 폴더와 Task 바인딩은
 * 실행당 하나다(Task는 채팅 생성 시점에 루트 채팅에 묶인다). 종료(final/error)
 * 시 지우고, 취소처럼 종료 이벤트가 안 오는 경우를 대비해 상한을 둔다 —
 * 무한히 자라는 맵은 그 자체가 결함이다.
 */
const RUN_CONTEXT_CACHE_MAX = 64;
interface RunEventContext {
  cwd: string | undefined;
  taskId: string | null;
}
const runContextCache = new Map<string, RunEventContext>();

function cachedRunContext(runId: string, chatId: string): RunEventContext {
  const hit = runContextCache.get(runId);
  if (hit) return hit;
  const resolved: RunEventContext = {
    cwd: resolveChatCwd(chatId),
    taskId: findCanonicalTaskForChat(chatId)?.id ?? null,
  };
  if (runContextCache.size >= RUN_CONTEXT_CACHE_MAX) {
    const oldest = runContextCache.keys().next();
    if (!oldest.done) runContextCache.delete(oldest.value);
  }
  runContextCache.set(runId, resolved);
  return resolved;
}

function forgetRunContext(runId: string): void {
  runContextCache.delete(runId);
}

function summarizeToolPayload(value: string | undefined): MobileBridgeToolPayloadSummaryDto | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const size = toolPayloadSize(value.length);
  if (!trimmed) return { shape: "empty", size };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { shape: "text", size };
  }
  if (Array.isArray(parsed)) {
    return {
      shape: "json-array",
      size,
      itemCount: Math.min(parsed.length, TOOL_COUNT_CAP),
      ...(parsed.length > TOOL_COUNT_CAP ? { countCapped: true } : {}),
    };
  }
  if (isRecord(parsed)) {
    const fieldCount = Object.keys(parsed).length;
    return {
      shape: "json-object",
      size,
      fieldCount: Math.min(fieldCount, TOOL_COUNT_CAP),
      ...(fieldCount > TOOL_COUNT_CAP ? { countCapped: true } : {}),
    };
  }
  return { shape: "json-scalar", size };
}

export function projectMobileBridgeInvocationEvent(
  event: McpInvocationEvent,
  context?: { taskId?: string | null; chatId?: string | null; runId?: string | null; syncedAt?: string; cwd?: string | null },
): MobileBridgeInvocationEventDto {
  // "mcp-key-request" is a desktop-renderer-only elicitation signal — the
  // mobile client has no key sheet and its DTO union stays closed. Project it
  // as a harmless value-free "thinking" beat (keyRequest itself is never sent).
  const projected: MobileBridgeInvocationEventDto = {
    // The current phone protocol predates the explicit desktop lifecycle item.
    // Project it to the existing value-free thinking beat until the mobile
    // contract grows the same typed boundary; never leak a free-form status.
    kind: event.kind === "mcp-key-request" || event.kind === "lifecycle" ? "thinking" : event.kind,
  };
  if (event.kind === "notice" && event.notice) {
    // 고지는 폰에도 간다. 다만 기계 원문(details)은 보내지 않는다 — 화면에 쓸 값만.
    // 심각도와 표시 형태는 같이 보낸다. 그게 없으면 폰은 "컨텍스트를 압축했습니다"와
    // "결과를 정리하지 못했습니다"를 같은 회색 줄로 그리게 된다.
    projected.status = boundedRedactedText(event.notice.message, 1_000);
    projected.noticeLevel = event.notice.level;
    if (event.notice.display === "divider" || event.notice.display === "row") {
      projected.noticeDisplay = event.notice.display;
    }
    // 이 문장은 **실행의 로케일**로 이미 렌더돼 있다. 폰이 다른 언어로 설정돼 있으면
    // 남의 언어가 그대로 뜬다(데스크탑이 시작한 실행에 폰이 붙어 볼 때). 만드는
    // 자리에서 두 벌을 내면 폰이 자기 것을 고를 수 있다.
    if (event.notice.i18n) {
      projected.noticeTextKo = boundedRedactedText(event.notice.i18n.ko, 1_000);
      projected.noticeTextEn = boundedRedactedText(event.notice.i18n.en, 1_000);
    }
  }
  if (typeof event.status === "string") {
    projected.status = boundedRedactedText(event.status, 1_000);
  }
  if (typeof event.text === "string") {
    const text = boundedRedactedText(
      stripMobileBridgeControlFences(event.text),
      EVENT_TEXT_MAX_BYTES,
    );
    projected.text = text;
    projected.textLen = text.length;
  } else if (typeof event.delta === "string") {
    const delta = boundedRedactedText(event.delta, EVENT_DELTA_MAX_BYTES);
    projected.delta = delta;
    // A redacted or truncated delta no longer has the same cumulative length.
    // Omitting textLen forces the client to rely on attach/final resync instead
    // of treating the host's pre-redaction length as proof.
    if (delta === event.delta && Number.isInteger(event.textLen) && Number(event.textLen) >= 0) {
      projected.textLen = event.textLen;
    }
  } else if (Number.isInteger(event.textLen) && Number(event.textLen) >= 0) {
    projected.textLen = event.textLen;
  }
  if (Number.isFinite(event.tokens) && Number(event.tokens) >= 0) {
    projected.tokens = Math.floor(Number(event.tokens));
  }
  if (typeof event.agentId === "string") {
    projected.agentId = boundedRedactedText(event.agentId, 256);
  }
  if (typeof event.agentName === "string") {
    projected.agentName = boundedRedactedText(event.agentName, 300);
  }
  if (typeof event.role === "string") {
    projected.role = boundedRedactedText(event.role, 300);
  }
  if (event.phase === "plan" || event.phase === "delegate" || event.phase === "synthesize") {
    projected.phase = event.phase;
  }
  if (event.reasoning?.phase === "start" || event.reasoning?.phase === "end") {
    projected.reasoning = {
      phase: event.reasoning.phase,
      ...(Number.isFinite(event.reasoning.durationMs) && Number(event.reasoning.durationMs) >= 0
        ? { durationMs: Math.floor(Number(event.reasoning.durationMs)) }
        : {}),
      // The span's summary text (end only; deltas stay desktop-live). Bounded and
      // redacted like every other mirrored string so the phone can show the same
      // collapsed "Thought for Ns" row without a second protocol.
      ...(event.reasoning.phase === "end" && typeof event.reasoning.text === "string" && event.reasoning.text.trim()
        ? { text: boundedRedactedText(event.reasoning.text, 2_000) }
        : {}),
    };
  }
  if (event.error) {
    projected.error = {
      code: boundedRedactedText(event.error.code, 160),
      message: boundedRedactedText(event.error.message, 4_000),
    };
  }
  if (event.tool && typeof event.tool.name === "string") {
    projected.tool = {
      name: boundedRedactedText(event.tool.name, 200),
      id: typeof event.tool.id === "string" ? boundedRedactedText(event.tool.id, 256) : null,
      isError: event.tool.isError === true,
      input: summarizeToolPayload(event.tool.args),
      output: summarizeToolPayload(event.tool.result),
      display: projectToolCallDisplay(event.tool, context?.cwd ?? undefined),
    };
  }
  if (event.oneArtifacts?.length && context?.taskId && context.chatId) {
    const artifacts = projectMobileBridgeOneArtifacts(event.oneArtifacts, {
      taskId: context.taskId,
      chatId: context.chatId,
      runId: context.runId,
      limit: EVENT_ONE_ARTIFACT_LIMIT,
    });
    if (artifacts.length > 0) projected.oneArtifacts = artifacts;
  }
  if (event.kind === "surface" && event.oneSurface && context?.taskId && event.oneSurface.taskId === context.taskId) {
    projected.surface = event.oneSurface;
  }
  // DESKTOP_MOBILE_BRIDGE: raw surface manifest, provider/model/session
  // metadata, delegation graph, env, and local filesystem fields are omitted.
  // TypeScript owns the DTO shape; a final runtime assertion prevents future
  // optional fields from becoming non-JSON without review.
  asJsonValue(projected, "invoke.event");
  return projected;
}

const MOBILE_ONE_ARTIFACT_TYPES = new Set([
  "document", "spreadsheet", "image", "video", "audio", "archive", "data", "other",
]);

function projectMobileBridgeOneArtifacts(
  value: unknown,
  context: { taskId?: string | null; chatId: string; runId?: string | null; limit: number },
): MobileBridgeInvocationArtifactDto[] {
  if (!Array.isArray(value) || !IDENTIFIER_RE.test(context.chatId)) return [];
  const seen = new Set<string>();
  const artifacts: MobileBridgeInvocationArtifactDto[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const taskId = candidate.taskId;
    const taskVersion = candidate.taskVersion;
    const chatId = candidate.chatId;
    const runId = candidate.runId;
    const manifestId = candidate.manifestId;
    const artifactRef = candidate.artifactRef;
    const label = candidate.label;
    const type = candidate.type;
    if (
      typeof taskId !== "string" || !IDENTIFIER_RE.test(taskId) ||
      context.taskId && taskId !== context.taskId ||
      !Number.isSafeInteger(taskVersion) || Number(taskVersion) < 1 ||
      chatId !== context.chatId ||
      typeof runId !== "string" || !IDENTIFIER_RE.test(runId) ||
      context.runId && runId !== context.runId ||
      typeof manifestId !== "string" || !IDENTIFIER_RE.test(manifestId) ||
      typeof artifactRef !== "string" || !IDENTIFIER_RE.test(artifactRef) ||
      typeof label !== "string" || !label.trim() ||
      typeof type !== "string" || !MOBILE_ONE_ARTIFACT_TYPES.has(type)
    ) continue;
    const key = `${runId}\u0000${artifactRef}`;
    if (!seen.add(key)) continue;
    artifacts.push({
      taskId,
      taskVersion: Number(taskVersion),
      chatId,
      runId,
      manifestId,
      artifactRef,
      label: boundedRedactedText(label, 512),
      type: type as MobileBridgeInvocationArtifactDto["type"],
      ...(Number.isSafeInteger(candidate.sizeBytes) && Number(candidate.sizeBytes) >= 0
        ? { sizeBytes: Number(candidate.sizeBytes) }
        : {}),
      ...(typeof candidate.contentSha256 === "string" && /^[a-f0-9]{64}$/u.test(candidate.contentSha256)
        ? { contentSha256: candidate.contentSha256 }
        : {}),
    });
    if (artifacts.length >= context.limit) break;
  }
  return artifacts;
}

export function projectMobileBridgeRecentOneArtifacts(
  chatId: string,
  limit = RECENT_ONE_ARTIFACT_LIMIT,
): MobileBridgeInvocationArtifactDto[] {
  const boundedLimit = Math.max(1, Math.min(RECENT_ONE_ARTIFACT_LIMIT, Math.floor(limit)));
  const newestFirst: MobileBridgeInvocationArtifactDto[] = [];
  const seen = new Set<string>();
  artifactEvents:
  for (const event of iterateRecentChatOneArtifactEvents(chatId)) {
    const projected = projectMobileBridgeOneArtifacts(event.payload.oneArtifacts, {
      chatId,
      runId: event.runId,
      limit: EVENT_ONE_ARTIFACT_LIMIT,
    });
    // The ledger event preserves creation order. Scan it backwards while the
    // outer iterator walks newest-to-oldest, then reverse the bounded answer so
    // Mobile renders the recent index chronologically.
    for (let index = projected.length - 1; index >= 0; index -= 1) {
      const artifact = projected[index];
      const key = `${artifact.runId}\u0000${artifact.artifactRef}`;
      if (!seen.add(key)) continue;
      newestFirst.push(artifact);
      if (newestFirst.length >= boundedLimit) break artifactEvents;
    }
  }
  return newestFirst.reverse();
}

/**
 * Concrete adapter between the authenticated socket server and existing
 * Desktop stores/services.
 *
 * DESKTOP_MOBILE_BRIDGE: This class owns no SQLite connection, run registry,
 * approval queue, scheduler, or fixture state. Every result comes from the same
 * Desktop authority used by Electron IPC and passes through a secret-free
 * projector before it reaches a phone.
 */
export class AgentlasDesktopMobileBridgeAuthority implements MobileBridgeAuthority {
  private readonly listeners = new Set<AuthorityListener>();
  private readonly onError: (error: Error) => void;
  private readonly cloudAgentActions: MobileBridgeCloudAgentActions;
  private readonly buildActions: MobileBridgeBuildActions;
  /**
   * Mobile terminal ownership is kept in the Desktop authority, not in the
   * phone. A reconnect therefore cannot silently reuse an old takeover epoch.
   */
  private readonly terminalLeases = new Map<string, MobileTerminalLeaseState>();
  private readonly buildRuns = new Map<string, {
    status: InternalMobileBuildStatus;
    /** True until the builder promise settles, even after a terminal event. */
    active: boolean;
    summary: string | null;
    questions: MobileBridgeBuildQuestionDto[];
    refusal: MobileBridgeBuildRefusalDto | null;
    controller: AbortController;
    startedAt: number;
    locale: "ko" | "en";
    workspace: string | null;
    runtimeSessionId: string | null;
    history: Array<{ role: "user" | "assistant"; text: string }>;
    lastPrompt: string;
    questionSetId: string | null;
    answerInFlight: boolean;
  }>();
  private upstreamUnsubscribers: Array<() => void> = [];
  private refreshQueued = false;
  private refreshRunning = false;
  private refreshRequested = false;
  private readonly pendingAutomationIds = new Set<string>();
  private lastConfirmationFingerprint: string | null = null;
  private lastOntologyFingerprint: string | null = null;
  private ontologyRefreshRequested = false;
  private disposed = false;

  constructor(private readonly options: AgentlasDesktopMobileBridgeAuthorityOptions) {
    if (
      options.hostIdentity.version !== MOBILE_BRIDGE_PROTOCOL_VERSION ||
      !/^host_[a-f0-9]{32}$/.test(options.hostIdentity.hostId) ||
      !Number.isFinite(Date.parse(options.hostIdentity.createdAt))
    ) {
      throw new Error("Invalid Mobile Bridge host identity");
    }
    if (!options.displayName.trim() || options.displayName.length > 160) {
      throw new Error("Invalid Mobile Bridge display name");
    }
    if (!options.appVersion.trim() || options.appVersion.length > 80) {
      throw new Error("Invalid Mobile Bridge app version");
    }
    this.onError = options.onError ?? ((error) => console.error("[mobile-bridge-authority]", error.message));
    this.cloudAgentActions = options.cloudAgentActions ?? createDesktopMobileBridgeCloudAgentActions();
    this.buildActions = options.buildActions ?? createDesktopMobileBridgeBuildActions();
    queueMicrotask(() => {
      void resumeMobileOneAutoRecovery(invocationService).catch((error) => this.onError(errorOf(error)));
    });
  }

  /** DESKTOP_MOBILE_BRIDGE: Initial state is always a fresh Desktop projection; no seed fallback. */
  async snapshot(_context: MobileBridgeConnectionContext): Promise<MobileBridgeSnapshot> {
    this.assertAvailable();
    const snapshot = await this.projectSnapshot();
    this.lastConfirmationFingerprint = this.confirmationFingerprint(snapshot);
    this.lastOntologyFingerprint = this.ontologyFingerprint(snapshot);
    return snapshot;
  }

  async pairingVerification(_context: MobileBridgeConnectionContext): Promise<{
    hostId: string;
    sampleTaskId: string | null;
    sampleTaskVersion: number | null;
  }> {
    this.assertAvailable();
    // A credential must never outlive a verification receipt the Mobile client
    // is able to prove. Let failures reach the server so it rolls the freshly
    // issued device credential back instead of returning an unusable success.
    const sample = ensurePairingVerificationTask(
      this.options.hostIdentity.hostId,
      _context.connectedAt,
      _context.deviceId,
    );
    return {
      hostId: this.options.hostIdentity.hostId,
      sampleTaskId: sample.id,
      sampleTaskVersion: sample.version,
    };
  }

  private terminalLease(terminalId: string): MobileTerminalLeaseState {
    const current = this.terminalLeases.get(terminalId);
    if (current) return current;
    const created: MobileTerminalLeaseState = {
      owner: "agent",
      ownerEpoch: 0,
      ownerDeviceId: null,
      previews: new Map(),
    };
    this.terminalLeases.set(terminalId, created);
    return created;
  }

  private terminalUnavailableRead(terminalId: string): MobileBridgeTerminalReadDto {
    return {
      schemaVersion: 1,
      terminalId,
      status: "unavailable",
      owner: "none",
      ownerEpoch: 0,
      lines: [],
      nextSeq: 0,
      truncated: false,
      refusal: terminalRefusal(
        "terminal_unavailable",
        "This Desktop has no authoritative mobile terminal controller.",
      ),
    };
  }

  private async terminalRead(
    params: Record<string, unknown>,
    context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeJsonValue> {
    const terminalId = requiredIdentifier(params, "terminalId", RUN_ID_RE);
    const sinceSeq = optionalInteger(params, "sinceSeq", 0, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(params, "limit", 1, 500);
    const control = this.options.terminalControl;
    if (!control) return asJsonValue(this.terminalUnavailableRead(terminalId), "terminal.read");
    const lease = this.terminalLease(terminalId);
    try {
      const result = await control.read({ terminalId, ...(sinceSeq === undefined ? {} : { sinceSeq }), ...(limit === undefined ? {} : { limit }) }, context);
      const normalized: MobileBridgeTerminalReadDto = {
        ...result,
        schemaVersion: 1,
        terminalId,
        owner: lease.owner,
        ownerEpoch: lease.ownerEpoch,
      };
      return asJsonValue(normalized, "terminal.read");
    } catch (error) {
      this.onError(errorOf(error));
      return asJsonValue({
        ...this.terminalUnavailableRead(terminalId),
        refusal: terminalRefusal(
          "terminal_control_unavailable",
          "The Desktop terminal controller did not answer.",
        ),
      }, "terminal.read");
    }
  }

  private async terminalPreview(
    params: Record<string, unknown>,
    context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeJsonValue> {
    const terminalId = requiredIdentifier(params, "terminalId", RUN_ID_RE);
    const command = requiredText(params, "command", 4_000);
    if (command.trim().length === 0) throw new TypeError("command must contain visible text");
    const control = this.options.terminalControl;
    if (!control) return asJsonValue(terminalRefusal(
      "terminal_unavailable",
      "This Desktop has no authoritative mobile terminal controller.",
    ), "terminal.preview");
    const lease = this.terminalLease(terminalId);
    try {
      const result = await control.preview({ terminalId, command, ownerEpoch: lease.ownerEpoch }, context);
      if (result.terminalId !== terminalId || !result.previewId || !result.expiresAt) {
        throw new Error("Desktop terminal preview returned an invalid receipt");
      }
      const risk = result.risk === "dangerous" ? "dangerous" : "safe";
      const expiresAtMs = Date.parse(result.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        return asJsonValue(terminalRefusal(
          "terminal_preview_expired",
          "The Desktop returned an expired terminal preview.",
        ), "terminal.preview");
      }
      lease.previews.set(result.previewId, {
        terminalId,
        previewId: result.previewId,
        ownerEpoch: lease.ownerEpoch,
        risk,
        expiresAt: result.expiresAt,
        expiresAtMs,
      });
      // A terminal may accumulate previews while a phone is offline. Keep the
      // authority bounded and make every dispatch use the latest epoch.
      for (const [previewId, preview] of lease.previews) {
        if (preview.expiresAtMs <= Date.now() || previewId === result.previewId) continue;
        lease.previews.delete(previewId);
      }
      return asJsonValue({
        ...result,
        schemaVersion: 1,
        terminalId,
        command,
        risk,
        requiresApproval: risk === "dangerous" || result.requiresApproval === true,
        ownerEpoch: lease.ownerEpoch,
      }, "terminal.preview");
    } catch (error) {
      this.onError(errorOf(error));
      return asJsonValue(terminalRefusal(
        "terminal_control_unavailable",
        "The Desktop terminal controller did not produce a preview.",
      ), "terminal.preview");
    }
  }

  private async terminalTakeover(
    params: Record<string, unknown>,
    context: MobileBridgeConnectionContext,
    request: MobileBridgeRpcRequest,
  ): Promise<MobileBridgeJsonValue> {
    const terminalId = requiredIdentifier(params, "terminalId", RUN_ID_RE);
    const expectedOwnerEpoch = optionalInteger(params, "expectedOwnerEpoch", 0, Number.MAX_SAFE_INTEGER);
    if (expectedOwnerEpoch === undefined) throw new TypeError("expectedOwnerEpoch is required");
    const control = this.options.terminalControl;
    if (!control) return asJsonValue(terminalWriteRefusal(request, terminalId,
      "terminal_unavailable",
      "This Desktop has no authoritative mobile terminal controller.",
    ), "terminal.takeover");
    const lease = this.terminalLease(terminalId);
    if (lease.owner === "mobile") {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        lease.ownerDeviceId === context.deviceId ? "terminal_owner_conflict" : "terminal_owner_conflict",
        lease.ownerDeviceId === context.deviceId
          ? "This phone already owns the terminal."
          : "Another paired phone currently owns the terminal.",
      ), "terminal.takeover");
    }
    if (lease.ownerEpoch !== expectedOwnerEpoch) {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_epoch_conflict",
        "The terminal changed on Desktop. Reload it before taking control.",
      ), "terminal.takeover");
    }
    const nextOwnerEpoch = lease.ownerEpoch + 1;
    try {
      await control.takeover({ terminalId, expectedOwnerEpoch, nextOwnerEpoch }, context);
      lease.owner = "mobile";
      lease.ownerDeviceId = context.deviceId;
      lease.ownerEpoch = nextOwnerEpoch;
      return asJsonValue({ schemaVersion: 1, terminalId, owner: "mobile", ownerEpoch: nextOwnerEpoch } satisfies MobileBridgeTerminalTakeoverDto, "terminal.takeover");
    } catch (error) {
      this.onError(errorOf(error));
      // The controller may have applied the takeover before its response was
      // lost. Surface an authority failure so Mobile reconciles terminal.read;
      // never forge an exact negative receipt after mutation began.
      throw errorOf(error);
    }
  }

  private async terminalRelease(
    params: Record<string, unknown>,
    context: MobileBridgeConnectionContext,
    request: MobileBridgeRpcRequest,
  ): Promise<MobileBridgeJsonValue> {
    const terminalId = requiredIdentifier(params, "terminalId", RUN_ID_RE);
    const ownerEpoch = optionalInteger(params, "ownerEpoch", 1, Number.MAX_SAFE_INTEGER);
    if (ownerEpoch === undefined) throw new TypeError("ownerEpoch is required");
    const control = this.options.terminalControl;
    if (!control) return asJsonValue(terminalWriteRefusal(request, terminalId,
      "terminal_unavailable",
      "This Desktop has no authoritative mobile terminal controller.",
    ), "terminal.release");
    const lease = this.terminalLease(terminalId);
    if (lease.owner !== "mobile" || lease.ownerDeviceId !== context.deviceId) {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_owner_conflict",
        "This phone does not own the terminal.",
      ), "terminal.release");
    }
    if (lease.ownerEpoch !== ownerEpoch) {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_epoch_conflict",
        "The terminal changed before control was returned.",
      ), "terminal.release");
    }
    const nextOwnerEpoch = lease.ownerEpoch + 1;
    try {
      await control.release({ terminalId, ownerEpoch, nextOwnerEpoch }, context);
      lease.owner = "agent";
      lease.ownerDeviceId = null;
      lease.ownerEpoch = nextOwnerEpoch;
      lease.previews.clear();
      return asJsonValue({ schemaVersion: 1, terminalId, owner: "agent", ownerEpoch: nextOwnerEpoch } satisfies MobileBridgeTerminalReleaseDto, "terminal.release");
    } catch (error) {
      this.onError(errorOf(error));
      throw errorOf(error);
    }
  }

  private async terminalDispatch(
    params: Record<string, unknown>,
    context: MobileBridgeConnectionContext,
    request: MobileBridgeRpcRequest,
  ): Promise<MobileBridgeJsonValue> {
    const terminalId = requiredIdentifier(params, "terminalId", RUN_ID_RE);
    const ownerEpoch = optionalInteger(params, "ownerEpoch", 1, Number.MAX_SAFE_INTEGER);
    const previewId = requiredIdentifier(params, "previewId", RUN_ID_RE);
    const approvalId = optionalIdentifier(params, "approvalId", 160);
    if (ownerEpoch === undefined) throw new TypeError("ownerEpoch is required");
    const control = this.options.terminalControl;
    if (!control) return asJsonValue(terminalWriteRefusal(request, terminalId,
      "terminal_unavailable",
      "This Desktop has no authoritative mobile terminal controller.",
    ), "terminal.dispatch");
    const lease = this.terminalLease(terminalId);
    if (lease.owner !== "mobile" || lease.ownerDeviceId !== context.deviceId) {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_owner_conflict",
        "Take over the terminal before sending a command.",
      ), "terminal.dispatch");
    }
    if (lease.ownerEpoch !== ownerEpoch) {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_epoch_conflict",
        "The terminal changed before this command was sent.",
      ), "terminal.dispatch");
    }
    const preview = lease.previews.get(previewId);
    if (!preview || preview.terminalId !== terminalId) {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_preview_required",
        "Preview this command again before sending it.",
      ), "terminal.dispatch");
    }
    if (preview.ownerEpoch !== lease.ownerEpoch) {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_epoch_conflict",
        "The command was previewed before the current takeover epoch.",
      ), "terminal.dispatch");
    }
    if (preview.expiresAtMs <= Date.now()) {
      lease.previews.delete(previewId);
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_preview_expired",
        "The command preview expired. Preview it again.",
      ), "terminal.dispatch");
    }
    if (preview.risk === "dangerous") {
      if (!approvalId || !TERMINAL_APPROVAL_ID_RE.test(approvalId)) {
        return asJsonValue(terminalWriteRefusal(request, terminalId,
          "terminal_approval_required",
          "Dangerous terminal commands require a separate approval.",
        ), "terminal.dispatch");
      }
    }
    try {
      const result = await control.dispatch({ terminalId, ownerEpoch, previewId, ...(approvalId ? { approvalId } : {}) }, context);
      if (result.terminalId !== terminalId || !result.requestId) {
        throw new Error("Desktop terminal dispatch returned an invalid receipt");
      }
      return asJsonValue({ ...result, schemaVersion: 1, terminalId, ownerEpoch }, "terminal.dispatch");
    } catch (error) {
      this.onError(errorOf(error));
      throw errorOf(error);
    }
  }

  private async terminalCancel(
    params: Record<string, unknown>,
    context: MobileBridgeConnectionContext,
    request: MobileBridgeRpcRequest,
  ): Promise<MobileBridgeJsonValue> {
    const terminalId = requiredIdentifier(params, "terminalId", RUN_ID_RE);
    const ownerEpoch = optionalInteger(params, "ownerEpoch", 1, Number.MAX_SAFE_INTEGER);
    const requestId = requiredIdentifier(params, "requestId", RUN_ID_RE);
    if (ownerEpoch === undefined) throw new TypeError("ownerEpoch is required");
    const control = this.options.terminalControl;
    if (!control) return asJsonValue(terminalWriteRefusal(request, terminalId,
      "terminal_unavailable",
      "This Desktop has no authoritative mobile terminal controller.",
    ), "terminal.cancel");
    const lease = this.terminalLease(terminalId);
    if (lease.owner !== "mobile" || lease.ownerDeviceId !== context.deviceId) {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_owner_conflict",
        "Take over the terminal before cancelling a command.",
      ), "terminal.cancel");
    }
    if (lease.ownerEpoch !== ownerEpoch) {
      return asJsonValue(terminalWriteRefusal(request, terminalId,
        "terminal_epoch_conflict",
        "The terminal changed before this command was cancelled.",
      ), "terminal.cancel");
    }
    try {
      const result = await control.cancel({ terminalId, ownerEpoch, requestId }, context);
      if (result.terminalId !== terminalId || result.requestId !== requestId) {
        throw new Error("Desktop terminal cancel returned an invalid receipt");
      }
      return asJsonValue({ ...result, schemaVersion: 1, terminalId, requestId, ownerEpoch }, "terminal.cancel");
    } catch (error) {
      this.onError(errorOf(error));
      throw errorOf(error);
    }
  }

  /** DESKTOP_MOBILE_BRIDGE: Exact compile-time allowlist; there is no dynamic IPC passthrough. */
  async request(
    request: MobileBridgeRpcRequest,
    context: MobileBridgeConnectionContext,
  ): Promise<MobileBridgeJsonValue> {
    this.assertAvailable();
    if (
      request.v !== MOBILE_BRIDGE_PROTOCOL_VERSION ||
      request.type !== "request" ||
      !REQUEST_ID_RE.test(request.id)
    ) {
      throw new TypeError("Invalid Mobile Bridge authority request envelope");
    }

    switch (request.method) {
      case "snapshot.get": {
        noParams(request);
        return asJsonValue(await this.projectSnapshot(), request.method);
      }
      case "host.status": {
        noParams(request);
        return asJsonValue((await this.projectSnapshot()).host, request.method);
      }
      case "team.list": {
        noParams(request);
        return asJsonValue((await this.projectSnapshot()).agents, request.method);
      }
      case "one.org.get": {
        noParams(request);
        return asJsonValue(getOneOrgState(), request.method);
      }
      case "one.org.add": {
        const params = guardedParams(request, ["installedAgentId", "displayName"]);
        const installedAgentId = requiredIdentifier(params, "installedAgentId");
        const displayName = optionalIdentifier(params, "displayName", 80);
        return asJsonValue(await addOneOrgMember({ installedAgentId, ...(displayName ? { displayName } : {}) }), request.method);
      }
      case "one.org.openMember": {
        const params = guardedParams(request, ["id", "expectedRevision"]);
        const opened = openOneOrgMember({
          id: requiredIdentifier(params, "id"),
          expectedRevision: optionalInteger(params, "expectedRevision", 1, Number.MAX_SAFE_INTEGER) ?? undefined,
        });
        // Opening may create a dedicated member chat. Publish that projection
        // independently of the later read CAS so Mobile never lands on an
        // empty thread when markRead is delayed or refused.
        this.scheduleSnapshotUpdated(opened.chat.id);
        return asJsonValue({
          memberId: opened.memberId,
          memberRevision: opened.memberRevision,
          unreadGeneration: opened.unreadGeneration,
          chat: projectMobileBridgeChat(
            opened.chat,
            invocationService.activeChatIds().includes(opened.chat.id),
          ),
        }, request.method);
      }
      case "one.org.markRead": {
        const params = guardedParams(request, ["id", "expectedUnreadGeneration"]);
        const memberId = requiredIdentifier(params, "id");
        const state = markOneOrgMemberRead({
          id: memberId,
          expectedUnreadGeneration: optionalInteger(
            params,
            "expectedUnreadGeneration",
            0,
            Number.MAX_SAFE_INTEGER,
          ) ?? -1,
        });
        this.scheduleSnapshotUpdated(memberId);
        return asJsonValue({ memberId, org: state }, request.method);
      }
      case "firms.list": {
        noParams(request);
        return asJsonValue((await this.projectSnapshot()).firms, request.method);
      }
      case "projects.list": {
        noParams(request);
        return asJsonValue((await this.projectSnapshot()).projects, request.method);
      }
      case "projects.get": {
        const params = guardedParams(request, ["id"]);
        const project = getProject(requiredIdentifier(params, "id"));
        if (!project) throw new Error("The selected Desktop project is unavailable");
        return asJsonValue(
          projectMobileBridgeProject(project, { includeDetails: true }),
          request.method,
        );
      }
      // DESKTOP_MOBILE_BRIDGE: project staffing from a paired phone. Mobile may
      // add a locally installed agent, drop any member, and reorder the pool.
      // It may not mint a new Cloud/Hub binding and it may not rename an agent:
      // remote members must already be bound to this exact project, and every
      // nameSnapshot is resolved here from Desktop authority.
      case "projects.setAgentPool": {
        const params = guardedParams(request, ["projectId", "members", "expectedMemberKeys"]);
        const project = getProject(requiredIdentifier(params, "projectId"));
        if (!project) throw new Error("The selected Desktop project is unavailable");

        const observedKeys = params.expectedMemberKeys;
        if (!Array.isArray(observedKeys)) throw new TypeError("expectedMemberKeys must be an array");
        const currentKeys = project.agentPool.map(projectPoolMemberKey);
        if (
          observedKeys.length !== currentKeys.length ||
          currentKeys.some((key, index) => key !== observedKeys[index])
        ) {
          throw new Error("This project's team changed on Desktop. Reload the project and try again.");
        }

        const requested = params.members;
        if (!Array.isArray(requested)) throw new TypeError("members must be an array");
        if (requested.length > PROJECT_AGENT_POOL_MAX) {
          throw new Error(`A project stages at most ${PROJECT_AGENT_POOL_MAX} agents`);
        }

        const installedById = new Map(listInstalledAgents().map((agent) => [agent.id, agent] as const));
        const nextPool: ProjectAgentPoolMember[] = [];
        const nextKeys = new Set<string>();
        for (const entry of requested) {
          if (!isRecord(entry)) throw new TypeError("members contains an unsupported project agent");
          assertOnlyKeys(entry, ["entityKind", "targetId", "agentId", "firmId", "controllerAgentId", "source", "releaseId"], "members");
          const entityKind = optionalIdentifier(entry, "entityKind", 16) ?? "agent";
          if (entityKind !== "agent" && entityKind !== "team") {
            throw new TypeError("members contains an unsupported project tool kind");
          }
          const legacyAgentId = optionalIdentifier(entry, "agentId", 200) ?? null;
          const targetId = optionalIdentifier(entry, "targetId", 200) ?? legacyAgentId;
          if (!targetId) throw new TypeError("members contains a project tool without targetId");
          const source = requiredIdentifier(entry, "source");
          if (source !== "local" && source !== "cloud" && source !== "hub") {
            throw new TypeError("members contains an unsupported project agent source");
          }
          const releaseId = optionalIdentifier(entry, "releaseId", 200) ?? null;
          let member: ProjectAgentPoolMember;
          if (source === "local") {
            if (entityKind === "team") {
              const firmId = optionalIdentifier(entry, "firmId", 200) ?? targetId;
              const firm = getFirm(firmId);
              if (!firm) throw new Error("That team is not installed on this Desktop");
              const controller = installedById.get(firm.ceoAgentId);
              if (!controller) throw new Error("That team has no installed execution entrypoint");
              if (releaseId !== null) throw new TypeError("A local project team has no releaseId");
              member = {
                entityKind: "team",
                targetId: firm.id,
                agentId: null,
                firmId: firm.id,
                controllerAgentId: controller.id,
                source,
                releaseId: null,
                nameSnapshot: firm.name,
              };
            } else {
              const agentId = legacyAgentId ?? targetId;
              const installed = installedById.get(agentId);
              if (!installed) throw new Error("That agent is not installed on this Desktop");
              if (!isUserFacingProjectAgent(installed)) {
                throw new Error("That agent is an internal team role and cannot staff a project");
              }
              if (releaseId !== null) throw new TypeError("A local project agent has no releaseId");
              member = {
                entityKind: "agent",
                targetId: agentId,
                agentId,
                firmId: null,
                controllerAgentId: null,
                source,
                releaseId: null,
                nameSnapshot: installed.name,
              };
            }
          } else {
            // A phone can keep or drop an existing Cloud/Hub member. Creating one
            // needs the borrow/lease authority Mobile deliberately does not have.
            const bound = project.agentPool.find((candidate) => candidate.source === source
              && candidate.entityKind === entityKind
              && candidate.targetId === targetId
              && candidate.releaseId === releaseId);
            if (!bound) {
              throw new Error("Add Cloud or Hub agents to this project from Desktop");
            }
            member = bound;
          }
          const key = projectPoolMemberKey(member);
          if (nextKeys.has(key)) throw new Error("That agent is already on this project");
          nextKeys.add(key);
          nextPool.push(member);
        }

        const updated = updateProject(project.id, { agentPool: nextPool });
        this.scheduleSnapshotUpdated();
        return asJsonValue(
          projectMobileBridgeProject(updated, { includeDetails: true }),
          request.method,
        );
      }

      // DESKTOP_MOBILE_BRIDGE: Chat CRUD calls the real store, then the shared
      // projector removes local-only fields before returning the DTO.
      case "chats.listRecent": {
        const params = guardedParams(request, ["limit"]);
        const limit = optionalInteger(params, "limit", 1, 100) ?? 50;
        const active = new Set(invocationService.activeChatIds());
        return asJsonValue(
          listRecentChats(limit).map((chat) => projectMobileBridgeChat(chat, active.has(chat.id))),
          request.method,
        );
      }
      case "chats.get": {
        const params = guardedParams(request, ["id"]);
        const chat = requireChat(requiredIdentifier(params, "id"));
        return asJsonValue(
          projectMobileBridgeChat(chat, invocationService.activeChatIds().includes(chat.id)),
          request.method,
        );
      }
      case "tasks.createProject": {
        const params = guardedParams(request, ["projectId", "title"]);
        const projectId = requiredIdentifier(params, "projectId");
        const title = optionalIdentifier(params, "title", 200) ?? "New task";
        const project = getProject(projectId);
        if (!project) throw new Error("The selected Desktop project is unavailable");
        if (!project.folderPath) throw new Error("The selected project has no connected working folder");
        const canonicalProjectFolder = captureInvocationWorkspaceBinding(project.folderPath).canonicalPath;
        if (!canonicalProjectFolder) throw new Error("The selected project has no connected working folder");
        const chat = createChat({
          projectId: project.id,
          title,
          taskMode: "task",
          originSurface: "work",
        });
        try {
          setChatWorkingFolder(chat.id, canonicalProjectFolder);
          const task = getCanonicalTaskForChat(chat.id);
          if (!task) throw new Error("The project task could not be prepared");
          this.scheduleSnapshotUpdated(chat.id);
          return asJsonValue({
            projectId: project.id,
            taskId: task.id,
            chatId: chat.id,
            title: task.title,
            controllerAgentId: chat.agentId,
            // Creation is already durable. Return the exact projected chat in
            // the same receipt so Mobile can open and recover the empty task
            // even when the following optional runtime-pin action is rejected.
            chat: projectMobileBridgeChat(chat, false),
          }, request.method);
        } catch (error) {
          removeChat(chat.id);
          throw error;
        }
      }
      case "chats.rename": {
        const params = guardedParams(request, ["id", "title"]);
        const id = requiredIdentifier(params, "id");
        requireChat(id);
        const chat = renameChat(id, requiredBoundedString(params, "title", 200));
        this.scheduleSnapshotUpdated();
        return asJsonValue(
          projectMobileBridgeChat(chat, invocationService.activeChatIds().includes(chat.id)),
          request.method,
        );
      }
      case "chats.archive": {
        const params = guardedParams(request, ["id"]);
        const id = requiredIdentifier(params, "id");
        requireChat(id);
        const chat = archiveChat(id);
        this.scheduleSnapshotUpdated();
        return asJsonValue(
          projectMobileBridgeChat(chat, invocationService.activeChatIds().includes(chat.id)),
          request.method,
        );
      }
      case "chats.unarchive": {
        const params = guardedParams(request, ["id"]);
        const id = requiredIdentifier(params, "id");
        requireChat(id);
        const chat = unarchiveChat(id);
        this.scheduleSnapshotUpdated();
        return asJsonValue(
          projectMobileBridgeChat(chat, invocationService.activeChatIds().includes(chat.id)),
          request.method,
        );
      }
      case "chats.setContinuousMode": {
        const params = guardedParams(request, ["id", "enabled"]);
        const id = requiredIdentifier(params, "id");
        requireChat(id);
        const enabled = requiredBoolean(params, "enabled");
        setChatContinuousMode(id, enabled);
        if (enabled) setChatSwarmMode(id, false);
        const chat = requireChat(id);
        this.scheduleSnapshotUpdated(id);
        return asJsonValue(
          projectMobileBridgeChat(chat, invocationService.activeChatIds().includes(chat.id)),
          request.method,
        );
      }
      case "chats.setSwarmMode": {
        const params = guardedParams(request, ["id", "enabled"]);
        const id = requiredIdentifier(params, "id");
        requireChat(id);
        const enabled = requiredBoolean(params, "enabled");
        setChatSwarmMode(id, enabled);
        if (enabled) setChatContinuousMode(id, false);
        const chat = requireChat(id);
        this.scheduleSnapshotUpdated(id);
        return asJsonValue(
          projectMobileBridgeChat(chat, invocationService.activeChatIds().includes(chat.id)),
          request.method,
        );
      }
      case "chats.setRuntimeSelection": {
        const params = guardedParams(request, ["id", "selection"]);
        const id = requiredIdentifier(params, "id");
        requireChat(id);
        const rawSelection = params.selection;
        const runtimeSelection = rawSelection === null
          ? null
          : await resolveMobileRoleSelection(
              mobileRuntimeSelectionFromValue(rawSelection, "orchestrator"),
            );
        const chat = setChatRuntimeSelection(id, runtimeSelection);
        this.scheduleSnapshotUpdated(id);
        return asJsonValue(
          projectMobileBridgeChat(chat, invocationService.activeChatIds().includes(chat.id)),
          request.method,
        );
      }
      case "chats.clearContext": {
        const params = guardedParams(request, ["id"]);
        const id = requiredIdentifier(params, "id");
        requireChat(id);
        if (invocationService.activeChatIds().includes(id)) {
          throw new Error("This conversation is still running. Stop it before clearing it.");
        }
        clearChatContext(id);
        const chat = requireChat(id);
        this.scheduleSnapshotUpdated(id);
        return asJsonValue(
          projectMobileBridgeChat(chat, false),
          request.method,
        );
      }
      case "tasks.acceptResult": {
        const params = guardedParams(request, ["taskId", "expectedVersion", "expectedRunId"]);
        const taskId = requiredIdentifier(params, "taskId");
        const expectedVersion = optionalInteger(params, "expectedVersion", 1, Number.MAX_SAFE_INTEGER);
        if (expectedVersion === undefined) throw new TypeError("expectedVersion is required");
        const expectedRunId = requiredIdentifier(params, "expectedRunId", RUN_ID_RE);
        const current = getCanonicalTask(taskId);
        const receipt = current?.originChatId
          ? invocationService.latestReceipt(current.originChatId)
          : null;
        const accepted = acceptCanonicalTaskResult(
          { taskId, expectedVersion, expectedRunId },
          receipt,
        );
        // Async pre-pass: warm the completion-claim judgments the synchronous
        // Value Closure trust validator peeks. A miss remains unverified and
        // cannot be promoted by a regex or static verdict.
        await prejudgeCompletionClaims(ACCEPTED_RESULT_CLOSURE_FACT_STATEMENTS, { timeoutMs: 6_000 }).catch(() => undefined);
        const closure = ensureAcceptedResultValueClosure({
          priorTaskVersion: expectedVersion,
          acceptedTask: accepted,
          expectedRunId,
          receipt,
          confirmedByUser: true,
        });
        try {
          ensureVerifiedAcceptedResultValueClosure({
            priorTaskVersion: expectedVersion,
            acceptedTask: accepted,
            expectedRunId,
            receipt,
            confirmedByUser: true,
          });
        } catch {
          // Mobile uses the same Main-only fail-closed artifact verifier as
          // Desktop. A missing or stale binding leaves acceptance partial.
        }
        try {
          sealOneMemoryCandidateProvenance({
            sourceTaskId: accepted.id,
            sourceTaskVersion: accepted.version,
            sourceRunId: expectedRunId,
            sourceValueClosureId: closure.value.closure.valueClosureId,
            sourceValueClosureVersion: closure.value.version,
          });
        } catch {
          // Mobile acceptance remains authoritative when optional Memory
          // provenance sealing races or finds no pending review candidate.
        }
        tryProduceAcceptedResultSuggestion({
          hostId: this.options.hostIdentity.hostId,
          taskId: accepted.id,
          expectedTaskVersion: accepted.version,
          expectedTaskUpdatedAt: accepted.updatedAt,
          expectedRunId,
          valueClosureId: closure.value.closure.valueClosureId,
          expectedValueClosureVersion: closure.value.version,
          confirmedByUser: true,
        });
        try {
          tryCompleteOneActivationFirstValue({
            taskId: accepted.id,
            expectedTaskVersion: accepted.version,
            valueClosureId: closure.value.closure.valueClosureId,
            expectedValueClosureVersion: closure.value.version,
          });
        } catch {
          // Mobile acceptance remains authoritative even if optional Desktop
          // first-use activation evidence cannot be advanced.
        }
        try {
          ensureOneExperienceReuseReceipt({
            taskId: accepted.id,
            expectedTaskVersion: accepted.version,
            expectedTaskUpdatedAt: accepted.updatedAt,
            expectedRunId,
            valueClosureId: closure.value.closure.valueClosureId,
            expectedValueClosureVersion: closure.value.version,
            confirmedByUser: true,
          });
        } catch {
          // The accepted Task and Value Closure remain authoritative even when
          // optional compounding evidence cannot be recorded.
        }
        try {
          tryProduceOneImprovementProofForTask(accepted.id);
        } catch {
          // Improvement Proof is derived from separately verified comparable
          // runs. Missing proof data must never roll back Mobile acceptance.
        }
        if (accepted.originChatId) this.scheduleSnapshotUpdated(accepted.originChatId);
        return asJsonValue({
          taskId: accepted.id,
          taskVersion: accepted.version,
          taskStatus: accepted.status,
          taskUpdatedAt: accepted.updatedAt,
        }, request.method);
      }
      case "tasks.latestResult": {
        const params = guardedParams(request, ["taskId", "chatId", "expectedVersion"]);
        const taskId = requiredIdentifier(params, "taskId");
        const chatId = requiredIdentifier(params, "chatId");
        const expectedVersion = optionalInteger(
          params,
          "expectedVersion",
          1,
          Number.MAX_SAFE_INTEGER,
        );
        if (expectedVersion === undefined) throw new TypeError("expectedVersion is required");

        const task = getCanonicalTask(taskId);
        if (
          !task ||
          task.originChatId !== chatId ||
          task.version !== expectedVersion ||
          (task.status !== "partial" && task.status !== "completed")
        ) {
          return null;
        }
        const receipt = invocationService.latestReceipt(chatId);
        if (
          !receipt ||
          receipt.chatId !== chatId ||
          receipt.status !== "completed" ||
          !hasPassedTaskForceExecutionVerification(receipt.runId)
        ) {
          return null;
        }
        const surface = invocationService.latestOneSurface({
          runId: receipt.runId,
          chatId,
          taskId,
        })?.manifest ?? null;
        return asJsonValue(
          {
            taskId,
            taskVersion: task.version,
            taskStatus: task.status,
            taskUpdatedAt: task.updatedAt,
            chatId,
            runId: receipt.runId,
            receipt: {
              status: "completed",
              startedAt: receipt.startedAt,
              updatedAt: receipt.updatedAt,
              finishedAt: receipt.finishedAt ?? receipt.updatedAt,
              eventCount: receipt.eventCount,
            },
            surface,
          },
          request.method,
        );
      }
      case "terminal.read":
        return this.terminalRead(guardedParams(request, ["terminalId", "sinceSeq", "limit"]), context);
      case "terminal.preview":
        return this.terminalPreview(guardedParams(request, ["terminalId", "command"]), context);
      case "terminal.takeover":
        return this.terminalTakeover(guardedParams(request, ["terminalId", "expectedOwnerEpoch"]), context, request);
      case "terminal.release":
        return this.terminalRelease(guardedParams(request, ["terminalId", "ownerEpoch"]), context, request);
      case "terminal.dispatch":
        return this.terminalDispatch(guardedParams(request, ["terminalId", "ownerEpoch", "previewId", "approvalId"]), context, request);
      case "terminal.cancel":
        return this.terminalCancel(guardedParams(request, ["terminalId", "ownerEpoch", "requestId"]), context, request);
      case "one.artifact.imagePreview": {
        const params = guardedParams(request, [
          "taskId", "taskVersion", "chatId", "runId", "manifestId", "artifactRef",
        ]);
        const taskVersion = optionalInteger(params, "taskVersion", 1, Number.MAX_SAFE_INTEGER);
        if (taskVersion === undefined) throw new TypeError("taskVersion is required");
        const preview = readOneArtifactImagePreview({
          taskId: requiredIdentifier(params, "taskId"),
          taskVersion,
          chatId: requiredIdentifier(params, "chatId"),
          runId: requiredIdentifier(params, "runId", RUN_ID_RE),
          manifestId: requiredIdentifier(params, "manifestId"),
          artifactRef: requiredIdentifier(params, "artifactRef"),
        });
        return preview ? asJsonValue(preview, request.method) : null;
      }
      case "one.artifacts.recent": {
        const params = guardedParams(request, ["chatId", "limit", "cursor"]);
        const chatId = requiredIdentifier(params, "chatId");
        requireChat(chatId);
        const limit = optionalInteger(params, "limit", 1, 100) ?? 100;
        const cursor = params.cursor === undefined
          ? undefined
          : requiredIdentifier(params, "cursor", MOBILE_ONE_ARTIFACT_CURSOR_RE);
        return asJsonValue(
          listRecentOneArtifactsForMobile({ chatId, limit, cursor }),
          request.method,
        );
      }
      case "chat.attachment.imagePreview": {
        const params = guardedParams(request, ["chatId", "messageId", "attachmentId"]);
        const attachment = readBoundChatMessageAttachment({
          chatId: requiredIdentifier(params, "chatId"),
          messageId: requiredIdentifier(params, "messageId"),
          attachmentId: requiredIdentifier(params, "attachmentId"),
        });
        return attachment
          ? asJsonValue({ mimeType: attachment.mediaType, base64: attachment.bytes.toString("base64") }, request.method)
          : null;
      }
      case "one.suggestions.act": {
        const params = guardedParams(request, [
          "schemaVersion", "action", "expectedStoreVersion", "suggestionId", "expectedSuggestionVersion",
          "originTaskId", "expectedTaskVersion", "valueClosureId", "expectedValueClosureVersion",
          "confirmedByUser", "reviewOnly",
        ]);
        const acknowledgement = performOneMobileSuggestionAction(
          params,
          this.options.hostIdentity.hostId,
        );
        const task = getCanonicalTask(acknowledgement.originTaskId);
        this.scheduleSnapshotUpdated(task?.originChatId ?? undefined);
        return asJsonValue(acknowledgement, request.method);
      }
      case "workspace.setProject": {
        const params = guardedParams(request, ["chatId", "projectId"]);
        const chatId = requiredIdentifier(params, "chatId");
        const projectId = requiredIdentifier(params, "projectId");
        const chat = requireChat(chatId);
        if (chat.projectId && chat.projectId !== projectId) {
          throw new Error("A project task cannot be moved to another project");
        }
        const project = getProject(projectId);
        if (!project) throw new Error("The selected Desktop project is unavailable");
        if (!project.folderPath) throw new Error("The selected project has no working folder");
        setChatWorkingFolder(chatId, project.folderPath);
        this.scheduleSnapshotUpdated(chatId);
        return asJsonValue({
          projectId: project.id,
          workingFolderName: boundedRedactedText(project.name, 512),
        }, request.method);
      }
      case "workspace.clear": {
        const params = guardedParams(request, ["chatId"]);
        const chatId = requiredIdentifier(params, "chatId");
        const chat = requireChat(chatId);
        if (chat.projectId) {
          throw new Error("A project task must remain connected to its project");
        }
        setChatWorkingFolder(chatId, null);
        this.scheduleSnapshotUpdated(chatId);
        return asJsonValue({ projectId: null, workingFolderName: null }, request.method);
      }
      case "composer.context": {
        const params = guardedParams(request, ["chatId"]);
        const chat = requireChat(requiredIdentifier(params, "chatId"));
        const agent = listInstalledAgents().find((item) => item.id === chat.agentId);
        return asJsonValue({
          commands: listRuntimeCommands().slice(0, 200).map((command) => ({
            name: boundedRedactedText(command.name, 256),
            description: boundedRedactedText(command.description, 1_000),
            source: command.source,
          })),
          plugins: (agent?.mcpServers ?? []).slice(0, 100).map((plugin) => boundedRedactedText(plugin, 256)),
        }, request.method);
      }
      case "plugins.list": {
        noParams(request);
        const catalogById = new Map(MCP_TOOL_CATALOG.map((item) => [item.id, item]));
        return asJsonValue(listInstalledServers().slice(0, 100).map((plugin) => {
          const catalog = plugin.catalogId ? catalogById.get(plugin.catalogId) : undefined;
          return {
            id: boundedRedactedText(plugin.id, 256),
            name: boundedRedactedText(plugin.name || plugin.nameEn, 256),
            nameEn: boundedRedactedText(plugin.nameEn || plugin.name, 256),
            description: boundedRedactedText(catalog?.description ?? "연결된 MCP 도구", 1_000),
            descriptionEn: boundedRedactedText(catalog?.descriptionEn ?? "Connected MCP tools", 1_000),
            enabled: plugin.enabled,
            ready: plugin.configurationValid !== false,
          };
        }), request.method);
      }

      // DESKTOP_MOBILE_BRIDGE: Invocation requests call only the shared
      // main-process InvocationService. Mobile never starts a parallel runtime.
      case "invoke.history": {
        const params = guardedParams(request, ["chatId", "limit"]);
        const chatId = requiredIdentifier(params, "chatId");
        const limit = optionalInteger(params, "limit", 1, 200) ?? 200;
        return projectInvocationHistory(invocationService.history(chatId), limit, chatId);
      }
      case "one.invoke.start": {
        assertMobileOneDeviceAuthority(context);
        const input = mobileOneStartParams(request);
        const runtimeSelection = input.runtimeSelection
          ? await resolveMobileRoleSelection(input.runtimeSelection)
          : undefined;
        // Main creates a Task-free One conversation and keeps its identity,
        // project/team selection, and durable One capabilities authoritative.
        // Permission is the normal Desktop execution choice and is forwarded
        // from the paired Mobile remote without creating a second mobile mode.
        const chat = createChat({
          title: mobileOneConversationTitle(input.userPrompt),
          taskMode: "conversation",
          originSurface: "one",
        });
        let result;
        try {
          if (runtimeSelection) setChatRuntimeSelection(chat.id, runtimeSelection);
          // Mobile's optimistic transcript is not durable Desktop history.
          // Persist the person's exact turn before execution so reconnect,
          // restart recovery, and One memory all retain the same conversation.
          appendChatMessage(chat.id, "user", input.userPrompt);
          if (input.liveMode) setChatContinuousMode(chat.id, true);
          const invocation = await bindMobileOneTurn({
              chatId: chat.id,
              userPrompt: input.userPrompt,
              taskIntent: "conversation",
              oneMode: true,
              permissions: input.permissions,
              ...(input.planMode ? { planMode: true } : {}),
              ...(input.goalMode ? { goalMode: true } : {}),
              // Network is an explicit structured override. The invocation
              // layer still lets One select the exact task force and keeps
              // every @ target turn-only.
              ...(input.networkMode ? { sessionRouting: true } : {}),
              ...(input.taskForceTargets ? { taskForceTargets: input.taskForceTargets } : {}),
              ...(input.images ? { images: input.images } : {}),
              ...(runtimeSelection ? { runtimeSelection } : {}),
            });
          result = invocationService.start(
            invocation,
            captureMobileOneInvocationBinding(),
            { source: "mobile" },
          );
        } catch (error) {
          // No accepted run exists, so do not leave a misleading empty One
          // conversation behind after a fail-closed admission rejection.
          removeChat(chat.id);
          throw error;
        }
        const receipt: MobileBridgeOneInvokeStartReceiptDto = {
          schemaVersion: 1,
          authoritativeHostRef: this.options.hostIdentity.hostId,
          chatId: chat.id,
          runId: result.runId,
        };
        this.scheduleSnapshotUpdated(chat.id);
        return asJsonValue(receipt, request.method);
      }
      case "invoke.start": {
        const { invocation, decisionAnswer } = invocationParams(request, false);
        if (decisionAnswer) await prejudgePendingDecisionAnswer(invocation.chatId, decisionAnswer.decisionId);
        if (decisionAnswer) validateCurrentMobileDecisionAnswer(invocation, decisionAnswer);
        // Warm the judgments the synchronous invocation start path peeks.
        await Promise.all([
          prejudgeOneRequestIntent(invocation, { timeoutMs: 4_000 }),
          prejudgeOneMemoryIntent(invocation, { timeoutMs: 4_000 }),
        ]).catch(() => undefined);
        const mobileOneTurn = isOneInvocationChat(invocation.chatId);
        const effectiveInvocation = mobileOneTurn
          ? await bindMobileOneTurn(invocation)
          : invocation;
        const workspaceBinding = mobileOneTurn
          ? captureMobileOneInvocationBinding()
          : captureInvocationWorkspaceBinding(getChatWorkingFolder(invocation.chatId));
        const rollbackQuestionClaim = decisionAnswer
          ? claimPendingConfirmationAnswer(invocation.chatId, decisionAnswer.decisionId)
          : null;
        let result;
        try {
          result = invocationService.start(effectiveInvocation, workspaceBinding, { source: "mobile" });
        } catch (error) {
          rollbackQuestionClaim?.();
          throw error;
        }
        // Admission succeeded and the claim is kept: seal the durable answer
        // receipt so the question stays resolved even if the run's own user
        // message persistence branch is skipped or the process dies mid-run.
        if (decisionAnswer) {
          recordCommittedAnswerReceipt(invocation.chatId, decisionAnswer.decisionId, invocation.userPrompt ?? "");
        }
        this.scheduleSnapshotUpdated();
        return asJsonValue(decisionAnswer
          ? { ...result, decisionAcknowledgement: mobileDecisionAnswerAcknowledgement(decisionAnswer) }
          : result, request.method);
      }
      case "invoke.steer": {
        const { invocation, expectedRunId, decisionAnswer } = invocationParams(request, true);
        if (decisionAnswer) await prejudgePendingDecisionAnswer(invocation.chatId, decisionAnswer.decisionId);
        if (decisionAnswer) validateCurrentMobileDecisionAnswer(invocation, decisionAnswer);
        const mobileOneTurn = isOneInvocationChat(invocation.chatId);
        const effectiveInvocation = mobileOneTurn
          ? await bindMobileOneTurn(invocation)
          : invocation;
        const workspaceBinding = mobileOneTurn
          ? captureMobileOneInvocationBinding()
          : captureInvocationWorkspaceBinding(getChatWorkingFolder(invocation.chatId));
        const rollbackQuestionClaim = decisionAnswer
          ? claimPendingConfirmationAnswer(invocation.chatId, decisionAnswer.decisionId)
          : null;
        let result;
        try {
          result = invocationService.steer(effectiveInvocation, expectedRunId, workspaceBinding, { source: "mobile" });
        } catch (error) {
          rollbackQuestionClaim?.();
          throw error;
        }
        if (decisionAnswer) {
          recordCommittedAnswerReceipt(invocation.chatId, decisionAnswer.decisionId, invocation.userPrompt ?? "");
        }
        this.scheduleSnapshotUpdated();
        return asJsonValue(decisionAnswer
          ? { ...result, decisionAcknowledgement: mobileDecisionAnswerAcknowledgement(decisionAnswer) }
          : result, request.method);
      }
      case "invoke.cancel": {
        const params = guardedParams(request, ["runId"]);
        const result = invocationService.cancel(requiredIdentifier(params, "runId", RUN_ID_RE));
        if (result === "not-found") throw new Error("Invocation run is no longer active");
        if (result === "requested") this.scheduleSnapshotUpdated();
        return result;
      }
      case "invoke.attach": {
        const params = guardedParams(request, ["chatId"]);
        const chatId = requiredIdentifier(params, "chatId");
        const attached = invocationService.attach(chatId);
        if (!attached) return null;
        const taskId = findCanonicalTaskForChat(chatId)?.id ?? null;
        const cwd = resolveChatCwd(chatId);
        return asJsonValue(
          {
            runId: attached.runId,
            events: attached.events.map((event) => projectMobileBridgeInvocationEvent(event, { taskId, chatId, runId: attached.runId, cwd })),
          },
          request.method,
        );
      }
      case "invoke.receipt": {
        const params = guardedParams(request, ["runId"]);
        return projectInvocationReceipt(
          invocationService.receipt(requiredIdentifier(params, "runId", RUN_ID_RE)),
        );
      }
      case "invoke.activeChats": {
        noParams(request);
        return asJsonValue(invocationService.activeChatIds(), request.method);
      }

      // DESKTOP_MOBILE_BRIDGE: Chat questions are a sanitized derived view.
      // Their answer returns through invoke.start/steer, never an approval resolver.
      case "confirm.listPending": {
        noParams(request);
        return asJsonValue(projectMobileBridgeConfirmations(), request.method);
      }

      // DESKTOP_MOBILE_BRIDGE: Resolve only the opaque live browser request.
      // browserResolveApproval itself emits pending/resolved/expired lifecycle events.
      case "browser.resolveApproval": {
        const params = guardedParams(request, ["requestId", "decision"]);
        const requestId = requiredIdentifier(params, "requestId", RUN_ID_RE);
        const decision = requiredEnum(
          params,
          "decision",
          ["once", "always", "deny"] as const,
        ) as BrowserPermissionDecision;
        const result = browserResolveApproval(requestId, decision);
        if (!result.ok) throw new Error("Browser approval is no longer pending");
        this.scheduleSnapshotUpdated();
        return asJsonValue(result, request.method);
      }

      /*
       * 런타임 도구 승인 — 데스크탑 승인 칩과 **같은 결정**을 폰이 답한다.
       * 결정은 tool-approval 의 단일 등록소로 가므로, allow_always 는 여기서도
       * 능력 규칙을 영구 기록한다(데스크탑과 다른 경로를 만들지 않는다).
       */
      case "runtime.resolveToolApproval": {
        const params = guardedParams(request, ["id", "decision"]);
        const id = requiredIdentifier(params, "id", TOOL_APPROVAL_ID_RE);
        const decision = requiredEnum(
          params,
          "decision",
          ["allow_once", "allow_session", "allow_always", "deny"] as const,
        );
        const receipt = resolveToolApproval(id, decision);
        this.scheduleSnapshotUpdated();
        // live 요청이 아니면(이미 지나간 고지) 대기 중인 실행은 없다 — 그 사실을 그대로 돌려준다.
        return asJsonValue({
          resolved: receipt.ok
            && receipt.resolvedDecision === decision
            && (receipt.status === "resolved" || receipt.status === "replayed"),
          id,
          decision,
          receipt,
          idempotencyKey: request.idempotencyKey ?? null,
        }, request.method);
      }

      case "runtime.submitUserInput": {
        const params = guardedParams(request, ["requestId", "answer"]);
        const requestId = requiredIdentifier(params, "requestId", ASK_USER_REQUEST_ID_RE);
        let answer: string | null = null;
        if (params.answer !== null) {
          answer = requiredText(params, "answer", 4_000).trim();
          if (!answer) throw new TypeError("answer must be non-empty text or null");
        }
        const resolved = submitAskUserAnswer(requestId, answer);
        this.scheduleSnapshotUpdated();
        return asJsonValue({
          resolved,
          requestId,
          idempotencyKey: request.idempotencyKey ?? null,
        }, request.method);
      }

      // DESKTOP_MOBILE_BRIDGE: Automation reads/writes use the same SQLite store
      // and scheduler as IPC; prompt/graph/trigger secrets stay in the projector.
      case "automations.list": {
        noParams(request);
        return asJsonValue(listAutomations().map(projectMobileBridgeAutomation), request.method);
      }
      case "automations.get": {
        const params = guardedParams(request, ["id"]);
        const automation = getAutomation(requiredIdentifier(params, "id"));
        return automation ? asJsonValue(projectMobileBridgeAutomation(automation), request.method) : null;
      }
      case "automations.toggle": {
        const params = guardedParams(request, ["id", "enabled"]);
        const id = requiredIdentifier(params, "id");
        const automation = toggleAutomation(id, requiredBoolean(params, "enabled"));
        await this.resyncAutomationTriggers();
        this.scheduleSnapshotUpdated(id);
        return asJsonValue(projectMobileBridgeAutomation(automation), request.method);
      }
      case "automations.setRuntime": {
        // ★모바일에서 자동화 런타임을 바꾸는 액션은 지금까지 없었다 — 채팅
        // 런타임을 바꿔도 다음 무인 실행은 자동화의 별도 칸을 읽는다.
        // 채팅 런타임(setChatRuntimeSelection)과 자동화 런타임은 다른 칸이다.
        const params = guardedParams(request, ["id", "runtimeSelection"]);
        const id = requiredIdentifier(params, "id");
        if (!getAutomation(id)) throw new Error(`Automation not found: ${id}`);
        const rawSelection = params.runtimeSelection;
        // Resolve against the live Desktop catalog before persisting. This
        // keeps a phone pin exact and prevents a stale/unknown model from
        // becoming a durable automation contract. An explicit null clears the
        // pin and returns to the orchestrator role default.
        const selection = rawSelection === null
          ? null
          : await resolveMobileRoleSelection(
              mobileRuntimeSelectionFromValue(rawSelection, "orchestrator"),
            );
        // Automation rows use the historical execution contract (kind,
        // backend/source/model/longContext/effort). Role and inheritance are
        // conversation/worker-pool metadata, and are intentionally not stored
        // in this automation column; the mobile projection supplies the
        // orchestrator defaults when it reads the row back.
        const automationSelection = selection === null
          ? null
          : {
              kind: selection.kind,
              ...(selection.backend !== undefined ? { backend: selection.backend } : {}),
              ...(selection.source !== undefined ? { source: selection.source } : {}),
              ...(selection.model !== undefined ? { model: selection.model } : {}),
              longContext: selection.longContext === true,
              ...(selection.effort !== undefined ? { effort: selection.effort } : {}),
            };
        const { updateAutomation } = await import("../store/automations");
        const automation = updateAutomation(id, {
          runtimeSelection: automationSelection,
        });
        this.scheduleSnapshotUpdated(id);
        return asJsonValue(projectMobileBridgeAutomation(automation), request.method);
      }
      case "automations.runNow": {
        const params = guardedParams(request, ["id"]);
        const id = requiredIdentifier(params, "id");
        if (!getAutomation(id)) throw new Error(`Automation not found: ${id}`);
        const { enqueueAutomationRunNow } = await import("../automation-scheduler");
        const result = enqueueAutomationRunNow(id);
        this.scheduleSnapshotUpdated(id);
        return asJsonValue(result, request.method);
      }
      case "automations.listRuns": {
        const params = guardedParams(request, ["id", "limit"]);
        const id = requiredIdentifier(params, "id");
        const limit = optionalInteger(params, "limit", 1, 200) ?? 50;
        if (!getAutomation(id)) throw new Error(`Automation not found: ${id}`);
        return asJsonValue(
          listRunHistory(id, limit).map((run) => ({
            id: run.id,
            automationId: run.automationId,
            scheduledFor: run.scheduledFor,
            ranAt: run.ranAt,
            status: run.status,
            skippedCount: run.skippedCount,
            // Detailed scheduler errors can contain local paths. Desktop owns
            // the full run log; Mobile receives only a stable failure marker.
            error: run.error ? "automation_failed" : null,
            // "그래프가 끝까지 돌았는가"(status)와 "나온 결과가 쓸 만한가"(outcome)는
            // 다른 질문이다. outcome 을 빼고 보내면 폰은 실패한 실행 옆에 이유를
            // 하나도 못 보여준다 — 실측 스크린샷 5번이 그 상태였다.
            outcome: run.outcome ?? null,
            outcomeReason: run.outcomeReason
              ? sanitizeMobileBridgeText(run.outcomeReason, MOBILE_BRIDGE_DISPLAY_TEXT_BYTES)
              : null,
            acknowledgedAt: run.acknowledgedAt ?? null,
          })),
          request.method,
        );
      }

      // DESKTOP_MOBILE_BRIDGE: Usage and runtime values come from their real
      // Desktop producers, then drop source paths and credential detail.
      case "usage.snapshot": {
        const params = guardedParams(request, ["force"]);
        const force = optionalBoolean(params, "force") ?? false;
        return asJsonValue(
          projectMobileBridgeUsage(await getUsageSnapshot({ force })),
          request.method,
        );
      }
      case "runtime.detect": {
        noParams(request);
        return asJsonValue(projectMobileBridgeRuntimes(await detectRuntimes()), request.method);
      }
      case "runtime.setActive": {
        const params = guardedParams(request, [
          "kind",
          "backend",
          "model",
          "effort",
          "longContext",
          "role",
          "inherit",
        ]);
        const kind = requiredEnum(params, "kind", MOBILE_RUNTIME_KINDS) as RuntimeKind;
        const role =
          optionalEnum(params, "role", ["orchestrator", "worker"] as const) ??
          "orchestrator";
        const inherit = optionalBoolean(params, "inherit") ?? false;
        if (inherit && role !== "worker") {
          throw new Error("Only the worker runtime role can inherit");
        }
        const backend = optionalEnum(params, "backend", MOBILE_RUNTIME_BACKENDS) as RuntimeBackend | undefined;
        const candidates = await detectRuntimes();
        const runtime = candidates.find((candidate) =>
          candidate.kind === kind && (backend === undefined || candidate.backend === backend));
        if (!runtime) throw new Error("The selected Desktop runtime is unavailable");
        if (runtimeCredentialUnavailable(runtime)) {
          throw new Error("The selected Desktop runtime credential is unavailable");
        }
        const model = optionalIdentifier(params, "model", 200);
        if (
          model &&
          (runtime.availableModels?.length ?? 0) > 0 &&
          !runtime.availableModels!.includes(model)
        ) {
          throw new Error("The selected model is unavailable on this Desktop runtime");
        }
        const effort = optionalIdentifier(params, "effort", 80);
        if (effort && (runtime.efforts?.length ?? 0) > 0 && !runtime.efforts!.some((item) => item.id === effort)) {
          throw new Error("The selected effort is unavailable on this Desktop runtime");
        }
        const longContext = optionalBoolean(params, "longContext");
        const list = await setActiveRuntime({
          kind: runtime.kind,
          backend: runtime.backend,
          source: runtime.source,
          ...(model !== undefined ? { model } : runtime.model ? { model: runtime.model } : {}),
          ...(effort !== undefined ? { effort } : runtime.effort ? { effort: runtime.effort } : {}),
          ...(longContext !== undefined ? { longContext } : { longContext: runtime.longContextEnabled === true }),
          role,
          inherit,
        });
        this.scheduleSnapshotUpdated();
        return asJsonValue(projectMobileBridgeRuntimes(list), request.method);
      }
      case "runtime.listRoleMembers": {
        noParams(request);
        return asJsonValue(await mobileRuntimeRolePoolDto(), request.method);
      }
      case "runtime.setRoleMembers": {
        const params = guardedParams(request, ["role", "selections"]);
        const role = requiredEnum(params, "role", MOBILE_RUNTIME_ROLES) as RuntimeRole;
        if (!Array.isArray(params.selections) || params.selections.length > 32) {
          throw new TypeError("Runtime role pools accept at most 32 selections");
        }
        const selections = params.selections.map((value) => {
          const selection = mobileRuntimeSelectionFromValue(value, role);
          if (selection.inherit) {
            throw new TypeError("Worker inheritance is represented by an empty worker pool");
          }
          return selection;
        });
        const resolvedSelections = await Promise.all(
          selections.map((selection) => resolveMobileRoleSelection(selection)),
        );
        setModelRoleMembers(role, resolvedSelections);
        clearDetectCache();
        await detectRuntimes(true);
        this.scheduleSnapshotUpdated();
        return asJsonValue(await mobileRuntimeRolePoolDto(), request.method);
      }
      case "hub.borrowable.list": {
        noParams(request);
        return asJsonValue(projectBorrowableHubAgents(), request.method);
      }
      case "billing.credits": {
        noParams(request);
        return asJsonValue(await getMobileBridgeCredits(), request.method);
      }
      case "hephaestus.engineToggles": {
        noParams(request);
        return asJsonValue(getEngineToggles(), request.method);
      }
      case "hephaestus.routePreview": {
        const params = guardedParams(request, ["query", "scope", "allowLocal", "offline"]);
        const query = requiredText(params, "query", 20_000);
        const scope = optionalEnum(params, "scope", ["network", "cloud"] as const);
        try {
          const result = await routeOnly(query, {
            scope,
            allowLocal: optionalBoolean(params, "allowLocal") ?? true,
            noHub: optionalBoolean(params, "offline") ?? false,
            timeoutMs: 30_000,
          });
          // 활성 장기대여 slug 는 호출 0크레딧 — 모바일 고지액도 데스크탑과 같은 규칙.
          const leasedSlugs = await activeLeasedSlugs().catch(() => new Set<string>());
          return asJsonValue(projectRouteRecommendation(normalizeRecommendation(result.json, query, { leasedSlugs })), request.method);
        } catch {
          return asJsonValue(projectRouteRecommendation(normalizeRecommendation(null, query)), request.method);
        }
      }
      case "ontology.projections.list": {
        noParams(request);
        const projected = await this.projectOntology(true);
        if (!projected.supported) {
          throw new Error("Ontology projection is unavailable on the connected Hub.");
        }
        return asJsonValue(projected.projections, request.method);
      }
      case "ontology.attach.resolve": {
        if (!this.options.ontologyHubClient) {
          throw new Error("Ontology attachment is unavailable on the connected Hub.");
        }
        const input = parseOntologyAttachResolveInput(guardedParams(request, [
          "schemaVersion",
          "approvalId",
          "recommendationId",
          "agentDefinitionId",
          "agentReleaseId",
          "expectedProjectionRevision",
          "expectedLoadoutRevision",
          "decision",
          "selectedChips",
        ]));
        const idempotencyKey = request.idempotencyKey;
        if (!idempotencyKey) throw new TypeError("ontology.attach.resolve requires idempotencyKey");
        const receipt = await this.options.ontologyHubClient.resolveAttach(input, idempotencyKey);
        // The receipt is acknowledgement only. Mobile and Desktop do not
        // mutate a loadout optimistically; a forced authoritative projection
        // is emitted after this RPC returns.
        this.ontologyRefreshRequested = true;
        this.scheduleSnapshotUpdated();
        return asJsonValue(receipt, request.method);
      }
      // DESKTOP_MOBILE_BRIDGE: Agent Cloud passthrough. Uploads reuse the exact
      // registered-upload + packageAndReviewCloudAgent internals behind the
      // Desktop `cloudAgents:saveRegisteredPrivate` IPC (pinned private-link +
      // static-only); delete calls the authenticated cargo.* client.
      // Server refusals surface through `refusal` with an explicit actionState;
      // partially committed withdrawal must not be treated as a no-op. Local
      // installations are never modified by these methods.
      case "agents.cloudUploadPreview": {
        const params = guardedParams(request, ["agentLocalId"]);
        const agentLocalId = requiredIdentifier(params, "agentLocalId");
        const option = this.registeredUploadOptionForAgent(agentLocalId);
        let estimatedFileCount: number | null = null;
        if (option.sourceReady) {
          try {
            estimatedFileCount = this.cloudAgentActions.estimateUploadFileCount(option.target);
          } catch {
            estimatedFileCount = null;
          }
        }
        const preview: MobileBridgeCloudUploadPreviewDto = {
          agentLocalId,
          name: boundedRedactedText(option.name, 512),
          slug: boundedRedactedText(option.slug, 512),
          entityKind: option.entityKind,
          sourceReady: option.sourceReady,
          estimatedFileCount,
          visibility: "private-link",
        };
        return asJsonValue(preview, request.method);
      }
      case "agents.cloudUploadSave": {
        // `confirmOverwrite` answers the one question Desktop asks when the
        // Cloud already holds this name and this machine has no record of
        // uploading it from this folder. Without it the phone could receive
        // that question and have no way to answer — see MobileBridgeUploadOptions.
        const params = guardedParams(request, ["agentLocalId", "idempotencyKey", "confirmOverwrite"]);
        const agentLocalId = requiredIdentifier(params, "agentLocalId");
        const confirmOverwrite = optionalBoolean(params, "confirmOverwrite") === true;
        this.consumeWriteIdempotencyKey(request, params);
        const option = this.registeredUploadOptionForAgent(agentLocalId);
        const sessionRefusal = this.cloudSessionRefusal();
        if (sessionRefusal) return asJsonValue({ refusal: sessionRefusal }, request.method);
        // ★ A REFUSAL MUST NOT LEAVE HERE AS AN EXCEPTION. Measured 2026-08-17.
        //
        //   Registration throws on a server refusal, and nothing caught it, so
        //   the server's every "no" arrived at the phone as the bridge's fixed
        //   "Desktop rejected the request". That generic string is correct
        //   redaction for an unexpected crash and completely wrong for a
        //   decision: a full seat plan and a forked package each have one thing
        //   for the person to do, and neither of them was ever said.
        //
        //   Only typed refusals are converted — `cloudRefusalOf` returns null
        //   for anything else, and that still rethrows into the generic path,
        //   so an unexpected error cannot smuggle a local path out through this
        //   branch. Same shape the delete case below already used.
        let result: Awaited<ReturnType<typeof this.cloudAgentActions.saveRegisteredPrivate>>;
        try {
          result = await this.cloudAgentActions.saveRegisteredPrivate(
            option.target,
            confirmOverwrite ? { confirmOverwrite: true } : undefined,
          );
        } catch (error) {
          const refusal = this.cloudRefusalOf(error);
          if (refusal) return asJsonValue({ refusal }, request.method);
          throw error;
        }
        if (result.status !== "registered" || !result.registration) {
          // The local security review blocked the package or the registration
          // did not commit. Never report success; surface the bounded summary.
          return asJsonValue({
            refusal: {
              code: result.status === "blocked" ? "package_blocked" : "not_registered",
              message: boundedRedactedText(result.summary, 1_000),
            },
          }, request.method);
        }
        this.scheduleSnapshotUpdated();
        const localSyncStored = result.registration.localSyncStored === true;
        const upload: MobileBridgeCloudUploadSaveDto = {
          slug: result.registration.slug,
          visibility: "private-link",
          status: localSyncStored ? "registered" : "registered-recovery-required",
          localSyncStored,
          recoveryRequired: !localSyncStored,
          ...(!localSyncStored
            ? {
                recovery: {
                  code: "local_revision_receipt_not_saved" as const,
                  message:
                    "Agent Cloud committed the package, but Desktop could not save its local revision receipt. Restore the latest Cloud copy before the next edit or save.",
                },
              }
            : {}),
        };
        return asJsonValue(upload, request.method);
      }
      // DESKTOP_MOBILE_BRIDGE: explicit public Hub publish of one of the
      // user's OWN registered agents/teams. Reuses the exact renderer
      // `cloudAgents:publishRegisteredPublic` pipeline (marketplace +
      // static-only local review). Refusal conversion mirrors cloudUploadSave:
      // typed server refusals — fork copies cannot publish, seat plans,
      // slug_identity_conflict, … — return their sentence verbatim; anything
      // else stays a generic authority error so no local path can leak.
      case "agents.cloudPublishHub": {
        const params = guardedParams(request, ["agentLocalId", "idempotencyKey", "confirmOverwrite"]);
        const agentLocalId = requiredIdentifier(params, "agentLocalId");
        const confirmOverwrite = optionalBoolean(params, "confirmOverwrite") === true;
        this.consumeWriteIdempotencyKey(request, params);
        const option = this.registeredUploadOptionForAgent(agentLocalId);
        const sessionRefusal = this.cloudSessionRefusal();
        if (sessionRefusal) return asJsonValue({ refusal: sessionRefusal }, request.method);
        let result: Awaited<ReturnType<typeof this.cloudAgentActions.publishRegisteredHub>>;
        try {
          result = await this.cloudAgentActions.publishRegisteredHub(
            option.target,
            confirmOverwrite ? { confirmOverwrite: true } : undefined,
          );
        } catch (error) {
          const refusal = this.cloudRefusalOf(error);
          if (refusal) return asJsonValue({ refusal }, request.method);
          throw error;
        }
        if (result.status !== "registered" || !result.registration) {
          // Local security review blocked the package or registration did not
          // commit. Never report success; surface the bounded summary.
          return asJsonValue({
            refusal: {
              code: result.status === "blocked" ? "package_blocked" : "not_registered",
              message: boundedRedactedText(result.summary, 1_000),
            },
          }, request.method);
        }
        this.scheduleSnapshotUpdated();
        const hubSyncStored = result.registration.localSyncStored === true;
        const published: MobileBridgeHubPublishDto = {
          slug: result.registration.slug,
          visibility: "marketplace",
          status: hubSyncStored ? "registered" : "registered-recovery-required",
          releaseVersion: boundedRedactedText(result.registration.revision, 96),
          packageHash: boundedRedactedText(result.registration.packageHash, 128),
          ...(typeof result.registration.marketplaceUrl === "string"
            ? { marketplaceUrl: boundedRedactedText(result.registration.marketplaceUrl, 512) }
            : {}),
          localSyncStored: hubSyncStored,
          recoveryRequired: !hubSyncStored,
          ...(!hubSyncStored
            ? {
                recovery: {
                  code: "local_revision_receipt_not_saved" as const,
                  message:
                    "The Hub registration committed, but Desktop could not save its local revision receipt. Restore the latest Cloud copy before the next edit or save.",
                },
              }
            : {}),
        };
        return asJsonValue(published, request.method);
      }
      // Pricing is deliberately a separate call from publishing: by the time it
      // runs the agent is already live on the Hub, so a pricing failure leaves
      // a live free listing rather than a failed publish. Server bounds and
      // rejections come back inside `refusal` with the server's own numbers.
      case "cloud.setHubPrices": {
        const params = guardedParams(request, ["slug", "prices", "idempotencyKey"]);
        const slug = requiredIdentifier(params, "slug", RUN_ID_RE);
        this.consumeWriteIdempotencyKey(request, params);
        const sessionRefusal = this.cloudSessionRefusal();
        if (sessionRefusal) return asJsonValue({ refusal: sessionRefusal }, request.method);
        const pricesInput = params.prices;
        if (!pricesInput || typeof pricesInput !== "object" || Array.isArray(pricesInput)) {
          throw new TypeError("cloud.setHubPrices requires a prices object");
        }
        const patch: Partial<Record<(typeof MOBILE_BRIDGE_HUB_PRICE_KINDS)[number], number | null>> = {};
        for (const kind of MOBILE_BRIDGE_HUB_PRICE_KINDS) {
          if (!(kind in pricesInput)) continue;
          const value = (pricesInput as Record<string, unknown>)[kind];
          if (value === null) {
            patch[kind] = null;
          } else if (Number.isInteger(value)) {
            patch[kind] = value as number;
          } else {
            throw new TypeError(`cloud.setHubPrices ${kind} must be null or an integer`);
          }
        }
        const result = await this.cloudAgentActions.setHubPrices({ slug, patch });
        if (!result.ok) {
          const refusal: MobileBridgeHubPriceRefusalDto = {
            code: boundedRedactedText(result.code, 160),
            message: boundedRedactedText(result.message, 1_000),
            ...(typeof result.kind === "string" ? { kind: boundedRedactedText(result.kind, 16) } : {}),
            ...(typeof result.minCredits === "number" ? { minCredits: result.minCredits } : {}),
            ...(typeof result.maxCredits === "number" ? { maxCredits: result.maxCredits } : {}),
          };
          return asJsonValue({ refusal }, request.method);
        }
        const prices: MobileBridgeHubPricesDto["prices"] = {};
        for (const kind of MOBILE_BRIDGE_HUB_PRICE_KINDS) {
          const value = result.prices[kind];
          if (typeof value === "number" && Number.isFinite(value)) prices[kind] = value;
        }
        const priced: MobileBridgeHubPricesDto = {
          ok: true,
          changed: result.changed === true,
          prices,
        };
        return asJsonValue(priced, request.method);
      }
      case "agents.cloudDelete": {
        const params = guardedParams(request, ["slug", "idempotencyKey"]);
        const slug = requiredIdentifier(params, "slug", RUN_ID_RE);
        this.consumeWriteIdempotencyKey(request, params);
        const sessionRefusal = this.cloudSessionRefusal();
        if (sessionRefusal) return asJsonValue({ refusal: sessionRefusal }, request.method);
        try {
          // Server-side delete only. The local installation, if any, stays.
          const result = await this.cloudAgentActions.deleteMyAgent(slug);
          const deleted: MobileBridgeCloudDeleteResultDto = {
            schema: result.schema,
            deleted: true,
            slug: boundedRedactedText(result.slug, 160),
            scope: result.scope,
            ...(result.operation ? { operation: result.operation } : {}),
            deletionMode: result.deletionMode,
            deletedResource: result.deletedResource,
            packageBytesRetained: result.packageBytesRetained,
            ...(result.reconciled !== undefined ? { reconciled: result.reconciled } : {}),
            revision: boundedRedactedText(result.revision, 96),
            deletedAt: boundedRedactedText(result.deletedAt, 64),
          };
          return asJsonValue(deleted, request.method);
        } catch (error) {
          const refusal = this.cloudRefusalOf(error);
          if (refusal) return asJsonValue({ refusal }, request.method);
          throw error;
        }
      }


      // DESKTOP_MOBILE_BRIDGE: Remote Hephaestus build. After a per-run local
      // approval, `build.start` answers with { runId, replayable: false }; all
      // progress is pushed as ordered `build.event` frames and `build.status`
      // reads the bounded in-process registry. Workspace paths, runtime session
      // ids, and raw build results never cross the bridge.
      case "build.start": {
        const params = guardedParams(request, ["goal", "idempotencyKey"]);
        const goal = requiredText(params, "goal", 20_000);
        this.consumeWriteIdempotencyKey(request, params);
        const activeBuilds = [...this.buildRuns.values()].filter((run) => run.active).length;
        if (activeBuilds >= MAX_CONCURRENT_MOBILE_BUILDS) {
          throw new Error("A Mobile build is already running on this Desktop");
        }
        const runId = randomUUID();
        const controller = new AbortController();
        const locale: "ko" | "en" = HANGUL_RE.test(goal) ? "ko" : "en";
        this.buildRuns.set(runId, {
          status: "awaiting-approval",
          active: true,
          summary: null,
          questions: [],
          refusal: null,
          controller,
          startedAt: Date.now(),
          locale,
          workspace: null,
          runtimeSessionId: null,
          history: [],
          lastPrompt: goal,
          questionSetId: null,
          answerInFlight: false,
        });
        this.pruneBuildRuns();
        const approval = await this.awaitBuildApproval({ runId, goal, locale, controller });
        const reserved = this.buildRuns.get(runId);
        if (!approval.approved || !reserved || controller.signal.aborted || this.disposed) {
          this.buildRuns.delete(runId);
          const refusal = this.buildApprovalRefusal(
            approval.approved ? "desktop_approval_unavailable" : approval.code,
          );
          return asJsonValue({ refusal }, request.method);
        }
        reserved.status = "running";
        const completion = Promise.resolve().then(() => this.buildActions.run({
          runId,
          goal,
          locale,
          sink: (event) => this.handleBuildEvent(runId, event),
          signal: controller.signal,
        }));
        void completion.then(
          () => this.finalizeBuildRun(runId, null),
          (error) => this.finalizeBuildRun(runId, errorOf(error)),
        );
        return asJsonValue({ runId, replayable: false }, request.method);
      }
      case "build.answer": {
        const params = guardedParams(request, ["runId", "questionSetId", "answers", "idempotencyKey"]);
        this.consumeWriteIdempotencyKey(request, params);
        const runId = requiredIdentifier(params, "runId", RUN_ID_RE);
        const questionSetId = requiredIdentifier(params, "questionSetId", RUN_ID_RE);
        const run = this.buildRuns.get(runId);
        if (!run) {
          return asJsonValue({ refusal: this.buildAnswerRefusal("build_answer_stale") }, request.method);
        }
        if (run.answerInFlight || run.active) {
          return asJsonValue({ refusal: this.buildAnswerRefusal("build_answer_in_progress") }, request.method);
        }
        if (
          run.status !== "awaiting-input" ||
          !run.questionSetId ||
          run.questionSetId !== questionSetId ||
          !run.workspace
        ) {
          return asJsonValue({ refusal: this.buildAnswerRefusal("build_answer_stale") }, request.method);
        }
        const answers = params.answers as Array<{ questionId: string; values: string[] }>;
        const answerError = this.validateBuildAnswers(run.questions, answers);
        if (answerError) {
          return asJsonValue({ refusal: this.buildAnswerRefusal("build_answer_invalid", answerError) }, request.method);
        }
        const answerText = this.buildAnswerPrompt(run.questions, answers);
        run.answerInFlight = true;
        run.active = true;
        run.status = "running";
        run.questions = [];
        run.questionSetId = null;
        run.refusal = null;
        run.summary = run.locale === "ko" ? "인터뷰 답변을 반영해 빌드를 재개했습니다." : "Build resumed with the interview answers.";
        run.lastPrompt = answerText;
        this.emitBuildEvent({
          runId,
          kind: "stage",
          status: "running",
          stage: "interview-resume",
          text: run.summary,
        });
        const completion = Promise.resolve().then(() => this.buildActions.run({
          runId,
          goal: answerText,
          locale: run.locale,
          workspace: run.workspace ?? undefined,
          runtimeSessionId: run.runtimeSessionId ?? undefined,
          history: run.history.slice(-BUILD_HISTORY_MAX_ENTRIES),
          sink: (event) => this.handleBuildEvent(runId, event),
          signal: run.controller.signal,
        }));
        void completion
          .then(
            () => this.finalizeBuildRun(runId, null),
            (error) => this.finalizeBuildRun(runId, errorOf(error)),
          )
          .finally(() => {
            const current = this.buildRuns.get(runId);
            if (current) current.answerInFlight = false;
          });
        return asJsonValue({ status: "running", summary: run.summary }, request.method);
      }
      case "build.status": {
        const params = guardedParams(request, ["runId"]);
        const runId = requiredIdentifier(params, "runId", RUN_ID_RE);
        const run = this.buildRuns.get(runId);
        if (!run) throw new Error("Build run not found");
        if (run.status === "awaiting-approval") {
          throw new Error("Build approval is still pending on Desktop");
        }
        return asJsonValue({
          status: run.status,
          summary: run.summary,
          ...(run.questionSetId ? { questionSetId: run.questionSetId } : {}),
          ...(run.questions.length > 0 ? { questions: run.questions } : {}),
          ...(run.refusal ? { refusal: run.refusal, resumable: false as const } : {}),
          ...(run.status === "awaiting-input" && !run.refusal ? { resumable: true as const } : {}),
        }, request.method);
      }

      case "device.revokeSelf": {
        noParams(request);
        if (context.devBootstrap || context.devicePlatform === "dev") {
          throw new Error("Development bootstrap credentials cannot revoke a paired device");
        }
        if (!this.options.revokeDevice) throw new Error("Device revocation authority is unavailable");
        // Desired-state idempotency: another authenticated socket for the same
        // device may have won the race, but the credential is revoked either way.
        this.options.revokeDevice(context.deviceId, "device_requested");
        return { revoked: true };
      }
      default: {
        const unsupported: never = request.method;
        throw new TypeError(`Unsupported Mobile Bridge method: ${String(unsupported)}`);
      }
    }
  }

  /** DESKTOP_MOBILE_BRIDGE: Live events originate only from Desktop services. */
  subscribe(listener: AuthorityListener): () => void {
    this.assertAvailable();
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.attachDesktopSubscriptions();
      if (this.refreshRequested) this.scheduleSnapshotUpdated();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.detachDesktopSubscriptions();
    };
  }

  /** DESKTOP_MOBILE_BRIDGE: Release upstream listeners before the server or app exits. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const run of this.buildRuns.values()) {
      if (!run.active) continue;
      try {
        run.controller.abort();
      } catch (error) {
        this.onError(errorOf(error));
      }
    }
    this.buildRuns.clear();
    this.detachDesktopSubscriptions();
    this.listeners.clear();
    this.terminalLeases.clear();
    this.pendingAutomationIds.clear();
    this.refreshRequested = false;
    this.refreshQueued = false;
  }

  /**
   * The durable replay ledger keys on the envelope idempotencyKey. The wire
   * contract also carries the key inside params, so require both to be present
   * and identical — a retry with a fresh envelope key must not silently bypass
   * write-ahead replay protection.
   */
  private consumeWriteIdempotencyKey(
    request: MobileBridgeRpcRequest,
    params: Record<string, unknown>,
  ): string {
    const key = requiredBoundedString(params, "idempotencyKey", 160);
    if (request.idempotencyKey !== key) {
      throw new TypeError(
        `${request.method} requires the envelope idempotencyKey to equal params.idempotencyKey`,
      );
    }
    return key;
  }

  private registeredUploadOptionForAgent(agentLocalId: string): CloudAgentRegisteredUploadOption {
    const option = this.cloudAgentActions
      .listRegisteredUploadOptions()
      .find((item) => (
        ("agentId" in item.target && item.target.agentId === agentLocalId) ||
        ("firmId" in item.target && item.target.firmId === agentLocalId)
      ));
    if (!option) {
      throw new Error("The selected local agent is unavailable for Agent Cloud upload");
    }
    return option;
  }

  /** Fail closed before any doomed server call when Desktop has no cloud session. */
  private cloudSessionRefusal(): MobileBridgeCloudRefusalDto | null {
    if (this.cloudAgentActions.hasCloudSession()) return null;
    return {
      code: "not_signed_in",
      message: "Sign in to agentlas.cloud on this Desktop first.",
    };
  }

  /** Exact server refusal codes (owner_only, agent_not_found, …) pass through verbatim. */
  private cloudRefusalOf(error: unknown): MobileBridgeCloudRefusalDto | null {
    if (!(error instanceof OwnerCloudActionError)) return null;
    return {
      code: boundedRedactedText(error.code, 160),
      message: boundedRedactedText(error.detail ?? error.code, 1_000),
      ...(typeof error.refusal.retryable === "boolean"
        ? { retryable: error.refusal.retryable }
        : {}),
      ...(error.refusal.expectedRevision !== undefined
        ? { expectedRevision: error.refusal.expectedRevision }
        : {}),
      ...(error.refusal.currentRevision !== undefined
        ? { currentRevision: error.refusal.currentRevision }
        : {}),
      ...(typeof error.refusal.packageBytesRetained === "boolean"
        ? { packageBytesRetained: error.refusal.packageBytesRetained }
        : {}),
      ...(error.refusal.actionState ? { actionState: error.refusal.actionState } : {}),
    };
  }

  private buildApprovalRefusal(
    code: Extract<
      MobileBridgeBuildRefusalDto["code"],
      "desktop_approval_denied" | "desktop_approval_unavailable" | "desktop_approval_timed_out"
    >,
  ): MobileBridgeBuildRefusalDto {
    const messages: Record<typeof code, string> = {
      desktop_approval_denied: "The user denied this full-access Mobile build on Desktop.",
      desktop_approval_unavailable:
        "Desktop could not present a local approval dialog. No builder was started.",
      desktop_approval_timed_out:
        "Desktop approval timed out. No builder was started; submit a new request to try again.",
    };
    return { code, message: messages[code], retryable: code !== "desktop_approval_denied" };
  }

  private buildAnswerRefusal(
    code: Extract<
      MobileBridgeBuildRefusalDto["code"],
      "build_answer_stale" | "build_answer_invalid" | "build_answer_in_progress"
    >,
    detail?: string,
  ): MobileBridgeBuildRefusalDto {
    const messages: Record<typeof code, string> = {
      build_answer_stale: "This interview question set is no longer active. Refresh the build status and use the latest questions.",
      build_answer_invalid: detail ?? "The submitted interview answers do not match the active question options.",
      build_answer_in_progress: "The previous build turn is still settling or another answer is already being applied.",
    };
    return { code, message: messages[code], retryable: code !== "build_answer_invalid" };
  }

  private validateBuildAnswers(
    questions: MobileBridgeBuildQuestionDto[],
    answers: Array<{ questionId: string; values: string[] }>,
  ): string | null {
    if (answers.length !== questions.length) return "Answer every active interview question exactly once.";
    const byId = new Map(questions.map((question) => [question.questionId, question]));
    const seen = new Set<string>();
    for (const answer of answers) {
      const question = byId.get(answer.questionId);
      if (!question) return "An answer references an inactive question.";
      if (seen.has(answer.questionId)) return "A question was answered more than once.";
      seen.add(answer.questionId);
      if (!question.multiSelect && answer.values.length !== 1) {
        return "Single-select questions require exactly one option.";
      }
      if (answer.values.length > question.options.length) {
        return "Too many options were selected for a question.";
      }
      const allowed = new Set(question.options.map((option) => option.label));
      for (const value of answer.values) {
        if (!allowed.has(value)) return "An answer contains an option that was not offered.";
      }
    }
    return null;
  }

  private buildAnswerPrompt(
    questions: MobileBridgeBuildQuestionDto[],
    answers: Array<{ questionId: string; values: string[] }>,
  ): string {
    const byId = new Map(answers.map((answer) => [answer.questionId, answer.values]));
    return questions
      .map((question, index) => {
        const label = question.header || `Question ${index + 1}`;
        const values = byId.get(question.questionId) ?? [];
        return `${label}: ${values.join(", ")}`;
      })
      .join("\n");
  }

  private async awaitBuildApproval(input: {
    runId: string;
    goal: string;
    locale: "ko" | "en";
    controller: AbortController;
  }): Promise<MobileBridgeBuildApprovalDecision | {
    approved: false;
    code: "desktop_approval_timed_out";
  }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (
        decision: MobileBridgeBuildApprovalDecision | {
          approved: false;
          code: "desktop_approval_timed_out";
        },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.controller.signal.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = (): void => finish({ approved: false, code: "desktop_approval_unavailable" });
      const timer = setTimeout(
        () => finish({ approved: false, code: "desktop_approval_timed_out" }),
        BUILD_APPROVAL_TIMEOUT_MS,
      );
      timer.unref?.();
      input.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (input.controller.signal.aborted) {
        onAbort();
        return;
      }
      void Promise.resolve()
        .then(() => this.buildActions.requestLocalApproval({
          runId: input.runId,
          goal: input.goal,
          locale: input.locale,
        }))
        .then(finish, (error) => {
          this.onError(errorOf(error));
          finish({ approved: false, code: "desktop_approval_unavailable" });
        });
    });
  }

  private projectBuildQuestions(text: unknown, result: unknown): MobileBridgeBuildQuestionDto[] {
    const candidates: BuildInterviewQuestion[] = extractBuildInterviewQuestions(text);
    if (isRecord(result) && isRecord(result.supplementalQuestion)) {
      const supplemental = result.supplementalQuestion;
      const question = typeof supplemental.question === "string" ? supplemental.question.trim() : "";
      const options = Array.isArray(supplemental.options)
        ? supplemental.options.flatMap((option) => {
            if (!isRecord(option)) return [];
            const label = typeof option.label === "string" ? option.label.trim() : "";
            if (!label) return [];
            const description = typeof option.description === "string" ? option.description.trim() : "";
            return [{ label, ...(description ? { description } : {}) }];
          }).slice(0, 8)
        : [];
      if (question && options.length >= 2) {
        candidates.push({ question, options, multiSelect: false });
      }
    }
    const seen = new Set<string>();
    return candidates.flatMap((candidate) => {
      if (seen.size >= 7) return [];
      const question = boundedRedactedText(candidate.question, 4_000);
      if (!question || seen.has(question)) return [];
      const options = candidate.options.flatMap((option) => {
        const label = boundedRedactedText(option.label, 200);
        if (!label) return [];
        const description = option.description
          ? boundedRedactedText(option.description, 1_000)
          : "";
        return [{ label, ...(description ? { description } : {}) }];
      }).slice(0, 8);
      if (options.length < 2) return [];
      seen.add(question);
      const header = candidate.header ? boundedRedactedText(candidate.header, 200) : "";
      return [{
        questionId: "",
        question,
        ...(header ? { header } : {}),
        options,
        multiSelect: candidate.multiSelect,
      }];
    });
  }

  /** DESKTOP_MOBILE_BRIDGE: Builder events cross the bridge as sanitized display copy only. */
  private handleBuildEvent(runId: string, event: HephaestusBuildEvent): void {
    const run = this.buildRuns.get(runId);
    if (!run) return;
    // Heartbeats are Desktop-local liveness for one live status row; they carry
    // no build content. The v1 bridge DTO has no such kind and already exposes
    // `run.status`, so forwarding them would be a silent wire-contract change.
    if (event.kind === "heartbeat") return;
    let projectedKind: MobileBridgeBuildEventDto["kind"] = event.kind;
    let text = typeof event.text === "string"
      ? boundedRedactedText(stripMobileBridgeControlFences(event.text), BUILD_EVENT_TEXT_MAX_BYTES)
      : undefined;
    if (typeof event.sessionId === "string" && event.sessionId.trim()) {
      run.runtimeSessionId = event.sessionId.trim().slice(0, 512);
    }
    if (isRecord(event.result) && typeof event.result.workspace === "string" && event.result.workspace.trim()) {
      run.workspace = event.result.workspace.trim();
    }
    if (event.kind === "done") {
      if (isCompletedBuildTurn(event.text)) {
        run.status = "done";
        run.questions = [];
        run.questionSetId = null;
        run.refusal = null;
      } else {
        const questions = this.projectBuildQuestions(event.text, event.result);
        if (questions.length > 0) {
          const questionSetId = randomUUID();
          run.history = [
            ...run.history,
            { role: "user" as const, text: boundedRedactedText(run.lastPrompt, BUILD_HISTORY_ENTRY_MAX_BYTES) },
            { role: "assistant" as const, text: boundedRedactedText(stripMobileBridgeControlFences(event.text ?? ""), BUILD_HISTORY_ENTRY_MAX_BYTES) },
          ].slice(-BUILD_HISTORY_MAX_ENTRIES);
          run.status = "awaiting-input";
          run.questionSetId = questionSetId;
          run.questions = questions.map((question, index) => ({
            ...question,
            questionId: `${questionSetId}:${index + 1}`,
          }));
          run.refusal = null;
          projectedKind = "awaiting-input";
          text = text || "Build is awaiting interview input on Desktop.";
        } else {
          run.status = "failed";
          run.questions = [];
          run.questionSetId = null;
          run.refusal = {
            code: "build_completion_unproven",
            message: "The builder turn ended without a final BUILD_COMPLETE receipt.",
            retryable: true,
          };
          projectedKind = "error";
          text = text || run.refusal.message;
        }
      }
    } else if (event.kind === "error" && run.status !== "done") {
      run.status = "failed";
      run.questions = [];
      run.questionSetId = null;
    }
    if (text && (event.kind === "stage" || event.kind === "done" || event.kind === "error")) {
      run.summary = boundedRedactedText(text, BUILD_SUMMARY_MAX_BYTES);
    }
    // sessionId (provider session identity) and result (contains the local
    // workspace path and scan output) are intentionally never projected.
    this.emitBuildEvent({
      runId,
      kind: projectedKind,
      status: run.status === "awaiting-approval" ? "running" : run.status,
      ...(typeof event.stage === "string" ? { stage: boundedRedactedText(event.stage, 256) } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(run.questionSetId ? { questionSetId: run.questionSetId } : {}),
      ...(run.questions.length > 0 ? { questions: run.questions } : {}),
      ...(run.refusal ? { refusal: run.refusal, resumable: false as const } : {}),
      ...(run.status === "awaiting-input" && !run.refusal ? { resumable: true as const } : {}),
    });
  }

  private emitBuildEvent(payload: MobileBridgeBuildEventDto): void {
    this.emit({ event: "build.event", payload: asJsonValue(payload, "build.event") });
  }

  private finalizeBuildRun(runId: string, failure: Error | null): void {
    if (failure) this.onError(failure);
    const run = this.buildRuns.get(runId);
    if (!run) return;
    run.active = false;
    if (activeMobileBuildStatus(run.status)) {
      // The builder settled without a terminal done/error event (startup
      // failure, abort, or crash). Never leave the phone believing it runs.
      run.status = "failed";
      // Internal failure messages may carry local paths; keep a fixed marker.
      run.summary = run.summary ?? (failure ? "Build failed before completion." : "Build ended without completing.");
      this.emitBuildEvent({ runId, kind: "error", status: "failed", text: run.summary });
    }
    this.pruneBuildRuns();
  }

  private pruneBuildRuns(): void {
    if (this.buildRuns.size <= BUILD_RUN_HISTORY_LIMIT) return;
    const terminal = [...this.buildRuns.entries()]
      .filter(([, run]) => !run.active)
      .sort(([, a], [, b]) => a.startedAt - b.startedAt);
    for (const [id] of terminal) {
      if (this.buildRuns.size <= BUILD_RUN_HISTORY_LIMIT) break;
      this.buildRuns.delete(id);
    }
  }

  private async projectSnapshot(): Promise<MobileBridgeSnapshot> {
    const activeChatIds = invocationService.activeChatIds();
    const pendingBrowserApprovals = listPendingBrowserApprovals().map((approval) =>
      this.projectBrowserApproval(approval));
    // live 요청만 폰에 보낸다 — 사후 고지(post-denial)는 데스크탑에서도 카드가 아니다.
    const pendingToolApprovals = listPendingToolApprovals()
      .filter((approval) => approval.mode === "live")
      .map((approval) => {
        // `expiresAt` was added after the original tool-approval event. Read it
        // structurally so this bridge remains source-compatible with an older
        // runtime registry while newer Desktop builds forward the exact
        // deadline to Mobile.
        const expiresAt = (approval as { expiresAt?: unknown }).expiresAt;
        return {
          id: approval.id,
          runtime: approval.runtime,
          tool: approval.tool,
          ...(approval.detail ? { detail: approval.detail.slice(0, 2_000) } : {}),
          ...(approval.cwd ? { cwd: approval.cwd } : {}),
          mode: approval.mode,
          ...(approval.deniedBy ? { deniedBy: approval.deniedBy } : {}),
          requestedAt: approval.requestedAt,
          ...(typeof expiresAt === "string" && expiresAt ? { expiresAt } : {}),
          ...(approval.chatId ? { chatId: approval.chatId } : {}),
          ...(approval.capability ? { capability: approval.capability } : {}),
          ...(approval.agentId ? { agentId: approval.agentId } : {}),
        };
      });
    const pendingUserInputs: MobileBridgeUserInputDto[] = listPendingAskUserRequests()
      .flatMap((request) => {
        // Only a live One/Work chat-bound request is a Mobile surface. Generic
        // Desktop prompts stay local, and an expired row never becomes a card.
        if (!request.chatId || !getChat(request.chatId) || request.expiresAt <= Date.now()) return [];
        const question = boundedRedactedText(request.question, 1_200);
        if (!question) return [];
        const options = request.options.flatMap((option) => {
          const label = boundedRedactedText(option.label, 200);
          if (!label) return [];
          const description = option.description
            ? boundedRedactedText(option.description, 400)
            : "";
          return [{ label, ...(description ? { description } : {}) }];
        }).slice(0, 8);
        const askedBy = request.askedBy
          ? boundedRedactedText(request.askedBy, 200)
          : "";
        return [{
          requestId: request.requestId,
          question,
          options,
          allowFreeText: request.allowFreeText,
          ...(askedBy ? { askedBy } : {}),
          chatId: request.chatId,
          createdAt: new Date(request.createdAt).toISOString(),
          expiresAt: new Date(request.expiresAt).toISOString(),
        }];
      });
    const ontology = await this.projectOntology(this.ontologyRefreshRequested);
    return projectMobileBridgeSnapshot({
      hostIdentity: this.options.hostIdentity,
      displayName: this.options.displayName,
      appVersion: this.options.appVersion,
      activeChatIds,
      includeMessagesForChatIds: activeChatIds,
      pendingBrowserApprovals,
      pendingToolApprovals,
      pendingUserInputs,
      ontology,
    });
  }

  private async projectOntology(force = false): Promise<{
    supported: boolean;
    projections: import("../../shared/mobile-bridge").MobileBridgeOntologyProjectionDto[];
  }> {
    const client = this.options.ontologyHubClient;
    if (!client) return { supported: false, projections: [] };
    const exactBindings = listInstalledAgentHubBindings(64);
    const bindings = exactBindings.map((binding) => ({
      agentDefinitionId: binding.agentDefinitionId,
      agentReleaseId: binding.agentReleaseId,
    }));
    if (bindings.length === 0) return { supported: false, projections: [] };
    const result = await settleOptionalProjectionWithin(
      client.query(bindings, force),
      INITIAL_ONTOLOGY_BUDGET_MS,
      { supported: false, status: "endpoint-absent" as const, projections: [] },
    );
    if (this.options.terminalOntologyLoadoutFeedWriter) {
      try {
        this.options.terminalOntologyLoadoutFeedWriter.write({
          bindings: exactBindings,
          result,
        });
      } catch (error) {
        this.onError(errorOf(error));
      }
    }
    return { supported: result.supported, projections: result.projections };
  }

  private attachDesktopSubscriptions(): void {
    if (this.upstreamUnsubscribers.length > 0) return;
    this.upstreamUnsubscribers = [
      invocationService.onEvent(({ runId, chatId, event }) => {
        // Live events arrive per token; the folder and Task lookups are per
        // RUN, not per event. The cache is dropped when the run terminates.
        const { cwd, taskId } = cachedRunContext(runId, chatId);
        this.emit({
          event: "invoke.event",
          payload: asJsonValue(
            { runId, chatId, event: projectMobileBridgeInvocationEvent(event, { taskId, chatId, runId, cwd }) },
            "invoke.event envelope",
          ),
        });
        if (event.kind === "final" || event.kind === "error") {
          forgetRunContext(runId);
          this.scheduleSnapshotUpdated();
        }
      }),
      invocationService.onActiveChats((chatIds) => {
        this.emit({ event: "invoke.activeChats", payload: asJsonValue(chatIds, "invoke.activeChats") });
        this.scheduleSnapshotUpdated();
      }),
      onBrowserApprovalLifecycle((event) => this.forwardBrowserApproval(event)),
      onToolApprovalRequested(() => this.scheduleSnapshotUpdated()),
      onToolApprovalResolved(() => this.scheduleSnapshotUpdated()),
      onAskUserLifecycle((event) => {
        if (!event.chatId || !getChat(event.chatId)) return false;
        this.scheduleSnapshotUpdated();
        return true;
      }),
      onDesktopStoreChange((change) => {
        this.scheduleSnapshotUpdated(change.entity === "automation" ? change.id : undefined);
      }),
    ];
  }

  private detachDesktopSubscriptions(): void {
    const unsubscribers = this.upstreamUnsubscribers;
    this.upstreamUnsubscribers = [];
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        this.onError(errorOf(error));
      }
    }
  }

  /** DESKTOP_MOBILE_BRIDGE: approval identity is preserved; free-form copy is sanitized. */
  private forwardBrowserApproval(event: BrowserApprovalLifecycleEvent): void {
    const projected = event.status === "pending"
      ? this.projectBrowserApproval(event)
      : event;
    this.emit({ event: "browser.approval", payload: asJsonValue(projected, "browser.approval") });
    if (event.status !== "pending") this.scheduleSnapshotUpdated();
  }

  private projectBrowserApproval(
    approval: Extract<BrowserApprovalLifecycleEvent, { status: "pending" }> | ReturnType<typeof listPendingBrowserApprovals>[number],
  ): MobileBridgeBrowserApprovalDto {
    return {
      status: "pending",
      requestId: approval.requestId,
      site: boundedRedactedText(approval.site, 1_024),
      actionType: boundedRedactedText(approval.actionType, 512),
      summary: boundedRedactedText(approval.summary, 4_096),
      target: typeof approval.target === "string"
        ? boundedRedactedText(approval.target, 2_048)
        : null,
      allowAlways: approval.allowAlways,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    };
  }

  private emit(event: MobileBridgeAuthorityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A phone or server listener must never interrupt Desktop authority.
        this.onError(errorOf(error));
      }
    }
  }

  /** DESKTOP_MOBILE_BRIDGE: Coalesce mutation events into a fresh async projection. */
  private scheduleSnapshotUpdated(automationId?: string): void {
    if (this.disposed) return;
    if (automationId) this.pendingAutomationIds.add(automationId);
    this.refreshRequested = true;
    if (this.listeners.size === 0 || this.refreshQueued || this.refreshRunning) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      void this.flushSnapshotUpdates();
    });
  }

  private async flushSnapshotUpdates(): Promise<void> {
    if (this.disposed || this.refreshRunning || this.listeners.size === 0) return;
    this.refreshRunning = true;
    try {
      while (this.refreshRequested && this.listeners.size > 0) {
        this.refreshRequested = false;
        const automationIds = [...this.pendingAutomationIds];
        this.pendingAutomationIds.clear();
        const snapshot = await this.projectSnapshot();
        const ontologyRefreshRequested = this.ontologyRefreshRequested;
        this.ontologyRefreshRequested = false;
        const previousConfirmations = this.lastConfirmationFingerprint;
        const nextConfirmations = this.confirmationFingerprint(snapshot);
        this.lastConfirmationFingerprint = nextConfirmations;
        const previousOntology = this.lastOntologyFingerprint;
        const nextOntology = this.ontologyFingerprint(snapshot);
        this.lastOntologyFingerprint = nextOntology;

        this.emit({
          event: "snapshot.updated",
          payload: asJsonValue(snapshot, "snapshot.updated"),
        });
        if (ontologyRefreshRequested || previousOntology !== nextOntology) {
          this.emit({
            event: "ontology.updated",
            payload: asJsonValue(
              { projections: snapshot.ontologyChipProjections ?? [] },
              "ontology.updated",
            ),
          });
        }
        if (previousConfirmations !== null && previousConfirmations !== nextConfirmations) {
          this.emit({
            event: "confirm.updated",
            payload: asJsonValue(snapshot.pendingConfirmations, "confirm.updated"),
          });
        }
        for (const automationId of automationIds) {
          this.emit({
            event: "automation.updated",
            payload: asJsonValue(
              snapshot.automations.find((automation) => automation.id === automationId) ?? null,
              "automation.updated",
            ),
          });
        }
      }
    } catch (error) {
      this.onError(errorOf(error));
    } finally {
      this.refreshRunning = false;
      if (this.refreshRequested && this.listeners.size > 0) this.scheduleSnapshotUpdated();
    }
  }

  private confirmationFingerprint(snapshot: MobileBridgeSnapshot): string {
    return JSON.stringify(snapshot.pendingConfirmations);
  }

  private ontologyFingerprint(snapshot: MobileBridgeSnapshot): string | null {
    return snapshot.ontologyChipProjections === undefined
      ? null
      : JSON.stringify(snapshot.ontologyChipProjections.map((projection) => ({
          agentDefinitionId: projection.agentDefinitionId,
          agentReleaseId: projection.agentReleaseId,
          revision: projection.revision,
          state: projection.state,
          loadoutRevision: projection.loadout.revision,
        })));
  }

  private async resyncAutomationTriggers(): Promise<void> {
    try {
      const { syncTriggers } = await import("../triggers/manager");
      syncTriggers();
    } catch (error) {
      // Match Desktop IPC: the durable toggle succeeds even if the optional
      // in-process trigger manager is not running, but surface the diagnostic.
      this.onError(errorOf(error));
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("Mobile Bridge authority is disposed");
  }
}

/** DESKTOP_MOBILE_BRIDGE: main.ts may inject this authority into the server after its own gate. */
export function createMobileBridgeAuthority(
  options: AgentlasDesktopMobileBridgeAuthorityOptions,
): MobileBridgeAuthorityHandle {
  return new AgentlasDesktopMobileBridgeAuthority(options);
}
