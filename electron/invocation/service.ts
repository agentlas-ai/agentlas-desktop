import { isHostPreflightTool } from "../../shared/tool-activity";
import { createHash, randomUUID } from "node:crypto";
import { agentRunCwd } from "../runtime/exec";
import { resolveInvocationRunId } from "../runtime/run-id";
import {
  onAgentResidencyChange,
  type AgentResidencyChange,
} from "../runtime/agent-residency";
import {
  InvocationLifecycleRegistry,
  registerDurableInvocationStart,
} from "../runtime/invocation-lifecycle";
import {
  bindLongRunWorker,
  getLongRunByGoalId,
  listLongRunTasks,
  settleLongRunWorkerAttempt,
  startLongRunWorkerAttempt,
  transitionLongRun,
} from "../store/long-runs";
import { completeChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { prepareInvocationAutomaticGoal } from "./automatic-goal";
import { DesktopLongRunInvocationProjection } from "../long-run/invocation-projection";
import { resolveDesktopRuntimeAdapter } from "../long-run/runtime-adapters";
import { runMcpInvocation, type InvocationExecutionContext } from "../mcp/client";
import { applyFinalDisplayBackstop } from "../mcp/final-display-backstop";
import { extractAskFences } from "../../shared/ask-fence-flatten";
import {
  committedQuestionContinuationIsCurrent,
  getCommittedQuestionContinuation,
} from "../confirm";
import { deriveGoalAcceptanceCriteria, ensureGoalLedgerGoal } from "../mcp/goal-ledger";
import { resolveDesktopWorkforceGoalId } from "../mcp/workforce-goal-continuity";
import {
  invocationWorkspaceBindingsEqual,
  isRemoteInvocationWorkspaceBindingSource,
  assertInvocationWorkspaceSourceContext,
  normalizeRemoteInvocationPermission,
  type InvocationWorkspaceBinding,
} from "./workspace-binding";
import { pickLocale } from "../runtime/status-i18n";
import { getRuntimeToolPermissionArbiter } from "../runtime/tool-approval";
import {
  PERMISSION_ESCALATION_TOOL,
  hasPermissionEscalationMarker,
  stripPermissionEscalationMarker,
} from "../../shared/permission-escalation";
import { markInterruptedPartial } from "./interrupted-partial";
import { untrustedRuntimeFailurePayload } from "../runtime/untrusted-error";
import {
  getInvocationRunReceipt,
  getLatestInvocationRunReceipt,
  hasInvocationRunReceipt,
  recordMcpInvocationEvent,
  recordRunEvent,
  recordScienceRuntimeOutboxEvent,
  type ScienceRuntimeOutboxEvent,
  USER_STEERING_EVENT_KIND,
  tryRecordFailureEvent,
  tryRecordRunEvent,
} from "../store/run-events";
import { getProject } from "../store/projects";
import { getDb } from "../store/db";
import {
  beginQueuedSteerDrain,
  cancelQueuedSteersForChat,
  listRecoverableQueuedSteers,
  persistQueuedSteer,
  settleQueuedSteer,
} from "../store/invocation-steers";
import {
  appendChatMessage,
  getChat,
  getChatWorkingFolder,
  hasDurableAssistantMessage,
  latestDurableAssistantMessage,
  listChatMessages,
  repairRootChatSurfaceController,
  setChatGoalBinding,
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
import { bindOneSurfaceArtifacts, removeUnboundOneSurfaceArtifacts } from "../one/artifact-preview";
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
import { redactMcpInvocationEventSecrets } from "./event-secret-redaction";
import { normalizeOneRecurrenceSelectionV1 } from "../../shared/one-recurrence";
import { classifyOneRequestIntent } from "../../shared/one-request-intent";
import { oneVersionPinRosterIds } from "../../shared/one-team-preflight";
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
import { cacheOneOrgCompletionSummary, setOneOrgMemberStatus } from "../one/org";
import { adaptLegacySurfaceToOneV1 } from "../../shared/one-surface";
import { applyOneFriendlyFollowups } from "../../shared/one-friendly-followups";
import {
  buildApprovedOneProfileContext,
  selectApprovedOneOperatingPrinciples,
} from "../../shared/one-profile";
import type {
  InvocationRunReceipt,
  InvocationSteerResult,
  AgentlasUserDecisionRequest,
  McpInvocationEvent,
  McpInvocationRequest,
  QuestionContinuationReceipt,
  RuntimeSelection,
} from "../../shared/types";

/** DESKTOP_MOBILE_BRIDGE: renderer IPC and Mobile Bridge share this authority. */
export interface InvocationEventEnvelope {
  runId: string;
  chatId: string;
  event: McpInvocationEvent;
  /** Present only for Main-owned Science runs after the Desktop outbox commit. */
  scienceDelivery?: ScienceRuntimeOutboxEvent;
}

export interface InvocationAttachResult {
  runId: string;
  events: McpInvocationEvent[];
  /** 실행 시작 시각(ISO) — 재접속한 렌더러가 상태줄 경과시간을 0s부터 다시 세지 않게 한다. */
  startedAt?: string;
  /** Main-owned pending directions. A renderer route change must not erase the
   *  user's already accepted steering turn from the visible conversation. */
  queuedSteers: Array<{
    text: string;
    queuedAt: string;
    position: number;
  }>;
}

export interface InvocationStartResult {
  runId: string;
}

export interface InvocationSettledEnvelope {
  runId: string;
  chatId: string;
  /** Main-observed installed agent identity, if the runtime exposed one. */
  agentId?: string;
  receipt: InvocationRunReceipt;
  oneMode: boolean;
  /** Host-owned approval/input wait discovered from the terminal response. */
  pendingQuestion?: boolean;
  /** Semantic wait projection only; never an approval or execution grant. */
  userDecisionRequest?: AgentlasUserDecisionRequest;
  /** Main-memory-only original goal; never projected as a wire receipt. */
  goal: string;
  workspaceBinding?: InvocationWorkspaceBinding;
}

interface RunRecord {
  controller: AbortController;
  chatId: string;
  /** Main-memory request used to persist late resident-CLI lifecycle events. */
  request: McpInvocationRequest;
  startedAt: string;
  cancelRequestedAt: string | null;
  /** The active turn is settling because a durable replacement direction exists. */
  steeringInterruptRequested: boolean;
  events: McpInvocationEvent[];
  partialText: string;
  resultFolder?: string;
  actualAgentId?: string;
  workspaceBinding?: InvocationWorkspaceBinding;
  oneMode: boolean;
  goal: string;
  pendingQuestion: boolean;
  userDecisionRequest?: AgentlasUserDecisionRequest;
  questionContinuationSourceMessageId?: string;
  questionContinuationRequestHash?: string;
  settlementPublished: boolean;
  longRunProjection?: DesktopLongRunInvocationProjection;
  automaticGoalId?: string;
  automaticGoalDeadline?: ReturnType<typeof setTimeout>;
  /** Main-owned monotonic sequence shared by provider and resident-process events. */
  observableStepSequence: number;
  executionSource?: InvocationExecutionContext["source"];
}

function nextObservableSequence(record: RunRecord): number {
  record.observableStepSequence += 1;
  return record.observableStepSequence;
}

interface QueuedSteer {
  id: string;
  originalRunId: string;
  promptHash: string;
  request: McpInvocationRequest;
  queuedAt: string;
  workspaceBinding?: InvocationWorkspaceBinding;
  executionContext?: InvocationExecutionContext;
  drainedRunId?: string;
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

type OnePermissionMode = NonNullable<McpInvocationRequest["onePermissionMode"]>;

function normalizeOnePermissionMode(value: unknown): OnePermissionMode | null {
  return value === "auto" || value === "read" || value === "write" || value === "full" ? value : null;
}

export function authoritativeOnePermission(
  mode: OnePermissionMode | null,
  taskIntent: McpInvocationRequest["taskIntent"],
): "read" | "write" | "full" {
  if (mode === "read") return "read";
  if (mode === "write") return "write";
  if (mode === "full") return "full";
  // Missing legacy mode is treated as Auto, never as permission supplied by
  // the renderer. Desktop One always sends the explicit chip value now.
  return taskIntent === "task" ? "write" : "read";
}

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
  /*
   * 명단을 만드는 판단은 shared/one-team-preflight.ts 에 있다 — 부수효과가 없어
   * 게이트가 실제로 불러 볼 수 있고, "Hub 좌석이 섞여도 명단이 무효가 되지
   * 않는다"는 계약을 동작으로 검사한다. 여기 인라인으로 있던 동안 그 계약이
   * 깨졌고 문장 대조 게이트는 전부 초록이었다(인수 실측 2026-08-26).
   *
   * 팀과 Hub 좌석은 이 명단에 오르지 않는다: 못박을 로컬 설치본 버전이 없기
   * 때문이며, 실행기에는 taskForceTargets / borrowAgents 로 따로 실린다.
   */
  const participantIds = oneVersionPinRosterIds(
    ownerAgentId,
    preparedTeam ? preparedTeam.mode : null,
    preparedTeam ? preparedTeam.taskForceTargets : null,
  );
  if (!participantIds) return null;
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
  terminalKind: "invoke_completed" | "invoke_cancelled" | "invoke_interrupted" | "invoke_failed";
}): void {
  if (!input.task) return;
  if (input.terminalKind !== "invoke_completed") {
    const userDirectedStop = input.terminalKind === "invoke_cancelled" || input.terminalKind === "invoke_interrupted";
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
        { name: "errorClass", value: userDirectedStop ? "cancelled" : "runtime_failure" },
        { name: "recoverability", value: userDirectedStop ? "resume_or_retry" : "review_and_retry" },
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
  terminalKind: "invoke_completed" | "invoke_cancelled" | "invoke_interrupted" | "invoke_failed",
): OneWorkspaceRunPhase {
  if (terminalKind === "invoke_completed") return "completed";
  return terminalKind === "invoke_cancelled" || terminalKind === "invoke_interrupted" ? "cancelled" : "failed";
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

export function invocationEventRequestsDecision(event: McpInvocationEvent): boolean {
  if (event.kind !== "final") return false;
  if (
    event.userDecisionRequest?.schemaVersion === "agentlas.user-decision-request.v1"
    && event.userDecisionRequest.questions.length > 0
  ) return true;
  // Display hygiene removes ask fences. Re-parse the Main-only durable body so
  // malformed, incomplete, and zero/one-option templates never become waits.
  const body = event.durableTextForVerification ?? event.text;
  return extractAskFences(body).questions.length > 0;
}

export function invocationEventPromotesTask(event: McpInvocationEvent): boolean {
  // Runtime progress is transported as a status-only `tool-use` event too
  // (for example, "Calling Claude Code CLI..."). That is not user work and
  // must not turn a greeting or ordinary answer into a canonical Task. Only
  // an actual tool payload proves that execution crossed the conversation
  // boundary.
  const toolName = event.tool?.name.trim() ?? "";
  const hostPluginPreflight = isHostPreflightTool(toolName);
  return (event.kind === "tool-use" && Boolean(event.tool) && !hostPluginPreflight) ||
    event.kind === "surface" ||
    (Boolean(event.agentId) && (event.phase === "delegate" || (event.tier ?? 1) > 1)) ||
    event.phase === "delegate" ||
    invocationEventRequestsDecision(event);
}

function isRetryableDecisionStoreError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code === "SQLITE_PROTOCOL";
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
  interrupted?: boolean;
  hasPartialText: boolean;
}): CanonicalTaskStatus {
  if (input.kind === "final") {
    // A model/runtime final proves only that this run ended and a result was
    // received. Task completion requires a separate artifact/outcome receipt
    // or explicit user acceptance; it must never be inferred from final text.
    return input.requestsDecision ? "waiting-decision" : "partial";
  }
  if (input.interrupted) return "partial";
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
  private readonly pendingGoalVerifications = new Map<string, RunRecord>();
  private readonly steerQueues = new Map<string, QueuedSteer[]>();
  private acceptingStarts = true;

  constructor() {
    // A resident CLI can close independently of the current runner callback.
    // Bridge that fact into the same run event stream while the run is alive;
    // the renderer then sees a real `closed` state instead of guessing from a
    // missing answer.
    onAgentResidencyChange((change) => this.publishAgentResidencyChange(change));
  }

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
    return [...new Set([...this.activeRuns.activeChatIds(), ...[...this.pendingGoalVerifications.values()].map((record) => record.chatId)])];
  }

  activeRunIds(): string[] {
    return [...new Set([...this.activeRuns.entries()].map(([runId]) => runId).concat([...this.pendingGoalVerifications.keys()]))];
  }

  /**
   * Start only the request Main sealed with the accepted Decision. The caller
   * supplies no runtime or permission fields here, so remount/replay cannot
   * widen the original continuation. A stable run id collapses response-loss
   * retries onto the existing live/durable run.
   */
  async continueCommittedQuestion(
    chatId: string,
    sourceMessageId: string,
    reply: string,
  ): Promise<QuestionContinuationReceipt> {
    let intent;
    try {
      intent = getCommittedQuestionContinuation(chatId, sourceMessageId, reply);
    } catch (error) {
      if (!isRetryableDecisionStoreError(error)) {
        return { chatId, sourceMessageId, runId: "", status: "rejected", reasonCode: "invalid-intent" };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      try { intent = getCommittedQuestionContinuation(chatId, sourceMessageId, reply); } catch {
        return { chatId, sourceMessageId, runId: "", status: "rejected", reasonCode: "start-rejected" };
      }
    }
    if (!intent) {
      return { chatId, sourceMessageId, runId: "", status: "rejected", reasonCode: "invalid-intent" };
    }
    const live = this.activeRuns.get(intent.runId);
    if (live) {
      const exact = live.chatId === chatId
        && live.questionContinuationSourceMessageId === sourceMessageId
        && live.questionContinuationRequestHash === intent.requestHash;
      return exact
        ? { chatId, sourceMessageId, runId: intent.runId, status: "already-running", runStatus: "running" }
        : { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "invalid-intent" };
    }
    const existing = getInvocationRunReceipt(intent.runId);
    if (existing) {
      const bound = existing.chatId === chatId && Boolean(getDb().prepare(
        `SELECT 1 AS found FROM run_events
          WHERE run_id = ? AND kind = 'invoke_started'
            AND json_extract(payload_json, '$.questionContinuationSourceMessageId') = ?
            AND json_extract(payload_json, '$.questionContinuationRequestHash') = ?
          LIMIT 1`,
      ).get(intent.runId, sourceMessageId, intent.requestHash));
      if (!bound) {
        return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "invalid-intent" };
      }
      // With no matching in-memory owner, a start-only receipt is already
      // projected as `interrupted` by the ledger. Never replay it after a host
      // crash: the provider may have performed a side effect before the crash.
      return {
        chatId,
        sourceMessageId,
        runId: intent.runId,
        status: "already-terminal",
        runStatus: existing.status,
      };
    }
    if (!committedQuestionContinuationIsCurrent(chatId, sourceMessageId)) {
      return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "invalid-intent" };
    }
    if (!this.acceptingStarts) {
      return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "admission-closed" };
    }
    if (this.activeChatIds().includes(chatId)) {
      return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "chat-busy" };
    }

    const tryStart = (): QuestionContinuationReceipt => {
      const started = this.start(intent.request, undefined, undefined, {
        sourceMessageId,
        requestHash: intent.requestHash,
      });
      if (started.runId !== intent.runId) {
        return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "invalid-intent" };
      }
      return { chatId, sourceMessageId, runId: intent.runId, status: "started", runStatus: "running" };
    };
    try {
      return tryStart();
    } catch (error) {
      // Only machine-coded transient SQLite admission failures receive one
      // bounded retry. Permission, billing, cancellation, and provider errors
      // either have a durable terminal receipt or are returned without retry.
      if (isRetryableDecisionStoreError(error)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        let raced: InvocationRunReceipt | null;
        try { raced = getInvocationRunReceipt(intent.runId); } catch {
          return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "start-rejected" };
        }
        if (raced) {
          let bound = false;
          try {
            bound = raced.chatId === chatId && Boolean(getDb().prepare(
              `SELECT 1 AS found FROM run_events
                WHERE run_id = ? AND kind = 'invoke_started'
                  AND json_extract(payload_json, '$.questionContinuationSourceMessageId') = ?
                  AND json_extract(payload_json, '$.questionContinuationRequestHash') = ?
                LIMIT 1`,
            ).get(intent.runId, sourceMessageId, intent.requestHash));
          } catch {
            return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "start-rejected" };
          }
          if (!bound) {
            return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "invalid-intent" };
          }
          return {
            chatId,
            sourceMessageId,
            runId: intent.runId,
            status: raced.status === "running" || raced.status === "cancelling"
              ? "already-running"
              : "already-terminal",
            runStatus: raced.status,
          };
        }
        try { return tryStart(); } catch { /* bounded: never loop */ }
      }
      return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "start-rejected" };
    }
  }

  openAppAdmission(): void {
    this.acceptingStarts = true;
  }

  /** Close the Desktop execution gate and interrupt every live turn. */
  beginAppShutdown(): string[] {
    this.acceptingStarts = false;
    const runIds = this.activeRunIds();
    for (const runId of runIds) this.cancelWithReason(runId, new Error("app_closed"));
    return runIds;
  }

  /** Rehydrate exact accepted directions after SQLite is initialized on boot. */
  recoverQueuedSteers(): number {
    const rows = listRecoverableQueuedSteers();
    for (const row of rows) {
      if (row.drainedRunId && hasInvocationRunReceipt(row.drainedRunId)) {
        settleQueuedSteer(row.id, "started");
        continue;
      }
      // A queued direction belonged to a host process that no longer exists.
      // Never auto-dispatch it on a later app launch; a long run is restored as
      // paused by AppRuntimeCoordinator and only a user resume may continue it.
      settleQueuedSteer(row.id, "cancelled");
    }
    return rows.length;
  }

  start(
    req: McpInvocationRequest,
    workspaceBinding?: InvocationWorkspaceBinding,
    /**
     * 실행 표면 표식. 미지정은 "헤드리스 누락"과 구분되지 않는 fail-open 상태라
     * 원격 대화형 채널(telegram 등)은 반드시 넘긴다.
     */
    executionContext?: InvocationExecutionContext,
    /** Main-only exact Decision continuation binding; never accepted over IPC. */
    questionContinuation?: { sourceMessageId: string; requestHash: string },
  ): InvocationStartResult {
    assertInvocationWorkspaceSourceContext(workspaceBinding, executionContext?.source);
    if (!this.acceptingStarts) throw new Error("desktop_execution_admission_closed");
    if ([...this.pendingGoalVerifications.values()].some((record) => record.chatId === req.chatId)) throw new Error("goal_verification_pending");
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
    // A One turn may also arrive from the paired Telegram channel. Both remote
    // One boundaries keep One mode; only the Mobile one may carry a team
    // preflight capability, because only Mobile has a surface that mints one.
    const remoteOneBoundary = mobileOneBoundary || workspaceBinding?.source === "telegram-one";
    if (incoming.oneMode === true && chat.originSurface !== "one") {
      throw new Error("One execution is valid only for a One-owned conversation");
    }
    if (chat.originSurface === "one" && incoming.oneMode !== true) {
      throw new Error("A One-owned conversation cannot run through the Work execution contract");
    }
    const requestedOneMode = incoming.oneMode === true
      && chat.originSurface === "one"
      && (!workspaceBinding || remoteOneBoundary)
      && req.agentAppMode !== true;
    const selectedOnePermissionMode = requestedOneMode
      ? normalizeOnePermissionMode(incoming.onePermissionMode)
      : null;
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
        : requestedOneMode
          ? { permissions: authoritativeOnePermission(selectedOnePermissionMode, requestWithoutMainContext.taskIntent) }
        : {}),
    };
    if (requestedOneMode) {
      /*
       * ★오너 결정 2026-08-20 — One 잠금해제. 예전에는 모든 일반 One 턴을
       * solo_locked + local-only 로 강등해 One 이 Work 의 기능(라우팅·워크포스·
       * 파이프라인)을 쓸 수 없었다. One 은 최고권한자다: Work 대화와 같은 실행
       * 계약을 그대로 받는다. 경계는 정적 강등이 아니라 행동 시점 승인
       * (tool-approval 중재자 + capability_grants)과 편성 동의 UI 가 지킨다.
       *
       * 유지되는 것: 렌더러가 지어낼 수 없는 Main 전용 값들은 여전히 폐기된다 —
       * oneTeamExecutionPolicy / oneTeamRuntimeBinding 은 위 _untrusted 구조분해로
       * 이미 벗겨졌고, 정확한 로스터 바인딩은 아래 Main 발행 preflight capability
       * 로만 복원된다.
       */
      invocationRequest = {
        ...invocationRequest,
        oneTeamExecutionPolicy: undefined,
        oneTeamRuntimeBinding: undefined,
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
    // A workspace capability is not necessarily a Mobile surface. Science
    // keeps its local persistence/projection while sharing directory identity checks.
    const remoteWorkspaceBinding = Boolean(runWorkspaceBinding
      && isRemoteInvocationWorkspaceBindingSource(runWorkspaceBinding.source));
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
      /*
       * ★수리 2026-08-25 — 화면이 보여준 팀이 실행에 실리게.
       * 예전에는 `borrowAgents: []` 가 하드코딩이고 hubMode 가 workforce 가
       * 아니면 무조건 local-only 였다. 그래서 사람이 단톡방에 앉힌 Hub 대여
       * 좌석은 실행 페이로드에 실릴 통로 자체가 없었다(실측: 좌석 2명,
       * 실행 0건, `borrowed_agent_career_runs` 인스턴스 전체 0건).
       * 확정된 로스터가 Hub 좌석을 담고 있으면 그 slug 를 그대로 싣고,
       * 허브 호출을 켠 모드로 시작한다.
       */
      const rosterHubBorrowSlugs = [...new Set(
        preparedOneTeamPreflight.taskForceTargets.flatMap((target) =>
          target.source === "hub" ? [target.slug] : []),
      )];
      invocationRequest = {
        ...invocationRequest,
        runId: preparedOneTeamPreflight.ref.reservedRunId,
        chatId: preparedOneTeamPreflight.chatId,
        userPrompt: preparedOneTeamPreflight.userPrompt,
        oneUserAuthoredPrompt: preparedOneTeamPreflight.userAuthoredPrompt,
        taskIntent: "task",
        oneMode: true,
        permissions: workspaceBinding
          ? preparedOneTeamPreflight.permission
          : authoritativeOnePermission(selectedOnePermissionMode, "task"),
        sessionRouting: false,
        hubMode: preparedOneTeamPreflight.mode === "workforce"
          ? "hub-first"
          : rosterHubBorrowSlugs.length > 0
            ? "hub-allowed"
            : "local-only",
        borrowAgents: rosterHubBorrowSlugs,
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
    const judgedTaskIntent = requestedOneMode
      && invocationRequest.taskIntent === "conversation"
      && classifyOneRequestIntent(invocationRequest.userPrompt, judgedOneRequestIntent) === "task";
    const effectiveTaskIntent: McpInvocationRequest["taskIntent"] = claimedOneAttachments
      ? "task"
      : judgedTaskIntent
        ? "task"
        : invocationRequest.taskIntent;
    const runReq: OneInvocationRequest = {
      ...invocationRequest,
      runId,
      // The resident judge decides "conversation vs task" by meaning: the async
      // invoke paths warm the judgment cache (prejudgeOneRequestIntent) and this
      // sync site peeks it; without a judged verdict the intent remains undecided.
      taskIntent: effectiveTaskIntent,
      ...(!workspaceBinding && requestedOneMode
        ? { permissions: preparedOneBriefingAction
            ? "read"
            : authoritativeOnePermission(selectedOnePermissionMode, effectiveTaskIntent) }
        : {}),
      ...(oneProfileContext ? { oneProfileContext } : {}),
      ...(claimedOneAttachments ? {
        images: claimedOneAttachments.images,
        oneAttachmentContext: claimedOneAttachments.runtimeContext,
        oneAttachmentRedactions: claimedOneAttachments.redactions,
      } : {}),
    };
    const record: RunRecord = {
      controller,
      chatId: req.chatId,
      request: runReq,
      startedAt,
      cancelRequestedAt: null,
      steeringInterruptRequested: false,
      events: [],
      partialText: "",
      resultFolder,
      oneMode: requestedOneMode,
      goal: invocationRequest.userPrompt.slice(0, 4_000),
      pendingQuestion: false,
      ...(questionContinuation
        ? {
            questionContinuationSourceMessageId: questionContinuation.sourceMessageId,
            questionContinuationRequestHash: questionContinuation.requestHash,
          }
        : {}),
      settlementPublished: false,
      observableStepSequence: 0,
      ...(executionContext?.source ? { executionSource: executionContext.source } : {}),
      ...(runWorkspaceBinding ? { workspaceBinding: runWorkspaceBinding } : {}),
    };
    let recoverablePartialPersisted = false;
    const persistRecoverableAssistantPartial = (): void => {
      if (
        recoverablePartialPersisted
        || runReq.agentAppMode
        || remoteWorkspaceBinding
        || !record.partialText.trim()
      ) return;
      try {
        appendChatMessage(
          runReq.chatId,
          "assistant",
          markInterruptedPartial(record.partialText, pickLocale(runReq)),
        );
        recoverablePartialPersisted = true;
      } catch {
        // The durable run ledger remains authoritative for the failure. A
        // secondary transcript write failure must not block run settlement.
      }
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
            onePermissionMode: selectedOnePermissionMode ?? undefined,
            fastMode: runReq.fastMode === true || undefined,
            locale: pickLocale(runReq),
            // Persist the semantic boundary that Main actually received. This
            // makes conversation -> Task promotion auditable without trying to
            // reconstruct it later from human-readable Activity text.
            taskIntent: runReq.taskIntent,
            invocationSource: runWorkspaceBinding?.source,
            synchronousAskSurface: executionContext?.source === "mobile"
              ? "durable-decision"
              : undefined,
            questionContinuationSourceMessageId: questionContinuation?.sourceMessageId,
            questionContinuationRequestHash: questionContinuation?.requestHash,
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
      : remoteWorkspaceBinding
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

    // Publish an authoritative run boundary before the provider produces its
    // first token. Some providers emit no reasoning/tool item for short turns;
    // without this event the Activity surface is blank even though the run is
    // genuinely active. This is a lifecycle fact, never inferred status copy.
    const lifecycleStartSequence = nextObservableSequence(record);
    const lifecycleStartEvent: McpInvocationEvent = {
      kind: "lifecycle",
      lifecycle: {
        phase: "start",
        ...(runReq.permissions ? { permission: runReq.permissions } : {}),
        ...(requestedOneMode && selectedOnePermissionMode ? { selectedPermissionMode: selectedOnePermissionMode } : {}),
        ...(record.resultFolder ? { cwd: record.resultFolder } : {}),
      },
      sequence: lifecycleStartSequence,
      observedAt: new Date().toISOString(),
    };
    recordObservableRunStep(canonicalTask, runId, lifecycleStartEvent, lifecycleStartSequence);
    record.events.push(lifecycleStartEvent);
    recordMcpInvocationEvent(runId, runReq, lifecycleStartEvent);
    this.publishRunEvent(record, { runId, chatId: runReq.chatId, event: lifecycleStartEvent });

    let terminalObserved = false;
    let projectionGoalId = chat.goalId;
    if (!projectionGoalId && runReq.goalMode && (runReq.permissions === "write" || runReq.permissions === "full")) {
      projectionGoalId = resolveDesktopWorkforceGoalId({
        chatGoalId: null,
        projectId: chat.projectId,
        taskId: canonicalTask?.id ?? null,
        chatId: chat.id,
      });
      try {
        const objective = runReq.userPrompt.replace(/\s+/g, " ").trim();
        if (!objective || !ensureGoalLedgerGoal({
          goalId: projectionGoalId,
          objective,
          acceptanceCriteria: deriveGoalAcceptanceCriteria(objective, pickLocale(runReq)),
          projectDir: getChatWorkingFolder(chat.id),
        })) {
          projectionGoalId = null;
        } else {
          setChatGoalBinding(chat.id, projectionGoalId);
        }
      } catch (error) {
        projectionGoalId = null;
        console.warn("[long-run] first Goal materialization failed:", error);
      }
    }
    let goalLongRun = projectionGoalId ? getLongRunByGoalId(projectionGoalId) : null;
    let goalLongRunTask = goalLongRun ? listLongRunTasks(goalLongRun.id, true)[0] ?? null : null;
    let goalInvocationProjection: DesktopLongRunInvocationProjection | null = null;
    const refreshGoalProjection = (): void => {
      goalLongRun = projectionGoalId ? getLongRunByGoalId(projectionGoalId) : null;
      goalLongRunTask = goalLongRun ? listLongRunTasks(goalLongRun.id, true)[0] ?? null : null;
      goalInvocationProjection = goalLongRun && goalLongRunTask
      ? new DesktopLongRunInvocationProjection({
          longRunId: goalLongRun.id,
          taskId: goalLongRunTask.id,
          invocationRunId: runId,
          controllerAgentId: chat.agentId ?? `controller:${chat.id}`,
          workspaceBinding: {
            projectId: chat.projectId,
            cwd: getChatWorkingFolder(chat.id),
            revision: null,
          },
          permissionProfile: runReq.permissions ?? "read",
        })
      : null;
      if (goalInvocationProjection) record.longRunProjection = goalInvocationProjection;
    };
    refreshGoalProjection();
    if (goalLongRun && getChatGoalRevision(goalLongRun.goalId) && !executionContext && !runWorkspaceBinding && goalLongRun.surface !== "science") {
      record.automaticGoalId = goalLongRun.goalId;
      const remaining = Date.parse(goalLongRun.budget.wallclockDeadline ?? "") - Date.now();
      if (Number.isFinite(remaining)) record.automaticGoalDeadline = setTimeout(() => this.cancelWithReason(runId, new Error("automatic_goal_time_budget")), Math.max(1, remaining));
    }
    let goalControllerAttemptId: string | null = null;
    let goalControllerAttemptSettled = false;
    const bindGoalControllerAttempt = (selection: RuntimeSelection): void => {
      if (!goalLongRun || !goalLongRunTask || goalControllerAttemptId || goalControllerAttemptSettled) return;
      const workerId = `controller_${goalLongRun.id}`;
      const source = selection.source === "cloud" || selection.source === "hub" || selection.source === "builtin"
        ? selection.source
        : "local";
      try {
        const adapter = resolveDesktopRuntimeAdapter(selection);
        bindLongRunWorker({
          workerId,
          runId: goalLongRun.id,
          parentWorkerId: null,
          taskId: goalLongRunTask.id,
          role: "controller",
          agentDefinitionId: chat.agentId,
          agentRelease: null,
          runtimeSelection: {
            kind: selection.kind,
            backend: selection.backend ?? null,
            model: selection.model ?? null,
            effort: selection.effort ?? null,
            source,
            capabilityDescriptorId: adapter.id,
          },
          workspaceBinding: {
            projectId: chat.projectId,
            cwd: getChatWorkingFolder(chat.id),
            revision: null,
          },
          permissionProfile: runReq.permissions ?? "read",
          state: "idle",
        });
        goalControllerAttemptId = startLongRunWorkerAttempt({
          runId: goalLongRun.id,
          workerId,
          taskId: goalLongRunTask.id,
          invocationRunId: runId,
          runtimeSelection: {
            kind: selection.kind,
            backend: selection.backend ?? null,
            model: selection.model ?? null,
            effort: selection.effort ?? null,
            source,
            capabilityDescriptorId: adapter.id,
          },
        }).attemptId;
        goalInvocationProjection?.bindController(workerId, chat.agentId ?? `controller:${chat.id}`);
      } catch (error) {
        console.warn("[long-run] controller attempt binding failed:", error);
      }
    };
    const settleGoalControllerAttempt = (completed: boolean): void => {
      if (!goalControllerAttemptId || goalControllerAttemptSettled) return;
      goalControllerAttemptSettled = true;
      settleLongRunWorkerAttempt({
        attemptId: goalControllerAttemptId,
        state: completed ? "completed" : "interrupted",
        sideEffectState: completed ? "committed" : "uncertain",
        ...(!completed
          ? { errorCode: controller.signal.aborted ? "cancelled" : "runtime_interrupted" }
          : {}),
      });
      goalInvocationProjection?.settleOpenWorkers(completed);
    };
    /*
     * 권한 승격 표식(오너 결정 2026-08-25) — 읽기 전용 실행이 쓰기를 만나 표식을 냈는가.
     * 표식은 본문에서 지워지고, 완주한 뒤 그 대화 안 승인칩으로 "전체 액세스로
     * 진행할까요?"를 묻는다. 대화가 붙은 사용자 실행에서만 — 사이트/모바일 경계와
     * 헤드리스(사전 부여) 경로는 기존 결정 그대로 둔다.
     */
    let permissionEscalationRequested = false;
    const permissionEscalationEligible =
      !runReq.agentAppMode
      && !runWorkspaceBinding
      && Boolean(runReq.chatId)
      && (runReq.permissions ?? "read") === "read";
    void runMcpInvocation(
      runReq,
      (rawEvent) => {
        rawEvent = redactMcpInvocationEventSecrets(redactOneAttachmentEvent(runReq, rawEvent));
        // One provider/run gets one terminal settlement. Late duplicate finals,
        // EOF callbacks, and post-cancel deliveries cannot reopen a Decision.
        if (terminalObserved && (rawEvent.kind === "final" || rawEvent.kind === "error")) return;
        if (rawEvent.kind === "final" && controller.signal.aborted) return;
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
        if (
          event.runtimeSelection
          && !event.agentId
          && (!event.modelRole || event.modelRole === "orchestrator")
        ) {
          bindGoalControllerAttempt(event.runtimeSelection);
        }
        /*
         * 권한 승격 표식은 사용자에게 보여줄 문장이 아니다 — 감지 즉시 화면·기록
         * 본문에서 지우고, 그 사실만 남겨 완주 후 승인칩이 잇는다. 부분 스트림과
         * 최종 본문을 같은 함수로 지워 델타 좌표계가 갈라지지 않게 한다.
         */
        if (
          permissionEscalationEligible
          && !event.agentId
          && (event.kind === "final" || event.kind === "partial")
          && typeof event.text === "string"
          && hasPermissionEscalationMarker(event.text)
        ) {
          if (event.kind === "final") permissionEscalationRequested = true;
          event = { ...event, text: stripPermissionEscalationMarker(event.text) };
        }
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

        // Some native runtimes persist the assistant row and then emit a
        // content-free final signal. The durable transcript is the canonical
        // answer in that ordering; using the empty transport event would lose
        // both the Decision and the waiting-decision task state on restart.
        if (event.kind === "final" && !(event.text ?? "").trim()) {
          const durableFinal = latestDurableAssistantMessage(runReq.chatId, startedAt);
          if (durableFinal?.text.trim()) {
            const durableText = stripPermissionEscalationMarker(durableFinal.text);
            const hygiene = applyFinalDisplayBackstop(durableText, {
              locale: pickLocale(runReq),
              allowSurfaceRender: !runReq.agentAppMode,
            });
            event = {
              ...event,
              text: hygiene.text,
              durableTextForVerification: durableText,
              durableAssistantMessageIdForVerification: durableFinal.id,
              ...(hygiene.userDecisionRequest
                ? {
                    userDecisionRequest: {
                      ...hygiene.userDecisionRequest,
                      sourceMessageId: durableFinal.id,
                    },
                  }
                : {}),
            };
          }
        }
        const terminalRequestsDecision = invocationEventRequestsDecision(event);
        if (terminalRequestsDecision) {
          record.pendingQuestion = true;
          if (event.userDecisionRequest) record.userDecisionRequest = event.userDecisionRequest;
        }
        if (!taskMaterialized && (invocationEventPromotesTask(event) || terminalRequestsDecision)) {
          tryRecordRunEvent({
            runId,
            kind: "task_promotion_requested",
            chatId: runReq.chatId,
            agentId: attributedAgentId ?? record.actualAgentId,
            payload: {
              cause: terminalRequestsDecision
                ? "decision_request"
                : event.kind === "surface"
                  ? "surface"
                  : event.phase === "delegate" || (event.tier ?? 1) > 1
                    ? "delegation"
                    : "tool_execution",
              eventKind: event.kind,
              toolName: event.tool?.name,
              phase: event.phase,
              tier: event.tier,
            },
          });
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

        let decisionTerminalCommitted = false;
        if (terminalRequestsDecision && event.kind === "final") {
          // The assistant Decision row is already durable. Seal the companion
          // waiting Task and completion receipt in one SQLite transaction
          // before either surface is published, so a crash cannot expose a
          // Decision whose Task still says partial/running (or vice versa).
          const sealDecision = getDb().transaction(() => {
            canonicalTask = trySetTaskStatus(
              runReq.chatId,
              "waiting-decision",
              true,
              invocationOrigin,
            );
            if (!canonicalTask) throw new Error("decision-task-projection-failed");
            taskMaterialized = true;
            recordRunEvent({
              runId,
              kind: "invoke_completed",
              chatId: runReq.chatId,
              agentId: attributedAgentId ?? record.actualAgentId,
              payload: { resultFolder: record.resultFolder, decisionRequested: true },
            });
          });
          sealDecision.immediate();
          decisionTerminalCommitted = true;
        }

        const rawSurfaceForArtifactBinding = event.kind === "surface" ? event.surface : undefined;
        // Desktop Work owns and consumes its native Work surface. Only One or
        // the separately bounded Mobile bridge receives the closed One/Mobile
        // semantic projection; ordinary project work must not mint One state.
        if (requestedOneMode || remoteWorkspaceBinding) {
          event = attachOneSurfaceProjection(event, runReq.chatId);
        }
        if (event.oneFriendlyFollowups) {
          // The plan is an untrusted model proposal used only by the Main
          // projection boundary. One and Mobile receive semantic actions only.
          event = { ...event, oneFriendlyFollowups: undefined };
        }
        if (event.kind === "surface" && event.oneSurface) {
          const projectedSurface = event.oneSurface;
          const durableSurfaceRecorded = tryRecordDurableOneSurfaceResult({
            runId,
            chatId: runReq.chatId,
            manifest: projectedSurface,
          });
          // Task-force execution persists the visible user turn after the run
          // starts. Chat-to-Task reconciliation can therefore advance the
          // canonical version while this service still holds its run-start
          // object. Surface persistence and filesystem sealing must share one
          // fresh exact version; a stale fallback would make the binder reject
          // an otherwise valid result (or attest the wrong Task version).
          const surfaceTask = findCanonicalTaskForChat(runReq.chatId);
          if (surfaceTask) canonicalTask = surfaceTask;
          if (durableSurfaceRecorded && surfaceTask && projectedSurface.taskId === surfaceTask.id) {
            if (rawSurfaceForArtifactBinding) {
              const boundArtifactCount = bindOneSurfaceArtifacts({
                rawManifest: rawSurfaceForArtifactBinding,
                surface: projectedSurface,
                taskId: surfaceTask.id,
                taskVersion: surfaceTask.version,
                chatId: runReq.chatId,
                runId,
                createdAt: projectedSurface.surfaceState.lastSyncedAt,
                runStartedAt: record.startedAt,
              });
              const droppedArtifactCount = removeUnboundOneSurfaceArtifacts(projectedSurface);
              if (boundArtifactCount > 0 || droppedArtifactCount > 0) {
                tryRecordDurableOneSurfaceResult({
                  runId,
                  chatId: runReq.chatId,
                  manifest: projectedSurface,
                });
                event = {
                  ...event,
                  oneArtifacts: projectedSurface.fallback.artifacts
                    .filter((artifact) => artifact.verificationStatus === "verified")
                    .map((artifact) => ({
                      taskId: surfaceTask.id,
                      taskVersion: surfaceTask.version,
                      chatId: runReq.chatId,
                      runId,
                      manifestId: projectedSurface.manifestId,
                      artifactRef: artifact.artifactRef,
                      label: artifact.label,
                      type: artifact.type,
                      ...(typeof artifact.sizeBytes === "number" ? { sizeBytes: artifact.sizeBytes } : {}),
                    })),
                };
              }
            }
            tryRecordOneDomainEvent({
              eventType: "result.manifest_ready",
              occurredAt: projectedSurface.surfaceState.lastSyncedAt ?? new Date().toISOString(),
              actor: "system",
              entityId: surfaceTask.id,
              ...(surfaceTask.projectId ? { projectId: surfaceTask.projectId } : {}),
              taskId: surfaceTask.id,
              version: surfaceTask.version,
              visibility: domainVisibility(surfaceTask),
              entries: [
                { name: "manifestId", value: projectedSurface.manifestId },
                { name: "contractVersion", value: projectedSurface.contractVersion },
                { name: "artifactRefs", value: projectedSurface.fallback.artifacts.map((item) => item.artifactRef) },
              ],
            });
            recordManifestArtifactEvidence(surfaceTask, projectedSurface);
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
        if ((requestedOneMode || remoteWorkspaceBinding) && event.kind === "surface" && event.surface) {
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

        const observableStepSequence = nextObservableSequence(record);
        event = {
          ...event,
          sequence: observableStepSequence,
          observedAt: new Date().toISOString(),
        };
        const durableTextForVerification = event.durableTextForVerification;
        const durableMessageId = event.durableAssistantMessageIdForVerification;
        // Preserve only the opaque committed-message identity for history
        // catch-up. The body used to verify it remains Main-only.
        if (
          durableTextForVerification !== undefined
          || event.durableAssistantMessageIdForVerification !== undefined
        ) {
          event = {
            ...event,
            ...(durableMessageId ? { durableMessageId } : {}),
            durableTextForVerification: undefined,
            durableAssistantMessageIdForVerification: undefined,
          };
        }
        if (goalInvocationProjection) {
          try {
            goalInvocationProjection.observe(event);
          } catch (error) {
            console.warn("[long-run] child worker projection failed:", error);
          }
        }
        if (
          event.kind === "final"
          && !runReq.agentAppMode
          && !remoteWorkspaceBinding
          && typeof event.text === "string"
          && event.text.trim()
          && !hasDurableAssistantMessage(
            runReq.chatId,
            typeof durableTextForVerification === "string" && durableTextForVerification.trim()
              ? durableTextForVerification
              : stripPermissionEscalationMarker(event.text),
            startedAt,
          )
        ) {
          // A native/IO failure can occur between model completion and the
          // transcript write. Never publish or ledger a successful completion
          // unless reopening this chat can read the exact result back.
          event = {
            kind: "error",
            runtimeAgentId: record.actualAgentId,
            error: {
              code: "result-not-durable",
              message: "The response finished but its saved result could not be verified.",
            },
            sequence: observableStepSequence,
            observedAt: event.observedAt,
          };
        }
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
        } else if (
          event.kind === "reasoning" && event.reasoning?.phase === "delta"
          && last?.kind === "reasoning" && last.reasoning?.phase === "delta"
          && (last.agentId ?? null) === (event.agentId ?? null)
        ) {
          // Thought text streams token by token (Claude thinking can be
          // thousands of deltas). The replay buffer keeps one merged delta per
          // span so tool rows are never evicted by think-time chatter; the wire
          // still gets each delta live.
          record.events[record.events.length - 1] = {
            ...event,
            reasoning: {
              ...event.reasoning,
              text: `${last.reasoning?.text ?? ""}${event.reasoning.text ?? ""}`.slice(0, 6_000),
            },
          };
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
        if (event.kind === "final" && !decisionTerminalCommitted) {
          // This throwing insert is the publication gate. tryRecordRunEvent is
          // intentionally not used: a renderer-visible completion without a
          // durable terminal receipt would become "running"/missing after a
          // restart even though the user already saw success.
          recordRunEvent({
            runId,
            kind: "invoke_completed",
            chatId: runReq.chatId,
            agentId: attributedAgentId ?? record.actualAgentId,
            payload: { resultFolder: record.resultFolder },
          });
        }
        recordMcpInvocationEvent(runId, runReq, event);
        this.publishRunEvent(record, { runId, chatId: runReq.chatId, event: wireEvent });

        if (event.kind === "final" || event.kind === "error") {
          // A streamed answer is user-visible work even if the runtime later
          // fails (hook error, transport loss, crash, or explicit cancel). The
          // renderer already keeps that bubble; persist the same partial so a
          // history refresh cannot make it disappear. Browser Agent Apps and
          // bounded remote workspaces retain their stricter isolation rules.
          if (event.kind === "error") persistRecoverableAssistantPartial();
          const terminalKind =
            event.kind === "final"
              ? "invoke_completed"
              : record.steeringInterruptRequested
                ? "invoke_interrupted"
                : controller.signal.aborted
                ? "invoke_cancelled"
              : "invoke_failed";
          settleGoalControllerAttempt(terminalKind === "invoke_completed");
          canonicalTask = trySetTaskStatus(
            runReq.chatId,
            terminalTaskStatus({
              kind: event.kind,
              requestsDecision: terminalRequestsDecision,
              cancelled: controller.signal.aborted && !record.steeringInterruptRequested,
              interrupted: record.steeringInterruptRequested,
              hasPartialText: Boolean(record.partialText.trim()),
            }),
            taskMaterialized,
            invocationOrigin,
          );
          taskMaterialized = Boolean(canonicalTask);
          terminalObserved = true;
          if (terminalKind !== "invoke_completed") {
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
          }
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
          if (
            permissionEscalationRequested
            && terminalKind === "invoke_completed"
            && !controller.signal.aborted
          ) {
            /*
             * 완주한 읽기 전용 턴이 쓰기 승격을 표식으로 요청했다 — 그 대화 안에서
             * 기존 승인칩 한 벌로 묻는다. 승인 없이는 아무것도 승격되지 않는다.
             */
            void this.offerPermissionEscalation({
              chatId: runReq.chatId,
              agentId: record.actualAgentId,
              oneMode: requestedOneMode,
              locale: pickLocale(runReq),
            });
          }
          if (this.activeRuns.settle(runId)) this.publishActiveChats();
        }
      },
      controller.signal,
      runWorkspaceBinding,
      executionContext,
      async (sourceMessageId) => {
        // Only ordinary local, user-authored root-chat work enters automatic
        // Goal. Science and remote/automation authority keep their own adapters.
        if (projectionGoalId || runReq.agentAppMode || runWorkspaceBinding || executionContext ||
            runReq.promptOrigin === "system" || runReq.planMode || chat.kind === "division" || controller.signal.aborted) return;
        try {
          const admitted = await prepareInvocationAutomaticGoal({ runId, chatId: chat.id, sourceMessageId,
            userPrompt: runReq.userPrompt, permission: runReq.permissions ?? "read", signal: controller.signal });
          if (!admitted || controller.signal.aborted) return;
          projectionGoalId = admitted.goalId;
          record.automaticGoalId = admitted.goalId;
          transitionLongRun({ runId: admitted.id, to: "running", actorKind: "host", reason: "automatic-goal-user-dispatch" });
          refreshGoalProjection();
          setChatGoalBinding(chat.id, admitted.goalId);
          const goalEvent: McpInvocationEvent = { kind: "tool-use", tool: { name: "Goal", result:
            `${admitted.objective}\n\n${admitted.acceptanceCriteria.map((criterion) => `• ${criterion}`).join("\n")}\n\n` +
            (pickLocale(runReq) === "ko" ? "최대 3회 실행 · 10분 후 미완료 목표는 유지합니다. 금액 사용량은 아직 계측되지 않습니다." :
              "Up to 3 passes / 10 minutes; unfinished criteria are retained. Monetary usage is not yet metered.") } };
          record.events.push(goalEvent);
          recordMcpInvocationEvent(runId, runReq, goalEvent);
          this.publishRunEvent(record, { runId, chatId: chat.id, event: goalEvent });
          const remaining = Date.parse(admitted.budget.wallclockDeadline!) - Date.now();
          record.automaticGoalDeadline = setTimeout(() => this.cancelWithReason(runId, new Error("automatic_goal_time_budget")), Math.max(1, remaining));
        } catch {
          tryRecordRunEvent({ runId, chatId: chat.id, kind: "automatic_goal_binding_failed", payload: { sourceMessageId } });
          // Goal enrichment failure must never swallow the original request.
        }
      },
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
        const completionClaim = result.goalCompletionClaim ?? (record.automaticGoalId && !record.pendingQuestion && !controller.signal.aborted
          ? { claimed: true, goalId: record.automaticGoalId, evidence: "Automatic Goal: verify the durable terminal result against all criteria." }
          : undefined);
        if (completionClaim?.claimed && completionClaim.goalId) {
          // The client records only a verification request. The independent
          // judge starts here, after invoke_completed/mcp_final and the result
          // receipt are durable, so model prose can never outrun host evidence.
          this.pendingGoalVerifications.set(runId, record);
          this.publishActiveChats();
          void import("../long-run/verifier")
            .then(({ verifyGoalCompletionClaim }) => verifyGoalCompletionClaim({
              goalId: completionClaim.goalId!,
              signal: controller.signal,
              outcomeText: result.finalText?.trim() || "Completion claimed without result text.",
              evidence: completionClaim.evidence,
              invocationRunId: runId,
              projectDir: getChatWorkingFolder(chat.id),
            }))
            .then((verification) => {
              if (!record.automaticGoalId || controller.signal.aborted) return;
              if (verification?.completed) {
                completeChatGoalContract(record.automaticGoalId, "completed");
                if (getChat(chat.id)?.goalId === record.automaticGoalId) setChatGoalBinding(chat.id, null);
              } else {
                const current = getLongRunByGoalId(record.automaticGoalId);
                if (current && ["running", "verifying"].includes(current.status)) transitionLongRun({ runId: current.id, to: "blocked", actorKind: "host", reason: "verification_inconclusive" });
              }
            })
            .catch((error: unknown) => {
              console.warn("[long-run] terminal verification failed:", error);
              if (record.automaticGoalId && !controller.signal.aborted) {
                const current = getLongRunByGoalId(record.automaticGoalId);
                if (current && ["running", "verifying"].includes(current.status)) {
                  transitionLongRun({ runId: current.id, to: "blocked", actorKind: "host", reason: "verification_unavailable" });
                }
              }
            })
            .finally(() => {
              this.pendingGoalVerifications.delete(runId);
              this.publishActiveChats();
              if (record.automaticGoalDeadline) clearTimeout(record.automaticGoalDeadline);
              this.settleAutomaticGoalInterruption(record);
              this.drainSteerQueue(record.chatId);
            });
        }
      })
      .catch((error: unknown) => {
        settleGoalControllerAttempt(false);
        if (record.automaticGoalId && !controller.signal.aborted) {
          try {
            const current = getLongRunByGoalId(record.automaticGoalId);
            if (current && ["queued", "running", "waiting_worker", "waiting_tool"].includes(current.status)) {
              transitionLongRun({ runId: current.id, to: "blocked", actorKind: "host", reason: "invocation_failed" });
            }
          } catch { /* Keep the original provider failure visible. */ }
        }
        const rawMessage = redactOneAttachmentText(
          runReq,
          error instanceof Error ? error.message : String(error),
        );
        const safeFailure = runReq.agentAppMode
          ? untrustedRuntimeFailurePayload()
          : { code: record.steeringInterruptRequested ? "interrupted" : controller.signal.aborted ? "cancelled" : "invoke-threw", message: rawMessage };
        const message = safeFailure.message;
        tryRecordRunEvent({
          runId,
          kind: "invoke_threw",
          chatId: runReq.chatId,
          agentId: record.actualAgentId,
          payload: { errorMessage: message },
        });
        if (!record.steeringInterruptRequested) {
          tryRecordFailureEvent({
            runId,
            source: "invoke",
            chatId: runReq.chatId,
            agentId: record.actualAgentId,
            errorCode: safeFailure.code,
            errorMessage: message,
          });
        }
        if (!terminalObserved) {
          terminalObserved = true;
          canonicalTask = trySetTaskStatus(
            runReq.chatId,
            record.steeringInterruptRequested ? "partial" : controller.signal.aborted ? "cancelled" : "failed",
            taskMaterialized,
            invocationOrigin,
          );
          taskMaterialized = Boolean(canonicalTask);
          persistRecoverableAssistantPartial();
          const observableStepSequence = nextObservableSequence(record);
          const event: McpInvocationEvent = {
            kind: "error",
            runtimeAgentId: record.actualAgentId,
            error: safeFailure,
            sequence: observableStepSequence,
            observedAt: new Date().toISOString(),
          };
          record.events.push(event);
          recordMcpInvocationEvent(runId, runReq, event);
          this.publishRunEvent(record, { runId, chatId: runReq.chatId, event });
          const terminalKind = record.steeringInterruptRequested
            ? "invoke_interrupted" as const
            : controller.signal.aborted ? "invoke_cancelled" as const : "invoke_failed" as const;
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
        if (record.automaticGoalDeadline && !this.pendingGoalVerifications.has(runId)) clearTimeout(record.automaticGoalDeadline);
        settleGoalControllerAttempt(false);
        if (!this.pendingGoalVerifications.has(runId)) this.settleAutomaticGoalInterruption(record);
        if (!terminalObserved) {
          canonicalTask = trySetTaskStatus(
            runReq.chatId,
            record.steeringInterruptRequested ? "partial" : controller.signal.aborted ? "cancelled" : "failed",
            taskMaterialized,
            invocationOrigin,
          );
          taskMaterialized = Boolean(canonicalTask);
          const terminalKind = record.steeringInterruptRequested
            ? "invoke_interrupted" as const
            : controller.signal.aborted ? "invoke_cancelled" as const : "invoke_failed" as const;
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

  /**
   * 읽기 전용 턴이 표식으로 요청한 권한 승격 — 오너 결정 2026-08-25.
   *
   * "권한이 모자라 실행 불가"는 거절이 아니라 행동 시점 승인칩으로 승격을 묻는다.
   * 기존 승인 한 벌(중재자 → capability_grants 규칙 → 그 대화 안 live 칩)을 그대로
   * 지난다 — 새 승인 채널은 없다. "항상 허용"은 tool:permission-escalation 영구
   * 규칙으로 남고, 무응답은 기존 계약대로 5분 뒤 거부로 닫힌다(자동 승격 없음).
   * 승인되면 같은 대화에 Main 발행(system) 연속 턴을 전체 액세스로 시작한다.
   * 거부되면 아무것도 더 하지 않는다 — 모델이 남긴 "쓰기가 필요하다" 문장이 곧
   * 정직한 거절 기록이고, 원 실행의 결과는 그대로 선다.
   */
  private async offerPermissionEscalation(input: {
    chatId: string;
    agentId?: string;
    oneMode: boolean;
    locale: "ko" | "en";
  }): Promise<void> {
    const arbiter = getRuntimeToolPermissionArbiter();
    if (!arbiter) return; // 물을 관문이 없으면 승격도 없다 — fail-closed.
    let allowed = false;
    try {
      allowed = (await arbiter({
        runtime: "agentlas",
        sessionKey: `permission-escalation:${input.chatId}`,
        tool: PERMISSION_ESCALATION_TOOL,
        kind: "escalate",
        permission: "read",
        mutating: true,
        chatId: input.chatId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      })) !== "deny";
    } catch {
      return; // 중재자 실패는 거부다 — 실패가 승격이 되면 관문이 아니다.
    }
    if (!allowed) return;
    const continuation = input.locale === "ko"
      ? "전체 액세스가 승인되었다. 방금 권한이 없어 멈춘 작업을 이어서 완료하라."
      : "Full access has been approved. Continue and finish the work that was blocked by the read-only permission.";
    try {
      this.start({
        chatId: input.chatId,
        userPrompt: continuation,
        promptOrigin: "system",
        taskIntent: "task",
        permissions: "full",
        ...(input.oneMode ? { oneMode: true, onePermissionMode: "full" } : {}),
      } as McpInvocationRequest);
    } catch {
      // 재개 시작 실패는 승격 기회를 잃을 뿐이다 — 다음 요청 때 칩이 다시 묻는다.
    }
  }

  private settleAutomaticGoalInterruption(record: RunRecord): void {
    if (!record.automaticGoalId || !record.controller.signal.aborted) return;
    try {
      const current = getLongRunByGoalId(record.automaticGoalId);
      if (current && ["pausing", "cancelling"].includes(current.status)) {
        const next = transitionLongRun({ runId: current.id, to: current.status === "cancelling" ? "cancelled" : "paused", actorKind: "host",
          reason: record.controller.signal.reason instanceof Error && record.controller.signal.reason.message === "automatic_goal_time_budget" ? "budget" : "user" });
        if (next.status === "cancelled") {
          completeChatGoalContract(next.goalId, "cancelled");
          if (getChat(record.chatId)?.goalId === next.goalId) setChatGoalBinding(record.chatId, null);
        }
      }
    } catch { /* Requested stop remains durable and non-admitting. */ }
  }

  cancel(runId: string): "requested" | "already-requested" | "not-found" {
    return this.cancelWithReason(runId, new Error("stopped_by_user"));
  }

  private cancelWithReason(
    runId: string,
    reason: Error,
  ): "requested" | "already-requested" | "not-found" {
    const record = this.activeRuns.get(runId) ?? this.pendingGoalVerifications.get(runId);
    if (record?.automaticGoalId) {
      try {
        const goal = getLongRunByGoalId(record.automaticGoalId);
        if (goal && !["completed", "failed", "cancelled", "cancelling", "paused"].includes(goal.status)) {
          transitionLongRun({ runId: goal.id,
            to: reason.message === "stopped_by_user" ? "cancelling" : "pausing",
            actorKind: reason.message === "stopped_by_user" ? "user" : "host",
            reason: reason.message === "automatic_goal_time_budget" ? "budget" : "user" });
        }
      } catch { /* Always abort the actual invocation even if persistence fails. */ }
    }
    // Stop is terminal for the visible work item: it also clears directions
    // queued behind the active turn. Steering itself never calls cancel.
    if (record?.chatId) {
      this.steerQueues.delete(record.chatId);
      cancelQueuedSteersForChat(record.chatId);
    }
    let result = this.activeRuns.requestCancelWithReason(runId, reason);
    if (result === "not-found" && record && this.pendingGoalVerifications.has(runId)) {
      result = record.controller.signal.aborted ? "already-requested" : "requested";
      record.cancelRequestedAt ??= new Date().toISOString();
      record.controller.abort(reason);
    }
    if (result === "requested") {
      if (record) {
        const sequence = nextObservableSequence(record);
        const cancelEvent: McpInvocationEvent = {
          kind: "lifecycle",
          lifecycle: { phase: "cancel_requested" },
          sequence,
          observedAt: record.cancelRequestedAt ?? new Date().toISOString(),
        };
        record.events.push(cancelEvent);
        this.publishRunEvent(record, { runId, chatId: record.chatId, event: cancelEvent });
      }
      tryRecordRunEvent({
        runId,
        kind: "invoke_cancel_requested",
        chatId: record?.chatId,
        payload: { requestedAt: record?.cancelRequestedAt },
      });
    }
    return result;
  }

  /** Interrupt an interactive turn only after its replacement direction is durable. */
  private interruptForSteer(runId: string, record: RunRecord): boolean {
    const locale = pickLocale(record.request);
    const result = this.activeRuns.requestCancelWithReason(
      runId,
      new Error(locale === "ko"
        ? "새 지시를 반영하기 위해 이전 실행을 중단했습니다."
        : "The previous run was interrupted to apply the new direction."),
    );
    if (result !== "requested") return result === "already-requested" && record.steeringInterruptRequested;
    record.steeringInterruptRequested = true;
    const sequence = nextObservableSequence(record);
    const cancelEvent: McpInvocationEvent = {
      kind: "lifecycle",
      lifecycle: { phase: "cancel_requested" },
      sequence,
      observedAt: record.cancelRequestedAt ?? new Date().toISOString(),
    };
    record.events.push(cancelEvent);
    this.publishRunEvent(record, { runId, chatId: record.chatId, event: cancelEvent });
    tryRecordRunEvent({
      runId,
      kind: "invoke_cancel_requested",
      chatId: record.chatId,
      agentId: record.actualAgentId,
      payload: { requestedAt: record.cancelRequestedAt, reason: "steering" },
    });
    return true;
  }

  /** DESKTOP_MOBILE_BRIDGE: main owns steering so every client gets identical resume semantics. */
  steer(
    req: McpInvocationRequest,
    expectedRunId?: string,
    workspaceBinding?: InvocationWorkspaceBinding,
    executionContext?: InvocationExecutionContext,
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
        chatId: req.chatId,
        queued: false,
        interruptsCurrent: false,
        runId: this.start({ ...steerRequest, runId: undefined }, workspaceBinding, executionContext).runId,
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
    const durable = persistQueuedSteer({
      chatId: req.chatId,
      originalRunId: active[0],
      request: { ...steerRequest, runId: undefined },
      ...(workspaceBinding ? { workspaceBinding: immutableWorkspaceBinding(workspaceBinding) } : {}),
      ...(executionContext ? { executionContext } : {}),
    });
    queue.push({
      id: durable.id,
      originalRunId: durable.originalRunId,
      promptHash: durable.promptHash,
      request: durable.request,
      queuedAt: durable.queuedAt,
      ...(durable.workspaceBinding ? { workspaceBinding: durable.workspaceBinding } : {}),
      ...(durable.executionContext ? { executionContext: durable.executionContext } : {}),
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
    // Interactive One/Work steering settles the old one-shot process after the
    // replacement is durable. Other callers retain additive queue semantics.
    const interruptsCurrent = req.steeringMode === "interrupt"
      ? this.interruptForSteer(active[0], active[1])
      : false;
    return {
      accepted: true,
      chatId: req.chatId,
      queued: true,
      interruptsCurrent,
      activeRunId: active[0],
      position: queue.length,
      queuedRequestId: durable.id,
      promptHash: durable.promptHash,
    };
  }

  /**
   * Remove a queued (not yet started) direction. Codex lets the user pull a
   * queued message back before the model receives it; the Desktop strip offers
   * the same. Removal is by 1-based position and exact text so a stale click
   * cannot pull a different, later-queued direction. Returns false when nothing
   * matched (already started, already cleared by stop, or already removed).
   */
  unsteer(chatId: string, position: number, text: string): boolean {
    const queue = this.steerQueues.get(chatId);
    if (!queue?.length) return false;
    const index = position - 1;
    if (index < 0 || index >= queue.length) return false;
    if (queue[index].request.userPrompt !== text) return false;
    settleQueuedSteer(queue[index].id, "cancelled");
    queue.splice(index, 1);
    if (!queue.length) this.steerQueues.delete(chatId);
    return true;
  }

  attach(chatId: string): InvocationAttachResult | null {
    let found: InvocationAttachResult | null = null;
    for (const [runId, record] of new Map([...this.pendingGoalVerifications, ...this.activeRuns.entries()])) {
      if (record.chatId === chatId) {
        found = {
          runId,
          events: record.events.slice(),
          startedAt: record.startedAt,
          queuedSteers: (this.steerQueues.get(chatId) ?? []).map((queued, index) => ({
            text: queued.request.userPrompt,
            queuedAt: queued.queuedAt,
            position: index + 1,
          })),
        };
      }
    }
    return found;
  }

  receipt(runId: string): InvocationRunReceipt | null {
    const record = this.activeRuns.get(runId) ?? this.pendingGoalVerifications.get(runId);
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
    for (const [runId, record] of new Map([...this.pendingGoalVerifications, ...this.activeRuns.entries()])) {
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

  private publishAgentResidencyChange(change: AgentResidencyChange): void {
    if (!change.chatId || !change.agentId) return;
    for (const [runId, record] of this.activeRuns.entries()) {
      if (record.chatId !== change.chatId) continue;
      const locale = pickLocale(record.request);
      if (record.oneMode) {
        // PRD §3.5 — `closed` 는 프로세스 실패만 뜻하지 않는다. 유휴 회수(reaped)·풀 축출(evicted)·
        // 앱 종료(shutdown)·턴 종료(turn-complete)도 같은 상태로 온다. 사유를 보지 않고 전부
        // 실패로 적었기 때문에, 일을 끝낸 팀원이 조직도에 "실행 실패"로 남아 있었다.
        // 문구도 한국어 하드코딩이라 영어 사용자는 아무 말도 못 봤다.
        const closedIsFailure = change.state === "closed"
          && !["reaped", "evicted", "shutdown", "turn-complete"].includes(change.reason);
        const statusKind = change.state === "running"
          ? "working"
          : closedIsFailure ? "failed" : "quiet";
        const statusLine = change.state === "running"
          ? (locale === "ko" ? "지금 작업 중" : "Working now")
          : closedIsFailure
            ? (locale === "ko" ? "실패 · 확인 필요" : "Failed · review needed")
            : (locale === "ko" ? "최근 작업 완료" : "Recently completed");
        setOneOrgMemberStatus({
          installedAgentId: change.agentId,
          statusKind,
          statusLine,
          ...(change.state === "running" ? { unreadCount: 0 } : {}),
          lastActivityAt: new Date().toISOString(),
        });
      }
      const status = change.state === "running"
        ? locale === "ko" ? "CLI 프로세스 실행 중" : "CLI process running"
        : change.state === "idle"
          ? locale === "ko" ? "CLI 프로세스 대기 중" : "CLI process idle"
          : locale === "ko" ? "CLI 프로세스 닫힘" : "CLI process closed";
      const displayAgentId = change.nodeId ?? change.agentId;
      const sequence = nextObservableSequence(record);
      const event: McpInvocationEvent = {
        kind: "tool-use",
        status,
        agentId: displayAgentId,
        runtimeAgentId: change.agentId,
        nodeId: displayAgentId,
        agentName: displayAgentId,
        agentLifecycle: {
          source: "cli-process",
          state: change.state,
          reason: change.reason,
          runtime: change.runtimeKind,
        },
        sequence,
        observedAt: new Date().toISOString(),
      };
      record.events.push(event);
      if (record.events.length > MAX_BUFFERED_EVENTS) {
        record.events.splice(0, record.events.length - MAX_BUFFERED_EVENTS);
      }
      recordMcpInvocationEvent(runId, record.request, event);
      if (record.longRunProjection) {
        try {
          record.longRunProjection.observe(event);
        } catch (error) {
          console.warn("[long-run] resident worker projection failed:", error);
        }
      }
      this.publishRunEvent(record, { runId, chatId: record.chatId, event });
    }
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

  private publishRunEvent(record: RunRecord, envelope: InvocationEventEnvelope): void {
    const scienceDelivery = record.executionSource === "science"
      ? recordScienceRuntimeOutboxEvent({ runId: envelope.runId, chatId: envelope.chatId, event: envelope.event })
      : undefined;
    this.publishEvent(scienceDelivery ? { ...envelope, scienceDelivery } : envelope);
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
      ...(record.oneMode && record.actualAgentId ? { agentId: record.actualAgentId } : {}),
      receipt,
      oneMode: record.oneMode,
      pendingQuestion: record.pendingQuestion,
      ...(record.userDecisionRequest ? { userDecisionRequest: record.userDecisionRequest } : {}),
      goal: record.goal,
      ...(record.workspaceBinding ? { workspaceBinding: record.workspaceBinding } : {}),
    };
    if (record.oneMode && record.actualAgentId) {
      const failed = receipt.status === "failed" || receipt.status === "cancelled" || receipt.status === "interrupted";
      const creditBlocked = receipt.errorCode === "insufficient_credits" || /insufficient[_ -]?credits/i.test(receipt.errorMessage || "");
      cacheOneOrgCompletionSummary({ installedAgentId: record.actualAgentId, runId });
      // PRD §3.5 — 사람이 읽는 문구는 로케일 표에서 가져온다. 내부 오류 코드는 사용자 문장에
      // 붙이지 않는다(코드는 영수증에 이미 있고, 화면에서는 뜻을 못 준다).
      const settleLocale = pickLocale(record.request);
      const statusLine = failed
        ? creditBlocked
          ? (settleLocale === "ko" ? "크레딧 부족" : "Out of credits")
          : (settleLocale === "ko" ? "실패 · 확인 필요" : "Failed · review needed")
        : (settleLocale === "ko" ? "최근 작업 완료" : "Recently completed");
      setOneOrgMemberStatus({
        installedAgentId: record.actualAgentId,
        statusKind: failed ? "failed" : record.pendingQuestion ? "waiting" : "quiet",
        statusLine,
        unreadCount: failed ? 0 : 1,
        // PRD §4.29 — 부족만 적고 성공 때 아무것도 안 보내면, 조직도가 옛 값을 그대로 유지해
        // 충전 후에도 "크레딧 부족"이 영영 남았다. 성공 정산은 상태를 정상으로 되돌린다.
        creditState: creditBlocked ? ("insufficient" as const) : ("ok" as const),
        ...(record.pendingQuestion ? { pendingCount: 1, pendingKind: "input" as const } : { pendingCount: 0 }),
        lastActivityAt: receipt.finishedAt || receipt.updatedAt,
      });
    }
    for (const listener of this.settledListeners) {
      try {
        void Promise.resolve(listener(envelope)).catch(() => undefined);
      } catch {
        // Recovery and projection listeners can never alter terminal durability.
      }
    }
  }

  private drainSteerQueue(chatId: string): void {
    if (this.activeChatIds().includes(chatId)) return;
    const queue = this.steerQueues.get(chatId);
    if (!queue?.length) return;
    const next = queue.shift();
    if (!queue.length) this.steerQueues.delete(chatId);
    if (!next) return;
    queueMicrotask(() => {
      const drainedRunId = next.drainedRunId ?? randomUUID();
      try {
        if (!beginQueuedSteerDrain(next.id, drainedRunId)) return;
        if (!hasInvocationRunReceipt(drainedRunId)) {
          this.start(
            { ...next.request, runId: drainedRunId },
            next.workspaceBinding,
            next.executionContext,
          );
        }
        settleQueuedSteer(next.id, "started");
      } catch (error) {
        settleQueuedSteer(next.id, "failed");
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
