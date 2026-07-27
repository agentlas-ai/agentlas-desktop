// IPC 핸들러 일괄 등록. main.ts 앱 ready 직후 호출.
// 각 도메인 모듈(runtime, secrets, team, marketplace, projects, chats, automations, invoke)을 thin wrapping.
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  SiteActivityEvent,
  SiteAgentAppMcpRecommendation,
  SiteAgentAppNativePublishApproval,
  SiteAgentAppPublishBackendRequest,
  SiteAgentAppTargetRef,
  SiteRemoteDeploymentRetention,
  SitePublishProvider,
  SitePublishProviderPage,
  SiteSurface,
} from "../shared/site-studio";
import { clearDetectCache, detectRuntimes, setActiveRuntime } from "./runtime/detect";
import { runtimeVersionsWithAutoUpdate } from "./runtime/auto-update";
import { agentRunCwd } from "./runtime/exec";
import { tryAcquireRuntimeMaintenance } from "./runtime/run-slots";
import { clearModelCache, listRuntimeModels } from "./runtime/providers";
import { installCli, openCliLogin, updateCli, type InstallableCli } from "./runtime/install-cli";
import { listRuntimeCommands } from "./runtime/commands";
import { resolveInvocationRunId } from "./runtime/run-id";
import {
  InvocationLifecycleRegistry,
  registerDurableInvocationStart,
} from "./runtime/invocation-lifecycle";
import {
  getMultimodalSettings,
  getMultimodalStatus,
  listMultimodalProviders,
  saveMultimodalSettings,
} from "./multimodal/settings";
import {
  cancelOberonKeyframes,
  getOberonKeyframeJob,
  openOberonKeyframeOutput,
  startOberonKeyframes,
} from "./oberon/keyframes";
import { planOberonWithCli } from "./oberon/planner";
import { startOberonSheets } from "./oberon/sheets";
import {
  cancelOberonRenderJob,
  getOberonRenderJob,
  openOberonRenderOutput,
  startOberonRender,
} from "./oberon/render";
import {
  cancelOberonMotionAd,
  getOberonMotionAdJob,
  openOberonMotionAdOutput,
  startOberonMotionAd,
} from "./oberon/motion-graphics";
import {
  animateKeyStatus,
  cancelOberonAnimate,
  getOberonAnimateJob,
  openOberonAnimateOutput,
  startOberonAnimate,
} from "./oberon/animate";
import { runMigration, scanMigrationSources } from "./migrate";
import {
  deleteApiKey,
  deleteEnvVar,
  hasApiKey,
  hasEnvVar,
  listEnvKeys,
  previewEnvVar,
  saveApiKey,
  setEnvVar,
} from "./secrets/vault";
import {
  installAgent,
  installMyAgent,
  getAgentById,
  listInstalledAgents,
  setAgentLocalDisplayName,
  uninstallAgent,
} from "./mcp/registry";
import { MCP_TOOL_CATALOG, getCatalogEntry } from "./mcp-tools/catalog";
import {
  installCustomServer,
  installFromCatalog,
  listInstalledServers,
  removeServer,
  setServerEnabled,
} from "./mcp-tools/registry";
import { statusAllServers, testServerById } from "./mcp-tools/client";
import { recommendMcpBuildPlan } from "./mcp-tools/build-plan";
import { getOpenCrabReadiness } from "./opencrab/ontology";
import {
  getSource as getMarketSource,
  listMyAgentsCached,
  refreshSourceStatus as refreshMarketSourceStatus,
} from "./marketplace";
import {
  getFirm,
  installFirm,
  listFirms,
  uninstallFirm,
} from "./store/firms";
import { listAgentFiles, readAgentFile, readAgentPromptSource, writeAgentFile } from "./agents/files";
import {
  approveAndApplyAgentEvolutionProposal,
  createAgentEvolutionProposal,
  listAgentEvolutionProposals,
  listPendingGrowthProposals,
  markAgentEvolutionProposalMeasured,
  rejectAgentEvolutionProposal,
  rollbackAgentEvolutionProposal,
} from "./agents/evolution";
import { importLocalFolder } from "./agents/import-local";
import { getDb } from "./store/db";
import { getResolvedOrg } from "./store/org-spec";
import { resolveTeamOrg, resolveAgentTeam } from "./agents/org-resolver";
import { runMcpInvocation } from "./mcp/client";
import {
  completeDesktopWorkforceGoal,
  desktopWorkforceGoalId,
  loadDesktopWorkforceGoal,
} from "./mcp/workforce-goal-continuity";
import { resolveRunKeyElicitation } from "./mcp/run-key-elicitation";
import { invocationService } from "./invocation/service";
// ── Hephaestus 엔진 브리지 — 데스크탑↔엔진 연결은 전부 electron/hephaestus/* 에서만 일어난다. ──
import { hephaestusAvailable, hephaestusDoctor, hephaestusRoot } from "./hephaestus/engine";
import { listSkillCatalog, readSkillCatalogAsset } from "./hephaestus/skill-catalog";
import {
  aoGraph,
  hepNetwork,
  hepPackage,
  hepPublish,
  hepSearch,
  localGui,
  routeOnly,
  securityScan,
  stormbreakerJournal,
  stormbreakerRun,
} from "./hephaestus/commands";
import { autofixForPublish } from "./hephaestus/publish-autofix";
import { normalizeRecommendation } from "./hephaestus/recommendation";
import { confirmUpload, PathGuardError, resolveFolderArg } from "./hephaestus/path-guard";
import { getEngineToggles, isSupervisorEnabled, setEngineToggle, setSupervisorEnabled } from "./hephaestus/supervisor";
import { previewBuildAllocation, runHephaestusBuild } from "./hephaestus/builder";
import { resolveHephaestusBuildRequest, resolveHephaestusBuildRequestForRun } from "./hephaestus/build-access";
import { pickLocale } from "./runtime/status-i18n";
import { currentUiLocale } from "./ui-locale";
import { buildChatRecap, markChatRecapViewed } from "./chat/recap";
import { startStudio, stopStudio } from "./hephaestus/studio";
import type {
  AgentGroupCreateInput,
  AgentGroupUpdateInput,
  HephaestusBuildEvent,
  HephaestusBuildRequest,
  CreateAgentEvolutionProposalInput,
  ExperiencePackCreateIpcInput,
  ExperienceCloudReconcileInput,
  ExperienceCloudSaveInput,
  ExperienceCloudWithdrawInput,
  FsPathGrant,
  FsReadScope,
  HiredAgentCard,
  CanonicalTaskResultAcceptance,
  OneOperatingPrincipleCreateInput,
  OneOperatingPrincipleDeleteInput,
  OneOperatingPrincipleEnabledInput,
  OneOperatingPrincipleUpdateInput,
  OneProfileUpdateInput,
  AcknowledgeOneFeatureIntroInput,
  DeferOneFeatureIntroInput,
  PrepareOneBriefingActionInput,
  OpenOneBriefingTaskInput,
  StartOneBriefingActionInput,
  OneBriefingChannel,
  OneBriefingFeedback,
  OneBriefingPreferences,
  AutoResolveOneTeamPreflightInput,
  OneTeamPreflightRef,
  PrepareOneTeamPreflightInput,
  ResolveOneTeamPreflightInput,
  DeleteOneMemoryAssetInput,
  DeleteOneMemoryCandidateInput,
  EditAndSaveOneMemoryCandidateInput,
  ProposeOneMemoryCandidateInput,
  RejectOneMemoryCandidateInput,
  SaveOneMemoryCandidateInput,
  SetOneMemoryAssetEnabledInput,
  UpdateOneMemoryAssetInput,
  UseOneMemoryCandidateOnceInput,
  AcceptOneSuggestionForReviewInput,
  GetOneHubDerivativeDraftInput,
  DismissOneSuggestionInput,
  NeverAskOneSuggestionInput,
  OneSuggestionReviewHandoffInput,
  SnoozeOneSuggestionInput,
  SetOneValueClosureReflectionInput,
  ResolveOneWeeklyReflectionInputV1,
  OneArtifactBindingRequestV1,
  OneArtifactPreviewRevokeV1,
} from "../shared/types";
import type {
  CompleteOneOnboardingInput,
  DismissOneOnboardingInput,
  LimitOneOnboardingProviderInput,
  ProvisionOneOnboardingStarterTeamInput,
  ReopenOneOnboardingProviderInput,
  ResetOneOnboardingInput,
  ResumeOneOnboardingInput,
  UpdateOneOnboardingInput,
  VerifyOneOnboardingProviderInput,
} from "../shared/one-onboarding";
import { resolveExperiencePackCreateIpcInput } from "./experience/access";
import { getExperienceHubCatalog } from "./experience/hub-catalog";
import {
  checkSafely as updaterCheck,
  getUpdaterState,
  openManualDownload as updaterOpenManualDownload,
  quitAndInstall as updaterInstall,
  revealRecoveryBackup as updaterRevealRecoveryBackup,
} from "./updater";
import { listDirectory, pickDirectory, readTextFilePreview } from "./fs/workspace";
import { grantDroppedPath, grantPath, pathFromGrant, resolveFsReadPath } from "./fs/access";
import {
  getAuthSession,
  getSessionCookieHeader,
  signInWithBrowser,
  signInWithGoogle,
  signOut,
} from "./auth";
import { revokeAllMobileBridgeDevicesForAuthChange } from "./mobile-bridge/runtime";
import { getBillingCredits, transferEarnings } from "./billing";
import {
  addHubPromptBookmark,
  getHubPrompt,
  listHubPromptBookmarks,
  listHubPrompts,
  listHubPromptTastes,
  removeHubPromptBookmark,
  tasteHubPrompt,
  unlockHubPrompt,
} from "./prompts-hub";
import {
  addHubAgentBookmark,
  listHubAgentBookmarks,
  removeHubAgentBookmark,
} from "./store/hub-bookmarks";
import {
  broadcastHubBookmarkSnapshot,
  failCloseActiveHubBookmarks,
  syncHubBookmarks,
} from "./hub-bookmark-sync";
import { claimQuest, listQuests } from "./quests";
import { listMemoryEntriesForAgentUi } from "./memory/store";
import { importMemoryPreview, importMemoryApply } from "./memory/import";
import {
  captureExperienceCandidate,
  createExperienceExportIntent,
  createExperiencePack,
  getExperienceIntakeDiagnostics,
  getExperienceOntologySummary,
  listExperienceCandidates,
  listExperienceExportIntents,
  listExperiencePacks,
  listExperiencePromotionReceipts,
  listLocalTasteDrafts,
  promoteExperienceCandidate,
  unsealExperienceCandidatePublic,
} from "./experience/store";
import { listAgentUsageSummary, setAgentBookmark } from "./agents/usage";
import {
  getBorrowedAgentOntologyGraph,
  listBorrowedAgentProfiles,
} from "./agents/borrowed-profiles";
import { getExperienceOntologyGraphSnapshot } from "./experience/relation-index";
import {
  confirmTasteGeneralization,
  listTasteChipWorkflows,
  prepareTastePreviews,
  saveTasteGeneralization,
  uploadTasteDraft,
} from "./experience/taste-workflow";
import {
  confirmOperationalPublicProjection,
  listOperationalPublicProjections,
  saveOperationalPublicProjection,
} from "./experience/operational-generalization";
import { getAgentLearningSummary } from "./agents/learning-summary";
import {
  exportExperienceFromCloud,
  listExperienceCloudUploads,
  reconcileExperienceCloudUpload,
  saveExperienceToCloud,
  withdrawExperienceFromCloud,
} from "./experience/cloud";
import { getDreamingStatus, setDreamingEnabled } from "./memory/dreaming";
import {
  getInvocationRunReceipt,
  getLatestInvocationRunReceipt,
  hasInvocationRunReceipt,
  listFailureEvents,
  listRunEvents,
  recordRunEvent,
  recordMcpInvocationEvent,
  tryRecordFailureEvent,
  tryRecordRunEvent,
} from "./store/run-events";
import { getUsageSnapshot, invalidateUsage, retryUsageProvider } from "./usage";
import { isUsageRetryProviderId } from "./usage/retry-policy";
import {
  commitPendingConfirmationAnswer,
  listCommittedQuestionAnswers,
  listPendingConfirmations,
  snoozePendingConfirmation,
} from "./confirm";
import {
  addProjectOntologySource,
  getProjectOntologyStatus,
  provisionProjectOntology,
  syncProjectOntology,
} from "./ontology/project-runtime";
import { getAgentOntologyHubProjection, resolveAgentOntologyHubAttach } from "./ontology/agent-hub-projection";
import { getProjectTimelineSnapshot } from "./memory/project-timeline";
import {
  createProject,
  getProject,
  listProjects,
  removeProject,
  updateProject,
} from "./store/projects";
import {
  archiveChat,
  clearChatContext,
  createChat,
  getChat,
  getChatWorkingFolder,
  listArchivedChats,
  listChatMessages,
  listChatsByFirm,
  listChatsByProject,
  listRecentChats,
  appendChatMessage,
  removeChat,
  renameChat,
  setChatContinuousMode,
  setChatHiredAgents,
  setChatSwarmMode,
  setChatWorkingFolder,
  switchChatAgent,
  unarchiveChat,
  getOrCreateAutomationSession,
} from "./store/chats";
import {
  acceptCanonicalTaskResult,
  getCanonicalTask,
  findCanonicalTaskForChat,
  getCanonicalTaskForChat,
  listCanonicalTasks,
} from "./store/tasks";
import { mutateOneTaskArchive, searchOneHistory } from "./one/search";
import { prejudgeOneRequestIntent } from "./one/judged-request-intent";
import { judge, judgeSubset } from "./system-agents/judgment";
import { prejudgeOneMemoryIntent } from "./one/memory-detector";
import { prejudgeCompletionClaims } from "./one/judged-completion-claim";
import { prejudgeAutomationComputerUse } from "./system-agents/judged-tool-mode";
import { continueOneFromTaskResult } from "./one/task-continuation";
import {
  bindOneAttachmentsToTeam,
  discardOneAttachments,
  getOneAttachmentsForTeam,
  prepareOneAttachments,
} from "./one/attachments";
import {
  issueOneArtifactPreviewCapability,
  resolveOneArtifactOpenPath,
  revokeOneArtifactPreview,
} from "./one/artifact-preview";
import {
  addOneOperatingPrinciple,
  deleteOneOperatingPrinciple,
  getOneProfile,
  setOneOperatingPrincipleEnabled,
  updateOneOperatingPrinciple,
  updateOneProfile,
} from "./store/one-profile";
import {
  getOneBriefingSnapshot,
  recordOneBriefingFeedback,
  resolveOneBriefingTaskNavigation,
  setOneBriefingPreferences,
} from "./one/briefing";
import {
  failOneBriefingActionStart,
  getOneBriefingActionPacket,
  getOneBriefingActionPacketForCandidate,
  OneBriefingActionError,
  prepareOneBriefingActionPacket,
  reserveOneBriefingActionExecution,
} from "./one/briefing-actions";
import {
  autoResolveOneTeamPreflight,
  failOneTeamPreflightStart,
  getOneTeamPreflightForChat,
  prepareOneTeamPreflight,
  resolveOneTeamPreflight,
} from "./one/team-preflight";
import {
  acknowledgeOneFeatureIntro,
  deferOneFeatureIntro,
  getOneFeatureIntroState,
} from "./one/feature-intro";
import {
  completeOneOnboarding,
  dismissOneOnboarding,
  getOneOnboardingExecutionAuthorization,
  getOneOnboardingState,
  limitOneOnboardingProvider,
  provisionOneOnboardingStarterTeam,
  reopenOneOnboardingProvider,
  resetOneOnboarding,
  resumeOneOnboarding,
  updateOneOnboarding,
  verifyOneOnboardingProvider,
} from "./one/onboarding";
import {
  deleteOneMemoryAsset,
  deleteOneMemoryCandidate,
  editAndSaveOneMemoryCandidate,
  getOneMemoryState,
  proposeOneMemoryCandidate,
  rejectOneMemoryCandidate,
  saveOneMemoryCandidate,
  sealOneMemoryCandidateProvenance,
  setOneMemoryAssetEnabled,
  updateOneMemoryAsset,
  useOneMemoryCandidateOnce,
} from "./one/memory-candidates";
import {
  acceptOneSuggestionForReviewFromUser,
  dismissOneSuggestion,
  getOneSuggestionReviewHandoff,
  getOneSuggestionState,
  neverAskOneSuggestion,
  snoozeOneSuggestion,
} from "./one/suggestions";
import { getOneSuggestionReviewSeed } from "./one/review-seed";
import { getOneHomeSignals } from "./one/home-signals";
import { getOneHubDerivativeDraft } from "./one/hub-derivative";
import {
  getLatestOneValueClosure,
  getOneValueClosureState,
  setOneValueClosureReflection,
} from "./one/value-closure";
import {
  getOneWeeklyReflectionSnapshot,
  resolveOneWeeklyReflection,
} from "./one/weekly-reflection";
import {
  ACCEPTED_RESULT_CLOSURE_FACT_STATEMENTS,
  ensureAcceptedResultValueClosure,
  ensureVerifiedAcceptedResultValueClosure,
} from "./one/accepted-result-value-closure";
import {
  getOneActivationState,
  resolveOneActivationConcern,
  resolveOneActivationMobile,
  resolveOneActivationWork,
  skipOneActivation,
  tryCompleteOneActivationFirstValue,
} from "./one/activation";
import {
  ensureOneExperienceReuseReceipt,
  getLatestOneExperienceReuseReceipt,
  getOneExperienceReuseState,
} from "./one/experience-reuse";
import { tryProduceAcceptedResultSuggestion } from "./one/completion-suggestion-producer";
import {
  getLatestOneImprovementProof,
  getOneImprovementProofState,
  listOneImprovementProofs,
} from "./one/improvement-proof";
import {
  reconcileOneImprovementProofs,
  tryProduceOneImprovementProofForTask,
} from "./one/improvement-proof-producer";
import { createOneTaskProjectionRuntime } from "./one/task-projection";
import { loadOrCreateMobileBridgeHostIdentity } from "./mobile-bridge/pairing";
import { listHiredAgents } from "./agents/hired-agents";
import { getAgentConcurrencyInfo, setAgentConcurrency } from "./store/concurrency";
import { getInterviewMode, setInterviewMode, type InterviewMode } from "./store/interview-mode";
import {
  createAutomation,
  getAutomation,
  listAutomations,
  toggleAutomation,
  updateAutomation,
  updateAutomationGraph,
  listRunHistory,
  getLatestGraphRun,
} from "./store/automations";
import {
  getAgentSurface,
  listAgentSurfaceEvents,
  listAgentSurfaces,
  patchAgentSurfaceState,
} from "./store/agent-surfaces";
import {
  approveAgentSurface,
  hasAgentSurfaceApproval,
  listAgentSurfaceApprovals,
  revokeAgentSurfaceApproval,
} from "./store/agent-surface-approvals";
import {
  getSurfaceJobSummary,
  listSurfaceJobs,
  updateSurfaceJob,
} from "./store/agent-surface-jobs";
import {
  getSurfaceAssetPack,
  getSurfaceAssetPackByRoot,
  getSurfaceAssetPackBySurface,
  listSurfaceAssetPackOperations,
  listSurfaceAssetPacks,
  recordMaterializedSurfaceAssetPack,
  recordSurfaceAssetPackOperation,
} from "./store/agent-surface-assets";
import {
  cloudAppRootPath,
  getAgentApp,
  getAgentAppByRoot,
  getAgentAppBySurface,
  isCloudAppRoot,
  listAgentAppOperations,
  listAgentApps,
  recordCloudAppManifest,
  recordAgentAppOperation,
  recordScaffoldedApp,
} from "./store/agent-apps";
import {
  getAgentTool,
  getAgentToolByRoot,
  getAgentToolBySurface,
  listAgentToolOperations,
  listAgentTools,
  recordAgentToolOperation,
  recordScaffoldedTool,
} from "./store/agent-tools";
import {
  getAgentRuntimeOverride,
  listAgentRuntimeOverrides,
  removeAgentRuntimeOverride,
  setAgentRuntimeOverride,
} from "./store/agent-runtime-overrides";
import {
  createAgentGroup,
  getResolvedAgentGroup,
  listAgentGroups,
  listResolvedAgentGroups,
  removeAgentGroup,
  removeAgentGroupMember,
  updateAgentGroup,
} from "./store/agent-groups";
import {
  autoConnectTelegram,
  cloneTelegramConnection,
  configureTelegramBotSettings,
  listTelegramBindings,
  openTelegramBot,
  pruneOrphanedTelegramBindings,
  removeTelegramConnection,
  resetTelegramConversation,
  resumeTelegramConnection,
  sendTelegramTest,
  startTelegramConnection,
  stopTelegramConnection,
} from "./telegram/connect";
import {
  getBrowserStatus,
  browserListSites,
  browserSaveSite,
  browserDeleteSite,
  browserOpenLogin,
  browserMarkSession,
  browserListPermissions,
  browserRevokePermission,
  browserResolveApproval,
  browserListLogs,
} from "./browser/connect";
import type { BrowserPermissionDecision } from "./browser/connect";
import { captureBrowserLiveFrame, focusBrowserLiveTarget } from "./browser/live-view";
import { captureComputerUsePreview } from "./computer-use/preview";
import {
  archiveAppPackage,
  activateLocalCommerceStack,
  approveProviderPayment,
  captureProviderBrowserSessions,
  installMcpPlan,
  launchProviderBrowserSession,
  materializeCatalogAssets,
  prepareProviderBrowserOpen,
  preparePreviewDeploy,
  publishAppAsTool,
  resolveProviderCredentials,
  runAppFactoryAutopilot,
  restoreAppPackage,
  runAppFactorySmoke,
  runProviderTasks,
  syncProviderBrowserResults,
} from "./app-factory/operations";
import { scaffoldServiceApp } from "./app-factory/scaffold";
import { archiveSurfaceAssetPack, materializeSurfaceAssetPack, restoreSurfaceAssetPack } from "./surface-assets/materialize";
import { archiveToolPackage, installToolMcp, restoreToolPackage } from "./tool-factory/operations";
import { runToolFactorySmoke, scaffoldAgentTool } from "./tool-factory/scaffold";
import { createCommerceAgentTeam } from "./meta-agent/commerce-team";
import { packageAndReviewCloudAgent } from "./cloud-agents/package";
import { resolveCloudAgentPackageRequest } from "./cloud-agents/access";
import { registeredUploadOptions, registeredUploadRoot } from "./cloud-agents/registered-upload";
import { selectedMultimodalEnvRequirements } from "../shared/multimodal";
import type {
  AppFactoryAppRecord,
  AppFactoryAppStatus,
  AppFactoryAssetMaterializeRequest,
  AppFactoryAutopilotRequest,
  AppFactoryCloudAppManifestRequest,
  AppFactoryLocalCommerceActivationRequest,
  AppFactoryLaunchTargetResult,
  AppFactoryOperationKind,
  AppFactoryProviderCredentialResolveRequest,
  AppFactoryProviderBrowserLaunchRequest,
  AppFactoryProviderBrowserResultSyncRequest,
  AppFactoryProviderBrowserSessionRequest,
  AppFactoryProviderPaymentApproveRequest,
  AppFactoryRootRequest,
  AppFactoryScaffoldRequest,
  AppFactoryScaffoldSnapshot,
  AgentRuntimeOverrideScope,
  AgentRuntimeOverrideSetInput,
  Automation,
  AutomationCreateInput,
  AutomationGraphReconcileInput,
  AutomationTriggerEventReconcileInput,
  CloudAgentBuiltPrivateSaveRequest,
  CloudAgentHubPublishRequest,
  CloudAgentPrivateSaveRequest,
  CloudAgentPublishProgressEvent,
  CloudAgentPublishStage,
  CloudAgentPublishRequest,
  CloudAgentRegisteredPublishRequest,
  CloudAgentRegisteredSaveRequest,
  InvocationRunReceipt,
  McpInvocationEvent,
  McpInvocationRequest,
  OrchestrationTarget,
  MetaAgentTeamFactoryRequest,
  McpTransport,
  MigrationOptions,
  MultimodalSettings,
  OberonKeyframeRequest,
  OberonPlanRequest,
  OberonRenderRequest,
  OberonSheetRequest,
  Project,
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
  SurfaceAssetPackRequest,
  SurfaceAssetPackRootRequest,
  SurfaceApprovalCheckRequest,
  SurfaceApprovalGrantRequest,
  SurfaceStatePatchRequest,
  SurfaceJobUpdateRequest,
  ToolFactoryOperationKind,
  ToolFactoryRootRequest,
  ToolFactoryScaffoldRequest,
  ToolFactoryToolStatus,
  WorkflowGraph,
  AutomationUpdatePatch,
  ScheduleSpec,
} from "../shared/types";
import {
  listTriggerEventAttention,
  reconcileParkedTriggerEvent,
} from "./store/trigger-events";
import {
  getAutomationGraphReconciliation,
  reconcileAutomationGraph,
} from "./store/graph-reconciliation";

// DESKTOP_MOBILE_BRIDGE: live invocation authority moved to invocation/service.ts.
// Hephaestus 빌더(hep-build) 진행 중 실행 — 취소용 AbortController 레지스트리.
const activeBuilds = new Map<string, AbortController>();
// runId → "렌더러 구독 완료" 신호. 구독 전 발생한 이벤트를 버퍼링하다 이 신호로 flush 한다.
const buildReadySignals = new Map<string, () => void>();
// 조기 실패가 렌더러의 invoke 응답보다 먼저 끝나도 terminal event를 잃지 않는다.
// 렌더러가 사라진 비정상 경로만 유한 시간 뒤 정리한다.
const BUILD_READY_GRACE_MS = 30_000;
const ONE_IMPROVEMENT_PROOF_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

function strictOneImprovementProofTaskId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ONE_IMPROVEMENT_PROOF_TASK_ID_RE.test(value)) {
    throw new TypeError(`${label} must be an opaque Task id`);
  }
  return value;
}

function oneImprovementProofListTaskId(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid Improvement Proof list request");
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "taskId")) {
    throw new TypeError("Improvement Proof list request contains unsupported fields");
  }
  return record.taskId === undefined
    ? undefined
    : strictOneImprovementProofTaskId(record.taskId, "Improvement Proof list taskId");
}
let pendingConfirmationCount = 0;
let pendingConfirmationBounceId: number | null = null;
let lastPendingConfirmationNoticeAt = 0;

/**
 * custom_base_url 검증 — byok.ts가 이 값으로 BYOK 키를 Bearer 전송하므로 임의 origin 재지정을 막는다.
 * 허용: 빈 값(기본값 복귀), 공개/사설 https, localhost/LAN 사설 IP의 http(로컬 LLM).
 * 거부: 그 외 스킴(file/data/javascript…)·공개 http·잘못된 URL → throw(렌더러에 거부 전달).
 * 순수 함수 — 부수효과 없음(단위테스트 가능).
 */
function validateCustomBaseUrl(raw: string): string {
  const url = (raw ?? "").trim();
  if (!url) return ""; // 빈 값 = 기본 OpenAI baseUrl로 복귀(허용)
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid base URL");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const isPrivateLan =
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (parsed.protocol === "https:") return url;
  if (parsed.protocol === "http:" && (isLoopback || isPrivateLan)) return url;
  throw new Error("Custom base URL must be https, or http on localhost/LAN");
}

function applyPendingConfirmationAttention(win: BrowserWindow | null, rawCount: number): void {
  const count = Math.max(0, Math.min(99, Math.floor(Number(rawCount) || 0)));
  const previous = pendingConfirmationCount;
  pendingConfirmationCount = count;

  try {
    app.setBadgeCount(count);
  } catch {
    // Badge support varies by platform/window manager.
  }

  if (count <= 0) {
    try {
      win?.flashFrame(false);
      if (process.platform === "darwin" && app.dock && pendingConfirmationBounceId !== null) {
        app.dock.cancelBounce(pendingConfirmationBounceId);
      }
    } catch {
      // ignore platform-specific attention failures
    }
    pendingConfirmationBounceId = null;
    return;
  }

  const focused = win?.isFocused() ?? false;
  if (focused || count <= previous) return;

  try {
    if (process.platform === "darwin" && app.dock) {
      if (pendingConfirmationBounceId !== null) app.dock.cancelBounce(pendingConfirmationBounceId);
      pendingConfirmationBounceId = app.dock.bounce("informational");
    } else {
      win?.flashFrame(true);
    }
  } catch {
    // ignore platform-specific attention failures
  }

  const now = Date.now();
  if (now - lastPendingConfirmationNoticeAt < 30_000) return;
  lastPendingConfirmationNoticeAt = now;

  try {
    if (Notification.isSupported()) {
      const ko = currentUiLocale() === "ko";
      new Notification({
        title: ko ? "Agentlas 승인 대기" : "Agentlas approval pending",
        body: ko
          ? (count === 1 ? "에이전트가 결정을 기다리고 있습니다." : `${count}개의 에이전트 승인 요청이 대기 중입니다.`)
          : (count === 1 ? "An agent is waiting on a decision." : `${count} agent approval requests are pending.`),
        silent: false,
      }).show();
    }
  } catch {
    // Native notifications can be disabled by the OS.
  }
}

function recordAppFactoryOperation(
  rootPath: string,
  operation: AppFactoryOperationKind,
  ok: boolean,
  result: unknown,
  status: AppFactoryAppStatus,
): void {
  const appRecord = getAgentAppByRoot(rootPath);
  if (!appRecord) return;
  const preservedStatus =
    appRecord.status === "tool-published" && status === "operations-ready"
      ? "tool-published"
      : appRecord.status === "preview-ready" && status === "operations-ready"
        ? "preview-ready"
        : status;
  recordAgentAppOperation(appRecord.id, operation, ok, result, preservedStatus);
}

function recordToolFactoryOperation(
  rootPath: string,
  operation: ToolFactoryOperationKind,
  ok: boolean,
  result: unknown,
  status: ToolFactoryToolStatus,
  installedServerId?: string | null,
): void {
  const toolRecord = getAgentToolByRoot(rootPath);
  if (!toolRecord) return;
  recordAgentToolOperation(toolRecord.id, operation, ok, result, status, installedServerId);
}

async function openAppLaunchTarget(appRecord: AppFactoryAppRecord): Promise<AppFactoryLaunchTargetResult> {
  const target = appLaunchTarget(appRecord);
  if (!target) {
    throw new Error(`No launch target is available for generated app: ${appRecord.appName}`);
  }
  if (target.mode === "external-url") {
    await shell.openExternal(validateExternalHttpUrl(target.target));
  } else if (target.mode === "local-file") {
    const localPath = target.target.startsWith("file://") ? fileURLToPath(target.target) : target.target;
    await shell.openPath(localPath);
  } else {
    shell.showItemInFolder(target.target);
  }
  return {
    rootPath: appRecord.rootPath,
    target: target.target,
    mode: target.mode,
    opened: true,
    summary: target.mode === "external-url"
      ? `Opened generated app at ${target.target}.`
      : `Opened generated app package at ${target.target}.`,
  };
}

/** Generated/app-provided URLs may reach the OS protocol dispatcher. Only web URLs are allowed. */
export function validateExternalHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("External URL is invalid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`External URL scheme is not allowed: ${parsed.protocol || "unknown"}`);
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error("External URL must use a credential-free web host.");
  }
  return parsed.toString();
}

function appLaunchTarget(appRecord: AppFactoryAppRecord): Pick<AppFactoryLaunchTargetResult, "target" | "mode"> | null {
  const scaffold = appRecord.scaffold as AppFactoryScaffoldSnapshot & { sourceUrl?: string };
  const candidates = [
    scaffold.launchUrl,
    appRecord.previewPath,
    scaffold.sourceUrl,
    appRecord.setupPath,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  for (const candidate of candidates) {
    const target = normalizeLaunchTarget(candidate);
    if (target) return target;
  }
  if (!isCloudAppRoot(appRecord.rootPath)) {
    return { target: appRecord.rootPath, mode: "local-folder" };
  }
  return null;
}

function normalizeLaunchTarget(value: string): Pick<AppFactoryLaunchTargetResult, "target" | "mode"> | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { target: url.toString(), mode: "external-url" };
    }
    if (url.protocol === "file:") {
      return { target: url.toString(), mode: "local-file" };
    }
    return null;
  } catch {
    if (path.isAbsolute(raw)) {
      return { target: pathToFileURL(raw).toString(), mode: "local-file" };
    }
    return null;
  }
}

function isTrustedSiteRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "agentlas:" && url.hostname === "app") return true;
    const developmentUrl = process.env.ELECTRON_START_URL?.trim();
    if (!developmentUrl) return false;
    const allowed = new URL(developmentUrl);
    return (allowed.protocol === "http:" || allowed.protocol === "https:") && url.origin === allowed.origin;
  } catch {
    return false;
  }
}

/** Fail closed unless publish came from the app window's trusted top frame. */
export function assertTrustedSitePublishIpcSender(event: IpcMainInvokeEvent): BrowserWindow {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !isTrustedSiteRendererUrl(frame.url)) {
    throw new Error("untrusted-site-publish-ipc-sender");
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win.webContents !== event.sender) {
    throw new Error("untrusted-site-publish-ipc-window");
  }
  return win;
}

async function confirmNativeSiteAgentAppMcp(
  win: BrowserWindow,
  recommendation: SiteAgentAppMcpRecommendation,
): Promise<"approved" | "declined"> {
  const ko = currentUiLocale().toLowerCase().startsWith("ko");
  const lines = recommendation.rows.map((row) => {
    const credential = row.credentialMode === "keyless"
      ? (ko ? "키 불필요" : "no key required")
      : row.keyState === "present"
        ? (ko ? "API 키 확인됨" : "API key present")
        : row.keyState === "missing"
          ? (ko ? "API 키 없음" : "API key missing")
          : (ko ? "API 키 상태 확인 불가" : "API key state unavailable");
    const readiness = row.readiness === "ready"
      ? (ko ? "실행 전 연결 검증 예정" : "will verify before each run")
      : row.readiness === "not-installed"
        ? (ko ? "미설치 · 연결하지 않음" : "not installed · will not attach")
        : row.readiness === "missing-key"
          ? (ko ? "키 없음 · 연결하지 않음" : "missing key · will not attach")
          : (ko ? "설정 미완료 · 연결하지 않음" : "not configured · will not attach");
    return `• ${row.name} (${row.catalogId}) · ${credential} · ${readiness}`;
  });
  const blockedLines = recommendation.blocked.map((issue) =>
    `• ${issue.id} · ${ko ? "Agent App 안전 정책에서 차단" : "blocked by Agent App safety policy"}`,
  );
  const detail = ko
    ? [
        ...lines,
        ...blockedLines,
        "",
        "연결 후보는 Desktop 시스템 전역 MCP에서 확인했습니다.",
        "차단 항목은 에이전트 번들의 앱 선언에서 안전 정책에 따라 제외했습니다.",
        "허용해도 설치·키 생성·로그인은 자동으로 하지 않습니다.",
        "키가 없거나 준비되지 않은 MCP는 붙이지 않고, 이번 앱 생성과 실행은 MCP 없이 계속합니다.",
        "실행 직전에 설치/키/연결/런타임을 다시 확인하고, 하나라도 실패하면 해당 MCP만 빼고 에이전트는 stateless/no-tool로 계속 실행합니다.",
        "비밀값, 키 이름, 로컬 경로, 서버 오류 원문은 앱 화면으로 전달하지 않습니다.",
      ].join("\n")
    : [
        ...lines,
        ...blockedLines,
        "",
        "Connection candidates were resolved from Desktop's system-wide MCP registry.",
        "Blocked items came from the agent bundle's app declaration and were excluded by safety policy.",
        "Allowing this does not install a server, create a key, or sign in automatically.",
        "A missing key or unready MCP is left unattached; this app still builds and runs without MCP.",
        "Agentlas rechecks installation, key, connection, and runtime eligibility before every run. Any failure removes only that MCP and continues stateless/no-tool.",
        "Secret values, key names, local paths, and raw server errors never reach the app UI.",
      ].join("\n");
  const result = await dialog.showMessageBox(win, {
    type: "question",
    buttons: recommendation.rows.length > 0
      ? ko ? ["MCP 없이 계속", "준비된 MCP 연결"] : ["Continue without MCP", "Attach ready MCP"]
      : [ko ? "확인" : "OK"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: ko ? "Agent App MCP 연결 검토" : "Review Agent App MCP access",
    message: ko
      ? recommendation.rows.length > 0
        ? `${recommendation.targetName} 앱을 만들기 전에 시스템 전역 MCP를 연결할까요?`
        : `${recommendation.targetName} 앱에서 차단된 MCP 선언을 확인하세요.`
      : recommendation.rows.length > 0
        ? `Attach system-wide MCPs before building ${recommendation.targetName}?`
        : `Review the MCP declarations blocked for ${recommendation.targetName}.`,
    detail,
  });
  return recommendation.rows.length > 0 && result.response === 1 ? "approved" : "declined";
}

/**
 * Main-owned review loop. The post-click recorder compares the exact digest
 * displayed above with a fresh registry/Keychain snapshot. One mismatch opens
 * the updated review once more; repeated churn fails closed to no-tool without
 * starving Agent App creation or launch.
 */
const siteAgentAppMcpReviewLocks = new Map<string, Promise<SiteAgentAppMcpRecommendation>>();

async function reviewNativeSiteAgentAppMcpUnlocked(
  win: BrowserWindow,
  projectId: string,
  mode: "launch" | "prebuild" | "force",
): Promise<SiteAgentAppMcpRecommendation> {
  const {
    getSiteAgentAppMcpRecommendation,
    recordSiteAgentAppMcpDecision,
  } = await import("./site/agent-app-mcp-plan");
  let recommendation = await getSiteAgentAppMcpRecommendation(projectId);
  if (mode === "launch" && recommendation.status !== "review-required") return recommendation;
  if (mode === "prebuild" && (recommendation.status === "approved" || recommendation.status === "declined")) {
    return recommendation;
  }
  if (recommendation.status === "not-required" && recommendation.blocked.length === 0) return recommendation;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const decision = await confirmNativeSiteAgentAppMcp(win, recommendation);
    if (recommendation.rows.length === 0) return recommendation;
    const decided = await recordSiteAgentAppMcpDecision(
      projectId,
      decision,
      recommendation.readinessDigest,
    );
    if (decision === "declined" || decided.status !== "review-required") return decided;
    recommendation = decided;
  }
  return recommendation;
}

function reviewNativeSiteAgentAppMcp(
  win: BrowserWindow,
  projectId: string,
  mode: "launch" | "prebuild" | "force",
): Promise<SiteAgentAppMcpRecommendation> {
  const existing = siteAgentAppMcpReviewLocks.get(projectId);
  const pending = (existing ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => reviewNativeSiteAgentAppMcpUnlocked(win, projectId, mode));
  siteAgentAppMcpReviewLocks.set(projectId, pending);
  void pending.finally(() => {
    if (siteAgentAppMcpReviewLocks.get(projectId) === pending) siteAgentAppMcpReviewLocks.delete(projectId);
  }).catch(() => {});
  return pending;
}

async function confirmNativeSitePublish(
  win: BrowserWindow,
  approval: SiteAgentAppNativePublishApproval,
): Promise<boolean> {
  const ko = currentUiLocale().toLowerCase().startsWith("ko");
  const fullSha256 = /^[a-f0-9]{64}$/;
  if (
    !fullSha256.test(approval.artifactDigest) ||
    !fullSha256.test(approval.intentDigest) ||
    !approval.providerAccountLabel.trim()
  ) throw new Error("native-publish-approval-contract-invalid");
  if (approval.provider === "render") {
    if (
      !approval.renderIntent ||
      approval.providerApiKeyIdentity !== "OS credential vault / secret:site-publish:render:api-key" ||
      !approval.providerApiKeyFingerprint ||
      !fullSha256.test(approval.providerApiKeyFingerprint)
    ) {
      throw new Error("render-native-approval-contract-missing");
    }
    const intent = approval.renderIntent;
    const detail = ko
      ? [
          `프로젝트: ${approval.projectName} (${approval.projectId})`,
          `앱: ${approval.appName}`,
          `Artifact SHA-256: ${approval.artifactDigest}`,
          `배포 intent SHA-256: ${approval.intentDigest}`,
          "",
          "호스팅: Render",
          `검증된 계정: ${approval.providerAccountLabel}`,
          `Owner ID: ${intent.ownerId}`,
          `Provider API key: ${approval.providerApiKeyIdentity}`,
          `Provider API key fingerprint: sha256:${approval.providerApiKeyFingerprint}`,
          "",
          `Repository: ${intent.repositoryUrl}`,
          `Branch: ${intent.branch}`,
          `Root directory: ${intent.rootDir ?? "repository root"}`,
          `Service name: ${intent.serviceName}`,
          `LLM selector: ${approval.llmProvider}`,
          "",
          approval.planWarning,
          "",
          "계속하면 위 계정과 repository intent로 공개 Render service만 생성합니다.",
          "LLM 키와 AGENTLAS_APP_ACCESS_KEY는 읽거나 전송하지 않으며, 생성 뒤 Render에서 직접 설정해야 합니다.",
        ].join("\n")
      : [
          `Project: ${approval.projectName} (${approval.projectId})`,
          `App: ${approval.appName}`,
          `Artifact SHA-256: ${approval.artifactDigest}`,
          `Deployment intent SHA-256: ${approval.intentDigest}`,
          "",
          "Hosting: Render",
          `Verified account: ${approval.providerAccountLabel}`,
          `Owner ID: ${intent.ownerId}`,
          `Provider API key: ${approval.providerApiKeyIdentity}`,
          `Provider API key fingerprint: sha256:${approval.providerApiKeyFingerprint}`,
          "",
          `Repository: ${intent.repositoryUrl}`,
          `Branch: ${intent.branch}`,
          `Root directory: ${intent.rootDir ?? "repository root"}`,
          `Service name: ${intent.serviceName}`,
          `LLM selector: ${approval.llmProvider}`,
          "",
          approval.planWarning,
          "",
          "Continuing creates only the public Render service for the exact account and repository intent above.",
          "Agentlas does not read or transfer the LLM key or AGENTLAS_APP_ACCESS_KEY; configure both manually in Render afterward.",
        ].join("\n");
    const result = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ko ? ["취소", "Render service 생성"] : ["Cancel", "Create Render service"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: ko ? "Render service 생성 최종 확인" : "Final Render service creation confirmation",
      message: ko
        ? `${approval.providerAccountLabel} 계정에 ${intent.serviceName} service를 생성하시겠습니까?`
        : `Create ${intent.serviceName} in account ${approval.providerAccountLabel}?`,
      detail,
    });
    return result.response === 1;
  }
  if (!approval.appAccessKeyFingerprint || !fullSha256.test(approval.appAccessKeyFingerprint)) {
    throw new Error("native-publish-app-access-fingerprint-invalid");
  }
  const keyIdentity = approval.llmKeyVersion && approval.llmKeyFingerprint
    ? `${approval.llmKeyIdentity}\n  version: ${approval.llmKeyVersion}\n  fingerprint: sha256:${approval.llmKeyFingerprint}`
    : `${approval.llmKeyIdentity}\n  version/fingerprint: ${ko ? "기존 키 metadata 없음" : "unavailable for this legacy key"}`;
  const detail = ko
    ? [
        `프로젝트: ${approval.projectName} (${approval.projectId})`,
        `앱: ${approval.appName}`,
        `Artifact SHA-256: ${approval.artifactDigest}`,
        "",
        `호스팅: ${approval.provider}`,
        `검증된 계정: ${approval.providerAccountLabel}`,
        `연결 방식: ${approval.providerConnectionMethod}`,
        `Scope / Workspace: ${approval.providerAccountScope ?? "personal default account"}`,
        `CLI: ${approval.providerCliVersion ?? "version unavailable"}`,
        "",
        `LLM: ${approval.llmProvider}`,
        `LLM Keychain 항목:\n${keyIdentity}`,
        `앱 access passcode fingerprint: sha256:${approval.appAccessKeyFingerprint}`,
        `배포 intent SHA-256: ${approval.intentDigest}`,
        "",
        approval.planWarning,
        "",
        "계속하면 두 secret을 위 계정의 서버 환경변수로 전송하고 공개 URL에 앱을 배포합니다. 추론 API는 별도 app passcode로 보호되며, 실제 secret 값은 이 창이나 renderer에 표시되지 않습니다.",
      ].join("\n")
    : [
        `Project: ${approval.projectName} (${approval.projectId})`,
        `App: ${approval.appName}`,
        `Artifact SHA-256: ${approval.artifactDigest}`,
        "",
        `Hosting: ${approval.provider}`,
        `Verified account: ${approval.providerAccountLabel}`,
        `Connection: ${approval.providerConnectionMethod}`,
        `Scope / workspace: ${approval.providerAccountScope ?? "personal default"}`,
        `CLI: ${approval.providerCliVersion ?? "version unavailable"}`,
        "",
        `LLM: ${approval.llmProvider}`,
        `LLM Keychain item:\n${keyIdentity}`,
        `App access passcode fingerprint: sha256:${approval.appAccessKeyFingerprint}`,
        `Deployment intent SHA-256: ${approval.intentDigest}`,
        "",
        approval.planWarning,
        "",
        "Continuing transfers both secrets to the server environment of the account above and deploys the app at a public URL. Its inference API is protected by the separate app passcode. Secret values are not shown here or to the renderer.",
      ].join("\n");
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ko ? ["취소", "Secret 전송 및 배포"] : ["Cancel", "Transfer secrets and deploy"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: ko ? "Agent App 공개 배포 최종 확인" : "Final Agent App publish confirmation",
    message: ko
      ? `${approval.provider}의 ${approval.providerAccountLabel} 계정으로 배포하시겠습니까?`
      : `Deploy to ${approval.provider} account ${approval.providerAccountLabel}?`,
    detail,
  });
  return result.response === 1;
}

async function confirmNativeSiteProjectDeletion(
  win: BrowserWindow,
  remotes: SiteRemoteDeploymentRetention[],
): Promise<boolean> {
  const ko = currentUiLocale().toLowerCase().startsWith("ko");
  if (remotes.length === 0) return true;
  const remoteLines = remotes.flatMap((remote, index) => [
    `[${index + 1}] ${remote.provider} · ${remote.status}`,
    `  Remote ID: ${remote.providerProjectId ?? "unavailable"}`,
    `  Service ID/name: ${remote.providerServiceId ?? "unavailable"} / ${remote.providerServiceName ?? "unavailable"}`,
    `  Remote URL: ${remote.url ?? "unavailable"}`,
    `  Provider-side secrets: ${remote.transferredSecrets.length ? remote.transferredSecrets.join(", ") : "none recorded"}`,
    `  Dashboard: ${remote.dashboardUrl}`,
  ]);
  const detail = ko
    ? [
        ...remoteLines,
        "",
        "이 작업은 로컬 Site 프로젝트, 생성 artifact, AppFactory 등록, 전용 hidden session만 삭제합니다.",
        "원격 서비스와 secret은 삭제하지 않습니다. Provider dashboard에서 직접 확인하고 삭제해야 합니다.",
      ].join("\n")
    : [
        ...remoteLines,
        "",
        "This removes only the local Site project, generated artifact, AppFactory registration, and dedicated hidden sessions.",
        "It does not delete the remote service or its secrets. Review and delete those manually in the provider dashboard.",
      ].join("\n");
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ko ? ["취소", "원격 유지 · 로컬만 삭제"] : ["Cancel", "Keep remote · delete local only"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: ko ? "원격 배포는 삭제되지 않습니다" : "Remote deployment will not be deleted",
    message: ko
      ? `${remotes.length}개의 원격 resource를 남기고 로컬 프로젝트만 삭제하시겠습니까?`
      : `Delete the local project while retaining ${remotes.length} remote resource(s)?`,
    detail,
  });
  return result.response === 1;
}

function rendererTaskForceTargets(value: unknown): OrchestrationTarget[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("Invalid task-force roster.");
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid task-force target.");
    const target = raw as Record<string, unknown>;
    const source = target.source;
    const kind = target.entityKind;
    const idKey = source === "local" ? kind === "agent" ? "agentId" : kind === "team" ? "firmId" : kind === "group" ? "groupId" : "" : "slug";
    const id = idKey && typeof target[idKey] === "string" ? target[idKey].trim() : "";
    if (!id || id.length > 160) throw new Error("Invalid task-force target identity.");
    let normalized: OrchestrationTarget;
    if (source === "local" && kind === "agent") normalized = { source, entityKind: kind, agentId: id };
    else if (source === "local" && kind === "team") normalized = { source, entityKind: kind, firmId: id };
    else if (source === "local" && kind === "group") normalized = { source, entityKind: kind, groupId: id };
    else if ((source === "cloud" || source === "hub") && (kind === "agent" || kind === "team")) {
      normalized = { source, entityKind: kind, slug: id };
    } else throw new Error("Invalid task-force target kind.");
    const key = JSON.stringify(normalized);
    if (seen.has(key)) throw new Error("Duplicate task-force target.");
    seen.add(key);
    return normalized;
  });
}

function rendererInvocationRequest(req: McpInvocationRequest): McpInvocationRequest {
  // Site Agent App authority is minted only by the loopback server in Electron
  // main. A compromised renderer cannot opt into that mode or inject an MCP
  // config/opaque-secret alias grant.
  const {
    agentAppMode: _agentAppMode,
    agentAppRuntimeToolGrant: _agentAppRuntimeToolGrant,
    oneBriefingActionRef: _oneBriefingActionRef,
    oneProfileContext: _oneProfileContext,
    oneTeamExecutionPolicy: _oneTeamExecutionPolicy,
    oneTeamRuntimeBinding: _oneTeamRuntimeBinding,
    oneAttachmentContext: _oneAttachmentContext,
    oneAttachmentRedactions: _oneAttachmentRedactions,
    ...rendererFields
  } = req as McpInvocationRequest & {
    oneTeamExecutionPolicy?: unknown;
    oneTeamRuntimeBinding?: unknown;
    oneAttachmentContext?: unknown;
    oneAttachmentRedactions?: unknown;
  };
  return {
    ...rendererFields,
    oneMode: rendererFields.oneMode === true,
    // One's exact team roster is minted from an opaque Main capability. A
    // renderer may carry the ref, never candidate identities themselves.
    taskForceTargets: rendererFields.oneMode === true
      ? undefined
      : rendererTaskForceTargets(rendererFields.taskForceTargets),
  };
}

// registeredUploadRoot / registeredUploadOptions moved to
// ./cloud-agents/registered-upload so the Mobile Bridge authority reuses the
// exact same internal path instead of re-implementing renderer IPC. That module
// owns the firmMemberIds filter which prevents a Team's internal workers from
// appearing again as ordinary upload choices.

export function registerIpcHandlers(): void {
  let oneProjectionHostRef: string | null = null;
  const oneTaskProjectionRuntime = createOneTaskProjectionRuntime({
    getAuthoritySnapshot: ({ taskId }) => {
      const task = getCanonicalTask(taskId);
      if (!task) return null;
      const chatAvailable = Boolean(task.originChatId && getChat(task.originChatId));
      if (!oneProjectionHostRef) {
        try {
          oneProjectionHostRef = loadOrCreateMobileBridgeHostIdentity(app.getPath("userData")).hostId;
        } catch {
          // A Desktop-only install can still expose an honest local authority ref.
          oneProjectionHostRef = "desktop:local";
        }
      }
      return {
        connection: "online" as const,
        lastSyncedAt: task.updatedAt,
        authoritativeHostRef: oneProjectionHostRef,
        executionAuthorityAvailable: chatAvailable,
        mutationMode: chatAvailable ? "direct" as const : "read_only" as const,
      };
    },
  });

  // ── app ─────────────────────────────────────────────────
  // macOS "시스템 설정 > 언어 및 지역"의 1순위 언어. Electron이 BCP47 형태로 반환.
  // ex) "ko-KR", "en-US", "ja-JP". 첫 실행 시 i18n 자동 감지에 사용.
  ipcMain.handle("app:getLocale", () => app.getLocale());

  // ── Renderer judgment bridge — style/format inference only ─────────────────
  // Narrow, kind-allowlisted surface: Main owns the question/guidance per kind;
  // the renderer supplies only labels, input, hint wordlists (reference only),
  // and its own deterministic fallback. No model → the fallback verdict comes
  // back labeled source:"fallback", never silently lexical.
  const RENDERER_JUDGE_KINDS: Record<string, { question: string; guidance: string }> = {
    "oberon-brief-format": {
      question: "Which film/video FORMAT does this production brief ask for? Pick exactly one listed format id.",
      guidance: "Judge the meaning in any language. A passing mention of a platform is not a format request.",
    },
    "oberon-brief-genre": {
      question: "Which GENRE best fits this film/video brief? Pick exactly one listed genre id.",
      guidance: "Judge the story/content the brief describes, not incidental words.",
    },
    "oberon-brief-setting": {
      question: "Which of the listed settings/locations does this brief primarily take place in? Answer 'none' when none fits.",
      guidance: "Only pick a location the brief genuinely uses as its setting.",
    },
    "trex-style-route": {
      question: "Which slide-deck visual style family best fits this presentation topic? Answer 'none' to keep the default look.",
      guidance: "Judge the audience and subject matter in any language; 'none' is a common correct answer.",
    },
    "trex-mode-route": {
      question: "Which art-direction mode best fits this slide-deck topic? Pick exactly one listed mode id.",
      guidance: "Judge the subject matter in any language.",
    },
    "cardnews-app-detect": {
      question: "Is this generated app a card-news / social-carousel image maker? Answer yes or no.",
      guidance: "Judge what the app actually does from its metadata, in any language.",
    },
    "generated-app-visual-output": {
      question: "Does this generated app primarily produce visual media outputs (images, cards, posters, storyboards, video) rather than text or data results? Answer yes or no.",
      guidance: "Judge the app's actual purpose from its metadata, in any language.",
    },
    // One DecisionCard risk/disposition — the Desktop render pass warms these
    // through the bridge and FAILS CLOSED (highest risk / approval required) when
    // no model answers; it never keyword-decides.
    "one-decision-risk": {
      question:
        "How risky is the action this assistant decision request asks the user to authorize? " +
        "R0 read-only; R1 preparation/draft only; R2 limited reversible change (save, upload, install); " +
        "R3 external effect (send, publish, book, pay, delete); R4 critical/irreversible effect " +
        "(legal filing, wiring money, security/permission change, mass destruction of data).",
      guidance:
        "Under-warning is the dangerous direction: when the action genuinely sends, pays, publishes, or " +
        "destroys, say R3/R4 even in a language no wordlist covers. Negated/hypothetical phrasing lowers it.",
    },
    "one-decision-disposition": {
      question:
        "For this ONE decision option, does choosing it approve/execute the proposed action (approve), " +
        "refuse it (reject), ask to modify or narrow it first (modify), or merely pick among neutral " +
        "alternatives (choice)?",
      guidance:
        "\"without X\" is usually a qualifier on an action option, not a refusal. Only a phrase that negates " +
        "the action itself is a rejection.",
    },
  };
  const RENDERER_SUBSET_KINDS: Record<string, { question: string; guidance: string }> = {
    "oberon-brief-tone": {
      question: "Which of the listed tone/mood attributes genuinely fit this film/video brief? Choose zero or more.",
      guidance: "Never pad the list; an empty selection is valid.",
    },
  };
  const RENDERER_JUDGMENT_LABEL_RE = /^[a-z0-9가-힣][a-z0-9가-힣 :._-]{0,63}$/i;
  const sanitizeRendererJudgmentSpec = (raw: unknown, allowlist: Record<string, { question: string; guidance: string }>) => {
    if (!raw || typeof raw !== "object") throw new TypeError("Invalid judgment request");
    const spec = raw as Record<string, unknown>;
    const kind = String(spec.kind ?? "");
    const meta = allowlist[kind];
    if (!meta) throw new TypeError(`Judgment kind not allowed for renderer: ${kind}`);
    const labels = Array.isArray(spec.labels)
      ? spec.labels.map((label) => String(label)).filter((label) => RENDERER_JUDGMENT_LABEL_RE.test(label)).slice(0, 64)
      : [];
    if (labels.length < 1) throw new TypeError("Judgment labels are required");
    const input = String(spec.input ?? "").slice(0, 6_000);
    const hints = Array.isArray(spec.hints)
      ? spec.hints
          .filter((hint): hint is { label: unknown; words: unknown } => Boolean(hint) && typeof hint === "object")
          .map((hint) => ({
            label: String(hint.label),
            words: Array.isArray(hint.words) ? hint.words.map((word) => String(word).slice(0, 64)).slice(0, 24) : [],
          }))
          .filter((hint) => labels.includes(hint.label) && hint.words.length > 0)
          .slice(0, 32)
      : undefined;
    const timeoutRaw = Number(spec.timeoutMs);
    const timeoutMs = Number.isFinite(timeoutRaw) ? Math.max(1_000, Math.min(10_000, Math.floor(timeoutRaw))) : 6_000;
    return { kind, meta, labels, input, hints, timeoutMs, fallback: String(spec.fallback ?? "") };
  };
  ipcMain.handle("judgment:judge", async (_e, raw: unknown) => {
    const spec = sanitizeRendererJudgmentSpec(raw, RENDERER_JUDGE_KINDS);
    if (!spec.labels.includes(spec.fallback)) throw new TypeError("Judgment fallback must be one of the labels");
    const verdict = await judge<string>({
      kind: spec.kind,
      question: spec.meta.question,
      labels: spec.labels,
      input: spec.input,
      guidance:
        `A deterministic pre-pass picked "${spec.fallback}". Treat that as a prior, not a fact. ` + spec.meta.guidance,
      hints: spec.hints,
      fallback: spec.fallback,
      timeoutMs: spec.timeoutMs,
    });
    return { verdict: verdict.verdict, source: verdict.source, confidence: verdict.confidence, reason: verdict.reason };
  });
  ipcMain.handle("judgment:judgeSubset", async (_e, raw: unknown) => {
    const spec = sanitizeRendererJudgmentSpec(raw, RENDERER_SUBSET_KINDS);
    const verdict = await judgeSubset<string>({
      kind: spec.kind,
      question: spec.meta.question,
      labels: spec.labels,
      input: spec.input,
      guidance: spec.meta.guidance,
      hints: spec.hints,
      timeoutMs: spec.timeoutMs,
    });
    return { selected: verdict.selected, source: verdict.source, confidence: verdict.confidence, reason: verdict.reason };
  });
  /** package.json의 version — 사이드바 푸터 표기/디버그 용 */
  ipcMain.handle("app:getVersion", () => app.getVersion());

  // ── T-rex 슬라이드 스튜디오 이미지 생성(키리스 CLI: codex image_gen / gemini) ──
  ipcMain.handle("trex:generateImage", async (_e, payload: { model?: "codex" | "gemini" | "auto"; prompt?: string }) => {
    const { generateTrexImage } = await import("./trex/imagegen");
    const model = payload?.model === "gemini" ? "gemini" : payload?.model === "codex" ? "codex" : "auto";
    return generateTrexImage(model, String(payload?.prompt ?? ""));
  });
  ipcMain.handle("trex:imageProviders", async () => {
    const { trexImageProviders } = await import("./trex/imagegen");
    return trexImageProviders();
  });
  // T-rex 슬라이드 "내용" 생성 — 연결된 LLM(agy/codex)이 슬라이드별 실제 카피·수치를 JSON으로 작성.
  ipcMain.handle("trex:generateContent", async (_e, payload: { topic?: string; count?: number; mode?: string; sources?: string; locale?: "ko" | "en"; useOpenCrab?: boolean }) => {
    const { generateDeckContent } = await import("./trex/content");
    return generateDeckContent(
      String(payload?.topic ?? ""),
      Number(payload?.count ?? 7),
      payload?.mode,
      payload?.sources,
      payload?.locale ?? "en",
      payload?.useOpenCrab === true,
    );
  });
  ipcMain.handle("trex:contentAvailable", async () => {
    const { trexContentAvailable } = await import("./trex/content");
    return trexContentAvailable();
  });
  // 선택 요소 LLM 수정(select-to-edit) — 현재 텍스트 + 자연어 지시 → 다시 쓴 텍스트.
  ipcMain.handle("trex:refineText", async (_e, payload: { current?: string; instruction?: string; context?: string }) => {
    const { refineTrexText } = await import("./trex/content");
    return refineTrexText(String(payload?.current ?? ""), String(payload?.instruction ?? ""), payload?.context);
  });

  // ── Site Studio ───────────────────────────────────────────────
  // Web/mobile 프리뷰는 prepareRender + opaque-origin iframe에 한정한다.
  // Agent App 실행/게시만 별도 main-owned Astryx artifact와 capability/consent
  // 검증을 통과하며, preview HTML이나 renderer 지정 경로를 실행하지 않는다.
  ipcMain.handle("site:listProjects", async () => {
    const { listSiteProjectsForRenderer } = await import("./site/store");
    return listSiteProjectsForRenderer();
  });
  ipcMain.handle("site:operationStatus", async (_e, payload: { projectId?: string }) => {
    const { activeSiteProjectOperation } = await import("./site/operation-lock");
    return activeSiteProjectOperation(String(payload?.projectId ?? ""));
  });
  ipcMain.handle("site:listConversation", async (_e, payload: { projectId?: string }) => {
    const { listSiteConversation } = await import("./site/store");
    return listSiteConversation(String(payload?.projectId ?? ""));
  });
  ipcMain.handle("site:createProject", async (_e, payload: {
    name?: string;
    surface?: SiteSurface;
    agentAppTarget?: SiteAgentAppTargetRef;
  }) => {
    const { createSiteProject, siteProjectForRenderer } = await import("./site/store");
    const surface: SiteSurface =
      payload?.surface === "mobile" || payload?.surface === "agent-app" ? payload.surface : "web";
    if (surface === "agent-app") {
      if (!payload?.agentAppTarget) throw new Error("Agent App에는 에이전트 또는 멀티에이전트 선택이 필요합니다.");
      const { resolveSiteAgentAppContext } = await import("./site/agent-app");
      const context = resolveSiteAgentAppContext(payload.agentAppTarget);
      return siteProjectForRenderer(createSiteProject({
        name: String(payload?.name ?? ""),
        surface,
        agentAppTarget: context.target,
        astryxTemplate: context.template,
        agentAppContract: context.contract,
        agentAppVisual: context.visual,
      }));
    }
    return siteProjectForRenderer(createSiteProject({ name: String(payload?.name ?? ""), surface }));
  });
  ipcMain.handle("site:deleteProject", async (event, payload: { projectId?: string }) => {
    const win = assertTrustedSitePublishIpcSender(event);
    const projectId = String(payload?.projectId ?? "");
    const { tryAcquireSiteProjectOperation } = await import("./site/operation-lock");
    const release = tryAcquireSiteProjectOperation(projectId, "delete");
    if (!release) throw new Error("site-project-busy");
    try {
      const { deleteSiteProjectWithAssets } = await import("./site/delete-project");
      const first = await deleteSiteProjectWithAssets(projectId);
      if (first.ok || first.remoteDeploymentsRetained.length === 0) return first;
      const acknowledged = await confirmNativeSiteProjectDeletion(win, first.remoteDeploymentsRetained);
      if (!acknowledged) return first;
      return deleteSiteProjectWithAssets(projectId, { acknowledgeRemoteRetained: true });
    } finally {
      release();
    }
  });
  ipcMain.handle("site:launchAgentApp", async (event, payload: { projectId?: string }) => {
    const win = assertTrustedSitePublishIpcSender(event);
    const projectId = String(payload?.projectId ?? "");
    const { assertSiteProjectIdle } = await import("./site/operation-lock");
    assertSiteProjectIdle(projectId);
    try {
      await reviewNativeSiteAgentAppMcp(win, projectId, "launch");
    } catch {
      // Recommendation/Keychain/registry/dialog failures cannot starve the app.
      // Without a valid main-owned receipt the runtime deterministically uses
      // the stateless/no-tool path.
    }
    const { launchSiteAgentApp } = await import("./site/agent-app-runtime");
    return launchSiteAgentApp(projectId);
  });
  ipcMain.handle("site:stopAgentApp", async (_e, payload: { projectId?: string }) => {
    const { stopSiteAgentApp } = await import("./site/agent-app-runtime");
    return stopSiteAgentApp(String(payload?.projectId ?? ""));
  });
  ipcMain.handle("site:agentAppRuntimeStatus", async (_e, payload: { projectId?: string }) => {
    const { siteAgentAppRuntimeStatus } = await import("./site/agent-app-runtime");
    return siteAgentAppRuntimeStatus(String(payload?.projectId ?? ""));
  });
  ipcMain.handle("site:agentAppMcpRecommendation", async (_e, payload: { projectId?: string }) => {
    const { getSiteAgentAppMcpRecommendation } = await import("./site/agent-app-mcp-plan");
    return getSiteAgentAppMcpRecommendation(String(payload?.projectId ?? ""));
  });
  ipcMain.handle("site:reviewAgentAppMcp", async (event, payload: { projectId?: string }) => {
    const win = assertTrustedSitePublishIpcSender(event);
    const projectId = String(payload?.projectId ?? "");
    return reviewNativeSiteAgentAppMcp(win, projectId, "force");
  });
  ipcMain.handle("site:prebuildReviewAgentAppMcp", async (event, payload: { projectId?: string }) => {
    const win = assertTrustedSitePublishIpcSender(event);
    return reviewNativeSiteAgentAppMcp(win, String(payload?.projectId ?? ""), "prebuild");
  });
  ipcMain.handle("site:agentAppThumbnail", async (_e, payload: { projectId?: string }) => {
    const { readSiteAgentAppThumbnail } = await import("./site/agent-app-thumbnail");
    return readSiteAgentAppThumbnail(String(payload?.projectId ?? ""));
  });
  ipcMain.handle("site:listPublishProviderStatuses", async () => {
    const { listSitePublishProviderStatuses } = await import("./site/agent-app-publish");
    return listSitePublishProviderStatuses();
  });
  ipcMain.handle("site:savePublishProviderToken", async (_e, payload: { provider?: SitePublishProvider; token?: string }) => {
    const { saveSitePublishProviderToken } = await import("./site/agent-app-publish");
    return saveSitePublishProviderToken(payload?.provider as SitePublishProvider, String(payload?.token ?? ""));
  });
  ipcMain.handle("site:removePublishProviderToken", async (_e, payload: { provider?: SitePublishProvider }) => {
    const { removeSitePublishProviderToken } = await import("./site/agent-app-publish");
    return removeSitePublishProviderToken(payload?.provider as SitePublishProvider);
  });
  ipcMain.handle("site:openPublishProviderPage", async (_e, payload: {
    provider?: SitePublishProvider;
    page?: SitePublishProviderPage;
  }) => {
    const { openSitePublishProviderPage } = await import("./site/agent-app-publish");
    return openSitePublishProviderPage(
      payload?.provider as SitePublishProvider,
      payload?.page as SitePublishProviderPage,
    );
  });
  ipcMain.handle("site:connectPublishProvider", async (_e, payload: { provider?: SitePublishProvider }) => {
    const { connectSiteAgentAppPublishProvider } = await import("./site/agent-app-publish");
    return connectSiteAgentAppPublishProvider(payload?.provider as SitePublishProvider);
  });
  ipcMain.handle("site:publishAgentApp", async (event, payload: SiteAgentAppPublishBackendRequest) => {
    const win = assertTrustedSitePublishIpcSender(event);
    const projectId = String(payload?.projectId ?? "");
    const { tryAcquireSiteProjectOperation } = await import("./site/operation-lock");
    const release = tryAcquireSiteProjectOperation(projectId, "publish");
    if (!release) throw new Error("site-project-busy");
    try {
      const { publishSiteAgentApp } = await import("./site/agent-app-publish");
      return await publishSiteAgentApp(payload, {
        confirmNativeApproval: (approval) => confirmNativeSitePublish(win, approval),
      });
    } finally {
      release();
    }
  });
  ipcMain.handle(
    "site:generateScreen",
    async (e, payload: { projectId?: string; brief?: string; variants?: number; styleHint?: string; baseScreenId?: string; locale?: string }) => {
      const runId = randomUUID();
      const projectId = String(payload?.projectId ?? "");
      let releaseSiteOperation: (() => void) | null = null;
      const emit = (event: SiteActivityEvent) => {
        if (!e.sender.isDestroyed()) e.sender.send("site:activity", event);
      };
      const status = (text: string) => emit({ type: "status", projectId, runId, text });
      try {
        const { tryAcquireSiteProjectOperation } = await import("./site/operation-lock");
        releaseSiteOperation = tryAcquireSiteProjectOperation(projectId, "generate");
        if (!releaseSiteOperation) {
          return {
            ok: false,
            reason: payload?.locale === "en" ? "Another Site project operation is already running." : "이 Site 프로젝트에서 다른 작업이 진행 중입니다.",
          };
        }
        const { generateSiteScreen } = await import("./site/generate");
        const { appendSiteConversation, getSiteProject, readSiteScreenHtml, saveSiteScreen } = await import("./site/store");
        const brief = String(payload?.brief ?? "");
        const locale = payload?.locale === "en" ? ("en" as const) : ("ko" as const);
        const variants = Math.max(1, Math.min(3, Number(payload?.variants ?? 1)));
        const project = getSiteProject(projectId); // 존재 검증 + main-owned surface/target
        let agentAppContext = null;
        if (project.surface === "agent-app") {
          if (!project.agentAppTarget) throw new Error("Agent App target is missing. Choose the agent again.");
          const { siteAgentAppContextFromProject } = await import("./site/agent-app");
          agentAppContext = siteAgentAppContextFromProject(project);
        }
        const userEntry = appendSiteConversation({
          projectId,
          role: "user",
          text: brief,
          context: payload?.baseScreenId ? (locale === "ko" ? "현재 버전을 바탕으로 새 버전" : "New version from the current version") : null,
        });
        emit({ type: "message", projectId, runId, entry: userEntry });
        status(locale === "ko" ? "웹앱 디자인 마스터에 새 화면을 요청하는 중…" : "Sending the new screen request to the design master…");
        let baseHtml: string | null = null;
        if (payload?.baseScreenId) {
          try {
            baseHtml = readSiteScreenHtml(projectId, String(payload.baseScreenId));
          } catch {
            baseHtml = null;
          }
        }
        const labels = ["A", "B", "C"];
        const variantGroup = variants > 1 ? randomUUID() : null;
        // 시안은 순차 실행 — 프로젝트 division 세션(대화 맥락)을 공유하므로 동시 실행 금지.
        const runs: Awaited<ReturnType<typeof generateSiteScreen>>[] = [];
        for (let i = 0; i < variants; i += 1) {
          status(
            variants > 1
              ? locale === "ko"
                ? `시안 ${labels[i]}의 방향을 설계하는 중…`
                : `Designing the direction for variant ${labels[i]}…`
              : locale === "ko"
                ? "제품의 시각 언어와 화면 구조를 설계하는 중…"
                : "Designing the product's visual language and screen structure…",
          );
          runs.push(
            await generateSiteScreen({
              projectId,
              brief,
              baseHtml,
              surface: project.surface,
              agentAppContext,
              locale,
              styleHint:
                [payload?.styleHint, variants > 1 ? `Variant ${labels[i]}: take a distinctly different visual direction from the other variants.` : null]
                  .filter(Boolean)
                  .join(" ") || null,
              activity: {
                onStatus: status,
                onFeedbackReset: () => emit({ type: "feedback-reset", projectId, runId }),
                onFeedbackDelta: (delta) => emit({ type: "feedback-delta", projectId, runId, delta }),
              },
            }),
          );
        }
        const okRuns = runs.filter((r) => r.ok && r.html);
        if (!okRuns.length) {
          const reason = runs[0]?.reason ?? "generation-failed";
          const assistantEntry = appendSiteConversation({
            projectId,
            role: "assistant",
            text: (locale === "ko" ? "시안을 만들지 못했습니다: " : "I could not create a version: ") + reason,
          });
          emit({ type: "message", projectId, runId, entry: assistantEntry });
          return { ok: false, reason };
        }
        status(locale === "ko" ? "생성 결과를 검증하고 버전 탭에 저장하는 중…" : "Validating the result and saving it to the version tabs…");
        const baseName = brief.replace(/\s+/g, " ").trim().slice(0, 24) || "screen";
        const screens = okRuns.map((r, i) =>
          saveSiteScreen({
            projectId,
            name: okRuns.length > 1 ? `${baseName} · ${labels[i]}` : baseName,
            html: r.html as string,
            variantGroup,
            variantLabel: okRuns.length > 1 ? labels[i] : null,
          }),
        );
        const feedback = okRuns
          .map((run, index) => {
            const label = okRuns.length > 1 ? `${locale === "ko" ? "시안" : "Variant"} ${labels[index]}` : null;
            const text = run.feedback || (locale === "ko" ? "화면을 완성하고 렌더 계약을 통과했습니다." : "The screen is ready and passed the render contract.");
            return label ? `${label}\n${text}` : text;
          })
          .join("\n\n");
        const assistantEntry = appendSiteConversation({ projectId, role: "assistant", text: feedback });
        emit({ type: "message", projectId, runId, entry: assistantEntry });
        let agentApp;
        let agentAppReason: string | undefined;
        if (project.surface === "agent-app") {
          status(locale === "ko" ? "실행 가능한 Astryx React 앱을 만드는 중…" : "Scaffolding the runnable Astryx React app…");
          try {
            const { scaffoldSiteAgentApp } = await import("./site/agent-app-scaffold");
            agentApp = await scaffoldSiteAgentApp(projectId, screens[0].id);
          } catch (error) {
            console.error("[site] Agent App scaffold failed:", error);
            agentAppReason = "agent-app-build-failed";
          }
        }
        return {
          ok: true,
          screens,
          engine: okRuns[0].engine,
          feedback,
          agentApp: agentApp ? { appName: agentApp.appName } : undefined,
          agentAppReason,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        try {
          const { appendSiteConversation } = await import("./site/store");
          const entry = appendSiteConversation({
            projectId,
            role: "assistant",
            text: (payload?.locale === "en" ? "I could not create that version: " : "새 버전을 만들지 못했습니다: ") + reason,
          });
          emit({ type: "message", projectId, runId, entry });
        } catch {
          // 프로젝트 생성 전 오류처럼 대화 파일을 만들 수 없는 경우에는 원래 오류만 반환한다.
        }
        return { ok: false, reason };
      } finally {
        releaseSiteOperation?.();
        emit({ type: "complete", projectId, runId });
      }
    },
  );
  ipcMain.handle(
    "site:editScreen",
    async (e, payload: { projectId?: string; screenId?: string; instruction?: string; selectionId?: string; selectionContext?: string; locale?: string }) => {
      const runId = randomUUID();
      const projectId = String(payload?.projectId ?? "");
      let releaseSiteOperation: (() => void) | null = null;
      const emit = (event: SiteActivityEvent) => {
        if (!e.sender.isDestroyed()) e.sender.send("site:activity", event);
      };
      const status = (text: string) => emit({ type: "status", projectId, runId, text });
      try {
        const { tryAcquireSiteProjectOperation } = await import("./site/operation-lock");
        releaseSiteOperation = tryAcquireSiteProjectOperation(projectId, "edit");
        if (!releaseSiteOperation) {
          return {
            ok: false,
            reason: payload?.locale === "en" ? "Another Site project operation is already running." : "이 Site 프로젝트에서 다른 작업이 진행 중입니다.",
          };
        }
        const { editSiteScreen } = await import("./site/generate");
        const { appendSiteConversation, getSiteProject, readSiteScreenHtml, updateSiteScreenHtml } = await import("./site/store");
        const screenId = String(payload?.screenId ?? "");
        const locale = payload?.locale === "en" ? "en" : "ko";
        const instruction = String(payload?.instruction ?? "");
        const project = getSiteProject(projectId);
        let agentAppContext = null;
        if (project.surface === "agent-app") {
          if (!project.agentAppTarget) throw new Error("Agent App 대상이 없습니다. 다시 선택해 주세요.");
          const { siteAgentAppContextFromProject } = await import("./site/agent-app");
          agentAppContext = siteAgentAppContextFromProject(project);
        }
        const sourceHtml = readSiteScreenHtml(projectId, screenId);
        const userEntry = appendSiteConversation({
          projectId,
          role: "user",
          text: instruction,
          context: payload?.selectionContext ?? null,
        });
        emit({ type: "message", projectId, runId, entry: userEntry });
        status(
          payload?.selectionId
            ? locale === "ko"
              ? "선택한 요소와 주변 레이아웃을 분석하는 중…"
              : "Analyzing the selected element and its surrounding layout…"
            : locale === "ko"
              ? "현재 화면과 이전 피드백을 분석하는 중…"
              : "Analyzing the current screen and prior feedback…",
        );
        const result = await editSiteScreen({
          projectId,
          sourceHtml,
          instruction,
          selectionId: payload?.selectionId ? String(payload.selectionId) : null,
          agentAppContext,
          locale,
          activity: {
            onStatus: status,
            onFeedbackReset: () => emit({ type: "feedback-reset", projectId, runId }),
            onFeedbackDelta: (delta) => emit({ type: "feedback-delta", projectId, runId, delta }),
          },
        });
        if (!result.ok || !result.html) {
          const reason = result.reason ?? "edit-failed";
          const assistantEntry = appendSiteConversation({
            projectId,
            role: "assistant",
            text: (locale === "ko" ? "수정을 적용하지 못했습니다: " : "I could not apply that change: ") + reason,
          });
          emit({ type: "message", projectId, runId, entry: assistantEntry });
          return { ok: false, reason, engine: result.engine };
        }
        status(locale === "ko" ? "변경 사항을 검증하고 캔버스에 적용하는 중…" : "Validating the change and applying it to the canvas…");
        const screen = updateSiteScreenHtml(projectId, screenId, result.html);
        const feedback =
          result.feedback ||
          (result.mode === "patch"
            ? locale === "ko"
              ? "선택한 요소에만 요청을 반영했고, 나머지 화면의 시각 언어는 유지했습니다."
              : "I applied the request only to the selected element and kept the rest of the visual language intact."
            : locale === "ko"
              ? "현재 화면 전체에 요청을 반영하고 렌더 계약을 다시 확인했습니다."
              : "I applied the request across the current screen and rechecked the render contract.");
        const assistantEntry = appendSiteConversation({ projectId, role: "assistant", text: feedback });
        emit({ type: "message", projectId, runId, entry: assistantEntry });
        let agentApp;
        let agentAppReason: string | undefined;
        if (project.surface === "agent-app") {
          status(locale === "ko" ? "Astryx React 앱 계약을 다시 동기화하는 중…" : "Synchronizing the Astryx React app contract…");
          try {
            const { scaffoldSiteAgentApp } = await import("./site/agent-app-scaffold");
            agentApp = await scaffoldSiteAgentApp(projectId, screen.id);
          } catch (error) {
            console.error("[site] Agent App rebuild failed:", error);
            agentAppReason = "agent-app-build-failed";
          }
        }
        return {
          ok: true,
          screen,
          engine: result.engine,
          mode: result.mode,
          feedback,
          agentApp: agentApp ? { appName: agentApp.appName } : undefined,
          agentAppReason,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        try {
          const { appendSiteConversation } = await import("./site/store");
          const entry = appendSiteConversation({
            projectId,
            role: "assistant",
            text: (payload?.locale === "en" ? "I could not apply that change: " : "수정을 적용하지 못했습니다: ") + reason,
          });
          emit({ type: "message", projectId, runId, entry });
        } catch {
          // 존재하지 않는 프로젝트/화면 오류는 원래 오류만 반환한다.
        }
        return { ok: false, reason };
      } finally {
        releaseSiteOperation?.();
        emit({ type: "complete", projectId, runId });
      }
    },
  );
  ipcMain.handle("site:readScreen", async (_e, payload: { projectId?: string; screenId?: string }) => {
    try {
      const { readSiteScreenHtml } = await import("./site/store");
      const html = readSiteScreenHtml(String(payload?.projectId ?? ""), String(payload?.screenId ?? ""));
      return { ok: true, html };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("site:prepareRender", async (_e, payload: { projectId?: string; screenId?: string }) => {
    try {
      const { readSiteScreenHtml } = await import("./site/store");
      const { prepareSiteRenderHtml } = await import("./site/html-tagger");
      const html = readSiteScreenHtml(String(payload?.projectId ?? ""), String(payload?.screenId ?? ""));
      const nonce = randomUUID();
      const { renderHtml } = prepareSiteRenderHtml(html, nonce);
      return { ok: true, renderHtml, nonce };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("site:renameScreen", async (_e, payload: { projectId?: string; screenId?: string; name?: string }) => {
    const projectId = String(payload?.projectId ?? "");
    const { assertSiteProjectIdle } = await import("./site/operation-lock");
    assertSiteProjectIdle(projectId);
    const { renameSiteScreen } = await import("./site/store");
    const screen = renameSiteScreen(projectId, String(payload?.screenId ?? ""), String(payload?.name ?? ""));
    return { ok: true, screen };
  });
  ipcMain.handle("site:deleteScreen", async (_e, payload: { projectId?: string; screenId?: string }) => {
    const projectId = String(payload?.projectId ?? "");
    const { assertSiteProjectIdle } = await import("./site/operation-lock");
    assertSiteProjectIdle(projectId);
    const { deleteSiteScreen } = await import("./site/store");
    deleteSiteScreen(projectId, String(payload?.screenId ?? ""));
    return { ok: true };
  });
  // 선택 요소 썸네일 — 호스트 창을 창 좌표(rect, CSS px)로 크롭 캡처.
  ipcMain.handle("site:captureRect", async (e, payload: { x?: number; y?: number; width?: number; height?: number }) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return { ok: false, reason: "no-window" };
      const [winW, winH] = win.getContentSize();
      const x = Math.max(0, Math.floor(Number(payload?.x ?? 0)));
      const y = Math.max(0, Math.floor(Number(payload?.y ?? 0)));
      const width = Math.min(Math.ceil(Number(payload?.width ?? 0)), winW - x);
      const height = Math.min(Math.ceil(Number(payload?.height ?? 0)), winH - y);
      if (width < 2 || height < 2) return { ok: false, reason: "empty-rect" };
      const image = await e.sender.capturePage({ x, y, width, height });
      return { ok: true, dataUrl: image.toDataURL() };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("site:exportScreen", async (e, payload: { projectId?: string; screenId?: string }) => {
    try {
      const { getSiteProject, readSiteScreenHtml } = await import("./site/store");
      const projectId = String(payload?.projectId ?? "");
      const screenId = String(payload?.screenId ?? "");
      const meta = getSiteProject(projectId);
      const screen = meta.screens.find((s) => s.id === screenId);
      const html = readSiteScreenHtml(projectId, screenId);
      const win = BrowserWindow.fromWebContents(e.sender);
      const res = await dialog.showSaveDialog(win ?? undefined!, {
        defaultPath: `${(screen?.name ?? "screen").replace(/[^\w가-힣 .-]+/g, "_")}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(res.filePath, html, "utf8");
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("site:exportProjectZip", async (e, payload: { projectId?: string }) => {
    try {
      const { getSiteProject, listSiteScreenFiles } = await import("./site/store");
      const { buildZipArchive } = await import("./site/zip-writer");
      const projectId = String(payload?.projectId ?? "");
      const meta = getSiteProject(projectId);
      const files = listSiteScreenFiles(projectId);
      if (!files.length) return { ok: false, reason: "no-screens" };
      const win = BrowserWindow.fromWebContents(e.sender);
      const res = await dialog.showSaveDialog(win ?? undefined!, {
        defaultPath: `${meta.name.replace(/[^\w가-힣 .-]+/g, "_") || "site"}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(res.filePath, buildZipArchive(files));
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  // Site 디자인을 실제 작업공간의 불변 레퍼런스 리비전으로 넘긴다. 렌더러가
  // 전달한 경로는 신뢰하지 않고 네이티브 picker가 발급한 capability만 해석한다.
  ipcMain.handle(
    "site:handoffToWorkspace",
    async (_e, payload: { projectId?: string; workspaceGrant?: import("../shared/types").FsPathGrant; locale?: string }) => {
      let releaseSiteOperation: (() => void) | null = null;
      try {
        if (!payload?.workspaceGrant) throw new Error("작업공간 폴더를 먼저 선택해 주세요.");
        const projectId = String(payload?.projectId ?? "");
        const { tryAcquireSiteProjectOperation } = await import("./site/operation-lock");
        releaseSiteOperation = tryAcquireSiteProjectOperation(projectId, "handoff");
        if (!releaseSiteOperation) {
          return {
            ok: false,
            reason: payload?.locale === "en" ? "Another Site project operation is already running." : "이 Site 프로젝트에서 다른 작업이 진행 중입니다.",
          };
        }
        const workspacePath = pathFromGrant(payload.workspaceGrant, "directory");
        const { handoffSiteProjectToWorkspace } = await import("./site/workspace-handoff");
        const handoff = handoffSiteProjectToWorkspace({
          projectId,
          workspacePath,
          locale: payload?.locale === "en" ? "en" : "ko",
        });
        return { ok: true, handoff };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally {
        releaseSiteOperation?.();
      }
    },
  );
  ipcMain.handle("site:contentAvailable", async () => {
    const { siteEngineStatus } = await import("./site/generate");
    return siteEngineStatus();
  });

  // ── 문서 스튜디오 "내용" 생성 — 연결된 LLM(agy/codex)이 실제 문서 초안을 JSON으로 작성 ──
  ipcMain.handle(
    "document:generate",
    async (
      _e,
      payload: {
        goal?: string;
        mode?: string;
        locale?: string;
        sources?: { authors?: string; title: string; year?: string; container?: string }[];
      },
    ) => {
      const { generateDocumentContent } = await import("./document/generate");
      const mode = payload?.mode === "paper" ? "paper" : payload?.mode === "brief" ? "brief" : "report";
      const locale = payload?.locale === "ko" ? "ko" : "en";
      const sources = Array.isArray(payload?.sources) ? payload!.sources : [];
      return generateDocumentContent(String(payload?.goal ?? ""), mode, locale, sources);
    },
  );
  // 선택 텍스트 개정(AI 편집 툴바).
  ipcMain.handle("document:revise", async (_e, payload: { text?: string; action?: string; locale?: string }) => {
    const { reviseDocumentText } = await import("./document/generate");
    const actions = ["expand", "rewrite", "shorten", "improve", "formal", "casual"] as const;
    const action = (actions as readonly string[]).includes(String(payload?.action)) ? (payload!.action as (typeof actions)[number]) : "improve";
    const locale = payload?.locale === "ko" ? "ko" : "en";
    return reviseDocumentText(String(payload?.text ?? ""), action, locale);
  });
  ipcMain.handle("document:available", async () => {
    const { documentContentAvailable } = await import("./document/generate");
    return documentContentAvailable();
  });

  // ── 버그 신고 ────────────────────────────────────────────
  // 우측 하단 도움말(?) 메뉴 → 신고 폼 → 웹 API(agentlas.cloud) → MongoDB 적재.
  ipcMain.handle(
    "support:submitBugReport",
    async (
      _e,
      payload: { message?: string; title?: string; severity?: "low" | "medium" | "high"; email?: string; page?: string; locale?: string },
    ) => {
      const { submitBugReport } = await import("./support");
      return submitBugReport({
        message: String(payload?.message ?? ""),
        title: payload?.title ? String(payload.title) : undefined,
        severity: payload?.severity,
        email: payload?.email ? String(payload.email) : undefined,
        page: payload?.page ? String(payload.page) : undefined,
        locale: payload?.locale ? String(payload.locale) : undefined,
      });
    },
  );

  // ── updater (electron-updater) ──────────────────────────
  // renderer가 마운트되자마자 현재 상태를 동기 조회. broadcast 이전에 새 창이 열려도 onState로 캐치.
  ipcMain.handle("updater:getState", () => getUpdaterState());
  ipcMain.handle("updater:check", () => updaterCheck());
  ipcMain.handle("updater:install", () => updaterInstall());
  ipcMain.handle("updater:openManualDownload", () => updaterOpenManualDownload());
  ipcMain.handle("updater:revealRecoveryBackup", () => updaterRevealRecoveryBackup());

  // ── fs (워킹 폴더 패널 read-only) ───────────────────────
  ipcMain.handle("fs:pickDirectory", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return pickDirectory(win);
  });
  ipcMain.handle("fs:listDirectory", (_e, absPath: string, scope: FsReadScope, showHidden?: boolean) =>
    listDirectory(absPath, scope, showHidden ?? false),
  );
  ipcMain.handle("fs:readTextFile", (_e, absPath: string, scope: FsReadScope) => readTextFilePreview(absPath, scope));
  // This channel is intentionally absent from window.agentlas. Only the isolated
  // preload bridge can pair webUtils.getPathForFile(File) with this grant call.
  ipcMain.handle("fs:grantDroppedPath", (_e, droppedPath: string) => grantDroppedPath(droppedPath));
  ipcMain.handle("fs:openPath", async (_e, target: string): Promise<{ ok: boolean; message?: string }> => {
    const raw = String(target || "").trim();
    if (!raw) return { ok: false, message: "No file or URL was provided." };
    try {
      if (/^https?:\/\//i.test(raw)) {
        await shell.openExternal(raw);
        return { ok: true };
      }
      let localPath = raw;
      if (raw.startsWith("file://")) {
        localPath = fileURLToPath(raw);
      } else if (raw.startsWith("agentlas://localfile/")) {
        const parsed = new URL(raw);
        localPath = parsed.searchParams.get("p") || "";
      }
      if (!path.isAbsolute(localPath)) {
        return { ok: false, message: "Only absolute local paths can be opened." };
      }
      if (!fs.existsSync(localPath)) {
        return { ok: false, message: `File does not exist: ${localPath}` };
      }
      const message = await shell.openPath(localPath);
      return message ? { ok: false, message } : { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("fs:showItemInFolder", async (_e, target: string): Promise<{ ok: boolean; message?: string }> => {
    const raw = String(target || "").trim();
    if (!raw) return { ok: false, message: "No file or folder was provided." };
    try {
      let localPath = raw;
      if (raw.startsWith("file://")) {
        localPath = fileURLToPath(raw);
      } else if (raw.startsWith("agentlas://localfile/")) {
        const parsed = new URL(raw);
        localPath = parsed.searchParams.get("p") || "";
      }
      if (!path.isAbsolute(localPath)) {
        return { ok: false, message: "Only absolute local paths can be shown in folder." };
      }
      if (!fs.existsSync(localPath)) {
        return { ok: false, message: `File does not exist: ${localPath}` };
      }
      shell.showItemInFolder(localPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
  // 산출물 내보내기 — 네이티브 저장 다이얼로그로 사용자가 고른 위치에 텍스트를 쓴다(lock-in 없음).
  ipcMain.handle(
    "fs:saveTextFile",
    async (e, suggestedName: string, content: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      try {
        const res = await dialog.showSaveDialog(win ?? undefined!, {
          defaultPath: suggestedName || "export.txt",
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        fs.writeFileSync(res.filePath, content, "utf8");
        return { ok: true, path: res.filePath };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  // ── workspace (채팅별 working_folder) ───────────────────
  ipcMain.handle("workspace:selectFolder", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return pickDirectory(win);
  });
  ipcMain.handle("workspace:get", (_e, chatId: string) => getChatWorkingFolder(chatId));
  ipcMain.handle("workspace:set", (_e, chatId: string, grant: FsPathGrant | null) => {
    setChatWorkingFolder(chatId, grant ? pathFromGrant(grant, "directory") : null);
  });
  ipcMain.handle("workspace:setFromProject", (_e, chatId: string, projectId: string) => {
    const project = getProject(projectId);
    if (!project?.folderPath) throw new Error("The project does not have a working folder.");
    // Project paths can only be written by the grant-validating project handlers
    // below. Existing rows are trusted main-owned migration state.
    setChatWorkingFolder(chatId, project.folderPath);
  });
  ipcMain.handle("workspace:defaultRunFolder", () => {
    try {
      return agentRunCwd();
    } catch {
      return null;
    }
  });

  // ── auth (agentlas.cloud 구글 로그인) ───────────────────
  ipcMain.handle("auth:getSession", () => getAuthSession());
  ipcMain.handle("auth:signInWithGoogle", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const session = await signInWithGoogle(win);
    if (session.signedIn) {
      revokeAllMobileBridgeDevicesForAuthChange(app.getPath("userData"));
      // Replace any mounted previous-account slice immediately from B's local
      // cache (often []); network reconciliation may take up to the timeout.
      failCloseActiveHubBookmarks();
      broadcastHubBookmarkSnapshot();
      void syncHubBookmarks({ rerunIfBusy: true });
    }
    return session;
  });
  ipcMain.handle("auth:signInWithBrowser", async () => {
    const session = await signInWithBrowser();
    if (session.signedIn) {
      revokeAllMobileBridgeDevicesForAuthChange(app.getPath("userData"));
      failCloseActiveHubBookmarks();
      broadcastHubBookmarkSnapshot();
      void syncHubBookmarks({ rerunIfBusy: true });
    }
    return session;
  });
  ipcMain.handle("auth:signOut", async () => {
    revokeAllMobileBridgeDevicesForAuthChange(app.getPath("userData"));
    await signOut();
    failCloseActiveHubBookmarks();
    broadcastHubBookmarkSnapshot();
    void syncHubBookmarks();
  });

  // ── usage (LLM 엔진 사용량 — 프로바이더 OAuth usage) ─────
  ipcMain.handle("usage:snapshot", async (_e, opts?: unknown) => {
    const force = !!opts && typeof opts === "object" && !Array.isArray(opts)
      && (opts as { force?: unknown }).force === true;
    // Usage와 설치 버전을 같은 영수증으로 반환한다. 최신 확인/업데이트 자체는
    // single-flight 백그라운드라 사용량 UI를 기다리게 하지 않는다.
    const [snapshot, runtimes] = await Promise.all([
      getUsageSnapshot(force ? { force: true } : undefined),
      detectRuntimes(force),
    ]);
    return {
      ...snapshot,
      runtimeVersions: runtimeVersionsWithAutoUpdate(runtimes),
    };
  });
  // Renderer는 임의 invalidate를 할 수 없다. allowlist+main cooldown 아래 대상 Provider만 원자적으로 재시도한다.
  ipcMain.handle("usage:retry", async (_e, providerId?: unknown) => {
    if (!isUsageRetryProviderId(providerId)) throw new Error("invalid usage retry provider");
    const result = await retryUsageProvider(providerId);
    if (result.attempted) clearDetectCache();
    const runtimes = await detectRuntimes(result.attempted);
    return {
      ...result,
      snapshot: {
        ...result.snapshot,
        runtimeVersions: runtimeVersionsWithAutoUpdate(runtimes),
      },
    };
  });

  // ── billing (Agentlas Hub 크레딧 — 구독/렌트수익 2계좌 + 일방 전송) ─────
  ipcMain.handle("billing:getCredits", () => getBillingCredits());
  ipcMain.handle("billing:transferEarnings", (_e, credits: number) => transferEarnings(credits));

  // ── 프롬프트 저장소 — 웹 /api/prompts 프록시(쿠키+Origin, billing 패턴) ──────
  ipcMain.handle("promptHub:list", (_e, params?: { q?: string; category?: string }) => listHubPrompts(params));
  ipcMain.handle("promptHub:get", (_e, slug: string) => getHubPrompt(slug));
  ipcMain.handle("promptHub:unlock", (_e, slug: string) => unlockHubPrompt(slug));
  ipcMain.handle("promptHub:taste", (_e, slug: string) => tasteHubPrompt(slug));
  ipcMain.handle("promptHub:tastes", () => listHubPromptTastes());
  ipcMain.handle("promptHub:bookmarks", () => listHubPromptBookmarks());
  ipcMain.handle("promptHub:bookmarkAdd", (_e, slug: string) => addHubPromptBookmark(slug));
  ipcMain.handle("promptHub:bookmarkRemove", (_e, slug: string) => removeHubPromptBookmark(slug));

  // ── 퀘스트 — 대시보드 신규 유저 튜토리얼(온보딩 대체) ──────────────────────
  ipcMain.handle("quests:list", () => listQuests());
  ipcMain.handle("quests:claim", (_e, questId: string) => claimQuest(questId));

  // ── 에이전트 durable 메모리 — 런타임 큐레이터 DB를 자가진화/타임라인 UI로 ────
  ipcMain.handle("agentMemory:entries", (_e, agentId: string, limit?: number) =>
    listMemoryEntriesForAgentUi(agentId, Math.min(Math.max(Number(limit) || 100, 1), 300)),
  );
  ipcMain.handle("agentLearning:summary", (_e, agentId: string) => getAgentLearningSummary(agentId));

  // ── 기존 메모리 가져오기 (Phase 1b) — 레거시 마크다운 폴더 → 멤버/팀/공유 메모리 ──
  //   dry-run 미리보기(어느 멤버·kind로 들어갈지) + 적용. 미리보기는 경로 미지정 시
  //   폴더 선택 대화상자를 연다. 원본 경로/자격증명은 렌더러로 반환하지 않는다.
  ipcMain.handle("memory:import-preview", async (event, agentId: string, sourcePath?: string) => {
    let resolvedPath = typeof sourcePath === "string" ? sourcePath.trim() : "";
    if (!resolvedPath) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const picked = await dialog.showOpenDialog(win ?? undefined!, {
        title: "Choose a folder or markdown file to import memory from",
        properties: ["openDirectory", "openFile"],
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }],
      });
      if (picked.canceled || picked.filePaths.length !== 1) return null;
      resolvedPath = picked.filePaths[0];
    }
    return importMemoryPreview({ agentId, sourcePath: resolvedPath });
  });
  ipcMain.handle("memory:import-apply", (_e, agentId: string, sourcePath: string) =>
    importMemoryApply({ agentId, sourcePath: String(sourcePath ?? "").trim() }));

  // ── Experience assets — local ownership + explicit, separate Cloud exchange ─
  // Pack creation still resolves project roots only through FsPathGrant. Cloud
  // calls attach the main-owned session cookie; no credential or raw path is
  // accepted from or returned to the renderer.
  ipcMain.handle("experience:hubCatalog", () => getExperienceHubCatalog());
  ipcMain.handle("experience:createPack", async (_e, input: ExperiencePackCreateIpcInput) => {
    const runtimes = await detectRuntimes();
    const activeRuntime = runtimes.find((runtime) => runtime.active) ?? runtimes[0];
    if (!activeRuntime) throw new Error("Experience Pack requires an active runtime.");
    return createExperiencePack(resolveExperiencePackCreateIpcInput(input, {
      platform: process.platform,
      arch: process.arch,
      runtimeKind: activeRuntime.kind,
    }));
  });
  ipcMain.handle("experience:listPacks", (_e, input) => listExperiencePacks(input));
  ipcMain.handle("experience:ontologySummary", (_e, agentId: string) => getExperienceOntologySummary(agentId));
  ipcMain.handle("experience:ontologyGraph", (_e, agentId: string) =>
    getExperienceOntologyGraphSnapshot(agentId));
  ipcMain.handle("agents:borrowed-profiles", () => listBorrowedAgentProfiles());
  ipcMain.handle("agents:borrowed-ontology-graph", (_e, profileId: string) =>
    getBorrowedAgentOntologyGraph(profileId));
  ipcMain.handle("experience:hubProjection", (_e, agentId: string, force?: boolean) =>
    getAgentOntologyHubProjection(agentId, { force: force === true }));
  ipcMain.handle("experience:hubResolveAttach", (_e, agentId: string, approvalId: string, decision: "approve" | "deny") =>
    resolveAgentOntologyHubAttach(agentId, approvalId, decision));
  ipcMain.handle("experience:captureFromMemory", (_e, input) => captureExperienceCandidate(input));
  ipcMain.handle("experience:listCandidates", (_e, packId: string) => listExperienceCandidates(packId));
  ipcMain.handle("experience:listOperationalPublicProjections", (_e, packId: string) =>
    listOperationalPublicProjections(packId));
  ipcMain.handle("experience:saveOperationalPublicProjection", (_e, input) =>
    saveOperationalPublicProjection(input));
  ipcMain.handle("experience:confirmOperationalPublicProjection", (_e, input) =>
    confirmOperationalPublicProjection(input));
  ipcMain.handle("experience:listTasteDrafts", (_e, agentId: string) => listLocalTasteDrafts(agentId));
  ipcMain.handle("experience:listTasteWorkflows", (_e, agentId: string) => listTasteChipWorkflows(agentId));
  ipcMain.handle("experience:saveTasteGeneralization", (_e, input) => saveTasteGeneralization(input));
  ipcMain.handle("experience:confirmTasteGeneralization", (_e, input) => confirmTasteGeneralization(input));
  ipcMain.handle("experience:pickTastePreviews", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const chipOn = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Choose CHIP-ON preview (Taste applied)",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (chipOn.canceled || chipOn.filePaths.length !== 1) return null;
    const control = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Choose CONTROL preview (same input, no Taste overlay)",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (control.canceled || control.filePaths.length !== 1) return null;
    return [chipOn.filePaths[0], control.filePaths[0]].map((file) => grantPath(file, { durable: true, exactFile: true }));
  });
  ipcMain.handle("experience:prepareTastePreviews", (_e, input) => prepareTastePreviews(input));
  ipcMain.handle("experience:uploadTasteDraft", (_e, input) => uploadTasteDraft(input));
  ipcMain.handle("experience:promote", (_e, input) => promoteExperienceCandidate(input));
  ipcMain.handle("experience:unsealPublic", (_e, input) => unsealExperienceCandidatePublic(input));
  ipcMain.handle("experience:intake-diagnostics", (_e, agentId: string) =>
    getExperienceIntakeDiagnostics(agentId));
  ipcMain.handle("experience:listPromotionReceipts", (_e, packId: string) =>
    listExperiencePromotionReceipts(packId),
  );

  // ── v74 에이전트 사용 원장 + 북마크 ─────────────────────────────────────────
  ipcMain.handle("agents:usage-summary", () => listAgentUsageSummary());
  ipcMain.handle("agents:set-bookmark", (_e, agentId: string, bookmarked: boolean) =>
    setAgentBookmark(agentId, bookmarked === true));
  ipcMain.handle("experience:createExportIntent", (_e, input) => createExperienceExportIntent(input));
  ipcMain.handle("experience:listExportIntents", (_e, packId: string) => listExperienceExportIntents(packId));
  ipcMain.handle("experience:cloudSave", (_e, input: ExperienceCloudSaveInput) => saveExperienceToCloud(input));
  ipcMain.handle("experience:cloudList", (_e, packId: string) => listExperienceCloudUploads(packId));
  ipcMain.handle("experience:cloudReconcile", (_e, input: ExperienceCloudReconcileInput) =>
    reconcileExperienceCloudUpload(input.localUploadId));
  ipcMain.handle("experience:cloudExport", (_e, input: ExperienceCloudReconcileInput) =>
    exportExperienceFromCloud(input.localUploadId));
  ipcMain.handle("experience:cloudWithdraw", (_e, input: ExperienceCloudWithdrawInput) =>
    withdrawExperienceFromCloud(input));

  // ── 유휴 드리밍 큐레이션 — 옵트인 설정(기본 OFF) + 상태 ─────────────────────
  ipcMain.handle("memoryDreaming:status", () => getDreamingStatus());
  ipcMain.handle("memoryDreaming:setEnabled", (_e, enabled: unknown) => {
    setDreamingEnabled(enabled === true);
    return getDreamingStatus();
  });

  // ── confirm (확인 요청 — 챗에서 사용자 결정 대기) ────────
  ipcMain.handle("confirm:listPending", () => listPendingConfirmations());
  ipcMain.handle("confirm:commitAnswer", (_e, input: { chatId?: unknown; reply?: unknown }) =>
    commitPendingConfirmationAnswer(
      typeof input?.chatId === "string" ? input.chatId : "",
      typeof input?.reply === "string" ? input.reply : "",
    ));
  ipcMain.handle("confirm:committedAnswers", (_e, chatId: unknown) =>
    listCommittedQuestionAnswers(typeof chatId === "string" ? chatId : ""));
  ipcMain.handle("confirm:snooze", (_e, input: { chatId?: unknown; sourceMessageId?: unknown; resumeAt?: unknown }) =>
    snoozePendingConfirmation(
      typeof input?.chatId === "string" ? input.chatId : "",
      typeof input?.sourceMessageId === "string" ? input.sourceMessageId : "",
      typeof input?.resumeAt === "string" ? input.resumeAt : "",
    ));

  // ── attention (Dock/taskbar/app badge — 놓치면 에이전트가 멈추는 승인 요청) ─────
  ipcMain.handle("attention:setPendingConfirmations", (e, count: number) => {
    applyPendingConfirmationAttention(BrowserWindow.fromWebContents(e.sender), count);
  });

  // ── runtime ─────────────────────────────────────────────
  ipcMain.handle("runtime:detect", (_e, force?: boolean) => detectRuntimes(force === true));
  ipcMain.handle("runtime:setActive", (_e, selection: RuntimeSelection) =>
    setActiveRuntime(selection),
  );
  ipcMain.handle("runtime:installCli", (_e, kind: InstallableCli) => installCli(kind));
  ipcMain.handle("runtime:openCliLogin", (_e, kind: InstallableCli) => {
    // 로그인 터미널을 여는 시점에 감지/사용량 캐시를 즉시 무효화 — 로그인 완료가
    // watchRecovery 폴링(및 그 이후 일반 폴링)에 재시작 없이 바로 반영되게 한다.
    clearDetectCache();
    if (kind === "claude-code" || kind === "codex" || kind === "gemini") invalidateUsage(kind);
    return openCliLogin(kind);
  });
  ipcMain.handle("runtime:updateCli", async (_e, kind: InstallableCli) => {
    const releaseMaintenance = tryAcquireRuntimeMaintenance();
    if (!releaseMaintenance) {
      return {
        ok: false,
        message: "CLI update deferred until active chats and automations finish",
      };
    }
    try {
      const result = await updateCli(kind);
      if (result.ok) clearDetectCache();
      return result;
    } finally {
      releaseMaintenance();
    }
  });
  ipcMain.handle("runtime:listCommands", () => listRuntimeCommands());
  ipcMain.handle(
    "runtime:listModels",
    (_e, sel: { kind: RuntimeKind; backend?: RuntimeBackend | null; availableModels?: string[] | null }) =>
      listRuntimeModels(sel.kind, sel.backend ?? null, sel.availableModels ?? null, Date.now()),
  );
  ipcMain.handle("agentRuntime:list", () => listAgentRuntimeOverrides());
  ipcMain.handle(
    "agentRuntime:get",
    (_e, scope: AgentRuntimeOverrideScope, targetId: string) =>
      getAgentRuntimeOverride(scope, targetId),
  );
  ipcMain.handle(
    "agentRuntime:set",
    (_e, input: AgentRuntimeOverrideSetInput) => setAgentRuntimeOverride(input),
  );
  ipcMain.handle(
    "agentRuntime:remove",
    (_e, scope: AgentRuntimeOverrideScope, targetId: string) =>
      removeAgentRuntimeOverride(scope, targetId),
  );

  // ── secrets (macOS Keychain) ────────────────────────────
  ipcMain.handle("secrets:saveApiKey", async (_e, backend: RuntimeBackend, key: string) => {
    await saveApiKey(backend, key);
    clearModelCache();
  });
  ipcMain.handle("secrets:hasApiKey", (_e, backend: RuntimeBackend) => hasApiKey(backend));
  ipcMain.handle("secrets:deleteApiKey", async (_e, backend: RuntimeBackend) => {
    await deleteApiKey(backend);
    clearModelCache();
  });
  
  // ── custom backend config ───────────────────────────────
  ipcMain.handle("config:getCustomBaseUrl", () => {
    try {
      const row = getDb().prepare("SELECT value FROM meta WHERE key = 'custom_base_url'").get() as { value: string } | undefined;
      return row?.value ?? "";
    } catch { return ""; }
  });
  // 보안: 이 값은 byok.ts가 BYOK API 키를 Bearer로 보내는 baseUrl이 된다. 손상된 렌더러가
  // 임의 origin으로 재지정해 키를 탈취하지 못하게, 저장 전에 스킴/호스트를 검증한다.
  // 정상 사용(공개 https API, 로컬/LAN http LLM)은 그대로 허용 — 부작용 없음.
  ipcMain.handle("config:setCustomBaseUrl", (_e, url: unknown) => {
    const safe = validateCustomBaseUrl(typeof url === "string" ? url : "");
    getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('custom_base_url', ?)").run(safe);
    clearModelCache();
  });

  // ── 에이전트 동시성(스웜 크기) — 사양 기반 추천 + 사용자 슬라이더 ─────────
  ipcMain.handle("system:concurrencyInfo", () => getAgentConcurrencyInfo());
  // 브리핑 인터뷰 모드 (smart / build-only / off)
  ipcMain.handle("interview:getMode", () => getInterviewMode());
  ipcMain.handle("interview:setMode", (_e, mode: InterviewMode) => setInterviewMode(mode));
  ipcMain.handle("system:setConcurrency", (_e, value: unknown) => {
    setAgentConcurrency(Number(value));
    return getAgentConcurrencyInfo();
  });

  // ── env vault (글로벌 외부 API 키) ──────────────────────
  ipcMain.handle("env:list", async () => {
    // 1) keychain에 저장된 env keys
    const stored = await listEnvKeys();
    // 2) 설치된 에이전트들의 envRequirements
    const agents = listInstalledAgents();
    type Aggregated = {
      hasValue: boolean;
      requiredBy: Array<{
        agentId: string;
        agentName: string;
        agentNameEn: string;
        label?: string;
        labelEn?: string;
        hint?: string;
        hintEn?: string;
      }>;
    };
    const map = new Map<string, Aggregated>();
    for (const a of agents) {
      for (const req of a.envRequirements) {
        const entry = map.get(req.key) ?? { hasValue: false, requiredBy: [] };
        entry.requiredBy.push({
          agentId: a.id,
          agentName: a.name,
          agentNameEn: a.nameEn,
          label: req.label,
          labelEn: req.labelEn,
          hint: req.hint,
          hintEn: req.hintEn,
        });
        map.set(req.key, entry);
      }
    }
    // 설치된 외부 MCP 서버가 요구하는 env도 합친다 — "어느 도구가 이 키를 쓰는지" 표시.
    for (const server of listInstalledServers()) {
      const catalog = server.catalogId ? getCatalogEntry(server.catalogId) : null;
      for (const key of server.envKeys) {
        const req = catalog?.envRequirements.find((r) => r.key === key);
        const entry = map.get(key) ?? { hasValue: false, requiredBy: [] };
        entry.requiredBy.push({
          agentId: `mcp:${server.id}`,
          agentName: `${server.name} (MCP)`,
          agentNameEn: `${server.nameEn || server.name} (MCP)`,
          label: req?.label,
          labelEn: req?.labelEn,
          hint: req?.hint,
          hintEn: req?.hintEn,
        });
        map.set(key, entry);
      }
    }
    // 멀티모달 전역 fallback provider가 요구하는 키도 환경변수 화면에 노출.
    for (const req of selectedMultimodalEnvRequirements(getMultimodalSettings())) {
      const entry = map.get(req.key) ?? { hasValue: false, requiredBy: [] };
      entry.requiredBy.push({
        agentId: `multimodal:${req.key}`,
        agentName: "Agentlas Multimodal Fallback",
        agentNameEn: "Agentlas Multimodal Fallback",
        label: req.label,
        labelEn: req.labelEn,
        hint: req.hint,
        hintEn: req.hintEn,
      });
      map.set(req.key, entry);
    }
    // 사용자가 직접 추가한 키도 포함 (요구하는 에이전트 없음)
    for (const k of stored) {
      if (!map.has(k)) map.set(k, { hasValue: true, requiredBy: [] });
    }
    // hasValue + 마스킹 미리보기를 한 번에 체크 (병렬). 미리보기는 메인에서 생성 — 전체 값 X.
    const keys = [...map.keys()];
    const values = await Promise.all(keys.map((k) => hasEnvVar(k)));
    const previews = await Promise.all(
      keys.map((k, i) => (values[i] ? previewEnvVar(k) : Promise.resolve(null))),
    );
    return keys.map((key, i) => ({
      key,
      hasValue: values[i],
      preview: previews[i] ?? null,
      requiredBy: map.get(key)!.requiredBy,
    }));
  });
  ipcMain.handle("env:set", (_e, key: string, value: string) => setEnvVar(key, value));
  ipcMain.handle("env:has", (_e, key: string) => hasEnvVar(key));
  ipcMain.handle("env:preview", (_e, key: string) => previewEnvVar(key));
  ipcMain.handle("env:remove", (_e, key: string) => deleteEnvVar(key));

  // ── multimodal global fallback ─────────────────────────
  ipcMain.handle("multimodal:listProviders", () => listMultimodalProviders());
  ipcMain.handle("multimodal:getSettings", () => getMultimodalSettings());
  ipcMain.handle("multimodal:saveSettings", (_e, settings: Partial<MultimodalSettings>) =>
    saveMultimodalSettings(settings),
  );
  ipcMain.handle("multimodal:status", () => getMultimodalStatus());

  // ── Oberon real generation bridges ─────────────────────────
  ipcMain.handle("oberon:planWithCli", (_e, request: OberonPlanRequest) =>
    planOberonWithCli(request),
  );
  ipcMain.handle("oberon:startKeyframes", (_e, request: OberonKeyframeRequest) =>
    startOberonKeyframes(request),
  );
  // 마스터 시트/콘티 시트 — 키프레임 잡 재사용 (조회/취소는 keyframe 채널로).
  ipcMain.handle("oberon:startSheets", (_e, request: OberonSheetRequest) =>
    startOberonSheets(request),
  );
  ipcMain.handle("oberon:getKeyframeJob", (_e, id: string) => getOberonKeyframeJob(id));
  ipcMain.handle("oberon:cancelKeyframes", (_e, id: string) => cancelOberonKeyframes(id));
  ipcMain.handle("oberon:openKeyframeOutput", (_e, id: string) => openOberonKeyframeOutput(id));
  ipcMain.handle("oberon:startRender", (_e, request: OberonRenderRequest) =>
    startOberonRender(request),
  );
  ipcMain.handle("oberon:getRenderJob", (_e, id: string) => getOberonRenderJob(id));
  ipcMain.handle("oberon:cancelRender", (_e, id: string) => cancelOberonRenderJob(id));
  ipcMain.handle("oberon:openRenderOutput", (_e, id: string) => openOberonRenderOutput(id));
  ipcMain.handle("oberon:startMotionAd", (_e, request) => startOberonMotionAd(request));
  ipcMain.handle("oberon:getMotionAdJob", (_e, id: string) => getOberonMotionAdJob(id));
  ipcMain.handle("oberon:cancelMotionAd", (_e, id: string) => cancelOberonMotionAd(id));
  ipcMain.handle("oberon:openMotionAdOutput", (_e, id: string) => openOberonMotionAdOutput(id));
  ipcMain.handle("oberon:startAnimate", (_e, request) => startOberonAnimate(request));
  ipcMain.handle("oberon:getAnimateJob", (_e, id: string) => getOberonAnimateJob(id));
  ipcMain.handle("oberon:cancelAnimate", (_e, id: string) => cancelOberonAnimate(id));
  ipcMain.handle("oberon:openAnimateOutput", (_e, id: string) => openOberonAnimateOutput(id));
  ipcMain.handle("oberon:animateKeyStatus", () => animateKeyStatus());

  // ── team (설치된 에이전트) ─────────────────────────────
  ipcMain.handle("team:list", () => listInstalledAgents());
  ipcMain.handle("team:install", (_e, slug: string) => installAgent(slug));
  ipcMain.handle("team:installMine", (_e, id: string) => installMyAgent(id));
  ipcMain.handle("team:uninstall", (_e, id: string) => uninstallAgent(id));
  ipcMain.handle("team:setLocalDisplayName", (_e, id: string, value: string) =>
    setAgentLocalDisplayName(id, value),
  );
  // 로컬 폴더 임포트 — 런타임 감지 + 라우팅 저장 후 설치된 에이전트로 반환
  ipcMain.handle(
    "team:importLocalFolder",
    async (_e, input: { path: string; scope: FsReadScope }) =>
      (await importLocalFolder(resolveFsReadPath(input.path, input.scope))).agent,
  );
  ipcMain.handle("team:resolveSubAgents", (_e, agentId: string) => resolveAgentTeam(agentId));

  // ── agentFiles (에이전트 폴더 파일 — 우측 패널 에디터) ──
  ipcMain.handle("agentFiles:list", (_e, agentId: string) => listAgentFiles(agentId));
  ipcMain.handle("agentFiles:read", (_e, agentId: string, absPath: string) =>
    readAgentFile(agentId, absPath),
  );
  ipcMain.handle("agentFiles:write", (_e, agentId: string, absPath: string, content: string) =>
    writeAgentFile(agentId, absPath, content),
  );
  ipcMain.handle("agentFiles:promptSource", (_e, agentId: string) => readAgentPromptSource(agentId));

  // ── runLedger (실행/실패 원장 — 실패 메모리·자가진화 평가 입력) ──
  ipcMain.handle("runLedger:events", (_e, runId: string, limit?: number) =>
    listRunEvents(runId, limit),
  );
  ipcMain.handle(
    "runLedger:failures",
    (_e, input?: { runId?: string; automationId?: string; chatId?: string; limit?: number }) =>
      listFailureEvents(input),
  );

  // ── agentEvolution (자가진화 proposal 원장 — 승인 흐름을 durable DB에 기록) ──
  ipcMain.handle("agentEvolution:list", (_e, agentId: string, limit?: number) =>
    listAgentEvolutionProposals(agentId, limit),
  );
  ipcMain.handle("agentEvolution:createProposal", (_e, input: CreateAgentEvolutionProposalInput) =>
    createAgentEvolutionProposal(input),
  );
  ipcMain.handle("agentEvolution:approveAndApply", (_e, proposalId: string, note?: string) =>
    approveAndApplyAgentEvolutionProposal(proposalId, note),
  );
  ipcMain.handle("agentEvolution:reject", (_e, proposalId: string, note?: string) =>
    rejectAgentEvolutionProposal(proposalId, note),
  );
  ipcMain.handle("agentEvolution:markMeasured", (_e, proposalId: string, note?: string) =>
    markAgentEvolutionProposalMeasured(proposalId, note),
  );
  ipcMain.handle("agentEvolution:rollback", (_e, proposalId: string) =>
    rollbackAgentEvolutionProposal(proposalId),
  );
  // 4표면 발화 UX — 에이전트 무관 전역 "성장 제안"(고위험 pending + 저위험 자동적용분).
  ipcMain.handle("agentEvolution:listGrowth", (_e, limit?: number) =>
    listPendingGrowthProposals(limit),
  );

  // ── skills (주입 가능한 스킬 카탈로그 — 엔진 skills/ 디렉토리 실측) ──
  // 하드코딩 목록이 아니라 디스크의 SKILL.md 프론트매터에서 name/description 을 읽는다.
  // SKILL.md 가 없는 디렉토리는 카탈로그에서 제외(추측 금지, 실측 원칙).
  ipcMain.handle("skills:listCatalog", () => listSkillCatalog());
  ipcMain.handle("skills:readCatalog", (_event, slug: string) => readSkillCatalogAsset(slug));

  // ── mcpTools (외부 MCP 툴 플러그인 — Slack/Discord/GitHub 등) ─
  ipcMain.handle("mcpTools:listCatalog", () => MCP_TOOL_CATALOG);
  ipcMain.handle("mcpTools:listInstalled", () => listInstalledServers());
  ipcMain.handle("mcpTools:install", (_e, catalogId: string) => installFromCatalog(catalogId));
  ipcMain.handle(
    "mcpTools:installCustom",
    (
      _e,
      def: {
        name: string;
        transport: McpTransport;
        command?: string;
        args?: string[];
        url?: string;
        envKeys?: string[];
      },
    ) => installCustomServer(def),
  );
  ipcMain.handle("mcpTools:remove", (_e, id: string) => removeServer(id));
  ipcMain.handle("mcpTools:setEnabled", (_e, id: string, enabled: boolean) =>
    setServerEnabled(id, enabled),
  );
  ipcMain.handle("mcpTools:test", (_e, id: string) => testServerById(id));
  ipcMain.handle("mcpTools:status", () => statusAllServers());
  ipcMain.handle("mcpTools:recommendForBuild", (_e, input) => recommendMcpBuildPlan(input));
  // 실행 전 키 요청 시트의 완료 신호 — 비밀 값은 절대 이 채널로 오지 않는다(값은 env:set).
  // 만료/미지의 runId는 { ok:false } 멱등 무시라 렌더러 재시도가 안전하다.
  ipcMain.handle("mcp:supplyRunKeys", (_e, runId: string, outcome: unknown) =>
    resolveRunKeyElicitation(String(runId), outcome),
  );
  ipcMain.handle("openCrab:readiness", async () => {
    const readiness = await getOpenCrabReadiness();
    switch (readiness.reason) {
      case "not_installed":
        return { state: "absent", installed: false, enabled: false, configured: false, connected: false, reason: readiness.reason };
      case "disabled":
        return { state: "disabled", installed: true, enabled: false, configured: false, connected: false, reason: readiness.reason };
      case "missing_endpoint":
        return { state: "needs-credential", installed: true, enabled: true, configured: false, connected: false, reason: readiness.reason };
      case "query_tool_unavailable":
        return { state: "unreachable", installed: true, enabled: true, configured: true, connected: true, reason: readiness.reason };
      case "unreachable":
        return { state: "unreachable", installed: true, enabled: true, configured: true, connected: false, reason: readiness.reason };
      default:
        return readiness.available
          ? { state: "ready", installed: true, enabled: true, configured: true, connected: true }
          : { state: "unreachable", installed: true, enabled: true, configured: true, connected: false, reason: "unreachable" };
    }
  });

  // ── marketplace (agentlas.cloud Hub-only; no in-memory fallback catalog) ─
  ipcMain.handle("marketplace:listBundles", () => getMarketSource().listBundles());
  ipcMain.handle("marketplace:search", (_e, q: string) => getMarketSource().searchAgents(q));
  ipcMain.handle("marketplace:listFirms", () => getMarketSource().listFirms());
  ipcMain.handle("marketplace:status", (_e, force?: boolean) => refreshMarketSourceStatus(force === true));
  ipcMain.handle("marketplace:bookmarks", () => listHubAgentBookmarks());
  ipcMain.handle("marketplace:bookmarksSync", () => syncHubBookmarks({ rerunIfBusy: true }));
  ipcMain.handle("marketplace:bookmarkAdd", (_e, listing) => {
    const bookmark = addHubAgentBookmark(listing);
    broadcastHubBookmarkSnapshot();
    void syncHubBookmarks({ rerunIfBusy: true });
    return bookmark;
  });
  ipcMain.handle("marketplace:bookmarkRemove", (_e, slug: string, entityKind?: string) => {
    removeHubAgentBookmark(slug, entityKind);
    broadcastHubBookmarkSnapshot();
    void syncHubBookmarks({ rerunIfBusy: true });
  });
  // 내 에이전트(cargo) — 미로그인/오프라인/실패면 빈 배열(팝업이 안내 처리).
  ipcMain.handle("marketplace:listMine", async () => {
    try {
      return await listMyAgentsCached();
    } catch {
      return [];
    }
  });

  // ── cloud agents ────────────────────────────────────────────
  //
  // Upload progress. `packageAndReviewCloudAgent` has always computed its phases
  // and offered them through `opts.onStage`, but no caller ever passed one — so
  // every upload surface showed a static "…중" label for the whole run and a
  // user could not tell a working upload from a dead one. These options bind
  // that existing callback to a renderer event channel, correlated by an opaque
  // renderer-generated `progressId`. The id carries no authority: it only routes
  // progress back to the window that started the upload.
  const cloudPublishProgressOptions = (
    event: IpcMainInvokeEvent,
    progressId: string | undefined,
    locale?: "ko" | "en",
  ): { onStage?: (stage: CloudAgentPublishStage, detail?: string) => void; locale?: "ko" | "en" } => {
    if (!progressId) return locale ? { locale } : {};
    const win = BrowserWindow.fromWebContents(event.sender);
    const startedAt = Date.now();
    return {
      ...(locale ? { locale } : {}),
      onStage: (stageName, detail) => {
        if (!win || win.isDestroyed()) return;
        try {
          win.webContents.send("cloudAgents:progress", {
            progressId,
            stage: stageName,
            ...(detail ? { detail } : {}),
            elapsedMs: Date.now() - startedAt,
          } satisfies CloudAgentPublishProgressEvent);
        } catch {
          /* window went away mid-upload; the invoke result still resolves */
        }
      },
    };
  };

  ipcMain.handle("cloudAgents:listRegisteredUploadOptions", () => registeredUploadOptions());
  ipcMain.handle("cloudAgents:saveRegisteredPrivate", async (event, input: CloudAgentRegisteredSaveRequest) => {
    const source = registeredUploadRoot(input.target);
    return packageAndReviewCloudAgent({
      ...source,
      visibility: "private-link",
      reviewMode: "static-only",
    }, cloudPublishProgressOptions(event, input.progressId));
  });
  ipcMain.handle("cloudAgents:publishRegisteredPublic", async (event, input: CloudAgentRegisteredPublishRequest) => {
    const source = registeredUploadRoot(input.target);
    return packageAndReviewCloudAgent({
      ...source,
      visibility: "marketplace",
      reviewMode: input.reviewMode,
      notes: input.notes,
    }, cloudPublishProgressOptions(event, input.progressId));
  });
  // Owner-private save is the default product action. It keeps local
  // secret/path/hash safety checks but never opts into public Hub review.
  ipcMain.handle("cloudAgents:savePrivate", async (event, input: CloudAgentPrivateSaveRequest) =>
    packageAndReviewCloudAgent({
      ...resolveCloudAgentPackageRequest(input),
      visibility: "private-link",
      reviewMode: "static-only",
    }, cloudPublishProgressOptions(event, input.progressId)),
  );
  // Build already received an explicit renderer choice. Do not open another
  // native confirmation here. Main still owns the filesystem authority and the
  // product contract is pinned to owner-private/static-only with no renderer
  // visibility, slug, notes, review-mode, or dry-run override.
  ipcMain.handle("cloudAgents:saveBuiltPrivate", async (event, input: CloudAgentBuiltPrivateSaveRequest) => {
    assertTrustedSitePublishIpcSender(event);
    const rootPath = resolveFsReadPath(input.folder, input.scope);
    return packageAndReviewCloudAgent({
      rootPath,
      visibility: "private-link",
      reviewMode: "static-only",
    }, cloudPublishProgressOptions(event, input.progressId));
  });
  // Public Hub publication is intentionally a separate, explicit action.
  ipcMain.handle("cloudAgents:publishPublic", async (event, input: CloudAgentHubPublishRequest) =>
    packageAndReviewCloudAgent({
      ...resolveCloudAgentPackageRequest(input),
      visibility: "marketplace",
    }, cloudPublishProgressOptions(event, input.progressId)),
  );
  // Compatibility surface for existing callers/flags. The packager defaults
  // omitted visibility to private-link; explicit marketplace remains public.
  ipcMain.handle("cloudAgents:publish", async (_e, input: CloudAgentPublishRequest) =>
    packageAndReviewCloudAgent(resolveCloudAgentPackageRequest(input)),
  );

  // ── firms (설치된 회사) ────────────────────────────────
  ipcMain.handle("firms:list", () => listFirms());
  ipcMain.handle("firms:get", (_e, id: string) => getFirm(id));
  ipcMain.handle("firms:install", (_e, slug: string) => installFirm(slug));
  ipcMain.handle("firms:uninstall", (_e, id: string) => uninstallFirm(id));
  // 정규화된 3-tier 조직 스펙 조회 (저장된 리졸버 결과 또는 orgChart 파생)
  ipcMain.handle("firms:getResolvedOrg", (_e, id: string) => {
    const firm = getFirm(id);
    return firm ? getResolvedOrg(firm) : null;
  });
  // LLM으로 팀 폴더를 분석해 3-tier 조직 스펙 생성 (임포트 팀용)
  ipcMain.handle("firms:resolveOrg", (_e, id: string) => resolveTeamOrg(id));

  // ── agent groups (자주 쓰는 조합 / 상위 오케스트레이터) ──────
  ipcMain.handle("agentGroups:list", () => listAgentGroups());
  ipcMain.handle("agentGroups:listResolved", () => listResolvedAgentGroups());
  ipcMain.handle("agentGroups:getResolved", (_e, id: string) => getResolvedAgentGroup(id));
  ipcMain.handle("agentGroups:create", (_e, input: AgentGroupCreateInput) =>
    createAgentGroup(input),
  );
  ipcMain.handle("agentGroups:update", (_e, id: string, patch: AgentGroupUpdateInput) =>
    updateAgentGroup(id, patch),
  );
  ipcMain.handle("agentGroups:removeMember", (_e, groupId: string, memberId: string) =>
    removeAgentGroupMember(groupId, memberId),
  );
  ipcMain.handle("agentGroups:remove", (_e, id: string) => removeAgentGroup(id));

  // ── Telegram Connect (Bot API polling + Agentlas invocation bridge) ─────
  ipcMain.handle("telegram:listBindings", () => listTelegramBindings());
  ipcMain.handle("telegram:autoConnect", (_e, input) => autoConnectTelegram(input));
  ipcMain.handle("telegram:start", (_e, input) => startTelegramConnection(input));
  ipcMain.handle("telegram:clone", (_e, input) => cloneTelegramConnection(input));
  ipcMain.handle("telegram:resume", (_e, id: string) => resumeTelegramConnection(id));
  ipcMain.handle("telegram:stop", (_e, id: string) => stopTelegramConnection(id));
  ipcMain.handle("telegram:remove", (_e, id: string, deleteBot?: boolean) => removeTelegramConnection(id, deleteBot === true));
  ipcMain.handle("telegram:resetConversation", (_e, id: string) => resetTelegramConversation(id));
  ipcMain.handle("telegram:sendTest", (_e, id: string) => sendTelegramTest(id));
  ipcMain.handle("telegram:openBot", (_e, id: string) => openTelegramBot(id));
  ipcMain.handle("telegram:configureBotSettings", (_e, id: string) => configureTelegramBotSettings(id));
  ipcMain.handle("telegram:pruneOrphans", () => pruneOrphanedTelegramBindings());

  // ── browser (자격증명 볼트 · 전용 프로필 · 승인 게이트 · 로그) ─
  ipcMain.handle("browser:status", () => getBrowserStatus());
  ipcMain.handle("browser:listSites", () => browserListSites());
  ipcMain.handle("browser:saveSite", (_e, input) => browserSaveSite(input));
  ipcMain.handle("browser:deleteSite", (_e, site: string) => browserDeleteSite(site));
  ipcMain.handle("browser:openLogin", (_e, site: string) => browserOpenLogin(site));
  ipcMain.handle("browser:markSession", (_e, site: string, status: "valid" | "expired" | "none") =>
    browserMarkSession(site, status),
  );
  ipcMain.handle("browser:listPermissions", () => browserListPermissions());
  ipcMain.handle("browser:revokePermission", (_e, site: string, actionType: string) =>
    browserRevokePermission(site, actionType),
  );
  ipcMain.handle("browser:resolveApproval", (_e, requestId: string, decision: BrowserPermissionDecision) =>
    browserResolveApproval(requestId, decision),
  );
  ipcMain.handle("browser:listLogs", (_e, limit?: number) => browserListLogs(limit));
  ipcMain.handle("browser:captureLiveFrame", (event) => {
    assertTrustedSitePublishIpcSender(event);
    return captureBrowserLiveFrame();
  });
  ipcMain.handle("browser:focusLiveTarget", (event, targetId?: string) => {
    assertTrustedSitePublishIpcSender(event);
    return focusBrowserLiveTarget(typeof targetId === "string" ? targetId.slice(0, 256) : undefined);
  });
  ipcMain.handle("computerUse:capturePreview", (event, sourceId?: string) => {
    assertTrustedSitePublishIpcSender(event);
    return captureComputerUsePreview(typeof sourceId === "string" ? sourceId.slice(0, 256) : undefined);
  });
  ipcMain.handle("computerUse:revealPreview", (event) => {
    assertTrustedSitePublishIpcSender(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false };
    win.minimize();
    return { ok: true };
  });

  // ── projects ───────────────────────────────────────────
  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("projects:get", (_e, id: string) => getProject(id));
  ipcMain.handle("projects:timeline", (_e, id: string, limit?: number) =>
    getProjectTimelineSnapshot(id, limit),
  );
  ipcMain.handle(
    "projects:create",
    (_e, input: { name: string; defaultAgentId?: string | null; contextNote?: string | null; folderGrant?: FsPathGrant | null }) =>
      createProject({
        name: input.name,
        defaultAgentId: input.defaultAgentId,
        contextNote: input.contextNote,
        folderPath: input.folderGrant ? pathFromGrant(input.folderGrant, "directory") : null,
      }),
  );
  ipcMain.handle(
    "projects:update",
    (
      _e,
      id: string,
      patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId">> & { folderGrant?: FsPathGrant | null },
    ) => updateProject(id, {
      name: patch.name,
      contextNote: patch.contextNote,
      defaultAgentId: patch.defaultAgentId,
      ...(patch.folderGrant !== undefined
        ? { folderPath: patch.folderGrant ? pathFromGrant(patch.folderGrant, "directory") : null }
        : {}),
    }),
  );
  ipcMain.handle("projects:remove", (_e, id: string) => removeProject(id));

  // ── ontology activation (project-local, inbox + explicit sources only) ──
  ipcMain.handle("ontology:getProject", (_e, projectId: string) =>
    getProjectOntologyStatus(projectId),
  );
  ipcMain.handle("ontology:provision", (_e, projectId: string) =>
    provisionProjectOntology(projectId),
  );
  ipcMain.handle("ontology:sync", (_e, projectId: string) =>
    syncProjectOntology(projectId),
  );
  ipcMain.handle(
    "ontology:addSource",
    (
      _e,
      projectId: string,
      absPath: string,
      scope: "public" | "internal" | "private",
      kind: "project" | "company" | "personal",
    ) => addProjectOntologySource(projectId, absPath, scope, kind),
  );
  ipcMain.handle("ontology:openInbox", async (_e, projectId: string) => {
    const status = getProjectOntologyStatus(projectId);
    if (!status.inboxPath || status.state === "failed") {
      return { ok: false, path: null, message: status.error || "Project folder is not set." };
    }
    const message = await shell.openPath(status.inboxPath);
    return { ok: !message, path: status.inboxPath, message: message || "opened" };
  });

  // ── chats ──────────────────────────────────────────────
  ipcMain.handle("chats:listRecent", (_e, limit?: number) => listRecentChats(limit));
  ipcMain.handle("chats:listArchived", () => listArchivedChats());
  ipcMain.handle("chats:archive", (_e, id: string) => archiveChat(id));
  ipcMain.handle("chats:unarchive", (_e, id: string) => unarchiveChat(id));
  ipcMain.handle("chats:listByProject", (_e, projectId: string) =>
    listChatsByProject(projectId),
  );
  ipcMain.handle("chats:listByFirm", (_e, firmId: string) => listChatsByFirm(firmId));
  ipcMain.handle("chats:get", (_e, id: string) => getChat(id));
  ipcMain.handle(
    "chats:create",
    (
      _e,
      input: {
        agentId?: string;
        firmId?: string | null;
        agentGroupId?: string | null;
        projectId?: string | null;
        title?: string;
        continueFromChatId?: string | null;
        taskMode?: "task" | "conversation";
        originSurface?: "one" | "work";
      },
    ) => createChat({
      ...input,
      originSurface: input?.originSurface === "one" ? "one" : "work",
    }),
  );
  ipcMain.handle("chats:rename", (_e, id: string, title: string) => renameChat(id, title));
  ipcMain.handle("chats:switchAgent", (_e, id: string, agentId: string) =>
    switchChatAgent(id, agentId),
  );
  ipcMain.handle("chats:remove", (_e, id: string) => removeChat(id));
  // 세션 recap — 자리를 비운 사이 도착한 에이전트 응답 한 줄 요약(없으면 null).
  ipcMain.handle("chats:recap", (_e, id: string) => buildChatRecap(id, currentUiLocale() === "ko" ? "ko" : "en"));
  ipcMain.handle("chats:markViewed", (_e, id: string) => {
    markChatRecapViewed(id);
  });
  ipcMain.handle("chats:setContinuousMode", (_e, id: string, enabled: boolean) => {
    setChatContinuousMode(id, enabled);
    return getChat(id);
  });
  ipcMain.handle("chats:setSwarmMode", (_e, id: string, enabled: boolean) => {
    setChatSwarmMode(id, enabled);
    return getChat(id);
  });
  // 고용(빌림) 카드 채팅 바인딩 — 빈 배열이면 해고. 매 send에 자동 재주입되는 원본.
  ipcMain.handle("chats:setHiredAgents", (_e, id: string, cards: HiredAgentCard[]) =>
    setChatHiredAgents(id, Array.isArray(cards) ? cards : []),
  );
  ipcMain.handle("tasks:list", (_e, input?: { limit?: number; includeArchived?: boolean }) =>
    listCanonicalTasks(input),
  );
  ipcMain.handle("tasks:get", (_e, id: string) => getCanonicalTask(id));
  ipcMain.handle("tasks:listProjections", (_e, input) =>
    oneTaskProjectionRuntime.listProjections(input));
  ipcMain.handle("tasks:getProjection", (_e, id: string, input) =>
    oneTaskProjectionRuntime.getProjection(id, input));
  ipcMain.handle("tasks:findForChat", (_e, chatId: string) => findCanonicalTaskForChat(chatId));
  ipcMain.handle("tasks:forChat", (_e, chatId: string) => getCanonicalTaskForChat(chatId));
  ipcMain.handle("tasks:acceptResult", async (_e, input: CanonicalTaskResultAcceptance) => {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.taskId !== "string" ||
      !Number.isSafeInteger(input.expectedVersion) ||
      typeof input.expectedRunId !== "string"
    ) {
      throw new TypeError("Invalid Task result acceptance request");
    }
    // Async pre-pass: warm the completion-claim judgments the synchronous
    // Value Closure trust validator peeks. Miss = deterministic regex verdict.
    await prejudgeCompletionClaims(ACCEPTED_RESULT_CLOSURE_FACT_STATEMENTS, { timeoutMs: 6_000 }).catch(() => undefined);
    const task = getCanonicalTask(input.taskId);
    const receipt = task?.originChatId
      ? invocationService.latestReceipt(task.originChatId)
      : null;
    if (task?.originChatId && getSessionCookieHeader()) {
      const projectDir = getChatWorkingFolder(task.originChatId) ?? process.cwd();
      const goalId = desktopWorkforceGoalId(task.id);
      const context = await loadDesktopWorkforceGoal(projectDir, goalId);
      if (context.goals.length) {
        await completeDesktopWorkforceGoal({
          projectDir,
          goalId,
          status: "completed",
        });
      }
    }
    const accepted = acceptCanonicalTaskResult(input, receipt);
    const closure = ensureAcceptedResultValueClosure({
      priorTaskVersion: input.expectedVersion,
      acceptedTask: accepted,
      expectedRunId: input.expectedRunId,
      receipt,
      confirmedByUser: true,
    });
    try {
      ensureVerifiedAcceptedResultValueClosure({
        priorTaskVersion: input.expectedVersion,
        acceptedTask: accepted,
        expectedRunId: input.expectedRunId,
        receipt,
        confirmedByUser: true,
      });
    } catch {
      // Host artifact verification is an optional fail-closed sibling record.
      // Acceptance remains partial when exact bound bytes cannot be re-proven.
    }
    try {
      sealOneMemoryCandidateProvenance({
        sourceTaskId: accepted.id,
        sourceTaskVersion: accepted.version,
        sourceRunId: input.expectedRunId,
        sourceValueClosureId: closure.value.closure.valueClosureId,
        sourceValueClosureVersion: closure.value.version,
      });
    } catch {
      // Memory review is optional. Provenance sealing must never roll back the
      // already-authoritative Task acceptance and accepted Value Closure.
    }
    try {
      const hostId = loadOrCreateMobileBridgeHostIdentity(app.getPath("userData")).hostId;
      tryProduceAcceptedResultSuggestion({
        hostId,
        taskId: accepted.id,
        expectedTaskVersion: accepted.version,
        expectedTaskUpdatedAt: accepted.updatedAt,
        expectedRunId: input.expectedRunId,
        valueClosureId: closure.value.closure.valueClosureId,
        expectedValueClosureVersion: closure.value.version,
        confirmedByUser: true,
      });
    } catch {
      // Ecosystem growth is optional and must never roll back result acceptance.
    }
    try {
      tryCompleteOneActivationFirstValue({
        taskId: accepted.id,
        expectedTaskVersion: accepted.version,
        valueClosureId: closure.value.closure.valueClosureId,
        expectedValueClosureVersion: closure.value.version,
      });
    } catch {
      // First-use activation is optional. It must never roll back the accepted
      // Task result or its exact Value Closure.
    }
    try {
      ensureOneExperienceReuseReceipt({
        taskId: accepted.id,
        expectedTaskVersion: accepted.version,
        expectedTaskUpdatedAt: accepted.updatedAt,
        expectedRunId: input.expectedRunId,
        valueClosureId: closure.value.closure.valueClosureId,
        expectedValueClosureVersion: closure.value.version,
        confirmedByUser: true,
      });
    } catch {
      // Compounding evidence is optional. Its failure must never roll back the
      // already-authoritative result acceptance or accepted Value Closure.
    }
    try {
      tryProduceOneImprovementProofForTask(accepted.id);
    } catch {
      // Improvement Proof is a derived, evidence-gated record. It must never
      // roll back the accepted result when verified comparison data is absent.
    }
    return accepted;
  });
  ipcMain.handle("tasks:continueFromResult", (_e, input: {
    taskId: string;
    expectedVersion: number;
    userPrompt: string;
  }) => {
    if (
      !input
      || typeof input !== "object"
      || Object.keys(input).length !== 3
      || typeof input.taskId !== "string"
      || !Number.isSafeInteger(input.expectedVersion)
      || typeof input.userPrompt !== "string"
    ) {
      throw new TypeError("Invalid Task result continuation request");
    }
    const projection = oneTaskProjectionRuntime.getProjection(input.taskId, {
      surface: "one",
      mode: "detailed",
    });
    if (!projection || projection.canonicalVersion !== input.expectedVersion) {
      throw new Error("Task changed before the follow-up started; review the current Task state");
    }
    return continueOneFromTaskResult({
      ...input,
      summary: projection.display.summary,
      locale: /[\u3131-\u318e\uac00-\ud7a3]/u.test(input.userPrompt)
        ? "ko"
        : currentUiLocale().toLowerCase().startsWith("ko") ? "ko" : "en",
    });
  });
  ipcMain.handle("oneSearch:search", (_e, input: unknown) => searchOneHistory(input));
  ipcMain.handle("oneSearch:mutateArchive", (_e, input: unknown) => {
    const taskId = input && typeof input === "object" && "taskId" in input
      ? String((input as { taskId?: unknown }).taskId ?? "")
      : "";
    const task = taskId ? getCanonicalTask(taskId) : null;
    if (task?.originChatId && invocationService.activeChatIds().includes(task.originChatId)) {
      throw new Error("A running Task cannot be archived or restored");
    }
    return mutateOneTaskArchive(input);
  });
  ipcMain.handle("oneAttachments:prepare", (_e, input) => prepareOneAttachments(input));
  ipcMain.handle("oneAttachments:bindToTeam", (_e, input) => bindOneAttachmentsToTeam(input));
  ipcMain.handle("oneAttachments:forTeam", (_e, proposalId) => getOneAttachmentsForTeam(String(proposalId ?? "")));
  ipcMain.handle("oneAttachments:discard", (_e, input) => discardOneAttachments(input));
  ipcMain.handle("oneArtifacts:issuePreview", (_e, input: OneArtifactBindingRequestV1) =>
    issueOneArtifactPreviewCapability(input));
  ipcMain.handle("oneArtifacts:revokePreview", (_e, input: OneArtifactPreviewRevokeV1) => ({
    revoked: revokeOneArtifactPreview(input),
  }));
  ipcMain.handle("oneArtifacts:open", async (_e, input: OneArtifactBindingRequestV1) => {
    const artifactPath = resolveOneArtifactOpenPath(input);
    if (!artifactPath) return { opened: false };
    const error = await shell.openPath(artifactPath);
    return { opened: error === "" };
  });
  ipcMain.handle("oneProfile:get", () => getOneProfile());
  ipcMain.handle("oneProfile:update", (_e, input: OneProfileUpdateInput) => updateOneProfile(input));
  ipcMain.handle("oneProfile:addPrinciple", (_e, input: OneOperatingPrincipleCreateInput) =>
    addOneOperatingPrinciple(input));
  ipcMain.handle("oneProfile:updatePrinciple", (_e, input: OneOperatingPrincipleUpdateInput) =>
    updateOneOperatingPrinciple(input));
  ipcMain.handle("oneProfile:setPrincipleEnabled", (_e, input: OneOperatingPrincipleEnabledInput) =>
    setOneOperatingPrincipleEnabled(input));
  ipcMain.handle("oneProfile:deletePrinciple", (_e, input: OneOperatingPrincipleDeleteInput) =>
    deleteOneOperatingPrinciple(input));
  ipcMain.handle("oneFeatureIntro:getState", () => getOneFeatureIntroState());
  ipcMain.handle("oneFeatureIntro:acknowledge", (_e, input: AcknowledgeOneFeatureIntroInput) =>
    acknowledgeOneFeatureIntro(input));
  ipcMain.handle("oneFeatureIntro:defer", (_e, input: DeferOneFeatureIntroInput) =>
    deferOneFeatureIntro(input));
  ipcMain.handle("oneOnboarding:getState", () => getOneOnboardingState());
  ipcMain.handle("oneOnboarding:update", (_e, input: UpdateOneOnboardingInput) =>
    updateOneOnboarding(input));
  ipcMain.handle("oneOnboarding:verifyProvider", (_e, input: VerifyOneOnboardingProviderInput) =>
    verifyOneOnboardingProvider(input));
  ipcMain.handle("oneOnboarding:chooseLimited", (_e, input: LimitOneOnboardingProviderInput) =>
    limitOneOnboardingProvider(input));
  ipcMain.handle("oneOnboarding:dismiss", (_e, input: DismissOneOnboardingInput) =>
    dismissOneOnboarding(input));
  ipcMain.handle("oneOnboarding:resume", (_e, input: ResumeOneOnboardingInput) =>
    resumeOneOnboarding(input));
  ipcMain.handle("oneOnboarding:reset", (_e, input: ResetOneOnboardingInput) =>
    resetOneOnboarding(input));
  ipcMain.handle("oneOnboarding:reopenProvider", (_e, input: ReopenOneOnboardingProviderInput) =>
    reopenOneOnboardingProvider(input));
  ipcMain.handle("oneOnboarding:getExecutionAuthorization", () =>
    getOneOnboardingExecutionAuthorization());
  ipcMain.handle("oneOnboarding:provisionStarterTeam", (_e, input: ProvisionOneOnboardingStarterTeamInput) =>
    provisionOneOnboardingStarterTeam(input));
  ipcMain.handle("oneOnboarding:complete", (_e, input: CompleteOneOnboardingInput) =>
    completeOneOnboarding(input));
  ipcMain.handle("oneActivation:getState", (_e, input) => getOneActivationState(input));
  ipcMain.handle("oneActivation:resolveConcern", (_e, input) => resolveOneActivationConcern(input));
  ipcMain.handle("oneActivation:resolveWork", (_e, input) => resolveOneActivationWork(input));
  ipcMain.handle("oneActivation:skip", (_e, input) => skipOneActivation(input));
  ipcMain.handle("oneActivation:resolveMobile", (_e, input) => resolveOneActivationMobile(input));
  ipcMain.handle("oneMemory:getState", () => getOneMemoryState());
  ipcMain.handle("oneMemory:propose", (_e, input: ProposeOneMemoryCandidateInput) =>
    proposeOneMemoryCandidate(input));
  ipcMain.handle("oneMemory:save", (_e, input: SaveOneMemoryCandidateInput) =>
    saveOneMemoryCandidate(input));
  ipcMain.handle("oneMemory:editAndSave", (_e, input: EditAndSaveOneMemoryCandidateInput) =>
    editAndSaveOneMemoryCandidate(input));
  ipcMain.handle("oneMemory:useOnce", (_e, input: UseOneMemoryCandidateOnceInput) =>
    useOneMemoryCandidateOnce(input));
  ipcMain.handle("oneMemory:reject", (_e, input: RejectOneMemoryCandidateInput) =>
    rejectOneMemoryCandidate(input));
  ipcMain.handle("oneMemory:deleteCandidate", (_e, input: DeleteOneMemoryCandidateInput) =>
    deleteOneMemoryCandidate(input));
  ipcMain.handle("oneMemory:updateAsset", (_e, input: UpdateOneMemoryAssetInput) =>
    updateOneMemoryAsset(input));
  ipcMain.handle("oneMemory:setAssetEnabled", (_e, input: SetOneMemoryAssetEnabledInput) =>
    setOneMemoryAssetEnabled(input));
  ipcMain.handle("oneMemory:deleteAsset", (_e, input: DeleteOneMemoryAssetInput) =>
    deleteOneMemoryAsset(input));
  ipcMain.handle("oneSuggestions:getState", () => getOneSuggestionState());
  ipcMain.handle("oneSuggestions:acceptForReview", (_e, input: AcceptOneSuggestionForReviewInput) =>
    acceptOneSuggestionForReviewFromUser(input));
  ipcMain.handle("oneSuggestions:getReviewHandoff", (_e, input: OneSuggestionReviewHandoffInput) =>
    getOneSuggestionReviewHandoff(input));
  ipcMain.handle("oneSuggestions:getReviewSeed", (_e, input: OneSuggestionReviewHandoffInput) =>
    getOneSuggestionReviewSeed(input));
  ipcMain.handle("oneSuggestions:snooze", (_e, input: SnoozeOneSuggestionInput) =>
    snoozeOneSuggestion(input));
  ipcMain.handle("oneSuggestions:dismiss", (_e, input: DismissOneSuggestionInput) =>
    dismissOneSuggestion(input));
  ipcMain.handle("oneSuggestions:neverAsk", (_e, input: NeverAskOneSuggestionInput) =>
    neverAskOneSuggestion(input));
  ipcMain.handle("oneHubDerivative:getDraft", (_e, input: GetOneHubDerivativeDraftInput) => {
    const handoff = getOneSuggestionReviewHandoff(input);
    if (handoff.type !== "hub_derivative" || handoff.reviewKind !== "hub_derivative_draft") {
      throw new Error("This review handoff is not a Hub public derivative");
    }
    return getOneHubDerivativeDraft(input);
  });
  ipcMain.handle("oneValueClosure:getState", () => getOneValueClosureState());
  ipcMain.handle("oneValueClosure:latestForTask", (_e, taskId: string) =>
    getLatestOneValueClosure(taskId));
  ipcMain.handle("oneValueClosure:setReflection", (_e, input: SetOneValueClosureReflectionInput) =>
    setOneValueClosureReflection(input));
  ipcMain.handle("oneHomeSignals:get", () => getOneHomeSignals());
  ipcMain.handle("oneWeeklyReflection:get", async () => {
    // Async pre-pass: warm completion-claim judgments for the stored closure
    // statements the synchronous reflection builder peeks (miss = regex fallback).
    const statements = getOneValueClosureState().closures
      .flatMap((record) => record.closure.valueItems
        .filter((item): item is Extract<typeof item, { kind: "fact" }> => item.kind === "fact")
        .map((item) => item.statement))
      .slice(0, 24);
    await prejudgeCompletionClaims(statements, { timeoutMs: 4_000 }).catch(() => undefined);
    return getOneWeeklyReflectionSnapshot();
  });
  ipcMain.handle("oneWeeklyReflection:resolve", (_e, input: ResolveOneWeeklyReflectionInputV1) =>
    resolveOneWeeklyReflection(input));
  ipcMain.handle("oneExperienceReuse:getState", () => getOneExperienceReuseState());
  ipcMain.handle("oneExperienceReuse:latestForTask", (_e, taskId: string) =>
    getLatestOneExperienceReuseReceipt(taskId));
  ipcMain.handle("oneImprovementProof:getState", () => {
    reconcileOneImprovementProofs();
    const { evidence: _mainOnlyEvidence, ...readState } = getOneImprovementProofState();
    return readState;
  });
  ipcMain.handle("oneImprovementProof:list", (_e, input: unknown) => {
    reconcileOneImprovementProofs();
    return listOneImprovementProofs(oneImprovementProofListTaskId(input));
  });
  ipcMain.handle("oneImprovementProof:latestForTask", (_e, taskId: unknown) => {
    const exactTaskId = strictOneImprovementProofTaskId(taskId, "Improvement Proof taskId");
    tryProduceOneImprovementProofForTask(exactTaskId);
    const task = getCanonicalTask(exactTaskId);
    const latest = getLatestOneImprovementProof(exactTaskId);
    return task && latest?.currentTaskVersion === task.version ? latest : null;
  });
  ipcMain.handle("oneBriefing:get", () => getOneBriefingSnapshot());
  ipcMain.handle("oneBriefing:openTask", (_e, input: OpenOneBriefingTaskInput) =>
    resolveOneBriefingTaskNavigation(input));
  ipcMain.handle("oneTeamPreflight:prepare", (_e, input: PrepareOneTeamPreflightInput) =>
    prepareOneTeamPreflight(input));
  ipcMain.handle("oneTeamPreflight:getForChat", (_e, chatId: string) =>
    getOneTeamPreflightForChat(chatId));
  ipcMain.handle("oneTeamPreflight:autoResolve", (_e, input: AutoResolveOneTeamPreflightInput) =>
    autoResolveOneTeamPreflight(input));
  ipcMain.handle("oneTeamPreflight:resolve", (_e, input: ResolveOneTeamPreflightInput) =>
    resolveOneTeamPreflight(input));
  ipcMain.handle("oneTeamPreflight:failStart", (_e, ref: OneTeamPreflightRef) =>
    failOneTeamPreflightStart(ref));
  ipcMain.handle("oneBriefing:prepareAction", (_e, input: PrepareOneBriefingActionInput) =>
    prepareOneBriefingActionPacket(input));
  ipcMain.handle("oneBriefing:getAction", (_e, input: PrepareOneBriefingActionInput) =>
    getOneBriefingActionPacketForCandidate(input));
  ipcMain.handle("oneBriefing:startAction", (_e, input: StartOneBriefingActionInput) => {
    try {
      const reservation = reserveOneBriefingActionExecution(input);
      if (reservation.kind === "already_started") {
        return {
          ok: true,
          packet: reservation.packet,
          runId: reservation.packet.run?.runId ?? null,
          errorCategory: null,
        };
      }
      try {
        const started = invocationService.start({
          runId: reservation.ref.reservedRunId,
          chatId: reservation.chatId,
          // InvocationService replaces both this placeholder and every mutable
          // execution field from the Main-only packet capability.
          userPrompt: "Briefing review",
          taskIntent: "task",
          oneMode: true,
          oneBriefingActionRef: reservation.ref,
          locale: currentUiLocale(),
          permissions: "read",
          sessionRouting: false,
          hubMode: "local-only",
          borrowAgents: [],
        });
        const packet = getOneBriefingActionPacket(reservation.packet.packetId);
        if (!packet || packet.status !== "started" || packet.run?.runId !== started.runId) {
          const recovered = failOneBriefingActionStart(reservation.ref, "recovery_required");
          return { ok: false, packet: recovered, runId: null, errorCategory: "recovery_required" };
        }
        return { ok: true, packet, runId: started.runId, errorCategory: null };
      } catch {
        const category = hasInvocationRunReceipt(reservation.ref.reservedRunId)
          ? "recovery_required" as const
          : "start_rejected" as const;
        const packet = failOneBriefingActionStart(reservation.ref, category);
        return { ok: false, packet, runId: null, errorCategory: category };
      }
    } catch (error) {
      if (!(error instanceof OneBriefingActionError)) throw error;
      const packet = getOneBriefingActionPacket(input?.packetId ?? "invalid");
      if (!packet) throw error;
      return { ok: false, packet, runId: null, errorCategory: error.category };
    }
  });
  ipcMain.handle("oneBriefing:setPreferences", (_e, input: {
    cadence?: OneBriefingPreferences["cadence"];
    channels?: OneBriefingChannel[];
    quietHours?: OneBriefingPreferences["quietHours"];
  }) => setOneBriefingPreferences(input ?? {}));
  ipcMain.handle("oneBriefing:feedback", (_e, input: {
    candidateId: string;
    expectedDetectedAt: string;
    feedback: OneBriefingFeedback;
  }) => {
    if (!input || typeof input !== "object") throw new TypeError("Invalid One Briefing feedback request");
    return recordOneBriefingFeedback(input);
  });
  // 사이드바 "고용 중" 로스터 — 리스 캐시 + 기억 둥지(~/.agentlas/networking) 스캔.
  ipcMain.handle("hired:list", () => listHiredAgents());

  // ── automations (SQLite + scheduler) ───────────────────
  // 이벤트 트리거(fs/chain)를 가진 자동화가 바뀌면 트리거 매니저를 재동기화한다(리스너 갱신).
  const resyncTriggers = async (): Promise<void> => {
    try {
      const { syncTriggers } = await import("./triggers/manager");
      syncTriggers();
    } catch {
      /* 매니저 미기동(헤드리스 등)이면 무시 */
    }
  };
  ipcMain.handle("automations:list", () => listAutomations());
  ipcMain.handle(
    "automations:create",
    async (_e, input: AutomationCreateInput) => {
      // The connected model decides the tool mode at creation; warm it before the
      // synchronous store write peeks the verdict (see prejudgeAutomationComputerUse).
      await prejudgeAutomationComputerUse(
        { toolMode: input.toolMode, name: input.name, promptTemplate: input.promptTemplate, targetLabel: input.targetType },
        { timeoutMs: 6_000 },
      );
      const created = createAutomation(input);
      await resyncTriggers();
      return created;
    },
  );
  ipcMain.handle("automations:toggle", async (_e, id: string, enabled: boolean) => {
    const next = toggleAutomation(id, enabled);
    await resyncTriggers();
    return next;
  });
  ipcMain.handle("automations:update", async (_e, id: string, patch: AutomationUpdatePatch) => {
    await prejudgeAutomationComputerUse(
      { toolMode: patch.toolMode, name: patch.name, promptTemplate: patch.promptTemplate, targetLabel: patch.targetType },
      { timeoutMs: 6_000 },
    );
    const next = updateAutomation(id, patch);
    await resyncTriggers();
    return next;
  });
  ipcMain.handle("automations:remove", async (_e, id: string) => {
    const { removeAutomationSafely } = await import("./automation-removal");
    removeAutomationSafely(id);
    await resyncTriggers();
  });
  ipcMain.handle("automations:get", (_e, id: string) => getAutomation(id));
  ipcMain.handle("automations:listRuns", (_e, id: string, limit?: number) => listRunHistory(id, limit ?? 50));
  ipcMain.handle("automations:listTriggerAttention", (_e, automationId: string) =>
    listTriggerEventAttention(automationId),
  );
  ipcMain.handle(
    "automations:reconcileTriggerEvent",
    (_e, input: AutomationTriggerEventReconcileInput) => reconcileParkedTriggerEvent(input),
  );
  ipcMain.handle("automations:getGraphReconciliation", (_e, automationId: string) =>
    getAutomationGraphReconciliation(automationId),
  );
  ipcMain.handle(
    "automations:reconcileGraph",
    async (_e, input: AutomationGraphReconcileInput) => {
      const result = reconcileAutomationGraph(input);
      if (result.resumeRequired && result.eventStatus === "pending") {
        const { wakeTriggerOutbox } = await import("./triggers/outbox");
        wakeTriggerOutbox();
      } else if (result.resumeRequired && result.eventStatus === null) {
        const { runAutomationNow } = await import("./automation-scheduler");
        void runAutomationNow(result.automationId).catch((error) => {
          console.error(`[automation] reconciled graph resume failed (${result.automationId}):`, error);
        });
      }
      return result;
    },
  );
  ipcMain.handle("automations:updateGraph", (_e, id: string, graph: WorkflowGraph | null) =>
    updateAutomationGraph(id, graph),
  );
  ipcMain.handle("automations:runNow", async (_e, id: string) => {
    const automation = getAutomation(id);
    if (!automation) throw new Error(`Automation not found: ${id}`);
    const { runAutomationNow } = await import("./automation-scheduler");
    void runAutomationNow(id).catch((err) => {
      console.error(`[automation] run-now failed (${id}):`, err);
    });
  });
  ipcMain.handle("automations:latestRun", (_e, id: string) => getLatestGraphRun(id));
  ipcMain.handle("automations:getSession", (_e, id: string) => {
    const automation = getAutomation(id);
    if (!automation) throw new Error(`Automation not found: ${id}`);
    return getOrCreateAutomationSession({
      automationId: automation.id,
      ...(automation.targetType === "firm"
        ? { firmId: automation.targetId }
        : automation.targetType === "agent"
          ? { agentId: automation.targetId }
          : {}),
    });
  });

  // ── schedule 문법 헬퍼(렌더러 스케줄 빌더용 — croner는 메인에서만) ──
  ipcMain.handle("schedule:validateCron", async (_e, expr: string) => {
    const { validateCron } = await import("./store/schedule");
    return validateCron(expr);
  });
  ipcMain.handle("schedule:describe", async (_e, spec: ScheduleSpec, loc?: "ko" | "en") => {
    const { describeSchedule } = await import("./store/schedule");
    try {
      return describeSchedule(spec, loc ?? "en");
    } catch {
      return "";
    }
  });
  ipcMain.handle("schedule:nextRun", async (_e, spec: ScheduleSpec) => {
    const { nextRun } = await import("./store/schedule");
    try {
      return nextRun(spec);
    } catch {
      return null;
    }
  });
  ipcMain.handle("schedule:defaultTz", async () => {
    const { defaultTz } = await import("./store/schedule");
    return defaultTz();
  });

  // ── launchd LaunchAgent (opt-in 앱 꺼져도 실행, macOS) ───
  ipcMain.handle("launchd:status", async () => {
    const { launchdStatus } = await import("./launchd/agent");
    return launchdStatus();
  });
  ipcMain.handle("launchd:enable", async () => {
    const { enableLaunchd } = await import("./launchd/agent");
    return enableLaunchd();
  });
  ipcMain.handle("launchd:disable", async () => {
    const { disableLaunchd } = await import("./launchd/agent");
    return disableLaunchd();
  });

  // ── Surfaces (agent-made Workbench outputs) ─────────────
  ipcMain.handle("surfaces:list", (_e, chatId?: string) => listAgentSurfaces(chatId));
  ipcMain.handle("surfaces:get", (_e, id: string) => getAgentSurface(id));
  ipcMain.handle("surfaces:listJobs", (_e, surfaceId: string) => listSurfaceJobs(surfaceId));
  ipcMain.handle("surfaces:getJobSummary", (_e, surfaceId: string) => {
    const surface = getAgentSurface(surfaceId);
    if (!surface) return null;
    return getSurfaceJobSummary(surfaceId, surface.manifest.budget);
  });
  ipcMain.handle("surfaces:updateJob", (_e, input: SurfaceJobUpdateRequest) =>
    updateSurfaceJob(input),
  );
  ipcMain.handle("surfaces:updateState", (_e, input: SurfaceStatePatchRequest) =>
    patchAgentSurfaceState(input),
  );
  ipcMain.handle("surfaces:listEvents", (_e, surfaceId: string) =>
    listAgentSurfaceEvents(surfaceId),
  );
  ipcMain.handle("surfaces:approve", (_e, input: SurfaceApprovalGrantRequest) =>
    approveAgentSurface(input),
  );
  ipcMain.handle("surfaces:hasApproval", (_e, input: SurfaceApprovalCheckRequest) =>
    hasAgentSurfaceApproval(input),
  );
  ipcMain.handle("surfaces:listApprovals", (_e, surfaceId: string) =>
    listAgentSurfaceApprovals(surfaceId),
  );
  ipcMain.handle("surfaces:revokeApproval", (_e, id: string) => revokeAgentSurfaceApproval(id));

  // ── Surface Assets (reusable packs from declarative manifests) ─
  ipcMain.handle("surfaceAssets:materialize", async (_e, input: SurfaceAssetPackRequest) => {
    const chat = getChat(input.chatId);
    if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
    const project = chat.projectId ? getProject(chat.projectId) : null;
    const baseDir =
      getChatWorkingFolder(chat.id) ??
      project?.folderPath ??
      path.join(app.getPath("userData"), "generated-assets");
    const result = await materializeSurfaceAssetPack(input, { baseDir, downloadRemoteAssets: true });
    const record = recordMaterializedSurfaceAssetPack({
      chatId: chat.id,
      projectId: chat.projectId,
      agentId: chat.agentId,
      surfaceId: input.surfaceId,
      actionId: input.actionId,
      manifest: input.manifest,
      snapshot: result,
    });
    return { ...result, record };
  });
  ipcMain.handle("surfaceAssets:archive", async (_e, input: SurfaceAssetPackRootRequest) => {
    const pack = getSurfaceAssetPackByRoot(path.resolve(input.rootPath));
    if (!pack) throw new Error(`Surface asset pack not found: ${input.rootPath}`);
    const result = await archiveSurfaceAssetPack(input);
    return recordSurfaceAssetPackOperation(pack.id, "archive", true, result, "archived");
  });
  ipcMain.handle("surfaceAssets:restore", async (_e, input: SurfaceAssetPackRootRequest) => {
    const pack = getSurfaceAssetPackByRoot(path.resolve(input.rootPath));
    if (!pack) throw new Error(`Surface asset pack not found: ${input.rootPath}`);
    const result = await restoreSurfaceAssetPack(input);
    return recordSurfaceAssetPackOperation(pack.id, "restore", true, result, "restored");
  });
  ipcMain.handle("surfaceAssets:listPacks", (_e, chatId?: string) => listSurfaceAssetPacks(chatId));
  ipcMain.handle("surfaceAssets:getPack", (_e, id: string) => getSurfaceAssetPack(id));
  ipcMain.handle("surfaceAssets:getPackBySurface", (_e, chatId: string, surfaceId: string) =>
    getSurfaceAssetPackBySurface(chatId, surfaceId),
  );
  ipcMain.handle("surfaceAssets:listOperations", (_e, packId: string) =>
    listSurfaceAssetPackOperations(packId),
  );

  // ── App Factory (agent-made service apps) ───────────────
  ipcMain.handle("appFactory:scaffold", async (_e, input: AppFactoryScaffoldRequest) => {
    const chat = getChat(input.chatId);
    if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
    const project = chat.projectId ? getProject(chat.projectId) : null;
    const baseDir =
      getChatWorkingFolder(chat.id) ??
      project?.folderPath ??
      path.join(app.getPath("userData"), "generated-apps");
    const result = await scaffoldServiceApp(input, { baseDir });
    const record = recordScaffoldedApp({
      chatId: chat.id,
      projectId: chat.projectId,
      agentId: chat.agentId,
      surfaceId: input.surfaceId,
      actionId: input.actionId,
      manifest: input.manifest,
      scaffold: result,
    });
    return { ...result, record };
  });
  ipcMain.handle("appFactory:syncCloudManifest", async (_e, input: AppFactoryCloudAppManifestRequest) => {
    const existingCloudApp = input.chatId
      ? null
      : getAgentAppByRoot(cloudAppRootPath(input.slug || input.cloudId));
    const chat = input.chatId
      ? getChat(input.chatId)
      : existingCloudApp
        ? getChat(existingCloudApp.chatId)
      : createChat({
          agentId: input.agentId,
          projectId: input.projectId ?? null,
          title: "Cloud Apps",
          kind: "division",
        });
    if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
    return recordCloudAppManifest({
      ...input,
      chatId: chat.id,
      projectId: input.projectId ?? chat.projectId,
      agentId: input.agentId ?? chat.agentId,
    });
  });
  ipcMain.handle("appFactory:runAutopilot", async (_e, input: AppFactoryAutopilotRequest) => {
    const result = await runAppFactoryAutopilot(input);
    recordAppFactoryOperation(
      result.rootPath,
      "run-autopilot",
      result.status === "operated",
      result,
      result.status === "operated" ? "tool-published" : result.smoke?.ok === false ? "smoke-failed" : "operations-ready",
    );
    return result;
  });
  ipcMain.handle("appFactory:installMcpPlan", async (_e, input: AppFactoryRootRequest) => {
    const result = await installMcpPlan(input);
    recordAppFactoryOperation(result.rootPath, "install-mcp", true, result, "mcp-ready");
    return result;
  });
  ipcMain.handle("appFactory:runProviderTasks", async (_e, input: AppFactoryRootRequest) => {
    const result = await runProviderTasks(input);
    recordAppFactoryOperation(result.rootPath, "run-provider-tasks", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:materializeAssets", async (_e, input: AppFactoryAssetMaterializeRequest) => {
    const result = await materializeCatalogAssets(input);
    recordAppFactoryOperation(result.rootPath, "materialize-assets", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:activateLocalCommerceStack", async (_e, input: AppFactoryLocalCommerceActivationRequest) => {
    const result = await activateLocalCommerceStack(input);
    recordAppFactoryOperation(result.rootPath, "activate-local-commerce-stack", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:openProviderBrowser", async (_e, input: AppFactoryRootRequest) => {
    const result = await prepareProviderBrowserOpen(input);
    // Validate the complete batch before opening the first URL so a later
    // javascript:/file:/custom-scheme value cannot cause a partial launch.
    const safeUrls = result.opened.map((plan) => validateExternalHttpUrl(plan.startUrl));
    for (const url of safeUrls) {
      await shell.openExternal(url);
    }
    recordAppFactoryOperation(result.rootPath, "open-provider-browser", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:captureProviderBrowserSessions", async (_e, input: AppFactoryProviderBrowserSessionRequest) => {
    const result = await captureProviderBrowserSessions(input);
    recordAppFactoryOperation(result.rootPath, "capture-provider-browser-sessions", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:launchProviderBrowserSession", async (_e, input: AppFactoryProviderBrowserLaunchRequest) => {
    const result = await launchProviderBrowserSession(input);
    recordAppFactoryOperation(result.rootPath, "launch-provider-session", result.ok, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:syncProviderBrowserResults", async (_e, input: AppFactoryProviderBrowserResultSyncRequest) => {
    const result = await syncProviderBrowserResults(input);
    recordAppFactoryOperation(result.rootPath, "sync-provider-browser-results", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:resolveProviderCredentials", async (_e, input: AppFactoryProviderCredentialResolveRequest) => {
    const result = await resolveProviderCredentials(input);
    recordAppFactoryOperation(result.rootPath, "resolve-provider-credentials", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:approveProviderPayment", async (_e, input: AppFactoryProviderPaymentApproveRequest) => {
    const result = await approveProviderPayment(input);
    recordAppFactoryOperation(result.rootPath, "approve-provider-payment", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:runSmoke", async (_e, input: AppFactoryRootRequest) => {
    const result = await runAppFactorySmoke(input);
    recordAppFactoryOperation(
      result.rootPath,
      "run-smoke-test",
      result.ok,
      result,
      result.ok ? "smoke-passed" : "smoke-failed",
    );
    return result;
  });
  ipcMain.handle("appFactory:preparePreview", async (_e, input: AppFactoryRootRequest) => {
    const result = await preparePreviewDeploy(input);
    recordAppFactoryOperation(result.rootPath, "deploy-preview", true, result, "preview-ready");
    return result;
  });
  ipcMain.handle("appFactory:openLaunchTarget", async (_e, input: AppFactoryRootRequest) => {
    const rootPath = isCloudAppRoot(input.rootPath) ? input.rootPath : path.resolve(input.rootPath);
    const appRecord = getAgentAppByRoot(rootPath);
    if (!appRecord) throw new Error(`Generated app not found: ${input.rootPath}`);
    const result = await openAppLaunchTarget(appRecord);
    recordAgentAppOperation(appRecord.id, "open-launch-target", result.opened, result);
    return result;
  });
  ipcMain.handle("appFactory:publishAsTool", async (_e, input: AppFactoryRootRequest) => {
    const result = await publishAppAsTool(input);
    recordAppFactoryOperation(result.rootPath, "publish-as-tool", true, result, "tool-published");
    return result;
  });
  ipcMain.handle("appFactory:archive", async (_e, input: AppFactoryRootRequest) => {
    const rootPath = isCloudAppRoot(input.rootPath) ? input.rootPath : path.resolve(input.rootPath);
    const appRecord = getAgentAppByRoot(rootPath);
    if (!appRecord) throw new Error(`Generated app not found: ${input.rootPath}`);
    if (isCloudAppRoot(rootPath)) {
      return recordAgentAppOperation(
        appRecord.id,
        "archive",
        true,
        {
          rootPath,
          archived: true,
          reversible: true,
          storage: "cloud-manifest",
          summary: "Cloud App hidden from local Apps list; manifest can be synced again from Agentlas Cloud.",
        },
        "archived",
      );
    }
    const result = await archiveAppPackage(input);
    return recordAgentAppOperation(appRecord.id, "archive", true, result, "archived");
  });
  ipcMain.handle("appFactory:restore", async (_e, input: AppFactoryRootRequest) => {
    const rootPath = isCloudAppRoot(input.rootPath) ? input.rootPath : path.resolve(input.rootPath);
    const appRecord = getAgentAppByRoot(rootPath);
    if (!appRecord) throw new Error(`Generated app not found: ${input.rootPath}`);
    if (isCloudAppRoot(rootPath)) {
      return recordAgentAppOperation(
        appRecord.id,
        "restore",
        true,
        {
          rootPath,
          restored: true,
          storage: "cloud-manifest",
          summary: "Cloud App restored locally from the cached manifest registry.",
        },
        "restored",
      );
    }
    const result = await restoreAppPackage(input);
    return recordAgentAppOperation(appRecord.id, "restore", true, result, "restored");
  });
  ipcMain.handle("appFactory:listApps", (_e, chatId?: string) => listAgentApps(chatId));
  ipcMain.handle("appFactory:getApp", (_e, id: string) => getAgentApp(id));
  ipcMain.handle("appFactory:getAppBySurface", (_e, chatId: string, surfaceId: string) =>
    getAgentAppBySurface(chatId, surfaceId),
  );
  ipcMain.handle("appFactory:listOperations", (_e, appId: string) =>
    listAgentAppOperations(appId),
  );

  // ── Meta Agent Factory (local team materialization) ─────
  ipcMain.handle("metaAgent:createCommerceTeam", (_e, input: MetaAgentTeamFactoryRequest) =>
    createCommerceAgentTeam(input),
  );

  // ── Tool Factory (agent-made local tools) ───────────────
  ipcMain.handle("toolFactory:scaffold", async (_e, input: ToolFactoryScaffoldRequest) => {
    const chat = getChat(input.chatId);
    if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
    const project = chat.projectId ? getProject(chat.projectId) : null;
    const baseDir =
      getChatWorkingFolder(chat.id) ??
      project?.folderPath ??
      path.join(app.getPath("userData"), "generated-tools");
    const result = await scaffoldAgentTool(input, { baseDir });
    const record = recordScaffoldedTool({
      chatId: chat.id,
      projectId: chat.projectId,
      agentId: chat.agentId,
      surfaceId: input.surfaceId,
      actionId: input.actionId,
      scaffold: result,
    });
    return { ...result, record };
  });
  ipcMain.handle("toolFactory:runSmoke", async (_e, input: ToolFactoryRootRequest) => {
    const result = await runToolFactorySmoke(input);
    recordToolFactoryOperation(
      result.rootPath,
      "run-smoke-test",
      result.ok,
      result,
      result.ok ? "smoke-passed" : "smoke-failed",
    );
    // 자동등록(REQ2): smoke가 통과하면 생성된 툴의 MCP 어댑터를 즉시 등록한다 → 에이전트가
    // 다음 턴부터 사용자 추가 클릭 없이 바로 호출 가능(buildMcpConfigFile이 .mcp.json으로 직렬화).
    // installToolMcp는 멱등(이미 설치돼 있으면 재사용)이라 중복 호출도 안전.
    if (result.ok) {
      try {
        const installed = await installToolMcp({ rootPath: result.rootPath });
        recordToolFactoryOperation(
          result.rootPath,
          "install-mcp",
          true,
          installed,
          "mcp-installed",
          installed.server.id,
        );
      } catch (err) {
        console.error("[tool-factory] auto-install after smoke failed:", err);
      }
    }
    return result;
  });
  ipcMain.handle("toolFactory:installMcp", async (_e, input: ToolFactoryRootRequest) => {
    const result = await installToolMcp(input);
    recordToolFactoryOperation(
      result.rootPath,
      "install-mcp",
      true,
      result,
      "mcp-installed",
      result.server.id,
    );
    return result;
  });
  ipcMain.handle("toolFactory:archive", async (_e, input: ToolFactoryRootRequest) => {
    const toolRecord = getAgentToolByRoot(path.resolve(input.rootPath));
    if (!toolRecord) throw new Error(`Generated tool not found: ${input.rootPath}`);
    const result = await archiveToolPackage(input);
    return recordAgentToolOperation(toolRecord.id, "archive", true, result, "archived", null);
  });
  ipcMain.handle("toolFactory:restore", async (_e, input: ToolFactoryRootRequest) => {
    const toolRecord = getAgentToolByRoot(path.resolve(input.rootPath));
    if (!toolRecord) throw new Error(`Generated tool not found: ${input.rootPath}`);
    const result = await restoreToolPackage(input);
    return recordAgentToolOperation(
      toolRecord.id,
      "restore",
      true,
      result,
      "restored",
      result.restoredServerId,
    );
  });
  ipcMain.handle("toolFactory:listTools", (_e, chatId?: string) => listAgentTools(chatId));
  ipcMain.handle("toolFactory:getTool", (_e, id: string) => getAgentTool(id));
  ipcMain.handle(
    "toolFactory:getToolBySurface",
    (_e, chatId: string, surfaceId: string, requestedToolId?: string) =>
      getAgentToolBySurface(chatId, surfaceId, requestedToolId),
  );
  ipcMain.handle("toolFactory:listOperations", (_e, toolRecordId: string) =>
    listAgentToolOperations(toolRecordId),
  );

  // ── migration (OpenClaw / Hermes → Agentlas) ────────────
  ipcMain.handle("migration:scan", () => scanMigrationSources());
  ipcMain.handle("migration:import", (_e, opts: MigrationOptions) => runMigration(opts));

  // ── invoke (renderer + Mobile Bridge가 공유하는 main-process 권위) ──────
  // DESKTOP_MOBILE_BRIDGE: 실행 상태·스트림·steering 큐는 invocationService만 소유한다.
  invocationService.onEvent(({ runId, event }) => {
    const channel = `invoke:event:${runId}`;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        try { window.webContents.send(channel, event); } catch {}
      }
    }
  });
  invocationService.onActiveChats((chatIds) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        try { window.webContents.send("invoke:activeChats", chatIds); } catch {}
      }
    }
  });
  ipcMain.handle("invoke:run", async (_event, req: McpInvocationRequest) => {
    const request = rendererInvocationRequest(req);
    // Warm the resident judgments the synchronous start path peeks (request
    // intent, explicit memory intent). Best-effort with a tight budget: a miss
    // keeps the labeled deterministic fallback instead of delaying the run.
    await Promise.all([
      prejudgeOneRequestIntent(request, { timeoutMs: 4_000 }),
      prejudgeOneMemoryIntent(request, { timeoutMs: 4_000 }),
    ]).catch(() => undefined);
    return invocationService.start(request);
  });
  ipcMain.handle("invoke:steer", (_event, req: McpInvocationRequest) => invocationService.steer(rendererInvocationRequest(req)));
  ipcMain.handle("invoke:cancel", (_event, runId: string) => invocationService.cancel(runId));
  ipcMain.handle("invoke:activeChats", () => invocationService.activeChatIds());
  ipcMain.handle("invoke:attach", (_event, chatId: string) => invocationService.attach(chatId));
  ipcMain.handle("invoke:receipt", (_event, runId: string) => invocationService.receipt(runId));
  ipcMain.handle("invoke:latestReceipt", (_event, chatId: string) => invocationService.latestReceipt(chatId));
  ipcMain.handle("invoke:latestOneSurface", (_event, input: unknown) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof (input as { runId?: unknown }).runId !== "string" ||
      typeof (input as { chatId?: unknown }).chatId !== "string" ||
      typeof (input as { taskId?: unknown }).taskId !== "string"
    ) {
      throw new TypeError("Invalid OneSurface restore request");
    }
    return invocationService.latestOneSurface(input as { runId: string; chatId: string; taskId: string });
  });
  ipcMain.handle("invoke:history", (_event, chatId: string) => invocationService.history(chatId));
  ipcMain.handle("invoke:clearHistory", (_e, chatId: string) => {
    // Renderer busy는 projection일 뿐 권위가 아니다. attach가 끝나기 전의 창에서도
    // main registry가 run/cancelling을 보유하면 clear를 거부해 terminal event가
    // 빈 대화에 다시 쓰이는 race를 막는다.
    if (invocationService.activeChatIds().includes(chatId)) {
      throw new Error("This conversation is still running. Stop it and wait for cancellation to finish before clearing it.");
    }
    clearChatContext(chatId);
  });

  // ── Hephaestus 엔진 브리지 ──────────────────────────────────────────────
  // 임베딩된 오픈소스 엔진(Hephaestus)을 범용 CLI/JSON 으로 호출한다. 엔진 측에는 데스크탑
  // 흔적이 없고, 모든 연결 코드는 electron/hephaestus/* + 아래 핸들러에만 존재한다.
  ipcMain.handle("hephaestus:status", (_e, locale?: "ko" | "en") => hephaestusAvailable(locale));
  ipcMain.handle("hephaestus:doctor", () => hephaestusDoctor());
  ipcMain.handle(
    "hephaestus:stormbreaker",
    (_e, input: { query: string; project?: string; background?: boolean; researchEvidence?: boolean }) =>
      stormbreakerRun(input.query, {
        project: input.project,
        background: input.background,
        researchEvidence: input.researchEvidence,
      }),
  );
  ipcMain.handle("hephaestus:getSupervisor", () => ({ enabled: isSupervisorEnabled() }));
  ipcMain.handle("hephaestus:setSupervisor", (_e, enabled: boolean) => setSupervisorEnabled(enabled));
  // 엔진 자동 개입 토글 — 신규 설치 기본값은 Stormbreaker OFF / hep-network Workforce ON.
  ipcMain.handle("hephaestus:getEngineToggles", () => getEngineToggles());
  ipcMain.handle("hephaestus:setEngineToggle", (_e, input: { id: "stormbreaker" | "network"; enabled: boolean }) =>
    setEngineToggle(input.id, input.enabled),
  );
  ipcMain.handle(
    "hephaestus:journal",
    (_e, input: { action: "status" | "verify" | "repair" | "gate"; runId?: string; project?: string }) =>
      stormbreakerJournal(input.action, { runId: input.runId, project: input.project }),
  );
  ipcMain.handle("hephaestus:search", (_e, input: { query: string; limit?: number }) =>
    hepSearch(input.query, { limit: input.limit }),
  );
  ipcMain.handle("hephaestus:network", (_e, input: { query: string; autoRun?: boolean; noOpen?: boolean }) =>
    hepNetwork(input.query, { autoRun: input.autoRun, noOpen: input.noOpen }),
  );
  // 추천 미리보기 — routeOnly(실행 없음)을 정규화해 추천 바텀시트에 넘긴다. 인터랙티브해야 하므로
  // 기본 120s 대신 짧은 timeout. 실패/비가용 시에도 절대 throw 하지 않고 mode:"none" 으로 강등한다.
  ipcMain.handle(
    "hephaestus:routePreview",
    async (
      _e,
      input: { query: string; project?: string; scope?: "network" | "cloud"; allowLocal?: boolean; offline?: boolean; sessionRosterFirst?: boolean },
    ) => {
      // 세션 팀 자동 보강은 매 턴 전역 카탈로그를 검색하지 않는다. none은 실패가
      // 아니라 "현재 roster를 먼저 실행하고 LLM이 실제 gap에서만 보강"하라는 계약이다.
      if (input.sessionRosterFirst) return normalizeRecommendation(null, input.query);
      try {
        const res = await routeOnly(input.query, {
          project: input.project,
          scope: input.scope,
          allowLocal: input.allowLocal ?? true,
          noHub: input.offline, // 오프라인-안전: 로컬 라우팅만
          timeoutMs: 30_000,
        });
        return normalizeRecommendation(res.json, input.query);
      } catch {
        return normalizeRecommendation(null, input.query);
      }
    },
  );
  ipcMain.handle("hephaestus:localGui", (_e, input: { shortcut: string; detach?: boolean; noOpen?: boolean }) =>
    localGui(input.shortcut, { detach: input.detach, noOpen: input.noOpen }),
  );
  ipcMain.handle(
    "hephaestus:publish",
    async (
      event,
      input: { folder: string; scope: FsReadScope; visibility: "private-link" | "marketplace"; dryRun?: boolean; locale?: "ko" | "en" },
    ) => {
      const locale = input.locale ?? "en";
      let folder: string;
      try {
        folder = resolveFsReadPath(input.folder, input.scope);
      } catch (e) {
        return { ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as PathGuardError).message };
      }
      // off-device 업로드 — 사용자 확인 강제(dry-run 은 업로드 없음이므로 제외).
      if (!input.dryRun) {
        const win = BrowserWindow.fromWebContents(event.sender);
        const ok = await confirmUpload(folder, input.visibility, win, locale);
        if (!ok) {
          return {
            ok: false,
            exitCode: null,
            json: null,
            stdout: "",
            stderr: "",
            error: locale === "ko" ? "사용자가 업로드를 취소했습니다." : "Upload cancelled by user.",
          };
        }
        // Auto-fix before publish: the strongest connected model reviews the
        // package and remediates it into a throwaway clean copy (excludes build
        // artifacts and secret files, translates missing bilingual metadata), so
        // an ordinary agent folder publishes without hand-editing. A deterministic
        // backstop still strips secrets/symlinks regardless of the model. The
        // user's original folder is never mutated.
        const runtimes = await detectRuntimes().catch(() => [] as Awaited<ReturnType<typeof detectRuntimes>>);
        const active = runtimes.find((runtime) => runtime.active) ?? runtimes[0] ?? null;
        const autofix = await autofixForPublish({ folder, locale, active });
        if (!autofix.ready || !autofix.packageFolder) {
          autofix.cleanup();
          const blockerText = autofix.remainingBlockers.map((finding) => finding.message).join("\n");
          return {
            ok: false,
            exitCode: null,
            json: null,
            stdout: blockerText,
            stderr: "",
            error:
              (locale === "ko"
                ? `자동 수정 후에도 남은 차단 항목이 있어요${autofix.model ? ` (검토 모델: ${autofix.model})` : ""}: `
                : `Blockers remain after auto-fix${autofix.model ? ` (reviewed by ${autofix.model})` : ""}: `) +
              (blockerText || (locale === "ko" ? "알 수 없음" : "unknown")),
          };
        }
        try {
          return await hepPublish(autofix.packageFolder, input.visibility, { dryRun: input.dryRun });
        } finally {
          autofix.cleanup();
        }
      }
      return hepPublish(folder, input.visibility, { dryRun: input.dryRun });
    },
  );
  ipcMain.handle(
    "hephaestus:package",
    async (event, input: { folder: string; scope: FsReadScope; visibility?: "private-link" | "marketplace"; locale?: "ko" | "en" }) => {
      const locale = input.locale ?? "en";
      let folder: string;
      try {
        folder = resolveFsReadPath(input.folder, input.scope);
      } catch (e) {
        return { ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as PathGuardError).message };
      }
      // package 는 폴더 텍스트 내용을 읽어 번들을 만들므로(off-device 후속 가능) 확인을 받는다.
      const win = BrowserWindow.fromWebContents(event.sender);
      const ok = await confirmUpload(folder, input.visibility ?? "marketplace", win, locale);
      if (!ok) {
        return {
          ok: false,
          exitCode: null,
          json: null,
          stdout: "",
          stderr: "",
          error: locale === "ko" ? "사용자가 패키징을 취소했습니다." : "Packaging cancelled by user.",
        };
      }
      return hepPackage(folder, { visibility: input.visibility });
    },
  );
  ipcMain.handle("hephaestus:securityScan", (_e, input: { folder: string; scope: FsReadScope; strict?: boolean; locale?: "ko" | "en" }) => {
    let folder: string;
    try {
      folder = resolveFsReadPath(input.folder, input.scope);
    } catch (e) {
      return { ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as PathGuardError).message };
    }
    return securityScan(folder, { strict: input.strict });
  });
  ipcMain.handle("hephaestus:aoGraph", (_e, input?: { agent?: string; dir?: string; locale?: "ko" | "en" }) => {
    const inp = input ?? {};
    let dir: string | undefined;
    if (inp.dir != null && String(inp.dir).trim()) {
      try {
        dir = resolveFolderArg(inp.dir, inp.locale ?? "en");
      } catch (e) {
        return { ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as PathGuardError).message };
      }
    }
    return aoGraph({ agent: inp.agent, dir });
  });

  // 빌더(hep-build) — 활성 런타임으로 Hephaestus 빌더 에이전트를 구동, 이벤트 스트리밍.
  // Resolves which model an unpinned Build would actually run on, without
  // starting it, so the renderer can confirm an escalation off the user's own
  // choice before any billable work happens.
  ipcMain.handle("hephaestus:previewAllocation", async (_event, req: HephaestusBuildRequest) => {
    // A preview must have NO side effects. previewBuildAllocation never reads
    // mcpAttachment, so applying the MCP consent here only installed/probed
    // servers and froze plan.application before the user had even decided the
    // runtime — which then made the real build fail its own plan check.
    const resolvedRequest = resolveHephaestusBuildRequest(req);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      return await previewBuildAllocation(
        resolvedRequest,
        req.locale ?? currentUiLocale(),
        controller.signal,
      );
    } catch {
      // A preview must never block a build; the build path re-resolves anyway.
      return null;
    } finally {
      clearTimeout(timer);
    }
  });

  ipcMain.handle("hephaestus:build", async (event, req: HephaestusBuildRequest) => {
    // Renderer가 보낸 절대경로는 권한이 아니다. Native picker / trusted drop이
    // 발급한 capability를 main에서 다시 검증하고 그 경로만 builder에 전달한다.
    const resolvedRequest = await resolveHephaestusBuildRequestForRun(req);
    const runId = randomUUID();
    const channel = `hephaestus:build:${runId}`;
    const win = BrowserWindow.fromWebContents(event.sender);
    const controller = new AbortController();
    activeBuilds.set(runId, controller);
    // 렌더러는 build() 응답을 await 한 뒤에야 채널을 구독하므로, 그 사이에 발생한 첫 이벤트
    // (예: 'build' stage 틱)가 유실될 수 있다. 렌더러가 buildReady 로 구독 완료를 알릴 때까지
    // 이벤트를 버퍼링했다가 한 번에 flush 한다(첫 stage 틱 손실 방지).
    const pending: HephaestusBuildEvent[] = [];
    let ready = false;
    let readyExpiry: NodeJS.Timeout | null = null;
    // 창이 닫힌 뒤 send는 throw하므로 destroyed 가드(빌드 종료와 닫기가 겹치는 경우).
    const sendToWin = (ev: HephaestusBuildEvent) => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send(channel, ev); } catch {}
      }
    };
    const emit = (ev: HephaestusBuildEvent) => {
      if (ready) {
        sendToWin(ev);
      } else {
        pending.push(ev);
      }
    };
    buildReadySignals.set(runId, () => {
      if (ready) return;
      ready = true;
      if (readyExpiry) clearTimeout(readyExpiry);
      for (const ev of pending) sendToWin(ev);
      pending.length = 0;
      buildReadySignals.delete(runId);
    });
    void runHephaestusBuild(runId, resolvedRequest, emit, controller.signal, pickLocale(req)).finally(() => {
      activeBuilds.delete(runId);
      // If buildReady already fired, its callback removed the signal. Otherwise
      // retain the buffered terminal event long enough for invoke() to resolve,
      // the renderer to subscribe, and buildReady() to flush it.
      if (!ready) {
        readyExpiry = setTimeout(() => {
          buildReadySignals.delete(runId);
          pending.length = 0;
        }, BUILD_READY_GRACE_MS);
        readyExpiry.unref?.();
      }
    });
    return { runId, mcpReceipt: resolvedRequest.mcpAttachment!.receipt };
  });
  ipcMain.handle("hephaestus:buildReady", (_e, runId: string) => {
    buildReadySignals.get(runId)?.();
  });
  ipcMain.handle("hephaestus:cancelBuild", (_e, runId: string) => {
    activeBuilds.get(runId)?.abort();
    activeBuilds.delete(runId);
  });

  // Startup Founder Studio — 패키지 자체 런처를 spawn 해 실제 SPA 를 로컬 서빙, iframe URL 반환.
  ipcMain.handle("hephaestus:startStudio", (_event, input?: { idea?: string }) => startStudio(input));
  ipcMain.handle("hephaestus:stopStudio", () => {
    stopStudio();
  });
}
