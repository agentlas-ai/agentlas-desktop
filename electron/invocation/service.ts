import { startPreparedHostQuestionInvocation } from "./host-admission";
import type { PreparedHostQuestionContinuation } from "./host-question-continuation";
import { recordInvocationArtifactWorkspace } from "../fs/invocation-workspace";
import { createClosedFactRetry } from "../runtime/fresh-reservation-frontier";
import { withoutOnePersonalNativeOriginal } from "../secrets/one-personal-native-entry";
import { captureOrdinaryOneTurn, type OrdinaryOneTurnSource, type OrdinaryOneTurnMode, type OrdinaryOneTurnState } from "./ordinary-one-turn";
import { nativeOwnerTextChoices, NATIVE_OWNER_TEXT_CONTEXT_OMITTED } from "./native-owner-text";
import type { NativeOwnerTextBinding, NativeOwnerTextInput, NativeOwnerTextReceipt } from "./native-owner-text";
import { withNativeApprovalExecution } from "../runtime/native-approval-provenance";
import { invocationRunPriority, withRunPriority } from "../runtime/run-priority";
import { getAuthenticatedActorIds, onAuthSessionOwnershipChanged, onAuthSessionRestored } from "../auth";
import { assertFinanceWorkChatOwner } from "../finance/work-project";
import { agentContextOwnerBinding } from "../runtime/agent-context-admission";
import { buildTeamSessionHandoff, teamDispatchReceiverCurrent } from "../one/session-handoff";
import { takeNativeInvocationIngressSource, validateNativeIngressRequest, type NativeInvocationIngressSource, type NativeIngressBinding, type NativeIngressPrepared } from "./native-ingress-source";
import { createNativePreparationLifetime, withNativePreparationLifetime, runNativePreparation, type NativePreparationLifetime } from "../runtime/native-preparation-lifetime";
import { assertNativeOneStartPort, isLocalInvocationPreparationPort, driveLocalOneStart, driveNativeOneStart, oneStartCheckpoint, nativeOneStartCheckpointFailureKind, type NativeOneStartCheckpoint, type NativeOneStartPort, type NativeOneStartBinding } from "./native-start-checkpoints";
import { canResumeInvocationBrowserLoginWait, claimInvocationBrowserLoginWait, registerInvocationBrowserLoginWait, settleInvocationBrowserLoginWait,
  type BrowserLoginWaitHandle, type InvocationBrowserLoginWait } from "./browser-login-wait";
import { isOneQuietReply } from "../../shared/one-supervisor";
import { bindWorkAttachmentRun, workAttachmentGroupIds, releaseWorkAttachmentRun, redactWorkAttachmentEvent, redactWorkAttachmentText } from "./work-attachments";
import { stoppedGoalMessageReopens } from "../../shared/goal-display-state";
import { TRANSIENT_SEND_DEADLINE_MS, isTransientSendRefusalCode, transientSendBackoffMs } from "../../shared/transient-send-refusal";
import { withBrowserDownloadProofContext } from "../long-run/download-proof";
import { admitMainInvocation, takeMainInvocationAdmission, MainInvocationLifetime, runMainBackgroundTask, type MainInvocationAdmission } from "../runtime/scheduled-root-context";
import { withBuiltinFileProofContext } from "../long-run/file-proof";
import { goalVerificationReasonCode, TRANSIENT_GOAL_VERIFICATION_REASON_CODES } from "../long-run/verification-effects";
import { withAdapterEffectContext, mainToolStartRequiresDurability } from "./adapter-effect-context";
import { RunEventDeliveryJournal } from "./event-delivery";
import { replayHostedElsewhere } from "./native-gui-events";
import { SemanticRunStepProjector } from "../one/semantic-run-step";
import { MainWorkRecoveryContext } from "./main-work-recovery";
import { parseRunEventReplayInput, type RunEventReplay } from "../../shared/run-event-delivery";
import { withInvocationAccounting } from "../long-run/accounting-context";
import { sameCauseWakeHold, SAME_CAUSE_WAKE_REASON } from "../long-run/wake-arbiter";
import { longRunMonetaryRefusal } from "../long-run/budget";
import { runtimeFailureBlocksReplay } from "../runtime/selection";
import { runtimeFailureBlocksNextAutomaticTurn } from "../../shared/runtime-turn-admission";
import { captureGoalEpisode, applyGoalEpisodeRest, drainGoalEpisodeNotices,
  captureGoalProducerAdmission, admitGoalProducer, assertGoalProducerDispatch, latestGoalEpisodeProducer, type GoalProducerAdmission } from "../long-run/episode-disposition";
import { latestGoalWaitSubscription, registerGoalWaitSubscription, registerOngoingGoalCycle, restoreGoalWaitAfterUndispatchedStart, supersedeGoalWaitForInvocation, type GoalWaitDispatch } from "../long-run/wait-subscriptions";
import { recordGoalWaitProposal } from "../long-run/goal-wait-proposal";
import type { ParsedGoalWait } from "../long-run/wait-emitter";
import { finiteGoalTimerRefusalEndsTurn, finiteGoalTimerRefusalMessage, goalWaitRefusalAlreadyNotified, goalWaitRefusalMessage, GOAL_WAIT_FINITE_TIMER_NOTICE } from "../long-run/goal-wait-refusal";
import { ensureOngoingEpisodeTask } from "../long-run/ongoing-episode-task";
import { settleNativeGoalEpisode } from "../long-run/native-goal-pass";
import { GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN, goalResumeRecoveryBlockerCode } from "../../shared/long-run";
import { prepareCheckpointContinuation } from "../long-run/continuation";
import { parkGoalAfterPassStopWithPool } from "../long-run/goal-pass-stop";
import { captureLongRunRuntimeSelection } from "../long-run/exact-runtime-binding";
import { InvocationEffectBoundaryTracker } from "./effect-boundary";
import { mainHostControlForEvent } from "./effect-metadata";
import { readInvocationEffectBoundary } from "./effect-boundary-reader";
import { recordAgentSurface } from "../store/agent-surfaces";
import type { ChatHostNotice } from "../../shared/types";
import { isHostPreflightTool } from "../../shared/tool-activity";
import { createHash, randomUUID } from "node:crypto";
import { assertInvocationRunOwner, claimInvocationRunOwner, invocationProcessOwner, invocationRunOwners } from "../store/invocation-run-owners";
import { CHAT_BUSY_OTHER_HOST_CODE, ensureChatHostHandover } from "../runtime/chat-host-handover";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import path from "node:path";
import { agentRunCwd } from "../runtime/exec";
import { resolveInvocationRunId } from "../runtime/run-id";
import {
  onAgentResidencyChange,
  type AgentResidencyChange,
} from "../runtime/agent-residency";
import {
  classifyMainOwnedTerminal,
  InvocationLifecycleRegistry,
  registerDurableInvocationStart,
  STOPPED_BY_USER,
} from "../runtime/invocation-lifecycle";
import { invocationHostStopCause, invocationHostStopCopy, isOwnerGoalStopCause, isNonFailureInvocationStop } from "../../shared/invocation-host-stop";
import { isAppSideRunFailureCode } from "../../shared/run-failure-cause";
import { runFailureNoticeText } from "../../shared/run-failure-notice";
import {
  appendLongRunEvent,
  bindCurrentGoalRevisionToLongRun,
  bindLongRunWorker,
  getLongRun,
  getLongRunByGoalId,
  getLongRunGoalRevisionBinding,
  listLongRunTasks,
  longRunContinueDecision,
  recordLongRunCycle,
  resumeLongRunByUser,
  settleLongRunWorkerAttempt,
  startLongRunWorkerAttempt,
  transitionLongRun, liveLongRunAttemptCount,
  longRunOwnerHold, goalOwnerAnswerHold, goalHoldableForOwnerAnswer, holdGoalForOwnerAnswer, releaseGoalOwnerAnswerHold, scheduleBlockedGoalRetry, pendingBlockedGoalRetry, consecutiveGoalTurnFollowUps, goalTurnFollowUpPlan } from "../store/long-runs";
import { armChatGoalContract, completeChatGoalContract, defineChatGoalContract, getChatGoalRevision, getLegacyGoalLifecycleSnapshot, migrateLegacyGoalLifecycle } from "../store/chat-goals";
import { automaticGoalReplayBlockerCode, prepareInvocationAutomaticGoal } from "./automatic-goal";
import { classifyAndHandGoalIntakeToMain } from "./goal-intake-forward";
import { followDaemonTurnGoalOfChat, goalAdmittedForServiceRun } from "../long-run/daemon-turn-goal";
import { holdFiniteGoalForPendingAmendment, reviewOwnerGoalMessage } from "../long-run/goal-owner-amendment";
import { prepareLegacyGoalLifecycle, type LegacyGoalLifecyclePreparation } from "./legacy-goal-lifecycle";
import { LONG_RUN_TERMINAL_STATUSES } from "../../shared/long-run";
import { desktopAppInstanceId } from "../long-run/app-runtime-coordinator";
import {
  completeEffectObservation, effectObservationTicket, maybeDispatchEffectObservation, readEffectObservationFromFinal,
  EFFECT_OBSERVATION_TIME_LIMIT_MS,
} from "../long-run/effect-observation";
import { stripEffectObservationMarker, type ParsedEffectObservation } from "../../shared/effect-observation";
import { DesktopLongRunInvocationProjection } from "../long-run/invocation-projection";
import { resolveDesktopRuntimeAdapter } from "../long-run/runtime-adapters";
import { claimCheckpointContinuation, latestTaskCheckpoint } from "../long-run/checkpoint";
import { inferWorkingFolderFromPrompt, runMcpInvocation, type InvocationExecutionContext } from "../mcp/client";
import { applyFinalDisplayBackstop } from "../mcp/final-display-backstop";
import { canonicalAskFenceText, extractAskFences } from "../../shared/ask-fence-flatten";
import {
  committedQuestionContinuationIsCurrent,
  committedQuestionRequiresHostPreparation,
  listCommittedQuestionAnswers,
  getCommittedQuestionContinuation,
} from "../confirm";
import { deriveGoalAcceptanceCriteria, ensureGoalLedgerGoal } from "../mcp/goal-ledger";
import { boundGoalIsTerminal, freshGoalIdForChat, resolveDesktopWorkforceGoalId } from "../mcp/workforce-goal-continuity";
import {
  invocationWorkspaceBindingsEqual,
  isRemoteInvocationWorkspaceBindingSource,
  assertInvocationWorkspaceSourceContext,
  normalizeRemoteInvocationPermission,
  type InvocationWorkspaceBinding,
} from "./workspace-binding";
import { pickLocale } from "../runtime/status-i18n";
import { hostOwnerCardQuestions } from "../long-run/goal-owner-card";
import { reportOwnerAsk } from "../owner-ask-alerts";
import { emitDesktopStoreChange } from "../store/change-bus";
import { permissionEscalationContinuationRequest } from "./permission-escalation-continuation";
import { effectiveInvocationPermission } from "../../shared/invocation-permission";
import { cancelQueuedOnePreflightSteersForChat } from "../store/one-preflight-steers";
import type { RunnerNativeTurnController, RunnerOwnerControlInbox, RunnerNativeControlState } from "../runtime/runner";
import type { InvocationCurrentTurnSteerRequest, InvocationCurrentTurnSteerReceipt } from "../../shared/types";
import { claimCurrentTurnSteer, countPendingCurrentTurnSteers, existingCurrentTurnSteer, getCurrentTurnSteer,
  listUncertainCurrentTurnSteers, rejectQueuedCurrentTurnSteersForStop, settleCurrentTurnSteer, takeCurrentTurnSteers } from "../store/current-turn-steers";
import { getRuntimeToolPermissionArbiter } from "../runtime/tool-approval";
import {
  PERMISSION_ESCALATION_TOOL,
  hasPermissionEscalationMarker,
  stripPermissionEscalationMarker,
} from "../../shared/permission-escalation";
import { stripStrayProtocolTokens } from "../../shared/protocol-token-strip";
import { advanceMainLivePartial, markInterruptedPartial } from "./interrupted-partial";
import { untrustedRuntimeFailurePayload } from "../runtime/untrusted-error";
import { validatedRunnerNativeControlState, markRefusedBeforeDispatch, outwardFailureCode, preDispatchRefusal, RuntimeTurnUnsettledError, refusalCode, runnerRefusedBeforeDispatch } from "../runtime/runner";
import { innermostTypedCode, STORE_BUSY_CODE } from "../../shared/turn-settlement";
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
import { getAgentApp } from "../store/agent-apps";
import { getDb } from "../store/db";
import { resumeGoalsWaitingOnProject } from "../long-run/blocked-goal-sweep";
import { adoptExplicitGoalGrant, ensureExplicitGoalContract } from "../long-run/explicit-goal-authority";
import { WORK_PROJECT_RESIDENCY_BUSY_CODE } from "../runtime/project-residency";
import {
  admitInvocationWithStartReceipt,
  canonicalInvocationRequestJson,
  INVOCATION_ADMISSION_DIGEST_VERSION,
  getInvocationAdmission,
  decideInvocationAdmission,
  rejectClosedNativeIngressAdmission,
  getPendingInvocationAdmissionForChat,
  type InvocationAdmissionIdentity,
} from "../store/invocation-admissions";
import { ownerVisiblePrompt } from "../one/owner-prompt";
import { claimDeferredSystemRelays, deferSystemRelay, peekDeferredSystemRelays, releaseDeferredSystemRelays } from "./deferred-system-relays";
import { chatFilePrompt, chatFileImages, validateChatAttachmentSelection, listChatFileSnapshot } from "../store/chat-message-attachments";
import { findAutomationByGoalId, toggleAutomation } from "../store/automations";
import { GOAL_CONTINUATION_HOST_WAKE } from "../store/goal-continuation-rows";
import { acknowledgeGoalExecutionResume, captureNativeGoalStopOwner, currentAutomationGoalExecutionOwnerMatches, nativeGoalStopOwnerMatches, snapshotAutomationGoalRunStops,
  stopKnownAutomationGoalRuns, type NativeGoalStopOwner } from "../automation-execution-control";
import { stopWorkspacePreviewsForTaskScope } from "../workspace-preview/control-server";
import {
  beginQueuedSteerDrain,
  bindQueuedTeamReportCustody,
  queuedTeamReportDigest,
  releaseQueuedSteerRecoveryHold,
  type QueuedTeamReportCustody,
  canonicalQueuedSteerRequest,
  cancelQueuedSteersForChat,
  getDurableQueuedSteer,
  holdQueuedSteerForRecovery,
  listRecoverableQueuedSteers,
  persistQueuedSteer,
  requeueUndispatchedQueuedSteer,
  retireHeldQueuedSteer,
  returnHeldOwnerSteer,
  settleQueuedSteer,
  type DurableQueuedSteer,
  type DurableQueuedSteerRecoveryReason,
  type DurableQueuedSteerTerminalCause,
} from "../store/invocation-steers";
import {
  appendChatMessage,
  bindGoalResultMessage,
  settleGoalResultMessages,
  getChat,
  getChatWorkingFolder,
  hasDurableAssistantMessage,
  latestDurableAssistantMessage,
  listChatMessages,
  repairRootChatSurfaceController,
  setChatGoalBinding,
  setChatContinuousMode,
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
import { personalSupervisorConversationInDb } from "../one/supervisor-store";
import { CARRIED_FOLLOWUP_STEER_PREFIX, carryUndeliveredOwnerFollowups as carryOwnerFollowupsToNextTurn } from "./carried-owner-followups";
import { personalSupervisorGuidance } from "../../shared/one-supervisor-context";
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
  resolveQueuedOneRoomRoster,
  type PreparedOneTeamPreflightClaim,
  type OneTeamRuntimeBinding,
} from "../one/team-preflight";
import { detectExplicitOneMemoryIntent, judgedOneMemoryIntent } from "../one/memory-detector";
import { judgedOneRequestIntent } from "../one/judged-request-intent";
import { oneTeamWorkforceHubMode, oneTeamUsesNativeStaffing, type OneTeamStaffingAuthority } from "../../shared/one-team-preflight";
import { ONE_PERSONA_DIRECTIVE } from "../one/persona";
import { composeMachineTurnOwnerContext } from "../one/turn-context";
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
import { redactSecrets } from "../../shared/secret-patterns";
import { invocationErrorDiagnostic, nativePreparationErrorDiagnostic, preparationRefusalCause, type NativePreparationDiagnosticPhase } from "./error-diagnostic";
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
import { assertDesktopOneRecoveryStart } from "../one/desktop-recovery-admission";
import { cacheOneOrgCompletionSummary, setOneOrgMemberStatus } from "../one/org";
import { adaptLegacySurfaceToOneV1 } from "../../shared/one-surface";
import { applyOneFriendlyFollowups } from "../../shared/one-friendly-followups";
import {
  buildApprovedOneProfileContext,
  buildApprovedOwnerWorkPreferenceContext,
  selectApprovedOneOperatingPrinciples,
} from "../../shared/one-profile";
import type {
  InvocationRunReceipt,
  InvocationSteerRecovery,
  InvocationSteerRecoveryReport,
  InvocationSteerRecoveryOutcome,
  InvocationSteerRecoveryReturn,
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
    id: string;
    text: string;
    queuedAt: string;
    position: number;
    recoveryState?: "ready" | "held";
    recoveryReason?: DurableQueuedSteerRecoveryReason;
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
  browserLoginWaiting?: boolean;
  /** Semantic wait projection only; never an approval or execution grant. */
  userDecisionRequest?: AgentlasUserDecisionRequest;
  /** Host-parsed proposal only; canonical source controllers retain all wait and execution authority. */
  goalWaitRequest?: ParsedGoalWait;
  /** Main-memory-only original goal; never projected as a wire receipt. */
  goal: string;
  workspaceBinding?: InvocationWorkspaceBinding;
}

/**
 * crossed: the durable start receipt exists. handedOff: the deferred completion chain is assigned.
 * cleanups: releases for resources this start has acquired so far, appended as each one is taken, so a failure
 * before the runner's own terminal settlement can undo exactly what exists (no closure reads a later binding).
 */
interface StartBoundary {
  crossed: boolean;
  runId?: string;
  handedOff?: boolean;
  cleanups?: Array<() => void>;
  ownerLease?: InvocationRunOwner;
}

/** Local bootstrap callback; never a renderer/daemon wire capability. */
export interface OrdinaryOneTurnObservation {
  wrap<T>(body: () => T): T;
  onAdmitted(): void;
  onPromptBound(): void;
  onSettled(): void;
  onPreparationClosed(): void;
}
interface OrdinaryOneTurnLifetime {
  phase: OrdinaryOneTurnState["phase"];
  actor: string;
  inputDigest: string;
  source?: OrdinaryOneTurnSource;
  observation?: OrdinaryOneTurnObservation;
  record?: RunRecord;
  messageId?: string;
  preparationClosed: boolean;
  executionClosed: boolean;
}
interface NativePreparingPending {
  startBoundary: StartBoundary;
  request: Readonly<McpInvocationRequest>;
  actorSnapshot: Readonly<{ userId: string; workspaceId: string }> | null;
  binding: NativeOneStartBinding;
  controller: AbortController;
  port: NativeOneStartPort;
  retained: Set<Promise<unknown>>;
  preparationLifetime: NativePreparationLifetime;
  ordinaryTurn?: OrdinaryOneTurnLifetime;
  /** Private monotonic dispatch frontier; never a wire or cleanup ACK. */
  dispatchClosed?: boolean;
}

interface RunRecord {
  /** Observed controller choice for live presentation only; never persisted as a chat pin. */
  currentRuntimeSelection?: RuntimeSelection;
  /** Original immutable native choices, never effective mutable UI settings. */
  nativeOwnerTextChoices?: string;
  ownerLease?: InvocationRunOwner;
  nativeTurnController?: RunnerNativeTurnController;
  nativeControlState?: Readonly<RunnerNativeControlState>;
  nativeBoundaryNoticeIntents?: Set<string>;
  /** Main verification owns this yielded native episode's next scheduling step. */
  nativeGoalEpisodePending?: boolean;
  mainLifetime?: MainInvocationLifetime;
  background?: boolean;
  completion?: Promise<void>;
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
  /** Each teammate's (agentId) accumulated live text: the base its wire deltas extend (liveWirePartial). */
  agentPartialTexts: Map<string, string>;
  resultFolder?: string;
  actualAgentId?: string;
  workspaceBinding?: InvocationWorkspaceBinding;
  oneMode: boolean;
  goal: string;
  pendingQuestion: boolean;
  browserLoginWait?: { handle: BrowserLoginWaitHandle; durable: InvocationBrowserLoginWait; unsubscribe?: () => void };
  userDecisionRequest?: AgentlasUserDecisionRequest;
  goalWaitRequest?: ParsedGoalWait;
  questionContinuationSourceMessageId?: string;
  questionContinuationRequestHash?: string;
  settlementPublished: boolean;
  longRunProjection?: DesktopLongRunInvocationProjection;
  automaticGoalId?: string;
  /** Canonical Main admission captured before dispatch; retained for Stop even
   * if the durable store becomes unreadable or mutable Goal fields change. */
  goalStopOwner?: NativeGoalStopOwner;
  automaticGoalDeadline?: ReturnType<typeof setTimeout>;
  /** A Goal continuation cannot silently pretend a one-turn attachment is still present. */
  hasTransientAttachments: boolean;
  /** Main-owned monotonic sequence shared by provider and resident-process events. */
  observableStepSequence: number;
  /** Run-owned semantic projection; original audit events retain every observation. */
  semanticSteps: SemanticRunStepProjector;
  deliveryOrdinal: number;
  executionSource?: InvocationExecutionContext["source"];
  /** Main-only provenance retained while waiting; never reconstructed from a receipt. */
  executionContext?: InvocationExecutionContext;
  oneTeamReportCustody?: QueuedTeamReportCustody;
  oneTeamReportOriginalRequest?: Readonly<McpInvocationRequest>;
}

function nextObservableSequence(record: RunRecord): number {
  record.observableStepSequence += 1;
  return record.observableStepSequence;
}

/**
 * The wire form of one live partial, or null when it brings nothing new (perf review 2026-10-17, R-03).
 *
 * A partial's `text` is the accumulated answer of its stream. The run's own answer already went out as `delta` +
 * `textLen`; a teammate's (agentId) went out whole on every frame, so a 10 KB answer cost about 1.25 MB of IPC and
 * delivery-journal JSON per teammate and a 30 KB one overran the run's 8 MB journal, evicting its tool events from
 * replay. Each teammate now has its own base (`agentPartialTexts`) and the same step. A teammate stream's first frame
 * and any reset that does not extend the base still carry the whole text, so a viewer re-syncs there. Readers rebuild
 * the text with reassembleAgentLivePartial (renderer gate, phone bridge, daemon relay).
 */
function liveWirePartial(record: Pick<RunRecord, "partialText" | "agentPartialTexts">, event: McpInvocationEvent): McpInvocationEvent | null {
  if (event.kind !== "partial" || typeof event.text !== "string") return event;
  const full = event.text;
  if (!event.agentId) {
    // 턴 확정 경계(빈 전문 + durableMessageId)도 여기서 버퍼를 비운다 — 이미 저장한
    // 본문이 중단 시 "중단된 답변"으로 또 저장되지 않게(shared/interrupted-partial.ts).
    const step = advanceMainLivePartial(record.partialText, full);
    if (step.drop) return null;
    record.partialText = step.partialText;
    return step.delta !== null
      ? { ...event, text: undefined, delta: step.delta, textLen: full.length }
      : { ...event, textLen: full.length };
  }
  const previous = record.agentPartialTexts.get(event.agentId);
  if (previous === undefined) {
    record.agentPartialTexts.set(event.agentId, full);
    return { ...event, textLen: full.length };
  }
  const step = advanceMainLivePartial(previous, full);
  if (step.drop) return null;
  record.agentPartialTexts.set(event.agentId, full);
  return step.delta !== null
    ? { ...event, text: undefined, delta: step.delta, textLen: full.length }
    : { ...event, textLen: full.length };
}

/** Teammate bases for a hydrating viewer, bounded like the root `partialText` (8 MB in all). */
function replayAgentPartialTexts(texts: ReadonlyMap<string, string>): Record<string, string> | undefined {
  return texts.size ? boundedPartialTexts(Object.fromEntries(texts)) : undefined;
}
function boundedPartialTexts(texts: Record<string, string>): Record<string, string> | undefined {
  let length = 0;
  for (const text of Object.values(texts)) length += text.length;
  return length <= 8 * 1024 * 1024 ? texts : undefined;
}

/**
 * The attach buffer keeps one partial per teammate: its latest accumulated text, placed at its latest frame. Pushing
 * every frame let one long teammate answer (thousands of frames) evict the run's tool rows from the 4,000-event buffer.
 */
function replaceTeammatePartial(events: McpInvocationEvent[], event: McpInvocationEvent): boolean {
  if (event.kind !== "partial" || !event.agentId || typeof event.text !== "string") return false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const prior = events[index];
    if (prior.kind === "partial" && prior.agentId === event.agentId && typeof prior.text === "string") {
      events.splice(index, 1);
      break;
    }
  }
  events.push(event);
  return true;
}

interface QueuedSteer {
  oneTeamReportCustodyJson?: string;
  oneTeamReportCustody?: QueuedTeamReportCustody;
  mainAdmission?: MainInvocationAdmission;
  id: string;
  originalRunId: string;
  promptHash: string;
  request: McpInvocationRequest;
  queuedAt: string;
  workspaceBinding?: InvocationWorkspaceBinding;
  executionContext?: InvocationExecutionContext;
  drainedRunId?: string;
  /** A planned run of this direction whose start a locked store refused after recording it: retried under a new id. */
  spentRunId?: string;
  recoveryState?: "ready" | "held";
  recoveryReason?: DurableQueuedSteerRecoveryReason;
}

function runReqChatFileGroupIds(prompt: string): Set<string> {
  const ids = new Set<string>();
  for (const match of prompt.matchAll(/<!--\s*agentlas-chat-files:v1:([0-9a-f-]{36})\s*-->/giu)) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

type OneInvocationRequest = McpInvocationRequest & {
  /** Renderer may request One semantics; Main derives the actual context. */
  oneMode?: boolean;
  /** Main-only. Renderer and Mobile input are always discarded before this is built. */
  oneProfileContext?: string;
  /** Main-only owner substance for turns whose output the host parses (electron/one/turn-context.ts). Discarded on input. */
  oneMachineTurnContext?: string;
  /** Main-only execution boundary. Renderer and Mobile input are discarded. */
  oneTeamExecutionPolicy?: "solo_locked" | "confirmed_existing_roster" | "confirmed_external_workforce" | "native_one_staffing";
  /** Main-only binding revalidated again in the runtime immediately before dispatch. */
  oneTeamRuntimeBinding?: OneTeamRuntimeBinding;
  /** Main-only exact-prompt staffing scope; incoming flags are discarded. */
  oneTeamStaffingAuthority?: OneTeamStaffingAuthority;
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
  requestedPermission?: unknown,
): "read" | "write" | "full" {
  if (mode === "read") return "read";
  if (mode === "write") return "write";
  if (mode === "full") return "full";
  const auto = taskIntent === "task" ? "write" : "read";
  if (mode === "auto") return auto;
  // Missing legacy mode is treated as Auto, never as permission supplied by
  // the renderer. Desktop One always sends the explicit chip value now.
  // An explicit read is still honored: it can only narrow. The Desktop
  // recovery turn, team reports and Agent Mail send read without a mode,
  // and intent promotion to "task" turned each into write (P17 replay
  // 2026-10-16: two recovery turns ran write under a read-only chip).
  return requestedPermission === "read" ? "read" : auto;
}

type InvocationEventListener = (envelope: InvocationEventEnvelope) => void;
type ActiveChatsListener = (chatIds: string[]) => void;
type InvocationSettledListener = (envelope: InvocationSettledEnvelope) => void | Promise<void>;

const MAX_BUFFERED_EVENTS = 4_000;
const MAX_PARTIAL_CHARS = 2 * 1024 * 1024;
const MAX_STEER_QUEUE_DEPTH = 8;
const HELD_SYSTEM_STEER_RETIRE_MS = 60 * 60_000;
/** Abort causes of a host stop for closing the app or installing an update: never an owner's withdrawal of queued work. */
const HOST_SHUTDOWN_ABORT_CAUSES: ReadonlySet<string> = new Set(["app_closed", "app_shutdown", "update_restart"]);
/** How often a chat held by this process outside its own turns (a graph agent node, a doctor run) is looked at again. */
const PROCESS_LEASE_POLL_MS = 2_000;
/**
 * Waits between start attempts of a queued direction whose start hit a locked store (R-067); each attempt first waits
 * out the store's own busy_timeout. Bounded: after the last one the row fails with drain-store-busy-exhausted.
 * AGENTLAS_TEST_STEER_DRAIN_FAST=1 shortens the schedule for gates only.
 */
const STEER_DRAIN_STORE_BUSY_DELAYS_MS: readonly number[] = process.env.AGENTLAS_TEST_STEER_DRAIN_FAST === "1"
  ? [20, 40, 80, 160]
  : [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
/** The id form One lists for an owner text a native turn could not confirm (nativeOwnerTextRecovery). */
const NATIVE_OWNER_RECOVERY_PREFIX = "native-owner:";
/** invocation_current_turn_steers code of an uncertain owner text the owner took back into the composer. */
const OWNER_RECOVERY_RETURNED_CODE = "owner_recovery_returned";

/** A waiting Goal refused this run and parked its relay (start(): deferSystemRelay with originRunId = the run id). */
function relayParkedForRun(runId: string): boolean {
  try {
    return Boolean(getDb().prepare("SELECT 1 FROM deferred_system_relays WHERE origin_run_id = ? LIMIT 1").get(runId));
  } catch {
    return false; // No parking table yet: nothing was parked.
  }
}

/** An undelivered parked copy of exactly this text waits for the chat's next turn (deferSystemRelay's duplicate rule). */
function relayCopyParked(chatId: string, text: string): boolean {
  try {
    return Boolean(getDb().prepare("SELECT 1 FROM deferred_system_relays WHERE chat_id = ? AND text_hash = ? AND delivered_at IS NULL LIMIT 1")
      .get(chatId, createHash("sha256").update(text.trim()).digest("hex")));
  } catch {
    return false;
  }
}

/**
 * The run's user-message cursor INCLUDING its own prompt row (ID-1). invoke_started.latestUserMessageRowId is read before
 * the run writes the owner's prompt row (mcp/client.ts persistUserMessage runs after the durable start), so for 34 of 44
 * owner-bound runs since 2026-10-14 the cursor was below the run's own prompt, and a Goal resume after a restart read the
 * owner's own prompt as a newer direction (Yotube run_d627367a 10-14 00:25Z and 05:32Z: newer_user_direction, then a
 * fresh-context retry). Recorded on invoke_prompt_bound once the row exists: the prompt row when no other owner message
 * landed between the start cursor and it, else the start cursor unchanged. invoke_started keeps its admission-time value,
 * so desktop-recovery-admission (owner-run automatic recovery) reads exactly what it read before.
 */
export function promptBoundUserCursor(chatId: string, runId: string, promptMessageId: string): { latestUserMessageRowId?: number } {
  try {
    const start = getDb().prepare(`SELECT json_extract(payload_json, '$.latestUserMessageRowId') AS cursor FROM run_events
      WHERE run_id = ? AND chat_id = ? AND kind = 'invoke_started' ORDER BY seq ASC LIMIT 1`).get(runId, chatId) as { cursor: unknown } | undefined;
    const prompt = getDb().prepare("SELECT rowid AS cursor FROM chat_messages WHERE id = ? AND chat_id = ? AND role = 'user'")
      .get(promptMessageId, chatId) as { cursor: number } | undefined;
    const startCursor = typeof start?.cursor === "number" && Number.isSafeInteger(start.cursor) ? start.cursor : null;
    if (!prompt) return startCursor !== null ? { latestUserMessageRowId: startCursor } : {};
    if (startCursor !== null && prompt.cursor <= startCursor) return { latestUserMessageRowId: startCursor };
    const between = getDb().prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND rowid > ? AND rowid < ? LIMIT 1")
      .get(chatId, startCursor ?? -1, prompt.cursor);
    if (between) return startCursor !== null ? { latestUserMessageRowId: startCursor } : {};
    return { latestUserMessageRowId: prompt.cursor };
  } catch {
    return {};
  }
}

/** Why an owner message in this run context gets no Goal review (null: it is reviewed). The start path adds not_local_user_turn. */
function ownerDirectionReviewSkip(request: Pick<McpInvocationRequest, "planMode" | "agentAppMode">,
  workspaceBinding: InvocationWorkspaceBinding | undefined, executionContext: InvocationExecutionContext | undefined): string | null {
  return request.planMode ? "plan_mode"
    : request.agentAppMode ? "agent_app_mode"
      : workspaceBinding ? "workspace_binding"
        : executionContext ? "execution_context"
          : null;
}

/**
 * An owner message that changes an ongoing Goal's targets becomes a Goal revision (applied at the next stop).
 * Asynchronous: never delays or refuses the turn. Every review — answered, unanswered or skipped — leaves a machine
 * reasonCode in the run ledger; silence was how the owner's target restatements disappeared (2026-09-24).
 * One review for every way an owner message enters (D2): a turn's own prompt (start), a direction typed into a running
 * turn (steerCurrentTurn, nativeOwnerText: Desktop, the background service, the phone), and a queued direction whose
 * start failed and was kept as the owner's message. Only the start path reviewed before: production Yotube 10-13..10-18,
 * 22 directions applied to running turns ("묻지 말고 공개", "음성은 한 번만") had no review and were gone from the Goal
 * the next day. reviewOwnerGoalMessage is idempotent per (Goal, message).
 */
function reviewOwnerDirectionForGoal(input: { runId: string; chatId: string; goalId: string; sourceMessageId: string;
  notReviewed: string | null; via?: "current-turn" | "queued-start-failed" }): void {
  const { runId, chatId, goalId, sourceMessageId } = input;
  const via = input.via ? { via: input.via } : {};
  if (input.notReviewed) {
    tryRecordRunEvent({ runId, chatId, kind: "goal_owner_amendment_reviewed", payload: {
      goalId, sourceMessageId, ...via, reasonCode: `skipped:${input.notReviewed}`, recorded: false, applied: false,
    } });
    return;
  }
  void reviewOwnerGoalMessage({ goalId, chatId, sourceMessageId }).then((review) => {
    if (review.reasonCode.startsWith("judge_unavailable:")) {
      console.warn(`[goal-amendment] review unanswered goal=${goalId} reason=${review.reasonCode}`);
      // The message still steers this turn and the Goal stays unchanged. No room notice:
      // the judge being down is an internal state the owner cannot act on (13 identical
      // notices in the Youtube room, 2026-10-10). The coded review event below is the
      // durable receipt; the Goal panel still shows the current conditions.
    }
    tryRecordRunEvent({ runId, chatId, kind: "goal_owner_amendment_reviewed", payload: {
      goalId, sourceMessageId, ...via, label: review.label, reasonCode: review.reasonCode,
      recorded: review.recorded,
      applied: review.apply?.applied ?? false,
      ...(review.apply?.applied ? { revision: review.apply.revision }
        : review.apply ? { deferredReason: review.apply.reason } : {}),
    } });
  });
}

/** The chat's Goal, when its owner messages are reviewed against it (a One or Work room the owner talks in). */
function reviewableChatGoalId(chatId: string, fallbackGoalId?: string | null): string | null {
  const chat = getChat(chatId);
  if (!chat || chat.kind !== "user" || !["one", "work"].includes(chat.originSurface ?? "")) return null;
  return chat.goalId ?? fallbackGoalId ?? null;
}

/**
 * The owner takes back an owner text a native turn could not confirm (`native-owner:<intent>`, status uncertain): the
 * text is returned and the row settled rejected/owner_recovery_returned in one transaction. Current-turn rows are the
 * owner's own text by construction (claimCurrentTurnSteer writes the owner's message). Idempotent.
 */
function returnUncertainOwnerText(intentId: string, expectedChatId?: string): InvocationSteerRecoveryOutcome {
  const db = getDb();
  return db.transaction((): InvocationSteerRecoveryOutcome => {
    const row = db.prepare("SELECT chat_id, prompt_text, status, code FROM invocation_current_turn_steers WHERE intent_id = ?")
      .get(intentId) as { chat_id: string; prompt_text: string; status: string; code: string | null } | undefined;
    if (!row) return { status: "refused", code: "steer_recovery_not_found" };
    if (expectedChatId !== undefined && row.chat_id !== expectedChatId) return { status: "refused", code: "steer_recovery_chat_mismatch" };
    if (row.status === "rejected" && row.code === OWNER_RECOVERY_RETURNED_CODE) {
      return { status: "already-returned", chatId: row.chat_id, promptText: row.prompt_text };
    }
    if (row.status !== "uncertain" || db.prepare(`UPDATE invocation_current_turn_steers SET status = 'rejected', code = ?, updated_at = ?
      WHERE intent_id = ? AND chat_id = ? AND status = 'uncertain'`).run(OWNER_RECOVERY_RETURNED_CODE, new Date().toISOString(), intentId, row.chat_id).changes !== 1) {
      return { status: "refused", code: "steer_recovery_not_held" };
    }
    return { status: "returned", chatId: row.chat_id, promptText: row.prompt_text };
  }).immediate();
}
const VERIFICATION_TRANSIENT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 480_000] as const;
const ONE_TASK_KIND_MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/;
const ONE_TASK_KIND_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ONE_TASK_KIND_PARTICIPANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function steerReceiptIsTerminal(receipt: InvocationRunReceipt | null): boolean {
  return receipt !== null && (receipt.status === "completed" || receipt.status === "failed" || receipt.status === "cancelled");
}

function queuedSteerFromDurable(row: DurableQueuedSteer): QueuedSteer {
  return {
    ...(row.oneTeamReportCustodyJson!==undefined ? {oneTeamReportCustodyJson:row.oneTeamReportCustodyJson} : {}),
    ...(row.oneTeamReportCustody ? {oneTeamReportCustody:row.oneTeamReportCustody} : {}),
    id: row.id,
    originalRunId: row.originalRunId,
    promptHash: row.promptHash,
    request: row.request,
    queuedAt: row.queuedAt,
    ...(row.workspaceBinding ? { workspaceBinding: row.workspaceBinding } : {}),
    ...(row.executionContext ? { executionContext: row.executionContext } : {}),
    ...(row.drainedRunId ? { drainedRunId: row.drainedRunId } : {}),
    recoveryState: row.recoveryState,
    ...(row.recoveryReason ? { recoveryReason: row.recoveryReason } : {}),
  };
}

/** The queued directions the owner wrote, in queue order; host-written turns (promptOrigin "system") are left out. */
function ownerWrittenSteers(queue: QueuedSteer[]): QueuedSteer[] {
  return queue.filter((queued) => queued.request.promptOrigin !== "system");
}

function publicSteerRecoveryReason(reason:DurableQueuedSteerRecoveryReason|undefined):InvocationSteerRecovery["reason"] {
  return !reason || reason==="one-team-report-owner-unbound" ? "original-run-start-uncertain" : reason;
}
/** Canonical source reference, Main-only positional argument; not an authority DTO. */
export interface QueuedTeamReportSourceRef { dispatchId:string;childRunId:string;roomChatId:string }
function readQueuedTeamReportSource(ref:QueuedTeamReportSourceRef) {
  if(Object.keys(ref).sort().join(",")!=="childRunId,dispatchId,roomChatId" || ![ref.dispatchId,ref.childRunId,ref.roomChatId].every(v=>typeof v==="string"&&!!v&&Buffer.byteLength(v)<=512&&!/[\u0000-\u001f]/.test(v)))throw new Error("one_team_report_owner_unbound");
  const db=getDb();
  type Source={parent_chat_id:string;parent_run_id:string|null;child_run_id:string;owner_scope:string|null;child_chat_id:string;member_agent_id:string;brief:string;status:string;result_text:string|null};
  const lookup=(table:string):Source|undefined=>{
    const columns=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(column=>column.name));
    if(!columns.size)return undefined;
    // Group tables predate private custody and still migrate lazily. Startup
    // recovery reads unknown metadata without taking over that migration.
    const optional=(name:string,fallback:string)=>columns.has(name)?name:`${fallback} AS ${name}`;
    const projection=["parent_chat_id",optional("parent_run_id","NULL"),"child_run_id",optional("owner_scope","NULL"),
      "child_chat_id","member_agent_id",optional("brief","''"),"status","result_text"].join(",");
    return db.prepare(`SELECT ${projection} FROM ${table} WHERE id=? AND child_run_id=? AND parent_chat_id=?`)
      .get(ref.dispatchId,ref.childRunId,ref.roomChatId) as Source|undefined;
  };
  const source=lookup("one_team_dispatches")??lookup("one_team_dispatch_results");
  if(!source || !buildTeamSessionHandoff({dispatchId:ref.dispatchId,roomChatId:source.parent_chat_id,parentRunId:source.parent_run_id,
    childRunId:source.child_run_id,childChatId:source.child_chat_id,memberAgentId:source.member_agent_id,memberName:"member",
    brief:source.brief,status:source.status,result:source.result_text}).relayAllowed)throw new Error("one_team_report_owner_unbound");return source;
}
function captureQueuedTeamReportCustody(request:McpInvocationRequest,ref?:QueuedTeamReportSourceRef,legacyParentRunId?:string):QueuedTeamReportCustody {
  if(request.oneTeamReportTurn!==true || !request.oneMode || request.promptOrigin!=="system")throw new Error("one_team_report_owner_unbound");
  // Fresh reports need the actual Group producer's canonical source. Only an
  // existing durable row may use the older native receiver proof on recovery.
  if(!ref && !legacyParentRunId)throw new Error("one_team_report_owner_unbound");
  const owner=agentContextOwnerBinding(),source=ref?readQueuedTeamReportSource(ref):null;
  if(ref && ref.roomChatId!==request.chatId || !teamDispatchReceiverCurrent({roomChatId:request.chatId,
    parentRunId:source?.parent_run_id ?? legacyParentRunId,ownerScope:source?.owner_scope ?? null}))throw new Error("one_team_report_owner_unbound");
  if(!ref){const db=getDb();for(const table of ["one_team_dispatches","one_team_dispatch_results"]){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))continue;
    const columns=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(column=>column.name));
    if(!columns.has("owner_scope"))continue;
    const parentBound=Boolean(legacyParentRunId&&columns.has("parent_run_id"));
    const foreign=db.prepare(`SELECT 1 FROM ${table} WHERE parent_chat_id=? AND owner_scope IS NOT NULL AND owner_scope<>? ${parentBound?"AND parent_run_id=?":""} LIMIT 1`)
      .get(request.chatId,owner.ownerScope,...(parentBound?[legacyParentRunId]:[]));
    if(foreign)throw new Error("one_team_report_owner_unbound");
  }}
  const latest=agentContextOwnerBinding();if(latest.ownerScope!==owner.ownerScope||latest.serviceIdentity!==owner.serviceIdentity)throw new Error("one_team_report_owner_unbound");
  return Object.freeze({schemaVersion:"agentlas.queued-team-report-custody.v1",...owner,chatId:request.chatId,
    dispatchId:ref?.dispatchId??null,childRunId:ref?.childRunId??null,parentRunId:source?.parent_run_id??legacyParentRunId??null,
    requestDigest:queuedTeamReportDigest(request)});
}
function queuedTeamReportCurrent(custody:QueuedTeamReportCustody|undefined,request:McpInvocationRequest):boolean {
  try {if(!custody || custody.chatId!==request.chatId || custody.requestDigest!==queuedTeamReportDigest(request))return false;
    const now=agentContextOwnerBinding();if(now.ownerScope!==custody.ownerScope||now.serviceIdentity!==custody.serviceIdentity)return false;
    if(custody.dispatchId){const source=readQueuedTeamReportSource({dispatchId:custody.dispatchId,childRunId:custody.childRunId!,roomChatId:custody.chatId});
      if(source.parent_run_id!==custody.parentRunId || !teamDispatchReceiverCurrent({roomChatId:custody.chatId,parentRunId:source.parent_run_id,ownerScope:source.owner_scope}))return false;
    }else {const legacy=captureQueuedTeamReportCustody(request,undefined,custody.parentRunId??undefined);if(legacy.ownerScope!==custody.ownerScope||legacy.serviceIdentity!==custody.serviceIdentity)return false;}
    const latest=agentContextOwnerBinding();return latest.ownerScope===custody.ownerScope&&latest.serviceIdentity===custody.serviceIdentity;
  }catch{return false;}
}
function steeringRecoveryFromDurable(row: DurableQueuedSteer): InvocationSteerRecovery {
  return {
    id: row.id,
    chatId: row.chatId,
    originalRunId: row.request.oneTeamReportTurn ? "" : row.originalRunId,
    promptText: row.request.oneTeamReportTurn ? "" : row.promptText,
    promptHash: row.request.oneTeamReportTurn ? "" : row.promptHash,
    queuedAt: row.queuedAt,
    reason: publicSteerRecoveryReason(row.recoveryReason),
  };
}

function oneTaskKindImageRef(image: ImageAttachment): string | null {
  if (
    !image
    || typeof image.mediaType !== "string"
    || !ONE_TASK_KIND_MEDIA_TYPE_RE.test(image.mediaType)
    || typeof image.data !== "string"
    || image.data.length < 4
    || image.data.length > Math.ceil(ONE_ATTACHMENT_LIMITS.maxImageBytes / 3) * 4
    || image.data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
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
    || (item.kind !== "image" && item.kind !== "file" && item.kind !== "directory")
    || typeof item.mediaType !== "string"
    || !ONE_TASK_KIND_MEDIA_TYPE_RE.test(item.mediaType)
    || !Number.isSafeInteger(item.size)
    || item.size < 0
    || item.size > (item.kind === "image" ? ONE_ATTACHMENT_LIMITS.maxImageBytes
      : item.kind === "directory" ? ONE_ATTACHMENT_LIMITS.maxTotalBytes : ONE_ATTACHMENT_LIMITS.maxFileBytes)
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
 * Resolve the execution roster from the owner plus claimed Main preflight
 * targets or freshly validated queued-room targets. Never infer participants from legacy firms, groups,
 * hired-agent cards, prior events, or renderer-supplied targets.
 */
function exactOneInvocationParticipants(
  ownerAgentId: string,
  preparedTeam: PreparedOneTeamPreflightClaim | null,
  queuedRoomTargets?: McpInvocationRequest["taskForceTargets"],
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
    preparedTeam ? preparedTeam.mode : queuedRoomTargets?.length ? "team" : null,
    preparedTeam ? preparedTeam.taskForceTargets : queuedRoomTargets ?? null,
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
    // A direct One organisation seat may itself be an installed team
    // controller. It is the selected execution owner and has exact local
    // prompt/package bytes, so pin it just like a single agent. Team targets
    // inside a dynamically assembled roster remain outside this list and are
    // represented by their Firm target binding instead.
    const directOwnerTeam = participantId === ownerAgentId && participant?.kind === "team";
    if (!participant || (participant.kind === "team" && !directOwnerTeam) || participant.sourceMissingSince) return null;
    participants.push(participant);
  }
  return participants;
}

/** 마지막 Task 투영 실패의 이유. 호출부가 사람이 읽을 수 있는 실패를 만들 수 있게 남긴다. */
let lastTaskProjectionFailure: { chatId: string; status: string; at: string; reason: string } | null = null;
// Only the durable owner queue can supply this non-serializable start argument.
const QUEUED_ONE_ROOM_INHERITANCE = Symbol("queued-one-room-inheritance");

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
  } catch (error) {
    // Task projection is a durable companion to the run ledger. A temporary
    // projection failure must not prevent the underlying invocation.
    //
    // ★ 이유까지 버리면 안 된다. 자율 연구의 연속 턴이 여기서 null 을 받아
    // decision-task-projection-failed 로 죽었는데, 왜 실패했는지는 이 catch 가
    // 삼켜서 남아 있지 않았다 -- 증거가 스스로를 지우는 구조다. 실행은 그대로
    // 진행시키되, 이유는 남긴다.
    lastTaskProjectionFailure = { chatId, status, at: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) };
    console.error(`[task-projection] ${status} failed for chat ${chatId}: ${lastTaskProjectionFailure.reason}`);
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
  projector: SemanticRunStepProjector,
): void {
  if (!task) return;
  projector.record(event, sequence, (step) => tryRecordOneDomainEvent({
    eventType: "run.step_changed",
    occurredAt: new Date().toISOString(),
    actor: event.agentId ? "agent" : "system",
    entityId: task.id,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    taskId: task.id,
    version: task.version,
    visibility: domainVisibility(task),
    entries: [
      { name: "stepId", value: step.stepId },
      { name: "status", value: step.status },
      { name: "publicSafeSummary", value: step.publicSafeSummary },
    ],
  }) !== null);
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

/**
 * A main-agent error terminal that still asks the owner a question (a typed decision request, or an ask fence in the
 * durable text it carries). Task status and the "waiting-decision" projection stay final-only; this only decides
 * whether the turn waits for the owner (record.pendingQuestion: no automatic completion claim, the Goal is held).
 */
export function invocationErrorAsksOwner(event: McpInvocationEvent): boolean {
  if (event.kind !== "error" || event.agentId) return false;
  return invocationEventRequestsDecision({ ...event, kind: "final" });
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

/** A store lock (SQLITE_BUSY / SQLITE_LOCKED and their extended codes, SQLITE_PROTOCOL): the shared typed STORE_BUSY_CODE. */
function isRetryableDecisionStoreError(error: unknown): boolean {
  return innermostTypedCode(error) === STORE_BUSY_CODE;
}

/** A completion judge is advisory and side-effect free. A provider timeout,
 * malformed response, or drained runner failure must retry the judge only;
 * it must never replay the already completed controller turn or block the
 * person's Goal. User stop/steering still aborts the retained lifetime. */
export function isTransientGoalVerificationError(error: unknown): boolean {
  return TRANSIENT_GOAL_VERIFICATION_REASON_CODES.includes(goalVerificationReasonCode(error));
}

function waitForGoalVerificationRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function retryTransientGoalVerification<T>(input: {
  signal: AbortSignal;
  verify: () => Promise<T>;
  onRetry: (retry: { attempt: number; delayMs: number; reasonCode: string }) => void;
}): Promise<T | null> {
  let transientAttempts = 0;
  while (!input.signal.aborted) {
    try {
      return await input.verify();
    } catch (error) {
      if (!isTransientGoalVerificationError(error) || input.signal.aborted) throw error;
      const delayMs = VERIFICATION_TRANSIENT_RETRY_DELAYS_MS[
        Math.min(transientAttempts, VERIFICATION_TRANSIENT_RETRY_DELAYS_MS.length - 1)
      ]!;
      transientAttempts += 1;
      input.onRetry({
        attempt: transientAttempts,
        delayMs,
        reasonCode: error && typeof error === "object" && "reasonCode" in error
          ? String((error as { reasonCode?: unknown }).reasonCode ?? "verification_transient")
          : "verification_transient",
      });
      await waitForGoalVerificationRetry(delayMs, input.signal);
    }
  }
  return null;
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

/** Typed run event that keeps a refused start's cause next to its outward ledger code (no prose, no paths). */
export const INVOCATION_START_REFUSAL_EVENT = "invocation_start_refusal";

/**
 * Admission ledger reason for a proven pre-dispatch refusal: the innermost machine code of the thrown cause chain
 * (shared/turn-settlement.ts typedCodeChain), never prose and never a wrapper's generic code; Main and the daemon record
 * the same code for the same refusal.
 */
export function preDispatchRefusalReasonCode(error: unknown): string {
  const identifier = /^[a-z][a-z0-9_-]{0,79}$/;
  const own = innermostTypedCode(error);
  if (typeof own === "string" && identifier.test(own)) return own;
  const message = error instanceof Error ? error.message.trim() : "";
  if (identifier.test(message)) return message;
  const leading = /^([a-z][a-z0-9_]{2,79}):\s/.exec(message)?.[1];
  return leading ?? "main_start_pre_dispatch_refused";
}

interface NativeIngressPending {
  source: ReturnType<typeof takeNativeInvocationIngressSource>;
  original: NativeInvocationIngressSource;
  actorSnapshot: Readonly<{ userId: string; workspaceId: string }> | null;
  selectedCwd?: string;
  undispatchedLease?: InvocationRunOwner;
  closedExecutionLease?: InvocationRunOwner;
  observedKinds: Set<string>;
  controller: AbortController;
  lifetime: NativePreparationLifetime;
  retained: Set<Promise<unknown>>;
  handedOff: boolean;
  returnedPrepared?: NativeIngressPrepared;
  port?: NativeOneStartPort;
  cancelPromise?: Promise<void>;
  cancelSettled: boolean;
  frontier: "open" | "closed-no-start" | "closed-prepared";
  proofMinted: boolean;
}

/** Desktop and the background service never run one chat's turns at once (1.3.0 A2): a live run-owner row of the other
 * process kind means the chat belongs to that process until the row is released. */
function otherHostOwnsChat(row: Pick<InvocationRunOwner, "ownerKind" | "state">, local: { ownerKind: InvocationRunOwner["ownerKind"] }): boolean {
  return (row.state === "active" || row.state === "settling") && row.ownerKind !== local.ownerKind
    && (row.ownerKind === "desktop" || row.ownerKind === "daemon") && (local.ownerKind === "desktop" || local.ownerKind === "daemon");
}

/** Typed marker only: a user-actor `run.user_control` pause/stop/delete on the chat's Goal newer than the committed answer. */
function ownerStoppedGoalAfterAnswer(chatId: string, sourceMessageId: string): boolean {
  try {
    const goalId = getChat(chatId)?.goalId;
    const run = goalId ? getLongRunByGoalId(goalId) : null;
    const answeredAt = listCommittedQuestionAnswers(chatId).find((answer) => answer.sourceMessageId === sourceMessageId)?.ts;
    if (!run || !answeredAt) return false;
    const rows = getDb().prepare(
      `SELECT payload_json FROM long_run_events
        WHERE run_id = ? AND kind = 'run.user_control' AND actor_kind = 'user' AND occurred_at > ?
        ORDER BY seq DESC`,
    ).all(run.id, answeredAt) as Array<{ payload_json: string }>;
    // A later owner resume_with_message/resume releases the hold again; the newest marker decides.
    for (const row of rows) {
      let payload: { action?: unknown; command?: unknown };
      try { payload = JSON.parse(row.payload_json); } catch { continue; }
      const verb = String(payload.action ?? payload.command ?? "");
      if (verb === "resume_with_message" || verb === "resume") return false;
      if (["pause", "stop", "cancel", "delete"].includes(verb)) return true;
    }
    return false;
  } catch { return false; }
}

/**
 * Owner 2026-10-14: termination is the model's judgment on its goal tree ("종료를 모델이 직접판단하는거아님? 그게 골 트리
 * 구조인데"), and the host checks outcomes, not mid-run tool-call settlement ("작업마다 정산하지말고 … 업로드된걸 보면 되지").
 * A finite Goal whose model declared completion closes here unless the verifier returned a positive "failed" verdict:
 * verification that could not run, threw, or stayed inconclusive no longer loops the Goal. The Yotube Goal looped from
 * 2026-10-13 23:07Z (owner "현 상태 수용하고 종결") through 1.3.33 on verification_unavailable.
 */
function closeGoalOnModelJudgment(goalId: string, reason: string): boolean {
  if (getChatGoalRevision(goalId)?.lifecycle !== "finite") return false;
  const run = getLongRunByGoalId(goalId);
  if (!run || LONG_RUN_TERMINAL_STATUSES.has(run.status) || longRunOwnerHold(run.id)) return false;
  try {
    const step = (to: "queued" | "running" | "verifying" | "completed", why: string) =>
      transitionLongRun({ runId: run.id, to, actorKind: "host", reason: why });
    if (run.status === "blocked") step("queued", reason);
    if (["blocked", "queued", "waiting_user"].includes(run.status)) step("running", reason);
    if (getLongRunByGoalId(goalId)?.status !== "verifying") step("verifying", reason);
    appendLongRunEvent({ runId: run.id, kind: "verification.model_judgment_accepted", actorKind: "host", payload: { reason } });
    step("completed", "model-declared-completion");
  } catch (error) {
    console.warn("[long-run] model-declared completion could not close the Goal:", error instanceof Error ? error.message : String(error));
    return false;
  }
  completeChatGoalContract(goalId, "completed");
  return true;
}

/**
 * The chat is still held by earlier work. The outward code stays invocation_cleanup_pending (the send queue and the
 * renderer key on it); the cause names the holder, and recordStartRefusalCause stores it as causeCode. Nine different
 * checks used to throw the same bare error, and one swallowed the fence's own error: the owner's message after a restart
 * was refused with no recorded reason (W7 2026-10-17, copy taken while the Yotube Goal turn was running).
 */
function cleanupPending(holder: string, cause?: unknown): Error {
  return Object.assign(new Error("invocation_cleanup_pending"),
    { cause: Object.assign(new Error(holder), { code: holder }, cause === undefined ? {} : { cause }) });
}

export class InvocationService {
  private readonly deliveryJournal = new RunEventDeliveryJournal();
  private readonly activeRuns = new InvocationLifecycleRegistry<RunRecord>();
  private readonly currentTurnSteerDispatches = new Set<string>();
  /** Machine marker for turns this process interrupts at shutdown (see markShutdownForUpdate). */
  private appShutdownCause: "app_closed" | "update_restart" = "app_closed";
  private readonly eventListeners = new Set<InvocationEventListener>();
  private readonly activeChatsListeners = new Set<ActiveChatsListener>();
  private readonly settledListeners = new Set<InvocationSettledListener>();
  private readonly steerQueueCapacityListeners = new Set<(chatId: string) => void>();
  private readonly pendingGoalVerifications = new Map<string, RunRecord>();
  private readonly settlingRuns = new Map<string, RunRecord>();
  /** Original cleanup observations have no executable authority or chat-admission slot. */
  private readonly nativeCleanupQuarantine = new Map<string, { completion: WeakRef<Promise<void>>; outcome: "pending" | "failed" }>();
  private readonly browserLoginWaitingRuns = new Map<string, RunRecord>();
  private readonly steerQueues = new Map<string, QueuedSteer[]>();
  /** Queued directions waiting out a locked store before their next start attempt (drainSteerQueue, R-067). */
  private readonly steerDrainBackoff = new Map<string, { chatId: string; attempt: number; notBefore: number; firstAt?: number }>();
  private readonly nativePreparing = new Map<string, NativePreparingPending>();
  private ordinaryOneTurnObserver?: (source: OrdinaryOneTurnSource) => OrdinaryOneTurnObservation | undefined;
  private readonly nativeIngress = new Map<string, NativeIngressPending>();
  private readonly nativeClosedAdmissionRetries = new Map<string, ReturnType<typeof createClosedFactRetry>>();
  private readonly nativeIngressOriginals = new WeakMap<NativeInvocationIngressSource, { pending: NativeIngressPending; controller: AbortController; lifetime: NativePreparationLifetime; closedEntry?: { token: object; port: NativeOneStartPort } }>();
  private readonly nativeClosedPreparing = new WeakMap<NativeInvocationIngressSource, { ingress: NativeIngressPending; prepared: NativePreparingPending }>();
  private readonly nativePreparedDriversClosed = new WeakSet<NativePreparingPending>();
  /** Transport Stop observations, never physical checkpoint/child completion. */
  private readonly nativeCancellationObservations = new WeakSet<Promise<unknown>>();
  private readonly nativeClosedPreparedRetries = new Map<string, ReturnType<typeof createClosedFactRetry>>();
  /** Local resources are invoked once; only their exact owner-release storage
   * observation can be retried after the original driver really drains. */
  private readonly nativeLocalPreparedClosures = new WeakMap<NativePreparingPending, {
    record: RunRecord; expected: InvocationRunOwner;
    status: "rejected" | "cancelled" | "uncertain"; finishStarted: boolean;
    retry?: ReturnType<typeof createClosedFactRetry>;
  }>();
  private readonly nativePreparedEntries = new WeakMap<object, { expected: { chatId: string; runId: string | undefined }; admission: InvocationAdmissionIdentity; port: NativeOneStartPort; ingress?: NativeIngressPending; entered: boolean; closed: boolean; originalFailure?: unknown; localDispatchClosed?: boolean; retry?: ReturnType<typeof createClosedFactRetry> }>();
  private readonly nativeServiceObservationProofs = new WeakMap<object, { original: NativeInvocationIngressSource; pending: NativeIngressPending; kind: "native-execution-cwd-selected-v1" | "native-undispatched-start-v1" }>();
  private readonly nativeIngressNoStartProofs = new WeakMap<object, { original: NativeInvocationIngressSource; pending: NativeIngressPending; controller: AbortController; lifetime: NativePreparationLifetime }>();
  private readonly nativePreparationListeners = new Set<(event: { runId: string; chatId: string; status: "handed-off" | "rejected" | "cancelled" | "uncertain" }) => void>();
  private acceptingStarts = true;
  private readonly processLeaseWaits = new Map<string, ReturnType<typeof setTimeout>>();
  private foreignNativeStartFence?: (chatId: string) => boolean;

  /** Trusted host bootstrap only. A negative observer never grants execution
   * authority or infers quiescence from a disconnected native viewer. */
  setForeignNativeStartFence(fence: (chatId: string) => boolean): void {
    if (this.foreignNativeStartFence || typeof fence !== "function") throw new Error("invocation_native_fence_already_configured");
    this.foreignNativeStartFence = fence;
  }


  /** Install one stable local bootstrap adapter. It resolves the current One
   * owner for each invocation instead of retaining a stale account/service. */
  configureOrdinaryOneTurnObserver(observer: (source: OrdinaryOneTurnSource) => OrdinaryOneTurnObservation | undefined): void {
    if (typeof observer !== "function" || (this.ordinaryOneTurnObserver && this.ordinaryOneTurnObserver !== observer)) {
      throw new Error("ordinary_one_turn_observer_already_configured");
    }
    this.ordinaryOneTurnObserver = observer;
  }

  private assertOrdinaryOneTurnCurrent(pending: NativePreparingPending, turn: OrdinaryOneTurnLifetime, mode: OrdinaryOneTurnMode): void {
    // Names the failed condition (never a value) so a refusal says WHY; the owner never sees it, logs and run events do.
    function fail(condition: string): never {
      console.warn(`[ordinary-one-turn] source changed condition=${condition} mode=${mode}`);
      throw Object.assign(new Error("ordinary_one_turn_source_changed"), { code: "ordinary_one_turn_source_changed", detail: `condition=${condition}` });
    }
    const { chatId, runId, admission } = pending.binding;
    const current = getInvocationAdmission(runId);
    if (pending.ordinaryTurn !== turn) fail("turn_replaced");
    if (pending.request.chatId !== chatId || pending.request.runId !== runId) fail("request_identity");
    if (canonicalInvocationRequestJson(pending.request) !== admission.canonicalRequestJson) fail("request_canonical_json");
    if (JSON.stringify(getAuthenticatedActorIds()) !== turn.actor) fail("actor_ids");
    if (!current) fail("admission_row_missing");
    if (current!.chatId !== chatId || current!.runId !== runId) fail("admission_identity");
    if (current!.ownerProcessEpoch !== admission.ownerProcessEpoch) fail("admission_owner_epoch");
    if (current!.inputDigest !== turn.inputDigest) fail("admission_input_digest");
    if (current!.digestVersion !== INVOCATION_ADMISSION_DIGEST_VERSION) fail("admission_digest_version");
    const record = turn.record;
    const hasRecord = Boolean(record && [this.activeRuns.get(runId), this.settlingRuns.get(runId),
      this.pendingGoalVerifications.get(runId), this.browserLoginWaitingRuns.get(runId)].includes(record));
    if (turn.phase === "preparing") {
      if (this.nativePreparing.get(runId) !== pending) fail("preparing_not_registered");
      if (current!.status !== "pending") fail("preparing_admission_status");
      if (record) fail("preparing_has_record");
    } else if (turn.phase === "admitted") {
      if (current!.status !== "admitted") fail("admitted_admission_status");
      if (!record || !hasRecord) fail("admitted_record_missing");
      if (record!.controller !== pending.controller) fail("admitted_controller");
      if (record!.chatId !== chatId || record!.request.runId !== runId) fail("admitted_record_identity");
      if (!record!.ownerLease) fail("admitted_owner_lease_missing");
      if (mode === "scope" || mode === "execution" || mode === "message") {
        const lease = record!.ownerLease!;
        if (lease.chatId !== chatId || lease.runId !== runId) fail("lease_identity");
        if (!isLocalInvocationPreparationPort(pending.port) && lease.ownerId !== admission.ownerProcessEpoch) fail("lease_owner_epoch");
        assertInvocationRunOwner(lease);
      }
    } else if (turn.phase === "settled") {
      if (mode !== "settlement" || !turn.preparationClosed || !turn.executionClosed) fail("settled_phase_mode");
      if (current!.status !== "admitted" || !record || record.controller !== pending.controller) fail("settled_record");
      if (this.nativePreparing.has(runId) || hasRecord) fail("settled_still_live");
    } else if (mode !== "closed" || !turn.preparationClosed || this.nativePreparing.has(runId) || hasRecord) fail("closed_phase");
    if ((mode === "settlement" || mode === "closed") && record?.ownerLease) {
      const expected = record.ownerLease, custody = invocationRunOwners.getRunOwner(chatId, runId);
      if (!custody || custody.chatId !== chatId || custody.runId !== runId || custody.ownerId !== expected.ownerId
        || custody.ownerKind !== expected.ownerKind || custody.leaseId !== expected.leaseId || custody.state !== "released") fail("custody_not_released");
    }
    if (mode === "message") {
      const row = turn.messageId ? getDb().prepare("SELECT id, chat_id, role FROM chat_messages WHERE id=?")
        .get(turn.messageId) as { id: string; chat_id: string; role: string } | undefined : undefined;
      if (!row || row.id !== turn.messageId || row.chat_id !== chatId || row.role !== "user") fail("prompt_row");
    }
  }

  private finishOrdinaryOneTurn(pending: NativePreparingPending, outcome: "preparation" | "execution" | "closed"): void {
    const turn = pending.ordinaryTurn;
    if (!turn || turn.phase === "settled" || turn.phase === "closed") return;
    if (outcome === "execution") turn.executionClosed = true;
    else turn.preparationClosed = true;
    if (outcome === "closed") turn.phase = "closed";
    else if (turn.preparationClosed && turn.executionClosed) turn.phase = "settled";
    else return;
    // A failed ledger observation cannot veto unconditional Stop/physical
    // cleanup or authorize any replay of the already-owned invocation.
    try {
      if (turn.phase === "closed") turn.observation?.onPreparationClosed();
      else turn.observation?.onSettled();
    } catch (error) { console.warn("[invocation] ordinary One observation remains unconfirmed:", error); }
  }

  private nativeCleanupObservers(runId: string, observation: { completion: WeakRef<Promise<void>>; outcome: "pending" | "failed" }): [() => void, () => void] {
    // This callback scope contains only the service and thin diagnostic record.
    // It never receives the original request, pending source, or cleanup promise.
    return [() => {
      if (this.nativeCleanupQuarantine.get(runId) === observation) this.nativeCleanupQuarantine.delete(runId);
    }, () => {
      if (this.nativeCleanupQuarantine.get(runId) === observation) observation.outcome = "failed";
      console.warn("[invocation] native cleanup remains unconfirmed", { runId });
    }];
  }

  private quarantineNativeCleanup(runId: string, held: { preparation?: NativePreparingPending; ingress?: NativeIngressPending; completion: Promise<void> }): void {
    const observation = { completion: new WeakRef(held.completion), outcome: "pending" as "pending" | "failed" };
    this.nativeCleanupQuarantine.set(runId, observation);
    while (this.nativeCleanupQuarantine.size > 128) this.nativeCleanupQuarantine.delete(this.nativeCleanupQuarantine.keys().next().value!);
    // The resource owner retains real work. Diagnostic observers are created
    // in a separate scope so an unsettled join cannot retain this source graph.
    void held.completion.then(...this.nativeCleanupObservers(runId, observation));
  }

  /** Called only after the original execution lifetime and its attached children settle.
   * Exact released ownership closes execution authority; cleanup success is separate. */
  private retireDrainedNativeExecution(runId: string, record: RunRecord, pending: NativePreparingPending): boolean {
    const expected = record.ownerLease;
    if (!expected || expected.runId !== runId || expected.chatId !== record.chatId
      || pending.binding.runId !== runId || pending.binding.chatId !== record.chatId
      || pending.controller !== record.controller || pending.startBoundary.ownerLease !== expected || !pending.startBoundary.handedOff
      || !pending.preparationLifetime.admissionClosed || pending.preparationLifetime.pendingCount !== 0
      || this.settlingRuns.get(runId) !== record || this.activeRuns.has(runId)) return false;
    const custody = invocationRunOwners.getRunOwner(record.chatId, runId);
    if (!custody || custody.state !== "released" || custody.chatId !== expected.chatId || custody.runId !== expected.runId
      || custody.ownerId !== expected.ownerId || custody.ownerKind !== expected.ownerKind || custody.leaseId !== expected.leaseId) return false;
    const preparing = this.nativePreparing.get(runId), ingress = this.nativeIngress.get(runId);
    if (preparing && preparing !== pending) return false;
    if (ingress && (ingress.port !== pending.port || ingress.controller !== pending.controller
      || ingress.lifetime !== pending.preparationLifetime || !ingress.handedOff)) return false;
    // Old source proofs still reference their originals, but their live-map guards now fail.
    if (preparing) this.nativePreparing.delete(runId);
    if (ingress) { ingress.closedExecutionLease = Object.freeze({ ...expected }); this.nativeIngress.delete(runId); }
    this.settlingRuns.delete(runId);
    this.finishOrdinaryOneTurn(pending, "preparation");
    if (!this.nativeCleanupQuarantine.has(runId)) {
      const completion = Promise.resolve().then(() => pending.port.finish(pending.binding, "settled"));
      const held = { preparation: pending, completion };
      this.quarantineNativeCleanup(runId, held);
    }
    return true;
  }

  /** Actual local driver closure only. Durable admission/lease authority is
   * checked separately by the unchanged retirement CAS. This admits no turn. */
  private nativePreparedDispatchLocallyClosed(pending: NativePreparingPending): boolean {
    // Genuine same-process ports still own their resource-quiesce/release path;
    // their admission epoch is intentionally distinct from process owner ID.
    if (isLocalInvocationPreparationPort(pending.port)) return false;
    const { binding, controller, preparationLifetime: lifetime, startBoundary: boundary } = pending;
    const runId = binding.runId, ingress = this.nativeIngress.get(runId);
    if (!this.nativePreparedDriversClosed.has(pending) || this.nativePreparing.get(runId) !== pending || boundary.handedOff
      || !lifetime.admissionClosed || lifetime.pendingCount !== 0
      || (ingress && (ingress.port !== pending.port || ingress.controller !== controller || ingress.lifetime !== lifetime || !ingress.handedOff))) return false;
    const record = this.activeRuns.get(runId) ?? this.settlingRuns.get(runId);
    if (record && (record.chatId !== binding.chatId || record.controller !== controller || record.completion || record.mainLifetime)) return false;
    if (boundary.crossed && (!record || !boundary.ownerLease || record.ownerLease !== boundary.ownerLease || boundary.runId !== runId
      || boundary.ownerLease.chatId !== binding.chatId || boundary.ownerLease.runId !== runId
      || boundary.ownerLease.ownerId !== binding.admission.ownerProcessEpoch)) return false;
    return boundary.crossed || (!record && !boundary.ownerLease);
  }

  /** Only the original semantic ACK join is skipped. This physical fact never
   * replaces the durable row/lease CAS or its fresh-admission/writer fences. */
  private nativeSourceDispatchLocallyClosed(original: NativeInvocationIngressSource): boolean {
    const held = this.nativeIngressOriginals.get(original), pending = held?.pending;
    if (!pending || pending.original !== original || held!.controller !== pending.controller || held!.lifetime !== pending.lifetime
      || !pending.handedOff || !pending.port || !pending.controller.signal.aborted
      || !pending.lifetime.admissionClosed || pending.lifetime.pendingCount !== 0) return false;
    const runId = pending.source.binding.runId, current = this.nativeIngress.get(runId), prepared = this.nativePreparing.get(runId);
    if (current && current !== pending) return false;
    if (prepared) return current === pending && prepared.controller === pending.controller && prepared.port === pending.port
      && prepared.preparationLifetime === pending.lifetime && this.nativePreparedDispatchLocallyClosed(prepared);
    if (this.activeRuns.has(runId) || this.settlingRuns.has(runId)) return false;
    const closed = this.nativeClosedPreparing.get(original);
    if (current === undefined && closed?.ingress === pending && pending.frontier === "closed-prepared") {
      const driver = closed.prepared;
      return driver.controller === pending.controller && driver.port === pending.port && driver.preparationLifetime === pending.lifetime
        && driver.dispatchClosed === true && !driver.startBoundary.handedOff && this.nativePreparedDriversClosed.has(driver);
    }
    const fact = held!.closedEntry;
    if (!fact || fact.port !== pending.port) return false;
    const entry = this.nativePreparedEntries.get(fact.token);
    if (!entry) return current === undefined && pending.frontier === "closed-prepared";
    return current === pending && !entry.entered && entry.closed && entry.localDispatchClosed === true
      && entry.ingress === pending && entry.port === pending.port
      && entry.expected.chatId === pending.source.binding.chatId && entry.expected.runId === runId
      && entry.admission.chatId === pending.source.binding.chatId && entry.admission.runId === runId
      && entry.admission.ownerProcessEpoch === pending.source.binding.ownerProcessEpoch
      && createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(entry.admission.canonicalRequestJson).digest("hex") === pending.source.binding.inputDigest;
  }

  /** Only startNativePrepared creates this original entry after consuming its
   * genuine Main admission. Its monotonic marker precedes prepared registration. */
  private async retireClosedPreparedEntry(token: object): Promise<boolean> {
    const entry = this.nativePreparedEntries.get(token);
    if (!entry || entry.entered || !entry.closed) return false;
    const a = entry.admission, ingress = entry.ingress, runId = a.runId;
    if (a.chatId !== entry.expected.chatId || runId !== entry.expected.runId) return false;
    if (this.nativePreparing.has(runId) || this.activeRuns.has(runId) || this.settlingRuns.has(runId)) return false;
    const current = this.nativeIngress.get(runId);
    if (current !== ingress || (ingress && (ingress.port !== entry.port || !ingress.handedOff || this.nativeIngressOriginals.get(ingress.original)?.pending !== ingress))) return false;
    if (ingress) {
      ingress.lifetime.closeAdmission();
      if (!ingress.controller.signal.aborted) ingress.controller.abort(entry.originalFailure);
      await ingress.lifetime.quiescent(); await this.drainNativeIngressRetained(ingress);
      if (this.nativeIngress.get(runId) !== ingress || this.nativePreparing.has(runId) || this.activeRuns.has(runId) || this.settlingRuns.has(runId)) return false;
    }
    if (this.nativePreparedEntries.get(token) !== entry || entry.entered || !entry.closed) return false;
    // This original never-entered driver's lifetime and unknown retained work
    // have drained. Keep only a thin token/port fact, not its request/admission.
    entry.localDispatchClosed = true;
    if (ingress) {
      const held = this.nativeIngressOriginals.get(ingress.original);
      if (held?.pending !== ingress || held.controller !== ingress.controller || held.lifetime !== ingress.lifetime) return false;
      held.closedEntry = { token, port: entry.port };
    }
    const verifyClosed = (allowWrite: boolean): boolean => {
      if (entry.entered || !entry.closed || invocationRunOwners.getRunOwner(a.chatId, runId)
        || getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(runId)) return false;
      const row = getInvocationAdmission(runId);
      if (!row || row.chatId !== a.chatId || row.ownerProcessEpoch !== a.ownerProcessEpoch
        || row.inputDigest !== createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(a.canonicalRequestJson).digest("hex")) return false;
      if (row.status === "rejected") return true;
      if (row.status !== "pending" || !allowWrite) return false;
      return decideInvocationAdmission({ ...a, decision: "rejected", reasonCode: "native_prepared_entry_closed",
        noStartProof: { kind: "owner-start-boundary-not-crossed", verifiedOwnerProcessEpoch: a.ownerProcessEpoch } }).kind === "rejected";
    };
    let closed: boolean;
    try { closed = getDb().transaction(() => verifyClosed(true)).immediate(); }
    catch (cause) { if (verifyClosed(false)) closed = true; else throw cause; }
    if (!closed) return false;
    entry.retry?.stop();
    this.nativePreparedEntries.delete(token);
    if (ingress) { ingress.frontier = "closed-prepared"; this.nativeIngress.delete(runId); }
    this.quarantineNativeCleanup(runId, { completion: this.observeClosedPreparedCleanup(entry.port, { chatId: a.chatId, runId, admission: a }, "uncertain") });
    this.publishActiveChats(); this.drainSteerQueue(a.chatId);
    return true;
  }

  private async reconcileClosedPreparedEntry(token: object): Promise<void> {
    const entry = this.nativePreparedEntries.get(token);
    if (!entry || entry.entered || !entry.closed) return;
    try {
      if (!await this.retireClosedPreparedEntry(token)) { entry.retry?.stop(); entry.retry = undefined; }
    } catch {
      if (!entry.retry) entry.retry = createClosedFactRetry({
        observe: () => this.reconcileClosedPreparedEntry(token),
        schedule: (retry, delay) => { const timer = setTimeout(retry, delay); timer.unref?.(); return () => clearTimeout(timer); },
      });
      entry.retry.request();
    }
  }

  /** Same-process resource cleanup already ran once. This observes only the
   * original locally-owned lease; no producer, port or cleanup is replayed. */
  private async reconcileClosedLocalPrepared(pending: NativePreparingPending): Promise<void> {
    const held = this.nativeLocalPreparedClosures.get(pending);
    if (!held || held.finishStarted) return;
    const { binding, controller, preparationLifetime: lifetime, startBoundary: boundary } = pending;
    const runId = binding.runId, expected = held.expected, record = held.record;
    const deny = (): void => { held.retry?.stop(); held.retry = undefined; };
    if (!isLocalInvocationPreparationPort(pending.port) || this.nativePreparing.get(runId) !== pending
      || !this.nativePreparedDriversClosed.has(pending) || !lifetime.admissionClosed || lifetime.pendingCount !== 0
      || !boundary.crossed || boundary.handedOff || boundary.runId !== runId || boundary.ownerLease !== expected
      || record.ownerLease !== expected || record.chatId !== binding.chatId || record.controller !== controller
      || record.completion || record.mainLifetime || this.nativeIngress.has(runId)
      || (this.activeRuns.has(runId) && this.activeRuns.get(runId) !== record)
      || (this.settlingRuns.has(runId) && this.settlingRuns.get(runId) !== record)) { deny(); return; }
    const verifyReleased = (allowWrite: boolean): boolean => {
      const admission = getInvocationAdmission(runId), process = invocationProcessOwner();
      if (!admission || admission.status !== "admitted" || admission.chatId !== binding.chatId
        || admission.ownerProcessEpoch !== binding.admission.ownerProcessEpoch
        || admission.inputDigest !== createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(binding.admission.canonicalRequestJson).digest("hex")
        || expected.chatId !== binding.chatId || expected.runId !== runId
        || expected.ownerId !== process.ownerId || expected.ownerKind !== process.ownerKind) return false;
      const owner = invocationRunOwners.getRunOwner(binding.chatId, runId);
      const same = (value: InvocationRunOwner | null): boolean => !!value && value.chatId === expected.chatId && value.runId === expected.runId
        && value.ownerId === expected.ownerId && value.ownerKind === expected.ownerKind && value.leaseId === expected.leaseId;
      if (!same(owner)) return false;
      if (owner!.state !== "released") {
        if (!allowWrite) return false;
        invocationRunOwners.release(expected);
      }
      const released = invocationRunOwners.getRunOwner(binding.chatId, runId);
      return same(released) && released!.state === "released";
    };
    let released: boolean;
    try {
      try { released = getDb().transaction(() => verifyReleased(true)).immediate(); }
      catch (cause) { if (verifyReleased(false)) released = true; else throw cause; }
    } catch {
      if (!held.retry) held.retry = createClosedFactRetry({
        observe: () => this.reconcileClosedLocalPrepared(pending),
        schedule: (observe, delay) => { const timer = setTimeout(observe, delay); timer.unref?.(); return () => clearTimeout(timer); },
      });
      held.retry.request();
      return;
    }
    if (!released) { deny(); return; }
    deny(); held.finishStarted = true;
    if (this.nativePreparing.get(runId) !== pending || boundary.handedOff || record.completion || record.mainLifetime) return;
    pending.dispatchClosed = true;
    if (this.activeRuns.get(runId) === record) this.activeRuns.settle(runId);
    if (this.settlingRuns.get(runId) === record) this.settlingRuns.delete(runId);
    // The only registered local finish implementations delegate to the renderer
    // no-op. Observe it once without turning its response into executable custody.
    let completion: Promise<void>;
    try { completion = Promise.resolve(pending.port.finish(binding, held.status)); }
    catch (cause) { completion = Promise.reject(cause); }
    this.quarantineNativeCleanup(runId, { completion });
    this.nativeLocalPreparedClosures.delete(pending);
    this.nativePreparing.delete(runId);
    this.publishActiveChats(); this.finishOrdinaryOneTurn(pending,"closed"); this.drainSteerQueue(binding.chatId);
  }

  /** The original driver has returned after closing its generator and draining
   * the real preparation lifetime. This retires executable custody, never claims. */
  private retireClosedPreparedNoBrain(pending: NativePreparingPending, error: unknown): boolean {
    const { binding, controller, preparationLifetime: lifetime, startBoundary: boundary } = pending;
    const runId = binding.runId, ingress = this.nativeIngress.get(runId);
    if (!this.nativePreparedDriversClosed.has(pending) || this.nativePreparing.get(runId) !== pending || boundary.handedOff || pending.dispatchClosed
      || !lifetime.admissionClosed || lifetime.pendingCount !== 0
      || (ingress && (ingress.port !== pending.port || ingress.controller !== controller || ingress.lifetime !== lifetime || !ingress.handedOff))) return false;
    const record = this.activeRuns.get(runId) ?? this.settlingRuns.get(runId);
    if (record && (record.chatId !== binding.chatId || record.controller !== controller || record.completion || record.mainLifetime)) return false;
    if (boundary.crossed && (!record || !boundary.ownerLease || record.ownerLease !== boundary.ownerLease || boundary.runId !== runId)) return false;
    if (!boundary.crossed && (record || boundary.ownerLease)) return false;
    // No asynchronous driver work survives this call site. Closing its original
    // controller cannot cancel a handed-off provider (explicitly denied above).
    if (!controller.signal.aborted) controller.abort(error);
    const verifyClosed = (allowWrite: boolean): boolean => {
      const admission = getInvocationAdmission(runId), expected = boundary.ownerLease;
      if (!admission || admission.chatId !== binding.chatId || admission.ownerProcessEpoch !== binding.admission.ownerProcessEpoch
        || admission.inputDigest !== createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(binding.admission.canonicalRequestJson).digest("hex")) return false;
      const owner = invocationRunOwners.getRunOwner(binding.chatId, runId), active = invocationRunOwners.getActiveOwner(binding.chatId);
      if (active && (!expected || active.runId !== runId || active.leaseId !== expected.leaseId || active.ownerId !== expected.ownerId || active.ownerKind !== expected.ownerKind)) return false;
      if (!boundary.crossed) {
        if (owner || getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(runId)) return false;
        if (admission.status === "pending") {
          if (!allowWrite) return false;
          const decision = decideInvocationAdmission({ ...binding.admission, decision: "rejected", reasonCode: "native_prepared_closed_before_start",
            noStartProof: { kind: "owner-start-boundary-not-crossed", verifiedOwnerProcessEpoch: binding.admission.ownerProcessEpoch } });
          if (decision.kind !== "rejected") return false;
        } else if (admission.status !== "rejected") return false;
        return true;
      }
      if (!expected || admission.status !== "admitted" || !owner || owner.chatId !== expected.chatId || owner.runId !== expected.runId
        || owner.ownerId !== expected.ownerId || owner.ownerKind !== expected.ownerKind || owner.leaseId !== expected.leaseId
        || expected.ownerId !== binding.admission.ownerProcessEpoch) return false;
      if (owner.state !== "released") { if (!allowWrite) return false; invocationRunOwners.release(expected); }
      const released = invocationRunOwners.getRunOwner(binding.chatId, runId);
      return !!released && released.state === "released" && released.chatId === expected.chatId && released.runId === expected.runId
        && released.ownerId === expected.ownerId && released.ownerKind === expected.ownerKind && released.leaseId === expected.leaseId;
    };
    let closed: boolean;
    try { closed = getDb().transaction(() => verifyClosed(true)).immediate(); }
    catch (cause) { if (verifyClosed(false)) closed = true; else throw cause; }
    if (!closed) return false;
    pending.dispatchClosed = true;
    const retry = this.nativeClosedPreparedRetries.get(runId);
    if (retry) { retry.stop(); this.nativeClosedPreparedRetries.delete(runId); }
    if (boundary.crossed && boundary.runId) {
      // Receipt observation failure cannot undo the actual local closed frontier.
      try { this.releaseUndispatchedStart(boundary.runId, binding.chatId, error, isLocalInvocationPreparationPort(pending.port) ? boundary.cleanups ?? [] : []); }
      catch { console.warn("[invocation] closed native receipt cleanup remains unconfirmed", { runId }); }
      if (this.activeRuns.get(runId) === record) this.activeRuns.settle(runId);
      if (this.settlingRuns.get(runId) === record) this.settlingRuns.delete(runId);
    }
    if (ingress) {
      ingress.frontier = "closed-prepared";
      if (boundary.ownerLease) { ingress.undispatchedLease = Object.freeze({ ...boundary.ownerLease }); ingress.closedExecutionLease = ingress.undispatchedLease; }
      // The opaque original remains the weak key for its terminal observation.
      // Neither active selection nor executable capacity retains this graph.
      this.nativeClosedPreparing.set(ingress.original, { ingress, prepared: pending });
      this.nativeIngress.delete(runId);
    }
    this.nativePreparing.delete(runId);
    this.finishOrdinaryOneTurn(pending, "closed");
    this.publishActiveChats();
    return true;
  }

  private scheduleClosedPreparedReconciliation(pending: NativePreparingPending, error: unknown, status: "rejected" | "cancelled" | "uncertain"): void {
    const runId = pending.binding.runId;
    let retry = this.nativeClosedPreparedRetries.get(runId);
    if (!retry) {
      retry = createClosedFactRetry({
        observe: () => {
          if (this.nativePreparing.get(runId) !== pending || !this.nativePreparedDriversClosed.has(pending)) {
            retry!.stop(); this.nativeClosedPreparedRetries.delete(runId); return;
          }
          try {
            if (this.retireClosedPreparedNoBrain(pending, error)) {
              this.quarantineNativeCleanup(runId, { completion: this.observeClosedPreparedCleanup(pending.port, pending.binding, status) });
              this.drainSteerQueue(pending.binding.chatId);
            } else { retry!.stop(); this.nativeClosedPreparedRetries.delete(runId); }
          } catch { retry!.request(); } // Reobserve only this original physically closed CAS.
        },
        schedule: (observe, delay) => { const timer = setTimeout(observe, delay); timer.unref?.(); return () => clearTimeout(timer); },
      });
      this.nativeClosedPreparedRetries.set(runId, retry);
    }
    retry.request();
  }

  private observeClosedPreparedCleanup(port: NativeOneStartPort, binding: NativeOneStartBinding, status: "rejected" | "cancelled" | "uncertain"): Promise<void> {
    // Only the actual port/resource owner enters this async scope. It never
    // captures the service pending/request/controller graph for diagnostics.
    return Promise.resolve().then(async () => { await port.quiesce(binding, status); await port.finish(binding, status); });
  }

  private scheduleClosedNativeIngressReconciliation(pending: NativeIngressPending, status: "cancelled" | "uncertain"): void {
    const runId = pending.source.binding.runId;
    let retry = this.nativeClosedAdmissionRetries.get(runId);
    if (!retry) {
      retry = createClosedFactRetry({
        observe: () => {
          if (this.nativeIngress.get(runId) !== pending) { retry!.stop(); this.nativeClosedAdmissionRetries.delete(runId); return; }
          try { if (this.retireClosedNativeIngress(pending, status)) this.drainSteerQueue(pending.source.binding.chatId); }
          catch { /* A changed/unknown source is not a new no-start proof. */ }
          // A storage exception in retire requested another observation. A false
          // source/tuple/owner/receipt guard terminates this original observer.
          if (!retry!.pending) { retry!.stop(); this.nativeClosedAdmissionRetries.delete(runId); }
        },
        schedule: (observe, delay) => { const timer = setTimeout(observe, delay); timer.unref?.(); return () => clearTimeout(timer); },
      });
      this.nativeClosedAdmissionRetries.set(runId, retry);
    }
    retry.request();
  }

  /** Actual original authorize/read returned or threw, and prepared entry never occurred. */
  private retireClosedNativeIngress(pending: NativeIngressPending, status: "cancelled" | "uncertain"): boolean {
    const original = this.nativeIngressOriginals.get(pending.original), runId = pending.source.binding.runId;
    let ownerObservationFailed = false;
    const assertClosed = () => {
      if (original?.pending !== pending || original.controller !== pending.controller || original.lifetime !== pending.lifetime
        || this.nativeIngress.get(runId) !== pending || pending.handedOff || pending.port !== undefined
        || !pending.controller.signal.aborted || !pending.lifetime.admissionClosed || pending.lifetime.pendingCount !== 0
        || this.nativePreparing.has(runId) || this.activeRuns.has(runId) || this.settlingRuns.has(runId)) throw new Error("native_ingress_dispatch_not_closed");
      let owner: InvocationRunOwner | null;
      try { owner = invocationRunOwners.getRunOwner(pending.source.binding.chatId, runId); }
      catch (error) { ownerObservationFailed = true; throw error; }
      if (owner) throw new Error("native_ingress_dispatch_not_closed");
    };
    let proof: object;
    try {
      assertClosed();
      pending.source.closeUnused(pending.controller.signal);
      proof = pending.returnedPrepared
        ? pending.source.captureClosedReturnedBeforeTransfer(pending.returnedPrepared, pending.lifetime, assertClosed)
        : pending.source.captureClosedBeforePrepared(assertClosed);
    } catch (error) {
      if (!ownerObservationFailed) throw error;
      this.scheduleClosedNativeIngressReconciliation(pending, status);
      return false;
    }
    let decision: ReturnType<typeof rejectClosedNativeIngressAdmission>;
    try { decision = rejectClosedNativeIngressAdmission(proof); }
    catch (error) {
      // COMMIT can succeed while its observer throws. A truthful exact terminal
      // row plus the same closed original fact needs no fabricated cleanup ACK.
      let committed: ReturnType<typeof getInvocationAdmission> = null;
      try {
        assertClosed();
        const row = getInvocationAdmission(runId), b = pending.source.binding;
        if (row?.status === "rejected" && row.chatId === b.chatId && row.inputDigest === b.inputDigest && row.ownerProcessEpoch === b.ownerProcessEpoch
          && !getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(runId)) committed = row;
      } catch {}
      if (committed) decision = { kind: "rejected", admission: committed };
      else {
        this.scheduleClosedNativeIngressReconciliation(pending, status);
        return false;
      }
    }
    if (decision.kind !== "rejected") return false;
    const retry = this.nativeClosedAdmissionRetries.get(runId);
    if (retry) { retry.stop(); this.nativeClosedAdmissionRetries.delete(runId); }
    pending.frontier = "closed-no-start";
    pending.returnedPrepared = undefined;
    // The original cancel/quiesce/finish promises stay observed; neither is replayed or treated as an ACK.
    const completion = Promise.resolve().then(async () => {
      await pending.source.quiesce();
      await this.drainNativeIngressRetained(pending);
      await pending.source.finish(status);
    });
    const held = { ingress: pending, completion };
    this.quarantineNativeCleanup(runId, held);
    this.nativeIngress.delete(runId);
    this.publishActiveChats();
    return true;
  }

  /** Additive quiescence fact; never a fabricated invocation terminal receipt. */
  onNativePreparationQuiesced(listener: (event: { runId: string; chatId: string; status: "handed-off" | "rejected" | "cancelled" | "uncertain" }) => void): () => void {
    this.nativePreparationListeners.add(listener);
    return () => this.nativePreparationListeners.delete(listener);
  }

  /** Cache before invoking the original callback: synchronous reentry cannot create a second cancellation. */
  private cancelNativeIngress(pending: NativeIngressPending): Promise<void> {
    if (!pending.cancelPromise) {
      const cancel = Promise.resolve().then(() => pending.source.cancel());
      pending.cancelPromise = cancel;
      pending.retained.add(cancel);
      this.nativeCancellationObservations.add(cancel);
      // Actual cancellation is requested once; an ACK remains only an observed
      // result. The original source/controller/lifetime owns dispatch closure.
      void cancel.catch(() => {});
    }
    return pending.cancelPromise;
  }

  private async drainNativeIngressRetained(pending: NativeIngressPending): Promise<void> {
    let size: number;
    do { size = pending.retained.size; await Promise.allSettled([...pending.retained].filter(p => !this.nativeCancellationObservations.has(p))); }
    while (pending.retained.size !== size);
  }

  private assertNativeIngressNoStart(original: NativeInvocationIngressSource, pending: NativeIngressPending): void {
    const originalRecord = this.nativeIngressOriginals.get(original);
    if (originalRecord?.pending !== pending || originalRecord.controller !== pending.controller || originalRecord.lifetime !== pending.lifetime
      || (this.nativeIngress.get(pending.source.binding.runId) !== pending && !(pending.frontier === "closed-no-start" && this.nativeIngress.get(pending.source.binding.runId) === undefined))
      || pending.frontier !== "closed-no-start" || pending.handedOff || pending.port !== undefined
      || !pending.lifetime.admissionClosed || pending.lifetime.pendingCount !== 0
      || !pending.cancelPromise) {
      throw Object.assign(new Error("native_ingress_no_start_not_closed"), { code: "native_ingress_no_start_not_closed" });
    }
    pending.source.assertCurrent();
  }

  /** Native host observer only. This token is not serializable authority or an admission/DB decision. */
  takeNativeIngressNoStartProof(original: NativeInvocationIngressSource): object {
    const pending = this.nativeIngressOriginals.get(original)?.pending;
    if (!pending) throw Object.assign(new Error("native_ingress_no_start_source_required"), { code: "native_ingress_no_start_source_required" });
    this.assertNativeIngressNoStart(original, pending);
    if (pending.proofMinted) throw Object.assign(new Error("native_ingress_no_start_proof_consumed"), { code: "native_ingress_no_start_proof_consumed" });
    pending.proofMinted = true;
    const proof = Object.freeze({});
    this.nativeIngressNoStartProofs.set(proof, { original, pending, controller: pending.controller, lifetime: pending.lifetime });
    return proof;
  }

  /** Burn before revalidation. The passive signing projection never substitutes for this local consume. */
  consumeNativeIngressNoStartProof(original: NativeInvocationIngressSource, proof: object): Readonly<{ kind: "native-ingress-closed-before-prepared-v1"; binding: Readonly<NativeIngressBinding> }> {
    const record = this.nativeIngressNoStartProofs.get(proof);
    this.nativeIngressNoStartProofs.delete(proof);
    if (!record || record.original !== original || record.controller !== record.pending.controller || record.lifetime !== record.pending.lifetime) {
      throw Object.assign(new Error("native_ingress_no_start_proof_required"), { code: "native_ingress_no_start_proof_required" });
    }
    this.assertNativeIngressNoStart(original, record.pending);
    return Object.freeze({ kind: "native-ingress-closed-before-prepared-v1", binding: Object.freeze({ ...record.pending.source.binding }) });
  }

  private assertNativeServiceObservationSelection(pending: NativeIngressPending): void {
    const held = this.nativeIngressOriginals.get(pending.original), prepared = this.nativePreparing.get(pending.source.binding.runId);
    if (held?.pending !== pending || held.controller !== pending.controller || held.lifetime !== pending.lifetime
      || !prepared || prepared.controller !== pending.controller || prepared.port !== pending.port || prepared.preparationLifetime !== pending.lifetime
      || pending.controller.signal.aborted || pending.lifetime.admissionClosed) throw new Error("native_service_cwd_source_required");
    pending.source.assertCurrent();
  }

  private assertNativeServiceObservation(original: NativeInvocationIngressSource, pending: NativeIngressPending, kind: "native-execution-cwd-selected-v1" | "native-undispatched-start-v1"): void {
    const held = this.nativeIngressOriginals.get(original), prepared = this.nativePreparing.get(pending.source.binding.runId);
    const closed = kind === "native-undispatched-start-v1" ? this.nativeClosedPreparing.get(original) : undefined;
    const selected = prepared ?? closed?.prepared;
    if (held?.pending !== pending || held.controller !== pending.controller || held.lifetime !== pending.lifetime
      || (this.nativeIngress.get(pending.source.binding.runId) !== pending && closed?.ingress !== pending) || !pending.handedOff || !pending.port
      || !selected || selected.controller !== pending.controller || selected.port !== pending.port
      || selected.preparationLifetime !== pending.lifetime || (closed && !selected.dispatchClosed)) throw new Error("native_service_observation_source_required");
    pending.source.assertCurrent();
    if (kind === "native-execution-cwd-selected-v1") {
      if (!pending.selectedCwd || pending.controller.signal.aborted || pending.lifetime.admissionClosed) throw new Error("native_service_cwd_not_selected");
    } else {
      const lease = pending.undispatchedLease, current = lease && invocationRunOwners.getRunOwner(lease.chatId, lease.runId);
      if (!lease || !pending.lifetime.admissionClosed || pending.lifetime.pendingCount !== 0
        || !current || current.state !== "released" || current.leaseId !== lease.leaseId || current.ownerId !== lease.ownerId
        || current.ownerKind !== "daemon" || current.runId !== pending.source.binding.runId || current.chatId !== pending.source.binding.chatId
        || current.ownerId !== pending.source.binding.ownerProcessEpoch) throw new Error("native_service_undispatched_not_released");
    }
  }

  /** Native bootstrap observes exact generator selection/failure, never caller JSON. */
  takeNativeServiceObservationProof(original: NativeInvocationIngressSource, kind: "native-execution-cwd-selected-v1" | "native-undispatched-start-v1"): object | undefined {
    const pending = this.nativeIngressOriginals.get(original)?.pending;
    if (!pending) throw new Error("native_service_observation_source_required");
    if (kind === "native-undispatched-start-v1" && !pending.undispatchedLease) return undefined;
    this.assertNativeServiceObservation(original, pending, kind);
    if (pending.observedKinds.has(kind)) throw new Error("native_service_observation_already_consumed");
    pending.observedKinds.add(kind);
    const proof = Object.freeze({});
    this.nativeServiceObservationProofs.set(proof, { original, pending, kind });
    return proof;
  }

  consumeNativeServiceObservationProof(original: NativeInvocationIngressSource, proof: object) {
    const held = this.nativeServiceObservationProofs.get(proof);
    this.nativeServiceObservationProofs.delete(proof);
    if (!held || held.original !== original) throw new Error("native_service_observation_proof_required");
    this.assertNativeServiceObservation(original, held.pending, held.kind);
    const binding = Object.freeze({ ...held.pending.source.binding });
    return held.kind === "native-execution-cwd-selected-v1"
      ? Object.freeze({ kind: held.kind, binding, cwd: held.pending.selectedCwd! })
      : Object.freeze({ kind: held.kind, binding, leaseId: held.pending.undispatchedLease!.leaseId });
  }

  /** Private original-source close observation; no wire/PID/row grants cancellation. */
  cancelNativePreparationForSource(original: NativeInvocationIngressSource): "requested" | "already-requested" | "handed-off" | "not-found" {
    const observed = this.nativeIngressOriginals.get(original);
    if (!observed) return "not-found";
    const ingress = observed.pending, runId = ingress.source.binding.runId;
    if (this.nativeIngress.get(runId) !== ingress || ingress.original !== original
      || ingress.controller !== observed.controller || ingress.lifetime !== observed.lifetime) return "not-found";
    const preparing = this.nativePreparing.get(runId);
    if (preparing && (preparing.controller !== observed.controller || preparing.preparationLifetime !== observed.lifetime)) return "not-found";
    // The actual start boundary, not the still-pending transport reply, transfers execution custody.
    if (preparing?.startBoundary.handedOff || (!preparing && ingress.handedOff)) return "handed-off";
    ingress.lifetime.closeAdmission();
    const already = ingress.controller.signal.aborted;
    if (!already) ingress.controller.abort(Object.assign(new Error("native_preparation_channel_lost"), { code: "native_preparation_channel_lost" }));
    this.cancelNativeIngress(ingress);
    return already ? "already-requested" : "requested";
  }

  /** Original host source only: execution/dispatch authority, not remote cleanup success. */
  nativeExecutableAuthorityClosedForSource(original: NativeInvocationIngressSource): boolean {
    const held = this.nativeIngressOriginals.get(original), pending = held?.pending;
    if (!pending || held!.controller !== pending.controller || held!.lifetime !== pending.lifetime
      || !pending.lifetime.admissionClosed || pending.lifetime.pendingCount !== 0) return false;
    const b = pending.source.binding, runId = b.runId;
    if (this.nativeIngress.has(runId) || this.nativePreparing.has(runId) || this.activeRuns.has(runId) || this.settlingRuns.has(runId)) return false;
    const a = getInvocationAdmission(runId), owner = invocationRunOwners.getRunOwner(b.chatId, runId);
    if (!a || a.chatId !== b.chatId || a.inputDigest !== b.inputDigest || a.ownerProcessEpoch !== b.ownerProcessEpoch) return false;
    if (!pending.handedOff || pending.frontier === "closed-prepared" && a.status === "rejected") return (pending.frontier === "closed-no-start" || pending.frontier === "closed-prepared") && pending.controller.signal.aborted && a.status === "rejected" && !owner;
    const expected = pending.closedExecutionLease;
    return !!expected && a.status === "admitted" && !!owner && owner.state === "released"
      && owner.chatId === expected.chatId && owner.runId === expected.runId && owner.ownerId === expected.ownerId
      && owner.ownerKind === expected.ownerKind && owner.leaseId === expected.leaseId;
  }

  /** Local machine observations only; never a receipt, authorization or recovery decision. */
  private logNativePreparationFailure(runId: string, chatId: string, error: unknown, context: {
    phase: NativePreparationDiagnosticPhase; startBoundaryCrossed?: boolean; agentAppMode?: boolean;
  }): void {
    if (context.agentAppMode !== false) return;
    try {
      console.warn("[invocation] native preparation diagnostic", { runId, chatId,
        ...nativePreparationErrorDiagnostic(error, context, nativeOneStartCheckpointFailureKind) });
    } catch { /* Diagnostics cannot replace the original error or prevent cleanup. */ }
  }

  /** The no-start ledger keeps its outward code; this typed run event keeps the cause. Production 1.3.47 (2026-10-16):
   * the daemon wrapped a Main checkpoint refusal as runtime_turn_unsettled and its console is not persisted.
   * Machine identifiers only: phase, host kind, ledger code, checkpoint kind, cause codes. One event per error. */
  private recordStartRefusalCause(runId: string, chatId: string, error: unknown, context: { phase: string; reasonCode?: string; startBoundaryCrossed?: boolean }): void {
    try {
      if (error && typeof error === "object") { if (this.startRefusalCausesRecorded.has(error)) return; this.startRefusalCausesRecorded.add(error); }
      tryRecordRunEvent({ runId, chatId, kind: INVOCATION_START_REFUSAL_EVENT, payload: {
        schemaVersion: "agentlas.invocation-start-refusal.v1", phase: context.phase, host: invocationProcessOwner().ownerKind,
        ...(context.reasonCode ? { reasonCode: context.reasonCode } : {}),
        ...(typeof context.startBoundaryCrossed === "boolean" ? { startBoundaryCrossed: context.startBoundaryCrossed } : {}),
        ...preparationRefusalCause(error, nativeOneStartCheckpointFailureKind),
      } });
    } catch { /* Attribution never replaces the original refusal. */ }
  }
  private readonly startRefusalCausesRecorded = new WeakSet<object>();

  /** Source capability, not a request/JSON switch. Registration precedes every chunk await. */
  async startNativeIngress(source: NativeInvocationIngressSource): Promise<InvocationStartResult> {
    const owned = takeNativeInvocationIngressSource(source), binding = owned.binding;
    const backgroundObservation=Boolean(effectObservationTicket(binding.runId));
    if (this.nativeIngress.has(binding.runId) || this.nativePreparing.has(binding.runId)) throw cleanupPending("cleanup_same_run_in_flight");
    const chatBusy = !backgroundObservation && ([...this.nativeIngress.values()].some(p=>p.source.binding.chatId===binding.chatId && !effectObservationTicket(p.source.binding.runId))
      || [...this.nativePreparing.values()].some(p=>p.binding.chatId===binding.chatId && !effectObservationTicket(p.binding.runId))
      || this.activeChatIds().includes(binding.chatId));
    let otherHostBusy = false;
    if (!chatBusy && !backgroundObservation) {
      try { const active = invocationRunOwners.getActiveOwner(binding.chatId); otherHostBusy = !!active && otherHostOwnsChat(active, invocationProcessOwner()); }
      catch { /* an unreadable owner table is not evidence of a busy chat: the claim at start decides */ }
    }
    const controller=new AbortController(), lifetime=createNativePreparationLifetime(binding), retained=new Set<Promise<unknown>>();
    const nativeActor = getAuthenticatedActorIds();
    const pending: NativeIngressPending={actorSnapshot:nativeActor ? Object.freeze({ ...nativeActor }) : null,source:owned,original:source,observedKinds:new Set(),controller,lifetime,retained,handedOff:false,port:undefined,cancelSettled:false,frontier:"open",proofMinted:false};
    this.nativeIngressOriginals.set(source,{pending,controller,lifetime});
    this.nativeIngress.set(binding.runId,pending);this.publishActiveChats();
    let status:"handed-off"|"cancelled"|"uncertain"="uncertain";
    let refusedBeforeStart=false;
    let diagnosticPhase: NativePreparationDiagnosticPhase = "native-ingress";
    let diagnosticAgentAppMode: boolean | undefined;
    try {
      // A distinct busy-chat capsule still owns genuine cancellation/quiescence
      // and a closed-before-prepared proof; it never leaks an unregistered source.
      // Nothing was authorized or read yet, so this is a definite pre-start refusal
      // (status "cancelled" = closed before start), not an uncertain execution.
      if (chatBusy) { refusedBeforeStart=true; throw Object.assign(new Error("invocation_chat_busy"),{code:"invocation_chat_busy"}); }
      // The other process (Desktop <-> background service) is running a turn of this chat: one host per chat at a time.
      if (otherHostBusy) { refusedBeforeStart=true; throw Object.assign(new Error(CHAT_BUSY_OTHER_HOST_CODE),{code:CHAT_BUSY_OTHER_HOST_CODE}); }
      // Shutdown closed admission before anything was authorized or read: a definite pre-start refusal, like a busy chat.
      if (!this.acceptingStarts) { refusedBeforeStart=true; throw Object.assign(new Error("desktop_execution_admission_closed"),{code:"desktop_execution_admission_closed"}); }
      diagnosticPhase="native-ingress-authorize";
      const admission=await withNativePreparationLifetime(lifetime,()=>runNativePreparation(()=>owned.authorize(controller.signal)));
      await lifetime.awaitRetained();owned.assertCurrent();controller.signal.throwIfAborted();
      diagnosticPhase="native-ingress-read";
      const prepared=await withNativePreparationLifetime(lifetime,()=>runNativePreparation(()=>owned.read(controller.signal)));
      pending.returnedPrepared=prepared;
      await lifetime.awaitRetained();
      owned.assertCurrent();controller.signal.throwIfAborted();
      diagnosticAgentAppMode=prepared.request.agentAppMode === true;
      diagnosticPhase="native-ingress-validation";
      const durable=validateNativeIngressRequest(binding,prepared.request);
      diagnosticPhase="native-prepared-start";
      const result=await this.startNativePrepared(prepared.request,prepared.port,admission,durable,undefined,undefined,prepared.hostNoticePurpose);
      status="handed-off";return result;
    } catch(cause) {
      status=controller.signal.aborted?"cancelled":"uncertain";
      if(controller.signal.aborted) throw controller.signal.reason;
      if(refusedBeforeStart){ status="cancelled"; throw markRefusedBeforeDispatch(cause); }
      this.recordStartRefusalCause(binding.runId,binding.chatId,cause,{phase:diagnosticPhase});
      // Every failure here precedes handoff, so nothing was dispatched: the refusal keeps its innermost machine code and
      // turnDelivery "not-dispatched", exactly as the Main-local start rethrows it (docs 31 W1, audit A7 M7). Wrapping it
      // as runtime_turn_unsettled ("may have acted") hid the real cause of the daemon's refused starts.
      const error=preDispatchRefusal(cause,diagnosticPhase,"native_ingress_refused");
      this.logNativePreparationFailure(binding.runId,binding.chatId,error,{phase:diagnosticPhase,agentAppMode:diagnosticAgentAppMode});
      throw error;
    } finally {
      if (!pending.handedOff) this.cancelNativeIngress(pending);
      lifetime.closeAdmission();await lifetime.quiescent();
      if (!pending.handedOff) {
        if (!controller.signal.aborted) controller.abort(new Error("native_ingress_dispatch_closed"));
        try {
          this.retireClosedNativeIngress(pending, controller.signal.aborted ? "cancelled" : "uncertain");
        } catch (cause) {
          // A missing/changed closed fact stays fenced; cleanup cannot replace
          // the original Stop, channel or request-validation failure.
          this.logNativePreparationFailure(binding.runId,binding.chatId,cause,{phase:"native-ingress-cleanup",agentAppMode:diagnosticAgentAppMode});
        }
      } else if (this.nativeSourceDispatchLocallyClosed(source)
        || (pending.frontier === "closed-prepared" && this.nativeExecutableAuthorityClosedForSource(source))) {
        // The exact closed prepared port already owns one cleanup observation.
        // Rejoining its cached semantic ACK here cannot hold nativeStart open.
      } else {
      await this.drainNativeIngressRetained(pending);
      try {
        await owned.quiesce();
        await this.drainNativeIngressRetained(pending);
        if (!pending.handedOff) pending.frontier="closed-no-start";
        await owned.finish(status);
      } catch(cause) { const error=new RuntimeTurnUnsettledError("native-ingress-cleanup");Object.defineProperty(error,"cause",{value:cause});
        this.logNativePreparationFailure(binding.runId,binding.chatId,error,{phase:"native-ingress-cleanup",agentAppMode:diagnosticAgentAppMode});throw error; }
      this.nativeIngress.delete(binding.runId);this.publishActiveChats();
      }
      for(const listener of this.nativePreparationListeners){try{listener({runId:binding.runId,chatId:binding.chatId,status});}catch{}}
    }
  }

  /** Private native bootstrap gate. The daemon host reserves exact input before this call, without await. */
  async startNativePrepared(req: McpInvocationRequest, port: NativeOneStartPort, mainAdmission: MainInvocationAdmission, durableAdmission: InvocationAdmissionIdentity,
    workspaceBinding?: InvocationWorkspaceBinding, executionContext?: InvocationExecutionContext, hostNoticePurpose?: ChatHostNotice["purpose"]): Promise<InvocationStartResult> {
    const admission = takeMainInvocationAdmission(mainAdmission, { chatId: req.chatId, runId: req.runId });
    if (!admission) throw new Error("native_one_main_admission_required");
    const token = Object.freeze({}), entry = { expected: { chatId: req.chatId, runId: req.runId }, admission: Object.freeze({ ...durableAdmission }), port, ingress: this.nativeIngress.get(req.runId ?? ""), entered: false, closed: false, originalFailure: undefined as unknown };
    this.nativePreparedEntries.set(token, entry);
    try {
      if (entry.ingress) {
        const prepared = entry.ingress.returnedPrepared;
        if (entry.ingress.handedOff || entry.ingress.port !== undefined || !prepared || prepared.request !== req || prepared.port !== port) throw new Error("native_ingress_original_prepared_required");
        entry.ingress.source.transferPreparedForEntry(prepared);
        entry.ingress.handedOff = true; entry.ingress.port = port; entry.ingress.returnedPrepared = undefined;
      }
      return await this.startNativePreparedOwned(req, port, admission, durableAdmission, () => { entry.entered = true; }, workspaceBinding, executionContext, hostNoticePurpose);
    } catch (error) {
      if (!entry.entered) {
        entry.closed = true; entry.originalFailure = error;
        if (entry.ingress && !entry.ingress.handedOff) this.nativePreparedEntries.delete(token);
        else await this.reconcileClosedPreparedEntry(token);
      }
      throw error;
    } finally { if (entry.entered) this.nativePreparedEntries.delete(token); }
  }

  private async startNativePreparedOwned(req: McpInvocationRequest, port: NativeOneStartPort, admission: MainInvocationAdmission, durableAdmission: InvocationAdmissionIdentity, enterPrepared: () => void,
    workspaceBinding?: InvocationWorkspaceBinding, executionContext?: InvocationExecutionContext, hostNoticePurpose?: ChatHostNotice["purpose"]): Promise<InvocationStartResult> {
    assertNativeOneStartPort(port);
    if (!req.runId || durableAdmission.runId !== req.runId || durableAdmission.chatId !== req.chatId) throw new Error("invocation_admission_request_identity_mismatch");
    const nativeRunId = req.runId;
    req = structuredClone(req);
    const freezeRequest = (value: unknown): void => { if (value && typeof value === "object") { for (const item of Object.values(value)) freezeRequest(item); Object.freeze(value); } };
    freezeRequest(req);
    if (canonicalInvocationRequestJson(req) !== durableAdmission.canonicalRequestJson) throw new Error("invocation_admission_request_identity_mismatch");
    const reservation = getInvocationAdmission(nativeRunId);
    if (!reservation || reservation.chatId !== req.chatId || reservation.ownerProcessEpoch !== durableAdmission.ownerProcessEpoch || reservation.status !== "pending"
      || reservation.inputDigest !== createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(durableAdmission.canonicalRequestJson).digest("hex")) throw new Error("native_one_input_reservation_required");
    const ingress=this.nativeIngress.get(nativeRunId);
    if (ingress && (!ingress.handedOff || ingress.port!==port)) throw cleanupPending("cleanup_ingress_not_handed_off");
    if (this.nativePreparing.has(nativeRunId) || (!effectObservationTicket(nativeRunId) && [...this.nativePreparing.values()].some(p => p.binding.chatId === req.chatId && !effectObservationTicket(p.binding.runId)))) throw cleanupPending("cleanup_chat_preparing");
    const binding = Object.freeze({ chatId: req.chatId, runId: nativeRunId, admission: Object.freeze({ ...durableAdmission }) });
    port.assertCurrent(binding);
    const controller = ingress?.controller ?? new AbortController(), retained = ingress?.retained ?? new Set<Promise<unknown>>();
    const preparationLifetime = ingress?.lifetime ?? createNativePreparationLifetime(binding);
    const nativeActor = ingress ? ingress.actorSnapshot : !isLocalInvocationPreparationPort(port) ? getAuthenticatedActorIds() : null;
    const boundary: StartBoundary = { crossed: false };
    const pending: NativePreparingPending = { startBoundary:boundary, request:req, actorSnapshot: nativeActor ? Object.freeze({ ...nativeActor }) : null, binding, controller, port, retained, preparationLifetime };
    enterPrepared();
    this.nativePreparing.set(nativeRunId, pending);
    let status: "handed-off" | "rejected" | "cancelled" | "uncertain" = "rejected";
    let nativeFailure: unknown;
    try {
      this.publishActiveChats();
      if (req.oneMode && !effectObservationTicket(nativeRunId) && this.ordinaryOneTurnObserver) {
        const turn: OrdinaryOneTurnLifetime = { phase: "preparing", actor: JSON.stringify(ingress || !isLocalInvocationPreparationPort(port) ? pending.actorSnapshot : getAuthenticatedActorIds()),
          inputDigest: reservation.inputDigest, preparationClosed: false, executionClosed: false };
        pending.ordinaryTurn = turn;
        const source = captureOrdinaryOneTurn({ request: req, admission: binding.admission, port, controller,
          readState: () => ({ phase: turn.phase, lease: turn.record?.ownerLease, messageId: turn.messageId }),
          assertCurrent: (mode) => this.assertOrdinaryOneTurnCurrent(pending, turn, mode) });
        turn.source = source;
        turn.observation = this.ordinaryOneTurnObserver(source);
      }
      const steps = this.startPreparedSteps(req, workspaceBinding, executionContext, undefined, hostNoticePurpose, admission, durableAdmission, boundary, undefined, controller);
      const drive = () => withNativePreparationLifetime(preparationLifetime, () => driveNativeOneStart(steps, port, binding, controller.signal, preparationLifetime));
      const started = await (pending.ordinaryTurn?.observation ? pending.ordinaryTurn.observation.wrap(drive) : drive());
      status = "handed-off";
      try {
        for (const [waitingRunId, waiting] of this.browserLoginWaitingRuns) {
          if (waiting.chatId === req.chatId && waitingRunId !== started.runId) this.cancelParkedBrowserLoginWait(waitingRunId, "new_invocation", true);
        }
      } catch (error) { console.warn("[invocation] parked browser-login wait cleanup failed after a dispatched start:", error); }
      return started;
    } catch (error) {
      nativeFailure = error;
      this.logNativePreparationFailure(nativeRunId,req.chatId,error,{phase:"native-prepared-start",startBoundaryCrossed:boundary.crossed,agentAppMode:req.agentAppMode === true});
      status = controller.signal.aborted ? "cancelled" : "uncertain";
      if (durableAdmission && !boundary.crossed) {
        const reasonCode = preDispatchRefusalReasonCode(error);
        try { decideInvocationAdmission({ ...durableAdmission, decision: "rejected", reasonCode,
          noStartProof: { kind: "owner-start-boundary-not-crossed", verifiedOwnerProcessEpoch: durableAdmission.ownerProcessEpoch } }); }
        catch { /* Original source failure remains primary; the exact closed frontier reconciles below. */ }
        if (!controller.signal.aborted) this.recordStartRefusalCause(nativeRunId, req.chatId, error, { phase: "native-prepared-start", reasonCode, startBoundaryCrossed: false });
      }
      if (boundary.crossed && !boundary.handedOff && boundary.runId) {
        // The refusal's own innermost code with its delivery fact; "providerDispatched:false" next to runtime_turn_unsettled
        // contradicted itself (audit A7 M9). native-main-no-brain.ts reads this row.
        tryRecordRunEvent({ runId: boundary.runId, chatId: req.chatId, kind: "invoke_threw", payload: controller.signal.aborted
          ? { errorCode: "native_preparation_cancelled", providerDispatched: false }
          : { errorCode: preDispatchRefusalReasonCode(error), providerDispatched: false, turnDelivery: "not-dispatched" } });
        // Keep the slot and custody until exact Main preparation/claim quiescence.
      }
      // Unknown remote claims do not release custody or restore original capabilities.
      throw error;
    } finally {
      preparationLifetime.closeAdmission();
      await preparationLifetime.quiescent();
      let retainedSize: number;
      do { retainedSize = retained.size; await Promise.allSettled([...retained].filter(p => !this.nativeCancellationObservations.has(p))); }
      while (retained.size !== retainedSize);
      // The original driver/generator and all attached local work have really
      // drained here. Remote semantic cleanup is not executable chat custody.
      this.nativePreparedDriversClosed.add(pending);
      let retired = false;
      if (!boundary.handedOff) {
        try { retired = this.retireClosedPreparedNoBrain(pending, nativeFailure); }
        catch {
          this.scheduleClosedPreparedReconciliation(pending, nativeFailure, status as "rejected" | "cancelled" | "uncertain");
        }
      }
      if (retired) {
        this.quarantineNativeCleanup(nativeRunId, { completion: this.observeClosedPreparedCleanup(port, binding, status as "rejected" | "cancelled" | "uncertain") });
      } else if (!boundary.handedOff && controller.signal.aborted && this.nativePreparedDispatchLocallyClosed(pending)) {
        // The exact durable retirement observer owns cleanup after its CAS.
        // Joining semantic RPCs here would veto the already closed original.
      } else {
      try { await port.quiesce(binding, status); }
      catch (cause) { const error = new RuntimeTurnUnsettledError("native-one-quiescence"); Object.defineProperty(error, "cause", { value: cause });
        this.logNativePreparationFailure(nativeRunId,req.chatId,error,{phase:"native-prepared-quiescence",startBoundaryCrossed:boundary.crossed,agentAppMode:req.agentAppMode === true});throw nativeFailure ?? error; }
      const localClosedRecord = isLocalInvocationPreparationPort(port) && boundary.crossed && !boundary.handedOff && boundary.runId === nativeRunId
        ? this.activeRuns.get(nativeRunId) ?? this.settlingRuns.get(nativeRunId) : undefined;
      const localClosedEligible = !!localClosedRecord && !!boundary.ownerLease && localClosedRecord.ownerLease === boundary.ownerLease
        && localClosedRecord.controller === controller && !localClosedRecord.completion && !localClosedRecord.mainLifetime;
      let localClosed = false;
      const observeLocalCleanupLoop = localClosedEligible ? () => {
        // This original-source fact is minted only after every synchronous
        // cleanup callback was attempted, never before a diagnostic/log leaf.
        this.nativeLocalPreparedClosures.set(pending, { record: localClosedRecord!, expected: boundary.ownerLease!,
          status: status as "rejected" | "cancelled" | "uncertain", finishStarted: false });
        localClosed = true;
      } : undefined;
      if (boundary.crossed && !boundary.handedOff && boundary.runId) {
        try { this.releaseUndispatchedStart(boundary.runId, req.chatId, nativeFailure, isLocalInvocationPreparationPort(port) ? boundary.cleanups ?? [] : [], undefined, observeLocalCleanupLoop); }
        catch (cause) { if (!localClosed) throw cause; this.logNativePreparationFailure(nativeRunId,req.chatId,cause,{phase:"native-prepared-cleanup",startBoundaryCrossed:true,agentAppMode:req.agentAppMode === true}); }
      }
      if (localClosed) {
        await this.reconcileClosedLocalPrepared(pending);
      } else {
      if (!boundary.handedOff && boundary.ownerLease) invocationRunOwners.release(boundary.ownerLease);
      if (ingress && boundary.crossed && !boundary.handedOff && boundary.ownerLease && boundary.runId === nativeRunId) {
        ingress.undispatchedLease = Object.freeze({ ...boundary.ownerLease });
      }
      try { await port.finish(binding, status); }
      catch (cause) { const error = new RuntimeTurnUnsettledError("native-one-cleanup"); Object.defineProperty(error, "cause", { value: cause });
        this.logNativePreparationFailure(nativeRunId,req.chatId,error,{phase:"native-prepared-cleanup",startBoundaryCrossed:boundary.crossed,agentAppMode:req.agentAppMode === true});throw nativeFailure ?? error; }
      this.nativePreparing.delete(nativeRunId);
      this.publishActiveChats();
      this.finishOrdinaryOneTurn(pending, boundary.handedOff ? "preparation" : "closed");
      }
      }
      for (const listener of this.nativePreparationListeners) {
        try { listener({ runId: nativeRunId, chatId: req.chatId, status }); } catch { /* machine fact remains owned */ }
      }
    }
  }


  constructor() {
    // A resident CLI can close independently of the current runner callback.
    // Bridge that fact into the same run event stream while the run is alive;
    // the renderer then sees a real `closed` state instead of guessing from a
    // missing answer.
    onAgentResidencyChange((change) => this.publishAgentResidencyChange(change));
    onAuthSessionOwnershipChanged(()=>{
      for(const [runId,record] of new Map([...this.activeRuns.entries(),...this.settlingRuns,
        ...this.pendingGoalVerifications,...this.browserLoginWaitingRuns])) {
        if(record.oneTeamReportCustody && !queuedTeamReportCurrent(record.oneTeamReportCustody,record.oneTeamReportOriginalRequest!)) {
          try {this.cancelWithReason(runId,new Error("one_team_report_owner_changed"));}catch{record.controller.abort(new Error("one_team_report_owner_changed"));}
        }
      }
    });
    onAuthSessionRestored(()=>queueMicrotask(()=>{try{this.recoverQueuedSteers(undefined,true);}catch{ /* Owner recovery is retried by the existing startup/host path. */ }}));
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

  onSteerQueueCapacity(listener: (chatId: string) => void): () => void {
    this.steerQueueCapacityListeners.add(listener);
    return () => this.steerQueueCapacityListeners.delete(listener);
  }

  steerQueueCapacity(chatId: string): number {
    return Math.max(0, MAX_STEER_QUEUE_DEPTH - (this.steerQueues.get(chatId)?.length ?? 0));
  }

  private publishSteerQueueCapacity(chatId: string): void {
    for (const listener of this.steerQueueCapacityListeners) {
      try { listener(chatId); } catch { /* Saved intake stays queued for the next lifecycle boundary. */ }
    }
  }

  /**
   * Chats with a live turn here, plus chats this process holds through a run-owner lease outside its own turns (W5): a
   * graph agent node (run-graph.ts claims the node chat) or a doctor run (automation-scheduler.ts). Both claim
   * invocation_run_owners directly and were invisible here, so an owner message, a Goal resume or a team report started
   * on such a chat was refused invocation_chat_owned_by_other_run (red, "could not start a model") instead of waiting.
   */
  activeChatIds(): string[] {
    return [...new Set([...this.turnChatIds(), ...this.processLeasedChatIds()])];
  }

  /** Actual observed controller, without guessing from requests or role defaults. */
  activeRuntimeSelection(chatId: string): RuntimeSelection | null {
    const records = [...new Map([...this.settlingRuns, ...this.activeRuns.entries()]).values()]
      .filter(record => record.chatId === chatId && !record.background && !record.controller.signal.aborted);
    return records.length === 1 && records[0].currentRuntimeSelection
      ? { ...records[0].currentRuntimeSelection } : null;
  }

  /** Chats of the turns this service itself runs (live, preparing, settling, an episode awaiting its Goal check). */
  turnChatIds(): string[] {
    return [...new Set([...this.nativeIngress.values()].map(pending => pending.source.binding.chatId).concat([...this.nativePreparing.values()].map(pending => pending.binding.chatId)).concat([...this.activeRuns.activeChatIds(), ...[...this.settlingRuns.values(),
      ...[...this.pendingGoalVerifications.values()].filter(record => record.nativeGoalEpisodePending),
    ].filter((record) => !record.background).map((record) => record.chatId)]))];
  }

  /** Chats whose active or settling run-owner lease belongs to THIS process (never the other host's). */
  private processLeasedChatIds(): string[] {
    try {
      const me = invocationProcessOwner();
      return invocationRunOwners.listActiveOwners()
        .filter((owner) => owner.ownerId === me.ownerId && owner.ownerKind === me.ownerKind)
        .map((owner) => owner.chatId);
    } catch { return []; } // a store without the owner table holds no lease
  }

  /**
   * A queued direction waits behind a chat this process holds outside its own turns. Nothing here settles when that
   * lease is released (the graph node or doctor run releases it itself), so look again on a short poll until it is.
   */
  private awaitProcessLease(chatId: string): void {
    if (this.processLeaseWaits.has(chatId) || !this.steerQueues.get(chatId)?.length || this.turnChatIds().includes(chatId)) return;
    const timer = setTimeout(() => {
      this.processLeaseWaits.delete(chatId);
      if (!this.activeChatIds().includes(chatId)) this.publishActiveChats();
      this.drainSteerQueue(chatId);
    }, PROCESS_LEASE_POLL_MS);
    timer.unref?.();
    this.processLeaseWaits.set(chatId, timer);
  }

  /** 오너가 보낸 요청이 이 대화에서 차례를 기다린다 — 자동 재개는 그 뒤로 미룬다. */
  hasQueuedOwnerRequest(chatId: string): boolean {
    if (this.steerQueues.get(chatId)?.length) return true;
    // The owner's request is reserved (invoke:run) before One's preflight judges run. A host resume that started
    // in that window took the chat and the owner's start was refused: Thread Marketing 2026-10-04, preflight at
    // 05:00:15.5Z, sweep resume at 05:00:17.8Z, "could not start" at 05:00:20.5Z. Bounded in time so a pending
    // row left by a crashed process cannot hold a Goal back.
    try {
      const pending = getPendingInvocationAdmissionForChat(chatId);
      return Boolean(pending && Date.now() - Date.parse(pending.pendingAt) < 120_000);
    } catch { return false; }
  }

  activeRunIds(): string[] {
    return [...new Set([...this.activeRuns.entries()].map(([runId]) => runId).concat([...this.nativeIngress.keys(), ...this.nativePreparing.keys(), ...this.pendingGoalVerifications.keys(), ...this.settlingRuns.keys(), ...this.browserLoginWaitingRuns.keys()]))];
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
    mainAdmission?: MainInvocationAdmission,
    /** Exact trusted host preparation only; never accepted over renderer IPC. */
    preparedHostStart?: PreparedHostQuestionContinuation,
  ): Promise<QuestionContinuationReceipt> {
    mainAdmission = takeMainInvocationAdmission(mainAdmission);
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
    const live = this.activeRuns.get(intent.runId) ?? this.settlingRuns.get(intent.runId);
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
    if (!preparedHostStart && committedQuestionRequiresHostPreparation(chatId,sourceMessageId)) {
      return {chatId,sourceMessageId,runId:intent.runId,status:"rejected",reasonCode:"start-rejected"};
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
    // An owner pause/stop/delete of this chat's Goal AFTER the answer committed outranks the stored
    // continuation: starting would resume what the owner just stopped (an owner message resumes a paused Goal
    // by design, an automatic replay of an old answer is not an owner message). The answer stays current.
    if (ownerStoppedGoalAfterAnswer(chatId, sourceMessageId)) {
      return { chatId, sourceMessageId, runId: intent.runId, status: "rejected", reasonCode: "start-rejected" };
    }

    const tryStart = (): QuestionContinuationReceipt => {
      const started = preparedHostStart
        ? startPreparedHostQuestionInvocation(this,preparedHostStart,{chatId,sourceMessageId,requestHash:intent.requestHash})
        : this.start(intent.request, undefined, undefined, {
          sourceMessageId,
          requestHash: intent.requestHash,
        }, undefined, mainAdmission);
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
    // Directions that waited while admission was closed start now, in queue order.
    for (const chatId of [...this.steerQueues.keys()]) this.drainSteerQueue(chatId);
  }

  /** Close the Desktop execution gate and interrupt every live turn. */
  beginAppShutdown(): string[] {
    this.acceptingStarts = false;
    const runIds = this.activeRunIds();
    let failed = false;
    let firstError: unknown;
    for (const runId of runIds) {
      try { this.cancelWithReason(runId, new Error(this.appShutdownCause)); }
      catch (error) { if (!failed) { failed = true; firstError = error; } }
    }
    // A failed receipt write for one run must not leave another run unstopped.
    if (failed) throw firstError;
    return runIds;
  }

  /**
   * The person confirmed "업데이트하고 이어하기": the coming shutdown interrupts turns for the update,
   * not because the app closed. Same stop, different machine marker (hostStopCause "update_restart"),
   * so the receipt reads "paused for the update" and the relaunch continues it once.
   */
  markShutdownForUpdate(): void {
    this.appShutdownCause = "update_restart";
  }

  /**
   * What is running right now, for the update confirm and its resume ledger. Main-memory facts only:
   * the request fields needed to continue the same turn later, never its prompt.
   */
  activeWorkSummaries(): Array<{
    runId: string;
    chatId: string;
    oneMode: boolean;
    automaticGoalId: string | null;
    executionSource: string | null;
    workspaceSource: string | null;
    request: Pick<McpInvocationRequest, "taskIntent" | "permissions" | "onePermissionMode" | "runtimeSelection" | "locale" | "oneMode">;
  }> {
    // A completed producer retained only by its background judge is no longer
    // foreground work. Actual transport drainage still belongs to settlingRuns.
    const records = new Map([...this.settlingRuns, ...this.activeRuns.entries()]);
    return [...records].filter(([, record]) => !record.background).map(([runId, record]) => ({
      runId,
      chatId: record.chatId,
      oneMode: record.oneMode,
      automaticGoalId: record.automaticGoalId ?? null,
      executionSource: record.executionSource ?? null,
      workspaceSource: record.workspaceBinding?.source ?? null,
      request: {
        ...(record.request.taskIntent ? { taskIntent: record.request.taskIntent } : {}),
        ...(record.request.permissions ? { permissions: record.request.permissions } : {}),
        ...(record.request.onePermissionMode ? { onePermissionMode: record.request.onePermissionMode } : {}),
        ...(record.request.runtimeSelection ? { runtimeSelection: record.request.runtimeSelection } : {}),
        ...(record.request.locale ? { locale: record.request.locale } : {}),
        ...(record.request.oneMode ? { oneMode: true } : {}),
      },
    }));
  }

  /**
   * Owner directions a turn never took (current-turn rows still `queued`) whose run is no longer live anywhere: the app
   * closed or crashed before the run's own end could carry them, or an older version left them (D5). An owner stop ends
   * them rejected owner_control_run_stopped (production chat 89bc5018: two rows queued since 2026-10-10, run cancelled by
   * the owner at 23:54:22Z). Any other end (closing the app, an update restart, a crash, a failure) carries them as the
   * chat's next turn (carried-owner-followups.ts), which the recovery below starts like any queued direction. A run
   * whose lease is still held by a process is left to that process; a run with no receipt is left as it is.
   */
  private settleUntakenCurrentTurnDirections(chatId?: string): { carried: number; rejected: number } {
    let carried = 0, rejected = 0;
    let runs: Array<{ chatId: string; runId: string }> = [];
    try {
      runs = getDb().prepare(`SELECT DISTINCT chat_id AS chatId, run_id AS runId FROM invocation_current_turn_steers
        WHERE status = 'queued'${chatId !== undefined ? " AND chat_id = ?" : ""}`).all(...(chatId !== undefined ? [chatId] : [])) as Array<{ chatId: string; runId: string }>;
    } catch { return { carried, rejected }; }
    for (const run of runs) {
      try {
        if (this.activeRuns.has(run.runId) || this.settlingRuns.has(run.runId) || this.nativeIngress.has(run.runId)
          || this.nativePreparing.has(run.runId) || this.pendingGoalVerifications.has(run.runId) || this.browserLoginWaitingRuns.has(run.runId)) continue;
        const owner = invocationRunOwners.getOwnerByRunId(run.runId);
        if (owner && owner.state !== "released") continue;
        const receipt = getInvocationRunReceipt(run.runId);
        if (!receipt || receipt.chatId !== run.chatId || receipt.status === "running" || receipt.status === "cancelling") continue;
        const ownerStopped = receipt.status === "cancelled" && receipt.interruptionCause !== "steering"
          && receipt.hostStopCause !== "app_closed" && receipt.hostStopCause !== "update_restart";
        if (ownerStopped) { rejected += rejectQueuedCurrentTurnSteersForStop(run.chatId, run.runId); continue; }
        const started = getDb().prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'invoke_started' ORDER BY seq LIMIT 1")
          .get(run.runId) as { payload_json: string } | undefined;
        let start: Record<string, unknown> = {};
        try { start = started ? JSON.parse(started.payload_json) as Record<string, unknown> : {}; } catch { start = {}; }
        const source: McpInvocationRequest = { chatId: run.chatId, userPrompt: "",
          ...(start.oneMode === true ? { oneMode: true } : {}),
          ...(typeof start.onePermissionMode === "string" ? { onePermissionMode: start.onePermissionMode as McpInvocationRequest["onePermissionMode"] } : {}),
          ...(start.permissions === "read" || start.permissions === "write" || start.permissions === "full" ? { permissions: start.permissions } : {}),
          ...(start.planMode === true ? { planMode: true } : {}),
          ...(start.locale === "ko" || start.locale === "en" ? { locale: start.locale } : {}) };
        const carriedRow = carryOwnerFollowupsToNextTurn({ chatId: run.chatId, runId: run.runId, request: source });
        if (!carriedRow) continue;
        carried += 1;
        tryRecordRunEvent({ runId: run.runId, chatId: run.chatId, kind: "owner_followup_carried",
          payload: { queuedSteerId: carriedRow.id, recovery: "restart", runStatus: receipt.status } });
      } catch (error) {
        console.warn(`[invocation] untaken owner directions not settled run=${run.runId} code=${innermostTypedCode(error) ?? "none"}`);
      }
    }
    if (carried || rejected) console.info("[invocation] untaken owner directions of ended runs", { carried, rejected });
    return { carried, rejected };
  }

  /** Rehydrate exact accepted directions after SQLite is initialized on boot. */
  recoverQueuedSteers(chatId?: string, ownerReportHoldsOnly = false): InvocationSteerRecoveryReport {
    if (!ownerReportHoldsOnly) this.settleUntakenCurrentTurnDirections(chatId);
    const rows = listRecoverableQueuedSteers(chatId).filter(row=>!ownerReportHoldsOnly
      || row.request.oneTeamReportTurn===true && row.recoveryState==="held" && row.recoveryReason==="one-team-report-owner-unbound");
    let resumed = 0;
    let settled = 0;
    let held = 0;
    for (let row of rows) {
      // A malformed/uncertain drain claim outranks owner recovery. An account
      // returning cannot turn evidence of a prior dispatch into a fresh queue.
      if (row.request.oneTeamReportTurn === true && row.status === "draining" && !row.drainedRunId) {
        holdQueuedSteerForRecovery(row.id, "draining-run-id-missing");
        held += 1;
        continue;
      }
      if(row.request.oneTeamReportTurn===true && !row.drainedRunId){
        if(row.oneTeamReportCustodyJson===undefined){
          try {const custody=captureQueuedTeamReportCustody(row.request,undefined,row.originalRunId);
            if(bindQueuedTeamReportCustody(row.id,custody))row=getDurableQueuedSteer(row.id)!;
          }catch{ /* Unknown legacy stays unknown, never rebound to a different source owner. */ }
        }
        if(!queuedTeamReportCurrent(row.oneTeamReportCustody,row.request)){
          holdQueuedSteerForRecovery(row.id,"one-team-report-owner-unbound");held++;continue;
        }
        if(row.recoveryState==="held" && row.recoveryReason==="one-team-report-owner-unbound"){
          if(!releaseQueuedSteerRecoveryHold(row.id,"one-team-report-owner-unbound")){held++;continue;}row=getDurableQueuedSteer(row.id)!;
        }
      }
      // This direction is a distinct next turn. An exact released execution
      // owner proves the previous writer is gone even when its result/ACK was
      // lost. Keep that history for recap, without holding undispatched input.
      const originalOwner = invocationRunOwners.getOwnerByRunId(row.originalRunId);
      const previousExecutionClosed = originalOwner?.runId === row.originalRunId
        && originalOwner.chatId === row.chatId && originalOwner.state === "released"
        && !this.activeRuns.has(row.originalRunId) && !this.settlingRuns.has(row.originalRunId)
        && !this.nativeIngress.has(row.originalRunId) && !this.nativePreparing.has(row.originalRunId);
      if (previousExecutionClosed && row.status === "queued" && !row.drainedRunId
        && row.recoveryState === "held"
        && (row.recoveryReason === "original-run-start-uncertain"
          || row.recoveryReason === "original-run-effect-boundary-unconfirmed")) {
        if (releaseQueuedSteerRecoveryHold(row.id, row.recoveryReason)) row = getDurableQueuedSteer(row.id)!;
      }
      if (row.recoveryState === "held") {
        // A held relay One wrote to a teammate has no owner to decide on it: measured 2026-10-12, two such rows sat
        // for days after their run ended in a browser-login wait without a receipt. Once that run's lease is released
        // and an hour has passed, close it; the Goal re-derives what still needs saying. Owner-written ones stay held.
        if (row.request.promptOrigin === "system" && originalOwner?.state === "released"
          && row.recoveryReason !== "one-team-report-owner-unbound"
          && Date.now() - Date.parse(row.queuedAt) > HELD_SYSTEM_STEER_RETIRE_MS && retireHeldQueuedSteer(row.id, "held-system-retired")) {
          settled += 1;
          continue;
        }
        held += 1;
        continue;
      }
      if (row.status === "draining" && !row.drainedRunId) {
        holdQueuedSteerForRecovery(row.id, "draining-run-id-missing");
        held += 1;
        continue;
      }
      if (row.drainedRunId) {
        const drainedReceipt = getInvocationRunReceipt(row.drainedRunId);
        if (steerReceiptIsTerminal(drainedReceipt)) {
          if (settleQueuedSteer(row.id, "started")) settled += 1;
        } else {
          // A start row without a terminal receipt may already have crossed an
          // external provider boundary. Holding is the only honest restart
          // action; absence of the row is not proof that no effect occurred.
          holdQueuedSteerForRecovery(
            row.id,
            drainedReceipt ? "drained-run-start-uncertain" : "drained-run-receipt-missing",
          );
          held += 1;
        }
        continue;
      }
      const originalReceipt = getInvocationRunReceipt(row.originalRunId);
      if (!steerReceiptIsTerminal(originalReceipt) && !previousExecutionClosed) {
        holdQueuedSteerForRecovery(row.id, "original-run-start-uncertain");
        held += 1;
        continue;
      }
      // While execution custody is still live, use its exact boundary. Once
      // released, historical effect uncertainty is the next model's context.
      let originalBoundary: ReturnType<typeof readInvocationEffectBoundary>;
      if (!previousExecutionClosed) try {
        originalBoundary = readInvocationEffectBoundary({
          invocationRunId: row.originalRunId,
          expectedChatId: row.chatId,
        });
      } catch {
        holdQueuedSteerForRecovery(row.id, "original-run-effect-boundary-unconfirmed");
        held += 1;
        continue;
      }
      // The owner's own message is never held on an unknown outside outcome, only on a run that has not finished.
      if (!previousExecutionClosed && !originalBoundary!.terminal) {
        holdQueuedSteerForRecovery(row.id, "original-run-effect-boundary-unconfirmed");
        held += 1;
        continue;
      }
      // The original run is durably terminal and this direction has never
      // crossed beginQueuedSteerDrain. Rehydrate it exactly once and let the
      // normal Main-owned drain create the next run.
      const queue = this.steerQueues.get(row.chatId) ?? [];
      if (!queue.some((queued) => queued.id === row.id)) this.enqueueSteer(row.chatId, queue, queuedSteerFromDurable(row));
      this.steerQueues.set(row.chatId, queue);
      resumed += 1;
    }
    for (const queuedChatId of chatId !== undefined ? [chatId] : this.steerQueues.keys()) this.drainSteerQueue(queuedChatId);
    if (rows.length > 0) this.publishActiveChats();
    return { examined: rows.length, resumed, settled, held };
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
    /** Main-only system-turn display purpose; not accepted in an IPC request. */
    hostNoticePurpose?: ChatHostNotice["purpose"],
    mainAdmission?: MainInvocationAdmission,
    /** Main-only renderer admission identity; never accepted from an IPC request. */
    durableAdmission?: InvocationAdmissionIdentity,
    queuedRoomInheritance?: typeof QUEUED_ONE_ROOM_INHERITANCE,
    oneTeamReportCustody?: QueuedTeamReportCustody,
  ): InvocationStartResult {
    if(req.oneTeamReportTurn===true){
      oneTeamReportCustody ??= captureQueuedTeamReportCustody(req);
      if(!queuedTeamReportCurrent(oneTeamReportCustody,req))throw new Error("one_team_report_owner_unbound");
    }
    const startBoundary: StartBoundary = { crossed: false };
    try {
      const started = this.startPrepared(req, workspaceBinding, executionContext, questionContinuation,
        hostNoticePurpose, mainAdmission, durableAdmission, startBoundary, queuedRoomInheritance, oneTeamReportCustody);
      // The run is dispatched from here: a failed cleanup of an older parked wait must not report it as not started.
      try {
        for (const [waitingRunId, waiting] of this.browserLoginWaitingRuns) {
          if (waiting.chatId === req.chatId && waitingRunId !== started.runId) this.cancelParkedBrowserLoginWait(waitingRunId, "new_invocation", true);
        }
      } catch (error) {
        console.warn("[invocation] parked browser-login wait cleanup failed after a dispatched start:", error);
      }
      return started;
    } catch (error) {
      // Nothing was handed to a runtime: the same typed fact the daemon's native ingress reports for this refusal.
      if (!startBoundary.handedOff && !(error instanceof RuntimeTurnUnsettledError)) markRefusedBeforeDispatch(error);
      if (startBoundary.crossed && !startBoundary.handedOff && startBoundary.runId) {
        this.releaseUndispatchedStart(startBoundary.runId, req.chatId, error, startBoundary.cleanups ?? []);
      }
      if (!startBoundary.handedOff && startBoundary.ownerLease) {
        try { invocationRunOwners.release(startBoundary.ownerLease); }
        catch (cleanupError) { console.warn("[invocation] owner release remains unconfirmed:", cleanupError); }
      }
      if (durableAdmission && !startBoundary.crossed) {
        // Direct control flow proves no provider dispatch occurred. Absence of
        // a receipt alone would not prove that, especially across epochs.
        const reasonCode = preDispatchRefusalReasonCode(error);
        const decision = decideInvocationAdmission({
          ...durableAdmission,
          decision: "rejected",
          // ★2026-09-23 — 실제 거절 코드를 남긴다. 고정 사유만 남기면 화면이 구체 문구
          //   (예산 소진·정리 중·앱 종료 중…)를 원리적으로 고를 수 없었다. 식별자 모양일 때만
          //   쓴다(사용자 내용은 원장에 들어가지 않는다). 아니면 예전 고정 사유.
          reasonCode,
          noStartProof: {
            kind: "owner-start-boundary-not-crossed",
            verifiedOwnerProcessEpoch: durableAdmission.ownerProcessEpoch,
          },
        });
        if (decision.kind === "rejected") this.recordStartRefusalCause(durableAdmission.runId, req.chatId, error, { phase: "local-start", reasonCode, startBoundaryCrossed: false });
        if (decision.kind === "conflict" && decision.reason !== "already-decided") {
          throw new Error(`invocation_admission_rejection_${decision.reason}`, { cause: error });
        }
      }
      throw error;
    }
  }

  /** Chat host handover (1.3.0 A2). Undefined when this chat's previous turn ran in this same process kind. */
  private handOverChatHost(lease: InvocationRunOwner, chatId: string, runId: string): Promise<void> | undefined {
    let previous: InvocationRunOwner | null;
    try { previous = invocationRunOwners.getPreviousOwner(chatId, runId); }
    catch { return undefined; }
    if (!previous || previous.ownerKind === lease.ownerKind) return undefined;
    return ensureChatHostHandover({
      chatId, runId, localKind: lease.ownerKind, previous,
      record: (line, fields) => {
        tryRecordRunEvent({ runId, chatId, kind: "runtime_session_handover", payload: { line, ...fields } });
        console.info(line);
      },
    });
  }

  private startPrepared(
    req: McpInvocationRequest,
    workspaceBinding: InvocationWorkspaceBinding | undefined,
    executionContext: InvocationExecutionContext | undefined,
    questionContinuation: { sourceMessageId: string; requestHash: string } | undefined,
    hostNoticePurpose: ChatHostNotice["purpose"] | undefined,
    mainAdmission: MainInvocationAdmission | undefined,
    durableAdmission: InvocationAdmissionIdentity | undefined,
    startBoundary: StartBoundary,
    queuedRoomInheritance?: typeof QUEUED_ONE_ROOM_INHERITANCE,
    oneTeamReportCustody?: QueuedTeamReportCustody,
  ): InvocationStartResult {
    return driveLocalOneStart(this.startPreparedSteps(req, workspaceBinding, executionContext, questionContinuation, hostNoticePurpose, mainAdmission, durableAdmission, startBoundary, queuedRoomInheritance, undefined, oneTeamReportCustody));
  }

  private *startPreparedSteps(
    req: McpInvocationRequest,
    workspaceBinding: InvocationWorkspaceBinding | undefined,
    executionContext: InvocationExecutionContext | undefined,
    questionContinuation: { sourceMessageId: string; requestHash: string } | undefined,
    hostNoticePurpose: ChatHostNotice["purpose"] | undefined,
    mainAdmission: MainInvocationAdmission | undefined,
    durableAdmission: InvocationAdmissionIdentity | undefined,
    startBoundary: StartBoundary,
    queuedRoomInheritance?: typeof QUEUED_ONE_ROOM_INHERITANCE,
    nativeController?: AbortController,
    oneTeamReportCustody?: QueuedTeamReportCustody,
  ): Generator<NativeOneStartCheckpoint, InvocationStartResult, unknown> {
    const nativePreparation = nativeController ? this.nativePreparing.get(req.runId!) : undefined;
    assertFinanceWorkChatOwner(req.chatId, getAuthenticatedActorIds());
    mainAdmission = takeMainInvocationAdmission(mainAdmission);
    assertDesktopOneRecoveryStart(req);
    if(req.oneTeamReportTurn===true && !queuedTeamReportCurrent(oneTeamReportCustody,req))throw new Error("one_team_report_owner_unbound");
    if (durableAdmission && (durableAdmission.runId !== req.runId || durableAdmission.chatId !== req.chatId)) {
      throw new Error("invocation_admission_request_identity_mismatch");
    }
    assertInvocationWorkspaceSourceContext(workspaceBinding, executionContext?.source);
    const companyWork = executionContext?.source === "company-work" ? executionContext.companyWork : undefined;
    if (!companyWork && require("../business/company-work-reference").isCompanyWorkReference(getChat(req.chatId)?.agentId)) throw new Error("company_work_original_owner_required");
    if (executionContext?.source === "company-work") {
      if (!companyWork) throw new Error("company_work_grant_required");
      const admitted = require("../business/company-work-grant").assertCompanyWorkGrant(companyWork, req);
      if (workspaceBinding !== admitted.workspace || getChat(req.chatId)?.agentId !== admitted.asset.agentId || req.oneMode || req.agentAppMode || req.automationId || getChat(req.chatId)?.originSurface !== "work") throw new Error("company_work_invocation_changed");
    }
    if (!this.acceptingStarts) throw new Error("desktop_execution_admission_closed");
    const backgroundObservation = Boolean(effectObservationTicket(req.runId));
    if ((!nativeController || !nativePreparation || isLocalInvocationPreparationPort(nativePreparation.port)) && !backgroundObservation) {
      const foreignOwner = invocationRunOwners.getActiveOwner(req.chatId), localOwner = invocationProcessOwner();
      if (foreignOwner && (foreignOwner.ownerId !== localOwner.ownerId || foreignOwner.ownerKind !== localOwner.ownerKind)) {
        // A live turn of this chat in the OTHER process (Desktop <-> background service) is a definite refusal (1.3.0 A2).
        if (otherHostOwnsChat(foreignOwner, localOwner)) throw Object.assign(new Error(CHAT_BUSY_OTHER_HOST_CODE), { code: CHAT_BUSY_OTHER_HOST_CODE });
        throw cleanupPending("cleanup_foreign_owner_lease");
      }
      if (this.foreignNativeStartFence) {
        let blocked: unknown;
        try { blocked = this.foreignNativeStartFence(req.chatId); }
        catch (error) { throw cleanupPending("cleanup_foreign_fence_failed", error); }
        if (blocked !== false) throw cleanupPending("cleanup_foreign_native_fence");
      }
    }
    // The shared pending reservation fences every ingress, including Mobile and
    // host resumes in another process, before any preparation/claim/owner lease.
    const pendingAdmission = !backgroundObservation ? getPendingInvocationAdmissionForChat(req.chatId) : null;
    if (pendingAdmission && (!durableAdmission || pendingAdmission.runId !== req.runId
      || pendingAdmission.ownerProcessEpoch !== durableAdmission.ownerProcessEpoch
      || pendingAdmission.inputDigest !== createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION + "\0").update(durableAdmission.canonicalRequestJson).digest("hex"))) throw cleanupPending("cleanup_other_admission_pending");
    if (!backgroundObservation && [...this.nativeIngress.values()].some(pending => pending.source.binding.chatId === req.chatId && pending.controller !== nativeController && !effectObservationTicket(pending.source.binding.runId))) throw cleanupPending("cleanup_chat_ingress");
    if (!backgroundObservation && [...this.nativePreparing.values()].some(pending => pending.binding.chatId === req.chatId && pending.controller !== nativeController)) throw cleanupPending("cleanup_chat_preparing");
    if (!backgroundObservation && [...this.settlingRuns.values()].some((record) => !record.background && record.chatId === req.chatId)) throw cleanupPending("cleanup_chat_settling");
    if (nativeController) yield oneStartCheckpoint("judge", { request: req, workspaceBinding, executionContext }, () => undefined);
    nativeController?.signal.throwIfAborted();
    const incoming = req as OneInvocationRequest;
    const {
      oneProfileContext: _untrustedOneProfileContext,
      oneMachineTurnContext: _untrustedOneMachineTurnContext,
      oneTeamExecutionPolicy: _untrustedOneTeamExecutionPolicy,
      oneTeamRuntimeBinding: _untrustedOneTeamRuntimeBinding,
      oneTeamStaffingAuthority: _untrustedOneTeamStaffingAuthority,
      oneParticipantExecutionSnapshot: _untrustedOneParticipantExecutionSnapshot,
      oneAttachmentContext: _untrustedOneAttachmentContext,
      oneAttachmentRedactions: _untrustedOneAttachmentRedactions,
      attachmentCapabilitySummary: _untrustedAttachmentCapabilitySummary,
      oneRecurrenceSelection: requestedOneRecurrenceSelection,
      oneMemoryUseOnceRef: requestedOneMemoryUseOnceRef,
      oneBriefingActionRef: requestedOneBriefingActionRef,
      oneTeamPreflightRef: requestedOneTeamPreflightRef,
      oneAttachmentRef: requestedOneAttachmentRef,
      ...requestWithoutMainContext
    } = incoming;
    // A Goal Main admitted for an earlier background-service turn of this chat follows that turn; once it ended the room is
    // not bound to it any more (2026-10-15: both team rooms stayed bound to Goals whose runs had failed).
    if (!companyWork && !backgroundObservation && invocationProcessOwner().ownerKind !== "daemon") {
      try { followDaemonTurnGoalOfChat(req.chatId); } catch (error) { console.warn("[invocation] service-turn Goal could not be settled:", error); }
    }
    const storedChat = getChat(req.chatId);
    if (!companyWork && require("../business/company-work-reference").isCompanyWorkReference(storedChat?.agentId)) throw new Error("company_work_original_owner_required");
    if (!storedChat) throw new Error("Chat not found");
    const chat = backgroundObservation || companyWork ? { ...storedChat } : repairRootChatSurfaceController(storedChat);
    let boundGoal = chat.goalId ? getLongRunByGoalId(chat.goalId) : null;
    if (!backgroundObservation && chat.goalId && boundGoal && LONG_RUN_TERMINAL_STATUSES.has(boundGoal.status)) {
      completeChatGoalContract(chat.goalId, boundGoal.status === "completed" ? "completed" : "cancelled");
      setChatGoalBinding(chat.id, null);
      chat.goalId = null;
      boundGoal = null;
    } else if (!backgroundObservation && chat.goalId?.startsWith("goal:auto-message:") && !boundGoal) {
      completeChatGoalContract(chat.goalId, "cancelled");
      setChatGoalBinding(chat.id, null);
      chat.goalId = null;
    }
    if (!backgroundObservation && !chat.goalId) {
      // A `blocked` contract is a live goal too (it asked the owner a question, or a hard stop parked it): the

      // (2026-09-28) unbound through two owner messages while its goal waited for exactly that answer.
      const orphan = getDb().prepare(
        "SELECT goal_id FROM chat_goal_contracts WHERE chat_id = ? AND status IN ('active','blocked') ORDER BY updated_at DESC LIMIT 1",
      ).get(chat.id) as { goal_id: string } | undefined;
      if (orphan) {
        const orphanRun = getLongRunByGoalId(orphan.goal_id);
        if (orphanRun && !LONG_RUN_TERMINAL_STATUSES.has(orphanRun.status)) {
          setChatGoalBinding(chat.id, orphan.goal_id);
          chat.goalId = orphan.goal_id;
          boundGoal = orphanRun;
        } else {
          completeChatGoalContract(orphan.goal_id, orphanRun?.status === "completed" ? "completed" : "cancelled");
        }
      }
    }
    /* Validate now; reopen only after this turn is durably stored. */
    const localUserTurn = req.promptOrigin !== "system"
      && !workspaceBinding
      && !executionContext
      && req.agentAppMode !== true;
    // Historical uncertain effects are background reconciliation work;
    // their unchanged records never refuse the owner's next message.
    // Sending a new local message is an explicit resume plus steering command.
    // Host retries and remote jobs cannot turn a paused Goal back on. A stop
    // still draining is not a paused Goal and must finish before a new start.
    if (boundGoal && ["pausing", "cancelling"].includes(boundGoal.status)) {
      throw new Error("goal_stop_in_progress");
    }
    const resumesPausedGoal = boundGoal?.status === "paused" && localUserTurn;
    // The owner's own paired channel (Mobile One, Telegram One) is not a host retry or a remote job: refusing it here
    // left a paused room unreachable from the phone for good (the phone only read "Desktop rejected the request").
    // It runs as an ordinary turn and leaves the Goal paused; resuming stays a Desktop message or the goal chip.
    // Exactly the shapes those two channels start with (mobile-bridge/authority.ts, telegram/connect.ts): the binding
    // plus that channel's own execution surface (and Telegram's surface text) and nothing else — no company work, graph
    // or recovery custody.
    const remoteSurfaceOnly = (surface: "mobile" | "telegram") => !executionContext
      || (executionContext.source === surface && Object.keys(executionContext)
        .every((key) => key === "source" || (surface === "telegram" && key === "surfaceContext")));
    const ownerRemoteTurn = req.promptOrigin !== "system" && req.agentAppMode !== true
      && ((workspaceBinding?.source === "mobile-one" && remoteSurfaceOnly("mobile"))
        || (workspaceBinding?.source === "telegram-one" && remoteSurfaceOnly("telegram")));
    if (boundGoal?.status === "paused" && !resumesPausedGoal && !ownerRemoteTurn) {
      throw new Error("goal_explicit_resume_required");
    }
    let stoppedGoalReactivation: { runId: string; version: number; status: "paused" | "blocked" | "waiting_tool" | "queued"; ownerAnswer?: boolean } | null = null;
    // The request's taskIntent is only a claim for One: semantic intake may
    // promote a conversation to a task below. Defer blocked-goal eligibility
    // until runReq carries that effective intent; otherwise a valid One task
    // is admitted as a plain conversation and can never reopen the run.
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
          ? { permissions: authoritativeOnePermission(selectedOnePermissionMode, requestWithoutMainContext.taskIntent, incoming.permissions) }
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
        oneTeamStaffingAuthority: undefined,
      };
    }
    if (typeof req.runId === "string" && hasInvocationRunReceipt(req.runId)) {
      throw new Error("Invocation runId already has a durable receipt; use a new runId");
    }
    const runId = resolveInvocationRunId(
      req.runId,
      (candidate) => this.activeRuns.hasSeen(candidate) || hasInvocationRunReceipt(candidate),
    );
    // 효과 관찰 실행(Main 발행 표)은 정확히 그 번호·그 대화·읽기 전용으로만 돈다 — 요청 본문이
    // 아니라 Main 이 들고 있는 표로 판정하고, 조금이라도 어긋나면 디스패치 전에 거절한다.
    const effectObservation = effectObservationTicket(req.runId);
    if (effectObservation && (runId !== req.runId || effectObservation.chatId !== req.chatId || workspaceBinding
      || executionContext || req.permissions !== "read" || req.agentAppMode
      || (requestedOneMode && selectedOnePermissionMode !== "read"))) {
      throw new Error("effect_observation_must_be_read_only");
    }
    const runWorkspaceBinding = workspaceBinding
      ? immutableWorkspaceBinding(workspaceBinding)
      : undefined;
    // A workspace capability is not necessarily a Mobile surface. Science
    // keeps its local persistence/projection while sharing directory identity checks.
    const remoteWorkspaceBinding = Boolean(runWorkspaceBinding
      && isRemoteInvocationWorkspaceBindingSource(runWorkspaceBinding.source));
    const controller = nativeController ?? new AbortController();
    const startedAt = new Date().toISOString();
    /*
     * ★청구가 실패하면 **예약을 반드시 풀어 준다** (오너 기기 로그 실측 2026-09-07:
     *   `Error: One team preflight Task binding changed`).
     *
     * 이 호출은 try/catch 없이 던지고 있었다. 그러면 실행은 시작도 못 했는데 제안은
     * `workforce_reserved` 로 남고, 화면에는 이유 없는 "이어갈 수 없다" 배너만 계속
     * 뜬다(One 화면의 recovery 줄이 그 상태를 본다). 사용자는 같은 요청을 다시 보내고,
     * 바인딩은 여전히 어긋나 있으니 같은 자리에서 또 죽는다 — 빠져나갈 길이 없다.
     *
     * failOneTeamPreflightStart 는 예약을 놓고 제안을 recovery_required 로 옮긴다.
     * 그래야 다음 전송이 팀을 새로 준비하는 정상 경로로 들어간다.
     */
    let preparedOneTeamPreflight: PreparedOneTeamPreflightClaim | null = null;
    if (requestedOneTeamPreflightRef) {
      try {
        preparedOneTeamPreflight = (yield oneStartCheckpoint("team.prepare", { ref: requestedOneTeamPreflightRef, chatId: chat.id }, () => prepareOneTeamPreflightClaim(requestedOneTeamPreflightRef, chat.id))) as ReturnType<typeof prepareOneTeamPreflightClaim>;
      } catch (error) {
        try {
          (yield oneStartCheckpoint("team.fail-start", { ref: requestedOneTeamPreflightRef }, () => failOneTeamPreflightStart(requestedOneTeamPreflightRef)));
        } catch {
          // 예약 해제 실패가 원래 사유를 덮으면 안 된다 — 아래에서 원래 오류를 던진다.
        }
        throw error;
      }
    }
    if (preparedOneTeamPreflight && (yield oneStartCheckpoint("team.attachments-required", { proposalId: preparedOneTeamPreflight.proposalId }, () => teamProposalRequiresOneAttachments(preparedOneTeamPreflight!.proposalId))) as boolean && !requestedOneAttachmentRef) {
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
        // Paired Mobile One carries the same validated chip as Desktop One.
        // Other bounded workspaces retain their prepared capability limit.
        permissions: workspaceBinding && !mobileOneBoundary
          ? preparedOneTeamPreflight.permission
          : authoritativeOnePermission(selectedOnePermissionMode, "task", incoming.permissions),
        sessionRouting: false,
        hubMode: preparedOneTeamPreflight.mode === "workforce"
          ? oneTeamWorkforceHubMode(preparedOneTeamPreflight.staffingAuthority)
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
            : oneTeamUsesNativeStaffing(preparedOneTeamPreflight.staffingAuthority)
              ? "native_one_staffing"
              : "solo_locked",
        oneTeamRuntimeBinding: preparedOneTeamPreflight.runtime,
        oneTeamStaffingAuthority: preparedOneTeamPreflight.staffingAuthority,
      };
    }
    const preparedOneBriefingAction = requestedOneBriefingActionRef
      ? (yield oneStartCheckpoint("briefing.prepare", { ref: requestedOneBriefingActionRef, chatId: chat.id }, () => prepareOneBriefingActionClaim(requestedOneBriefingActionRef, chat.id))) as ReturnType<typeof prepareOneBriefingActionClaim>
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
        oneTeamStaffingAuthority: undefined,
      };
    }
    const preparedOneMemoryUseOnce = requestedOneMemoryUseOnceRef
      ? (yield oneStartCheckpoint("memory.prepare", { ref: requestedOneMemoryUseOnceRef, chatId: chat.id }, () => prepareOneMemoryUseOnceClaim(requestedOneMemoryUseOnceRef, chat.id))) as ReturnType<typeof prepareOneMemoryUseOnceClaim>
      : null;
    const inheritedOneRoom = queuedRoomInheritance === QUEUED_ONE_ROOM_INHERITANCE
      && requestedOneMode && !preparedOneTeamPreflight && !preparedOneBriefingAction && !requestedOneAttachmentRef
      ? resolveQueuedOneRoomRoster(chat.id) : null;
    if (inheritedOneRoom) {
      invocationRequest = { ...invocationRequest, taskForceTargets: inheritedOneRoom.taskForceTargets,
        sessionRouting: false, borrowAgents: undefined, borrowVersions: undefined };
    }
    const explicitMemoryIntent = requestedOneMode && !preparedOneBriefingAction
      ? detectExplicitOneMemoryIntent(invocationRequest.userPrompt,
          (prompt) => judgedOneMemoryIntent(prompt, invocationRequest.runtimeSelection))
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
    let oneMachineTurnContext: string | undefined;
    // A teammate in a One room does its piece and answers One. One's persona, the owner's One profile and the approved One
    // memory are One's own; a teammate re-reading them every turn only costs input (production 2026-10-12: the Motiondirector
    // room turns carried "You are One … Identity: Hope" and ended with the owner's progress-bar instruction).
    let roomTeammateTurn = false;
    if (requestedOneMode) {
      try { roomTeammateTurn = Boolean((require("../one/room-chat") as typeof import("../one/room-chat")).roomMemberContext(chat.id)); }
      catch { roomTeammateTurn = false; }
    }
    if (requestedOneMode && !roomTeammateTurn) {
      const profile = getOneProfile();
      const invocationScope = {
        projectId: chat.projectId,
        agentId: chat.agentId,
        teamId: chat.firmId,
      };
      const appliedPrinciples = selectApprovedOneOperatingPrinciples(profile, invocationScope);
      let approvedMemoryContext: string | undefined;
      // Approved memory is an optional overlay. A legacy reader or unavailable
      // store must not refuse a fresh owner turn or alter the stored authority.
      try {
        const memoryState = getOneMemoryState();
        const appliedMemories = selectApprovedOneMemoryAssets(invocationScope, memoryState);
        const memoryContext = buildApprovedOneMemoryContext(invocationScope, memoryState);
        const memoryReceipt = {
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
        oneMemoryReceipt = memoryReceipt;
        approvedMemoryContext = memoryContext;
      } catch {
        console.warn("[invocation] optional One memory overlay skipped", { code: "one_memory_overlay_unavailable" });
      }
      // One 페르소나 오버레이 — Main만 붙인다. 실행 경계(solo_locked·preflight)는
      // 위에서 이미 고정됐고, 이 블록은 정체성/능력 서술만 더한다.
      oneProfileContext = [
        ONE_PERSONA_DIRECTIVE,
        buildApprovedOneProfileContext(profile, invocationScope),
        approvedMemoryContext,
        ...(preparedOneMemoryUseOnce ? [preparedOneMemoryUseOnce.context] : []),
        ...(preparedOneBriefingAction ? [preparedOneBriefingAction.context] : []),
      ].filter(Boolean).join("\n\n");
      // A turn whose output the host parses never gets the persona, identity or voice above: they end the owner's reply.
      oneMachineTurnContext = composeMachineTurnOwnerContext(profile, invocationScope,
        [approvedMemoryContext, preparedOneMemoryUseOnce?.context]) || undefined;
      oneProfileReceipt = {
        oneId: profile.oneId,
        profileVersion: profile.version,
        principleIds: appliedPrinciples.map((item) => item.id),
        scopeKinds: [...new Set(appliedPrinciples.map((item) => item.scope))].sort(),
      };
    } else if (
      chat.originSurface === "work"
      && !workspaceBinding
      && req.agentAppMode !== true
      && !["science", "alive", "site-studio", "trex"].includes(executionContext?.source ?? "")
    ) {
      // 첫 실행 07(성격·말투)과 승인된 원칙은 One 대화에만 붙고 Work 실행에는
      // 한 글자도 가지 않았다. Work 는 One 의 정체성·기억을 빌리지 않고, 사람이
      // 직접 쓰고 승인한 선호만 받는다. 같은 필드(oneProfileContext)로 실어야
      // 솔로·프로젝트 팀·회사 경로가 모두 같은 자리에서 읽는다.
      const profile = getOneProfile();
      const invocationScope = { projectId: chat.projectId, agentId: chat.agentId, teamId: chat.firmId };
      const workPreferenceContext = buildApprovedOwnerWorkPreferenceContext(profile, invocationScope);
      if (workPreferenceContext) {
        oneProfileContext = workPreferenceContext;
        oneMachineTurnContext = composeMachineTurnOwnerContext(profile, invocationScope) || undefined;
        const appliedPrinciples = selectApprovedOneOperatingPrinciples(profile, invocationScope);
        oneProfileReceipt = {
          oneId: profile.oneId,
          profileVersion: profile.version,
          principleIds: appliedPrinciples.map((item) => item.id),
          scopeKinds: [...new Set(appliedPrinciples.map((item) => item.scope))].sort(),
        };
      }
    }
    const personalSupervisor = requestedOneMode && personalSupervisorConversationInDb(getDb(), getOneProfile().oneId, chat.id);
    if (personalSupervisor) oneProfileContext = [oneProfileContext, personalSupervisorGuidance(getOneProfile().displayName)].filter(Boolean).join("\n\n");
    const judgedTaskIntent = requestedOneMode && !personalSupervisor
      && invocationRequest.taskIntent === "conversation"
      && classifyOneRequestIntent(invocationRequest.userPrompt,
        (prompt) => judgedOneRequestIntent(prompt, invocationRequest.runtimeSelection, Boolean(boundGoal))) === "task";
    const effectiveTaskIntent: McpInvocationRequest["taskIntent"] = resumesPausedGoal || requestedOneAttachmentRef || (boundGoal && localUserTurn)
      ? "task"
      : judgedTaskIntent
        ? "task"
        : invocationRequest.taskIntent;
    const invocationPermission = effectiveInvocationPermission(
      !workspaceBinding && requestedOneMode
        ? preparedOneBriefingAction
          ? "read"
          : authoritativeOnePermission(selectedOnePermissionMode, effectiveTaskIntent, incoming.permissions)
        : invocationRequest.permissions,
      invocationRequest.planMode,
    );
    const suppressProjectBinding = executionContext?.source === "site-studio" || executionContext?.source === "alive";
    const suppressMutableProjectContext = executionContext?.source === "science" || executionContext?.source === "alive"
      || (executionContext?.source === "automation" && invocationPermission === "read");
    const storedWorkingFolder = runWorkspaceBinding || suppressProjectBinding
      ? null
      : getChatWorkingFolder(req.chatId);
    const projectFolder = runWorkspaceBinding || suppressProjectBinding || suppressMutableProjectContext
      ? null
      : chat.projectId
        ? getProject(chat.projectId)?.folderPath ?? null
        : null;
    const targetAppFolder = !runWorkspaceBinding && !suppressProjectBinding && invocationRequest.targetAppId
      ? getAgentApp(invocationRequest.targetAppId)?.rootPath ?? null
      : null;
    const promptFolder = !runWorkspaceBinding
      && !storedWorkingFolder
      && !projectFolder
      && (invocationPermission === "write" || invocationPermission === "full")
      && !["automation", "site-studio", "trex", "alive"].includes(executionContext?.source ?? "")
      ? inferWorkingFolderFromPrompt(invocationRequest.userPrompt, { authored: "human" })
      : null;
    // Freeze the same Main-owned cwd that runMcpInvocation will hand to every
    // provider: immutable binding, target App, saved chat, Project, explicit
    // human folder, then the concrete agentRunCwd fallback. A provider may
    // return a different resultFolder later, but that is output metadata only.
    const executionCwd = runWorkspaceBinding
      ? runWorkspaceBinding.canonicalPath ?? agentRunCwd()
      : targetAppFolder
        ? path.resolve(targetAppFolder)
        : storedWorkingFolder ?? projectFolder ?? promptFolder ?? agentRunCwd();
    if (nativeController && !isLocalInvocationPreparationPort(nativePreparation!.port) && requestedOneAttachmentRef) {
      const ingress = this.nativeIngress.get(runId);
      if (!ingress || ingress.controller !== nativeController || ingress.selectedCwd !== undefined) throw new Error("native_service_cwd_source_required");
      this.assertNativeServiceObservationSelection(ingress);
      ingress.selectedCwd = executionCwd;
    }
    const resultFolder = executionCwd;
    // The attachment grant is bound to the owner's exact text. A team run executes the proposal's prompt, which
    // prepends standing-staff preferences when a member has a handover note or style (production 1.3.47,
    // 2026-10-16: every room turn with a file was refused before start, runtime_turn_unsettled).
    const oneAttachmentPrompt = preparedOneTeamPreflight ? preparedOneTeamPreflight.userAuthoredPrompt : invocationRequest.userPrompt;
    const claimedOneAttachments = requestedOneAttachmentRef
      ? (yield oneStartCheckpoint("attachments.claim", { ref: requestedOneAttachmentRef, chatId: chat.id, userPrompt: oneAttachmentPrompt, runId, resultFolder, teamProposalId: preparedOneTeamPreflight?.proposalId ?? null }, () => claimOneAttachments({
          ref: requestedOneAttachmentRef, chatId: chat.id, userPrompt: oneAttachmentPrompt, runId, resultFolder, teamProposalId: preparedOneTeamPreflight?.proposalId ?? null,
        }))) as ReturnType<typeof claimOneAttachments>
      : null;
    validateChatAttachmentSelection(chat.id,invocationRequest.fileGroupId,invocationRequest.images);
    if (invocationRequest.fileGroupId) invocationRequest.userPrompt=chatFilePrompt(chat.id,invocationRequest.userPrompt,invocationRequest.fileGroupId);
    const chatFileGroupIds = [...runReqChatFileGroupIds(invocationRequest.userPrompt)];
    // Mobile and personal One supply an explicit Main-validated group for this turn.
    // Historical One markers alone remain unable to grant a new attachment reader.
    const explicitChatFiles = invocationRequest.fileGroupId ? listChatFileSnapshot({chatId:chat.id,groupId:invocationRequest.fileGroupId}) : [];
    const workChatFiles = explicitChatFiles.length ? explicitChatFiles : chat.originSurface === "work" && !requestedOneMode && !runWorkspaceBinding && !invocationRequest.agentAppMode
      ? chatFileGroupIds.flatMap((groupId) => listChatFileSnapshot({ chatId: chat.id, groupId })) : [];
    const validChatFileMarkers = new Set(workChatFiles.map((file) => file.groupId));
    const promptWithoutValidChatFileMarkers = invocationRequest.userPrompt.replace(
      /<!--\s*agentlas-chat-files:v1:([0-9a-f-]{36})\s*-->/giu,
      (marker, groupId: string) => validChatFileMarkers.has(groupId) ? "" : marker,
    ).trim();
    const attachmentDescriptors = [
      ...(claimedOneAttachments?.receipt.attachments.map((item) => `${item.kind}:${item.mediaType}`) ?? []),
      ...workChatFiles.map((item) => `${item.kind}:${item.mediaType}`),
      ...(invocationRequest.images?.map((item) => `image:${item.mediaType}`) ?? []),
    ];
    // Work chat files have a durable, revision-checked reader binding below.
    // Only one-turn One grants and inline images require fresh authorization.
    const hasTransientAttachments = Boolean(claimedOneAttachments?.receipt.attachments.length || invocationRequest.images?.length);
    const attachmentCapabilitySummary = attachmentDescriptors.length > 0
      ? `[ATTACHMENT CAPABILITIES - host verified]\n${attachmentDescriptors.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n[/ATTACHMENT CAPABILITIES]`
      : undefined;
    /*
     * Relays a waiting Goal refused earlier (deferred-system-relays.ts) ride on this turn's Main-only context, once.
     * Only a turn that can claim them reads them; the claim is made right after the waiting-Goal guard below.
     */
    const deferredRelayEligible = !backgroundObservation && !executionContext && !workspaceBinding
      && req.agentAppMode !== true && !effectObservation;
    let deferredRelays: ReturnType<typeof peekDeferredSystemRelays> = null;
    if (deferredRelayEligible) {
      try { deferredRelays = peekDeferredSystemRelays(chat.id, 15_000 - (oneProfileContext?.length ?? 0) - 2); }
      catch (error) { console.warn("[invocation] deferred relays unreadable; the turn runs without them:", error); }
    }
    if (deferredRelays) oneProfileContext = [oneProfileContext, deferredRelays.block].filter(Boolean).join("\n\n");
    const runReq: OneInvocationRequest = {
      ...invocationRequest,
      runId,
      // The resident judge decides "conversation vs task" by meaning: the async
      // invoke paths warm the judgment cache (prejudgeOneRequestIntent) and this
      // sync site peeks it; without a judged verdict the intent remains undecided.
      taskIntent: effectiveTaskIntent,
      permissions: invocationPermission,
      ...(oneProfileContext ? { oneProfileContext } : {}),
      ...(oneMachineTurnContext ? { oneMachineTurnContext } : {}),
      ...(claimedOneAttachments ? {
        images: claimedOneAttachments.images,
        oneAttachmentContext: claimedOneAttachments.runtimeContext,
        oneAttachmentRedactions: claimedOneAttachments.redactions,
      } : {}),
      ...(invocationRequest.fileGroupId ? {images:[...(invocationRequest.images ?? []),...chatFileImages(chat.id,invocationRequest.fileGroupId)]} : {}),
      ...(attachmentCapabilitySummary ? { attachmentCapabilitySummary } : {}),
    };
    if (effectObservation && runReq.permissions !== "read") throw new Error("effect_observation_must_be_read_only");
    // The owner's reply to the Goal's own question is the resume, however short it is ("승인"): soak 1.2.50,

    // goal_owner_answer_required from 2026-09-28 11:51Z until a manual resume the next day.
    const reopen = boundGoal ? stoppedGoalMessageReopens(boundGoal, runReq.taskIntent) : { reopens: false, ownerAnswer: false };
    const ownerAnswersGoalQuestion = reopen.ownerAnswer;
    // A host continuation or retry may wait between turns without a pending
    // wait subscription. The owner's task still needs the durable resume below
    // before a new controller can acquire this Goal's execution authority.
    /*
     * A Goal the sweep has just queued for its next continuation (retry due) has no turn running yet. The owner's task
     * message takes that turn: it was refused goal_episode_admission_stale (the producer is admitted only while the Goal
     * is running) and the owner's message failed in 3 s (W7 2026-10-17, YouTube room, the owner wrote while the sweep's
     * retry had queued the Goal). The chat still runs one turn at a time; the sweep's continuation, if it comes later,
     * finds the chat busy and schedules its next retry.
     */
    const queuedGoalTakeover = boundGoal?.status === "queued" && localUserTurn && runReq.taskIntent !== "conversation";
    if (boundGoal && (boundGoal.status === "blocked" || boundGoal.status === "paused" || boundGoal.status === "waiting_tool"
      || boundGoal.status === "queued") && localUserTurn && (reopen.reopens || queuedGoalTakeover)) {
      // A new task message must not silently reactivate a claimed wait whose
      // successor may already have reached an external runtime before crash.
      if (boundGoal.surface === "science" || boundGoal.rootChatId !== chat.id) {
        throw new Error("goal_control_scope_mismatch");
      }
      // Admission is read-only. The durable-message hook records the user's
      // resume authority atomically with the state transition, not before it.
      stoppedGoalReactivation = { runId: boundGoal.id, version: boundGoal.version, status: boundGoal.status,
        ...(ownerAnswersGoalQuestion ? { ownerAnswer: true } : {}) };
    }
    const record: RunRecord = {
      ...(oneTeamReportCustody ? {oneTeamReportCustody,oneTeamReportOriginalRequest:Object.freeze(structuredClone(req))} : {}),
      ...(nativePreparation ? {nativeOwnerTextChoices:canonicalInvocationRequestJson(nativeOwnerTextChoices(nativePreparation.request) as unknown as McpInvocationRequest)} : {}),
      controller,
      background: backgroundObservation,
      chatId: req.chatId,
      request: runReq,
      startedAt,
      cancelRequestedAt: null,
      steeringInterruptRequested: false,
      events: [],
      partialText: "",
      agentPartialTexts: new Map(),
      resultFolder,
      oneMode: requestedOneMode,
      goal: invocationRequest.userPrompt.slice(0, 4_000),
      pendingQuestion: false,
      hasTransientAttachments,
      ...(questionContinuation
        ? {
            questionContinuationSourceMessageId: questionContinuation.sourceMessageId,
            questionContinuationRequestHash: questionContinuation.requestHash,
          }
        : {}),
      settlementPublished: false,
      observableStepSequence: 0,
      semanticSteps: new SemanticRunStepProjector(runId, req.chatId),
      deliveryOrdinal: 0,
      ...(executionContext?.source ? { executionSource: executionContext.source } : {}),
      ...(executionContext ? { executionContext } : {}),
      ...(runWorkspaceBinding ? { workspaceBinding: runWorkspaceBinding } : {}),
    };
    let recoverablePartialPersisted = false;
    // Main-stream events carry the resolved installed author. Worker events
    // must never replace it when an interrupted partial becomes durable.
    let mainSpeakerAgentId: string | null = null;
    const persistRecoverableAssistantPartial = (): void => {
      if (
        record.background
        || recoverablePartialPersisted
        || runReq.agentAppMode
        || remoteWorkspaceBinding
        || !record.partialText.trim()
      ) return;
      try {
        appendChatMessage(
          runReq.chatId,
          "assistant",
          markInterruptedPartial(record.partialText, pickLocale(runReq)),
          mainSpeakerAgentId ? { speakerAgentId: mainSpeakerAgentId } : undefined,
        );
        recoverablePartialPersisted = true;
      } catch {
        // The durable run ledger remains authoritative for the failure. A
        // secondary transcript write failure must not block run settlement.
      }
    };
    let emptyFailureNoticePersisted = false;
    // A failed team run first commits its own honest reply ("This task is not complete yet …")
    // and only then turns the held final into an error. That reply arrives as a durable message
    // identity, not as streamed partial text, so partialText stays empty — and the run used to
    // append a second, false "failed before it could finish a reply" notice under it
    // (2026-10-04, verify-one-improvement-proof-producer failed-worker scenario).
    let durableAssistantReplyBound = false;
    // `errorCode` is the run's own terminal code. A cause inside the app (shared/run-failure-cause.ts) is reported as
    // "app-failed", never as a needs-owner ask: the owner has nothing to do (Yotube 2026-10-17, goal_episode_admission_missing).
    // `failure` is the run's error event when it has one: its typed provider failure (quota, rate limit, sign-in, refusal, an
    // unfinished provider turn) is worded by shared/run-failure-notice.ts, and is the provider's outcome, never an app problem
    // (F51, 2026-10-21: a turn blocked by the provider's content safety filters read "The run failed …" + "App problem").
    const persistEmptyFailureNotice = (terminalKind: string, errorCode?: string | null, failure?: McpInvocationEvent["error"]): void => {
      const abortReason = controller.signal.reason instanceof Error ? controller.signal.reason.message : null;
      if (record.background || emptyFailureNoticePersisted || durableAssistantReplyBound || record.partialText.trim() || runReq.agentAppMode || remoteWorkspaceBinding
        || runReq.promptOrigin === "system" || terminalKind === "invoke_cancelled"
        || record.steeringInterruptRequested || isOwnerGoalStopCause(abortReason)) return;
      try {
        const locale = pickLocale(runReq);
        const hostCause = invocationHostStopCause(abortReason);
        const typedFailureText = hostCause || terminalKind === "invoke_interrupted" ? null : runFailureNoticeText({
          locale, errorCode, runtimeFailure: failure?.runtimeFailure, turnDelivery: failure?.turnDelivery,
          detail: failure?.message ? redactWorkAttachmentText(runReq, redactOneAttachmentText(runReq, failure.message)) : undefined,
        });
        const message = hostCause ? invocationHostStopCopy(hostCause, locale).detail
          : terminalKind === "invoke_interrupted"
            ? locale === "ko" ? "실행이 중단되어 답변을 완료하지 못했습니다. 요청은 저장되어 있습니다. 실행 기록에서 중단 원인과 재개 상태를 확인할 수 있습니다."
              : "The run was interrupted before it could finish a reply. Your request is saved; run history shows the interruption and resume status."
            : typedFailureText ?? (locale === "ko" ? "실행이 실패해 답변을 완료하지 못했습니다. 요청은 저장되어 있습니다. 실행 기록에서 실패 원인과 복구 상태를 확인할 수 있습니다."
              : "The run failed before it could finish a reply. Your request is saved; run history shows the failure and recovery status.");
        appendChatMessage(chat.id, "assistant", message,
        { hostNotice: { purpose: "host-status", runId, status: hostCause ? "goal-paused" : isAppSideRunFailureCode(errorCode, failure?.runtimeFailure) ? "app-failed" : "needs-owner" } });
        emptyFailureNoticePersisted = true;
      } catch { /* The failure ledger remains authoritative if the transcript write fails. */ }
    };
    const oneParticipantPresentation = new Map<string, { name: string; role: string }>();

    try {
      let oneParticipantVersionBindings: OneParticipantVersionBinding[] | undefined;
      if (runReq.oneMode) {
        const participants = exactOneInvocationParticipants(chat.agentId, preparedOneTeamPreflight, inheritedOneRoom?.taskForceTargets);
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
      if (!record.background) {
        record.ownerLease = startBoundary.ownerLease = claimInvocationRunOwner(runReq.chatId, runId);
      }
      registerDurableInvocationStart({
        registry: this.activeRuns,
        runId,
        record,
        publishActiveState: () => this.publishActiveChats(),
        persistStart: () => {
          assertDesktopOneRecoveryStart(runReq);
          if(record.oneTeamReportCustody && !queuedTeamReportCurrent(record.oneTeamReportCustody,record.oneTeamReportOriginalRequest!))throw new Error("one_team_report_owner_unbound");
          const persistReceipt = () => recordRunEvent({
          runId,
          kind: "invoke_started",
          chatId: runReq.chatId,
          agentId: chat.agentId,
          payload: {
            background: record.background === true,
            oneMode: runReq.oneMode,
            latestUserMessageRowId: (getDb().prepare("SELECT MAX(rowid) AS cursor FROM chat_messages WHERE chat_id=? AND role='user'")
              .get(runReq.chatId) as { cursor: number | null }).cursor ?? undefined,
            onePermissionMode: selectedOnePermissionMode ?? undefined,
            fastMode: runReq.fastMode === true || undefined,
            locale: pickLocale(runReq),
            // Persist the semantic boundary that Main actually received. This
            // makes conversation -> Task promotion auditable without trying to
            // reconstruct it later from human-readable Activity text.
            taskIntent: runReq.taskIntent,
            invocationSource: executionContext?.source === "science" ? "science" : runWorkspaceBinding?.source,
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
            ...(inheritedOneRoom ? { oneRoomRosterBinding: { roomId: inheritedOneRoom.roomId,
              revision: inheritedOneRoom.revision, memberAgentIds: inheritedOneRoom.memberAgentIds } } : {}),
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
          });
          if (!durableAdmission) {
            persistReceipt();
            return;
          }
          const admitted = admitInvocationWithStartReceipt(durableAdmission, persistReceipt);
          if (admitted.kind !== "admitted") {
            throw new Error(`invocation_admission_${admitted.kind === "conflict" ? admitted.reason : admitted.admission.status}`);
          }
        },
      });
      startBoundary.crossed = true;
      startBoundary.runId = runId;
      if (record.workspaceBinding) recordInvocationArtifactWorkspace({chatId:record.chatId,runId,binding:record.workspaceBinding});
      startBoundary.cleanups = nativeController && !isLocalInvocationPreparationPort(nativePreparation!.port) ? [] : [() => releaseOneAttachmentRun(requestedOneAttachmentRef)];
      if (nativePreparation?.ordinaryTurn) {
        nativePreparation.ordinaryTurn.record = record;
        nativePreparation.ordinaryTurn.phase = "admitted";
        nativePreparation.ordinaryTurn.observation?.onAdmitted();
      }
    } catch (error) {
      (yield oneStartCheckpoint("attachments.release", { ref: requestedOneAttachmentRef }, () => releaseOneAttachmentRun(requestedOneAttachmentRef)));
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
        const claimed = (yield oneStartCheckpoint("team.claim", { leaseId: record.ownerLease?.leaseId }, () => claimPreparedOneTeamPreflight(preparedOneTeamPreflight!))) as ReturnType<typeof claimPreparedOneTeamPreflight>;
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
        (yield oneStartCheckpoint("team.fail-start", { ref: preparedOneTeamPreflight.ref }, () => failOneTeamPreflightStart(preparedOneTeamPreflight.ref)));
        (yield oneStartCheckpoint("attachments.release", { ref: requestedOneAttachmentRef }, () => releaseOneAttachmentRun(requestedOneAttachmentRef)));
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
        const claimed = (yield oneStartCheckpoint("briefing.claim", { leaseId: record.ownerLease?.leaseId }, () => claimPreparedOneBriefingAction(preparedOneBriefingAction!))) as ReturnType<typeof claimPreparedOneBriefingAction>;
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
        (yield oneStartCheckpoint("attachments.release", { ref: requestedOneAttachmentRef }, () => releaseOneAttachmentRun(requestedOneAttachmentRef)));
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
        claimed = (yield oneStartCheckpoint("memory.claim", { leaseId: record.ownerLease?.leaseId }, () => claimPreparedOneMemoryUseOnce(preparedOneMemoryUseOnce!))) as ReturnType<typeof claimPreparedOneMemoryUseOnce>;
      } catch (error) {
        // Attachments have already crossed their own one-shot claim boundary.
        // A later Main-owned capability failure must not strand staged copies.
        if (this.activeRuns.settle(runId)) this.publishActiveChats();
        (yield oneStartCheckpoint("attachments.release", { ref: requestedOneAttachmentRef }, () => releaseOneAttachmentRun(requestedOneAttachmentRef)));
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
    if (nativeController && claimedOneAttachments) {
      runReq.images = (yield oneStartCheckpoint("images.transfer", { leaseId: record.ownerLease?.leaseId, attachments: claimedOneAttachments.receipt.attachments }, () => claimedOneAttachments.images)) as NonNullable<McpInvocationRequest["images"]>;
      controller.signal.throwIfAborted();
    }
    if (nativeController) yield oneStartCheckpoint("preparation.handoff", { leaseId: record.ownerLease?.leaseId }, () => undefined);
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
    const projectTaskStatus = (...args: Parameters<typeof trySetTaskStatus>): CanonicalTask | null =>
      record.background ? null : trySetTaskStatus(...args);
    let canonicalTask: CanonicalTask | null;
    if (runReq.taskIntent !== "conversation") {
      canonicalTask = projectTaskStatus(req.chatId, "running", true, invocationOrigin);
    } else {
      // A previously promoted conversation stays a Task on later turns.
      canonicalTask = projectTaskStatus(req.chatId, "running", false, invocationOrigin);
    }
    let taskMaterialized = Boolean(canonicalTask);
    startBoundary.cleanups?.push(() => {
      if (taskMaterialized) projectTaskStatus(runReq.chatId, terminalTaskStatus({ kind: "error", requestsDecision: false,
        cancelled: false, hasPartialText: false }), taskMaterialized, invocationOrigin);
    });
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
    recordObservableRunStep(canonicalTask, runId, lifecycleStartEvent, lifecycleStartSequence, record.semanticSteps);
    record.events.push(lifecycleStartEvent);
    recordMcpInvocationEvent(runId, runReq, lifecycleStartEvent);
    this.publishRunEvent(record, { runId, chatId: runReq.chatId, event: lifecycleStartEvent });

    const effectBoundary = new InvocationEffectBoundaryTracker(runId, runReq.chatId);
    let terminalObserved = false;
    // A read-only effect observation looks at the outside world for a blocked
    // Goal; it is not a Goal cycle. It must not bind a controller attempt, claim
    // completion, register waits or run the verifier on that Goal.
    let projectionGoalId = effectObservation ? null : chat.goalId;
    /** This owner turn does not run the chat's stopped Goal (a conversational message, or a resume that could not apply). */
    let ordinaryTurnOnStoppedGoal = false;
    // A goal-mode turn in a chat still bound to an ENDED Goal starts a new Goal instead of attaching to the ended one.
    if (projectionGoalId && runReq.goalMode && !executionContext && boundGoalIsTerminal(projectionGoalId)) {
      setChatGoalBinding(chat.id, null);
      projectionGoalId = null;
    }
    let effectObservationParsed: ParsedEffectObservation | null = null;
    let effectObservationFailed = false;
    const effectObservationDeadline = effectObservation
      ? setTimeout(() => this.cancelWithReason(runId, new Error("effect_observation_time_budget")), EFFECT_OBSERVATION_TIME_LIMIT_MS)
      : null;
    startBoundary.cleanups?.push(() => { if (effectObservationDeadline) clearTimeout(effectObservationDeadline); });
    if (!projectionGoalId && runReq.goalMode && (runReq.permissions === "write" || runReq.permissions === "full")) {
      projectionGoalId = resolveDesktopWorkforceGoalId({
        chatGoalId: null,
        projectId: chat.projectId,
        taskId: canonicalTask?.id ?? null,
        chatId: chat.id,
      });
      /*
       * The project-derived id is the workforce roster's continuity key, not a per-conversation Goal.
       * A second goalMode chat in the same project re-used the first chat's long run (rootChatId = the
       * first chat), so pausing from the second chat failed goal_control_scope_mismatch (isolated live
       * run 2026-09-25). Same rule as chats:setGoalMode: a new Goal whose derived id already has a run
       * owned by another conversation gets its own id.
       */
      projectionGoalId = freshGoalIdForChat(projectionGoalId, chat.id);
      try {
        const objective = ownerVisiblePrompt(runReq).replace(/\s+/g, " ").trim();
        const acceptanceCriteria = deriveGoalAcceptanceCriteria(objective, pickLocale(runReq), runReq.permissions);
        /*
         * Bind the chat BEFORE the ledger row is created: ensureGoalLongRun finds its root chat through
         * chats.goal_id. Binding afterwards created a long run with rootChatId null, and the first usage
         * receipt then failed long_run_usage_anchor_mismatch, killing the turn as
         * mcp-runtime-config-unavailable (isolated live run 2026-09-24, goalMode Work chat without a task).
         */
        if (objective) setChatGoalBinding(chat.id, projectionGoalId);
        if (!objective || !ensureGoalLedgerGoal({
          goalId: projectionGoalId,
          objective,
          acceptanceCriteria,
          projectDir: executionCwd,
        })) {
          if (objective && getChat(chat.id)?.goalId === projectionGoalId) setChatGoalBinding(chat.id, null);
          projectionGoalId = null;
        } else {
          /*
           * ★대화에 목표 번호만 찍고 계약을 안 만들면, 그 목표는 영영 못 닫는다.
           *
           * 이 경로는 실행 원장(long_runs)만 만들고 chat_goal_contracts 는 안 만들었다.
           * 그런데 화면의 목표 칩·완료 판정·"껐다 켜면 이어가기"는 **그 계약**을 본다.
           * 그래서 칩은 뜨는데 닫을 대상도 이어갈 대상도 없었다.
           *
           * 실측(오너 설치본 v1.1.8, QA 격리 재현 둘 다 같은 모양):
           *   goal:auto-message:…  계약 있음 · 실행 있음 → 33초 만에 completed 로 닫힘
           *   goal:desktop:…       계약 **없음** · 실행 있음 → 영원히 안 닫힘
           * 그 저장소에서 목표가 완료된 적은 한 번도 없었다(completed 0).
           *
           * 계약은 실행 원장과 같은 사실을 다른 각도로 적는 것이므로, 여기서 함께 적는다.
           * 실패해도 실행은 계속 간다 — 계약이 없다고 실행을 죽이면 더 나쁘다.
           */
          try {
            armChatGoalContract({ goalId: projectionGoalId, chatId: chat.id });
            defineChatGoalContract({
              goalId: projectionGoalId,
              chatId: chat.id,
              objective,
              acceptanceCriteria,
            });
          } catch (contractError) {
            console.warn("[long-run] goal contract not recorded:", contractError);
          }
        }
      } catch (error) {
        projectionGoalId = null;
        console.warn("[long-run] first Goal materialization failed:", error);
      }
    }
    let goalLongRun = projectionGoalId ? getLongRunByGoalId(projectionGoalId) : null;
    if (!stoppedGoalReactivation && !executionContext && goalLongRun?.rootChatId === chat.id) {
      const superseded = supersedeGoalWaitForInvocation(goalLongRun.goalId, runId);
      // A start that fails before any provider runs gives the Goal its wait back (releaseUndispatchedStart runs this).
      if (superseded) startBoundary.cleanups?.push(() => { restoreGoalWaitAfterUndispatchedStart(superseded); });
      goalLongRun = getLongRunByGoalId(goalLongRun.goalId);
    }
    // A Desktop Goal turn is admitted only while its Goal is running (admitGoalProducer). Host continuations make it
    // running (or queued, confirmed right after start) before they start, and a pending wait was superseded above;
    // only an owner message may resume a Goal that waits for the owner or a scheduled retry. A system turn arriving
    // then (a One relay drained after the Goal's turn asked the owner a question: Youtube launch 2026-10-10 07:00Z,
    // run 7f8c7a55) spent 37 s of model calls and failed goal_episode_admission_missing. Refuse it before any call.
    if (!localUserTurn && !record.background && !executionContext && !runReq.agentAppMode && !effectObservation
      && goalLongRun?.rootChatId === chat.id && goalLongRun.surface !== "science"
      && ["waiting_tool", "blocked", "waiting_user"].includes(goalLongRun.status)) {
      /*
       * The refusal stands, but a relay is a teammate's work handed back or a room follow-up for One: dropping it lost
       * that work for good (group room 8f3e09ee, 1.3.4, 2026-10-12). Park it with the cause; the chat's next real turn
       * carries it as context. Host continuations (task turns) are not relays and are not parked.
       */
      if (invocationRequest.oneMode && invocationRequest.taskIntent === "conversation") {
        try {
          deferSystemRelay({ chatId: chat.id, text: invocationRequest.userPrompt, cause: `goal_${goalLongRun.status}`,
            goalStatus: goalLongRun.status, originRunId: runId });
        } catch (deferError) { console.warn("[invocation] refused system relay could not be parked:", deferError); }
      }
      throw new Error("goal_waiting_system_start_refused");
    }
    if (deferredRelays) {
      try {
        if (claimDeferredSystemRelays(deferredRelays.ids, runId)) startBoundary.cleanups?.push(() => { releaseDeferredSystemRelays(runId); });
      } catch (claimError) { console.warn("[invocation] deferred relays were claimed by another turn first:", claimError); }
    }
    let goalLongRunTask = goalLongRun ? listLongRunTasks(goalLongRun.id, true)[0] ?? null : null;
    // An ongoing Goal's episode needs an open task, or no controller attempt is bound and its cycle wait is refused

    if (!goalLongRunTask && goalLongRun && !executionContext && goalLongRun.rootChatId === chat.id) {
      try { goalLongRunTask = ensureOngoingEpisodeTask({ longRunId: goalLongRun.id, invocationRunId: runId }); }
      catch (error) { console.warn("[long-run] ongoing episode task unavailable:", error); }
    }
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
            cwd: executionCwd,
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
      // A Goal whose canonical rows disagree (a closed contract on a live ledger row, a revision bound elsewhere) cannot
      // own this turn's Stop custody. That used to throw here, after the durable receipt, and refuse every owner message
      // in the chat for good (no-dead-end sweep 2026-10-25). The message runs as an ordinary turn instead; the Goal keeps
      // its rows untouched and the turn's own Stop stays unconditional (it aborts this run's controller).
      if (goalLongRun.rootChatId === chat.id) {
        try {
          record.goalStopOwner = captureNativeGoalStopOwner({ goalId: goalLongRun.goalId, rootChatId: chat.id, longRunId: goalLongRun.id });
        } catch (error) {
          tryRecordRunEvent({ runId, chatId: chat.id, kind: "goal_dispatch_ordinary_turn", payload: { goalId: goalLongRun.goalId,
            goalStatus: goalLongRun.status, cause: "goal_stop_owner_unavailable",
            code: (error as { code?: unknown })?.code ?? (error instanceof Error ? error.message.slice(0, 80) : null) } });
          record.automaticGoalId = undefined;
          record.longRunProjection = undefined;
          projectionGoalId = null;
          goalLongRun = null;
          goalLongRunTask = null;
          goalInvocationProjection = null;
          // Nor is it resumed by this message: its rows are not coherent enough to own an episode.
          stoppedGoalReactivation = null;
          ordinaryTurnOnStoppedGoal = true;
        }
      }
    }
    let goalControllerAttemptId: string | null = null;
    let goalControllerAttemptSettled = false;
    /*
     * The orchestrator's runtime-selected event can arrive before the automatic Goal is admitted
     * (the admission judgment runs inside the pre-execution hook, ~9s in the 2026-09-24 isolated run).
     * Binding only on that event left every first-turn Goal without a controller attempt, so its
     * checkpoint could never mint settled effects and blocked
     * after turn one — even a read-only "2+2" One goal. Remember the selection and bind once the
     * Goal projection exists.
     */
    let lastControllerSelection: RuntimeSelection | null = null;
    const desktopProducerAdmission = !record.background && !executionContext && !runReq.agentAppMode && !effectObservation;
    let producerAdmission: GoalProducerAdmission | null | undefined;
    let producerWorkDispatchSealed = false;
    const assertProducerServiceLifetime = (): void => {
      if (!desktopProducerAdmission || producerWorkDispatchSealed || controller.signal.aborted
        || this.activeRuns.get(runId) !== record || record.chatId !== chat.id
        || !startBoundary.crossed || startBoundary.runId !== runId) throw new Error("goal_episode_admission_lifetime_stale");
    };
    /** Preserve the root runtime's typed cause in the durable controller attempt. */
    let observedRuntimeErrorCode: string | null = null;
    /*
     * A fresh explicit Goal (goal chip or goalMode turn) had no revision until a later sweep adopted the owner's
     * recorded turn, so its first controller attempt carried no revision and the first verification always ended
     * verification_goal_revision_unbound (live 2026-09-25). Adopt the same recorded grant — this turn's
     * invoke_started + invoke_prompt_bound are durable by now — before the producer admission is captured and before the
     * attempt is stamped. Adopting after the capture made a LATER owner turn on a Goal without a revision (a paused
     * explicit Goal from before da35c424, resumed by the owner's message) fail goal_episode_admission_stale, then
     * goal_episode_admission_missing: the adoption moved the run version under the captured custody, and only the Goal's
     * own first turn is exempt from that (W7 2026-10-17, YouTube room, on 1.3.63 and 1.3.64 alike).
     */
    const adoptRecordedExplicitGrant = (): void => {
      if (!goalLongRun || executionContext || goalLongRun.surface === "science" || getChatGoalRevision(goalLongRun.goalId)) return;
      try {
        // No goal-mode turn of this Goal is recorded (a Goal defined through chats:defineGoal): the owner's own message
        // turn running now is the instruction the "send one more message" notice asks for (explicit-goal-authority.ts).
        const ownerTurn = localUserTurn && !backgroundObservation && !effectObservation && goalLongRun.rootChatId === chat.id
          ? { invocationRunId: runId } : undefined;
        if (adoptExplicitGoalGrant(goalLongRun.goalId, ownerTurn)) {
          goalLongRun = getLongRunByGoalId(goalLongRun.goalId);
          goalLongRunTask = goalLongRun ? listLongRunTasks(goalLongRun.id, true)[0] ?? null : null;
        }
      } catch (error) {
        console.warn("[long-run] explicit goal grant adoption at first turn failed:", error);
      }
    };
    const bindGoalControllerAttempt = (selection: RuntimeSelection): void => {
      if (!goalLongRun || !goalLongRunTask || goalControllerAttemptId || goalControllerAttemptSettled) return;
      adoptRecordedExplicitGrant();
      if (!goalLongRun || !goalLongRunTask) return;
      // A Goal revision owns a new durable task. Reusing one controller worker
      // across revisions makes the immutable task binding conflict on resume.
      // Keep retries of the same revision on one worker, while giving each
      // revised task its own controller lineage.
      const workerId = `controller_${createHash("sha256")
        .update(`${goalLongRun.id}:${goalLongRunTask.id}`)
        .digest("hex")
        .slice(0, 32)}`;
      try {
        const longRunRuntimeSelection = captureLongRunRuntimeSelection(selection, { requireExact: true });
        const workerBinding: Parameters<typeof bindLongRunWorker>[0] = {
          workerId,
          runId: goalLongRun.id,
          parentWorkerId: null,
          taskId: goalLongRunTask.id,
          role: "controller",
          agentDefinitionId: chat.agentId,
          agentRelease: null,
          runtimeSelection: longRunRuntimeSelection,
          workspaceBinding: {
            projectId: chat.projectId,
            cwd: executionCwd,
            revision: null,
          },
          permissionProfile: runReq.permissions ?? "read",
          state: "idle",
        };
        if (desktopProducerAdmission) {
          if (!producerAdmission) throw new Error("goal_episode_admission_missing");
          goalControllerAttemptId = admitGoalProducer({ admission: producerAdmission, goalId: goalLongRun.goalId,
            worker: workerBinding }, assertProducerServiceLifetime).attemptId;
          // The first owner claim advances the run version without a synthetic status transition.
          refreshGoalProjection();
        } else {
          bindLongRunWorker(workerBinding);
          goalControllerAttemptId = startLongRunWorkerAttempt({
            runId: goalLongRun.id, workerId, taskId: goalLongRunTask.id, invocationRunId: runId,
            runtimeSelection: longRunRuntimeSelection,
          }).attemptId;
        }
        goalInvocationProjection?.bindController(workerId, chat.agentId ?? `controller:${chat.id}`);
      } catch (error) {
        console.warn("[long-run] controller attempt binding failed:", error);
      }
    };
    const settleGoalControllerAttempt = (completed: boolean): void => {
      if (!goalControllerAttemptId || goalControllerAttemptSettled) return;
      goalControllerAttemptSettled = true;
      const terminalDisposition = classifyMainOwnedTerminal({
        eventKind: completed ? "final" : "error",
        steeringInterruptRequested: record.steeringInterruptRequested,
        signalAborted: controller.signal.aborted,
        abortReason: controller.signal.reason,
      });
      settleLongRunWorkerAttempt({
        attemptId: goalControllerAttemptId,
        state: completed ? "completed" : "interrupted",
        ...(!completed
          ? { errorCode: terminalDisposition.errorCode ?? observedRuntimeErrorCode ?? "runtime_interrupted" }
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
    /*
     * ★승격을 물을 수 있는 실행 — 읽기 전용만이 아니다.
     *
     * 조건이 `permissions === "read"` 였다. 그런데 사람이 실제로 막히는 자리는 그것만이
     * 아니다: 쓰기 권한 실행에서도 작업 폴더 밖 경로는 거부되고, 그때 화면에는 "승인할 사람이
     * 붙어 있지 않습니다"라는 문장과 기계 코드 한 줄만 남았다 — **채팅 앞에 사람이 앉아
     * 있는데도**, 권한을 올릴 버튼 하나 없이(QA 실측 2026-09-07).
     *
     * 이미 full 인 실행은 더 올릴 것이 없으므로 제외한다. 승격 자체는 여전히 사람이 칩에
     * 답해야 일어나고, 무응답은 기존 계약대로 거부로 닫힌다.
     */
    const permissionEscalationEligible =
      !effectObservation
      && !runReq.agentAppMode
      && !runWorkspaceBinding
      && Boolean(runReq.chatId)
      && (runReq.permissions ?? "read") !== "full";
    if (!record.background && !runReq.agentAppMode && (explicitChatFiles.length > 0 || (chat.originSurface === "work" && !requestedOneMode && !runWorkspaceBinding))) {
      const pinnedRevision = goalLongRun ? getChatGoalRevision(goalLongRun.goalId) : null;
      bindWorkAttachmentRun({ runId, chatId: chat.id, signal: controller.signal, readGroups: () => {
        const groups = explicitChatFiles.length ? [invocationRequest.fileGroupId!] : workAttachmentGroupIds(runReq.userPrompt);
        if (pinnedRevision && goalLongRun) {
          const current = getChatGoalRevision(goalLongRun.goalId);
          if (!current || current.revision !== pinnedRevision.revision || current.chatId !== chat.id) throw new Error("work_attachment_goal_revision_changed");
          for (const source of [current.originalRequest, current.sourceMessage]) {
            const message = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(source.messageId) as { chat_id: string; role: string; text: string } | undefined;
            if (!message || message.chat_id !== chat.id || source.chatId !== chat.id || message.role !== "user" || message.text !== source.text) throw new Error("work_attachment_goal_source_changed");
            groups.push(...workAttachmentGroupIds(source.text));
          }
        }
        return [...new Set(groups)];
      } });
      startBoundary.cleanups?.push(() => { void releaseWorkAttachmentRun(runId).catch(() => { /* the binding is closed either way */ }); });
    }
    const lifetime = record.mainLifetime = new MainInvocationLifetime(mainAdmission, chat.id, runId);
    this.settlingRuns.set(runId, record);
    const canonicalWorkRecovery = executionContext?.source === "science" || executionContext?.aliveScience ? undefined
      : new MainWorkRecoveryContext(chat.id,runId,()=>{
        controller.signal.throwIfAborted();
        if(this.settlingRuns.get(runId)!==record)throw new Error("main_work_invocation_owner_ended");
      });
    let retryGoalCheckpoint: { goalId: string; checkpointId: string } | undefined;
    // Defer dispatch inside the captured lifetime/ALS so a synchronous throw
    // reaches the same terminal and registry cleanup as a rejected runner.
    record.completion = lifetime.run(() => withBrowserDownloadProofContext({ runId, chatId: chat.id, agentId: chat.agentId ?? null, signal: controller.signal,
      readOwner: () => goalLongRun && goalLongRun.surface !== "science" ? {goalId:goalLongRun.goalId,attemptId:goalControllerAttemptId} : null }, () => withBuiltinFileProofContext({ runId, chatId: chat.id, agentId: chat.agentId ?? null, signal: controller.signal,
      readOwner: () => goalLongRun && goalLongRun.surface !== "science" ? { goalId: goalLongRun.goalId, attemptId: goalControllerAttemptId } : null }, () => withInvocationAccounting({ runId, chatId: chat.id, readOwner: () =>
      goalLongRun && goalLongRun.surface !== "science"
        ? { goalId: goalLongRun.goalId, attemptId: goalControllerAttemptId } : null }, () => withAdapterEffectContext({ runId, chatId: chat.id, rootAgentId: chat.agentId ?? null,
        source: executionContext?.source, nativeScienceTool: binding => effectBoundary.nativeScienceTool(binding),
        nativeScienceFailure: observation => effectBoundary.nativeScienceFailure(observation),
        nativeRuntimeDiagnostic: diagnostic => tryRecordRunEvent({ runId, chatId: chat.id, agentId: chat.agentId ?? null,
          kind: "runtime_native_diagnostic", sourceEventId: `native-runtime-diagnostic:${diagnostic.diagnosticAttemptId}:${diagnostic.phase}:${diagnostic.sequence}`,
          evidencePhase: "observed", payload: { ...diagnostic } }),
        begin: admission => { effectBoundary.adapterStarted(admission); record.semanticSteps.admitAdapter(admission); }, finish: (scopeId, report) => effectBoundary.adapterFinished(scopeId, report),
        hostControl: observation => effectBoundary.hostControl(observation), recordingFailed: () => effectBoundary.recordingFailed() }, () => Promise.resolve().then(() => {
        if (record.ownerLease) assertInvocationRunOwner(record.ownerLease);
        const handoverLease = record.ownerLease;
        const nativeApprovalOwner = nativeController && record.ownerLease && (!isLocalInvocationPreparationPort(nativePreparation!.port) || record.ownerLease.ownerKind === "daemon")
          ? { originalRequest: runReq, runId, chatId: chat.id, ownerId: record.ownerLease.ownerId, leaseId: record.ownerLease.leaseId,
              signal: controller.signal, actor: nativePreparation!.actorSnapshot, assertCurrent: () => {
                if (this.activeRuns.get(runId) !== record || record.controller !== controller || record.request !== runReq
                  || controller.signal.aborted || !record.ownerLease) throw new Error("native_approval_execution_ended");
                assertInvocationRunOwner(record.ownerLease);
              } } : undefined;
        if (nativeApprovalOwner && !lifetime.ownsActiveRoot()) throw new Error("native_approval_execution_root_required");
        // Chat host handover (1.3.0 A2): the chat's previous turn ran in the other process, so that process lets go of its
        // idle resident runtime sessions before this one dispatches, and the same provider thread resumes here.
        const handedOver = handoverLease ? this.handOverChatHost(handoverLease, runReq.chatId, runId) : undefined;
        const dispatch = () => {
          controller.signal.throwIfAborted();
          if(record.oneTeamReportCustody && !queuedTeamReportCurrent(record.oneTeamReportCustody,record.oneTeamReportOriginalRequest!))throw new Error("one_team_report_owner_changed");
          return withNativeApprovalExecution(nativeApprovalOwner, () => runMcpInvocation(
      runReq,
      (rawEvent) => {
        if(record.oneTeamReportCustody && !queuedTeamReportCurrent(record.oneTeamReportCustody,record.oneTeamReportOriginalRequest!)) {
          controller.abort(new Error("one_team_report_owner_changed"));
          if(rawEvent.kind!=="usage")return;
          // Keep numeric usage, never a stale report's text/tool/notice payload.
          rawEvent={kind:"usage",tokens:rawEvent.tokens,observedUsage:rawEvent.observedUsage ? {
            inputTokens:rawEvent.observedUsage.inputTokens,outputTokens:rawEvent.observedUsage.outputTokens,
            ...(rawEvent.observedUsage.cachedInputTokens!==undefined?{cachedInputTokens:rawEvent.observedUsage.cachedInputTokens}:{})} : undefined};
        }
        const hostControl = mainHostControlForEvent(rawEvent);
        effectBoundary.observe(rawEvent);
        rawEvent = redactMcpInvocationEventSecrets(redactOneAttachmentEvent(runReq, rawEvent));
        rawEvent = redactWorkAttachmentEvent(runReq, rawEvent);
        rawEvent = { ...rawEvent, goalResult: undefined };
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
        if (record.background) {
          if (!event.agentId && event.kind === "final" && typeof event.text === "string") {
            effectObservationParsed = readEffectObservationFromFinal(runId, event.text);
          }
          const terminal = this.recordBackgroundRunEvent(runId, record, event, hostControl);
          try { effectBoundary.recorded(event, hostControl); }
          catch { effectBoundary.recordingFailed(); }
          if (terminal) {
            terminalObserved = true;
            effectObservationFailed ||= event.kind === "error";
          }
          return;
        }
        if (
          event.runtimeSelection
          && !event.agentId
          && (!event.modelRole || event.modelRole === "orchestrator")
        ) {
          lastControllerSelection = event.runtimeSelection;
          // This token survives delayed automatic admission/ledger creation. A later selection or final cannot refresh it.
          if (desktopProducerAdmission && producerAdmission === undefined
            && event.kind === "notice" && event.notice?.code === "runtime-selected") {
            if (!goalControllerAttemptId && !goalControllerAttemptSettled) adoptRecordedExplicitGrant();
            try {
              producerAdmission = captureGoalProducerAdmission({ invocationId: runId, chatId: chat.id,
                goalId: projectionGoalId ?? getChat(chat.id)?.goalId ?? null }, assertProducerServiceLifetime);
            } catch (error) {
              producerAdmission = null;
              console.warn("[long-run] producer admission capture unavailable:", error);
            }
          }
          bindGoalControllerAttempt(event.runtimeSelection);
        }
        /*
         * A goal-chip Goal gets its ledger row from the client DURING its first turn (after runtime selection:
         * live 2026-09-25, row 12 s after invoke_started), so that turn had no controller attempt and no revision and its
         * first verification was always verification_goal_revision_unbound. Bind as soon as the row exists.
         */
        if (!goalLongRun && projectionGoalId && lastControllerSelection && !goalControllerAttemptId && !goalControllerAttemptSettled
          && !effectObservation && getLongRunByGoalId(projectionGoalId)) {
          refreshGoalProjection();
          bindGoalControllerAttempt(lastControllerSelection);
        }
        if (event.kind === "error" && !event.agentId && typeof event.error?.code === "string") observedRuntimeErrorCode = event.error.code;
        /*
         * 권한 승격 표식은 사용자에게 보여줄 문장이 아니다 — 감지 즉시 화면·기록
         * 본문에서 지우고, 그 사실만 남겨 완주 후 승인칩이 잇는다. 부분 스트림과
         * 최종 본문을 같은 함수로 지워 델타 좌표계가 갈라지지 않게 한다.
         */
        // 효과 관찰 판정은 원문 final 의 고정 표식 한 줄에서만 읽는다(지우기 전에). 부분 스트림의
        // 표식 줄도 화면에 보이지 않게 여기서 지운다.
        if (effectObservation && !event.agentId && (event.kind === "final" || event.kind === "partial")
          && typeof event.text === "string") {
          if (event.kind === "final") effectObservationParsed = readEffectObservationFromFinal(runId, event.text);
          event = { ...event, text: event.kind === "partial" && event.text.trim().startsWith("{")
            ? "" : stripEffectObservationMarker(event.text) };
        }
        if (
          permissionEscalationEligible
          && !event.agentId
          && (event.kind === "final" || event.kind === "partial")
          && typeof event.text === "string"
          && (hasPermissionEscalationMarker(event.text)
            // Measured 2026-09-24: the model wrote the marker as its last line, but the final event text
            // is built from the stripped durable copy — no chip was ever offered. The client carries the fact.
            || (event.kind === "final" && event.permissionEscalationMarkerForVerification === true))
        ) {
          if (event.kind === "final") permissionEscalationRequested = true;
          event = { ...event, text: stripPermissionEscalationMarker(event.text) };
        }
        // 형식을 안 지킨 맨 프로토콜 토큰(<<agentlas-goal-wait>> 등)은 사람에게 보여줄 문장이 아니다 — 최종 본문에서 지운다.
        if (!event.agentId && event.kind === "final" && typeof event.text === "string" && event.text.includes("<<")) {
          event = { ...event, text: stripStrayProtocolTokens(event.text) };
        }
        /*
         * A runtime that denied the tool itself has already given us the signal.
         *
         * The marker contract was written on the premise that a read-only run has no tool events at
         * all -- true where the write tools are removed outright. It is not true on every runtime:
         * Antigravity keeps the tools and refuses them one by one, emitting a typed
         * `approval-required` notice each time. On those runs the person watched the model try to
         * read a file, get denied, try to run a command, get denied, and then start guessing at
         * localhost ports, while the only way out was a magic phrase the model never said.
         *
         * The denial is a stronger signal than the marker, because it is the runtime's own event
         * rather than a model behaviour. Nothing is escalated here: this only earns the same chip,
         * which still asks the person and still closes as a refusal if unanswered.
         */
        if (
          permissionEscalationEligible
          && !event.agentId
          && event.kind === "notice"
          && event.notice?.code === "approval-required"
        ) {
          permissionEscalationRequested = true;
        }
        const attributedAgentId = event.runtimeAgentId ?? event.agentId;
        if (attributedAgentId) record.actualAgentId = attributedAgentId;
        if (!event.agentId && event.runtimeAgentId) {
          mainSpeakerAgentId = event.runtimeAgentId;
        }
        const participantPresentation = attributedAgentId
          ? oneParticipantPresentation.get(attributedAgentId)
          : undefined;
        if (requestedOneMode && participantPresentation) {
          event = {
            ...event,
            // The installed roster owns identity; provider prose may vary by language or turn.
            agentName: participantPresentation.name,
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
              ...(durableFinal.speakerAgentId
                ? { runtimeAgentId: durableFinal.speakerAgentId }
                : {}),
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
        } else if (invocationErrorAsksOwner(event)) {
          // A team turn whose workers did not all verify ends on an error that still carries the synthesis's question
          // to the owner (mcp/client.ts runBoundTaskForceInvocation re-emits the held final as kind "error"). The card is
          // in the transcript and answerable, so the turn waits for the owner exactly like a final question: its Goal is
          // held, not re-woken. Measured 2026-10-25 (HMG Work room, 1.3.89): every turn there ended
          // task-force-verification-failed, a question was never registered, and the Goal resumed 30-80 s after each
          // card, keeping the chat busy for 20+ minutes at a time; no answer receipt was ever recorded in that chat.
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
          canonicalTask = projectTaskStatus(runReq.chatId, "running", true, invocationOrigin);
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
            canonicalTask = projectTaskStatus(
              runReq.chatId,
              "waiting-decision",
              true,
              invocationOrigin,
            );
            if (!canonicalTask) throw new Error(`decision-task-projection-failed: ${lastTaskProjectionFailure?.reason ?? "reason-not-recorded"}`);
            taskMaterialized = true;
            recordRunEvent({
              runId,
              kind: "invoke_completed",
              chatId: runReq.chatId,
              agentId: attributedAgentId ?? record.actualAgentId,
              payload: { resultFolder: record.resultFolder, decisionRequested: true },
            });
          });
          // 봉인이 실패하면 **결정만** 포기한다. 예전에는 여기서 던져 턴 전체가 죽었는데,
          // 그 시점엔 모델의 작업이 이미 끝나 있었고 Decision 행도 durable 이었다. 즉 연구
          // 한 턴이 통째로 사라지는 대가로 얻는 것이 companion 장부 한 줄이었다.
          // trySetTaskStatus 자신이 "일시적 투영 실패가 실행을 막아서는 안 된다"고 적어 둔
          // 계약을 호출부가 정확히 뒤집고 있었다.
          //
          // 트랜잭션이 통째로 되돌아가므로 "Decision 과 Task 가 어긋난 채 노출되는 일은
          // 없다"는 원래 불변식은 그대로다. 달라지는 것은 실패의 값이다: 턴을 죽이는 대신
          // 결정 표면을 이번엔 올리지 않고, 왜 못 올렸는지를 원장에 남긴다.
          try {
            sealDecision.immediate();
            decisionTerminalCommitted = true;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`[decision-seal] chat ${runReq.chatId}: ${reason}`);
            tryRecordRunEvent({
              runId,
              chatId: runReq.chatId,
              kind: "invoke_completed",
              payload: { resultFolder: record.resultFolder, decisionRequested: false, decisionSealSkipped: reason.slice(0, 240) },
            });
          }
        }

        // Persist the source before publishing its ID. A stream-only surface
        // cannot participate in durable input CAS, reopen, or model handoff.
        if (event.kind === "surface" && event.surface) {
          const ownerChat = getChat(runReq.chatId);
          if (!ownerChat) throw new Error("artifact_owner_missing");
          /*
           * ★A surface that cannot be persisted is one result card, not the turn.
           *   Since 6bdbab38 (2026-09-12) persistence runs before publication, and a
           *   manifest it cannot serialize/validate threw straight out of the sink —
           *   the runtime then reported invoke-threw and the whole run failed, where
           *   the projection contract below says a bad surface degrades to a
           *   content-free status. Without a durable id it still must not publish,
           *   so it is dropped here and the fact (not the raw error, which can carry
           *   a Main-private path) goes to the ledger.
           */
          try {
            const persisted = recordAgentSurface({
              id: event.surfaceId ?? `surface:${runId}`,
              chatId: ownerChat.id, projectId: ownerChat.projectId,
              agentId: attributedAgentId ?? record.actualAgentId ?? ownerChat.agentId,
              manifest: event.surface,
            });
            event = { ...event, surfaceId: persisted.id };
          } catch (error) {
            console.error(`[surface] chat ${runReq.chatId}: surface not persisted — ${error instanceof Error ? error.message : String(error)}`);
            tryRecordRunEvent({
              runId,
              chatId: runReq.chatId,
              kind: "surface_persist_failed",
              payload: { reasonCode: "surface_persist_failed" },
            });
            event = {
              ...event,
              surface: undefined,
              oneSurface: undefined,
              status: pickLocale(runReq) === "ko"
                ? "결과를 정리하는 중 문제가 생겨 이번 응답을 완성하지 못했어요."
                : "Something went wrong while preparing this result, so it is not complete.",
            };
          }
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
        if (!event.agentId && (durableMessageId || (event.kind === "partial" && event.durableMessageId))) {
          durableAssistantReplyBound = true;
        }
        // Preserve only the opaque committed-message identity for history
        // catch-up. The body used to verify it remains Main-only.
        if (
          durableTextForVerification !== undefined
          || event.durableAssistantMessageIdForVerification !== undefined
          || event.permissionEscalationMarkerForVerification !== undefined
        ) {
          event = {
            ...event,
            ...(durableMessageId ? { durableMessageId } : {}),
            durableTextForVerification: undefined,
            durableAssistantMessageIdForVerification: undefined,
            permissionEscalationMarkerForVerification: undefined,
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
          // One's quiet reply on a host-started review or check-in is deliberately not saved (dots parity): its
          // durable record is the one_quiet_reply run event, not a transcript row. Treating it as a lost result
          // failed every quiet turn and retried the review until its attempts ran out (QA 2026-10-04).
          && !((hostNoticePurpose === "one-delegation-review" || hostNoticePurpose === "one-checkin") && isOneQuietReply(event.text))
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
        const resultGoalId = projectionGoalId ?? record.automaticGoalId;
        if (resultGoalId && !event.agentId && (event.kind === "partial" || event.kind === "final")) {
          event = { ...event, goalResult: { goalId: resultGoalId, runId, status: "pending" } };
          if (event.kind === "final" && typeof event.text === "string") {
            const messageId = bindGoalResultMessage({ chatId: runReq.chatId, goalId: resultGoalId, runId,
              text: typeof durableTextForVerification === "string" && durableTextForVerification.trim()
                ? durableTextForVerification : stripPermissionEscalationMarker(event.text), notBefore: startedAt });
            if (messageId) event = { ...event, durableMessageId: messageId };
          }
        }
        const terminalDisposition = event.kind === "final" || event.kind === "error"
          ? classifyMainOwnedTerminal({
              eventKind: event.kind,
              steeringInterruptRequested: record.steeringInterruptRequested,
              signalAborted: controller.signal.aborted,
              abortReason: controller.signal.reason,
            })
          : null;
        if (event.kind === "error" && event.error && terminalDisposition?.errorCode) {
          event = { ...event, error: { ...event.error, code: terminalDisposition.errorCode } };
        }
        recordObservableRunStep(canonicalTask, runId, event, observableStepSequence, record.semanticSteps);

        const wireEvent = liveWirePartial(record, event);
        if (!wireEvent) return;

        const last = record.events[record.events.length - 1];
        // partial(누적 전문)과 usage(단조 카운터)는 마지막 값만 의미 있다 — 연속이 아니어도
        // 같은 kind의 직전 버퍼 항목을 교체해 버퍼가 고빈도 신호로 밀려나지 않게 한다.
        if (event.kind === "partial" && !event.agentId && last?.kind === "partial" && !last.agentId) {
          record.events[record.events.length - 1] = event;
        } else if (replaceTeammatePartial(record.events, event)) {
          // One partial per teammate (its text is cumulative); see replaceTeammatePartial.
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
        try {
          recordMcpInvocationEvent(runId, runReq, event, { requireDurable: true, hostControl });
          effectBoundary.recorded(event, hostControl);
        } catch (error) {
          effectBoundary.recordingFailed();
          console.warn("[invocation] effect ledger write failed:", error);
          if (mainToolStartRequiresDurability()) {
            throw Object.assign(new Error("main_tool_start_not_durable"), { code: "main_tool_start_not_durable", cause: error });
          }
        }
        this.publishRunEvent(record, { runId, chatId: runReq.chatId, event: wireEvent });

        if (event.kind === "final" || event.kind === "error") {
          // A streamed answer is user-visible work even if the runtime later
          // fails (hook error, transport loss, crash, or explicit cancel). The
          // renderer already keeps that bubble; persist the same partial so a
          // history refresh cannot make it disappear. Browser Agent Apps and
          // bounded remote workspaces retain their stricter isolation rules.
          if (event.kind === "error") persistRecoverableAssistantPartial();
          const terminalKind = terminalDisposition!.terminalKind;
          if (event.kind === "error" && !event.agentId) persistEmptyFailureNotice(terminalKind, event.error?.code, event.error);
          settleGoalControllerAttempt(terminalKind === "invoke_completed");
          canonicalTask = projectTaskStatus(
            runReq.chatId,
            terminalTaskStatus({
              kind: event.kind,
              requestsDecision: terminalRequestsDecision,
              cancelled: terminalKind === "invoke_cancelled",
              interrupted: terminalKind === "invoke_interrupted",
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
                // The runner's own error line does not know who stopped it; Main does (app quit, update, Goal stop).
                ...(controller.signal.aborted && controller.signal.reason instanceof Error
                  && invocationHostStopCause(controller.signal.reason.message)
                  ? { hostStopCause: invocationHostStopCause(controller.signal.reason.message) } : {}),
                runtimeFailureKind: event.error?.runtimeFailure?.kind,
                runtimeFailureSource: event.error?.runtimeFailure?.source,
                runtimeFailureProviderCode: event.error?.runtimeFailure?.providerCode,
                runtimeFailureRetryAfterAt: event.error?.runtimeFailure?.retryAfterAt,
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
            && !runReq.planMode
            /*
             * 완주한 턴만 물었다. 그런데 승인이 없어 막힌 도구는 그 턴을 **실패로 끝내기도**
             * 한다 — 그때가 사람이 가장 도움이 필요한 순간인데 아무것도 안 물었다.
             * 사용자가 직접 멈춘 것만 제외한다(그건 이미 답이다).
             */
            && (terminalKind === "invoke_completed" || terminalKind === "invoke_failed")
            && !controller.signal.aborted
          ) {
            /*
             * 완주한 읽기 전용 턴이 쓰기 승격을 표식으로 요청했다 — 그 대화 안에서
             * 기존 승인칩 한 벌로 묻는다. 승인 없이는 아무것도 승격되지 않는다.
             */
            void this.offerPermissionEscalation({
              record,
              chatId: runReq.chatId,
              goalId: projectionGoalId ?? null,
              signal: controller.signal,
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
        // The user row is persisted inside runMcpInvocation immediately before
        // this hook. Keep the exact row id in the append-only run ledger so a
        // failed run without an assistant row can be placed after its own
        // prompt during replay; renderers must never infer this from text or
        // timestamps.
        tryRecordRunEvent({
          runId,
          chatId: chat.id,
          kind: "invoke_prompt_bound",
          payload: { promptMessageId: sourceMessageId, ...promptBoundUserCursor(chat.id, runId, sourceMessageId) },
        });
        if (nativePreparation?.ordinaryTurn) {
          const turn = nativePreparation.ordinaryTurn;
          if (turn.messageId && turn.messageId !== sourceMessageId) throw new Error("ordinary_one_prompt_identity_changed");
          turn.messageId = sourceMessageId;
          turn.observation?.onPromptBound();
        }
        const publishAutomaticGoalDegradedNotice = (reason: string, failureKind?: string) => {
          const ko = "목표 자동 추적을 이번 실행에 적용하지 못했습니다. 작업은 일반 실행으로 계속합니다. 반복되면 설정의 모델 역할에서 오케스트레이터 연결과 사용 한도를 확인해 주세요.";
          const en = "Automatic Goal tracking was unavailable for this run. The task is continuing as a normal run. If this repeats, check the orchestrator connections and usage limits under Model roles in Settings.";
          const noticeEvent: McpInvocationEvent = {
            kind: "notice",
            notice: {
              level: "warning",
              code: "automatic-goal-intake-degraded",
              message: pickLocale(runReq) === "ko" ? ko : en,
              i18n: { ko, en },
              details: JSON.stringify({ reason, ...(failureKind ? { failureKind } : {}), continued: true }),
            },
          };
          record.events.push(noticeEvent);
          recordMcpInvocationEvent(runId, runReq, noticeEvent);
          this.publishRunEvent(record, { runId, chatId: chat.id, event: noticeEvent });
        };
        if (stoppedGoalReactivation) {
          if (runReq.taskIntent === "conversation" && !stoppedGoalReactivation.ownerAnswer) {
            ordinaryTurnOnStoppedGoal = true;
            stoppedGoalReactivation = null;
            record.automaticGoalId = undefined;
            record.longRunProjection = undefined;
            projectionGoalId = null;
          }
        }
        let legacyLifecycle: LegacyGoalLifecyclePreparation | null = null;
        const legacyRuntime = runReq.runtimeSelection ? { ...runReq.runtimeSelection } : undefined;
        const legacyGoalId = projectionGoalId ?? boundGoal?.goalId;
        if (localUserTurn && !runReq.planMode && !runReq.agentAppMode && !runWorkspaceBinding && !executionContext
          && chat.kind === "user" && ["one", "work"].includes(chat.originSurface ?? "")
          && legacyGoalId && getLegacyGoalLifecycleSnapshot(legacyGoalId)) {
          let reasonCode = "legacy-lifecycle-stopped-native-resume-required";
          // A between-turn owner task resumes the existing lifecycle. Only a
          // paused or blocked legacy Goal may enter lifecycle migration here.
          if (stoppedGoalReactivation && stoppedGoalReactivation.status !== "waiting_tool" && stoppedGoalReactivation.status !== "queued"
            && lifetime.ownsActiveRoot()) {
            legacyLifecycle = await prepareLegacyGoalLifecycle({
              goalId: legacyGoalId, longRunId: stoppedGoalReactivation.runId,
              expectedVersion: stoppedGoalReactivation.version, expectedStatus: stoppedGoalReactivation.status,
              source: { chatId: chat.id, messageId: sourceMessageId, role: "user", text: ownerVisiblePrompt(runReq) },
              runtimeSelection: legacyRuntime, signal: controller.signal,
            });
            reasonCode = legacyLifecycle?.reasonCode ?? "legacy-lifecycle-no-longer-legacy";
          }
          recordRunEvent({ runId, chatId: chat.id, kind: "legacy_goal_lifecycle_classified", payload: {
            goalId: legacyGoalId, sourceMessageId, reasonCode,
            verdict: legacyLifecycle?.verdict ?? "unavailable",
            ...(legacyLifecycle ? { expectedRevision: legacyLifecycle.snapshot.revision.revision,
              snapshotDigest: legacyLifecycle.snapshotDigest, runtimeReceipt: legacyLifecycle.runtimeReceipt } : {}),
          } });
          if (!legacyLifecycle || legacyLifecycle.verdict !== "ongoing") {
            const noticeEvent: McpInvocationEvent = { kind: "notice", notice: { level: "warning",
              code: "legacy-goal-lifecycle-unchanged",
              message: pickLocale(runReq) === "ko"
                ? "기존 목표의 반복 수행 설정은 변경하지 않았습니다. 이번 메시지는 기존 목표 설정으로 처리합니다."
                : "The existing Goal's lifetime was not changed. This message retains the existing Goal settings.",
              details: JSON.stringify({ reasonCode, lifecycleChanged: false }),
            } };
            record.events.push(noticeEvent);
            recordMcpInvocationEvent(runId, runReq, noticeEvent);
            this.publishRunEvent(record, { runId, chatId: chat.id, event: noticeEvent });
          }
        }
        // An owner message that changes an ongoing Goal's targets becomes a Goal
        // revision (applied at the next stop). Asynchronous: never delays or
        // refuses this turn. Every review — answered, unanswered or skipped —
        // leaves a machine reasonCode in the run ledger; silence was how the
        // owner's target restatements disappeared (2026-09-24).
        const amendmentGoalId = projectionGoalId ?? boundGoal?.goalId ?? null;
        if (amendmentGoalId && chat.kind === "user" && ["one", "work"].includes(chat.originSurface ?? "")
          && runReq.promptOrigin !== "system") {
          reviewOwnerDirectionForGoal({ runId, chatId: chat.id, goalId: amendmentGoalId, sourceMessageId,
            notReviewed: !localUserTurn ? "not_local_user_turn" : ownerDirectionReviewSkip(runReq, runWorkspaceBinding, executionContext) });
        }
        if (stoppedGoalReactivation) {
          let resumed: ReturnType<typeof getLongRun> = null;
          // Preserve a machine-coded refusal when another action changes the
          // exact Goal while this turn is preparing. No provider dispatch may
          // follow a failed resume transaction.
          // `detail` names the check that failed (or the thrown error): the refusal used to keep only the coarse reason,
          // and the owner's message after a restart failed "목표 상태가 방금 바뀌어" with no recorded cause (W7 2026-10-17).
          const stall: { reason: "state-changed" | "revision" | "attempt-live" | "budget" | "contract" | "not-ready" | "claimed-wait" | "effect-boundary-uncertain"; detail?: string } = { reason: "state-changed" };
          const refuse = (detail: string) => { stall.detail = detail; return null; };
          try {
            resumed = getDb().transaction(() => {
              const current = getLongRun(stoppedGoalReactivation!.runId);
              const source = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?")
                .get(sourceMessageId) as { chat_id: string; role: string; text: string } | undefined;
              if (controller.signal.aborted) return refuse("aborted");
              if (!current) return refuse("goal_run_missing");
              // CAS on the LATEST version: any host event (sweep re-stamp, accounting, a wait note) moves the version, and
              // refusing on that refused the owner's message with "the Goal just changed state" (no-dead-end sweep
              // 2026-10-25). The message still resumes only a Goal that is stopped now; one another turn took (running) or
              // that ended runs this message as an ordinary turn below.
              if (!["paused", "blocked", "waiting_tool", "queued"].includes(current.status)) return refuse(`status:${stoppedGoalReactivation!.status}>${current.status}`);
              if (getChat(chat.id)?.goalId !== current.goalId || current.rootChatId !== chat.id) return refuse("chat_goal_binding_changed");
              if (source?.chat_id !== chat.id || source.role !== "user") return refuse("source_message_missing");
              if (source.text !== ownerVisiblePrompt(runReq)) return refuse("source_text_differs");
              const revision = getChatGoalRevision(current.goalId);
              const revisionBinding = getLongRunGoalRevisionBinding(current.id);
              stall.reason = "revision";
              // Explicit legacy Goals have a contract and tasks but no
              // automatic-intake revision. Missing automatic Goal metadata or
              // a partial revision binding must still fail closed.
              if (revision
                ? revision.chatId !== chat.id || revisionBinding?.revision !== revision.revision
                : revisionBinding !== null || current.goalId.startsWith("goal:auto-message:")) return refuse("revision_binding_mismatch");
              if (legacyLifecycle && (getLegacyGoalLifecycleSnapshot(current.goalId)?.payloadJson !== legacyLifecycle.snapshot.payloadJson
                || JSON.stringify(runReq.runtimeSelection) !== JSON.stringify(legacyRuntime))) return refuse("legacy_lifecycle_changed");
              if (legacyLifecycle?.verdict === "ongoing" && !lifetime.ownsActiveRoot()) return refuse("legacy_root_not_owned");
              // Never replay an old attempt; the new message owns a new turn.
              // Live controller concurrency is owned by the chat registry.
              // Old uncertain effects and Goal budgets do not gate this turn.
              appendLongRunEvent({ runId: current.id, kind: "run.user_control", actorKind: "user",
                payload: { action: "resume_with_message", sourceMessageId, invocationRunId: runId,
                  previousStatus: current.status } });
              stall.reason = "contract";
              // An explicit Goal defined without a contract row (chats:defineGoal) is not a Goal that "just changed
              // state": refusing it repeated forever, for every owner message (production 2026-10-24, X Marketing room).
              // Write its contract from its own ledger row first; an automatic Goal always has one from its admission.
              if (!current.goalId.startsWith("goal:auto-message:")) ensureExplicitGoalContract(getDb(), current.goalId);
              const contractChanged = getDb().prepare(`UPDATE chat_goal_contracts
                SET status = 'active', completed_at = NULL, updated_at = ?
                WHERE goal_id = ? AND chat_id = ? AND status IN ('active', 'blocked')`)
                .run(new Date().toISOString(), current.goalId, chat.id);
              if (contractChanged.changes !== 1) throw new Error("auto_goal_resume_contract_not_blocked");
              if (legacyLifecycle?.verdict === "ongoing") {
                const migrated = migrateLegacyGoalLifecycle({ goalId: current.goalId,
                  expectedPayloadJson: legacyLifecycle.snapshot.payloadJson, source: legacyLifecycle.source });
                // Only our own writes advance this CAS. Generic revision binding
                // stays strict; it never clears an uncertain attempt for us.
                bindCurrentGoalRevisionToLongRun(current.id, getLongRun(current.id)!.version);
                appendLongRunEvent({ runId: current.id, kind: "run.legacy_lifecycle_migrated", actorKind: "host",
                  payload: { schemaVersion: "agentlas.legacy-goal-lifecycle.v1", sourceMessageId, invocationRunId: runId,
                    previousRevision: revision!.revision, revision: migrated.revision, lifecycle: migrated.lifecycle,
                    previousPayloadDigest: legacyLifecycle.snapshotDigest, runtimeSelection: legacyRuntime,
                    runtimeReceipt: legacyLifecycle.runtimeReceipt, verdict: "ongoing" } });
              }
              const resumeVersion = getLongRun(current.id)!.version;
              stall.reason = "not-ready";
              // A Goal already queued (the sweep's retry, no turn started) goes straight to running for this message.
              const queued = current.status === "queued" ? getLongRun(current.id)!
                : resumeLongRunByUser(current.id, desktopAppInstanceId(), resumeVersion);
              if (!longRunContinueDecision(queued.goalId)?.continue) throw new Error("auto_goal_resume_not_ready");
              const running = transitionLongRun({
                runId: queued.id,
                to: "running",
                actorKind: "host",
                reason: "stopped-goal-user-message-dispatch",
                appInstanceId: desktopAppInstanceId(),
                expectedVersion: queued.version,
              });
              // A paused timer wait belongs to the old turn. Supersede it only
              // after durable resume; doing it at admission advances the CAS
              // version and makes the new message reject its own transition.
              const superseded = supersedeGoalWaitForInvocation(current.goalId, runId);
              if (superseded) startBoundary.cleanups?.push(() => { restoreGoalWaitAfterUndispatchedStart(superseded); });
              return getLongRun(running.id);
            }).immediate();
            // The exact human source and Goal revision are durable now. Release
            // Main's unreadable-stop marker only through its typed Resume path.
            if (resumed) {
              const resumedRevision = getChatGoalRevision(resumed.goalId);
              if (resumedRevision) acknowledgeGoalExecutionResume({ goalId: resumed.goalId,
                rootChatId: chat.id, expectedRevision: resumedRevision.revision });
            }
          } catch (error) {
            if (error instanceof Error && error.message === "goal_wait_claimed_reconciliation_required") stall.reason = "claimed-wait";
            if (error instanceof Error && error.message === GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN) stall.reason = "effect-boundary-uncertain";
            stall.detail = `thrown:${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
            resumed = null;
          }
          if (!resumed) {
            const now = getLongRun(stoppedGoalReactivation.runId);
            tryRecordRunEvent({ runId, chatId: chat.id, kind: "goal_reactivation_refused", payload: {
              goalRunId: stoppedGoalReactivation.runId, reason: stall.reason, detail: stall.detail ?? null,
              captured: { status: stoppedGoalReactivation.status, version: stoppedGoalReactivation.version },
              current: now ? { status: now.status, version: now.version } : null } });
            stoppedGoalReactivation = null;
            record.automaticGoalId = undefined;
            record.longRunProjection = undefined;
            projectionGoalId = null;
            // The owner's message is never refused because the Goal could not be resumed (it was, forever, for a Goal
            // missing a contract row: X Marketing room 2026-10-24; and for a version race: W7 2026-10-17). It runs now as an
            // ordinary turn of this chat; the Goal keeps its state and the chip still resumes it. The machine cause stays in
            // goal_reactivation_refused and in the notice code; no automatic replay of the Goal's old attempt happens.
            const ko = "목표는 지금 상태 그대로 두고, 이 메시지는 일반 대화로 바로 처리합니다. 목표를 이어가려면 목표 칩에서 재개하세요.";
            const en = "The Goal stays as it is; this message runs now as an ordinary turn. Resume the Goal from the goal chip to continue it.";
            const deferredNotice: McpInvocationEvent = { kind: "notice", notice: { level: "info",
              code: "goal-resume-deferred-message-ran",
              message: pickLocale(runReq) === "ko" ? ko : en, i18n: { ko, en },
              details: JSON.stringify({ reason: stall.reason, resumeCode: stall.reason === "claimed-wait" ? "goal_wait_claimed_reconciliation_required"
                : stall.reason === "effect-boundary-uncertain" ? GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN : "automatic-goal-resume-state-changed" }) } };
            record.events.push(deferredNotice);
            recordMcpInvocationEvent(runId, runReq, deferredNotice);
            this.publishRunEvent(record, { runId, chatId: chat.id, event: deferredNotice });
            ordinaryTurnOnStoppedGoal = true;
            return;
          }
          boundGoal = resumed;
          stoppedGoalReactivation = null;
          refreshGoalProjection();
          if (lastControllerSelection) bindGoalControllerAttempt(lastControllerSelection);
        }
        // Only ordinary local, user-authored root-chat work enters automatic
        // Goal. Science and remote/automation authority keep their own adapters.
        if (projectionGoalId || runReq.agentAppMode || runWorkspaceBinding || executionContext ||
            runReq.promptOrigin === "system" || runReq.planMode || chat.kind === "division" || controller.signal.aborted) return;
        // Goal custody is Desktop-only: this process cannot admit a Goal controller (producerAdmission stays
        // null), so a Goal admitted mid-turn would have its first dispatch refused with goal_episode_admission_missing.
        // The turn stays ordinary and finishes here, but its intake must not be dropped: production 2026-10-11 10:08Z (run
        // 97164057-c169-4868-89c0-53ebd22e9c8f, room chat 8f3e09ee-0ab7-4d6b-aa0a-8ae7d5e96549, 1.2.96) lost a recurring
        // "every day ... upload" brief here, so no One chat could ever become a continuous Goal. Classify off the critical path
        // with Desktop's own resolver; a Goal-bound message goes to Main (which owns Goal custody), or leaves a durable marker
        // when Main is away. Once the chat holds a live Goal, ownerTurnStartsOnDesktop routes its next turn to Desktop.
        if (record.ownerLease?.ownerKind === "daemon") {
          void classifyAndHandGoalIntakeToMain({ runId, chatId: chat.id, sourceMessageId, userPrompt: ownerVisiblePrompt(runReq),
            permission: runReq.permissions ?? "read", signal: controller.signal,
            attachmentOnly: attachmentDescriptors.length > 0 && !promptWithoutValidChatFileMarkers }).catch(() => undefined);
          return;
        }
        try {
          const prepared = await prepareInvocationAutomaticGoal({ runId, chatId: chat.id, sourceMessageId,
            userPrompt: ownerVisiblePrompt(runReq), permission: runReq.permissions ?? "read", signal: controller.signal,
            attachmentOnly: attachmentDescriptors.length > 0 && !promptWithoutValidChatFileMarkers });
          if (controller.signal.aborted) {
            if (prepared.kind === "admitted") {
              // Admission may finish after an abort. Only the owner's explicit
              // stop closes this Goal; an internal abort retains its binding.
              projectionGoalId = prepared.run.goalId;
              record.automaticGoalId = prepared.run.goalId;
              try {
                const stopReason = controller.signal.reason instanceof Error ? controller.signal.reason.message : "internal_abort";
                let goal = getLongRunByGoalId(prepared.run.goalId);
                if (goal && !LONG_RUN_TERMINAL_STATUSES.has(goal.status)) {
                  if (stopReason === "goal_deleted_by_user") {
                    if (goal.status !== "cancelling") goal = transitionLongRun({ runId: goal.id, to: "cancelling", actorKind: "user", reason: "user" });
                    transitionLongRun({ runId: goal.id, to: "cancelled", actorKind: "host", reason: "user" });
                    completeChatGoalContract(goal.goalId, "cancelled");
                    if (getChat(chat.id)?.goalId === goal.goalId) setChatGoalBinding(chat.id, null);
                  } else if (stopReason === STOPPED_BY_USER || isOwnerGoalStopCause(stopReason)) {
                    appendLongRunEvent({ runId: goal.id, kind: "run.user_control", actorKind: "user",
                      payload: { action: "pause", source: "turn-stop", chatId: chat.id, goalId: goal.goalId, invocationRunId: runId } });
                    if (["draft", "queued", "blocked"].includes(goal.status)) transitionLongRun({ runId: goal.id, to: "paused", actorKind: "user", reason: "user" });
                    else if (!["paused", "pausing", "cancelling"].includes(goal.status)) {
                      goal = transitionLongRun({ runId: goal.id, to: "pausing", actorKind: "user", reason: "user" });
                      transitionLongRun({ runId: goal.id, to: "paused", actorKind: "host", reason: "user" });
                    }
                  } else {
                    appendLongRunEvent({ runId: goal.id, kind: "run.internal_abort_deferred", actorKind: "host",
                      payload: { invocationRunId: runId, reason: stopReason } });
                    this.scheduleGoalContinuation(goal.goalId, record, "automatic-goal-admission-interrupted");
                  }
                }
              } catch (cleanupError) {
                tryRecordRunEvent({ runId, chatId: chat.id, kind: "automatic_goal_abort_recovery_pending",
                  payload: { goalId: prepared.run.goalId } });
                console.warn("[long-run] automatic Goal abort recovery pending:", cleanupError);
              }
            }
            return;
          }
          if (prepared.kind === "unavailable") {
            // Automatic Goal intake is auxiliary orchestration. Its failure is
            // already durable in automatic_goal_intake_unavailable, but it must
            // never prevent the selected execution runtime from handling the
            // person's request. Continue this turn as an ordinary invocation;
            // a later turn may retry Goal admission when judgment is healthy.
            publishAutomaticGoalDegradedNotice(prepared.reason, prepared.failureKind);
            return;
          }
          if (prepared.kind === "bypass") return;
          const admitted = prepared.run;
          projectionGoalId = admitted.goalId;
          record.automaticGoalId = admitted.goalId;
          if (admitted.rootChatId === chat.id) record.goalStopOwner = captureNativeGoalStopOwner({ goalId: admitted.goalId,
            rootChatId: chat.id, longRunId: admitted.id });
          transitionLongRun({ runId: admitted.id, to: "running", actorKind: "host", reason: "automatic-goal-user-dispatch" });
          refreshGoalProjection();
          if (lastControllerSelection) bindGoalControllerAttempt(lastControllerSelection);
          const goalEvent: McpInvocationEvent = { kind: "tool-use", tool: { name: "Goal", result:
            `${admitted.objective}\n\n${admitted.acceptanceCriteria.map((criterion) => `• ${criterion}`).join("\n")}\n\n` +
            (pickLocale(runReq) === "ko"
              ? `${admitted.budget.maxCycles == null ? "실행 횟수 제한 없음" : `최대 ${admitted.budget.maxCycles}회 실행`} · ${admitted.budget.wallclockDeadline == null ? "시간 제한 없음" : `기한 ${admitted.budget.wallclockDeadline}`}. 미완료 목표는 유지합니다. 금액 사용량은 아직 계측되지 않습니다.`
              : `${admitted.budget.maxCycles == null ? "No pass limit" : `Up to ${admitted.budget.maxCycles} passes`} · ${admitted.budget.wallclockDeadline == null ? "No time limit" : `Deadline ${admitted.budget.wallclockDeadline}`}. Unfinished criteria are retained. Monetary usage is not yet metered.`) } };
          record.events.push(goalEvent);
          recordMcpInvocationEvent(runId, runReq, goalEvent);
          this.publishRunEvent(record, { runId, chatId: chat.id, event: goalEvent });
          /*
           * ★마감이 없으면(무제한) 타이머를 걸지 않는다.
           *
           * Date.parse(null) 은 NaN 이고 setTimeout(fn, NaN) 은 **즉시** 실행된다. 그래서
           * 이 줄은 무제한 목표를 시작하자마자 취소해 버린다 — 상한을 푸는 변경에서 가장
           * 조용히 반대로 도는 자리다(오너 지시 2026-09-08 주기·시간 무제한).
           */
        } catch {
          tryRecordRunEvent({ runId, chatId: chat.id, kind: "automatic_goal_binding_failed", payload: { sourceMessageId } });
          const failedGoalId = record.automaticGoalId;
          if (failedGoalId) {
            try {
              const failedGoal = getLongRunByGoalId(failedGoalId);
              if (failedGoal && ["queued", "running", "waiting_worker", "waiting_tool", "waiting_user"].includes(failedGoal.status)) {
                transitionLongRun({
                  runId: failedGoal.id,
                  to: failedGoal.status === "queued" ? "failed" : "blocked",
                  actorKind: "host",
                  reason: "automatic_goal_binding_failed",
                });
              }
            } catch (cleanupError) {
              tryRecordRunEvent({
                runId,
                chatId: chat.id,
                kind: "automatic_goal_binding_cleanup_failed",
                payload: { goalId: failedGoalId },
              });
              console.warn("[long-run] automatic Goal binding cleanup failed:", cleanupError);
            } finally {
              // The invocation did not start. Never synthesize a completion
              // claim or verifier retry from runMcpInvocation's empty result.
              record.automaticGoalId = undefined;
              record.longRunProjection = undefined;
              projectionGoalId = null;
            }
          }
          publishAutomaticGoalDegradedNotice("automatic_goal_binding_failed");
        }
      },
      hostNoticePurpose,
      // User-owned One/Work turns (including automatic Goal continuation) are
      // foreground work even when their system coordinator is inventory-hidden.
      // Background divisions and external job contexts keep quiet native grants.
      !record.background && chat.kind === "user" && !executionContext && !runReq.agentAppMode ? "foreground" : "background",
      (goalId) => {
        if (!desktopProducerAdmission) return;
        if (producerWorkDispatchSealed) throw Object.assign(
          new Error("goal_episode_admission_lifetime_stale"), { code: "goal_episode_admission_lifetime_stale" });
        try {
          // A Goal Main admitted for THIS service run follows the turn (long-run/daemon-turn-goal.ts): the turn stays an ordinary
          // one that holds no producer custody, so nothing here may bind or refuse it. A slow model reaches its first dispatch
          // after Main's admission has landed (a local 4B: 12 s) and was refused goal_episode_admission_missing before any work.
          if (goalId && record.ownerLease?.ownerKind === "daemon" && goalAdmittedForServiceRun(runId, goalId)) return;
          // The client names the chat's bound Goal whatever its state. A Goal that is not running (paused, blocked,
          // waiting) is not this turn's episode: the owner's conversational message, or a message whose resume could not
          // apply, runs as an ordinary turn. Binding it here re-attached the stopped Goal and refused the dispatch with
          // goal_episode_admission_missing ("App problem") for every such message (no-dead-end sweep 2026-10-25).
          if (goalId && !goalControllerAttemptId) {
            const named = getLongRunByGoalId(goalId);
            if (ordinaryTurnOnStoppedGoal || !named || named.status !== "running") {
              if (projectionGoalId === goalId) { projectionGoalId = null; record.automaticGoalId = undefined; record.longRunProjection = undefined; }
              tryRecordRunEvent({ runId, chatId: chat.id, kind: "goal_dispatch_ordinary_turn", payload: {
                goalId, goalStatus: named?.status ?? null, cause: ordinaryTurnOnStoppedGoal ? "owner_turn_not_goal_episode" : "goal_not_running" } });
              return;
            }
          }
          // Last synchronous pre-work opportunity: the client may have materialized the first Goal after selection.
          if (goalId && (!projectionGoalId || projectionGoalId === goalId)) {
            projectionGoalId = goalId;
            refreshGoalProjection();
            if (lastControllerSelection) bindGoalControllerAttempt(lastControllerSelection);
          }
          // Optional intake may leave an ordinary turn without a Goal. Once
          // this dispatch names a durable Goal, however, an unbound controller
          // cannot execute and then fabricate episode custody at completion.
          if (goalId) {
            if (!producerAdmission || !goalControllerAttemptId) throw Object.assign(
              new Error("goal_episode_admission_missing"), { code: "goal_episode_admission_missing" });
            assertGoalProducerDispatch({ admission: producerAdmission, goalId,
              attemptId: goalControllerAttemptId }, assertProducerServiceLifetime);
          }
        } finally { producerWorkDispatchSealed = true; }
      },
      canonicalWorkRecovery,
      (nativeController, nativeState) => {
        // Withdrawal clears this captured run even after Stop/custody revocation.
        if (!nativeController) record.nativeTurnController = undefined;
        if (this.activeRuns.get(runId) !== record || record.background) return;
        const state = nativeState === undefined ? undefined : validatedRunnerNativeControlState(nativeState);
        if (nativeState !== undefined && !state) { record.nativeTurnController = undefined; return; }
        if (state) {
          const observed = state.phase === "active" && (!nativeController || controller.signal.aborted || nativeController.binding.chatId !== record.chatId || state.runtime !== nativeController.binding.runtime || state.driver !== "app-server")
            ? { ...state, phase: "unavailable" as const, code: "native_control_unavailable" as const }
            : state;
          record.nativeControlState = Object.freeze({ ...observed });
          // Without a native handle an owner direction waits for the episode end (runWithOwnerControl) or, when the run
          // never reads its inbox, for the next turn (carryUndeliveredOwnerFollowups). It is never refused for that.
          if (observed.phase === "unavailable") this.publishQueuedNativeBoundaryNotice(runId, record);
          tryRecordRunEvent({ runId, chatId: record.chatId, kind: "invoke_native_control_state",
            payload: { ...observed, inputDigest: getInvocationAdmission(runId)?.inputDigest ?? null } });
        }
        if (!nativeController) {
          if (!nativeState && record.nativeControlState) record.nativeControlState = Object.freeze({ ...record.nativeControlState, phase: "withdrawn", code: "native_control_withdrawn" });
          return;
        }
        if (state && (state.phase !== "active" || state.runtime !== nativeController.binding.runtime || state.driver !== "app-server")) { record.nativeTurnController = undefined; return; }
        if (!record.background && !controller.signal.aborted && this.activeRuns.get(runId) === record
          && nativeController.binding.chatId === record.chatId) {
          record.nativeTurnController = nativeController;
          this.deliverNativeOwnerControls(runId, record);
        }
      },
      this.ownerControlInbox(runId, record),
    ));
        };
        // The owner's own message takes the owner slot lane (NH20); anything this turn starts for others does not inherit it.
        const runPriority = invocationRunPriority({ promptOrigin: runReq.promptOrigin, oneTeamReportTurn: runReq.oneTeamReportTurn, source: executionContext?.source });
        const prioritizedDispatch = () => withRunPriority(runPriority, dispatch);
        return handedOver ? handedOver.then(prioritizedDispatch) : prioritizedDispatch(); })
      .then((result) => {
        // The runner promise has settled. Persist host effect completeness
        // before a fast verifier can produce or claim a retry checkpoint.
        try { effectBoundary.persist(); }
        catch (error) { console.warn("[invocation] effect boundary receipt failed:", error); }
        if(record.oneTeamReportCustody && !queuedTeamReportCurrent(record.oneTeamReportCustody,record.oneTeamReportOriginalRequest!)) {
          controller.abort(new Error("one_team_report_owner_changed"));throw new Error("one_team_report_owner_changed");
        }
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
            // A role-free invocation summary must not be added again to the
            // per-provider orchestrator/worker usage rows.
            observedUsageScope: "invocation",
            observedUsageStatus: result.observedUsage ? "measured" : "unknown",
            observedInputTokens: result.observedUsage?.inputTokens,
            observedOutputTokens: result.observedUsage?.outputTokens,
            observedCachedInputTokens: result.observedUsage?.cachedInputTokens,
          },
        });
        if (record.background) {
          // An observer cannot acquire the owner's login wait or Task UI.
          if (result.browserLoginWait) {
            result.browserLoginWait.cancel();
            effectObservationFailed = true;
          }
          if (effectObservationParsed?.status !== "reported" && typeof result.finalText === "string") {
            const parsed = readEffectObservationFromFinal(runId, result.finalText);
            if (parsed && (parsed.status !== "absent" || !effectObservationParsed)) effectObservationParsed = parsed;
          }
          return;
        }
        if (result.browserLoginWait && (controller.signal.aborted || record.steeringInterruptRequested)) {
          result.browserLoginWait.cancel();
          return;
        }
        if (result.browserLoginWait && !controller.signal.aborted && !record.steeringInterruptRequested) {
          const handle = result.browserLoginWait;
          if (handle.prerequisite.runId !== runId || handle.prerequisite.chatId !== chat.id) {
            handle.cancel();
            throw new Error("browser_login_wait_scope_mismatch");
          }
          let effectsSettled = false;
          const sourceCanResume = canResumeInvocationBrowserLoginWait(executionContext);
          const automaticResume = sourceCanResume && handle.runtimeQuiesced;
          const waitingGoalId = !executionContext
            ? record.automaticGoalId ?? (goalLongRun?.rootChatId === chat.id ? goalLongRun.goalId : null) : null;
          const durable: InvocationBrowserLoginWait = { prerequisite: handle.prerequisite, sourceInvocationId: runId,
            chatId: chat.id, goalId: waitingGoalId, goalRevision: waitingGoalId ? getChatGoalRevision(waitingGoalId)?.revision ?? null : null,
            ownerEpoch: desktopAppInstanceId(), runtimeQuiesced: handle.runtimeQuiesced, effectsSettled,
            state: "waiting", successorInvocationId: null,
            reason: !sourceCanResume ? "browser_login_resume_requires_source_controller"
              : !handle.runtimeQuiesced ? "browser_login_runtime_not_quiesced" : null };
          getDb().transaction(() => {
            recordRunEvent({ runId, chatId: chat.id, kind: "invoke_waiting", sourceEventId: `login-wait:${handle.prerequisite.prerequisiteId}`,
              payload: { errorCode: "authentication_required", prerequisite: handle.prerequisite,
                runtimeQuiesced: handle.runtimeQuiesced, resultFolder: record.resultFolder,
                automaticResume, executionSource: executionContext?.source,
                ...(durable.reason ? { resumeBlockedReason: durable.reason } : {}) } });
            // Waiting is a terminal inference receipt, not success. Measure effect custody only after it exists.
            effectBoundary.persist();
            if (goalControllerAttemptId && !goalControllerAttemptSettled) {
              goalControllerAttemptSettled = true;
              // Only measured runtime drainage can settle the interrupted attempt.
              if (handle.runtimeQuiesced) settleLongRunWorkerAttempt({ attemptId: goalControllerAttemptId, state: "interrupted",
                errorCode: "authentication_required" });
            }
            try { effectsSettled = readInvocationEffectBoundary({ invocationRunId: runId, expectedChatId: chat.id }).effects === "settled"; } catch { /* preserve uncertainty */ }
            durable.effectsSettled = effectsSettled;
            registerInvocationBrowserLoginWait(durable);
            canonicalTask = projectTaskStatus(chat.id, "waiting-decision", true, invocationOrigin);
            if (waitingGoalId) {
              const current = getLongRunByGoalId(waitingGoalId);
              if (current?.status === "running") transitionLongRun({ runId: current.id, to: "waiting_user", actorKind: "host", reason: "authentication_required" });
            }
          })();
          record.browserLoginWait = { handle, durable };
          this.browserLoginWaitingRuns.set(runId, record);
          terminalObserved = true;
          taskMaterialized = Boolean(canonicalTask);
          persistRecoverableAssistantPartial();
          const message = !automaticResume ? (pickLocale(runReq) === "ko"
            ? "로그인이 필요해 이 작업을 기다리고 있어요. 로그인 후 원래 작업 화면에서 계속해 주세요."
            : "This task is waiting for sign-in. After login, continue from the original task surface.") : pickLocale(runReq) === "ko"
            ? "로그인이 필요해 이 작업을 기다리고 있어요. 로그인 확인 후 남은 단계를 이어갑니다."
            : "This task is waiting for sign-in. After login is verified, the remaining steps can continue.";
          appendChatMessage(chat.id, "assistant", message, { hostNotice: { purpose: "host-status", runId, status: "needs-owner" } });
          this.publishRunEvent(record, { runId, chatId: chat.id, event: { kind: "notice", notice: { code: "browser-login-wait", level: "info", message } } });
          if (handle.runtimeQuiesced && automaticResume) record.browserLoginWait.unsubscribe = handle.onRestored(() => {
            void Promise.resolve(record.completion).then(() => record.mainLifetime
              ? record.mainLifetime.afterSettled(() => this.resumeParkedBrowserLoginWait(runId))
              : this.resumeParkedBrowserLoginWait(runId)).catch(error => {
              console.warn("[browser-login-wait] continuation refused", error instanceof Error ? error.name : "unknown");
            });
          });
          return;
        }
        // This typed stop owns the terminal result even if the Goal projection
        // could not be written. Keep effect/usage receipts, but do not turn a
        // stopped inference into a completion claim or launch a verifier.
        if (observedRuntimeErrorCode === "invocation-no-progress"
          || runtimeFailureBlocksReplay({ providerCode: observedRuntimeErrorCode ?? undefined })) return;
        /*
         * The verdict is read from the runner's own final text. The final *event* no longer carries
         * the marker: the client's universal sink derives its text from the durable copy, and the
         * durable copy has every protocol line stripped (stripStrayProtocolTokens) — so from the
         * first observation (2026-09-23) every One/Work look ended effect_observation_marker_missing
         * although the model wrote a valid marker (session transcript, 2026-09-24). The automation
         * path already read result.finalText and settled.
         */
        if (effectObservation && effectObservationParsed?.status !== "reported" && typeof result.finalText === "string") {
          const raw = readEffectObservationFromFinal(runId, result.finalText);
          if (raw && (raw.status !== "absent" || !effectObservationParsed)) effectObservationParsed = raw;
        }
        // An effect observation owns no Goal semantics (see projectionGoalId).
        if (effectObservation) return;
        if (executionContext?.source === "science" && result.goalWaitRequest
          && !controller.signal.aborted && !record.steeringInterruptRequested) {
          // Journal before terminal publication. This is a recoverable model proposal,
          // never a projected Work Goal mutation or a generic this.start continuation.
          record.goalWaitRequest = recordGoalWaitProposal({ sourceInvocationId: runId,
            chatId: chat.id, proposal: result.goalWaitRequest });
        }
        /*
         * A failed goal pass stopped the loop with the goal still open (quota, auth, refusal, exhausted
         * transient). Its stop reason and reset time go into the long-run ledger with a scheduled retry;
         * nothing else in this turn may claim completion or register a wait on top of it. Before
         * 2026-09-24 the stop was set in the client and read nowhere, so the reset time died there.
         */
        if (result.goalPassStop && !executionContext && !controller.signal.aborted
          && goalLongRun && result.goalPassStop.goalId === goalLongRun.goalId) {
          lifetime.retain(parkGoalAfterPassStopWithPool({
            stop: result.goalPassStop,
            invocationRunId: runId,
            chatId: chat.id,
          }).then(() => undefined));
          return;
        }
        if (result.goalWaitRequest && !executionContext) {
          // A finite Goal's refused timer ends this turn through the ordinary end-of-turn verification below.
          let finiteTimerEndsTurn = false;
          let episodeRefused = false;
          let episodeDecisionRecorded = false;
          try {
            if (controller.signal.aborted || record.steeringInterruptRequested) return;
            if (result.goalWaitRequest.status === "invalid") throw new Error(result.goalWaitRequest.reason);
            const goalId = getChat(chat.id)?.goalId;
            if (!goalId || goalId !== goalLongRun?.goalId) throw new Error("goal_wait_goal_binding_changed");
            episodeRefused = true;
            const captureId = `goal-wait:${runId}`;
            captureGoalEpisode({ captureId, goalId, producerInvocationId: runId });
            const disposition = applyGoalEpisodeRest({ requestId: captureId, captureId, goalId,
              intent: result.goalWaitRequest.intent, signal: controller.signal,
              hasTransientAttachments: record.hasTransientAttachments, projectDir: executionCwd,
              latestReceipt: chatId => { const receipt = this.latestReceipt(chatId);
                return receipt ? { runId: receipt.runId, status: receipt.status, errorCode: receipt.errorCode ?? null } : null; },
            }, registerGoalWaitSubscription);
            episodeDecisionRecorded = disposition.code !== "goal_episode_request_conflict";
            if (disposition.status !== "wait_registered") { episodeRefused = true; throw new Error(disposition.code); }
            tryRecordRunEvent({ runId, chatId: chat.id, kind: "goal_wait_registered", payload: { waitId: disposition.waitId,
              goalId, nextCheckAt: disposition.nextCheckAt, executionAvailability: disposition.executionAvailability,
              episodeRequestId: disposition.requestId } });
            drainGoalEpisodeNotices();
            return;
          } catch (error) {
            // Keep typed checkpoint refusals visible. Masking
            // checkpoint_workspace_changed as goal_wait_registration_failed
            // hid the actual projectless-One continuity failure in native QA.
            const reason = error instanceof Error && /^(?:goal_episode|goal_plan|goal_revision|goal_wait|checkpoint)_[a-z_]+$/.test(error.message)
              ? error.message : "goal_wait_registration_failed";
            const current = goalLongRun ? getLongRun(goalLongRun.id) : null;
            const revision = current ? getChatGoalRevision(current.goalId) : null;
            const requestedIntent = result.goalWaitRequest.status === "requested" ? result.goalWaitRequest.intent : null;
            if (current && finiteGoalTimerRefusalEndsTurn({ reason, lifecycle: revision?.lifecycle, status: current.status,
              intent: requestedIntent, aborted: controller.signal.aborted })) {

              // the same timer, and the retry cap stopped a Goal whose deliverables were done. Say what happened and
              // let the turn end through verification like any finite turn.
              finiteTimerEndsTurn = true;
              const message = finiteGoalTimerRefusalMessage(pickLocale(runReq), requestedIntent, reason);
              // One notice per Goal revision: a goal whose turns keep asking for a follow-up must not repeat the same
              // line every cycle (the refusal is recorded every time; the chat line is not).
              const alreadyTold = goalWaitRefusalAlreadyNotified({ chatId: chat.id, goalId: current.goalId,
                revision: revision?.revision ?? null, reason });
              if (!alreadyTold) appendChatMessage(chat.id, "assistant", message, { hostNotice: { purpose: "host-status", runId, status: "wait-not-scheduled" } });
              tryRecordRunEvent({ runId, chatId: chat.id, kind: "goal_wait_refused", payload: { goalId: current.goalId,
                revision: revision?.revision ?? null, reasonCode: reason, disposition: "turn_end_verification", notified: !alreadyTold,
                notBefore: requestedIntent?.subject.kind === "timer" ? requestedIntent.subject.notBefore : null } });
              if (!alreadyTold) this.publishRunEvent(record, { runId, chatId: chat.id, event: { kind: "notice",
                notice: { code: GOAL_WAIT_FINITE_TIMER_NOTICE, level: "info", message } } });
            } else if (!episodeRefused && current?.status === "running" && revision?.lifecycle === "ongoing"
              && !controller.signal.aborted && !record.hasTransientAttachments) {
              let fallbackRegistered = false;
              try {
                readInvocationEffectBoundary({ invocationRunId: runId, expectedChatId: chat.id });
                const wait = getDb().transaction(() => {
                  recordLongRunCycle({ goalId: current.goalId, sourceInvocationId: runId,
                    progressState: "unknown", outcome: "ongoing-episode-unverified" });
                  const registered = registerOngoingGoalCycle({ goalId: current.goalId, invocationRunId: runId });
                  appendLongRunEvent({ runId: current.id, kind: "run.ongoing_cycle_unverified", actorKind: "host",
                    payload: { invocationRunId: runId, waitId: registered.waitId,
                      nextCheckAt: registered.nextCheckAt, originalWaitRefusal: reason } });
                  return registered;
                }).immediate();
                fallbackRegistered = true;
                const message = pickLocale(runReq) === "ko"
                  ? "요청한 대기를 등록하지 못해 현재 상태를 다시 확인하도록 예약했습니다. 이전 작업은 반복하지 않습니다."
                  : "The requested wait could not be registered. A current-state check is scheduled without repeating prior work.";
                appendChatMessage(chat.id, "assistant", message, { hostNotice: { purpose: "host-status", runId, status: "wait-registered" } });
                this.publishRunEvent(record, { runId, chatId: chat.id, event: { kind: "notice",
                  notice: { code: "goal-wait-observation-scheduled", level: "info", message } } });
                tryRecordRunEvent({ runId, chatId: chat.id, kind: "goal_wait_registered", payload: {
                  waitId: wait.waitId, goalId: current.goalId, nextCheckAt: wait.nextCheckAt,
                  lifecycle: "ongoing", observationOnly: true } });
                return;
              } catch (fallbackError) {
                console.warn("[long-run] ongoing wait fallback unavailable:", fallbackError);
                if (fallbackRegistered) return;
              }
            }
            if (episodeRefused && !finiteTimerEndsTurn) {
              // Leave a typed current blocker for the existing Main/AGI recovery
              // owner. Never revive this proposal or disturb a newer producer
              // or a specialist that still owns running work.
              const latest = current ? getLongRun(current.id) : null;
              const producer = latest ? latestGoalEpisodeProducer(latest.id) : undefined;
              if (latest?.status === "running" && !longRunOwnerHold(latest.id) && producer?.invocation_run_id === runId
                && !controller.signal.aborted) transitionLongRun({ runId: latest.id, expectedVersion: latest.version,
                  to: "blocked", actorKind: "host", reason });
              tryRecordRunEvent({ runId, chatId: chat.id, kind: "goal_wait_refused", payload: {
                goalId: current?.goalId ?? null, reasonCode: reason, disposition: episodeDecisionRecorded ? "decision_recorded" : "refused", scheduled: false } });
              return;
            }
            if (!finiteTimerEndsTurn) {
              const latest = current ? getLongRun(current.id) : null;
              if (latest?.status === "running") transitionLongRun({ runId: latest.id, to: "blocked", actorKind: "host", reason });
              // The generic code hides the cause (owner DB 2026-10-04: 39 refusals in an hour, all generic).
              const cause = error instanceof Error ? error.message : String(error);
              tryRecordFailureEvent({ runId, chatId: chat.id, source: "invoke", errorCode: reason,
                errorMessage: reason === "goal_wait_registration_failed" && cause !== reason ? `${reason}: ${cause.slice(0, 200)}` : reason });
              // Say what was refused and what the owner can do — the old sentence ("Review the requested subject
              // and the execution state") named neither (2026-09-27).
              const message = pickLocale(runReq) === "ko"
                ? "대기 조건을 확인하지 못했습니다. 확인은 백그라운드에서 처리하며 가능한 다음 작업을 계속합니다."
                : "The wait condition is unconfirmed. Its check runs in the background while the next available work continues.";
              // A refused wait never blocks the Goal: its check runs in the background.
              const selfResolving = true;
              appendChatMessage(chat.id, "assistant", message, { hostNotice: { purpose: "host-status", runId,
                status: selfResolving ? "wait-not-scheduled" : "needs-owner" } });
              this.publishRunEvent(record, { runId, chatId: chat.id, event: { kind: "notice",
                notice: { code: reason, level: selfResolving ? "info" : "warning", message } } });
            }
          }
          if (!finiteTimerEndsTurn) {
            // The turn asked to be woken at a time; a refused registration must not turn that into "30 s from now".
            const asked = result.goalWaitRequest.status === "requested" && result.goalWaitRequest.intent.subject.kind === "timer"
              ? result.goalWaitRequest.intent.subject.notBefore : null;
            this.scheduleGoalContinuation(goalLongRun?.goalId, record, "goal_wait_registration_failed", { requestedNotBefore: asked });
            return;
          }
        }
        // Only the model's own claim (typed goal_complete or its marker) may close a Goal on its judgment below.
        const modelDeclaredCompletion = Boolean(result.goalCompletionClaim?.claimed);
        let completionClaim = result.goalCompletionClaim ?? (record.automaticGoalId && !record.pendingQuestion && !controller.signal.aborted
          ? { claimed: true, goalId: record.automaticGoalId, evidence: "Automatic Goal: verify the durable terminal result against all criteria." }
          : undefined);
        /*
         * Every goal turn end verifies, continues or stops with a coded reason — never "running" with no attempt.
         * Measured (1.2.43 dev E2E, One chip goal run_27355a43 on Agentlas Light): an explicit Goal whose turn ended without
         * a completion claim (7 in-turn cycles, last one asking the owner a question) stayed status=running with no live
         * attempt: the client queued a hidden every-10m continuation and nothing on the host side scheduled anything.
         */
        /*
         * Automatic Goals too (1.2.43 E2E, serving One automatic goal run_2e5f7bbd): a turn that ended on a typed
         * agentlas-ask question has no completion claim (pendingQuestion suppresses it) and stayed running with no attempt.
         */
        /*
         * And every other turn of the Goal (1.2.43 E2E, explicit serving One goal run_3a5360e1): the checkpoint
         * continuation after verification_inconclusive_retry ended on agentlas-ask and stayed running with no attempt.
         * Which turn-end rule applied depended on how the turn was started (first explicit turn vs revision-bound
         * continuation vs a turn whose controller attempt never bound). A turn that ran in the Goal's own chat while
         * the chat was bound to it is a Goal turn — however it was started — and ends through the same rule.
         */
        const turnEndGoalId = record.automaticGoalId
          ?? (goalControllerAttemptId || (goalLongRun?.rootChatId === chat.id && getChat(chat.id)?.goalId === goalLongRun.goalId)
            ? goalLongRun?.goalId : undefined);
        if (!completionClaim?.claimed && turnEndGoalId && !controller.signal.aborted && !executionContext) {
          const turnGoalId = turnEndGoalId;
          const current = getLongRunByGoalId(turnGoalId);
          if (current && current.surface !== "science" && current.status === "running" && !longRunOwnerHold(current.id)) {
            if (record.pendingQuestion) {
              // The turn asked the owner: this Goal waits for the answer (owner 2026-10-20 "답오기전에 해당작업 보류하며 다른
              // 작업은 진행"). It is held, not scheduled: nothing wakes it to ask the same card again, and its Work project's
              // provider stays free for the owner's other conversations. The answer (any owner message here) reopens it, and the
              // blocked-goal sweep releases it when the owner answered where a Goal cannot reopen (the phone, Telegram).
              try {
                holdGoalForOwnerAnswer({ runId: current.id, invocationRunId: runId, appInstanceId: desktopAppInstanceId() });
              } catch (error) {
                // A hold that cannot be written must never leave the Goal "running" with no attempt: use the spaced follow-up.
                console.warn("[long-run] owner-answer hold unavailable; scheduling the spaced follow-up instead:", error);
                appendLongRunEvent({ runId: current.id, kind: "run.owner_answer_pending", actorKind: "host", payload: { reason: "goal_owner_answer_required", held: false } });
                this.scheduleGoalContinuation(current.goalId, record, "goal_owner_answer_required");
              }
            } else if (!result.goalEpisodeYield && result.goalHostWakeRequested?.goalId === turnGoalId) {
              // The turn ended with safe work left on this finite Goal: the host wakes the next episode itself (spaced
              // follow-up → blocked-goal sweep). No automation owns it any more (owner 2026-10-20: a Goal continuation is
              // not a graph). An enabled "Goal continuation" row used to own this step; 4 of the 5 on the owner's store
              // had next_run_at NULL and woke nobody (production 1.3.11, Yotube 2026-10-12: 45 minutes in waiting_tool).
              transitionLongRun({ runId: current.id, to: "waiting_tool", actorKind: "host", reason: GOAL_CONTINUATION_HOST_WAKE });
              this.scheduleGoalContinuation(current.goalId, record, GOAL_CONTINUATION_HOST_WAKE);
            } else {
              completionClaim = { claimed: true, goalId: turnGoalId,
                evidence: "Goal turn ended without a completion claim: verify the durable terminal result against all criteria." };
            }
          }
        }
        if (completionClaim?.claimed && completionClaim.goalId) {
          const ongoingRevision = getChatGoalRevision(completionClaim.goalId);
          if (ongoingRevision?.lifecycle === "ongoing" && getChat(chat.id)?.goalId === completionClaim.goalId
            && !controller.signal.aborted && !result.goalEpisodeYield) {
            // A continuing mandate needs a settled execution boundary and a
            // next observation, not a model judge declaring the entire mandate
            // complete after every episode. The wait checkpoint keeps this
            // result unverified and forces inspection before another action.
            settleGoalResultMessages({ chatId: chat.id, goalId: completionClaim.goalId, runId, verified: false,
              verificationScope: "episode", verificationState: "not_requested" });
            try {
              readInvocationEffectBoundary({ invocationRunId: runId, expectedChatId: chat.id });
              getDb().transaction(() => {
                recordLongRunCycle({ goalId: completionClaim.goalId!, sourceInvocationId: runId,
                  progressState: "unknown", outcome: "ongoing-episode-unverified" });
                const wait = registerOngoingGoalCycle({ goalId: completionClaim.goalId!, invocationRunId: runId,
                  hasTransientAttachments: record.hasTransientAttachments });
                const current = getLongRunByGoalId(completionClaim.goalId!);
                if (current) appendLongRunEvent({ runId: current.id, kind: "run.ongoing_cycle_unverified", actorKind: "host",
                  payload: { invocationRunId: runId, waitId: wait.waitId, nextCheckAt: wait.nextCheckAt } });
              }).immediate();
            } catch (error) {
              // A missing effect receipt, changed authority or transient
              // attachment is a real continuation boundary. Never replay the
              // producer invocation just to hide that uncertainty.
              console.warn("[long-run] ongoing cycle wait unavailable:", error);
              const current = getLongRunByGoalId(completionClaim.goalId);
              if (current?.status === "running") transitionLongRun({ runId: current.id,
                to: "blocked", actorKind: "host", reason: error instanceof Error && /^goal_wait_[a-z_]+$/.test(error.message)
                  ? error.message : "goal_wait_registration_failed" });
            }
            this.scheduleGoalContinuation(completionClaim.goalId, record, "ongoing-cycle-check-pending");
          }
          // A finite Goal the owner re-targeted during this turn is verified against the new revision, never the

          if (!controller.signal.aborted && holdFiniteGoalForPendingAmendment(completionClaim.goalId)) {
            settleGoalResultMessages({ chatId: chat.id, goalId: completionClaim.goalId, runId, verified: false });
            const message = pickLocale(runReq) === "ko"
              ? "새로 주신 목표를 반영한 뒤 이어갑니다. 이번 결과는 바뀌기 전 목표로 검증하지 않았어요."
              : "Continuing under the goal you just updated. This result was not verified against the previous goal.";
            appendChatMessage(chat.id, "assistant", message);
            this.publishRunEvent(record, { runId, chatId: chat.id, event: { kind: "notice",
              notice: { code: "goal-owner-amendment-pending", level: "info", message } } });
            this.scheduleGoalContinuation(completionClaim.goalId, record, "goal_owner_amendment_pending");
            return;
          }
          let retryCheckpointId: string | null = null;
          let episodeCheckpointId: string | null = null;
          // Only a host-observed idle yield on the Goal being verified (never the model's own claim).
          const idleYieldGoalId = !modelDeclaredCompletion && result.goalIdleYield?.goalId === completionClaim.goalId
            ? result.goalIdleYield.goalId : null;
          // The client records only a verification request. The independent
          // judge starts here, after invoke_completed/mcp_final and the result
          // receipt are durable, so model prose can never outrun host evidence.
          if (!result.goalEpisodeYield) this.scheduleGoalContinuation(completionClaim.goalId, record, "verification_background");
          if ([...this.pendingGoalVerifications.values()].some((pending) => pending.chatId === chat.id)) return;
          this.pendingGoalVerifications.set(runId, record);
          record.nativeGoalEpisodePending = Boolean(result.goalEpisodeYield);
          void runMainBackgroundTask(() => {
            const verificationRunId = `background-verification:${runId}`;
            const verificationLifetime = new MainInvocationLifetime(admitMainInvocation(chat.id, verificationRunId), chat.id, verificationRunId);
            return verificationLifetime.run(() => import("../long-run/verifier")
            .then(({ verifyGoalCompletionClaim }) => retryTransientGoalVerification({
              signal: controller.signal,
              verify: () => verifyGoalCompletionClaim({
                goalId: completionClaim.goalId!,
                signal: controller.signal,
                outcomeText: result.finalText?.trim() || "Completion claimed without result text.",
                evidence: completionClaim.evidence,
                invocationRunId: runId,
                projectDir: executionCwd,
                hasTransientAttachments: record.hasTransientAttachments,
                background: true,
              }),
              onRetry: ({ attempt, delayMs, reasonCode }) => {
                const current = getLongRunByGoalId(completionClaim.goalId!);
                if (!current || LONG_RUN_TERMINAL_STATUSES.has(current.status) || longRunOwnerHold(current.id)) throw new Error("verification_retry_state_changed");
                appendLongRunEvent({
                  runId: current.id,
                  kind: "verification.transient_retry_scheduled",
                  actorKind: "host",
                  payload: {
                    invocationRunId: runId,
                    attempt,
                    delayMs,
                    reasonCode,
                  },
                });
              },
            }))
            .then((verification) => {
              /*
               * Close the goal that was verified, not the one that happened to be auto-admitted.
               *
               * Every branch here used to be guarded by `record.automaticGoalId`, which is only set
               * when the host admitted the goal from a plain sentence. A goal started from the Goal
               * chip has no such id, so this handler returned immediately and nothing acted on the
               * verdict: the run stayed in `verifying` forever, `should-continue` answered
               * `goal_verifying`, and completing it returned false. Measured end to end on an
               * isolated store -- closing the open tasks moved the run to `verifying` and there was
               * no exit from that state in any code path.
               *
               * The goal being verified is named by the claim. That is the identity to act on.
               */
              episodeCheckpointId = verification?.checkpointId ?? null;
              const modelJudgmentClosed = modelDeclaredCompletion && !controller.signal.aborted
                && getChat(chat.id)?.goalId === completionClaim.goalId
                && !["completed", "cycle_completed"].includes(verification?.disposition ?? "")
                && !(verification?.verdicts ?? []).some((criterion) => criterion.verdict === "failed")
                && closeGoalOnModelJudgment(completionClaim.goalId!, verification ? `verification_${verification.disposition}` : "verification_unavailable");
              settleGoalResultMessages({ chatId: chat.id, goalId: completionClaim.goalId!, runId,
                verified: modelJudgmentClosed || (!controller.signal.aborted && ["completed", "cycle_completed"].includes(verification?.disposition ?? "")) });
              if (modelJudgmentClosed) {
                if (getChat(chat.id)?.goalId === completionClaim.goalId) setChatGoalBinding(chat.id, null);
                return;
              }
              if (controller.signal.aborted || getChat(chat.id)?.goalId !== completionClaim.goalId) return;
              const verifiedGoalId = completionClaim.goalId!;
              if (verification?.disposition === "completed") {
                completeChatGoalContract(verifiedGoalId, "completed");
                if (getChat(chat.id)?.goalId === verifiedGoalId) setChatGoalBinding(chat.id, null);
              } else if (verification?.disposition === "cycle_completed") {
                // This episode registers its exact wait after verification below.
                // Do not announce an absent receipt or an assumed 30-minute time.
                if (result.goalEpisodeYield) return;
                const wait = latestGoalWaitSubscription(verifiedGoalId);
                const message = pickLocale(runReq) === "ko"
                  ? "이번 회차를 확인했습니다. 지속 목표는 유지되며, 앱 실행 중 30분 뒤 현재 상태를 확인해 이어갑니다. 중지하면 더 이상 재개하지 않습니다."
                  : "This cycle is verified. The ongoing Goal stays open and will check current state again in 30 minutes while the app is running. Stop prevents further continuation.";
                appendChatMessage(chat.id, "assistant", message, { hostNotice: { purpose: "host-status", runId, status: "cycle-verified" } });
                tryRecordRunEvent({ runId, chatId: chat.id, kind: "goal_wait_registered", payload: { waitId: wait?.waitId,
                  goalId: verifiedGoalId, nextCheckAt: wait?.nextCheckAt, lifecycle: "ongoing", executionAvailability: "app-running" } });
              } else if (verification?.disposition === "retry_required") {
                // The verifier owns its verdict transition. Inconclusive returns
                // to running to gather evidence, never straight back to blocked.
                // A turn whose passes did nothing (client goal_idle_pass_yield) and that the verifier does not call done
                // would only repeat itself on another wake: the owner is asked by card instead, and the Goal rests
                // held for the answer. If the Goal cannot be held the verifier's own retry stands.
                const askedOwner = idleYieldGoalId === verifiedGoalId && this.askOwnerAfterIdleYield({
                  goalId: verifiedGoalId, chatId: chat.id, runId, record, locale: pickLocale(runReq) === "ko" ? "ko" : "en" });
                if (!askedOwner) retryCheckpointId = verification.checkpointId;
              } else if (!verification) {
                const current = getLongRunByGoalId(verifiedGoalId);
                if (!result.goalEpisodeYield && current?.status === "verifying") transitionLongRun({ runId: current.id,
                  to: "blocked", actorKind: "host", reason: "verification_unavailable" });
              }
            })
            .catch((error: unknown) => {
              const modelJudgmentClosed = modelDeclaredCompletion && !controller.signal.aborted
                && getChat(chat.id)?.goalId === completionClaim.goalId
                && closeGoalOnModelJudgment(completionClaim.goalId!, "verification_failed_to_run");
              settleGoalResultMessages({ chatId: chat.id, goalId: completionClaim.goalId!, runId, verified: modelJudgmentClosed });
              console.warn("[long-run] terminal verification failed:", error);
              if (modelJudgmentClosed) {
                if (getChat(chat.id)?.goalId === completionClaim.goalId) setChatGoalBinding(chat.id, null);
                return;
              }
              if (controller.signal.aborted) return;
              // A verifier that never answered must still leave the goal somewhere a person can act
              // on. Silence here was the difference between "blocked, here is why" and a run stuck
              // in `verifying` with no way forward.
              const current = getLongRunByGoalId(completionClaim.goalId!);
              if (!result.goalEpisodeYield && current && ["running", "verifying"].includes(current.status)) {
                transitionLongRun({ runId: current.id, to: "blocked", actorKind: "host", reason: "verification_unavailable" });
              }
            })
            .finally(() => {
              if (result.goalEpisodeYield && !controller.signal.aborted && !record.steeringInterruptRequested
                && !this.steerQueues.get(record.chatId)?.length) {
                try {
                  const settlement = settleNativeGoalEpisode(result.goalEpisodeYield, {
                    checkpointId: episodeCheckpointId, hasTransientAttachments: record.hasTransientAttachments });
                  tryRecordRunEvent({ runId, chatId: chat.id, kind: "goal_native_episode_settlement",
                    payload: { settlement, goalId: result.goalEpisodeYield.goalId, goalRevision: result.goalEpisodeYield.goalRevision } });
                } catch (error) {
                  console.warn("[long-run] native episode settlement unavailable:", error);
                  // A rolled-back wait/cycle transaction still needs a durable
                  // follow-up. Existing current-authority/effect guards choose
                  // observation before any action and preserve registered waits.
                  this.scheduleGoalContinuation(result.goalEpisodeYield.goalId, record, "native-episode-settlement-pending");
                }
              }
              record.nativeGoalEpisodePending = false;
              this.pendingGoalVerifications.delete(runId);
              this.publishActiveChats();
              // 검증을 기다리며 줄 선 오너 요청은 지금 바로 돈다(스윕의 옛 목표 재개보다 먼저).
              this.drainSteerQueue(record.chatId);
              if (record.automaticGoalDeadline) clearTimeout(record.automaticGoalDeadline);
              this.settleAutomaticGoalInterruption(record);
              if (retryCheckpointId) this.scheduleGoalContinuation(completionClaim.goalId, record, "verification_retry_required");
            }));
          });
        }
      })
      .catch((error: unknown) => {
        const diagnostic = invocationErrorDiagnostic(error, {
          agentAppMode: runReq.agentAppMode,
          context: { phase: "completion-chain-catch", executionSource: record.executionSource,
            runtimeKind: runReq.runtimeSelection?.kind, scienceProjectId: record.executionContext?.science?.projectId,
            scienceTurnId: record.executionContext?.science?.turnId },
          redactText: value => redactWorkAttachmentText(runReq, redactOneAttachmentText(runReq, value)),
        });
        if (diagnostic) tryRecordRunEvent({ runId, chatId: runReq.chatId, agentId: record.actualAgentId,
          kind: "invoke_error_diagnostic", payload: diagnostic });
        settleGoalControllerAttempt(false);
        effectObservationFailed = true;
        const failedGoalId = record.automaticGoalId ??
          (error instanceof Error && error.message === "durable_user_message_hook_failed" ? projectionGoalId : null);
        if (failedGoalId && !controller.signal.aborted) {
          try {
            const current = getLongRunByGoalId(failedGoalId);
            if (current && ["queued", "running", "waiting_worker", "waiting_tool"].includes(current.status)) {
              transitionLongRun({ runId: current.id, to: "blocked", actorKind: "host", reason: "invocation_failed" });
            }
          } catch { /* Keep the original provider failure visible. */ }
        }
        const rawMessage = redactWorkAttachmentText(runReq, redactOneAttachmentText(
          runReq,
          error instanceof Error ? error.message : String(error),
        ));
        const terminalDisposition = classifyMainOwnedTerminal({
          eventKind: "error",
          steeringInterruptRequested: record.steeringInterruptRequested,
          signalAborted: controller.signal.aborted,
          abortReason: controller.signal.reason,
        });
        const safeFailure = runReq.agentAppMode
          ? {
              ...untrustedRuntimeFailurePayload(),
              ...(terminalDisposition.errorCode ? { code: terminalDisposition.errorCode } : {}),
            }
          // The thrown failure's own machine code; the wrapper code only when it carries none (audit A7 M10).
          : { code: terminalDisposition.errorCode ?? outwardFailureCode(error) ?? "invoke-threw", message: rawMessage };
        const message = safeFailure.message;
        tryRecordRunEvent({
          runId,
          kind: "invoke_threw",
          chatId: runReq.chatId,
          agentId: record.actualAgentId,
          payload: { errorCode: safeFailure.code, errorMessage: message },
        });
        if (!record.background && !terminalDisposition.errorCode) {
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
          canonicalTask = projectTaskStatus(
            runReq.chatId,
            terminalTaskStatus({
              kind: "error",
              requestsDecision: false,
              cancelled: terminalDisposition.terminalKind === "invoke_cancelled",
              interrupted: terminalDisposition.terminalKind === "invoke_interrupted",
              hasPartialText: Boolean(record.partialText.trim()),
            }),
            taskMaterialized,
            invocationOrigin,
          );
          taskMaterialized = Boolean(canonicalTask);
          persistRecoverableAssistantPartial();
          persistEmptyFailureNotice(terminalDisposition.terminalKind, safeFailure.code);
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
          const terminalKind = terminalDisposition.terminalKind;
          tryRecordRunEvent({
            runId,
            kind: terminalKind,
            chatId: runReq.chatId,
            agentId: record.actualAgentId,
            payload: { resultFolder: record.resultFolder, errorCode: safeFailure.code, errorMessage: message,
              // Measured 2026-09-28 (isolated app, before): a turn cut by app quit landed here as
              // invoke-threw with no cause, so it read as a crash. Keep Main's own stop marker.
              ...(controller.signal.aborted && controller.signal.reason instanceof Error
                && invocationHostStopCause(controller.signal.reason.message)
                ? { hostStopCause: invocationHostStopCause(controller.signal.reason.message) } : {}) },
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
      .finally(async () => {
        await releaseWorkAttachmentRun(runId).catch(() => { /* cleanup refusal cannot prevent terminal settlement */ });
        if (record.automaticGoalDeadline && !this.pendingGoalVerifications.has(runId)) clearTimeout(record.automaticGoalDeadline);
        settleGoalControllerAttempt(false);
        if (!this.pendingGoalVerifications.has(runId)) this.settleAutomaticGoalInterruption(record);
        if (!terminalObserved) {
          const terminalDisposition = classifyMainOwnedTerminal({
            eventKind: "error",
            steeringInterruptRequested: record.steeringInterruptRequested,
            signalAborted: controller.signal.aborted,
            abortReason: controller.signal.reason,
          });
          canonicalTask = projectTaskStatus(
            runReq.chatId,
            terminalTaskStatus({
              kind: "error",
              requestsDecision: false,
              cancelled: terminalDisposition.terminalKind === "invoke_cancelled",
              interrupted: terminalDisposition.terminalKind === "invoke_interrupted",
              hasPartialText: Boolean(record.partialText.trim()),
            }),
            taskMaterialized,
            invocationOrigin,
          );
          taskMaterialized = Boolean(canonicalTask);
          const terminalKind = terminalDisposition.terminalKind;
          persistEmptyFailureNotice(terminalKind, terminalDisposition.errorCode);
          tryRecordRunEvent({
            runId,
            kind: terminalKind,
            chatId: runReq.chatId,
            agentId: record.actualAgentId,
            payload: {
              resultFolder: record.resultFolder,
              ...(terminalDisposition.errorCode ? { errorCode: terminalDisposition.errorCode } : {}),
              errorMessage: "Runtime settled without a terminal event",
              // 러너가 종료 이벤트 없이 끝나도, 끊은 쪽이 Main 이면 그 표식을 남긴다(앱 종료·Goal 중지/삭제).
              ...(controller.signal.aborted && controller.signal.reason instanceof Error
                && invocationHostStopCause(controller.signal.reason.message)
                ? { hostStopCause: invocationHostStopCause(controller.signal.reason.message) } : {}),
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
        // Only runner settlement closes effect coverage. Model final can arrive
        // while the adapter is still draining tool/transport work.
        try { effectBoundary.persist(); }
        catch (error) { console.warn("[invocation] effect boundary receipt failed:", error); }
        if (this.activeRuns.settle(runId)) this.publishActiveChats();
        if (!nativeController || isLocalInvocationPreparationPort(nativePreparation!.port)) releaseOneAttachmentRun(requestedOneAttachmentRef);
      })))))).catch((error: unknown) => {
        console.warn("[invocation] execution cleanup failed:", error);
        // The inner chain settles the slot in its own finally. Still registered here means a lifetime wrapper rejected
        // before that chain was attached (or its finally threw first): start() already returned, so settle and
        // publish here or the chat stays "running" and refuses every later start (independent review 2026-10-04).
        if (this.activeRuns.has(runId)) this.releaseUndispatchedStart(runId, runReq.chatId, error, startBoundary.cleanups ?? [], record);
      }).finally(() => lifetime.afterSettled(async () => {
        if (record.ownerLease) {
          try { invocationRunOwners.release(record.ownerLease); }
          catch (error) { console.warn("[invocation] drained owner release remains unconfirmed:", error); }
        }
        if (nativePreparation) {
          // A missing cleanup ACK cannot retain an already drained execution slot.
          // Failed owner/CAS or actual preparation drain proof keeps the live fence.
          if (!this.retireDrainedNativeExecution(runId, record, nativePreparation)) return;
        } else this.settlingRuns.delete(runId);
        this.publishActiveChats();
        if (nativePreparation) this.finishOrdinaryOneTurn(nativePreparation, "execution");
        // Actual execution authority is closed; original resource cleanup remains separate.
        this.publishSettled(runId, record);
        this.carryUndeliveredOwnerFollowups(runId, record);
        const hasQueuedSteer = Boolean(this.steerQueues.get(record.chatId)?.length);
        this.drainSteerQueue(runReq.chatId);
        // A turn in a Work project released it: Goals refused as project-busy continue now (event-driven).
        if (chat.projectId && !effectObservation) {
          const projectId = chat.projectId;
          setTimeout(() => {
            try { resumeGoalsWaitingOnProject(this, projectId); }
            catch (error) { console.warn("[blocked-goal-sweep] project release resume failed:", error); }
          }, 1_500).unref?.();
        }
        if (!effectObservation && !hasQueuedSteer && !record.nativeGoalEpisodePending) this.scheduleGoalContinuation(record.automaticGoalId ?? projectionGoalId ?? undefined, record,
          observedRuntimeErrorCode ?? "goal_turn_settled");
        if (retryGoalCheckpoint && !hasQueuedSteer) this.continueGoalCheckpoint({
          ...retryGoalCheckpoint, record, executionContext,
        });
        if (effectObservation) {
          if (effectObservationDeadline) clearTimeout(effectObservationDeadline);
          try {
            completeEffectObservation({ runId, parsed: effectObservationParsed,
              aborted: controller.signal.aborted, failed: effectObservationFailed });
          } catch (error) {
            console.warn("[effect-observation] completion failed:", error);
          }
        }
      }));
    // From here the completion chain above owns this run's terminal settlement and registry slot.
    startBoundary.handedOff = true;

    return { runId };
  }

  /**
   * A failure after the durable start receipt that the runner's own terminal settlement will never see: a synchronous
   * throw before the completion chain was assigned (the caller gets the error), or a lifetime wrapper rejecting before
   * the inner chain was attached (start() already returned, so `settledRecord` is published). Live 2026-10-04 (TPA
   * study, update-like restart): one "database is locked" here left the Science chat refusing every retry with
   * chat_invocation_active until the app was reopened. Undo what the start acquired, record the terminal fact once,
   * and release the slot.
   */
  private releaseUndispatchedStart(runId: string, chatId: string, error: unknown, cleanups: Array<() => void>,
    settledRecord?: RunRecord, onCleanupLoopCompleted?: () => void): void {
    const diagnosticRecord = settledRecord ?? this.activeRuns.get(runId);
    try {
    // Inspect only a known Main request, before cleanup removes attachment aliases.
    if (diagnosticRecord) {
      const diagnosticRequest = diagnosticRecord.request;
      const diagnostic = invocationErrorDiagnostic(error, {
        agentAppMode: diagnosticRequest.agentAppMode,
        context: { phase: "undispatched-start", executionSource: diagnosticRecord.executionSource,
          runtimeKind: diagnosticRequest.runtimeSelection?.kind,
          scienceProjectId: diagnosticRecord.executionContext?.science?.projectId,
          scienceTurnId: diagnosticRecord.executionContext?.science?.turnId },
        redactText: value => redactWorkAttachmentText(diagnosticRequest, redactOneAttachmentText(diagnosticRequest, value)),
      });
      if (diagnostic) tryRecordRunEvent({ runId, chatId, agentId: diagnosticRecord.actualAgentId,
        kind: "invoke_error_diagnostic", payload: diagnostic });
    }
    console.warn("[invocation] start failed after its durable receipt and before dispatch; releasing the chat", error);
    } catch { /* Diagnostic collection/formatting cannot skip terminal cleanup. */ }
    for (const cleanup of cleanups) {
      try { cleanup(); }
      catch (cleanupError) {
        try { console.warn("[invocation] undispatched start cleanup failed:", cleanupError); }
        catch { /* A diagnostic formatter cannot prevent the next cleanup. */ }
      }
    }
    onCleanupLoopCompleted?.();
    // The ledger projects a start without a terminal row as "interrupted", so ask for the row itself: a runner that
    // already wrote its terminal fact before failing keeps it, and only a missing one is recorded here.
    const terminalRecorded = getDb().prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND kind IN
      ('invoke_waiting','invoke_completed','mcp_final','invoke_cancelled','invoke_interrupted','invoke_failed','invoke_threw','mcp_error') LIMIT 1`).get(runId);
    if (!terminalRecorded) {
      const message = error instanceof Error ? error.message : String(error);
      tryRecordRunEvent({
        runId,
        kind: "invoke_threw",
        chatId,
        agentId: this.activeRuns.get(runId)?.actualAgentId,
        // The refusal's own machine code, not a wrapper the AGI monitor had to re-parse from the message (audit A7 M10).
        payload: { errorCode: outwardFailureCode(error) ?? "invoke-start-failed", errorMessage: message.slice(0, 500), providerDispatched: false,
          turnDelivery: "not-dispatched" },
      });
    }
    this.settlingRuns.delete(runId);
    if (this.activeRuns.settle(runId)) this.publishActiveChats();
    if (diagnosticRecord?.ownerLease) {
      try { invocationRunOwners.release(diagnosticRecord.ownerLease); }
      catch (cleanupError) { console.warn("[invocation] undispatched owner release remains unconfirmed:", cleanupError); }
    }
    if (settledRecord) this.publishSettled(runId, settledRecord);
  }

  /** Main-only scheduler seam. Claims are durable before this call; a crash
   * after claim cannot dispatch a second successor on replay. */
  private cancelParkedBrowserLoginWait(runId: string, reason: string, cancelled: boolean): void {
    const record = this.browserLoginWaitingRuns.get(runId);
    if (!record?.browserLoginWait) return;
    const parked = record.browserLoginWait;
    // Durable cancellation precedes revocation; a store failure still cannot keep authority live.
    try {
      settleInvocationBrowserLoginWait(runId, cancelled ? "cancelled" : "blocked", reason);
      if (cancelled) {
        recordRunEvent({ runId, chatId: record.chatId, kind: "invoke_cancelled", payload: { errorCode: "browser_login_wait_cancelled", reason } });
        if (getLatestInvocationRunReceipt(record.chatId)?.runId === runId) trySetTaskStatus(record.chatId, "cancelled", true);
      }
    } finally {
      this.browserLoginWaitingRuns.delete(runId);
      parked.unsubscribe?.();
      parked.handle.cancel();
      record.controller.abort(new Error(reason));
      if (cancelled) {
        record.browserLoginWait = undefined;
        if (getLatestInvocationRunReceipt(record.chatId)?.runId === runId) {
          record.settlementPublished = false;
          this.publishSettled(runId, record);
        }
      }
    }
  }

  private resumeParkedBrowserLoginWait(runId: string): void {
    const record = this.browserLoginWaitingRuns.get(runId);
    const parked = record?.browserLoginWait;
    if (!record || !parked || !parked.handle.runtimeQuiesced
      || !canResumeInvocationBrowserLoginWait(record.executionContext)) return;
    const current = () => {
      if (!this.acceptingStarts || record.controller.signal.aborted || record.cancelRequestedAt
        || this.browserLoginWaitingRuns.get(runId) !== record || this.activeChatIds().includes(record.chatId)
        || this.steerQueues.get(record.chatId)?.length) return false;
      const latest = getLatestInvocationRunReceipt(record.chatId);
      if (latest?.runId !== runId || latest.status !== "waiting_input") return false;
      const goalId = parked.durable.goalId;
      if (goalId) {
        const goal = getLongRunByGoalId(goalId);
        if (getChat(record.chatId)?.goalId !== goalId || getChatGoalRevision(goalId)?.revision !== parked.durable.goalRevision
          || !goal || LONG_RUN_TERMINAL_STATUSES.has(goal.status) || longRunOwnerHold(goal.id)
          || !["waiting_user", "queued", "running", "waiting_tool"].includes(goal.status)) return false;
      } else if (!record.executionContext && getChat(record.chatId)?.goalId) return false;
      return true;
    };
    const successorRunId = `login-resume-${randomUUID()}`;
    if (!claimInvocationBrowserLoginWait({ wait: parked.durable, prerequisite: parked.handle.prerequisite,
      ownerEpoch: desktopAppInstanceId(), successorInvocationId: successorRunId, isCurrent: current })) return;
    this.browserLoginWaitingRuns.delete(runId);
    parked.unsubscribe?.();
    try {
      const successorAdmission = record.mainLifetime?.successor(record.chatId, successorRunId);
      if (record.mainLifetime && !successorAdmission) throw new Error("browser_login_continuation_scope_changed");
      const goalId = parked.durable.goalId;
      if (goalId && !parked.durable.effectsSettled) {
        // Reconcile the old operation independently while the fresh, read-only
        // continuation inspects other current work under the exact login claim.
        setTimeout(() => {
          try { runMainBackgroundTask(() => maybeDispatchEffectObservation(this, goalId, "browser-login-restored")); }
          catch (error) { console.warn("[effect-observation] login background check unavailable:", error); }
        }, 0).unref?.();
      }
      if (goalId) {
        const goal = getLongRunByGoalId(goalId);
        if (goal && ["waiting_user", "queued", "waiting_tool"].includes(goal.status)) transitionLongRun({ runId: goal.id, to: "running", actorKind: "host", reason: "authentication_restored" });
      }
      // Consumed single-use capabilities and the original action prompt cannot be replayed.
      const { runId: _old, images: _images, oneUserAuthoredPrompt: _authored, oneMemoryUseOnceRef: _memory,
        oneBriefingActionRef: _briefing, oneTeamPreflightRef: _team, oneAttachmentRef: _attachment,
        oneRecurrenceSelection: _recurrence, ...request } = record.request;
      const readOnly = !parked.durable.effectsSettled;
      this.start({ ...request, runId: successorRunId, promptOrigin: "system", taskIntent: "task",
        ...(readOnly ? { permissions: "read", onePermissionMode: "read" } : {}),
        userPrompt: `login restored (source run ${runId}). Inspect results and external state, then do only what remains.${readOnly ? " read-only: report what happened." : ""}`,
      }, record.workspaceBinding, record.executionContext, undefined, "goal-continuation",
        successorAdmission);
      settleInvocationBrowserLoginWait(runId, "dispatched");
    } catch (error) {
      settleInvocationBrowserLoginWait(runId, "blocked", "browser_login_resume_refused");
      const goal = parked.durable.goalId ? getLongRunByGoalId(parked.durable.goalId) : null;
      if (goal?.status === "running") transitionLongRun({ runId: goal.id, to: "blocked", actorKind: "host", reason: "browser_login_resume_refused" });
      this.scheduleGoalContinuation(goal?.goalId, record, "browser-login-resume-refused");
      console.warn("[browser-login-wait] resume refused", error instanceof Error ? error.name : "unknown");
    } finally {
      parked.handle.cancel();
    }
  }

  resumeGoalWait(input: GoalWaitDispatch): { runId: string } {
    const wait = latestGoalWaitSubscription(input.goalId), run = getLongRunByGoalId(input.goalId);
    if (!this.acceptingStarts || !wait || wait.waitId !== input.waitId || wait.state !== "claimed"
      || wait.successorInvocationId !== input.invocationRunId || wait.checkpointId !== input.checkpointId
      || !run || run.status !== "running" || getChat(wait.chatId)?.goalId !== input.goalId
      || input.request.chatId !== wait.chatId || input.request.runId !== input.invocationRunId
      || ((wait.recoveryMode || wait.observationOnly) && (input.request.permissions !== "read"
        || (run.surface === "one" && input.request.onePermissionMode !== "read")))
      || this.activeChatIds().includes(wait.chatId) || this.steerQueues.get(wait.chatId)?.length) throw new Error("goal_wait_dispatch_state_changed");
    const checkpoint = latestTaskCheckpoint(input.goalId);
    if (!checkpoint || checkpoint.checkpointId !== input.checkpointId) throw new Error("goal_wait_checkpoint_changed");
    const prepared = prepareCheckpointContinuation(checkpoint, input.invocationRunId);
    if (JSON.stringify(prepared.runtimeSelection) !== JSON.stringify(input.request.runtimeSelection))
      throw new Error("goal_wait_runtime_selection_changed");
    return this.start(input.request, undefined, undefined, undefined, "goal-continuation",
      admitMainInvocation(wait.chatId, input.invocationRunId));
  }

  /**
   * The host drove this Goal again, its passes did nothing, and the terminal verification did not close it: another wake
   * would repeat that (owner 2026-10-20 "묻는건 무조건 카드로 주고 알림 울리게해"). The owner gets the same decision card a
   * model writes (fixed host copy, no word judged), the Goal rests held for the answer — nothing wakes it, so it neither
   * re-asks nor keeps the Work project's provider busy — and the desktop and the phone ring through the owner-ask seam.
   * A card posted before the verification pre-empted it and held a Goal that was already done; this one only follows a
   * verdict that did not close the Goal. Returns false when the Goal could not be held (nothing is left half-done: the
   * caller then keeps the verifier's own retry).
   */
  private askOwnerAfterIdleYield(input: { goalId: string; chatId: string; runId: string; record: RunRecord; locale: "ko" | "en" }): boolean {
    let heldVersion: number | null = null;
    try {
      const run = getLongRunByGoalId(input.goalId);
      if (!run || run.surface === "science" || !goalHoldableForOwnerAnswer(run) || longRunOwnerHold(run.id)
        || getChat(input.chatId)?.goalId !== input.goalId || input.record.controller.signal.aborted
        || input.record.steeringInterruptRequested || this.steerQueues.get(input.chatId)?.length) return false;
      heldVersion = holdGoalForOwnerAnswer({ runId: run.id, invocationRunId: input.runId, appInstanceId: desktopAppInstanceId() }).version;
      // noGoalResult: a host-written card is not the Goal's answer, so it must never wait for a verification verdict.
      appendChatMessage(input.chatId, "assistant", canonicalAskFenceText(hostOwnerCardQuestions("goal_idle_stop", input.locale)), { noGoalResult: true });
      tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "goal_owner_card_added",
        payload: { source: "goal_idle_pass_yield", after: "verification" } });
      reportOwnerAsk({ chatId: input.chatId, source: "goal", key: input.runId });
      return true;
    } catch (error) {
      console.warn("[long-run] idle-yield owner card unavailable; the verifier's retry stands:", error);
      // Held but no card written: never leave a Goal waiting for a question nobody can see.
      if (heldVersion !== null) {
        try { releaseGoalOwnerAnswerHold({ runId: getLongRunByGoalId(input.goalId)?.id ?? "", expectedVersion: heldVersion, reason: "owner_card_not_posted", appInstanceId: desktopAppInstanceId() }); }
        catch (releaseError) { console.warn("[long-run] owner-answer hold could not be released:", releaseError); }
      }
      return false;
    }
  }

  /** Durable continuation and read-only reconciliation have independent owners. */
  private scheduleGoalContinuation(goalId: string | null | undefined, record: RunRecord, reason: string,
    options: { requestedNotBefore?: string | null } = {}): void {
    const stop = record.controller.signal.reason;
    const ownerStop = record.controller.signal.aborted && stop instanceof Error
      && (stop.message === STOPPED_BY_USER || isOwnerGoalStopCause(stop.message) || Boolean(invocationHostStopCause(stop.message)));
    if (!goalId || record.background || ownerStop || record.steeringInterruptRequested
      || runtimeFailureBlocksNextAutomaticTurn({ providerCode: reason })) return;
    try {
      const run = getLongRunByGoalId(goalId);
      if (!run || run.surface === "science" || LONG_RUN_TERMINAL_STATUSES.has(run.status)
        || longRunOwnerHold(run.id) || getChat(record.chatId)?.goalId !== goalId) return;
      // A Goal held for the owner's answer is woken by nobody; the turn-end calls that follow the question must not undo that.
      if (goalOwnerAnswerHold(run.id)) return;
      if (automaticGoalReplayBlockerCode(run.id)) return;
      const wait = latestGoalWaitSubscription(goalId);
      if (wait && ["pending", "claimed"].includes(wait.state)) return;
      if (pendingBlockedGoalRetry(run.id)) return;
      // Every follow-up of the same reason doubles its spacing (30 s, 1 min, 2 min … 6 h) until the owner speaks or
      // uses a Goal control; a time the turn asked for is honoured. A turn that asked to wait and could not register
      // it completes with nothing started, so it counts across completed turns (the 2026-10-04 Thread Marketing loop:
      // 39 turns in an hour). Any other reason starts over after a completed turn, so a productive Goal keeps the 30 s
      // step while a failing one backs off. Only the first case was spaced before, and the same loop came back with
      // another reason: X Marketing 2026-10-05 failed runtime_turn_unsettled every minute for 25 minutes.
      const nothingStarted = reason === "goal_wait_registration_failed";
      // A turn that ended because its passes stopped doing anything (client goal_idle_pass_yield) completed, yet it
      // is no progress either: its follow-ups count across completed turns too, so the Goal backs off instead of
      // being woken again after 30 s. Production 2026-10-06, Youtube launch on 1.2.69: after the idle yield the sweep
      // resumed the same blocked check 1.5 minutes later, every time.
      const turnRunId = record.request?.runId;
      const idleYield = !nothingStarted && Boolean(turnRunId && getDb().prepare(
        "SELECT 1 FROM run_events WHERE run_id = ? AND kind = 'goal_idle_pass_yield' LIMIT 1").get(turnRunId));
      const followUpReason = idleYield ? "goal_idle_pass_yield" : reason;
      // A turn that ended on an owner question completed too, but until the owner answers nothing can move: count it
      // across completed turns. Production 1.3.29, Yotube room 2026-10-13 21:09–21:53Z: every follow-up restarted at
      // retryIndex 0, so the Goal woke about once a minute and asked the same phone-verification card 8 times.
      const ownerQuestion = followUpReason === "goal_owner_answer_required";
      const ownerSince = (getDb().prepare("SELECT MAX(created_at) AS at FROM chat_messages WHERE chat_id = ? AND role = 'user'")
        .get(record.chatId) as { at: string | null } | undefined)?.at ?? null;
      const repeats = consecutiveGoalTurnFollowUps(run.id, followUpReason, ownerSince, Date.now(),
        { sinceCompletedTurn: !nothingStarted && !idleYield && !ownerQuestion });
      const plan = goalTurnFollowUpPlan({ repeats, requestedNotBefore: options.requestedNotBefore });
      // The same move already failed for one machine cause (wake-arbiter.ts, owner 2026-09-24): the follow-up shows the time
      // the sweep will really start it and carries that cause, instead of a 30 s step the arbiter would only defer again.
      const sameCause = sameCauseWakeHold(run.id, record.chatId);
      const held = sameCause && Date.parse(sameCause.retryAt) > Date.parse(plan.nextAt) ? sameCause : null;
      scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: "resume",
        fromReason: held ? `${SAME_CAUSE_WAKE_REASON}:${held.cause}`.slice(0, 120) : followUpReason, retryIndex: repeats,
        nextAt: held ? held.retryAt : plan.nextAt, requestedBy: held ? "host" : plan.requestedBy,
        detail: followUpReason, trigger: "goal-turn-background",
        appInstanceId: desktopAppInstanceId() });
      if (held) console.info("[long-run] same-cause wait", JSON.stringify({ runId: run.id, cause: held.cause, failures: held.failures, nextAt: held.retryAt }));
      setTimeout(() => {
        try { runMainBackgroundTask(() => maybeDispatchEffectObservation(this, goalId, "goal-turn-background")); }
        catch (error) { console.warn("[effect-observation] background check unavailable:", error); }
      }, 0).unref?.();
    } catch (error) {
      console.warn("[long-run] continuation scheduling will retry:", error);
    }
  }

  private continueGoalCheckpoint(input: {
    goalId: string; checkpointId: string; record: RunRecord; executionContext?: InvocationExecutionContext;
  }): void {
    // A stale/uncertain checkpoint is evidence to reconcile, never an old
    // action prompt to replay. The sweep dispatches from current Goal context.
    this.scheduleGoalContinuation(input.goalId, input.record, "checkpoint-follow-up");
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
    record: RunRecord;
    chatId: string;
    goalId: string | null;
    signal: AbortSignal;
    agentId?: string;
    oneMode: boolean;
    locale: "ko" | "en";
  }): Promise<void> {
    const arbiter = getRuntimeToolPermissionArbiter();
    if (!arbiter) return; // 물을 관문이 없으면 승격도 없다 — fail-closed.
    const controlEpoch = (): number | null => {
      try {
        return input.goalId ? (getDb().prepare(
          "SELECT COALESCE(MAX(seq), 0) AS seq FROM long_run_events WHERE run_id = (SELECT id FROM long_runs WHERE goal_id = ?) AND kind = 'run.user_control' AND actor_kind = 'user'",
        ).get(input.goalId) as { seq: number }).seq : 0;
      } catch { return null; }
    };
    const originalControlEpoch = controlEpoch();
    if (originalControlEpoch === null) return;
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
    // Approval can arrive before transport drainage. Resume only after the
    // exact originating invocation AND its verifier have released ownership.
    await input.record.completion;
    if (input.signal.aborted || controlEpoch() !== originalControlEpoch) return;
    if (input.goalId) {
      const current = getLongRunByGoalId(input.goalId);
      if (getChat(input.chatId)?.goalId !== input.goalId || !current
        || ["paused", "pausing", "cancelling", "cancelled", "completed", "failed", "blocked"].includes(current.status)) return;
    }
    try {
      await input.record.mainLifetime?.afterSettled(() => {
        if (input.signal.aborted || controlEpoch() !== originalControlEpoch || this.activeChatIds().includes(input.chatId)) return;
        const successorRunId = randomUUID();
        this.start(permissionEscalationContinuationRequest({
          runId: successorRunId,
          chatId: input.chatId,
          oneMode: input.oneMode,
          locale: input.locale,
        }), undefined, undefined, undefined, undefined,
          input.record.mainLifetime?.successor(input.chatId, successorRunId));
      });
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
          reason: record.controller.signal.reason instanceof Error && ["app_closed", "app_shutdown", "update_restart"].includes(record.controller.signal.reason.message)
            ? "app_closed" : "user" });
        if (next.status === "cancelled") {
          completeChatGoalContract(next.goalId, "cancelled");
          if (getChat(record.chatId)?.goalId === next.goalId) setChatGoalBinding(record.chatId, null);
        }
      }
    } catch { /* Requested stop remains durable and non-admitting. */ }
  }

  /** Main owns stop intent before aborting any native work. The identity guard
   * prevents a stale control from stopping a replacement goal in this chat. */
  pauseGoal(chatId: string, expectedGoalId: string): void {
    this.stopGoal(chatId, expectedGoalId, "pause");
  }

  deleteGoal(chatId: string, expectedGoalId: string): void {
    this.stopGoal(chatId, expectedGoalId, "delete");
  }

  private stopGoal(chatId: string, expectedGoalId: string, action: "pause" | "delete"): void {
    let chat: ReturnType<typeof getChat>, run: ReturnType<typeof getLongRunByGoalId>;
    try { chat = getChat(chatId); run = getLongRunByGoalId(expectedGoalId); }
    catch (error) {
      // Reads may fail before durable pause can begin. Abort only the exact
      // canonical owners already sealed by this Main process, never a raw ID.
      const known = new Map([...this.browserLoginWaitingRuns, ...this.settlingRuns, ...this.pendingGoalVerifications, ...this.activeRuns.entries()]);
      stopKnownAutomationGoalRuns(expectedGoalId, chatId, [...known.values()]
        .flatMap((record) => record.goalStopOwner ? [record.goalStopOwner] : []));
      for (const [runId, record] of known) {
        if (nativeGoalStopOwnerMatches(record.goalStopOwner, expectedGoalId, chatId)) {
          this.cancelWithReason(runId, new Error(action === "pause" ? "goal_paused_by_user" : "goal_deleted_by_user"));
        }
      }
      throw error;
    }
    if (!expectedGoalId || chat?.goalId !== expectedGoalId) throw new Error("goal_control_binding_changed");
    if (run && (run.rootChatId !== chatId || run.surface === "science")) throw new Error("goal_control_scope_mismatch");
    if (!run && action === "pause") throw new Error("goal_control_not_started");
    // Actual scheduler controllers keep their immutable creation owner even if
    // their row/receipt has since changed. Fence admissions before persistence.
    const automationStops = run ? snapshotAutomationGoalRunStops({ goalId: expectedGoalId,
      rootChatId: chatId, longRunId: run.id, receiptCursor: run.lastEventSeq }) : undefined;
    const records = [...new Map([...this.browserLoginWaitingRuns, ...this.settlingRuns, ...this.pendingGoalVerifications, ...this.activeRuns.entries()])]
      .filter(([, record]) => record.chatId === chatId && (!record.automaticGoalId || record.automaticGoalId === expectedGoalId));
    try {
      getDb().transaction(() => {
        if (getChat(chatId)?.goalId !== expectedGoalId) throw new Error("goal_control_binding_changed");
        // This legacy lookup only nominates a row. Verify its Main creation
        // owner before changing it; following this Goal's folder is insufficient.
        const continuation = findAutomationByGoalId(expectedGoalId);
        let ownedContinuation = false;
        if (continuation && run) {
          try { ownedContinuation = currentAutomationGoalExecutionOwnerMatches(continuation.id,
            expectedGoalId, chatId, run.id); } catch { /* Existing owned controllers still stop in finally. */ }
        }
        if (run) {
          appendLongRunEvent({ runId: run.id, kind: "run.user_control", actorKind: "user",
            payload: { action, chatId, goalId: expectedGoalId } });
          let current = getLongRunByGoalId(expectedGoalId)!;
          if (!["completed", "failed", "cancelled"].includes(current.status)) {
            if (action === "delete") {
              if (!["draft", "paused", "blocked", "cancelling"].includes(current.status)) {
                current = transitionLongRun({ runId: current.id, to: "cancelling", actorKind: "user", reason: "user", expectedVersion: current.version });
              }
              transitionLongRun({ runId: current.id, to: "cancelled", actorKind: "user", reason: "user", expectedVersion: current.version });
            } else if (!["paused", "cancelling"].includes(current.status)) {
              if (["draft", "queued", "blocked"].includes(current.status)) {
                transitionLongRun({ runId: current.id, to: "paused", actorKind: "user", reason: "user", expectedVersion: current.version });
              } else {
                current = transitionLongRun({ runId: current.id, to: "pausing", actorKind: "user", reason: "user", expectedVersion: current.version });
                if (!records.length) transitionLongRun({ runId: current.id, to: "paused", actorKind: "host", reason: "user", expectedVersion: current.version });
              }
            }
          }
        }
        if (continuation?.enabled && (ownedContinuation || automationStops?.ownsAutomation(continuation.id, continuation.createdAt))) {
          toggleAutomation(continuation.id, false);
        }
        for (const owned of automationStops?.automations ?? []) {
          if (owned.automationId !== continuation?.id && automationStops?.ownsAutomation(owned.automationId, owned.createdAt)) {
            toggleAutomation(owned.automationId, false);
          }
        }
        cancelQueuedSteersForChat(chatId, false, "goal-stopped");
        cancelQueuedOnePreflightSteersForChat(chatId);
        if (action === "delete") {
          completeChatGoalContract(expectedGoalId, "cancelled");
          setChatGoalBinding(chatId, null);
          setChatContinuousMode(chatId, false);
        }
      })();
    } finally {
      // Even a storage failure must not keep the live invocation running.
      automationStops?.stop();
      this.steerQueues.delete(chatId);
      for (const [runId, record] of records) {
        record.automaticGoalId ??= run?.goalId;
        this.cancelWithReason(runId, new Error(action === "pause" ? "goal_paused_by_user" : "goal_deleted_by_user"));
      }
      if (action === "delete") stopWorkspacePreviewsForTaskScope(expectedGoalId);
    }
  }

  cancel(runId: string): "requested" | "already-requested" | "not-found" {
    return this.cancelWithReason(runId, new Error(STOPPED_BY_USER));
  }

  /** Native owner transport uses the held memory identity for unconditional
   * Stop even if the durable store cannot be read during shutdown. */
  liveRunOwner(runId: string): InvocationRunOwner | null {
    const record = this.activeRuns.get(runId) ?? this.pendingGoalVerifications.get(runId)
      ?? this.settlingRuns.get(runId) ?? this.browserLoginWaitingRuns.get(runId);
    return record?.ownerLease ? { ...record.ownerLease } : null;
  }

  private cancelWithReason(
    runId: string,
    reason: Error,
  ): "requested" | "already-requested" | "not-found" {
    const ingress=this.nativeIngress.get(runId);
    if(ingress && (!ingress.handedOff || (!this.nativePreparing.has(runId) && !this.activeRuns.get(runId) && !this.pendingGoalVerifications.has(runId) && !this.settlingRuns.has(runId) && !this.browserLoginWaitingRuns.has(runId)))){
      ingress.lifetime.closeAdmission();const already=ingress.controller.signal.aborted;
      if(!already) ingress.controller.abort(reason);
      this.cancelNativeIngress(ingress);
      return already?"already-requested":"requested";
    }
    const preparing = this.nativePreparing.get(runId);
    if (preparing) {
      preparing.preparationLifetime.closeAdmission();
      const already = preparing.controller.signal.aborted;
      if (!already) {
        preparing.controller.abort(reason);
        try { const pending = Promise.resolve(preparing.port.cancel(preparing.binding)); pending.catch(() => {}); this.nativeCancellationObservations.add(pending); preparing.retained.add(pending); } catch { /* actual awaited claim still owns the barrier */ }
      }
      if (!this.activeRuns.get(runId)) return already ? "already-requested" : "requested";
    }
    const record = this.activeRuns.get(runId) ?? this.pendingGoalVerifications.get(runId) ?? this.settlingRuns.get(runId) ?? this.browserLoginWaitingRuns.get(runId);
    // Store refusal must never block the actual AbortController or child stop.
    if (record?.ownerLease) {
      try { invocationRunOwners.markSettling(record.ownerLease); } catch { /* Stop remains unconditional. */ }
    }
    if (record?.automaticGoalId && !["goal_paused_by_user", "goal_deleted_by_user"].includes(reason.message)) {
      try {
        const goal = getLongRunByGoalId(record.automaticGoalId);
        if (goal && !["completed", "failed", "cancelled", "cancelling", "paused"].includes(goal.status)) {









          if (reason.message === STOPPED_BY_USER) {
            appendLongRunEvent({ runId: goal.id, kind: "run.user_control", actorKind: "user",
              payload: { action: "pause", source: "turn-stop", chatId: record.chatId, goalId: goal.goalId, invocationRunId: runId } });
          }
          const explicitStop = reason.message === STOPPED_BY_USER || isOwnerGoalStopCause(reason.message);
          const shutdown = reason.message === "app_closed" || reason.message === "app_shutdown" || reason.message === "update_restart";
          if (explicitStop || shutdown) {
            transitionLongRun({ runId: goal.id, to: "pausing", actorKind: explicitStop ? "user" : "host",
              reason: explicitStop ? "user" : "app_closed" });
          } else {
            appendLongRunEvent({ runId: goal.id, kind: "run.internal_abort_deferred", actorKind: "host",
              payload: { invocationRunId: runId, reason: reason.message } });
          }
        }
      } catch { /* Always abort the actual invocation even if persistence fails. */ }
    }
    if (this.browserLoginWaitingRuns.has(runId)) {
      const preserveWaiting = reason.message === "app_closed" || reason.message === "app_shutdown" || reason.message === "update_restart";
      if (!preserveWaiting && record?.chatId) {
        this.clearQueuedDirectionsForStop(record,reason,runId);
      }
      this.cancelParkedBrowserLoginWait(runId, preserveWaiting ? "host_restart" : reason.message, !preserveWaiting);
      if (record?.automaticGoalId) this.settleAutomaticGoalInterruption(record);
      return "requested";
    }
    // Stop is terminal for the visible work item: it also clears directions
    // queued behind the active turn. Steering itself never calls cancel.
    if (record?.chatId) {
      this.clearQueuedDirectionsForStop(record,reason,runId);
    }
    let result = this.activeRuns.requestCancelWithReason(runId, reason);
    if (result === "not-found" && record && (this.pendingGoalVerifications.has(runId) || this.settlingRuns.has(runId))) {
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

  /**
   * What a stop withdraws: the directions queued behind the stopped turn (next-turn queue, preflight) and the owner
   * directions the stopped turn itself had not taken yet (current-turn rows, settled rejected owner_control_run_stopped),
   * in one transaction. Two kinds of stop withdraw nothing (D5):
   *  - closing the app or restarting for an update: the queued directions stay durable, restart recovery starts them
   *    (recoverQueuedSteers), and the stopped turn's untaken directions are carried to the next turn
   *    (carryUndeliveredOwnerFollowups). Before, every app exit cancelled them as run-stopped, then the drain of the
   *    settling run would have refused them as desktop_execution_admission_closed.
   *  - a background run (an effect observation reaching its time budget): it is not the chat's visible turn.
   */
  private clearQueuedDirectionsForStop(record:RunRecord,reason:Error,runId:string):void {
    if (record.background || HOST_SHUTDOWN_ABORT_CAUSES.has(reason.message)) return;
    this.steerQueues.delete(record.chatId);
    const preserveReports=reason.message==="one_team_report_owner_changed" && Boolean(record.oneTeamReportCustody);
    try {getDb().transaction(()=>{
      if(preserveReports)for(const row of listRecoverableQueuedSteers(record.chatId)){
        if(row.request.oneTeamReportTurn===true && row.status==="queued" && !row.drainedRunId){
          // This is a hold, never a new admission. Auth restoration rechecks
          // the exact original custody; stronger uncertainty holds stay held.
          holdQueuedSteerForRecovery(row.id,"one-team-report-owner-unbound");
        }
      }
      cancelQueuedSteersForChat(record.chatId,preserveReports,"run-stopped");
      cancelQueuedOnePreflightSteersForChat(record.chatId);
      rejectQueuedCurrentTurnSteersForStop(record.chatId, runId);
    })();}catch{ /* Store refusal must never keep the original run alive. */ }
  }

  /** Interrupt an interactive turn only after its replacement direction is durable. */
  private interruptForSteer(runId: string, record: RunRecord): boolean {
    const locale = pickLocale(record.request);
    const reason = new Error(locale === "ko"
        ? "새 지시를 반영하기 위해 이전 실행을 중단했습니다."
        : "The previous run was interrupted to apply the new direction.");
    let result = this.activeRuns.requestCancelWithReason(runId, reason);
    if (result === "not-found" && this.settlingRuns.get(runId) === record) {
      result = record.controller.signal.aborted ? "already-requested" : "requested";
      record.cancelRequestedAt ??= new Date().toISOString();
      record.controller.abort(reason);
    }
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
  /** Main-only coordination into an existing run. Keep its sealed workspace and execution contract;
   * a supervisor's new direction cannot manufacture a binding or replay a consumed preflight. */
  steerFromSupervisor(
    req: McpInvocationRequest,
    expectedRunId: string,
    mainAdmission?: MainInvocationAdmission,
  ): InvocationSteerResult {
    const record = this.activeRuns.get(expectedRunId) ?? this.settlingRuns.get(expectedRunId)
      ?? this.browserLoginWaitingRuns.get(expectedRunId);
    if (!record || record.background || record.chatId !== req.chatId) {
      throw new Error("supervisor_steering_target_stale");
    }
    const source = record.request;
    return this.steer({
      ...req,
      permissions: source.permissions,
      planMode: source.planMode,
      oneMode: source.oneMode,
      onePermissionMode: source.onePermissionMode,
      runtimeSelection: source.runtimeSelection,
      promptOrigin: "system",
      steeringMode: "queue",
    }, expectedRunId, record.workspaceBinding, record.executionContext, mainAdmission);
  }

  currentTurn(chatId: string): { runId: string } | null {
    for (const [runId, record] of this.activeRuns.entries()) {
      if (record.chatId === chatId && !record.background && !record.controller.signal.aborted
        && !this.pendingGoalVerifications.has(runId)) return { runId };
    }
    return null;
  }

  currentTurnSteerReceipt(chatId: string, intentId: string): InvocationCurrentTurnSteerReceipt | null {
    const row = getCurrentTurnSteer(chatId, intentId);
    if (row && (row.status === "queued" || row.status === "dispatching")) {
      const owner = invocationRunOwners.getRunOwner(chatId, row.runId);
      if (owner && owner.ownerId !== invocationProcessOwner().ownerId) {
        throw new Error("invocation_owner_unavailable");
      }
    }
    const record = row ? this.activeRuns.get(row.runId) : undefined;
    if (row?.status === "queued" && (!record || record.chatId !== chatId || record.controller.signal.aborted
      || this.pendingGoalVerifications.has(row.runId))) {
      return settleCurrentTurnSteer(chatId, intentId, "rejected", "owner_control_run_settled");
    }
    if (row?.status === "dispatching" && !this.currentTurnSteerDispatches.has(intentId)) {
      return settleCurrentTurnSteer(chatId, intentId, "uncertain", "native_steer_dispatch_interrupted");
    }
    if (row?.status === "queued" && !row.code && !record?.nativeTurnController) return { ...row,
      code: record?.nativeControlState?.code ?? "native_control_pending" };
    return row;
  }

  /** The original native service source must still own this exact input and controller. */
  private nativeOwnerTextTarget(binding: NativeOwnerTextBinding): AbortController | undefined {
    const pending = this.nativeIngress.get(binding.runId);
    if (pending) {
      const source = pending.source.binding;
      if (source.chatId !== binding.chatId || source.inputDigest !== binding.inputDigest) throw Object.assign(new Error("native_owner_text_binding_changed"),{code:"native_owner_text_binding_changed"});
      if (!pending.handedOff) { try { pending.source.assertCurrent(); } catch { return undefined; } }
      return pending.controller;
    }
    const preparation = this.nativePreparing.get(binding.runId);
    const record = this.activeRuns.get(binding.runId) ?? this.settlingRuns.get(binding.runId);
    const admission = getInvocationAdmission(binding.runId);
    if (!admission || admission.chatId !== binding.chatId || admission.inputDigest !== binding.inputDigest) throw Object.assign(new Error("native_owner_text_binding_changed"),{code:"native_owner_text_binding_changed"});
    if (preparation) {
      if (preparation.binding.chatId !== binding.chatId || preparation.binding.admission.ownerProcessEpoch !== admission.ownerProcessEpoch) throw Object.assign(new Error("native_owner_text_binding_changed"),{code:"native_owner_text_binding_changed"});
      return preparation.controller;
    }
    if (!record || record.background || record.chatId !== binding.chatId || !record.ownerLease
      || record.ownerLease.ownerKind !== "daemon" || record.ownerLease.ownerId !== admission.ownerProcessEpoch) return undefined;
    const owner = invocationRunOwners.getRunOwner(binding.chatId,binding.runId);
    if (!owner || owner.state === "released" || owner.leaseId !== record.ownerLease.leaseId) return undefined;
    assertInvocationRunOwner(record.ownerLease);
    return record.controller;
  }

  nativeOwnerTextCompatible(binding: NativeOwnerTextBinding, choices: unknown): boolean {
    const controller = this.nativeOwnerTextTarget(binding);
    if (!controller || controller.signal.aborted) throw Object.assign(new Error("native_owner_text_parent_unavailable"),{code:"native_owner_text_parent_unavailable"});
    const preparation = this.nativePreparing.get(binding.runId), record = this.activeRuns.get(binding.runId);
    const original = preparation ? canonicalInvocationRequestJson(nativeOwnerTextChoices(preparation.request) as unknown as McpInvocationRequest) : record?.nativeOwnerTextChoices;
    if (!original) throw Object.assign(new Error("native_owner_text_context_unavailable"),{code:"native_owner_text_context_unavailable"});
    if (!choices || typeof choices !== "object" || Array.isArray(choices) || (Object.getPrototypeOf(choices) !== Object.prototype && Object.getPrototypeOf(choices) !== null)
      || Object.keys(choices).some(key => NATIVE_OWNER_TEXT_CONTEXT_OMITTED.includes(key))) return false;
    try { return canonicalInvocationRequestJson(choices as McpInvocationRequest) === original; } catch { return false; }
  }

  private nativeOwnerTextRows(binding: NativeOwnerTextBinding) {
    return (getDb().prepare(`SELECT * FROM invocation_current_turn_steers WHERE chat_id = ? AND run_id = ? ORDER BY rowid`)
      .all(binding.chatId, binding.runId) as Array<{intent_id:string;prompt_text:string;prompt_hash:string;message_id:string;binding_json:string;status:InvocationCurrentTurnSteerReceipt["status"];code:string|null;created_at:string}>)
      .filter(row => { const saved = JSON.parse(row.binding_json); return saved.source === "native-owner-text" && saved.inputDigest === binding.inputDigest; });
  }

  nativeOwnerTextReceipt(binding: NativeOwnerTextBinding, intentId: string): NativeOwnerTextReceipt | null {
    const row = this.nativeOwnerTextRows(binding).find(item => item.intent_id === intentId);
    if (!row) {
      if (getDb().prepare("SELECT intent_id FROM invocation_current_turn_steers WHERE intent_id = ?").get(intentId)) throw Object.assign(new Error("native_owner_text_binding_changed"),{code:"native_owner_text_binding_changed"});
      return null;
    }
    const saved = JSON.parse(row.binding_json);
    let receipt = getCurrentTurnSteer(binding.chatId, intentId)!;
    // A cancelled/unknown old source never becomes a next-run dispatch opportunity.
    const target = this.nativeOwnerTextTarget(binding);
    if (receipt.status === "queued" && (!target || target.signal.aborted)) receipt = settleCurrentTurnSteer(binding.chatId, intentId, "uncertain", "native_owner_text_held");
    if (receipt.status === "dispatching" && !this.currentTurnSteerDispatches.has(intentId)) receipt = settleCurrentTurnSteer(binding.chatId, intentId, "uncertain", "native_steer_dispatch_interrupted");
    const position = this.nativeOwnerTextRows(binding).filter(item => item.status === "queued" || item.status === "uncertain").findIndex(item => item.intent_id === intentId);
    if (receipt.status === "queued" && !receipt.code) {
      if (saved.deliveryKind === "queue") receipt = { ...receipt, code: "native_control_next_boundary" };
      else if (!this.activeRuns.get(binding.runId)?.nativeTurnController) receipt = { ...receipt,
        code: this.activeRuns.get(binding.runId)?.nativeControlState?.code ?? "native_control_pending" };
    }
    const withdrawn = receipt.code === "native_owner_text_withdrawn";
    return { version:"agentlas.native-owner-text.v1", chatId:binding.chatId,runId:binding.runId,inputDigest:binding.inputDigest, intentId, deliveryKind:saved.requestedMode,
      promptHash:receipt.promptHash,messageId:receipt.messageId,sourceStatus:receipt.status,...(receipt.code ? {code:receipt.code}:{}),
      result:{accepted:true,chatId:binding.chatId,intentId,queued:receipt.status === "queued" || receipt.status === "dispatching",
        interruptsCurrent:saved.requestedMode === "interrupt",activeRunId:binding.runId,queuedRequestId:`native-owner:${intentId}`,promptHash:receipt.promptHash,
        ...(position >= 0 ? {position:position+1}:{}),...(receipt.status === "applied" ? {runId:binding.runId}:{}),
        status:withdrawn ? "cancelled" : receipt.status === "applied" ? "started" : receipt.status === "queued" ? "queued" : receipt.status === "dispatching" ? "draining" : "held"} };
  }

  /** Synchronous durable intake, including original source registration before payload awaits. */
  nativeOwnerText(input: NativeOwnerTextInput): NativeOwnerTextReceipt {
    if (!["current","queue","interrupt"].includes(input.deliveryKind)) throw Object.assign(new Error("native_owner_text_kind_invalid"),{code:"native_owner_text_kind_invalid"});
    const request = {chatId:input.chatId,expectedRunId:input.runId,intentId:input.intentId,text:input.text};
    if (typeof input.chatId !== "string" || !input.chatId || typeof input.runId !== "string" || !input.runId
      || typeof input.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.inputDigest)
      || typeof input.intentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.intentId)
      || typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text,"utf8") > 200_000) {
      throw Object.assign(new Error("native_owner_text_invalid"),{code:"native_owner_text_invalid"});
    }
    const existing = getDb().prepare("SELECT chat_id,run_id,prompt_text FROM invocation_current_turn_steers WHERE intent_id = ?").get(input.intentId) as {chat_id:string;run_id:string;prompt_text:string}|undefined;
    if (existing && (existing.chat_id !== input.chatId || existing.run_id !== input.runId || existing.prompt_text !== input.text)) {
      throw Object.assign(new Error("native_owner_text_identity_conflict"),{code:"native_owner_text_identity_conflict"});
    }
    if (existing) {
      const prior = this.nativeOwnerTextRows(input).find(row => row.intent_id === input.intentId);
      if (!prior || JSON.parse(prior.binding_json).requestedMode !== input.deliveryKind) throw Object.assign(new Error("native_owner_text_identity_conflict"),{code:"native_owner_text_identity_conflict"});
      return this.nativeOwnerTextReceipt(input,input.intentId)!;
    }
    const controller = this.nativeOwnerTextTarget(input);
    if (!controller || controller.signal.aborted || this.pendingGoalVerifications.has(input.runId)) throw Object.assign(new Error("native_owner_text_parent_unavailable"),{code:"native_owner_text_parent_unavailable"});
    if (countPendingCurrentTurnSteers(input.chatId,input.runId) >= 64) throw Object.assign(new Error("invocation_current_turn_steer_limit"),{code:"invocation_current_turn_steer_limit"});
    const claimed = claimCurrentTurnSteer(request,{source:"native-owner-text",chatId:input.chatId,runId:input.runId,inputDigest:input.inputDigest,
      requestedMode:input.deliveryKind,deliveryKind:input.deliveryKind === "current" ? "current" : "queue"});
    this.reviewCurrentTurnDirection(input.chatId, input.runId, claimed.messageId, this.activeRuns.get(input.runId) ?? this.settlingRuns.get(input.runId));
    if (input.deliveryKind === "current" && !this.activeRuns.get(input.runId)?.nativeTurnController) {
      // Stays queued: the episode end or the next turn delivers it (see the native control observer above).
    } else if (input.deliveryKind === "interrupt") {
      this.cancel(input.runId); // unconditional Stop; no source-safe successor is manufactured.
      settleCurrentTurnSteer(input.chatId,input.intentId,"uncertain","native_owner_text_interrupt_held");
    } else if (input.deliveryKind === "current") {
      const record = this.activeRuns.get(input.runId); if (record) this.deliverNativeOwnerControls(input.runId,record);
    }
    const receipt = this.nativeOwnerTextReceipt(input,input.intentId)!;
    const record = this.activeRuns.get(input.runId);
    if (record && receipt.sourceStatus === "queued") this.publishQueuedNativeBoundaryNotice(input.runId, record, input.intentId);
    return receipt;
  }

  nativeOwnerTextUnsteer(binding: NativeOwnerTextBinding, position: number, text: string): boolean {
    if (!Number.isSafeInteger(position) || position < 1 || typeof text !== "string") return false;
    const row = this.nativeOwnerTextRows(binding).filter(item => item.status === "queued" || item.status === "uncertain")[position-1];
    if (!row || row.status !== "queued" || row.prompt_text !== text) return false;
    settleCurrentTurnSteer(binding.chatId,row.intent_id,"rejected","native_owner_text_withdrawn"); return true;
  }

  nativeOwnerTextAttach(binding: NativeOwnerTextBinding, includeEvents: boolean) {
    const record = this.activeRuns.get(binding.runId) ?? this.settlingRuns.get(binding.runId);
    const pending = this.nativeIngress.get(binding.runId) ?? this.nativePreparing.get(binding.runId);
    if (!record && !pending) return null;
    const queue = this.nativeOwnerTextRows(binding).filter(row => row.status === "queued" || row.status === "uncertain");
    return {runId:binding.runId,events:includeEvents ? record?.events ?? [] : [],startedAt:record?.startedAt ?? getInvocationAdmission(binding.runId)?.pendingAt ?? null,
      queuedSteers:queue.map((row,index)=>({id:`native-owner:${row.intent_id}`,text:row.prompt_text,queuedAt:row.created_at,position:index+1,
        ...(row.status === "uncertain" ? {recoveryState:"held",recoveryReason:"original-run-effect-boundary-unconfirmed"}: {})}))};
  }

  nativeOwnerTextRecovery(binding: NativeOwnerTextBinding): InvocationSteerRecovery[] {
    // Read each exact receipt first so stopped/settled queue rows are explicitly held.
    for (const row of this.nativeOwnerTextRows(binding)) this.nativeOwnerTextReceipt(binding,row.intent_id);
    return this.nativeOwnerTextRows(binding).filter(row=>row.status === "uncertain").map(row=>({id:`native-owner:${row.intent_id}`,chatId:binding.chatId,
      originalRunId:binding.runId,promptText:row.prompt_text,promptHash:row.prompt_hash,queuedAt:row.created_at,reason:"original-run-effect-boundary-unconfirmed"}));
  }

  /**
   * A direction typed into a running turn is reviewed against the chat's Goal like a turn's own prompt (D2), in the
   * process that owns the run (Desktop, the background service; the phone's text arrives through the same two). Never
   * delays or refuses the direction.
   */
  private reviewCurrentTurnDirection(chatId: string, runId: string, messageId: string | undefined, record?: RunRecord): void {
    try {
      if (!messageId) return;
      const goalId = reviewableChatGoalId(chatId, record?.automaticGoalId);
      if (!goalId) return;
      const preparing = record ? undefined : this.nativePreparing.get(runId);
      const notReviewed = record ? ownerDirectionReviewSkip(record.request, record.workspaceBinding, record.executionContext)
        : preparing ? ownerDirectionReviewSkip(preparing.request, undefined, undefined) : null;
      reviewOwnerDirectionForGoal({ runId, chatId, goalId, sourceMessageId: messageId, notReviewed, via: "current-turn" });
    } catch (error) {
      console.warn(`[goal-amendment] current-turn direction not reviewed run=${runId} code=${innermostTypedCode(error) ?? "none"}`);
    }
  }

  /** Durable local intake returns promptly. Only the exact native ACK marks it applied. */
  steerCurrentTurn(input: InvocationCurrentTurnSteerRequest): InvocationCurrentTurnSteerReceipt {
    if (existingCurrentTurnSteer(input)) return this.currentTurnSteerReceipt(input.chatId, input.intentId)!;
    const record = this.activeRuns.get(input.expectedRunId);
    if (!record || record.background || record.chatId !== input.chatId || record.controller.signal.aborted
      || this.pendingGoalVerifications.has(input.expectedRunId)) {
      throw new Error("invocation_current_turn_unavailable");
    }
    if (record.ownerLease) assertInvocationRunOwner(record.ownerLease);
    if (countPendingCurrentTurnSteers(input.chatId, input.expectedRunId) >= 64) throw new Error("invocation_current_turn_steer_limit");
    const intake = claimCurrentTurnSteer(input, { chatId: record.chatId, runId: input.expectedRunId,
      ...(record.ownerLease ? { ownerId: record.ownerLease.ownerId, leaseId: record.ownerLease.leaseId } : {}),
      agentId: record.actualAgentId, workspaceBinding: record.workspaceBinding,
      permission: record.request.permissions, runtime: record.request.runtimeSelection });
    this.reviewCurrentTurnDirection(input.chatId, input.expectedRunId, intake.messageId, record);
    this.deliverNativeOwnerControls(input.expectedRunId, record);
    this.publishQueuedNativeBoundaryNotice(input.expectedRunId, record, input.intentId);
    return intake.code || record.nativeTurnController ? intake : { ...intake,
      code: record.nativeControlState?.code ?? "native_control_pending" };
  }

  /**
   * Where a queued turn waits: an owner turn goes ahead of host-written (system) turns already queued in the same chat,
   * keeping the order among owner turns and among system turns. Production 2026-10-18, Yotube room 8f3e09ee: the owner's
   * 04:37Z direction was carried at 05:34Z behind a teammate relay queued at 04:44Z; the relay ran first as a read-only
   * turn for 13 minutes and the direction started only at 05:47Z. A head a drain may already have taken is never
   * displaced: only while the chat's run is active (no drain can be pending) may the new turn take the head.
   */
  private enqueueSteer(chatId: string, queue: QueuedSteer[], item: QueuedSteer): void {
    if (item.request.promptOrigin === "system") { queue.push(item); return; }
    const from = this.activeChatIds().includes(chatId) ? 0 : 1;
    const at = queue.findIndex((queued, index) => index >= from && queued.request.promptOrigin === "system");
    if (at < 0) queue.push(item); else queue.splice(at, 0, item);
  }

  /**
   * When a run ends without the owner stopping it, the owner directions it never dispatched become the chat's next turn
   * (carried-owner-followups.ts: production 2026-10-17, a team run left the owner's style direction queued for 81
   * minutes and then refused it, so it was lost). A stopped run keeps them refused: the stop withdrew the turn
   * (clearQueuedDirectionsForStop settles them owner_control_run_stopped). Closing the app or restarting for an update is
   * not the owner's stop: those directions are carried too, and restart recovery starts the carried turn (D5).
   */
  private carryUndeliveredOwnerFollowups(runId: string, record: RunRecord): void {
    const reason = record.controller.signal.reason;
    const hostShutdown = reason instanceof Error && HOST_SHUTDOWN_ABORT_CAUSES.has(reason.message);
    if (record.background || (record.controller.signal.aborted && !record.steeringInterruptRequested && !hostShutdown)) return;
    try {
      // An ordinary owner turn: the room resolves its workspace and execution context afresh, as for a typed message.
      const carried = carryOwnerFollowupsToNextTurn({ chatId: record.chatId, runId, request: record.request });
      if (!carried) return;
      const queue = this.steerQueues.get(record.chatId) ?? [];
      if (!queue.some((queued) => queued.id === carried.id)) this.enqueueSteer(record.chatId, queue, queuedSteerFromDurable(carried));
      this.steerQueues.set(record.chatId, queue);
      tryRecordRunEvent({ runId, chatId: record.chatId, agentId: record.actualAgentId, kind: "owner_followup_carried",
        payload: { queuedSteerId: carried.id } });
      try { emitDesktopStoreChange({ entity: "chat", id: record.chatId }); } catch { /* the queued turn is durable */ }
    } catch (error) {
      // The rows stay queued and the receipt read settles them as before; nothing is half-carried (one transaction).
      console.warn("[invocation] owner follow-up carry failed:", error instanceof Error ? error.message : String(error));
    }
  }

  /** A delivery notice describes an admitted queued intent, never driver readiness or an effect. */
  private publishQueuedNativeBoundaryNotice(runId: string, record: RunRecord, intentId?: string): void {
    try {
      if (this.activeRuns.get(runId) !== record || record.background || record.controller.signal.aborted
        || this.pendingGoalVerifications.has(runId) || record.nativeTurnController) return;
      const observation = record.nativeControlState;
      const state = validatedRunnerNativeControlState(observation);
      if (!state || state.phase !== "unavailable") return;
      if (record.ownerLease) assertInvocationRunOwner(record.ownerLease);
      const rows = getDb().prepare(`SELECT intent_id,binding_json FROM invocation_current_turn_steers
        WHERE chat_id = ? AND run_id = ? AND status = 'queued' ORDER BY rowid`).all(record.chatId, runId) as Array<{intent_id:string;binding_json:string}>;
      for (const row of rows) {
        if (intentId !== undefined && row.intent_id !== intentId || record.nativeBoundaryNoticeIntents?.has(row.intent_id)) continue;
        const binding = JSON.parse(row.binding_json);
        if (binding.chatId !== record.chatId || binding.runId !== runId
          || binding.deliveryKind !== undefined && binding.deliveryKind !== "queue" && binding.deliveryKind !== "current") continue;
        if (binding.source === "native-owner-text") {
          const admission = getInvocationAdmission(runId);
          if (!admission || binding.inputDigest !== admission.inputDigest || this.nativeOwnerTextTarget(binding) !== record.controller) continue;
        }
        // Re-read after source checks. Never describe a changed/uncertain dispatch as next-boundary delivery.
        if (this.activeRuns.get(runId) !== record || record.controller.signal.aborted || record.nativeTurnController
          || this.pendingGoalVerifications.has(runId) || record.nativeControlState !== observation
          || getCurrentTurnSteer(record.chatId,row.intent_id)?.status !== "queued") continue;
        (record.nativeBoundaryNoticeIntents ??= new Set()).add(row.intent_id);
        const ko = "추가 요청은 이번 답변이 끝난 뒤 처리 대기 중입니다.";
        const en = "Your follow-up is queued until this response ends.";
        this.publishRunEvent(record, {runId,chatId:record.chatId,event:{kind:"notice",notice:{level:"info",code:state.code,
          message:pickLocale(record.request) === "ko" ? ko : en, i18n:{ko,en}}}});
      }
    } catch { /* Notice cannot change model admission, retry credits, authority or an intent receipt. */ }
  }

  private ownerControlInbox(runId: string, record: RunRecord): RunnerOwnerControlInbox {
    const claimedIds = new Set<string>();
    return {
      take: (phase) => {
        if (record.controller.signal.aborted || this.activeRuns.get(runId) !== record) return [];
        if (record.ownerLease) assertInvocationRunOwner(record.ownerLease);
        const directions = takeCurrentTurnSteers(record.chatId, runId, phase);
        for (const direction of directions) {
          claimedIds.add(direction.intentId);
          this.currentTurnSteerDispatches.add(direction.intentId);
        }
        return directions;
      },
      settle: (intentIds, status, code) => {
        // Validate the whole batch before writing any receipt. A late callback
        // from this run cannot settle a newer run in the same conversation.
        if (intentIds.some(intentId => !claimedIds.has(intentId)
          || getCurrentTurnSteer(record.chatId, intentId)?.runId !== runId)) {
          throw new Error("owner_control_receipt_identity_mismatch");
        }
        for (const intentId of intentIds) {
          settleCurrentTurnSteer(record.chatId, intentId, status, code);
          claimedIds.delete(intentId);
          this.currentTurnSteerDispatches.delete(intentId);
          if (status === "applied") tryRecordRunEvent({ runId, chatId: record.chatId,
            agentId: record.actualAgentId, kind: USER_STEERING_EVENT_KIND });
        }
      },
    };
  }

  /** A native adapter can consume the same harness inbox during its active episode. */
  private deliverNativeOwnerControls(runId: string, record: RunRecord): void {
    const nativeController = record.nativeTurnController;
    if (!nativeController || record.controller.signal.aborted) return;
    const inbox = this.ownerControlInbox(runId, record);
    for (const direction of inbox.take("current-boundary")) {
      void Promise.resolve().then(async () => {
        if (record.controller.signal.aborted || record.nativeTurnController !== nativeController
          || this.activeRuns.get(runId) !== record) {
          inbox.settle([direction.intentId], "rejected", "native_turn_stale");
          return;
        }
        const result = await nativeController.steer({ requestId: direction.intentId, text: direction.text,
          expectedThreadId: nativeController.binding.threadId, expectedTurnId: nativeController.binding.turnId });
        inbox.settle([direction.intentId], result.status === "accepted" ? "applied" : result.status,
          result.status === "accepted" ? undefined : result.code);
      }).catch(() => {
        try { inbox.settle([direction.intentId], "uncertain", "native_steer_ack_unknown"); }
        catch { /* A lost settlement remains uncertain and never replays. */ }
      });
    }
  }

  private ownerSteerId(intentId: string): string {
    if (typeof intentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(intentId)) {
      throw new Error("invocation_steer_invalid_intent_id");
    }
    return `owner:${intentId}`;
  }

  private durableSteerReceipt(row: DurableQueuedSteer, intentId?: string): InvocationSteerResult {
    const queue = this.steerQueues.get(row.chatId) ?? [];
    const position = queue.findIndex((item) => item.id === row.id);
    return {
      accepted: true, chatId: row.chatId,
      queued: row.status === "queued" || row.status === "draining",
      interruptsCurrent: false, activeRunId: row.originalRunId,
      queuedRequestId: row.id, promptHash: row.promptHash,
      ...(row.drainedRunId ? { runId: row.drainedRunId } : {}),
      ...(position >= 0 ? { position: position + 1 } : {}),
      ...(intentId ? { intentId } : {}),
      status: row.recoveryState === "held" ? "held" : row.status,
    };
  }

  ownerSteerReceipt(chatId: string, intentId: string): InvocationSteerResult | null {
    if (typeof chatId !== "string" || !chatId) throw new Error("invocation_steer_invalid_chat_id");
    const row = getDurableQueuedSteer(this.ownerSteerId(intentId));
    if (!row) return null;
    if (row.chatId !== chatId) throw new Error("invocation_steer_identity_conflict");
    return this.durableSteerReceipt(row, intentId);
  }

  /** Owner-authored followups have an identity before any provider effect. A retry only reads that identity. */
  steerFromOwner(req: McpInvocationRequest, intentId: string | undefined, mainAdmission?: MainInvocationAdmission): InvocationSteerResult {
    if (intentId === undefined) {
      // Legacy callers retain steer return/throw semantics, with Main's sealed active binding.
      const active = [...new Map([...this.browserLoginWaitingRuns, ...this.settlingRuns, ...this.activeRuns.entries()])]
        .find(([, record]) => !record.background && record.chatId === req.chatId);
      return this.steer(req, active?.[0], active?.[1].workspaceBinding, active?.[1].executionContext, mainAdmission);
    }
    const id = this.ownerSteerId(intentId);
    const request = { ...req, runId: undefined, permissions: effectiveInvocationPermission(req.permissions, req.planMode) };
    const existing = getDurableQueuedSteer(id);
    if (existing) {
      if (existing.chatId !== req.chatId || canonicalQueuedSteerRequest(existing.request) !== canonicalQueuedSteerRequest(request)) {
        throw new Error("invocation_steer_identity_conflict");
      }
      return this.durableSteerReceipt(existing, intentId);
    }
    if (req.oneAttachmentRef) throw new Error("One attachments cannot be added through steering in v1; wait for the active run and send a new request");
    const active = [...this.activeRuns.entries(), ...this.settlingRuns.entries(), ...this.browserLoginWaitingRuns.entries()]
      .find(([, record]) => !record.background && record.chatId === req.chatId);
    if (active) {
      const result = this.steer(request, active[0], active[1].workspaceBinding, active[1].executionContext, mainAdmission, id);
      return { ...result, intentId, status: "queued" };
    }
    // A pending root is not an idle chat. The renderer retains this distinct
    // message in its durable waiting-parent outbox, or uses its preflight submission.
    if (getPendingInvocationAdmissionForChat(req.chatId) || this.activeChatIds().includes(req.chatId)) {
      throw new Error("invocation_steer_parent_pending");
    }
    const runId = randomUUID();
    const row = persistQueuedSteer({ id, chatId: req.chatId, originalRunId: runId, request });
    if (!beginQueuedSteerDrain(id, runId)) throw new Error("invocation_steer_claim_lost");
    try {
      this.start({ ...request, runId }, undefined, undefined, undefined, undefined, mainAdmission, undefined,
        request.oneMode && request.promptOrigin !== "system" ? QUEUED_ONE_ROOM_INHERITANCE : undefined);
      settleQueuedSteer(id, "started");
    } catch (error) {
      // A start refused for a "not ready yet" reason (shared/transient-send-refusal.ts: refused before anything reached a
      // model) is the owner's direction waiting, not an uncertain dispatch: it used to be held for recovery with no retry
      // and sat undelivered (no-dead-end sweep 2026-10-25). It takes the drain queue with backoff under a new run id.
      const code = innermostTypedCode(error) ?? refusalCode(error) ?? null;
      if (isTransientSendRefusalCode(code) && this.queueRefusedIdleSteer(req.chatId, row, runId, error) === "scheduled") {
        return this.durableSteerReceipt(getDurableQueuedSteer(id) ?? row, intentId);
      }
      // A thrown start may already have crossed a provider boundary. Preserve
      // the one planned run ID; never manufacture another on an ACK retry.
      holdQueuedSteerForRecovery(id, "drained-run-start-uncertain");
    }
    return this.durableSteerReceipt(getDurableQueuedSteer(id) ?? row, intentId);
  }

  steer(
    req: McpInvocationRequest,
    expectedRunId?: string,
    workspaceBinding?: InvocationWorkspaceBinding,
    executionContext?: InvocationExecutionContext,
    mainAdmission?: MainInvocationAdmission,
    /** Main-owned idempotency key for a preflight direction. */
    preflightSteerId?: string,
    oneTeamReportSource?: QueuedTeamReportSourceRef,
  ): InvocationSteerResult {
    if (require("../business/company-work-reference").isCompanyWorkReference(getChat(req.chatId)?.agentId)) throw new Error("company_work_steering_denied");
    mainAdmission = takeMainInvocationAdmission(mainAdmission);
    if (req.oneAttachmentRef) {
      throw new Error("One attachments cannot be added through steering in v1; wait for the active run and send a new request");
    }
    const steerRequest = {
      ...req,
      permissions: effectiveInvocationPermission(req.permissions, req.planMode),
    };
    const reportCustody=steerRequest.oneTeamReportTurn===true?captureQueuedTeamReportCustody(steerRequest,oneTeamReportSource):undefined;
    if (oneTeamReportSource && !reportCustody)throw new Error("one_team_report_owner_unbound");
    if (preflightSteerId) {
      const existing = getDurableQueuedSteer(preflightSteerId);
      if (existing) {
        if (existing.chatId !== req.chatId || expectedRunId && existing.originalRunId !== expectedRunId
          || canonicalQueuedSteerRequest(existing.request) !== canonicalQueuedSteerRequest(steerRequest)
          || JSON.stringify(existing.workspaceBinding) !== JSON.stringify(workspaceBinding)
          || JSON.stringify(existing.executionContext) !== JSON.stringify(executionContext)) {
          throw new Error("invocation_steer_identity_conflict");
        }
        return this.durableSteerReceipt(existing);
      }
    }
    // 목표 턴이 끝나고 검증을 기다리는 동안에도 대화는 아직 "진행 중"이다. 그 사이 오너가 보낸 요청은
    // 거절(invocation_cleanup_pending·goal_verification_pending)하지 않고 줄 세워, 검증이 끝나는 즉시 돌린다
    // (Codex 의 Tab 대기열·Claude Code 의 작업 중 입력 대기열과 같은 규칙).
    const active = [...new Map([...this.browserLoginWaitingRuns, ...this.settlingRuns, ...this.activeRuns.entries()])].filter(([, record]) => !record.background).find(([, record]) => record.chatId === req.chatId);
    if (expectedRunId && active?.[0] !== expectedRunId && this.browserLoginWaitingRuns.get(expectedRunId)?.chatId !== req.chatId) {
      throw new Error("Steering target is stale; attach to the current Desktop run and retry");
    }
    if (!active) {
      return {
        accepted: true,
        chatId: req.chatId,
        queued: false,
        interruptsCurrent: false,
        runId: this.start({ ...steerRequest, runId: undefined }, workspaceBinding, executionContext, undefined, undefined, mainAdmission,undefined,undefined,reportCustody).runId,
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
      ...(preflightSteerId ? { id: preflightSteerId } : {}),
      chatId: req.chatId,
      originalRunId: active[0],
      ...(reportCustody ? {oneTeamReportCustody:reportCustody} : {}),
      request: { ...steerRequest, runId: undefined },
      ...(workspaceBinding ? { workspaceBinding: immutableWorkspaceBinding(workspaceBinding) } : {}),
      ...(executionContext ? { executionContext } : {}),
    });
    if (durable.status === "draining" || queue.some((queued) => queued.id === durable.id)) {
      return {
        accepted: true, chatId: req.chatId, queued: durable.status === "queued",
        interruptsCurrent: false, activeRunId: active[0],
        position: Math.max(1, queue.findIndex((queued) => queued.id === durable.id) + 1),
        queuedRequestId: durable.id, promptHash: durable.promptHash,
      };
    }
    this.enqueueSteer(req.chatId, queue, {
      mainAdmission,
      ...(durable.oneTeamReportCustodyJson!==undefined ? {oneTeamReportCustodyJson:durable.oneTeamReportCustodyJson} : {}),
      ...(durable.oneTeamReportCustody ? {oneTeamReportCustody:durable.oneTeamReportCustody} : {}),
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
    // Only an explicit interrupt settles the current process after the next
    // request is durable. Ordinary One/Work input retains additive queue semantics.
    // 검증 중인 결과는 끊지 않는다 — 끝난 턴의 판정을 버리면 목표가 다시 막힌다. 줄만 선다.
    const interruptsCurrent = req.steeringMode === "interrupt" && !this.pendingGoalVerifications.has(active[0])
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
    // The position is the strip's, which lists only the owner's directions (attach). Counting host notices too
    // pointed it at a teammate report whenever one was queued first, and the owner's removal silently failed.
    const target = ownerWrittenSteers(queue)[position - 1];
    if (!target || target.request.userPrompt !== text) return false;
    settleQueuedSteer(target.id, "cancelled", "owner-withdrawn");
    queue.splice(queue.indexOf(target), 1);
    if (!queue.length) this.steerQueues.delete(chatId);
    else this.drainSteerQueue(chatId);
    return true;
  }

  /**
   * Main-owned withdrawal of one queued direction by its durable id (not by the visible position): a host
   * report whose content is already stale (the teammate session was continued, or One read the result
   * itself) must not run as a second report turn. Returns false when it already started or is gone.
   */
  unsteerQueuedById(chatId: string, queuedRequestId: string): boolean {
    const queue = this.steerQueues.get(chatId);
    const index = queue?.findIndex((queued) => queued.id === queuedRequestId) ?? -1;
    if (!queue || index < 0) return false;
    const queued = queue[index];
    const withdrawn = getDb().transaction(() => {
      if (!settleQueuedSteer(queued.id, "cancelled", "host-report-superseded")) return false;
      recordRunEvent({ runId: queued.originalRunId, chatId,
        kind: "invocation_host_steer_withdrawn", sourceEventId: `host-steer-withdrawn:${queued.id}`,
        payload: { queuedRequestId: queued.id, reason: "host_report_superseded" } });
      return true;
    })();
    if (!withdrawn) return false;
    queue.splice(index, 1);
    if (!queue.length) this.steerQueues.delete(chatId);
    else this.drainSteerQueue(chatId);
    return true;
  }

  attach(chatId: string, options?: { includeEvents?: boolean }): InvocationAttachResult | null {
    let found: InvocationAttachResult | null = null;
    for (const [runId, record] of new Map([...this.settlingRuns, ...this.activeRuns.entries()])) {
      if (!record.background && record.chatId === chatId) {
        found = {
          runId,
          events: options?.includeEvents === false ? [] : record.events.slice(),
          startedAt: record.startedAt,
          // Only what the owner wrote is a "next instruction" on screen. A host notice (a teammate's finished
          // report) queued in the same line is plumbing, and the strip's positions count only the owner's.
          queuedSteers: ownerWrittenSteers(this.steerQueues.get(chatId) ?? []).map((queued, index) => ({
            id: queued.id,
            text: queued.request.userPrompt,
            queuedAt: queued.queuedAt,
            position: index + 1,
            ...(queued.recoveryState ? { recoveryState: queued.recoveryState } : {}),
            ...(queued.recoveryReason ? { recoveryReason: publicSteerRecoveryReason(queued.recoveryReason) } : {}),
          })),
        };
      }
    }
    return found;
  }

  /**
   * Wire replay for a viewer (perf review 2026-10-17, R-04 / H2).
   *
   * The live texts (the run's answer so far, each teammate's) ride only on an answer the viewer rebuilds from: the first
   * replay (afterOrdinal 0), one it asks to hydrate from (`hydrate`), or one that is not a complete tail. A complete
   * tail is applied event by event and its deltas already carry the text; attaching the whole answer-so-far to every
   * safety poll re-sent it each time. A run the background service hosts is answered from Main's mirror of its stream
   * (native-gui-events.ts) instead of "unavailable"; `includeHostedElsewhere: false` keeps a reader on Main's own runs.
   */
  replay(value: unknown, options: { includeHostedElsewhere?: boolean } = {}): RunEventReplay {
    const input = parseRunEventReplayInput(value);
    const receipt = this.receipt(input.runId);
    if (receipt && receipt.chatId !== input.chatId) throw new Error("run-event-replay-owner-mismatch");
    const own = this.deliveryJournal.replay(input);
    const record = this.activeRuns.get(input.runId) ?? this.pendingGoalVerifications.get(input.runId) ?? this.settlingRuns.get(input.runId);
    if (record && record.chatId !== input.chatId) throw new Error("run-event-replay-owner-mismatch");
    const elsewhere = !record && own.status === "unavailable" && options.includeHostedElsewhere !== false ? replayHostedElsewhere(input) : null;
    const replay = elsewhere?.replay ?? own;
    if (!(input.afterOrdinal === 0 || input.hydrate === true || replay.status !== "complete")) return { ...replay, receipt };
    const live = record ? { partialText: record.partialText, agentPartialTexts: replayAgentPartialTexts(record.agentPartialTexts) } : elsewhere?.live;
    if (!live) return { ...replay, receipt };
    const agentPartialTexts = live.agentPartialTexts && Object.keys(live.agentPartialTexts).length ? boundedPartialTexts(live.agentPartialTexts) : undefined;
    return { ...replay, receipt, ...(live.partialText.length <= 8 * 1024 * 1024 ? { partialText: live.partialText } : {}),
      ...(agentPartialTexts ? { agentPartialTexts } : {}) };
  }

  /** A teammate's accumulated live text in a run this service hosts, for readers that must project it whole (phone). */
  liveAgentPartialText(runId: string, agentId: string): string | undefined {
    const record = this.activeRuns.get(runId) ?? this.pendingGoalVerifications.get(runId) ?? this.settlingRuns.get(runId);
    return record?.agentPartialTexts.get(agentId);
  }

  /**
   * Main-owned recovery receipt; held directions are never replay permission. Lists the held next-turn directions and
   * every uncertain owner text of the chat's running turns (`native-owner:<intent>`, the form returnSteeringRecovery
   * takes), whichever host or source wrote it (D6). Only the daemon's native-owner-text rows used to be listed
   * (nativeOwnerTextRecovery); a Desktop uncertain row had no exit: production a4f949a6 (Yotube, 2026-10-13 13:51Z,
   * owner_control_episode_reply_lost) stayed uncertain for five days.
   */
  steeringRecovery(chatId: string): InvocationSteerRecovery[] {
    const held = listRecoverableQueuedSteers()
      .filter((row) => row.chatId === chatId && row.recoveryState === "held")
      .map(steeringRecoveryFromDurable);
    let uncertain: InvocationSteerRecovery[] = [];
    try {
      uncertain = listUncertainCurrentTurnSteers(chatId).map((row) => ({ id: `${NATIVE_OWNER_RECOVERY_PREFIX}${row.intentId}`,
        chatId: row.chatId, originalRunId: row.runId, promptText: row.promptText, promptHash: row.promptHash, queuedAt: row.createdAt,
        reason: "original-run-effect-boundary-unconfirmed" as const }));
    } catch { /* a store without the current-turn table has no uncertain owner text */ }
    return [...held, ...uncertain];
  }

  private withSteeringRecovery(receipt: InvocationRunReceipt | null): InvocationRunReceipt | null {
    if (!receipt) return null;
    const steeringRecovery = this.steeringRecovery(receipt.chatId);
    return steeringRecovery.length > 0 ? { ...receipt, steeringRecovery } : receipt;
  }

  receipt(runId: string): InvocationRunReceipt | null {
    // Verification retains the old record for cancellation and evidence, not
    // permission to overwrite its durable terminal receipt with "running".
    const record = this.activeRuns.get(runId) ?? this.settlingRuns.get(runId);
    const durable = getInvocationRunReceipt(runId);
    if (!record) return this.withSteeringRecovery(durable);
    return this.withSteeringRecovery({
      ...(durable ?? {
        runId,
        chatId: record.chatId,
        startedAt: record.startedAt,
        updatedAt: record.startedAt,
        eventCount: record.events.length,
      }),
      status: record.browserLoginWait ? "waiting_input" : record.cancelRequestedAt ? "cancelling" : "running",
      updatedAt: record.cancelRequestedAt ?? durable?.updatedAt ?? record.startedAt,
      eventCount: Math.max(durable?.eventCount ?? 0, record.events.length),
      ...(record.resultFolder ? { resultFolder: record.resultFolder } : {}),
    });
  }

  latestReceipt(chatId: string): InvocationRunReceipt | null {
    for (const [runId, record] of new Map([...this.activeRuns.entries(), ...this.settlingRuns, ...this.browserLoginWaitingRuns])) {
      if (!record.background && record.chatId === chatId) return this.receipt(runId);
    }
    // A newer observation receipt must not replace the owner's foreground run,
    // including after restart when the in-memory registry is empty.
    const row = getDb().prepare(`SELECT run_id FROM run_events
      WHERE chat_id = ? AND kind = 'invoke_started'
        AND COALESCE(json_extract(payload_json, '$.background'), 0) != 1
      ORDER BY ts DESC, rowid DESC LIMIT 1`).get(chatId) as { run_id: string } | undefined;
    return this.withSteeringRecovery(row ? getInvocationRunReceipt(row.run_id) : null);
  }

  /**
   * The chat's latest run started from the owner's own message (it recorded `origin_user_message`): "the execution
   * choices the chat last ran with" for the owner's next text. latestReceipt can be a host-written turn (a teammate's
   * report turn runs read-only, a Goal continuation), and taking its permission ran the owner's next message read-only:
   * production 2026-10-18, Yotube room, the 01:45:27Z report turn was read-only and the owner's 01:49:46Z answer to a
   * question card ran with "Bash is disabled for this session", although the Goal it resumed holds full access.
   */
  latestOwnerReceipt(chatId: string): InvocationRunReceipt | null {
    for (const [runId, record] of new Map([...this.activeRuns.entries(), ...this.settlingRuns, ...this.browserLoginWaitingRuns])) {
      if (!record.background && record.chatId === chatId && record.request.promptOrigin !== "system") return this.receipt(runId);
    }
    const row = getDb().prepare(`SELECT started.run_id FROM run_events started
      WHERE started.chat_id = ? AND started.kind = 'invoke_started'
        AND COALESCE(json_extract(started.payload_json, '$.background'), 0) != 1
        AND EXISTS (SELECT 1 FROM run_events origin WHERE origin.run_id = started.run_id AND origin.kind = 'origin_user_message')
      ORDER BY started.ts DESC, started.rowid DESC LIMIT 1`).get(chatId) as { run_id: string } | undefined;
    return this.withSteeringRecovery(row ? getInvocationRunReceipt(row.run_id) : null);
  }

  latestOneSurface(input: { runId: string; chatId: string; taskId: string }) {
    return getDurableOneSurfaceResult(input);
  }

  history(chatId: string) {
    if (require("../business/company-work-reference").isCompanyWorkReference(getChat(chatId)?.agentId)) throw new Error("company_work_history_owner_required");
    return listChatMessages(chatId);
  }

  private publishAgentResidencyChange(change: AgentResidencyChange): void {
    if (!change.chatId || !change.agentId) return;
    for (const [runId, record] of this.activeRuns.entries()) {
      if (record.background || record.chatId !== change.chatId) continue;
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

  /** Observer evidence owns its run ledger, never the shared Task or chat UI. */
  private recordBackgroundRunEvent(
    runId: string,
    record: RunRecord,
    input: McpInvocationEvent,
    hostControl: ReturnType<typeof mainHostControlForEvent>,
  ): boolean {
    const terminal = !input.agentId && (input.kind === "final" || input.kind === "error");
    const disposition = terminal ? classifyMainOwnedTerminal({
      eventKind: input.kind as "final" | "error",
      steeringInterruptRequested: record.steeringInterruptRequested,
      signalAborted: record.controller.signal.aborted,
      abortReason: record.controller.signal.reason,
    }) : null;
    const event: McpInvocationEvent = {
      ...input,
      ...(input.kind === "error" && input.error && disposition?.errorCode
        ? { error: { ...input.error, code: disposition.errorCode } } : {}),
      sequence: nextObservableSequence(record),
      observedAt: new Date().toISOString(),
    };
    recordMcpInvocationEvent(runId, record.request, event, { requireDurable: true, hostControl });
    if (disposition) {
      recordRunEvent({ runId, chatId: record.chatId, agentId: record.actualAgentId,
        kind: disposition.terminalKind,
        payload: { background: true, resultFolder: record.resultFolder,
          errorCode: event.error?.code, errorMessage: event.error?.message,
          ...(record.controller.signal.aborted && record.controller.signal.reason instanceof Error
            && invocationHostStopCause(record.controller.signal.reason.message)
            ? { hostStopCause: invocationHostStopCause(record.controller.signal.reason.message) } : {}) },
      });
    }
    // A background run gets no push: replay of its journal is its only live channel, so its partials (its own answer
    // and each teammate's) go there as deltas too, never as the whole text on every frame.
    const wireEvent = liveWirePartial(record, event);
    if (!replaceTeammatePartial(record.events, event)) record.events.push(event);
    if (record.events.length > MAX_BUFFERED_EVENTS) record.events.splice(0, record.events.length - MAX_BUFFERED_EVENTS);
    if (wireEvent) this.publishRunEvent(record, { runId, chatId: record.chatId, event: wireEvent });
    return terminal;
  }

  private publishRunEvent(record: RunRecord, envelope: InvocationEventEnvelope): void {
    const observed = envelope.event;
    if (!record.background && !observed.agentId && observed.runtimeSelection?.role !== "worker"
      && (!observed.modelRole || observed.modelRole === "orchestrator")) {
      if (observed.kind === "final" || observed.kind === "error") record.currentRuntimeSelection = undefined;
      else if (observed.runtimeSelection) {
        record.currentRuntimeSelection = { ...observed.runtimeSelection };
      }
    }
    const scienceDelivery = !record.background && record.executionSource === "science"
      ? recordScienceRuntimeOutboxEvent({ runId: envelope.runId, chatId: envelope.chatId, event: envelope.event })
      : undefined;
    const event = this.deliveryJournal.publish(envelope.runId, envelope.chatId, envelope.event, ++record.deliveryOrdinal);
    if (record.background) return;
    this.publishEvent(scienceDelivery ? { ...envelope, event, scienceDelivery } : { ...envelope, event });
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
    if (record.background) return;
    const envelope: InvocationSettledEnvelope = {
      runId,
      chatId: record.chatId,
      ...(record.oneMode && record.actualAgentId ? { agentId: record.actualAgentId } : {}),
      receipt,
      oneMode: record.oneMode,
      pendingQuestion: record.pendingQuestion,
      ...(record.browserLoginWait ? { browserLoginWaiting: true } : {}),
      ...(record.userDecisionRequest ? { userDecisionRequest: record.userDecisionRequest } : {}),
      ...(record.goalWaitRequest ? { goalWaitRequest: record.goalWaitRequest } : {}),
      goal: record.goal,
      ...(record.workspaceBinding ? { workspaceBinding: record.workspaceBinding } : {}),
    };
    if (record.oneMode && record.actualAgentId) {
      // 사람이 멈춘 실행(중지·Goal 일시정지/삭제)과 방향 전환은 실패가 아니다 — 조직도에 붉은
      // "실패 · 확인 필요"로 남기지 않는다(2026-09-26 실측: Goal 삭제 직후 좌석이 실패로 표시).
      const stopped = isNonFailureInvocationStop(receipt);
      const failed = !stopped && (receipt.status === "failed" || receipt.status === "interrupted");
      const creditBlocked = receipt.errorCode === "insufficient_credits" || /insufficient[_ -]?credits/i.test(receipt.errorMessage || "");
      cacheOneOrgCompletionSummary({ installedAgentId: record.actualAgentId, runId });
      // PRD §3.5 — 사람이 읽는 문구는 로케일 표에서 가져온다. 내부 오류 코드는 사용자 문장에
      // 붙이지 않는다(코드는 영수증에 이미 있고, 화면에서는 뜻을 못 준다).
      const settleLocale = pickLocale(record.request);
      const statusLine = record.browserLoginWait
        ? (settleLocale === "ko" ? "로그인 확인 대기" : "Waiting for sign-in")
        : failed
        ? (settleLocale === "ko" ? "실패 · 확인 필요" : "Failed · review needed")
        : stopped
          ? (settleLocale === "ko" ? "멈춤 · 실패 아님" : "Stopped · not a failure")
          : (settleLocale === "ko" ? "최근 작업 완료" : "Recently completed");
      setOneOrgMemberStatus({
        installedAgentId: record.actualAgentId,
        statusKind: record.browserLoginWait ? "waiting" : failed ? "failed" : record.pendingQuestion ? "waiting" : "quiet",
        statusLine,
        unreadCount: failed || stopped ? 0 : 1,
        // Preserve the machine-readable balance marker for diagnostics, and clear it after success.
        creditState: creditBlocked ? ("insufficient" as const) : ("ok" as const),
        ...((record.pendingQuestion || record.browserLoginWait) ? { pendingCount: 1, pendingKind: "input" as const } : { pendingCount: 0 }),
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
    // Closed admission (app closing, update restart, a suppressed dev copy): the queued rows stay durable for restart
    // recovery instead of each failing as desktop_execution_admission_closed.
    if (!this.acceptingStarts) return;
    if (this.activeChatIds().includes(chatId)) { this.awaitProcessLease(chatId); return; }
    const queue = this.steerQueues.get(chatId);
    if (!queue?.length) return;
    const next = queue[0];
    if (!next) return;
    // A direction waiting out a locked store keeps its place at the head; its own timer drains it.
    if ((this.steerDrainBackoff.get(next.id)?.notBefore ?? 0) > Date.now()) return;
    queueMicrotask(() => {
      // Keep the exact row cancellable until dispatch, including this microtask
      // gap. An unsteer/stop or competing drain must win before the durable CAS.
      if (this.steerQueues.get(chatId)?.[0] !== next) return;
      if (this.activeChatIds().includes(chatId)) { this.awaitProcessLease(chatId); return; }
      queue.shift();
      if (!queue.length) this.steerQueues.delete(chatId);
      const drainedRunId = next.drainedRunId ?? randomUUID();
      let phase: "claim" | "start" = "claim";
      let started = false;
      try {
        try {
          // The planned run of an earlier attempt was refused by a locked store after it was recorded: reopen the claim.
          if (next.spentRunId) requeueUndispatchedQueuedSteer(next.id, next.spentRunId);
          if (!beginQueuedSteerDrain(next.id, drainedRunId, row=>queuedTeamReportCurrent(row.oneTeamReportCustody,row.request)
            && canonicalQueuedSteerRequest(row.request)===canonicalQueuedSteerRequest(next.request)
            && row.oneTeamReportCustodyJson===next.oneTeamReportCustodyJson)) { this.steerDrainBackoff.delete(next.id); return; }
          phase = "start";
          if (!hasInvocationRunReceipt(drainedRunId)) {
            // Started from the settling run's own stack: it must not inherit that run's personal-native original.
            withoutOnePersonalNativeOriginal(() => this.start(
              { ...next.request, runId: drainedRunId },
              next.workspaceBinding,
              next.executionContext,
              undefined, undefined, next.mainAdmission, undefined,
              next.request.oneMode && next.request.promptOrigin !== "system" ? QUEUED_ONE_ROOM_INHERITANCE : undefined,
              next.oneTeamReportCustody,
            ));
          }
          started = true;
        } catch (error) {
          const retry = this.retryQueuedSteerOnLockedStore(chatId, next, drainedRunId, phase, error);
          if (retry !== "scheduled") this.failQueuedSteerStart(chatId, next, drainedRunId, error, retry === "exhausted");
        }
        if (started) {
          this.steerDrainBackoff.delete(next.id);
          // The run is started: a lock on this settlement retries it and never turns the started run into a failure.
          this.settleQueuedSteerDurably(next.id, "started");
        }
      } finally {
        // A rejected/CAS-lost row must not strand a second queued direction.
        this.publishSteerQueueCapacity(chatId);
        this.drainSteerQueue(chatId);
      }
    });
  }

  /**
   * A queued direction whose start hit a locked store is started again with backoff instead of failing (R-067).
   * Production 1.3.67, 2026-10-18T02:44:23Z, Yotube room: the Film Production Director's completion report
   * (dispatch-1f9ca888) waited behind the leader's run; when the run ended its start threw "database is locked", the drain
   * marked it failed and never ran it, and the leader never read the report. The 1.3.54 store_busy retry covers only the
   * model-call path. A lock is transient, and this start is retried only while it provably sent nothing: a lock in the
   * drain claim (the CAS rolled back), or a start that refused before dispatch (start() marks it). A start that had
   * already recorded its planned run leaves that id spent and the retry starts a new run. Bounded by
   * STEER_DRAIN_STORE_BUSY_DELAYS_MS; the head keeps its place in the queue meanwhile.
   */
  /** An idle-chat direction whose start was refused transiently joins the drain queue (see retryQueuedSteerOnLockedStore). */
  private queueRefusedIdleSteer(chatId: string, row: DurableQueuedSteer, runId: string, error: unknown): "scheduled" | "exhausted" | "not-retryable" {
    return this.retryQueuedSteerOnLockedStore(chatId, queuedSteerFromDurable(row), runId, "start", error);
  }

  private retryQueuedSteerOnLockedStore(chatId: string, next: QueuedSteer, drainedRunId: string,
    phase: "claim" | "start", error: unknown): "scheduled" | "exhausted" | "not-retryable" {
    const typed = innermostTypedCode(error) ?? refusalCode(error) ?? null;
    const storeBusy = innermostTypedCode(error) === STORE_BUSY_CODE;
    // No-dead-end sweep 2026-10-25: a start refused because the chat or its channel was not ready yet (the same codes the
    // owner's message queue retries) is retried too, with the message queue's backoff and deadline, instead of ending the
    // owner's direction "failed". A waiting Goal's refusal of a system relay keeps its own parking path below.
    const transient = !storeBusy && typed !== "goal_waiting_system_start_refused" && isTransientSendRefusalCode(typed);
    if (!storeBusy && !transient) return "not-retryable";
    if (phase === "start" && storeBusy && !runnerRefusedBeforeDispatch(error)) return "not-retryable";
    const prior = this.steerDrainBackoff.get(next.id);
    const attempt = (prior?.attempt ?? 0) + 1;
    const firstAt = prior?.firstAt ?? Date.now();
    if (storeBusy ? attempt > STEER_DRAIN_STORE_BUSY_DELAYS_MS.length : Date.now() - firstAt > TRANSIENT_SEND_DEADLINE_MS) return "exhausted";
    let retry = next;
    if (phase === "start") {
      // The admission was consumed by the refused start; a recovered direction starts without one, like this retry.
      const { drainedRunId: _spent, mainAdmission: _consumed, ...rest } = next;
      retry = { ...rest, spentRunId: drainedRunId };
    }
    for (const [id, waiting] of this.steerDrainBackoff) {
      if (id !== next.id && !this.steerQueues.get(waiting.chatId)?.some((queued) => queued.id === id)) this.steerDrainBackoff.delete(id);
    }
    const delayMs = storeBusy ? STEER_DRAIN_STORE_BUSY_DELAYS_MS[attempt - 1]! : transientSendBackoffMs(attempt - 1);
    this.steerDrainBackoff.set(next.id, { chatId, attempt, notBefore: Date.now() + delayMs, firstAt });
    const queue = this.steerQueues.get(chatId) ?? [];
    if (!queue.some((queued) => queued.id === next.id)) queue.unshift(retry);
    this.steerQueues.set(chatId, queue);
    const timer = setTimeout(() => this.drainSteerQueue(chatId), delayMs + 5);
    timer.unref?.();
    console.warn(`[invocation] queued steer start ${storeBusy ? "hit a locked store" : "was refused (not ready yet)"}; retrying steer=${next.id} chat=${chatId} `
      + `code=${storeBusy ? STORE_BUSY_CODE : typed} phase=${phase} attempt=${attempt}${storeBusy ? `/${STEER_DRAIN_STORE_BUSY_DELAYS_MS.length}` : ""} delayMs=${delayMs}`);
    return "scheduled";
  }

  /** Every failed/cancelled settlement names its cause; a lock on the settlement itself is retried, never dropped. */
  private settleQueuedSteerDurably(id: string, status: "started"): void;
  private settleQueuedSteerDurably(id: string, status: "cancelled" | "failed", cause: DurableQueuedSteerTerminalCause): void;
  private settleQueuedSteerDurably(id: string, status: "started" | "cancelled" | "failed", cause?: DurableQueuedSteerTerminalCause): void {
    this.settleQueuedSteerAttempt(id, status, cause, 0);
  }

  private settleQueuedSteerAttempt(id: string, status: "started" | "cancelled" | "failed",
    cause: DurableQueuedSteerTerminalCause | undefined, attempt: number): void {
    try {
      if (status === "started") settleQueuedSteer(id, "started");
      else settleQueuedSteer(id, status, cause ?? "unattributed");
    } catch (error) {
      if (innermostTypedCode(error) === STORE_BUSY_CODE && attempt < STEER_DRAIN_STORE_BUSY_DELAYS_MS.length) {
        const timer = setTimeout(() => this.settleQueuedSteerAttempt(id, status, cause, attempt + 1), STEER_DRAIN_STORE_BUSY_DELAYS_MS[attempt]!);
        timer.unref?.();
        return;
      }
      // The row stays draining with its planned run; restart recovery settles or holds it from that run's receipt.
      console.warn(`[invocation] queued steer settlement could not be written steer=${id} status=${status}`
        + `${cause ? ` cause=${cause}` : ""} code=${innermostTypedCode(error) ?? "none"}`);
    }
  }

  /** A start that will not be retried ends with its machine cause (never NULL), and the owner's own text is kept. */
  private failQueuedSteerStart(chatId: string, next: QueuedSteer, drainedRunId: string, error: unknown, storeBusyExhausted: boolean): void {
    this.steerDrainBackoff.delete(next.id);
    const code = refusalCode(error);
    // A waiting Goal refuses a system turn and parks its relay with this run id; the Goal's next turn carries it as
    // context. That is a hand-off, not a lost report (Yotube 2026-10-17T17:36:21Z steer c9bd1c58: "failed", yet its
    // relay was parked and delivered at 19:44).
    if (code === "goal_waiting_system_start_refused" && (relayParkedForRun(drainedRunId) || this.parkRefusedQueuedRelay(chatId, next, drainedRunId))) {
      this.settleQueuedSteerDurably(next.id, "cancelled", "parked-for-waiting-goal");
      console.info(`[invocation] queued steer parked for the waiting Goal steer=${next.id} chat=${chatId} cause=parked-for-waiting-goal code=${code}`);
      return;
    }
    const cause: DurableQueuedSteerTerminalCause = storeBusyExhausted ? "drain-store-busy-exhausted" : code ? "drain-start-refused" : "drain-start-error";
    this.settleQueuedSteerDurably(next.id, "failed", cause);
    const message = error instanceof Error ? error.message : String(error);
    // The queued direction was never a chat message (start() persists it), so a failed start used
    // to erase the owner's sentence and leave no trace of why (Youtube room, 2026-10-10 08:55).
    // Log the cause marker with the typed code, keep the sentence as the owner's own turn, and say so briefly.
    console.warn(`[invocation] queued steer failed to start steer=${next.id} chat=${chatId} cause=${cause} code=${code ?? "none"} `
      + `detail=${redactSecrets(message).replace(/\s+/g, " ").slice(0, 400)}`);
    try {
      const request = next.request;
      const text = typeof request.userPrompt === "string" ? request.userPrompt : "";
      // A carried direction's own rows are already in the chat (carried-owner-followups.ts): never a second copy.
      if (text.trim() && request.promptOrigin !== "system" && !request.agentAppMode && !next.id.startsWith(CARRIED_FOLLOWUP_STEER_PREFIX)) {
        // A preflight copy of the same direction may already have been delivered as a user turn.
        const delivered = getDb().prepare(
          "SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND text = ? AND created_at >= ? LIMIT 1",
        ).get(chatId, text, next.queuedAt);
        if (!delivered) {
          const kept = appendChatMessage(chatId, "user", text, request.images?.length ? { images: request.images } : undefined);
          // No synthetic "could not hand over" reply: the message is shown once, the cause is in the log above.
          // The kept message is the owner's: the chat's Goal reviews it like any owner message (D2).
          const goalId = reviewableChatGoalId(chatId);
          if (goalId && kept?.id) reviewOwnerDirectionForGoal({ runId: drainedRunId, chatId, goalId, sourceMessageId: kept.id,
            notReviewed: ownerDirectionReviewSkip(request, next.workspaceBinding, next.executionContext), via: "queued-start-failed" });
        }
      }
    } catch (persistError) {
      console.warn("[invocation] failed queued steer could not be preserved in the chat:", persistError);
    }
    this.publishEvent({
      runId: "steer",
      chatId,
      event: { kind: "error", error: { code: "steer-start-failed", message } },
    });
  }

  /**
   * start() parks only One conversation relays (a teammate report, a room follow-up) when a waiting Goal refuses them. A
   * queued host direction of another shape was refused the same way and then dropped: the One supervisor's direction into
   * a room (taskIntent "task", steerFromSupervisor) or a relay into a chat that is not a One chat. It goes to the same
   * deferred store (deferred-system-relays.ts), so the chat's next turn that runs carries it exactly once. Returns true
   * only when a parked copy really waits: newly written, or an undelivered copy of the same text already there. The
   * owner's own text is never parked here (the failure path keeps it in the chat as the owner's turn).
   */
  private parkRefusedQueuedRelay(chatId: string, next: QueuedSteer, drainedRunId: string): boolean {
    const request = next.request;
    const text = typeof request.userPrompt === "string" ? request.userPrompt.trim() : "";
    if (request.promptOrigin !== "system" || request.agentAppMode === true || !text) return false;
    try {
      const goalId = getChat(chatId)?.goalId;
      const status = goalId ? getLongRunByGoalId(goalId)?.status : undefined;
      return deferSystemRelay({ chatId, text, cause: status ? `goal_${status}` : "goal_waiting", goalStatus: status ?? null,
        originRunId: drainedRunId }) || relayCopyParked(chatId, text);
    } catch (error) {
      console.warn(`[invocation] refused queued relay could not be parked steer=${next.id} chat=${chatId} code=${innermostTypedCode(error) ?? "none"}`);
      return false;
    }
  }

  /**
   * The owner takes a held direction back into the composer (invoke:returnSteeringRecovery). Its text is returned and
   * the held row retired in ONE transaction, so the composer holds the only copy. Owner 2026-10-18: a held follow-up
   * stayed listed forever because only host-written held rows were ever retired; One now puts the text back once
   * (renderer 38f5892d) and this retires the row. Both held forms One lists are accepted: a queued direction held at
   * restart (invocation_steers) and an owner text a native turn could not confirm (`native-owner:<intent>`). It runs on
   * the shared store whichever process owns the chat's run: a held row is in no process's live queue
   * (recoverQueuedSteers never queues one, the drain CAS refuses it) and an uncertain current-turn row is never
   * dispatched again. Owner text only, idempotent, never starts a turn.
   */
  returnSteeringRecovery(id: string, expectedChatId?: string): InvocationSteerRecoveryReturn {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) throw new Error("steer_recovery_invalid_id");
    if (expectedChatId !== undefined && (typeof expectedChatId !== "string" || !expectedChatId)) throw new Error("steer_recovery_invalid_chat_id");
    const result = id.startsWith(NATIVE_OWNER_RECOVERY_PREFIX)
      ? returnUncertainOwnerText(id.slice(NATIVE_OWNER_RECOVERY_PREFIX.length), expectedChatId)
      : returnHeldOwnerSteer(id, expectedChatId);
    if (result.status === "returned") {
      console.info(`[invocation] held direction returned to the owner steer=${id} chat=${result.chatId} cause=held-returned-to-owner`);
      try { emitDesktopStoreChange({ entity: "chat", id: result.chatId }); } catch { /* the retirement is durable */ }
    }
    return { id, ...result } as InvocationSteerRecoveryReturn;
  }
}

export const invocationService = new InvocationService();
installMobileOneAutoRecovery(invocationService);
