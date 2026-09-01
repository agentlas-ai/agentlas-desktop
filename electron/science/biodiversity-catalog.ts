import { createHash } from "node:crypto";
import type { ScienceSource } from "../../shared/science-contract";
import { ScienceStore } from "./store";

export const BIODIVERSITY_CATALOG_TOOL_ID = "agentlas.biodiversity-catalog";
export const BIODIVERSITY_CATALOG_TOOL_VERSION = "1.0.0";
export const GBIF_OCCURRENCE_ENDPOINT = "https://api.gbif.org/v1/occurrence/search";

export interface BiodiversityCatalogInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  scientificName: string;
  countryCode?: string;
  fromYear?: number;
  toYear?: number;
  limit?: number;
  title?: string;
}

export interface BiodiversityOccurrence {
  id: string;
  gbifKey: string;
  scientificName: string;
  species: string | null;
  genus: string | null;
  family: string | null;
  order: string | null;
  className: string | null;
  phylum: string | null;
  kingdom: string | null;
  latitude: number;
  longitude: number;
  eventDate: string | null;
  year: number | null;
  basisOfRecord: string;
  countryCode: string | null;
  datasetKey: string | null;
  issues: string[];
}

export interface BiodiversityCatalogReceipt {
  provider: "gbif-occurrence";
  endpoint: string;
  requestSha256: string;
  responseSha256: string;
  retrievedAt: string;
  durationMs: number;
  httpStatus: number;
  rowCount: number;
  totalCount: number;
  endOfRecords: boolean;
}

export interface BiodiversityCatalogResult {
  schema: "agentlas.biodiversity-catalog-result/v1";
  provider: "gbif-occurrence";
  query: {
    scientificName: string;
    countryCode: string | null;
    fromYear: number | null;
    toYear: number | null;
    limit: number;
    hasCoordinate: true;
    occurrenceStatus: "PRESENT";
  };
  title: string;
  occurrences: BiodiversityOccurrence[];
  sourceId: string;
  sourceVersionId: string;
  receipt: BiodiversityCatalogReceipt;
  warnings: string[];
  runId: string;
  replayed: boolean;
}

interface GbifResponse {
  offset?: unknown;
  limit?: unknown;
  endOfRecords?: unknown;
  count?: unknown;
  results?: unknown;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function boundedText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(code);
  return value.trim();
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) return null;
  return value.trim();
}

function optionalYear(value: unknown, code: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1000 || Number(value) > 3000) throw new Error(code);
  return Number(value);
}

function parseOccurrence(raw: unknown, index: number): BiodiversityOccurrence {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`science-biodiversity-row-${index}-invalid`);
  const record = raw as Record<string, unknown>;
  const key = typeof record.key === "number" && Number.isSafeInteger(record.key) && record.key > 0
    ? String(record.key)
    : typeof record.key === "string" && /^\d{1,30}$/.test(record.key) ? record.key : null;
  const scientificName = optionalText(record.scientificName, 500);
  const latitude = typeof record.decimalLatitude === "number" && Number.isFinite(record.decimalLatitude) ? record.decimalLatitude : null;
  const longitude = typeof record.decimalLongitude === "number" && Number.isFinite(record.decimalLongitude) ? record.decimalLongitude : null;
  const basisOfRecord = optionalText(record.basisOfRecord, 120);
  if (!key || !scientificName || latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || !basisOfRecord) {
    throw new Error(`science-biodiversity-row-${index}-invalid`);
  }
  const year = Number.isSafeInteger(record.year) && Number(record.year) >= 1000 && Number(record.year) <= 3000 ? Number(record.year) : null;
  const countryCode = optionalText(record.countryCode, 2)?.toUpperCase() ?? null;
  const issues = Array.isArray(record.issues)
    ? record.issues.map((issue) => optionalText(issue, 160)).filter((issue): issue is string => Boolean(issue)).slice(0, 100)
    : [];
  return {
    id: stableUuid(`gbif-occurrence:v1:${key}`),
    gbifKey: key,
    scientificName,
    species: optionalText(record.species, 500),
    genus: optionalText(record.genus, 240),
    family: optionalText(record.family, 240),
    order: optionalText(record.order, 240),
    className: optionalText(record.class, 240),
    phylum: optionalText(record.phylum, 240),
    kingdom: optionalText(record.kingdom, 240),
    latitude,
    longitude,
    eventDate: optionalText(record.eventDate, 120),
    year,
    basisOfRecord,
    countryCode,
    datasetKey: optionalText(record.datasetKey, 80),
    issues,
  };
}

function parseGbifResponse(payload: GbifResponse, limit: number): { occurrences: BiodiversityOccurrence[]; totalCount: number; endOfRecords: boolean } {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) throw new Error("science-biodiversity-response-schema-invalid");
  const occurrences = payload.results.slice(0, limit).map(parseOccurrence);
  if (new Set(occurrences.map((occurrence) => occurrence.id)).size !== occurrences.length) throw new Error("science-biodiversity-occurrence-duplicate");
  const totalCount = Number.isSafeInteger(payload.count) && Number(payload.count) >= 0 ? Number(payload.count) : occurrences.length;
  return { occurrences, totalCount, endOfRecords: payload.endOfRecords === true };
}

async function fetchGbif(url: URL, fetchImpl: typeof fetch, timeoutMs = 20_000): Promise<{ body: Buffer; response: Response; retrievedAt: string; durationMs: number }> {
  if (url.origin !== "https://api.gbif.org" || url.pathname !== "/v1/occurrence/search") throw new Error("science-biodiversity-endpoint-denied");
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: "application/json", "user-agent": "Agentlas-Science/1.0 (biodiversity occurrence research; https://agentlas.ai)" },
    });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 12 * 1024 * 1024) throw new Error("science-biodiversity-response-size-invalid");
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`science-biodiversity-http-${response.status}`);
    const mime = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0].trim();
    if (mime !== "application/json" || body.length < 2 || body.length > 12 * 1024 * 1024) throw new Error("science-biodiversity-response-invalid");
    return { body, response, retrievedAt: new Date().toISOString(), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

export class ScienceBiodiversityCatalogService {
  constructor(private readonly store: ScienceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  async search(input: BiodiversityCatalogInput): Promise<BiodiversityCatalogResult> {
    const scientificName = boundedText(input.scientificName, 500, "science-biodiversity-name-invalid");
    const countryCode = input.countryCode === undefined ? null : boundedText(input.countryCode, 2, "science-biodiversity-country-invalid").toUpperCase();
    if (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) throw new Error("science-biodiversity-country-invalid");
    const fromYear = optionalYear(input.fromYear, "science-biodiversity-from-year-invalid");
    const toYear = optionalYear(input.toYear, "science-biodiversity-to-year-invalid");
    if (fromYear !== null && toYear !== null && fromYear > toYear) throw new Error("science-biodiversity-year-range-invalid");
    const limit = Math.max(1, Math.min(300, Math.floor(input.limit ?? 200)));
    const title = optionalText(input.title, 240) ?? `GBIF occurrences · ${scientificName}`;
    const url = new URL(GBIF_OCCURRENCE_ENDPOINT);
    url.searchParams.set("scientificName", scientificName);
    url.searchParams.set("hasCoordinate", "true");
    url.searchParams.set("occurrenceStatus", "PRESENT");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", "0");
    if (countryCode) url.searchParams.set("country", countryCode);
    if (fromYear !== null || toYear !== null) url.searchParams.set("year", `${fromYear ?? 1000},${toYear ?? 3000}`);
    const requestSha256 = sha256(url.toString());
    const query = { scientificName, countryCode, fromYear, toYear, limit, hasCoordinate: true as const, occurrenceStatus: "PRESENT" as const };
    const inputEnvelope = { schema: "agentlas.biodiversity-catalog-query/v1", provider: "gbif-occurrence", endpoint: GBIF_OCCURRENCE_ENDPOINT, requestSha256, query, title };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = { role: "biodiversity-query", mimeType: "application/vnd.agentlas.biodiversity-catalog-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: BIODIVERSITY_CATALOG_TOOL_ID, toolVersion: BIODIVERSITY_CATALOG_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "gbif-occurrence-search-v1", endpoint: GBIF_OCCURRENCE_ENDPOINT, runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "catalog-results" && resource.mimeType === "application/vnd.agentlas.biodiversity-catalog-results+json");
      if (!output) throw new Error("science-biodiversity-replay-output-missing");
      const stored = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as BiodiversityCatalogResult;
      if (stored.schema !== "agentlas.biodiversity-catalog-result/v1" || stored.runId !== run.id) throw new Error("science-biodiversity-replay-output-invalid");
      return { ...stored, replayed: true };
    }
    try {
      const fetched = await fetchGbif(url, this.fetchImpl);
      const responseSha256 = sha256(fetched.body);
      const parsed = parseGbifResponse(JSON.parse(fetched.body.toString("utf8")) as GbifResponse, limit);
      const receipt: BiodiversityCatalogReceipt = {
        provider: "gbif-occurrence", endpoint: GBIF_OCCURRENCE_ENDPOINT, requestSha256, responseSha256,
        retrievedAt: fetched.retrievedAt, durationMs: fetched.durationMs, httpStatus: fetched.response.status,
        rowCount: parsed.occurrences.length, totalCount: parsed.totalCount, endOfRecords: parsed.endOfRecords,
      };
      const canonicalSourceUrl = new URL(url.toString());
      let source: ScienceSource | null = this.store.getSourceByCanonicalUriForProject(input.projectId, canonicalSourceUrl.toString());
      if (!source) {
        source = this.store.createSource({
          requestId: stableUuid(`${input.requestId}:source:${requestSha256}`), projectId: input.projectId,
          kind: "database-record", canonicalUri: canonicalSourceUrl.toString(), title,
          authors: ["Global Biodiversity Information Facility"], publicationYear: null, publisher: "GBIF",
          containerTitle: "GBIF Occurrence Store", abstract: `Exact GBIF occurrence search for ${scientificName}; coordinates and provider issue flags are preserved without imputation.`,
          accessState: "retrieved", contentSha256: responseSha256, mimeType: "application/json",
          retrievedAt: fetched.retrievedAt, retrievalMethod: "agentlas-biodiversity-catalog:gbif-occurrence@1.0.0",
          license: "GBIF-user-agreement-and-record-level-rights",
        }, fetched.body).source;
      } else if (source.version.contentSha256 !== responseSha256 || source.version.mimeType !== "application/json") {
        source = this.store.appendSourceVersion({
          requestId: stableUuid(`${input.requestId}:source-version:${responseSha256}`), projectId: input.projectId,
          sourceId: source.id, accessState: "retrieved", contentSha256: responseSha256, mimeType: "application/json",
          retrievedAt: fetched.retrievedAt, retrievalMethod: "agentlas-biodiversity-catalog:gbif-occurrence@1.0.0",
          license: "GBIF-user-agreement-and-record-level-rights",
        }, fetched.body).source;
      }
      const partial: BiodiversityCatalogResult = {
        schema: "agentlas.biodiversity-catalog-result/v1", provider: "gbif-occurrence", query, title,
        occurrences: parsed.occurrences, sourceId: source.id, sourceVersionId: source.version.id, receipt,
        warnings: [
          ...(parsed.occurrences.length ? [] : ["GBIF returned no coordinate-bearing occurrences for the exact query; the empty result is preserved."]),
          ...(parsed.totalCount > parsed.occurrences.length ? [`The interactive artifact preserves the first ${parsed.occurrences.length} of ${parsed.totalCount} indexed records. Use an authenticated GBIF download for publication-scale exhaustive analysis.`] : []),
        ],
        runId: run.id, replayed: false,
      };
      const rawBlob = this.store.putRunBlob(fetched.body);
      const rawResource = { role: "provider-response", mimeType: "application/json", ...rawBlob, artifactId: null, artifactVersion: null };
      const resultBlob = this.store.putRunBlob(Buffer.from(canonicalJson(partial), "utf8"));
      const resultResource = { role: "catalog-results", mimeType: "application/vnd.agentlas.biodiversity-catalog-results+json", ...resultBlob, artifactId: null, artifactVersion: null };
      const outputs = [rawResource, resultResource];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id,
        status: "succeeded", outputManifestSha256: sha256(canonicalJson(outputs)),
        summary: `${parsed.occurrences.length} exact coordinate-bearing GBIF occurrences retrieved for ${scientificName}.`, outputs,
      });
      return partial;
    } catch (error) {
      const failure = { schema: "agentlas.biodiversity-catalog-failure/v1", provider: "gbif-occurrence", endpoint: GBIF_OCCURRENCE_ENDPOINT, requestSha256, code: error instanceof Error ? error.message.slice(0, 240) : "science-biodiversity-catalog-failed" };
      const failureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(failure), "utf8"));
      const failureResource = { role: "provider-receipt", mimeType: "application/vnd.agentlas.biodiversity-catalog-failure+json", ...failureBlob, artifactId: null, artifactVersion: null };
      this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson([failureResource])), summary: failure.code, outputs: [failureResource] });
      throw error;
    }
  }
}
