import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type {
  CreateScienceJournalProfileInput,
  CreateScienceJournalProfileResult,
  CreateScienceSubmissionExportInput,
  CreateScienceSubmissionExportResult,
  ScienceJournalGuidelineInspection,
  ScienceJournalProfile,
  ScienceJournalRule,
  ScienceJournalValidationFinding,
  ScienceJournalValidationReport,
  ScienceJournalHumanAttestationReceipt,
  ScienceManuscript,
  ScienceManuscriptBinding,
  ScienceSubmissionMetadata,
} from "../../shared/science-contract";
import { SCIENCE_TABLE_SCHEMA, validateScienceTablePayload } from "../../shared/science-table";
import {
  buildSciencePublicationEditableDomainTable,
  buildSciencePublicationEditableTable,
  sciencePublicationTableSha256,
  type SciencePublicationEditableTableExport,
  verifySciencePublicationEditableTable,
} from "../../shared/science-publication-table";
import {
  SCIENCE_STATISTICS_FIGURE_VECTOR_ARTIFACT_SCHEMA,
  validateScienceStatisticsFigureRasterArtifactPayload,
  validateScienceStatisticsFigureVectorArtifactPayload,
} from "../../shared/science-statistics";
import {
  SCIENCE_NUMERIC_SURFACE_RASTER_ARTIFACT_SCHEMA,
  validateScienceNumericSurfaceRasterArtifactPayload,
} from "../../shared/science-numeric-3d";
import { ScienceStore } from "./store";
import { ScienceManuscriptRenderService, type ManuscriptRenderResult } from "./manuscript";
import { deriveScienceJournalRenderProfile, type ScienceJournalRenderProfileReceipt } from "./manuscript/journal-render-profile";
export { deriveScienceJournalRenderProfile } from "./manuscript/journal-render-profile";
export type { ScienceJournalRenderProfileReceipt } from "./manuscript/journal-render-profile";

const MAX_GUIDELINE_BYTES = 8 * 1024 * 1024;
const MAX_GUIDELINE_TEXT = 2_000_000;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
}

function canonicalJson(value: unknown): string { return JSON.stringify(canonicalValue(value)); }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function derivedRequestId(requestId: string, purpose: string): string {
  const hex = sha256(`${requestId}:${purpose}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface ScienceJournalRenderRealizationReceipt {
  schema: "agentlas.science-journal-render-realization/v1";
  renderProfileContentSha256: string;
  manuscriptContentSha256: string;
  status: "passed";
  checks: Array<{ id: string; status: "pass"; observed: string }>;
  outputs: Record<"html" | "latex" | "docx" | "pdf", { byteSize: number; sha256: string }>;
  typeset: {
    toolchain: NonNullable<NonNullable<ManuscriptRenderResult["pdf"]>["toolchain"]>;
    diagnostics: NonNullable<NonNullable<ManuscriptRenderResult["pdf"]>["typesetDiagnostics"]>;
  } | null;
  contentSha256: string;
}

/**
 * Proves that the final bytes realize the evidence-backed render profile. This
 * intentionally runs after rendering: profile metadata alone is not evidence
 * that HTML, TeX, DOCX, and PDF adopted the requested template and geometry.
 */
function verifyScienceJournalRenderRealization(
  profile: ScienceJournalRenderProfileReceipt,
  rendered: ManuscriptRenderResult,
): ScienceJournalRenderRealizationReceipt {
  if (!rendered.html || !rendered.latex || !rendered.docx || !rendered.pdf) throw new Error("science-journal-render-realization-output-missing");
  const layout = profile.layout;
  const columns = layout.columnCount ?? 1;
  const template = layout.latexTemplate ?? "generic-article";
  const target = layout.renderTarget ?? "initial-submission";
  const html = rendered.html;
  const latex = rendered.latex;
  const docx = unzipSync(rendered.docx);
  const documentXmlBytes = docx["word/document.xml"];
  if (!documentXmlBytes) throw new Error("science-journal-render-realization-docx-invalid");
  const documentXml = strFromU8(documentXmlBytes);
  const expectedSpace = Math.round((layout.columnGapMm ?? 7) * (1440 / 25.4));
  const checks: Array<{ id: string; status: "pass"; observed: string }> = [];
  const requireCheck = (id: string, pass: boolean, observed: string) => {
    if (!pass) throw new Error(`science-journal-render-realization-invalid:${id}:${observed}`);
    checks.push({ id, status: "pass", observed });
  };
  requireCheck("profile-roundtrip", canonicalJson(rendered.layout) === canonicalJson(layout), "renderer returned the exact immutable layout profile");
  requireCheck("html-profile", html.includes(`data-render-target="${target}"`) && html.includes(`data-latex-template="${template}"`) && html.includes(`data-columns="${columns}"`), `${target}; ${template}; ${columns} column(s)`);
  requireCheck("latex-profile", latex.includes(`% Render target: ${target}; template: ${template}; columns: ${columns}`), `${target}; ${template}; ${columns} column(s)`);
  requireCheck("docx-columns", documentXml.includes(`<w:cols w:num="${columns}" w:space="${expectedSpace}"/>`), `${columns} column(s), ${expectedSpace} twip gap`);
  if (columns === 2) {
    requireCheck("html-columns", rendered.css?.includes("column-count:2") === true, "two-column CSS body");
    requireCheck("latex-columns", template === "generic-article" ? latex.includes(",twocolumn]{article}") : latex.includes(",reprint,"), "two-column TeX recipe");
  }
  if (layout.titlePageMode === "separate") {
    requireCheck("latex-title-page", /\\maketitle\s+\\clearpage/u.test(latex), "page break follows title front matter");
    requireCheck("docx-title-page", documentXml.includes('<w:br w:type="page"/>'), "page break follows title front matter");
  }
  if (template === "aps-revtex4-2") {
    requireCheck("aps-template", latex.includes(`\\documentclass[aps${layout.latexJournalStyle ? `,${layout.latexJournalStyle}` : ""},`), `REVTeX 4.2 ${layout.latexJournalStyle ?? "unspecified APS journal"}`);
  }
  const exactTypesetRequested = profile.fallbackFields.every((field) => !["renderTarget", "latexTemplate", "columns", "titlePageMode", "latexJournalStyle"].includes(field));
  if (exactTypesetRequested) {
    requireCheck("pdf-engine", rendered.pdf.engine === "tectonic" && rendered.pdf.degraded === null, `${rendered.pdf.engine}; degraded=${rendered.pdf.degraded ?? "none"}`);
    const diagnostics = rendered.pdf.typesetDiagnostics;
    const toolchain = rendered.pdf.toolchain;
    requireCheck("typeset-toolchain", Boolean(toolchain && /^tectonic\b/iu.test(toolchain.version) && /^[a-f0-9]{64}$/u.test(toolchain.executableSha256)), toolchain ? `${toolchain.version}; ${toolchain.executableSha256}` : "missing");
    requireCheck("typeset-overflow", diagnostics?.overfullBoxCount === 0, `${diagnostics?.overfullBoxCount ?? "missing"} overfull boxes`);
    requireCheck("typeset-references", diagnostics?.undefinedReferenceCount === 0 && diagnostics?.multiplyDefinedLabelCount === 0 && diagnostics?.rerunWarningCount === 0, `${diagnostics?.undefinedReferenceCount ?? "missing"} undefined; ${diagnostics?.multiplyDefinedLabelCount ?? "missing"} multiply defined; ${diagnostics?.rerunWarningCount ?? "missing"} rerun warnings`);
    requireCheck("typeset-glyphs", diagnostics?.missingGlyphCount === 0, `${diagnostics?.missingGlyphCount ?? "missing"} missing glyphs`);
  }
  const outputs = {
    html: { byteSize: Buffer.byteLength(rendered.html), sha256: sha256(rendered.html) },
    latex: { byteSize: Buffer.byteLength(rendered.latex), sha256: sha256(rendered.latex) },
    docx: { byteSize: rendered.docx.byteLength, sha256: sha256(rendered.docx) },
    pdf: { byteSize: rendered.pdf.bytes.byteLength, sha256: sha256(rendered.pdf.bytes) },
  };
  const core = {
    schema: "agentlas.science-journal-render-realization/v1" as const,
    renderProfileContentSha256: profile.contentSha256,
    manuscriptContentSha256: rendered.manuscriptContentSha256,
    status: "passed" as const,
    checks,
    outputs,
    typeset: rendered.pdf.toolchain && rendered.pdf.typesetDiagnostics
      ? { toolchain: rendered.pdf.toolchain, diagnostics: rendered.pdf.typesetDiagnostics }
      : null,
  };
  return { ...core, contentSha256: sha256(canonicalJson(core)) };
}
function exactText(value: unknown, maximum: number, code: string, optional = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new Error(code);
  }
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized || normalized.length > maximum || /\u0000/.test(normalized)) throw new Error(code);
  return normalized;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'");
}

function htmlText(html: string): { title: string; text: string } {
  const titleMatch = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html);
  const title = decodeHtml((titleMatch?.[1] ?? "Official journal guidance").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 1_000);
  const text = decodeHtml(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:h[1-6]|p|li|tr|td|th|section|article|main|div|br|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim())
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 80 || text.length > MAX_GUIDELINE_TEXT) throw new Error("science-journal-guideline-text-invalid");
  return { title: title || "Official journal guidance", text };
}

function normalizedGuidelinePlainText(value: string): string {
  const text = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (text.length < 80 || text.length > MAX_GUIDELINE_TEXT) throw new Error("science-journal-guideline-text-invalid");
  return text;
}

async function pdfText(bytes: Buffer, fallbackTitle: string): Promise<{ title: string; text: string }> {
  let pdf: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    throw new Error("science-journal-guideline-pdf-parser-unavailable");
  }
  let loadingTask: ReturnType<typeof pdf.getDocument> | null = null;
  try {
    loadingTask = pdf.getDocument({
      data: new Uint8Array(bytes),
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
    });
    const document = await loadingTask.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > 1_000) {
      throw new Error("science-journal-guideline-pdf-pages-invalid");
    }
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let current = "";
      let previousY: number | null = null;
      for (const item of content.items) {
        if (!("str" in item) || typeof item.str !== "string") continue;
        const y = Array.isArray(item.transform) && Number.isFinite(item.transform[5]) ? Number(item.transform[5]) : null;
        if (previousY !== null && y !== null && Math.abs(previousY - y) > 2 && current.trim()) {
          lines.push(current.trim());
          current = "";
        }
        current += `${current ? " " : ""}${item.str}`;
        previousY = y;
      }
      if (current.trim()) lines.push(current.trim());
      pages.push(lines.join("\n"));
      page.cleanup();
    }
    const metadata = await document.getMetadata().catch(() => null);
    const rawTitle = metadata?.info && typeof metadata.info === "object" && "Title" in metadata.info
      ? String((metadata.info as { Title?: unknown }).Title ?? "").trim()
      : "";
    const title = (rawTitle || fallbackTitle).slice(0, 1_000);
    const text = normalizedGuidelinePlainText(pages.join("\n\n"));
    await document.destroy();
    return { title, text };
  } catch (error) {
    if (error instanceof Error && /^science-journal-guideline-/u.test(error.message)) throw error;
    throw new Error(`science-journal-guideline-pdf-invalid:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { await loadingTask?.destroy(); } catch { /* already destroyed or invalid */ }
  }
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return publicAddress(normalized.slice(7));
  return isIP(address) === 6 && normalized !== "::" && normalized !== "::1" && !normalized.startsWith("fc") && !normalized.startsWith("fd") && !/^fe[89ab]/.test(normalized);
}

function safeOfficialUrl(value: unknown): URL {
  const raw = exactText(value, 4_000, "science-journal-guideline-url-invalid")!;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("science-journal-guideline-url-invalid"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || !host.includes(".") || host === "localhost" || host.endsWith(".local") || isIP(host)) throw new Error("science-journal-guideline-url-denied");
  url.hash = "";
  return url;
}

async function readBounded(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_GUIDELINE_BYTES) throw new Error("science-journal-guideline-response-too-large");
  if (!response.body) throw new Error("science-journal-guideline-response-empty");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > MAX_GUIDELINE_BYTES) { await reader.cancel(); throw new Error("science-journal-guideline-response-too-large"); }
    chunks.push(chunk);
  }
  if (!total) throw new Error("science-journal-guideline-response-empty");
  return Buffer.concat(chunks, total);
}

function pinnedHttpsFetch(url: URL, address: string, family: number, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "text/html, application/pdf;q=0.95, text/plain;q=0.9", "user-agent": "Agentlas-Science/1.0 (official journal guideline inspection; https://agentlas.ai)" },
      servername: url.hostname,
      signal,
      lookup: (_hostname, _options, callback) => callback(null, address, family as 4 | 6),
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status: incoming.statusCode ?? 500, statusText: incoming.statusMessage, headers }));
    });
    request.once("error", reject);
    request.end();
  });
}

function markdownSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current = "__main__";
  let buffer: string[] = [];
  const flush = () => { sections.set(current, `${sections.get(current) ?? ""}\n${buffer.join("\n")}`.trim()); buffer = []; };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) { flush(); current = heading[1].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); continue; }
    buffer.push(line);
  }
  flush();
  return sections;
}

function normalizedNeedle(value: string): string { return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }

function metadataInput(value: ScienceSubmissionMetadata): ScienceSubmissionMetadata {
  if (!value || typeof value !== "object" || !Array.isArray(value.authors) || value.authors.length > 500) throw new Error("science-submission-metadata-invalid");
  const authors = value.authors.map((author) => {
    const name = exactText(author?.name, 500, "science-submission-author-invalid")!;
    if (!Array.isArray(author.affiliations) || !author.affiliations.length || author.affiliations.length > 20) throw new Error("science-submission-author-affiliations-invalid");
    const affiliations = author.affiliations.map((item) => exactText(item, 1_000, "science-submission-author-affiliation-invalid")!);
    const email = exactText(author.email, 500, "science-submission-author-email-invalid", true);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("science-submission-author-email-invalid");
    const orcid = exactText(author.orcid, 40, "science-submission-author-orcid-invalid", true);
    if (orcid && !/^(?:https:\/\/orcid\.org\/)?\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(orcid)) throw new Error("science-submission-author-orcid-invalid");
    return { name, affiliations, email, orcid, corresponding: Boolean(author.corresponding) };
  });
  const list = (input: unknown, maxItems: number, maxLength: number, code: string) => {
    if (!Array.isArray(input) || input.length > maxItems) throw new Error(code);
    const result = input.map((item) => exactText(item, maxLength, code)!);
    if (new Set(result).size !== result.length) throw new Error(code);
    return result;
  };
  return {
    authors,
    keywords: list(value.keywords, 100, 500, "science-submission-keywords-invalid"),
    fundingStatement: exactText(value.fundingStatement, 20_000, "science-submission-funding-invalid", true),
    competingInterestsStatement: exactText(value.competingInterestsStatement, 20_000, "science-submission-competing-interests-invalid", true),
    authorContributionsStatement: exactText(value.authorContributionsStatement, 40_000, "science-submission-contributions-invalid", true),
    dataAvailabilityStatement: exactText(value.dataAvailabilityStatement, 40_000, "science-submission-data-availability-invalid", true),
    codeAvailabilityStatement: exactText(value.codeAvailabilityStatement, 40_000, "science-submission-code-availability-invalid", true),
    ethicsStatement: exactText(value.ethicsStatement, 40_000, "science-submission-ethics-invalid", true),
    coverLetter: exactText(value.coverLetter, 100_000, "science-submission-cover-letter-invalid", true),
  };
}

function evaluateRule(rule: ScienceJournalRule, manuscript: ScienceManuscript, metadata: ScienceSubmissionMetadata, attestedCodes: Set<string>, store: ScienceStore, rendered: ManuscriptRenderResult | null): { status: "pass" | "fail" | "manual"; observed: string } {
  const markdown = manuscript.version.markdown;
  const sections = markdownSections(markdown);
  const check = rule.check;
  if (check.kind === "heading-present") {
    const existing = [...sections.keys()].map(normalizedNeedle);
    const matched = check.headings.filter((heading) => existing.some((item) => item === normalizedNeedle(heading))).length;
    return { status: matched >= check.minimumMatches ? "pass" : "fail", observed: `${matched}/${check.minimumMatches} required headings matched` };
  }
  if (check.kind === "max-title-characters") return { status: manuscript.title.length <= check.maximum ? "pass" : "fail", observed: `${manuscript.title.length}/${check.maximum} title characters` };
  if (check.kind === "max-section-words") {
    const target = normalizedNeedle(check.heading);
    const report = rendered?.document.wordCountReport;
    if (!report) return { status: "fail", observed: "rendered-document word count unavailable" };
    const count = report.sectionWordCounts[target];
    if (count === undefined) return { status: "fail", observed: `rendered-document section "${check.heading}" unavailable` };
    return { status: count <= check.maximum ? "pass" : "fail", observed: `${count}/${check.maximum} words in ${check.heading} (shared rendered-document count; section headings excluded)` };
  }
  if (check.kind === "max-manuscript-words") {
    const report = rendered?.document.wordCountReport;
    if (!report) return { status: "fail", observed: "rendered-document word count unavailable" };
    const count = report.total;
    const scope = Object.entries(report.scope).filter(([, included]) => included).map(([name]) => name).join(", ");
    return { status: count <= check.maximum ? "pass" : "fail", observed: `${count}/${check.maximum} manuscript words (basis=${report.basis}; included=${scope})` };
  }
  if (check.kind === "binding-count") {
    const count = manuscript.version.bindings.filter((binding) => binding.role === check.role).length;
    const pass = (check.minimum === undefined || count >= check.minimum) && (check.maximum === undefined || count <= check.maximum);
    return { status: pass ? "pass" : "fail", observed: `${count} ${check.role} bindings` };
  }
  if (check.kind === "required-text") {
    const haystack = `${markdown}\n${Object.values(metadata).filter((item) => typeof item === "string").join("\n")}`.toLowerCase();
    const matched = check.patterns.filter((pattern) => haystack.includes(pattern.toLowerCase())).length;
    return { status: matched >= check.minimumMatches ? "pass" : "fail", observed: `${matched}/${check.minimumMatches} required text patterns matched` };
  }
  if (check.kind === "output-format") {
    const produced = ["docx", "tex", "pdf", "zip", "html", "bib", "md"];
    const matches = check.allowed.filter((item) => produced.includes(item));
    return { status: matches.length ? "pass" : "fail", observed: `bundle produces ${produced.join(", ")}; allowed ${check.allowed.join(", ")}` };
  }
  if (check.kind === "bibliography-style") {
    return { status: "pass", observed: `bibliography renderer selected: ${check.style}` };
  }
  if (check.kind === "manuscript-layout") {
    const advanced = [
      `target ${check.renderTarget ?? "initial-submission"}`,
      `template ${check.latexTemplate ?? "generic-article"}`,
      check.latexJournalStyle ? `journal style ${check.latexJournalStyle}` : null,
      `${check.columnCount ?? 1} column${(check.columnCount ?? 1) === 1 ? "" : "s"}`,
      check.columnCount === 2 ? `gap ${check.columnGapMm ?? 7} mm` : null,
      `title page ${check.titlePageMode ?? "inline"}`,
    ].filter(Boolean).join(", ");
    return {
      status: "pass",
      observed: `${check.pageSize}, ${check.fontSizePt}pt ${check.fontFamily}, ${check.lineSpacing} spacing, margins ${check.marginsMm.top}/${check.marginsMm.right}/${check.marginsMm.bottom}/${check.marginsMm.left} mm, line numbers ${check.lineNumbers ? "on" : "off"}, ${advanced}`,
    };
  }
  if (check.kind === "figure-raster-profile") {
    const figures = manuscript.version.bindings.filter((binding) => binding.role === "figure");
    let verified = 0;
    for (const binding of figures) {
      if (binding.target.kind !== "artifact") continue;
      try {
        const context = store.getArtifactContextForProject(manuscript.projectId, binding.target.artifactId, binding.target.artifactVersion);
        const preview = store.artifactVisualCaptureForBinding(
          manuscript.projectId,
          binding.target.artifactId,
          binding.target.artifactVersion,
          binding.target.captureId,
          binding.target.validationReceiptId,
        );
        if (!context?.isCurrent || context.artifact.kind !== "image" || context.selectedVersion.rendererId !== "agentlas.image" || !preview) continue;
        const raster = context.selectedVersion.payload.schema === SCIENCE_NUMERIC_SURFACE_RASTER_ARTIFACT_SCHEMA
          ? validateScienceNumericSurfaceRasterArtifactPayload(context.selectedVersion.payload)
          : validateScienceStatisticsFigureRasterArtifactPayload(context.selectedVersion.payload);
        if (raster.export.dpi < check.minimumDpi || !check.allowedColorSpaces.includes(raster.export.colorSpace)
          || raster.export.sha256 !== preview.sha256 || raster.export.byteSize !== preview.byteSize
          || raster.export.width !== preview.width || raster.export.height !== preview.height) continue;
        verified += 1;
      } catch {
        // Any stale, malformed, or non-raster Figure binding fails the rule.
      }
    }
    const pass = figures.length > 0 && verified === figures.length;
    return {
      status: pass ? "pass" : "fail",
      observed: `${verified}/${figures.length} figure bindings are exact persisted PNG exports at >=${check.minimumDpi} DPI in ${check.allowedColorSpaces.join(" or ")}`,
    };
  }
  if (check.kind === "figure-vector-profile") {
    const figures = manuscript.version.bindings.filter((binding) => binding.role === "figure");
    let verified = 0;
    for (const binding of figures) {
      if (binding.target.kind !== "artifact") continue;
      try {
        const context = store.getArtifactContextForProject(manuscript.projectId, binding.target.artifactId, binding.target.artifactVersion);
        const preview = store.artifactVisualCaptureForBinding(
          manuscript.projectId,
          binding.target.artifactId,
          binding.target.artifactVersion,
          binding.target.captureId,
          binding.target.validationReceiptId,
        );
        const vector = context ? validateScienceStatisticsFigureVectorArtifactPayload(context.selectedVersion.payload) : null;
        const asset = store.statisticsFigureSvgAssetForBinding(manuscript.projectId, binding.target.artifactId, binding.target.artifactVersion);
        if (!context?.isCurrent || context.artifact.kind !== "image" || context.selectedVersion.rendererId !== "agentlas.image"
          || !preview || !vector || !asset || !check.allowedFormats.includes("svg")
          || vector.export.sha256 !== asset.sha256 || vector.export.byteSize !== asset.byteSize) continue;
        verified += 1;
      } catch {
        // Any stale, malformed, or non-vector Figure binding fails the rule.
      }
    }
    const pass = figures.length > 0 && verified === figures.length;
    return {
      status: pass ? "pass" : "fail",
      observed: `${verified}/${figures.length} figure bindings are exact persisted UTF-8 SVG exports`,
    };
  }
  const passed = attestedCodes.has(check.code.toLowerCase());
  return { status: passed ? "pass" : "manual", observed: passed ? `human receipt verified: ${check.code}` : `human attestation receipt required: ${check.code}` };
}

function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;"); }
function latex(value: string): string { return value.replace(/\\/g, "\\textbackslash{}").replace(/([#$%&_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}"); }

function slug(value: string): string { return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "journal"; }
function imageExtension(mimeType: string): "png" | "jpg" | "webp" {
  return mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
}

function editableTableForBinding(store: ScienceStore, manuscript: ScienceManuscript, binding: ScienceManuscriptBinding): SciencePublicationEditableTableExport {
  if (binding.role !== "table" || binding.target.kind !== "artifact") throw new Error("science-submission-editable-table-binding-invalid");
  const context = store.getArtifactContextForProject(manuscript.projectId, binding.target.artifactId, binding.target.artifactVersion);
  if (!context) throw new Error("science-submission-editable-table-artifact-invalid");
  const sourceRunId = context.artifact.sourceRunId;
  const run = sourceRunId ? store.getResearchRunForProject(manuscript.projectId, sourceRunId) : null;
  const runArtifactBinding = sourceRunId ? store.getRunArtifactBinding(manuscript.projectId, sourceRunId) : null;
  if (!run || !runArtifactBinding) throw new Error("science-submission-editable-table-lineage-missing");
  const payload = context.selectedVersion.payload;
  const analysis = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { analysis?: { publicationTable?: unknown } }).analysis : null;
  if (context.artifact.kind === "chart.vega" && context.selectedVersion.rendererId === "agentlas.vega" && analysis?.publicationTable) {
    return verifySciencePublicationEditableTable(buildSciencePublicationEditableDomainTable({
      context,
      run,
      runArtifactBinding,
      selection: { title: context.artifact.title, caption: binding.locator },
    }));
  }
  if (context.artifact.kind !== "table" || payload.schema !== SCIENCE_TABLE_SCHEMA) {
    throw new Error("science-submission-editable-table-artifact-invalid");
  }
  const table = validateScienceTablePayload(payload);
  return verifySciencePublicationEditableTable(buildSciencePublicationEditableTable({
    context,
    run,
    runArtifactBinding,
    selection: {
      title: context.artifact.title,
      caption: binding.locator,
      columns: table.columns.map((column) => column.name),
      rowIndices: Array.from({ length: table.rows.length }, (_value, index) => index),
    },
  }));
}

function editableTableManifestEvidence(value: SciencePublicationEditableTableExport, packageBase: string): Record<string, unknown> {
  const assets = {
    docx: { packagePath: `${packageBase}.docx`, fileName: value.assets.docx.fileName, mimeType: value.assets.docx.mimeType, byteSize: value.assets.docx.byteSize, sha256: value.assets.docx.sha256 },
    tex: { packagePath: `${packageBase}.tex`, fileName: value.assets.tex.fileName, mimeType: value.assets.tex.mimeType, byteSize: value.assets.tex.byteSize, sha256: value.assets.tex.sha256 },
    json: { packagePath: `${packageBase}.json`, fileName: value.assets.json.fileName, mimeType: value.assets.json.mimeType, byteSize: value.assets.json.byteSize, sha256: value.assets.json.sha256 },
  };
  return {
    schema: "agentlas.science.publication-editable-table-manifest-evidence/v1",
    bindingSha256: value.binding.bindingSha256,
    documentSha256: sciencePublicationTableSha256(value.document),
    assets,
    manifestSha256: value.manifestSha256,
  };
}

type JournalManuscriptCoherenceAssessment = {
  status: "current" | "stale";
  staleReasons: string[];
  receipt: {
    id: string;
    projectId: string;
    manuscript: {
      manuscriptId: string;
      versionId: string;
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
    };
    status: "passed" | "blocked";
    reportSha256: string;
    contentSha256: string;
  };
};

function currentPassedCoherenceAssessment(
  assessment: JournalManuscriptCoherenceAssessment | null,
  manuscript: ScienceManuscript,
  claimLedger: ReturnType<ScienceStore["evaluateClaimLedgerForManuscript"]> | null,
): assessment is JournalManuscriptCoherenceAssessment {
  if (!assessment || assessment.status !== "current" || assessment.staleReasons.length !== 0
    || assessment.receipt.status !== "passed" || !claimLedger?.gate.ready) return false;
  const { receipt } = assessment;
  return receipt.projectId === manuscript.projectId
    && receipt.manuscript.manuscriptId === manuscript.id
    && receipt.manuscript.versionId === manuscript.version.id
    && receipt.manuscript.version === manuscript.currentVersion
    && receipt.manuscript.contentSha256 === manuscript.version.contentSha256
    && receipt.manuscript.documentSha256 === manuscript.version.documentSha256
    && receipt.manuscript.bindingManifestSha256 === manuscript.version.bindingManifestSha256
    && receipt.claimLedger.ledgerId === claimLedger.manifest.ledgerId
    && receipt.claimLedger.revision === claimLedger.manifest.revision
    && receipt.claimLedger.manifestSha256 === claimLedger.manifest.manifestSha256
    && receipt.claimLedger.gateReportSha256 === claimLedger.gate.reportSha256
    && receipt.claimLedger.policyContentSha256 === claimLedger.gate.policyContentSha256;
}

export class ScienceJournalPublicationService {
  constructor(
    private readonly store: ScienceStore,
    private readonly fetchImpl: typeof fetch | null = null,
    private readonly resolveHost: typeof dns.lookup = dns.lookup,
  ) {}

  async inspectOfficialGuidelines(input: { projectId: string; sourceUrl: string }): Promise<ScienceJournalGuidelineInspection> {
    if (!this.store.getProject(input.projectId)) throw new Error("science-project-not-found");
    const url = safeOfficialUrl(input.sourceUrl);
    const addresses = await this.resolveHost(url.hostname, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => !publicAddress(entry.address))) throw new Error("science-journal-guideline-host-denied");
    const pinned = addresses[0];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = this.fetchImpl
        ? await this.fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "text/html, application/pdf;q=0.95, text/plain;q=0.9", "user-agent": "Agentlas-Science/1.0 (official journal guideline inspection; https://agentlas.ai)" } })
        : await pinnedHttpsFetch(url, pinned.address, pinned.family, controller.signal);
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(`science-journal-guideline-http-${response.status}`);
    const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (mimeType !== "text/html" && mimeType !== "text/plain" && mimeType !== "application/pdf") throw new Error("science-journal-guideline-mime-invalid");
    const bytes = await readBounded(response);
    const extracted = mimeType === "application/pdf"
      ? await pdfText(bytes, url.hostname)
      : mimeType === "text/html"
        ? htmlText(bytes.toString("utf8"))
        : { title: url.hostname, text: normalizedGuidelinePlainText(bytes.toString("utf8")) };
    return this.store.recordJournalGuidelineInspection({
      projectId: input.projectId, sourceUrl: url.toString(), officialHost: url.hostname.toLowerCase(), pageTitle: extracted.title,
      mimeType, responseBytes: bytes, normalizedText: extracted.text, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"), retrievedAt: new Date().toISOString(),
    });
  }

  createJournalProfile(input: CreateScienceJournalProfileInput): CreateScienceJournalProfileResult { return this.store.createJournalProfile(input); }
  listJournalProfiles(projectId: string): ScienceJournalProfile[] { return this.store.listJournalProfiles(projectId); }
  confirmJournalIdentity(input: Parameters<ScienceStore["confirmJournalIdentity"]>[0]) { return this.store.confirmJournalIdentity(input); }
  confirmHumanAttestation(input: Parameters<ScienceStore["confirmJournalHumanAttestation"]>[0]) { return this.store.confirmJournalHumanAttestation(input); }

  validate(manuscript: ScienceManuscript, profile: ScienceJournalProfile, rawMetadata?: ScienceSubmissionMetadata, humanAttestationReceiptIds: string[] = [], allowConsumedByExportId: string | null = null): ScienceJournalValidationReport {
    if (profile.status !== "verified" || !profile.version.identityReceiptId || !profile.version.identityReceiptSha256 || !profile.version.coverageManifestSha256 || profile.version.coverage.some((entry) => entry.status === "unresolved")) {
      throw new Error("science-journal-profile-not-ready");
    }
    const metadata = metadataInput(rawMetadata ?? { authors: [], keywords: [], fundingStatement: null, competingInterestsStatement: null, authorContributionsStatement: null, dataAvailabilityStatement: null, codeAvailabilityStatement: null, ethicsStatement: null, coverLetter: null });
    const receipts = humanAttestationReceiptIds.map((receiptId) => this.store.getJournalHumanAttestationReceiptForProject(manuscript.projectId, receiptId));
    if (receipts.some((receipt) => !receipt || receipt.consumedByExportId !== null && receipt.consumedByExportId !== allowConsumedByExportId || receipt.manuscriptId !== manuscript.id || receipt.manuscriptVersion !== manuscript.currentVersion
      || receipt.manuscriptContentSha256 !== manuscript.version.contentSha256 || receipt.journalProfileId !== profile.id || receipt.journalProfileVersion !== profile.currentVersion
      || receipt.journalProfileContentSha256 !== profile.version.contentSha256)) throw new Error("science-journal-attestation-receipt-mismatch");
    const attestedCodes = new Set(receipts.map((receipt) => (receipt as ScienceJournalHumanAttestationReceipt).code));
    let claimLedger: ReturnType<ScienceStore["evaluateClaimLedgerForManuscript"]> | null = null;
    try {
      claimLedger = this.store.evaluateClaimLedgerForManuscript(manuscript.projectId, manuscript.id);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "science-claim-ledger-required") throw error;
    }
    const blueprintValidation = this.store.evaluateManuscriptBlueprintForJournal(manuscript.projectId, manuscript.id, profile.id);
    const blueprintAssessment = this.store.getManuscriptBlueprintAssessmentForManuscript(manuscript.projectId, manuscript.id);
    const blueprintAssessmentReady = Boolean(blueprintAssessment && blueprintAssessment.status === "current"
      && blueprintAssessment.receipt.structuralStatus === "passed"
      && blueprintAssessment.receipt.manuscript.version === manuscript.currentVersion
      && blueprintAssessment.receipt.manuscript.contentSha256 === manuscript.version.contentSha256
      && blueprintAssessment.receipt.blueprint.id === blueprintValidation.blueprint?.id
      && blueprintAssessment.receipt.blueprint.version === blueprintValidation.blueprint?.currentVersion
      && blueprintAssessment.receipt.blueprint.contentSha256 === blueprintValidation.blueprint?.version.contentSha256
      && blueprintAssessment.receipt.journalProfile.id === profile.id
      && blueprintAssessment.receipt.journalProfile.version === profile.currentVersion
      && blueprintAssessment.receipt.journalProfile.contentSha256 === profile.version.contentSha256);
    const scholarlyAssessment = this.store.getManuscriptScholarlyAssessmentForManuscript(manuscript.projectId, manuscript.id);
    const scholarlyAssessmentReady = Boolean(scholarlyAssessment && scholarlyAssessment.status === "current"
      && scholarlyAssessment.receipt.scholarlyStatus === "passed"
      && scholarlyAssessment.receipt.manuscript.version === manuscript.currentVersion
      && scholarlyAssessment.receipt.manuscript.contentSha256 === manuscript.version.contentSha256
      && scholarlyAssessment.receipt.blueprint.id === blueprintValidation.blueprint?.id
      && scholarlyAssessment.receipt.blueprint.version === blueprintValidation.blueprint?.currentVersion
      && scholarlyAssessment.receipt.blueprint.contentSha256 === blueprintValidation.blueprint?.version.contentSha256
      && scholarlyAssessment.receipt.journalProfile.id === profile.id
      && scholarlyAssessment.receipt.journalProfile.version === profile.currentVersion
      && scholarlyAssessment.receipt.journalProfile.contentSha256 === profile.version.contentSha256
      && scholarlyAssessment.receipt.blueprintAssessment.id === blueprintAssessment?.receipt.id
      && scholarlyAssessment.receipt.blueprintAssessment.reportSha256 === blueprintAssessment?.receipt.reportSha256
      && scholarlyAssessment.receipt.blueprintAssessment.policyContentSha256 === blueprintAssessment?.receipt.policy.contentSha256
      && scholarlyAssessment.receipt.blueprintAssessment.contentSha256 === blueprintAssessment?.receipt.contentSha256);
    const coherenceAssessment = this.store.getManuscriptCoherenceAssessmentForManuscript(manuscript.projectId, manuscript.id);
    const coherenceAssessmentReady = currentPassedCoherenceAssessment(coherenceAssessment, manuscript, claimLedger);
    const renderProfile = deriveScienceJournalRenderProfile(profile);
    let validationRender: ManuscriptRenderResult | null = null;
    try {
      validationRender = new ScienceManuscriptRenderService(this.store).renderSync(manuscript, {
        outputs: ["html"], journalRenderProfile: renderProfile, draftBoundary: null,
      });
    } catch {
      // Rendering remains an independent readiness check; the rule report below records the
      // unavailable shared document count instead of silently reverting to raw Markdown.
    }
    const findings: ScienceJournalValidationFinding[] = profile.version.rules.map((rule) => {
      const result = evaluateRule(rule, manuscript, metadata, attestedCodes, this.store, validationRender);
      const source = profile.version.sources.find((item) => item.inspectionId === rule.inspectionId)!;
      return { ruleId: rule.id, severity: rule.severity, status: result.status, requirement: rule.requirement, observed: result.observed, sourceUrl: source.sourceUrl, evidenceQuote: rule.evidenceQuote };
    });
    findings.unshift(
      ...blueprintValidation.findings,
      { ruleId: "agentlas.submission.manuscript-blueprint-assessment", severity: "error", status: blueprintAssessmentReady ? "pass" : "fail",
        requirement: "The exact current manuscript, Blueprint, journal profile, and assessment policy must have an immutable passing structural assessment receipt.",
        observed: !blueprintAssessment ? "assessment receipt missing" : `assessment ${blueprintAssessment.receipt.id} status=${blueprintAssessment.status} structural=${blueprintAssessment.receipt.structuralStatus}`,
        sourceUrl: "agentlas://submission/manuscript-blueprint-assessment",
        evidenceQuote: "Submission readiness must close the immutable structural assessment, not recompute an unversioned heuristic." },
      { ruleId: "agentlas.submission.manuscript-scholarly-assessment", severity: "error", status: scholarlyAssessmentReady ? "pass" : "fail",
        requirement: "The exact current manuscript must have an immutable passing Research Director assessment of rhetorical moves, evidence roles, section flow, and required visuals.",
        observed: !scholarlyAssessment ? "scholarly assessment receipt missing" : `assessment ${scholarlyAssessment.receipt.id} status=${scholarlyAssessment.status} scholarly=${scholarlyAssessment.receipt.scholarlyStatus}`,
        sourceUrl: "agentlas://submission/manuscript-scholarly-assessment",
        evidenceQuote: "Submission readiness must close exact-node scholarly judgments in addition to deterministic structural depth." },
      { ruleId: "agentlas.submission.manuscript-coherence-assessment", severity: "error", status: coherenceAssessmentReady ? "pass" : "fail",
        requirement: "The exact current manuscript and claim ledger must have an immutable passing cross-section, numeric, and visual coherence assessment receipt.",
        observed: !coherenceAssessment
          ? "coherence assessment receipt missing"
          : `assessment ${coherenceAssessment.receipt.id} status=${coherenceAssessment.status} coherence=${coherenceAssessment.receipt.status}${coherenceAssessment.staleReasons.length ? ` stale=${coherenceAssessment.staleReasons.join(",")}` : ""}`,
        sourceUrl: "agentlas://submission/manuscript-coherence-assessment",
        evidenceQuote: "Submission readiness requires summaries, body claims, numeric assertions, and visual bindings to close against one exact immutable evidence state." },
      { ruleId: "agentlas.submission.claim-ledger", severity: "error", status: claimLedger?.gate.ready ? "pass" : "fail",
        requirement: "Every current factual, inference, method, and result claim must be resolved by the exact immutable claim ledger and publication policy.",
        observed: claimLedger ? `${claimLedger.gate.issues.length} blocking claim issues at ledger revision ${claimLedger.manifest.revision}` : "claim ledger missing",
        sourceUrl: "agentlas://submission/claim-ledger", evidenceQuote: "A ready submission requires an exact current claim ledger and a ready claim gate report." },
      { ruleId: "agentlas.submission.authors", severity: "error", status: metadata.authors.length ? "pass" : "fail", requirement: "Submission metadata must identify at least one accountable human author.", observed: `${metadata.authors.length} authors`, sourceUrl: "agentlas://submission/core", evidenceQuote: "Accountable human authors are required before export." },
      { ruleId: "agentlas.submission.corresponding-author", severity: "error", status: metadata.authors.some((author) => author.corresponding && author.email) ? "pass" : "fail", requirement: "At least one corresponding author must have an email address.", observed: `${metadata.authors.filter((author) => author.corresponding && author.email).length} corresponding authors with email`, sourceUrl: "agentlas://submission/core", evidenceQuote: "A corresponding author with contact information is required before export." },
    );
    for (const binding of manuscript.version.bindings.filter((item) => item.role === "figure" || item.role === "table")) {
      const available = binding.target.kind === "artifact"
        ? (() => {
          const preview = this.store.artifactVisualCaptureForBinding(
            manuscript.projectId,
            binding.target.artifactId,
            binding.target.artifactVersion,
            binding.target.captureId,
            binding.target.validationReceiptId,
          );
          const context = this.store.getArtifactContextForProject(manuscript.projectId, binding.target.artifactId, binding.target.artifactVersion);
          if (context?.selectedVersion.payload.schema === SCIENCE_STATISTICS_FIGURE_VECTOR_ARTIFACT_SCHEMA) {
            return Boolean(preview && this.store.statisticsFigureSvgAssetForBinding(
              manuscript.projectId,
              binding.target.artifactId,
              binding.target.artifactVersion,
            ));
          }
          return Boolean(preview);
        })()
        : binding.target.kind === "source-figure" ? Boolean(this.store.sourceFigureBytesForProject(manuscript.projectId, binding.target.sourceFigureId)) : true;
      findings.push({ ruleId: `agentlas.submission.asset.${binding.ordinal}`, severity: "error", status: available ? "pass" : "fail", requirement: `Bound ${binding.role} asset must remain hash-verifiable at export.`, observed: available ? "verified asset available" : "bound asset missing", sourceUrl: "agentlas://submission/core", evidenceQuote: "Every exported visual must resolve to the exact bound version and content hash." });
      if (binding.role === "table") {
        let editable = false;
        let observed = "exact editable table available";
        try {
          editableTableForBinding(this.store, manuscript, binding);
          editable = true;
        } catch (error) {
          observed = `editable table unavailable: ${error instanceof Error ? error.message : "science-submission-editable-table-invalid"}`;
        }
        findings.push({
          ruleId: `agentlas.submission.table-editable.${binding.ordinal}`,
          severity: "error",
          status: editable ? "pass" : "fail",
          requirement: "Bound table must resolve to an exact editable table export with immutable artifact, dataset, run, and selected-cell lineage.",
          observed,
          sourceUrl: "agentlas://submission/editable-table",
          evidenceQuote: "Every exported table must remain both visually reviewable and editable without losing exact scientific lineage.",
        });
      }
    }
    const fail = findings.filter((item) => item.status === "fail").length;
    const manual = findings.filter((item) => item.status === "manual").length;
    const warning = findings.filter((item) => item.status === "fail" && item.severity === "warning").length;
    const errorFail = findings.some((item) => item.status === "fail" && item.severity === "error");
    const status: ScienceJournalValidationReport["status"] = errorFail ? "blocked" : manual ? "manual-review" : "ready";
    const generatedAt = [manuscript.version.createdAt, profile.version.createdAt].sort().at(-1)!;
    const blueprintBinding = manuscript.version.blueprintBinding ?? null;
    const core = {
      schema: "agentlas.science-journal-validation/v1" as const, projectId: manuscript.projectId, manuscriptId: manuscript.id, manuscriptVersion: manuscript.currentVersion,
      manuscriptContentSha256: manuscript.version.contentSha256, journalProfileId: profile.id, journalProfileVersion: profile.currentVersion,
      journalProfileContentSha256: profile.version.contentSha256,
      manuscriptBlueprintId: blueprintBinding?.blueprintId ?? null,
      manuscriptBlueprintVersion: blueprintBinding?.blueprintVersion ?? null,
      manuscriptBlueprintContentSha256: blueprintBinding?.blueprintContentSha256 ?? null,
      manuscriptBlueprintAssessmentId: blueprintAssessmentReady ? blueprintAssessment!.receipt.id : null,
      manuscriptBlueprintAssessmentReportSha256: blueprintAssessmentReady ? blueprintAssessment!.receipt.reportSha256 : null,
      manuscriptBlueprintAssessmentPolicyContentSha256: blueprintAssessmentReady ? blueprintAssessment!.receipt.policy.contentSha256 : null,
      manuscriptScholarlyAssessmentId: scholarlyAssessmentReady ? scholarlyAssessment!.receipt.id : null,
      manuscriptScholarlyAssessmentReportSha256: scholarlyAssessmentReady ? scholarlyAssessment!.receipt.reportSha256 : null,
      manuscriptScholarlyAssessmentPolicyContentSha256: scholarlyAssessmentReady ? scholarlyAssessment!.receipt.policy.contentSha256 : null,
      manuscriptCoherenceAssessmentId: coherenceAssessmentReady ? coherenceAssessment.receipt.id : null,
      manuscriptCoherenceAssessmentReportSha256: coherenceAssessmentReady ? coherenceAssessment.receipt.reportSha256 : null,
      manuscriptCoherenceAssessmentContentSha256: coherenceAssessmentReady ? coherenceAssessment.receipt.contentSha256 : null,
      claimLedgerId: claimLedger?.manifest.ledgerId ?? null,
      claimLedgerRevision: claimLedger?.manifest.revision ?? null,
      claimLedgerManifestSha256: claimLedger?.manifest.manifestSha256 ?? null,
      claimGateReportSha256: claimLedger?.gate.reportSha256 ?? null,
      claimPolicyContentSha256: claimLedger?.gate.policyContentSha256 ?? null,
      status, counts: { pass: findings.filter((item) => item.status === "pass").length, fail, manual, warning }, findings, generatedAt,
    };
    return { ...core, reportSha256: sha256(canonicalJson(core)) };
  }

  async createSubmissionExport(input: CreateScienceSubmissionExportInput): Promise<CreateScienceSubmissionExportResult> {
    const manuscript = this.store.getManuscriptForProject(input.projectId, input.manuscriptId);
    const profile = this.store.getJournalProfileForProject(input.projectId, input.journalProfileId);
    if (!manuscript || manuscript.currentVersion !== input.expectedManuscriptVersion || manuscript.version.contentSha256 !== input.expectedManuscriptContentSha256) throw new Error("science-manuscript-version-conflict");
    if (!profile || profile.currentVersion !== input.expectedJournalProfileVersion || profile.version.contentSha256 !== input.expectedJournalProfileContentSha256) throw new Error("science-journal-profile-version-conflict");
    const metadata = metadataInput(input.metadata);
    const replayed = this.store.replaySubmissionExport({
      requestId: input.requestId, projectId: input.projectId, manuscriptId: manuscript.id, manuscriptVersion: manuscript.currentVersion, manuscriptContentSha256: manuscript.version.contentSha256,
      journalProfileId: profile.id, journalProfileVersion: profile.currentVersion, journalProfileContentSha256: profile.version.contentSha256,
      metadataSha256: sha256(canonicalJson(metadata)), humanAttestationReceiptIds: input.humanAttestationReceiptIds,
    });
    if (replayed) {
      const validation = this.validate(manuscript, profile, metadata, input.humanAttestationReceiptIds, replayed.submissionExport.id);
      if (replayed.validationReceipt.report.reportSha256 !== validation.reportSha256 || validation.status !== "ready") {
        throw new Error("science-submission-current-readiness-changed");
      }
      return { submissionExport: replayed.submissionExport, validation: replayed.validationReceipt.report, validationReceipt: replayed.validationReceipt, replayed: true };
    }
    const validation = this.validate(manuscript, profile, metadata, input.humanAttestationReceiptIds);
    const validationReceipt = this.store.recordJournalValidationReceipt({
      requestId: derivedRequestId(input.requestId, "journal-validation"), projectId: input.projectId, manuscriptId: manuscript.id, manuscriptVersion: manuscript.currentVersion, manuscriptContentSha256: manuscript.version.contentSha256,
      journalProfileId: profile.id, journalProfileVersion: profile.currentVersion, journalProfileContentSha256: profile.version.contentSha256,
      humanAttestationReceiptIds: input.humanAttestationReceiptIds, report: validation,
    });
    const manuscriptBlueprintAssessment = this.store.getManuscriptBlueprintAssessmentForManuscript(input.projectId, manuscript.id);
    const manuscriptScholarlyAssessment = this.store.getManuscriptScholarlyAssessmentForManuscript(input.projectId, manuscript.id);
    const manuscriptCoherenceAssessment = this.store.getManuscriptCoherenceAssessmentForManuscript(input.projectId, manuscript.id);
    const manifestBase = {
      schema: "agentlas.science-submission-manifest/v6", projectId: input.projectId, manuscript: {
        id: manuscript.id,
        versionId: manuscript.version.id,
        version: manuscript.currentVersion,
        contentSha256: manuscript.version.contentSha256,
        documentSha256: manuscript.version.documentSha256 ?? null,
        bindingManifestSha256: manuscript.version.bindingManifestSha256,
      },
      journalProfile: { id: profile.id, version: profile.currentVersion, contentSha256: profile.version.contentSha256, sourceManifestSha256: profile.version.sourceManifestSha256, ruleManifestSha256: profile.version.ruleManifestSha256, identityReceiptId: profile.version.identityReceiptId, identityReceiptSha256: profile.version.identityReceiptSha256, coverageManifestSha256: profile.version.coverageManifestSha256 },
      metadataSha256: sha256(canonicalJson(metadata)), validationReceiptId: validationReceipt.id, validationReceiptSha256: validationReceipt.contentSha256, validationReportSha256: validation.reportSha256,
      claimLedger: validation.claimLedgerId === null ? null : { id: validation.claimLedgerId, revision: validation.claimLedgerRevision, manifestSha256: validation.claimLedgerManifestSha256 },
      claimGateReportSha256: validation.claimGateReportSha256,
      claimPolicyContentSha256: validation.claimPolicyContentSha256,
      manuscriptBlueprint: validation.manuscriptBlueprintId === null ? null : {
        id: validation.manuscriptBlueprintId, version: validation.manuscriptBlueprintVersion,
        contentSha256: validation.manuscriptBlueprintContentSha256,
      },
      manuscriptBlueprintAssessment: validation.manuscriptBlueprintAssessmentId === null ? null : {
        id: validation.manuscriptBlueprintAssessmentId,
        reportSha256: validation.manuscriptBlueprintAssessmentReportSha256,
        policyContentSha256: validation.manuscriptBlueprintAssessmentPolicyContentSha256,
        contentSha256: manuscriptBlueprintAssessment?.receipt.contentSha256 ?? null,
      },
      manuscriptScholarlyAssessment: validation.manuscriptScholarlyAssessmentId === null ? null : {
        id: validation.manuscriptScholarlyAssessmentId,
        reportSha256: validation.manuscriptScholarlyAssessmentReportSha256,
        policyContentSha256: validation.manuscriptScholarlyAssessmentPolicyContentSha256,
        contentSha256: manuscriptScholarlyAssessment?.receipt.contentSha256 ?? null,
      },
      manuscriptCoherenceAssessment: validation.manuscriptCoherenceAssessmentId === null ? null : {
        id: validation.manuscriptCoherenceAssessmentId,
        reportSha256: validation.manuscriptCoherenceAssessmentReportSha256,
        contentSha256: validation.manuscriptCoherenceAssessmentContentSha256,
        numericSourceCount: manuscriptCoherenceAssessment?.receipt.numericProvenance.sourceCount ?? null,
        numericSourceManifestSha256: manuscriptCoherenceAssessment?.receipt.numericProvenance.sourceManifestSha256 ?? null,
      },
    };
    let packageBytes: Buffer | null = null;
    let fileName: string | null = null;
    let manifestSha256 = sha256(canonicalJson(manifestBase));
    if (validation.status === "ready") {
      const claimLedger = this.store.evaluateClaimLedgerForManuscript(input.projectId, manuscript.id);
      if (!claimLedger.gate.ready || claimLedger.manifest.ledgerId !== validation.claimLedgerId || claimLedger.manifest.revision !== validation.claimLedgerRevision
        || claimLedger.manifest.manifestSha256 !== validation.claimLedgerManifestSha256 || claimLedger.gate.reportSha256 !== validation.claimGateReportSha256
        || claimLedger.gate.policyContentSha256 !== validation.claimPolicyContentSha256) throw new Error("science-submission-claim-gate-stale");
      const manuscriptBlueprintValidation = this.store.evaluateManuscriptBlueprintForJournal(input.projectId, manuscript.id, profile.id);
      const manuscriptBlueprint = manuscriptBlueprintValidation.blueprint;
      if (!manuscriptBlueprint || manuscriptBlueprintValidation.findings.some((finding) => finding.status !== "pass")
        || manuscriptBlueprint.id !== validation.manuscriptBlueprintId || manuscriptBlueprint.currentVersion !== validation.manuscriptBlueprintVersion
        || manuscriptBlueprint.version.contentSha256 !== validation.manuscriptBlueprintContentSha256) {
        throw new Error("science-submission-manuscript-blueprint-stale");
      }
      if (!manuscriptBlueprintAssessment || manuscriptBlueprintAssessment.status !== "current"
        || manuscriptBlueprintAssessment.receipt.structuralStatus !== "passed"
        || manuscriptBlueprintAssessment.receipt.id !== validation.manuscriptBlueprintAssessmentId
        || manuscriptBlueprintAssessment.receipt.reportSha256 !== validation.manuscriptBlueprintAssessmentReportSha256
        || manuscriptBlueprintAssessment.receipt.policy.contentSha256 !== validation.manuscriptBlueprintAssessmentPolicyContentSha256) {
        throw new Error("science-submission-manuscript-blueprint-assessment-stale");
      }
      if (!manuscriptScholarlyAssessment || manuscriptScholarlyAssessment.status !== "current"
        || manuscriptScholarlyAssessment.receipt.scholarlyStatus !== "passed"
        || manuscriptScholarlyAssessment.receipt.id !== validation.manuscriptScholarlyAssessmentId
        || manuscriptScholarlyAssessment.receipt.reportSha256 !== validation.manuscriptScholarlyAssessmentReportSha256
        || manuscriptScholarlyAssessment.receipt.policy.contentSha256 !== validation.manuscriptScholarlyAssessmentPolicyContentSha256
        || manuscriptScholarlyAssessment.receipt.blueprintAssessment.id !== manuscriptBlueprintAssessment.receipt.id
        || manuscriptScholarlyAssessment.receipt.blueprintAssessment.contentSha256 !== manuscriptBlueprintAssessment.receipt.contentSha256) {
        throw new Error("science-submission-manuscript-scholarly-assessment-stale");
      }
      if (!currentPassedCoherenceAssessment(manuscriptCoherenceAssessment, manuscript, claimLedger)
        || manuscriptCoherenceAssessment.receipt.id !== validation.manuscriptCoherenceAssessmentId
        || manuscriptCoherenceAssessment.receipt.reportSha256 !== validation.manuscriptCoherenceAssessmentReportSha256
        || manuscriptCoherenceAssessment.receipt.contentSha256 !== validation.manuscriptCoherenceAssessmentContentSha256) {
        throw new Error("science-submission-manuscript-coherence-assessment-stale");
      }
      // Full manuscript rendering (numbered figures/tables/equations, embedded assets,
      // references) from the shared document model. Figure paths point at the exact
      // bound assets mirrored under manuscript/figures/ so the .tex compiles in place.
      const mirroredFigures: Record<string, Uint8Array> = {};
      for (const binding of manuscript.version.bindings) {
        if (binding.role !== "figure" && binding.role !== "table") continue;
        const ordinal = String(binding.ordinal).padStart(3, "0");
        if (binding.target.kind === "artifact") {
          const preview = this.store.artifactVisualCaptureForBinding(input.projectId, binding.target.artifactId, binding.target.artifactVersion, binding.target.captureId, binding.target.validationReceiptId);
          if (preview) mirroredFigures[`manuscript/figures/${ordinal}-${binding.role}.png`] = preview.bytes;
        } else if (binding.target.kind === "source-figure") {
          const source = this.store.sourceFigureBytesForProject(input.projectId, binding.target.sourceFigureId);
          if (source) {
            const extension = source.figure.mimeType === "image/jpeg" ? "jpg" : source.figure.mimeType === "image/webp" ? "webp" : "png";
            mirroredFigures[`manuscript/figures/${ordinal}-source.${extension}`] = source.bytes;
          }
        }
      }
      const renderProfile = deriveScienceJournalRenderProfile(profile);
      const rendered = await new ScienceManuscriptRenderService(this.store).render(manuscript, {
        outputs: ["html", "latex", "docx", "pdf"], metadata, style: renderProfile.bibliographyStyle, layout: renderProfile.layout,
        journalRenderProfile: renderProfile, draftBoundary: null,
      });
      const pdfRequired = profile.version.rules.some((rule) => rule.check.kind === "output-format" && rule.check.allowed.includes("pdf"));
      if (pdfRequired && !rendered.pdf) throw new Error(`science-submission-pdf-required:${rendered.pdfFailure ?? "pdf-render-failed"}`);
      const renderRealization = verifyScienceJournalRenderRealization(renderProfile, rendered);
      const renderReport = {
        schema: rendered.schema, manuscriptContentSha256: rendered.manuscriptContentSha256, style: rendered.style, layout: rendered.layout, renderProfile, document: rendered.document,
        references: rendered.references.map((reference) => ({ locator: reference.locator, ordinal: reference.ordinal, text: reference.text })),
        warnings: rendered.warnings, equationFallbacks: rendered.equationFallbacks,
        pdf: rendered.pdf ? {
          engine: rendered.pdf.engine,
          degraded: rendered.pdf.degraded,
          degradedReason: rendered.pdf.degradedReason,
          byteSize: rendered.pdf.bytes.byteLength,
          sha256: sha256(rendered.pdf.bytes),
          typesetDiagnostics: rendered.pdf.typesetDiagnostics,
          toolchain: rendered.pdf.toolchain,
        } : null,
        pdfFailure: rendered.pdfFailure,
        renderRealization,
      };
      const files: Record<string, Uint8Array> = {
        "manuscript/manuscript.md": strToU8(manuscript.version.markdown),
        "manuscript/manuscript.tex": strToU8(rendered.latex ?? ""),
        "manuscript/manuscript.docx": rendered.docx ?? new Uint8Array(),
        "manuscript/manuscript.html": strToU8(rendered.html ?? ""),
        ...(rendered.pdf ? { "manuscript/manuscript.pdf": rendered.pdf.bytes } : {}),
        "manuscript/references.bib": strToU8(rendered.bibtex ?? ""),
        "manuscript/render-report.json": strToU8(`${JSON.stringify(renderReport, null, 2)}\n`),
        ...mirroredFigures,
        "submission/metadata.json": strToU8(JSON.stringify(metadata, null, 2)),
        "submission/journal-profile.json": strToU8(JSON.stringify(profile, null, 2)),
        "submission/journal-render-profile.json": strToU8(`${JSON.stringify(renderProfile, null, 2)}\n`),
        "submission/journal-render-realization.json": strToU8(`${JSON.stringify(renderRealization, null, 2)}\n`),
        "submission/manuscript-blueprint.json": strToU8(`${JSON.stringify(manuscriptBlueprint, null, 2)}\n`),
        "submission/manuscript-blueprint-assessment.json": strToU8(`${JSON.stringify(manuscriptBlueprintAssessment.receipt, null, 2)}\n`),
        "submission/manuscript-scholarly-assessment.json": strToU8(`${JSON.stringify(manuscriptScholarlyAssessment.receipt, null, 2)}\n`),
        "submission/manuscript-coherence-assessment.json": strToU8(`${JSON.stringify(manuscriptCoherenceAssessment.receipt, null, 2)}\n`),
        "submission/numeric-provenance.json": strToU8(`${JSON.stringify(manuscriptCoherenceAssessment.receipt.numericProvenance, null, 2)}\n`),
        "submission/validation-report.json": strToU8(JSON.stringify(validation, null, 2)),
        "submission/validation-receipt.json": strToU8(JSON.stringify(validationReceipt, null, 2)),
        "submission/evidence-bindings.json": strToU8(JSON.stringify(manuscript.version.bindings, null, 2)),
        "submission/claim-ledger.json": strToU8(JSON.stringify(claimLedger.manifest, null, 2)),
        "submission/claim-gate-report.json": strToU8(JSON.stringify(claimLedger.gate, null, 2)),
        "submission/cover-letter.md": strToU8(metadata.coverLetter ?? `# Cover letter\n\nTarget journal: ${profile.journalName}\nArticle type: ${profile.articleType}\n`),
        "README.txt": strToU8(`Agentlas Science submission bundle\nJournal: ${profile.journalName}\nArticle type: ${profile.articleType}\nManuscript immutable v${manuscript.currentVersion}\nVerify MANIFEST.json before upload.\n`),
      };
      for (const file of rendered.files) files[`manuscript/${file.name}`] = file.bytes;
      const supplementIndexEntries: Array<{
        ordinal: number;
        locator: string;
        targetKind: "artifact" | "source-figure";
        files: Array<{ name: string; byteSize: number; sha256: string; mimeType: string }>;
        provenance: Record<string, unknown>;
      }> = [];
      for (const binding of manuscript.version.bindings) {
        if (binding.role === "supplement") {
          const packageBase = `supplementary/${String(binding.ordinal).padStart(3, "0")}-${slug(binding.locator)}`;
          const packaged: Array<{ name: string; byteSize: number; sha256: string; mimeType: string }> = [];
          const addSupplementFile = (name: string, bytes: Uint8Array, mimeType: string) => {
            files[name] = bytes;
            packaged.push({ name, byteSize: bytes.byteLength, sha256: sha256(bytes), mimeType });
          };
          if (binding.target.kind === "artifact") {
            const context = this.store.getArtifactContextForProject(input.projectId, binding.target.artifactId, binding.target.artifactVersion);
            const preview = this.store.artifactVisualCaptureForBinding(
              input.projectId,
              binding.target.artifactId,
              binding.target.artifactVersion,
              binding.target.captureId,
              binding.target.validationReceiptId,
            );
            if (!context || !preview) throw new Error("science-submission-supplement-artifact-unresolved");
            const payloadBytes = strToU8(`${canonicalJson(context.selectedVersion.payload)}\n`);
            const previewName = `${packageBase}.${imageExtension(preview.mimeType)}`;
            addSupplementFile(`${packageBase}.json`, payloadBytes, "application/json");
            addSupplementFile(previewName, preview.bytes, preview.mimeType);
            const bindingBytes = strToU8(`${JSON.stringify({ binding, artifact: { id: context.artifact.id, version: binding.target.artifactVersion, contentSha256: context.selectedVersion.contentSha256, rendererId: context.selectedVersion.rendererId, rendererVersion: context.selectedVersion.rendererVersion }, capture: { id: binding.target.captureId, validationReceiptId: binding.target.validationReceiptId, sha256: preview.sha256, byteSize: preview.byteSize, mimeType: preview.mimeType } }, null, 2)}\n`);
            addSupplementFile(`${packageBase}.binding.json`, bindingBytes, "application/json");
            supplementIndexEntries.push({
              ordinal: binding.ordinal,
              locator: binding.locator,
              targetKind: "artifact",
              files: packaged,
              provenance: { artifactId: context.artifact.id, artifactVersion: binding.target.artifactVersion, contentSha256: context.selectedVersion.contentSha256, captureId: binding.target.captureId, validationReceiptId: binding.target.validationReceiptId },
            });
          } else if (binding.target.kind === "source-figure") {
            const source = this.store.sourceFigureBytesForProject(input.projectId, binding.target.sourceFigureId);
            if (!source) throw new Error("science-submission-supplement-source-unresolved");
            const assetName = `${packageBase}.${imageExtension(source.figure.mimeType)}`;
            addSupplementFile(assetName, source.bytes, source.figure.mimeType);
            const bindingBytes = strToU8(`${JSON.stringify({ binding, sourceFigure: source.figure }, null, 2)}\n`);
            addSupplementFile(`${packageBase}.binding.json`, bindingBytes, "application/json");
            supplementIndexEntries.push({
              ordinal: binding.ordinal,
              locator: binding.locator,
              targetKind: "source-figure",
              files: packaged,
              provenance: { sourceFigureId: binding.target.sourceFigureId, assetSha256: source.figure.assetSha256, sourceId: source.figure.sourceId },
            });
          } else {
            throw new Error("science-submission-supplement-target-invalid");
          }
          continue;
        }
        if (binding.target.kind === "artifact" && (binding.role === "figure" || binding.role === "table")) {
          const context = this.store.getArtifactContextForProject(input.projectId, binding.target.artifactId, binding.target.artifactVersion);
          if (binding.role === "table") {
            const editable = editableTableForBinding(this.store, manuscript, binding);
            const packageBase = `tables/${String(binding.ordinal).padStart(3, "0")}-table`;
            files[`${packageBase}.docx`] = editable.assets.docx.bytes;
            files[`${packageBase}.tex`] = strToU8(editable.assets.tex.text);
            files[`${packageBase}.json`] = strToU8(editable.assets.json.text);
            files[`${packageBase}.binding.json`] = strToU8(`${JSON.stringify(editable.binding, null, 2)}\n`);
            files[`${packageBase}.manifest.json`] = strToU8(`${JSON.stringify(editableTableManifestEvidence(editable, packageBase), null, 2)}\n`);
          }
          if (binding.role === "figure" && context?.selectedVersion.payload.schema === SCIENCE_STATISTICS_FIGURE_VECTOR_ARTIFACT_SCHEMA) {
            const vector = this.store.statisticsFigureSvgAssetForBinding(input.projectId, binding.target.artifactId, binding.target.artifactVersion);
            if (vector) files[`figures/${String(binding.ordinal).padStart(3, "0")}-${binding.role}.svg`] = vector.bytes;
          } else {
            const preview = this.store.artifactVisualCaptureForBinding(
              input.projectId,
              binding.target.artifactId,
              binding.target.artifactVersion,
              binding.target.captureId,
              binding.target.validationReceiptId,
            );
            if (preview) files[`figures/${String(binding.ordinal).padStart(3, "0")}-${binding.role}.png`] = preview.bytes;
          }
        } else if (binding.target.kind === "source-figure") {
          const source = this.store.sourceFigureBytesForProject(input.projectId, binding.target.sourceFigureId);
          if (source) {
            const extension = source.figure.mimeType === "image/jpeg" ? "jpg" : source.figure.mimeType === "image/webp" ? "webp" : "png";
            files[`figures/${String(binding.ordinal).padStart(3, "0")}-source.${extension}`] = source.bytes;
          }
        }
      }
      const supplementIndexCore = {
        schema: "agentlas.science-submission-supplement-index/v1" as const,
        manuscriptId: manuscript.id,
        manuscriptVersion: manuscript.currentVersion,
        manuscriptContentSha256: manuscript.version.contentSha256,
        entries: supplementIndexEntries.sort((left, right) => left.ordinal - right.ordinal),
      };
      files["submission/supplement-index.json"] = strToU8(`${JSON.stringify({ ...supplementIndexCore, contentSha256: sha256(canonicalJson(supplementIndexCore)) }, null, 2)}\n`);
      const fileManifest = Object.keys(files).sort().map((name) => ({ name, byteSize: files[name].byteLength, sha256: sha256(files[name]) }));
      const preZipClaimLedger = this.store.evaluateClaimLedgerForManuscript(input.projectId, manuscript.id);
      if (!preZipClaimLedger.gate.ready || preZipClaimLedger.manifest.manifestSha256 !== claimLedger.manifest.manifestSha256
        || preZipClaimLedger.gate.reportSha256 !== claimLedger.gate.reportSha256 || preZipClaimLedger.gate.policyContentSha256 !== claimLedger.gate.policyContentSha256) {
        throw new Error("science-submission-claim-gate-stale");
      }
      const preZipBlueprintValidation = this.store.evaluateManuscriptBlueprintForJournal(input.projectId, manuscript.id, profile.id);
      if (!preZipBlueprintValidation.blueprint || preZipBlueprintValidation.findings.some((finding) => finding.status !== "pass")
        || preZipBlueprintValidation.blueprint.id !== manuscriptBlueprint.id
        || preZipBlueprintValidation.blueprint.currentVersion !== manuscriptBlueprint.currentVersion
        || preZipBlueprintValidation.blueprint.version.contentSha256 !== manuscriptBlueprint.version.contentSha256) {
        throw new Error("science-submission-manuscript-blueprint-stale");
      }
      const preZipBlueprintAssessment = this.store.getManuscriptBlueprintAssessmentForManuscript(input.projectId, manuscript.id);
      if (!preZipBlueprintAssessment || preZipBlueprintAssessment.status !== "current"
        || preZipBlueprintAssessment.receipt.id !== manuscriptBlueprintAssessment.receipt.id
        || preZipBlueprintAssessment.receipt.contentSha256 !== manuscriptBlueprintAssessment.receipt.contentSha256) {
        throw new Error("science-submission-manuscript-blueprint-assessment-stale");
      }
      const preZipScholarlyAssessment = this.store.getManuscriptScholarlyAssessmentForManuscript(input.projectId, manuscript.id);
      if (!preZipScholarlyAssessment || preZipScholarlyAssessment.status !== "current"
        || preZipScholarlyAssessment.receipt.scholarlyStatus !== "passed"
        || preZipScholarlyAssessment.receipt.id !== manuscriptScholarlyAssessment.receipt.id
        || preZipScholarlyAssessment.receipt.contentSha256 !== manuscriptScholarlyAssessment.receipt.contentSha256) {
        throw new Error("science-submission-manuscript-scholarly-assessment-stale");
      }
      const preZipCoherenceAssessment = this.store.getManuscriptCoherenceAssessmentForManuscript(input.projectId, manuscript.id);
      if (!currentPassedCoherenceAssessment(preZipCoherenceAssessment, manuscript, preZipClaimLedger)
        || preZipCoherenceAssessment.receipt.id !== manuscriptCoherenceAssessment.receipt.id
        || preZipCoherenceAssessment.receipt.reportSha256 !== manuscriptCoherenceAssessment.receipt.reportSha256
        || preZipCoherenceAssessment.receipt.contentSha256 !== manuscriptCoherenceAssessment.receipt.contentSha256) {
        throw new Error("science-submission-manuscript-coherence-assessment-stale");
      }
      const manifest = { ...manifestBase, files: fileManifest };
      manifestSha256 = sha256(canonicalJson(manifest));
      files["MANIFEST.json"] = strToU8(JSON.stringify({ ...manifest, manifestSha256 }, null, 2));
      packageBytes = Buffer.from(zipSync(files, { level: 6 }));
      fileName = `${slug(profile.journalName)}-${slug(manuscript.title)}-v${manuscript.currentVersion}.zip`;
    }
    const recorded = this.store.recordSubmissionExport({
      requestId: input.requestId, projectId: input.projectId, manuscriptId: manuscript.id, manuscriptVersion: manuscript.currentVersion, manuscriptContentSha256: manuscript.version.contentSha256,
      journalProfileId: profile.id, journalProfileVersion: profile.currentVersion, journalProfileContentSha256: profile.version.contentSha256,
      validationReceipt, packageBytes, fileName, manifestSha256,
    });
    return { submissionExport: recorded.submissionExport, validation, validationReceipt, replayed: recorded.replayed };
  }
}
