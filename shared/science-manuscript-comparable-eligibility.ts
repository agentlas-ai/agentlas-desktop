import type { ScienceDomain } from "./science-contract";
import type {
  ScienceManuscriptArticleFamily,
  ScienceManuscriptBlueprintJournalBindingInput,
} from "./science-manuscript-blueprint";
import type { ScienceManuscriptScholarlyEvaluator } from "./science-manuscript-scholarly-assessment";

export const SCIENCE_MANUSCRIPT_COMPARABLE_ELIGIBILITY_SCHEMA =
  "agentlas.science.manuscript-comparable-eligibility/v1" as const;

export const SCIENCE_MANUSCRIPT_COMPARABLE_DECISIONS = [
  "quantitative-calibration",
  "rhetorical-analogue-only",
  "ineligible",
] as const;
export type ScienceManuscriptComparableDecision = typeof SCIENCE_MANUSCRIPT_COMPARABLE_DECISIONS[number];

export const SCIENCE_MANUSCRIPT_COMPARABLE_VENUE_RELATIONS = [
  "exact-target-journal",
  "same-field-peer-journal",
  "cross-field-analogue",
  "incompatible",
] as const;
export type ScienceManuscriptComparableVenueRelation = typeof SCIENCE_MANUSCRIPT_COMPARABLE_VENUE_RELATIONS[number];

export interface ScienceManuscriptComparableSourceClosure {
  sourceId: string;
  sourceVersionId: string;
  sourceVersion: number;
  sourceContentSha256: string;
  sourceKind: "journal-article" | "preprint" | "book";
  canonicalUri: string;
  title: string;
  containerTitle: string | null;
}

/** Exact UTF-8 byte quote from the immutable parsed SourceVersion. */
export interface ScienceManuscriptComparableSourceQuoteLocator {
  sectionId: string;
  startByte: number;
  endByte: number;
  exactQuote: string;
  exactQuoteSha256: string;
}

export interface RecordScienceManuscriptComparableEligibilityInput {
  requestId: string;
  projectId: string;
  sourceId: string;
  expectedSourceVersionId: string;
  expectedSourceVersion: number;
  expectedSourceContentSha256: string;
  sourceDomain: ScienceDomain;
  articleFamily: ScienceManuscriptArticleFamily;
  decision: ScienceManuscriptComparableDecision;
  venueRelation: ScienceManuscriptComparableVenueRelation;
  targetJournal: ScienceManuscriptBlueprintJournalBindingInput | null;
  evidence: ScienceManuscriptComparableSourceQuoteLocator[];
  rationale: string;
  limitations: string[];
}

export interface ScienceManuscriptComparableEligibilityReceipt {
  schema: typeof SCIENCE_MANUSCRIPT_COMPARABLE_ELIGIBILITY_SCHEMA;
  id: string;
  projectId: string;
  projectDomain: ScienceDomain;
  projectRelatedDomains: ScienceDomain[];
  sourceDomain: ScienceDomain;
  source: ScienceManuscriptComparableSourceClosure;
  articleFamily: ScienceManuscriptArticleFamily;
  decision: ScienceManuscriptComparableDecision;
  venueRelation: ScienceManuscriptComparableVenueRelation;
  targetJournal: ScienceManuscriptBlueprintJournalBindingInput | null;
  evidence: ScienceManuscriptComparableSourceQuoteLocator[];
  evaluator: ScienceManuscriptScholarlyEvaluator;
  rationale: string;
  limitations: string[];
  reportSha256: string;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceManuscriptComparableEligibilityReadModel {
  receipt: ScienceManuscriptComparableEligibilityReceipt;
  status: "current" | "stale";
  staleReasons: string[];
}

export interface RecordScienceManuscriptComparableEligibilityResult {
  eligibility: ScienceManuscriptComparableEligibilityReadModel;
  replayed: boolean;
}
