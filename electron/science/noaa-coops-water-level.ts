import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceSource } from "../../shared/science-contract";
import { ScienceStore } from "./store";
import { loadSciencePluginRuntime } from "./plugin-runtime";

const NOAA_ORIGIN = "https://api.tidesandcurrents.noaa.gov";
const NOAA_PATH = "/api/prod/datagetter";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MINIMUM_INTERVAL_MS = 1_000;
const MAX_OBSERVATIONS = 7_500;
const TOOL_ID = "agentlas.noaa-coops-water-level";
const TOOL_VERSION = "1.0.0";
const LAB_ID = "data-visualization";
const RESULT_SCHEMA = "agentlas.science.noaa-coops-water-level-result/v1";
const ARTIFACT_SCHEMA = "agentlas.science.noaa-coops-water-level-artifact/v1";
const RECEIPT_SCHEMA = "agentlas.science.noaa-coops-water-level-receipt/v1";
const FAILURE_SCHEMA = "agentlas.science.noaa-coops-water-level-failure/v1";
const NORMALIZED_SCHEMA = "agentlas.earth.noaa-coops-water-level-series/v1";
const TABLE_SCHEMA = "agentlas.science-table/v1";
const EVIDENCE_SCHEMA = "agentlas.science.noaa-coops-water-level-evidence/v1";
const QUERY_MIME = "application/vnd.agentlas.science.noaa-coops-water-level-query+json";
const RECEIPT_MIME = "application/vnd.agentlas.science.noaa-coops-water-level-receipt+json";
const FAILURE_MIME = "application/vnd.agentlas.science.noaa-coops-water-level-failure+json";
const PAYLOAD_MIME = "application/vnd.agentlas.science.noaa-coops-water-level-artifact+json";
const DATUMS = new Set(["CRD", "IGLD", "LWD", "MHHW", "MHW", "MTL", "MSL", "MLW", "MLLW", "NAVD", "STND"]);

type Datum = "CRD" | "IGLD" | "LWD" | "MHHW" | "MHW" | "MTL" | "MSL" | "MLW" | "MLLW" | "NAVD" | "STND";
type Units = "metric" | "english";
type Query = { stationId: string; startTime: string; endTime: string; datum: Datum; units: Units; product: "water_level"; timeZone: "gmt" };
type Observation = { time: string; value: number | null; standardDeviation: number | null; quality: "preliminary" | "verified" | null; flags: string[] };
type Station = { id: string; name: string; longitude: number; latitude: number; coordinateReferenceSystem: "EPSG:4326" };
type Measurement = { phenomenon: "water-level"; valueUnit: "m" | "ft"; verticalDatum: Datum; timeZone: "UTC"; samplingInterval: "provider-observed" };
type Column = { id: string; label: string; type: string; unit: string | null };
type Table = { schema: typeof TABLE_SCHEMA; columns: Column[]; rows: Array<Array<string | number | null>> };
type ContentReceipt = { schema: "agentlas.science-content-receipt/v1"; role: string; mimeType: string; bytes: number; sha256: string };

type Normalized = {
  schema: typeof NORMALIZED_SCHEMA;
  source: { provider: string; collection: string; canonicalUri: string; endpoint: string };
  query: Omit<Query, "product" | "timeZone">;
  station: Station;
  measurement: Measurement;
  observationCount: number;
  observations: Observation[];
  stationGeojson: Record<string, unknown>;
  table: Table;
  vegaLite: Record<string, unknown>;
  contentReceipts: { stationGeojson: ContentReceipt; observationTable: ContentReceipt; timeSeriesFigure: ContentReceipt };
  rendererCompatibility: Record<string, unknown>;
  warnings: string[];
  normalizedSha256: string;
};

type EarthRuntime = {
  buildNoaaCoopsWaterLevelUrl(input: { stationId: string; startTime: string; endTime: string; datum: string; units: string }): {
    input: { stationId: string; startTime: string; endTime: string; datum: Datum; units: Units };
    url: string;
  };
  normalizeNoaaCoopsWaterLevel(raw: unknown, query: Omit<Query, "product" | "timeZone">): unknown;
};

type ArtifactPayload = {
  schema: typeof ARTIFACT_SCHEMA;
  table: Table;
  spec: Record<string, unknown>;
  evidence: {
    schema: typeof EVIDENCE_SCHEMA;
    runId: string;
    query: Query;
    station: Station;
    measurement: Measurement;
    source: { id: string; versionId: string; canonicalUri: string };
    request: { method: "GET"; url: string; sha256: string };
    response: { sha256: string; byteSize: number; mimeType: "application/json"; httpStatus: number; retrievedAt: string };
    network: {
      redirectPolicy: "deny";
      timeoutMs: number;
      maxResponseBytes: number;
      minimumIntervalMs: number;
      waitedMs: number;
      attempts: 1;
    };
    normalization: {
      schema: typeof NORMALIZED_SCHEMA;
      sha256: string;
      rowCount: number;
      missingValueCount: number;
      preliminaryCount: number;
      missingValuePolicy: "preserve-null";
      contentReceipts: Normalized["contentReceipts"];
      warnings: string[];
    };
  };
};

type NoaaReceipt = Omit<ArtifactPayload["evidence"], "schema" | "response"> & {
  schema: typeof RECEIPT_SCHEMA;
  provider: "noaa-coops";
  response: ArtifactPayload["evidence"]["response"] & { durationMs: number };
};

export interface ScienceNoaaCoopsWaterLevelInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  stationId: string;
  startTime: string;
  endTime: string;
  datum: Datum;
  units?: Units;
  title?: string;
}

export interface ScienceNoaaCoopsWaterLevelResult {
  schema: typeof RESULT_SCHEMA;
  provider: "noaa-coops";
  query: Query;
  title: string;
  sourceId: string;
  sourceVersionId: string;
  receipt: NoaaReceipt;
  artifact: ScienceArtifact;
  runId: string;
  replayed: boolean;
}

type Fetched = {
  body: Buffer;
  status: number;
  mimeType: string;
  ok: boolean;
  retrievedAt: string;
  durationMs: number;
  waitedMs: number;
};

type ServiceOptions = {
  clockMs?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  minimumIntervalMs?: number;
  timeoutMs?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().flatMap((key) => object[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(object[key])}`]).join(",")}}`;
  }
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function text(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return value.trim();
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(code);
  return Number(value);
}

function finite(value: unknown, minimum: number, maximum: number, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(code);
  return Object.is(value, -0) ? 0 : value;
}

function optionalFinite(value: unknown, minimum: number, maximum: number, code: string): number | null {
  return value === null ? null : finite(value, minimum, maximum, code);
}

function optionalTitle(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, 240, "science-noaa-coops-title-invalid");
}

function iso(value: unknown, code: string): string {
  const raw = text(value, 80, code);
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis) || !/(?:Z|[+-]\d\d:\d\d)$/u.test(raw)) throw new Error(code);
  return new Date(millis).toISOString();
}

function validateNoaaUrl(value: unknown, query?: Query): string {
  const raw = text(value, 4_000, "science-noaa-coops-endpoint-invalid");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("science-noaa-coops-endpoint-invalid"); }
  const names = [...url.searchParams.keys()];
  const expected = ["application", "begin_date", "datum", "end_date", "format", "product", "station", "time_zone", "units"];
  if (url.origin !== NOAA_ORIGIN || url.pathname !== NOAA_PATH || url.username || url.password || url.port || url.hash
    || canonicalJson(names) !== canonicalJson(expected) || new Set(names).size !== names.length
    || url.searchParams.get("application") !== "AgentlasEarthScience" || url.searchParams.get("format") !== "json"
    || url.searchParams.get("product") !== "water_level" || url.searchParams.get("time_zone") !== "gmt") {
    throw new Error("science-noaa-coops-endpoint-denied");
  }
  if (query && (url.searchParams.get("station") !== query.stationId || url.searchParams.get("datum") !== query.datum
    || url.searchParams.get("units") !== query.units)) throw new Error("science-noaa-coops-request-query-mismatch");
  return url.toString();
}

function validateContentReceipt(value: unknown, expectedRole: string, expectedMime: string, content: unknown): ContentReceipt {
  const item = record(value);
  const serialized = canonicalJson(content);
  if (!item || item.schema !== "agentlas.science-content-receipt/v1" || item.role !== expectedRole || item.mimeType !== expectedMime
    || item.bytes !== Buffer.byteLength(serialized, "utf8") || item.sha256 !== sha256(serialized)) {
    throw new Error("science-noaa-coops-content-receipt-invalid");
  }
  return item as ContentReceipt;
}

function validateNormalized(value: unknown, expectedQuery: Query): Normalized {
  const normalized = record(value);
  if (!normalized || normalized.schema !== NORMALIZED_SCHEMA || !Array.isArray(normalized.observations)
    || normalized.observations.length > MAX_OBSERVATIONS || normalized.observationCount !== normalized.observations.length) {
    throw new Error("science-noaa-coops-normalized-invalid");
  }
  const query = record(normalized.query);
  if (!query || canonicalJson(query) !== canonicalJson({
    stationId: expectedQuery.stationId, startTime: expectedQuery.startTime, endTime: expectedQuery.endTime,
    datum: expectedQuery.datum, units: expectedQuery.units,
  })) throw new Error("science-noaa-coops-normalized-query-mismatch");
  const stationValue = record(normalized.station);
  if (!stationValue || stationValue.id !== expectedQuery.stationId || stationValue.coordinateReferenceSystem !== "EPSG:4326") {
    throw new Error("science-noaa-coops-station-invalid");
  }
  const station: Station = {
    id: text(stationValue.id, 7, "science-noaa-coops-station-invalid"),
    name: text(stationValue.name, 500, "science-noaa-coops-station-invalid"),
    longitude: finite(stationValue.longitude, -180, 180, "science-noaa-coops-station-invalid"),
    latitude: finite(stationValue.latitude, -90, 90, "science-noaa-coops-station-invalid"),
    coordinateReferenceSystem: "EPSG:4326",
  };
  if (!/^\d{7}$/u.test(station.id)) throw new Error("science-noaa-coops-station-invalid");
  const measurementValue = record(normalized.measurement);
  const valueUnit = expectedQuery.units === "metric" ? "m" : "ft";
  if (!measurementValue || canonicalJson(measurementValue) !== canonicalJson({
    phenomenon: "water-level", valueUnit, verticalDatum: expectedQuery.datum, timeZone: "UTC", samplingInterval: "provider-observed",
  })) throw new Error("science-noaa-coops-measurement-invalid");
  const rawObservations = normalized.observations as unknown[];
  let previousTime: string | null = null;
  const observations: Observation[] = rawObservations.map((entry) => {
    const observation = record(entry);
    if (!observation || !Array.isArray(observation.flags) || observation.flags.some((flag) => typeof flag !== "string" || !/^[0-9A-Za-z-]{1,16}$/u.test(flag))) {
      throw new Error("science-noaa-coops-observation-invalid");
    }
    const time = iso(observation.time, "science-noaa-coops-observation-invalid");
    if (Date.parse(time) < Date.parse(expectedQuery.startTime) || Date.parse(time) > Date.parse(expectedQuery.endTime)
      || (previousTime !== null && time <= previousTime)) {
      throw new Error("science-noaa-coops-observation-order-invalid");
    }
    previousTime = time;
    const quality = observation.quality;
    if (quality !== null && quality !== "preliminary" && quality !== "verified") throw new Error("science-noaa-coops-observation-invalid");
    return {
      time,
      value: optionalFinite(observation.value, -100_000, 100_000, "science-noaa-coops-observation-invalid"),
      standardDeviation: optionalFinite(observation.standardDeviation, 0, 100_000, "science-noaa-coops-observation-invalid"),
      quality,
      flags: [...observation.flags] as string[],
    };
  });
  const tableValue = record(normalized.table);
  if (!tableValue || tableValue.schema !== TABLE_SCHEMA || !Array.isArray(tableValue.columns) || !Array.isArray(tableValue.rows)
    || canonicalJson(tableValue.rows) !== canonicalJson(observations.map((item) => [item.time, item.value, item.standardDeviation, item.quality, item.flags.join(",")]))) {
    throw new Error("science-noaa-coops-table-invalid");
  }
  const table = tableValue as Table;
  const stationGeojson = record(normalized.stationGeojson);
  const vegaLite = record(normalized.vegaLite);
  const receipts = record(normalized.contentReceipts);
  if (!stationGeojson || !vegaLite || !receipts) throw new Error("science-noaa-coops-content-invalid");
  const contentReceipts = {
    stationGeojson: validateContentReceipt(receipts.stationGeojson, "station-geojson", "application/geo+json", stationGeojson),
    observationTable: validateContentReceipt(receipts.observationTable, "water-level-observation-table", "application/vnd.agentlas.science-table+json", table),
    timeSeriesFigure: validateContentReceipt(receipts.timeSeriesFigure, "water-level-time-series", "application/vnd.vegalite.v5+json", vegaLite),
  };
  if (!Array.isArray(normalized.warnings) || normalized.warnings.some((warning) => typeof warning !== "string" || warning.length > 2_000)) {
    throw new Error("science-noaa-coops-warning-invalid");
  }
  const withoutHash = { ...normalized };
  delete withoutHash.normalizedSha256;
  if (normalized.normalizedSha256 !== sha256(canonicalJson(withoutHash))) throw new Error("science-noaa-coops-normalization-hash-invalid");
  return {
    ...(normalized as unknown as Normalized), station, observations, table, stationGeojson, vegaLite, contentReceipts,
    measurement: measurementValue as Measurement, warnings: [...normalized.warnings] as string[],
  };
}

function createVegaSpec(rows: Table["rows"], title: string, datum: Datum, valueUnit: string): Record<string, unknown> {
  const values = rows.map((row) => ({
    time: row[0], waterLevel: row[1], standardDeviation: row[2], quality: row[3], flags: row[4], defined: row[1] !== null,
    tooltip: row[1] === null ? `${row[0]}: missing` : `${row[0]}: ${row[1]} ${valueUnit} (${datum})`,
  }));
  const observed = values.filter((row) => row.defined);
  return {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    description: `NOAA CO-OPS observed water level relative to ${datum}; missing values remain null and no interpolation or prediction is applied.`,
    width: 720, height: 360, padding: 12,
    autosize: { type: "fit", contains: "padding", resize: true },
    title: { text: title, anchor: "middle", fontSize: 16, offset: 12 },
    data: [{ name: "table", values }, { name: "observed", values: observed }],
    scales: [
      { name: "x", type: "time", range: "width", domain: { data: "table", field: "time" } },
      { name: "y", type: "linear", range: "height", domain: { data: "observed", field: "waterLevel" }, nice: true, zero: false },
      { name: "quality", type: "ordinal", domain: ["verified", "preliminary", null], range: ["#2563eb", "#d97706", "#64748b"] },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "UTC", format: "%Y-%m-%d %H:%M", labelOverlap: true },
      { orient: "left", scale: "y", title: `Water level (${valueUnit}, ${datum})`, grid: true, tickCount: 6 },
    ],
    marks: [
      { type: "line", from: { data: "table" }, encode: { enter: {
        x: { scale: "x", field: "time" }, y: { scale: "y", field: "waterLevel" }, defined: { field: "defined" },
        stroke: { value: "#2563eb" }, strokeWidth: { value: 2.25 },
      } } },
      { type: "symbol", from: { data: "observed" }, encode: {
        enter: {
          x: { scale: "x", field: "time" }, y: { scale: "y", field: "waterLevel" },
          fill: { scale: "quality", field: "quality" }, stroke: { value: "#ffffff" }, strokeWidth: { value: 1.5 },
          size: { value: 54 }, tooltip: { field: "tooltip" },
        },
        hover: { size: { value: 120 }, strokeWidth: { value: 2.5 } },
      } },
    ],
  };
}

function validatePayload(value: unknown): ArtifactPayload {
  let serialized = "";
  try { serialized = JSON.stringify(value); } catch { throw new Error("science-noaa-coops-artifact-invalid"); }
  if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) throw new Error("science-noaa-coops-artifact-size-limit");
  const payload = record(value);
  const evidence = record(payload?.evidence);
  const query = record(evidence?.query);
  const station = record(evidence?.station);
  const measurement = record(evidence?.measurement);
  const source = record(evidence?.source);
  const request = record(evidence?.request);
  const response = record(evidence?.response);
  const network = record(evidence?.network);
  const normalization = record(evidence?.normalization);
  const table = record(payload?.table);
  const spec = record(payload?.spec);
  if (!payload || payload.schema !== ARTIFACT_SCHEMA || !evidence || evidence.schema !== EVIDENCE_SCHEMA || !query || !station
    || !measurement || !source || !request || !response || !network || !normalization || !table || !spec || table.schema !== TABLE_SCHEMA
    || !Array.isArray(table.columns) || !Array.isArray(table.rows) || table.rows.length > MAX_OBSERVATIONS) {
    throw new Error("science-noaa-coops-artifact-invalid");
  }
  const normalizedQuery: Query = {
    stationId: text(query.stationId, 7, "science-noaa-coops-artifact-query-invalid"),
    startTime: iso(query.startTime, "science-noaa-coops-artifact-query-invalid"),
    endTime: iso(query.endTime, "science-noaa-coops-artifact-query-invalid"),
    datum: text(query.datum, 8, "science-noaa-coops-artifact-query-invalid") as Datum,
    units: text(query.units, 16, "science-noaa-coops-artifact-query-invalid") as Units,
    product: query.product as "water_level",
    timeZone: query.timeZone as "gmt",
  };
  if (!/^\d{7}$/u.test(normalizedQuery.stationId) || !DATUMS.has(normalizedQuery.datum)
    || !["metric", "english"].includes(normalizedQuery.units) || normalizedQuery.product !== "water_level" || normalizedQuery.timeZone !== "gmt"
    || Date.parse(normalizedQuery.startTime) >= Date.parse(normalizedQuery.endTime)) throw new Error("science-noaa-coops-artifact-query-invalid");
  const url = validateNoaaUrl(request.url, normalizedQuery);
  if (request.method !== "GET" || request.sha256 !== sha256(canonicalJson({ method: "GET", url, headers: { accept: "application/json" } }))) {
    throw new Error("science-noaa-coops-request-receipt-invalid");
  }
  if (source.canonicalUri !== url || typeof source.id !== "string" || typeof source.versionId !== "string") throw new Error("science-noaa-coops-source-invalid");
  if (response.mimeType !== "application/json" || typeof response.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(response.sha256)
    || integer(response.byteSize, 2, MAX_RESPONSE_BYTES, "science-noaa-coops-response-invalid") < 2
    || integer(response.httpStatus, 200, 299, "science-noaa-coops-response-invalid") < 200
    || !Number.isFinite(Date.parse(text(response.retrievedAt, 80, "science-noaa-coops-response-invalid")))) {
    throw new Error("science-noaa-coops-response-invalid");
  }
  if (network.redirectPolicy !== "deny" || network.maxResponseBytes !== MAX_RESPONSE_BYTES || network.attempts !== 1
    || integer(network.timeoutMs, 1, 120_000, "science-noaa-coops-network-invalid") < 1
    || integer(network.minimumIntervalMs, 0, 60_000, "science-noaa-coops-network-invalid") < 0
    || integer(network.waitedMs, 0, 60_000, "science-noaa-coops-network-invalid") < 0) throw new Error("science-noaa-coops-network-invalid");
  if (normalization.schema !== NORMALIZED_SCHEMA || normalization.rowCount !== table.rows.length
    || normalization.missingValuePolicy !== "preserve-null" || typeof normalization.sha256 !== "string"
    || !Array.isArray(normalization.warnings)) throw new Error("science-noaa-coops-normalization-invalid");
  const title = text(record(spec.title)?.text, 240, "science-noaa-coops-title-invalid");
  if (canonicalJson(spec) !== canonicalJson(createVegaSpec(table.rows as Table["rows"], title, normalizedQuery.datum, normalizedQuery.units === "metric" ? "m" : "ft"))) {
    throw new Error("science-noaa-coops-vega-invalid");
  }
  return payload as unknown as ArtifactPayload;
}

function parseReceipt(value: unknown, payload: ArtifactPayload): ScienceNoaaCoopsWaterLevelResult["receipt"] {
  const receipt = record(value);
  const response = record(receipt?.response);
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA || receipt.provider !== "noaa-coops" || !response) {
    throw new Error("science-noaa-coops-replay-receipt-invalid");
  }
  const expected: NoaaReceipt = {
    ...payload.evidence,
    schema: RECEIPT_SCHEMA,
    provider: "noaa-coops" as const,
    response: { ...payload.evidence.response, durationMs: integer(response.durationMs, 0, 86_400_000, "science-noaa-coops-replay-receipt-invalid") },
  };
  if (canonicalJson(receipt) !== canonicalJson(expected)) throw new Error("science-noaa-coops-replay-receipt-invalid");
  return expected;
}

function loadRuntime(): EarthRuntime {
  const loaded = loadSciencePluginRuntime<Partial<EarthRuntime>>("agentlas-earth-science", "runtime/earth-science.cjs", 16 * 1024 * 1024);
  if (typeof loaded.runtime.buildNoaaCoopsWaterLevelUrl !== "function" || typeof loaded.runtime.normalizeNoaaCoopsWaterLevel !== "function") {
    throw new Error("science-noaa-coops-runtime-invalid");
  }
  return loaded.runtime as EarthRuntime;
}

export class ScienceNoaaCoopsWaterLevelService {
  private readonly runtime: EarthRuntime;
  private readonly clockMs: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly minimumIntervalMs: number;
  private readonly timeoutMs: number;
  private requestQueue: Promise<unknown> = Promise.resolve();
  private nextAllowedRequestAt = 0;

  constructor(private readonly store: ScienceStore, private readonly fetchImpl: typeof fetch = fetch, options: ServiceOptions = {}, runtime?: EarthRuntime) {
    this.runtime = runtime ?? loadRuntime();
    this.clockMs = options.clockMs ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.minimumIntervalMs = integer(options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS, 0, 60_000, "science-noaa-coops-rate-invalid");
    this.timeoutMs = integer(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 120_000, "science-noaa-coops-timeout-invalid");
  }

  private scheduleFetch(url: URL): Promise<Fetched> {
    const scheduled = this.requestQueue.then(async () => {
      const waitedMs = Math.max(0, this.nextAllowedRequestAt - this.clockMs());
      if (waitedMs > 0) await this.sleep(waitedMs);
      const started = this.clockMs();
      this.nextAllowedRequestAt = started + this.minimumIntervalMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          signal: controller.signal,
          redirect: "error",
          headers: { accept: "application/json", "user-agent": "Agentlas-Science/1.0 (NOAA CO-OPS water-level research; https://agentlas.ai)" },
        });
        if (response.redirected || (response.url && response.url !== url.toString())) throw new Error("science-noaa-coops-redirect-denied");
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("science-noaa-coops-response-size-invalid");
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length < 2 || body.length > MAX_RESPONSE_BYTES) throw new Error("science-noaa-coops-response-size-invalid");
        return {
          body,
          status: response.status,
          mimeType: (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim(),
          ok: response.ok,
          retrievedAt: new Date(this.clockMs()).toISOString(),
          durationMs: Math.max(0, this.clockMs() - started),
          waitedMs,
        };
      } finally {
        clearTimeout(timer);
      }
    });
    this.requestQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  private upsertSource(input: { requestId: string; projectId: string; canonicalUri: string; title: string; body: Buffer; retrievedAt: string }): ScienceSource {
    const contentSha256 = sha256(input.body);
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.canonicalUri);
    if (!existing) return this.store.createSource({
      requestId: stableUuid(`${input.requestId}:source:${input.canonicalUri}:${contentSha256}`),
      projectId: input.projectId,
      kind: "database-record",
      canonicalUri: input.canonicalUri,
      title: input.title,
      authors: ["NOAA Center for Operational Oceanographic Products and Services"],
      publicationYear: null,
      publisher: "NOAA",
      containerTitle: "CO-OPS Data API",
      abstract: "Exact NOAA CO-OPS water_level response bytes. Times are requested in GMT; missing observations remain null without interpolation.",
      accessState: "retrieved",
      contentSha256,
      mimeType: "application/json",
      retrievedAt: input.retrievedAt,
      retrievalMethod: "agentlas-earth-science:noaa-coops-water-level@1.0.0",
      license: "U.S. Government public data",
    }, input.body).source;
    if (existing.version.contentSha256 === contentSha256 && existing.version.mimeType === "application/json") return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.canonicalUri}:${contentSha256}`),
      projectId: input.projectId,
      sourceId: existing.id,
      accessState: "retrieved",
      contentSha256,
      mimeType: "application/json",
      retrievedAt: input.retrievedAt,
      retrievalMethod: "agentlas-earth-science:noaa-coops-water-level@1.0.0",
      license: "U.S. Government public data",
    }, input.body).source;
  }

  private assertRunClosure(projectId: string, payload: ArtifactPayload): void {
    const run = this.store.getResearchRunForProject(projectId, payload.evidence.runId);
    const raw = run?.outputs[0];
    const receipt = run?.outputs[1];
    const artifactPayload = run?.outputs[2];
    if (!run || run.status !== "succeeded" || run.toolId !== TOOL_ID || run.toolVersion !== TOOL_VERSION
      || run.inputs.length !== 1 || run.inputs[0]?.role !== "water-level-query" || run.inputs[0]?.mimeType !== QUERY_MIME
      || run.outputs.length !== 3 || raw?.role !== "provider-response" || raw.mimeType !== "application/json"
      || receipt?.role !== "provider-receipt" || receipt.mimeType !== RECEIPT_MIME
      || artifactPayload?.role !== "water-level-artifact-payload" || artifactPayload.mimeType !== PAYLOAD_MIME) {
      throw new Error("science-noaa-coops-run-closure-invalid");
    }
    const payloadBytes = Buffer.from(canonicalJson(payload), "utf8");
    if (raw.sha256 !== payload.evidence.response.sha256 || raw.byteSize !== payload.evidence.response.byteSize
      || sha256(this.store.readRunBlob(raw)) !== payload.evidence.response.sha256
      || artifactPayload.sha256 !== sha256(payloadBytes) || !this.store.readRunBlob(artifactPayload).equals(payloadBytes)) {
      throw new Error("science-noaa-coops-run-closure-invalid");
    }
    const source = this.store.getSourceVersionForProject(projectId, payload.evidence.source.id, payload.evidence.source.versionId);
    if (!source || source.canonicalUri !== payload.evidence.source.canonicalUri || source.version.accessState !== "retrieved"
      || source.version.mimeType !== "application/json" || source.version.contentSha256 !== payload.evidence.response.sha256
      || source.version.assetRef !== `science-source-cas:sha256:${payload.evidence.response.sha256}`) {
      throw new Error("science-noaa-coops-source-run-closure-invalid");
    }
    parseReceipt(JSON.parse(this.store.readRunBlob(receipt).toString("utf8")), payload);
  }

  private artifactForRun(projectId: string, runId: string): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, LAB_ID);
    if (!artifact) return null;
    const payload = validatePayload(artifact.version.payload);
    if (payload.evidence.runId !== runId) throw new Error("science-noaa-coops-artifact-run-mismatch");
    this.assertRunClosure(projectId, payload);
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-noaa-coops-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId, runId, outputOrdinal: 3, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  private createArtifact(input: { projectId: string; conversationId: string; originMessageId: string; runId: string; environmentSha256: string; payload: ArtifactPayload }): ScienceArtifact {
    const payload = validatePayload(input.payload);
    this.assertRunClosure(input.projectId, payload);
    const title = text(record(payload.spec.title)?.text, 240, "science-noaa-coops-title-invalid");
    const artifact = this.store.createArtifact({
      projectId: input.projectId,
      sourceRunId: input.runId,
      kind: "chart.vega",
      title,
      rendererId: "agentlas.vega",
      rendererVersion: "6.4.0",
      rendererBinding: null,
      payload: payload as unknown as Record<string, unknown>,
      semantic: {
        title,
        summary: `${payload.table.rows.length} exact NOAA CO-OPS water-level observations at station ${payload.evidence.station.id}; no interpolation or prediction.`,
        entities: [{ id: payload.evidence.station.id, label: payload.evidence.station.name, type: "noaa-coops-station" }],
        observations: [
          { label: "Rows", value: payload.table.rows.length, unit: null },
          { label: "Missing values", value: payload.evidence.normalization.missingValueCount, unit: null },
          { label: "Preliminary observations", value: payload.evidence.normalization.preliminaryCount, unit: null },
          { label: "Longitude", value: payload.evidence.station.longitude, unit: "degrees" },
          { label: "Latitude", value: payload.evidence.station.latitude, unit: "degrees" },
        ],
        warnings: payload.evidence.normalization.warnings,
      },
      provenance: {
        sourceRunId: input.runId,
        sourceRefs: [payload.evidence.source.canonicalUri],
        datasetSha256: [payload.evidence.response.sha256, payload.evidence.normalization.sha256],
        codeSha256: null,
        environmentSha256: input.environmentSha256,
      },
      linkage: {
        labId: LAB_ID,
        origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: input.runId, branchId: null },
        parent: null,
        inputs: [],
      },
    });
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-noaa-coops-run-artifact-binding:v1:${input.projectId}:${input.runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId: input.projectId, runId: input.runId, outputOrdinal: 3, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  async retrieve(input: ScienceNoaaCoopsWaterLevelInput): Promise<ScienceNoaaCoopsWaterLevelResult> {
    const requestedTitle = optionalTitle(input.title);
    const built = this.runtime.buildNoaaCoopsWaterLevelUrl({
      stationId: input.stationId, startTime: input.startTime, endTime: input.endTime, datum: input.datum, units: input.units ?? "metric",
    });
    const query: Query = { ...built.input, product: "water_level", timeZone: "gmt" };
    const builtUrl = validateNoaaUrl(built.url, query);
    const requestDescriptor = { method: "GET" as const, url: builtUrl, headers: { accept: "application/json" } };
    const requestSha256 = sha256(canonicalJson(requestDescriptor));
    const inputEnvelope = {
      schema: "agentlas.science.noaa-coops-water-level-query/v1",
      provider: "noaa-coops",
      query,
      request: { method: "GET", url: builtUrl, sha256: requestSha256 },
      title: requestedTitle,
      network: { redirectPolicy: "deny", timeoutMs: this.timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES, minimumIntervalMs: this.minimumIntervalMs, attempts: 1 },
      missingValuePolicy: "preserve-null",
    };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = { role: "water-level-query", mimeType: QUERY_MIME, ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      toolId: TOOL_ID,
      toolVersion: TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({
        policy: "noaa-coops-exact-bytes-no-redirect-rate-limited-preserve-null-v1",
        plugin: "agentlas-earth-science@1.0.0",
        endpoint: NOAA_ORIGIN,
        runtime: process.version,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        minimumIntervalMs: this.minimumIntervalMs,
      })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "failed") {
      const failureOutput = run.outputs.find((item) => item.role === "provider-receipt" && item.mimeType === FAILURE_MIME);
      const failure = failureOutput ? record(JSON.parse(this.store.readRunBlob(failureOutput).toString("utf8"))) : null;
      throw new Error(typeof failure?.code === "string" ? failure.code : "science-noaa-coops-prior-run-failed");
    }
    if (created.replayed && run.status === "running") throw new Error("science-noaa-coops-run-in-progress");
    if (created.replayed && run.status === "succeeded") {
      const payloadOutput = run.outputs.find((item) => item.role === "water-level-artifact-payload" && item.mimeType === PAYLOAD_MIME);
      const receiptOutput = run.outputs.find((item) => item.role === "provider-receipt" && item.mimeType === RECEIPT_MIME);
      if (!payloadOutput || !receiptOutput) throw new Error("science-noaa-coops-replay-output-missing");
      const payload = validatePayload(JSON.parse(this.store.readRunBlob(payloadOutput).toString("utf8")));
      if (payload.evidence.runId !== run.id || canonicalJson(payload.evidence.query) !== canonicalJson(query)) throw new Error("science-noaa-coops-replay-output-invalid");
      const receipt = parseReceipt(JSON.parse(this.store.readRunBlob(receiptOutput).toString("utf8")), payload);
      const artifact = this.artifactForRun(input.projectId, run.id) ?? this.createArtifact({
        projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
        runId: run.id, environmentSha256: run.environmentSha256, payload,
      });
      return {
        schema: RESULT_SCHEMA, provider: "noaa-coops", query, title: artifact.title,
        sourceId: payload.evidence.source.id, sourceVersionId: payload.evidence.source.versionId,
        receipt, artifact, runId: run.id, replayed: true,
      };
    }

    let fetched: Fetched | null = null;
    try {
      fetched = await this.scheduleFetch(new URL(builtUrl));
      if (!fetched.ok) throw new Error(`science-noaa-coops-http-${fetched.status}`);
      if (fetched.mimeType !== "application/json") throw new Error("science-noaa-coops-response-mime-invalid");
      let raw: unknown;
      try { raw = JSON.parse(fetched.body.toString("utf8")); } catch { throw new Error("science-noaa-coops-response-json-invalid"); }
      const normalized = validateNormalized(this.runtime.normalizeNoaaCoopsWaterLevel(raw, built.input), query);
      const title = requestedTitle ?? `${normalized.station.name} · NOAA water level · ${query.datum}`;
      const responseSha256 = sha256(fetched.body);
      const source = this.upsertSource({ requestId: input.requestId, projectId: input.projectId, canonicalUri: builtUrl, title, body: fetched.body, retrievedAt: fetched.retrievedAt });
      const missingValueCount = normalized.observations.filter((item) => item.value === null).length;
      const preliminaryCount = normalized.observations.filter((item) => item.quality === "preliminary").length;
      const payload = validatePayload({
        schema: ARTIFACT_SCHEMA,
        table: normalized.table,
        spec: createVegaSpec(normalized.table.rows, title, query.datum, normalized.measurement.valueUnit),
        evidence: {
          schema: EVIDENCE_SCHEMA,
          runId: run.id,
          query,
          station: normalized.station,
          measurement: normalized.measurement,
          source: { id: source.id, versionId: source.version.id, canonicalUri: builtUrl },
          request: { method: "GET", url: builtUrl, sha256: requestSha256 },
          response: { sha256: responseSha256, byteSize: fetched.body.length, mimeType: "application/json", httpStatus: fetched.status, retrievedAt: fetched.retrievedAt },
          network: {
            redirectPolicy: "deny", timeoutMs: this.timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES,
            minimumIntervalMs: this.minimumIntervalMs, waitedMs: fetched.waitedMs, attempts: 1,
          },
          normalization: {
            schema: NORMALIZED_SCHEMA, sha256: normalized.normalizedSha256, rowCount: normalized.observationCount,
            missingValueCount, preliminaryCount, missingValuePolicy: "preserve-null",
            contentReceipts: normalized.contentReceipts, warnings: normalized.warnings,
          },
        },
      });
      const receipt: NoaaReceipt = {
        ...payload.evidence,
        schema: RECEIPT_SCHEMA,
        provider: "noaa-coops" as const,
        response: { ...payload.evidence.response, durationMs: fetched.durationMs },
      };
      const rawBlob = this.store.putRunBlob(fetched.body);
      const receiptBlob = this.store.putRunBlob(Buffer.from(canonicalJson(receipt), "utf8"));
      const payloadBlob = this.store.putRunBlob(Buffer.from(canonicalJson(payload), "utf8"));
      const outputs = [
        { role: "provider-response", mimeType: "application/json", ...rawBlob, artifactId: null, artifactVersion: null },
        { role: "provider-receipt", mimeType: RECEIPT_MIME, ...receiptBlob, artifactId: null, artifactVersion: null },
        { role: "water-level-artifact-payload", mimeType: PAYLOAD_MIME, ...payloadBlob, artifactId: null, artifactVersion: null },
      ];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)),
        summary: `${normalized.observationCount - missingValueCount} exact NOAA CO-OPS water-level observations retrieved; ${missingValueCount} missing values preserved as null.`,
        outputs,
      });
      const artifact = this.createArtifact({
        projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
        runId: run.id, environmentSha256: run.environmentSha256, payload,
      });
      return {
        schema: RESULT_SCHEMA, provider: "noaa-coops", query, title, sourceId: source.id, sourceVersionId: source.version.id,
        receipt, artifact, runId: run.id, replayed: false,
      };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        const code = error instanceof Error ? error.message.slice(0, 240) : "science-noaa-coops-provider-failed";
        const failure = {
          schema: FAILURE_SCHEMA,
          provider: "noaa-coops",
          request: { method: "GET", url: builtUrl, sha256: requestSha256 },
          response: fetched ? {
            sha256: sha256(fetched.body), byteSize: fetched.body.length, mimeType: fetched.mimeType || "application/octet-stream",
            httpStatus: fetched.status, retrievedAt: fetched.retrievedAt, durationMs: fetched.durationMs,
          } : null,
          network: {
            redirectPolicy: "deny", timeoutMs: this.timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES,
            minimumIntervalMs: this.minimumIntervalMs, waitedMs: fetched?.waitedMs ?? null, attempts: 1,
          },
          code,
        };
        const failureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(failure), "utf8"));
        const outputs = [
          ...(fetched ? [{ role: "provider-response", mimeType: fetched.mimeType || "application/octet-stream", ...this.store.putRunBlob(fetched.body), artifactId: null, artifactVersion: null }] : []),
          { role: "provider-receipt", mimeType: FAILURE_MIME, ...failureBlob, artifactId: null, artifactVersion: null },
        ];
        this.store.completeResearchRun({
          requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "failed",
          outputManifestSha256: sha256(canonicalJson(outputs)), summary: code, outputs,
        });
      }
      throw error;
    }
  }
}
