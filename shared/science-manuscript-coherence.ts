import type { ScienceClaimClass, ScienceClaimStatus } from "./science-claim-ledger";

export const SCIENCE_MANUSCRIPT_COHERENCE_SCHEMA = "agentlas.science.manuscript-coherence/v1" as const;

/** Versioned deterministic policy. Changing any parser/linkage rule requires a new version. */
export const SCIENCE_MANUSCRIPT_COHERENCE_POLICY = {
  id: "agentlas.manuscript-coherence-policy",
  version: 2,
  summaryLinkAlgorithm: "exact-body-evidence-subset/v1",
  resultsDiscussionAlgorithm: "exact-shared-provenance/v1",
  numericGrammarCatalog: "sample-effect-ci-quantity/v1",
  roundingAlgorithm: "decimal-half-away-from-zero/v1",
  numericSourceAlgorithm: "exact-validated-artifact-json-scalar/v1",
  unitVocabulary: "bounded-si-unit-allowlist/v1",
  visualBindingAlgorithm: "exact-artifact-capture-validation-run-output/v1",
} as const;

export type ScienceCoherenceSectionRole =
  | "abstract" | "introduction" | "methods" | "results" | "discussion" | "limitations" | "conclusion" | "other";

export interface ScienceCoherenceClaimContext {
  claimId: string;
  claimContentSha256: string;
  claimClass: ScienceClaimClass;
  status: ScienceClaimStatus;
  sectionRole: ScienceCoherenceSectionRole;
  exactText: string;
  evidenceSignatures: string[];
}

export interface ScienceCoherenceVisualContext {
  nodeId: string;
  nodeRevision: number;
  nodeContentSha256: string;
  visualKind: "figure" | "table";
  /** Artifact-backed figures/tables require an exact provenance binding; inline tables do not. */
  bindingRequired: boolean;
  locator: string | null;
  caption: string;
  binding: {
    role: "figure" | "table";
    locator: string;
    artifactId: string;
    artifactVersion: number;
    artifactContentSha256: string;
    captureId: string;
    validationReceiptId: string;
    validationPassed: boolean;
    runArtifactClosurePassed: boolean;
  } | null;
}

export interface ScienceManuscriptCoherenceContext {
  projectId: string;
  manuscript: {
    /** Present in host-prepared and persisted contexts; omitted by pure evaluator fixtures. */
    projectId?: string;
    manuscriptId: string;
    /** Present in host-prepared and persisted contexts; omitted by pure evaluator fixtures. */
    versionId?: string;
    version: number;
    contentSha256: string;
    documentSha256: string;
    bindingManifestSha256: string;
  };
  claimLedger: {
    ledgerId: string;
    revision: number;
    manifestSha256: string;
    gateReportSha256: string;
    policyContentSha256: string;
    ready: boolean;
  };
  claims: ScienceCoherenceClaimContext[];
  visuals: ScienceCoherenceVisualContext[];
  /**
   * Host-resolved immutable scalar values referenced by numeric declarations.
   * Callers may propose selectors, but must never supply these values or closure facts.
   */
  numericSources: ScienceCoherenceNumericSourceContext[];
  orphanArtifactBindingLocators: string[];
}

export interface ScienceCoherenceSummaryClaimLinkInput {
  summaryClaimId: string;
  bodyClaimIds: string[];
}

export interface ScienceCoherenceResultsDiscussionLinkInput {
  resultClaimId: string;
  discussionClaimIds: string[];
}

export type ScienceCoherenceTextOwner =
  | { kind: "claim"; claimId: string; claimContentSha256: string }
  | { kind: "visual-caption"; nodeId: string; nodeRevision: number; nodeContentSha256: string };

export type ScienceCoherenceNumericGrammar =
  | "sample-size/v1" | "effect-estimate/v1" | "confidence-interval/v1" | "quantity-unit/v1";

export type ScienceCoherenceNumericComponentRole = "value" | "confidence-level" | "lower" | "upper";

/** A caller-proposed locator. Every other source fact is rebuilt by the host. */
export interface ScienceCoherenceNumericSourceSelectorInput {
  componentRole: ScienceCoherenceNumericComponentRole;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  validationReceiptId: string;
  /** Strict RFC 6901 JSON Pointer into the immutable artifact payload. */
  jsonPointer: string;
  /** Optional pointer to an explicit unit string in the same immutable payload. */
  unitJsonPointer: string | null;
}

export interface ScienceCoherenceNumericSourceContext {
  sourceId: string;
  selector: ScienceCoherenceNumericSourceSelectorInput;
  selectorSha256: string;
  artifactVersionId: string;
  artifactLinkageSha256: string;
  rendererId: string;
  rendererVersion: string;
  validationReceiptSha256: string;
  runArtifactBindingId: string;
  researchRunId: string;
  runOutputId: string;
  runOutputSha256: string;
  canonicalDecimal: string;
  canonicalUnit: string | null;
  valueSha256: string;
  /** Exact claim/caption identities allowed to cite this source. */
  allowedOwnerKeys: string[];
  contentSha256: string;
}

export interface ScienceCoherenceNumericAssertionInput {
  groupId: string;
  owner: ScienceCoherenceTextOwner;
  from: number;
  to: number;
  exactQuote: string;
  grammar: ScienceCoherenceNumericGrammar;
  presentation: "exact" | "rounded";
  /** Required for newly recorded policy-v2 receipts; optional only for reading legacy v1 rows. */
  sources?: ScienceCoherenceNumericSourceSelectorInput[];
}

export interface ScienceCoherenceNumericExemptionInput {
  owner: ScienceCoherenceTextOwner;
  from: number;
  to: number;
  exactQuote: string;
  reason: "calendar-year" | "citation-number" | "identifier";
}

export interface EvaluateScienceManuscriptCoherenceInput {
  summaryClaimLinks: ScienceCoherenceSummaryClaimLinkInput[];
  resultsDiscussionLinks: ScienceCoherenceResultsDiscussionLinkInput[];
  numericAssertions: ScienceCoherenceNumericAssertionInput[];
  numericExemptions: ScienceCoherenceNumericExemptionInput[];
}

export type ScienceManuscriptCoherenceFindingCode =
  | "claim-ledger-ready"
  | "summary-claim-body-link"
  | "summary-claim-evidence-subset"
  | "results-discussion-link"
  | "results-discussion-shared-evidence"
  | "numeric-assertion-valid"
  | "numeric-source-exact"
  | "numeric-group-consistent"
  | "numeric-coverage"
  | "visual-caption-present"
  | "visual-binding-exact"
  | "orphan-artifact-binding";

export interface ScienceManuscriptCoherenceFinding {
  code: ScienceManuscriptCoherenceFindingCode;
  severity: "error" | "warning";
  status: "pass" | "fail";
  ownerId: string | null;
  observed: string;
  required: string;
}

export interface ScienceManuscriptCoherenceReport {
  schema: typeof SCIENCE_MANUSCRIPT_COHERENCE_SCHEMA;
  projectId: string;
  manuscript: ScienceManuscriptCoherenceContext["manuscript"];
  claimLedger: ScienceManuscriptCoherenceContext["claimLedger"];
  declarationsSha256: string;
  numericProvenance: {
    sourceCount: number;
    sourceManifestSha256: string;
    sources: ScienceCoherenceNumericSourceContext[];
  };
  findings: ScienceManuscriptCoherenceFinding[];
  status: "passed" | "blocked";
  limitations: string[];
  reportSha256: string;
}

export interface PrepareScienceManuscriptCoherenceContextInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedManuscriptVersion: number;
  expectedManuscriptContentSha256: string;
}

export interface PrepareScienceManuscriptCoherenceContextResult {
  context: ScienceManuscriptCoherenceContext & {
    manuscript: ScienceManuscriptCoherenceContext["manuscript"] & { projectId: string; versionId: string };
  };
  contextSha256: string;
  replayed: boolean;
}

/**
 * The caller supplies semantic declarations only. The main-process store derives every
 * manuscript, claim, section, receipt, capture, and run-output fact from current durable state.
 */
export interface RecordScienceManuscriptCoherenceAssessmentInput extends EvaluateScienceManuscriptCoherenceInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedManuscriptVersion: number;
  expectedManuscriptContentSha256: string;
  expectedClaimLedgerId: string;
  expectedClaimLedgerRevision: number;
  expectedClaimLedgerManifestSha256: string;
  expectedClaimLedgerGateReportSha256: string;
  expectedClaimLedgerPolicyContentSha256: string;
}

/** Immutable host receipt for one exact report and one exact durable manuscript version. */
export interface ScienceManuscriptCoherenceAssessmentReceipt
  extends Omit<ScienceManuscriptCoherenceReport, "manuscript"> {
  id: string;
  manuscript: ScienceManuscriptCoherenceContext["manuscript"] & { projectId: string; versionId: string };
  policy: typeof SCIENCE_MANUSCRIPT_COHERENCE_POLICY & { contentSha256: string };
  /** Canonically ordered declarations retained so the host can fully re-evaluate the receipt. */
  declarations: EvaluateScienceManuscriptCoherenceInput;
  contentSha256: string;
  createdAt: string;
}

export type ScienceManuscriptCoherenceAssessmentStaleReason =
  | "manuscript-version-advanced"
  | "claim-ledger-missing"
  | "claim-ledger-advanced"
  | "claim-ledger-gate-advanced"
  | "coherence-policy-advanced"
  | "coherence-context-advanced"
  | "coherence-report-tampered";

export interface ScienceManuscriptCoherenceAssessmentReadModel {
  receipt: ScienceManuscriptCoherenceAssessmentReceipt;
  status: "current" | "stale";
  staleReasons: ScienceManuscriptCoherenceAssessmentStaleReason[];
}

export interface RecordScienceManuscriptCoherenceAssessmentResult {
  assessment: ScienceManuscriptCoherenceAssessmentReadModel;
  replayed: boolean;
}
