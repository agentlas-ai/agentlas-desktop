import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { strToU8, zipSync } from "fflate";
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
  ScienceSubmissionMetadata,
} from "../../shared/science-contract";
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
      headers: { accept: "text/html, text/plain;q=0.9", "user-agent": "Agentlas-Science/1.0 (official journal guideline inspection; https://agentlas.ai)" },
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

function words(value: string): number { return (value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length; }
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

function evaluateRule(rule: ScienceJournalRule, manuscript: ScienceManuscript, metadata: ScienceSubmissionMetadata, attestedCodes: Set<string>, store: ScienceStore): { status: "pass" | "fail" | "manual"; observed: string } {
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
    const section = [...sections.entries()].find(([name]) => normalizedNeedle(name) === target)?.[1] ?? "";
    const count = words(section);
    return { status: section && count <= check.maximum ? "pass" : "fail", observed: `${count}/${check.maximum} words in ${check.heading}` };
  }
  if (check.kind === "max-manuscript-words") {
    const count = words(markdown.replace(/^#{1,6}\s+.*$/gm, ""));
    return { status: count <= check.maximum ? "pass" : "fail", observed: `${count}/${check.maximum} manuscript words` };
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
    const produced = ["docx", "tex", "zip"];
    const matches = check.allowed.filter((item) => produced.includes(item));
    return { status: matches.length ? "pass" : "fail", observed: `bundle produces ${produced.join(", ")}; allowed ${check.allowed.join(", ")}` };
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

function docxBytes(manuscript: ScienceManuscript, metadata: ScienceSubmissionMetadata): Uint8Array {
  const paragraphs: string[] = [];
  const add = (text: string, style?: string) => paragraphs.push(`<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`);
  add(manuscript.title, "Title");
  if (metadata.authors.length) add(metadata.authors.map((author) => `${author.name}${author.corresponding ? "*" : ""}`).join(", "), "Subtitle");
  [...new Set(metadata.authors.flatMap((author) => author.affiliations))].forEach((affiliation) => add(affiliation));
  for (const line of manuscript.version.markdown.split(/\r?\n/)) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) add(heading[2], `Heading${heading[1].length}`);
    else if (line.trim()) add(line.replace(/^[-*]\s+/, "• "));
  }
  const statements = [
    ["Funding", metadata.fundingStatement], ["Competing interests", metadata.competingInterestsStatement], ["Author contributions", metadata.authorContributionsStatement],
    ["Data availability", metadata.dataAvailabilityStatement], ["Code availability", metadata.codeAvailabilityStatement], ["Ethics statement", metadata.ethicsStatement],
  ] as const;
  for (const [heading, text] of statements) if (text) { add(heading, "Heading1"); add(text); }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr><w:lnNumType w:countBy="1"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>${["Title", "Subtitle", "Heading1", "Heading2", "Heading3"].map((name, index) => `<w:style w:type="paragraph" w:styleId="${name}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${name.startsWith("Heading") ? `<w:pPr><w:outlineLvl w:val="${index - 2}"/></w:pPr>` : ""}</w:style>`).join("")}</w:styles>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(document), "word/styles.xml": strToU8(styles),
  }, { level: 6 });
}

function texText(manuscript: ScienceManuscript, metadata: ScienceSubmissionMetadata): string {
  const body = manuscript.version.markdown.split(/\r?\n/).map((line) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) return `${["section", "subsection", "subsubsection"][heading[1].length - 1]}{${latex(heading[2])}}`;
    return latex(line);
  }).join("\n");
  return `\\documentclass[12pt]{article}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{lineno}\n\\linenumbers\n\\title{${latex(manuscript.title)}}\n\\author{${latex(metadata.authors.map((author) => author.name).join(", "))}}\n\\begin{document}\n\\maketitle\n${body}\n\\end{document}\n`;
}

function slug(value: string): string { return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "journal"; }

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
        ? await this.fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "text/html, text/plain;q=0.9", "user-agent": "Agentlas-Science/1.0 (official journal guideline inspection; https://agentlas.ai)" } })
        : await pinnedHttpsFetch(url, pinned.address, pinned.family, controller.signal);
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(`science-journal-guideline-http-${response.status}`);
    const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (mimeType !== "text/html" && mimeType !== "text/plain") throw new Error("science-journal-guideline-mime-invalid");
    const bytes = await readBounded(response);
    const decoded = bytes.toString("utf8");
    const extracted = mimeType === "text/html" ? htmlText(decoded) : { title: url.hostname, text: decoded.replace(/\s+/g, " ").trim() };
    return this.store.recordJournalGuidelineInspection({
      projectId: input.projectId, sourceUrl: url.toString(), officialHost: url.hostname.toLowerCase(), pageTitle: extracted.title,
      mimeType, responseBytes: bytes, normalizedText: extracted.text, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"), retrievedAt: new Date().toISOString(),
    });
  }

  createJournalProfile(input: CreateScienceJournalProfileInput): CreateScienceJournalProfileResult { return this.store.createJournalProfile(input); }
  listJournalProfiles(projectId: string): ScienceJournalProfile[] { return this.store.listJournalProfiles(projectId); }
  confirmJournalIdentity(input: Parameters<ScienceStore["confirmJournalIdentity"]>[0]) { return this.store.confirmJournalIdentity(input); }
  confirmHumanAttestation(input: Parameters<ScienceStore["confirmJournalHumanAttestation"]>[0]) { return this.store.confirmJournalHumanAttestation(input); }

  validate(manuscript: ScienceManuscript, profile: ScienceJournalProfile, rawMetadata?: ScienceSubmissionMetadata, humanAttestationReceiptIds: string[] = []): ScienceJournalValidationReport {
    if (profile.status !== "verified" || !profile.version.identityReceiptId || !profile.version.identityReceiptSha256 || !profile.version.coverageManifestSha256 || profile.version.coverage.some((entry) => entry.status === "unresolved")) {
      throw new Error("science-journal-profile-not-ready");
    }
    const metadata = metadataInput(rawMetadata ?? { authors: [], keywords: [], fundingStatement: null, competingInterestsStatement: null, authorContributionsStatement: null, dataAvailabilityStatement: null, codeAvailabilityStatement: null, ethicsStatement: null, coverLetter: null });
    const receipts = humanAttestationReceiptIds.map((receiptId) => this.store.getJournalHumanAttestationReceiptForProject(manuscript.projectId, receiptId));
    if (receipts.some((receipt) => !receipt || receipt.consumedByExportId !== null || receipt.manuscriptId !== manuscript.id || receipt.manuscriptVersion !== manuscript.currentVersion
      || receipt.manuscriptContentSha256 !== manuscript.version.contentSha256 || receipt.journalProfileId !== profile.id || receipt.journalProfileVersion !== profile.currentVersion
      || receipt.journalProfileContentSha256 !== profile.version.contentSha256)) throw new Error("science-journal-attestation-receipt-mismatch");
    const attestedCodes = new Set(receipts.map((receipt) => (receipt as ScienceJournalHumanAttestationReceipt).code));
    let claimLedger: ReturnType<ScienceStore["evaluateClaimLedgerForManuscript"]> | null = null;
    try {
      claimLedger = this.store.evaluateClaimLedgerForManuscript(manuscript.projectId, manuscript.id);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "science-claim-ledger-required") throw error;
    }
    const findings: ScienceJournalValidationFinding[] = profile.version.rules.map((rule) => {
      const result = evaluateRule(rule, manuscript, metadata, attestedCodes, this.store);
      const source = profile.version.sources.find((item) => item.inspectionId === rule.inspectionId)!;
      return { ruleId: rule.id, severity: rule.severity, status: result.status, requirement: rule.requirement, observed: result.observed, sourceUrl: source.sourceUrl, evidenceQuote: rule.evidenceQuote };
    });
    findings.unshift(
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
    }
    const fail = findings.filter((item) => item.status === "fail").length;
    const manual = findings.filter((item) => item.status === "manual").length;
    const warning = findings.filter((item) => item.status === "fail" && item.severity === "warning").length;
    const errorFail = findings.some((item) => item.status === "fail" && item.severity === "error");
    const status: ScienceJournalValidationReport["status"] = errorFail ? "blocked" : manual ? "manual-review" : "ready";
    const generatedAt = [manuscript.version.createdAt, profile.version.createdAt].sort().at(-1)!;
    const core = {
      schema: "agentlas.science-journal-validation/v1" as const, projectId: manuscript.projectId, manuscriptId: manuscript.id, manuscriptVersion: manuscript.currentVersion,
      manuscriptContentSha256: manuscript.version.contentSha256, journalProfileId: profile.id, journalProfileVersion: profile.currentVersion,
      journalProfileContentSha256: profile.version.contentSha256,
      claimLedgerId: claimLedger?.manifest.ledgerId ?? null,
      claimLedgerRevision: claimLedger?.manifest.revision ?? null,
      claimLedgerManifestSha256: claimLedger?.manifest.manifestSha256 ?? null,
      claimGateReportSha256: claimLedger?.gate.reportSha256 ?? null,
      claimPolicyContentSha256: claimLedger?.gate.policyContentSha256 ?? null,
      status, counts: { pass: findings.filter((item) => item.status === "pass").length, fail, manual, warning }, findings, generatedAt,
    };
    return { ...core, reportSha256: sha256(canonicalJson(core)) };
  }

  createSubmissionExport(input: CreateScienceSubmissionExportInput): CreateScienceSubmissionExportResult {
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
    if (replayed) return { submissionExport: replayed.submissionExport, validation: replayed.validationReceipt.report, validationReceipt: replayed.validationReceipt, replayed: true };
    const validation = this.validate(manuscript, profile, metadata, input.humanAttestationReceiptIds);
    const validationReceipt = this.store.recordJournalValidationReceipt({
      requestId: derivedRequestId(input.requestId, "journal-validation"), projectId: input.projectId, manuscriptId: manuscript.id, manuscriptVersion: manuscript.currentVersion, manuscriptContentSha256: manuscript.version.contentSha256,
      journalProfileId: profile.id, journalProfileVersion: profile.currentVersion, journalProfileContentSha256: profile.version.contentSha256,
      humanAttestationReceiptIds: input.humanAttestationReceiptIds, report: validation,
    });
    const manifestBase = {
      schema: "agentlas.science-submission-manifest/v3", projectId: input.projectId, manuscript: { id: manuscript.id, version: manuscript.currentVersion, contentSha256: manuscript.version.contentSha256, bindingManifestSha256: manuscript.version.bindingManifestSha256 },
      journalProfile: { id: profile.id, version: profile.currentVersion, contentSha256: profile.version.contentSha256, sourceManifestSha256: profile.version.sourceManifestSha256, ruleManifestSha256: profile.version.ruleManifestSha256, identityReceiptId: profile.version.identityReceiptId, identityReceiptSha256: profile.version.identityReceiptSha256, coverageManifestSha256: profile.version.coverageManifestSha256 },
      metadataSha256: sha256(canonicalJson(metadata)), validationReceiptId: validationReceipt.id, validationReceiptSha256: validationReceipt.contentSha256, validationReportSha256: validation.reportSha256,
      claimLedger: validation.claimLedgerId === null ? null : { id: validation.claimLedgerId, revision: validation.claimLedgerRevision, manifestSha256: validation.claimLedgerManifestSha256 },
      claimGateReportSha256: validation.claimGateReportSha256,
      claimPolicyContentSha256: validation.claimPolicyContentSha256,
    };
    let packageBytes: Buffer | null = null;
    let fileName: string | null = null;
    let manifestSha256 = sha256(canonicalJson(manifestBase));
    if (validation.status === "ready") {
      const claimLedger = this.store.evaluateClaimLedgerForManuscript(input.projectId, manuscript.id);
      if (!claimLedger.gate.ready || claimLedger.manifest.ledgerId !== validation.claimLedgerId || claimLedger.manifest.revision !== validation.claimLedgerRevision
        || claimLedger.manifest.manifestSha256 !== validation.claimLedgerManifestSha256 || claimLedger.gate.reportSha256 !== validation.claimGateReportSha256
        || claimLedger.gate.policyContentSha256 !== validation.claimPolicyContentSha256) throw new Error("science-submission-claim-gate-stale");
      const files: Record<string, Uint8Array> = {
        "manuscript/manuscript.md": strToU8(manuscript.version.markdown),
        "manuscript/manuscript.tex": strToU8(texText(manuscript, metadata)),
        "manuscript/manuscript.docx": docxBytes(manuscript, metadata),
        "submission/metadata.json": strToU8(JSON.stringify(metadata, null, 2)),
        "submission/journal-profile.json": strToU8(JSON.stringify(profile, null, 2)),
        "submission/validation-report.json": strToU8(JSON.stringify(validation, null, 2)),
        "submission/validation-receipt.json": strToU8(JSON.stringify(validationReceipt, null, 2)),
        "submission/evidence-bindings.json": strToU8(JSON.stringify(manuscript.version.bindings, null, 2)),
        "submission/claim-ledger.json": strToU8(JSON.stringify(claimLedger.manifest, null, 2)),
        "submission/claim-gate-report.json": strToU8(JSON.stringify(claimLedger.gate, null, 2)),
        "submission/cover-letter.md": strToU8(metadata.coverLetter ?? `# Cover letter\n\nTarget journal: ${profile.journalName}\nArticle type: ${profile.articleType}\n`),
        "README.txt": strToU8(`Agentlas Science submission bundle\nJournal: ${profile.journalName}\nArticle type: ${profile.articleType}\nManuscript immutable v${manuscript.currentVersion}\nVerify MANIFEST.json before upload.\n`),
      };
      for (const binding of manuscript.version.bindings) {
        if (binding.target.kind === "artifact" && (binding.role === "figure" || binding.role === "table")) {
          const context = this.store.getArtifactContextForProject(input.projectId, binding.target.artifactId, binding.target.artifactVersion);
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
      const fileManifest = Object.keys(files).sort().map((name) => ({ name, byteSize: files[name].byteLength, sha256: sha256(files[name]) }));
      const preZipClaimLedger = this.store.evaluateClaimLedgerForManuscript(input.projectId, manuscript.id);
      if (!preZipClaimLedger.gate.ready || preZipClaimLedger.manifest.manifestSha256 !== claimLedger.manifest.manifestSha256
        || preZipClaimLedger.gate.reportSha256 !== claimLedger.gate.reportSha256 || preZipClaimLedger.gate.policyContentSha256 !== claimLedger.gate.policyContentSha256) {
        throw new Error("science-submission-claim-gate-stale");
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
