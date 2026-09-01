export const SCIENCE_CLAIM_LEDGER_SCHEMA = "agentlas.science.claim-ledger/v1" as const;
export const SCIENCE_CLAIM_LEDGER_GATE_SCHEMA = "agentlas.science.claim-ledger-gate/v1" as const;

export const SCIENCE_CLAIM_CLASSES = [
  "factual",
  "inference",
  "method",
  "result",
  "limitation",
  "non-factual",
] as const;
export type ScienceClaimClass = typeof SCIENCE_CLAIM_CLASSES[number];

export const SCIENCE_CLAIM_STATUSES = [
  "supported",
  "contradicted",
  "mixed",
  "unresolved",
  "not-applicable",
] as const;
export type ScienceClaimStatus = typeof SCIENCE_CLAIM_STATUSES[number];

export const SCIENCE_EVIDENCE_DIRECTIONS = ["support", "contradict", "qualify"] as const;
export type ScienceEvidenceDirection = typeof SCIENCE_EVIDENCE_DIRECTIONS[number];

export const SCIENCE_EVIDENCE_LOCATOR_MEDIA = [
  "page",
  "section",
  "table",
  "figure",
  "dataset-row",
  "transcript-time",
  "web-fragment",
  "other",
] as const;
export type ScienceEvidenceLocatorMedium = typeof SCIENCE_EVIDENCE_LOCATOR_MEDIA[number];

export interface ScienceManuscriptBinding {
  manuscriptId: string;
  projectId: string;
  version: number;
  contentSha256: string;
}

/**
 * A stable locator points to an exact UTF-16 slice in a sentence and also pins
 * the containing sentence. Ordinals are zero based. The offsets deliberately
 * use JavaScript string offsets because the Electron editor and this runtime
 * share that representation.
 */
export interface ScienceClaimLocator {
  sectionId: string;
  sectionOrdinal: number;
  paragraphOrdinal: number;
  sentenceOrdinal: number;
  claimStartOffset: number;
  claimEndOffset: number;
  sentenceTextSha256: string;
  locatorSha256: string;
}

export interface ScienceEvidenceSpanLocator {
  medium: ScienceEvidenceLocatorMedium;
  value: string;
}

export interface ScienceArtifactEvidenceBinding {
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
}

export interface ScienceValidationReceiptEvidenceBinding {
  validationReceiptId: string;
  validationReceiptVersion: number;
  validationReceiptContentSha256: string;
}

/**
 * Confidence is the confidence of the assessment/link, never a claim that the
 * underlying proposition is true. Truth status is intentionally not inferred
 * by this data type.
 */
export interface ScienceClaimEvidenceAtom {
  evidenceAtomId: string;
  evidenceAtomVersion: number;
  citationId: string;
  citationVersion: number;
  citationContentSha256: string;
  sourceId: string;
  sourceVersionId: string;
  sourceVersion: number;
  sourceContentSha256: string;
  evidenceSpanId: string;
  evidenceSpanVersion: number;
  evidenceSpanContentSha256: string;
  evidenceSpanExactText: string;
  evidenceSpanTextSha256: string;
  evidenceSpanLocator: ScienceEvidenceSpanLocator;
  artifact: ScienceArtifactEvidenceBinding | null;
  validationReceipt: ScienceValidationReceiptEvidenceBinding | null;
  direction: ScienceEvidenceDirection;
  relevance: number;
  assessmentConfidence: number;
  contentSha256: string;
}

/**
 * Records are immutable. A changed text, locator, status, or evidence set is a
 * new claim record linked through supersedesClaimId/content hash.
 */
export interface ScienceClaimRecord {
  claimId: string;
  logicalClaimId: string;
  manuscript: ScienceManuscriptBinding;
  locator: ScienceClaimLocator;
  exactText: string;
  exactTextSha256: string;
  claimClass: ScienceClaimClass;
  status: ScienceClaimStatus;
  evidence: ScienceClaimEvidenceAtom[];
  supersedesClaimId: string | null;
  supersedesClaimContentSha256: string | null;
  createdAt: string;
  contentSha256: string;
}

/**
 * claims is append-only history. activeClaimIds selects the leaf records that
 * belong to the currently bound manuscript version.
 */
export interface ScienceClaimLedgerManifest {
  schema: typeof SCIENCE_CLAIM_LEDGER_SCHEMA;
  ledgerId: string;
  projectId: string;
  revision: number;
  previousManifestSha256: string | null;
  manuscript: ScienceManuscriptBinding;
  manuscriptCitations: ScienceClaimCitationSnapshotBinding[];
  claims: ScienceClaimRecord[];
  activeClaimIds: string[];
  createdAt: string;
  manifestSha256: string;
}

export interface ScienceClaimCitationSnapshotBinding {
  citationId: string;
  citationVersion: number;
  citationContentSha256: string;
}

export interface ScienceCanonicalManuscriptSentence {
  sectionId: string;
  sectionOrdinal: number;
  paragraphOrdinal: number;
  sentenceOrdinal: number;
  text: string;
  textSha256: string;
}

export interface ScienceManuscriptSentenceSnapshot extends ScienceCanonicalManuscriptSentence {
  id: string;
  projectId: string;
  manuscriptVersionId: string;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceCanonicalCitationRecord {
  citationId: string;
  projectId: string;
  citationVersion: number;
  sourceId: string;
  sourceVersionId: string;
  evidenceSpanId: string;
  evidenceSpanVersion: number;
  evidenceSpanContentSha256: string;
  contentSha256: string;
}

export interface ScienceCanonicalSourceRecord {
  sourceId: string;
  projectId: string;
  sourceVersionId: string;
  sourceVersion: number;
  contentSha256: string;
}

export interface ScienceCanonicalEvidenceSpanRecord {
  evidenceSpanId: string;
  projectId: string;
  evidenceSpanVersion: number;
  sourceId: string;
  sourceVersionId: string;
  exactText: string;
  exactTextSha256: string;
  locator: ScienceEvidenceSpanLocator;
  contentSha256: string;
}

export interface ScienceCanonicalArtifactRecord {
  artifactId: string;
  projectId: string;
  artifactVersion: number;
  contentSha256: string;
}

export interface ScienceCanonicalValidationReceiptRecord {
  validationReceiptId: string;
  projectId: string;
  validationReceiptVersion: number;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  inputSha256: string;
  outputSha256: string;
  contentSha256: string;
  status: "passed" | "failed";
}

export interface ScienceClaimLedgerValidationContext {
  projectId: string;
  manuscript: ScienceManuscriptBinding;
  manuscriptSentences: ScienceCanonicalManuscriptSentence[];
  citations: ScienceCanonicalCitationRecord[];
  sources: ScienceCanonicalSourceRecord[];
  evidenceSpans: ScienceCanonicalEvidenceSpanRecord[];
  artifacts: ScienceCanonicalArtifactRecord[];
  validationReceipts: ScienceCanonicalValidationReceiptRecord[];
}

export interface ScienceClaimLedgerPublicationPolicy {
  policyId: string;
  policyVersion: number;
  allowedStatuses: {
    factual: ScienceClaimStatus[];
    inference: ScienceClaimStatus[];
    method: ScienceClaimStatus[];
    result: ScienceClaimStatus[];
    limitation: ScienceClaimStatus[];
    "non-factual": ScienceClaimStatus[];
  };
  minimumRelevance: number;
  minimumAssessmentConfidence: number;
  requirePassedValidationForArtifactEvidence: boolean;
  contentSha256: string;
}

export type ScienceClaimLedgerGateIssueCode =
  | "active-claim-status-blocked"
  | "active-claim-evidence-required"
  | "evidence-below-policy-threshold"
  | "artifact-validation-required"
  | "artifact-validation-not-passed"
  | "orphan-manuscript-citation"
  | "evidence-citation-not-in-manuscript"
  | "manuscript-sentence-unclassified";

export interface ScienceClaimLedgerGateIssue {
  code: ScienceClaimLedgerGateIssueCode;
  claimId: string | null;
  evidenceAtomId: string | null;
  citationId: string | null;
}

export interface ScienceClaimLedgerPublicationGateReport {
  schema: typeof SCIENCE_CLAIM_LEDGER_GATE_SCHEMA;
  projectId: string;
  ledgerId: string;
  ledgerRevision: number;
  ledgerManifestSha256: string;
  manuscript: ScienceManuscriptBinding;
  policyId: string;
  policyVersion: number;
  policyContentSha256: string;
  manuscriptSentenceCount: number;
  classifiedSentenceCount: number;
  claimCoverageSha256: string;
  ready: boolean;
  issues: ScienceClaimLedgerGateIssue[];
  reportSha256: string;
}

export interface PrepareScienceClaimLedgerContextInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedManuscriptVersion: number;
  expectedManuscriptContentSha256: string;
  citationIds: string[];
  validationReceiptIds: string[];
}

export interface PrepareScienceClaimLedgerContextResult {
  manuscript: ScienceManuscriptBinding;
  segmentationPolicyId: string;
  segmentationPolicyVersion: number;
  sentenceManifestSha256: string;
  sentenceCount: number;
  citationSnapshots: Array<{ citationId: string; citationVersion: number; contentSha256: string }>;
  evidenceSpanSnapshots: Array<{ evidenceSpanId: string; evidenceSpanVersion: number; contentSha256: string }>;
  validationReceiptSnapshots: Array<{ validationReceiptId: string; validationReceiptVersion: number; contentSha256: string; status: "passed" | "failed" }>;
  replayed: boolean;
}

export interface CreateScienceClaimLedgerInput {
  requestId: string;
  projectId: string;
  manifest: ScienceClaimLedgerManifest;
}

export interface AppendScienceClaimLedgerManifestInput {
  requestId: string;
  projectId: string;
  ledgerId: string;
  expectedRevision: number;
  expectedManifestSha256: string;
  manifest: ScienceClaimLedgerManifest;
}

export interface ScienceClaimLedgerMutationResult {
  manifest: ScienceClaimLedgerManifest;
  gate: ScienceClaimLedgerPublicationGateReport;
  replayed: boolean;
}

export interface ScienceClaimLedgerReadModel {
  manifest: ScienceClaimLedgerManifest;
  gate: ScienceClaimLedgerPublicationGateReport;
  counts: {
    total: number;
    active: number;
    supported: number;
    contradicted: number;
    mixed: number;
    unresolved: number;
    notApplicable: number;
  };
}
