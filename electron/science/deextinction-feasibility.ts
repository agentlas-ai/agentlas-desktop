import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceResearchRunParentBindingInput } from "../../shared/science-contract";
import { ScienceStore, scienceEvidenceGraphResearchRunContentSha256 } from "./store";
import { loadSciencePluginRuntime } from "./plugin-runtime";

export const DEEXTINCTION_FEASIBILITY_TOOL_ID = "agentlas.paleontology-deextinction-feasibility";
export const DEEXTINCTION_FEASIBILITY_TOOL_VERSION = "1.0.0";
export const DEEXTINCTION_FEASIBILITY_RESULT_SCHEMA = "agentlas.science-deextinction-feasibility-result/v1" as const;
export const DEEXTINCTION_FEASIBILITY_ARTIFACT_SCHEMA = "agentlas.science.deextinction-feasibility-artifact/v1" as const;
export const DEEXTINCTION_FEASIBILITY_LAB_ID = "paleontology-evidence" as const;
export const PALEONTOLOGY_DEEXTINCTION_FEASIBILITY_TOOL_ID = DEEXTINCTION_FEASIBILITY_TOOL_ID;
export const PALEONTOLOGY_DEEXTINCTION_FEASIBILITY_TOOL_VERSION = DEEXTINCTION_FEASIBILITY_TOOL_VERSION;

const ALLOWED_SOURCE_TOOLS = new Set([
  "agentlas.academic-search@1.0.0",
  "agentlas.academic-full-text@1.0.0",
  "agentlas.pbdb-taxon-occurrences@1.0.0",
  "agentlas.paleontology-stratigraphic-support@1.0.0",
  "agentlas.biodiversity-catalog@1.0.0",
  "agentlas.ensembl-variant-track@1.1.0",
  "agentlas.extant-reference-assembly-manifest@1.0.0",
  "agentlas.comparative-genomics-gene-tree@1.0.0",
  "agentlas.comparative-genomics-hypothetical-fitch-asr@0.1.0",
  "agentlas.scientific-data@1.0.0",
]);

const REQUIRED_PROHIBITED_CLAIMS = [
  "recovered-dinosaur-dna",
  "dinosaur-genome",
  "reconstructed-dinosaur-genome",
  "viable-dinosaur-embryo",
  "dinosaur-hatching",
  "biological-resurrection-achieved",
] as const;

const BIOLOGICAL_GATE_CRITERIA = new Set([
  "authenticated-endogenous-dinosaur-dna",
  "species-level-nuclear-genome-and-karyotype",
  "viable-cell-or-nucleus",
  "validated-avian-embryo-surrogate-platform",
]);

const PBDB_EVIDENCE_TOOLS = new Set([
  "agentlas.pbdb-taxon-occurrences@1.0.0",
  "agentlas.paleontology-stratigraphic-support@1.0.0",
]);

const EXTANT_GENOME_EVIDENCE_TOOLS = new Set([
  "agentlas.ensembl-variant-track@1.1.0",
  "agentlas.extant-reference-assembly-manifest@1.0.0",
  "agentlas.scientific-data@1.0.0",
]);

const EXTANT_REFERENCE_ASSEMBLY_MANIFEST_TOOL = "agentlas.extant-reference-assembly-manifest@1.0.0";

const COMPARATIVE_GENE_TREE_EVIDENCE_TOOLS = new Set([
  "agentlas.comparative-genomics-gene-tree@1.0.0",
]);

const HYPOTHETICAL_ASR_EVIDENCE_TOOL = "agentlas.comparative-genomics-hypothetical-fitch-asr@0.1.0";

type JsonRecord = Record<string, unknown>;
type ResearchRun = NonNullable<ReturnType<ScienceStore["getResearchRunForProject"]>>;

export type DeextinctionTargetObjective = "actual-biological-revival" | "comparative-proxy-research";
export type DeextinctionEvidenceStatus = "observed" | "inferred" | "hypothetical" | "missing";
export type DeextinctionFinding = "supports" | "contradicts" | "inconclusive" | "not-assessed";

export interface DeextinctionEvidenceInput {
  criterionId: string;
  evidenceStatus: DeextinctionEvidenceStatus;
  finding: DeextinctionFinding;
  detail: string;
  sourceRunIds: string[];
}

export interface DeextinctionCandidateInput {
  candidateId: string;
  taxonName: string;
  label: string;
  evidence: DeextinctionEvidenceInput[];
}

export interface DeextinctionFeasibilityInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  title: string;
  targetObjective: DeextinctionTargetObjective;
  candidates: DeextinctionCandidateInput[];
}

export interface DeextinctionFeasibilityRecord extends JsonRecord {
  schema: "agentlas.paleontology-deextinction-feasibility/v1";
  methodRevision: "fixed-evidence-gate-audit/v1";
  title: string;
  targetObjective: DeextinctionTargetObjective;
  candidates: Array<JsonRecord & {
    candidateId: string;
    taxonName: string;
    label: string;
    biologicalGateDecision: "stopped" | "evidence-gates-satisfied-pending-expert-review" | "not-assessed-different-objective";
    evidenceRows: Array<JsonRecord & {
      criterionId: string;
      evidenceStatus: DeextinctionEvidenceStatus;
      finding: DeextinctionFinding;
      detail: string;
      sourceRunIds: string[];
    }>;
  }>;
  publicationTable: JsonRecord;
  spec: JsonRecord;
  contentReceipts: {
    publicationTable: { sha256: string; mimeType: "application/vnd.agentlas.science-table+json" };
    figure: { sha256: string; mimeType: "application/vnd.vega.v5+json" };
  };
  evidenceBoundary: {
    biologicalFeasibilityScoreEmitted: false;
    pbdbFossilCoverageBiologicalFeasibilityContribution: 0;
    prohibitedClaims: string[];
  };
  assumptions: string[];
  warnings: string[];
  deterministicHash: string;
}

export interface DeextinctionFeasibilityResult {
  schema: typeof DEEXTINCTION_FEASIBILITY_RESULT_SCHEMA;
  toolId: typeof DEEXTINCTION_FEASIBILITY_TOOL_ID;
  runId: string;
  parentRunIds: string[];
  title: string;
  assessment: DeextinctionFeasibilityRecord;
  artifact: ScienceArtifact;
  replayed: boolean;
}

type PaleontologyRuntime = {
  PLUGIN_VERSION: string;
  stableStringify(value: unknown): string;
  sha256(value: string): string;
  assessDeextinctionFeasibility(input: {
    title: string;
    targetObjective: DeextinctionTargetObjective;
    candidates: DeextinctionCandidateInput[];
  }): DeextinctionFeasibilityRecord;
};

interface SealedParent {
  run: ResearchRun;
  contentSha256: string;
  outputs: Array<{
    ordinal: number;
    role: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
  }>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
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

function exactKeys(value: JsonRecord, allowed: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}

function assertScoreFreeInput(value: DeextinctionFeasibilityInput): void {
  const input = record(value, "science-deextinction-feasibility-input-invalid");
  exactKeys(input, [
    "requestId", "projectId", "conversationId", "originMessageId", "title", "targetObjective", "candidates",
  ], "science-deextinction-feasibility-input-unknown-field");
  if (!Array.isArray(input.candidates)) fail("science-deextinction-feasibility-candidates-invalid");
  for (const rawCandidate of input.candidates) {
    const candidate = record(rawCandidate, "science-deextinction-feasibility-candidate-invalid");
    exactKeys(candidate, ["candidateId", "taxonName", "label", "evidence"], "science-deextinction-feasibility-candidate-unknown-field");
    if (!Array.isArray(candidate.evidence)) fail("science-deextinction-feasibility-evidence-invalid");
    for (const rawEvidence of candidate.evidence) {
      const evidence = record(rawEvidence, "science-deextinction-feasibility-evidence-invalid");
      exactKeys(evidence, [
        "criterionId", "evidenceStatus", "finding", "detail", "sourceRunIds",
      ], "science-deextinction-feasibility-evidence-unknown-field");
    }
  }
}

function runtime(): PaleontologyRuntime {
  const loaded = loadSciencePluginRuntime<Partial<PaleontologyRuntime>>(
    "agentlas-paleontology",
    "runtime/paleontology.cjs",
    4 * 1024 * 1024,
  ).runtime;
  if (loaded.PLUGIN_VERSION !== "0.2.0"
    || typeof loaded.stableStringify !== "function"
    || typeof loaded.sha256 !== "function"
    || typeof loaded.assessDeextinctionFeasibility !== "function") {
    fail("science-deextinction-feasibility-runtime-invalid");
  }
  return loaded as PaleontologyRuntime;
}

function verifyAssessment(engine: PaleontologyRuntime, value: DeextinctionFeasibilityRecord): DeextinctionFeasibilityRecord {
  if (value.schema !== "agentlas.paleontology-deextinction-feasibility/v1"
    || value.methodRevision !== "fixed-evidence-gate-audit/v1"
    || !Array.isArray(value.candidates) || value.candidates.length < 2
    || !value.publicationTable || !value.spec
    || value.contentReceipts?.publicationTable?.mimeType !== "application/vnd.agentlas.science-table+json"
    || value.contentReceipts?.figure?.mimeType !== "application/vnd.vega.v5+json"
    || value.evidenceBoundary?.biologicalFeasibilityScoreEmitted !== false
    || value.evidenceBoundary.pbdbFossilCoverageBiologicalFeasibilityContribution !== 0
    || !Array.isArray(value.evidenceBoundary.prohibitedClaims)
    || !REQUIRED_PROHIBITED_CLAIMS.every((claim) => value.evidenceBoundary.prohibitedClaims.includes(claim))) {
    fail("science-deextinction-feasibility-result-invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.deterministicHash)
    || value.contentReceipts.publicationTable.sha256 !== engine.sha256(engine.stableStringify(value.publicationTable))
    || value.contentReceipts.figure.sha256 !== engine.sha256(engine.stableStringify(value.spec))) {
    fail("science-deextinction-feasibility-content-receipt-invalid");
  }
  const { deterministicHash, ...core } = value;
  if (deterministicHash !== engine.sha256(engine.stableStringify(core))) {
    fail("science-deextinction-feasibility-hash-invalid");
  }
  if (value.candidates.some((candidate) => ![
    "stopped",
    "evidence-gates-satisfied-pending-expert-review",
    "not-assessed-different-objective",
  ].includes(candidate.biologicalGateDecision))) {
    fail("science-deextinction-feasibility-claim-boundary-invalid");
  }
  return value;
}

function orderedSourceRunIds(assessment: DeextinctionFeasibilityRecord): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of assessment.candidates) {
    for (const evidence of candidate.evidenceRows) {
      if (!Array.isArray(evidence.sourceRunIds)) fail("science-deextinction-feasibility-source-runs-invalid");
      for (const runId of evidence.sourceRunIds) {
        if (typeof runId !== "string" || !runId || seen.has(runId)) continue;
        seen.add(runId);
        ids.push(runId);
      }
    }
  }
  if (ids.length < 1 || ids.length > 100) fail("science-deextinction-feasibility-source-runs-invalid");
  return ids;
}

function sealParents(store: ScienceStore, projectId: string, sourceRunIds: string[]): SealedParent[] {
  return sourceRunIds.map((runId) => {
    const run = store.getResearchRunForProject(projectId, runId);
    if (!run || run.status !== "succeeded"
      || !ALLOWED_SOURCE_TOOLS.has(`${run.toolId}@${run.toolVersion}`)
      || run.outputs.length < 1) {
      fail("science-deextinction-feasibility-parent-run-invalid");
    }
    const outputs = run.outputs.map((output, index) => {
      if (output.runId !== run.id || output.ordinal !== index + 1) {
        fail("science-deextinction-feasibility-parent-output-invalid");
      }
      const bytes = store.readRunBlob(output);
      if (bytes.length !== output.byteSize || sha256(bytes) !== output.sha256) {
        fail("science-deextinction-feasibility-parent-output-closure-invalid");
      }
      return {
        ordinal: output.ordinal,
        role: output.role,
        mimeType: output.mimeType,
        byteSize: output.byteSize,
        sha256: output.sha256,
      };
    });
    return { run, contentSha256: scienceEvidenceGraphResearchRunContentSha256(run), outputs };
  });
}

function verifyCriterionSourcePolicy(store: ScienceStore, assessment: DeextinctionFeasibilityRecord, parents: SealedParent[]): void {
  const parentById = new Map(parents.map((parent) => [parent.run.id, parent]));
  const isReferenceAssemblyManifest = (parent: SealedParent): boolean => {
    const rawCount = parent.outputs.length - 2;
    if (`${parent.run.toolId}@${parent.run.toolVersion}` !== EXTANT_REFERENCE_ASSEMBLY_MANIFEST_TOOL
      || rawCount < 9 || (rawCount - 1) % 4 !== 0
      || parent.outputs[0]?.role !== "ensembl-release-response"
      || parent.outputs[rawCount]?.role !== "extant-reference-assembly-assessment"
      || parent.outputs[rawCount + 1]?.role !== "extant-reference-assembly-publication-table") return false;
    const speciesCount = (rawCount - 1) / 4;
    const roleShapeValid = Array.from({ length: speciesCount }, (_, index) => index).every((index) => {
      const roles = parent.outputs.slice(1 + index * 4, 5 + index * 4).map((output) => output.role);
      const names = roles.map((role) => role.split(":", 2)[1]);
      return roles[0]?.startsWith("ensembl-genome-metadata:")
        && roles[1]?.startsWith("ensembl-assembly-metadata:")
        && roles[2]?.startsWith("ensembl-fasta-readme:")
        && roles[3]?.startsWith("ensembl-fasta-checksums:")
        && names.every((name) => name === names[0]);
    });
    const sourceBindings = store.getResearchRunSourceBindings(parent.run.projectId, parent.run.id);
    const outputBindings = store.getResearchRunSourceOutputBindings(parent.run.projectId, parent.run.id);
    return Boolean(roleShapeValid && sourceBindings.length === rawCount && outputBindings.length === rawCount
      && sourceBindings.every((binding, index) => binding.ordinal === index + 1
        && outputBindings[index]?.outputOrdinal === index + 1
        && binding.contentSha256 === outputBindings[index]?.outputSha256));
  };
  const isHypotheticalAsr = (parent: SealedParent): boolean => {
    if (`${parent.run.toolId}@${parent.run.toolVersion}` !== HYPOTHETICAL_ASR_EVIDENCE_TOOL
      || parent.outputs.length !== 3
      || parent.outputs[0]?.role !== "hypothetical-ancestral-state-ambiguity-sets"
      || parent.outputs[1]?.role !== "hypothetical-asr-site-table"
      || parent.outputs[2]?.role !== "hypothetical-asr-ambiguity-figure") return false;
    const binding = store.getRunArtifactBinding(parent.run.projectId, parent.run.id);
    const artifact = binding ? store.getArtifactContextForProject(parent.run.projectId, binding.artifactId, binding.artifactVersion) : null;
    return Boolean(binding?.outputOrdinal === 1 && binding.outputSha256 === parent.outputs[0]?.sha256
      && artifact?.artifact.kind === "chart.vega" && artifact.selectedVersion.rendererId === "agentlas.vega"
      && artifact.selectedVersion.payload.evidenceBoundary
      && (artifact.selectedVersion.payload.evidenceBoundary as JsonRecord).publicationGrade === false);
  };
  for (const candidate of assessment.candidates) {
    for (const evidence of candidate.evidenceRows) {
      if (BIOLOGICAL_GATE_CRITERIA.has(evidence.criterionId)
        && evidence.evidenceStatus === "observed" && evidence.finding === "supports") {
        // No installed producer proves authenticated dinosaur DNA, a target
        // genome/karyotype, a viable target cell, or an avian hatching path.
        fail("science-deextinction-feasibility-biological-evidence-unverified");
      }
      const sourceTools = evidence.sourceRunIds.map((runId) => {
        const parent = parentById.get(runId);
        if (!parent) fail("science-deextinction-feasibility-source-binding-missing");
        return `${parent.run.toolId}@${parent.run.toolVersion}`;
      });
      if (evidence.criterionId === "pbdb-fossil-occurrence-coverage"
        && (sourceTools.length < 1 || sourceTools.some((tool) => !PBDB_EVIDENCE_TOOLS.has(tool)))) {
        fail("science-deextinction-feasibility-pbdb-evidence-invalid");
      }
      if (evidence.criterionId === "version-pinned-extant-relative-genomes"
        && sourceTools.some((tool) => !EXTANT_GENOME_EVIDENCE_TOOLS.has(tool))) {
        fail("science-deextinction-feasibility-extant-genome-evidence-invalid");
      }
      if (evidence.criterionId === "version-pinned-extant-relative-genomes"
        && evidence.finding === "supports") {
        if (evidence.evidenceStatus !== "observed" || sourceTools.length < 1
          || evidence.sourceRunIds.some((runId) => {
            const parent = parentById.get(runId);
            return !parent || !isReferenceAssemblyManifest(parent);
          })) {
          // Regional variant tracks and individual structure records cannot
          // substitute for an accession- and asset-pinned reference manifest.
          fail("science-deextinction-feasibility-extant-genome-evidence-insufficient");
        }
      }
      if (evidence.criterionId === "orthology-alignment-species-tree") {
        if (sourceTools.length < 1 || sourceTools.some((tool) => !COMPARATIVE_GENE_TREE_EVIDENCE_TOOLS.has(tool))
          || evidence.evidenceStatus !== "inferred") {
          fail("science-deextinction-feasibility-comparative-tree-evidence-invalid");
        }
      }
      if (evidence.criterionId === "ancestral-state-uncertainty" && evidence.evidenceStatus !== "missing") {
        if (evidence.evidenceStatus !== "hypothetical" || evidence.finding !== "inconclusive" || evidence.sourceRunIds.length < 1
          || evidence.sourceRunIds.some((runId) => {
            const parent = parentById.get(runId);
            return !parent || !isHypotheticalAsr(parent);
          })) {
          fail("science-deextinction-feasibility-ancestral-state-evidence-invalid");
        }
      }
      if (evidence.criterionId === "regulatory-chromosomal-research-model" && evidence.evidenceStatus !== "missing") {
        // No installed producer supplies regulatory architecture or chromosome reconstruction.
        fail("science-deextinction-feasibility-downstream-model-evidence-unavailable");
      }
    }
  }
}

function parentBindings(parents: SealedParent[]): ScienceResearchRunParentBindingInput[] {
  return parents.map((parent, index) => ({
    ordinal: index + 1,
    role: index === 0 ? "primary" : `evidence-source-${String(index + 1).padStart(3, "0")}`,
    parentRunId: parent.run.id,
  }));
}

export class ScienceDeextinctionFeasibilityService {
  constructor(private readonly store: ScienceStore) {}

  assessDeextinctionFeasibility(input: DeextinctionFeasibilityInput): DeextinctionFeasibilityResult {
    assertScoreFreeInput(input);
    const engine = runtime();
    const assessment = verifyAssessment(engine, engine.assessDeextinctionFeasibility({
      title: input.title,
      targetObjective: input.targetObjective,
      candidates: input.candidates,
    }));
    const normalizedCandidates: DeextinctionCandidateInput[] = assessment.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        taxonName: candidate.taxonName,
        label: candidate.label,
        evidence: candidate.evidenceRows.map((evidence) => ({
          criterionId: evidence.criterionId,
          evidenceStatus: evidence.evidenceStatus,
          finding: evidence.finding,
          detail: evidence.detail,
          sourceRunIds: evidence.sourceRunIds,
        })),
      }));
    const sourceRunIds = orderedSourceRunIds(assessment);
    const parents = sealParents(this.store, input.projectId, sourceRunIds);
    verifyCriterionSourcePolicy(this.store, assessment, parents);
    const bindings = parentBindings(parents);
    const descriptor = {
      schema: "agentlas.science-deextinction-feasibility-input/v1",
      title: assessment.title,
      targetObjective: assessment.targetObjective,
      candidates: normalizedCandidates,
      sourceRuns: parents.map((parent) => ({
        runId: parent.run.id,
        toolId: parent.run.toolId,
        toolVersion: parent.run.toolVersion,
        contentSha256: parent.contentSha256,
        outputs: parent.outputs,
      })),
    };
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const inputs = [{
      role: "deextinction-feasibility-input",
      mimeType: "application/vnd.agentlas.science.deextinction-feasibility-input+json",
      ...descriptorBlob,
      artifactId: null,
      artifactVersion: null,
    }];
    const environmentSha256 = sha256(canonicalJson({
      policy: "sealed-multi-parent-fixed-evidence-gate-audit-v1",
      plugin: `agentlas-paleontology@${engine.PLUGIN_VERSION}`,
      methodRevision: assessment.methodRevision,
      allowedSourceTools: [...ALLOWED_SOURCE_TOOLS].sort(),
      runtime: process.version,
    }));
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      parentRunId: parents[0]!.run.id,
      parentBindings: bindings,
      toolId: DEEXTINCTION_FEASIBILITY_TOOL_ID,
      toolVersion: DEEXTINCTION_FEASIBILITY_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs)),
      environmentSha256,
      inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    this.verifyParentBindings(input.projectId, run.id, parents, bindings);

    if (created.replayed && run.status === "succeeded") {
      const replayed = this.verifyOutputs(engine, run, assessment);
      const payload = this.artifactPayload(replayed.assessment, parents, run.id, replayed.tableSha256, replayed.figureSha256);
      const artifact = this.artifactForRun(input.projectId, run.id, payload);
      return {
        schema: DEEXTINCTION_FEASIBILITY_RESULT_SCHEMA,
        toolId: DEEXTINCTION_FEASIBILITY_TOOL_ID,
        runId: run.id,
        parentRunIds: sourceRunIds,
        title: assessment.title,
        assessment: replayed.assessment,
        artifact,
        replayed: true,
      };
    }
    if (run.status !== "running") fail(`science-deextinction-feasibility-run-${run.status}`);

    try {
      const assessmentBlob = this.store.putRunBlob(Buffer.from(canonicalJson(assessment), "utf8"));
      const tableBlob = this.store.putRunBlob(Buffer.from(engine.stableStringify(assessment.publicationTable), "utf8"));
      const figureBlob = this.store.putRunBlob(Buffer.from(engine.stableStringify(assessment.spec), "utf8"));
      if (tableBlob.sha256 !== assessment.contentReceipts.publicationTable.sha256
        || figureBlob.sha256 !== assessment.contentReceipts.figure.sha256) {
        fail("science-deextinction-feasibility-output-receipt-invalid");
      }
      const outputs = [
        { role: "deextinction-feasibility-assessment", mimeType: "application/vnd.agentlas.paleontology-deextinction-feasibility+json", ...assessmentBlob, artifactId: null, artifactVersion: null },
        { role: "deextinction-feasibility-publication-table", mimeType: "application/vnd.agentlas.science-table+json", ...tableBlob, artifactId: null, artifactVersion: null },
        { role: "deextinction-feasibility-figure", mimeType: "application/vnd.vega.v5+json", ...figureBlob, artifactId: null, artifactVersion: null },
      ];
      const stopped = assessment.candidates.filter((candidate) => candidate.biologicalGateDecision === "stopped").length;
      const summary = assessment.targetObjective === "actual-biological-revival"
        ? `${assessment.candidates.length} candidates audited; ${stopped} stopped by biological evidence gates. No viability, genome, embryo, hatching, or revival claim was produced.`
        : `${assessment.candidates.length} candidates audited for comparative proxy researchability; biological revival was not assessed.`;
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`),
        projectId: input.projectId,
        runId: run.id,
        status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)),
        summary,
        outputs,
      }).run;
      this.verifyParentBindings(input.projectId, run.id, parents, bindings);
      const payload = this.artifactPayload(assessment, parents, run.id, tableBlob.sha256, figureBlob.sha256);
      const artifact = this.store.createArtifact({
        projectId: input.projectId,
        sourceRunId: run.id,
        kind: "chart.vega",
        title: assessment.title,
        rendererId: "agentlas.vega",
        rendererVersion: "6.4.0",
        rendererBinding: null,
        payload,
        semantic: {
          title: assessment.title,
          summary,
          entities: assessment.candidates.map((candidate) => ({ id: candidate.candidateId, label: candidate.label, type: "deextinction-audit-candidate" })),
          observations: [
            { label: "Candidates audited", value: assessment.candidates.length, unit: "count" },
            { label: "Candidates stopped", value: stopped, unit: "count" },
            { label: "Biological-feasibility scores emitted", value: 0, unit: "count" },
          ],
          warnings: [...assessment.warnings, ...assessment.assumptions],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: parents.map((parent) => `research-run:${parent.run.id}`),
          datasetSha256: [
            ...parents.map((parent) => parent.contentSha256),
            ...parents.flatMap((parent) => parent.outputs.map((output) => output.sha256)),
            assessment.deterministicHash,
            tableBlob.sha256,
            figureBlob.sha256,
          ],
          codeSha256: sha256(`${DEEXTINCTION_FEASIBILITY_TOOL_ID}@${DEEXTINCTION_FEASIBILITY_TOOL_VERSION}:${assessment.methodRevision}:agentlas-paleontology@${engine.PLUGIN_VERSION}`),
          environmentSha256,
        },
        linkage: {
          labId: DEEXTINCTION_FEASIBILITY_LAB_ID,
          origin: { surface: "conversation", conversationId: input.conversationId, messageId: input.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
          parent: null,
          inputs: [],
        },
      });
      this.store.bindSucceededRunArtifact({
        requestId: stableUuid(`science-deextinction-feasibility-run-artifact-binding:v1:${input.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
        projectId: input.projectId,
        runId: run.id,
        outputOrdinal: 1,
        artifactId: artifact.id,
        artifactVersion: artifact.currentVersion,
        expectedArtifactContentSha256: artifact.version.contentSha256,
      });
      return {
        schema: DEEXTINCTION_FEASIBILITY_RESULT_SCHEMA,
        toolId: DEEXTINCTION_FEASIBILITY_TOOL_ID,
        runId: run.id,
        parentRunIds: sourceRunIds,
        title: assessment.title,
        assessment,
        artifact,
        replayed: false,
      };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        this.store.completeResearchRun({
          requestId: stableUuid(`${input.requestId}:failed`),
          projectId: input.projectId,
          runId: run.id,
          status: "failed",
          outputManifestSha256: sha256(canonicalJson([])),
          summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-deextinction-feasibility-failed",
          outputs: [],
        });
      }
      throw error;
    }
  }

  private verifyParentBindings(
    projectId: string,
    runId: string,
    parents: SealedParent[],
    expected: ScienceResearchRunParentBindingInput[],
  ): void {
    const actual = this.store.getResearchRunParentBindings(projectId, runId);
    if (actual.length !== expected.length || actual.some((binding, index) => {
      const parent = parents[index]!;
      const wanted = expected[index]!;
      return binding.ordinal !== wanted.ordinal || binding.role !== wanted.role
        || binding.parentRunId !== wanted.parentRunId || binding.parentContentSha256 !== parent.contentSha256;
    })) {
      fail("science-deextinction-feasibility-parent-binding-integrity-failed");
    }
  }

  private verifyOutputs(
    engine: PaleontologyRuntime,
    run: ResearchRun,
    expected: DeextinctionFeasibilityRecord,
  ): { assessment: DeextinctionFeasibilityRecord; tableSha256: string; figureSha256: string } {
    if (run.outputs.length !== 3) fail("science-deextinction-feasibility-replay-output-invalid");
    if (run.outputs.some((output, index) => output.ordinal !== index + 1 || output.runId !== run.id)) {
      fail("science-deextinction-feasibility-replay-output-invalid");
    }
    const assessmentOutput = run.outputs.find((output) => output.role === "deextinction-feasibility-assessment"
      && output.mimeType === "application/vnd.agentlas.paleontology-deextinction-feasibility+json");
    const tableOutput = run.outputs.find((output) => output.role === "deextinction-feasibility-publication-table"
      && output.mimeType === "application/vnd.agentlas.science-table+json");
    const figureOutput = run.outputs.find((output) => output.role === "deextinction-feasibility-figure"
      && output.mimeType === "application/vnd.vega.v5+json");
    if (!assessmentOutput || !tableOutput || !figureOutput) fail("science-deextinction-feasibility-replay-output-invalid");
    let replayed: DeextinctionFeasibilityRecord;
    let table: unknown;
    let figure: unknown;
    try {
      replayed = verifyAssessment(engine, JSON.parse(this.store.readRunBlob(assessmentOutput).toString("utf8")) as DeextinctionFeasibilityRecord);
      table = JSON.parse(this.store.readRunBlob(tableOutput).toString("utf8"));
      figure = JSON.parse(this.store.readRunBlob(figureOutput).toString("utf8"));
    } catch {
      return fail("science-deextinction-feasibility-replay-output-invalid");
    }
    if (sha256(canonicalJson(replayed)) !== sha256(canonicalJson(expected))
      || engine.sha256(engine.stableStringify(table)) !== replayed.contentReceipts.publicationTable.sha256
      || engine.sha256(engine.stableStringify(figure)) !== replayed.contentReceipts.figure.sha256
      || tableOutput.sha256 !== replayed.contentReceipts.publicationTable.sha256
      || figureOutput.sha256 !== replayed.contentReceipts.figure.sha256) {
      fail("science-deextinction-feasibility-replay-output-invalid");
    }
    return { assessment: replayed, tableSha256: tableOutput.sha256, figureSha256: figureOutput.sha256 };
  }

  private artifactPayload(
    assessment: DeextinctionFeasibilityRecord,
    parents: SealedParent[],
    runId: string,
    publicationTableSha256: string,
    figureSha256: string,
  ): JsonRecord {
    return {
      schema: DEEXTINCTION_FEASIBILITY_ARTIFACT_SCHEMA,
      assessment,
      spec: assessment.spec,
      source: {
        runId,
        sourceRuns: parents.map((parent) => ({
          runId: parent.run.id,
          toolId: parent.run.toolId,
          toolVersion: parent.run.toolVersion,
          contentSha256: parent.contentSha256,
          outputSha256: parent.outputs.map((output) => output.sha256),
        })),
        assessmentSha256: assessment.deterministicHash,
        publicationTableSha256,
        figureSha256,
        evidenceClass: "deextinction-evidence-gate-audit",
        biologicalFeasibilityScoreEmitted: false,
      },
    };
  }

  private artifactForRun(projectId: string, runId: string, expectedPayload: JsonRecord): ScienceArtifact {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, DEEXTINCTION_FEASIBILITY_LAB_ID);
    if (!artifact) fail("science-deextinction-feasibility-replay-artifact-missing");
    const context = this.store.getArtifactContextForProject(projectId, artifact.id, artifact.currentVersion);
    if (!context || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega"
      || artifact.version.payload.schema !== DEEXTINCTION_FEASIBILITY_ARTIFACT_SCHEMA
      || artifact.sourceRunId !== runId || context.linkage.labId !== DEEXTINCTION_FEASIBILITY_LAB_ID
      || sha256(canonicalJson(artifact.version.payload)) !== sha256(canonicalJson(expectedPayload))) {
      fail("science-deextinction-feasibility-replay-artifact-invalid");
    }
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-deextinction-feasibility-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId,
      runId,
      outputOrdinal: 1,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }
}

export function deextinctionFeasibilityToolSummary(result: DeextinctionFeasibilityResult): JsonRecord {
  return {
    targetObjective: result.assessment.targetObjective,
    parentRunIds: result.parentRunIds,
    candidateCount: result.assessment.candidates.length,
    decisions: result.assessment.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      decision: candidate.biologicalGateDecision,
    })),
    publicationTable: {
      contentSha256: result.assessment.contentReceipts.publicationTable.sha256,
    },
    figure: {
      schema: "application/vnd.vega.v5+json",
      contentSha256: result.assessment.contentReceipts.figure.sha256,
    },
    evidenceBoundary: result.assessment.evidenceBoundary,
    warnings: result.assessment.warnings,
    assumptions: result.assessment.assumptions,
  };
}
