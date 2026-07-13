import {
  browserResolveApproval,
  listPendingBrowserApprovals,
  onBrowserApprovalLifecycle,
  type BrowserApprovalLifecycleEvent,
  type BrowserPermissionDecision,
} from "../browser/connect";
import { onDesktopStoreChange } from "../store/change-bus";
import { invocationService } from "../invocation/service";
import {
  captureInvocationWorkspaceBinding,
  enforceMobileReadOnlyPermission,
} from "../invocation/workspace-binding";
import { claimPendingConfirmationAnswer } from "../confirm";
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
  renameChat,
  setChatContinuousMode,
  setChatHiredAgents,
  setChatSwarmMode,
  setChatWorkingFolder,
  switchChatAgent,
  unarchiveChat,
} from "../store/chats";
import { getProject } from "../store/projects";
import { getUsageSnapshot } from "../usage";
import { listInstalledAgentHubBindings } from "../ontology/hub-bindings";
import type { TerminalOntologyLoadoutFeedWriter } from "../ontology/terminal-loadout-feed";
import type {
  Chat,
  ImageAttachment,
  InvocationRunReceipt,
  McpInvocationEvent,
  McpInvocationRequest,
  Recommendation,
  RuntimeBackend,
  RuntimeKind,
} from "../../shared/types";
import {
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  isMobileBridgeJsonValue,
  type MobileBridgeInvocationEventDto,
  type MobileBridgeBrowserApprovalDto,
  type MobileBridgeInvokeSteerParams,
  type MobileBridgeJsonValue,
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
import { sanitizeMobileBridgeText } from "./sanitize";
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

function optionalBorrowAgents(params: Record<string, unknown>): string[] | undefined {
  const value = params.borrowAgents;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length < 1 ||
        item.length > 160 ||
        /[\u0000-\u001f]/.test(item),
    )
  ) {
    throw new TypeError("borrowAgents must contain at most 8 bounded identifiers");
  }
  return [...value] as string[];
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

function invocationParams(
  request: MobileBridgeRpcRequest,
  steering: false,
): { invocation: McpInvocationRequest; expectedQuestionMessageId?: string };
function invocationParams(
  request: MobileBridgeRpcRequest,
  steering: true,
): { invocation: McpInvocationRequest; expectedRunId: string; expectedQuestionMessageId?: string };
function invocationParams(
  request: MobileBridgeRpcRequest,
  steering: boolean,
): { invocation: McpInvocationRequest; expectedRunId?: string; expectedQuestionMessageId?: string } {
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
          "borrowAgents",
          "images",
          "expectedQuestionMessageId",
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
          "borrowAgents",
          "images",
          "expectedQuestionMessageId",
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
  const borrowAgents = optionalBorrowAgents(params);
  const images = optionalImages(params);
  const expectedQuestionMessageId = optionalIdentifier(params, "expectedQuestionMessageId");
  if (runId !== undefined) invocation.runId = runId;
  if (locale !== undefined) invocation.locale = locale;
  if (permissions !== undefined) invocation.permissions = permissions;
  if (planMode !== undefined) invocation.planMode = planMode;
  if (goalMode !== undefined) invocation.goalMode = goalMode;
  if (appsGenerateMode !== undefined) invocation.appsGenerateMode = appsGenerateMode;
  if (borrowAgents !== undefined) invocation.borrowAgents = borrowAgents;
  if (images !== undefined) invocation.images = images;
  const expectedRunId: MobileBridgeInvokeSteerParams["expectedRunId"] | undefined = steering
    ? requiredIdentifier(params, "expectedRunId", RUN_ID_RE)
    : undefined;
  return {
    invocation: enforceMobileInvocationPermissionBoundary(invocation),
    ...(expectedRunId !== undefined ? { expectedRunId } : {}),
    ...(expectedQuestionMessageId !== undefined ? { expectedQuestionMessageId } : {}),
  };
}

export function enforceMobileInvocationPermissionBoundary(
  invocation: McpInvocationRequest,
): McpInvocationRequest {
  return {
    ...invocation,
    permissions: enforceMobileReadOnlyPermission(invocation.permissions),
  };
}

function createChatParams(request: MobileBridgeRpcRequest): Parameters<typeof createChat>[0] {
  const params = guardedParams(request, [
    "agentId",
    "firmId",
    "agentGroupId",
    "projectId",
    "title",
    "continueFromChatId",
  ]);
  const agentId = optionalIdentifier(params, "agentId");
  const firmId = optionalIdentifier(params, "firmId");
  const agentGroupId = optionalIdentifier(params, "agentGroupId");
  if ([agentId, firmId, agentGroupId].filter(Boolean).length !== 1) {
    throw new TypeError("chats.create requires exactly one agentId, firmId, or agentGroupId");
  }
  const projectId = optionalIdentifier(params, "projectId");
  const title = optionalIdentifier(params, "title", 200);
  const continueFromChatId = optionalIdentifier(params, "continueFromChatId");
  return {
    ...(agentId !== undefined ? { agentId } : {}),
    ...(firmId !== undefined ? { firmId } : {}),
    ...(agentGroupId !== undefined ? { agentGroupId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(continueFromChatId !== undefined ? { continueFromChatId } : {}),
  };
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
      borrowAgents: receipt.borrowAgents ?? [],
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
): MobileBridgeInvocationEventDto {
  const projected: MobileBridgeInvocationEventDto = { kind: event.kind };
  if (typeof event.status === "string") {
    projected.status = boundedRedactedText(event.status, 1_000);
  }
  if (typeof event.text === "string") {
    const text = boundedRedactedText(event.text, EVENT_TEXT_MAX_BYTES);
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
  // DESKTOP_MOBILE_BRIDGE: surface manifest, surfaceId, provider/model/session
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
  }

  /** DESKTOP_MOBILE_BRIDGE: Initial state is always a fresh Desktop projection; no seed fallback. */
  async snapshot(_context: MobileBridgeConnectionContext): Promise<MobileBridgeSnapshot> {
    this.assertAvailable();
    const snapshot = await this.projectSnapshot();
    this.lastConfirmationFingerprint = this.confirmationFingerprint(snapshot);
    this.lastOntologyFingerprint = this.ontologyFingerprint(snapshot);
    return snapshot;
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
      case "agentGroups.listResolved": {
        noParams(request);
        return asJsonValue((await this.projectSnapshot()).groups, request.method);
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
      case "chats.create": {
        const chat = createChat(createChatParams(request));
        this.scheduleSnapshotUpdated();
        return asJsonValue(projectMobileBridgeChat(chat, false), request.method);
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
      case "chats.setBorrowedAgents": {
        const params = guardedParams(request, ["id", "slugs"]);
        const id = requiredIdentifier(params, "id");
        requireChat(id);
        if (!Array.isArray(params.slugs) || params.slugs.length > 8) {
          throw new TypeError("slugs must contain at most 8 identifiers");
        }
        const requestedSlugs = [...new Set(params.slugs.map((slug) => normalizedSlug(slug)).filter(Boolean))];
        const allowedBySlug = new Map(
          callableHubBookmarksForMobile().map((bookmark) => [
            normalizedSlug(bookmark.slug || bookmark.listing.slug),
            bookmark,
          ] as const),
        );
        const unknown = requestedSlugs.find((slug) => !allowedBySlug.has(slug));
        if (unknown) throw new Error(`Hub agent is not currently callable: ${unknown}`);
        const now = new Date().toISOString();
        const chat = setChatHiredAgents(id, requestedSlugs.map((slug) => {
          const bookmark = allowedBySlug.get(slug)!;
          return {
            slug,
            name: boundedRedactedText(bookmark.listing.name, 512),
            source: "hub" as const,
            hiredAt: now,
          };
        }));
        this.scheduleSnapshotUpdated(id);
        return asJsonValue(
          projectMobileBridgeChat(chat, invocationService.activeChatIds().includes(chat.id)),
          request.method,
        );
      }
      case "chats.switchAgent": {
        const params = guardedParams(request, ["id", "agentId"]);
        const id = requiredIdentifier(params, "id");
        const agentId = requiredIdentifier(params, "agentId");
        requireChat(id);
        const agent = listInstalledAgents().find((item) => item.id === agentId);
        if (!agent || (agent.visibility ?? "visible") !== "visible") {
          throw new Error("The selected agent is unavailable for direct chat");
        }
        const chat = switchChatAgent(id, agentId);
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
      case "workspace.setProject": {
        const params = guardedParams(request, ["chatId", "projectId"]);
        const chatId = requiredIdentifier(params, "chatId");
        const projectId = requiredIdentifier(params, "projectId");
        requireChat(chatId);
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
        requireChat(chatId);
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
      case "invoke.start": {
        const { invocation, expectedQuestionMessageId } = invocationParams(request, false);
        const workspaceBinding = captureInvocationWorkspaceBinding(
          getChatWorkingFolder(invocation.chatId),
        );
        const rollbackQuestionClaim = expectedQuestionMessageId
          ? claimPendingConfirmationAnswer(invocation.chatId, expectedQuestionMessageId)
          : null;
        let result;
        try {
          result = invocationService.start(invocation, workspaceBinding);
        } catch (error) {
          rollbackQuestionClaim?.();
          throw error;
        }
        this.scheduleSnapshotUpdated();
        return asJsonValue(result, request.method);
      }
      case "invoke.steer": {
        const { invocation, expectedRunId, expectedQuestionMessageId } = invocationParams(request, true);
        const workspaceBinding = captureInvocationWorkspaceBinding(
          getChatWorkingFolder(invocation.chatId),
        );
        const rollbackQuestionClaim = expectedQuestionMessageId
          ? claimPendingConfirmationAnswer(invocation.chatId, expectedQuestionMessageId)
          : null;
        let result;
        try {
          result = invocationService.steer(invocation, expectedRunId, workspaceBinding);
        } catch (error) {
          rollbackQuestionClaim?.();
          throw error;
        }
        this.scheduleSnapshotUpdated();
        return asJsonValue(result, request.method);
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
        const attached = invocationService.attach(requiredIdentifier(params, "chatId"));
        if (!attached) return null;
        return asJsonValue(
          {
            runId: attached.runId,
            events: attached.events.map((event) => projectMobileBridgeInvocationEvent(event)),
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
        const params = guardedParams(request, ["kind", "backend", "model", "effort", "longContext"]);
        const kind = requiredEnum(params, "kind", [
          "claude-code",
          "codex",
          "gemini",
          "grok",
          "cursor",
          "byok",
          "ollama",
        ] as const) as RuntimeKind;
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
    this.detachDesktopSubscriptions();
    this.listeners.clear();
    this.pendingAutomationIds.clear();
    this.refreshRequested = false;
    this.refreshQueued = false;
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
        this.emit({
          event: "invoke.event",
          payload: asJsonValue(
            { runId, chatId, event: projectMobileBridgeInvocationEvent(event) },
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
