import type { ScienceManuscriptNodeKind } from "./science-manuscript-document";
import type {
  ScienceManuscriptBlueprintAssessmentBlueprintClosure,
  ScienceManuscriptBlueprintAssessmentClosure,
  ScienceManuscriptBlueprintAssessmentManuscriptClosure,
  ScienceManuscriptSectionRole,
} from "./science-manuscript-blueprint";

/**
 * A semantic assessment is an attested reading of one exact manuscript version.
 * It complements, and never replaces, the deterministic Blueprint depth receipt.
 */
export const SCIENCE_MANUSCRIPT_SCHOLARLY_ASSESSMENT_SCHEMA =
  "agentlas.science.manuscript-scholarly-assessment/v1" as const;

export interface ScienceManuscriptStableNodeLocator {
  nodeId: string;
  nodeRevision: number;
  nodeContentSha256: string;
  nodeKind: ScienceManuscriptNodeKind;
}

export interface ScienceManuscriptExactQuoteLocator extends ScienceManuscriptStableNodeLocator {
  nodeKind: "paragraph";
  from: number;
  to: number;
  exactQuote: string;
}

export type ScienceManuscriptScholarlyItemStatus = "satisfied" | "partial" | "missing";

export interface ScienceManuscriptScholarlyItemInput {
  label: string;
  status: ScienceManuscriptScholarlyItemStatus;
  confidence: number;
  evidence: ScienceManuscriptExactQuoteLocator[];
  rationale: string;
}

export interface ScienceManuscriptScholarlyFlowInput {
  status: "coherent" | "partial" | "broken";
  readerStartsWith: string;
  contribution: string;
  nextQuestion: string;
  confidence: number;
  evidence: ScienceManuscriptExactQuoteLocator[];
  rationale: string;
}

export interface ScienceManuscriptScholarlySectionInput {
  sectionKey: string;
  heading: ScienceManuscriptStableNodeLocator;
  rhetoricalMoves: ScienceManuscriptScholarlyItemInput[];
  evidenceRoleCoverage: ScienceManuscriptScholarlyItemInput[];
  flow: ScienceManuscriptScholarlyFlowInput;
}

/** Caller-owned judgments. Evaluator identity is supplied separately by trusted main-process context. */
export interface RecordScienceManuscriptScholarlyAssessmentInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedManuscriptVersion: number;
  expectedManuscriptContentSha256: string;
  expectedBlueprintAssessmentId: string;
  expectedBlueprintAssessmentReportSha256: string;
  journalProfileId: string;
  expectedJournalProfileVersion: number;
  expectedJournalProfileContentSha256: string;
  overallConfidence: number;
  sections: ScienceManuscriptScholarlySectionInput[];
  summary: string;
  limitations: string[];
}

/** Main-process-only Research Director identity. Never deserialize this value from renderer or MCP input. */
export interface ScienceManuscriptScholarlyEvaluator {
  method: "research-director-attestation";
  agentId: string;
  agentSlug: string;
  packageVersion: string;
  packageDigest: string;
  systemPromptSha256: string;
  invocationRunId: string;
}

export interface ScienceManuscriptScholarlyVisualCoverage {
  expectation: "none" | "optional" | "required";
  status: "satisfied" | "not-required" | "missing";
  evidence: ScienceManuscriptStableNodeLocator[];
}

export interface ScienceManuscriptScholarlySectionAssessment {
  sectionKey: string;
  title: string;
  role: ScienceManuscriptSectionRole;
  required: boolean;
  heading: ScienceManuscriptStableNodeLocator;
  observedParagraphNodeIds: string[];
  requiredParagraphs: number;
  rhetoricalMoves: ScienceManuscriptScholarlyItemInput[];
  evidenceRoleCoverage: ScienceManuscriptScholarlyItemInput[];
  flow: ScienceManuscriptScholarlyFlowInput;
  visualExpectationCoverage: ScienceManuscriptScholarlyVisualCoverage;
  status: "passed" | "blocked";
}

export interface ScienceManuscriptScholarlyAssessmentFinding {
  code:
    | "structural-assessment-current"
    | "section-paragraph-sequence"
    | "rhetorical-move-coverage"
    | "evidence-role-coverage"
    | "evidence-distribution"
    | "section-flow"
    | "visual-expectation"
    | "evaluator-confidence";
  sectionKey: string | null;
  severity: "error" | "warning";
  status: "pass" | "fail";
  observed: string;
  required: string;
}

export interface ScienceManuscriptScholarlyAssessmentReceipt {
  schema: typeof SCIENCE_MANUSCRIPT_SCHOLARLY_ASSESSMENT_SCHEMA;
  id: string;
  projectId: string;
  manuscript: ScienceManuscriptBlueprintAssessmentManuscriptClosure;
  blueprint: ScienceManuscriptBlueprintAssessmentBlueprintClosure;
  journalProfile: ScienceManuscriptBlueprintAssessmentClosure;
  blueprintAssessment: {
    id: string;
    reportSha256: string;
    policyContentSha256: string;
    contentSha256: string;
  };
  evaluator: ScienceManuscriptScholarlyEvaluator;
  policy: ScienceManuscriptBlueprintAssessmentClosure & {
    minimumConfidence: number;
    paragraphSequenceMode: "corpus-blueprint-minimum";
    requiredMoveMode: "exact-blueprint";
    exactLocatorMode: true;
    evidenceDistributionMode: "at-least-two-substantive-paragraphs-when-available";
    visualCoverageMode: "host-derived";
  };
  overallConfidence: number;
  sections: ScienceManuscriptScholarlySectionAssessment[];
  findings: ScienceManuscriptScholarlyAssessmentFinding[];
  summary: string;
  limitations: string[];
  scholarlyStatus: "passed" | "blocked";
  reportSha256: string;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceManuscriptScholarlyAssessmentReadModel {
  receipt: ScienceManuscriptScholarlyAssessmentReceipt;
  status: "current" | "stale";
  staleReasons: string[];
}

export interface RecordScienceManuscriptScholarlyAssessmentResult {
  assessment: ScienceManuscriptScholarlyAssessmentReadModel;
  replayed: boolean;
}
