import { sectionRole, type SectionRole } from "./document-model";

export const SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_SCHEMA = "agentlas.science.manuscript-depth-preflight/v1" as const;

export interface ScienceManuscriptSectionDepth {
  heading: string;
  role: SectionRole;
  wordCount: number;
  paragraphCount: number;
  sentenceCount: number;
  figureCount: number;
  tableCount: number;
  citationCount: number;
}

export interface ScienceManuscriptDepthIssue {
  code: "document-below-anti-stub-floor" | "abstract-below-anti-stub-floor" | "core-section-missing" | "core-section-below-anti-stub-floor" | "insufficient-substantive-sections";
  heading: string | null;
  observed: string;
  required: string;
}

export interface ScienceManuscriptDepthPreflight {
  schema: typeof SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_SCHEMA;
  status: "stub" | "draft-depth-present";
  antiStubPassed: boolean;
  wordCount: number;
  paragraphCount: number;
  sections: ScienceManuscriptSectionDepth[];
  substantiveSectionCount: number;
  issues: ScienceManuscriptDepthIssue[];
  requiresCorpusBlueprint: true;
  limitation: string;
}

export const SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_POLICY = Object.freeze({
  id: "agentlas.manuscript-depth-preflight-policy",
  version: 2,
  documentWordFloor: 500,
  abstractWordFloor: 75,
  coreSectionWordFloor: 60,
  coreSectionParagraphFloor: 2,
  substantiveSectionWordFloor: 75,
  minimumSubstantiveSections: 3,
  requiredEmpiricalRoles: ["introduction", "methods", "results", "discussion"] as SectionRole[],
});

const DOCUMENT_WORD_FLOOR = SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_POLICY.documentWordFloor;
const ABSTRACT_WORD_FLOOR = SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_POLICY.abstractWordFloor;
const CORE_SECTION_WORD_FLOOR = SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_POLICY.coreSectionWordFloor;
const CORE_SECTION_PARAGRAPH_FLOOR = SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_POLICY.coreSectionParagraphFloor;
const SUBSTANTIVE_SECTION_WORD_FLOOR = SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_POLICY.substantiveSectionWordFloor;
const REQUIRED_EMPIRICAL_ROLES = SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_POLICY.requiredEmpiricalRoles;

function prose(value: string): string {
  return value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\{\{(?:figure|table|cite|ref|eq):[^}]+\}\}/gu, " ")
    .replace(/^\s*\|.*\|\s*$/gmu, " ")
    .replace(/^\s*\$\$[\s\S]*?^\s*\$\$\s*$/gmu, " ")
    .replace(/[`*_>#~-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function words(value: string): number {
  const normalized = prose(value);
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function paragraphs(value: string): string[] {
  return value.split(/\n\s*\n/gu).map(prose).filter((item) => item.split(/\s+/u).filter(Boolean).length >= 8);
}

function sentences(value: string): number {
  const normalized = prose(value);
  if (!normalized) return 0;
  const matched = normalized.match(/(?:[.!?](?:["')\]]+)?)(?=\s|$)/gu);
  return Math.max(matched?.length ?? 0, normalized.length >= 40 ? 1 : 0);
}

function count(pattern: RegExp, value: string): number {
  return value.match(pattern)?.length ?? 0;
}

/**
 * Deterministic anti-stub inspection for the Research Director and UI.
 *
 * These deliberately small global floors reject heading scaffolds and one-line demonstrations.
 * Passing does not mean journal quality; the field/article/journal target remains the
 * corpus-derived blueprint in the built-in Research Director package.
 */
export function inspectScienceManuscriptDepth(markdown: string): ScienceManuscriptDepthPreflight {
  const source = String(markdown ?? "").replace(/\r\n?/gu, "\n");
  const matches = [...source.matchAll(/^(#{1,4})\s+(.+?)\s*#*\s*$/gmu)];
  const sectionBodies = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const level = match[1].length;
    const nextPeerOrAncestor = matches.slice(index + 1).find((candidate) => candidate[1].length <= level);
    const end = nextPeerOrAncestor?.index ?? source.length;
    return source.slice(start, end).trim();
  });
  const sections: ScienceManuscriptSectionDepth[] = matches.map((match, index) => {
    const body = sectionBodies[index];
    return {
      heading: match[2].replace(/[*_`]/gu, "").trim(),
      role: sectionRole(match[2]),
      wordCount: words(body),
      paragraphCount: paragraphs(body).length,
      sentenceCount: sentences(body),
      figureCount: count(/\{\{\s*figure\s*:/giu, body),
      tableCount: count(/\{\{\s*table\s*:/giu, body),
      citationCount: count(/\{\{\s*cite\s*:/giu, body) + count(/\[@[^\]]+\]/gu, body),
    };
  });
  const bodyBeforeFirstHeading = source.slice(0, matches[0]?.index ?? source.length);
  const wordCount = words(source.replace(/^#{1,4}\s+.+$/gmu, " "));
  const paragraphCount = paragraphs(`${bodyBeforeFirstHeading}\n\n${sectionBodies.join("\n\n")}`).length;
  const issues: ScienceManuscriptDepthIssue[] = [];

  if (wordCount < DOCUMENT_WORD_FLOOR) {
    issues.push({ code: "document-below-anti-stub-floor", heading: null, observed: `${wordCount} words`, required: `at least ${DOCUMENT_WORD_FLOOR} words before corpus calibration` });
  }
  const abstract = sections.find((section) => section.role === "abstract");
  if (abstract && abstract.wordCount < ABSTRACT_WORD_FLOOR) {
    issues.push({ code: "abstract-below-anti-stub-floor", heading: abstract.heading, observed: `${abstract.wordCount} words`, required: `at least ${ABSTRACT_WORD_FLOOR} words before corpus calibration` });
  }

  const empirical = sections.some((section) => section.role === "methods") || sections.some((section) => section.role === "results");
  if (empirical) {
    for (const role of REQUIRED_EMPIRICAL_ROLES) {
      const section = sections.find((item) => item.role === role);
      if (!section) {
        issues.push({ code: "core-section-missing", heading: role, observed: "section absent", required: `${role} section for an empirical draft` });
      } else if (section.wordCount < CORE_SECTION_WORD_FLOOR || section.paragraphCount < CORE_SECTION_PARAGRAPH_FLOOR) {
        issues.push({
          code: "core-section-below-anti-stub-floor",
          heading: section.heading,
          observed: `${section.wordCount} words, ${section.paragraphCount} substantive paragraphs`,
          required: `at least ${CORE_SECTION_WORD_FLOOR} words and ${CORE_SECTION_PARAGRAPH_FLOOR} substantive paragraphs before corpus calibration`,
        });
      }
    }
  }

  const substantiveSectionCount = sections.filter((section) => section.wordCount >= SUBSTANTIVE_SECTION_WORD_FLOOR).length;
  if (substantiveSectionCount < SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_POLICY.minimumSubstantiveSections) {
    issues.push({ code: "insufficient-substantive-sections", heading: null, observed: `${substantiveSectionCount} sections`, required: `at least ${SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_POLICY.minimumSubstantiveSections} sections with ${SUBSTANTIVE_SECTION_WORD_FLOOR}+ words before corpus calibration` });
  }

  return {
    schema: SCIENCE_MANUSCRIPT_DEPTH_PREFLIGHT_SCHEMA,
    status: issues.length ? "stub" : "draft-depth-present",
    antiStubPassed: issues.length === 0,
    wordCount,
    paragraphCount,
    sections,
    substantiveSectionCount,
    issues,
    requiresCorpusBlueprint: true,
    limitation: "Passing only rejects a heading scaffold or one-line demonstration. It does not prove scientific completeness, evidence support, target-journal fit, or publication readiness; compare the draft with its full-text corpus blueprint and verified journal profile.",
  };
}
