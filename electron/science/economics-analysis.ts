import { createHash } from "node:crypto";
import type {
  ScienceArtifact,
  ScienceResearchRun,
  ScienceResearchRunResource,
} from "../../shared/science-contract";
import type { ScienceEconomicIndicatorArtifactPayload } from "../../shared/science-economics";
import {
  SCIENCE_ECONOMICS_GROWTH_ARTIFACT_SCHEMA,
  SCIENCE_ECONOMICS_GROWTH_METRIC_FORMULA,
  SCIENCE_ECONOMICS_GROWTH_METRIC_ID,
  SCIENCE_ECONOMICS_GROWTH_METRIC_LABEL,
  SCIENCE_ECONOMICS_GROWTH_RESULT_SCHEMA,
  SCIENCE_ECONOMICS_GROWTH_TABLE_SCHEMA,
  SCIENCE_ECONOMICS_GROWTH_TOOL_ID,
  SCIENCE_ECONOMICS_GROWTH_TOOL_VERSION,
  createScienceEconomicIndicatorGrowthVegaSpec,
  scienceEconomicIndicatorGrowthAnalysisSha256,
  scienceEconomicsGrowthSha256,
  type ScienceEconomicIndicatorGrowthPayload,
  type ScienceEconomicIndicatorGrowthRow,
  validateScienceEconomicIndicatorGrowthPayload,
} from "../../shared/science-economics-analysis";
import {
  SCIENCE_ECONOMICS_ARTIFACT_SCHEMA,
  SCIENCE_ECONOMICS_LAB_ID,
  SCIENCE_ECONOMICS_TOOL_ID,
  SCIENCE_ECONOMICS_TOOL_VERSION,
  validateScienceEconomicIndicatorArtifactPayload,
} from "../../shared/science-economics";
import { assertScienceEconomicsCatalogRunClosure } from "./economics-catalog";
import { ScienceStore } from "./store";

const INPUT_SCHEMA = "agentlas.science.economic-indicator-growth-input/v1" as const;
const INPUT_ROLE = "economic-indicator-growth-input" as const;
const INPUT_MIME = "application/vnd.agentlas.science.economic-indicator-growth-input+json" as const;
const OUTPUT_ROLE = "economic-indicator-growth-analysis" as const;
const OUTPUT_MIME = "application/vnd.agentlas.science.economic-indicator-growth-analysis+json" as const;
const TABLE_OUTPUT_ROLE = "economic-indicator-growth-publication-table" as const;
const FIGURE_OUTPUT_ROLE = "economic-indicator-growth-figure" as const;
const TABLE_OUTPUT_MIME = "application/vnd.agentlas.science-table+json" as const;
const FIGURE_OUTPUT_MIME = "application/vnd.vega.v5+json" as const;
const ANALYSIS_METHOD_REVISION = "adjacent-annual-yoy-percent-v1" as const;
const ANALYSIS_CODE_SHA256 = createHash("sha256")
  .update(`${SCIENCE_ECONOMICS_GROWTH_TOOL_ID}@${SCIENCE_ECONOMICS_GROWTH_TOOL_VERSION}:${ANALYSIS_METHOD_REVISION}`)
  .digest("hex");

type JsonRecord = Record<string, unknown>;

export interface ScienceEconomicsGrowthAnalysisInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  parentRunId: string;
  title?: string;
}

export interface ScienceEconomicsGrowthAnalysisResult {
  schema: typeof SCIENCE_ECONOMICS_GROWTH_RESULT_SCHEMA;
  toolId: typeof SCIENCE_ECONOMICS_GROWTH_TOOL_ID;
  runId: string;
  parentRunId: string;
  title: string;
  analysis: ScienceEconomicIndicatorGrowthPayload;
  artifact: ScienceArtifact;
  replayed: boolean;
}

interface ResolvedParent {
  run: ScienceResearchRun;
  artifact: ScienceArtifact;
  payload: ScienceEconomicIndicatorArtifactPayload;
  rawOutput: ScienceResearchRunResource;
  receiptOutput: ScienceResearchRunResource;
  payloadOutput: ScienceResearchRunResource;
  rawBytes: Buffer;
  receiptBytes: Buffer;
  payloadBytes: Buffer;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entry = value as JsonRecord;
    return `{${Object.keys(entry).sort().flatMap((key) => entry[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(entry[key])}`]).join(",")}}`;
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

function safeText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return value.trim();
}

function exactUuid(value: unknown, code: string): string {
  const text = safeText(value, 80, code);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(text)) throw new Error(code);
  return text;
}

function exactTitle(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  return safeText(value, 240, "science-economics-growth-title-invalid");
}

function comparisonRows(payload: ScienceEconomicIndicatorArtifactPayload): ScienceEconomicIndicatorGrowthRow[] {
  const observations = payload.table.rows;
  const rows: ScienceEconomicIndicatorGrowthRow[] = [];
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;
    const fromYear = Number(previous.date);
    const toYear = Number(current.date);
    let status: ScienceEconomicIndicatorGrowthRow["status"];
    if (toYear !== fromYear + 1) status = "year-gap";
    else if (current.value === null) status = "missing-observation";
    else if (previous.value === null) status = "missing-baseline";
    else if (previous.value === 0) status = "zero-baseline";
    else status = "computed";
    const absoluteChange = status === "computed" || status === "zero-baseline"
      ? (current.value! - previous.value!)
      : null;
    const percentChange = status === "computed"
      ? (absoluteChange! / Math.abs(previous.value!)) * 100
      : null;
    rows.push({
      fromYear,
      toYear,
      fromValue: previous.value,
      toValue: current.value,
      absoluteChange: Object.is(absoluteChange, -0) ? 0 : absoluteChange,
      percentChange: Object.is(percentChange, -0) ? 0 : percentChange,
      status,
    });
  }
  return rows;
}

function notes(rows: ScienceEconomicIndicatorGrowthRow[]): { warnings: string[]; boundaries: string[] } {
  const missingObservationRows = rows.filter((row) => row.status === "missing-observation").length;
  const missingBaselineRows = rows.filter((row) => row.status === "missing-baseline").length;
  const gapRows = rows.filter((row) => row.status === "year-gap").length;
  const zeroBaselineRows = rows.filter((row) => row.status === "zero-baseline").length;
  const warnings = [
    ...(missingObservationRows ? [`${missingObservationRows} comparison(s) have a missing current observation and were not imputed.`] : []),
    ...(missingBaselineRows ? [`${missingBaselineRows} comparison(s) have a missing prior observation and were not carried forward.`] : []),
    ...(gapRows ? [`${gapRows} comparison(s) span a year gap and were not treated as annual growth.`] : []),
    ...(zeroBaselineRows ? [`${zeroBaselineRows} comparison(s) have a zero prior value; percentage change is undefined.`] : []),
  ];
  return {
    warnings,
    boundaries: [
      "This descriptive transformation compares adjacent calendar-year observations only.",
      "Missing values are preserved and neither imputed nor carried forward.",
      "A zero prior value has undefined percentage change and remains null.",
      "The result does not identify causal effects, forecasts, or investment recommendations.",
    ],
  };
}

function summary(rows: ScienceEconomicIndicatorGrowthRow[], inputRows: number): ScienceEconomicIndicatorGrowthPayload["summary"] {
  const values = rows.flatMap((row) => row.percentChange === null ? [] : [row.percentChange]);
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const middle = Math.floor(sorted.length / 2);
  const median = !sorted.length ? null : sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    inputRows,
    comparisonRows: rows.length,
    computedRows: rows.filter((row) => row.status === "computed").length,
    missingObservationRows: rows.filter((row) => row.status === "missing-observation").length,
    missingBaselineRows: rows.filter((row) => row.status === "missing-baseline").length,
    gapRows: rows.filter((row) => row.status === "year-gap").length,
    zeroBaselineRows: rows.filter((row) => row.status === "zero-baseline").length,
    meanPercentChange: mean === null ? null : Object.is(mean, -0) ? 0 : mean,
    medianPercentChange: median === null ? null : Object.is(median, -0) ? 0 : median,
  };
}

function resolvedParent(store: ScienceStore, projectId: string, parentRunId: string): ResolvedParent {
  const code = "science-economics-growth";
  const run = store.getResearchRunForProject(projectId, exactUuid(parentRunId, `${code}-parent-run-invalid`));
  if (!run || run.status !== "succeeded" || run.toolId !== SCIENCE_ECONOMICS_TOOL_ID || run.toolVersion !== SCIENCE_ECONOMICS_TOOL_VERSION) {
    throw new Error(`${code}-parent-run-invalid`);
  }
  const rawOutput = run.outputs[0];
  const receiptOutput = run.outputs[1];
  const payloadOutput = run.outputs[2];
  if (!rawOutput || !receiptOutput || !payloadOutput || run.outputs.length !== 3) throw new Error(`${code}-parent-output-invalid`);
  const payloadBytes = store.readRunBlob(payloadOutput);
  const rawBytes = store.readRunBlob(rawOutput);
  const receiptBytes = store.readRunBlob(receiptOutput);
  let payload: ScienceEconomicIndicatorArtifactPayload;
  try { payload = validateScienceEconomicIndicatorArtifactPayload(JSON.parse(payloadBytes.toString("utf8"))); } catch { throw new Error(`${code}-parent-output-invalid`); }
  if (payload.evidence.runId !== run.id) throw new Error(`${code}-parent-output-invalid`);
  try { assertScienceEconomicsCatalogRunClosure(store, projectId, payload); } catch { throw new Error(`${code}-parent-closure-invalid`); }
  const artifact = store.getArtifactForSourceRun(projectId, run.id, SCIENCE_ECONOMICS_LAB_ID);
  if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega"
    || artifact.version.payload.schema !== SCIENCE_ECONOMICS_ARTIFACT_SCHEMA || artifact.sourceRunId !== run.id) {
    throw new Error(`${code}-parent-artifact-invalid`);
  }
  const context = store.getArtifactContextForProject(projectId, artifact.id, artifact.currentVersion);
  if (!context || !context.isCurrent || context.linkage.labId !== SCIENCE_ECONOMICS_LAB_ID
    || context.linkage.origin.runId !== run.id || context.selectedVersion.contentSha256 !== artifact.version.contentSha256) {
    throw new Error(`${code}-parent-artifact-lineage-invalid`);
  }
  let artifactPayload: ScienceEconomicIndicatorArtifactPayload;
  try { artifactPayload = validateScienceEconomicIndicatorArtifactPayload(artifact.version.payload); } catch { throw new Error(`${code}-parent-artifact-invalid`); }
  if (scienceEconomicsGrowthSha256(artifactPayload) !== scienceEconomicsGrowthSha256(payload)) throw new Error(`${code}-parent-artifact-payload-mismatch`);
  return { run, artifact, payload, rawOutput, receiptOutput, payloadOutput, rawBytes, receiptBytes, payloadBytes };
}

function parentDescriptor(parent: ResolvedParent, title: string): JsonRecord {
  return {
    schema: INPUT_SCHEMA,
    toolId: SCIENCE_ECONOMICS_GROWTH_TOOL_ID,
    toolVersion: SCIENCE_ECONOMICS_GROWTH_TOOL_VERSION,
    metric: {
      id: SCIENCE_ECONOMICS_GROWTH_METRIC_ID,
      label: SCIENCE_ECONOMICS_GROWTH_METRIC_LABEL,
      formula: SCIENCE_ECONOMICS_GROWTH_METRIC_FORMULA,
      baselinePolicy: "absolute-prior-value",
    },
    parentRunId: parent.run.id,
    parentArtifactId: parent.artifact.id,
    parentArtifactVersion: parent.artifact.currentVersion,
    parentArtifactContentSha256: parent.artifact.version.contentSha256,
    parentPayloadSha256: parent.payloadOutput.sha256,
    rawResponseSha256: parent.rawOutput.sha256,
    title,
  };
}

function bodyWithoutProvenance(
  parent: ResolvedParent,
  title: string,
  rows: ScienceEconomicIndicatorGrowthRow[],
): Omit<ScienceEconomicIndicatorGrowthPayload, "provenance"> {
  const { warnings, boundaries } = notes(rows);
  const source = {
    parentRunId: parent.run.id,
    parentArtifactId: parent.artifact.id,
    parentArtifactVersion: parent.artifact.currentVersion,
    parentArtifactContentSha256: parent.artifact.version.contentSha256,
    parentPayloadSha256: parent.payloadOutput.sha256,
    rawResponseSha256: parent.rawOutput.sha256,
    sourceId: parent.payload.evidence.source.id,
    sourceVersionId: parent.payload.evidence.source.versionId,
    canonicalUri: parent.payload.evidence.source.canonicalUri,
    query: parent.payload.evidence.query,
    countryName: parent.payload.evidence.normalization.series.country.name,
    indicatorName: parent.payload.evidence.normalization.series.indicator.name,
    unit: parent.payload.evidence.normalization.series.unit,
    decimals: parent.payload.evidence.normalization.series.decimals,
    observationCount: parent.payload.table.rows.length,
  };
  const table = {
    schema: SCIENCE_ECONOMICS_GROWTH_TABLE_SCHEMA,
    columns: [
      { id: "fromYear", label: "From year", type: "number" as const, unit: null, nullable: false },
      { id: "toYear", label: "To year", type: "number" as const, unit: null, nullable: false },
      { id: "fromValue", label: "Prior value", type: "number" as const, unit: null, nullable: true },
      { id: "toValue", label: "Current value", type: "number" as const, unit: null, nullable: true },
      { id: "absoluteChange", label: "Absolute change", type: "number" as const, unit: null, nullable: true },
      { id: "percentChange", label: "Year-over-year change", type: "number" as const, unit: "%", nullable: true },
      { id: "status", label: "Comparison status", type: "string" as const, unit: null, nullable: false },
    ],
    rows,
  };
  const spec = createScienceEconomicIndicatorGrowthVegaSpec(
    rows,
    title,
    source.indicatorName,
    source.unit,
  );
  const result = {
    schema: SCIENCE_ECONOMICS_GROWTH_ARTIFACT_SCHEMA,
    title,
    metric: {
      id: SCIENCE_ECONOMICS_GROWTH_METRIC_ID,
      label: SCIENCE_ECONOMICS_GROWTH_METRIC_LABEL,
      formula: SCIENCE_ECONOMICS_GROWTH_METRIC_FORMULA,
      baselinePolicy: "absolute-prior-value" as const,
    },
    source,
    table,
    spec,
    summary: summary(rows, parent.payload.table.rows.length),
    warnings,
    boundaries,
  } satisfies Omit<ScienceEconomicIndicatorGrowthPayload, "provenance">;
  return result;
}

function payloadForRun(
  parent: ResolvedParent,
  title: string,
  rows: ScienceEconomicIndicatorGrowthRow[],
  runId: string,
): ScienceEconomicIndicatorGrowthPayload {
  const body = bodyWithoutProvenance(parent, title, rows);
  const tableSha256 = scienceEconomicsGrowthSha256(body.table);
  const figureSha256 = scienceEconomicsGrowthSha256(body.spec);
  const analysisSha256 = scienceEconomicIndicatorGrowthAnalysisSha256(body);
  return {
    ...body,
    provenance: {
      runId,
      parentRunId: parent.run.id,
      parentArtifactContentSha256: parent.artifact.version.contentSha256,
      parentPayloadSha256: parent.payloadOutput.sha256,
      rawResponseSha256: parent.rawOutput.sha256,
      tableSha256,
      figureSha256,
      analysisSha256,
    },
  };
}

function result(
  run: ScienceResearchRun,
  parent: ResolvedParent,
  payload: ScienceEconomicIndicatorGrowthPayload,
  artifact: ScienceArtifact,
  replayed: boolean,
): ScienceEconomicsGrowthAnalysisResult {
  return {
    schema: SCIENCE_ECONOMICS_GROWTH_RESULT_SCHEMA,
    toolId: SCIENCE_ECONOMICS_GROWTH_TOOL_ID,
    runId: run.id,
    parentRunId: parent.run.id,
    title: payload.title,
    analysis: payload,
    artifact,
    replayed,
  };
}

export class ScienceEconomicsAnalysisService {
  constructor(private readonly store: ScienceStore) {}

  private artifactForRun(projectId: string, run: ScienceResearchRun, parent: ResolvedParent): ScienceArtifact {
    const artifact = this.store.getArtifactForSourceRun(projectId, run.id, SCIENCE_ECONOMICS_LAB_ID);
    if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega") throw new Error("science-economics-growth-replay-artifact-missing");
    const payload = validateScienceEconomicIndicatorGrowthPayload(artifact.version.payload);
    if (payload.provenance.runId !== run.id || payload.provenance.parentRunId !== parent.run.id) throw new Error("science-economics-growth-replay-artifact-invalid");
    const context = this.store.getArtifactContextForProject(projectId, artifact.id, artifact.currentVersion);
    if (!context || !context.isCurrent || context.linkage.labId !== SCIENCE_ECONOMICS_LAB_ID || context.linkage.origin.runId !== run.id
      || context.linkage.parent?.artifactId !== parent.artifact.id || context.linkage.parent.version !== parent.artifact.currentVersion) throw new Error("science-economics-growth-replay-artifact-invalid");
    const output = run.outputs.find((item) => item.role === OUTPUT_ROLE && item.mimeType === OUTPUT_MIME);
    if (!output || !this.store.readRunBlob(output).equals(Buffer.from(canonicalJson(payload), "utf8"))) throw new Error("science-economics-growth-replay-output-invalid");
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-economics-growth-run-artifact-binding:v1:${projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
      projectId,
      runId: run.id,
      outputOrdinal: 1,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  async analyze(input: ScienceEconomicsGrowthAnalysisInput): Promise<ScienceEconomicsGrowthAnalysisResult> {
    const parent = resolvedParent(this.store, input.projectId, input.parentRunId);
    const fallbackTitle = `Year-over-year change · ${parent.payload.evidence.normalization.series.indicator.name} · ${parent.payload.evidence.normalization.series.country.name}`;
    const title = exactTitle(input.title, fallbackTitle);
    const rows = comparisonRows(parent.payload);
    const descriptor = parentDescriptor(parent, title);
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const rawBlob = this.store.putRunBlob(parent.rawBytes);
    const receiptBlob = this.store.putRunBlob(parent.receiptBytes);
    const payloadBlob = this.store.putRunBlob(parent.payloadBytes);
    const inputs = [
      { role: INPUT_ROLE, mimeType: INPUT_MIME, ...descriptorBlob, artifactId: null, artifactVersion: null },
      { role: "economic-indicator-growth-parent-response", mimeType: parent.rawOutput.mimeType, ...rawBlob, artifactId: null, artifactVersion: null },
      { role: "economic-indicator-growth-parent-receipt", mimeType: parent.receiptOutput.mimeType, ...receiptBlob, artifactId: null, artifactVersion: null },
      { role: "economic-indicator-growth-parent-artifact", mimeType: parent.payloadOutput.mimeType, ...payloadBlob, artifactId: parent.artifact.id, artifactVersion: parent.artifact.currentVersion },
    ];
    const environmentSha256 = sha256(canonicalJson({
      policy: "world-bank-economic-indicator-adjacent-yoy-v1",
      parentToolId: SCIENCE_ECONOMICS_TOOL_ID,
      parentToolVersion: SCIENCE_ECONOMICS_TOOL_VERSION,
      plugin: "agentlas-economic-data@1.0.0",
      methodRevision: ANALYSIS_METHOD_REVISION,
      runtime: process.version,
    }));
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      parentRunId: parent.run.id,
      toolId: SCIENCE_ECONOMICS_GROWTH_TOOL_ID,
      toolVersion: SCIENCE_ECONOMICS_GROWTH_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs)),
      environmentSha256,
      inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "failed") throw new Error("science-economics-growth-prior-run-failed");
    if (created.replayed && run.status === "running") throw new Error("science-economics-growth-run-in-progress");
    const expectedPayload = payloadForRun(parent, title, rows, run.id);
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((item) => item.role === OUTPUT_ROLE && item.mimeType === OUTPUT_MIME);
      if (!output) throw new Error("science-economics-growth-replay-output-missing");
      const storedPayload = validateScienceEconomicIndicatorGrowthPayload(JSON.parse(this.store.readRunBlob(output).toString("utf8")));
      if (canonicalJson(storedPayload) !== canonicalJson(expectedPayload)) throw new Error("science-economics-growth-replay-output-invalid");
      const artifact = this.artifactForRun(input.projectId, run, parent);
      return result(run, parent, storedPayload, artifact, true);
    }
    if (run.status !== "running") throw new Error(`science-economics-growth-run-${run.status}`);
    try {
      const analysisBytes = Buffer.from(canonicalJson(expectedPayload), "utf8");
      const tableBytes = Buffer.from(canonicalJson(expectedPayload.table), "utf8");
      const figureBytes = Buffer.from(canonicalJson(expectedPayload.spec), "utf8");
      const analysisBlob = this.store.putRunBlob(analysisBytes);
      const tableBlob = this.store.putRunBlob(tableBytes);
      const figureBlob = this.store.putRunBlob(figureBytes);
      const outputs = [
        { role: OUTPUT_ROLE, mimeType: OUTPUT_MIME, ...analysisBlob, artifactId: null, artifactVersion: null },
        { role: TABLE_OUTPUT_ROLE, mimeType: TABLE_OUTPUT_MIME, ...tableBlob, artifactId: null, artifactVersion: null },
        { role: FIGURE_OUTPUT_ROLE, mimeType: FIGURE_OUTPUT_MIME, ...figureBlob, artifactId: null, artifactVersion: null },
      ];
      const completed = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`),
        projectId: input.projectId,
        runId: run.id,
        status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)),
        summary: `${expectedPayload.summary.computedRows} adjacent annual percentage changes computed from ${expectedPayload.summary.inputRows} exact World Bank observations; missing values and year gaps remain explicit.`,
        outputs,
      });
      run = completed.run;
      const artifact = this.store.createArtifact({
        projectId: input.projectId,
        sourceRunId: run.id,
        kind: "chart.vega",
        title,
        rendererId: "agentlas.vega",
        rendererVersion: "6.4.0",
        rendererBinding: null,
        payload: expectedPayload as unknown as Record<string, unknown>,
        semantic: {
          title,
          summary: `${expectedPayload.summary.computedRows} adjacent annual percentage changes computed from exact World Bank observations.`,
          entities: [
            { id: expectedPayload.source.query.country, label: expectedPayload.source.countryName, type: "country-or-economy" },
            { id: expectedPayload.source.query.indicator, label: expectedPayload.source.indicatorName, type: "economic-indicator" },
          ],
          observations: [
            { label: "Input observations", value: expectedPayload.summary.inputRows, unit: "count" },
            { label: "Computed changes", value: expectedPayload.summary.computedRows, unit: "count" },
            { label: "Mean change", value: expectedPayload.summary.meanPercentChange === null ? "not computed" : expectedPayload.summary.meanPercentChange, unit: "%" },
            { label: "Median change", value: expectedPayload.summary.medianPercentChange === null ? "not computed" : expectedPayload.summary.medianPercentChange, unit: "%" },
          ],
          warnings: expectedPayload.warnings,
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: [expectedPayload.source.canonicalUri],
          datasetSha256: [
            expectedPayload.source.rawResponseSha256,
            expectedPayload.source.parentPayloadSha256,
            expectedPayload.provenance.analysisSha256,
            expectedPayload.provenance.tableSha256,
            expectedPayload.provenance.figureSha256,
          ],
          codeSha256: ANALYSIS_CODE_SHA256,
          environmentSha256,
        },
        linkage: {
          labId: SCIENCE_ECONOMICS_LAB_ID,
          origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
          parent: { artifactId: parent.artifact.id, version: parent.artifact.currentVersion },
          inputs: [{ artifactId: parent.artifact.id, version: parent.artifact.currentVersion }],
        },
      });
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-economics-growth-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId,
        runId: run.id,
        outputOrdinal: 1,
        artifactId: artifact.id,
        artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return result(run, parent, expectedPayload, artifact, false);
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:failed`),
        projectId: input.projectId,
        runId: run.id,
        status: "failed",
        outputManifestSha256: sha256(canonicalJson([])),
        summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-economics-growth-failed",
        outputs: [],
      });
      throw error;
    }
  }
}

export function economicsGrowthAnalysisToolSummary(result: ScienceEconomicsGrowthAnalysisResult): JsonRecord {
  return {
    methodRevision: ANALYSIS_METHOD_REVISION,
    parentRunId: result.parentRunId,
    summary: result.analysis.summary,
    publicationTable: {
      schema: result.analysis.table.schema,
      rowCount: result.analysis.table.rows.length,
      contentSha256: result.analysis.provenance.tableSha256,
    },
    figure: { schema: FIGURE_OUTPUT_MIME, contentSha256: result.analysis.provenance.figureSha256 },
    warnings: result.analysis.warnings,
    boundaries: result.analysis.boundaries,
  };
}
