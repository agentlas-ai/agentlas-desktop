import { createHash } from "node:crypto";
import type {
  ScienceJournalProfile,
  ScienceManuscriptLayoutSpec,
  ScienceJournalWordCountScope as SharedScienceJournalWordCountScope,
} from "../../../shared/science-contract";
import type { FormattedReference } from "./bibliography";
import {
  inlineToPlainText,
  type BlockNode,
  type InlineNode,
  type ManuscriptDocument,
} from "./document-model";

/** The default layout used when a caller has not selected a verified journal rule. */
export const DEFAULT_MANUSCRIPT_LAYOUT: ScienceManuscriptLayoutSpec = {
  pageSize: "a4",
  marginsMm: { top: 25, right: 25, bottom: 25, left: 25 },
  fontFamily: "serif",
  fontSizePt: 11,
  lineSpacing: "single",
  lineNumbers: false,
};

export type ScienceJournalWordCountScope = SharedScienceJournalWordCountScope;

export interface ScienceJournalWordCountPolicy {
  schema: "agentlas.science-journal-word-count-policy/v1";
  maximum: number | null;
  maximumRuleId: string | null;
  abstractMaximum: number | null;
  abstractMaximumRuleId: string | null;
  scope: ScienceJournalWordCountScope;
  /** Whether the profile supplied a scope or this is the backwards-compatible renderer scope. */
  basis: "journal-rule" | "legacy-rendered-document";
  evidenceQuote: string | null;
  contentSha256: string;
}

export interface ScienceJournalRenderProfileReceipt {
  schema: "agentlas.science-journal-render-profile/v2";
  journalProfileId: string;
  journalProfileVersion: number;
  journalProfileContentSha256: string;
  bibliographyStyle: "numeric" | "apa" | "nature";
  layout: ScienceManuscriptLayoutSpec;
  wordCountPolicy: ScienceJournalWordCountPolicy;
  appliedRuleIds: string[];
  fallbackFields: Array<"bibliographyStyle" | "layout" | "renderTarget" | "latexTemplate" | "latexJournalStyle" | "columns" | "titlePageMode">;
  contentSha256: string;
}

export interface ScienceManuscriptWordCountReport {
  schema: "agentlas.science.manuscript-word-count/v1";
  total: number;
  maximum: number | null;
  withinMaximum: boolean | null;
  basis: ScienceJournalWordCountPolicy["basis"];
  scope: ScienceJournalWordCountScope;
  included: {
    title: number;
    headings: number;
    abstract: number;
    body: number;
    captions: number;
    tableCells: number;
    references: number;
    keywords: number;
  };
  /** Render-document counts keyed by normalized section heading for section rules. */
  sectionWordCounts: Record<string, number>;
  excluded: Array<keyof ScienceManuscriptWordCountReport["included"]>;
  maximumRuleId: string | null;
  abstractMaximum: number | null;
  abstractMaximumRuleId: string | null;
  evidenceQuote: string | null;
  contentSha256: string;
}

export interface ScienceManuscriptDraftBoundary {
  schema: "agentlas.science.manuscript-draft-boundary/v1";
  status: "draft";
  literalText: "DRAFT — NOT FOR SUBMISSION";
  machineReadableToken: "AGENTLAS-SCIENCE-DRAFT";
  reason: "preview-or-ordinary-render";
  manuscriptId: string | null;
  manuscriptVersion: number | null;
  manuscriptContentSha256: string;
  journalProfileId: string | null;
  journalProfileVersion: number | null;
  journalProfileContentSha256: string | null;
}

interface RawWordCountScope {
  includeTitle?: unknown;
  includeHeadings?: unknown;
  includeAbstract?: unknown;
  includeCaptions?: unknown;
  includeReferences?: unknown;
  includeTableCells?: unknown;
  includeKeywords?: unknown;
}

interface RawWordCountRule {
  kind: "max-manuscript-words";
  maximum: number;
  scope?: unknown;
  wordCountScope?: unknown;
  abstractMaximum?: unknown;
  abstractMaximumWords?: unknown;
}

interface RawSectionWordRule {
  kind: "max-section-words";
  heading: string;
  maximum: number;
}

const LEGACY_RENDERED_DOCUMENT_SCOPE: ScienceJournalWordCountScope = {
  includeTitle: false,
  includeHeadings: true,
  includeAbstract: true,
  includeCaptions: true,
  includeReferences: false,
  includeTableCells: true,
  includeKeywords: false,
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
}

function canonicalJson(value: unknown): string { return JSON.stringify(canonicalValue(value)); }

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedHeading(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function scopeFromRule(rule: RawWordCountRule | undefined): { scope: ScienceJournalWordCountScope; basis: ScienceJournalWordCountPolicy["basis"] } {
  const raw = isRecord(rule?.scope) ? rule?.scope : isRecord(rule?.wordCountScope) ? rule?.wordCountScope : null;
  if (!raw) return { scope: { ...LEGACY_RENDERED_DOCUMENT_SCOPE }, basis: "legacy-rendered-document" };
  const read = (key: keyof ScienceJournalWordCountScope, fallback: boolean): boolean => typeof raw[key] === "boolean" ? raw[key] as boolean : fallback;
  return {
    basis: "journal-rule",
    scope: {
      includeTitle: read("includeTitle", true),
      includeHeadings: read("includeHeadings", true),
      includeAbstract: read("includeAbstract", true),
      includeCaptions: read("includeCaptions", true),
      includeReferences: read("includeReferences", true),
      includeTableCells: read("includeTableCells", true),
      includeKeywords: read("includeKeywords", false),
    },
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function wordRuleScope(rule: unknown): RawWordCountRule | undefined {
  if (!isRecord(rule) || rule.kind !== "max-manuscript-words" || typeof rule.maximum !== "number") return undefined;
  return rule as unknown as RawWordCountRule;
}

function sectionWordRule(rule: unknown): RawSectionWordRule | undefined {
  if (!isRecord(rule) || rule.kind !== "max-section-words" || typeof rule.heading !== "string" || typeof rule.maximum !== "number") return undefined;
  return rule as unknown as RawSectionWordRule;
}

function deriveWordCountPolicy(profile: ScienceJournalProfile, wordRules: RawWordCountRule[], sectionRules: RawSectionWordRule[]): ScienceJournalWordCountPolicy {
  const selected = wordRules[0];
  if (wordRules.some((rule) => rule.maximum !== selected?.maximum)) throw new Error("science-journal-render-word-count-conflict");
  const abstractRules = sectionRules.filter((rule) => normalizedHeading(rule.heading) === "abstract");
  if (abstractRules.some((rule) => rule.maximum !== abstractRules[0]?.maximum)) throw new Error("science-journal-render-abstract-word-count-conflict");
  const selectedScope = scopeFromRule(selected);
  if (wordRules.some((rule) => canonicalJson(scopeFromRule(rule)) !== canonicalJson(selectedScope))) {
    throw new Error("science-journal-render-word-count-scope-conflict");
  }
  const core = {
    schema: "agentlas.science-journal-word-count-policy/v1" as const,
    maximum: selected?.maximum ?? null,
    maximumRuleId: (selected && profile.version.rules.find((rule) => rule.check === selected)?.id) ?? null,
    abstractMaximum: positiveInteger(abstractRules[0]?.maximum) ?? null,
    abstractMaximumRuleId: (abstractRules[0] && profile.version.rules.find((rule) => rule.check === abstractRules[0])?.id) ?? null,
    scope: selectedScope.scope,
    basis: selectedScope.basis,
    evidenceQuote: selected ? profile.version.rules.find((rule) => rule.check === selected)?.evidenceQuote ?? null : null,
  };
  return { ...core, contentSha256: sha256(canonicalJson(core)) };
}

/**
 * Derives the only render settings the host is allowed to use from verified journal rules.
 * This function deliberately has no store/runtime dependency; the caller must resolve and
 * version-check the profile before passing it here.
 */
export function deriveScienceJournalRenderProfile(profile: ScienceJournalProfile): ScienceJournalRenderProfileReceipt {
  const bibliographyRules = profile.version.rules.filter((rule) => rule.check.kind === "bibliography-style");
  const layoutRules = profile.version.rules.filter((rule) => rule.check.kind === "manuscript-layout");
  const wordRules = profile.version.rules.map((rule) => wordRuleScope(rule.check)).filter((rule): rule is RawWordCountRule => Boolean(rule));
  const sectionRules = profile.version.rules.map((rule) => sectionWordRule(rule.check)).filter((rule): rule is RawSectionWordRule => Boolean(rule));
  const bibliographyStyles = new Set(bibliographyRules.map((rule) => rule.check.kind === "bibliography-style" ? rule.check.style : "numeric"));
  const layoutValues = new Map(layoutRules.map((rule) => [
    canonicalJson(rule.check.kind === "manuscript-layout" ? rule.check : DEFAULT_MANUSCRIPT_LAYOUT),
    rule.check.kind === "manuscript-layout" ? rule.check : DEFAULT_MANUSCRIPT_LAYOUT,
  ]));
  if (bibliographyStyles.size > 1) throw new Error("science-journal-render-bibliography-conflict");
  if (layoutValues.size > 1) throw new Error("science-journal-render-layout-conflict");
  const bibliographyStyle = bibliographyRules.length ? [...bibliographyStyles][0] : "numeric";
  const selectedLayout = layoutRules.length ? [...layoutValues.values()][0] : DEFAULT_MANUSCRIPT_LAYOUT;
  const layout: ScienceManuscriptLayoutSpec = {
    pageSize: selectedLayout.pageSize,
    marginsMm: { ...selectedLayout.marginsMm },
    fontFamily: selectedLayout.fontFamily,
    fontSizePt: selectedLayout.fontSizePt,
    lineSpacing: selectedLayout.lineSpacing,
    lineNumbers: selectedLayout.lineNumbers,
    ...(selectedLayout.renderTarget === undefined ? {} : { renderTarget: selectedLayout.renderTarget }),
    ...(selectedLayout.latexTemplate === undefined ? {} : { latexTemplate: selectedLayout.latexTemplate }),
    ...(selectedLayout.latexJournalStyle === undefined ? {} : { latexJournalStyle: selectedLayout.latexJournalStyle }),
    ...(selectedLayout.columnCount === undefined ? {} : { columnCount: selectedLayout.columnCount }),
    ...(selectedLayout.columnGapMm === undefined ? {} : { columnGapMm: selectedLayout.columnGapMm }),
    ...(selectedLayout.titlePageMode === undefined ? {} : { titlePageMode: selectedLayout.titlePageMode }),
  };
  const wordCountPolicy = deriveWordCountPolicy(profile, wordRules, sectionRules);
  const core = {
    schema: "agentlas.science-journal-render-profile/v2" as const,
    journalProfileId: profile.id,
    journalProfileVersion: profile.currentVersion,
    journalProfileContentSha256: profile.version.contentSha256,
    bibliographyStyle,
    layout,
    wordCountPolicy,
    appliedRuleIds: [...bibliographyRules, ...layoutRules, ...profile.version.rules.filter((rule) => rule.check.kind === "max-manuscript-words" || rule.check.kind === "max-section-words")].map((rule) => rule.id).sort(),
    fallbackFields: [
      ...(bibliographyRules.length ? [] : ["bibliographyStyle" as const]),
      ...(layoutRules.length ? [] : ["layout" as const]),
      ...(selectedLayout.renderTarget === undefined ? ["renderTarget" as const] : []),
      ...(selectedLayout.latexTemplate === undefined ? ["latexTemplate" as const] : []),
      ...(selectedLayout.latexTemplate === "aps-revtex4-2" && selectedLayout.latexJournalStyle === undefined ? ["latexJournalStyle" as const] : []),
      ...(selectedLayout.columnCount === undefined ? ["columns" as const] : []),
      ...(selectedLayout.titlePageMode === undefined ? ["titlePageMode" as const] : []),
    ],
  };
  return { ...core, contentSha256: sha256(canonicalJson(core)) };
}

export function legacyScienceWordCountPolicy(): ScienceJournalWordCountPolicy {
  const core = {
    schema: "agentlas.science-journal-word-count-policy/v1" as const,
    maximum: null,
    maximumRuleId: null,
    abstractMaximum: null,
    abstractMaximumRuleId: null,
    scope: { ...LEGACY_RENDERED_DOCUMENT_SCOPE },
    basis: "legacy-rendered-document" as const,
    evidenceQuote: null,
  };
  return { ...core, contentSha256: sha256(canonicalJson(core)) };
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
function words(value: string): number { return (value.match(WORD_RE) ?? []).length; }
function countInline(nodes: InlineNode[]): number { return words(inlineToPlainText(nodes)); }

interface WordCountParts {
  headings: number;
  abstract: number;
  body: number;
  captions: number;
  tableCells: number;
}

function countBlocks(blocks: BlockNode[], includeHeadings: boolean, includeCaptions: boolean, includeTableCells: boolean, parts: WordCountParts, section: "abstract" | "body"): void {
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": if (includeHeadings) parts.headings += countInline(block.children); break;
      case "paragraph": case "list": case "blockquote": {
        const before = parts.body;
        const visit = (items: BlockNode[]) => {
          for (const item of items) {
            if (item.kind === "paragraph") parts.body += countInline(item.children);
            else if (item.kind === "list") for (const child of item.items) visit(child.children);
            else if (item.kind === "blockquote") visit(item.children);
            else if (item.kind === "heading" && includeHeadings) parts.headings += countInline(item.children);
            else if (item.kind === "figure" || item.kind === "bound-table") { if (includeCaptions) parts.captions += countInline(item.caption); }
            else if (item.kind === "table") {
              if (includeCaptions && item.caption) parts.captions += countInline(item.caption);
              if (includeTableCells) for (const row of [item.header, ...item.rows]) for (const cell of row) parts.tableCells += countInline(cell);
            }
          }
        };
        visit([block]);
        if (section === "abstract") parts.abstract += parts.body - before;
        break;
      }
      case "figure": case "bound-table": if (includeCaptions) parts.captions += countInline(block.caption); break;
      case "table":
        if (includeCaptions && block.caption) parts.captions += countInline(block.caption);
        if (includeTableCells) for (const row of [block.header, ...block.rows]) for (const cell of row) parts.tableCells += countInline(cell);
        break;
      default: break;
    }
  }
}

function countSectionWords(blocks: BlockNode[], policy: ScienceJournalWordCountPolicy, section: "abstract" | "body"): number {
  const parts: WordCountParts = { headings: 0, abstract: 0, body: 0, captions: 0, tableCells: 0 };
  // Section limits historically describe section prose and its rendered captions/tables;
  // the section heading itself is reported in the manuscript total when the journal scope
  // includes headings, but is not charged against a section's own limit.
  countBlocks(blocks, false, policy.scope.includeCaptions, policy.scope.includeTableCells, parts, section);
  return (section === "abstract" ? parts.abstract : parts.body) + parts.captions + parts.tableCells;
}

export function countScienceManuscriptWords(
  document: ManuscriptDocument,
  references: FormattedReference[],
  policy: ScienceJournalWordCountPolicy,
): ScienceManuscriptWordCountReport {
  const parts: WordCountParts = { headings: 0, abstract: 0, body: 0, captions: 0, tableCells: 0 };
  countBlocks(document.abstract, policy.scope.includeHeadings, policy.scope.includeCaptions, policy.scope.includeTableCells, parts, "abstract");
  const abstractBody = parts.abstract;
  countBlocks(document.body, policy.scope.includeHeadings, policy.scope.includeCaptions, policy.scope.includeTableCells, parts, "body");
  const title = policy.scope.includeTitle ? words(document.title) : 0;
  // The legacy parser removed the abstract heading before counting. Only a verified journal
  // scope that explicitly counts rendered headers charges the generated heading.
  const generatedAbstractHeading = policy.basis === "journal-rule" && policy.scope.includeHeadings && document.abstract.length ? words("Abstract") : 0;
  const generatedReferencesHeading = policy.scope.includeHeadings && policy.scope.includeReferences && references.length
    && !document.headings.some((heading) => heading.role === "references") ? words("References") : 0;
  const headings = policy.scope.includeHeadings ? parts.headings + generatedAbstractHeading + generatedReferencesHeading : 0;
  const abstract = policy.scope.includeAbstract ? abstractBody : 0;
  const body = parts.body - abstractBody;
  const captions = policy.scope.includeCaptions ? parts.captions : 0;
  const tableCells = policy.scope.includeTableCells ? parts.tableCells : 0;
  const referencesCount = policy.scope.includeReferences ? references.reduce((total, reference) => total + words(reference.text), 0) : 0;
  const keywords = policy.scope.includeKeywords ? document.keywords.reduce((total, keyword) => total + words(keyword), 0) : 0;
  const included = { title, headings, abstract, body, captions, tableCells, references: referencesCount, keywords };
  const total = Object.values(included).reduce((sum, value) => sum + value, 0);
  const sectionWordCounts: Record<string, number> = {};
  if (document.abstract.length) {
    const abstractCount = countSectionWords(document.abstract, policy, "abstract");
    // The parser deliberately removes the Abstract heading from the abstract body. Keep the
    // section-rule lookup compatible with the parser's documented abstract synonyms.
    for (const alias of ["abstract", "summary", "초록", "요약"]) sectionWordCounts[alias] = abstractCount;
  }
  const bodySections = new Map<string, BlockNode[]>();
  const sectionAliases = new Map<string, string>();
  let currentSection = "__main__";
  for (const block of document.body) {
    if (block.kind === "heading") {
      currentSection = block.slug || normalizedHeading(inlineToPlainText(block.children));
      if (!bodySections.has(currentSection)) bodySections.set(currentSection, []);
      const textKey = normalizedHeading(inlineToPlainText(block.children));
      if (textKey) sectionAliases.set(textKey, currentSection);
      if (block.role !== "other") sectionAliases.set(block.role, currentSection);
      continue;
    }
    const section = bodySections.get(currentSection) ?? [];
    section.push(block);
    bodySections.set(currentSection, section);
  }
  for (const [section, blocks] of bodySections) sectionWordCounts[section] = countSectionWords(blocks, policy, "body");
  for (const [alias, section] of sectionAliases) sectionWordCounts[alias] = sectionWordCounts[section] ?? 0;
  if (policy.scope.includeReferences && references.length) {
    const referenceSection = sectionAliases.get("references") ?? "references";
    sectionWordCounts[referenceSection] = (sectionWordCounts[referenceSection] ?? 0) + references.reduce((total, reference) => total + words(reference.text), 0);
    for (const [alias, section] of sectionAliases) if (section === referenceSection) sectionWordCounts[alias] = sectionWordCounts[referenceSection];
  }
  const scopeByKey: Record<keyof typeof included, boolean> = {
    title: policy.scope.includeTitle,
    headings: policy.scope.includeHeadings,
    abstract: policy.scope.includeAbstract,
    body: true,
    captions: policy.scope.includeCaptions,
    tableCells: policy.scope.includeTableCells,
    references: policy.scope.includeReferences,
    keywords: policy.scope.includeKeywords,
  };
  const excluded = (Object.keys(included) as Array<keyof typeof included>).filter((key) => !scopeByKey[key]);
  const core = {
    schema: "agentlas.science.manuscript-word-count/v1" as const,
    total,
    maximum: policy.maximum,
    withinMaximum: policy.maximum === null ? null : total <= policy.maximum,
    basis: policy.basis,
    scope: policy.scope,
    included,
    sectionWordCounts,
    excluded,
    maximumRuleId: policy.maximumRuleId,
    abstractMaximum: policy.abstractMaximum,
    abstractMaximumRuleId: policy.abstractMaximumRuleId,
    evidenceQuote: policy.evidenceQuote,
  };
  return { ...core, contentSha256: sha256(canonicalJson(core)) };
}

export function draftBoundaryForProfile(
  profile: ScienceJournalRenderProfileReceipt | null,
  manuscript: { id: string; currentVersion: number; version: { contentSha256: string } },
): ScienceManuscriptDraftBoundary {
  return {
    schema: "agentlas.science.manuscript-draft-boundary/v1",
    status: "draft",
    literalText: "DRAFT — NOT FOR SUBMISSION",
    machineReadableToken: "AGENTLAS-SCIENCE-DRAFT",
    reason: "preview-or-ordinary-render",
    manuscriptId: manuscript.id === "draft" ? null : manuscript.id,
    manuscriptVersion: manuscript.id === "draft" ? null : manuscript.currentVersion,
    manuscriptContentSha256: manuscript.version.contentSha256,
    journalProfileId: profile?.journalProfileId ?? null,
    journalProfileVersion: profile?.journalProfileVersion ?? null,
    journalProfileContentSha256: profile?.journalProfileContentSha256 ?? null,
  };
}
