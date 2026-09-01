import { createHash } from "node:crypto";
import type { ScienceSource } from "../../shared/science-contract";
import { ScienceStore } from "./store";

export const ACADEMIC_FULL_TEXT_TOOL_ID = "agentlas.academic-full-text";
export const ACADEMIC_FULL_TEXT_TOOL_VERSION = "1.0.0";

const EUROPE_PMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const EUROPE_PMC_FULL_TEXT_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_FULL_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_PARSED_BYTES = 64 * 1024 * 1024;

export interface AcademicFullTextInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  sourceId: string;
  expectedSourceVersionId: string;
}

export interface AcademicFullTextReceipt {
  provider: "europe-pmc";
  metadataUrl: string;
  fullTextUrl: string;
  metadataRequestSha256: string;
  metadataResponseSha256: string;
  fullTextRequestSha256: string;
  fullTextResponseSha256: string;
  parsedTextSha256: string;
  retrievedAt: string;
  pmcid: string;
  license: string | null;
  rawByteSize: number;
  parsedByteSize: number;
}

export interface AcademicFullTextResult {
  schema: "agentlas.academic-full-text-result/v1";
  evidenceScope: "full-text";
  source: ScienceSource;
  receipt: AcademicFullTextReceipt;
  sectionHeadings: string[];
  runId: string;
  replayed: boolean;
}

type FetchLike = typeof fetch;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function exactText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(code);
  return normalized;
}

function normalizeDoi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
  return /^10\.\d{4,9}\/.+/.test(normalized) ? normalized : null;
}

function sourceIdentity(source: ScienceSource): { query: string; doi: string | null; pmid: string | null } {
  const pmidMatch = /^pmid:(\d{1,20})$/i.exec(source.canonicalUri);
  if (pmidMatch) return { query: `EXT_ID:${pmidMatch[1]} AND SRC:MED`, doi: null, pmid: pmidMatch[1] };
  const doi = normalizeDoi(source.canonicalUri);
  if (doi) return { query: `DOI:\"${doi.replace(/[\"\\]/g, "")}\"`, doi, pmid: null };
  throw new Error("science-academic-full-text-identity-unsupported");
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ",
    thinsp: " ", ndash: "–", mdash: "—", minus: "−", times: "×", middot: "·", hellip: "…",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const numeric = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0x10ffff) return "�";
      try { return String.fromCodePoint(numeric); } catch { return "�"; }
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function jatsFragmentText(fragment: string): string {
  return decodeXmlEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function parseEuropePmcJats(xmlBytes: Buffer): { text: string; bytes: Buffer; sectionHeadings: string[] } {
  let xml: string;
  try { xml = new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes); } catch { throw new Error("science-academic-full-text-xml-encoding-invalid"); }
  if (!/<article(?:\s|>)/i.test(xml) || !/<body(?:\s|>)/i.test(xml)) throw new Error("science-academic-full-text-jats-invalid");
  const withoutUnsafeDeclarations = xml
    .replace(/<!DOCTYPE[\s\S]*?\]>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?(?:xml|processing-instruction)[\s\S]*?\?>/gi, "");
  const sectionHeadings = [...withoutUnsafeDeclarations.matchAll(/<(?:article-title|title)(?:\s[^>]*)?>([\s\S]*?)<\/(?:article-title|title)>/gi)]
    .map((match) => jatsFragmentText(match[1]))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 500);
  const blockSeparated = withoutUnsafeDeclarations
    .replace(/<(?:br|break)(?:\s[^>]*)?\/?\s*>/gi, "\n")
    .replace(/<\/(?:article-title|title|subtitle|p|sec|abstract|list-item|caption|table-wrap|tr|fig|ref)>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, " ");
  const text = decodeXmlEntities(blockSeparated)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length < 200 || bytes.length > MAX_PARSED_BYTES) throw new Error("science-academic-full-text-parsed-size-invalid");
  return { text, bytes, sectionHeadings };
}

async function fetchExact(fetchImpl: FetchLike, url: URL, accept: string, maximumBytes: number): Promise<{ bytes: Buffer; response: Response; retrievedAt: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept, "user-agent": "Agentlas-Science/1.0 (open-access full-text retrieval; https://agentlas.ai)" },
    });
    if (!response.ok) throw new Error(`science-academic-full-text-http-${response.status}`);
    const contentLength = response.headers.get("content-length");
    const length = contentLength === null ? null : Number(contentLength);
    if (length !== null && (!Number.isFinite(length) || length < 1 || length > maximumBytes)) throw new Error("science-academic-full-text-response-size-invalid");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1 || bytes.length > maximumBytes) throw new Error("science-academic-full-text-response-size-invalid");
    return { bytes, response, retrievedAt: new Date().toISOString() };
  } finally { clearTimeout(timeout); }
}

function matchingEuropePmcRecord(payload: unknown, identity: { doi: string | null; pmid: string | null }): Record<string, unknown> {
  const records = (payload as { resultList?: { result?: unknown[] } } | null)?.resultList?.result;
  if (!Array.isArray(records)) throw new Error("science-academic-full-text-metadata-invalid");
  const match = records.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    if (identity.pmid) return String(record.pmid ?? record.id ?? "") === identity.pmid;
    return Boolean(identity.doi && normalizeDoi(record.doi) === identity.doi);
  });
  if (!match || typeof match !== "object" || Array.isArray(match)) throw new Error("science-academic-full-text-identity-mismatch");
  return match as Record<string, unknown>;
}

export class ScienceAcademicFullTextService {
  constructor(private readonly store: ScienceStore, private readonly fetchImpl: FetchLike = fetch) {}

  async retrieve(input: AcademicFullTextInput): Promise<AcademicFullTextResult> {
    const sourceId = exactText(input.sourceId, 80, "science-source-id-invalid");
    const expectedSourceVersionId = exactText(input.expectedSourceVersionId, 80, "science-source-version-id-invalid");
    const exactSource = this.store.getSourceVersionForProject(input.projectId, sourceId, expectedSourceVersionId);
    if (!exactSource) throw new Error("science-source-version-not-found");
    const identity = sourceIdentity(exactSource);
    const normalizedInput = { sourceId, expectedSourceVersionId, provider: "europe-pmc", identity };
    const inputBytes = Buffer.from(canonicalJson(normalizedInput), "utf8");
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = { role: "source-identity", mimeType: "application/vnd.agentlas.academic-full-text-request+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const runCreation = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      toolId: ACADEMIC_FULL_TEXT_TOOL_ID,
      toolVersion: ACADEMIC_FULL_TEXT_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "europe-pmc-oa-fulltext-v1", endpoints: [EUROPE_PMC_SEARCH, EUROPE_PMC_FULL_TEXT_BASE], runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, runCreation.run.id) ?? runCreation.run;
    if (runCreation.replayed && run.status === "succeeded") {
      const resultOutput = run.outputs.find((output) => output.role === "fulltext-result" && output.mimeType === "application/vnd.agentlas.academic-full-text-result+json");
      if (!resultOutput) throw new Error("science-academic-full-text-replay-output-invalid");
      const result = JSON.parse(this.store.readRunBlob(resultOutput).toString("utf8")) as AcademicFullTextResult;
      return { ...result, replayed: true };
    }
    if (runCreation.replayed) throw new Error(`science-academic-full-text-run-terminal-${run.status}`);
    const current = this.store.getSourceForProject(input.projectId, sourceId);
    if (!current || current.version.id !== expectedSourceVersionId) {
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:stale`), projectId: input.projectId, runId: run.id, status: "failed",
        outputManifestSha256: sha256(canonicalJson([])), summary: "The requested SourceVersion is no longer current.", outputs: [],
      });
      throw new Error("science-source-version-conflict");
    }
    try {
      const metadataUrl = new URL(EUROPE_PMC_SEARCH);
      metadataUrl.searchParams.set("query", identity.query);
      metadataUrl.searchParams.set("format", "json");
      metadataUrl.searchParams.set("resultType", "core");
      metadataUrl.searchParams.set("pageSize", "10");
      const metadata = await fetchExact(this.fetchImpl, metadataUrl, "application/json", MAX_METADATA_BYTES);
      let metadataPayload: unknown;
      try { metadataPayload = JSON.parse(metadata.bytes.toString("utf8")); } catch { throw new Error("science-academic-full-text-metadata-invalid"); }
      const record = matchingEuropePmcRecord(metadataPayload, identity);
      const pmcid = exactText(record.pmcid, 40, "science-academic-full-text-not-open-access").toUpperCase();
      if (!/^PMC\d+$/.test(pmcid) || String(record.isOpenAccess ?? "").toUpperCase() !== "Y") throw new Error("science-academic-full-text-not-open-access");
      const fullTextUrl = new URL(`${EUROPE_PMC_FULL_TEXT_BASE}/${pmcid}/fullTextXML`);
      const fullText = await fetchExact(this.fetchImpl, fullTextUrl, "application/xml, text/xml;q=0.9", MAX_FULL_TEXT_BYTES);
      const contentType = String(fullText.response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType && !contentType.includes("xml")) throw new Error("science-academic-full-text-content-type-invalid");
      const parsed = parseEuropePmcJats(fullText.bytes);
      const license = typeof record.license === "string" && record.license.trim() ? record.license.trim().slice(0, 500) : current.version.license;
      const appended = this.store.appendSourceVersion({
        requestId: stableUuid(`${input.requestId}:source-version`), projectId: input.projectId, sourceId,
        accessState: "parsed", contentSha256: sha256(parsed.bytes), mimeType: "text/plain; charset=utf-8",
        retrievedAt: fullText.retrievedAt,
        retrievalMethod: `agentlas-europe-pmc-fulltext/v1:${pmcid}:raw-sha256:${sha256(fullText.bytes)}`,
        license,
      }, parsed.bytes);
      const receipt: AcademicFullTextReceipt = {
        provider: "europe-pmc", metadataUrl: metadataUrl.toString(), fullTextUrl: fullTextUrl.toString(),
        metadataRequestSha256: sha256(metadataUrl.toString()), metadataResponseSha256: sha256(metadata.bytes),
        fullTextRequestSha256: sha256(fullTextUrl.toString()), fullTextResponseSha256: sha256(fullText.bytes),
        parsedTextSha256: sha256(parsed.bytes), retrievedAt: fullText.retrievedAt, pmcid, license,
        rawByteSize: fullText.bytes.length, parsedByteSize: parsed.bytes.length,
      };
      const provisional = { schema: "agentlas.academic-full-text-result/v1" as const, evidenceScope: "full-text" as const, source: appended.source, receipt, sectionHeadings: parsed.sectionHeadings, runId: run.id, replayed: false };
      const metadataBlob = this.store.putRunBlob(metadata.bytes);
      const xmlBlob = this.store.putRunBlob(fullText.bytes);
      const parsedBlob = this.store.putRunBlob(parsed.bytes);
      const resultBytes = Buffer.from(canonicalJson(provisional), "utf8");
      const resultBlob = this.store.putRunBlob(resultBytes);
      const outputs = [
        { role: "provider-metadata", mimeType: "application/json", ...metadataBlob, artifactId: null, artifactVersion: null },
        { role: "fulltext-xml", mimeType: "application/xml", ...xmlBlob, artifactId: null, artifactVersion: null },
        { role: "parsed-fulltext", mimeType: "text/plain; charset=utf-8", ...parsedBlob, artifactId: null, artifactVersion: null },
        { role: "fulltext-result", mimeType: "application/vnd.agentlas.academic-full-text-result+json", ...resultBlob, artifactId: null, artifactVersion: null },
      ];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: `Retrieved and deterministically parsed Europe PMC OA full text ${pmcid}.`, outputs,
      });
      return provisional;
    } catch (error) {
      const failure = { schema: "agentlas.academic-full-text-failure/v1", code: error instanceof Error ? error.message.slice(0, 240) : "science-academic-full-text-failed" };
      const bytes = Buffer.from(canonicalJson(failure), "utf8");
      const blob = this.store.putRunBlob(bytes);
      const outputs = [{ role: "fulltext-failure", mimeType: "application/vnd.agentlas.academic-full-text-failure+json", ...blob, artifactId: null, artifactVersion: null }];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: failure.code, outputs,
      });
      throw error;
    }
  }
}
