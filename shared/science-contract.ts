import type { ScienceResearchLifecycleRevision } from "./science-lifecycle";
import type {
  ScienceStatisticsFigureArtifactPayload,
  ScienceStatisticsFigureRasterArtifactPayload,
} from "./science-statistics";
import type {
  ScienceNumericSurfacePngExport,
  ScienceNumericSurfaceRasterArtifactPayload,
  ScienceNumericSurfaceV2ArtifactPayload,
} from "./science-numeric-3d";
import type {
  ScienceManuscriptDocument,
  ScienceManuscriptOperation,
} from "./science-manuscript-document";
import type {
  ScienceManuscriptEditProposal,
  ScienceManuscriptSelectionContext,
} from "./science-manuscript-proposal";
import type { RuntimeSelection } from "./types";

export * from "./science-manuscript-document";
export * from "./science-manuscript-proposal";
export * from "./science-manuscript-scholarly-assessment";
export * from "./science-manuscript-comparable-eligibility";
export * from "./science-manuscript-drafting";

export const SCIENCE_DOMAINS = [
  "general",
  "life-science",
  "chemistry",
  "physics",
  "materials-science",
  "genomics",
  "astronomy",
  "earth-ecology",
  "statistics",
  "economics",
  "finance",
] as const;
export type ScienceDomain = typeof SCIENCE_DOMAINS[number];

export const SCIENCE_RESEARCH_TEMPLATE_IDS = [
  "data-table",
  "statistics-analysis",
  "data-visualization",
  "economic-indicators",
  "literature-network",
  "astronomy-sky",
  "biodiversity-map",
  "paleontology-evidence",
  "earthquake-observations",
  "physics-data",
  "materials-structures",
  "genomics-variants",
  "comparative-genomics",
  "molecular-structure",
  "chemistry",
] as const;
export type ScienceResearchTemplateId = typeof SCIENCE_RESEARCH_TEMPLATE_IDS[number];

export interface ScienceProject {
  id: string;
  title: string;
  question: string;
  domain: ScienceDomain;
  /** Additional discovery metadata. `domain` remains the backwards-compatible primary domain. */
  relatedDomains: ScienceDomain[];
  /** Exact creation template. Legacy projects remain null and keep their original domain semantics. */
  researchTemplateId?: ScienceResearchTemplateId | null;
  /** The first Lab bound by the creation template. It is stored independently for auditability. */
  initialLabId?: ScienceResearchTemplateId | null;
  /** Canonical folder explicitly selected in the Science UI; absent for legacy projects. */
  folderPath?: string | null;
  status: "draft" | "active" | "paused" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScienceProjectLibrarySummary {
  projectId: string;
  fileCount: number;
  dataCount: number;
  analysisCount: number;
  manuscriptCount: number;
  pdfCount: number;
}

export const SCIENCE_PROJECT_DESTINATIONS = [
  "overview",
  "logbook",
  "scope",
  "literature",
  "hypotheses",
  "plan-protocols",
  "acquisition",
  "analysis-runs",
  "interpretation",
  "results",
  "manuscript",
  "submission-archive",
] as const;
export type ScienceProjectDestination = typeof SCIENCE_PROJECT_DESTINATIONS[number];

export const SCIENCE_PROJECT_WORKSPACE_TAB_KINDS = [
  "research",
  "conversation",
  "lab",
  "artifact",
  "manuscript",
] as const;
export type ScienceProjectWorkspaceTabKind = typeof SCIENCE_PROJECT_WORKSPACE_TAB_KINDS[number];

export const SCIENCE_PROJECT_LAB_ACTIVATORS = ["user", "artifact", "template", "recommendation"] as const;
export type ScienceProjectLabActivator = typeof SCIENCE_PROJECT_LAB_ACTIVATORS[number];

export interface ScienceProjectNavigationState {
  projectId: string;
  destination: ScienceProjectDestination;
  selectedConversationId: string | null;
  selectedLabId: string | null;
  updatedAt: string;
}

export interface ScienceProjectWorkspaceTab {
  id: string;
  projectId: string;
  kind: ScienceProjectWorkspaceTabKind;
  targetId: string | null;
  exactVersion: number | null;
  exactContentSha256: string | null;
  dirty: boolean;
  selected: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScienceProjectLabBinding {
  id: string;
  projectId: string;
  labId: string;
  enabled: boolean;
  pinned: boolean;
  displayOrder: number;
  activatedBy: ScienceProjectLabActivator;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ScienceProjectWorkspaceState {
  navigation: ScienceProjectNavigationState;
  tabs: ScienceProjectWorkspaceTab[];
  labs: ScienceProjectLabBinding[];
  relatedDomains: ScienceDomain[];
}

export interface UpdateScienceProjectNavigationInput {
  projectId: string;
  destination: ScienceProjectDestination;
  selectedConversationId?: string | null;
  selectedLabId?: string | null;
}

export interface ReplaceScienceProjectWorkspaceTabsInput {
  projectId: string;
  tabs: Array<{
    id: string;
    kind: ScienceProjectWorkspaceTabKind;
    targetId?: string | null;
    exactVersion?: number | null;
    exactContentSha256?: string | null;
    dirty?: boolean;
    selected?: boolean;
    displayOrder: number;
  }>;
}

export interface UpsertScienceProjectLabBindingInput {
  requestId: string;
  projectId: string;
  labId: string;
  enabled: boolean;
  pinned?: boolean;
  displayOrder?: number;
  activatedBy: ScienceProjectLabActivator;
  config?: Record<string, unknown>;
}

export interface UpsertScienceProjectLabBindingResult {
  binding: ScienceProjectLabBinding;
  replayed: boolean;
}

export interface UpdateScienceProjectRelatedDomainsInput {
  requestId: string;
  projectId: string;
  relatedDomains: ScienceDomain[];
}

export interface UpdateScienceProjectRelatedDomainsResult {
  project: ScienceProject;
  replayed: boolean;
}

export interface ScienceConversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScienceMessage {
  id: string;
  projectId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  /**
   * Controller continuation prompts are durable runtime inputs, but are not
   * researcher-authored chat.  Keeping the visibility on the canonical row
   * lets the UI omit them without falsifying the runtime history.
   */
  visibility: "visible" | "internal";
  content: string;
  createdAt: string;
}

export interface AppendScienceMessageInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  role: "assistant" | "system";
  content: string;
}

export interface AppendScienceMessageResult {
  message: ScienceMessage;
  replayed: boolean;
}

export const SCIENCE_TURN_STATUSES = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type ScienceTurnStatus = typeof SCIENCE_TURN_STATUSES[number];

export const SCIENCE_TURN_EVENT_KINDS = [
  "lifecycle",
  "reasoning",
  "tool",
  "partial",
  "final",
  "error",
] as const;
export type ScienceTurnEventKind = typeof SCIENCE_TURN_EVENT_KINDS[number];

export interface ScienceConversationRuntimeBinding {
  projectId: string;
  conversationId: string;
  runtimeChatId: string;
  createdAt: string;
}

export interface BindScienceConversationRuntimeInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  runtimeChatId: string;
}

export interface BindScienceConversationRuntimeResult {
  binding: ScienceConversationRuntimeBinding;
  replayed: boolean;
}

export interface ScienceTurn {
  id: string;
  requestId: string;
  projectId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  runtimeChatId: string;
  invocationRunId: string;
  parentTurnId: string | null;
  /** Whether this invocation came from a researcher or an authorized loop continuation. */
  origin: "user" | "loop-continuation";
  continuationBasis: Record<string, unknown> | null;
  continuationBasisSha256: string | null;
  /** Exact Science-owned orchestrator pin captured when this turn was created. */
  runtimeSelection: RuntimeSelection | null;
  runtimeSelectionSha256: string | null;
  status: ScienceTurnStatus;
  lastSequence: number;
  partialText: string;
  partialSha256: string | null;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StartScienceTurnInput = {
  requestId: string;
  projectId: string;
  conversationId: string;
  runtimeChatId: string;
  invocationRunId: string;
  parentTurnId?: string | null;
  /** Optional for legacy internal callers; new Science UI calls must provide an exact pin. */
  runtimeSelection?: RuntimeSelection | null;
} & (
  | { mode: "existing-user-message"; userMessageId: string }
  | { mode: "append-user-message"; content: string }
  | { mode: "append-controller-message"; content: string; continuationBasis: Record<string, unknown> }
);

export interface StartScienceTurnResult {
  turn: ScienceTurn;
  userMessage: ScienceMessage;
  replayed: boolean;
}

export interface ScienceTurnEvent {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  invocationRunId: string;
  sequence: number;
  kind: ScienceTurnEventKind;
  code: string;
  /** Stable Desktop outbox identity. Null for Science-owned synthetic events. */
  sourceDeliveryId: string | null;
  /** Append-only source runtime event identity carried across process restarts. */
  sourceRunEventId: string | null;
  /** Runtime-observed sequence within invocationRunId. */
  sourceSequence: number | null;
  /** Hash of the redacted source event envelope delivered by Main. */
  sourceEventSha256: string | null;
  payload: Record<string, unknown>;
  delta: string | null;
  createdAt: string;
}

export interface AppendScienceTurnEventInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  sequence: number;
  kind: ScienceTurnEventKind;
  code: string;
  sourceDeliveryId?: string | null;
  sourceRunEventId?: string | null;
  sourceSequence?: number | null;
  sourceEventSha256?: string | null;
  payload: Record<string, unknown>;
  delta?: string | null;
}

export interface AppendScienceTurnEventResult {
  turn: ScienceTurn;
  event: ScienceTurnEvent;
  replayed: boolean;
}

export interface SettleScienceAssistantTurnInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  sequence: number;
  content: string;
  payload: Record<string, unknown>;
}

export interface SettleScienceAssistantTurnResult {
  turn: ScienceTurn;
  message: ScienceMessage;
  event: ScienceTurnEvent;
  replayed: boolean;
}

export const SCIENCE_SOURCE_KINDS = [
  "journal-article",
  "preprint",
  "dataset",
  "database-record",
  "book",
  "patent",
  "software",
  "web",
] as const;
export type ScienceSourceKind = typeof SCIENCE_SOURCE_KINDS[number];

export const SCIENCE_SOURCE_ACCESS_STATES = [
  "metadata-only",
  "retrieved",
  "parsed",
  "evidence-linked",
] as const;
export type ScienceSourceAccessState = typeof SCIENCE_SOURCE_ACCESS_STATES[number];

export interface ScienceSourceVersion {
  id: string;
  sourceId: string;
  version: number;
  accessState: ScienceSourceAccessState;
  contentSha256: string | null;
  mimeType: string | null;
  assetRef: string | null;
  retrievedAt: string | null;
  retrievalMethod: string | null;
  license: string | null;
  createdAt: string;
}

export interface ScienceSource {
  id: string;
  projectId: string;
  kind: ScienceSourceKind;
  canonicalUri: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  publisher: string | null;
  containerTitle: string | null;
  abstract: string | null;
  verificationStatus: "unverified" | "metadata-checked" | "content-checked" | "retracted";
  currentVersion: number;
  version: ScienceSourceVersion;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScienceSourceInput {
  requestId: string;
  projectId: string;
  kind: ScienceSourceKind;
  canonicalUri: string;
  title: string;
  authors: string[];
  publicationYear?: number | null;
  publisher?: string | null;
  containerTitle?: string | null;
  abstract?: string | null;
  accessState: ScienceSourceAccessState;
  contentSha256?: string | null;
  mimeType?: string | null;
  retrievedAt?: string | null;
  retrievalMethod?: string | null;
  license?: string | null;
}

export interface CreateScienceSourceResult {
  source: ScienceSource;
  replayed: boolean;
}

export interface AppendScienceSourceVersionInput {
  requestId: string;
  projectId: string;
  sourceId: string;
  accessState: Exclude<ScienceSourceAccessState, "metadata-only">;
  contentSha256: string;
  mimeType: string;
  retrievedAt: string;
  retrievalMethod: string;
  license?: string | null;
}

export interface AppendScienceSourceVersionResult {
  source: ScienceSource;
  replayed: boolean;
}

export interface PromoteScienceSourceAbstractInput {
  requestId: string;
  projectId: string;
  sourceId: string;
  expectedSourceVersionId: string;
}

export interface PromoteScienceSourceAbstractResult {
  source: ScienceSource;
  evidenceText: string;
  evidenceScope: "abstract-only";
  replayed: boolean;
}

export type ScienceDatasetCell = string | number | boolean | null;

export interface ScienceDatasetTablePayload {
  schema: "agentlas.science-table/v1";
  columns: Array<{
    name: string;
    logicalType: "integer" | "number" | "boolean" | "string";
    nullable: boolean;
  }>;
  rows: Array<Record<string, ScienceDatasetCell>>;
  profile: {
    rowCount: number;
    columnCount: number;
    nullCount: number;
    formulaLikeCellCount: number;
  };
  receipts: {
    parserId: "agentlas.csv-to-table" | "agentlas.comparative-genomics-publication-table" | "agentlas.paired-artifact-table-aligner";
    parserVersion: "1.0.0";
    rawSha256: string;
    headerSha256: string;
    rowsSha256: string;
    tableSha256: string;
  };
}

export interface ScienceResearchRunSourceBinding {
  id: string;
  projectId: string;
  runId: string;
  ordinal: number;
  role: string;
  sourceId: string;
  sourceVersionId: string;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceResearchRunSourceOutputBinding {
  bindingId: string;
  projectId: string;
  runId: string;
  outputId: string;
  outputOrdinal: number;
  outputSha256: string;
  createdAt: string;
}

export interface ImportScienceDatasetCsvInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  title?: string;
}

export interface ImportScienceDatasetCsvResult {
  canceled: false;
  source: ScienceSource;
  run: ScienceResearchRun;
  binding: ScienceResearchRunSourceBinding;
  table: {
    columns: ScienceDatasetTablePayload["columns"];
    profile: ScienceDatasetTablePayload["profile"];
    tableSha256: string;
    outputSha256: string;
  };
  replayed: boolean;
}

export interface CommitScienceDatasetIngestionInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  title: string;
  rawBytes: Uint8Array;
  table: ScienceDatasetTablePayload;
  workerSha256: string;
  environmentSha256: string;
}

export type CommitScienceDatasetIngestionResult = Omit<ImportScienceDatasetCsvResult, "canceled">;

export interface MaterializeScienceDatasetTableInput {
  requestId: string;
  projectId: string;
  runId: string;
  title?: string;
}

export interface MaterializeScienceDatasetTableResult {
  artifact: ScienceArtifact;
  replayed: boolean;
}

export interface RecordScienceSourceCheckInput {
  requestId: string;
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  status: "metadata-checked" | "content-checked" | "retracted";
  code: string;
  summary: string;
}

export interface RecordScienceSourceCheckResult {
  source: ScienceSource;
  replayed: boolean;
}

export interface RecordScienceCitationCheckInput {
  requestId: string;
  projectId: string;
  citationId: string;
  status: "machine-checked" | "human-reviewed";
  code: string;
  summary: string;
}

export interface RecordScienceCitationCheckResult {
  citation: ScienceCitation;
  replayed: boolean;
}

export interface ScienceEvidenceSpan {
  id: string;
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  locator: string;
  startByte: number;
  endByte: number;
  excerpt: string;
  excerptSha256: string;
  createdAt: string;
}

export interface ScienceMessageBlock {
  id: string;
  projectId: string;
  messageId: string;
  ordinal: number;
  kind: "markdown" | "claim" | "artifact" | "run-status";
  content: string;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceCitation {
  id: string;
  projectId: string;
  messageId: string;
  blockId: string;
  sourceId: string;
  sourceVersionId: string;
  evidenceSpanId: string;
  ordinal: number;
  relation: "supports" | "contradicts" | "context";
  verificationStatus: "unverified" | "machine-checked" | "human-reviewed";
  createdAt: string;
}

export interface RecordScienceMessageEvidenceInput {
  requestId: string;
  projectId: string;
  messageId: string;
  blockOrdinal: number;
  blockKind: ScienceMessageBlock["kind"];
  blockContent: string;
  sourceId: string;
  sourceVersionId: string;
  citationOrdinal: number;
  relation: ScienceCitation["relation"];
  locator: string;
  startByte: number;
  endByte: number;
  excerpt: string;
}

export interface RecordScienceMessageEvidenceResult {
  block: ScienceMessageBlock;
  evidence: ScienceEvidenceSpan;
  citation: ScienceCitation;
  replayed: boolean;
}

export type ScienceStagedMessageEvidenceStatus = "pending" | "committed" | "rejected";

export interface ScienceStagedMessageEvidence {
  id: string;
  requestId: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  invocationRunId: string;
  sourceId: string;
  sourceVersionId: string;
  blockOrdinal: number;
  blockKind: ScienceMessageBlock["kind"];
  blockContent: string;
  citationOrdinal: number;
  relation: ScienceCitation["relation"];
  locator: string;
  startByte: number;
  endByte: number;
  excerpt: string;
  inputSha256: string;
  status: ScienceStagedMessageEvidenceStatus;
  messageId: string | null;
  citationId: string | null;
  failureCode: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface StageScienceMessageEvidenceInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  invocationRunId: string;
  blockOrdinal: number;
  blockKind: ScienceMessageBlock["kind"];
  blockContent: string;
  sourceId: string;
  sourceVersionId: string;
  citationOrdinal: number;
  relation: ScienceCitation["relation"];
  locator: string;
  startByte: number;
  endByte: number;
  excerpt: string;
}

export interface StageScienceMessageEvidenceResult {
  stagedEvidence: ScienceStagedMessageEvidence;
  replayed: boolean;
}

export interface ReconcileScienceMessageEvidenceResult {
  committed: ScienceStagedMessageEvidence[];
  rejected: ScienceStagedMessageEvidence[];
}

export interface CreateScienceProjectInput {
  requestId: string;
  /** Opaque Main-issued folder selection. Raw paths are not accepted from the renderer. */
  folderSelectionId?: string;
  question: string;
  title?: string;
  domain: ScienceDomain;
  relatedDomains?: ScienceDomain[];
  researchTemplateId?: ScienceResearchTemplateId;
  initialLabId?: ScienceResearchTemplateId;
  /** Labs to bind at creation, deduplicated in selection order after the active initialLabId. */
  initialLabIds?: ScienceResearchTemplateId[];
}

export type PickScienceProjectFolderResult =
  | { canceled: true }
  | { canceled: false; selectionId: string; path: string };

export interface CreateScienceProjectResult {
  project: ScienceProject;
  conversation: ScienceConversation;
  message: ScienceMessage;
  lifecycle: ScienceResearchLifecycleRevision;
  replayed: boolean;
}

export interface ScienceBootstrap {
  extensionId: "agentlas-science";
  extensionVersion: string;
  schemaVersion: number;
  projects: ScienceProject[];
  rendererPacks: ScienceRendererPackStatus[];
}

export interface ScienceResearchContract {
  id: string;
  projectId: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  objective: string;
  successCriteria: string[];
  failureCriteria: string[];
  constraints: string[];
  /**
   * `full-study` keeps the authoritative loop alive through the lifecycle's
   * journal-ready gate.  `bounded-deliverable` permits completion at the
   * contract's own evidence criteria.  Null is retained for legacy contracts
   * and keeps their pre-scope hash semantics.
   */
  completionScope: ScienceResearchCompletionScope | null;
  maxEpisodes: number;
  maxWallTimeMinutes: number;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SCIENCE_RESEARCH_COMPLETION_SCOPES = ["full-study", "bounded-deliverable"] as const;
export type ScienceResearchCompletionScope = typeof SCIENCE_RESEARCH_COMPLETION_SCOPES[number];

/**
 * The decisions a project can authorize in advance.
 *
 * Each names a point where the product would otherwise wait for a person. `submission-attestation`
 * is deliberately separate from the rest: it is a statement made in the researcher's name to a
 * publisher, so a project has to opt into it explicitly rather than inherit it from a blanket
 * "proceed".
 */
export const SCIENCE_APPROVAL_SCOPES = Object.freeze([
  "research-contract",
  "hypothesis",
  "analysis-plan",
  "journal-identity",
  "submission-attestation",
] as const);
export type ScienceApprovalScope = typeof SCIENCE_APPROVAL_SCOPES[number];

export interface ScienceApprovalPolicy {
  id: string;
  projectId: string;
  revision: number;
  /** `autonomous` lets the scopes below proceed without stopping; `checkpoint` asks every time. */
  mode: "autonomous" | "checkpoint";
  scopes: ScienceApprovalScope[];
  grantedBy: string;
  note: string | null;
  createdAt: string;
}

export interface SetScienceApprovalPolicyInput {
  requestId: string;
  projectId: string;
  mode: "autonomous" | "checkpoint";
  scopes: ScienceApprovalScope[];
  grantedBy: string;
  note?: string | null;
}

export interface SaveScienceResearchContractInput {
  requestId: string;
  projectId: string;
  expectedProjectVersion: number;
  objective: string;
  successCriteria: string[];
  failureCriteria: string[];
  constraints: string[];
  completionScope?: ScienceResearchCompletionScope | null;
  maxEpisodes: number;
  maxWallTimeMinutes: number;
}

export interface SaveScienceResearchContractResult {
  project: ScienceProject;
  contract: ScienceResearchContract;
  replayed: boolean;
}

export interface ApproveScienceResearchContractInput {
  requestId: string;
  projectId: string;
  contractId: string;
  expectedProjectVersion: number;
  expectedContractVersion: number;
}

export interface ApproveScienceResearchContractResult {
  project: ScienceProject;
  contract: ScienceResearchContract;
  replayed: boolean;
}

export interface ScienceHypothesis {
  id: string;
  projectId: string;
  contractId: string;
  parentHypothesisId: string | null;
  version: number;
  role: "primary" | "alternative";
  status: "proposed" | "approved" | "rejected" | "supported" | "contradicted";
  statement: string;
  rationale: string;
  falsificationCriteria: string[];
  evidenceSpanIds: string[];
  episodeResultIds: string[];
  contentSha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposeScienceHypothesisInput {
  requestId: string;
  projectId: string;
  contractId: string;
  role: ScienceHypothesis["role"];
  statement: string;
  rationale: string;
  falsificationCriteria: string[];
  evidenceSpanIds: string[];
  episodeResultIds?: string[];
}

export interface ReviseScienceHypothesisInput {
  requestId: string;
  projectId: string;
  parentHypothesisId: string;
  expectedParentVersion: number;
  expectedParentContentSha256: string;
  role: ScienceHypothesis["role"];
  status: ScienceHypothesis["status"];
  statement: string;
  rationale: string;
  falsificationCriteria: string[];
  evidenceSpanIds: string[];
  episodeResultIds?: string[];
}

export interface WriteScienceHypothesisResult {
  hypothesis: ScienceHypothesis;
  replayed: boolean;
}

export type ScienceLoopStage =
  | "contract-approved"
  | "evidence"
  | "hypothesis"
  | "experiment-design"
  | "preflight"
  | "awaiting-approval"
  | "executing"
  | "evaluating"
  | "deciding"
  | "verifying"
  | "writing";

export interface ScienceLoopSession {
  id: string;
  projectId: string;
  contractId: string;
  contractVersion: number;
  contractContentSha256: string;
  lifecycleStudyId: string;
  lifecycleStartRevision: number;
  lifecycleStartStateSha256: string;
  runtimeChatId: string;
  /** Exact Science-owned orchestrator pin captured for the whole loop. */
  runtimeSelection: RuntimeSelection | null;
  runtimeSelectionSha256: string | null;
  activeRunId: string | null;
  status: "queued" | "running" | "pausing" | "paused" | "completed" | "failed" | "cancelled";
  stage: ScienceLoopStage;
  currentEpisode: number;
  maxEpisodes: number;
  maxWallTimeMinutes: number;
  deadlineAt: string;
  version: number;
  stateSha256: string;
  terminalCode: string | null;
  completionReceiptSetSha256: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScienceLoopEvent {
  id: string;
  projectId: string;
  loopSessionId: string;
  sequence: number;
  kind: "lifecycle" | "reasoning" | "tool" | "message" | "usage" | "error";
  code: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ScienceResearchEpisodeKind =
  | "literature"
  | "simulation"
  | "experiment"
  | "analysis"
  | "verification";

export type ScienceResearchEpisodeStatus =
  | "planned"
  | "running"
  | "waiting-for-decision"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ScienceResearchEpisodeOutcome =
  | "supported"
  | "contradicted"
  | "inconclusive"
  | "not-tested";

export interface ScienceResearchEpisodeToolIntent {
  toolName: string;
  labId: string;
  purpose: string;
}

export interface ScienceResearchEpisodeArtifactBinding {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
}

export interface ScienceResearchEpisodeResult {
  episodeId: string;
  outcome: ScienceResearchEpisodeOutcome;
  observationSummary: string;
  conclusion: string;
  nextAction: string;
  runIds: string[];
  artifacts: ScienceResearchEpisodeArtifactBinding[];
  evidenceSpanIds: string[];
  resultSha256: string;
  createdAt: string;
}

export type ScienceEpisodeResultReviewVerdict = "accepted" | "rejected";

export interface ScienceEpisodeResultReviewArtifactBinding {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
}

export interface ScienceEpisodeResultReviewSelectedAction {
  trigger: string;
  action: string;
  reason: string;
  destinationKind: "lab" | "artifact" | "analysis-plan" | "human-decision" | "manuscript";
  destinationId: string | null;
  requiresHumanDecision: boolean;
}

export interface ScienceEpisodeResultReviewReceipt {
  schema: "agentlas.science.episode-result-review/v1";
  id: string;
  requestId: string;
  projectId: string;
  projectVersion: number;
  projectContentSha256: string;
  loopSessionId: string;
  loopVersion: number;
  loopStateSha256: string;
  episodeId: string;
  episodeVersion: number;
  episodeStateSha256: string;
  resultSha256: string;
  labId: string;
  basisSha256: string;
  projectionSha256: string;
  artifacts: ScienceEpisodeResultReviewArtifactBinding[];
  revision: number;
  previousReviewSha256: string | null;
  verdict: ScienceEpisodeResultReviewVerdict;
  rationale: string;
  selectedNextTrigger: string;
  selectedNextAction: ScienceEpisodeResultReviewSelectedAction;
  selectedNextActionSha256: string;
  reviewerRef: string;
  createdAt: string;
  reviewSha256: string;
}

export interface InspectScienceEpisodeResultReviewInput {
  projectId: string;
  labId: string;
  episodeId: string;
  expectedProjectionSha256: string;
}

export interface ScienceEpisodeResultReviewInspection {
  project: ScienceProject;
  projectContentSha256: string;
  session: ScienceLoopSession;
  episode: ScienceResearchEpisode;
  labId: string;
  basisSha256: string;
  projectionSha256: string;
  boundary: string;
  availableActions: ScienceEpisodeResultReviewSelectedAction[];
  latestReceipt: ScienceEpisodeResultReviewReceipt | null;
}

export interface RecordScienceEpisodeResultReviewInput {
  requestId: string;
  projectId: string;
  loopSessionId: string;
  episodeId: string;
  labId: string;
  expectedProjectVersion: number;
  expectedProjectContentSha256: string;
  expectedLoopVersion: number;
  expectedLoopStateSha256: string;
  expectedEpisodeVersion: number;
  expectedEpisodeStateSha256: string;
  expectedResultSha256: string;
  expectedBasisSha256: string;
  expectedProjectionSha256: string;
  expectedReviewRevision: number;
  expectedReviewSha256: string | null;
  verdict: ScienceEpisodeResultReviewVerdict;
  rationale: string;
  selectedNextTrigger: string;
}

export type RecordScienceEpisodeResultReviewResult =
  | { outcome: "recorded"; receipt: ScienceEpisodeResultReviewReceipt; replayed: boolean }
  | { outcome: "refresh-required"; reason: string; inspection: ScienceEpisodeResultReviewInspection | null; replayed: false };

export interface ScienceResearchEpisode {
  id: string;
  projectId: string;
  loopSessionId: string;
  ordinal: number;
  version: number;
  stateSha256: string;
  status: ScienceResearchEpisodeStatus;
  kind: ScienceResearchEpisodeKind;
  hypothesisId: string;
  hypothesisVersion: number;
  hypothesisContentSha256: string;
  lifecycleStudyId: string;
  lifecycleRevision: number;
  lifecycleStateSha256: string;
  objective: string;
  method: string;
  expectedObservations: string[];
  falsificationCriteria: string[];
  toolIntents: ScienceResearchEpisodeToolIntent[];
  planSha256: string;
  result: ScienceResearchEpisodeResult | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartScienceLoopSessionInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  contractId: string;
  expectedProjectVersion: number;
  expectedContractVersion: number;
  /** Optional for legacy internal callers; new Science UI calls must provide an exact pin. */
  runtimeSelection?: RuntimeSelection | null;
}

export interface StartScienceLoopSessionResult {
  session: ScienceLoopSession;
  replayed: boolean;
}

export interface PlanScienceResearchEpisodeInput {
  requestId: string;
  projectId: string;
  loopSessionId: string;
  expectedLoopVersion: number;
  expectedLoopStateSha256: string;
  hypothesisId: string;
  expectedHypothesisVersion: number;
  expectedHypothesisContentSha256: string;
  kind: ScienceResearchEpisodeKind;
  objective: string;
  method: string;
  expectedObservations: string[];
  falsificationCriteria: string[];
  toolIntents: ScienceResearchEpisodeToolIntent[];
}

export interface PlanScienceResearchEpisodeResult {
  session: ScienceLoopSession;
  episode: ScienceResearchEpisode;
  replayed: boolean;
}

export interface StartScienceResearchEpisodeInput {
  requestId: string;
  projectId: string;
  loopSessionId: string;
  episodeId: string;
  expectedLoopVersion: number;
  expectedLoopStateSha256: string;
  expectedEpisodeVersion: number;
  expectedEpisodeStateSha256: string;
  expectedPlanSha256: string;
}

export interface StartScienceResearchEpisodeResult {
  session: ScienceLoopSession;
  episode: ScienceResearchEpisode;
  replayed: boolean;
}

export interface SettleScienceResearchEpisodeInput {
  requestId: string;
  projectId: string;
  loopSessionId: string;
  episodeId: string;
  expectedLoopVersion: number;
  expectedLoopStateSha256: string;
  expectedEpisodeVersion: number;
  expectedEpisodeStateSha256: string;
  expectedPlanSha256: string;
  status: "succeeded" | "failed" | "cancelled";
  outcome: ScienceResearchEpisodeOutcome;
  observationSummary: string;
  conclusion: string;
  nextAction: string;
  runIds: string[];
  artifacts: ScienceResearchEpisodeArtifactBinding[];
  evidenceSpanIds: string[];
}

export interface SettleScienceResearchEpisodeResult {
  session: ScienceLoopSession;
  episode: ScienceResearchEpisode;
  replayed: boolean;
}

export interface TransitionScienceLoopSessionInput {
  requestId: string;
  projectId: string;
  loopSessionId: string;
  expectedLoopVersion: number;
  expectedLoopStateSha256: string;
  action: "pause" | "resume" | "complete" | "fail" | "cancel";
  reason: string;
}

export interface TransitionScienceLoopSessionResult {
  session: ScienceLoopSession;
  replayed: boolean;
}

export interface ScienceLoopCriterionVerifier {
  method: "research-director-attestation";
  agentId: string;
  agentSlug: string;
  packageVersion: string;
  packageDigest: string;
  systemPromptSha256: string;
  invocationRunId: string;
}

export interface ScienceLoopCriterionVerificationReceipt {
  id: string;
  projectId: string;
  loopSessionId: string;
  contractId: string;
  contractVersion: number;
  contractContentSha256: string;
  criterionIndex: number;
  criterionTextSha256: string;
  receiptVersion: number;
  issuedLoopVersion: number;
  issuedLoopStateSha256: string;
  previousReceiptSha256: string | null;
  verdict: "passed" | "failed" | "inconclusive";
  evidenceSpanIds: string[];
  artifacts: ScienceResearchEpisodeArtifactBinding[];
  verifier: ScienceLoopCriterionVerifier;
  summary: string;
  provenanceSha256: string;
  receiptSha256: string;
  createdAt: string;
}

export interface RecordScienceLoopCriterionVerificationInput {
  requestId: string;
  projectId: string;
  loopSessionId: string;
  expectedLoopVersion: number;
  expectedLoopStateSha256: string;
  criterionIndex: number;
  verdict: ScienceLoopCriterionVerificationReceipt["verdict"];
  evidenceSpanIds: string[];
  artifacts: ScienceResearchEpisodeArtifactBinding[];
  verifier: ScienceLoopCriterionVerifier;
  summary: string;
}

export interface RecordScienceLoopCriterionVerificationResult {
  session: ScienceLoopSession;
  receipt: ScienceLoopCriterionVerificationReceipt;
  replayed: boolean;
}

export const SCIENCE_RESEARCH_RUN_RUNTIMES = [
  "electron-main",
  "electron-web",
  "wasm",
  "python-worker",
  "r-worker",
  "native-sidecar",
] as const;
export type ScienceResearchRunRuntime = typeof SCIENCE_RESEARCH_RUN_RUNTIMES[number];

export interface ScienceResearchRunResource {
  id: string;
  runId: string;
  ordinal: number;
  role: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  blobRef: string;
  artifactId: string | null;
  artifactVersion: number | null;
  createdAt: string;
}

export interface ScienceResearchRunAnalysisPlanBinding {
  analysisSpecId: string;
  version: number;
  contentSha256: string;
}

/**
 * Immutable, project-scoped lineage from one research run to an exact succeeded
 * parent run. `parentRunId` on ScienceResearchRun remains the compatibility
 * pointer to the single primary parent; this collection carries every parent.
 */
export interface ScienceResearchRunParentBinding {
  id: string;
  projectId: string;
  runId: string;
  ordinal: number;
  role: string;
  parentRunId: string;
  parentContentSha256: string;
  createdAt: string;
}

export interface ScienceResearchRunParentBindingInput {
  ordinal: number;
  role: string;
  parentRunId: string;
}

export interface ScienceResearchRun {
  id: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  loopSessionId: string | null;
  parentRunId: string | null;
  toolId: string;
  toolVersion: string;
  runtime: ScienceResearchRunRuntime;
  status: "running" | "succeeded" | "failed" | "cancelled";
  inputManifestSha256: string;
  environmentSha256: string;
  outputManifestSha256: string | null;
  summary: string | null;
  analysisPlan: ScienceResearchRunAnalysisPlanBinding | null;
  inputs: ScienceResearchRunResource[];
  outputs: ScienceResearchRunResource[];
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScienceResearchRunResourceInput {
  role: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  blobRef: string;
  artifactId?: string | null;
  artifactVersion?: number | null;
}

export interface ScienceRunBlobReceipt {
  blobRef: string;
  sha256: string;
  byteSize: number;
}

export interface ScienceToolArtifactOutputEnvelope {
  schema: "agentlas.science-tool-artifact-output/v1";
  artifact: {
    kind: ScienceArtifactKind;
    title: string;
    rendererId: ScienceRendererId;
    rendererVersion: string;
    payload: Record<string, unknown>;
    semantic: ScienceArtifactSemanticSnapshot;
  };
}

/**
 * A worker-produced artifact candidate. Renderer authority is deliberately
 * absent: Main pins the signed renderer binding before the worker starts and
 * the store applies that immutable plan while committing the candidate.
 */
export interface ScienceToolArtifactCandidateEnvelope {
  schema: "agentlas.science-tool-artifact-candidate/v2";
  artifact: {
    kind: ScienceArtifactKind;
    title: string;
    rendererId: ScienceRendererId;
    payload: Record<string, unknown>;
    semantic: ScienceArtifactSemanticSnapshot;
  };
}

export interface ScienceRunArtifactBinding {
  id: string;
  projectId: string;
  runId: string;
  outputId: string;
  outputOrdinal: number;
  outputSha256: string;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  createdAt: string;
}

export interface CommitScienceRunArtifactInput {
  requestId: string;
  projectId: string;
  runId: string;
  outputOrdinal: number;
  codeSha256: string;
  labId?: string;
}

export interface CommitScienceRunArtifactResult {
  artifact: ScienceArtifact;
  binding: ScienceRunArtifactBinding;
  replayed: boolean;
}

export interface CreateScienceResearchRunInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  loopSessionId?: string | null;
  parentRunId?: string | null;
  /**
   * Optional explicit multi-parent lineage. When present, exactly one `primary`
   * binding must match `parentRunId`. Legacy callers may keep passing only
   * `parentRunId`; the store synthesizes its immutable primary binding.
   */
  parentBindings?: ScienceResearchRunParentBindingInput[];
  toolId: string;
  toolVersion: string;
  runtime: ScienceResearchRunRuntime;
  inputManifestSha256: string;
  environmentSha256: string;
  analysisPlan?: ScienceResearchRunAnalysisPlanBinding | null;
  inputs: ScienceResearchRunResourceInput[];
}

export interface CreateScienceResearchRunResult {
  run: ScienceResearchRun;
  replayed: boolean;
}

export interface CompleteScienceResearchRunInput {
  requestId: string;
  projectId: string;
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  outputManifestSha256: string;
  summary: string;
  outputs: ScienceResearchRunResourceInput[];
}

export interface CompleteScienceResearchRunResult {
  run: ScienceResearchRun;
  replayed: boolean;
}

export const SCIENCE_TOOL_EXECUTION_PHASES = [
  "reserved",
  "spawned",
  "outputs-staged",
  "run-completed",
  "committed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type ScienceToolExecutionPhase = typeof SCIENCE_TOOL_EXECUTION_PHASES[number];

export interface ScienceToolExecution {
  id: string;
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId: string | null;
  invocationRunId: string | null;
  toolCallId: string;
  runId: string;
  toolId: string;
  toolVersion: string;
  workerSha256: string;
  environmentSha256: string;
  inputManifestSha256: string;
  outputManifestSha256: string | null;
  outputBlobRef: string | null;
  outputSha256: string | null;
  outputByteSize: number | null;
  outputOrdinal: number;
  labId: string;
  processPid: number | null;
  artifactId: string | null;
  artifactVersion: number | null;
  phase: ScienceToolExecutionPhase;
  failureCode: string | null;
  spawnedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScienceToolMaterializationPlan {
  schema: "agentlas.science-tool-materialization-plan/v1";
  executionId: string;
  projectId: string;
  authorityMode: "core" | "signed-pack";
  artifactKind: ScienceArtifactKind;
  rendererId: ScienceRendererId;
  rendererVersion: string;
  rendererBinding: import("./science-renderer-runtime").ScienceRendererBinding | null;
  rendererBindingSha256: string | null;
  executorBinding: import("./science-renderer-runtime").ScienceRendererExecutorBinding | null;
  executorBindingSha256: string | null;
  outputOrdinal: number;
  outputRole: string;
  outputMimeType: string;
  labId: string;
  planSha256: string;
  createdAt: string;
}

export interface ScienceToolMaterializationPlanInput {
  authorityMode: ScienceToolMaterializationPlan["authorityMode"];
  artifactKind: ScienceToolMaterializationPlan["artifactKind"];
  rendererId: ScienceToolMaterializationPlan["rendererId"];
  rendererVersion: string;
  rendererBinding: import("./science-renderer-runtime").ScienceRendererBinding | null;
  executorBinding: import("./science-renderer-runtime").ScienceRendererExecutorBinding | null;
  outputOrdinal: number;
  outputRole: string;
  outputMimeType: string;
  labId: string;
}

export interface ReserveScienceToolExecutionInput {
  requestId: string;
  toolCallId: string;
  turnId?: string | null;
  invocationRunId?: string | null;
  workerSha256: string;
  outputOrdinal: number;
  labId: string;
  materializationPlan: ScienceToolMaterializationPlanInput;
  run: CreateScienceResearchRunInput;
}

export interface ReserveScienceToolExecutionResult {
  execution: ScienceToolExecution;
  run: ScienceResearchRun;
  materializationPlan: ScienceToolMaterializationPlan;
  replayed: boolean;
}

export const SCIENCE_ARTIFACT_KINDS = [
  "chart.vega",
  "chart.numeric-3d",
  "literature.citation-network",
  "astronomy.sky-catalog",
  "genomics.variant-track",
  "phylogeny.radial",
  "protein.structure",
  "chemistry.document",
  "table",
  "image",
] as const;
export type ScienceArtifactKind = typeof SCIENCE_ARTIFACT_KINDS[number];

export const SCIENCE_RENDERER_IDS = [
  "agentlas.vega",
  "agentlas.three-numeric",
  "agentlas.cytoscape",
  "agentlas.d3-sky",
  "agentlas.jbrowse",
  "agentlas.molstar",
  "agentlas.ketcher",
  "agentlas.table",
  "agentlas.image",
] as const;
export type ScienceRendererId = typeof SCIENCE_RENDERER_IDS[number];

export interface ScienceArtifactSemanticSnapshot {
  title: string;
  summary: string;
  entities: Array<{
    id: string;
    label: string;
    type: string;
  }>;
  observations: Array<{
    label: string;
    value: string | number;
    unit: string | null;
  }>;
  warnings: string[];
}

export interface ScienceArtifactProvenance {
  sourceRunId: string | null;
  sourceRefs: string[];
  datasetSha256: string[];
  codeSha256: string | null;
  environmentSha256: string | null;
}

export const SCIENCE_ARTIFACT_ORIGIN_SURFACES = ["conversation", "lab", "loop", "legacy"] as const;
export type ScienceArtifactOriginSurface = typeof SCIENCE_ARTIFACT_ORIGIN_SURFACES[number];

export interface ScienceArtifactOrigin {
  surface: ScienceArtifactOriginSurface;
  conversationId: string | null;
  messageId: string | null;
  loopSessionId: string | null;
  runId: string | null;
  branchId: string | null;
}

export interface ScienceArtifactVersionReference {
  artifactId: string;
  version: number;
}

export interface ScienceArtifactLinkageInput {
  labId: string;
  origin: ScienceArtifactOrigin;
  parent: ScienceArtifactVersionReference | null;
  inputs: ScienceArtifactVersionReference[];
}

export interface ScienceArtifactLinkage extends ScienceArtifactLinkageInput {
  schema: "agentlas.science-artifact-linkage/v1";
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  rendererId: ScienceRendererId;
  linkageSha256: string;
  createdAt: string;
}

export interface ScienceArtifactContext {
  artifact: ScienceArtifact;
  selectedVersion: ScienceArtifactVersion;
  linkage: ScienceArtifactLinkage;
  isCurrent: boolean;
}

export interface ScienceConversationArtifactEvent {
  id: string;
  projectId: string;
  conversationId: string;
  messageId: string;
  turnId: string | null;
  artifactId: string;
  originArtifactVersion: number;
  artifactVersion: number;
  parentArtifactVersion: number;
  labId: string;
  kind: "version-saved";
  contentSha256: string;
  createdAt: string;
}

export interface ScienceConversationArtifactRoute {
  schema: "agentlas.science-conversation-artifact-route/v1";
  projectId: string;
  conversationId: string;
  messageId: string;
  artifactId: string;
  originArtifactVersion: number;
  currentArtifactVersion: number;
  artifactKind: ScienceArtifactKind;
  rendererId: ScienceRendererId;
  rendererVersion: string;
  labId: string;
  linkageSha256: string;
}

export interface ScienceArtifactVersionHistoryEntry {
  artifactId: string;
  version: number;
  rendererId: ScienceRendererId;
  rendererVersion: string;
  semanticTitle: string;
  semanticSummary: string;
  contentSha256: string;
  createdAt: string;
  linkage: ScienceArtifactLinkage;
  isCurrent: boolean;
  hasVisualCapture: boolean;
}

export interface ScienceArtifactVersionHistory {
  schema: "agentlas.science-artifact-version-history/v1";
  projectId: string;
  artifactId: string;
  currentVersion: number;
  entries: ScienceArtifactVersionHistoryEntry[];
}

export interface ScienceArtifactDiffEndpoint {
  version: number;
  contentSha256: string;
  linkageSha256: string;
  semanticSha256: string;
  provenanceSha256: string;
  rendererBindingSha256: string | null;
}

export interface ScienceArtifactStructuralChange {
  path: string;
  kind: "added" | "removed" | "replaced";
  category: "atom" | "bond" | "layout" | "document" | "data" | "transform" | "scale" | "axis" | "mark" | "config" | "structure" | "representation" | "metadata" | "other";
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface ScienceChemistryArtifactDiffDetail {
  kind: "chemistry";
  classification: "none" | "serialization-only" | "same-identity-document-change" | "chemical-identity-change";
  ketSha256: { from: string; to: string };
  canonicalKetSha256: { from: string; to: string };
  canonicalSmilesSha256: { from: string; to: string };
  atomCount: { from: number; to: number; delta: number };
  bondCount: { from: number; to: number; delta: number };
}

export interface ScienceVegaArtifactDiffDetail {
  kind: "vega";
  specSha256: { from: string; to: string };
  categoryCounts: Record<string, number>;
}

export interface ScienceProteinStructureArtifactDiffDetail {
  kind: "protein-structure";
  from: {
    sourceId: string;
    sourceVersionId: string;
    contentSha256: string;
    format: "pdb" | "mmcif";
    representation: "cartoon" | "ball-and-stick" | "surface";
    colorTheme: "chain-id" | "element-symbol" | "secondary-structure";
    interactionSha256: string | null;
    selectedResidueCount: number;
    focusResidue: string | null;
  };
  to: {
    sourceId: string;
    sourceVersionId: string;
    contentSha256: string;
    format: "pdb" | "mmcif";
    representation: "cartoon" | "ball-and-stick" | "surface";
    colorTheme: "chain-id" | "element-symbol" | "secondary-structure";
    interactionSha256: string | null;
    selectedResidueCount: number;
    focusResidue: string | null;
  };
  structureBytesChanged: boolean;
  sourceBindingChanged: boolean;
  formatChanged: boolean;
  representationChanged: boolean;
  colorThemeChanged: boolean;
  interactionChanged: boolean;
  focusChanged: boolean;
  addedResidues: string[];
  removedResidues: string[];
}

export interface ScienceArtifactVersionDiff {
  schema: "agentlas.science-artifact-version-diff/v1";
  algorithmVersion: 1;
  projectId: string;
  artifactId: string;
  artifactKind: ScienceArtifactKind;
  rendererId: ScienceRendererId;
  from: ScienceArtifactDiffEndpoint;
  to: ScienceArtifactDiffEndpoint;
  classification: "identical" | "metadata-only" | "scientific-change";
  changeCount: number;
  emittedChangeCount: number;
  omittedChangeCount: number;
  truncated: boolean;
  changes: ScienceArtifactStructuralChange[];
  detail: ScienceChemistryArtifactDiffDetail | ScienceVegaArtifactDiffDetail | ScienceProteinStructureArtifactDiffDetail;
  diffSha256: string;
}

export interface ScienceLabSummary {
  labId: string;
  bindingId: string;
  enabled: boolean;
  pinned: boolean;
  displayOrder: number;
  activatedBy: ScienceProjectLabActivator;
  config: Record<string, unknown>;
  artifactCount: number;
  versionCount: number;
  updatedAt: string | null;
}

export interface ScienceArtifactVersion {
  id: string;
  artifactId: string;
  version: number;
  rendererId: ScienceRendererId;
  rendererVersion: string;
  rendererBinding: import("./science-renderer-runtime").ScienceRendererBinding | null;
  payload: Record<string, unknown>;
  semantic: ScienceArtifactSemanticSnapshot;
  provenance: ScienceArtifactProvenance;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceArtifact {
  id: string;
  projectId: string;
  loopSessionId: string | null;
  sourceRunId: string | null;
  kind: ScienceArtifactKind;
  title: string;
  status: "ready" | "failed";
  currentVersion: number;
  version: ScienceArtifactVersion;
  createdAt: string;
  updatedAt: string;
}

export interface MaterializeScienceStatisticsFigureInput {
  requestId: string;
  projectId: string;
  statisticsArtifactId: string;
  statisticsArtifactVersion: number;
  statisticsArtifactContentSha256: string;
  visualizationIndex: number;
  title?: string;
}

export interface MaterializeScienceStatisticsFigureResult {
  artifact: ScienceArtifact;
  payload: ScienceStatisticsFigureArtifactPayload;
  parent: {
    artifactId: string;
    artifactVersion: number;
    contentSha256: string;
  };
  replayed: boolean;
}

export interface MaterializeScienceStatisticsNumericSurfaceInput {
  requestId: string;
  projectId: string;
  statisticsArtifactId: string;
  statisticsArtifactVersion: number;
  statisticsArtifactContentSha256: string;
  sourceArtifactIndex: number;
}

export interface MaterializeScienceStatisticsNumericSurfaceResult {
  artifact: ScienceArtifact;
  payload: ScienceNumericSurfaceV2ArtifactPayload;
  parent: {
    artifactId: string;
    artifactVersion: number;
    contentSha256: string;
  };
  source: {
    artifactIndex: number;
    artifactSha256: string;
  };
  replayed: boolean;
}

export interface ExportScienceStatisticsFigureSvgInput {
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
}

export interface ExportScienceStatisticsFigureSvgResult {
  schema: "agentlas.science.statistics-figure-svg-export/v1";
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  mimeType: "image/svg+xml";
  renderer: { id: "agentlas.vega"; version: string };
  sourceSpecSha256: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  svg: string;
  exportArtifact: {
    id: string;
    version: number;
    kind: "image";
    contentSha256: string;
    captureId: string;
    captureSha256: string;
    exportSha256: string;
    exportReceiptSha256: string;
  };
  replayed: boolean;
}

export interface ExportScienceStatisticsFigurePngInput extends ExportScienceStatisticsFigureSvgInput {
  dpi: 300 | 600;
  widthMm?: number;
}

export interface ExportScienceStatisticsFigurePngResult {
  schema: "agentlas.science.statistics-figure-png-export/v1";
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  mimeType: "image/png";
  renderer: { id: "agentlas.vega"; version: string };
  sourceSpecSha256: string;
  sourceSvgSha256: string;
  exportProfile: "journal-raster-300dpi" | "journal-raster-600dpi";
  dpi: 300 | 600;
  widthMm: number;
  heightMm: number;
  width: number;
  height: number;
  colorSpace: "srgb";
  background: "#ffffff";
  byteSize: number;
  sha256: string;
  dataBase64: string;
}

export interface ExportScienceStatisticsFigurePublicationBinaryInput extends ExportScienceStatisticsFigureSvgInput {
  dpi: 300 | 600;
  widthMm?: number;
  colorSpace?: "srgb";
}

interface ExportScienceStatisticsFigurePublicationBinaryResult {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  renderer: { id: "agentlas.vega"; version: string };
  sourceSpecSha256: string;
  sourceSvgSha256: string;
  dpi: 300 | 600;
  requestedWidthMm: number;
  widthMm: number;
  heightMm: number;
  width: number;
  height: number;
  colorSpace: "srgb";
  iccProfileSha256: string;
  background: "#ffffff";
  byteSize: number;
  sha256: string;
  dataBase64: string;
}

export interface ExportScienceStatisticsFigurePdfResult extends ExportScienceStatisticsFigurePublicationBinaryResult {
  schema: "agentlas.science.statistics-figure-pdf-export/v1";
  mimeType: "application/pdf";
  exportProfile: "journal-raster-pdf-300dpi" | "journal-raster-pdf-600dpi";
  pdfVersion: "1.7";
  imageEncoding: "flate-rgb8";
  fontEmbedding: "not-applicable-rasterized";
}

export interface ExportScienceStatisticsFigureTiffResult extends ExportScienceStatisticsFigurePublicationBinaryResult {
  schema: "agentlas.science.statistics-figure-tiff-export/v1";
  mimeType: "image/tiff";
  exportProfile: "journal-raster-tiff-300dpi" | "journal-raster-tiff-600dpi";
  bitsPerSample: 8;
  samplesPerPixel: 3;
  compression: "lzw";
}

export interface PersistScienceStatisticsFigurePngInput {
  requestId: string;
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  rendered: Omit<ExportScienceStatisticsFigurePngResult, "artifactId" | "artifactVersion" | "contentSha256">;
  png: Uint8Array;
}

export interface PersistScienceStatisticsFigurePngResult {
  artifact: ScienceArtifact;
  payload: ScienceStatisticsFigureRasterArtifactPayload;
  visualCapture: ScienceArtifactVisualCapture;
  parent: ScienceStatisticsInputArtifactBindingLike;
  replayed: boolean;
}

export interface PersistScienceNumericSurfacePngInput {
  requestId: string;
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  rendered: ScienceNumericSurfacePngExport;
  png: Uint8Array;
}

export interface PersistScienceNumericSurfacePngResult {
  artifact: ScienceArtifact;
  payload: ScienceNumericSurfaceRasterArtifactPayload;
  visualCapture: ScienceArtifactVisualCapture;
  parent: ScienceStatisticsInputArtifactBindingLike;
  replayed: boolean;
}

type ScienceStatisticsInputArtifactBindingLike = {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
};

export interface CreateScienceArtifactInput {
  projectId: string;
  loopSessionId?: string | null;
  sourceRunId?: string | null;
  kind: ScienceArtifactKind;
  title: string;
  rendererId: ScienceRendererId;
  rendererVersion: string;
  rendererBinding?: import("./science-renderer-runtime").ScienceRendererBinding | null;
  payload: Record<string, unknown>;
  semantic: ScienceArtifactSemanticSnapshot;
  provenance: ScienceArtifactProvenance;
  linkage?: ScienceArtifactLinkageInput;
}

export interface AppendScienceArtifactVersionInput {
  requestId: string;
  projectId: string;
  artifactId: string;
  expectedArtifactVersion: number;
  expectedContentSha256: string;
  payload: Record<string, unknown>;
  semantic: ScienceArtifactSemanticSnapshot;
  provenance: ScienceArtifactProvenance;
  linkage?: ScienceArtifactLinkageInput;
  actionContext?: {
    conversationId: string;
    originMessageId: string;
    turnId: string;
  };
}

export interface AppendScienceArtifactVersionResult {
  artifact: ScienceArtifact;
  replayed: boolean;
}

export interface ScienceArtifactVisualCapture {
  id: string;
  assetRef: string;
  mimeType: "image/png";
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  contentSha256: string;
  artifactVersion: number;
  renderRequestId: string;
  rendererBinding: import("./science-renderer-runtime").ScienceRendererBinding | null;
  sceneRevision: string | null;
  renderContext: {
    electronVersion: string;
    chromiumVersion: string;
    platform: string;
    architecture: string;
    locale: string;
    colorScheme: "light" | "dark";
    captureMethod?: "cdp-staged-origin-clip";
    deviceScaleFactor: number;
    cssWidth: number;
    cssHeight: number;
    pixelWidth: number;
    pixelHeight: number;
  };
  renderContextSha256: string;
  capturedAt: string;
}

export interface ScienceArtifactVisualPreview {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  mimeType: "image/png";
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  bytes: Uint8Array;
}

export interface CaptureScienceArtifactInput {
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
}

/**
 * Model-facing review input. A renderer is considered visually observed only
 * when both the structured semantic layer and an exact pixel capture exist.
 */
export interface ScienceArtifactObservationBundle {
  schema: "agentlas.science-artifact-observation/v1";
  artifactId: string;
  artifactVersion: number;
  rendererId: ScienceRendererId;
  rendererVersion: string;
  rendererBinding: import("./science-renderer-runtime").ScienceRendererBinding | null;
  contentSha256: string;
  semantic: ScienceArtifactSemanticSnapshot;
  provenance: ScienceArtifactProvenance;
  visualCapture: ScienceArtifactVisualCapture | null;
  visualReviewEligible: boolean;
}

export interface ScienceSourceFigure {
  id: string;
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  locator: string;
  pageNumber: number | null;
  figureLabel: string;
  caption: string;
  captionSha256: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  byteSize: number;
  assetSha256: string;
  assetRef: string;
  license: string | null;
  rightsNote: string | null;
  createdAt: string;
}

export interface RecordScienceSourceFigureInput {
  requestId: string;
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  locator: string;
  pageNumber?: number | null;
  figureLabel: string;
  caption: string;
  mimeType: ScienceSourceFigure["mimeType"];
  width: number;
  height: number;
  assetSha256: string;
  license?: string | null;
  rightsNote?: string | null;
}

export interface RecordScienceSourceFigureResult {
  figure: ScienceSourceFigure;
  replayed: boolean;
}

export interface ScienceArtifactValidationReceipt {
  id: string;
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  artifactLinkageSha256: string;
  visualCaptureId: string;
  visualAssetSha256: string;
  researchRunId: string;
  validatorId: string;
  validatorVersion: string;
  policyId: string;
  policyVersion: string;
  status: "verified" | "warning" | "rejected";
  checks: string[];
  warnings: string[];
  challengeSha256: string;
  inputSha256: string;
  environmentSha256: string;
  receiptSha256: string;
  createdAt: string;
}

/**
 * Immutable companion closure for publication validators that prove which
 * exact succeeded-run output produced the validated artifact version. Older
 * validation receipts may legitimately have no companion row; validator v2
 * and later must require one before replaying or binding the receipt.
 */
export interface ScienceArtifactValidationRunArtifactBinding {
  receiptId: string;
  projectId: string;
  runArtifactBindingId: string;
  runId: string;
  outputId: string;
  outputOrdinal: number;
  outputRole: string;
  outputSha256: string;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  createdAt: string;
}

export interface RecordScienceArtifactValidationInput {
  requestId: string;
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  validatorId: string;
  validatorVersion: string;
  policyId: string;
  policyVersion: string;
  status: ScienceArtifactValidationReceipt["status"];
  checks: string[];
  warnings: string[];
  challengeSha256: string;
  inputSha256: string;
  environmentSha256: string;
  /**
   * When supplied, the store must atomically persist an immutable companion
   * row derived from this binding and the exact run output. Callers may not
   * supply any of the derived closure fields themselves.
   */
  runArtifactBindingId?: string;
}

export interface RecordScienceArtifactValidationResult {
  receipt: ScienceArtifactValidationReceipt;
  runArtifactBinding?: ScienceArtifactValidationRunArtifactBinding;
  replayed: boolean;
}

export const SCIENCE_ANALYSIS_SPEC_SCHEMA = "agentlas.science.analysis-spec.v1" as const;
export const SCIENCE_DECISION_SCHEMA = "agentlas.science.decision.v1" as const;

export interface ScienceAnalysisArtifactRef {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
}

export interface ScienceAnalysisAcquisitionPlan {
  strategy: "acquire-before-execution";
  sources: Array<{
    provider: string;
    sourceRefs: string[];
    retrievalPlan: string;
    expectedArtifactKind: string;
  }>;
}

export interface ScienceEstimand {
  population: string;
  treatmentOrExposure: string;
  comparator: string | null;
  outcome: string;
  summaryMeasure: string;
  timeHorizon: string | null;
}

export type ScienceDependenceStructure =
  | { kind: "unresolved" }
  | { kind: "independent" }
  | { kind: "repeated"; subjectIdVariable: string; timeVariable: string | null }
  | { kind: "clustered"; clusterVariables: string[] }
  | { kind: "repeated-and-clustered"; subjectIdVariable: string; timeVariable: string | null; clusterVariables: string[] };

export const SCIENCE_ANALYSIS_MODEL_FAMILIES = [
  "lm",
  "glm",
  "mixed-effects",
  "gee",
  "pca",
  "time-series-diagnostics",
  // Added with the extension method registry. Additive only: existing frozen AnalysisSpec documents
  // keep resolving, and a plan may still classify a survival or categorical model as "glm" as the
  // core methods do. These names let a plan say what it actually is instead of the nearest fit.
  "lmm",
  "nonparametric",
  "survival",
  "categorical",
  "meta-analysis",
  "rank-test",
  "classification-evaluation",
  "diagnostic-accuracy",
  "mixed-models",
] as const;
export type ScienceAnalysisModelFamily = typeof SCIENCE_ANALYSIS_MODEL_FAMILIES[number];

export interface ScienceAnalysisModelSpec {
  family: ScienceAnalysisModelFamily;
  formula: string;
  distribution: string | null;
  link: string | null;
  groupingVariables: string[];
  randomEffects: string[];
  rationale: string;
}

export interface ScienceAnalysisSpecDocument {
  schemaVersion: typeof SCIENCE_ANALYSIS_SPEC_SCHEMA;
  purpose: "confirmatory";
  researchQuestion: string;
  population: string;
  estimand: ScienceEstimand | null;
  design: {
    studyType: "randomized-experiment" | "observational" | "quasi-experiment" | "simulation";
    experimentalUnit: string | null;
    observationUnit: string;
    dependence: ScienceDependenceStructure;
  };
  data: {
    inputs: ScienceAnalysisArtifactRef[];
    /**
     * Present on plans approved before collection. Execution still requires a successor plan whose
     * `inputs` bind exact immutable artifact versions; this field specifies what may be acquired and
     * never acts as an execution-time data binding by itself. Absent only on legacy v1 documents.
     */
    acquisition?: ScienceAnalysisAcquisitionPlan | null;
    outcomeVariables: string[];
    predictorVariables: string[];
    transformations: string[];
    exclusions: string[];
  };
  model: ScienceAnalysisModelSpec | null;
  missingData: {
    strategy: "unresolved" | "complete-case" | "multiple-imputation" | "model-based" | "not-applicable";
    rationale: string;
  };
  multiplicity: {
    strategy: "unresolved" | "none" | "fdr" | "fwer";
    families: string[];
    rationale: string;
  };
  requiredDiagnostics: string[];
  sensitivityAnalyses: string[];
  seed: { algorithm: "fixed"; value: number };
  runtimePolicy: {
    network: "deny";
    maxWallTimeMinutes: number;
    maxCpuCores: number;
    maxRamMb: number;
  };
  expectedArtifacts: Array<{ role: "result-table" | "figure" | "diagnostics" | "methods"; title: string }>;
}

export interface ScienceAnalysisSpecVersion {
  id: string;
  analysisSpecId: string;
  projectId: string;
  version: number;
  document: ScienceAnalysisSpecDocument;
  documentSha256: string;
  createdBy: "user" | "assistant" | "decision";
  originDecisionId: string | null;
  createdAt: string;
}

export interface ScienceAnalysisPlanReviewReceipt {
  id: string;
  requestId: string;
  projectId: string;
  analysisSpecId: string;
  analysisSpecVersion: number;
  analysisSpecContentSha256: string;
  analysisSpecLockVersion: number;
  decision: "approve" | "revise";
  rationale: string | null;
  actor: "human" | "standing-policy";
  /** Present only for a host-authorized standing approval; never a human click. */
  approvalPolicy?: {
    id: string;
    revision: number;
    grantedBy: string;
    contentSha256: string;
  };
  resultingStatus: "draft" | "frozen";
  createdAt: string;
  receiptSha256: string;
}

export interface ScienceAnalysisSpec {
  id: string;
  projectId: string;
  title: string;
  status: "draft" | "frozen";
  currentVersion: number;
  currentDocumentSha256: string;
  lockVersion: number;
  version: ScienceAnalysisSpecVersion;
  latestReview: ScienceAnalysisPlanReviewReceipt | null;
  frozenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ScienceAnalysisDecisionEffect =
  | { kind: "set-estimand"; value: ScienceEstimand }
  | { kind: "set-dependence"; value: Exclude<ScienceDependenceStructure, { kind: "unresolved" }> };

export interface ScienceAnalysisDecisionOptionDraft {
  id: string;
  label: string;
  description: string;
  benefits: string[];
  risks: string[];
  downstreamImpact: string;
  reversible: boolean;
  recommended: boolean;
  effect: ScienceAnalysisDecisionEffect;
}

export interface ScienceAnalysisDecisionDraft {
  decisionKey: "analysis.estimand" | "analysis.dependence-structure";
  mergeKey: string;
  prompt: {
    title: string;
    question: string;
    whyAsked: string;
    impactIfUnanswered: string;
  };
  evidenceRefs: Array<
    | { kind: "analysis-spec-version" }
    | ({ kind: "artifact-version" } & ScienceAnalysisArtifactRef)
    | { kind: "evidence-span"; evidenceSpanId: string }
  >;
  options: ScienceAnalysisDecisionOptionDraft[];
  recommendationRationale: string;
  recommendationConfidence: number;
  recommendationAssumptions: string[];
  unaffectedNodeIds: string[];
}

export interface ScienceDecisionOption extends ScienceAnalysisDecisionOptionDraft {
  ordinal: number;
  effectSha256: string;
}

export interface ScienceDecisionRequest {
  schemaVersion: typeof SCIENCE_DECISION_SCHEMA;
  id: string;
  projectId: string;
  analysisSpecId: string;
  basisVersion: number;
  basisContentSha256: string;
  decisionKey: ScienceAnalysisDecisionDraft["decisionKey"];
  mergeKey: string;
  prompt: ScienceAnalysisDecisionDraft["prompt"];
  evidenceRefs: ScienceAnalysisDecisionDraft["evidenceRefs"];
  options: ScienceDecisionOption[];
  recommendation: { optionId: string; rationale: string; confidence: number; assumptions: string[] };
  dependencies: { blockedNodeIds: string[]; unaffectedNodeIds: string[] };
  preconditions: Array<{ path: "/estimand" | "/design/dependence"; valueSha256: string }>;
  preconditionSha256: string;
  proposalSha256: string;
  status: "queued" | "presented" | "deferred" | "applied" | "superseded" | "expired" | "cancelled";
  lockVersion: number;
  deferUntil: string | null;
  presentedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProposeScienceAnalysisPlanInput {
  requestId: string;
  projectId: string;
  title: string;
  document: ScienceAnalysisSpecDocument;
  decisions: ScienceAnalysisDecisionDraft[];
}

export interface ProposeScienceAnalysisPlanResult {
  analysisSpec: ScienceAnalysisSpec;
  decisions: ScienceDecisionRequest[];
  replayed: boolean;
}

export interface PresentScienceDecisionInput {
  requestId: string;
  projectId: string;
  decisionId: string;
  expectedLockVersion: number;
}

export interface DeferScienceDecisionInput extends PresentScienceDecisionInput {
  deferUntil: string | null;
}

export interface AnswerScienceDecisionInput {
  requestId: string;
  projectId: string;
  decisionId: string;
  optionId: string;
  expectedDecisionLockVersion: number;
  expectedAnalysisSpecVersion: number;
  expectedAnalysisSpecContentSha256: string;
  rationale?: string | null;
}

export type AnswerScienceDecisionResult =
  | { outcome: "applied"; decision: ScienceDecisionRequest; analysisSpec: ScienceAnalysisSpec; replayed: boolean }
  | { outcome: "refresh-required" | "expired"; decision: ScienceDecisionRequest; analysisSpec: ScienceAnalysisSpec; replayed: boolean };

export interface FreezeScienceAnalysisSpecInput {
  requestId: string;
  projectId: string;
  analysisSpecId: string;
  expectedVersion: number;
  expectedContentSha256: string;
  expectedLockVersion: number;
}

export interface FreezeScienceAnalysisSpecResult {
  analysisSpec: ScienceAnalysisSpec;
  replayed: boolean;
}

export interface ReviewScienceAnalysisPlanInput {
  requestId: string;
  projectId: string;
  analysisSpecId: string;
  expectedVersion: number;
  expectedContentSha256: string;
  expectedLockVersion: number;
  decision: "approve" | "revise";
  rationale?: string | null;
}

export interface ReviewScienceAnalysisPlanResult {
  receipt: ScienceAnalysisPlanReviewReceipt;
  analysisSpec: ScienceAnalysisSpec;
  replayed: boolean;
}

export interface ScienceManuscriptBinding {
  id: string;
  projectId: string;
  manuscriptVersionId: string;
  ordinal: number;
  role: "claim" | "citation" | "figure" | "table" | "supplement";
  locator: string;
  target:
    | { kind: "citation"; citationId: string }
    | { kind: "source-figure"; sourceFigureId: string }
    | { kind: "artifact"; artifactId: string; artifactVersion: number; captureId: string; validationReceiptId: string };
  createdAt: string;
}

export interface ScienceManuscriptVersion {
  id: string;
  manuscriptId: string;
  version: number;
  markdown: string;
  contentSha256: string;
  /** Structured editor state. Absent only on manuscripts created before the document-IDE migration. */
  document?: ScienceManuscriptDocument;
  /** Integrity hash of `document`; distinct from the renderer-facing Markdown content hash. */
  documentSha256?: string;
  /** Fresh baseline identity epoch; never inferred by matching legacy Markdown content. */
  identityEpoch?: string;
  bindingManifestSha256: string;
  bindings: ScienceManuscriptBinding[];
  blueprintBinding?: import("./science-manuscript-blueprint").ScienceManuscriptBlueprintBinding;
  createdAt: string;
}

export interface ScienceManuscript {
  id: string;
  projectId: string;
  title: string;
  status: "draft" | "review" | "accepted" | "exported";
  currentVersion: number;
  version: ScienceManuscriptVersion;
  createdAt: string;
  updatedAt: string;
}

export type ScienceManuscriptBindingInput = Omit<ScienceManuscriptBinding, "id" | "projectId" | "manuscriptVersionId" | "createdAt">;

export interface CreateScienceManuscriptInput {
  requestId: string;
  projectId: string;
  title: string;
  markdown: string;
  /** Optional structured baseline. When present, its deterministic serialization must equal `markdown`. */
  document?: ScienceManuscriptDocument;
  bindings: ScienceManuscriptBindingInput[];
  blueprintBinding?: import("./science-manuscript-blueprint").ScienceManuscriptBlueprintBindingInput;
}

export interface CreateScienceManuscriptResult {
  manuscript: ScienceManuscript;
  replayed: boolean;
}

export interface AppendScienceManuscriptVersionInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedVersion: number;
  expectedContentSha256: string;
  markdown: string;
  /** Optional structured next version. When present, its deterministic serialization must equal `markdown`. */
  document?: ScienceManuscriptDocument;
  bindings: ScienceManuscriptBindingInput[];
  blueprintBinding?: import("./science-manuscript-blueprint").ScienceManuscriptBlueprintBindingInput;
}

export interface AppendScienceManuscriptVersionResult {
  manuscript: ScienceManuscript;
  replayed: boolean;
}

export type ScienceManuscriptTransactionActor = "user" | "assistant";

/** The sole mutation contract used by direct manipulation and assistant edits. */
export interface ApplyScienceManuscriptTransactionInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedVersion: number;
  expectedContentSha256: string;
  expectedDocumentSha256: string;
  actor: ScienceManuscriptTransactionActor;
  reason: string | null;
  operations: ScienceManuscriptOperation[];
}

export interface ScienceManuscriptTransaction {
  id: string;
  requestId: string;
  projectId: string;
  manuscriptId: string;
  baseVersion: number;
  baseContentSha256: string;
  baseDocumentSha256: string;
  resultVersion: number;
  resultContentSha256: string;
  resultDocumentSha256: string;
  actor: ScienceManuscriptTransactionActor;
  reason: string | null;
  /** Non-null only when this transaction is the durable inverse of another transaction. */
  revertsTransactionId: string | null;
  operations: ScienceManuscriptOperation[];
  createdAt: string;
}

export interface ApplyScienceManuscriptTransactionResult {
  manuscript: ScienceManuscript;
  transaction: ScienceManuscriptTransaction;
  replayed: boolean;
}

export interface RevertScienceManuscriptTransactionInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  transactionId: string;
  expectedVersion: number;
  expectedContentSha256: string;
  expectedDocumentSha256: string;
  actor: ScienceManuscriptTransactionActor;
  reason: string | null;
}

export type RevertScienceManuscriptTransactionResult = ApplyScienceManuscriptTransactionResult;

export interface GetScienceManuscriptEditorModelResult {
  manuscript: ScienceManuscript;
  document: ScienceManuscriptDocument;
  recentTransactions: ScienceManuscriptTransaction[];
  canUndo: boolean;
}

export interface CreateScienceManuscriptSelectionContextResult {
  selectionContext: ScienceManuscriptSelectionContext;
  replayed: boolean;
}

export interface CreateScienceManuscriptEditProposalResult {
  proposal: ScienceManuscriptEditProposal;
  replayed: boolean;
}

export interface ApplyScienceManuscriptEditProposalResult {
  proposal: ScienceManuscriptEditProposal;
  manuscript: ScienceManuscript;
  transaction: ScienceManuscriptTransaction;
  replayed: boolean;
}

export interface RejectScienceManuscriptEditProposalResult {
  proposal: ScienceManuscriptEditProposal;
  replayed: boolean;
}

export type ScienceJournalRuleSeverity = "error" | "warning" | "manual";

export type ScienceManuscriptPageSize = "a4" | "letter";
export type ScienceManuscriptFontFamily = "serif" | "sans-serif";
export type ScienceManuscriptLineSpacing = "single" | "one-and-half" | "double";
export type ScienceManuscriptRenderTarget = "initial-submission" | "accepted-source" | "published-approximation";
export type ScienceManuscriptLatexTemplate = "generic-article" | "aps-revtex4-2";
export type ScienceManuscriptApsJournalStyle = "pra" | "prb" | "prc" | "prd" | "pre" | "prl" | "rmp";
export type ScienceManuscriptTitlePageMode = "inline" | "separate";

export interface ScienceManuscriptLayoutSpec {
  pageSize: ScienceManuscriptPageSize;
  marginsMm: { top: number; right: number; bottom: number; left: number };
  fontFamily: ScienceManuscriptFontFamily;
  fontSizePt: 10 | 11 | 12;
  lineSpacing: ScienceManuscriptLineSpacing;
  lineNumbers: boolean;
  /** Submission manuscripts and publication-like proofs are different artifacts. */
  renderTarget?: ScienceManuscriptRenderTarget;
  /** Exact installed LaTeX recipe. Omitted legacy rules use generic-article. */
  latexTemplate?: ScienceManuscriptLatexTemplate;
  /** Required to claim one specific APS journal rather than the REVTeX default. */
  latexJournalStyle?: ScienceManuscriptApsJournalStyle;
  /** Main-text column count; title and abstract remain full-width in HTML preview. */
  columnCount?: 1 | 2;
  /** Inter-column gap. Only meaningful when columnCount is 2. */
  columnGapMm?: number;
  /** Whether author/front matter occupies its own first page. */
  titlePageMode?: ScienceManuscriptTitlePageMode;
}

export type ScienceJournalRuleCheck =
  | { kind: "heading-present"; headings: string[]; minimumMatches: number }
  | { kind: "max-title-characters"; maximum: number }
  | { kind: "max-section-words"; heading: string; maximum: number }
  | { kind: "max-manuscript-words"; maximum: number }
  | { kind: "binding-count"; role: ScienceManuscriptBinding["role"]; minimum?: number; maximum?: number }
  | { kind: "required-text"; patterns: string[]; minimumMatches: number }
  | { kind: "output-format"; allowed: Array<"docx" | "tex" | "pdf" | "zip">; preferred: "docx" | "tex" | "pdf" }
  | { kind: "bibliography-style"; style: "numeric" | "apa" | "nature" }
  | ({ kind: "manuscript-layout" } & ScienceManuscriptLayoutSpec)
  | { kind: "figure-raster-profile"; minimumDpi: 300 | 600; allowedColorSpaces: Array<"srgb" | "cmyk"> }
  | { kind: "figure-vector-profile"; allowedFormats: Array<"svg"> }
  | { kind: "manual-attestation"; code: string };

export interface ScienceJournalRuleInput {
  id: string;
  category: "structure" | "length" | "figures" | "references" | "ethics" | "data-code" | "files" | "review" | "other";
  severity: ScienceJournalRuleSeverity;
  requirement: string;
  inspectionId: string;
  evidenceQuote: string;
  check: ScienceJournalRuleCheck;
}

export interface ScienceJournalGuidelineInspection {
  id: string;
  projectId: string;
  sourceUrl: string;
  officialHost: string;
  pageTitle: string;
  mimeType: "text/html" | "application/pdf" | "text/plain";
  byteSize: number;
  responseSha256: string;
  normalizedTextSha256: string;
  normalizedText: string;
  etag: string | null;
  lastModified: string | null;
  retrievedAt: string;
}

export interface ScienceJournalGuidelineSource {
  inspectionId: string;
  sourceUrl: string;
  officialHost: string;
  pageTitle: string;
  mimeType: ScienceJournalGuidelineInspection["mimeType"];
  byteSize: number;
  responseSha256: string;
  normalizedTextSha256: string;
  etag: string | null;
  lastModified: string | null;
  retrievedAt: string;
}

export interface ScienceJournalRule extends ScienceJournalRuleInput {
  evidenceSha256: string;
}

export const SCIENCE_JOURNAL_COVERAGE_CATEGORIES = [
  "identity",
  "article-structure",
  "length-limits",
  "manuscript-files",
  "figures-tables",
  "references",
  "supplements",
  "data-code",
  "ethics-conflicts",
  "authorship",
  "peer-review",
] as const;

export type ScienceJournalCoverageCategory = typeof SCIENCE_JOURNAL_COVERAGE_CATEGORIES[number];

export interface ScienceJournalCoverageEntry {
  category: ScienceJournalCoverageCategory;
  status: "covered" | "not-applicable" | "unresolved";
  inspectionId: string;
  evidenceQuote: string;
  rationale: string;
}

export interface ScienceJournalIdentityReceipt {
  id: string;
  projectId: string;
  journalName: string;
  articleType: string;
  officialHosts: string[];
  contentSha256: string;
  confirmedAt: string;
}

export interface ScienceJournalProfileVersion {
  id: string;
  profileId: string;
  version: number;
  journalName: string;
  articleType: string;
  sources: ScienceJournalGuidelineSource[];
  rules: ScienceJournalRule[];
  identityReceiptId: string | null;
  identityReceiptSha256: string | null;
  coverage: ScienceJournalCoverageEntry[];
  coverageManifestSha256: string | null;
  sourceManifestSha256: string;
  ruleManifestSha256: string;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceJournalProfile {
  id: string;
  projectId: string;
  journalName: string;
  articleType: string;
  status: "verified" | "stale";
  currentVersion: number;
  version: ScienceJournalProfileVersion;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScienceJournalProfileInput {
  requestId: string;
  projectId: string;
  journalName: string;
  articleType: string;
  identityReceiptId: string;
  inspectionIds: string[];
  rules: ScienceJournalRuleInput[];
  coverage: ScienceJournalCoverageEntry[];
}

export interface CreateScienceJournalProfileResult {
  profile: ScienceJournalProfile;
  replayed: boolean;
}

export interface ScienceJournalValidationFinding {
  ruleId: string;
  severity: ScienceJournalRuleSeverity;
  status: "pass" | "fail" | "manual";
  requirement: string;
  observed: string;
  sourceUrl: string;
  evidenceQuote: string;
}

export interface ScienceJournalValidationReport {
  schema: "agentlas.science-journal-validation/v1";
  projectId: string;
  manuscriptId: string;
  manuscriptVersion: number;
  manuscriptContentSha256: string;
  journalProfileId: string;
  journalProfileVersion: number;
  journalProfileContentSha256: string;
  manuscriptBlueprintId: string | null;
  manuscriptBlueprintVersion: number | null;
  manuscriptBlueprintContentSha256: string | null;
  manuscriptBlueprintAssessmentId: string | null;
  manuscriptBlueprintAssessmentReportSha256: string | null;
  manuscriptBlueprintAssessmentPolicyContentSha256: string | null;
  manuscriptScholarlyAssessmentId: string | null;
  manuscriptScholarlyAssessmentReportSha256: string | null;
  manuscriptScholarlyAssessmentPolicyContentSha256: string | null;
  manuscriptCoherenceAssessmentId: string | null;
  manuscriptCoherenceAssessmentReportSha256: string | null;
  manuscriptCoherenceAssessmentContentSha256: string | null;
  claimLedgerId: string | null;
  claimLedgerRevision: number | null;
  claimLedgerManifestSha256: string | null;
  claimGateReportSha256: string | null;
  claimPolicyContentSha256: string | null;
  status: "ready" | "blocked" | "manual-review";
  counts: { pass: number; fail: number; manual: number; warning: number };
  findings: ScienceJournalValidationFinding[];
  reportSha256: string;
  generatedAt: string;
}

export interface ScienceJournalHumanAttestationReceipt {
  id: string;
  projectId: string;
  manuscriptId: string;
  manuscriptVersion: number;
  manuscriptContentSha256: string;
  journalProfileId: string;
  journalProfileVersion: number;
  journalProfileContentSha256: string;
  code: string;
  contentSha256: string;
  confirmedAt: string;
  consumedByExportId: string | null;
}

export interface ScienceJournalValidationReceipt {
  id: string;
  projectId: string;
  manuscriptId: string;
  manuscriptVersion: number;
  manuscriptContentSha256: string;
  journalProfileId: string;
  journalProfileVersion: number;
  journalProfileContentSha256: string;
  journalIdentityReceiptId: string;
  journalIdentityReceiptSha256: string;
  humanAttestationReceiptIds: string[];
  manuscriptBlueprintAssessmentId: string | null;
  manuscriptBlueprintAssessmentReportSha256: string | null;
  manuscriptBlueprintAssessmentPolicyContentSha256: string | null;
  manuscriptScholarlyAssessmentId: string | null;
  manuscriptScholarlyAssessmentReportSha256: string | null;
  manuscriptScholarlyAssessmentPolicyContentSha256: string | null;
  manuscriptCoherenceAssessmentId: string | null;
  manuscriptCoherenceAssessmentReportSha256: string | null;
  manuscriptCoherenceAssessmentContentSha256: string | null;
  claimLedgerId: string | null;
  claimLedgerRevision: number | null;
  claimLedgerManifestSha256: string | null;
  claimGateReportSha256: string | null;
  claimPolicyContentSha256: string | null;
  report: ScienceJournalValidationReport;
  contentSha256: string;
  createdAt: string;
}

export interface ConfirmScienceJournalIdentityInput {
  requestId: string;
  projectId: string;
  journalName: string;
  articleType: string;
  officialHosts: string[];
}

export interface ConfirmScienceJournalHumanAttestationInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedManuscriptVersion: number;
  expectedManuscriptContentSha256: string;
  journalProfileId: string;
  expectedJournalProfileVersion: number;
  expectedJournalProfileContentSha256: string;
  code: string;
}

export interface ScienceSubmissionAuthor {
  name: string;
  affiliations: string[];
  email?: string | null;
  orcid?: string | null;
  corresponding?: boolean;
}

export interface ScienceSubmissionMetadata {
  authors: ScienceSubmissionAuthor[];
  keywords: string[];
  fundingStatement: string | null;
  competingInterestsStatement: string | null;
  authorContributionsStatement: string | null;
  dataAvailabilityStatement: string | null;
  codeAvailabilityStatement: string | null;
  ethicsStatement: string | null;
  coverLetter: string | null;
}

export interface ScienceSubmissionExport {
  id: string;
  projectId: string;
  manuscriptId: string;
  manuscriptVersion: number;
  manuscriptContentSha256: string;
  journalProfileId: string;
  journalProfileVersion: number;
  journalProfileContentSha256: string;
  status: "ready" | "blocked";
  journalIdentityReceiptId: string;
  journalIdentityReceiptSha256: string;
  validationReceiptId: string;
  validationReceiptSha256: string;
  validationReportSha256: string;
  manuscriptScholarlyAssessmentId: string | null;
  manuscriptScholarlyAssessmentReportSha256: string | null;
  manuscriptScholarlyAssessmentPolicyContentSha256: string | null;
  manuscriptCoherenceAssessmentId: string | null;
  manuscriptCoherenceAssessmentReportSha256: string | null;
  manuscriptCoherenceAssessmentContentSha256: string | null;
  claimLedgerId: string | null;
  claimLedgerRevision: number | null;
  claimLedgerManifestSha256: string | null;
  claimGateReportSha256: string | null;
  claimPolicyContentSha256: string | null;
  packageSha256: string | null;
  packageByteSize: number | null;
  packageRef: string | null;
  fileName: string | null;
  manifestSha256: string;
  createdAt: string;
}

export interface CreateScienceSubmissionExportInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedManuscriptVersion: number;
  expectedManuscriptContentSha256: string;
  journalProfileId: string;
  expectedJournalProfileVersion: number;
  expectedJournalProfileContentSha256: string;
  metadata: ScienceSubmissionMetadata;
  humanAttestationReceiptIds: string[];
}

export interface CreateScienceSubmissionExportResult {
  submissionExport: ScienceSubmissionExport;
  validation: ScienceJournalValidationReport;
  validationReceipt: ScienceJournalValidationReceipt;
  replayed: boolean;
}
import type { ScienceRendererPackStatus } from "./science-renderer-pack";
export * from "./science-manuscript-blueprint";
