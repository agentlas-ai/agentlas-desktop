// Main 프로세스 ↔ Renderer 간 공유 타입.
// renderer/lib/types.ts에서 re-export.
import type { CredentialRecoveryFailure, CredentialRecoveryResult } from "./credential-recovery";
import type {
  MultimodalProvider,
  MultimodalProviderStatus,
  MultimodalSettings,
} from "./multimodal";
import type {
  BrowserCredentialConsent,
  BrowserCredentialImportResult,
  BrowserCredentialScanResult,
} from "./browser-credentials";
import type { OberonTitleSpec } from "./oberon-titles";
import type { OneSurfaceManifestV1 } from "./one-surface";
import type { DurableOneSurfaceResult } from "./one-surface-durable";
import type { OneFriendlyFollowupPlanV1 } from "./one-friendly-followups";
import type {
  OneOperatingPrincipleCreateInput,
  OneOperatingPrincipleDeleteInput,
  OneOperatingPrincipleEnabledInput,
  OneOperatingPrincipleUpdateInput,
  OneProfile,
  OneProfileUpdateInput,
} from "./one-profile";
import type {
  AcknowledgeOneFeatureIntroInput,
  DeferOneFeatureIntroInput,
  OneFeatureIntroState,
} from "./one-feature-intro";
import type {
  GetOneActivationStateInput,
  OneActivationState,
  ResolveOneActivationConcernInput,
  ResolveOneActivationMobileInput,
  ResolveOneActivationWorkInput,
  SkipOneActivationInput,
} from "./one-activation";
import type {
  OneBriefingActionPacket,
  OneBriefingActionRef,
  OneBriefingActionStartResult,
  OneBriefingChannel,
  OneBriefingFeedback,
  OneBriefingPreferences,
  OneBriefingSnapshot,
  OpenOneBriefingTaskInput,
  OpenOneBriefingTaskResult,
  PrepareOneBriefingActionInput,
  StartOneBriefingActionInput,
} from "./one-briefing";
import type {
  ConnectOneProjectDeadlineInput,
  OneProjectDeadlineState,
  RemoveOneProjectDeadlineInput,
} from "./one-project-deadline";
import type {
  AcknowledgeOneTeamPreflightInput,
  AcknowledgeOneTeamPreflightResult,
  AutoResolveOneTeamPreflightInput,
  OneTeamPreflightProposal,
  OneTeamPreflightRef,
  PrepareOneTeamPreflightInput,
  PrepareOneTeamPreflightResult,
  ResolveOneTeamPreflightInput,
  ResolveOneTeamPreflightResult,
} from "./one-team-preflight";
import type {
  BindOneAttachmentsToTeamInput,
  DiscardOneAttachmentsInput,
  OneAttachmentRef,
  PrepareOneAttachmentsInput,
  PreparedOneAttachments,
} from "./one-attachments";
import type { OneRecurrenceSelectionV1 } from "./one-recurrence";
import type {
  OneArtifactBindingRequestV1,
  OneArtifactPreviewCapabilityV1,
  OneArtifactPreviewRevokeV1,
} from "./one-artifacts";
import type {
  DeleteOneMemoryAssetInput,
  DeleteOneMemoryCandidateInput,
  EditAndSaveOneMemoryCandidateInput,
  OneMemoryAsset,
  OneMemoryCandidate,
  OneMemoryMutationResult,
  OneMemorySavedResult,
  OneMemoryState,
  OneMemoryUseOnceRef,
  OneMemoryUseOnceReceipt,
  OneMemoryUseOnceTarget,
  ProposeOneMemoryCandidateInput,
  RejectOneMemoryCandidateInput,
  SaveOneMemoryCandidateInput,
  SetOneMemoryAssetEnabledInput,
  UpdateOneMemoryAssetInput,
  UseOneMemoryCandidateOnceInput,
} from "./one-memory";
import type { OneMemoryMapSnapshot } from "./one-memory-map";
import type {
  AddOneOrgMemberInput,
  ArchiveOneOrgMemberInput,
  CreateOneTeamAgentInput,
  CreateOneTeamAgentResult,
  OneOrgCompletionSummary,
  MarkOneOrgMemberReadInput,
  OneOrgState,
  ReorderOneOrgMembersInput,
  ReplaceOneOrgMemberInput,
  RenameOneOrgMemberInput,
  SetOneOrgMemberToolsInput,
  UpdateOneOrgMemberInput,
} from "./one-org";
import type {
  CreateOneTaskforceInput,
  OneTaskforce,
  RemoveOneTaskforceInput,
  UpdateOneTaskforceInput,
} from "./one-taskforces";
import type { ComputerHistoryDraftPrompt, ComputerHistoryState } from "./computer-history";
import type {
  AcceptOneSuggestionForReviewInput,
  DismissOneSuggestionInput,
  NeverAskOneSuggestionInput,
  OneEcosystemSuggestion,
  OneSuggestionReviewHandoff,
  OneSuggestionReviewHandoffInput,
  OneSuggestionMutationResult,
  OneSuggestionReviewRequest,
  OneSuggestionState,
  SnoozeOneSuggestionInput,
} from "./one-suggestions";
import type { OneSuggestionReviewSeed } from "./one-review-seed";
import type {
  PluginBuilderAnswers,
  PluginBuilderDraftInput,
  PluginBuilderPhase,
  PluginBuilderProgressEvent,
  PluginBuilderSeed,
  PluginBuilderSession,
  PluginBuilderSessionInput,
  PluginDraftResult,
  PluginGateReport,
  PluginInstallReceipt,
  PluginProofReceipt,
} from "./plugin-builder";
import type {
  ProductExtensionInstallReceipt,
  ProductExtensionStatus,
  ProductExtensionUninstallReceipt,
  ProductExtensionViewBounds,
  ProductExtensionViewStatus,
  ScienceSuiteInstallReceipt,
  ScienceSuiteStatus,
} from "./product-extension";
import type {
  GetOneHubDerivativeDraftInput,
  OneHubDerivativeDraft,
} from "./one-hub-derivative";
import type {
  OneValueClosureMutationResult,
  OneValueClosureRecord,
  OneValueClosureState,
  SetOneValueClosureReflectionInput,
} from "./one-value-closure";
import type {
  OneWeeklyReflectionSnapshotV1,
  ResolveOneWeeklyReflectionInputV1,
} from "./one-weekly-reflection";
import type {
  OneImprovementProofRecord,
  OneImprovementProofReadState,
} from "./one-improvement-proof";
import type { ToolFailureCode } from "./tool-failure";
import type {
  OneExperienceReuseRecord,
  OneExperienceReuseState,
} from "./one-experience-reuse";
import type {
  AgentlasOneTaskProjectionV1,
  OneTaskProjectionListRequest,
  OneTaskProjectionRequest,
} from "./one-task-projection";
import type {
  OneSearchPageV1,
  OneSearchRequestV1,
  OneTaskArchiveMutationInputV1,
  OneTaskArchiveMutationResultV1,
} from "./one-search";
export type {
  AddOneOrgMemberInput,
  ArchiveOneOrgMemberInput,
  CreateOneTeamAgentInput,
  CreateOneTeamAgentResult,
  OneOrgMember,
  OneOrgCompletionSummary,
  MarkOneOrgMemberReadInput,
  OneOrgSource,
  OneOrgState,
  OneOrgStatusKind,
  OneOrgSlots,
  ReorderOneOrgMembersInput,
  ReplaceOneOrgMemberInput,
  RenameOneOrgMemberInput,
  UpdateOneOrgMemberInput,
} from "./one-org";
export type {
  CreateOneTaskforceInput,
  OneTaskforce,
  RemoveOneTaskforceInput,
  UpdateOneTaskforceInput,
} from "./one-taskforces";
export type {
  ComputerHistoryDraftPrompt,
  ComputerHistoryEntry,
  ComputerHistoryRecommendation,
  ComputerHistorySource,
  ComputerHistoryState,
} from "./computer-history";
export type {
  OneOperatingPrinciple,
  OneOperatingPrincipleCreateInput,
  OneOperatingPrincipleDeleteInput,
  OneOperatingPrincipleEnabledInput,
  OneOperatingPrincipleScope,
  OneOperatingPrincipleUpdateInput,
  OneProfile,
  OneProfileDeviceProjection,
  OneProfileLocale,
  OneProfileUpdateInput,
} from "./one-profile";
export type {
  GetOneHubDerivativeDraftInput,
  OneHubDerivativeDraft,
  OneHubDerivativeExcludedSummary,
  OneHubDerivativeExclusionCategory,
  OneHubDerivativeIncludedFile,
  OneHubDerivativeState,
  OneHubDerivativeUnknownGate,
} from "./one-hub-derivative";
export type {
  AcknowledgeOneFeatureIntroInput,
  DeferOneFeatureIntroInput,
  OneFeatureIntroAcknowledgement,
  OneFeatureIntroBlockingStateCategory,
  OneFeatureIntroDeferral,
  OneFeatureIntroResolution,
  OneFeatureIntroState,
} from "./one-feature-intro";
export type {
  GetOneActivationStateInput,
  OneActivationConcernStep,
  OneActivationEligibility,
  OneActivationFirstValueStep,
  OneActivationMobileResolution,
  OneActivationMobileStep,
  OneActivationRoute,
  OneActivationState,
  OneActivationStatus,
  OneActivationWorkNavigationStep,
  ResolveOneActivationConcernInput,
  ResolveOneActivationMobileInput,
  ResolveOneActivationWorkInput,
  SkipOneActivationInput,
} from "./one-activation";
export type {
  OneRecurrenceCadence,
  OneRecurrenceIntentKind,
  OneRecurrenceSelectionV1,
} from "./one-recurrence";
export type {
  OneArtifactBindingRequestV1,
  OneArtifactPreviewCapabilityV1,
  OneArtifactPreviewRevokeV1,
} from "./one-artifacts";
export type {
  OneBriefingActionFailureCategory,
  OneBriefingActionPacket,
  OneBriefingActionPacketStatus,
  OneBriefingActionRef,
  OneBriefingActionStartResult,
  OneBriefingCadence,
  OneBriefingChannel,
  OneBriefingConfidence,
  OneBriefingEvidence,
  OneBriefingFeedback,
  OneBriefingFreshness,
  OneBriefingKind,
  OneBriefingPreferences,
  OneBriefingPreparedAction,
  OneBriefingReasonCode,
  OneBriefingSnapshot,
  OpenOneBriefingTaskInput,
  OpenOneBriefingTaskResult,
  OneProactiveBriefing,
  PrepareOneBriefingActionInput,
  StartOneBriefingActionInput,
} from "./one-briefing";
export type {
  ConnectOneProjectDeadlineInput,
  OneProjectDeadlineCheck,
  OneProjectDeadlineLeadMinutes,
  OneProjectDeadlineState,
  RemoveOneProjectDeadlineInput,
} from "./one-project-deadline";
export type {
  AcknowledgeOneTeamPreflightInput,
  AcknowledgeOneTeamPreflightResult,
  AutoResolveOneTeamPreflightInput,
  OneTeamMemberUnavailableReason,
  OneTeamPreflightComplexityReason,
  OneTeamPreflightInputScope,
  OneTeamPreflightPermission,
  OneTeamPreflightPermissionScope,
  OneTeamPreflightProposal,
  OneTeamPreflightRef,
  OneTeamPreflightResolution,
  OneTeamPreflightRole,
  OneTeamPreflightStatus,
  PrepareOneTeamPreflightInput,
  PrepareOneTeamPreflightResult,
  ResolveOneTeamPreflightInput,
  ResolveOneTeamPreflightResult,
} from "./one-team-preflight";
export type {
  DeleteOneMemoryAssetInput,
  DeleteOneMemoryCandidateInput,
  EditAndSaveOneMemoryCandidateInput,
  OneMemoryAsset,
  OneMemoryCandidate,
  OneMemoryCandidateResolution,
  OneMemoryCandidateSource,
  OneMemoryCandidateStatus,
  OneMemoryInvocationScope,
  OneMemoryMutationResult,
  OneMemoryProposalBasis,
  OneMemorySavedResult,
  OneMemoryScope,
  OneMemoryState,
  OneMemoryUseOnceRef,
  OneMemoryUseOnceReceipt,
  OneMemoryUseOnceTarget,
  ProposeOneMemoryCandidateInput,
  RejectOneMemoryCandidateInput,
  SaveOneMemoryCandidateInput,
  SetOneMemoryAssetEnabledInput,
  UpdateOneMemoryAssetInput,
  UseOneMemoryCandidateOnceInput,
} from "./one-memory";
export type {
  OneMemoryMapEdge,
  OneMemoryMapKind,
  OneMemoryMapNode,
  OneMemoryMapRelation,
  OneMemoryMapScope,
  OneMemoryMapSnapshot,
} from "./one-memory-map";
export type {
  AcceptOneSuggestionForReviewInput,
  ArbitrateOneSuggestionInput,
  DismissOneSuggestionInput,
  MarkOneSuggestionIgnoredInput,
  NeverAskOneSuggestionInput,
  OneAgentBuildProposal,
  OneAgentBuildSignal,
  OneAutomationPermissionPreview,
  OneAutomationPreview,
  OneAutomationProposal,
  OneAutomationSignal,
  OneEcosystemSuggestion,
  OneHubDerivativeProposal,
  OneHubDerivativeSignal,
  OneHubEconomyAvailability,
  OneHubPrivateExclusion,
  OneRetainTeamProposal,
  OneRetainTeamSignal,
  OneSuggestionArbitrationReason,
  OneSuggestionArbitrationResult,
  OneSuggestionCandidateSignals,
  OneSuggestionMutationResult,
  OneSuggestionPatternFeedback,
  OneSuggestionProposal,
  OneSuggestionReviewHandoff,
  OneSuggestionReviewHandoffInput,
  OneSuggestionReviewSurface,
  OneSuggestionReviewKind,
  OneSuggestionReviewRequest,
  OneSuggestionState,
  OneSuggestionStatus,
  OneSuggestionSuppression,
  OneSuggestionSuppressionMode,
  OneSuggestionTaskArbitration,
  OneSuggestionTaskEvidence,
  OneSuggestionType,
  SnoozeOneSuggestionInput,
} from "./one-suggestions";
export type {
  OneAgentBuildReviewSeed,
  OneAutomationReviewSeed,
  OneBlockedReviewSeed,
  OneHubDerivativeReviewSeed,
  OneRetainTeamReviewSeed,
  OneReviewInstalledAgentRef,
  OneReviewSeedBinding,
  OneReviewSeedBlockedReason,
  OneReviewSeedSurface,
  OneSuggestionReviewSeed,
} from "./one-review-seed";
export type {
  PluginBuilderAnswers,
  PluginBuilderDraftInput,
  PluginBuilderPhase,
  PluginBuilderProgressEvent,
  PluginBuilderSeed,
  PluginBuilderSession,
  PluginBuilderSessionInput,
  PluginDraftResult,
  PluginGateReport,
  PluginInstallReceipt,
  PluginProofReceipt,
} from "./plugin-builder";
export type {
  ProductExtensionInstallReceipt,
  ProductExtensionStatus,
  ProductExtensionUninstallReceipt,
  ProductExtensionViewBounds,
  ProductExtensionViewStatus,
  ScienceSuiteInstallProgress,
  ScienceSuiteInstallReceipt,
  ScienceSuiteStatus,
} from "./product-extension";
export type {
  CreateOneValueClosureInput,
  OneOriginalPreservationStatus,
  OneTrustedOutcomeEvidence,
  OneTrustedOutcomeEvidenceKind,
  OneTrustedOutcomeEvidenceSource,
  OneValueClosureEstimate,
  OneValueClosureEstimateItem,
  OneValueClosureFactItem,
  OneValueClosureLifecycleClaim,
  OneValueClosureMutationResult,
  OneValueClosureOriginalPreservation,
  OneValueClosureOutcomeStatus,
  OneValueClosurePhase,
  OneValueClosurePhaseStatus,
  OneValueClosureRecord,
  OneValueClosureReflection,
  OneValueClosureRemainingOwner,
  OneValueClosureRemainingStatus,
  OneValueClosureRemainingWork,
  OneValueClosureState,
  OneValueClosureV1,
  OneValueClosureValueItem,
  SetOneValueClosureReflectionInput,
} from "./one-value-closure";
export type {
  OneWeeklyReflectionEstimateV1,
  OneWeeklyReflectionFactV1,
  OneWeeklyReflectionOutcomeV1,
  OneWeeklyReflectionPreservationV1,
  OneWeeklyReflectionRemainingWorkV1,
  OneWeeklyReflectionSnapshotV1,
  OneWeeklyReflectionStatus,
  OneWeeklyReflectionTimeZoneSource,
  OneWeeklyReflectionV1,
  ResolveOneWeeklyReflectionInputV1,
} from "./one-weekly-reflection";
export type {
  OneImprovementAssetBinding,
  OneImprovementAssetControl,
  OneImprovementAssetType,
  OneImprovementAssetVersionRef,
  OneImprovementBaselineTaskRef,
  OneImprovementChangeKind,
  OneImprovementChangeV1,
  OneImprovementComparisonDirection,
  OneImprovementComparisonRecord,
  OneImprovementEstimateChangeV1,
  OneImprovementEstimateV1,
  OneImprovementEvidenceType,
  OneImprovementMeasuredChangeV1,
  OneImprovementProofRecord,
  OneImprovementProofReadState,
  OneImprovementProofState,
  OneImprovementProofV1,
  OneImprovementQualitativeChangeV1,
  OneImprovementResult,
  OneImprovementReusedAssetV1,
  OneImprovementRuntimeAssetKind,
} from "./one-improvement-proof";
export type {
  OneExperienceReuseAssetBinding,
  OneExperienceReuseReceiptV1,
  OneExperienceReuseRecord,
  OneExperienceReuseScope,
  OneExperienceReuseState,
} from "./one-experience-reuse";
export type {
  AgentlasOneTaskProjectionV1,
  OneTaskProjectionActionIntent,
  OneTaskProjectionConnection,
  OneTaskProjectionListRequest,
  OneTaskProjectionMode,
  OneTaskProjectionMutationMode,
  OneTaskProjectionPendingIntent,
  OneTaskProjectionPendingOperation,
  OneTaskProjectionRequest,
  OneTaskProjectionSemanticAction,
  OneTaskProjectionStatusSource,
  OneTaskProjectionStatusValue,
  OneTaskProjectionSurface,
} from "./one-task-projection";
export type {
  OneSearchHitKind,
  OneSearchHitV1,
  OneSearchMatchKind,
  OneSearchPageV1,
  OneSearchRequestV1,
  OneTaskArchiveMutationInputV1,
  OneTaskArchiveMutationResultV1,
} from "./one-search";
import type {
  SiteAgentAppPublishBackendRequest,
  SiteAgentAppPublishBackendResult,
  SiteAgentAppPublishConnectResult,
  SiteAgentAppPublishProviderStatus,
  SiteAgentAppPublishTokenResult,
  SiteAgentAppLaunchResult,
  SiteAgentAppMcpRecommendation,
  SiteAgentAppRuntimeStatus,
  SiteAgentAppScaffoldSummary,
  SiteAgentAppTargetRef,
  SiteAgentAppThumbnailResult,
  SiteConversationEntry,
  SiteDeleteProjectResult,
  SiteProjectPublicMeta,
  SiteProjectOperation,
  SitePublishProvider,
  SitePublishProviderPage,
  SiteScreenMeta,
  SiteSurface,
  SiteWorkspaceHandoff,
} from "./site-studio";
import type {
  MobileBridgeOntologyAttachReceiptDto,
  MobileBridgeOntologyProjectionDto,
  MobileBridgePairingPayload,
} from "./mobile-bridge";
import type {
  HephaestusBuildStartResult,
  McpBuildAttachmentReceipt,
  McpBuildConsent,
  McpBuildPlan,
  McpBuildRecommendationInput,
} from "./mcp-plan";
import type {
  ExperienceCandidateCaptureInput,
  ExperienceCandidateRecord,
  ExperienceIntakeDiagnostics,
  ExperienceOntologyGraphSnapshot,
  ExperiencePublicUnsealInput,
  LocalTasteDraftRecord,
  ExperienceOntologySummary,
  ExperienceExportIntentInput,
  ExperienceExportIntentRecord,
  ExperiencePackCreateInput,
  ExperiencePackListInput,
  ExperiencePackRecord,
  ExperienceMcpRequirement,
  ExperiencePromotionInput,
  ExperiencePromotionReceipt,
  OperationalPublicProjectionRecord,
  OperationalPublicProjectionSourceBinding,
  OperationalPublicProjectionSaveInput,
  OperationalPublicProjectionConfirmInput,
  ExperienceBaseReleaseResolution,
  ExperienceCloudExportResult,
  ExperienceCloudReconcileInput,
  ExperienceCloudSaveInput,
  ExperienceCloudUploadReceipt,
  ExperienceCloudUploadRecord,
  ExperienceCloudWithdrawInput,
  PortableExperienceBundle,
  TasteChipWorkflowRecord,
  TasteGeneralizationInput,
  TasteGeneralizationConfirmInput,
  TastePreviewPrepareInput,
  TasteHubUploadInput,
  TastePreviewGrant,
} from "./experience";
export type {
  HephaestusBuildStartResult,
  McpBuildAttachmentReceipt,
  McpBuildCandidate,
  McpBuildCandidateReadiness,
  McpBuildCandidateSource,
  McpBuildPermissionBasis,
  McpBuildRecommendationReasonCode,
  McpBuildConsent,
  McpBuildFallbackReceipt,
  McpBuildKeyState,
  McpBuildPlan,
  McpBuildReceiptItem,
  McpBuildReceiptItemStatus,
  McpBuildReceiptReason,
  McpBuildRecommendationInput,
} from "./mcp-plan";
export type {
  ExperienceCandidateCaptureInput,
  ExperienceCandidateRecord,
  ExperienceIntakeDiagnostics,
  ExperiencePublicUnsealInput,
  ExperienceOntologyGraphEdge,
  ExperienceOntologyGraphEdgeKind,
  ExperienceOntologyGraphNode,
  ExperienceOntologyGraphNodeKind,
  ExperienceOntologyGraphNodeSource,
  ExperienceOntologyGraphNodeStatus,
  ExperienceOntologyGraphSnapshot,
  LocalTasteDraftRecord,
  ExperienceOntologySummary,
  OntologyRelationGraphV1Edge,
  OntologyRelationGraphV1Node,
  OntologyRelationGraphV1Snapshot,
  ExperienceAutoIntakeSummary,
  CanonicalExperienceEnvironmentProfile,
  ExperienceContextSelection,
  ExperienceEnvironment,
  ExperienceExportIntentInput,
  ExperienceExportIntentRecord,
  ExperiencePackCreateInput,
  ExperiencePackListInput,
  ExperiencePackRecord,
  ExperienceMcpRequirement,
  ExperiencePromotionInput,
  ExperiencePromotionReceipt,
  OperationalPublicProjectionRecord,
  OperationalPublicProjectionSourceBinding,
  OperationalPublicProjectionSaveInput,
  OperationalPublicProjectionConfirmInput,
  ExperienceVerificationMethod,
  ExperienceBaseReleaseResolution,
  ExperienceCloudExportResult,
  ExperienceCloudLocalState,
  ExperienceCloudReconcileInput,
  ExperienceCloudSaveInput,
  ExperienceCloudServerStatus,
  ExperienceCloudUploadReceipt,
  ExperienceCloudUploadRecord,
  TasteChipWorkflowRecord,
  TasteGeneralizationInput,
  TasteGeneralizationConfirmInput,
  TastePreviewPrepareInput,
  TasteHubUploadInput,
  TasteAxis,
  TastePreviewRights,
  TastePreviewGrant,
  ExperienceCloudWithdrawInput,
  PortableExperienceBundle,
  PortableExperienceItem,
  PortableExperienceMcpRequirement,
  PortableExperiencePack,
  PortableExperienceVisibility,
} from "./experience";
export type {
  OberonLowerThird,
  OberonSubtitleCue,
  OberonTextStyle,
  OberonTitleCard,
  OberonTitleSpec,
} from "./oberon-titles";
export type {
  MultimodalModality,
  MultimodalProvider,
  MultimodalProviderMode,
  MultimodalProviderStatus,
  MultimodalSettings,
} from "./multimodal";

/**
 * "acp" is the open seat (PRD 2026-08-15 Phase B-1): any agent that speaks the
 * Agent Client Protocol — built-in specs (OpenCode, Goose, Copilot CLI, …) or a
 * user-registered TerminalProfile in ACP mode — is detected and dispatched
 * through the generic ACP runner without a new RuntimeKind per vendor. Which
 * agent a status row is: `RuntimeStatus.acpAgentId`; display name: `label`.
 */
export type RuntimeKind = "claude-code" | "codex" | "antigravity" | "kimi" | "grok" | "cursor" | "byok" | "ollama" | "lmstudio" | "mlx" | "acp" | "agentlas";
// 역할 목록·성격의 정본은 shared/runtime-roles.ts 하나다(손으로 쓴 배열 금지).
import type { RuntimeRole } from "./runtime-roles";
export type { RuntimeRole };
export { RUNTIME_ROLES, RUNTIME_ROLE_TRAITS, CONVERSATIONAL_ROLES, POOL_AUTOPICK_ROLES, isRuntimeRole } from "./runtime-roles";

/**
 * 사용자 편집형 터미널 프로필 — Paseo식 "프로바이더". 하드코딩된 claude/codex/antigravity와
 * 달리, 사용자가 임의의 CLI를 등록한다. `template`의 `{{{prompt}}}`가 메시지로 치환돼
 * 실행된다(예: `claude {{{prompt}}}`, `opencode --prompt={{{prompt}}}`).
 * ★런타임 dispatch 배선(RuntimeKind 편입)은 후속 단계 — 지금은 설정 저장/조회만.
 */
export interface TerminalProfile {
  id: string;
  name: string;
  /** template 모드: 반드시 `{{{prompt}}}`를 포함(없으면 메시지가 실행 커맨드에 안 들어감). acp 모드에서는 비워도 된다. */
  template: string;
  enabled: boolean;
  /**
   * "acp": the profile is an Agent Client Protocol agent — `acp.command` +
   * `acp.args` spawn it, and it shows up in the engine picker as kind "acp"
   * (PRD 2026-08-15 B-1). Absent/"template" keeps the legacy save-only template.
   */
  mode?: "template" | "acp";
  acp?: { command: string; args: string[] };
}

/** LLM 제공자. "ollama"/"lmstudio"/"mlx"는 로컬 머신에서 도는 오픈 모델(gemma/deepseek/qwen 등). */
export type RuntimeBackend =
  | "anthropic"
  | "openai"
  | "google"
  | "ollama"
  | "lmstudio"
  | "mlx"
  | "upstage"
  | "custom"
  // Anthropic Messages API 호환 서드파티(구독/종량제 코딩 플랜)
  | "glm"
  | "kimi"
  | "deepseek"
  | "minimax"
  | "xai"
  | "openrouter"
  | "cursor"
  // Agentlas 서빙 — 우리 서버가 모델을 고른다. 사용자가 고르는 것은 세기뿐이다.
  | "agentlas";

export interface RuntimeSelection {
  kind: RuntimeKind;
  backend?: RuntimeBackend;
  source?: string;
  /** Persistent role default. Omitted means orchestrator for backward compatibility. */
  role?: RuntimeRole;
  /** Worker-only quality-first inheritance. true means use the orchestrator selection. */
  inherit?: boolean;
  /** ollama·BYOK 등 모델을 골라야 하는 LLM에서 활성 모델 이름 (예: "llama3.1", "claude-opus-4-8") */
  model?: string;
  /** BYOK 긴 컨텍스트(1M) opt-in 토글. beta-header 모델에만 의미. (auto 모델은 항상 ON 취급) */
  longContext?: boolean;
  /** 작업량(reasoning effort) — Claude Code `--effort` 전용. "" 또는 미설정이면 기본. */
  effort?: string;
}

export type AgentRuntimeOverrideScope = "agent" | "firm" | "division";

export interface AgentRuntimeOverride {
  scope: AgentRuntimeOverrideScope;
  /** agent id, firm id, or `${firmId}:${divisionNodeId}` for division-wide defaults. */
  targetId: string;
  /** User-facing source label such as agent name, firm name, or division role. */
  label?: string | null;
  selection: RuntimeSelection;
  updatedAt: string;
}

export interface AgentRuntimeOverrideSetInput {
  scope: AgentRuntimeOverrideScope;
  targetId: string;
  label?: string | null;
  selection: RuntimeSelection;
}

/** CLI(Claude/Codex/Antigravity)에서 스캔한 슬래시 명령 — 챗 입력 `/` 자동완성에 노출. */
/**
 * 에이전트의 동기 질문 — 도구가 답을 기다리는 질문(electron/confirm/ask-user.ts).
 * 기존 `<<agentlas-ask>>` 펜스는 비동기라 도구가 결과를 받을 수 없었다.
 */
export interface AskUserRequestEvent {
  requestId: string;
  question: string;
  options: { label: string; description?: string }[];
  allowFreeText: boolean;
  askedBy: string | null;
  chatId: string | null;
  createdAt: number;
  /** 0 이면 이 질문은 끝났다(만료·취소) — 시트에서 치우라는 신호. */
  expiresAt: number;
}

export interface RuntimeCommand {
  /** "/deploy", "/frontend:component" 등 (앞에 / 포함) */
  name: string;
  description: string;
  source: "claude-code" | "codex" | "antigravity" | "cursor";
}

export interface RuntimeStatus {
  /**
   * 모델을 지정하지 않고("엔진 설정 사용") 이 런타임을 돌렸을 때 **실제로 쓰인 모델 id**.
   * 실행 결과에서만 나오는 값이라 벤더가 세대를 올려도 저절로 따라간다.
   * 한 번도 안 돌렸으면 미설정 — 짐작해서 채우지 않는다.
   */
  observedDefaultModel?: string;

  /** Credential access is separate from runtime/model discovery; absence has no runtime row. */
  credentialAccess?:
    | { status: "available" }
    | { status: "unavailable"; errorCode: "keychain_unavailable" | "credential_read_failed" };
  kind: RuntimeKind;
  backend: RuntimeBackend;
  /** CLI 경로 또는 "byok:<backend>" 또는 "ollama" */
  source: string;
  /** CLI 감지된 버전 — BYOK은 null. ollama는 서버 버전 */
  version: string | null;
  /**
   * 이 런타임이 로그인 실패를 냈고 아직 성공한 적이 없다.
   *
   * 이 앱은 CLI 파일이 있고 버전이 나오면 화면에 "연결됨"이라고 썼다. 로그인 상태는 한 번도
   * 보지 않았다. 그래서 계정이 만료된 런타임이 초록불로 보였고, 실행은 계속 실패했고, 푸는
   * 길은 사용자가 터미널을 직접 열어 로그인하는 것뿐이었다. 화면은 이제 이 칸을 보고
   * "로그인 필요"라고 말할 수 있고, 그 자리에서 로그인을 열 수 있다.
   */
  signInRequired?: { since: string; message: string };
  /** 사용자가 현재 이 LLM을 활성으로 선택했는지 */
  active: boolean;
  /** Persistent role defaults that currently resolve to this runtime. */
  activeRoles?: RuntimeRole[];
  /** Exact per-role model/effort selection, including worker inheritance. */
  roleSelections?: Partial<Record<RuntimeRole, RuntimeSelection>>;
  /** Display name when the kind alone is not enough (kind "acp": the agent's name). */
  label?: string;
  /** kind "acp": which ACP agent spec (built-in id such as "opencode", or "profile:<TerminalProfile.id>"). */
  acpAgentId?: string;
  /** ollama·BYOK 활성 모델 이름. 모델 개념 없는 LLM은 미설정 */
  model?: string | null;
  /** ollama가 로컬에 받아둔 모델 목록 (설정 화면의 모델 선택용). 그 외 LLM은 미설정 */
  availableModels?: string[];
  /**
   * How `availableModels` was obtained (PRD 2026-08-15 D-3). `failed` means the
   * probe ran and yielded nothing usable — the picker may show a stale last-good
   * list (`stale: true`), and the UI must say so instead of showing an empty
   * menu that falsely implies an engine-level model fallback. `unsupported` is honest
   * absence (no list concept, e.g. claude-code) — not an error.
   */
  modelDiscovery?: import("./model-discovery").ModelDiscoverySummary;
  /**
   * Execution inventory for automatic allocation, built by the
   * model-advertisement adapter. Live discovery is authoritative; runtimes
   * whose vendor-maintained aliases are the only inventory (claude-code 등
   * 디스커버리 개념이 없는 CLI) advertise catalog aliases as a fallback, paired
   * with the swarm worker's failed-allocation retry. Display-only catalogs
   * that cannot vouch for entitlement (cursor) must not fall back.
   */
  allocationModels?: string[];
  /** Optional host-authored facts for exact automatic allocation. Model IDs remain opaque. */
  allocationModelProfiles?: Record<string, {
    costTier?: "economy" | "balanced" | "frontier";
    contextWindow?: number;
    capabilities?: string[];
    supportsTools?: boolean;
    supportsMultimodal?: boolean;
    /** Per-model reasoning levels reported by the host runtime. */
    efforts?: string[];
    /** Host-provided effort to use when a chat has not pinned one. */
    defaultEffort?: string;
  }>;
  /** BYOK 긴 컨텍스트(1M) 토글 상태. beta-header 모델에서만 의미 있음. */
  longContextEnabled?: boolean;
  /** 작업량(reasoning effort) 현재 선택값. 명시 조절이 없는 런타임은 `none`. */
  effort?: string | null;
  /** 이 런타임이 지원하는 작업량 레벨. 명시 조절이 없으면 `none`만 채움. */
  efforts?: Array<{ id: string; label: string }>;
}

/** 역할 풀의 후보 1명 — position이 곧 우선순위(1이 최우선). */
export interface RuntimeRoleMember {
  role: RuntimeRole;
  position: number;
  selection: RuntimeSelection;
  updatedAt: string;
}

/** 풀 해석에서 건너뛴 멤버와 사유 — 조용한 폴백 금지, UI/영수증에 그대로 노출. */
export interface RuntimeRolePoolSkip {
  position: number;
  kind: RuntimeKind;
  model: string | null;
  /**
   * runtime-unavailable: 그 CLI/백엔드가 이 컴퓨터에 없다.
   * model-unavailable: CLI는 있는데 그 모델이 카탈로그에 없다(호출하면 실패한다).
   * quota-exceeded: 마지막 정상 사용량 스냅샷의 창 사용률이 임계 이상.
   */
  reason: "runtime-unavailable" | "model-unavailable" | "quota-exceeded";
}

/** 역할 풀의 현재 해석 결과 — 어느 멤버가 선택됐고 누가 왜 스킵됐는가. */
export interface RuntimeRolePoolPick {
  role: RuntimeRole;
  selection: RuntimeSelection;
  /** null = 풀이 아니라 단일 행/레거시 해석에서 나온 선택. */
  position: number | null;
  /** worker 풀이 비어 오케스트레이터 풀을 상속했는가. */
  inherited: boolean;
  skipped: RuntimeRolePoolSkip[];
}

export interface RuntimeRolePoolState {
  members: Record<RuntimeRole, RuntimeRoleMember[]>;
  picks: Partial<Record<RuntimeRole, RuntimeRolePoolPick>>;
}

/**
 * 에이전트가 동작하려면 필요한 환경변수 1개.
 * 예: Notion 통합 에이전트는 NOTION_API_KEY 필요.
 *
 * 데스크톱 글로벌 vault(keychain)에 한 번 저장하면 모든 에이전트가 재사용.
 * MCP 서버 spawn 시 자식 프로세스 env로 자동 주입 (M1).
 */
export interface AgentEnvRequirement {
  /** env 키 이름 — 외부 표준 따라가는 게 좋음 (NOTION_API_KEY 등) */
  key: string;
  label: string;
  labelEn: string;
  /** false면 없어도 동작은 함 (제한된 기능) */
  required: boolean;
  /** 어디서 얻는지 한 줄 안내 (URL이면 클릭 가능하게) */
  hint?: string;
  hintEn?: string;
}

export type AgentVisibility = "visible" | "background" | "private";

export interface InstalledAgent {
  id: string;
  slug: string;
  /** 한국어 표시명 (기본 / fallback) */
  name: string;
  /** 영어 표시명. 비어있으면 name fallback */
  nameEn: string;
  /** Desktop-only alias. Source package names/slugs/hashes remain immutable. */
  localDisplayName?: string;
  /** 한국어 한 줄 설명 */
  tagline: string;
  /** 영어 한 줄 설명 */
  taglineEn: string;
  /** LLM에 보낼 시스템 프롬프트 — 단일. LLM이 사용자 입력 언어에 자동 매칭 */
  systemPrompt: string;
  mcpServers: string[];
  /** 이 에이전트가 동작에 필요한 env 변수들 */
  envRequirements: AgentEnvRequirement[];
  preferredBackend: RuntimeBackend | null;
  trustGrade: "A" | "B" | "C" | "unknown";
  installedAt: string;
  tone: "blue" | "green" | "purple" | "amber" | "peach";
  /** 로컬 폴더에서 임포트한 경우: 전용 CLI 런타임 라벨. legacy GEMINI.md 패키지 라벨은 gemini로 보존한다. */
  runtimeLabel?: "claude-code" | "codex" | "gemini" | "cursor" | "generic";
  /** 로컬 임포트 원본 폴더 절대경로 (있으면 파일 패널이 이 폴더를 사용) */
  localPath?: string;
  /**
   * ISO time when this agent's source folder was first seen unreadable.
   * Present only for local agents whose folder is currently gone (deleted,
   * moved, or on an unmounted disk). The agent is intentionally kept — this
   * lets the UI explain why it cannot run and offer repair/remove instead of
   * showing a silently broken row.
   */
  sourceMissingSince?: string;
  /** 실행 폴더의 권위 출처. Agent Cloud 복원본도 로컬 실행을 위해 localPath를 가진다. */
  assetSource?: "local-import" | "agent-cloud" | "hub";
  /** Agent Cloud 복원본의 검증된 불변 package hash. */
  packageHash?: string;
  /** 단일 에이전트 / 팀 */
  kind?: "agent" | "team";
  /** UI/routing contract: visible user agent, background control agent, or private web-only agent. */
  visibility?: AgentVisibility;
  /** v74 소유자 북마크 시각(없으면 북마크 안 됨). 로스터 섹션/별 토글이 읽는다. */
  bookmarkedAt?: string | null;
  /**
   * v75 팀 멤버 세포: 이 에이전트가 소속된 팀(firm)의 id. NULL이면 독립(standalone)
   * 에이전트다. 값이 있으면 조직도 안의 멤버이므로 최상위 로스터(single/multi)에서
   * 숨기고 팀 조직도 안에서만 노출한다(중복 방지).
   */
  parentTeamId?: string | null;
}

/** Main-owned exact remote identity for an installed execution copy. */
export interface InstalledAgentExactBinding {
  installedAgentId: string;
  agentDefinitionId: string;
  agentReleaseId: string;
  source: "hub-install" | "agent-cloud-restore";
  boundAt: string;
}

/** Explicit removal controls used by the organization chart X action. */
export interface InstalledAgentRemovalOptions {
  /** Move a local-import source folder to the OS Trash after registry removal. */
  removeSource?: boolean;
}

export interface InstalledFirmRemovalOptions {
  /** Remove the firm and its materialized member rows, not only the relationship. */
  removeMembers?: boolean;
  /** Move local team source folders to the OS Trash after registry removal. */
  removeSource?: boolean;
}

export interface RosterRemovalResult {
  removed: boolean;
  sourceMovedToTrash: boolean;
  retainedAgentIds?: string[];
}

/**
 * v74 에이전트 사용 원장(run_events 귀속 집계) 행. useCount는 이 에이전트가
 * 참여한 서로 다른 런 수. 삭제된 에이전트 이력도 installed=false로 남는다.
 */
export interface AgentUsageSummaryRow {
  agentId: string;
  kind: string;
  firstUsedAt: string;
  lastUsedAt: string;
  useCount: number;
  bookmarkedAt: string | null;
  installed: boolean;
}

export interface BorrowedAgentRuntimeSnapshot {
  provider: string;
  modelId: string;
  effort: string;
  source: "ai-assigned" | "manual-override" | "safe-fallback";
  recordedAt: string;
}

/**
 * Read-only, owner-scoped career for a Hub asset. This deliberately excludes
 * the origin author's prompt, manifest, package files, and evolution controls.
 */
export interface BorrowedAgentProfile {
  profileId: string;
  agentDefinitionId: string;
  agentReleaseId: string;
  /** Stable package-internal worker id. Empty for the top-level Hub asset. */
  componentId: string;
  slug: string;
  entityKind: "agent" | "team";
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  bookmarkedAt: string | null;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  latestRuntime: BorrowedAgentRuntimeSnapshot | null;
  memoryCount: number;
  relationCount: number;
  hasQuarantinedDeviceHistory: boolean;
}

/**
 * UI용 env 메타 — 값 자체는 main에만, renderer는 hasValue boolean만 받는다.
 */
export interface EnvVarMeta {
  key: string;
  /** null means access was unavailable; false means confirmed missing. */
  hasValue: boolean | null;
  credentialAccess?: "available" | "unavailable";
  /** 저장된 값의 마스킹 미리보기 (메인에서 생성, 전체 평문 아님). 미저장이면 null. */
  preview?: string | null;
  /** 이 env를 요구하는 설치된 에이전트들 (없으면 사용자가 직접 추가한 free-form) */
  requiredBy: Array<{
    agentId: string;
    agentName: string;
    agentNameEn: string;
    /** 그 에이전트의 envRequirements에서 따온 라벨 — 키별로 다른 라벨 가능 */
    label?: string;
    labelEn?: string;
    hint?: string;
    hintEn?: string;
  }>;
}

export interface TeamBundle {
  id: string;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  persona: string;
  agents: Array<Pick<InstalledAgent, "slug" | "name" | "nameEn" | "tagline" | "taglineEn" | "tone" | "visibility">>;
}

export interface MarketplaceListing {
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  trustGrade: "A" | "B" | "C" | "unknown";
  installCount: number;
  manifestUrl: string;
  ownerName?: string;
  publishedAt?: string;
  visibility?: AgentVisibility;
  /** Exact immutable Hub release hash exposed by callable marketplace search rows. */
  packageHash?: string;
  cloudPackage?: CloudAgentPackageDownload;
  /** Owner restore baseline used only for optimistic Cloud writes. */
  cloudRegistration?: CloudAgentRevisionIdentity;
  /**
   * Agent Cloud shelf identity as returned by `cargo.search_agents`. These are
   * the only identifiers an owner-cloud row carries — it has no Hub
   * definition/release pair — so they are declared rather than left to survive
   * only through the untyped record spread in `normalizeListing`.
   */
  cloudId?: string;
  manifestId?: string;
  revision?: string | number;
  kind?: "cloud-callable" | "install-only" | string;
  callable?: boolean;
  routingReady?: boolean;
  routingStatus?: string | null;
  source?: string;
  entityKind?: "agent" | "team" | string;
  perCallCredits?: number;
  verifiedInvocations?: number;
  totalBorrows?: number;
  todayBorrows?: number;
  assetCount?: number;
  agentCount?: number;
  lastRoutingSuccessAt?: string;
  recentFailureRate?: number;
  evalPassRate?: number;
  rating?: number;
  category?: string;
  developer?: string;
  detailUrl?: string;
  installCli?: string;
  /** Plugin provider's real-world site (not the Hub's own detail page). */
  homepage?: string;
  /** Exact immutable Hub identity. Both values must be present to enable Ontology projection. */
  agentDefinitionId?: string;
  agentReleaseId?: string;
  /** Account shelf provenance; never invocation authority. */
  bookmarkState?: "bookmarked" | "used";
  /**
   * Hub 브랜드 자산 — 웹 `/api/plugins`가 내려주는 값을 절대 URL로 올린 것.
   * 웹이 정본이므로 데스크탑에 로고 파일을 복사해 두지 않는다.
   */
  iconUrl?: string;
  brandGlyphUrl?: string;
  brandColor?: string;
  /**
   * 플러그인 행이 "연결해야 쓰는 MCP"인지 "연결할 것이 없는 스킬 묶음"인지.
   * 웹 `/api/plugins`의 `pluginKind`를 그대로 옮긴다 — 판정의 정본은 카탈로그
   * (mcp 행/connectSetup/skills 유무)이고 데스크탑은 재유도하지 않는다.
   * 구버전 허브 응답에는 없으므로 optional이며, 없으면 로컬 폴백이 추정한다.
   */
  pluginKind?: PluginKind;
  /** 번들된 스킬 수(스킬 묶음 판정의 근거). */
  skillCount?: number;
  /** 매니페스트가 검증한 MCP 서버 행 수. 0이면 붙일 서버가 없다. */
  mcpServerCount?: number;
  /** 실서버는 있으나 연결이 계정별로 발급되어 자동 설치가 불가능한 항목. */
  connectSetupRequired?: boolean;
  /**
   * 이 도구가 요구하는 인증 종류. 설치 뒤 무엇을 더 해야 하는지가 여기서 갈린다.
   * 구버전 허브 응답에는 없으므로 optional — 없으면 화면은 종류를 단정하지 않는다.
   */
  authKind?: PluginAuthKind;
  /**
   * 허브가 대표로 고른 항목. 온보딩의 첫 화면은 140개를 다 못 보여주므로 이 표시로
   * 추린다 — 설치수·인기 같은 로컬 추정이 아니라 카탈로그가 선언한 값이다.
   */
  featured?: boolean;
}

/**
 * 플러그인 한 줄의 종류.
 *
 * 왜 나누는가: Slack은 계정과 살아 있는 서버가 있어야 도구가 생기고, Computer Use나
 * Sales는 연결할 것이 아예 없는 스킬 묶음이다. 한 격자에 섞어 놓으면 사용자는
 * "왜 Sales는 API 키를 안 물어보지?"를 제품 결함으로 읽는다. 두 섹터로 나누면
 * 그 차이가 화면에서 먼저 설명된다.
 */
export type PluginKind = "mcp" | "skill";

/**
 * 이 도구를 쓰려면 사용자가 무엇을 해야 하는가. 허브 카탈로그의 `auth`를 그대로 옮긴다.
 *
 * 왜 나누는가: 셋은 사용자에게 요구하는 것이 완전히 다른데 지금까지 한 줄로 취급됐다.
 *  · none    — 아무것도 필요 없다. 고르면 그 자리에서 끝난다.
 *  · oauth   — 그 서비스에 로그인해 권한을 준다. 우리가 대신 처리할 수 있는 유일한 갈래다
 *              (Agentlas 전용 Chrome에 이미 로그인돼 있으면 동의만 누르면 된다).
 *  · api_key
 *  · token   — 사용자가 다른 사이트에서 키를 발급받아 와야 한다. 우리가 줄여줄 수 있는
 *              건 발급 페이지를 열어 주는 것까지다 — 그러니 "지금 말고 나중에"가
 *              1급 선택지여야 한다.
 */
export type PluginAuthKind = "none" | "oauth" | "api_key" | "token";

/** slug 하나에 대한 Hub 브랜드 자산(로고). 웹 카탈로그의 거울이며 정본이 아니다. */
export interface PluginBrandAsset {
  slug: string;
  name: string;
  /** 풀컬러 래스터 아이콘. */
  iconUrl?: string;
  /** 브랜드 컬러 타일 위에 얹는 단색 글리프. */
  brandGlyphUrl?: string;
  brandColor?: string;
}

export interface HubAgentBookmark {
  slug: string;
  listing: MarketplaceListing;
  bookmarkedAt: string;
  /** False means server-observed Hub use, not an explicit user bookmark. */
  bookmarked?: boolean;
}

export interface HubBookmarkSnapshotEvent {
  bookmarks: HubAgentBookmark[];
  syncedAt: string;
}

export interface MarketplaceSourceStatus {
  mode: "mcp" | "memory";
  baseUrl: string | null;
  online: boolean;
  usingFallback: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
}

// ── 외부 MCP 툴 플러그인 (Slack / Discord / GitHub 등 — Codex 스타일) ──
// 에이전트의 mcpServers(문자열 ID)와 별개. 이것은 "실제로 연결되는 외부 MCP 서버"다.
// @modelcontextprotocol/sdk로 stdio(npx) 또는 SSE/HTTP로 붙는다.
export type McpTransport = "stdio" | "sse" | "http";

/** 연결 가능한 외부 MCP 툴 카탈로그 항목 — 설정 가이드(setting_guide)의 외부 툴. */
/** 엔진 skills/ 디렉토리에서 읽은 주입 가능한 스킬 한 건. */
export interface SkillCatalogEntry {
  slug: string;
  name: string;
  description: string;
}

/** Main-owned exact SKILL.md source selected from the Hephaestus catalog. */
export interface SkillCatalogAsset extends SkillCatalogEntry {
  content: string;
  contentHash: string;
  byteLength: number;
}

export interface AgentFileTextSnapshotUi {
  path: string;
  relativePath: string;
  exists: boolean;
  content: string;
  hash: string;
}

export interface McpToolCatalogEntry {
  id: string; // "slack" | "discord" | "github" | "notion" ...
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  category: "communication" | "dev" | "productivity" | "data" | "web" | "custom";
  transport: McpTransport;
  /** stdio 실행 명령 (예: "npx") */
  command?: string;
  /** stdio 인자 (예: ["-y", "@modelcontextprotocol/server-github"]) */
  args?: string[];
  /** sse/http 엔드포인트 URL */
  url?: string;
  /** 이 서버가 동작하려면 필요한 env — 글로벌 vault 키와 매핑된다 */
  envRequirements: AgentEnvRequirement[];
  /** "공식 MCP 서버" 배지 */
  trust: "official" | "community";
  docsUrl?: string;
  /** 키/토큰을 발급받는 페이지 (UI에 "키 발급 →" 링크) */
  setupUrl?: string;
  /** 로고 타일 배경색 (브랜드 컬러) */
  brandColor?: string;
  /** 로고 타일 모노그램 (1–2자) */
  mark?: string;
}

/** 사용자가 설치/구성한 MCP 서버 (SQLite에 영구화). */
export interface InstalledMcpServer {
  id: string;
  /** 카탈로그 출신이면 카탈로그 id, 커스텀이면 null */
  catalogId: string | null;
  name: string;
  nameEn: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /** 이 서버가 쓰는 글로벌 env 키 목록 (값은 keychain) */
  envKeys: string[];
  /** False when legacy/corrupt JSON arrays contained non-string members. */
  configurationValid?: boolean;
  enabled: boolean;
  installedAt: string;
}

/** 연결 상태 + 노출하는 툴 목록. test() / status()가 반환. */
export interface McpServerStatus {
  id: string;
  connected: boolean;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  error: string | null;
  /** 아직 값이 없는 필수 env 키 — 연결 막힘 원인 */
  missingEnv: string[];
  checkedAt: string;
  /**
   * A configured server whose health check would visibly launch a user-facing
   * application is intentionally not spawned by passive status surfaces.
   * An explicit per-server test still performs the real connection check.
   */
  deferred?: "interactive";
}

// ── Firm = 위계 조직을 가진 에이전트 회사 풀패키지 ──────────
// Agentlas 웹의 핵심 — 데스크톱은 설치된 firm을 갖고 채팅/자동화.
//
// 예: "쇼핑몰 운영 풀패키지"
//   CEO (오케스트레이터 에이전트) — 사용자 명령 수신, 부서장에게 위임
//   ├─ 콘텐츠 부서장 → 상품설명 작가, 광고 카피라이터
//   ├─ CS 부서장 → CS 답변 도우미, 리뷰 모니터
//   └─ 분석 부서장 → 가격 스카우터, 키워드 발굴자
export interface FirmOrgNode {
  /** 이 노드의 에이전트 slug */
  agentSlug: string;
  /** "CEO" / "마케팅 부서장" / "디자이너" 같은 회사 내 역할 */
  role: string;
  /** 상사 agentSlug — null이면 최상위(CEO) */
  reportsTo: string | null;
}

export interface FirmListing {
  /** 마켓 slug */
  slug: string;
  /** 회사 이름 (한국어) */
  name: string;
  nameEn: string;
  /** 한 줄 설명 (한국어) */
  tagline: string;
  taglineEn: string;
  /** ICP / 페르소나 */
  persona: string;
  /** CEO 에이전트 slug (orgChart에 반드시 포함, reportsTo === null) */
  ceoSlug: string;
  /** 조직도 */
  orgChart: FirmOrgNode[];
  /** 의존하는 모든 에이전트 slug (설치 시 한꺼번에 install) */
  agentSlugs: string[];
}

export interface InstalledFirm {
  id: string;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  persona: string;
  /** orgChart의 CEO 에이전트 id (installed_agents.id, slug 아님) */
  ceoAgentId: string;
  /** orgChart의 각 노드를 installed agent id로 resolve */
  orgChart: Array<FirmOrgNode & { agentId: string }>;
  installedAt: string;
}


// ── 정규화된 3-tier 조직 스펙 (멀티 에이전트 오케스트레이션의 입력) ──────
// firm.orgChart(또는 LLM 리졸버)를 CEO → 본부(division) → 전문가(specialist)
// 3계층으로 정규화한다. 오케스트레이터는 이 스펙만 보고 실행하므로 소스(시드/임포트)와 분리된다.
export interface ResolvedNode {
  /** 안정적 id — 실 installed agent면 그 id, 아니면 slug/role 파생 */
  id: string;
  /** 표시 이름 */
  name: string;
  /** 회사 내 역할 ("CEO" / "마케팅 본부장" / ...) */
  role: string;
  /** 실제 installed agent에 매핑되면 그 id (없으면 라벨/리졸버 생성 노드) */
  agentId?: string;
  /** 이 노드를 실행할 시스템 프롬프트 (에이전트 프롬프트 또는 리졸버 생성). */
  prompt?: string;
  /** 인라인 prompt 대신 런타임에 읽을 프롬프트 파일 절대경로 (리졸버 출력용). */
  promptFileRef?: string;
}

export interface ResolvedDivision extends ResolvedNode {
  /** 이 본부 산하 전문가 (tier 3, ephemeral worker) */
  specialists: ResolvedNode[];
}

export interface ResolvedOrg {
  /** 어떻게 만들어졌는가 — orgChart 파생 / LLM 리졸버 */
  source: "orgchart" | "resolver";
  ceo: ResolvedNode;
  /** tier 2 본부들. 비어있으면 = 단일 에이전트처럼 CEO만 실행 */
  divisions: ResolvedDivision[];
  /** 리졸버가 생성한 경우 원본 팀 폴더 절대경로 (재-resolve·sidecar용) */
  sourcePath?: string;
  /** 만들어진 시각 (ISO) */
  resolvedAt?: string;
}

/** standalone 팀 에이전트의 하위 서브에이전트 해석 결과. */
export interface AgentTeamResolution {
  /** LLM/구조 판정 종류 — 'agent'면 실제로는 싱글(다음 새로고침에 이동). */
  kind: "agent" | "team";
  /** 사용자 대면 서브에이전트(시스템 역할 제외). */
  subAgents: Array<{ name: string; role: string }>;
}

// ── 프로젝트 / 채팅 (Claude Desktop / Codex 스타일) ──────────
export interface Project {
  id: string;
  name: string;
  description: string | null;
  /** 프로젝트 전체에 적용되는 사용자 작성 지시. */
  systemPrompt: string | null;
  /** 사용자가 프로젝트에 붙인 에이전트·팀 도구. 배열 순서는 표시 안정성만 위한 값이다. */
  agentPool: ProjectAgentPoolMember[];
  /** 프로젝트가 기준으로 삼는 소스. */
  sourceType: ProjectSourceType;
  /** GitHub URL 또는 sample identifier. Local은 folderPath가 기준이다. */
  sourceRef: string | null;
  /** 이 프로젝트의 로컬 작업 폴더(절대경로). */
  folderPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSourceType = "local" | "github" | "sample";

export type ProjectSourceConnectResult =
  | { status: "connected"; capability: "ready"; repositoryUrl: string; folderGrant: FsPathGrant }
  | { status: "cancelled"; capability: "destination" }
  | { status: "action_required"; capability: "repository" | "github_client" | "github_auth" | "destination" | "clone" };

interface ProjectToolPoolMemberBase {
  /** Identity namespace that resolves targetId. */
  source: "local" | "cloud" | "hub";
  /** Exact remote release. Local source packages intentionally use null. */
  releaseId: string | null;
  /** Stable display fallback only; never used as execution identity. */
  nameSnapshot: string;
}

export interface ProjectAgentPoolAgentMember extends ProjectToolPoolMemberBase {
  entityKind: "agent";
  /** Canonical identity in the declared source namespace. */
  targetId: string;
  /** Installed Desktop projection, when materialized locally. */
  agentId: string | null;
  firmId: null;
  controllerAgentId: null;
}

export interface ProjectAgentPoolTeamMember extends ProjectToolPoolMemberBase {
  entityKind: "team";
  /** Local firm id, or the exact Cloud/Hub team slug before local materialization. */
  targetId: string;
  agentId: null;
  /** Present only after a team has an authoritative local firm projection. */
  firmId: string | null;
  /** Execution entrypoint metadata; the team identity remains targetId/firmId. */
  controllerAgentId: string | null;
}

/**
 * A project owns work and keeps an unordered pool of reusable tools. An agent
 * and a team are distinct execution targets; a team must never collapse to its
 * CEO agent id merely because the CEO is its runtime entrypoint.
 */
export type ProjectAgentPoolMember = ProjectAgentPoolAgentMember | ProjectAgentPoolTeamMember;

/** Automation-owned transcript projection. The renderer never receives a Work chat. */
/**
 * 자동화가 멈췄을 때 사용자가 **지금 누를 수 있는** 조치. 문장만 남기고 끝내면 사용자는
 * 무엇을 해야 할지 알 수 없다. 행동 id는 Main이 만든 유한 집합이며, 모델은 그중에서만
 * 고른다(자유 문자열 실행 없음). 문구는 모델이 쓰고, 실행 권한은 코드가 가진다.
 */
/** 짓다 막혔을 때 할 수 있는 일. **유한하고 각각 호스트가 실제로 실행한다.** */
export type GraphBuildFixKind =
  | "repair_step"
  | "browser_login"
  | "open_browser_setup"
  | "open_mac_permissions"
  | "agentlas_sign_in"
  | "save_switched_off"
  | "ask_in_session";

export interface GraphBuildFixOption {
  actionId: string;
  kind: GraphBuildFixKind;
  /** 모델이 쓴 사용자 문구. 내부 코드·경로·스택은 들어가지 않는다. */
  label: string;
  site?: string;
}

export interface GraphBuildRecoveryPlan {
  summary: string;
  question: string | null;
  options: GraphBuildFixOption[];
  /** 판정 런타임이 없어 고르지 못했다. 이때만 화면이 일반 안내로 내려간다. */
  unavailable: boolean;
}

export type AutomationFixKind =
  /** 저장된 사이트의 로그인 창을 자동화 전용 브라우저 프로필로 연다. */
  | "browser_login"
  /** 브라우저 자체를 못 찾거나 설정이 없어 커넥트 화면을 연다. */
  | "open_browser_setup"
  /** macOS 손쉬운 사용/화면 기록 권한 화면을 연다. */
  | "open_mac_permissions"
  /** Agentlas 계정 로그인(브라우저 왕복). */
  | "agentlas_sign_in"
  /** Agentlas OS 런타임 자가 수리. */
  | "repair_runtime"
  /** 이 자동화를 지금 다시 실행. */
  | "retry_run"
  /**
   * "알릴 것이 없는 날마다 실패하는" 그래프 모양을 고친다 — 비어 있어도 되는 값의 검증을
   * 값이 있는 쪽 가지 안으로 옮긴다. 다시 실행해도 낫지 않는 유일한 부류라, 재실행 조치와
   * 나란히 두면 사람이 계속 헛되이 재실행을 누르게 된다.
   */
  | "repair_graph_shape"
  /**
   * 이 자동화가 바깥을 바꾸는 단계를 갖고 있는데 읽기 전용으로 저장돼 있어, 부를 수 있는
   * 도구가 없는 상태로 매번 실행된다. 필요한 권한을 **여기서 한 번** 받아 저장한다 —
   * 실행 중에 사람을 세우지 않기 위해서다(오너 지시 2026-08-20).
   */
  | "grant_execution_permission"
  /** 세션 대화에서 이어서 해결. */
  | "ask_in_session";

export interface AutomationFixOption {
  /** Main이 발급한 실행 가능한 조치 id. 이 목록 밖의 값은 실행되지 않는다. */
  actionId: string;
  kind: AutomationFixKind;
  /** 모델이 쓴 사용자 문구. 내부 코드·경로·스택은 들어가지 않는다. */
  label: string;
  /** 외부 효과가 있어 사용자가 먼저 눌러야 하는 조치. */
  requiresConfirmation: boolean;
}

export interface AutomationFixPlan {
  automationId: string;
  /** 지금 상황을 사람 말로 설명한 문장(모델 작성). */
  summary: string;
  /** 사용자에게 물어야 할 때만 채워진다. */
  question: string | null;
  options: AutomationFixOption[];
  /** Main이 이미 스스로 실행해 본 조치(있다면)와 그 결과. */
  applied: { actionId: string; ok: boolean } | null;
  /** 판정 런타임이 없어 조치를 고르지 못한 상태. UI는 이때만 일반 안내로 내려간다. */
  unavailable: boolean;
}

export interface AutomationFixResult {
  ok: boolean;
  /** 사용자에게 보여줄 결과 한 줄. */
  message: string;
  /** 렌더러가 열어야 하는 고정 목적지(자유 URL 아님). */
  navigate: "/browser" | "/settings" | null;
  /** 조치 후 다시 계산한 계획. */
  plan: AutomationFixPlan | null;
}

/** Main-bound identity for one user-selected fix mutation. */
export interface AutomationFixActionReceipt extends AutomationFixResult {
  automationId: string;
  actionId: string;
}

export interface AutomationSession {
  id: string;
  automationId: string;
  /** Execution-ledger chat that owns this transcript. The automation screen sends
   *  ordinary turns into it, so the session panel is a real conversation. */
  chatId: string;
  /** The automation pin used by manual follow-ups from this transcript. */
  runtimeSelection: RuntimeSelection | null;
  messages: ChatHistoryEntry[];
  updatedAt: string;
}

export type ProjectKnowledgeSourceKind = "pm_soul" | "sitemap" | "code_map";
export type ProjectKnowledgeSourceStatus = "ready" | "missing" | "invalid" | "unavailable";

export interface ProjectKnowledgeSourceState {
  kind: ProjectKnowledgeSourceKind;
  status: ProjectKnowledgeSourceStatus;
  /** Content-free health detail only. Raw project memory never crosses this IPC. */
  detail: string | null;
}

export type ProjectTimelineEntrySource = "memory_episode" | "chat_fallback";
export type ProjectTimelineNavigationStatus =
  | "exact"
  | "chat_only"
  | "chat_deleted"
  | "unlinked";

export interface ProjectTimelineEntry {
  id: string;
  occurredAt: string;
  summary: string;
  source: ProjectTimelineEntrySource;
  chatId: string | null;
  messageId: string | null;
  taskId: string | null;
  archived: boolean;
  navigationStatus: ProjectTimelineNavigationStatus;
}

export interface ProjectTimelineSnapshot {
  projectId: string;
  generatedAt: string;
  sources: ProjectKnowledgeSourceState[];
  entries: ProjectTimelineEntry[];
  truncated: boolean;
}

export type OntologySourceScope = "public" | "internal" | "private";
export type OntologySourceKind = "project" | "company" | "personal";

export interface OntologyRegisteredSource {
  path: string;
  scope: OntologySourceScope;
  kind: OntologySourceKind;
  exists: boolean;
  registeredAt?: string;
}

export interface OntologyInboxEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  supported: boolean;
}

export interface OntologyProjectStatus {
  projectId: string;
  projectName: string;
  state: "provisioned" | "ingesting" | "ready" | "degraded" | "failed";
  projectPath: string | null;
  memoryDir: string | null;
  inboxPath: string | null;
  dbPath: string | null;
  configPath: string | null;
  sourceManifestPath: string | null;
  policy: {
    mode: "inbox_and_registered_sources_only";
    neverScanHomeDirectory: true;
    neverScanSiblingProjects: true;
    crossProjectSearchDefault: "disabled";
    privateScopeDefaultSearch: "excluded";
  };
  sources: OntologyRegisteredSource[];
  inboxEntries: OntologyInboxEntry[];
  counts: {
    registeredSources: number;
    availableRegisteredSources: number;
    missingRegisteredSources: number;
    inboxEntries: number;
    supportedInboxEntries: number;
    unsupportedInboxEntries: number;
    syncedPaths: number;
    ingestedSources: number;
    chunksWritten: number;
    entitiesWritten: number;
    relationsWritten: number;
    idempotentSkips: number;
    parserErrors: number;
    unsupportedSources: number;
    databaseSources: number;
    databaseChunks: number;
    databaseEntities: number;
    databaseRelations: number;
  };
  warnings: string[];
  lastOperation?: "provision" | "sync" | "register";
  lastIngestStartedAt?: string;
  lastIngestCompletedAt?: string;
  error?: string;
}

export interface Chat {
  id: string;
  /** One/Work/Mobile이 함께 여는 durable Task. 구버전 row에는 없을 수 있다. */
  taskId?: string;
  /** 프로젝트 소속이면 그 id, 아니면 null */
  projectId: string | null;
  /** 회사 채팅이면 firm id, 아니면 null. firmId가 있으면 agentId = firm.ceoAgentId */
  firmId: string | null;
  /** 이 채팅에 묶인 에이전트 (개별) 또는 firm의 CEO 에이전트 */
  agentId: string;
  /** 'user'(일반, 사이드바 노출) | 'division'(백그라운드 본부/자동화 세션, 숨김) */
  kind: "user" | "division";
  /** 사용자 첫 메시지로 자동 생성된 제목 (사용자 rename 가능) */
  title: string;
  /** 보관 시각 — null이면 활성, 있으면 사이드바에서 숨김 (보관함에서만 보임) */
  archivedAt: string | null;
  createdAt: string;
  /** 마지막 메시지 시각 — 사이드바 정렬 키 */
  updatedAt: string;
  /** 세션 목록 한 줄용 마지막 사용자/에이전트 메시지 미리보기. */
  lastMessagePreview?: string;
  /** "계속 라이브로" 모드 — Stormbreaker 연속실행 상한에 닿아도 백그라운드로 넘기지 않고
   *  같은 채팅에서 라이브 스트리밍을 계속 이어간다(수 시간 단위). */
  continuousMode: boolean;
  /** 스웜 모드 — 목표를 작업 그래프로 분해해 여러 워커가 병렬로 협업(emergent A2A). */
  swarmMode: boolean;
  /** 이 채팅이 추진 중인 persistent goal의 원장 축(goal_ledger 조인 키).
   *  null = 목표 추진 꺼짐. 켜는 순간 고정되며(칩 ON), 끄기는 명시적 목표 종료다. */
  goalId?: string | null;
  /** 어느 표면이 시작한 대화인지 — 'one'(초개인화 One 홈) | 'work'(전역 Work).
   *  One 홈과 Work 사이드바는 이 값으로 서로를 오염하지 않는다. 구버전 row는 'work'. */
  originSurface?: "one" | "work";
  /** Exact chat-scoped orchestrator pin. null means follow the role default. */
  runtimeSelection?: RuntimeSelection | null;
  /** 좌석 상호참조 — 끊길 수 있는 참조(좌석 해체·소멸 후에도 세션은 유효). */
  seatId?: string | null;
  /** 좌석 표시 스냅샷(쓰는 시점 기록) — 좌석 테이블 조인 없이 이 칸만으로 렌더한다. */
  seatLabel?: string | null;
  seatKind?: "solo" | "group" | null;
  participants?: Array<{ slot: number; agentId: string | null; displayName: string }> | null;
}

/**
 * 좌석 1급 뷰 — 세션(chats)과 생존이 분리된 고정 자리(SEAT-SESSION-PLAN-v2).
 * dissolvedAt 이 있으면 해체된 좌석: 소속 세션은 전부 보존된 읽기 전용 아카이브다.
 */
export interface OneSeatOccupancy {
  slot: number;
  agentId: string | null;
  /** 그 시점의 표시 이름 스냅샷 — 봇이 삭제돼도 남는다. */
  displayName: string;
  since: string;
  /** null = 지금 앉아 있음. 값이 있으면 그때 자리를 떠났다(행은 수정·삭제되지 않는다). */
  until: string | null;
}

export interface OneSeatView {
  id: string;
  kind: "solo" | "group";
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  dissolvedAt: string | null;
  /** 현재 점유(열린 행)만 — 빈 배열이면 빈 좌석. */
  occupants: OneSeatOccupancy[];
}

/**
 * Host-owned goal contract shown by every chat surface.
 *
 * `objective` is immutable while the goal is active. Ordinary messages and
 * steering turns may change the execution path, but never this contract.
 * A bound chat can temporarily return `null` here until the first Goal-mode
 * request defines the objective and its acceptance criteria.
 */
export interface ChatGoalContext {
  goalId: string;
  objective: string;
  acceptanceCriteria: string[];
  status: "active" | "blocked" | "completed" | "cancelled";
  runId?: string;
  runStatus?: string;
  pauseReason?: "user" | "app_closed" | "budget" | "runtime_unavailable" | "approval_required" | "crash_recovery" | null;
  /*
   * ★막힌 이유. 저장소에는 있는데 화면까지 오지 않던 값이다 (실측 2026-09-08).
   *   오너의 실데이터에서 목표 하나가 `blocked` + `verification_inconclusive` 로 서 있었는데,
   *   이 칸이 없어서 화면은 "왜 멈췄는지" 를 알 방법이 없었다.
   */
  blockedReason?: string | null;
  version?: number;
  executionLocation?: "desktop-local" | "web-hosted";
}

export type CanonicalTaskStatus =
  | "open"
  | "running"
  | "waiting-decision"
  | "partial"
  | "completed"
  | "failed"
  | "cancelled"
  | "archived";

export interface CanonicalTaskParticipant {
  taskId: string;
  agentId: string | null;
  agentSlug: string;
  role: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface CanonicalTask {
  id: string;
  /** Monotonic-enough canonical projection version derived from authoritative updatedAt. */
  version: number;
  title: string;
  projectId: string | null;
  firmId: string | null;
  status: CanonicalTaskStatus;
  originChatId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  participants: CanonicalTaskParticipant[];
}

/** Main-verified Work destination for one Task. Never derived in the renderer. */
export interface CanonicalTaskWorkTarget {
  taskId: string;
  chatId: string;
  title: string;
}

export interface CanonicalTaskResultAcceptance {
  taskId: string;
  expectedVersion: number;
  expectedRunId: string;
}

export interface CanonicalTaskResultContinuation {
  taskId: string;
  expectedVersion: number;
  userPrompt: string;
}

/** 에이전트 동시 실행 수(스웜 크기) — 사양 기반 추천 + 사용자 슬라이더값. */
export interface AgentConcurrencyInfo {
  cores: number;
  totalMemGB: number;
  recommended: number;
  current: number;
  hardMax: number;
  userSet: boolean;
}

/** Main-authored display metadata. It grants no execution authority. */
export interface ChatHostNotice {
  purpose: "goal-continuation";
  runId: string;
}

export interface ChatHistoryEntry {
  goalResult?: import("./goal-result").GoalResultPresentation;
  id: string;
  /** Opaque Main-issued durable chat-message identity; never derived from copy or timestamps. */
  durableMessageId?: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  /** Exact Main-issued purpose of a system turn; absent on legacy history. */
  hostNotice?: ChatHostNotice;
  /** 사용자 또는 호스트가 생성해 영구화한 이미지 첨부 URL. */
  imageDataUrls?: string[];
}

export interface ExternalCliSessionSummary {
  /** Main-owned opaque reference. Raw CLI log paths never cross into the renderer. */
  sourceKey: string;
  provider: "claude-code" | "codex";
  title: string;
  preview: string;
  /** Basename only; the user's raw local path remains in Main. */
  projectLabel: string | null;
  updatedAt: string;
  messageCount: number;
  /** Import is intentionally bounded; true means only the most recent safe window is copied. */
  truncated: boolean;
}

export interface ExternalCliSessionImportInput {
  sourceKey: string;
  projectId: string;
  /** Surface that owns the copied conversation. Project detail defaults to Work. */
  originSurface?: "work" | "one";
}

/**
 * "one" 은 개인 에이전트 One 하나를 가리키는 싱글턴 **타겟**이다(target_id = "one").
 * 타겟이 하나인 것과 **연결이 하나**인 것은 다르다 — One 은 여러 방(=여러 봇)에 붙을 수
 * 있고, 방마다 대화가 따로 생긴다. 그 둘을 한 인덱스로 묶었던 것이 v94 의 실수였다(v101 에서 분리).
 * agent/firm 은 One 통합 이전에 만들어진 레거시 연결 — 계속 돌지만 새로 만들지 않는다.
 */
export type TelegramConnectTargetKind = "agent" | "firm" | "one";
/** One 바인딩의 고정 target_id. 설치된 에이전트 행 id가 아니라 불변 sentinel이다. */
export const TELEGRAM_ONE_TARGET_ID = "one";
export type TelegramConnectStatus =
  | "draft"
  | "bot_verified"
  | "waiting_for_chat"
  | "chat_paired"
  | "test_passed"
  | "running"
  | "failed"
  | "disabled";

export interface TelegramConnectBinding {
  id: string;
  targetKind: TelegramConnectTargetKind;
  targetId: string;
  targetName: string;
  /** True when the bound agent/firm/group no longer exists (deleted target → orphaned port). */
  targetMissing: boolean;
  status: TelegramConnectStatus;
  enabled: boolean;
  sessionRunning: boolean;
  automationReportEnabled: boolean;
  hasToken: boolean;
  /** Exact Terminal-owned token path exists; import still performs full safety validation. */
  terminalImportAvailable: boolean;
  tokenPreview: string | null;
  botUserId: number | null;
  botUsername: string | null;
  botDisplayName: string | null;
  telegramChatId: string | null;
  telegramChatTitle: string | null;
  chatSessionId: string | null;
  lastUpdateId: number;
  lastError: string | null;
  lastTestAt: string | null;
  /** 텔레그램에서 /project 로 지정한 프로젝트. 이름은 표시용이라 삭제되면 null이 된다. */
  designatedProjectId: string | null;
  designatedProjectName: string | null;
  /** /graph 로 지정한 자동화. 삭제된 자동화는 id만 남고 이름이 null이 된다(조용히 지우지 않는다). */
  designatedGraphId: string | null;
  designatedGraphName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramLegacyCleanupResult {
  removed: number;
  botsDeleted: number;
  /** BotFather 자동화가 실패해 사용자가 직접 지워야 하는 봇들(@username). */
  botDeleteFailures: string[];
}

export interface TelegramConnectStartInput {
  targetKind: TelegramConnectTargetKind;
  targetId: string;
  /** BotFather token. Stored in Keychain by main; never returned to renderer. */
  botToken: string;
}

export interface TelegramConnectCloneInput {
  sourceBindingId: string;
  targetKind?: TelegramConnectTargetKind;
  targetId?: string;
}

export interface TelegramConnectAutoInput {
  targetKind: TelegramConnectTargetKind;
  targetId: string;
  /** 사용자가 지정한 봇 표시 이름(텔레그램에 보이는 이름). 비우면 "Agentlas <타겟명>" 자동. */
  botName?: string;
  /**
   * true면 기존 연결을 재확인하지 않고 **새 봇/새 방**을 하나 더 만든다.
   * One은 방마다 하나이므로 봇을 더 붙이면 그만큼 대화(세션)가 늘어난다.
   */
  newConnection?: boolean;
}

export interface TelegramConnectActionResult {
  binding: TelegramConnectBinding;
  message: string;
}

// ── 스케줄 트리거 spec — 저장/문법/표시 분리(설계 §2.1) ───────────
// 내부 진실은 이 discriminated union 하나. 프리셋은 별도 kind가 아니라 라벨 붙은 cron.
export type ScheduleSpec =
  | { kind: "cron"; expr: string; tz: string }
  | { kind: "interval"; everyMs: number; anchor: "wallclock" | "lastRun" }
  | { kind: "once"; atIso: string }
  | { kind: "manual" };

// ── 조건 게이트(설계 §3.5) — 트리거 발사 시 or 그래프 워크 중 평가하는 순수 조건 ──────
// P1은 Tier 0(이벤트/체인/스케줄+게이트)만. poll 계열의 cond도 같은 타입을 쓴다.
export interface TriggerCondition {
  /** 비교할 좌변 — 변수명({{var}}) 또는 리터럴 문자열. */
  left: string;
  op: "eq" | "ne" | "contains" | "gt" | "lt" | "gte" | "lte" | "exists" | "changed";
  /** 우변 — 리터럴(연산자가 exists/changed면 무시). */
  right?: string;
}

// ── 트리거 union(설계 §3.5) — "언제 fire하나"만 바꾸는 전위 레이어. 실행 엔진은 불변. ──
// schedule = 기존 시간 트리거(scheduleSpec/scheduleHuman으로 표현, 하위호환).
// 이벤트 계열(fs/chain)은 스케줄러가 아니라 트리거 매니저의 리스너에 등록 → 유휴 0.
export type Trigger =
  | { kind: "schedule"; onlyIf?: TriggerCondition }
  // 커넥터 C47·C48 — 바깥에서 "이거 돌려줘"가 들어오는 종류. 예약처럼 시계가 부르지도,
  // 소스처럼 값이 변해 부르지도 않는다. **누군가 명시적으로 부른 것**이다.
  // 그래프에 그려 넣는 트리거 노드가 아니라 대기열에 앉는 종류라, 실행 기록에서
  // 어디서 온 요청인지가 남는다(예약 실행과 섞이면 영원히 구분할 수 없다).
  | { kind: "command"; onlyIf?: TriggerCondition }
  | { kind: "fs"; path: string; on: "create" | "modify" | "delete"; debounceMs?: number; onlyIf?: TriggerCondition }
  | { kind: "chain"; afterAutomationId: string; onlyIf?: TriggerCondition }
  | { kind: "webhook"; token: string; onlyIf?: TriggerCondition }
  | {
      kind: "poll";
      /** 폴 소스 명세(설계 §3.4 Tier 1). 어떤 외부 값을 어떻게 읽을지. */
      source: PollSource;
      cond: TriggerCondition;
      /** 적응형 백오프 하한(변화·임계근접 시 이 간격으로 조임). */
      minIntervalMs: number;
      /** 적응형 백오프 상한(값 안 변하면 여기까지 지수 증가). */
      maxIntervalMs: number;
      /** dedup 커서 — 마지막으로 관측한 값(같으면 재발사 안 함). */
      lastSeen?: string;
    };

export type TriggerKind = Trigger["kind"];

// ── 폴 소스(설계 §3.2, §3.4 Tier 1) — 폴링 강제 트리거의 데이터 소스 명세 ──────
// 폴링은 유일한 실질 비용이므로(설계 §3.1) 적응형 간격 + lastSeen 커서로 통제한다.
// 각 소스는 하나의 스칼라/문자열 값을 관측한다(조건 평가기가 이 값을 좌변으로 쓴다).
export type PollSource =
  | {
      /** 주가/지표 임계값 — stock/alphavantage MCP(GLOBAL_QUOTE/RSI 등). MARKET_STATUS로 게이팅. */
      kind: "stock";
      /** 티커 심볼(예 "AAPL", "005930.KS"). */
      symbol: string;
      /** 관측 지표 — "price"(현재가) | 지표명(rsi 등). 기본 price. */
      metric?: string;
      /** 시장이 닫혀 있으면 폴을 더 늘린다(설계 §3.3 게이팅). 기본 true. */
      gateMarket?: boolean;
    }
  | {
      /** GitHub 이슈/PR 폴링. lastSeen 커서로 새 항목만 발사. */
      kind: "github";
      /** "owner/repo". */
      repo: string;
      /** issues | pulls. 기본 issues. */
      resource?: "issues" | "pulls";
    }
  | {
      /** Slack 채널 새 메시지 폴링(webhook 없을 때). */
      kind: "slack";
      /** 채널 id 또는 "#name". */
      channel: string;
    }
  | {
      /** Notion 데이터베이스 새 항목 폴링. */
      kind: "notion";
      /** 데이터베이스 id. */
      databaseId: string;
    };

// ── 비주얼 워크플로우 그래프(설계 §4.2) ───────────────────────────
// automations 행의 nullable graph_json 컬럼에 직렬화. null = 오늘의 단일-프롬프트 동작.
export type WorkflowNodeType =
  | "trigger" // schedule | manual → schedule 컬럼 미러
  | "agent" // agent.id | firm.id | taskForceTargets[] | swarm | pipeline
  | "tool" // MCP catalog id / 커스텀 → 인접 agent 런타임 MCP 설정에 컴파일
  | "action" // surface action.type / appFactory:* / toolFactory:* / hep-call
  | "condition" // 이전 출력 분기
  | "eval" // 만든 것을 **다른 노드가** 선언된 기준으로 판정 → pass/fail + 사유
  | "transform" // 노드 간 변수 map/extract/format
  | "output" // Slack post / notification / file write / chat surface
  | "subgraph" // 다른 그래프를 한 단계로 부른다(함수 안의 함수)
  | "code"; // ★AI가 짠 스크립트를 격리 실행 — 정확한 계산·데이터 가공(주가·엑셀·파싱). 말로는 틀리는 것.

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  /** 타입별 자유형 설정(스케줄/에이전트 ref/툴 catalog/변수 produces·consumes 등). */
  config: Record<string, unknown>;
  label?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** condition 노드의 분기 핸들: "true" | "false" | 변수명 라벨. */
  sourceHandle?: string;
  /**
   * 앞 단계로 되돌아가는 연결(반복)에서 **몇 바퀴까지 돌 것인가**.
   * 자동화는 사람이 보지 않는 동안 도는 것이므로 상한 없는 반복은 실행하지 않는다
   * — 토큰과 시간이 끝없이 나가고, 멈출 사람이 그 자리에 없다.
   */
  maxIterations?: number;
}

export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /**
   * 실행 전체에 걸리는 상한. 노드별 상한(node.config.maxTokens)과는 비교 대상이 다르다 —
   * 노드 상한은 그 노드의 누계, 여기 값은 실행 총계다.
   * 토큰은 런타임이 실제로 보고하는 측정값이라 상한으로 쓸 수 있다. 금액은 모델·시점마다
   * 달라지는 추정치라 상한의 단위로 쓰지 않는다.
   */
  budget?: {
    maxTokens?: number;
  };
}

// ── run history — 놓친 실행/스킵 가시화(설계 §2.7) ─────────────────
export interface AutomationRunRecord {
  id: string;
  automationId: string;
  /** 이 실행이 겨냥한 예정 시각(ISO). catch-up 시 놓쳤던 슬롯. */
  scheduledFor: string | null;
  /** 실제 실행 시각(ISO). */
  ranAt: string;
  /**
   * **커널의 답 — 그래프가 끝까지 돌았는가.** 판정 모델이 이 칸을 덮어쓰지 않는다.
   * (blocked·needs_input은 옛 기록에만 남아 있는 값이다. 그때는 한 칸에 두 답이 섞였다.)
   */
  status: "ok" | "partial" | "error" | "skipped" | "blocked" | "needs_input";
  /**
   * **판정의 답 — 나온 결과물이 쓸 만한가.** status와 다른 질문이라 칸이 다르다.
   * `null`이면 옛 기록(두 답이 섞여 있어 복원 불가) 또는 판정을 하지 않은 실행이다 —
   * 모르는 것을 accepted로 메꾸지 않는다.
   */
  outcome: "accepted" | "needs_input" | "blocked" | "rejected" | "unjudged" | null;
  /** 판정이 그렇게 본 이유. status의 error와 섞지 않는다. */
  outcomeReason: string | null;
  /** 이 실행에서 병합/스킵된 놓친 발생 수. */
  skippedCount: number;
  error: string | null;
  /** 사용자가 확인필요 요구를 닫은 시각. 기록은 남고 "지금 조치하라"만 꺼진다. */
  acknowledgedAt?: string | null;
}

/** Main이 실제 스케줄러 판정을 끝낸 뒤 반환하는 수동 실행 결과. */
export interface AutomationRunNowResult {
  /** Exact automation whose terminal result this receipt describes. */
  automationId: string;
  /** Durable graph run when one was created; null for a preflight-only terminal result. */
  runId: string | null;
  /** false면 리스 충돌·업데이트 quiesce 등으로 실행이 접수되지 않았다. */
  accepted: boolean;
  /** accepted=true인 실행의 최종 커널 상태. */
  status?: AutomationRunRecord["status"];
  error?: string | null;
  output?: string;
}

/** A retained event occurrence that cannot be safely replayed automatically. */
export interface AutomationTriggerEventAttention {
  id: string;
  automationId: string;
  triggerKind: Exclude<TriggerKind, "schedule">;
  attemptCount: number;
  lastError: string;
  runId: string | null;
  runOutcome: AutomationRunRecord["status"] | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTriggerEventReconcileInput {
  eventId: string;
  automationId: string;
  /** Optimistic CAS token from AutomationTriggerEventAttention.updatedAt. */
  expectedUpdatedAt: string;
  /** completed = external action happened; retry = external action did not happen. */
  resolution: "completed" | "retry";
}

export interface AutomationTriggerEventReconcileResult {
  eventId: string;
  automationId: string;
  resolution: AutomationTriggerEventReconcileInput["resolution"];
  status: "delivered" | "pending";
}

export interface InvocationCancelReceipt {
  runId: string;
  status: "requested" | "already-requested" | "not-found";
}

export interface AutomationGraphReconciliationNode {
  nodeId: string;
  label: string;
  nodeType: WorkflowNodeType;
  uncertainty: "ambiguous" | "in_flight";
  /** Variable name populated by this node, when the graph declares one. */
  produces: string | null;
  /** Completion needs a human-supplied output when the node populates a variable. */
  outputRequired: boolean;
  /** An untrusted pre-reconciliation output existed and will be audit-digested. */
  hasRecordedOutput: boolean;
}

export interface AutomationGraphReconciliationEvent {
  id: string;
  triggerKind: Exclude<TriggerKind, "schedule">;
  status: "pending" | "parked";
  updatedAt: string;
}

/** Strict, latest-failed v3 checkpoint view. Raw checkpoint payloads are never exposed. */
export interface AutomationGraphReconciliation {
  automationId: string;
  runId: string;
  occurrenceId: string;
  graphDigest: string;
  checkpointDigest: string;
  updatedAt: string;
  /** True when the interrupted occurrence was a side-effect-blocking simulation. */
  simulation: boolean;
  triggerEvent: AutomationGraphReconciliationEvent | null;
  nodes: AutomationGraphReconciliationNode[];
}

/** Exact failed occurrence reviewed before explicitly starting a new run. */
export interface AutomationGraphTerminalCloseInput {
  automationId: string;
  runId: string;
  occurrenceId: string;
  graphDigest: string;
  checkpointDigest: string;
  expectedUpdatedAt: string;
  decision: "reviewed_external_effects";
}

export interface AutomationGraphTerminalCloseReceipt {
  automationId: string;
  runId: string;
  occurrenceId: string;
  graphDigest: string;
  checkpointDigest: string;
  closedAt: string;
  status: "closed" | "already-closed";
  consequence: "fresh_occurrence_may_repeat_completed_effects";
}

export interface AutomationGraphTerminalCloseCandidate {
  automationId: string;
  runId: string;
  occurrenceId: string;
  graphDigest: string;
  checkpointDigest: string;
  updatedAt: string;
  simulation: boolean;
  unresolvedNodeIds: string[];
  completedEffectNodeIds: string[];
}

export interface AutomationGraphReconciliationDecision {
  nodeId: string;
  /** completed = it happened; retry = it definitely did not happen. */
  resolution: "completed" | "retry";
  /** Required and non-empty for completed nodes whose config declares `produces`. */
  output?: string;
}

export interface AutomationGraphReconcileInput {
  automationId: string;
  runId: string;
  occurrenceId: string;
  graphDigest: string;
  checkpointDigest: string;
  expectedUpdatedAt: string;
  eventId?: string | null;
  expectedEventUpdatedAt?: string | null;
  decisions: AutomationGraphReconciliationDecision[];
}

export interface AutomationGraphReconcileResult {
  automationId: string;
  runId: string;
  checkpointDigest: string;
  updatedAt: string;
  /** Durable run mode that any automatic resume must preserve. */
  simulation: boolean;
  eventStatus: "pending" | "delivered" | null;
  resumeRequired: boolean;
  completedNodeIds: string[];
  retryNodeIds: string[];
}

export type AutomationToolMode = "auto" | "browser" | "computer-use";
export type AutomationHubMode = "hub-allowed" | "hub-first" | "local-only";
/** Scheduler authority is intentionally capped below interactive `full` access. */
export type AutomationExecutionPermission = "read" | "write";
export type AutomationTargetType = "agent" | "firm" | "hub";

// ── Browser 기능 (자격증명 볼트 · 전용 프로필 · 승인 게이트 · 로그) ──
export type BrowserSessionStatus = "valid" | "expired" | "none";
export type BrowserApprovalDecision = "once" | "always" | "deny";

export interface BrowserStatus {
  chromeFound: boolean;
  chromePath: string | null;
  profilePath: string;
  cdpPort: number;
}
export interface BrowserSite {
  id: string;
  site: string;
  label: string | null;
  username: string | null;
  session: { status: BrowserSessionStatus; capturedAt: string | null };
  createdAt: string;
  updatedAt: string;
}
export interface BrowserSiteInput {
  site: string;
  label?: string | null;
  username?: string | null;
}
export interface BrowserPermissionEntry {
  site: string;
  actionType: string;
  decision: BrowserApprovalDecision;
}
export interface BrowserActionLog {
  id: string;
  ts: string;
  site: string | null;
  action: string;
  target: string | null;
  result: string | null;
  approval: string | null;
}
export type BrowserLiveViewport = "desktop" | "phone";
export type BrowserCdpHostFailureStage =
  | "profile"
  | "existing-host"
  | "launcher"
  | "initialize"
  | "browser-call"
  | "port-check"
  | "ownership"
  | "guardian"
  | "unknown";
export type BrowserCdpHostFailureCode =
  | "profile-unavailable"
  | "ownership-unverified"
  | "guardian-unavailable"
  | "launcher-unavailable"
  | "launcher-materialize-failed"
  | "launcher-spawn-failed"
  | "launcher-exited"
  | "launcher-timeout"
  | "launcher-stdin-closed"
  | "launcher-initialize-failed"
  | "launcher-browser-call-failed"
  | "host-not-ready"
  | "unknown";
export interface BrowserCdpHostFailureDiagnostic {
  stage: BrowserCdpHostFailureStage;
  code: BrowserCdpHostFailureCode;
  /** Bounded byte count only; stderr content is never retained or exposed. */
  stderrBytes?: number;
  stderrTruncated?: boolean;
}
export interface BrowserLiveFrame {
  available: boolean;
  dataUrl: string | null;
  targetId: string | null;
  title: string | null;
  /** Query, fragment, and URL credentials are always removed. */
  url: string | null;
  width: number | null;
  height: number | null;
  /** The real CDP viewport used for this capture. */
  viewport: BrowserLiveViewport;
  capturedAt: string;
  error: "browser-offline" | "no-page" | "capture-failed" | "task-scope-missing" | "browser-session-unlinked" | null;
  /** Machine-readable browser-host failure without raw stderr, argv, or URLs. */
  hostFailure?: BrowserCdpHostFailureDiagnostic | null;
}
/** A frame pushed by the task-scoped CDP screencast. */
export interface BrowserLiveStreamFrame extends BrowserLiveFrame {
  sessionId: string;
  sequence: number;
}
export interface BrowserLiveSessionResult {
  sessionId: string | null;
  interactive: boolean;
  frame: BrowserLiveFrame;
}
export type BrowserLiveInput =
  | {
      sessionId: string;
      kind: "pointer";
      phase: "move" | "down" | "up";
      /** Normalized coordinates inside the streamed viewport. */
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      clickCount?: number;
    }
  | {
      sessionId: string;
      kind: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      sessionId: string;
      kind: "key";
      phase: "down" | "up";
      key: string;
      code?: string;
      modifiers?: number;
    }
  | {
      sessionId: string;
      kind: "text";
      text: string;
    }
  | {
      sessionId: string;
      kind: "navigation";
      action: "back" | "forward" | "reload";
    }
  | {
      sessionId: string;
      kind: "navigation";
      action: "navigate";
      url: string;
    };
export type BrowserLiveDispatchResult =
  | {
      ok: true;
      sessionId: string;
      /** Latest frame sequence after the exact input settled. */
      sequence: number;
      /** Actual settled page after navigation, including redirects. */
      finalUrl: string | null;
    }
  | {
      ok: false;
      code: "invalid_input" | "session_missing" | "no_history" | "dispatch_failed";
    };
export interface ComputerUsePreviewSource {
  id: string;
  kind: "screen" | "window";
  name: string;
  displayId: string | null;
  width: number;
  height: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
  scaleFactor: number | null;
}
export interface ComputerUseCaptureOptions {
  /** The default keeps existing computer-control callers on display capture. */
  mode?: "screen" | "window";
}
export interface ComputerUsePreview {
  platform: NodeJS.Platform;
  captureMode: "screen" | "window";
  screenPermission: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
  accessibility: boolean;
  observationAvailable: boolean;
  /** False until an Agentlas-owned, signed native input driver is installed. */
  interactionAvailable: boolean;
  interactionDriver: "agentlas-native-required" | "agentlas-native";
  sources: ComputerUsePreviewSource[];
  selectedSourceId: string | null;
  /** Window mode returns candidates without an image until the user chooses one. */
  selectionRequired: boolean;
  dataUrl: string | null;
  capturedAt: string;
  error: "screen-unavailable" | "capture-failed" | "source-stale" | "window-selection-required" | "window-not-found" | null;
}
/** electron → renderer 로 밀리는 승인 요청(경량 바텀시트가 받는다). */
export interface BrowserApprovalRequestEvent {
  requestId: string;
  site: string;
  actionType: string;
  summary: string;
  target: string | null;
  allowAlways: boolean;
  /** Main-process fail-closed deadline; renderer auto-closes the stale sheet. */
  expiresAt: number;
}

// ── 자동화 — SQLite 영속 + 앱 실행 중 백그라운드 스케줄러 ────────────
export interface Automation {
  id: string;
  name: string;
  /** "매일 9시", "매주 월 14:00" 같은 사용자 친화 텍스트 */
  scheduleHuman: string;
  /** 자동화 타깃: agent=로컬 에이전트, firm=로컬 회사/팀, hub=Agentlas Hub 에이전트 slug */
  targetType: AutomationTargetType;
  /** targetType에 따라 installed_agents.id, installed_firms.id, 또는 Hub agent slug */
  targetId: string;
  /** Explicit project grounding for this automation session. null means no project context. */
  projectId?: string | null;
  /** 실행 시 사용자 입력 대신 들어갈 프롬프트 템플릿 */
  promptTemplate: string;
  /** 자동화가 웹/화면 조작을 해야 할 때 선호하는 실행 도구. */
  toolMode?: AutomationToolMode;
  /** 로컬 도구만 쓸지, Agentlas Hub 후보까지 빌려 쓸지. */
  hubMode?: AutomationHubMode;
  /** Hub 대상 packageHash 핀. 미설정 = latest(작성자 재게시 시 지시문이 조용히 바뀜).
   *  설정 시 서버가 정확히 그 버전일 때만 실행하고 아니면 version_mismatch로 거절한다. */
  targetVersion?: string;
  /** Runtime pinned for this automation. Global runtime changes must not silently move it
   * to another provider/model and therefore another CLI session namespace. */
  runtimeSelection?: RuntimeSelection;
  /** 예약 실행 권한. 스케줄러는 read/write만 허용하며 full로 승격하지 않는다. */
  executionPermission: AutomationExecutionPermission;
  /** 확인 요구를 "여기까지 다 봤다"고 닫은 시각. 이 시각 이전 실행의 요구는 닫힌 것으로 본다. */
  attentionClearedAt?: string | null;
  enabled: boolean;
  /** 'user'(폼에서 사람이 생성) | 'agent'(채팅에서 에이전트가 `## Automation` 블록으로 생성) */
  createdBy: "user" | "agent";
  createdAt: string;
  lastRunAt: string | null;
  /** 다음 실행 예정 시각(ISO). 스케줄러가 이 값으로 due 판단 후 재계산 */
  nextRunAt: string | null;
  /** 저장된 워크플로우 그래프(있으면 그래프 러너로 실행). null = 단일 프롬프트. */
  graph?: WorkflowGraph | null;
  /** 무엇을 위한 자동화인가 — 인터뷰가 적은 한 문장. AI가 그래프를 이해할 단서. */
  goal?: string | null;
  /** 이 자동화가 어느 persistent goal의 연속실행인가(goal_ledger 조인 키).
   *  프롬프트 안 마커 문자열 검색 대신 쓰는 1급 식별자 — 한 goal에 연속실행은
   *  최대 하나만 만들어지고, 목표 종료 시 정확히 이 행만 비활성화된다. */
  goalId?: string | null;
  /** IANA 타임존(예 "Asia/Seoul"). cron 해석 기준. */
  timezone?: string | null;
  /** 구조화 스케줄 spec(있으면 scheduleHuman 레거시 토큰보다 우선). */
  scheduleSpec?: ScheduleSpec | null;
  /** 트리거 종류(설계 §3.5). 기본 'schedule'(기존 시간 트리거). */
  triggerType?: TriggerKind;
  /** 트리거 상세(fs 경로/chain afterId/webhook token/poll source 등). 'schedule'이면 null. */
  trigger?: Trigger | null;
}

/**
 * 신규/기존 UI는 권한 필드를 보내지 않아도 기존 동작(write)을 유지한다.
 * 저장 후 반환되는 Automation에는 정규화된 executionPermission이 항상 존재한다.
 */
export type AutomationCreateInput = Omit<
  Automation,
  "id" | "createdAt" | "lastRunAt" | "enabled" | "nextRunAt" | "createdBy" | "executionPermission"
> & {
  executionPermission?: AutomationExecutionPermission;
};

/** 기존 자동화 편집 패치(설계 한계 #7 — 삭제-재생성 대신 in-place 수정). */
export interface AutomationUpdatePatch {
  name?: string;
  /** 목적 문장. 빈 문자열 = 지움, undefined = 미변경. */
  goal?: string;
  /** persistent goal 조인 키. null = 해제, undefined = 미변경. */
  goalId?: string | null;
  scheduleHuman?: string;
  targetType?: AutomationTargetType;
  targetId?: string;
  projectId?: string | null;
  promptTemplate?: string;
  toolMode?: AutomationToolMode;
  hubMode?: AutomationHubMode;
  /** packageHash 핀. 빈 문자열 = 핀 해제(latest). undefined = 미변경. */
  targetVersion?: string;
  runtimeSelection?: RuntimeSelection | null;
  executionPermission?: AutomationExecutionPermission;
  scheduleJson?: string | null;
  timezone?: string | null;
  endAt?: string | null;
  maxRuns?: number | null;
  triggerType?: TriggerKind;
  trigger?: Trigger | null;
}


/** launchd LaunchAgent 상태(설계 §2.6). macOS 전용. */
export interface LaunchdStatus {
  /** 이 플랫폼에서 지원되는지(현재 macOS(darwin)만). */
  supported: boolean;
  /** plist가 설치돼 있는지(파일 존재). */
  installed: boolean;
  /** launchd에 로드/부트스트랩돼 실제로 도는지. */
  loaded: boolean;
  /** plist 절대 경로(진단용). */
  plistPath: string;
  /** 마지막 작업 실패 사유(있으면). */
  error?: string;
}

// ── invocation ───────────────────────────────────────────────
export interface ImageAttachment {
  /** "image/png" | "image/jpeg" | "image/gif" | "image/webp" */
  mediaType: string;
  /** 원본 파일명. CLI 런타임에서 임시 파일로 스테이징할 때 사용자 맥락 보존용. */
  name?: string;
  /** base64 (data: 접두사 없이 순수 인코딩) */
  data: string;
}

// ── Agent OS interactive surfaces ─────────────────────────
// Safe, declarative UI artifacts emitted by agents. The model declares data,
// widgets, actions, and provenance; Agentlas renders them through trusted
// components instead of executing arbitrary model-generated code.
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type AgentlasSurfaceLayout =
  | "report"
  | "table"
  | "dashboard"
  | "map-list"
  | "timeline"
  | "workflow"
  | "form"
  | "creative-studio"
  | "service-app"
  | string;

export type AgentlasSurfaceDataType =
  | "table"
  | "timeline"
  | "cards"
  | "metrics"
  | "markdown"
  | "media"
  | "routes"
  | "connectors"
  | "launch-checklist"
  | "pricing"
  | "artifacts"
  | "json"
  | string;

export interface AgentlasSurfaceDataSet {
  type: AgentlasSurfaceDataType;
  columns?: string[];
  rows?: JsonObject[];
  items?: JsonObject[];
  value?: JsonValue;
  summary?: string;
  [key: string]: unknown;
}

/** Portable, JSON-only Flint input carried by a declarative Surface dataset. */
export interface AgentlasSurfaceFlintInput {
  chart_spec: {
    chartType: string;
    title?: string;
    subtitle?: string;
    encodings: Record<string, string | JsonObject>;
    baseSize?: { width: number; height: number };
    canvasSize?: { width: number; height: number };
    chartProperties?: JsonObject;
  };
  semantic_types?: Record<string, string | JsonObject>;
  theme_spec?: string | JsonObject;
  options?: JsonObject;
  field_display_names?: Record<string, string>;
}

export type AgentlasSurfaceWidgetType =
  | "map"
  | "cards"
  | "table"
  | "chart"
  | "timeline"
  | "workflow"
  | "form"
  | "report"
  | "brief-panel"
  | "storyboard"
  | "shot-list"
  | "asset-board"
  | "model-router"
  | "rights-provenance"
  | "export-pack"
  | "cost-summary"
  | "source-matrix"
  | "issue-tree"
  | "app-shell"
  | "service-blueprint"
  | "mcp-builder"
  | "tool-builder"
  | "connector-matrix"
  | "launch-checklist"
  | "pricing-model"
  | "deployment-plan"
  | string;

export interface AgentlasSurfaceWidget {
  type: AgentlasSurfaceWidgetType;
  data?: string;
  title?: string;
  [key: string]: unknown;
}

export type AgentlasSurfaceActionType =
  | "external-link"
  | "agent-followup"
  | "generate"
  | "retry"
  | "copy"
  | "export"
  | "open-file"
  | "scaffold-agent-team"
  | "scaffold-app"
  | "install-mcp"
  | "operate-app"
  | "deploy-preview"
  | "scaffold-tool"
  | "run-tool-smoke"
  | "install-tool-mcp"
  | "materialize-asset-pack"
  | "connect-service"
  | "delegate-browser"
  | "request-credential"
  | "request-payment-approval"
  | "save-as-product"
  | "run-smoke-test"
  | "publish-as-tool"
  | string;

export interface AgentlasSurfaceAction {
  id: string;
  label: string;
  type: AgentlasSurfaceActionType;
  url?: string;
  prompt?: string;
  permission?: "read" | "write" | "full";
  [key: string]: unknown;
}

export interface AgentlasSurfaceProvenance {
  source: string;
  retrievedAt?: string;
  url?: string;
  note?: string;
  [key: string]: unknown;
}

export type AgentlasSurfaceEvidenceKind =
  | "verified"
  | "claimed"
  | "estimated"
  | "unverified"
  | string;

export interface AgentlasSurfaceEvidence {
  id: string;
  kind: AgentlasSurfaceEvidenceKind;
  label?: string;
  source?: string;
  url?: string;
  retrievedAt?: string;
  confidence?: number;
  note?: string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceClaim {
  id: string;
  text: string;
  kind?: AgentlasSurfaceEvidenceKind;
  evidenceIds?: string[];
  status?: "unchecked" | "passed" | "failed" | "needs-review" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceCapability {
  id: string;
  type:
    | "network"
    | "filesystem"
    | "pii"
    | "payment"
    | "payment-method"
    | "credential"
    | "browser-session"
    | "external-api"
    | "model-generation"
    | "human-approval"
    | string;
  purpose: string;
  scope?: string;
  approval?: "none" | "once" | "per-run" | "per-action" | string;
  allowlist?: string[];
  dataClasses?: string[];
  [key: string]: unknown;
}

export interface AgentlasSurfaceBudget {
  currency?: string;
  limit?: number;
  spent?: number;
  approvalThreshold?: number;
  unit?: "surface" | "job" | "session" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceStateField {
  path: string;
  owner: "agent" | "user" | "derived" | string;
  description?: string;
  merge?: "preserve-user" | "replace" | "append" | "derive" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceJob {
  id: string;
  label: string;
  status: "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled" | string;
  costEstimate?: number;
  costSpent?: number;
  currency?: string;
  resumable?: boolean;
  [key: string]: unknown;
}

export interface AgentlasSurfaceDelegationSpec {
  mode?: "agent-operated" | string;
  autonomy?: {
    mode?: "agent-first" | "supervised" | string;
    allowedWithoutPrompt?: string[];
    checkpoints?: string[];
    noDeadEndReasons?: string[];
    destructiveActions?: string[];
    [key: string]: unknown;
  };
  credentials?: JsonObject[];
  payments?: JsonObject[];
  fallbackLadder?: string[];
  [key: string]: unknown;
}

export interface AgentlasSurfaceAppRoute {
  path: string;
  label: string;
  purpose?: string;
  status?: "planned" | "generated" | "wired" | "verified" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceConnectorSpec {
  id: string;
  name: string;
  type: "mcp" | "api" | "oauth" | "database" | "storage" | "payment" | "model" | string;
  purpose?: string;
  auth?: "none" | "api-key" | "oauth" | "user-approval" | string;
  status?: "proposed" | "configured" | "missing-credential" | "verified" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceDeploymentSpec {
  target?: string;
  repoPath?: string;
  command?: string;
  previewUrl?: string;
  readiness?: "concept" | "prototype" | "launch-candidate" | "production" | string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceBusinessSpec {
  audience?: string;
  offer?: string;
  pricing?: string;
  moat?: string;
  launchMetric?: string;
  [key: string]: unknown;
}

export interface AgentlasSurfaceToolParameterSpec {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | string;
  label?: string;
  description?: string;
  required?: boolean;
  default?: JsonValue;
  [key: string]: unknown;
}

export interface AgentlasSurfaceToolSpec {
  id: string;
  name: string;
  description: string;
  domain?: string;
  kind?: "calculator" | "normalizer" | "scorer" | "extractor" | "validator" | "router" | string;
  purpose?: string;
  inputSchema?: JsonObject;
  parameters?: AgentlasSurfaceToolParameterSpec[];
  outputs?: JsonObject[];
  examples?: JsonObject[];
  safety?: {
    externalCalls?: boolean;
    fileWrites?: boolean;
    requiresApproval?: boolean;
    notes?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AgentlasSurfaceAppSpec {
  name: string;
  tagline?: string;
  appType?: "saas" | "internal-tool" | "marketplace-agent" | "automation" | "creative-tool" | string;
  audience?: string;
  valueProp?: string;
  routes?: AgentlasSurfaceAppRoute[];
  connectors?: AgentlasSurfaceConnectorSpec[];
  tools?: AgentlasSurfaceToolSpec[];
  deployment?: AgentlasSurfaceDeploymentSpec;
  business?: AgentlasSurfaceBusinessSpec;
  generatedArtifacts?: string[];
  [key: string]: unknown;
}

export interface AgentlasSurfaceManifest {
  version: "0.1" | string;
  kind: "surface";
  title: string;
  domain: string;
  layout: AgentlasSurfaceLayout;
  /** Launch-ready app/product blueprint when an agent builds a tool it can operate or ship. */
  app?: AgentlasSurfaceAppSpec;
  data: Record<string, AgentlasSurfaceDataSet>;
  widgets: AgentlasSurfaceWidget[];
  actions?: AgentlasSurfaceAction[];
  provenance?: AgentlasSurfaceProvenance[];
  evidence?: AgentlasSurfaceEvidence[];
  claims?: AgentlasSurfaceClaim[];
  capabilities?: AgentlasSurfaceCapability[];
  delegation?: AgentlasSurfaceDelegationSpec;
  budget?: AgentlasSurfaceBudget;
  stateSchema?: { fields?: AgentlasSurfaceStateField[]; [key: string]: unknown };
  jobs?: AgentlasSurfaceJob[];
  [key: string]: unknown;
}

export interface AgentlasSurfaceRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  title: string;
  domain: string;
  layout: string;
  manifest: AgentlasSurfaceManifest;
  state: JsonObject;
  provenance: AgentlasSurfaceProvenance[];
  jobSummary?: SurfaceJobCostSummary;
  createdAt: string;
  updatedAt: string;
}

export interface SurfaceJobRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  jobId: string;
  label: string;
  status: string;
  costEstimate: number | null;
  costSpent: number | null;
  currency: string | null;
  resumable: boolean;
  manifestJob: AgentlasSurfaceJob;
  createdAt: string;
  updatedAt: string;
}

export interface SurfaceJobCostSummary {
  currency: string;
  jobCount: number;
  queuedCount: number;
  runningCount: number;
  pausedCount: number;
  succeededCount: number;
  failedCount: number;
  resumableCount: number;
  costEstimate: number;
  costSpent: number;
  budgetLimit?: number;
  approvalThreshold?: number;
  overLimit: boolean;
  needsApproval: boolean;
}

export interface SurfaceJobUpdateRequest {
  surfaceId: string;
  jobId: string;
  status?: string;
  costSpent?: number;
  note?: string;
}

export interface SurfaceStatePatchRequest {
  surfaceId: string;
  /** JSON Pointer path inside the surface state overlay, e.g. /data/shots/rows/0/status. */
  path: string;
  value: JsonValue;
  actor?: "user" | "agent" | "system" | string;
  label?: string;
}

export interface SurfaceStateEventRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actor: string;
  eventType: "state-patch" | string;
  path: string;
  value: JsonValue;
  previousValue: JsonValue | null;
  label: string | null;
  createdAt: string;
}

export type SurfaceApprovalKind =
  | "capability"
  | "budget"
  | "payment"
  | "credential"
  | "browser-session"
  | "full-permission"
  | string;

export interface SurfaceApprovalRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actionId: string | null;
  actionType: string;
  kind: SurfaceApprovalKind;
  scopeKey: string;
  title: string;
  summary: string;
  metadata: JsonObject;
  revokedAt: string | null;
  createdAt: string;
}

export interface SurfaceApprovalGrantRequest {
  surfaceId: string;
  actionId?: string | null;
  actionType: string;
  kind: SurfaceApprovalKind;
  scopeKey: string;
  title: string;
  summary: string;
  metadata?: JsonObject;
}

export interface SurfaceApprovalCheckRequest {
  surfaceId: string;
  scopeKey: string;
}

export interface SurfaceAssetPackRequest {
  chatId: string;
  surfaceId: string;
  actionId?: string;
  manifest: AgentlasSurfaceManifest;
}

export interface SurfaceAssetPackGeneratedFile {
  path: string;
  kind: "doc" | "manifest" | "html" | "metadata" | "prompt" | "media";
  bytes: number;
}

export interface SurfaceAssetPackRemoteAsset {
  id: string;
  label: string;
  url: string;
  evidenceIds?: string[];
  sourceData?: string;
  status?: "referenced" | "downloaded" | "skipped";
  downloadedPath?: string;
  mediaType?: string;
  bytes?: number;
  reason?: string;
}

export interface SurfaceAssetPackSnapshot {
  packId: string;
  packName: string;
  rootPath: string;
  manifestPath: string;
  indexPath: string;
  assetsPath: string;
  fileUrl?: string;
  createdAt: string;
  files: SurfaceAssetPackGeneratedFile[];
  remoteAssets: SurfaceAssetPackRemoteAsset[];
  summary: string;
}

export type SurfaceAssetPackStatus = "materialized" | "restored" | "archived";

export type SurfaceAssetPackOperationKind = "materialize" | "archive" | "restore";

export interface SurfaceAssetPackRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actionId: string | null;
  packName: string;
  domain: string;
  layout: string;
  rootPath: string;
  manifestPath: string;
  indexPath: string;
  assetsPath: string;
  manifest: AgentlasSurfaceManifest;
  snapshot: SurfaceAssetPackSnapshot;
  status: SurfaceAssetPackStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SurfaceAssetPackOperationRecord {
  id: string;
  packId: string;
  operation: SurfaceAssetPackOperationKind;
  ok: boolean;
  result: JsonValue;
  createdAt: string;
}

export interface SurfaceAssetPackMaterializeResult extends SurfaceAssetPackSnapshot {
  fileUrl: string;
  record?: SurfaceAssetPackRecord;
}

export interface SurfaceAssetPackRootRequest {
  rootPath: string;
}

export interface AppFactoryScaffoldRequest {
  chatId: string;
  surfaceId: string;
  actionId?: string;
  manifest: AgentlasSurfaceManifest;
}

export interface AppFactoryGeneratedFile {
  path: string;
  kind: "doc" | "source" | "config" | "test" | "data";
  bytes: number;
}

export interface AppFactoryScaffoldSnapshot {
  appId: string;
  appName: string;
  rootPath: string;
  previewPath: string;
  setupPath: string;
  smokePath: string;
  runtimeMode?: "external-local-webapp" | "cloud-manifest" | "legacy-internal-runner" | string;
  launchUrl?: string;
  devCommand?: string;
  localPort?: number;
  createdAt: string;
  files: AppFactoryGeneratedFile[];
  summary: string;
}

export type AppFactoryRuntimeEngine =
  | "generated-app"
  | "cardnews"
  | "document-studio"
  | string;

export interface AppFactoryCloudAppManifestRequest {
  cloudId: string;
  slug: string;
  version: string;
  runtimeEngine: AppFactoryRuntimeEngine;
  minDesktopVersion?: string;
  sourceUrl?: string;
  launchUrl?: string;
  devCommand?: string;
  manifest: AgentlasSurfaceManifest;
  chatId?: string;
  projectId?: string | null;
  agentId?: string;
  surfaceId?: string;
  actionId?: string | null;
  fileCount?: number;
  publishedAt?: string;
  updatedAt?: string;
  metadata?: JsonObject;
}

export type AppFactoryAppStatus =
  | "scaffolded"
  | "cloud-installed"
  | "cloud-synced"
  | "mcp-ready"
  | "operations-ready"
  | "smoke-passed"
  | "smoke-failed"
  | "preview-ready"
  | "tool-published"
  | "restored"
  | "archived";

export type AppFactoryOperationKind =
  | "scaffold"
  | "install-cloud-app"
  | "sync-cloud-manifest"
  | "open-launch-target"
  | "run-autopilot"
  | "install-mcp"
  | "run-provider-tasks"
  | "materialize-assets"
  | "activate-local-commerce-stack"
  | "capture-provider-browser-sessions"
  | "launch-provider-session"
  | "sync-provider-browser-results"
  | "resolve-provider-credentials"
  | "approve-provider-payment"
  | "open-provider-browser"
  | "run-smoke-test"
  | "deploy-preview"
  | "publish-as-tool"
  | "archive"
  | "restore";

export interface AppFactoryAppRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actionId: string | null;
  appName: string;
  domain: string;
  layout: string;
  rootPath: string;
  previewPath: string;
  setupPath: string;
  smokePath: string;
  manifest: AgentlasSurfaceManifest;
  scaffold: AppFactoryScaffoldSnapshot;
  status: AppFactoryAppStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AppFactoryOperationRecord {
  id: string;
  appId: string;
  operation: AppFactoryOperationKind;
  ok: boolean;
  result: JsonValue;
  createdAt: string;
}

export interface AppFactoryScaffoldResult extends AppFactoryScaffoldSnapshot {
  record?: AppFactoryAppRecord;
}

export interface AppFactoryCloudAppInstallResult {
  app: AppFactoryAppRecord;
  operation: AppFactoryOperationRecord;
  rootPath: string;
  installed: boolean;
}

export interface AppFactoryRootRequest {
  rootPath: string;
}

export interface AppFactoryLaunchTargetResult {
  rootPath: string;
  target: string;
  mode: "external-url" | "local-file" | "local-folder";
  opened: boolean;
  summary: string;
}

export interface MetaAgentTeamFactoryFile {
  path: string;
  kind: "doc" | "prompt" | "config";
  bytes: number;
}

export interface MetaAgentTeamFactoryRequest {
  chatId: string;
  surfaceId?: string;
  manifest: AgentlasSurfaceManifest;
  baseDir?: string;
}

export interface MetaAgentTeamFactoryResult {
  rootPath: string;
  agent: InstalledAgent;
  firm: InstalledFirm;
  org: ResolvedOrg;
  files: MetaAgentTeamFactoryFile[];
  createdAt: string;
}

export interface AppFactorySmokeResult {
  rootPath: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  testedAt: string;
}

export interface AppFactoryMcpInstallResult {
  rootPath: string;
  configPath: string;
  envPath: string;
  adapters: Array<{
    id: string;
    name: string;
    type: string;
    path: string;
    envKey?: string;
    status: string;
  }>;
  missingCredentials: string[];
  createdAt: string;
}

export interface AppFactoryProviderTaskRunRequest extends AppFactoryRootRequest {
  taskId?: string;
}

export interface AppFactoryProviderBrowserPlan {
  connectorId: string;
  connectorName: string;
  type: string;
  startUrl: string;
  purpose?: string;
  auth?: string;
  envKey?: string;
}

export interface AppFactoryProviderCredentialGate {
  envKey: string;
  label: string;
  connectorId?: string;
  provider?: string;
  scope?: string;
  allowedHosts?: string[];
  allowedOperations?: string[];
  setupUrl?: string;
  brokerMode?:
    | "host-bound-broker"
    | "runtime-env-injection"
    | "provider-managed-oauth"
    | "manual-provider-page"
    | string;
  inputMode: "agentlas-vault" | "provider-page" | "oauth-browser" | string;
  saveTarget: "agentlas-env-vault" | string;
  hasValue?: boolean;
}

export interface AppFactoryProviderPaymentGate {
  merchant: string;
  quoteRequired: boolean;
  amount?: number | null;
  currency?: string | null;
  recurrence: string;
  approvalMode: string;
  cardHandling: string;
  actionId?: string;
}

export interface AppFactoryProviderPaymentApproveRequest extends AppFactoryRootRequest {
  merchant: string;
  quoteRequired?: boolean;
  amount?: number | null;
  currency?: string | null;
  recurrence?: string;
  approvalMode?: string;
  cardHandling?: string;
  actionId?: string;
  scopeKey?: string;
  approvedBy?: string;
  purpose?: string;
}

export interface AppFactoryProviderPaymentApproval extends AppFactoryProviderPaymentGate {
  status: "approved";
  scopeKey: string;
  approvedBy: string;
  approvedAt: string;
  purpose: string;
}

export interface AppFactoryProviderPaymentApproveResult {
  rootPath: string;
  approvalPath: string;
  approval: AppFactoryProviderPaymentApproval;
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderActionRecipe {
  id: string;
  connectorId: string;
  connectorName: string;
  type: string;
  mode: "api-or-browser" | "browser-first" | "local-fallback" | string;
  status: "planned" | "credential-ready" | "secure-checkpoint-required" | string;
  requiredEnvKeys: string[];
  browserStartUrl?: string;
  nextActions: string[];
  checkpoints: string[];
  fallbackProviders: string[];
  resolutionLadder?: string[];
  localFallback?: string;
  humanInputPolicy?: string;
  deadEndPolicy?: string;
  liveGuard: string;
}

export interface AppFactoryProviderResolutionAttempt {
  id: string;
  label: string;
  status: "ready" | "planned" | "needs-secure-input" | "needs-payment-approval" | "not-needed" | "unavailable" | string;
  detail: string;
  artifact?: string;
}

export interface AppFactoryProviderResolutionPlan {
  connectorId: string;
  connectorName: string;
  type: string;
  status: "ready" | "recoverable" | "needs-secure-input" | "contract-violation" | string;
  canProceedWithoutMcp: boolean;
  currentBestPath: string;
  attempts: AppFactoryProviderResolutionAttempt[];
  fallbackProviders: string[];
  deadEndReasonsCovered: string[];
  humanCheckpoints: string[];
  localFallback?: string;
}

export interface AppFactoryProviderNoDeadEndStrategy {
  version: "0.1" | string;
  status: "recoverable" | "contract-violation" | string;
  generatedAt: string;
  fallbackLadder: string[];
  plans: AppFactoryProviderResolutionPlan[];
  violations: string[];
  policy: string[];
  summary: string;
}

export interface AppFactoryProviderTaskResult {
  id: string;
  label: string;
  type: string;
  beforeStatus: string;
  afterStatus: string;
  secureInputRequired: boolean;
  summary: string;
  browserStartUrl?: string;
  vaultEnvKeys?: string[];
  paymentApproval?: AppFactoryProviderPaymentGate;
  humanCheckpoints?: string[];
}

export interface AppFactoryProviderTaskRunResult {
  rootPath: string;
  operationsPath: string;
  providerTasksPath: string;
  resultsPath: string;
  recipesPath: string;
  runbookPath: string;
  tasks: AppFactoryProviderTaskResult[];
  browserPlans: AppFactoryProviderBrowserPlan[];
  credentialGates: AppFactoryProviderCredentialGate[];
  paymentGates: AppFactoryProviderPaymentGate[];
  providerRecipes: AppFactoryProviderActionRecipe[];
  noDeadEndStrategy: AppFactoryProviderNoDeadEndStrategy;
  noDeadEndStrategyPath: string;
  readyCount: number;
  secureInputRequiredCount: number;
  createdAt: string;
  summary: string;
}

export interface AppFactoryAssetMaterializeRequest extends AppFactoryRootRequest {
  budgetApproved?: boolean;
  approvedBy?: string;
  approvalReason?: string;
}

export interface AppFactoryMaterializedAsset {
  name: string;
  path: string;
  sourcePath: string;
  productName?: string;
  kind: string;
  status: string;
  evidenceKind: string;
}

export interface AppFactoryAssetMaterializeResult {
  rootPath: string;
  operationsPath: string;
  assetsDir: string;
  assets: AppFactoryMaterializedAsset[];
  budget: JsonObject;
  createdAt: string;
  summary: string;
}

export interface AppFactoryLocalCommerceActivationRequest extends AppFactoryRootRequest {
  mode?: "sandbox" | "local-first";
  activatedBy?: string;
}

export interface AppFactoryLocalCommerceActivationResult {
  rootPath: string;
  operationsPath: string;
  localDatabasePath: string;
  runtimePath: string;
  checkoutPath: string;
  products: number;
  orders: number;
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderBrowserOpenRequest extends AppFactoryRootRequest {
  connectorId?: string;
}

export interface AppFactoryProviderBrowserOpenResult {
  rootPath: string;
  opened: AppFactoryProviderBrowserPlan[];
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderBrowserSessionRequest extends AppFactoryRootRequest {
  connectorId?: string;
  mode?: "plan-only" | "headless";
  timeoutMs?: number;
  screenshot?: boolean;
}

export interface AppFactoryProviderBrowserSession {
  connectorId: string;
  connectorName: string;
  type: string;
  startUrl: string;
  status: string;
  checkpoints: string[];
  capturedAt: string;
  finalUrl?: string;
  title?: string;
  screenshotPath?: string;
  blockerKind?: string;
  nextAction?: string;
  evidenceKind?: string;
  agentCanContinue?: boolean;
  safeStorage?: string[];
  resumeProfileDir?: string;
  resumeLauncherPath?: string;
  resumeCommand?: string;
  handoffPath?: string;
  actionQueuePath?: string;
  checkpointManifestPath?: string;
  resultPath?: string;
  resultStatus?: string;
  resultSyncedAt?: string;
  resultObservedAt?: string;
  resultSummary?: string;
  credentialContainer?: string;
  error?: string;
}

export interface AppFactoryProviderBrowserSessionResult {
  rootPath: string;
  sessionsPath: string;
  screenshotsDir: string;
  mode: "plan-only" | "headless";
  sessions: AppFactoryProviderBrowserSession[];
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderBrowserLaunchRequest extends AppFactoryRootRequest {
  connectorId?: string;
  approved?: boolean;
  dryRun?: boolean;
}

export interface AppFactoryProviderBrowserLaunchResult {
  rootPath: string;
  ok: boolean;
  connectorId: string;
  connectorName: string;
  status: "dry-run" | "approval-required" | "launched";
  dryRun: boolean;
  launched: boolean;
  approved: boolean;
  pid?: number;
  launcherPath: string;
  resumeCommand: string;
  actionQueuePath?: string;
  handoffPath?: string;
  checkpointManifestPath?: string;
  resultPath?: string;
  actionQueue?: JsonObject | null;
  createdAt: string;
  summary: string;
  safety: string;
}

export interface AppFactoryProviderBrowserResultSyncRequest extends AppFactoryRootRequest {
  connectorId?: string;
}

export interface AppFactoryProviderBrowserResultSyncItem {
  connectorId: string;
  connectorName: string;
  status: "synced" | "pending";
  resultStatus?: string;
  resultPath?: string;
  finalUrl?: string;
  title?: string;
  error?: string;
  observedAt?: string;
  agentCanContinue: boolean;
  summary: string;
}

export interface AppFactoryProviderBrowserResultSyncResult {
  rootPath: string;
  operationsPath: string;
  synced: number;
  pending: number;
  results: AppFactoryProviderBrowserResultSyncItem[];
  createdAt: string;
  summary: string;
}

export interface AppFactoryProviderCredentialResolveRequest extends AppFactoryRootRequest {
  source?: "env" | "agentlas-env-vault" | "auto";
}

export interface AppFactoryProviderCredentialResolution {
  envKey: string;
  label: string;
  connectorId?: string;
  provider?: string;
  scope?: string;
  allowedHosts?: string[];
  allowedOperations?: string[];
  setupUrl?: string;
  brokerMode?: string;
  status: "live-credential-ready" | "secure-input-required";
  source: string;
  saveTarget: string;
  inputMode: string;
  fingerprint?: string;
}

export interface AppFactoryProviderCredentialResolveResult {
  rootPath: string;
  resolutionPath: string;
  runbookPath: string;
  credentials: AppFactoryProviderCredentialResolution[];
  resolvedCount: number;
  missingCount: number;
  createdAt: string;
  summary: string;
}

export type AppFactoryAutopilotStepStatus = "completed" | "skipped" | "waiting" | "failed";

export interface AppFactoryAutopilotStep {
  id: string;
  label: string;
  status: AppFactoryAutopilotStepStatus;
  summary: string;
}

export interface AppFactoryAutopilotRequest extends AppFactoryRootRequest {
  budgetApproved?: boolean;
  approvedBy?: string;
  approvalReason?: string;
  credentialSource?: "env" | "agentlas-env-vault" | "auto";
  captureProviderSessions?: boolean;
  browserMode?: "plan-only" | "headless";
  timeoutMs?: number;
}

export interface AppFactoryAutopilotResult {
  rootPath: string;
  appName: string;
  domain: string;
  status: "operated" | "waiting-for-secure-input" | "needs-review";
  steps: AppFactoryAutopilotStep[];
  waitingOn: string[];
  providerRun?: AppFactoryProviderTaskRunResult;
  materializedAssets?: AppFactoryAssetMaterializeResult;
  localStack?: AppFactoryLocalCommerceActivationResult;
  providerBrowser?: AppFactoryProviderBrowserOpenResult;
  providerBrowserSessions?: AppFactoryProviderBrowserSessionResult;
  credentialResolution?: AppFactoryProviderCredentialResolveResult;
  mcp?: AppFactoryMcpInstallResult;
  smoke?: AppFactorySmokeResult;
  preview?: AppFactoryPreviewResult;
  appTool?: AppFactoryAppToolPublishResult;
  createdAt: string;
  summary: string;
}

export interface AppFactoryPreviewResult {
  rootPath: string;
  previewPath: string;
  deployPath: string;
  manifestPath: string;
  fileUrl: string;
  serveCommand: string;
  launchUrl?: string;
  devCommand?: string;
  createdAt: string;
}

/**
 * A generated app preview that is actually reachable now. Local generated apps
 * are served by a main-owned loopback server; cloud/external apps retain their
 * declared HTTPS URL. A scaffold path by itself is never reported as live.
 */
export interface AppFactoryLivePreviewResult {
  ok: boolean;
  appId: string;
  url?: string;
  runtime: "managed-loopback" | "external-web" | "unavailable";
  revision?: number;
  reason?: string;
}

export interface WorkLiveViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WorkLiveViewState = "opening" | "loading" | "ready" | "error" | "closed";

export type WorkLiveViewInput =
  | { kind: "pointer"; phase: "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { kind: "key"; phase: "down" | "up"; key: string }
  | { kind: "text"; text: string };

type NativeBrowserCookieImportFailureCode =
  | "authorization-required"
  | "migration-requires-connect"
  | "source-host-unavailable"
  | "source-ownership-unverified"
  | "source-reservation-failed"
  | "source-protocol-unavailable"
  | "source-cookie-read-failed"
  | "source-empty"
  | "no-transferable-cookies"
  | "destination-write-failed";

export type NativeBrowserCookieImportCode = "imported" | "already-migrated" | "partial" | NativeBrowserCookieImportFailureCode;

export interface NativeBrowserCookieImportResult {
  ok: boolean;
  code: NativeBrowserCookieImportCode;
  /** This transfer intentionally excludes DOM storage, IndexedDB, cache, and service-worker state. */
  scope: "cookies-only";
  destinationPartition: "persist:agentlas-browser-default";
  observed: number;
  imported: number;
  /** Existing native cookies retained by Connect migration, never overwritten. */
  preserved?: number;
  skipped: {
    expired: number;
    partitioned: number;
    invalid: number;
    writeFailed: number;
  };
  /** Present only for the bounded machine-readable browser-host failure contract. */
  hostFailure?: BrowserCdpHostFailureDiagnostic;
}


export interface WorkLiveBrowserTab extends WorkLiveViewStatus {
  /** True only for the currently shown, ready guest. */
  visible?: boolean;
  taskScopeId: string;
  url: string;
}

export interface WorkLiveViewStatus {
  /** Main-issued foreground AI action; navigation status alone is not presentation authority. */
  presentation?: { id: string; runId: string };
  /** Cookie transfer receipt for this URL only; unrelated sites remain in Main. */
  nativeSession?: NativeBrowserCookieImportResult;
  viewId: string;
  taskScopeId?: string;
  state: WorkLiveViewState;
  canGoBack?: boolean;
  canGoForward?: boolean;
  url?: string;
  title?: string;
  error?: string;
}

export interface AppFactoryAppToolPublishResult {
  rootPath: string;
  toolName: string;
  toolDir: string;
  configPath: string;
  mcpPath: string;
  server: InstalledMcpServer;
  publishedAt: string;
  summary: string;
}

// ── Agentlas Cloud agent packaging / marketplace registration ─────────────
// Packaging and security review run on the submitter's machine. Agentlas Cloud
// receives package hashes, manifests, and review evidence; it must not call a
// platform-owned LLM for this flow.
export type CloudAgentReviewMode = "static-only" | "local-runtime";
export type CloudAgentVisibility = "private-link" | "marketplace";
export type CloudAgentPackageStatus = "ready" | "blocked" | "registered" | "dry-run";

export interface CloudAgentPackageRequest {
  /** Local agent/team/repo folder to package. */
  rootPath: string;
  /** Optional public slug. If omitted, derived from the folder/name. */
  slug?: string;
  /**
   * The caller's `slug` is a local-registry name, not a publishing identity.
   * A registered agent/team carries a namespaced local slug (`local-…`,
   * `firm-local-…`, plus a `-2` de-duplication suffix) that exists only to keep
   * rows unique on this machine. Uploading under it mints a SECOND cloud
   * identity for a package that already owns one, which the server refuses with
   * `slug_identity_conflict`. When this is set the package's own stable slug
   * (agent-card / agentlas.json) wins and `slug` is only the fallback.
   */
  preferPackageSlug?: boolean;
  /** Defaults to owner-private Agent Cloud storage. Use marketplace only for an explicit public Hub publish. */
  visibility?: CloudAgentVisibility;
  /** true packages and reviews locally but does not call agentlas.cloud. */
  dryRun?: boolean;
  /** static-only is free; local-runtime uses the submitter's active CLI/BYOK/local runtime. */
  reviewMode?: CloudAgentReviewMode;
  /** Optional operator note stored with the registration request. */
  notes?: string;
  /**
   * Plain-language answer collected only when the package does not explain
   * what work the agent completes. Main turns it into routing metadata; users
   * never have to know Agentlas card field names.
   */
  purposeAnswer?: string;
  /** Opaque renderer-generated correlation id for live upload progress. Not authority. */
  progressId?: string;
  /**
   * The person answered "yes, replace it" to the one overwrite question main
   * asked about THIS folder. It carries no target: main stored what it asked
   * about and re-reads it, so a renderer can never name which cloud asset gets
   * replaced.
   */
  confirmOverwrite?: boolean;
}

/** Renderer-to-main request. The native picker capability, not a renderer path,
 * authorizes which local package root may be read. */
export type CloudAgentPublishRequest = Omit<CloudAgentPackageRequest, "rootPath"> & {
  rootGrant: FsPathGrant;
};

/** Owner-only Agent Cloud save. Public routing cards and model review do not apply. */
export type CloudAgentPrivateSaveRequest = Omit<
  CloudAgentPublishRequest,
  "visibility" | "reviewMode"
>;

/**
 * A Build-completion save reuses the already-approved Build package root.
 * Main must resolve `folder` against `scope`; renderer cannot choose visibility,
 * review mode, notes, slug, or dry-run behavior on this narrow surface.
 */
export interface CloudAgentBuiltPrivateSaveRequest {
  folder: string;
  scope: FsReadScope;
  /** Opaque renderer-generated correlation id for live upload progress. Not authority. */
  progressId?: string;
}

/** Explicit public Agentlas Hub publish. Public routing and review gates apply. */
export type CloudAgentHubPublishRequest = Omit<CloudAgentPublishRequest, "visibility">;

export type CloudAgentRegisteredTarget =
  | { entityKind: "agent"; agentId: string }
  | { entityKind: "team"; firmId: string }
  | { entityKind: "team"; agentId: string };

export interface CloudAgentRegisteredUploadOption {
  target: CloudAgentRegisteredTarget;
  name: string;
  slug: string;
  entityKind: "agent" | "team";
  sourceReady: boolean;
}

export interface CloudAgentRegisteredSaveRequest {
  target: CloudAgentRegisteredTarget;
  /** Opaque renderer-generated correlation id for live upload progress. Not authority. */
  progressId?: string;
  /** Answers main's one overwrite question for this target. Carries no cloud id. */
  confirmOverwrite?: boolean;
}

export interface CloudAgentRegisteredPublishRequest extends CloudAgentRegisteredSaveRequest {
  reviewMode?: CloudAgentReviewMode;
  notes?: string;
  purposeAnswer?: string;
}

/** Ordered, machine-readable phases of one Agent Cloud / Hub upload. */
export type CloudAgentPublishStage =
  | "starting"
  | "cleaning"
  | "routing-card"
  | "remediating"
  | "blockers"
  | "excluded"
  | "scan-clean"
  | "scanning"
  | "metadata"
  | "packaging"
  | "reviewing"
  | "uploading"
  | "receipt"
  | "done"
  | "error";

/**
 * Live upload progress. Main already computed these phases internally; before
 * this event they were only ever passed to an `onStage` callback that had zero
 * callers, so every upload looked frozen from the renderer's side.
 */
export interface CloudAgentPublishProgressEvent {
  progressId: string;
  stage: CloudAgentPublishStage;
  detail?: string;
  /** ms since the upload started — always advances, even while a phase is silent. */
  elapsedMs: number;
}

export interface CloudAgentSecurityFinding {
  id: string;
  severity: "blocker" | "high" | "medium" | "low" | "info";
  category: "secret" | "policy" | "size" | "structure" | "runtime" | "network" | "review";
  message: string;
  file?: string;
  remediation?: string;
}

export interface CloudAgentPackageFile {
  path: string;
  bytes: number;
  sha256: string;
  kind: "text" | "binary";
  executable?: boolean;
  included: boolean;
  reason?: string;
}

export interface CloudAgentPackageDownloadFile {
  path: string;
  /** Size of the ORIGINAL file, whatever encoding carried it. */
  bytes: number;
  /** sha256 of the ORIGINAL bytes — so packageHash does not move with the encoding. */
  sha256: string;
  contentBase64: string;
  /** Absent means identity, which is what every package written before compression says. */
  encoding?: "gzip";
  /** Bytes that actually travelled. Present only alongside `encoding`. */
  encodedBytes?: number;
  /** Portable execution bit. Raw host permission bits are never transferred. */
  executable?: boolean;
}

export type CloudAgentPackageHashVersion = "path-sha256-v1" | "path-sha256-executable-v2";
export type CloudAgentCloudScope = "owner-private" | "hub-public";

export interface CloudAgentLocalizedListing {
  titleEn: string;
  titleKo: string;
  descriptionEn: string;
  descriptionKo: string;
}

/** Opaque optimistic-concurrency identity returned by Agent Cloud. Revisions
 * are equality tokens only; clients must never infer ordering from them. */
export interface CloudAgentRevisionIdentity {
  cloudId: string;
  slug: string;
  scope: CloudAgentCloudScope;
  packageHash: string;
  packageHashVersion: CloudAgentPackageHashVersion;
  revision: string;
  updatedAt?: string;
}

export interface CloudAgentPackageDownload {
  packageHash: string;
  /** Missing means legacy path-sha256-v1. New packages use executable-protected v2. */
  packageHashVersion?: CloudAgentPackageHashVersion;
  fileCount: number;
  totalBytes: number;
  agentKind: "agent" | "team" | "repo" | "graph";
  runtimeLabels: string[];
  files: CloudAgentPackageDownloadFile[];
  /** Optional owner-restore CAS identity. Package bytes remain independently hashed. */
  cloudId?: string;
  scope?: CloudAgentCloudScope;
  revision?: string;
  updatedAt?: string;
  /**
   * Set when this package is an installed COPY of somebody else's Hub agent.
   *
   * Travels with the download so the restore marker can record it. Without it
   * the desktop cannot tell an installed copy from original work once the files
   * are on disk, and the Hub-upload refusal has nothing to read.
   */
  fork?: CloudAgentForkOrigin;
}

/** Where an installed copy came from. Mirrors the web `CloudAgentForkOrigin`. */
export interface CloudAgentForkOrigin {
  originPackageHash: string;
  originAgentDefinitionId: string | null;
  originAgentReleaseId: string | null;
  originSlug: string;
  originOwnerUserId: string | null;
  forkedAt: string;
}

export interface CloudAgentPublicCareerGraph {
  schemaVersion?: string;
  kind: "agentlas-public-career-card";
  generatedAt?: string;
  projectName?: string;
  indexStatus?: string;
  policy?: string;
  privacy?: {
    rawLocalPathsIncluded?: false;
    rawPromptsIncluded?: false;
    rawTranscriptsIncluded?: false;
    sourceTextIncluded?: false;
  };
  counts?: Record<string, number>;
  canonicalSources?: number;
  staleSourceCount?: number;
  sourceKinds?: Record<string, number>;
  nodeTypes?: Record<string, number>;
  edgeTypes?: Record<string, number>;
}

export interface CloudAgentPackageManifest {
  version: "0.1";
  kind: "agentlas-cloud-agent";
  slug: string;
  name: string;
  tagline: string;
  agentKind: "agent" | "team" | "repo" | "graph";
  runtimeLabels: string[];
  visibility: CloudAgentVisibility;
  rootFingerprint: string;
  packageHash: string;
  packageHashVersion: CloudAgentPackageHashVersion;
  fileCount: number;
  includedFileCount: number;
  totalBytes: number;
  createdAt: string;
  billingMode: "submitter-local-runtime" | "static-only";
  costOwner: "submitter" | "none";
  /** Required for public Hub publication; optional for owner-private storage. */
  localized?: CloudAgentLocalizedListing;
  /**
   * Declared when this folder is an installed copy — read from the restore
   * marker, sent on EVERY save including private ones.
   *
   * ★ It travels on the private save specifically because that is the save
   *   that used to erase it. Refusing the Hub upload locally is not enough:
   *   the copy could be re-saved privately as a parentless agent, restored
   *   again into a folder with no marker, and published from there. The server
   *   now also refuses to let an omission clear stored lineage, so this field
   *   and that rule cover the honest and the dishonest client respectively.
   */
  fork?: CloudAgentForkOrigin;
  security: {
    verdict: "pass" | "fail" | "needs-review";
    blockerCount: number;
    highCount: number;
    findingCount: number;
  };
  careerGraph?: CloudAgentPublicCareerGraph;
}

export interface CloudAgentReviewResult {
  mode: CloudAgentReviewMode;
  verdict: "pass" | "fail" | "needs-review";
  costOwner: "submitter" | "none";
  runtimeLabel?: string;
  summary: string;
  findings: CloudAgentSecurityFinding[];
  reviewedAt: string;
  rawText?: string;
}

export interface CloudAgentRegistrationResult {
  cloudId: string;
  slug: string;
  scope: CloudAgentCloudScope;
  packageHash: string;
  packageHashVersion: CloudAgentPackageHashVersion;
  revision: string;
  etag: string;
  url?: string;
  marketplaceUrl?: string;
  registeredAt: string;
  dryRun: boolean;
  /** False means the server commit succeeded but its local CAS receipt could not be persisted. */
  localSyncStored?: boolean;
  /**
   * Server refusals this upload repaired by itself, in the order they happened.
   * A silent repair is not allowed to stay silent: each entry is shown to the
   * user, because "published under a different slug than you asked for" and
   * "overwrote the copy already in your Cloud" are facts they must be able to
   * see after the fact.
   */
  autoRecovered?: string[];
}

/** Exact immutable Hub release reference inside an owner cloud combination. */
export interface CloudAgentCombinationMemberRef {
  agentDefinitionId: string;
  agentReleaseId: string;
}

/**
 * Owner-scoped Agent Cloud combination (cargo.list_combinations /
 * cargo.save_combination / cargo.delete_combination). Holds Hub release
 * references only — never package bytes.
 */
export interface CloudAgentCombination {
  combinationId: string;
  name: string;
  description: string;
  members: CloudAgentCombinationMemberRef[];
  revision: number;
  updatedAt: string;
}

/** Exact semantic result of the current Agent Cloud delete contract. */
export interface CloudAgentDeleteResult {
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

/** One auto-fix applied so a package could publish, surfaced to the user. */
export interface CloudAgentRemediationAction {
  file: string;
  action: "redacted" | "rewritten" | "excluded" | "kept";
  detail: string;
}

export interface CloudAgentPackageResult {
  status: CloudAgentPackageStatus;
  rootPath: string;
  packageDir: string;
  bundlePath: string;
  manifestPath: string;
  manifest: CloudAgentPackageManifest;
  files: CloudAgentPackageFile[];
  review: CloudAgentReviewResult;
  registration?: CloudAgentRegistrationResult;
  /** Auto-fixes the publish pipeline applied to reach an uploadable package. */
  remediation?: CloudAgentRemediationAction[];
  summary: string;
}

export interface ToolFactoryScaffoldRequest {
  chatId: string;
  surfaceId: string;
  actionId?: string;
  toolId?: string;
  manifest: AgentlasSurfaceManifest;
}

export interface ToolFactoryGeneratedFile {
  path: string;
  kind: "doc" | "source" | "config" | "test" | "data";
  bytes: number;
}

export type ToolFactoryToolStatus =
  | "scaffolded"
  | "smoke-passed"
  | "smoke-failed"
  | "mcp-installed"
  | "restored"
  | "archived";

export type ToolFactoryOperationKind =
  | "scaffold"
  | "run-smoke-test"
  | "install-mcp"
  | "archive"
  | "restore";

export interface ToolFactoryScaffoldSnapshot {
  toolId: string;
  requestedToolId: string;
  toolName: string;
  domain: string;
  kind: string;
  rootPath: string;
  configPath: string;
  toolPath: string;
  mcpPath: string;
  smokePath: string;
  createdAt: string;
  files: ToolFactoryGeneratedFile[];
  summary: string;
}

export interface ToolFactoryToolRecord {
  id: string;
  chatId: string;
  projectId: string | null;
  agentId: string;
  surfaceId: string;
  actionId: string | null;
  requestedToolId: string;
  toolId: string;
  toolName: string;
  domain: string;
  kind: string;
  rootPath: string;
  configPath: string;
  toolPath: string;
  mcpPath: string;
  smokePath: string;
  scaffold: ToolFactoryScaffoldSnapshot;
  status: ToolFactoryToolStatus;
  installedServerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolFactoryOperationRecord {
  id: string;
  toolId: string;
  operation: ToolFactoryOperationKind;
  ok: boolean;
  result: JsonValue;
  createdAt: string;
}

export interface ToolFactoryScaffoldResult extends ToolFactoryScaffoldSnapshot {
  record?: ToolFactoryToolRecord;
}

export interface ToolFactoryRootRequest {
  rootPath: string;
}

export interface ToolFactorySmokeResult {
  rootPath: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  testedAt: string;
}

export interface ToolFactoryMcpInstallResult {
  rootPath: string;
  configPath: string;
  mcpPath: string;
  command: string;
  args: string[];
  server: InstalledMcpServer;
  installedAt: string;
}

export interface McpInvocationRequest {
  /** 렌더러가 미리 생성한 실행 id — invoke.run 왕복 전에 이벤트 채널을 구독하기 위함
   *  (subscribe-before-trigger). 없으면 main이 randomUUID로 생성한다(하위호환). */
  runId?: string;
  /** 새 모델: chatId 기반. 에이전트는 chat에서 lookup */
  chatId: string;
  userPrompt: string;
  /** Main-only exact person-authored text before One appends standing-staff context. */
  oneUserAuthoredPrompt?: string;
  /**
   * Who authored `userPrompt`. "system" marks a prompt the product sent on the
   * user's behalf (continue an unfinished run, resume after runtime recovery).
   * Such a turn stays in the conversation for model context, but it is never
   * recorded as the person's own words and never titles the conversation.
   * Absent means "user" — the ordinary case.
   */
  promptOrigin?: "user" | "system";
  /** One may begin as general conversation and promote only on real work signals. */
  taskIntent?: "task" | "conversation";
  /** Interactive One/Work can ask Main to settle the active turn after the direction is durably queued. */
  steeringMode?: "queue" | "interrupt";
  /** Chat sent from an automation's session panel. Main injects that
   *  automation's live-edit contract (name + current graph + the control-block
   *  path) so an instruction typed in chat lands on THIS automation. */
  automationId?: string;
  /** Renderer signal selecting the One product surface. Main derives all approved context itself. */
  oneMode?: boolean;
  /** Opaque, Main-issued one-time Memory capability. Main consumes it only after durable start acceptance. */
  oneMemoryUseOnceRef?: OneMemoryUseOnceRef;
  /** Main-only Briefing review capability. Renderer IPC always strips this field. */
  oneBriefingActionRef?: OneBriefingActionRef;
  /** Opaque Main-issued adaptive-team reservation. Candidate, cost, permission, and prompt remain in Main. */
  oneTeamPreflightRef?: OneTeamPreflightRef;
  /** Opaque, process-local, single-use Desktop One attachment capability. */
  oneAttachmentRef?: OneAttachmentRef;
  /**
   * Explicit closed recurrence controls for proposal evidence only. Main
   * validates and removes this value before dispatch; it never becomes prompt
   * context and cannot create, enable, save, or run an automation.
   */
  oneRecurrenceSelection?: OneRecurrenceSelectionV1;
  /** Main-only approved One Profile/Memory context. Renderer IPC always strips this field. */
  oneProfileContext?: string;
  /** Main-only Site Agent App invocation. Pins the selected target and disables router/automation expansion. */
  agentAppMode?: boolean;
  /**
   * Main-only, per-run capability grant prepared from a persisted Agent App
   * declaration. Renderer IPC always removes this field. It contains opaque
   * MCP secret aliases only; raw key names/values and arbitrary servers are
   * forbidden by the Site capability builder.
   */
  agentAppRuntimeToolGrant?: {
    schemaVersion: 1;
    mcpConfigPath: string;
    /** SHA-256 of the exact main-generated config accepted during JIT preflight. */
    mcpConfigSha256: string;
    mcpAllowedTools: string[];
    mcpRuntimeEnv: Record<string, string>;
    availableCatalogIds: string[];
    /** Value-free registry/config binding revalidated immediately before dispatch. */
    mcpServerBindings: Array<{
      serverId: string;
      catalogId: string;
      configKey: string;
    }>;
    /** In-process handoff receipt; a runtime mismatch downgrades the final disclosure. */
    runtimeStatus: "prepared" | "accepted" | "runtime-unavailable";
  };
  /** 첨부 이미지 — BYOK/Ollama는 멀티모달로, CLI는 읽을 수 있는 로컬 파일로 스테이징해 전송. */
  images?: ImageAttachment[];
  /** UI 사용자 locale — main이 emit하는 상태/오류 메시지가 이 언어로 나옴.
   *  영어 사용자에게 한국어 status가 새지 않도록 renderer가 항상 동봉. */
  locale?: "ko" | "en";
  /** 도구 사용 권한 수준 (ChatInput 권한 칩) — 런타임 권한 모드로 매핑 */
  permissions?: "read" | "write" | "full";
  /** One composer의 원래 선택값. Auto의 보수적 승격과 명시적 Read only를 구분한다. */
  onePermissionMode?: "auto" | "read" | "write" | "full";
  /** 자동화 등 백그라운드 실행에서 Playwright persistent profile lock을 피하기 위한 MCP 브라우저 프로필 키. */
  mcpBrowserProfileKey?: string;
  /** Main-only Graph boundary: refresh the consented source cookies immediately
   * before the first Agentlas Browser node. Renderer IPC strips this field. */
  forceBrowserCredentialRefresh?: boolean;
  /**
   * 그래프가 **명시적으로 붙인** 도구들(MCP 카탈로그 id). 커넥터 C06 — 캔버스에서
   * `tool` 노드를 이 에이전트에 선으로 이어 놓은 것들이다.
   *
   * ★자동 선택과 다르다: 자동 선택은 프롬프트를 보고 골라 주는 편의이고, 이건
   * 사용자가 그래프에 그려 넣은 **선언**이다. 선언한 것은 선택 결과와 무관하게 켠다 —
   * 안 그러면 화면에서는 도구를 붙였는데 실행에는 없는 상태가 된다.
   */
  requiredToolCatalogIds?: string[];
  /**
   * 커넥터 C38 — 이번 호출에 걸 **도구 중개 관문**. 런타임이 도구를 부르기 직전에 도는
   * 훅 설정 파일 경로다. 위 `requiredToolCatalogIds`가 "무엇을 켤지"라면 이건 "무엇을
   * 못 쓰게 할지"이고, 켜기만 하는 쪽으로는 선언을 지킬 수 없다(허용 깃발은 거절을 못 한다).
   * 관문을 걸 수 없는 런타임에서는 **채우지 않는다** — 비워 두는 것이 정직한 상태다.
   */
  toolBrokerSettingsPath?: string;
  /**
   * 이번 호출이 **시뮬레이션**인가. 권한을 read로 낮추는 것과 다르다 — 권한은 런타임이
   * 해석하는 요청이고, 이 표시는 중개 관문이 바깥을 바꾸는 도구를 실제로 거절하게 만든다.
   */
  simulation?: boolean;
  /** 중개 관문을 만들 때 쓰는 노드 식별(실행 id / 노드 id). 커널만 채운다. */
  toolBrokerScope?: { runId: string; nodeId: string };
  /** 자동화가 저장한 실행 도구 선호도. */
  toolMode?: AutomationToolMode;
  /** 자동화가 저장한 Hub 사용 정책. */
  hubMode?: AutomationHubMode;
  /** 계획 모드 — 실행 전에 사용자에게 읽히는 작업 계획과 검증 기준을 먼저 세운다. */
  planMode?: boolean;
  /** 목표 추진 모드 — 사용자의 요청을 지속 가능한 목표로 구조화한다. */
  goalMode?: boolean;
  /** 채팅 목표를 Agentlas 안에서 실행되는 Apps 패키지로 생성하도록 요청한다. */
  appsGenerateMode?: boolean;
  /** 기존 생성 App을 채팅에서 수정/보관할 때 지정하는 대상. */
  targetAppId?: string;
  targetAppAction?: "edit" | "archive";
  /** 추천 시트의 네트워크 모드에서 고른 Hub 에이전트 슬러그 — runMcpInvocation 이 hep-call 로
   *  이들을 빌려와(BYOM) 프롬프트 앞에 borrow 지시를 붙여 데스크탑 런타임으로 실행한다. */
  borrowAgents?: string[];
  /** 슬러그별 packageHash 핀(선택). borrowAgents와 병렬 맵으로 두는 이유: `string[]`을
   *  객체 배열로 바꾸면 이 필드를 읽는 15+ 지점과 모바일 브리지 wire 프로토콜이 깨진다.
   *  미지정 슬러그는 latest. 반복 자동화가 재게시 drift를 겪지 않도록 스케줄러가 채운다. */
  borrowVersions?: Record<string, string>;
  /** Main-owned scheduled automation runtime pin. If unavailable, execution fails closed. */
  runtimeSelection?: RuntimeSelection;
  /** 임시 최상위 TF의 정확한 실행 단위. Main이 실행 직전에 각 대상을 재검증한다. */
  taskForceTargets?: OrchestrationTarget[];
  /** 추천 시트의 pipeline 모드에서 받은 stage 계약 — 런타임이 단계별 입력/출력 handoff로 실행한다. */
  pipelineStages?: RecStage[];
  /** 저신뢰 라우팅 결정을 호스트 LLM Router Agent로 재판단해야 할 때 전달되는 에스컬레이션. */
  routerAgent?: RecRouterAgent;
  /** Keep the bound chat roster first and recruit from Network/Cloud only after a model-judged capability gap. */
  sessionRouting?: boolean;
  /** Explicit per-turn Stormbreaker preference. Absent means the controller decides; it never means OFF. */
  stormbreakerMode?: boolean;
  /** Explicit One fast-turn preference: one direct pass and the lowest verified reasoning effort. */
  fastMode?: boolean;
}

/** Main-owned Codex-style steering acknowledgement shared by Desktop and Mobile. */
export interface InvocationSteerResult {
  accepted: true;
  /** Exact conversation whose queue/run accepted this direction. */
  chatId: string;
  queued: boolean;
  /** True when the accepted direction also asked Main to settle the active turn immediately. */
  interruptsCurrent: boolean;
  activeRunId?: string;
  position?: number;
  runId?: string;
  /** Durable queue ledger identity, present only when queued=true. */
  queuedRequestId?: string;
  promptHash?: string;
}

export interface MobileBridgeDeviceSummary {
  deviceId: string;
  name: string;
  platform: "ios" | "android";
  appVersion: string | null;
  issuedAt: string;
  revokedAt: string | null;
}

export interface MobileBridgeRuntimeStatus {
  running: boolean;
  endpoint: string | null;
  secure: boolean;
  hostId: string | null;
  devices: MobileBridgeDeviceSummary[];
  /** Authenticated sockets that completed ready + snapshot. Pairing alone is
   * not a live Mobile connection and must never be presented as one. */
  connectedDeviceIds: string[];
  error: string | null;
}

/** 실행 전 API 키 요청 — 값이 아니라 "어떤 키가 필요한가"만 담는다(value-free).
 *  값 저장은 렌더러가 기존 env:set으로 직접 하고, 완료 신호만 mcp:supplyRunKeys로 돌아온다. */
export interface McpRunKeyRequestEnvKey {
  key: string;
  label?: string;
  labelEn?: string;
  hint?: string;
  hintEn?: string;
}

export interface McpRunKeyRequestTool {
  /** catalogId(카탈로그 출신) 또는 installed server id(커스텀). */
  id: string;
  name: string;
  /** 키 발급 페이지 (카탈로그 setupUrl) — 시트에서 "키 발급 →" 링크. */
  setupUrl?: string;
  envKeys: McpRunKeyRequestEnvKey[];
}

export interface McpRunKeyRequest {
  /** runId와 동일 — 같은 실행의 중복 요청은 멱등 처리된다. */
  requestId: string;
  runId: string;
  /** epoch ms — 지나면 메인이 declined로 자동 진행(런은 절대 여기 걸려 멈추지 않는다). */
  expiresAt: number;
  tools: McpRunKeyRequestTool[];
}

/**
 * A worker turn and the CLI process that hosts it have different lifecycles.
 * A completed turn may leave a resident CLI idle, while a closed CLI may
 * interrupt a turn before it produces a result. Keep those facts separate so
 * the renderer never infers process death from a normal `done` event.
 */
export type AgentProcessState = "running" | "idle" | "closed" | "failed";

export type AgentProcessLifecycleReason =
  | "spawned"
  | "turn-started"
  | "turn-complete"
  | "transport-closed"
  | "process-exit"
  | "reaped"
  | "shutdown"
  | "evicted"
  | "error";

export type AgentMessageDirection = "orchestrator-to-worker" | "worker-to-orchestrator";

export interface AgentProcessLifecycleEvent {
  source: "cli-process";
  state: AgentProcessState;
  reason: AgentProcessLifecycleReason;
  /** Runtime kind only; no pid, command line, cwd, or environment is exposed. */
  runtime?: string;
}

export interface AgentMessageEvent {
  messageId: string;
  direction: AgentMessageDirection;
  fromAgentId: string;
  toAgentId: string;
  /**
   * Optional typed parent in the same Taskforce transcript. This lets the
   * renderer show a Buzz-style comment without guessing relationships from
   * prose or exposing execution identifiers in the room.
   */
  replyToMessageId?: string;
  /** Exact Main-owned report is loaded only when its worker panel opens. */
  reportAvailable?: boolean;
  /** Bounded, user-visible brief/result excerpt. */
  text: string;
  /** Host-enforced typed-handoff facts. Depth is 1..3; a pair may round-trip at most 4 times. */
  handoffDepth?: number;
  handoffRoundtrip?: number;
  /**
   * 이 발언을 만들며 **실제로 부른** 도구 이름들(중복 제거, 관측값).
   *
   * 시연 화면의 `Skill used: …` 줄은 호스트 인격의 라우터 템플릿이 본문으로 샌
   * 것이라 막혔다(G-2/G-3, 2026-08-25). 사람이 보고 싶어 한 것 — "이 팀원이 무엇을
   * 써서 일했나" — 은 정당하므로, 모델이 쓴 산문 대신 관측된 사실로 싣는다.
   * 지어낼 수 없는 값이다.
   */
  usedTools?: string[];
  /** Explicit child grant minted by Main; it is never copied from the parent. */
  handoffPermission?: "read" | "write" | "full";
  /** Always false for a successful typed handoff; present for auditability. */
  permissionInherited?: false;
  /** Set only when the host refused a handoff; the run must escalate to One. */
  handoffBlocked?: "depth" | "roundtrip" | "permission";
}

export interface AgentlasUserDecisionQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}

/**
 * Host-parsed projection of a model-authored ask fence. This means only that
 * the run is waiting for an explicit user choice. It is never an approval,
 * capability grant, or authority to execute the recommended option.
 */
export interface AgentlasUserDecisionRequest {
  schemaVersion: "agentlas.user-decision-request.v1";
  /** Main-owned durable assistant row when the exact chat/run binding exists. */
  sourceMessageId?: string;
  questions: AgentlasUserDecisionQuestion[];
}

export interface McpInvocationEvent {
  kind:
    | "lifecycle"
    | "thinking"
    | "tool-use"
    | "partial"
    | "final"
    | "error"
    | "surface"
    | "usage"
    | "reasoning"
    | "mcp-key-request"
    /**
     * ★호스트가 하는 말. 모델의 답과 **같은 칸을 쓰지 않는다**.
     *
     * 실측 사고(2026-08-08): 서피스 봉투 원문이 답변으로 저장됐고, 그걸 잘라낸 자리에
     * 호스트가 "결과를 정리하는 중 문제가 생겨…"를 **본문 텍스트로** 넣었다. 자동화 등록
     * 요약도 답변 끝에 이어붙였다. 호스트 고지에 자기 행이 없어서 생긴 일이다.
     * 고지는 이 이벤트로 보내고 화면은 심각도를 가진 별도 행으로 그린다.
     */
    | "notice";
  /** Main-assigned monotonic sequence within one run. Renderers never infer ordering from copy. */
  sequence?: number;
  /** Main observation time for this event. Preserved when an active run is reattached. */
  observedAt?: string;
  /** Opaque durable assistant-message identity, present only after Main commits the transcript row. */
  durableMessageId?: string;
  goalResult?: import("./goal-result").GoalResultPresentation;
  /** Main-owned run boundary. Unlike status prose, this is an authoritative lifecycle fact. */
  lifecycle?: {
    phase: "start" | "cancel_requested";
    /** Main-authoritative authority actually dispatched to the runtime. */
    permission?: "read" | "write" | "full";
    /** Original One policy selected by the user before Auto was resolved. */
    selectedPermissionMode?: "auto" | "read" | "write" | "full";
    /**
     * The run's working folder (start only). The timeline relativizes tool
     * paths against it the way Codex prints `src/foo.ts`, not the whole
     * absolute path. Desktop-only: the phone projection never carries it.
     */
    cwd?: string;
  };
  status?: string;
  /** Machine-readable transient progress. Status copy is presentation only. */
  activity?: {
    code: "runtime_wait" | "queue_wait" | "recovery_retry" | "session_resume" | "goal_pass_retry";
  };
  text?: string;
  /** Validated semantic ask projection; raw control markers remain hidden. */
  userDecisionRequest?: AgentlasUserDecisionRequest;
  /** Main-owned durable image attachment URLs for the completed assistant turn. */
  imageDataUrls?: string[];
  /**
   * Main-internal exact assistant body returned by the durable transcript
   * write. Runtime adapters may rewrite transient media paths to attachment
   * URLs while preserving the user-facing live text. InvocationService uses
   * this value only for the completion durability gate and strips it before
   * publishing or recording the observable event.
   */
  durableTextForVerification?: string;
  /**
   * Main-internal owner of durableTextForVerification. InvocationService strips
   * it before ledger or UI publication; model-authored ids are never accepted.
   */
  durableAssistantMessageIdForVerification?: string;
  /** partial 델타 스트리밍(무-agentId 메인 스트림 한정) — text(누적 전문) 대신 직전 partial
   *  이후 추가분만 담는다. IPC 페이로드를 O(전체)→O(증분)으로 줄인다. 리플레이/폴백 이벤트는
   *  여전히 text를 쓴다. */
  delta?: string;
  /** 델타 적용 후 전체 텍스트 길이 — 렌더러가 누적 결과를 검증해 어긋나면 재동기화한다. */
  textLen?: number;
  error?: { code: string; message: string };
  /** kind:"notice" 전용 — 호스트 고지. 답변 본문과 절대 합치지 않는다. */
  notice?: {
    level: "info" | "success" | "warning" | "error";
    /** 사람이 읽는 한 줄. */
    message: string;
    /** 기계 코드(있으면). 화면은 접어 두고 진단에 쓴다. */
    code?: string;
    /**
     * 같은 고지의 두 로케일 판본.
     *
     * `message` 는 **실행의 로케일**로 이미 렌더된 문장이다. 그 실행을 다른 로케일로
     * 설정된 화면(모바일)이 지켜보면 남의 언어가 그대로 뜬다 — 폰이 시작한 실행은
     * 폰 로케일로 돌지만, 데스크탑이 시작한 실행을 폰이 붙어 볼 때가 그 경우다.
     * 문장은 이미 렌더돼 있어 중계 지점에서는 되돌릴 수 없으므로, 만드는 자리에서
     * 두 벌을 함께 낸다. 없으면 `message` 를 그대로 쓴다.
     */
    i18n?: { ko: string; en: string };
    /** 원문·payload. 펼쳤을 때만 보인다. */
    details?: string;
    /**
     * `divider`면 좌우 선 사이의 라벨로 그린다 — 대화의 **경계**를 표시하는 사실
     * (컨텍스트 압축이 첫 소비자). 없으면 보통 고지 행.
     */
    display?: "row" | "divider";
  };
  /** Agent OS surface manifest, emitted when an agent produces a safe interactive surface. */
  surfaceId?: string;
  surface?: AgentlasSurfaceManifest;
  /** Main-authoritative, non-executable semantic projection consumed unchanged by One and Mobile. */
  oneSurface?: OneSurfaceManifestV1;
  /**
   * Main-bound One artifacts only. These are emitted after the exact Surface
   * binding succeeds; they never carry a raw local path to the renderer.
   */
  oneArtifacts?: Array<{
    taskId: string;
    taskVersion: number;
    chatId: string;
    runId: string;
    manifestId: string;
    artifactRef: string;
    label: string;
    type: "document" | "spreadsheet" | "image" | "video" | "audio" | "archive" | "data" | "other";
    sizeBytes?: number;
  }>;
  /** Model suggestion only; Main validates and converts it to bounded semantic actions. */
  oneFriendlyFollowups?: OneFriendlyFollowupPlanV1;
  /** 도구 호출/결과 이벤트 — Claude Code식 접기/펴기 블록용 (이름 + 인자 JSON + 결과) */
  tool?: {
    name: string;
    args?: string;
    result?: string;
    id?: string;
    isError?: boolean;
    /** Closed cause shared by live Activity, durable failure rows, and replay. */
    failureCode?: ToolFailureCode;
    /** Verified public URLs observed in this tool's own input or result. */
    sourceUrls?: string[];
  };
  /** kind:"mcp-key-request" 전용 — 렌더러 McpKeyRequestSheet가 소비한다. 값 없음(키 이름만). */
  keyRequest?: McpRunKeyRequest;
  /** 생성 토큰 수 — final에 동봉. kind:"usage"면 실행 중 라이브 누적치(단조 증가, 추정 포함). */
  tokens?: number;
  /** reasoning(thinking) 구간 신호(kind:"reasoning") — 상태줄 "생각 중…" 회전과
   *  종료 후 "N초 동안 생각함" 표시의 근거. durationMs는 end에만 동봉.
   *
   *  `text`: 모델이 낸 생각 요약/사고 텍스트. `delta`면 증분, `end`면 그 구간의 전문
   *  (원장에 남는 값 — 재방문 시 "N초 동안 생각함 ›"을 펼치면 이게 보인다).
   *  Codex는 reasoning summary 헤드라인, Claude는 thinking 블록, ACP는 thought chunk,
   *  ollama는 thinking 필드가 온다. 없는 런타임(agy)은 start/end만 온다. */
  reasoning?: { phase: "start" | "delta" | "end"; durationMs?: number; text?: string };
  // ── 멀티 에이전트 속성 (firm 오케스트레이션) — 없으면 단일 CEO/에이전트 ──
  /** 이 이벤트를 낸 노드의 안정 id (ResolvedNode.id) — 네트워크 패널 per-agent 버킷 키 */
  agentId?: string;
  /** Durable attribution only: actual installed agent id after auto-route/firm resolution. */
  runtimeAgentId?: string;
  /** 표시 이름 */
  agentName?: string;
  /** 회사 내 역할 ("CEO" / "마케팅 본부장" / ...) */
  role?: string;
  /** Model-economy role; kept separate from the human/firm role above. */
  modelRole?: RuntimeRole;
  /** 계층: 1=CEO, 2=본부, 3=전문가 */
  tier?: 1 | 2 | 3;
  /** 오케스트레이션 단계 — plan(위임 결정) / delegate(하위 실행) / synthesize(종합) */
  phase?: "plan" | "delegate" | "synthesize";
  /** 위임 흐름 표시용 — 이 노드가 위임한 대상 노드 id들 (handoff 엣지) */
  delegateTo?: string[];
  /** per-node 완료 신호 — 이 노드의 한 턴이 끝났음(성공/실패). UI가 그 노드만 비활성(✓)으로 처리. */
  done?: boolean;
  /** 이 노드가 실행 중인 모델/런타임 라벨(예: "grok-4.3", "claude", "gpt-5") — 트리에 "모델 사용 중" 표시. */
  model?: string;
  /** Model reported by a completed runner call; never filled from a requested fallback selection. */
  observedModel?: string;
  /** Main-confirmed runtime selection actually used for this invocation. */
  runtimeSelection?: RuntimeSelection;
  /** Explicit orchestrator/worker envelope; separate from ordinary status prose. */
  agentMessage?: AgentMessageEvent;
  /** Actual CLI process lifecycle; never inferred from `done` or `final`. */
  agentLifecycle?: AgentProcessLifecycleEvent;
  // ── 워크플로우 그래프 라이브 실행(설계 §5 P2) — run-graph.ts가 per-node 상태를 emit ──
  /** 이 이벤트가 겨냥한 워크플로우 노드 id(그래프 러너 라이브 오버레이용). */
  nodeId?: string;
  /** 노드 실행 상태 — 캔버스가 이 값으로 노드/엣지 애니메이션을 그린다. */
  nodeState?: WorkflowNodeRunState;
}

/** 워크플로우 그래프 노드의 라이브 실행 상태(설계 §5 P2 — 캔버스 오버레이). */
export type WorkflowNodeRunState = "pending" | "running" | "done" | "failed" | "skipped";

/** Main-confirmed runtime actually used by one graph run. */
export interface WorkflowRunRuntimeFact {
  nodeId?: string;
  /** "worker" for graph work, "judgment" for an eval node, or a future role. */
  role?: string;
  selection: RuntimeSelection;
}

/** 워크플로우 1회 실행의 per-node 상태 스냅샷(automation_runs.node_states_json에 직렬화). */
export interface WorkflowRunSnapshot {
  /** 이 실행 식별자. */
  runId: string;
  automationId: string;
  startedAt: string;
  status: "running" | "ok" | "error";
  /** Durable run mode; a simulation checkpoint must never resume live. */
  simulation: boolean;
  /** 노드 id → 마지막 상태. */
  nodeStates: Record<string, WorkflowNodeRunState>;
  /**
   * 이 실행이 쓴 토큰. 커널은 처음부터 세고 있었지만 읽는 곳이 없어 화면이 몰랐다 —
   * 매일 도는 자동화가 얼마를 쓰는지 모른 채 켜 두게 된다.
   */
  tokensUsed?: number;
  /** 실제 연결이 원장에 남은 경우에만 제공한다. 설정값으로 추정하지 않는다. */
  runtimeSelections?: WorkflowRunRuntimeFact[];
  /**
   * 노드 id → 왜 멈췄고 지금 무엇을 누르면 되는지.
   * 상태 단어만으로는 실패 카드가 아무 말도 할 수 없다.
   */
  nodeFailures?: Record<string, { code: string; reason: string; nextAction: string }>;
}

/** 워킹 폴더 트리의 한 엔트리 — lazy expand. dir이면 hasChildren 힌트로 chevron 표시. */
export interface WorkspaceNode {
  name: string;
  /** 절대 경로 — 다음 expand 요청에 그대로 사용 */
  path: string;
  kind: "dir" | "file";
  size: number;
  hasChildren?: boolean;
  isTextLike?: boolean;
}

export interface DirListing {
  path: string;
  exists: boolean;
  entries: WorkspaceNode[];
  /** Main-owned agent source disappeared; the installed agent row remains valid. */
  reason?: "source-missing";
}

export interface TextFilePreview {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  reason?: "binary" | "too-large" | "not-text-ext" | "missing" | "not-a-file" | "not-read";
}

/** Main-authoritative read scope. Renderer paths never act as their own roots. */
export type FsReadScope =
  | { kind: "capability"; token: string }
  | { kind: "chat-workspace"; chatId: string }
  | { kind: "chat-assets"; chatId: string };

export interface FsFileWatchSnapshot {
  watchId: string;
  path: string;
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
  revision: number;
  error: "unavailable" | null;
}

/** Opaque authority issued only after a native picker or trusted drop event. */
export interface FsPathGrant {
  path: string;
  kind: "file" | "directory";
  durable: boolean;
  scope: Extract<FsReadScope, { kind: "capability" }>;
}

/** Renderer-safe Experience creation boundary. A raw projectPath is never authority. */
export type ExperiencePackCreateIpcInput = Omit<
  ExperiencePackCreateInput,
  "projectPath" | "environment"
> & {
  projectGrant: FsPathGrant;
};

/** 로그인 세션 — 백엔드(agentlas.cloud)에서 cookie 기반으로 받아 main에 보관. renderer는 메타만. */
export interface AuthSession {
  /** 로그인되어 있으면 true */
  signedIn: boolean;
  /** Renderer preference scoping only. Opaque digest; never a raw user id. */
  accountFingerprint?: string;
  email?: string;
  name?: string;
  workspaceId?: string;
  /** 세션이 만료될 epoch ms — 알 수 없으면 미설정 */
  expiresAt?: number;
  /**
   * 로그인이 **실패로 끝난** 이유. signedIn:false 일 때만 실린다.
   *
   * ★왜 (2026-09-07): 브라우저 로그인을 마쳤는데 저장이 실패하면(키체인 잠김 등)
   * 예전에는 아무도 그 사실을 말하지 않고 3분 타임아웃 뒤 그냥 "로그인 안 됨"이 됐다.
   * 실패한 로그인은 왜 실패했는지 말할 수 있어야 한다.
   */
  error?: string;
}

// ── LLM 엔진 사용량 (구독 rate-limit 창 + 크레딧) ──────────────
// Claude/Codex/Gemini의 프로바이더 OAuth usage 엔드포인트에서 조회한 정규화 결과.
/** 사용량 창 종류. 5h=5시간 롤링, 7d=주간(7일), monthly=월 크레딧, daily=일일(모델별·Gemini). */
export type UsageWindowKind = "5h" | "7d" | "monthly" | "daily" | "unknown";

/** 한 프로바이더의 단일 사용량 창. */
export interface UsageWindow {
  /** 안정 id — "five_hour" | "seven_day" | "seven_day_opus" | "extra_usage" 등 */
  id: string;
  /** 영문 기본 라벨(폴백). 표시는 렌더러가 kind/model로 로컬라이즈. */
  label: string;
  kind: UsageWindowKind;
  /** 0–100. monthly는 used/limit로 계산. */
  usedPercent: number;
  /** 리셋 시각(epoch ms). 모르면 미설정. */
  resetAt?: number | null;
  /** 공급자가 밝힌 실제 창 길이(분). 위치(primary/secondary)로 추정하지 않는다. */
  windowDurationMins?: number | null;
  /** 공급자 소유 제한 식별자. 모델별/일반 제한을 합치지 않기 위해 보존한다. */
  limitId?: string | null;
  /** 공급자 소유 제한 표시명. 모델별 제한을 구분할 때 사용한다. */
  limitName?: string | null;
  /** 모델 한정 창이면 "opus" | "sonnet" 등. */
  model?: string | null;
  /** monthly 크레딧 창: 사용/한도/단위($·credits). */
  used?: number;
  limit?: number;
  unit?: string;
}

export type UsageProviderStatus =
  | "ok" // 사용량 창 있음
  | "key_billed" // API 키형 — 구독 창 없음(키 과금)
  | "local" // 로컬(Ollama) — 무제한
  | "no_quota" // 연결됐으나 한도 메타 없음
  | "error"; // 조회 실패

/** Renderer/Mobile까지 전달해도 안전한 정규화 오류 코드. Provider 원문 오류는 IPC 경계를 넘지 않는다. */
export type UsageProviderErrorCode =
  | "auth_expired"
  | "credentials_corrupt"
  | "keychain_blocked"
  | "quota_exhausted"
  | "unsupported_client"
  | "rate_limited"
  | "network_error"
  | "provider_error"
  | "local_estimate";

/** 사용량을 기계 판독할 수 있고 명시 재시도를 지원하는 Provider allowlist. */
export type UsageRetryProviderId = "claude-code" | "codex" | "kimi" | "grok";

/** 한 LLM 프로바이더의 사용량 스냅샷. */
export interface ProviderUsage {
  /** "claude-code" | "codex" | "gemini" | "deepseek" | "glm" | "grok" | "pi" | "ollama" */
  provider: string;
  backend?: RuntimeBackend | string;
  label: string;
  status: UsageProviderStatus;
  windows: UsageWindow[];
  /** 조회 시각(epoch ms). */
  fetchedAt: number;
  /** 정규화된 안전 오류 코드. Provider 응답 원문·URL·로컬 경로는 포함하지 않는다. */
  error?: UsageProviderErrorCode;
  /** rate_limited일 때 Provider가 제시한 재시도 대기(초). Renderer는 표시하지 않아도 된다. */
  retryAfterSeconds?: number;
  /** secret-free 계정 지문(sha256 앞 16 hex). 같은 구독 계정의 멀티 데스크탑 병합 표시 기준. */
  accountFingerprint?: string;
}

/** Usage 조회와 함께 반환되는 설치형 CLI의 버전/자동 업데이트 상태. */
export type CliRuntimeUpdateState =
  | "not-installed"
  | "checking"
  | "current"
  | "update-available"
  | "updating"
  | "updated"
  | "deferred-active-runs"
  | "check-failed"
  | "update-failed"
  | "unverifiable";

export interface CliRuntimeVersionStatus {
  kind: "claude-code" | "codex" | "antigravity" | "kimi" | "grok";
  installedVersion: string | null;
  latestVersion: string | null;
  state: CliRuntimeUpdateState;
  /** 마지막으로 공식 최신 버전을 확인했거나 source-owned updater를 검증한 시각. */
  checkedAt: number | null;
}

export interface ModelRoleUsageBucket {
  role: RuntimeRole;
  /** Provider-observed tokens. Current runners expose output tokens consistently. */
  observedTokens: number;
  invocationCount: number;
}

/** One exact model/effort pair observed in a conversational invocation. */
export interface ModelRoleUsageModelBucket extends ModelRoleUsageBucket {
  /** Provider/backend that received the invocation (for example `openai`). */
  provider: string;
  /** Exact model id reported by the runner. Null means the runner did not expose one. */
  model: string | null;
  /** Exact applied effort when the host/runner exposed it; null means default/unknown. */
  effort: string | null;
}

export interface ModelRoleUsageSnapshot {
  /** Inclusive UTC window used by Main's append-only run-event query. */
  since: string;
  until: string;
  /** No input-token zeroes are fabricated while runner coverage is output-only. */
  measurement: "output-only" | "total";
  orchestrator: ModelRoleUsageBucket;
  worker: ModelRoleUsageBucket;
  totalObservedTokens: number;
  workerSharePercent: number;
  /**
   * Exact model/effort attribution from local invocation receipts. This is
   * observed token usage, not a provider quota percentage: Codex/Claude quota
   * endpoints expose account-level windows and do not split them by model.
   */
  byModel: ModelRoleUsageModelBucket[];
}

/** 전체 엔진 사용량 스냅샷 — 대시보드 "엔진 연결·사용량" 모듈이 소비. */
export interface UsageSnapshot {
  providers: ProviderUsage[];
  fetchedAt: number;
  /** No provider or local account observations were collected in this snapshot. */
  collection?: { status: "suppressed"; reason: "development_effect_policy_disabled" };
  /** Seven-day role split derived from real model-call completion receipts. */
  modelRoleUsage?: ModelRoleUsageSnapshot;
  /** Main이 runtime.detect와 결합한 설치 버전 + 무중단 자동 업데이트 상태. */
  runtimeVersions?: CliRuntimeVersionStatus[];
}

/** Renderer의 단일 Provider 재시도 결과. attempted=false면 main cooldown 안에서 기존 snapshot을 반환했다. */
export interface UsageRetryResult {
  snapshot: UsageSnapshot;
  attempted: boolean;
  retryAfterMs: number;
}

/** 확인 요청 — 에이전트가 챗에서 사용자 결정을 기다리는 항목.
 *  마지막 메시지가 미답변 질문 fence(<<agentlas-ask>>)인 채팅에서 도출. */
export interface PendingConfirmation {
  chatId: string;
  /** Exact current assistant message that owns this question. */
  sourceMessageId: string;
  chatTitle: string;
  /** 에이전트가 던진 질문 본문 */
  question: string;
  /** 짧은 칩 라벨(선택) */
  header?: string;
  /** 선택지 개수 */
  optionCount: number;
  /** Desktop 질문 카드와 Mobile이 공유하는 실제 안전한 선택지. */
  options: Array<{ label: string; description?: string }>;
  /** 여러 선택을 허용하는 질문인지 여부. */
  multiSelect: boolean;
  agentId: string;
  firmId: string | null;
  /** 사용자에게 보여 줄 실제 요청 주체 이름. ID만 노출하지 않는다. */
  requesterLabel: string;
  requesterKind: "agent" | "firm";
  /** 질문 메시지 시각(ISO) */
  createdAt: string;
  /** One에서 사용자가 미룬 시각. 질문은 Work의 정본 승인 목록에서는 계속 pending이다. */
  snoozedUntil?: string;
}

/** 질문 답변 확정 영수증 — 답변 제출이 수락된 순간 append-only 원장(run_events)에
 *  남는 정본. 후속 user 메시지가 실행 분기에서 유실돼도 이 영수증이 질문을 durable하게
 *  해소해, 알림 배지·"답변 필요" 목록·바텀시트가 이미 답한 질문을 다시 띄우지 않는다. */
export interface CommittedQuestionAnswer {
  /** 답한 질문을 소유한 assistant 메시지 id. */
  sourceMessageId: string;
  /**
   * Desktop continuation restore에만 반환되는 제출 당시 답장 본문.
   * Mobile 진단 영수증에는 원문이 없으므로 빈 문자열일 수 있다.
   */
  reply: string;
  /** 확정 시각(ISO). */
  ts: string;
  /** Main-derived exact-once run reserved for this source question + reply. */
  continuationRunId?: string;
}

/** Full formatted Decision reply limit, including every question/selection prefix. */
export const QUESTION_CONTINUATION_REPLY_MAX_LENGTH = 250_000;

/** Conservative UTF-8 ceiling for the canonical Decision reply stored by Main. */
export const QUESTION_CONTINUATION_REPLY_MAX_BYTES = 1_000_000;

/** Closed renderer input captured with the committed answer and reused verbatim on recovery. */
export interface QuestionContinuationOptions {
  locale?: "ko" | "en";
  permissions?: "read" | "write" | "full";
  sessionRouting?: boolean;
  runtimeSelection?: RuntimeSelection;
}

export interface QuestionContinuationReceipt {
  chatId: string;
  sourceMessageId: string;
  runId: string;
  status: "started" | "already-running" | "already-terminal" | "rejected";
  runStatus?: InvocationRunReceipt["status"];
  reasonCode?: "invalid-intent" | "chat-busy" | "admission-closed" | "start-rejected";
}

/** electron-updater의 자동 업데이트 상태. main → renderer로 broadcast. */
export type UpdaterErrorCode =
  | "config-missing"
  | "check-failed"
  | "download-failed"
  | "install-not-owned"
  | "install-source-untrusted"
  | "install-not-applied"
  | "install-state-corrupt"
  | "legacy-cleanup-failed"
  | "install-start-failed"
  | "continuity-backup-failed"
  | "continuity-violation"
  | "compatibility-metadata-missing"
  | "minimum-app-version"
  | "minimum-runtime-version"
  | "minimum-schema-version";

/** Fixed, value-free updater diagnostics safe to persist and expose to renderer. */
export type UpdaterDiagnosticCategory =
  | "source-signature-class"
  | "source-identity"
  | "source-seal"
  | "source-designated-requirement"
  | "source-gatekeeper"
  | "source-verification-unavailable"
  | "native-install-signature"
  | "native-install-permission"
  | "native-install-space"
  | "native-install-payload"
  | "native-install-state"
  | "native-install-timeout"
  | "native-install-unknown";

export interface UpdaterDiagnostic {
  category: UpdaterDiagnosticCategory;
  message: string;
}

export interface UpdaterCompatibility {
  minimumSourceAppVersion: string;
  minimumRuntimeVersion: string;
  minimumSchemaVersion: number;
  targetSchemaVersion: number;
  bundledRuntimeVersion: string;
}

export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    | "updated"
    | "not-available"
    | "manual-required"
    | "incompatible"
    // "recovery-required" was removed: nothing produced it once the continuity
    // gate was disabled, yet its banner still asked users to go inspect a
    // recovery copy. An update that needs the person to open a database file is
    // a failed update, not a recovery path.
    | "error";
  /** update-available / update-downloaded 시 채워짐 */
  version?: string;
  /** download-progress의 백분율 (0-100). downloading 상태일 때만 의미 있음 */
  progress?: number;
  /** main에서 HTML/링크/과도한 길이를 제거한 사용자 표시용 릴리스 노트. */
  releaseNotes?: string;
  /** renderer가 원문 오류를 추측하지 않고 안전한 복구 UI를 고를 수 있는 안정 코드. */
  code?: UpdaterErrorCode;
  /** 사용자에게 보여도 되는 짧은 설명. 내부 경로/토큰/스택은 포함하지 않는다. */
  error?: string;
  /** 네이티브 원문/경로/토큰을 포함하지 않는 고정 진단. */
  diagnostic?: UpdaterDiagnostic;
  /** 네트워크 등 일시 실패일 때만 true. 권한/호환성/연속성 실패는 false다. */
  canRetry?: boolean;
  /** 복구본이 있을 때만 true. 실제 경로는 main이 보관하고 reveal IPC로만 연다. */
  recoveryBackupAvailable?: boolean;
  /** 릴리스가 선언한 최소 호환 경계. */
  compatibility?: UpdaterCompatibility;
  /** 마지막으로 서버 확인이 끝난 시각(epoch ms). */
  lastCheckedAt?: number;
  /** 일시적 설치 인계 실패 뒤 다음 안전 재시도 가능 시각(epoch ms). */
  retryAfter?: number;
}

export interface UpdaterActionResult {
  accepted: boolean;
  state: UpdaterState;
  /** A stable refusal marker. Direct install never restarts while a model turn is active. */
  blockedBy?: "active-runs";
  /** Count only; renderer never receives run prompts or runtime internals. */
  activeRunCount?: number;
}

// ── 마이그레이션 (OpenClaw / Hermes → Agentlas) ──────────────
// 기존 터미널형 에이전트 런처에서 페르소나·API 키·자동화·메모리를 가져온다.
// 값(시크릿)은 절대 renderer로 넘기지 않는다 — preview는 키 "이름"만.
export type MigrationSourceKind = "openclaw" | "hermes";

export interface MigrationApiKeyPreview {
  /** 소스에서 발견된 env 변수 이름 (예: OPENAI_API_KEY) — 값은 포함 안 함 */
  envKey: string;
  /** 인식된 BYOK 백엔드. null이면 글로벌 env vault로 들어감 */
  backend: RuntimeBackend | null;
}

export interface MigrationSourcePreview {
  kind: MigrationSourceKind;
  /** UI 라벨 ("OpenClaw" / "Hermes") */
  label: string;
  /** 디스크에 설정 디렉토리가 있는지 */
  available: boolean;
  /** 스캔한 절대 경로 — 무엇을 읽었는지 사용자에게 투명하게 */
  rootPath: string;
  /** 가져올 페르소나/에이전트. 없으면 null */
  agent: { name: string; personaBytes: number } | null;
  /** 발견된 API 키 (이름만 — 값은 main에만 머묾) */
  apiKeys: MigrationApiKeyPreview[];
  /** 발견된 예약 작업 수 */
  automations: number;
  /** 발견된 메모리/워크스페이스 파일 수 */
  memories: number;
}

export interface MigrationOptions {
  source: MigrationSourceKind;
  /** preview만 — 아무것도 쓰지 않음 */
  dryRun?: boolean;
  /** 이미 가져온 적 있어도 다시 가져옴 (에이전트를 제자리 업데이트) */
  overwrite?: boolean;
  /** API 키를 OS 키체인으로 가져오기 (기본 true) */
  importKeys?: boolean;
  /** UI 표시 언어 — 결과 경고 메시지를 이 언어로 낸다. */
  locale?: "ko" | "en";
}

export interface MigrationResult {
  source: MigrationSourceKind;
  dryRun: boolean;
  agentImported: boolean;
  agentId: string | null;
  agentSlug: string | null;
  /** 실제로 저장한 env 키 이름들 (값 아님) */
  keysImported: string[];
  automationsImported: number;
  projectId: string | null;
  /** UI에 노출할 비치명적 경고 */
  warnings: string[];
}

// ── Oberon real render jobs ───────────────────────────────────
export type OberonRenderProvider = "google-gemini-veo" | "google-enterprise-veo" | "grok-cli-video";
export type OberonRenderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type OberonRenderFileKind =
  | "clip_mp4"
  | "master_mp4"
  | "master_mov"
  | "master_wav"
  | "titled_mp4"
  | "titled_mov";
export type OberonRenderClipStatus = "queued" | "generating" | "ready" | "failed";

export interface OberonRenderShotInput {
  shotId: string;
  index: number;
  durationSec: number;
  aspectRatio: string;
  prompt: string;
  negativePrompt?: string;
  providerId?: string;
  providerMode?: string;
  firstFrame?: {
    absPath?: string;
    imageBytes?: string;
    mimeType: string;
  };
  /** END 프레임 — Veo가 이 이미지로 정확히 끝나도록 보간(START/END 체이닝). firstFrame이 있을 때만 적용. */
  lastFrame?: {
    absPath?: string;
    imageBytes?: string;
    mimeType: string;
  };
  /** 이 샷의 첫 프레임이 직전 샷(id)의 END 프레임에서 이어짐 — 프롬프트에 연속성 지시로 반영. */
  chainedFromShotId?: string;
}

export interface OberonRenderRequest {
  productionId: string;
  title: string;
  aspectRatio: string;
  shots: OberonRenderShotInput[];
  /** Live renders are capped by default to avoid surprise spend. */
  maxShots?: number;
  takesPerShot?: number;
  provider?: OberonRenderProvider;
  model?: string;
  resolution?: "720p" | "1080p" | "4k";
  /** 타이틀/로어서드/자막 결정적 번인 스펙 (있으면 *_titled.mp4 추가 생성). */
  titles?: OberonTitleSpec;
}

export interface OberonRenderFile {
  id: string;
  kind: OberonRenderFileKind;
  name: string;
  label: string;
  absPath: string;
  url: string;
  mime: string;
  sizeBytes: number;
}

export interface OberonRenderClip {
  shotId: string;
  takeId: string;
  attempt: number;
  status: OberonRenderClipStatus;
  provider: OberonRenderProvider;
  model: string;
  prompt: string;
  absPath?: string;
  url?: string;
  mime?: string;
  sizeBytes?: number;
  error?: string;
  createdAtMs: number;
}

export interface OberonRenderProgress {
  phase: "queued" | "generating" | "assembling" | "complete" | "failed" | "cancelled";
  totalClips: number;
  completedClips: number;
  currentShotId?: string;
  percent: number;
}

export interface OberonRenderJob {
  id: string;
  productionId: string;
  title: string;
  provider: OberonRenderProvider;
  model: string;
  status: OberonRenderJobStatus;
  outputDir: string;
  progress: OberonRenderProgress;
  clips: OberonRenderClip[];
  files: OberonRenderFile[];
  message: string;
  error?: string;
  warnings: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

// ── Oberon local motion graphics jobs ─────────────────────────
export type OberonMotionAdJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type OberonMotionAdFileKind = "motion_mp4" | "html_preview" | "prompt_pack" | "manifest_json";

export interface OberonMotionAdRequest {
  productionId?: string;
  title?: string;
  brand?: string;
  concept?: string;
  aspectRatio?: "16:9" | "9:16";
  durationSec?: number;
  fps?: number;
  width?: number;
  height?: number;
  /** 고객 로고 — 이미지 URL/로컬 절대경로/data-uri. 없으면 브랜드 이니셜 모노그램. */
  logoSource?: string;
  /** 브랜드 강조색 #hex. 없으면 브랜드명에서 결정적으로 선택. */
  accentColor?: string;
  outputDir?: string;
}

export interface OberonMotionAdFile {
  id: string;
  kind: OberonMotionAdFileKind;
  name: string;
  label: string;
  absPath: string;
  url: string;
  mime: string;
  sizeBytes: number;
}

export interface OberonMotionAdProgress {
  phase: "queued" | "rendering_frames" | "encoding" | "complete" | "failed" | "cancelled";
  totalFrames: number;
  completedFrames: number;
  percent: number;
}

export interface OberonMotionAdJob {
  id: string;
  productionId?: string;
  title: string;
  brand: string;
  status: OberonMotionAdJobStatus;
  outputDir: string;
  progress: OberonMotionAdProgress;
  files: OberonMotionAdFile[];
  message: string;
  error?: string;
  warnings: string[];
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  createdAtMs: number;
  updatedAtMs: number;
}

// ── Oberon image-to-video (애니메이션 스튜디오) ──────────────
export type MultimodalVideoProvider = "runway" | "luma" | "veo" | "seedance" | "kling" | "grok";
export type MultimodalVideoJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface MultimodalVideoRequest {
  productionId?: string;
  title?: string;
  provider?: MultimodalVideoProvider;
  /** 입력 이미지 — 로컬 절대경로(runway는 base64 data-uri로 인라인). */
  imagePath?: string;
  /** 입력 이미지 — 공개 HTTPS URL(luma는 공개 URL만 허용). */
  imageUrl?: string;
  prompt: string;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  durationSec?: number;
  model?: string;
}

export interface MultimodalVideoFile {
  id: string;
  kind: "animation_mp4";
  name: string;
  absPath: string;
  url: string;
  mime: string;
  sizeBytes: number;
}

export interface OberonAnimateProgress {
  phase: "queued" | "submitting" | "generating" | "downloading" | "complete" | "failed" | "cancelled";
  percent: number;
}

export interface MultimodalVideoJob {
  id: string;
  productionId?: string;
  title: string;
  provider: MultimodalVideoProvider;
  model: string;
  status: MultimodalVideoJobStatus;
  outputDir: string;
  progress: OberonAnimateProgress;
  files: MultimodalVideoFile[];
  message: string;
  error?: string;
  warnings: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

/** 이미지 생성 1회의 결과 — data: URI 로 돌아와 채팅·사이드바가 바로 렌더한다. */
export interface MultimodalImageResult {
  ok: boolean;
  /** data:image/png;base64,… */
  src?: string;
  /** 실제로 그림을 그린 엔진(codex | gemini | agy …) — 지어낸 값이 아니라 실행 결과다. */
  engine?: string;
  message?: string;
}

export interface MultimodalVideoKeyStatus {
  runway: boolean;
  luma: boolean;
  veo: boolean;
  seedance: boolean;
  kling: boolean;
  /** Grok CLI(Imagine) — API 키가 아니라 구독 로그인된 grok 바이너리 존재 여부. */
  grok: boolean;
}

// ── Oberon text planning jobs ──────────────────────────────────
export type OberonPlanRuntime = "claude-code" | "codex" | "antigravity";

/** Optional, main-process-owned OpenCrab ontology enrichment. No endpoint or result body crosses IPC. */
export interface OpenCrabReadiness {
  state: "absent" | "needs-credential" | "disabled" | "ready" | "unreachable";
  installed: boolean;
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  reason?: string;
}

export interface OpenCrabEnrichment {
  requested: boolean;
  used: boolean;
  reason?: string;
  /** Main-owned safe projection. No ontology result text crosses IPC. */
  evidenceCount?: number;
  matchedQueryTerms?: string[];
}

export interface OberonPlanRequest {
  productionId?: string;
  brief: JsonObject;
  runtime?: OberonPlanRuntime | string;
  runtimeLabel?: string;
  premium?: boolean;
  /** Explicit per-run consent. False/omitted preserves the current local-only planning flow. */
  useOpenCrab?: boolean;
}

export interface OberonPlanResult {
  ok: boolean;
  runtime: OberonPlanRuntime | string;
  runtimeLabel: string;
  patch?: JsonObject;
  rawText?: string;
  error?: string;
  warnings: string[];
  createdAtMs: number;
  openCrab?: OpenCrabEnrichment;
}

// ── Oberon keyframe image jobs ─────────────────────────────────
export type OberonKeyframeProvider = "codex-imagegen-cli" | "google-imagen" | "grok-cli-image";
export type OberonKeyframeJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type OberonKeyframeAssetKind = "first_frame" | "last_frame" | "master_sheet" | "storyboard_sheet";

export interface OberonKeyframeShotInput {
  shotId: string;
  index: number;
  aspectRatio: string;
  prompt: string;
  negativePrompt?: string;
  cameraSize?: string;
  continuityRefs?: string[];
  /** START/END 프레임 체이닝 — "last"면 샷의 END 프레임을 생성(파일명·자산 kind 반영). 기본 "first". */
  frameRole?: "first" | "last";
  /** 자산 종류 오버라이드 — 마스터 시트/콘티 시트 생성 시 사용. */
  assetKind?: OberonKeyframeAssetKind;
}

export interface OberonKeyframeRequest {
  productionId: string;
  title: string;
  aspectRatio: string;
  shots: OberonKeyframeShotInput[];
  maxShots?: number;
  provider?: OberonKeyframeProvider;
  model?: string;
  imageSize?: "1K" | "2K";
}

export interface OberonKeyframeAsset {
  id: string;
  shotId: string;
  kind: OberonKeyframeAssetKind;
  provider: OberonKeyframeProvider;
  model: string;
  prompt: string;
  absPath: string;
  url: string;
  mime: string;
  sizeBytes: number;
  createdAtMs: number;
}

export interface OberonKeyframeProgress {
  phase: "queued" | "generating" | "complete" | "failed" | "cancelled";
  totalImages: number;
  completedImages: number;
  currentShotId?: string;
  percent: number;
}

export interface OberonKeyframeJob {
  id: string;
  productionId: string;
  title: string;
  provider: OberonKeyframeProvider;
  model: string;
  status: OberonKeyframeJobStatus;
  outputDir: string;
  progress: OberonKeyframeProgress;
  assets: OberonKeyframeAsset[];
  message: string;
  error?: string;
  warnings: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

// ── Oberon 시트 생성 (마스터 시트 · 콘티 시트 · 컷 분해 시트) ──
// 프롬프트는 shared/oberon-sheets.ts 빌더로 만들고, 생성은 키프레임 엔진을 재사용한다.
export type OberonSheetKindInput =
  | "master_sheet_v1"
  | "master_sheet_v2"
  | "storyboard_overview"
  | "cut_breakdown"
  // 커버리지 워크플로우: 3x3 그리드 / 4단 스택 / 스토리보드 시퀀스.
  | "scene_grid_3x3"
  | "scene_stack_4"
  | "storyboard_sequence";

export interface OberonSheetItemInput {
  /** 시트 id — 캐릭터 시트면 reference id, 콘티면 "storyboard_overview" 등. */
  id: string;
  kind: OberonSheetKindInput;
  /** shared/oberon-sheets 빌더가 만든 완성 프롬프트. */
  prompt: string;
  /** normalizeAspect 입력 기준 비율 (기본: kind별 sheetAspect). */
  aspectRatio?: string;
}

export interface OberonSheetRequest {
  productionId: string;
  title: string;
  sheets: OberonSheetItemInput[];
  provider?: OberonKeyframeProvider;
  model?: string;
  imageSize?: "1K" | "2K";
}

// ── Hephaestus 엔진 브리지 ──────────────────────────────────────────────────
/** 임베딩된 Hephaestus 엔진의 가용성. */
/**
 * What the Agentlas OS updater last did. Written by Core to
 * `runtime/auto-update.json`; Desktop only reads it. A null journal means the
 * updater has not run yet on this machine — distinct from having failed.
 */
export interface HephaestusUpdateJournal {
  status: string | null;
  reason: string | null;
  current: string | null;
  latest: string | null;
  lastCheckedEpoch: number | null;
  lastAppliedTag: string | null;
  lastAppliedEpoch: number | null;
  /** Core runtime may be current while a running host still loads the old plugin. */
  reloadRequired: boolean;
  pendingHosts: string[];
  /** Preserve Core's post-activation receipt for forward-compatible diagnosis. */
  activation: Record<string, unknown> | null;
}
export interface HephaestusUpdateResult {
  ok: boolean;
  /**
   * `applied` new engine installed · `current` already newest · `unknown` the
   * updater ran but reported a state this build cannot interpret · `working`
   * still downloading (the worker continues without the app waiting) · `busy`
   * another updater holds the lock · `offline` could not reach the release feed
   * · `no_engine` nothing to update · `no_python` no interpreter to run it.
   *
   * `current` must never absorb the others: each one needs different words, and
   * three of them previously read as "already up to date".
   */
  outcome:
    | "applied"
    | "current"
    | "unknown"
    | "working"
    | "busy"
    | "offline"
    | "no_engine"
    | "no_python";
  error?: string;
  journal: HephaestusUpdateJournal | null;
}
export interface HephaestusStatus {
  available: boolean;
  reason?: string;
  root: string | null;
  python: string | null;
  version: string | null;
  /**
   * Where the attached engine came from. `managed` follows its own release
   * train, `bundled` is the frozen copy inside this app, `override` is an
   * explicit HEPHAESTUS_RUNTIME_ROOT. Functionally distinct, not cosmetic: the
   * bundled fallback lacks the Workforce goal-continuity tools, so the UI must
   * be able to say which one is attached rather than only its version number.
   */
  source: "managed" | "bundled" | "override" | null;
  pythonVersion: string | null;
}
export interface HephaestusRecoveryPresentation {
  summary: string;
  question: string | null;
  options: Array<{ actionId: string; label: string }>;
}
export interface HephaestusRecoveryResult {
  status: HephaestusStatus;
  verified: boolean;
  attempted: boolean;
  presentation: HephaestusRecoveryPresentation | null;
}
export interface HephaestusRecoveryReceipt extends HephaestusRecoveryResult {
  /** Exact action requested through IPC; null for inspection/automatic judgment. */
  actionId: string | null;
}
/** 엔진 CLI 명령 결과(JSON 출력 + 원시 stdout/stderr). */
export interface HephaestusCommandResult<T = unknown> {
  ok: boolean;
  exitCode: number | null;
  json: T | null;
  stdout: string;
  stderr: string;
  error?: string;
}
export type HephaestusUploadVisibility = "private-link" | "marketplace";
/** hep-build(빌더) 스트리밍 이벤트 — 데스크탑 런타임으로 Hephaestus 빌더 에이전트 구동. */
export interface HephaestusBuildEvent {
  runId: string;
  kind: "log" | "stage" | "partial" | "done" | "error" | "heartbeat";
  text?: string;
  stage?: string;
  /** CLI 런타임이 반환한 재개 가능한 세션 id. 다음 인터뷰 턴에서 그대로 이어간다. */
  sessionId?: string;
  result?: unknown;
  /**
   * heartbeat only — host-owned liveness. Emitted on a timer by Main while a
   * runner turn is in flight, so a runtime that streams NOTHING for minutes
   * (codex emits no reasoning items at all) can never look like a hang.
   * Heartbeats replace one live status row; they are never appended to the log.
   */
  elapsedMs?: number;
  /** heartbeat only — how long the engine stream itself has been silent. */
  silentMs?: number;
}

/** Main-authored supplemental question. It never comes from model text. */
export interface HephaestusBuildSupplementalQuestion {
  kind: "opencrab-ontology";
  question: string;
  options: Array<{ label: string; description?: string }>;
}

/** One runtime identity in a Build allocation preview. Never carries credentials. */
export interface BuildAllocationRuntime {
  kind: string;
  backend?: string;
  model?: string;
  effort?: string;
  source?: string;
}

/**
 * What the parent allocator would run this Build on, resolved WITHOUT starting
 * it. `escalated` is true when the allocator moved off the runtime the user
 * actually selected, which is the only case worth interrupting them for.
 */
export interface BuildAllocationPreview {
  current: BuildAllocationRuntime;
  allocated: BuildAllocationRuntime;
  escalated: boolean;
  tier?: "economy" | "balanced" | "frontier";
}

export interface HephaestusBuildResult {
  workspace: string;
  securityScan: unknown;
  /** 엔진 package-contract verify 결과(JSON) — blockers가 비면 routing-ready 패키지. */
  packageContract?: unknown;
  mcpReceipt: McpBuildAttachmentReceipt;
  supplementalQuestion?: HephaestusBuildSupplementalQuestion;
}
/** 빌드 지시문 첨부 — 사용자 디스크의 파일/폴더(기존 에이전트·스킬·이미지·문서 등). */
export interface HephaestusBuildAttachment {
  /** Native picker / trusted drop에서 발급된 opaque 파일 권한. Renderer 경로는 권한이 아니다. */
  grant: FsPathGrant;
  /** 표시용 이름(기본 basename). */
  name?: string;
}

export interface HephaestusBuildRequest {
  /** 이번 턴의 사용자 입력(자연어). 1턴=원 요청, 인터뷰 답변 턴=사용자의 답변. */
  request: string;
  /** 첨부 파일/폴더 — 첫 턴에만 유효. 워크스페이스 `_attachments/`로 복사되고 프롬프트에 참조가 주입된다. */
  attachments?: HephaestusBuildAttachment[];
  /** single | team | package(repair) — 미지정 시 엔진 mode-classification 에 위임. */
  mode?: "single" | "team" | "package";
  /** 결과 패키지 작업 폴더 권한. Main이 검증한 경로만 런타임 cwd가 된다. */
  workspaceGrant: FsPathGrant;
  /** 사용할 런타임 선택(미지정 시 활성 런타임). */
  runtime?: RuntimeSelection;
  /** true only when the user explicitly chose the Build runtime/model in the UI. */
  runtimePinned?: boolean;
  /** Main이 발급한 계획 ID에 대한 1회 선택. Renderer가 서버 정의나 연결 결과를 만들 수 없다. */
  mcpConsent: McpBuildConsent;
  /** 이전 인터뷰 턴에서 받은 CLI 세션 id. 있으면 새 호출 대신 같은 대화를 resume한다. */
  runtimeSessionId?: string;
  /** 대화형 딥인터뷰용 이전 대화(이번 턴 입력 이전까지). 빌더가 인터뷰 맥락을 이어간다. */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  /**
   * True when `request` is the host's own "keep going without asking" nudge
   * rather than something a person typed or chose.
   *
   * The host writes the interview receipt and the work brief from what it saw a
   * person send. Its own instruction, carried on a user-shaped turn, is not that
   * — counting it produced a brief whose `assumptions` listed a prompt Agentlas
   * wrote to itself, tagged `source: "user"` (measured 2026-08-17).
   */
  hostAuthoredContinuation?: boolean;
  /** Explicit answer to the conditional OpenCrab interview question. */
  openCrabOntology?: "use" | "skip";
  /**
   * Records that the user was shown, and accepted, an allocator escalation off
   * their chosen model. Present only for the receipt/log — the accepted runtime
   * itself arrives pinned via `runtime` + `runtimePinned`.
   */
  runtimeEscalationAccepted?: boolean;
  /** 렌더러 표시 언어. 빌더가 UI 노출 로그/상태 메시지를 이 언어로 낸다. 미지정 시 백엔드 기본. */
  locale?: "ko" | "en";
}

// ── 추천 바텀시트(Recommendation) ──────────────────────────────────────────
// routePreview 가 routeOnly(실행 없음) 결정 JSON 을 정규화해 렌더러에 넘기는 모양.
// 렌더러는 엔진 내부 JSON 을 직접 파싱하지 않고 이 정규형만 소비한다.
export type RecMode = "single" | "multi" | "network" | "pipeline" | "clarify" | "build" | "none";
export type RecSource = "local" | "cloud" | "hub";
export type OrchestrationTarget =
  | { source: "local"; entityKind: "agent"; agentId: string }
  | { source: "local"; entityKind: "team"; firmId: string }
  | { source: "cloud" | "hub"; entityKind: "agent" | "team"; slug: string };
export interface RecAgent {
  id: string;
  name: string;
  source: RecSource;
  /** 점추정 크레딧(예상). 알 수 없으면 null. */
  estCredits: number | null;
  /** 범위 추정(pipeline/network 처럼 패스·규모 불확실할 때). */
  estCreditsRange?: [number, number];
  /** single 라우트의 정규 실행 명령(entrypoints.canonical_command). */
  canonicalCommand?: string;
  /** type 이 팀/회사면 firm 바인딩 경로로 실행. */
  isFirm?: boolean;
  /** Active day-based lease (owner-purchased): calls cost 0 while it lasts. */
  leased?: boolean;
  /** Exact executable identity; id/source alone are display compatibility fields. */
  target: OrchestrationTarget;
}
export interface RecStage {
  order: number;
  /** 단계 라벨(plan/build/qa/deploy 등 엔진 stage 키). */
  kind: string;
  agentId?: string;
  agentName?: string;
  produces?: string[];
  consumes?: string[];
  estCredits?: number | null;
}
export interface Recommendation {
  mode: RecMode;
  /** single→1, multi/network→N. */
  agents: RecAgent[];
  /** mode==="pipeline" 일 때 단계. */
  stages?: RecStage[];
  /** 전체 예상 크레딧(점추정). */
  totalEstCredits: number | null;
  totalEstCreditsRange?: [number, number];
  /** true 면 totalEstCredits 는 총액이 아니라 하한이다 — 단가 미상(perCallCredits 없음) Hub 행이
   *  섞여 합산에서 빠졌다는 뜻. 부분합을 총액으로 표기·비교하면 사용자에게 보여준 숫자보다
   *  서버가 더 청구한다. 결제/페이월 소비자는 반드시 이 플래그를 함께 읽어야 한다. */
  totalEstCreditsPartial?: boolean;
  /** 항상 추정치임을 UI 가 명시하도록 하는 리터럴 플래그. */
  estimate: true;
  receiptId?: string;
  /** 원본 엔진 action(텔레메트리/디버그). */
  rawAction: string;
  /** action==="clarify" 일 때 되물을 질문. */
  clarifyQuestion?: string;
  /** action==="propose_new"(적합 에이전트 없음 → 빌드 제안) 일 때 엔진이 준 사유. */
  buildReason?: string;
  /** 원 요청 텍스트(시트가 실행할 때 사용). */
  query: string;
  /** 저신뢰(clarify/propose_new) 결정에 엔진이 붙인 Router Agent 에스컬레이션.
   *  있으면 호스트 런타임이 LLM 추론으로 의도 재해석·후보 재정렬해 재라우팅한다(BYOC). */
  routerAgent?: RecRouterAgent;
}

export interface RecRouterAgent {
  /** 호스트가 로드·실행할 Router Agent id. */
  agent: string;
  /** 에스컬레이션 사유(clarify|propose_new). */
  reason: string;
  /** 호스트 런타임이 따를 지침(엔진이 생성, 모델 호출은 호스트). */
  directive?: string;
  /** 엔진이 첨부한 구조화 컨텍스트. query/candidates/hub_candidates 등을 포함할 수 있음. */
  context?: JsonObject;
}

/** 추천 시트에서 사용자가 고른 실행 경로 — 페이지가 적절한 send/switch 로 디스패치한다. */
export type RecExecChoice =
  | { kind: "agent"; target: OrchestrationTarget; routerAgent?: RecRouterAgent }
  | { kind: "network"; targets?: OrchestrationTarget[]; routerAgent?: RecRouterAgent }
  | { kind: "pipeline"; stages?: RecStage[]; routerAgent?: RecRouterAgent }
  | { kind: "plain"; routerAgent?: RecRouterAgent };

/** Agentlas Hub 크레딧 잔액 — GET /api/billing/credits 응답 형태.
 *  구독 계좌(A: 월 초기화 + 톱업 + 전송분)와 렌트수익 계좌(B: 적립 전용)를 분리해서 본다.
 *  `remainingCredits`=사용 가능(A), `earningsCredits`=이동 가능한 렌트수익(B). */
export interface HubCreditBalance {
  authenticated: boolean;
  plan?: string;
  usedCredits?: number;
  planCreditLimit?: number;
  topUpCredits?: number;
  limitCredits?: number;
  remainingCredits?: number;
  earningsCredits?: number;
  error?: string;
}

/** 렌트수익(B) → 구독(A) 일방 전송 결과. POST /api/billing/earnings/transfer. */
export interface EarningsTransferResult {
  ok: boolean;
  moved?: number;
  earningsCredits?: number;
  remainingCredits?: number;
  error?: string;
}

// ── 프롬프트 저장소 (웹 /api/prompts 프록시 — electron/prompts-hub.ts) ─────────
/** 카탈로그/상세 공통 프롬프트 요약. body/tips는 절대 카탈로그에 오지 않는다. */
export interface HubPromptSummary {
  id: string;
  slug: string;
  category?: string;
  titleKo?: string;
  titleEn?: string;
  summaryKo?: string;
  summaryEn?: string;
  models?: string[];
  /** 필요한 입력물 안내(사진/문서 등) — "써보기" 전에 반드시 표시할 것. */
  inputsKo?: string;
  inputsEn?: string;
  exampleImages?: string[];
  exampleResultKo?: string;
  exampleResultEn?: string;
  tags?: string[];
  authorName?: string;
  unlockCount?: number;
  viewCount?: number;
  // 로그인 사용자 전용 플래그
  unlocked?: boolean;
  tasted?: boolean;
  bookmarked?: boolean;
  mine?: boolean;
}

export interface HubPromptViewer {
  signedIn: boolean;
  /** 유료 구독(free 아님 + active/trialing/past_due) — 전 프롬프트 무제한 열람+저장. */
  paidAccess: boolean;
}

export interface HubPromptCatalog {
  ok: boolean;
  prompts: HubPromptSummary[];
  viewer: HubPromptViewer | null;
  error?: string;
}

export interface HubPromptDetailResult {
  ok: boolean;
  prompt?: HubPromptSummary & { body?: string; tipsKo?: string; tipsEn?: string; paidAccess?: boolean | null };
  error?: string;
}

/** 언락/맛보기 공통 결과 — code: subscription_required / already_tasted / unauthenticated / network. */
export interface HubPromptOpenResult {
  ok: boolean;
  receiptVersion?: 1;
  status?: "ready" | "processing" | "completed" | "consumed" | "not_required" | "already_unlocked";
  slug?: string;
  tasteIntentId?: string;
  unlockIntentId?: string;
  body?: string;
  tipsKo?: string;
  tipsEn?: string;
  alreadyUnlocked?: boolean;
  unlocked?: boolean;
  isOwner?: boolean;
  charged?: number;
  tasted?: boolean;
  replayed?: boolean;
  completedAt?: string;
  outcomeUnknown?: boolean;
  code?: string;
  error?: string;
  upgradeUrl?: string;
}

export interface PromptChatStartInput {
  intentId: string;
  body: string;
  seedOnly?: boolean;
}

export interface PromptChatStartReceipt {
  ok: true;
  receiptVersion: 1;
  status: "created" | "replayed";
  intentId: string;
  promptDigest: string;
  seedOnly: boolean;
  chat: Chat;
}

export interface HubPromptTastesResult {
  ok: boolean;
  count: number;
  slugs: string[];
  code?: string;
}

export interface HubPromptBookmarkResult {
  ok: boolean;
  /** Exact prompt identity for the mutation/readback receipt. */
  slug?: string;
  bookmarked?: boolean;
  /** True only after GET /bookmarks confirmed the final requested state. */
  verified?: boolean;
  /** Mutation may have committed but its authoritative projection was unavailable. */
  outcomeUnknown?: boolean;
  code?: string;
  error?: string;
}

// ── 퀘스트 (온보딩 대체 신규 유저 튜토리얼 — 웹 /api/quests 프록시) ────────────
export interface QuestInfo {
  id: string;
  titleKo: string;
  titleEn: string;
  descKo: string;
  descEn: string;
  rewardCredits: number;
  verification: "server" | "client-attested";
  claimed: boolean;
  claimedAt: string | null;
}

export interface QuestListResult {
  ok: boolean;
  authenticated: boolean;
  quests: QuestInfo[];
  error?: string;
}

export interface QuestClaimResult {
  ok: boolean;
  receiptVersion?: 1;
  status?: "ready" | "completed" | "already_claimed";
  questId?: string;
  claimIntentId?: string;
  rewardCredits?: number;
  claimedAt?: string;
  replayed?: boolean;
  outcomeUnknown?: boolean;
  code?: string;
  error?: string;
}

export interface QuestClaimInput {
  questId: string;
  claimIntentId: string;
}

// ── 에이전트 durable 메모리(런타임 큐레이터 DB) — 자가진화/타임라인 UI 소스 ────
export interface AgentMemoryEntryUi {
  id: string;
  scope: string;
  kind: string;
  content: string;
  confidence: "high" | "medium" | "low";
  sensitivity: "public" | "internal" | "private" | "confidential" | "secret";
  evidence: string[];
  chatId: string | null;
  projectPath: string | null;
  createdAt: string;
}

/** Phase 1b: one mapped section in an "import existing memory" preview. */
export interface MemoryImportRowUi {
  file: string;
  section: string;
  ownerLabel: string;
  ownerAgentId: string | null;
  scope: string;
  kind: string;
  status: "new" | "duplicate" | "redacted";
}

export interface MemoryImportPreviewUi {
  sourcePath: string;
  targetAgentId: string;
  targetKind: "agent" | "team";
  rows: MemoryImportRowUi[];
  summary: {
    total: number;
    newCount: number;
    duplicateCount: number;
    redactedCount: number;
    byOwner: Record<string, number>;
    byKind: Record<string, number>;
  };
}

export interface MemoryImportResultUi {
  sourcePath: string;
  targetAgentId: string;
  imported: number;
  skippedDuplicate: number;
  redacted: number;
  embedded: number;
  intakeAttempted: number;
  byOwner: Record<string, number>;
}

export interface AgentLearningSummary {
  agentId: string;
  /** Runs whose executor was recorded directly on the append-only run ledger. */
  runCount: number;
  lastRunAt: string | null;
  /**
   * Pre-ledger runs linked through an exact chat -> installed-agent relation.
   * This is related activity, not proof that the agent was the final executor.
   */
  legacyChatLinkedRunCount: number;
  legacyChatLinkedLastRunAt: string | null;
  legacyChatLinkedFailureCount: number;
  durableMemoryCount: number;
  /** Content-free per-turn curator receipts available from the current ledger version onward. */
  curationTurnCount: number;
  noNewMemoryTurnCount: number;
  memoryEventCount: number;
  memoryWrittenCount: number;
  memoryDedupedCount: number;
  memoryRedactedCount: number;
  memorySessionOnlyCount: number;
  memoryDiscardedCount: number;
  memoryMarkdownCount: number;
  failureCount: number;
  evolutionProposalCount: number;
  /** Global historical terminal/failure records that cannot honestly be assigned to any agent. */
  legacyUnattributedCount: number;
  localFileCount: number;
  localReceiptCount: number;
}

export type AgentOntologyHubProjectionStatus =
  | "unbound"
  | "live"
  | "offline"
  | "stale"
  | "auth-unavailable"
  | "endpoint-absent"
  | "projection-missing"
  | "binding-changed";

/**
 * Renderer-safe, read-only Hub projection for one installed agent. Main owns
 * authentication and exact-binding resolution; no local path, prompt, user,
 * workspace, credential, or MCP process configuration crosses IPC.
 */
export interface AgentOntologyHubProjection {
  schemaVersion: 1;
  status: AgentOntologyHubProjectionStatus;
  supported: boolean;
  binding: {
    agentDefinitionId: string;
    agentReleaseId: string;
  } | null;
  projection: MobileBridgeOntologyProjectionDto | null;
}

export type AgentOntologyAttachDecision = "approve" | "deny";

/**
 * Main-verified result of one explicit Desktop attachment decision. The
 * renderer receives the outcome and refreshed public projection, never a
 * session cookie, idempotency key, or caller-supplied release identity.
 */
export interface AgentOntologyAttachDecisionResult {
  schemaVersion: 1;
  outcome: MobileBridgeOntologyAttachReceiptDto["outcome"];
  loadoutState: MobileBridgeOntologyAttachReceiptDto["loadoutState"];
  acknowledgedAt: string;
  projection: AgentOntologyHubProjection;
}

export interface RunEventUi {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  kind: string;
  chatId?: string;
  automationId?: string;
  nodeId?: string;
  agentId?: string;
  payload: Record<string, unknown>;
}

export interface FailureEventUi {
  id: string;
  runId?: string;
  ts: string;
  source: string;
  chatId?: string;
  automationId?: string;
  nodeId?: string;
  agentId?: string;
  errorCode?: string;
  /** Closed tool cause shared by the failure ledger, replay, and One UI. */
  failureCode?: ToolFailureCode;
  errorMessage: string;
  payload: Record<string, unknown>;
}

export type InvocationRunStatus =
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * Durable execution receipt. Renderer busy state is deliberately not part of
 * this contract: main's live registry owns running/cancelling, while the DB
 * ledger owns terminal recovery and retry deduplication.
 */
export interface InvocationRunReceipt {
  runId: string;
  chatId: string;
  status: InvocationRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  eventCount: number;
  resultFolder?: string;
  hasImages?: boolean;
  borrowAgents?: string[];
  taskForceTargets?: OrchestrationTarget[];
  /**
   * Model/runtime label the orchestrator actually executed with, replayed from
   * the run's own final/result ledger rows (표시=실행, 계약 7-C-8 / C-D-1).
   * Absent for runs that never reached a model call.
   */
  model?: string;
  errorCode?: string;
  errorMessage?: string;
  /**
   * Tool authority this run executed under, replayed from the durable start
   * record. Automatic recovery needs it: a `read` run cannot have mutated
   * anything outside the app, so repeating it is safe, while a write-capable
   * run has no idempotency key to collapse a duplicate onto.
   */
  executionPermission?: "read" | "write" | "full";
}

/** Result of Main's recovery judgment for one unfinished run. */
export interface OneAutoRecoveryJudgement {
  /** True when One may retry by itself with a changed approach. */
  retry: boolean;
  /** Present when retry is false: why One stopped instead. */
  reason?:
    | "settled"
    | "stopped-by-user"
    | "needs-person"
    | "unsafe-to-repeat"
    | "will-not-succeed"
    | "no-progress"
    | "exhausted"
    | "undecided";
  /** 1-based index of the attempt this authorizes, when retry is true. */
  attempt?: number;
  /** Identity of this failure, so the caller can detect a repeat next time. */
  fingerprint: string;
  /** Plain-language account of what blocked the run. */
  diagnosis: string;
  /** "unavailable" means no model verdict exists; no semantic fallback ran. */
  decidedBy: "form" | "llm" | "unavailable";
}

/** Main-owned proof that a completed recovery run satisfied the original request. */
export interface OneAutoRecoveryVerification {
  verified: boolean;
  retry: boolean;
  attempt?: number;
  reason?:
    | "settled"
    | "stopped-by-user"
    | "needs-person"
    | "unsafe-to-repeat"
    | "will-not-succeed"
    | "no-progress"
    | "exhausted"
    | "undecided";
  diagnosis: string;
  decidedBy: "llm" | "unavailable";
  originalRunId: string;
  recoveryRunId: string;
  assessmentReceiptId?: string;
}

export type AgentEvolutionProposalStatus =
  | "candidate"
  | "approved"
  | "applying"
  | "rejected"
  | "applied"
  | "measured"
  | "rolling_back"
  | "rolled_back"
  | "apply_failed"
  | "conflicted"
  | "recovery_required";

export interface AgentEvolutionReceiptUi {
  id: string;
  proposalId: string;
  agentId: string;
  action: "apply" | "rollback";
  targetPath: string;
  versionBefore: number;
  versionAfter: number;
  targetHashBefore: string;
  targetHashAfter: string;
  /** Hash of governed prompt/skill/playbook assets, not the Agent Cloud bundle hash. */
  governedAssetHashBefore: string;
  governedAssetHashAfter: string;
  /** @deprecated compatibility alias; use governedAssetHashBefore. */
  packageHashBefore: string;
  /** @deprecated compatibility alias; use governedAssetHashAfter. */
  packageHashAfter: string;
  createdAt: string;
}

export interface AgentEvolutionProposalUi {
  id: string;
  agentId: string;
  proposalType: "rule" | "playbook" | "skill" | "setup_doc" | "plugin";
  summary: string;
  targetPath: string;
  beforeHash: string;
  afterHash: string;
  /** Local-only diff payload used for explicit review and crash recovery. */
  beforeContent: string;
  afterContent: string;
  risk: "low" | "medium" | "high";
  status: AgentEvolutionProposalStatus;
  source: Record<string, unknown>;
  receipts: AgentEvolutionReceiptUi[];
  decisionNote?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  appliedAt?: string;
  measuredAt?: string;
  rolledBackAt?: string;
}

/** 사람이 읽는 성장 제안 카드 문구 — 원시 diff 대신 "배운 것 → 바뀌는 것 → 되돌리기". */
export interface GrowthProposalCardCopy {
  learned: string;
  change: string;
  reversible: string;
}

/** 4표면 발화 UX용 전역 성장 제안 인박스. */
export interface GrowthProposalInbox {
  /** 사람이 결정해야 하는 고위험 후보(candidate) — [적용][나중에][안 함]. */
  pending: AgentEvolutionProposalUi[];
  /** 저위험 자동적용분 — 수동태 "적용됨 · 되돌리기" 표기. */
  autoApplied: AgentEvolutionProposalUi[];
}

export interface CreateAgentEvolutionProposalInput {
  agentId: string;
  targetPath: string;
  currentContent: string;
  proposedContent: string;
  proposalType?: AgentEvolutionProposalUi["proposalType"];
  summary?: string;
  risk?: AgentEvolutionProposalUi["risk"];
  source?: Record<string, unknown>;
  decisionNote?: string;
}

/** 버그 신고 입력 — 우측 하단 도움말(?) 메뉴의 신고 폼에서 전달. */
export interface BugReportInput {
  message: string;
  title?: string;
  severity?: "low" | "medium" | "high";
  email?: string;
  /** 신고 당시 화면 경로(예: "/workspace/task") — 재현에 도움. */
  page?: string;
  /** 표시 언어(ko/en). */
  locale?: string;
}

/** 버그 신고 결과 — 웹 API가 MongoDB에 적재. */
export interface BugReportResult {
  ok: boolean;
  /** 저장된 신고 id(성공 시). */
  id?: string;
  /** 실패 코드: message_required / network / http_4xx / store_failed 등. */
  code?: string;
  error?: string;
}

export type ExperienceHubCatalogOffer = {
  mode: "purchase" | "lease";
  durationDays: number | null;
  credits: number;
};

export type ExperienceHubCatalogChip = {
  title: string;
  summary: string;
  benefits: string[];
  author: string;
  workLabels: string[];
  offers: ExperienceHubCatalogOffer[];
  /** Same-origin public Hub detail route; no raw internal ID is rendered. */
  detailPath: string;
  updatedAt: string | null;
};

export type ExperienceHubCatalogResult = {
  status: "ready" | "empty" | "unavailable";
  chips: ExperienceHubCatalogChip[];
  checkedAt: string;
  message?: string;
};

/**
 * Renderer judgment bridge — style/format inference only. Main owns the
 * question/guidance per allowlisted kind; the renderer supplies only labels,
 * input, hint wordlists (reference only), and its deterministic fallback.
 */
export interface RendererJudgmentSpec {
  kind: string;
  labels: string[];
  input: string;
  fallback: string;
  hints?: Array<{ label: string; words: string[] }>;
  timeoutMs?: number;
}

export interface RendererJudgmentVerdict {
  verdict: string;
  source: "llm" | "fallback";
  confidence: number;
  reason: string;
}

export interface RendererSubsetJudgmentSpec {
  kind: string;
  labels: string[];
  input: string;
  hints?: Array<{ label: string; words: string[] }>;
  timeoutMs?: number;
}

export interface RendererSubsetJudgmentVerdict {
  selected: string[];
  source: "llm" | "fallback";
  confidence: number;
  reason: string;
}

/** The three things a creator can charge for. Ceilings live on the server. */
export type CloudAgentPriceKind = "RENT" | "INGEST" | "FORK";

export type CloudAgentPrices = Partial<Record<CloudAgentPriceKind, number>>;

/**
 * A PATCH, not a replacement.
 *
 * A kind left out is untouched; a kind set to null is removed. Blank is not
 * zero — an agent with no fork price cannot be forked, while a fork priced at
 * zero would be giving copies away.
 */
export type CloudAgentPricePatch = Partial<Record<CloudAgentPriceKind, number | null>>;

export interface CloudAgentPricesRead {
  ok: boolean;
  prices: CloudAgentPrices;
  /** True when nothing has ever been priced — the agent is callable for free. */
  legacyUnpriced: boolean;
  agentDefinitionId?: string;
}

export type CloudAgentSetPricesResult =
  | { ok: true; prices: CloudAgentPrices; changed: boolean }
  | { ok: false; code: string; message: string; kind?: string; maxCredits?: number; minCredits?: number };

/**
 * Day-based prepaid agent lease (owner decision 2026-08-18). The old 24-hour
 * auto-lease is retired: RENT bills per work order, and a long-term lease is
 * bought explicitly for 1..30 days. While active, calls to that slug cost 0.
 */
export interface AgentLeaseQuote {
  /** False when the account is signed out or the server could not be reached. */
  ok: boolean;
  active: boolean;
  leasedUntil: string | null;
  perDayCredits: number | null;
  /** False → the creator does not sell long-term leases for this agent. */
  leaseOffered: boolean;
  /** Machine-readable reason when the quote could not be used. */
  code?: "signed_out" | "network" | "http" | "invalid_slug" | "lease_not_offered" | string;
  /** Safe, user-facing explanation; never includes response payloads. */
  message?: string;
}

export type AgentLeasePurchaseResult =
  | { ok: true; leasedUntil: string; days: number; perDayCredits: number; chargedCredits: number }
  | { ok: false; code: "lease_not_offered" | "insufficient_credits" | "signed_out" | "network" | string; needed?: number; have?: number; message: string };

export interface AgentLeaseRow {
  slug: string;
  leasedUntil: string;
}

/** 실행이 끝났을 때의 알람 설정. 정본 구현은 electron/run-alerts.ts. */
export interface RunAlertSettings {
  enabled: boolean;
  notification: boolean;
  sound: boolean;
  /** macOS Dock 바운스 / Windows·Linux 작업표시줄 깜빡임. */
  bounce: boolean;
  onlyWhenUnfocused: boolean;
  /** 이보다 짧게 끝난 턴은 알리지 않는다(초). 0이면 언제나. */
  minSeconds: number;
  alsoOnFailure: boolean;
}

export interface AgentlasIpc {
  /**
   * 도구 승인 결정 — Main의 exact resolution 원장이 같은 request/decision/action 을
   * 확인한 뒤에만 성공이다. 응답이 유실돼도 getToolApprovalResolution 으로 재전송
   * 없이 실제 결정을 확인한다.
   */
  resolveToolApproval: (
    id: string,
    decision: ToolApprovalDecision,
    actionId: string,
  ) => Promise<ToolApprovalResolutionReceipt>;
  getToolApprovalResolution: (id: string) => Promise<ToolApprovalResolutionReceipt>;
  listToolApprovals: () => Promise<ToolApprovalRequestEvent[]>;
  /** 데몬 자동 시작(로그인 기동) — 기본 off. 켜면 부팅 항목까지 같은 턴에 정합된다. */
  getDaemonAutostart: () => Promise<{ enabled: boolean }>;
  setDaemonAutostart: (enabled: boolean) => Promise<{ enabled: boolean; reconciled?: boolean; reason?: string }>;
  /** 능력 규칙(capability_grants) — "항상 허용"의 영구 원장(오너 결정 2026-08-20). */
  listCapabilityGrants: (scope?: string) => Promise<Array<{
    id: number; capability: string; pattern: string | null;
    decision: "allow" | "deny"; scope: string; source: string; createdAt: string;
    binding?: ToolApprovalConsentBinding;
  }>>;
  revokeCapabilityGrant: (id: number) => Promise<boolean>;
  /** 대화 단위 "항상 승인" — renderer localStorage 에서 공유 DB 로 이관됐다. */
  listAlwaysApprovedChats: () => Promise<string[]>;
  grantChatAlwaysApproval: (chatId: string) => Promise<string[]>;
  revokeChatAlwaysApproval: (chatId: string) => Promise<string[]>;
  /** Electron 메인이 알려주는 OS 환경 정보 (Apple/Codex/Claude 데스크톱과 동일 패턴) */
  app: {
    /** macOS 시스템 설정의 1순위 언어 — "ko-KR" / "en-US" 등. i18n 자동 감지에 사용 */
    getLocale: () => Promise<string>;
    /** package.json의 version — 사이드바 푸터 표기/디버그 용 */
    getVersion: () => Promise<string>;
  };
  /** Rendered chat images — Main owns trusted loading, clipboard, and native save dialogs. */
  media: {
    copyImage: (payload: { src: string; suggestedName?: string }) => Promise<{
      ok: boolean; error?: string;
    }>;
    saveImage: (payload: { src: string; suggestedName?: string }) => Promise<{
      ok: boolean; path?: string; canceled?: boolean; error?: string;
    }>;
  };
  /** DESKTOP_MOBILE_BRIDGE: pairing UI only; tokens never cross renderer IPC. */
  mobileBridge: {
    status: () => Promise<MobileBridgeRuntimeStatus>;
    issuePairing: () => Promise<MobileBridgePairingPayload>;
    listDevices: () => Promise<MobileBridgeDeviceSummary[]>;
    retry: () => Promise<MobileBridgeRuntimeStatus>;
    revokeDevice: (deviceId: string) => Promise<{ ok: boolean }>;
    /** Reveals the main-process log file. Log contents never cross IPC. */
    revealLog: () => Promise<{ ok: boolean }>;
  };
  /** First-party product extensions are signed, separately installed products. */
  productExtensions: {
    scienceStatus: () => Promise<ProductExtensionStatus>;
    scienceSuiteStatus: () => Promise<ScienceSuiteStatus>;
    installScience: () => Promise<ProductExtensionInstallReceipt>;
    installScienceSuite: () => Promise<ScienceSuiteInstallReceipt>;
    setScienceEnabled: (enabled: boolean) => Promise<ProductExtensionStatus>;
    uninstallScience: () => Promise<ProductExtensionUninstallReceipt>;
    openScienceView: (bounds: ProductExtensionViewBounds, leaseId: string) => Promise<ProductExtensionViewStatus>;
    setScienceViewBounds: (bounds: ProductExtensionViewBounds, leaseId: string) => Promise<{ ok: boolean }>;
    closeScienceView: (leaseId: string) => Promise<{ ok: true }>;
  };
  /**
   * Resident judgment bridge for renderer style/format inference. Narrow and
   * kind-allowlisted in Main; a missing model returns the caller's fallback
   * verdict labeled source:"fallback" — never silently lexical.
   */
  judgment: {
    judge: (spec: RendererJudgmentSpec) => Promise<RendererJudgmentVerdict>;
    judgeSubset: (spec: RendererSubsetJudgmentSpec) => Promise<RendererSubsetJudgmentVerdict>;
  };
  /** T-rex 슬라이드 스튜디오 — 키리스 CLI 이미지 생성(codex image_gen / agy). */
  /**
   * Site Studio: Web/mobile는 sandbox 디자인 프리뷰, Agent App은 별도 Astryx
   * 패키지 + main-owned 로컬 런타임/명시적 공개 배포 경로를 사용한다.
   */
  site: {
    listProjects: () => Promise<SiteProjectPublicMeta[]>;
    /** Main-authoritative project mutex, used to restore busy UI after remount. */
    operationStatus: (payload: { projectId: string }) => Promise<SiteProjectOperation | null>;
    /** 사람이 읽는 Site Copilot 기록 — 내부 모델 프롬프트와 분리된 프로젝트별 영속 로그. */
    listConversation: (payload: { projectId: string }) => Promise<SiteConversationEntry[]>;
    createProject: (payload: {
      name: string;
      surface?: SiteSurface;
      /** Required for Agent App; Electron main resolves and persists display/capability data. */
      agentAppTarget?: SiteAgentAppTargetRef;
    }) => Promise<SiteProjectPublicMeta>;
    deleteProject: (payload: { projectId: string }) => Promise<SiteDeleteProjectResult>;
    /** Start the capability-scoped loopback runtime and open the built Astryx app. */
    launchAgentApp: (payload: { projectId: string }) => Promise<SiteAgentAppLaunchResult>;
    stopAgentApp: (payload: { projectId: string }) => Promise<SiteAgentAppRuntimeStatus>;
    agentAppRuntimeStatus: (payload: { projectId: string }) => Promise<SiteAgentAppRuntimeStatus>;
    /** Value-safe MCP recommendation. No key names, values, commands, URLs, or paths. */
    agentAppMcpRecommendation: (payload: { projectId: string }) => Promise<SiteAgentAppMcpRecommendation>;
    /** Opens a main-owned native review and returns the resulting safe status. */
    reviewAgentAppMcp: (payload: { projectId: string }) => Promise<SiteAgentAppMcpRecommendation>;
    /** Runs before the first design/Astryx generation; cancel/skip still permits a no-tool build. */
    prebuildReviewAgentAppMcp: (payload: { projectId: string }) => Promise<SiteAgentAppMcpRecommendation>;
    /** Read only the validated 1280x720 PNG tied to this Site project. */
    agentAppThumbnail: (payload: { projectId: string }) => Promise<SiteAgentAppThumbnailResult>;
    /** Provider readiness only; credentials never cross into the renderer. */
    listPublishProviderStatuses: () => Promise<SiteAgentAppPublishProviderStatus[]>;
    savePublishProviderToken: (payload: { provider: SitePublishProvider; token: string }) => Promise<SiteAgentAppPublishTokenResult>;
    removePublishProviderToken: (payload: { provider: SitePublishProvider }) => Promise<SiteAgentAppPublishTokenResult>;
    openPublishProviderPage: (payload: {
      provider: SitePublishProvider;
      page: SitePublishProviderPage;
    }) => Promise<{ opened: boolean; provider: SitePublishProvider; page: SitePublishProviderPage }>;
    /** Starts a provider-owned browser login. Account creation and terms stay user-owned. */
    connectPublishProvider: (payload: { provider: SitePublishProvider }) => Promise<SiteAgentAppPublishConnectResult>;
    /** Validate the immutable Astryx package, then perform one explicitly approved public deploy. */
    publishAgentApp: (payload: SiteAgentAppPublishBackendRequest) => Promise<SiteAgentAppPublishBackendResult>;
    /** 화면 생성 — variants(1~3)만큼 시안을 만든다(순차 — 프로젝트 세션 공유). */
    generateScreen: (payload: {
      projectId: string;
      brief: string;
      variants?: number;
      styleHint?: string;
      /** 스타일 참조 화면 — 같은 제품처럼 보이게 팔레트/타이포를 따라간다. */
      baseScreenId?: string;
      locale?: "ko" | "en";
    }) => Promise<{
      ok: boolean;
      screens?: SiteScreenMeta[];
      engine?: string;
      feedback?: string;
      /** Agent App only: real React 19 + Astryx companion registered in Apps. */
      agentApp?: SiteAgentAppScaffoldSummary;
      agentAppReason?: string;
      reason?: string;
    }>;
    /** 선택 요소 부분 patch 우선 수정. selectionId = data-agentlas-id. */
    editScreen: (payload: {
      projectId: string;
      screenId: string;
      instruction: string;
      selectionId?: string;
      /** 사용자에게 보이는 선택 대상 식별자 — 내부 HTML 프롬프트와 분리해 대화 로그에만 저장. */
      selectionContext?: string;
      locale?: "ko" | "en";
    }) => Promise<{
      ok: boolean;
      screen?: SiteScreenMeta;
      engine?: string;
      mode?: "patch" | "full";
      feedback?: string;
      /** Agent App only: regenerated from the preserved main-owned I/O contract after an edit. */
      agentApp?: SiteAgentAppScaffoldSummary;
      agentAppReason?: string;
      reason?: string;
    }>;
    readScreen: (payload: { projectId: string; screenId: string }) => Promise<{ ok: boolean; html?: string; reason?: string }>;
    /** 렌더 직전 태깅+오버레이/CSP 주입 — iframe srcDoc으로 쓸 HTML과 nonce 반환. */
    prepareRender: (payload: { projectId: string; screenId: string }) => Promise<{ ok: boolean; renderHtml?: string; nonce?: string; reason?: string }>;
    renameScreen: (payload: { projectId: string; screenId: string; name: string }) => Promise<{ ok: boolean; screen?: SiteScreenMeta }>;
    deleteScreen: (payload: { projectId: string; screenId: string }) => Promise<{ ok: boolean }>;
    /** 창 좌표(rect, CSS px) 크롭 스크린샷 — 선택 요소 썸네일용. */
    captureRect: (payload: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; dataUrl?: string; reason?: string }>;
    exportScreen: (payload: { projectId: string; screenId: string }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; reason?: string }>;
    /** 이 프로젝트 표면에서 고를 수 있는 코드 내보내기 대상(웹: react|html, 앱: flutter|react-native|…). */
    exportTargets: (payload: { projectId: string }) => Promise<{ ok: boolean; targets?: string[]; reason?: string }>;
    /** 승인된 화면을 코드로 옮겨 사용자가 고른 폴더에 쓴다. 배포는 하지 않는다. */
    exportScreenCode: (payload: { projectId: string; screenId: string; target: string }) => Promise<{
      ok: boolean; path?: string; files?: string[]; notes?: string; engine?: string; canceled?: boolean; reason?: string;
    }>;
    exportProjectZip: (payload: { projectId: string }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; reason?: string }>;
    /** 사용자가 직접 고른 작업공간에 디자인 리비전을 기록하고 Build 입력으로 이어간다. */
    handoffToWorkspace: (payload: {
      projectId: string;
      workspaceGrant: FsPathGrant;
      locale?: "ko" | "en";
    }) => Promise<{ ok: boolean; handoff?: SiteWorkspaceHandoff; reason?: string }>;
    /** 활성 런타임 존재 여부 + 붙어 있는 Hub 에이전트 슬러그. */
    contentAvailable: () => Promise<{ ready: boolean; agent: string }>;
  };
  /** 문서 스튜디오 내용 생성/개정 — 연결된 LLM(agy/codex), no-fallback. */
  document: {
    /**
     * Render a document to PDF through the strongest path this computer has.
     * The result always names the engine that actually produced the file, and
     * flags `degraded` when LaTeX typesetting was wanted but unavailable — a
     * Chromium page must never be presented as a typeset manuscript.
     */
    exportPdf: (payload: {
      title: string;
      markdown: string;
      figureCaption?: string;
      suggestedName?: string;
    }) => Promise<{
      ok: boolean;
      canceled?: boolean;
      path?: string;
      engine?: "tectonic" | "chromium";
      degraded?: "toolchain-missing" | "typeset-failed";
      degradedReason?: string;
      bytes?: number;
      reason?: string;
    }>;
    /** Which PDF paths exist here, so the UI can say so before the user clicks. */
    pdfCapability: () => Promise<{ latex: boolean; chromium: boolean }>;
    generate: (payload: {
      goal: string;
      mode?: "report" | "paper" | "brief";
      locale?: "ko" | "en";
      sources?: { authors?: string; title: string; year?: string; container?: string }[];
    }) => Promise<{
      ok: boolean;
      doc?: { title: string; subtitle: string; body: string; figureCaption: string };
      engine?: "agy" | "codex";
      reason?: string;
    }>;
    revise: (payload: {
      text: string;
      action: "expand" | "rewrite" | "shorten" | "improve" | "formal" | "casual";
      locale?: "ko" | "en";
    }) => Promise<{ ok: boolean; text?: string; engine?: "agy" | "codex"; reason?: string }>;
    available: () => Promise<{ agy: boolean; codex: boolean }>;
  };
  /** 버그 신고 — 우측 하단 도움말(?) 메뉴에서 신고를 받아 웹 API(→MongoDB)로 적재. */
  support: {
    submitBugReport: (payload: BugReportInput) => Promise<BugReportResult>;
  };
  /** 네이티브 macOS 메뉴바 제어 — 인앱 언어 설정을 메인 프로세스로 전달해 메뉴를 다시 그린다. */
  menu: {
    /** 현재 표시 언어를 메인에 알려 네이티브 메뉴 라벨을 ko/en으로 갱신. */
    setLocale: (locale: "ko" | "en") => Promise<void>;
  };
  /** 워킹 폴더 — 채팅 우측의 폴더 트리 패널이 사용. read-only. */
  fs: {
    pickDirectory: () => Promise<FsPathGrant | null>;
    listDirectory: (absPath: string, scope: FsReadScope, showHidden?: boolean) => Promise<DirListing>;
    readTextFile: (absPath: string, scope: FsReadScope) => Promise<TextFilePreview>;
    watchFile: (absPath: string, scope: FsReadScope) => Promise<FsFileWatchSnapshot>;
    unwatchFile: (watchId: string) => Promise<{ ok: boolean }>;
    onFileChanged: (handler: (snapshot: FsFileWatchSnapshot) => void) => () => void;
    /** 로컬 파일/폴더 또는 http(s) URL을 OS 기본 앱/브라우저로 연다. */
    openPath: (target: string) => Promise<{ ok: boolean; message?: string }>;
    /** 로컬 파일/폴더를 Finder/Explorer에서 표시한다. */
    showItemInFolder?: (target: string) => Promise<{ ok: boolean; message?: string }>;
    /** 네이티브 저장 다이얼로그로 텍스트를 디스크에 쓴다(산출물 내보내기). 취소 시 canceled=true. */
    saveTextFile: (
      suggestedName: string,
      content: string,
    ) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  };
  /** 채팅마다 마지막에 연 워킹 폴더 — SQLite에 저장. null이면 미설정. */
  workspace: {
    get: (chatId: string) => Promise<string | null>;
    set: (chatId: string, grant: FsPathGrant | null) => Promise<void>;
    /** Apply a main-owned project folder without accepting a renderer-supplied path. */
    setFromProject: (chatId: string, projectId: string) => Promise<void>;
    /** CLI 실행 기본 폴더(userData/agent-cwd). 채팅 working_folder가 없을 때 산출물 상대경로 해석에 사용. */
    defaultRunFolder: () => Promise<string | null>;
    /** 네이티브 폴더 선택 다이얼로그 → 선택한 절대경로(취소 시 null) */
    selectFolder: () => Promise<FsPathGrant | null>;
  };
  /** 로그인 — agentlas.cloud 구글 OAuth. BrowserWindow 열고 cookie 추출 → Keychain. */
  auth: {
    /** 현재 세션 메타데이터 — 로그인되어 있지 않으면 signedIn=false */
    getSession: () => Promise<AuthSession>;
    /** Google 로그인 시작 — BrowserWindow를 띄우고 사용자가 끝낼 때까지 await */
    signInWithGoogle: () => Promise<AuthSession>;
    /** 시스템 기본 브라우저(이미 로그인된 크롬 등)로 로그인 — loopback 콜백으로 세션 수신.
     *  웹앱이 desktop callback을 지원하지 않거나 180초 타임아웃 시 signedIn=false (창 방식으로 폴백). */
    signInWithBrowser: () => Promise<AuthSession>;
    signOut: () => Promise<void>;
    /** Main-authoritative TTL/server invalidation notification. */
    onSessionChanged?: (callback: (session: AuthSession) => void) => () => void;
  };
  /** LLM 엔진 사용량 — 프로바이더 OAuth usage 엔드포인트(Claude/Codex/Gemini)에서
   *  5시간·주간(7일)·모델별·월 크레딧 조회. main에서 60초 캐시; force로 강제 갱신. */
  usage: {
    snapshot: (opts?: { force?: boolean }) => Promise<UsageSnapshot>;
    /** Provider allowlist와 main-owned cooldown 아래 캐시 무효화+재조회를 원자적으로 수행한다. */
    retry: (providerId: UsageRetryProviderId) => Promise<UsageRetryResult>;
  };
  /** Agentlas Hub 크레딧 — 구독(사용 가능) 잔액과 렌트수익(이동 가능) 잔액을 함께 조회하고,
   *  렌트수익 → 구독 일방 전송을 수행한다. 세션 쿠키로 Hub HTTP API를 main에서 호출. */
  billing: {
    getCredits: () => Promise<HubCreditBalance>;
    transferEarnings: (credits: number) => Promise<EarningsTransferResult>;
  };
  /** 프롬프트 저장소 — 웹 프롬프트 카탈로그 탐색/열람/맛보기/저장(북마크). Hub 메뉴와 동형. */
  promptHub: {
    list: (params?: { q?: string; category?: string }) => Promise<HubPromptCatalog>;
    get: (slug: string) => Promise<HubPromptDetailResult>;
    unlock: (input: { slug: string; unlockIntentId: string }) => Promise<HubPromptOpenResult>;
    unlockStatus: (input: { slug: string; unlockIntentId: string }) => Promise<HubPromptOpenResult>;
    taste: (input: { slug: string; tasteIntentId: string }) => Promise<HubPromptOpenResult>;
    tasteStatus: (input: { slug: string; tasteIntentId: string }) => Promise<HubPromptOpenResult>;
    startChat: (input: PromptChatStartInput) => Promise<PromptChatStartReceipt>;
    tastes: () => Promise<HubPromptTastesResult>;
    bookmarks: () => Promise<{ ok: boolean; slugs: string[]; code?: string }>;
    bookmarkAdd: (slug: string) => Promise<HubPromptBookmarkResult>;
    bookmarkRemove: (slug: string) => Promise<HubPromptBookmarkResult>;
  };
  /** 퀘스트 — 대시보드 신규 유저 튜토리얼(온보딩 대체). 클레임 성공 시 크레딧 지급. */
  quests: {
    list: () => Promise<QuestListResult>;
    claim: (input: QuestClaimInput) => Promise<QuestClaimResult>;
    claimStatus: (input: QuestClaimInput) => Promise<QuestClaimResult>;
  };
  /** 에이전트 전역 durable 메모리. 프로젝트 메모리는 프로젝트 화면에서만 조회한다. */
  agentMemory: {
    entries: (agentId: string, limit?: number) => Promise<AgentMemoryEntryUi[]>;
    /** Phase 1b: 레거시 마크다운 폴더/파일 → 멤버·팀·공유 메모리 dry-run 미리보기. 경로 미지정 시 폴더 선택. */
    importPreview: (agentId: string, sourcePath?: string) => Promise<MemoryImportPreviewUi | null>;
    /** Phase 1b: 미리보기 그대로 적용(멱등). */
    importApply: (agentId: string, sourcePath: string) => Promise<MemoryImportResultUi>;
  };
  agentLearning: {
    summary: (agentId: string) => Promise<AgentLearningSummary>;
  };
  /** v74 사용 원장 + 북마크 — run 귀속 시 자동 축적되는 agent_usage 조회/북마크 토글. */
  agents: {
    usageSummary: () => Promise<AgentUsageSummaryRow[]>;
    exactBindings: () => Promise<InstalledAgentExactBinding[]>;
    borrowedProfiles: () => Promise<BorrowedAgentProfile[]>;
    borrowedOntologyGraph: (profileId: string) => Promise<ExperienceOntologyGraphSnapshot>;
    setBookmark: (agentId: string, bookmarked: boolean) => Promise<{ agentId: string; bookmarkedAt: string | null }>;
  };
  /** Local Experience ownership and explicit owner-authorized Cloud exchange. */
  experience: {
    /** Public, buyer-safe Hub catalog. Internal chip/release IDs never cross IPC. */
    hubCatalog: () => Promise<ExperienceHubCatalogResult>;
    createPack: (input: ExperiencePackCreateIpcInput) => Promise<ExperiencePackRecord>;
    listPacks: (input: ExperiencePackListInput) => Promise<ExperiencePackRecord[]>;
    captureFromMemory: (input: ExperienceCandidateCaptureInput) => Promise<ExperienceCandidateRecord>;
    listCandidates: (packId: string) => Promise<ExperienceCandidateRecord[]>;
    listOperationalPublicProjections: (packId: string) => Promise<OperationalPublicProjectionRecord[]>;
    saveOperationalPublicProjection: (input: OperationalPublicProjectionSaveInput) => Promise<OperationalPublicProjectionRecord>;
    confirmOperationalPublicProjection: (input: OperationalPublicProjectionConfirmInput) => Promise<OperationalPublicProjectionRecord>;
    /** Private preference observations only. They are not Hub Taste releases. */
    listTasteDrafts: (agentId: string) => Promise<LocalTasteDraftRecord[]>;
    listTasteWorkflows: (agentId: string) => Promise<TasteChipWorkflowRecord[]>;
    saveTasteGeneralization: (input: TasteGeneralizationInput) => Promise<TasteChipWorkflowRecord>;
    confirmTasteGeneralization: (input: TasteGeneralizationConfirmInput) => Promise<TasteChipWorkflowRecord>;
    pickTastePreviews: () => Promise<[TastePreviewGrant, TastePreviewGrant] | null>;
    prepareTastePreviews: (input: TastePreviewPrepareInput) => Promise<TasteChipWorkflowRecord>;
    uploadTasteDraft: (input: TasteHubUploadInput) => Promise<TasteChipWorkflowRecord>;
    promote: (input: ExperiencePromotionInput) => Promise<ExperiencePromotionReceipt>;
    /** Explicit owner-consented public unseal of one promoted candidate (post-redaction clean + existing receipt required). */
    unsealPublic: (input: ExperiencePublicUnsealInput) => Promise<ExperiencePromotionReceipt>;
    /** Value-free intake funnel counts (blocked/skipped reason codes, redacted admits). */
    intakeDiagnostics: (agentId: string) => Promise<ExperienceIntakeDiagnostics>;
    listPromotionReceipts: (packId: string) => Promise<ExperiencePromotionReceipt[]>;
    createExportIntent: (input: ExperienceExportIntentInput) => Promise<ExperienceExportIntentRecord>;
    listExportIntents: (packId: string) => Promise<ExperienceExportIntentRecord[]>;
    /** Private save and public verification request are separate explicit actions. */
    cloudSave: (input: ExperienceCloudSaveInput) => Promise<ExperienceCloudUploadRecord>;
    cloudList: (packId: string) => Promise<ExperienceCloudUploadRecord[]>;
    cloudReconcile: (input: ExperienceCloudReconcileInput) => Promise<ExperienceCloudUploadRecord>;
    cloudExport: (input: ExperienceCloudReconcileInput) => Promise<ExperienceCloudExportResult>;
    cloudWithdraw: (input: ExperienceCloudWithdrawInput) => Promise<ExperienceCloudUploadRecord>;
    ontologySummary: (agentId: string) => Promise<ExperienceOntologySummary>;
    /** Value-free, bounded relation graph; never includes source summaries, paths, prompts, or secrets. */
    ontologyGraph: (agentId: string) => Promise<ExperienceOntologyGraphSnapshot>;
    /** Exact v59 binding only. Reads Hub state; any attachment decision uses hubResolveAttach. */
    hubProjection: (agentId: string, force?: boolean) => Promise<AgentOntologyHubProjection>;
    /** Resolve only a Hub-issued pending approval for this exact installed agent. Never purchases a chip. */
    hubResolveAttach: (
      agentId: string,
      approvalId: string,
      decision: AgentOntologyAttachDecision,
    ) => Promise<AgentOntologyAttachDecisionResult>;
  };
  /** 실행/실패 원장 — 긴 원문 없이 runId, 노드, 도구, 오류 메타데이터만 조회한다. */
  runLedger: {
    events: (runId: string, limit?: number) => Promise<RunEventUi[]>;
    /**
     * Every run of one conversation (oldest first) with a bounded event window each —
     * One renders one "Worked for Ns" block per turn from this, so past turns keep
     * their process instead of only the latest run surviving a reload.
     */
    chatTimeline: (chatId: string, input?: { maxRuns?: number; eventsPerRun?: number }) => Promise<Array<{ receipt: InvocationRunReceipt; events: RunEventUi[] }>>;
    failures: (input?: { runId?: string; automationId?: string; chatId?: string; agentId?: string; limit?: number }) => Promise<FailureEventUi[]>;
  };
  /** 에이전트 자가진화 proposal 원장 — 제안/승인/적용/측정/롤백 상태를 로컬 DB에 남긴다. */
  agentEvolution: {
    list: (agentId: string, limit?: number) => Promise<AgentEvolutionProposalUi[]>;
    /** Candidate collection only; this call never writes an agent package file. */
    createProposal: (input: CreateAgentEvolutionProposalInput) => Promise<AgentEvolutionProposalUi>;
    /** Explicit approval applies the already-reviewed candidate and creates a hash/version receipt. */
    approveAndApply: (proposalId: string, note?: string) => Promise<AgentEvolutionProposalUi>;
    reject: (proposalId: string, note?: string) => Promise<AgentEvolutionProposalUi>;
    markMeasured: (proposalId: string, note?: string) => Promise<AgentEvolutionProposalUi>;
    rollback: (proposalId: string) => Promise<AgentEvolutionProposalUi>;
    /** 4표면 발화 UX — 전역 성장 제안(고위험 pending + 저위험 자동적용분). */
    listGrowth: (limit?: number) => Promise<GrowthProposalInbox>;
    /** Hide one growth-proposal session without changing the governed asset or receipts. */
    deleteGrowthSession: (proposalId: string) => Promise<AgentEvolutionProposalUi>;
  };
  /** 유휴 드리밍 큐레이션 — 옵트인(기본 OFF). 유휴+슬롯 완전 유휴+쿨다운 가드로 메모리 통합. */
  memoryDreaming: {
    status: () => Promise<{ enabled: boolean; lastRunAt: string | null; running: boolean }>;
    setEnabled: (enabled: boolean) => Promise<{ enabled: boolean; lastRunAt: string | null; running: boolean }>;
  };
  /** 확인 요청 — 에이전트가 챗에서 사용자 결정을 기다리는 채팅 목록(미답변 질문 fence 기준). */
  confirm: {
    listPending: () => Promise<PendingConfirmation[]>;
    /** 답변과 그 exact continuation request를 한 durable intent로 확정한다. */
    commitAnswer: (input: {
      chatId: string;
      reply: string;
      sourceMessageId?: string;
      continuation?: QuestionContinuationOptions;
    }) => Promise<{ chatId: string; sourceMessageId: string; continuationRunId: string }>;
    /** Main이 저장된 request만 사용해 exact-once continuation을 시작하거나 재확인한다. */
    continueAnswer: (input: { chatId: string; sourceMessageId: string; reply: string }) =>
      Promise<QuestionContinuationReceipt>;
    /** 정확한 현재 Decision만 24시간 미룬다. 실행·승인 상태는 바꾸지 않는다. */
    snooze: (input: { chatId: string; sourceMessageId: string; resumeAt: string }) =>
      Promise<{ chatId: string; sourceMessageId: string; snoozedUntil: string }>;
    committedAnswers: (chatId: string) => Promise<CommittedQuestionAnswer[]>;
    /**
     * 에이전트의 **동기 질문**에 대한 답(electron/confirm/ask-user.ts).
     * `null` 은 "답하지 않음" — 지어낸 답으로 채우지 않는다.
     */
    submitAskUserAnswer: (requestId: string, answer: string | null) => Promise<boolean>;
  };
  /** 앱 주의 표시 — Dock/taskbar badge와 네이티브 알림을 갱신한다. */
  attention: {
    setPendingConfirmations: (count: number) => Promise<void>;
  };
  /** 자동 업데이트 — electron-updater 래퍼. broadcast는 window.agentlasUpdater.onState로 받음. */
  updater: {
    /** 마운트 직후 현재 상태 동기 조회. broadcast 이전에 새 창이 열려도 onState로 미스되지 않음. */
    getState: () => Promise<UpdaterState>;
    /** 사용자가 "지금 확인" 누름. 동시 호출은 하나로 합치고 최종 authoritative state를 반환한다. */
    check: () => Promise<UpdaterState>;
    /** "재시작 업데이트" 클릭. 백업·권한·버전 가드를 모두 통과해야 종료/설치를 시작한다. */
    install: () => Promise<UpdaterActionResult>;
    /** macOS 네이티브 교체가 시작·적용되지 않았거나 서명 계보가 다를 때 공식 설치 페이지를 연다. */
    openManualDownload: () => Promise<UpdaterActionResult>;
    /** 현재 버전의 공개 릴리즈 노트를 기본 브라우저에서 연다. 업데이트 상태는 바꾸지 않는다. */
    openReleaseNotes: (version?: string) => Promise<UpdaterActionResult>;
    /** 연속성 검증 실패 때 main이 보관한 복구본을 Finder/Explorer에서 연다. */
    revealRecoveryBackup: () => Promise<UpdaterActionResult>;
  };
  runtime: {
    detect: (force?: boolean) => Promise<RuntimeStatus[]>;
    setActive: (selection: RuntimeSelection) => Promise<RuntimeStatus[]>;
    /** CLI 미설치 사용자용 — Windows는 앱에 동봉한 검증된 Node/npm으로 무관리자 설치. */
    installCli: (
      kind: "claude-code" | "codex" | "kimi" | "grok",
    ) => Promise<{ ok: boolean; message: string; command?: string }>;
    /** 시스템 터미널을 열어 CLI 로그인 실행 — 사용자는 브라우저 로그인만 하면 됨. */
    openCliLogin: (
      kind: "claude-code" | "codex" | "antigravity" | "kimi" | "grok",
    ) => Promise<{ ok: boolean; message: string; command?: string }>;
    /** CLI를 최신으로 업데이트 — 미설치면 설치, npm 관리본은 재설치, claude는 self-updater. */
    updateCli: (
      kind: "claude-code" | "codex" | "antigravity" | "kimi" | "grok",
    ) => Promise<{ ok: boolean; message: string; command?: string }>;
    /** CLI(Claude/Codex/Antigravity)의 커스텀 슬래시 명령을 스캔 — 매 호출마다 최신. */
    listCommands: () => Promise<RuntimeCommand[]>;
    /** 런타임의 모델 목록을 실시간 조회 — BYOK는 provider /models API, ollama는 동적, CLI는 카탈로그.
     *  하드코딩 대신 실제 소스에서 가져와 자동 동기화 (5분 캐시). */
    listModels: (sel: {
      kind: RuntimeKind;
      backend?: RuntimeBackend | null;
      availableModels?: string[] | null;
    }) => Promise<Array<{ id: string; label: string; tag?: string }>>;
    /** 역할 풀(순서=우선순위) 조회 — 멤버 목록 + 현재 선택/스킵 사유. */
    listRoleMembers: () => Promise<RuntimeRolePoolState>;
    /** 역할 풀 전체 교체. 빈 worker 배열 = 오케스트레이터 풀 상속. */
    setRoleMembers: (
      role: RuntimeRole,
      selections: RuntimeSelection[],
    ) => Promise<RuntimeRolePoolState>;
  };
  agentRuntime: {
    list: () => Promise<AgentRuntimeOverride[]>;
    get: (
      scope: AgentRuntimeOverrideScope,
      targetId: string,
    ) => Promise<AgentRuntimeOverride | null>;
    set: (input: AgentRuntimeOverrideSetInput) => Promise<AgentRuntimeOverride>;
    remove: (scope: AgentRuntimeOverrideScope, targetId: string) => Promise<void>;
  };
  config: {
    getCustomBaseUrl: () => Promise<string>;
    setCustomBaseUrl: (url: string) => Promise<void>;
    getTerminalProfiles: () => Promise<TerminalProfile[]>;
    setTerminalProfiles: (profiles: TerminalProfile[]) => Promise<TerminalProfile[]>;
  };
  secrets: {
    saveApiKey: (backend: RuntimeBackend, key: string) => Promise<void>;
    hasApiKey: (backend: RuntimeBackend) => Promise<boolean>;
    deleteApiKey: (backend: RuntimeBackend) => Promise<void>;
  };
  credentialRecovery: {
    /** Read failure metadata only; never probes the credential backend. */
    list: () => Promise<CredentialRecoveryFailure[]>;
    /** One explicit attempt at the exact Main-issued resource handle. */
    retry: (retryToken: string) => Promise<CredentialRecoveryResult>;
  };
  /** 글로벌 env vault — 에이전트들이 공유하는 외부 API 키.
   *  값은 macOS Keychain에 저장, renderer는 metadata만 받음.
   *  M1: MCP 서버 spawn 시 envRequirements 매칭해 자동 주입. */
  env: {
    /** 모든 env 키 + 등록 여부 + 어떤 에이전트가 요구하는지 */
    list: () => Promise<EnvVarMeta[]>;
    /** 값 저장 (편집도 동일) */
    set: (key: string, value: string) => Promise<void>;
    /** 값 존재 여부만 — 실제 값은 renderer로 안 보냄 */
    has: (key: string) => Promise<boolean>;
    /** 저장된 값의 마스킹 미리보기 (전체 평문 아님). 미저장이면 null. */
    preview: (key: string) => Promise<string | null>;
    remove: (key: string) => Promise<void>;
  };
  /** 멀티모달 전역 fallback — 에이전트/프로젝트 env가 없을 때 이미지·영상·음성 provider를 고른다. */
  /**
   * 실행 완료 알람 — 소리·앱 흔들기(맥 Dock 바운스 / 윈도우·리눅스 작업표시줄 깜빡임).
   * 값은 main 이 소유한다. 렌더러는 부분 패치만 보내고 정규화된 전체 값을 돌려받는다.
   */
  runAlerts: {
    get: () => Promise<RunAlertSettings>;
    set: (patch: Partial<RunAlertSettings>) => Promise<RunAlertSettings>;
    /** 저장값 그대로 한 번 울린다 — 켜 놨는데 안 들리는 상태를 그 자리에서 알 수 있게. */
    preview: () => Promise<RunAlertSettings>;
  };
  multimodal: {
    listProviders: () => Promise<MultimodalProvider[]>;
    getSettings: () => Promise<MultimodalSettings>;
    saveSettings: (settings: Partial<MultimodalSettings>) => Promise<MultimodalSettings>;
    status: () => Promise<MultimodalProviderStatus[]>;
    /** 생성 엔진 — Oberon/T-rex 스튜디오에서 적출(2026-08-21). */
    generateImage: (payload: { model?: "codex" | "gemini" | "auto"; prompt: string }) => Promise<MultimodalImageResult>;
    imageProviders: () => Promise<{ codex: boolean; gemini: boolean }>;
    startVideo: (request: MultimodalVideoRequest) => Promise<MultimodalVideoJob>;
    getVideoJob: (id: string) => Promise<MultimodalVideoJob | null>;
    cancelVideo: (id: string) => Promise<MultimodalVideoJob | null>;
    openVideoOutput: (id: string) => Promise<{ ok: boolean; message: string }>;
    videoKeyStatus: () => Promise<MultimodalVideoKeyStatus>;
  };
  /** Oberon real render bridge — API keys stay in the Electron main process. */
  team: {
    list: () => Promise<InstalledAgent[]>;
    install: (slug: string) => Promise<InstalledAgent>;
    /** 내 에이전트(cargo) 설치 — 로그인 사용자가 agentlas.cloud에서 만든 것 */
    installMine: (id: string) => Promise<InstalledAgent>;
    uninstall: (id: string, options?: InstalledAgentRemovalOptions) => Promise<RosterRemovalResult>;
    /** 삭제 확인 문구용 사전 COUNT — 좌석(빈 자리가 될 곳)·대화(보존될 것) 정확한 수. */
    uninstallPreview: (id: string) => Promise<{ seatCount: number; chatCount: number }>;
    /** NFC 1-80 code-point local alias; empty text clears it. */
    setLocalDisplayName: (id: string, value: string) => Promise<InstalledAgent>;
    /** 로컬 폴더(기존 에이전트/팀)를 임포트 — 런타임 감지·라벨링 후 라우팅 저장. */
    importLocalFolder: (input: { path: string; scope: FsReadScope }) => Promise<InstalledAgent>;
    /** 팀 에이전트의 하위 서브에이전트 해석 — 즉시 결정적 + 백그라운드 LLM 정밀판정/자가교정. */
    resolveSubAgents: (agentId: string) => Promise<AgentTeamResolution | null>;
  };
  /** Durable One Team bindings; execution remains in canonical Work/Automation. */
  oneOrg: {
    get: () => Promise<OneOrgState>;
    createAgent: (input: CreateOneTeamAgentInput) => Promise<CreateOneTeamAgentResult>;
    add: (input: AddOneOrgMemberInput) => Promise<OneOrgState>;
    rename: (input: RenameOneOrgMemberInput) => Promise<OneOrgState>;
    update: (input: UpdateOneOrgMemberInput) => Promise<OneOrgState>;
    replace: (input: ReplaceOneOrgMemberInput) => Promise<OneOrgState>;
    archive: (input: ArchiveOneOrgMemberInput) => Promise<OneOrgState>;
    restore: (input: ArchiveOneOrgMemberInput) => Promise<OneOrgState>;
    markRead: (input: MarkOneOrgMemberReadInput) => Promise<OneOrgState>;
    reorder: (input: ReorderOneOrgMembersInput) => Promise<OneOrgState>;
    setTools: (input: SetOneOrgMemberToolsInput) => Promise<OneOrgState>;
  };
  /** Durable group conversations. One is implicit and always present. */
  oneTaskforces: {
    list: () => Promise<OneTaskforce[]>;
    create: (input: CreateOneTaskforceInput) => Promise<OneTaskforce>;
    update: (input: UpdateOneTaskforceInput) => Promise<OneTaskforce>;
    /** 단톡 "삭제" = 좌석 해체(T7) — 대화는 지워지지 않고 읽기 전용 아카이브로 남는다. */
    remove: (input: RemoveOneTaskforceInput) => Promise<void>;
    /** 해체 확인 문구용 정확한 수 — "대화 N개는 기록으로 남습니다". */
    removePreview: (input: { id: string }) => Promise<{ sessionCount: number }>;
  };
  /** 좌석 1급 조회·조작 — 세션의 좌석(해체 여부·현재 점유자·이력·배정). */
  seats: {
    forChat: (chatId: string) => Promise<OneSeatView | null>;
    /** append-only 점유 이력(닫힌 행 포함) — "그때 누가 있었나" 재구성. */
    historyForChat: (chatId: string) => Promise<OneSeatOccupancy[]>;
    /** 빈 슬롯에 착석(T10). 이미 점유 중이면 거절된다(교체는 조직 화면의 교체 동작). */
    assign: (input: { chatId: string; agentId: string; slot?: number }) => Promise<OneSeatView>;
  };
  /** Opt-in local Computer History summaries and read-only recommendations. */
  computerHistory: {
    get: () => Promise<ComputerHistoryState>;
    setConsent: (enabled: boolean) => Promise<ComputerHistoryState>;
    clear: () => Promise<ComputerHistoryState>;
    /** Explicit review handoff; the passive history list remains path-free. */
    prepareDraft: (recommendationId: string, locale: "ko" | "en") => Promise<ComputerHistoryDraftPrompt>;
  };
  /** 에이전트 폴더 파일 — 라이브러리 우측 패널의 파일 목록 + 에디터.
   *  폴더(userData/agents/<slug>/) 내부로만 접근 제한. system-prompt.md 편집은 즉시 적용. */
  agentFiles: {
    /** 폴더를 보장(materialize)하고 최상위 엔트리를 반환 */
    list: (agentId: string) => Promise<DirListing>;
    /** 폴더 내부 파일 본문 읽기 */
    read: (agentId: string, absPath: string) => Promise<TextFilePreview>;
    /** 폴더 내부 파일 저장 (system-prompt.md면 동작 프롬프트도 갱신) */
    write: (agentId: string, absPath: string, content: string) => Promise<{ ok: boolean }>;
    /** Main-owned canonical runtime prompt source for this package. */
    promptSource: (agentId: string) => Promise<AgentFileTextSnapshotUi | null>;
  };
  /** 스킬 카탈로그 — 엔진(Hephaestus)의 skills/ 디렉토리를 실제로 스캔해 반환한다.
   *  하드코딩 목록이 아니라 디스크의 SKILL.md 프론트매터에서 읽는다. */
  /** 엔진 텍스트 자산(스킬·호스트 훅·어댑터 매니페스트) 직접 편집. */
  runtimeFiles: {
    list: () => Promise<{
      root: string | null;
      /** 이 폴더는 엔진 업데이트가 다시 쓴다 — 편집은 그때 사라질 수 있다. */
      overwrittenByUpdate: true;
      entries: Array<{ relPath: string; size: number; group: string }>;
    }>;
    read: (relPath: string) => Promise<{ relPath: string; content: string; size: number }>;
    write: (relPath: string, content: string) => Promise<{ ok: true; size: number }>;
  };
  skills: {
    /** 주입 가능한 스킬 카탈로그 (엔진 skills/ 디렉토리 실측) */
    listCatalog: () => Promise<SkillCatalogEntry[]>;
    /** allowlisted catalog slug의 실제 SKILL.md 원문과 sha256. */
    readCatalog: (slug: string) => Promise<SkillCatalogAsset>;
  };
  /** 외부 MCP 툴 플러그인 — Slack/Discord/GitHub 등을 실제로 연결한다.
   *  env 값은 글로벌 vault(env)에서 가져와 stdio 자식 프로세스에 주입. */
  mcpTools: {
    /** 연결 가능한 외부 툴 카탈로그 (setting_guide) */
    listCatalog: () => Promise<McpToolCatalogEntry[]>;
    /** 정규화된 slug -> 허브 브랜드 자산(로고). 웹 카탈로그의 거울. */
    brandMap: () => Promise<Record<string, PluginBrandAsset>>;
    /** 설치/구성된 서버 목록 */
    listInstalled: () => Promise<InstalledMcpServer[]>;
    /** 카탈로그 id로 설치 (env 요구는 vault에 자동 등록) */
    install: (catalogId: string) => Promise<InstalledMcpServer>;
    /** 커스텀 서버 직접 등록 */
    installCustom: (def: {
      name: string;
      transport: McpTransport;
      command?: string;
      args?: string[];
      url?: string;
      envKeys?: string[];
    }) => Promise<InstalledMcpServer>;
    remove: (id: string) => Promise<void>;
    setEnabled: (id: string, enabled: boolean) => Promise<InstalledMcpServer>;
    /**
     * Hub 플러그인의 연결 정보를 **설치하지 않고** 읽는다. 승인 시트가 "이 명령이 이
     * 기계에서 실행됩니다"를 보여주려면 설치 전에 읽을 수 있어야 한다.
     */
    previewHubPlugin: (manifestUrl: string) => Promise<{
      rows: Array<{
        name: string;
        transport: "http" | "sse" | "stdio";
        url?: string;
        command?: string;
        args?: string[];
        envKeys?: string[];
      }>;
      /** stdio 행이 하나라도 있으면 참 — 로컬 프로세스 실행 승인이 필요하다. */
      needsLocalExecution: boolean;
      alreadyInstalledIds: string[];
    }>;
    /**
     * 사용자가 승인 시트에서 직접 누른 Hub 플러그인을 설치한다.
     * `approveLocalExecution`이 거짓이면 stdio 행은 비활성으로 남는다 — 이 호출은
     * 승인을 만들어내지 않는다.
     */
    installHubPlugin: (input: {
      slug: string;
      manifestUrl: string;
      approveLocalExecution?: boolean;
    }) => Promise<{
      receipts: Array<{
        slug: string;
        serverName: string;
        transport: string;
        action: "connected" | "already-installed" | "needs-approval" | "skipped";
        reason?: string;
        serverId?: string;
      }>;
      liveServerIds: string[];
    }>;
    /**
     * 자동 브리지가 등록해 두고 승인을 기다리는 stdio 서버 목록.
     * 실행 중 채팅에 지나가는 영수증과 달리 영구 상태에서 읽으므로, 대화를 새로 열어도
     * 같은 답이 나온다.
     */
    pendingHubApprovals: () => Promise<Array<{
      serverId: string;
      slug: string;
      serverName: string;
      command: string | null;
      args: string[];
      envKeys: string[];
    }>>;
    /**
     * 이 원격 서버가 로그인(OAuth)을 요구하는가, 그리고 이미 연결됐는가.
     * 읽기만 한다 — 부작용 없이 화면이 상태를 말할 수 있게 하는 용도다.
     */
    oauthStatus: (serverId: string) => Promise<
      | { supported: true; connected: boolean; resource?: string; expiresAt?: number | null }
      | { supported: false; connected: false; reason: string; message?: string }
    >;
    /**
     * 인가 흐름을 돌린다. 동의 창은 Agentlas 전용 Chrome(브라우저 자격증명 프로필)에서
     * 열리므로, 이미 그 서비스에 로그인해 둔 사용자는 동의만 누르면 끝난다.
     * Chrome을 못 열었으면 `manualUrl` 로 사람이 직접 열 주소를 돌려준다.
     */
    oauthConnect: (serverId: string) => Promise<
      { ok: true; manualUrl: string | null } | { ok: false; error: string }
    >;
    /** 저장된 토큰과 세션을 지운다. */
    oauthDisconnect: (serverId: string) => Promise<{ ok: true }>;
    /** 실제로 붙어서 tools/list 해보고 상태 반환 */
    test: (id: string) => Promise<McpServerStatus>;
    /** 활성화된 모든 서버 상태 (env 부족분 포함) */
    status: () => Promise<McpServerStatus[]>;
    /** Build 시작 전 읽기 전용 추천. 설치·연결 테스트·외부 호출을 하지 않는다. */
    recommendForBuild: (input: McpBuildRecommendationInput) => Promise<McpBuildPlan>;
    /** 실행 전 키 요청 시트의 완료 신호. 비밀 값은 절대 싣지 않는다 — 값은 env.set으로
     *  이미 vault에 저장된 뒤다. 만료/중복 runId면 { ok:false } 안전 무시. */
    supplyRunKeys: (runId: string, outcome: "provided" | "declined") => Promise<{ ok: boolean }>;
  };
  /** Optional ontology context. Endpoint and returned context remain in Electron main. */
  openCrab: {
    readiness: () => Promise<OpenCrabReadiness>;
  };
  marketplace: {
    listBundles: () => Promise<TeamBundle[]>;
    search: (q: string) => Promise<MarketplaceListing[]>;
    listFirms: () => Promise<FirmListing[]>;
    status: (force?: boolean) => Promise<MarketplaceSourceStatus>;
    /** 로그인 사용자의 실제 복원 가능한 Agent Cloud 패키지 목록. 미로그인/오프라인이면 [] */
    listMine: () => Promise<MarketplaceListing[]>;
    deleteMine: (slug: string) => Promise<CloudAgentDeleteResult>;
    bookmarks: () => Promise<HubAgentBookmark[]>;
    /**
     * 허브 소개 페이지(agentlas.cloud/p/<slug>)를 앱 안에 그대로 띄운다.
     * 원격 페이지이므로 preload도 IPC도 붙지 않는다 — 읽기 전용 소개 전용 경로다.
     * bounds는 렌더러 좌표(윈도 콘텐츠 기준 CSS px).
     */
    openProfileView: (input: {
      slug: string;
      bounds: { x: number; y: number; width: number; height: number };
      locale?: "ko" | "en";
    }) => Promise<{ ok: boolean; url?: string; reason?: string }>;
    setProfileViewBounds: (
      bounds: { x: number; y: number; width: number; height: number },
    ) => Promise<{ ok: boolean }>;
    closeProfileView: () => Promise<{ ok: true }>;
    /** 임베드가 소개 페이지 밖으로 나가려 할 때 — 데스크탑 화면이 대신 처리한다. */
    onProfileViewExit: (handler: () => void) => () => void;
    /** Web account snapshot + local outbox reconciliation. No polling; callers trigger lifecycle sync. */
    syncBookmarks: () => Promise<HubAgentBookmark[]>;
    /** Main-owned full snapshot broadcast after local mutation or account sync. */
    onBookmarksSnapshot: (handler: (event: HubBookmarkSnapshotEvent) => void) => () => void;
    bookmarkAdd: (listing: MarketplaceListing) => Promise<HubAgentBookmark>;
    bookmarkRemove: (slug: string, entityKind?: string) => Promise<void>;
  };
  /** Store owned packages privately in Agent Cloud or explicitly publish them to the public Hub. */
  cloudAgents: {
    listRegisteredUploadOptions: () => Promise<CloudAgentRegisteredUploadOption[]>;
    saveRegisteredPrivate: (input: CloudAgentRegisteredSaveRequest) => Promise<CloudAgentPackageResult>;
    publishRegisteredPublic: (input: CloudAgentRegisteredPublishRequest) => Promise<CloudAgentPackageResult>;
    savePrivate: (input: CloudAgentPrivateSaveRequest) => Promise<CloudAgentPackageResult>;
    saveBuiltPrivate: (input: CloudAgentBuiltPrivateSaveRequest) => Promise<CloudAgentPackageResult>;
    publishPublic: (input: CloudAgentHubPublishRequest) => Promise<CloudAgentPackageResult>;
    /** Compatibility surface. Omitted visibility now means private-link; marketplace remains an explicit flag. */
    publish: (input: CloudAgentPublishRequest) => Promise<CloudAgentPackageResult>;
    /** Live upload phases for the in-flight `progressId`. Returns an unsubscribe. */
    onProgress: (handler: (event: CloudAgentPublishProgressEvent) => void) => () => void;
    /**
     * What a published agent charges, keyed by slug.
     *
     * Slug rather than a definition id because the registration receipt has
     * never carried one — pricing on the server resolves the slug against this
     * account's own listings, so this is one call rather than resolve-then-price.
     */
    readPrices: (slug: string) => Promise<CloudAgentPricesRead>;
    setPrices: (input: { slug: string; patch: CloudAgentPricePatch }) => Promise<CloudAgentSetPricesResult>;
  };
  firms: {
    list: () => Promise<InstalledFirm[]>;
    get: (id: string) => Promise<InstalledFirm | null>;
    install: (slug: string) => Promise<InstalledFirm>;
    uninstall: (id: string, options?: InstalledFirmRemovalOptions) => Promise<RosterRemovalResult>;
    /** 정규화된 3-tier 조직 스펙 (저장된 리졸버 결과 또는 orgChart 파생) */
    getResolvedOrg: (id: string) => Promise<ResolvedOrg | null>;
    /** LLM으로 팀 폴더를 분석해 3-tier 조직 스펙 생성 (임포트 팀용) */
    resolveOrg: (id: string) => Promise<{ ok: boolean; org?: ResolvedOrg; error?: string }>;
  };
  telegram: {
    listBindings: () => Promise<TelegramConnectBinding[]>;
    /**
     * One 연결. 기본은 멱등이다 — 이미 방까지 붙은 연결이 있으면 그 바인딩을 돌려준다.
     * `newConnection: true` 면 봇을 하나 더 만든다. One 은 **방마다 하나**라서(v101)
     * 봇이 늘면 텔레그램에서 나란히 열 수 있는 대화가 그만큼 늘어난다.
     */
    connectOne: (input?: { botName?: string; newConnection?: boolean }) => Promise<TelegramConnectActionResult>;
    /** agent/firm 레거시 연결 일괄 제거. deleteBots 는 옵트인. */
    removeLegacy: (input: { deleteBots: boolean }) => Promise<TelegramLegacyCleanupResult>;
    autoConnect: (input: TelegramConnectAutoInput) => Promise<TelegramConnectActionResult>;
    start: (input: TelegramConnectStartInput) => Promise<TelegramConnectActionResult>;
    clone: (input: TelegramConnectCloneInput) => Promise<TelegramConnectActionResult>;
    /** Explicit one-time transfer from Terminal's private token file into Desktop Keychain. */
    importTerminal: (id: string) => Promise<TelegramConnectActionResult>;
    resume: (id: string) => Promise<TelegramConnectBinding>;
    stop: (id: string) => Promise<TelegramConnectBinding>;
    remove: (id: string, deleteBot?: boolean) => Promise<{ botDeleted: boolean }>;
    resetConversation: (id: string) => Promise<TelegramConnectBinding>;
    sendTest: (id: string) => Promise<TelegramConnectActionResult>;
    openBot: (id: string) => Promise<{ ok: boolean; message: string }>;
    configureBotSettings: (id: string) => Promise<{ ok: boolean; message: string }>;
    pruneOrphans: () => Promise<{ removed: number }>;
  };
  browser: {
    status: () => Promise<BrowserStatus>;
    listSites: () => Promise<BrowserSite[]>;
    saveSite: (input: BrowserSiteInput) => Promise<BrowserSite>;
    deleteSite: (site: string) => Promise<{ ok: true }>;
    openLogin: (site: string) => Promise<{ ok: boolean; error?: string }>;
    markSession: (site: string, status: BrowserSessionStatus) => Promise<{ ok: boolean; error?: string }>;
    /** 평소 브라우저 프로필 목록과, profileId 를 주면 그 프로필에 로그인된 도메인 목록. */
    scanCredentials: (profileId?: string | null) => Promise<BrowserCredentialScanResult>;
    /** 고른 도메인의 세션만 전용 프로필로 가져오고 Connect 목록에 등록한다. */
    importCredentials: (profileId: string, domains: string[]) => Promise<BrowserCredentialImportResult>;
    /** 지금 승인 상태와, 아직 승인이 없다면 물어볼 만한 로그인이 몇 개인지. */
    credentialConsent: () => Promise<
      { consent: BrowserCredentialConsent; pending: boolean; profileId: string | null; count: number }
    >;
    revokeCredentialConsent: () => Promise<BrowserCredentialConsent>;
    /** 주기를 기다리지 않고 지금 갱신 — 자동 갱신과 같은 경로. */
    refreshCredentials: () => Promise<BrowserCredentialConsent>;
    listPermissions: () => Promise<BrowserPermissionEntry[]>;
    revokePermission: (site: string, actionType: string) => Promise<{ ok: true }>;
    resolveApproval: (requestId: string, decision: BrowserApprovalDecision) => Promise<{ ok: boolean }>;
    listLogs: (limit?: number) => Promise<BrowserActionLog[]>;
    /** Capture the current task's already-open page when supplied; never navigates. */
    captureLiveFrame: (preferredUrl?: string, viewport?: BrowserLiveViewport) => Promise<BrowserLiveFrame>;
    /** Main resolves this task's observed browser source from durable tool receipts. */
    captureTaskFrame: (chatId: string) => Promise<BrowserLiveFrame>;
    /** Start a persistent, task-scoped CDP screencast. It never selects an unrelated tab. */
    startLiveView: (preferredUrl: string, viewport?: BrowserLiveViewport) => Promise<BrowserLiveSessionResult>;
    stopLiveView: (sessionId: string) => Promise<{ ok: boolean }>;
    dispatchLiveInput: (input: BrowserLiveInput) => Promise<BrowserLiveDispatchResult>;
    onLiveFrame: (handler: (frame: BrowserLiveStreamFrame) => void) => () => void;
    focusLiveTarget: (targetId?: string) => Promise<{ ok: boolean }>;
  };
  computerUse: {
    capturePreview: (sourceId?: string, options?: ComputerUseCaptureOptions) => Promise<ComputerUsePreview>;
    revealPreview: () => Promise<{ ok: boolean }>;
  };
  projects: {
    list: () => Promise<Project[]>;
    /** Create (or reuse) the project for a folder already persisted by Main for this chat. */
    createFromWorkspace: (input: {
      chatId: string;
      name: string;
      agentPool?: ProjectAgentPoolMember[];
    }) => Promise<Project>;
    create: (input: {
      name: string;
      systemPrompt?: string | null;
      agentPool?: ProjectAgentPoolMember[];
      sourceType: ProjectSourceType;
      sourceRef?: string | null;
      folderGrant?: FsPathGrant | null;
    }) => Promise<Project>;
    get: (id: string) => Promise<Project | null>;
    timeline: (id: string, limit?: number) => Promise<ProjectTimelineSnapshot>;
    update: (
      id: string,
      patch: Partial<Pick<Project, "name" | "systemPrompt" | "agentPool" | "sourceType" | "sourceRef">> & { folderGrant?: FsPathGrant | null },
    ) => Promise<Project>;
    remove: (id: string) => Promise<void>;
    connectGithub: (repositoryUrl: string) => Promise<ProjectSourceConnectResult>;
    /** Hub slugs this project may auto-hire per work order without a per-send notice. */
    listRentAllowed: (projectId: string) => Promise<string[]>;
    /** Returns the updated allowed-slug list for the project. */
    setRentAllowed: (input: { projectId: string; slug: string; allowed: boolean }) => Promise<string[]>;
  };
  agentLeases: {
    quote: (slug: string) => Promise<AgentLeaseQuote>;
    purchase: (input: { slug: string; days: number; idempotencyKey?: string }) => Promise<AgentLeasePurchaseResult>;
    /** Cached (~60s) list of this account's leases; active ones call at 0 credits. */
    list: () => Promise<AgentLeaseRow[]>;
  };
  ontology: {
    getProject: (projectId: string) => Promise<OntologyProjectStatus>;
    provision: (projectId: string) => Promise<OntologyProjectStatus>;
    sync: (projectId: string) => Promise<OntologyProjectStatus>;
    addSource: (
      projectId: string,
      absPath: string,
      scope: OntologySourceScope,
      kind: OntologySourceKind,
    ) => Promise<OntologyProjectStatus>;
    openInbox: (projectId: string) => Promise<{ ok: boolean; path: string | null; message: string }>;
  };
  chats: {
    /** 최신순 활성 채팅 (보관된 것 제외). 사이드바 "최근 채팅" 섹션에서 사용 */
    listRecent: (limit?: number) => Promise<Chat[]>;
    /** One 홈 전용 — 전체 최근 목록을 잘라 쓰면 Work 대화가 One 대화를 밀어낸다. */
    listRecentOne: (limit?: number) => Promise<Chat[]>;
    /** 보관된 채팅 — 보관함 페이지용 */
    listArchived: () => Promise<Chat[]>;
    listByProject: (projectId: string) => Promise<Chat[]>;
    listByFirm: (firmId: string) => Promise<Chat[]>;
    get: (id: string) => Promise<Chat | null>;
    /** firmId가 있으면 firm의 CEO 에이전트로 자동 묶임. agentId 직접 지정도 가능 (개별 에이전트) */
    create: (input: {
      agentId?: string;
      firmId?: string | null;
      projectId?: string | null;
      title?: string;
      /** 새 컨텍스트지만 기존 채팅의 main-owned 작업 폴더를 이어받는다. */
      continueFromChatId?: string | null;
      /** Keep a One general conversation Task-free until runtime promotion. */
      taskMode?: "task" | "conversation";
      /** 'one'이면 One 홈 전용 대화 — Work 사이드바에 나타나지 않는다. */
      originSurface?: "one" | "work";
    }) => Promise<Chat>;
    /** Persist a local conversation-first command such as `@graph` without starting an LLM turn. */
    appendOneUserMessage: (id: string, text: string) => Promise<ChatHistoryEntry>;
    /** Open the durable direct conversation owned by one standing One teammate. */
    openOneMember: (input: { agentId: string; title: string }) => Promise<Chat>;
    rename: (id: string, title: string) => Promise<Chat>;
    /** 보관 — 사이드바에서 숨김. 채팅·메시지는 그대로 유지 */
    archive: (id: string) => Promise<Chat>;
    /** 보관 해제 — 다시 사이드바에 등장 */
    unarchive: (id: string) => Promise<Chat>;
    /** 영구 삭제 — 메시지까지 cascade */
    remove: (id: string) => Promise<void>;
    /** "계속 라이브로" 모드 — 켜두면 Stormbreaker 연속실행이 짧은 상한에 닿아도 이 채팅에서
     *  라이브 스트리밍을 계속 이어간다(수 시간 단위). */
    setContinuousMode: (id: string, enabled: boolean) => Promise<Chat>;
    /** 목표 추진 on/off — 켜면 goal 원장에 목표를 만들고 chat에 goal_id를 바인딩하며
     *  continuousMode를 함께 켠다. 끄기(칩 ×)는 단순 off가 아니라 명시적 목표 종료다. */
    setGoalMode: (id: string, enabled: boolean) => Promise<Chat>;
    /** 현재 goal 원장의 불변 objective/성공 기준. 아직 첫 Goal 요청 전이면 null. */
    getGoalContext: (id: string) => Promise<ChatGoalContext | null>;
    /** 첫 Goal 요청으로만 goal 계약을 정의한다. 활성 goal은 후속 채팅/steering으로 덮어쓰지 않는다. */
    defineGoal: (id: string, objective: string, locale?: "ko" | "en") => Promise<ChatGoalContext | null>;
    /** Stop execution and automatic continuation while retaining this exact goal. */
    pauseGoal: (id: string, goalId: string) => Promise<ChatGoalContext | null>;
    /** Detach this exact goal; retain chat, files and audit history. */
    deleteGoal: (id: string, goalId: string) => Promise<Chat>;
    /** Explicit resume; uncertain interrupted effects remain blocked. */
    resumeGoal: (id: string, expectedVersion: number, expectedGoalId: string) => Promise<ChatGoalContext | null>;
    /** 스웜 모드 on/off — 여러 워커가 목표를 분해해 병렬 협업. */
    setSwarmMode: (id: string, enabled: boolean) => Promise<Chat>;
    /** Set or clear this chat's exact orchestrator runtime without changing role defaults. */
    setRuntimeSelection: (
      id: string,
      selection: RuntimeSelection | null,
    ) => Promise<Chat>;
    /** 세션 recap — 자리를 비운 사이 도착한 에이전트 응답 한 줄 요약(없으면 null). */
    recap: (id: string) => Promise<{ summary: string; count: number; sinceIso: string } | null>;
    /** 이 채팅을 방금 봤다고 기록(recap 기준점 갱신). */
    markViewed: (id: string) => Promise<void>;
  };
  externalCliSessions: {
    list: (input: { projectId: string; query?: string; limit?: number }) => Promise<ExternalCliSessionSummary[]>;
    importToProject: (input: ExternalCliSessionImportInput) => Promise<CanonicalTaskWorkTarget>;
  };
  /** One/Work/Mobile의 공통 정본. Chat은 이 Task의 대화 투영이다. */
  tasks: {
    /** Create a Work task only inside an existing project and its explicit agent pool. */
    createProject: (input: { projectId: string; title?: string }) => Promise<CanonicalTaskWorkTarget>;
    list: (input?: { projectId?: string; limit?: number; includeArchived?: boolean; reconcile?: boolean }) => Promise<CanonicalTask[]>;
    get: (id: string) => Promise<CanonicalTask | null>;
    /** Main-owned semantic projection. Renderer input can choose a surface, never authority. */
    listProjections: (input: OneTaskProjectionListRequest) => Promise<AgentlasOneTaskProjectionV1[]>;
    getProjection: (id: string, input: OneTaskProjectionRequest) => Promise<AgentlasOneTaskProjectionV1 | null>;
    /** Read-only lookup. Unlike forChat, this never promotes a conversation. */
    findForChat: (chatId: string) => Promise<CanonicalTask | null>;
    forChat: (chatId: string) => Promise<CanonicalTask | null>;
    /** Explicit user acceptance; Main verifies Task version and completed run receipt. */
    acceptResult: (input: CanonicalTaskResultAcceptance) => Promise<CanonicalTask>;
    /** Start separate follow-up work with only a bounded Main-owned result summary. */
    continueFromResult: (input: CanonicalTaskResultContinuation) => Promise<Chat>;
    /**
     * Resolve where this Task actually lives in Work. Main verifies the Task and
     * that its conversation still exists, so the renderer navigates to a
     * confirmed target instead of a URL built from a possibly-stale projection.
     * Returns null when the Task or its conversation is gone.
     */
    openInWork: (taskId: string) => Promise<CanonicalTaskWorkTarget | null>;
  };
  /** Main-owned full-history search and atomic Task/conversation re-entry controls. */
  oneSearch: {
    search: (input: OneSearchRequestV1) => Promise<OneSearchPageV1>;
    mutateArchive: (input: OneTaskArchiveMutationInputV1) => Promise<OneTaskArchiveMutationResultV1>;
  };
  /** Desktop One file preparation. Grants enter Main once; returned refs contain no path. */
  oneAttachments: {
    prepare: (input: PrepareOneAttachmentsInput) => Promise<PreparedOneAttachments>;
    bindToTeam: (input: BindOneAttachmentsToTeamInput) => Promise<PreparedOneAttachments>;
    forTeam: (proposalId: string) => Promise<PreparedOneAttachments | null>;
    discard: (input: DiscardOneAttachmentsInput) => Promise<{ discarded: boolean }>;
  };
  /** Desktop-only opaque previews for exact Main-bound One result artifacts. */
  oneArtifacts: {
    issuePreview: (input: OneArtifactBindingRequestV1) => Promise<OneArtifactPreviewCapabilityV1 | null>;
    revokePreview: (input: OneArtifactPreviewRevokeV1) => Promise<{ revoked: boolean }>;
  };
  /** Persistent One identity and user-approved operating principles. */
  oneProfile: {
    get: () => Promise<OneProfile>;
    update: (input: OneProfileUpdateInput) => Promise<OneProfile>;
    /** One 자신의 초상(생성·업로드 이미지)을 저장하고 프로필이 그것을 가리키게 한다. */
    setAvatarImage: (input: { dataUrl: string; expectedVersion: number }) => Promise<OneProfile>;
    addPrinciple: (input: OneOperatingPrincipleCreateInput) => Promise<OneProfile>;
    updatePrinciple: (input: OneOperatingPrincipleUpdateInput) => Promise<OneProfile>;
    setPrincipleEnabled: (input: OneOperatingPrincipleEnabledInput) => Promise<OneProfile>;
    deletePrinciple: (input: OneOperatingPrincipleDeleteInput) => Promise<OneProfile>;
  };
  /** Version-gated feature introduction bound to Main's persistent One identity. */
  oneFeatureIntro: {
    getState: () => Promise<OneFeatureIntroState>;
    acknowledge: (input: AcknowledgeOneFeatureIntroInput) => Promise<OneFeatureIntroState>;
    defer: (input: DeferOneFeatureIntroInput) => Promise<OneFeatureIntroState>;
  };
  /** Main-owned Desktop-first activation; renderer never owns completion. */
  oneActivation: {
    getState: (input: GetOneActivationStateInput) => Promise<OneActivationState>;
    resolveConcern: (input: ResolveOneActivationConcernInput) => Promise<OneActivationState>;
    resolveWork: (input: ResolveOneActivationWorkInput) => Promise<OneActivationState>;
    skip: (input: SkipOneActivationInput) => Promise<OneActivationState>;
    resolveMobile: (input: ResolveOneActivationMobileInput) => Promise<OneActivationState>;
  };
  /** Editable Memory candidates and explicitly approved reusable Memory assets. */
  oneMemory: {
    getState: () => Promise<OneMemoryState>;
    getMap: () => Promise<OneMemoryMapSnapshot>;
    /**
     * What One actually remembers — the durable memory_entries the memory map is
     * drawn from (same rows, same count), bounded and path-free. The sheet lists
     * these so "기억" and the map never disagree (owner report 2026-08-16).
     */
    listEntries: (input?: { limit?: number }) => Promise<OneDurableMemoryEntryUi[]>;
    /** Supersede one durable entry (non-destructive; the map drops it). */
    forgetEntry: (input: { memoryId: string }) => Promise<{ ok: boolean; memoryId: string; forgottenAt: string | null }>;
    propose: (input: ProposeOneMemoryCandidateInput) => Promise<OneMemoryMutationResult<OneMemoryCandidate>>;
    save: (input: SaveOneMemoryCandidateInput) => Promise<OneMemoryMutationResult<OneMemorySavedResult>>;
    editAndSave: (input: EditAndSaveOneMemoryCandidateInput) => Promise<OneMemoryMutationResult<OneMemorySavedResult>>;
    useOnce: (input: UseOneMemoryCandidateOnceInput) => Promise<OneMemoryMutationResult<OneMemoryUseOnceReceipt>>;
    reject: (input: RejectOneMemoryCandidateInput) => Promise<OneMemoryMutationResult<OneMemoryCandidate>>;
    deleteCandidate: (input: DeleteOneMemoryCandidateInput) => Promise<OneMemoryMutationResult<{ candidateId: string; deletedAt: string }>>;
    updateAsset: (input: UpdateOneMemoryAssetInput) => Promise<OneMemoryMutationResult<OneMemoryAsset>>;
    setAssetEnabled: (input: SetOneMemoryAssetEnabledInput) => Promise<OneMemoryMutationResult<OneMemoryAsset>>;
    deleteAsset: (input: DeleteOneMemoryAssetInput) => Promise<OneMemoryMutationResult<{ memoryId: string; deletedAt: string }>>;
  };
  /** Evidence-gated ecosystem suggestions. Renderer actions create review drafts only. */
  oneSuggestions: {
    getState: () => Promise<OneSuggestionState>;
    acceptForReview: (input: AcceptOneSuggestionForReviewInput) => Promise<OneSuggestionMutationResult<OneSuggestionReviewRequest>>;
    getReviewHandoff: (input: OneSuggestionReviewHandoffInput) => Promise<OneSuggestionReviewHandoff>;
    getReviewSeed: (input: OneSuggestionReviewHandoffInput) => Promise<OneSuggestionReviewSeed>;
    snooze: (input: SnoozeOneSuggestionInput) => Promise<OneSuggestionMutationResult<OneEcosystemSuggestion>>;
    dismiss: (input: DismissOneSuggestionInput) => Promise<OneSuggestionMutationResult<OneEcosystemSuggestion>>;
    neverAsk: (input: NeverAskOneSuggestionInput) => Promise<OneSuggestionMutationResult<OneEcosystemSuggestion>>;
  };
  /** Local-only sanitized public derivative. This surface has no publish operation. */
  oneHubDerivative: {
    getDraft: (input: GetOneHubDerivativeDraftInput) => Promise<OneHubDerivativeDraft>;
  };
  /** Trusted Outcome read projection. Creation remains Main-only. */
  oneValueClosure: {
    getState: () => Promise<OneValueClosureState>;
    latestForTask: (taskId: string) => Promise<OneValueClosureRecord | null>;
    setReflection: (input: SetOneValueClosureReflectionInput) => Promise<OneValueClosureMutationResult<OneValueClosureRecord>>;
  };
  /**
   * Main-owned judgment on a run that did not finish: may One route around the
   * obstacle itself, or must it involve the person? Read-only — deciding does
   * not start anything.
   */
  oneAutoRecovery: {
    judge: (input: {
      runId: string;
      chatId: string;
      goal: string;
      attemptsSpent: number;
      previousFingerprint?: string | null;
    }) => Promise<OneAutoRecoveryJudgement | null>;
    verify: (input: {
      originalRunId: string;
      recoveryRunId: string;
      chatId: string;
      goal: string;
      attemptsSpent: number;
    }) => Promise<OneAutoRecoveryVerification | null>;
  };
  /** Optional current-week reflection derived only from explicitly included, verified Value Closures. */
  oneWeeklyReflection: {
    get: () => Promise<OneWeeklyReflectionSnapshotV1>;
    resolve: (input: ResolveOneWeeklyReflectionInputV1) => Promise<OneWeeklyReflectionSnapshotV1>;
  };
  /** Read-only receipt that approved experience was reused. Creation remains Main-only. */
  oneExperienceReuse: {
    getState: () => Promise<OneExperienceReuseState>;
    latestForTask: (taskId: string) => Promise<OneExperienceReuseRecord | null>;
  };
  /** Read-only, receipt-backed evidence of reuse. Trusted creation remains Main-only. */
  oneImprovementProof: {
    /** Main-only evidence bodies are intentionally omitted from this read model. */
    getState: () => Promise<OneImprovementProofReadState>;
    list: (input?: { taskId?: string }) => Promise<OneImprovementProofRecord[]>;
    latestForTask: (taskId: string) => Promise<OneImprovementProofRecord | null>;
  };
  /** Evidence-gated proactive findings. Main owns detection, suppression, and cadence. */
  oneBriefing: {
    get: () => Promise<OneBriefingSnapshot>;
    /** First click: prepare a review receipt only. Never creates a chat, Task, or run. */
    prepareAction: (input: PrepareOneBriefingActionInput) => Promise<OneBriefingActionPacket>;
    getAction: (input: PrepareOneBriefingActionInput) => Promise<OneBriefingActionPacket | null>;
    /** Second explicit click: exact revalidation, one canonical Task, then a read-only run. */
    startAction: (input: StartOneBriefingActionInput) => Promise<OneBriefingActionStartResult>;
    /** Exact Main-revalidated read-only navigation. Never starts or mutates a Task. */
    openTask: (input: OpenOneBriefingTaskInput) => Promise<OpenOneBriefingTaskResult>;
    setPreferences: (input: {
      cadence?: OneBriefingPreferences["cadence"];
      channels?: OneBriefingChannel[];
      quietHours?: OneBriefingPreferences["quietHours"];
    }) => Promise<OneBriefingPreferences>;
    feedback: (input: {
      candidateId: string;
      expectedDetectedAt: string;
      feedback: OneBriefingFeedback;
    }) => Promise<OneBriefingSnapshot>;
  };
  /** Main-owned semantic decision used before a new One conversation starts. */
  oneRequestIntent: {
    resolve: (prompt: string) => Promise<{
      intent: "conversation" | "task" | "undecided";
      source: "llm" | "unavailable";
    }>;
  };
  /** Read-only adaptive-team proposal plus explicit, exact resolution. */
  oneTeamPreflight: {
    prepare: (input: PrepareOneTeamPreflightInput) => Promise<PrepareOneTeamPreflightResult>;
    getForChat: (chatId: string) => Promise<OneTeamPreflightProposal | null>;
    autoResolve: (input: AutoResolveOneTeamPreflightInput) => Promise<ResolveOneTeamPreflightResult>;
    resolve: (input: ResolveOneTeamPreflightInput) => Promise<ResolveOneTeamPreflightResult>;
    /** Persist a user's acknowledgement of an expired/cancelled proposal. */
    acknowledge: (input: AcknowledgeOneTeamPreflightInput) => Promise<AcknowledgeOneTeamPreflightResult>;
    /** Fail-close a reservation whose renderer-to-Main start handoff was rejected. */
    failStart: (ref: OneTeamPreflightRef) => Promise<OneTeamPreflightProposal | null>;
  };
  /** 고용(빌림) 로스터 — 사이드바 "고용 중" 섹션. 리스 캐시+기억 둥지 기반 읽기 전용. */
  /** 시스템/하드웨어 설정 — 에이전트 동시성(스웜 크기) 슬라이더 등. */
  system: {
    concurrencyInfo: () => Promise<AgentConcurrencyInfo>;
    setConcurrency: (value: number) => Promise<AgentConcurrencyInfo>;
  };
  automations: {
    list: () => Promise<Automation[]>;
    get: (id: string) => Promise<Automation | null>;
    create: (input: AutomationCreateInput) => Promise<Automation>;
    toggle: (id: string, enabled: boolean) => Promise<Automation>;
    remove: (id: string) => Promise<void>;
    /** 기존 자동화의 이름/스케줄/타깃/프롬프트/트리거를 갱신(삭제-재생성 회피, 설계 한계 #7). */
    update: (id: string, patch: AutomationUpdatePatch) => Promise<Automation>;
    updateGraph: (id: string, graph: WorkflowGraph | null) => Promise<Automation>;
    /** 이 실행본(프로세스) 기준의 화면 조작 권한 상태 — 설치본과 개발 실행은 별개 앱이다. */
    computerUsePermissions: () => Promise<{ ok: boolean; missing: string[] }>;
    /** macOS 손쉬운 사용 설정 화면을 바로 연다 — 경로 문장은 모르는 사람에게 없는 것과 같다. */
    openAccessibilitySettings: () => Promise<void>;
    /** 그래프를 Hub에 올린다(공개 자산이 된다). */
    publishGraph: (id: string, opts?: { version?: string }) => Promise<
      { ok: true; slug: string; version: string; url?: string } | { ok: false; reason: string }
    >;
    /** 올려둔 그래프를 받아 자동화로 설치한다 — 꺼진 채로 들어온다. */
    installGraphFromHub: (slug: string, opts?: { name?: string }) => Promise<
      { ok: true; id: string; name: string } | { ok: false; reason: string }
    >;
    /** 저장할 때마다 남는 직전 판(최신 순). 되돌리기의 목록. */
    listGraphVersions: (id: string) => Promise<Array<{ id: string; savedAt: string; note?: string; nodeCount: number }>>;
    restoreGraphVersion: (id: string, versionId: string) => Promise<
      | { ok: true; automationId: string; versionId: string; automation: Automation }
      | { ok: false; reason: string }
    >;
    /** opts.dryRun: 시뮬레이션 실행 — 외부 변경을 막고 무엇이 막혔는지 남긴다. */
    runNow: (id: string, opts?: { dryRun?: boolean; input?: Record<string, unknown>; fresh?: boolean }) => Promise<AutomationRunNowResult>;
    /** 이 그래프가 시작할 때 사람에게 받아야 하는 값(없으면 null). */
    inputRequirement: (id: string) => Promise<{ required: boolean; varName: string; label: string } | null>;
    /** 이 그래프가 연결돼야 하는 것 — 공급자 묶음별로. 켜기 게이트와 같은 계산을 쓴다. */
    connectionReport: (id: string) => Promise<import("./graph-tool-binding").GraphConnectionReportShape | null>;
    /**
     * 같은 일을 하는 다른 서비스로 **한 번에** 갈아끼운다.
     * 못 하는 것으로는 바꿔주지 않는다 — 거절도 코드·사유·다음 행동으로 온다.
     */
    swapProvider: (
      id: string,
      input: { capability: string; fromProvider: string | null; toProvider: string },
    ) => Promise<import("./graph-tool-binding").GraphSwapOutcome>;
    /** 한 단계가 부르는 에이전트를 바꾼다. */
    swapAgent: (
      id: string,
      input: { nodeId: string; ref: string; targetType: "agent" | "firm" | "hub"; targetVersion?: string | null; label?: string },
    ) => Promise<import("./graph-tool-binding").GraphSwapOutcome>;
    /** 자연어로 새 자동화를 만드는 인터뷰 한 턴. 질문이 오거나, 지어진 그래프가 온다. */
    interviewGraph: (state: unknown) => Promise<
      | { ok: true; kind: "ask"; questions: Array<{ id: string; question: string; why: string; choices?: string[] }> }
      | { ok: true; kind: "blueprint"; blueprint: unknown; graph: WorkflowGraph; scheduleHuman: string; triggerType: "schedule" | "manual" }
      | { ok: false; code: string; reason: string; nextAction: string }
    >;
    /** 인터뷰로 정해진 그래프를 실제로 만든다(꺼진 상태로). */
    createFromBlueprint: (payload: { name: string; graph: WorkflowGraph; scheduleHuman: string; targetId?: string; goal?: string }) => Promise<
      { ok: true; id: string; name: string; renamed: boolean } | { ok: false; code: string; reason: string; nextAction: string }
    >;
    /**
     * 그래프를 고친 뒤 **이전 실패를 잊고 처음부터** 돌릴 수 있게 한다.
     * `forgot:false` 면 사유가 온다 — 그래프가 안 바뀌었으면 잊지 않는다(이중 실행 방지).
     */
    forgetFailedRun: (id: string) => Promise<{ automationId: string; ok: boolean; forgot: boolean; reason?: string }>;
    /**
     * 저장 **전에** 한 번 돌려 보고, 막히면 이어갈 길을 함께 받는다. 저장하지 않는다.
     *
     * ★막힌 것을 문장 한 줄로 알리고 끝내면 사용자는 거기서 멈춘다(오너 2026-08-20).
     *   `recovery.options` 는 **호스트가 실제로 실행할 수 있는 것만** 담긴다 —
     *   모델이 지어낸 조치는 여기 오지 못한다.
     */
    checkBlueprintBeforeSave: (payload: {
      graph: WorkflowGraph;
      goal?: string;
      initialVars?: Record<string, unknown>;
    }) => Promise<{
      ok: boolean;
      blocked: {
        nodeId: string; label: string; cause: string;
        availableVars: string[]; upstreamSample: string | null;
        varsSnapshot: Record<string, unknown>;
      } | null;
      recovery: GraphBuildRecoveryPlan | null;
      repaired?: Array<{ nodeId: string; label: string; code: string }>;
    }>;
    /** 짓는 중 복구 칩을 실제로 실행한다. 사람이 누른 순간에만 부른다. */
    applyBuildRecovery: (payload: {
      graph: WorkflowGraph;
      goal?: string;
      blocked: {
        nodeId: string; label: string; cause: string;
        availableVars: string[]; upstreamSample: string | null;
        varsSnapshot: Record<string, unknown>;
      };
      actionId: string;
    }) => Promise<{
      ok: boolean;
      message: string;
      graph?: WorkflowGraph;
      saveNow?: boolean;
      continueInChat?: boolean;
    }>;
    /**
     * 도는 실행을 멈춘다. `stopped: false`면 멈출 것이 없었다는 뜻 — 멈춘 척하지 않는다.
     * 커널이 진행 중 노드를 정리한 뒤, 바깥에 반영됐는지 모르는 단계는 재조정 대기로 남는다.
     */
    stopRun: (id: string) => Promise<{ ok: true; stopped: boolean }>;
    /**
     * 사용자의 한 문장을 그래프 변경 제안으로 바꾼다. **적용하지 않는다** —
     * 무엇이 바뀌는지 보여주고, 적용은 applyGraphPatch로만 한다.
     */
    requestGraphPatch: (
      id: string,
      request: string,
    ) => Promise<
      | { ok: false; code: string; reason: string; nextAction: string }
      | {
        ok: true;
        patch: { ops: unknown[]; rationale?: string };
        risks: string[];
        summary: { added: string[]; removed: string[]; changed: string[] };
        needsApproval: boolean;
        rationale?: string;
      }
    >;
    /**
     * 그래프 변경 제안을 평가한다 — **적용하지 않는다**.
     * 무엇이 바뀌는지와 사람이 봐야 할 이유를 돌려주고, 적용은 별도 호출로만 한다.
     */
    proposeGraphPatch: (
      id: string,
      patch: { ops: unknown[]; rationale?: string },
    ) => Promise<
      | { ok: false; code: string; reason: string; nextAction: string }
      | {
        ok: true;
        risks: string[];
        summary: { added: string[]; removed: string[]; changed: string[] };
        needsApproval: boolean;
      }
    >;
    /** 사용자가 diff를 보고 승인한 뒤에만 저장한다. */
    applyGraphPatch: (
      id: string,
      patch: { ops: unknown[]; rationale?: string },
    ) => Promise<
      | { ok: true; automationId: string; automation: Automation }
      | { ok: false; code?: string; reason?: string; nextAction?: string }
    >;
    /** 승인 브레이크가 걸린 단계의 결정을 기록한다. 승인은 판정이 아니라 사람의 결정이다. */
    /** 좋은 예시 하나 → 채점표 제안. 제안일 뿐 — 편집기에 채워지고 사람이 고친 뒤 저장된다. */
    proposeChecklistFromExample: (
      id: string,
      example: string,
    ) => Promise<{ ok: boolean; items: Array<{ text: string; kind: "must" | "mustNot" }> }>;
    /** "이 판정은 틀렸다" — 교정을 남기면 그 노드의 이후 판정에 few-shot으로 주입된다. */
    recordEvalCorrection: (
      id: string,
      nodeId: string,
      correctedVerdict: "pass" | "fail",
      note?: string,
    ) => Promise<{ ok: boolean }>;
    decideNodeApproval: (
      id: string,
      nodeId: string,
      /** "always" = 이 노드는 앞으로 다시 묻지 않는다(그래프는 안 바뀐다 — 재개가 살아 있어야 하므로). */
      decision: "approved" | "rejected" | "always",
    ) => Promise<{ ok: boolean; occurrenceId: string | null; always?: boolean }>;
    listRuns: (id: string, limit?: number) => Promise<AutomationRunRecord[]>;
    /** 실행 창(ranAt±10분)의 호스트 캡처 — 지어낸 사유 대신 보여줄 물증. */
    runCaptures: (ranAtIso: string, limit?: number) => Promise<{ name: string; at: string; dataUrl: string }[]>;
    /** 확인필요 카드 닫기 — 기록은 남고 "지금 조치하라"는 요구만 꺼진다. */
    acknowledgeRun: (id: string, runId: string) => Promise<boolean>;
    /** 실행 id 없이 지금까지의 확인 요구를 전부 닫는다 — 어떤 카드든 끝낼 수 있는 종결 행동. */
    acknowledgeAttention: (id: string) => Promise<number>;
    listTriggerAttention: (automationId: string) => Promise<AutomationTriggerEventAttention[]>;
    reconcileTriggerEvent: (
      input: AutomationTriggerEventReconcileInput,
    ) => Promise<AutomationTriggerEventReconcileResult>;
    terminalCloseCandidate: (automationId: string) => Promise<AutomationGraphTerminalCloseCandidate | null>;
    terminalClose: (input: AutomationGraphTerminalCloseInput) => Promise<AutomationGraphTerminalCloseReceipt>;
    getGraphReconciliation: (
      automationId: string,
    ) => Promise<AutomationGraphReconciliation | null>;
    reconcileGraph: (
      input: AutomationGraphReconcileInput,
    ) => Promise<AutomationGraphReconcileResult>;
    /** 그래프 라이브 실행 상태 채널명 — agentlasEvents.on으로 구독해 per-node 상태를 받는다(설계 §5 P2). */
    liveRunChannel: (automationId: string) => string;
    /** 이 자동화의 최근 실행 스냅샷(per-node 상태). 라이브 오버레이 초기 하이드레이트용. */
    latestRun: (automationId: string) => Promise<WorkflowRunSnapshot | null>;
    /** Automation-owned session transcript rendered beside the node graph. */
    getSession: (automationId: string) => Promise<AutomationSession>;
    /** 멈춘 자동화에 대해 지금 실행 가능한 조치까지 포함한 복구 계획. */
    planFix: (automationId: string) => Promise<AutomationFixPlan>;
    /** 사용자가 고른 조치를 실행. 계획에 없는 id는 아무 일도 하지 않는다. */
    applyFix: (automationId: string, actionId: string) => Promise<AutomationFixActionReceipt>;
  };
  /** Legacy macOS background-launcher cleanup compatibility. */
  launchd: {
    status: () => Promise<LaunchdStatus>;
    enable: () => Promise<LaunchdStatus>;
    disable: () => Promise<LaunchdStatus>;
  };
  /** 스케줄 문법 헬퍼 — croner는 메인에서만 돌므로 렌더러 스케줄 빌더가 IPC로 검증/표시. */
  schedule: {
    validateCron: (expr: string) => Promise<boolean>;
    describe: (spec: ScheduleSpec, locale?: "ko" | "en") => Promise<string>;
    nextRun: (spec: ScheduleSpec) => Promise<string | null>;
    defaultTz: () => Promise<string>;
  };
  /** Agent-made interactive work surfaces emitted by agents. */
  surfaces: {
    listSurfaces: (chatId?: string) => Promise<AgentlasSurfaceRecord[]>;
    getSurface: (id: string) => Promise<AgentlasSurfaceRecord | null>;
    listJobs: (surfaceId: string) => Promise<SurfaceJobRecord[]>;
    getJobSummary: (surfaceId: string) => Promise<SurfaceJobCostSummary | null>;
    updateJob: (input: SurfaceJobUpdateRequest) => Promise<SurfaceJobRecord>;
    updateState: (input: SurfaceStatePatchRequest) => Promise<AgentlasSurfaceRecord>;
    listEvents: (surfaceId: string) => Promise<SurfaceStateEventRecord[]>;
    approve: (input: SurfaceApprovalGrantRequest) => Promise<SurfaceApprovalRecord>;
    hasApproval: (input: SurfaceApprovalCheckRequest) => Promise<boolean>;
    listApprovals: (surfaceId: string) => Promise<SurfaceApprovalRecord[]>;
    revokeApproval: (id: string) => Promise<SurfaceApprovalRecord>;
  };
  /** Reusable asset packs materialized from declarative surface media/storyboard/export data. */
  surfaceAssets: {
    materialize: (input: SurfaceAssetPackRequest) => Promise<SurfaceAssetPackMaterializeResult>;
    archive: (input: SurfaceAssetPackRootRequest) => Promise<SurfaceAssetPackOperationRecord>;
    restore: (input: SurfaceAssetPackRootRequest) => Promise<SurfaceAssetPackOperationRecord>;
    listPacks: (chatId?: string) => Promise<SurfaceAssetPackRecord[]>;
    getPack: (id: string) => Promise<SurfaceAssetPackRecord | null>;
    getPackBySurface: (chatId: string, surfaceId: string) => Promise<SurfaceAssetPackRecord | null>;
    listOperations: (packId: string) => Promise<SurfaceAssetPackOperationRecord[]>;
  };
  /** Agent-made service apps generated from safe Agentlas Surface manifests. */
  appFactory: {
    scaffold: (input: AppFactoryScaffoldRequest) => Promise<AppFactoryScaffoldResult>;
    syncCloudManifest: (input: AppFactoryCloudAppManifestRequest) => Promise<AppFactoryCloudAppInstallResult>;
    runAutopilot: (input: AppFactoryAutopilotRequest) => Promise<AppFactoryAutopilotResult>;
    installMcpPlan: (input: AppFactoryRootRequest) => Promise<AppFactoryMcpInstallResult>;
    runProviderTasks: (input: AppFactoryProviderTaskRunRequest) => Promise<AppFactoryProviderTaskRunResult>;
    materializeAssets: (input: AppFactoryAssetMaterializeRequest) => Promise<AppFactoryAssetMaterializeResult>;
    activateLocalCommerceStack: (input: AppFactoryLocalCommerceActivationRequest) => Promise<AppFactoryLocalCommerceActivationResult>;
    openProviderBrowser: (input: AppFactoryProviderBrowserOpenRequest) => Promise<AppFactoryProviderBrowserOpenResult>;
    captureProviderBrowserSessions: (input: AppFactoryProviderBrowserSessionRequest) => Promise<AppFactoryProviderBrowserSessionResult>;
    launchProviderBrowserSession: (input: AppFactoryProviderBrowserLaunchRequest) => Promise<AppFactoryProviderBrowserLaunchResult>;
    syncProviderBrowserResults: (input: AppFactoryProviderBrowserResultSyncRequest) => Promise<AppFactoryProviderBrowserResultSyncResult>;
    resolveProviderCredentials: (input: AppFactoryProviderCredentialResolveRequest) => Promise<AppFactoryProviderCredentialResolveResult>;
    approveProviderPayment: (input: AppFactoryProviderPaymentApproveRequest) => Promise<AppFactoryProviderPaymentApproveResult>;
    runSmoke: (input: AppFactoryRootRequest) => Promise<AppFactorySmokeResult>;
    preparePreview: (input: AppFactoryRootRequest) => Promise<AppFactoryPreviewResult>;
    /** Start or reuse a real, main-owned live preview for a registered app. */
    startLivePreview: (input: { appId: string }) => Promise<AppFactoryLivePreviewResult>;
    /** Stop the managed loopback preview. External URLs are unaffected. */
    stopLivePreview: (input: { appId: string }) => Promise<{ ok: true; stopped: boolean }>;
    openLaunchTarget: (input: AppFactoryRootRequest) => Promise<AppFactoryLaunchTargetResult>;
    publishAsTool: (input: AppFactoryRootRequest) => Promise<AppFactoryAppToolPublishResult>;
    archive: (input: AppFactoryRootRequest) => Promise<AppFactoryOperationRecord>;
    restore: (input: AppFactoryRootRequest) => Promise<AppFactoryOperationRecord>;
    listApps: (chatId?: string) => Promise<AppFactoryAppRecord[]>;
    getApp: (id: string) => Promise<AppFactoryAppRecord | null>;
    getAppBySurface: (chatId: string, surfaceId: string) => Promise<AppFactoryAppRecord | null>;
    listOperations: (appId: string) => Promise<AppFactoryOperationRecord[]>;
  };
  /**
   * Sandboxed native web surface used by Work. Unlike an iframe this remains
   * compatible with apps that correctly deny framing, while exposing no
   * preload, Node API, or Desktop IPC to the loaded page.
   */
  workLiveView: {
    /** Explicit user action; source and destination are fixed by Main. */
    importBrowserCookies: () => Promise<NativeBrowserCookieImportResult>;
    listTabs: (input: { taskScopeId: string }) => Promise<{ ok: boolean; tabs: WorkLiveBrowserTab[]; reason?: string }>;
    createTab: (input: { taskScopeId: string; url?: string }) => Promise<{ ok: boolean; tab?: WorkLiveBrowserTab; reason?: string }>;
    open: (input: {
      viewId: string;
      taskScopeId?: string;
      url: string;
      bounds: WorkLiveViewBounds;
      visible?: boolean;
      mode?: "app" | "browser";
    }) => Promise<{ ok: boolean; viewId: string; url?: string; reason?: string }>;
    setBounds: (input: {
      viewId: string;
      taskScopeId?: string;
      bounds: WorkLiveViewBounds;
      visible?: boolean;
    }) => Promise<{ ok: boolean }>;
    reload: (viewId: string, taskScopeId?: string) => Promise<{ ok: boolean }>;
    navigate: (input: { viewId: string; url: string; taskScopeId?: string }) => Promise<{ ok: boolean; url?: string; reason?: string }>;
    goBack: (viewId: string, taskScopeId?: string) => Promise<{ ok: boolean }>;
    goForward: (viewId: string, taskScopeId?: string) => Promise<{ ok: boolean }>;
    close: (viewId: string, taskScopeId?: string) => Promise<{ ok: boolean }>;
    capture: (viewId: string, taskScopeId?: string) => Promise<{ ok: boolean; dataUrl?: string; reason?: string }>;
    dispatchInput: (input: { viewId: string; input: WorkLiveViewInput; taskScopeId?: string }) => Promise<{ ok: boolean; reason?: string }>;
    onStatus: (handler: (status: WorkLiveViewStatus) => void) => () => void;
  };
  /** Local meta-agent factory that materializes domain teams for Agentlas OS. */
  metaAgent: {
    createCommerceTeam: (input: MetaAgentTeamFactoryRequest) => Promise<MetaAgentTeamFactoryResult>;
  };
  /** Agent-made local tools generated from safe tool specs in Agentlas Surface manifests. */
  toolFactory: {
    scaffold: (input: ToolFactoryScaffoldRequest) => Promise<ToolFactoryScaffoldResult>;
    runSmoke: (input: ToolFactoryRootRequest) => Promise<ToolFactorySmokeResult>;
    installMcp: (input: ToolFactoryRootRequest) => Promise<ToolFactoryMcpInstallResult>;
    archive: (input: ToolFactoryRootRequest) => Promise<ToolFactoryOperationRecord>;
    restore: (input: ToolFactoryRootRequest) => Promise<ToolFactoryOperationRecord>;
    listTools: (chatId?: string) => Promise<ToolFactoryToolRecord[]>;
    getTool: (id: string) => Promise<ToolFactoryToolRecord | null>;
    getToolBySurface: (
      chatId: string,
      surfaceId: string,
      requestedToolId?: string,
    ) => Promise<ToolFactoryToolRecord | null>;
    listOperations: (toolRecordId: string) => Promise<ToolFactoryOperationRecord[]>;
  };
  /** Conversation-driven local plugin builder. Packages are verified before install. */
  pluginBuilder: {
    start: (input: { chatId: string; seed: PluginBuilderSeed }) => Promise<PluginBuilderSession>;
    draft: (input: PluginBuilderDraftInput) => Promise<PluginDraftResult>;
    verify: (input: PluginBuilderSessionInput) => Promise<PluginGateReport>;
    install: (input: PluginBuilderSessionInput) => Promise<PluginInstallReceipt>;
    prove: (input: PluginBuilderSessionInput) => Promise<PluginProofReceipt>;
    discard: (input: PluginBuilderSessionInput) => Promise<void>;
    listDrafts: (chatId: string) => Promise<PluginBuilderSession[]>;
    onProgress: (listener: (event: PluginBuilderProgressEvent) => void) => () => void;
  };
  /** OpenClaw / Hermes에서 페르소나·키·자동화·메모리를 가져온다.
   *  scan은 디스크를 읽어 preview(이름/개수만) 반환, import는 실제 적용. */
  migration: {
    /** ~/.openclaw, ~/.hermes를 스캔해 가져올 수 있는 것들의 preview */
    scan: () => Promise<MigrationSourcePreview[]>;
    /** preview를 실제 적용 (dryRun이면 적용 없이 결과 형태만) */
    import: (opts: MigrationOptions) => Promise<MigrationResult>;
  };
  /** 브리핑 인터뷰 모드 — 모호한 실행형 요청 앞 배치 질문 게이트 설정. */
  interview: {
    getMode: () => Promise<"smart" | "build-only" | "off">;
    setMode: (mode: "smart" | "build-only" | "off") => Promise<"smart" | "build-only" | "off">;
  };
  /** invoke:run의 chatId가 firm 채팅인지 일반 채팅인지로 자동 라우팅 */
  invoke: {
    run: (req: McpInvocationRequest) => Promise<{ runId: string }>;
    /** Queue a follow-up, cancel the current turn, then resume this chat after terminal settlement. */
    steer: (req: McpInvocationRequest) => Promise<InvocationSteerResult>;
    eventChannel: (runId: string) => string;
    /** 진행 중인 실행을 취소 — CLI 자식 프로세스 kill / API fetch abort. 병렬 세션 각각 독립 취소. */
    cancel: (runId: string) => Promise<InvocationCancelReceipt>;
    /** Pull a queued direction back before its run starts (1-based queue position + exact text). */
    unsteer: (req: { chatId: string; position: number; text: string }) => Promise<boolean>;
    history: (chatId: string) => Promise<ChatHistoryEntry[]>;
    clearHistory: (chatId: string) => Promise<void>;
    /** 현재 실행 중인 chatId 목록 — 사이드바 "실행 중" 인디케이터 초기 시드용. */
    activeChats: () => Promise<string[]>;
    /** 채팅 진입 시 진행 중 실행에 재접속 — 그 chat의 runId + 지금까지 버퍼된 이벤트 + 시작 시각. 없으면 null. */
    attach: (chatId: string, options?: { includeEvents?: boolean }) => Promise<{
      runId: string;
      events: McpInvocationEvent[];
      startedAt?: string;
      queuedSteers?: Array<{ text: string; queuedAt: string; position: number }>;
    } | null>;
    /** 실행 ID의 live+durable 상태. 앱 재시작 뒤 미종결 started receipt는 interrupted로 판정한다. */
    receipt: (runId: string) => Promise<InvocationRunReceipt | null>;
    /** 채팅의 가장 최근 실행 receipt — 결과 폴더/실패 진단 복원용. */
    latestReceipt: (chatId: string) => Promise<InvocationRunReceipt | null>;
    workerReport: (scope: import("./worker-report").WorkerReportScope) => Promise<import("./worker-report").WorkerReport | null>;
    /** Exact Main-projected surface for one canonical Task/run binding. */
    latestOneSurface: (input: {
      runId: string;
      chatId: string;
      taskId: string;
    }) => Promise<DurableOneSurfaceResult | null>;
  };
  /** 임베딩된 Hephaestus 엔진 브리지. 데스크탑↔엔진 연결은 전부 이 도메인으로 흐른다.
   *  (Hephaestus 소스에는 데스크탑 흔적이 없다 — 엔진은 범용 CLI/JSON 으로만 호출됨.) */
  hephaestus: {
    /** 엔진 가용성(번들 + Python). UI 게이트에 사용. */
    status: (locale?: "ko" | "en") => Promise<HephaestusStatus>;
    /** One이 복구 행동을 선택·실행하고 같은 엔진을 다시 검증한다. */
    recover: (input?: { locale?: "ko" | "en"; actionId?: string }) => Promise<HephaestusRecoveryReceipt>;
    /** Engine updater journal (read-only; null when it has never run). */
    updateJournal: () => Promise<HephaestusUpdateJournal | null>;
    /** Run the engine updater now and report what it actually did. */
    runUpdate: () => Promise<HephaestusUpdateResult>;
    /** 엔진 자가진단(JSON). */
    doctor: () => Promise<HephaestusCommandResult>;
    /** 엔진 계정 상태(JSON). 데스크탑 로그인과 **별개의 자격증명**이다 — 데스크탑은
     *  세션 쿠키를, 엔진은 OAuth access token 을 쓴다. */
    coreAuthStatus: () => Promise<HephaestusCommandResult>;
    /** 엔진 로그인을 한 번 끝낸다. 브라우저 PKCE 라 최대 3분. */
    coreAuthLogin: () => Promise<HephaestusCommandResult>;
    /**
     * Core CLI 진행 스트림 구독. 반환값은 해제 함수다.
     * publish·securityScan 이 수 분간 침묵하던 문제를 메운다 — `runHephaestus` 는
     * `onStdout`/`onStderr` 를 늘 갖고 있었지만 넘기는 호출부가 0곳이었다.
     */
    onProgress: (
      listener: (event: { progressId: string; stream: "stdout" | "stderr"; line: string; elapsedMs: number }) => void,
    ) => () => void;
    /** Stormbreaker 견고-실행: 쿼리 라우팅 후 가능한 pipeline execution_fabric 실행. */
    stormbreaker: (input: {
      query: string;
      project?: string;
      background?: boolean;
      researchEvidence?: boolean;
    }) => Promise<HephaestusCommandResult>;
    /** Stormbreaker 슈퍼바이저 상태. 현재 제품 UI에서는 항상 ON이며 토글은 호환 API다. */
    getSupervisor: () => Promise<{ enabled: boolean }>;
    setSupervisor: (enabled: boolean) => Promise<{ enabled: boolean }>;
    /** 엔진 자동 개입 토글 — 대시보드 LLM 연결·사용량 아래 스위치 2개
     *  (신규 설치: stormbreakerAuto OFF, networkAuto ON; 저장값은 보존).
     *  stormbreakerAuto: 일반 채팅에 Stormbreaker 루프 자동 주입 / networkAuto: 자동 Hub 빌림·에스컬레이션.
     *  명시 경로(컴포저 칩, `stormbreaker`/`hep-network` 프리픽스, @멘션 고용, continuousMode)는 토글과 무관하게 동작. */
    getEngineToggles: () => Promise<{ stormbreakerAuto: boolean; networkAuto: boolean }>;
    setEngineToggle: (input: {
      id: "stormbreaker" | "network";
      enabled: boolean;
    }) => Promise<{ stormbreakerAuto: boolean; networkAuto: boolean }>;
    /** Stormbreaker 런 저널 검사(재개/감사). */
    journal: (input: {
      action: "status" | "verify" | "repair" | "gate";
      runId?: string;
      project?: string;
    }) => Promise<HephaestusCommandResult>;
    /** Hub/Cloud 후보 검색(실행 없음). 마켓플레이스/허브. */
    search: (input: { query: string; limit?: number }) => Promise<HephaestusCommandResult>;
    /** Hub 네트워크 라우팅(GUI 숏컷 → 라우팅 폴백). */
    network: (input: { query: string; autoRun?: boolean; noOpen?: boolean }) => Promise<HephaestusCommandResult>;
    /** 추천 미리보기 — routeOnly(실행 없음) 결정을 정규화해 추천 바텀시트에 넘긴다. 짧은 timeout(인터랙티브). */
    routePreview: (input: {
      query: string;
      project?: string;
      scope?: "network" | "cloud";
      allowLocal?: boolean;
      offline?: boolean;
      /** Preserve the route-preview host contract without running a global search for every turn. */
      sessionRosterFirst?: boolean;
    }) => Promise<Recommendation>;
    /** 패키지된 GUI 숏컷(스튜디오 등) 복원/실행. */
    localGui: (input: { shortcut: string; detach?: boolean; noOpen?: boolean }) => Promise<HephaestusCommandResult>;
    /** 에이전트 폴더 → Cloud/Hub 업로드(실 패키징 + 보안 스캔 + publish). */
    publish: (input: {
      folder: string;
      scope: FsReadScope;
      visibility: HephaestusUploadVisibility;
      dryRun?: boolean;
    }) => Promise<HephaestusCommandResult>;
    /** 업로드 전 패키징 + 정적 검토 리포트. */
    package: (input: { folder: string; scope: FsReadScope; visibility?: HephaestusUploadVisibility }) => Promise<HephaestusCommandResult>;
    /** 정적 보안 스캔. */
    securityScan: (input: { folder: string; scope: FsReadScope; strict?: boolean }) => Promise<HephaestusCommandResult>;
    /** AO(에이전트 온톨로지) 그래프 — 정보 흐름 맵 백킹 데이터. */
    aoGraph: (input?: { agent?: string; dir?: string }) => Promise<HephaestusCommandResult>;
    /** 빌더(hep-build) 스트리밍 실행 — 데스크탑 런타임 + Hephaestus 빌더 에이전트. */
    /** Which model an unpinned Build would use, resolved without starting it. */
    previewAllocation: (input: HephaestusBuildRequest) => Promise<BuildAllocationPreview | null>;
    build: (input: HephaestusBuildRequest) => Promise<HephaestusBuildStartResult>;
    /** 빌더 이벤트 채널명(window.agentlasEvents.on 으로 구독). */
    buildEventChannel: (runId: string) => string;
    /** 채널 구독 완료 신호 — 구독 전 버퍼링된 초기 이벤트를 flush 한다(첫 stage 틱 유실 방지). */
    buildReady: (runId: string) => Promise<void>;
    /**
     * Main이 들고 있는 최신 빌드 전사. 화면을 떠났다 돌아왔을 때 붙기 위한 것.
     * `running`이면 같은 채널을 다시 구독하면 되고, 끝난 빌드면 결과만 재생한다.
     */
    activeBuild: () => Promise<{
      runId: string;
      request: string;
      workspace: string;
      startedAt: string;
      running: boolean;
      events: HephaestusBuildEvent[];
    } | null>;
    /**
     * 패키지 계약 게이트를 직접 물어본다. 모델의 완료 선언과 무관하게 사실을 잰다.
     * blockers가 빈 배열이면 통과, null이면 검증 자체가 불가(통과로 간주 금지).
     */
    contractVerify: (input: { folder: string; scope: FsReadScope; mode?: "single" | "team" | "package" })
      => Promise<{ ok: boolean; blockers: string[] | null; error: string | null }>;
    /** 진행 중 빌드 취소. */
    cancelBuild: (runId: string) => Promise<void>;
    /** Startup Founder Studio — 패키지의 실제 GUI 런처를 띄우고 iframe 용 로컬 URL 반환. */
    startStudio: (input?: { idea?: string }) => Promise<{ ok: boolean; url?: string; reason?: string; ideaQueued?: boolean }>;
    stopStudio: () => Promise<void>;
  };
}

declare global {
  interface Window {
    agentlas: AgentlasIpc;
  }
}

/** preload가 contextBridge로 노출하는 updater 이벤트 채널 — onState 구독자에게 UpdaterState 푸시. */
export interface AgentlasUpdaterEvents {
  onState: (handler: (state: UpdaterState) => void) => () => void;
}

/**
 * 도구 승인 — 런타임이 제각각 말하는 "승인"을 화면이 한 모양으로 받는다.
 *
 * `mode` 가 이 계약의 중심이다(electron/runtime/tool-approval.ts 주석 참고):
 *  - live: 런타임이 실행 전에 물었고 답을 기다린다. 선택이 이번 호출을 결정한다.
 *  - post-denial: 헤드리스라 물어볼 상대가 없어 런타임이 이미 거부하고 지나갔다.
 *    선택은 다음 실행에만 적용된다. 이 둘을 한 버튼으로 그리면 "허용했는데
 *    아무 일도 안 일어나는" 화면이 된다.
 *
 * `deniedBy` 는 사람이 거절한 것과 런타임이 자동 거부한 것을 화면에서 구분하기 위한
 * 칸이다. 런타임들은 자동 거부를 "User denied" / "user-rejected" 로 기록하지만,
 * 사용자는 손도 대지 않았다.
 */
export interface ToolApprovalRequestEvent {
  id: string;
  /** claude-code | antigravity | acp | ollama … */
  runtime: string;
  tool: string;
  /** 실제로 무엇을 하려 했는가 — 명령줄이나 대상 경로. */
  detail?: string;
  cwd?: string;
  mode: "live" | "post-denial";
  deniedBy?: "runtime-headless" | "sandbox";
  requestedAt: string;
  /** Main이 이 live 요청을 자동 거부하는 정확한 시각. 오래된 요청은 없을 수 있다. */
  expiresAt?: string;
  /**
   * 요청이 붙어 있는 대화(chat id). 승인 카드는 이 대화 안에서만 뜨고, 다른 화면에는
   * 확인필요 배지만 남는다(오너 결정 2026-08-15). 없으면(대화 없는 실행) 전역 배지.
   */
  chatId?: string;
  /**
   * 이 호출의 능력 클래스(execute|edit|delete|network|other). "항상 허용"이 무엇을
   * 영구 부여하는지 카드가 정확히 말할 수 있게 한다(오너 결정 2026-08-20).
   */
  capability?: string;
  /** 실행 중인 에이전트 — 에이전트 스코프 규칙의 대상. */
  agentId?: string;
  /**
   * Main-owned durable-consent identity.  This is deliberately opaque to the
   * renderer: it binds an allow-always decision to one user, workspace,
   * requester, exact credential/resource, and exact permission level.
   */
  consentBinding?: ToolApprovalConsentBinding;
}

/**
 * Exact identity required for a durable tool consent.  Resource identity is
 * value-free (normally a Main-computed digest), so raw credentials never cross
 * the approval IPC or enter the SQLite row.
 */
export interface ToolApprovalConsentBinding {
  userIdentity: string;
  workspaceIdentity: string;
  requesterIdentity: string;
  credentialResourceIdentity: string;
  permissionScope: "read" | "write" | "full";
}

export type ToolApprovalDurableConsentStatus = "persisted" | "failed" | "unavailable";

/** Separate from the runtime decision: allow-once/session may still succeed
 * when an allow-always write was unavailable, but the UI must not call it
 * durable until this receipt says `persisted`. */
export interface ToolApprovalDurableConsentReceipt {
  status: ToolApprovalDurableConsentStatus;
  code?:
    | "missing-binding"
    | "missing-persister"
    | "storage-failure"
    | "storage-receipt-missing";
}

/**
 * allow_always — 능력 규칙을 영구 기록해 **다시는 묻지 않는다**(오너 결정 2026-08-20).
 * 대기 중인 이번 호출에는 allow_session 과 같게 작용하고, 기록은 capability_grants 로 간다.
 */
export type ToolApprovalDecision = "allow_once" | "allow_session" | "allow_always" | "deny";

/**
 * 런타임 승인 한 번의 authoritative receipt. `pending=false`만으로 성공을 추측하지
 * 않는다: requestId + requested/resolved decision + deterministic actionId가 모두
 * 맞아야 사용자가 누른 선택이 실제 실행 경계에 전달된 것이다.
 */
export interface ToolApprovalResolutionReceipt {
  ok: boolean;
  receiptVersion: 1;
  requestId: string;
  requestedDecision: ToolApprovalDecision | null;
  resolvedDecision: ToolApprovalDecision | null;
  actionId: string | null;
  status: "resolved" | "replayed" | "pending" | "expired" | "conflict" | "not_found" | "invalid_action";
  pending: boolean;
  decidedAt: string | null;
  durableConsent?: ToolApprovalDurableConsentReceipt;
}

/** One's durable memory row as the renderer may see it: bounded content, project slug only, never a local path. */
export interface OneDurableMemoryEntryUi {
  id: string;
  kind: string;
  scope: string;
  content: string;
  projectSlug: string | null;
  evidenceCount: number;
  createdAt: string;
}

/**
 * Can this updater state be resolved by fetching the official installer?
 *
 * ★ One definition, used by both the main process (which decides whether the
 * action is allowed) and the renderer (which decides whether to draw the
 * button). They were hand-maintained copies of the same list; a button that
 * appears but does nothing is a worse dead end than no button at all.
 *
 * - The three `install-*` codes mean native replacement could not start or
 *   apply. A fresh installer replaces app bytes and keeps userData.
 * - `minimum-app-version` means the installed app predates the oldest starting
 *   point the release accepts. Nothing picks an intermediate build to bridge
 *   from and the state is not retryable, so reinstalling is the only exit that
 *   exists — leaving it out froze such an install permanently.
 *
 * Backup, schema, and metadata failures stay out: replacing the bundle cannot
 * repair those boundaries.
 */
export function updaterCanUseOfficialInstaller(state: {
  status?: string;
  code?: UpdaterErrorCode;
}): boolean {
  if (state.status === "manual-required") {
    return state.code === "install-source-untrusted"
      || state.code === "install-not-applied"
      || state.code === "install-start-failed";
  }
  if (state.status === "incompatible") return state.code === "minimum-app-version";
  return false;
}

/**
 * 봇이 "질문 서식"을 채우지 않고 그대로 베껴 낸 것인가?
 *
 * ★ 사고: 우리는 봇에게 질문 쓰는 법을 빈 서식으로 알려준다 —
 * question 자리에 "Question text ending with ?", header 자리에 "Short label",
 * 선택지에 "Option A"/"Option B". 그 안내문을 자기 질문으로 바꿔 채우라는 뜻인데,
 * 봇이 안내문을 지우지 않고 그대로 제출하는 일이 실제로 일어났다. 걸러내는 곳이
 * 없어서 그 안내문이 승인함까지 올라왔고, 답해도 이어갈 내용이 없으니 사라지지도
 * 않아 12일 동안 남아 있었다.
 *
 * 오너 규칙: 답할 수 없는 것은 보여주지 않는다. 그래서 이 판정은 두 곳이 같이 쓴다 —
 * 질문을 받는 쪽(다시 내게 한다)과 목록을 만드는 쪽(올리지 않는다). 손으로 유지되는
 * 두 벌이면 한쪽만 고쳐져 다시 새어 나온다.
 *
 * 판정은 보수적이다: 사람이 실제로 저 문장을 쓸 일은 없지만, 그래도 한 조각만 같은
 * 경우는 통과시키고 서식의 뼈대가 그대로 남아 있을 때만 막는다.
 */
export function isUnfilledQuestionTemplate(input: {
  question?: string;
  header?: string;
  options?: ReadonlyArray<{ label?: string }>;
}): boolean {
  const norm = (value?: string) => (value ?? "").trim().toLowerCase();
  const question = norm(input.question);
  const header = norm(input.header);
  const labels = (input.options ?? []).map((option) => norm(option?.label));

  // 서식의 질문 자리를 그대로 낸 경우. 이 문장 자체가 "여기에 질문을 써라"는 안내문이라
  // 사용자에게는 뜻이 없다.
  if (question === "question text ending with ?") return true;

  // 질문은 채웠는데 선택지를 안 채운 경우 — 고를 수 없으니 역시 답할 수 없다.
  const placeholderLabels = labels.filter((label) => /^option [a-d]$/.test(label));
  if (labels.length > 0 && placeholderLabels.length === labels.length) return true;

  // 짧은 이름만 안 채운 것은 막지 않는다 — 질문과 선택지가 진짜면 답할 수 있다.
  if (header === "short label" && question === "" ) return true;
  return false;
}
