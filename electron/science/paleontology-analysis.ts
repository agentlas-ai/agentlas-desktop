import { createHash } from "node:crypto";
import type { ScienceArtifact } from "../../shared/science-contract";
import { ScienceStore } from "./store";
import {
  PALEONTOLOGY_CATALOG_TOOL_ID,
  PALEONTOLOGY_CATALOG_TOOL_VERSION,
  type PaleontologyCatalogResult,
} from "./paleontology-catalog";
import { loadSciencePluginRuntime } from "./plugin-runtime";

export const PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_ID = "agentlas.paleontology-stratigraphic-support";
export const PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_VERSION = "1.0.0";
export const PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_RESULT_SCHEMA = "agentlas.science-paleontology-stratigraphic-analysis-result/v1" as const;
export const PALEONTOLOGY_STRATIGRAPHIC_ARTIFACT_SCHEMA = "agentlas.science.paleontology-stratigraphic-analysis-artifact/v1" as const;
export const PALEONTOLOGY_EVIDENCE_LAB_ID = "paleontology-evidence" as const;

type JsonRecord = Record<string, unknown>;
type ResearchRun = NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>;
type RunResource = ResearchRun["outputs"][number];

export interface PaleontologyStratigraphicAnalysisInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  catalogRunId: string;
  title?: string;
}

export interface PaleontologyStratigraphicAnalysisRecord extends JsonRecord {
  schema: "agentlas.paleontology-stratigraphic-analysis/v1";
  methodRevision: "interval-preserving-stratigraphic-support/v1";
  analysisSha256: string;
  source: {
    parentRunId: string;
    provider: "pbdb-data1.2";
    taxonName: string;
    acceptedTaxonId: string;
    parentTruncated: boolean;
  };
  estimates: {
    occurrenceCount: number;
    georeferencedCount: number;
    formationCount: number;
    intervalNameCount: number;
    oldestBoundMa: number;
    youngestBoundMa: number;
    medianIntervalWidthMa: number;
    figureOccurrenceCount: number;
    figureOmittedCount: number;
  };
  formationSummary: Array<JsonRecord>;
  publicationTable: JsonRecord & { columns: unknown[]; rows: unknown[]; notes: string[] };
  spec: JsonRecord;
  contentReceipts: {
    publicationTable: { sha256: string; mimeType: "application/vnd.agentlas.science-table+json" };
    figure: { sha256: string; mimeType: "application/vnd.vega.v5+json" };
  };
  evidenceBoundary: {
    evidenceClass: "stratigraphic-occurrence-support";
    molecularEvidence: "none";
    pointEstimateUsed: false;
  };
  assumptions: string[];
  warnings: string[];
}

export interface PaleontologyStratigraphicAnalysisResult {
  schema: typeof PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_RESULT_SCHEMA;
  toolId: typeof PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_ID;
  runId: string;
  parentRunId: string;
  title: string;
  analysis: PaleontologyStratigraphicAnalysisRecord;
  artifact: ScienceArtifact;
  replayed: boolean;
}

type PaleontologyRuntime = {
  PLUGIN_VERSION: string;
  analyzeStratigraphicEvidence(input: { catalog: PaleontologyCatalogResult }): PaleontologyStratigraphicAnalysisRecord;
};

interface ExactParent {
  run: ResearchRun;
  catalog: PaleontologyCatalogResult;
  catalogOutput: RunResource;
  rawOutputs: RunResource[];
  inputResources: Array<{
    role: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    blobRef: string;
    artifactId: null;
    artifactVersion: null;
  }>;
  sourceRefs: string[];
  datasetSha256: string[];
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

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function exactTitle(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") fail("science-paleontology-analysis-title-invalid");
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/u.test(normalized)) fail("science-paleontology-analysis-title-invalid");
  return normalized;
}

function numberish(value: unknown, code: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) fail(code);
  return parsed;
}

function rawRecords(bytes: Buffer, code: string): JsonRecord[] {
  let parsed: JsonRecord;
  try { parsed = record(JSON.parse(bytes.toString("utf8")), code); } catch { return fail(code); }
  if (!Array.isArray(parsed.records)) fail(code);
  return parsed.records.map((entry) => record(entry, code));
}

function runtime(): PaleontologyRuntime {
  const loaded = loadSciencePluginRuntime<Partial<PaleontologyRuntime>>(
    "agentlas-paleontology",
    "runtime/paleontology.cjs",
    4 * 1024 * 1024,
  ).runtime;
  if (loaded.PLUGIN_VERSION !== "0.2.0" || typeof loaded.analyzeStratigraphicEvidence !== "function") {
    fail("science-paleontology-analysis-runtime-invalid");
  }
  return loaded as PaleontologyRuntime;
}

function verifyAnalysis(value: PaleontologyStratigraphicAnalysisRecord, parentRunId: string): PaleontologyStratigraphicAnalysisRecord {
  if (value.schema !== "agentlas.paleontology-stratigraphic-analysis/v1"
    || value.methodRevision !== "interval-preserving-stratigraphic-support/v1"
    || value.source?.parentRunId !== parentRunId
    || value.source.provider !== "pbdb-data1.2"
    || value.evidenceBoundary?.evidenceClass !== "stratigraphic-occurrence-support"
    || value.evidenceBoundary.molecularEvidence !== "none"
    || value.evidenceBoundary.pointEstimateUsed !== false) {
    fail("science-paleontology-analysis-result-invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.analysisSha256)
    || value.contentReceipts.publicationTable.sha256 !== sha256(canonicalJson(value.publicationTable))
    || value.contentReceipts.figure.sha256 !== sha256(canonicalJson(value.spec))) {
    fail("science-paleontology-analysis-content-receipt-invalid");
  }
  const { analysisSha256, ...core } = value;
  if (analysisSha256 !== sha256(canonicalJson(core))) fail("science-paleontology-analysis-sha256-invalid");
  return value;
}

function exactParent(store: ScienceStore, projectId: string, catalogRunId: string): ExactParent {
  const run = store.getResearchRunForProject(projectId, catalogRunId);
  if (!run || run.status !== "succeeded" || run.toolId !== PALEONTOLOGY_CATALOG_TOOL_ID
    || run.toolVersion !== PALEONTOLOGY_CATALOG_TOOL_VERSION || run.parentRunId !== null) {
    fail("science-paleontology-analysis-parent-run-invalid");
  }
  const catalogOutputs = run.outputs.filter((resource) => resource.role === "paleontology-catalog"
    && resource.mimeType === "application/vnd.agentlas.paleontology-catalog-results+json");
  const rawOutputs = run.outputs.filter((resource) => resource.role === "provider-taxon-response" || resource.role === "provider-occurrence-page");
  if (catalogOutputs.length !== 1 || rawOutputs.length < 2 || run.outputs.length !== rawOutputs.length + 1
    || rawOutputs[0]?.role !== "provider-taxon-response" || rawOutputs.slice(1).some((resource) => resource.role !== "provider-occurrence-page")) {
    fail("science-paleontology-analysis-parent-output-invalid");
  }
  const catalogOutput = catalogOutputs[0]!;
  const catalogBytes = store.readRunBlob(catalogOutput);
  let catalog: PaleontologyCatalogResult;
  try { catalog = JSON.parse(catalogBytes.toString("utf8")) as PaleontologyCatalogResult; } catch { return fail("science-paleontology-analysis-parent-result-invalid"); }
  if (catalog.schema !== "agentlas.paleontology-catalog-result/v1" || catalog.provider !== "pbdb-data1.2"
    || catalog.runId !== run.id || catalog.replayed !== false || !Array.isArray(catalog.sources)
    || catalog.sources.length !== rawOutputs.length || catalog.sources[0]?.role !== "taxon-response"
    || catalog.sources.slice(1).some((source, index) => source.role !== "occurrence-page" || source.pageIndex !== index)) {
    fail("science-paleontology-analysis-parent-result-invalid");
  }
  if (catalog.receipt.taxonResponseSha256 !== rawOutputs[0]!.sha256
    || catalog.receipt.occurrencePages.length !== rawOutputs.length - 1) {
    fail("science-paleontology-analysis-parent-receipt-invalid");
  }

  const rawBytes = rawOutputs.map((resource) => store.readRunBlob(resource));
  const sourceRefs: string[] = [];
  for (let index = 0; index < catalog.sources.length; index += 1) {
    const binding = catalog.sources[index]!;
    const resource = rawOutputs[index]!;
    if (resource.sha256 !== binding.responseSha256 || sha256(rawBytes[index]!) !== binding.responseSha256) {
      fail("science-paleontology-analysis-parent-raw-closure-invalid");
    }
    const verified = store.getVerifiedJsonDatabaseSourceVersionForTool(projectId, binding.sourceId, binding.sourceVersionId);
    if (verified.source.version.contentSha256 !== binding.responseSha256 || sha256(verified.bytes) !== binding.responseSha256
      || !verified.bytes.equals(rawBytes[index]!)) {
      fail("science-paleontology-analysis-parent-source-closure-invalid");
    }
    const url = new URL(verified.source.canonicalUri);
    if (url.origin !== "https://paleobiodb.org" || !url.pathname.startsWith("/data1.2/")) {
      fail("science-paleontology-analysis-parent-source-invalid");
    }
    sourceRefs.push(verified.source.canonicalUri);
    if (index > 0) {
      const receipt = catalog.receipt.occurrencePages[index - 1];
      const pageRecords = rawRecords(rawBytes[index]!, "science-paleontology-analysis-parent-raw-invalid");
      if (!receipt || receipt.responseSha256 !== resource.sha256 || receipt.rowCount !== pageRecords.length) {
        fail("science-paleontology-analysis-parent-receipt-invalid");
      }
    }
  }

  const taxonRows = rawRecords(rawBytes[0]!, "science-paleontology-analysis-parent-raw-invalid");
  if (taxonRows.length !== 1 || sha256(canonicalJson(taxonRows[0])) !== catalog.taxon.providerRecordSha256
    || String(taxonRows[0]!.accepted_no ?? taxonRows[0]!.taxon_no ?? "") !== catalog.taxon.acceptedTaxonId
    || String(taxonRows[0]!.accepted_name ?? taxonRows[0]!.taxon_name ?? "") !== catalog.taxon.acceptedName) {
    fail("science-paleontology-analysis-parent-taxon-closure-invalid");
  }
  const providerOccurrences = rawBytes.slice(1).flatMap((bytes) => rawRecords(bytes, "science-paleontology-analysis-parent-raw-invalid"));
  if (catalog.occurrences.length < 1 || catalog.occurrences.length > providerOccurrences.length
    || catalog.pagination.recordsReturned !== catalog.occurrences.length) {
    fail("science-paleontology-analysis-parent-occurrence-closure-invalid");
  }
  catalog.occurrences.forEach((occurrence, index) => {
    const raw = providerOccurrences[index]!;
    if (sha256(canonicalJson(raw)) !== occurrence.providerRecordSha256
      || String(raw.occurrence_no ?? "") !== occurrence.occurrenceId
      || String(raw.collection_no ?? "") !== occurrence.collectionId
      || String(raw.accepted_no ?? "") !== occurrence.acceptedTaxonId
      || String(raw.accepted_name ?? "") !== occurrence.acceptedName
      || numberish(raw.max_ma, "science-paleontology-analysis-parent-occurrence-closure-invalid") !== occurrence.age.maxMa
      || numberish(raw.min_ma, "science-paleontology-analysis-parent-occurrence-closure-invalid") !== occurrence.age.minMa
      || occurrence.age.isPointEstimate !== false) {
      fail("science-paleontology-analysis-parent-occurrence-closure-invalid");
    }
  });

  const inputResources = [
    { role: "paleontology-parent-catalog", mimeType: catalogOutput.mimeType, ...store.putRunBlob(catalogBytes), artifactId: null, artifactVersion: null },
    ...rawOutputs.map((resource, index) => ({
      role: index === 0 ? "paleontology-parent-taxon-response" : "paleontology-parent-occurrence-page",
      mimeType: resource.mimeType,
      ...store.putRunBlob(rawBytes[index]!),
      artifactId: null,
      artifactVersion: null,
    })),
  ];
  return {
    run,
    catalog,
    catalogOutput,
    rawOutputs,
    inputResources,
    sourceRefs,
    datasetSha256: [catalogOutput.sha256, ...rawOutputs.map((resource) => resource.sha256)],
  };
}

export class SciencePaleontologyAnalysisService {
  constructor(private readonly store: ScienceStore) {}

  private artifactForRun(
    projectId: string,
    runId: string,
    parentRunId: string,
    expectedPayload: JsonRecord,
  ): ScienceArtifact {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, PALEONTOLOGY_EVIDENCE_LAB_ID);
    if (!artifact) fail("science-paleontology-analysis-replay-artifact-missing");
    const context = this.store.getArtifactContextForProject(projectId, artifact.id, artifact.currentVersion);
    if (!context || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega"
      || artifact.version.payload.schema !== PALEONTOLOGY_STRATIGRAPHIC_ARTIFACT_SCHEMA
      || artifact.sourceRunId !== runId || context.linkage.labId !== PALEONTOLOGY_EVIDENCE_LAB_ID
      || (artifact.version.payload.source as JsonRecord | undefined)?.parentRunId !== parentRunId
      || sha256(canonicalJson(artifact.version.payload)) !== sha256(canonicalJson(expectedPayload))) {
      fail("science-paleontology-analysis-replay-artifact-invalid");
    }
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-paleontology-analysis-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId,
      runId,
      outputOrdinal: 1,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  analyzeStratigraphicEvidence(input: PaleontologyStratigraphicAnalysisInput): PaleontologyStratigraphicAnalysisResult {
    const parent = exactParent(this.store, input.projectId, input.catalogRunId);
    const engine = runtime();
    const analysis = verifyAnalysis(engine.analyzeStratigraphicEvidence({ catalog: parent.catalog }), parent.run.id);
    const title = exactTitle(input.title, `Stratigraphic support · ${analysis.source.taxonName}`);
    const descriptor = {
      schema: "agentlas.science-paleontology-stratigraphic-analysis-input/v1",
      catalogRunId: parent.run.id,
      catalogOutputSha256: parent.catalogOutput.sha256,
      rawResponseSha256: parent.rawOutputs.map((resource) => resource.sha256),
      title,
    };
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const inputs = [
      { role: "paleontology-stratigraphic-analysis-input", mimeType: "application/vnd.agentlas.science.paleontology-stratigraphic-analysis-input+json", ...descriptorBlob, artifactId: null, artifactVersion: null },
      ...parent.inputResources,
    ];
    const environmentSha256 = sha256(canonicalJson({
      policy: "paleontology-exact-parent-interval-analysis-v1",
      plugin: `agentlas-paleontology@${engine.PLUGIN_VERSION}`,
      methodRevision: analysis.methodRevision,
      runtime: process.version,
    }));
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      parentRunId: parent.run.id,
      toolId: PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_ID,
      toolVersion: PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs)),
      environmentSha256,
      inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const outputs = run.outputs;
      if (outputs.length !== 3) fail("science-paleontology-analysis-replay-output-invalid");
      const analysisOutput = outputs.find((resource) => resource.role === "paleontology-stratigraphic-analysis"
        && resource.mimeType === "application/vnd.agentlas.science.paleontology-stratigraphic-analysis+json");
      const tableOutput = outputs.find((resource) => resource.role === "paleontology-stratigraphic-publication-table"
        && resource.mimeType === "application/vnd.agentlas.science-table+json");
      const figureOutput = outputs.find((resource) => resource.role === "paleontology-stratigraphic-figure"
        && resource.mimeType === "application/vnd.vega.v5+json");
      if (!analysisOutput || !tableOutput || !figureOutput) fail("science-paleontology-analysis-replay-output-invalid");
      const replayed = verifyAnalysis(JSON.parse(this.store.readRunBlob(analysisOutput).toString("utf8")) as PaleontologyStratigraphicAnalysisRecord, parent.run.id);
      const replayedTable = JSON.parse(this.store.readRunBlob(tableOutput).toString("utf8"));
      const replayedFigure = JSON.parse(this.store.readRunBlob(figureOutput).toString("utf8"));
      if (sha256(canonicalJson(replayed)) !== sha256(canonicalJson(analysis))
        || sha256(canonicalJson(replayedTable)) !== replayed.contentReceipts.publicationTable.sha256
        || sha256(canonicalJson(replayedFigure)) !== replayed.contentReceipts.figure.sha256) {
        fail("science-paleontology-analysis-replay-output-invalid");
      }
      const payload = this.artifactPayload(replayed, parent, run.id, tableOutput.sha256, figureOutput.sha256);
      const artifact = this.artifactForRun(input.projectId, run.id, parent.run.id, payload);
      return { schema: PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_RESULT_SCHEMA, toolId: PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_ID, runId: run.id, parentRunId: parent.run.id, title, analysis: replayed, artifact, replayed: true };
    }
    if (run.status !== "running") fail(`science-paleontology-analysis-run-${run.status}`);

    try {
      const analysisBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis), "utf8"));
      const tableBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis.publicationTable), "utf8"));
      const figureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(analysis.spec), "utf8"));
      if (tableBlob.sha256 !== analysis.contentReceipts.publicationTable.sha256
        || figureBlob.sha256 !== analysis.contentReceipts.figure.sha256) {
        fail("science-paleontology-analysis-output-receipt-invalid");
      }
      const outputs = [
        { role: "paleontology-stratigraphic-analysis", mimeType: "application/vnd.agentlas.science.paleontology-stratigraphic-analysis+json", ...analysisBlob, artifactId: null, artifactVersion: null },
        { role: "paleontology-stratigraphic-publication-table", mimeType: "application/vnd.agentlas.science-table+json", ...tableBlob, artifactId: null, artifactVersion: null },
        { role: "paleontology-stratigraphic-figure", mimeType: "application/vnd.vega.v5+json", ...figureBlob, artifactId: null, artifactVersion: null },
      ];
      const estimates = analysis.estimates;
      const summary = `${estimates.occurrenceCount} exact PBDB occurrences span reported bounds ${estimates.oldestBoundMa}–${estimates.youngestBoundMa} Ma across ${estimates.formationCount} named formations; intervals remain bounds and molecular evidence remains none.`;
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`),
        projectId: input.projectId,
        runId: run.id,
        status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)),
        summary,
        outputs,
      }).run;
      const payload = this.artifactPayload(analysis, parent, run.id, tableBlob.sha256, figureBlob.sha256);
      const artifact = this.store.createArtifact({
        projectId: input.projectId,
        sourceRunId: run.id,
        kind: "chart.vega",
        title,
        rendererId: "agentlas.vega",
        rendererVersion: "6.4.0",
        rendererBinding: null,
        payload,
        semantic: {
          title,
          summary,
          entities: [{ id: parent.catalog.taxon.acceptedTaxonId, label: parent.catalog.taxon.acceptedName, type: "pbdb-taxon" }],
          observations: [
            { label: "Retrieved occurrences", value: estimates.occurrenceCount, unit: "count" },
            { label: "Named formations", value: estimates.formationCount, unit: "count" },
            { label: "Oldest reported bound", value: estimates.oldestBoundMa, unit: "Ma" },
            { label: "Youngest reported bound", value: estimates.youngestBoundMa, unit: "Ma" },
            { label: "Median interval width", value: estimates.medianIntervalWidthMa, unit: "Myr" },
          ],
          warnings: [...analysis.warnings, ...analysis.assumptions],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: parent.sourceRefs,
          datasetSha256: [...parent.datasetSha256, analysis.analysisSha256, tableBlob.sha256, figureBlob.sha256],
          codeSha256: sha256(`${PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_ID}@${PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_VERSION}:${analysis.methodRevision}:agentlas-paleontology@${engine.PLUGIN_VERSION}`),
          environmentSha256,
        },
        linkage: {
          labId: PALEONTOLOGY_EVIDENCE_LAB_ID,
          origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
          parent: null,
          inputs: [],
        },
      });
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-paleontology-analysis-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId,
        runId: run.id,
        outputOrdinal: 1,
        artifactId: artifact.id,
        artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return { schema: PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_RESULT_SCHEMA, toolId: PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_ID, runId: run.id, parentRunId: parent.run.id, title, analysis, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:failed`),
        projectId: input.projectId,
        runId: run.id,
        status: "failed",
        outputManifestSha256: sha256(canonicalJson([])),
        summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-paleontology-analysis-failed",
        outputs: [],
      });
      throw error;
    }
  }

  private artifactPayload(
    analysis: PaleontologyStratigraphicAnalysisRecord,
    parent: ExactParent,
    analysisRunId: string,
    publicationTableSha256: string,
    figureSha256: string,
  ): JsonRecord {
    return {
      schema: PALEONTOLOGY_STRATIGRAPHIC_ARTIFACT_SCHEMA,
      analysis,
      spec: analysis.spec,
      source: {
        parentRunId: parent.run.id,
        analysisRunId,
        catalogOutputSha256: parent.catalogOutput.sha256,
        rawResponseSha256: parent.rawOutputs.map((resource) => resource.sha256),
        sourceVersionSha256: parent.catalog.sources.map((source) => source.responseSha256),
        analysisSha256: analysis.analysisSha256,
        publicationTableSha256,
        figureSha256,
        evidenceClass: "stratigraphic-occurrence-support",
        molecularEvidence: "none",
      },
    };
  }
}

export function paleontologyStratigraphicAnalysisToolSummary(result: PaleontologyStratigraphicAnalysisResult): JsonRecord {
  return {
    methodRevision: result.analysis.methodRevision,
    parentRunId: result.parentRunId,
    summary: `${result.analysis.estimates.occurrenceCount} occurrence intervals; ${result.analysis.estimates.formationCount} named formations; ${result.analysis.estimates.oldestBoundMa}–${result.analysis.estimates.youngestBoundMa} Ma reported envelope.`,
    publicationTable: {
      schema: result.analysis.publicationTable.schema,
      title: result.analysis.publicationTable.title,
      rowCount: result.analysis.publicationTable.rows.length,
      contentSha256: result.analysis.contentReceipts.publicationTable.sha256,
    },
    figure: { schema: "application/vnd.vega.v5+json", contentSha256: result.analysis.contentReceipts.figure.sha256 },
    evidenceBoundary: result.analysis.evidenceBoundary,
    warnings: result.analysis.warnings,
    assumptions: result.analysis.assumptions,
  };
}
