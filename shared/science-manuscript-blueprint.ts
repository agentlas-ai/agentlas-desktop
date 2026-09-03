export const SCIENCE_MANUSCRIPT_BLUEPRINT_SCHEMA = "agentlas.science.manuscript-blueprint/v1" as const;

export const SCIENCE_MANUSCRIPT_ARTICLE_FAMILIES = [
  "empirical",
  "theoretical-proof",
  "review-synthesis",
  "methods-model",
  "data-resource",
] as const;
export type ScienceManuscriptArticleFamily = typeof SCIENCE_MANUSCRIPT_ARTICLE_FAMILIES[number];

export type ScienceManuscriptSectionRole =
  | "abstract"
  | "introduction"
  | "related-work"
  | "methods"
  | "theory"
  | "results"
  | "discussion"
  | "limitations"
  | "conclusion"
  | "references"
  | "appendix"
  | "other";

export interface ScienceManuscriptBlueprintRange {
  minimum: number;
  maximum: number;
}

export const SCIENCE_MANUSCRIPT_CORPUS_STRUCTURE_PROFILE_SCHEMA =
  "agentlas.science.manuscript-corpus-structure-profile/v1" as const;

export interface ScienceManuscriptCorpusStructureMetricSummary {
  minimum: number;
  median: number;
  maximum: number;
}

export interface ScienceManuscriptCorpusStructureObservedSection {
  sectionId: string;
  ordinal: number;
  title: string;
  role: ScienceManuscriptSectionRole;
  wordCount: number;
  paragraphCount: number;
  contentSha256: string;
}

export interface ScienceManuscriptCorpusStructureScopeObservation {
  sectionIds: string[];
  wordCount: number;
  paragraphCount: number;
}

export interface ScienceManuscriptCorpusStructureComparableProfile {
  sourceId: string;
  sourceVersionId: string;
  sourceVersion: number;
  sourceContentSha256: string;
  textIndexId: string;
  textIndexContentSha256: string;
  observedSections: ScienceManuscriptCorpusStructureObservedSection[];
  observedRoleOrder: ScienceManuscriptSectionRole[];
  scopes: {
    abstract: ScienceManuscriptCorpusStructureScopeObservation;
    references: ScienceManuscriptCorpusStructureScopeObservation;
    appendix: ScienceManuscriptCorpusStructureScopeObservation;
  };
  counts: {
    figures: number;
    tables: number;
    equations: number;
    references: number;
  };
  contentSha256: string;
}

export interface ScienceManuscriptCorpusStructureTransitionSupport {
  from: ScienceManuscriptSectionRole;
  to: ScienceManuscriptSectionRole;
  supportCount: number;
  comparableCount: number;
  supportFraction: number;
}

export interface ScienceManuscriptCorpusStructureProfile {
  schema: typeof SCIENCE_MANUSCRIPT_CORPUS_STRUCTURE_PROFILE_SCHEMA;
  derivation: {
    parserId: "agentlas.source-text-chunker";
    parserVersion: "1.0.0";
    metricRevision: "exact-full-text-structure/v1";
    roleClassification: "normalized-section-heading";
    visualCountBasis: "unique-explicit-labels";
    referenceCountBasis: "reference-section-entry-boundaries";
  };
  comparables: ScienceManuscriptCorpusStructureComparableProfile[];
  scopeSummary: {
    abstractWords: ScienceManuscriptCorpusStructureMetricSummary;
    abstractParagraphs: ScienceManuscriptCorpusStructureMetricSummary;
    referenceWords: ScienceManuscriptCorpusStructureMetricSummary;
    referenceParagraphs: ScienceManuscriptCorpusStructureMetricSummary;
    appendixWords: ScienceManuscriptCorpusStructureMetricSummary;
    appendixParagraphs: ScienceManuscriptCorpusStructureMetricSummary;
  };
  countSummary: {
    figures: ScienceManuscriptCorpusStructureMetricSummary;
    tables: ScienceManuscriptCorpusStructureMetricSummary;
    equations: ScienceManuscriptCorpusStructureMetricSummary;
    references: ScienceManuscriptCorpusStructureMetricSummary;
  };
  consensus: {
    roleOrder: ScienceManuscriptSectionRole[];
    roleSupport: Array<{ role: ScienceManuscriptSectionRole; supportCount: number; comparableCount: number }>;
    transitions: ScienceManuscriptCorpusStructureTransitionSupport[];
  };
  plannedOrder: {
    roles: ScienceManuscriptSectionRole[];
    conflicts: Array<{ before: ScienceManuscriptSectionRole; after: ScienceManuscriptSectionRole }>;
    policy: "explicit-limitation";
  };
  contentSha256: string;
}

export interface ScienceManuscriptBlueprintComparableInput {
  sourceId: string;
  sourceVersionId: string;
  sourceVersion: number;
  sourceContentSha256: string;
  eligibilityReceiptId: string;
  sectionMappings: Array<{
    role: ScienceManuscriptSectionRole;
    sourceSectionIds: string[];
  }>;
}

export interface ScienceManuscriptBlueprintComparableSectionObservation {
  role: ScienceManuscriptSectionRole;
  sourceSectionIds: string[];
  sourceSectionTitles: string[];
  wordCount: number;
  paragraphCount: number;
  contentSha256: string;
}

export interface ScienceManuscriptBlueprintComparable extends Omit<ScienceManuscriptBlueprintComparableInput, "sectionMappings"> {
  title: string;
  canonicalUri: string;
  textIndexId: string;
  textIndexContentSha256: string;
  wordCount: number;
  paragraphCount: number;
  sectionCount: number;
  figureMentionCount: number;
  tableMentionCount: number;
  equationMentionCount: number;
  referenceEntryCount: number;
  sectionObservations: ScienceManuscriptBlueprintComparableSectionObservation[];
  snapshotSha256: string;
}

export interface ScienceManuscriptBlueprintSectionInput {
  key: string;
  title: string;
  role: ScienceManuscriptSectionRole;
  required: boolean;
  rhetoricalMoves: string[];
  visualExpectation: "none" | "optional" | "required";
  evidenceRoles: string[];
}

export interface ScienceManuscriptBlueprintSection extends ScienceManuscriptBlueprintSectionInput {
  /** Host-derived advisory range. Callers cannot lower this target. */
  targetWords: ScienceManuscriptBlueprintRange | null;
  /** Host-derived advisory range. Callers cannot pad or lower this target. */
  targetParagraphs: ScienceManuscriptBlueprintRange | null;
  calibrationBasis: "corpus-section" | "unresolved";
}

export interface ScienceManuscriptBlueprintJournalBindingInput {
  journalProfileId: string;
  journalProfileVersion: number;
  journalProfileContentSha256: string;
}

export interface ScienceManuscriptBlueprintCorpusSummary {
  comparableCount: number;
  wordCount: { minimum: number; median: number; maximum: number };
  paragraphCount: { minimum: number; median: number; maximum: number };
  sectionCount: { minimum: number; median: number; maximum: number };
  confidence: "low" | "medium" | "high";
}

export interface ScienceManuscriptBlueprintDocument {
  schema: typeof SCIENCE_MANUSCRIPT_BLUEPRINT_SCHEMA;
  articleFamily: ScienceManuscriptArticleFamily;
  comparables: ScienceManuscriptBlueprintComparable[];
  corpusSummary: ScienceManuscriptBlueprintCorpusSummary;
  journalBinding: ScienceManuscriptBlueprintJournalBindingInput | null;
  sections: ScienceManuscriptBlueprintSection[];
  totalTargetWords: ScienceManuscriptBlueprintRange;
  /**
   * Host-derived from exact comparable SourceVersion bytes. Optional only so
   * Blueprint documents persisted before this profile was introduced remain readable.
   * Every newly created Blueprint includes this immutable nested receipt.
   */
  structureProfile?: ScienceManuscriptCorpusStructureProfile;
  planningRationale: string;
  limitations: string[];
}

export interface ScienceManuscriptBlueprintVersion {
  id: string;
  blueprintId: string;
  version: number;
  document: ScienceManuscriptBlueprintDocument;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceManuscriptBlueprint {
  id: string;
  projectId: string;
  title: string;
  status: "collecting" | "current" | "stale";
  staleReasons: string[];
  currentVersion: number;
  version: ScienceManuscriptBlueprintVersion;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScienceManuscriptBlueprintInput {
  requestId: string;
  projectId: string;
  title: string;
  articleFamily: ScienceManuscriptArticleFamily;
  comparables: ScienceManuscriptBlueprintComparableInput[];
  journalBinding: ScienceManuscriptBlueprintJournalBindingInput | null;
  sections: ScienceManuscriptBlueprintSectionInput[];
  planningRationale: string;
  limitations: string[];
}

export interface AppendScienceManuscriptBlueprintVersionInput extends Omit<CreateScienceManuscriptBlueprintInput, "title"> {
  blueprintId: string;
  expectedVersion: number;
  expectedContentSha256: string;
}

export interface WriteScienceManuscriptBlueprintResult {
  blueprint: ScienceManuscriptBlueprint;
  replayed: boolean;
}

export interface ScienceManuscriptBlueprintBindingInput {
  blueprintId: string;
  blueprintVersion: number;
  blueprintContentSha256: string;
}

export interface ScienceManuscriptBlueprintBinding extends ScienceManuscriptBlueprintBindingInput {
  manuscriptVersionId: string;
  projectId: string;
  manuscriptId: string;
  manuscriptVersion: number;
  manuscriptContentSha256: string;
  manuscriptDocumentSha256: string;
  manuscriptBindingManifestSha256: string;
  createdAt: string;
}

export const SCIENCE_MANUSCRIPT_BLUEPRINT_ASSESSMENT_SCHEMA = "agentlas.science.manuscript-blueprint-assessment/v1" as const;

export interface ScienceManuscriptBlueprintAssessmentClosure {
  id: string;
  version: number;
  contentSha256: string;
}

export interface ScienceManuscriptBlueprintAssessmentManuscriptClosure extends ScienceManuscriptBlueprintAssessmentClosure {
  versionId: string;
  documentSha256: string;
  bindingManifestSha256: string;
}

export interface ScienceManuscriptBlueprintAssessmentBlueprintClosure extends ScienceManuscriptBlueprintAssessmentClosure {
  versionId: string;
}

export interface ScienceManuscriptBlueprintAssessmentSection {
  key: string;
  title: string;
  role: ScienceManuscriptSectionRole;
  required: boolean;
  observedHeading: string | null;
  observedHeadingNode: { id: string; revision: number; contentSha256: string } | null;
  observedWords: number;
  observedParagraphs: number;
  targetWords: ScienceManuscriptBlueprintRange | null;
  targetParagraphs: ScienceManuscriptBlueprintRange | null;
  status: "missing" | "gross-shortfall" | "below-range" | "within-range" | "above-range" | "unresolved";
}

export interface ScienceManuscriptBlueprintAssessmentFinding {
  code: "blueprint-current" | "anti-stub-depth" | "required-section-role" | "gross-corpus-depth";
  severity: "error" | "warning";
  status: "pass" | "fail";
  observed: string;
  required: string;
}

export interface ScienceManuscriptBlueprintAssessmentDepthPreflight {
  schema: "agentlas.science.manuscript-depth-preflight/v1";
  status: "stub" | "draft-depth-present";
  antiStubPassed: boolean;
  wordCount: number;
  paragraphCount: number;
  sections: Array<{
    heading: string;
    role: string;
    wordCount: number;
    paragraphCount: number;
    sentenceCount: number;
    figureCount: number;
    tableCount: number;
    citationCount: number;
  }>;
  substantiveSectionCount: number;
  issues: Array<{ code: string; heading: string | null; observed: string; required: string }>;
  requiresCorpusBlueprint: true;
  limitation: string;
  contentSha256: string;
}

/** Immutable deterministic assessment of one exact manuscript version against one exact Blueprint and journal profile. */
export interface ScienceManuscriptBlueprintAssessmentReceipt {
  schema: typeof SCIENCE_MANUSCRIPT_BLUEPRINT_ASSESSMENT_SCHEMA;
  id: string;
  projectId: string;
  manuscript: ScienceManuscriptBlueprintAssessmentManuscriptClosure;
  blueprint: ScienceManuscriptBlueprintAssessmentBlueprintClosure;
  journalProfile: ScienceManuscriptBlueprintAssessmentClosure;
  policy: ScienceManuscriptBlueprintAssessmentClosure;
  depthPreflight: ScienceManuscriptBlueprintAssessmentDepthPreflight;
  sections: ScienceManuscriptBlueprintAssessmentSection[];
  findings: ScienceManuscriptBlueprintAssessmentFinding[];
  structuralStatus: "blocked" | "passed";
  reportSha256: string;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceManuscriptBlueprintAssessmentReadModel {
  receipt: ScienceManuscriptBlueprintAssessmentReceipt;
  status: "current" | "stale";
  staleReasons: string[];
}

export interface RecordScienceManuscriptBlueprintAssessmentInput {
  requestId: string;
  projectId: string;
  manuscriptId: string;
  expectedManuscriptVersion: number;
  expectedManuscriptContentSha256: string;
  journalProfileId: string;
  expectedJournalProfileVersion: number;
  expectedJournalProfileContentSha256: string;
}

export interface RecordScienceManuscriptBlueprintAssessmentResult {
  assessment: ScienceManuscriptBlueprintAssessmentReadModel;
  replayed: boolean;
}
