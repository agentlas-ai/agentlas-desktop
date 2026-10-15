import type {
  AgentlasSurfaceManifest,
  JsonObject,
  JsonValue,
} from "../../shared/types";
import {
  SURFACE_CLOSE_FENCE,
  SURFACE_OPEN_FENCE,
  parseSurfaces,
} from "../surface-emitter";
import { oneText } from "./one-copy";

// Structural adapter (owner rule 2026-10-13, native harness 04-host-roles §3):
// this file converts the SYNTAX of a model's markdown reply (tables, headings,
// paragraphs, task lists, links, file names) into a closed One Surface when the
// model did not emit one. It never reads wording to decide meaning: no
// recommendation rows are invented, no sentences are dropped by phrase, no
// table cell is filled from header words. Meaning (which option is recommended,
// what the schedule is) belongs to the model's own Surface.

const MAX_SOURCE_COUNT = 12;
const MAX_TABLE_ROWS = 40;
const MAX_TABLE_COLUMNS = 10;
const MAX_CELL_LENGTH = 1_000;

// ── Model-judged intent ──────────────────────────────────────────────────────
// The connected model labels the comparison widget by meaning. The host no
// longer builds travel/product layouts from words; the verdict only picks the
// table widget title. Without a verdict the neutral label is used.

export type OneMarkdownSurfaceIntent = "travel" | "product-comparison" | "generic";

export interface JudgedOneMarkdownSurfaceIntent {
  intent: OneMarkdownSurfaceIntent;
  source: "llm" | "unavailable";
}

export type OneMarkdownSurfaceJudge = (spec: {
  kind: string;
  question: string;
  labels: readonly OneMarkdownSurfaceIntent[];
  input: string;
  guidance?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<{ verdict: OneMarkdownSurfaceIntent | null; source: "llm" | "unavailable"; confidence: number; reason: string }>;

/** Judge the fallback surface intent for a One task prompt (async electron flow). */
export async function resolveOneMarkdownSurfaceIntent(
  taskPrompt: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; judgeFn?: OneMarkdownSurfaceJudge } = {},
): Promise<JudgedOneMarkdownSurfaceIntent> {
  if (!taskPrompt.trim()) return { intent: "generic", source: "unavailable" };
  let judgeFn = opts.judgeFn;
  if (!judgeFn) {
    const { judgeRequired } = await import("../system-agents/judgment");
    judgeFn = judgeRequired as unknown as OneMarkdownSurfaceJudge;
  }
  try {
    const verdict = await judgeFn({
      kind: "one-markdown-surface-intent",
      question:
        "Does this user task call for a PRODUCT COMPARISON (choosing between purchasable products/models) or a GENERIC report?",
      labels: ["product-comparison", "generic"] as const,
      input: taskPrompt.slice(0, 4_000),
      guidance: "Judge the request's meaning in any language.",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 300_000,
    });
    return verdict.verdict === null
      ? { intent: "generic", source: "unavailable" }
      : { intent: verdict.verdict, source: "llm" };
  } catch {
    return { intent: "generic", source: "unavailable" };
  }
}

function cleanText(value: string, maximum = MAX_CELL_LENGTH): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function parseCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cleanText(current));
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(cleanText(current));
  return cells.slice(0, MAX_TABLE_COLUMNS);
}

function separatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function firstMarkdownTable(markdown: string): { columns: string[]; rows: JsonObject[] } | null {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (!lines[index].includes("|") || !lines[index + 1].includes("|")) continue;
    const header = parseCells(lines[index]);
    const separator = parseCells(lines[index + 1]);
    if (header.length < 2 || separator.length !== header.length || !separatorRow(separator)) continue;
    const columns = header.map((cell, columnIndex) => cell || `Column ${columnIndex + 1}`);
    const rows: JsonObject[] = [];
    for (let cursor = index + 2; cursor < lines.length && rows.length < MAX_TABLE_ROWS; cursor += 1) {
      if (!lines[cursor].includes("|")) break;
      const cells = parseCells(lines[cursor]);
      if (cells.length !== columns.length) break;
      const row: JsonObject = {};
      columns.forEach((column, columnIndex) => {
        row[column] = (cells[columnIndex] || "—") as JsonValue;
      });
      rows.push(row);
    }
    if (rows.length >= 2) return { columns, rows };
  }
  return null;
}

/** First heading as written (structure only); otherwise the caller's fallback title. */
function firstHeading(markdown: string, fallbackTitle: string): string {
  const heading = /^#{1,3}[ \t]+(.+)$/m.exec(markdown)?.[1];
  return cleanText(heading || fallbackTitle, 160) || "One result";
}

function hasMeaningfulSurfacePayload(surface: AgentlasSurfaceManifest): boolean {
  return Object.values(surface.data).some((dataset) => {
    if (!["markdown", "metrics", "table", "timeline", "routes", "pricing", "media", "artifacts", "launch-checklist"].includes(dataset.type)) {
      return false;
    }
    if (Array.isArray(dataset.rows) && dataset.rows.length > 0) return true;
    if (Array.isArray(dataset.items) && dataset.items.length > 0) return true;
    if (typeof dataset.summary === "string" && cleanText(dataset.summary, 2_000).length >= 24) return true;
    if (typeof dataset.value === "string" && cleanText(dataset.value, 2_000).length >= 24) return true;
    if (Array.isArray(dataset.value) && dataset.value.length > 0) return true;
    if (dataset.value && typeof dataset.value === "object") return true;
    return false;
  });
}

function surfaceContentKinds(surface: AgentlasSurfaceManifest): Set<string> {
  const kinds = new Set<string>();
  for (const dataset of Object.values(surface.data)) {
    if (dataset.type === "markdown" && typeof dataset.value === "string" && cleanText(dataset.value, 2_000).length >= 24) {
      kinds.add("narrative");
    }
    if (dataset.type === "table" && Array.isArray(dataset.rows) && dataset.rows.length > 0) {
      kinds.add("table");
    }
    if (dataset.type === "timeline" && (dataset.items?.length || dataset.rows?.length)) kinds.add("timeline");
    if (dataset.type === "pricing" && (dataset.items?.length || dataset.rows?.length)) kinds.add("budget");
    if (dataset.type === "routes" && (dataset.items?.length || dataset.rows?.length)) kinds.add("map");
    if (dataset.type === "launch-checklist" && (dataset.items?.length || dataset.rows?.length)) kinds.add("checklist");
    if (dataset.type === "artifacts" && (dataset.items?.length || dataset.rows?.length)) kinds.add("artifacts");
    if (dataset.type === "media" && (dataset.items?.length || dataset.rows?.length)) kinds.add("media");
  }
  return kinds;
}

/**
 * A model-authored Surface may pass the closed schema while containing only a
 * title and sources. When the same visible answer structurally produces real
 * narrative or table data, prefer that richer closed Surface so One never hides
 * the useful answer behind an empty-looking card. Only dataset kinds are
 * compared; no wording is read and no model text is rewritten.
 */
export function chooseOneSurfaceForDisplay(
  parsed: AgentlasSurfaceManifest | null,
  deterministic: AgentlasSurfaceManifest | null,
): AgentlasSurfaceManifest | null {
  if (!parsed) return deterministic;
  if (!deterministic) return parsed;
  const parsedKinds = surfaceContentKinds(parsed);
  const deterministicKinds = surfaceContentKinds(deterministic);
  // Markdown reconstruction cannot prove or recreate a real file, media byte,
  // coordinate set, budget contract, or task checklist. Never trade one of
  // those model-authored semantic blocks for an extra prose block.
  const nonReconstructableKinds = new Set(["artifacts", "media", "timeline", "budget", "map", "checklist"]);
  if ([...parsedKinds].some((kind) => nonReconstructableKinds.has(kind) && !deterministicKinds.has(kind))) {
    return parsed;
  }
  if ([...deterministicKinds].some((kind) => !parsedKinds.has(kind))) return deterministic;
  return hasMeaningfulSurfacePayload(parsed) ? parsed : deterministic;
}

/**
 * Markdown summary: paragraphs/lists as written, without the table (it becomes
 * its own dataset), headings (the first heading is the title) and link-only
 * blocks (the source list is its own widget). Capped at four paragraphs.
 */
function linkOnlyBlock(paragraph: string): boolean {
  const withoutLinks = paragraph
    .replace(/\[[^\]]*\]\([^)\s]+\)/g, "")
    .replace(/https?:\/\/\S+/g, "");
  if (withoutLinks === paragraph) return false;
  return withoutLinks.replace(/[\p{P}\p{S}\s]/gu, "").length <= 12;
}

function summaryMarkdown(markdown: string): string {
  const withoutTable = markdown.replace(/^\|?.+\|.+\r?\n\|?\s*:?-{3,}[^\n]*\r?\n(?:\|?.+\|.*\r?\n?){2,40}/m, "");
  const paragraphs = withoutTable
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !/^#{1,4}[ \t]+/.test(paragraph) && !linkOnlyBlock(paragraph))
    .slice(0, 4)
    .join("\n\n");
  return paragraphs.slice(0, 6_000);
}

/** GFM task list items (`- [ ] x` / `- [x] x`) are the only checklist syntax. */
function taskListChecklist(markdown: string): JsonObject[] {
  const rows = [...markdown.matchAll(/^\s*[-*]\s+\[([ xX])\][ \t]+(.+)$/gm)]
    .map((match) => ({
      label: cleanText(match[2], 500),
      status: match[1] === " " ? "pending" : "completed",
    }))
    .filter((row) => row.label)
    .slice(0, MAX_TABLE_ROWS);
  return rows.length >= 2 ? rows : [];
}

/** A document with several headings and enough body is structured on its own. */
function structurallyRichNarrative(markdown: string): boolean {
  const headings = markdown.match(/^#{1,4}[ \t]+[^\r\n]+$/gm)?.length ?? 0;
  return headings >= 2 && cleanText(markdown, 10_000).length >= 160;
}

function markdownSources(markdown: string, observedUrls: string[] = []): Array<{ label: string; url: string }> {
  const sources: Array<{ label: string; url: string }> = [];
  const seen = new Set<string>();
  const representedHosts = new Set<string>();
  for (const match of markdown.matchAll(/\[([^\]]{1,200})\]\((https:\/\/[^\s)]+)\)/g)) {
    const label = cleanText(match[1], 200);
    const url = match[2];
    if (!label || seen.has(url)) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") continue;
      representedHosts.add(parsed.hostname.replace(/^www\./i, "").toLocaleLowerCase());
    } catch {
      continue;
    }
    seen.add(url);
    sources.push({ label, url });
    if (sources.length >= MAX_SOURCE_COUNT) break;
  }
  for (const value of observedUrls) {
    if (sources.length >= MAX_SOURCE_COUNT) break;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || seen.has(parsed.href)) continue;
      const host = parsed.hostname.replace(/^www\./i, "").toLocaleLowerCase();
      if (representedHosts.has(host)) continue;
      seen.add(parsed.href);
      representedHosts.add(host);
      sources.push({ label: parsed.hostname, url: parsed.href });
    } catch {
      continue;
    }
  }
  return sources;
}

function markdownArtifacts(markdown: string): JsonObject[] {
  const extensionKinds: Record<string, string> = {
    pdf: "document", docx: "document", txt: "document", md: "document",
    xlsx: "spreadsheet", csv: "spreadsheet", json: "data", zip: "archive",
    png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", avif: "image", bmp: "image",
    mp4: "video", webm: "video", mov: "video", m4v: "video", ogv: "video",
    mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", flac: "audio", aac: "audio",
  };
  const items: JsonObject[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(/(?:\*\*)?([^`*|<>\r\n\\/]{1,180}\.([A-Za-z0-9]{2,5}))(?:\*\*)?/gu)) {
    const label = cleanText(match[1], 200);
    const extension = match[2].toLocaleLowerCase();
    const type = extensionKinds[extension];
    if (!type || !label || seen.has(label.toLocaleLowerCase())) continue;
    seen.add(label.toLocaleLowerCase());
    items.push({ label, type, path: label, trust: "unverified" });
    if (items.length >= 24) break;
  }
  return items;
}

/**
 * Structural One fallback for runtimes that return useful Markdown but do not
 * obey the hidden Surface JSON contract. It promotes only syntax: the first
 * Markdown table (rows and columns exactly as written), headings, paragraphs,
 * task lists, file names and HTTPS links. No model HTML or executable code is
 * accepted, and no recommendation, schedule, budget or ranking is inferred
 * from wording.
 */
export function buildOneSurfaceFromMarkdown(input: {
  markdown: string;
  fallbackTitle: string;
  /** Kept for caller compatibility; the host does not read prompt wording. */
  taskPrompt?: string;
  observedSourceUrls?: string[];
  /**
   * A completed One tool run may be rendered as an explicitly unverified
   * operational report without public URLs. The caller owns that receipt
   * boundary; ordinary prose never receives this exception.
   */
  allowUncitedStructured?: boolean;
  /**
   * Model-judged intent resolved by the async caller (resolveOneMarkdownSurfaceIntent).
   * Only a source:"llm" product-comparison verdict changes the table widget
   * title; it never changes which rows or columns exist.
   */
  judgedIntent?: JudgedOneMarkdownSurfaceIntent;
}): AgentlasSurfaceManifest | null {
  const sources = markdownSources(input.markdown, input.observedSourceUrls);
  const table = firstMarkdownTable(input.markdown);
  const resolvedChecklist = taskListChecklist(input.markdown);
  const artifacts = markdownArtifacts(input.markdown);
  const uncitedStructured = input.allowUncitedStructured === true
    && (
      resolvedChecklist.length >= 2
      || structurallyRichNarrative(input.markdown)
      || (table?.rows.length ?? 0) >= 2
      || artifacts.length > 0
    );
  if (sources.length < 2 && !uncitedStructured) return null;

  const title = firstHeading(input.markdown, input.fallbackTitle);
  // Script detection (Hangul vs Latin) only picks the ko/en display strings.
  const hangulCount = input.markdown.match(/[가-힣]/g)?.length ?? 0;
  const ko = hangulCount >= 12 || /[가-힣]/.test(title);
  // Only a connected-model verdict labels the table as a comparison.
  const productComparison = input.judgedIntent?.source === "llm"
    && input.judgedIntent.intent === "product-comparison";
  const narrative = summaryMarkdown(input.markdown);
  if (!table && !narrative && resolvedChecklist.length === 0) return null;
  const candidate: AgentlasSurfaceManifest = {
    version: "0.1",
    kind: "surface",
    title,
    domain: sources.length >= 2 ? "research" : "operations",
    layout: table ? "table" : resolvedChecklist.length ? "workflow" : "report",
    data: {
      ...(narrative ? { summary: { type: "markdown", value: narrative } } : {}),
      ...(table ? { comparison: {
        type: "table",
        columns: table.columns,
        // The source list is attached to every row because Markdown tables do
        // not carry cell-level citation ids. This preserves the trust linter's
        // important-value boundary without upgrading a claim to "verified".
        rows: table.rows.map((row) => ({
          ...row,
          ...(sources.length
            ? { evidenceIds: sources.map((_, index) => `source_${index + 1}`) }
            : { trust: "unverified" }),
        })),
      } } : {}),
      ...(resolvedChecklist.length ? { checklist: {
        type: "launch-checklist",
        items: resolvedChecklist,
      } } : {}),
      ...(artifacts.length ? { artifacts: {
        type: "artifacts",
        items: artifacts,
      } } : {}),
    },
    widgets: [
      ...(narrative ? [{ type: "report", data: "summary", title: oneText(ko ? "ko" : "en", "one.md.widgetSummary") }] : []),
      ...(table ? [{
        type: "table",
        data: "comparison",
        title: productComparison ? oneText(ko ? "ko" : "en", "one.md.widgetComparison") : oneText(ko ? "ko" : "en", "one.md.widgetDetails"),
      }] : []),
      ...(resolvedChecklist.length ? [{ type: "launch-checklist", data: "checklist", title: oneText(ko ? "ko" : "en", "one.md.widgetDetails") }] : []),
      ...(artifacts.length ? [{ type: "report", data: "artifacts", title: oneText(ko ? "ko" : "en", "one.md.widgetFiles") }] : []),
      ...(sources.length ? [{ type: "source-matrix", title: oneText(ko ? "ko" : "en", "one.md.widgetSources") }] : []),
    ],
    ...(sources.length ? {
      evidence: sources.map((source, index) => ({
        id: `source_${index + 1}`,
        kind: "claimed",
        label: source.label,
        source: source.label,
        url: source.url,
      })),
      provenance: sources.map((source) => ({ source: source.label, url: source.url })),
    } : {}),
  };

  // Reuse the same closed validator as model-emitted manifests. A code-built
  // fallback never receives a weaker admission path.
  const parsed = parseSurfaces(`${SURFACE_OPEN_FENCE}\n${JSON.stringify(candidate)}\n${SURFACE_CLOSE_FENCE}`);
  return parsed.errors.length === 0 && parsed.surfaces.length === 1
    ? parsed.surfaces[0].manifest
    : null;
}
