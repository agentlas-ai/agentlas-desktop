import { createHash } from "node:crypto";
import { agentRunCwd } from "../runtime/exec";
import { resolveInvocationRunId } from "../runtime/run-id";
import {
  InvocationLifecycleRegistry,
  registerDurableInvocationStart,
} from "../runtime/invocation-lifecycle";
import { runMcpInvocation } from "../mcp/client";
import {
  invocationWorkspaceBindingsEqual,
  normalizeRemoteInvocationPermission,
  type InvocationWorkspaceBinding,
} from "./workspace-binding";
import { pickLocale } from "../runtime/status-i18n";
import { untrustedRuntimeFailurePayload } from "../runtime/untrusted-error";
import {
  getInvocationRunReceipt,
  getLatestInvocationRunReceipt,
  hasInvocationRunReceipt,
  recordMcpInvocationEvent,
  recordRunEvent,
  USER_STEERING_EVENT_KIND,
  tryRecordFailureEvent,
  tryRecordRunEvent,
} from "../store/run-events";
import { getProject } from "../store/projects";
import {
  appendChatMessage,
  getChat,
  getChatWorkingFolder,
  listChatMessages,
  repairRootChatSurfaceController,
} from "../store/chats";
import {
  ensureCanonicalTaskForChat,
  findCanonicalTaskForChat,
  setCanonicalTaskStatus,
} from "../store/tasks";
import {
  getDurableOneSurfaceResult,
  tryRecordDurableOneSurfaceResult,
} from "../store/one-surface-results";
import { getOneProfile } from "../store/one-profile";
import { tryRecordOneDomainEvent } from "../one/domain-events";
import {
  buildApprovedOneMemoryContext,
  claimPreparedOneMemoryUseOnce,
  getOneMemoryState,
  prepareOneMemoryUseOnceClaim,
  proposeUnverifiedOneMemoryCandidateFromRun,
  selectApprovedOneMemoryAssets,
} from "../one/memory-candidates";
import {
  claimPreparedOneBriefingAction,
  prepareOneBriefingActionClaim,
} from "../one/briefing-actions";
import {
  claimPreparedOneTeamPreflight,
  failOneTeamPreflightStart,
  prepareOneTeamPreflightClaim,
  type PreparedOneTeamPreflightClaim,
  type OneTeamRuntimeBinding,
} from "../one/team-preflight";
import { detectExplicitOneMemoryIntent } from "../one/memory-detector";
import { judgedOneRequestIntent } from "../one/judged-request-intent";
import { ONE_PERSONA_DIRECTIVE } from "../one/persona";
import {
  deriveOneTaskKindRef,
  snapshotOneParticipantExecution,
  type OneParticipantExecutionSnapshot,
  type OneParticipantVersionBinding,
} from "../one/task-kind";
import { listInstalledAgentsReadOnly } from "../mcp/registry";
import { bindOneSurfaceArtifacts } from "../one/artifact-preview";
import {
  tryProjectOneWorkspace,
  type OneWorkspaceRunPhase,
} from "../one/workspace-projection";
import {
  claimOneAttachments,
  redactOneAttachmentEvent,
  redactOneAttachmentText,
  releaseOneAttachmentRun,
  teamProposalRequiresOneAttachments,
} from "../one/attachments";
import { normalizeOneRecurrenceSelectionV1 } from "../../shared/one-recurrence";
import { classifyOneRequestIntent } from "../../shared/one-request-intent";
import {
  ONE_ATTACHMENT_LIMITS,
  type OneAttachmentSafeItem,
} from "../../shared/one-attachments";
import type {
  CanonicalTask,
  CanonicalTaskStatus,
  ImageAttachment,
  InstalledAgent,
} from "../../shared/types";
import { installMobileOneAutoRecovery } from "../one/mobile-auto-recovery";
import { adaptLegacySurfaceToOneV1 } from "../../shared/one-surface";
import { applyOneFriendlyFollowups } from "../../shared/one-friendly-followups";
import {
  buildApprovedOneProfileContext,
  selectApprovedOneOperatingPrinciples,
} from "../../shared/one-profile";
import type {
  InvocationRunReceipt,
  InvocationSteerResult,
  McpInvocationEvent,
  McpInvocationRequest,
} from "../../shared/types";

/** DESKTOP_MOBILE_BRIDGE: renderer IPC and Mobile Bridge share this authority. */
export interface InvocationEventEnvelope {
  runId: string;
  chatId: string;
  event: McpInvocationEvent;
}

export interface InvocationAttachResult {
  runId: string;
  events: McpInvocationEvent[];
  /** 실행 시작 시각(ISO) — 재접속한 렌더러가 상태줄 경과시간을 0s부터 다시 세지 않게 한다. */
  startedAt?: string;
}

export interface InvocationStartResult {
  runId: string;
}

export interface InvocationSettledEnvelope {
  runId: string;
  chatId: string;
  receipt: InvocationRunReceipt;
  oneMode: boolean;
  /** Main-memory-only original goal; never projected as a wire receipt. */
  goal: string;
  workspaceBinding?: InvocationWorkspaceBinding;
}

interface RunRecord {
  controller: AbortController;
  chatId: string;
  startedAt: string;
  cancelRequestedAt: string | null;
  events: McpInvocationEvent[];
  partialText: string;
  resultFolder?: string;
  actualAgentId?: string;
  workspaceBinding?: InvocationWorkspaceBinding;
  oneMode: boolean;
  goal: string;
  settlementPublished: boolean;
}

interface QueuedSteer {
  request: McpInvocationRequest;
  workspaceBinding?: InvocationWorkspaceBinding;
}

type OneInvocationRequest = McpInvocationRequest & {
  /** Renderer may request One semantics; Main derives the actual context. */
  oneMode?: boolean;
  /** Main-only. Renderer and Mobile input are always discarded before this is built. */
  oneProfileContext?: string;
  /** Main-only execution boundary. Renderer and Mobile input are discarded. */
  oneTeamExecutionPolicy?: "solo_locked" | "confirmed_existing_roster" | "confirmed_external_workforce";
  /** Main-only binding revalidated again in the runtime immediately before dispatch. */
  oneTeamRuntimeBinding?: OneTeamRuntimeBinding;
  /** Main-memory-only exact prompt bytes captured before the durable start. */
  oneParticipantExecutionSnapshot?: OneParticipantExecutionSnapshot;
  /** Main-only staged-file guide. Renderer and Mobile input are always discarded. */
  oneAttachmentContext?: string;
  /** Main-only output redaction map for internal staging paths. */
  oneAttachmentRedactions?: Array<{ path: string; replacement: string }>;
};

type InvocationEventListener = (envelope: InvocationEventEnvelope) => void;
type ActiveChatsListener = (chatIds: string[]) => void;
type InvocationSettledListener = (envelope: InvocationSettledEnvelope) => void | Promise<void>;

const MAX_BUFFERED_EVENTS = 4_000;
const MAX_PARTIAL_CHARS = 2 * 1024 * 1024;
const MAX_STEER_QUEUE_DEPTH = 8;
const ONE_TASK_KIND_MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/;
const ONE_TASK_KIND_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ONE_TASK_KIND_PARTICIPANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function oneTaskKindImageRef(image: ImageAttachment): string | null {
  if (
    !image
    || typeof image.mediaType !== "string"
    || !ONE_TASK_KIND_MEDIA_TYPE_RE.test(image.mediaType)
    || typeof image.data !== "string"
    || image.data.length < 4
    || image.data.length > Math.ceil(ONE_ATTACHMENT_LIMITS.maxImageBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
  ) return null;
  const bytes = Buffer.from(image.data, "base64");
  if (
    bytes.length < 1
    || bytes.length > ONE_ATTACHMENT_LIMITS.maxImageBytes
    || bytes.toString("base64") !== image.data
  ) return null;
  return `image:${image.mediaType}:${bytes.length}:sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function oneTaskKindAttachmentRef(item: OneAttachmentSafeItem): string | null {
  if (
    !item
    || (item.kind !== "image" && item.kind !== "file")
    || typeof item.mediaType !== "string"
    || !ONE_TASK_KIND_MEDIA_TYPE_RE.test(item.mediaType)
    || !Number.isSafeInteger(item.size)
    || item.size < 0
    || item.size > (item.kind === "image" ? ONE_ATTACHMENT_LIMITS.maxImageBytes : ONE_ATTACHMENT_LIMITS.maxFileBytes)
    || typeof item.digest !== "string"
    || !ONE_TASK_KIND_DIGEST_RE.test(item.digest)
  ) return null;
  return `attachment:${item.kind}:${item.mediaType}:${item.size}:${item.digest}`;
}

/**
 * Produce only content identities for Task-kind derivation. Attachment names,
 * local paths, staging paths, and image base64 never cross this boundary.
 */
function buildOneTaskKindInputRefs(
  attachments: readonly OneAttachmentSafeItem[],
  images: readonly ImageAttachment[],
): string[] | null {
  if (
    !Array.isArray(attachments)
    || attachments.length > ONE_ATTACHMENT_LIMITS.maxCount
    || !Array.isArray(images)
    || images.length > ONE_ATTACHMENT_LIMITS.maxCount
  ) return null;
  const refs: string[] = [];
  let totalAttachmentBytes = 0;
  for (const attachment of attachments) {
    const ref = oneTaskKindAttachmentRef(attachment);
    if (!ref) return null;
    totalAttachmentBytes += attachment.size;
    if (totalAttachmentBytes > ONE_ATTACHMENT_LIMITS.maxTotalBytes) return null;
    refs.push(ref);
  }
  for (const image of images) {
    const ref = oneTaskKindImageRef(image);
    if (!ref) return null;
    refs.push(ref);
  }
  return refs;
}

/**
 * Resolve the execution roster from exactly the owner plus the claimed Main
 * preflight targets. Never infer participants from legacy firms, groups,
 * hired-agent cards, prior events, or renderer-supplied targets.
 */
function exactOneInvocationParticipants(
  ownerAgentId: string,
  preparedTeam: PreparedOneTeamPreflightClaim | null,
): InstalledAgent[] | null {
  if (!ONE_TASK_KIND_PARTICIPANT_ID_RE.test(ownerAgentId)) return null;
  const participantIds = [ownerAgentId];
  const seen = new Set(participantIds);
  if (preparedTeam) {
    if (
      (preparedTeam.mode === "solo" && preparedTeam.taskForceTargets.length !== 0)
      || (preparedTeam.mode === "team" && preparedTeam.taskForceTargets.length < 1)
    ) return null;
    for (const target of preparedTeam.taskForceTargets) {
      if (
        target.source !== "local"
        || target.entityKind !== "agent"
        || !ONE_TASK_KIND_PARTICIPANT_ID_RE.test(target.agentId)
        || seen.has(target.agentId)
      ) return null;
      seen.add(target.agentId);
      participantIds.push(target.agentId);
    }
  }
  const installedById = new Map<string, InstalledAgent>();
  for (const installed of listInstalledAgentsReadOnly()) {
    if (installedById.has(installed.id)) return null;
    installedById.set(installed.id, installed);
  }
  const participants: InstalledAgent[] = [];
  for (const participantId of participantIds) {
    const participant = installedById.get(participantId);
    if (!participant || participant.kind === "team" || participant.sourceMissingSince) return null;
    participants.push(participant);
  }
  return participants;
}

function trySetTaskStatus(
  chatId: string,
  status: CanonicalTaskStatus,
  createIfMissing = true,
  origin: "one" | "work" | "mobile" = "work",
): CanonicalTask | null {
  try {
    const prior = findCanonicalTaskForChat(chatId);
    const task = prior ?? (createIfMissing ? ensureCanonicalTaskForChat(chatId) : null);
    if (!task) return null;
    if (!prior) {
      tryRecordOneDomainEvent({
        eventType: "task.created",
        occurredAt: task.createdAt,
        actor: origin === "one" ? "one" : "system",
        entityId: task.id,
        ...(task.projectId ? { projectId: task.projectId } : {}),
        taskId: task.id,
        version: task.version,
        visibility: task.projectId ? "project" : "personal",
        entries: [
          { name: "goalSummary", value: "Task created from an explicit user request" },
          { name: "origin", value: origin },
        ],
      });
    }
    if (task.status === status) return task;
    const updated = setCanonicalTaskStatus(task.id, status);
    tryRecordOneDomainEvent({
      eventType: "task.state_changed",
      occurredAt: updated.updatedAt,
      actor: "system",
      entityId: updated.id,
      ...(updated.projectId ? { projectId: updated.projectId } : {}),
      taskId: updated.id,
      version: updated.version,
      visibility: updated.projectId ? "project" : "personal",
      entries: [
        { name: "from", value: task.status },
        { name: "to", value: status },
        { name: "reason", value: "authoritative invocation lifecycle" },
      ],
    });
    return updated;
  } catch {
    // Task projection is a durable companion to the run ledger. A temporary
    // projection failure must not prevent the underlying invocation.
    return null;
  }
}

function domainVisibility(task: CanonicalTask): "personal" | "project" {
  return task.projectId ? "project" : "personal";
}

function recordTaskRunStarted(
  task: CanonicalTask,
  runId: string,
  actor: "one" | "system",
): void {
  tryRecordOneDomainEvent({
    eventType: "run.started",
    occurredAt: new Date().toISOString(),
    actor,
    entityId: runId,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    taskId: task.id,
    version: 1,
    visibility: domainVisibility(task),
    entries: [
      { name: "runId", value: runId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
}

function recordTaskTerminalEvidence(input: {
  task: CanonicalTask | null;
  runId: string;
  terminalKind: "invoke_completed" | "invoke_cancelled" | "invoke_failed";
}): void {
  if (!input.task) return;
  if (input.terminalKind !== "invoke_completed") {
    tryRecordOneDomainEvent({
      eventType: "run.failed",
      occurredAt: input.task.updatedAt,
      actor: "system",
      entityId: input.runId,
      ...(input.task.projectId ? { projectId: input.task.projectId } : {}),
      taskId: input.task.id,
      version: 2,
      visibility: domainVisibility(input.task),
      entries: [
        { name: "stepId", value: "runtime" },
        { name: "errorClass", value: input.terminalKind === "invoke_cancelled" ? "cancelled" : "runtime_failure" },
        { name: "recoverability", value: input.terminalKind === "invoke_cancelled" ? "resume_or_retry" : "review_and_retry" },
      ],
    });
  }
  tryRecordOneDomainEvent({
    eventType: "receipt.recorded",
    occurredAt: input.task.updatedAt,
    actor: "system",
    entityId: input.task.id,
    ...(input.task.projectId ? { projectId: input.task.projectId } : {}),
    taskId: input.task.id,
    version: input.task.version,
    visibility: domainVisibility(input.task),
    entries: [
      { name: "receiptId", value: `receipt:${input.runId}` },
      { name: "kind", value: input.terminalKind },
      { name: "sourceOrRunRefs", value: [input.runId] },
    ],
  });
}

function oneWorkspaceTerminalPhase(
  terminalKind: "invoke_completed" | "invoke_cancelled" | "invoke_failed",
): OneWorkspaceRunPhase {
  if (terminalKind === "invoke_completed") return "completed";
  return terminalKind === "invoke_cancelled" ? "cancelled" : "failed";
}

function recordObservableRunStep(
  task: CanonicalTask | null,
  runId: string,
  event: McpInvocationEvent,
  sequence: number,
): void {
  if (!task) return;
  let status: "running" | "completed" | "failed" | null = null;
  let publicSafeSummary: string | null = null;
  if (event.kind === "tool-use") {
    status = event.tool?.isError ? "failed" : event.tool?.result !== undefined ? "completed" : "running";
    publicSafeSummary = status === "failed"
      ? "A runtime tool step failed."
      : status === "completed"
        ? "A runtime tool step completed."
        : "A runtime tool step started.";
  } else if (event.kind === "surface") {
    status = "completed";
    publicSafeSummary = "Your result is ready.";
  } else if (event.agentId && event.phase) {
    status = event.done ? "completed" : "running";
    publicSafeSummary = event.done
      ? "A team role completed its assigned step."
      : "A team role started an assigned step.";
  }
  if (!status || !publicSafeSummary) return;
  tryRecordOneDomainEvent({
    eventType: "run.step_changed",
    occurredAt: new Date().toISOString(),
    actor: event.agentId ? "agent" : "system",
    entityId: task.id,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    taskId: task.id,
    version: task.version,
    visibility: domainVisibility(task),
    entries: [
      { name: "stepId", value: `step:${runId}:${sequence}` },
      { name: "status", value: status },
      { name: "publicSafeSummary", value: publicSafeSummary },
    ],
  });
}

function recordManifestArtifactEvidence(
  task: CanonicalTask,
  manifest: NonNullable<McpInvocationEvent["oneSurface"]>,
): void {
  const occurredAt = manifest.surfaceState.lastSyncedAt ?? new Date().toISOString();
  for (const artifact of manifest.fallback.artifacts) {
    tryRecordOneDomainEvent({
      eventType: "artifact.created",
      occurredAt,
      actor: "system",
      entityId: artifact.artifactRef,
      ...(task.projectId ? { projectId: task.projectId } : {}),
      taskId: task.id,
      version: task.version,
      visibility: domainVisibility(task),
      entries: [
        { name: "artifactId", value: artifact.artifactRef },
        { name: "type", value: artifact.type },
        { name: "artifactVersion", value: manifest.contractVersion },
        { name: "storageRef", value: `manifest:${manifest.manifestId}` },
      ],
    });
    if (artifact.verificationStatus === "unverified") continue;
    tryRecordOneDomainEvent({
      eventType: "artifact.verified",
      occurredAt,
      actor: "system",
      entityId: artifact.artifactRef,
      ...(task.projectId ? { projectId: task.projectId } : {}),
      taskId: task.id,
      version: task.version,
      visibility: domainVisibility(task),
      entries: [
        { name: "artifactId", value: artifact.artifactRef },
        { name: "checks", value: ["closed_contract", "task_chat_binding", "durable_receipt"] },
        { name: "status", value: artifact.verificationStatus },
      ],
    });
  }
}

export function invocationEventPromotesTask(event: McpInvocationEvent): boolean {
  // Runtime progress is transported as a status-only `tool-use` event too
  // (for example, "Calling Claude Code CLI..."). That is not user work and
  // must not turn a greeting or ordinary answer into a canonical Task. Only
  // an actual tool payload proves that execution crossed the conversation
  // boundary.
  return (event.kind === "tool-use" && Boolean(event.tool)) ||
    event.kind === "surface" ||
    Boolean(event.agentId) ||
    event.phase === "delegate" ||
    (event.kind === "final" && typeof event.text === "string" && event.text.includes("<<agentlas-ask"));
}

export function attachOneSurfaceProjection(
  event: McpInvocationEvent,
  chatId: string,
  syncedAt = new Date().toISOString(),
): McpInvocationEvent {
  if (event.kind !== "surface" || !event.surface || event.oneSurface) return event;
  const task = findCanonicalTaskForChat(chatId);
  if (!task) return event;
  try {
    return {
      ...event,
      oneSurface: applyOneFriendlyFollowups(
        adaptLegacySurfaceToOneV1({
          manifest: event.surface,
          surfaceId: event.surfaceId ?? `surface:${task.id}`,
          taskId: task.id,
          syncedAt,
        }),
        event.oneFriendlyFollowups,
      ),
    };
  } catch {
    // The raw legacy event remains available to Work. One and Mobile receive no
    // semantic projection unless Main can produce the closed safe contract.
    return event;
  }
}

export function terminalTaskStatus(input: {
  kind: "final" | "error";
  requestsDecision: boolean;
  cancelled: boolean;
  hasPartialText: boolean;
}): CanonicalTaskStatus {
  if (input.kind === "final") {
    // A model/runtime final proves only that this run ended and a result was
    // received. Task completion requires a separate artifact/outcome receipt
    // or explicit user acceptance; it must never be inferred from final text.
    return input.requestsDecision ? "waiting-decision" : "partial";
  }
  if (input.cancelled) return "cancelled";
  return "failed";
}

function immutableWorkspaceBinding(
  binding: InvocationWorkspaceBinding,
): InvocationWorkspaceBinding {
  return Object.freeze({
    source: binding.source,
    canonicalPath: binding.canonicalPath,
    directoryIdentity: binding.directoryIdentity
      ? Object.freeze({ ...binding.directoryIdentity })
      : null,
  });
}

export class InvocationService {
  private readonly activeRuns = new InvocationLifecycleRegistry<RunRecord>();
  private readonly eventListeners = new Set<InvocationEventListener>();
  private readonly activeChatsListeners = new Set<ActiveChatsListener>();
  private readonly settledListeners = new Set<InvocationSettledListener>();
  private readonly steerQueues = new Map<string, QueuedSteer[]>();

  onEvent(listener: InvocationEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onActiveChats(listener: ActiveChatsListener): () => void {
    this.activeChatsListeners.add(listener);
    return () => this.activeChatsListeners.delete(listener);
  }

  /** Runs only after the terminal receipt is durable and the live run has settled. */
  onSettled(listener: InvocationSettledListener): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  activeChatIds(): string[] {
    return this.activeRuns.activeChatIds();
  }

  start(
    req: McpInvocationRequest,
    workspaceBinding?: InvocationWorkspaceBinding,
  ): InvocationStartResult {
    const incoming = req as OneInvocationRequest;
    const {
      oneProfileContext: _untrustedOneProfileContext,
      oneTeamExecutionPolicy: _untrustedOneTeamExecutionPolicy,
      oneTeamRuntimeBinding: _untrustedOneTeamRuntimeBinding,
      oneParticipantExecutionSnapshot: _untrustedOneParticipantExecutionSnapshot,
      oneAttachmentContext: _untrustedOneAttachmentContext,
      oneAttachmentRedactions: _untrustedOneAttachmentRedactions,
      oneRecurrenceSelection: requestedOneRecurrenceSelection,
      oneMemoryUseOnceRef: requestedOneMemoryUseOnceRef,
      oneBriefingActionRef: requestedOneBriefingActionRef,
      oneTeamPreflightRef: requestedOneTeamPreflightRef,
      oneAttachmentRef: requestedOneAttachmentRef,
      ...requestWithoutMainContext
    } = incoming;
    const storedChat = getChat(req.chatId);
    if (!storedChat) throw new Error("Chat not found");
    const chat = repairRootChatSurfaceController(storedChat);
    const mobileOneBoundary = workspaceBinding?.source === "mobile-one";
    if (incoming.oneMode === true && chat.originSurface !== "one") {
      throw new Error("One execution is valid only for a One-owned conversation");
    }
    if (chat.originSurface === "one" && incoming.oneMode !== true) {
      throw new Error("A One-owned conversation cannot run through the Work execution contract");
    }
    const requestedOneMode = incoming.oneMode === true
      && chat.originSurface === "one"
      && (!workspaceBinding || mobileOneBoundary)
      && req.agentAppMode !== true;
    if (requestedOneMemoryUseOnceRef && (!requestedOneMode || workspaceBinding)) {
      throw new Error("A Memory use-once receipt is valid only for a local One invocation");
    }
    if (requestedOneBriefingActionRef && (!requestedOneMode || workspaceBinding)) {
      throw new Error("A Briefing action packet is valid only for a local One invocation");
    }
    if (requestedOneBriefingActionRef && requestedOneMemoryUseOnceRef) {
      throw new Error("A Briefing review cannot widen itself with a one-time Memory capability");
    }
    if (requestedOneTeamPreflightRef && (!requestedOneMode || (workspaceBinding && !mobileOneBoundary))) {
      throw new Error("A team preflight capability is valid only for a local One invocation");
    }
    if (requestedOneTeamPreflightRef && (requestedOneBriefingActionRef || requestedOneMemoryUseOnceRef)) {
      throw new Error("A team preflight run cannot widen itself with another One capability");
    }
    if (requestedOneAttachmentRef && (!requestedOneMode || workspaceBinding)) {
      throw new Error("A One attachment capability is valid only for a local Desktop One invocation");
    }
    if (requestedOneAttachmentRef && requestedOneBriefingActionRef) {
      throw new Error("A Briefing review cannot widen itself with an attachment capability");
    }
    if (requestedOneRecurrenceSelection !== undefined && (!requestedOneMode || workspaceBinding)) {
      throw new Error("A recurrence selection is valid only for a local Desktop One invocation");
    }
    if (requestedOneRecurrenceSelection !== undefined && requestedOneBriefingActionRef) {
      throw new Error("A Briefing review cannot add a recurrence proposal signal");
    }
    const oneRecurrenceSelection = requestedOneRecurrenceSelection !== undefined
      ? normalizeOneRecurrenceSelectionV1(requestedOneRecurrenceSelection)
      : null;
    let invocationRequest: OneInvocationRequest = {
      ...requestWithoutMainContext,
      oneMode: requestedOneMode,
      ...(workspaceBinding
        ? { permissions: normalizeRemoteInvocationPermission(req.permissions) }
        : {}),
    };
    if (requestedOneMode) {
      // Every ordinary One turn is fail-closed to its selected local agent.
      // A team roster can only be restored below from an exact Main-issued
      // preflight capability; renderer-supplied candidates never survive.
      invocationRequest = {
        ...invocationRequest,
        sessionRouting: false,
        hubMode: "local-only",
        borrowAgents: [],
        borrowVersions: undefined,
        taskForceTargets: undefined,
        pipelineStages: undefined,
        routerAgent: undefined,
        oneTeamExecutionPolicy: "solo_locked",
        oneTeamRuntimeBinding: undefined,
        // Desktop One accepts files only through a Main-minted attachment
        // capability. Mobile One keeps its separately bounded image wire.
        ...(!workspaceBinding ? { images: undefined } : {}),
      };
    }
    if (typeof req.runId === "string" && hasInvocationRunReceipt(req.runId)) {
      throw new Error("Invocation runId already has a durable receipt; use a new runId");
    }
    const runId = resolveInvocationRunId(
      req.runId,
      (candidate) => this.activeRuns.hasSeen(candidate) || hasInvocationRunReceipt(candidate),
    );
    const runWorkspaceBinding = workspaceBinding
      ? immutableWorkspaceBinding(workspaceBinding)
      : undefined;
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    const preparedOneTeamPreflight = requestedOneTeamPreflightRef
      ? prepareOneTeamPreflightClaim(requestedOneTeamPreflightRef, chat.id)
      : null;
    if (preparedOneTeamPreflight && teamProposalRequiresOneAttachments(preparedOneTeamPreflight.proposalId) && !requestedOneAttachmentRef) {
      throw new Error("This team proposal requires its exact prepared One attachment capability");
    }
    if (preparedOneTeamPreflight) {
      if (runId !== preparedOneTeamPreflight.ref.reservedRunId) {
        throw new Error("One team preflight run binding changed");
      }
      invocationRequest = {
        ...invocationRequest,
        runId: preparedOneTeamPreflight.ref.reservedRunId,
        chatId: preparedOneTeamPreflight.chatId,
        userPrompt: preparedOneTeamPreflight.userPrompt,
        taskIntent: "task",
        oneMode: true,
        permissions: preparedOneTeamPreflight.permission,
        sessionRouting: false,
        hubMode: preparedOneTeamPreflight.mode === "workforce" ? "hub-first" : "local-only",
        borrowAgents: [],
        borrowVersions: undefined,
        taskForceTargets: preparedOneTeamPreflight.taskForceTargets,
        pipelineStages: undefined,
        routerAgent: undefined,
        oneTeamExecutionPolicy: preparedOneTeamPreflight.mode === "team"
          ? "confirmed_existing_roster"
          : preparedOneTeamPreflight.mode === "workforce"
            ? "confirmed_external_workforce"
            : "solo_locked",
        oneTeamRuntimeBinding: preparedOneTeamPreflight.runtime,
      };
    }
    const preparedOneBriefingAction = requestedOneBriefingActionRef
      ? prepareOneBriefingActionClaim(requestedOneBriefingActionRef, chat.id)
      : null;
    if (preparedOneBriefingAction) {
      if (runId !== preparedOneBriefingAction.ref.reservedRunId) {
        throw new Error("One Briefing action run binding changed");
      }
      invocationRequest = {
        ...invocationRequest,
        runId: preparedOneBriefingAction.ref.reservedRunId,
        chatId: preparedOneBriefingAction.chatId,
        userPrompt: preparedOneBriefingAction.userPrompt,
        taskIntent: "task",
        oneMode: true,
        permissions: "read",
        sessionRouting: false,
        hubMode: "local-only",
        borrowAgents: [],
        taskForceTargets: undefined,
        oneTeamExecutionPolicy: "solo_locked",
        oneTeamRuntimeBinding: undefined,
      };
    }
    const preparedOneMemoryUseOnce = requestedOneMemoryUseOnceRef
      ? prepareOneMemoryUseOnceClaim(requestedOneMemoryUseOnceRef, chat.id)
      : null;
    const explicitMemoryIntent = requestedOneMode && !preparedOneBriefingAction
      ? detectExplicitOneMemoryIntent(invocationRequest.userPrompt)
      : null;
    let oneProfileReceipt: {
      oneId: string;
      profileVersion: number;
      principleIds: string[];
      scopeKinds: string[];
    } | null = null;
    let oneMemoryReceipt: {
      storeVersion: number;
      memoryIds: string[];
      scopeKinds: string[];
      assets: Array<{
        assetId: string;
        assetVersion: number;
        provenanceStatus: "verified" | "legacy_unversioned";
        sourceTaskId: string;
        sourceTaskVersion: number | null;
        sourceRunId: string | null;
        sourceValueClosureId: string | null;
        sourceValueClosureVersion: number | null;
        scope: "personal" | "project" | "agent" | "team";
      }>;
    } | null = null;
    let oneProfileContext: string | undefined;
    if (requestedOneMode) {
      const profile = getOneProfile();
      const invocationScope = {
        projectId: chat.projectId,
        agentId: chat.agentId,
        teamId: chat.firmId,
      };
      const appliedPrinciples = selectApprovedOneOperatingPrinciples(profile, invocationScope);
      const memoryState = getOneMemoryState();
      const appliedMemories = selectApprovedOneMemoryAssets(invocationScope, memoryState);
      // One 페르소나 오버레이 — Main만 붙인다. 실행 경계(solo_locked·preflight)는
      // 위에서 이미 고정됐고, 이 블록은 정체성/능력 서술만 더한다.
      oneProfileContext = [
        ONE_PERSONA_DIRECTIVE,
        buildApprovedOneProfileContext(profile, invocationScope),
        buildApprovedOneMemoryContext(invocationScope, memoryState),
        ...(preparedOneMemoryUseOnce ? [preparedOneMemoryUseOnce.context] : []),
        ...(preparedOneBriefingAction ? [preparedOneBriefingAction.context] : []),
      ].join("\n\n");
      oneProfileReceipt = {
        oneId: profile.oneId,
        profileVersion: profile.version,
        principleIds: appliedPrinciples.map((item) => item.id),
        scopeKinds: [...new Set(appliedPrinciples.map((item) => item.scope))].sort(),
      };
      oneMemoryReceipt = {
        storeVersion: memoryState.version,
        memoryIds: appliedMemories.map((item) => item.id),
        scopeKinds: [...new Set(appliedMemories.map((item) => item.scope))].sort(),
        assets: appliedMemories.map((item) => ({
          assetId: item.id,
          assetVersion: item.version,
          provenanceStatus: item.provenanceStatus,
          sourceTaskId: item.sourceTaskId,
          sourceTaskVersion: item.sourceTaskVersion,
          sourceRunId: item.sourceRunId,
          sourceValueClosureId: item.sourceValueClosureId,
          sourceValueClosureVersion: item.sourceValueClosureVersion,
          scope: item.scope,
        })),
      };
    }
    const projectFolder = runWorkspaceBinding
      ? null
      : chat.projectId
        ? getProject(chat.projectId)?.folderPath ?? null
        : null;
    const resultFolder = runWorkspaceBinding
      ? runWorkspaceBinding.canonicalPath ?? agentRunCwd()
      : getChatWorkingFolder(req.chatId) ?? projectFolder ?? agentRunCwd();
    const claimedOneAttachments = requestedOneAttachmentRef
      ? claimOneAttachments({
          ref: requestedOneAttachmentRef,
          chatId: chat.id,
          userPrompt: invocationRequest.userPrompt,
          runId,
          resultFolder,
          teamProposalId: preparedOneTeamPreflight?.proposalId ?? null,
        })
      : null;
    const runReq: OneInvocationRequest = {
      ...invocationRequest,
      runId,
      // The resident judge decides "conversation vs task" by meaning: the async
      // invoke paths warm the judgment cache (prejudgeOneRequestIntent) and this
      // sync site peeks it; without a judged verdict the intent remains undecided.
      ...(requestedOneMode
        && invocationRequest.taskIntent === "conversation"
        && classifyOneRequestIntent(invocationRequest.userPrompt, judgedOneRequestIntent) === "task"
        ? { taskIntent: "task" as const, permissions: "write" as const }
        : {}),
      ...(oneProfileContext ? { oneProfileContext } : {}),
      ...(claimedOneAttachments ? {
        taskIntent: "task" as const,
        images: claimedOneAttachments.images,
        oneAttachmentContext: claimedOneAttachments.runtimeContext,
        oneAttachmentRedactions: claimedOneAttachments.redactions,
      } : {}),
    };
    const record: RunRecord = {
      controller,
      chatId: req.chatId,
      startedAt,
      cancelRequestedAt: null,
      events: [],
      partialText: "",
      resultFolder,
      oneMode: requestedOneMode,
      goal: invocationRequest.userPrompt.slice(0, 4_000),
      settlementPublished: false,
      ...(runWorkspaceBinding ? { workspaceBinding: runWorkspaceBinding } : {}),
    };
    const oneParticipantPresentation = new Map<string, { name: string; role: string }>();

    try {
      let oneParticipantVersionBindings: OneParticipantVersionBinding[] | undefined;
      if (runReq.oneMode) {
        const participants = exactOneInvocationParticipants(chat.agentId, preparedOneTeamPreflight);
        if (!participants) {
          throw new Error("One participant version bindings could not be derived from the exact execution roster");
        }
        const executionSnapshot = snapshotOneParticipantExecution(participants);
        if (!executionSnapshot) {
          throw new Error("One participant version bindings could not be derived from the exact execution roster");
        }
        // Never persist these bytes. runMcpInvocation consumes this exact
        // in-memory snapshot for owner and local team execution.
        runReq.oneParticipantExecutionSnapshot = executionSnapshot;
        oneParticipantVersionBindings = executionSnapshot.bindings;
        const locale = pickLocale(runReq);
        for (const participant of participants) {
          const name = (
            participant.localDisplayName
            || (locale === "ko" ? participant.name : participant.nameEn)
            || participant.name
            || participant.nameEn
            || participant.slug
          ).trim();
          oneParticipantPresentation.set(participant.id, {
            name,
            role: participant.id === chat.agentId
              ? locale === "ko" ? "오케스트레이터" : "Orchestrator"
              : locale === "ko" ? "전문 에이전트" : "Specialist agent",
          });
        }
      }
      let oneTaskKindRef: string | null = null;
      if (runReq.oneMode && runReq.taskIntent === "task") {
        const inputRefs = buildOneTaskKindInputRefs(
          claimedOneAttachments?.receipt.attachments ?? [],
          runReq.images ?? [],
        );
        if (!inputRefs) throw new Error("One Task-kind inputs are invalid or exceed safe limits");
        oneTaskKindRef = deriveOneTaskKindRef({
          userPrompt: runReq.userPrompt,
          projectId: chat.projectId,
          firmId: chat.firmId,
          ownerAgentId: chat.agentId,
          inputRefs,
        });
        if (!oneTaskKindRef) throw new Error("One Task-kind intent is invalid or exceeds safe limits");
      }
      registerDurableInvocationStart({
        registry: this.activeRuns,
        runId,
        record,
        publishActiveState: () => this.publishActiveChats(),
        persistStart: () => recordRunEvent({
          runId,
          kind: "invoke_started",
          chatId: runReq.chatId,
          agentId: chat.agentId,
          payload: {
            oneMode: runReq.oneMode,
            invocationSource: runWorkspaceBinding?.source,
            oneTaskKindRef: oneTaskKindRef ?? undefined,
            oneParticipantVersionBindings,
            oneTeamPreflightProposalId: preparedOneTeamPreflight?.proposalId,
            oneTeamPreflightMode: preparedOneTeamPreflight?.mode,
            oneTeamPreflightRuntimeDigest: preparedOneTeamPreflight?.runtime.digest,
            oneTeamExecutionPolicy: runReq.oneTeamExecutionPolicy,
            oneBriefingActionPacketId: preparedOneBriefingAction?.packetId,
            oneBriefingActionEvidenceDigest: preparedOneBriefingAction?.evidenceDigest,
            oneBriefingActionPolicy: preparedOneBriefingAction ? "read_only_claim_once_after_durable_start" : undefined,
            oneMemoryUseOnceReceiptId: preparedOneMemoryUseOnce?.receiptId,
            oneMemoryUseOncePolicy: preparedOneMemoryUseOnce ? "claim_once_after_durable_start" : undefined,
            permissions: runReq.permissions,
            toolMode: runReq.toolMode,
            hubMode: runReq.hubMode,
            borrowAgents: runReq.borrowAgents,
            taskForceTargets: runReq.taskForceTargets,
            hasImages: Boolean(runReq.images?.length),
            hasOneAttachments: Boolean(claimedOneAttachments),
            oneAttachmentCount: claimedOneAttachments?.receipt.attachments.length,
            oneAttachmentTotalBytes: claimedOneAttachments?.receipt.totalBytes,
            planMode: runReq.planMode,
            goalMode: runReq.goalMode,
            appsGenerateMode: runReq.appsGenerateMode,
            oneRecurrenceSelection: oneRecurrenceSelection ?? undefined,
            oneRecurrencePolicy: oneRecurrenceSelection
              ? "proposal_evidence_only_review_required"
              : undefined,
          },
        }),
      });
    } catch (error) {
      releaseOneAttachmentRun(requestedOneAttachmentRef);
      throw error;
    }
    if (claimedOneAttachments) {
      tryRecordRunEvent({
        runId,
        kind: "one_attachments_claimed",
        chatId: runReq.chatId,
        payload: {
          contractVersion: claimedOneAttachments.receipt.contractVersion,
          attachmentCount: claimedOneAttachments.receipt.attachments.length,
          totalBytes: claimedOneAttachments.receipt.totalBytes,
          attachmentIds: claimedOneAttachments.receipt.attachments.map((item) => item.attachmentId),
          mediaTypes: claimedOneAttachments.receipt.attachments.map((item) => item.mediaType),
          sizes: claimedOneAttachments.receipt.attachments.map((item) => item.size),
          kinds: claimedOneAttachments.receipt.attachments.map((item) => item.kind),
          digests: claimedOneAttachments.receipt.attachments.map((item) => item.digest),
          sourcePathsPersisted: false,
        },
      });
    }
    if (preparedOneTeamPreflight) {
      try {
        const claimed = claimPreparedOneTeamPreflight(preparedOneTeamPreflight);
        tryRecordRunEvent({
          runId,
          kind: "one_team_preflight_claimed",
          chatId: runReq.chatId,
          payload: {
            proposalId: claimed.proposalId,
            status: claimed.status,
            mode: preparedOneTeamPreflight.mode,
            taskId: preparedOneTeamPreflight.taskId,
            taskVersion: preparedOneTeamPreflight.taskVersion,
            runtimeDigest: preparedOneTeamPreflight.runtime.digest,
          },
        });
      } catch (error) {
        if (this.activeRuns.settle(runId)) this.publishActiveChats();
        failOneTeamPreflightStart(preparedOneTeamPreflight.ref);
        releaseOneAttachmentRun(requestedOneAttachmentRef);
        tryRecordRunEvent({
          runId,
          kind: "one_team_preflight_claim_failed",
          chatId: runReq.chatId,
          payload: {
            proposalId: preparedOneTeamPreflight.proposalId,
            status: "recovery_required",
          },
        });
        throw error;
      }
    }
    if (preparedOneBriefingAction) {
      try {
        const claimed = claimPreparedOneBriefingAction(preparedOneBriefingAction);
        tryRecordRunEvent({
          runId,
          kind: "one_briefing_action_claimed",
          chatId: runReq.chatId,
          payload: {
            packetId: claimed.packetId,
            candidateId: claimed.candidateId,
            evidenceDigest: claimed.evidenceDigest,
            evidenceRefs: claimed.evidenceRefs,
            permission: claimed.permission,
            executionStarted: claimed.executionStarted,
            taskId: claimed.task?.taskId,
            taskVersion: claimed.task?.taskVersion,
            status: claimed.status,
          },
        });
      } catch (error) {
        // invoke_started is already durable, so this is an explicit recovery
        // state rather than permission to dispatch or retry the model run.
        if (this.activeRuns.settle(runId)) this.publishActiveChats();
        releaseOneAttachmentRun(requestedOneAttachmentRef);
        tryRecordRunEvent({
          runId,
          kind: "one_briefing_action_claim_failed",
          chatId: runReq.chatId,
          payload: {
            packetId: preparedOneBriefingAction.packetId,
            status: "recovery_required",
          },
        });
        throw error;
      }
    }
    if (preparedOneMemoryUseOnce) {
      // Claim only after invoke_started is durable. The grant is never restored
      // after this point, including runtime failure/cancellation.
      let claimed: ReturnType<typeof claimPreparedOneMemoryUseOnce>;
      try {
        claimed = claimPreparedOneMemoryUseOnce(preparedOneMemoryUseOnce);
      } catch (error) {
        // Attachments have already crossed their own one-shot claim boundary.
        // A later Main-owned capability failure must not strand staged copies.
        if (this.activeRuns.settle(runId)) this.publishActiveChats();
        releaseOneAttachmentRun(requestedOneAttachmentRef);
        throw error;
      }
      tryRecordRunEvent({
        runId,
        kind: "one_memory_use_once_claimed",
        chatId: runReq.chatId,
        payload: {
          receiptId: claimed.receiptId,
          candidateId: claimed.candidateId,
          candidateVersion: claimed.candidateVersion,
          scope: claimed.scope,
          targetTaskId: claimed.binding.taskId,
          targetTaskVersion: claimed.binding.taskVersion,
          status: "claimed_once",
        },
      });
      if (claimed.binding.taskId && claimed.binding.taskVersion) {
        tryRecordOneDomainEvent({
          eventType: "receipt.recorded",
          occurredAt: claimed.claimedAt,
          actor: "system",
          entityId: claimed.receiptId,
          ...(claimed.binding.projectId ? { projectId: claimed.binding.projectId } : {}),
          taskId: claimed.binding.taskId,
          version: 1,
          visibility: claimed.scope === "team"
            ? "team"
            : claimed.scope === "project"
              ? "project"
              : "personal",
          entries: [
            { name: "receiptId", value: claimed.receiptId },
            { name: "kind", value: "one_memory_use_once_claimed" },
            { name: "sourceOrRunRefs", value: [runId, claimed.candidateId] },
          ],
        });
      }
    }
    if (oneProfileReceipt) {
      tryRecordRunEvent({
        runId,
        kind: "one_profile_context_applied",
        chatId: runReq.chatId,
        payload: oneProfileReceipt,
      });
    }
    if (oneMemoryReceipt) {
      tryRecordRunEvent({
        runId,
        kind: "one_memory_context_applied",
        chatId: runReq.chatId,
        payload: oneMemoryReceipt,
      });
    }
    // The run only exists after its durable idempotency receipt succeeds.
    // Keeping Task state behind that boundary prevents a failed start write
    // from leaving One and Mobile stuck on a run that never became authoritative.
    const invocationOrigin = requestedOneMode
      ? "one" as const
      : runWorkspaceBinding
        ? "mobile" as const
        : "work" as const;
    let canonicalTask: CanonicalTask | null;
    if (runReq.taskIntent !== "conversation") {
      canonicalTask = trySetTaskStatus(req.chatId, "running", true, invocationOrigin);
    } else {
      // A previously promoted conversation stays a Task on later turns.
      canonicalTask = trySetTaskStatus(req.chatId, "running", false, invocationOrigin);
    }
    let taskMaterialized = Boolean(canonicalTask);
    let taskRunStartedRecorded = false;
    let memoryCandidateProposed = false;
    let observableStepSequence = 0;
    if (canonicalTask) {
      recordTaskRunStarted(canonicalTask, runId, requestedOneMode ? "one" : "system");
      taskRunStartedRecorded = true;
      if (requestedOneMode) {
        tryProjectOneWorkspace({
          task: canonicalTask,
          runId,
          chatId: runReq.chatId,
          phase: "running",
        });
      }
    }

    let terminalObserved = false;
    void runMcpInvocation(
      runReq,
      (rawEvent) => {
        rawEvent = redactOneAttachmentEvent(runReq, rawEvent);
        // Agent App remains a separately isolated browser surface. A paired
        // Mobile client is a Desktop remote, so its live partial stream follows
        // the same chat behavior as the Desktop renderer.
        if (runReq.agentAppMode && rawEvent.kind === "partial") return;
        const boundedEvent: McpInvocationEvent =
          rawEvent.kind === "partial" &&
          typeof rawEvent.text === "string" &&
          rawEvent.text.length > MAX_PARTIAL_CHARS
            ? {
                ...rawEvent,
                text:
                  rawEvent.text.slice(0, MAX_PARTIAL_CHARS) +
                  (pickLocale(runReq) === "ko"
                    ? "\n\n[출력이 너무 길어 잘렸습니다 — 런어웨이 출력 메모리 보호]"
                    : "\n\n[Output truncated — runaway output memory guard]"),
              }
            : rawEvent;
        // CLI/orchestrator errors can contain stderr, cwd, executable/config
        // paths, or environment material. Site callers receive one fixed error.
        let event: McpInvocationEvent =
          runReq.agentAppMode && boundedEvent.kind === "error"
            ? { ...boundedEvent, error: untrustedRuntimeFailurePayload() }
            : boundedEvent;
        const attributedAgentId = event.runtimeAgentId ?? event.agentId;
        if (attributedAgentId) record.actualAgentId = attributedAgentId;
        const participantPresentation = attributedAgentId
          ? oneParticipantPresentation.get(attributedAgentId)
          : undefined;
        if (requestedOneMode && participantPresentation) {
          event = {
            ...event,
            agentName: event.agentName?.trim() || participantPresentation.name,
            role: event.role?.trim() || participantPresentation.role,
          };
        }

        const terminalRequestsDecision = event.kind === "final" &&
          (event.text ?? record.partialText).includes("<<agentlas-ask");
        if (!taskMaterialized && (invocationEventPromotesTask(event) || terminalRequestsDecision)) {
          canonicalTask = trySetTaskStatus(runReq.chatId, "running", true, invocationOrigin);
          taskMaterialized = Boolean(canonicalTask);
          if (canonicalTask && !taskRunStartedRecorded) {
            recordTaskRunStarted(canonicalTask, runId, requestedOneMode ? "one" : "system");
            taskRunStartedRecorded = true;
            if (requestedOneMode) {
              tryProjectOneWorkspace({
                task: canonicalTask,
                runId,
                chatId: runReq.chatId,
                phase: "running",
              });
            }
          }
        }

        const rawSurfaceForArtifactBinding = event.kind === "surface" ? event.surface : undefined;
        // Desktop Work owns and consumes its native Work surface. Only One or
        // the separately bounded Mobile bridge receives the closed One/Mobile
        // semantic projection; ordinary project work must not mint One state.
        if (requestedOneMode || runWorkspaceBinding) {
          event = attachOneSurfaceProjection(event, runReq.chatId);
        }
        if (event.oneFriendlyFollowups) {
          // The plan is an untrusted model proposal used only by the Main
          // projection boundary. One and Mobile receive semantic actions only.
          event = { ...event, oneFriendlyFollowups: undefined };
        }
        if (event.kind === "surface" && event.oneSurface) {
          const durableSurfaceRecorded = tryRecordDurableOneSurfaceResult({
            runId,
            chatId: runReq.chatId,
            manifest: event.oneSurface,
          });
          // Task-force execution persists the visible user turn after the run
          // starts. Chat-to-Task reconciliation can therefore advance the
          // canonical version while this service still holds its run-start
          // object. Surface persistence and filesystem sealing must share one
          // fresh exact version; a stale fallback would make the binder reject
          // an otherwise valid result (or attest the wrong Task version).
          const surfaceTask = findCanonicalTaskForChat(runReq.chatId);
          if (surfaceTask) canonicalTask = surfaceTask;
          if (durableSurfaceRecorded && surfaceTask && event.oneSurface.taskId === surfaceTask.id) {
            if (rawSurfaceForArtifactBinding) {
              const boundArtifactCount = bindOneSurfaceArtifacts({
                rawManifest: rawSurfaceForArtifactBinding,
                surface: event.oneSurface,
                taskId: surfaceTask.id,
                taskVersion: surfaceTask.version,
                chatId: runReq.chatId,
                runId,
                createdAt: event.oneSurface.surfaceState.lastSyncedAt,
              });
              if (boundArtifactCount > 0) {
                tryRecordDurableOneSurfaceResult({
                  runId,
                  chatId: runReq.chatId,
                  manifest: event.oneSurface,
                });
              }
            }
            tryRecordOneDomainEvent({
              eventType: "result.manifest_ready",
              occurredAt: event.oneSurface.surfaceState.lastSyncedAt ?? new Date().toISOString(),
              actor: "system",
              entityId: surfaceTask.id,
              ...(surfaceTask.projectId ? { projectId: surfaceTask.projectId } : {}),
              taskId: surfaceTask.id,
              version: surfaceTask.version,
              visibility: domainVisibility(surfaceTask),
              entries: [
                { name: "manifestId", value: event.oneSurface.manifestId },
                { name: "contractVersion", value: event.oneSurface.contractVersion },
                { name: "artifactRefs", value: event.oneSurface.fallback.artifacts.map((item) => item.artifactRef) },
              ],
            });
            recordManifestArtifactEvidence(surfaceTask, event.oneSurface);
            if (requestedOneMode) {
              tryProjectOneWorkspace({
                task: surfaceTask,
                runId,
                chatId: runReq.chatId,
                phase: "surface_ready",
                surface: event.oneSurface,
              });
            }
          }
        }
        // One and Mobile never receive the raw legacy manifest, even when its
        // semantic projection or durable write fails. A raw payload may carry
        // a Main-private local path/file URL; projection success must not be a
        // prerequisite for stripping that authority-bearing transport.
        if ((requestedOneMode || runWorkspaceBinding) && event.kind === "surface" && event.surface) {
          event = {
            ...event,
            surface: undefined,
            ...(!event.oneSurface
              ? {
                  status: pickLocale(runReq) === "ko"
                    ? "결과를 정리하는 중 문제가 생겨 이번 응답을 완성하지 못했어요."
                    : "Something went wrong while preparing this result, so it is not complete.",
                }
              : {}),
          };
        }

        observableStepSequence += 1;
        recordObservableRunStep(canonicalTask, runId, event, observableStepSequence);

        let wireEvent = event;
        if (event.kind === "partial" && !event.agentId && typeof event.text === "string") {
          const full = event.text;
          const previous = record.partialText;
          const probe = Math.min(32, previous.length);
          const appended =
            full.length >= previous.length &&
            (probe === 0 || full.slice(previous.length - probe, previous.length) === previous.slice(-probe));
          if (appended) {
            const delta = full.slice(previous.length);
            if (!delta) return;
            wireEvent = { ...event, text: undefined, delta, textLen: full.length };
          } else {
            wireEvent = { ...event, textLen: full.length };
          }
          record.partialText = full;
        }

        const last = record.events[record.events.length - 1];
        // partial(누적 전문)과 usage(단조 카운터)는 마지막 값만 의미 있다 — 연속이 아니어도
        // 같은 kind의 직전 버퍼 항목을 교체해 버퍼가 고빈도 신호로 밀려나지 않게 한다.
        if (event.kind === "partial" && !event.agentId && last?.kind === "partial" && !last.agentId) {
          record.events[record.events.length - 1] = event;
        } else if (event.kind === "usage") {
          let prevUsageIdx = -1;
          for (let i = record.events.length - 1; i >= 0; i -= 1) {
            if (record.events[i].kind === "usage") {
              prevUsageIdx = i;
              break;
            }
          }
          if (prevUsageIdx >= 0) record.events[prevUsageIdx] = event;
          else record.events.push(event);
        } else {
          record.events.push(event);
        }
        if (record.events.length > MAX_BUFFERED_EVENTS) {
          record.events.splice(0, record.events.length - MAX_BUFFERED_EVENTS);
        }
        recordMcpInvocationEvent(runId, runReq, event);
        this.publishEvent({ runId, chatId: runReq.chatId, event: wireEvent });

        if (event.kind === "final" || event.kind === "error") {
          if (
            !runReq.agentAppMode &&
            !runWorkspaceBinding &&
            event.kind === "error" &&
            controller.signal.aborted &&
            record.partialText.trim()
          ) {
            try {
              appendChatMessage(runReq.chatId, "assistant", record.partialText);
            } catch {
              // The durable run ledger still records terminal state.
            }
          }
          const terminalKind =
            event.kind === "final"
              ? "invoke_completed"
              : controller.signal.aborted
                ? "invoke_cancelled"
                : "invoke_failed";
          canonicalTask = trySetTaskStatus(
            runReq.chatId,
            terminalTaskStatus({
              kind: event.kind,
              requestsDecision: terminalRequestsDecision,
              cancelled: controller.signal.aborted,
              hasPartialText: Boolean(record.partialText.trim()),
            }),
            taskMaterialized,
            invocationOrigin,
          );
          taskMaterialized = Boolean(canonicalTask);
          terminalObserved = true;
          tryRecordRunEvent({
            runId,
            kind: terminalKind,
            chatId: runReq.chatId,
            agentId: attributedAgentId ?? record.actualAgentId,
            payload: {
              resultFolder: record.resultFolder,
              errorCode: event.error?.code,
              errorMessage: event.error?.message,
            },
          });
          recordTaskTerminalEvidence({ task: canonicalTask, runId, terminalKind });
          if (requestedOneMode && canonicalTask) {
            tryProjectOneWorkspace({
              task: canonicalTask,
              runId,
              chatId: runReq.chatId,
              phase: oneWorkspaceTerminalPhase(terminalKind),
            });
          }
          if (
            explicitMemoryIntent &&
            !memoryCandidateProposed &&
            canonicalTask &&
            terminalKind === "invoke_completed" &&
            !terminalRequestsDecision
          ) {
            memoryCandidateProposed = true;
            try {
              const memoryState = getOneMemoryState();
              proposeUnverifiedOneMemoryCandidateFromRun({
                expectedStoreVersion: memoryState.version,
                normalizedPreview: explicitMemoryIntent.normalizedPreview,
                scope: canonicalTask.projectId ? "project" : "personal",
                ...(canonicalTask.projectId ? { scopeRef: canonicalTask.projectId } : {}),
                sourceTaskId: canonicalTask.id,
                sourceRunId: runId,
                basis: explicitMemoryIntent.basis,
                suppressionKey: explicitMemoryIntent.suppressionKey,
              });
            } catch {
              // A duplicate, suppressed, unsafe, or concurrent proposal fails quiet.
              // The completed Task remains authoritative and no durable Memory is created.
            }
          }
          if (this.activeRuns.settle(runId)) this.publishActiveChats();
        }
      },
      controller.signal,
      runWorkspaceBinding,
    )
      .then((result) => {
        // A compromised runtime must not turn the private attachment staging
        // directory into a durable result-folder receipt.
        const returnedResultFolder = result.resultFolder;
        if (
          !returnedResultFolder
          || redactOneAttachmentText(runReq, returnedResultFolder) === returnedResultFolder
        ) {
          record.resultFolder = returnedResultFolder ?? record.resultFolder;
        }
        tryRecordRunEvent({
          runId,
          kind: "invoke_result",
          chatId: runReq.chatId,
          agentId: record.actualAgentId,
          payload: {
            resultFolder: record.resultFolder,
            tokens: result.tokens,
            hasFinalText: Boolean(result.finalText?.trim()),
          },
        });
      })
      .catch((error: unknown) => {
        const rawMessage = redactOneAttachmentText(
          runReq,
          error instanceof Error ? error.message : String(error),
        );
        const safeFailure = runReq.agentAppMode
          ? untrustedRuntimeFailurePayload()
          : { code: controller.signal.aborted ? "cancelled" : "invoke-threw", message: rawMessage };
        const message = safeFailure.message;
        tryRecordRunEvent({
          runId,
          kind: "invoke_threw",
          chatId: runReq.chatId,
          agentId: record.actualAgentId,
          payload: { errorMessage: message },
        });
        tryRecordFailureEvent({
          runId,
          source: "invoke",
          chatId: runReq.chatId,
          agentId: record.actualAgentId,
          errorCode: safeFailure.code,
          errorMessage: message,
        });
        if (!terminalObserved) {
          terminalObserved = true;
          canonicalTask = trySetTaskStatus(
            runReq.chatId,
            controller.signal.aborted ? "cancelled" : "failed",
            taskMaterialized,
            invocationOrigin,
          );
          taskMaterialized = Boolean(canonicalTask);
          if (!runReq.agentAppMode && controller.signal.aborted && record.partialText.trim()) {
            if (!runWorkspaceBinding) {
              try {
                appendChatMessage(runReq.chatId, "assistant", record.partialText);
              } catch {
                // Best effort. The final error remains visible over the event stream.
              }
            }
          }
          const event: McpInvocationEvent = {
            kind: "error",
            runtimeAgentId: record.actualAgentId,
            error: safeFailure,
          };
          record.events.push(event);
          recordMcpInvocationEvent(runId, runReq, event);
          this.publishEvent({ runId, chatId: runReq.chatId, event });
          const terminalKind = controller.signal.aborted ? "invoke_cancelled" as const : "invoke_failed" as const;
          tryRecordRunEvent({
            runId,
            kind: terminalKind,
            chatId: runReq.chatId,
            agentId: record.actualAgentId,
            payload: { resultFolder: record.resultFolder, errorMessage: message },
          });
          recordTaskTerminalEvidence({ task: canonicalTask, runId, terminalKind });
          if (requestedOneMode && canonicalTask) {
            tryProjectOneWorkspace({
              task: canonicalTask,
              runId,
              chatId: runReq.chatId,
              phase: oneWorkspaceTerminalPhase(terminalKind),
            });
          }
        }
      })
      .finally(() => {
        if (!terminalObserved) {
          canonicalTask = trySetTaskStatus(
            runReq.chatId,
            controller.signal.aborted ? "cancelled" : "failed",
            taskMaterialized,
            invocationOrigin,
          );
          taskMaterialized = Boolean(canonicalTask);
          const terminalKind = controller.signal.aborted ? "invoke_cancelled" as const : "invoke_failed" as const;
          tryRecordRunEvent({
            runId,
            kind: terminalKind,
            chatId: runReq.chatId,
            agentId: record.actualAgentId,
            payload: {
              resultFolder: record.resultFolder,
              errorMessage: "Runtime settled without a terminal event",
            },
          });
          recordTaskTerminalEvidence({ task: canonicalTask, runId, terminalKind });
          if (requestedOneMode && canonicalTask) {
            tryProjectOneWorkspace({
              task: canonicalTask,
              runId,
              chatId: runReq.chatId,
              phase: oneWorkspaceTerminalPhase(terminalKind),
            });
          }
        }
        if (this.activeRuns.settle(runId)) this.publishActiveChats();
        this.publishSettled(runId, record);
        releaseOneAttachmentRun(requestedOneAttachmentRef);
        this.drainSteerQueue(runReq.chatId);
      });

    return { runId };
  }

  cancel(runId: string): "requested" | "already-requested" | "not-found" {
    const record = this.activeRuns.get(runId);
    // Stop is terminal for the visible work item: it also clears directions
    // queued behind the active turn. Steering itself never calls cancel.
    if (record?.chatId) {
      this.steerQueues.delete(record.chatId);
    }
    const result = this.activeRuns.requestCancel(runId);
    if (result === "requested") {
      tryRecordRunEvent({
        runId,
        kind: "invoke_cancel_requested",
        chatId: record?.chatId,
        payload: { requestedAt: record?.cancelRequestedAt },
      });
    }
    return result;
  }

  /** DESKTOP_MOBILE_BRIDGE: main owns steering so every client gets identical resume semantics. */
  steer(
    req: McpInvocationRequest,
    expectedRunId?: string,
    workspaceBinding?: InvocationWorkspaceBinding,
  ): InvocationSteerResult {
    if (req.oneAttachmentRef) {
      throw new Error("One attachments cannot be added through steering in v1; wait for the active run and send a new request");
    }
    const steerRequest = workspaceBinding
      ? { ...req, permissions: normalizeRemoteInvocationPermission(req.permissions) }
      : req;
    const active = [...this.activeRuns.entries()].find(([, record]) => record.chatId === req.chatId);
    if (expectedRunId && active?.[0] !== expectedRunId) {
      throw new Error("Steering target is stale; attach to the current Desktop run and retry");
    }
    if (!active) {
      return {
        accepted: true,
        queued: false,
        interruptsCurrent: false,
        runId: this.start({ ...steerRequest, runId: undefined }, workspaceBinding).runId,
      };
    }
    if (!invocationWorkspaceBindingsEqual(active[1].workspaceBinding, workspaceBinding)) {
      throw new Error(
        "The Desktop working folder changed while this run was active. Attach to the current run or start a new Mobile chat.",
      );
    }
    const queue = this.steerQueues.get(req.chatId) ?? [];
    if (queue.length >= MAX_STEER_QUEUE_DEPTH) {
      throw new Error("Steering queue is full; wait for the current Desktop run to settle");
    }
    queue.push({
      request: { ...steerRequest, runId: undefined },
      ...(workspaceBinding
        ? { workspaceBinding: immutableWorkspaceBinding(workspaceBinding) }
        : {}),
    });
    this.steerQueues.set(req.chatId, queue);
    // 진화 트리거 근거 — 사용자가 실행 중 방향을 바꾸면(스티어링) content-free 신호를
    // 원장에 남긴다. 같은 에이전트를 반복 교정하면 "행동/역할 조정" 진화 제안이 뜬다.
    tryRecordRunEvent({
      runId: active[0],
      kind: USER_STEERING_EVENT_KIND,
      chatId: req.chatId,
      agentId: active[1].actualAgentId,
    });
    // Codex-style steering is additive. Keep the current child process alive,
    // surface the user's new turn immediately, and drain this queue only from
    // the active run's settlement path. The CLI runners are one-shot processes,
    // so writing to stdin here would either close or corrupt their protocol.
    return {
      accepted: true,
      queued: true,
      interruptsCurrent: false,
      activeRunId: active[0],
      position: queue.length,
    };
  }

  attach(chatId: string): InvocationAttachResult | null {
    let found: InvocationAttachResult | null = null;
    for (const [runId, record] of this.activeRuns.entries()) {
      if (record.chatId === chatId) {
        found = { runId, events: record.events.slice(), startedAt: record.startedAt };
      }
    }
    return found;
  }

  receipt(runId: string): InvocationRunReceipt | null {
    const record = this.activeRuns.get(runId);
    const durable = getInvocationRunReceipt(runId);
    if (!record) return durable;
    return {
      ...(durable ?? {
        runId,
        chatId: record.chatId,
        startedAt: record.startedAt,
        updatedAt: record.startedAt,
        eventCount: record.events.length,
      }),
      status: record.cancelRequestedAt ? "cancelling" : "running",
      updatedAt: record.cancelRequestedAt ?? durable?.updatedAt ?? record.startedAt,
      eventCount: Math.max(durable?.eventCount ?? 0, record.events.length),
      ...(record.resultFolder ? { resultFolder: record.resultFolder } : {}),
    };
  }

  latestReceipt(chatId: string): InvocationRunReceipt | null {
    for (const [runId, record] of this.activeRuns.entries()) {
      if (record.chatId === chatId) return this.receipt(runId);
    }
    return getLatestInvocationRunReceipt(chatId);
  }

  latestOneSurface(input: { runId: string; chatId: string; taskId: string }) {
    return getDurableOneSurfaceResult(input);
  }

  history(chatId: string) {
    return listChatMessages(chatId);
  }

  private publishEvent(envelope: InvocationEventEnvelope): void {
    for (const listener of this.eventListeners) {
      try {
        listener(envelope);
      } catch {
        // A renderer or phone disconnect must never break the host run.
      }
    }
  }

  private publishActiveChats(): void {
    const chatIds = this.activeChatIds();
    for (const listener of this.activeChatsListeners) {
      try {
        listener(chatIds);
      } catch {
        // Projection listeners are isolated from execution authority.
      }
    }
  }

  private publishSettled(runId: string, record: RunRecord): void {
    if (record.settlementPublished) return;
    const receipt = getInvocationRunReceipt(runId);
    if (!receipt || receipt.status === "running" || receipt.status === "cancelling") return;
    record.settlementPublished = true;
    const envelope: InvocationSettledEnvelope = {
      runId,
      chatId: record.chatId,
      receipt,
      oneMode: record.oneMode,
      goal: record.goal,
      ...(record.workspaceBinding ? { workspaceBinding: record.workspaceBinding } : {}),
    };
    for (const listener of this.settledListeners) {
      try {
        void Promise.resolve(listener(envelope)).catch(() => undefined);
      } catch {
        // Recovery and projection listeners can never alter terminal durability.
      }
    }
  }

  private drainSteerQueue(chatId: string): void {
    const queue = this.steerQueues.get(chatId);
    if (!queue?.length) return;
    const next = queue.shift();
    if (!queue.length) this.steerQueues.delete(chatId);
    if (!next) return;
    queueMicrotask(() => {
      try {
        this.start(next.request, next.workspaceBinding);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.publishEvent({
          runId: "steer",
          chatId,
          event: { kind: "error", error: { code: "steer-start-failed", message } },
        });
      }
    });
  }
}

export const invocationService = new InvocationService();
installMobileOneAutoRecovery(invocationService);
