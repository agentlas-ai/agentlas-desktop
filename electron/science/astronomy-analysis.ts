import { createHash } from "node:crypto";
import type { ScienceArtifact } from "../../shared/science-contract";
import { SCIENCE_TABLE_ARTIFACT_KIND, SCIENCE_TABLE_LAB_ID, SCIENCE_TABLE_RENDERER_ID, validateScienceTablePayload } from "../../shared/science-table";
import { ScienceStore } from "./store";
import { loadSciencePluginRuntime, readSciencePluginFile } from "./plugin-runtime";

/**
 * Host binding for the pure Agentlas Astronomy analysis runtimes (periodicity depth,
 * BLS transit search, Galactic kinematics, colour-magnitude diagram, flat Lambda-CDM
 * cosmology, SED blackbody fit, radial-velocity Keplerian orbit).
 *
 * Every analysis reads one exact immutable Data Table artifact version (or, for the
 * cosmology calculator, only declared parameters), runs the plugin runtime in-process.
 * The depth tool applies a CommonJS require/require.resolve builtin allowlist containing
 * only node:crypto. This is a module-request boundary for the verified graph, not a process
 * sandbox: dynamic import and global fetch remain outside that boundary.
 * records a ResearchRun whose single output is the canonical analysis JSON, and
 * materializes one immutable `chart.vega` artifact carrying the publication table and
 * the Vega-Lite figure. Replays are verified against the recomputed result hash.
 */

export const ASTRONOMY_ANALYSIS_LAB_ID = "data-visualization" as const;
export const ASTRONOMY_ANALYSIS_RENDERER_ID = "agentlas.vega" as const;
export const ASTRONOMY_ANALYSIS_RENDERER_VERSION = "6.4.0" as const;
export const ASTRONOMY_ANALYSIS_ARTIFACT_SCHEMA = "agentlas.science.astronomy-analysis-artifact/v1" as const;
export const ASTRONOMY_ANALYSIS_INPUT_SCHEMA = "agentlas.science.astronomy-analysis-input/v1" as const;
export const ASTRONOMY_ANALYSIS_INPUT_ROLE = "astronomy-analysis-input" as const;
export const ASTRONOMY_ANALYSIS_INPUT_MIME = "application/vnd.agentlas.science.astronomy-analysis-input+json" as const;
export const ASTRONOMY_ANALYSIS_OUTPUT_ROLE = "astronomy-analysis-result" as const;
export const ASTRONOMY_ANALYSIS_OUTPUT_MIME = "application/vnd.agentlas.science.astronomy-analysis-result+json" as const;
export const ASTRONOMY_ANALYSIS_PLUGIN_ID = "agentlas-astronomy" as const;
export const ASTRONOMY_ANALYSIS_PLUGIN_VERSION = "1.2.2" as const;
const ASTRONOMY_DEPTH_TOOL_ID = "agentlas.astronomy-light-curve-periodicity-depth" as const;
const ASTRONOMY_DEPTH_ALLOWED_BUILTINS = ["node:crypto"] as const;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/u;

type CellType = "string" | "number" | "boolean";
interface RowField {
  /** camelCase runtime row field. */
  field: string;
  /** snake_case key in the MCP `columns` mapping. */
  key: string;
  type: CellType;
  nullable: boolean;
  optional?: boolean;
}

export interface AstronomyAnalysisToolDefinition {
  toolId: string;
  toolVersion: string;
  mcpName: string;
  runtimeModule: string;
  runtimeExport: string;
  resultSchema: string;
  /** Runtime argument that receives the projected rows; null for parameter-only tools. */
  rowsArgument: string | null;
  rowFields: RowField[];
  /** Values inserted only for fields deliberately omitted by this tool's source mapping. */
  defaultRowValues?: Readonly<Record<string, unknown>>;
  /** Runtime module dependencies whose hashes enter the environment receipt. */
  runtimeDependencies: string[];
  titleFallback: (settings: Record<string, unknown>) => string;
  summaryLine: (result: AstronomyAnalysisResult) => string;
  observations: (result: AstronomyAnalysisResult) => Array<{ label: string; value: number | string; unit: string | null }>;
}

const LIGHT_CURVE_ROWS: RowField[] = [
  { field: "observationId", key: "observation_id", type: "string", nullable: false },
  { field: "time", key: "time", type: "number", nullable: true },
  { field: "value", key: "value", type: "number", nullable: true },
  { field: "standardError", key: "standard_error", type: "number", nullable: true },
  { field: "use", key: "use", type: "boolean", nullable: false },
];

const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown): string => (typeof value === "string" ? value : String(value));

export const ASTRONOMY_ANALYSIS_TOOLS: readonly AstronomyAnalysisToolDefinition[] = Object.freeze([
  {
    toolId: "agentlas.astronomy-light-curve-periodicity-depth", toolVersion: "1.0.0", mcpName: "analyze_light_curve_periodicity_depth",
    runtimeModule: "periodicity-depth.cjs", runtimeExport: "analyzeLightCurvePeriodicityDepth", resultSchema: "agentlas.science.astronomy-light-curve-periodicity-depth-result/v1",
    rowsArgument: "measurements", rowFields: LIGHT_CURVE_ROWS, defaultRowValues: { use: true }, runtimeDependencies: ["analysis-common.cjs", "astronomy.cjs"],
    titleFallback: (settings) => `Periodicity depth · ${text(settings.targetId)}`,
    summaryLine: (result) => `GLS depth: refined period ${number(record(result.summary).refinedPeriodDays)} d, Baluev FAP ${number(record(result.summary).baluevFalseAlarmProbability)}, bootstrap FAP ${String(record(result.summary).bootstrapFalseAlarmProbability)} over ${number(record(result.summary).analysisEligibleRows)} eligible observations.`,
    observations: (result) => [
      { label: "Refined period", value: number(record(result.summary).refinedPeriodDays), unit: "day" },
      { label: "Baluev false-alarm probability", value: number(record(result.summary).baluevFalseAlarmProbability), unit: null },
      { label: "Bootstrap false-alarm probability", value: record(result.summary).bootstrapFalseAlarmProbability === null ? "not computed" : number(record(result.summary).bootstrapFalseAlarmProbability), unit: null },
      { label: "Peak HWHM period uncertainty", value: record(result.periodUncertainty).halfWidthPeriodDays === null ? "not resolved" : number(record(result.periodUncertainty).halfWidthPeriodDays), unit: "day" },
    ],
  },
  {
    toolId: "agentlas.astronomy-transit-search-bls", toolVersion: "1.0.0", mcpName: "search_light_curve_transits_bls",
    runtimeModule: "transit-search.cjs", runtimeExport: "searchLightCurveTransitsBls", resultSchema: "agentlas.science.astronomy-transit-search-bls-result/v1",
    rowsArgument: "measurements", rowFields: LIGHT_CURVE_ROWS, runtimeDependencies: ["analysis-common.cjs", "astronomy.cjs"],
    titleFallback: (settings) => `BLS transit search · ${text(settings.targetId)}`,
    summaryLine: (result) => `BLS: best period ${number(record(result.summary).bestPeriodDays)} d, duration ${number(record(result.summary).bestDurationHours)} h, depth ${number(record(result.summary).bestDepth)}, SDE ${String(record(result.summary).signalDetectionEfficiency)} over ${number(record(result.summary).analysisEligibleRows)} eligible observations.`,
    observations: (result) => [
      { label: "Best period", value: number(record(result.summary).bestPeriodDays), unit: "day" },
      { label: "Best duration", value: number(record(result.summary).bestDurationHours), unit: "hour" },
      { label: "Depth", value: number(record(result.summary).bestDepth), unit: null },
      { label: "Signal detection efficiency", value: record(result.summary).signalDetectionEfficiency === null ? "not computed" : number(record(result.summary).signalDetectionEfficiency), unit: null },
    ],
  },
  {
    toolId: "agentlas.astronomy-galactic-kinematics", toolVersion: "1.0.0", mcpName: "analyze_galactic_kinematics",
    runtimeModule: "galactic-kinematics.cjs", runtimeExport: "analyzeGalacticKinematics", resultSchema: "agentlas.science.astronomy-galactic-kinematics-result/v1",
    rowsArgument: "measurements", runtimeDependencies: ["analysis-common.cjs", "astronomy.cjs"],
    rowFields: [
      { field: "objectId", key: "object_id", type: "string", nullable: false },
      { field: "raDeg", key: "ra_deg", type: "number", nullable: true },
      { field: "decDeg", key: "dec_deg", type: "number", nullable: true },
      { field: "parallaxMas", key: "parallax_mas", type: "number", nullable: true },
      { field: "parallaxErrorMas", key: "parallax_error_mas", type: "number", nullable: true },
      { field: "pmRaMasYr", key: "pm_ra_mas_yr", type: "number", nullable: true },
      { field: "pmRaErrorMasYr", key: "pm_ra_error_mas_yr", type: "number", nullable: true },
      { field: "pmDecMasYr", key: "pm_dec_mas_yr", type: "number", nullable: true },
      { field: "pmDecErrorMasYr", key: "pm_dec_error_mas_yr", type: "number", nullable: true },
      { field: "radialVelocityKmS", key: "radial_velocity_km_s", type: "number", nullable: true },
      { field: "radialVelocityErrorKmS", key: "radial_velocity_error_km_s", type: "number", nullable: true },
      { field: "use", key: "use", type: "boolean", nullable: false },
    ],
    titleFallback: (settings) => `Galactic kinematics · ${text(settings.sampleId)}`,
    summaryLine: (result) => `UVW kinematics for ${number(record(result.summary).inferenceEligibleRows)} of ${number(record(result.summary).inputRows)} stars; membership ${JSON.stringify(record(result.summary).membershipCounts)}.`,
    observations: (result) => [
      { label: "Inference-eligible stars", value: number(record(result.summary).inferenceEligibleRows), unit: "count" },
      { label: "Median total LSR velocity", value: record(result.summary).medianTotalSpaceVelocityLsrKmS === null ? "not computed" : number(record(result.summary).medianTotalSpaceVelocityLsrKmS), unit: "km/s" },
      { label: "Thick-disc candidates", value: number(record(record(result.summary).membershipCounts)["thick-disc"]), unit: "count" },
    ],
  },
  {
    toolId: "agentlas.astronomy-colour-magnitude-diagram", toolVersion: "1.0.0", mcpName: "build_colour_magnitude_diagram",
    runtimeModule: "colour-magnitude.cjs", runtimeExport: "analyzeColourMagnitudeDiagram", resultSchema: "agentlas.science.astronomy-colour-magnitude-diagram-result/v1",
    rowsArgument: "measurements", runtimeDependencies: ["analysis-common.cjs", "astronomy.cjs"],
    rowFields: [
      { field: "objectId", key: "object_id", type: "string", nullable: false },
      { field: "parallaxMas", key: "parallax_mas", type: "number", nullable: true },
      { field: "parallaxErrorMas", key: "parallax_error_mas", type: "number", nullable: true },
      { field: "magnitude", key: "magnitude", type: "number", nullable: true },
      { field: "magnitudeError", key: "magnitude_error", type: "number", nullable: true },
      { field: "colour", key: "colour", type: "number", nullable: true },
      { field: "colourError", key: "colour_error", type: "number", nullable: true },
      { field: "extinctionMag", key: "extinction_mag", type: "number", nullable: true, optional: true },
      { field: "reddeningMag", key: "reddening_mag", type: "number", nullable: true, optional: true },
      { field: "use", key: "use", type: "boolean", nullable: false },
    ],
    titleFallback: (settings) => `Colour-magnitude diagram · ${text(settings.sampleId)}`,
    summaryLine: (result) => `CMD with ${number(record(result.summary).diagramEligibleRows)} of ${number(record(result.summary).inputRows)} stars; locus classes ${JSON.stringify(record(result.summary).locusClassCounts)}.`,
    observations: (result) => [
      { label: "Diagram-eligible stars", value: number(record(result.summary).diagramEligibleRows), unit: "count" },
      { label: "Median absolute-magnitude error", value: record(result.summary).medianAbsoluteMagnitudeError === null ? "not computed" : number(record(result.summary).medianAbsoluteMagnitudeError), unit: "mag" },
    ],
  },
  {
    toolId: "agentlas.astronomy-flat-lambda-cdm-cosmology", toolVersion: "1.0.0", mcpName: "compute_flat_lambda_cdm_cosmology",
    runtimeModule: "cosmology.cjs", runtimeExport: "computeFlatLambdaCdmCosmology", resultSchema: "agentlas.science.astronomy-flat-lambda-cdm-cosmology-result/v1",
    rowsArgument: null, rowFields: [], runtimeDependencies: ["analysis-common.cjs", "astronomy.cjs"],
    titleFallback: (settings) => `Flat Lambda-CDM · ${text(settings.label)}`,
    summaryLine: (result) => `Flat Lambda-CDM (H0 = ${number(record(result.settings).hubbleConstantKmSMpc)}, Omega_m = ${number(record(result.settings).omegaMatter)}): age ${number(record(result.summary).ageOfUniverseGyr)} Gyr, ${number(record(result.summary).explicitRedshiftCount)} explicit redshifts, ${number(record(result.summary).gridRowCount)} grid rows.`,
    observations: (result) => [
      { label: "Age of the universe", value: number(record(result.summary).ageOfUniverseGyr), unit: "Gyr" },
      { label: "Hubble distance", value: number(record(result.summary).hubbleDistanceMpc), unit: "Mpc" },
      { label: "Explicit redshifts", value: number(record(result.summary).explicitRedshiftCount), unit: "count" },
    ],
  },
  {
    toolId: "agentlas.astronomy-sed-blackbody-fit", toolVersion: "1.0.0", mcpName: "fit_sed_blackbody",
    runtimeModule: "sed-blackbody.cjs", runtimeExport: "fitBlackbodySed", resultSchema: "agentlas.science.astronomy-sed-blackbody-fit-result/v1",
    rowsArgument: "photometry", runtimeDependencies: ["analysis-common.cjs", "astronomy.cjs"],
    rowFields: [
      { field: "pointId", key: "point_id", type: "string", nullable: false },
      { field: "wavelengthMicron", key: "wavelength_micron", type: "number", nullable: false },
      { field: "fluxDensity", key: "flux_density", type: "number", nullable: true },
      { field: "fluxDensityError", key: "flux_density_error", type: "number", nullable: true },
      { field: "use", key: "use", type: "boolean", nullable: false },
    ],
    titleFallback: (settings) => `Blackbody SED fit · ${text(settings.targetId)}`,
    summaryLine: (result) => `Blackbody T = ${number(record(result.summary).temperatureK)} ± ${String(record(result.summary).temperatureErrorK)} K, chi^2 = ${number(record(result.summary).chiSquare)} for ${number(record(result.summary).degreesOfFreedom)} dof over ${number(record(result.summary).fitEligiblePoints)} points.`,
    observations: (result) => [
      { label: "Temperature", value: number(record(result.summary).temperatureK), unit: "K" },
      { label: "Temperature s.e.", value: record(result.summary).temperatureErrorK === null ? "not computed" : number(record(result.summary).temperatureErrorK), unit: "K" },
      { label: "Reduced chi-square", value: record(result.summary).reducedChiSquare === null ? "not computed" : number(record(result.summary).reducedChiSquare), unit: null },
    ],
  },
  {
    toolId: "agentlas.astronomy-radial-velocity-orbit", toolVersion: "1.0.0", mcpName: "fit_radial_velocity_orbit",
    runtimeModule: "rv-orbit.cjs", runtimeExport: "fitRadialVelocityOrbit", resultSchema: "agentlas.science.astronomy-radial-velocity-orbit-result/v1",
    rowsArgument: "measurements", runtimeDependencies: ["analysis-common.cjs", "astronomy.cjs"],
    rowFields: [
      { field: "observationId", key: "observation_id", type: "string", nullable: false },
      { field: "time", key: "time", type: "number", nullable: true },
      { field: "radialVelocityKmS", key: "radial_velocity_km_s", type: "number", nullable: true },
      { field: "standardErrorKmS", key: "standard_error_km_s", type: "number", nullable: true },
      { field: "use", key: "use", type: "boolean", nullable: false },
    ],
    titleFallback: (settings) => `Keplerian RV orbit · ${text(settings.targetId)}`,
    summaryLine: (result) => `Keplerian orbit P = ${number(record(result.summary).periodDays)} d, K = ${number(record(result.summary).semiAmplitudeKmS)} km/s, e = ${number(record(result.summary).eccentricity)}, residual RMS ${number(record(result.summary).residualRmsKmS)} km/s over ${number(record(result.summary).fitEligibleRows)} observations.`,
    observations: (result) => [
      { label: "Period", value: number(record(result.summary).periodDays), unit: "day" },
      { label: "Semi-amplitude", value: number(record(result.summary).semiAmplitudeKmS), unit: "km/s" },
      { label: "Eccentricity", value: number(record(result.summary).eccentricity), unit: null },
      { label: "Minimum mass", value: record(result.summary).minimumMassJupiter === null ? "not computed" : number(record(result.summary).minimumMassJupiter), unit: "M_Jup" },
    ],
  },
]);

export const ASTRONOMY_ANALYSIS_TOOL_IDS: readonly string[] = Object.freeze(ASTRONOMY_ANALYSIS_TOOLS.map((tool) => tool.toolId));

export function isAstronomyAnalysisToolId(toolId: string): boolean {
  return ASTRONOMY_ANALYSIS_TOOL_IDS.includes(toolId);
}

export interface AstronomyAnalysisSourceTable {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
}

export interface AstronomyAnalysisRequest {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  toolId: string;
  title?: string;
  /** Required for every table-backed tool; must be absent for parameter-only tools. */
  sourceTable?: AstronomyAnalysisSourceTable;
  /** Runtime row field (camelCase) -> table column name. */
  columns?: Record<string, string>;
  /** camelCase runtime arguments excluding sourceContentSha256 and the rows argument. */
  analysis: Record<string, unknown>;
}

export type AstronomyAnalysisResult = Record<string, unknown> & {
  schema: string;
  algorithm: Record<string, unknown>;
  settings: Record<string, unknown>;
  summary: Record<string, unknown>;
  warnings: string[];
  boundaries: string[];
  publication: { table: Record<string, unknown>; figure: Record<string, unknown> & { spec: Record<string, unknown> } };
  provenance: Record<string, unknown> & { resultSha256: string; tableSha256: string; figureSha256: string; inputSha256: string; sourceContentSha256: string };
};

export interface AstronomyAnalysisReceipt {
  schema: "agentlas.science-astronomy-analysis-result/v1";
  toolId: string;
  toolVersion: string;
  runId: string;
  parentRunId: string | null;
  title: string;
  analysis: AstronomyAnalysisResult;
  artifact: ScienceArtifact;
  replayed: boolean;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(entry[key])}`).join(",")}}`;
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

function exactTitle(value: unknown, fallback: string): string {
  if (value === undefined) return fallback.replace(/\s+/gu, " ").trim().slice(0, 240);
  if (typeof value !== "string") throw new Error("science-astronomy-analysis-title-invalid");
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error("science-astronomy-analysis-title-invalid");
  return normalized;
}

function toolDefinition(toolId: string): AstronomyAnalysisToolDefinition {
  const tool = ASTRONOMY_ANALYSIS_TOOLS.find((entry) => entry.toolId === toolId);
  if (!tool) throw new Error("science-astronomy-analysis-tool-unknown");
  return tool;
}

function loadRuntime(tool: AstronomyAnalysisToolDefinition, allowedBuiltins?: readonly string[]): { analyze: (input: Record<string, unknown>) => AstronomyAnalysisResult; runtimeSha256: Record<string, string> } {
  const loaded = loadSciencePluginRuntime<Record<string, unknown>>(
    ASTRONOMY_ANALYSIS_PLUGIN_ID,
    `runtime/${tool.runtimeModule}`,
    16 * 1024 * 1024,
    allowedBuiltins === undefined ? undefined : { allowedBuiltins },
  );
  const runtimeSha256: Record<string, string> = { [tool.runtimeModule]: loaded.sha256 };
  for (const name of tool.runtimeDependencies) {
    runtimeSha256[name] = readSciencePluginFile(ASTRONOMY_ANALYSIS_PLUGIN_ID, `runtime/${name}`, 16 * 1024 * 1024).sha256;
  }
  const analyze = loaded.runtime[tool.runtimeExport];
  if (typeof analyze !== "function") throw new Error("science-astronomy-analysis-runtime-invalid");
  return { analyze: analyze as (input: Record<string, unknown>) => AstronomyAnalysisResult, runtimeSha256 };
}

function runtimeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "";
  return /^[a-z0-9-]+$/u.test(code) ? code : "science-astronomy-analysis-failed";
}

function projectRows(tool: AstronomyAnalysisToolDefinition, table: ReturnType<typeof validateScienceTablePayload>, columns: Record<string, string>): { rows: Array<Record<string, unknown>>; exactColumns: Record<string, string> } {
  const columnByName = new Map(table.columns.map((column) => [column.name, column]));
  const exactColumns: Record<string, string> = {};
  const unknown = Object.keys(columns).filter((field) => !tool.rowFields.some((entry) => entry.field === field));
  if (unknown.length) throw new Error("science-astronomy-analysis-column-mapping-invalid");
  for (const field of tool.rowFields) {
    const name = columns[field.field];
    if (name === undefined) {
      if (Object.hasOwn(tool.defaultRowValues ?? {}, field.field)) continue;
      if (field.optional) continue;
      throw new Error(`science-astronomy-analysis-${field.key.replace(/_/gu, "-")}-column-missing`);
    }
    if (typeof name !== "string" || !name.trim() || name.length > 240 || /[\u0000-\u001f]/u.test(name)) throw new Error(`science-astronomy-analysis-${field.key.replace(/_/gu, "-")}-column-invalid`);
    const column = columnByName.get(name);
    const allowed = field.type === "number" ? ["integer", "number"] : [field.type];
    if (!column || !allowed.includes(column.logicalType) || (!field.nullable && column.nullable)) throw new Error(`science-astronomy-analysis-${field.key.replace(/_/gu, "-")}-column-invalid`);
    exactColumns[field.field] = name;
  }
  if (new Set(Object.values(exactColumns).map((name) => name.toLocaleLowerCase("en-US"))).size !== Object.keys(exactColumns).length) throw new Error("science-astronomy-analysis-column-duplicate");
  const rows = table.rows.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const field of tool.rowFields) {
      const name = exactColumns[field.field];
      if (name !== undefined) {
        projected[field.field] = row[name] ?? null;
        continue;
      }
      if (Object.hasOwn(tool.defaultRowValues ?? {}, field.field)) projected[field.field] = tool.defaultRowValues?.[field.field];
    }
    return projected;
  });
  return { rows, exactColumns };
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/gu, (_, character: string) => character.toUpperCase());
}

function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === "object") {
    const converted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) converted[snakeToCamel(key)] = camelizeKeys(entry);
    return converted;
  }
  return value;
}

export class ScienceAstronomyAnalysisService {
  constructor(private readonly store: ScienceStore) {}

  private artifactForRun(projectId: string, runId: string, tool: AstronomyAnalysisToolDefinition): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, ASTRONOMY_ANALYSIS_LAB_ID);
    if (!artifact) return null;
    if (artifact.kind !== "chart.vega" || artifact.version.rendererId !== ASTRONOMY_ANALYSIS_RENDERER_ID
      || artifact.version.payload.schema !== ASTRONOMY_ANALYSIS_ARTIFACT_SCHEMA || artifact.version.payload.toolId !== tool.toolId) {
      throw new Error("science-astronomy-analysis-artifact-replay-invalid");
    }
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-astronomy-analysis-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId, runId, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  analyze(input: AstronomyAnalysisRequest): AstronomyAnalysisReceipt {
    const tool = toolDefinition(input.toolId);
    if (!input.analysis || typeof input.analysis !== "object" || Array.isArray(input.analysis)) throw new Error("science-astronomy-analysis-input-invalid");
    if (Object.hasOwn(input.analysis, "sourceContentSha256") || (tool.rowsArgument && Object.hasOwn(input.analysis, tool.rowsArgument))) {
      throw new Error("science-astronomy-analysis-input-invalid");
    }
    const allowedBuiltins = tool.toolId === ASTRONOMY_DEPTH_TOOL_ID ? ASTRONOMY_DEPTH_ALLOWED_BUILTINS : undefined;
    const runtime = loadRuntime(tool, allowedBuiltins);

    // Resolve the exact source table (table-backed tools) and project its rows.
    let source: Record<string, unknown> | null = null;
    let parentRunId: string | null = null;
    let parentRef: { artifactId: string; version: number } | null = null;
    let rows: Array<Record<string, unknown>> | null = null;
    let sourceContentSha256: string;
    if (tool.rowsArgument) {
      const binding = input.sourceTable;
      if (!binding || typeof binding.artifactId !== "string" || !Number.isSafeInteger(binding.artifactVersion) || binding.artifactVersion < 1
        || typeof binding.contentSha256 !== "string" || !SHA256_RE.test(binding.contentSha256)) throw new Error("science-astronomy-analysis-source-binding-invalid");
      if (!input.columns || typeof input.columns !== "object" || Array.isArray(input.columns)) throw new Error("science-astronomy-analysis-column-mapping-invalid");
      const context = this.store.getArtifactContextForProject(input.projectId, binding.artifactId, binding.artifactVersion);
      if (!context || context.selectedVersion.contentSha256 !== binding.contentSha256 || context.artifact.kind !== SCIENCE_TABLE_ARTIFACT_KIND
        || context.selectedVersion.rendererId !== SCIENCE_TABLE_RENDERER_ID || context.linkage.labId !== SCIENCE_TABLE_LAB_ID || !context.artifact.sourceRunId) {
        throw new Error("science-astronomy-analysis-source-artifact-invalid");
      }
      const parentRun = this.store.getResearchRunForProject(input.projectId, context.artifact.sourceRunId);
      if (!parentRun || parentRun.status !== "succeeded") throw new Error("science-astronomy-analysis-source-run-invalid");
      let table: ReturnType<typeof validateScienceTablePayload>;
      try { table = validateScienceTablePayload(context.selectedVersion.payload); }
      catch { throw new Error("science-astronomy-analysis-source-artifact-invalid"); }
      const projected = projectRows(tool, table, input.columns);
      rows = projected.rows;
      parentRunId = parentRun.id;
      parentRef = { artifactId: context.artifact.id, version: context.selectedVersion.version };
      sourceContentSha256 = table.receipts.rawSha256;
      source = {
        kind: "data-table",
        artifact: { artifactId: context.artifact.id, artifactVersion: context.selectedVersion.version, contentSha256: context.selectedVersion.contentSha256, rawSha256: table.receipts.rawSha256, tableSha256: table.receipts.tableSha256 },
        columns: projected.exactColumns,
        rowCount: rows.length,
      };
    } else {
      if (input.sourceTable !== undefined || input.columns !== undefined) throw new Error("science-astronomy-analysis-source-not-accepted");
      sourceContentSha256 = sha256(canonicalJson(input.analysis));
      source = { kind: "declared-parameters", parameterSha256: sourceContentSha256 };
    }

    const pluginInput: Record<string, unknown> = { sourceContentSha256, ...input.analysis, ...(tool.rowsArgument ? { [tool.rowsArgument]: rows } : {}) };
    let analysis: AstronomyAnalysisResult;
    try { analysis = runtime.analyze(pluginInput); }
    catch (error) { throw new Error(runtimeErrorCode(error)); }
    if (analysis.schema !== tool.resultSchema || !analysis.publication?.table || !analysis.publication?.figure?.spec
      || analysis.provenance?.sourceContentSha256 !== sourceContentSha256 || !SHA256_RE.test(String(analysis.provenance.resultSha256))) {
      throw new Error("science-astronomy-analysis-result-invalid");
    }
    const title = exactTitle(input.title, tool.titleFallback(analysis.settings));
    const payload = {
      schema: ASTRONOMY_ANALYSIS_ARTIFACT_SCHEMA,
      toolId: tool.toolId,
      toolVersion: tool.toolVersion,
      mcpName: tool.mcpName,
      analysis,
      publication: analysis.publication,
      spec: analysis.publication.figure.spec,
      source,
    };
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (payloadBytes > MAX_PAYLOAD_BYTES) throw new Error("science-astronomy-analysis-payload-too-large");

    const descriptor = {
      schema: ASTRONOMY_ANALYSIS_INPUT_SCHEMA,
      toolId: tool.toolId,
      toolVersion: tool.toolVersion,
      title,
      runtime: { pluginId: ASTRONOMY_ANALYSIS_PLUGIN_ID, pluginVersion: ASTRONOMY_ANALYSIS_PLUGIN_VERSION, module: tool.runtimeModule, export: tool.runtimeExport, sha256: runtime.runtimeSha256 },
      source,
      pluginInput,
    };
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const inputs = [{
      role: ASTRONOMY_ANALYSIS_INPUT_ROLE, mimeType: ASTRONOMY_ANALYSIS_INPUT_MIME, ...descriptorBlob,
      artifactId: parentRef?.artifactId ?? null, artifactVersion: parentRef?.version ?? null,
    }];
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      policy: "astronomy-analysis-in-process-v1",
      toolId: tool.toolId,
      toolVersion: tool.toolVersion,
      plugin: { id: ASTRONOMY_ANALYSIS_PLUGIN_ID, version: ASTRONOMY_ANALYSIS_PLUGIN_VERSION, runtimeSha256: runtime.runtimeSha256 },
      algorithmSha256: analysis.provenance.algorithmSha256 ?? null,
      runtime: "electron-main",
      node: process.versions.node,
      networkPolicy: allowedBuiltins ? "verified-cjs-builtin-allowlist-v1" : "runtime-imports-no-network-modules",
      networkPolicyScope: allowedBuiltins
        ? "require-and-require.resolve-only; dynamic-import-and-global-fetch-outside-boundary"
        : "manifest-pinned-current-runtime-imports",
      allowedBuiltins: allowedBuiltins ?? null,
    }));
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      parentRunId, toolId: tool.toolId, toolVersion: tool.toolVersion, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs)), environmentSha256, inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === ASTRONOMY_ANALYSIS_OUTPUT_ROLE && resource.mimeType === ASTRONOMY_ANALYSIS_OUTPUT_MIME);
      if (!output) throw new Error("science-astronomy-analysis-replay-output-missing");
      const replayed = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as AstronomyAnalysisResult;
      if (replayed.schema !== analysis.schema || replayed.provenance?.resultSha256 !== analysis.provenance.resultSha256) throw new Error("science-astronomy-analysis-replay-output-invalid");
      const artifact = this.artifactForRun(input.projectId, run.id, tool);
      if (!artifact) throw new Error("science-astronomy-analysis-replay-artifact-missing");
      return { schema: "agentlas.science-astronomy-analysis-result/v1", toolId: tool.toolId, toolVersion: tool.toolVersion, runId: run.id, parentRunId, title, analysis: replayed, artifact, replayed: true };
    }
    if (run.status !== "running") throw new Error(`science-astronomy-analysis-run-${run.status}`);
    try {
      const analysisBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis), "utf8"));
      const output = { role: ASTRONOMY_ANALYSIS_OUTPUT_ROLE, mimeType: ASTRONOMY_ANALYSIS_OUTPUT_MIME, ...analysisBlob, artifactId: null, artifactVersion: null };
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson([output])), summary: tool.summaryLine(analysis).slice(0, 1_000), outputs: [output],
      }).run;
      const datasetSha256 = [
        ...(source.kind === "data-table" ? [String((source.artifact as Record<string, unknown>).rawSha256), String((source.artifact as Record<string, unknown>).tableSha256)] : []),
        analysis.provenance.inputSha256, analysis.provenance.tableSha256, analysis.provenance.figureSha256, analysis.provenance.resultSha256,
      ];
      const artifact = this.store.createArtifact({
        projectId: input.projectId, sourceRunId: run.id, kind: "chart.vega", title,
        rendererId: ASTRONOMY_ANALYSIS_RENDERER_ID, rendererVersion: ASTRONOMY_ANALYSIS_RENDERER_VERSION, rendererBinding: null,
        payload,
        semantic: {
          title,
          summary: tool.summaryLine(analysis),
          entities: [parentRef ? { id: parentRef.artifactId, label: title, type: "science-data-table" } : { id: sourceContentSha256, label: title, type: "declared-parameters" }],
          observations: tool.observations(analysis),
          warnings: [...analysis.warnings, ...analysis.boundaries],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: [],
          datasetSha256,
          codeSha256: sha256(`${tool.toolId}@${tool.toolVersion}:${ASTRONOMY_ANALYSIS_PLUGIN_ID}@${ASTRONOMY_ANALYSIS_PLUGIN_VERSION}:${canonicalJson(runtime.runtimeSha256)}`),
          environmentSha256,
        },
        linkage: {
          labId: ASTRONOMY_ANALYSIS_LAB_ID,
          origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
          parent: parentRef,
          inputs: parentRef ? [parentRef] : [],
        },
      });
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-astronomy-analysis-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId, runId: run.id, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: "agentlas.science-astronomy-analysis-result/v1", toolId: tool.toolId, toolVersion: tool.toolVersion, runId: run.id, parentRunId, title, analysis, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed",
        outputManifestSha256: sha256(canonicalJson([])), summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-astronomy-analysis-failed", outputs: [],
      });
      throw error;
    }
  }

  /** Dispatches one snake_case MCP body from the tool-control server. */
  dispatch(toolId: string, body: Record<string, unknown>, common: { requestId: string; projectId: string; conversationId: string; originMessageId: string }, tool: { id: string; version: string; labId: string; operation: string }): Record<string, unknown> {
    const definition = toolDefinition(toolId);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("science-astronomy-analysis-input-invalid");
    const { tool_call_id: _toolCallId, title, source_table: sourceTable, columns, ...analysisArguments } = body;
    const request: AstronomyAnalysisRequest = {
      requestId: common.requestId, projectId: common.projectId, conversationId: common.conversationId, originMessageId: common.originMessageId,
      toolId, ...(title === undefined ? {} : { title: title as string }),
      analysis: camelizeKeys(analysisArguments) as Record<string, unknown>,
    };
    if (definition.rowsArgument) {
      const binding = sourceTable as Record<string, unknown> | undefined;
      if (!binding || typeof binding !== "object") throw new Error("science-astronomy-analysis-source-binding-invalid");
      request.sourceTable = { artifactId: binding.artifact_id as string, artifactVersion: binding.artifact_version as number, contentSha256: binding.content_sha256 as string };
      const mapping = columns as Record<string, unknown> | undefined;
      if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error("science-astronomy-analysis-column-mapping-invalid");
      const exact: Record<string, string> = {};
      for (const [key, value] of Object.entries(mapping)) {
        const field = definition.rowFields.find((entry) => entry.key === key);
        if (!field || typeof value !== "string") throw new Error("science-astronomy-analysis-column-mapping-invalid");
        exact[field.field] = value;
      }
      request.columns = exact;
    } else if (sourceTable !== undefined || columns !== undefined) throw new Error("science-astronomy-analysis-source-not-accepted");
    const receipt = this.analyze(request);
    const { analysis } = receipt;
    return {
      ok: true,
      schema: "agentlas.science-mcp-tool-result/v2",
      tool: { id: tool.id, version: tool.version, labId: tool.labId, operation: tool.operation },
      run: { id: receipt.runId, status: "succeeded" },
      artifact: {
        id: receipt.artifact.id, version: receipt.artifact.version.version, currentVersion: receipt.artifact.currentVersion, kind: receipt.artifact.kind,
        title: receipt.artifact.title, contentSha256: receipt.artifact.version.contentSha256, labId: tool.labId,
      },
      replayed: receipt.replayed,
      parentRunId: receipt.parentRunId,
      method: { id: analysis.algorithm.id, version: analysis.algorithm.version },
      settings: analysis.settings,
      summary: analysis.summary,
      warnings: analysis.warnings,
      boundaries: analysis.boundaries,
      publicationTable: { schema: analysis.publication.table.schema, title: analysis.publication.table.title, rowCount: Array.isArray(analysis.publication.table.rows) ? analysis.publication.table.rows.length : 0, contentSha256: analysis.provenance.tableSha256 },
      figure: { schema: analysis.publication.figure.schema, title: analysis.publication.figure.title, altText: analysis.publication.figure.altText, contentSha256: analysis.provenance.figureSha256 },
      provenance: analysis.provenance,
    };
  }
}
