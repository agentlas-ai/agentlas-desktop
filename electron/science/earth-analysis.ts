import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceDatasetCell, ScienceDatasetTablePayload, ScienceResearchRunAnalysisPlanBinding } from "../../shared/science-contract";
import { validateScienceTablePayload } from "../../shared/science-table";
import { ScienceStore } from "./store";
import { EARTHQUAKE_CATALOG_TOOL_ID, EARTHQUAKE_CATALOG_TOOL_VERSION, type EarthquakeCatalogResult } from "./earthquake-catalog";
import { loadSciencePluginRuntime } from "./plugin-runtime";

// Host binding for the Agentlas Earth Science analysis runtime. Every tool here
// is modelled on analyzeEarthGutenbergRichter in domain-analysis.ts: an exact
// parent (a succeeded USGS catalog run or an immutable table artifact) becomes
// an immutable child ResearchRun whose outputs are the analysis, its
// publication table, and its Vega-Lite figure, plus one chart.vega artifact
// carrying a static Vega spec composed from that figure.

export const EARTH_ANALYSIS_PLUGIN_VERSION = "0.6.0";
export const EARTH_ANALYSIS_TOOL_VERSION = "1.0.0";
export const EARTH_ANALYSIS_RESULT_SCHEMA = "agentlas.science-earth-analysis-result/v1";

type JsonRecord = Record<string, unknown>;

export type EarthAnalysisRecord = JsonRecord & {
  schema: string;
  methodRevision: string;
  analysisSha256: string;
  publicationTable: JsonRecord & { rows: unknown[] };
  vegaLite: JsonRecord;
  contentReceipts: Record<string, { sha256: string }>;
  assumptions?: string[];
  warnings?: string[];
};

type EarthRuntime = {
  PLUGIN_VERSION: string;
  NORMAL_CRITICAL_VALUES: Record<string, number>;
  akiB(magnitudes: number[], completenessMagnitude: number, binWidth: number): {
    sampleSize: number;
    meanMagnitude: number;
    effectiveThreshold: number;
    bValue: number;
    akiStandardError: number;
    shiBoltStandardError: number;
    aValue: number;
  } | null;
  fitBoundedOmoriUtsu(eventSeconds: number[], startSeconds: number, endSeconds: number, bounds: {
    pMin: number;
    pMax: number;
    cMinSeconds: number;
    cMaxSeconds: number;
  }): { p: number; cSeconds: number; k: number; logLikelihood: number; atBoundary: boolean } | null;
  omoriIntegral(p: number, cSeconds: number, startSeconds: number, endSeconds: number): number;
  analyzeSeismicityBValue(input: JsonRecord): EarthAnalysisRecord;
  analyzeAftershockProductivity(input: JsonRecord): EarthAnalysisRecord;
  analyzeTidalHarmonics(input: JsonRecord): EarthAnalysisRecord;
  analyzeClimateTrend(input: JsonRecord): EarthAnalysisRecord;
  analyzeDroughtIndex(input: JsonRecord): EarthAnalysisRecord;
  analyzeFloodFrequency(input: JsonRecord): EarthAnalysisRecord;
  analyzeIsochron(input: JsonRecord): EarthAnalysisRecord;
  analyzeTasClassification(input: JsonRecord): EarthAnalysisRecord;
  analyzeSpatialAutocorrelation(input: JsonRecord): EarthAnalysisRecord;
};

type ParentKind = "earthquake-catalog" | "table";

export interface EarthAnalysisContext {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  analysisPlan?: ScienceResearchRunAnalysisPlanBinding | null;
}

export interface EarthAnalysisResult {
  schema: typeof EARTH_ANALYSIS_RESULT_SCHEMA;
  toolId: string;
  runId: string;
  parentRunId: string;
  title: string;
  analysis: EarthAnalysisRecord;
  artifact: ScienceArtifact;
  replayed: boolean;
}

interface EarthAnalysisToolSpec {
  id: string;
  key: string;
  labId: "earthquake-observations" | "data-visualization";
  mcpName: string;
  parentKind: ParentKind;
  pluginFunction: "analyzeSeismicityBValue" | "analyzeAftershockProductivity" | "analyzeTidalHarmonics" | "analyzeClimateTrend" | "analyzeDroughtIndex" | "analyzeFloodFrequency" | "analyzeIsochron" | "analyzeTasClassification" | "analyzeSpatialAutocorrelation";
  defaultTitle: (body: JsonRecord) => string;
  summarize: (analysis: EarthAnalysisRecord) => { summary: string; observations: Array<{ label: string; value: string | number; unit: string | null }> };
}

const TOOL_SPECS: readonly EarthAnalysisToolSpec[] = [
  {
    id: "agentlas.earth-aftershock-table-study", key: "aftershock-table-study", labId: "earthquake-observations", mcpName: "analyze_aftershock_catalog_table", parentKind: "table", pluginFunction: "analyzeAftershockProductivity",
    defaultTitle: () => "Uploaded aftershock catalogue analysis",
    summarize: (analysis) => {
      const omori = analysis.omoriUtsu as JsonRecord;
      const comparison = analysis.bValueComparison as JsonRecord;
      return {
        summary: `Omori–Utsu status ${omori.status}; p=${omori.p ?? "unavailable"}, c=${omori.cDays ?? "unavailable"} d; early b=${comparison.earlyB ?? "unavailable"}, later b=${comparison.laterB ?? "unavailable"}, difference=${comparison.difference ?? "unavailable"} (two-sided normal p=${comparison.pValue ?? "unavailable"}).`,
        observations: [
          { label: "Omori p", value: (omori.p as number | null) ?? "unavailable", unit: null },
          { label: "Omori c", value: (omori.cDays as number | null) ?? "unavailable", unit: "day" },
          { label: "Early b-value", value: (comparison.earlyB as number | null) ?? "unavailable", unit: null },
          { label: "Later b-value", value: (comparison.laterB as number | null) ?? "unavailable", unit: null },
          { label: "b-value difference", value: (comparison.difference as number | null) ?? "unavailable", unit: null },
        ],
      };
    },
  },
  {
    id: "agentlas.earth-seismicity-b-value-analysis", key: "seismicity-b-value", labId: "earthquake-observations", mcpName: "analyze_earthquake_seismicity_b_value", parentKind: "earthquake-catalog", pluginFunction: "analyzeSeismicityBValue",
    defaultTitle: () => "Seismicity b-value and completeness",
    summarize: (analysis) => {
      const estimates = analysis.estimates as JsonRecord;
      const selection = analysis.selection as JsonRecord;
      return {
        summary: `Mc=${selection.selectedCompletenessMagnitude} (${selection.completenessSelection}); Aki b=${estimates.bValue} ± ${estimates.shiBoltStandardError} (Shi & Bolt) from ${estimates.sampleSize} events; return periods and a sliding-window b-value series are tabulated.`,
        observations: [
          { label: "Selected Mc", value: selection.selectedCompletenessMagnitude as number, unit: selection.magnitudeType as string },
          { label: "b-value", value: estimates.bValue as number, unit: null },
          { label: "Shi & Bolt δb", value: estimates.shiBoltStandardError as number, unit: null },
          { label: "Events ≥ Mc", value: estimates.sampleSize as number, unit: "count" },
        ],
      };
    },
  },
  {
    id: "agentlas.earth-aftershock-productivity-analysis", key: "aftershock-productivity", labId: "earthquake-observations", mcpName: "analyze_earthquake_aftershock_productivity", parentKind: "earthquake-catalog", pluginFunction: "analyzeAftershockProductivity",
    defaultTitle: () => "Aftershock productivity and forecast table",
    summarize: (analysis) => {
      const bath = analysis.bath as JsonRecord;
      const forecast = analysis.forecast as JsonRecord;
      const bValue = analysis.bValue as JsonRecord;
      return {
        summary: `Omori–Utsu status ${analysis.status}; Båth ΔM=${bath.difference}; aftershock b=${bValue.value ?? "unavailable"}; expected N(≥Mc)=${forecast.expectedAboveCompleteness ?? "unavailable"} over the next ${forecast.horizonDays} days (point forecast, no parameter-uncertainty propagation).`,
        observations: [
          { label: "Båth difference", value: (bath.difference as number | null) ?? "unavailable", unit: null },
          { label: "Aftershock b-value", value: (bValue.value as number | null) ?? "unavailable", unit: null },
          { label: "Expected aftershocks ≥ Mc", value: (forecast.expectedAboveCompleteness as number | null) ?? "unavailable", unit: "count" },
        ],
      };
    },
  },
  {
    id: "agentlas.earth-tidal-harmonic-analysis", key: "tidal-harmonics", labId: "data-visualization", mcpName: "analyze_tidal_harmonics", parentKind: "table", pluginFunction: "analyzeTidalHarmonics",
    defaultTitle: () => "Tidal harmonic analysis",
    summarize: (analysis) => {
      const estimates = analysis.estimates as JsonRecord;
      const constituents = analysis.constituents as Array<JsonRecord>;
      return {
        summary: `${constituents.length} constituents fitted by least squares; form factor ${estimates.formFactor ?? "unavailable"} (${estimates.tidalRegime ?? "regime undetermined"}); residual RMSE ${estimates.residualRootMeanSquare}.`,
        observations: [
          { label: "Constituents fitted", value: constituents.length, unit: "count" },
          { label: "Mean level Z0", value: estimates.meanLevel as number, unit: (analysis.source as JsonRecord).valueUnit as string },
          { label: "Residual RMSE", value: estimates.residualRootMeanSquare as number, unit: (analysis.source as JsonRecord).valueUnit as string },
        ],
      };
    },
  },
  {
    id: "agentlas.earth-climate-trend-analysis", key: "climate-trend", labId: "data-visualization", mcpName: "analyze_climate_series_trend", parentKind: "table", pluginFunction: "analyzeClimateTrend",
    defaultTitle: () => "Sea-level / climate trend analysis",
    summarize: (analysis) => {
      const ols = analysis.ols as JsonRecord;
      const serial = analysis.serialCorrelation as JsonRecord;
      const mk = analysis.mannKendall as JsonRecord;
      const sen = analysis.sen as JsonRecord;
      const unit = (analysis.source as JsonRecord).valueUnit as string;
      return {
        summary: `OLS trend ${ols.slopePerYear} ${unit}/yr (AR(1)-adjusted SE ${serial.adjustedStandardError}); Mann–Kendall z=${mk.zCorrected} (Hamed–Rao) p=${mk.pValueCorrected}; Sen's slope ${sen.slopePerYear} ${unit}/yr.`,
        observations: [
          { label: "OLS trend", value: ols.slopePerYear as number, unit: `${unit}/year` },
          { label: "AR(1)-adjusted SE", value: serial.adjustedStandardError as number, unit: `${unit}/year` },
          { label: "Sen's slope", value: sen.slopePerYear as number, unit: `${unit}/year` },
          { label: "Mann–Kendall p (corrected)", value: mk.pValueCorrected as number, unit: null },
        ],
      };
    },
  },
  {
    id: "agentlas.earth-drought-index-analysis", key: "drought-index", labId: "data-visualization", mcpName: "analyze_drought_index", parentKind: "table", pluginFunction: "analyzeDroughtIndex",
    defaultTitle: (body) => `${String(body.index ?? "spi").toUpperCase()} drought index`,
    summarize: (analysis) => {
      const settings = analysis.settings as JsonRecord;
      const scales = analysis.scales as Record<string, JsonRecord>;
      const primary = scales[String(settings.primaryScale)];
      return {
        summary: `${String(analysis.index).toUpperCase()} at ${(settings.scales as number[]).join("/")}-month scales; primary scale ${settings.primaryScale} has ${(primary.events as unknown[]).length} drought events over ${primary.valuedMonths} valued months.`,
        observations: [
          { label: "Primary scale", value: settings.primaryScale as number, unit: "month" },
          { label: "Drought events (primary)", value: (primary.events as unknown[]).length, unit: "count" },
          { label: "Valued months (primary)", value: primary.valuedMonths as number, unit: "count" },
        ],
      };
    },
  },
  {
    id: "agentlas.earth-flood-frequency-analysis", key: "flood-frequency", labId: "data-visualization", mcpName: "analyze_flood_frequency", parentKind: "table", pluginFunction: "analyzeFloodFrequency",
    defaultTitle: () => "Flood frequency analysis",
    summarize: (analysis) => {
      const quantiles = analysis.quantiles as Array<JsonRecord>;
      const hundred = quantiles.find((row) => row.returnPeriod === 100) ?? quantiles[quantiles.length - 1];
      const unit = (analysis.source as JsonRecord).flowUnit as string;
      return {
        summary: `LP3 (Bulletin 17B), Gumbel, and GEV quantiles for ${quantiles.length} return periods from ${(analysis.source as JsonRecord).peakCount} annual peaks; T=${hundred.returnPeriod}: LP3 ${hundred.logPearson3} ${unit} [${hundred.logPearson3Lower}, ${hundred.logPearson3Upper}].`,
        observations: [
          { label: `LP3 T=${hundred.returnPeriod}`, value: hundred.logPearson3 as number, unit },
          { label: `Gumbel T=${hundred.returnPeriod}`, value: hundred.gumbel as number, unit },
          { label: `GEV T=${hundred.returnPeriod}`, value: hundred.gev as number, unit },
        ],
      };
    },
  },
  {
    id: "agentlas.earth-isochron-analysis", key: "isochron", labId: "data-visualization", mcpName: "analyze_isochron_age", parentKind: "table", pluginFunction: "analyzeIsochron",
    defaultTitle: (body) => `${String(body.system ?? "isochron")} isochron age`,
    summarize: (analysis) => {
      const age = analysis.age as JsonRecord;
      const regression = analysis.regression as JsonRecord;
      return {
        summary: `York (2004) isochron age ${age.value} ± ${age.uncertainty} ${age.unit}; initial ratio ${age.initialRatio}; MSWD ${regression.mswd} (${regression.classification}).`,
        observations: [
          { label: "Age", value: age.value as number, unit: age.unit as string },
          { label: "Age uncertainty", value: age.uncertainty as number, unit: age.unit as string },
          { label: "Initial ratio", value: age.initialRatio as number, unit: null },
          { label: "MSWD", value: regression.mswd as number, unit: null },
        ],
      };
    },
  },
  {
    id: "agentlas.earth-tas-classification", key: "tas-classification", labId: "data-visualization", mcpName: "classify_volcanic_rocks_tas", parentKind: "table", pluginFunction: "analyzeTasClassification",
    defaultTitle: () => "TAS classification and AFM coordinates",
    summarize: (analysis) => {
      const counts = analysis.fieldCounts as Record<string, number>;
      return {
        summary: `${(analysis.samples as unknown[]).length} samples classified on the Le Bas et al. (1986) TAS diagram: ${Object.entries(counts).map(([field, count]) => `${field} ×${count}`).join(", ")}.`,
        observations: [{ label: "Samples", value: (analysis.samples as unknown[]).length, unit: "count" }, { label: "Fields occupied", value: Object.keys(counts).length, unit: "count" }],
      };
    },
  },
  {
    id: "agentlas.earth-spatial-autocorrelation-analysis", key: "spatial-autocorrelation", labId: "data-visualization", mcpName: "analyze_spatial_autocorrelation", parentKind: "table", pluginFunction: "analyzeSpatialAutocorrelation",
    defaultTitle: () => "Spatial autocorrelation (Moran, Geary, LISA)",
    summarize: (analysis) => {
      const moran = analysis.moran as JsonRecord;
      const geary = analysis.geary as JsonRecord;
      return {
        summary: `Moran's I=${moran.observed} (z=${moran.z}, p=${moran.pValue}); Geary's C=${geary.observed} (z=${geary.z}); LISA clusters: ${JSON.stringify((analysis.local as JsonRecord).clusterCounts)}.`,
        observations: [
          { label: "Moran's I", value: moran.observed as number, unit: null },
          { label: "Moran z", value: moran.z as number, unit: null },
          { label: "Geary's C", value: geary.observed as number, unit: null },
        ],
      };
    },
  },
];

const TOOL_BY_ID = new Map(TOOL_SPECS.map((spec) => [spec.id, spec]));

export const EARTH_ANALYSIS_TOOL_IDS: readonly string[] = TOOL_SPECS.map((spec) => spec.id);

export function isEarthAnalysisToolId(value: string): boolean {
  return TOOL_BY_ID.has(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function fail(code: string): never {
  throw new Error(code);
}

function exactTitle(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") fail("science-earth-analysis-title-invalid");
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/u.test(normalized)) fail("science-earth-analysis-title-invalid");
  return normalized;
}

function earthRuntime(): EarthRuntime {
  const runtime = loadSciencePluginRuntime<Partial<EarthRuntime>>(
    "agentlas-earth-science",
    "runtime/earth-science.cjs",
    32 * 1024 * 1024,
  ).runtime;
  if (runtime.PLUGIN_VERSION !== EARTH_ANALYSIS_PLUGIN_VERSION) fail("science-earth-analysis-runtime-invalid");
  for (const spec of TOOL_SPECS) if (typeof runtime[spec.pluginFunction] !== "function") fail("science-earth-analysis-runtime-invalid");
  return runtime as EarthRuntime;
}

// ---------------------------------------------------------------------------
// Body (snake_case MCP) → plugin request (camelCase) projection
// ---------------------------------------------------------------------------

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], code: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(code);
}

function optional<T>(value: unknown, transform: (item: unknown) => T): T | undefined {
  return value === undefined ? undefined : transform(value);
}

function asNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code);
  return value;
}

function asNullableNumber(value: unknown, code: string): number | null {
  return value === null ? null : asNumber(value, code);
}

function asInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) fail(code);
  return value as number;
}

function asText(value: unknown, code: string, maximum = 80): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function asNullableText(value: unknown, code: string, maximum = 80): string | null {
  return value === null ? null : asText(value, code, maximum);
}

function asBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function asNumberArray(value: unknown, code: string): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) fail(code);
  return value.map((item) => asNumber(item, code));
}

function asNullableNumberArray(value: unknown, code: string): number[] | null {
  return value === null ? null : asNumberArray(value, code);
}

function asStringArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) fail(code);
  return value.map((item) => asText(item, code));
}

interface TableParentSpec {
  sourceTable: { artifactId: string; artifactVersion: number; contentSha256: string };
  columns: Record<string, string>;
}

function tableParentSpec(body: JsonRecord, columnKeys: { required: string[]; optional: string[] }, code: string): TableParentSpec {
  const source = record(body.source_table, `${code}-source-table-invalid`);
  exactKeys(source, ["artifact_id", "artifact_version", "content_sha256"], `${code}-source-table-invalid`);
  const artifactId = asText(source.artifact_id, `${code}-source-table-invalid`, 120);
  const artifactVersion = asInteger(source.artifact_version, `${code}-source-table-invalid`);
  const contentSha256 = asText(source.content_sha256, `${code}-source-table-invalid`, 64);
  if (artifactVersion < 1 || !/^[a-f0-9]{64}$/u.test(contentSha256)) fail(`${code}-source-table-invalid`);
  const columnsRecord = record(body.columns, `${code}-columns-invalid`);
  exactKeys(columnsRecord, [...columnKeys.required, ...columnKeys.optional], `${code}-columns-invalid`);
  const columns: Record<string, string> = {};
  for (const key of columnKeys.required) columns[key] = asText(columnsRecord[key], `${code}-columns-invalid`, 240);
  for (const key of columnKeys.optional) if (columnsRecord[key] !== undefined && columnsRecord[key] !== null) columns[key] = asText(columnsRecord[key], `${code}-columns-invalid`, 240);
  const names = Object.values(columns);
  if (new Set(names.map((name) => name.toLocaleLowerCase("en-US"))).size !== names.length) fail(`${code}-columns-duplicate`);
  return { sourceTable: { artifactId, artifactVersion, contentSha256 }, columns };
}

type ResolvedTable = { payload: ScienceDatasetTablePayload; columnIndex: Map<string, ScienceDatasetTablePayload["columns"][number]> };

function tableColumn(table: ResolvedTable, name: string, code: string): ScienceDatasetTablePayload["columns"][number] {
  const column = table.columnIndex.get(name.toLocaleLowerCase("en-US"));
  if (!column) fail(`${code}-column-missing`);
  return column;
}

function numberCell(row: Record<string, ScienceDatasetCell>, column: ScienceDatasetTablePayload["columns"][number], code: string, nullable: boolean): number | null {
  const cell = row[column.name];
  if (cell === null || cell === undefined) { if (nullable) return null; fail(`${code}-cell-null`); }
  if (typeof cell === "number" && Number.isFinite(cell)) return cell;
  if (typeof cell === "string" && cell.trim() && Number.isFinite(Number(cell))) return Number(cell);
  fail(`${code}-cell-not-numeric`);
}

function textCell(row: Record<string, ScienceDatasetCell>, column: ScienceDatasetTablePayload["columns"][number], code: string): string {
  const cell = row[column.name];
  if (cell === null || cell === undefined) fail(`${code}-cell-null`);
  return String(cell);
}

interface ProjectedRequest {
  title: string;
  parent: { kind: "earthquake-catalog"; catalogRunId: string } | { kind: "table"; spec: TableParentSpec };
  pluginInput: (context: { catalog?: JsonRecord; table?: ResolvedTable; sourceContentSha256?: string }) => JsonRecord;
  descriptorSettings: JsonRecord;
}

function catalogBody(body: JsonRecord, allowed: string[], code: string): string {
  exactKeys(body, ["tool_call_id", "catalog_run_id", "title", ...allowed], `${code}-input-invalid`);
  return asText(body.catalog_run_id, `${code}-catalog-run-id-invalid`, 120);
}

function projectRequest(spec: EarthAnalysisToolSpec, body: JsonRecord): ProjectedRequest {
  const code = `science-earth-${spec.key}`;
  const title = exactTitle(body.title, spec.defaultTitle(body));
  switch (spec.key) {
    case "aftershock-table-study": {
      exactKeys(body, ["tool_call_id", "source_table", "columns", "title", "completeness_start_days", "completeness_magnitude", "split_time_days", "bin_width", "rate_bin_width_days", "parameter_bounds", "confidence_level"], `${code}-input-invalid`);
      const parentSpec = tableParentSpec(body, { required: ["event_id_column", "time_days_column", "magnitude_column"], optional: [] }, code);
      const bounds = record(body.parameter_bounds, `${code}-parameter-bounds-invalid`);
      exactKeys(bounds, ["p_min", "p_max", "c_min_days", "c_max_days"], `${code}-parameter-bounds-invalid`);
      const settings: JsonRecord = {
        completenessStartDays: asNumber(body.completeness_start_days, `${code}-completeness-start-invalid`),
        completenessMagnitude: asNumber(body.completeness_magnitude, `${code}-completeness-magnitude-invalid`),
        splitTimeDays: asNumber(body.split_time_days, `${code}-split-time-invalid`),
        binWidth: optional(body.bin_width, (value) => asNumber(value, `${code}-bin-width-invalid`)) ?? 0.01,
        rateBinWidthDays: asNumber(body.rate_bin_width_days, `${code}-rate-bin-width-invalid`),
        parameterBounds: {
          pMin: asNumber(bounds.p_min, `${code}-parameter-bounds-invalid`),
          pMax: asNumber(bounds.p_max, `${code}-parameter-bounds-invalid`),
          cMinDays: asNumber(bounds.c_min_days, `${code}-parameter-bounds-invalid`),
          cMaxDays: asNumber(bounds.c_max_days, `${code}-parameter-bounds-invalid`),
        },
        confidenceLevel: optional(body.confidence_level, (value) => asNumber(value, `${code}-confidence-level-invalid`)) ?? 0.95,
      };
      return {
        title,
        parent: { kind: "table", spec: parentSpec },
        descriptorSettings: settings,
        pluginInput: ({ table, sourceContentSha256 }) => {
          const idColumn = tableColumn(table!, parentSpec.columns.event_id_column!, `${code}-event-id`);
          const timeColumn = tableColumn(table!, parentSpec.columns.time_days_column!, `${code}-time`);
          const magnitudeColumn = tableColumn(table!, parentSpec.columns.magnitude_column!, `${code}-magnitude`);
          return {
            sourceContentSha256,
            sourceTableSha256: table!.payload.receipts.tableSha256,
            events: table!.payload.rows.map((row) => ({
              id: textCell(row, idColumn, `${code}-event-id`),
              timeDays: numberCell(row, timeColumn, `${code}-time`, false),
              magnitude: numberCell(row, magnitudeColumn, `${code}-magnitude`, false),
            })),
            ...settings,
          };
        },
      };
    }
    case "seismicity-b-value": {
      const catalogRunId = catalogBody(body, ["magnitude_type", "bin_width", "confidence_level", "completeness_selection", "completeness_magnitude", "maximum_curvature_correction", "window_events", "step_events", "stability_window_bins", "return_period_magnitudes"], code);
      const settings: JsonRecord = {
        magnitudeType: asText(body.magnitude_type, `${code}-magnitude-type-invalid`, 40).toLowerCase(),
        binWidth: optional(body.bin_width, (v) => asNumber(v, `${code}-bin-width-invalid`)),
        confidenceLevel: optional(body.confidence_level, (v) => asNumber(v, `${code}-confidence-level-invalid`)),
        completenessSelection: optional(body.completeness_selection, (v) => asText(v, `${code}-completeness-selection-invalid`, 40)),
        completenessMagnitude: optional(body.completeness_magnitude, (v) => asNullableNumber(v, `${code}-completeness-magnitude-invalid`)),
        maximumCurvatureCorrection: optional(body.maximum_curvature_correction, (v) => asNumber(v, `${code}-maxc-correction-invalid`)),
        windowEvents: optional(body.window_events, (v) => asInteger(v, `${code}-window-events-invalid`)),
        stepEvents: optional(body.step_events, (v) => asInteger(v, `${code}-step-events-invalid`)),
        stabilityWindowBins: optional(body.stability_window_bins, (v) => asInteger(v, `${code}-stability-window-bins-invalid`)),
        returnPeriodMagnitudes: optional(body.return_period_magnitudes, (v) => asNullableNumberArray(v, `${code}-return-period-magnitudes-invalid`)),
      };
      return { title, parent: { kind: "earthquake-catalog", catalogRunId }, descriptorSettings: definedOnly(settings), pluginInput: ({ catalog }) => ({ catalog, ...definedOnly(settings) }) };
    }
    case "aftershock-productivity": {
      const catalogRunId = catalogBody(body, ["mainshock_time", "mainshock_magnitude", "observation_start_time", "observation_end_time", "completeness_start_time", "completeness_magnitude", "magnitude_type", "rate_bin_width_seconds", "parameter_bounds", "forecast_horizon_days", "forecast_magnitudes", "b_value", "bin_width", "background_rate_per_day", "bath_reference_difference"], code);
      const bounds = record(body.parameter_bounds, `${code}-parameter-bounds-invalid`);
      exactKeys(bounds, ["p_min", "p_max", "c_min_seconds", "c_max_seconds"], `${code}-parameter-bounds-invalid`);
      const settings: JsonRecord = {
        mainshockTime: asText(body.mainshock_time, `${code}-mainshock-time-invalid`),
        mainshockMagnitude: asNumber(body.mainshock_magnitude, `${code}-mainshock-magnitude-invalid`),
        observationStartTime: asText(body.observation_start_time, `${code}-observation-start-invalid`),
        observationEndTime: asText(body.observation_end_time, `${code}-observation-end-invalid`),
        completenessStartTime: asText(body.completeness_start_time, `${code}-completeness-start-invalid`),
        completenessMagnitude: asNumber(body.completeness_magnitude, `${code}-completeness-magnitude-invalid`),
        magnitudeType: asText(body.magnitude_type, `${code}-magnitude-type-invalid`, 40).toLowerCase(),
        rateBinWidthSeconds: asInteger(body.rate_bin_width_seconds, `${code}-rate-bin-width-invalid`),
        parameterBounds: {
          pMin: asNumber(bounds.p_min, `${code}-parameter-bounds-invalid`), pMax: asNumber(bounds.p_max, `${code}-parameter-bounds-invalid`),
          cMinSeconds: asNumber(bounds.c_min_seconds, `${code}-parameter-bounds-invalid`), cMaxSeconds: asNumber(bounds.c_max_seconds, `${code}-parameter-bounds-invalid`),
        },
        forecastHorizonDays: asNumber(body.forecast_horizon_days, `${code}-forecast-horizon-invalid`),
        forecastMagnitudes: asNumberArray(body.forecast_magnitudes, `${code}-forecast-magnitudes-invalid`),
        bValue: optional(body.b_value, (v) => asNullableNumber(v, `${code}-b-value-invalid`)),
        binWidth: optional(body.bin_width, (v) => asNumber(v, `${code}-bin-width-invalid`)),
        backgroundRatePerDay: optional(body.background_rate_per_day, (v) => asNullableNumber(v, `${code}-background-rate-invalid`)),
        bathReferenceDifference: optional(body.bath_reference_difference, (v) => asNumber(v, `${code}-bath-reference-invalid`)),
      };
      return { title, parent: { kind: "earthquake-catalog", catalogRunId }, descriptorSettings: definedOnly(settings), pluginInput: ({ catalog }) => ({ catalog, ...definedOnly(settings) }) };
    }
    case "tidal-harmonics": {
      exactKeys(body, ["tool_call_id", "source_table", "columns", "title", "value_unit", "vertical_datum", "constituents", "reference_time", "prediction_step_minutes", "prediction_start_time", "prediction_end_time"], `${code}-input-invalid`);
      const parentSpec = tableParentSpec(body, { required: ["time_column", "value_column"], optional: [] }, code);
      const settings: JsonRecord = {
        valueUnit: asText(body.value_unit, `${code}-value-unit-invalid`, 40),
        verticalDatum: optional(body.vertical_datum, (v) => asNullableText(v, `${code}-vertical-datum-invalid`, 40)),
        constituents: optional(body.constituents, (v) => (v === null ? null : asStringArray(v, `${code}-constituents-invalid`))),
        referenceTime: optional(body.reference_time, (v) => asNullableText(v, `${code}-reference-time-invalid`)),
        predictionStepMinutes: optional(body.prediction_step_minutes, (v) => asInteger(v, `${code}-prediction-step-invalid`)),
        predictionStartTime: optional(body.prediction_start_time, (v) => asNullableText(v, `${code}-prediction-start-invalid`)),
        predictionEndTime: optional(body.prediction_end_time, (v) => asNullableText(v, `${code}-prediction-end-invalid`)),
      };
      return {
        title, parent: { kind: "table", spec: parentSpec }, descriptorSettings: definedOnly(settings),
        pluginInput: ({ table, sourceContentSha256 }) => {
          const timeColumn = tableColumn(table!, parentSpec.columns.time_column!, `${code}-time`);
          const valueColumn = tableColumn(table!, parentSpec.columns.value_column!, `${code}-value`);
          return { sourceContentSha256, series: table!.payload.rows.map((row) => ({ time: textCell(row, timeColumn, `${code}-time`), value: numberCell(row, valueColumn, `${code}-value`, true) })), ...definedOnly(settings) };
        },
      };
    }
    case "climate-trend": {
      exactKeys(body, ["tool_call_id", "source_table", "columns", "title", "value_unit", "seasonal_harmonics", "confidence_level"], `${code}-input-invalid`);
      const parentSpec = tableParentSpec(body, { required: ["time_column", "value_column"], optional: [] }, code);
      const settings: JsonRecord = {
        valueUnit: asText(body.value_unit, `${code}-value-unit-invalid`, 40),
        seasonalHarmonics: optional(body.seasonal_harmonics, (v) => asInteger(v, `${code}-seasonal-harmonics-invalid`)),
        confidenceLevel: optional(body.confidence_level, (v) => asNumber(v, `${code}-confidence-level-invalid`)),
      };
      return {
        title, parent: { kind: "table", spec: parentSpec }, descriptorSettings: definedOnly(settings),
        pluginInput: ({ table, sourceContentSha256 }) => {
          const timeColumn = tableColumn(table!, parentSpec.columns.time_column!, `${code}-time`);
          const valueColumn = tableColumn(table!, parentSpec.columns.value_column!, `${code}-value`);
          return { sourceContentSha256, series: table!.payload.rows.map((row) => ({ time: numberCell(row, timeColumn, `${code}-time`, false), value: numberCell(row, valueColumn, `${code}-value`, true) })), ...definedOnly(settings) };
        },
      };
    }
    case "drought-index": {
      exactKeys(body, ["tool_call_id", "source_table", "columns", "title", "precipitation_unit", "scales", "index", "primary_scale", "reference_period"], `${code}-input-invalid`);
      const parentSpec = tableParentSpec(body, { required: ["year_column", "month_column", "precipitation_column"], optional: ["potential_evapotranspiration_column"] }, code);
      const reference = body.reference_period === undefined || body.reference_period === null ? body.reference_period : record(body.reference_period, `${code}-reference-period-invalid`);
      if (reference) exactKeys(reference, ["start_year", "end_year"], `${code}-reference-period-invalid`);
      const settings: JsonRecord = {
        precipitationUnit: asText(body.precipitation_unit, `${code}-precipitation-unit-invalid`, 40),
        scales: optional(body.scales, (v) => (v === null ? null : asNumberArray(v, `${code}-scales-invalid`))),
        index: optional(body.index, (v) => asText(v, `${code}-index-invalid`, 4)),
        primaryScale: optional(body.primary_scale, (v) => asInteger(v, `${code}-primary-scale-invalid`)),
        referencePeriod: reference === undefined ? undefined : reference === null ? null : { startYear: asInteger(reference.start_year, `${code}-reference-period-invalid`), endYear: asInteger(reference.end_year, `${code}-reference-period-invalid`) },
      };
      return {
        title, parent: { kind: "table", spec: parentSpec }, descriptorSettings: definedOnly(settings),
        pluginInput: ({ table, sourceContentSha256 }) => {
          const yearColumn = tableColumn(table!, parentSpec.columns.year_column!, `${code}-year`);
          const monthColumn = tableColumn(table!, parentSpec.columns.month_column!, `${code}-month`);
          const precipitationColumn = tableColumn(table!, parentSpec.columns.precipitation_column!, `${code}-precipitation`);
          const petColumn = parentSpec.columns.potential_evapotranspiration_column ? tableColumn(table!, parentSpec.columns.potential_evapotranspiration_column, `${code}-pet`) : null;
          return {
            sourceContentSha256,
            series: table!.payload.rows.map((row) => ({
              year: numberCell(row, yearColumn, `${code}-year`, false), month: numberCell(row, monthColumn, `${code}-month`, false),
              precipitation: numberCell(row, precipitationColumn, `${code}-precipitation`, true),
              ...(petColumn ? { potentialEvapotranspiration: numberCell(row, petColumn, `${code}-pet`, true) } : {}),
            })),
            ...definedOnly(settings),
          };
        },
      };
    }
    case "flood-frequency": {
      exactKeys(body, ["tool_call_id", "source_table", "columns", "title", "flow_unit", "return_periods", "regional_skew", "plotting_position", "confidence_level"], `${code}-input-invalid`);
      const parentSpec = tableParentSpec(body, { required: ["year_column", "flow_column"], optional: [] }, code);
      const skew = body.regional_skew === undefined || body.regional_skew === null ? body.regional_skew : record(body.regional_skew, `${code}-regional-skew-invalid`);
      if (skew) exactKeys(skew, ["value", "mean_square_error"], `${code}-regional-skew-invalid`);
      const settings: JsonRecord = {
        flowUnit: asText(body.flow_unit, `${code}-flow-unit-invalid`, 40),
        returnPeriods: optional(body.return_periods, (v) => asNullableNumberArray(v, `${code}-return-periods-invalid`)),
        regionalSkew: skew === undefined ? undefined : skew === null ? null : { value: asNumber(skew.value, `${code}-regional-skew-invalid`), meanSquareError: asNumber(skew.mean_square_error, `${code}-regional-skew-invalid`) },
        plottingPosition: optional(body.plotting_position, (v) => asText(v, `${code}-plotting-position-invalid`, 20)),
        confidenceLevel: optional(body.confidence_level, (v) => asNumber(v, `${code}-confidence-level-invalid`)),
      };
      return {
        title, parent: { kind: "table", spec: parentSpec }, descriptorSettings: definedOnly(settings),
        pluginInput: ({ table, sourceContentSha256 }) => {
          const yearColumn = tableColumn(table!, parentSpec.columns.year_column!, `${code}-year`);
          const flowColumn = tableColumn(table!, parentSpec.columns.flow_column!, `${code}-flow`);
          return { sourceContentSha256, peaks: table!.payload.rows.map((row) => ({ year: numberCell(row, yearColumn, `${code}-year`, false), flow: numberCell(row, flowColumn, `${code}-flow`, false) })), ...definedOnly(settings) };
        },
      };
    }
    case "isochron": {
      exactKeys(body, ["tool_call_id", "source_table", "columns", "title", "system", "decay_constant_per_year", "uncertainty_kind", "confidence_level", "age_unit"], `${code}-input-invalid`);
      const parentSpec = tableParentSpec(body, { required: ["id_column", "x_column", "y_column", "sigma_x_column", "sigma_y_column"], optional: ["correlation_column"] }, code);
      const settings: JsonRecord = {
        system: asText(body.system, `${code}-system-invalid`, 20),
        decayConstantPerYear: optional(body.decay_constant_per_year, (v) => asNullableNumber(v, `${code}-decay-constant-invalid`)),
        uncertaintyKind: optional(body.uncertainty_kind, (v) => asText(v, `${code}-uncertainty-kind-invalid`, 20)),
        confidenceLevel: optional(body.confidence_level, (v) => asNumber(v, `${code}-confidence-level-invalid`)),
        ageUnit: optional(body.age_unit, (v) => asText(v, `${code}-age-unit-invalid`, 4)),
      };
      return {
        title, parent: { kind: "table", spec: parentSpec }, descriptorSettings: definedOnly(settings),
        pluginInput: ({ table, sourceContentSha256 }) => {
          const idColumn = tableColumn(table!, parentSpec.columns.id_column!, `${code}-id`);
          const xColumn = tableColumn(table!, parentSpec.columns.x_column!, `${code}-x`);
          const yColumn = tableColumn(table!, parentSpec.columns.y_column!, `${code}-y`);
          const sxColumn = tableColumn(table!, parentSpec.columns.sigma_x_column!, `${code}-sigma-x`);
          const syColumn = tableColumn(table!, parentSpec.columns.sigma_y_column!, `${code}-sigma-y`);
          const rColumn = parentSpec.columns.correlation_column ? tableColumn(table!, parentSpec.columns.correlation_column, `${code}-correlation`) : null;
          return {
            sourceContentSha256,
            samples: table!.payload.rows.map((row) => ({
              id: textCell(row, idColumn, `${code}-id`), x: numberCell(row, xColumn, `${code}-x`, false), y: numberCell(row, yColumn, `${code}-y`, false),
              sigmaX: numberCell(row, sxColumn, `${code}-sigma-x`, false), sigmaY: numberCell(row, syColumn, `${code}-sigma-y`, false),
              ...(rColumn ? { correlation: numberCell(row, rColumn, `${code}-correlation`, true) } : {}),
            })),
            ...definedOnly(settings),
          };
        },
      };
    }
    case "tas-classification": {
      const oxides = ["sio2", "tio2", "al2o3", "fe2o3", "feo", "mno", "mgo", "cao", "na2o", "k2o", "p2o5", "loi", "h2o", "co2"];
      exactKeys(body, ["tool_call_id", "source_table", "columns", "title", "normalize_to_anhydrous"], `${code}-input-invalid`);
      const parentSpec = tableParentSpec(body, { required: ["id_column", "sio2_column", "na2o_column", "k2o_column"], optional: oxides.filter((oxide) => !["sio2", "na2o", "k2o"].includes(oxide)).map((oxide) => `${oxide}_column`) }, code);
      const settings: JsonRecord = { normalizeToAnhydrous: optional(body.normalize_to_anhydrous, (v) => asBoolean(v, `${code}-normalize-invalid`)) };
      return {
        title, parent: { kind: "table", spec: parentSpec }, descriptorSettings: definedOnly(settings),
        pluginInput: ({ table, sourceContentSha256 }) => {
          const idColumn = tableColumn(table!, parentSpec.columns.id_column!, `${code}-id`);
          const oxideColumns = oxides.map((oxide) => [oxide, parentSpec.columns[`${oxide}_column`] ? tableColumn(table!, parentSpec.columns[`${oxide}_column`]!, `${code}-${oxide}`) : null] as const);
          return {
            sourceContentSha256,
            samples: table!.payload.rows.map((row) => ({
              id: textCell(row, idColumn, `${code}-id`),
              ...Object.fromEntries(oxideColumns.filter(([, column]) => column).map(([oxide, column]) => [oxide, numberCell(row, column!, `${code}-${oxide}`, true)])),
            })),
            ...definedOnly(settings),
          };
        },
      };
    }
    case "spatial-autocorrelation": {
      exactKeys(body, ["tool_call_id", "source_table", "columns", "title", "coordinate_system", "distance_unit", "value_unit", "weights", "confidence_level"], `${code}-input-invalid`);
      const parentSpec = tableParentSpec(body, { required: ["id_column", "x_column", "y_column", "value_column"], optional: [] }, code);
      const weights = body.weights === undefined ? undefined : record(body.weights, `${code}-weights-invalid`);
      if (weights) exactKeys(weights, ["kind", "power", "bandwidth", "k", "row_standardize"], `${code}-weights-invalid`);
      const settings: JsonRecord = {
        coordinateSystem: optional(body.coordinate_system, (v) => asText(v, `${code}-coordinate-system-invalid`, 20)),
        distanceUnit: optional(body.distance_unit, (v) => asText(v, `${code}-distance-unit-invalid`, 20)),
        valueUnit: optional(body.value_unit, (v) => asNullableText(v, `${code}-value-unit-invalid`, 40)),
        weights: weights === undefined ? undefined : definedOnly({
          kind: optional(weights.kind, (v) => asText(v, `${code}-weights-invalid`, 20)),
          power: optional(weights.power, (v) => asNumber(v, `${code}-weights-invalid`)),
          bandwidth: optional(weights.bandwidth, (v) => asNullableNumber(v, `${code}-weights-invalid`)),
          k: optional(weights.k, (v) => asInteger(v, `${code}-weights-invalid`)),
          rowStandardize: optional(weights.row_standardize, (v) => asBoolean(v, `${code}-weights-invalid`)),
        }),
        confidenceLevel: optional(body.confidence_level, (v) => asNumber(v, `${code}-confidence-level-invalid`)),
      };
      return {
        title, parent: { kind: "table", spec: parentSpec }, descriptorSettings: definedOnly(settings),
        pluginInput: ({ table, sourceContentSha256 }) => {
          const idColumn = tableColumn(table!, parentSpec.columns.id_column!, `${code}-id`);
          const xColumn = tableColumn(table!, parentSpec.columns.x_column!, `${code}-x`);
          const yColumn = tableColumn(table!, parentSpec.columns.y_column!, `${code}-y`);
          const valueColumn = tableColumn(table!, parentSpec.columns.value_column!, `${code}-value`);
          return {
            sourceContentSha256,
            locations: table!.payload.rows.map((row) => ({ id: textCell(row, idColumn, `${code}-id`), x: numberCell(row, xColumn, `${code}-x`, false), y: numberCell(row, yColumn, `${code}-y`, false), value: numberCell(row, valueColumn, `${code}-value`, false) })),
            ...definedOnly(settings),
          };
        },
      };
    }
    default:
      return fail("science-earth-analysis-tool-unknown");
  }
}

function definedOnly(value: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function rounded(value: number, digits = 9): number {
  const factor = 10 ** digits;
  const result = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

function normalCdf(value: number): number {
  // Abramowitz-Stegun 7.1.26. The approximation error is below 7.5e-8,
  // which is materially smaller than the asymptotic uncertainty reported by
  // this bounded catalogue comparison.
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function analyzeAftershockTableStudy(runtime: EarthRuntime, value: JsonRecord): EarthAnalysisRecord {
  const code = "science-earth-aftershock-table-study";
  const events = Array.isArray(value.events) ? value.events.map((item) => record(item, `${code}-event-invalid`)) : fail(`${code}-events-invalid`);
  if (events.length < 50 || events.length > 2_000) fail(`${code}-events-invalid`);
  const sourceContentSha256 = asText(value.sourceContentSha256, `${code}-source-content-invalid`, 64);
  const sourceTableSha256 = asText(value.sourceTableSha256, `${code}-source-table-content-invalid`, 64);
  if (!/^[a-f0-9]{64}$/u.test(sourceContentSha256) || !/^[a-f0-9]{64}$/u.test(sourceTableSha256)) fail(`${code}-source-content-invalid`);
  const completenessStartDays = asNumber(value.completenessStartDays, `${code}-completeness-start-invalid`);
  const completenessMagnitude = asNumber(value.completenessMagnitude, `${code}-completeness-magnitude-invalid`);
  const splitTimeDays = asNumber(value.splitTimeDays, `${code}-split-time-invalid`);
  const binWidth = asNumber(value.binWidth, `${code}-bin-width-invalid`);
  const rateBinWidthDays = asNumber(value.rateBinWidthDays, `${code}-rate-bin-width-invalid`);
  const confidenceLevel = asNumber(value.confidenceLevel, `${code}-confidence-level-invalid`);
  const zCritical = runtime.NORMAL_CRITICAL_VALUES[String(confidenceLevel)];
  if (!(completenessStartDays >= 0 && completenessStartDays < 366)) fail(`${code}-completeness-start-invalid`);
  if (!(completenessMagnitude >= -2 && completenessMagnitude <= 10)) fail(`${code}-completeness-magnitude-invalid`);
  if (!(binWidth >= 0.01 && binWidth <= 1) || Math.abs(completenessMagnitude / binWidth - Math.round(completenessMagnitude / binWidth)) > 1e-8) fail(`${code}-bin-width-invalid`);
  if (!(rateBinWidthDays > 0 && rateBinWidthDays <= 31) || zCritical === undefined) fail(`${code}-analysis-settings-invalid`);
  const bounds = record(value.parameterBounds, `${code}-parameter-bounds-invalid`);
  const parameterBounds = {
    pMin: asNumber(bounds.pMin, `${code}-parameter-bounds-invalid`),
    pMax: asNumber(bounds.pMax, `${code}-parameter-bounds-invalid`),
    cMinSeconds: asNumber(bounds.cMinDays, `${code}-parameter-bounds-invalid`) * 86_400,
    cMaxSeconds: asNumber(bounds.cMaxDays, `${code}-parameter-bounds-invalid`) * 86_400,
  };
  if (!(parameterBounds.pMin >= 0.1 && parameterBounds.pMax <= 5 && parameterBounds.pMin < parameterBounds.pMax
    && parameterBounds.cMinSeconds > 0 && parameterBounds.cMinSeconds < parameterBounds.cMaxSeconds)) fail(`${code}-parameter-bounds-invalid`);

  const seen = new Set<string>();
  const normalized = events.map((event) => {
    const id = asText(event.id, `${code}-event-id-invalid`, 160);
    if (seen.has(id)) fail(`${code}-event-id-duplicate`);
    seen.add(id);
    const timeDays = asNumber(event.timeDays, `${code}-event-time-invalid`);
    const magnitude = asNumber(event.magnitude, `${code}-event-magnitude-invalid`);
    if (!(timeDays > 0 && timeDays <= 366) || magnitude < -2 || magnitude > 10) fail(`${code}-event-invalid`);
    if (Math.abs(magnitude / binWidth - Math.round(magnitude / binWidth)) > 1e-8) fail(`${code}-magnitude-bin-alignment-invalid`);
    return { id, timeDays, magnitude };
  }).sort((left, right) => left.timeDays - right.timeDays || left.id.localeCompare(right.id));
  const observationEndDays = normalized.at(-1)!.timeDays;
  if (!(splitTimeDays > completenessStartDays && splitTimeDays < observationEndDays)) fail(`${code}-split-time-invalid`);
  const selected = normalized.filter((event) => event.timeDays >= completenessStartDays && event.magnitude >= completenessMagnitude);
  const startSeconds = completenessStartDays * 86_400;
  const endSeconds = observationEndDays * 86_400;
  const eventSeconds = selected.map((event) => event.timeDays * 86_400);
  const rateBinWidthSeconds = rateBinWidthDays * 86_400;
  const binCount = Math.ceil((endSeconds - startSeconds) / rateBinWidthSeconds);
  if (binCount < 4 || binCount > 500) fail(`${code}-rate-bin-count-invalid`);
  const occupiedTimeBins = new Set(eventSeconds.map((time) => Math.min(binCount - 1, Math.floor((time - startSeconds) / rateBinWidthSeconds)))).size;
  const statusReasons: string[] = [];
  if (selected.length < 20) statusReasons.push("minimum-included-events-not-met");
  if (new Set(eventSeconds).size < 5) statusReasons.push("temporal-spread-inadequate");
  if (occupiedTimeBins < 4) statusReasons.push("minimum-occupied-time-bins-not-met");
  const fit = statusReasons.length ? null : runtime.fitBoundedOmoriUtsu(eventSeconds, startSeconds, endSeconds, parameterBounds);
  if (!fit && !statusReasons.length) statusReasons.push("numerical-fit-failed");
  if (fit?.atBoundary) statusReasons.push("parameter-estimate-at-boundary");
  const status = statusReasons.length ? (fit?.atBoundary ? "invalid" : "insufficient-data") : "complete";
  const decayRows = Array.from({ length: binCount }, (_, index) => {
    const binStartSeconds = startSeconds + index * rateBinWidthSeconds;
    const binEndSeconds = Math.min(endSeconds, binStartSeconds + rateBinWidthSeconds);
    const count = eventSeconds.filter((time) => time >= binStartSeconds && (index === binCount - 1 ? time <= binEndSeconds : time < binEndSeconds)).length;
    const expectedCount = fit ? fit.k * runtime.omoriIntegral(fit.p, fit.cSeconds, binStartSeconds, binEndSeconds) : null;
    return {
      binStartDays: rounded(binStartSeconds / 86_400),
      binEndDays: rounded(binEndSeconds / 86_400),
      centerDays: rounded((binStartSeconds + binEndSeconds) / (2 * 86_400)),
      count,
      expectedCount: expectedCount === null ? null : rounded(expectedCount),
      observedRatePerDay: count === 0 ? null : rounded(count / ((binEndSeconds - binStartSeconds) / 86_400)),
      fittedRatePerDay: expectedCount === null ? null : rounded(expectedCount / ((binEndSeconds - binStartSeconds) / 86_400)),
      pearsonResidual: expectedCount && expectedCount > 0 ? rounded((count - expectedCount) / Math.sqrt(expectedCount)) : null,
    };
  });
  const pearsonChiSquare = decayRows.reduce((sum, row) => sum + (row.pearsonResidual === null ? 0 : row.pearsonResidual ** 2), 0);

  const earlyMagnitudes = selected.filter((event) => event.timeDays < splitTimeDays).map((event) => event.magnitude);
  const laterMagnitudes = selected.filter((event) => event.timeDays >= splitTimeDays).map((event) => event.magnitude);
  if (earlyMagnitudes.length < 50 || laterMagnitudes.length < 50) fail(`${code}-b-value-window-sample-inadequate`);
  const early = runtime.akiB(earlyMagnitudes, completenessMagnitude, binWidth);
  const later = runtime.akiB(laterMagnitudes, completenessMagnitude, binWidth);
  if (!early || !later) fail(`${code}-b-value-mle-invalid`);
  const difference = early.bValue - later.bValue;
  const differenceStandardError = Math.sqrt(early.shiBoltStandardError ** 2 + later.shiBoltStandardError ** 2);
  const z = difference / differenceStandardError;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  const bValueComparison = {
    splitTimeDays,
    earlyWindow: { startDays: completenessStartDays, endDaysExclusive: splitTimeDays, sampleSize: early.sampleSize },
    laterWindow: { startDaysInclusive: splitTimeDays, endDays: observationEndDays, sampleSize: later.sampleSize },
    estimator: "Aki maximum likelihood with discrete-bin correction",
    uncertainty: "Shi and Bolt standard errors; independent-window normal approximation for the difference",
    earlyB: rounded(early.bValue),
    earlyStandardError: rounded(early.shiBoltStandardError),
    earlyConfidenceInterval: { lower: rounded(Math.max(0, early.bValue - zCritical * early.shiBoltStandardError)), upper: rounded(early.bValue + zCritical * early.shiBoltStandardError) },
    laterB: rounded(later.bValue),
    laterStandardError: rounded(later.shiBoltStandardError),
    laterConfidenceInterval: { lower: rounded(Math.max(0, later.bValue - zCritical * later.shiBoltStandardError)), upper: rounded(later.bValue + zCritical * later.shiBoltStandardError) },
    difference: rounded(difference),
    differenceStandardError: rounded(differenceStandardError),
    differenceConfidenceInterval: { lower: rounded(difference - zCritical * differenceStandardError), upper: rounded(difference + zCritical * differenceStandardError) },
    z: rounded(z),
    pValue: rounded(Math.max(0, Math.min(1, pValue)), 12),
    confidenceLevel,
  };
  const omoriUtsu = {
    status,
    statusReasons,
    includedCount: selected.length,
    occupiedTimeBins,
    binCount,
    p: fit ? rounded(fit.p) : null,
    cDays: fit ? rounded(fit.cSeconds / 86_400) : null,
    kEventsDayPower: fit ? rounded(fit.k * 86_400 ** (1 - fit.p)) : null,
    logLikelihood: fit ? rounded(fit.logLikelihood) : null,
    pearsonChiSquare: fit ? rounded(pearsonChiSquare) : null,
    degreesOfFreedom: fit ? Math.max(0, binCount - 3) : null,
    parameterBounds: { pMin: parameterBounds.pMin, pMax: parameterBounds.pMax, cMinDays: parameterBounds.cMinSeconds / 86_400, cMaxDays: parameterBounds.cMaxSeconds / 86_400 },
    parameterUncertainty: "not-computed; this bounded grid fit returns point estimates and bin-level Pearson diagnostics only",
  };
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: "Uploaded aftershock catalogue: Omori–Utsu and early/later b-value results",
    columns: [
      { id: "quantity", label: "Quantity", type: "string", unit: null },
      { id: "estimate", label: "Estimate", type: "number", unit: null },
      { id: "lower", label: `${confidenceLevel * 100}% lower`, type: "number", unit: null },
      { id: "upper", label: `${confidenceLevel * 100}% upper`, type: "number", unit: null },
      { id: "note", label: "Method / limit", type: "string", unit: null },
    ],
    rows: [
      ["Omori p", omoriUtsu.p, null, null, omoriUtsu.parameterUncertainty],
      ["Omori c (days)", omoriUtsu.cDays, null, null, omoriUtsu.parameterUncertainty],
      ["Omori K", omoriUtsu.kEventsDayPower, null, null, "events*day^(p-1); point estimate"],
      ["Early b", bValueComparison.earlyB, bValueComparison.earlyConfidenceInterval.lower, bValueComparison.earlyConfidenceInterval.upper, `${early.sampleSize} events`],
      ["Later b", bValueComparison.laterB, bValueComparison.laterConfidenceInterval.lower, bValueComparison.laterConfidenceInterval.upper, `${later.sampleSize} events`],
      ["b early - later", bValueComparison.difference, bValueComparison.differenceConfidenceInterval.lower, bValueComparison.differenceConfidenceInterval.upper, `z=${bValueComparison.z}; two-sided p=${bValueComparison.pValue}`],
    ],
  };
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: "Aftershock rate and bounded Omori–Utsu fit",
    width: 600,
    height: 340,
    background: "white",
    data: { values: decayRows },
    layer: [
      { mark: { type: "point", filled: true, color: "#2E6F62", size: 70 }, encoding: { x: { field: "centerDays", type: "quantitative", scale: { type: "log" }, title: "Days since mainshock (log)" }, y: { field: "observedRatePerDay", type: "quantitative", scale: { type: "log" }, title: "Events per day (log)" }, tooltip: [{ field: "count", type: "quantitative" }, { field: "pearsonResidual", type: "quantitative", format: ".3f" }] } },
      { mark: { type: "line", color: "#B85C38", strokeWidth: 2 }, encoding: { x: { field: "centerDays", type: "quantitative", scale: { type: "log" } }, y: { field: "fittedRatePerDay", type: "quantitative", scale: { type: "log" } } } },
    ],
  };
  const warnings = [
    "Omori–Utsu p, c, and K are bounded point estimates; parameter confidence intervals, background seismicity, secondary triggering, and forecast validation are not implemented.",
    "The b-value difference uses an independent-window normal approximation with a fixed researcher-supplied completeness threshold and split; uncertainty in Mc and the split is not propagated.",
  ];
  const contentReceipts = {
    publicationTable: { sha256: sha256(canonicalJson(publicationTable)) },
    figure: { sha256: sha256(canonicalJson(vegaLite)) },
  };
  const core = {
    schema: "agentlas.earth.uploaded-aftershock-study/v1",
    methodRevision: "bounded-omori-aki-window-comparison/v1",
    source: { provider: "Project Data Table", contentSha256: sourceContentSha256, tableSha256: sourceTableSha256, rowCount: normalized.length },
    selection: { completenessStartDays, completenessMagnitude, splitTimeDays, binWidth, rateBinWidthDays, includedCount: selected.length, earlyCount: early.sampleSize, laterCount: later.sampleSize, includedEventIdsSha256: sha256(canonicalJson(selected.map((event) => event.id).sort())) },
    omoriUtsu,
    bValueComparison,
    decayRows,
    publicationTable,
    vegaLite,
    contentReceipts,
    warnings,
    assumptions: [
      "days_since_mainshock is treated as elapsed SI days from the declared mainshock origin; no wall-clock timestamp is inferred.",
      "The same fixed magnitude-completeness threshold is applied to both b-value windows and the Omori–Utsu fit.",
      "The first window ends immediately before split_time_days; the later window begins at split_time_days.",
    ],
  };
  return { ...core, analysisSha256: sha256(canonicalJson(core)) } as EarthAnalysisRecord;
}

// ---------------------------------------------------------------------------
// Static Vega composition from the plugin's Vega-Lite subset
// ---------------------------------------------------------------------------
// The host renderer parses plain Vega and the artifact store forbids signals,
// expressions, and URL keys, so the Vega-Lite figure emitted by the plugin is
// projected into a static Vega spec: pre-filtered data arrays, explicit
// numeric domains, and one mark per layer (or per detail group).

type VlEncodingChannel = { field?: string; datum?: number; type?: string; title?: string | null; scale?: JsonRecord; axis?: null | JsonRecord };
type VlLayer = { data?: { values: JsonRecord[] }; transform?: Array<{ filter: string }>; mark: string | JsonRecord; encoding?: Record<string, VlEncodingChannel | Array<JsonRecord> | JsonRecord> };

function channel(layer: VlLayer, name: string): VlEncodingChannel | null {
  const value = layer.encoding?.[name];
  return value && !Array.isArray(value) ? value as VlEncodingChannel : null;
}

function markRecord(layer: VlLayer): JsonRecord {
  return typeof layer.mark === "string" ? { type: layer.mark } : layer.mark;
}

function applyFilters(rows: JsonRecord[], transforms: Array<{ filter: string }> | undefined): JsonRecord[] {
  let output = rows;
  for (const transform of transforms ?? []) {
    const match = /^datum\.([A-Za-z0-9_]+) != null$/u.exec(transform.filter ?? "");
    if (!match) fail("science-earth-analysis-vega-transform-unsupported");
    const field = match[1]!;
    output = output.filter((row) => row[field] !== null && row[field] !== undefined);
  }
  return output;
}

function numericValue(value: unknown, temporal: boolean): number | null {
  if (value === null || value === undefined) return null;
  if (temporal) {
    const millis = typeof value === "number" ? value : Date.parse(String(value));
    return Number.isFinite(millis) ? millis : null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function composeStaticVega(vegaLite: JsonRecord): JsonRecord {
  const layers = (Array.isArray(vegaLite.layer) ? vegaLite.layer : [vegaLite]) as VlLayer[];
  const topValues = ((vegaLite.data as { values?: JsonRecord[] } | undefined)?.values ?? []) as JsonRecord[];
  const xTemporal = layers.some((layer) => channel(layer, "x")?.type === "temporal");
  const xSpec = layers.map((layer) => channel(layer, "x")).find((item) => item?.field) ?? null;
  const ySpec = layers.map((layer) => channel(layer, "y")).find((item) => item?.field) ?? null;
  const yLog = layers.some((layer) => (channel(layer, "y")?.scale as JsonRecord | undefined)?.type === "log");
  const xDomainExplicit = layers.map((layer) => (channel(layer, "x")?.scale as JsonRecord | undefined)?.domain).find((item) => Array.isArray(item)) as number[] | undefined;
  const yDomainExplicit = layers.map((layer) => (channel(layer, "y")?.scale as JsonRecord | undefined)?.domain).find((item) => Array.isArray(item)) as number[] | undefined;
  const yZero = layers.some((layer) => markRecord(layer).type === "bar" || (channel(layer, "y")?.scale as JsonRecord | undefined)?.zero === true);
  const xValues: number[] = [];
  const yValues: number[] = [];
  const data: JsonRecord[] = [];
  const marks: JsonRecord[] = [];
  const scales: JsonRecord[] = [
    { name: "x", type: xTemporal ? "time" : "linear", range: "width", nice: !xTemporal, zero: false },
    { name: "y", type: yLog ? "log" : "linear", range: "height", nice: !yLog, zero: yZero && !yLog },
  ];
  const legends: JsonRecord[] = [];
  layers.forEach((layer, index) => {
    const mark = markRecord(layer);
    const type = String(mark.type);
    const x = channel(layer, "x");
    const y = channel(layer, "y");
    const x2 = channel(layer, "x2");
    const y2 = channel(layer, "y2");
    const color = channel(layer, "color");
    const detail = channel(layer, "detail");
    const order = channel(layer, "order");
    const tooltipField = Array.isArray(layer.encoding?.tooltip) ? String((layer.encoding!.tooltip as JsonRecord[])[0]?.field ?? "") : "";
    const stroke = typeof mark.color === "string" ? mark.color : "#2E6F62";
    const common: JsonRecord = {};
    if (typeof mark.strokeWidth === "number") common.strokeWidth = { value: mark.strokeWidth };
    if (Array.isArray(mark.strokeDash)) common.strokeDash = { value: mark.strokeDash };
    if (type === "rule" && (x?.datum !== undefined || y?.datum !== undefined)) {
      const datum = x?.datum !== undefined ? x.datum : y!.datum!;
      const name = `layer${index}`;
      data.push({ name, values: [{ v: datum }] });
      if (x?.datum !== undefined) xValues.push(datum); else yValues.push(datum);
      marks.push({
        type: "rule", from: { data: name },
        encode: { enter: x?.datum !== undefined
          ? { x: { scale: "x", field: "v" }, y: { value: 0 }, y2: { field: { group: "height" } }, stroke: { value: stroke }, ...common }
          : { y: { scale: "y", field: "v" }, x: { value: 0 }, x2: { field: { group: "width" } }, stroke: { value: stroke }, ...common } },
      });
      return;
    }
    if (!x?.field || (!y?.field && type !== "rule")) fail("science-earth-analysis-vega-layer-unsupported");
    const rows = applyFilters(layer.data?.values ?? topValues, layer.transform).map((row) => {
      const projected: JsonRecord = { ...row };
      projected.__x = numericValue(row[x.field!], xTemporal);
      if (x2?.field) projected.__x2 = numericValue(row[x2.field], xTemporal);
      if (y?.field) projected.__y = numericValue(row[y.field], false);
      if (y2?.field) projected.__y2 = numericValue(row[y2.field], false);
      return projected;
    }).filter((row) => row.__x !== null && (y?.field ? row.__y !== null : true) && (y2?.field ? row.__y2 !== null : true) && (x2?.field ? row.__x2 !== null : true));
    for (const row of rows) {
      xValues.push(row.__x as number);
      if (row.__x2 !== undefined) xValues.push(row.__x2 as number);
      if (row.__y !== undefined) yValues.push(row.__y as number);
      if (row.__y2 !== undefined) yValues.push(row.__y2 as number);
    }
    if (order?.field) rows.sort((left, right) => Number(left[order.field!]) - Number(right[order.field!]));
    const groups = detail?.field ? [...new Set(rows.map((row) => String(row[detail.field!])))].map((key) => rows.filter((row) => String(row[detail.field!]) === key)) : [rows];
    let fillEncoding: JsonRecord = { value: stroke };
    if (color?.field) {
      const colorScale = color.scale as { domain?: string[]; range?: string[] } | undefined;
      const scaleName = `color${index}`;
      scales.push({ name: scaleName, type: "ordinal", domain: colorScale?.domain ?? [...new Set(rows.map((row) => String(row[color.field!])))], range: colorScale?.range ?? ["#2E6F62", "#B85C38", "#5C7080", "#D9A441", "#C9C5BE"] });
      fillEncoding = { scale: scaleName, field: color.field };
      if (color.title) legends.push({ fill: scaleName, title: color.title, orient: "right" });
    }
    groups.forEach((groupRows, groupIndex) => {
      const name = `layer${index}${groups.length > 1 ? `_${groupIndex}` : ""}`;
      data.push({ name, values: groupRows });
      const xEncode = { scale: "x", field: "__x" };
      const yEncode = { scale: "y", field: "__y" };
      if (type === "line") {
        marks.push({ type: "line", from: { data: name }, encode: { enter: { x: xEncode, y: yEncode, stroke: color?.field ? fillEncoding : { value: stroke }, strokeWidth: { value: typeof mark.strokeWidth === "number" ? mark.strokeWidth : 1.5 }, ...(typeof mark.interpolate === "string" ? { interpolate: { value: mark.interpolate } } : {}), ...(typeof mark.opacity === "number" ? { strokeOpacity: { value: mark.opacity } } : {}), ...common } } });
      } else if (type === "point") {
        const filled = mark.filled === true;
        marks.push({ type: "symbol", from: { data: name }, encode: { enter: { x: xEncode, y: yEncode, size: { value: typeof mark.size === "number" ? mark.size : 40 }, ...(filled ? { fill: fillEncoding } : { stroke: color?.field ? fillEncoding : { value: stroke }, fill: { value: "transparent" } }), ...(tooltipField ? { tooltip: { field: tooltipField } } : {}) } } });
      } else if (type === "area") {
        marks.push({ type: "area", from: { data: name }, encode: { enter: { x: xEncode, y: yEncode, y2: { scale: "y", field: y2?.field ? "__y2" : "__y" }, fill: { value: stroke }, fillOpacity: { value: typeof mark.opacity === "number" ? mark.opacity : 0.3 } } } });
      } else if (type === "bar") {
        marks.push({ type: "rect", from: { data: name }, encode: { enter: { x: xEncode, width: { value: 3 }, y: yEncode, y2: { scale: "y", value: 0 }, fill: fillEncoding, ...(tooltipField ? { tooltip: { field: tooltipField } } : {}) } } });
      } else if (type === "rule") {
        const encode: JsonRecord = { x: xEncode, stroke: { value: stroke }, ...common };
        if (x2?.field) { encode.x2 = { scale: "x", field: "__x2" }; encode.y = yEncode; }
        else { encode.y = yEncode; encode.y2 = { scale: "y", field: y2?.field ? "__y2" : "__y" }; }
        marks.push({ type: "rule", from: { data: name }, encode: { enter: encode } });
      } else {
        fail("science-earth-analysis-vega-mark-unsupported");
      }
    });
  });
  if (!xValues.length || !yValues.length) fail("science-earth-analysis-vega-empty");
  const pad = (values: number[], log: boolean): [number, number] => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (log) return [Math.max(min, Number.MIN_VALUE) / 1.1, max * 1.1];
    const span = max - min || Math.abs(max) || 1;
    return [min - span * 0.03, max + span * 0.03];
  };
  scales[0]!.domain = xDomainExplicit ?? pad(xValues, false);
  scales[1]!.domain = yDomainExplicit ?? pad(yValues, yLog);
  const axes: JsonRecord[] = [];
  if (xSpec?.axis !== null) axes.push({ orient: "bottom", scale: "x", title: xSpec?.title ?? xSpec?.field ?? "x", labelOverlap: true, ...(xTemporal ? { format: "%Y-%m-%d" } : {}) });
  if (ySpec?.axis !== null) axes.push({ orient: "left", scale: "y", title: ySpec?.title ?? ySpec?.field ?? "y", grid: true });
  const spec: JsonRecord = {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    width: typeof vegaLite.width === "number" ? vegaLite.width : 600,
    height: typeof vegaLite.height === "number" ? vegaLite.height : 340,
    padding: 16,
    background: "white",
    ...(typeof vegaLite.title === "string" ? { title: { text: vegaLite.title, fontSize: 13 } } : {}),
    data, scales, axes, marks,
    ...(legends.length ? { legends } : {}),
  };
  return spec;
}

// ---------------------------------------------------------------------------
// Parent resolution
// ---------------------------------------------------------------------------

type ResearchRun = NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>;
type RunResource = ResearchRun["outputs"][number];

interface ResolvedParent {
  parentRunId: string;
  sourceRefs: string[];
  datasetSha256: string[];
  parentArtifactRef: { artifactId: string; version: number } | null;
  entity: { id: string; label: string; type: string };
  descriptor: JsonRecord;
  inputs: Array<{ role: string; mimeType: string; byteSize: number; sha256: string; blobRef: string; artifactId: string | null; artifactVersion: number | null }>;
  pluginContext: { catalog?: JsonRecord; table?: ResolvedTable; sourceContentSha256?: string };
  sourceSummary: JsonRecord;
}

function exactEarthquakeParent(store: ScienceStore, spec: EarthAnalysisToolSpec, projectId: string, catalogRunId: string): ResolvedParent {
  const code = `science-earth-${spec.key}`;
  const run = store.getResearchRunForProject(projectId, catalogRunId);
  if (!run || run.status !== "succeeded" || run.toolId !== EARTHQUAKE_CATALOG_TOOL_ID || run.toolVersion !== EARTHQUAKE_CATALOG_TOOL_VERSION) fail(`${code}-parent-run-invalid`);
  const catalogOutput = run.outputs.find((resource: RunResource) => resource.role === "catalog-results" && resource.mimeType === "application/vnd.agentlas.earthquake-catalog-results+json");
  const rawOutput = run.outputs.find((resource: RunResource) => resource.role === "provider-response" && resource.mimeType === "application/geo+json");
  if (!catalogOutput || !rawOutput || run.outputs.length !== 2) fail(`${code}-parent-output-invalid`);
  const catalogBytes = store.readRunBlob(catalogOutput);
  const rawBytes = store.readRunBlob(rawOutput);
  let stored: EarthquakeCatalogResult;
  try { stored = JSON.parse(catalogBytes.toString("utf8")) as EarthquakeCatalogResult; } catch { return fail(`${code}-parent-output-invalid`); }
  if (stored.schema !== "agentlas.earthquake-catalog-result/v1" || stored.runId !== run.id || stored.sourceId.length < 1
    || stored.receipt.rawResponseSha256 !== rawOutput.sha256 || stored.catalog.normalizedSha256 !== stored.receipt.normalizedSha256) fail(`${code}-parent-output-invalid`);
  const source = store.getSourceVersionForProject(projectId, stored.sourceId, stored.sourceVersionId);
  if (!source || source.version.contentSha256 !== rawOutput.sha256 || source.version.accessState !== "retrieved") fail(`${code}-source-invalid`);
  const catalogBlob = store.putRunBlob(catalogBytes);
  const rawBlob = store.putRunBlob(rawBytes);
  if (catalogBlob.sha256 !== catalogOutput.sha256 || rawBlob.sha256 !== rawOutput.sha256) fail(`${code}-parent-closure-invalid`);
  const parentArtifact = store.getArtifactForSourceRun(projectId, run.id, "earthquake-observations");
  return {
    parentRunId: run.id,
    sourceRefs: [source.canonicalUri],
    datasetSha256: [rawOutput.sha256, catalogOutput.sha256, String(stored.catalog.normalizedSha256)],
    parentArtifactRef: parentArtifact ? { artifactId: parentArtifact.id, version: parentArtifact.currentVersion } : null,
    entity: { id: run.id, label: stored.title, type: "usgs-earthquake-catalog" },
    descriptor: { catalogRunId: run.id, catalogOutputSha256: catalogOutput.sha256, rawResponseSha256: rawOutput.sha256 },
    inputs: [
      { role: "earthquake-catalog-parent", mimeType: catalogOutput.mimeType, ...catalogBlob, artifactId: null, artifactVersion: null },
      { role: "earthquake-provider-response", mimeType: rawOutput.mimeType, ...rawBlob, artifactId: null, artifactVersion: null },
    ],
    pluginContext: { catalog: { ...stored.catalog, query: stored.query, provenance: stored.receipt } },
    sourceSummary: { kind: "earthquake-catalog", catalogRunId: run.id, catalogOutputSha256: catalogOutput.sha256, rawResponseSha256: rawOutput.sha256 },
  };
}

function exactTableParent(store: ScienceStore, spec: EarthAnalysisToolSpec, projectId: string, parent: TableParentSpec): ResolvedParent {
  const code = `science-earth-${spec.key}`;
  const context = store.getArtifactContextForProject(projectId, parent.sourceTable.artifactId, parent.sourceTable.artifactVersion);
  if (!context || context.artifact.kind !== "table" || context.selectedVersion.contentSha256 !== parent.sourceTable.contentSha256 || !context.artifact.sourceRunId) fail(`${code}-source-artifact-invalid`);
  let payload: ScienceDatasetTablePayload;
  try { payload = validateScienceTablePayload(context.selectedVersion.payload); } catch { return fail(`${code}-source-artifact-invalid`); }
  const parentRun = store.getResearchRunForProject(projectId, context.artifact.sourceRunId);
  if (!parentRun || parentRun.status !== "succeeded") fail(`${code}-parent-run-invalid`);
  const table: ResolvedTable = { payload, columnIndex: new Map(payload.columns.map((column) => [column.name.toLocaleLowerCase("en-US"), column])) };
  const tableBlob = store.putRunBlob(Buffer.from(canonicalJson(payload), "utf8"));
  return {
    parentRunId: parentRun.id,
    sourceRefs: context.selectedVersion.provenance.sourceRefs.slice(0, 20),
    datasetSha256: [context.selectedVersion.contentSha256, payload.receipts.tableSha256],
    parentArtifactRef: { artifactId: context.artifact.id, version: context.selectedVersion.version },
    entity: { id: context.artifact.id, label: context.artifact.title, type: "science-table" },
    descriptor: { sourceTable: parent.sourceTable, columns: parent.columns, tableSha256: payload.receipts.tableSha256 },
    inputs: [{ role: "earth-source-table", mimeType: "application/vnd.agentlas.science-table+json", ...tableBlob, artifactId: context.artifact.id, artifactVersion: context.selectedVersion.version }],
    pluginContext: { table, sourceContentSha256: context.selectedVersion.contentSha256 },
    sourceSummary: { kind: "table", artifactId: context.artifact.id, artifactVersion: context.selectedVersion.version, contentSha256: context.selectedVersion.contentSha256, tableSha256: payload.receipts.tableSha256, rowCount: payload.rows.length },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ScienceEarthAnalysisService {
  constructor(private readonly store: ScienceStore) {}

  private artifactForRun(spec: EarthAnalysisToolSpec, projectId: string, runId: string, artifactSchema: string): ScienceArtifact {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, spec.labId);
    if (!artifact) fail(`science-earth-${spec.key}-replay-artifact-missing`);
    if (artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega" || artifact.version.payload.schema !== artifactSchema) fail(`science-earth-${spec.key}-artifact-replay-invalid`);
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-earth-analysis-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId, runId, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  execute(toolId: string, context: EarthAnalysisContext, body: JsonRecord): EarthAnalysisResult {
    const spec = TOOL_BY_ID.get(toolId);
    if (!spec) fail("science-earth-analysis-tool-unknown");
    const code = `science-earth-${spec.key}`;
    const request = projectRequest(spec, body);
    const parent = request.parent.kind === "earthquake-catalog"
      ? exactEarthquakeParent(this.store, spec, context.projectId, request.parent.catalogRunId)
      : exactTableParent(this.store, spec, context.projectId, request.parent.spec);
    const analysisPlan = context.analysisPlan ?? null;
    if (analysisPlan) {
      const exactPlan = this.store.getAnalysisSpecForProject(context.projectId, analysisPlan.analysisSpecId);
      const expectedInput = exactPlan?.version.document.data.inputs[0];
      if (!exactPlan || exactPlan.status !== "frozen" || exactPlan.currentVersion !== analysisPlan.version
        || exactPlan.currentDocumentSha256 !== analysisPlan.contentSha256
        || parent.sourceSummary.kind !== "table" || exactPlan.version.document.data.inputs.length !== 1
        || expectedInput?.artifactId !== parent.sourceSummary.artifactId
        || expectedInput?.artifactVersion !== parent.sourceSummary.artifactVersion
        || expectedInput?.contentSha256 !== parent.sourceSummary.contentSha256) {
        fail(`${code}-analysis-plan-input-binding-invalid`);
      }
    }
    const runtime = earthRuntime();
    const pluginInput = request.pluginInput(parent.pluginContext);
    const analysis = spec.key === "aftershock-table-study"
      ? analyzeAftershockTableStudy(runtime, pluginInput)
      : runtime[spec.pluginFunction](pluginInput);
    const artifactSchema = `agentlas.science.earth-${spec.key}-artifact/v1`;
    const analysisRole = `earth-${spec.key}-analysis`;
    const analysisMime = `application/vnd.agentlas.earth.${spec.key}-analysis+json`;
    const descriptor = {
      schema: `agentlas.science-earth-${spec.key}-input/v1`,
      toolId: spec.id,
      ...parent.descriptor,
      settings: request.descriptorSettings,
      title: request.title,
    };
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const inputs = [
      { role: `earth-${spec.key}-input`, mimeType: `application/vnd.agentlas.science.earth-${spec.key}-input+json`, ...descriptorBlob, artifactId: null, artifactVersion: null },
      ...parent.inputs,
    ];
    const environmentSha256 = sha256(canonicalJson({
      policy: `earth-analysis-parent-${parent.sourceSummary.kind}-v1`,
      plugin: `agentlas-earth-science@${runtime.PLUGIN_VERSION}`,
      methodRevision: analysis.methodRevision,
      runtime: process.version,
    }));
    const created = this.store.createResearchRun({
      requestId: context.requestId, projectId: context.projectId, conversationId: context.conversationId, originMessageId: context.originMessageId,
      parentRunId: parent.parentRunId, toolId: spec.id, toolVersion: EARTH_ANALYSIS_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs)), environmentSha256, analysisPlan, inputs,
    });
    let run = this.store.getResearchRunForProject(context.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource: RunResource) => resource.role === analysisRole && resource.mimeType === analysisMime);
      if (!output) fail(`${code}-replay-output-missing`);
      const replayedAnalysis = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as EarthAnalysisRecord;
      if (replayedAnalysis.schema !== analysis.schema || replayedAnalysis.analysisSha256 !== analysis.analysisSha256) fail(`${code}-replay-output-invalid`);
      const artifact = this.artifactForRun(spec, context.projectId, run.id, artifactSchema);
      return { schema: EARTH_ANALYSIS_RESULT_SCHEMA, toolId: spec.id, runId: run.id, parentRunId: parent.parentRunId, title: request.title, analysis: replayedAnalysis, artifact, replayed: true };
    }
    if (run.status !== "running") fail(`${code}-run-${run.status}`);
    try {
      const analysisBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis), "utf8"));
      const tableBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis.publicationTable), "utf8"));
      const figureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis.vegaLite), "utf8"));
      // Validate and compose the renderable artifact before the run becomes immutable succeeded.
      // Otherwise a renderer-contract failure leaves a succeeded analysis run with no artifact.
      const spec_ = composeStaticVega(analysis.vegaLite);
      const outputs = [
        { role: analysisRole, mimeType: analysisMime, ...analysisBlob, artifactId: null, artifactVersion: null },
        { role: `earth-${spec.key}-publication-table`, mimeType: "application/vnd.agentlas.science-table+json", ...tableBlob, artifactId: null, artifactVersion: null },
        { role: `earth-${spec.key}-figure`, mimeType: "application/vnd.vegalite.v5+json", ...figureBlob, artifactId: null, artifactVersion: null },
      ];
      const summarized = spec.summarize(analysis);
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${context.requestId}:complete`), projectId: context.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: summarized.summary.slice(0, 2_000), outputs,
      }).run;
      const payload = {
        schema: artifactSchema,
        analysis,
        spec: spec_,
        source: { ...parent.sourceSummary, parentRunId: parent.parentRunId, analysisRunId: run.id, analysisSha256: analysis.analysisSha256, publicationTableSha256: tableBlob.sha256, figureSha256: figureBlob.sha256 },
      };
      const artifact = this.store.createArtifact({
        projectId: context.projectId, sourceRunId: run.id, kind: "chart.vega", title: request.title,
        rendererId: "agentlas.vega", rendererVersion: "6.4.0", rendererBinding: null, payload,
        semantic: {
          title: request.title,
          summary: summarized.summary,
          entities: [parent.entity],
          observations: summarized.observations,
          warnings: [...(analysis.warnings ?? []), ...(analysis.assumptions ?? [])],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: parent.sourceRefs,
          datasetSha256: [...parent.datasetSha256, analysis.analysisSha256, tableBlob.sha256, figureBlob.sha256],
          codeSha256: sha256(`${spec.id}@${EARTH_ANALYSIS_TOOL_VERSION}:${analysis.methodRevision}:agentlas-earth-science@${runtime.PLUGIN_VERSION}`),
          environmentSha256,
        },
        linkage: {
          labId: spec.labId,
          origin: { surface: "conversation", conversationId: context.conversationId, messageId: context.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
          parent: parent.parentArtifactRef,
          inputs: parent.parentArtifactRef ? [parent.parentArtifactRef] : [],
        },
      });
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-earth-analysis-run-artifact-binding:v1:${context.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: context.projectId, runId: run.id, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: EARTH_ANALYSIS_RESULT_SCHEMA, toolId: spec.id, runId: run.id, parentRunId: parent.parentRunId, title: request.title, analysis, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(context.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`${context.requestId}:failed`), projectId: context.projectId, runId: run.id, status: "failed",
        outputManifestSha256: sha256(canonicalJson([])), summary: error instanceof Error ? error.message.slice(0, 1_000) : `${code}-failed`, outputs: [],
      });
      throw error;
    }
  }
}

export function earthAnalysisToolSummary(result: EarthAnalysisResult): JsonRecord {
  const spec = TOOL_BY_ID.get(result.toolId)!;
  const table = result.analysis.publicationTable;
  return {
    methodRevision: result.analysis.methodRevision,
    parentRunId: result.parentRunId,
    summary: spec.summarize(result.analysis).summary,
    publicationTable: { schema: table.schema, title: table.title, rowCount: table.rows.length, contentSha256: result.analysis.contentReceipts.publicationTable?.sha256 ?? null },
    figure: { schema: "application/vnd.vegalite.v5+json", contentSha256: result.analysis.contentReceipts.figure?.sha256 ?? null },
    warnings: result.analysis.warnings ?? [],
    assumptions: result.analysis.assumptions ?? [],
    ...(result.analysis.status === undefined ? {} : { status: result.analysis.status }),
  };
}
