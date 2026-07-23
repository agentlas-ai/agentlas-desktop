/**
 * Host-local Experience assets. These are overlays that reference a base agent;
 * they never contain or rewrite the base package itself.
 */
export interface ExperienceEnvironment {
  platform: string;
  arch?: string;
  runtimeKind: string;
}

export interface CanonicalExperienceEnvironmentProfile {
  schema: "agentlas.experience-environment-profile.v1";
  os: string;
  arch: string;
  runtime: string;
  constraints: string[];
}

/** Catalog-id-only capability relation. It never carries a command, URL, key, or account. */
export interface ExperienceMcpRequirement {
  catalogId: string;
  required: boolean;
  alternatives: string[];
}

export interface ExperiencePackCreateInput {
  agentId: string;
  name: string;
  description?: string;
  projectId?: string | null;
  projectPath?: string | null;
  environment: ExperienceEnvironment;
  /** Optional explicit Pack requirements; otherwise safe installed-agent catalog IDs are snapshotted as optional. */
  mcpRequirements?: ExperienceMcpRequirement[];
}

export interface ExperiencePackListInput {
  agentId: string;
  projectId?: string | null;
  projectPath?: string | null;
  environment?: ExperienceEnvironment;
}

export interface ExperiencePackRecord {
  id: string;
  agentId: string;
  projectId: string | null;
  projectPath: string | null;
  environmentKey: string;
  /** Null means a legacy opaque environment key that cannot auto-activate or export canonically. */
  environmentProfile: CanonicalExperienceEnvironmentProfile | null;
  autoManaged: boolean;
  name: string;
  description: string;
  /** Immutable provenance reference only; package bytes are never copied into this asset. */
  basePackageHash: string | null;
  /** Server-authoritative identity of the exact base release. Null until Cloud resolves it. */
  baseAgentDefinitionId: string | null;
  baseAgentReleaseId: string | null;
  /** Hash algorithm used by the base Agent Cloud artifact. */
  basePackageHashVersion: string | null;
  mcpRequirements: ExperienceMcpRequirement[];
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceCandidateCaptureInput {
  packId: string;
  /** The only P0 capture source is an already-curated Memory entry, never a raw run/transcript. */
  sourceMemoryId: string;
}

export interface ExperienceCandidateRecord {
  id: string;
  packId: string;
  agentId: string;
  sourceMemoryId: string;
  summary: string;
  sensitivity: "public" | "internal" | "private";
  confidence: "high" | "medium" | "low";
  status: "candidate" | "promoted" | "rejected";
  outcomeStatus: "unverified" | "attested" | "verified" | "failed";
  publicSafe: boolean;
  /** Frozen canonical task ids inferred at capture time; never raw request text. */
  taskSignatures: string[];
  autoManaged: boolean;
  createdAt: string;
  updatedAt: string;
  promotedAt: string | null;
}

export interface OperationalPublicProjectionSourceBinding {
  candidateId: string;
  /** Content-addressed snapshot of the private promoted item + attestation. */
  sourceItemHash: string;
}

/**
 * Owner-authored public projection of one or more private Operational items.
 * The private candidate/Memory remains immutable and is never copied here.
 */
export interface OperationalPublicProjectionRecord {
  projectionId: string;
  packId: string;
  agentId: string;
  basePackageHash: string;
  baseAgentDefinitionId: string;
  baseAgentReleaseId: string;
  environmentKey: string;
  sourceBindings: OperationalPublicProjectionSourceBinding[];
  title: string;
  instructions: string[];
  taskSignatures: string[];
  environmentConstraints: string[];
  sourceSnapshotHash: string;
  proposalHash: string;
  privacyIssueCodes: string[];
  status: "proposal" | "confirmed";
  confirmationHash: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalPublicProjectionSaveInput {
  packId: string;
  sourceCandidateIds: string[];
  title: string;
  instructions: string[];
  taskSignatures: string[];
  environmentConstraints: string[];
}

export interface OperationalPublicProjectionConfirmInput {
  projectionId: string;
  proposalHash: string;
  explicitConsent: true;
}

export interface ExperienceAutoIntakeSummary {
  candidateCreated: number;
  blocked: number;
  skipped: number;
  reasons: Array<{ code: string; count: number }>;
}

/**
 * A host-local preference observation. This is deliberately not a portable
 * Taste/Style release and carries no claim of quality or success. It can only
 * become a public Taste chip after the separate Hub flow collects randomized,
 * explicit human pairwise evidence and safe preview references.
 */
export interface LocalTasteDraftRecord {
  id: string;
  agentId: string;
  sourceMemoryId: string;
  statement: string;
  sensitivity: "public" | "internal" | "private";
  confidence: "high" | "medium" | "low";
  axisCandidates: Array<
    | "composition"
    | "color"
    | "typography"
    | "motion"
    | "pacing"
    | "density"
    | "imagery"
    | "editing"
    | "spatial-rhythm"
  >;
  taskSignatures: string[];
  basePackageHash: string;
  baseAgentDefinitionId: string | null;
  baseAgentReleaseId: string | null;
  evidenceState: "pairwise-required";
  status: "observation" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export type TasteAxis = LocalTasteDraftRecord["axisCandidates"][number];
export type TastePreviewRights =
  | "owner-authorized"
  | "licensed-for-public-preview"
  | "public-domain";

export interface TastePreviewTreatmentProvenance {
  role: "chip-on" | "control";
  canonicalTaskInputHash: string;
  generationCohortHash: string;
  baseAgentDefinitionId: string;
  baseAgentReleaseId: string;
  tasteStyleReleaseId: string;
  tasteMaterialHash: string | null;
  noTasteOverlay: boolean;
  evidenceLevel: "owner-attested-external";
  ownerAttested: true;
}

/** Local review state for turning one private observation into a portable Taste draft. */
export interface TasteChipWorkflowRecord {
  workflowId: string;
  draftId: string;
  agentId: string;
  basePackageHash: string;
  baseAgentDefinitionId: string;
  baseAgentReleaseId: string;
  environmentKey: string;
  tasteStyleId: string;
  releaseId: string;
  title: string;
  summary: string;
  ruleStatement: string;
  axis: TasteAxis;
  taskSignature: string;
  contexts: string[];
  generalizationHash: string;
  privacyIssueCodes: string[];
  status: "proposal" | "confirmed" | "moderation-pending" | "ab-ready" | "error";
  confirmedAt: string | null;
  previewNames: [string, string] | null;
  previewTreatments: [TastePreviewTreatmentProvenance, TastePreviewTreatmentProvenance] | null;
  previewRights: TastePreviewRights | null;
  remotePreviewAssetIds: [string, string] | null;
  remoteRevision: string | null;
  remoteErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TasteGeneralizationInput {
  draftId: string;
  agentId: string;
  title: string;
  summary: string;
  ruleStatement: string;
  axis: TasteAxis;
  taskSignature: string;
  contexts: string[];
}

export interface TasteGeneralizationConfirmInput {
  workflowId: string;
  generalizationHash: string;
  explicitConsent: true;
}

export interface TastePreviewPrepareInput {
  workflowId: string;
  previews: [TastePreviewGrant, TastePreviewGrant];
  rightsStatus: TastePreviewRights;
  rightsAttested: true;
  canonicalTaskInputHash: string;
  generationCohortRef: string;
  externalGenerationAttested: true;
}

/** Structural subset of FsPathGrant kept here to avoid a shared type cycle. */
export interface TastePreviewGrant {
  path: string;
  kind: "file";
  durable: boolean;
  scope: { kind: "capability"; token: string };
}

export interface TasteHubUploadInput {
  workflowId: string;
  generalizationHash: string;
  explicitUpload: true;
}

export interface ExperienceOntologySummary {
  packCount: number;
  candidateCount: number;
  promotedCount: number;
  /** Private local Taste observations; never counted as operational success. */
  tasteDraftCount: number;
  tasteNeedsEvidenceCount: number;
  tasteUnclassifiedCount: number;
  taskCount: number;
  evidenceCount: number;
  mcpCount: number;
  lineageCount: number;
  updateRelationCount: number;
  localReceiptCount: number;
  autoIntake: ExperienceAutoIntakeSummary;
}

/**
 * Renderer-safe projection of the host-local relation index. Labels are fixed
 * product vocabulary and refs are value-free identifiers only; this contract
 * never carries candidate summaries, prompts, paths, URLs, or secret values.
 */
export type ExperienceOntologyGraphNodeKind =
  | "agent"
  | "pack"
  | "release"
  | "experience-item"
  | "task"
  | "environment"
  | "mcp"
  | "evidence"
  | "taste-draft"
  | "taste-axis";

export type ExperienceOntologyGraphNodeStatus =
  | "active"
  | "historical"
  | "candidate"
  | "promoted"
  | "pending-evidence";

export type ExperienceOntologyGraphNodeSource =
  | "synthetic"
  | "relation-index"
  | "private-candidate"
  | "taste-draft";

export interface ExperienceOntologyGraphNode {
  id: string;
  kind: ExperienceOntologyGraphNodeKind;
  packId?: string;
  /** Value-free entity reference such as a UUID, canonical task id, or catalog id. */
  ref?: string;
  /** Fixed/allowlisted product vocabulary only; never source-authored text. */
  safeLabel?: string;
  /**
   * Owner-only readable title for local-source nodes (candidate summary title,
   * pack name, taste statement). This exists solely for the local Experience
   * Map render surface: it must never enter Hub projections, portable
   * Experience bundles, or any export payload. Hub-source nodes never set it.
   */
  localLabel?: string;
  status: ExperienceOntologyGraphNodeStatus;
  source: ExperienceOntologyGraphNodeSource;
}

export type ExperienceOntologyGraphEdgeKind =
  | "agent_has_pack"
  | "has_release"
  | "exact_base_binding"
  | "contains"
  | "contains_candidate"
  | "applies_to_task"
  | "applies_in_environment"
  | "requires_mcp"
  | "supports_mcp"
  | "alternative_mcp"
  | "supported_by"
  | "supersedes"
  | "contradicts"
  | "similar_to"
  | "similar_by_tag"
  | "agent_has_taste_draft"
  | "classified_as_taste_axis";

export interface ExperienceOntologyGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: ExperienceOntologyGraphEdgeKind;
  status: "active" | "historical" | "pending";
}

export interface ExperienceOntologyGraphSnapshot {
  schema: "agentlas.ontology-relation-graph.v1";
  agentId: string;
  generatedAt: string;
  nodes: ExperienceOntologyGraphNode[];
  edges: ExperienceOntologyGraphEdge[];
  /** Counts before the renderer transport cap, after privacy-safe projection. */
  totalNodeCount: number;
  totalEdgeCount: number;
  omittedNodeCount: number;
  omittedEdgeCount: number;
  truncated: boolean;
  limits: {
    nodes: 400;
    edges: 800;
  };
}

/** Explicit v1 aliases for consumers that name the wire schema rather than the product surface. */
export type OntologyRelationGraphV1Node = ExperienceOntologyGraphNode;
export type OntologyRelationGraphV1Edge = ExperienceOntologyGraphEdge;
export type OntologyRelationGraphV1Snapshot = ExperienceOntologyGraphSnapshot;

/**
 * Receipt-side verification methods. `user-attested` is a human review,
 * `local-run-receipt` is an outcome-attested successful run (durable start
 * receipt in the append-only run ledger), `local-test-receipt` is reserved.
 */
export type ExperienceVerificationMethod = "user-attested" | "local-run-receipt" | "local-test-receipt";

export interface ExperiencePromotionInput {
  candidateId: string;
  explicitConsent: true;
  verification: {
    status: "attested";
    /** Renderer-initiated promotion stays user-attested; run-receipt promotion is Main-only. */
    method: "user-attested";
    /** Value-free IDs only. Raw outputs, paths, URLs, and transcripts are rejected. */
    evidenceRefs: string[];
  };
  publicSafe: boolean;
}

export interface ExperiencePromotionReceipt {
  id: string;
  packId: string;
  candidateId: string;
  agentId: string;
  action: "promote";
  explicitConsent: true;
  verificationStatus: "attested" | "verified";
  verificationMethod: ExperienceVerificationMethod;
  evidenceHash: string;
  publicSafe: boolean;
  createdAt: string;
}

/**
 * Explicit owner action that publicly unseals one already-promoted candidate.
 * Requires an existing promotion receipt (`user-attested` or
 * `local-run-receipt`) and a post-redaction privacy-clean summary; the
 * promotion receipt is upgraded to `verified` + `public_safe`.
 */
export interface ExperiencePublicUnsealInput {
  candidateId: string;
  explicitConsent: true;
}

/** Value-free aggregate of local auto-intake receipts for one agent. */
export interface ExperienceIntakeDiagnostics {
  agentId: string;
  totals: {
    candidateCreated: number;
    blocked: number;
    skipped: number;
  };
  /** Redacted-and-admitted subset of candidateCreated, with total redacted spans. */
  redactedAdmits: {
    receipts: number;
    redactedSpans: number;
  };
  reasons: Array<{
    status: "candidate-created" | "blocked" | "skipped";
    code: string;
    count: number;
  }>;
}

export interface ExperienceExportIntentInput {
  packId: string;
  visibility: "private" | "public";
}

export interface ExperienceExportIntentRecord {
  id: string;
  packId: string;
  agentId: string;
  visibility: "private" | "public";
  /** Legacy/local intent only. Portable Cloud exchange has a separate receipt/state machine. */
  status: "local_intent";
  manifestHash: string;
  createdAt: string;
}

export type PortableExperienceVisibility = "private" | "unlisted" | "public";

export interface PortableExperienceMcpRequirement {
  schemaVersion: "agentlas.mcp-requirement.v1";
  kind: "agentlas-mcp-requirement";
  requirementId: string;
  catalogId: string;
  reason: string;
  capabilities: string[];
  required: boolean;
  requiresKey: boolean;
  priority: number;
  permissions: string[];
  alternatives: string[];
  credentialMetadata?: {
    provider: string;
    env: string[];
    allowedHosts?: string[];
    scopes?: string[];
    setupUrl?: string;
    brokerMode?: "host-bound-broker" | "runtime-env-injection" | "provider-managed-oauth" | "manual-provider-page";
  };
  unavailablePolicy: {
    build: "degrade";
    rental: "exclude-variant" | "continue-degraded";
    execution: "use-alternative" | "disable-capability" | "continue-degraded";
  };
}

export interface PortableExperienceItem {
  schemaVersion: "agentlas.experience-item.v1";
  kind: "agentlas-experience-item";
  experienceItemId: string;
  experiencePackId: string;
  experiencePackReleaseId: string;
  type: "procedure" | "failure-recovery" | "environment-gotcha" | "tool-affordance" | "warning" | "supersedes";
  summary: string;
  instructions: string[];
  taskSignatures: string[];
  environmentConstraints: string[];
  evidenceReceiptIds: string[];
  supersedesItemIds: string[];
  confidence: number;
  status: "candidate" | "promoted" | "deprecated" | "rejected";
  privacyScope: "private" | "public-safe";
  createdAt?: string;
}

export interface PortableExperiencePack {
  schemaVersion: "agentlas.experience-pack.v1";
  kind: "agentlas-experience-pack";
  experiencePackId: string;
  releaseId: string;
  /** A syntactic placeholder only. The authenticated server account replaces it. */
  ownerRef: string;
  version: string;
  baseCompatibility: {
    agentDefinitionId: string;
    compatibleBaseReleaseIds: string[];
  };
  itemIds: string[];
  evidenceReceiptIds: string[];
  mcpRequirements: PortableExperienceMcpRequirement[];
  containsBasePackageMaterial: false;
  contentHash: string;
  visibility: PortableExperienceVisibility;
  status: "draft" | "active" | "suspended" | "withdrawn" | "deleted";
  createdAt?: string;
  releasedAt?: string | null;
  withdrawnAt?: string | null;
}

/** Canonical, portable Experience asset. It never contains the base package or local source material. */
export interface PortableExperienceBundle {
  schemaVersion: "agentlas.experience-bundle.v1";
  kind: "agentlas-experience-bundle";
  bundleId: string;
  bundleHash: string;
  requestedVisibility: PortableExperienceVisibility;
  pack: PortableExperiencePack;
  items: PortableExperienceItem[];
  sourceAttestations: Array<{
    kind: "user-attested";
    experienceItemId: string;
    evidenceHash: string;
  }>;
  privacy: {
    basePackageMaterialIncluded: false;
    rawPromptIncluded: false;
    rawTranscriptIncluded: false;
    rawLocalPathsIncluded: false;
    credentialValuesIncluded: false;
  };
}

export interface ExperienceBaseReleaseResolution {
  schema: "agentlas.experience-base-resolution.v1";
  agentDefinitionId: string;
  agentReleaseId: string;
  packageHash: string;
  packageHashVersion: string;
  cloudId: string;
  slug: string;
}

export type ExperienceCloudServerStatus =
  | "draft-saved"
  | "verification-requested"
  | "verification-pending"
  | "verified-private"
  | "public-active"
  | "conflict"
  | "withdrawn"
  | "rejected";

/** Strictly validated server receipt. public-active can only arrive from the server/evaluator. */
export interface ExperienceCloudUploadReceipt {
  schema: "agentlas.experience-upload-receipt.v1";
  uploadId: string;
  bundleId: string;
  bundleHash: string;
  experiencePackId: string;
  experienceReleaseId: string;
  ownerWorkspaceRef: string;
  status: ExperienceCloudServerStatus;
  requestedVisibility: PortableExperienceVisibility;
  revision: string;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
}

/** Local workflow state. Network/offline/conflict states never pretend to be server activation. */
export type ExperienceCloudLocalState =
  | "local-ready"
  | "saving-private"
  | "private-saved"
  | "requesting-verification"
  | "verification-requested"
  | "verification-pending"
  | "verified-private"
  | "public-active"
  | "conflict"
  | "offline"
  | "error"
  | "withdrawn"
  | "rejected";

export interface ExperienceCloudUploadRecord {
  id: string;
  packId: string;
  requestedVisibility: PortableExperienceVisibility;
  bundleId: string;
  bundleHash: string;
  bundle: PortableExperienceBundle;
  idempotencyKey: string;
  remoteUploadId: string | null;
  remoteRevision: string | null;
  state: ExperienceCloudLocalState;
  errorCode: string | null;
  errorMessage: string | null;
  receipt: ExperienceCloudUploadReceipt | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceCloudSaveInput {
  packId: string;
  requestedVisibility: "private" | "public";
}

export interface ExperienceCloudReconcileInput {
  localUploadId: string;
}

export interface ExperienceCloudWithdrawInput {
  localUploadId: string;
}

export interface ExperienceCloudExportResult {
  bundle: PortableExperienceBundle;
  receipt: ExperienceCloudUploadReceipt;
}

export interface ExperienceContextSelection {
  prompt: string;
  selectedCandidateIds: string[];
  approximateTokens: number;
}
