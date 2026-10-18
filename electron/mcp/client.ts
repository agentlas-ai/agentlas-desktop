import { bindRunnerTurnContext, carryRunnerTurnContext, renderRunnerTurnContext, replaceRunnerUserPrompt, runnerTurnContextSource } from "../runtime/runner-turn-context-binding";
import { composeTracedPrompt } from "../runtime/prompt-composition-trace";
import { fixedPurposePrompt, purposePrompt } from "../runtime/purpose-prompts";
import { captureNativeOsCuratorRun } from "../runtime/os-memory-curator-binding";
import { placeTurnContextForRuntime } from "../runtime/serving-prefix";
import { currentHistoryRuntimeFence, withCurrentHistoryProvider } from "../one/history-runtime-fences";
import { withOneHistoryNativeInvocation } from "../one/personal-integrations-runtime";
import { withAdapterEffectObserver } from "../invocation/adapter-effect-context";
import { runWithOwnerControl } from "../runtime/owner-control-pump";
import { assertGraphWorkerAttempt, noteGraphWorkerDispatch, noteGraphWorkerReturnedFailure, noteGraphWorkerAdapterStart, noteGraphWorkerAdapterFinish, noteGraphWorkerCoverageUnknown, noteGraphWorkerActivity, noteGraphWorkerTool, noteGraphWorkerPrepare, noteGraphWorkerSelection, noteGraphWorkerFailure, settleGraphWorkerAttempt, type GraphWorkerAttempt, type GraphWorkerFailureReceipt } from "../workflow/graph-worker-fallback";
import { prepareWorkAttachmentContext, mainWorkAttachmentContext, redactWorkAttachmentText, isWorkAttachmentInput } from "../invocation/work-attachments";
import { issueScienceCollectionCapability, assertScienceCollectionRuntimeSelection } from "../runtime/science-collection-boundary";
import { readScienceCollectionAuthority } from "../science-host/collection-authority";
import { resolveScienceRecoveryAuthority, freshScienceRecoveryRequest } from "../science-host/recovery-authority";
import { readScienceRecoveryAuthority } from "../science-host/recovery-mint";
import { bindScienceAliveDesktopToolWake, bindScienceDesktopToolTurn,
  type ScienceAliveDesktopToolScope } from "../science-host/desktop-tool-bridge";
import { ALIVE_DECISION_OUTPUT_SCHEMA } from "../alive-decision-schema";
import { bindInvocationJudgmentRuntime, withInvocationJudgmentContext } from "../runtime/judgment-context";
import { longRunMonetaryRefusal, type LongRunUsageInput } from "../long-run/budget";
import { beginAccountedInference } from "../long-run/accounting-context";
import { createRuntimeUsageCollector } from "../../shared/observed-usage";
import { withModelCallScope } from "../runtime/model-call-ledger";
import { estimateTextTokens } from "../runtime/token-estimate";
import { assertCurrentHistoryRunnerResult, runObservedRunner, observedRunnerUsage, ObservedRunnerFailureError } from "../runtime/observed-runner";
import { withInvocationUsage, beginInvocationUsageAttempt, currentInvocationObservedUsage } from "../runtime/invocation-usage";
import { createNoProgressGuard, noteNoProgressEvent, toolObservationDigest } from "../automation-progress-guard";
import { formatAutomationNextRun } from "../../shared/automation-next-run";
import { runtimeQuotaFailureMessage } from "../../shared/runtime-quota";
import { getBillingCredits } from "../billing";
import { peekProviderQuotaExhausted } from "../usage";
import { getOneProfile } from "../store/one-profile";
import { applyAutomationLifecycle, automationLifecycleContext, automationLifecycleRefusalText, automationRegistrationReasonCode, automationRegistrationRefusalText } from "../automation-lifecycle";
import { recordAutomationPinProvenance } from "../automation-runtime-provenance";
import { AutomationWorkspaceError, bindCreatedGoalContinuationWorkspace } from "../automation-workspace";
import { assertFiniteGoalLifecycleCurrent, currentAutomationGoalExecutionOwnerMatches, isGoalDispatchRefusal } from "../automation-execution-control";
import { selectionForRuntime } from "../../shared/runtime-selection";
import { roomChipRuntimeSelection } from "../runtime/room-chip-runtime";
import { officeTaskContextForInvocation } from "../office-task-context";
import { goalDeadlineWaitClause, goalWaitProtocol, parseGoalWaitIntent, stripGoalWaitDisplayText, type ParsedGoalWait } from "../long-run/wait-emitter";
import { prepareCheckpointContinuation } from "../long-run/continuation";
import { goalContinuationSessionIdentity } from "../long-run/goal-session-owner";
import { recordInvocationInstructionSnapshot, compileProjectInstructionSnapshot } from "../long-run/instructions";
import { renderInstructionSnapshot } from "../../shared/runtime-instructions";
import { createNativeCapturePublisher } from "../browser/native-capture-artifacts";
import type { NativeBrowserRelayGrant } from "../browser/native-cdp-relay";
import { createBrowserLoginPrerequisite, type BrowserLoginPrerequisiteControl,
  type BrowserLoginWait } from "../browser/login-prerequisite";
import { withAttemptChildren, type AttemptChildren } from "../runtime/attempt-children";
import { drainAttemptChildren, killCliTree } from "../runtime/exec";
import { OwnerCloudShelfIncompleteError } from "../marketplace/mcp-source";
import type { ChatHostNotice } from "../../shared/types";
// 활성 백엔드 → 실제 러너로 라우팅하는 invocation runner.
// PRD §3.1 6단계 BYOC: 사용자 머신에서 사용자의 구독/키로 직접 호출.
// chatId 기반 — chat에서 agent + project 컨텍스트 lookup.
import fs from "node:fs";
import { modelContextFailureReason, passFailureVerdict, waitForPassRetry } from "../long-run/pass-failure-verdict";
import type { GoalPassStop } from "../long-run/goal-pass-stop";
import { parseHubReleasePin, assertHubReleasePin } from "../../shared/hub-release-pin";
import { isCallOnlyHubAgent } from "../../shared/call-only-agent";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createToolObservationNovelty } from "./tool-observation-novelty";
import { bindInvocationAgentContext } from "../runtime/agent-context-admission";
import { invokeWithUnsettledContinuation, unsettledContinuationCarriesRequest, unsettledContinuationPrompt } from "../runtime/unsettled-continuation";
import { agentContextHostBinding, agentContextUnsettledTurn, markAgentContextContinuationHandle, type AgentContextCapability } from "../runtime/agent-context";
import { createMainHostControlSink, createMainHostOperationBridge, withAdapterEffectChildDispatch } from "../invocation/adapter-effect-context";
import { detectRuntimes } from "../runtime/detect";
import { ONE_AGENT_ID } from "../runtime/agent-residency";
// Stormbreaker Loop — 목표 분해/연속 실행/검증 가능한 오류 repair를 감독(비차단·실패-무해).
import { superviseStormbreaker, type StormbreakerHandle } from "../hephaestus/stormbreaker-supervisor";
import { isStormbreakerAutoEnabled } from "../hephaestus/supervisor";
import { careerGraphIngest, hepCall, routeOnly, stormbreakerHarness } from "../hephaestus/commands";
import { normalizeRecommendation } from "../hephaestus/recommendation";
import {
  buildGoalDrivenContinuationPrompt,
  buildStormbreakerLongRunPrompt,
  goalCompletionProtocol,
  goalCompletionVerdict,
  stripGoalCompleteMarker,
  buildStormbreakerContinuationPrompt,
  CONTINUOUS_MODE_MAX_PASSES,
  STORMBREAKER_MAX_IDENTICAL_PASSES,
  idleGoalPassStep,
  finiteGoalContinuationIsParked,
  goalContinuationSchedule,
  STORMBREAKER_LONG_RUN_SCHEDULE,
  STORMBREAKER_LOOP_PROTOCOL,
  STORMBREAKER_MAX_EXECUTION_PASSES,
  stripStormbreakerContinueMarker,
} from "../hephaestus/loop-engineering";
import {
  closeOpenGoalLedgerTasks,
  completeGoalLedgerGoal,
  deriveGoalAcceptanceCriteria,
  ensureGoalLedgerGoal,
  getGoalLedgerGoal,
  GOAL_HARD_STOP_REASONS,
  goalProgressKeyForText,
  recordGoalLedgerCycle,
  type GoalLedgerDecision,
  type GoalLedgerSnapshot,
} from "./goal-ledger";
import { getAgentById, listInstalledAgents } from "./registry";
import { isAgentArchived, restoreAgentForUse } from "../archive/auto-archive";
import { applyGoalPlanMarkers, bindGoalPlanDispatch, buildGoalPlanTurnContext, ensureGoalShapeBeforeTurn, goalPlanContinuationNote, recordGoalPlanPassStop } from "../long-run/goal-shaping";
import { readGoalPlan } from "../store/goal-plans";
import { goalPassStopCause } from "../long-run/goal-pass-stop";
import { goalPassBudgetStep, GOAL_PASS_WALL_CLOCK_BUDGET_MS } from "../long-run/goal-pass-budget";
import { captureNativeGoalEpisode, type NativeGoalEpisodeBinding } from "../long-run/native-goal-pass";
import { agentPromptFolder, buildEffectiveAgentSystemPrompt } from "../agents/files";
import { acquireAgentWorkspaceRunLease, releaseAgentWorkspaceRunLease, getAgentWorkspace, readAgentWorkspaceFile } from "../agents/workspace-service";
import {
  autoRouteStatus,
  autoRouteSystemPreamble,
  shouldForceHubFirstWorkforce,
  type AutoRouteChoice,
} from "../agents/auto-router";
import { assembleSystemPrompt } from "../system-agents/assemble";
import { AUTOMATION_SUPERVISOR_SYSTEM_AGENT } from "../system-agents/automation-supervisor";
import { ROUTER_AGENT_ID, ROUTER_SYSTEM_AGENT } from "../system-agents/router";
import {
  appendChatMessage,
  appendInvocationAssistantResult,
  autoTitleFromFirstMessage,
  clearChatGoalBindingByGoalId,
  getChat,
  getChatGoalId,
  getChatWorkingFolder,
  listChatMessages,
  repairRootChatSurfaceController,
  setChatRuntimeSelection,
  setChatGoalBinding,
  setChatWorkingFolder,
} from "../store/chats";
import { getProject, listProjects } from "../store/projects";
import { getChatGoalContract, getChatGoalRevision, getLegacyGoalLifecycleSnapshot } from "../store/chat-goals";
import { goalDeadlineAt } from "../long-run/goal-deadline";
import { getLongRunByGoalId, longRunOwnerHold, recordLongRunUsage, transitionLongRun } from "../store/long-runs";
import { getDb } from "../store/db";
import { desktopStoreTransaction } from "../store/change-bus";
import { supervisorExcludedHistoryMessages, supervisorIngressMessage } from "../one/supervisor-store";
import { carriedFollowupMessageIds } from "../invocation/carried-owner-followups";
import { isOneQuietReply } from "../../shared/one-supervisor";
import { listAgentSurfaces } from "../store/agent-surfaces";
import { listRentAllowedSlugs } from "../store/project-agent-rent";
import { findCanonicalTaskForChat } from "../store/tasks";
import { MainWorkRecoveryContext } from "../invocation/main-work-recovery";
import { touchRuntimeSession } from "../store/runtime-sessions";
import { latestTaskCheckpoint } from "../long-run/checkpoint";
import { bindCreatedAutomationToGoal } from "../long-run/automation-provenance";
import { compileLongRunCheckpoint } from "../../shared/long-run-checkpoint";
import { getInterviewMode } from "../store/interview-mode";
import { isUserFacingProjectAgent } from "../../shared/project-agent-pool";
import { oneConfirmedRosterTargetsAreExact, oneTeamWorkforceHubMode, oneTeamUsesNativeStaffing, type OneTeamStaffingAuthority } from "../../shared/one-team-preflight";
import { projectRosterSpecs } from "../../shared/project-roster-specs";
import { getCargoSource } from "../marketplace";
import { getSessionCookieHeader, webBaseUrl } from "../auth";
import { ExperienceCloudHttpClient } from "../experience/cloud";
import { prepareProjectCloudRoster, ProjectCloudRosterError } from "./project-cloud-roster";
import { classifyTurnEscalation, decideProjectRosterTaskForce, describeTurnEscalation } from "../../shared/turn-escalation";
import { hasPermissionEscalationMarker, stripPermissionEscalationMarker } from "../../shared/permission-escalation";
import { stripStrayProtocolTokens } from "../../shared/protocol-token-strip";
import { livePartialCommitBoundary } from "../../shared/interrupted-partial";
import { EFFECT_OBSERVATION_SYSTEM_PROMPT, effectObservationOutputSchema, stripEffectObservationMarker } from "../../shared/effect-observation";
import { effectObservationTicket } from "../long-run/effect-observation-tickets";
import { goalExecutionDirectivePromptBlock } from "../long-run/goal-execution-context";
import { canonicalAskFenceText, extractAskFences } from "../../shared/ask-fence-flatten";
import { AGENT_ASK_OPEN } from "../../shared/agent-control-blocks";

/**
 * A turn that opened an ask fence handed the next move to the owner — even when the fence body
 * is not the JSON card the parser accepts. Production 2026-10-03 (X room): Codex closed the fence
 * with `<<end-agentlas-ask>>` around a prose question, so no card was parsed, the loop counted
 * "no question", and the same Goal run re-asked 143 times in 90 minutes.
 */
function turnAsksOwner(text: string): boolean {
  return extractAskFences(text).questions.length > 0 || text.includes(AGENT_ASK_OPEN);
}
import { getFirm, listFirms } from "../store/firms";
import { recordBorrowedAgentCareer } from "../agents/borrowed-profiles";
import {
  activeBorrowedOwnerScopeKey,
  borrowedMemoryKey,
} from "../agents/borrowed-owner-scope";
import { getResolvedOrg } from "../store/org-spec";
import { runFirmInvocation } from "./firm-orchestrator";
import {
  BorrowedAgentUnavailableError,
  TaskForceRuntimeFailureError,
  requireBorrowedAgentSpecs,
  runBorrowedTaskForceInvocation,
  type BorrowedAgentSpec,
  type WorkforceLeaderRunnerEvidence,
} from "./borrowed-task-force";
import {
  emitWorkforceBenchmarkSelectionArtifacts,
  isWorkforceLeaderRuntimeAllowed,
  parseWorkforceCommand,
  preparedWorkforceSpecSource,
  runWorkforceSelection,
  installedWorkforceHubMcp,
  type WorkforcePrepareCheckpointReceipt,
  type WorkforceSelectionReceipt,
  workforceFailureCode,
} from "./workforce-orchestrator";
import {
  bindDesktopWorkforceGoal,
  resolveDesktopWorkforceGoalId,
  freshGoalIdForChat,
  loadDesktopWorkforceGoal,
  recordDesktopWorkforceTurn,
  type DesktopWorkforceRuntimePlan,
} from "./workforce-goal-continuity";
import { runSwarmInvocation } from "./swarm-run";
import { canReadActivatedFolderMemory, recordFolderVisit } from "../architecture/activation";
import { ensureDesktopProjectBootstrap } from "../architecture/project-bootstrap";
import { buildMemoryContext } from "../memory/context";
import { orderPromptParts, registerDeclaredPromptModule, type DeclaredPromptPart, type PromptChangeTrigger, type PromptOrderingMetadata, type PromptStability } from "../runtime/prompt-order";
import { renderControllerSurfaceMemory, bindSurfaceMemoryRequest } from "../memory/surface-recall";
import { scienceAliveMemory, scienceAliveMemoryGuard } from "../memory/science-alive-memory";
import { bindAppMemoryRequest, appRunMemory, appMemoryRunGuard } from "../memory/agent-app-memory";
import { invocationMemoryScope } from "../memory/invocation-scope";
import { queryWorkingFolderOntologyContext } from "../ontology/project-runtime";
import { writeEvolutionProposalsForProject, evolutionSessionContextLine } from "../agents/evolution-hep";
import {
  curateReply,
  recordTerminalMemoryTurn,
  stripReplyMemoryEventsReadOnly,
} from "../memory/curator";
import { stripAllMemoryEventBlocks } from "../memory/events";
import {
  runSemanticMemoryReview,
} from "../memory/semantic-curator";
import { isAutomationLedgerChat } from "../memory/automation-surface";
import { harvestCompactionSummaries } from "../memory/compaction-harvest";
import { parseMemoryEvents, type RawMemoryEvent } from "../memory/events";
import { hasQueuedOwnerSteer } from "../store/invocation-steers";
import { APP_BUILDER_SLUG } from "../architecture/manifest";
import { memoryEmitterPromptFor } from "../system-agents/memory";
import { roomMemberContext } from "../one/room-chat";
import { automationProtocolFor, parseAutomations, automationRegistrationGateProblems } from "../automation-emitter";
import { SURFACE_CLOSE_FENCE, SURFACE_OPEN_FENCE, SURFACE_PROTOCOL, parseSurfaces } from "../surface-emitter";
import { applyFinalDisplayBackstop } from "./final-display-backstop";
import {
  oneFriendlyFollowupProtocol,
  parseOneFriendlyFollowups,
  type OneFriendlyFollowupPlanV1,
} from "../../shared/one-friendly-followups";
import { buildOneSurfaceFromMarkdown, chooseOneSurfaceForDisplay, resolveOneMarkdownSurfaceIntent } from "../one/markdown-surface";
import { bindOneRuntimeToolArtifacts, oneArtifactAlreadyBoundInChat, promoteBoundOneMarkdownImages } from "../one/artifact-preview";
import { hasRunProducedFiles, openRunProducedFiles, takeRunProducedFiles } from "../harness/run-produced-files";
import { classifyToolFailure, toolFailureCopy } from "../../shared/tool-failure";
import { resolveToolInvocationOrigin } from "../invocation/tool-origin";
import type { ToolInvocationOrigin } from "../../shared/tool-invocation-origin";
import type { RuntimeToolKind } from "../../shared/runtime-tool-kind";
import { automationRegistrationMonitoring, hasAutomationRegistrationHandoff, resolveAutomationRegistrationTarget } from "../automation-registration";
import { createAutomation, findAutomationByGoalId, getAutomation, listAutomations, toggleAutomation, updateAutomation, updateAutomationGraph } from "../store/automations";
import { graphTeamGrantCurrent, type GraphTeamGrant } from "../one/graph-team-grant";
import { isCompletedToolEvent, previousTurnObservation, projectContextKey, recordContextSourceMarker, recordRunEvent, tryRecordRunEvent } from "../store/run-events";
import { RUNTIME_TURN_ATTEMPT_EVENT, RUNTIME_TURN_PLACED_EVENT } from "../invocation/turn-placement";
import { validSiteAgentAppMcpGrantTools } from "../site/agent-app-tool-policy";
import {
  resolveSiteAgentAppInlineMcpConfigForDispatch,
} from "../site/agent-app-mcp-config-policy";
import { listInstalledServers as listInstalledMcpServers } from "../mcp-tools/registry";
import { getAgentApp } from "../store/agent-apps";
import { autoSelectMcpTools, buildMcpAutoSelectionPrompt, describeScopedMcpOutcome, selectUntilGoalScopeSettled, type GoalToolSelectionReceipt } from "../mcp-tools/auto-select";
import { runMcpKeyElicitationGate } from "./run-key-elicitation";
import { getEnvConfigurationRevision } from "../secrets/vault";
import { bridgeHubPluginCandidates } from "../mcp-tools/hub-plugin-bridge";
import { noteRuntimeFailure, noteRuntimeSucceeded, runtimeCooldown, clearRuntimeCooldown, parseRetryHint } from "../runtime/runtime-cooldown";
import { recordResolvedAlias } from "../runtime/model-discovery-store";
import { setResolvedCliModelAlias } from "../../shared/models";
import { buildMcpConfigFile, isKeylessPlaywrightMcpDuplicate, type BrowserApprovalScope } from "../mcp-tools/mcp-config";
import { AGENTLAS_WORKSPACE_PREVIEW_CATALOG_ID } from "../workspace-preview/mcp-server";
import { AGENTLAS_UI_CATALOG_ID } from "../ui-schema/mcp-server";
import { AGENTLAS_TURN_CATALOG_ID } from "../turn-tools/mcp-server";
import { takeTurnAsks, takeTurnMemoryNotes, turnNotesKey } from "../turn-tools/notes";
import { applyGoalSignalsToText, takeGoalSignals, typedGoalDeadlineClause, typedGoalLifecycleProtocol } from "../turn-tools/goal-signals";
import { turnToolReplacesText } from "../turn-tools/attach";
import { appendTurnAsks } from "../turn-tools/ask";
import type { WorkspacePreviewOwnerGrant } from "../workspace-preview/channel";
import { MCP_TOOL_CATALOG } from "../mcp-tools/catalog";
import { resolveMcpNeeds } from "../mcp-tools/need-resolver";
import { mcpServerConfigurationDigest, preparedMcpBindings } from "../mcp-tools/prepared-transport";
import { createOneScopedMcpPreflight } from "../mcp-tools/one-scoped-preflight";
import { resolveOnePersonalNativeMcpSelection, captureOnePersonalNativeOriginal, captureOnePersonalNativePending } from "../secrets/one-personal-native-main-owner";
import { createWorkerCapabilityPreparer, WorkerCapabilityMaterializationError } from "./worker-capability-preparer";
import { WorkerCapabilityError, type PrepareWorkerCapabilities } from "./worker-capabilities";
import { browserCdpHostFailureDiagnostic } from "../mcp-tools/browser-cdp-launcher";
import {
  refreshBrowserCredentialsBeforeAutomatedRun,
  type BrowserCredentialRefreshReport,
} from "../browser/credential-sync";
import { buildAgentAppRunnerEnv, buildRunnerEnv, restrictedRunnerEnv } from "../runtime/env-resolver";
import { claimRenameAnnouncement, renameSuggestionNotice } from "../runtime/env-key-reach";
import { agentRunCwd } from "../runtime/exec";
import { codexUserConfigOutsideBrowser } from "../runtime/codex-desktop-surface";
import { generateImage, removeGeneratedImageArtifact } from "../multimodal/image";
import { copyGeneratedImageIntoWorkspace } from "../multimodal/workspace-image-copy";
import { multimodalImageSlot } from "../multimodal/slot";
import { chatImageAttachmentFromTrustedFile } from "../store/chat-message-attachments";
import { ownerVisiblePrompt, stripStaffGuidance } from "../one/owner-prompt";
import { browserCaptureDir, savedBrowserCaptureDir, screenCaptureDir } from "../media/capture-artifacts";
import { userDataPath } from "../runtime-paths";
import { ONE_ATTACHMENT_LIMITS } from "../../shared/one-attachments";
import { effectiveInvocationPermission } from "../../shared/invocation-permission";
import {
  revalidateInvocationWorkspaceBinding,
  assertInvocationWorkspaceSourceContext,
  type InvocationWorkspaceBinding,
} from "../invocation/workspace-binding";
import {
  runnerFailureFromError,
  runnerRefusedBeforeDispatch,
  runnerResultRefusedBeforeDispatch,
  runtimeFailureIsClosedHttpRefusal,
  RuntimeTurnUnsettledError,
  RuntimeNoProgressError,
  RUNTIME_TURN_UNSETTLED_CODE,
  type Runner,
  type RunnerFailure,
  type RunnerEvents,
  type RunnerRequest,
  type RuntimeTurnDelivery,
  SURFACE_INTENT_MARKER,
  UNATTENDED_NO_ASK_DIRECTIVE,
  MOBILE_DURABLE_ASK_DIRECTIVE,
} from "../runtime/runner";
import { markRefusedBeforeDispatch, outwardFailureCode, refusalCode, unsettledTurnError, validatedRunnerNativeControlState } from "../runtime/runner";
import { decideTurnSettlement, innermostTypedCode, isTypedCode, STORE_BUSY_CODE } from "../../shared/turn-settlement";
import { WORK_PROJECT_RESIDENCY_BUSY_CODE } from "../runtime/project-residency";
import {
  effortForSelectedModel,
  pickActive,
  pickRunner,
  pinnedRuntimeCredentialOrModelUnavailable,
  rolePriorityRuntimes,
  runtimeFailureBlocksReplay,
  runtimeDisplayName,
  selectInvocationRuntime,
} from "../runtime/selection";
import { pickLocale, tStatus } from "../runtime/status-i18n";
import { untrustedRuntimeFailurePayload } from "../runtime/untrusted-error";
import { extractBuildInterviewQuestions } from "../../shared/build-turn";
import {
  oneTeamRuntimeBinding,
  oneTeamRuntimeBindingMatches,
  type OneTeamRuntimeBinding,
} from "../one/team-preflight";
import {
  exactOneParticipantEffectivePrompt,
  validatedOneParticipantEffectivePromptMap,
  type OneParticipantExecutionSnapshot,
  type OneParticipantEffectivePromptSnapshot,
} from "../one/task-kind";
import {
  mainOneAttachmentContext,
  redactOneAttachmentEvent,
  redactOneAttachmentText,
} from "../one/attachments";
import {
  materializeToolBroker,
  type MaterializedToolBroker,
} from "../workflow/tool-broker-runtime";
import type { ToolBrokerLevel } from "../../shared/graph-tool-broker";
import { runtimeKindCanUseMcp, RUNTIME_MCP_SUPPORT } from "../../shared/runtime-mcp";
import { RUNTIME_NATIVE_CAPABILITIES } from "../runtime/native-capabilities";
import { listInstalledPluginCandidates, pluginSlugsNamedInToolEvent } from "../plugins/plugin-candidates";
import type {
  Chat,
  AppFactoryAppRecord,
  ImageAttachment,
  InstalledAgent,
  McpInvocationEvent,
  McpInvocationRequest,
  InvocationRuntimeFailure,
  AgentlasSurfaceManifest,
  JsonObject,
  OrchestrationTarget,
  ProjectAgentPoolMember,
  RecStage,
  RecRouterAgent,
  RuntimeSelection,
  RuntimeStatus,
} from "../../shared/types";

/** Runtimes whose read permission keeps a configured tool surface usable. Antigravity's headless
 * read mode refuses it outright (runtime/antigravity.ts antigravityReadToolFailure). */
const OBSERVATION_READ_TOOL_CAPABLE = (kind: string): boolean => kind !== "antigravity";

/**
 * Bounded machine code for an MCP preparation failure. Plain Errors used to collapse to
 * "unknown"; we accept only a machine-shaped message, a Node/SQLite `code`, or the error
 * class name — never free-form prose, paths or values.
 */
function mcpConfigFailureCode(err: unknown): string | null {
  const machine = /^[a-z][a-z0-9_-]{2,80}$/;
  if (err instanceof Error && machine.test(err.message)) return err.message;
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_-]{1,60}$/.test(code)) return code.toLowerCase();
  if (err instanceof Error && /^[A-Za-z][A-Za-z0-9]{1,60}$/.test(err.name)) return `error-class:${err.name}`;
  return null;
}

const ONE_LOCAL_ARTIFACT_PATH_KEYS = ["path", "filePath", "localPath", "file"] as const;
const ONE_LOCAL_ARTIFACT_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp",
  ".mp4", ".webm", ".mov", ".m4v", ".ogv",
  ".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac",
  ".pdf", ".docx", ".txt", ".md", ".xlsx", ".csv", ".json", ".zip",
  // A One result often includes the focused validator or reusable source that
  // proves the document/data artifact. These remain exact-result-folder files
  // and receive the same filesystem seal before the renderer can open them.
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".sh", ".bash", ".zsh", ".html", ".css", ".scss",
]);

function sealOneLocalArtifactPaths(
  manifest: AgentlasSurfaceManifest,
  resultFolder: string | undefined,
): AgentlasSurfaceManifest {
  if (!resultFolder || !path.isAbsolute(resultFolder)) return manifest;
  let root: string;
  try {
    root = fs.realpathSync.native(path.resolve(resultFolder));
  } catch {
    return manifest;
  }
  const insideRoot = (candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const sealRow = (row: JsonObject): JsonObject => {
    const next = { ...row };
    for (const key of ONE_LOCAL_ARTIFACT_PATH_KEYS) {
      const value = row[key];
      if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.includes("://")) continue;
      const candidate = path.resolve(root, value.trim());
      if (!insideRoot(candidate)) continue;
      try {
        const canonical = fs.realpathSync.native(candidate);
        const stat = fs.lstatSync(candidate);
        if (canonical === candidate && stat.isFile()) next[key] = canonical;
      } catch {
        // A claimed file that is absent or linked never gains local authority.
      }
    }
    return next;
  };
  const verifiedArtifactRow = (row: JsonObject): JsonObject | null => {
    const claimedPath = ONE_LOCAL_ARTIFACT_PATH_KEYS
      .map((key) => row[key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const claimedLabel = [row.label, row.name, row.title]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const claim = (claimedPath || claimedLabel || "").trim();
    if (!claim || claim.includes("://")) return null;
    const candidate = path.isAbsolute(claim) ? path.resolve(claim) : path.resolve(root, claim);
    if (!insideRoot(candidate) || !ONE_LOCAL_ARTIFACT_EXTENSIONS.has(path.extname(candidate).toLocaleLowerCase())) return null;
    try {
      const canonical = fs.realpathSync.native(candidate);
      const stat = fs.lstatSync(candidate);
      if (canonical !== candidate || !stat.isFile()) return null;
      return {
        ...row,
        label: claimedLabel?.trim() || path.basename(canonical),
        path: canonical,
      };
    } catch {
      return null;
    }
  };
  return {
    ...manifest,
    data: Object.fromEntries(Object.entries(manifest.data).map(([key, dataset]) => {
      if (dataset.type !== "artifacts" && dataset.type !== "media") return [key, dataset];
      if (dataset.type === "artifacts") {
        return [key, {
          ...dataset,
          ...(Array.isArray(dataset.rows) ? { rows: dataset.rows.flatMap((row) => {
            const verified = verifiedArtifactRow(row);
            return verified ? [verified] : [];
          }) } : {}),
          ...(Array.isArray(dataset.items) ? { items: dataset.items.flatMap((item) => {
            const verified = verifiedArtifactRow(item);
            return verified ? [verified] : [];
          }) } : {}),
        }];
      }
      return [key, {
        ...dataset,
        ...(Array.isArray(dataset.rows) ? { rows: dataset.rows.map((row) => sealRow(row)) } : {}),
        ...(Array.isArray(dataset.items) ? { items: dataset.items.map((item) => sealRow(item)) } : {}),
      }];
    })),
  };
}

/**
 * Installed plugin slugs the agent looked up or opened during the most recent
 * earlier run of this chat. They are attached on this turn automatically; the
 * slugs are re-checked against the installed plugin root by auto-select, so a
 * Hub plugin that is not installed can never be attached this way.
 */
function readMidTurnPluginRequests(chatId: string, currentRunId?: string): string[] {
  try {
    const rows = getDb().prepare(
      "SELECT run_id, payload_json FROM run_events WHERE chat_id = ? AND kind = 'plugin_requested_mid_turn' ORDER BY rowid DESC LIMIT 20",
    ).all(chatId) as Array<{ run_id: string; payload_json: string }>;
    const latestRun = rows.find((row) => row.run_id !== currentRunId)?.run_id;
    if (!latestRun) return [];
    const slugs = new Set<string>();
    for (const row of rows) {
      if (row.run_id !== latestRun) continue;
      const payload = JSON.parse(row.payload_json) as { slugs?: unknown };
      if (!Array.isArray(payload.slugs)) continue;
      for (const slug of payload.slugs) if (typeof slug === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/u.test(slug)) slugs.add(slug);
    }
    return [...slugs].slice(0, 8);
  } catch {
    return [];
  }
}

function mainOneProfileContext(req: McpInvocationRequest): string {
  const value = (req as McpInvocationRequest & { oneProfileContext?: unknown }).oneProfileContext;
  return typeof value === "string" && value.length > 0 && value.length <= 16_000 ? value : "";
}

type MainBoundOneInvocationRequest = McpInvocationRequest & {
  oneTeamExecutionPolicy?: "solo_locked" | "confirmed_existing_roster" | "confirmed_external_workforce" | "native_one_staffing";
  oneTeamStaffingAuthority?: OneTeamStaffingAuthority;
  oneTeamRuntimeBinding?: OneTeamRuntimeBinding;
  oneParticipantExecutionSnapshot?: OneParticipantExecutionSnapshot;
};

function mainOneTeamExecutionPolicy(
  req: McpInvocationRequest,
): MainBoundOneInvocationRequest["oneTeamExecutionPolicy"] {
  const value = (req as MainBoundOneInvocationRequest).oneTeamExecutionPolicy;
  return value === "solo_locked"
    || value === "confirmed_existing_roster"
    || value === "confirmed_external_workforce"
    || value === "native_one_staffing"
    ? value
    : undefined;
}

function mainOneTeamRuntimeBinding(req: McpInvocationRequest): OneTeamRuntimeBinding | undefined {
  const value = (req as MainBoundOneInvocationRequest).oneTeamRuntimeBinding;
  return value && typeof value === "object" ? value : undefined;
}

function mainOneParticipantExecutionSnapshot(req: McpInvocationRequest): unknown {
  return (req as MainBoundOneInvocationRequest).oneParticipantExecutionSnapshot;
}

/**
 * One is the only controller allowed to start owner Cloud, Build, or federated
 * Network routes. `hep-network --stormbreaker` is a legacy spelling of the
 * local Storm command and intentionally remains available to every teammate.
 */
export function oneControllerOnlyHephaestusCommand(prompt: string): "build" | "cloud" | "network" | null {
  if (/^\s*\/?hep-network\s+--stormbreaker\b/i.test(prompt)) return null;
  const match = prompt.match(/^\s*\/?hep-(build|cloud|network)\b/i);
  return match ? match[1].toLowerCase() as "build" | "cloud" | "network" : null;
}

type EventSink = (ev: McpInvocationEvent) => void;
const careerGraphRefreshTriggered = new Set<string>();

function browserCredentialSyncNotice(
  report: BrowserCredentialRefreshReport,
  locale: "ko" | "en",
): NonNullable<McpInvocationEvent["notice"]> {
  const loginRequired = report.requiresLoginSites.length > 0;
  const ko = report.state === "refreshed"
    ? loginRequired
      ? `그래프 실행 전 세션을 동기화했지만 ${report.requiresLoginSites.length}개 사이트는 Agentlas Browser에서 한 번 로그인이 필요합니다.`
      : `그래프 실행 전 Agentlas Browser 세션을 동기화했습니다 — ${report.linkedSites.length}개 사이트, ${report.cookiesAdded}개 쿠키.`
    : report.state === "not-consented"
      ? "가져오기를 승인한 브라우저 세션이 없어 기존 Agentlas Browser 세션으로 실행합니다."
      : report.state === "failed"
        ? "그래프 실행 전 세션 동기화에 실패해 기존 Agentlas Browser 세션으로 계속합니다."
        : report.state === "discarded"
          ? "동기화 중 브라우저 승인 범위가 바뀌어 결과를 폐기했습니다. 기존 Agentlas Browser 세션으로 계속합니다."
          : "Agentlas Browser 세션이 이미 최근 동기화되어 그대로 사용합니다.";
  const en = report.state === "refreshed"
    ? loginRequired
      ? `The session was synced before this graph, but ${report.requiresLoginSites.length} site(s) need one login in Agentlas Browser.`
      : `Agentlas Browser session synced before this graph — ${report.linkedSites.length} site(s), ${report.cookiesAdded} cookie(s).`
    : report.state === "not-consented"
      ? "No consented browser session import is available; continuing with the existing Agentlas Browser session."
      : report.state === "failed"
        ? "Session sync failed before this graph; continuing with the existing Agentlas Browser session."
        : report.state === "discarded"
          ? "The browser consent scope changed during sync, so its result was discarded; continuing with the existing Agentlas Browser session."
          : "The Agentlas Browser session was synced recently and is reused as-is.";
  return {
    level: report.state === "failed" || loginRequired ? "warning" : report.state === "refreshed" ? "success" : "info",
    code: "browser-session-sync",
    message: locale === "ko" ? ko : en,
    i18n: { ko, en },
  };
}

/**
 * Some host CLIs occasionally stop immediately after opening the hidden
 * memory JSON fence. A language-qualified fence at end-of-message cannot be a
 * valid closing fence, so keeping it only creates an empty black code block in
 * One and Work. Bare closing fences and every complete code block are left
 * untouched.
 */
/** One 복구 패스 프롬프트 — 실패한 필수 단계를 모델이 직접 재실행해 스스로 완주하게 한다. */
function oneRecoveryApprovalExample(locale: "ko" | "en"): string {
  return locale === "ko"
    ? '<<agentlas-ask>>{"header":"해결안","question":"제가 [구체적인 해결 조치]를 실행해서 이 작업을 계속할까요?","options":[{"label":"해결하고 계속","description":"제안한 조치를 승인하고 같은 작업을 이어서 완료합니다."},{"label":"다른 방법 선택","description":"실행하지 않고 다른 해결 방법을 정합니다."}],"multiSelect":false}<</agentlas-ask>>'
    : '<<agentlas-ask>>{"header":"Solution","question":"Should I carry out [specific repair] and continue this task?","options":[{"label":"Fix and continue","description":"Approve the proposed action and continue the same task."},{"label":"Choose another way","description":"Do not execute it and choose a different solution."}],"multiSelect":false}<</agentlas-ask>>';
}

function buildOneRecoveryPrompt(previousText: string, attempt: number, locale: "ko" | "en"): string {
  const clipped = previousText.length > 6_000 ? previousText.slice(-6_000) : previousText;
  return [
    `recovery pass ${attempt}: a required tool step failed; find it, re-run it or take another path to the same outcome, verify with tool evidence, then write the complete result`,
    `only if the next safe action needs the owner's authority, credentials, money or a consequential choice: propose the exact repair as one choice card (ask_form, or ${oneRecoveryApprovalExample(locale)})`,
    "never apologize, expose internal errors or ask for a retry",
    "<previous-output>",
    clipped,
    "</previous-output>",
  ].join("\n");
}

function buildOneRecoveryDecisionPrompt(previousText: string, locale: "ko" | "en"): string {
  const clipped = previousText.length > 6_000 ? previousText.slice(-6_000) : previousText;
  return [
    "recovery decision: no tools this pass; pick the most practical repair One can run after approval, say it in one sentence, then exactly one choice card (first option approves that action, second keeps the owner in control without claiming completion); no retry requests, tool names or raw errors",
    `card: ${oneRecoveryApprovalExample(locale)}`,
    "<previous-output>",
    clipped,
    "</previous-output>",
  ].join("\n");
}

function hasOneRecoveryDecision(text: unknown): boolean {
  return extractBuildInterviewQuestions(text).length > 0;
}

/** Never omit state just because a runtime advertises session support. */


/** Requests are not successes. An exact successful retry resolves that failed operation. */
function createOneToolFailureTracker(): { note: (tool: NonNullable<McpInvocationEvent["tool"]>) => boolean; unresolved: () => boolean } {
  const pending = new Map<string, string>();
  const completed = new Set<string>();
  const failed = new Set<string>();
  let overflowFailure = false;
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  return {
    note(tool): boolean {
      const id = tool.id?.trim();
      if (id && completed.has(id)) return false;
      let key: string | undefined;
      if (tool.args !== undefined) {
        let args: unknown = tool.args;
        try { args = JSON.parse(tool.args); } catch { /* Keep non-JSON arguments exact. */ }
        key = createHash("sha256").update(`${tool.name.trim().toLowerCase()}\0${canonical(args)}`).digest("hex");
      } else if (id) key = pending.get(id);
      if (tool.result === undefined && tool.isError !== true) {
        if (id && key) {
          if (pending.size >= 4096 && !pending.has(id)) pending.delete(pending.keys().next().value!);
          pending.set(id, key);
        }
        return false;
      }
      if (id) {
        pending.delete(id);
        if (completed.size >= 4096) completed.delete(completed.values().next().value!);
        completed.add(id);
      }
      if (!key) { if (tool.isError === true) overflowFailure = true; return true; }
      if (tool.isError === true) {
        if (failed.size >= 4096 && !failed.has(key)) overflowFailure = true;
        else failed.add(key);
      } else if (tool.result !== undefined && tool.isError === false) failed.delete(key);
      return true;
    },
    unresolved: () => overflowFailure || failed.size > 0,
  };
}

/**
 * Positive image-generation intent is a host capability contract, not a
 * renderer hint. Keep it conservative so opening or inspecting an existing
 * image never causes a new image to be generated behind the user's back.
 */
export function naturalLanguageRequiresImageGeneration(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  const text = prompt
    .normalize("NFKC")
    .replace(/\b(?:do\s+not|don't|never)\s+(?:create|generate|draw|illustrate|design|make|render|compose|produce)\b/giu, " ")
    .replace(/(?:만들|생성|그리|그려|제작|디자인)(?:지\s*(?:마|말|않)|하지\s*(?:마|말|않))/gu, " ")
    .toLowerCase();
  const clauses = text
    .split(/(?:[.!?\n;:。！？；：]+|\s+(?:그리고|하지만|또는|및|and|but|or|then)\s+)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const visual = /(?:이미지|사진|그림|포스터|일러스트(?:레이션)?|도표|다이어그램|아이콘|로고|배너|삽화|작품|image|photo|picture|poster|illustration|drawing|diagram|icon|logo|banner|artwork|graphic|visual)/iu;
  const generation = /(?:만들|생성|그리|그려|제작|디자인|create|generate|draw|illustrate|design|make|render|compose|produce|generation|creation|production)/iu;
  return clauses.some((clause) => visual.test(clause) && generation.test(clause));
}

/**
 * 사용자가 **화면을 찍어 보여 달라**고 했는가.
 *
 * `naturalLanguageRequiresImageGeneration` 과 일부러 나눠 둔다. 그쪽 깃발은 멀티모달
 * 엔진으로 그림을 **생성**까지 하므로, 스크린샷 요청에 그 깃발을 켜면 python.org 를
 * 찍는 대신 python.org 를 그려 버린다. 여기서 필요한 것은 생성이 아니라 **증거 요구**다.
 *
 * 배경(2026-09-04 실측): "파이썬 공식 사이트 화면 한 장 찍어서 보여줘" 에 모델이
 * "캡처해 위에 표시했습니다" 라고 답했는데 채팅에 이미지가 없고 새 파일도 없었다.
 * 그리기 요청에는 이미 증거 관문이 있었지만 어휘가 이미지·사진·그림뿐이라
 * 화면·스크린샷·캡처는 통과했다.
 */
export function naturalLanguageRequiresScreenCapture(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  const text = prompt
    .normalize("NFKC")
    .replace(/\b(?:do\s+not|don't|never)\s+(?:capture|screenshot|screengrab)\b/giu, " ")
    .replace(/(?:찍|캡처|캡쳐)(?:지\s*(?:마|말|않)|하지\s*(?:마|말|않))/gu, " ")
    .toLowerCase();
  const clauses = text
    .split(/(?:[.!?\n;:。！？；：]+|\s+(?:그리고|하지만|또는|및|and|but|or|then)\s+)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const surface = /(?:화면|스크린샷|스크린\s*샷|캡처|캡쳐|screenshot|screen\s*shot|screen\s*capture|screengrab)/iu;
  /*
   * 명사를 지운 **뒤에** 동사가 남아야 한다.
   *
   * 캡처·screenshot 은 명사이자 동사라, 둘을 각각 찾으면 한 단어가 두 조건을 혼자
   * 만족시킨다. 그래서 "캡처가 안 된 이유를 알려줘" 같은 **질문**이 캡처 요청으로
   * 읽혔다(2026-09-04 게이트가 잡음). 오탐은 정상 대화를 오류로 끝내므로 값이 크다.
   */
  const capture = /(?:찍|담아|떠\s*(?:줘|주|서)|take|grab|get|make)/iu;
  // 명사에 곧바로 붙은 동사형(캡처해줘 · 스크린샷 찍어)은 위 규칙으로는 명사만 남으므로
  // 따로 받는다. 일반 "해줘" 를 동사 목록에 넣으면 "설명해줘" 까지 잡힌다.
  const attached = /(?:캡처|캡쳐)\s*(?:해|하)|스크린샷\s*(?:떠|찍|해)/iu;
  return clauses.some((clause) => {
    if (!surface.test(clause)) return false;
    if (attached.test(clause)) return true;
    const withoutNoun = clause.replace(surface, " ");
    return capture.test(withoutNoun);
  });
}

function wrapOneRecoveryProposal(text: string, locale: "ko" | "en"): string {
  const proposal = text
    .replace(/<<agentlas-ask>>[\s\S]*?(?:<<\/agentlas-ask>>|$)/gu, "")
    .trim()
    .slice(0, 2_000)
    || (locale === "ko"
      ? "One이 막힌 단계의 조건을 다시 점검하고 안전한 대체 실행 경로를 적용하겠습니다."
      : "One will re-check the blocked step and apply a safe alternative execution path.");
  const question = locale === "ko"
    ? "제가 위 해결안을 실행해서 이 작업을 계속할까요?"
    : "Should I carry out the solution above and continue this task?";
  const options = locale === "ko"
    ? [
        { label: "해결하고 계속", description: "제안한 조치를 승인하고 같은 작업을 이어서 완료합니다." },
        { label: "다른 방법 선택", description: "실행하지 않고 다른 해결 방법을 정합니다." },
      ]
    : [
        { label: "Fix and continue", description: "Approve the proposed action and continue the same task." },
        { label: "Choose another way", description: "Do not execute it and choose a different solution." },
      ];
  return `${proposal}\n\n<<agentlas-ask>>${JSON.stringify({
    header: locale === "ko" ? "해결안" : "Solution",
    question,
    options,
    multiSelect: false,
  })}<</agentlas-ask>>`;
}

function stripDanglingLanguageFence(text: string): string {
  return text.replace(/\n[ \t]*```[A-Za-z0-9_+.-]+[ \t]*$/u, "").trim();
}

/**
 * 실행이 실패했을 때 사람에게 보여줄 것.
 *
 * ★한도는 고장이 아니라 **풀 수 있는 상태**다. 여기는 제공자가 준 문장을 그대로
 * 실어 보냈고, 그래서 한국어 화면에 `claude runtime quota: You've hit your weekly
 * limit · resets Aug 29 at 6pm` 이 떴다 — 읽어도 무엇을 하면 되는지 알 수 없다
 * (라이브 실측 2026-08-26, 오너 지적). 팀 작업에서는 더 나빴다: **팀원은 답을
 * 보내 왔는데** 그 뒤 정리 단계가 한도에 걸려, 사람은 도착한 답을 실패로 읽었다.
 *
 * 어느 런타임이 왜 멈췄고 무엇을 하면 되는지 먼저 말하고, 리셋 시각이 담긴 원문은
 * 뒤에 그대로 붙인다(사실을 지우지 않는다).
 */
class InvocationRunnerFailureError extends Error {
  readonly #failure: Readonly<RunnerFailure>;
  /** The runner's own RuntimeTurnDelivery for this failure; "not-dispatched" reaches run-graph as a definite non-execution. */
  readonly turnDelivery?: RuntimeTurnDelivery;

  constructor(failure: RunnerFailure, includeHeuristic = false, turnDelivery?: RuntimeTurnDelivery) {
    super(`${failure.runtime} runtime ${failure.kind}${includeHeuristic && failure.source === "heuristic" ? " (appears)" : ""}: ${failure.message}`);
    this.#failure = Object.freeze({ ...failure });
    if (turnDelivery) this.turnDelivery = turnDelivery;
  }

  static isMarkedQuota(error: unknown): boolean {
    const failure = InvocationRunnerFailureError.providerFailure(error);
    return failure?.kind === "quota" && failure.source === "marker";
  }

  static providerFailure(error: unknown): Readonly<RunnerFailure> | null {
    if (error instanceof InvocationRunnerFailureError && (#failure in error)) return error.#failure;
    if (error instanceof RuntimeTurnUnsettledError || error instanceof RuntimeNoProgressError) {
      return runnerFailureFromError(error, error.runtimeKind);
    }
    return ObservedRunnerFailureError.providerFailure(error)
      ?? TaskForceRuntimeFailureError.providerFailure(error);
  }

  static imageInputFailure(error: unknown): { code: string; message: string } | null {
    // Only the host's typed runner-result boundary can mint this brand. A
    // provider message, serialized error or forged prototype is not evidence.
    if (!(error instanceof InvocationRunnerFailureError) || !(#failure in error)) return null;
    const failure = error.#failure;
    if (failure.kind !== "unsupported" || failure.runtime !== "agentlas-local"
      || failure.source !== "marker" || failure.providerCode !== "local_model_image_input_unsupported") return null;
    return { code: failure.providerCode, message: failure.message };
  }

  static localContextFailure(error: unknown): { code: string; message: string } | null {
    if (!(error instanceof InvocationRunnerFailureError) || !(#failure in error)) return null;
    const failure = error.#failure;
    if (!modelContextFailureReason(failure) || !failure.providerCode) return null;
    return { code: failure.providerCode, message: failure.message };
  }

  static readToolScopeFailure(error: unknown): { code: string; message: string } | null {
    if (!(error instanceof InvocationRunnerFailureError) || !(#failure in error)) return null;
    const failure = error.#failure;
    if (failure.kind !== "refused" || failure.runtime !== "antigravity"
      || failure.source !== "marker" || failure.providerCode !== "agy_read_tools_unsupported") return null;
    return { code: failure.providerCode, message: failure.message };
  }

  static projectResidencyBusyFailure(error: unknown): { code: string; message: string } | null {
    if (error && typeof error === "object" && "code" in error && error.code === WORK_PROJECT_RESIDENCY_BUSY_CODE) {
      return {
        code: WORK_PROJECT_RESIDENCY_BUSY_CODE,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const failure = error instanceof InvocationRunnerFailureError && (#failure in error)
      ? error.#failure
      : error && typeof error === "object" && "failure" in error && error.failure && typeof error.failure === "object"
        ? error.failure as RunnerFailure
        : null;
    if (!failure) return null;
    if (failure.kind !== "refused" || failure.source !== "marker" || failure.providerCode !== WORK_PROJECT_RESIDENCY_BUSY_CODE) return null;
    return { code: failure.providerCode, message: failure.message };
  }
}

function invocationRuntimeFailure(error: unknown, now = Date.now()): InvocationRuntimeFailure | null {
  const failure = InvocationRunnerFailureError.providerFailure(error);
  if (!failure || !["quota", "rate_limit", "auth", "refused"].includes(failure.kind)) return null;
  const reset = failure.kind === "quota" || failure.kind === "rate_limit" ? parseRetryHint(failure.retryAfterHint, now) : null;
  return {
    kind: failure.kind as InvocationRuntimeFailure["kind"],
    source: failure.source,
    ...(failure.providerCode && /^[a-zA-Z0-9_.-]{1,96}$/.test(failure.providerCode)
      ? { providerCode: failure.providerCode } : {}),
    ...(reset !== null && reset > now && reset <= now + 30 * 24 * 60 * 60_000
      ? { retryAfterAt: new Date(reset).toISOString() } : {}),
  };
}

function invocationFailure(
  req: McpInvocationRequest,
  fallbackCode: string,
  error: unknown,
  executionContext?: InvocationExecutionContext,
): { code: string; message: string; runtimeFailure?: InvocationRuntimeFailure } {
  if (req.agentAppMode) return untrustedRuntimeFailurePayload();
  const runtimeFailure = invocationRuntimeFailure(error);
  const typedFailure = InvocationRunnerFailureError.providerFailure(error);
  if (typedFailure?.source === "marker" && runtimeFailureBlocksReplay(typedFailure)) {
    return { code: typedFailure.providerCode!, message: error instanceof Error ? error.message : String(error),
      ...(runtimeFailure ? { runtimeFailure } : {}) };
  }
  const projectResidencyFailure = InvocationRunnerFailureError.projectResidencyBusyFailure(error);
  if (projectResidencyFailure) {
    const ko = "이 Work 프로젝트의 다른 채팅에서 에이전트가 아직 실행 중이라 새 CLI를 시작하지 않았습니다. 현재 실행이 끝난 뒤 다시 보내 주세요. 기존 대화와 입력은 보존됩니다.";
    const en = "Another chat in this Work project is still using its provider. The new CLI was not started; send again after the current turn finishes. Your existing transcript and input are preserved.";
    return { code: projectResidencyFailure.code, message: pickLocale(req) === "ko" ? ko : en,
      ...(runtimeFailure ? { runtimeFailure } : {}) };
  }
  const capabilityFailure = InvocationRunnerFailureError.imageInputFailure(error)
    ?? InvocationRunnerFailureError.localContextFailure(error)
    ?? InvocationRunnerFailureError.readToolScopeFailure(error);
  if (capabilityFailure) return { ...capabilityFailure, ...(runtimeFailure ? { runtimeFailure } : {}) };
  const raw = error instanceof Error ? error.message : String(error);
  /*
   * The outward code is the failure's innermost machine code (shared/turn-settlement.ts): the typed runner failure's
   * provider code, else the thrown error's own code, its cause chain's, or a message that is itself a code. The caller's
   * fallback code is used only when the failure carries none (docs 31 W1, audit A7 M11: the AGI monitor filed 58
   * incidents of unknown cause because runner-failed replaced codes such as goal_episode_admission_missing).
   */
  const typedCode = (isTypedCode(typedFailure?.providerCode) ? typedFailure!.providerCode : undefined) ?? outwardFailureCode(error);
  if (typedCode === STORE_BUSY_CODE) {
    // The local store stayed locked by another write (R-067): its own code, never runner-failed, and whether it can be sent again.
    const beforeDispatch = runnerRefusedBeforeDispatch(error);
    const ko = beforeDispatch
      ? "Agentlas 저장소가 다른 기록으로 잠겨 있어 모델에 보내기 전에 멈췄습니다. 모델에는 아무것도 보내지 않았으니 다시 보내도 됩니다."
      : "Agentlas 저장소가 다른 기록으로 잠겨 있어 이 턴을 끝까지 기록하지 못했습니다. 이미 실행됐을 수 있어 자동으로 다시 보내지 않았습니다.";
    const en = beforeDispatch
      ? "The Agentlas store stayed locked by another write, so this turn stopped before anything was sent to the model. Nothing reached the model; it is safe to send again."
      : "The Agentlas store was locked by another write, so this turn could not be fully recorded. It may already have run, so it was not sent again automatically.";
    return { code: STORE_BUSY_CODE, message: `${pickLocale(req) === "ko" ? ko : en} (${raw})`, ...(runtimeFailure ? { runtimeFailure } : {}) };
  }
  if (runtimeFailure?.kind === "auth" || runtimeFailure?.kind === "refused") {
    return { code: typedCode ?? (runtimeFailure.kind === "auth" ? "runtime_auth" : "runtime_refused"), message: raw, runtimeFailure };
  }
  if (typedCode && runtimeFailure?.kind !== "quota") {
    return { code: typedCode, message: raw, ...(runtimeFailure ? { runtimeFailure } : {}) };
  }
  // Prose is read only for an untyped throw (no machine code anywhere in it): the legacy quota wording.
  const quota = runtimeFailure?.kind === "quota" ? runtimeFailure.kind : /\bquota\b|hit your weekly limit|usage limit/i.test(raw)
    ? raw.match(/^([a-z0-9-]+) runtime quota:/i)?.[1] ?? null
    : undefined;
  if (quota !== undefined) {
    const who = quota === "quota" ? InvocationRunnerFailureError.providerFailure(error)?.runtime ?? "this model"
      : quota ?? (pickLocale(req) === "ko" ? "이 모델" : "this model");
    let timeZone: string | undefined;
    try {
      timeZone = (executionContext?.source === "automation" && req.automationId
        ? getAutomation(req.automationId)?.timezone
        : getOneProfile().timeZone) ?? undefined;
    } catch { /* Display-only fallback uses the local time zone. */ }
    return {
      code: typedCode ?? "runtime_quota",
      ...(runtimeFailure ? { runtimeFailure } : {}),
      message: runtimeQuotaFailureMessage({ runtime: who, locale: pickLocale(req),
        retryAfterAt: runtimeFailure?.retryAfterAt, unattended: isUnattendedExecution(executionContext), timeZone }),
    };
  }
  const toolFailureCode = classifyToolFailure({ result: raw });
  if (toolFailureCode !== "tool_failed") {
    const locale = pickLocale(req);
    return {
      code: toolFailureCode,
      message: `${toolFailureCopy(toolFailureCode, locale) ?? raw} (${raw})`,
    };
  }
  return { code: fallbackCode, message: raw };
}

/** Planning can execute tools on the pinned runtime; account it and keep its typed terminal cause. */
async function runInvocationPlanningRunner(
  runner: Runner,
  request: RunnerRequest,
  events: RunnerEvents,
  runtime: RuntimeStatus,
  assertCurrent?: () => void,
  graphAttempt?: GraphWorkerAttempt,
): Promise<Awaited<ReturnType<Runner>>> {
  assertCurrent?.();
  const accounting = beginAccountedInference({ kind: runtime.kind, model: runtime.model, source: runtime.source });
  try {
    assertCurrent?.();
    currentHistoryRuntimeFence()?.assertRuntimeCoverage(runtime.kind);
    noteGraphWorkerDispatch(graphAttempt, selectionForRuntime(runtime));
    let result = await runObservedRunner(runner, request, events, runtime.kind);
    if (result.ownerControlTerminal !== "completed") {
      result = { ...result, ownerControlTerminal: "uncertain",
        failure: result.failure ?? runnerFailureFromError(new RuntimeTurnUnsettledError(runtime.kind, request.locale), runtime.kind) };
    }
    accounting?.complete(result.observedUsage,
      request.signal?.aborted ? "cancelled" : result.failure ? "failed" : "returned");
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("invocation_cancelled");
    if (result.failure) throw new InvocationRunnerFailureError(result.failure);
    return result;
  } catch (error) {
    accounting?.complete(observedRunnerUsage(error), request.signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}

function throwIfInvocationAborted(signal: AbortSignal | undefined, locale: "ko" | "en"): void {
  if (signal?.aborted) throw new Error(tStatus(locale, "aborted"));
}

/** 방출된 "agent" 필드(id/slug/표시명, 대소문자 무시)를 설치 에이전트로 해석. 못 찾으면 null. */
function resolveInstalledAgentLoose(query: string): InstalledAgent | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const direct = getAgentById(query.trim());
  if (direct) return direct;
  const all = listInstalledAgents();
  return (
    all.find((ag) => ag.slug.toLowerCase() === needle) ??
    all.find(
      (ag) =>
        ag.name.trim().toLowerCase() === needle ||
        (ag.nameEn ?? "").trim().toLowerCase() === needle,
    ) ??
    null
  );
}

function cleanPathCandidate(raw: string | undefined): string | null {
  const cleaned = raw?.trim().replace(/^`|`$/g, "").replace(/[),.;]+$/g, "");
  if (!cleaned || !path.isAbsolute(cleaned)) return null;
  return cleaned;
}

/** reasoning 전문 상한 — 원장 payload와 IPC를 지킨다(Claude thinking은 수만 자가 될 수 있다). */
const REASONING_SPAN_TEXT_CAP = 6_000;

/**
 * 사람이 쓴 요청에 **이미 있는 폴더의 절대 경로가 정확히 하나** 있으면 그 폴더를 잡는다(구조 판정).
 * 2026-10-14: "작업 폴더/working folder" 같은 단어로 고르던 정규식을 뺐다 — 호스트는 단어로 의미를 판단하지
 * 않는다(docs/2026-10-13-native-harness 04 §3). 폴더 경로가 둘 이상이면 어느 쪽인지 모르므로 잡지 않는다.
 *
 * ★두 가지를 못 박는다. 실측 2026-08-20 (E2E 캠페인 E1, 다운로드 폴더 정리 자동화):
 *   사용자 폴더에 `IMG_9931/` 이라는 **없던 폴더**가 생기고 그 안에 `.agentlas`
 *   프로젝트 뼈대 516KB(.env.example · .gitignore · credentials/ · signing/)가 깔렸다.
 *
 *   ① **추측한 경로를 만들지 않는다.** 예전에는 `mkdirSync(candidate, {recursive:true})`
 *      로 없는 폴더를 **만들었다**. 추측이 틀렸을 때 흔적이 남는 쪽으로 틀린 것이다.
 *      이미 있는 폴더만 잡는다 — 없으면 그건 작업 폴더 선언이 아니었다.
 *
 *   ② **기계가 쓴 문장에서는 추측하지 않는다.** 자동화 노드의 프롬프트에는 다루는
 *      파일 경로가 데이터로 들어간다("group key IMG_9931 · target folder …/IMG_9931").
 *      그 경로는 "여기서 일해"가 아니라 "이걸 처리해"다.
 *      실측: 사용자가 쓴 원문은 이 정규식에 **안 걸렸고**, 제품이 스스로 만든 노드
 *      프롬프트가 걸렸다. 즉 사용자가 쓰지도 않은 폴더가 사용자 폴더에 생긴다.
 */
export function inferWorkingFolderFromPrompt(
  prompt: string,
  opts?: { authored: "human" | "machine" },
): string | null {
  if (opts?.authored === "machine") return null;
  const directories = new Set<string>();
  for (const match of prompt.matchAll(/(?:^|[\s`"'(])(\/[^\s`"'<>]+)/g)) {
    const candidate = cleanPathCandidate(match[1]);
    if (!candidate) continue;
    try {
      // 없는 경로는 만들지 않는다 — 추측으로 사용자 폴더에 흔적을 남기지 않는다. 파일 경로도 작업 폴더가 아니다.
      if (fs.statSync(candidate).isDirectory()) directories.add(path.resolve(candidate));
    } catch { /* not an existing path */ }
  }
  return directories.size === 1 ? [...directories][0] : null;
}

function refreshCareerGraphInBackground(projectPath: string, sink: EventSink, locale: "ko" | "en"): void {
  let key: string;
  try {
    key = path.resolve(projectPath);
  } catch {
    return;
  }
  if (careerGraphRefreshTriggered.has(key)) return;
  careerGraphRefreshTriggered.add(key);
  void careerGraphIngest(key, { cwd: key, timeoutMs: 20_000 })
    .then((res) => {
      if (!res.ok) return;
      const counts = (res.json as { nodes?: number; edges?: number } | null) ?? {};
      sink({
        kind: "tool-use",
        status:
          locale === "ko"
            ? `Career Graph 색인 갱신: nodes=${counts.nodes ?? "?"}, edges=${counts.edges ?? "?"}`
            : `Career Graph refreshed: nodes=${counts.nodes ?? "?"}, edges=${counts.edges ?? "?"}`,
      });
    })
    .catch(() => {
      // Best-effort only. The canonical Markdown/JSONL files remain readable.
    });
}

type CurrentUserEnvelope = "one" | "host-facts" | "automation-edit" | "automation-run" | "session" | "preference";

/** Closed framing belongs to each declared body, never to an interleaved owner turn. */
function closedCurrentUserPart(part: DeclaredPromptPart, envelope: CurrentUserEnvelope): DeclaredPromptPart {
  const frames = {
    one: { id: "purpose.one.invocation.frame", revision: 2, open: "[Agentlas One execution boundary]", close: "[/Agentlas One execution boundary]" },
    "host-facts": { id: "user.current.host-facts.frame", revision: 1, open: "[Host-confirmed facts for this run]", close: "[/Host-confirmed facts for this run]" },
    "automation-edit": { id: "user.current.automation-edit.frame", revision: 1, open: "[Agentlas automation edit contract]", close: "[/Agentlas automation edit contract]" },
    "automation-run": { id: "user.current.automation-run.frame", revision: 1, open: "[Agentlas automation execution boundary]", close: "[/Agentlas automation execution boundary]" },
    session: { id: "user.current.session.frame", revision: 1, open: "[Agentlas session-team policy]", close: "[/Agentlas session-team policy]" },
    preference: { id: "user.current.preference.frame", revision: 1, open: "[Explicit preference for this turn]", close: "[/Explicit preference for this turn]" },
  } as const;
  const frame = frames[envelope];
  registerDeclaredPromptModule({ id: frame.id, revision: frame.revision, stability: "fixed-policy", changeTriggers: ["release"] });
  // Framing is a registered static template around one body, not a separate sorted field.
  return { ...part, text: part.text ? `${frame.open}\n${part.text}\n${frame.close}` : "" };
}

function currentUserRequestPart(prompt: string): DeclaredPromptPart {
  return { id: "user.current.request", revision: 1, stability: "turn-context", changeTriggers: ["owner-input", "task", "checkpoint", "child-result", "validation-result"], order: 1000, text: prompt };
}

/** Labels stay with this exact current-request slot; no text parsing or authority reconstruction. */
function labelCurrentUserRequest(parts: readonly DeclaredPromptPart[], label: string): DeclaredPromptPart[] {
  return parts.map(part => part.id === "user.current.request" ? { ...part, text: `${label}\n${part.text ?? ""}` } : part);
}

function composeCurrentUserPrompt(parts: readonly DeclaredPromptPart[]): string {
  return purposePrompt(parts, "\n\n");
}

function buildAppEditUserPromptParts(prompt: string, appRecord: AppFactoryAppRecord, locale: "ko" | "en"): DeclaredPromptPart[] {
  const appRoute = `/apps/generated?id=${appRecord.id}`;
  const manifestJson = JSON.stringify(appRecord.manifest, null, 2).slice(0, 7000);
  return [
    { id: "user.current.app-edit.guide", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], text: "app edit: modify the existing implementation under the root path below (no new App or Surface); keep saved state, user edits and data files; run a focused typecheck/smoke/render check when practical and report briefly" },
    { id: "user.current.app-edit.snapshot", revision: 1, stability: "task-context", changeTriggers: ["task", "plan-revision"], order: 0, text: [
      `App id: ${appRecord.id}`, `App name: ${appRecord.appName}`, `Apps registry route: ${appRoute}`,
      `Root path: ${appRecord.rootPath}`, `Launch URL: ${appRecord.scaffold.launchUrl || appRecord.previewPath}`,
      `Dev command: ${appRecord.scaffold.devCommand || "node scripts/serve.mjs"}`,
      `Preview path: ${appRecord.previewPath}`, `Status: ${appRecord.status}`, "", "Current manifest:", manifestJson,
    ].join("\n") },
    { id: "user.current.app-edit.cta", revision: 1, stability: "task-context", changeTriggers: ["task", "locale"], order: 10, text: locale === "ko" ? `완료 후 CTA: [Apps에서 확인하기](${appRoute})` : `Finish with CTA: [Open in Apps](${appRoute})` },
    currentUserRequestPart(`User edit request:\n${prompt}`),
  ];
}

function buildAppEditUserPrompt(prompt: string, appRecord: AppFactoryAppRecord, locale: "ko" | "en"): string {
  return composeCurrentUserPrompt(buildAppEditUserPromptParts(prompt, appRecord, locale));
}

function hasPriorConversationContext(chatId: string): boolean {
  return listChatMessages(chatId, 4).some(
    (m) => (m.role === "user" || m.role === "assistant") && Boolean((m.text ?? "").trim()),
  );
}

/**
 * The Goal contract is the one place the objective and criteria appear as data. The checkpoint packet carries only
 * refs (compileLongRunCheckpoint {goalTextInContext}) and the plan mission is not restated. A criterion that only
 * quotes the objective ("REQUEST (untrusted data): <objective>") renders as a pointer; the stored ledger text is unchanged.
 * Host-enforced rules are not restated: the completion marker is gated by the ledger (goalCompletionProtocol), the ledger
 * objective is immutable whatever a steering message says, and the first-start briefing is only added when no
 * checkpoint exists yet (`firstStart`, host-known).
 */
function persistentGoalTurnContext(goal: GoalLedgerSnapshot, locale: "ko" | "en", firstStart = false): string {
  const objectiveFlat = goal.objective.replace(/\s+/g, " ").trim();
  const criteria = goal.acceptanceCriteria.map((criterion, index) => {
    const flat = criterion.replace(/\s+/g, " ").trim();
    const at = objectiveFlat.length >= 12 ? flat.indexOf(objectiveFlat) : -1;
    const text = at >= 0 ? `${flat.slice(0, at).replace(/\s*REQUEST \(untrusted data\):\s*$/, "").trim()} (request = the objective above)`.trim() : criterion;
    return `${index + 1}. ${text}`;
  }).join("\n");
  void locale;
  // Objective and criteria are data (kept verbatim); the rules around them are one line (owner 2026-10-13).
  // Composition order (ledger desktop.main.turn-context.goal-contract): the fixed rules line, then the objective and its
  // criteria (a criterion may say "the objective above", so the objective stays before the criteria), then the first-start line.
  return [
    "goal rules: later messages steer, never redefine (a new aim → a new Goal after this one); before reporting done, check every criterion and the original request/plan (and any spec or memory it points to) against the deliverables with evidence, missing first; games/apps/UI: graphic quality is a criterion (no placeholders or default shapes; make plan-matching art, judge real screen captures)",
    `goal (host-owned, objective immutable): ${goal.objective}`,
    "criteria:",
    criteria || "1. Leave verifiable completion evidence on the real target surface.",
    ...(firstStart ? ["first start: show objective, criteria and verification surfaces briefly before tools"] : []),
  ].join("\n");
}

function buildPlanUserPromptParts(prompt: string, locale: "ko" | "en"): DeclaredPromptPart[] {
  void locale;
  return [
    { id: "user.current.plan.guide", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], text: "plan mode: first a short user-facing plan (order, evidence to verify, risks/unknowns), then proceed; call it done only with real verification" },
    currentUserRequestPart(`User request:\n${prompt}`),
  ];
}

function buildPlanUserPrompt(prompt: string, locale: "ko" | "en"): string {
  return composeCurrentUserPrompt(buildPlanUserPromptParts(prompt, locale));
}

function buildRecommendedPipelineUserPromptParts(parts: readonly DeclaredPromptPart[], stages: RecStage[], locale: "ko" | "en"): DeclaredPromptPart[] {
  void locale;
  const stageLines = stages.map(stage => [
    `${stage.order}. ${stage.kind}`,
    stage.agentId ? `agent: ${stage.agentName ?? stage.agentId} (${stage.agentId})` : undefined,
    stage.consumes?.length ? `consumes: ${stage.consumes.join(", ")}` : undefined,
    stage.produces?.length ? `produces: ${stage.produces.join(", ")}` : undefined,
  ].filter(Boolean).join(" | ")).join("\n");
  return [
    { id: "user.current.pipeline.guide", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 10, text: "pipeline: the stages below are an execution contract; define each stage's input packet (inputType, inputKind, brief, consumes, expectedOutput, constraints), carry each output into the next, synthesize one answer; a stage that cannot call its own agent runs here and you say so" },
    { id: "user.current.pipeline.stages", revision: 1, stability: "task-context", changeTriggers: ["plan-revision"], order: 20, text: `Recommended stages:\n${stageLines}` },
    ...labelCurrentUserRequest(parts, "User request:"),
  ];
}

function buildRecommendedPipelineUserPrompt(prompt: string, stages: RecStage[], locale: "ko" | "en"): string {
  return composeCurrentUserPrompt(buildRecommendedPipelineUserPromptParts([currentUserRequestPart(prompt)], stages, locale));
}

function borrowedCurrentUserPrompt(parts: readonly DeclaredPromptPart[], borrowParts: readonly DeclaredPromptPart[]): string {
  return composeCurrentUserPrompt([...borrowParts, ...labelCurrentUserRequest(parts, "Request:")]);
}

/**
 * 추천 시트 네트워크 모드에서 고른 Hub 에이전트를 hep-call 로 빌려와(BYOM) 프롬프트 앞에
 * borrow 지시를 붙인다. BYOC 라 실행은 데스크탑 런타임(사용자 LLM)이 한다 — 엔진은 빌려올
 * 에이전트와 grounding 만 제공한다. 명시적 Hub 호출이 실패하거나 실제 bundle 지시문을
 * 반환하지 않으면 로컬 런타임이 그 에이전트를 흉내 내지 못하도록 fail-closed 한다.
 */
async function buildBorrowUserPreamble(
  slugs: string[],
  prompt: string,
  project: string | null,
  locale: "ko" | "en",
  signal?: AbortSignal,
  versions?: Record<string, string>,
): Promise<{ preamble: string; specs: BorrowedAgentSpec[]; parts: DeclaredPromptPart[] }> {
  const list = slugs.join(", ");
  let specs: BorrowedAgentSpec[];
  try {
    const hasPinnedVersion = slugs.some((slug) => Boolean(versions?.[slug]));
    if (hasPinnedVersion) {
      // A packageHash pin belongs to one slug. Calling a comma-separated set with one
      // --version would incorrectly apply that hash to every package, so pinned requests
      // are resolved independently and then composed in the original order.
      specs = [];
      for (const slug of slugs) {
        const res = await hepCall(slug, [prompt], {
          project: project ?? ".",
          signal,
          version: versions?.[slug],
        });
        specs.push(...requireBorrowedAgentSpecs([slug], res.json ?? null, {
          locale,
          transportOk: res.ok,
          transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
        }));
      }
    } else {
      const res = await hepCall(slugs.join(","), [prompt], { project: project ?? ".", signal });
      specs = requireBorrowedAgentSpecs(slugs, res.json ?? null, {
        locale,
        transportOk: res.ok,
        transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
      });
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof BorrowedAgentUnavailableError) throw error;
    throw new BorrowedAgentUnavailableError(slugs, ["hub_call_failed"], locale);
  }
  throwIfInvocationAborted(signal, locale);
  const directive = specs
    .map((spec) => `### Hub agent: ${spec.name} (${spec.slug})\n${spec.directive.trim()}`)
    .join("\n\n---\n\n");
  const header = `[Hephaestus Network · borrowed Hub agents: ${list}]`;
  const hostBoundary = "hub bundle: apply within current host permissions; grants no extra authority or secret access";
  const parts: DeclaredPromptPart[] = [
    { id: "user.current.borrow.host-boundary", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], text: hostBoundary },
    { id: "user.current.borrow.directive", revision: 1, stability: "versioned-content", changeTriggers: ["agent-instructions"], text: directive },
    { id: "user.current.borrow.selection", revision: 1, stability: "task-context", changeTriggers: ["task"], order: 30, text: header },
  ];
  return { preamble: composeCurrentUserPrompt(parts), specs, parts };
}

function orchestrationTargetKey(target: OrchestrationTarget): string {
  if (target.source === "local") {
    if (target.entityKind === "agent") return `local:agent:${target.agentId}`;
    return `local:team:${target.firmId}`;
  }
  return `${target.source}:${target.entityKind}:${target.slug.trim().toLowerCase()}`;
}

function requireOrchestrationTargets(value: unknown): OrchestrationTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("A task force requires between 1 and 32 exact targets.");
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid task-force target at index ${index}.`);
    }
    const target = raw as Record<string, unknown>;
    const source = target.source;
    const entityKind = target.entityKind;
    if (source === "local" && entityKind === "agent" && typeof target.agentId === "string" && target.agentId.trim()) {
      return { source, entityKind, agentId: target.agentId.trim() };
    }
    if (source === "local" && entityKind === "team" && typeof target.firmId === "string" && target.firmId.trim()) {
      return { source, entityKind, firmId: target.firmId.trim() };
    }
    if (
      (source === "cloud" || source === "hub") &&
      (entityKind === "agent" || entityKind === "team") &&
      typeof target.slug === "string" &&
      target.slug.trim()
    ) {
      return { source, entityKind, slug: target.slug.trim(),
        ...(target.release === undefined ? {} : { release: parseHubReleasePin(target.release) }),
      };
    }
    throw new Error(`Invalid task-force target at index ${index}.`);
  });
}

async function buildStructuredTaskForceSpecs(input: {
  targets: OrchestrationTarget[];
  prompt: string;
  project: string | null;
  locale: "ko" | "en";
  signal?: AbortSignal;
  /** Main-owned One snapshot. When present, local directives must not re-read disk. */
  localEffectivePrompts?: ReadonlyMap<string, OneParticipantEffectivePromptSnapshot>;
}): Promise<BorrowedAgentSpec[]> {
  if (input.targets.length === 0 || input.targets.length > 32) {
    throw new Error("A task force requires between 1 and 32 exact targets.");
  }
  const seen = new Set<string>();
  const targets = input.targets.filter((target) => {
    const key = orchestrationTargetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const specs: BorrowedAgentSpec[] = [];
  for (const target of targets) {
    if (target.source === "local" && target.entityKind === "agent") {
      const locator = target.agentId.split("/").pop() || target.agentId;
      const matches = listInstalledAgents().filter((candidate) => candidate.id === target.agentId || candidate.slug === locator);
      const agent = matches.length === 1 ? matches[0] : null;
      if (!agent) throw new Error(`Installed agent is unavailable: ${target.agentId}`);
      if (agent.kind === "team") {
        throw new Error(`Installed team package must resolve to a Team/Firm target: ${target.agentId}`);
      }
      const frozenPrompt = input.localEffectivePrompts
        ? exactOneParticipantEffectivePrompt(input.localEffectivePrompts, agent.id, agent.slug)
        : null;
      if (input.localEffectivePrompts && frozenPrompt === null) {
        throw new Error(`Installed agent is outside the exact One prompt snapshot: ${target.agentId}`);
      }
      specs.push({
        slug: `installed:${agent.slug}`,
        name: agent.nameEn || agent.name,
        directive: frozenPrompt ?? buildEffectiveAgentSystemPrompt(agent.id, agent.systemPrompt),
        entityKind: "agent",
        source: "installed",
        routeLabel: "Installed",
        installedAgentId: agent.id,
      });
      continue;
    }
    if (target.source === "local" && target.entityKind === "team") {
      const locator = target.firmId.split("/").pop() || target.firmId;
      const matches = listFirms().filter((candidate) => candidate.id === target.firmId || candidate.slug === locator);
      const firm = matches.length === 1 ? matches[0] : null;
      if (!firm) throw new Error(`Installed team is unavailable: ${target.firmId}`);
      specs.push({
        slug: `firm:${firm.slug}`,
        name: firm.nameEn || firm.name,
        directive: `Preserve the installed team hierarchy for ${firm.nameEn || firm.name}.`,
        entityKind: "team",
        source: "firm",
        routeLabel: "Installed Team",
        installedAgentId: firm.ceoAgentId,
        firmId: firm.id,
      });
      continue;
    }
    // Exact Core selector keeps scope + entity kind + slug through Hub lookup.
    const ref = `${target.source}/${target.entityKind}/${target.slug}`;
    const res = await hepCall(ref, [input.prompt], { project: input.project ?? ".", signal: input.signal, version: target.release?.packageHash });
    const [remote] = requireBorrowedAgentSpecs([target.slug], res.json ?? null, {
      locale: input.locale,
      transportOk: res.ok,
      transportError: res.error || (res.exitCode == null ? "hub_call_failed" : `hub_exit_${res.exitCode}`),
    });
    if (!remote) throw new BorrowedAgentUnavailableError([target.slug], ["missing_directive"], input.locale);
    // A public card selection authorizes only this exact release. The server hash
    // gate and this complete identity check both run before any worker starts.
    if (target.release) assertHubReleasePin(target.release, remote);
    if (!remote.entityKind || remote.entityKind !== target.entityKind) {
      throw new BorrowedAgentUnavailableError(
        [target.slug],
        [`entity_kind_mismatch:${remote.entityKind ?? "unproven"}->${target.entityKind}`],
        input.locale,
      );
    }
    if (target.entityKind === "team" && !remote.executionGraph) {
      throw new BorrowedAgentUnavailableError([target.slug], ["team_execution_graph_unavailable"], input.locale);
    }
    specs.push({
      ...remote,
      entityKind: target.entityKind,
      source: target.source,
      routeLabel: target.source === "cloud" ? "Agent Cloud" : "Hub",
    });
  }
  return specs;
}

function selectAppBuilderForExistingAppEdit(
  agents: InstalledAgent[],
  locale: "ko" | "en",
): AutoRouteChoice | null {
  const agent = agents.find((candidate) => candidate.slug === APP_BUILDER_SLUG);
  if (!agent) return null;
  return {
    agent,
    reason:
      locale === "ko"
        ? "기존 Agentlas App 수정 요청이라 숨은 App Builder 라우트를 선택했습니다"
        : "the request edits an existing Agentlas App, so Agentlas selected the hidden App Builder route",
    matchedTerms: ["existing-app-edit"],
  };
}

function selectAppBuilderForAppsGenerate(
  agents: InstalledAgent[],
  locale: "ko" | "en",
): AutoRouteChoice | null {
  const agent = agents.find((candidate) => candidate.slug === APP_BUILDER_SLUG);
  if (!agent) return null;
  return {
    agent,
    reason:
      locale === "ko"
        ? "사용자가 Apps Generate 모드를 명시적으로 켜서 숨은 App Builder 라우트를 선택했습니다"
        : "the user explicitly enabled Apps Generate mode, so Agentlas selected the hidden App Builder route",
    matchedTerms: ["apps-generate-mode"],
  };
}

function buildRouterAgentEscalationPrompt(input: {
  routerAgent: RecRouterAgent;
  userPrompt: string;
  effectiveUserPrompt: string;
  locale: "ko" | "en";
  selectedAgent: InstalledAgent;
  autoRoute: AutoRouteChoice | null;
  borrowedAgents?: string[];
}): string {
  const context = input.routerAgent.context ?? {};
  const contextHasQuery = typeof context.query === "string" && context.query.trim().length > 0;
  const payload = {
    routerAgent: input.routerAgent.agent,
    reason: input.routerAgent.reason,
    locale: input.locale,
    query: contextHasQuery ? context.query : input.userPrompt,
    effectiveQuery: input.effectiveUserPrompt,
    deterministicContext: context,
    currentDesktopRoute: input.autoRoute
      ? {
          agentId: input.autoRoute.agent.id,
          slug: input.autoRoute.agent.slug,
          name: input.autoRoute.agent.nameEn || input.autoRoute.agent.name,
          reason: input.autoRoute.reason,
          matchedTerms: input.autoRoute.matchedTerms,
        }
      : {
          agentId: input.selectedAgent.id,
          slug: input.selectedAgent.slug,
          name: input.selectedAgent.nameEn || input.selectedAgent.name,
        },
    borrowedAgents: input.borrowedAgents ?? [],
  };
  return [
    input.routerAgent.directive ||
      "Resolve this low-confidence routing decision with the Router Agent before answering.",
    "",
    "Router escalation payload:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

/** The package definition and its skill list share one exact version/freeze boundary. */
function mainHostSystemPart(id: string, stability: PromptStability, changeTriggers: readonly PromptChangeTrigger[], text: string): DeclaredPromptPart {
  return { id: `main.system.host.${id}`, revision: 1, stability, changeTriggers, text };
}

/** A real system-channel producer; conversation order and package bytes are never interpreted. */
function composeMainHostSystemPrompt(parts: readonly DeclaredPromptPart[]) {
  return composeTracedPrompt(parts, { separator: "\n\n", kind: "main-host" });
}

function buildRouterAgentSystemPreamble(input: {
  routerAgent: RecRouterAgent;
  userPrompt: string;
  effectiveUserPrompt: string;
  locale: "ko" | "en";
  selectedAgent: InstalledAgent;
  autoRoute: AutoRouteChoice | null;
  borrowedAgents?: string[];
}): { preamble: string; loadedModuleIds: string[]; parts: DeclaredPromptPart[] } | null {
  const agentId = input.routerAgent.agent.trim();
  if (!agentId || (agentId !== ROUTER_AGENT_ID && agentId !== ROUTER_SYSTEM_AGENT.id)) return null;
  const escalationPrompt = buildRouterAgentEscalationPrompt(input);
  const assembled = assembleSystemPrompt(ROUTER_SYSTEM_AGENT, escalationPrompt, {
    threshold: 0.4,
    maxModules: 2,
  });
  const preamble = [
    "## Agentlas Router Agent escalation",
    "",
    assembled.systemPrompt,
    "",
    "### Escalation directive",
    escalationPrompt,
  ].join("\n");
  const parts = [
    mainHostSystemPart("router.heading", "fixed-policy", ["release"], "## Agentlas Router Agent escalation"),
    ...assembled.parts.map(part => mainHostSystemPart(`router.${part.id}`, "fixed-policy", ["release"], part.text)),
    mainHostSystemPart("router.directive", "turn-context", ["task", "owner-input", "locale"], `### Escalation directive\n${escalationPrompt}`),
  ];
  return { preamble, loadedModuleIds: assembled.loadedModuleIds, parts };
}

type AutomationRegistrationResult = {
  automationId: string;
  timezone: string | null;
  notificationPolicy: "meaningful_changes" | "every_run";
  executionAvailability: "app-running";
  action: "created" | "updated" | "paused" | "resumed";
  enabled: boolean;
  activeRunStopRequested?: boolean;
  name: string;
  schedule: string;
  targetType: "agent" | "firm" | "hub";
  targetId: string;
  nextRunAt: string | null;
  graph: boolean;
};

function automationActionLabel(action: AutomationRegistrationResult["action"], locale: "ko" | "en"): string {
  if (locale === "ko") return {created:"등록",updated:"업데이트",paused:"중지",resumed:"다시 켜기"}[action];
  return action;
}

function automationRegistrationToolName(action: AutomationRegistrationResult["action"]): string {
  return {created:"automation.create",updated:"automation.update",paused:"automation.pause",resumed:"automation.resume"}[action];
}

function automationRegistrationResultText(item: AutomationRegistrationResult, locale: "ko" | "en"): string {
  const action = automationActionLabel(item.action, locale);
  if (item.action === "paused") return locale === "ko"
    ? `${item.name} · 예약 실행을 껐습니다${item.activeRunStopRequested ? " · 진행 중인 실행에 중지를 요청했습니다" : ""}.`
    : `${item.name} · scheduled runs are disabled${item.activeRunStopRequested ? "; Stop requested for the active run" : ""}.`;
  if (locale === "ko") {
    return `${item.name} ${action} 완료 · 앱 실행 중 확인 · ${item.schedule}${item.graph ? " · 워크플로우 그래프 포함" : ""}`;
  }
  return `${item.name} ${action} · checks while app is running · ${item.schedule}${item.graph ? " · workflow graph included" : ""}`;
}

function automationFinalSummary(items: AutomationRegistrationResult[], locale: "ko" | "en"): string {
  if (items.length === 0) return "";
  const lines = items.map((item) => {
    const action = automationActionLabel(item.action, locale);
    const nextRun =
      item.enabled && item.nextRunAt && locale === "ko"
        ? ` · 다음 실행 ${formatAutomationNextRun(item.nextRunAt, item.timezone, locale)}`
        : item.enabled && item.nextRunAt
          ? ` · next run ${formatAutomationNextRun(item.nextRunAt, item.timezone, locale)}`
          : "";
    return `- ${item.name} · ${action} · ${item.schedule}${nextRun}`;
  });
  return locale === "ko"
    ? [`자동화 ${items.length}개를 설정했습니다.`, ...lines, "자동화 화면에서 바로 확인할 수 있습니다."].join("\n")
    : [`Set up ${items.length} automation${items.length === 1 ? "" : "s"}.`, ...lines, "You can review it in Automations."].join("\n");
}

function automationPermissionRequiredText(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "자동화는 저장하지 않았습니다. 쓰기 권한으로 다시 실행하세요."
    : "Automation was not saved. Run again with write permission.";
}

/**
 * 호스트 고지 한 줄. **모델의 답과 절대 같은 칸을 쓰지 않는다.**
 *
 * 이 함수가 존재하는 이유(2026-08-08 실측): 호스트가 할 말이 생길 때마다 답변
 * 문자열에 이어붙이거나 아예 대입해 버려서, 사용자는 "에이전트가 그렇게 말했다"고
 * 읽었다. 서피스 원문 유출도 자동화 요약도 전부 이 한 칸을 공유한 결과였다.
 */
function emitHostNotice(
  sink: (event: McpInvocationEvent) => void,
  notice: NonNullable<McpInvocationEvent["notice"]>,
): void {
  sink({ kind: "notice", notice });
}

/**
 * 프로젝트의 공개 Hub 에이전트 자동 사용 동의 게이트(모델의 자발적 협조에
 * 기대는 계약은 배선이 아니다). 프롬프트에 주입되는 정책 문장과 별개로, **자동**
 * 편성 경로가 실행 직전에 통과해야 하는 기계 관문이다 — 사용자가 명시적으로 고른
 * 로스터(추천 시트 선택, 직접 지목)는 이 함수를 거치지 않는다.
 *
 * Hub 스펙은 프로젝트에서 자동 사용을 허용했거나 사용자가 직접 지목한 경우에만
 * 통과한다. 옛 유료 장기대여 상태는 무료 Hub의 동의를 대신하지 않는다.
 */
async function gateHubSpecsByProjectRentPolicy(input: {
  specs: BorrowedAgentSpec[];
  projectId: string | null | undefined;
  userPrompt: string;
  locale: "ko" | "en";
  sink: (event: McpInvocationEvent) => void;
}): Promise<BorrowedAgentSpec[]> {
  const { specs, projectId, userPrompt, locale, sink } = input;
  const needsHubConsent = (spec: BorrowedAgentSpec): boolean => {
    const preparedSource = preparedWorkforceSpecSource(spec);
    return preparedSource ? preparedSource === "hub" : spec.source === "hub";
  };
  if (!projectId || !specs.some(needsHubConsent)) return specs;
  let allowed: Set<string>;
  try {
    allowed = new Set(listRentAllowedSlugs(projectId).map((s) => s.toLowerCase()));
  } catch {
    allowed = new Set();
  }
  const prompt = String(userPrompt || "").toLowerCase();
  const explicitlyNamed = (s: BorrowedAgentSpec): boolean => {
    const slug = (s.slug || "").trim().toLowerCase();
    const name = (s.name || "").trim().toLowerCase();
    return (slug.length >= 3 && prompt.includes(slug)) || (name.length >= 3 && prompt.includes(name));
  };
  const kept: BorrowedAgentSpec[] = [];
  const dropped: BorrowedAgentSpec[] = [];
  for (const s of specs) {
    if (!needsHubConsent(s)) {
      kept.push(s);
      continue;
    }
    const slug = (s.slug || "").toLowerCase();
    if (allowed.has(slug) || explicitlyNamed(s)) kept.push(s);
    else dropped.push(s);
  }
  if (dropped.length) {
    const names = dropped.map((s) => s.name || s.slug).join(", ");
    emitHostNotice(sink, {
      level: "info",
      code: "hub_auto_use_not_allowed",
      message: locale === "ko"
        ? `이 프로젝트에서 자동 사용을 허용하지 않은 Hub 에이전트 ${dropped.length}명을 제외했습니다: ${names}. 프로젝트의 [자동 사용]을 켜거나 직접 지목하세요.`
        : `This project has not enabled automatic use for ${dropped.length} Hub agent(s): ${names}. Turn on [Auto use] in the project or name them explicitly.`,
      i18n: {
        ko: `이 프로젝트에서 자동 사용을 허용하지 않은 Hub 에이전트 ${dropped.length}명을 제외했습니다: ${names}. 프로젝트의 [자동 사용]을 켜거나 직접 지목하세요.`,
        en: `This project has not enabled automatic use for ${dropped.length} Hub agent(s): ${names}. Turn on [Auto use] in the project or name them explicitly.`,
      },
    });
  }
  return kept;
}

function appendAutomationSummary(text: string, summary: string): string {
  const trimmed = text.trim();
  if (!summary.trim()) return trimmed;
  if (!trimmed) return summary;
  return `${trimmed}\n\n${summary}`;
}

/** 활성 런타임 + 러너를 한 번에 선택 (오케스트레이터/리졸버 공용). */
export async function pickActiveRunner(): Promise<
  { runner: Runner; label: string; active: RuntimeStatus } | null
> {
  const list = await detectRuntimes();
  const active = pickActive(list);
  if (!active) return null;
  const picked = pickRunner(active);
  if (!picked) return null;
  return { runner: picked.runner, label: picked.label, active };
}

/** Main-process-only invocation provenance. Never deserialize this from IPC/wire input.
 *  - automation / site-studio / trex: 무인 실행 — 질문에 답할 사람이 없다(unattended).
 *  - telegram: 원격 대화형 — 질문이 평문으로 전달되고 사용자가 다음 메시지로 답한다.
 *  context 미지정(undefined)은 로컬 렌더러 대화형 경로다. 새 원격/헤드리스 통합은 반드시
 *  여기 source를 추가하고 넘겨라 — 안 넘기면 대화형으로 오인된다(fail-open). */
export interface InvocationExecutionContext {
  /** Original Graph custody, never renderer/model supplied. */
  graphWorkerAttempt?: GraphWorkerAttempt;
  /** Main-minted exact-run capability; future Science recovery writer only. */
  scienceRecovery?: object;
  /** Main-minted object identity; serialized fields cannot authorize a reviewer. */
  scienceReview?: object;
  /** "agent-mail": a One run the inbound-mail loop started for one received message (no person to ask). */
  source: "automation" | "site-studio" | "telegram" | "trex" | "mobile" | "science" | "alive" | "agent-mail";
  /** An Alive wake's attached Science playground, not a Research Director turn. Main-only. */
  aliveScience?: Readonly<{ agentId: string; wakeId: string; controlEpoch: number; attachmentId: string }>;
  /** Main-owned Science turn authority. Never reconstruct this by parsing surfaceContext. */
  science?: Readonly<{
    projectId: string;
    conversationId: string;
    turnId: string;
    originUserMessageId: string;
    invocationRunId: string;
    researchDirectorAgentId: string;
    researchDirectorAgentSlug: string;
    researchDirectorPackageVersion: string;
    researchDirectorPackageDigest: string;
    researchDirectorSystemPromptSha256: string;
    /** Main-selected route hint for a bounded Science workflow. */
    workflowRoute?: "dinosaur-comparative-proxy";
  }>;
  /**
   * 표면이 붙이는 안내(방 정보·언어 규칙·모드 지시). **userPrompt 에 섞으면 안 된다** —
   * userPrompt 는 "사람이 실제로 한 말"이고 goal 목표·수락 기준·대화 제목·기억이
   * 전부 그걸 그대로 쓴다. 실측: 텔레그램이 스캐폴딩을 프롬프트에 이어 붙이자 goal
   * objective 가 "Telegram chat: … language rule … 파일 만들어줘" 통째가 되어 완료
   * 판정이 불가능해졌고, 28사이클을 돌다 no_progress_stall 로 막혔다.
   */
  surfaceContext?: string;
  /** Main-owned workflow node identity; keeps Memory Tickets distinct within one parent run. */
  nodeId?: string;
  /** Durable logical graph occurrence shared by resume runs. */
  occurrenceId?: string;
  /**
   * Main-process-only checkpoint hook. It fires immediately after Hub response
   * validation and before any borrowed worker starts, closing the crash window
   * that a final invocation result alone would leave.
   */
  onWorkforcePrepareReceipt?: (receipt: WorkforcePrepareCheckpointReceipt) => void;
  /** Main-minted by the graph runner (one/graph-team-grant.ts): a room-saved graph step acting for that room's One
   * Team. Object identity is the authority; a copied or renderer-supplied value is never current. */
  graphTeamGrant?: GraphTeamGrant;
}

export interface McpInvocationResult {
  /** Main-only, invocation-owned settlement receipt; never accepted from a model. */
  graphWorkerFailure?: GraphWorkerFailureReceipt;
  /** Host-owned waiting custody; never serialized as a tool/model result. */
  browserLoginWait?: BrowserLoginWait;
  finalText?: string;
  tokens?: number;
  /** Sum of measured invocation attempts, including planning and workers; absent if any attempt is unknown. */
  observedUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** Host-created structured quota marker; never inferred from error prose. */
  markedQuotaFailure?: true;
  stormbreakerContinueRequested: boolean;
  /**
   * 모델이 이 턴에서 goal 전체 완료를 선언했는가(+ 같이 적은 근거).
   *
   * 채팅 경로는 여기서 바로 원장을 닫지만, 스케줄러가 쓰는 division 채팅은
   * goal 계약 블록 자체에서 제외되므로(`chat.kind !== "division"`) 원장 회계가
   * 호출자 쪽에 있다. 그 호출자에게 선언을 전달할 유일한 통로가 이 칸이다 —
   * 없으면 마커는 텍스트에서 지워진 뒤 아무 데도 도달하지 못한다.
   */
  goalWaitRequest?: ParsedGoalWait;
  /** Main must settle this episode before deciding the next Goal turn. */
  goalEpisodeYield?: NativeGoalEpisodeBinding;
  goalCompletionClaim?: { claimed: boolean; evidence: string | null; goalId: string | null };
  /** A failed goal pass stopped the loop with the goal still open (typed; see long-run/goal-pass-stop.ts). */
  goalPassStop?: GoalPassStop;
  resultFolder?: string;
  /**
   * 커넥터 C38 — 이 호출에서 도구 중개가 **실제로** 어디까지 걸렸는가. 계획이 아니라
   * 결과다. 관문 파일을 만들었어도 실행이 다른 경로(회사·스웜 등)로 갔으면 여기 등급은
   * 내려온다. 화면과 실행 기록은 계획이 아니라 이 값을 보여줘야 한다.
   */
  toolBroker?: { level: ToolBrokerLevel; reason: string };
  /** Trusted main-process metadata; never accepted from model/tool event text. */
  workforcePrepareReceipt?: WorkforcePrepareCheckpointReceipt;
}

type DesktopWorkforceTurnDecision =
  | { decision: "reuse"; planRevision: number; reasonCode: string }
  | { decision: "recruit" | "local-only" | "blocked"; planRevision: null; reasonCode: string };

function parseDesktopWorkforceTurnDecision(
  text: string,
  plans: DesktopWorkforceRuntimePlan[],
): DesktopWorkforceTurnDecision {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("workforce_goal_turn_decision_invalid");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    throw new Error("workforce_goal_turn_decision_invalid");
  }
  const decision = String(value.decision || "");
  const reasonCode = String(value.reasonCode || "").trim().slice(0, 160);
  const planRevision = value.planRevision;
  if (!["reuse", "recruit", "local-only", "blocked"].includes(decision) || !reasonCode) {
    throw new Error("workforce_goal_turn_decision_invalid");
  }
  if (decision === "reuse") {
    if (!Number.isInteger(planRevision) || !plans.some((plan) => plan.revision === planRevision && plan.status === "ready")) {
      throw new Error("workforce_goal_turn_plan_invalid");
    }
    return { decision, planRevision: planRevision as number, reasonCode };
  }
  if (planRevision !== null) throw new Error("workforce_goal_turn_plan_invalid");
  return { decision: decision as "recruit" | "local-only" | "blocked", planRevision: null, reasonCode };
}


/** 질문에 답할 사람이 없는 실행인가 — UNATTENDED_NO_ASK_DIRECTIVE 부착 기준. */
function isUnattendedExecution(executionContext?: InvocationExecutionContext): boolean {
  return (
    executionContext?.source === "automation" ||
    executionContext?.source === "science" ||
    executionContext?.source === "site-studio" ||
    executionContext?.source === "trex" ||
    executionContext?.source === "alive" ||
    executionContext?.source === "agent-mail"
  );
}

function usesMobileDurableDecision(executionContext?: InvocationExecutionContext): boolean {
  return executionContext?.source === "mobile";
}

/**
 * The project the host bound an automation run to, or null. Binding sources: automations.project_id, which every
 * automation session chat of the run carries (store/automation-sessions.ts getOrCreateAutomationSession, run-graph
 * chatForNode), then the run's captured automation workspace (automation-workspace.ts captureAutomationWorkspace: a
 * project folder, or a followed Goal's folder) when exactly one project owns that folder. Never a model choice.
 */
function automationBoundProject(chatProjectId: string | null | undefined, binding: InvocationWorkspaceBinding | undefined): ReturnType<typeof getProject> {
  const bound = chatProjectId ? getProject(chatProjectId) : null;
  if (bound) return bound;
  const folder = binding?.source === "automation" ? binding.canonicalPath : null;
  if (!folder) return null;
  const owners = listProjects().filter((project) => {
    if (!project.folderPath) return false;
    try { return fs.realpathSync.native(project.folderPath) === folder; } catch { return false; }
  });
  return owners.length === 1 ? owners[0] : null;
}

// ── One 태스크 Surface 레시피 — 선택은 판정기(LLM) 경유 ──────────────────────
// 2026-08-20: 사용자 프롬프트를 6개 정규식(여행/풀이/문서/엑셀/미디어/조사)으로 분기해
// 레시피를 확정하던 단어장 게이트를 제거했다. 어떤 레시피가 맞는지는 연결된 모델이
// 뜻으로 판정한다(shared/one-request-intent.ts · mcp-tools/need-resolver.ts와 같은 계약).
// 판정이 없으면 중립(레시피 없음)이다 — 단어장 폴백은 없다.
//
// 전달 경로가 둘인 이유: 경계 블록 조립(아래 oneTaskSurfaceRecipe 호출부)은 동기라
// 이미 판정된 캐시를 peek만 할 수 있다. 비동기 본선(resolveOneTaskSurfaceRecipe)은
// 시스템 프롬프트 조립 단계(턴 컨텍스트)에서 판정을 확정해 같은 턴에 전달한다.
const ONE_TASK_SURFACE_RECIPE_JUDGMENT_KIND = "one-task-surface-recipe";
const ONE_TASK_SURFACE_RECIPE_LABELS = [
  "travel",
  "study",
  "document",
  "spreadsheet",
  "media",
  "research",
  "none",
] as const;
type OneTaskSurfaceRecipeLabel = (typeof ONE_TASK_SURFACE_RECIPE_LABELS)[number];

const ONE_TASK_SURFACE_RECIPE_QUESTION =
  "Which result-surface recipe fits the main deliverable this request asks for: " +
  "travel (a trip plan with schedule/route/budget), study (explaining problems, worksheets, or a learning plan), " +
  "document (a written document/report file), spreadsheet (tabular data or a spreadsheet file), " +
  "media (photo/image/video work), research (research, comparison, strategy, marketing, or how-to recommendations), " +
  "or none of these?";

const ONE_TASK_SURFACE_RECIPE_GUIDANCE =
  "Judge the request's meaning in any language. Mentioning a topic in passing is not the task; " +
  "choose the recipe for the primary deliverable, and 'none' when no single recipe clearly fits.";

// 동기 peek 를 위한 지연 로드 핸들 — 비동기 resolver 가 최초 1회 채운다.
let oneTaskSurfaceJudgmentModule: typeof import("../system-agents/judgment") | null = null;

function oneTaskSurfaceRecipeCopy(kind: OneTaskSurfaceRecipeLabel, ko: boolean): string | null {
  void ko;
  // One line per recipe (owner 2026-10-13); the Surface field shapes come from read_surface_protocol.
  switch (kind) {
    case "travel":
      return purposePrompt([{ id: `purpose.surface.recipe.${kind}`, revision: 3, stability: "task-context", changeTriggers: ["release", "task", "owner-input"], text: "recipe travel: data.schedule type=timeline + widgets.timeline; data.costs type=pricing(currency,limit,items) + widgets.cost-summary; data.checklist type=launch-checklist + widgets.launch-checklist; dates/prices evidenceIds or trust:'estimated'; data.routes/widgets.map verified coordinates only" }]);
    case "study":
      return purposePrompt([{ id: `purpose.surface.recipe.${kind}`, revision: 3, stability: "task-context", changeTriggers: ["release", "task", "owner-input"], text: "recipe study: summary explains; steps keep ordered solution/reasoning; checklist practice" }]);
    case "document":
      return purposePrompt([{ id: `purpose.surface.recipe.${kind}`, revision: 3, stability: "task-context", changeTriggers: ["release", "task", "owner-input"], text: "recipe document: summary markdown; artifacts/report only for files actually created and kept" }]);
    case "spreadsheet":
      return purposePrompt([{ id: `purpose.surface.recipe.${kind}`, revision: 3, stability: "task-context", changeTriggers: ["release", "task", "owner-input"], text: "recipe spreadsheet: table real rows/columns; artifacts only for files actually created and kept" }]);
    case "media":
      return purposePrompt([{ id: `purpose.surface.recipe.${kind}`, revision: 3, stability: "task-context", changeTriggers: ["release", "task", "owner-input"], text: "recipe media: media/asset-board real inputs/generated assets permanently saved; separate scenes/captions/output files" }]);
    case "research":
      return purposePrompt([{ id: `purpose.surface.recipe.${kind}`, revision: 3, stability: "task-context", changeTriggers: ["release", "task", "owner-input"], text: "recipe research: conclusion/why; table concrete options(priority,audience,method,next action,resources,risk,verification), one recommended; checklist first launch steps; preparation ≠ execution; follow-ups continue result within scope" }]);
    default:
      return null;
  }
}

/**
 * 동기 자리(경계 블록 조립)용 — 이미 판정된 verdict 를 peek 만 한다.
 * 판정이 아직 없으면 null(중립): 이 턴의 레시피는 아래 비동기 resolver 가
 * 턴 컨텍스트로 전달한다. 어떤 경우에도 단어장으로 되돌아가지 않는다.
 */
function oneTaskSurfaceRecipe(prompt: string, ko: boolean): string | null {
  const judgment = oneTaskSurfaceJudgmentModule;
  if (!judgment || !prompt.trim()) return null;
  const hit = judgment.peekJudgment<OneTaskSurfaceRecipeLabel>(
    ONE_TASK_SURFACE_RECIPE_JUDGMENT_KIND,
    prompt,
  );
  if (!hit || hit.source !== "llm") return null;
  return oneTaskSurfaceRecipeCopy(hit.verdict, ko);
}

/** 비동기 본선: 판정기를 통해 레시피를 결정한다. 판정 불가/none → null(중립). */
async function resolveOneTaskSurfaceRecipe(
  prompt: string,
  ko: boolean,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!prompt.trim()) return null;
  try {
    oneTaskSurfaceJudgmentModule ??= await import("../system-agents/judgment");
    const verdict = await oneTaskSurfaceJudgmentModule.judgeRequired<OneTaskSurfaceRecipeLabel>({
      kind: ONE_TASK_SURFACE_RECIPE_JUDGMENT_KIND,
      question: ONE_TASK_SURFACE_RECIPE_QUESTION,
      labels: ONE_TASK_SURFACE_RECIPE_LABELS,
      input: prompt,
      guidance: ONE_TASK_SURFACE_RECIPE_GUIDANCE,
      timeoutMs: 8_000,
      signal,
    });
    if (verdict.source !== "llm" || verdict.verdict === null) return null;
    return oneTaskSurfaceRecipeCopy(verdict.verdict, ko);
  } catch {
    return null;
  }
}

function deterministicOneCompletionCopy(
  prompt: string,
  surface: AgentlasSurfaceManifest,
  locale: "ko" | "en",
): string {
  const types = new Set(Object.values(surface.data).map((dataset) => dataset.type));
  if (types.has("artifacts") || types.has("media")) {
    return locale === "ko"
      ? "요청한 결과와 파일을 준비했어요. 아래에서 바로 확인할 수 있어요."
      : "Your result and files are ready. You can review them below.";
  }
  // Dataset types only (docs/2026-10-13-native-harness 04 §3): no wording of the request picks the copy.
  if (types.has("timeline") || (types.has("pricing") && types.has("launch-checklist"))) {
    return locale === "ko"
      ? "일정과 비용, 준비할 내용을 한눈에 정리했어요."
      : "I organized the schedule, costs, and preparations below.";
  }
  if (types.has("table")) {
    return locale === "ko"
      ? "확인한 내용과 비교 결과를 한눈에 정리했어요."
      : "I organized the checked details and comparison below.";
  }
  return locale === "ko"
    ? "필요한 결과만 보기 쉽게 정리했어요."
    : "I organized the result so it is easy to review.";
}

/**
 * Renderer → main IPC 진입점. chatId 기반.
 * 1) chat → agent + project lookup → system prompt 조립
 * 2) 사용자 메시지를 chat_messages에 영구화
 * 3) 활성 런타임 선택 → 러너에 위임
 */
export interface DurableUserMessageHookBlock {
  blockInvocation: true;
  code: "automatic-goal-intake-unavailable" | "automatic-goal-resume-state-changed" | "goal_wait_claimed_reconciliation_required" | "goal_resume_effect_boundary_uncertain";
  message: string;
}

export function runMcpInvocation(
  req: McpInvocationRequest,
  sink: EventSink,
  signal?: AbortSignal,
  workspaceBinding?: InvocationWorkspaceBinding,
  executionContext?: InvocationExecutionContext,
  onDurableUserMessage?: (messageId: string) => Promise<void | DurableUserMessageHookBlock>,
  hostNoticePurpose?: ChatHostNotice["purpose"],
  browserPresentation: "foreground" | "background" = "background",
  /** Main-only admission boundary before the first root work request and its plan receipt. */
  onBeforeGoalWorkDispatch?: (goalId: string | null) => void,
  canonicalWorkRecovery?: import("../invocation/main-work-recovery").MainWorkRecoveryContext,
  /** Main-only native controller; never carried in model or renderer input. */
  onNativeTurnController?: RunnerEvents["onNativeTurnController"],
  ownerControlInbox?: RunnerRequest["ownerControlInbox"],
): Promise<McpInvocationResult> {
  if (!req.runId) req = { ...req, runId: `direct-${randomUUID()}` };
  const graphAttempt = executionContext?.graphWorkerAttempt;
  assertGraphWorkerAttempt(graphAttempt);
  if (graphAttempt && (executionContext?.source !== "automation" || graphAttempt.runId !== req.runId
    || graphAttempt.automationId !== req.automationId || graphAttempt.chatId !== req.chatId
    || graphAttempt.nodeId !== executionContext.nodeId || graphAttempt.occurrenceId !== executionContext.occurrenceId
    || JSON.stringify(graphAttempt.selection) !== JSON.stringify(req.runtimeSelection))) {
    throw new Error("graph_worker_invocation_identity_changed");
  }
  // Native CLI tool loops can make hundreds of provider requests inside one
  // host pass. Guard completed outcomes here, including ordinary chats, rather
  // than relying on the scheduled Graph guard or on model-written progress.
  const progress = createNoProgressGuard({ observationMode: "completed" });
  const ownerSignal = signal ?? new AbortController().signal;
  const children: AttemptChildren = { children: new Set(), closing: false, stop: child => killCliTree(child, 500) };
  const login = createBrowserLoginPrerequisite({ runId: req.runId!, chatId: req.chatId,
    nodeId: executionContext?.nodeId, signal: ownerSignal,
    onWaiting: prerequisite => {
      children.closing = true;
      recordRunEvent({ runId: req.runId!, chatId: req.chatId, nodeId: executionContext?.nodeId,
        kind: "browser_login_wait_requested", sourceEventId: `browser-login-wait:${prerequisite.prerequisiteId}`,
        payload: { prerequisite } });
    },
  });
  const invocationSignal = login.signal;
  // Site, legacy Telegram and scheduler observations use this Host entrance
  // directly. Reuse their existing canonical Task and the same private leaf
  // port; the invocation run id only fences this port's lifetime.
  let directWorkOwnerCurrent = true;
  const workRecovery = canonicalWorkRecovery ?? (executionContext?.source !== "science"
    && !executionContext?.aliveScience && findCanonicalTaskForChat(req.chatId)
    ? new MainWorkRecoveryContext(req.chatId, req.runId!, () => {
      if (!directWorkOwnerCurrent) throw new Error("main_work_invocation_owner_ended");
      invocationSignal.throwIfAborted();
    }) : undefined);
  if (graphAttempt) {
    const originalPrepare = executionContext?.onWorkforcePrepareReceipt;
    executionContext = { ...executionContext!, onWorkforcePrepareReceipt: receipt => {
      noteGraphWorkerPrepare(graphAttempt); originalPrepare?.(receipt);
    } };
  }
  let progressAdvisory: string | null = null;
  const reportedProgress = new Set<string>();
  let goalDispatchObserved = false;
  let admittedGoal: { goalId: string; runId: string; revision: number } | null = null;
  const bindDispatchedGoal = (goalId: string | null): void => {
    if (goalDispatchObserved) return;
    goalDispatchObserved = true;
    try {
      const run = goalId ? getLongRunByGoalId(goalId) : null;
      const revision = goalId ? getChatGoalRevision(goalId) : null;
      if (goalId && run && run.surface !== "science" && revision) {
        admittedGoal = { goalId, runId: run.id, revision: revision.revision };
      }
    } catch { /* Missing admission evidence cannot authorize a Goal transition. */ }
  };
  const guardedSink: EventSink = (event) => {
    if(event.kind==="partial"||event.kind==="thinking"||event.kind==="reasoning"||(event.kind==="tool-use"&&event.tool))currentHistoryRuntimeFence()?.assertCurrent();
    // Status/progress also uses tool-use in this legacy channel. Only an
    // actual tool frame (including start, failed or read tools) is an effect observation.
    if (event.kind === "tool-use" && event.tool) noteGraphWorkerTool(graphAttempt);
    if (event.kind === "partial" && event.text) noteGraphWorkerActivity(graphAttempt);
    if (event.kind === "error") noteGraphWorkerFailure(graphAttempt);
    if (event.kind === "notice" && event.runtimeSelection &&
      (event.notice?.code === "runtime-selected" || event.notice?.code === "runtime-fallback")) {
      noteGraphWorkerSelection(graphAttempt, event.runtimeSelection);
    }
    if (login.waiting) {
      if (event.kind !== "final" && event.kind !== "error") sink(event);
      return;
    }
    const decision = signal?.aborted ? null : noteNoProgressEvent(progress, event);
    sink(event);
    if (!decision || signal?.aborted || reportedProgress.has(decision.fingerprint)) return;
    reportedProgress.add(decision.fingerprint);
    progressAdvisory = `The host observed repeated unchanged results (${decision.rule}, ${decision.count} observations). Change strategy now: delegate diagnosis or read-only effect checks to a background worker, then perform a different independent task. Do not repeat an uncertain external action or claim an unverified result. Keep the overall goal active.`;
    if (req.runId) tryRecordRunEvent({ runId: req.runId, chatId: req.chatId,
      kind: "invocation_no_progress_advisory", sourceEventId: `invocation-no-progress:${decision.fingerprint}`,
      ...(decision.nodeId ? { nodeId: decision.nodeId } : {}),
      payload: { rule: decision.rule, tool: decision.tool, fingerprint: decision.fingerprint, count: decision.count,
        goalId: admittedGoal?.goalId ?? null, action: "change_strategy", backgroundRepair: true } });
    sink({ kind: "notice", notice: { level: "warning", code: "invocation-no-progress-advisory",
      message: pickLocale(req) === "ko" ? "같은 결과가 반복돼 다음 단계에서 접근을 바꾸고 독립 작업을 이어갑니다."
        : "Repeated results detected. The next step will change strategy and continue independent work." } });
  };
  // Context-reduction C01: every model call this owner turn causes is recorded against this run (model-call-ledger.ts).
  const runOwnedInvocation = () => withModelCallScope({ runId: req.runId, chatId: req.chatId, userTurnId: req.runId, role: "main" }, runOwnedInvocationScoped);
  const runOwnedInvocationScoped = () => withOneHistoryNativeInvocation({runId:req.runId!,chatId:req.chatId},()=>withAttemptChildren(children, () => withInvocationUsage(() => withInvocationJudgmentContext(req.runtimeSelection, invocationSignal, () => runMcpInvocationInContext(
    req, guardedSink, invocationSignal, workspaceBinding, executionContext, onDurableUserMessage, hostNoticePurpose, browserPresentation, bindDispatchedGoal, login, () => progressAdvisory, onBeforeGoalWorkDispatch, workRecovery,
    () => directWorkOwnerCurrent && !ownerSignal.aborted, onNativeTurnController, ownerControlInbox,
  )).then(async result => {
    if (login.waiting && !ownerSignal.aborted) {
      const browserLoginWait = login.seal(await drainAttemptChildren(children));
      if (browserLoginWait) return { ...result, browserLoginWait, finalText: undefined,
        stormbreakerContinueRequested: false, goalCompletionClaim: undefined,
        goalWaitRequest: undefined, goalPassStop: undefined };
    }
    login.cancel();
    if (result.workforcePrepareReceipt) noteGraphWorkerPrepare(graphAttempt);
    const graphWorkerFailure = await settleGraphWorkerAttempt(graphAttempt, () => drainAttemptChildren(children));
    return graphWorkerFailure ? { ...result, graphWorkerFailure } : result;
  }).catch(async error => {
    noteGraphWorkerFailure(graphAttempt);
    await settleGraphWorkerAttempt(graphAttempt, () => drainAttemptChildren(children));
    if (login.waiting && !ownerSignal.aborted) {
      const browserLoginWait = login.seal(await drainAttemptChildren(children));
      if (browserLoginWait) return { browserLoginWait, observedUsage: currentInvocationObservedUsage(),
        stormbreakerContinueRequested: false };
    }
    login.cancel();
    throw error;
  }), () => bindDispatchedGoal(getChatGoalId(req.chatId) ?? null))));
  // Files a harness port writes for this run wait until a tool completion of this invocation seals them into One
  // Outputs (bindInvocationOneArtifacts in runMcpInvocationInContext; harness/run-produced-files.ts).
  const releaseProducedFiles = openRunProducedFiles(req.runId);
  const owned = graphAttempt ? withAdapterEffectObserver({ runId: req.runId!, chatId: req.chatId, rootAgentId: null, source: "automation" }, {
    begin: admission => noteGraphWorkerAdapterStart(graphAttempt, admission),
    finish: (scopeId, report) => noteGraphWorkerAdapterFinish(graphAttempt, scopeId, report),
    recordingFailed: () => noteGraphWorkerCoverageUnknown(graphAttempt),
  }, runOwnedInvocation) : runOwnedInvocation();
  return owned.finally(() => { directWorkOwnerCurrent = false; releaseProducedFiles(); });
}

async function runMcpInvocationInContext(
  req: McpInvocationRequest,
  sink: EventSink,
  signal?: AbortSignal,
  workspaceBinding?: InvocationWorkspaceBinding,
  executionContext?: InvocationExecutionContext,
  /** Main-only hook after this invocation's user message is durably stored. */
  onDurableUserMessage?: (messageId: string) => Promise<void | DurableUserMessageHookBlock>,
  /** Main-only display purpose; no renderer request field can set this. */
  hostNoticePurpose?: ChatHostNotice["purpose"],
  /** Main-owned invocation surface, independent of the coordinator's inventory visibility. */
  browserPresentation: "foreground" | "background" = "background",
  /** Capture Main's current Goal admission before the first provider dispatch. */
  onGoalDispatched?: (goalId: string | null) => void,
  login?: BrowserLoginPrerequisiteControl,
  progressAdvisory?: () => string | null,
  onBeforeGoalWorkDispatch?: (goalId: string | null) => void,
  canonicalWorkRecovery?: import("../invocation/main-work-recovery").MainWorkRecoveryContext,
  invocationCurrent?: () => boolean,
  onNativeTurnController?: RunnerEvents["onNativeTurnController"],
  ownerControlInbox?: RunnerRequest["ownerControlInbox"],
): Promise<McpInvocationResult> {
  assertInvocationWorkspaceSourceContext(workspaceBinding, executionContext?.source);
  const historyNative = await import('../one/personal-integrations-runtime');
  const historyRun = await historyNative.bindOneHistoryNativeRun({ runId: req.runId!, chatId: req.chatId });
  let nativeBrowserGrant: NativeBrowserRelayGrant | undefined;
  const workspaceLeases = new Map<string, string>();
  const workspacePins = new Map<string, { revisionId: string; treeDigest: string }>();
  const pinWorkspace = (candidate: InstalledAgent) => {
    const row = getDb().prepare("SELECT builtin, system_prompt FROM installed_agents WHERE id = ?").get(candidate.id) as { builtin: number; system_prompt: string } | undefined;
    if (!row || row.builtin || isCallOnlyHubAgent(candidate) || workspaceLeases.has(candidate.id)) return;
    const leaseId = `${req.runId ?? "invocation"}:${candidate.id}:${randomUUID()}`;
    const pin = acquireAgentWorkspaceRunLease(candidate.id, leaseId); workspaceLeases.set(candidate.id, leaseId); workspacePins.set(candidate.id, pin);
    const workspace = getAgentWorkspace(candidate.id);
    if (workspace.treeDigest !== pin.treeDigest || workspace.currentRevisionId !== pin.revisionId) throw new Error("agent_revision_changed_before_dispatch");
    const canonical = workspace.canonicalEntry ? readAgentWorkspaceFile(candidate.id, workspace.canonicalEntry) : null;
    if (canonical?.binary) throw new Error("agent_revision_entry_binary");
    candidate.systemPrompt = canonical?.content ?? row.system_prompt;
    recordRunEvent({ runId: req.runId ?? leaseId, chatId: req.chatId, agentId: candidate.id, kind: "agent_revision_run_started",
      payload: { schemaVersion: "agentlas.revision-run-receipt.v1", ...pin, status: "started" } });
  };
  let mcpConfigCleanup: (() => void) | undefined;
  let mcpConfigCurrent = true;
  const isMcpConfigCurrent = () => mcpConfigCurrent && !signal?.aborted
    && !login?.ownerSignal.aborted && invocationCurrent?.() !== false;
  const revokeMcpConfig = () => {
    mcpConfigCurrent = false;
    try { mcpConfigCleanup?.(); }
    catch { console.warn("[mcp] invocation abort config cleanup failed; authority closed"); }
  };
  signal?.addEventListener("abort", revokeMcpConfig, { once: true });
  if (login?.ownerSignal !== signal) login?.ownerSignal.addEventListener("abort", revokeMcpConfig, { once: true });
  // Browser fallback ladder binding (electron/browser/fallback-ladder-runtime.ts): chat/run ids + notice sink.
  let unbindBrowserLadder: (() => void) | undefined;
  let browserLadderSettled = false;
  let graphDirectFailureError: unknown;
  // Dispatch facts for a store lock refused on the way (STORE_BUSY_CODE): a planning, team or swarm call before the turn,
  // and the turn itself (modelTurnStarted: every dispatch below it goes through invokeCurrentRuntime).
  let preparationDispatched = false;
  let modelTurnStarted = false;
  try {
  // A scheduled invocation is the worker leg of the automation, even though
  // it shares this implementation with an interactive orchestrator turn.
  // Keep usage and replay attribution aligned with the runtime that actually
  // received the prompt.
  const invocationModelRole = executionContext?.source === "automation" ? "worker" : "orchestrator";
  // 한 마이크로태스크 양보 — ipc:run 핸들러가 { runId }를 반환하고 렌더러가 이벤트 채널을
  // 구독한 뒤에야 sink가 발화하도록 보장한다. 이게 없으면 동기 early-return(no-chat/no-agent)
  // 에러가 구독 전에 발화돼 렌더러가 종료 이벤트를 놓치고 busy(정지 버튼)가 영구 고착된다.
  await Promise.resolve();
  // IPC runs already carry the renderer/main-owned id. Direct integrations (Telegram,
  // site generation, legacy scripts) still receive one internal identity so their
  // content-free memory curation receipts are not silently lost.
  if (!req.runId) req = { ...req, runId: `direct-${randomUUID()}` };
  // Alive's host-supplied state, not its hidden Work chat, owns this wake.
  const isAliveControllerRun = executionContext?.source === "alive";
  // One question-channel decision for this run: nobody can answer (scheduled/background, not Alive's own controller).
  // It closes the turn context with UNATTENDED_NO_ASK_DIRECTIVE, withholds ask_form, skips the briefing ask contract
  // and makes every runtime omit the system `ask:` module (RunnerRequest.unattendedNoAsk), so no channel offers an ask.
  const unattendedNoAsk = isUnattendedExecution(executionContext) && !isAliveControllerRun;
  const scienceRecovery = readScienceRecoveryAuthority(executionContext, req.runId!, req.chatId, req.runtimeSelection);
  if (scienceRecovery) {
    if (req.oneMode || req.agentAppMode || req.borrowAgents?.length || req.taskForceTargets !== undefined
      || req.routerAgent || req.goalMode || req.stormbreakerMode) throw new Error("science_recovery_orchestration_denied");
    req = { ...req, sessionRouting: false, hubMode: "local-only", taskIntent: "conversation" };
  }
  const scienceCollectionCurrent = readScienceCollectionAuthority(executionContext, req.runId!, req.chatId, req.runtimeSelection);
  let scienceCollectionCapability: object | undefined;
  if (scienceCollectionCurrent) {
    if (req.oneMode || req.agentAppMode || req.borrowAgents?.length || req.taskForceTargets !== undefined || req.routerAgent) {
      throw new Error("science_collection_orchestration_denied");
    }
    req = { ...req, permissions: "read", sessionRouting: false, planMode: false, taskIntent: "conversation" };
  }
  const scienceReview = executionContext?.scienceReview
    ? (await import("../science-host/criterion-review")).resolveScienceReviewAuthority(executionContext.scienceReview,req.runId!,req.chatId) : null;
  if (scienceReview && (executionContext?.source!=="science" || req.planMode!==true || req.permissions!=="read")) throw new Error("science-review-read-ceiling-required");
  const planReadOnly = req.planMode === true;
  if (req.agentAppMode) {
    /*
     * ★오너 결정 2026-08-20 — Site 축 전부 개방.
     *
     * 예전에는 이 자리에서 permissions 를 read 로 못박고 브라우저 프로필까지 지워
     * Site 앱이 브라우저·MCP·셸을 하나도 쓸 수 없었다. 이제 Site 는 다른 축과 같은
     * 도구 표면을 받는다: 권한은 **소유자가 앱에 설정한 값**(agent-app-runtime 이
     * 프로젝트 계약에서 읽어 싣는다)이고, 경계는 정적 박탈이 아니라 행동 시점
     * 승인(tool-approval 중재자 + capability_grants)이 지킨다.
     *
     * 여전히 지우는 것: **방문자의 브라우저 입력이 스스로 넓힐 수 있는 것들**.
     * 편성(borrow/taskForce/pipeline/router)과 앱 조작 대상은 요청 본문에서 오면
     * 안 된다 — 이건 권한 강등이 아니라 위조 방지다.
     */
    req = {
      ...req,
      toolMode: req.toolMode ?? "auto",
      borrowAgents: [],
      taskForceTargets: undefined,
      pipelineStages: undefined,
      routerAgent: undefined,
      planMode: planReadOnly,
      goalMode: false,
      appsGenerateMode: false,
      targetAppId: undefined,
      targetAppAction: undefined,
      images: undefined,
    };
  }
  // Every caller, including legacy/direct integrations, crosses the same
  // fail-closed boundary. Unknown or omitted permission is read-only.
  const normalizedPermission = effectiveInvocationPermission(req.permissions, planReadOnly);
  /*
   * Main-issued read-only effect observation: the One/Work ticket (registered by Main before
   * dispatch) or the automation observation (Main-minted `effect-observation-` run id). The
   * identity only ever narrows this run: it selects the Main-enforced read-only browser profile
   * and steers away from runtimes that cannot use tools under read permission.
   */
  const readOnlyObservationRun = normalizedPermission === "read" && (Boolean(effectObservationTicket(req.runId))
    || (Boolean(req.automationId) && typeof req.runId === "string" && req.runId.startsWith("effect-observation-")));
  if (req.permissions !== normalizedPermission) req = { ...req, permissions: normalizedPermission };
  const canWrite = normalizedPermission === "write" || normalizedPermission === "full";
  // A Mobile run consumes only the main-owned snapshot captured at the Bridge
  // boundary. Revalidate after the async handoff and never consult the mutable
  // chat/project folder fields again for this run.
  const boundMobileWorkingFolder: string | null = workspaceBinding
    ? revalidateInvocationWorkspaceBinding(workspaceBinding)
    : null;
  const callerSink = sink;
  // Tool calls that completed in this invocation: host-observed work, read at each continuous Goal pass boundary.
  let completedToolCalls = 0;
  // Of those, the ones that observed something this invocation had not observed yet (createToolObservationNovelty).
  let novelToolObservations = 0;
  const toolObservationNovelty = createToolObservationNovelty();
  let runtimeAgentId: string | undefined;
  let finalTextFromSink = "";
  let resolvedResultFolder: string | undefined;
  let workforcePrepareReceipt: WorkforcePrepareCheckpointReceipt | undefined;
  let backstopSurfaceSeq = 0;
  /*
   * After a successful browser call, read where the agent actually stands from its own browser surface; never
   * blocks. A login wall runs the recovery ladder (owner 2026-09-28: a login wall is a product defect). A site's
   * human check (CAPTCHA/anti-bot) is not solved or bypassed: browser in front, the owner told through One.
   *
   * Owner 2026-10-05 ("코덱스 클로드 agy … 키미도 세상 모든거 다 … api랑 로컬모델도"): every runtime. The call is
   * observed at its result boundary (beforeMcpToolResult), which every runtime's agentlas-browser call passes with
   * the same catalog id and server tool name: Claude, Codex, Antigravity, Kimi, Cursor and Grok through Main's MCP
   * proxy, API keys and local models through the local tool loop. Matching runtime tool names instead had only
   * known the codex spelling: on the owner's store 11,255 Antigravity and 412 Claude browser calls were never
   * observed, and an isolated 1.2.58 app opened a reCAPTCHA page on Claude with no card and no report to One.
   */
  let browserObservedAtBoundary = false;
  // The turn read the automation registration spec (agentlas-ui read_automation_protocol): a host-observed fact that lets a
  // headless registration block be validated as one (automation-emitter.ts parseAutomations headlessFence).
  let automationProtocolRead = false;
  const observeBrowserCall = (leaf: string, notify: (notice: NonNullable<McpInvocationEvent["notice"]>) => void): void => {
    const browserTool = `agentlas-browser.${leaf}`;
    // A native grant's login walls are recovered, awaited, inside beforeMcpToolResult.
    if (!nativeBrowserGrant) {
      void import("../browser/login-recovery-runtime").then(({ observeBrowserToolForLoginWall, ownerLoginCardNotice }) =>
        observeBrowserToolForLoginWall({
          toolName: browserTool, runId: req.runId, chatId: req.chatId, nodeId: executionContext?.nodeId, signal, nativeGrant: nativeBrowserGrant,
          notify: (card) => notify(ownerLoginCardNotice(card, pickLocale(req))),
        })).catch(() => undefined);
    }
    void import("../browser/fallback-ladder-runtime").then(({ observeBrowserToolForHumanCheck, ownerBrowserStepNotice }) => {
      if (leaf === "browser_show_owner") {
        notify(ownerBrowserStepNotice({ locale: pickLocale(req), nativeGrant: nativeBrowserGrant ?? null }));
        return;
      }
      observeBrowserToolForHumanCheck({ toolName: browserTool, ...(req.chatId ? { chatId: req.chatId } : {}), nativeGrant: nativeBrowserGrant ?? null });
    }).catch(() => undefined);
  };
  sink = (rawEvent: McpInvocationEvent) => {
    let ev = redactOneAttachmentEvent(req, rawEvent);
    const emit = (event: McpInvocationEvent) =>
      callerSink(runtimeAgentId && !event.runtimeAgentId ? { ...event, runtimeAgentId } : event);
    if (ev.kind === "final") {
      // ★표시 위생 백스톱 — 여기가 모든 실행 갈래(단일·firm·swarm·borrowed·
      // earlyResult 20여 곳)가 예외 없이 지나는 단 한 자리다. 갈래마다 정리를
      // 복붙하지 않고 이 지점에서 한 번만 판단한다(멱등 — 이미 정리된 텍스트는
      // 여는 울타리가 없어 그대로 통과).
      const hygiene = applyFinalDisplayBackstop(
        ev.durableTextForVerification ?? ev.text,
        {
        locale: pickLocale(req),
        // 미신뢰(Agent App) 실행은 모델이 쓴 매니페스트를 렌더하지 않는다.
        allowSurfaceRender: !req.agentAppMode,
        },
      );
      if (hygiene.changed) {
        // 값은 버리지 않는다: 유효 매니페스트는 원래 보여야 했던 화면으로 승격.
        for (const surface of hygiene.surfaces) {
          backstopSurfaceSeq += 1;
          emit({
            kind: "surface",
            surfaceId: `surface:${req.runId ?? "run"}:backstop:${backstopSurfaceSeq}`,
            surface,
          });
        }
      }
      // The display text below comes from the durable copy, which has the escalation marker line
      // stripped. Carry the fact (never the line) so Main can still offer the approval chip.
      const rawEscalation = typeof ev.text === "string" && hasPermissionEscalationMarker(ev.text);
      ev = {
        ...ev,
        text: hygiene.text,
        ...(ev.agentId ? {} : { observedUsage: currentInvocationObservedUsage() }),
        ...(rawEscalation ? { permissionEscalationMarkerForVerification: true } : {}),
        durableTextForVerification: ev.durableTextForVerification ?? hygiene.durableText,
        userDecisionRequest: hygiene.userDecisionRequest
          ? {
              ...hygiene.userDecisionRequest,
              ...(ev.durableAssistantMessageIdForVerification
                ? { sourceMessageId: ev.durableAssistantMessageIdForVerification }
                : {}),
            }
          : undefined,
      };
    }
    if (ev.kind === "final" && ev.text?.trim()) {
      finalTextFromSink = ev.text.trim();
    }
    if (isCompletedToolEvent(ev)) completedToolCalls += 1;
    if (ev.kind === "tool-use" && ev.tool && toolObservationNovelty.note(ev.tool) && isCompletedToolEvent(ev)) novelToolObservations += 1;
    // Backstop for a run whose browser calls never reached the result boundary (beforeMcpToolResult below):
    // recognise the call by its runtime's name. Codex says `agentlas-browser.browser_x`; Claude, Antigravity
    // and the local loop say `mcp__agentlas-browser__browser_x`.
    const browserLeaf = !browserObservedAtBoundary && ev.kind === "tool-use" && ev.tool?.result !== undefined && !ev.tool.isError
      ? /^(?:agentlas-browser\.|mcp__agentlas-browser__)(browser_[a-z_]+)$/.exec(ev.tool.name)?.[1] : undefined;
    if (browserLeaf) {
      observeBrowserCall(browserLeaf, (notice) => { try { emit({ kind: "notice", notice }); } catch { /* run ended */ } });
    }
    if (ev.kind === "tool-use" && ev.tool?.result !== undefined && !ev.tool.isError
      && /^(?:agentlas-ui\.|mcp__agentlas-ui__)read_automation_protocol$/.test(ev.tool.name)) automationProtocolRead = true;
    emit(ev);
  };
  const earlyResult = () => ({
    finalText: finalTextFromSink || undefined,
    observedUsage: currentInvocationObservedUsage(),
    stormbreakerContinueRequested: false,
    resultFolder: resolvedResultFolder,
    workforcePrepareReceipt,
  });
  const beforeMcpToolResult = async (input: { catalogId: string | null; toolName: string; isError: boolean }): Promise<void> => {
    login?.assertRunnable();
    if (input.catalogId === "agentlas-ui" && input.toolName === "read_automation_protocol" && !input.isError) automationProtocolRead = true;
    if (input.catalogId === "agentlas-browser") {
      browserObservedAtBoundary = true;
      if (!input.isError && /^browser_[a-z_]+$/.test(input.toolName)) {
        observeBrowserCall(input.toolName, (notice) => { try { sink({ kind: "notice", notice }); } catch { /* run ended */ } });
      }
    }
    if (!login || !nativeBrowserGrant || !["agentlas-browser", "cua-driver"].includes(input.catalogId ?? "")) return;
    const observed = login.beginObservation();
    try {
    let outcomes: Awaited<ReturnType<typeof import("../browser/login-recovery-runtime").recoverLoginWallsNow>>;
    try {
      const { recoverLoginWallsNow, ownerLoginCardNotice } = await import("../browser/login-recovery-runtime");
      outcomes = await recoverLoginWallsNow({ runId: req.runId, chatId: req.chatId,
        nodeId: executionContext?.nodeId, signal: login.ownerSignal, nativeGrant: nativeBrowserGrant,
        onPrerequisiteRestored: ref => login.restored(ref),
        notify: card => sink({ kind: "notice", notice: ownerLoginCardNotice(card, pickLocale(req)) }),
      });
    } catch (error) {
      // Looking for a login wall is best effort; failing to look must not cost the result the tool already produced.
      // Production 1.3.3: all 26 daemon-run browser and computer-use calls were reset at this boundary (window runs: 0 of 794);
      // 1.3.5 named the cause: the recovery module failed to load in the daemon (MODULE_NOT_FOUND).
      login.assertRunnable();
      const errorCode = (error as { code?: unknown } | null)?.code;
      const code = typeof errorCode === "string" && /^[A-Z0-9_]{2,40}$/.test(errorCode) ? errorCode
        : error instanceof Error && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.message) ? error.message : "unknown";
      tryRecordRunEvent({ runId: req.runId!, chatId: req.chatId, nodeId: executionContext?.nodeId, kind: "browser_login_observation_failed",
        sourceEventId: `browser-login-observation:${randomUUID()}`, payload: { catalogId: input.catalogId, toolName: input.toolName, code } });
      return;
    }
    login.observe(outcomes);
    login.assertRunnable();
    } finally { observed(); }
  };
  const locale = pickLocale(req);
  const oneTeamExecutionPolicy = mainOneTeamExecutionPolicy(req);
  const boundOneTeamRuntime = mainOneTeamRuntimeBinding(req);
  if (oneTeamExecutionPolicy === "native_one_staffing") {
    const authority = (req as MainBoundOneInvocationRequest).oneTeamStaffingAuthority;
    if (!boundOneTeamRuntime || !oneTeamUsesNativeStaffing(authority)
      || !req.oneUserAuthoredPrompt
      || authority!.promptDigest !== `sha256:${createHash("sha256").update(req.oneUserAuthoredPrompt).digest("hex")}`) {
      sink({ kind: "error", error: { code: "one-native-staffing-binding-invalid",
        message: locale === "ko" ? "One 팀 운영 요청의 실행 바인딩이 달라 시작하지 않았습니다."
          : "The One staffing request binding changed, so execution did not start." } });
      return earlyResult();
    }
  }
  if (oneTeamExecutionPolicy) {
    /*
     * 여기서 묻는 것은 "Main 이 만든 모양인가"이지 "로컬 설치본인가"가 아니다 —
     * 판정과 그 이유는 shared/one-team-preflight.ts 에 있다. 로컬 에이전트만
     * 통과시키던 동안 빌려온 좌석이 있는 단톡방은 실행이 0.2초 만에 죽었고,
     * 바로 아래에 있는 Hub slug 수리까지 도달하지도 못했다.
     */
    const exactRosterTargets = oneConfirmedRosterTargetsAreExact(req.taskForceTargets);
    if (
      oneTeamExecutionPolicy === "confirmed_existing_roster"
      && (!boundOneTeamRuntime || !exactRosterTargets)
    ) {
      sink({
        kind: "error",
        error: {
          code: "one-team-binding-invalid",
          message: locale === "ko"
            ? "확정된 One 팀의 실행 바인딩이 유효하지 않아 실행을 중단했습니다."
            : "The confirmed One team binding is invalid, so execution was stopped.",
        },
      });
      return earlyResult();
    }
    if (
      oneTeamExecutionPolicy === "confirmed_external_workforce"
      && !boundOneTeamRuntime
    ) {
      sink({
        kind: "error",
        error: {
          code: "one-workforce-binding-invalid",
          message: locale === "ko"
            ? "확인된 One Workforce 실행 바인딩이 유효하지 않아 시작하지 않았습니다."
            : "The confirmed One Workforce binding is invalid, so execution did not start.",
        },
      });
      return earlyResult();
    }
    /*
     * ★수리 2026-08-25 — 확정된 로스터의 Hub 대여 좌석을 여기서 다시 지우면
     * service.ts 가 실은 borrowAgents 가 무효가 된다(같은 병의 두 번째 자리).
     * 확정된 로스터 대상 중 hub 좌석의 slug 만 남긴다 — 렌더러가 임의 slug 를
     * 넣을 수는 없다. 이 목록은 Main 이 설치 원장에서 만든 대상에서만 나온다.
     */
    const confirmedRosterTargets = oneTeamExecutionPolicy === "confirmed_existing_roster"
      ? req.taskForceTargets
      : undefined;
    const confirmedRosterBorrowSlugs = [...new Set(
      (confirmedRosterTargets ?? [])
        .filter((target) => target.source === "hub")
        .map((target) => (target as { slug: string }).slug),
    )];
    req = {
      ...req,
      sessionRouting: false,
      hubMode: oneTeamExecutionPolicy === "confirmed_external_workforce"
        ? oneTeamWorkforceHubMode((req as MainBoundOneInvocationRequest).oneTeamStaffingAuthority)
        : confirmedRosterBorrowSlugs.length > 0
          ? "hub-allowed"
          : "local-only",
      borrowAgents: confirmedRosterBorrowSlugs,
      borrowVersions: undefined,
      pipelineStages: undefined,
      routerAgent: undefined,
      taskForceTargets: confirmedRosterTargets,
    };
  }
  const storedChat = getChat(req.chatId);
  const chat = storedChat ? repairRootChatSurfaceController(storedChat) : null;
  if (!chat) {
    sink({ kind: "error", error: { code: "no-chat", message: tStatus(locale, "errChatNotFound") } });
    return earlyResult();
  }
  // The room's model chip governs the room's orchestrator: a turn the host starts here without naming a runtime (Goal
  // resume, operational recovery, a teammate's report, a Mobile message) runs the chat's pin like the owner's own turn
  // (runtime/room-chip-runtime.ts). Flags that mean "the request itself named this runtime" keep reading the explicit one.
  const explicitRuntimeSelection = req.runtimeSelection;
  const roomChipSelection = roomChipRuntimeSelection({
    explicit: explicitRuntimeSelection,
    chatPin: chat.runtimeSelection,
    executionSource: executionContext?.source ?? null,
    graphWorker: Boolean(executionContext?.graphWorkerAttempt),
    automationId: req.automationId ?? null,
    agentAppMode: req.agentAppMode === true,
  });
  if (roomChipSelection) req = { ...req, runtimeSelection: roomChipSelection };
  const browserApprovalScope: BrowserApprovalScope | undefined = chat.id === req.chatId
    ? executionContext?.source === "science"
      ? Object.freeze({ surface: "science" as const, chatId: chat.id })
      : chat.originSurface === "one" || chat.originSurface === "work"
        ? Object.freeze({ surface: chat.originSurface, chatId: chat.id })
        : undefined
    : undefined;
  // Freeze conversation state before this turn becomes durable. Every routing
  // decision and model history below must see only earlier turns; otherwise the
  // current request is duplicated as both history and the active user prompt.
  // A scheduled graph is not a chat turn: its state is already carried by the
  // graph checkpoint, node variables, and the current node prompt. Replaying
  // the automation's durable chat here only injects stale recovery prose and
  // can make a model change rebuild an enormous, unrelated transcript.
  const excludedSupervisorInputs = supervisorExcludedHistoryMessages(getDb(), chat.id, req.runId);
  // A turn carried from directions the owner wrote into the previous run answers those rows: they are its prompt, so
  // they are not history too (invocation/carried-owner-followups.ts).
  const carriedFollowupMessages = carriedFollowupMessageIds(getDb(), chat.id, req.runId);
  for (const id of carriedFollowupMessages) excludedSupervisorInputs.add(id);
  const history = req.agentAppMode || executionContext?.source === "automation" || scienceRecovery
    ? []
    : listChatMessages(chat.id, 80).filter(message => !excludedSupervisorInputs.has(message.id));
  const priorHistory = history;
  const hadPriorConversationContext = scienceRecovery || req.agentAppMode || isAliveControllerRun
    ? false
    : hasPriorConversationContext(chat.id);
  // Group, firm, borrowed-task-force, and Stormbreaker branches return before
  // the ordinary single-run persistence point. Keep the visible request durable
  // exactly once regardless of which executable orchestrator owns it.
  // Personal ingress already committed this exact human message with its ACK.
  // Reuse that binding instead of appending a second copy during dispatch.
  let persistedUserMessageId: string | null = supervisorIngressMessage(getDb(), chat.id, req.runId)
    ?? carriedFollowupMessages.at(-1) ?? null;
  let userMessagePersisted = persistedUserMessageId !== null;
  // A product-authored continuation is not the person's turn. It stays durable
  // so the next turn keeps the context, but it is written as a system turn:
  // replaying the conversation must never attribute our wording to the user,
  // and it must never become the conversation's title.
  const effectObservationRun = Boolean(effectObservationTicket(req.runId));
  const promptIsSystemAuthored = req.promptOrigin === "system";
  const persistUserMessage = () => {
    if (effectObservationRun || req.agentAppMode || userMessagePersisted) return;
    // A check-in One runs on its own leaves no row; only One's own message, if any, appears (dots parity).
    if (promptIsSystemAuthored && hostNoticePurpose === "one-checkin") { userMessagePersisted = true; return; }
    if (promptIsSystemAuthored) {
      appendChatMessage(chat.id, "system", req.userPrompt, (hostNoticePurpose === "goal-continuation" || hostNoticePurpose === "one-dispatch-brief" || hostNoticePurpose === "update-resume" || hostNoticePurpose === "one-delegation-review") && req.runId
        ? { hostNotice: { purpose: hostNoticePurpose, runId: req.runId } } : undefined);
    } else {
      /*
       * ★붙인 사진은 그 사람의 턴의 일부다 — 텍스트만 저장하면 대화를 다시 열었을 때
       * 사진이 사라진다. 저장 배관(persistChatMessageImages)은 예전부터 있었는데
       * 데스크탑 경로에서 이 인자를 넘기지 않아, 실제로 그것을 쓰는 곳은 모바일
       * 브리지 하나뿐이었다.
       */
      persistedUserMessageId = appendChatMessage(chat.id, "user", ownerVisiblePrompt(req), req.images?.length ? { images: req.images } : undefined).id;
      if (priorHistory.length === 0) autoTitleFromFirstMessage(chat.id, ownerVisiblePrompt(req));
    }
    userMessagePersisted = true;
  };
  // The user's turn belongs to the conversation even when routing, provider
  // authentication, or a later authority check fails before model dispatch.
  // Persist it at the first safe point after the exact local chat is resolved;
  // later orchestration branches keep calling this idempotent helper.
  persistUserMessage();
  // The run's own origin: graph tools called later in this run anchor their reports here, never on the conversation's
  // latest message (a second owner message can arrive while this run is still saving its graph — notyet NH15).
  if (req.runId && persistedUserMessageId) {
    tryRecordRunEvent({ runId: req.runId, chatId: chat.id, kind: "origin_user_message", payload: { messageId: persistedUserMessageId } });
  }
  if (persistedUserMessageId && onDurableUserMessage && !signal?.aborted) {
    try {
      const hookResult = await onDurableUserMessage(persistedUserMessageId);
      if (hookResult?.blockInvocation) {
        // The user row is already durable. Publish through the ordinary error
        // sink so InvocationService records invoke_failed and releases busy
        // state, while returning before any runtime or tool can start.
        sink({ kind: "error", error: { code: hookResult.code, message: hookResult.message } });
        return earlyResult();
      }
      chat.goalId = getChatGoalId(chat.id);
    } catch {
      tryRecordRunEvent({ runId: req.runId!, chatId: chat.id, kind: "durable_user_message_hook_failed", payload: { messageId: persistedUserMessageId } });
      // The hook may be committing Goal resume authority. An unexpected
      // failure is not the explicit degraded-intake outcome: never dispatch a
      // provider or synthesize completion from an empty successful result.
      throw new Error("durable_user_message_hook_failed");
    }
  }
  if (signal?.aborted) return earlyResult();
  // A paired phone and a direct scheduled run use the normal Desktop runtime
  // contract. Multi-hop unattended orchestration has a narrower Main-authored
  // boundary below so planner/worker/synthesis output cannot smuggle memory
  // control events across hops without reducing direct Mobile/scheduled runs.
  const restrictedReadBoundary = false;
  const restrictedOrchestrationBoundary =
    executionContext?.source === "automation" && !canWrite;
  // An unattended read automation may work in its selected folder, but it must
  // not silently inherit mutable Desktop-only project notes, activated memory,
  // ontology, or project-scoped Experience. This is deliberately narrower than
  // `restrictedReadBoundary`: the selected runtime and its read tools remain
  // available, preserving Desktop/Mobile execution parity.
  // Science and Alive own their state outside Work. A runtime directory must
  // not seed Work memory or evolution proposals into either actor.
  const suppressMutableProjectContext = isAliveControllerRun || executionContext?.source === "science"
    || (executionContext?.source === "automation" && !canWrite);
  // Permission still controls normal Desktop write authority. It is unrelated
  // to whether the request originated from a paired phone.
  const projectReadOnlyBoundary = !canWrite || restrictedReadBoundary;
  const suppressProjectBinding = executionContext?.source === "site-studio" || isAliveControllerRun;
  // Site Studio and Alive have hidden conversations, but those chat rows are
  // not authority to consume an arbitrary Desktop Project. Freeze the effective
  // project id once in Main so a stale/tampered row cannot re-enter through
  // context notes, Experience selection, firm delegation, or curation.
  const invocationProjectId = suppressProjectBinding || suppressMutableProjectContext
    ? null
    : chat.projectId;
  // A local agent changes while it works (owner edits, its own evolution): run the folder's current definition.
  // Stat-only check; a re-import happens only when a definition file is newer than the last import.
  try {
    const { refreshLocalAgentIfChanged } = await import("../agents/local-freshness");
    await refreshLocalAgentIfChanged(chat.agentId);
    for (const target of req.taskForceTargets ?? []) {
      if (target.source === "local" && target.entityKind === "agent") await refreshLocalAgentIfChanged(target.agentId);
    }
  } catch (error) {
    console.warn("[local-agent] freshness check unavailable:", error instanceof Error ? error.message : String(error));
  }
  // Owner 2026-10-13: an archived agent is not called directly — only the Settings restore button or routing brings it back.
  // Routing (One's roster pick, task-force targets) restores it; a direct call to it is refused with a typed code.
  for (const target of req.taskForceTargets ?? []) {
    if (target.source === "local" && target.entityKind === "agent") restoreAgentForUse(target.agentId);
  }
  if (isAgentArchived(chat.agentId)) {
    sink({ kind: "error", error: { code: "agent_archived", message: tStatus(locale, "errAgentArchived") } });
    return earlyResult();
  }
  let agent = getAgentById(chat.agentId);
  if (!agent) {
    sink({ kind: "error", error: { code: "no-agent", message: tStatus(locale, "errAgentNotFound") } });
    return earlyResult();
  }
  pinWorkspace(agent);
  for (const target of req.taskForceTargets ?? []) {
    if (target.source === "local" && target.entityKind === "agent") { const participant = getAgentById(target.agentId); if (participant) pinWorkspace(participant); }
  }
  // A call-only Hub seat has no local instructions: its direct chat must run as
  // a Hub borrow (BYOM bundle), never as a local empty-prompt spawn. Explicit
  // targets/borrows and One-policy runs keep their own routing; only the plain
  // single-agent path is redirected here.
  if (
    !req.oneMode
    && !oneTeamExecutionPolicy
    && req.taskForceTargets === undefined
    && (req.borrowAgents?.length ?? 0) === 0
    && isCallOnlyHubAgent(agent)
  ) {
    req = { ...req, borrowAgents: [agent.slug] };
  }
  const oneControllerOnlyCommand = req.oneMode
    ? oneControllerOnlyHephaestusCommand(req.userPrompt)
    : null;
  if (oneControllerOnlyCommand && agent.id !== ONE_AGENT_ID) {
    sink({
      kind: "error",
      error: {
        code: "one-controller-command-required",
        message: locale === "ko"
          ? `hep-${oneControllerOnlyCommand}는 One만 실행할 수 있습니다. 이 동료에게는 로컬 Tool·MCP와 hep-storm을 사용할 수 있습니다.`
          : `Only One can run hep-${oneControllerOnlyCommand}. This teammate can use local Tools, MCP, and hep-storm.`,
      },
    });
    return earlyResult();
  }
  const oneParticipantEffectivePrompts = oneTeamExecutionPolicy
    ? validatedOneParticipantEffectivePromptMap(mainOneParticipantExecutionSnapshot(req))
    : null;
  if (oneTeamExecutionPolicy) {
    const targetIds = oneTeamExecutionPolicy === "confirmed_existing_roster"
      ? (req.taskForceTargets ?? []).flatMap((target) =>
          target.source === "local" && target.entityKind === "agent" ? [target.agentId] : [])
      : [];
    const expectedIds = [agent.id, ...targetIds];
    const actualIds = oneParticipantEffectivePrompts
      ? [...oneParticipantEffectivePrompts.keys()]
      : [];
    const exactIds = new Set(expectedIds).size === expectedIds.length
      && [...expectedIds].sort().join("\u0000") === [...actualIds].sort().join("\u0000");
    const exactSlugs = exactIds && expectedIds.every((agentId) => {
      const liveAgent = getAgentById(agentId);
      const frozen = oneParticipantEffectivePrompts?.get(agentId);
      // The conversation controller can be an installed team package selected
      // directly from One's organisation. Dynamically selected team targets do
      // not enter expectedIds (they retain their Firm target binding), so only
      // the controller is allowed to carry kind=team here.
      return Boolean(liveAgent && frozen && liveAgent.slug === frozen.agentSlug
        && (liveAgent.kind !== "team" || agentId === expectedIds[0]));
    });
    if (!oneParticipantEffectivePrompts || !exactIds || !exactSlugs) {
      sink({
        kind: "error",
        error: {
          code: "one-participant-prompt-snapshot-invalid",
          message: locale === "ko"
            ? "확정된 One 참여자의 실행 프롬프트 스냅샷이 유효하지 않아 실행을 중단했습니다."
            : "The exact One participant prompt snapshot is invalid, so execution was stopped.",
        },
      });
      return earlyResult();
    }
  }
  const effectivePromptFor = (candidate: InstalledAgent): string => {
    pinWorkspace(candidate);
    if (!oneParticipantEffectivePrompts) {
      return buildEffectiveAgentSystemPrompt(candidate.id, candidate.systemPrompt);
    }
    const frozen = exactOneParticipantEffectivePrompt(
      oneParticipantEffectivePrompts,
      candidate.id,
      candidate.slug,
    );
    if (frozen === null) {
      throw new Error(`One participant prompt snapshot is unavailable: ${candidate.id}`);
    }
    if (workspacePins.has(candidate.id) && frozen !== buildEffectiveAgentSystemPrompt(candidate.id, candidate.systemPrompt)) throw new Error("one_participant_revision_changed");
    return frozen;
  };
  runtimeAgentId = agent.id;
  const targetApp = req.targetAppId ? getAgentApp(req.targetAppId) : null;
  const isTargetAppEdit = Boolean(targetApp && req.targetAppAction === "edit");
  if (req.targetAppId && !targetApp) {
    sink({
      kind: "error",
      error: {
        code: "app-not-found",
        message:
          locale === "ko"
            ? `수정할 App을 찾을 수 없습니다: ${req.targetAppId}`
            : `Could not find the App to edit: ${req.targetAppId}`,
      },
    });
    return earlyResult();
  }
  let effectiveUserPromptParts: DeclaredPromptPart[] = isTargetAppEdit && targetApp
    ? buildAppEditUserPromptParts(req.userPrompt, targetApp, locale)
    : req.planMode && !scienceReview
        ? buildPlanUserPromptParts(req.userPrompt, locale)
        : [currentUserRequestPart(req.userPrompt)];
  let effectiveUserPrompt = composeCurrentUserPrompt(effectiveUserPromptParts);
  const addEffectiveUserParts = (parts: readonly DeclaredPromptPart[]) => {
    effectiveUserPromptParts.push(...parts);
    return composeCurrentUserPrompt(effectiveUserPromptParts);
  };
  /*
   * What this turn was asked to do, as the agent's experience records it ("이 에이전트는 다음과 같은 요청을
   * 수행한다: …"). A host-written prompt — a Goal continuation, an update resume, One's review of finished work — is
   * not a request; it was saved as One's procedure memory word for word (QA 2026-10-04, "[Host: work you delegated
   * has finished…]"). A brief One handed to a worker is a real task, so it stays.
   */
  const hostWrotePrompt = () => promptIsSystemAuthored && hostNoticePurpose !== "one-dispatch-brief";
  if (oneTeamExecutionPolicy) {
    const taskSurfaceRecipe = oneTaskSurfaceRecipe(req.userPrompt, locale === "ko");
    // Output presentation and optional follow-ups do not constrain the current
    // task's execution authority. Keep them outside the Main-owned team boundary.
    // Each body is independently closed before ordering; the unchanged Taskforce
    // display consumer can never strip an interleaved owner slot with a host block.
    const oneInvocationInstructions: DeclaredPromptPart[] = [
      { id: "purpose.one.invocation.result", revision: 3, stability: "fixed-policy", changeTriggers: ["release"], text: `result: no routing openers; a structured result (research, comparison, schedule, document, media) ends with exactly one ${SURFACE_OPEN_FENCE} JSON ${SURFACE_CLOSE_FENCE} Surface (read_surface_protocol or exact host-delivered Surface contract); its title/summary is the finished conclusion only; comparisons: a choice column, exactly one recommended row, every key cell a value or "not verified"; sources only in evidence (no links in strings); never invent coordinates, prices or files; numbers and names must not contradict each other` },
      { id: "purpose.one.invocation.followups", revision: 2, stability: "configuration", changeTriggers: ["locale"], text: oneFriendlyFollowupProtocol(locale === "ko" ? "ko" : "en") },
      { id: "purpose.one.invocation.recipe", revision: 3, stability: "task-context", changeTriggers: ["task", "owner-input"], text: taskSurfaceRecipe },
      { id: "purpose.one.invocation.authority", revision: 2, stability: "final-boundary", changeTriggers: ["permission", "tool-grant", "task"], text: `boundary: ${oneTeamExecutionPolicy === "confirmed_existing_roster"
        ? "only the exact installed roster Main confirmed; no other agent or team"
        : oneTeamExecutionPolicy === "confirmed_external_workforce"
          ? "only the Hub Workforce releases the owner confirmed and Hub pinned; never a silent substitute"
          : oneTeamExecutionPolicy === "native_one_staffing"
            ? "the owner-requested member creation/invitation/delegation through the One team tools; reuse current room members and sessions first"
            : "single-agent run; no other agent or team"}; need more → stop and say a new One team review is needed` },
    ];
    effectiveUserPrompt = addEffectiveUserParts(oneInvocationInstructions.map(part => closedCurrentUserPart(part, "one")));
  }
  // 자동화 세션에서 온 사용자 채팅: 이 자동화의 실시간 수정 계약을 앞에 세운다.
  // 오너 결정 2026-08-19: 채팅 리얼타임 수정이 본선이고 편집 버튼은 보조다. 실측:
  // 사용자가 "view 10k 이상만" 지시 → 모델이 hephaestus graph CLI(터미널 저장소)를
  // 만지고 "업데이트했다"고 답했지만 이 자동화의 graph_json은 그대로였다. 그래프
  // 저장소가 둘인데 모델에게는 둘 다 "그래프 편집"으로 보인 것. 유일하게 이 자동화를
  // 바꾸는 경로(## Automation 블록, 아래 소비부가 즉시 적용)를 이름·현재 그래프와
  // 함께 명시하고, CLI는 이 목적에 금지한다.
  if (req.automationId && executionContext?.source !== "automation") {
    try {
      const target = listAutomations().find((a) => a.id === req.automationId);
      if (target) {
        const graphJson = target.graph ? JSON.stringify(target.graph) : null;
        const editContract: DeclaredPromptPart[] = [
          closedCurrentUserPart({ id: "user.current.automation-edit.guide", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 20, text: "never the terminal graph CLI (another store); claim the change only after emitting the block; a recurring action prompt pinning 80+ chars of quoted text is refused → carry facts/links/hashtags and compose fresh wording each run" }, "automation-edit"),
          closedCurrentUserPart({ id: "user.current.automation-edit.target", revision: 1, stability: "task-context", changeTriggers: ["task", "plan-revision"], order: 40, text: `automation: this chat edits "${target.name}"; to change it, end the reply with a \`## Automation\` block named exactly "${target.name}" holding the full updated graph (the only path; call read_automation_protocol for the format)` }, "automation-edit"),
          closedCurrentUserPart({ id: "user.current.automation-edit.graph", revision: 1, stability: "task-context", changeTriggers: ["plan-revision"], order: 50, text: graphJson ? `graph: ${graphJson}` : "graph: none (single-prompt automation)" }, "automation-edit"),
        ];
        effectiveUserPrompt = addEffectiveUserParts(editContract);
      }
    } catch {
      // 계약 주입 실패가 대화 자체를 막으면 안 된다.
    }
  }
  if (executionContext?.source === "automation") {
    /*
     * The project of an automation run is a host fact, never the model's pick. This boundary used to list every owner
     * project and tell the model to choose one from that list, returning a short question when unclear, on every run,
     * bound or not. An unattended run told to ask when unclear asks: production 2026-10-13..16, graph
     * cdf732ca (YouTube daily, project_id NULL) step 1 ended 9+ times with "Which connected project and publishing
     * account should I use…?" / blocker "Connected project selection required from available project list" while its
     * real work (room, channel, files) needed no project. Now: a bound project is stated as the fact it is; an unbound
     * run gets no list and no choice, and works in its own automation workspace as before.
     */
    const boundProject = automationBoundProject(chat.projectId, workspaceBinding);
    const automationBoundary: DeclaredPromptPart[] = [
      closedCurrentUserPart({ id: "user.current.automation-run.guide", revision: 2, stability: "fixed-policy", changeTriggers: ["release"], order: 30, text: "automation run: start with the finished result; no routing/runtime reports" }, "automation-run"),
      ...(boundProject ? [closedCurrentUserPart({ id: "user.current.automation-run.project", revision: 1, stability: "task-context", changeTriggers: ["task", "project-instructions"], order: 60, text: `project: ${JSON.stringify(boundProject.name)} (the host bound this run to it)` }, "automation-run")] : []),
    ];
    effectiveUserPrompt = addEffectiveUserParts(automationBoundary);
  }
  // Science is its own product with its own roster (Research Director, assistants, specialists): the Work "recruit via
  // Workforce" policy sent Haiku to workforce_goal_context and the Hub in a research run (live run r1, 2026-10-17).
  if (req.sessionRouting && executionContext?.source !== "science") {
    const incumbentRoster = [agent.nameEn || agent.name || agent.slug].filter(Boolean);
    // Hub 자동 보강은 프로젝트에서 허용한 slug 로만 제한한다.
    const rentAllowed = invocationProjectId
      ? (() => {
          try {
            return listRentAllowedSlugs(invocationProjectId);
          } catch {
            return [] as string[];
          }
        })()
      : null;
    const rentPolicy = rentAllowed === null
      ? ""
      : rentAllowed.length > 0
        ? `; Hub auto-use only: ${rentAllowed.join(", ")} (others only when the user names them)`
        : "; no Hub agent auto-use (only when the user names one)";
    const sessionRoutingPolicy: DeclaredPromptPart[] = [
      closedCurrentUserPart({ id: "user.current.session.guide", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 40, text: "keep it when it can do the work; only a real capability gap → recruit the minimum role via Workforce (Hub/Cloud) and say which and why" }, "session"),
      closedCurrentUserPart({ id: "user.current.session.roster", revision: 1, stability: "task-context", changeTriggers: ["task", "agent-instructions"], order: 70, text: `team: ${incumbentRoster.join(", ")}` }, "session"),
      closedCurrentUserPart({ id: "user.current.session.rent-policy", revision: 1, stability: "task-context", changeTriggers: ["task", "project-instructions"], order: 80, text: rentPolicy }, "session"),
    ];
    effectiveUserPrompt = addEffectiveUserParts(sessionRoutingPolicy);
  }
  if (req.oneMode && req.stormbreakerMode === true) {
    effectiveUserPrompt = addEffectiveUserParts([
      closedCurrentUserPart({ id: "user.current.preference.stormbreaker", revision: 1, stability: "turn-context", changeTriggers: ["owner-input"], order: 10, text: "stormbreaker: the user prefers it this turn; you stay the only controller and use its execute/verify/repair loops only when useful; not carried to later turns" }, "preference"),
    ]);
  }
  if (req.oneMode && req.fastMode === true) {
    effectiveUserPrompt = addEffectiveUserParts([
      closedCurrentUserPart({ id: "user.current.preference.fast", revision: 1, stability: "turn-context", changeTriggers: ["owner-input"], order: 0, text: "fast: one direct pass; no repeat execution, Stormbreaker or sub-runs; cannot finish → state only the next condition needed, no guessing or retry; not carried to later turns" }, "preference"),
    ]);
  }
  // `/hep-network` now enters the host-LLM Agent Workforce Ontology path.
  // The old lexical recommendation path remains available only as the explicit
  // compatibility command `/hep-network --legacy`.
  const workforceCommand = oneTeamExecutionPolicy === "confirmed_external_workforce"
    ? { kind: "workforce" as const, goal: req.userPrompt, benchmarkMode: false }
    : parseWorkforceCommand(req.userPrompt, req.agentAppMode === true);
  const workforceBenchmarkMode = workforceCommand.kind === "workforce" && workforceCommand.benchmarkMode;
  let explicitWorkforceGoal = workforceCommand.kind === "workforce" ? workforceCommand.goal : null;
  const explicitNetworkGoal = workforceCommand.kind === "legacy-network" ? workforceCommand.goal : null;
  if (workforceCommand.kind !== "none") {
    const routedGoal = workforceCommand.goal;
    if (!routedGoal) {
      sink({
        kind: "error",
        error: {
          code: "hep-network-goal-required",
          message: locale === "ko" ? "Workforce에 실행할 요청을 입력하세요." : "Provide a goal for Workforce.",
        },
      });
      return earlyResult();
    }
    req = { ...req, userPrompt: routedGoal, borrowAgents: undefined, taskForceTargets: undefined };
    effectiveUserPromptParts = [currentUserRequestPart(routedGoal)];
    effectiveUserPrompt = composeCurrentUserPrompt(effectiveUserPromptParts);
  }
  const borrowedAgentSlugs = [...new Set((req.borrowAgents ?? []).map((slug) => slug.trim()).filter(Boolean))];
  // 이번 턴에 사용자가 대상을 직접 지목했는가. 아래 경로들이 req를 다시 만들며
  // taskForceTargets를 지우므로, 지목 사실은 여기서 한 번 붙잡아 둔다.
  const userNamedTargetsThisTurn = (req.taskForceTargets?.length ?? 0) > 0;
  let explicitBorrowUserPreamble: string | null = null;
  let explicitBorrowUserParts: DeclaredPromptPart[] = [];
  let explicitBorrowSpecs: BorrowedAgentSpec[] = [];
  let explicitBorrowMemoryKeys: string[] = [];
  const explicitBorrowOwnerScopeKey = activeBorrowedOwnerScopeKey();
  if (req.pipelineStages && req.pipelineStages.length > 0) {
    effectiveUserPromptParts = buildRecommendedPipelineUserPromptParts(effectiveUserPromptParts, req.pipelineStages, locale);
    effectiveUserPrompt = composeCurrentUserPrompt(effectiveUserPromptParts);
  }

  // 추천 시트 네트워크 모드(단일) — 고른 Hub 에이전트를 빌려와 프롬프트 앞에 borrow 지시를 붙인다(BYOM).
  // 2개 이상은 아래 Borrowed Task Force 실행기로 분기해 plan → parallel delegate → synthesize를 수행한다.
  const shouldPrepareBorrowPreamble =
    borrowedAgentSlugs.length > 0 &&
    (borrowedAgentSlugs.length === 1 || chat.kind === "division");
  if (shouldPrepareBorrowPreamble) {
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `Hub 에이전트 빌리는 중: ${borrowedAgentSlugs.join(", ")}`
          : `Borrowing Hub agents: ${borrowedAgentSlugs.join(", ")}`,
    });
    try {
      const preparedBorrow = await buildBorrowUserPreamble(
        borrowedAgentSlugs,
        effectiveUserPrompt,
        workspaceBinding
          ? boundMobileWorkingFolder
          : suppressProjectBinding
            ? null
            : getChatWorkingFolder(chat.id),
        locale,
        signal,
        req.borrowVersions,
      );
      explicitBorrowUserPreamble = preparedBorrow.preamble;
      explicitBorrowUserParts = preparedBorrow.parts;
      explicitBorrowSpecs = preparedBorrow.specs;
      explicitBorrowMemoryKeys = preparedBorrow.specs.map((spec) =>
        borrowedMemoryKey(spec.agentDefinitionId!, spec.agentReleaseId!)
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      sink({ kind: "error", error: { code: "borrowed-agent-unavailable", message } });
      return earlyResult();
    }
  }

  let runtimes = await detectRuntimes();
  // Credit fallback is admitted only from a current authenticated wallet.
  // Warm it on actual subscription exhaustion, before role-pool selection.
  if (runtimes.some((runtime) => peekProviderQuotaExhausted(runtime.kind, Date.now(), runtime.model ?? undefined))) {
    await getBillingCredits();
    throwIfInvocationAborted(signal, locale);
  }
  // A pinned runtime missing from the cached inventory is re-probed once before the run fails: one slow probe under
  // load dropped codex and failed a Science turn with science-runtime-unavailable (dev app, 2026-09-27 00:23Z).
  if (req.runtimeSelection && !runtimes.some((runtime) => runtime.kind === req.runtimeSelection!.kind)) {
    runtimes = await detectRuntimes(true);
  }
  throwIfInvocationAborted(signal, locale);
  // The same for the runtime a One team was confirmed on: a probe that ran out of time under load leaves the cached
  // inventory with another spelling or an unknown version of the same executable (W7 2026-10-18, S-followup-during-team
  // failed one-team-runtime-changed 6 s after the owner's message). Read the inventory again once before refusing.
  if (boundOneTeamRuntime && !oneTeamRuntimeBindingMatches(boundOneTeamRuntime, runtimes)) {
    runtimes = await detectRuntimes(true);
    throwIfInvocationAborted(signal, locale);
  }
  if (boundOneTeamRuntime && !oneTeamRuntimeBindingMatches(boundOneTeamRuntime, runtimes)) {
    sink({
      kind: "error",
      error: {
        code: "one-team-runtime-changed",
        message: locale === "ko"
          ? "팀 확인에 사용한 런타임을 더 이상 사용할 수 없습니다. 현재 상태로 팀을 다시 검토해주세요."
          : "The runtime selected for team confirmation is no longer available. Review the team again against the current inventory.",
      },
    });
    return earlyResult();
  }
  const installedAgents = listInstalledAgents();
  // Agent Apps are request/response surfaces, not durable chat continuations.
  // An earlier browser request must not influence a later caller's routing.
  const hasPriorContext = hadPriorConversationContext;
  // plain 대화(인사/맞장구)는 라우팅 전체를 건너뛰고 기본 LLM이 즉답 — 전문 에이전트로
  // 잘못 위임되거나 아래 Hephaestus 에스컬레이션 선지연을 무는 엣지케이스를 없앤다.
  const hubWorkforceRequested = shouldForceHubFirstWorkforce({
    agentAppMode: req.agentAppMode === true,
    hubMode: req.hubMode,
    borrowedAgentCount: borrowedAgentSlugs.length,
    plainConversation: false,
    targetAppEdit: isTargetAppEdit,
  });
  // Scheduled runs already carry an explicit target and their own Hub policy.
  // Applying the global chat auto-route here used to turn every default
  // `hub-allowed` automation into Workforce before the selected agent could run.
  const autoRoute = req.agentAppMode
    ? null
    : oneTeamExecutionPolicy || explicitWorkforceGoal || explicitNetworkGoal || hubWorkforceRequested
      ? null
    : req.sessionRouting
      ? null
    : isTargetAppEdit
    ? selectAppBuilderForExistingAppEdit(installedAgents, locale)
    : req.appsGenerateMode
      ? selectAppBuilderForAppsGenerate(installedAgents, locale)
    : hasPriorContext
      ? null
    : null;
  if (autoRoute) {
    agent = autoRoute.agent;
    pinWorkspace(agent);
    runtimeAgentId = agent.id;
    sink({ kind: "tool-use", status: autoRouteStatus(autoRoute, locale) });
  }

  // 사용자가 프롬프트 안에 "project folder: /abs/path"처럼 명시하면, 채팅 워킹 폴더로
  // 자동 고정한다. firm 경로도 단일 에이전트 경로와 같은 cwd/MCP 구성을 받아야 한다.
  const existingWorkingFolder = workspaceBinding
    ? boundMobileWorkingFolder
    : suppressProjectBinding
      ? null
      : getChatWorkingFolder(chat.id);
  const projectWorkingFolder = workspaceBinding
    ? null
    : invocationProjectId
      ? getProject(invocationProjectId)?.folderPath ?? null
      : null;
  const inferredWorkingFolder =
    workspaceBinding || !canWrite || existingWorkingFolder || projectWorkingFolder
      ? null
      : inferWorkingFolderFromPrompt(req.userPrompt, {
        // 자동화·사이트·트렉 실행의 프롬프트는 제품이 조립한 것이다. 거기 담긴 경로는
        // 작업 폴더 선언이 아니라 처리 대상이다(위 주석의 실측 참고).
        authored: isUnattendedExecution(executionContext) ? "machine" : "human",
      });
  if (inferredWorkingFolder) setChatWorkingFolder(chat.id, inferredWorkingFolder);
  const targetAppWorkingFolder = !workspaceBinding && !suppressProjectBinding && targetApp
    ? path.resolve(targetApp.rootPath)
    : null;
  let workingFolder: string | null = suppressProjectBinding
    ? null
    : workspaceBinding
      ? boundMobileWorkingFolder
      : targetAppWorkingFolder ?? existingWorkingFolder ?? projectWorkingFolder ?? inferredWorkingFolder;
  // Even a global chat executes in a concrete local folder. Persist it in the
  // run receipt so generated files do not become undiscoverable after reload.
  resolvedResultFolder = workingFolder ?? agentRunCwd();
  await prepareWorkAttachmentContext(req, resolvedResultFolder, signal);
  // A snapshot's relative paths must use the same concrete cwd in every selected runner.
  if (mainWorkAttachmentContext(req, resolvedResultFolder)) workingFolder = resolvedResultFolder;
  // The owner-full fact is minted once by Main and passed separately to worker
  // config materialization. Worker permission remains write; it is never
  // upgraded merely because the parent can run a preview.
  const workspacePreviewOwnerGrant: WorkspacePreviewOwnerGrant | undefined = (() => {
    if (!workingFolder || normalizedPermission !== "full" || req.agentAppMode || req.simulation === true) return undefined;
    let canonicalCwd: string;
    try { canonicalCwd = fs.realpathSync(workingFolder); } catch { return undefined; }
    // A long run keeps one preview across worker/turn handoffs, while a deleted
    // goal must not leave its process addressable by a later goal in the same
    // chat. Fall back to the chat only for ordinary non-goal turns.
    const taskScopeId = getChatGoalId(chat.id) ?? chat.id;
    return {
      schemaVersion: "agentlas.workspace-preview-owner-grant.v1",
      grantId: randomUUID(),
      taskScopeId,
      chatId: chat.id,
      runId: req.runId!,
      canonicalCwd,
      ownerExecutionPermission: "full",
    };
  })();

  if (explicitNetworkGoal) {
    try {
      const routed = await routeOnly(explicitNetworkGoal, {
        project: workingFolder ?? undefined,
        hubOnly: true,
        scope: "network",
        timeoutMs: 12_000,
        signal,
      });
      throwIfInvocationAborted(signal, locale);
      const recommendation = normalizeRecommendation(routed.json, explicitNetworkGoal);
      const targets = recommendation.agents.map((candidate) => candidate.target);
      if (targets.length === 0) {
        throw new Error("Hephaestus Network returned no executable exact targets.");
      }
      req = { ...req, taskForceTargets: targets, borrowAgents: undefined };
      sink({
        kind: "tool-use",
        status: locale === "ko"
          ? `Hephaestus Network가 ${targets.length}개 실행 단위를 선택했습니다.`
          : `Hephaestus Network selected ${targets.length} execution unit(s).`,
      });
    } catch (error) {
      throwIfInvocationAborted(signal, locale);
      sink({ kind: "error", error: invocationFailure(req, "hep-network-route-failed", error, executionContext) });
      return earlyResult();
    }
  }

  // 자동화 Hub 정책: 명시적인 Hub-first만 Workforce를 선행 구성한다.
  // hub-allowed(로컬 우선)는 선택된 에이전트를 먼저 실행하고, local-only는
  // 이 경로를 막는다. 정확한 Hub 대상은 borrowAgents 경로가 별도로 소유한다.
  if (!explicitWorkforceGoal && !explicitNetworkGoal && hubWorkforceRequested) {
    explicitWorkforceGoal = effectiveUserPrompt;
    sink({
      kind: "tool-use",
      status: locale === "ko"
        ? "Hub 자동화 요청을 Agent Workforce 온톨로지로 구성합니다."
        : "Building the Hub automation through Agent Workforce Ontology.",
    });
  }

  // Network is an explicit per-turn override. Absence means the current
  // One/project controller decides with its supplied project roster; Main never
  // activates a global lexical route.
  let routerAgent = req.agentAppMode ? undefined : req.routerAgent;

  const runtimeTargets = [
    { scope: "agent" as const, targetId: agent.id },
    { scope: "firm" as const, targetId: chat.firmId },
  ];
  // A message typed in an automation's session panel is still an explicit
  // request against that automation's pinned runtime. It must not silently
  // turn a Gemini failure into a Codex answer; show the actual failure so the
  // user can repair the selected runtime or graph.
  const automationRuntimePinned = Boolean(req.automationId && req.runtimeSelection);
  if (executionContext?.source === "alive" && (req.promptOrigin !== "system" || !req.runtimeSelection?.model)) {
    sink({ kind: "error", error: { code: "alive-runtime-selection-required",
      message: "An Alive wake requires its exact selected model and a system-origin prompt." } });
    return earlyResult();
  }
  if (executionContext?.source === "science" && !req.runtimeSelection?.model) {
    sink({ kind: "error", error: {
      code: "science-runtime-selection-required",
      message: locale === "ko" ? "Science에서 연구 모델을 선택한 뒤 다시 시작하세요." : "Select a Science research model before starting this study.",
    } });
    return earlyResult();
  }
  // Science owns the model for the whole research session, independently of
  // Library assignments and the Work/One role pools, including error recovery.
  const scienceRuntimePinned = executionContext?.source === "science" && Boolean(req.runtimeSelection);
  const aliveRuntimePinned = executionContext?.source === "alive" && Boolean(req.runtimeSelection);
  // Main-only checkpoint dispatch retains its exact producer binding. A model
  // handoff requires a separate validated boundary, not the recovery pool.
  // An effect observation also starts as a goal-continuation run and now carries the Goal's exact runtime (2a85294b),
  // but it is one look, not a checkpoint successor: treating it as one demanded a checkpoint it never has
  // (checkpoint_dispatch_context_missing on every codex/serving look, live 2026-09-25).
  // The room chip is not a producer binding: a Goal resume running it keeps the One fallback chain.
  const continuationRuntimePinned = hostNoticePurpose === "goal-continuation" && Boolean(explicitRuntimeSelection)
    && !effectObservationTicket(req.runId);
  // One's composer selection is the controller's first runtime for both One
  // chat and One Work/graph runs. A normal Library assignment remains the
  // default for other surfaces; One only leaves its pin after a typed runtime
  // failure, at which point the ordered orchestrator pool takes over.
  // A model chosen on the interactive composer is the user's execution
  // decision for this turn.  Library role assignments may fill an Auto choice,
  // but must not replace this explicit pin.
  const directUserRuntimePinRequested = req.promptOrigin !== "system" && Boolean(explicitRuntimeSelection);
  const runtimeResolution = selectInvocationRuntime(runtimes, runtimeTargets, {
    pin: req.runtimeSelection,
    // The room chip has the authority the owner's own turn gives it.
    pinIsAuthoritative:
      directUserRuntimePinRequested || Boolean(roomChipSelection) || isUnattendedExecution(executionContext) || req.oneMode === true || automationRuntimePinned || scienceRuntimePinned || aliveRuntimePinned || continuationRuntimePinned,
    agentAppMode: req.agentAppMode === true,
  });
  const directUserRuntimePinHonored = directUserRuntimePinRequested && runtimeResolution.pinHonored;
  const directUserTeamControlAuthority = directUserRuntimePinHonored
    && !restrictedOrchestrationBoundary
    && req.agentAppMode !== true;
  let runtimeChoice = runtimeResolution.choice;
  if ((scienceRuntimePinned || aliveRuntimePinned || continuationRuntimePinned) && runtimeChoice) {
    // The selection policy knows which model lists can prove an exact pin is
    // absent. CLI picker catalogs can omit valid aliases or hidden models.
    if (pinnedRuntimeCredentialOrModelUnavailable(runtimeChoice.active)) {
      runtimeChoice = null;
    }
  }
  let controllerFallbackBeforeRun: RuntimeStatus | null = null;
  /*
   * ★고른 런타임이 지금 한도에 걸려 있으면 **시작하기 전에** 비켜 간다.
   *
   * 실사용 실측 2026-09-07: agy 가 한도인 채로 실행이 들어가 `7m 4s 동안 작업 · 실패`
   * 를 낸 뒤에야 폴백이 돌았다. 이미 아는 사실을 확인하려고 7분을 쓴 것이다.
   * 저장된 선택은 건드리지 않는다 — 시한이 지나면 다음 턴이 알아서 원래 모델로 간다.
   */
  // Work gets the same pre-run cooldown avoidance for a runtime it did not pin
  // (owner 2026-09-23: long-run behaviour must match One). A Work composer pin
  // stays the user's exact decision and is never swapped here.
  const workUnpinnedCooldownAvoidance = req.oneMode !== true && !runtimeResolution.pinHonored
    && chat?.originSurface === "work" && req.agentAppMode !== true;
  if (runtimeChoice && ((req.oneMode === true && runtimeResolution.pinHonored) || workUnpinnedCooldownAvoidance)
    && !continuationRuntimePinned) {
    const cooling = runtimeCooldown(runtimeChoice.active);
    if (cooling) {
      const fallback = rolePriorityRuntimes(runtimes, "orchestrator")[0];
      const fallbackPicked = fallback ? pickRunner(fallback) : null;
      if (fallback && fallbackPicked) {
        runtimeChoice = { active: fallback, picked: fallbackPicked, override: null, unavailableOverride: null };
        controllerFallbackBeforeRun = fallback;
      } else {
        /*
         * 대신 갈 곳이 없다. 그러면 쿨다운을 **지키지 않는다** — 아무것도 안 하는 것보다
         * 한 번 더 해 보는 쪽이 낫다(한도가 이미 풀렸을 수도 있다). 기록만 지운다.
         */
        clearRuntimeCooldown(runtimeChoice.active);
      }
    }
  }
  // A One composer pin is a preference with an ordered recovery chain, not a
  // reason to stop before a runner starts. If the selected executable vanished
  // between the picker and dispatch, begin at orchestrator priority 1.
  if (!runtimeChoice && req.oneMode === true && runtimeResolution.pinHonored && !continuationRuntimePinned) {
    const fallback = rolePriorityRuntimes(runtimes, "orchestrator")[0];
    const fallbackPicked = fallback ? pickRunner(fallback) : null;
    if (fallback && fallbackPicked) {
      runtimeChoice = {
        active: fallback,
        picked: fallbackPicked,
        override: null,
        unavailableOverride: null,
      };
      controllerFallbackBeforeRun = fallback;
    }
  }
  if (runtimeChoice && !runtimeChoice.picked && req.oneMode === true && runtimeResolution.pinHonored && !continuationRuntimePinned) {
    const fallback = rolePriorityRuntimes(runtimes, "orchestrator")[0];
    const fallbackPicked = fallback ? pickRunner(fallback) : null;
    if (fallback && fallbackPicked) {
      runtimeChoice = {
        active: fallback,
        picked: fallbackPicked,
        override: null,
        unavailableOverride: null,
      };
      controllerFallbackBeforeRun = fallback;
    }
  }
  /*
   * ★A read-only observation must be able to call its read tools. Antigravity's headless read
   * mode refuses any configured tool surface (antigravityReadToolFailure →
   * agy_read_tools_unsupported), so an observation pinned there failed every retry (production
   * 2026-09-23, automation observation on an agy-pinned automation). Start such a run on the
   * next orchestrator runtime instead; the pin itself is not rewritten.
   */
  if (runtimeChoice && readOnlyObservationRun && !continuationRuntimePinned
    && !OBSERVATION_READ_TOOL_CAPABLE(runtimeChoice.active.kind)) {
    const fallback = rolePriorityRuntimes(runtimes, "orchestrator")
      .find((candidate) => OBSERVATION_READ_TOOL_CAPABLE(candidate.kind) && pickRunner(candidate));
    const fallbackPicked = fallback ? pickRunner(fallback) : null;
    tryRecordRunEvent({ runId: req.runId!, chatId: req.chatId, kind: "observation_runtime_selection",
      payload: { schemaVersion: 1, reasonCode: "observation_read_tools_unsupported",
        refusedKind: runtimeChoice.active.kind, fallbackKind: fallback?.kind ?? null } });
    if (fallback && fallbackPicked) {
      runtimeChoice = { active: fallback, picked: fallbackPicked, override: null, unavailableOverride: null };
      controllerFallbackBeforeRun = fallback;
    }
  }
  if (!runtimeChoice) {
    sink({
      kind: "error",
      error: {
        code: aliveRuntimePinned ? "alive-runtime-unavailable" : scienceRuntimePinned ? "science-runtime-unavailable" : continuationRuntimePinned
          ? "goal-runtime-unavailable" : req.oneMode
          ? "one-runtime-unavailable"
          : runtimeResolution.pinHonored
            ? "pinned-runtime-unavailable"
            : "no-runtime",
        message: runtimeResolution.pinHonored && req.runtimeSelection
          ? `Pinned ${aliveRuntimePinned ? "Alive" : scienceRuntimePinned ? "Science" : continuationRuntimePinned ? "Goal checkpoint" : "automation"} runtime is unavailable: ${req.runtimeSelection.kind}${req.runtimeSelection.model ? ` · ${req.runtimeSelection.model}` : ""}`
          : tStatus(locale, "errNoRuntime"),
      },
    });
    return earlyResult();
  }

  // 두 설정 표면이 같은 결정을 주장할 때, 어느 쪽이 이겼는지 반드시 사용자에게 알린다.
  if (runtimeResolution.pinYieldedToOverride) {
    const assigned = runtimeResolution.pinYieldedToOverride.selection;
    const assignedLabel = `${assigned.kind}${assigned.model ? ` · ${assigned.model}` : ""}`;
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `이 채팅의 런타임 고정 대신 Library에서 이 에이전트에 배정한 런타임(${assignedLabel})으로 실행합니다.`
          : `Using the runtime assigned to this agent in Library (${assignedLabel}) instead of this chat's pinned runtime.`,
    });
  }

  if (runtimeChoice.unavailableOverride) {
    const fallbackLabel = runtimeChoice.fallbackStage === "worker"
      ? (locale === "ko" ? "Worker 런타임" : "the worker runtime")
      : (locale === "ko" ? "연결된 정상 런타임" : "another connected working runtime");
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `선택한 모델을 지금 사용할 수 없어 ${fallbackLabel}으로 이어갑니다.`
          : `The selected model is unavailable right now, so Agentlas is continuing with ${fallbackLabel}.`,
    });
  }
  if (req.agentAppMode && "fallbackFromKind" in runtimeChoice && runtimeChoice.fallbackFromKind) {
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `${runtimeChoice.fallbackFromKind} 런타임은 Agent App 격리를 증명할 수 없어 안전한 무도구 런타임으로 실행합니다.`
          : `${runtimeChoice.fallbackFromKind} cannot prove Agent App isolation; using a safe stateless no-tool runtime.`,
    });
  }

  let active = runtimeChoice.active;
  let picked = runtimeChoice.picked;
  if (scienceCollectionCurrent) {
    scienceCollectionCurrent();
    assertScienceCollectionRuntimeSelection(active, req.runtimeSelection);
    if (chat.kind !== "division" || chat.firmId || agent.kind === "team") throw new Error("science_collection_orchestration_denied");
  }
  if (boundOneTeamRuntime && oneTeamRuntimeBinding(active).digest !== boundOneTeamRuntime.digest) {
    sink({
      kind: "error",
      error: {
        code: "one-team-runtime-selection-changed",
        message: locale === "ko"
          ? "확인한 런타임과 실제 실행 런타임이 달라 실행을 중단했습니다."
          : "The runtime selected for execution differs from the confirmed runtime, so execution was stopped.",
      },
    });
    return earlyResult();
  }
  if (!picked) {
    sink({
      kind: "error",
      error: {
        code: aliveRuntimePinned ? "alive-runtime-unavailable" : scienceRuntimePinned ? "science-runtime-unavailable" : "no-runner",
        message: tStatus(locale, "errNoRunner", {
          kind: active.kind,
          backend: active.backend,
        }),
      },
    });
    return earlyResult();
  }
  const pickedForWorkforceLeader = picked;
  const confirmedRuntime: RuntimeSelection = selectionForRuntime(active, {
    longContext: active.longContextEnabled ?? undefined,
  });
  if (continuationRuntimePinned && req.runtimeSelection && (
    confirmedRuntime.kind !== req.runtimeSelection.kind
    || confirmedRuntime.backend !== req.runtimeSelection.backend
    || confirmedRuntime.source !== req.runtimeSelection.source
    || confirmedRuntime.model !== req.runtimeSelection.model
    || (req.runtimeSelection.effort !== undefined && confirmedRuntime.effort !== req.runtimeSelection.effort)
    || (req.runtimeSelection.longContext !== undefined && confirmedRuntime.longContext !== req.runtimeSelection.longContext)
    || (req.runtimeSelection.acpAgentId !== undefined && active.acpAgentId !== req.runtimeSelection.acpAgentId)
  )) {
    sink({ kind: "error", error: { code: "goal-runtime-binding-mismatch",
      message: "The requested Goal runtime changed during selection; continuation was stopped before execution." } });
    return earlyResult();
  }
  bindInvocationJudgmentRuntime(confirmedRuntime);
  const runtimeLabel = `${runtimeDisplayName(confirmedRuntime.kind)}${confirmedRuntime.model ? ` · ${confirmedRuntime.model}` : ""}`;
  console.info(
    `[runtime-selection] run=${req.runId ?? "-"} node=${executionContext?.nodeId ?? "root"} `
      + `kind=${confirmedRuntime.kind} backend=${confirmedRuntime.backend ?? "-"} `
      + `source=${confirmedRuntime.source ?? "-"} model=${confirmedRuntime.model ?? "-"}`,
  );
  sink({
    kind: "notice",
    model: confirmedRuntime.model ?? confirmedRuntime.kind,
    modelRole: invocationModelRole,
    runtimeSelection: confirmedRuntime,
    notice: {
      level: "info",
      code: "runtime-selected",
      // The label is usually an English product name, where 을/를 cannot be decided
      // from the last syllable (koSubjectParticle falls back to "이(가)"). A labelled
      // clause needs no particle, so no "을(를)" machine seam reaches the screen.
      message: locale === "ko"
        ? `이번 실행에 고른 AI: ${runtimeLabel}. 실제로 호출되는지 확인하고 있습니다.`
        : `This run uses ${runtimeLabel}; checking that the call goes through.`,
      i18n: {
        ko: `이번 실행에 고른 AI: ${runtimeLabel}. 실제로 호출되는지 확인하고 있습니다.`,
        en: `This run uses ${runtimeLabel}; checking that the call goes through.`,
      },
      details: JSON.stringify(confirmedRuntime),
    },
  });
  let controllerSelectionForFallback: RuntimeSelection = req.runtimeSelection ?? confirmedRuntime;
  const oneControllerFallbackEligible = req.oneMode === true && runtimeResolution.pinHonored && !continuationRuntimePinned;
  const emitControllerRuntimeFallback = (
    fallback: RuntimeStatus,
    failure: Pick<RunnerFailure, "kind" | "runtime" | "source" | "providerCode" | "exitCode" | "retryAfterHint"> | null,
  ): void => {
    if (!oneControllerFallbackEligible) return;
    const nextSelection: RuntimeSelection = {
      kind: fallback.kind,
      backend: fallback.backend,
      source: fallback.source,
      model: fallback.model ?? undefined,
      longContext: fallback.longContextEnabled,
      effort: fallback.effort ?? undefined,
      role: "orchestrator",
      inherit: false,
    };
    const sameSelection = controllerSelectionForFallback.kind === nextSelection.kind
      && controllerSelectionForFallback.backend === nextSelection.backend
      && controllerSelectionForFallback.source === nextSelection.source
      && controllerSelectionForFallback.model === nextSelection.model;
    if (sameSelection) return;
    const previous = controllerSelectionForFallback;
    controllerSelectionForFallback = nextSelection;
    req = { ...req, runtimeSelection: nextSelection };
    bindInvocationJudgmentRuntime(nextSelection);
    /*
     * ★폴백은 이번 실행의 우회로지 **사용자의 선택을 바꾸는 일이 아니다**.
     *
     * 실사용 실측 2026-09-07. 사용자가 제미나이를 골라 뒀는데 여기서
     * `setChatRuntimeSelection(chat.id, nextSelection)` 으로 그 선택을 **영구히
     * 덮어썼다.** agy 한도는 25분이면 풀리는데 대화는 영영 grok 에 남았고, 사용자는
     * "제미나이로 했는데", "왜 자꾸 그록으로 바뀌냐", "자꾸 걍 그록만 호출된다" 를
     * 반복해 겪었다. 매 턴 손으로 되돌려야 원래 모델로 돌아온다.
     *
     * 같은 자리의 Work 경로(아래 recovery 루프의 else 가지)는 처음부터 옳게 하고
     * 있었다 — "저장된 선택은 변경하지 않았습니다". One 만 달랐다.
     *
     * 이제 선택은 사용자 것으로 두고, 대신 **고장 사실에 시한을 붙인다**
     * (runtime-cooldown). 그래서 다음 턴은 죽은 런타임을 빠르게 건너뛰고, 한도가
     * 풀리면 사용자가 아무것도 안 해도 원래 모델로 **스스로 돌아온다.**
     */
    const fromLabel = `${previous.kind}${previous.model ? ` · ${previous.model}` : ""}`;
    const toLabel = `${nextSelection.kind}${nextSelection.model ? ` · ${nextSelection.model}` : ""}`;
    const contextLimited = failure && modelContextFailureReason(failure) === "context_capacity";
    const reason = failure?.kind === "quota"
      ? locale === "ko" ? "사용 한도에 걸려" : "hit its usage limit"
      : contextLimited
        ? locale === "ko" ? "요청이 모델의 문맥 한도를 넘어" : "exceeded its context limit"
        : locale === "ko" ? "실행할 수 없어" : "became unavailable";
    const koMessage = `One 모델 ${fromLabel}이 ${reason} 이번 실행만 ${toLabel}로 이어갑니다. 저장된 선택은 ${previous.kind}${previous.model ? ` · ${previous.model}` : ""} 그대로이고, 사용할 수 있게 되면 자동으로 돌아갑니다.`;
    const enMessage = `One's ${fromLabel} ${failure?.kind === "quota" ? "hit its usage limit" : contextLimited ? "exceeded its context limit" : "became unavailable"}; continuing this run on ${toLabel}. Your saved selection is unchanged and will be used again as soon as it works.`;
    const message = locale === "ko"
      ? koMessage
      : enMessage;
    sink({
      kind: "notice",
      model: nextSelection.model ?? nextSelection.kind,
      modelRole: "orchestrator",
      runtimeSelection: nextSelection,
      notice: {
        level: "warning",
        code: "runtime-fallback",
        message,
        i18n: { ko: koMessage, en: enMessage },
        details: JSON.stringify({
          from: previous,
          to: nextSelection,
          reason: failure?.kind ?? "unavailable-before-run",
          runtime: failure?.runtime ?? null,
          failureSource: failure?.source ?? null,
          providerCode: failure?.providerCode ?? null,
          exitCode: failure?.exitCode ?? null,
          retryAfterHint: failure?.retryAfterHint ?? null,
          // 저장된 선택은 건드리지 않는다 — 폴백은 이번 실행에만 적용된다.
          savedSelectionChanged: false,
        }),
      },
    });
  };
  if (controllerFallbackBeforeRun) {
    emitControllerRuntimeFallback(controllerFallbackBeforeRun, null);
  }
  if (oneTeamExecutionPolicy) {
    const hostRunFacts: DeclaredPromptPart[] = [
      closedCurrentUserPart({ id: "user.current.host-facts.reporting", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 50, text: 'report exactly these when asked (never "requested only", "unverifiable" or a generic name)' }, "host-facts"),
      closedCurrentUserPart({ id: "user.current.host-facts.settings", revision: 1, stability: "configuration", changeTriggers: ["runtime", "permission"], text: `model=${active.model ?? active.kind}; permission=${req.permissions}` }, "host-facts"),
    ];
    effectiveUserPrompt = addEffectiveUserParts(hostRunFacts);
  }
  if (explicitWorkforceGoal && !isWorkforceLeaderRuntimeAllowed(active.kind)) {
    sink({
      kind: "error",
      error: {
        code: "workforce-leader-runtime-unsupported",
        message: locale === "ko"
          ? `선택한 ${active.kind} 런타임은 Workforce 리더의 로컬 무권한 경계가 검증되지 않았습니다. 다른 모델로 몰래 대체하지 않고 실행을 중단했습니다.`
          : `The selected ${active.kind} runtime has no verified local no-authority boundary for the Workforce leader. Execution was stopped without a hidden model fallback.`,
      },
    });
    return earlyResult();
  }

  // Legacy text aliases remain accepted for old deep links, but the Desktop
  // composer sends a typed per-turn preference and never rewrites user text.
  const stormbreakerPrefix = /^\s*(?:\/?hep-storm|\/?hep-network\s+--stormbreaker|\/?stormbreaker)\b\s*/i;
  const explicitStormbreakerRequest = stormbreakerPrefix.test(req.userPrompt);
  const structuredStormbreakerRequest = req.stormbreakerMode === true;
  const explicitStormbreakerGoal = explicitStormbreakerRequest
    ? req.userPrompt.replace(stormbreakerPrefix, "").trim() || req.userPrompt
    : req.userPrompt;
  const oneTeamAllowsStorm = !scienceRecovery && !isAliveControllerRun && !scienceCollectionCurrent && executionContext?.source !== "science" && (!oneTeamExecutionPolicy || oneTeamExecutionPolicy === "solo_locked" || oneTeamExecutionPolicy === "native_one_staffing");
  // A Main-issued read-only effect observation is one look at the outside world,
  // never a Goal cycle, Stormbreaker loop or multi-pass continuation.
  // A teammate in a One room does its piece of work and answers One. The Goal/Stormbreaker/UltraCode protocol belongs to the
  // controller turns only (One and AGI): production 2026-10-12, every Motiondirector room turn re-read it (owner: "모든
  // 에이전트가 이걸 알아야 함? One만 알면 되는 거 아니냐").
  const roomMemberTurn = Boolean(req.oneMode && !req.agentAppMode && chat.id && roomMemberContext(chat.id));
  const stormbreakerEngaged = oneTeamAllowsStorm && !roomMemberTurn && !req.agentAppMode && !restrictedReadBoundary && !effectObservationRun && (
    chat.kind === "division" ||
    chat.continuousMode === true ||
    explicitStormbreakerRequest ||
    structuredStormbreakerRequest ||
    isStormbreakerAutoEnabled()
  );
  /* 이번 턴을 얼마나 올릴 것인가 — 직전 턴의 관측으로 정한다.
   *
   * 요청 문장은 읽지 않는다. 실사용 558턴 실측에서 단어 신호의 재현율은 21.7%,
   * 가벼운 턴 오탐은 130건 중 115건이었다. 같은 코퍼스에서 직전 턴 이어받기는
   * 재현율 88.5%였고 전체 턴의 86%가 후속 턴이다. 첫 턴은 예측하지 않는다. */
  const previousTurn = previousTurnObservation(chat.id);
  const turnEscalation = classifyTurnEscalation({
    previousTurn,
    explicitTeamRequest: explicitStormbreakerRequest || structuredStormbreakerRequest,
  });
  const projectRosterForTurn = invocationProjectId
    ? (getProject(invocationProjectId)?.agentPool ?? [])
    : [];
  const stormbreakerSwarm =
    oneTeamAllowsStorm &&
    !req.agentAppMode &&
    !restrictedReadBoundary &&
    chat.kind !== "division" &&
    !chat.continuousMode &&
    // 토글이 켜져 있어도 직전 턴이 가벼웠으면 올리지 않고, 사용자가 직접 요청했으면
    // 언제나 올린다. "매번"이 아니라 "관측이 그렇게 말할 때"다.
    (explicitStormbreakerRequest || structuredStormbreakerRequest || isStormbreakerAutoEnabled()) &&
    turnEscalation.level === "team";

  // ── MCP 툴 브리지 ──────────────────────────────────────────
  // Claude Code/Codex 러너에는 요청/에이전트 문맥으로 필요한 MCP 플러그인을 자동 선택한 뒤
  // 런타임별 설정으로 직렬화해 넘긴다. env가 필요한 플러그인은 vault 값이 있을 때만 자동 설치한다.
  let mcpConfigPath: string | undefined;
  let mcpGoalSelectionIsCurrent: (() => boolean) | undefined;
  let mcpGoalSelectionInvalidated = false;
  const assertMcpGoalSelectionCurrent = (): void => {
    (require('../one/personal-data-runtime') as typeof import('../one/personal-data-runtime')).assertOnePersonalDataRunCurrent(req.runId);
    historyNative.assertOneHistoryRunCurrent({ runId: req.runId!, chatId: req.chatId });
    assertGraphWorkerAttempt(executionContext?.graphWorkerAttempt);
    if (mcpGoalSelectionIsCurrent && !mcpGoalSelectionIsCurrent()) mcpGoalSelectionInvalidated = true;
    if (mcpGoalSelectionInvalidated) {
      throw Object.assign(new Error("mcp_goal_tool_scope_changed"), { code: "mcp-goal-tool-scope-changed" });
    }
  };
  let mcpAllowedTools: string[] | undefined;
  let mcpCodexConfigArgs: string[] | undefined;
  let mcpRuntimeEnv: Record<string, string> | undefined;
  // Set when the run's tool authority is a single-use grant (Science): the runner must not keep the process resident.
  let ephemeralToolGrant = false;
  let isolatedMcpConfig = false;
  let prepareWorkerCapabilities: PrepareWorkerCapabilities | undefined;
  // Selecting an authenticated browser adds a capability; it does not revoke
  // the file/shell grant needed by mixed implementation and visual QA work.
  // Only the explicit host-normalized tool mode restricts execution to browser.
  const browserOnly = req.toolMode === "browser";
  // 커넥터 C38 — 이번 호출에 걸린 도구 중개 관문. 걸지 못했으면 계속 null이고,
  // 그 사실이 그대로 실행 기록으로 나간다(못 막은 것을 막았다고 적지 않는다).
  let toolBroker: MaterializedToolBroker | null = null;
  // 관문 파일이 **실제로 러너 요청에 실렸는가**. 계획과 결과를 가르는 유일한 사실이다.
  let toolBrokerInstalled = false;
  // config key ↔ catalog id 대응. 관문 생성이 이 블록 바깥으로 나가면서 필요해졌다.
  let mcpIncludedServers: Array<{ serverId: string; catalogId: string | null; configKey: string }> = [];
  // Goal turns that get goal_wait / goal_complete from agentlas-turn (same turns the wait/completion text is injected on).
  const turnGoalToolsOffered = Boolean(req.runId) && !scienceRecovery && !req.agentAppMode && chat.kind !== "division"
    && !effectObservationRun && !roomMemberTurn && !executionContext && (Boolean(getChatGoalId(chat.id)) || (req.goalMode === true && canWrite));
  // ask_form is offered on attended runs only (not unattended, Mobile durable, app-mode or division runs).
  const turnAskToolOffered = Boolean(req.runId) && !unattendedNoAsk
    && !usesMobileDurableDecision(executionContext) && !req.agentAppMode && chat.kind !== "division";
  // One Team attached to a Work task as a Toolchain consumer: it may search and run, not author.
  let mcpToolchainConsumer = false;
  let mcpAutoSelectionPrompt = "";
  // ★한 곳에서만 답한다(shared/runtime-mcp.ts). 예전에는 이 자리에 손으로 적은
  // 여섯 줄이 있었고, ACP 러너가 session/new.mcpServers 번역을 배운 뒤에도 그 목록은
  // 배우지 못해 cursor·kimi·acp 는 mcpConfigPath 자체를 못 받았다 — 번역기는 고쳤는데
  // 넘겨줄 config 가 없어 여전히 도구 0개로 돌았다.
  const runtimeCanUseMcp = runtimeKindCanUseMcp(active.kind);
  const agentAppToolGrant = req.agentAppMode ? req.agentAppRuntimeToolGrant : undefined;
  let acceptedAgentAppInlineMcpConfig: string | undefined;
  const markAgentAppMcpRuntimeUnavailable = () => {
    if (agentAppToolGrant) agentAppToolGrant.runtimeStatus = "runtime-unavailable";
  };
  const agentAppCapabilityRuntimeEligible =
    req.agentAppMode &&
    "capabilityRuntimeEligible" in runtimeChoice &&
    runtimeChoice.capabilityRuntimeEligible === true;
  if (agentAppToolGrant && !agentAppCapabilityRuntimeEligible) {
    // Runtime selection can change between Site's JIT preflight and dispatch.
    // Degrade to the stateless no-tool path rather than passing the grant to a
    // runtime that cannot prove the exact capability boundary.
    markAgentAppMcpRuntimeUnavailable();
  } else if (agentAppToolGrant) {
    const toolSet = new Set(agentAppToolGrant.mcpAllowedTools);
    const exactTools =
      toolSet.size === agentAppToolGrant.mcpAllowedTools.length &&
      validSiteAgentAppMcpGrantTools(
        agentAppToolGrant.mcpAllowedTools,
        agentAppToolGrant.availableCatalogIds,
      );
    const exactCatalog = new Set(agentAppToolGrant.availableCatalogIds).size === agentAppToolGrant.availableCatalogIds.length;
    const runtimeEnvKeys = Object.keys(agentAppToolGrant.mcpRuntimeEnv);
    const exactEnvAliases = runtimeEnvKeys.length === 0;
    let exactConfig = false;
    try {
      acceptedAgentAppInlineMcpConfig = resolveSiteAgentAppInlineMcpConfigForDispatch(
        agentAppToolGrant,
        listInstalledMcpServers(),
      ) ?? undefined;
      exactConfig = Boolean(acceptedAgentAppInlineMcpConfig);
    } catch {
      exactConfig = false;
    }
    if (
      agentAppToolGrant.schemaVersion !== 1 ||
      agentAppToolGrant.runtimeStatus !== "prepared" ||
      !exactTools ||
      !exactCatalog ||
      !exactEnvAliases ||
      !exactConfig
    ) {
      // The MCP row/config may be removed or replaced after Site's JIT
      // preflight. Keep the Agent App itself available in stateless no-tool
      // mode and let finalDisclosure report the exact degraded capability.
      markAgentAppMcpRuntimeUnavailable();
    } else {
      agentAppToolGrant.runtimeStatus = "accepted";
      // Pass the compact canonical serialization derived from the exact bytes
      // just revalidated above so delayed firm/group execution never re-opens
      // a mutable preflight pathname. The Claude runner alone may snapshot
      // these exact bytes for a Windows `.cmd` invocation's argv ceiling.
      mcpConfigPath = acceptedAgentAppInlineMcpConfig;
      mcpAllowedTools = [...agentAppToolGrant.mcpAllowedTools];
      mcpRuntimeEnv = { ...agentAppToolGrant.mcpRuntimeEnv };
    }
  }
  // Workforce capability choice belongs to the same top host LLM that owns the
  // roster. The ordinary lexical auto-selector may search/install broad tools,
  // so it is never an authority source for an explicit Workforce execution.
  //
  // That rule is about *Workforce* rosters, but `oneTeamExecutionPolicy` is set
  // on every One turn — including an ordinary solo one. Excluding all of them
  // left One with no MCP config at all: no browser, no file access, nothing to
  // operate. One exists to run Agentlas for a non-expert, so a solo One turn
  // gets the same tools an ordinary chat turn would. Confirmed external
  // staffing keeps the exclusion, because there the roster's own host LLM owns
  // the capability decision.
  // An existing One Team roster is made from owner-installed teammates. It
  // still needs the normal local capability auto-selection so every selected
  // worker receives the same approved Filesystem/System Time/etc. MCP config
  // as the visible One turn. Only a server-prepared external Workforce owns
  // capability binding through its validated WorkOrder receipt.
  const workforceOwnsCapabilityChoice = oneTeamExecutionPolicy === "confirmed_external_workforce";
  /*
   * ★읽기 실행도 MCP 를 받는다 — 오너 결정 2026-08-18.
   *
   * 예전에는 `canWrite` 가 이 관문에 걸려 있어 읽기 권한 실행은 MCP 설정 자체를 받지
   * 못했다 — 브라우저 조회·시간 조회·온톨로지 읽기처럼 프로젝트 파일을 건드리지 않는
   * 도구까지 전부. "읽기"는 **내 파일을 바꾸지 마라**는 뜻이지 **조회 도구를 쓰지
   * 마라**가 아니다(2026-08-09 같은 병의 그래프 판이 이미 이 구분으로 수리됐다).
   * 파일·셸 경계는 각 러너의 권한 플래그(claude READ_ONLY_DENIED_TOOLS 등)가 계속
   * 지키고, 여기서는 승인된 MCP 서버만 전달한다.
   */
  // ★Site 도 같은 자동 선택을 지난다(오너 결정 2026-08-20). 예전에는 agentAppMode 가
  // 여기서 통째로 빠져 JIT 인라인 grant 밖의 도구를 하나도 못 받았다.
  // Science has one signed, turn-scoped tool catalog supplied by its execution
  // owner below. A second generic One/Work MCP config is both redundant and
  // can fail before the Science grant is even attempted in a headless daemon.
  if (runtimeCanUseMcp && executionContext?.source !== "science" && !isAliveControllerRun
    && !workforceOwnsCapabilityChoice && !explicitWorkforceGoal && !scienceReview) {
    // Which preparation step was running when a failure escaped. A thrown plain Error used to
    // log {stage:"unknown",code:"unknown"} (13x in production 2026-09-23) with no way to tell
    // tool selection from the browser grant from config materialization. Fixed vocabulary only.
    let mcpPrepStage = "prepare";
    try {
      if (req.forceBrowserCredentialRefresh) {
        mcpPrepStage = "browser-credential-refresh";
        // Due-gated, never forced: a forced import closes the dedicated browser
        // and re-feeds everyday-Chrome cookies on every automation occurrence.
        const report = await refreshBrowserCredentialsBeforeAutomatedRun();
        sink({
          kind: "notice",
          notice: browserCredentialSyncNotice(report, locale),
        });
      }
      let oneMemberToolPolicy: { autoSelectTools: boolean; fixedServerIds: string[] } | null = null;
      const oneRoomMemberRun = Boolean(req.oneMode && !req.agentAppMode && chat.id && roomMemberContext(chat.id));
      if (req.oneMode && !req.agentAppMode) {
        try {
          const row = getDb().prepare(
            "SELECT auto_select_tools, installed_agent_id FROM one_org_members WHERE installed_agent_id = ? AND archived_at IS NULL LIMIT 1",
          ).get(agent.id) as { auto_select_tools?: number; installed_agent_id?: string } | undefined;
          if (row) {
            oneMemberToolPolicy = {
              autoSelectTools: row.auto_select_tools !== 0,
              // A teammate working a hand-off from a group room also carries room_say (One Team, that one tool).
              fixedServerIds: [...agent.mcpServers.slice(0, 100), ...(oneRoomMemberRun ? ["one-team"] : [])],
            };
          }
        } catch {
          // Older stores without One Team tables retain the normal auto mode.
        }
      }
      const autoSelectInput = {
        userPrompt: [effectiveUserPrompt, req.attachmentCapabilitySummary].filter(Boolean).join("\n\n"),
        systemPrompt: buildEffectiveAgentSystemPrompt(agent.id, agent.systemPrompt),
        // A CLI's name or inherited MCP configuration does not prove a native
        // browser is available to this invocation or visible in Desktop.
        runtimeCapabilities: {
          nativeBrowser: "unknown" as const,
          nativeWebSearch: RUNTIME_NATIVE_CAPABILITIES[active.kind]?.includes("web.search")
            ? "available" as const
            : "unknown" as const,
        },
        // Codex loads the owner's ~/.codex MCP servers; a Playwright-style one there would
        // be the run's only browser unless the Agentlas browser is attached (codex-desktop-surface).
        ...(active.kind === "codex" && codexUserConfigOutsideBrowser({ env: process.env, cwd: agentRunCwd() })
          ? { runtimeOutsideBrowser: true as const }
          : {}),
        agentName: agent.nameEn || agent.name,
        workingFolder,
        toolMode: req.toolMode,
        hubMode: req.hubMode,
        signal,
        ...(req.requiredToolCatalogIds?.length
          ? { requiredToolCatalogIds: req.requiredToolCatalogIds }
          : {}),
        // 같은 채팅의 후속 턴이면 지난 선택과 접속 확인을 재사용한다(auto-select 메모).
        conversationId: chat.id,
        resolveActiveGoalScope: () => {
          if (req.agentAppMode || signal?.aborted) return null;
          const goalId = getChatGoalId(chat.id);
          if (!goalId) return null;
          const contract = getChatGoalContract(goalId);
          const revision = getChatGoalRevision(goalId);
          const run = getLongRunByGoalId(goalId);
          if (contract?.status !== "active" || revision?.chatId !== chat.id
            || !run || !["queued", "running", "waiting_worker", "waiting_tool", "verifying"].includes(run.status)) return null;
          // Permission is this invocation's host-normalized grant. A later
          // invocation with a narrower grant receives a different scope hash.
          return {
            goalId, revision: revision.revision, permission: normalizedPermission,
            objective: contract.objective,
            acceptanceCriteria: contract.acceptanceCriteria,
          };
        },
        readGoalSelection: (scope: Omit<GoalToolSelectionReceipt, "selectedIds">): string[] => {
          // Only the latest Main receipt in this chat can supply a hint. Searching
          // older matching scopes would resurrect a revoked permission/configuration.
          const row = getDb().prepare(
            "SELECT payload_json FROM run_events WHERE chat_id = ? AND kind = 'mcp_goal_tool_selection' ORDER BY rowid DESC LIMIT 1",
          ).get(chat.id) as { payload_json: string } | undefined;
          if (!row) return [];
          const receipt = JSON.parse(row.payload_json) as Partial<GoalToolSelectionReceipt>;
          return receipt.goalId === scope.goalId && receipt.revision === scope.revision && receipt.scopeHash === scope.scopeHash
            && Array.isArray(receipt.selectedIds) && receipt.selectedIds.length <= 100
            && receipt.selectedIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)
            ? receipt.selectedIds : [];
        },
        writeGoalSelection: (receipt: GoalToolSelectionReceipt): void => {
          recordRunEvent({ runId: req.runId!, chatId: chat.id, kind: "mcp_goal_tool_selection", payload: { ...receipt } });
        },
        ...(oneMemberToolPolicy ? oneMemberToolPolicy : {}),
        ...(oneRoomMemberRun ? { roomMember: true as const } : {}),
        // A One group room is a team by definition: One Team rides every turn (goal passes too).
        ...(chat.originSurface === "one" && chat.seatKind === "group" && !oneMemberToolPolicy ? { groupRoom: true as const } : {}),
        // An installed plugin the agent looked up or opened mid-turn in this
        // conversation's previous run is attached now (never a Hub install).
        requestedPluginSlugs: readMidTurnPluginRequests(chat.id, req.runId),
      };
      mcpPrepStage = "tool-selection";
      captureOnePersonalNativeOriginal();
      const scopedMcpPreflight = createOneScopedMcpPreflight({
        resolveSelection: resolveOnePersonalNativeMcpSelection, isCurrent: isMcpConfigCurrent, runId: req.runId,
        gate: {
          beforeMcpToolResult, runtime: active.kind,
          sessionKey: `${active.kind}:${req.chatId ?? workingFolder ?? "default"}`,
          permission: normalizedPermission,
          ...(planReadOnly ? { planMode: true as const } : {}),
          ...(req.simulation === true ? { simulation: true as const } : {}),
          ...(workingFolder ? { cwd: workingFolder } : {}),
          ...(req.chatId ? { chatId: req.chatId } : {}),
          ...(executionContext ? { unattended: true } : {}),
        },
      });
      const scopedSelectionDeps = { probeScopedServer: scopedMcpPreflight.probe };
      // The Goal can end or be revised while tool needs are judged (the previous turn's background verifier settling it);
      // the selection is made again under the Goal's present state rather than failing this turn.
      const selectUnderCurrentGoal = (stage: "tool-selection" | "key-gate") => selectUntilGoalScopeSettled(
        () => autoSelectMcpTools(autoSelectInput, scopedSelectionDeps),
        { onReselect: (attempt) => tryRecordRunEvent({ runId: req.runId!, chatId: chat.id, kind: "mcp_goal_scope_reselected",
          payload: { schemaVersion: 1, stage, attempt, reasonCode: "goal-scope-moved-during-selection" } }) },
      );
      let selectedContext = await selectUnderCurrentGoal("tool-selection");
      const keyConfigurationRevision = getEnvConfigurationRevision();
      const keyUserMessageId = persistedUserMessageId
        ?? [...priorHistory].reverse().find((message) => message.role === "user")?.id;
      // ── 실행 전 API 키 요청 게이트 (대화형 렌더러 런 전용) ──────────────
      // matched 도구가 missing-key면 렌더러 시트(mcp-key-request 이벤트)로 키를
      // 요청하고 제한 시간만큼만 기다린다. 값은 렌더러가 기존 env:set으로 vault에
      // 직접 저장하고, 여기로는 완료 신호만 돌아온다(mcp:supplyRunKeys).
      // 무인 실행(automation/site-studio/trex/telegram/agent-app)은 사람에게 절대
      // 블록되지 않는다 — interactive:false로 게이트 전체가 no-op.
      mcpPrepStage = "key-gate";
      const keyGate = await runMcpKeyElicitationGate({
        runId: req.runId,
        // 데스크탑 렌더러 대화형 런만. workspaceBinding(모바일)은 시트를 렌더링할
        // 화면이 없으므로 제외 — 모바일 런이 120초 헛대기하는 일이 없어야 한다.
        interactive: !executionContext && !req.agentAppMode && !workspaceBinding,
        context: selectedContext,
        ...(selectedContext.goalSelectionScope && keyUserMessageId ? { goalScope: {
          ...selectedContext.goalSelectionScope,
          userMessageId: keyUserMessageId,
          configurationRevision: keyConfigurationRevision,
          automaticContinuation: promptIsSystemAuthored,
          isCurrent: () => getEnvConfigurationRevision() === keyConfigurationRevision
            && selectedContext.goalSelectionIsCurrent?.() === true,
        } } : {}),
        sink: event => { if (event.kind === "mcp-key-request") captureOnePersonalNativePending(); sink(event); },
        signal,
        // 키가 저장된 뒤의 재선택은 세상이 바뀐 시점이다 — 메모를 버리고 처음부터 다시 고른다.
        reselect: () => autoSelectMcpTools({
          ...autoSelectInput,
          bypassSelectionMemo: true,
          ...(selectedContext.goalSelectionScope ? { credentialRetry: {
            ...selectedContext.goalSelectionScope,
            // This callback runs only after the current gate's typed provided
            // outcome. Recheck these exact requested IDs, never a stale ready row.
            selectedIds: selectedContext.tools.filter((tool) => tool.state === "missing-key" && tool.missingEnv.length > 0)
              .map((tool) => tool.id),
          } } : {}),
        }, scopedSelectionDeps),
      });
      selectedContext = keyGate.context;
      // The key sheet can wait for the owner far longer than a selection: the Goal may have ended meanwhile.
      if (selectedContext.goalSelectionIsCurrent?.() === false) selectedContext = await selectUnderCurrentGoal("key-gate");
      mcpGoalSelectionIsCurrent = selectedContext.goalSelectionIsCurrent;
      assertMcpGoalSelectionCurrent();
      // A selection failure does not establish that a provider is disconnected
      // or authorize suggesting a runtime outside the user's configured pool.
      const needsOutcome = selectedContext.needsOutcome;
      const undecidedCostSomething = !selectedContext.needsDecided && (needsOutcome?.candidateCount ?? 0) > 0;
      if (undecidedCostSomething) {
        sink({
          kind: "notice",
          notice: {
            level: "info",
            code: "mcp-selection-undecided",
            message: locale === "ko"
              ? "연결된 도구로 작업을 계속합니다. 추가 도구 확인은 이번에 완료되지 않았습니다."
              : "Continuing with the configured tools. The check for additional tools did not finish this time.",
          },
        });
      }
      isolatedMcpConfig = selectedContext.effectiveToolMode === "browser";
      if (keyGate.outcome !== "skipped") {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · credential request",
            // Value-free receipt: tool ids + outcome only, never key values.
            result: `${keyGate.outcome}: ${selectedContext.tools
              .filter((tool) => tool.state === "missing-key")
              .map((tool) => tool.id)
              .join(", ") || "all requested tools unlocked"}`,
          },
        });
      }
      mcpAutoSelectionPrompt = buildMcpAutoSelectionPrompt(selectedContext, {
        toolMode: selectedContext.effectiveToolMode,
        hubMode: req.hubMode,
        userPrompt: effectiveUserPrompt,
      });
      if (selectedContext.routedPlugins?.length || selectedContext.selectionSource) {
        // The routing decision is a ledger fact for every turn, Work and One alike.
        tryRecordRunEvent({
          runId: req.runId ?? `chat:${chat.id}`,
          kind: "plugin_route_selection",
          chatId: chat.id,
          agentId: agent.id,
          payload: {
            source: selectedContext.selectionSource ?? "none",
            routed: (selectedContext.routedPlugins ?? []).map((plugin) => ({
              slug: plugin.slug, source: plugin.source, hasSkills: plugin.hasSkills, toolIds: plugin.toolIds,
            })),
          },
        });
      }
      if (selectedContext.routedPlugins?.length) {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · routed",
            result: selectedContext.routedPlugins
              .map((plugin) => `${plugin.slug} (${plugin.source}${plugin.toolIds.length ? `; tools: ${plugin.toolIds.join(", ")}` : ""})`)
              .join("\n"),
          },
        });
      }
      if (keyGate.fallbackPrompt) {
        // 거절/시간초과 폴백 — 남은 도구들로 대안을 찾으라는 정직한 지시 블록.
        mcpAutoSelectionPrompt = `${mcpAutoSelectionPrompt}\n${keyGate.fallbackPrompt}`.trim();
      }
      if (selectedContext.hubPluginCount > 0 || selectedContext.localPluginCount > 0) {
        const hubCandidates =
          selectedContext.hubPlugins.length > 0
            ? `\nHub candidates: ${selectedContext.hubPlugins
                .map((plugin) => `${plugin.slug}: ${plugin.reason}`)
                .join("\n")}`
            : "";
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · universe",
            result: `${selectedContext.localPluginCount} local plugin/tool entries + ${selectedContext.hubPluginCount} Hub plugins${hubCandidates}`,
          },
        });
      }
      if (selectedContext.hubPluginError) {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · Hub lookup",
            result: selectedContext.hubPluginError,
          },
        });
      }
      const selectedTools = selectedContext.tools;
      const installedTools = selectedTools.filter((tool) => tool.installed);
      const degradedTools = selectedTools.filter((tool) => tool.state !== "ready");
      // AGY browser turns may share one CLI only when the config is exactly the
      // canonical Agentlas Browser. The opaque hash is a Main-owned identity;
      // it is never a caller-authored handle or a browser credential.
      const antigravityBrowserResidentKey = browserOnly
        && active.kind === "antigravity"
        && Boolean(req.chatId)
        && installedTools.length > 0
        && installedTools.every((tool) => tool.id === "agentlas-browser")
        ? createHash("sha256")
          .update("antigravity-browser-resident-v1\0")
          .update(req.chatId ?? "")
          .update("\0")
          .update(browserApprovalScope?.surface ?? "")
          .update("\0")
          .update(req.mcpBrowserProfileKey ?? "")
          .update("\0")
          .update(workingFolder ?? "")
          .update("\0")
          .update(active.model ?? "")
          .update("\0")
          .update(agent.id)
          .update("\0")
          .update(agent.systemPrompt)
          .update("\0")
          .update(normalizedPermission)
          .update("\0")
          .update(locale)
          .digest("hex")
        : undefined;
      if (
        selectedContext.effectiveToolMode === "browser" &&
        !selectedTools.some((tool) => tool.id === "agentlas-browser" && tool.state === "ready")
      ) {
        throw new Error(
          locale === "ko"
            ? "로그인된 Agentlas Browser 호스트를 확인할 수 없어 자동화를 실행하지 않았습니다. Agentlas Browser를 다시 연결한 뒤 재시도하세요."
            : "The authenticated Agentlas Browser host is unavailable. The automation was blocked before model execution; reconnect Agentlas Browser and retry.",
        );
      }
      if (installedTools.length > 0) {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · auto-select",
            result: installedTools.map((tool) => `${tool.id}: ${tool.reason}`).join("\n"),
          },
        });
      }
      if (degradedTools.length > 0) {
        sink({
          kind: "tool-use",
          tool: {
            name: "Agentlas Plugins · degraded capabilities",
            // Value-free state receipt: never include an MCP error body because
            // remote servers may reflect a credential or private URL in it.
            result: degradedTools
              .map((tool) => `${tool.id}: ${tool.connectionOutcome ? describeScopedMcpOutcome(tool.connectionOutcome, locale) : tool.state}${tool.required ? " (required function only)" : ""}`)
              .join("\n"),
          },
        });
      }
      // Hub 후보 브리지 — resolve된 후보를 프롬프트 텍스트로 끝내지 않고 실제 서버로
      // 연결한다(원격 http/sse는 자동, stdio는 승인 대기로 등록). 실패는 런에 영향 없음.
      let hubBridgedServerIds: string[] = [];
      if (selectedContext.hubPlugins.length > 0) {
        try {
          mcpPrepStage = "hub-bridge";
          const bridged = await bridgeHubPluginCandidates(selectedContext.hubPlugins);
          hubBridgedServerIds = bridged.liveServerIds;
          if (bridged.receipts.length > 0) {
            sink({
              kind: "tool-use",
              tool: {
                name: "Agentlas Plugins · Hub bridge",
                result: bridged.receipts
                  .map((receipt) =>
                    `${receipt.slug} → ${receipt.serverName} [${receipt.transport}] ${receipt.action}` +
                    (receipt.reason ? ` (${receipt.reason})` : ""))
                  .join("\n"),
              },
            });
          }
        } catch (bridgeError) {
          console.warn("[mcp] hub plugin bridge failed:", bridgeError);
        }
      }
      // Hub/credential setup may await user or network work. Re-check the
      // selected server bindings before materializing their runtime config.
      assertMcpGoalSelectionCurrent();
      // Every owner task uses the same native login session. Visibility and
      // executionContext choose presentation/authority, never another cookie store.
      // AgentApp sessions retain their explicitly separate runtime boundary.
      if (!req.agentAppMode &&
        (installedTools.some((tool) => tool.id === "agentlas-browser") || req.requiredToolCatalogIds?.includes("agentlas-browser"))) {
        mcpPrepStage = "native-browser-grant";
        const { createCanonicalNativeBrowserGrant } = await import("../browser/main-browser-channel");
        nativeBrowserGrant = await createCanonicalNativeBrowserGrant({ chatId: chat.id, runId: req.runId!,
          presentation: executionContext ? "background" : browserPresentation,
          onScreenshot: (capture) => publishNativeCapture(capture),
          permission: normalizedPermission, signal: login?.ownerSignal ?? signal ?? new AbortController().signal });
      }
      mcpPrepStage = "config-build";
      // Owner decision 2026-10-16: this exact graph step (run, chat, node) of a room-saved graph carries the room's
      // One Team. The runner minted the grant at step start; it is re-checked here and again in mcp-config.ts.
      const graphTeamGrant = executionContext?.source === "automation" && req.simulation !== true && !planReadOnly
        && graphTeamGrantCurrent(executionContext.graphTeamGrant) && executionContext.graphTeamGrant.runId === req.runId
        && executionContext.graphTeamGrant.chatId === req.chatId && executionContext.graphTeamGrant.automationId === req.automationId
        && executionContext.graphTeamGrant.nodeId === executionContext.nodeId ? executionContext.graphTeamGrant : null;
      const cfg = await buildMcpConfigFile({
        ...(graphTeamGrant ? { graphTeamGrant } : {}),
        osMemoryCuratorRun: captureNativeOsCuratorRun({ runId: req.runId!, model: confirmedRuntime.model ?? "",
          current: isMcpConfigCurrent, signal }),
        supervisorReplyRunId: req.runId,
        nativeScopedSelectionForServer: scopedMcpPreflight.selectionForServer,
        // Graph nodes can share a runId. Every preparation, including doctor
        // and unattended runs, needs its own sealed file and launch lifetime.
        configKey: `invocation-${randomUUID()}`,
        ...(req.runId ? { turnRunId: req.runId } : {}),
        ...(turnGoalToolsOffered ? { turnGoalTools: true as const } : {}),
        ...(turnAskToolOffered ? { turnAskTool: true as const } : {}),
        admissionCurrent: isMcpConfigCurrent,
        ...(nativeBrowserGrant ? { nativeBrowser: nativeBrowserGrant } : {}),
        ...(workspacePreviewOwnerGrant ? { workspacePreviewOwnerGrant } : {}),
        ...(req.mcpBrowserProfileKey ? { browserProfileKey: req.mcpBrowserProfileKey } : {}),
        // 그래프가 선으로 이어 선언한 도구는 자동 선택 결과와 **함께** 켠다.
        // 선언은 사용자가 화면에 그려 넣은 것이라, 선택기가 안 골랐다고 빠지면
        // "붙였는데 안 쓰인다"가 된다(커넥터 C06).
        catalogIds: [...new Set([
          ...installedTools.map((tool) => tool.id),
          ...hubBridgedServerIds,
          ...(req.requiredToolCatalogIds ?? []),
          // The room's One Team for a room-saved graph step (graphTeamGrant above); no grant, no row.
          ...(graphTeamGrant ? ["one-team"] : []),
          ...(workspacePreviewOwnerGrant
            ? [AGENTLAS_WORKSPACE_PREVIEW_CATALOG_ID]
            : []),
          // The model reads the UI schema through this read-only tool instead of a keyword-gated
          // prompt section. Every ordinary turn gets it; Site/Agent App runs keep their own closed set.
          ...(!req.agentAppMode ? [AGENTLAS_UI_CATALOG_ID] : []),
          // Typed replacement of the Memory Events text block (memory_note); same turns that used to get the block.
          ...(!req.agentAppMode && !isAliveControllerRun ? [AGENTLAS_TURN_CATALOG_ID] : []),
        ])],
        ...(req.requiredToolCatalogIds?.length
          ? { requiredToolCatalogIds: req.requiredToolCatalogIds }
          : {}),
        // Owner 2026-10-17: an ordinary turn carries the work-core Hub tools (hephaestus-tool-surface.ts). A graph or
        // owner that requires the network server by name gets every tool the engine lists.
        ...(req.requiredToolCatalogIds?.includes("hephaestus-network") ? {} : { hephaestusToolSurface: "work-core" as const }),
        /*
         * ★도구 관문을 이 실행에 붙인다 — 어느 런타임이든.
         *
         * 실행 전 거절이 실제로 먹히던 곳은 claude 의 PreToolUse 훅 하나뿐이었다.
         * 나머지 런타임에서는 사용자가 "거절"을 눌러도 다음 호출을 막지 못했고,
         * cursor CLI 는 MCP 훅을 아예 쏘지 않으며 copilot 은 서브에이전트 내부 호출에
         * 훅이 안 걸린다. 관문을 벤더 훅이 아니라 **도구가 지나는 길**에 두면
         * 그 차이가 사라진다(mcp-config.ts mcpProxySpec → proxy-child.cjs).
         */
        toolGate: {
          beforeMcpToolResult,
          ...(planReadOnly ? { planMode: true as const } : {}),
          runtime: active.kind,
          // 승인 세션 키는 러너들과 같은 규칙이라야 "이번 세션 동안 허용"이 이어진다.
          sessionKey: `${active.kind}:${req.chatId ?? workingFolder ?? "default"}`,
          permission: normalizedPermission,
          ...(req.simulation === true ? { simulation: true as const } : {}),
          ...(workingFolder ? { cwd: workingFolder } : {}),
          ...(req.chatId ? { chatId: req.chatId } : {}),
          ...(workspacePreviewOwnerGrant ? { chatId: workspacePreviewOwnerGrant.chatId } : {}),
          ...(browserApprovalScope ? { approvalScope: browserApprovalScope } : {}),
          ...(executionContext ? { unattended: true } : {}),
          ...(antigravityBrowserResidentKey ? { residentKey: antigravityBrowserResidentKey } : {}),
          ...(readOnlyObservationRun ? { readOnlyObservation: true as const } : {}),
          ...(req.oneTeamReportTurn === true ? { oneTeamReport: true as const } : {}),
        },
      });
      mcpConfigCleanup = cfg?.cleanup;
      if (!isMcpConfigCurrent()) {
        mcpConfigCleanup?.();
        throw new Error("mcp_invocation_scope_ended");
      }
      assertMcpGoalSelectionCurrent();
      if (nativeBrowserGrant && !cfg?.nativeBrowserBound) {
        throw new Error("native-browser-config-unbound");
      }
      if (cfg) {
        mcpConfigPath = cfg.configPath;
        mcpAllowedTools = cfg.allowedTools;
        mcpCodexConfigArgs = cfg.codexConfigArgs;
        mcpRuntimeEnv = cfg.runtimeEnv;
        if (nativeBrowserGrant && !cfg.nativeBrowserBound) { nativeBrowserGrant.release(); nativeBrowserGrant = undefined; }
        // 관문이 좁힐 이름은 config key에서 나온다(`mcp__<key>__*`). 커널은 catalog id로
        // 선언하므로, 두 이름을 다 아는 유일한 지점이 여기다 — 아래 관문 생성이 이걸 쓴다.
        mcpIncludedServers = cfg.includedServers ?? [];
        mcpToolchainConsumer = cfg.toolchainConsumer === true;
      }
      // Browser fallback ladder: lend this run's ids and notice sink; a browser run without the browser MCP
      // attached is recorded as a typed ladder stop (one card) instead of silently using another browser.
      if (chat.id && req.runId) {
        const browserAttached = mcpIncludedServers.some((row) => row.catalogId === "agentlas-browser" || row.serverId === "agentlas-browser");
        const browserNeeded = req.toolMode === "browser" || Boolean(req.requiredToolCatalogIds?.includes("agentlas-browser"));
        const ladderChatId = chat.id, ladderRunId = req.runId;
        const ladderNotify = (notice: NonNullable<McpInvocationEvent["notice"]>) => { try { sink({ kind: "notice", notice }); } catch { /* run ended */ } };
        void import("../browser/fallback-ladder-runtime").then((ladder) => {
          if (browserAttached) {
            const unbind = ladder.bindBrowserLadderRun({ chatId: ladderChatId, runId: ladderRunId, locale: pickLocale(req), notify: ladderNotify,
              nativeGrant: nativeBrowserGrant ?? null, nativeRequired: !req.agentAppMode,
              nativeComputerUseAvailable: cfg?.nativeComputerUseBound === true });
            if (browserLadderSettled) unbind(); else unbindBrowserLadder = unbind;
          } else if (browserNeeded) {
            ladder.recordBrowserMcpNotAttached({ chatId: ladderChatId, runId: ladderRunId, locale: pickLocale(req), notify: ladderNotify,
              nativeRequired: !req.agentAppMode });
          }
        }).catch(() => undefined);
      }
      mcpPrepStage = "worker-preparer";
      const workerGoalScope = autoSelectInput.resolveActiveGoalScope();
      if (workerGoalScope && !executionContext && !req.agentAppMode) {
        const baselineIds = [...new Set(mcpIncludedServers.map((row) => row.catalogId ?? row.serverId))];
        prepareWorkerCapabilities = createWorkerCapabilityPreparer({
          scope: workerGoalScope, cwd: workingFolder ?? undefined, baselineIds,
          readScope: autoSelectInput.resolveActiveGoalScope,
          assertParentCurrent: () => {
            assertMcpGoalSelectionCurrent();
            if (workspaceBinding) revalidateInvocationWorkspaceBinding(workspaceBinding);
          },
          inventory: () => {
            const servers = listInstalledMcpServers().filter((server) => server.enabled && server.configurationValid !== false);
            const canonicalBrowser = servers.some((server) => server.catalogId === "agentlas-browser");
            const eligible = servers.filter((server) => (server.catalogId !== AGENTLAS_WORKSPACE_PREVIEW_CATALOG_ID || Boolean(workspacePreviewOwnerGrant))
              && (!browserOnly || baselineIds.includes(server.catalogId ?? server.id))
              && (!canonicalBrowser || server.catalogId || baselineIds.includes(server.id) || !isKeylessPlaywrightMcpDuplicate(server)));
            return {
              fingerprint: createHash("sha256").update(JSON.stringify(eligible.map((server) =>
                [server.id, mcpServerConfigurationDigest(server)]).sort())).digest("hex"),
              candidates: [...new Map(eligible.map((server) => {
                const entry = MCP_TOOL_CATALOG.find((candidate) => candidate.id === server.catalogId);
                const id = server.catalogId ?? server.id;
                return [id, { id, name: server.nameEn || server.name,
                  description: entry?.descriptionEn || entry?.description || "Owner-installed custom MCP server",
                  origin: "local" as const, needsCredential: server.envKeys.length > 0 }] as const;
              })).values()],
            };
          },
          select: (input) => resolveMcpNeeds({ ...input, runtimeCapabilities: {
            nativeBrowser: nativeBrowserGrant && mcpConfigPath ? "available" : "unknown",
            nativeWebSearch: RUNTIME_NATIVE_CAPABILITIES[active.kind]?.includes("web.search")
              ? "available" : "unknown",
          } }),
          receipt: (payload) => recordRunEvent({ runId: req.runId!, chatId: chat.id,
            kind: "mcp_worker_capability_selection", payload }),
          materialize: async (input, ids, generation) => {
            let grant: NativeBrowserRelayGrant | undefined;
            let childConfig: Awaited<ReturnType<typeof buildMcpConfigFile>>;
            let released = false;
            const release = () => {
              if (released) return;
              released = true;
              try { grant?.release(); } finally { childConfig?.cleanup?.(); }
            };
            try {
              if (ids.includes("agentlas-browser") && !req.agentAppMode) {
                const { createCanonicalNativeBrowserGrant } = await import("../browser/main-browser-channel");
                const grantSignal = input.signal ?? signal ?? new AbortController().signal;
                grant = await createCanonicalNativeBrowserGrant({ chatId: chat.id, runId: req.runId!,
                  permission: input.permission!, signal: grantSignal,
                  presentation: executionContext ? "background" : browserPresentation,
                  onScreenshot: (capture) => publishNativeCapture(capture) });
              }
              // agentlas-turn (harness_search/describe/call) binds to a chat and a run: without the run it is never written
              // into the worker's config, and a worker whose selection includes it fails before it starts. Production
              // 2026-10-18 05:48-05:57Z, Yotube room run ea52dcd9: 14 of 14 task-force and firm workers refused
              // materialization-unavailable ["agentlas-turn"] on the first production run of this path. The worker's turn
              // tools belong to the run that started it.
              childConfig = await buildMcpConfigFile({ configKey: `worker-${generation}-${randomUUID()}`,
                ...(req.runId ? { turnRunId: req.runId } : {}),
                skipDefaultSeed: true, catalogIds: ids, ...(grant ? { nativeBrowser: grant } : {}),
                ...(workspacePreviewOwnerGrant ? { workspacePreviewOwnerGrant } : {}),
                toolGate: { ...(planReadOnly ? { planMode: true as const } : {}), runtime: input.runtime.kind, sessionKey: `${input.runtime.kind}:${chat.id}`,
                  permission: input.permission!, ...(input.cwd ? { cwd: input.cwd } : {}), chatId: chat.id,
                  ...(browserApprovalScope ? { approvalScope: browserApprovalScope } : {}),
                  ...(readOnlyObservationRun ? { readOnlyObservation: true as const } : {}),
                  ...(req.simulation === true ? { simulation: true as const } : {}) } });
              const boundIds = new Set(childConfig?.includedServers?.flatMap((row) => [row.serverId, row.catalogId].filter(Boolean)));
              if (!childConfig || ids.some((id) => !boundIds.has(id)) || (grant && !childConfig.nativeBrowserBound)) {
                const unavailableIds = ids.filter((id) => !boundIds.has(id)
                  || (id === "agentlas-browser" && grant && !childConfig?.nativeBrowserBound));
                recordRunEvent({ runId: req.runId!, chatId: chat.id, kind: "mcp_worker_capability_selection",
                  payload: { schemaVersion: 1, workerId: input.workerId, attemptId: input.attemptId,
                    status: "materialization-unavailable", reasonCode: "worker-capability-credential-or-server-unavailable",
                    unavailableCatalogIds: unavailableIds.filter((id) => MCP_TOOL_CATALOG.some((entry) => entry.id === id)),
                    unavailableCount: unavailableIds.length, evidenceType: "capability-binding-only" } });
                throw new WorkerCapabilityMaterializationError(unavailableIds);
              }
              const preparedConfig = childConfig;
              return { runner: { mcpConfigPath: preparedConfig.configPath, mcpAllowedTools: preparedConfig.allowedTools,
                mcpCodexConfigArgs: preparedConfig.codexConfigArgs, isolatedMcpConfig: true as const,
                ...(browserOnly ? { browserOnly: true as const } : {}),
                env: { ...orchestrationRunnerEnv, ...preparedConfig.runtimeEnv,
                  ...(grant ? { AGENTLAS_NATIVE_BROWSER_SCOPE: "task" } : {}) } },
                assertCurrent: () => {
                  if (released) throw new WorkerCapabilityError("worker-capability-lease-released");
                  preparedMcpBindings(preparedConfig.configPath);
                }, release };
            } catch (error) { release(); throw error; }
          },
        });
      }
    } catch (err) {
      // Every runtime must receive this invocation's approved transport. In
      // particular AGY otherwise falls through to a prior chat's global proxy
      // when config creation fails. A Full Access grant is not transferable to
      // that old proxy. Preserve the failure before any runner dispatch.
      if (signal?.aborted) return earlyResult();
      const hostDiagnostic = browserCdpHostFailureDiagnostic(err);
      // A non-launcher failure used to collapse to {unknown, unknown} and "(unknown)" in the
      // message, hiding e.g. native-browser-task-unbound. Carry a bounded machine code only.
      const thrownCode = mcpConfigFailureCode(err);
      const diagnostic = {
        ...hostDiagnostic,
        ...(hostDiagnostic.stage === "unknown" ? { stage: mcpPrepStage } : {}),
        ...(hostDiagnostic.code === "unknown" && thrownCode ? { code: thrownCode } : {}),
      };
      const scopeChanged = err && typeof err === "object" && "code" in err
        && err.code === "mcp-goal-tool-scope-changed";
      const code = scopeChanged ? "mcp-goal-tool-scope-changed" : "mcp-runtime-config-unavailable";
      console.error("[mcp]", { code, diagnostic });
      tryRecordRunEvent({ runId: req.runId!, chatId: chat.id, kind: "mcp_config_failure",
        payload: { schemaVersion: 1, code, stage: diagnostic.stage, reasonCode: diagnostic.code } });

      if (process.env.AGENTLAS_MCP_CONFIG_DEBUG === "1") console.error("[mcp] config failure detail:", err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err));
      sink({ kind: "error", error: {
        code,
        message: locale === "ko"
          ? `이번 실행의 도구 연결을 준비하지 못했습니다. 도구 연결을 확인한 뒤 다시 시도해 주세요. (${diagnostic.code})`
          : `Could not prepare this run's tool connections. Check the tool connection and retry. (${diagnostic.code})`,
      } });
      return earlyResult();
    }
  }

  // Science computation is a daemon-owned, turn-scoped capability. It is not a
  // globally installed MCP row and is never selected from prompt text. The
  // short-lived bridge carries only a loopback endpoint and an opaque grant;
  // project/turn authority remains in the Science owner and is revalidated by ScienceStore.
  if (executionContext?.source === "science") {
    if (!executionContext.science && !scienceReview) throw new Error("science-execution-context-missing");
    const { materializeScienceMcpGrant, materializeScienceReviewMcpGrant } = await import("agentlas-science");
    // Science turns use the daemon-owned catalog as their single tool boundary.
    // Keeping the auto-selected standalone domain servers in the same config
    // creates duplicate tools (for example PBDB's low-level occurrence call
    // beside the host's receipt-producing search_paleontology_occurrences),
    // so a Research Director can loop on the wrong surface and bypass the
    // downstream Science receipts. The built-in catalog already contains the
    // trusted adapters for every installed Science Lab. Other installed
    // servers are discoverable through the turn-bound lazy Desktop bridge,
    // never inserted wholesale into the Science session config.
    // Codex launches with this exact cwd (see the root RunnerRequest below and
    // codex.ts's agentRunCwd fallback). Science must bind its isolated CODEX_HOME
    // project-trust entry to that directory, not infer a workspace from the
    // research project or the model's prompt. Keep the extra argument optional
    // at the TypeScript boundary while the published Science pin is older.
    const codexLaunch = { cwd: workingFolder ?? agentRunCwd() };
    const reviewGrantWithCwd = materializeScienceReviewMcpGrant as unknown as (
      authority: object, invocationRunId: string, runtimeChatId: string, launch: { cwd: string },
    ) => ReturnType<typeof materializeScienceReviewMcpGrant>;
    const turnGrantWithCwd = materializeScienceMcpGrant as unknown as (
      context: NonNullable<NonNullable<typeof executionContext>["science"]>, baseConfigPath: undefined,
      testDescriptor: undefined, executionPolicy: { planMode: boolean }, launch: { cwd: string },
    ) => ReturnType<typeof materializeScienceMcpGrant>;
    const scienceGrant = scienceReview
      ? await reviewGrantWithCwd(executionContext.scienceReview!, req.runId!, req.chatId, codexLaunch)
      : await turnGrantWithCwd(executionContext.science!, undefined, undefined, { planMode: planReadOnly }, codexLaunch);
    if (!scienceReview && !planReadOnly && !scienceCollectionCurrent && executionContext.science) {
      if (executionContext.science.invocationRunId !== req.runId || req.chatId !== chat.id)
        throw new Error("science_desktop_tool_run_binding_mismatch");
      const releaseDesktopTools = bindScienceDesktopToolTurn(executionContext.science, {
        chatId: req.chatId, agentId: agent.id, runtimeKind: active.kind,
        permission: normalizedPermission, cwd: workingFolder ?? codexLaunch.cwd,
        signal, approvalScope: browserApprovalScope,
      });
      const previousCleanup = mcpConfigCleanup;
      mcpConfigCleanup = () => { try { releaseDesktopTools(); } finally { previousCleanup?.(); } };
    }
    mcpConfigPath = scienceGrant.configPath;
    if (scienceCollectionCurrent) scienceCollectionCapability = issueScienceCollectionCapability(mcpConfigPath, scienceCollectionCurrent);
    mcpAllowedTools = scienceGrant.allowedTools;
    mcpCodexConfigArgs = scienceGrant.codexConfigArgs;
    mcpRuntimeEnv = scienceGrant.runtimeEnv;
    /*
     * The daemon stays with the project (owner, 2026-09-21: "매번 턴마다 cli 리셋으로 초기화 띄우면 안 됨 … 런타임 변경 때만
     * 데몬 죽이고, 앱 끄면 죽여야지"). A Science build that returns a SESSION grant keeps one token, config file and
     * catalogue for the conversation on this runtime kind, so the CLI that carries it serves the next turn too and may
     * stay resident like any other chat. Authority still ends with the turn: Science refuses calls made between turns.
     * Plan mode, criterion review and older Science builds keep a per-run grant, and those processes still die with the turn.
     */
    ephemeralToolGrant = (scienceGrant as { sessionScoped?: true }).sessionScoped !== true;
    mcpIncludedServers = [scienceGrant.includedServer];
    mcpAutoSelectionPrompt = purposePrompt([{
      id: "purpose.science.session.scope", revision: 2, stability: "configuration", changeTriggers: ["release", "profile", "permission", "tool-grant"],
      text: scienceReview
      ? "science review: independent, read-only; only read_criterion_review_input; no research state, no borrowed agents; return the exact requested findings JSON"
      : planReadOnly
        ? "science plan: read-only (files, shell, research state); only the granted discovery tools; describe the plan, create no state"
        : "science: Agentlas Science owns this session; pick tools from the live catalog; claims cite returned source ids or receipts; metadata ≠ full text; disclose partial failure; typed receipt before state claims; respect stale grants/Stop; reply as Agentlas Science (no Hope prefix)",
    }]);
  }

  // Alive is a separate actor: its attachment, not its hidden Work chat or
  // prompt text, authorizes Science. A reserved wake may prepare this bridge;
  // the Science endpoint admits calls only after that same wake is running.
  if (isAliveControllerRun && executionContext?.aliveScience) {
    const authority = executionContext.aliveScience;
    if (authority.wakeId !== req.runId) throw new Error("alive-science-wake-run-mismatch");
    const science = await import("agentlas-science") as unknown as {
      materializeAliveScienceMcpGrant?: (authority: NonNullable<InvocationExecutionContext["aliveScience"]>,
        launch: { cwd: string }) => Promise<{ configPath: string; allowedTools: string[];
          codexConfigArgs: string[]; runtimeEnv: Record<string, string>;
          includedServer: { serverId: string; catalogId: string; configKey: string }; sessionScoped?: true }>;
      revokeAliveScienceMcpGrant?: (wakeId: string) => boolean;
    };
    if (typeof science.materializeAliveScienceMcpGrant !== "function"
      || typeof science.revokeAliveScienceMcpGrant !== "function") {
      // An older installed Science pin must not stop the Alive actor's other
      // branches. It receives no Science tools and is told so explicitly.
      mcpAutoSelectionPrompt = "science bridge: unavailable in this build; no Science tools, claim no Science call or receipt; reason about observed state and propose only host-validated actions";
    } else {
      const aliveGrant = await science.materializeAliveScienceMcpGrant(authority, { cwd: workingFolder ?? agentRunCwd() });
      let releaseAliveDesktopTools: (() => void) | undefined;
      try {
      const store = (await import("agentlas-science")).scienceStore();
      const principal = store.aliveLifetime().preparedToolPrincipal({ ...authority, domain: "science" }, Date.now());
      const projectId = principal.scope.projectId;
      const conversationId = principal.scope.conversationId;
      if (typeof projectId !== "string" || typeof conversationId !== "string"
        || principal.agentId !== store.scienceAliveAgentId(projectId))
        throw new Error("alive_desktop_tool_wake_binding_invalid");
      const policy = store.aliveResearchContinuationAuthority(projectId, conversationId);
      if (policy.stopped || !policy.fullAutonomyStanding) throw new Error("alive_desktop_tool_policy_stale");
      const desktopScope: ScienceAliveDesktopToolScope = { projectId, conversationId,
        agentId: authority.agentId, wakeId: authority.wakeId, controlEpoch: authority.controlEpoch,
        attachmentId: authority.attachmentId, attachmentGeneration: principal.attachmentGeneration,
        scopeSha256: createHash("sha256").update(JSON.stringify(principal.scope)).digest("hex"),
        conversationStopEpoch: policy.conversationStopEpoch,
        approvalPolicySha256: policy.approvalPolicySha256 };
      releaseAliveDesktopTools = bindScienceAliveDesktopToolWake(desktopScope, {
        chatId: req.chatId, agentId: authority.agentId, runtimeKind: active.kind,
        permission: normalizedPermission, cwd: workingFolder ?? agentRunCwd(),
        signal, approvalScope: browserApprovalScope,
      });
      mcpConfigPath = aliveGrant.configPath;
      mcpAllowedTools = aliveGrant.allowedTools;
      mcpCodexConfigArgs = aliveGrant.codexConfigArgs;
      mcpRuntimeEnv = aliveGrant.runtimeEnv;
      mcpIncludedServers = [aliveGrant.includedServer];
      const canProposeAliveHypothesis = aliveGrant.allowedTools.some((tool) => tool.endsWith("__alive_propose_research_hypothesis"));
      mcpAutoSelectionPrompt = "science bridge: current grant only, separate from Alive identity; read project state; honor expiry/Stop; exact receipt before action claims"
        + (canProposeAliveHypothesis
          ? "; alive_propose_research_hypothesis: evidence-bound proposal, copy wake_id exactly, Science may refuse, a proposal is not approval or a result"
          : "; no Alive Science write tool in this build");
      ephemeralToolGrant = aliveGrant.sessionScoped !== true;
      const previousCleanup = mcpConfigCleanup;
      mcpConfigCleanup = () => {
        try { releaseAliveDesktopTools?.(); }
        finally {
          try { science.revokeAliveScienceMcpGrant?.(authority.wakeId); }
          finally { previousCleanup?.(); }
        }
      };
      } catch (error) {
        releaseAliveDesktopTools?.();
        science.revokeAliveScienceMcpGrant?.(authority.wakeId);
        throw error;
      }
    }
  }

  /*
   * ★C38 — 관문 생성은 위 블록 **바깥**이다.
   *
   * 예전에는 이 조각이 `canWrite`가 걸린 블록 안에 있었다. 그런데 그래프 시뮬레이션은
   * 정확히 read 권한으로 돈다(shared/graph-node-protocol.ts automationRuntimePermission).
   * 즉 "바깥을 바꾸는 내장 도구를 실제로 거절한다"는 dry-run의 유일한 실물 보증이,
   * 그 보증이 필요한 유일한 실행에서만 한 번도 걸리지 않았다 — claude 를 포함해
   * 모든 런타임에서. 실행 기록은 정직하게 `observed`로 내려갔으니 거짓말은 아니었지만,
   * 그래프 프로토콜 주석이 약속한 "선언되지 않은 도구 호출을 실제로 거절하는 곳"은
   * 존재하지 않았다.
   *
   * 관문은 쓰기 권한을 필요로 하지 않는다: 계획·설정 파일은 userData 아래에 쓰고
   * (electron/workflow/tool-broker-runtime.ts brokerDir), 러너에는 `--settings` 한 줄로
   * 실린다. 그래서 read 실행에도 그대로 걸 수 있다.
   *
   * 남는 한계는 정직하게 적어 둔다: read 실행에서는 MCP config 자체를 만들지 않으므로
   * `declaredToolNames`가 비고, 그때 관문이 실제로 거는 것은 **dry-run의 변이 내장도구
   * 거절**뿐이다(선언되지 않은 MCP 도구를 좁히는 쪽은 좁힐 대상이 없다). 이건 관문의
   * 결함이 아니라 그 실행에 MCP 도구가 아예 없다는 사실의 반영이다.
   */
  if (req.toolBrokerScope) {
    const declaredCatalogIds = req.requiredToolCatalogIds ?? [];
    const declaredToolNames = [...new Set(mcpIncludedServers
      .filter((server) => !!server.catalogId && declaredCatalogIds.includes(server.catalogId))
      .map((server) => `mcp__${server.configKey}`))];
    toolBroker = materializeToolBroker({
      runId: req.toolBrokerScope.runId,
      nodeId: req.toolBrokerScope.nodeId,
      declaredToolCatalogIds: declaredCatalogIds,
      declaredToolNames,
      dryRun: req.simulation === true,
      runtimeKind: active.kind === "claude-code" ? "claude" : active.kind,
    });
  }

  const runnerEnv = req.agentAppMode
    ? { env: buildAgentAppRunnerEnv(process.env, mcpRuntimeEnv), injectedKeys: [], renameSuggestions: [] }
    : await buildRunnerEnv(agent, workingFolder ?? undefined, {
        restrictedReadBoundary,
        // Team members run in the same tool process: the keys they declare must reach it too.
        memberAgents: (req.taskForceTargets ?? []).flatMap((target) =>
          target.source === "local" && target.entityKind === "agent" ? [getAgentById(target.agentId)] : []),
      });
  // A saved key that is only misnamed (ELEVENLABS_1 for ELEVENLABS_API_KEY) already reaches the tools under the read
  // name (owner 2026-10-12: don't ask), so it is only recorded. Only a key that could not be aliased is offered to the
  // owner, once, as one plain line. Nothing is renamed here.
  if (!req.agentAppMode) {
    for (const alias of runnerEnv.aliasedKeys ?? []) {
      tryRecordRunEvent({
        runId: req.runId ?? `chat:${chat.id}`, kind: "env_key_aliased", chatId: chat.id, agentId: agent.id,
        payload: { from: alias.from, to: alias.to },
      });
    }
    for (const suggestion of runnerEnv.renameSuggestions ?? []) {
      if (!claimRenameAnnouncement(suggestion)) continue;
      const notice = renameSuggestionNotice(suggestion, locale === "ko" ? "ko" : "en");
      sink({ kind: "notice", notice: { level: "warning", code: "env-key-rename-suggested", message: notice.message, i18n: notice.i18n } });
      tryRecordRunEvent({
        runId: req.runId ?? `chat:${chat.id}`, kind: "env_key_rename_suggested", chatId: chat.id, agentId: agent.id,
        payload: { from: suggestion.from, to: suggestion.to },
      });
    }
  }
  const orchestrationRunnerEnv = restrictedOrchestrationBoundary
    ? restrictedRunnerEnv()
    : runnerEnv.env;
  throwIfInvocationAborted(signal, locale);
  if (mcpRuntimeEnv && !req.agentAppMode) Object.assign(runnerEnv.env, mcpRuntimeEnv);
  if (nativeBrowserGrant && mcpConfigPath) {
    runnerEnv.env.AGENTLAS_NATIVE_BROWSER_SCOPE = "task";
    orchestrationRunnerEnv.AGENTLAS_NATIVE_BROWSER_SCOPE = "task";
  }
  // Runtime detection/routing can take time. Check the capability again at the
  // last shared point before any direct, group, firm, swarm, or borrowed runner
  // can start. A deleted/replaced directory cannot inherit the earlier check.
  if (workspaceBinding) revalidateInvocationWorkspaceBinding(workspaceBinding);
  assertMcpGoalSelectionCurrent();
  let coreStormbreakerHarnessPromise: ReturnType<typeof stormbreakerHarness> | null = null;
  const loadCoreStormbreakerHarness = () => {
    coreStormbreakerHarnessPromise ??= stormbreakerHarness({
      cwd: resolvedResultFolder,
      signal,
    });
    return coreStormbreakerHarnessPromise;
  };

  // Runtime goal continuity may reuse a Task that already exists, but merely
  // asking a conversational turn must not manufacture one. The chat id is the
  // durable fallback goal key until an authoritative promotion occurs.
  const canonicalTask = findCanonicalTaskForChat(chat.id);
  let nativeCaptureBound = false;
  let blindVisionRuntime = false;
  let collectDurableToolImages: ((paths: readonly string[], allowResultFolder?: boolean) => boolean) | null = null;
  const publishNativeCapture = createNativeCapturePublisher({
    task: canonicalTask, chatId: chat.id, runId: req.runId ?? "", signal,
    emit: (event) => { sink(event); nativeCaptureBound = true; },
    onCommittedImage: (filePath) => { collectDurableToolImages?.([filePath]); },
  });

  // Host pre-turn image generation is for runtimes that cannot draw by
  // themselves. Codex/Antigravity request images through their own image
  // generation (or the host generate_image tool) and the host copies each
  // result into the working folder. One and Work now share the same rule —
  // the old One exclusion predates the unified One/Work image binding.
  const runtimeDrawsItself = (RUNTIME_NATIVE_CAPABILITIES[active.kind] ?? []).includes("image.generate");
  const imageGenerationRequired = !req.agentAppMode
    && chat.kind !== "division"
    && !runtimeDrawsItself
    && naturalLanguageRequiresImageGeneration(req.userPrompt);
  /*
   * ★찍어 달라고 했으면 찍은 것이 있어야 한다 — 그리라고는 하지 않았으므로 생성은 하지 않고
   * 결과만 요구한다(위 판정기 주석의 실측 참고).
   */
  const screenCaptureRequired = !req.agentAppMode
    && chat.kind !== "division"
    && !naturalLanguageRequiresImageGeneration(req.userPrompt)
    && naturalLanguageRequiresScreenCapture(req.userPrompt);
  let observedImageArtifactEvidence = false;
  const pendingWorkToolImages: Array<{ sourcePath: string; image: ImageAttachment }> = [];
  const generatedImageSourcePaths = new Set<string>();
  // One seal for both sources of this run's outputs: the paths a runtime adapter structured for a tool event, and the
  // files a harness port wrote for this run (harness/run-produced-files.ts). A/B 2026-10-18 (Haiku, GPT): document.save
  // and media.image.generate answered a path, Outputs stayed empty and both answers said no file was linked. A port's
  // file is this run's output whichever tool event carries it, so the read-observation rule covers the adapter's paths.
  const bindInvocationOneArtifacts = (
    toolId: string,
    paths: readonly string[],
    observedBy?: { name: string; kind?: RuntimeToolKind },
    /** Receives the paths of the port files this call took (the main runner attaches their images to the answer too). */
    onProducedPaths?: (taken: string[]) => void,
  ): NonNullable<McpInvocationEvent["oneArtifacts"]> => {
    const runId = req.runId;
    // Only files the run produced are outputs. A file the model only read (Claude `Read` of an image, any typed
    // `read` tool) is an observation: the Yotube QA contact sheets it inspected were bound as 15 "results"
    // (2026-10-17) while the rendered videos were not.
    if (observedBy && (observedBy.kind === "read"
      || (!observedBy.kind && /^(?:Read|view_image|read_image|read_file|view_file)$/u.test(observedBy.name.trim())))) paths = [];
    // An adapter path binds under its tool's id; a port's file binds under its own record id, so a completion whose local
    // server sent no call id still carries it (local-tool-loop.ts synthesizes the wire id and reports none).
    if (!toolId) paths = [];
    if (req.agentAppMode || !runId || (paths.length === 0 && !hasRunProducedFiles(runId))) return [];
    // A conversational One run can become a canonical Task on its first tool
    // event. The Task did not exist when this invocation was prepared, but it
    // is already durable by the successful completion event that carries the
    // artifact. Resolve it again here so that first-turn outputs bind to the
    // Task that the invocation service just materialized.
    const artifactTask = findCanonicalTaskForChat(chat.id) ?? canonicalTask;
    // Work and One use the same canonical Task output rail. Admission depends
    // on that exact Task/run binding, not on which product opened the chat.
    if (!artifactTask) return [];
    const bind = (bindToolId: string, candidates: readonly string[]): NonNullable<McpInvocationEvent["oneArtifacts"]> => (
      candidates.length === 0 ? [] : bindOneRuntimeToolArtifacts({
        taskId: artifactTask.id,
        taskVersion: artifactTask.version,
        chatId: chat.id,
        runId,
        toolId: bindToolId,
        paths: candidates,
      }).map((artifact) => ({
        taskId: artifactTask.id,
        taskVersion: artifactTask.version,
        chatId: chat.id,
        runId,
        manifestId: artifact.manifestId,
        artifactRef: artifact.artifactRef,
        label: artifact.label,
        type: artifact.type,
        sizeBytes: artifact.sizeBytes,
      })));
    paths = paths.filter(target => !isWorkAttachmentInput(runId, chat.id, resolvedResultFolder, path.resolve(resolvedResultFolder, target)));
    // An input copy staged for this run (even one a port rewrote) is not an output; its folder goes when the run ends.
    // A file this chat already holds as an output, byte for byte, is not bound again (a reused narration, a job read twice).
    const produced = takeRunProducedFiles(runId).filter((file) => {
      if (oneArtifactAlreadyBoundInChat({ chatId: chat.id, candidate: file.path })) return false;
      if (!resolvedResultFolder) return true;
      try { return !isWorkAttachmentInput(runId, chat.id, resolvedResultFolder, file.path); } catch { return false; }
    });
    if (produced.length) onProducedPaths?.(produced.map((file) => file.path));
    // Each write binds under its own host record id, so the same file saved twice is two exact bindings, never one reused.
    return [...bind(toolId, paths), ...produced.flatMap((file) => bind(`harness-output:${file.recordId}`, [file.path]))];
  };
  const runBoundTaskForceInvocation = async (
    params: Parameters<typeof runBorrowedTaskForceInvocation>[0],
  ) => {
    // Main preparation can await roster/lease work after the common guard.
    // Check the prepared scope at this first team dispatch, not each worker.
    assertMcpGoalSelectionCurrent();
    // A synthesis final precedes the aggregate return. Main ignores errors
    // after its first terminal, so hold that final until worker verification.
    let finalEvent: McpInvocationEvent | undefined;
    preparationDispatched = true;
    const result = await runBorrowedTaskForceInvocation({
      ...params,
      sink: event => {
        if (event.kind === "final" && !event.agentId) finalEvent = event;
        else params.sink(event);
      },
      // Every early team route crosses this Main-owned boundary. A verifier
      // retry must reach the planner/workers before the general runner helper.
      goalCheckpoint: params.chat.goalId ? latestTaskCheckpoint(params.chat.goalId) ?? undefined : undefined,
      ...(browserOnly ? { browserOnly: true as const } : {}),
      ...(isolatedMcpConfig ? { isolatedMcpConfig: true as const } : {}),
      onControllerRuntimeFallback: params.onControllerRuntimeFallback ?? emitControllerRuntimeFallback,
      bindOneRuntimeToolArtifacts: bindInvocationOneArtifacts,
      prepareWorkerCapabilities,
      ...(browserApprovalScope ? { browserApprovalScope } : {}),
    });
    if (result.ok) {
      if (finalEvent) params.sink(finalEvent);
    } else {
      if (finalEvent?.durableAssistantMessageIdForVerification) params.sink({
        kind: "partial", text: "", durableMessageId: finalEvent.durableAssistantMessageIdForVerification,
      });
      params.sink({
        ...finalEvent, kind: "error",
        text: finalEvent?.text ?? result.text,
        error: {
          code: "task-force-verification-failed",
          message: locale === "ko" ? "태스크포스의 일부 실행이 완료되거나 검증되지 않았습니다. 저장된 결과와 실행 기록을 확인하세요." : "Some task force execution is incomplete or unverified. Review the saved result and run history.",
        },
      });
    }
    return result;
  };
  const workforceProjectDir = workingFolder ?? process.cwd();
  // 프로젝트가 있으면 편성은 프로젝트에 붙는다 — 새 대화를 열어도 팀을 물려받는다.
  const durableWorkforceGoalId = resolveDesktopWorkforceGoalId({
    chatGoalId: chat.goalId,
    projectId: invocationProjectId,
    taskId: canonicalTask?.id,
    chatId: chat.id,
  });
  let durableTurnDecision: DesktopWorkforceTurnDecision | null = null;
  let durableRuntimePlan: DesktopWorkforceRuntimePlan | null = null;
  // A Main-issued, user-confirmed external Workforce capability is already the
  // authoritative staffing decision for this exact turn. Re-running durable
  // goal arbitration here allowed a prior failed preparation to downgrade the
  // next explicit "bring an expert" confirmation to local-only, so the run
  // falsely claimed no PDF/file tools were available without invoking the
  // selected Workforce at all.
  if (!scienceCollectionCurrent && oneTeamExecutionPolicy !== "confirmed_external_workforce") {
    try {
      const durableContext = await loadDesktopWorkforceGoal(workforceProjectDir, durableWorkforceGoalId);
      const goal = durableContext.goals[0];
      if (goal) {
      const readyPlans = goal.plans.filter((plan) => plan.status === "ready" && plan.preparation);
      if (turnEscalation.level === "solo") {
        /* 난이도가 solo면 판정 자체를 건너뛴다.
         *
         * 예전에는 편성이 묶인 대화의 **모든** 턴이 판정용 모델 왕복을 한 번씩 더 돌았다
         * ("고마워요" 한 마디에도). 판정이 작업만큼 비싸면 라우팅의 의미가 없다. 양끝은
         * 공짜 신호로 이미 정해졌으므로 여기서 다시 물을 것이 없다. */
        durableTurnDecision = { decision: "local-only", planRevision: null, reasonCode: "escalation-solo" };
      } else if (durableContext.status === "refresh-required" || !goal.executionAllowed || !readyPlans.length) {
        durableTurnDecision = {
          decision: "recruit",
          planRevision: null,
          reasonCode: "lease-refresh-or-plan-unavailable",
        };
      } else {
        assertMcpGoalSelectionCurrent();
        preparationDispatched = true;
        const decisionResult = await runInvocationPlanningRunner(picked.runner,
          {
            ...(planReadOnly ? { planMode: true as const } : {}),
            systemPrompt: [
              "You are the active Agentlas Desktop host deciding one turn of a durable Workforce goal.",
              "Decide the STAFFING SOURCE only. Never decompose the task or assign roles — the executing model owns that.",
              "Order of preference, highest first: (1) an exact incumbent plan, (2) the agents this project already designates, (3) recruiting someone new.",
              "Choose reuse when one exact incumbent plan can perform this turn.",
              "Choose local-only when the host, local skills, or the project's designated agents can perform it without recruiting. A designated agent that fits is always preferred over recruiting a new one.",
              "Choose recruit only when neither the incumbent plan nor any designated agent covers a real capability, tool, or modality gap. Name that gap in reasonCode.",
              "Choose blocked only when safe progress is impossible.",
              "escalation tells you how heavy this turn is; it never by itself justifies recruiting.",
              "Never complete or dismiss the goal.",
              'Return exactly one JSON object: {"decision":"reuse|recruit|local-only|blocked","planRevision":1|null,"reasonCode":"short-code"}.',
            ].join("\n"),
            history: [],
            userPrompt: JSON.stringify({
              currentTurnTask: req.userPrompt,
              goalId: durableWorkforceGoalId,
              // 판정이 리스트를 볼 수 없으면 "리스트 우선"은 성립할 수 없다. 예전에는
              // 이 입력에 기존 플랜만 들어가서, 지정한 에이전트는 판정 대상에조차
              // 오르지 못했다.
              projectDesignatedAgents: projectRosterForTurn.map((member) => ({
                name: member.nameSnapshot,
                kind: member.entityKind,
                source: member.source,
              })),
              // 난이도 근거는 해석이 아니라 직전 턴의 계측치다.
              escalation: {
                level: turnEscalation.level,
                reasonCode: turnEscalation.reasonCode,
                previousTurn: turnEscalation.basis,
              },
              incumbentPlans: readyPlans.map((plan) => ({
                revision: plan.revision,
                agentReleaseIds: plan.agentReleaseIds,
                leaseExpiresAt: plan.leaseExpiresAt,
              })),
            }),
            backendLabel: picked.label,
            model: active.model ?? undefined,
            longContext: active.longContextEnabled ?? false,
            effort: active.effort ?? undefined,
            signal,
            permission: directUserTeamControlAuthority ? normalizedPermission : "read",
            restrictedReadBoundary: restrictedOrchestrationBoundary || undefined,
            env: orchestrationRunnerEnv,
            // This is a bounded staffing decision, but an internal control
            // label must not revoke authority the user already granted to an
            // exact runtime. Unpinned/background/restricted callers retain the
            // existing zero-tool path.
            untrustedNoTools: !directUserTeamControlAuthority,
            cwd: directUserTeamControlAuthority ? workingFolder ?? undefined : undefined,
            chatId: `workforce-goal-turn:${req.runId}`,
            locale,
          },
          { onStatus: () => {}, onPartial: () => {},
            onTool: (name, args, result, id, isError, artifactPaths, imageDataUrl) => sink({ kind: "tool-use",
              tool: { name, args, result, id, isError, observationDigest: toolObservationDigest(artifactPaths, imageDataUrl) },
              agentId: "workforce:staffing", phase: "plan" }) },
          active,
          assertMcpGoalSelectionCurrent,
          executionContext?.graphWorkerAttempt,
        );
        durableTurnDecision = parseDesktopWorkforceTurnDecision(decisionResult.text, readyPlans);
        if (durableTurnDecision.decision === "reuse") {
          durableRuntimePlan = readyPlans.find((plan) => plan.revision === durableTurnDecision?.planRevision) ?? null;
        }
      }
    }
    } catch (error) {
      if (explicitWorkforceGoal || runtimeFailureBlocksReplay(InvocationRunnerFailureError.providerFailure(error))) throw error;
      // A chat with no binding or no signed-in account remains an ordinary local
      // turn. Once the user explicitly invokes Workforce, the same failure is
      // surfaced instead of silently falling back.
    }
  }

  if (durableTurnDecision?.decision === "blocked") {
    await recordDesktopWorkforceTurn({
      projectDir: workforceProjectDir,
      goalId: durableWorkforceGoalId,
      decision: "blocked",
      gapCodes: [durableTurnDecision.reasonCode],
      turnId: req.runId,
    });
    sink({
      kind: "error",
      error: {
        code: "workforce-goal-turn-blocked",
        message: locale === "ko"
          ? "기존 팀·로컬 처리·추가 영입 중 안전하게 진행할 수 있는 경로가 없어 이 턴을 중단했습니다."
          : "No safe incumbent, local, or recruitment path can progress this turn.",
      },
    });
    return earlyResult();
  }
  if (durableTurnDecision?.decision === "local-only") {
    explicitWorkforceGoal = null;
    await recordDesktopWorkforceTurn({
      projectDir: workforceProjectDir,
      goalId: durableWorkforceGoalId,
      decision: "local-only",
      gapCodes: [durableTurnDecision.reasonCode],
      turnId: req.runId,
    });
  } else if (durableTurnDecision?.decision === "recruit") {
    explicitWorkforceGoal = req.userPrompt;
  }

  if (durableTurnDecision?.decision === "reuse" && durableRuntimePlan?.preparation) {
    const continuation = durableRuntimePlan.preparation;
    const rawSpecs = continuation.specs as BorrowedAgentSpec[];
    const receipt = continuation.receipt as unknown as WorkforceSelectionReceipt;
    if (!Array.isArray(rawSpecs) || !rawSpecs.length || receipt.schemaVersion !== "agentlas.desktop-workforce-selection-receipt.v1") {
      throw new Error("workforce_goal_runtime_invalid");
    }
    // 자동 재사용 경로 — 프로젝트의 공개 Hub 자동 사용 동의를 확인한다.
    const specs = await gateHubSpecsByProjectRentPolicy({
      specs: rawSpecs,
      projectId: invocationProjectId,
      userPrompt: req.userPrompt,
      locale,
      sink,
    });
    if (!specs.length) {
      throw new Error(locale === "ko"
        ? "이 프로젝트에서 자동 사용을 허용한 Hub 에이전트가 없어 자동 편성을 실행하지 않았습니다. 프로젝트의 [자동 사용]을 켜거나 에이전트를 직접 지목해 주세요."
        : "No Hub agent is enabled for automatic use in this project. Turn on [Auto use] or name an agent explicitly.");
    }
    const execution = await runBoundTaskForceInvocation({
      req: { ...req, borrowAgents: undefined, taskForceTargets: undefined },
      chat,
      orchestratorAgent: agent,
      taskForceName: locale === "ko" ? "Agent Workforce TF" : "Agent Workforce task force",
      taskForceKind: "task-force",
      taskForceSpecs: specs,
      priorHistory,
      active,
      runtimes,
      picked,
      runtimeOverride: runtimeChoice.override,
      // 사람이 방에서 고른 런타임이 실제로 존중됐는가. 단톡 오케스트레이터는
      // 이것이 참이면 역할 정책보다 그 선택을 앞세운다 — 안 그러면 화면에 적힌
      // 모델과 실제로 부르는 모델이 갈린다(실측 2026-08-26: 방은 gemini 인데
      // Claude 를 불러 주간 한도에 걸렸고, 그 실패가 멀쩡한 팀원 답변에
      // '전달 실패' 배지를 붙였다).
      runtimePinHonored: runtimeResolution.pinHonored,
      workingFolder,
      ...(workspaceBinding ? { workspaceBinding } : {}),
      ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
      mcpConfigPath,
      mcpAllowedTools,
      mcpCodexConfigArgs,
      agentAppMcpRuntimeEnv: mcpRuntimeEnv,
      onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
      runnerEnv: orchestrationRunnerEnv,
      locale,
      sink,
      signal,
      workforceSelectionReceipt: receipt,
      workforceLeaderRunnerEvidence: [],
      benchmarkMode: false,
      requireAllWorkers: true,
    });
    if (!execution.ok) {
      sink({
        kind: "error",
        error: {
          code: "workforce-verification-failed",
          message: execution.verifierIssues?.join(", ") || "Workforce structural verification failed.",
        },
      });
      return earlyResult();
    }
    await recordDesktopWorkforceTurn({
      projectDir: workforceProjectDir,
      goalId: durableWorkforceGoalId,
      decision: "reuse",
      rosterKeys: durableRuntimePlan.rosterKeys,
      gapCodes: [durableTurnDecision.reasonCode],
      turnId: req.runId,
    });
    return earlyResult();
  }

  // ── Agent Workforce Ontology ────────────────────────────────
  // The active host model owns both the job-analysis work order and the final
  // semantic roster decision. Main calls Hub MCP only for content-only search,
  // deterministic validation, and exact immutable release preparation.
  if (explicitWorkforceGoal) {
    try {
      const workforceLeaderRunnerEvidence: WorkforceLeaderRunnerEvidence[] = [];
      const hostOperations = createMainHostOperationBridge(sink, "main-hub", chat.id, "workforce:leader");
      const hostControls = createMainHostControlSink(hostOperations.sink);
      const hub = installedWorkforceHubMcp();
      const workforce = await runWorkforceSelection({
        goal: explicitWorkforceGoal,
        projectDir: workforceProjectDir,
        goalId: durableWorkforceGoalId,
        occurrenceId: executionContext?.occurrenceId ?? req.runId,
        inputModalities: req.images?.length ? ["modality:image"] : [],
        active,
        benchmarkMode: workforceBenchmarkMode,
        sourcePolicy: req.hubMode === "hub-first" ? "hub-required" : "network",
        signal,
        sink: hostControls.sink,
        hubMcp: { call: (tool, args, abortSignal) => hostOperations.call(tool, args, () => hub.call(tool, args, abortSignal)) },
        auditSchemaAttempt: (attempt) => hostControls.audit("validation", { name: "agentlas.workforce.schema_attempt", agentId: "workforce:leader", role: "workforce-leader", phase: "plan", tier: 1, id: attempt.invocationId, result: JSON.stringify(attempt), isError: attempt.status === "rejected" }, () => recordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_schema_attempt",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...attempt },
        })),
        auditHubToolObservation: (observation) => hostControls.audit("selection-observation", { name: "agentlas.workforce.hub_tool_observation", agentId: "workforce:leader", role: "workforce-leader", phase: "plan", tier: 1, id: observation.invocationId, result: JSON.stringify(observation), isError: observation.status === "failed" }, () => recordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_hub_tool_observation",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...observation },
        })),
        auditHubToolSupersession: (supersession) => hostControls.audit("authority-supersession", { name: "agentlas.workforce.hub_tool_supersession", agentId: "workforce:leader", role: "workforce-leader", phase: "plan", tier: 1, id: supersession.supersessionId, result: JSON.stringify(supersession) }, () => recordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_hub_tool_supersession",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...supersession },
        })),
        auditLeaderDecisionSupersession: (supersession) => hostControls.audit("authority-supersession", { name: "agentlas.workforce.leader_decision_supersession", agentId: "workforce:leader", role: "workforce-leader", phase: "plan", tier: 1, id: supersession.supersessionId, result: JSON.stringify(supersession) }, () => recordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_leader_decision_supersession",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...supersession },
        })),
        auditWorkOrderRefinement: (refinement) => hostControls.audit("contract-refinement", { name: "agentlas.workforce.work_order_refinement", agentId: "workforce:leader", role: "workforce-leader", phase: "plan", tier: 1, id: refinement.invocationId ?? `workforce-refinement:${refinement.refinement}`, result: JSON.stringify(refinement), isError: refinement.status === "failed" }, () => recordRunEvent({
          runId: req.runId ?? `task-force:${chat.id}`,
          kind: "workforce_work_order_refinement",
          chatId: chat.id,
          nodeId: "workforce:leader",
          agentId: agent.id,
          payload: { ...refinement },
        })),
        leader: async (turn) => {
          throwIfInvocationAborted(signal, locale);
          assertMcpGoalSelectionCurrent();
          preparationDispatched = true;
          const result = await withAdapterEffectChildDispatch(turn.invocationId, () => runInvocationPlanningRunner(pickedForWorkforceLeader.runner,
            {
              ...(planReadOnly ? { planMode: true as const } : {}),
              systemPrompt: turn.systemPrompt,
              history: [],
              userPrompt: turn.userPrompt,
              ...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
              // Attachments stay inside the selected local/BYOM leader runtime. Hub receives
              // only the validated redacted WorkOrder, never image bytes or attachment paths.
              images: req.images,
              backendLabel: pickedForWorkforceLeader.label,
              model: active.model ?? undefined,
              longContext: active.longContextEnabled ?? false,
              effort: active.effort ?? undefined,
              signal,
              permission: directUserTeamControlAuthority ? normalizedPermission : "read",
              restrictedReadBoundary: restrictedOrchestrationBoundary || undefined,
              env: orchestrationRunnerEnv,
              untrustedNoTools: !directUserTeamControlAuthority,
              cwd: directUserTeamControlAuthority ? workingFolder ?? undefined : undefined,
              chatId: turn.invocationId,
              locale,
            },
            {
              onStatus: (status, activity) => sink({
                kind: "tool-use",
                status,
                activity,
                agentId: "workforce:leader",
                agentName: "Agentlas Workforce Leader",
                role: "workforce-leader",
                tier: 1,
                phase: "plan",
              }),
              onPartial: () => {},
              onTool: (name, args, resultText, id, isError, artifactPaths, imageDataUrl) => sink({
                kind: "tool-use",
                tool: { name, args, result: resultText, id, isError, observationDigest: toolObservationDigest(artifactPaths, imageDataUrl) },
                agentId: "workforce:leader",
                agentName: "Agentlas Workforce Leader",
                role: "workforce-leader",
                tier: 1,
                phase: "plan",
              }),
            },
            active,
            assertMcpGoalSelectionCurrent,
            executionContext?.graphWorkerAttempt,
          ));
          workforceLeaderRunnerEvidence.push({
            invocationId: turn.invocationId,
            runtime: { ...active },
            result: { appliedEffort: result.appliedEffort },
          });
          return result.text;
        },
      });
      workforcePrepareReceipt = workforce.prepareCheckpointReceipt;
      executionContext?.onWorkforcePrepareReceipt?.(workforcePrepareReceipt);
      const workforceGoalBinding = await bindDesktopWorkforceGoal({
        goalId: durableWorkforceGoalId,
        projectDir: workforceProjectDir,
        workforce,
      });
      const boundGoals = Array.isArray(workforceGoalBinding.goals)
        ? workforceGoalBinding.goals as Array<Record<string, unknown>>
        : [];
      const boundRoster = Array.isArray(boundGoals[0]?.roster)
        ? boundGoals[0].roster as Array<Record<string, unknown>>
        : [];
      const usedRosterKeys = workforce.receipt.preparedReleases.map((preparedRelease) => {
        const row = boundRoster.find((candidate) =>
          candidate.slotId === preparedRelease.slotId
          && candidate.agentReleaseId === preparedRelease.agentReleaseId
          && candidate.state !== "released");
        const rosterKey = String(row?.rosterKey || "");
        if (!/^sha256:[a-f0-9]{64}$/.test(rosterKey)) {
          throw new Error("workforce_goal_roster_mismatch");
        }
        return rosterKey;
      });
      emitWorkforceBenchmarkSelectionArtifacts(sink, workforceBenchmarkMode, workforce);
      tryRecordRunEvent({
        runId: req.runId ?? `task-force:${chat.id}`,
        kind: "workforce_selection_receipt",
        chatId: chat.id,
        nodeId: "workforce:leader",
        agentId: agent.id,
        payload: {
          receiptId: workforce.receipt.receiptId,
          workOrderId: workforce.receipt.workOrderId,
          selectionReceiptId: workforce.receipt.selectionReceiptId,
          preparationReceiptId: workforce.receipt.preparationReceiptId,
          candidateSetDigest: workforce.receipt.candidateSetDigest,
          ontologyVersion: workforce.receipt.ontologyVersion,
          decisionOwner: workforce.receipt.decisionOwner,
          decisionModel: workforce.receipt.decisionModel,
          historyInfluence: workforce.receipt.historyInfluence,
          executionContext: workforce.receipt.executionContext,
          executionContextDigest: workforce.receipt.executionContextDigest,
          idealTeam: workforce.receipt.idealTeam,
          executableTeam: workforce.receipt.executableTeam,
          unfilledPosts: workforce.receipt.unfilledPosts,
          substitutions: workforce.receipt.substitutions,
          preparedReleases: workforce.receipt.preparedReleases,
          mcpCalls: workforce.receipt.mcpCalls,
          hubToolObservations: workforce.receipt.hubToolObservations,
          hubToolSupersessions: workforce.receipt.hubToolSupersessions,
          leaderDecisionSupersessions: workforce.receipt.leaderDecisionSupersessions,
          leaderInvocations: workforce.receipt.leaderInvocations,
          schemaAttempts: workforce.receipt.schemaAttempts,
          workOrderRefinements: workforce.receipt.workOrderRefinements,
        },
      });
      // 자동 편성(recruit) 경로 — 프로젝트의 공개 Hub 자동 사용 동의를 확인한다.
      const rentGatedWorkforceSpecs = await gateHubSpecsByProjectRentPolicy({
        specs: workforce.specs,
        projectId: invocationProjectId,
        userPrompt: req.userPrompt,
        locale,
        sink,
      });
      if (!rentGatedWorkforceSpecs.length) {
        throw new Error(locale === "ko"
          ? "이 프로젝트에서 자동 사용을 허용한 Hub 에이전트가 없어 자동 편성을 실행하지 않았습니다. 프로젝트의 [자동 사용]을 켜거나 에이전트를 직접 지목해 주세요."
          : "No Hub agent is enabled for automatic use in this project. Turn on [Auto use] or name an agent explicitly.");
      }
      const execution = await runBoundTaskForceInvocation({
        req: { ...req, userPrompt: explicitWorkforceGoal, borrowAgents: undefined, taskForceTargets: undefined },
        chat,
        orchestratorAgent: agent,
        taskForceName: locale === "ko" ? "Agent Workforce TF" : "Agent Workforce task force",
        taskForceKind: "task-force",
        taskForceSpecs: rentGatedWorkforceSpecs,
        priorHistory,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
      // 사람이 방에서 고른 런타임이 실제로 존중됐는가. 단톡 오케스트레이터는
      // 이것이 참이면 역할 정책보다 그 선택을 앞세운다 — 안 그러면 화면에 적힌
      // 모델과 실제로 부르는 모델이 갈린다(실측 2026-08-26: 방은 gemini 인데
      // Claude 를 불러 주간 한도에 걸렸고, 그 실패가 멀쩡한 팀원 답변에
      // '전달 실패' 배지를 붙였다).
      runtimePinHonored: runtimeResolution.pinHonored,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
        workforceSelectionReceipt: workforce.receipt,
        workforceLeaderRunnerEvidence,
        benchmarkMode: workforceBenchmarkMode,
        requireAllWorkers: true,
      });
      if (!execution.ok) {
        sink({
          kind: "error",
          error: {
            code: "workforce-verification-failed",
            message: execution.verifierIssues?.join(", ") || "Workforce structural verification failed.",
          },
        });
      } else {
        await recordDesktopWorkforceTurn({
          projectDir: workforceProjectDir,
          goalId: durableWorkforceGoalId,
          decision: "recruit",
          rosterKeys: usedRosterKeys,
          gapCodes: durableTurnDecision?.reasonCode ? [durableTurnDecision.reasonCode] : [],
          turnId: req.runId,
        });
      }
    } catch (error) {
      throwIfInvocationAborted(signal, locale);
      const failureCode = workforceFailureCode(error);
      sink({
        kind: "error",
        error: failureCode
          ? {
              code: failureCode,
              message: error instanceof Error ? error.message : String(error),
            }
          : invocationFailure(req, "workforce-execution-failed", error, executionContext),
      });
    }
    return earlyResult();
  }

  // ── Exact temporary top-level task force ──────────────────
  // A recommendation is an ephemeral roster, not a chat binding mutation.
  // Main validates every discriminated target against live inventory before
  // handing one execution unit per Agent, Team, or Group to the orchestrator.
  if (req.taskForceTargets !== undefined) {
    try {
      const targets = requireOrchestrationTargets(req.taskForceTargets);
      const taskForceSpecs = await buildStructuredTaskForceSpecs({
        targets,
        prompt: effectiveUserPrompt,
        project: workingFolder,
        locale,
        signal,
        ...(oneParticipantEffectivePrompts
          ? { localEffectivePrompts: oneParticipantEffectivePrompts }
          : {}),
      });
      await runBoundTaskForceInvocation({
        req: { ...req, userPrompt: effectiveUserPrompt },
        chat,
        orchestratorAgent: agent,
        ...(oneParticipantEffectivePrompts
          ? { orchestratorEffectivePrompt: effectivePromptFor(agent) }
          : {}),
        taskForceName: locale === "ko" ? "임시 태스크포스" : "Temporary task force",
        taskForceKind: "task-force",
        taskForceSpecs,
        priorHistory,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
      // 사람이 방에서 고른 런타임이 실제로 존중됐는가. 단톡 오케스트레이터는
      // 이것이 참이면 역할 정책보다 그 선택을 앞세운다 — 안 그러면 화면에 적힌
      // 모델과 실제로 부르는 모델이 갈린다(실측 2026-08-26: 방은 gemini 인데
      // Claude 를 불러 주간 한도에 걸렸고, 그 실패가 멀쩡한 팀원 답변에
      // '전달 실패' 배지를 붙였다).
      runtimePinHonored: runtimeResolution.pinHonored,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      sink({ kind: "error", error: invocationFailure(req, "task-force-failed", err, executionContext) });
    }
    return earlyResult();
  }

  /* ── 리스트 우선 편성 ────────────────────────────────────────
   *
   * 순서는 캐시 → 리스트 → 네트워크다. 위쪽에서 이미 붙어 있는 편성(reuse)을 썼고,
   * 여기서 **프로젝트에 지정한 리스트**를 쓰고, 그래도 모자랄 때만 아래에서 네트워크로
   * 새로 뽑는다. 지금까지는 가운데 칸이 통째로 없어서, 리스트에 무엇을 넣든 실행은
   * 곧바로 네트워크로 갔다.
   *
   * 사용자가 이번 턴에 직접 대상을 지목했으면(@ 지목·명시 borrow) 그 지시가 위다.
   * 평범한 solo 턴에는 팀을 만들지 않는다 — 한 줄 질문에 편성을 붙이는 것이 이 시스템의
   * 반대 방향 결함이다. 다만 사용자 메시지가 저장된 뒤 실제 Goal로 승인된 턴은 첫 턴에도
   * 실행 계약이 생겼으므로, 프로젝트 도구를 편성한다. Cloud 행은 소유 선반의
   * 저장된 exact release를 Core에서 준비한 뒤에만 실행 스펙이 된다. */
  const rosterSpecs = projectRosterSpecs(
    projectRosterForTurn.filter((member) => member.source !== "cloud"),
    {
      agentById: (id) => {
        const installed = getAgentById(id);
        return installed
          ? {
              id: installed.id,
              slug: installed.slug,
              name: installed.name,
              userFacing: isUserFacingProjectAgent(installed),
            }
          : null;
      },
      firmById: (id) => {
        const firm = getFirm(id);
        return firm ? { id: firm.id, slug: firm.slug, name: firm.name } : null;
      },
    },
    locale,
  ) as BorrowedAgentSpec[];
  const rosterTaskForceDecision = decideProjectRosterTaskForce({
    turnEscalation,
    // The durable-message hook above admits automatic Goals and refreshes this
    // field before routing. Automatic Goal does not rewrite req.goalMode.
    activeGoal: Boolean(chat.goalId),
    runnableRosterCount: rosterSpecs.length + projectRosterForTurn.filter((member) => member.source === "cloud").length,
  });
  const rosterFirstEligible =
    !oneTeamExecutionPolicy &&
    !req.agentAppMode &&
    !restrictedReadBoundary &&
    chat.kind !== "division" &&
    rosterTaskForceDecision.run &&
    borrowedAgentSlugs.length === 0 &&
    !userNamedTargetsThisTurn &&
    projectRosterForTurn.length > 0;
  if (rosterFirstEligible) {
    if (rosterSpecs.length > 0 || projectRosterForTurn.some((member) => member.source === "cloud")) {
      try {
        persistUserMessage();
        const canonicalCloudClient = () => {
          const cookie = getSessionCookieHeader();
          if (!cookie) throw new ProjectCloudRosterError("source_unauthorized", "cloud");
          return new ExperienceCloudHttpClient({ baseUrl: webBaseUrl(), cookieHeader: cookie });
        };
        rosterSpecs.push(...await prepareProjectCloudRoster(projectRosterForTurn, {
          listOwnerCloud: async () => {
            const source = getCargoSource();
            if (!source) throw new ProjectCloudRosterError("owner_cloud_unavailable", "cloud");
            // Use the authenticated source, never the UI's stale/fallback cache.
            return (await source.listMyCloudPackages(undefined, { signal, requireComplete: true })).rows;
          },
          listDefinitions: () => canonicalCloudClient().listAgentDefinitionIdentities(),
          resolveBase: (input) => canonicalCloudClient().resolveBase(input),
          prepare: async (target) => {
            const res = await hepCall(`cloud/${target.entityKind}/${target.slug}`, [
              "Prepare this exact project-designated Cloud release for local execution.",
            ], { project: workingFolder ?? ".", version: target.packageHash, signal });
            const [spec] = requireBorrowedAgentSpecs([target.slug], res.json ?? null, {
              locale,
              transportOk: res.ok,
              transportError: res.error || (res.exitCode == null ? "cloud_call_failed" : `cloud_exit_${res.exitCode}`),
            });
            if (!spec) throw new BorrowedAgentUnavailableError([target.slug], ["missing_directive"], locale);
            return spec;
          },
        }));
        // 영수증 — 무엇으로 이 등급이 나왔고 누구를 썼는지 남긴다. 이 줄이 없으면
        // "리스트가 안 쓰였다"가 다시 조용해진다.
        sink({
          kind: "tool-use",
          status: locale === "ko"
            ? `프로젝트 지정 ${rosterSpecs.length}명으로 편성합니다 (경로 ${rosterTaskForceDecision.reasonCode}; 난이도 ${describeTurnEscalation(turnEscalation)}).`
            : `Staffing with ${rosterSpecs.length} project-designated member(s) (route ${rosterTaskForceDecision.reasonCode}; escalation ${describeTurnEscalation(turnEscalation)}).`,
        });
        await runBoundTaskForceInvocation({
          req: { ...req, userPrompt: effectiveUserPrompt, borrowAgents: undefined, taskForceTargets: undefined },
          chat,
          orchestratorAgent: agent,
          taskForceName: locale === "ko" ? "프로젝트 지정 팀" : "Project-designated team",
          taskForceKind: "task-force",
          taskForceSpecs: rosterSpecs,
          priorHistory,
          active,
          runtimes,
          picked,
          runtimeOverride: runtimeChoice.override,
      // 사람이 방에서 고른 런타임이 실제로 존중됐는가. 단톡 오케스트레이터는
      // 이것이 참이면 역할 정책보다 그 선택을 앞세운다 — 안 그러면 화면에 적힌
      // 모델과 실제로 부르는 모델이 갈린다(실측 2026-08-26: 방은 gemini 인데
      // Claude 를 불러 주간 한도에 걸렸고, 그 실패가 멀쩡한 팀원 답변에
      // '전달 실패' 배지를 붙였다).
      runtimePinHonored: runtimeResolution.pinHonored,
          workingFolder,
          ...(workspaceBinding ? { workspaceBinding } : {}),
          ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
          mcpConfigPath,
          mcpAllowedTools,
          mcpCodexConfigArgs,
          agentAppMcpRuntimeEnv: mcpRuntimeEnv,
          onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
          runnerEnv: orchestrationRunnerEnv,
          locale,
          sink,
          signal,
        });
        return earlyResult();
      } catch (err) {
        if (signal?.aborted) return earlyResult();
        // 리스트로 실패했다고 조용히 네트워크로 넘어가지 않는다 — 사용자가 지정한
        // 팀이 실패했다는 사실 자체가 결과다.
        sink({
          kind: "error",
          error: err instanceof ProjectCloudRosterError || err instanceof OwnerCloudShelfIncompleteError
            ? { code: err.code, message: err.message }
            : invocationFailure(req, "project-roster-task-force-failed", err, executionContext),
        });
        return earlyResult();
      }
    }
  }

  // ── Hub borrowed task force ─────────────────────────────────
  // 추천 시트에서 Hub 에이전트 2개 이상을 고른 경우: 단일 프롬프트에 "여러 전문가를 적용"이라고
  // 뭉개지 않고, 로컬 오케스트레이터가 에이전트별 입력 패킷을 설계한 뒤 각 borrowed agent를
  // 별도 세션으로 병렬 실행하고 최종 종합한다.
  // 명시적 Hub borrow는 swarm보다 먼저 실행한다. 그렇지 않으면 swarm이 req.borrowAgents를
  // 소비하지 않은 채 로컬 워커만 실행해 Hub 권한/번들 검증을 우회할 수 있다.
  const directBorrowedTeam = explicitBorrowSpecs.length === 1
    && explicitBorrowSpecs[0].entityKind === "team"
    ? explicitBorrowSpecs[0]
    : null;
  if (directBorrowedTeam && chat.kind !== "division") {
    try {
      await runBoundTaskForceInvocation({
        req: { ...req, userPrompt: effectiveUserPrompt, borrowAgents: undefined },
        chat,
        orchestratorAgent: agent,
        taskForceName: directBorrowedTeam.name,
        taskForceKind: "task-force",
        taskForceSpecs: [directBorrowedTeam],
        priorHistory,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
      // 사람이 방에서 고른 런타임이 실제로 존중됐는가. 단톡 오케스트레이터는
      // 이것이 참이면 역할 정책보다 그 선택을 앞세운다 — 안 그러면 화면에 적힌
      // 모델과 실제로 부르는 모델이 갈린다(실측 2026-08-26: 방은 gemini 인데
      // Claude 를 불러 주간 한도에 걸렸고, 그 실패가 멀쩡한 팀원 답변에
      // '전달 실패' 배지를 붙였다).
      runtimePinHonored: runtimeResolution.pinHonored,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      sink({ kind: "error", error: invocationFailure(req, "borrowed-team-failed", err, executionContext) });
    }
    return earlyResult();
  }
  if (borrowedAgentSlugs.length > 1 && chat.kind !== "division") {
    try {
      await runBoundTaskForceInvocation({
        req: { ...req, borrowAgents: borrowedAgentSlugs },
        chat,
        orchestratorAgent: agent,
        priorHistory,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
      // 사람이 방에서 고른 런타임이 실제로 존중됐는가. 단톡 오케스트레이터는
      // 이것이 참이면 역할 정책보다 그 선택을 앞세운다 — 안 그러면 화면에 적힌
      // 모델과 실제로 부르는 모델이 갈린다(실측 2026-08-26: 방은 gemini 인데
      // Claude 를 불러 주간 한도에 걸렸고, 그 실패가 멀쩡한 팀원 답변에
      // '전달 실패' 배지를 붙였다).
      runtimePinHonored: runtimeResolution.pinHonored,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        agentAppMcpRuntimeEnv: mcpRuntimeEnv,
        onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
      });
    } catch (err) {
      sink({ kind: "error", error: invocationFailure(req, "borrowed-task-force-failed", err, executionContext) });
    }
    return earlyResult();
  }

  // ── 스웜 모드 ──
  // 켜져 있으면 목표를 작업 그래프로 분해해 여러 워커가 병렬 협업(emergent A2A). 동시성=사용자 슬라이더.
  // Explicit single borrow also bypasses swarm: its verified Hub user preamble
  // must reach the selected primary runtime unchanged instead of being discarded.
  if (
    oneTeamAllowsStorm &&
    !req.agentAppMode &&
    (chat.swarmMode || stormbreakerSwarm) &&
    borrowedAgentSlugs.length === 0 &&
    chat.kind !== "division"
  ) {
    try {
      persistUserMessage();
      const coreHarness = stormbreakerSwarm
        ? await loadCoreStormbreakerHarness()
        : undefined;
      if (stormbreakerSwarm && !chat.swarmMode) {
        sink({
          kind: "tool-use",
          status: locale === "ko"
            ? "Stormbreaker · Goal/UltraCode 병렬 작업 분해와 런타임 자동 배정을 시작합니다."
            : "Stormbreaker · starting Goal/UltraCode parallel decomposition with automatic runtime allocation.",
        });
      }
      assertMcpGoalSelectionCurrent();
      preparationDispatched = true;
      await runSwarmInvocation({
        // Persist the exact user command above, but give workers the actual
        // goal rather than a route slug that could be mistaken for work.
        req: stormbreakerSwarm ? { ...req, userPrompt: explicitStormbreakerGoal } : req,
        chat,
        orchestratorAgent: agent,
        priorHistory,
        active,
        runtimes,
        picked,
        runtimeOverride: runtimeChoice.override,
      // 사람이 방에서 고른 런타임이 실제로 존중됐는가. 단톡 오케스트레이터는
      // 이것이 참이면 역할 정책보다 그 선택을 앞세운다 — 안 그러면 화면에 적힌
      // 모델과 실제로 부르는 모델이 갈린다(실측 2026-08-26: 방은 gemini 인데
      // Claude 를 불러 주간 한도에 걸렸고, 그 실패가 멀쩡한 팀원 답변에
      // '전달 실패' 배지를 붙였다).
      runtimePinHonored: runtimeResolution.pinHonored,
        workingFolder,
        ...(workspaceBinding ? { workspaceBinding } : {}),
        ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
        mcpConfigPath,
        mcpAllowedTools,
        mcpCodexConfigArgs,
        bindOneRuntimeToolArtifacts: bindInvocationOneArtifacts,
        runnerEnv: orchestrationRunnerEnv,
        locale,
        sink,
        signal,
        stormbreakerMode: stormbreakerSwarm,
        stormbreakerHarness: coreHarness,
      });
    } catch (err) {
      sink({ kind: "error", error: invocationFailure(req, "swarm-failed", err, executionContext) });
    }
    return earlyResult();
  }

  // ── 멀티 에이전트 firm 오케스트레이션 ──
  // 회사 채팅이고 정규화된 조직에 본부/전문가가 있으면 3-tier 오케스트레이터로 분기.
  // (본부가 없는 firm은 아래 단일 CEO 경로 — 기존 동작 유지)
  if (!oneTeamExecutionPolicy && chat.firmId) {
    const firm = getFirm(chat.firmId);
    if (firm) {
      const org = getResolvedOrg(firm);
      if (org.divisions.length > 0) {
        try {
          const firmUserPrompt = explicitBorrowUserPreamble
            ? borrowedCurrentUserPrompt(effectiveUserPromptParts, explicitBorrowUserParts)
            : effectiveUserPrompt;
          assertMcpGoalSelectionCurrent();
          await runFirmInvocation({
            req: { ...req, userPrompt: firmUserPrompt },
            chat: { id: chat.id, projectId: invocationProjectId, firmId: chat.firmId, goalId: chat.goalId },
            goalCheckpoint: chat.goalId ? latestTaskCheckpoint(chat.goalId) ?? undefined : undefined,
            org,
            ceoAgent: agent,
            priorHistory,
            active,
            runtimes,
            picked,
            workingFolder,
            ...(workspaceBinding ? { workspaceBinding } : {}),
            ...(restrictedOrchestrationBoundary ? { restrictedReadBoundary: true as const } : {}),
            mcpConfigPath,
            mcpAllowedTools,
            mcpCodexConfigArgs,
            ...(isolatedMcpConfig ? { isolatedMcpConfig: true as const } : {}),
            ...(browserOnly ? { browserOnly: true as const } : {}),
            agentAppMcpRuntimeEnv: mcpRuntimeEnv,
            prepareWorkerCapabilities,
            bindOneRuntimeToolArtifacts: bindInvocationOneArtifacts,
            onAgentAppMcpRuntimeUnavailable: markAgentAppMcpRuntimeUnavailable,
            onControllerRuntimeFallback: emitControllerRuntimeFallback,
            runtimePinHonored: runtimeResolution.pinHonored,
            runnerEnv: orchestrationRunnerEnv,
            locale,
            sink,
            signal,
          });
        } catch (err) {
          // 오케스트레이션 실패 → 무한 스피너 방지: 에러 이벤트 emit
          sink({ kind: "error", error: invocationFailure(req, "firm-failed", err, executionContext) });
        }
        return earlyResult();
      }
    }
  }

  const persistentAgentContext = Boolean(req.runId && agent.id === chat.agentId && !req.agentAppMode && !scienceRecovery
    && !scienceCollectionCurrent && executionContext?.source !== "science"
    && !executionContext?.aliveScience && !effectObservationRun);
  // Agent instructions are stable; task-selected host context is transported per turn.
  let systemPrompt = effectivePromptFor(agent);
  const systemContextParts: DeclaredPromptPart[] = [mainHostSystemPart("agent-definition", "versioned-content",
    ["agent-instructions", "skill-package"], systemPrompt)];
  // ── 턴 컨텍스트 — 사용자 프롬프트에 따라 매 턴 달라지는 주입(메모리 캡슐·온톨로지·
  // MCP 자동선택·브리핑 게이트·Experience/Taste)은 시스템 프롬프트가 아니라 여기 모은다.
  // 시스템 프롬프트를 턴마다 바꾸면 CLI 세션 지문이 매번 달라져 대화 연속성이 전멸한다
  // (2026-07-16 사고: 매 턴 fingerprint_changed → 세션 폐기 → "이전 세션을 보면~").
  // 세션 지원 러너는 새 세션이면 시스템 프롬프트 뒤에 붙이고, resume 턴이면 사용자
  // 메시지 앞에 싣는다. 세션 미지원 러너에는 기존처럼 시스템 프롬프트에 합쳐 전달한다.
  const turnContextParts: string[] = [];
  // 세션 내내 같은 블록 — resume 턴에서 러너가 최근 보낸 것을 생략한다(runner.turnContextStable).
  const stableTurnContextParts: string[] = [];
  // Declared lifetime of each collector block, by its slot (docs/PROMPT-COMPOSITION-POLICY.md, ledger
  // desktop.main.turn-context.collector); the turn context is ordered by it at serialization (orderPromptParts).
  const turnContextDeclarations = new Map<number, PromptOrderingMetadata>();
  const declareLastTurnContext = (id: string, stability: PromptStability, changeTriggers: readonly PromptChangeTrigger[]): void => {
    turnContextDeclarations.set(turnContextParts.length - 1, { id, stability, changeTriggers });
  };
  /** The block just pushed stays the same for the session: resume turns drop it once acknowledged. */
  const keepLastTurnContext = (id: string, stability: PromptStability, changeTriggers: readonly PromptChangeTrigger[]): void => {
    const last = turnContextParts[turnContextParts.length - 1];
    stableTurnContextParts.push(last);
    declareLastTurnContext(id, stability, changeTriggers);
  };
  // Set when the Goal contract block carries the objective + criteria, so the checkpoint packet only references them.
  let goalContractInContext: { objective: string; criteria: readonly string[] } | null = null;
  // The typed goal_complete / goal_wait tools replaced the marker text on this run (set where the Goal turn context is built).
  let goalTypedToolsReplaceText = false;
  // The language rule lives once, in the system text (prompt-modules core.locale): a resumed Codex thread keeps its first
  // developer instructions and Claude re-reads the same system file every spawn, so a turn-context copy only repeated it.
  // Removed 2026-10-14 after a real-model A/B: Korean → English → Korean turns followed the user's language 3/3 on Codex
  // and 3/3 on Claude both with and without the copy. Stateless API/local turns send the system text every turn.
  if (req.oneMode && !req.agentAppMode) {
    // The owner's global AGENTS.md asks for "사용 스킬: …" openers; they do not belong in One.
    turnContextParts.push("display: no \"Skills used:\" / \"사용 스킬:\" openers; start with what the user needs");
    keepLastTurnContext("reply.display", "fixed-policy", ["release"]);
  }
  // Router/supervisor/firm/project/pool definitions: system text for a fresh request, kept turn context for a retained one.
  // Each definition is its own declared producer (ledger desktop.main.turn-context.collector).
  const placeHostContext = (id: string, changeTriggers: readonly PromptChangeTrigger[], block: string, parts: readonly DeclaredPromptPart[]): void => {
    if (persistentAgentContext) {
      // Retained context uses its existing exact blocks/ACK metadata; no new system trace is minted.
      turnContextParts.push(block); keepLastTurnContext(id, "versioned-content", changeTriggers);
    } else {
      systemContextParts.push(...parts);
    }
  };
  // One immutable project snapshot per execution boundary. All supported runner
  // adapters consume the same block through their existing context transport.
  // Projectless One executes in agentRunCwd(), not Electron's process cwd.
  // Bind instructions to that same producer workspace so the settled checkpoint
  // can carry the completed episode into its next scheduled cycle.
  const projectInstructions = req.runId
    ? recordInvocationInstructionSnapshot({ runId: req.runId, chatId: chat.id, projectDir: resolvedResultFolder })
    : compileProjectInstructionSnapshot({ projectDir: resolvedResultFolder });
  // An empty snapshot (no project instruction files) carries no information; a removal delta alone does not warrant one.
  if (projectInstructions.snapshot.sources.length > 0) {
    turnContextParts.push(renderInstructionSnapshot(projectInstructions.snapshot)); keepLastTurnContext("project.instructions", "versioned-content", ["project-instructions"]);
  }
  /*
   * 보고서로 낼지는 에이전트가 정한다(오너 지시 2026-08-24). 호스트는 글의
   * 모양을 보고 문서인지 추측하지 않는다 — 그건 판정자를 하나 더 세우는 일이고,
   * 같은 글이 그날 형식에 따라 문서가 되기도 안 되기도 한다. 대신 "이건
   * 보고서다" 라고 스스로 밝히는 표식 하나를 알려 준다.
   */
  if (req.oneMode && !req.agentAppMode) {
    turnContextParts.push("document: a document to keep (report, plan, proposal) starts with the lines `---`, `document: <title>`, `---`; never for short answers");
    // Same text every turn: a resumed native session already has it (runner dedupe, continuity.ts).
    keepLastTurnContext("reply.document", "fixed-policy", ["release"]);
  }
  /*
   * 차트·시각물·agentlas-ui 계약은 더 이상 턴 맥락에 넣지 않는다(오너 2026-10-12: 사용자 프롬프트
   * 단어장이 아니라 모델이 도구로 판단). 시스템 프롬프트의 한 줄 규칙이 read_ui_schema 호출을 지시하고,
   * 그 도구(agentlas-ui 내장 MCP)가 스키마와 차트·시각물 안내를 돌려준다.
   */
  // One output needs the exact contract even if this run cannot discover a reader.
  // In-process providers have lazy menus/unprobed tool capability; never rely on a nonexistent reader.
  if (oneTeamExecutionPolicy && (!mcpIncludedServers.some(row => row.catalogId === AGENTLAS_UI_CATALOG_ID)
    || RUNTIME_MCP_SUPPORT[active.kind]?.delivery === "in-process-loop")) {
    turnContextParts.push(SURFACE_PROTOCOL); keepLastTurnContext("surface.protocol.execution", "fixed-policy", ["release"]);
  }
  // An installed agent's entry file names its own docs by relative path; the run works in the owner's project.
  {
    const agentFolder = agentPromptFolder(agent.id);
    if (agentFolder) {
      const block = `agent folder: ${agentFolder} (your relative paths; deliver to the working folder)`;
      turnContextParts.push(block); keepLastTurnContext("agent.folder", "versioned-content", ["agent-instructions"]);
    }
  }
  // 표면 안내는 프롬프트가 아니라 이 턴의 맥락으로 들어간다.
  if (executionContext?.surfaceContext?.trim()) {
    turnContextParts.push(executionContext.surfaceContext.trim()); declareLastTurnContext("surface.state", "turn-context", ["task"]);
  }
  // One context remains Main-selected regardless of whether the chat is shown
  // in Desktop, on its paired Mobile remote, or in the paired Telegram channel.
  const approvedOneContext =
    (!workspaceBinding
      || workspaceBinding.source === "mobile-one"
      || workspaceBinding.source === "telegram-one")
    && !req.agentAppMode
      ? mainOneProfileContext(req)
      : "";
  // Persona and approved profile repeat verbatim; held reports change, and a changed block is always sent again.
  if (approvedOneContext) { turnContextParts.push(approvedOneContext); keepLastTurnContext("owner.definition", "versioned-content", ["owner-profile"]); }
  const approvedOneAttachmentContext = !workspaceBinding && !req.agentAppMode
    ? mainOneAttachmentContext(req)
    : "";
  if (approvedOneAttachmentContext) { turnContextParts.push(approvedOneAttachmentContext); declareLastTurnContext("attachments.one", "turn-context", ["attachments"]); }
  const approvedWorkAttachmentContext = mainWorkAttachmentContext(req, resolvedResultFolder);
  if (approvedWorkAttachmentContext) { turnContextParts.push(approvedWorkAttachmentContext); declareLastTurnContext("attachments.work", "turn-context", ["attachments"]); }
  if (autoRoute) {
    const routePreamble = autoRouteSystemPreamble(
      autoRoute,
      locale,
      isTargetAppEdit ? "app-edit" : req.appsGenerateMode ? "apps-generate" : "default",
    );
    placeHostContext("host.auto-route", ["agent-instructions", "task"], routePreamble,
      [mainHostSystemPart("auto-route", "task-context", ["agent-instructions", "task"], routePreamble)]);
  }
  const routerAgentPreamble = routerAgent
    ? buildRouterAgentSystemPreamble({
        routerAgent: routerAgent,
        userPrompt: req.userPrompt,
        effectiveUserPrompt,
        locale,
        selectedAgent: agent,
        autoRoute,
        borrowedAgents: req.borrowAgents,
      })
    : null;
  if (routerAgentPreamble) {
    placeHostContext("host.router", ["agent-instructions", "task"], routerAgentPreamble.preamble, routerAgentPreamble.parts);
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `Router Agent 에스컬레이션 적용: ${routerAgentPreamble.loadedModuleIds.join(", ") || "core"}`
          : `Router Agent escalation applied: ${routerAgentPreamble.loadedModuleIds.join(", ") || "core"}`,
    });
  }
  // ── 브리핑 인터뷰 게이트(smart 모드 전용) ─────────────────────────────
  // 모호한 실행형 요청이면 실행 전에 배치 질문(3-5)을 강제한다. 판단은 모델이 턴 안에서
  // 인라인으로 수행(추가 LLM 콜/지연 0). trivial 프롬프트는 주입 자체를 건너뛴다(하드 어서션:
  // 사소한 요청에 질문 0개). 기본 모드는 build-only라 챗에는 꺼져 있다.
  /* 브리핑 게이트 — 사소함 판정을 단어로 하지 않는다.
   *
   * 예전에는 이 주입 앞에 `isTrivialPrompt`가 서 있었다. 그 판정 전부는 "15자 미만",
   * "/ 나 @ 로 시작", "물음표로 끝나고 120자 미만"이었다. 실사용 558턴에서 같은 계열
   * 단어 신호의 재현율은 21.7%였고, "전체 검증해줘"(11자) 같은 무거운 요청이 사소함으로
   * 잘렸다. 토큰 몇 개를 아끼려고 누구에게 물을지를 글자 수로 정한 셈이다.
   *
   * 판정은 이미 아래 지시문 안에 있다 — 모델이 조용히 판단하고, 분명하면 아무것도 묻지
   * 않는다. 그러니 앞단에 두 번째 판정자를 세울 이유가 없다. 이제 모드가 켜져 있으면
   * 언제나 주입하고, 유일한 판정자는 모델이다.
   *
   * 판단 차원은 Build 인터뷰(agentlas_cloud/interview/scorer.py)와 같은 것으로 맞춘다:
   * 목표·제약·완료기준. 두 표면이 같은 것을 보고 판정해야 사용자가 같은 기준을 만난다. */
  if (
    !req.agentAppMode &&
    executionContext?.source !== "science" &&
    getInterviewMode() === "smart" &&
    chat.kind !== "division" &&
    // "ask once" is an ask instruction; an unattended run has nobody to answer it (its final boundary forbids asking).
    !unattendedNoAsk
  ) {
    // No question/option counts here: the host parser decides (extractAskFences, shared/ask-fence-flatten.ts:28-29,98-100:
    // at most 64 questions per reply, 2-8 options each, unfilled templates dropped). Prose counts only contradicted ASK_PROTOCOL.
    turnContextParts.push(
      "briefing: judge silently whether goal, constraints and done-criterion are clear; clear (or a greeting/question) → ask nothing; an unclear execution request → ask once about the weakest (anti-scope, smallest version, done signal, audience), then stop; after answers restate the goal in one sentence and proceed, open points as assumptions",
    );
    keepLastTurnContext("briefing.contract", "fixed-policy", ["release"]);
  }
  if (invocationProjectId) {
    const project = getProject(invocationProjectId);
    if (project?.systemPrompt) {
      const projectDefinition = `${tStatus(locale, "projectContext", {
        name: project.name,
      })}\n${project.systemPrompt}`;
      placeHostContext("host.project", ["project-instructions"], projectDefinition,
        [mainHostSystemPart("project", "versioned-content", ["project-instructions", "locale"], projectDefinition)]);
    }
    if (project?.agentPool.length) {
      const userFacingPool = project.agentPool.filter((member) => {
        if (member.entityKind === "team" || !member.agentId) return true;
        const installed = getAgentById(member.agentId);
        // Background HQ cells are implementation details of their controller,
        // not independently callable project members.
        return !installed || (
          installed.visibility !== "background"
          && installed.visibility !== "private"
          && installed.systemPrompt.trim().length > 0
        );
      });
      const pool = userFacingPool.map((member) => {
        const installed = member.entityKind === "agent" && member.agentId ? getAgentById(member.agentId) : null;
        const firm = member.entityKind === "team" && member.firmId ? getFirm(member.firmId) : null;
        const label = installed?.name || firm?.name || member.nameSnapshot;
        // 원격 행은 표시 이름과 불투명한 revision 토큰만 적혀 있어, 오케스트레이터가 부를
        // 정확한 이름(slug)을 짐작하거나 Workforce 검색으로 다시 찾아야 했다 — 모델이 운 좋게
        // "cloud:growth-hacker" 를 맞히면 돌고, 못 맞히면 정확한 식별자를 못 받아 실패했다.
        // 저장된 targetId 가 곧 소스 안의 식별자이므로 그대로 호출 핸들로 준다.
        const remoteHandle = !installed && !firm && (member.source === "cloud" || member.source === "hub")
          && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(member.targetId) && !/^agd_/i.test(member.targetId)
          ? `${member.source}:${member.targetId}`
          : null;
        return remoteHandle
          ? `- ${label} [${member.entityKind}; ${member.source}; call handle ${remoteHandle}; saved revision ${member.releaseId ?? "latest"}]`
          : `- ${label} [${member.entityKind}; ${member.source}; ${member.releaseId ?? "local"}]`;
      }).join("\n");
      if (pool) {
        // A call handle is the source's own identifier (measured 2026-09-26: guessed slugs failed). A successful call may
        // report agd_/agr_ ids and "hub:<slug>" even for the owner's Cloud agent; that is not a substitute release.
        const poolRoster = `project tools (unordered, reusable; you decompose, staff, run and verify):\n${pool}\n`;
        const poolPolicy = "pool: a call handle → hephaestus_call with that exact handle (agd_/agr_/hub: ids in its result are normal, not a substitute); " +
          "a real gap → recruit the minimum role via Workforce (Local + Cloud + Hub), scoped to that work order, never into the saved team; never ask the user to type @";
        const poolContext = poolRoster + poolPolicy;
        placeHostContext("host.project-pool", ["agent-instructions"], poolContext, [
          mainHostSystemPart("project-pool.policy", "fixed-policy", ["release"], poolPolicy),
          mainHostSystemPart("project-pool.roster", "versioned-content", ["agent-instructions", "capability-inventory"], poolRoster),
        ]);
      }
    }
  }
  // 회사 채팅이면 firm 정보를 system prompt에 주입 — CEO가 자기 회사를 알 수 있게
  if (chat.firmId) {
    const firm = getFirm(chat.firmId);
    if (firm) {
      const roster = firm.orgChart
        .map(
          (n) =>
            `  - ${n.role}: ${n.agentSlug}${
              n.reportsTo ? ` ${tStatus(locale, "firmReportSuffix", { to: n.reportsTo })}` : ""
            }`,
        )
        .join("\n");
      const firmIdentity = tStatus(locale, "firmContext", { name: firm.name });
      const firmRole = tStatus(locale, "firmCeoGuide");
      const firmRoster = `${tStatus(locale, "firmOrgChart")}\n${roster}`;
      const firmDelegation = tStatus(locale, "firmDelegateNote");
      const firmContext = `${firmIdentity}\n${firmRole}\n${firmRoster}\n${firmDelegation}`;
      placeHostContext("host.firm", ["agent-instructions"], firmContext, [
        mainHostSystemPart("firm.identity", "versioned-content", ["agent-instructions", "locale"], firmIdentity),
        mainHostSystemPart("firm.roster", "versioned-content", ["agent-instructions", "locale"], firmRoster),
        mainHostSystemPart("firm.role", "configuration", ["release", "locale"], firmRole),
        mainHostSystemPart("firm.delegation", "configuration", ["release", "locale"], firmDelegation),
      ]);
    }
  }

  // ── Agentlas 아키텍처: 메모리 주입 + 항상-켜진 큐레이터 ──────────────
  // 워킹 폴더에서 반복 작업하면 그 폴더가 활성화되고, 그때부터 프로젝트 메모리(.agentlas)를
  // 시스템 프롬프트에 주입한다. 폴더가 없거나 아직 활성 전이면 전역 메모리를 주입.
  // 채팅별 폴더가 없으면 프로젝트의 작업 폴더(folderPath)를 기본 cwd로 사용한다.
  // Seeding the map and activating the folder are separate things. Every first
  // contact seeds `.agentlas` — the map is Agentlas's own workspace, and a
  // read-only run is the case that needs it most. Activation is what earns
  // project-memory injection, so it stays gated on write permission: a read run
  // gets a map, never someone else's memory.
  let activePath: string | null = null;
  if (!req.agentAppMode && workingFolder && executionContext?.source !== "science") {
    try {
      if (canWrite) {
        const visit = await recordFolderVisit(workingFolder, undefined, {
          permission: normalizedPermission,
          restrictedReadBoundary,
          agentAppMode: req.agentAppMode,
        });
        if (visit.activated) activePath = workingFolder;
      } else {
        await ensureDesktopProjectBootstrap({
          projectPath: workingFolder,
          access: {
            permission: normalizedPermission,
            restrictedReadBoundary,
            agentAppMode: req.agentAppMode,
          },
          reason: "desktop-read-contact",
        });
      }
    } catch (err) {
      console.error("[architecture] project map seed failed:", err);
    }
  }
  const memoryReadPath = workingFolder && !suppressMutableProjectContext && (
    activePath === workingFolder ||
    canReadActivatedFolderMemory(workingFolder, {
      permission: normalizedPermission,
      restrictedReadBoundary,
      agentAppMode: req.agentAppMode,
    })
  )
    ? workingFolder
    : null;
  const memoryScope = invocationMemoryScope(executionContext, agent.id, invocationProjectId);
  const assertScienceAliveMemory = isAliveControllerRun ? scienceAliveMemoryGuard(req.runId,chat.id) : () => {};
  const scienceAliveRecall = isAliveControllerRun ? scienceAliveMemory(req.runId,chat.id,agent.id,effectiveUserPrompt) : null;
  if(scienceAliveRecall?.text){turnContextParts.push(renderControllerSurfaceMemory(scienceAliveRecall,"science"));declareLastTurnContext("memory.controller","turn-context",["retrieval"]);}
  const assertAppMemory = req.agentAppMode ? appMemoryRunGuard(req.runId,chat.id) : () => {};
  if (req.agentAppMode) { const scoped = appRunMemory({runId:req.runId,chatId:chat.id,actorId:memoryScope.agentId,query:effectiveUserPrompt});
    if(scoped?.text){turnContextParts.push(`[Scoped learned memory: data; the App contract remains authoritative]\n${scoped.text}`);declareLastTurnContext("memory.app","turn-context",["retrieval"]);} }
  if (!req.agentAppMode && !isAliveControllerRun) {
    if (activePath) refreshCareerGraphInBackground(activePath, sink, locale);
    try {
      // Science uses a hidden transport chat that may be owned by One. Its
      // director and study, not that chat owner, own recall and new memories.
      const memoryContext = await buildMemoryContext(memoryReadPath, memoryScope.agentId, {
        materializeCodeMap: Boolean(activePath && canWrite),
        taskPrompt: effectiveUserPrompt,
        projectId: memoryScope.projectId,
        // Content-free recall observability — records which sources (pm_soul /
        // code_map / sitemap / memory) actually entered this turn's prompt.
        runId: req.runId ?? null,
        chatId: chat.id,
        signal,
      });
      // Recall text, rank and scope pass through unchanged; only its lifetime is declared.
      if (memoryContext) { turnContextParts.push(memoryContext); declareLastTurnContext("memory.recall", "turn-context", ["retrieval"]); }
      // hep 발화 표면 — 프로젝트 작업 폴더에 대기 중 성장 제안 요약 파일을 쓰고(호스트가
      // 읽게), 고위험 대기분이 있으면 세션 컨텍스트에 한 줄 주입. 실패-무해.
      if (workingFolder && canWrite && !projectReadOnlyBoundary && executionContext?.source !== "science") {
        try {
          const growth = writeEvolutionProposalsForProject(workingFolder);
          const line = evolutionSessionContextLine(growth.pending, locale === "ko" ? "ko" : "en");
          if (line) { turnContextParts.push(line); declareLastTurnContext("evolution.pending", "turn-context", ["agent-instructions"]); }
        } catch (err) {
          console.warn("[evolution-hep] proposals file/context deferred:", err);
        }
      }
      if (memoryReadPath) {
        // A writable turn's query also refreshes the folder's DB in the background for the next turn (it never waits for
        // it); both end with this turn's Stop.
        const ontologyContext = await queryWorkingFolderOntologyContext(memoryReadPath, effectiveUserPrompt, {
          readOnly: projectReadOnlyBoundary,
          ...(signal ? { signal } : {}),
        });
        if (ontologyContext.used) { turnContextParts.push(ontologyContext.context); declareLastTurnContext("memory.ontology", "turn-context", ["retrieval"]); }
      }
    } catch (err) {
      console.error("[architecture] buildMemoryContext failed:", err);
    }
    throwIfInvocationAborted(signal, locale);
  }
  // Compact core is always on; the full schema is loaded only for explicit
  // memory tasks. This keeps the recurring contract under ~150 tokens.
  // Every runtime writes the one-line turn_summary receipt itself (owner 2026-10-13: the host's 360-char cut of the answer is
  // not a summary); the contract is the 285-byte block, the same on every path.
  if (!req.agentAppMode && !isAliveControllerRun && !restrictedReadBoundary && executionContext?.source !== "science") {
    turnContextParts.push(memoryEmitterPromptFor(effectiveUserPrompt, pickLocale(req))); keepLastTurnContext("memory.receipt", "fixed-policy", ["release"]);
  }
  if (mcpAutoSelectionPrompt) { turnContextParts.push(mcpAutoSelectionPrompt); declareLastTurnContext("tools.selection", "turn-context", ["tool-grant", "capability-inventory"]); }
  if (!req.agentAppMode && !isAliveControllerRun && chat.kind === "division" && (req.toolMode || req.hubMode)) {
    const supervisor = assembleSystemPrompt(
      AUTOMATION_SUPERVISOR_SYSTEM_AGENT,
      [effectiveUserPrompt, req.toolMode ?? "", req.hubMode ?? ""].join("\n"),
      { threshold: 0.6, maxModules: 3 },
    );
    placeHostContext("host.automation-supervisor", ["agent-instructions", "task"], supervisor.systemPrompt,
      supervisor.parts.map(part => mainHostSystemPart(`automation-supervisor.${part.id}`, "fixed-policy", ["release"], part.text)));
    sink({
      kind: "tool-use",
      status:
        locale === "ko"
          ? `Automation Supervisor 적용: ${supervisor.loadedModuleIds.join(", ") || "core"}`
          : `Automation Supervisor applied: ${supervisor.loadedModuleIds.join(", ") || "core"}`,
    });
  }
  // Stormbreaker Loop — 이제 무조건 주입이 아니라 명시적 개입 조건에서만 켠다(대시보드 토글 기본 OFF).
  // 항상 켜지는 경로: division(백그라운드 자동화 인프라), continuousMode(계속 라이브), 명시 프리픽스
  // (`stormbreaker …` / `hep-network --stormbreaker …` = 컴포저 칩·추천 pipeline 선택).
  if (stormbreakerEngaged) {
    let coreHarness: Awaited<ReturnType<typeof stormbreakerHarness>>;
    try {
      coreHarness = await loadCoreStormbreakerHarness();
    } catch (err) {
      sink({
        kind: "error",
        error: {
          code: "stormbreaker-core-harness-unavailable",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return earlyResult();
    }
    // division(무인 시드)은 기존처럼 시스템 프롬프트에. 인터랙티브 채팅은 engaged가 턴 단위
    // 상태이므로 턴 컨텍스트로 — resume 세션에서도 이번 턴에 확실히 전달된다.
    if (chat.kind === "division") {
      placeHostContext("host.stormbreaker", ["release", "task"], `${coreHarness.system_prompt}\n\n${STORMBREAKER_LOOP_PROTOCOL}`, [
        mainHostSystemPart("stormbreaker.core", "fixed-policy", ["release"], coreHarness.system_prompt),
        mainHostSystemPart("stormbreaker.continuation", "fixed-policy", ["release"], STORMBREAKER_LOOP_PROTOCOL),
      ]);
    } else {
      turnContextParts.push(`${coreHarness.system_prompt}\n\n${STORMBREAKER_LOOP_PROTOCOL}`); keepLastTurnContext("stormbreaker.definition", "versioned-content", ["release", "task"]);
    }
  }
  if (!req.agentAppMode && executionContext?.source !== "automation" && (chat.kind !== "division" || req.automationId)) {
    const officeContext = officeTaskContextForInvocation(chat.id);
    if (officeContext) {
      turnContextParts.push(officeContext); declareLastTurnContext("office.assignment", "task-context", ["task"]);
    }
    const lifecycleContext = mcpIncludedServers.some(server => server.catalogId === "one-team") && !mcpToolchainConsumer
      ? null : automationLifecycleContext(chat.id, req.automationId);
    if (lifecycleContext) {
      turnContextParts.push(lifecycleContext); declareLastTurnContext("automation.state", "turn-context", ["task"]);
    }
  }
  // 사용자 채팅에서만 자동화 생성 protocol 주입 (백그라운드 automation 실행 세션은 제외 → 재귀 방지)
  if (chat.kind !== "division" && canWrite) {
    // 2026-08-20: 단어장 게이트(isAutomationSetupRequest — ko/en AND 매칭) 제거.
    // 제3언어 자동화 요청은 그 게이트에 영구 미도달이었다. write 권한의 사용자 턴에는
    // 계약을 턴 컨텍스트로 무조건 전달한다 — read 권한으로 시작해 protocol 없이
    // 생성된 resume 세션에서도 계약이 이번 턴에 도달하고, 이 턴이 자동화 요청인지는
    // 모델이 스스로 판단해 ## Automation 블록을 낼지 결정한다. 단어장 판정은 없다.
    // Fresh/sessionless requests already merge this into the system prompt;
    // resumed sessions receive it with their turn. Do not inject it twice.
    if (executionContext?.source !== "science") {
      const automationProtocol = automationProtocolFor(mcpIncludedServers.some(server => server.catalogId === "one-team"), mcpToolchainConsumer);
      turnContextParts.push(automationProtocol); keepLastTurnContext("automation.contract", "configuration", ["capability-inventory"]);
    }
  }
  // One 실행 경계의 태스크 Surface 레시피 — 선택은 판정기(LLM) 경유. 경계 블록 조립은
  // 동기라 캐시 peek만 가능했으므로, 여기(비동기)에서 판정을 확정해 같은 턴의 턴
  // 컨텍스트로 전달한다. 판정 불가/none이면 중립(레시피 없음) — 단어장 폴백 없음.
  if (oneTeamExecutionPolicy && !oneTaskSurfaceRecipe(req.userPrompt, locale === "ko")) {
    const judgedTaskSurfaceRecipe = await resolveOneTaskSurfaceRecipe(
      req.userPrompt,
      locale === "ko",
      signal,
    );
    if (judgedTaskSurfaceRecipe) { turnContextParts.push(judgedTaskSurfaceRecipe); declareLastTurnContext("surface.recipe", "task-context", ["task"]); }
  }
  // 일반 무인 실행은 질문을 받을 사람이 없다. Alive의 질문은 별도 작업공간 도구로
  // 연결되어야 하므로 이 Work 지침을 상속하지 않는다. ASK_PROTOCOL보다 뒤에 오는 최종
  // 지침으로 질문 fence를 금지하고, 안전한 기본값이 없으면 "NEEDS-INPUT:"으로 명시적 실패를
  // 유도한다. automation-result.ts 분류기가 이 계약을 짝으로 감지한다(조용한 가짜 성공 방지).
  if (unattendedNoAsk) {
    // An authority boundary closes the turn context on every turn (final-boundary, never deduped as a kept block): the
    // run's own question channel decides what the model may emit after everything above (native-harness notyet NH03).
    turnContextParts.push(UNATTENDED_NO_ASK_DIRECTIVE); declareLastTurnContext("ask.unattended", "final-boundary", ["profile"]);
  } else if (usesMobileDurableDecision(executionContext)) {
    turnContextParts.push(MOBILE_DURABLE_ASK_DIRECTIVE); declareLastTurnContext("ask.mobile", "final-boundary", ["profile"]);
  }
  // Attended runs need no turn-context ask line: the system `ask:` module already says call ask_form (or ask_user),
  // else the <<agentlas-ask>> block (2026-10-14: the two lines said the same thing twice).

  // 사용자 메시지 영구화 + 첫 메시지면 제목 자동 생성
  persistUserMessage();

  sink({ kind: "thinking", status: tStatus(locale, "thinking", { agent: agent.name }) });
  // Stormbreaker 슈퍼바이저 — 활성·가용하면 이 실행을 scope→route→gate 로 감독한다(비차단).
  // division(백그라운드 firm 하위) 세션은 제외(재귀/노이즈 방지). 실패/부재 시 null → no-op.
  let stormbreaker: StormbreakerHandle | null = null;
  if (chat.kind !== "division" && stormbreakerEngaged) {
    stormbreaker = superviseStormbreaker({
      query: req.userPrompt,
      cwd: resolvedResultFolder,
      emit: (tool) => sink({ kind: "tool-use", tool }),
      signal,
    });
  }

  // Main-authored before model execution. The renderer/model never controls
  // Memory Ticket identity, so success/error/cancel handling converges.
  const memoryTurnId = `chat:${chat.id}:run:${req.runId ?? randomUUID()}:node:${executionContext?.nodeId ?? "root"}`;
  try {
    const runtimeUserPrompt = explicitBorrowUserPreamble
      ? borrowedCurrentUserPrompt(effectiveUserPromptParts, explicitBorrowUserParts)
      : effectiveUserPrompt;
    // ── persistent goal contract ─────────────────────────────────
    // Goal definition and steering are different authorities. The first
    // explicit Goal request creates the contract; every later message is only
    // execution guidance and therefore cannot upsert the objective.
    let activeGoalId: string | null = null;
    let activeGoal: GoalLedgerSnapshot | null = null;
    let activeGoalRevision: number | null = null;
    let goalPlanContextSlot: { index: number; goalId: string; revision: number; reservedDecisionIds: Set<string> | null } | null = null;
    if (!scienceRecovery && !req.agentAppMode && chat.kind !== "division" && !effectObservationRun) {
      activeGoalId = getChatGoalId(chat.id);
      if (!activeGoalId && req.goalMode && canWrite) {
        activeGoalId = freshGoalIdForChat(durableWorkforceGoalId, chat.id);
        try {
          setChatGoalBinding(chat.id, activeGoalId);
        } catch {
          activeGoalId = null;
        }
      }
      if (activeGoalId) {
        // Capture the admitted revision before the first ledger/model await.
        // A later revision or owner stop cannot authorize this turn's factory.
        const admittedRevision = getChatGoalRevision(activeGoalId);
        activeGoalRevision = admittedRevision?.chatId === chat.id ? admittedRevision.revision : null;
        activeGoal = await getGoalLedgerGoal(activeGoalId, workforceProjectDir);
        // A missing/terminal ledger means this is the first turn of a newly
        // enabled Goal campaign. An already-active ledger is immutable even
        // when this request arrived through steering.
        if (
          req.goalMode
          && !promptIsSystemAuthored
          && (!activeGoal || activeGoal.status !== "active")
        ) {
          const objective = ownerVisiblePrompt(req).replace(/\s+/g, " ").trim();
          if (objective) {
            await ensureGoalLedgerGoal({
              goalId: activeGoalId,
              objective,
              acceptanceCriteria: deriveGoalAcceptanceCriteria(objective, locale,
                req.permissions === "read" || req.permissions === "write" || req.permissions === "full" ? req.permissions : undefined),
              projectDir: workforceProjectDir,
            });
            activeGoal = await getGoalLedgerGoal(activeGoalId, workforceProjectDir);
          }
        }
        if (activeGoal?.status === "active") {
          // Goals stored before the objective came from ownerVisiblePrompt carry the standing-staff block; show the owner's goal only.
          activeGoal = { ...activeGoal, objective: stripStaffGuidance(activeGoal.objective), acceptanceCriteria: activeGoal.acceptanceCriteria.map(stripStaffGuidance) };
          goalContractInContext = { objective: activeGoal.objective, criteria: activeGoal.acceptanceCriteria };
          turnContextParts.push(persistentGoalTurnContext(activeGoal, locale, !latestTaskCheckpoint(activeGoalId))); keepLastTurnContext("goal.contract", "task-context", ["goal-revision"]);
          // A room teammate gets the contract (what is wanted) but not the controller machinery: the completion/wait
          // protocols, the plan-shape judgement and the tactic grammar are One's and the orchestrator's. Since 2026-10-01
          // no teammate or installed agent emitted a plan marker (1,941 + 607 tactic_status from the orchestrator and One).
          if (!roomMemberTurn) {
          // 계약을 주면서 그 계약을 끝내는 법도 같이 준다. 연속 프롬프트에만 적으면
          // 1패스에 끝나는 작업이 마커를 몰라서 못 끝난다.
          const goalToolsReplaceText = turnGoalToolsOffered && turnToolReplacesText(active.kind, mcpIncludedServers);
          goalTypedToolsReplaceText = goalToolsReplaceText;
          const typedGoalText = goalToolsReplaceText ? typedGoalLifecycleProtocol(getChatGoalRevision(activeGoalId)?.lifecycle) : null;
          if (typedGoalText) { turnContextParts.push(typedGoalText); keepLastTurnContext("goal.lifecycle.typed", "configuration", ["tool-grant", "goal-revision"]); }
          if (!goalToolsReplaceText) { turnContextParts.push(goalCompletionProtocol(locale, getChatGoalRevision(activeGoalId)?.lifecycle)); keepLastTurnContext("goal.lifecycle.text", "configuration", ["goal-revision"]); }
          if (!executionContext && !goalToolsReplaceText) { turnContextParts.push(goalWaitProtocol((() => { try { return getLegacyGoalLifecycleSnapshot(activeGoalId) ? null : getChatGoalRevision(activeGoalId)?.lifecycle; } catch { return null; } })())); keepLastTurnContext("goal.wait", "configuration", ["goal-revision"]); }
          /*
           * 골 구조 판단(오너 최우선 2026-09-24): 이 목표 개정의 모양(단일 전술/전술 목록/대계-전략-전술 트리)이
           * 없으면 이 턴을 시작하기 전에 정한다. 실패는 단일 전술 폴백 — 목표를 막지 않는다. 턴마다 바뀌는 절이라
           * 세션 재사용 문맥(stable)에는 넣지 않는다.
           */
          const goalPlan = await ensureGoalShapeBeforeTurn({ goalId: activeGoalId, objective: activeGoal.objective, signal,
            runtimeSelection: confirmedRuntime, locale,
            onJudging: () => sink({ kind: "tool-use", status: locale === "ko" ? "목표의 계획 구조를 먼저 정하는 중…" : "Deciding the goal's plan shape first…" }),
          }).catch((error: unknown) => { console.warn("[goal-plan] shape decision failed:", error instanceof Error ? error.message : error); return null; });
          if (goalPlan) {
            // Keep the initial dispatch/review bookkeeping exactly once. The
            // typed slot is refreshed without rewriting unrelated owner text.
            const reservedDecisionIds = new Set<string>();
            goalPlanContextSlot = { index: turnContextParts.length, goalId: activeGoalId,
              revision: activeGoalRevision ?? goalPlan.revision, reservedDecisionIds };
            turnContextParts.push(buildGoalPlanTurnContext(goalPlan, { runId: req.runId ?? null, locale, typedTools: goalToolsReplaceText,
              onDecisionRecorded: (id) => { reservedDecisionIds.add(id); } }));
            // Measured 1.3.24: the 6,190-char plan was byte-identical on consecutive turns and resent each time.
            // A refreshed slot no longer matches this copy, so a changed plan is still delivered.
            keepLastTurnContext("goal.plan", "task-context", ["goal-revision", "plan-revision"]);
          }
          // A finite Goal with a deadline may wait for its next cycle up to that deadline (goal-deadline.ts).
          if (!executionContext && getChatGoalRevision(activeGoalId)?.lifecycle === "finite") {
            const deadlineAt = goalDeadlineAt(activeGoalId);
            if (deadlineAt && Date.parse(deadlineAt) > Date.now()) { turnContextParts.push(goalToolsReplaceText ? typedGoalDeadlineClause(deadlineAt) : goalDeadlineWaitClause(deadlineAt)); declareLastTurnContext("goal.deadline", "task-context", ["goal-revision"]); }
          }
          }
        }
      }
    }
    // 세션 지원 러너(claude-code/codex/kimi)는 턴 컨텍스트를 분리 전달해 러너가
    // 새 세션/resume에 맞게 배치한다. 그 외 stateless 러너는 기존처럼 시스템 프롬프트에 합친다.
    // Composition order (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.main.turn-context.collector): every block carries
    // its declared lifetime; serialization orders fixed → versioned → configuration → task → turn → final boundary (stable
    // within a tier), so unchanged blocks stay a byte-identical prefix. Runners drop acknowledged kept blocks wherever they sit.
    // Every producer declares its slot; an undeclared one is a host defect and the turn is refused, never sorted by guess
    // (native-harness notyet NH02).
    const declaredTurnContext = (parts: readonly string[]): Array<PromptOrderingMetadata & { text: string }> =>
      parts.flatMap((text, index) => {
        if (!text || !text.trim()) return [];
        const declared = turnContextDeclarations.get(index);
        if (!declared) throw new Error(`prompt-context-undeclared-slot:${index}`);
        return [{ ...declared, text }];
      });
    const hostSystemComposition = persistentAgentContext ? null : composeMainHostSystemPrompt(systemContextParts);
    if (hostSystemComposition) systemPrompt = hostSystemComposition.text;
    const turnContext = orderPromptParts(declaredTurnContext(turnContextParts)).map((part) => part.text).join("\n\n");
    const frozenTurnContextParts = [...turnContextParts];
    // A settled Goal checkpoint is the authoritative handoff packet. When no
    // valid checkpoint exists yet (for example on the first or a failed Goal
    // turn), preserve the bounded frozen transcript so a fresh model session
    // does not lose the only conversational context available to it.
    const goalCheckpoint = activeGoalId ? latestTaskCheckpoint(activeGoalId) : null;
    const canonicalWorkPacket=canonicalWorkRecovery?.packet();
    const sessionCapableRuntime =
      active.kind === "claude-code" || active.kind === "codex" || active.kind === "kimi" || active.kind === "antigravity";
    const runnerReq = {
      beforeMcpToolResult,
      ...(canonicalWorkRecovery ? { canonicalWorkRecovery } : {}),
      ...(executionContext?.source === "science" ? { sciencePromptProfile: true as const } : {}),
      systemPrompt: sessionCapableRuntime || persistentAgentContext || !turnContext
        ? `${systemPrompt}${canonicalWorkPacket ? `\n\n${canonicalWorkPacket}` : ""}`
        : `${systemPrompt}\n\n${turnContext}${canonicalWorkPacket ? `\n\n${canonicalWorkPacket}` : ""}`,
      ...((sessionCapableRuntime || persistentAgentContext) && turnContext ? { turnContext } : {}),
      // Long-run state comes from the versioned goal and checkpoint. Replaying
      // the whole chat into a fresh native session is neither recovery nor state.
      // The no-checkpoint fallback above is intentionally bounded and only
      // covers the period before a Goal checkpoint can carry that state.
      history: scienceCollectionCurrent || isAliveControllerRun || (activeGoalId && goalCheckpoint) ? [] : history,
      // A Main-issued effect observation is one look, not a turn of this conversation. Resuming the
      // chat's native session carried its whole accumulated context into every look (measured
      // 2026-09-24: 79k-500k input tokens per observation, growing with each retry). Its own isolated
      // session owner starts fresh and never replaces the conversation's stored session.
      ...(effectObservationRun && req.runId ? { runtimeSessionOwnerId: `effect-observation:${req.runId}` } : {}),
      // Alive decisions continue this controller's context. Work/run identity
      // stays in the existing effect/Goal ledgers, separate from native session identity.
      ...(isAliveControllerRun ? { runtimeSessionOwnerId: `alive-controller:${chat.id}:${agent.id}` } : {}),
      // A checkpoint successor is seeded from host-owned neutral state. Its
      // native owner is assigned only after the exact checkpoint is validated
      // for the selected runtime below.
      userPrompt: runtimeUserPrompt,
      surfaceUserPrompt: req.oneUserAuthoredPrompt ?? req.userPrompt,
      images: req.images,
      backendLabel: picked.label,
      ...(scienceCollectionCapability ? { scienceCollectionCapability, unattended: true as const, noSynchronousAsk: true as const } : {}),
      model: active.model ?? undefined,
      runtimeSource: active.source ?? undefined,
      ...(isAliveControllerRun ? { outputSchema: { name: "agentlas_alive_decision_v2", schema: ALIVE_DECISION_OUTPUT_SCHEMA } } : {}),
      longContext: active.longContextEnabled ?? false,
      effort: req.oneMode && req.fastMode === true && active.kind === "codex"
        ? effortForSelectedModel(active, active.model, "minimal") ?? undefined
        : active.effort ?? undefined,
      signal,
      // Antigravity cannot approve an MCP call in headless read mode. Preserve
      // the user's selected runtime and open its ordinary write+sandbox tool
      // mode for this trusted, Main-authorized review invocation. Other
      // runtimes keep the review's original read permission.
      permission: scienceReview && active.kind === "antigravity" ? "write" : req.permissions,
      ...(planReadOnly ? { planMode: true as const } : {}),
      ...(req.simulation === true ? { simulation: true as const } : {}),
      ...(browserOnly ? { browserOnly: true as const } : {}),
      // Only an explicit Computer Use selection lets an unattended run reach a
      // runtime's own desktop-control plugins (codex-desktop-surface.ts).
      ...(req.toolMode === "computer-use" ? { desktopControlGrant: true as const } : {}),
      ...(restrictedReadBoundary ? { restrictedReadBoundary: true as const } : {}),
      ...(isUnattendedExecution(executionContext) ? { unattended: true as const } : {}),
      ...(unattendedNoAsk ? { unattendedNoAsk: true as const } : {}),
      ...(usesMobileDurableDecision(executionContext) ? { noSynchronousAsk: true as const } : {}),
      // 세션 지문 시드 — 인터랙티브 채팅은 모델·effort·권한·턴별 주입이 바뀌어도
      // 같은 CLI 세션을 이어간다. 단, 명시적으로 바꾼 UI 언어는 시스템 프롬프트를
      // 다시 심어야 하므로 세션 정체성에 포함한다. 그렇지 않으면 resume이 첫 턴의
      // 한국어 지시를 계속 유지해 영어 One 화면에서 한국어 답변을 내보낸다.
      ...(req.agentAppMode
        ? {}
        : {
            sessionFingerprintSeed: JSON.stringify(
              isUnattendedExecution(executionContext)
                ? executionContext?.source === "alive"
                  ? {
                    v: "agentlas.alive-session-seed.v1",
                    chatId: chat.id,
                    agentId: agent.id,
                    locale,
                  }
                  : {
                    agentId: agent.id,
                    agentSystemPrompt: agent.systemPrompt,
                    permission: req.permissions,
                    runtime: req.runtimeSelection ?? {
                      kind: active.kind,
                      backend: active.backend,
                      model: active.model,
                      effort: active.effort,
                    },
                    toolMode: req.toolMode,
                    hubMode: req.hubMode,
                  }
                : {
                    /*
                     * Only things that are stable for the whole conversation belong here.
                     *
                     * `mcpIsolation` was in this seed, and it flips the moment a turn happens to
                     * need the browser tool. So a conversation that used the browser once and then
                     * went back to ordinary work changed its own session identity mid-thread, and
                     * the runtime session was silently dropped -- the transcript still looked
                     * continuous, because the last 80 messages are replayed every turn, while
                     * everything the CLI actually held (what it read, what its tools returned, the
                     * plan it was working from) was gone. Which MCP config a turn uses is a command
                     * line argument, not an identity.
                     */
                    v: "agentlas.chat-session-seed.v3",
                    chatId: chat.id,
                    agentId: agent.id,
                    locale,
                    executionMode: oneTeamExecutionPolicy ? "one-task-surface-v1" : "conversation",
                  },
            ),
          }),
      // 세션 resume 키 — CLI 러너가 (chatId, kind)별 세션을 재사용해
      // 시스템 프롬프트/히스토리를 매 턴 재전송하지 않게 한다.
      chatId: req.agentAppMode ? `site-agent-app:${req.runId ?? randomUUID()}` : chat.id,
      // Work project admission is a separate Main-owned partition. Keep the
      // visible chat id above as the session/transcript identity.
      workProjectId: chat.originSurface === "work" && invocationProjectId ? invocationProjectId : null,
      // 도구 승인의 에이전트 스코프 규칙 대상 — 누가 이 도구를 부르는지.
      agentId: agent.id,
      mcpConfigPath,
      ...(isolatedMcpConfig ? { isolatedMcpConfig: true as const } : {}),
      ...(ephemeralToolGrant ? { ephemeralToolGrant: true as const } : {}),
      ...(executionContext?.source === "science" && !scienceReview ? { scienceController: true as const } : {}),
      // Science / Alive-Science grants are the whole catalog; a generic One/Work config is not.
      ...(mcpConfigPath && (executionContext?.source === "science" || scienceReview
        || (isAliveControllerRun && executionContext?.aliveScience))
        ? { mcpGrantCatalogOnly: true as const } : {}),
      mcpAllowedTools,
      mcpCodexConfigArgs,
      // C38 — 관문을 실제로 건 것은 **이 경로**뿐이다. 관문 파일이 여기 실리는 순간에만
      // 등급이 "강제됨"으로 남는다(아래 brokerInstalled). 다른 실행 경로에서 등급만 들고
      // 다니면, 막지 않은 실행에 막았다는 라벨이 붙는다.
      ...(toolBroker?.settingsPath ? { toolBrokerSettingsPath: toolBroker.settingsPath } : {}),
      // grok 은 같은 훅 스크립트를 자기 플러그인 디렉터리로 받는다(claude --settings 와 같은 자리).
      ...(toolBroker?.pluginDirPath ? { toolBrokerPluginDir: toolBroker.pluginDirPath } : {}),
      env: runnerEnv.env,
      // ★오너 결정 2026-08-20 — Site 도 도구를 전부 쓴다. 예전에는 agentAppMode 가
      // 곧 "내장 도구 0개"(--tools "")였다. 이제 도구는 배선되고, 무엇이 실제로
      // 실행되는지는 행동 시점 승인 규칙(capability_grants)이 정한다.
      untrustedNoTools: false,
      untrustedAllowedMcpTools: undefined,
      onAgentAppMcpRuntimeUnavailable: req.agentAppMode
        ? markAgentAppMcpRuntimeUnavailable
        : undefined,
      // 사용자가 지정한 워킹 폴더(프로젝트)에서 에이전트를 실행 — 빌드/파일 생성이 거기서 일어난다.
      // 활성화(2회 방문) 게이팅과 무관하게, 폴더가 지정돼 있으면 즉시 cwd로 사용한다.
      cwd: workingFolder ?? undefined,
      locale,
      // A confirmed One Task is a result surface, not an ordinary chat turn.
      // Force the declarative protocol while casual One conversation remains
      // lightweight and plain-text capable.
      forceSurface: oneTeamExecutionPolicy ? true : undefined,
    };
    let agentContextAttempt = 0;
    // Typed journal marker for host-written input (see markAgentContextHostAuthored); set per invocation, first call only.
    let hostAuthoredNext: string | undefined;
    // Same-session continuation of an unsettled turn (invokeCurrentRuntime): the native handle for the next delivery only,
    // and the turn id of the latest journal delivery, which is how the host finds what that turn left behind.
    let continuationHandleNext: string | undefined;
    let lastJournalTurnId: string | null = null;
    const persistentRunnerRequest = (request: RunnerRequest): RunnerRequest => {
      if (!persistentAgentContext || !req.runId || request.minimalObservation || request.judgmentOnly || request.untrustedNoTools) return request;
      const bound = bindInvocationAgentContext(request, { chatId: chat.id, agentId: agent.id, runId: req.runId,
        attempt: ++agentContextAttempt, aliveController: isAliveControllerRun, hostAuthored: hostAuthoredNext, assertCurrent() {
          assertMcpGoalSelectionCurrent();
          if (activeGoalId && activeGoalRevision !== null) {
            const revision = getChatGoalRevision(activeGoalId);
            if (!revision || revision.chatId !== chat.id || revision.revision !== activeGoalRevision) {
              throw Object.assign(new Error("agent_context_goal_revision_changed"), { code: "agent_context_goal_revision_changed" });
            }
          }
        } });
      lastJournalTurnId = agentContextHostBinding(bound.agentContext as AgentContextCapability).turnId;
      markAgentContextContinuationHandle(lastJournalTurnId, continuationHandleNext);
      return bound;
    };
    let goalWorkAdmissionNotified = false;
    if (workspacePins.size) runnerReq.sessionFingerprintSeed = JSON.stringify({ base: runnerReq.sessionFingerprintSeed ?? null,
      revisions: [...workspacePins].sort(([a], [b]) => a.localeCompare(b)) });
    const runnerRequestForRuntime = (
      runtime: RuntimeStatus,
      runtimePicked: { runner: Runner; label: string },
      userPrompt = runtimeUserPrompt,
    ) => {
      if (scienceRecovery) {
        if (signal?.aborted) throw new Error("science_recovery_dispatch_cancelled");
        resolveScienceRecoveryAuthority(executionContext, req.runId!, req.chatId, runtime);
        return freshScienceRecoveryRequest({ ...runnerReq, backendLabel: runtimePicked.label,
          runtimeSource: runtime.source ?? undefined,
          model: runtime.model ?? undefined, effort: runtime.effort ?? undefined }, scienceRecovery);
      }
      if (scienceCollectionCurrent) {
        scienceCollectionCurrent();
        assertScienceCollectionRuntimeSelection(runtime, req.runtimeSelection);
        if (!scienceCollectionCapability) throw new Error("science_collection_transport_unsupported");
      }
      // Runners that place req.turnContext themselves after their wrapped system text: the session runners, plus grok,
      // cursor and ACP (grok appends it after the wrapper and frames it on resume, cursor's print path follows the wrapper,
      // ACP frames and dedupes it). Gluing it onto systemPrompt put per-turn blocks inside the agent slot, which the
      // stability order now places before the configuration lines (docs/PROMPT-COMPOSITION-POLICY.md), and a loaded ACP
      // session never received it again.
      const sessionCapable = persistentAgentContext || runtime.kind === "claude-code" || runtime.kind === "codex" || runtime.kind === "kimi"
        || runtime.kind === "antigravity" || runtime.kind === "grok" || runtime.kind === "cursor" || runtime.kind === "acp";
      const checkpoint = activeGoalId ? latestTaskCheckpoint(activeGoalId) : null;
      let checkpointAdvisory: string | null = null;
      let checkpointAdmitted = false;
      let continuationSession: ReturnType<typeof goalContinuationSessionIdentity> | null = null;
      if (continuationRuntimePinned) {
        if (signal?.aborted) throw new Error("checkpoint_dispatch_cancelled");
        const goal = activeGoalId ? getLongRunByGoalId(activeGoalId) : null;
        if (goal && (longRunOwnerHold(goal.id) || ["pausing", "cancelling", "cancelled", "completed"].includes(goal.status)
          || (goal.status === "paused" && goal.pauseReason === "user"))) {
          throw new Error("checkpoint_dispatch_goal_stopped");
        }
        try {
          if (!checkpoint) throw new Error("checkpoint_dispatch_context_missing");
          const admitted = prepareCheckpointContinuation(checkpoint, req.runId);
          if (JSON.stringify(admitted.runtimeSelection) !== JSON.stringify(req.runtimeSelection)) {
            throw new Error("checkpoint_dispatch_runtime_selection_changed");
          }
          if (!req.runId || !checkpoint.workspacePath) throw new Error("checkpoint_session_identity_missing");
          continuationSession = goalContinuationSessionIdentity({ chatId: chat.id, goalId: checkpoint.goalId,
            goalRevision: checkpoint.goalRevision!, workspacePath: checkpoint.workspacePath,
            runtime, permission: req.permissions ?? null, baseSeed: runnerReq.sessionFingerprintSeed ?? "",
            invocationRunId: req.runId });
          checkpointAdmitted = true;
        } catch (error) {
          if (signal?.aborted) throw error;
          checkpointAdvisory = "checkpoint: no replay authorized; plan fresh from the goal and constraints; prior external effects unknown → inspect, never replay them";
          if (req.runId) tryRecordRunEvent({ runId: req.runId, chatId: chat.id, kind: "checkpoint_dispatch_advisory",
            payload: { goalId: activeGoalId, action: "fresh_independent_episode",
              reason: error instanceof Error ? error.message.slice(0, 160) : "checkpoint_unavailable" } });
        }
      }
      // Interactive model changes may follow a newer artifact/user-state edit.
      // Read one canonical snapshot without rewriting the stored checkpoint or
      // weakening the stricter automatic-continuation admission above.
      const checkpointContext = checkpoint && (!continuationRuntimePinned || checkpointAdmitted) ? getDb().transaction(() => {
        const artifacts = !continuationRuntimePinned && checkpoint.schemaVersion === "agentlas.task-checkpoint.v2"
          ? { chatId: chat.id, observedAt: new Date().toISOString(),
              artifacts: listAgentSurfaces(chat.id).map(surface => ({ artifactId: surface.id,
                artifactRevision: surface.artifactRevision ?? null, sourceDigest: surface.artifactRef?.sourceDigest ?? null,
                dataDigest: surface.artifactRef?.dataDigest ?? null, stateRevision: surface.stateRevision ?? null,
                stateSchemaDigest: surface.artifactRef?.stateSchemaDigest ?? null, state: surface.state,
              })).sort((a, b) => a.artifactId.localeCompare(b.artifactId)) }
          : undefined;
        // The Goal contract block (objective + criteria) is in this turn's context: the packet keeps refs only.
        return compileLongRunCheckpoint(checkpoint, runtime.kind, artifacts, goalContractInContext ? { goalContext: goalContractInContext } : undefined);
      })() : "";
      // Owner method/constraint changes are execution context, not new success
      // criteria or a new native session. Re-read their source-backed projection
      // for every dispatch, including checkpoint recovery and runtime fallback.
      const ownerExecutionDirectives = activeGoalId ? goalExecutionDirectivePromptBlock(activeGoalId) : null;
      const dispatchTurnContextParts = [...frozenTurnContextParts];
      if (!goalWorkAdmissionNotified) {
        if (signal?.aborted) throw Object.assign(new Error("goal_plan_dispatch_cancelled"), { code: "goal_plan_dispatch_cancelled" });
        onBeforeGoalWorkDispatch?.(activeGoalId);
        goalWorkAdmissionNotified = true;
      }
      if (goalPlanContextSlot) {
        if (signal?.aborted) {
          throw Object.assign(new Error("goal_plan_dispatch_cancelled"), { code: "goal_plan_dispatch_cancelled" });
        }
        const currentGoalRevision = getChatGoalRevision(goalPlanContextSlot.goalId);
        // Legacy first turns may have no canonical revision yet. Once one is
        // admitted, its absence or replacement cannot authorize this projection.
        if ((activeGoalRevision !== null && !currentGoalRevision)
          || (currentGoalRevision && (currentGoalRevision.chatId !== chat.id || currentGoalRevision.revision !== goalPlanContextSlot.revision))) {
          throw Object.assign(new Error("goal_plan_dispatch_revision_changed"), { code: "goal_plan_dispatch_revision_changed" });
        }
        const currentPlan = readGoalPlan(goalPlanContextSlot.goalId, goalPlanContextSlot.revision);
        if (!currentPlan || currentPlan.goalId !== goalPlanContextSlot.goalId || currentPlan.revision !== goalPlanContextSlot.revision) {
          throw Object.assign(new Error("goal_plan_dispatch_context_missing"), { code: "goal_plan_dispatch_context_missing" });
        }
        dispatchTurnContextParts[goalPlanContextSlot.index] = buildGoalPlanTurnContext(currentPlan,
          { runId: req.runId ?? null, locale, record: false, typedTools: goalTypedToolsReplaceText,
            reservedDecisionIds: goalPlanContextSlot.reservedDecisionIds ?? undefined });
        bindGoalPlanDispatch(currentPlan, req.runId ?? null);
      }
      // Same declared order at dispatch: the refreshed plan keeps its slot's declaration; the checkpoint rule/packet, owner
      // directives and recovery packet are task context after the collector's task blocks; the progress advisory is per turn.
      const runtimeTurnContextParts = orderPromptParts([...declaredTurnContext(dispatchTurnContextParts),
        ...([["checkpoint.advisory", checkpointAdvisory], ["checkpoint.context", checkpointContext],
          ["owner.execution-directives", ownerExecutionDirectives], ["canonical.recovery-packet", canonicalWorkRecovery?.packet()]] as const)
          .flatMap(([id, text]) => text ? [{ id, stability: "task-context" as const, changeTriggers: ["checkpoint", "goal-revision"] as const, text }] : []),
        ...((): Array<PromptOrderingMetadata & { text: string }> => { const text = progressAdvisory?.();
          return text ? [{ id: "progress.advisory", stability: "turn-context", changeTriggers: ["task"], text }] : []; })(),
      ]);
      const runtimeTurnContext = renderRunnerTurnContext(runtimeTurnContextParts);
      // Every runtime gets the minimal observation request; runners that support the mode (claude-code, codex, serving,
      // BYOK/local host loop) also shed their own headers, user setup and extra tool servers.
      if (effectObservationRun) {
        // One read-only look: its own tiny system prompt, no persona/history/turn context. The observation
        // prompt (userPrompt) carries the goal, targets, rules and the verdict marker contract.
        return {
          ...runnerReq,
          systemPrompt: EFFECT_OBSERVATION_SYSTEM_PROMPT,
          turnContext: undefined,
          turnContextStable: undefined,
          history: [],
          minimalObservation: true as const,
          outputSchema: { name: "agentlas_effect_observation_v1",
            schema: effectObservationOutputSchema(effectObservationTicket(req.runId)!.attemptIds) },
          // A local effect (file, folder) is looked at with read built-ins only; the browser server's tool
          // schemas are loaded only when the interrupted work used a browser or a web page.
          ...(effectObservationTicket(req.runId)?.needsBrowser === false
            ? { mcpConfigPath: undefined, mcpAllowedTools: [], mcpCodexConfigArgs: [] } : {}),
          userPrompt,
          backendLabel: runtimePicked.label,
          runtimeSource: runtime.source ?? undefined,
          model: runtime.model ?? undefined,
          longContext: false,
          effort: runtime.effort ?? undefined,
        };
      }
      const placedTurnContext = placeTurnContextForRuntime({ runtimeKind: runtime.kind, sessionCapable,
        systemPrompt, turnContext: runtimeTurnContext, userPrompt, locale });
      const hostSystemProjection = hostSystemComposition
        ? placedTurnContext.placement === "system-tail" && runtimeTurnContext.trim()
          ? composeMainHostSystemPrompt([...systemContextParts, ...runtimeTurnContextParts])
          : hostSystemComposition
        : null;
      const composedRequest: RunnerRequest = {
        ...runnerReq,
        ...(continuationSession ? { runtimeSessionOwnerId: continuationSession.ownerId,
          sessionFingerprintSeed: continuationSession.fingerprintSeed } : continuationRuntimePinned && req.runId
          ? { runtimeSessionOwnerId: `goal-independent:${req.runId}`, sessionFingerprintSeed: `goal-independent:${req.runId}` } : {}),
        // Serving keeps the cached prefix (tools, system, history) byte-stable: its per-turn host
        // context rides in front of the current user message, not on the system tail.
        systemPrompt: hostSystemProjection?.text ?? placedTurnContext.systemPrompt,
        ...(hostSystemProjection ? { systemPromptComposition: hostSystemProjection.composition } : {}),
        ...(sessionCapable && runtimeTurnContext ? { turnContext: runtimeTurnContext } : { turnContext: undefined }),
        ...(sessionCapable && runtimeTurnContext ? { turnContextStable: stableTurnContextParts } : {}),
        userPrompt: placedTurnContext.userPrompt,
        ledgerHints: { hostContextTokens: estimateTextTokens(runtimeTurnContext ?? ""), hostContextText: runtimeTurnContext,
          hostContextPlacement: placedTurnContext.placement, ownerTextTokens: estimateTextTokens(userPrompt) },
        backendLabel: runtimePicked.label,
        runtimeSource: runtime.source ?? undefined,
        model: runtime.model ?? undefined,
        longContext: runtime.longContextEnabled ?? false,
        effort: req.oneMode && req.fastMode === true && runtime.kind === "codex"
          ? effortForSelectedModel(runtime, runtime.model, "minimal") ?? undefined
          : runtime.effort ?? undefined,
      };
      return bindRunnerTurnContext(composedRequest, { parts: runtimeTurnContextParts, runtimeKind: runtime.kind,
        sessionCapable, systemPrompt, ...(hostSystemComposition ? { systemPromptComposition: hostSystemComposition.composition } : {}), userPrompt, locale });
    };
    // ★관문이 "설치됨"인지는 런타임이 실제로 받은 것으로 판정한다. settingsPath 하나만
    // 보면 grok 실행은 관문을 받고도 영원히 미설치로 기록된다.
    toolBrokerInstalled = Boolean(runnerReq.toolBrokerSettingsPath || runnerReq.toolBrokerPluginDir);
    // 라이브 토큰은 러너 1회 실행 기준 누적치 — Stormbreaker 연속 패스에서 다음 패스가
    // 0부터 다시 세도 표시가 뒤로 가지 않도록 이전 패스 최고치를 floor로 더한다.
    let liveUsageFloor = 0;
    let liveUsageHigh = 0;
    // 현재 reasoning 구간의 누적 텍스트(end에 원장용 전문으로 붙는다).
    let reasoningSpanText = "";
    // partial도 같은 문제 — 패스가 바뀌면 러너 누적이 0부터 다시 시작해 렌더러 본문이
    // 통째로 줄고(전문 교체) 이전 패스 도구 카드 앵커가 붕괴한다. 이전 패스 전문을 floor로
    // 접두해 본문/앵커 좌표계를 패스 전체에 걸쳐 단조로 유지한다. (continuousMode는 패스마다
    // 별도 assistant 메시지를 남기므로 제외 — 접두하면 내용이 중복된다)
    let partialFloor = "";
    // Memory events a continuous pass ended with. Each pass is saved as its own message below, so its block is taken
    // out there and curated with the final answer (production 2026-10-05: X Marketing showed the raw envelope).
    const carriedPassMemoryEvents: RawMemoryEvent[] = [];
    const observedOneSourceUrls = new Set<string>();
    let observedOneToolEvidence = false;
    let observedOneToolFailure = false;
    const oneToolFailures = createOneToolFailureTracker();
    let oneRecoveryDecisionPending = false;
    // 복구 패스 판정용 패스 단위 계수 — 복구 패스가 "도구 성공 증거 있음 + 무오류"로
    // 끝났을 때에만 실패 흔적을 지운다(도구 없이 말로만 끝내는 가짜 성공 방지).
    let passToolFailures = 0;
    let passToolSuccesses = 0;
    const oneToolFailureBlocksCompletion = () => Boolean(oneTeamExecutionPolicy && observedOneToolFailure);
    const collectObservedSourceUrls = (value?: string): string[] => {
      if (!value || !oneTeamExecutionPolicy || observedOneSourceUrls.size >= 32) return [];
      const added: string[] = [];
      for (const match of value.matchAll(/https:\/\/[^\s"'<>\\)\]]+/g)) {
        if (observedOneSourceUrls.size >= 32) break;
        try {
          const parsed = new URL(match[0]);
          if (
            parsed.protocol === "https:"
            && !parsed.username
            && !parsed.password
            && !parsed.hostname.endsWith(".invalid")
            && !parsed.hostname.endsWith(".local")
            && !observedOneSourceUrls.has(parsed.href)
          ) {
            observedOneSourceUrls.add(parsed.href);
            added.push(parsed.href);
          }
        } catch {
          // Tool output is untrusted text; malformed URLs are ignored.
        }
      }
      return added;
    };
    const collectToolImages = (paths: readonly string[], allowResultFolder = false): boolean => {
      if (req.agentAppMode || !paths.length) return false;
      let added = false;
      const maxImages = imageGenerationRequired ? 1 : ONE_ATTACHMENT_LIMITS.maxCount;
      let retainedBytes = pendingWorkToolImages.reduce(
        (total, item) => total + Buffer.byteLength(item.image.data, "base64"),
        0,
      );
      for (const sourcePath of paths) {
        if (pendingWorkToolImages.length >= maxImages) break;
        if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) continue;
        // 임의의 읽기 대상이 채팅 이미지로 승격되면 안 된다. 그 경계는 도구 이름이 아니라
        // Main 정본 폴더 소속 + 이번 run의 exact artifact binding으로 긋는다.
        // 문자열 prefix가 아니라 realpath-relative containment를 써서 형제 폴더와
        // symlink alias가 정본으로 오인되지 않게 한다.
        try {
          const resolvedSource = fs.realpathSync.native(path.resolve(sourcePath));
          const candidateRoots = [
            browserCaptureDir(),
            savedBrowserCaptureDir(),
            screenCaptureDir(),
            userDataPath("generated-assets", "native-browser"),
            userDataPath("generated-assets", "antigravity"),
            userDataPath("multimodal-images"),
            ...(allowResultFolder && resolvedResultFolder ? [resolvedResultFolder] : []),
          ];
          const trustedRoot = candidateRoots.map((root) => {
            try {
              const resolvedRoot = fs.realpathSync.native(path.resolve(root));
              const relative = path.relative(resolvedRoot, resolvedSource);
              return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
                ? resolvedRoot
                : null;
            } catch { return null; }
          }).find((root): root is string => Boolean(root));
          if (!trustedRoot) continue;
          if (allowResultFolder && resolvedResultFolder
            && trustedRoot === fs.realpathSync.native(path.resolve(resolvedResultFolder))
            && req.runId
            && isWorkAttachmentInput(req.runId, chat.id, resolvedResultFolder, resolvedSource)) continue;
          const image = chatImageAttachmentFromTrustedFile({ filePath: sourcePath, trustedRoot });
          if (pendingWorkToolImages.some((item) => item.sourcePath === sourcePath)) continue;
          const imageBytes = Buffer.byteLength(image.data, "base64");
          if (retainedBytes + imageBytes > ONE_ATTACHMENT_LIMITS.maxTotalBytes) continue;
          pendingWorkToolImages.push({ sourcePath, image });
          retainedBytes += imageBytes;
          added = true;
          if (imageGenerationRequired) observedImageArtifactEvidence = true;
        } catch {
          // Main sealing is fail-closed. An untrusted or malformed file is not
          // image evidence and must not cross into chat history.
        }
      }
      return added;
    };
    collectDurableToolImages = collectToolImages;
    const runnerEvents = {
      onStatus: (status: string, activity?: McpInvocationEvent["activity"]) => sink({
        kind: "tool-use",
        status,
        activity,
      }),
      // A partial JSON fence cannot be safely sanitized. Restricted runs are
      // final-only so cancel/error can never persist an unfinished Memory block.
      onPartial: (text: string) => {
        if (!projectReadOnlyBoundary) {
          const visible = activeGoalId && !executionContext ? stripGoalWaitDisplayText(text) : text;
          sink({ kind: "partial", text: partialFloor ? `${partialFloor}\n${visible}` : visible });
        }
      },
      // Claude Code식 tool-use 블록 — 이름 + 인자 JSON
      // `_toolKind` (typed ACP/agy kind, runner.ts) is accepted so the forwarding wrapper keeps the runner signature.
      onTool: (name: string, args?: string, result?: string, id?: string, isError?: boolean, artifactPaths?: readonly string[], imageDataUrl?: string, dispatchedOrigin?: ToolInvocationOrigin, _toolKind?: RuntimeToolKind) => {
        let sourceUrls: string[] | undefined;
        if (!isError && req.runId && !req.agentAppMode) {
          try {
            const slugs = pluginSlugsNamedInToolEvent({ name, args, result }, listInstalledPluginCandidates());
            if (slugs.length) {
              tryRecordRunEvent({ runId: req.runId, kind: "plugin_requested_mid_turn", chatId: chat.id, agentId: agent.id,
                payload: { slugs, tool: name.slice(0, 120) } });
            }
          } catch { /* Optional routing hint; never breaks the run. */ }
        }
        const completedToolOutcome = oneToolFailures.note({ name, args, result, id, isError });
        observedOneToolFailure = oneToolFailures.unresolved();
        if (completedToolOutcome && isError === true) {
          passToolFailures += 1;
        }
        if (completedToolOutcome && isError === false && result !== undefined) {
          passToolSuccesses += 1;
          // The Codex runtime uses this generic wrapper only for an MCP call.
          // Shell/read tools can echo arbitrary URLs from local documents (for
          // example a proposed schema's example.invalid), which must never be
          // presented as a browsed source. Browser MCP observations do carry
          // their public page URL through this wrapper.
          const browserMcpCall = /^mcp[\s_.-]*tool[\s_.-]*call$/i.test(name.trim());
          sourceUrls = browserMcpCall
            ? [...collectObservedSourceUrls(args), ...collectObservedSourceUrls(result)]
            : undefined;
          // Some provider runners emit a successful tool completion without
          // echoing its result text back through this callback. The signed
          // invocation event is still enough to admit an explicitly
          // unverified deterministic fallback; file claims remain subject to
          // the separate exact-result-folder filesystem seal below.
          if (oneTeamExecutionPolicy && name.trim()) observedOneToolEvidence = true;
        }
        // ★오너 지시(2026-09-03): "사진/영상 증빙 렌더링을 전부 One과 동일하게 맞출 것.
        // 애초에 다를 이유가 없음." One 은 아무 도구의 산출물이나 바인딩하는데 Work 만
        // generate_image 한 도구로 막혀 있어, 브라우저 스크린샷이 화면에 아무것도 남기지
        // 못했다(2026-09-03 실측: 산출물 0 · 레일 이미지 0 · 채팅 이미지 0).
        // 도구 이름을 추측하는 대신 **우리 정본 폴더 안에 있는가**로 판정한다 —
        // 아래 봉인이 fail-closed 라 남의 경로는 어차피 통과하지 못한다.
        // A successful completion also carries the files a harness port wrote for this run (bindInvocationOneArtifacts).
        let producedPaths: string[] = [];
        const oneArtifacts = !isError && (result !== undefined || (id && artifactPaths?.length))
          ? bindInvocationOneArtifacts(id ?? "", artifactPaths ?? [], { name, ...(_toolKind ? { kind: _toolKind } : {}) }, (taken) => { producedPaths = taken; })
          : undefined;
        const outputPaths = isError ? [] : [...(artifactPaths ?? []), ...producedPaths];
        if (outputPaths.length) {
          const boundImageLabels = new Set((oneArtifacts ?? [])
            .filter((artifact) => artifact.type === "image")
            .map((artifact) => artifact.label));
          const boundImagePaths = outputPaths.filter((candidate) => boundImageLabels.has(path.basename(candidate)));
          collectToolImages(outputPaths);
          if (boundImagePaths.length > 0) collectToolImages(boundImagePaths, true);
        }
        sink({
          kind: "tool-use",
          tool: {
            name,
            origin: resolveToolInvocationOrigin({
              toolName: name,
              runtimeKind: active.kind,
              backendLabel: runnerReq.backendLabel,
              ...(typeof mcpConfigPath === "string" ? { mcpConfigPath } : {}),
              ...(dispatchedOrigin ? { dispatchedOrigin } : {}),
            }),
            args,
            result,
            id,
            isError,
            observationDigest: toolObservationDigest(artifactPaths, imageDataUrl),
            ...(isError ? { failureCode: classifyToolFailure({ result }) } : {}),
            ...(sourceUrls?.length ? { sourceUrls } : {}),
          },
          ...(oneArtifacts?.length ? { oneArtifacts } : {}),
        });
      },
      // 라이브 누적 토큰 — 상태줄 "{N}s · {tokens} tokens" 실시간 갱신.
      onUsage: (tokens: number) => {
        liveUsageHigh = Math.max(liveUsageHigh, liveUsageFloor + tokens);
        sink({ kind: "usage", tokens: liveUsageHigh });
      },
      // reasoning(thinking) 구간 신호 — 상태줄 "생각 중…" 회전 + "N초 동안 생각함".
      // 텍스트는 live로는 delta 그대로 흘리고, end에는 이 구간의 전문을 붙인다 —
      // 원장(run_events)은 partial을 안 남기므로 end의 전문이 재방문 때의 유일한 근거다.
      onThinking: (phase: "start" | "delta" | "end", durationMs?: number, text?: string) => {
        if (phase === "start") {
          reasoningSpanText = "";
          sink({ kind: "reasoning", reasoning: { phase } });
          return;
        }
        if (phase === "delta") {
          if (typeof text === "string" && text) {
            if (reasoningSpanText.length < REASONING_SPAN_TEXT_CAP) reasoningSpanText += text;
            sink({ kind: "reasoning", reasoning: { phase, text } });
          }
          return;
        }
        const fullText = (typeof text === "string" && text.trim() ? text : reasoningSpanText).slice(0, REASONING_SPAN_TEXT_CAP);
        reasoningSpanText = "";
        sink({
          kind: "reasoning",
          reasoning: { phase, ...(durationMs !== undefined ? { durationMs } : {}), ...(fullText.trim() ? { text: fullText } : {}) },
        });
      },
      // The runtime's own checklist (runtime-plan.ts normalized it from its structured protocol).
      onPlan: (plan: NonNullable<McpInvocationEvent["plan"]>) => sink({ kind: "plan", plan }),
      // 러너가 사용자에게 남겨야 하는 사실(첫 소비자: 컨텍스트 압축).
      // 상태줄과 달리 대화에 남는다.
      onNotice: (notice: NonNullable<McpInvocationEvent["notice"]>) => {
        // 러너가 "이 모델은 화면을 볼 수 없어 컴퓨터 유즈·스크린샷 도구를 뺐다" 고 알렸으면, 그 실행에
        // 캡처 산출을 요구하는 것은 성립하지 않는다 — 안내를 남기고도 끝에서 screen_capture_unavailable 로
        // 실패시키던 것(3회 반복 실측 2026-09-13: 컴퓨터 유즈 과제 3/3 실패). 답은 정직한 텍스트로 끝난다.
        if (notice.code === "computer-use-needs-vision-model") blindVisionRuntime = true;
        sink({ kind: "notice", notice });
      },
    };
    // Direct interactive fallback is a recovery chain, not an unbounded retry
    // loop. The set lives for the whole invocation so a later Stormbreaker or
    // One recovery pass cannot resurrect a runtime that already failed here.
    const DIRECT_RUNTIME_RECOVERY_MAX_ATTEMPTS = 4;
    const DIRECT_RUNTIME_RECOVERY_MAX_ELAPSED_MS = 30_000;
    const DIRECT_RUNTIME_RECOVERY_MAX_RETRY_EVENTS = 3;
    const attemptedRuntimeKeys = new Set<string>();
    const attemptedRuntimeReceipts = new Map<string, {
      kind: RuntimeStatus["kind"];
      backend: RuntimeStatus["backend"];
      source: string;
      acpAgentId: string | null;
      model: string | null;
      attempt: number;
    }>();
    let runnerEventGeneration = 0;
    let aliveUsageAttemptOrdinal = 0;
    // Paid fallback cannot replay effects from any earlier attempt in this
    // invocation, even if the last candidate rejects before producing output.
    let creditRetryBlocked = false;
    const runtimeAttemptKey = (runtime: RuntimeStatus): string => JSON.stringify([
      runtime.kind,
      runtime.backend,
      runtime.source,
      runtime.acpAgentId ?? null,
      runtime.model ?? null,
    ]);
    const runtimeAttemptReceipt = (runtime: RuntimeStatus, attempt: number) => ({
      kind: runtime.kind,
      backend: runtime.backend,
      source: runtime.source,
      acpAgentId: runtime.acpAgentId ?? null,
      model: runtime.model ?? null,
      attempt,
    });
    // A CLI can resolve its promise before a buffered stream callback arrives.
    // Seal each runner's callbacks to its own generation so a late callback
    // cannot mutate the next runtime's counters, artifacts, or transcript.
    const runtimeTerminalEvidence = { closedHttpRefusal: false, locallyRejected: false };
    /*
     * Typed placement evidence for the send queue (invocation/pending-chat-sends.ts removes a queued message only on it):
     * the first protocol fact that this run's turn reached the runtime's conversation. The native turn ACK
     * (onNativeTurnController after the exact receipt or uuid echo), model output of this turn (text, tool, thinking,
     * plan, provider usage), or a returned/thrown terminal the runner reports accepted or completed. A dispatch alone
     * (onRuntimeAttemptStarted) is not placement. Recorded once per run as a durable run event, on Main and daemon alike.
     */
    let turnPlacementRecorded = false;
    const recordTurnPlacement = (evidence: "turn-ack" | "output" | "terminal"): void => {
      if (turnPlacementRecorded || !req.runId) return;
      turnPlacementRecorded = true;
      tryRecordRunEvent({ runId: req.runId, chatId: chat.id, kind: RUNTIME_TURN_PLACED_EVENT, payload: { runtime: active.kind, evidence } });
    };
    const createAttemptRunnerEvents = (): {
      events: RunnerEvents; settle: () => void;
      observedUsage: (returnedUsage?: LongRunUsageInput["observedUsage"]) => LongRunUsageInput["observedUsage"];
      creditRetrySafe: () => boolean;
      nativeActivity: () => boolean;
    } => {
      const generation = ++runnerEventGeneration;
      let settled = false;
      let nativeActivity = false;
      const usageCollector = createRuntimeUsageCollector();
      const recordTerminalUsage: NonNullable<RunnerEvents["onTerminalObservedUsage"]> = (usage, attemptId): void => {
        if (settled || generation !== runnerEventGeneration) return;
        nativeActivity = true;
        recordTurnPlacement("output");
        if (usage && (!Number.isFinite(usage.outputTokens) || usage.outputTokens !== 0)) { creditRetryBlocked = true; noteGraphWorkerActivity(executionContext?.graphWorkerAttempt); }
        usageCollector.recordTerminal(usage, attemptId);
      };
      const forward = <T extends unknown[]>(handler: (...args: T) => void) => (...args: T): void => {
        if (settled || generation !== runnerEventGeneration || signal?.aborted) return;
        handler(...args);
      };
      return {
        events: {
          onPartial: forward((...args: Parameters<RunnerEvents["onPartial"]>) => {
            if (args[0]) { nativeActivity = true; recordTurnPlacement("output"); }
            if (args[0]) { creditRetryBlocked = true; noteGraphWorkerActivity(executionContext?.graphWorkerAttempt); }
            currentHistoryRuntimeFence()?.assertCurrent();
            runnerEvents.onPartial(...args);
          }),
          onStatus: forward(runnerEvents.onStatus),
          onTool: forward((...args: Parameters<NonNullable<RunnerEvents["onTool"]>>) => {
            nativeActivity = true;
            recordTurnPlacement("output");
            creditRetryBlocked = true;
            currentHistoryRuntimeFence()?.assertCurrent();
            runnerEvents.onTool(...args);
          }),
          onUsage: forward((...args: Parameters<NonNullable<RunnerEvents["onUsage"]>>) => {
            nativeActivity = true;
            runnerEvents.onUsage?.(...args);
          }),
          // A provider can send its terminal usage after cancellation. The
          // display callbacks stop then, but this exact accounting fact may
          // still settle the already-dispatched wake without replaying it.
          onRuntimeAttemptStarted: (attemptId) => {
            if (!settled && generation === runnerEventGeneration) { nativeActivity = true; usageCollector.start(attemptId); }
          },
          onNativeTurnController: (controller, state) => {
            if (settled || generation !== runnerEventGeneration) return;
            const observed = state === undefined ? undefined : validatedRunnerNativeControlState(state);
            if (state !== undefined && !observed) { if (!controller) onNativeTurnController?.(null); return; }
            // Withdrawal must still pass after Stop; it has no provider effect.
            if (controller && signal?.aborted) return;
            if (controller) { nativeActivity = true; recordTurnPlacement("turn-ack"); }
            onNativeTurnController?.(controller, observed ?? undefined);

          },
          onTerminalObservedUsage: recordTerminalUsage,
          onThinking: forward((...args: Parameters<NonNullable<RunnerEvents["onThinking"]>>) => {
            nativeActivity = true;
            recordTurnPlacement("output");
            if (args[0]) { creditRetryBlocked = true; noteGraphWorkerActivity(executionContext?.graphWorkerAttempt); }
            if(args[0]!=="end"||args[2])currentHistoryRuntimeFence()?.assertCurrent();
            runnerEvents.onThinking(...args);
          }),
          onNotice: forward(runnerEvents.onNotice),
          onPlan: forward((...args: Parameters<NonNullable<RunnerEvents["onPlan"]>>) => {
            nativeActivity = true;
            recordTurnPlacement("output");
            runnerEvents.onPlan(...args);
          }),
        },
        settle: () => {
          if (!settled && generation === runnerEventGeneration) onNativeTurnController?.(null);
          settled = true;
        },
        observedUsage: (returnedUsage) => usageCollector.total(returnedUsage),
        creditRetrySafe: () => !creditRetryBlocked,
        nativeActivity: () => nativeActivity,
      };
    };
    const directRuntimeFallbackAllowed =
      !req.agentAppMode
      && !isUnattendedExecution(executionContext)
      && !automationRuntimePinned
      && !scienceRuntimePinned
      && !continuationRuntimePinned;
    let directRuntimeDispatched = false;
    let goalResultOrdinal = 0;
    const goalUsageInvocationId = req.runId ?? randomUUID();
    let lastGoalUsage: LongRunUsageInput | undefined;
    const invokeBrainRuntime = async (request: RunnerRequest): Promise<Awaited<ReturnType<Runner>>> => {
      const currentPicked = picked;
      if (!currentPicked) throw new Error("no-runner");
      /*
       * The recovery clock measures recovery, not the work.
       *
       * It used to start here, before the first attempt, while the budget it feeds is 30 seconds.
       * So any request that took longer than 30 seconds -- which is every long prompt -- had its
       * entire recovery budget spent by the work itself: the first failure was immediately ruled
       * "time-limit", no other runtime was ever tried, and the person got an empty answer with a
       * notice that said the retry budget had run out before a single retry happened.
       *
       * It now starts when the first failure is seen, so the budget covers what it is named after.
       */
      let recoveryStartedAt: number | null = null;
      const recoveryElapsedMs = () => (recoveryStartedAt == null ? 0 : Date.now() - recoveryStartedAt);
      let recoveryRetryEvents = 0;
      let attemptCount = 0;
      /** Same-runtime retries the settlement decision spent on request throttling (reset when the runtime changes). */
      let sameRuntimeRetries = 0;
      /** Same-runtime retries spent on a store lock refused before dispatch (STORE_BUSY_CODE). */
      let storeBusyRetries = 0;
      let originalFailure: RunnerFailure | null = null;
      let terminalNoticeEmitted = false;
      const currentOwnerPrompt = runnerTurnContextSource(request)?.userPrompt ?? request.userPrompt;
      const requestForRuntimeBase = runnerRequestForRuntime(active, currentPicked, currentOwnerPrompt);
      let requestForRuntime: RunnerRequest = carryRunnerTurnContext(requestForRuntimeBase, {
        ...requestForRuntimeBase,
        history: request.history,
        runtimeSessionId: request.runtimeSessionId,
        ownerControlInbox,
        images: scienceRecovery ? undefined : request.images,
      });
      const emitTerminalRecoveryFailure = (
        result: Awaited<ReturnType<Runner>>,
        reason: "candidate-exhausted" | "attempt-limit" | "time-limit" | "event-limit",
      ): Awaited<ReturnType<Runner>> => {
        const failure = result.failure;
        if (!failure || terminalNoticeEmitted) return result;
        terminalNoticeEmitted = true;
        const elapsedMs = Math.max(0, recoveryElapsedMs());
        const details = JSON.stringify({
          schema: "agentlas.runtime-recovery-terminal/v1",
          code: "runtime-recovery-exhausted",
          reason,
          elapsedMs,
          attempts: attemptCount,
          retryEvents: recoveryRetryEvents,
          attemptedRuntimeCount: attemptedRuntimeKeys.size,
          runtimes: [...attemptedRuntimeReceipts.values()],
          originalFailure: originalFailure ?? failure,
          lastFailure: failure,
        });
        /*
         * ★로그인이 만료된 것을 "복구 후보를 다 써봤습니다"로 말하지 않는다.
         *
         * 이 앱은 런타임이 로그인돼 있는지 한 번도 보지 않는다 — CLI 파일이 있고 버전이 나오면
         * 화면은 "연결됨"이라고 쓴다. 그래서 만료된 계정으로 실행하면 사용자는 초록불을 보면서
         * 실패만 겪고, 푸는 길은 **터미널을 직접 열어 로그인**하는 것뿐이었다. 그건 만든 사람만
         * 쓸 수 있는 제품이다.
         *
         * 인증 실패는 표식(`kind: "auth"`)으로 오므로 문구를 짐작할 필요가 없다. 그 표식이 오면
         * 로그인을 여기서 권한다 — 화면은 이 코드를 보고 버튼 하나를 그리고, 그 버튼은 이미
         * 있는 openCliLogin 을 부른다.
         */
        const signedOutRuntime = (originalFailure ?? failure).kind === "auth"
          ? (originalFailure ?? failure).runtime
          : null;
        if (signedOutRuntime) {
          const koAuth = `${signedOutRuntime} 로그인이 만료됐거나 되어 있지 않습니다. 아래 로그인 버튼을 누르면 로그인 창이 열리고, 끝나면 같은 요청을 다시 보내면 됩니다.`;
          const enAuth = `${signedOutRuntime} is not signed in, or its session expired. Use the sign-in button below, then send the same request again.`;
          sink({
            kind: "notice",
            model: failure.runtime,
            modelRole: invocationModelRole,
            notice: {
              level: "error",
              code: "runtime-signed-out",
              message: locale === "ko" ? koAuth : enAuth,
              i18n: { ko: koAuth, en: enAuth },
              details: JSON.stringify({
                schema: "agentlas.runtime-signed-out/v1",
                runtime: signedOutRuntime,
                originalFailure: originalFailure ?? failure,
              }),
            },
          });
          return result;
        }
        const koMessage = `실행 ${attemptCount}회 시도 후 복구를 멈췄습니다. 중단 이유와 원래 실패 원인은 자세히에서 확인하세요.`;
        const enMessage = `Recovery stopped after ${attemptCount} execution attempt${attemptCount === 1 ? "" : "s"}. See details for the stopping reason and original failure.`;
        sink({
          kind: "notice",
          model: failure.runtime,
          modelRole: invocationModelRole,
          notice: {
            level: "error",
            code: "runtime-recovery-exhausted",
            message: locale === "ko" ? koMessage : enMessage,
            i18n: { ko: koMessage, en: enMessage },
            details,
          },
        });
        return result;
      };
      /*
       * A store write refused this attempt before dispatch because another connection held the lock (R-067: production
       * "database is locked" ×5 became runner-failed). Nothing reached the provider and another runtime would meet the
       * same store, so the settlement's short bounded retry runs the same request on the same runtime, on every lane
       * whose runtime choice is pinned too (a retry changes nothing about the choice). A graph worker attempt is left to
       * its graph, which retries the step itself. An Alive wake is left as it was: each attempt opens a provider-usage
       * marker its wake total must close (alive-runtime.ts measuredWakeUsage), so a second attempt would turn a known
       * total unknown. True when the caller should run the attempt again.
       */
      const retryStoreBusyBeforeDispatch = async (failure: unknown): Promise<boolean> => {
        if (signal?.aborted || executionContext?.graphWorkerAttempt || executionContext?.source === "alive"
          || innermostTypedCode(failure) !== STORE_BUSY_CODE) return false;
        const settlement = decideTurnSettlement({ outcome: "failed", delivery: "not-dispatched", providerCode: STORE_BUSY_CODE,
          unattended: isUnattendedExecution(executionContext), attempt: storeBusyRetries, resumeBudget: 0, fallbackAvailable: false });
        if (settlement.action !== "retry") return false;
        storeBusyRetries += 1;
        const koRetry = "Agentlas 저장소가 다른 기록으로 잠시 잠겨 있어 같은 요청을 곧 다시 보냅니다. 모델에는 아직 아무것도 보내지 않았습니다.";
        const enRetry = "The Agentlas store was briefly locked by another write; sending the same request again shortly. Nothing has reached the model yet.";
        runnerEvents.onNotice({ level: "info", code: "runtime-store-busy-retry", message: locale === "ko" ? koRetry : enRetry,
          i18n: { ko: koRetry, en: enRetry },
          details: JSON.stringify({ runtime: active.kind, providerCode: STORE_BUSY_CODE, attempt: storeBusyRetries,
            delayMs: settlement.delayMs, reason: settlement.reason }) });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, settlement.delayMs);
          const stop = (): void => { clearTimeout(timer); resolve(); };
          signal?.addEventListener("abort", stop, { once: true });
        });
        throwIfInvocationAborted(signal, locale);
        return true;
      };
      while (attemptCount < DIRECT_RUNTIME_RECOVERY_MAX_ATTEMPTS) {
        if (signal?.aborted) throw new Error(tStatus(locale, "aborted"));
        if (originalFailure && recoveryElapsedMs() >= DIRECT_RUNTIME_RECOVERY_MAX_ELAPSED_MS) {
          return emitTerminalRecoveryFailure({ text: "", failure: originalFailure }, "time-limit");
        }
        attemptCount += 1;
        const selectedRuntime = active;
        const selectedRuntimeKey = runtimeAttemptKey(selectedRuntime);
        attemptedRuntimeKeys.add(selectedRuntimeKey);
        attemptedRuntimeReceipts.set(
          selectedRuntimeKey,
          runtimeAttemptReceipt(selectedRuntime, attemptCount),
        );
        // Only Main's first direct dispatch is admitted here. This is not a
        // new policy for revoking an already-running provider or recovery pass.
        if (!directRuntimeDispatched) assertMcpGoalSelectionCurrent();
        const goalBudget = activeGoalId ? getLongRunByGoalId(activeGoalId) : null;
        const monetaryRefusal = goalBudget && goalBudget.surface !== "science" ? longRunMonetaryRefusal(goalBudget) : null;
        if (monetaryRefusal) throw new Error(monetaryRefusal);
        // A missing runner is a known pre-dispatch failure, not an unknown
        // provider charge. Begin coverage only for a selected provider.
        const aliveUsageAttempt = executionContext?.source === "alive" && picked ? ++aliveUsageAttemptOrdinal : null;
        if (aliveUsageAttempt !== null && req.runId) {
          // Required coverage marker: a missing terminal pair for any provider
          // attempt makes the bounded Alive wake's total unknown.
          recordRunEvent({ runId: req.runId, chatId: chat.id, kind: "alive_provider_attempt_started",
            sourceEventId: `alive-provider-attempt:${aliveUsageAttempt}`,
            payload: { schemaVersion: "agentlas.alive-provider-usage.v1", attempt: aliveUsageAttempt } });
        }
        const attemptEvents = createAttemptRunnerEvents();
        let runnerInvoked = false;
        /** This attempt provably sent nothing (runner never entered, or its typed pre-dispatch refusal). */
        let attemptRefusedBeforeDispatch = false;
        let historyReturnedUsage:LongRunUsageInput["observedUsage"];
        runtimeTerminalEvidence.closedHttpRefusal = false;
        runtimeTerminalEvidence.locallyRejected = false;
        let result: Awaited<ReturnType<Runner>>;
        const usageSourceId = `${goalUsageInvocationId}:provider-result:${++goalResultOrdinal}`;
        const automationAccounting = picked && executionContext?.source === "automation"
          ? beginAccountedInference({ kind: selectedRuntime.kind, model: selectedRuntime.model, source: selectedRuntime.source })
          : null;
        let invocationUsageAttempt: ReturnType<typeof beginInvocationUsageAttempt> | undefined;
        let attemptUsageRecorded = false;
        const persistAttemptUsage = (usage: LongRunUsageInput["observedUsage"], outcome: "returned" | "failed" | "cancelled"): void => {
          if (usage && (!Number.isFinite(usage.outputTokens) || usage.outputTokens !== 0)) { creditRetryBlocked = true; noteGraphWorkerActivity(executionContext?.graphWorkerAttempt); }
          if (attemptUsageRecorded) return;
          attemptUsageRecorded = true;
          invocationUsageAttempt?.complete(usage);
          automationAccounting?.complete(usage, outcome);
          // Persist only the complete runner scope. An early native receipt
          // cannot stand for a later retry whose usage is missing.
          if (aliveUsageAttempt !== null && req.runId && usage) {
            tryRecordRunEvent({ runId: req.runId, chatId: chat.id, kind: "alive_provider_usage_observed",
              sourceEventId: `alive-provider-usage:${aliveUsageAttempt}`,
              payload: { schemaVersion: "agentlas.alive-provider-usage.v1", attempt: aliveUsageAttempt,
                observedInputTokens: usage.inputTokens, observedOutputTokens: usage.outputTokens,
                ...(usage.cachedInputTokens !== undefined ? { observedCachedInputTokens: usage.cachedInputTokens } : {}) } });
          }
        };
        const persistGoalUsage = (observedUsage?: LongRunUsageInput["observedUsage"]): void => {
          // Automated calls use the captured schedule owner and its single
          // accounting receipt, even if a legacy worker chat is Goal-bound.
          if (executionContext?.source === "automation"
            || !activeGoalId || !goalBudget || goalBudget.surface === "science" || req.agentAppMode) return;
          lastGoalUsage = { sourceId: usageSourceId, invocationRunId: goalUsageInvocationId, observedUsage };
          recordLongRunUsage(activeGoalId, lastGoalUsage);
        };
        try {
          const selected = picked;
          if (!selected) throw new Error("no-runner");
          for (const [agentId, pin] of workspacePins) {
            const current = getAgentWorkspace(agentId);
            if (current.currentRevisionId !== pin.revisionId || current.treeDigest !== pin.treeDigest) throw new Error("agent_revision_changed_before_dispatch");
          }
          onGoalDispatched?.(activeGoalId ?? null);
          directRuntimeDispatched = true;
          invocationUsageAttempt = beginInvocationUsageAttempt();
          assertGraphWorkerAttempt(executionContext?.graphWorkerAttempt);
          noteGraphWorkerDispatch(executionContext?.graphWorkerAttempt, selectionForRuntime(selectedRuntime));
          currentHistoryRuntimeFence()?.assertRuntimeCoverage(selectedRuntime.kind);
          // Binding the agent context is a host check: a refusal here is pre-dispatch, never an unsettled turn.
          const boundRequest = bindAppMemoryRequest(bindSurfaceMemoryRequest(persistentRunnerRequest(requestForRuntime),scienceAliveRecall),
            {runId:req.runId,chatId:chat.id,actorId:memoryScope.agentId});
          runnerInvoked = true;
          result = await withCurrentHistoryProvider(async()=>{assertAppMemory();assertScienceAliveMemory();const returned=await selected.runner(boundRequest, attemptEvents.events);historyReturnedUsage=returned.observedUsage;assertAppMemory();assertScienceAliveMemory();return assertCurrentHistoryRunnerResult(returned);});
          runtimeTerminalEvidence.closedHttpRefusal = runtimeFailureIsClosedHttpRefusal(result.failure, {
            text: result.text, nativeActivity: attemptEvents.nativeActivity(), aborted: signal?.aborted === true,
            observedUsage: result.observedUsage,
          });
          // A failure the runner proved pre-dispatch (RuntimeTurnDelivery "not-dispatched") is that failure with its own
          // provider code, exactly like a locally rejected throw below: no model work, never an unknown dispatch.
          if (runnerResultRefusedBeforeDispatch(result)) {
            runtimeTerminalEvidence.locallyRejected = true;
            attemptRefusedBeforeDispatch = true;
            const { ownerControlTerminal: _unknownEffect, ...refused } = result;
            result = refused;
          }
          // Dispatch is not completion. Preserve partial text, session and
          // usage while fencing authentication-success and provider recovery.
          if (result.ownerControlTerminal !== "completed" && !runtimeTerminalEvidence.closedHttpRefusal && !runtimeTerminalEvidence.locallyRejected) {
            result = { ...result, ownerControlTerminal: "uncertain",
              failure: result.failure ?? runnerFailureFromError(new RuntimeTurnUnsettledError(selectedRuntime.kind, locale), selectedRuntime.kind) };
          }
          if (result.observedUsage && (!Number.isFinite(result.observedUsage.outputTokens) || result.observedUsage.outputTokens !== 0)) { creditRetryBlocked = true; noteGraphWorkerActivity(executionContext?.graphWorkerAttempt); }
          const observedUsage = attemptEvents.observedUsage(result.observedUsage);
          result = { ...result, observedUsage: observedUsage ?? undefined };
          persistAttemptUsage(observedUsage,
            result.failure ? "failed" : "returned");
          // A transport may settle with success after abort. Keep its measured
          // usage, but never persist completion or enter recovery/verification.
          if (signal?.aborted) throw signal.reason ?? new Error(tStatus(locale, "aborted"));
        } catch (error) {
          persistAttemptUsage(attemptEvents.observedUsage(historyReturnedUsage??observedRunnerUsage(error)), signal?.aborted ? "cancelled" : "failed");
          // The session acknowledged the turn before it went silent (RuntimeTurnUnsettledError turnDelivery "accepted").
          if ((error as { turnDelivery?: unknown } | null)?.turnDelivery === "accepted") recordTurnPlacement("terminal");
          attemptRefusedBeforeDispatch = !runnerInvoked || runnerRefusedBeforeDispatch(error);
          // A typed admission refusal raised before dispatch (the Work project's resident owner is busy) is that refusal,
          // not an unknown dispatch: wrapping it made the one continuation replace the owner's question (2026-10-16).
          if (runnerInvoked && !signal?.aborted && !runnerRefusedBeforeDispatch(error)) {
            const observedUsage = attemptEvents.observedUsage(historyReturnedUsage??observedRunnerUsage(error));
            persistGoalUsage(observedUsage);
            if (runtimeFailureBlocksReplay(runnerFailureFromError(error, selectedRuntime.kind))) throw error;
            // Unknown effect after dispatch, but never an anonymous one: the thrown error stays the standard cause (its
            // innermost code is still readable) with the delivery it carried (docs 31 W1, audit A7 M4).
            throw unsettledTurnError({ runtimeKind: selectedRuntime.kind, locale, cause: error });
          }
          if (attemptRefusedBeforeDispatch && await retryStoreBusyBeforeDispatch(error)) continue;
          if (!directRuntimeFallbackAllowed || signal?.aborted) {
            persistGoalUsage(attemptEvents.observedUsage(historyReturnedUsage??observedRunnerUsage(error)));
            throw error;
          }
          runtimeTerminalEvidence.locallyRejected = true;
          // Every throw that reaches here preceded dispatch (the runner was never entered, or proved it sent nothing): the
          // returned failure keeps that fact, so the thrown InvocationRunnerFailureError and the error event carry it.
          result = {
            text: "",
            failure: runnerFailureFromError(error, active.kind),
            observedUsage: attemptEvents.observedUsage() ?? undefined,
            turnDelivery: "not-dispatched",
          };
        } finally {
          attemptEvents.settle();
          // One delivery fact per attempt for the send queue (invocation/turn-placement.ts).
          if (req.runId) tryRecordRunEvent({ runId: req.runId, chatId: chat.id, kind: RUNTIME_TURN_ATTEMPT_EVENT,
            payload: { runtime: selectedRuntime.kind, delivery: attemptRefusedBeforeDispatch ? "not-dispatched" : "dispatched" } });
        }
        if (result.text.trim()) { creditRetryBlocked = true; noteGraphWorkerActivity(executionContext?.graphWorkerAttempt); }
        if (!runnerResultRefusedBeforeDispatch(result) && (result.turnDelivery === "accepted" || result.ownerControlTerminal === "completed")) recordTurnPlacement("terminal");
        persistGoalUsage(result.observedUsage);
        // A partial reply without a proven terminal is an unknown effect,
        // never permission to retry this request on another brain.
        if (result.ownerControlTerminal === "uncertain" && !runtimeTerminalEvidence.closedHttpRefusal) return result;
        // A run that actually worked is the only thing that clears "sign in required".
        if (!result.failure) noteRuntimeSucceeded(selectedRuntime);
        // Image incompatibility is a capability outcome, not a temporary
        // outage. Keep the selected binding; forwarding the attachment to a
        // different provider requires a new model choice.
        if (result.failure?.kind === "unsupported" && request.images?.length) return result;
        // A Work project has one resident provider owner. Busy is an explicit
        // admission result, not a provider outage that may fall back to a
        // second runtime and create another CLI for the same project.
        if (result.failure?.providerCode === WORK_PROJECT_RESIDENCY_BUSY_CODE) return result;
        if (result.failure?.source === "marker" && runtimeFailureBlocksReplay(result.failure)) {
          throw new InvocationRunnerFailureError(result.failure);
        }
        // A measured context refusal must retain the user's exact local binding.
        if (result.failure?.kind === "refused" && result.failure.runtime === "agentlas-local" && result.failure.source === "marker"
          && (result.failure.providerCode === "local_context_limit_exceeded" || result.failure.providerCode === "local_context_measurement_unavailable"
            || result.failure.providerCode === "local_model_remote_mcp_admission_refused")) return result;
        // A pinned Goal continuation cannot retry inside this invocation, but
        // its next settled checkpoint still needs the typed quota signal to
        // choose another connected provider before dispatch.
        if (result.failure) noteRuntimeFailure(active, result.failure);
        if (result.failure && executionContext?.graphWorkerAttempt) {
          graphDirectFailureError = new InvocationRunnerFailureError(result.failure, false, result.turnDelivery);
          noteGraphWorkerReturnedFailure(executionContext.graphWorkerAttempt,
            selectionForRuntime(selectedRuntime, { longContext: selectedRuntime.longContextEnabled }), result.failure);
          throw graphDirectFailureError;
        }
        if (result.failure && attemptRefusedBeforeDispatch && await retryStoreBusyBeforeDispatch(result.failure)) continue;
        if (!result.failure || !directRuntimeFallbackAllowed || signal?.aborted) return result;
        const failed = result.failure;
        // First failure: this is when recovery actually begins.
        if (recoveryStartedAt == null) recoveryStartedAt = Date.now();
        originalFailure = originalFailure ?? failed;
        /*
         * The one settlement decision (shared/turn-settlement.ts) chooses between a bounded same-runtime retry (request
         * throttling that provably did no work), the role pool's next candidate, and surfacing this failure as is. It
         * reads typed facts only; a closed HTTP refusal is a provider rejection ("rejected"): no model work.
         */
        const resetAt = parseRetryHint(failed.retryAfterHint, Date.now());
        const settlement = decideTurnSettlement({
          outcome: "failed",
          delivery: attemptRefusedBeforeDispatch ? "not-dispatched" : runtimeTerminalEvidence.closedHttpRefusal ? "rejected" : result.turnDelivery,
          kind: failed.kind, providerCode: failed.providerCode,
          ...(resetAt !== null ? { retryAfterMs: Math.max(0, resetAt - Date.now()) } : {}),
          unattended: isUnattendedExecution(executionContext),
          attempt: failed.providerCode === STORE_BUSY_CODE ? storeBusyRetries : sameRuntimeRetries, resumeBudget: 0,
          effectsObserved: !attemptEvents.creditRetrySafe() || Boolean(result.text.trim()),
          fallbackAvailable: true,
        });
        if (settlement.action === "surface") return result;
        if (settlement.action === "retry" && attemptCount < DIRECT_RUNTIME_RECOVERY_MAX_ATTEMPTS
          && recoveryElapsedMs() + settlement.delayMs < DIRECT_RUNTIME_RECOVERY_MAX_ELAPSED_MS) {
          sameRuntimeRetries += 1;
          const seconds = Math.max(1, Math.round(settlement.delayMs / 1000));
          const koRetry = `${active.kind} 요청 한도에 걸려 ${seconds}초 뒤 같은 모델로 다시 보냅니다.`;
          const enRetry = `${active.kind} is rate limited; sending again on the same model in ${seconds}s.`;
          runnerEvents.onNotice({ level: "warning", code: "runtime-rate-limit-retry", message: locale === "ko" ? koRetry : enRetry,
            i18n: { ko: koRetry, en: enRetry },
            details: JSON.stringify({ runtime: active.kind, providerCode: failed.providerCode ?? null, attempt: sameRuntimeRetries,
              delayMs: settlement.delayMs, reason: settlement.reason }) });
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, settlement.delayMs);
            const stop = (): void => { clearTimeout(timer); resolve(); };
            signal?.addEventListener("abort", stop, { once: true });
          });
          throwIfInvocationAborted(signal, locale);
          continue;
        }
        // A paid request must not replay work that has already produced output
        // or run tools. Only an explicit provider quota rejection can admit it.
        const allowCreditFallback = failed.kind === "quota" && failed.source === "marker"
          && active.kind !== "agentlas" && attemptEvents.creditRetrySafe()
          && !result.text.trim() && (!result.observedUsage
            || (Number.isFinite(result.observedUsage.outputTokens) && result.observedUsage.outputTokens === 0));
        if (allowCreditFallback) {
          await getBillingCredits();
          throwIfInvocationAborted(signal, locale);
        }
        /*
         * ★"지금 못 쓴다"를 시한부 사실로 남긴다. 이게 없으면 다음 턴이 같은 죽은
         * 런타임에 또 7분을 쓰고(실측), 폴백은 이미 한도 초과인 후보를 다시 고른다.
         * 시한이 지나면 스스로 후보로 돌아오므로 사용자가 손댈 일이 없다.
         */
        const fallback = rolePriorityRuntimes(runtimes, "orchestrator", {
          failedRuntime: active,
          failure: failed,
          allowCreditFallback,
        }).find((candidate) => {
          const candidateKey = runtimeAttemptKey(candidate);
          return candidateKey !== selectedRuntimeKey && !attemptedRuntimeKeys.has(candidateKey);
        });
        const fallbackPicked = fallback ? pickRunner(fallback) : null;
        if (!fallback || !fallbackPicked) return emitTerminalRecoveryFailure(result, "candidate-exhausted");
        if (attemptCount >= DIRECT_RUNTIME_RECOVERY_MAX_ATTEMPTS) {
          return emitTerminalRecoveryFailure(result, "attempt-limit");
        }
        if (recoveryElapsedMs() >= DIRECT_RUNTIME_RECOVERY_MAX_ELAPSED_MS) {
          return emitTerminalRecoveryFailure(result, "time-limit");
        }
        if (recoveryRetryEvents >= DIRECT_RUNTIME_RECOVERY_MAX_RETRY_EVENTS) {
          return emitTerminalRecoveryFailure(result, "event-limit");
        }
        recoveryRetryEvents += 1;
        if (oneControllerFallbackEligible && fallback.kind !== "agentlas") {
          emitControllerRuntimeFallback(fallback, failed);
        } else {
          const fromLabel = `${active.kind}${active.model ? ` · ${active.model}` : ""}`;
          const toLabel = `${fallback.kind}${fallback.model ? ` · ${fallback.model}` : ""}`;
          const koMessage = fallback.kind === "agentlas"
            ? `${fromLabel} 구독 한도가 소진되어 AI 크레딧으로 ${toLabel}에서 이어갑니다.`
            : `선택한 실행 환경 ${fromLabel}을 사용할 수 없어 오케스트레이터 우선순위 모델 ${toLabel}로 이어갑니다. 저장된 선택은 변경하지 않았습니다.`;
          const enMessage = fallback.kind === "agentlas"
            ? `${fromLabel} reached its subscription limit; continuing on ${toLabel} with AI credits.`
            : `The selected runtime ${fromLabel} is unavailable; continuing on orchestrator-priority model ${toLabel}. The saved selection was not changed.`;
          runnerEvents.onNotice({
            level: "warning",
            code: "runtime-fallback-attempt",
            message: locale === "ko" ? koMessage : enMessage,
            i18n: { ko: koMessage, en: enMessage },
            details: JSON.stringify({
              from: { kind: active.kind, backend: active.backend, model: active.model ?? null },
              to: { kind: fallback.kind, backend: fallback.backend, model: fallback.model ?? null },
              reason: failed.kind,
              runtime: failed.runtime,
              failureSource: failed.source,
              providerCode: failed.providerCode ?? null,
              exitCode: failed.exitCode ?? null,
              retryAfterHint: failed.retryAfterHint ?? null,
            }),
          });
        }
        sink({
          kind: "tool-use",
          status: locale === "ko"
            ? "선택한 실행 환경을 사용할 수 없어 오케스트레이터 우선순위 다음 모델로 이어갑니다."
            : "The selected runtime is unavailable; continuing on the next orchestrator-priority model.",
          activity: { code: "recovery_retry" },
        });
        active = fallback;
        picked = fallbackPicked;
        sameRuntimeRetries = 0;
        const fallbackRequestBase = runnerRequestForRuntime(active, picked, currentOwnerPrompt);
        requestForRuntime = carryRunnerTurnContext(fallbackRequestBase, {
          ...fallbackRequestBase,
          images: request.images,
        });
      }
      throw new Error("runtime recovery loop exited without a terminal result");
    };
    const advanceUsageFloor = () => {
      liveUsageFloor = liveUsageHigh;
    };
    // "계속 라이브로" 모드: 채팅에 켜져 있으면 짧은 상한(3턴)에서 멈춰 30분 간격 백그라운드로
    // 넘기지 않고, 같은 채팅에서 라이브 스트리밍을 계속 이어간다(사실상 무제한, 안전 상한만).
    // persistent goal이 바인딩된 채팅은 goal이 미달인 동안 같은 라이브 루프를 기본으로 쓴다 —
    // "goal 명령은 완성될 때까지 계속 도는 루프가 기본"(오너 요구). 정지 판단은 모델이 아니라
    // goal 원장(예산·무진전·명시 종료)이 내린다.
    const continuousMode = !scienceRecovery && !req.agentAppMode && !projectReadOnlyBoundary && chat.kind !== "division" && !effectObservationRun &&
      (chat.continuousMode === true || activeGoalId != null);
    const maxPasses = effectObservationRun || req.agentAppMode || (req.oneMode && req.fastMode === true) || scienceRecovery
      ? 1
      : continuousMode
        ? CONTINUOUS_MODE_MAX_PASSES
        : STORMBREAKER_MAX_EXECUTION_PASSES;
    let restrictedDiscardedMemoryEvents = 0;
    const sanitizeRestrictedPass = (passResult: Awaited<ReturnType<Runner>>) => {
      if (!projectReadOnlyBoundary) return passResult;
      const parsed = stripAllMemoryEventBlocks(passResult.text);
      restrictedDiscardedMemoryEvents += parsed.events.length;
      return { ...passResult, text: parsed.cleanedText };
    };
    let hostGeneratedImageAttachment: ImageAttachment | undefined;
    let hostGeneratedImageContext = "";
    if (imageGenerationRequired && !signal?.aborted) {
      const imageSlot = multimodalImageSlot();
      if (!imageSlot) {
        throw new Error("image_tool_unavailable: no configured multimodal image runtime");
      }
      sink({
        kind: "tool-use",
        status: locale === "ko"
          ? "요청한 이미지를 전용 멀티모달 엔진으로 생성하는 중…"
          : "Generating the requested image with the configured multimodal engine…",
      });
      // The run's permission reaches the image route's own CLI (multimodal/image.ts ImageAdmission, R-078).
      const generated = await generateImage(imageSlot.model, req.userPrompt, { permission: req.permissions });
      if (!generated.ok || !generated.artifactPath || !generated.src) {
        throw new Error(`image_tool_unavailable: ${generated.reason ?? "no image was produced"}`);
      }
      generatedImageSourcePaths.add(generated.artifactPath);
      collectToolImages([generated.artifactPath]);
      if (!pendingWorkToolImages.length) {
        throw new Error("image_tool_unavailable: generated bytes failed Main sealing");
      }
      hostGeneratedImageAttachment = pendingWorkToolImages[0].image;
      runnerEvents.onTool(
        "generate_image",
        JSON.stringify({ prompt: req.userPrompt }),
        JSON.stringify({ ok: true, engine: generated.engine ?? imageSlot.runtimeKind }),
        `host-image-${randomUUID()}`,
        false,
        [generated.artifactPath],
      );
      const workspaceImageCopy = copyGeneratedImageIntoWorkspace({ cwd: resolvedResultFolder ?? workingFolder,
        permission: normalizedPermission, sourcePath: generated.artifactPath, label: "image" });
      hostGeneratedImageContext = `\n\n[Agentlas image result]\nimage: the host generated and attached exactly one real image; it is the result, claim no other${workspaceImageCopy ? `\ncopy: ${workspaceImageCopy} (use for uploads, documents, later steps)` : ""}`;
      sink({
        kind: "tool-use",
        status: locale === "ko" ? "실제 이미지 결과를 채팅과 결과 탭에 연결했습니다." : "The real image result is attached to the chat and Results rail.",
      });
    }
    // Only the first call carries the host-authored purpose; an owner steer the pump delivers after it is the owner's words.
    const runCurrentRuntimeOnce = (request: RunnerRequest, hostAuthored?: string, continuationHandle?: string): Promise<Awaited<ReturnType<Runner>>> => {
      const first: RunnerRequest = carryRunnerTurnContext(request, { ...request, ownerControlInbox });
      const settled = runWithOwnerControl(first, (r) => {
        hostAuthoredNext = r === first ? hostAuthored : undefined;
        continuationHandleNext = r === first ? continuationHandle : undefined;
        return invokeBrainRuntime(r);
      });
      // goal_wait / goal_complete calls of this pass re-enter as the exact text blocks the unchanged parsers read.
      // When the typed tools replace the marker teaching, a completion marker the model wrote into its reply is not a
      // completion (docs native-harness 07 G02): only the goal_complete tool call closes the Goal on that run.
      const withGoalSignals = turnGoalToolsOffered && req.chatId && req.runId
        ? settled.then((res) => ({ ...res, text: applyGoalSignalsToText(
          goalTypedToolsReplaceText ? stripGoalCompleteMarker(res.text).text : res.text,
          takeGoalSignals(turnNotesKey(req.chatId!, req.runId!))) }))
        : settled;
      // ask_form calls of this pass re-enter as canonical <<agentlas-ask>> blocks (ordinary attended turns too).
      return turnAskToolOffered && req.chatId && req.runId
        ? withGoalSignals.then((res) => ({ ...res, text: appendTurnAsks(res.text, takeTurnAsks(turnNotesKey(req.chatId!, req.runId!))) }))
        : withGoalSignals;
    };
    /*
     * A dispatched turn that ends without its terminal event is unknown, not failed (RuntimeTurnUnsettledError).
     * The cause keeps changing (a background-wait tool, a login drop, a CLI update), so no cause is named here. The one
     * contract every runtime keeps is that a session id resumes the same conversation; the model sees its own history, so
     * completed effects are not repeated. This is the single point every runtime and every pass goes through (first call,
     * Goal continuation passes, One recovery passes): ONE host-authored turn into the SAME session, never the original
     * request again and never a stop for a human. If that turn is also unsettled, or the conversation cannot be resumed
     * (no handle, resume refused), the binding gets a new generation (agent-context retire: decideGeneration symptom
     * "resume_failed") and the failure surfaces exactly as before. The bound is structural: one continuation per call.
     * Owner stop/abort, a closed HTTP refusal and a locally rejected dispatch never continue.
     */
    const invokeCurrentRuntime = (request: RunnerRequest, hostAuthored?: string): Promise<Awaited<ReturnType<Runner>>> => {
      lastJournalTurnId = null;
      return invokeWithUnsettledContinuation<RunnerRequest>({
        dispatch(r, purpose, handle) { lastJournalTurnId = null; return runCurrentRuntimeOnce(r, purpose, handle); },
        continuationRequest: (r, sessionId, delivery) => {
          // The interrupted request rides along (with its images) unless the session acknowledged that turn: an accepted
          // request is in the resumed transcript and is not re-sent (runner.ts RuntimeTurnDelivery; owner 2026-10-16:
          // a follow-up that never reached the session was replaced by the fixed line and answered "nothing remains").
          const next = replaceRunnerUserPrompt(r, unsettledContinuationPrompt(runnerTurnContextSource(r)?.userPrompt ?? r.userPrompt, delivery),
            unsettledContinuationCarriesRequest(delivery) ? {} : { images: undefined });
          return carryRunnerTurnContext(next, { ...next, runtimeSessionId: sessionId });
        },
        eligible: !isAliveControllerRun && !scienceRecovery && !request.minimalObservation && !request.judgmentOnly && !request.untrustedNoTools,
        aborted: () => signal?.aborted === true,
        noModelWork: () => runtimeTerminalEvidence.closedHttpRefusal || runtimeTerminalEvidence.locallyRejected,
        leftBehind: () => (lastJournalTurnId ? agentContextUnsettledTurn(lastJournalTurnId) : null),
        record(phase, delivery) {
          if (req.runId) tryRecordRunEvent({ runId: req.runId, chatId: chat.id, kind: "runtime_unsettled_continuation",
            payload: { runtime: active.kind, phase, ...(delivery ? { turnDelivery: delivery } : {}) } });
        },
      }, request, hostAuthored);
    };
    let activeRunnerReq = runnerRequestForRuntime(active, picked);
    if (hostGeneratedImageAttachment) {
      activeRunnerReq = replaceRunnerUserPrompt(activeRunnerReq,
        `${runnerTurnContextSource(activeRunnerReq)?.userPrompt ?? activeRunnerReq.userPrompt}${hostGeneratedImageContext}`,
        { images: [...(req.images ?? []), hostGeneratedImageAttachment] });
    }
    modelTurnStarted = true;
    const nativeGoalEpisode = activeGoalId && req.runId && !executionContext && continuousMode
      ? captureNativeGoalEpisode(activeGoalId, chat.id, req.runId) : null;
    let goalEpisodeYield: NativeGoalEpisodeBinding | null = null;
    const passLoopStartedAtMs = Date.now();
    // A refusal before dispatch (turnDelivery "not-dispatched") reached no model: it is the typed failure below, never
    // "unsettled" (an unknown effect).
    let result = await invokeCurrentRuntime(activeRunnerReq, hostNoticePurpose);
    if (result.ownerControlTerminal !== "completed" && !runtimeTerminalEvidence.closedHttpRefusal && !runtimeTerminalEvidence.locallyRejected
      && result.turnDelivery !== "not-dispatched") {
      // The result (typed failure, session, delivery) is the cause; the provider's words lead the message (audit A7 M5).
      throw unsettledTurnError({ runtimeKind: active.kind, locale, cause: result, turnDelivery: result.turnDelivery });
    }
    /*
     * ★런타임이 표식으로 실패를 말했으면 그 text는 답이 아니다 — 거절 고지문이다.
     * 여기서 막지 않으면 고지문이 assistant 챗 답변으로 영속되고(appendChatMessage),
     * 그래프 agent 노드에서는 vars[produces]에 앉아 다음 단계의 입력이 된다
     * (실측 2026-08-06: "You've hit your weekly limit"이 노드 산출물이 될 뻔한 경로).
     * 이 한 관문이 One 챗과 그래프 노드 양쪽을 같이 지킨다 — throw는 기존 오류
     * 경로(sink error → NODE_FAILED/챗 오류 카드)를 그대로 탄다.
     */
    if (result.failure) {
      throw new InvocationRunnerFailureError(result.failure, true, result.turnDelivery);
    }
    // The first pass (including its predispatch runtime fallbacks) has consumed
    // its booked plan receipts. Later passes observe their normal budget/cadence.
    if (goalPlanContextSlot) goalPlanContextSlot.reservedDecisionIds = null;
    result = sanitizeRestrictedPass(result);
    advanceUsageFloor();
    // persistent goal 사이클 회계 — 매 패스를 원장에 기록하고(무진전·예산 감시),
    // "계속 여부"는 (모델 마커 OR goal 미달)의 OR로 정한다. 반대 방향도 있다:
    // 예산 소진·무진전 정지·명시 종료는 마커가 있어도 정지시킨다(폭주 방지, 사람 호출).
    let latestGoalDecision: GoalLedgerDecision | null = null;
    let goalHardStop: GoalLedgerDecision | null = null;
    // Local control-flow latch only. Does not complete or pause the durable Goal.
    let goalLiveContinuationParked = false;
    const parkFiniteGoalContinuation = (decision: GoalLedgerDecision): boolean => {
      if (!activeGoalId || executionContext || !finiteGoalContinuationIsParked({
        lifecycle: getChatGoalRevision(activeGoalId)?.lifecycle, status: decision.status,
      })) return false;
      if (!goalLiveContinuationParked) tryRecordRunEvent({
        runId: req.runId ?? `chat:${chat.id}`, chatId: chat.id, agentId: agent.id,
        // Existing follow-up backoff consumes this event; accounting work must
        // not reset its delay just because the native invocation completed.
        kind: "goal_idle_pass_yield", payload: { reason: "finite_goal_wait_boundary", status: decision.status },
      });
      goalLiveContinuationParked = true;
      return true;
    };
    /*
     * 완료 선언은 중간 패스에서 나올 수 있고, 그때 처리하지 않으면 두 가지가 깨진다.
     * ① 이 패스의 본문은 appendChatMessage로 즉시 영속되므로 마커가 대화에 남는다.
     * ② 원장이 아직 "미완"이라 goalDrivenPass가 계속 참이 되어, 모델이 매 패스
     *    "다 끝났다"고 말하는데 루프는 상한까지 도는 — 고치려던 것과 같은 무한
     *    진행이 형태만 바꿔 되돌아온다.
     * 그래서 여기서 바로 원장에 반영하고, 선언 사실은 루프 밖으로 들고 나간다.
     */
    let goalClaimSeen = false;
    let goalClaimEvidence: string | null = null;
    /** Consecutive transient failures on the current pass; reset by any pass that succeeds. */
    let passFailureTransientAttempts = 0;
    /** Runaway guard for the marker-driven path, which has no ledger to consult. */
    let lastPassFingerprint = "";
    let identicalPassStreak = 0;
    let lastPassToolCalls: number | null = null;
    let lastPassNovelObservations: number | null = null;
    let idleGoalPasses = 0;
    let passRecoveryNote: string | null = null;
    /**
     * Set when a failed pass stopped the loop while leaving the goal open and resumable. Returned to the
     * invocation service, which writes it into the long-run ledger with a scheduled retry
     * (long-run/goal-pass-stop.ts). Before 2026-09-24 nothing read it: the reset time died here.
     */
    let goalPassStop: GoalPassStop | null = null;
    const needsAutomationRegistration = (text: string): boolean => hasAutomationRegistrationHandoff(text, {
      agentAppMode: req.agentAppMode === true, division: chat.kind === "division",
      sessionAutomationId: req.automationId, backgroundAutomation: executionContext?.source === "automation",
      headlessFence: automationProtocolRead,
    });
    for (let pass = 2; pass <= maxPasses; pass += 1) {
      // The host must consume a schedule proposal before the Goal can judge its
      // receipt. Continuing inference here starves the registration below.
      if (needsAutomationRegistration(result.text)) break;
      // A structured external wait ends inference immediately. Only service
      // settlement may accept it; neither completion nor another live pass wins.
      if (activeGoalId && !executionContext && parseGoalWaitIntent(result.text).request) break;
      const rawContinuation = stripStormbreakerContinueMarker(result.text);
      // 전술·계획 표식은 이 패스에서 원장에 반영하고 본문에서 뗀다(패스 본문은 곧바로 영속된다).
      if (!roomMemberTurn) rawContinuation.text = applyGoalPlanMarkers({ goalId: activeGoalId, text: rawContinuation.text, runId: req.runId ?? null, signal }).text;
      const passClaim = stripGoalCompleteMarker(rawContinuation.text);
      if (passClaim.claimed) {
        goalClaimSeen = true;
        goalClaimEvidence = goalClaimEvidence ?? passClaim.evidence;
      }
      const continuation = { text: passClaim.text, shouldContinue: rawContinuation.shouldContinue };
      let passShouldContinue = continuation.shouldContinue;
      let goalDrivenPass = false;
      /*
       * 질문을 냈으면 이 턴은 사람 차례다 — 목표가 미달이라도 다음 패스를 돌리지 않는다.
       * 실측(페르소나 루프 2026-09-14, 오너 직접 지적): 목표 연속 실행이 질문 카드를 띄운 뒤에도 계속 돌아
       * 대화가 '실행 중'으로 남았고, 질문 시트는 "실행이 정리되면 전송"만 보이며 고른 답을 보내지 못했다.
       * 답이 오면 질문 연속 실행(questionContinuation)이 같은 목표를 이어간다.
       */
      const asksUser = turnAsksOwner(continuation.text);
      if (asksUser) passShouldContinue = false;
      if (activeGoalId && continuousMode && !signal?.aborted && !asksUser) {
        if (passClaim.claimed && !nativeGoalEpisode) {
          await closeOpenGoalLedgerTasks({
            goalId: activeGoalId,
            evidence: passClaim.evidence
              ?? `chat:${chat.id} pass:${pass - 1} ${goalProgressKeyForText(continuation.text)}`,
            projectDir: workforceProjectDir,
            outcomeText: continuation.text,
            invocationRunId: req.runId ?? null,
            deferVerificationUntilTerminal: true,
          });
        }
        latestGoalDecision = await recordGoalLedgerCycle({
          goalId: activeGoalId,
          usage: lastGoalUsage,
          progressText: continuation.text,
          progressAuthority: "one-host-receipts",
          outcome: passClaim.claimed
            ? "pass-goal-complete-claim"
            : passShouldContinue ? "pass-continue-marker" : "pass-final-output",
          projectDir: workforceProjectDir,
        }) ?? latestGoalDecision;
        if (latestGoalDecision) {
          if (parkFiniteGoalContinuation(latestGoalDecision)) {
            passShouldContinue = false;
          } else if (!latestGoalDecision.continue) {
            passShouldContinue = false;
            if (GOAL_HARD_STOP_REASONS.has(latestGoalDecision.reason)) goalHardStop = latestGoalDecision;
          } else if (!passClaim.claimed && !passShouldContinue && latestGoalDecision.continue) {
            // Codex 동형: 모델이 마커를 안 붙여도 goal이 미달이면 계속한다.
            passShouldContinue = true;
            goalDrivenPass = true;
          }
        }
      }
      // A completion claim belongs to terminal verification. An open Goal can
      // keep its mandate after that verification; it does not justify asking
      // this same native turn to complete the claimed work again.
      if (passClaim.claimed) passShouldContinue = false;
      // A pass the Goal ledger alone keeps alive has to show host-observed work. Production 2026-10-06, Youtube
      // launch: 273 continuous passes about 25 s apart, each a paraphrase of "the plan's assignment limits block
      // the remaining check; nothing done this turn", no tool call in any of them, the ledger answering "1 open
      // task" every time, 17.5k fresh input tokens a pass. Paraphrase defeats the identical-output guard below, so
      // the measure is the host's own count of completed tool calls. After GOAL_IDLE_PASS_LIMIT idle passes the
      // invocation ends; Main's verification and wake schedule decide when the Goal is looked at again.
      const idleStep = idleGoalPassStep({ continuousMode, goalDrivenPass, passShouldContinue, lastPassToolCalls, lastPassNovelObservations, idlePasses: idleGoalPasses });
      idleGoalPasses = idleStep.idlePasses;
      if (idleStep.yieldNow) {
        passShouldContinue = false;
        tryRecordRunEvent({ runId: req.runId ?? `chat:${chat.id}`, chatId: chat.id, agentId: agent.id,
          kind: "goal_idle_pass_yield", payload: { pass, idlePasses: idleGoalPasses } });
      }
      // Wall-clock bound (long-run/goal-pass-budget.ts): at this pass boundary no runtime turn or tool is in
      // flight. End the invocation instead of starting another pass; Main continues the open Goal from its ledger
      // and drains the owner steers queued meanwhile. The event is not goal_idle_pass_yield: that one backs the
      // follow-up off, and this turn made progress.
      const budgetStep = goalPassBudgetStep({ continuousMode, passShouldContinue, startedAtMs: passLoopStartedAtMs, nowMs: Date.now() });
      if (budgetStep.yieldNow && !signal?.aborted) {
        passShouldContinue = false;
        tryRecordRunEvent({ runId: req.runId ?? `chat:${chat.id}`, chatId: chat.id, agentId: agent.id,
          kind: "goal_pass_budget_yield", payload: { pass, elapsedMs: budgetStep.elapsedMs, budgetMs: GOAL_PASS_WALL_CLOCK_BUDGET_MS } });
      }
      // An unfinished ongoing invocation has no terminal/effect checkpoint of
      // its own. Goal unmet and prose/tool counts cannot authorize another pass.
      // Main verification chooses useful follow-up or a durable observation.
      if (nativeGoalEpisode && !asksUser && !signal?.aborted) {
        goalEpisodeYield = nativeGoalEpisode;
        passShouldContinue = false;
        tryRecordRunEvent({ runId: nativeGoalEpisode.invocationRunId, chatId: chat.id,
          kind: "goal_native_episode_yield", payload: { ...nativeGoalEpisode } });
      }
      /*
       * A marker-driven loop has no ledger to tell it that nothing is happening, so this is its only
       * runaway guard: output that has not changed at all for three passes running is not work.
       * Without it, raising the pass cap would hand a stuck model the person's machine.
       */
      if (!continuousMode) {
        // 숫자만 바뀐 "변화 없음"도 같은 결과다(goalProgressKeyForText 와 같은 정규화).
        const passFingerprint = continuation.text.trim() ? goalProgressKeyForText(continuation.text) : "";
        if (passFingerprint && passFingerprint === lastPassFingerprint) {
          identicalPassStreak += 1;
        } else {
          identicalPassStreak = 0;
          lastPassFingerprint = passFingerprint;
        }
        if (identicalPassStreak + 1 >= STORMBREAKER_MAX_IDENTICAL_PASSES) {
          sink({
            kind: "notice",
            notice: {
              level: "warning",
              code: "continuation-no-progress",
              message: locale === "ko"
                ? `${STORMBREAKER_MAX_IDENTICAL_PASSES}번 같은 결과가 반복돼 다음 단계에서 다른 접근으로 이어갑니다.`
                : `The last ${STORMBREAKER_MAX_IDENTICAL_PASSES} passes repeated the same result. The next step will use a different approach.`,
            },
          });
          passRecoveryNote = "Previous passes repeated unchanged results. Delegate diagnosis to a background worker and select another useful independent step. Keep uncertain actions unresolved and do not replay them.";
          identicalPassStreak = 0;
          passShouldContinue = true;
        }
      }
      // The owner wrote while this run worked (production 2026-10-05, Thread Marketing: a direction queued behind a
      // Goal's continuous run waited for the whole run). Stop at this pass boundary; Main then starts the owner's
      // turn from the queue and the Goal continues from there.
      if (passShouldContinue && !signal?.aborted && hasQueuedOwnerSteer(chat.id)) {
        passShouldContinue = false;
        tryRecordRunEvent({ runId: req.runId ?? `chat:${chat.id}`, chatId: chat.id, agentId: agent.id,
          kind: "owner_steer_pass_boundary", payload: { pass } });
      }
      if (!passShouldContinue || signal?.aborted) {
        result = { ...result, text: continuation.text };
        break;
      }
      result = { ...result, text: continuation.text };
      if (!continuousMode && continuation.text.trim()) {
        // 다음 패스가 확정된 순간에만 이전 패스 전문을 partial floor에 적립 —
        // 단일 패스(대다수)는 floor가 비어 있어 기존 경로와 완전히 동일하다.
        partialFloor = partialFloor ? `${partialFloor}\n${continuation.text}` : continuation.text;
      }
      if (continuousMode) {
        // 이 턴의 완료된 결과를 즉시 별도 assistant 메시지로 남긴다 — 화면엔 새 말풍선이
        // 계속 이어 붙는 것처럼 보이고, 앱이 중간에 꺼져도 그때까지 기록은 남는다.
        const passMemory = stripAllMemoryEventBlocks(continuation.text);
        carriedPassMemoryEvents.push(...passMemory.events);
        const committedPass = appendInvocationAssistantResult({
          chatId: chat.id,
          speakerAgentId: agent.id,
          text: stripStrayProtocolTokens(stripPermissionEscalationMarker(redactWorkAttachmentText(req, redactOneAttachmentText(req, passMemory.cleanedText)))),
          goalId: activeGoalId,
          runId: req.runId,
        });
        // 방금 저장한 본문은 더는 "흘러나오는 중"이 아니다 — Main 버퍼와 화면의 실시간 말풍선을
        // 이 행 id에서 끊는다. 없으면 다음 턴 첫 글자 전에 끊긴 실행이 같은 본문을
        // "중단된 답변"으로 또 저장했다(2026-09-27 X 마케팅 실측).
        sink(livePartialCommitBoundary(committedPass.id));
        // 세션 워터마크 전진 — 다음 resume 턴이 방금 자기 답변을 gap으로 재주입하지 않게.
        if (sessionCapableRuntime) touchRuntimeSession(chat.id, active.kind, agent.id);
        sink({
          kind: "tool-use",
          status: goalDrivenPass
            ? locale === "ko"
              ? `목표 미달 · ${pass}턴째 계속 (남은 작업 ${latestGoalDecision?.openTaskCount ?? 0}건)`
              : `Goal not reached · continuing pass ${pass} (${latestGoalDecision?.openTaskCount ?? 0} open tasks)`
            : locale === "ko" ? `계속 진행 중 · ${pass}턴째 (안 끊기고 이어짐)` : `Continuing · pass ${pass} (uninterrupted)`,
        });
      }
      stormbreaker?.continuePass({
        pass,
        reason: goalDrivenPass
          ? "goal ledger reports the goal is not achieved yet"
          : "runner reported more safe Stormbreaker work remains",
      });
      const nextRunnerReq = runnerRequestForRuntime(active, picked!);
      // Journal-backed and native-session runs already hold the previous pass and receive the turn context (Goal contract) each pass.
      const passCarriesContext = persistentAgentContext || sessionCapableRuntime;
      const baseContinuationPrompt = goalDrivenPass
        ? buildGoalDrivenContinuationPrompt({
            pass,
            objective: passCarriesContext && goalContractInContext ? null : latestGoalDecision?.objective ?? null,
            openTaskCount: latestGoalDecision?.openTaskCount ?? 0,
            previousOutput: passCarriesContext ? null : result.text,
            typedGoalTools: goalTypedToolsReplaceText,
          })
        : buildStormbreakerContinuationPrompt(passCarriesContext ? null : result.text, pass);
      // Composition order (ledger desktop.main.user.goal-continuation): continuation request, the plan note (task), then
      // this pass's recovery note (turn).
      const planNote = !goalPlanContextSlot && activeGoalId ? goalPlanContinuationNote(activeGoalId, Date.now(), goalTypedToolsReplaceText) : null;
      const continuationPrompt = [baseContinuationPrompt, planNote, passRecoveryNote].filter(Boolean).join("\n\n");
      // Remote Hub text remains user authority; rebase the exact current host context without string stripping.
      activeRunnerReq = replaceRunnerUserPrompt(nextRunnerReq, explicitBorrowUserPreamble
        ? `${explicitBorrowUserPreamble}\n\nContinuation request:\n${continuationPrompt}`
        : continuationPrompt, { images: undefined });
      /*
       * The previous pass completed. A next pass that never reached the model (refused before dispatch: a locked store, a
       * session its previous process still held, a missing executable) does not turn the whole Goal turn into a failure:
       * the turn ends with the completed pass (`result` keeps it) and the Goal continues on its own schedule. Production
       * 2026-10-18 (Yotube Goal turn fd5f52e7): a turn whose earlier pass had completed ended red. What may have reached
       * the model surfaces.
       */
      const novelObservationsBeforePass = novelToolObservations;
      const toolCallsBeforePass = completedToolCalls;
      try {
        result = await invokeCurrentRuntime(activeRunnerReq, "goal-continuation");
      } catch (error) {
        if (signal?.aborted || !runnerRefusedBeforeDispatch(error)) throw error;
        tryRecordRunEvent({ runId: req.runId ?? "", chatId: req.chatId ?? "", kind: "goal_pass_not_started",
          payload: { pass, code: refusalCode(error) ?? null, turnDelivery: "not-dispatched" } });
        break;
      }
      // A returned refusal before dispatch is a typed pass failure (retried or handed on below), never "unsettled".
      if (result.ownerControlTerminal !== "completed" && !runtimeTerminalEvidence.closedHttpRefusal && !runtimeTerminalEvidence.locallyRejected
        && result.turnDelivery !== "not-dispatched") {
        const error = unsettledTurnError({ runtimeKind: active.kind, locale, cause: result, turnDelivery: result.turnDelivery });
        throw error;
      }
      // A failed pass is retried or handed on below; it is not an idle pass.
      lastPassToolCalls = result.failure ? null : completedToolCalls - toolCallsBeforePass;
      lastPassNovelObservations = result.failure ? null : novelToolObservations - novelObservationsBeforePass;
      if (result.failure) {
        /*
         * A failed pass is not the end of the goal.
         *
         * Throwing here escaped the loop, and nothing downstream scheduled a successor -- so a goal
         * meant to run for hours died on the first hiccup, and the person saw the product give up.
         * Measured on a real 25.9-hour orchestration: four turns failed (a model at capacity, two
         * rejected parameters, one usage limit) and the work continued past every one of them.
         *
         * The next move comes from the typed failure marker, never the wording, because vendor
         * notices change on every release and a run must not start dying because a sentence moved.
         */
        const verdict = passFailureVerdict(result.failure, passFailureTransientAttempts);
        tryRecordRunEvent({
          runId: req.runId ?? "",
          chatId: req.chatId ?? "",
          kind: "goal_pass_failed",
          payload: {
            pass,
            action: verdict.action,
            reason: verdict.reason,
            runtime: result.failure.runtime,
            failureKind: result.failure.kind,
            ...(verdict.retryAfterHint ? { retryAfterHint: verdict.retryAfterHint } : {}),
          },
        });
        if (verdict.action === "retry") {
          passFailureTransientAttempts += 1;
          sink({
            kind: "tool-use",
            status: locale === "ko"
              ? `${pass}턴째가 실패해 ${Math.round(verdict.retryAfterMs / 1000)}초 뒤 같은 턴을 다시 시도합니다.`
              : `Pass ${pass} failed; retrying the same pass in ${Math.round(verdict.retryAfterMs / 1000)}s.`,
            activity: { code: "goal_pass_retry" },
          });
          await waitForPassRetry(verdict.retryAfterMs, signal);
          if (signal?.aborted) break;
          pass -= 1;
          continue;
        }
        if (activeGoalId) {
          const resetMs = result.failure.kind === "quota" ? parseRetryHint(verdict.retryAfterHint, Date.now()) : null;
          goalPassStop = {
            goalId: activeGoalId,
            reason: verdict.reason,
            action: verdict.action,
            failureKind: result.failure.kind,
            runtime: result.failure.runtime,
            ...(verdict.retryAfterHint ? { retryAfterHint: verdict.retryAfterHint } : {}),
            ...(resetMs !== null ? { retryAfterAt: new Date(resetMs).toISOString() } : {}),
          };
          recordGoalPlanPassStop(activeGoalId, goalPassStopCause(goalPassStop), req.runId ?? null);
        }
        sink({
          kind: "notice",
          notice: {
            level: "warning",
            code: `goal-pass-${verdict.action}`,
            message: locale === "ko"
              ? `${pass}턴째에서 멈췄습니다(사유: ${verdict.reason}). 목표는 살아 있고 남은 예산도 그대로입니다${verdict.retryAfterHint ? ` — 런타임 안내: ${verdict.retryAfterHint}` : ""}.`
              : `Stopped at pass ${pass} (${verdict.reason}). The goal is still open with its remaining budget${verdict.retryAfterHint ? ` — runtime says: ${verdict.retryAfterHint}` : ""}.`,
          },
        });
        break;
      }
      passFailureTransientAttempts = 0;
      result = sanitizeRestrictedPass(result);
      advanceUsageFloor();
    }
    // ── One 완주 규범 ─────────────────────────────────────────────
    // 도구 한 번의 실패 흔적이 남은 채로 턴을 "다시 해달라"로 끝내지 않는다.
    // 같은 대화 안에서 스스로 복구 패스를 돌려 막힌 단계를 재실행하고 결과까지
    // 완주한다. 복구 패스가 도구 성공 증거를 남기고 무오류로 끝났을 때에만
    // 실패 흔적을 지운다 — 말로만 "됐다"고 하는 가짜 성공은 통과하지 못한다.
    if (oneTeamExecutionPolicy && !req.agentAppMode && !needsAutomationRegistration(result.text) && !parseGoalWaitIntent(result.text).request) {
      const ONE_RECOVERY_MAX_PASSES = 2;
      for (let attempt = 1; attempt <= ONE_RECOVERY_MAX_PASSES && observedOneToolFailure && !signal?.aborted; attempt += 1) {
        sink({
          kind: "tool-use",
          status: locale === "ko" ? "막힌 단계를 다시 진행하는 중…" : "Retrying a blocked step…",
          activity: { code: "recovery_retry" },
        });
        if (!continuousMode && result.text.trim()) {
          partialFloor = partialFloor ? `${partialFloor}\n${result.text}` : result.text;
        }
        passToolFailures = 0;
        passToolSuccesses = 0;
        const nextRunnerReq = runnerRequestForRuntime(active, picked!);
        const recoveryPrompt = buildOneRecoveryPrompt(result.text, attempt, locale);
        activeRunnerReq = replaceRunnerUserPrompt(nextRunnerReq, explicitBorrowUserPreamble
          ? `${explicitBorrowUserPreamble}\n\nContinuation request:\n${recoveryPrompt}`
          : recoveryPrompt, { images: undefined });
        result = await invokeCurrentRuntime(activeRunnerReq, "run-recovery");
        if (result.failure) {
          throw new InvocationRunnerFailureError(result.failure);
        }
        result = sanitizeRestrictedPass(result);
        advanceUsageFloor();
        if (hasOneRecoveryDecision(result.text)) {
          oneRecoveryDecisionPending = true;
          break;
        }
        observedOneToolFailure = oneToolFailures.unresolved();
      }
      if (observedOneToolFailure && !oneRecoveryDecisionPending && !signal?.aborted) {
        sink({
          kind: "tool-use",
          status: locale === "ko" ? "실행 가능한 해결안을 준비하는 중…" : "Preparing an actionable solution…",
        });
        const nextRunnerReq = runnerRequestForRuntime(active, picked!);
        const recoveryDecisionPrompt = buildOneRecoveryDecisionPrompt(result.text, locale);
        activeRunnerReq = replaceRunnerUserPrompt(nextRunnerReq, explicitBorrowUserPreamble
          ? `${explicitBorrowUserPreamble}\n\nContinuation request:\n${recoveryDecisionPrompt}`
          : recoveryDecisionPrompt, { images: undefined });
        result = await invokeCurrentRuntime(activeRunnerReq, "run-recovery");
        if (result.failure) {
          throw new InvocationRunnerFailureError(result.failure);
        }
        result = sanitizeRestrictedPass(result);
        advanceUsageFloor();
        oneRecoveryDecisionPending = hasOneRecoveryDecision(result.text);
        if (!oneRecoveryDecisionPending) {
          result = { ...result, text: wrapOneRecoveryProposal(result.text, locale) };
          oneRecoveryDecisionPending = true;
        }
        if (oneRecoveryDecisionPending) partialFloor = "";
      }
    }
    const automationHandoff = needsAutomationRegistration(result.text);
    const waitProposal = !executionContext && activeGoalId ? parseGoalWaitIntent(result.text) : { text: result.text, request: null };
    const goalWaitRequest = waitProposal.request;
    // Fast/single-pass Goal turns need the same terminal custody as live passes.
    if (nativeGoalEpisode && !goalEpisodeYield && !goalWaitRequest && !automationHandoff
      && !signal?.aborted && !turnAsksOwner(result.text)) {
      goalEpisodeYield = nativeGoalEpisode;
      tryRecordRunEvent({ runId: nativeGoalEpisode.invocationRunId, chatId: chat.id,
        kind: "goal_native_episode_yield", payload: { ...nativeGoalEpisode } });
    }
    result = { ...result, text: waitProposal.text };
    const finalContinuation = stripStormbreakerContinueMarker(result.text);
    // 전술·계획 표식 회수도 모든 경로가 지나는 이 한 지점에서 한다(완료 선언과 같은 이유).
    if (!roomMemberTurn) finalContinuation.text = applyGoalPlanMarkers({ goalId: activeGoalId, text: finalContinuation.text, runId: req.runId ?? null, signal }).text;
    // 완료 선언 회수는 **모든 경로가 지나는 이 한 지점**에서 한다. 패스 루프 안에서만
    // 떼면 agentAppMode(maxPasses=1)나 One 복구 패스로 끝난 턴에서 마커가 사용자에게
    // 그대로 나간다 — 제어 표식이 답변에 새는 계열의 결함을 새로 만드는 셈이다.
    const finalClaim = stripGoalCompleteMarker(finalContinuation.text);
    // 중간 패스에서 이미 선언했으면 그 사실은 마지막 본문에 남아 있지 않다 —
    // 루프가 그 패스에서 마커를 떼어 냈기 때문이다. 선언은 OR로 합친다.
    const goalCompletion = {
      text: finalClaim.text,
      claimed: !goalWaitRequest && (finalClaim.claimed || goalClaimSeen),
      evidence: finalClaim.evidence ?? goalClaimEvidence,
    };
    const finalAsksOwner = turnAsksOwner(finalContinuation.text);
    let stormbreakerContinueRequested = !req.agentAppMode && !goalWaitRequest && !automationHandoff && !finalAsksOwner
      && finalContinuation.shouldContinue;
    result = { ...result, text: goalCompletion.text };
    // ── persistent goal 최종 판정 (L2: continue = 모델마커 OR goal 미달) ──────
    // 라이브 루프가 이미 사이클을 기록했으면 그 판정을 재사용하고, 아니면(비-continuous
    // 경로·read 경계 등) 여기서 한 사이클을 기록해 회계를 이어간다. goal 미달이면 마커
    // 없이도 연속실행이 예약되고, 예산/정지/종료는 마커보다 우선한다.
    if (!goalWaitRequest && !automationHandoff && !req.agentAppMode && activeGoalId && chat.kind !== "division" && !signal?.aborted) {
      /*
       * ★순서가 계약이다. 선언을 원장에 반영한 **뒤에** 판정을 읽는다.
       * 반대로 하면 방금 닫은 task가 안 보이는 낡은 판정으로 완료를 놓치고,
       * 라이브 루프가 이미 기록해 둔 판정도 같은 이유로 폐기해야 한다.
       */
      if (goalCompletion.claimed && !goalEpisodeYield) {
        await closeOpenGoalLedgerTasks({
          goalId: activeGoalId,
          // 근거를 안 적었으면 감사 가능한 대체값을 넣는다. 근거를 필수로 하면
          // 맨 마커가 조용히 무시돼 "완료가 안 되는" 원래 결함이 되돌아온다.
          evidence: goalCompletion.evidence
            ?? `chat:${chat.id} ${goalProgressKeyForText(goalCompletion.text)}`,
          projectDir: workforceProjectDir,
          outcomeText: goalCompletion.text,
          invocationRunId: req.runId ?? null,
          deferVerificationUntilTerminal: true,
        });
        latestGoalDecision = null;
      }
      {
        latestGoalDecision = await recordGoalLedgerCycle({
          goalId: activeGoalId,
          usage: lastGoalUsage,
          progressText: goalCompletion.text,
          progressAuthority: "one-host-receipts",
          outcome: goalCompletion.claimed
            ? "turn-goal-complete-claim"
            : stormbreakerContinueRequested ? "turn-continue-marker" : "turn-final-output",
          projectDir: workforceProjectDir,
        });
      }
      if (goalLiveContinuationParked) stormbreakerContinueRequested = false;
      if (latestGoalDecision) {
        if (goalLiveContinuationParked || parkFiniteGoalContinuation(latestGoalDecision)) {
          stormbreakerContinueRequested = false;
        } else if (!stormbreakerContinueRequested && latestGoalDecision.continue && !finalAsksOwner) {
          stormbreakerContinueRequested = true;
        } else if (
          stormbreakerContinueRequested &&
          !latestGoalDecision.continue
        ) {
          stormbreakerContinueRequested = false;
          if (GOAL_HARD_STOP_REASONS.has(latestGoalDecision.reason)) goalHardStop = latestGoalDecision;
        }
      }
      /*
       * 완료 확정 — 세 신호가 모두 같은 말을 할 때만이다.
       *   ① 모델이 근거와 함께 완료를 선언했고
       *   ② 더 할 일이 있다고 하지 않았고
       *   ③ 호스트 원장에도 미완 항목이 없다.
       * ③은 ①이 만들어 준 상태이지만 원장이 독립적으로 되읽은 값이다 —
       * 예산 소진·무진전 정지 상태에서는 사유가 달라 여기 들어오지 못한다.
       * 선언만으로 닫지 않는 이유: 그러면 모델의 한마디가 곧 완료가 되어
       * "영원히 안 끝남"을 "너무 일찍 끝남"으로 바꿔치기할 뿐이다.
       */
      if (goalCompletionVerdict({
        claimed: goalCompletion.claimed,
        continueRequested: stormbreakerContinueRequested,
        ledgerReason: latestGoalDecision?.reason,
      })) {
        const closed = await completeGoalLedgerGoal({
          goalId: activeGoalId,
          status: "completed",
          reason: "model-declared-verified-no-open-tasks",
          projectDir: workforceProjectDir,
        });
        if (closed) {
          // 목표 칩을 내린다 — 끝난 goal이 계속 켜져 있으면 다음 메시지가
          // 죽은 캠페인에 붙는다.
          try {
            clearChatGoalBindingByGoalId(activeGoalId);
          } catch {
            /* 바인딩 정리 실패가 완료 자체를 되돌리지는 않는다. */
          }
          // 조용한 완료는 고장과 구분되지 않는다 — 정지 사유를 알리는 것과 같은 이유로 알린다.
          sink({
            kind: "tool-use",
            tool: {
              name: "Goal Loop · complete",
              result: locale === "ko"
                ? `목표를 완료로 닫았습니다${goalCompletion.evidence ? ` (근거: ${goalCompletion.evidence})` : ""}. 목표 칩은 내려갑니다 — 새 목표는 다시 켜서 시작하세요.`
                : `Goal closed as completed${goalCompletion.evidence ? ` (evidence: ${goalCompletion.evidence})` : ""}. The goal chip is now off — re-enable it to start a new one.`,
            },
          });
        }
      }
    }
    if (goalHardStop) {
      // 정지 사유를 숨기지 않는다 — 조용한 정지는 고장과 구분되지 않는다.
      sink({
        kind: "tool-use",
        tool: {
          name: "Goal Loop · stopped",
          result: locale === "ko"
            ? `목표의 사용자 정지 또는 종료 상태를 따릅니다 (${goalHardStop.reason}).`
            : `Respecting the goal’s owner stop or terminal state (${goalHardStop.reason}).`,
        },
      });
    }
    // continuousMode는 안전 상한(20,000턴)이 사실상 안 걸리므로 정상적으론 이 분기에 안 들어온다.
    // 혹시라도 상한에 닿았는데 아직 할 일이 있다고 하면(진짜 폭주 등) 작업을 잃지 않도록 기존
    // 백그라운드 자동화로 안전하게 이어받는다. persistent goal 채팅은 goal 미달이기만 해도
    // (마커 없이) 여기로 들어와 앱 재시작·크래시 뒤에도 목표가 계속 돈다.
    if (!req.agentAppMode && stormbreakerContinueRequested && chat.kind !== "division" && canWrite
      && (!activeGoalId || getChatGoalRevision(activeGoalId)?.lifecycle !== "ongoing")) {
      const assertContinuationGoalCurrent = (): void => {
        throwIfInvocationAborted(signal, locale);
        if (!activeGoalId) return;
        if (activeGoalRevision == null) {
          throw new AutomationWorkspaceError("automation_workspace_creation_source_unverified");
        }
        assertFiniteGoalLifecycleCurrent({ goalId: activeGoalId, rootChatId: chat.id,
          expectedRevision: activeGoalRevision });
      };
      try {
        assertContinuationGoalCurrent();
        const marker = `Source chat: ${chat.id}`;
        // goal_id 1급 조회가 먼저다 — 프롬프트 마커 문자열 검색은 goal_id 없는 레거시
        // 연속실행의 폴백으로만 남는다. goal당 연속실행은 정확히 한 행이다.
        const goalContinuation = activeGoalId ? findAutomationByGoalId(activeGoalId) : null;
        const foundContinuation = goalContinuation
          ?? listAutomations().find(
            (automation) => automation.enabled && automation.promptTemplate.includes(marker),
          );
        // W1 (2026-10-18): a Goal is bound only to a continuation that can wake under it. Production: "Goal continuation ·
        // Yotube" (834c86d9) was held by the schedule quarantine (enabled, next_run_at NULL) and this lookup re-bound it
        // to the next /goal Goal, so every turn end of that Goal fell to goal_continuation_unarmed. A re-bound row can
        // never run anyway: its creation receipt names the old Goal and definition (automation-provenance.ts), so the
        // Goal owner check refuses it. Another Goal's or a legacy row is therefore left as it is and a new continuation is
        // created. This Goal's row is reused only when its receipt names this Goal and the schedule quarantine does not
        // hold it, otherwise a new one replaces it; one that only lost its cursor is armed again, as a disabled one always
        // was.
        const sameGoalContinuation = activeGoalId && foundContinuation?.goalId === activeGoalId ? foundContinuation : undefined;
        const ownedByThisGoal = (automation: { id: string }): boolean => {
          try {
            const goalRun = getLongRunByGoalId(activeGoalId!);
            return Boolean(goalRun && currentAutomationGoalExecutionOwnerMatches(automation.id, activeGoalId!, chat.id, goalRun.id));
          } catch { return false; }
        };
        const continuationWake = !sameGoalContinuation ? "ok"
          : !ownedByThisGoal(sameGoalContinuation) ? "unowned"
            : (await import("../store/graph-reconciliation")).graphScheduleWakeState(sameGoalContinuation);
        const existingContinuation = !activeGoalId ? foundContinuation
          : continuationWake === "ok" || continuationWake === "unarmed" ? sameGoalContinuation : undefined;
        const replacedContinuation = continuationWake === "held" || continuationWake === "unowned"
          ? sameGoalContinuation ?? null : null;
        // A hidden continuation is a new invocation, not a trusted continuation
        // of the current process. Pin an explicit single Hub hire as a Hub target
        // so the scheduler performs a fresh authoritative hepCall on every run.
        const continuationHubSlug = borrowedAgentSlugs.length === 1 ? borrowedAgentSlugs[0] : null;
        const continuationHubVersion = continuationHubSlug
          ? explicitBorrowSpecs.find((spec) => spec.slug === continuationHubSlug)?.packageHash
          : undefined;
        if (continuationHubSlug && !continuationHubVersion) {
          throw Object.assign(new Error("automation_hub_release_pin_missing"), {
            code: "automation_hub_release_pin_missing",
          });
        }
        if (existingContinuation) {
          getDb().transaction(() => {
            assertContinuationGoalCurrent();
            if (continuationHubSlug &&
              (existingContinuation.targetType !== "hub" || existingContinuation.targetId !== continuationHubSlug
                || existingContinuation.targetVersion !== continuationHubVersion)) {
              // A changed definition still requires its normal execution-owner
              // review; this update never issues an ownership receipt.
              updateAutomation(existingContinuation.id, {
                targetType: "hub",
                targetId: continuationHubSlug,
                ...(continuationHubVersion ? { targetVersion: continuationHubVersion } : {}),
              });
            }
            if (activeGoalId && (!existingContinuation.enabled || continuationWake === "unarmed")) {
              toggleAutomation(existingContinuation.id, true);
            }
          })();
        }
        if (!existingContinuation) {
          const continuationSchedule = activeGoalId
            ? goalContinuationSchedule(latestGoalDecision)
            : STORMBREAKER_LONG_RUN_SCHEDULE;
          getDb().transaction(() => {
            assertContinuationGoalCurrent();
            if (activeGoalId && !req.runId) {
              throw new AutomationWorkspaceError("automation_workspace_creation_source_unverified");
            }
            const continuation = createAutomation({
              name: activeGoalId
                ? `Goal continuation · ${chat.title || agent.name}`
                : `Stormbreaker continuation · ${chat.title || agent.name}`,
              scheduleHuman: continuationSchedule,
              targetType: continuationHubSlug ? "hub" : chat.firmId ? "firm" : "agent",
              targetId: continuationHubSlug ?? chat.firmId ?? chat.agentId,
              // Main recovery may have selected another connected engine. Copy
              // that final validated engine before sealing the creation receipt.
              runtimeSelection: selectionForRuntime(active, {
                longContext: active.longContextEnabled ?? undefined,
              }),
              ...(continuationHubVersion ? { targetVersion: continuationHubVersion } : {}),
              promptTemplate: buildStormbreakerLongRunPrompt({
                sourceChatId: chat.id,
                previousOutput: result.text,
                userPrompt: req.userPrompt,
                workingFolder,
              }),
              createdBy: "agent",
              ...(activeGoalId ? { goalId: activeGoalId } : {}),
            });
            if (activeGoalId) bindCreatedGoalContinuationWorkspace({
              automationId: continuation.id,
              goalId: activeGoalId,
              sourceChatId: chat.id,
              invocationRunId: req.runId!,
            });
            if (replacedContinuation) {
              // A held row this Goal owns could wake beside the new one once its effects are reconciled: only its clock
              // stops (history and uncertain-effect record stay). A row whose receipt names another Goal can never run
              // under this one and is left exactly as it is (its cleanup is the owner's call).
              const retired = continuationWake === "held" && replacedContinuation.enabled;
              if (retired) toggleAutomation(replacedContinuation.id, false);
              tryRecordRunEvent({ runId: req.runId!, chatId: chat.id, automationId: replacedContinuation.id,
                kind: "goal_continuation_replaced", payload: { goalId: activeGoalId,
                  reasonCode: continuationWake === "held" ? "goal_continuation_schedule_held" : "goal_continuation_owner_unverified",
                  replacementAutomationId: continuation.id, retired } });
            }
          })();
          sink({
            kind: "tool-use",
            tool: {
              name: activeGoalId ? "Goal Loop · long-run" : "Stormbreaker Loop · long-run",
              result: activeGoalId
                ? `The goal is not achieved yet. Queued a hidden ${continuationSchedule} goal continuation that keeps running until the goal ledger reports completion, budget exhaustion, or an explicit end.`
                : `More safe work remains after ${STORMBREAKER_MAX_EXECUTION_PASSES} immediate passes. Queued a hidden ${STORMBREAKER_LONG_RUN_SCHEDULE} continuation that reuses its own durable session and disables itself when the marker stops.`,
            },
          });
        }
      } catch (error) {
        /*
         * The lifecycle barrier refused a further dispatch (independent review 2026-10-04: the long
         * run was still `verifying` its last effects). That refusal is about the NEXT pass; this
         * turn's answer is already complete. Throwing here failed the finished turn, so it was saved
         * as an interrupted answer. Withhold the continuation (the transactions above rolled back,
         * nothing was created or re-enabled) and finish the turn; every other error still throws.
         * A creation receipt that cannot be sealed (AutomationWorkspaceError: this turn is not bound to the Goal's
         * revision) is the same kind of refusal. Since W1 (2026-10-18) a held or foreign continuation is no longer
         * silently re-bound, so creation is reached more often, and it must not fail a complete answer either.
         */
        if (!isGoalDispatchRefusal(error) && !(error instanceof AutomationWorkspaceError)) throw error;
        sink({
          kind: "tool-use",
          tool: {
            name: "Goal Loop · continuation withheld",
            result: locale === "ko"
              ? `목표가 지금은 다음 실행을 받을 수 없는 상태라 이어받기를 예약하지 않았습니다 (${error.code}). 이번 답변은 그대로 완료됩니다.`
              : `The goal cannot take another run right now, so no continuation was queued (${error.code}). This answer stands as completed.`,
          },
        });
      }
    }

    // Chat must not auto-escalate into App/Workbench generation. If a model emits
    // the legacy surface-intent marker, strip it below instead of doing a second
    // app/surface pass.

    // 항상-켜진 큐레이터: 답변 끝의 "## Memory Events" 블록을 파싱해 안전·스코프·중복 처리 후
    // 내구 메모리에 기록하고, 사용자에게 보이는 텍스트에서는 그 블록을 제거한다(추가 LLM 호출 없음).
    let displayText = result.text.split(SURFACE_INTENT_MARKER).join("").trim();
    let oneFriendlyFollowups: OneFriendlyFollowupPlanV1 | null = null;
    if (req.oneMode === true) {
      const followupParse = parseOneFriendlyFollowups(displayText);
      displayText = followupParse.cleanedText;
      oneFriendlyFollowups = followupParse.plan;
      if (followupParse.error) {
        console.warn(`[one-followups] rejected ${followupParse.error}`);
      }
    }
    // 에이전트가 "## Automation" 블록을 넣었으면 → 현재 chat의 타깃(firm/agent)으로 자동화 등록 + 블록 제거.
    // (백그라운드 automation 실행 세션은 제외 → 자동화가 자동화를 만드는 재귀 방지)
    const automationRegistrations: AutomationRegistrationResult[] = [];
    // 거부 사유. 모델의 본문은 이미 확정된 뒤에 게이트가 도는 구조라, 모델은 "바꿨다"고
    // 써 놓고 호스트가 거부하는 조합이 나온다(실측 2026-08-19: 831자 고정 문구 교체 지시에
    // 답변은 "replaced", graph_json은 무변경). 그러면 **호스트가 직접 말해야** 한다.
    const automationRefusals: string[] = [];
    let automationPermissionRequired = false;
    if (req.agentAppMode) {
      // Browser output is untrusted display text. Strip host control envelopes
      // without executing or persisting them.
      try {
        displayText = parseAutomations(displayText).cleanedText;
      } catch {
        // Malformed blocks remain ordinary text and never reach registration.
      }
      displayText = parseMemoryEvents(displayText).cleanedText;
    } else if (
      chat.kind !== "division" ||
      // 자동화 세션 채팅은 division 이다 — 편집 계약(위 req.automationId 주입)이 시킨
      // `## Automation` 방출을 여기서 소비하지 않으면 계약 전체가 죽은 경로가 된다.
      // (백그라운드 자동화 실행이 자동화를 낳는 재귀는 executionContext 로 계속 차단)
      (req.automationId && executionContext?.source !== "automation")
    ) {
      try {
        const { automations: autos, cleanedText, errors } = parseAutomations(displayText, { headlessFence: automationProtocolRead });
        if (errors.length > 0) {
          // 조용히 드롭하지 않고 표면화(설계 §2.5) — 로그로 남겨 진단 가능하게.
          console.warn("[automation] parse warnings:", errors.join("; "));
          automationRefusals.push(...errors);
        }
        if (autos.some(a=>a.action!=="pause") && !canWrite) {
          automationPermissionRequired = true;
          sink({
            kind: "tool-use",
            tool: {
              name: "automation.permission-required",
              args: JSON.stringify({ requested: autos.length, requiredPermission: "write" }),
              result: automationPermissionRequiredText(locale),
            },
          });
        } else if (autos.length > 0) {
          sink({
            kind: "tool-use",
            status:
              locale === "ko"
                ? `자동화 ${autos.length}개 설정 중`
                : `Setting up ${autos.length} automation${autos.length === 1 ? "" : "s"}`,
          });
        }
        for (const a of !signal?.aborted ? autos.filter(a=>canWrite || a.action==="pause") : []) {
          if (a.action) {
            const operationId = `host-automation:${randomUUID()}`;
            const toolName = a.action === "pause" ? "automation.pause" : "automation.resume";
            sink({kind:"tool-use",tool:{id:operationId,name:toolName,args:JSON.stringify({automationId:a.automationId,action:a.action})}});
            try {
              const applied = applyAutomationLifecycle({parsed:a,chatId:chat.id,sessionAutomationId:req.automationId,canWrite});
              const row = applied.automation;
              const registration: AutomationRegistrationResult = {action:applied.action,enabled:row.enabled,
                activeRunStopRequested:applied.activeRunStopRequested,automationId:row.id,name:row.name,
                timezone:row.timezone ?? null,notificationPolicy:row.monitor?.notificationPolicy ?? "every_run",
                executionAvailability:"app-running",schedule:row.scheduleHuman,targetType:row.targetType,targetId:row.targetId,
                nextRunAt:row.nextRunAt,graph:Boolean(row.graph)};
              automationRegistrations.push(registration);
              sink({kind:"tool-use",tool:{id:operationId,name:toolName,isError:false,args:JSON.stringify(registration),
                result:automationRegistrationResultText(registration,locale)}});
            } catch (error) {
              const reason = error instanceof Error ? error.message : "automation_lifecycle_failed";
              const message = automationLifecycleRefusalText(reason,locale);
              automationRefusals.push(message);
              sink({kind:"tool-use",tool:{id:operationId,name:toolName,isError:true,args:JSON.stringify({automationId:a.automationId,action:a.action,reasonCode:reason}),result:message}});
            }
            continue;
          }
          // 등록 시점 구조 게이트 — 정의·사유는 automation-emitter의
          // automationRegistrationGateProblems (순수 함수, 하네스와 동일 코드 객체).
          const gateProblems = automationRegistrationGateProblems(a);
          if (gateProblems.length > 0) {
            automationRefusals.push(`${a.name}: ${gateProblems.join(" / ")}`);
            sink({
              kind: "tool-use",
              tool: {
                name: "automation-registration-refused",
                isError: true,
                result: gateProblems.join(" / "),
              },
            });
            continue;
          }
          // 모델이 "agent" 필드로 실행 주체를 지정하면 설치 에이전트로 해석(id → slug → 표시명).
          // 미지정/미해석이면 기존처럼 현재 챗 타깃 — 오케스트레이터 챗에서 만든 자동화가 항상
          // 오케스트레이터에 묶여 매 실행 라우팅 홉을 타던 문제의 수정.
          const named = a.agent ? resolveInstalledAgentLoose(a.agent) : null;
          const hubAgent = a.hubAgent?.trim();
          const targetType = hubAgent ? "hub" : named ? "agent" : chat.firmId ? "firm" : "agent";
          const targetId = hubAgent || (named ? named.id : (chat.firmId ?? chat.agentId));
          let dup;
          try {
            dup = resolveAutomationRegistrationTarget({ parsed: a, automations: listAutomations(), chatId: chat.id,
              ...(req.automationId ? {sessionAutomationId:req.automationId}:{}) });
          } catch (error) {
            const reason = error instanceof Error ? error.message : "automation_identity_invalid";
            automationRefusals.push(`${a.name}: ${reason}`);
            sink({kind:"tool-use",tool:{name:"automation-registration-refused",isError:true,result:reason}});
            continue;
          }
          const monitoring = automationRegistrationMonitoring({parsed:a,chatId:chat.id,messageId:persistedUserMessageId,existing:dup});
          const registrationOperationId = `host-automation:${randomUUID()}`;
          // A refused or failed registration answers its own started tool row and is said to the owner (refusal notice below).
          // Measured 2026-10-17 (dev A/B4): a finite-Goal refusal threw out of this loop into a log-only catch, leaving
          // "자동화 1개 설정 중" open, the reply's "등록 결과 대기" unanswered, and every later entry in the block unregistered.
          let startedTool: "automation.create" | "automation.update" | null = null;
          try {
            if (dup) {
              startedTool = "automation.update";
              sink({kind:"tool-use",tool:{id:registrationOperationId,name:"automation.update",args:JSON.stringify({automationId:dup.id,name:a.name})}});
              const updated = updateAutomation(dup.id, {
                ...monitoring,
                ...(a.monitor ? {endAt:a.monitor.deadline}:{}),
                // schedule 은 방출됐을 때만 — 미방출(graph-only 세션 편집)의 schedule 은
                // resolveSchedule 폴백("daily-09:00")이라, 그대로 쓰면 진짜 스케줄을 지워버린다.
                ...(a.scheduleEmitted
                  ? {
                      scheduleHuman: a.schedule,
                      // schedule_json은 항상 방출값으로 — stale spec이 새 토큰을 덮는 것 방지.
                      scheduleJson: a.scheduleSpec ? JSON.stringify(a.scheduleSpec) : null,
                    }
                  : {}),
                // 타깃은 방출이 실행 주체를 실었을 때만 재계산 — graph-only 편집이 기존 타깃을
                // 현재 챗 타깃으로 몰래 바꾸면 안 된다.
                ...(a.agent || a.hubAgent || a.prompt ? { targetType, targetId } : {}),
                ...(a.prompt ? { promptTemplate: a.prompt } : {}),
                // tz는 방출됐을 때만 갱신(미방출 재방출이 기존 tz를 시스템 tz로 되돌리지 않게).
                ...(a.tz && a.tz.trim() ? { timezone: a.tz } : {}),
              });
              // 그래프는 방출됐을 때만 교체 — 사용자가 캔버스에서 편집한 그래프를 지우지 않는다.
              const updatedWithGraph = a.graph ? updateAutomationGraph(dup.id, a.graph) : updated;
              const registration: AutomationRegistrationResult = {
                action: "updated",
                enabled: updatedWithGraph.enabled,
                automationId: updatedWithGraph.id,
                timezone: updatedWithGraph.timezone ?? null,
                notificationPolicy: updatedWithGraph.monitor?.notificationPolicy ?? "every_run",
                executionAvailability: "app-running",
                name: updatedWithGraph.name,
                schedule: updatedWithGraph.triggerType === "poll" ? (locale === "ko" ? "조건 변화 확인" : "Check for condition changes") : updatedWithGraph.scheduleHuman,
                targetType: updatedWithGraph.targetType,
                targetId: updatedWithGraph.targetId,
                nextRunAt: updatedWithGraph.nextRunAt,
                graph: Boolean(updatedWithGraph.graph),
              };
              automationRegistrations.push(registration);
              sink({
                kind: "tool-use",
                tool: {
                  id: registrationOperationId,
                  isError: false,
                  name: automationRegistrationToolName(registration.action),
                  args: JSON.stringify({
                    automationId: registration.automationId,
                    action: registration.action,
                    enabled: registration.enabled,
                    nextRunAt: registration.nextRunAt,
                    timezone: registration.timezone,
                    notificationPolicy: registration.notificationPolicy,
                    executionAvailability: registration.executionAvailability,
                    name: registration.name,
                    schedule: registration.schedule,
                    targetType: registration.targetType,
                    targetId: registration.targetId,
                    graph: registration.graph,
                  }),
                  result: automationRegistrationResultText(registration, locale),
                },
              });
            } else if (!a.prompt.trim() && a.graph) {
              // graph-only 방출(세션 편집 계약)이 이름 불일치로 여기 떨어지면, 빈 프롬프트·폴백
              // 스케줄의 반쪽 자동화가 생긴다. 만들지 말고 이름이 틀렸다고 말한다.
              sink({
                kind: "tool-use",
                tool: {
                  name: "automation-registration-refused",
                  isError: true,
                  result: `No automation named "${a.name}" exists to update — a graph-only block must keep the session automation's exact name.`,
                },
              });
            } else {
              startedTool = "automation.create";
              sink({kind:"tool-use",tool:{id:registrationOperationId,name:"automation.create",args:JSON.stringify({name:a.name})}});
              const creationRevision = activeGoalId ? getChatGoalRevision(activeGoalId) : null;
              const finiteCreation = creationRevision?.lifecycle === "finite";
              // A failed finite binding must roll back creation, never leave an independent automation behind.
              const { created, unboundReason } = desktopStoreTransaction(getDb(), () => {
                const finiteDeadline = finiteCreation && activeGoalId ? goalDeadlineAt(activeGoalId) : null;
                // A Goal-made automation ends at its finite Goal's deadline. A finite Goal with no host-resolved deadline
                // (a single-tactic shape has none) was asked for standing work that outlives it, so that automation is
                // created unbound (harness decision 2026-10-17; dev A/B4 O2 was refused here). Each refusal cause keeps
                // its own code for the owner's refusal text.
                const boundFinite = finiteCreation && finiteDeadline !== null;
                const unboundReason = finiteCreation && !boundFinite ? "goal_automation_unbound_no_deadline" as const : null;
                if (boundFinite && Date.parse(finiteDeadline!) <= Date.now()) throw new Error("goal_automation_finite_deadline_passed");
                if (boundFinite && (creationRevision.chatId !== chat.id || typeof req.runId !== "string"))
                  throw new Error("goal_automation_binding_source_unverified");
                if (boundFinite) assertFiniteGoalLifecycleCurrent({ goalId: activeGoalId!,
                  rootChatId: chat.id, expectedRevision: creationRevision.revision });
                const created = createAutomation({
                ...monitoring,
                ...(a.monitor ? {endAt:a.monitor.deadline}:{}),
                ...(finiteDeadline ? { endAt: a.monitor?.deadline && Date.parse(a.monitor.deadline) < Date.parse(finiteDeadline)
                  ? a.monitor.deadline : finiteDeadline } : {}),
                name: a.name,
                // The chat's runtime at this moment is copied as the job's pin. It is a
                // copy, not a separate owner choice: unattended runs follow the owner's
                // *current* chat/worker configuration (automation-runtime-plan.ts) until
                // the owner edits the pin itself. Recorded below as agent_copy.
                ...(req.runtimeSelection ? { runtimeSelection: req.runtimeSelection } : {}),
                scheduleHuman: a.schedule,
                targetType,
                targetId,
                promptTemplate: a.prompt,
                createdBy: "agent",
                // 구조화 스케줄 + steps→그래프를 통과시켜 챗 생성 자동화가 graph_json/schedule_json을 저장.
                scheduleJson: a.scheduleSpec ? JSON.stringify(a.scheduleSpec) : null,
                timezone: a.tz && a.tz.trim() ? a.tz : null,
                graphJson: a.graph ?? null,
              });
                if (req.runtimeSelection) recordAutomationPinProvenance(created.id, "agent_copy", "chat_registration");
                // Only this newly created row and its genuine invocation may acquire a bridge.
                if (activeGoalId && typeof req.runId === "string" && creationRevision?.chatId === chat.id) {
                  if (boundFinite) {
                    bindCreatedAutomationToGoal({ goalId: activeGoalId, expectedGoalRevision: creationRevision.revision,
                      chatId: chat.id, invocationRunId: req.runId, automationId: created.id });
                  } else if (creationRevision.lifecycle === "ongoing") {
                    try { bindCreatedAutomationToGoal({ goalId: activeGoalId, expectedGoalRevision: creationRevision.revision,
                      chatId: chat.id, invocationRunId: req.runId, automationId: created.id }); }
                    catch (error) { console.warn("[goal-automation-provenance] created automation remains independent:", error); }
                  }
                }
                return { created, unboundReason };
              }).immediate();
              if (unboundReason && typeof req.runId === "string") tryRecordRunEvent({ runId: req.runId, chatId: chat.id, kind: "goal_automation_unbound",
                payload: { schemaVersion: "agentlas.goal-automation-unbound.v1", goalId: activeGoalId, automationId: created.id, reasonCode: unboundReason } });
              const registration: AutomationRegistrationResult = {
                action: "created",
                enabled: created.enabled,
                automationId: created.id,
                timezone: created.timezone ?? null,
                notificationPolicy: created.monitor?.notificationPolicy ?? "every_run",
                executionAvailability: "app-running",
                name: created.name,
                schedule: created.triggerType === "poll" ? (locale === "ko" ? "조건 변화 확인" : "Check for condition changes") : created.scheduleHuman,
                targetType: created.targetType,
                targetId: created.targetId,
                nextRunAt: created.nextRunAt,
                graph: Boolean(created.graph),
              };
              automationRegistrations.push(registration);
              sink({
                kind: "tool-use",
                tool: {
                  id: registrationOperationId,
                  isError: false,
                  name: automationRegistrationToolName(registration.action),
                  args: JSON.stringify({
                    automationId: registration.automationId,
                    action: registration.action,
                    enabled: registration.enabled,
                    nextRunAt: registration.nextRunAt,
                    timezone: registration.timezone,
                    notificationPolicy: registration.notificationPolicy,
                    executionAvailability: registration.executionAvailability,
                    name: registration.name,
                    schedule: registration.schedule,
                    targetType: registration.targetType,
                    targetId: registration.targetId,
                    graph: registration.graph,
                    ...(unboundReason ? { goalBindingReasonCode: unboundReason } : {}),
                  }),
                  result: automationRegistrationResultText(registration, locale),
                },
              });
            }
          } catch (error) {
            const reason = automationRegistrationReasonCode(error);
            if (reason === "automation_registration_failed") console.error("[automation] registration failed:", error);
            const message = automationRegistrationRefusalText(reason, locale);
            automationRefusals.push(`${a.name}: ${message}`);
            sink({kind:"tool-use",tool:{...(startedTool ? {id:registrationOperationId,name:startedTool} : {name:"automation-registration-refused"}),
              isError:true,args:JSON.stringify({name:a.name,reasonCode:reason}),result:message}});
          }
        }
        displayText = cleanedText;
      } catch (err) {
        console.error("[automation] parseAutomations failed:", err);
      }
    }
    // 호스트가 하는 말은 답변 본문에 이어붙이지 않는다 — 자기 행(notice)으로 나간다.
    if (automationRegistrations.length > 0) {
      sink({
        kind: "notice",
        notice: {
          level: "success",
          message: automationFinalSummary(automationRegistrations, locale),
          i18n: {
            ko: automationFinalSummary(automationRegistrations, "ko"),
            en: automationFinalSummary(automationRegistrations, "en"),
          },
          code: "automation-registered",
        },
      });
    }
    // 거부는 성공보다 더 크게 말해야 한다 — 본문이 "바꿨다"고 주장하는 동안 아무것도 안 바뀐 상태다.
    if (automationRefusals.length > 0) {
      const ko = `요청한 변경은 적용되지 않았습니다 — 등록 게이트가 거부했습니다.\n${automationRefusals.join("\n")}\n답변 본문이 적용됐다고 말하더라도 자동화는 그대로입니다.`;
      const en = `The requested change was NOT applied — the registration gate refused it.\n${automationRefusals.join("\n")}\nEven if the reply says it was applied, the automation is unchanged.`;
      sink({
        kind: "notice",
        notice: {
          level: "warning",
          message: locale === "ko" ? ko : en,
          i18n: { ko, en },
          code: "automation-registration-refused",
        },
      });
    }
    if (automationPermissionRequired) {
      sink({
        kind: "notice",
        notice: {
          level: "warning",
          message: automationPermissionRequiredText(locale),
          i18n: {
            ko: automationPermissionRequiredText("ko"),
            en: automationPermissionRequiredText("en"),
          },
          code: "automation-permission-required",
        },
      });
    }
    try {
      const surfaceParse = parseSurfaces(displayText);
      if (surfaceParse.diagnostics.some((diagnostic) => diagnostic.code === "surface-parse-failed")) {
        // 예전에는 이 문장을 **답변 본문에 대입**했다. 호스트의 사과가 모델의 답 행세를
        // 하던 자리 — 이제는 고지 행으로 나가고 본문은 남기지 않는다.
        emitHostNotice(sink, {
          level: "error",
          message: locale === "ko"
            ? "결과를 정리하는 중 문제가 생겨 이번 응답을 완성하지 못했어요."
            : "Something went wrong while preparing this result, so it is not complete.",
          i18n: { ko: "결과를 정리하는 중 문제가 생겨 이번 응답을 완성하지 못했어요.", en: "Something went wrong while preparing this result, so it is not complete." },
          code: "surface-parse-failed",
        });
        displayText = "";
      } else {
        const parsedOneSurface = req.oneMode === true
          && surfaceParse.errors.length === 0
          && surfaceParse.surfaces.length === 1
          ? sealOneLocalArtifactPaths(surfaceParse.surfaces[0].manifest, resolvedResultFolder)
          : null;
        const rawDeterministicOneSurface = req.oneMode === true
          && oneTeamExecutionPolicy
          ? buildOneSurfaceFromMarkdown({
              // A model may append an invalid hidden Surface after an otherwise
              // useful cited answer. The parser already removed that untrusted
              // block; keep the clean visible Markdown eligible for the same
              // deterministic, closed validator instead of discarding both.
              markdown: surfaceParse.cleanedText.trim() || displayText,
              fallbackTitle: chat.title,
              taskPrompt: req.userPrompt,
              observedSourceUrls: [...observedOneSourceUrls],
              allowUncitedStructured: observedOneToolEvidence,
              // The resident judge picks the surface layout by meaning; an
              // unavailable verdict keeps the neutral generic layout.
              judgedIntent: await resolveOneMarkdownSurfaceIntent(req.userPrompt ?? "").catch(
                () => undefined,
              ),
            })
          : null;
        const deterministicOneSurface = rawDeterministicOneSurface
          ? sealOneLocalArtifactPaths(rawDeterministicOneSurface, resolvedResultFolder)
          : null;
        const oneSurface = chooseOneSurfaceForDisplay(parsedOneSurface, deterministicOneSurface);
        const usedDeterministicOneSurface = Boolean(
          deterministicOneSurface && oneSurface === deterministicOneSurface,
        );
        // A pretty manifest cannot turn a failed required tool step into a
        // successful One result. Keep the manifest out of the renderer and
        // finish this invocation through the failure channel below.
        if (oneSurface && !oneToolFailureBlocksCompletion()) {
          sink({
            kind: "surface",
            surfaceId: `surface:${req.runId ?? chat.id}:1`,
            surface: oneSurface,
            runtimeAgentId,
            agentName: agent.name,
            role: "orchestrator",
            tier: 1,
            phase: "synthesize",
            ...(oneFriendlyFollowups ? { oneFriendlyFollowups } : {}),
          });
        }
        if (oneToolFailureBlocksCompletion() && !oneRecoveryDecisionPending) {
          // The model did not produce a valid executable confirmation even
          // after the dedicated decision pass. Keep the run fail-closed.
          displayText = locale === "ko"
            ? "실행 가능한 해결안을 안전하게 구성하지 못해 이 실행은 완료로 표시하지 않았습니다."
            : "This run is not marked complete because an executable solution could not be formed safely.";
        } else if (usedDeterministicOneSurface && deterministicOneSurface) {
          // 모델이 쓴 결과 본문이 답이다 — 어느 채널이든(Codex 패리티, 오너 결정 2026-08-15).
          // 예전에는 카드가 있는 화면에 "요청한 결과와 파일을 준비했어요. 아래에서 바로 확인할
          // 수 있어요."라는 완료 문구를 **답변으로 저장**하고 진짜 답은 카드 안 Narrative에만
          // 남겼다(실측: 카드는 마크다운을 평문으로 그려 링크·코드펜스가 깨졌고, 재방문
          // 스레드에는 답이 없었다). 본문이 비었을 때만 완료 문구로 되돌아간다.
          const modelText = surfaceParse.cleanedText.trim();
          displayText = modelText
            || deterministicOneCompletionCopy(req.userPrompt, deterministicOneSurface, locale);
        } else if (surfaceParse.surfaces.length > 0 || surfaceParse.errors.length > 0) {
          displayText =
            surfaceParse.cleanedText.trim() ||
            (parsedOneSurface
              ? locale === "ko"
                ? "요청하신 결과를 정리했어요."
                : "Here's your result."
              : locale === "ko"
                ? "여기 채팅으로 답변을 정리해 드렸어요."
                : "I've written the answer here in chat.");
        }
      }
    } catch {
      // Defensive fallback for failures outside an individual manifest. Never
      // retain or log the rejected model body because it may contain a local
      // path or another Main-private Surface transport value.
      //
      // 호스트의 사과는 답변 본문이 아니라 고지 행으로 나간다(2026-08-08).
      emitHostNotice(sink, {
        level: "error",
        message: locale === "ko"
          ? "결과를 정리하는 중 문제가 생겨 이번 응답을 완성하지 못했어요."
          : "Something went wrong while preparing this result, so it is not complete.",
        i18n: { ko: "결과를 정리하는 중 문제가 생겨 이번 응답을 완성하지 못했어요.", en: "Something went wrong while preparing this result, so it is not complete." },
        code: "surface-pipeline-failed",
      });
      displayText = "";
      console.error("[surface] parseSurfaces failed");
    }
    if (!req.agentAppMode || projectReadOnlyBoundary) {
      try {
        const curationContext = {
          turnId: memoryTurnId,
          // Activated read identity scopes the DB episode even when this turn
          // cannot write project files. The read-only curator path records only
          // a one-way hash and never appends project artifacts.
          projectPath: memoryReadPath,
          projectId: memoryScope.projectId,
          agentId: memoryScope.agentId,
          chatId: chat.id,
          runId: req.runId,
          cwdAtRequest: workingFolder,
          experienceIntake: {
            platform: process.platform,
            arch: process.arch,
            runtimeKind: active.kind,
            basePackageHash: agent.packageHash ?? null,
            taskHint: hostWrotePrompt() ? null : effectiveUserPrompt,
          },
          // 단일 borrow 실행 — 빌린 에이전트의 agent_repo 배움을 그 전역 둥지로 미러링.
          borrowedAgentSlugs:
            activeBorrowedOwnerScopeKey() === explicitBorrowOwnerScopeKey
              ? explicitBorrowMemoryKeys
              : [],
        };
        // Notes the model recorded through the agentlas-turn memory_note tool join the parsed envelope's events.
        const toolMemoryNotes = takeTurnMemoryNotes(req.chatId && req.runId ? turnNotesKey(req.chatId, req.runId) : null);
        const semanticOptions = projectReadOnlyBoundary
          ? {}
          : await runSemanticMemoryReview({
              extraEvents: toolMemoryNotes,
              replyText: displayText,
              runner: picked.runner,
              backendLabel: picked.label,
              model: active.model ?? undefined,
              effort: active.effort ?? undefined,
              env: runnerEnv.env,
              locale,
              signal,
              hasProject: Boolean(memoryReadPath),
              hasAgent: Boolean(agent.id),
              ...(isAutomationLedgerChat(curationContext.chatId) ? { sourceSurface: "automation-run" as const } : {}),
            });
        const { cleanedText } = projectReadOnlyBoundary
          ? stripReplyMemoryEventsReadOnly(
              displayText,
              curationContext,
              restrictedDiscardedMemoryEvents + toolMemoryNotes.length,
            )
          : curateReply(displayText, curationContext, { ...semanticOptions, carriedEvents: [...toolMemoryNotes, ...carriedPassMemoryEvents] });
        // Restricted cleanup may intentionally remove the entire response. Never
        // restore the raw control block through the ordinary empty-text fallback.

        // 그때 원문(봉투)을 되살리면 제어 블록이 화면에 그대로 뜬다. 봉투의 turn_summary 가 유일한 사람 말이면 그것을 답으로.
        const envelopeOnlySummary = !cleanedText.trim()
          ? (parseMemoryEvents(displayText).turnSummary?.trim() || /turn_summary\s*:\s*"([^"\n]{1,300})"/.exec(displayText)?.[1]?.trim() || "")
          : "";
        displayText = projectReadOnlyBoundary ? cleanedText : cleanedText || envelopeOnlySummary || displayText;
      } catch (err) {
        console.error("[architecture] curateReply failed:", err);
        try {
          recordTerminalMemoryTurn({
            turnId: memoryTurnId,
            projectPath: req.agentAppMode ? null : memoryReadPath,
            projectId: req.agentAppMode ? null : memoryScope.projectId,
            agentId: memoryScope.agentId,
            chatId: chat.id,
            runId: req.runId,
            cwdAtRequest: req.agentAppMode ? null : workingFolder,
            borrowedAgentSlugs:
              activeBorrowedOwnerScopeKey() === explicitBorrowOwnerScopeKey
                ? explicitBorrowMemoryKeys
                : [],
          }, "curation_failed");
        } catch (ticketError) {
          console.error("[memory] curation failure receipt failed:", ticketError);
        }
        const stripped = stripAllMemoryEventBlocks(displayText).cleanedText.trim();
        displayText = stripped || (locale === "ko"
          ? "응답은 완료됐지만 메모리 제어 블록을 안전하게 정리하지 못해 본문을 숨겼습니다."
          : "The response completed, but its memory control block could not be safely finalized, so the body was withheld.");
      }
    }

    // A successful direct Hub borrow is a first-class owner career event. The
    // immutable identity came from the exact runtime bundle prepared for this
    // invocation; a mid-run account switch suppresses both career and memory
    // writes instead of assigning the result to the newly active account.
    if (
      !oneToolFailureBlocksCompletion()
      && activeBorrowedOwnerScopeKey() === explicitBorrowOwnerScopeKey
    ) {
      for (const spec of explicitBorrowSpecs) {
        recordBorrowedAgentCareer({
          ownerScopeKey: explicitBorrowOwnerScopeKey,
          slug: spec.slug,
          agentDefinitionId: spec.agentDefinitionId!,
          agentReleaseId: spec.agentReleaseId!,
          entityKind: spec.entityKind,
          source: spec.source ?? "hub",
          localized: spec.localized!,
          runId: req.runId ?? `chat:${chat.id}:turn:${memoryTurnId}`,
          resolution: {
            runtime: active,
            source: runtimeChoice.override ? "manual-override" : "safe-fallback",
          },
        });
      }
    }

    // 컴팩션 요약 수집 — Claude Code가 이번 세션에서 컨텍스트를 자동 압축했다면 그 요약을
    // 큐레이터 인테이크(session/hypothesis) 티어로만 흘려보낸다. 심사·승격은 Curator 에이전트 몫.
    // 실패-무해: 트랜스크립트가 없거나(다른 런타임) 요약이 없으면 조용히 0건.
    try {
      if (!req.agentAppMode && !projectReadOnlyBoundary && result.sessionId) {
        harvestCompactionSummaries({
          sessionId: result.sessionId,
          cwd: workingFolder,
          ctx: {
            runId: req.runId,
            projectPath: memoryReadPath,
            projectId: memoryScope.projectId,
            agentId: memoryScope.agentId,
            chatId: chat.id,
            cwdAtRequest: workingFolder,
            experienceIntake: {
              platform: process.platform,
              arch: process.arch,
              runtimeKind: active.kind,
              basePackageHash: agent.packageHash ?? null,
              taskHint: hostWrotePrompt() ? null : effectiveUserPrompt,
            },
          },
        });
      }
    } catch (err) {
      console.error("[architecture] harvestCompactionSummaries failed:", err);
    }

    // App generation from chat is disabled: do not append Apps CTAs or route
    // ordinary chat output into installed/generated App surfaces.

    // Stormbreaker 최종 게이트 — 답변 표출 직전 리뷰/증거 게이트(비차단·실패-무해).
    if (stormbreaker) {
      await stormbreaker.finish({ workspace: workingFolder ?? undefined, permission: req.permissions });
    }

    // 다중 패스(비-continuousMode)면 이전 패스 전문을 접두 — 라이브에서 보이던 본문/도구
    // 앵커 좌표계가 final에서도 유지된다. 단일 패스는 floor가 비어 그대로.
    const displayWithFloor = stripDanglingLanguageFence(redactWorkAttachmentText(req, redactOneAttachmentText(
      req,
      partialFloor ? `${partialFloor}\n${displayText}` : displayText,
    )));
    const pendingFinalImages = !req.agentAppMode
      ? pendingWorkToolImages.splice(0, pendingWorkToolImages.length).map((item) => item.image)
      : [];
    const promotedImages = !effectObservationRun && !req.agentAppMode && req.runId
      ? promoteBoundOneMarkdownImages({
          text: displayWithFloor, chatId: chat.id, runId: req.runId, images: pendingFinalImages,
        })
      : { text: displayWithFloor, images: pendingFinalImages };
    const boundImageDisplayWithFloor = promotedImages.text;
    /*
     * 권한 승격 표식은 저장 본문에서 지운다 — 화면/승인칩 감지는 final 이벤트
     * (displayWithFloor 원문)를 받는 invocation service 가 맡는다. 히스토리 새로고침
     * 때 표식 줄이 되살아나지 않게 하는 것이 이 한 줄의 전부다.
    */
    const finalDisplay = applyFinalDisplayBackstop(boundImageDisplayWithFloor, {
      locale: pickLocale(req),
      allowSurfaceRender: !req.agentAppMode,
    });
    const persistedDisplay = stripStrayProtocolTokens(stripPermissionEscalationMarker(
      effectObservationRun ? stripEffectObservationMarker(finalDisplay.durableText) : finalDisplay.durableText));
    const finalWorkImages = promotedImages.images;
    if (imageGenerationRequired && (!observedImageArtifactEvidence || finalWorkImages.length === 0) && !signal?.aborted) {
      throw new Error("image_tool_unavailable: the generated image was not durably bound");
    }
    // 찍어 달라고 한 실행이 이미지 하나 없이 끝나면, 답이 무슨 말을 했든 사실이 아니다.
    if (screenCaptureRequired && !blindVisionRuntime && !nativeCaptureBound && finalWorkImages.length === 0 && !signal?.aborted) {
      throw new Error("screen_capture_unavailable: the requested screen capture was never produced");
    }
    const finalImageOptions = finalWorkImages.length > 0 ? { images: finalWorkImages } : undefined;
    let durableAssistantEntry: ReturnType<typeof appendChatMessage> | null = null;
    if (!effectObservationRun && !req.agentAppMode) {
      /*
       * ★빈 답은 빈 말풍선으로 남기지 않는다 — 대화창 하단에 아무것도 안 적힌 잔해만
       * 쌓이고, 사용자는 그것을 "끝난 자리"로 읽는다(실측 2026-08-15: 다중 패스 루프의
       * 중간 턴이 길이 0 assistant 메시지로 저장됨).
       * 삼키지도 않는다 — 빈 답 자체가 진단 신호이므로 사실은 원장에 남긴다.
       */
      if ((hostNoticePurpose === "one-delegation-review" || hostNoticePurpose === "one-checkin") && isOneQuietReply(persistedDisplay)) {
        // One decided the owner does not need to hear anything: nothing is saved and no alert fires (run-alerts).
        tryRecordRunEvent({ runId: req.runId ?? `chat:${chat.id}`, kind: "one_quiet_reply", chatId: chat.id, agentId: agent.id,
          payload: { purpose: hostNoticePurpose } });
      } else if (persistedDisplay.trim() || finalImageOptions?.images?.length) {
        durableAssistantEntry = appendInvocationAssistantResult({
          chatId: chat.id,
          speakerAgentId: agent.id,
          text: persistedDisplay,
          goalId: activeGoalId,
          runId: req.runId,
          options: finalImageOptions,
        });
      } else {
        tryRecordRunEvent({
          runId: req.runId ?? `chat:${chat.id}`,
          kind: "invoke_result",
          chatId: chat.id,
          agentId: agent.id,
          payload: { phase: "chat", emptyDisplayText: true, runtime: active.kind },
        });
      }
      for (const sourcePath of generatedImageSourcePaths) removeGeneratedImageArtifact(sourcePath);
      generatedImageSourcePaths.clear();
      // 세션 워터마크 전진 — 이 kind의 세션은 방금 답변까지 봤다. 다음 resume 턴의
      // gap-replay가 자기 답변을 중복 주입하지 않고, 스웜/다른 러너 턴만 메우게 된다.
      if (sessionCapableRuntime) touchRuntimeSession(chat.id, active.kind, agent.id);
    }
    /*
     * ★어느 세대가 실제로 돌았는지 기록한다 (오너 2026-09-07: "버전 바뀌어도 알아서
     * 읽게 해라"). claude-code 는 모델 목록 명령이 없어 우리가 보낼 수 있는 것이 벤더
     * 별칭(`opus`)뿐이고 화면에도 그것만 보였다. 실행 결과가 실제 id 를 싣고 오므로
     * 그것을 남긴다 — 벤더가 세대를 올리면 다음 실행이 알아서 덮는다. 우리가 적는 값은 없다.
     */
    /*
     * ★기본값으로 돌린 실행도 기록한다 (QA 실측 2026-09-08).
     *
     * 처음에는 `active.model` 이 있을 때만 기록했다. 그런데 오케스트레이터 행을
     * **"엔진 설정 사용"**(모델 미지정)으로 두고 쓰는 것이 기본 사용법이고, 그 경우
     * active.model 은 비어 있다. 그래서 claude-code 로 5번을 완주해도 화면은 계속
     * "Anthropic · Claude Code" 였고 사용량 패널은 "모델 미상" 이었다 —
     * **기본값으로 쓰는 사람은 영원히 못 보는 구조**였다.
     *
     * 모델 미지정 실행의 관측값은 빈 별칭("")에 기록한다. 그것이 곧 "이 런타임의
     * 기본 선택이 실제로 무엇으로 풀렸는가" 이고, 피커의 "엔진 설정 사용" 행이 그걸 쓴다.
     */
    if (result.observedModel) {
      const alias = active.model ?? "";
      if (result.observedModel !== alias) {
        setResolvedCliModelAlias(active.kind, alias, result.observedModel);
        try {
          recordResolvedAlias(active.kind, alias, result.observedModel);
        } catch {
          // 저장 실패는 이번 세션의 표시를 막지 않는다(메모리 레지스트리는 이미 갱신됐다).
        }
      }
    }
    const finalObservedTokens = Math.max(result.tokens ?? 0, liveUsageHigh);
    const invocationObservedUsage = currentInvocationObservedUsage();
    if (finalObservedTokens > 0) {
      // A runner-owned `null` is authoritative: it means no explicit effort
      // reached the provider. Only runners that predate `appliedEffort` may
      // fall back to the resolved runtime selection.
      const recordedEffort = Object.prototype.hasOwnProperty.call(result, "appliedEffort")
        ? result.appliedEffort ?? null
        : active.effort ?? null;
      tryRecordRunEvent({
        runId: req.runId ?? `chat:${chat.id}`,
        kind: "invoke_result",
        chatId: chat.id,
        agentId: agent.id,
        payload: {
          invocationId: memoryTurnId,
          modelRole: invocationModelRole,
          provider: active.backend ?? active.kind,
          /*
           * ★실행이 알려준 모델이 있으면 그것을 적는다 (QA 실측 2026-09-08:
           * 사용량 패널이 `Orch · anthropic · **모델 미상** · … · 3` — 실행 3건이
           * 집계됐는데 모델이 미상이었다).
           *
           * 원인은 "모델 미지정으로 돌렸으니 적을 모델이 없다"였다. 하지만 우리는 실제로
           * 무엇이 돌았는지 **알고 있다** — 러너가 result.observedModel 로 알려준다.
           * 요청값(비어 있음)이 아니라 관측값을 적는다. Claude는 관측이 없으면
           * 요청 별칭으로 추정하지 않고 미상으로 남긴다(재개 세션이 다른 모델일 수 있다).
           */
          // Claude's requested alias is not proof of what a resumed native session ran.
          // If its per-turn assistant events supplied no unambiguous model, record unknown.
          model: result.observedModel ?? (active.kind === "claude-code" ? null : active.model ?? null),
          // Persist the exact effort that the runner applied. The model may
          // have clamped a stale UI value (for example Spark max -> xhigh), so
          // the runner result is authoritative; the resolved runtime value is
          // only the fallback for runtimes that do not return one.
          effort: recordedEffort,
          tokens: finalObservedTokens,
          measurement: active.kind === "codex" ? "output-delta-or-visible-estimate" : "output-only",
          phase: "chat",
        },
      });
    }
    if (oneToolFailureBlocksCompletion() && !oneRecoveryDecisionPending) {
      sink({
        kind: "error",
        error: {
          code: "one-required-step-failed",
          message: locale === "ko"
            ? "한 단계가 끝까지 확인되지 않아 완료로 표시하지 않았습니다."
            : "One step was not fully verified, so this is not marked complete.",
        },
      });
      return {
        finalText: boundImageDisplayWithFloor,
        tokens: result.tokens,
        observedUsage: invocationObservedUsage,
        stormbreakerContinueRequested,
        ...(goalWaitRequest ? { goalWaitRequest } : {}),
      ...(goalEpisodeYield ? { goalEpisodeYield } : {}),
        goalCompletionClaim: {
          claimed: goalCompletion.claimed,
          evidence: goalCompletion.evidence,
          goalId: activeGoalId,
        },
        ...(goalPassStop ? { goalPassStop } : {}),
        resultFolder: resolvedResultFolder,
        workforcePrepareReceipt,
      };
    }
    // 연속 패스에서 result.tokens는 마지막 패스만 반영 — 라이브 누적 최고치와 큰 쪽을 확정치로.
    sink({
      kind: "final",
      // The universal sink wrapper below is the single trust boundary that
      // derives the typed request and strips the wire markers before delivery.
      text: boundImageDisplayWithFloor,
      durableTextForVerification: persistedDisplay,
      ...(durableAssistantEntry
        ? { durableAssistantMessageIdForVerification: durableAssistantEntry.id }
        : {}),
      tokens: finalObservedTokens || undefined,
      ...(invocationObservedUsage ? { observedUsage: invocationObservedUsage } : {}),
      model: active.model ?? active.kind,
      observedModel: result.observedModel,
      modelRole: invocationModelRole,
      ...(durableAssistantEntry?.imageDataUrls?.length
        ? { imageDataUrls: durableAssistantEntry.imageDataUrls }
        : {}),
    });
    return {
      finalText: boundImageDisplayWithFloor,
      tokens: result.tokens,
      observedUsage: invocationObservedUsage,
      stormbreakerContinueRequested,
      ...(goalWaitRequest ? { goalWaitRequest } : {}),
      ...(goalEpisodeYield ? { goalEpisodeYield } : {}),
      goalCompletionClaim: {
        claimed: goalCompletion.claimed,
        evidence: goalCompletion.evidence,
        goalId: activeGoalId,
      },
      ...(goalPassStop ? { goalPassStop } : {}),
      resultFolder: resolvedResultFolder,
      workforcePrepareReceipt,
      // C38 — 계획이 아니라 **결과**를 돌려준다. 관문 파일을 만들어 놓고 실행이 다른
      // 경로로 갔으면 등급은 여기서 내려간다.
      ...(toolBroker
        ? {
            toolBroker: toolBrokerInstalled
              ? { level: toolBroker.plan.level, reason: toolBroker.plan.reason }
              : {
                  level: "observed" as const,
                  reason: "이 실행은 중개 관문을 걸 수 없는 경로로 갔습니다 — 기록만 남습니다.",
                },
          }
        : {}),
    };
  } catch (err) {
    for (const sourcePath of generatedImageSourcePaths) removeGeneratedImageArtifact(sourcePath);
    generatedImageSourcePaths.clear();
    if (login?.waiting) return earlyResult();
    if (modelTurnStarted) {
      try {
        recordTerminalMemoryTurn({
          turnId: memoryTurnId,
          projectPath: memoryReadPath,
          projectId: memoryScope.projectId,
          agentId: memoryScope.agentId,
          chatId: chat.id,
          runId: req.runId,
          cwdAtRequest: workingFolder,
          borrowedAgentSlugs:
            activeBorrowedOwnerScopeKey() === explicitBorrowOwnerScopeKey
              ? explicitBorrowMemoryKeys
              : [],
        }, signal?.aborted ? "cancelled" : "failed");
      } catch (ticketError) {
        console.error("[memory] terminal turn receipt failed:", ticketError);
      }
    }
    noteGraphWorkerFailure(executionContext?.graphWorkerAttempt);
    if (executionContext?.graphWorkerAttempt && err !== graphDirectFailureError) noteGraphWorkerCoverageUnknown(executionContext.graphWorkerAttempt);
    // A store lock refused before this invocation sent anything (no planning, team or swarm call, no turn) did no work.
    if (!modelTurnStarted && !preparationDispatched && innermostTypedCode(err) === STORE_BUSY_CODE) markRefusedBeforeDispatch(err);
    // The typed delivery fact rides on the event: run-graph reads it to tell a refusal before dispatch from an unknown effect.
    sink({ kind: "error", error: { ...invocationFailure(req, "runner-failed", err, executionContext),
      ...(runnerRefusedBeforeDispatch(err) ? { turnDelivery: "not-dispatched" as const } : {}) } });
    return InvocationRunnerFailureError.isMarkedQuota(err)
      ? { ...earlyResult(), markedQuotaFailure: true }
      : earlyResult();
  }
  } catch (err) {
    // A store lock refused while the invocation was being prepared, before it sent anything anywhere: typed
    // not-dispatched, so a graph step or caller may retry it instead of treating it as possibly acted.
    if (!modelTurnStarted && !preparationDispatched && innermostTypedCode(err) === STORE_BUSY_CODE) markRefusedBeforeDispatch(err);
    throw err;
  } finally {
    for (const [agentId, leaseId] of workspaceLeases) {
      const pin = workspacePins.get(agentId);
      try { if (pin) recordRunEvent({ runId: req.runId ?? leaseId, chatId: req.chatId, agentId, kind: "agent_revision_run_finished",
        payload: { schemaVersion: "agentlas.revision-run-receipt.v1", ...pin, status: signal?.aborted ? "cancelled" : "finished" } }); } catch { /* Lease release remains unconditional. */ }
      try { releaseAgentWorkspaceRunLease(agentId, leaseId); } catch { /* A removed route retains a conservative lease until recovery. */ }
    }
    mcpConfigCurrent = false;
    signal?.removeEventListener("abort", revokeMcpConfig);
    if (login?.ownerSignal !== signal) login?.ownerSignal.removeEventListener("abort", revokeMcpConfig);
    browserLadderSettled = true;
    try { unbindBrowserLadder?.(); } catch { /* binding already gone */ }
    try { nativeBrowserGrant?.release(); } finally { mcpConfigCleanup?.(); }
  }
}
