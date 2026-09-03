import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type {
  ScienceArtifact,
  ScienceResearchRun,
  ScienceResearchRunResource,
  ScienceSource,
} from "../../shared/science-contract";
import { ScienceStore } from "./store";

export const BIODIVERSITY_CATALOG_TOOL_ID = "agentlas.biodiversity-catalog";
export const BIODIVERSITY_CATALOG_TOOL_VERSION = "1.0.0";
export const GBIF_OCCURRENCE_ENDPOINT = "https://api.gbif.org/v1/occurrence/search";

const BIODIVERSITY_MAP_LAB_ID = "biodiversity-map";
const BIODIVERSITY_MAP_RENDERER_ID = "agentlas.vega";
const BIODIVERSITY_MAP_RENDERER_VERSION = "6.4.0";
const MAX_PROVIDER_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_CATALOG_RESULT_BYTES = 3 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;

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
  query: BiodiversityCatalogQuery;
  title: string;
  occurrences: BiodiversityOccurrence[];
  sourceId: string;
  sourceVersionId: string;
  receipt: BiodiversityCatalogReceipt;
  warnings: string[];
  runId: string;
  artifact: ScienceArtifact;
  replayed: boolean;
}

interface BiodiversityCatalogQuery {
  scientificName: string;
  countryCode: string | null;
  fromYear: number | null;
  toYear: number | null;
  limit: number;
  hasCoordinate: true;
  occurrenceStatus: "PRESENT";
}

type StoredBiodiversityCatalogResult = Omit<BiodiversityCatalogResult, "artifact"> & { replayed: false };

interface GbifResponse {
  offset?: unknown;
  limit?: unknown;
  endOfRecords?: unknown;
  count?: unknown;
  results?: unknown;
}

interface VerifiedCatalogClosure {
  run: ScienceResearchRun;
  input: ScienceResearchRunResource;
  rawOutput: ScienceResearchRunResource;
  resultOutput: ScienceResearchRunResource;
  stored: StoredBiodiversityCatalogResult;
  queryUrl: URL;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("science-biodiversity-canonical-json-invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  throw new Error("science-biodiversity-canonical-json-invalid");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function boundedText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return value.trim();
}

function nullableText(value: unknown, maximum: number, code: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  return boundedText(value, maximum, code);
}

function optionalYear(value: unknown, code: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1000 || Number(value) > 3000) throw new Error(code);
  return Number(value);
}

function requestedLimit(value: unknown): number {
  if (value === undefined) return 200;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 300) throw new Error("science-biodiversity-limit-invalid");
  return Number(value);
}

function defaultTitle(scientificName: string): string {
  const full = `GBIF occurrences · ${scientificName}`;
  return full.length <= 240 ? full : `${full.slice(0, 239)}…`;
}

function parseOccurrence(raw: unknown, index: number): BiodiversityOccurrence {
  const row = record(raw);
  if (!row) throw new Error(`science-biodiversity-row-${index}-invalid`);
  const key = typeof row.key === "number" && Number.isSafeInteger(row.key) && row.key > 0
    ? String(row.key)
    : typeof row.key === "string" && /^\d{1,30}$/u.test(row.key) ? row.key : null;
  const scientificName = nullableText(row.scientificName, 500, `science-biodiversity-row-${index}-name-invalid`);
  const latitude = typeof row.decimalLatitude === "number" && Number.isFinite(row.decimalLatitude) ? row.decimalLatitude : null;
  const longitude = typeof row.decimalLongitude === "number" && Number.isFinite(row.decimalLongitude) ? row.decimalLongitude : null;
  const basisOfRecord = nullableText(row.basisOfRecord, 120, `science-biodiversity-row-${index}-basis-invalid`);
  if (!key || !scientificName || latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || !basisOfRecord) {
    throw new Error(`science-biodiversity-row-${index}-invalid`);
  }
  const year = row.year === undefined || row.year === null
    ? null
    : Number.isSafeInteger(row.year) && Number(row.year) >= 1000 && Number(row.year) <= 3000
      ? Number(row.year)
      : (() => { throw new Error(`science-biodiversity-row-${index}-year-invalid`); })();
  const countryCode = nullableText(row.countryCode, 2, `science-biodiversity-row-${index}-country-invalid`)?.toUpperCase() ?? null;
  if (countryCode !== null && !/^[A-Z]{2}$/u.test(countryCode)) throw new Error(`science-biodiversity-row-${index}-country-invalid`);
  if (row.issues !== undefined && !Array.isArray(row.issues)) throw new Error(`science-biodiversity-row-${index}-issues-invalid`);
  const issues = (row.issues ?? []).map((issue: unknown, issueIndex: number) => boundedText(issue, 160, `science-biodiversity-row-${index}-issue-${issueIndex}-invalid`));
  if (issues.length > 100) throw new Error(`science-biodiversity-row-${index}-issues-invalid`);
  return {
    id: stableUuid(`gbif-occurrence:v1:${key}`),
    gbifKey: key,
    scientificName,
    species: nullableText(row.species, 500, `science-biodiversity-row-${index}-species-invalid`),
    genus: nullableText(row.genus, 240, `science-biodiversity-row-${index}-genus-invalid`),
    family: nullableText(row.family, 240, `science-biodiversity-row-${index}-family-invalid`),
    order: nullableText(row.order, 240, `science-biodiversity-row-${index}-order-invalid`),
    className: nullableText(row.class, 240, `science-biodiversity-row-${index}-class-invalid`),
    phylum: nullableText(row.phylum, 240, `science-biodiversity-row-${index}-phylum-invalid`),
    kingdom: nullableText(row.kingdom, 240, `science-biodiversity-row-${index}-kingdom-invalid`),
    latitude,
    longitude,
    eventDate: nullableText(row.eventDate, 120, `science-biodiversity-row-${index}-event-date-invalid`),
    year,
    basisOfRecord,
    countryCode,
    datasetKey: nullableText(row.datasetKey, 80, `science-biodiversity-row-${index}-dataset-invalid`),
    issues,
  };
}

function parseGbifResponse(payload: GbifResponse, limit: number): { occurrences: BiodiversityOccurrence[]; totalCount: number; endOfRecords: boolean } {
  if (!record(payload) || payload.offset !== 0 || payload.limit !== limit || typeof payload.endOfRecords !== "boolean"
    || !Number.isSafeInteger(payload.count) || Number(payload.count) < 0 || !Array.isArray(payload.results)
    || payload.results.length > limit || payload.results.length > Number(payload.count)) {
    throw new Error("science-biodiversity-response-schema-invalid");
  }
  const occurrences = payload.results.map(parseOccurrence);
  if (new Set(occurrences.map((occurrence) => occurrence.id)).size !== occurrences.length) throw new Error("science-biodiversity-occurrence-duplicate");
  return { occurrences, totalCount: Number(payload.count), endOfRecords: payload.endOfRecords };
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(code);
  }
}

function buildQueryUrl(query: BiodiversityCatalogQuery): URL {
  const url = new URL(GBIF_OCCURRENCE_ENDPOINT);
  url.searchParams.set("scientificName", query.scientificName);
  url.searchParams.set("hasCoordinate", "true");
  url.searchParams.set("occurrenceStatus", "PRESENT");
  url.searchParams.set("limit", String(query.limit));
  url.searchParams.set("offset", "0");
  if (query.countryCode) url.searchParams.set("country", query.countryCode);
  if (query.fromYear !== null || query.toYear !== null) url.searchParams.set("year", `${query.fromYear ?? 1000},${query.toYear ?? 3000}`);
  return url;
}

function validateQuery(value: unknown, code: string): BiodiversityCatalogQuery {
  const query = record(value);
  if (!query || !exactKeys(query, ["scientificName", "countryCode", "fromYear", "toYear", "limit", "hasCoordinate", "occurrenceStatus"])) throw new Error(code);
  const scientificName = boundedText(query.scientificName, 500, code);
  const countryCode = query.countryCode === null ? null : boundedText(query.countryCode, 2, code).toUpperCase();
  if (countryCode !== null && !/^[A-Z]{2}$/u.test(countryCode)) throw new Error(code);
  const fromYear = query.fromYear === null ? null : optionalYear(query.fromYear, code);
  const toYear = query.toYear === null ? null : optionalYear(query.toYear, code);
  if (fromYear !== null && toYear !== null && fromYear > toYear) throw new Error(code);
  const limit = requestedLimit(query.limit);
  if (query.hasCoordinate !== true || query.occurrenceStatus !== "PRESENT") throw new Error(code);
  return { scientificName, countryCode, fromYear, toYear, limit, hasCoordinate: true, occurrenceStatus: "PRESENT" };
}

function expectedWarnings(occurrenceCount: number, totalCount: number): string[] {
  return [
    ...(occurrenceCount ? [] : ["GBIF returned no coordinate-bearing occurrences for the exact query; the empty result is preserved."]),
    ...(totalCount > occurrenceCount ? [`The interactive artifact preserves the first ${occurrenceCount} of ${totalCount} indexed records. Use an authenticated GBIF download for publication-scale exhaustive analysis.`] : []),
  ];
}

function runResourceEnvelope(resource: ScienceResearchRunResource): Record<string, unknown> {
  return {
    role: resource.role,
    mimeType: resource.mimeType,
    byteSize: resource.byteSize,
    sha256: resource.sha256,
    blobRef: resource.blobRef,
    artifactId: resource.artifactId,
    artifactVersion: resource.artifactVersion,
  };
}

function basisOfRecordCounts(occurrences: BiodiversityOccurrence[]): Array<{ basisOfRecord: string; count: number }> {
  const counts = new Map<string, number>();
  for (const occurrence of occurrences) counts.set(occurrence.basisOfRecord, (counts.get(occurrence.basisOfRecord) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]
    || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([basisOfRecord, count]) => ({ basisOfRecord, count }));
}

function biodiversityMapPayload(closure: VerifiedCatalogClosure): Record<string, unknown> {
  const { stored } = closure;
  const plotted = stored.occurrences.map((occurrence) => ({
    id: occurrence.id,
    gbifKey: occurrence.gbifKey,
    scientificName: occurrence.scientificName,
    longitude: occurrence.longitude,
    latitude: occurrence.latitude,
    year: occurrence.year,
    basisOfRecord: occurrence.basisOfRecord,
    countryCode: occurrence.countryCode,
    issueCount: occurrence.issues.length,
  }));
  return {
    schema: "agentlas.science.biodiversity-map-artifact/v1",
    spec: {
      width: 720,
      height: 390,
      padding: { left: 16, right: 130, top: 24, bottom: 32 },
      background: "#ffffff",
      projections: [{ name: "world", type: "equalEarth", scale: 118, translate: [360, 195] }],
      data: [
        { name: "graticule", transform: [{ type: "graticule", step: [30, 30] }] },
        { name: "occurrences", values: plotted, transform: [{ type: "geopoint", projection: "world", fields: ["longitude", "latitude"], as: ["x", "y"] }] },
      ],
      scales: [{ name: "basis", type: "ordinal", domain: { data: "occurrences", field: "basisOfRecord" }, range: { scheme: "tableau10" } }],
      legends: [{ fill: "basis", title: "Basis of record", orient: "right", symbolType: "circle", labelLimit: 180 }],
      marks: [
        { type: "shape", from: { data: "graticule" }, transform: [{ type: "geoshape", projection: "world" }], encode: { enter: { fill: { value: "transparent" }, stroke: { value: "#d9d8d3" }, strokeWidth: { value: 0.7 } } } },
        { type: "symbol", from: { data: "occurrences" }, encode: { enter: { x: { field: "x" }, y: { field: "y" }, size: { value: 72 }, fill: { scale: "basis", field: "basisOfRecord" }, fillOpacity: { value: 0.78 }, stroke: { value: "#ffffff" }, strokeWidth: { value: 0.8 }, tooltip: { field: "scientificName" } }, update: { fillOpacity: { value: 0.78 } }, hover: { fillOpacity: { value: 1 }, size: { value: 140 } } } },
      ],
    },
    catalog: {
      provider: stored.provider,
      sourceId: stored.sourceId,
      sourceVersionId: stored.sourceVersionId,
      query: stored.query,
      occurrences: stored.occurrences,
      basisOfRecordCounts: basisOfRecordCounts(stored.occurrences),
    },
    evidence: {
      catalogRunId: closure.run.id,
      catalogInputSha256: closure.input.sha256,
      catalogResultSha256: closure.resultOutput.sha256,
      rawResponseSha256: closure.rawOutput.sha256,
      requestSha256: stored.receipt.requestSha256,
      responseSha256: stored.receipt.responseSha256,
      sourceId: stored.sourceId,
      sourceVersionId: stored.sourceVersionId,
      canonicalUri: closure.queryUrl.toString(),
      retrievedAt: stored.receipt.retrievedAt,
    },
  };
}

function biodiversityMapSemantic(stored: StoredBiodiversityCatalogResult): ScienceArtifact["version"]["semantic"] {
  return {
    title: stored.title,
    summary: `Interactive equal-Earth occurrence map built from ${stored.occurrences.length} exact GBIF rows for ${stored.query.scientificName}. Coordinates, dates, dataset ids, and provider issue flags are preserved without imputation.`,
    entities: stored.occurrences.slice(0, 100).map((occurrence) => ({ id: occurrence.id, label: occurrence.scientificName, type: occurrence.basisOfRecord })),
    observations: [
      { label: "Mapped occurrences", value: stored.occurrences.length, unit: null },
      { label: "Records with provider issues", value: stored.occurrences.filter((occurrence) => occurrence.issues.length > 0).length, unit: null },
      { label: "Distinct datasets", value: new Set(stored.occurrences.map((occurrence) => occurrence.datasetKey).filter(Boolean)).size, unit: null },
      { label: "Indexed total", value: stored.receipt.totalCount, unit: null },
    ],
    warnings: [...stored.warnings],
  };
}

function biodiversityMapProvenance(closure: VerifiedCatalogClosure): ScienceArtifact["version"]["provenance"] {
  return {
    sourceRunId: closure.run.id,
    sourceRefs: [closure.queryUrl.toString()],
    datasetSha256: [closure.rawOutput.sha256, closure.resultOutput.sha256],
    codeSha256: sha256(`${BIODIVERSITY_CATALOG_TOOL_ID}@${BIODIVERSITY_CATALOG_TOOL_VERSION}:verified-map-v1`),
    environmentSha256: closure.run.environmentSha256,
  };
}

async function fetchGbif(url: URL, fetchImpl: typeof fetch, timeoutMs = 20_000): Promise<{ body: Buffer; status: number; retrievedAt: string; durationMs: number }> {
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
    const declaredHeader = response.headers.get("content-length");
    if (declaredHeader !== null && (!/^\d+$/u.test(declaredHeader) || Number(declaredHeader) > MAX_PROVIDER_RESPONSE_BYTES)) {
      throw new Error("science-biodiversity-response-size-invalid");
    }
    if (!response.ok) throw new Error(`science-biodiversity-http-${response.status}`);
    const mime = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim();
    if (!response.body) throw new Error("science-biodiversity-response-invalid");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("science-biodiversity-response-size-invalid");
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks, total);
    if (mime !== "application/json" || body.length < 2 || body.length > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error("science-biodiversity-response-invalid");
    }
    return { body, status: response.status, retrievedAt: new Date().toISOString(), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

export class ScienceBiodiversityCatalogService {
  constructor(private readonly store: ScienceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  private upsertSource(input: { requestId: string; projectId: string; canonicalUri: string; title: string; body: Buffer; retrievedAt: string }): ScienceSource {
    const contentSha256 = sha256(input.body);
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.canonicalUri);
    if (!existing) return this.store.createSource({
      requestId: stableUuid(`${input.requestId}:source:${input.canonicalUri}:${contentSha256}`),
      projectId: input.projectId,
      kind: "database-record",
      canonicalUri: input.canonicalUri,
      title: input.title,
      authors: ["Global Biodiversity Information Facility"],
      publicationYear: null,
      publisher: "GBIF",
      containerTitle: "GBIF Occurrence Store",
      abstract: "Exact GBIF occurrence response; coordinates and provider issue flags are preserved without imputation.",
      accessState: "retrieved",
      contentSha256,
      mimeType: "application/json",
      retrievedAt: input.retrievedAt,
      retrievalMethod: "agentlas-biodiversity-catalog:gbif-occurrence@1.0.0",
      license: "GBIF-user-agreement-and-record-level-rights",
    }, input.body).source;
    if (existing.kind !== "database-record") throw new Error("science-biodiversity-source-kind-invalid");
    if (existing.version.contentSha256 === contentSha256 && existing.version.mimeType === "application/json") return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.canonicalUri}:${contentSha256}`),
      projectId: input.projectId,
      sourceId: existing.id,
      accessState: "retrieved",
      contentSha256,
      mimeType: "application/json",
      retrievedAt: input.retrievedAt,
      retrievalMethod: "agentlas-biodiversity-catalog:gbif-occurrence@1.0.0",
      license: "GBIF-user-agreement-and-record-level-rights",
    }, input.body).source;
  }

  private storedResultForRun(projectId: string, runId: string): VerifiedCatalogClosure {
    const run = this.store.getResearchRunForProject(projectId, runId);
    const input = run?.inputs[0];
    const rawOutput = run?.outputs[0];
    const resultOutput = run?.outputs[1];
    if (!run || run.status !== "succeeded" || run.projectId !== projectId || run.parentRunId !== null
      || run.toolId !== BIODIVERSITY_CATALOG_TOOL_ID || run.toolVersion !== BIODIVERSITY_CATALOG_TOOL_VERSION || run.runtime !== "electron-main"
      || run.inputs.length !== 1 || input?.ordinal !== 1 || input.role !== "biodiversity-query"
      || input.mimeType !== "application/vnd.agentlas.biodiversity-catalog-query+json" || input.artifactId !== null || input.artifactVersion !== null
      || run.outputs.length !== 2 || rawOutput?.ordinal !== 1 || rawOutput.role !== "provider-response" || rawOutput.mimeType !== "application/json"
      || rawOutput.artifactId !== null || rawOutput.artifactVersion !== null || resultOutput?.ordinal !== 2 || resultOutput.role !== "catalog-results"
      || resultOutput.mimeType !== "application/vnd.agentlas.biodiversity-catalog-results+json" || resultOutput.artifactId !== null || resultOutput.artifactVersion !== null
      || run.inputManifestSha256 !== sha256(canonicalJson(run.inputs.map(runResourceEnvelope)))
      || run.outputManifestSha256 !== sha256(canonicalJson(run.outputs.map(runResourceEnvelope)))) {
      throw new Error("science-biodiversity-run-closure-invalid");
    }
    const inputBytes = this.store.readRunBlob(input);
    const rawBytes = this.store.readRunBlob(rawOutput);
    const resultBytes = this.store.readRunBlob(resultOutput);
    if (resultBytes.length > MAX_CATALOG_RESULT_BYTES || rawOutput.sha256 !== sha256(rawBytes) || resultOutput.sha256 !== sha256(resultBytes)) {
      throw new Error("science-biodiversity-run-closure-invalid");
    }
    const envelope = record(parseJson(inputBytes, "science-biodiversity-run-closure-invalid"));
    const storedRecord = record(parseJson(resultBytes, "science-biodiversity-run-closure-invalid"));
    if (!envelope || !exactKeys(envelope, ["schema", "provider", "endpoint", "requestSha256", "query", "title"])
      || envelope.schema !== "agentlas.biodiversity-catalog-query/v1" || envelope.provider !== "gbif-occurrence"
      || envelope.endpoint !== GBIF_OCCURRENCE_ENDPOINT || !storedRecord || !exactKeys(storedRecord, [
        "schema", "provider", "query", "title", "occurrences", "sourceId", "sourceVersionId", "receipt", "warnings", "runId", "replayed",
      ]) || storedRecord.schema !== "agentlas.biodiversity-catalog-result/v1" || storedRecord.provider !== "gbif-occurrence"
      || storedRecord.runId !== run.id || storedRecord.replayed !== false || !UUID_RE.test(String(storedRecord.sourceId ?? ""))
      || !UUID_RE.test(String(storedRecord.sourceVersionId ?? "")) || !Array.isArray(storedRecord.occurrences) || !Array.isArray(storedRecord.warnings)) {
      throw new Error("science-biodiversity-run-closure-invalid");
    }
    const query = validateQuery(envelope.query, "science-biodiversity-run-closure-invalid");
    const storedQuery = validateQuery(storedRecord.query, "science-biodiversity-run-closure-invalid");
    const title = boundedText(envelope.title, 240, "science-biodiversity-run-closure-invalid");
    const queryUrl = buildQueryUrl(query);
    if (canonicalJson(query) !== canonicalJson(storedQuery) || storedRecord.title !== title
      || envelope.requestSha256 !== sha256(queryUrl.toString()) || !inputBytes.equals(Buffer.from(canonicalJson(envelope), "utf8"))) {
      throw new Error("science-biodiversity-run-closure-invalid");
    }
    const parsed = parseGbifResponse(parseJson(rawBytes, "science-biodiversity-response-schema-invalid") as GbifResponse, query.limit);
    const receipt = record(storedRecord.receipt);
    if (!receipt || !exactKeys(receipt, ["provider", "endpoint", "requestSha256", "responseSha256", "retrievedAt", "durationMs", "httpStatus", "rowCount", "totalCount", "endOfRecords"])
      || receipt.provider !== "gbif-occurrence" || receipt.endpoint !== GBIF_OCCURRENCE_ENDPOINT
      || receipt.requestSha256 !== envelope.requestSha256 || receipt.responseSha256 !== rawOutput.sha256
      || !SHA256_RE.test(String(receipt.responseSha256 ?? "")) || typeof receipt.retrievedAt !== "string" || !Number.isFinite(Date.parse(receipt.retrievedAt))
      || !Number.isSafeInteger(receipt.durationMs) || Number(receipt.durationMs) < 0 || Number(receipt.durationMs) > 86_400_000
      || receipt.httpStatus !== 200 || receipt.rowCount !== parsed.occurrences.length || receipt.totalCount !== parsed.totalCount
      || receipt.endOfRecords !== parsed.endOfRecords || canonicalJson(storedRecord.occurrences) !== canonicalJson(parsed.occurrences)
      || canonicalJson(storedRecord.warnings) !== canonicalJson(expectedWarnings(parsed.occurrences.length, parsed.totalCount))
      || !resultBytes.equals(Buffer.from(canonicalJson(storedRecord), "utf8"))) {
      throw new Error("science-biodiversity-run-closure-invalid");
    }
    let verifiedSource: ReturnType<ScienceStore["getVerifiedJsonDatabaseSourceVersionForTool"]>;
    try {
      verifiedSource = this.store.getVerifiedJsonDatabaseSourceVersionForTool(
        projectId,
        String(storedRecord.sourceId),
        String(storedRecord.sourceVersionId),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "science-source-cas-integrity-failed") throw error;
      throw new Error("science-biodiversity-source-run-closure-invalid");
    }
    const source = verifiedSource.source;
    if (!verifiedSource.bytes.equals(rawBytes) || source.canonicalUri !== queryUrl.toString()
      || source.title !== defaultTitle(query.scientificName)
      || canonicalJson(source.authors) !== canonicalJson(["Global Biodiversity Information Facility"])
      || source.publicationYear !== null || source.publisher !== "GBIF" || source.containerTitle !== "GBIF Occurrence Store"
      || source.version.accessState !== "retrieved" || source.version.mimeType !== "application/json"
      || source.version.contentSha256 !== rawOutput.sha256 || source.version.assetRef !== `science-source-cas:sha256:${rawOutput.sha256}`
      || source.version.retrievalMethod !== "agentlas-biodiversity-catalog:gbif-occurrence@1.0.0"
      || source.version.license !== "GBIF-user-agreement-and-record-level-rights") {
      throw new Error("science-biodiversity-source-run-closure-invalid");
    }
    return {
      run,
      input,
      rawOutput,
      resultOutput,
      stored: storedRecord as unknown as StoredBiodiversityCatalogResult,
      queryUrl,
    };
  }

  private bindArtifact(closure: VerifiedCatalogClosure, artifact: ScienceArtifact): void {
    const { binding } = this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-biodiversity-run-artifact-binding:v1:${closure.run.projectId}:${closure.run.id}:${artifact.id}:${artifact.currentVersion}`),
      projectId: closure.run.projectId,
      runId: closure.run.id,
      outputOrdinal: 2,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    if (binding.outputId !== closure.resultOutput.id || binding.outputSha256 !== closure.resultOutput.sha256
      || binding.artifactId !== artifact.id || binding.artifactVersion !== artifact.currentVersion
      || binding.artifactContentSha256 !== artifact.version.contentSha256) {
      throw new Error("science-biodiversity-artifact-run-closure-invalid");
    }
  }

  private artifactForRun(closure: VerifiedCatalogClosure): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(closure.run.projectId, closure.run.id, BIODIVERSITY_MAP_LAB_ID);
    if (!artifact) return null;
    const context = this.store.getArtifactContextForProject(closure.run.projectId, artifact.id, artifact.currentVersion);
    if (!context || artifact.sourceRunId !== closure.run.id || artifact.kind !== "chart.vega" || artifact.title !== closure.stored.title
      || artifact.version.rendererId !== BIODIVERSITY_MAP_RENDERER_ID || artifact.version.rendererVersion !== BIODIVERSITY_MAP_RENDERER_VERSION
      || canonicalJson(artifact.version.payload) !== canonicalJson(biodiversityMapPayload(closure))
      || canonicalJson(artifact.version.semantic) !== canonicalJson(biodiversityMapSemantic(closure.stored))
      || canonicalJson(artifact.version.provenance) !== canonicalJson(biodiversityMapProvenance(closure))
      || context.linkage.labId !== BIODIVERSITY_MAP_LAB_ID || context.linkage.origin.surface !== "conversation"
      || context.linkage.origin.conversationId !== closure.run.conversationId || context.linkage.origin.messageId !== closure.run.originMessageId
      || context.linkage.origin.runId !== closure.run.id || context.linkage.parent !== null || context.linkage.inputs.length !== 0) {
      throw new Error("science-biodiversity-artifact-run-closure-invalid");
    }
    this.bindArtifact(closure, artifact);
    return artifact;
  }

  private createArtifact(closure: VerifiedCatalogClosure): ScienceArtifact {
    const artifact = this.store.createArtifact({
      projectId: closure.run.projectId,
      sourceRunId: closure.run.id,
      kind: "chart.vega",
      title: closure.stored.title,
      rendererId: BIODIVERSITY_MAP_RENDERER_ID,
      rendererVersion: BIODIVERSITY_MAP_RENDERER_VERSION,
      rendererBinding: null,
      payload: biodiversityMapPayload(closure),
      semantic: biodiversityMapSemantic(closure.stored),
      provenance: biodiversityMapProvenance(closure),
      linkage: {
        labId: BIODIVERSITY_MAP_LAB_ID,
        origin: {
          surface: "conversation",
          conversationId: closure.run.conversationId,
          messageId: closure.run.originMessageId,
          loopSessionId: null,
          runId: closure.run.id,
          branchId: null,
        },
        parent: null,
        inputs: [],
      },
    });
    this.bindArtifact(closure, artifact);
    return artifact;
  }

  async search(input: BiodiversityCatalogInput): Promise<BiodiversityCatalogResult> {
    const scientificName = boundedText(input.scientificName, 500, "science-biodiversity-name-invalid");
    const countryCode = input.countryCode === undefined ? null : boundedText(input.countryCode, 2, "science-biodiversity-country-invalid").toUpperCase();
    if (countryCode !== null && !/^[A-Z]{2}$/u.test(countryCode)) throw new Error("science-biodiversity-country-invalid");
    const fromYear = optionalYear(input.fromYear, "science-biodiversity-from-year-invalid");
    const toYear = optionalYear(input.toYear, "science-biodiversity-to-year-invalid");
    if (fromYear !== null && toYear !== null && fromYear > toYear) throw new Error("science-biodiversity-year-range-invalid");
    const limit = requestedLimit(input.limit);
    const title = input.title === undefined ? defaultTitle(scientificName) : boundedText(input.title, 240, "science-biodiversity-title-invalid");
    const query: BiodiversityCatalogQuery = { scientificName, countryCode, fromYear, toYear, limit, hasCoordinate: true, occurrenceStatus: "PRESENT" };
    const url = buildQueryUrl(query);
    const requestSha256 = sha256(url.toString());
    const inputEnvelope = {
      schema: "agentlas.biodiversity-catalog-query/v1",
      provider: "gbif-occurrence",
      endpoint: GBIF_OCCURRENCE_ENDPOINT,
      requestSha256,
      query,
      title,
    };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = { role: "biodiversity-query", mimeType: "application/vnd.agentlas.biodiversity-catalog-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      toolId: BIODIVERSITY_CATALOG_TOOL_ID,
      toolVersion: BIODIVERSITY_CATALOG_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "gbif-occurrence-search-v2", endpoint: GBIF_OCCURRENCE_ENDPOINT, runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed) {
      if (run.status === "running") throw new Error("science-biodiversity-run-in-progress");
      if (run.status !== "succeeded") throw new Error(`science-biodiversity-run-terminal-${run.status}`);
      const closure = this.storedResultForRun(input.projectId, run.id);
      const artifact = this.artifactForRun(closure) ?? this.createArtifact(closure);
      return { ...closure.stored, artifact, replayed: true };
    }
    if (run.status !== "running") throw new Error(`science-biodiversity-run-${run.status}`);
    let fetched: Awaited<ReturnType<typeof fetchGbif>> | null = null;
    try {
      fetched = await fetchGbif(url, this.fetchImpl);
      const responseSha256 = sha256(fetched.body);
      const parsed = parseGbifResponse(parseJson(fetched.body, "science-biodiversity-response-schema-invalid") as GbifResponse, limit);
      const receipt: BiodiversityCatalogReceipt = {
        provider: "gbif-occurrence",
        endpoint: GBIF_OCCURRENCE_ENDPOINT,
        requestSha256,
        responseSha256,
        retrievedAt: fetched.retrievedAt,
        durationMs: fetched.durationMs,
        httpStatus: fetched.status,
        rowCount: parsed.occurrences.length,
        totalCount: parsed.totalCount,
        endOfRecords: parsed.endOfRecords,
      };
      const source = this.upsertSource({
        requestId: input.requestId,
        projectId: input.projectId,
        canonicalUri: url.toString(),
        title: defaultTitle(scientificName),
        body: fetched.body,
        retrievedAt: fetched.retrievedAt,
      });
      const stored: StoredBiodiversityCatalogResult = {
        schema: "agentlas.biodiversity-catalog-result/v1",
        provider: "gbif-occurrence",
        query,
        title,
        occurrences: parsed.occurrences,
        sourceId: source.id,
        sourceVersionId: source.version.id,
        receipt,
        warnings: expectedWarnings(parsed.occurrences.length, parsed.totalCount),
        runId: run.id,
        replayed: false,
      };
      const resultBytes = Buffer.from(canonicalJson(stored), "utf8");
      if (resultBytes.length > MAX_CATALOG_RESULT_BYTES) throw new Error("science-biodiversity-catalog-result-too-large");
      const rawBlob = this.store.putRunBlob(fetched.body);
      const resultBlob = this.store.putRunBlob(resultBytes);
      const outputs = [
        { role: "provider-response", mimeType: "application/json", ...rawBlob, artifactId: null, artifactVersion: null },
        { role: "catalog-results", mimeType: "application/vnd.agentlas.biodiversity-catalog-results+json", ...resultBlob, artifactId: null, artifactVersion: null },
      ];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`),
        projectId: input.projectId,
        runId: run.id,
        status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)),
        summary: `${parsed.occurrences.length} exact coordinate-bearing GBIF occurrences retrieved for ${scientificName}.`,
        outputs,
      });
      const closure = this.storedResultForRun(input.projectId, run.id);
      const artifact = this.createArtifact(closure);
      return { ...stored, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        const failure = {
          schema: "agentlas.biodiversity-catalog-failure/v1",
          provider: "gbif-occurrence",
          endpoint: GBIF_OCCURRENCE_ENDPOINT,
          requestSha256,
          code: error instanceof Error ? error.message.slice(0, 240) : "science-biodiversity-catalog-failed",
        };
        const failureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(failure), "utf8"));
        const outputs = [
          ...(fetched ? [{ role: "provider-response", mimeType: "application/json", ...this.store.putRunBlob(fetched.body), artifactId: null, artifactVersion: null }] : []),
          { role: "provider-receipt", mimeType: "application/vnd.agentlas.biodiversity-catalog-failure+json", ...failureBlob, artifactId: null, artifactVersion: null },
        ];
        this.store.completeResearchRun({
          requestId: stableUuid(`${input.requestId}:complete`),
          projectId: input.projectId,
          runId: run.id,
          status: "failed",
          outputManifestSha256: sha256(canonicalJson(outputs)),
          summary: failure.code,
          outputs,
        });
      }
      throw error;
    }
  }
}
