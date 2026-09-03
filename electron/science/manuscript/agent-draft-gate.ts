import type {
  ScienceManuscriptBlueprintDocument,
  ScienceManuscriptSectionRole,
} from "../../../shared/science-manuscript-blueprint";
import {
  inspectScienceManuscriptDepth,
  type ScienceManuscriptDepthPreflight,
} from "./depth-preflight";

export const SCIENCE_AGENT_MANUSCRIPT_DRAFT_GATE_SCHEMA =
  "agentlas.science.agent-manuscript-draft-gate/v1" as const;

export interface ScienceAgentManuscriptDraftGateIssue {
  code:
    | "anti-stub-depth"
    | "required-section-missing"
    | "section-grossly-below-corpus"
    | "section-paragraph-flow-below-corpus"
    | "document-grossly-below-corpus"
    | "document-paragraph-flow-below-corpus"
    | "duplicate-paragraph-padding";
  role: ScienceManuscriptSectionRole | null;
  observed: string;
  required: string;
}

export interface ScienceAgentManuscriptDraftGate {
  schema: typeof SCIENCE_AGENT_MANUSCRIPT_DRAFT_GATE_SCHEMA;
  status: "accepted" | "blocked";
  accepted: boolean;
  depthPreflight: ScienceManuscriptDepthPreflight;
  corpus: {
    comparableCount: number;
    confidence: ScienceManuscriptBlueprintDocument["corpusSummary"]["confidence"];
    targetWords: ScienceManuscriptBlueprintDocument["totalTargetWords"];
    targetParagraphs: ScienceManuscriptBlueprintDocument["corpusSummary"]["paragraphCount"];
  };
  issues: ScienceAgentManuscriptDraftGateIssue[];
  limitation: string;
}

function substantiveParagraphs(markdown: string): string[] {
  return String(markdown ?? "")
    .replace(/\r\n?/gu, "\n")
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph
      .replace(/^#{1,4}\s+.+$/gmu, " ")
      .replace(/```[\s\S]*?```/gu, " ")
      .replace(/\{\{(?:figure|table|cite|ref|eq):[^}]+\}\}/gu, " ")
      .replace(/^\s*\|.*\|\s*$/gmu, " ")
      .replace(/[`*_>#~-]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim())
    .filter((paragraph) => paragraph.length >= 120 && paragraph.split(/\s+/u).length >= 20);
}

function duplicatedSubstantiveParagraphs(markdown: string): number {
  const paragraphs = substantiveParagraphs(markdown);
  return paragraphs.length - new Set(paragraphs.map((paragraph) => paragraph.toLocaleLowerCase("en-US"))).size;
}

function normalizedHeading(value: string): string {
  return value.replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

/**
 * Prevent the Research Director from publishing an outline as manuscript v1.
 *
 * The small global anti-stub floor remains a deterministic first check. The
 * actual draft floor comes from exact comparable full texts in the bound
 * Blueprint, so fields and article families are never forced into one fixed
 * word count or IMRaD shape.
 */
export function evaluateScienceAgentManuscriptDraft(
  markdown: string,
  blueprint: ScienceManuscriptBlueprintDocument,
): ScienceAgentManuscriptDraftGate {
  const depthPreflight = inspectScienceManuscriptDepth(markdown);
  const issues: ScienceAgentManuscriptDraftGateIssue[] = [];
  if (!depthPreflight.antiStubPassed) {
    issues.push({
      code: "anti-stub-depth",
      role: null,
      observed: `${depthPreflight.wordCount} words; ${depthPreflight.issues.length} anti-stub issues`,
      required: "pass deterministic anti-stub inspection before corpus comparison",
    });
  }

  for (const planned of blueprint.sections.filter((section) => section.required)) {
    const observed = depthPreflight.sections.find((section) => normalizedHeading(section.heading) === normalizedHeading(planned.title))
      ?? depthPreflight.sections.find((section) => section.role === planned.role);
    if (!observed) {
      issues.push({
        code: "required-section-missing",
        role: planned.role,
        observed: "section absent",
        required: `required ${planned.role} section from the exact manuscript Blueprint`,
      });
      continue;
    }
    if (planned.targetWords && observed.wordCount < planned.targetWords.minimum) {
      issues.push({
        code: "section-grossly-below-corpus",
        role: planned.role,
        observed: `${observed.wordCount} words`,
        required: `at least the corpus lower range of ${planned.targetWords.minimum} words for Research Director draft creation; corpus target ${planned.targetWords.minimum}-${planned.targetWords.maximum}`,
      });
    }
    if (planned.targetParagraphs && observed.paragraphCount < planned.targetParagraphs.minimum) {
      issues.push({
        code: "section-paragraph-flow-below-corpus",
        role: planned.role,
        observed: `${observed.paragraphCount} substantive paragraphs`,
        required: `at least the corpus lower range of ${planned.targetParagraphs.minimum} substantive paragraphs for Research Director draft creation; corpus target ${planned.targetParagraphs.minimum}-${planned.targetParagraphs.maximum}`,
      });
    }
  }

  const documentFloor = blueprint.totalTargetWords.minimum;
  if (depthPreflight.wordCount < documentFloor) {
    issues.push({
      code: "document-grossly-below-corpus",
      role: null,
      observed: `${depthPreflight.wordCount} words`,
      required: `at least the corpus lower range of ${documentFloor} words for Research Director draft creation; corpus target ${blueprint.totalTargetWords.minimum}-${blueprint.totalTargetWords.maximum}`,
    });
  }
  const paragraphFloor = blueprint.corpusSummary.paragraphCount.minimum;
  if (depthPreflight.paragraphCount < paragraphFloor) {
    issues.push({
      code: "document-paragraph-flow-below-corpus",
      role: null,
      observed: `${depthPreflight.paragraphCount} substantive paragraphs`,
      required: `at least the corpus lower range of ${paragraphFloor} substantive paragraphs for Research Director draft creation; corpus target ${blueprint.corpusSummary.paragraphCount.minimum}-${blueprint.corpusSummary.paragraphCount.maximum}`,
    });
  }
  const duplicateParagraphCount = duplicatedSubstantiveParagraphs(markdown);
  if (duplicateParagraphCount > 0) {
    issues.push({
      code: "duplicate-paragraph-padding",
      role: null,
      observed: `${duplicateParagraphCount} duplicated substantive paragraphs`,
      required: "zero exact duplicate substantive paragraphs; every paragraph must perform a distinct scholarly job",
    });
  }

  return {
    schema: SCIENCE_AGENT_MANUSCRIPT_DRAFT_GATE_SCHEMA,
    status: issues.length ? "blocked" : "accepted",
    accepted: issues.length === 0,
    depthPreflight,
    corpus: {
      comparableCount: blueprint.corpusSummary.comparableCount,
      confidence: blueprint.corpusSummary.confidence,
      targetWords: blueprint.totalTargetWords,
      targetParagraphs: blueprint.corpusSummary.paragraphCount,
    },
    issues,
    limitation: "Acceptance permits the Research Director to create or replace a draft; it is not journal readiness. Claim, scholarly-flow, journal-rule, artifact, and human-attestation gates still apply.",
  };
}

export function assertScienceAgentManuscriptDraft(
  markdown: string,
  blueprint: ScienceManuscriptBlueprintDocument,
): ScienceAgentManuscriptDraftGate {
  const gate = evaluateScienceAgentManuscriptDraft(markdown, blueprint);
  if (!gate.accepted) {
    const summary = gate.issues.map((issue) => `${issue.code}${issue.role ? `:${issue.role}` : ""}`).join(",");
    throw new Error(`science-manuscript-agent-draft-blocked:${summary}`);
  }
  return gate;
}
