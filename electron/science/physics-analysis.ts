import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceResearchRun } from "../../shared/science-contract";
import { ScienceStore } from "./store";
import { loadSciencePluginRuntime, readSciencePluginFile } from "./plugin-runtime";

// Host binding for the Agentlas Physics analysis catalogue. Every analysis is
// a pure, deterministic function inside plugins/agentlas-physics/runtime; the
// host owns lineage: it resolves the exact parent dataset run/artifact, writes
// the immutable ResearchRun (inputs: request descriptor + parent artifact
// payload; outputs: analysis result, publication table, Vega figure), creates
// one chart.vega artifact carrying the analysis, and binds run output 1 to it.

export const PHYSICS_ANALYSIS_PLUGIN_VERSION = "0.3.2";
export const PHYSICS_ANALYSIS_LAB_ID = "physics-data";
export const PHYSICS_ANALYSIS_ARTIFACT_SCHEMA = "agentlas.science.physics-analysis-artifact/v1";
export const PHYSICS_ANALYSIS_RESULT_SCHEMA = "agentlas.physics.analysis-result/v1";
export const PHYSICS_DATASET_PARENT_TOOL_ID = "agentlas.physics-dataset";
export const PHYSICS_DATASET_PARENT_TOOL_VERSION = "1.0.0";

export type PhysicsAnalysisKind =
  | "spectrum-fit"
  | "significance-limits"
  | "uncertainty-propagation"
  | "unit-analysis"
  | "ode-simulation"
  | "signal-analysis"
  | "york-fit"
  | "lab-experiment";

export interface PhysicsAnalysisToolDefinition {
  kind: PhysicsAnalysisKind;
  toolId: string;
  toolVersion: string;
  mcpName: string;
  runtimeModule: string;
  runtimeExport: string;
  requiresDataset: boolean;
  summaryLabel: string;
}

export const PHYSICS_ANALYSIS_TOOLS: Readonly<Record<PhysicsAnalysisKind, PhysicsAnalysisToolDefinition>> = Object.freeze({
  "spectrum-fit": { kind: "spectrum-fit", toolId: "agentlas.physics-spectrum-fit-analysis", toolVersion: "1.0.0", mcpName: "fit_physics_spectrum_peaks", runtimeModule: "spectrum-fit.cjs", runtimeExport: "analyzeSpectrumFit", requiresDataset: true, summaryLabel: "Spectrum peak fit" },
  "significance-limits": { kind: "significance-limits", toolId: "agentlas.physics-significance-limits-analysis", toolVersion: "1.0.0", mcpName: "compute_physics_significance_limits", runtimeModule: "significance-limits.cjs", runtimeExport: "analyzeSignificanceLimits", requiresDataset: false, summaryLabel: "Significance and limits" },
  "uncertainty-propagation": { kind: "uncertainty-propagation", toolId: "agentlas.physics-uncertainty-propagation-analysis", toolVersion: "1.0.0", mcpName: "propagate_physics_uncertainty", runtimeModule: "uncertainty-propagation.cjs", runtimeExport: "analyzeUncertaintyPropagation", requiresDataset: false, summaryLabel: "Uncertainty propagation" },
  "unit-analysis": { kind: "unit-analysis", toolId: "agentlas.physics-unit-analysis", toolVersion: "1.0.0", mcpName: "analyze_physics_units", runtimeModule: "units.cjs", runtimeExport: "analyzeUnits", requiresDataset: false, summaryLabel: "Dimensional analysis" },
  "ode-simulation": { kind: "ode-simulation", toolId: "agentlas.physics-ode-simulation-analysis", toolVersion: "1.0.0", mcpName: "simulate_physics_ode", runtimeModule: "ode-simulation.cjs", runtimeExport: "analyzeOdeSimulation", requiresDataset: false, summaryLabel: "ODE simulation" },
  "signal-analysis": { kind: "signal-analysis", toolId: "agentlas.physics-signal-analysis", toolVersion: "1.0.0", mcpName: "analyze_physics_signal", runtimeModule: "signal-analysis.cjs", runtimeExport: "analyzeSignal", requiresDataset: true, summaryLabel: "Signal spectrum analysis" },
  "york-fit": { kind: "york-fit", toolId: "agentlas.physics-york-fit-analysis", toolVersion: "1.0.0", mcpName: "fit_physics_york_line", runtimeModule: "york-fit.cjs", runtimeExport: "analyzeYorkFit", requiresDataset: true, summaryLabel: "York errors-in-variables fit" },
  "lab-experiment": { kind: "lab-experiment", toolId: "agentlas.physics-lab-experiment-analysis", toolVersion: "1.0.0", mcpName: "check_physics_lab_experiment", runtimeModule: "lab-checkers.cjs", runtimeExport: "analyzeLabExperiment", requiresDataset: true, summaryLabel: "Teaching-lab experiment check" },
});

export function physicsAnalysisKindForToolId(toolId: string): PhysicsAnalysisKind | null {
  for (const definition of Object.values(PHYSICS_ANALYSIS_TOOLS)) if (definition.toolId === toolId) return definition.kind;
  return null;
}

type ScienceTable = {
  schema: "agentlas.science-table/v1";
  title: string;
  columns: Array<{ id: string; name: string; type: "number" | "string"; unit: string | null }>;
  rows: Array<Array<number | string | null>>;
};

export type PhysicsAnalysisResult = Record<string, unknown> & {
  schema: typeof PHYSICS_ANALYSIS_RESULT_SCHEMA;
  analysisId: string;
  method: { id: string; version: string; references: string[] };
  input: Record<string, unknown>;
  summary: Record<string, unknown>;
  publicationTable: ScienceTable;
  tables: Record<string, ScienceTable>;
  figure: { schema: string; rendererId: string; specKind: string; spec: Record<string, unknown>; figureSha256: string };
  boundaries: string[];
  warnings: string[];
  analysisBytes: number;
  analysisSha256: string;
};

type PhysicsRuntimeError = Error & { code?: unknown; details?: unknown };

type ParentDataset = {
  run: ScienceResearchRun;
  artifact: ScienceArtifact;
  table: ScienceTable;
  payloadBytes: Buffer;
  normalizedSha256: string;
};

export interface PhysicsAnalysisInput {
  kind: PhysicsAnalysisKind;
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  datasetRunId?: string;
  parameters: Record<string, unknown>;
  title?: string;
}

export interface PhysicsAnalysisServiceResult {
  schema: "agentlas.science-physics-analysis-result/v1";
  kind: PhysicsAnalysisKind;
  toolId: string;
  runId: string;
  parentRunId: string | null;
  title: string;
  analysis: PhysicsAnalysisResult;
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

function exactTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback.length > 240 ? fallback.slice(0, 240) : fallback;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error("science-physics-analysis-title-invalid");
  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const RUNTIME_SHARED_FILES = ["analysis-common.cjs", "physics.cjs"];

function runtimeFileSha256(fileName: string): string {
  return readSciencePluginFile("agentlas-physics", `runtime/${fileName}`, 16 * 1024 * 1024).sha256;
}

function loadRuntime(definition: PhysicsAnalysisToolDefinition): { analyze: (input: Record<string, unknown>) => PhysicsAnalysisResult; codeSha256: string } {
  const loaded = loadSciencePluginRuntime<Record<string, unknown>>(
    "agentlas-physics",
    `runtime/${definition.runtimeModule}`,
    32 * 1024 * 1024,
  );
  const analyze = loaded.runtime[definition.runtimeExport];
  if (typeof analyze !== "function") throw new Error("science-physics-analysis-runtime-invalid");
  const codeSha256 = sha256(canonicalJson({
    plugin: `agentlas-physics@${PHYSICS_ANALYSIS_PLUGIN_VERSION}`,
    tool: `${definition.toolId}@${definition.toolVersion}`,
    files: [
      { fileName: definition.runtimeModule, sha256: loaded.sha256 },
      ...RUNTIME_SHARED_FILES.map((fileName) => ({ fileName, sha256: runtimeFileSha256(fileName) })),
    ],
  }));
  return { analyze: analyze as (input: Record<string, unknown>) => PhysicsAnalysisResult, codeSha256 };
}

function exactParentDataset(store: ScienceStore, projectId: string, datasetRunId: string): ParentDataset {
  const run = store.getResearchRunForProject(projectId, datasetRunId);
  if (!run || run.status !== "succeeded" || run.toolId !== PHYSICS_DATASET_PARENT_TOOL_ID || run.toolVersion !== PHYSICS_DATASET_PARENT_TOOL_VERSION) {
    throw new Error("science-physics-analysis-parent-run-invalid");
  }
  const artifact = store.getArtifactForSourceRun(projectId, run.id, PHYSICS_ANALYSIS_LAB_ID);
  if (!artifact || artifact.kind !== "table" || artifact.version.rendererId !== "agentlas.table") throw new Error("science-physics-analysis-parent-artifact-invalid");
  const payload = artifact.version.payload as Record<string, unknown>;
  const normalized = isPlainRecord(payload.normalized) ? payload.normalized : null;
  const table = normalized && isPlainRecord(normalized.table) ? normalized.table as ScienceTable : null;
  if (payload.schema !== "agentlas.science.physics-data-artifact/v1" || !normalized || normalized.schema !== "agentlas.physics.user-dataset/v1"
    || !table || table.schema !== "agentlas.science-table/v1" || !Array.isArray(table.columns) || !Array.isArray(table.rows)
    || typeof normalized.normalizedSha256 !== "string") {
    throw new Error("science-physics-analysis-parent-payload-invalid");
  }
  return { run, artifact, table, payloadBytes: Buffer.from(canonicalJson(payload), "utf8"), normalizedSha256: normalized.normalizedSha256 };
}

function verifiedAnalysis(value: unknown, definition: PhysicsAnalysisToolDefinition): PhysicsAnalysisResult {
  const analysis = value as PhysicsAnalysisResult;
  if (!isPlainRecord(analysis) || analysis.schema !== PHYSICS_ANALYSIS_RESULT_SCHEMA || analysis.analysisId !== definition.kind
    || !isPlainRecord(analysis.summary) || !isPlainRecord(analysis.publicationTable) || analysis.publicationTable.schema !== "agentlas.science-table/v1"
    || !isPlainRecord(analysis.figure) || !isPlainRecord(analysis.figure.spec) || analysis.figure.rendererId !== "agentlas.vega"
    || !Array.isArray(analysis.boundaries) || !Array.isArray(analysis.warnings) || typeof analysis.analysisSha256 !== "string") {
    throw new Error("science-physics-analysis-result-invalid");
  }
  return analysis;
}

function numericObservations(summary: Record<string, unknown>): Array<{ label: string; value: number; unit: string | null }> {
  const observations: Array<{ label: string; value: number; unit: string | null }> = [];
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === "number" && Number.isFinite(value)) observations.push({ label: key, value, unit: null });
    if (observations.length >= 8) break;
  }
  return observations;
}

export class SciencePhysicsAnalysisService {
  constructor(private readonly store: ScienceStore) {}

  analyze(input: PhysicsAnalysisInput): PhysicsAnalysisServiceResult {
    const definition = PHYSICS_ANALYSIS_TOOLS[input.kind];
    if (!definition) throw new Error("science-physics-analysis-kind-invalid");
    if (!isPlainRecord(input.parameters)) throw new Error("science-physics-analysis-parameters-invalid");
    if ("table" in input.parameters) throw new Error("science-physics-analysis-table-must-come-from-dataset-run");
    const runtime = loadRuntime(definition);
    let parent: ParentDataset | null = null;
    if (definition.requiresDataset) {
      if (typeof input.datasetRunId !== "string" || !input.datasetRunId) throw new Error("science-physics-analysis-dataset-run-required");
      parent = exactParentDataset(this.store, input.projectId, input.datasetRunId);
    } else if (input.datasetRunId !== undefined) {
      throw new Error("science-physics-analysis-dataset-run-not-applicable");
    }
    const title = exactTitle(input.title, `${definition.summaryLabel}${parent ? ` · ${parent.table.title}` : ""}`);
    let analysis: PhysicsAnalysisResult;
    try {
      analysis = verifiedAnalysis(runtime.analyze(parent ? { ...input.parameters, table: parent.table } : { ...input.parameters }), definition);
    } catch (error) {
      const failure = error as PhysicsRuntimeError;
      if (failure && typeof failure.code === "string" && failure.code.startsWith("physics-")) {
        throw new Error(`science-physics-analysis-rejected:${failure.code}:${String(failure.message ?? "").slice(0, 160)}`);
      }
      throw error;
    }
    const descriptor = {
      schema: "agentlas.science-physics-analysis-input/v1",
      kind: definition.kind,
      toolId: definition.toolId,
      toolVersion: definition.toolVersion,
      datasetRunId: parent?.run.id ?? null,
      datasetArtifactId: parent?.artifact.id ?? null,
      datasetArtifactVersion: parent?.artifact.currentVersion ?? null,
      datasetContentSha256: parent?.artifact.version.contentSha256 ?? null,
      datasetNormalizedSha256: parent?.normalizedSha256 ?? null,
      parameters: input.parameters,
      title,
    };
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const inputs = [
      { role: "physics-analysis-input", mimeType: "application/vnd.agentlas.science.physics-analysis-input+json", ...descriptorBlob, artifactId: null, artifactVersion: null },
      ...(parent ? [(() => {
        const payloadBlob = this.store.putRunBlob(parent.payloadBytes);
        return { role: "physics-dataset-artifact-payload", mimeType: "application/vnd.agentlas.science.physics-data-artifact+json", ...payloadBlob, artifactId: parent.artifact.id, artifactVersion: parent.artifact.currentVersion };
      })()] : []),
    ];
    const environmentSha256 = sha256(canonicalJson({
      policy: "physics-analysis-pure-runtime-v1",
      plugin: `agentlas-physics@${PHYSICS_ANALYSIS_PLUGIN_VERSION}`,
      method: `${analysis.method.id}@${analysis.method.version}`,
      codeSha256: runtime.codeSha256,
      runtime: process.version,
    }));
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      parentRunId: parent?.run.id ?? null, toolId: definition.toolId, toolVersion: definition.toolVersion,
      runtime: "electron-main", inputManifestSha256: sha256(canonicalJson(inputs)), environmentSha256, inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "physics-analysis-result");
      if (!output) throw new Error("science-physics-analysis-replay-output-missing");
      const replayed = verifiedAnalysis(JSON.parse(this.store.readRunBlob(output).toString("utf8")), definition);
      if (replayed.analysisSha256 !== analysis.analysisSha256) throw new Error("science-physics-analysis-replay-output-invalid");
      const artifact = this.store.getArtifactForSourceRun(input.projectId, run.id, PHYSICS_ANALYSIS_LAB_ID);
      if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega" || artifact.version.payload.schema !== PHYSICS_ANALYSIS_ARTIFACT_SCHEMA) {
        throw new Error("science-physics-analysis-replay-artifact-invalid");
      }
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-physics-analysis-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId, runId: run.id, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: "agentlas.science-physics-analysis-result/v1", kind: definition.kind, toolId: definition.toolId, runId: run.id, parentRunId: parent?.run.id ?? null, title, analysis: replayed, artifact, replayed: true };
    }
    if (run.status !== "running") throw new Error(`science-physics-analysis-run-${run.status}`);
    try {
      const analysisBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis), "utf8"));
      const tableBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis.publicationTable), "utf8"));
      const figureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis.figure.spec), "utf8"));
      const outputs = [
        { role: "physics-analysis-result", mimeType: "application/vnd.agentlas.physics.analysis-result+json", ...analysisBlob, artifactId: null, artifactVersion: null },
        { role: "physics-analysis-table", mimeType: "application/vnd.agentlas.science.table+json", ...tableBlob, artifactId: null, artifactVersion: null },
        { role: "physics-analysis-figure", mimeType: "application/vnd.vega.v5+json", ...figureBlob, artifactId: null, artifactVersion: null },
      ];
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)),
        summary: `${definition.summaryLabel}: ${analysis.method.id} produced ${analysis.publicationTable.rows.length} publication rows${analysis.warnings.length ? ` with ${analysis.warnings.length} warning(s)` : ""}.`,
        outputs,
      }).run;
      const parentRef = parent ? { artifactId: parent.artifact.id, version: parent.artifact.currentVersion } : null;
      const payload = {
        schema: PHYSICS_ANALYSIS_ARTIFACT_SCHEMA,
        kind: definition.kind,
        toolId: definition.toolId,
        toolVersion: definition.toolVersion,
        analysis,
        spec: analysis.figure.spec,
        source: parent ? { datasetRunId: parent.run.id, datasetArtifactId: parent.artifact.id, datasetArtifactVersion: parent.artifact.currentVersion, datasetContentSha256: parent.artifact.version.contentSha256, datasetNormalizedSha256: parent.normalizedSha256 } : null,
      };
      const artifact = this.store.createArtifact({
        projectId: input.projectId, sourceRunId: run.id, kind: "chart.vega", title,
        rendererId: "agentlas.vega", rendererVersion: "6.4.0", rendererBinding: null, payload,
        semantic: {
          title,
          summary: `${definition.summaryLabel} (${analysis.method.id} ${analysis.method.version}); boundaries: ${analysis.boundaries.slice(0, 2).join(" ")}`.slice(0, 2_000),
          entities: parent ? [{ id: parent.artifact.id, label: parent.table.title, type: "physics-dataset" }] : [],
          observations: numericObservations(analysis.summary),
          warnings: [...analysis.warnings],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: [],
          datasetSha256: [...(parent ? [parent.artifact.version.contentSha256, parent.normalizedSha256] : []), analysis.analysisSha256, analysis.figure.figureSha256],
          codeSha256: runtime.codeSha256,
          environmentSha256,
        },
        linkage: {
          labId: PHYSICS_ANALYSIS_LAB_ID,
          origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
          parent: parentRef,
          inputs: parentRef ? [parentRef] : [],
        },
      });
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-physics-analysis-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId, runId: run.id, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: "agentlas.science-physics-analysis-result/v1", kind: definition.kind, toolId: definition.toolId, runId: run.id, parentRunId: parent?.run.id ?? null, title, analysis, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed",
        outputManifestSha256: sha256(canonicalJson([])), summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-physics-analysis-failed", outputs: [],
      });
      throw error;
    }
  }
}
