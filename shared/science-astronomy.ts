import { createHash } from "node:crypto";

export const SCIENCE_ASTRONOMY_SOURCE_AUTHORITY = Object.freeze({
  schema: "agentlas.astronomy.official-source/v1",
  providerId: "simbad-tap",
  databaseName: "SIMBAD Astronomical Database",
  operatorName: "Centre de Données astronomiques de Strasbourg",
  institutionCode: "CDS",
  endpoint: "https://simbad.cds.unistra.fr/simbad/sim-tap/sync",
  documentationUrl: "https://simbad.cds.unistra.fr/Pages/guide/sim-url.htx",
  access: "official-public-anonymous",
} as const);

export const SCIENCE_ASTRONOMY_RENDERER_AUTHORITY = Object.freeze({
  schema: "agentlas.astronomy.renderer-authority/v1",
  rendererId: "agentlas.d3-sky",
  rendererVersion: "7.9.0",
  packageName: "d3",
  packageVersion: "7.9.0",
  packageTarballUrl: "https://registry.npmjs.org/d3/-/d3-7.9.0.tgz",
  packageIntegrity: "sha512-e1U46jVP+w7Iut8Jt8ri1YsPOvFpg46k+K8TpCb0P+zjCkjkPnV7WzfDJzMHy1LnA+wj5pLT1wjO901gLXeEhA==",
  sourceRepositoryUrl: "https://github.com/d3/d3",
  upstreamReleaseUrl: "https://github.com/d3/d3/releases/tag/v7.9.0",
  runtimeAssetPath: "vendor/d3.min.js",
  runtimeAssetSha256: "f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539",
  licenseSpdx: "ISC",
  licenseUrl: "https://github.com/d3/d3/blob/v7.9.0/LICENSE",
  licenseAssetPath: "vendor/D3-LICENSE.txt",
  licenseAssetSha256: "3e6849627f74ff73c257a3ae1efb574015d94fc1035c05ec3c15805165efcbc4",
} as const);

export type ScienceAstronomySourceAuthority = typeof SCIENCE_ASTRONOMY_SOURCE_AUTHORITY;
export type ScienceAstronomyRendererAuthority = typeof SCIENCE_ASTRONOMY_RENDERER_AUTHORITY;

export interface ScienceAstronomyRendererReceipt extends ScienceAstronomyRendererAuthority {
  dataSha256: string;
}

export const SCIENCE_ASTRONOMY_LIGHT_CURVE_TOOL_ID = "agentlas.astronomy-light-curve-periodicity" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION = "1.2.2" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_SCHEMA = "agentlas.science.astronomy-light-curve-periodicity-input/v1" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_ARTIFACT_SCHEMA = "agentlas.science.astronomy-light-curve-periodicity-artifact/v1" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_ROLE = "astronomy-light-curve-periodicity-input" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_MIME = "application/vnd.agentlas.science.astronomy-light-curve-periodicity-input+json" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_OUTPUT_ROLE = "astronomy-light-curve-periodicity-artifact-output" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact+json" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_LAB_ID = "data-visualization" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_ID = "agentlas.vega" as const;
export const SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_VERSION = "6.4.0" as const;

export const SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS = Object.freeze({
  minimumMeasurements: 5,
  maximumMeasurements: 2_000,
  minimumFrequencyCount: 32,
  maximumFrequencyCount: 5_000,
  minimumPeaks: 1,
  maximumPeaks: 20,
} as const);

export type ScienceAstronomyLightCurveTimeSystem = "BJD_TDB" | "BJD_UTC" | "HJD_UTC" | "JD_UTC" | "MJD_UTC" | "relative-day";
export type ScienceAstronomyLightCurveValueKind = "magnitude" | "flux" | "relative-flux" | "generic";
export type ScienceAstronomyLightCurveWeighting = "auto" | "weighted" | "unweighted";

export interface ScienceAstronomyLightCurveArtifactBinding {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
  rawSha256: string;
  tableSha256: string;
}

export interface ScienceAstronomyLightCurveColumnMapping {
  observationIdColumn: string;
  timeColumn: string;
  valueColumn: string;
  standardErrorColumn: string;
  /**
   * Optional inclusion mask. Published photometry does not carry one, so requiring it refused every
   * real light curve; null means every measurement is used, and the receipt records that.
   */
  useColumn: string | null;
}

export interface ScienceAstronomyLightCurveMeasurement {
  observationId: string;
  time: number | null;
  value: number | null;
  standardError: number | null;
  use: boolean;
}

export interface ScienceAstronomyLightCurveAnalysisRequest {
  targetId: string;
  timeSystem: ScienceAstronomyLightCurveTimeSystem;
  timeOffsetDays: number;
  valueKind: ScienceAstronomyLightCurveValueKind;
  valueUnit: string | null;
  weighting: ScienceAstronomyLightCurveWeighting;
  minimumPeriodDays: number;
  maximumPeriodDays: number;
  frequencyCount: number;
  maximumPeaks: number;
}

export interface ScienceAstronomyLightCurveInputDescriptor {
  schema: typeof SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_SCHEMA;
  title: string;
  runtime: {
    pluginId: "agentlas-astronomy";
    pluginVersion: typeof SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION;
    runtimeSha256: string;
  };
  sourceTable: ScienceAstronomyLightCurveArtifactBinding;
  columns: ScienceAstronomyLightCurveColumnMapping;
  analysis: ScienceAstronomyLightCurveAnalysisRequest;
  measurements: ScienceAstronomyLightCurveMeasurement[];
}

export interface ScienceAstronomyLightCurveArtifactPayload {
  schema: typeof SCIENCE_ASTRONOMY_LIGHT_CURVE_ARTIFACT_SCHEMA;
  analysis: Record<string, unknown>;
  publication: Record<string, unknown>;
  spec: Record<string, unknown>;
  source: {
    artifact: ScienceAstronomyLightCurveArtifactBinding;
    columns: ScienceAstronomyLightCurveColumnMapping;
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("science-astronomy-canonical-number-invalid");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("science-astronomy-canonical-value-invalid");
}

function exactRecord(value: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(record).sort();
  return canonicalJson(actualKeys) === canonicalJson(expectedKeys)
    && expectedKeys.every((key) => record[key] === expected[key]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function exactSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exactText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactArtifactBinding(value: unknown): ScienceAstronomyLightCurveArtifactBinding | null {
  const item = record(value);
  if (!item || !exactKeys(item, ["artifactId", "artifactVersion", "contentSha256", "rawSha256", "tableSha256"])
    || typeof item.artifactId !== "string" || !/^[a-f0-9-]{36}$/i.test(item.artifactId)
    || !Number.isSafeInteger(item.artifactVersion) || Number(item.artifactVersion) < 1
    || !exactSha256(item.contentSha256) || !exactSha256(item.rawSha256) || !exactSha256(item.tableSha256)) return null;
  return item as unknown as ScienceAstronomyLightCurveArtifactBinding;
}

function exactColumnMapping(value: unknown): ScienceAstronomyLightCurveColumnMapping | null {
  const item = record(value);
  const keys = ["observationIdColumn", "timeColumn", "valueColumn", "standardErrorColumn", "useColumn"] as const;
  const required = keys.filter((key) => key !== "useColumn");
  if (!item || !exactKeys(item, keys)
    || required.some((key) => !exactText(item[key], 240) || item[key] !== String(item[key]).trim())) return null;
  // The mask is the one column that may be absent; when present it is held to the same rule.
  if (item.useColumn !== null && (!exactText(item.useColumn, 240) || item.useColumn !== String(item.useColumn).trim())) return null;
  const values = keys.map((key) => item[key]).filter((entry): entry is string => typeof entry === "string").map(String);
  if (new Set(values.map((entry) => entry.toLocaleLowerCase("en-US"))).size !== values.length) return null;
  return item as unknown as ScienceAstronomyLightCurveColumnMapping;
}

function exactAnalysisRequest(value: unknown): ScienceAstronomyLightCurveAnalysisRequest | null {
  const item = record(value);
  if (!item || !exactKeys(item, [
    "targetId", "timeSystem", "timeOffsetDays", "valueKind", "valueUnit", "weighting",
    "minimumPeriodDays", "maximumPeriodDays", "frequencyCount", "maximumPeaks",
  ]) || !exactText(item.targetId, 500)
    || !(["BJD_TDB", "BJD_UTC", "HJD_UTC", "JD_UTC", "MJD_UTC", "relative-day"] as const).includes(item.timeSystem as ScienceAstronomyLightCurveTimeSystem)
    || typeof item.timeOffsetDays !== "number" || !Number.isFinite(item.timeOffsetDays) || item.timeOffsetDays < -1e9 || item.timeOffsetDays > 1e9
    || !(["magnitude", "flux", "relative-flux", "generic"] as const).includes(item.valueKind as ScienceAstronomyLightCurveValueKind)
    || !(item.valueUnit === null || exactText(item.valueUnit, 80))
    || !(["auto", "weighted", "unweighted"] as const).includes(item.weighting as ScienceAstronomyLightCurveWeighting)
    || typeof item.minimumPeriodDays !== "number" || !Number.isFinite(item.minimumPeriodDays) || item.minimumPeriodDays <= 0 || item.minimumPeriodDays > 1e9
    || typeof item.maximumPeriodDays !== "number" || !Number.isFinite(item.maximumPeriodDays) || item.maximumPeriodDays <= item.minimumPeriodDays || item.maximumPeriodDays > 1e9
    || item.maximumPeriodDays / item.minimumPeriodDays > 1e9
    || !Number.isSafeInteger(item.frequencyCount) || Number(item.frequencyCount) < SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.minimumFrequencyCount || Number(item.frequencyCount) > SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.maximumFrequencyCount
    || !Number.isSafeInteger(item.maximumPeaks) || Number(item.maximumPeaks) < SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.minimumPeaks || Number(item.maximumPeaks) > SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.maximumPeaks) return null;
  return {
    targetId: String(item.targetId).trim(),
    timeSystem: item.timeSystem as ScienceAstronomyLightCurveTimeSystem,
    timeOffsetDays: Object.is(item.timeOffsetDays, -0) ? 0 : Number(item.timeOffsetDays),
    valueKind: item.valueKind as ScienceAstronomyLightCurveValueKind,
    valueUnit: item.valueUnit === null ? null : String(item.valueUnit).trim(),
    weighting: item.weighting as ScienceAstronomyLightCurveWeighting,
    minimumPeriodDays: Number(item.minimumPeriodDays),
    maximumPeriodDays: Number(item.maximumPeriodDays),
    frequencyCount: Number(item.frequencyCount),
    maximumPeaks: Number(item.maximumPeaks),
  };
}

export function validateScienceAstronomyLightCurveInputDescriptor(value: unknown): ScienceAstronomyLightCurveInputDescriptor {
  const input = record(value);
  if (!input || !exactKeys(input, ["schema", "title", "runtime", "sourceTable", "columns", "analysis", "measurements"])
    || input.schema !== SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_SCHEMA || !exactText(input.title, 240)) {
    throw new Error("science-astronomy-light-curve-input-invalid");
  }
  const runtime = record(input.runtime);
  const sourceTable = exactArtifactBinding(input.sourceTable);
  const columns = exactColumnMapping(input.columns);
  const analysis = exactAnalysisRequest(input.analysis);
  if (!runtime || !exactKeys(runtime, ["pluginId", "pluginVersion", "runtimeSha256"])
    || runtime.pluginId !== "agentlas-astronomy" || runtime.pluginVersion !== SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION
    || !exactSha256(runtime.runtimeSha256) || !sourceTable || !columns || !analysis || !Array.isArray(input.measurements)
    || input.measurements.length < SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.minimumMeasurements
    || input.measurements.length > SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.maximumMeasurements) {
    throw new Error("science-astronomy-light-curve-input-invalid");
  }
  const seen = new Set<string>();
  const measurements = input.measurements.map((value, index) => {
    const row = record(value);
    const observationId = typeof row?.observationId === "string" ? row.observationId.trim() : "";
    if (!row || !exactKeys(row, ["observationId", "time", "value", "standardError", "use"])
      || !exactText(row.observationId, 160) || seen.has(observationId)
      || !(row.time === null || (typeof row.time === "number" && Number.isFinite(row.time) && row.time >= -1e9 && row.time <= 1e9))
      || !(row.value === null || (typeof row.value === "number" && Number.isFinite(row.value) && row.value >= -1e15 && row.value <= 1e15))
      || !(row.standardError === null || (typeof row.standardError === "number" && Number.isFinite(row.standardError) && row.standardError > 0 && row.standardError <= 1e15))
      || typeof row.use !== "boolean") throw new Error(`science-astronomy-light-curve-measurement-${index}-invalid`);
    seen.add(observationId);
    return {
      observationId,
      time: row.time === null ? null : (Object.is(row.time, -0) ? 0 : Number(row.time)),
      value: row.value === null ? null : (Object.is(row.value, -0) ? 0 : Number(row.value)),
      standardError: row.standardError === null ? null : Number(row.standardError),
      use: row.use,
    };
  });
  return {
    schema: SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_SCHEMA,
    title: input.title.trim(),
    runtime: { pluginId: "agentlas-astronomy", pluginVersion: SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION, runtimeSha256: String(runtime.runtimeSha256) },
    sourceTable,
    columns,
    analysis,
    measurements,
  };
}

export function validateScienceAstronomyLightCurveArtifactPayload(value: unknown): ScienceAstronomyLightCurveArtifactPayload {
  const payload = record(value);
  if (!payload || !exactKeys(payload, ["schema", "analysis", "publication", "spec", "source"])
    || payload.schema !== SCIENCE_ASTRONOMY_LIGHT_CURVE_ARTIFACT_SCHEMA) throw new Error("science-astronomy-light-curve-artifact-invalid");
  const analysis = record(payload.analysis);
  const publication = record(payload.publication);
  const spec = record(payload.spec);
  const source = record(payload.source);
  if (!analysis || !publication || !spec || !source || !exactKeys(source, ["artifact", "columns"])) throw new Error("science-astronomy-light-curve-artifact-invalid");
  const sourceArtifact = exactArtifactBinding(source.artifact);
  const columns = exactColumnMapping(source.columns);
  const provenance = record(analysis.provenance);
  const observationsTable = record(publication?.observationsTable);
  const peaksTable = record(publication?.peaksTable);
  const periodogramTable = record(publication?.periodogramTable);
  const figure = record(publication?.figure);
  if (!sourceArtifact || !columns || analysis.schema !== "agentlas.astronomy.lomb-scargle-periodogram/v1"
    || !publication || !provenance || !observationsTable || !peaksTable || !periodogramTable || !figure
    || observationsTable.schema !== "agentlas.astronomy.light-curve-observation-table/v1"
    || peaksTable.schema !== "agentlas.astronomy.lomb-scargle-peak-table/v1"
    || periodogramTable.schema !== "agentlas.astronomy.lomb-scargle-periodogram-table/v1"
    || figure.schema !== "agentlas.astronomy.light-curve-publication-figure/v1" || figure.rendererId !== "vega-lite"
    || !record(figure.spec) || scienceAstronomySha256Json(spec) !== scienceAstronomySha256Json(figure.spec)
    || provenance.schema !== "agentlas.astronomy.analysis-provenance/v1" || provenance.pluginId !== "agentlas-astronomy"
    || !["1.2.1", SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION].includes(String(provenance.pluginVersion))
    || provenance.sourceContentSha256 !== sourceArtifact.rawSha256
    || !exactSha256(provenance.inputSha256) || !exactSha256(provenance.algorithmSha256)
    || provenance.observationsTableSha256 !== scienceAstronomySha256Json(observationsTable)
    || provenance.peaksTableSha256 !== scienceAstronomySha256Json(peaksTable)
    || provenance.periodogramTableSha256 !== scienceAstronomySha256Json(periodogramTable)
    || provenance.figureSha256 !== scienceAstronomySha256Json(figure)
    || !exactSha256(provenance.resultSha256)) throw new Error("science-astronomy-light-curve-artifact-integrity-failed");
  if (!Array.isArray(observationsTable.rows) || observationsTable.rows.length < SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.minimumMeasurements || observationsTable.rows.length > SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.maximumMeasurements
    || !Array.isArray(periodogramTable.rows) || periodogramTable.rows.length < SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.minimumFrequencyCount || periodogramTable.rows.length > SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.maximumFrequencyCount
    || !Array.isArray(peaksTable.rows) || peaksTable.rows.length < 1 || peaksTable.rows.length > SCIENCE_ASTRONOMY_LIGHT_CURVE_LIMITS.maximumPeaks) {
    throw new Error("science-astronomy-light-curve-artifact-integrity-failed");
  }
  // Historical 1.2.1 artifacts keep their immutable payloads. Newly produced
  // results must carry the method boundaries and consistent value/warning pairs.
  if (provenance.pluginVersion === SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION) {
    const fit = record(analysis.bestFit);
    const warnings = analysis.warnings;
    if (!fit || !Array.isArray(warnings) || warnings.some((item) => typeof item !== "string")
      || !Array.isArray(analysis.boundaries) || analysis.boundaries.length === 0
      || analysis.boundaries.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error("science-astronomy-light-curve-method-boundary-invalid");
    }
    for (const [field, warning] of [["falseAlarmProbability", "false-alarm-probability-not-computed"], ["periodStandardErrorDays", "period-uncertainty-not-computed"]]) {
      const value = fit[field];
      if ((value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0
        || (field === "falseAlarmProbability" && value > 1)))
        || (value === null) !== warnings.includes(warning)) {
        throw new Error("science-astronomy-light-curve-value-warning-conflict");
      }
    }
  }
  return { schema: SCIENCE_ASTRONOMY_LIGHT_CURVE_ARTIFACT_SCHEMA, analysis, publication, spec, source: { artifact: sourceArtifact, columns } };
}

export function scienceAstronomySha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function isScienceAstronomySourceAuthority(value: unknown): value is ScienceAstronomySourceAuthority {
  return exactRecord(value, SCIENCE_ASTRONOMY_SOURCE_AUTHORITY);
}

export function createScienceAstronomyRendererReceipt(data: unknown): ScienceAstronomyRendererReceipt {
  return Object.freeze({
    ...SCIENCE_ASTRONOMY_RENDERER_AUTHORITY,
    dataSha256: scienceAstronomySha256Json(data),
  });
}

export function isScienceAstronomyRendererReceipt(value: unknown, data: unknown): value is ScienceAstronomyRendererReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { dataSha256, ...authority } = value as Record<string, unknown>;
  return typeof dataSha256 === "string"
    && /^[a-f0-9]{64}$/.test(dataSha256)
    && dataSha256 === scienceAstronomySha256Json(data)
    && exactRecord(authority, SCIENCE_ASTRONOMY_RENDERER_AUTHORITY);
}
