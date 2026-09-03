import type { ScienceManuscriptBindingInput, ScienceManuscript } from "./science-contract";
import type {
  ScienceManuscriptBlueprintBindingInput,
  ScienceManuscriptBlueprintRange,
  ScienceManuscriptSectionRole,
} from "./science-manuscript-blueprint";
import type { ScienceManuscriptScholarlyEvaluator } from "./science-manuscript-scholarly-assessment";

export const SCIENCE_MANUSCRIPT_DRAFTING_SESSION_SCHEMA =
  "agentlas.science.manuscript-drafting-session/v1" as const;

export type ScienceManuscriptDraftingSessionStatus = "drafting" | "assembled" | "cancelled";
export type ScienceManuscriptDraftSectionStatus = "draft" | "ready";

export interface ScienceManuscriptDraftPlanSection {
  key: string;
  title: string;
  role: ScienceManuscriptSectionRole;
  required: boolean;
  origin: "blueprint" | "system-abstract";
  ordinal: number;
  targetWords: ScienceManuscriptBlueprintRange;
  targetParagraphs: ScienceManuscriptBlueprintRange;
  rhetoricalMoves: string[];
  evidenceRoles: string[];
  visualExpectation: "none" | "optional" | "required";
}

export interface ScienceManuscriptDraftSectionRevision {
  id: string;
  sessionId: string;
  projectId: string;
  sectionKey: string;
  revision: number;
  status: ScienceManuscriptDraftSectionStatus;
  markdown: string;
  contentSha256: string;
  wordCount: number;
  paragraphCount: number;
  writer: ScienceManuscriptScholarlyEvaluator;
  createdAt: string;
}

export interface ScienceManuscriptDraftSectionProgress {
  plan: ScienceManuscriptDraftPlanSection;
  current: ScienceManuscriptDraftSectionRevision | null;
}

export interface ScienceManuscriptDraftingSession {
  schema: typeof SCIENCE_MANUSCRIPT_DRAFTING_SESSION_SCHEMA;
  id: string;
  projectId: string;
  title: string;
  status: ScienceManuscriptDraftingSessionStatus;
  version: number;
  stateSha256: string;
  blueprintBinding: ScienceManuscriptBlueprintBindingInput;
  bindings: ScienceManuscriptBindingInput[];
  bindingManifestSha256: string;
  plan: ScienceManuscriptDraftPlanSection[];
  sections: ScienceManuscriptDraftSectionProgress[];
  assembledManuscript: {
    manuscriptId: string;
    manuscriptVersion: number;
    manuscriptContentSha256: string;
  } | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartScienceManuscriptDraftingSessionInput {
  requestId: string;
  projectId: string;
  title: string;
  blueprintBinding: ScienceManuscriptBlueprintBindingInput;
  bindings: ScienceManuscriptBindingInput[];
}

export interface StartScienceManuscriptDraftingSessionResult {
  session: ScienceManuscriptDraftingSession;
  replayed: boolean;
}

export interface SaveScienceManuscriptDraftSectionInput {
  requestId: string;
  projectId: string;
  sessionId: string;
  expectedVersion: number;
  expectedStateSha256: string;
  sectionKey: string;
  markdown: string;
}

export interface SaveScienceManuscriptDraftSectionResult {
  session: ScienceManuscriptDraftingSession;
  section: ScienceManuscriptDraftSectionRevision;
  replayed: boolean;
}

export interface AssembleScienceManuscriptDraftingSessionInput {
  requestId: string;
  projectId: string;
  sessionId: string;
  expectedVersion: number;
  expectedStateSha256: string;
}

export interface AssembleScienceManuscriptDraftingSessionResult {
  session: ScienceManuscriptDraftingSession;
  manuscript: ScienceManuscript;
  replayed: boolean;
}

export interface CancelScienceManuscriptDraftingSessionInput extends AssembleScienceManuscriptDraftingSessionInput {
  reason: string;
}

export interface CancelScienceManuscriptDraftingSessionResult {
  session: ScienceManuscriptDraftingSession;
  replayed: boolean;
}
