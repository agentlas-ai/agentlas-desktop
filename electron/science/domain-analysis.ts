import { createHash } from "node:crypto";
import type { ScienceArtifact } from "../../shared/science-contract";
import { SCIENCE_MATERIALS_TOOL_ID, SCIENCE_MATERIALS_TOOL_VERSION, type ScienceMaterialsArtifactPayload } from "../../shared/science-materials";
import {
  SCIENCE_PHYSICS_HEPDATA_SOURCE_TOOL_ID,
  SCIENCE_PHYSICS_LIVE_SOURCE_TOOL_VERSION,
  type SciencePhysicsLiveArtifactPayload,
} from "../../shared/science-physics";
import { ScienceStore } from "./store";
import { EARTHQUAKE_CATALOG_TOOL_ID, EARTHQUAKE_CATALOG_TOOL_VERSION, type EarthquakeCatalogResult } from "./earthquake-catalog";
import { isOqmdJsonMimeType } from "./materials-catalog";
import { loadSciencePluginRuntime } from "./plugin-runtime";

export const EARTH_GUTENBERG_RICHTER_TOOL_ID = "agentlas.earth-gutenberg-richter-analysis";
export const EARTH_GUTENBERG_RICHTER_TOOL_VERSION = "1.0.0";
export const PHYSICS_HEPDATA_CHI_SQUARE_TOOL_ID = "agentlas.physics-hepdata-chi-square-analysis";
export const PHYSICS_HEPDATA_CHI_SQUARE_TOOL_VERSION = "1.0.0";
export const MATERIALS_LATTICE_METRICS_TOOL_ID = "agentlas.materials-lattice-metrics-analysis";
export const MATERIALS_LATTICE_METRICS_TOOL_VERSION = "1.0.0";

type GutenbergRichterResult = {
  schema: "agentlas.earth.gutenberg-richter-analysis/v1";
  methodRevision: "aki-mle-discrete-bin/v1";
  source: {
    requestUrl: string;
    rawResponseSha256: string;
    normalizedCatalogSha256: string;
  };
  selection: {
    totalEvents: number;
    includedCount: number;
    excludedCount: number;
    completenessMagnitude: number;
    binWidth: number;
    magnitudeType: string;
  };
  estimates: {
    estimator: string;
    sampleSize: number;
    aValue: number;
    bValue: number;
    standardError: number;
    confidenceLevel: number;
    confidenceInterval: { lower: number; upper: number };
  };
  publicationTable: { schema: "agentlas.science-table/v1"; rows: Array<[number, number, number, number, number]> };
  assumptions: string[];
  contentReceipts: { publicationTable: { sha256: string }; figure: { sha256: string } };
  analysisSha256: string;
};

type EarthRuntime = {
  PLUGIN_VERSION: string;
  analyzeGutenbergRichter(input: {
    catalog: Record<string, unknown>;
    completenessMagnitude: number;
    binWidth?: number;
    magnitudeType: string;
    confidenceLevel?: number;
  }): GutenbergRichterResult;
};

type HepDataNormalizedTable = Record<string, unknown> & {
  schema: "agentlas.physics.hepdata-table/v1";
  recordId: string;
  tableName: string;
  version: number;
  pointCount: number;
  normalizedSha256: string;
};

type HepDataChiSquareResult = {
  schema: "agentlas.physics.hepdata-chi-square-analysis/v1";
  sourceLineage: { normalizedTableSha256: string; recordId: string; tableName: string; version: number };
  series: { dependentSeriesIndex: number; name: string; units: string | null; predictionLabel: string };
  uncertaintyModel: { combination: string; asymmetricPolicy: string; labels: string[] };
  summary: {
    includedPointCount: number;
    excludedPointCount: number;
    fittedParameterCount: number;
    degreesOfFreedom: number;
    chiSquare: number;
    reducedChiSquare: number;
    pValue: number;
  };
  rows: Array<{ ordinal: number; x: number; observed: number | null; prediction: number | null; propagatedSigma: number | null; pull: number | null; included: boolean }>;
  publicationTable: Record<string, unknown>;
  contentReceipts: { publicationTable: { sha256: string } };
  warnings: string[];
  analysisBytes: number;
  analysisSha256: string;
};

type PhysicsRuntime = {
  normalizeHepDataTable(input: { recordId: string; tableName: string; version?: number; table: unknown }): HepDataNormalizedTable;
  analyzeHepDataChiSquare(input: {
    table: HepDataNormalizedTable;
    dependentSeriesIndex: number;
    prediction: { label: string; units: string | null; values: Array<number | null> };
    uncertaintyLabels: string[];
    fittedParameterCount?: number;
  }): HepDataChiSquareResult;
};

type LatticeMetricsResult = {
  schema: "agentlas.materials.lattice-metrics/v1";
  sourceKind: "optimade";
  sourceLineage: { normalizedSha256: string; structureId: string };
  volume: {
    angstrom3: number;
    method: string;
    validation: { status: string; declaredVolumeAngstrom3: number | null; absoluteDifferenceAngstrom3: number | null; relativeDifference: number | null; toleranceRelative: number };
  };
  density: { status: string; gramsPerCm3: number | null; formula: string | null; missingInputs: string[]; method: string | null };
  publicationTable: Record<string, unknown>;
  contentReceipts: { publicationTable: { sha256: string } };
  constants: Record<string, number>;
  warnings: string[];
  analysisSha256: string;
};

type MaterialsRuntime = {
  analyzeLatticeMetrics(input: {
    sourceKind: "optimade";
    normalized: ScienceMaterialsArtifactPayload["normalized"];
    structureId: string;
    declaredVolumeToleranceRelative?: number;
  }): LatticeMetricsResult;
};

type StoredPhysicsHepDataParent = {
  schema: "agentlas.science.physics-hepdata-live-result/v1";
  projectId: string;
  runId: string;
  recordId: string;
  tableName: string;
  version: number;
  title: string;
  recordResponseSha256: string;
  tableResponseSha256: string;
  tableSourceId: string;
  tableSourceVersionId: string;
  payload: SciencePhysicsLiveArtifactPayload;
};

type StoredMaterialsParent = {
  schema: "agentlas.science-materials-catalog-result/v1";
  projectId: string;
  runId: string;
  title: string;
  endpoint: string;
  responseSha256: string;
  sourceId: string;
  sourceVersionId: string;
  normalized: ScienceMaterialsArtifactPayload["normalized"];
};

export interface EarthGutenbergRichterInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  catalogRunId: string;
  completenessMagnitude: number;
  magnitudeType: string;
  binWidth?: number;
  confidenceLevel?: number;
  title?: string;
}

export interface EarthGutenbergRichterResult {
  schema: "agentlas.science-earth-gutenberg-richter-result/v1";
  runId: string;
  parentRunId: string;
  title: string;
  analysis: GutenbergRichterResult;
  artifact: ScienceArtifact;
  replayed: boolean;
}

export interface PhysicsHepDataChiSquareInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  tableRunId: string;
  dependentSeriesIndex: number;
  prediction: { label: string; units: string | null; values: Array<number | null> };
  uncertaintyLabels: string[];
  fittedParameterCount?: number;
  title?: string;
}

export interface PhysicsHepDataChiSquareAnalysisResult {
  schema: "agentlas.science-physics-hepdata-chi-square-result/v1";
  runId: string;
  parentRunId: string;
  title: string;
  analysis: HepDataChiSquareResult;
  artifact: ScienceArtifact;
  replayed: boolean;
}

export interface MaterialsLatticeMetricsInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  catalogRunId: string;
  structureId: string;
  declaredVolumeToleranceRelative?: number;
  title?: string;
}

export interface MaterialsLatticeMetricsAnalysisResult {
  schema: "agentlas.science-materials-lattice-metrics-result/v1";
  runId: string;
  parentRunId: string;
  title: string;
  analysis: LatticeMetricsResult;
  artifact: ScienceArtifact;
  replayed: boolean;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
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

function title(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error("science-domain-analysis-title-invalid");
  return normalized;
}

function earthRuntime(): EarthRuntime {
  const { runtime } = loadSciencePluginRuntime<Partial<EarthRuntime>>(
    "agentlas-earth-science", "runtime/earth-science.cjs", 16 * 1024 * 1024,
  );
  if (runtime.PLUGIN_VERSION !== "0.6.0" || typeof runtime.analyzeGutenbergRichter !== "function") {
    throw new Error("science-earth-gutenberg-richter-runtime-invalid");
  }
  return runtime as EarthRuntime;
}

function physicsRuntime(): PhysicsRuntime {
  const { runtime } = loadSciencePluginRuntime<Partial<PhysicsRuntime>>(
    "agentlas-physics", "runtime/physics.cjs", 16 * 1024 * 1024,
  );
  if (typeof runtime.normalizeHepDataTable !== "function" || typeof runtime.analyzeHepDataChiSquare !== "function") {
    throw new Error("science-physics-hepdata-chi-square-runtime-invalid");
  }
  return runtime as PhysicsRuntime;
}

function materialsRuntime(): MaterialsRuntime {
  const { runtime } = loadSciencePluginRuntime<Partial<MaterialsRuntime>>(
    "agentlas-materials-science", "runtime/materials-science.cjs", 16 * 1024 * 1024,
  );
  if (typeof runtime.analyzeLatticeMetrics !== "function") throw new Error("science-materials-lattice-metrics-runtime-invalid");
  return runtime as MaterialsRuntime;
}

function exactEarthquakeParent(store: ScienceStore, projectId: string, catalogRunId: string): {
  run: NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>;
  stored: EarthquakeCatalogResult;
  catalogBytes: Buffer;
  rawBytes: Buffer;
  catalogOutput: NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>["outputs"][number];
  rawOutput: NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>["outputs"][number];
} {
  const run = store.getResearchRunForProject(projectId, catalogRunId);
  if (!run || run.status !== "succeeded" || run.toolId !== EARTHQUAKE_CATALOG_TOOL_ID || run.toolVersion !== EARTHQUAKE_CATALOG_TOOL_VERSION) {
    throw new Error("science-earth-gutenberg-richter-parent-run-invalid");
  }
  const catalogOutput = run.outputs.find((resource) => resource.role === "catalog-results" && resource.mimeType === "application/vnd.agentlas.earthquake-catalog-results+json");
  const rawOutput = run.outputs.find((resource) => resource.role === "provider-response" && resource.mimeType === "application/geo+json");
  if (!catalogOutput || !rawOutput || run.outputs.length !== 2) throw new Error("science-earth-gutenberg-richter-parent-output-invalid");
  const catalogBytes = store.readRunBlob(catalogOutput);
  const rawBytes = store.readRunBlob(rawOutput);
  let stored: EarthquakeCatalogResult;
  try { stored = JSON.parse(catalogBytes.toString("utf8")) as EarthquakeCatalogResult; }
  catch { throw new Error("science-earth-gutenberg-richter-parent-output-invalid"); }
  if (stored.schema !== "agentlas.earthquake-catalog-result/v1" || stored.runId !== run.id || stored.sourceId.length < 1
    || stored.receipt.rawResponseSha256 !== rawOutput.sha256 || stored.catalog.normalizedSha256 !== stored.receipt.normalizedSha256) {
    throw new Error("science-earth-gutenberg-richter-parent-output-invalid");
  }
  const source = store.getSourceVersionForProject(projectId, stored.sourceId, stored.sourceVersionId);
  if (!source || source.version.contentSha256 !== rawOutput.sha256 || source.version.accessState !== "retrieved") {
    throw new Error("science-earth-gutenberg-richter-source-invalid");
  }
  return { run, stored, catalogBytes, rawBytes, catalogOutput, rawOutput };
}

function exactPhysicsHepDataParent(store: ScienceStore, projectId: string, tableRunId: string, runtime: PhysicsRuntime): {
  run: NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>;
  stored: StoredPhysicsHepDataParent;
  normalizedTable: HepDataNormalizedTable;
  tableBytes: Buffer;
  resultBytes: Buffer;
  tableOutput: NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>["outputs"][number];
  resultOutput: NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>["outputs"][number];
} {
  const run = store.getResearchRunForProject(projectId, tableRunId);
  if (!run || run.status !== "succeeded" || run.toolId !== SCIENCE_PHYSICS_HEPDATA_SOURCE_TOOL_ID || run.toolVersion !== SCIENCE_PHYSICS_LIVE_SOURCE_TOOL_VERSION) {
    throw new Error("science-physics-hepdata-chi-square-parent-run-invalid");
  }
  const recordOutput = run.outputs.find((resource) => resource.role === "record-response" && resource.mimeType === "application/json");
  const tableOutput = run.outputs.find((resource) => resource.role === "table-response" && resource.mimeType === "application/json");
  const resultOutput = run.outputs.find((resource) => resource.role === "physics-live-result" && resource.mimeType === "application/vnd.agentlas.science.physics-hepdata-live-result+json");
  if (!recordOutput || !tableOutput || !resultOutput || run.outputs.length !== 3) throw new Error("science-physics-hepdata-chi-square-parent-output-invalid");
  const tableBytes = store.readRunBlob(tableOutput);
  const resultBytes = store.readRunBlob(resultOutput);
  let stored: StoredPhysicsHepDataParent;
  let rawTable: unknown;
  try {
    stored = JSON.parse(resultBytes.toString("utf8")) as StoredPhysicsHepDataParent;
    rawTable = JSON.parse(tableBytes.toString("utf8"));
  } catch { throw new Error("science-physics-hepdata-chi-square-parent-output-invalid"); }
  if (stored.schema !== "agentlas.science.physics-hepdata-live-result/v1" || stored.projectId !== projectId || stored.runId !== run.id
    || stored.recordResponseSha256 !== recordOutput.sha256 || stored.tableResponseSha256 !== tableOutput.sha256
    || stored.payload?.schema !== "agentlas.science.physics-live-source-vega/v1" || stored.payload.evidence.provider !== "hepdata"
    || !stored.payload.evidence.normalizedSha256.includes(stored.payload.evidence.normalizedSha256[1] ?? "")) {
    throw new Error("science-physics-hepdata-chi-square-parent-output-invalid");
  }
  const normalizedTable = runtime.normalizeHepDataTable({ recordId: stored.recordId, tableName: stored.tableName, version: stored.version, table: rawTable });
  if (normalizedTable.normalizedSha256 !== stored.payload.evidence.normalizedSha256[1]) throw new Error("science-physics-hepdata-chi-square-normalization-mismatch");
  const source = store.getSourceVersionForProject(projectId, stored.tableSourceId, stored.tableSourceVersionId);
  if (!source || source.version.accessState !== "retrieved" || source.version.contentSha256 !== tableOutput.sha256) {
    throw new Error("science-physics-hepdata-chi-square-source-invalid");
  }
  return { run, stored, normalizedTable, tableBytes, resultBytes, tableOutput, resultOutput };
}

function exactMaterialsParent(store: ScienceStore, projectId: string, catalogRunId: string): {
  run: NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>;
  stored: StoredMaterialsParent;
  rawBytes: Buffer;
  resultBytes: Buffer;
  rawOutput: NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>["outputs"][number];
  resultOutput: NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>["outputs"][number];
} {
  const run = store.getResearchRunForProject(projectId, catalogRunId);
  if (!run || run.status !== "succeeded" || run.toolId !== SCIENCE_MATERIALS_TOOL_ID || run.toolVersion !== SCIENCE_MATERIALS_TOOL_VERSION) {
    throw new Error("science-materials-lattice-metrics-parent-run-invalid");
  }
  const rawOutput = run.outputs.find((resource) => resource.role === "provider-response" && isOqmdJsonMimeType(resource.mimeType));
  const resultOutput = run.outputs.find((resource) => resource.role === "materials-catalog" && resource.mimeType === "application/vnd.agentlas.science-materials-catalog+json");
  if (!rawOutput || !resultOutput || run.outputs.length !== 2) throw new Error("science-materials-lattice-metrics-parent-output-invalid");
  const rawBytes = store.readRunBlob(rawOutput);
  const resultBytes = store.readRunBlob(resultOutput);
  let stored: StoredMaterialsParent;
  try { stored = JSON.parse(resultBytes.toString("utf8")) as StoredMaterialsParent; }
  catch { throw new Error("science-materials-lattice-metrics-parent-output-invalid"); }
  if (stored.schema !== "agentlas.science-materials-catalog-result/v1" || stored.projectId !== projectId || stored.runId !== run.id
    || stored.responseSha256 !== rawOutput.sha256 || stored.normalized?.schema !== "agentlas.materials.oqmd-optimade/v1") {
    throw new Error("science-materials-lattice-metrics-parent-output-invalid");
  }
  const source = store.getSourceVersionForProject(projectId, stored.sourceId, stored.sourceVersionId);
  if (!source || source.version.accessState !== "retrieved" || source.version.contentSha256 !== rawOutput.sha256 || source.canonicalUri !== stored.endpoint) {
    throw new Error("science-materials-lattice-metrics-source-invalid");
  }
  return { run, stored, rawBytes, resultBytes, rawOutput, resultOutput };
}

function earthMagnitudeFrequencyVega(analysis: GutenbergRichterResult): Record<string, unknown> {
  const values = analysis.publicationTable.rows.map((row) => ({
    magnitudeThreshold: row[0],
    binCount: row[1],
    cumulativeCount: row[2],
    observed: row[3],
    fitted: row[4],
  }));
  return {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    width: 680,
    height: 380,
    padding: 16,
    background: "white",
    data: [{ name: "frequency", values }],
    scales: [
      { name: "x", type: "linear", domain: { data: "frequency", field: "magnitudeThreshold" }, range: "width", nice: true, zero: false },
      { name: "y", type: "linear", domain: { data: "frequency", fields: ["observed", "fitted"] }, range: "height", nice: true, zero: false },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: `Magnitude (${analysis.selection.magnitudeType})` },
      { orient: "left", scale: "y", title: "log10 cumulative count", grid: true },
    ],
    marks: [
      { type: "line", from: { data: "frequency" }, encode: { enter: { x: { scale: "x", field: "magnitudeThreshold" }, y: { scale: "y", field: "fitted" }, stroke: { value: "#B85C38" }, strokeWidth: { value: 2 } } } },
      { type: "symbol", from: { data: "frequency" }, encode: { enter: { x: { scale: "x", field: "magnitudeThreshold" }, y: { scale: "y", field: "observed" }, fill: { value: "#2E6F62" }, size: { value: 72 }, tooltip: { field: "cumulativeCount" } } } },
    ],
  };
}

function physicsMeasurementVega(analysis: HepDataChiSquareResult): Record<string, unknown> {
  const values = analysis.rows.filter((row) => row.included).map((row) => ({
    x: row.x,
    observed: row.observed,
    prediction: row.prediction,
    lower: row.observed === null || row.propagatedSigma === null ? null : row.observed - row.propagatedSigma,
    upper: row.observed === null || row.propagatedSigma === null ? null : row.observed + row.propagatedSigma,
    pull: row.pull,
  }));
  return {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    width: 680,
    height: 380,
    padding: 16,
    background: "white",
    data: [{ name: "measurements", values }],
    scales: [
      { name: "x", type: "linear", domain: { data: "measurements", field: "x" }, range: "width", nice: true, zero: false },
      { name: "y", type: "linear", domain: { data: "measurements", fields: ["lower", "upper", "prediction"] }, range: "height", nice: true, zero: false },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "Independent variable" },
      { orient: "left", scale: "y", title: `${analysis.series.name}${analysis.series.units ? ` (${analysis.series.units})` : ""}`, grid: true },
    ],
    marks: [
      { type: "rule", from: { data: "measurements" }, encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "lower" }, y2: { scale: "y", field: "upper" }, stroke: { value: "#6D6A66" }, strokeWidth: { value: 1.2 } } } },
      { type: "line", from: { data: "measurements" }, encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "prediction" }, stroke: { value: "#B85C38" }, strokeWidth: { value: 2 } } } },
      { type: "symbol", from: { data: "measurements" }, encode: { enter: { x: { scale: "x", field: "x" }, y: { scale: "y", field: "observed" }, fill: { value: "#2E6F62" }, size: { value: 72 }, tooltip: { field: "pull" } } } },
    ],
  };
}

function materialsLatticeVega(analysis: LatticeMetricsResult): Record<string, unknown> {
  return {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    width: 680,
    // The publication validator refuses a capture under 320x200 (artifact-publication-validator.ts),
    // so a figure drawn shorter than that can never be bound into a manuscript.
    height: 220,
    padding: 16,
    background: "white",
    data: [{ name: "metrics", values: [{ metric: "Cell volume", value: analysis.volume.angstrom3 }] }],
    scales: [
      { name: "x", type: "linear", domain: { data: "metrics", field: "value" }, range: "width", nice: true, zero: true },
      { name: "y", type: "band", domain: { data: "metrics", field: "metric" }, range: "height", padding: 0.45 },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "Cell volume (angstrom³)", grid: true },
      { orient: "left", scale: "y", title: null },
    ],
    marks: [{ type: "rect", from: { data: "metrics" }, encode: { enter: { x: { scale: "x", value: 0 }, x2: { scale: "x", field: "value" }, y: { scale: "y", field: "metric" }, height: { scale: "y", band: 1 }, fill: { value: "#2E6F62" }, tooltip: { field: "value" } } } }],
  };
}

export class ScienceDomainAnalysisService {
  constructor(private readonly store: ScienceStore) {}

  private earthArtifactForRun(projectId: string, runId: string): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, "earthquake-observations");
    if (!artifact) return null;
    if (artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega"
      || artifact.version.payload.schema !== "agentlas.science.earth-gutenberg-richter-artifact/v1") {
      throw new Error("science-earth-gutenberg-richter-artifact-replay-invalid");
    }
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-earth-gr-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId, runId, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  analyzeEarthGutenbergRichter(input: EarthGutenbergRichterInput): EarthGutenbergRichterResult {
    const parent = exactEarthquakeParent(this.store, input.projectId, input.catalogRunId);
    const exactTitle = title(input.title, `Gutenberg–Richter analysis · ${parent.stored.title}`);
    const runtime = earthRuntime();
    const pluginInput = {
      catalog: { ...parent.stored.catalog, query: parent.stored.query, provenance: parent.stored.receipt },
      completenessMagnitude: input.completenessMagnitude,
      ...(input.binWidth === undefined ? {} : { binWidth: input.binWidth }),
      magnitudeType: input.magnitudeType,
      ...(input.confidenceLevel === undefined ? {} : { confidenceLevel: input.confidenceLevel }),
    };
    const analysis = runtime.analyzeGutenbergRichter(pluginInput);
    const descriptor = {
      schema: "agentlas.science-earth-gutenberg-richter-input/v1",
      catalogRunId: parent.run.id,
      catalogOutputSha256: parent.catalogOutput.sha256,
      rawResponseSha256: parent.rawOutput.sha256,
      pluginInput: {
        completenessMagnitude: input.completenessMagnitude,
        binWidth: input.binWidth ?? 0.1,
        magnitudeType: input.magnitudeType.toLowerCase(),
        confidenceLevel: input.confidenceLevel ?? 0.95,
      },
      title: exactTitle,
    };
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const catalogBlob = this.store.putRunBlob(parent.catalogBytes);
    const rawBlob = this.store.putRunBlob(parent.rawBytes);
    if (catalogBlob.sha256 !== parent.catalogOutput.sha256 || rawBlob.sha256 !== parent.rawOutput.sha256) {
      throw new Error("science-earth-gutenberg-richter-parent-closure-invalid");
    }
    const inputs = [
      { role: "earth-gutenberg-richter-input", mimeType: "application/vnd.agentlas.science.earth-gutenberg-richter-input+json", ...descriptorBlob, artifactId: null, artifactVersion: null },
      { role: "earthquake-catalog-parent", mimeType: parent.catalogOutput.mimeType, ...catalogBlob, artifactId: null, artifactVersion: null },
      { role: "earthquake-provider-response", mimeType: parent.rawOutput.mimeType, ...rawBlob, artifactId: null, artifactVersion: null },
    ];
    const environmentSha256 = sha256(canonicalJson({
      policy: "earth-gutenberg-richter-parent-run-v1",
      plugin: `agentlas-earth-science@${runtime.PLUGIN_VERSION}`,
      methodRevision: analysis.methodRevision,
      runtime: process.version,
    }));
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      parentRunId: parent.run.id,
      toolId: EARTH_GUTENBERG_RICHTER_TOOL_ID,
      toolVersion: EARTH_GUTENBERG_RICHTER_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs)),
      environmentSha256,
      inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "earth-gutenberg-richter-analysis" && resource.mimeType === "application/vnd.agentlas.earth.gutenberg-richter-analysis+json");
      if (!output) throw new Error("science-earth-gutenberg-richter-replay-output-missing");
      const replayedAnalysis = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as GutenbergRichterResult;
      if (replayedAnalysis.schema !== analysis.schema || replayedAnalysis.analysisSha256 !== analysis.analysisSha256) {
        throw new Error("science-earth-gutenberg-richter-replay-output-invalid");
      }
      const artifact = this.earthArtifactForRun(input.projectId, run.id);
      if (!artifact) throw new Error("science-earth-gutenberg-richter-replay-artifact-missing");
      return { schema: "agentlas.science-earth-gutenberg-richter-result/v1", runId: run.id, parentRunId: parent.run.id, title: exactTitle, analysis: replayedAnalysis, artifact, replayed: true };
    }
    if (run.status !== "running") throw new Error(`science-earth-gutenberg-richter-run-${run.status}`);
    try {
      const analysisBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis), "utf8"));
      const output = { role: "earth-gutenberg-richter-analysis", mimeType: "application/vnd.agentlas.earth.gutenberg-richter-analysis+json", ...analysisBlob, artifactId: null, artifactVersion: null };
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson([output])),
        summary: `Gutenberg–Richter b=${analysis.estimates.bValue} from ${analysis.selection.includedCount} of ${analysis.selection.totalEvents} exact USGS observations.`,
        outputs: [output],
      }).run;
      const source = this.store.getSourceVersionForProject(input.projectId, parent.stored.sourceId, parent.stored.sourceVersionId);
      if (!source) throw new Error("science-earth-gutenberg-richter-source-invalid");
      const payload = {
        schema: "agentlas.science.earth-gutenberg-richter-artifact/v1",
        analysis,
        spec: earthMagnitudeFrequencyVega(analysis),
        source: { catalogRunId: parent.run.id, catalogOutputSha256: parent.catalogOutput.sha256, rawResponseSha256: parent.rawOutput.sha256 },
      };
      const parentArtifact = this.store.getArtifactForSourceRun(input.projectId, parent.run.id, "earthquake-observations");
      const parentRef = parentArtifact ? { artifactId: parentArtifact.id, version: parentArtifact.currentVersion } : null;
      const artifact = this.store.createArtifact({
        projectId: input.projectId, sourceRunId: run.id, kind: "chart.vega", title: exactTitle,
        rendererId: "agentlas.vega", rendererVersion: "6.4.0", rendererBinding: null,
        payload,
        semantic: {
          title: exactTitle,
          summary: `Aki MLE Gutenberg–Richter analysis with explicit Mc=${analysis.selection.completenessMagnitude} and one ${analysis.selection.magnitudeType} scale.`,
          entities: [{ id: parent.run.id, label: parent.stored.title, type: "usgs-earthquake-catalog" }],
          observations: [
            { label: "Included events", value: analysis.selection.includedCount, unit: "count" },
            { label: "b-value", value: analysis.estimates.bValue, unit: null },
            { label: "Standard error", value: analysis.estimates.standardError, unit: null },
          ],
          warnings: [...analysis.assumptions],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: [source.canonicalUri],
          datasetSha256: [parent.rawOutput.sha256, parent.catalogOutput.sha256, analysis.source.normalizedCatalogSha256, analysis.analysisSha256, analysis.contentReceipts.publicationTable.sha256, analysis.contentReceipts.figure.sha256],
          codeSha256: sha256(`${EARTH_GUTENBERG_RICHTER_TOOL_ID}@${EARTH_GUTENBERG_RICHTER_TOOL_VERSION}:${analysis.methodRevision}`),
          environmentSha256,
        },
        linkage: {
          labId: "earthquake-observations",
          origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
          parent: parentRef,
          inputs: parentRef ? [parentRef] : [],
        },
      });
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-earth-gr-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId, runId: run.id, outputOrdinal: 1,
        artifactId: artifact.id, artifactVersion: artifact.currentVersion, expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: "agentlas.science-earth-gutenberg-richter-result/v1", runId: run.id, parentRunId: parent.run.id, title: exactTitle, analysis, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed",
        outputManifestSha256: sha256(canonicalJson([])), summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-earth-gutenberg-richter-failed", outputs: [],
      });
      throw error;
    }
  }

  analyzePhysicsHepDataChiSquare(input: PhysicsHepDataChiSquareInput): PhysicsHepDataChiSquareAnalysisResult {
    const runtime = physicsRuntime();
    const parent = exactPhysicsHepDataParent(this.store, input.projectId, input.tableRunId, runtime);
    const exactTitle = title(input.title, `Chi-square analysis · ${parent.stored.title}`);
    const analysis = runtime.analyzeHepDataChiSquare({
      table: parent.normalizedTable,
      dependentSeriesIndex: input.dependentSeriesIndex,
      prediction: input.prediction,
      uncertaintyLabels: input.uncertaintyLabels,
      ...(input.fittedParameterCount === undefined ? {} : { fittedParameterCount: input.fittedParameterCount }),
    });
    const descriptor = {
      schema: "agentlas.science-physics-hepdata-chi-square-input/v1",
      tableRunId: parent.run.id,
      tableResponseSha256: parent.tableOutput.sha256,
      normalizedTableSha256: parent.normalizedTable.normalizedSha256,
      dependentSeriesIndex: input.dependentSeriesIndex,
      prediction: input.prediction,
      uncertaintyLabels: input.uncertaintyLabels,
      fittedParameterCount: input.fittedParameterCount ?? 0,
      title: exactTitle,
    };
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const resultBlob = this.store.putRunBlob(parent.resultBytes);
    const tableBlob = this.store.putRunBlob(parent.tableBytes);
    if (resultBlob.sha256 !== parent.resultOutput.sha256 || tableBlob.sha256 !== parent.tableOutput.sha256) {
      throw new Error("science-physics-hepdata-chi-square-parent-closure-invalid");
    }
    const inputs = [
      { role: "physics-hepdata-chi-square-input", mimeType: "application/vnd.agentlas.science.physics-hepdata-chi-square-input+json", ...descriptorBlob, artifactId: null, artifactVersion: null },
      { role: "physics-hepdata-parent-result", mimeType: parent.resultOutput.mimeType, ...resultBlob, artifactId: null, artifactVersion: null },
      { role: "physics-hepdata-table-response", mimeType: parent.tableOutput.mimeType, ...tableBlob, artifactId: null, artifactVersion: null },
    ];
    const environmentSha256 = sha256(canonicalJson({
      policy: "hepdata-diagonal-chi-square-parent-run-v1",
      plugin: "agentlas-physics@0.2.0",
      method: "directional-independent-quadrature-chi-square/v1",
      runtime: process.version,
    }));
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      parentRunId: parent.run.id, toolId: PHYSICS_HEPDATA_CHI_SQUARE_TOOL_ID, toolVersion: PHYSICS_HEPDATA_CHI_SQUARE_TOOL_VERSION,
      runtime: "electron-main", inputManifestSha256: sha256(canonicalJson(inputs)), environmentSha256, inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "physics-hepdata-chi-square-analysis" && resource.mimeType === "application/vnd.agentlas.physics.hepdata-chi-square-analysis+json");
      if (!output) throw new Error("science-physics-hepdata-chi-square-replay-output-missing");
      const replayedAnalysis = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as HepDataChiSquareResult;
      if (replayedAnalysis.schema !== analysis.schema || replayedAnalysis.analysisSha256 !== analysis.analysisSha256) throw new Error("science-physics-hepdata-chi-square-replay-output-invalid");
      const artifact = this.store.getArtifactForSourceRun(input.projectId, run.id, "physics-data");
      if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega" || artifact.version.payload.schema !== "agentlas.science.physics-hepdata-chi-square-artifact/v1") {
        throw new Error("science-physics-hepdata-chi-square-replay-artifact-invalid");
      }
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-physics-chi2-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId, runId: run.id, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: "agentlas.science-physics-hepdata-chi-square-result/v1", runId: run.id, parentRunId: parent.run.id, title: exactTitle, analysis: replayedAnalysis, artifact, replayed: true };
    }
    if (run.status !== "running") throw new Error(`science-physics-hepdata-chi-square-run-${run.status}`);
    try {
      const analysisBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis), "utf8"));
      const output = { role: "physics-hepdata-chi-square-analysis", mimeType: "application/vnd.agentlas.physics.hepdata-chi-square-analysis+json", ...analysisBlob, artifactId: null, artifactVersion: null };
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson([output])),
        summary: `Chi-square=${analysis.summary.chiSquare} with ${analysis.summary.degreesOfFreedom} degrees of freedom from ${analysis.summary.includedPointCount} exact HEPData points.`,
        outputs: [output],
      }).run;
      const parentArtifact = this.store.getArtifactForSourceRun(input.projectId, parent.run.id, "physics-data");
      const parentRef = parentArtifact ? { artifactId: parentArtifact.id, version: parentArtifact.currentVersion } : null;
      const sourceRefs = parent.stored.payload.evidence.citations.map((citation) => citation.url);
      const payload = {
        schema: "agentlas.science.physics-hepdata-chi-square-artifact/v1",
        analysis,
        spec: physicsMeasurementVega(analysis),
        source: { tableRunId: parent.run.id, tableResponseSha256: parent.tableOutput.sha256, normalizedTableSha256: parent.normalizedTable.normalizedSha256 },
      };
      const artifact = this.store.createArtifact({
        projectId: input.projectId, sourceRunId: run.id, kind: "chart.vega", title: exactTitle,
        rendererId: "agentlas.vega", rendererVersion: "6.4.0", rendererBinding: null, payload,
        semantic: {
          title: exactTitle,
          summary: `Diagonal chi-square with explicitly selected independent uncertainty components and directional asymmetric errors; covariance and parameter fitting are not inferred.`,
          entities: [{ id: `${parent.stored.recordId}:${parent.stored.tableName}`, label: parent.stored.title, type: "hepdata-table" }],
          observations: [
            { label: "Included points", value: analysis.summary.includedPointCount, unit: "count" },
            { label: "Chi-square", value: analysis.summary.chiSquare, unit: null },
            { label: "Reduced chi-square", value: analysis.summary.reducedChiSquare, unit: null },
            { label: "p-value", value: analysis.summary.pValue, unit: null },
          ],
          warnings: [...analysis.warnings],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs,
          datasetSha256: [parent.tableOutput.sha256, parent.resultOutput.sha256, parent.normalizedTable.normalizedSha256, analysis.analysisSha256, analysis.contentReceipts.publicationTable.sha256],
          codeSha256: sha256(`${PHYSICS_HEPDATA_CHI_SQUARE_TOOL_ID}@${PHYSICS_HEPDATA_CHI_SQUARE_TOOL_VERSION}:agentlas-physics@0.2.0`),
          environmentSha256,
        },
        linkage: {
          labId: "physics-data",
          origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
          parent: parentRef,
          inputs: parentRef ? [parentRef] : [],
        },
      });
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-physics-chi2-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId, runId: run.id, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: "agentlas.science-physics-hepdata-chi-square-result/v1", runId: run.id, parentRunId: parent.run.id, title: exactTitle, analysis, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed",
        outputManifestSha256: sha256(canonicalJson([])), summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-physics-hepdata-chi-square-failed", outputs: [],
      });
      throw error;
    }
  }

  analyzeMaterialsLatticeMetrics(input: MaterialsLatticeMetricsInput): MaterialsLatticeMetricsAnalysisResult {
    const parent = exactMaterialsParent(this.store, input.projectId, input.catalogRunId);
    const exactTitle = title(input.title, `Lattice metrics · ${input.structureId}`);
    const analysis = materialsRuntime().analyzeLatticeMetrics({
      sourceKind: "optimade",
      normalized: parent.stored.normalized,
      structureId: input.structureId,
      ...(input.declaredVolumeToleranceRelative === undefined ? {} : { declaredVolumeToleranceRelative: input.declaredVolumeToleranceRelative }),
    });
    const descriptor = {
      schema: "agentlas.science-materials-lattice-metrics-input/v1",
      catalogRunId: parent.run.id,
      catalogOutputSha256: parent.resultOutput.sha256,
      rawResponseSha256: parent.rawOutput.sha256,
      normalizedSha256: parent.stored.normalized.normalizedSha256,
      sourceKind: "optimade",
      structureId: input.structureId,
      declaredVolumeToleranceRelative: input.declaredVolumeToleranceRelative ?? 0.005,
      title: exactTitle,
    };
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const resultBlob = this.store.putRunBlob(parent.resultBytes);
    const rawBlob = this.store.putRunBlob(parent.rawBytes);
    if (resultBlob.sha256 !== parent.resultOutput.sha256 || rawBlob.sha256 !== parent.rawOutput.sha256) throw new Error("science-materials-lattice-metrics-parent-closure-invalid");
    const inputs = [
      { role: "materials-lattice-metrics-input", mimeType: "application/vnd.agentlas.science.materials-lattice-metrics-input+json", ...descriptorBlob, artifactId: null, artifactVersion: null },
      { role: "materials-catalog-parent", mimeType: parent.resultOutput.mimeType, ...resultBlob, artifactId: null, artifactVersion: null },
      { role: "materials-provider-response", mimeType: parent.rawOutput.mimeType, ...rawBlob, artifactId: null, artifactVersion: null },
    ];
    const environmentSha256 = sha256(canonicalJson({ policy: "optimade-lattice-metrics-parent-run-v1", plugin: "agentlas-materials-science@0.2.0", runtime: process.version }));
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      parentRunId: parent.run.id, toolId: MATERIALS_LATTICE_METRICS_TOOL_ID, toolVersion: MATERIALS_LATTICE_METRICS_TOOL_VERSION,
      runtime: "electron-main", inputManifestSha256: sha256(canonicalJson(inputs)), environmentSha256, inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "materials-lattice-metrics-analysis" && resource.mimeType === "application/vnd.agentlas.materials.lattice-metrics+json");
      if (!output) throw new Error("science-materials-lattice-metrics-replay-output-missing");
      const replayedAnalysis = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as LatticeMetricsResult;
      if (replayedAnalysis.schema !== analysis.schema || replayedAnalysis.analysisSha256 !== analysis.analysisSha256) throw new Error("science-materials-lattice-metrics-replay-output-invalid");
      const artifact = this.store.getArtifactForSourceRun(input.projectId, run.id, "materials-structures");
      if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega" || artifact.version.payload.schema !== "agentlas.science.materials-lattice-metrics-artifact/v1") {
        throw new Error("science-materials-lattice-metrics-replay-artifact-invalid");
      }
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-materials-lattice-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId, runId: run.id, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: "agentlas.science-materials-lattice-metrics-result/v1", runId: run.id, parentRunId: parent.run.id, title: exactTitle, analysis: replayedAnalysis, artifact, replayed: true };
    }
    if (run.status !== "running") throw new Error(`science-materials-lattice-metrics-run-${run.status}`);
    try {
      const analysisBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis), "utf8"));
      const output = { role: "materials-lattice-metrics-analysis", mimeType: "application/vnd.agentlas.materials.lattice-metrics+json", ...analysisBlob, artifactId: null, artifactVersion: null };
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson([output])), summary: `Validated ${analysis.sourceLineage.structureId} cell volume=${analysis.volume.angstrom3} angstrom^3 from exact OQMD lattice vectors.`, outputs: [output],
      }).run;
      const parentArtifact = this.store.getArtifactForSourceRun(input.projectId, parent.run.id, "materials-structures");
      const parentRef = parentArtifact ? { artifactId: parentArtifact.id, version: parentArtifact.currentVersion } : null;
      const payload = {
        schema: "agentlas.science.materials-lattice-metrics-artifact/v1",
        analysis,
        spec: materialsLatticeVega(analysis),
        source: { catalogRunId: parent.run.id, rawResponseSha256: parent.rawOutput.sha256, normalizedSha256: parent.stored.normalized.normalizedSha256 },
      };
      const artifact = this.store.createArtifact({
        projectId: input.projectId, sourceRunId: run.id, kind: "chart.vega", title: exactTitle,
        rendererId: "agentlas.vega", rendererVersion: "6.4.0", rendererBinding: null, payload,
        semantic: {
          title: exactTitle,
          summary: `Cell volume was computed from the absolute determinant of exact three-dimensional OPTIMADE lattice vectors; density is shown only when every required explicit field exists.`,
          entities: [{ id: analysis.sourceLineage.structureId, label: analysis.sourceLineage.structureId, type: "crystal-structure" }],
          observations: [
            { label: "Cell volume", value: analysis.volume.angstrom3, unit: "angstrom^3" },
            { label: "Density", value: analysis.density.gramsPerCm3 ?? "not computed", unit: analysis.density.gramsPerCm3 === null ? null : "g/cm^3" },
          ],
          warnings: [...analysis.warnings],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: [parent.stored.endpoint],
          datasetSha256: [parent.rawOutput.sha256, parent.resultOutput.sha256, parent.stored.normalized.normalizedSha256, analysis.analysisSha256, analysis.contentReceipts.publicationTable.sha256],
          codeSha256: sha256(`${MATERIALS_LATTICE_METRICS_TOOL_ID}@${MATERIALS_LATTICE_METRICS_TOOL_VERSION}:agentlas-materials-science@0.2.0`),
          environmentSha256,
        },
        linkage: {
          labId: "materials-structures",
          origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
          parent: parentRef,
          inputs: parentRef ? [parentRef] : [],
        },
      });
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-materials-lattice-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId, runId: run.id, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: "agentlas.science-materials-lattice-metrics-result/v1", runId: run.id, parentRunId: parent.run.id, title: exactTitle, analysis, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed",
        outputManifestSha256: sha256(canonicalJson([])), summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-materials-lattice-metrics-failed", outputs: [],
      });
      throw error;
    }
  }
}
