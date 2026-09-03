import { createHash } from "node:crypto";

export const SCIENCE_ECONOMICS_GROWTH_TOOL_ID = "agentlas.economic-indicator-growth-analysis" as const;
export const SCIENCE_ECONOMICS_GROWTH_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_ECONOMICS_GROWTH_RESULT_SCHEMA = "agentlas.science.economic-indicator-growth-result/v1" as const;
export const SCIENCE_ECONOMICS_GROWTH_ARTIFACT_SCHEMA = "agentlas.science.economic-indicator-growth-artifact/v1" as const;
export const SCIENCE_ECONOMICS_GROWTH_TABLE_SCHEMA = "agentlas.science.economic-indicator-growth-table/v1" as const;
export const SCIENCE_ECONOMICS_GROWTH_METRIC_ID = "year-over-year-percent" as const;
export const SCIENCE_ECONOMICS_GROWTH_METRIC_LABEL = "Year-over-year percentage change" as const;
export const SCIENCE_ECONOMICS_GROWTH_METRIC_FORMULA = "(current_value - prior_value) / abs(prior_value) * 100" as const;

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const YEAR_RE = /^\d{4}$/u;

export const SCIENCE_ECONOMICS_GROWTH_STATUSES = [
  "computed",
  "missing-observation",
  "missing-baseline",
  "year-gap",
  "zero-baseline",
] as const;
export type ScienceEconomicsGrowthStatus = typeof SCIENCE_ECONOMICS_GROWTH_STATUSES[number];

export interface ScienceEconomicIndicatorGrowthRow {
  fromYear: number;
  toYear: number;
  fromValue: number | null;
  toValue: number | null;
  absoluteChange: number | null;
  percentChange: number | null;
  status: ScienceEconomicsGrowthStatus;
}

export interface ScienceEconomicIndicatorGrowthPayload {
  schema: typeof SCIENCE_ECONOMICS_GROWTH_ARTIFACT_SCHEMA;
  title: string;
  metric: {
    id: typeof SCIENCE_ECONOMICS_GROWTH_METRIC_ID;
    label: typeof SCIENCE_ECONOMICS_GROWTH_METRIC_LABEL;
    formula: typeof SCIENCE_ECONOMICS_GROWTH_METRIC_FORMULA;
    baselinePolicy: "absolute-prior-value";
  };
  source: {
    parentRunId: string;
    parentArtifactId: string;
    parentArtifactVersion: number;
    parentArtifactContentSha256: string;
    parentPayloadSha256: string;
    rawResponseSha256: string;
    sourceId: string;
    sourceVersionId: string;
    canonicalUri: string;
    query: { country: string; indicator: string; startYear: number; endYear: number };
    countryName: string;
    indicatorName: string;
    unit: string;
    decimals: number;
    observationCount: number;
  };
  table: {
    schema: typeof SCIENCE_ECONOMICS_GROWTH_TABLE_SCHEMA;
    columns: Array<{
      id: string;
      label: string;
      type: "number" | "string";
      unit: string | null;
      nullable: boolean;
    }>;
    rows: ScienceEconomicIndicatorGrowthRow[];
  };
  spec: Record<string, unknown>;
  summary: {
    inputRows: number;
    comparisonRows: number;
    computedRows: number;
    missingObservationRows: number;
    missingBaselineRows: number;
    gapRows: number;
    zeroBaselineRows: number;
    meanPercentChange: number | null;
    medianPercentChange: number | null;
  };
  warnings: string[];
  boundaries: string[];
  provenance: {
    runId: string;
    parentRunId: string;
    parentArtifactContentSha256: string;
    parentPayloadSha256: string;
    rawResponseSha256: string;
    tableSha256: string;
    figureSha256: string;
    analysisSha256: string;
  };
}

type JsonRecord = Record<string, unknown>;

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

function safeNumber(value: unknown, code: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(code);
  return Object.is(value, -0) ? 0 : value;
}

function isWorldBankUri(value: string, query: { startYear: number; endYear: number }): boolean {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  return parsed.protocol === "https:" && parsed.origin === "https://api.worldbank.org"
    && /^\/v2\/country\/[^/]+\/indicator\/[^/]+$/u.test(parsed.pathname)
    && parsed.searchParams.get("date") === `${query.startYear}:${query.endYear}`
    && parsed.searchParams.get("format") === "json"
    && parsed.searchParams.get("page") === "1"
    && parsed.searchParams.get("per_page") === "1000";
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  return Object.fromEntries(Object.keys(value as JsonRecord).sort().flatMap((key) => {
    const child = (value as JsonRecord)[key];
    return child === undefined ? [] : [[key, canonicalValue(child)]];
  }));
}

export function scienceEconomicsGrowthSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function numericSummary(values: number[]): { mean: number | null; median: number | null } {
  if (!values.length) return { mean: null, median: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { mean: Object.is(mean, -0) ? 0 : mean, median: Object.is(median, -0) ? 0 : median };
}

function figureRow(row: ScienceEconomicIndicatorGrowthRow): JsonRecord {
  const percentText = row.percentChange === null ? "not computed" : `${row.percentChange}%`;
  return {
    fromYear: row.fromYear,
    toYear: row.toYear,
    percentChange: row.percentChange,
    defined: row.percentChange !== null,
    status: row.status,
    tooltip: `${row.fromYear}–${row.toYear}: ${percentText} (${row.status})`,
  };
}

function buildVegaSpec(rows: ScienceEconomicIndicatorGrowthRow[], title: string, indicatorName: string, unit: string): Record<string, unknown> {
  const comparisons = rows.map(figureRow);
  const computed = comparisons.filter((row) => row.defined === true);
  return {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    description: `Year-over-year percentage changes for World Bank ${indicatorName}; only adjacent, non-null observations are computed. Missing observations and year gaps are retained in the publication table and omitted from the plotted series.`,
    width: 720,
    height: 360,
    padding: 12,
    autosize: { type: "fit", contains: "padding", resize: true },
    title: { text: title, anchor: "middle", fontSize: 16, offset: 12 },
    data: [
      { name: "comparisons", values: comparisons },
      { name: "computed", values: computed },
      { name: "zero", values: [{ value: 0 }] },
    ],
    scales: [
      { name: "x", type: "point", range: "width", domain: { data: "comparisons", field: "toYear" }, padding: 0.35 },
      { name: "y", type: "linear", range: "height", domain: computed.length ? { data: "computed", field: "percentChange" } : [-1, 1], nice: true, zero: false },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "Year ending", labelOverlap: true },
      { orient: "left", scale: "y", title: "Year-over-year change (%)", grid: true, tickCount: 6 },
    ],
    marks: [
      {
        type: "rule",
        from: { data: "zero" },
        encode: { enter: { y: { scale: "y", field: "value" }, x: { value: 0 }, x2: { field: { group: "width" } }, stroke: { value: "#94a3b8" }, strokeDash: { value: [4, 4] } } },
      },
      {
        type: "line",
        from: { data: "computed" },
        encode: { enter: { x: { scale: "x", field: "toYear" }, y: { scale: "y", field: "percentChange" }, stroke: { value: "#2563eb" }, strokeWidth: { value: 2.5 } } },
      },
      {
        type: "symbol",
        from: { data: "computed" },
        encode: {
          enter: {
            x: { scale: "x", field: "toYear" }, y: { scale: "y", field: "percentChange" },
            fill: { value: "#ffffff" }, stroke: { value: "#2563eb" }, strokeWidth: { value: 2 }, size: { value: 70 }, tooltip: { field: "tooltip" },
          },
          hover: { size: { value: 145 }, strokeWidth: { value: 3 } },
        },
      },
    ],
    ...(unit ? { usermeta: { sourceUnit: unit } } : {}),
  };
}

export function createScienceEconomicIndicatorGrowthVegaSpec(
  rows: ScienceEconomicIndicatorGrowthRow[],
  title: string,
  indicatorName: string,
  unit: string,
): Record<string, unknown> {
  return buildVegaSpec(rows, title, indicatorName, unit);
}

function analysisBody(payload: Omit<ScienceEconomicIndicatorGrowthPayload, "provenance">): JsonRecord {
  return {
    schema: payload.schema,
    title: payload.title,
    metric: payload.metric,
    source: payload.source,
    table: payload.table,
    spec: payload.spec,
    summary: payload.summary,
    warnings: payload.warnings,
    boundaries: payload.boundaries,
  };
}

export function scienceEconomicIndicatorGrowthAnalysisSha256(payload: Omit<ScienceEconomicIndicatorGrowthPayload, "provenance">): string {
  return scienceEconomicsGrowthSha256(analysisBody(payload));
}

function validateSource(value: unknown): ScienceEconomicIndicatorGrowthPayload["source"] {
  const source = record(value);
  if (!source || !exactKeys(source, [
    "parentRunId", "parentArtifactId", "parentArtifactVersion", "parentArtifactContentSha256", "parentPayloadSha256", "rawResponseSha256",
    "sourceId", "sourceVersionId", "canonicalUri", "query", "countryName", "indicatorName", "unit", "decimals", "observationCount",
  ])) throw new Error("science-economics-growth-source-invalid");
  const parentRunId = safeText(source.parentRunId, 80, "science-economics-growth-source-invalid");
  const parentArtifactId = safeText(source.parentArtifactId, 80, "science-economics-growth-source-invalid");
  const sourceId = safeText(source.sourceId, 80, "science-economics-growth-source-invalid");
  const sourceVersionId = safeText(source.sourceVersionId, 80, "science-economics-growth-source-invalid");
  if (!UUID_RE.test(parentRunId) || !UUID_RE.test(parentArtifactId) || !UUID_RE.test(sourceId) || !UUID_RE.test(sourceVersionId)) throw new Error("science-economics-growth-source-invalid");
  const parentArtifactVersion = safeInteger(source.parentArtifactVersion, 1, Number.MAX_SAFE_INTEGER, "science-economics-growth-source-invalid");
  const parentArtifactContentSha256 = safeText(source.parentArtifactContentSha256, 64, "science-economics-growth-source-invalid");
  const parentPayloadSha256 = safeText(source.parentPayloadSha256, 64, "science-economics-growth-source-invalid");
  const rawResponseSha256 = safeText(source.rawResponseSha256, 64, "science-economics-growth-source-invalid");
  if (!SHA256_RE.test(parentArtifactContentSha256) || !SHA256_RE.test(parentPayloadSha256) || !SHA256_RE.test(rawResponseSha256)) throw new Error("science-economics-growth-source-invalid");
  const canonicalUri = safeText(source.canonicalUri, 4_000, "science-economics-growth-source-invalid");
  const query = record(source.query);
  if (!query || !exactKeys(query, ["country", "indicator", "startYear", "endYear"])) throw new Error("science-economics-growth-query-invalid");
  const country = safeText(query.country, 3, "science-economics-growth-query-invalid");
  const indicator = safeText(query.indicator, 64, "science-economics-growth-query-invalid");
  const startYear = safeInteger(query.startYear, 1800, 2200, "science-economics-growth-query-invalid");
  const endYear = safeInteger(query.endYear, startYear, 2200, "science-economics-growth-query-invalid");
  if (!/^[A-Z]{2,3}$/u.test(country) || !/^[A-Z0-9_]+(?:\.[A-Z0-9_]+){1,7}$/u.test(indicator)) throw new Error("science-economics-growth-query-invalid");
  if (!isWorldBankUri(canonicalUri, { startYear, endYear })) throw new Error("science-economics-growth-source-invalid");
  const countryName = safeText(source.countryName, 500, "science-economics-growth-source-invalid");
  const indicatorName = safeText(source.indicatorName, 500, "science-economics-growth-source-invalid");
  const unit = safeText(source.unit, 240, "science-economics-growth-source-invalid", true);
  const decimals = safeInteger(source.decimals, 0, 20, "science-economics-growth-source-invalid");
  const observationCount = safeInteger(source.observationCount, 0, 20_000, "science-economics-growth-source-invalid");
  return {
    parentRunId, parentArtifactId, parentArtifactVersion, parentArtifactContentSha256, parentPayloadSha256, rawResponseSha256,
    sourceId, sourceVersionId, canonicalUri, query: { country, indicator, startYear, endYear }, countryName, indicatorName, unit, decimals, observationCount,
  };
}

const EXPECTED_COLUMNS = [
  { id: "fromYear", label: "From year", type: "number" as const, unit: null, nullable: false },
  { id: "toYear", label: "To year", type: "number" as const, unit: null, nullable: false },
  { id: "fromValue", label: "Prior value", type: "number" as const, unit: null, nullable: true },
  { id: "toValue", label: "Current value", type: "number" as const, unit: null, nullable: true },
  { id: "absoluteChange", label: "Absolute change", type: "number" as const, unit: null, nullable: true },
  { id: "percentChange", label: "Year-over-year change", type: "number" as const, unit: "%", nullable: true },
  { id: "status", label: "Comparison status", type: "string" as const, unit: null, nullable: false },
];

function validateTable(value: unknown, source: ScienceEconomicIndicatorGrowthPayload["source"]): ScienceEconomicIndicatorGrowthPayload["table"] {
  const table = record(value);
  if (!table || !exactKeys(table, ["schema", "columns", "rows"]) || table.schema !== SCIENCE_ECONOMICS_GROWTH_TABLE_SCHEMA
    || !Array.isArray(table.columns) || !Array.isArray(table.rows) || table.rows.length > 20_000
    || JSON.stringify(canonicalValue(table.columns)) !== JSON.stringify(canonicalValue(EXPECTED_COLUMNS))) throw new Error("science-economics-growth-table-invalid");
  let previousToYear: number | null = null;
  const rows = table.rows.map((valueEntry) => {
    const row = record(valueEntry);
    if (!row || !exactKeys(row, ["fromYear", "toYear", "fromValue", "toValue", "absoluteChange", "percentChange", "status"])) throw new Error("science-economics-growth-row-invalid");
    const fromYear = safeInteger(row.fromYear, source.query.startYear, source.query.endYear, "science-economics-growth-row-invalid");
    const toYear = safeInteger(row.toYear, source.query.startYear, source.query.endYear, "science-economics-growth-row-invalid");
    if (fromYear >= toYear || (previousToYear !== null && toYear <= previousToYear)) throw new Error("science-economics-growth-row-order-invalid");
    previousToYear = toYear;
    const fromValue = safeNumber(row.fromValue, "science-economics-growth-row-invalid", true);
    const toValue = safeNumber(row.toValue, "science-economics-growth-row-invalid", true);
    const absoluteChange = safeNumber(row.absoluteChange, "science-economics-growth-row-invalid", true);
    const percentChange = safeNumber(row.percentChange, "science-economics-growth-row-invalid", true);
    const status = safeText(row.status, 40, "science-economics-growth-row-invalid") as ScienceEconomicsGrowthStatus;
    if (!SCIENCE_ECONOMICS_GROWTH_STATUSES.includes(status)) throw new Error("science-economics-growth-status-invalid");
    if (status === "computed") {
      if (fromValue === null || toValue === null || fromValue === 0 || absoluteChange === null || percentChange === null) throw new Error("science-economics-growth-computed-row-invalid");
      const expectedAbsolute = Object.is(toValue - fromValue, -0) ? 0 : toValue - fromValue;
      const expectedPercent = expectedAbsolute / Math.abs(fromValue) * 100;
      if (absoluteChange !== expectedAbsolute || percentChange !== expectedPercent) throw new Error("science-economics-growth-computed-row-invalid");
    } else if (status === "zero-baseline") {
      if (fromValue !== 0 || toValue === null || absoluteChange === null || percentChange !== null) throw new Error("science-economics-growth-zero-baseline-invalid");
    } else if (status === "missing-observation") {
      if (toValue !== null || percentChange !== null) throw new Error("science-economics-growth-missing-observation-invalid");
    } else if (status === "missing-baseline") {
      if (fromValue !== null || toValue === null || percentChange !== null) throw new Error("science-economics-growth-missing-baseline-invalid");
    } else if (status === "year-gap") {
      if (percentChange !== null) throw new Error("science-economics-growth-year-gap-invalid");
    }
    return { fromYear, toYear, fromValue, toValue, absoluteChange, percentChange, status };
  });
  return { schema: SCIENCE_ECONOMICS_GROWTH_TABLE_SCHEMA, columns: EXPECTED_COLUMNS, rows };
}

function validateSummary(value: unknown, rows: ScienceEconomicIndicatorGrowthRow[], inputRows: number): ScienceEconomicIndicatorGrowthPayload["summary"] {
  const summary = record(value);
  if (!summary || !exactKeys(summary, ["inputRows", "comparisonRows", "computedRows", "missingObservationRows", "missingBaselineRows", "gapRows", "zeroBaselineRows", "meanPercentChange", "medianPercentChange"])) throw new Error("science-economics-growth-summary-invalid");
  const counts = {
    inputRows: safeInteger(summary.inputRows, 0, 20_000, "science-economics-growth-summary-invalid"),
    comparisonRows: safeInteger(summary.comparisonRows, 0, 20_000, "science-economics-growth-summary-invalid"),
    computedRows: safeInteger(summary.computedRows, 0, 20_000, "science-economics-growth-summary-invalid"),
    missingObservationRows: safeInteger(summary.missingObservationRows, 0, 20_000, "science-economics-growth-summary-invalid"),
    missingBaselineRows: safeInteger(summary.missingBaselineRows, 0, 20_000, "science-economics-growth-summary-invalid"),
    gapRows: safeInteger(summary.gapRows, 0, 20_000, "science-economics-growth-summary-invalid"),
    zeroBaselineRows: safeInteger(summary.zeroBaselineRows, 0, 20_000, "science-economics-growth-summary-invalid"),
  };
  if (counts.inputRows !== inputRows || counts.comparisonRows !== rows.length
    || counts.computedRows !== rows.filter((row) => row.status === "computed").length
    || counts.missingObservationRows !== rows.filter((row) => row.status === "missing-observation").length
    || counts.missingBaselineRows !== rows.filter((row) => row.status === "missing-baseline").length
    || counts.gapRows !== rows.filter((row) => row.status === "year-gap").length
    || counts.zeroBaselineRows !== rows.filter((row) => row.status === "zero-baseline").length) throw new Error("science-economics-growth-summary-count-invalid");
  const values = rows.flatMap((row) => row.percentChange === null ? [] : [row.percentChange]);
  const numeric = numericSummary(values);
  const meanPercentChange = safeNumber(summary.meanPercentChange, "science-economics-growth-summary-invalid", true);
  const medianPercentChange = safeNumber(summary.medianPercentChange, "science-economics-growth-summary-invalid", true);
  if (meanPercentChange !== numeric.mean || medianPercentChange !== numeric.median) throw new Error("science-economics-growth-summary-statistic-invalid");
  return { ...counts, meanPercentChange, medianPercentChange };
}

function validateSpec(value: unknown, rows: ScienceEconomicIndicatorGrowthRow[], title: string, indicatorName: string, unit: string): Record<string, unknown> {
  const spec = record(value);
  if (!spec) throw new Error("science-economics-growth-spec-invalid");
  const expected = buildVegaSpec(rows, title, indicatorName, unit);
  if (JSON.stringify(canonicalValue(spec)) !== JSON.stringify(canonicalValue(expected))) throw new Error("science-economics-growth-spec-invalid");
  return expected;
}

export function validateScienceEconomicIndicatorGrowthPayload(value: unknown): ScienceEconomicIndicatorGrowthPayload {
  let bytes = "";
  try { bytes = JSON.stringify(value); } catch { throw new Error("science-economics-growth-artifact-invalid"); }
  if (Buffer.byteLength(bytes, "utf8") > 4 * 1024 * 1024) throw new Error("science-economics-growth-artifact-size-limit");
  const payload = record(value);
  if (!payload || !exactKeys(payload, ["schema", "title", "metric", "source", "table", "spec", "summary", "warnings", "boundaries", "provenance"])
    || payload.schema !== SCIENCE_ECONOMICS_GROWTH_ARTIFACT_SCHEMA) throw new Error("science-economics-growth-artifact-invalid");
  const title = safeText(payload.title, 240, "science-economics-growth-title-invalid");
  const metric = record(payload.metric);
  if (!metric || !exactKeys(metric, ["id", "label", "formula", "baselinePolicy"])
    || metric.id !== SCIENCE_ECONOMICS_GROWTH_METRIC_ID || metric.label !== SCIENCE_ECONOMICS_GROWTH_METRIC_LABEL
    || metric.formula !== SCIENCE_ECONOMICS_GROWTH_METRIC_FORMULA || metric.baselinePolicy !== "absolute-prior-value") throw new Error("science-economics-growth-metric-invalid");
  const source = validateSource(payload.source);
  const table = validateTable(payload.table, source);
  if (table.rows.length !== Math.max(0, source.observationCount - 1)) throw new Error("science-economics-growth-row-count-invalid");
  const summary = validateSummary(payload.summary, table.rows, source.observationCount);
  const warningsValue = payload.warnings;
  const boundariesValue = payload.boundaries;
  if (!Array.isArray(warningsValue) || warningsValue.length > 200 || !Array.isArray(boundariesValue) || boundariesValue.length > 200) throw new Error("science-economics-growth-notes-invalid");
  const warnings = warningsValue.map((entry) => safeText(entry, 2_000, "science-economics-growth-warning-invalid"));
  const boundaries = boundariesValue.map((entry) => safeText(entry, 2_000, "science-economics-growth-boundary-invalid"));
  const spec = validateSpec(payload.spec, table.rows, title, source.indicatorName, source.unit);
  const provenanceValue = record(payload.provenance);
  if (!provenanceValue || !exactKeys(provenanceValue, ["runId", "parentRunId", "parentArtifactContentSha256", "parentPayloadSha256", "rawResponseSha256", "tableSha256", "figureSha256", "analysisSha256"])) throw new Error("science-economics-growth-provenance-invalid");
  const runId = safeText(provenanceValue.runId, 80, "science-economics-growth-provenance-invalid");
  const parentRunId = safeText(provenanceValue.parentRunId, 80, "science-economics-growth-provenance-invalid");
  if (!UUID_RE.test(runId) || parentRunId !== source.parentRunId) throw new Error("science-economics-growth-provenance-invalid");
  const parentArtifactContentSha256 = safeText(provenanceValue.parentArtifactContentSha256, 64, "science-economics-growth-provenance-invalid");
  const parentPayloadSha256 = safeText(provenanceValue.parentPayloadSha256, 64, "science-economics-growth-provenance-invalid");
  const rawResponseSha256 = safeText(provenanceValue.rawResponseSha256, 64, "science-economics-growth-provenance-invalid");
  const tableSha256 = safeText(provenanceValue.tableSha256, 64, "science-economics-growth-provenance-invalid");
  const figureSha256 = safeText(provenanceValue.figureSha256, 64, "science-economics-growth-provenance-invalid");
  const analysisSha256 = safeText(provenanceValue.analysisSha256, 64, "science-economics-growth-provenance-invalid");
  if (![parentArtifactContentSha256, parentPayloadSha256, rawResponseSha256, tableSha256, figureSha256, analysisSha256].every((hash) => SHA256_RE.test(hash))
    || parentArtifactContentSha256 !== source.parentArtifactContentSha256 || parentPayloadSha256 !== source.parentPayloadSha256 || rawResponseSha256 !== source.rawResponseSha256
    || tableSha256 !== scienceEconomicsGrowthSha256(table) || figureSha256 !== scienceEconomicsGrowthSha256(spec)) throw new Error("science-economics-growth-provenance-digest-invalid");
  const body = {
    schema: SCIENCE_ECONOMICS_GROWTH_ARTIFACT_SCHEMA,
    title,
    metric: { id: SCIENCE_ECONOMICS_GROWTH_METRIC_ID, label: SCIENCE_ECONOMICS_GROWTH_METRIC_LABEL, formula: SCIENCE_ECONOMICS_GROWTH_METRIC_FORMULA, baselinePolicy: "absolute-prior-value" as const },
    source, table, spec, summary, warnings, boundaries,
  };
  if (analysisSha256 !== scienceEconomicIndicatorGrowthAnalysisSha256(body)) throw new Error("science-economics-growth-analysis-digest-invalid");
  return {
    ...body,
    provenance: { runId, parentRunId, parentArtifactContentSha256, parentPayloadSha256, rawResponseSha256, tableSha256, figureSha256, analysisSha256 },
  };
}
