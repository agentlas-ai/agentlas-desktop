import { randomUUID } from "node:crypto";
import { GLOBAL_ORCHESTRATOR_SLUG } from "../architecture/manifest";
import {
  extractBuildInterviewQuestions,
  isCompletedBuildTurn,
  type BuildInterviewQuestion,
} from "../../shared/build-turn";
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
import { detectRuntimes, setActiveRuntime } from "../runtime/detect";
import { listRuntimeCommands } from "../runtime/commands";
import { listInstalledAgents } from "../mcp/registry";
import { routeOnly } from "../hephaestus/commands";
import { normalizeRecommendation } from "../hephaestus/recommendation";
import { getEngineToggles } from "../hephaestus/supervisor";
import { listHubAgentBookmarks } from "../store/hub-bookmarks";
import {
  getAutomation,
  listAutomations,
  listRunHistory,
  toggleAutomation,
} from "../store/automations";
import {
  archiveChat,
  clearChatContext,
  createChat,
  getChat,
  getChatWorkingFolder,
  listRecentChats,
  removeChat,
  renameChat,
  setChatContinuousMode,
  setChatSwarmMode,
  setChatWorkingFolder,
  unarchiveChat,
} from "../store/chats";
import { getProject } from "../store/projects";
import { OwnerCloudActionError } from "../marketplace/mcp-source";
import {
  createDesktopMobileBridgeBuildActions,
  createDesktopMobileBridgeCloudAgentActions,
  type MobileBridgeBuildApprovalDecision,
  type MobileBridgeBuildActions,
  type MobileBridgeCloudAgentActions,
} from "./cloud-actions";
import { getUsageSnapshot } from "../usage";
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
  Recommendation,
  RuntimeBackend,
  RuntimeKind,
} from "../../shared/types";
import {
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  isMobileBridgeJsonValue,
  type MobileBridgeBuildEventDto,
  type MobileBridgeBuildQuestionDto,
  type MobileBridgeBuildRefusalDto,
  type MobileBridgeBuildStatus,
  type MobileBridgeCloudDeleteResultDto,
  type MobileBridgeCloudRefusalDto,
  type MobileBridgeCloudUploadSaveDto,
  type MobileBridgeCloudUploadPreviewDto,
  type MobileBridgeInvocationEventDto,
  type MobileBridgeBrowserApprovalDto,
  type MobileBridgeInvokeSteerParams,
  type MobileBridgeJsonValue,
  type MobileBridgeOneInvokeStartReceiptDto,
  type MobileBridgeRpcRequest,
  type MobileBridgeSnapshot,
  type MobileBridgeToolPayloadSize,
  type MobileBridgeToolPayloadSummaryDto,
} from "../../shared/mobile-bridge";
import type { MobileBridgeHostIdentity } from "./pairing";
import {
  projectMobileBridgeAutomation,
  projectMobileBridgeChat,
  projectMobileBridgeConfirmations,
  projectMobileBridgeHistory,
  projectMobileBridgeRuntimes,
  projectMobileBridgeSnapshot,
  projectMobileBridgeUsage,
} from "./projector";
import { sanitizeMobileBridgeText, stripMobileBridgeControlFences } from "./sanitize";
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
const EVENT_TEXT_MAX_BYTES = 200_000;
const EVENT_DELTA_MAX_BYTES = 64_000;
const TOOL_COUNT_CAP = 1_000;
const BUILD_EVENT_TEXT_MAX_BYTES = 16_000;
const BUILD_SUMMARY_MAX_BYTES = 2_000;
const BUILD_RUN_HISTORY_LIMIT = 64;
const BUILD_APPROVAL_TIMEOUT_MS = 90_000;
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
  revokeDevice?: (deviceId: string) => boolean;
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
}

export type MobileBridgeAuthorityHandle = MobileBridgeAuthority & { dispose(): void };

type AuthorityListener = (event: MobileBridgeAuthorityEvent) => void;

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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
  // synchronous validation; a cache miss keeps the deterministic fallback.
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
          "planMode",
          "goalMode",
          "appsGenerateMode",
          "stormbreakerMode",
          "taskForceTargets",
          "images",
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
          "appsGenerateMode",
          "stormbreakerMode",
          "taskForceTargets",
          "images",
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
  const planMode = optionalBoolean(params, "planMode");
  const goalMode = optionalBoolean(params, "goalMode");
  const appsGenerateMode = optionalBoolean(params, "appsGenerateMode");
  const stormbreakerMode = optionalBoolean(params, "stormbreakerMode");
  const taskForceTargets = optionalTurnAgentTargets(params);
  const images = optionalImages(params);
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
  if (planMode !== undefined) invocation.planMode = planMode;
  if (goalMode !== undefined) invocation.goalMode = goalMode;
  if (appsGenerateMode !== undefined) invocation.appsGenerateMode = appsGenerateMode;
  if (stormbreakerMode !== undefined) invocation.stormbreakerMode = stormbreakerMode;
  if (taskForceTargets !== undefined) invocation.taskForceTargets = taskForceTargets;
  if (images !== undefined) invocation.images = images;
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
  if (
    context.devBootstrap
    || context.devicePlatform === "dev"
    || !/^device_[a-f0-9]{32}$/.test(context.deviceId)
  ) {
    throw new Error(
      "Mobile One requires an iOS or Android pairing credential issued after account verification",
    );
  }
}

function mobileOneStartParams(request: MobileBridgeRpcRequest): {
  userPrompt: string;
  permissions: "read" | "write" | "full";
  images?: ImageAttachment[];
  taskForceTargets?: OrchestrationTarget[];
} {
  const params = guardedParams(request, ["schemaVersion", "userPrompt", "permissions", "taskForceTargets", "images"]);
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
  const images = optionalImages(params);
  const taskForceTargets = optionalTurnAgentTargets(params);
  return {
    userPrompt,
    permissions,
    ...(images !== undefined ? { images } : {}),
    ...(taskForceTargets !== undefined ? { taskForceTargets } : {}),
  };
}

function mobileOneConversationTitle(userPrompt: string): string {
  const firstLine = userPrompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return (firstLine || "One").slice(0, 200);
}

/** DESKTOP_MOBILE_BRIDGE: History strips in-memory data URLs; attachments never cross this v1 method. */
function projectInvocationHistory(
  history: ReturnType<typeof invocationService.history>,
  limit: number,
): MobileBridgeJsonValue {
  return asJsonValue(projectMobileBridgeHistory(history, limit), "invoke.history");
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
      errorCode: receipt.errorCode ?? null,
      errorMessage:
        typeof receipt.errorMessage === "string"
          ? boundedRedactedText(receipt.errorMessage, 4_000)
          : null,
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
  context?: { taskId?: string | null; syncedAt?: string },
): MobileBridgeInvocationEventDto {
  // "mcp-key-request" is a desktop-renderer-only elicitation signal — the
  // mobile client has no key sheet and its DTO union stays closed. Project it
  // as a harmless value-free "thinking" beat (keyRequest itself is never sent).
  const projected: MobileBridgeInvocationEventDto = {
    kind: event.kind === "mcp-key-request" ? "thinking" : event.kind,
  };
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
    };
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
  private readonly buildRuns = new Map<string, {
    status: InternalMobileBuildStatus;
    /** True until the builder promise settles, even after a terminal event. */
    active: boolean;
    summary: string | null;
    questions: MobileBridgeBuildQuestionDto[];
    refusal: MobileBridgeBuildRefusalDto | null;
    controller: AbortController;
    startedAt: number;
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
      case "firms.list": {
        noParams(request);
        return asJsonValue((await this.projectSnapshot()).firms, request.method);
      }
      case "projects.list": {
        noParams(request);
        return asJsonValue((await this.projectSnapshot()).projects, request.method);
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
        const controller = project.agentPool[0];
        if (!controller) throw new Error("Choose at least one project agent before starting work");
        if (controller.source !== "local") {
          throw new Error("The first project agent must be installed locally on this Desktop");
        }
        if (!listInstalledAgents().some((agent) => agent.id === controller.agentId)) {
          throw new Error("The project controller is unavailable; choose a new first project agent");
        }
        const canonicalProjectFolder = captureInvocationWorkspaceBinding(project.folderPath).canonicalPath;
        if (!canonicalProjectFolder) throw new Error("The selected project has no connected working folder");
        const chat = createChat({
          projectId: project.id,
          agentId: controller.agentId,
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
            controllerAgentId: controller.agentId,
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
        // Value Closure trust validator peeks. Miss = deterministic regex verdict.
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
        if (!receipt || receipt.chatId !== chatId || receipt.status !== "completed") {
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

      // DESKTOP_MOBILE_BRIDGE: Invocation requests call only the shared
      // main-process InvocationService. Mobile never starts a parallel runtime.
      case "invoke.history": {
        const params = guardedParams(request, ["chatId", "limit"]);
        const chatId = requiredIdentifier(params, "chatId");
        const limit = optionalInteger(params, "limit", 1, 200) ?? 200;
        return projectInvocationHistory(invocationService.history(chatId), limit);
      }
      case "one.invoke.start": {
        assertMobileOneDeviceAuthority(context);
        const input = mobileOneStartParams(request);
        const coordinator = listInstalledAgents().find(
          (agent) => agent.slug === GLOBAL_ORCHESTRATOR_SLUG,
        );
        if (!coordinator) {
          throw new Error("The canonical One coordinator is not installed on this Desktop");
        }

        // Main creates a Task-free One conversation and keeps its identity,
        // project/team selection, and durable One capabilities authoritative.
        // Permission is the normal Desktop execution choice and is forwarded
        // from the paired Mobile remote without creating a second mobile mode.
        const chat = createChat({
          agentId: coordinator.id,
          title: mobileOneConversationTitle(input.userPrompt),
          taskMode: "conversation",
        });
        let result;
        try {
          result = invocationService.start(
            {
              chatId: chat.id,
              userPrompt: input.userPrompt,
              taskIntent: "conversation",
              oneMode: true,
              permissions: input.permissions,
              ...(input.taskForceTargets ? { taskForceTargets: input.taskForceTargets } : {}),
              ...(input.images ? { images: input.images } : {}),
            },
            captureMobileOneInvocationBinding(),
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
        const workspaceBinding = captureInvocationWorkspaceBinding(
          getChatWorkingFolder(invocation.chatId),
        );
        const rollbackQuestionClaim = decisionAnswer
          ? claimPendingConfirmationAnswer(invocation.chatId, decisionAnswer.decisionId)
          : null;
        let result;
        try {
          result = invocationService.start(invocation, workspaceBinding);
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
        const workspaceBinding = captureInvocationWorkspaceBinding(
          getChatWorkingFolder(invocation.chatId),
        );
        const rollbackQuestionClaim = decisionAnswer
          ? claimPendingConfirmationAnswer(invocation.chatId, decisionAnswer.decisionId)
          : null;
        let result;
        try {
          result = invocationService.steer(invocation, expectedRunId, workspaceBinding);
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
        return asJsonValue(
          {
            runId: attached.runId,
            events: attached.events.map((event) => projectMobileBridgeInvocationEvent(event, { taskId })),
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
      case "automations.runNow": {
        const params = guardedParams(request, ["id"]);
        const id = requiredIdentifier(params, "id");
        if (!getAutomation(id)) throw new Error(`Automation not found: ${id}`);
        const { runAutomationNow } = await import("../automation-scheduler");
        const execution = runAutomationNow(id);
        void execution.then(
          () => this.scheduleSnapshotUpdated(id),
          (error) => {
            this.onError(errorOf(error));
            this.scheduleSnapshotUpdated(id);
          },
        );
        this.scheduleSnapshotUpdated(id);
        return asJsonValue({ accepted: true, automationId: id }, request.method);
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
        const kind = requiredEnum(params, "kind", [
          "claude-code",
          "codex",
          "gemini",
          "grok",
          "cursor",
          "byok",
          "ollama",
        ] as const) as RuntimeKind;
        const role =
          optionalEnum(params, "role", ["orchestrator", "worker"] as const) ??
          "orchestrator";
        const inherit = optionalBoolean(params, "inherit") ?? false;
        if (inherit && role !== "worker") {
          throw new Error("Only the worker runtime role can inherit");
        }
        const backend = optionalIdentifier(params, "backend", 80) as RuntimeBackend | undefined;
        const candidates = await detectRuntimes();
        const runtime = candidates.find((candidate) =>
          candidate.kind === kind && (backend === undefined || candidate.backend === backend));
        if (!runtime) throw new Error("The selected Desktop runtime is unavailable");
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
      case "hub.borrowable.list": {
        noParams(request);
        return asJsonValue(projectBorrowableHubAgents(), request.method);
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
          return asJsonValue(projectRouteRecommendation(normalizeRecommendation(result.json, query)), request.method);
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
        const params = guardedParams(request, ["agentLocalId", "idempotencyKey"]);
        const agentLocalId = requiredIdentifier(params, "agentLocalId");
        this.consumeWriteIdempotencyKey(request, params);
        const option = this.registeredUploadOptionForAgent(agentLocalId);
        const sessionRefusal = this.cloudSessionRefusal();
        if (sessionRefusal) return asJsonValue({ refusal: sessionRefusal }, request.method);
        const result = await this.cloudAgentActions.saveRegisteredPrivate(option.target);
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
        this.buildRuns.set(runId, {
          status: "awaiting-approval",
          active: true,
          summary: null,
          questions: [],
          refusal: null,
          controller,
          startedAt: Date.now(),
        });
        this.pruneBuildRuns();
        const locale: "ko" | "en" = HANGUL_RE.test(goal) ? "ko" : "en";
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
          ...(run.questions.length > 0 ? { questions: run.questions } : {}),
          ...(run.refusal ? { refusal: run.refusal, resumable: false as const } : {}),
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
        this.options.revokeDevice(context.deviceId);
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
    if (event.kind === "done") {
      if (isCompletedBuildTurn(event.text)) {
        run.status = "done";
        run.questions = [];
        run.refusal = null;
      } else {
        const questions = this.projectBuildQuestions(event.text, event.result);
        if (questions.length > 0) {
          run.status = "awaiting-input";
          run.questions = questions;
          run.refusal = {
            code: "mobile_build_resume_unsupported",
            message:
              "This Build requires interview answers. Mobile Bridge v1 cannot safely resume the full-access runtime session; continue from Desktop instead.",
            retryable: false,
          };
          projectedKind = "awaiting-input";
          text = text || "Build is awaiting interview input on Desktop.";
        } else {
          run.status = "failed";
          run.questions = [];
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
      ...(run.questions.length > 0 ? { questions: run.questions } : {}),
      ...(run.refusal ? { refusal: run.refusal, resumable: false as const } : {}),
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
    const ontology = await this.projectOntology(this.ontologyRefreshRequested);
    return projectMobileBridgeSnapshot({
      hostIdentity: this.options.hostIdentity,
      displayName: this.options.displayName,
      appVersion: this.options.appVersion,
      activeChatIds,
      includeMessagesForChatIds: activeChatIds,
      pendingBrowserApprovals,
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
    const result = await client.query(bindings, force);
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
        const taskId = findCanonicalTaskForChat(chatId)?.id ?? null;
        this.emit({
          event: "invoke.event",
          payload: asJsonValue(
            { runId, chatId, event: projectMobileBridgeInvocationEvent(event, { taskId }) },
            "invoke.event envelope",
          ),
        });
        if (event.kind === "final" || event.kind === "error") this.scheduleSnapshotUpdated();
      }),
      invocationService.onActiveChats((chatIds) => {
        this.emit({ event: "invoke.activeChats", payload: asJsonValue(chatIds, "invoke.activeChats") });
        this.scheduleSnapshotUpdated();
      }),
      onBrowserApprovalLifecycle((event) => this.forwardBrowserApproval(event)),
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
