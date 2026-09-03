import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type {
  ScienceArtifact,
  ScienceResearchRun,
  ScienceResearchRunParentBindingInput,
  ScienceResearchRunResource,
} from "../../shared/science-contract";
import { ScienceStore, scienceEvidenceGraphResearchRunContentSha256 } from "./store";
import {
  PALEONTOLOGY_CATALOG_TOOL_ID,
  PALEONTOLOGY_CATALOG_TOOL_VERSION,
  type PaleontologyCatalogResult,
} from "./paleontology-catalog";
import {
  PALEONTOLOGY_EVIDENCE_LAB_ID,
  PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_ID,
  PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_VERSION,
  type PaleontologyStratigraphicAnalysisRecord,
} from "./paleontology-analysis";
import { loadSciencePluginRuntime } from "./plugin-runtime";

export const PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_ID = "agentlas.paleontology-candidate-comparison";
export const PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_VERSION = "1.0.0";
export const PALEONTOLOGY_CANDIDATE_COMPARISON_RESULT_SCHEMA = "agentlas.science-paleontology-candidate-comparison-result/v1" as const;

const INPUT_ROLE = "paleontology-candidate-comparison-input";
const INPUT_MIME = "application/vnd.agentlas.science.paleontology-candidate-comparison-input+json";
const OUTPUT_ROLE = "paleontology-candidate-comparison";
const OUTPUT_MIME = "application/vnd.agentlas.science.paleontology-candidate-comparison+json";
const TABLE_OUTPUT_ROLE = "paleontology-candidate-comparison-publication-table";
const TABLE_OUTPUT_MIME = "application/vnd.agentlas.science-table+json";

type JsonRecord = Record<string, unknown>;

export interface PaleontologyCandidateComparisonInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  title?: string;
  candidates: Array<{ catalogRunId: string; stratigraphicRunId: string }>;
}

export interface PaleontologyCandidateComparisonRecord extends JsonRecord {
  schema: "agentlas.science.paleontology-candidate-comparison/v1";
  methodRevision: "exact-normalized-stratigraphic-matrix/v1";
  title: string;
  normalizedMatrix: Array<JsonRecord>;
  coverageDetails: Array<JsonRecord>;
  ranking: { status: "not-produced"; reason: "descriptive-comparison-only" | "truncated-parent-evidence" };
  publicationTable: JsonRecord;
  contentReceipts: {
    normalizedMatrix: { sha256: string; mimeType: "application/json" };
    publicationTable: { sha256: string; mimeType: "application/vnd.agentlas.science-table+json" };
  };
  evidenceBoundary: JsonRecord;
  assumptions: string[];
  warnings: string[];
  comparisonSha256: string;
}

export interface PaleontologyCandidateComparisonResult {
  schema: typeof PALEONTOLOGY_CANDIDATE_COMPARISON_RESULT_SCHEMA;
  toolId: typeof PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_ID;
  toolVersion: typeof PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_VERSION;
  runId: string;
  parentRunIds: string[];
  title: string;
  comparison: PaleontologyCandidateComparisonRecord;
  artifact: ScienceArtifact;
  replayed: boolean;
}

type PaleontologyComparisonRuntime = {
  PLUGIN_VERSION: string;
  stableStringify(value: unknown): string;
  compareFossilCandidateEvidence(input: {
    title: string;
    candidates: Array<{
      catalogRunId: string;
      stratigraphicRunId: string;
      catalog: PaleontologyCatalogResult;
      stratigraphicAnalysis: PaleontologyStratigraphicAnalysisRecord;
    }>;
  }): PaleontologyCandidateComparisonRecord;
};

interface VerifiedCandidate {
  catalogRun: ScienceResearchRun;
  stratigraphicRun: ScienceResearchRun;
  catalog: PaleontologyCatalogResult;
  stratigraphicAnalysis: PaleontologyStratigraphicAnalysisRecord;
  catalogOutput: ScienceResearchRunResource;
  stratigraphicOutput: ScienceResearchRunResource;
  catalogContentSha256: string;
  stratigraphicContentSha256: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function parseJson(bytes: Buffer, code: string): JsonRecord {
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), code);
  } catch {
    fail(code);
  }
}

function exactTitle(value: unknown): string {
  if (value === undefined || value === null) return "Exact fossil candidate comparison";
  if (typeof value !== "string") fail("science-paleontology-candidate-comparison-title-invalid");
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail("science-paleontology-candidate-comparison-title-invalid");
  }
  return normalized;
}

function resourceEnvelope(resource: Pick<ScienceResearchRunResource,
  "role" | "mimeType" | "byteSize" | "sha256" | "blobRef" | "artifactId" | "artifactVersion">): JsonRecord {
  return {
    role: resource.role,
    mimeType: resource.mimeType,
    byteSize: resource.byteSize,
    sha256: resource.sha256,
    blobRef: resource.blobRef,
    artifactId: resource.artifactId,
    artifactVersion: resource.artifactVersion,
  };
}

function verifyRunResources(store: ScienceStore, run: ScienceResearchRun): void {
  run.inputs.forEach((resource) => store.readRunBlob(resource));
  run.outputs.forEach((resource) => store.readRunBlob(resource));
  if (sha256(canonicalJson(run.inputs.map(resourceEnvelope))) !== run.inputManifestSha256
    || sha256(canonicalJson(run.outputs.map(resourceEnvelope))) !== run.outputManifestSha256) {
    fail("science-paleontology-candidate-comparison-parent-manifest-invalid");
  }
}

function runtime(): PaleontologyComparisonRuntime {
  const loaded = loadSciencePluginRuntime<Partial<PaleontologyComparisonRuntime>>(
    "agentlas-paleontology",
    "runtime/paleontology.cjs",
    4 * 1024 * 1024,
  ).runtime;
  if (loaded.PLUGIN_VERSION !== "0.2.0" || typeof loaded.stableStringify !== "function"
    || typeof loaded.compareFossilCandidateEvidence !== "function") {
    fail("science-paleontology-candidate-comparison-runtime-invalid");
  }
  return loaded as PaleontologyComparisonRuntime;
}

function verifyCandidate(
  store: ScienceStore,
  projectId: string,
  candidate: { catalogRunId: string; stratigraphicRunId: string },
): VerifiedCandidate {
  const catalogRun = store.getResearchRunForProject(projectId, candidate.catalogRunId);
  const stratigraphicRun = store.getResearchRunForProject(projectId, candidate.stratigraphicRunId);
  if (!catalogRun || !stratigraphicRun) fail("science-paleontology-candidate-comparison-parent-run-invalid");
  if (catalogRun.status !== "succeeded" || catalogRun.toolId !== PALEONTOLOGY_CATALOG_TOOL_ID
    || catalogRun.toolVersion !== PALEONTOLOGY_CATALOG_TOOL_VERSION || catalogRun.parentRunId !== null) {
    fail("science-paleontology-candidate-comparison-catalog-parent-invalid");
  }
  if (stratigraphicRun.status !== "succeeded"
    || stratigraphicRun.toolId !== PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_ID
    || stratigraphicRun.toolVersion !== PALEONTOLOGY_STRATIGRAPHIC_ANALYSIS_TOOL_VERSION) {
    fail("science-paleontology-candidate-comparison-stratigraphic-parent-invalid");
  }
  if (stratigraphicRun.parentRunId !== catalogRun.id) {
    fail("science-paleontology-candidate-comparison-parent-relation-invalid");
  }
  verifyRunResources(store, catalogRun);
  verifyRunResources(store, stratigraphicRun);

  const catalogOutputs = catalogRun.outputs.filter((resource) => resource.role === "paleontology-catalog"
    && resource.mimeType === "application/vnd.agentlas.paleontology-catalog-results+json");
  const stratigraphicOutputs = stratigraphicRun.outputs.filter((resource) => resource.role === "paleontology-stratigraphic-analysis"
    && resource.mimeType === "application/vnd.agentlas.science.paleontology-stratigraphic-analysis+json");
  if (catalogOutputs.length !== 1) fail("science-paleontology-candidate-comparison-catalog-parent-invalid");
  if (stratigraphicOutputs.length !== 1) fail("science-paleontology-candidate-comparison-stratigraphic-parent-invalid");
  const catalogOutput = catalogOutputs[0]!;
  const stratigraphicOutput = stratigraphicOutputs[0]!;
  const catalog = parseJson(store.readRunBlob(catalogOutput), "science-paleontology-candidate-comparison-catalog-parent-invalid") as unknown as PaleontologyCatalogResult;
  const stratigraphicAnalysis = parseJson(store.readRunBlob(stratigraphicOutput), "science-paleontology-candidate-comparison-stratigraphic-parent-invalid") as unknown as PaleontologyStratigraphicAnalysisRecord;
  if (catalog.schema !== "agentlas.paleontology-catalog-result/v1" || catalog.provider !== "pbdb-data1.2"
    || catalog.runId !== catalogRun.id || catalog.replayed !== false) {
    fail("science-paleontology-candidate-comparison-catalog-parent-invalid");
  }
  if (stratigraphicAnalysis.schema !== "agentlas.paleontology-stratigraphic-analysis/v1"
    || stratigraphicAnalysis.methodRevision !== "interval-preserving-stratigraphic-support/v1"
    || stratigraphicAnalysis.source?.parentRunId !== catalogRun.id
    || stratigraphicAnalysis.evidenceBoundary?.evidenceClass !== "stratigraphic-occurrence-support"
    || stratigraphicAnalysis.evidenceBoundary.molecularEvidence !== "none") {
    fail("science-paleontology-candidate-comparison-stratigraphic-parent-invalid");
  }
  const { analysisSha256, ...analysisCore } = stratigraphicAnalysis;
  if (!/^[a-f0-9]{64}$/u.test(analysisSha256) || analysisSha256 !== sha256(canonicalJson(analysisCore))) {
    fail("science-paleontology-candidate-comparison-stratigraphic-parent-invalid");
  }
  const parentBindings = store.getResearchRunParentBindings(projectId, stratigraphicRun.id);
  const catalogContentSha256 = scienceEvidenceGraphResearchRunContentSha256(catalogRun);
  if (parentBindings.length !== 1 || parentBindings[0]?.ordinal !== 1 || parentBindings[0].role !== "primary"
    || parentBindings[0].parentRunId !== catalogRun.id || parentBindings[0].parentContentSha256 !== catalogContentSha256) {
    fail("science-paleontology-candidate-comparison-parent-relation-invalid");
  }
  return {
    catalogRun,
    stratigraphicRun,
    catalog,
    stratigraphicAnalysis,
    catalogOutput,
    stratigraphicOutput,
    catalogContentSha256,
    stratigraphicContentSha256: scienceEvidenceGraphResearchRunContentSha256(stratigraphicRun),
  };
}

function parentBindings(candidates: VerifiedCandidate[]): ScienceResearchRunParentBindingInput[] {
  return [
    { ordinal: 1, role: "primary", parentRunId: candidates[0]!.stratigraphicRun.id },
    { ordinal: 2, role: "candidate-1-catalog", parentRunId: candidates[0]!.catalogRun.id },
    ...candidates.slice(1).flatMap((candidate, index) => {
      const ordinal = index + 2;
      return [
        { ordinal: ordinal * 2 - 1, role: `candidate-${ordinal}-stratigraphic`, parentRunId: candidate.stratigraphicRun.id },
        { ordinal: ordinal * 2, role: `candidate-${ordinal}-catalog`, parentRunId: candidate.catalogRun.id },
      ];
    }),
  ];
}

function verifyComparison(value: PaleontologyCandidateComparisonRecord, candidates: VerifiedCandidate[]): PaleontologyCandidateComparisonRecord {
  if (value.schema !== "agentlas.science.paleontology-candidate-comparison/v1"
    || value.methodRevision !== "exact-normalized-stratigraphic-matrix/v1"
    || !Array.isArray(value.normalizedMatrix) || value.normalizedMatrix.length !== candidates.length
    || !Array.isArray(value.coverageDetails) || value.coverageDetails.length !== candidates.length
    || value.ranking?.status !== "not-produced"
    || !["descriptive-comparison-only", "truncated-parent-evidence"].includes(value.ranking.reason)
    || value.contentReceipts?.normalizedMatrix?.sha256 !== sha256(canonicalJson(value.normalizedMatrix))
    || value.contentReceipts?.publicationTable?.sha256 !== sha256(canonicalJson(value.publicationTable))) {
    fail("science-paleontology-candidate-comparison-result-invalid");
  }
  value.normalizedMatrix.forEach((rawRow, index) => {
    const row = record(rawRow, "science-paleontology-candidate-comparison-result-invalid");
    const candidate = candidates[index]!;
    if (row.candidateOrdinal !== index + 1 || row.catalogRunId !== candidate.catalogRun.id
      || row.stratigraphicRunId !== candidate.stratigraphicRun.id
      || row.acceptedTaxonId !== candidate.catalog.taxon.acceptedTaxonId
      || row.acceptedName !== candidate.catalog.taxon.acceptedName
      || row.parentTruncated !== candidate.catalog.pagination.truncated
      || row.evidenceClass !== "stratigraphic-occurrence-support" || row.molecularEvidence !== "none") {
      fail("science-paleontology-candidate-comparison-result-invalid");
    }
  });
  const expectedReason = candidates.some((candidate) => candidate.catalog.pagination.truncated)
    ? "truncated-parent-evidence" : "descriptive-comparison-only";
  if (value.ranking.reason !== expectedReason
    || value.evidenceBoundary?.biologicalFeasibilityAssessed !== false
    || value.evidenceBoundary?.callerScoreAccepted !== false
    || value.evidenceBoundary?.nullsImputed !== false
    || value.evidenceBoundary?.pointEstimateUsed !== false) {
    fail("science-paleontology-candidate-comparison-result-invalid");
  }
  const { comparisonSha256, ...core } = value;
  if (!/^[a-f0-9]{64}$/u.test(comparisonSha256) || comparisonSha256 !== sha256(canonicalJson(core))) {
    fail("science-paleontology-candidate-comparison-result-invalid");
  }
  const serialized = canonicalJson(value);
  if (/"(?:revivalProbability|molecularScore|genomeScore|embryoScore|hatchingScore|biologicalFeasibilityScore)"/iu.test(serialized)) {
    fail("science-paleontology-candidate-comparison-prohibited-score");
  }
  return value;
}

export function paleontologyCandidateComparisonToolSummary(result: PaleontologyCandidateComparisonResult): JsonRecord {
  return {
    methodRevision: result.comparison.methodRevision,
    parentRunIds: result.parentRunIds,
    normalizedMatrix: result.comparison.normalizedMatrix,
    ranking: result.comparison.ranking,
    evidenceBoundary: result.comparison.evidenceBoundary,
    warnings: result.comparison.warnings,
    contentReceipts: result.comparison.contentReceipts,
  };
}

export class SciencePaleontologyCandidateComparisonService {
  constructor(private readonly store: ScienceStore) {}

  compare(input: PaleontologyCandidateComparisonInput): PaleontologyCandidateComparisonResult {
    if (!Array.isArray(input.candidates) || input.candidates.length < 2 || input.candidates.length > 20) {
      fail("science-paleontology-candidate-comparison-candidates-invalid");
    }
    const seenCandidates = new Set<string>();
    const seenRuns = new Set<string>();
    const candidates: VerifiedCandidate[] = [];
    for (const rawCandidate of input.candidates) {
      if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)
        || typeof rawCandidate.catalogRunId !== "string" || typeof rawCandidate.stratigraphicRunId !== "string") {
        fail("science-paleontology-candidate-comparison-candidate-invalid");
      }
      const candidateKey = `${rawCandidate.catalogRunId}\u0000${rawCandidate.stratigraphicRunId}`;
      if (seenCandidates.has(candidateKey)) fail("science-paleontology-candidate-comparison-candidate-duplicate");
      if (seenRuns.has(rawCandidate.catalogRunId) || seenRuns.has(rawCandidate.stratigraphicRunId)) {
        fail("science-paleontology-candidate-comparison-run-duplicate");
      }
      seenCandidates.add(candidateKey);
      const verified = verifyCandidate(this.store, input.projectId, rawCandidate);
      seenRuns.add(rawCandidate.catalogRunId);
      seenRuns.add(rawCandidate.stratigraphicRunId);
      candidates.push(verified);
    }
    const title = exactTitle(input.title);
    const engine = runtime();
    const comparison = verifyComparison(engine.compareFossilCandidateEvidence({
      title,
      candidates: candidates.map((candidate) => ({
        catalogRunId: candidate.catalogRun.id,
        stratigraphicRunId: candidate.stratigraphicRun.id,
        catalog: candidate.catalog,
        stratigraphicAnalysis: candidate.stratigraphicAnalysis,
      })),
    }), candidates);
    const bindings = parentBindings(candidates);
    const descriptor = {
      schema: "agentlas.science-paleontology-candidate-comparison-input/v1",
      title,
      methodRevision: comparison.methodRevision,
      candidates: candidates.map((candidate, index) => ({
        candidateOrdinal: index + 1,
        catalog: {
          runId: candidate.catalogRun.id,
          toolId: candidate.catalogRun.toolId,
          toolVersion: candidate.catalogRun.toolVersion,
          contentSha256: candidate.catalogContentSha256,
          resultOutputSha256: candidate.catalogOutput.sha256,
        },
        stratigraphic: {
          runId: candidate.stratigraphicRun.id,
          toolId: candidate.stratigraphicRun.toolId,
          toolVersion: candidate.stratigraphicRun.toolVersion,
          contentSha256: candidate.stratigraphicContentSha256,
          resultOutputSha256: candidate.stratigraphicOutput.sha256,
        },
      })),
      rankingPolicy: "not-produced",
    };
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const inputs = [{ role: INPUT_ROLE, mimeType: INPUT_MIME, ...descriptorBlob, artifactId: null, artifactVersion: null }];
    const environmentSha256 = sha256(canonicalJson({
      policy: "exact-multi-parent-descriptive-fossil-candidate-comparison-v1",
      plugin: `agentlas-paleontology@${engine.PLUGIN_VERSION}`,
      methodRevision: comparison.methodRevision,
      tool: `${PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_ID}@${PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_VERSION}`,
      parentContentSha256: candidates.flatMap((candidate) => [candidate.catalogContentSha256, candidate.stratigraphicContentSha256]),
      runtime: "electron-main",
    }));
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      parentRunId: candidates[0]!.stratigraphicRun.id,
      parentBindings: bindings,
      toolId: PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_ID,
      toolVersion: PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs.map(resourceEnvelope))),
      environmentSha256,
      inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    this.verifyParentBindings(input.projectId, run, candidates, bindings);
    if (created.replayed && run.status === "succeeded") {
      const replayed = this.verifyOutputs(run, comparison, descriptor, candidates);
      const artifact = this.artifactForRun(run, replayed, candidates);
      return this.result(run, candidates, title, replayed, artifact, true);
    }
    if (run.status !== "running") fail(`science-paleontology-candidate-comparison-run-${run.status}`);
    try {
      const comparisonBlob = this.store.putRunBlob(Buffer.from(engine.stableStringify(comparison), "utf8"));
      const tableBlob = this.store.putRunBlob(Buffer.from(engine.stableStringify(comparison.publicationTable), "utf8"));
      if (comparisonBlob.sha256 !== sha256(canonicalJson(comparison))
        || tableBlob.sha256 !== comparison.contentReceipts.publicationTable.sha256) {
        fail("science-paleontology-candidate-comparison-output-receipt-invalid");
      }
      const outputs = [
        { role: OUTPUT_ROLE, mimeType: OUTPUT_MIME, ...comparisonBlob, artifactId: null, artifactVersion: null },
        { role: TABLE_OUTPUT_ROLE, mimeType: TABLE_OUTPUT_MIME, ...tableBlob, artifactId: null, artifactVersion: null },
      ];
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`),
        projectId: input.projectId,
        runId: run.id,
        status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs.map(resourceEnvelope))),
        summary: `${candidates.length} exact fossil candidates compared descriptively from sealed PBDB and stratigraphic parents; no ranking, molecular evidence, or biological-revival score was produced.`,
        outputs,
      }).run;
      this.verifyParentBindings(input.projectId, run, candidates, bindings);
      const verified = this.verifyOutputs(run, comparison, descriptor, candidates);
      const artifact = this.artifactForRun(run, verified, candidates);
      return this.result(run, candidates, title, verified, artifact, false);
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        this.store.completeResearchRun({
          requestId: stableUuid(`${input.requestId}:failed`),
          projectId: input.projectId,
          runId: run.id,
          status: "failed",
          outputManifestSha256: sha256(canonicalJson([])),
          summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-paleontology-candidate-comparison-failed",
          outputs: [],
        });
      }
      throw error;
    }
  }

  private result(
    run: ScienceResearchRun,
    candidates: VerifiedCandidate[],
    title: string,
    comparison: PaleontologyCandidateComparisonRecord,
    artifact: ScienceArtifact,
    replayed: boolean,
  ): PaleontologyCandidateComparisonResult {
    return {
      schema: PALEONTOLOGY_CANDIDATE_COMPARISON_RESULT_SCHEMA,
      toolId: PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_ID,
      toolVersion: PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_VERSION,
      runId: run.id,
      parentRunIds: candidates.flatMap((candidate) => [candidate.catalogRun.id, candidate.stratigraphicRun.id]),
      title,
      comparison,
      artifact,
      replayed,
    };
  }

  private verifyParentBindings(
    projectId: string,
    run: ScienceResearchRun,
    candidates: VerifiedCandidate[],
    expected: ScienceResearchRunParentBindingInput[],
  ): void {
    const contentByRun = new Map(candidates.flatMap((candidate) => [
      [candidate.catalogRun.id, candidate.catalogContentSha256] as const,
      [candidate.stratigraphicRun.id, candidate.stratigraphicContentSha256] as const,
    ]));
    const actual = this.store.getResearchRunParentBindings(projectId, run.id);
    if (run.parentRunId !== candidates[0]!.stratigraphicRun.id || actual.length !== expected.length
      || actual.some((binding, index) => {
        const wanted = expected[index]!;
        return binding.ordinal !== wanted.ordinal || binding.role !== wanted.role
          || binding.parentRunId !== wanted.parentRunId
          || binding.parentContentSha256 !== contentByRun.get(wanted.parentRunId);
      })) {
      fail("science-paleontology-candidate-comparison-parent-binding-integrity-failed");
    }
  }

  private verifyOutputs(
    run: ScienceResearchRun,
    expected: PaleontologyCandidateComparisonRecord,
    descriptor: JsonRecord,
    candidates: VerifiedCandidate[],
  ): PaleontologyCandidateComparisonRecord {
    if (run.status !== "succeeded" || run.toolId !== PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_ID
      || run.toolVersion !== PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_VERSION
      || run.inputs.length !== 1 || run.outputs.length !== 2) {
      fail("science-paleontology-candidate-comparison-replay-invalid");
    }
    const input = run.inputs[0]!;
    const output = run.outputs[0]!;
    const tableOutput = run.outputs[1]!;
    if (input.ordinal !== 1 || input.role !== INPUT_ROLE || input.mimeType !== INPUT_MIME
      || output.ordinal !== 1 || output.role !== OUTPUT_ROLE || output.mimeType !== OUTPUT_MIME
      || tableOutput.ordinal !== 2 || tableOutput.role !== TABLE_OUTPUT_ROLE || tableOutput.mimeType !== TABLE_OUTPUT_MIME
      || sha256(canonicalJson(run.inputs.map(resourceEnvelope))) !== run.inputManifestSha256
      || sha256(canonicalJson(run.outputs.map(resourceEnvelope))) !== run.outputManifestSha256
      || !this.store.readRunBlob(input).equals(Buffer.from(canonicalJson(descriptor), "utf8"))) {
      fail("science-paleontology-candidate-comparison-replay-invalid");
    }
    const comparison = verifyComparison(
      parseJson(this.store.readRunBlob(output), "science-paleontology-candidate-comparison-replay-invalid") as PaleontologyCandidateComparisonRecord,
      candidates,
    );
    if (canonicalJson(comparison) !== canonicalJson(expected)
      || !this.store.readRunBlob(tableOutput).equals(Buffer.from(canonicalJson(comparison.publicationTable), "utf8"))) {
      fail("science-paleontology-candidate-comparison-replay-invalid");
    }
    return comparison;
  }

  private artifactForRun(
    run: ScienceResearchRun,
    comparison: PaleontologyCandidateComparisonRecord,
    candidates: VerifiedCandidate[],
  ): ScienceArtifact {
    let artifact = this.store.getArtifactForSourceRun(run.projectId, run.id, PALEONTOLOGY_EVIDENCE_LAB_ID);
    if (artifact && (artifact.kind !== "table" || artifact.title !== comparison.title
      || artifact.version.rendererId !== "agentlas.table" || artifact.version.rendererVersion !== "1.0.0"
      || artifact.sourceRunId !== run.id
      || canonicalJson(artifact.version.payload) !== canonicalJson(comparison.publicationTable))) {
      fail("science-paleontology-candidate-comparison-artifact-invalid");
    }
    if (!artifact) {
      artifact = this.store.createArtifact({
        projectId: run.projectId,
        sourceRunId: run.id,
        kind: "table",
        title: comparison.title,
        rendererId: "agentlas.table",
        rendererVersion: "1.0.0",
        rendererBinding: null,
        payload: comparison.publicationTable,
        semantic: {
          title: comparison.title,
          summary: `${comparison.normalizedMatrix.length} exact fossil candidates compared descriptively; ranking and biological feasibility were not produced.`,
          entities: comparison.normalizedMatrix.map((rawRow) => {
            const row = record(rawRow, "science-paleontology-candidate-comparison-result-invalid");
            return { id: String(row.acceptedTaxonId), label: String(row.acceptedName), type: "pbdb-taxon" };
          }),
          observations: [
            { label: "Candidates compared", value: comparison.normalizedMatrix.length, unit: "count" },
            { label: "Rankings produced", value: 0, unit: "count" },
            { label: "Molecular evidence rows", value: 0, unit: "count" },
          ],
          warnings: [...comparison.warnings, ...comparison.assumptions],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: candidates.flatMap((candidate) => [
            `research-run:${candidate.catalogRun.id}`,
            `research-run:${candidate.stratigraphicRun.id}`,
          ]),
          datasetSha256: [
            ...candidates.flatMap((candidate) => [candidate.catalogContentSha256, candidate.stratigraphicContentSha256]),
            comparison.comparisonSha256,
            comparison.contentReceipts.normalizedMatrix.sha256,
            comparison.contentReceipts.publicationTable.sha256,
          ],
          codeSha256: sha256(`${PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_ID}@${PALEONTOLOGY_CANDIDATE_COMPARISON_TOOL_VERSION}:${comparison.methodRevision}:agentlas-paleontology@0.2.0`),
          environmentSha256: run.environmentSha256,
        },
        linkage: {
          labId: PALEONTOLOGY_EVIDENCE_LAB_ID,
          origin: {
            surface: "conversation",
            conversationId: run.conversationId,
            messageId: run.originMessageId,
            loopSessionId: null,
            runId: run.id,
            branchId: null,
          },
          parent: null,
          inputs: [],
        },
      });
    }
    const binding = this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-paleontology-candidate-comparison-artifact-binding:v1:${run.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
      projectId: run.projectId,
      runId: run.id,
      outputOrdinal: 2,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    }).binding;
    const output = run.outputs[1]!;
    if (binding.outputId !== output.id || binding.outputSha256 !== output.sha256
      || binding.artifactId !== artifact.id || binding.artifactVersion !== artifact.currentVersion
      || binding.artifactContentSha256 !== artifact.version.contentSha256) {
      fail("science-paleontology-candidate-comparison-artifact-binding-invalid");
    }
    return artifact;
  }
}
