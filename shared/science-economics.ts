import { createHash } from "node:crypto";

export const SCIENCE_ECONOMICS_TOOL_ID = "agentlas.world-bank-economic-indicator" as const;
export const SCIENCE_ECONOMICS_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_ECONOMICS_LAB_ID = "economic-indicators" as const;
export const SCIENCE_ECONOMICS_ARTIFACT_SCHEMA = "agentlas.science.economic-indicator-artifact/v1" as const;
export const SCIENCE_ECONOMICS_TABLE_SCHEMA = "agentlas.science.economic-indicator-table/v1" as const;
export const SCIENCE_ECONOMICS_EVIDENCE_SCHEMA = "agentlas.science.economic-indicator-evidence/v1" as const;
export const WORLD_BANK_NORMALIZED_SCHEMA = "agentlas.economic-data.world-bank-indicator.v1" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const YEAR_RE = /^\d{4}$/;
type JsonRecord = Record<string, unknown>;

export interface ScienceEconomicIndicatorTableRow {
  date: string;
  value: number | null;
  unit: string;
  decimals: number;
  observationStatus: string | null;
}

export interface ScienceEconomicIndicatorArtifactPayload {
  schema: typeof SCIENCE_ECONOMICS_ARTIFACT_SCHEMA;
  table: {
    schema: typeof SCIENCE_ECONOMICS_TABLE_SCHEMA;
    columns: [
      { id: "date"; label: "Year"; type: "string"; unit: null; nullable: false },
      { id: "value"; label: string; type: "number"; unit: string | null; nullable: true },
      { id: "unit"; label: "Unit"; type: "string"; unit: null; nullable: false },
      { id: "decimals"; label: "Decimals"; type: "number"; unit: null; nullable: false },
      { id: "observationStatus"; label: "Observation status"; type: "string"; unit: null; nullable: true },
    ];
    rows: ScienceEconomicIndicatorTableRow[];
  };
  spec: Record<string, unknown>;
  evidence: {
    schema: typeof SCIENCE_ECONOMICS_EVIDENCE_SCHEMA;
    runId: string;
    query: { country: string; indicator: string; startYear: number; endYear: number };
    source: { id: string; versionId: string; canonicalUri: string };
    request: { method: "GET"; url: string; sha256: string };
    response: { sha256: string; byteSize: number; mimeType: "application/json"; httpStatus: number; retrievedAt: string };
    normalization: {
      schema: typeof WORLD_BANK_NORMALIZED_SCHEMA;
      sha256: string;
      rowCount: number;
      missingValueCount: number;
      missingValuePolicy: "preserve-null";
      pagination: { page: number; pages: number; perPage: number; total: number };
      provider: { sourceId: string | null; lastUpdated: string | null; sourceNotes: string[] };
      series: {
        country: { id: string; name: string; iso3Code: string };
        indicator: { code: string; name: string };
        unit: string;
        decimals: number;
      };
    };
  };
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function exactKeys(value: JsonRecord, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeText(value: unknown, maximum: number, code: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return allowEmpty ? value : value.trim();
}

function safeInteger(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(code);
  return Number(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  return Object.fromEntries(Object.keys(value as JsonRecord).sort().flatMap((key) => {
    const child = (value as JsonRecord)[key];
    return child === undefined ? [] : [[key, canonicalValue(child)]];
  }));
}

export function scienceEconomicsSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function canonicalWorldBankUrl(value: unknown, code: string): string {
  const raw = safeText(value, 4_000, code);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(code); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.worldbank.org" || parsed.username || parsed.password
    || !/^\/v2\/country\/[^/]+\/indicator\/[^/]+$/.test(parsed.pathname)
    || parsed.searchParams.get("format") !== "json" || !parsed.searchParams.get("date")) throw new Error(code);
  return parsed.toString();
}

function buildVegaSpec(
  rows: ScienceEconomicIndicatorTableRow[],
  title: string,
  indicatorName: string,
  unit: string,
): Record<string, unknown> {
  const tableValues = rows.map((row) => ({
    date: row.date,
    value: row.value,
    defined: row.value !== null,
    tooltip: row.value === null ? `${row.date}: missing` : `${row.date}: ${row.value}${unit ? ` ${unit}` : ""}`,
  }));
  const observedValues = tableValues.filter((row) => row.defined);
  return {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    description: `World Bank ${indicatorName} observations. Missing values remain null and are not plotted or imputed.`,
    width: 720,
    height: 360,
    padding: 12,
    autosize: { type: "fit", contains: "padding", resize: true },
    title: { text: title, anchor: "middle", fontSize: 16, offset: 12 },
    data: [
      { name: "table", values: tableValues },
      { name: "observed", values: observedValues },
    ],
    scales: [
      { name: "x", type: "point", range: "width", domain: { data: "table", field: "date" }, padding: 0.35 },
      { name: "y", type: "linear", range: "height", domain: { data: "observed", field: "value" }, nice: true, zero: false },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "Year", labelOverlap: true },
      { orient: "left", scale: "y", title: unit || indicatorName, grid: true, tickCount: 6 },
    ],
    marks: [
      {
        type: "line",
        from: { data: "table" },
        encode: { enter: {
          x: { scale: "x", field: "date" }, y: { scale: "y", field: "value" }, defined: { field: "defined" },
          stroke: { value: "#2563eb" }, strokeWidth: { value: 2.5 },
        } },
      },
      {
        type: "symbol",
        from: { data: "observed" },
        encode: {
          enter: {
            x: { scale: "x", field: "date" }, y: { scale: "y", field: "value" },
            fill: { value: "#ffffff" }, stroke: { value: "#2563eb" }, strokeWidth: { value: 2 },
            size: { value: 70 }, tooltip: { field: "tooltip" },
          },
          hover: { size: { value: 145 }, strokeWidth: { value: 3 } },
        },
      },
    ],
  };
}

export function createScienceEconomicIndicatorVegaSpec(
  rows: ScienceEconomicIndicatorTableRow[],
  title: string,
  indicatorName: string,
  unit: string,
): Record<string, unknown> {
  return buildVegaSpec(rows, title, indicatorName, unit);
}

export function validateScienceEconomicIndicatorArtifactPayload(value: unknown): ScienceEconomicIndicatorArtifactPayload {
  let serialized = "";
  try { serialized = JSON.stringify(value); } catch { throw new Error("science-economics-artifact-invalid"); }
  if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) throw new Error("science-economics-artifact-size-limit");
  const payload = record(value);
  if (!payload || !exactKeys(payload, ["schema", "table", "spec", "evidence"]) || payload.schema !== SCIENCE_ECONOMICS_ARTIFACT_SCHEMA) {
    throw new Error("science-economics-artifact-invalid");
  }

  const evidence = record(payload.evidence);
  if (!evidence || !exactKeys(evidence, ["schema", "runId", "query", "source", "request", "response", "normalization"])
    || evidence.schema !== SCIENCE_ECONOMICS_EVIDENCE_SCHEMA || typeof evidence.runId !== "string" || !UUID_RE.test(evidence.runId)) {
    throw new Error("science-economics-evidence-invalid");
  }
  const query = record(evidence.query);
  if (!query || !exactKeys(query, ["country", "indicator", "startYear", "endYear"])) throw new Error("science-economics-query-invalid");
  const country = safeText(query.country, 3, "science-economics-query-invalid");
  const indicator = safeText(query.indicator, 64, "science-economics-query-invalid");
  const startYear = safeInteger(query.startYear, 1800, 2200, "science-economics-query-invalid");
  const endYear = safeInteger(query.endYear, startYear, 2200, "science-economics-query-invalid");
  if (!/^[A-Z]{2,3}$/.test(country) || !/^[A-Z0-9_]+(?:\.[A-Z0-9_]+){1,7}$/.test(indicator)) throw new Error("science-economics-query-invalid");

  const source = record(evidence.source);
  if (!source || !exactKeys(source, ["id", "versionId", "canonicalUri"])) throw new Error("science-economics-source-invalid");
  const sourceId = safeText(source.id, 80, "science-economics-source-invalid");
  const sourceVersionId = safeText(source.versionId, 80, "science-economics-source-invalid");
  if (!UUID_RE.test(sourceId) || !UUID_RE.test(sourceVersionId)) throw new Error("science-economics-source-invalid");
  const canonicalUri = canonicalWorldBankUrl(source.canonicalUri, "science-economics-source-invalid");

  const request = record(evidence.request);
  if (!request || !exactKeys(request, ["method", "url", "sha256"]) || request.method !== "GET"
    || typeof request.sha256 !== "string" || !SHA256_RE.test(request.sha256)) throw new Error("science-economics-request-receipt-invalid");
  const requestUrl = canonicalWorldBankUrl(request.url, "science-economics-request-receipt-invalid");
  if (requestUrl !== canonicalUri) throw new Error("science-economics-request-source-mismatch");
  const parsedRequestUrl = new URL(requestUrl);
  const pathMatch = /^\/v2\/country\/([^/]+)\/indicator\/([^/]+)$/.exec(parsedRequestUrl.pathname);
  const searchKeys = [...parsedRequestUrl.searchParams.keys()].sort();
  if (!pathMatch || decodeURIComponent(pathMatch[1]!) !== country || decodeURIComponent(pathMatch[2]!) !== indicator
    || parsedRequestUrl.searchParams.get("date") !== `${startYear}:${endYear}`
    || parsedRequestUrl.searchParams.get("page") !== "1" || parsedRequestUrl.searchParams.get("per_page") !== "1000"
    || JSON.stringify(searchKeys) !== JSON.stringify(["date", "format", "page", "per_page"])) {
    throw new Error("science-economics-request-query-mismatch");
  }
  if (request.sha256 !== scienceEconomicsSha256({ method: "GET", url: requestUrl, headers: { accept: "application/json" } })) {
    throw new Error("science-economics-request-receipt-invalid");
  }

  const response = record(evidence.response);
  if (!response || !exactKeys(response, ["sha256", "byteSize", "mimeType", "httpStatus", "retrievedAt"])
    || typeof response.sha256 !== "string" || !SHA256_RE.test(response.sha256) || response.mimeType !== "application/json") {
    throw new Error("science-economics-response-receipt-invalid");
  }
  const byteSize = safeInteger(response.byteSize, 2, 8 * 1024 * 1024, "science-economics-response-receipt-invalid");
  const httpStatus = safeInteger(response.httpStatus, 200, 299, "science-economics-response-receipt-invalid");
  const retrievedAt = safeText(response.retrievedAt, 80, "science-economics-response-receipt-invalid");
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error("science-economics-response-receipt-invalid");

  const normalization = record(evidence.normalization);
  if (!normalization || !exactKeys(normalization, ["schema", "sha256", "rowCount", "missingValueCount", "missingValuePolicy", "pagination", "provider", "series"])
    || normalization.schema !== WORLD_BANK_NORMALIZED_SCHEMA || typeof normalization.sha256 !== "string" || !SHA256_RE.test(normalization.sha256)
    || normalization.missingValuePolicy !== "preserve-null") throw new Error("science-economics-normalization-invalid");
  const pagination = record(normalization.pagination);
  if (!pagination || !exactKeys(pagination, ["page", "pages", "perPage", "total"])) throw new Error("science-economics-pagination-invalid");
  const normalizedPagination = {
    page: safeInteger(pagination.page, 1, 1_000_000, "science-economics-pagination-invalid"),
    pages: safeInteger(pagination.pages, 0, 1_000_000, "science-economics-pagination-invalid"),
    perPage: safeInteger(pagination.perPage, 1, 20_000, "science-economics-pagination-invalid"),
    total: safeInteger(pagination.total, 0, 100_000_000, "science-economics-pagination-invalid"),
  };
  const provider = record(normalization.provider);
  if (!provider || !exactKeys(provider, ["sourceId", "lastUpdated", "sourceNotes"]) || !Array.isArray(provider.sourceNotes)
    || provider.sourceNotes.length > 100) throw new Error("science-economics-provider-metadata-invalid");
  const sourceMetadataId = provider.sourceId === null ? null : safeText(provider.sourceId, 160, "science-economics-provider-metadata-invalid");
  const lastUpdated = provider.lastUpdated === null ? null : safeText(provider.lastUpdated, 160, "science-economics-provider-metadata-invalid");
  const sourceNotes = provider.sourceNotes.map((note) => safeText(note, 2_000, "science-economics-provider-metadata-invalid"));

  const series = record(normalization.series);
  const seriesCountry = record(series?.country);
  const seriesIndicator = record(series?.indicator);
  if (!series || !exactKeys(series, ["country", "indicator", "unit", "decimals"])
    || !seriesCountry || !exactKeys(seriesCountry, ["id", "name", "iso3Code"])
    || !seriesIndicator || !exactKeys(seriesIndicator, ["code", "name"])) throw new Error("science-economics-series-invalid");
  const normalizedSeries = {
    country: {
      id: safeText(seriesCountry.id, 80, "science-economics-series-invalid"),
      name: safeText(seriesCountry.name, 500, "science-economics-series-invalid"),
      iso3Code: safeText(seriesCountry.iso3Code, 20, "science-economics-series-invalid"),
    },
    indicator: {
      code: safeText(seriesIndicator.code, 160, "science-economics-series-invalid"),
      name: safeText(seriesIndicator.name, 500, "science-economics-series-invalid"),
    },
    unit: safeText(series.unit, 240, "science-economics-series-invalid", true),
    decimals: safeInteger(series.decimals, 0, 20, "science-economics-series-invalid"),
  };
  if (normalizedSeries.indicator.code !== indicator) throw new Error("science-economics-indicator-mismatch");
  if ((country.length === 2 && normalizedSeries.country.id !== country)
    || (country.length === 3 && normalizedSeries.country.iso3Code !== country)) throw new Error("science-economics-country-mismatch");

  const table = record(payload.table);
  if (!table || !exactKeys(table, ["schema", "columns", "rows"]) || table.schema !== SCIENCE_ECONOMICS_TABLE_SCHEMA
    || !Array.isArray(table.columns) || table.columns.length !== 5 || !Array.isArray(table.rows) || table.rows.length > 20_000) {
    throw new Error("science-economics-table-invalid");
  }
  const expectedColumns: ScienceEconomicIndicatorArtifactPayload["table"]["columns"] = [
    { id: "date", label: "Year", type: "string", unit: null, nullable: false },
    { id: "value", label: normalizedSeries.indicator.name, type: "number", unit: normalizedSeries.unit || null, nullable: true },
    { id: "unit", label: "Unit", type: "string", unit: null, nullable: false },
    { id: "decimals", label: "Decimals", type: "number", unit: null, nullable: false },
    { id: "observationStatus", label: "Observation status", type: "string", unit: null, nullable: true },
  ];
  if (JSON.stringify(canonicalValue(table.columns)) !== JSON.stringify(canonicalValue(expectedColumns))) throw new Error("science-economics-columns-invalid");
  const rows = table.rows.map((entry) => {
    const row = record(entry);
    if (!row || !exactKeys(row, ["date", "value", "unit", "decimals", "observationStatus"])) throw new Error("science-economics-row-invalid");
    const date = safeText(row.date, 4, "science-economics-row-invalid");
    const year = YEAR_RE.test(date) ? Number(date) : NaN;
    if (!Number.isSafeInteger(year) || year < startYear || year > endYear) throw new Error("science-economics-row-invalid");
    const rowValue = row.value === null ? null : typeof row.value === "number" && Number.isFinite(row.value) ? (Object.is(row.value, -0) ? 0 : row.value) : undefined;
    if (rowValue === undefined || row.unit !== normalizedSeries.unit || row.decimals !== normalizedSeries.decimals) throw new Error("science-economics-row-invalid");
    const observationStatus = row.observationStatus === null ? null : safeText(row.observationStatus, 240, "science-economics-row-invalid");
    return { date, value: rowValue, unit: normalizedSeries.unit, decimals: normalizedSeries.decimals, observationStatus };
  });
  if (new Set(rows.map((row) => row.date)).size !== rows.length
    || rows.some((row, index) => index > 0 && Number(rows[index - 1]!.date) >= Number(row.date))) throw new Error("science-economics-row-order-invalid");
  const missingValueCount = rows.filter((row) => row.value === null).length;
  if (normalization.rowCount !== rows.length || normalization.missingValueCount !== missingValueCount) throw new Error("science-economics-count-invalid");
  const normalizedForDigest = {
    schema: WORLD_BANK_NORMALIZED_SCHEMA,
    provider: { id: "world-bank", name: "World Bank", apiVersion: "v2", sourceId: sourceMetadataId, lastUpdated },
    pagination: normalizedPagination,
    series: normalizedSeries,
    observations: [...rows].sort((left, right) => Number(right.date) - Number(left.date)),
  };
  if (normalization.sha256 !== scienceEconomicsSha256(normalizedForDigest)) throw new Error("science-economics-normalization-digest-invalid");

  const titleRecord = record(payload.spec);
  const specTitle = record(titleRecord?.title);
  const title = safeText(specTitle?.text, 240, "science-economics-vega-spec-invalid");
  const expectedSpec = buildVegaSpec(rows, title, normalizedSeries.indicator.name, normalizedSeries.unit);
  if (JSON.stringify(canonicalValue(payload.spec)) !== JSON.stringify(canonicalValue(expectedSpec))) throw new Error("science-economics-vega-spec-invalid");

  return {
    schema: SCIENCE_ECONOMICS_ARTIFACT_SCHEMA,
    table: { schema: SCIENCE_ECONOMICS_TABLE_SCHEMA, columns: expectedColumns, rows },
    spec: expectedSpec,
    evidence: {
      schema: SCIENCE_ECONOMICS_EVIDENCE_SCHEMA,
      runId: String(evidence.runId),
      query: { country, indicator, startYear, endYear },
      source: { id: sourceId, versionId: sourceVersionId, canonicalUri },
      request: { method: "GET", url: requestUrl, sha256: String(request.sha256) },
      response: { sha256: String(response.sha256), byteSize, mimeType: "application/json", httpStatus, retrievedAt: new Date(retrievedAt).toISOString() },
      normalization: {
        schema: WORLD_BANK_NORMALIZED_SCHEMA,
        sha256: String(normalization.sha256),
        rowCount: rows.length,
        missingValueCount,
        missingValuePolicy: "preserve-null",
        pagination: normalizedPagination,
        provider: { sourceId: sourceMetadataId, lastUpdated, sourceNotes },
        series: normalizedSeries,
      },
    },
  };
}
