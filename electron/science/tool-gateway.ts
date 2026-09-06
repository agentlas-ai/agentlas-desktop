import fs from "node:fs";
import { projectScienceDeclaredColumns, type ScienceDeclaredColumnMapping, type ScienceDeclaredSchemaNode } from "./statistics-declared-projection";
import { prepareScienceTable, type ScienceTablePreparation } from "./statistics-table-preparation";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  ScienceAnalysisModelSpec,
  ScienceArtifact,
  ScienceResearchRun,
  ScienceResearchRunResourceInput,
  ScienceRunArtifactBinding,
  ScienceRunBlobReceipt,
  ScienceToolExecution,
} from "../../shared/science-contract";

import {
  defaultScienceProteinColorTheme,
  scienceRendererBindingsEqual,
  scienceRendererExecutorBindingsEqual,
  type ScienceProteinColorTheme,
  type ScienceProteinRepresentation,
  type ScienceRendererBinding,
  type ScienceRendererExecutorBinding,
} from "../../shared/science-renderer-runtime";
import { ScienceStore } from "./store";
import { runSignedScienceExecutor } from "./signed-executor";
import { loadSciencePluginRuntime, readSciencePluginFile, readSciencePluginRelease } from "./plugin-runtime";
import type { ResolvedScienceRendererExecutor } from "./renderer-registry";
import {
  SCIENCE_STATISTICS_LAB_ID,
  SCIENCE_STATISTICS_REQUEST_SCHEMA,
  SCIENCE_STATISTICS_TOOL_ID,
  SCIENCE_STATISTICS_TOOL_VERSION,
  SCIENCE_STATISTICS_EXECUTION_BINDING_SCHEMA,
  SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA,
  SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA,
  SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V4_SCHEMA,
  SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V3_SCHEMA,
  isScienceStatisticsMethod,
  scienceStatisticsSha256,
  scienceStatisticsMethodMatchesAnalysisModel,
  validateScienceStatisticsExecutionBinding,
  validateScienceStatisticsDataTableProjectionReceipt,
  type ScienceStatisticsExecutionBinding,
  type ScienceStatisticsInputArtifactBinding,
  type ScienceStatisticsLmmFixedEffectSpec,
  type ScienceStatisticsLmmSourceTableBinding,
  type ScienceStatisticsPurpose,
  type ScienceStatisticsSourceTableBinding,
  type ScienceStatisticsSourceTableInput,
} from "../../shared/science-statistics";
import {
  SCIENCE_TABLE_ARTIFACT_KIND,
  SCIENCE_TABLE_LAB_ID,
  SCIENCE_TABLE_RENDERER_ID,
  validateScienceTablePayload,
} from "../../shared/science-table";
import {
  SCIENCE_PHYSICS_LAB_ID,
  SCIENCE_PHYSICS_TOOL_ID,
  SCIENCE_PHYSICS_TOOL_VERSION,
} from "../../shared/science-physics";
import {
  SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_MIME,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_ROLE,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_LAB_ID,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_OUTPUT_MIME,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_OUTPUT_ROLE,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_ID,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_VERSION,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_TOOL_ID,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_TOOL_VERSION,
  validateScienceAstronomyLightCurveInputDescriptor,
  type ScienceAstronomyLightCurveAnalysisRequest,
  type ScienceAstronomyLightCurveArtifactBinding,
  type ScienceAstronomyLightCurveColumnMapping,
  type ScienceAstronomyLightCurveInputDescriptor,
} from "../../shared/science-astronomy";

const TOOL_ID = "agentlas.table-to-vega";
const TOOL_VERSION = "1.0.0";
const TOOL_RUNTIME = "native-sidecar" as const;
const INPUT_MIME = "application/vnd.agentlas.science.table+json";
const OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact+json";
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STATISTICS_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const STATISTICS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STATISTICS_DEFAULT_ANALYSIS_TIMEOUT_MS = 5_000;
const STATISTICS_MAX_ANALYSIS_TIMEOUT_MS = 10_000;
const STATISTICS_TERMINATION_GRACE_MS = 1_000;
const STATISTICS_CHILD_RESOURCE_LIMITS = Object.freeze({
  maxOldSpaceMb: 192,
  maxSemiSpaceMb: 16,
  stackSizeKb: 8 * 1024,
});
const MAX_LOG_BYTES = 64 * 1024;
const TIMEOUT_MS = 15_000;
const MOLSTAR_TOOL_ID = "agentlas.source-to-molstar";
const MOLSTAR_TOOL_VERSION = "1.0.0";
const MOLSTAR_INPUT_MIME = "application/vnd.agentlas.science.source-version+json";
const MOLSTAR_OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact-candidate+json";
const KETCHER_TOOL_ID = "agentlas.smiles-to-ketcher";
const KETCHER_TOOL_VERSION = "1.0.0";
const KETCHER_INPUT_MIME = "application/vnd.agentlas.science.smiles+json";
const KETCHER_OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact-candidate+json";
const SOURCE_TO_KETCHER_TOOL_ID = "agentlas.source-to-ketcher";
const SOURCE_TO_KETCHER_TOOL_VERSION = "1.1.0";
const SOURCE_TO_KETCHER_INPUT_MIME = "application/vnd.agentlas.science.source-to-ketcher+json";
const CITATION_NETWORK_TOOL_ID = "agentlas.academic-to-citation-network";
const CITATION_NETWORK_TOOL_VERSION = "1.0.0";
const CITATION_NETWORK_INPUT_MIME = "application/vnd.agentlas.science.academic-to-citation-network+json";
const CITATION_NETWORK_OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact+json";
const ASTRONOMY_SKY_TOOL_ID = "agentlas.astronomy-to-sky-map";
const ASTRONOMY_SKY_TOOL_VERSION = "1.0.0";
const ASTRONOMY_SKY_INPUT_MIME = "application/vnd.agentlas.science.astronomy-to-sky-map+json";
const ASTRONOMY_SKY_OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact+json";
const BIODIVERSITY_MAP_TOOL_ID = "agentlas.biodiversity-to-map";
const BIODIVERSITY_MAP_TOOL_VERSION = "1.0.0";
const BIODIVERSITY_MAP_INPUT_MIME = "application/vnd.agentlas.science.biodiversity-to-map+json";
const BIODIVERSITY_MAP_OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact+json";
const EARTHQUAKE_MAP_TOOL_ID = "agentlas.earthquake-to-map";
const EARTHQUAKE_MAP_TOOL_VERSION = "1.0.0";
const EARTHQUAKE_MAP_INPUT_MIME = "application/vnd.agentlas.science.earthquake-to-map+json";
const EARTHQUAKE_MAP_OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact+json";
const STATISTICS_INPUT_MIME = "application/vnd.agentlas.science.statistics-request+json";
const STATISTICS_SOURCE_TABLE_MIME = "application/vnd.agentlas.science.table+json";
const STATISTICS_OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact+json";
const PHYSICS_INPUT_MIME = "application/vnd.agentlas.science.physics-dataset+json";
const PHYSICS_OUTPUT_MIME = "application/vnd.agentlas.science.tool-artifact+json";

export interface ScienceRendererAuthorityResolver {
  resolve(rendererId: string, artifactKind: string): ScienceRendererBinding | null;
  resolveExact(binding: ScienceRendererBinding, artifactKind: string): ScienceRendererBinding | null;
  resolveExecutor(rendererId: string, artifactKind: string, executorId: string): ResolvedScienceRendererExecutor | null;
  resolveExactExecutor(binding: ScienceRendererBinding, artifactKind: string, executorId: string): ResolvedScienceRendererExecutor | null;
  resolveExactExecutorBinding(
    rendererBinding: ScienceRendererBinding,
    executorBinding: ScienceRendererExecutorBinding,
    artifactKind: string,
  ): ResolvedScienceRendererExecutor | null;
}

export interface ExecuteTableToVegaInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  title: string;
  xField: string;
  yField: string;
  rows: Array<Record<string, string | number>>;
}

export interface ExecuteStatisticsAnalysisInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  purpose?: ScienceStatisticsPurpose;
  inputArtifacts?: ScienceStatisticsInputArtifactBinding[];
  analysisSpec?: {
    analysisSpecId: string;
    version: number;
    contentSha256: string;
    status: "frozen";
    modelSha256: string;
  };
  sourceTable?: ScienceStatisticsSourceTableInput;
  request: Record<string, unknown>;
}

export interface ExecutePhysicsDatasetInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  title: string;
  columns: Array<{ name: string; type: "number" | "string"; unit?: string | null }>;
  rows: Array<Array<string | number | null>>;
}

export interface ExecuteAcademicToCitationNetworkInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  searchRunId: string;
  title: string;
  maxRecords?: number;
}

export interface ExecuteAstronomyToSkyMapInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  catalogRunId: string;
  title: string;
}

export interface ExecuteAstronomyLightCurvePeriodicityInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  title: string;
  sourceTable: Pick<ScienceAstronomyLightCurveArtifactBinding, "artifactId" | "artifactVersion" | "contentSha256">;
  columns: ScienceAstronomyLightCurveColumnMapping;
  analysis: ScienceAstronomyLightCurveAnalysisRequest;
}

export interface ExecuteBiodiversityToMapInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  catalogRunId: string;
  title: string;
}

export interface ExecuteEarthquakeToMapInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  catalogRunId: string;
  title: string;
}

export interface ExecuteSourceToMolstarInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  sourceId: string;
  sourceVersionId: string;
  title?: string;
  representation?: ScienceProteinRepresentation;
  colorTheme?: ScienceProteinColorTheme;
}

export interface ExecuteSmilesToKetcherInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  title: string;
  smiles: string;
}

export interface ExecuteSourceToKetcherInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  turnId?: string;
  invocationRunId?: string;
  toolCallId?: string;
  retrievalRunId: string;
  sourceId: string;
  sourceVersionId: string;
  title?: string;
}

export interface ScienceToolExecutionReceipt {
  schema: "agentlas.science-tool-execution/v1";
  requestId: string;
  toolId: string;
  toolVersion: string;
  workerSha256: string;
  environmentSha256: string;
  childPid: number | null;
  exitCode: number;
  input: ScienceRunBlobReceipt;
  output: ScienceRunBlobReceipt;
  run: ScienceResearchRun;
  artifact: ScienceArtifact;
  binding: ScienceRunArtifactBinding;
  replayed: boolean;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const STATISTICS_PLUGIN_SLUG = "agentlas-science-statistics";
const STATISTICS_RUNTIME_RECEIPT_SCHEMA = "agentlas.science.statistics.runtime-receipt/v1";
const STATISTICS_RUNTIME_RECEIPT_MIME = "application/vnd.agentlas.science.statistics-runtime-receipt+json";

type StatisticsPluginIntegrityFile = {
  path: string;
  sha256: string;
  bytes: number;
};

type StatisticsRuntimeReceipt = {
  schema: typeof STATISTICS_RUNTIME_RECEIPT_SCHEMA;
  toolId: typeof SCIENCE_STATISTICS_TOOL_ID;
  toolVersion: typeof SCIENCE_STATISTICS_TOOL_VERSION;
  workerSha256: string;
  runtime: typeof TOOL_RUNTIME;
  electron: string | null;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  networkPolicy: "builtin-module-deny-v1";
  processLimits: {
    isolation: "electron-run-as-node-child";
    analysisTimeoutMs: number;
    terminationTimeoutMs: number;
    maxOldSpaceMb: number;
    maxSemiSpaceMb: number;
    stackSizeKb: number;
  };
  plugin: {
    slug: typeof STATISTICS_PLUGIN_SLUG;
    version: typeof SCIENCE_STATISTICS_TOOL_VERSION;
    manifestSha256: string;
    integrityManifestSha256: string;
    releaseSha256: string;
    runtimeFiles: StatisticsPluginIntegrityFile[];
    engine: StatisticsPluginIntegrityFile;
  };
  receiptSha256: string;
};

function createStatisticsRuntimeReceipt(
  workerSha256: string,
  analysisTimeoutMs: number,
  terminationTimeoutMs: number,
): StatisticsRuntimeReceipt {
  const release = readSciencePluginRelease(STATISTICS_PLUGIN_SLUG, "runtime/");
  if (release.manifest.version !== SCIENCE_STATISTICS_TOOL_VERSION) {
    throw new Error("science-statistics-runtime-version-mismatch");
  }
  const files = [...release.manifest.integrity.files]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const runtimeFiles = [...release.files.entries()]
    .filter(([relativePath]) => relativePath.startsWith("runtime/"))
    .map(([relativePath, file]) => ({ path: relativePath, sha256: file.sha256, bytes: file.bytes.length }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const runtimeFile = (relativePath: string): StatisticsPluginIntegrityFile => {
    const file = runtimeFiles.find((entry) => entry.path === relativePath);
    if (!file) throw new Error("science-statistics-runtime-integrity-invalid");
    return file;
  };
  const engine = runtimeFile("runtime/engine.cjs");
  const core: Omit<StatisticsRuntimeReceipt, "receiptSha256"> = {
    schema: STATISTICS_RUNTIME_RECEIPT_SCHEMA,
    toolId: SCIENCE_STATISTICS_TOOL_ID,
    toolVersion: SCIENCE_STATISTICS_TOOL_VERSION,
    workerSha256,
    runtime: TOOL_RUNTIME,
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    networkPolicy: "builtin-module-deny-v1" as const,
    processLimits: {
      isolation: "electron-run-as-node-child",
      analysisTimeoutMs,
      terminationTimeoutMs,
      ...STATISTICS_CHILD_RESOURCE_LIMITS,
    },
    plugin: {
      slug: STATISTICS_PLUGIN_SLUG,
      version: SCIENCE_STATISTICS_TOOL_VERSION,
      manifestSha256: release.manifestSha256,
      integrityManifestSha256: sha256(canonicalJson({ algo: "sha256", files })),
      releaseSha256: release.releaseSha256,
      runtimeFiles,
      engine,
    },
  };
  return { ...core, receiptSha256: sha256(canonicalJson(core)) };
}

function statisticsAnalysisTimeoutMs(normalized: Record<string, unknown>): number {
  const options = normalized.options;
  const value = options && typeof options === "object" && !Array.isArray(options)
    ? (options as Record<string, unknown>).timeoutMs
    : undefined;
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= STATISTICS_MAX_ANALYSIS_TIMEOUT_MS
    ? Number(value)
    : STATISTICS_DEFAULT_ANALYSIS_TIMEOUT_MS;
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(`science-tool-${field}-invalid`);
  return value.trim();
}

function canonicalStatisticsCategory(value: unknown, maximum: number, field: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`science-tool-${field}-invalid`);
    return String(value);
  }
  return boundedText(value, maximum, field);
}

function statisticsNumericRange(values: readonly number[]): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return { minimum, maximum };
}

function normalizeInput(input: ExecuteTableToVegaInput): Record<string, unknown> {
  if (!input || typeof input !== "object" || !Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 5_000) {
    throw new Error("science-tool-input-invalid");
  }
  const title = boundedText(input.title, 240, "title");
  const xField = boundedText(input.xField, 80, "x-field");
  const yField = boundedText(input.yField, 80, "y-field");
  const rows = input.rows.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`science-tool-row-${index}-invalid`);
    const x = raw[xField];
    const y = raw[yField];
    if ((typeof x !== "string" && typeof x !== "number") || (typeof x === "number" && !Number.isFinite(x))) throw new Error(`science-tool-row-${index}-x-invalid`);
    if (typeof y !== "number" || !Number.isFinite(y)) throw new Error(`science-tool-row-${index}-y-invalid`);
    return { [xField]: x, [yField]: y };
  });
  return { schema: "agentlas.science-table-to-vega-input/v1", title, xField, yField, rows };
}

function exactObjectKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareStatisticsLabels(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireStatisticsSourceColumn(
  table: ReturnType<typeof validateScienceTablePayload>,
  name: string,
  logicalTypes: readonly string[],
): void {
  const column = table.columns.find((entry) => entry.name === name);
  if (!column || !logicalTypes.includes(column.logicalType)) throw new Error("science-statistics-source-column-invalid");
}

function normalizeStatisticsLmmFixedEffects(value: unknown): ScienceStatisticsLmmFixedEffectSpec[] {
  if (!Array.isArray(value) || value.length > 48) throw new Error("science-statistics-source-fixed-effects-invalid");
  let expandedTerms = 0;
  const fixedEffects = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("science-statistics-source-fixed-effect-invalid");
    const item = raw as Record<string, unknown>;
    const column = boundedText(item.column, 128, "statistics-source-fixed-effect-column");
    if (item.type === "numeric") {
      if (!exactObjectKeys(item, ["column", "type"])) throw new Error("science-statistics-source-fixed-effect-invalid");
      expandedTerms += 1;
      return { column, type: "numeric" as const };
    }
    if (item.type !== "categorical" || !exactObjectKeys(item, ["column", "type", "levels", "reference"])
      || !Array.isArray(item.levels) || item.levels.length < 2 || item.levels.length > 32) {
      throw new Error("science-statistics-source-fixed-effect-invalid");
    }
    const levels = item.levels.map((level) => boundedText(level, 128, "statistics-source-fixed-effect-level"))
      .sort(compareStatisticsLabels);
    if (new Set(levels).size !== levels.length) throw new Error("science-statistics-source-fixed-effect-levels-invalid");
    const reference = boundedText(item.reference, 128, "statistics-source-fixed-effect-reference");
    if (!levels.includes(reference)) throw new Error("science-statistics-source-fixed-effect-reference-invalid");
    expandedTerms += levels.length - 1;
    return { column, type: "categorical" as const, levels, reference };
  });
  if (new Set(fixedEffects.map((item) => item.column)).size !== fixedEffects.length || expandedTerms > 32) {
    throw new Error("science-statistics-source-fixed-effects-invalid");
  }
  return fixedEffects;
}

function statisticsLmmFormulaName(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function statisticsLmmCanonicalFormula(sourceTable: ScienceStatisticsLmmSourceTableBinding): string {
  const fixed = sourceTable.fixedEffects.map((item) => ` + ${statisticsLmmFormulaName(item.column)}`).join("");
  return `${statisticsLmmFormulaName(sourceTable.outcomeColumn)} ~ 1${fixed} + (1 | ${statisticsLmmFormulaName(sourceTable.groupColumn)})`;
}

function assertStatisticsLmmAnalysisSpecCompatibility(
  sourceTable: ScienceStatisticsLmmSourceTableBinding,
  document: Record<string, unknown>,
): void {
  const data = document.data as Record<string, unknown> | undefined;
  const design = document.design as Record<string, unknown> | undefined;
  const dependence = design?.dependence as Record<string, unknown> | undefined;
  const missingData = document.missingData as Record<string, unknown> | undefined;
  const model = document.model as Record<string, unknown> | undefined;
  const predictorColumns = sourceTable.fixedEffects.map((item) => item.column);
  const quotedFormula = statisticsLmmCanonicalFormula(sourceTable);
  const safeFormulaName = (value: string) => /^[A-Za-z_][A-Za-z0-9_.]*$/u.test(value) ? value : statisticsLmmFormulaName(value);
  const fixed = predictorColumns.map((item) => ` + ${safeFormulaName(item)}`).join("");
  const bareFormula = `${safeFormulaName(sourceTable.outcomeColumn)} ~ 1${fixed} + (1 | ${safeFormulaName(sourceTable.groupColumn)})`;
  const dependenceMatches = dependence?.kind === "repeated"
    ? dependence.subjectIdVariable === sourceTable.groupColumn
    : dependence?.kind === "clustered" && Array.isArray(dependence.clusterVariables)
      && dependence.clusterVariables.length === 1 && dependence.clusterVariables[0] === sourceTable.groupColumn;
  if (!data || !design || !dependence || !missingData || !model
    || JSON.stringify(data.outcomeVariables) !== JSON.stringify([sourceTable.outcomeColumn])
    || JSON.stringify(data.predictorVariables) !== JSON.stringify(predictorColumns)
    || !Array.isArray(data.transformations) || data.transformations.length !== 0
    || !Array.isArray(data.exclusions) || data.exclusions.length !== 0
    || !["complete-case", "not-applicable"].includes(String(missingData.strategy))
    || !dependenceMatches
    || ![quotedFormula, bareFormula].includes(String(model.formula))) {
    throw new Error("science-statistics-lmm-analysis-spec-source-mismatch");
  }
}

/**
 * The registered definition for a method, or null when the engine does not describe it.
 *
 * Loaded through the same integrity-verified plugin path the analysis itself runs from, so a
 * projection can never be built against a definition that differs from the one that will execute.
 */
function statisticsMethodDefinition(method: string): { dataSchema?: ScienceDeclaredSchemaNode } | null {
  try {
    // Through the shared resolver so this definition comes from the same pinned, verified release
    // the analysis will actually execute -- a second path here could hand back a schema from a
    // different copy of the plugin than the one that runs.
    const engine = loadSciencePluginRuntime<{
      METHOD_REGISTRY?: { byMethod?: Record<string, { dataSchema?: ScienceDeclaredSchemaNode }> };
    }>("agentlas-science-statistics", "runtime/engine.cjs", 16 * 1024 * 1024).runtime;
    const registered = engine.METHOD_REGISTRY?.byMethod?.[method];
    if (registered) return registered;
    // The core methods parse their input imperatively and register no definition, so their shapes
    // are declared beside the engine instead. Without this the analyses a researcher reaches for
    // first -- a t-test, a correlation, a regression -- could not read an uploaded table at all.
    const core = loadSciencePluginRuntime<{
      CORE_DATA_SCHEMAS?: Record<string, ScienceDeclaredSchemaNode>;
    }>("agentlas-science-statistics", "runtime/core-data-schemas.cjs", 4 * 1024 * 1024).runtime;
    const declared = core.CORE_DATA_SCHEMAS?.[method];
    return declared ? { dataSchema: declared } : null;
  } catch {
    return null;
  }
}

function projectStatisticsSourceTable(
  method: string,
  raw: Record<string, unknown>,
  table: ReturnType<typeof validateScienceTablePayload>,
  sourceArtifact: ScienceStatisticsInputArtifactBinding,
): { sourceTable: ScienceStatisticsSourceTableBinding; dataProjection: { data: Record<string, unknown>; receipt: ReturnType<typeof validateScienceStatisticsDataTableProjectionReceipt> } } {
  if (method === "kaplan_meier") {
    const timeColumn = boundedText(raw.timeColumn, 240, "statistics-source-time-column");
    const eventColumn = boundedText(raw.eventColumn, 240, "statistics-source-event-column");
    if (timeColumn === eventColumn) throw new Error("science-statistics-source-column-invalid");
    const label = raw.label === undefined ? "Kaplan-Meier" : boundedText(raw.label, 128, "statistics-source-label");
    requireStatisticsSourceColumn(table, timeColumn, ["integer", "number"]);
    requireStatisticsSourceColumn(table, eventColumn, ["integer", "number"]);
    const time: number[] = [];
    const event: number[] = [];
    const includedRows: Array<{ rowIndex: number; time: number; event: number }> = [];
    table.rows.forEach((row, rowIndex) => {
      const timeValue = row[timeColumn];
      const eventValue = row[eventColumn];
      if (typeof timeValue !== "number" || !Number.isFinite(timeValue) || timeValue <= 0) throw new Error(`science-statistics-source-row-${rowIndex}-time-invalid`);
      if (typeof eventValue !== "number" || !Number.isFinite(eventValue) || (eventValue !== 0 && eventValue !== 1)) throw new Error(`science-statistics-source-row-${rowIndex}-event-invalid`);
      time.push(timeValue);
      event.push(eventValue);
      includedRows.push({ rowIndex, time: timeValue, event: eventValue });
    });
    const sourceTable = { ...sourceArtifact, timeColumn, eventColumn, label };
    const projectedData = { time, event, label };
    const core = {
      schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA,
      sourceArtifact,
      sourceTableSha256: table.receipts.tableSha256,
      timeColumn,
      eventColumn,
      label,
      includedRowCount: includedRows.length,
      includedRowsSha256: scienceStatisticsSha256(includedRows),
      projectedDataSha256: scienceStatisticsSha256(projectedData),
    };
    return {
      sourceTable,
      dataProjection: { data: projectedData, receipt: validateScienceStatisticsDataTableProjectionReceipt({ ...core, receiptSha256: scienceStatisticsSha256(core) }) },
    };
  }
  if (method === "welch_one_way_anova") {
    const groupColumn = boundedText(raw.groupColumn, 240, "statistics-source-group-column");
    const valueColumn = boundedText(raw.valueColumn, 240, "statistics-source-value-column");
    if (raw.method !== method || raw.projectionKind !== "welch-one-way-anova-long" || groupColumn === valueColumn) throw new Error("science-statistics-source-method-invalid");
    requireStatisticsSourceColumn(table, groupColumn, ["string"]);
    requireStatisticsSourceColumn(table, valueColumn, ["integer", "number"]);
    const groups = new Map<string, number[]>();
    const includedRows: Array<{ rowIndex: number; group: string; value: number }> = [];
    table.rows.forEach((row, rowIndex) => {
      const group = boundedText(row[groupColumn], 240, `statistics-source-row-${rowIndex}-group`);
      const value = row[valueColumn];
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`science-statistics-source-row-${rowIndex}-value-invalid`);
      const values = groups.get(group) ?? [];
      values.push(value);
      groups.set(group, values);
      includedRows.push({ rowIndex, group, value });
    });
    // A Map preserves insertion order, which is the order the arms appear in the researcher's table.
    // For a dose study that order is the only thing that encodes low-dose before high-dose, and
    // sorting the labels alphabetically put control, high-dose, low-dose on the axis of a figure
    // captioned "dose response". The comparison itself is order-independent, so no statistic
    // changes; the axis and the reported row order follow the table instead of the alphabet.
    const names = [...groups.keys()];
    if (names.length < 2 || names.some((name) => (groups.get(name)?.length ?? 0) < 2)) throw new Error("science-statistics-source-group-incomplete");
    const projectedData = { groups: names.map((name) => ({ name, values: groups.get(name) as number[] })) };
    const sourceTable = { ...sourceArtifact, method: "welch_one_way_anova" as const, projectionKind: "welch-one-way-anova-long" as const, groupColumn, valueColumn };
    const core = {
      schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA,
      method,
      projectionKind: sourceTable.projectionKind,
      sourceArtifact,
      sourceTableSha256: table.receipts.tableSha256,
      columns: { groupColumn, valueColumn },
      includedRowCount: includedRows.length,
      includedRowsSha256: scienceStatisticsSha256(includedRows),
      projectedDataSha256: scienceStatisticsSha256(projectedData),
    };
    return { sourceTable, dataProjection: { data: projectedData, receipt: validateScienceStatisticsDataTableProjectionReceipt({ ...core, receiptSha256: scienceStatisticsSha256(core) }) } };
  }
  if (method === "friedman_test") {
    const blockColumn = boundedText(raw.blockColumn, 240, "statistics-source-block-column");
    const conditionColumn = boundedText(raw.conditionColumn, 240, "statistics-source-condition-column");
    const valueColumn = boundedText(raw.valueColumn, 240, "statistics-source-value-column");
    if (raw.method !== method || raw.projectionKind !== "friedman-long" || new Set([blockColumn, conditionColumn, valueColumn]).size !== 3) throw new Error("science-statistics-source-method-invalid");
    requireStatisticsSourceColumn(table, blockColumn, ["string"]);
    requireStatisticsSourceColumn(table, conditionColumn, ["string"]);
    requireStatisticsSourceColumn(table, valueColumn, ["integer", "number"]);
    const cells = new Map<string, Map<string, { rowIndex: number; value: number }>>();
    const conditionNames = new Set<string>();
    table.rows.forEach((row, rowIndex) => {
      const block = boundedText(row[blockColumn], 240, `statistics-source-row-${rowIndex}-block`);
      const condition = boundedText(row[conditionColumn], 240, `statistics-source-row-${rowIndex}-condition`);
      const value = row[valueColumn];
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`science-statistics-source-row-${rowIndex}-value-invalid`);
      const blockCells = cells.get(block) ?? new Map<string, { rowIndex: number; value: number }>();
      if (blockCells.has(condition)) throw new Error("science-statistics-source-cell-duplicate");
      blockCells.set(condition, { rowIndex, value });
      cells.set(block, blockCells);
      conditionNames.add(condition);
    });
    const blocks = [...cells.keys()].sort(compareStatisticsLabels);
    const conditions = [...conditionNames].sort(compareStatisticsLabels);
    if (blocks.length < 2 || conditions.length < 3) throw new Error("science-statistics-source-matrix-incomplete");
    const includedRows: Array<{ rowIndex: number; block: string; condition: string; value: number }> = [];
    for (const block of blocks) {
      const blockCells = cells.get(block) as Map<string, { rowIndex: number; value: number }>;
      if (blockCells.size !== conditions.length) throw new Error("science-statistics-source-matrix-incomplete");
      for (const condition of conditions) {
        const cell = blockCells.get(condition);
        if (!cell) throw new Error("science-statistics-source-matrix-incomplete");
        includedRows.push({ rowIndex: cell.rowIndex, block, condition, value: cell.value });
      }
    }
    const projectedData = { conditions: conditions.map((name) => ({ name, values: blocks.map((block) => (cells.get(block) as Map<string, { value: number }>).get(name)?.value as number) })) };
    const sourceTable = { ...sourceArtifact, method: "friedman_test" as const, projectionKind: "friedman-long" as const, blockColumn, conditionColumn, valueColumn };
    const core = {
      schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA,
      method,
      projectionKind: sourceTable.projectionKind,
      sourceArtifact,
      sourceTableSha256: table.receipts.tableSha256,
      columns: { blockColumn, conditionColumn, valueColumn },
      includedRowCount: includedRows.length,
      includedRowsSha256: scienceStatisticsSha256(includedRows),
      projectedDataSha256: scienceStatisticsSha256(projectedData),
    };
    return { sourceTable, dataProjection: { data: projectedData, receipt: validateScienceStatisticsDataTableProjectionReceipt({ ...core, receiptSha256: scienceStatisticsSha256(core) }) } };
  }
  if (method === "roc_curve_analysis") {
    const outcomeColumn = boundedText(raw.outcomeColumn, 240, "statistics-source-outcome-column");
    const scoreColumn = boundedText(raw.scoreColumn, 240, "statistics-source-score-column");
    const observationLabelColumn = raw.observationLabelColumn === undefined || raw.observationLabelColumn === null
      ? null : boundedText(raw.observationLabelColumn, 240, "statistics-source-observation-label-column");
    if (raw.method !== method || raw.projectionKind !== "roc-curve-analysis" || outcomeColumn === scoreColumn
      || observationLabelColumn === outcomeColumn || observationLabelColumn === scoreColumn) throw new Error("science-statistics-source-method-invalid");
    requireStatisticsSourceColumn(table, outcomeColumn, ["integer", "number"]);
    requireStatisticsSourceColumn(table, scoreColumn, ["integer", "number"]);
    if (observationLabelColumn) requireStatisticsSourceColumn(table, observationLabelColumn, ["string"]);
    const outcomes: number[] = [];
    const scores: number[] = [];
    const observationLabels: string[] = [];
    const includedRows: Array<{ rowIndex: number; outcome: number; score: number; observationLabel?: string }> = [];
    table.rows.forEach((row, rowIndex) => {
      const outcome = row[outcomeColumn];
      const score = row[scoreColumn];
      if (typeof outcome !== "number" || !Number.isFinite(outcome) || (outcome !== 0 && outcome !== 1)) throw new Error(`science-statistics-source-row-${rowIndex}-outcome-invalid`);
      if (typeof score !== "number" || !Number.isFinite(score)) throw new Error(`science-statistics-source-row-${rowIndex}-score-invalid`);
      const observationLabel = observationLabelColumn ? boundedText(row[observationLabelColumn], 240, `statistics-source-row-${rowIndex}-label`) : undefined;
      outcomes.push(outcome);
      scores.push(score);
      if (observationLabel !== undefined) observationLabels.push(observationLabel);
      includedRows.push({ rowIndex, outcome, score, ...(observationLabel === undefined ? {} : { observationLabel }) });
    });
    if (outcomes.length < 4 || outcomes.every((value) => value === 0) || outcomes.every((value) => value === 1)) throw new Error("science-statistics-source-outcomes-degenerate");
    if (observationLabelColumn && new Set(observationLabels).size !== observationLabels.length) throw new Error("science-statistics-source-observation-label-duplicate");
    const projectedData = { outcomes, scores, ...(observationLabelColumn ? { observationLabels } : {}) };
    const sourceTable = { ...sourceArtifact, method: "roc_curve_analysis" as const, projectionKind: "roc-curve-analysis" as const, outcomeColumn, scoreColumn, observationLabelColumn };
    const core = {
      schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA,
      method,
      projectionKind: sourceTable.projectionKind,
      sourceArtifact,
      sourceTableSha256: table.receipts.tableSha256,
      columns: { outcomeColumn, scoreColumn, observationLabelColumn },
      includedRowCount: includedRows.length,
      includedRowsSha256: scienceStatisticsSha256(includedRows),
      projectedDataSha256: scienceStatisticsSha256(projectedData),
    };
    return { sourceTable, dataProjection: { data: projectedData, receipt: validateScienceStatisticsDataTableProjectionReceipt({ ...core, receiptSha256: scienceStatisticsSha256(core) }) } };
  }
  if (method === "gaussian_random_intercept_lmm") {
    const outcomeColumn = boundedText(raw.outcomeColumn, 128, "statistics-source-outcome-column");
    const groupColumn = boundedText(raw.groupColumn, 128, "statistics-source-group-column");
    const observationLabelColumn = raw.observationLabelColumn === undefined || raw.observationLabelColumn === null
      ? null : boundedText(raw.observationLabelColumn, 128, "statistics-source-observation-label-column");
    const fixedEffects = normalizeStatisticsLmmFixedEffects(raw.fixedEffects);
    if (raw.method !== method || raw.projectionKind !== "gaussian-random-intercept-lmm-long") {
      throw new Error("science-statistics-source-method-invalid");
    }
    const selectedColumns = [outcomeColumn, groupColumn, ...(observationLabelColumn === null ? [] : [observationLabelColumn]), ...fixedEffects.map((item) => item.column)];
    if (new Set(selectedColumns).size !== selectedColumns.length) throw new Error("science-statistics-source-column-invalid");
    requireStatisticsSourceColumn(table, outcomeColumn, ["integer", "number"]);
    requireStatisticsSourceColumn(table, groupColumn, ["string", "integer"]);
    if (observationLabelColumn !== null) requireStatisticsSourceColumn(table, observationLabelColumn, ["string", "integer"]);
    fixedEffects.forEach((item) => requireStatisticsSourceColumn(table, item.column, item.type === "numeric" ? ["integer", "number"] : ["string", "integer"]));
    if (table.rows.length < 12 || table.rows.length > 10_000) throw new Error("science-statistics-source-lmm-row-count-invalid");
    const y: number[] = [];
    const groups: string[] = [];
    const observationLabels: string[] = [];
    const predictorValues = fixedEffects.map(() => [] as Array<number | string>);
    const includedRows: Array<{ rowIndex: number; outcome: number; group: string; observationLabel?: string; fixedEffectValues: Array<number | string> }> = [];
    table.rows.forEach((row, rowIndex) => {
      const outcome = row[outcomeColumn];
      if (typeof outcome !== "number" || !Number.isFinite(outcome) || Math.abs(outcome) > 1e15) {
        throw new Error(`science-statistics-source-row-${rowIndex}-outcome-invalid`);
      }
      const group = canonicalStatisticsCategory(row[groupColumn], 128, `statistics-source-row-${rowIndex}-group`);
      const observationLabel = observationLabelColumn === null ? undefined
        : canonicalStatisticsCategory(row[observationLabelColumn], 128, `statistics-source-row-${rowIndex}-observation-label`);
      const rowFixedEffectValues = fixedEffects.map((item, effectIndex) => {
        const value = row[item.column];
        if (item.type === "numeric") {
          if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15) {
            throw new Error(`science-statistics-source-row-${rowIndex}-fixed-effect-invalid`);
          }
          predictorValues[effectIndex].push(value);
          return value;
        }
        const level = canonicalStatisticsCategory(value, 128, `statistics-source-row-${rowIndex}-fixed-effect-level`);
        if (!item.levels.includes(level)) throw new Error(`science-statistics-source-row-${rowIndex}-fixed-effect-level-invalid`);
        predictorValues[effectIndex].push(level);
        return level;
      });
      y.push(outcome);
      groups.push(group);
      if (observationLabel !== undefined) observationLabels.push(observationLabel);
      includedRows.push({ rowIndex, outcome, group, ...(observationLabel === undefined ? {} : { observationLabel }), fixedEffectValues: rowFixedEffectValues });
    });
    const groupCounts = new Map<string, number>();
    groups.forEach((group) => groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1));
    if (groupCounts.size < 5 || [...groupCounts.values()].some((count) => count < 2)) throw new Error("science-statistics-source-lmm-groups-invalid");
    if (observationLabelColumn !== null && new Set(observationLabels).size !== observationLabels.length) {
      throw new Error("science-statistics-source-observation-label-duplicate");
    }
    const predictors = fixedEffects.map((item, index) => {
      const values = predictorValues[index];
      if (item.type === "numeric") {
        const numeric = values as number[];
        const range = statisticsNumericRange(numeric);
        if (range.minimum === range.maximum) throw new Error("science-statistics-source-fixed-effect-degenerate");
        return { name: item.column, type: "numeric" as const, values: numeric };
      }
      const categorical = values as string[];
      const observedLevels = [...new Set(categorical)].sort(compareStatisticsLabels);
      if (JSON.stringify(observedLevels) !== JSON.stringify(item.levels)) throw new Error("science-statistics-source-fixed-effect-levels-mismatch");
      if (categorical.every((value, rowIndex) => value === groups[rowIndex])) throw new Error("science-statistics-source-group-fixed-effect-duplicate");
      return { name: item.column, type: "categorical" as const, values: categorical, reference: item.reference };
    });
    const projectedData = {
      y,
      groups,
      predictors,
      outcomeLabel: outcomeColumn,
      groupLabel: groupColumn,
      ...(observationLabelColumn === null ? {} : { observationLabels }),
    };
    const sourceTable: ScienceStatisticsLmmSourceTableBinding = {
      ...sourceArtifact,
      method: "gaussian_random_intercept_lmm",
      projectionKind: "gaussian-random-intercept-lmm-long",
      outcomeColumn,
      groupColumn,
      observationLabelColumn,
      fixedEffects,
    };
    const core = {
      schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V3_SCHEMA,
      method: sourceTable.method,
      projectionKind: sourceTable.projectionKind,
      sourceArtifact,
      sourceTableSha256: table.receipts.tableSha256,
      columns: { outcomeColumn, groupColumn, observationLabelColumn, fixedEffects },
      includedRowCount: includedRows.length,
      includedRowsSha256: scienceStatisticsSha256(includedRows),
      projectedDataSha256: scienceStatisticsSha256(projectedData),
    };
    return { sourceTable, dataProjection: { data: projectedData, receipt: validateScienceStatisticsDataTableProjectionReceipt({ ...core, receiptSha256: scienceStatisticsSha256(core) }) } };
  }
  if (method === "response_surface_regression") {
    const responseColumn = boundedText(raw.responseColumn, 240, "statistics-source-response-column");
    const factor1Column = boundedText(raw.factor1Column, 240, "statistics-source-factor-1-column");
    const factor2Column = boundedText(raw.factor2Column, 240, "statistics-source-factor-2-column");
    if (raw.method !== method || raw.projectionKind !== "response-surface-regression"
      || new Set([responseColumn, factor1Column, factor2Column]).size !== 3) throw new Error("science-statistics-source-method-invalid");
    requireStatisticsSourceColumn(table, responseColumn, ["integer", "number"]);
    requireStatisticsSourceColumn(table, factor1Column, ["integer", "number"]);
    requireStatisticsSourceColumn(table, factor2Column, ["integer", "number"]);
    const responseValues: number[] = [];
    const factor1Values: number[] = [];
    const factor2Values: number[] = [];
    const includedRows: Array<{ rowIndex: number; response: number; factor1: number; factor2: number }> = [];
    table.rows.forEach((row, rowIndex) => {
      const response = row[responseColumn];
      const factor1 = row[factor1Column];
      const factor2 = row[factor2Column];
      if (![response, factor1, factor2].every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15)) {
        throw new Error(`science-statistics-source-row-${rowIndex}-response-surface-invalid`);
      }
      responseValues.push(response as number); factor1Values.push(factor1 as number); factor2Values.push(factor2 as number);
      includedRows.push({ rowIndex, response: response as number, factor1: factor1 as number, factor2: factor2 as number });
    });
    if (includedRows.length < 9) throw new Error("science-statistics-source-response-surface-insufficient");
    const coding = (values: number[]) => {
      const minimum = Math.min(...values); const maximum = Math.max(...values);
      const halfRange = (maximum - minimum) / 2; const center = minimum + halfRange;
      if (!Number.isFinite(center) || !Number.isFinite(halfRange) || !(halfRange > 0)
        || Math.abs(center) + halfRange > 1e15) throw new Error("science-statistics-source-response-surface-domain-invalid");
      return { kind: "center-half-range-to-minus-one-one", center, halfRange };
    };
    const projectedData = {
      response: { name: responseColumn, values: responseValues },
      factors: [
        { name: factor1Column, values: factor1Values, coding: coding(factor1Values) },
        { name: factor2Column, values: factor2Values, coding: coding(factor2Values) },
      ],
    };
    const sourceTable = { ...sourceArtifact, method: "response_surface_regression" as const, projectionKind: "response-surface-regression" as const, responseColumn, factor1Column, factor2Column };
    const core = {
      schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA,
      method,
      projectionKind: sourceTable.projectionKind,
      sourceArtifact,
      sourceTableSha256: table.receipts.tableSha256,
      columns: { responseColumn, factor1Column, factor2Column },
      includedRowCount: includedRows.length,
      includedRowsSha256: scienceStatisticsSha256(includedRows),
      projectedDataSha256: scienceStatisticsSha256(projectedData),
    };
    return { sourceTable, dataProjection: { data: projectedData, receipt: validateScienceStatisticsDataTableProjectionReceipt({ ...core, receiptSha256: scienceStatisticsSha256(core) }) } };
  }
  // Any method that has no bespoke projection above, projected against its own declared data shape.
  //
  // The six projections above were written one at a time, by hand, for six methods. The engine
  // registers 178. Everything else could only be reached by putting the numbers in the request,
  // which is the retyping this whole mechanism exists to prevent -- so 172 methods were unreachable
  // from an uploaded table, including every one added after the last hand-written projection.
  //
  // This projects from the method's own `dataSchema`, which the registry already validates, so a
  // method becomes reachable the day it is registered. Measured: 165 of 178 -- 141 of the 147
  // registered extension methods, and 23 of the 24 core methods whose shapes are declared beside
  // the engine in `core-data-schemas.cjs`. The rest are refused BY NAME rather than approximated.
  // The counts are re-measured by `science-statistics-table-reachability` and
  // `science-statistics-core-projection`; this comment is not where they are checked.
  if (raw.projectionKind === "declared-columns") {
    const definition = statisticsMethodDefinition(method);
    if (!definition) throw new Error("science-statistics-source-method-invalid");
    const mapping = raw.columns;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error("science-statistics-declared-mapping-invalid");
    // Narrow the table BEFORE projecting, when the caller asked to. Projection can only map columns
    // that exist, so without this the two things most studies need -- keep the rows above a
    // completeness cut, split a series into two windows -- were impossible on a real table.
    const prepared = prepareScienceTable(table, raw.preparation as ScienceTablePreparation | undefined);
    const projection = projectScienceDeclaredColumns(definition.dataSchema, prepared.table, mapping as Record<string, ScienceDeclaredColumnMapping>);
    const sourceTable = { ...sourceArtifact, method, projectionKind: "declared-columns" as const, columns: projection.columns };
    const core = {
      schema: SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V4_SCHEMA,
      method,
      projectionKind: "declared-columns" as const,
      sourceArtifact,
      sourceTableSha256: table.receipts.tableSha256,
      columns: projection.columns,
      // What was cut and what was derived, so the analysis can be re-run from the exact table
      // version and this rule alone. Absent when nothing was asked for.
      ...(prepared.receipt ? { preparation: prepared.receipt } : {}),
      includedRowCount: projection.includedRows.length,
      includedRowsSha256: scienceStatisticsSha256(projection.includedRows as unknown as Record<string, unknown>[]),
      projectedDataSha256: scienceStatisticsSha256(projection.data),
    };
    return {
      sourceTable: sourceTable as unknown as ScienceStatisticsSourceTableBinding,
      dataProjection: { data: projection.data, receipt: validateScienceStatisticsDataTableProjectionReceipt({ ...core, receiptSha256: scienceStatisticsSha256(core) }) },
    };
  }
  throw new Error("science-statistics-source-method-invalid");
}

function normalizeStatisticsInput(input: ExecuteStatisticsAnalysisInput, store: ScienceStore): Record<string, unknown> {
  if (!input || typeof input !== "object" || !input.request || typeof input.request !== "object" || Array.isArray(input.request)) {
    throw new Error("science-statistics-input-invalid");
  }
  const requestEnvelope = JSON.parse(canonicalJson(input.request)) as Record<string, unknown>;
  if (Object.keys(requestEnvelope).some((key) => !["schema", "method", "data", "options", "execution"].includes(key))) throw new Error("science-statistics-input-invalid");
  const hasInlineData = Object.hasOwn(requestEnvelope, "data");
  const hasSourceTable = input.sourceTable !== undefined;
  if (hasInlineData === hasSourceTable) throw new Error("science-statistics-data-source-conflict");
  const embedded = requestEnvelope.execution === undefined ? null : requestEnvelope.execution as Record<string, unknown>;
  if (embedded !== null && (!embedded || typeof embedded !== "object" || Array.isArray(embedded)
    || !exactObjectKeys(embedded, ["purpose", "input_artifacts", "analysis_spec"]))) throw new Error("science-statistics-execution-envelope-invalid");
  if (embedded !== null && !Array.isArray(embedded.input_artifacts)) throw new Error("science-statistics-input-artifact-binding-invalid");
  if (embedded && (input.purpose !== undefined || input.inputArtifacts !== undefined || input.analysisSpec !== undefined)) throw new Error("science-statistics-execution-envelope-conflict");
  const purpose = (input.purpose ?? embedded?.purpose) as ScienceStatisticsPurpose;
  if (!(["descriptive", "exploratory", "confirmatory"] as const).includes(purpose)) throw new Error("science-statistics-purpose-invalid");
  const request = {
    schema: requestEnvelope.schema,
    method: requestEnvelope.method,
    ...(Object.hasOwn(requestEnvelope, "options") ? { options: requestEnvelope.options } : {}),
  } as Record<string, unknown>;
  if (request.schema !== SCIENCE_STATISTICS_REQUEST_SCHEMA || !isScienceStatisticsMethod(request.method)) {
    throw new Error("science-statistics-input-invalid");
  }
  if (hasInlineData && (!requestEnvelope.data || typeof requestEnvelope.data !== "object" || Array.isArray(requestEnvelope.data))) {
    throw new Error("science-statistics-input-invalid");
  }
  if (purpose === "descriptive" && !["descriptive", "distribution_fit", "confidence_interval", "kaplan_meier"].includes(request.method)) {
    throw new Error("science-statistics-descriptive-method-invalid");
  }
  let sourceTable: ScienceStatisticsSourceTableBinding | null = null;
  let dataProjection: { data: Record<string, unknown>; receipt: ReturnType<typeof validateScienceStatisticsDataTableProjectionReceipt> } | null = null;
  if (hasSourceTable) {
    const raw = input.sourceTable as unknown as Record<string, unknown>;
    // The general projection is keyed by projection kind, not by method: it serves every method
    // that declares a data shape, so an allowlist of method names is the wrong gate for it. The
    // list below stays for the six bespoke projections, each of which reads named columns this
    // request shape cannot express.
    const declaredColumns = raw && (raw as Record<string, unknown>).projectionKind === "declared-columns";
    if (!declaredColumns && !["kaplan_meier", "welch_one_way_anova", "friedman_test", "roc_curve_analysis", "response_surface_regression", "gaussian_random_intercept_lmm"].includes(request.method)) {
      throw new Error("science-statistics-source-method-invalid");
    }
    const commonSourceKeys = ["artifactId", "artifactVersion", "contentSha256"];
    const expectedSourceKeys = declaredColumns
      ? [...commonSourceKeys, "method", "projectionKind", "columns"]
      : request.method === "kaplan_meier"
      ? [...commonSourceKeys, "timeColumn", "eventColumn", ...(raw && Object.hasOwn(raw, "label") ? ["label"] : [])]
      : request.method === "welch_one_way_anova"
        ? [...commonSourceKeys, "method", "projectionKind", "groupColumn", "valueColumn"]
        : request.method === "friedman_test"
          ? [...commonSourceKeys, "method", "projectionKind", "blockColumn", "conditionColumn", "valueColumn"]
          : request.method === "roc_curve_analysis"
            ? [...commonSourceKeys, "method", "projectionKind", "outcomeColumn", "scoreColumn", ...(raw && Object.hasOwn(raw, "observationLabelColumn") ? ["observationLabelColumn"] : [])]
            : request.method === "response_surface_regression"
              ? [...commonSourceKeys, "method", "projectionKind", "responseColumn", "factor1Column", "factor2Column"]
              : request.method === "gaussian_random_intercept_lmm"
                ? [...commonSourceKeys, "method", "projectionKind", "outcomeColumn", "groupColumn", "fixedEffects", ...(raw && Object.hasOwn(raw, "observationLabelColumn") ? ["observationLabelColumn"] : [])]
                : [];
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !exactObjectKeys(raw, expectedSourceKeys)
      || typeof raw.artifactId !== "string" || !Number.isSafeInteger(raw.artifactVersion) || Number(raw.artifactVersion) < 1
      || typeof raw.contentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.contentSha256)) {
      throw new Error("science-statistics-source-table-invalid");
    }
    const context = store.getArtifactContextForProject(input.projectId, raw.artifactId, Number(raw.artifactVersion));
    if (!context || context.selectedVersion.contentSha256 !== raw.contentSha256) throw new Error("science-statistics-source-artifact-not-found");
    if (context.artifact.kind !== SCIENCE_TABLE_ARTIFACT_KIND || context.selectedVersion.rendererId !== SCIENCE_TABLE_RENDERER_ID
      || context.linkage.labId !== SCIENCE_TABLE_LAB_ID) throw new Error("science-statistics-source-artifact-invalid");
    let table: ReturnType<typeof validateScienceTablePayload>;
    try { table = validateScienceTablePayload(context.selectedVersion.payload); }
    catch { throw new Error("science-statistics-source-artifact-invalid"); }
    const sourceArtifact = {
      artifactId: String(raw.artifactId), artifactVersion: Number(raw.artifactVersion), contentSha256: String(raw.contentSha256),
    };
    const projected = projectStatisticsSourceTable(String(request.method), raw, table, sourceArtifact);
    sourceTable = projected.sourceTable;
    dataProjection = projected.dataProjection;
  }
  const embeddedArtifacts = embedded?.input_artifacts;
  const rawArtifacts = (input.inputArtifacts ?? (Array.isArray(embeddedArtifacts) ? embeddedArtifacts.map((item) => {
    const entry = item as Record<string, unknown>;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !exactObjectKeys(entry, ["artifact_id", "artifact_version", "content_sha256"])) {
      throw new Error("science-statistics-input-artifact-binding-invalid");
    }
    return { artifactId: entry.artifact_id, artifactVersion: entry.artifact_version, contentSha256: entry.content_sha256 };
  }) : [])) as ScienceStatisticsInputArtifactBinding[];
  if (!Array.isArray(rawArtifacts) || rawArtifacts.length > 100) throw new Error("science-statistics-input-artifact-binding-invalid");
  let inputArtifacts = rawArtifacts.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !exactObjectKeys(raw as unknown as Record<string, unknown>, ["artifactId", "artifactVersion", "contentSha256"])
      || typeof raw.artifactId !== "string" || !Number.isSafeInteger(raw.artifactVersion) || raw.artifactVersion < 1
      || typeof raw.contentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.contentSha256)) throw new Error(`science-statistics-input-artifact-binding-${index}-invalid`);
    const context = store.getArtifactContextForProject(input.projectId, raw.artifactId, raw.artifactVersion);
    if (!context || context.selectedVersion.contentSha256 !== raw.contentSha256) throw new Error("science-statistics-input-artifact-not-found");
    return { artifactId: raw.artifactId, artifactVersion: raw.artifactVersion, contentSha256: raw.contentSha256 };
  });
  if (new Set(inputArtifacts.map((item) => `${item.artifactId}:${item.artifactVersion}`)).size !== inputArtifacts.length) throw new Error("science-statistics-input-artifact-binding-duplicate");
  if (sourceTable) {
    const expected = { artifactId: sourceTable.artifactId, artifactVersion: sourceTable.artifactVersion, contentSha256: sourceTable.contentSha256 };
    if (inputArtifacts.length > 0 && (inputArtifacts.length !== 1 || canonicalJson(inputArtifacts[0]) !== canonicalJson(expected))) {
      throw new Error("science-statistics-source-artifact-binding-mismatch");
    }
    inputArtifacts = [expected];
  } else if (inputArtifacts.length > 0) {
    throw new Error("science-statistics-inline-artifact-binding-forbidden");
  }
  let analysisPlan: ScienceStatisticsExecutionBinding["analysisPlan"] = null;
  if (purpose === "confirmatory") {
    const embeddedAnalysisSpec = embedded?.analysis_spec;
    let embeddedClaim: ExecuteStatisticsAnalysisInput["analysisSpec"] | undefined;
    if (embeddedAnalysisSpec && typeof embeddedAnalysisSpec === "object" && !Array.isArray(embeddedAnalysisSpec)) {
      const entry = embeddedAnalysisSpec as Record<string, unknown>;
      if (!exactObjectKeys(entry, ["analysis_spec_id", "version", "content_sha256", "status", "model_sha256"])) {
        throw new Error("science-statistics-analysis-plan-binding-invalid");
      }
      embeddedClaim = {
        analysisSpecId: entry.analysis_spec_id as string,
        version: entry.version as number,
        contentSha256: entry.content_sha256 as string,
        status: entry.status as "frozen",
        modelSha256: entry.model_sha256 as string,
      };
    }
    const claimed = input.analysisSpec ?? embeddedClaim;
    if (!claimed || !exactObjectKeys(claimed as unknown as Record<string, unknown>, ["analysisSpecId", "version", "contentSha256", "status", "modelSha256"])
      || typeof claimed.analysisSpecId !== "string" || !claimed.analysisSpecId.trim() || claimed.analysisSpecId.length > 160
      || claimed.status !== "frozen" || !Number.isSafeInteger(claimed.version) || claimed.version < 1
      || typeof claimed.contentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(claimed.contentSha256)
      || typeof claimed.modelSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(claimed.modelSha256)) {
      throw new Error("science-statistics-analysis-plan-binding-invalid");
    }
    const spec = store.getAnalysisSpecForProject(input.projectId, claimed.analysisSpecId);
    if (!spec || spec.status !== "frozen" || spec.frozenAt === null || spec.currentVersion !== claimed.version
      || spec.currentDocumentSha256 !== claimed.contentSha256 || spec.version.documentSha256 !== claimed.contentSha256) {
      throw new Error("science-statistics-analysis-plan-not-frozen-exact");
    }
    if (spec.version.document.data.inputs.length === 0 && spec.version.document.data.acquisition?.sources.length) {
      // An acquisition-only plan may authorize collection, but it intentionally does not identify
      // the immutable bytes used by an analysis. After collection the director must propose and get
      // approval for a successor plan whose exact inputs match this execution request.
      throw new Error("science-statistics-execution-exact-input-plan-required");
    }
    if (canonicalJson(inputArtifacts) !== canonicalJson(spec.version.document.data.inputs)) throw new Error("science-statistics-analysis-input-binding-mismatch");
    const model = spec.version.document.model as unknown as Record<string, unknown> | null;
    if (!model || scienceStatisticsSha256(model) !== claimed.modelSha256) throw new Error("science-statistics-analysis-model-binding-mismatch");
    const plannedMethodToken = `agentlas.statistics.method:${request.method}`;
    if (!spec.version.document.requiredDiagnostics.includes(plannedMethodToken)) throw new Error("science-statistics-analysis-method-not-frozen");
    if (!scienceStatisticsMethodMatchesAnalysisModel(request.method, model)) throw new Error("science-statistics-analysis-method-model-mismatch");
    if (request.method === "gaussian_random_intercept_lmm") {
      if (!sourceTable || !("method" in sourceTable) || sourceTable.method !== "gaussian_random_intercept_lmm") {
        throw new Error("science-statistics-lmm-source-binding-required");
      }
      assertStatisticsLmmAnalysisSpecCompatibility(sourceTable, spec.version.document as unknown as Record<string, unknown>);
    }
    analysisPlan = {
      analysisSpecId: spec.id,
      version: spec.currentVersion,
      contentSha256: spec.currentDocumentSha256,
      status: "frozen",
      plannedMethodToken,
      model: JSON.parse(canonicalJson(model)) as ScienceAnalysisModelSpec,
      modelSha256: claimed.modelSha256,
    };
  } else if (input.analysisSpec !== undefined || (embedded !== null && embedded.analysis_spec !== null)) {
    throw new Error("science-statistics-analysis-plan-forbidden");
  }
  const bindingCore = { schema: SCIENCE_STATISTICS_EXECUTION_BINDING_SCHEMA, purpose, inputArtifacts, analysisPlan };
  const executionBinding = validateScienceStatisticsExecutionBinding({ ...bindingCore, bindingSha256: scienceStatisticsSha256(bindingCore) }, request.method);
  const normalized = sourceTable && dataProjection
    ? { ...request, sourceTable, dataProjection, executionBinding }
    : { ...request, data: requestEnvelope.data, executionBinding };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > STATISTICS_MAX_INPUT_BYTES) throw new Error("science-statistics-input-invalid");
  return normalized;
}

function normalizePhysicsDatasetInput(input: ExecutePhysicsDatasetInput): Record<string, unknown> {
  if (!input || typeof input !== "object" || !Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > 64
    || !Array.isArray(input.rows) || input.rows.length > 10_000) throw new Error("science-physics-input-invalid");
  const title = boundedText(input.title, 500, "physics-title");
  const names = new Set<string>();
  const columns = input.columns.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !["number", "string"].includes(String(raw.type))) throw new Error(`science-physics-column-${index}-invalid`);
    const name = boundedText(raw.name, 160, `physics-column-${index}-name`);
    if (names.has(name)) throw new Error("science-physics-column-duplicate");
    names.add(name);
    const unit = raw.unit === undefined || raw.unit === null || raw.unit === "" ? undefined : boundedText(raw.unit, 120, `physics-column-${index}-unit`);
    return { name, type: raw.type, ...(unit === undefined ? {} : { unit }) };
  });
  const rows = input.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error(`science-physics-row-${rowIndex}-width-invalid`);
    return row.map((cell, columnIndex) => {
      if (cell === null) return null;
      if (columns[columnIndex].type === "number") {
        if (typeof cell !== "number" || !Number.isFinite(cell)) throw new Error(`science-physics-row-${rowIndex}-cell-${columnIndex}-invalid`);
        return Object.is(cell, -0) ? 0 : cell;
      }
      if (typeof cell !== "string" || cell.length > 2_000 || /[\u0000-\u001f\u007f]/u.test(cell)) throw new Error(`science-physics-row-${rowIndex}-cell-${columnIndex}-invalid`);
      return cell;
    });
  });
  const normalized = { title, columns, rows };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > 4 * 1024 * 1024) throw new Error("science-physics-input-too-large");
  return normalized;
}

function normalizeCitationNetworkInput(input: ExecuteAcademicToCitationNetworkInput, store: ScienceStore): Record<string, unknown> {
  const searchRun = store.getResearchRunForProject(input.projectId, input.searchRunId);
  if (!searchRun || searchRun.status !== "succeeded" || searchRun.toolId !== "agentlas.academic-search" || searchRun.toolVersion !== "1.0.0") {
    throw new Error("science-tool-academic-search-run-invalid");
  }
  if (searchRun.outputs.length !== 1) throw new Error("science-tool-academic-search-output-invalid");
  const output = searchRun.outputs[0];
  if (output.role !== "search-results" || output.mimeType !== "application/vnd.agentlas.academic-search-results+json") {
    throw new Error("science-tool-academic-search-output-invalid");
  }
  let searchResult: Record<string, unknown>;
  try {
    searchResult = JSON.parse(store.readRunBlob({ blobRef: output.blobRef, sha256: output.sha256, byteSize: output.byteSize }).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("science-tool-academic-search-output-invalid");
  }
  if (searchResult.schema !== "agentlas.academic-search-result/v1" || searchResult.runId !== searchRun.id || !Array.isArray(searchResult.records) || searchResult.records.length < 1) {
    throw new Error("science-tool-academic-search-output-invalid");
  }
  const maxRecords = Math.max(2, Math.min(200, Math.floor(input.maxRecords ?? 50)));
  return {
    schema: "agentlas.science-academic-to-citation-network-input/v1",
    title: boundedText(input.title, 240, "title"),
    searchRunId: searchRun.id,
    searchOutputSha256: output.sha256,
    query: boundedText(searchResult.query, 1_000, "academic-query"),
    records: searchResult.records.slice(0, maxRecords),
  };
}

function normalizeAstronomySkyInput(input: ExecuteAstronomyToSkyMapInput, store: ScienceStore): Record<string, unknown> {
  const catalogRun = store.getResearchRunForProject(input.projectId, input.catalogRunId);
  if (!catalogRun || catalogRun.status !== "succeeded" || catalogRun.toolId !== "agentlas.astronomy-catalog" || catalogRun.toolVersion !== "1.0.0") {
    throw new Error("science-tool-astronomy-catalog-run-invalid");
  }
  const output = catalogRun.outputs.find((resource) => resource.role === "catalog-results" && resource.mimeType === "application/vnd.agentlas.astronomy-catalog-results+json");
  const raw = catalogRun.outputs.find((resource) => resource.role === "provider-response" && resource.mimeType === "application/json");
  if (!output || !raw || catalogRun.outputs.length !== 2) throw new Error("science-tool-astronomy-catalog-output-invalid");
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(store.readRunBlob(output).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("science-tool-astronomy-catalog-output-invalid");
  }
  if (result.schema !== "agentlas.astronomy-catalog-result/v1" || result.provider !== "simbad-tap" || result.runId !== catalogRun.id
    || !Array.isArray(result.objects) || typeof result.query !== "object" || result.query === null || Array.isArray(result.query)
    || typeof result.receipt !== "object" || result.receipt === null || Array.isArray(result.receipt)
    || typeof result.sourceId !== "string" || typeof result.sourceVersionId !== "string") {
    throw new Error("science-tool-astronomy-catalog-output-invalid");
  }
  const receipt = result.receipt as Record<string, unknown>;
  if (receipt.responseSha256 !== raw.sha256) throw new Error("science-tool-astronomy-catalog-raw-response-invalid");
  return {
    schema: "agentlas.science-astronomy-to-sky-map-input/v1",
    title: boundedText(input.title, 240, "title"),
    catalogRunId: catalogRun.id,
    catalogOutputSha256: output.sha256,
    rawResponseSha256: raw.sha256,
    provider: "simbad-tap",
    query: result.query,
    sourceId: result.sourceId,
    sourceVersionId: result.sourceVersionId,
    receipt: result.receipt,
    objects: result.objects,
  };
}

function normalizeAstronomyLightCurvePeriodicityInput(
  input: ExecuteAstronomyLightCurvePeriodicityInput,
  store: ScienceStore,
  pluginRuntimeSha256: string,
): ScienceAstronomyLightCurveInputDescriptor {
  if (!input || typeof input !== "object" || !input.sourceTable || !input.columns || !input.analysis) {
    throw new Error("science-tool-astronomy-light-curve-input-invalid");
  }
  const source = input.sourceTable;
  if (typeof source.artifactId !== "string" || !Number.isSafeInteger(source.artifactVersion) || source.artifactVersion < 1
    || typeof source.contentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.contentSha256)) {
    throw new Error("science-tool-astronomy-light-curve-source-binding-invalid");
  }
  const context = store.getArtifactContextForProject(input.projectId, source.artifactId, source.artifactVersion);
  if (!context || context.selectedVersion.contentSha256 !== source.contentSha256
    || context.artifact.kind !== SCIENCE_TABLE_ARTIFACT_KIND || context.selectedVersion.rendererId !== SCIENCE_TABLE_RENDERER_ID
    || context.linkage.labId !== SCIENCE_TABLE_LAB_ID || !context.artifact.sourceRunId) {
    throw new Error("science-tool-astronomy-light-curve-source-artifact-invalid");
  }
  const parentRun = store.getResearchRunForProject(input.projectId, context.artifact.sourceRunId);
  if (!parentRun || parentRun.status !== "succeeded" || !store.getRunArtifactBinding(input.projectId, parentRun.id)) {
    throw new Error("science-tool-astronomy-light-curve-source-run-invalid");
  }
  let table: ReturnType<typeof validateScienceTablePayload>;
  try { table = validateScienceTablePayload(context.selectedVersion.payload); }
  catch { throw new Error("science-tool-astronomy-light-curve-source-artifact-invalid"); }
  const columns = input.columns;
  const columnByName = new Map(table.columns.map((column) => [column.name, column]));
  const requireColumn = (name: unknown, allowedTypes: readonly string[], requireNonNullable: boolean, code: string) => {
    if (typeof name !== "string" || !name.trim() || name.length > 240 || /[\u0000-\u001f]/u.test(name)) throw new Error(code);
    const column = columnByName.get(name);
    if (!column || !allowedTypes.includes(column.logicalType) || (requireNonNullable && column.nullable)) throw new Error(code);
    return name;
  };
  // An inclusion mask is a refinement, not a fact of the measurement.
  //
  // This column used to be mandatory, and a published light curve does not carry one: the seeded
  // catalogue here has observation id, time, magnitude and uncertainty, and nothing boolean. So the
  // tool demanded a column real photometry never has, and refused every table it was ever pointed
  // at. Measured on a live study: the director reached this exact call and was turned away with
  // `use-column-invalid` on a table whose four columns were all correct.
  //
  // Absent, every row is used, and the receipt says so, so an analysis can never quietly claim a
  // mask it did not apply.
  const useColumnDeclared = columns.useColumn !== undefined && columns.useColumn !== null && columns.useColumn !== "";
  const exactColumns = {
    observationIdColumn: requireColumn(columns.observationIdColumn, ["string"], true, "science-tool-astronomy-light-curve-observation-id-column-invalid"),
    timeColumn: requireColumn(columns.timeColumn, ["integer", "number"], false, "science-tool-astronomy-light-curve-time-column-invalid"),
    valueColumn: requireColumn(columns.valueColumn, ["integer", "number"], false, "science-tool-astronomy-light-curve-value-column-invalid"),
    standardErrorColumn: requireColumn(columns.standardErrorColumn, ["integer", "number"], false, "science-tool-astronomy-light-curve-standard-error-column-invalid"),
    useColumn: useColumnDeclared
      ? requireColumn(columns.useColumn, ["boolean"], true, "science-tool-astronomy-light-curve-use-column-invalid")
      : null,
  };
  const declaredNames = Object.values(exactColumns).filter((name): name is string => typeof name === "string");
  if (new Set(declaredNames.map((name) => name.toLocaleLowerCase("en-US"))).size !== declaredNames.length) {
    throw new Error("science-tool-astronomy-light-curve-column-duplicate");
  }
  const measurements = table.rows.map((row, rowIndex) => {
    const observationId = row[exactColumns.observationIdColumn];
    const time = row[exactColumns.timeColumn];
    const value = row[exactColumns.valueColumn];
    const standardError = row[exactColumns.standardErrorColumn];
    // No declared mask means every measurement is in, which is what a table without the column means.
    const use = exactColumns.useColumn === null ? true : row[exactColumns.useColumn];
    if (typeof observationId !== "string" || !observationId.trim() || observationId.length > 160 || /[\u0000-\u001f]/u.test(observationId)) {
      throw new Error(`science-tool-astronomy-light-curve-row-${rowIndex}-observation-id-invalid`);
    }
    if (!(time === null || (typeof time === "number" && Number.isFinite(time)))) throw new Error(`science-tool-astronomy-light-curve-row-${rowIndex}-time-invalid`);
    if (!(value === null || (typeof value === "number" && Number.isFinite(value)))) throw new Error(`science-tool-astronomy-light-curve-row-${rowIndex}-value-invalid`);
    if (!(standardError === null || (typeof standardError === "number" && Number.isFinite(standardError) && standardError > 0))) {
      throw new Error(`science-tool-astronomy-light-curve-row-${rowIndex}-standard-error-invalid`);
    }
    if (typeof use !== "boolean") throw new Error(`science-tool-astronomy-light-curve-row-${rowIndex}-use-invalid`);
    return { observationId, time, value, standardError, use };
  });
  return validateScienceAstronomyLightCurveInputDescriptor({
    schema: "agentlas.science.astronomy-light-curve-periodicity-input/v1",
    title: boundedText(input.title, 240, "title"),
    runtime: { pluginId: "agentlas-astronomy", pluginVersion: SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION, runtimeSha256: pluginRuntimeSha256 },
    sourceTable: {
      artifactId: context.artifact.id,
      artifactVersion: context.selectedVersion.version,
      contentSha256: context.selectedVersion.contentSha256,
      rawSha256: table.receipts.rawSha256,
      tableSha256: table.receipts.tableSha256,
    },
    columns: exactColumns,
    analysis: input.analysis,
    measurements,
  });
}

function normalizeBiodiversityMapInput(input: ExecuteBiodiversityToMapInput, store: ScienceStore): Record<string, unknown> {
  const catalogRun = store.getResearchRunForProject(input.projectId, input.catalogRunId);
  if (!catalogRun || catalogRun.status !== "succeeded" || catalogRun.toolId !== "agentlas.biodiversity-catalog" || catalogRun.toolVersion !== "1.0.0") {
    throw new Error("science-tool-biodiversity-catalog-run-invalid");
  }
  const output = catalogRun.outputs.find((resource) => resource.role === "catalog-results" && resource.mimeType === "application/vnd.agentlas.biodiversity-catalog-results+json");
  const raw = catalogRun.outputs.find((resource) => resource.role === "provider-response" && resource.mimeType === "application/json");
  if (!output || !raw || catalogRun.outputs.length !== 2) throw new Error("science-tool-biodiversity-catalog-output-invalid");
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(store.readRunBlob(output).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("science-tool-biodiversity-catalog-output-invalid");
  }
  if (result.schema !== "agentlas.biodiversity-catalog-result/v1" || result.provider !== "gbif-occurrence" || result.runId !== catalogRun.id
    || !Array.isArray(result.occurrences) || typeof result.query !== "object" || result.query === null || Array.isArray(result.query)
    || typeof result.receipt !== "object" || result.receipt === null || Array.isArray(result.receipt)
    || typeof result.sourceId !== "string" || typeof result.sourceVersionId !== "string") {
    throw new Error("science-tool-biodiversity-catalog-output-invalid");
  }
  const receipt = result.receipt as Record<string, unknown>;
  if (receipt.responseSha256 !== raw.sha256) throw new Error("science-tool-biodiversity-catalog-raw-response-invalid");
  return {
    schema: "agentlas.science-biodiversity-to-map-input/v1",
    title: boundedText(input.title, 240, "title"),
    catalogRunId: catalogRun.id,
    catalogOutputSha256: output.sha256,
    rawResponseSha256: raw.sha256,
    provider: "gbif-occurrence",
    query: result.query,
    sourceId: result.sourceId,
    sourceVersionId: result.sourceVersionId,
    receipt: result.receipt,
    occurrences: result.occurrences,
  };
}

function normalizeEarthquakeMapInput(input: ExecuteEarthquakeToMapInput, store: ScienceStore): Record<string, unknown> {
  const catalogRun = store.getResearchRunForProject(input.projectId, input.catalogRunId);
  if (!catalogRun || catalogRun.status !== "succeeded" || catalogRun.toolId !== "agentlas.earthquake-catalog" || catalogRun.toolVersion !== "1.0.0") {
    throw new Error("science-tool-earthquake-catalog-run-invalid");
  }
  const output = catalogRun.outputs.find((resource) => resource.role === "catalog-results" && resource.mimeType === "application/vnd.agentlas.earthquake-catalog-results+json");
  const raw = catalogRun.outputs.find((resource) => resource.role === "provider-response" && resource.mimeType === "application/geo+json");
  if (!output || !raw || catalogRun.outputs.length !== 2) throw new Error("science-tool-earthquake-catalog-output-invalid");
  let result: Record<string, unknown>;
  try { result = JSON.parse(store.readRunBlob(output).toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("science-tool-earthquake-catalog-output-invalid"); }
  if (result.schema !== "agentlas.earthquake-catalog-result/v1" || result.provider !== "usgs-fdsn-event" || result.runId !== catalogRun.id
    || typeof result.catalog !== "object" || result.catalog === null || Array.isArray(result.catalog)
    || typeof result.query !== "object" || result.query === null || Array.isArray(result.query)
    || typeof result.receipt !== "object" || result.receipt === null || Array.isArray(result.receipt)
    || typeof result.sourceId !== "string" || typeof result.sourceVersionId !== "string") throw new Error("science-tool-earthquake-catalog-output-invalid");
  const receipt = result.receipt as Record<string, unknown>;
  if (receipt.rawResponseSha256 !== raw.sha256) throw new Error("science-tool-earthquake-catalog-raw-response-invalid");
  return {
    schema: "agentlas.science-earthquake-to-map-input/v1", title: boundedText(input.title, 240, "title"), catalogRunId: catalogRun.id,
    catalogOutputSha256: output.sha256, rawResponseSha256: raw.sha256, provider: "usgs-fdsn-event", query: result.query,
    sourceId: result.sourceId, sourceVersionId: result.sourceVersionId, receipt: result.receipt, catalog: result.catalog,
  };
}

function normalizeMolstarInput(input: ExecuteSourceToMolstarInput, source: NonNullable<ReturnType<ScienceStore["getSourceVersionForProject"]>>): Record<string, unknown> {
  const mime = String(source.version.mimeType ?? "").toLowerCase().split(";", 1)[0].trim();
  const format = mime === "chemical/x-pdb" || mime === "text/x-pdb" || mime === "application/x-pdb"
    ? "pdb"
    : mime === "chemical/x-cif" || mime === "chemical/x-mmcif" || mime === "application/x-mmcif" || mime === "text/x-mmcif"
      ? "mmcif"
      : null;
  if (!format || !source.version.contentSha256) throw new Error("science-tool-source-structure-format-invalid");
  const representation = input.representation ?? "cartoon";
  if (!["cartoon", "ball-and-stick", "surface"].includes(representation)) throw new Error("science-tool-representation-invalid");
  const colorTheme = input.colorTheme ?? defaultScienceProteinColorTheme(representation);
  if (!["chain-id", "element-symbol", "secondary-structure"].includes(colorTheme)) throw new Error("science-tool-color-theme-invalid");
  return {
    schema: "agentlas.science-source-to-molstar-input/v1",
    title: boundedText(input.title ?? source.title, 240, "title"),
    source: {
      id: source.id,
      versionId: source.version.id,
      contentSha256: source.version.contentSha256,
      format,
    },
    representation,
    colorTheme,
  };
}

function normalizeKetcherInput(input: ExecuteSmilesToKetcherInput): Record<string, unknown> {
  return {
    schema: "agentlas.science-ketcher-validation-input/v1",
    title: boundedText(input.title, 240, "title"),
    source: { format: "smiles", value: boundedText(input.smiles, 100_000, "smiles") },
  };
}

function normalizeSourceKetcherInput(
  input: ExecuteSourceToKetcherInput,
  verified: ReturnType<ScienceStore["getVerifiedScientificDataChemistrySourceForTool"]>,
): Record<string, unknown> {
  const value = verified.bytes.toString("utf8");
  if (Buffer.from(value, "utf8").length !== verified.bytes.length
    || sha256(Buffer.from(value, "utf8")) !== verified.source.version.contentSha256) {
    throw new Error("science-tool-source-chemistry-encoding-invalid");
  }
  return {
    schema: "agentlas.science-source-to-ketcher-input/v2",
    title: boundedText(input.title ?? verified.source.title, 240, "title"),
    retrievalRunId: verified.retrievalRun.id,
    retrievalOutputSha256: verified.retrievalOutputSha256,
    expectedIdentity: {
      provider: "pubchem",
      canonicalExternalId: verified.externalId,
      canonicalSmiles: verified.canonicalSmiles,
    },
    source: {
      id: verified.source.id,
      versionId: verified.source.version.id,
      contentSha256: verified.source.version.contentSha256,
      format: verified.format,
      value,
    },
  };
}

function readRegularFileNoFollow(target: string, maximum: number): Buffer {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(target, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error("science-tool-output-file-invalid");
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read < 1) throw new Error("science-tool-output-short-read");
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("science-tool-output-file-changed");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

type ScienceChildExecutionPolicy = {
  timeoutMs?: number;
  nodeArgs?: readonly string[];
};

async function runChild(
  workerPath: string,
  jobRoot: string,
  onSpawn: (pid: number) => void,
  policy: ScienceChildExecutionPolicy = {},
): Promise<{ pid: number; exitCode: number; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(policy.nodeArgs ?? []), workerPath, path.join(jobRoot, "input.json"), path.join(jobRoot, "output.json")], {
      cwd: jobRoot,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TMPDIR: jobRoot,
      },
    });
    const pid = child.pid;
    if (!pid) {
      reject(new Error("science-tool-child-pid-missing"));
      return;
    }
    try {
      onSpawn(pid);
    } catch (error) {
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already exited */ }
      reject(error);
      return;
    }
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const terminate = () => {
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already exited */ }
    };
    const timer = setTimeout(() => {
      terminate();
      if (!settled) {
        settled = true;
        reject(new Error("science-tool-timeout"));
      }
    }, policy.timeoutMs ?? TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_LOG_BYTES) terminate();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_LOG_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_LOG_BYTES);
      if (Buffer.byteLength(stderr, "utf8") > MAX_LOG_BYTES) terminate();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (stdoutBytes > MAX_LOG_BYTES) reject(new Error("science-tool-stdout-limit"));
      else if (signal) reject(new Error(`science-tool-signal-${signal}`));
      else if (code !== 0) reject(new Error(`science-tool-exit-${code}:${stderr.slice(0, 1_000)}`));
      else resolve({ pid, exitCode: code, stderr });
    });
  });
}

export class ScienceToolGateway {
  private readonly active = new Map<string, Promise<ScienceToolExecutionReceipt>>();
  private readonly activeInputSha256 = new Map<string, string>();
  private readonly activeChildPids = new Map<string, number>();
  private readonly invocationRequests = new Map<string, Set<string>>();
  private readonly cancelledRequests = new Set<string>();
  private accepting = true;

  constructor(private readonly store: ScienceStore, private readonly rendererAuthority?: ScienceRendererAuthorityResolver) {}

  openAdmission(): void {
    this.accepting = true;
  }

  closeAdmission(): void {
    this.accepting = false;
  }

  activeRequestCount(): number {
    return this.active.size;
  }

  async shutdownForAppClose(): Promise<{ interruptedRequests: number }> {
    this.closeAdmission();
    const activePromises = [...this.active.values()];
    let interruptedRequests = 0;
    for (const requestId of this.active.keys()) {
      this.cancelledRequests.add(requestId);
      const pid = this.activeChildPids.get(requestId);
      if (pid) {
        try {
          if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else process.kill(pid, "SIGKILL");
        } catch { /* The exact child tree may already have settled. */ }
      }
      interruptedRequests += 1;
    }
    await Promise.allSettled(activePromises);
    return { interruptedRequests };
  }

  private assertAdmission(): void {
    if (!this.accepting) throw new Error("science-tool-runtime-closing");
  }

  executeTableToVega(input: ExecuteTableToVegaInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeTableToVegaOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executeStatisticsAnalysis(input: ExecuteStatisticsAnalysisInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeStatisticsAnalysisOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executePhysicsDataset(input: ExecutePhysicsDatasetInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executePhysicsDatasetOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executeAcademicToCitationNetwork(input: ExecuteAcademicToCitationNetworkInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeAcademicToCitationNetworkOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executeAstronomyToSkyMap(input: ExecuteAstronomyToSkyMapInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeAstronomyToSkyMapOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executeAstronomyLightCurvePeriodicity(input: ExecuteAstronomyLightCurvePeriodicityInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeAstronomyLightCurvePeriodicityOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executeBiodiversityToMap(input: ExecuteBiodiversityToMapInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeBiodiversityToMapOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executeEarthquakeToMap(input: ExecuteEarthquakeToMapInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256 ? active : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeEarthquakeToMapOnce(input).finally(() => {
      this.active.delete(key); this.activeInputSha256.delete(key); this.activeChildPids.delete(key); this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId); requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise); this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executeSourceToMolstar(input: ExecuteSourceToMolstarInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeSourceToMolstarOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executeSmilesToKetcher(input: ExecuteSmilesToKetcherInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeSmilesToKetcherOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  executeSourceToKetcher(input: ExecuteSourceToKetcherInput): Promise<ScienceToolExecutionReceipt> {
    this.assertAdmission();
    const key = String(input?.requestId ?? "");
    const inputSha256 = sha256(canonicalJson(input));
    const active = this.active.get(key);
    if (active) return this.activeInputSha256.get(key) === inputSha256
      ? active
      : Promise.reject(new Error("science-tool-request-replay-conflict"));
    const promise = this.executeSourceToKetcherOnce(input).finally(() => {
      this.active.delete(key);
      this.activeInputSha256.delete(key);
      this.activeChildPids.delete(key);
      this.cancelledRequests.delete(key);
      if (input.invocationRunId) {
        const requests = this.invocationRequests.get(input.invocationRunId);
        requests?.delete(key);
        if (requests?.size === 0) this.invocationRequests.delete(input.invocationRunId);
      }
    });
    this.active.set(key, promise);
    this.activeInputSha256.set(key, inputSha256);
    return promise;
  }

  cancelInvocation(invocationRunId: string): number {
    const executions = this.store.listToolExecutionsForInvocation(invocationRunId);
    let cancelled = 0;
    for (const execution of executions) {
      if (["committed", "failed", "cancelled", "interrupted"].includes(execution.phase)) continue;
      this.cancelledRequests.add(execution.requestId);
      const pid = this.activeChildPids.get(execution.requestId);
      if (pid) {
        try {
          if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else process.kill(pid, "SIGKILL");
        } catch { /* child already settled */ }
      } else {
        const run = this.store.getResearchRunForProject(execution.projectId, execution.runId);
        if (run?.status === "running") {
          this.store.completeResearchRun({
            requestId: stableUuid(`science-tool-run-cancel:v1:${execution.id}`),
            projectId: execution.projectId,
            runId: execution.runId,
            status: "cancelled",
            outputManifestSha256: sha256(canonicalJson([])),
            summary: "Tool execution was cancelled by the owning Science turn.",
            outputs: [],
          });
        }
        this.store.markToolExecutionTerminal(execution.projectId, execution.requestId, "cancelled", "science-tool-cancelled-by-turn");
      }
      cancelled += 1;
    }
    return cancelled;
  }

  async reconcileAfterStoreReady(): Promise<{ interrupted: number; finalized: number; alreadyCommitted: number; deferredBinding: number; quarantined: number }> {
    const result = { interrupted: 0, finalized: 0, alreadyCommitted: 0, deferredBinding: 0, quarantined: 0 };
    for (const execution of this.store.listRecoverableToolExecutions(1_000)) {
      try {
        if (execution.phase === "reserved" || execution.phase === "spawned") {
          const run = this.store.getResearchRunForProject(execution.projectId, execution.runId);
          if (run?.status === "running") {
            this.store.completeResearchRun({
              requestId: stableUuid(`science-tool-reconcile-run:v1:${execution.id}`),
              projectId: execution.projectId,
              runId: execution.runId,
              status: "failed",
              outputManifestSha256: sha256(canonicalJson([])),
              summary: "Tool execution was interrupted before a durable output checkpoint.",
              outputs: [],
            });
          }
          this.store.markToolExecutionTerminal(execution.projectId, execution.requestId, "interrupted", "science-tool-restart-interrupted");
          result.interrupted += 1;
          continue;
        }
        await this.finalizeExecution(execution, true);
        result.finalized += 1;
      } catch (error) {
        if (error instanceof Error && (error.message === "science-tool-renderer-authority-unavailable" || error.message === "science-tool-renderer-binding-unavailable")) {
          result.deferredBinding += 1;
          continue;
        }
        try {
          this.store.markToolExecutionTerminal(execution.projectId, execution.requestId, "interrupted", "science-tool-recovery-quarantined");
        } catch { /* preserve original evidence */ }
        result.quarantined += 1;
      }
    }
    return result;
  }

  private committedReceipt(execution: ScienceToolExecution, inputBlob: ScienceRunBlobReceipt, workerSha256: string, environmentSha256: string, replayed: boolean): ScienceToolExecutionReceipt {
    const run = this.store.getResearchRunForProject(execution.projectId, execution.runId);
    const binding = this.store.getRunArtifactBinding(execution.projectId, execution.runId);
    const artifact = binding ? this.store.getArtifactForProject(execution.projectId, binding.artifactId) : null;
    const output = run?.outputs[execution.outputOrdinal - 1];
    if (!run || run.status !== "succeeded" || !binding || !artifact || !output || execution.phase !== "committed") {
      throw new Error("science-tool-replay-integrity-failed");
    }
    if (execution.workerSha256 !== workerSha256 || execution.environmentSha256 !== environmentSha256
      || run.environmentSha256 !== environmentSha256) {
      throw new Error("science-tool-runtime-drift");
    }
    return {
      schema: "agentlas.science-tool-execution/v1",
      requestId: execution.requestId,
      toolId: execution.toolId,
      toolVersion: execution.toolVersion,
      workerSha256,
      environmentSha256,
      childPid: null,
      exitCode: 0,
      input: inputBlob,
      output: { blobRef: output.blobRef, sha256: output.sha256, byteSize: output.byteSize },
      run,
      artifact,
      binding,
      replayed,
    };
  }

  private async finalizeExecution(initial: ScienceToolExecution, replayed: boolean, inputBlob?: ScienceRunBlobReceipt, workerSha256 = initial.workerSha256, environmentSha256 = initial.environmentSha256): Promise<ScienceToolExecutionReceipt | null> {
    let execution = this.store.getToolExecution(initial.projectId, initial.requestId) ?? initial;
    if (execution.phase === "committed") {
      if (!inputBlob) return null;
      return this.committedReceipt(execution, inputBlob, workerSha256, environmentSha256, replayed);
    }
    if (execution.phase === "outputs-staged") {
      if (!execution.outputBlobRef || !execution.outputSha256 || !execution.outputByteSize || !execution.outputManifestSha256) throw new Error("science-tool-recovery-output-missing");
      const plan = this.store.getToolMaterializationPlan(execution.projectId, execution.id);
      if (!plan) throw new Error("science-tool-recovery-plan-missing");
      const outputResource = {
        role: plan.outputRole,
        mimeType: plan.outputMimeType,
        byteSize: execution.outputByteSize,
        sha256: execution.outputSha256,
        blobRef: execution.outputBlobRef,
        artifactId: null,
        artifactVersion: null,
      };
      const run = this.store.getResearchRunForProject(execution.projectId, execution.runId);
      if (!run) throw new Error("science-tool-recovery-run-missing");
      if (run.status === "running") {
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-complete:v1:${execution.requestId}`),
          projectId: execution.projectId,
          runId: execution.runId,
          status: "succeeded",
          outputManifestSha256: execution.outputManifestSha256,
          summary: `Isolated ${execution.toolId}@${execution.toolVersion} completed with one content-addressed artifact output.`,
          outputs: [outputResource],
        });
      } else if (run.status !== "succeeded") {
        throw new Error(`science-tool-recovery-run-terminal-${run.status}`);
      }
      execution = this.store.markToolExecutionRunCompleted(execution.projectId, execution.requestId);
    }
    if (execution.phase === "run-completed") {
      const plan = this.store.getToolMaterializationPlan(execution.projectId, execution.id);
      if (!plan) throw new Error("science-tool-recovery-plan-missing");
      if (plan.authorityMode === "signed-pack") {
        if (!plan.rendererBinding || !this.rendererAuthority) throw new Error("science-tool-renderer-authority-unavailable");
        if (plan.executorBinding) {
          const exact = this.rendererAuthority.resolveExactExecutorBinding(plan.rendererBinding, plan.executorBinding, plan.artifactKind);
          if (!exact || !scienceRendererBindingsEqual(exact.renderer.binding, plan.rendererBinding)
            || !scienceRendererExecutorBindingsEqual(exact.binding, plan.executorBinding)
            || exact.executor.entrySha256 !== execution.workerSha256) {
            throw new Error("science-tool-renderer-binding-unavailable");
          }
        } else {
          if (plan.artifactKind === "chemistry.document") throw new Error("science-tool-renderer-binding-unavailable");
          const exact = this.rendererAuthority.resolveExact(plan.rendererBinding, plan.artifactKind);
          if (!exact || !scienceRendererBindingsEqual(exact, plan.rendererBinding)) throw new Error("science-tool-renderer-binding-unavailable");
        }
      }
      const committed = this.store.commitRunArtifact({
        requestId: stableUuid(`science-tool-artifact-commit:v1:${execution.requestId}`),
        projectId: execution.projectId,
        runId: execution.runId,
        outputOrdinal: execution.outputOrdinal,
        codeSha256: execution.workerSha256,
        labId: execution.labId,
      });
      execution = this.store.markToolExecutionCommitted(execution.projectId, execution.requestId, committed.binding);
    }
    if (execution.phase !== "committed") throw new Error(`science-tool-recovery-state-${execution.phase}`);
    if (!inputBlob) return null;
    return this.committedReceipt(execution, inputBlob, workerSha256, environmentSha256, replayed);
  }

  private async executeTableToVegaOnce(input: ExecuteTableToVegaInput): Promise<ScienceToolExecutionReceipt> {
    const normalized = normalizeInput(input);
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > MAX_INPUT_BYTES) throw new Error("science-tool-input-too-large");
    const workerPath = path.join(__dirname, "workers", "table-to-vega.js");
    const workerStat = fs.lstatSync(workerPath);
    if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-tool-worker-invalid");
    const workerSha256 = sha256(fs.readFileSync(workerPath));
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      toolId: TOOL_ID,
      toolVersion: TOOL_VERSION,
      workerSha256,
      runtime: TOOL_RUNTIME,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      networkPolicy: "builtin-module-deny-v1",
    }));
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = {
      role: "table-input",
      mimeType: INPUT_MIME,
      byteSize: inputBlob.byteSize,
      sha256: inputBlob.sha256,
      blobRef: inputBlob.blobRef,
      artifactId: null,
      artifactVersion: null,
    };
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: "data-visualization",
      materializationPlan: {
        authorityMode: "core",
        artifactKind: "chart.vega",
        rendererId: "agentlas.vega",
        rendererVersion: "6.4.0",
        rendererBinding: null,
        executorBinding: null,
        outputOrdinal: 1,
        outputRole: "vega-artifact-output",
        outputMimeType: OUTPUT_MIME,
        labId: "data-visualization",
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`),
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        toolId: TOOL_ID,
        toolVersion: TOOL_VERSION,
        runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson([inputResource])),
        environmentSha256,
        inputs: [inputResource],
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (execution.phase === "committed" || execution.phase === "outputs-staged" || execution.phase === "run-completed") {
      const recovered = await this.finalizeExecution(execution, true, inputBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-tool-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    let childPid: number | null = null;
    try {
      const inputPath = path.join(jobRoot, "input.json");
      const inputFd = fs.openSync(inputPath, "wx", 0o400);
      try {
        fs.writeFileSync(inputFd, inputBytes);
        fs.fsyncSync(inputFd);
      } finally {
        fs.closeSync(inputFd);
      }
      const child = await runChild(workerPath, jobRoot, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.pid;
      const outputPath = path.join(jobRoot, "output.json");
      const outputBytes = readRegularFileNoFollow(outputPath, MAX_OUTPUT_BYTES);
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = {
        role: "vega-artifact-output",
        mimeType: OUTPUT_MIME,
        byteSize: outputBlob.byteSize,
        sha256: outputBlob.sha256,
        blobRef: outputBlob.blobRef,
        artifactId: null,
        artifactVersion: null,
      };
      const outputManifestSha256 = sha256(canonicalJson([outputResource]));
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, outputManifestSha256);
      const finalized = await this.finalizeExecution(execution, false, inputBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") {
        const outputs: [] = [];
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`),
          projectId: input.projectId,
          runId: current.id,
          status: cancelled ? "cancelled" : "failed",
          outputManifestSha256: sha256(canonicalJson(outputs)),
          summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
          outputs,
        });
      }
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    } finally {
      fs.rmSync(jobRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  private async executeStatisticsAnalysisOnce(input: ExecuteStatisticsAnalysisInput): Promise<ScienceToolExecutionReceipt> {
    const normalized = normalizeStatisticsInput(input, this.store);
    const executionBinding = normalized.executionBinding as ScienceStatisticsExecutionBinding;
    const researchRunAnalysisPlan = executionBinding.analysisPlan === null ? null : {
      analysisSpecId: executionBinding.analysisPlan.analysisSpecId,
      version: executionBinding.analysisPlan.version,
      contentSha256: executionBinding.analysisPlan.contentSha256,
    };
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > STATISTICS_MAX_INPUT_BYTES) throw new Error("science-statistics-input-invalid");
    const workerPath = path.join(__dirname, "workers", "statistics-analysis.js");
    const workerStat = fs.lstatSync(workerPath);
    if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-tool-worker-invalid");
    const workerSha256 = sha256(fs.readFileSync(workerPath));
    const analysisTimeoutMs = statisticsAnalysisTimeoutMs(normalized);
    const terminationTimeoutMs = Math.min(TIMEOUT_MS, analysisTimeoutMs + STATISTICS_TERMINATION_GRACE_MS);
    const runtimeReceipt = createStatisticsRuntimeReceipt(workerSha256, analysisTimeoutMs, terminationTimeoutMs);
    const environmentSha256 = runtimeReceipt.receiptSha256;
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = {
      role: "statistics-request-input",
      mimeType: STATISTICS_INPUT_MIME,
      byteSize: inputBlob.byteSize,
      sha256: inputBlob.sha256,
      blobRef: inputBlob.blobRef,
      artifactId: null,
      artifactVersion: null,
    };
    const runtimeReceiptBlob = this.store.putRunBlob(Buffer.from(canonicalJson(runtimeReceipt), "utf8"));
    const runtimeReceiptResource: ScienceResearchRunResourceInput = {
      role: "statistics-runtime-integrity",
      mimeType: STATISTICS_RUNTIME_RECEIPT_MIME,
      byteSize: runtimeReceiptBlob.byteSize,
      sha256: runtimeReceiptBlob.sha256,
      blobRef: runtimeReceiptBlob.blobRef,
      artifactId: null,
      artifactVersion: null,
    };
    const runInputs: ScienceResearchRunResourceInput[] = [inputResource, runtimeReceiptResource];
    const normalizedSourceTable = normalized.sourceTable as ScienceStatisticsSourceTableBinding | undefined;
    if (normalizedSourceTable) {
      const context = this.store.getArtifactContextForProject(
        input.projectId, normalizedSourceTable.artifactId, normalizedSourceTable.artifactVersion,
      );
      if (!context || context.selectedVersion.contentSha256 !== normalizedSourceTable.contentSha256
        || context.artifact.kind !== SCIENCE_TABLE_ARTIFACT_KIND || context.selectedVersion.rendererId !== SCIENCE_TABLE_RENDERER_ID
        || context.linkage.labId !== SCIENCE_TABLE_LAB_ID) throw new Error("science-statistics-source-artifact-not-found");
      let table: ReturnType<typeof validateScienceTablePayload>;
      try { table = validateScienceTablePayload(context.selectedVersion.payload); }
      catch { throw new Error("science-statistics-source-artifact-invalid"); }
      const sourceBlob = this.store.putRunBlob(Buffer.from(canonicalJson(table), "utf8"));
      runInputs.push({
        role: "statistics-source-table",
        mimeType: STATISTICS_SOURCE_TABLE_MIME,
        byteSize: sourceBlob.byteSize,
        sha256: sourceBlob.sha256,
        blobRef: sourceBlob.blobRef,
        artifactId: normalizedSourceTable.artifactId,
        artifactVersion: normalizedSourceTable.artifactVersion,
      });
    }
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: SCIENCE_STATISTICS_LAB_ID,
      materializationPlan: {
        authorityMode: "core",
        artifactKind: "table",
        rendererId: "agentlas.table",
        rendererVersion: "1.0.0",
        rendererBinding: null,
        executorBinding: null,
        outputOrdinal: 1,
        outputRole: "statistics-analysis-artifact-output",
        outputMimeType: STATISTICS_OUTPUT_MIME,
        labId: SCIENCE_STATISTICS_LAB_ID,
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`),
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        toolId: SCIENCE_STATISTICS_TOOL_ID,
        toolVersion: SCIENCE_STATISTICS_TOOL_VERSION,
        runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson(runInputs)),
        environmentSha256,
        analysisPlan: researchRunAnalysisPlan,
        inputs: runInputs,
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (execution.workerSha256 !== workerSha256 || execution.environmentSha256 !== environmentSha256
      || authoritativeRun.environmentSha256 !== environmentSha256
      || authoritativeRun.inputs[1]?.role !== "statistics-runtime-integrity"
      || authoritativeRun.inputs[1]?.sha256 !== runtimeReceiptBlob.sha256) {
      throw new Error("science-statistics-runtime-drift");
    }
    if (execution.phase === "committed" || execution.phase === "outputs-staged" || execution.phase === "run-completed") {
      const recovered = await this.finalizeExecution(execution, true, inputBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-statistics-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    let childPid: number | null = null;
    try {
      const inputPath = path.join(jobRoot, "input.json");
      const inputFd = fs.openSync(inputPath, "wx", 0o400);
      try { fs.writeFileSync(inputFd, inputBytes); fs.fsyncSync(inputFd); } finally { fs.closeSync(inputFd); }
      const child = await runChild(workerPath, jobRoot, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      }, {
        timeoutMs: terminationTimeoutMs,
        nodeArgs: [
          `--max-old-space-size=${STATISTICS_CHILD_RESOURCE_LIMITS.maxOldSpaceMb}`,
          `--max-semi-space-size=${STATISTICS_CHILD_RESOURCE_LIMITS.maxSemiSpaceMb}`,
          `--stack-size=${STATISTICS_CHILD_RESOURCE_LIMITS.stackSizeKb}`,
        ],
      });
      childPid = child.pid;
      const outputBytes = readRegularFileNoFollow(path.join(jobRoot, "output.json"), STATISTICS_MAX_OUTPUT_BYTES);
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = {
        role: "statistics-analysis-artifact-output",
        mimeType: STATISTICS_OUTPUT_MIME,
        byteSize: outputBlob.byteSize,
        sha256: outputBlob.sha256,
        blobRef: outputBlob.blobRef,
        artifactId: null,
        artifactVersion: null,
      };
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, sha256(canonicalJson([outputResource])));
      const finalized = await this.finalizeExecution(execution, false, inputBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") {
        const outputs: [] = [];
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
          status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson(outputs)),
          summary: cancelled ? "Statistics execution was cancelled by the owning Science turn." : `Statistics execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
          outputs,
        });
      }
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    } finally {
      fs.rmSync(jobRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  private async executePhysicsDatasetOnce(input: ExecutePhysicsDatasetInput): Promise<ScienceToolExecutionReceipt> {
    const normalized = normalizePhysicsDatasetInput(input);
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    const workerPath = path.join(__dirname, "workers", "physics-dataset.js");
    const workerStat = fs.lstatSync(workerPath);
    if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-tool-worker-invalid");
    const workerSha256 = sha256(fs.readFileSync(workerPath));
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      toolId: SCIENCE_PHYSICS_TOOL_ID,
      toolVersion: SCIENCE_PHYSICS_TOOL_VERSION,
      workerSha256,
      runtime: TOOL_RUNTIME,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      networkPolicy: "builtin-module-deny-v1",
      physicsRuntime: "agentlas-physics@1.0.0",
    }));
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = { role: "physics-dataset-input", mimeType: PHYSICS_INPUT_MIME, ...inputBlob, artifactId: null, artifactVersion: null };
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: SCIENCE_PHYSICS_LAB_ID,
      materializationPlan: {
        authorityMode: "core", artifactKind: "table", rendererId: "agentlas.table", rendererVersion: "1.0.0",
        rendererBinding: null, executorBinding: null, outputOrdinal: 1, outputRole: "physics-dataset-artifact-output",
        outputMimeType: PHYSICS_OUTPUT_MIME, labId: SCIENCE_PHYSICS_LAB_ID,
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`), projectId: input.projectId,
        conversationId: input.conversationId, originMessageId: input.originMessageId,
        toolId: SCIENCE_PHYSICS_TOOL_ID, toolVersion: SCIENCE_PHYSICS_TOOL_VERSION, runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson([inputResource])), environmentSha256, inputs: [inputResource],
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId); this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (["committed", "outputs-staged", "run-completed"].includes(execution.phase)) {
      const recovered = await this.finalizeExecution(execution, true, inputBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-physics-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    let childPid: number | null = null;
    try {
      const inputPath = path.join(jobRoot, "input.json");
      const inputFd = fs.openSync(inputPath, "wx", 0o400);
      try { fs.writeFileSync(inputFd, inputBytes); fs.fsyncSync(inputFd); } finally { fs.closeSync(inputFd); }
      const child = await runChild(workerPath, jobRoot, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.pid;
      const outputBytes = readRegularFileNoFollow(path.join(jobRoot, "output.json"), MAX_INPUT_BYTES);
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = { role: "physics-dataset-artifact-output", mimeType: PHYSICS_OUTPUT_MIME, ...outputBlob, artifactId: null, artifactVersion: null };
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, sha256(canonicalJson([outputResource])));
      const finalized = await this.finalizeExecution(execution, false, inputBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
        status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson([])),
        summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
        outputs: [],
      });
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    } finally { fs.rmSync(jobRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  }

  private async executeAcademicToCitationNetworkOnce(input: ExecuteAcademicToCitationNetworkInput): Promise<ScienceToolExecutionReceipt> {
    const normalized = normalizeCitationNetworkInput(input, this.store);
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > MAX_INPUT_BYTES) throw new Error("science-tool-input-too-large");
    const workerPath = path.join(__dirname, "workers", "academic-to-citation-network.js");
    const workerStat = fs.lstatSync(workerPath);
    if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-tool-worker-invalid");
    const workerSha256 = sha256(fs.readFileSync(workerPath));
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      toolId: CITATION_NETWORK_TOOL_ID,
      toolVersion: CITATION_NETWORK_TOOL_VERSION,
      workerSha256,
      runtime: TOOL_RUNTIME,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      networkPolicy: "builtin-module-deny-v1",
    }));
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = {
      role: "academic-search-input",
      mimeType: CITATION_NETWORK_INPUT_MIME,
      byteSize: inputBlob.byteSize,
      sha256: inputBlob.sha256,
      blobRef: inputBlob.blobRef,
      artifactId: null,
      artifactVersion: null,
    };
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: "literature-network",
      materializationPlan: {
        authorityMode: "core",
        artifactKind: "literature.citation-network",
        rendererId: "agentlas.cytoscape",
        rendererVersion: "3.34.1",
        rendererBinding: null,
        executorBinding: null,
        outputOrdinal: 1,
        outputRole: "citation-network-artifact-output",
        outputMimeType: CITATION_NETWORK_OUTPUT_MIME,
        labId: "literature-network",
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`),
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        parentRunId: input.searchRunId,
        toolId: CITATION_NETWORK_TOOL_ID,
        toolVersion: CITATION_NETWORK_TOOL_VERSION,
        runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson([inputResource])),
        environmentSha256,
        inputs: [inputResource],
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (["committed", "outputs-staged", "run-completed"].includes(execution.phase)) {
      const recovered = await this.finalizeExecution(execution, true, inputBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-tool-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    let childPid: number | null = null;
    try {
      const inputPath = path.join(jobRoot, "input.json");
      const inputFd = fs.openSync(inputPath, "wx", 0o400);
      try { fs.writeFileSync(inputFd, inputBytes); fs.fsyncSync(inputFd); } finally { fs.closeSync(inputFd); }
      const child = await runChild(workerPath, jobRoot, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.pid;
      const outputBytes = readRegularFileNoFollow(path.join(jobRoot, "output.json"), MAX_OUTPUT_BYTES);
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = {
        role: "citation-network-artifact-output",
        mimeType: CITATION_NETWORK_OUTPUT_MIME,
        byteSize: outputBlob.byteSize,
        sha256: outputBlob.sha256,
        blobRef: outputBlob.blobRef,
        artifactId: null,
        artifactVersion: null,
      };
      const outputManifestSha256 = sha256(canonicalJson([outputResource]));
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, outputManifestSha256);
      const finalized = await this.finalizeExecution(execution, false, inputBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") {
        const outputs: [] = [];
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
          status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson(outputs)),
          summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
          outputs,
        });
      }
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    } finally {
      fs.rmSync(jobRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  private async executeAstronomyToSkyMapOnce(input: ExecuteAstronomyToSkyMapInput): Promise<ScienceToolExecutionReceipt> {
    const normalized = normalizeAstronomySkyInput(input, this.store);
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > MAX_INPUT_BYTES) throw new Error("science-tool-input-too-large");
    const workerPath = path.join(__dirname, "workers", "astronomy-to-sky-map.js");
    const workerStat = fs.lstatSync(workerPath);
    if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-tool-worker-invalid");
    const workerSha256 = sha256(fs.readFileSync(workerPath));
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      toolId: ASTRONOMY_SKY_TOOL_ID,
      toolVersion: ASTRONOMY_SKY_TOOL_VERSION,
      workerSha256,
      runtime: TOOL_RUNTIME,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      networkPolicy: "builtin-module-deny-v1",
    }));
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = {
      role: "astronomy-catalog-input",
      mimeType: ASTRONOMY_SKY_INPUT_MIME,
      byteSize: inputBlob.byteSize,
      sha256: inputBlob.sha256,
      blobRef: inputBlob.blobRef,
      artifactId: null,
      artifactVersion: null,
    };
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: "astronomy-sky",
      materializationPlan: {
        authorityMode: "core",
        artifactKind: "astronomy.sky-catalog",
        rendererId: "agentlas.d3-sky",
        rendererVersion: "7.9.0",
        rendererBinding: null,
        executorBinding: null,
        outputOrdinal: 1,
        outputRole: "astronomy-sky-artifact-output",
        outputMimeType: ASTRONOMY_SKY_OUTPUT_MIME,
        labId: "astronomy-sky",
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`),
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        parentRunId: input.catalogRunId,
        toolId: ASTRONOMY_SKY_TOOL_ID,
        toolVersion: ASTRONOMY_SKY_TOOL_VERSION,
        runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson([inputResource])),
        environmentSha256,
        inputs: [inputResource],
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (["committed", "outputs-staged", "run-completed"].includes(execution.phase)) {
      const recovered = await this.finalizeExecution(execution, true, inputBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-tool-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    let childPid: number | null = null;
    try {
      const inputPath = path.join(jobRoot, "input.json");
      const inputFd = fs.openSync(inputPath, "wx", 0o400);
      try { fs.writeFileSync(inputFd, inputBytes); fs.fsyncSync(inputFd); } finally { fs.closeSync(inputFd); }
      const child = await runChild(workerPath, jobRoot, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.pid;
      const outputBytes = readRegularFileNoFollow(path.join(jobRoot, "output.json"), MAX_OUTPUT_BYTES);
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = {
        role: "astronomy-sky-artifact-output",
        mimeType: ASTRONOMY_SKY_OUTPUT_MIME,
        byteSize: outputBlob.byteSize,
        sha256: outputBlob.sha256,
        blobRef: outputBlob.blobRef,
        artifactId: null,
        artifactVersion: null,
      };
      const outputManifestSha256 = sha256(canonicalJson([outputResource]));
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, outputManifestSha256);
      const finalized = await this.finalizeExecution(execution, false, inputBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") {
        const outputs: [] = [];
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
          status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson(outputs)),
          summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
          outputs,
        });
      }
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    } finally {
      fs.rmSync(jobRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }


  private async executeAstronomyLightCurvePeriodicityOnce(
    input: ExecuteAstronomyLightCurvePeriodicityInput,
  ): Promise<ScienceToolExecutionReceipt> {
    const workerPath = path.join(__dirname, "workers", "astronomy-light-curve-periodicity.js");
    const pluginRuntimeFile = readSciencePluginFile(
      "agentlas-astronomy", "runtime/astronomy.cjs", 16 * 1024 * 1024,
    );
    const pluginRuntimePath = pluginRuntimeFile.path;
    const workerStat = fs.lstatSync(workerPath);
    const pluginRuntimeStat = fs.lstatSync(pluginRuntimePath);
    if (!workerStat.isFile() || workerStat.isSymbolicLink() || !pluginRuntimeStat.isFile() || pluginRuntimeStat.isSymbolicLink()) {
      throw new Error("science-tool-astronomy-light-curve-runtime-invalid");
    }
    const workerSha256 = sha256(fs.readFileSync(workerPath));
    const pluginRuntimeSha256 = pluginRuntimeFile.sha256;
    const normalized = normalizeAstronomyLightCurvePeriodicityInput(input, this.store, pluginRuntimeSha256);
    const sourceContext = this.store.getArtifactContextForProject(
      input.projectId,
      normalized.sourceTable.artifactId,
      normalized.sourceTable.artifactVersion,
    );
    const parentRunId = sourceContext?.artifact.sourceRunId ?? null;
    if (!sourceContext || sourceContext.selectedVersion.contentSha256 !== normalized.sourceTable.contentSha256 || !parentRunId) {
      throw new Error("science-tool-astronomy-light-curve-source-artifact-invalid");
    }
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > MAX_INPUT_BYTES) throw new Error("science-tool-input-too-large");
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      toolId: SCIENCE_ASTRONOMY_LIGHT_CURVE_TOOL_ID,
      toolVersion: SCIENCE_ASTRONOMY_LIGHT_CURVE_TOOL_VERSION,
      workerSha256,
      plugin: { id: "agentlas-astronomy", version: SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION, runtimeSha256: pluginRuntimeSha256 },
      runtime: TOOL_RUNTIME,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      networkPolicy: "builtin-module-deny-v1",
    }));
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = {
      role: SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_ROLE,
      mimeType: SCIENCE_ASTRONOMY_LIGHT_CURVE_INPUT_MIME,
      byteSize: inputBlob.byteSize,
      sha256: inputBlob.sha256,
      blobRef: inputBlob.blobRef,
      artifactId: normalized.sourceTable.artifactId,
      artifactVersion: normalized.sourceTable.artifactVersion,
    };
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: SCIENCE_ASTRONOMY_LIGHT_CURVE_LAB_ID,
      materializationPlan: {
        authorityMode: "core",
        artifactKind: "chart.vega",
        rendererId: SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_ID,
        rendererVersion: SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_VERSION,
        rendererBinding: null,
        executorBinding: null,
        outputOrdinal: 1,
        outputRole: SCIENCE_ASTRONOMY_LIGHT_CURVE_OUTPUT_ROLE,
        outputMimeType: SCIENCE_ASTRONOMY_LIGHT_CURVE_OUTPUT_MIME,
        labId: SCIENCE_ASTRONOMY_LIGHT_CURVE_LAB_ID,
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`),
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        parentRunId,
        toolId: SCIENCE_ASTRONOMY_LIGHT_CURVE_TOOL_ID,
        toolVersion: SCIENCE_ASTRONOMY_LIGHT_CURVE_TOOL_VERSION,
        runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson([inputResource])),
        environmentSha256,
        inputs: [inputResource],
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (["committed", "outputs-staged", "run-completed"].includes(execution.phase)) {
      const recovered = await this.finalizeExecution(execution, true, inputBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-tool-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    let childPid: number | null = null;
    try {
      const inputPath = path.join(jobRoot, "input.json");
      const inputFd = fs.openSync(inputPath, "wx", 0o400);
      try { fs.writeFileSync(inputFd, inputBytes); fs.fsyncSync(inputFd); } finally { fs.closeSync(inputFd); }
      const child = await runChild(workerPath, jobRoot, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.pid;
      const outputBytes = readRegularFileNoFollow(path.join(jobRoot, "output.json"), MAX_OUTPUT_BYTES);
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = {
        role: SCIENCE_ASTRONOMY_LIGHT_CURVE_OUTPUT_ROLE,
        mimeType: SCIENCE_ASTRONOMY_LIGHT_CURVE_OUTPUT_MIME,
        byteSize: outputBlob.byteSize,
        sha256: outputBlob.sha256,
        blobRef: outputBlob.blobRef,
        artifactId: null,
        artifactVersion: null,
      };
      const outputManifestSha256 = sha256(canonicalJson([outputResource]));
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, outputManifestSha256);
      const finalized = await this.finalizeExecution(execution, false, inputBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") {
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
          status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson([])),
          summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
          outputs: [],
        });
      }
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    } finally {
      fs.rmSync(jobRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  private async executeBiodiversityToMapOnce(input: ExecuteBiodiversityToMapInput): Promise<ScienceToolExecutionReceipt> {
    const normalized = normalizeBiodiversityMapInput(input, this.store);
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > MAX_INPUT_BYTES) throw new Error("science-tool-input-too-large");
    const workerPath = path.join(__dirname, "workers", "biodiversity-to-map.js");
    const workerStat = fs.lstatSync(workerPath);
    if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-tool-worker-invalid");
    const workerSha256 = sha256(fs.readFileSync(workerPath));
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      toolId: BIODIVERSITY_MAP_TOOL_ID,
      toolVersion: BIODIVERSITY_MAP_TOOL_VERSION,
      workerSha256,
      runtime: TOOL_RUNTIME,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      networkPolicy: "builtin-module-deny-v1",
    }));
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = {
      role: "biodiversity-catalog-input",
      mimeType: BIODIVERSITY_MAP_INPUT_MIME,
      byteSize: inputBlob.byteSize,
      sha256: inputBlob.sha256,
      blobRef: inputBlob.blobRef,
      artifactId: null,
      artifactVersion: null,
    };
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: "biodiversity-map",
      materializationPlan: {
        authorityMode: "core",
        artifactKind: "chart.vega",
        rendererId: "agentlas.vega",
        rendererVersion: "6.4.0",
        rendererBinding: null,
        executorBinding: null,
        outputOrdinal: 1,
        outputRole: "biodiversity-map-artifact-output",
        outputMimeType: BIODIVERSITY_MAP_OUTPUT_MIME,
        labId: "biodiversity-map",
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`),
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        parentRunId: input.catalogRunId,
        toolId: BIODIVERSITY_MAP_TOOL_ID,
        toolVersion: BIODIVERSITY_MAP_TOOL_VERSION,
        runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson([inputResource])),
        environmentSha256,
        inputs: [inputResource],
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (["committed", "outputs-staged", "run-completed"].includes(execution.phase)) {
      const recovered = await this.finalizeExecution(execution, true, inputBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-tool-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    let childPid: number | null = null;
    try {
      const inputPath = path.join(jobRoot, "input.json");
      const inputFd = fs.openSync(inputPath, "wx", 0o400);
      try { fs.writeFileSync(inputFd, inputBytes); fs.fsyncSync(inputFd); } finally { fs.closeSync(inputFd); }
      const child = await runChild(workerPath, jobRoot, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.pid;
      const outputBytes = readRegularFileNoFollow(path.join(jobRoot, "output.json"), MAX_OUTPUT_BYTES);
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = {
        role: "biodiversity-map-artifact-output",
        mimeType: BIODIVERSITY_MAP_OUTPUT_MIME,
        byteSize: outputBlob.byteSize,
        sha256: outputBlob.sha256,
        blobRef: outputBlob.blobRef,
        artifactId: null,
        artifactVersion: null,
      };
      const outputManifestSha256 = sha256(canonicalJson([outputResource]));
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, outputManifestSha256);
      const finalized = await this.finalizeExecution(execution, false, inputBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") {
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
          status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson([])),
          summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
          outputs: [],
        });
      }
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    } finally {
      fs.rmSync(jobRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  private async executeEarthquakeToMapOnce(input: ExecuteEarthquakeToMapInput): Promise<ScienceToolExecutionReceipt> {
    const normalized = normalizeEarthquakeMapInput(input, this.store);
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > MAX_INPUT_BYTES) throw new Error("science-tool-input-too-large");
    const workerPath = path.join(__dirname, "workers", "earthquake-to-map.js");
    const workerStat = fs.lstatSync(workerPath);
    if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-tool-worker-invalid");
    const workerSha256 = sha256(fs.readFileSync(workerPath));
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1", toolId: EARTHQUAKE_MAP_TOOL_ID, toolVersion: EARTHQUAKE_MAP_TOOL_VERSION,
      workerSha256, runtime: TOOL_RUNTIME, electron: process.versions.electron ?? null, node: process.versions.node,
      platform: process.platform, arch: process.arch, networkPolicy: "builtin-module-deny-v1",
    }));
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = { role: "earthquake-catalog-input", mimeType: EARTHQUAKE_MAP_INPUT_MIME, ...inputBlob, artifactId: null, artifactVersion: null };
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId, toolCallId: input.toolCallId ?? input.requestId, turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null, workerSha256, outputOrdinal: 1, labId: "earthquake-observations",
      materializationPlan: {
        authorityMode: "core", artifactKind: "chart.vega", rendererId: "agentlas.vega", rendererVersion: "6.4.0",
        rendererBinding: null, executorBinding: null, outputOrdinal: 1, outputRole: "earthquake-map-artifact-output",
        outputMimeType: EARTHQUAKE_MAP_OUTPUT_MIME, labId: "earthquake-observations",
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`), projectId: input.projectId, conversationId: input.conversationId,
        originMessageId: input.originMessageId, parentRunId: input.catalogRunId, toolId: EARTHQUAKE_MAP_TOOL_ID,
        toolVersion: EARTHQUAKE_MAP_TOOL_VERSION, runtime: TOOL_RUNTIME, inputManifestSha256: sha256(canonicalJson([inputResource])),
        environmentSha256, inputs: [inputResource],
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>(); requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (["committed", "outputs-staged", "run-completed"].includes(execution.phase)) {
      const recovered = await this.finalizeExecution(execution, true, inputBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-tool-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    let childPid: number | null = null;
    try {
      const inputPath = path.join(jobRoot, "input.json"); const inputFd = fs.openSync(inputPath, "wx", 0o400);
      try { fs.writeFileSync(inputFd, inputBytes); fs.fsyncSync(inputFd); } finally { fs.closeSync(inputFd); }
      const child = await runChild(workerPath, jobRoot, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid); this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.pid;
      const outputBytes = readRegularFileNoFollow(path.join(jobRoot, "output.json"), MAX_OUTPUT_BYTES);
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = { role: "earthquake-map-artifact-output", mimeType: EARTHQUAKE_MAP_OUTPUT_MIME, ...outputBlob, artifactId: null, artifactVersion: null };
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, sha256(canonicalJson([outputResource])));
      const finalized = await this.finalizeExecution(execution, false, inputBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
        status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson([])),
        summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`, outputs: [],
      });
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) this.store.markToolExecutionTerminal(
        input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed",
      );
      throw error;
    } finally { fs.rmSync(jobRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  }

  private async executeSmilesToKetcherOnce(input: ExecuteSmilesToKetcherInput): Promise<ScienceToolExecutionReceipt> {
    if (!this.rendererAuthority) throw new Error("science-tool-renderer-authority-unavailable");
    const normalized = normalizeKetcherInput(input);
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > MAX_INPUT_BYTES) throw new Error("science-tool-input-too-large");
    const authority = this.rendererAuthority.resolveExecutor("agentlas.ketcher", "chemistry.document", KETCHER_TOOL_ID);
    if (!authority || authority.renderer.binding.rendererId !== "agentlas.ketcher") throw new Error("science-tool-renderer-binding-unavailable");
    const rendererBinding = authority.renderer.binding;
    const exactAuthority = this.rendererAuthority.resolveExactExecutor(rendererBinding, "chemistry.document", KETCHER_TOOL_ID);
    if (!exactAuthority || !scienceRendererBindingsEqual(exactAuthority.renderer.binding, rendererBinding)
      || exactAuthority.executorDescriptorSha256 !== authority.executorDescriptorSha256) throw new Error("science-tool-renderer-binding-unavailable");
    const workerSha256 = authority.executor.entrySha256;
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      toolId: KETCHER_TOOL_ID,
      toolVersion: KETCHER_TOOL_VERSION,
      workerSha256,
      runtime: TOOL_RUNTIME,
      platform: process.platform,
      arch: process.arch,
      networkPolicy: authority.executor.network,
      sandboxPolicy: authority.executor.sandboxPolicy,
      rendererBinding,
      executor: {
        id: authority.executor.id,
        version: authority.executor.version,
        descriptorSha256: authority.executorDescriptorSha256,
        entrySha256: authority.executor.entrySha256,
        engines: authority.executor.engines,
        assets: authority.executor.assets,
      },
    }));
    const requestBlob = this.store.putRunBlob(inputBytes);
    const inputs = [{
      role: "chemistry-request-input", mimeType: KETCHER_INPUT_MIME,
      byteSize: requestBlob.byteSize, sha256: requestBlob.sha256, blobRef: requestBlob.blobRef,
      artifactId: null, artifactVersion: null,
    }];
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: "chemistry",
      materializationPlan: {
        authorityMode: "signed-pack",
        artifactKind: "chemistry.document",
        rendererId: "agentlas.ketcher",
        rendererVersion: rendererBinding.rendererVersion,
        rendererBinding,
        executorBinding: authority.binding,
        outputOrdinal: 1,
        outputRole: "ketcher-artifact-output",
        outputMimeType: KETCHER_OUTPUT_MIME,
        labId: "chemistry",
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`),
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        toolId: KETCHER_TOOL_ID,
        toolVersion: KETCHER_TOOL_VERSION,
        runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson(inputs)),
        environmentSha256,
        inputs,
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (execution.phase === "committed" || execution.phase === "outputs-staged" || execution.phase === "run-completed") {
      const recovered = await this.finalizeExecution(execution, true, requestBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    let childPid: number | null = null;
    try {
      const child = await runSignedScienceExecutor(authority, inputBytes, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.childPid;
      const outputBytes = child.output;
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = {
        role: "ketcher-artifact-output", mimeType: KETCHER_OUTPUT_MIME,
        byteSize: outputBlob.byteSize, sha256: outputBlob.sha256, blobRef: outputBlob.blobRef,
        artifactId: null, artifactVersion: null,
      };
      const outputManifestSha256 = sha256(canonicalJson([outputResource]));
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, outputManifestSha256);
      const finalized = await this.finalizeExecution(execution, false, requestBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") {
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
          status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson([])),
          summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
          outputs: [],
        });
      }
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    }
  }

  private async executeSourceToKetcherOnce(input: ExecuteSourceToKetcherInput): Promise<ScienceToolExecutionReceipt> {
    if (!this.rendererAuthority) throw new Error("science-tool-renderer-authority-unavailable");
    const verified = this.store.getVerifiedScientificDataChemistrySourceForTool(
      input.projectId,
      String(input.retrievalRunId ?? ""),
      String(input.sourceId ?? ""),
      String(input.sourceVersionId ?? ""),
    );
    const normalized = normalizeSourceKetcherInput(input, verified);
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > MAX_INPUT_BYTES) throw new Error("science-tool-input-too-large");
    const authority = this.rendererAuthority.resolveExecutor("agentlas.ketcher", "chemistry.document", SOURCE_TO_KETCHER_TOOL_ID);
    if (!authority || authority.renderer.binding.rendererId !== "agentlas.ketcher") throw new Error("science-tool-renderer-binding-unavailable");
    const rendererBinding = authority.renderer.binding;
    const exactAuthority = this.rendererAuthority.resolveExactExecutor(rendererBinding, "chemistry.document", SOURCE_TO_KETCHER_TOOL_ID);
    if (!exactAuthority || !scienceRendererBindingsEqual(exactAuthority.renderer.binding, rendererBinding)
      || exactAuthority.executorDescriptorSha256 !== authority.executorDescriptorSha256) throw new Error("science-tool-renderer-binding-unavailable");
    const workerSha256 = authority.executor.entrySha256;
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      toolId: SOURCE_TO_KETCHER_TOOL_ID,
      toolVersion: SOURCE_TO_KETCHER_TOOL_VERSION,
      workerSha256,
      runtime: TOOL_RUNTIME,
      platform: process.platform,
      arch: process.arch,
      networkPolicy: authority.executor.network,
      sandboxPolicy: authority.executor.sandboxPolicy,
      rendererBinding,
      executor: {
        id: authority.executor.id,
        version: authority.executor.version,
        descriptorSha256: authority.executorDescriptorSha256,
        entrySha256: authority.executor.entrySha256,
        engines: authority.executor.engines,
        assets: authority.executor.assets,
      },
    }));
    const requestBlob = this.store.putRunBlob(inputBytes);
    const sourceBlob = this.store.putRunBlob(verified.bytes);
    if (sourceBlob.sha256 !== verified.source.version.contentSha256) throw new Error("science-tool-source-closure-invalid");
    const inputs = [{
      role: "source-version-input", mimeType: SOURCE_TO_KETCHER_INPUT_MIME,
      byteSize: requestBlob.byteSize, sha256: requestBlob.sha256, blobRef: requestBlob.blobRef,
      artifactId: null, artifactVersion: null,
    }, {
      role: "chemistry-structure-source", mimeType: "application/octet-stream",
      byteSize: sourceBlob.byteSize, sha256: sourceBlob.sha256, blobRef: sourceBlob.blobRef,
      artifactId: null, artifactVersion: null,
    }];
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: "chemistry",
      materializationPlan: {
        authorityMode: "signed-pack",
        artifactKind: "chemistry.document",
        rendererId: "agentlas.ketcher",
        rendererVersion: rendererBinding.rendererVersion,
        rendererBinding,
        executorBinding: authority.binding,
        outputOrdinal: 1,
        outputRole: "ketcher-artifact-output",
        outputMimeType: KETCHER_OUTPUT_MIME,
        labId: "chemistry",
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`),
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        parentRunId: verified.retrievalRun.id,
        toolId: SOURCE_TO_KETCHER_TOOL_ID,
        toolVersion: SOURCE_TO_KETCHER_TOOL_VERSION,
        runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson(inputs)),
        environmentSha256,
        inputs,
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (execution.phase === "committed" || execution.phase === "outputs-staged" || execution.phase === "run-completed") {
      const recovered = await this.finalizeExecution(execution, true, requestBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    let childPid: number | null = null;
    try {
      const child = await runSignedScienceExecutor(authority, inputBytes, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.childPid;
      const outputBlob = this.store.putRunBlob(child.output);
      const outputResource = {
        role: "ketcher-artifact-output", mimeType: KETCHER_OUTPUT_MIME,
        byteSize: outputBlob.byteSize, sha256: outputBlob.sha256, blobRef: outputBlob.blobRef,
        artifactId: null, artifactVersion: null,
      };
      const outputManifestSha256 = sha256(canonicalJson([outputResource]));
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, outputManifestSha256);
      const finalized = await this.finalizeExecution(execution, false, requestBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") {
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
          status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson([])),
          summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
          outputs: [],
        });
      }
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    }
  }

  private async executeSourceToMolstarOnce(input: ExecuteSourceToMolstarInput): Promise<ScienceToolExecutionReceipt> {
    if (!this.rendererAuthority) throw new Error("science-tool-renderer-authority-unavailable");
    const verified = this.store.getVerifiedSourceVersionForTool(input.projectId, String(input.sourceId ?? ""), String(input.sourceVersionId ?? ""));
    const normalized = normalizeMolstarInput(input, verified.source);
    const inputBytes = Buffer.from(canonicalJson(normalized), "utf8");
    if (inputBytes.length > MAX_INPUT_BYTES) throw new Error("science-tool-input-too-large");
    const rendererBinding = this.rendererAuthority.resolve("agentlas.molstar", "protein.structure");
    if (!rendererBinding || rendererBinding.rendererId !== "agentlas.molstar") throw new Error("science-tool-renderer-binding-unavailable");
    const exactBinding = this.rendererAuthority.resolveExact(rendererBinding, "protein.structure");
    if (!exactBinding || !scienceRendererBindingsEqual(exactBinding, rendererBinding)) throw new Error("science-tool-renderer-binding-unavailable");
    const workerPath = path.join(__dirname, "workers", "source-to-molstar.js");
    const workerStat = fs.lstatSync(workerPath);
    if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-tool-worker-invalid");
    const workerSha256 = sha256(fs.readFileSync(workerPath));
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-tool-environment/v1",
      toolId: MOLSTAR_TOOL_ID,
      toolVersion: MOLSTAR_TOOL_VERSION,
      workerSha256,
      runtime: TOOL_RUNTIME,
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      networkPolicy: "builtin-module-deny-v1",
      rendererBinding,
    }));
    const requestBlob = this.store.putRunBlob(inputBytes);
    const sourceBlob = this.store.putRunBlob(verified.bytes);
    if (sourceBlob.sha256 !== verified.source.version.contentSha256) throw new Error("science-tool-source-closure-invalid");
    const inputs = [{
      role: "source-version-input", mimeType: MOLSTAR_INPUT_MIME,
      byteSize: requestBlob.byteSize, sha256: requestBlob.sha256, blobRef: requestBlob.blobRef,
      artifactId: null, artifactVersion: null,
    }, {
      role: "protein-structure-source", mimeType: "application/octet-stream",
      byteSize: sourceBlob.byteSize, sha256: sourceBlob.sha256, blobRef: sourceBlob.blobRef,
      artifactId: null, artifactVersion: null,
    }];
    const reserved = this.store.reserveToolExecution({
      requestId: input.requestId,
      toolCallId: input.toolCallId ?? input.requestId,
      turnId: input.turnId ?? null,
      invocationRunId: input.invocationRunId ?? null,
      workerSha256,
      outputOrdinal: 1,
      labId: "molecular-structure",
      materializationPlan: {
        authorityMode: "signed-pack",
        artifactKind: "protein.structure",
        rendererId: "agentlas.molstar",
        rendererVersion: rendererBinding.rendererVersion,
        rendererBinding,
        executorBinding: null,
        outputOrdinal: 1,
        outputRole: "molstar-artifact-output",
        outputMimeType: MOLSTAR_OUTPUT_MIME,
        labId: "molecular-structure",
      },
      run: {
        requestId: stableUuid(`science-tool-run-create:v1:${input.requestId}`),
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        toolId: MOLSTAR_TOOL_ID,
        toolVersion: MOLSTAR_TOOL_VERSION,
        runtime: TOOL_RUNTIME,
        inputManifestSha256: sha256(canonicalJson(inputs)),
        environmentSha256,
        inputs,
      },
    });
    let execution = this.store.getToolExecution(input.projectId, input.requestId) ?? reserved.execution;
    if (execution.invocationRunId) {
      const requests = this.invocationRequests.get(execution.invocationRunId) ?? new Set<string>();
      requests.add(input.requestId);
      this.invocationRequests.set(execution.invocationRunId, requests);
    }
    const authoritativeRun = this.store.getResearchRunForProject(input.projectId, execution.runId);
    if (!authoritativeRun) throw new Error("science-tool-run-missing-after-create");
    if (execution.phase === "committed" || execution.phase === "outputs-staged" || execution.phase === "run-completed") {
      const recovered = await this.finalizeExecution(execution, true, requestBlob, workerSha256, environmentSha256);
      if (!recovered) throw new Error("science-tool-recovery-receipt-missing");
      return recovered;
    }
    if (execution.phase !== "reserved") throw new Error(`science-tool-execution-terminal-${execution.phase}`);
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-molstar-tool-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    let childPid: number | null = null;
    try {
      const inputPath = path.join(jobRoot, "input.json");
      const inputFd = fs.openSync(inputPath, "wx", 0o400);
      try { fs.writeFileSync(inputFd, inputBytes); fs.fsyncSync(inputFd); } finally { fs.closeSync(inputFd); }
      const child = await runChild(workerPath, jobRoot, (pid) => {
        execution = this.store.markToolExecutionSpawned(input.projectId, input.requestId, pid);
        this.activeChildPids.set(input.requestId, pid);
      });
      childPid = child.pid;
      const outputBytes = readRegularFileNoFollow(path.join(jobRoot, "output.json"), MAX_OUTPUT_BYTES);
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = {
        role: "molstar-artifact-output", mimeType: MOLSTAR_OUTPUT_MIME,
        byteSize: outputBlob.byteSize, sha256: outputBlob.sha256, blobRef: outputBlob.blobRef,
        artifactId: null, artifactVersion: null,
      };
      const outputManifestSha256 = sha256(canonicalJson([outputResource]));
      execution = this.store.stageToolExecutionOutput(input.projectId, input.requestId, outputBlob, outputManifestSha256);
      const finalized = await this.finalizeExecution(execution, false, requestBlob, workerSha256, environmentSha256);
      if (!finalized) throw new Error("science-tool-final-receipt-missing");
      return { ...finalized, childPid, exitCode: child.exitCode, replayed: false };
    } catch (error) {
      const cancelled = this.cancelledRequests.has(input.requestId);
      const currentExecution = this.store.getToolExecution(input.projectId, input.requestId);
      const current = this.store.getResearchRunForProject(input.projectId, authoritativeRun.id);
      if (current?.status === "running") {
        this.store.completeResearchRun({
          requestId: stableUuid(`science-tool-run-failed:v1:${input.requestId}`), projectId: input.projectId, runId: current.id,
          status: cancelled ? "cancelled" : "failed", outputManifestSha256: sha256(canonicalJson([])),
          summary: cancelled ? "Tool execution was cancelled by the owning Science turn." : `Tool execution failed: ${error instanceof Error ? error.message.slice(0, 1_000) : "unknown"}`,
          outputs: [],
        });
      }
      if (currentExecution && !["committed", "failed", "cancelled", "interrupted"].includes(currentExecution.phase)) {
        this.store.markToolExecutionTerminal(input.projectId, input.requestId, cancelled ? "cancelled" : "failed", cancelled ? "science-tool-cancelled-by-turn" : error instanceof Error ? error.message.slice(0, 240) : "science-tool-failed");
      }
      throw error;
    } finally {
      fs.rmSync(jobRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
}
