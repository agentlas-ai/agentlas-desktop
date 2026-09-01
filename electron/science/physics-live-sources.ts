import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ScienceArtifact, ScienceSource } from "../../shared/science-contract";
import {
  SCIENCE_PHYSICS_HEPDATA_SOURCE_TOOL_ID,
  SCIENCE_PHYSICS_INSPIRE_SOURCE_TOOL_ID,
  SCIENCE_PHYSICS_LAB_ID,
  SCIENCE_PHYSICS_LIVE_ARTIFACT_SCHEMA,
  SCIENCE_PHYSICS_LIVE_EVIDENCE_SCHEMA,
  SCIENCE_PHYSICS_LIVE_SOURCE_TOOL_VERSION,
  SCIENCE_PHYSICS_TABLE_SCHEMA,
  sciencePhysicsSha256,
  validateSciencePhysicsLiveArtifactPayload,
  type SciencePhysicsLiveArtifactPayload,
  type SciencePhysicsLiveSourceEvidence,
  type SciencePhysicsLiveTable,
} from "../../shared/science-physics";
import { ScienceStore } from "./store";

export const INSPIRE_HEP_LITERATURE_ENDPOINT = "https://inspirehep.net/api/literature";
export const HEPDATA_RECORD_ENDPOINT = "https://www.hepdata.net/record";
export const HEPDATA_TABLE_ENDPOINT = "https://www.hepdata.net/download/table";

type JsonRecord = Record<string, unknown>;
type PhysicsScalar = string | number | boolean | null;

interface InspirePaper {
  rank: number;
  id: string;
  title: string;
  authors: string[];
  authorCount: number;
  abstract: string | null;
  dois: string[];
  arxivIds: string[];
  earliestDate: string | null;
  citationCount: number | null;
  documentTypes: string[];
  journal: { title: string | null; volume: string | null; articleId: string | null; year: number | null } | null;
  recordUrl: string | null;
}

interface InspireNormalized {
  schema: "agentlas.physics.inspire-literature/v1";
  source: { provider: "INSPIRE"; canonicalUri: string };
  resultCount: number;
  papers: InspirePaper[];
  warnings: string[];
  normalizedSha256: string;
}

interface HepDataRecordTable {
  ordinal: number;
  id: string | null;
  name: string;
  description: string | null;
  location: string | null;
  doi: string | null;
  formats: Record<string, string>;
}

interface HepDataRecordNormalized {
  schema: "agentlas.physics.hepdata-record/v1";
  source: { provider: "HEPData"; canonicalUri: string };
  recordId: string;
  version: string | null;
  title: string;
  abstract: string | null;
  collaboration: string[];
  firstAuthor: string | null;
  year: number | null;
  doi: string | null;
  hepdataDoi: string | null;
  arxivId: string | null;
  journalInfo: string | null;
  tableCount: number;
  tables: HepDataRecordTable[];
  publicUrl: string;
  normalizedSha256: string;
}

interface HepDataVariableValue {
  value: PhysicsScalar;
  low?: PhysicsScalar;
  high?: PhysicsScalar;
  errors?: Array<{ label: string | null; kind: "symmetric" | "asymmetric"; plus: PhysicsScalar; minus: PhysicsScalar }>;
}

interface HepDataTableNormalized {
  schema: "agentlas.physics.hepdata-table/v1";
  source: { provider: "HEPData"; canonicalUri: string };
  recordId: string;
  tableName: string;
  version: number | null;
  pointCount: number;
  independentVariables: Array<{ header: { name: string; units: string | null }; values: HepDataVariableValue[] }>;
  dependentVariables: Array<{
    header: { name: string; units: string | null };
    qualifiers: Array<{ name: string; value: PhysicsScalar; units: string | null }>;
    values: HepDataVariableValue[];
  }>;
  rendererProjection: {
    schema: "agentlas.physics.hepdata-renderer-series/v1";
    pointCount: number;
    independentDimensionCount: number;
    dependentSeriesCount: number;
    recommendedMark: "point" | "point-errorbar" | "heatmap" | "table";
    uncertaintyPolicy: string;
    series: Array<{
      seriesId: string;
      dependentIndex: number;
      name: string;
      units: string | null;
      qualifiers: Array<{ name: string; value: PhysicsScalar; units: string | null }>;
      points: Array<{
        ordinal: number;
        independent: Array<{
          independentIndex: number;
          name: string;
          units: string | null;
          value: PhysicsScalar;
          low: PhysicsScalar;
          high: PhysicsScalar;
          numericValue: number | null;
          numericLow: number | null;
          numericHigh: number | null;
          numericCenter: number | null;
        }>;
        value: PhysicsScalar;
        numericValue: number | null;
        errors: Array<{
          label: string | null;
          sourceKind: "symmetric" | "asymmetric";
          plusRaw: PhysicsScalar;
          minusRaw: PhysicsScalar;
          plusDelta: number | null;
          minusDelta: number | null;
          plusEndpoint: number | null;
          minusEndpoint: number | null;
          errorBarLow: number | null;
          errorBarHigh: number | null;
          relative: boolean;
          renderable: boolean;
        }>;
        renderable: boolean;
      }>;
    }>;
  };
  rendererCompatibility: Record<string, unknown>;
  normalizedBytes: number;
  normalizedSha256: string;
}

export interface PhysicsRuntime {
  buildInspireUrl(input: { query: string; limit?: number; page?: number; sort?: "relevance" | "mostrecent" | "mostcited" }): {
    input: { query: string; limit: number; page: number; sort: "relevance" | "mostrecent" | "mostcited" };
    url: string;
  };
  normalizeInspireResponse(value: unknown): InspireNormalized;
  buildHepDataRecordUrl(input: { recordId: string; version?: number; includeTables?: boolean }): {
    input: { recordId: string; version: number | null; includeTables: boolean };
    url: string;
  };
  buildHepDataTableUrl(input: { recordId: string; tableName: string; version?: number }): {
    input: { recordId: string; tableName: string; version: number | null };
    url: string;
  };
  normalizeHepDataRecord(value: unknown, requestedRecordId: string): HepDataRecordNormalized;
  normalizeHepDataTable(input: { recordId: string; tableName: string; version?: number; table: unknown }): HepDataTableNormalized;
}

export interface PhysicsInspireLiveInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  query: string;
  limit?: number;
  page?: number;
  sort?: "relevance" | "mostrecent" | "mostcited";
  title?: string;
}

export interface PhysicsInspireLiveResult {
  schema: "agentlas.science.physics-inspire-live-result/v1";
  provider: "inspire-hep";
  query: { query: string; limit: number; page: number; sort: "relevance" | "mostrecent" | "mostcited" };
  title: string;
  endpoint: string;
  responseSha256: string;
  retrievedAt: string;
  sourceId: string;
  sourceVersionId: string;
  runId: string;
  artifact: ScienceArtifact;
  replayed: boolean;
}

export interface PhysicsHepDataLiveInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  recordId: string;
  tableName: string;
  version?: number;
  title?: string;
}

export interface PhysicsHepDataLiveResult {
  schema: "agentlas.science.physics-hepdata-live-result/v1";
  provider: "hepdata";
  recordId: string;
  tableName: string;
  version: number;
  title: string;
  recordEndpoint: string;
  tableEndpoint: string;
  recordResponseSha256: string;
  tableResponseSha256: string;
  retrievedAt: string;
  recordSourceId: string;
  recordSourceVersionId: string;
  tableSourceId: string;
  tableSourceVersionId: string;
  journalDoi: string | null;
  hepdataDoi: string | null;
  tableDoi: string | null;
  recordUrl: string;
  runId: string;
  artifact: ScienceArtifact;
  replayed: boolean;
}

interface FetchedJson {
  body: Buffer;
  retrievedAt: string;
  status: number;
  receipt: SciencePhysicsLiveSourceEvidence["networkReceipts"][number];
}

const PHYSICS_NETWORK_RETRYABLE_STATUSES = [408, 429, 502, 503, 504] as const;
const PHYSICS_NETWORK_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const PHYSICS_NETWORK_RETRIES = 2;
const PHYSICS_NETWORK_RETRY_DELAY_MS = 500;
const PHYSICS_NETWORK_MAX_RETRY_AFTER_MS = 30_000;

function createRateGate(minimumIntervalMs: number): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    let release = (): void => undefined;
    const previous = tail;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, minimumIntervalMs - (Date.now() - lastStartedAt));
      if (waitMs) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      lastStartedAt = Date.now();
      return await operation();
    } finally {
      release();
    }
  };
}

const physicsNetworkGates = {
  inspire: createRateGate(350),
  hepdata: createRateGate(1_000),
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("science-physics-live-json-invalid");
  return serialized;
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }

function responseContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || raw === "") return null;
  if (!/^[0-9]+$/u.test(raw)) throw new Error("science-physics-live-response-content-length-invalid");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error("science-physics-live-response-content-length-invalid");
  return parsed;
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declared = responseContentLength(response);
  if (declared !== null && declared > PHYSICS_NETWORK_MAX_RESPONSE_BYTES) throw new Error("science-physics-live-response-size-invalid");
  const reader = response.body?.getReader();
  if (!reader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > PHYSICS_NETWORK_MAX_RESPONSE_BYTES) throw new Error("science-physics-live-response-size-invalid");
    return body;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > PHYSICS_NETWORK_MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* byte cap is already enforced */ }
      throw new Error("science-physics-live-response-size-invalid");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(PHYSICS_NETWORK_MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1_000));
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.min(PHYSICS_NETWORK_MAX_RETRY_AFTER_MS, Math.max(0, timestamp - Date.now())) : null;
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : null;
}

function loadRuntime(): PhysicsRuntime {
  const runtimePath = path.resolve(__dirname, "../../../plugins/agentlas-physics/runtime/physics.cjs");
  const runtime = createRequire(__filename)(runtimePath) as Partial<PhysicsRuntime>;
  if (typeof runtime.buildInspireUrl !== "function" || typeof runtime.normalizeInspireResponse !== "function"
    || typeof runtime.buildHepDataRecordUrl !== "function" || typeof runtime.buildHepDataTableUrl !== "function"
    || typeof runtime.normalizeHepDataRecord !== "function" || typeof runtime.normalizeHepDataTable !== "function") {
    throw new Error("science-physics-live-runtime-invalid");
  }
  return runtime as PhysicsRuntime;
}

async function fetchOfficialJson(
  url: URL,
  provider: "inspire" | "hepdata",
  outputRole: SciencePhysicsLiveSourceEvidence["networkReceipts"][number]["outputRole"],
  fetchImpl: typeof fetch,
  timeoutMs = 20_000,
): Promise<FetchedJson> {
  const valid = provider === "inspire"
    ? url.origin === "https://inspirehep.net" && url.pathname === "/api/literature"
    : url.origin === "https://www.hepdata.net" && (url.pathname.startsWith("/record/ins") || url.pathname.startsWith("/download/table/ins"));
  if (!valid || url.username || url.password) throw new Error(`science-physics-${provider}-endpoint-denied`);
  const providerId = provider === "inspire" ? "inspire-hep" : "hepdata";
  const minimumIntervalMs = provider === "inspire" ? 350 : 1_000;
  let attempts = 0;
  while (attempts <= PHYSICS_NETWORK_RETRIES) {
    attempts += 1;
    const outcome = await physicsNetworkGates[provider](async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          signal: controller.signal,
          redirect: "error",
          headers: { accept: "application/json", "user-agent": "Agentlas-Science/1.0 (physics research; https://agentlas.ai)" },
        });
        if (response.redirected || (response.url && new URL(response.url).toString() !== url.toString())) throw new Error("science-physics-live-redirect-denied");
        if (PHYSICS_NETWORK_RETRYABLE_STATUSES.includes(response.status as typeof PHYSICS_NETWORK_RETRYABLE_STATUSES[number]) && attempts <= PHYSICS_NETWORK_RETRIES) {
          try { await response.body?.cancel(); } catch { /* retry does not trust the response body */ }
          return { retry: true as const, response };
        }
        if (!response.ok) throw new Error(`science-physics-${provider}-http-${response.status}`);
        const mimeType = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim();
        if (mimeType !== "application/json") throw new Error("science-physics-live-response-mime-invalid");
        const body = await readBoundedResponse(response);
        if (body.length < 2) throw new Error("science-physics-live-response-size-invalid");
        JSON.parse(body.toString("utf8"));
        return { retry: false as const, response, body };
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new Error(`science-physics-${provider}-timeout`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
    if (outcome.retry) {
      const declaredDelay = retryAfterMs(outcome.response);
      const providerMinimum = outcome.response.status === 429 && provider === "inspire" ? 5_000 : 0;
      const fallbackDelay = Math.min(PHYSICS_NETWORK_MAX_RETRY_AFTER_MS, Math.max(providerMinimum, PHYSICS_NETWORK_RETRY_DELAY_MS * (2 ** (attempts - 1))));
      const delayMs = declaredDelay === null ? fallbackDelay : Math.max(providerMinimum, declaredDelay);
      if (delayMs) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    const retrievedAt = new Date().toISOString();
    return {
      body: outcome.body,
      retrievedAt,
      status: outcome.response.status,
      receipt: {
        schema: "agentlas.science.physics-network-receipt/v1",
        provider: providerId,
        outputRole,
        requestUrl: url.toString(),
        requestSha256: sciencePhysicsSha256({ method: "GET", url: url.toString(), accept: "application/json" }),
        responseSha256: sha256(outcome.body),
        responseBytes: outcome.body.length,
        responseStatus: outcome.response.status,
        responseContentType: "application/json",
        retrievedAt,
        attempts,
        policy: {
          timeoutMs,
          maxResponseBytes: PHYSICS_NETWORK_MAX_RESPONSE_BYTES,
          minimumIntervalMs,
          retries: PHYSICS_NETWORK_RETRIES,
          maxRetryAfterMs: PHYSICS_NETWORK_MAX_RETRY_AFTER_MS,
          retryableStatusCodes: [...PHYSICS_NETWORK_RETRYABLE_STATUSES],
          redirects: "deny",
        },
      },
    };
  }
  throw new Error(`science-physics-${provider}-retry-exhausted`);
}

function citationUrl(doi: string): string { return `https://doi.org/${doi}`; }

function dedupeCitations(citations: SciencePhysicsLiveSourceEvidence["citations"]): SciencePhysicsLiveSourceEvidence["citations"] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.kind}:${citation.doi ?? ""}:${citation.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function missingCellCount(table: SciencePhysicsLiveTable): number {
  return table.rows.reduce((count, row) => count + row.filter((cell) => cell === null).length, 0);
}

function inspireTable(normalized: InspireNormalized): SciencePhysicsLiveTable {
  return {
    schema: SCIENCE_PHYSICS_TABLE_SCHEMA,
    columns: [
      { id: "rank", label: "Rank", type: "number", unit: null },
      { id: "record_id", label: "INSPIRE record", type: "string", unit: null },
      { id: "title", label: "Title", type: "string", unit: null },
      { id: "authors", label: "Authors", type: "string", unit: null },
      { id: "dois", label: "DOIs", type: "string", unit: null },
      { id: "arxiv_ids", label: "arXiv IDs", type: "string", unit: null },
      { id: "earliest_date", label: "Earliest date", type: "string", unit: null },
      { id: "citation_count", label: "Citation count", type: "number", unit: null },
      { id: "journal", label: "Journal", type: "string", unit: null },
      { id: "record_url", label: "Record URL", type: "string", unit: null },
    ],
    rows: normalized.papers.map((paper) => [
      paper.rank,
      paper.id,
      paper.title,
      paper.authors.join("; "),
      paper.dois.length ? paper.dois.join("; ") : null,
      paper.arxivIds.length ? paper.arxivIds.join("; ") : null,
      paper.earliestDate,
      paper.citationCount,
      paper.journal ? [paper.journal.title, paper.journal.volume, paper.journal.articleId, paper.journal.year].filter((item) => item !== null).join(" · ") : null,
      paper.recordUrl,
    ]),
  };
}

function scalarJson(value: PhysicsScalar | undefined): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function finiteNumeric(value: PhysicsScalar | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function hepDataTable(normalized: HepDataTableNormalized): SciencePhysicsLiveTable {
  const rows: SciencePhysicsLiveTable["rows"] = [];
  normalized.independentVariables.forEach((variable, variableIndex) => {
    variable.values.forEach((entry, pointIndex) => rows.push([
      pointIndex + 1, "independent", variableIndex + 1, variable.header.name, variable.header.units,
      "[]", scalarJson(entry.value), finiteNumeric(entry.value),
      scalarJson(entry.low), scalarJson(entry.high), "[]",
    ]));
  });
  normalized.dependentVariables.forEach((variable, variableIndex) => {
    const qualifiersJson = canonicalJson(variable.qualifiers);
    variable.values.forEach((entry, pointIndex) => rows.push([
      pointIndex + 1, "dependent", variableIndex + 1, variable.header.name, variable.header.units,
      qualifiersJson, scalarJson(entry.value), finiteNumeric(entry.value),
      null, null, canonicalJson(entry.errors ?? []),
    ]));
  });
  if (rows.length > 50_000) throw new Error("science-physics-hepdata-projection-too-large");
  return {
    schema: SCIENCE_PHYSICS_TABLE_SCHEMA,
    columns: [
      { id: "point_index", label: "Point", type: "number", unit: null },
      { id: "role", label: "Variable role", type: "string", unit: null },
      { id: "variable_index", label: "Variable index", type: "number", unit: null },
      { id: "variable_name", label: "Variable", type: "string", unit: null },
      { id: "unit", label: "Unit", type: "string", unit: null },
      { id: "qualifiers_json", label: "Qualifiers", type: "string", unit: null },
      { id: "value_json", label: "Exact normalized value", type: "string", unit: null },
      { id: "numeric_value", label: "Numeric value", type: "number", unit: null },
      { id: "low_json", label: "Bin low", type: "string", unit: null },
      { id: "high_json", label: "Bin high", type: "string", unit: null },
      { id: "errors_json", label: "Errors", type: "string", unit: null },
    ],
    rows,
  };
}

function inspireSpec(table: SciencePhysicsLiveTable): Record<string, unknown> {
  const values = table.rows.map((row) => ({
    rank: row[0], recordId: row[1], title: row[2], citationCount: row[7], doi: row[4], recordUrl: row[9],
    tooltip: `${String(row[2])}\nINSPIRE ${String(row[1])}\nCitations: ${row[7] === null ? "missing" : String(row[7])}`,
  }));
  return {
    $schema: "https://vega.github.io/schema/vega/v5.json", width: 760, height: 380, padding: 16,
    data: [{ name: "papers", values }],
    scales: [
      { name: "x", type: "linear", domain: { data: "papers", field: "rank" }, range: "width", nice: true, zero: false },
      { name: "y", type: "sqrt", domain: { data: "papers", field: "citationCount" }, range: "height", nice: true, zero: true },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "INSPIRE result rank", tickMinStep: 1 },
      { orient: "left", scale: "y", title: "Citation count (provider value; null preserved)", grid: true },
    ],
    marks: [{
      type: "symbol", from: { data: "papers" },
      encode: { enter: { x: { scale: "x", field: "rank" }, y: { scale: "y", field: "citationCount" }, size: { value: 110 }, fill: { value: "#455A8E" }, tooltip: { field: "tooltip" } } },
    }],
  };
}

function hepDataSpec(projection: HepDataTableNormalized["rendererProjection"]): Record<string, unknown> {
  const values = projection.series.flatMap((series) => series.points.map((point) => {
    const xAxis = point.independent[0] ?? null;
    const yAxis = point.independent[1] ?? null;
    return {
      pointIndex: point.ordinal,
      series: `${series.name} [${series.units ?? "unit not reported"}]`,
      x: xAxis?.numericCenter ?? point.ordinal,
      xLow: xAxis?.numericLow ?? null,
      xHigh: xAxis?.numericHigh ?? null,
      secondAxis: yAxis?.numericCenter ?? null,
      numericValue: point.numericValue,
      renderable: point.renderable,
      tooltip: `${series.name} · point ${point.ordinal}\nvalue: ${point.value === null ? "missing" : String(point.value)}${series.units ? ` ${series.units}` : ""}`,
    };
  }));
  const uncertaintyValues = projection.series.flatMap((series) => series.points.flatMap((point) => {
    const xAxis = point.independent[0] ?? null;
    return point.errors.filter((error) => error.renderable && error.errorBarLow !== null && error.errorBarHigh !== null).map((error) => ({
      pointIndex: point.ordinal,
      series: `${series.name} [${series.units ?? "unit not reported"}]`,
      errorLabel: error.label ?? "unlabeled uncertainty",
      x: xAxis?.numericCenter ?? point.ordinal,
      yLow: error.errorBarLow,
      yHigh: error.errorBarHigh,
      tooltip: `${series.name} · ${error.label ?? "unlabeled uncertainty"}\n${error.errorBarLow} to ${error.errorBarHigh}`,
    }));
  }));
  const xTitle = projection.independentDimensionCount > 0
    ? `${projection.series[0]?.points[0]?.independent[0]?.name ?? "Independent variable"}${projection.series[0]?.points[0]?.independent[0]?.units ? ` [${projection.series[0].points[0].independent[0].units}]` : ""}`
    : "HEPData point";
  const yTitle = projection.independentDimensionCount === 2
    ? `${projection.series[0]?.points[0]?.independent[1]?.name ?? "Second independent variable"}`
    : "Reported measurement";
  if (projection.independentDimensionCount === 2) {
    return {
      $schema: "https://vega.github.io/schema/vega/v5.json", width: 760, height: 380, padding: 16,
      description: projection.uncertaintyPolicy,
      data: [{ name: "measurements", values: values.filter((value) => value.renderable) }],
      scales: [
        { name: "x", type: "linear", domain: { data: "measurements", field: "x" }, range: "width", nice: true, zero: false },
        { name: "y", type: "linear", domain: { data: "measurements", field: "secondAxis" }, range: "height", nice: true, zero: false },
        { name: "color", type: "linear", domain: { data: "measurements", field: "numericValue" }, range: { scheme: "viridis" }, zero: false },
      ],
      axes: [{ orient: "bottom", scale: "x", title: xTitle }, { orient: "left", scale: "y", title: yTitle, grid: true }],
      legends: [{ fill: "color", title: "Reported measurement" }],
      marks: [{ type: "symbol", from: { data: "measurements" }, encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "secondAxis" }, size: { value: 130 }, fill: { scale: "color", field: "numericValue" }, tooltip: { field: "tooltip" } } } }],
    };
  }
  return {
    $schema: "https://vega.github.io/schema/vega/v5.json", width: 760, height: 380, padding: 16,
    description: projection.uncertaintyPolicy,
    data: [
      { name: "measurements", values: values.filter((value) => value.renderable) },
      { name: "uncertainties", values: uncertaintyValues },
      { name: "bins", values: values.filter((value) => value.renderable && value.xLow !== null && value.xHigh !== null) },
    ],
    scales: [
      { name: "x", type: "linear", domain: { data: "measurements", field: "x" }, range: "width", nice: true, zero: false },
      { name: "y", type: "linear", domain: { data: "measurements", field: "numericValue" }, range: "height", nice: true, zero: false },
      { name: "color", type: "ordinal", domain: { data: "measurements", field: "series" }, range: { scheme: "tableau10" } },
      { name: "errorColor", type: "ordinal", domain: { data: "uncertainties", field: "errorLabel" }, range: { scheme: "dark2" } },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: xTitle, ...(projection.independentDimensionCount === 0 ? { tickMinStep: 1 } : {}) },
      { orient: "left", scale: "y", title: yTitle, grid: true },
    ],
    legends: [{ fill: "color", title: "Dependent variable" }, { stroke: "errorColor", title: "Uncertainty component" }],
    marks: [
      { type: "rule", from: { data: "bins" }, encode: { enter: { x: { scale: "x", field: "xLow" }, x2: { scale: "x", field: "xHigh" }, y: { scale: "y", field: "numericValue" }, stroke: { value: "#929292" }, strokeWidth: { value: 1 } } } },
      { type: "rule", from: { data: "uncertainties" }, encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "yLow" }, y2: { scale: "y", field: "yHigh" }, stroke: { scale: "errorColor", field: "errorLabel" }, strokeWidth: { value: 2 }, tooltip: { field: "tooltip" } } } },
      { type: "symbol", from: { data: "measurements" }, encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "numericValue" }, size: { value: 90 }, fill: { scale: "color", field: "series" }, tooltip: { field: "tooltip" } } } },
    ],
  };
}

abstract class SciencePhysicsLiveSourceBase {
  constructor(protected readonly store: ScienceStore, protected readonly fetchImpl: typeof fetch, protected readonly runtime: PhysicsRuntime) {}

  protected upsertSource(input: {
    requestId: string; projectId: string; canonicalUri: string; title: string; authors: string[]; publicationYear: number | null;
    publisher: string; containerTitle: string; abstract: string | null; body: Buffer; retrievedAt: string; retrievalMethod: string;
  }): ScienceSource {
    const contentSha256 = sha256(input.body);
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.canonicalUri);
    if (!existing) return this.store.createSource({
      requestId: stableUuid(`${input.requestId}:source:${input.canonicalUri}:${contentSha256}`), projectId: input.projectId,
      kind: "database-record", canonicalUri: input.canonicalUri, title: input.title, authors: input.authors,
      publicationYear: input.publicationYear, publisher: input.publisher, containerTitle: input.containerTitle, abstract: input.abstract,
      accessState: "retrieved", contentSha256, mimeType: "application/json", retrievedAt: input.retrievedAt,
      retrievalMethod: input.retrievalMethod, license: null,
    }, input.body).source;
    if (existing.version.contentSha256 === contentSha256 && existing.version.mimeType === "application/json") return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.canonicalUri}:${contentSha256}`), projectId: input.projectId,
      sourceId: existing.id, accessState: "retrieved", contentSha256, mimeType: "application/json", retrievedAt: input.retrievedAt,
      retrievalMethod: input.retrievalMethod, license: null,
    }, input.body).source;
  }

  protected verifyEvidenceSources(projectId: string, evidence: SciencePhysicsLiveSourceEvidence): void {
    for (const reference of evidence.sources) {
      const source = this.store.getSourceVersionForProject(projectId, reference.sourceId, reference.sourceVersionId);
      if (!source || source.canonicalUri !== reference.canonicalUri || source.version.contentSha256 !== reference.responseSha256
        || source.version.accessState !== "retrieved" || source.version.mimeType !== "application/json" || !source.version.assetRef) {
        throw new Error("science-physics-live-source-lineage-invalid");
      }
    }
  }

  protected artifactForRun(projectId: string, runId: string, outputOrdinal: number, expected: SciencePhysicsLiveArtifactPayload): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, SCIENCE_PHYSICS_LAB_ID);
    if (!artifact) return null;
    if (artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega"
      || sciencePhysicsSha256(artifact.version.payload) !== sciencePhysicsSha256(expected)) throw new Error("science-physics-live-artifact-replay-integrity-failed");
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-physics-live-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId, runId, outputOrdinal, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  protected createArtifact(input: {
    projectId: string; runId: string; outputOrdinal: number; title: string; payload: SciencePhysicsLiveArtifactPayload;
    environmentSha256: string; conversationId: string; originMessageId: string; sourceRefs: string[]; summary: string;
    entities: Array<{ id: string; label: string; type: string }>; observations: Array<{ label: string; value: string | number; unit: string | null }>;
    warnings: string[];
  }): ScienceArtifact {
    const payload = validateSciencePhysicsLiveArtifactPayload(input.payload);
    if (payload.evidence.runId !== input.runId) throw new Error("science-physics-live-run-lineage-invalid");
    this.verifyEvidenceSources(input.projectId, payload.evidence);
    const artifact = this.store.createArtifact({
      projectId: input.projectId, sourceRunId: input.runId, kind: "chart.vega", title: input.title,
      rendererId: "agentlas.vega", rendererVersion: "6.4.0", rendererBinding: null,
      payload: payload as unknown as Record<string, unknown>,
      semantic: { title: input.title, summary: input.summary, entities: input.entities, observations: input.observations, warnings: input.warnings },
      provenance: {
        sourceRunId: input.runId, sourceRefs: input.sourceRefs,
        datasetSha256: [...payload.evidence.sources.map((source) => source.responseSha256), ...payload.evidence.normalizedSha256, payload.evidence.projectionSha256],
        codeSha256: null, environmentSha256: input.environmentSha256,
      },
      linkage: {
        labId: SCIENCE_PHYSICS_LAB_ID,
        origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: input.runId, branchId: null },
        parent: null, inputs: [],
      },
    });
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-physics-live-run-artifact-binding:v1:${input.projectId}:${input.runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId: input.projectId, runId: input.runId, outputOrdinal: input.outputOrdinal,
      artifactId: artifact.id, artifactVersion: artifact.currentVersion, expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  protected failRun(projectId: string, requestId: string, runId: string, provider: "inspire-hep" | "hepdata", error: unknown): void {
    const current = this.store.getResearchRunForProject(projectId, runId);
    if (current?.status !== "running") return;
    const failure = {
      schema: "agentlas.science.physics-live-source-failure/v1", provider,
      code: error instanceof Error ? error.message.slice(0, 240) : "science-physics-live-source-failed",
    };
    const blob = this.store.putRunBlob(Buffer.from(canonicalJson(failure), "utf8"));
    const resource = { role: "provider-receipt", mimeType: "application/vnd.agentlas.science.physics-live-source-failure+json", ...blob, artifactId: null, artifactVersion: null };
    this.store.completeResearchRun({
      requestId: stableUuid(`${requestId}:complete`), projectId, runId, status: "failed",
      outputManifestSha256: sha256(canonicalJson([resource])), summary: failure.code, outputs: [resource],
    });
  }
}

export class SciencePhysicsInspireLiveService extends SciencePhysicsLiveSourceBase {
  constructor(store: ScienceStore, fetchImpl: typeof fetch = fetch, runtime: PhysicsRuntime = loadRuntime()) { super(store, fetchImpl, runtime); }

  async search(input: PhysicsInspireLiveInput): Promise<PhysicsInspireLiveResult> {
    const built = this.runtime.buildInspireUrl({ query: input.query, ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.page === undefined ? {} : { page: input.page }), ...(input.sort === undefined ? {} : { sort: input.sort }) });
    const endpoint = new URL(built.url);
    const title = optionalText(input.title, 240) ?? `INSPIRE HEP · ${built.input.query}`;
    const inputEnvelope = { schema: "agentlas.science.physics-inspire-query/v1", provider: "inspire-hep", query: built.input, endpoint: endpoint.toString(), title };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = { role: "physics-inspire-query", mimeType: "application/vnd.agentlas.science.physics-inspire-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: SCIENCE_PHYSICS_INSPIRE_SOURCE_TOOL_ID, toolVersion: SCIENCE_PHYSICS_LIVE_SOURCE_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "inspire-hep-live-source-v1", endpoint: INSPIRE_HEP_LITERATURE_ENDPOINT, runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "physics-live-result" && resource.mimeType === "application/vnd.agentlas.science.physics-inspire-live-result+json");
      if (!output) throw new Error("science-physics-inspire-replay-output-missing");
      const stored = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as Omit<PhysicsInspireLiveResult, "artifact" | "replayed"> & { projectId: string; payload: SciencePhysicsLiveArtifactPayload; warnings: string[] };
      if (stored.schema !== "agentlas.science.physics-inspire-live-result/v1" || stored.runId !== run.id || stored.projectId !== input.projectId) throw new Error("science-physics-inspire-replay-output-invalid");
      const payload = validateSciencePhysicsLiveArtifactPayload(stored.payload);
      const artifact = this.artifactForRun(input.projectId, run.id, 2, payload) ?? this.createArtifact({
        projectId: input.projectId, runId: run.id, outputOrdinal: 2, title: stored.title, payload, environmentSha256: run.environmentSha256,
        conversationId: input.conversationId, originMessageId: input.originMessageId,
        sourceRefs: payload.evidence.citations.map((citation) => citation.url),
        summary: `${payload.table.rows.length} INSPIRE HEP records preserved from exact provider bytes; DOI and record URLs remain attached.`,
        entities: payload.table.rows.slice(0, 100).map((row) => ({ id: String(row[1]), label: String(row[2]), type: "physics-literature-record" })),
        observations: [{ label: "Records", value: payload.table.rows.length, unit: null }, { label: "Missing citation counts", value: payload.table.rows.filter((row) => row[7] === null).length, unit: null }],
        warnings: stored.warnings,
      });
      const { projectId: _projectId, payload: _payload, warnings: _warnings, ...result } = stored;
      return { ...result, artifact, replayed: true };
    }
    try {
      const fetched = await fetchOfficialJson(endpoint, "inspire", "provider-response", this.fetchImpl);
      const responseSha256 = sha256(fetched.body);
      const normalized = this.runtime.normalizeInspireResponse(JSON.parse(fetched.body.toString("utf8")));
      const table = inspireTable(normalized);
      const source = this.upsertSource({
        requestId: input.requestId, projectId: input.projectId, canonicalUri: endpoint.toString(), title,
        authors: ["INSPIRE Project"], publicationYear: null, publisher: "INSPIRE", containerTitle: "INSPIRE Literature",
        abstract: `Exact INSPIRE metadata response for ${built.input.query}; discovery metadata is not experimental evidence.`,
        body: fetched.body, retrievedAt: fetched.retrievedAt, retrievalMethod: "agentlas-physics:inspire-literature@1.0.0",
      });
      const citations = dedupeCitations(normalized.papers.flatMap((paper) => [
        ...(paper.recordUrl ? [{ kind: "record" as const, doi: null, url: paper.recordUrl }] : []),
        ...paper.dois.map((doi) => ({ kind: "journal-doi" as const, doi, url: citationUrl(doi) })),
      ]));
      if (!citations.length) citations.push({ kind: "record", doi: null, url: endpoint.toString() });
      const spec = inspireSpec(table);
      const evidence: SciencePhysicsLiveSourceEvidence = {
        schema: SCIENCE_PHYSICS_LIVE_EVIDENCE_SCHEMA, provider: "inspire-hep", runId: run.id, inputSha256: inputResource.sha256,
        normalizedSha256: [normalized.normalizedSha256], projectionSha256: sciencePhysicsSha256(table), renderSha256: sciencePhysicsSha256(spec),
        projectionRowCount: table.rows.length, missingValueCount: missingCellCount(table), missingValuePolicy: "preserve-null",
        sources: [{ sourceId: source.id, sourceVersionId: source.version.id, canonicalUri: endpoint.toString(), responseSha256 }],
        networkReceipts: [fetched.receipt], citations,
      };
      const payload = validateSciencePhysicsLiveArtifactPayload({ schema: SCIENCE_PHYSICS_LIVE_ARTIFACT_SCHEMA, table, spec, evidence });
      const partial = {
        schema: "agentlas.science.physics-inspire-live-result/v1" as const, provider: "inspire-hep" as const, query: built.input, title,
        endpoint: endpoint.toString(), responseSha256, retrievedAt: fetched.retrievedAt,
        sourceId: source.id, sourceVersionId: source.version.id, runId: run.id,
      };
      const stored = { ...partial, projectId: input.projectId, payload, warnings: [...normalized.warnings, "INSPIRE results are discovery metadata and do not by themselves establish experimental support."] };
      const rawBlob = this.store.putRunBlob(fetched.body);
      const rawResource = { role: "provider-response", mimeType: "application/json", ...rawBlob, artifactId: null, artifactVersion: null };
      const resultBlob = this.store.putRunBlob(Buffer.from(canonicalJson(stored), "utf8"));
      const resultResource = { role: "physics-live-result", mimeType: "application/vnd.agentlas.science.physics-inspire-live-result+json", ...resultBlob, artifactId: null, artifactVersion: null };
      const outputs = [rawResource, resultResource];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: `${normalized.resultCount} exact INSPIRE HEP records retrieved.`, outputs,
      });
      const artifact = this.createArtifact({
        projectId: input.projectId, runId: run.id, outputOrdinal: 2, title, payload, environmentSha256: run.environmentSha256,
        conversationId: input.conversationId, originMessageId: input.originMessageId, sourceRefs: citations.map((citation) => citation.url),
        summary: `${normalized.resultCount} INSPIRE HEP records preserved from exact provider bytes; DOI and record URLs remain attached.`,
        entities: normalized.papers.slice(0, 100).map((paper) => ({ id: paper.id, label: paper.title, type: "physics-literature-record" })),
        observations: [{ label: "Records", value: normalized.resultCount, unit: null }, { label: "Missing citation counts", value: normalized.papers.filter((paper) => paper.citationCount === null).length, unit: null }],
        warnings: stored.warnings,
      });
      return { ...partial, artifact, replayed: false };
    } catch (error) {
      this.failRun(input.projectId, input.requestId, run.id, "inspire-hep", error);
      throw error;
    }
  }
}

export class SciencePhysicsHepDataLiveService extends SciencePhysicsLiveSourceBase {
  constructor(store: ScienceStore, fetchImpl: typeof fetch = fetch, runtime: PhysicsRuntime = loadRuntime()) { super(store, fetchImpl, runtime); }

  async fetchTable(input: PhysicsHepDataLiveInput): Promise<PhysicsHepDataLiveResult> {
    const recordBuilt = this.runtime.buildHepDataRecordUrl({ recordId: input.recordId, includeTables: true, ...(input.version === undefined ? {} : { version: input.version }) });
    const recordEndpoint = new URL(recordBuilt.url);
    const provisionalTitle = optionalText(input.title, 240) ?? `HEPData ${recordBuilt.input.recordId} · ${input.tableName}`;
    const inputEnvelope = { schema: "agentlas.science.physics-hepdata-table-query/v1", provider: "hepdata", recordId: recordBuilt.input.recordId, tableName: input.tableName, version: recordBuilt.input.version, recordEndpoint: recordEndpoint.toString(), title: provisionalTitle };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = { role: "physics-hepdata-table-query", mimeType: "application/vnd.agentlas.science.physics-hepdata-table-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: SCIENCE_PHYSICS_HEPDATA_SOURCE_TOOL_ID, toolVersion: SCIENCE_PHYSICS_LIVE_SOURCE_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "hepdata-version-pinned-live-table-v1", recordEndpoint: HEPDATA_RECORD_ENDPOINT, tableEndpoint: HEPDATA_TABLE_ENDPOINT, runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "physics-live-result" && resource.mimeType === "application/vnd.agentlas.science.physics-hepdata-live-result+json");
      if (!output) throw new Error("science-physics-hepdata-replay-output-missing");
      const stored = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as Omit<PhysicsHepDataLiveResult, "artifact" | "replayed"> & { projectId: string; payload: SciencePhysicsLiveArtifactPayload; warnings: string[] };
      if (stored.schema !== "agentlas.science.physics-hepdata-live-result/v1" || stored.runId !== run.id || stored.projectId !== input.projectId) throw new Error("science-physics-hepdata-replay-output-invalid");
      const payload = validateSciencePhysicsLiveArtifactPayload(stored.payload);
      const artifact = this.artifactForRun(input.projectId, run.id, 3, payload) ?? this.createArtifact({
        projectId: input.projectId, runId: run.id, outputOrdinal: 3, title: stored.title, payload, environmentSha256: run.environmentSha256,
        conversationId: input.conversationId, originMessageId: input.originMessageId, sourceRefs: payload.evidence.citations.map((citation) => citation.url),
        summary: `${payload.table.rows.length} normalized HEPData variable rows preserve exact table bytes, units, qualifiers, errors, and null measurements.`,
        entities: [{ id: `${stored.recordId}:${stored.tableName}`, label: stored.title, type: "hepdata-table" }],
        observations: [{ label: "Projection rows", value: payload.table.rows.length, unit: null }, { label: "Missing cells", value: payload.evidence.missingValueCount, unit: null }],
        warnings: stored.warnings,
      });
      const { projectId: _projectId, payload: _payload, warnings: _warnings, ...result } = stored;
      return { ...result, artifact, replayed: true };
    }
    try {
      const recordFetched = await fetchOfficialJson(recordEndpoint, "hepdata", "record-response", this.fetchImpl);
      const recordResponseSha256 = sha256(recordFetched.body);
      const normalizedRecord = this.runtime.normalizeHepDataRecord(JSON.parse(recordFetched.body.toString("utf8")), recordBuilt.input.recordId);
      const resolvedVersion = input.version ?? Number(normalizedRecord.version);
      if (!Number.isInteger(resolvedVersion) || resolvedVersion < 1 || resolvedVersion > 999 || (input.version !== undefined && String(input.version) !== normalizedRecord.version)) {
        throw new Error("science-physics-hepdata-version-unavailable");
      }
      const tableMetadata = normalizedRecord.tables.find((table) => table.name === input.tableName);
      if (!tableMetadata) throw new Error("science-physics-hepdata-table-not-found");
      const unversioned = this.runtime.buildHepDataTableUrl({ recordId: normalizedRecord.recordId, tableName: tableMetadata.name });
      const providerTableUrl = tableMetadata.formats.json ? new URL(tableMetadata.formats.json).toString() : null;
      if (!providerTableUrl || providerTableUrl !== new URL(unversioned.url).toString()) throw new Error("science-physics-hepdata-table-url-invalid");
      const tableBuilt = this.runtime.buildHepDataTableUrl({ recordId: normalizedRecord.recordId, tableName: tableMetadata.name, version: resolvedVersion });
      const tableEndpoint = new URL(tableBuilt.url);
      const tableFetched = await fetchOfficialJson(tableEndpoint, "hepdata", "table-response", this.fetchImpl);
      const tableResponseSha256 = sha256(tableFetched.body);
      const normalizedTable = this.runtime.normalizeHepDataTable({ recordId: normalizedRecord.recordId, tableName: tableMetadata.name, version: resolvedVersion, table: JSON.parse(tableFetched.body.toString("utf8")) });
      const table = hepDataTable(normalizedTable);
      const title = optionalText(input.title, 240) ?? `${normalizedRecord.title} · ${tableMetadata.name}`;
      const recordSource = this.upsertSource({
        requestId: input.requestId, projectId: input.projectId, canonicalUri: recordEndpoint.toString(), title: normalizedRecord.title,
        authors: normalizedRecord.firstAuthor ? [normalizedRecord.firstAuthor] : ["HEPData"], publicationYear: normalizedRecord.year,
        publisher: "HEPData", containerTitle: "HEPData record metadata", abstract: normalizedRecord.abstract,
        body: recordFetched.body, retrievedAt: recordFetched.retrievedAt, retrievalMethod: "agentlas-physics:hepdata-record@1.0.0",
      });
      const tableSource = this.upsertSource({
        requestId: input.requestId, projectId: input.projectId, canonicalUri: tableEndpoint.toString(), title,
        authors: normalizedRecord.firstAuthor ? [normalizedRecord.firstAuthor] : ["HEPData"], publicationYear: normalizedRecord.year,
        publisher: "HEPData", containerTitle: normalizedRecord.title,
        abstract: tableMetadata.description ?? `Exact HEPData ${tableMetadata.name} JSON body with units, qualifiers, and uncertainties.`,
        body: tableFetched.body, retrievedAt: tableFetched.retrievedAt, retrievalMethod: "agentlas-physics:hepdata-table-json@1.0.0",
      });
      const citations = dedupeCitations([
        { kind: "record", doi: null, url: normalizedRecord.publicUrl },
        ...(normalizedRecord.doi ? [{ kind: "journal-doi" as const, doi: normalizedRecord.doi, url: citationUrl(normalizedRecord.doi) }] : []),
        ...(normalizedRecord.hepdataDoi ? [{ kind: "dataset-doi" as const, doi: normalizedRecord.hepdataDoi, url: citationUrl(normalizedRecord.hepdataDoi) }] : []),
        ...(tableMetadata.doi ? [{ kind: "table-doi" as const, doi: tableMetadata.doi, url: citationUrl(tableMetadata.doi) }] : []),
        { kind: "table-download", doi: tableMetadata.doi, url: tableEndpoint.toString() },
      ]);
      const spec = hepDataSpec(normalizedTable.rendererProjection);
      const evidence: SciencePhysicsLiveSourceEvidence = {
        schema: SCIENCE_PHYSICS_LIVE_EVIDENCE_SCHEMA, provider: "hepdata", runId: run.id, inputSha256: inputResource.sha256,
        normalizedSha256: [normalizedRecord.normalizedSha256, normalizedTable.normalizedSha256], projectionSha256: sciencePhysicsSha256(table), renderSha256: sciencePhysicsSha256(spec),
        projectionRowCount: table.rows.length, missingValueCount: missingCellCount(table), missingValuePolicy: "preserve-null",
        sources: [
          { sourceId: recordSource.id, sourceVersionId: recordSource.version.id, canonicalUri: recordEndpoint.toString(), responseSha256: recordResponseSha256 },
          { sourceId: tableSource.id, sourceVersionId: tableSource.version.id, canonicalUri: tableEndpoint.toString(), responseSha256: tableResponseSha256 },
        ], networkReceipts: [recordFetched.receipt, tableFetched.receipt], citations,
      };
      const payload = validateSciencePhysicsLiveArtifactPayload({ schema: SCIENCE_PHYSICS_LIVE_ARTIFACT_SCHEMA, table, spec, evidence });
      const retrievedAt = recordFetched.retrievedAt > tableFetched.retrievedAt ? recordFetched.retrievedAt : tableFetched.retrievedAt;
      const partial = {
        schema: "agentlas.science.physics-hepdata-live-result/v1" as const, provider: "hepdata" as const,
        recordId: normalizedRecord.recordId, tableName: tableMetadata.name, version: resolvedVersion, title,
        recordEndpoint: recordEndpoint.toString(), tableEndpoint: tableEndpoint.toString(), recordResponseSha256, tableResponseSha256, retrievedAt,
        recordSourceId: recordSource.id, recordSourceVersionId: recordSource.version.id, tableSourceId: tableSource.id, tableSourceVersionId: tableSource.version.id,
        journalDoi: normalizedRecord.doi, hepdataDoi: normalizedRecord.hepdataDoi, tableDoi: tableMetadata.doi, recordUrl: normalizedRecord.publicUrl, runId: run.id,
      };
      const warnings = [
        "Missing HEPData measurements remain null; no missing value is converted to zero.",
        "Provider-side access challenges are surfaced and never bypassed.",
      ];
      const stored = { ...partial, projectId: input.projectId, payload, warnings };
      const recordBlob = this.store.putRunBlob(recordFetched.body);
      const recordResource = { role: "record-response", mimeType: "application/json", ...recordBlob, artifactId: null, artifactVersion: null };
      const tableBlob = this.store.putRunBlob(tableFetched.body);
      const tableResource = { role: "table-response", mimeType: "application/json", ...tableBlob, artifactId: null, artifactVersion: null };
      const resultBlob = this.store.putRunBlob(Buffer.from(canonicalJson(stored), "utf8"));
      const resultResource = { role: "physics-live-result", mimeType: "application/vnd.agentlas.science.physics-hepdata-live-result+json", ...resultBlob, artifactId: null, artifactVersion: null };
      const outputs = [recordResource, tableResource, resultResource];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: `${normalizedTable.pointCount} exact HEPData points retrieved from version ${resolvedVersion}.`, outputs,
      });
      const artifact = this.createArtifact({
        projectId: input.projectId, runId: run.id, outputOrdinal: 3, title, payload, environmentSha256: run.environmentSha256,
        conversationId: input.conversationId, originMessageId: input.originMessageId, sourceRefs: citations.map((citation) => citation.url),
        summary: `${normalizedTable.pointCount} HEPData points preserve exact record and table bytes, units, qualifiers, errors, DOI citations, and null measurements.`,
        entities: [{ id: `${normalizedRecord.recordId}:${tableMetadata.name}`, label: title, type: "hepdata-table" }],
        observations: [
          { label: "Points", value: normalizedTable.pointCount, unit: null },
          { label: "Independent variables", value: normalizedTable.independentVariables.length, unit: null },
          { label: "Dependent variables", value: normalizedTable.dependentVariables.length, unit: null },
          { label: "Missing cells", value: evidence.missingValueCount, unit: null },
        ], warnings,
      });
      return { ...partial, artifact, replayed: false };
    } catch (error) {
      this.failRun(input.projectId, input.requestId, run.id, "hepdata", error);
      throw error;
    }
  }
}
