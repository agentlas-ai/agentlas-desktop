// IPC 핸들러 일괄 등록. main.ts 앱 ready 직후 호출.
// 각 도메인 모듈(runtime, secrets, team, marketplace, projects, chats, automations, invoke)을 thin wrapping.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { copyImageSource, saveImageSource } from "./media/image-actions";
import { checkComputerUsePermissions } from "./mac-permissions";
import type { IpcMainInvokeEvent } from "electron";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
import {
  clearDetectCache,
  detectRuntimes,
  resolveRolePoolPicks,
  setActiveRuntime,
} from "./runtime/detect";
import { disposeAcpSessionPool } from "./runtime/acp";
import { disposeClaudeSessionPool } from "./runtime/claude-session";
import { disposeCodexSessionPool } from "./runtime/codex-session";
import {
  listModelRoleMembers,
  pickModelRoleFromPool,
  setModelRoleMembers as setModelRoleMembersStore,
} from "./store/model-roles";
import type { RuntimeRole, RuntimeRolePoolState } from "../shared/types";
import { requiredExecutionPermission } from "../shared/graph-node-protocol";
import { runtimeVersionsWithAutoUpdate } from "./runtime/auto-update";
import { agentRunCwd } from "./runtime/exec";
import { setAcpProfileReader } from "./runtime/acp-agents";
import { sanitizeTerminalProfiles } from "../shared/terminal-profiles";
import { tryAcquireRuntimeMaintenance } from "./runtime/run-slots";
import { clearModelCache, listRuntimeModels } from "./runtime/providers";
import { installCli, openCliLogin, updateCli, type InstallableCli, type ManageableCli } from "./runtime/install-cli";
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
  videoKeyStatus,
  cancelVideoJob,
  getVideoJob,
  openVideoOutput,
  startVideoJob,
} from "./multimodal/video";
import { runMigration, scanMigrationSources } from "./migrate";
import {
  deleteApiKey,
  deleteEnvVar,
  hasApiKey,
  hasEnvVar,
  listEnvKeys,
  listCredentialRecoveryFailures,
  retryCredentialRecoveryFromUser,
  previewEnvVar,
  saveApiKey,
  setEnvVar,
} from "./secrets/vault";
import { collectEnvStatus } from "./secrets/env-status";
import { userDataPath, userDataDir } from "./runtime-paths";
import { configuredIdentity } from "./install-identity";
import {
  installAgent,
  installMyAgent,
  getAgentById,
  listInstalledAgents,
  setAgentLocalDisplayName,
  uninstallAgent,
} from "./mcp/registry";
import {
  addOneOrgMember,
  archiveOneOrgMember,
  createOneTeamAgent,
  getOneOrgState,
  markOneOrgMemberRead,
  reorderOneOrgMembers,
  renameOneOrgMember,
  replaceOneOrgMember,
  restoreOneOrgMember,
  setOneOrgMemberTools,
  updateOneOrgMember,
} from "./one/org";
import {
  createOneTaskforce,
  listOneTaskforces,
  oneTaskforceRemovalPreview,
  removeOneTaskforce,
  updateOneTaskforce,
} from "./one/taskforces";
import {
  clearComputerHistory,
  getComputerHistoryState,
  prepareComputerHistoryDraftPrompt,
  setComputerHistoryConsent,
} from "./one/computer-history";
import { MCP_TOOL_CATALOG, getCatalogEntry } from "./mcp-tools/catalog";
import {
  getServer,
  installCustomServer,
  installFromCatalog,
  listInstalledServers,
  removeServer,
  setServerEnabled,
} from "./mcp-tools/registry";
import {
  installHubPlugin,
  listPendingHubPluginApprovals,
  previewHubPlugin,
} from "./mcp-tools/hub-plugin-bridge";
import {
  authorizeMcpServer,
  discoverMcpOAuth,
  forgetMcpOAuth,
  readMcpOAuthSession,
} from "./mcp-tools/oauth";
import { getPluginBrandMap } from "./mcp-tools/plugin-brand";
import {
  closeHubProfileView,
  openHubProfileView,
  setHubProfileViewBounds,
  type HubProfileBounds,
} from "./hub-profile-view";
import { statusAllServers, testServerById } from "./mcp-tools/client";
import { recommendMcpBuildPlan } from "./mcp-tools/build-plan";
import { getOpenCrabReadiness } from "./opencrab/ontology";
import {
  getSource as getMarketSource,
  getCargoSource,
  invalidateMyAgentsCache,
  listMyAgentsCached,
  refreshSourceStatus as refreshMarketSourceStatus,
} from "./marketplace";
import {
  getFirm,
  installFirm,
  listFirms,
  removeFirmFromRoster,
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
import { getRoute } from "./agents/routes";
import { importLocalFolder } from "./agents/import-local";
import { getDb } from "./store/db";
import { getResolvedOrg } from "./store/org-spec";
import { listInstalledAgentHubBindings } from "./ontology/hub-bindings";
import { resolveTeamOrg, resolveAgentTeam } from "./agents/org-resolver";
import { runMcpInvocation } from "./mcp/client";
import {
  completeDesktopWorkforceGoal,
  desktopWorkforceGoalId,
  resolveDesktopWorkforceGoalId,
  loadDesktopWorkforceGoal,
} from "./mcp/workforce-goal-continuity";
import { resolveRunKeyElicitation } from "./mcp/run-key-elicitation";
import { invocationService } from "./invocation/service";
import { queueAutomaticGoalResume } from "./invocation/automatic-goal";
// ── Hephaestus 엔진 브리지 — 데스크탑↔엔진 연결은 전부 electron/hephaestus/* 에서만 일어난다. ──
import { hepAuthLogin, hepAuthStatus } from "./hephaestus/commands";
import { hephaestusAvailable, hephaestusDoctor, hephaestusRoot, readHephaestusUpdateJournal, runHephaestusRuntimeUpdate } from "./hephaestus/engine";
import { listSkillCatalog, readSkillCatalogAsset } from "./hephaestus/skill-catalog";
import { listRuntimeFiles, readRuntimeFile, writeRuntimeFile } from "./hephaestus/runtime-files";
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
  contractVerify,
} from "./hephaestus/commands";
import { autofixForPublish } from "./hephaestus/publish-autofix";
import { normalizeRecommendation } from "./hephaestus/recommendation";
import { confirmUpload, PathGuardError, resolveFolderArg } from "./hephaestus/path-guard";
import { getEngineToggles, isSupervisorEnabled, setEngineToggle, setSupervisorEnabled } from "./hephaestus/supervisor";
import { previewBuildAllocation, runHephaestusBuild } from "./hephaestus/builder";
import { resolveHephaestusBuildRequest, resolveHephaestusBuildRequestForRun } from "./hephaestus/build-access";
import { pickLocale } from "./runtime/status-i18n";
import { currentUiLocale } from "./ui-locale";
import { agentRemovalPreview, assignSeatOccupant, getSeatForChat, listSeatOccupantHistory } from "./store/seats";
import { koSubjectParticle, seatEventText } from "../shared/one-seat-events";
import { SYSTEM_OPTIMIZER_PROMPT_MARKER } from "./system-agents/system-optimizer";
import { stripAutomationContinuityCapsule } from "./automation-continuity";
import { buildChatRecap, markChatRecapViewed } from "./chat/recap";
import { assertChatRemovalAllowed } from "./chat/removal-guard";
import { startStudio, stopStudio } from "./hephaestus/studio";
import { listPendingAskUserRequests, submitAskUserAnswer } from "./confirm/ask-user";
import type {
  HephaestusBuildEvent,
  HephaestusBuildRequest,
  CreateAgentEvolutionProposalInput,
  ExperiencePackCreateIpcInput,
  ExperienceCloudReconcileInput,
  ExperienceCloudSaveInput,
  ExperienceCloudWithdrawInput,
  FsPathGrant,
  FsReadScope,
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
import { resolveExperiencePackCreateIpcInput } from "./experience/access";
import { getExperienceHubCatalog } from "./experience/hub-catalog";
import {
  checkSafely as updaterCheck,
  getUpdaterState,
  openManualDownload as updaterOpenManualDownload,
  openReleaseNotes as updaterOpenReleaseNotes,
  quitAndInstall as updaterInstall,
  revealRecoveryBackup as updaterRevealRecoveryBackup,
} from "./updater";
import { listDirectory, pickDirectory, readTextFilePreview } from "./fs/workspace";
import { grantDroppedPath, grantPastedAttachment, grantPastedImage, grantPath, pathFromGrant, resolveFsReadPath } from "./fs/access";
import { unwatchFsPreviewFile, unwatchFsPreviewFilesForOwner, watchFsPreviewFile } from "./fs/file-watch";
import { connectGithubProject } from "./project-sources/github";
import {
  getAuthSession,
  getAuthenticatedActorIds,
  getSessionCookieHeader,
  signInWithBrowser,
  signInWithGoogle,
  signOut,
} from "./auth";
import { reconcileMobileBridgeDevicesForAccount } from "./mobile-bridge/runtime";
import { getBillingCredits, transferEarnings } from "./billing";
import {
  addHubPromptBookmark,
  getHubPrompt,
  getHubPromptTasteStatus,
  getHubPromptUnlockStatus,
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
import { claimQuest, getQuestClaimStatus, listQuests } from "./quests";
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
  listChatRunTimeline,
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
  createOrReplayPromptChat,
  getChat,
  getOrCreateOneMemberChat,
  getChatWorkingFolder,
  listArchivedChats,
  listChatMessages,
  repairRootChatSurfaceController,
  listChatsByFirm,
  listChatsByProject,
  listRecentChats,
  listRecentOneChats,
  appendChatMessage,
  removeChat,
  renameChat,
  setChatContinuousMode,
  setChatGoalBinding,
  setChatRuntimeSelection,
  setChatSwarmMode,
  setChatWorkingFolder,
  unarchiveChat,
} from "./store/chats";
import { listChatFileSnapshot, persistChatFileSnapshot, readChatFileSnapshotForExternalOpen } from "./store/chat-message-attachments";
import {
  completeGoalLedgerGoal,
  deriveGoalAcceptanceCriteria,
  ensureGoalLedgerGoal,
  getGoalLedgerGoal,
} from "./mcp/goal-ledger";
import { findAutomationByGoalId } from "./store/automations";
import { emitDesktopStoreChange } from "./store/change-bus";
import {
  confirmDesktopLongRunResumeDispatched,
  failDesktopLongRunResumeDispatch,
  resumeDesktopLongRunManually,
} from "./long-run/app-runtime-coordinator";
import { getOrCreateAutomationSession } from "./store/automation-sessions";
import {
  acceptCanonicalTaskResult,
  getCanonicalTask,
  findCanonicalTaskForChat,
  getCanonicalTaskForChat,
  listCanonicalTasks,
} from "./store/tasks";
import { ONE_SELF_AVATAR_ICON, decodeOneTeamAvatarDataUrl, writeOneSelfAvatar } from "./one/avatar";
import { mutateOneTaskArchive, searchOneHistory } from "./one/search";
import { importExternalCliSession, listExternalCliSessions } from "./external-cli-sessions";
import {
  prejudgeOneRequestIntent,
  resolveOneRequestIntent,
} from "./one/judged-request-intent";
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
  acknowledgeOneTeamPreflight,
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
import { forgetOneDurableMemoryEntry, getOneMemoryMap, listOneDurableMemoryEntries } from "./one/memory-map";
import {
  acceptOneSuggestionForReviewFromUser,
  dismissOneSuggestion,
  getOneSuggestionReviewHandoff,
  getOneSuggestionState,
  neverAskOneSuggestion,
  snoozeOneSuggestion,
} from "./one/suggestions";
import { getOneSuggestionReviewSeed } from "./one/review-seed";
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
import { getAgentConcurrencyInfo, setAgentConcurrency } from "./store/concurrency";
import { getInterviewMode, setInterviewMode, type InterviewMode } from "./store/interview-mode";
import {
  createAutomation,
  getAutomation,
  listAutomations,
  toggleAutomation,
  updateAutomation,
  updateAutomationGraph,
  listGraphVersions,
  restoreGraphVersion,
  listRunHistory,
  acknowledgeAutomationRun,
  getLatestGraphRun,
  enqueueRunInput,
} from "./store/automations";
import { graphInputRequirement } from "../shared/graph-trigger-input";
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
  autoConnectTelegram,
  cloneTelegramConnection,
  configureTelegramBotSettings,
  connectTelegramToOne,
  importTerminalTelegramConnection,
  listTelegramBindings,
  openTelegramBot,
  pruneOrphanedTelegramBindings,
  removeLegacyTelegramConnections,
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
import { importBrowserCredentials, scanBrowserCredentials } from "./browser/credential-import";
import {
  browserCredentialConsentIsPending,
  getBrowserCredentialConsent,
  recordBrowserCredentialConsent,
  refreshBrowserCredentialsIfDue,
  revokeBrowserCredentialConsent,
} from "./browser/credential-sync";
import {
  captureBrowserLiveFrame,
  dispatchBrowserLiveInput,
  focusBrowserLiveTarget,
  startBrowserLiveSession,
  stopBrowserLiveSession,
  stopBrowserLiveSessionsForOwner,
} from "./browser/live-view";
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
import {
  startAppFactoryLivePreview,
  stopAppFactoryLivePreview,
} from "./app-factory/live-preview";
import {
  closeWorkLiveView,
  closeWorkLiveViewsForOwner,
  goBackWorkLiveView,
  goForwardWorkLiveView,
  navigateWorkLiveView,
  openWorkLiveView,
  reloadWorkLiveView,
  setWorkLiveViewBounds,
} from "./work-live-view";
import { archiveSurfaceAssetPack, materializeSurfaceAssetPack, restoreSurfaceAssetPack } from "./surface-assets/materialize";
import { archiveToolPackage, installToolMcp, restoreToolPackage } from "./tool-factory/operations";
import { runToolFactorySmoke, scaffoldAgentTool } from "./tool-factory/scaffold";
import {
  discardPluginBuilder,
  draftPluginBuilder,
  installPluginBuilder,
  listPluginBuilderDrafts,
  provePluginBuilder,
  startPluginBuilder,
  subscribePluginBuilderProgress,
  verifyPluginBuilder,
} from "./plugins/builder";
import type { PluginBuilderAnswers, PluginBuilderSeed } from "../shared/plugin-builder";
import { createCommerceAgentTeam } from "./meta-agent/commerce-team";
import { packageAndReviewCloudAgent } from "./cloud-agents/package";
import { readAgentPrices, setAgentPrices } from "./cloud-agents/pricing";
import {
  activeLeasedSlugs,
  getAgentLeaseQuote,
  listAgentLeasesCached,
  purchaseAgentLease,
} from "./cloud-agents/leases";
import { listRentAllowedSlugs, setRentAllowed } from "./store/project-agent-rent";
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
  CanonicalTaskWorkTarget,
  CloudAgentPublishProgressEvent,
  CloudAgentPublishStage,
  CloudAgentPublishRequest,
  CloudAgentPricePatch,
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
  ProjectAgentPoolMember,
  ProjectSourceType,
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
import {
  announceToolDenied,
  capabilityClassFor,
  getToolApprovalResolution,
  listPendingToolApprovals,
  onToolApprovalRequested,
  onToolApprovalResolved,
  requestToolApproval,
  resolveToolApproval,
  setCapabilityGrantPersister,
  setRuntimeToolPermissionArbiter,
} from "./runtime/tool-approval";
import {
  getCapabilityDecision,
  capabilityConsentScope,
  capabilityResourceIdentity,
  grantChatAlwaysApproval,
  listAlwaysApprovedChatIds,
  listCapabilityGrants,
  recordCapabilityGrant,
  revokeCapabilityGrant,
  revokeChatAlwaysApproval,
} from "./store/capability-grants";
import type { ToolApprovalDecision } from "../shared/types";
import type { ToolApprovalConsentBinding } from "../shared/types";

// DESKTOP_MOBILE_BRIDGE: live invocation authority moved to invocation/service.ts.
// Hephaestus 빌더(hep-build) 진행 중 실행 — 취소용 AbortController 레지스트리.
const activeBuilds = new Map<string, AbortController>();
/**
 * 실행 중(또는 마지막) 빌드의 전사(轉寫).
 *
 * 빌드는 main에서 돌지만 진행 상태는 렌더러 모듈 변수에만 있었다. 그래서 빌드 중에
 * 다른 메뉴를 한 번 누르면 요청·로그·단계가 통째로 사라졌다(2026-08-16 실측:
 * rows 10→0, request 소실, 화면상 "멈춤" — 실제로는 main에서 계속 돌고 있었다).
 * 터미널 hep-build는 프로세스가 살아 있는 한 화면을 잃지 않으므로, 이건 GUI가
 * 만들어 낸 차이다. 여기 전사를 남겨 두면 화면이 돌아왔을 때 그대로 복원된다.
 */
const buildTranscripts = new Map<string, {
  runId: string;
  request: string;
  workspace: string;
  startedAt: string;
  running: boolean;
  events: HephaestusBuildEvent[];
}>();
/** 한 빌드가 남기는 이벤트 상한 — 긴 빌드가 메모리를 무한히 쓰지 않게. */
const BUILD_TRANSCRIPT_MAX_EVENTS = 4_000;
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

  // 승인 게이트 폐지(오너 이사회 결정 2026-08-10) — "Agentlas 승인 대기" macOS 알림은
  // 더 이상 보내지 않는다. 배지/도크 표시는 남는다(정보 표시이지 승인 요구가 아니다).
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
  _win: BrowserWindow,
  _recommendation: SiteAgentAppMcpRecommendation,
): Promise<"approved" | "declined"> {
  /* 승인 게이트 폐지(오너 이사회 결정 2026-08-10) — 빌드 전 MCP 연결 검토 모달은 더
     이상 띄우지 않고, 예전 모달의 기본 버튼이던 "MCP 없이 계속"(= declined)을 자동
     선택한다. 앱 생성·실행은 MCP 없이 계속되고, 어떤 MCP 도 자동으로 붙지 않는다 —
     실행 직전 설치/키/연결/런타임 재검증과 안전 정책 차단은 그대로 남는다. */
  return "declined";
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
  // rows.length === 0 means there is nothing the user's click can change (see
  // the early return inside the loop below) — the automatic pre-build check
  // would otherwise interrupt Create with a decision-free native dialog. The
  // same "blocked" fact is already shown, non-blocking, via the project
  // card's MCP badge (SiteLanding.tsx mcpCardPresentation) once it exists.
  if (mode === "prebuild" && recommendation.rows.length === 0) return recommendation;
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
    const idKey = source === "local" ? kind === "agent" ? "agentId" : kind === "team" ? "firmId" : "" : "slug";
    const id = idKey && typeof target[idKey] === "string" ? target[idKey].trim() : "";
    if (!id || id.length > 160) throw new Error("Invalid task-force target identity.");
    let normalized: OrchestrationTarget;
    if (source === "local" && kind === "agent") normalized = { source, entityKind: kind, agentId: id };
    else if (source === "local" && kind === "team") normalized = { source, entityKind: kind, firmId: id };
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
    forceBrowserCredentialRefresh: _forceBrowserCredentialRefresh,
    ...rendererFields
  } = req as McpInvocationRequest & {
    oneTeamExecutionPolicy?: unknown;
    oneTeamRuntimeBinding?: unknown;
    oneAttachmentContext?: unknown;
    oneAttachmentRedactions?: unknown;
  };
  return {
    ...rendererFields,
    // Closed enum: anything but the exact system marker is the person's own turn.
    promptOrigin: rendererFields.promptOrigin === "system" ? "system" : undefined,
    oneMode: rendererFields.oneMode === true,
    steeringMode: rendererFields.steeringMode === "interrupt" ? "interrupt" : undefined,
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

/**
 * Seed a project folder's `.agentlas` (and its code map) off the critical path.
 *
 * Project creation returns immediately; a first map build can take tens of
 * seconds on a large workspace and must never hold the IPC reply. Failures are
 * logged, not surfaced: the next turn's recordFolderVisit retries anyway.
 */
async function seedProjectMapInBackground(folderPath: string, projectName?: string): Promise<void> {
  try {
    const { ensureDesktopProjectBootstrap } = await import("./architecture/project-bootstrap");
    await ensureDesktopProjectBootstrap({
      projectPath: folderPath,
      projectName,
      access: { permission: "full" },
      reason: "desktop-project-created",
    });
  } catch (err) {
    console.error("[architecture] project map seed failed:", err);
  }
}

const browserLiveCleanupOwners = new Set<number>();
const fsWatchCleanupOwners = new Set<number>();
const workLiveCleanupOwners = new Set<number>();

async function desktopRuntimeRolePoolState(): Promise<RuntimeRolePoolState> {
  const picks = await resolveRolePoolPicks();
  // Multimodal is intentionally not quota-auto-picked, but the Desktop still
  // needs the exact head selection so it can label the configured generator.
  const multimodal = pickModelRoleFromPool("multimodal");
  return {
    members: {
      orchestrator: listModelRoleMembers("orchestrator"),
      worker: listModelRoleMembers("worker"),
      multimodal: listModelRoleMembers("multimodal"),
    },
    picks: {
      ...picks,
      ...(multimodal ? { multimodal } : {}),
    },
  };
}

export function registerIpcHandlers(): void {
  let oneProjectionHostRef: string | null = null;
  subscribePluginBuilderProgress((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        try { window.webContents.send("pluginBuilder:progress", event); } catch { /* renderer may be closing */ }
      }
    }
  });
  const oneTaskProjectionRuntime = createOneTaskProjectionRuntime({
    getAuthoritySnapshot: ({ taskId }) => {
      const task = getCanonicalTask(taskId);
      if (!task) return null;
      const chatAvailable = Boolean(task.originChatId && getChat(task.originChatId));
      if (!oneProjectionHostRef) {
        try {
          oneProjectionHostRef = loadOrCreateMobileBridgeHostIdentity(userDataDir()).hostId;
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
  ipcMain.handle("media:copyImage", (event, payload: { src?: unknown; suggestedName?: unknown }) => {
    assertTrustedSitePublishIpcSender(event);
    return copyImageSource(String(payload?.src || ""), typeof payload?.suggestedName === "string" ? payload.suggestedName : undefined);
  });
  ipcMain.handle("media:saveImage", (event, payload: { src?: unknown; suggestedName?: unknown }) => {
    const win = assertTrustedSitePublishIpcSender(event);
    return saveImageSource(win, String(payload?.src || ""), typeof payload?.suggestedName === "string" ? payload.suggestedName : undefined);
  });

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
    "one-decision-authority-readiness": {
      question:
        "Does this One decision request contain enough human-readable detail for the user to knowingly choose an option that grants authority?",
      guidance:
        "Return ready only when target, action, material impact, and relevant cost, destination/audience, and undo limits are clear in this same decision. " +
        "A standard account login/connection is ready when the login step is explicit, there is no charge, and the connection can later be revoked. " +
        "Payment, publication, destructive, legal, security, and permission changes need their material amount/scope/destination and reversal limits. " +
        "Do not require Work merely because the action is R2 or higher; decide whether One can safely ask here.",
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

  // ── T-rex 슬라이드 스튜디오 이미지 생성(키리스 CLI: codex image_gen / agy) ──
  ipcMain.handle("multimodal:generateImage", async (_e, payload: { model?: "codex" | "gemini" | "auto"; prompt?: string }) => {
    const { generateImage } = await import("./multimodal/image");
    const model = payload?.model === "gemini" ? "gemini" : payload?.model === "codex" ? "codex" : "auto";
    return generateImage(model, String(payload?.prompt ?? ""));
  });
  ipcMain.handle("multimodal:imageProviders", async () => {
    const { imageProviders } = await import("./multimodal/image");
    return imageProviders();
  });
  // T-rex 슬라이드 "내용" 생성 — 연결된 LLM(agy/codex)이 슬라이드별 실제 카피·수치를 JSON으로 작성.
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
          // 앱 화면은 편집도 앱 계약(393x852·안전영역)으로 해야 한다. 이걸 빼면 한 번
          // 수정하는 순간 "375/1280 반응형" 웹 계약으로 조용히 드리프트한다.
          surface: project.surface,
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
  /*
   * 디자인 → 코드 내보내기(오너 정의 2026-08-20: Site 는 디자인 생성기다).
   * 승인된 화면을 React/HTML(웹) 또는 Flutter/React Native(앱) 소스로 옮겨,
   * 사용자가 고른 폴더에 파일 트리로 쓴다. 배포는 하지 않는다.
   */
  ipcMain.handle("site:exportScreenCode", async (e, payload: {
    projectId?: string;
    screenId?: string;
    target?: string;
  }) => {
    try {
      const { getSiteProject, readSiteScreenHtml } = await import("./site/store");
      const { exportSiteScreenCode } = await import("./site/generate");
      const { exportTargetsFor } = await import("./site/design-export");
      const projectId = String(payload?.projectId ?? "");
      const screenId = String(payload?.screenId ?? "");
      const meta = getSiteProject(projectId);
      const allowed = exportTargetsFor(meta.surface);
      const target = allowed.find((candidate) => candidate === payload?.target);
      if (!target) return { ok: false, reason: `unsupported export target for this surface (allowed: ${allowed.join(", ")})` };
      const html = readSiteScreenHtml(projectId, screenId);
      const screen = meta.screens.find((s) => s.id === screenId);

      const win = BrowserWindow.fromWebContents(e.sender);
      // 폴더를 **먼저** 고르게 한다 — 몇 분짜리 변환을 돌린 뒤에 "어디 쓸까요"를 묻고
      // 취소당하면 그 실행이 통째로 버려진다.
      const picked = await dialog.showOpenDialog(win ?? undefined!, {
        title: "내보낼 폴더 선택",
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      const root = picked.filePaths[0];

      const result = await exportSiteScreenCode({
        projectId,
        html,
        target,
        surface: meta.surface,
      });
      if (!result.ok || !result.files) return { ok: false, reason: result.reason ?? "export-failed" };

      const folderName = `${(screen?.name ?? "screen").replace(/[^\w가-힣 .-]+/g, "_")}-${target}`;
      const outDir = path.join(root, folderName);
      const written: string[] = [];
      for (const file of result.files) {
        const destination = path.join(outDir, file.path);
        // 경로 탈출 재확인 — 파서가 이미 걸렀지만, 쓰기 직전이 마지막 경계다.
        const relative = path.relative(outDir, destination);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.content, "utf8");
        written.push(file.path);
      }
      return { ok: true, path: outDir, files: written, notes: result.notes, engine: result.engine };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("site:exportTargets", async (_e, payload: { projectId?: string }) => {
    try {
      const { getSiteProject } = await import("./site/store");
      const { exportTargetsFor } = await import("./site/design-export");
      return { ok: true, targets: exportTargetsFor(getSiteProject(String(payload?.projectId ?? "")).surface) };
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
  // PDF 내보내기. 저장 위치는 네이티브 다이얼로그가 정한다 — 렌더러가 보낸 경로는
  // 권한이 아니므로 targetPath 는 Main 이 다이얼로그 결과로만 채운다.
  ipcMain.handle(
    "document:exportPdf",
    async (
      event,
      payload: { title?: string; markdown?: string; figureCaption?: string; suggestedName?: string },
    ) => {
      const markdown = typeof payload?.markdown === "string" ? payload.markdown : "";
      if (!markdown.trim()) return { ok: false, reason: "empty document" };
      const win = BrowserWindow.fromWebContents(event.sender);
      const title = typeof payload?.title === "string" ? payload.title : "";
      const suggested = (payload?.suggestedName || `${title || "document"}.pdf`).replace(/[/\\]/g, "-");
      const chosen = await dialog.showSaveDialog(win ?? undefined!, {
        defaultPath: suggested.endsWith(".pdf") ? suggested : `${suggested}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true };
      const { renderDocumentPdf } = await import("./document/export-pdf");
      const result = await renderDocumentPdf({
        title,
        markdown,
        figureCaption: typeof payload?.figureCaption === "string" ? payload.figureCaption : undefined,
        targetPath: chosen.filePath,
      });
      return result.ok ? { ...result, path: chosen.filePath } : result;
    },
  );
  ipcMain.handle("document:pdfCapability", async () => {
    const { documentPdfCapability } = await import("./document/export-pdf");
    return documentPdfCapability();
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
  ipcMain.handle("updater:install", () => {
    const activeRunCount = invocationService.activeChatIds().length;
    if (activeRunCount > 0) {
      return {
        accepted: false,
        state: getUpdaterState(),
        blockedBy: "active-runs" as const,
        activeRunCount,
      };
    }
    return updaterInstall();
  });
  ipcMain.handle("updater:openManualDownload", () => updaterOpenManualDownload());
  ipcMain.handle("updater:openReleaseNotes", (_event, version?: string) => updaterOpenReleaseNotes(version));
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
  ipcMain.handle("fs:watchFile", (event, absPath: string, scope: FsReadScope) => {
    assertTrustedSitePublishIpcSender(event);
    const ownerId = event.sender.id;
    if (!fsWatchCleanupOwners.has(ownerId)) {
      fsWatchCleanupOwners.add(ownerId);
      event.sender.once("destroyed", () => {
        fsWatchCleanupOwners.delete(ownerId);
        unwatchFsPreviewFilesForOwner(ownerId);
      });
    }
    return watchFsPreviewFile(ownerId, String(absPath || ""), scope, (snapshot) => {
      if (!event.sender.isDestroyed()) event.sender.send("fs:fileChanged", snapshot);
    });
  });
  ipcMain.handle("fs:unwatchFile", (event, watchId?: string) => {
    assertTrustedSitePublishIpcSender(event);
    return unwatchFsPreviewFile(event.sender.id, typeof watchId === "string" ? watchId.slice(0, 128) : "");
  });
  // This channel is intentionally absent from window.agentlas. Only the isolated
  // preload bridge can pair webUtils.getPathForFile(File) with this grant call.
  ipcMain.handle("fs:grantDroppedPath", (_e, droppedPath: string) => grantDroppedPath(droppedPath));
  // Only preload can submit grants. Renderer text can never promote an
  // arbitrary path into a durable chat file.
  ipcMain.handle("chatFiles:snapshot", (_e, input: unknown) => persistChatFileSnapshot(input as Parameters<typeof persistChatFileSnapshot>[0]));
  ipcMain.handle("chatFiles:listGroup", (_e, input: unknown) => listChatFileSnapshot(input as Parameters<typeof listChatFileSnapshot>[0]));
  ipcMain.handle("chatFiles:openExternal", async (_e, input: unknown): Promise<{ ok: boolean; message?: string }> => {
    let root = "";
    try {
      const file = readChatFileSnapshotForExternalOpen(input);
      if (!file) return { ok: false, message: "The exact chat file binding or document type is unavailable." };
      root = fs.realpathSync.native(fs.mkdtempSync(path.join(app.getPath("temp"), "agentlas-chat-open-")));
      fs.chmodSync(root, 0o700);
      const destination = path.join(root, path.basename(file.name));
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);
      const fd = fs.openSync(destination, flags, 0o600);
      try {
        fs.writeFileSync(fd, file.bytes);
        fs.fsyncSync(fd);
        fs.fchmodSync(fd, 0o400);
      } finally {
        fs.closeSync(fd);
      }
      const written = fs.lstatSync(destination, { bigint: true });
      const writtenDigest = createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
      if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1n || written.size !== BigInt(file.size) || writtenDigest !== file.sha256) {
        throw new Error("The temporary file failed its integrity check.");
      }
      const message = await shell.openPath(destination);
      if (message) throw new Error(message);
      // The OS owns the temporary-directory lifetime after a successful open.
      // Keeping the verified copy read-only avoids silently discarding edits on
      // an arbitrary timer while still preventing it from becoming an export.
      return { ok: true };
    } catch (error) {
      if (root) fs.rm(root, { recursive: true, force: true }, () => undefined);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  // 클립보드 이미지는 경로가 없다 — main이 내용을 비공개 파일로 고정하고 같은 등급의
  // capability를 돌려준다. 그래야 붙여넣기가 드롭·파일선택과 같은 첨부 경로를 탄다.
  ipcMain.handle("fs:grantPastedImage", (_e, input: unknown) =>
    grantPastedImage((input ?? {}) as { mediaType?: unknown; bytes?: unknown }));
  // Pasted audio, video and safe document data has no native Finder path. Main
  // owns the accepted MIME/extension and emits the same exact-file capability.
  ipcMain.handle("fs:grantPastedAttachment", (_e, input: unknown) =>
    grantPastedAttachment((input ?? {}) as { mediaType?: unknown; bytes?: unknown }));
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
      // Only phones bound to a DIFFERENT workspace lose their credential. The
      // same account signing in again keeps every pairing — revoking there was
      // a large part of why no pairing ever survived.
      reconcileMobileBridgeDevicesForAccount(userDataDir());
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
      reconcileMobileBridgeDevicesForAccount(userDataDir());
      failCloseActiveHubBookmarks();
      broadcastHubBookmarkSnapshot();
      void syncHubBookmarks({ rerunIfBusy: true });
    }
    return session;
  });
  ipcMain.handle("auth:signOut", async () => {
    // Signing out stops the bridge from serving (desktopSessionActive gate) but
    // does not delete pairings: signing back into the same account must restore
    // them. A different account signing in revokes them at that point.
    await signOut();
    reconcileMobileBridgeDevicesForAccount(userDataDir());
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
  ipcMain.handle(
    "promptHub:unlock",
    (_e, input: { slug: string; unlockIntentId: string }) => unlockHubPrompt(input),
  );
  ipcMain.handle(
    "promptHub:unlockStatus",
    (_e, input: { slug: string; unlockIntentId: string }) => getHubPromptUnlockStatus(input),
  );
  ipcMain.handle(
    "promptHub:taste",
    (_e, input: { slug: string; tasteIntentId: string }) => tasteHubPrompt(input),
  );
  ipcMain.handle(
    "promptHub:tasteStatus",
    (_e, input: { slug: string; tasteIntentId: string }) => getHubPromptTasteStatus(input),
  );
  ipcMain.handle(
    "promptHub:startChat",
    (_e, input: { intentId: string; body: string; seedOnly?: boolean }) => createOrReplayPromptChat(input),
  );
  ipcMain.handle("promptHub:tastes", () => listHubPromptTastes());
  ipcMain.handle("promptHub:bookmarks", () => listHubPromptBookmarks());
  ipcMain.handle("promptHub:bookmarkAdd", (_e, slug: string) => addHubPromptBookmark(slug));
  ipcMain.handle("promptHub:bookmarkRemove", (_e, slug: string) => removeHubPromptBookmark(slug));

  // ── 퀘스트 — 대시보드 신규 유저 튜토리얼(온보딩 대체) ──────────────────────
  ipcMain.handle("quests:list", () => listQuests());
  ipcMain.handle("quests:claim", (_e, input) => claimQuest(input));
  ipcMain.handle("quests:claimStatus", (_e, input) => getQuestClaimStatus(input));

  // ── 에이전트 전역 durable 메모리 — 프로젝트 귀속 콘텐츠는 이 표면에서 제외 ──
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
  ipcMain.handle("agents:exact-bindings", () => listInstalledAgentHubBindings());
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
  ipcMain.handle("confirm:commitAnswer", (_e, input: {
    chatId?: unknown;
    reply?: unknown;
    sourceMessageId?: unknown;
    continuation?: unknown;
  }) => {
    const raw = input?.continuation && typeof input.continuation === "object" && !Array.isArray(input.continuation)
      ? input.continuation as Record<string, unknown>
      : undefined;
    const chatId = typeof input?.chatId === "string" ? input.chatId : "";
    const reply = typeof input?.reply === "string" ? input.reply : "";
    const sealed = raw ? rendererInvocationRequest({
      chatId,
      userPrompt: reply,
      ...(raw.locale === "ko" || raw.locale === "en" ? { locale: raw.locale } : {}),
      ...(raw.permissions === "read" || raw.permissions === "write" || raw.permissions === "full"
        ? { permissions: raw.permissions }
        : {}),
      ...(raw.sessionRouting === true ? { sessionRouting: true } : {}),
      ...(raw.runtimeSelection && typeof raw.runtimeSelection === "object" && !Array.isArray(raw.runtimeSelection)
        ? { runtimeSelection: raw.runtimeSelection as RuntimeSelection }
        : {}),
    }) : undefined;
    return commitPendingConfirmationAnswer(
      chatId,
      reply,
      typeof input?.sourceMessageId === "string" ? input.sourceMessageId : undefined,
      sealed ? {
        locale: sealed.locale,
        permissions: sealed.permissions,
        sessionRouting: sealed.sessionRouting,
        runtimeSelection: sealed.runtimeSelection,
      } : undefined,
    );
  });
  ipcMain.handle("confirm:continueAnswer", (_e, input: {
    chatId?: unknown;
    sourceMessageId?: unknown;
    reply?: unknown;
  }) => invocationService.continueCommittedQuestion(
    typeof input?.chatId === "string" ? input.chatId : "",
    typeof input?.sourceMessageId === "string" ? input.sourceMessageId : "",
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
  // 역할 풀: 순서 있는 후보 목록 + 현재 선택/스킵 사유. set은 전체 교체(순서=우선순위).
  ipcMain.handle("runtime:listRoleMembers", () => desktopRuntimeRolePoolState());
  ipcMain.handle(
    "runtime:setRoleMembers",
    async (_e, role: RuntimeRole, selections: RuntimeSelection[]) => {
      setModelRoleMembersStore(role, selections);
      clearDetectCache();
      await detectRuntimes();
      return desktopRuntimeRolePoolState();
    },
  );
  ipcMain.handle("runtime:installCli", (_e, kind: InstallableCli) => installCli(kind));
  ipcMain.handle("runtime:openCliLogin", async (_e, kind: ManageableCli) => {
    // 로그인 터미널을 여는 시점에 감지/사용량 캐시를 즉시 무효화 — 로그인 완료가
    // watchRecovery 폴링(및 그 이후 일반 폴링)에 재시작 없이 바로 반영되게 한다.
    clearDetectCache();
    if (kind === "claude-code" || kind === "codex") invalidateUsage(kind);
    const runtimes = await detectRuntimes();
    const selected = runtimes.find((runtime) => runtime.kind === kind && runtime.active)
      ?? runtimes.find((runtime) => runtime.kind === kind);
    return openCliLogin(kind, selected?.source);
  });
  ipcMain.handle("runtime:updateCli", async (_e, kind: ManageableCli) => {
    const releaseMaintenance = tryAcquireRuntimeMaintenance();
    if (!releaseMaintenance) {
      return {
        ok: false,
        message: "CLI update deferred until active chats and automations finish",
      };
    }
    try {
      const runtimes = await detectRuntimes();
      const selected = runtimes.find((runtime) => runtime.kind === kind && runtime.active)
        ?? runtimes.find((runtime) => runtime.kind === kind);
      const result = await updateCli(kind, selected?.source);
      if (result.ok) {
        clearDetectCache();
        // CLI 교체는 이미 떠 있는 상주 프로세스의 바이너리를 바꾸지 않는다. 자동 업데이트
        // 경로와 같은 정리 계약을 수동 업데이트에도 적용해, 다음 턴이 새 CLI로 시작하게 한다.
        disposeAcpSessionPool();
        disposeClaudeSessionPool();
        disposeCodexSessionPool();
        // 렌더러의 IPC/view snapshot도 즉시 비우게 한다. TTL(최대 5분)을 기다리거나 모델
        // 선택을 다시 눌러야 연결이 살아나는 현재 증상을 막는다.
        emitDesktopStoreChange({ entity: "runtime" });
      }
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

  // ── 터미널 프로필(사용자 편집형 CLI 러너) ───────────────────────────
  // Paseo식: 각 프로필 = {id, name, template}. template의 {{{prompt}}}가 메시지로
  // 치환돼 CLI로 실행된다. 하드코딩된 claude/codex/antigravity와 달리 사용자가 어떤 CLI든
  // 등록·편집한다. (런타임 dispatch 배선은 후속 — 여기서는 저장/조회만.)
  // detect() reads ACP-mode profiles through this store-backed reader (electron/runtime/acp-agents.ts).
  setAcpProfileReader(() => {
    try {
      const row = getDb().prepare("SELECT value FROM meta WHERE key = 'terminal_profiles'").get() as { value: string } | undefined;
      const parsed = row?.value ? JSON.parse(row.value) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  ipcMain.handle("config:getTerminalProfiles", () => {
    try {
      const row = getDb().prepare("SELECT value FROM meta WHERE key = 'terminal_profiles'").get() as { value: string } | undefined;
      if (!row?.value) return [];
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  ipcMain.handle("config:setTerminalProfiles", (_e, profiles: unknown) => {
    // Shape rules live in shared/terminal-profiles.ts (template needs {{{prompt}}};
    // acp needs a command). Saved acp profiles are detected as kind "acp".
    const safe = sanitizeTerminalProfiles(profiles);
    getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('terminal_profiles', ?)").run(JSON.stringify(safe));
    return safe;
  });

  // ── 에이전트 동시성(스웜 크기) — 사양 기반 추천 + 사용자 슬라이더 ─────────
  /*
   * ★권한 안내는 문장이 아니라 버튼이어야 한다(오너 실판정 2026-08-06) — "시스템 설정 >
   * 개인정보 보호…를 켜세요"는 모르는 사람에겐 없는 것과 같다. 상태 조회는 실행 중인
   * **이 프로세스** 기준의 진실(isTrustedAccessibilityClient)이다 — 설치본에 켠 권한과
   * 개발 실행은 macOS가 서로 다른 앱으로 취급한다(오너가 "이미 켰는데?"라고 한 실측 혼선의 뿌리).
   */
  ipcMain.handle("system:computerUsePermissions", () => checkComputerUsePermissions());
  ipcMain.handle("system:openAccessibilitySettings", async () => {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  });
  ipcMain.handle("system:concurrencyInfo", () => getAgentConcurrencyInfo());
  // 브리핑 인터뷰 모드 (smart / build-only / off)
  ipcMain.handle("interview:getMode", () => getInterviewMode());
  ipcMain.handle("interview:setMode", (_e, mode: InterviewMode) => setInterviewMode(mode));
  ipcMain.handle("system:setConcurrency", (_e, value: unknown) => {
    setAgentConcurrency(Number(value));
    return getAgentConcurrencyInfo();
  });

  // ── env vault (글로벌 외부 API 키) ──────────────────────
  ipcMain.handle("credentialRecovery:list", (event) => {
    assertTrustedSitePublishIpcSender(event);
    return listCredentialRecoveryFailures();
  });
  ipcMain.handle("credentialRecovery:retry", (event, retryToken: unknown) => {
    assertTrustedSitePublishIpcSender(event);
    if (typeof retryToken !== "string" || retryToken.length > 128) return { status: "invalid-token" };
    return retryCredentialRecoveryFromUser(retryToken);
  });
  ipcMain.handle("env:list", async () => {
    // Gather known requirements before touching credential storage.
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
    return collectEnvStatus(
      [...map].map(([key, entry]) => ({ key, requiredBy: entry.requiredBy })),
      { listKeys: listEnvKeys, hasValue: hasEnvVar, preview: previewEnvVar },
    );
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
  ipcMain.handle("multimodal:startVideo", (_e, request) => startVideoJob(request));
  ipcMain.handle("multimodal:getVideoJob", (_e, id: string) => getVideoJob(id));
  ipcMain.handle("multimodal:cancelVideo", (_e, id: string) => cancelVideoJob(id));
  ipcMain.handle("multimodal:openVideoOutput", (_e, id: string) => openVideoOutput(id));
  ipcMain.handle("multimodal:videoKeyStatus", () => videoKeyStatus());

  // ── team (설치된 에이전트) ─────────────────────────────
  ipcMain.handle("team:list", () => listInstalledAgents());
  ipcMain.handle("team:install", (_e, slug: string) => installAgent(slug));
  ipcMain.handle("team:installMine", (_e, id: string) => installMyAgent(id));
  // 봇 삭제 확인 문구용 정확한 수 — "좌석 N곳이 빈 자리가 됩니다. 대화 M개는 그대로 남습니다".
  ipcMain.handle("team:uninstallPreview", (_e, id: string) => agentRemovalPreview(id));
  ipcMain.handle("team:uninstall", async (_e, id: string, options?: { removeSource?: boolean }) => {
    const existing = getAgentById(id);
    if (!existing) return { removed: false, sourceMovedToTrash: false };
    const route = getRoute(id);
    uninstallAgent(id);
    let sourceMovedToTrash = false;
    if (options?.removeSource && route?.source === "local-import" && fs.existsSync(route.path)) {
      try {
        await shell.trashItem(route.path);
        sourceMovedToTrash = true;
      } catch {
        // Registry removal remains complete; the result tells the renderer that
        // the original folder still needs attention.
      }
    }
    return { removed: true, sourceMovedToTrash };
  });
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

  // ── One Team (durable identity bindings; Work still owns execution) ──
  ipcMain.handle("oneOrg:get", () => getOneOrgState());
  ipcMain.handle("oneOrg:createAgent", (_e, input) => createOneTeamAgent(input));
  ipcMain.handle("oneOrg:add", (_e, input) => addOneOrgMember(input));
  ipcMain.handle("oneOrg:rename", (_e, input) => renameOneOrgMember(input));
  ipcMain.handle("oneOrg:update", (_e, input) => updateOneOrgMember(input));
  ipcMain.handle("oneOrg:replace", (_e, input) => replaceOneOrgMember(input));
  ipcMain.handle("oneOrg:archive", (_e, input) => archiveOneOrgMember(input));
  ipcMain.handle("oneOrg:restore", (_e, input) => restoreOneOrgMember(input));
  ipcMain.handle("oneOrg:markRead", (_e, input) => markOneOrgMemberRead(input));
  ipcMain.handle("oneOrg:reorder", (_e, input) => reorderOneOrgMembers(input));
  ipcMain.handle("oneOrg:setTools", (_e, input) => setOneOrgMemberTools(input));

  // ── One Taskforces (durable group chats; One is always implicit) ──
  ipcMain.handle("oneTaskforces:list", () => listOneTaskforces());
  ipcMain.handle("oneTaskforces:create", (_e, input) => createOneTaskforce(input));
  ipcMain.handle("oneTaskforces:update", (_e, input) => updateOneTaskforce(input));
  ipcMain.handle("oneTaskforces:remove", (_e, input) => {
    const taskforce = listOneTaskforces().find((item) => item.id === input?.id);
    if (taskforce && invocationService.activeChatIds().includes(taskforce.chatId)) {
      throw new Error("Stop the active Taskforce run before deleting it.");
    }
    // 이 "삭제"는 좌석 해체(T7)다 — 대화는 지워지지 않고 읽기 전용 아카이브로 남는다.
    removeOneTaskforce(input);
  });
  // 해체 확인 문구용 정확한 수(사전 COUNT) — "대화 N개는 기록으로 남습니다".
  ipcMain.handle("oneTaskforces:removePreview", (_e, input) => oneTaskforceRemovalPreview(input));
  // 세션의 좌석 1급 조회 — 해체 배너·빈 자리 표시가 이 창구로 읽는다.
  ipcMain.handle("seats:forChat", (_e, chatId: string) => getSeatForChat(chatId));
  // "그때 누가 있었나" 재구성(I6) — 닫힌 점유 포함 append-only 이력.
  ipcMain.handle("seats:historyForChat", (_e, chatId: string) => {
    const seat = getSeatForChat(chatId);
    return seat ? listSeatOccupantHistory(seat.id) : [];
  });
  // T10 빈 좌석 배정 — 착석 + 세션에 시스템 줄 1개(누가 앉았는지 대화가 스스로 말한다).
  ipcMain.handle("seats:assign", (_e, input: { chatId: string; agentId: string; slot?: number }) => {
    const seat = getSeatForChat(input.chatId);
    if (!seat) throw new Error("This conversation has no seat yet.");
    const assigned = assignSeatOccupant(seat.id, input.agentId, input.slot ?? 0);
    const name = assigned.occupants.find((row) => row.agentId === input.agentId)?.displayName ?? "";
    if (name) {
      appendChatMessage(
        input.chatId,
        "system",
        seatEventText(currentUiLocale() === "ko" ? `이 자리를 ${name}${koSubjectParticle(name)} 맡았습니다` : `${name} took this seat`),
      );
    }
    return assigned;
  });

  // ── Computer History (explicit local opt-in; no raw history leaves disk) ──
  ipcMain.handle("computerHistory:get", () => getComputerHistoryState());
  ipcMain.handle("computerHistory:setConsent", (_e, enabled: boolean) => setComputerHistoryConsent(enabled === true));
  ipcMain.handle("computerHistory:clear", () => clearComputerHistory());
  ipcMain.handle("computerHistory:prepareDraft", (_e, recommendationId: string, locale: "ko" | "en") =>
    prepareComputerHistoryDraftPrompt(recommendationId, locale === "ko" ? "ko" : "en"));

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
    "runLedger:chatTimeline",
    (_e, chatId: string, input?: { maxRuns?: number; eventsPerRun?: number }) =>
      listChatRunTimeline(chatId, input),
  );
  ipcMain.handle(
    "runLedger:failures",
    (_e, input?: { runId?: string; automationId?: string; chatId?: string; agentId?: string; limit?: number }) =>
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
  /*
   * 엔진 텍스트 자산 편집 — 스킬·호스트 훅·어댑터 매니페스트를 앱 안에서 고친다.
   * 경계와 "업데이트가 덮어쓴다"는 사실은 runtime-files.ts 가 들고 있다.
   */
  ipcMain.handle("runtimeFiles:list", () => listRuntimeFiles());
  ipcMain.handle("runtimeFiles:read", (_e, relPath: string) => readRuntimeFile(relPath));
  ipcMain.handle("runtimeFiles:write", (_e, relPath: string, content: string) =>
    writeRuntimeFile(relPath, content));
  ipcMain.handle("skills:listCatalog", () => listSkillCatalog());
  ipcMain.handle("skills:readCatalog", (_event, slug: string) => readSkillCatalogAsset(slug));

  // ── mcpTools (외부 MCP 툴 플러그인 — Slack/Discord/GitHub 등) ─
  ipcMain.handle("mcpTools:listCatalog", () => MCP_TOOL_CATALOG);
  // 로고는 웹 카탈로그가 정본이다 — 데스크탑은 slug->자산 주소만 거울로 들고 있는다.
  ipcMain.handle("mcpTools:brandMap", () => getPluginBrandMap());
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
  // Hub 플러그인 설치 — 미리보기와 설치를 반드시 나눈다. stdio 행은 그 명령을 이 기계에서
  // 실행한다는 뜻이므로, 사람이 명령 원문을 보지 못한 채 누르는 승인은 승인이 아니다.
  // 이전에는 마켓플레이스 카드가 설치 명령을 클립보드에 복사만 해줘서, Desktop 사용자가
  // 터미널을 따로 열지 않으면 Hub 플러그인을 쓸 수 없었다.
  ipcMain.handle("mcpTools:previewHubPlugin", (_e, manifestUrl: string) =>
    previewHubPlugin(String(manifestUrl)),
  );
  ipcMain.handle(
    "mcpTools:installHubPlugin",
    (_e, input: { slug: string; manifestUrl: string; approveLocalExecution?: boolean }) =>
      installHubPlugin({
        slug: String(input?.slug ?? ""),
        manifestUrl: String(input?.manifestUrl ?? ""),
        approveLocalExecution: input?.approveLocalExecution === true,
      }),
  );
  // 자동 브리지가 등록해 두고 승인을 기다리는 stdio 서버. 실행 중 채팅에 한 줄 지나가는
  // needs-approval 영수증을 놓치면 사용자는 어디서 무엇을 켜는지 알 수 없었다.
  ipcMain.handle("mcpTools:pendingHubApprovals", () => listPendingHubPluginApprovals());
  /*
   * 원격 MCP OAuth.
   *
   * `authStatus` 는 이 서버가 무엇을 요구하는지 읽기만 한다(연결 시도 없음) — 화면이
   * "로그인 필요"인지 "이미 연결됨"인지 "인증 불필요"인지 말할 수 있어야 하기 때문이다.
   * `connect` 는 실제 인가 흐름을 돌린다. 값(토큰)은 이 채널로 오가지 않는다: 저장은
   * Keychain vault, 화면에는 성공 여부와 사람이 직접 열어야 할 URL만 돌려준다.
   */
  ipcMain.handle("mcpTools:oauthStatus", async (_e, serverId: string) => {
    const id = String(serverId ?? "");
    const server = getServer(id);
    if (!server || !server.url) return { supported: false as const, connected: false, reason: "not_remote" };
    const session = await readMcpOAuthSession(id);
    if (session) {
      return {
        supported: true as const,
        connected: true,
        resource: session.resource,
        expiresAt: session.expiresAt ?? null,
      };
    }
    try {
      const discovery = await discoverMcpOAuth(server.url);
      return discovery
        ? { supported: true as const, connected: false, resource: discovery.resource }
        : { supported: false as const, connected: false, reason: "no_authorization_required" };
    } catch (error) {
      return {
        supported: false as const,
        connected: false,
        reason: "discovery_failed",
        message: error instanceof Error ? error.message.slice(0, 240) : "discovery failed",
      };
    }
  });
  ipcMain.handle("mcpTools:oauthConnect", async (_e, serverId: string) => {
    const id = String(serverId ?? "");
    const server = getServer(id);
    if (!server?.url) return { ok: false as const, error: "this server has no remote URL to authorize" };
    try {
      const result = await authorizeMcpServer({ serverId: id, serverUrl: server.url });
      // 연결이 끝났으면 다음 실행부터 이 서버가 실려야 한다. 꺼져 있던 행을 켜 준다.
      if (!server.enabled) setServerEnabled(id, true);
      return { ok: true as const, manualUrl: result.manualUrl };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message.slice(0, 300) : "authorization failed",
      };
    }
  });
  ipcMain.handle("mcpTools:oauthDisconnect", async (_e, serverId: string) => {
    await forgetMcpOAuth(String(serverId ?? ""));
    return { ok: true as const };
  });
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
  // 허브 소개 페이지 임베드 — 원격 페이지라 preload/IPC를 붙이지 않는다(hub-profile-view 참고).
  ipcMain.handle(
    "marketplace:openProfileView",
    (_e, input: { slug: string; bounds: HubProfileBounds; locale?: "ko" | "en" }) =>
      openHubProfileView(input),
  );
  ipcMain.handle(
    "marketplace:setProfileViewBounds",
    (_e, bounds: HubProfileBounds) => setHubProfileViewBounds(bounds),
  );
  ipcMain.handle("marketplace:closeProfileView", () => closeHubProfileView());
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
  ipcMain.handle("marketplace:deleteMine", async (_e, slug: string) => {
    const source = getCargoSource();
    if (!source) throw new Error("Agent Cloud is not connected.");
    const result = await source.deleteMyAgent(String(slug ?? ""));
    invalidateMyAgentsCache();
    return result;
  });

  /*
   * Core CLI 를 부르는 오래 걸리는 작업에 붙이는 옵션 두 가지.
   *
   * 1) `noOpen: true` — Core `publish` 는 `--no-open` 없이는 `interactive=True` 로 돌고
   *    (`agentlas_cloud/cli.py:801`), 자기 토큰(`~/.agentlas/auth/<host>.json`)이 없으면
   *    브라우저 PKCE 로그인을 띄워 최대 180초 블록한다. 데스크탑은 이미 자기 세션으로
   *    로그인돼 있는데(safeStorage), 그 신원이 Core 로 전달되지 않는다. 그래서
   *    "데스크탑에서만 로그인한" 기계에서 Publish 를 누르면 난데없이 브라우저 OAuth 창이
   *    뜨거나 무응답 후 타임아웃했다(2026-07-28 확인). GUI 앱 안에서 CLI 가 제 브라우저를
   *    여는 것은 어느 쪽이든 옳지 않다 — 막고, 인증이 없으면 Core 가 정직하게 실패하게 한다.
   *
   * 2) `onStdout`/`onStderr` — `runHephaestus` 는 이 콜백을 옵션으로 갖고 있었는데
   *    **넘기는 호출부가 저장소 전체에 0곳**이었다. publish(300s)·securityScan(180s) 가
   *    종료 전까지 아무 신호도 안 줘서, 사용자는 도는 작업과 죽은 작업을 구분할 수 없었다.
   *    바로 위 업로드 진행(`cloudPublishProgressOptions`)이 같은 결함을 이미 한 번 겪었고
   *    같은 방식으로 고쳤다. 여기도 같은 채널 규약을 쓴다.
   */
  const coreProgressOptions = (event: IpcMainInvokeEvent, progressId: string | undefined) => {
    if (!progressId) return {};
    const win = BrowserWindow.fromWebContents(event.sender);
    const startedAt = Date.now();
    const emit = (stream: "stdout" | "stderr") => (line: string) => {
      if (!win || win.isDestroyed()) return;
      const text = line.trim();
      if (!text) return;
      try {
        win.webContents.send("hephaestus:progress", {
          progressId,
          stream,
          line: text.slice(0, 500),
          elapsedMs: Date.now() - startedAt,
        });
      } catch {
        /* window went away mid-run; the invoke result still resolves */
      }
    };
    return { onStdout: emit("stdout"), onStderr: emit("stderr") };
  };

  const corePublishOptions = (event: IpcMainInvokeEvent, progressId: string | undefined) => ({
    noOpen: true,
    ...coreProgressOptions(event, progressId),
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
      ...(input.confirmOverwrite ? { confirmOverwrite: true } : {}),
    }, cloudPublishProgressOptions(event, input.progressId));
  });
  ipcMain.handle("cloudAgents:publishRegisteredPublic", async (event, input: CloudAgentRegisteredPublishRequest) => {
    const source = registeredUploadRoot(input.target);
    return packageAndReviewCloudAgent({
      ...source,
      visibility: "marketplace",
      reviewMode: input.reviewMode,
      notes: input.notes,
      purposeAnswer: input.purposeAnswer,
      ...(input.confirmOverwrite ? { confirmOverwrite: true } : {}),
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

  // Pricing is a separate call from publishing on purpose: the agent is already
  // on the Hub by the time prices are set, so a pricing failure leaves a live
  // free listing rather than a failed publish.
  ipcMain.handle("cloudAgents:readPrices", async (_e, slug: string) => readAgentPrices(String(slug || "")));
  ipcMain.handle(
    "cloudAgents:setPrices",
    async (_e, input: { slug: string; patch: CloudAgentPricePatch }) =>
      setAgentPrices({ slug: String(input?.slug || ""), patch: input?.patch ?? {} }),
  );

  // ── firms (설치된 회사) ────────────────────────────────
  ipcMain.handle("firms:list", () => listFirms());
  ipcMain.handle("firms:get", (_e, id: string) => getFirm(id));
  ipcMain.handle("firms:install", (_e, slug: string) => installFirm(slug));
  ipcMain.handle("firms:uninstall", async (_e, id: string, options?: { removeMembers?: boolean; removeSource?: boolean }) => {
    const firm = getFirm(id);
    if (!firm) return { removed: false, sourceMovedToTrash: false };
    const sourceRoutes = [...new Set([firm.ceoAgentId, ...firm.orgChart.map((node) => node.agentId)])]
      .map((agentId) => getRoute(agentId))
      .filter((route): route is NonNullable<ReturnType<typeof getRoute>> => Boolean(route));
    const result = options?.removeMembers
      ? removeFirmFromRoster(id)
      : (uninstallFirm(id), { removedAgentIds: [], retainedAgentIds: [] });
    let sourceMovedToTrash = false;
    if (options?.removeSource) {
      const localPaths = [...new Set(sourceRoutes
        .filter((route) => route.source === "local-import" && fs.existsSync(route.path))
        .map((route) => route.path))];
      let moved = 0;
      for (const localPath of localPaths) {
        try {
          await shell.trashItem(localPath);
          moved += 1;
        } catch {
          // Keep the registry result truthful; a false flag means at least one
          // source folder could not be moved to Trash.
        }
      }
      sourceMovedToTrash = localPaths.length > 0 && moved === localPaths.length;
    }
    return {
      removed: true,
      sourceMovedToTrash,
      ...(result.retainedAgentIds.length > 0 ? { retainedAgentIds: result.retainedAgentIds } : {}),
    };
  });
  // 정규화된 3-tier 조직 스펙 조회 (저장된 리졸버 결과 또는 orgChart 파생)
  ipcMain.handle("firms:getResolvedOrg", (_e, id: string) => {
    const firm = getFirm(id);
    return firm ? getResolvedOrg(firm) : null;
  });
  // LLM으로 팀 폴더를 분석해 3-tier 조직 스펙 생성 (임포트 팀용)
  ipcMain.handle("firms:resolveOrg", (_e, id: string) => resolveTeamOrg(id));

  // ── Telegram Connect (Bot API polling + Agentlas invocation bridge) ─────
  ipcMain.handle("telegram:listBindings", () => listTelegramBindings());
  ipcMain.handle("telegram:connectOne", (_e, input?: { botName?: string; newConnection?: boolean }) => connectTelegramToOne(input ?? {}));
  ipcMain.handle("telegram:removeLegacy", (_e, input: { deleteBots?: boolean }) =>
    removeLegacyTelegramConnections({ deleteBots: input?.deleteBots === true }));
  ipcMain.handle("telegram:autoConnect", (_e, input) => autoConnectTelegram(input));
  ipcMain.handle("telegram:start", (_e, input) => startTelegramConnection(input));
  ipcMain.handle("telegram:clone", (_e, input) => cloneTelegramConnection(input));
  ipcMain.handle("telegram:importTerminal", (_e, id: string) => importTerminalTelegramConnection(id));
  ipcMain.handle("telegram:resume", (_e, id: string) => resumeTelegramConnection(id));
  ipcMain.handle("telegram:stop", (_e, id: string) => stopTelegramConnection(id));
  ipcMain.handle("telegram:remove", (_e, id: string, deleteBot?: boolean) => removeTelegramConnection(id, deleteBot === true));
  ipcMain.handle("telegram:resetConversation", (_e, id: string) => resetTelegramConversation(id));
  ipcMain.handle("telegram:sendTest", (_e, id: string) => sendTelegramTest(id));
  ipcMain.handle("telegram:openBot", (_e, id: string) => openTelegramBot(id));
  ipcMain.handle("telegram:configureBotSettings", (_e, id: string) => configureTelegramBotSettings(id));
  ipcMain.handle("telegram:pruneOrphans", () => pruneOrphanedTelegramBindings());

  // ── browser (자격증명 볼트 · 전용 프로필 · 승인 게이트 · 로그) ─
  // 동기 질문의 답 — confirm/ask-user.ts 의 대기 중인 약속을 깨운다.
  ipcMain.handle("confirm:listPendingAskUser", (event) => {
    // Pending question text is private: only the trusted Desktop top frame
    // may recover it after its event subscription (or renderer) restarts.
    assertTrustedSitePublishIpcSender(event);
    return listPendingAskUserRequests();
  });
  ipcMain.handle("confirm:submitAskUserAnswer", (_e, requestId: string, answer: string | null) =>
    submitAskUserAnswer(String(requestId), typeof answer === "string" ? answer : null),
  );
  ipcMain.handle("browser:status", () => getBrowserStatus());
  ipcMain.handle("browser:listSites", () => browserListSites());
  ipcMain.handle("browser:saveSite", (_e, input) => browserSaveSite(input));
  ipcMain.handle("browser:deleteSite", (_e, site: string) => browserDeleteSite(site));
  ipcMain.handle("browser:openLogin", (_e, site: string) => browserOpenLogin(site));
  ipcMain.handle("browser:markSession", (_e, site: string, status: "valid" | "expired" | "none") =>
    browserMarkSession(site, status),
  );
  // 평소 브라우저에서 이미 로그인된 도메인을 목록으로 주고(scan), 고른 것만 전용 프로필로
  // 가져온다(import). 가져오면 Connect 목록에 사이트로 올라가므로 주소를 손으로 칠 일이 없다.
  ipcMain.handle("browser:scanCredentials", (_e, profileId?: string | null) =>
    scanBrowserCredentials(typeof profileId === "string" ? profileId : null),
  );
  ipcMain.handle("browser:importCredentials", async (_e, profileId: string, domains: string[]) => {
    const id = String(profileId || "");
    const list = Array.isArray(domains) ? domains.map(String) : [];
    const result = await importBrowserCredentials(id, list);
    // 사용자가 실제로 가져온 그 선택이 곧 승인이다. 별도 동의 화면을 한 번 더 띄우지 않는다 —
    // 승인은 "묻는 순간"에 한 번(오너결정 2026-08-15), 그 뒤로는 이 집합만 자동 갱신한다.
    if (result.ok && result.linkedSites.length > 0) {
      // linkedSites 는 정규화된 사이트 문자열이고 스킴이 없을 수 있다("x.com"). new URL 에
      // 그대로 넣으면 던져서 승인 도메인이 통째로 빈 배열이 됐다 — 그러면 승인은 기록되는데
      // 자동 갱신은 영영 아무것도 하지 않는 반쪽 배선이 된다(실측으로 잡음).
      const loginRequired = new Set(result.requiresLoginSites ?? []);
      const granted = result.linkedSites
        .filter((site) => !loginRequired.has(site))
        .map((s) => {
          const raw = String(s || "").trim();
          if (!raw) return "";
          try {
            const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
            return new URL(withScheme).hostname.replace(/^www\./, "").toLowerCase();
          } catch {
            return "";
          }
        })
        .filter(Boolean);
      if (granted.length > 0) recordBrowserCredentialConsent(id, granted);
    }
    return result;
  });
  ipcMain.handle("browser:credentialConsent", () => ({
    consent: getBrowserCredentialConsent(),
    ...browserCredentialConsentIsPending(),
  }));
  ipcMain.handle("browser:revokeCredentialConsent", () => revokeBrowserCredentialConsent());
  // 주기를 기다리지 않고 지금 갱신. 사용자가 방금 어딘가에 새로 로그인했을 때 필요하고,
  // 자동 갱신과 **같은 코드 경로**를 쓰므로 이 버튼이 도는지가 곧 자동 갱신이 도는지다.
  ipcMain.handle("browser:refreshCredentials", async () => {
    await refreshBrowserCredentialsIfDue({ force: true });
    return getBrowserCredentialConsent();
  });
  ipcMain.handle("browser:listPermissions", () => browserListPermissions());
  ipcMain.handle("browser:revokePermission", (_e, site: string, actionType: string) =>
    browserRevokePermission(site, actionType),
  );
  ipcMain.handle("browser:resolveApproval", (_e, requestId: string, decision: BrowserPermissionDecision) =>
    browserResolveApproval(requestId, decision),
  );

  /*
   * 도구 승인 — 런타임이 승인을 필요로 하거나(live) 이미 자동 거부한(post-denial) 사실을
   * 화면으로 나른다. 예전에는 어느 쪽도 화면에 도달하지 않아, 사용자는 파일 편집은 되는데
   * 셸 명령만 조용히 안 되는 상태를 원인 없이 겪었다.
   */
  // 능력 규칙(capability grants) — "항상 허용"의 영구 원장. 대화 단위 "항상 승인"도
  // 여기로 이관됐다(renderer localStorage 폐지, 오너 결정 2026-08-20).
  /*
   * 데몬 자동 시작 토글. 설정과 부팅 동작이 어긋난 채 남지 않도록, 값을 바꾼 **직후**
   * 파일시스템(launchd/시작프로그램/systemd)을 같은 턴에 정합시킨다.
   */
  ipcMain.handle("daemon:getAutostart", async () => {
    const { getDaemonAutostartEnabled } = await import("./store/daemon-autostart");
    return { enabled: getDaemonAutostartEnabled() };
  });
  ipcMain.handle("daemon:setAutostart", async (_e, enabled: boolean) => {
    const { setDaemonAutostartEnabled, getDaemonAutostartEnabled } = await import("./store/daemon-autostart");
    setDaemonAutostartEnabled(false);
    try {
      const { reconcileDaemonAutostart } = await import("./daemon/app-launcher");
      // main.ts 부팅 경로와 **같은** 커맨드로 정합시킨다(경로가 갈리면 부팅 항목이 둘이 된다).
      reconcileDaemonAutostart(false, {
        executable: process.execPath,
        entry: path.join(__dirname, "daemon", "main.js"),
      });
    } catch (error) {
      // 값은 저장됐지만 부팅 항목을 못 고쳤다 — 조용히 성공이라고 말하지 않는다.
      return {
        enabled: getDaemonAutostartEnabled(),
        reconciled: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      enabled: getDaemonAutostartEnabled(),
      reconciled: true,
      requested: enabled === true,
      reason: enabled === true ? "desktop_runtime_is_app_scoped" : null,
    };
  });
  ipcMain.handle("capability:listGrants", (_e, scope?: string) => listCapabilityGrants(scope));
  ipcMain.handle("capability:revokeGrant", (_e, id: number) => revokeCapabilityGrant(Number(id)));
  ipcMain.handle("capability:listAlwaysApprovedChats", () => listAlwaysApprovedChatIds());
  ipcMain.handle("capability:grantChatAlwaysApproval", (_e, chatId: string) => {
    if (typeof chatId === "string" && chatId) grantChatAlwaysApproval(chatId.slice(0, 128), "chip");
    return listAlwaysApprovedChatIds();
  });
  ipcMain.handle("capability:revokeChatAlwaysApproval", (_e, chatId: string) => {
    if (typeof chatId === "string" && chatId) revokeChatAlwaysApproval(chatId.slice(0, 128));
    return listAlwaysApprovedChatIds();
  });
  ipcMain.handle("runtime:listToolApprovals", () => listPendingToolApprovals());
  ipcMain.handle("runtime:getToolApprovalResolution", (_e, id: string) =>
    getToolApprovalResolution(typeof id === "string" ? id.slice(0, 256) : ""),
  );
  ipcMain.handle("runtime:resolveToolApproval", (
    _e,
    id: string,
    decision: ToolApprovalDecision,
    actionId: string,
  ) =>
    resolveToolApproval(
      typeof id === "string" ? id.slice(0, 256) : "",
      decision,
      typeof actionId === "string" ? actionId.slice(0, 512) : "",
    ),
  );
  /*
   * ACP는 전수 조사에서 **유일하게 런타임이 실행 전에 묻는** 경로다
   * (`session/request_permission`). 그래서 여기만 진짜 live 승인이 성립한다.
   *
   * 결합은 import 가 아니라 주입이다 — acp 런타임은 이 계약 파일을 알지 못하고,
   * 등록되지 않으면 종전의 보수 기본값(read+mutating → 거절)으로 돈다.
   */
  /*
   * ★오너 결정(2026-08-15) — 승인 카드는 **경계를 넘을 때만, 묻는 순간, 그 대화 안에서**.
   * 실행에 준 권한 범위 안의 호출은 처음부터 풀어 둔다(묻지 않는다):
   *   full            → 전부 허용
   *   write + 변이     → 허용(세션) — 사용자가 write 를 골랐다는 뜻이 그것이다
   *   비변이(read/search/fetch/think) → 허용
   *   read + 변이      → 경계를 넘는 요청. 여기만 사용자에게 live 로 묻는다.
   * 헤드리스 CLI 들은 묻는 순간이 없어 같은 규칙을 spawn 플래그로 미리 준다
   * (claude/grok acceptEdits+allow, codex workspace-write, agy skip-permissions+sandbox).
   */
  /*
   * 사람이 방금 거부한 것을 같은 실행의 복구 패스가 곧바로 다시 묻지 않게 한다 — One 은
   * 도구 실패 흔적이 있으면 최대 2번 스스로 재시도하는데(완주 규범), 사용자의 "거부"는
   * 막힌 단계가 아니라 결정이다. 같은 도구·대상 거부는 짧게(5분) 기억해 조용히 거부한다.
   * 영구 기억은 아니다 — 다음 요청 때는 다시 묻는다.
   */
  const recentUserDenials = new Map<string, number>();
  const USER_DENIAL_TTL_MS = 5 * 60_000;
  const denialKey = (ask: { sessionKey: string; tool: string; detail?: string }) => `${ask.sessionKey}\u0000${ask.tool}\u0000${ask.detail ?? ""}`;

  const opaqueConsentIdentity = (label: string, value: string): string => {
    // Account ids, workspace paths, and agent names are Main-only material.
    // Approval events may cross into a renderer, so keep the binding exact but
    // value-free at that boundary and in the capability ledger.
    if (!value || value.length > 16 * 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`invalid capability consent ${label}`);
    }
    return `consent-id:v1:${label}:${createHash("sha256")
      .update(`agentlas-tool-consent-${label}-v1\u0000${value}`, "utf8")
      .digest("hex")}`;
  };

  /**
   * Main is the only authority that can mint a durable consent identity.  The
   * account id comes from the authenticated session when available; unsigned
   * local work is isolated to this install's user-data namespace.  Workspace
   * includes the exact working folder (or chat fallback), while requester is
   * stable across runtime restarts and excludes the ephemeral session key.
   */
  const consentBindingForAsk = (ask: {
    runtime: string;
    tool: string;
    detail?: string;
    cwd?: string;
    chatId?: string;
    agentId?: string;
    permission: "read" | "write" | "full" | undefined;
  }): ToolApprovalConsentBinding => {
    const actor = getAuthenticatedActorIds();
    const install = configuredIdentity();
    // Keep the supplied path bytes intact before canonicalizing `.`/`..`.
    // Unix permits leading/trailing spaces in a directory name; trimming here
    // would let two distinct workspaces inherit the same durable consent.
    const rawWorkspace = ask.cwd && ask.cwd.length > 0
      ? path.resolve(ask.cwd)
      : ask.chatId
        ? `chat:${ask.chatId}`
        : `desktop:${install?.userDataNamespace ?? "Agentlas"}`;
    const rawUser = actor
      ? `account:${actor.userId}`
      : `install:${install?.channel ?? "official"}:${install?.userDataNamespace ?? "Agentlas"}`;
    const rawWorkspaceIdentity = actor
      ? `account-workspace:${actor.workspaceId}|${rawWorkspace}`
      : rawWorkspace;
    const rawRequester = `runtime:${ask.runtime}|agent:${ask.agentId?.trim() || "default"}`;
    return {
      userIdentity: opaqueConsentIdentity("user", rawUser),
      workspaceIdentity: opaqueConsentIdentity("workspace", rawWorkspaceIdentity),
      requesterIdentity: opaqueConsentIdentity("requester", rawRequester),
      credentialResourceIdentity: capabilityResourceIdentity(ask.tool, ask.detail),
      permissionScope: ask.permission ?? "read",
    };
  };
  // ★한 벌뿐이다 — ACP 의 session/request_permission 과 우리 in-process 도구 루프
  // (ollama/lmstudio/mlx)가 **같은** 이 함수를 지난다. 정책을 두 벌 쓰면 갈라지고,
  // 갈라진 쪽은 반드시 "묻지 않고 실행"으로 기운다(local-tool-loop 이 실제로 그랬다).
  // "항상 허용" 칩의 영구 기록(capability_grants) — tool-approval.ts 는 store 를 모르므로
  // 여기서 주입한다(오너 결정 2026-08-20: 항상 허용은 다시는 묻지 않는다).
  setCapabilityGrantPersister((grant) => {
    if (!grant.consentBinding) return { ok: false, code: "missing-binding" };
    const result = recordCapabilityGrant({
      capability: grant.capability,
      pattern: grant.pattern,
      decision: "allow",
      // The store derives the full scope digest from all binding fields.  The
      // marker supplied by the runtime is intentionally not trusted here.
      scope: capabilityConsentScope(grant.consentBinding),
      source: "chip",
      tool: grant.tool,
      consentBinding: grant.consentBinding,
    });
    if (!result.ok) return { ok: false, code: result.code };
    return { ok: true, id: result.id };
  });
  setRuntimeToolPermissionArbiter(async (ask) => {
    /*
     * 저장된 능력 규칙이 최우선이다(deny > allow, chat > agent > global).
     * "항상 허용"으로 영구 부여된 행동은 권한 등급과 무관하게 통과하고,
     * 영구 거부된 행동은 full 권한으로도 뚫리지 않는다.
     */
    const capability = capabilityClassFor(ask.kind, ask.tool);
    let consentBinding: ToolApprovalConsentBinding;
    try {
      consentBinding = consentBindingForAsk(ask);
    } catch {
      // An invalid Main-owned identity must not turn into a broad legacy rule.
      return "deny";
    }
    const ruled = getCapabilityDecision({
      capability,
      tool: ask.tool,
      detail: ask.detail,
      agentId: ask.agentId,
      chatId: ask.chatId,
      consentBinding,
    });
    if (ruled === "deny") return "deny";
    if (ruled === "allow") return "allow_session";
    if (ask.permission === "full") return "allow_session";
    if (!ask.mutating) return "allow_once";
    if (ask.permission === "write") return "allow_session";
    const deniedAt = recentUserDenials.get(denialKey(ask));
    if (deniedAt && Date.now() - deniedAt < USER_DENIAL_TTL_MS) return "deny";
    /*
     * 대화가 붙어 있지 않은 실행(자동화/그래프/헤드리스)은 답할 사람이 없다 — 5분을
     * 매달아 두었다가 거부하는 대신 즉시 거부하고 사실만 남긴다(08-09 결정: 실행 중
     * 승인 게이트 없음. 승인은 만들 때 한 번).
     */
    if (!ask.chatId || ask.unattended) {
      announceToolDenied({
        sessionKey: ask.sessionKey,
        // 실제로 돈 런타임을 적는다. 예전엔 "acp"로 못 박혀 있어, 같은 중재자를
        // 쓰는 로컬 런타임의 거부까지 ACP 가 한 일로 기록될 뻔했다.
        runtime: ask.runtime,
        tool: ask.tool,
        detail: ask.detail,
        cwd: ask.cwd,
        deniedBy: "runtime-headless",
        consentBinding,
      });
      return "deny";
    }
    const outcome = await requestToolApproval({
      sessionKey: ask.sessionKey,
      runtime: ask.runtime,
      tool: ask.tool,
      detail: ask.detail,
      cwd: ask.cwd,
      chatId: ask.chatId,
      capability,
      agentId: ask.agentId,
      consentBinding,
    });
    if (outcome.decision === "deny") recentUserDenials.set(denialKey(ask), Date.now());
    // allow_always 는 tool-approval 이 이미 영속했다 — 러너 계약에는 세션 허용으로 답한다.
    return outcome.decision === "allow_always" ? "allow_session" : outcome.decision;
  });

  onToolApprovalRequested((request) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("runtime:toolApprovalRequest", request);
      } catch {
        // 화면 하나가 사라져도 실행 경계는 그대로다.
      }
    }
  });
  // A phone or another renderer can answer the same live card. Broadcast the
  // authoritative ledger receipt so stale cards disappear only after Main has
  // actually resolved (or expired) the runtime request.
  onToolApprovalResolved((id) => {
    const receipt = getToolApprovalResolution(id);
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("runtime:toolApprovalResolution", receipt);
      } catch {
        // One dead renderer cannot affect the runtime decision or other views.
      }
    }
  });
  ipcMain.handle("browser:listLogs", (_e, limit?: number) => browserListLogs(limit));
  ipcMain.handle("browser:captureLiveFrame", (event, preferredUrl?: string, viewport?: "desktop" | "phone") => {
    assertTrustedSitePublishIpcSender(event);
    return captureBrowserLiveFrame(
      typeof preferredUrl === "string" ? preferredUrl.slice(0, 2_048) : undefined,
      viewport === "phone" ? "phone" : "desktop",
    );
  });
  ipcMain.handle("browser:startLiveView", async (event, preferredUrl?: string, viewport?: "desktop" | "phone") => {
    assertTrustedSitePublishIpcSender(event);
    const ownerId = event.sender.id;
    if (!browserLiveCleanupOwners.has(ownerId)) {
      browserLiveCleanupOwners.add(ownerId);
      event.sender.once("destroyed", () => {
        browserLiveCleanupOwners.delete(ownerId);
        void stopBrowserLiveSessionsForOwner(ownerId);
      });
    }
    const scopedUrl = typeof preferredUrl === "string" ? preferredUrl.slice(0, 2_048) : "";
    return startBrowserLiveSession(ownerId, scopedUrl, viewport === "phone" ? "phone" : "desktop", (frame) => {
      if (!event.sender.isDestroyed()) event.sender.send("browser:liveFrame", frame);
    });
  });
  ipcMain.handle("browser:stopLiveView", (event, sessionId?: string) => {
    assertTrustedSitePublishIpcSender(event);
    return stopBrowserLiveSession(event.sender.id, typeof sessionId === "string" ? sessionId.slice(0, 128) : "");
  });
  ipcMain.handle("browser:dispatchLiveInput", (event, input: unknown) => {
    assertTrustedSitePublishIpcSender(event);
    return dispatchBrowserLiveInput(event.sender.id, input);
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
  ipcMain.handle(
    "projects:createFromWorkspace",
    (_e, input: { chatId: string; name: string; agentPool?: ProjectAgentPoolMember[] }) => {
      const chatId = typeof input?.chatId === "string" ? input.chatId.trim() : "";
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!chatId || !name) throw new TypeError("A chat and project name are required.");

      // The renderer never supplies a path here. Reuse only the folder that was
      // selected through a native grant and durably recorded by Main for this chat.
      const folderPath = getChatWorkingFolder(chatId);
      if (!folderPath) throw new Error("Choose a working folder before creating a project.");
      const normalizedFolder = path.resolve(folderPath);
      const existing = listProjects().find((project) =>
        project.folderPath && path.resolve(project.folderPath) === normalizedFolder,
      );
      if (existing) return existing;

      const created = createProject({
        name,
        sourceType: "local",
        sourceRef: null,
        agentPool: input.agentPool ?? [],
        folderPath,
      });
      void seedProjectMapInBackground(folderPath, name);
      return created;
    },
  );
  ipcMain.handle("projects:get", (_e, id: string) => getProject(id));
  ipcMain.handle("projects:timeline", (_e, id: string, limit?: number) =>
    getProjectTimelineSnapshot(id, limit),
  );
  ipcMain.handle(
    "projects:create",
    (_e, input: {
      name: string;
      systemPrompt?: string | null;
      agentPool?: ProjectAgentPoolMember[];
      sourceType: ProjectSourceType;
      sourceRef?: string | null;
      folderGrant?: FsPathGrant | null;
    }) => {
      const folderPath = input.folderGrant ? pathFromGrant(input.folderGrant, "directory") : null;
      const project = createProject({
        name: input.name,
        systemPrompt: input.systemPrompt,
        agentPool: input.agentPool,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        folderPath,
      });
      // Seed .agentlas as soon as the folder is known so the first turn already
      // has a project map. Runs in the background: creation must not block on it.
      if (folderPath) void seedProjectMapInBackground(folderPath, input.name);
      return project;
    },
  );
  ipcMain.handle(
    "projects:update",
    (
      _e,
      id: string,
      patch: Partial<Pick<Project, "name" | "systemPrompt" | "agentPool" | "sourceType" | "sourceRef">> & { folderGrant?: FsPathGrant | null },
    ) => updateProject(id, {
      name: patch.name,
      systemPrompt: patch.systemPrompt,
      agentPool: patch.agentPool,
      sourceType: patch.sourceType,
      sourceRef: patch.sourceRef,
      ...(patch.folderGrant !== undefined
        ? { folderPath: patch.folderGrant ? pathFromGrant(patch.folderGrant, "directory") : null }
        : {}),
    }),
  );
  ipcMain.handle("projects:remove", (_e, id: string) => removeProject(id));
  ipcMain.handle("projects:connectGithub", async (event, repositoryUrl: string) =>
    connectGithubProject(BrowserWindow.fromWebContents(event.sender), repositoryUrl));
  // Per-project rent consent (per-work-order RENT; owner decision 2026-08-18).
  // Desktop-local only — the server never learns which projects allow whom.
  ipcMain.handle("projects:listRentAllowed", (_e, projectId: string) =>
    listRentAllowedSlugs(String(projectId || "")));
  ipcMain.handle(
    "projects:setRentAllowed",
    (_e, input: { projectId: string; slug: string; allowed: boolean }) =>
      setRentAllowed(String(input?.projectId || ""), String(input?.slug || ""), input?.allowed === true),
  );

  // ── agent leases (day-based, prepaid; replaces the retired 24h auto-lease) ──
  ipcMain.handle("agentLeases:quote", (_e, slug: string) => getAgentLeaseQuote(String(slug || "")));
  ipcMain.handle(
    "agentLeases:purchase",
    (_e, input: { slug: string; days: number }) =>
      purchaseAgentLease({ slug: String(input?.slug || ""), days: Number(input?.days) }),
  );
  ipcMain.handle("agentLeases:list", () => listAgentLeasesCached());

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
  // One 화면 전용 — 전체 최근 목록을 잘라 쓰면 Work 대화가 One 대화를 밀어낸다.
  ipcMain.handle("chats:listRecentOne", (_e, limit?: number) => listRecentOneChats(limit));
  ipcMain.handle("chats:listArchived", () => listArchivedChats());
  ipcMain.handle("chats:archive", (_e, id: string) => archiveChat(id));
  ipcMain.handle("chats:unarchive", (_e, id: string) => unarchiveChat(id));
  ipcMain.handle("chats:listByProject", (_e, projectId: string) =>
    listChatsByProject(projectId),
  );
  ipcMain.handle("chats:listByFirm", (_e, firmId: string) => listChatsByFirm(firmId));
  ipcMain.handle("chats:get", (_e, id: string) => {
    const chat = getChat(id);
    return chat ? repairRootChatSurfaceController(chat) : null;
  });
  ipcMain.handle(
    "chats:create",
    (
      _e,
      input: {
        agentId?: string;
        firmId?: string | null;
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
  ipcMain.handle(
    "chats:openOneMember",
    (_e, input: { agentId: string; title: string }) =>
      getOrCreateOneMemberChat(input.agentId, input.title),
  );
  ipcMain.handle("chats:appendOneUserMessage", (_e, id: string, rawText: string) => {
    const chat = getChat(id);
    if (!chat || chat.originSurface !== "one") throw new Error("One conversation not found.");
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text || text.length > 12_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error("One conversation message is invalid.");
    }
    return appendChatMessage(id, "user", text);
  });
  ipcMain.handle("chats:rename", (_e, id: string, title: string) => renameChat(id, title));
  ipcMain.handle("chats:remove", (_e, id: string) => {
    // Renderer의 busy 표시는 투영일 뿐이다. 삭제 권위인 Main이 terminal event가 끝날
    // 때까지 채팅 행을 보존해, 실행 결과가 사라진 대화에 기록되는 race를 막는다.
    assertChatRemovalAllowed(id, invocationService.activeChatIds());
    removeChat(id);
  });
  // 세션 recap — 자리를 비운 사이 도착한 에이전트 응답 한 줄 요약(없으면 null).
  ipcMain.handle("chats:recap", (_e, id: string) => buildChatRecap(id, currentUiLocale() === "ko" ? "ko" : "en"));
  ipcMain.handle("chats:markViewed", (_e, id: string) => {
    markChatRecapViewed(id);
  });
  ipcMain.handle("chats:setContinuousMode", (_e, id: string, enabled: boolean) => {
    setChatContinuousMode(id, enabled);
    return getChat(id);
  });
  /*
   * 목표 추진 칩 — 켜면 단순 프롬프트 접두사가 아니라 persistent goal이 된다:
   * ① goal_ledger 축(goal_id)을 chat에 바인딩(대화가 Task로 승격돼도 축 불변),
   * ② goal 원장 행 생성(best-effort — 첫 goal 전송이 objective를 최신 문장으로 채움),
   * ③ continuousMode 자동 ON(완성까지 계속 도는 루프가 기본).
   * 끄기(칩 ×)는 단순 off가 아니라 **명시적 목표 종료**다: 원장 cancelled, 이
   * goal의 연속실행 자동화 정확히 한 행 비활성화, 바인딩 해제.
   * 원장 호출은 fail-soft(런타임 없으면 조용히 생략)이며 UI 응답을 막지 않는다.
   */
  ipcMain.handle("chats:setGoalMode", (_e, id: string, enabled: boolean) => {
    const chat = getChat(id);
    if (!chat) throw new Error(`Chat not found: ${id}`);
    if (enabled) {
      const task = getCanonicalTaskForChat(id);
      // 프로젝트 대화의 목표는 프로젝트에 붙는다. 여기서 대화 단위로 파생해 두면
      // 실행 경로가 프로젝트 편성을 물려받으려 해도 이 값이 먼저 이겨서 무효가 된다.
      const goalId = chat.goalId ?? resolveDesktopWorkforceGoalId({
        projectId: chat.projectId,
        taskId: task?.id,
        chatId: id,
      });
      setChatGoalBinding(id, goalId);
      setChatContinuousMode(id, true);
      // Binding is not definition. The next explicit Goal-mode request owns
      // the objective; a chat title is only navigation copy and must never
      // become (or later overwrite) the user's durable goal.
    } else if (chat.goalId) {
      const continuation = findAutomationByGoalId(chat.goalId);
      if (continuation?.enabled) toggleAutomation(continuation.id, false);
      void completeGoalLedgerGoal({
        goalId: chat.goalId,
        status: "cancelled",
        reason: "user-ended-goal-chip",
        projectDir: getChatWorkingFolder(id),
      });
      setChatGoalBinding(id, null);
    }
    return getChat(id);
  });
  ipcMain.handle("chats:getGoalContext", async (_e, id: string) => {
    const chat = getChat(id);
    if (!chat?.goalId) return null;
    return getGoalLedgerGoal(chat.goalId, getChatWorkingFolder(id));
  });
  ipcMain.handle("chats:defineGoal", async (_e, id: string, objective: string, requestedLocale?: "ko" | "en") => {
    const chat = getChat(id);
    if (!chat?.goalId) return null;
    const projectDir = getChatWorkingFolder(id);
    const existing = await getGoalLedgerGoal(chat.goalId, projectDir);
    // An active contract with criteria is immutable. Ordinary chat and
    // steering can never call this endpoint to silently replace it.
    if (existing?.status === "active" && existing.acceptanceCriteria.length > 0) return existing;
    const normalizedObjective = objective.replace(/\s+/g, " ").trim();
    if (!normalizedObjective) return existing;
    const locale = requestedLocale === "ko" || requestedLocale === "en"
      ? requestedLocale
      : currentUiLocale() === "ko" ? "ko" : "en";
    await ensureGoalLedgerGoal({
      goalId: chat.goalId,
      objective: normalizedObjective,
      acceptanceCriteria: deriveGoalAcceptanceCriteria(normalizedObjective, locale),
      projectDir,
    });
    return getGoalLedgerGoal(chat.goalId, projectDir);
  });
  ipcMain.handle("chats:resumeGoal", async (_e, id: string, expectedVersion: number) => {
    const chat = getChat(id);
    if (!chat?.goalId) return null;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
      throw new TypeError("A current long-run version is required to resume");
    }
    const context = await getGoalLedgerGoal(chat.goalId, getChatWorkingFolder(id));
    if (!context || context.version !== expectedVersion) {
      throw new Error("long_run_resume_version_conflict");
    }
    const continuation = findAutomationByGoalId(chat.goalId);
    if (!continuation) {
      if (invocationService.activeChatIds().includes(id)) throw new Error("auto_goal_resume_chat_busy");
      const { request, queued } = queueAutomaticGoalResume(id, expectedVersion);
      try {
        confirmDesktopLongRunResumeDispatched(queued.id);
        invocationService.start(request);
      } catch (error) {
        failDesktopLongRunResumeDispatch(queued.id, error instanceof Error ? error.message : String(error));
        throw error;
      }
      return getGoalLedgerGoal(chat.goalId, getChatWorkingFolder(id));
    }
    const queued = resumeDesktopLongRunManually(context.runId, expectedVersion);
    try {
      if (!continuation.enabled) toggleAutomation(continuation.id, true);
      const { enqueueAutomationRunNow } = await import("./automation-scheduler");
      const accepted = enqueueAutomationRunNow(continuation.id);
      if (!accepted.accepted) throw new Error("long_run_resume_dispatch_rejected");
      confirmDesktopLongRunResumeDispatched(queued.id);
    } catch (error) {
      failDesktopLongRunResumeDispatch(queued.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return getGoalLedgerGoal(chat.goalId, getChatWorkingFolder(id));
  });
  ipcMain.handle("chats:setSwarmMode", (_e, id: string, enabled: boolean) => {
    setChatSwarmMode(id, enabled);
    return getChat(id);
  });
  ipcMain.handle(
    "chats:setRuntimeSelection",
    (_e, id: string, selection: RuntimeSelection | null) =>
      setChatRuntimeSelection(id, selection),
  );
  ipcMain.handle("externalCliSessions:list", (_e, input?: { projectId?: unknown; query?: unknown; limit?: unknown }) =>
    listExternalCliSessions({
      projectId: typeof input?.projectId === "string" ? input.projectId : "",
      query: typeof input?.query === "string" ? input.query : "",
      limit: Math.min(Math.max(Number(input?.limit) || 60, 1), 100),
    }));
  ipcMain.handle("externalCliSessions:importToProject", (_e, input: unknown) =>
    importExternalCliSession(input as Parameters<typeof importExternalCliSession>[0]));
  ipcMain.handle("tasks:createProject", (_e, input: { projectId: string; title?: string }): CanonicalTaskWorkTarget => {
    if (!input || typeof input.projectId !== "string" || !input.projectId.trim()) {
      throw new TypeError("Project is required");
    }
    const project = getProject(input.projectId);
    if (!project) throw new Error("Project is unavailable");
    const projectController = listInstalledAgents().find((agent) => agent.slug === "agentlas-orchestrator");
    if (!projectController) throw new Error("Project orchestrator is unavailable");
    const chat = createChat({
      projectId: project.id,
      // Project work is owned by the project and the built-in task
      // orchestrator. Saved agents and teams remain reusable tools in the
      // project's pool; the first row is not promoted to session owner.
      agentId: projectController.id,
      title: typeof input.title === "string" && input.title.trim()
        ? input.title.trim().slice(0, 200)
        : "New task",
      taskMode: "task",
      originSurface: "work",
    });
    // A project task starts in the project's exact source context. The path was
    // already granted/validated by the Main-owned project source flow, so the
    // renderer never has to guess or ask the user to reconnect it per task.
    if (project.folderPath) setChatWorkingFolder(chat.id, project.folderPath);
    const task = getCanonicalTaskForChat(chat.id);
    if (!task) throw new Error("Project task could not be prepared");
    return { taskId: task.id, chatId: chat.id, title: task.title };
  });
  ipcMain.handle("tasks:list", (_e, input?: { projectId?: string; limit?: number; includeArchived?: boolean; reconcile?: boolean }) =>
    listCanonicalTasks(input),
  );
  ipcMain.handle("tasks:get", (_e, id: string) => getCanonicalTask(id));
  ipcMain.handle("tasks:listProjections", (_e, input) =>
    oneTaskProjectionRuntime.listProjections(input));
  ipcMain.handle("tasks:getProjection", (_e, id: string, input) =>
    oneTaskProjectionRuntime.getProjection(id, input));
  // One 의 "Work 에서 열기" 는 지금까지 렌더러가 projection 에서 조립한 URL 로만
  // 이동했다. openInWork 브리지는 인터페이스에 선언만 되어 있고 IPC·preload·main
  // 어디에도 구현이 없어 분기가 항상 false 였다(=죽은 코드). Main 이 Task 와 그
  // 대화가 실제로 존재하는지 확인한 목적지를 돌려주고, 렌더러는 그걸로만 이동한다.
  ipcMain.handle("tasks:openInWork", (_e, taskId: string): CanonicalTaskWorkTarget | null => {
    if (typeof taskId !== "string" || !taskId.trim()) return null;
    const task = getCanonicalTask(taskId);
    // Work is project-first. A projectless One conversation may become a
    // durable Task, but it must stay in One instead of reappearing as a global
    // Work chat with no source, team, or project identity.
    if (!task?.originChatId || !task.projectId) return null;
    const chat = getChat(task.originChatId);
    // 대화가 지워졌으면 목적지가 없다. null 을 돌려 렌더러가 조용히 죽은 링크로
    // 보내지 않게 한다 — 없는 곳으로 이동시키는 것보다 못 여는 게 정직하다.
    if (!chat || chat.projectId !== task.projectId || !getProject(task.projectId)) return null;
    return { taskId: task.id, chatId: chat.id, title: chat.title ?? task.title ?? "" };
  });
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
    // The canonical Task acceptance above is the authoritative user action.
    // Value Closure and its downstream projections are derived records: an
    // older Task whose title once changed its timestamp may not have an exact
    // result-ready event for that metadata version. Never reject the already
    // committed acceptance and leave Work stuck on "Completing…".
    let closure: ReturnType<typeof ensureAcceptedResultValueClosure> | null = null;
    try {
      closure = ensureAcceptedResultValueClosure({
        priorTaskVersion: input.expectedVersion,
        acceptedTask: accepted,
        expectedRunId: input.expectedRunId,
        receipt,
        confirmedByUser: true,
      });
    } catch {
      // Derived evidence remains absent when its exact historical binding
      // cannot be reconstructed. The canonical acceptance is still durable.
    }
    if (closure) {
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
        // Memory review is optional.
      }
      try {
        const hostId = loadOrCreateMobileBridgeHostIdentity(userDataDir()).hostId;
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
        // Ecosystem growth is optional.
      }
      try {
        tryCompleteOneActivationFirstValue({
          taskId: accepted.id,
          expectedTaskVersion: accepted.version,
          valueClosureId: closure.value.closure.valueClosureId,
          expectedValueClosureVersion: closure.value.version,
        });
      } catch {
        // First-use activation is optional.
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
        // Compounding evidence is optional.
      }
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
  ipcMain.handle("oneProfile:get", () => getOneProfile());
  ipcMain.handle("oneProfile:update", (_e, input: OneProfileUpdateInput) => updateOneProfile(input));
  /*
   * One 자신의 초상(생성·업로드 이미지). 팀원과 같은 창에서 같은 방식으로 고르므로,
   * 저장하는 길도 있어야 한다 — 없으면 그 창에서 One 만 두 탭이 사라진다.
   * 이미지는 먼저 디스크에 쓰고, 그다음 프로필이 그 자리를 가리키게 한다. 순서를 뒤집으면
   * 저장이 실패했을 때 프로필만 없는 그림을 가리킨다.
   */
  ipcMain.handle("oneProfile:setAvatarImage", (_e, input: { dataUrl: string; expectedVersion: number }) => {
    const decoded = decodeOneTeamAvatarDataUrl(String(input?.dataUrl ?? ""));
    writeOneSelfAvatar(decoded);
    return updateOneProfile({
      expectedVersion: Number(input?.expectedVersion),
      patch: { avatarIcon: ONE_SELF_AVATAR_ICON },
    });
  });
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
  ipcMain.handle("oneActivation:getState", (_e, input) => getOneActivationState(input));
  ipcMain.handle("oneActivation:resolveConcern", (_e, input) => resolveOneActivationConcern(input));
  ipcMain.handle("oneActivation:resolveWork", (_e, input) => resolveOneActivationWork(input));
  ipcMain.handle("oneActivation:skip", (_e, input) => skipOneActivation(input));
  ipcMain.handle("oneActivation:resolveMobile", (_e, input) => resolveOneActivationMobile(input));
  ipcMain.handle("oneMemory:getState", () => getOneMemoryState());
  ipcMain.handle("oneMemory:getMap", () => getOneMemoryMap());
  ipcMain.handle("oneMemory:listEntries", (_e, input?: { limit?: number }) => listOneDurableMemoryEntries(input?.limit));
  ipcMain.handle("oneMemory:forgetEntry", (_e, input: { memoryId: string }) => forgetOneDurableMemoryEntry(input?.memoryId));
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
  ipcMain.handle(
    "oneAutoRecovery:judge",
    async (_e, input: { runId?: string; chatId?: string; goal?: string; attemptsSpent?: number; previousFingerprint?: string | null }) => {
      const runId = String(input?.runId ?? "");
      const chatId = String(input?.chatId ?? "");
      if (!runId || !chatId) return null;
      // Main owns the receipt. Bind the judgment to the thread the renderer is
      // displaying so a run id from another conversation cannot expose its
      // failure evidence or spend a recovery judgment.
      const receipt = invocationService.receipt(runId);
      if (!receipt || receipt.chatId !== chatId) return null;
      const { judgeOneAutoRecovery } = await import("./one/auto-recovery");
      const result = await judgeOneAutoRecovery({
        receipt,
        goal: typeof input?.goal === "string" ? input.goal.slice(0, 4_000) : "",
        attemptsSpent: Number.isSafeInteger(input?.attemptsSpent) ? Math.max(0, input!.attemptsSpent!) : 0,
        previousFingerprint: typeof input?.previousFingerprint === "string" ? input.previousFingerprint : null,
      });
      return {
        ...(result.decision.retry
          ? { retry: true as const, attempt: result.decision.attempt }
          : { retry: false as const, reason: result.decision.reason }),
        fingerprint: result.fingerprint,
        diagnosis: result.diagnosis,
        decidedBy: result.decidedBy,
      };
    },
  );
  ipcMain.handle(
    "oneAutoRecovery:verify",
    async (_e, input: {
      originalRunId?: string;
      recoveryRunId?: string;
      chatId?: string;
      goal?: string;
      attemptsSpent?: number;
    }) => {
      const { verifyOneRecoveryOutcome } = await import("./one/recovery-verification");
      return verifyOneRecoveryOutcome({
        originalRunId: String(input?.originalRunId ?? ""),
        recoveryRunId: String(input?.recoveryRunId ?? ""),
        chatId: String(input?.chatId ?? ""),
        goal: typeof input?.goal === "string" ? input.goal : "",
        attemptsSpent: Number.isSafeInteger(input?.attemptsSpent) ? Math.max(0, input!.attemptsSpent!) : 0,
      });
    },
  );
  ipcMain.handle("oneValueClosure:getState", () => getOneValueClosureState());
  ipcMain.handle("oneValueClosure:latestForTask", (_e, taskId: string) =>
    getLatestOneValueClosure(taskId));
  ipcMain.handle("oneValueClosure:setReflection", (_e, input: SetOneValueClosureReflectionInput) =>
    setOneValueClosureReflection(input));
  ipcMain.handle("oneWeeklyReflection:get", () => {
    // Async pre-pass: warm completion-claim judgments for the stored closure
    // statements the synchronous reflection builder peeks (miss = regex fallback).
    // 폴 경로(5초 틱)에서 LLM 판정을 기다리면 핸들러가 최대 4초 막힌다 — 웜업은
    // 백그라운드로 흘리고 스냅샷은 즉시 반환한다(판정은 다음 폴부터 반영, 문장별
    // 메모이즈라 중복 추론 없음).
    const statements = getOneValueClosureState().closures
      .flatMap((record) => record.closure.valueItems
        .filter((item): item is Extract<typeof item, { kind: "fact" }> => item.kind === "fact")
        .map((item) => item.statement))
      .slice(0, 24);
    void prejudgeCompletionClaims(statements, { timeoutMs: 4_000 }).catch(() => undefined);
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
  // 브리핑 탐지는 프로젝트별 lstat·자동화별 이력 조회를 동반하는 비싼 스윕이다.
  // 5초 폴링이 그대로 때리지 않게 10초 캐시를 두고, 사용자 행동(openTask)은
  // 즉시 무효화한다. 탐지 지연 10초는 프로액티브 브리핑 표면에서 체감 불가.
  let oneBriefingSnapshotCache: { at: number; snapshot: ReturnType<typeof getOneBriefingSnapshot> } | null = null;
  ipcMain.handle("oneBriefing:get", () => {
    if (oneBriefingSnapshotCache && Date.now() - oneBriefingSnapshotCache.at < 10_000) {
      return oneBriefingSnapshotCache.snapshot;
    }
    const snapshot = getOneBriefingSnapshot();
    oneBriefingSnapshotCache = { at: Date.now(), snapshot };
    return snapshot;
  });
  ipcMain.handle("oneBriefing:openTask", (_e, input: OpenOneBriefingTaskInput) => {
    oneBriefingSnapshotCache = null;
    return resolveOneBriefingTaskNavigation(input);
  });
  ipcMain.handle("oneRequestIntent:resolve", async (_e, prompt: unknown) => {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4_000) {
      throw new TypeError("Invalid One request-intent prompt");
    }
    const resolved = await resolveOneRequestIntent(prompt, { timeoutMs: 4_000 });
    return { intent: resolved.intent, source: resolved.source };
  });
  ipcMain.handle("oneTeamPreflight:prepare", (_e, input: PrepareOneTeamPreflightInput) =>
    prepareOneTeamPreflight(input));
  ipcMain.handle("oneTeamPreflight:getForChat", (_e, chatId: string) =>
    getOneTeamPreflightForChat(chatId));
  ipcMain.handle("oneTeamPreflight:autoResolve", (_e, input: AutoResolveOneTeamPreflightInput) =>
    autoResolveOneTeamPreflight(input));
  ipcMain.handle("oneTeamPreflight:resolve", (_e, input: ResolveOneTeamPreflightInput) =>
    resolveOneTeamPreflight(input));
  ipcMain.handle("oneTeamPreflight:acknowledge", (_e, input) =>
    acknowledgeOneTeamPreflight(input));
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
    // ★켜기 게이트. 저장은 언제나 허용하되, **연결이 빠진 채로는 켜지 않는다.**
    // 업계 합의(create-then-gate): Zapier "you will not be able to turn it on",
    // n8n "Please resolve outstanding issues before you activate it",
    // Power Automate `ConnectionAuthorizationFailed`.
    // 이 검사가 없으면 사용자는 아무것도 모른 채 켜고 새벽에 조용히 죽는다(실사용 실측).
    if (enabled) {
      const automation = getAutomation(id);
      if (automation?.graph) {
        const { reportGraphConnections } = require("./workflow/tool-inventory") as typeof import("./workflow/tool-inventory");
        const report = await reportGraphConnections(
          automation.graph,
          currentUiLocale() === "en" ? "en" : "ko",
        );
        if (!report.activation.canActivate) {
          const error = new Error(report.activation.reason) as Error & {
            code?: string; nextAction?: string;
          };
          error.code = "AUTOMATION_NOT_CONNECTED";
          error.nextAction = report.activation.nextAction;
          throw error;
        }
      }
    }
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
  // ★실패의 물증 — 실행 창(ranAt±10분)에 cua-driver가 저장한 화면 캡처를 그 실행의
  // 증거로 돌려준다. 실측 2026-08-19: 모델이 "글자수 초과"를 지어내는 동안 진짜
  // 원인(중복 차단으로 비활성화된 Reply 버튼)은 이미 캡처에 찍혀 있었다 — 디스크에만
  // 있고 화면엔 없었을 뿐이다. 지어낸 사유 대신 이 파일을 보여준다.
  ipcMain.handle("automations:runCaptures", (_e, ranAtIso: string, limit?: number) => {
    try {
      const dir = path.join(os.homedir(), ".agentlas", "captures", "screen");
      if (!fs.existsSync(dir)) return [];
      const anchor = Date.parse(String(ranAtIso || ""));
      if (!Number.isFinite(anchor)) return [];
      const windowMs = 10 * 60 * 1000;
      return fs.readdirSync(dir)
        .filter((name) => name.startsWith("screen-") && name.endsWith(".png"))
        .map((name) => {
          const stamp = name.slice(7, 31).replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z");
          const at = Date.parse(stamp);
          return { name, at, path: path.join(dir, name) };
        })
        .filter((row) => Number.isFinite(row.at) && Math.abs(row.at - anchor) <= windowMs)
        .sort((a, b) => a.at - b.at)
        .slice(0, Math.max(1, Math.min(limit ?? 3, 6)))
        // dev 렌더러는 http 오리진이라 file:// 이미지가 막힌다 — dataURL로 전달한다.
        // 호출은 카드 확장 시 1회뿐이고 상한 6장이라 페이로드는 유한하다.
        .map((row) => ({
          name: row.name,
          at: new Date(row.at).toISOString(),
          dataUrl: `data:image/png;base64,${fs.readFileSync(row.path).toString("base64")}`,
        }));
    } catch {
      return [];
    }
  });
  // 확인필요 카드 닫기 — 기록은 남기고 "지금 조치하라"는 요구만 끈다.
  ipcMain.handle("automations:acknowledgeRun", (_e, id: string, runId: string) =>
    acknowledgeAutomationRun(id, runId));
  // 실행 id 없이 "지금까지의 확인 요구"를 전부 닫는다 — 어떤 카드든 끝낼 수 있는 행동.
  ipcMain.handle("automations:acknowledgeAttention", (_e, id: string) => {
    const { acknowledgeAutomationAttention } = require("./store/automations") as
      typeof import("./store/automations");
    return acknowledgeAutomationAttention(id);
  });
  ipcMain.handle("automations:listTriggerAttention", (_e, automationId: string) =>
    listTriggerEventAttention(automationId),
  );
  ipcMain.handle(
    "automations:reconcileTriggerEvent",
    (_e, input: AutomationTriggerEventReconcileInput) => {
      reconcileParkedTriggerEvent(input);
      return {
        eventId: input.eventId,
        automationId: input.automationId,
        resolution: input.resolution,
        status: input.resolution === "completed" ? "delivered" as const : "pending" as const,
      };
    },
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
        void runAutomationNow(
          result.automationId,
          result.simulation ? { dryRun: true } : undefined,
        ).catch((error) => {
          console.error(`[automation] reconciled graph resume failed (${result.automationId}):`, error);
        });
      }
      return result;
    },
  );
  ipcMain.handle("automations:updateGraph", (_e, id: string, graph: WorkflowGraph | null) => {
    const saved = updateAutomationGraph(id, graph);
    /* ★고친 그래프가 바깥으로 나가게 됐으면 권한도 따라 올라간다.
       내리지는 않는다 — 넓혀 둔 것은 사람이 그렇게 정했을 수 있고, 좁히는 쪽이
       "어제까지 되던 게 오늘 안 됨"을 만든다. 올리는 쪽만 자동이다. */
    if (graph && requiredExecutionPermission(graph) === "write") {
      const current = getAutomation(id);
      if (current && current.executionPermission !== "write") {
        return updateAutomation(id, { executionPermission: "write" });
      }
    }
    return saved;
  });

  // ★저장된 판으로 되돌리기 — 저장이 덮어쓰기뿐이라 잘못 저장하면 돌아갈 자리가 없었다.
  ipcMain.handle("automations:listGraphVersions", (_e, id: string) => listGraphVersions(id));
  ipcMain.handle("automations:restoreGraphVersion", (_e, id: string, versionId: string) => {
    try {
      const automation = restoreGraphVersion(id, versionId);
      return {
        ok: true as const,
        automationId: automation.id,
        versionId,
        automation,
      };
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : "restore_failed" };
    }
  });

  // ── 그래프를 Hub에 올리고, Hub에서 받아 설치한다 ──────────────────────────
  //
  // ★두 방향 모두 **미바인딩**을 정직하게 말한다. 발행은 무엇을 지웠는지,
  //   설치는 무엇이 비어 있는지 돌려준다. "됐습니다"만 말하면 사람은 돈다고 믿는다.
  // 도는 실행을 사람이 멈춘다. 멈출 것이 없으면 그대로 false — 멈춘 척하지 않는다.
  ipcMain.handle("automations:stopRun", (_e, id: string) => {
    const { stopAutomationRun } = require("./automation-scheduler") as typeof import("./automation-scheduler");
    return { ok: true as const, stopped: stopAutomationRun(String(id || "").trim()) };
  });

  ipcMain.handle("automations:publishGraph", async (_e, id: string, opts?: { version?: string }) => {
    const automation = getAutomation(id);
    if (!automation) throw new Error(`Automation not found: ${id}`);
    if (!automation.graph) {
      return { ok: false as const, reason: "이 자동화에는 아직 그래프가 없습니다." };
    }
    const { publishGraphToHub } = await import("./cloud-agents/graph-publish");
    return publishGraphToHub({
      automation,
      graph: automation.graph,
      ...(opts?.version ? { version: opts.version } : {}),
    });
  });

  ipcMain.handle("automations:fetchGraphFromHub", async (_e, slug: string) => {
    const { fetchGraphFromHub } = await import("./cloud-agents/graph-publish");
    return fetchGraphFromHub(String(slug || "").trim());
  });

  ipcMain.handle("automations:installGraphFromHub", async (_e, slug: string, opts?: { name?: string }) => {
    const { fetchGraphFromHub } = await import("./cloud-agents/graph-publish");
    const fetched = await fetchGraphFromHub(String(slug || "").trim());
    if (!fetched.ok || !fetched.package) return fetched;
    const pkg = fetched.package;
    const name = (opts?.name || pkg.manifest.name || slug).trim();
    // 같은 이름이 이미 있으면 덮어쓰지 않는다 — 남의 작업을 지우는 설치는 없다.
    if (listAutomations().some((row) => row.name === name)) {
      return { ok: false as const, reason: `"${name}" 이름의 자동화가 이미 있습니다.` };
    }
    const created = createAutomation({
      name,
      scheduleHuman: pkg.manifest.trigger.schedule || "수동 실행",
      // 슬롯은 비운 채로 만든다. 받는 사람이 채우기 전에 도는 것이 가장 나쁘다.
      targetType: "agent",
      targetId: "",
      promptTemplate: "",
      graphJson: pkg.graph,
      createdBy: "user",
      // 받는 사람이 슬롯을 채우기 전에 도는 것이 가장 나쁘다 — 꺼진 채로 설치한다.
      enabled: false,
      ...(pkg.manifest.trigger.schedule ? { scheduleJson: pkg.manifest.trigger.schedule } : {}),
      // 입력 트리거는 그래프의 트리거 노드가 들고 있다(TriggerKind에 input은 없다).
      ...(pkg.manifest.trigger.kind === "cron" ? { triggerType: "schedule" as const } : {}),
    });
    return {
      ok: true as const,
      automationId: created.id,
      name,
      bindings: fetched.bindings ?? [],
      ...(fetched.packageHash ? { packageHash: fetched.packageHash } : {}),
    };
  });
  // 그래프 변경 제안 — 평가만 한다. 적용은 사용자가 diff를 보고 누른 뒤 별도 호출로만.
  // 모델 출력이 저장된 그래프에 직접 닿는 경로는 만들지 않는다(설계 D8).
  const evaluatePatchFor = (id: string, patch: unknown) => {
    const automation = getAutomation(id);
    if (!automation) throw new Error(`Automation not found: ${id}`);
    if (!automation.graph) {
      return {
        ok: false as const,
        code: "PATCH_NO_GRAPH",
        reason: "이 자동화에는 아직 고칠 그래프가 없습니다.",
        nextAction: "먼저 그래프를 만든 뒤 다시 요청해 주세요.",
      };
    }
    const { evaluateGraphPatch } = require("./workflow/graph-patch") as typeof import("./workflow/graph-patch");
    const parsed = patch && typeof patch === "object" ? (patch as { ops?: unknown; rationale?: string }) : null;
    const ops = Array.isArray(parsed?.ops) ? parsed!.ops : [];
    return {
      automation,
      decision: evaluateGraphPatch(automation.graph, {
        ops: ops as never,
        ...(parsed?.rationale ? { rationale: parsed.rationale } : {}),
      }),
    } as const;
  };

  // 사용자의 한 문장 → 변경 제안. 여기서도 **적용은 하지 않는다**.
  ipcMain.handle("automations:requestGraphPatch", async (_e, id: string, request: string) => {
    const automation = getAutomation(id);
    if (!automation) throw new Error(`Automation not found: ${id}`);
    const sentence = String(request ?? "").trim();
    if (!sentence) {
      return { ok: false as const, code: "ARCHITECT_NO_REQUEST", reason: "무엇을 바꿀지 알려주세요.", nextAction: "고치고 싶은 내용을 한 문장으로 적어 주세요." };
    }
    if (!automation.graph) {
      return { ok: false as const, code: "PATCH_NO_GRAPH", reason: "이 자동화에는 아직 고칠 그래프가 없습니다.", nextAction: "먼저 그래프를 만든 뒤 다시 요청해 주세요." };
    }
    const architect = require("./workflow/graph-architect") as typeof import("./workflow/graph-architect");
    const { evaluateGraphPatch, graphPatchNeedsApproval } = require("./workflow/graph-patch") as typeof import("./workflow/graph-patch");
    const { callConnectedModelDetailed } = require("./system-agents/judgment") as typeof import("./system-agents/judgment");
    const detailed = await callConnectedModelDetailed({
      systemPrompt: architect.buildGraphArchitectPrompt(automation.graph, automation.goal),
      input: sentence.slice(0, 4_000),
      // 짓는 일이다 — 조회 도구를 연다(판정 통로의 무도구 잠금은 그대로).
      authoring: true,
    });
    const text = detailed.text;
    if (text === null) {
      /*
       * ★인터뷰 수리의 쌍둥이(2026-08-06) — 여기만 안 고쳐져 있었다. 모델이 이유를
       * 말하며 거절했으면(한도·로그인) 그 문장을 그대로 보여준다. "한 문장으로 다시
       * 말씀해 주세요"는 사람 문장이 문제일 때만 맞는 말이다.
       */
      return {
        ok: false as const,
        code: "ARCHITECT_UNAVAILABLE",
        reason: detailed.failure
          ? `그래프를 고치지 못했습니다 — ${detailed.failure.message}`
          : "그래프를 고쳐 줄 모델에 연결하지 못했습니다. 아무것도 바꾸지 않았습니다.",
        nextAction: detailed.failure?.kind === "quota"
          ? "안내에 적힌 시각 이후에 다시 시도하거나, 다른 모델을 연결해 주세요."
          : "설정에서 모델 연결을 확인한 뒤 다시 시도해 주세요.",
      };
    }
    const parsed = architect.parseGraphPatchProposal(text);
    if (!parsed.ok) return { ok: false as const, code: parsed.code, reason: parsed.reason, nextAction: parsed.nextAction };
    const decision = evaluateGraphPatch(automation.graph, parsed.patch);
    if (!decision.ok) return { ok: false as const, code: decision.code, reason: decision.reason, nextAction: decision.nextAction };
    return {
      ok: true as const,
      patch: parsed.patch,
      risks: decision.risks,
      summary: decision.summary,
      needsApproval: graphPatchNeedsApproval(decision),
      ...(parsed.patch.rationale ? { rationale: parsed.patch.rationale } : {}),
    };
  });

  // 자연어로 **새 자동화를 만드는** 인터뷰 한 턴. 화면은 질문을 받아 사람에게 보여주고,
  // 답을 모아 다시 이 자리로 돌아온다. 그래프는 청사진에서 코드가 짓는다 —
  // 모델이 노드와 연결을 직접 쓰면, 사람이 겪은 결함(미선언 분기·고아 노드·상한 없는 반복)이
  // 그대로 재발한다.
  ipcMain.handle("automations:interviewGraph", async (_e, state: unknown) => {
    const {
      buildInterviewPrompt, parseInterviewTurn,
    } = require("./workflow/graph-interview") as typeof import("./workflow/graph-interview");
    const { buildGraphFromBlueprint } = require("../shared/graph-blueprint") as typeof import("../shared/graph-blueprint");
    const current = state as import("./workflow/graph-interview").InterviewState;
    if (!current || typeof current !== "object" || typeof current.request !== "string") {
      return { ok: false, code: "INTERVIEW_STATE_INVALID", reason: "만들 내용을 읽지 못했습니다.", nextAction: "무엇을 자동으로 하고 싶은지 한 문장으로 말씀해 주세요." };
    }
    const {
      callConnectedModelDetailed,
      awaitConnectedModelRunnerWithAbortGrace,
    } = require("./system-agents/judgment") as typeof import("./system-agents/judgment");
    const { MAX_SELF_CORRECTIONS } = require("./workflow/graph-interview") as typeof import("./workflow/graph-interview");
    // 한 번의 사람 답변은 스스로 고치는 재시도까지 모두 합쳐 2분 안에 끝난다.
    // 각 재시도마다 2분을 새로 주면 화면의 남은 시간과 실제 대기가 서로 다른 약속이 된다.
    const interviewDeadline = Date.now() + 120_000;

    /**
     * 한 턴 안에서 **스스로 고칠 기회**를 정해진 횟수만큼 준다.
     *
     * 예전엔 청사진이 검증에 걸리면 "조금 더 구체적으로 말씀해 주시면 다시 시도합니다"로
     * 끝났다. 그건 막다른 길이다 — 무엇이 틀렸는지 **사람은 모르고 우리는 안다**. 형식이
     * 틀린 것은 사람이 다시 말한다고 고쳐지지 않는다. 커널이 지난 실패를 다음 실행 지시에
     * 붙이는 것과 같은 규율로, 무엇이 틀렸는지 모델에게 돌려주고 다시 짓게 한다.
     *
     * 무한히 맡기지 않는 이유: 같은 자리에서 계속 막히면 모델이 못 고치는 문제이고,
     * 계속 부르면 사람은 아무 설명 없이 기다리기만 한다.
     */
    // ★부를 수 있는 자동화 목록을 실물로 실어 준다 — 없으면 모델이 id를 지어낸다.
    const knownGraphs = listAutomations()
      .filter((row) => row.graph && row.graph.nodes?.length)
      .map((row) => ({ id: row.id, name: row.name }));
    let attempt = { ...current, knownGraphs, attempts: [...(current.attempts ?? [])] };
    for (let round = 0; round <= MAX_SELF_CORRECTIONS; round += 1) {
      let text: string | null = null;
      try {
        /*
         * ★답이 다 나오기 전에도 **지금까지 정해진 단계**를 화면으로 보낸다.
         *
         * 런타임은 이미 조각을 주고 있었는데(runner.ts onPartial) 판정기가 버리고 있어서,
         * 인터뷰는 완성된 청사진이 올 때까지 아무것도 못 그렸다 — 사람은 몇 십 초를
         * 빈 화면으로 기다렸다. 여기서 조각을 훑어 `"title": "..."` 이 나올 때마다
         * 그 순서대로 흘려보낸다. **완성된 JSON을 기다리지 않는다** — 부분 문자열은
         * 파싱이 안 되는 것이 정상이고, 우리가 필요한 건 "몇 번째 단계가 무엇인가"뿐이다.
         */
        const seenTitles: string[] = [];
        let partialBuf = "";
        const detailedTurn = await callConnectedModelDetailed({
          systemPrompt: "You return only compact JSON. No prose.",
          input: buildInterviewPrompt(attempt, currentUiLocale()),
          timeoutMs: Math.max(1, interviewDeadline - Date.now()),
          // 그래프를 **짓는** 호출이다 — 조회 도구와 이미 동의된 MCP 가 함께 간다.
          // (판정 호출부는 이 깃발을 켜지 않으므로 무도구 잠금이 그대로 유지된다.)
          authoring: true,
          onPartial: (chunk) => {
            partialBuf += chunk;
            for (const m of partialBuf.matchAll(/"title"\s*:\s*"([^"\\]{1,80})"/g)) {
              const title = m[1];
              if (seenTitles.includes(title)) continue;
              seenTitles.push(title);
              for (const win of BrowserWindow.getAllWindows()) {
                try {
                  win.webContents.send("automations:interview:steps", {
                    index: seenTitles.length - 1,
                    title,
                  });
                } catch { /* 창이 닫혔을 뿐이다 */ }
              }
            }
          },
        });
        text = detailedTurn.text;
        /*
         * ★표식이 먼저다 — 240자 문구 추측(graph-interview.ts)은 표식 없는 런타임용
         * 폴백으로 강등됐다. 런타임이 이유를 말하며 거절했으면 그 문장을 그대로.
         */
        if (text === null && detailedTurn.failure) {
          return {
            ok: false,
            code: "INTERVIEW_MODEL_UNAVAILABLE",
            reason: `AI가 만들지 못했습니다 — ${detailedTurn.failure.message}`,
            nextAction: detailedTurn.failure.kind === "quota"
              ? "안내에 적힌 시각 이후에 다시 시도하거나, 다른 모델을 연결해 주세요."
              : "다른 모델을 연결하거나, 잠시 뒤 다시 시도해 주세요.",
          };
        }
      } catch (error) {
        return {
          ok: false,
          code: "INTERVIEW_MODEL_UNAVAILABLE",
          reason: `AI를 부르지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
          nextAction: "잠시 뒤 다시 시도해 주세요.",
        };
      }
      if (!text) {
        return {
          ok: false,
          code: "INTERVIEW_MODEL_UNAVAILABLE",
          reason: "AI가 답하지 못했습니다.",
          nextAction: "잠시 뒤 다시 시도해 주세요.",
        };
      }
      const parsed = parseInterviewTurn(text, attempt);
      if (!parsed.ok) {
        /*
         * ★모델이 형식을 틀린 것과 사람이 답을 안 준 것은 다르다.
         *
         * 출력이 JSON으로 안 읽히면 지금까지는 그 자리에서 인터뷰가 죽고 **사람이 준
         * 답까지 전부 사라졌다.** 화면에는 "자동으로 돌릴 일을 한 문장으로 다시 적어
         * 주세요"가 떴다 — 사람 문장이 틀린 것처럼(실측 2026-08-06, 연속 3회 재현).
         * 형식 문제는 이미 스스로 고치게 하는 장치가 있다. 같은 예산 안에서 그쪽으로 보낸다.
         */
        if (parsed.code !== "INTERVIEW_OUTPUT_UNREADABLE" || attempt.attempts.length >= MAX_SELF_CORRECTIONS) {
          return parsed;
        }
        attempt = {
          ...attempt,
          attempts: [...attempt.attempts, {
            round: attempt.round,
            problems: ["지난 답이 JSON 하나로 읽히지 않았습니다. 설명 없이 JSON 객체 하나만 내보내세요."],
          }],
        };
        continue;
      }
      if (parsed.turn.kind === "ask") {
        return { ok: true as const, kind: "ask" as const, questions: parsed.turn.questions };
      }
      if (parsed.turn.kind === "retry") {
        attempt = {
          ...attempt,
          attempts: [...attempt.attempts, {
            round: attempt.round,
            problems: parsed.turn.problems,
            // 다음 시도가 이보다 작아지면 막는다 — 문제를 지워서 고치는 것을 코드가 잡는다.
            ...(typeof parsed.turn.stepCount === "number" ? { stepCount: parsed.turn.stepCount } : {}),
            ...(parsed.turn.triggerKind ? { triggerKind: parsed.turn.triggerKind } : {}),
          }],
        };
        continue;
      }
      const built = buildGraphFromBlueprint(parsed.turn.blueprint, currentUiLocale(), { knownGraphs });
      if (!built.ok) {
        // 청사진 검증은 통과했는데 짓는 데서 걸렸다 — 이것도 형식 문제다. 같은 규율.
        attempt = {
          ...attempt,
          attempts: [...attempt.attempts, { round: attempt.round, problems: built.problems.map((p) => p.reason) }],
        };
        continue;
      }
      // ★슬롯 편성 — 단계가 선언한 역할을 **실물 에이전트**로 채운다.
      //   기본은 Hub(생태계가 돌아야 한다). 못 찾은 슬롯은 비워 둔다 — 아무거나
      //   꽂으면 사람은 꽂힌 대로 돌 거라 믿는다. 사람은 저장 확인 화면에서 이 결정을 본다.
      let staffedGraph = built.graph;
      let staffing: import("./workflow/graph-staffing").StaffedSlot[] = [];
      try {
        const { staffGraph, applyStaffing } = await import("./workflow/graph-staffing");
        const { listInstalledAgentsReadOnly } = await import("./mcp/registry");
        const { getSource } = await import("./marketplace");
        const installedAgents = listInstalledAgentsReadOnly();
        // 특화도 Hub도 못 찾은 슬롯의 기본 러너 = 상주 오케스트레이터. 이게 없으면
        // AGENT 노드가 no-runner로 멈춰 "만들었는데 안 도는" 그래프가 된다(실측).
        const orchestrator = installedAgents.find((a) => a.id === "builtin-agentlas-orchestrator");
        const staffingController = new AbortController();
        const staffingBudgetMs = Math.max(1, Math.min(8_000, interviewDeadline - Date.now()));
        const staffingTimer = setTimeout(() => {
          staffingController.abort(new Error("Graph staffing timed out"));
        }, staffingBudgetMs);
        try {
          staffing = await awaitConnectedModelRunnerWithAbortGrace(staffGraph(built.graph, {
          installed: installedAgents.map((a) => ({
            id: a.id, name: a.name, ...(a.tagline ? { tagline: a.tagline } : {}),
          })),
          searchHub: (q) => getSource().searchAgents(q),
          ...(orchestrator
            ? { defaultRunnerRef: orchestrator.id, defaultRunnerLabel: orchestrator.name }
            : {}),
          }), staffingController.signal);
        } finally {
          clearTimeout(staffingTimer);
        }
        staffedGraph = applyStaffing(built.graph, staffing);
      } catch {
        // 편성 실패는 그래프 실패가 아니다 — 기본 에이전트로 도는 그래프가 나온다.
        staffing = [];
      }
      return {
        ok: true as const,
        kind: "blueprint" as const,
        blueprint: parsed.turn.blueprint,
        graph: staffedGraph,
        staffing,
        scheduleHuman: built.scheduleHuman,
        triggerType: built.triggerType,
      };
    }
    // 상한에 닿았다. **무엇을 시도했는지와 함께** 멈춘다 — 조용히 포기하지 않는다.
    const tried = attempt.attempts.flatMap((a) => a.problems);
    return {
      ok: false,
      code: "INTERVIEW_SELF_CORRECTION_EXHAUSTED",
      reason: `${MAX_SELF_CORRECTIONS + 1}번 다시 만들어 봤지만 같은 자리에서 막혔습니다: ${[...new Set(tried)].slice(0, 3).join(" / ")}`,
      nextAction: "만들고 싶은 것을 다른 말로 적어 주시거나, 캔버스에서 직접 만들어 보세요.",
    };
  });


  // 인터뷰가 끝난 뒤 실제로 만든다. **꺼진 상태로** 들어온다 — 사람이 보고 켜야 돈다.
  /**
   * 저장 전에 한 번 돌려 보고, 안 되면 **이어갈 길을 함께 준다**.
   *
   * ★실측 2026-08-20: 저장 전 검증(verify-before-save)은 터미널에만 붙어 있었고
   *   데스크탑 빌더는 아예 부르지 않았다 — 사람이 가장 많이 쓰는 표면에서 그 안전장치가
   *   통째로 없었다. 그리고 터미널에서도 막히면 문장 한 줄로 끝났다. 오너 지시:
   *   *"50% 정도 완성하다 실패했을 때도 이어갈 수 있어야지, 대안을 제시한다거나."*
   *
   *   그래서 이 문은 두 가지를 돌려준다: **무엇이 막혔는지(사실)** 와
   *   **지금 무엇을 하면 이어갈 수 있는지(칩)**. 저장은 하지 않는다 — 사람이 고른다.
   */
  ipcMain.handle("automations:checkBlueprintBeforeSave", async (_e, payload: unknown) => {
    const input = payload as { graph?: unknown; goal?: string; initialVars?: Record<string, unknown> } | null;
    if (!input?.graph) {
      return { ok: false as const, code: "CREATE_INPUT_INVALID", blocked: null, recovery: null };
    }
    const graph = input.graph as import("../shared/types").WorkflowGraph;
    const { verifyGraphBeforeSaveWithKernel } = await import("./workflow/verify-before-save");
    const verification = await verifyGraphBeforeSaveWithKernel(
      graph,
      input.initialVars && typeof input.initialVars === "object" ? input.initialVars : undefined,
    );
    const blocked = verification.steps.find((step) => step.state === "blocked") ?? null;
    const repaired = verification.steps
      .filter((step) => step.state === "repaired")
      .map((step) => ({ nodeId: step.nodeId, label: step.label, code: step.repairedCode ?? "" }));
    if (!blocked) {
      return { ok: true as const, blocked: null, recovery: null, repaired };
    }
    const { planGraphBuildRecovery, blockedStepFactsFrom } = await import("./workflow/build-recovery");
    const facts = blockedStepFactsFrom({
      graph,
      nodeId: blocked.nodeId,
      label: blocked.label,
      cause: blocked.cause ?? "",
      availableVars: blocked.facts?.availableVars ?? [],
      upstreamSample: blocked.facts?.upstreamSample ?? null,
      varsSnapshot: blocked.facts?.varsSnapshot ?? {},
    });
    const ranBefore = verification.steps
      .filter((step) => step.state === "ran" || step.state === "repaired")
      .map((step) => step.label);
    const recovery = await planGraphBuildRecovery({
      graph,
      goal: String(input.goal ?? ""),
      blocked: facts,
      ranBefore,
    });
    return {
      ok: false as const,
      blocked: {
        nodeId: blocked.nodeId,
        label: blocked.label,
        cause: blocked.cause ?? "",
        // ★화면이 이걸 그대로 돌려줘야 복구기가 고친 코드를 **증명**할 수 있다.
        availableVars: blocked.facts?.availableVars ?? [],
        upstreamSample: blocked.facts?.upstreamSample ?? null,
        varsSnapshot: blocked.facts?.varsSnapshot ?? {},
      },
      recovery,
      repaired,
    };
  });

  /** 짓는 중 복구 칩을 **사람이 누른 순간에만** 실행한다. 계획과 실행을 나눈 이유다. */
  ipcMain.handle("automations:applyBuildRecovery", async (_e, payload: unknown) => {
    const input = payload as {
      graph?: unknown; goal?: string; actionId?: string;
      blocked?: {
        nodeId: string; label: string; cause: string;
        availableVars?: string[]; upstreamSample?: string | null;
        varsSnapshot?: Record<string, unknown>;
      };
    } | null;
    if (!input?.graph || !input.actionId || !input.blocked?.nodeId) {
      return { ok: false as const, message: "이 조치를 실행할 수 없습니다." };
    }
    const graph = input.graph as import("../shared/types").WorkflowGraph;
    const { applyGraphBuildRecovery, blockedStepFactsFrom } = await import("./workflow/build-recovery");
    return applyGraphBuildRecovery({
      graph,
      goal: String(input.goal ?? ""),
      blocked: blockedStepFactsFrom({
        graph,
        nodeId: input.blocked.nodeId,
        label: input.blocked.label,
        cause: input.blocked.cause,
        availableVars: input.blocked.availableVars ?? [],
        upstreamSample: input.blocked.upstreamSample ?? null,
        varsSnapshot: input.blocked.varsSnapshot ?? {},
      }),
      actionId: input.actionId,
    });
  });

  /**
   * 그래프를 고친 뒤 **이전 실패는 잊고 처음부터** 돌린다.
   *
   * ★실측 2026-08-20 (캠페인 E3): 실행이 실패한 뒤 사람이 채팅으로 그래프를 고쳤더니
   *   재실행이 거부됐다 — 화면은 "이전 그래프를 복원하거나 새 자동화로 분리하라"고만
   *   말했다. 커널에는 나갈 문(forgetStaleGraphCheckpoint)이 있었는데 **화면에 없었다.**
   *   그래서 고친 그래프로는 영원히 못 돌린다. 내는 오류에는 푸는 길이 있어야 한다.
   *
   *   그래프가 **실제로 바뀐 경우에만** 응한다 — 안 바뀌었으면 이전 실패는 여전히
   *   그 그래프의 실패이고, 잊는 것은 이중 실행의 문을 여는 짓이다.
   */
  ipcMain.handle("automations:forgetFailedRun", (_e, id: unknown) => {
    const automationId = String(id ?? "").trim();
    if (!automationId) return { automationId, ok: false as const, forgot: false, reason: "no_automation" };
    const automation = getAutomation(automationId);
    if (!automation?.graph) return { automationId, ok: false as const, forgot: false, reason: "no_graph" };
    const { forgetStaleGraphCheckpoint } = require("./store/graph-reconciliation") as
      typeof import("./store/graph-reconciliation");
    const { graphExecutionDigest } = require("../shared/graph-execution-digest") as
      typeof import("../shared/graph-execution-digest");
    const result = forgetStaleGraphCheckpoint(
      automationId,
      graphExecutionDigest(automation, automation.graph),
    );
    return { automationId, ok: true as const, ...result };
  });

  ipcMain.handle("automations:createFromBlueprint", (_e, payload: unknown) => {
    const input = payload as {
      name?: string; graph?: unknown; scheduleHuman?: string; targetId?: string; goal?: string;
    } | null;
    if (!input?.name?.trim() || !input.graph) {
      return { ok: false, code: "CREATE_INPUT_INVALID", reason: "만들 내용을 읽지 못했습니다.", nextAction: "다시 시도해 주세요." };
    }
    const existing = listAutomations().find((a) => a.name === input.name!.trim());
    // ★같은 이름 + 같은 그래프면 새로 만들지 않고 있는 것을 돌려준다.
    //   실측(2026-08-05): 저장 버튼이 전환 피드백 없이 조용해서 사람이 여러 번 눌렀고,
    //   같은 그래프가 "(2)" 사본 8개로 쌓였다. 중복 제거가 아니라 멱등이 정답이다.
    if (existing) {
      const prior = getAutomation(existing.id);
      if (prior?.graph && JSON.stringify(prior.graph) === JSON.stringify(input.graph)) {
        return { ok: true as const, id: existing.id, name: existing.name, renamed: false, reused: true };
      }
    }
    const name = existing ? `${input.name!.trim()} (2)` : input.name!.trim();
    const created = createAutomation({
      name,
      scheduleHuman: input.scheduleHuman?.trim() || "manual",
      targetType: "agent",
      targetId: input.targetId?.trim() || "builtin-agentlas-orchestrator",
      promptTemplate: name,
      // ★권한은 그래프가 선언한 것에서 따라 나온다 — 여기서 "read" 로 못박아 두면
      //   자기 청사진이 선언한 mutation 단계를 스스로 못 하는 자동화가 태어난다.
      executionPermission: requiredExecutionPermission(input.graph as never),
      graphJson: input.graph as never,
      // ★확인 카드가 "꺼진 상태로 저장됩니다"라고 약속한다 — 그 상태로 **태어나야** 한다.
      //   만들고 나서 끄는 두 걸음 사이에서 예외가 나면 켜진 채 남는다(실측).
      enabled: false,
      // ★목적 문장을 함께 저장한다 — 사라지면 AI가 이 그래프를 다시 이해할 수 없다.
      ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
    });
    return { ok: true as const, id: created.id, name, renamed: !!existing };
  });

  ipcMain.handle("automations:proposeGraphPatch", (_e, id: string, patch: unknown) => {
    const evaluated = evaluatePatchFor(id, patch);
    if ("ok" in evaluated) return evaluated;
    const { decision } = evaluated;
    if (!decision.ok) return decision;
    const { graphPatchNeedsApproval } = require("./workflow/graph-patch") as typeof import("./workflow/graph-patch");
    return {
      ok: true as const,
      risks: decision.risks,
      summary: decision.summary,
      needsApproval: graphPatchNeedsApproval(decision),
    };
  });

  ipcMain.handle("automations:applyGraphPatch", (_e, id: string, patch: unknown) => {
    const evaluated = evaluatePatchFor(id, patch);
    if ("ok" in evaluated) return evaluated;
    const { decision } = evaluated;
    if (!decision.ok) return decision;
    // 여기 도달했다는 것은 사용자가 diff를 보고 눌렀다는 뜻이다. 검증은 한 번 더 한다 —
    // 제안과 적용 사이에 그래프가 바뀌었으면 위 평가에서 이미 걸린다.
    const automation = updateAutomationGraph(id, decision.next, { note: "말로 고치기" });
    return { ok: true as const, automationId: automation.id, automation };
  });
  ipcMain.handle("automations:runNow", async (
    _e,
    id: string,
    opts?: { dryRun?: boolean; input?: Record<string, unknown> },
  ) => {
    // 켜도 되는가의 판단은 **한 곳**에서 한다(shared/graph-run-request).
    // 입구마다 각자 검사하면 같은 그래프가 부르는 쪽에 따라 다르게 돈다 — 지금 터미널은
    // SQL을 직접 쓰고 여기는 IPC에서 따로 검사하고 있었다.
    const { decideGraphRunRequest } = require("../shared/graph-run-request") as typeof import("../shared/graph-run-request");
    const decision = decideGraphRunRequest({
      ref: id,
      automations: listAutomations(),
      // 데스크탑의 [지금 실행]·[시뮬레이션]은 사람이 그 화면 앞에서 직접 누른 것이다 —
      // 대기열에 앉는 요청이 아니므로 꺼져 있어도 한 번 돌려볼 수 있어야 한다.
      mode: "immediate",
      ...(opts?.input ? { input: opts.input } : {}),
      ...(opts?.dryRun ? { dryRun: true } : {}),
    });
    if (!decision.ok) {
      const error = new Error(decision.reason) as Error & { code?: string; nextAction?: string };
      error.code = decision.code;
      error.nextAction = decision.nextAction;
      throw error;
    }
    for (const [name, value] of Object.entries(decision.input)) {
      enqueueRunInput(id, { [name]: value }, "desktop");
    }
    // 수동 실행은 실제 스케줄러의 접수·최종 상태를 돌려준다. 버튼 클릭 자체를 성공으로
    // 간주하면 리스 충돌이나 실행 실패가 "시작됨"으로 보이므로 fire-and-forget하지 않는다.
    const dryRun = opts?.dryRun === true;
    // An uncertain live occurrence must block another live replay, but it must
    // not block a side-effect-proof simulation used to diagnose the graph.
    // runGraph also mode-matches durable checkpoints, so this simulation starts
    // a fresh occurrence and can never inherit or consume the live coordinate.
    if (!dryRun && getAutomationGraphReconciliation(id)) {
      throw new Error("automation_reconciliation_pending");
    }
    const { runAutomationNow } = await import("./automation-scheduler");
    const result = await runAutomationNow(id, dryRun ? { dryRun: true } : undefined);
    if (!result.accepted) {
      const error = new Error("automation_run_not_accepted") as Error & { code?: string };
      error.code = "automation_run_not_accepted";
      throw error;
    }
    if (result.automationId !== id || result.runId === undefined) {
      throw new Error("automation_run_receipt_identity_missing");
    }
    return result;
  });
  // 이 그래프가 무엇에 연결돼야 하는가 — **공급자 묶음으로** 답한다.
  // 조사 결과 이 묶기를 하는 제품이 없다(Power Automate는 커넥터마다 새 탭→닫기→Refresh→
  // 재선택 4스텝 왕복, 3개면 12스텝). 구글 캘린더·시트·지메일은 계정 하나로 함께 열린다.
  ipcMain.handle("automations:connectionReport", async (_e, id: string) => {
    const automation = getAutomation(id);
    if (!automation) return null;
    const { reportGraphConnections } = require("./workflow/tool-inventory") as typeof import("./workflow/tool-inventory");
    return reportGraphConnections(automation.graph, currentUiLocale() === "en" ? "en" : "ko");
  });

  // 원터치 교체 — 같은 일을 하는 다른 서비스로 **한 번에** 갈아끼운다.
  // 검사는 여기(main)에서 한다. 화면이 후보를 잘못 그려도, 할 수 없는 것으로는 안 바뀐다.
  ipcMain.handle(
    "automations:swapProvider",
    async (_e, id: string, input: { capability: string; fromProvider: string | null; toProvider: string }) => {
      const automation = getAutomation(id);
      if (!automation) throw new Error(`Automation not found: ${id}`);
      const locale = currentUiLocale() === "en" ? "en" : "ko";
      const { planProviderSwap } = require("../shared/graph-tool-binding") as typeof import("../shared/graph-tool-binding");
      const plan = planProviderSwap(automation.graph, {
        capability: String(input?.capability ?? ""),
        fromProvider: typeof input?.fromProvider === "string" ? input.fromProvider : null,
        toProvider: String(input?.toProvider ?? ""),
      }, locale);
      if (!plan.ok) return plan;
      updateAutomationGraph(id, plan.graph);
      const { reportGraphConnections } = require("./workflow/tool-inventory") as typeof import("./workflow/tool-inventory");
      return { ok: true, changed: plan.changed, report: await reportGraphConnections(plan.graph, locale) };
    },
  );
  ipcMain.handle(
    "automations:swapAgent",
    async (
      _e,
      id: string,
      input: { nodeId: string; ref: string; targetType: "agent" | "firm" | "hub"; targetVersion?: string | null; label?: string },
    ) => {
      const automation = getAutomation(id);
      if (!automation) throw new Error(`Automation not found: ${id}`);
      const locale = currentUiLocale() === "en" ? "en" : "ko";
      const { planAgentSwap } = require("../shared/graph-tool-binding") as typeof import("../shared/graph-tool-binding");
      const plan = planAgentSwap(automation.graph, {
        nodeId: String(input?.nodeId ?? ""),
        ref: String(input?.ref ?? ""),
        targetType: input?.targetType === "firm" || input?.targetType === "hub" ? input.targetType : "agent",
        targetVersion: typeof input?.targetVersion === "string" ? input.targetVersion : null,
        ...(typeof input?.label === "string" ? { label: input.label } : {}),
      }, locale);
      if (!plan.ok) return plan;
      updateAutomationGraph(id, plan.graph);
      const { reportGraphConnections } = require("./workflow/tool-inventory") as typeof import("./workflow/tool-inventory");
      return { ok: true, changed: plan.changed, report: await reportGraphConnections(plan.graph, locale) };
    },
  );

  ipcMain.handle("automations:inputRequirement", (_e, id: string) => {
    const automation = getAutomation(id);
    if (!automation) return null;
    return graphInputRequirement(automation.graph);
  });
  ipcMain.handle("automations:latestRun", (_e, id: string) => getLatestGraphRun(id));
  // 승인은 사람의 결정이라 판정 모델 가용성과 무관하게 동작해야 한다. 결정은 가장 최근
  // 실행의 occurrence에 묶는다 — 승인 하나가 다음 실행까지 조용히 재사용되면 안 된다.
  ipcMain.handle(
    "automations:decideNodeApproval",
    (_e, id: string, nodeId: string, decision: "approved" | "rejected" | "always") => {
      const automation = getAutomation(id);
      if (!automation) throw new Error(`Automation not found: ${id}`);
      if (typeof nodeId !== "string" || !nodeId.trim()) throw new Error("automation_approval_node_invalid");
      if (decision !== "approved" && decision !== "rejected" && decision !== "always") {
        throw new Error("automation_approval_decision_invalid");
      }
      const { getLatestGraphRunOccurrence, recordNodeApproval, clearGraphRunFailureForNode } =
        require("./store/automations") as typeof import("./store/automations");
      const occurrenceId = getLatestGraphRunOccurrence(id);
      if (!occurrenceId) {
        // 승인할 대상이 없는데 승인한 척하지 않는다.
        return { ok: false, occurrenceId: null };
      }
      // ★"항상 허용"은 승인 기록에 scope로 남긴다 — 그래프를 바꾸지 않는다.
      //   노드 config를 ask_once로 고치면 graph_json이 달라져 graphDigest가 바뀌고,
      //   지금 멈춰 있는 바로 그 실행의 재개가 거부된다.
      recordNodeApproval({
        automationId: id, occurrenceId, nodeId,
        decision: decision === "always" ? "approved" : decision,
        ...(decision === "always" ? { scope: "always" as const } : {}),
      });
      // ★승인 무한루프의 절반(실측 2026-08-08): 결정 뒤에도 스냅샷의
      //   APPROVAL_REQUIRED가 남아 라이브 폴링이 승인 카드를 계속 되살렸다.
      //   결정이 기록됐으니 카드의 근거를 스냅샷에서 지운다(거부 포함 —
      //   거부도 결정이며, 카드가 계속 "결정하라"고 조르면 안 된다).
      clearGraphRunFailureForNode(id, nodeId);
      return { ok: true, occurrenceId, always: decision === "always" };
    },
  );
  ipcMain.handle(
    "automations:proposeChecklistFromExample",
    async (_e, id: string, example: string) => {
      const automation = getAutomation(id);
      if (!automation) throw new Error(`Automation not found: ${id}`);
      if (typeof example !== "string" || !example.trim()) {
        return { ok: false as const, items: [] };
      }
      const { proposeChecklistFromExample } = await import("./system-agents/judgment");
      const proposal = await proposeChecklistFromExample({
        example,
        ...(automation.goal ? { goal: automation.goal } : {}),
        locale: (await import("./ui-locale")).currentUiLocale(),
      });
      // 제안이 불가하면 불가라고 말한다 — 빈 채점표를 성공처럼 주지 않는다.
      return proposal.source === "llm"
        ? { ok: true as const, items: proposal.items }
        : { ok: false as const, items: [] };
    },
  );
  ipcMain.handle(
    "automations:recordEvalCorrection",
    (_e, id: string, nodeId: string, correctedVerdict: "pass" | "fail", note?: string) => {
      const automation = getAutomation(id);
      if (!automation) throw new Error(`Automation not found: ${id}`);
      if (correctedVerdict !== "pass" && correctedVerdict !== "fail") {
        throw new Error("automation_eval_correction_invalid");
      }
      // 교정 대상(판정이 봤던 결과)은 마지막 실행의 체크포인트에서 서버가 찾는다 —
      // 렌더러에 실행 변수를 다시 실어 나르지 않는다.
      const { recordEvalCorrection } = require("./store/automations") as
        typeof import("./store/automations");
      const { getDb } = require("./store/db") as typeof import("./store/db");
      const node = automation.graph?.nodes.find((n) => n.id === nodeId);
      const subjectVar = typeof node?.config?.subject === "string" ? node.config.subject : null;
      let preview = "";
      try {
        const row = getDb().prepare(
          "SELECT checkpoint_json FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1",
        ).get(id) as { checkpoint_json: string | null } | undefined;
        const checkpoint = row?.checkpoint_json
          ? JSON.parse(row.checkpoint_json) as { vars?: Record<string, unknown> } : null;
        const value = subjectVar ? checkpoint?.vars?.[subjectVar] : undefined;
        if (value != null) preview = String(value);
      } catch { /* 미리보기는 없어도 교정은 성립한다 */ }
      recordEvalCorrection({
        automationId: id, nodeId,
        subjectPreview: preview,
        correctedVerdict,
        ...(note?.trim() ? { note: note.trim() } : {}),
      });
      return { ok: true as const };
    },
  );
  // 멈춘 자동화의 "지금 무엇을 하면 되는지" — 실행 가능한 조치까지 포함해 계산한다.
  ipcMain.handle("automations:planFix", async (_e, id: string) => {
    const { planAutomationFix } = await import("./automation-fix");
    return planAutomationFix(id);
  });
  ipcMain.handle("automations:applyFix", async (_e, id: string, actionId: string) => {
    const { applyAutomationFix } = await import("./automation-fix");
    return { ...(await applyAutomationFix(id, actionId)), automationId: id, actionId };
  });
  ipcMain.handle("automations:getSession", (_e, id: string) => {
    const automation = getAutomation(id);
    if (!automation) throw new Error(`Automation not found: ${id}`);
    const session = getOrCreateAutomationSession({
      automationId: automation.id,
      projectId: automation.projectId ?? null,
      runtimeSelection: automation.runtimeSelection ?? null,
      ...(automation.targetType === "firm"
        ? { firmId: automation.targetId }
        : automation.targetType === "agent"
          ? { agentId: automation.targetId }
          : {}),
    });
    return {
      id: session.id,
      automationId: automation.id,
      chatId: session.chat.id,
      runtimeSelection: session.chat.runtimeSelection ?? null,
      // 제품이 스스로 보낸 복구 지시는 대화가 아니다. 예전에 user 턴으로 저장된 것들이
      // "요청"으로 보이면서 내부 프롬프트("Private evidence …")까지 노출됐다.
      messages: listChatMessages(session.chat.id)
        // 제품이 스스로 보낸 복구 지시는 대화가 아니다.
        .filter((message) => !message.text.startsWith(SYSTEM_OPTIMIZER_PROMPT_MARKER))
        // 연속성 캡슐은 모델용 내부 컨텍스트다. 사용자가 실제로 지시한 본문만 남긴다.
        .map((message) => ({ ...message, text: stripAutomationContinuityCapsule(message.text) }))
        .filter((message) => message.text.trim().length > 0),
      updatedAt: session.chat.updatedAt,
    };
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

  // ── legacy launchd cleanup (Desktop local execution is app-scoped) ───
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
      userDataPath("generated-assets");
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
      userDataPath("generated-apps");
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
  ipcMain.handle("appFactory:startLivePreview", async (event, input: { appId: string }) => {
    assertTrustedSitePublishIpcSender(event);
    return startAppFactoryLivePreview(input?.appId);
  });
  ipcMain.handle("appFactory:stopLivePreview", async (event, input: { appId: string }) => {
    assertTrustedSitePublishIpcSender(event);
    return stopAppFactoryLivePreview(input?.appId);
  });

  // Native Work live view. Every operation is bound to the requesting renderer;
  // a different window cannot resize, reload, or close its surface by guessing an id.
  ipcMain.handle("workLiveView:open", async (event, input: {
    viewId: string;
    url: string;
    bounds: import("../shared/types").WorkLiveViewBounds;
    visible?: boolean;
    mode?: "app" | "browser";
  }) => {
    const win = assertTrustedSitePublishIpcSender(event);
    const ownerId = event.sender.id;
    if (!workLiveCleanupOwners.has(ownerId)) {
      workLiveCleanupOwners.add(ownerId);
      event.sender.once("destroyed", () => {
        closeWorkLiveViewsForOwner(ownerId);
        workLiveCleanupOwners.delete(ownerId);
      });
    }
    return openWorkLiveView({
      ownerId,
      window: win,
      ...input,
      send: (status) => {
        if (!event.sender.isDestroyed()) event.sender.send("workLiveView:status", status);
      },
    });
  });
  ipcMain.handle("workLiveView:setBounds", (event, input: {
    viewId: string;
    bounds: import("../shared/types").WorkLiveViewBounds;
    visible?: boolean;
  }) => {
    assertTrustedSitePublishIpcSender(event);
    return setWorkLiveViewBounds(event.sender.id, input);
  });
  ipcMain.handle("workLiveView:reload", (event, viewId: string) => {
    assertTrustedSitePublishIpcSender(event);
    return reloadWorkLiveView(event.sender.id, viewId);
  });
  ipcMain.handle("workLiveView:navigate", (event, input: { viewId: string; url: string }) => {
    assertTrustedSitePublishIpcSender(event);
    return navigateWorkLiveView(event.sender.id, input);
  });
  ipcMain.handle("workLiveView:goBack", (event, viewId: string) => {
    assertTrustedSitePublishIpcSender(event);
    return goBackWorkLiveView(event.sender.id, viewId);
  });
  ipcMain.handle("workLiveView:goForward", (event, viewId: string) => {
    assertTrustedSitePublishIpcSender(event);
    return goForwardWorkLiveView(event.sender.id, viewId);
  });
  ipcMain.handle("workLiveView:close", (event, viewId: string) => {
    assertTrustedSitePublishIpcSender(event);
    return closeWorkLiveView(event.sender.id, viewId);
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
      userDataPath("generated-tools");
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

  // ── Plugin Builder (@plugin-make) ──────────────────────
  ipcMain.handle("pluginBuilder:start", (_e, input: { chatId: string; seed: PluginBuilderSeed }) =>
    startPluginBuilder(input));
  ipcMain.handle("pluginBuilder:draft", (_e, input: { sessionId: string; answers: PluginBuilderAnswers }) =>
    draftPluginBuilder(input));
  ipcMain.handle("pluginBuilder:verify", (_e, input: { sessionId: string }) => verifyPluginBuilder(input));
  ipcMain.handle("pluginBuilder:install", (_e, input: { sessionId: string }) => installPluginBuilder(input));
  ipcMain.handle("pluginBuilder:prove", (_e, input: { sessionId: string }) => provePluginBuilder(input));
  ipcMain.handle("pluginBuilder:discard", (_e, input: { sessionId: string }) => discardPluginBuilder(input));
  ipcMain.handle("pluginBuilder:listDrafts", (_e, chatId: string) => listPluginBuilderDrafts(chatId));

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
    // One's intent and personal-memory judges belong to the One surface only.
    // A Work project turn goes directly to the project execution contract and
    // must not silently spend time in, or inherit policy from, One's judges.
    if (request.oneMode === true) {
      // T7 읽기 전용 아카이브(SEAT-SESSION-PLAN-v2 I3) — 해체된 좌석의 세션은 열람만
      // 가능하다. 권위 가드는 여기(렌더러 우회 불가)이고, 거절 문구는 막다른 길이
      // 아니라 다음 행동(새 단톡으로 이어가기)을 함께 낸다. Work 표면은 무접촉.
      if (request.chatId) {
        const seat = getSeatForChat(request.chatId);
        if (seat?.dissolvedAt) {
          throw new Error(
            currentUiLocale() === "ko"
              ? "이 단톡은 해체되어 기록으로만 보존됩니다. 같은 멤버로 새 단톡을 만들어 이어가세요."
              : "This group chat was dissolved and is kept as a read-only archive. Start a new group chat with the same members to continue.",
          );
        }
        /*
         * ★ 나간 사람은 대답하지 않는다 (UX-D-4).
         *
         * 대화에는 "나갔습니다" 구분선이 찍히는데 바로 그 밑에서 그 팀원이 정상적으로
         * 대답하고 있었다. 담당이 자리를 비워도 `chats.agent_id` 는 마지막 담당을 그대로
         * 들고 있고, 실행은 그 owner 를 무조건 참여자로 세우기 때문이다. 화면 가드는
         * 렌더러가 우회할 수 있으므로 권위 가드는 해체와 같은 자리에 둔다.
         *
         * **떠났다는 것을 증명할 수 있을 때만** 막는다 — 열린 점유가 없다는 사실만으로는
         * "나갔다"가 아니다(좌석 원장이 아직 시딩되지 않은 구세대 대화도 0행이다).
         * 점유 이력이 있는데 열린 행이 하나도 없을 때, 그때만 사람이 자리를 뜬 것이다.
         * 없는 데이터를 사실로 승격시키지 않는다.
         */
        {
          let departed = false;
          let directAgentChanged = false;
          if (seat && seat.kind === "solo" && seat.occupants.length === 0) {
            try {
              departed = listSeatOccupantHistory(seat.id).length > 0;
            } catch {
              // 좌석 이력을 못 읽으면 증명이 없는 것이다 — 막지 않는다.
            }
          }
          /*
           * 좌석을 비우기 전(이 수리 이전)에 보관된 팀원은 좌석 원장에 열린 점유가 그대로
           * 남아 있다. 그 사람도 조직에서는 이미 나간 사람이므로, 조직 원장 쪽 사실로도
           * 같은 판정을 내린다 — 안 그러면 "예전에 보관한 사람만 계속 대답하는" 상태가 남는다.
           */
          if (!departed) {
            try {
              const ownerAgentId = getChat(request.chatId)?.agentId;
              if (ownerAgentId) {
                const owner = getOneOrgState().members
                  .find((member) => member.installedAgentId === ownerAgentId);
                departed = Boolean(owner?.archivedAt);
              }
            } catch {
              // 조직 상태를 못 읽으면 증명이 없는 것이다 — 막지 않는다.
            }
          }
          if (seat && seat.kind === "solo" && seat.occupants.length > 0) {
            const sessionAgentId = getChat(request.chatId)?.agentId;
            directAgentChanged = Boolean(
              sessionAgentId
              && !seat.occupants.some((occupant) => occupant.agentId === sessionAgentId),
            );
          }
          if (departed || directAgentChanged) {
            throw new Error(
              currentUiLocale() === "ko"
                ? "이 세션의 에이전트가 사라졌습니다. 세션을 새로 시작해주세요."
                : "This session's agent is no longer available. Start a new session to continue.",
            );
          }
        }
      }
      // Best-effort with a tight budget: a miss remains unresolved and must
      // never be replaced by a lexical or static verdict.
      await Promise.all([
        prejudgeOneRequestIntent(request, { timeoutMs: 4_000 }),
        prejudgeOneMemoryIntent(request, { timeoutMs: 4_000 }),
      ]).catch(() => undefined);
    }
    return invocationService.start(request);
  });
  ipcMain.handle("invoke:steer", (_event, req: McpInvocationRequest) => invocationService.steer(rendererInvocationRequest(req)));
  ipcMain.handle("invoke:cancel", (_event, runId: string) => ({
    runId,
    status: invocationService.cancel(runId),
  }));
  ipcMain.handle(
    "invoke:unsteer",
    (_event, req: { chatId: string; position: number; text: string }) =>
      invocationService.unsteer(req.chatId, req.position, req.text),
  );
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

  let hephaestusUpdateInFlight: ReturnType<typeof runHephaestusRuntimeUpdate> | null = null;
  let coreAuthLoginInFlight: ReturnType<typeof hepAuthLogin> | null = null;
  // ── Hephaestus 엔진 브리지 ──────────────────────────────────────────────
  // 임베딩된 오픈소스 엔진(Hephaestus)을 범용 CLI/JSON 으로 호출한다. 엔진 측에는 데스크탑
  // 흔적이 없고, 모든 연결 코드는 electron/hephaestus/* + 아래 핸들러에만 존재한다.
  ipcMain.handle("hephaestus:status", (_e, locale?: "ko" | "en") => hephaestusAvailable(locale));
  ipcMain.handle("hephaestus:recover", async (_e, input?: { locale?: "ko" | "en"; actionId?: string }) => {
    const { recoverHephaestusRuntime } = await import("./one/hephaestus-recovery");
    return { ...(await recoverHephaestusRuntime(input)), actionId: input?.actionId ?? null };
  });
  ipcMain.handle("hephaestus:coreAuthStatus", () => hepAuthStatus());
  // 로그인은 브라우저를 띄우고 최대 3분 기다린다. 두 번 겹치면 Core 의 콜백 서버가
  // 포트를 두고 다투므로 하나로 직렬화한다.
  ipcMain.handle("hephaestus:coreAuthLogin", () => {
    if (!coreAuthLoginInFlight) {
      coreAuthLoginInFlight = hepAuthLogin().finally(() => { coreAuthLoginInFlight = null; });
    }
    return coreAuthLoginInFlight;
  });
  ipcMain.handle("hephaestus:updateJournal", () => readHephaestusUpdateJournal());
  // Serialised: two concurrent updaters would race Core's lock and the second
  // would report a misleading outcome for work the first is still doing.
  ipcMain.handle("hephaestus:runUpdate", () => {
    if (!hephaestusUpdateInFlight) {
      hephaestusUpdateInFlight = runHephaestusRuntimeUpdate().finally(() => {
        hephaestusUpdateInFlight = null;
      });
    }
    return hephaestusUpdateInFlight;
  });
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
        // 활성 장기대여 slug 는 호출 비용 0 — 페이월/고지액이 실제 청구액을 넘보지 않게
        // 정규화 단계에서 확정한다(리스 목록은 main 의 TTL 캐시).
        const leasedSlugs = await activeLeasedSlugs().catch(() => new Set<string>());
        return normalizeRecommendation(res.json, input.query, { leasedSlugs });
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
      input: { folder: string; scope: FsReadScope; visibility: "private-link" | "marketplace"; dryRun?: boolean; locale?: "ko" | "en"; progressId?: string },
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
          return await hepPublish(autofix.packageFolder, input.visibility, {
            dryRun: input.dryRun,
            ...corePublishOptions(event, input.progressId),
          });
        } finally {
          autofix.cleanup();
        }
      }
      return hepPublish(folder, input.visibility, {
        dryRun: input.dryRun,
        ...corePublishOptions(event, input.progressId),
      });
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
  ipcMain.handle("hephaestus:securityScan", (event, input: { folder: string; scope: FsReadScope; strict?: boolean; locale?: "ko" | "en"; progressId?: string }) => {
    let folder: string;
    try {
      folder = resolveFsReadPath(input.folder, input.scope);
    } catch (e) {
      return { ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as PathGuardError).message };
    }
    return securityScan(folder, { strict: input.strict, ...coreProgressOptions(event, input.progressId) });
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

  // 화면이 돌아왔을 때 붙을 수 있게, main이 들고 있는 전사를 그대로 돌려준다.
  // 렌더러는 이걸 재생해 로그·단계를 복원하고, 아직 running이면 같은 채널을 다시 구독한다.
  // 완료 신호가 없어도 "계약이 통과했는가"는 물어볼 수 있어야 한다. 모델이 마지막
  // 한 줄을 빠뜨렸다고 완성된 패키지를 실패로 통보하는 건 사실과 다르다
  // (2026-08-17 실측: blockers 0인 패키지가 "최종 검증 완료 신호 미확인"으로 실패 처리).
  ipcMain.handle(
    "hephaestus:contractVerify",
    async (_e, input: { folder: string; scope: FsReadScope; mode?: "single" | "team" | "package" }) => {
      let folder: string;
      try {
        folder = resolveFsReadPath(input.folder, input.scope);
      } catch (e) {
        return { ok: false, blockers: null, error: (e as PathGuardError).message };
      }
      const res = await contractVerify(folder, { mode: input.mode });
      const blockers = (res.json as { blockers?: unknown } | null)?.blockers;
      return {
        ok: Array.isArray(blockers),
        blockers: Array.isArray(blockers) ? blockers.map(String) : null,
        error: res.error ?? null,
      };
    },
  );

  ipcMain.handle("hephaestus:activeBuild", () => {
    const latest = [...buildTranscripts.values()].at(-1);
    if (!latest) return null;
    return {
      runId: latest.runId,
      request: latest.request,
      workspace: latest.workspace,
      startedAt: latest.startedAt,
      running: latest.running,
      events: latest.events,
    };
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
    buildTranscripts.clear();
    buildTranscripts.set(runId, {
      runId,
      request: String(req.request ?? ""),
      workspace: resolvedRequest.workspace,
      startedAt: new Date().toISOString(),
      running: true,
      events: [],
    });
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
      const transcript = buildTranscripts.get(runId);
      if (transcript) {
        transcript.events.push(ev);
        if (transcript.events.length > BUILD_TRANSCRIPT_MAX_EVENTS) {
          transcript.events.splice(0, transcript.events.length - BUILD_TRANSCRIPT_MAX_EVENTS);
        }
      }
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
      const finished = buildTranscripts.get(runId);
      if (finished) finished.running = false;
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
