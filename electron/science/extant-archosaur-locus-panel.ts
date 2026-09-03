import { createHash } from "node:crypto";
import type {
  ScienceArtifact,
  ScienceResearchRun,
  ScienceResearchRunResource,
} from "../../shared/science-contract";
import {
  createScienceExtantArchosaurLocusPanelArtifactLineage,
  createScienceExtantArchosaurLocusPanelAnalysis,
  createScienceExtantArchosaurLocusPanelOutputLineage,
  createScienceExtantArchosaurLocusPanelParentLineage,
  normalizeScienceExtantArchosaurLocusPanelInputDescriptor,
  scienceExtantArchosaurLocusPanelCanonicalJson,
  scienceExtantArchosaurLocusPanelSha256,
  type ScienceExtantArchosaurLocusPanelAnalysis,
  type ScienceExtantArchosaurLocusPanelArtifactLineage,
  type ScienceExtantArchosaurLocusPanelInputDescriptor,
  type ScienceExtantArchosaurLocusPanelOutputLineage,
  type ScienceExtantArchosaurLocusPanelParentLineage,
  type ScienceExtantArchosaurLocusPanelResult,
} from "../../shared/science-extant-archosaur-locus-panel";
import { loadSciencePluginRuntime } from "./plugin-runtime";
import { ScienceStore, scienceEvidenceGraphResearchRunContentSha256 } from "./store";
import {
  COMPARATIVE_GENOMICS_TOOL_ID,
  COMPARATIVE_GENOMICS_TOOL_VERSION,
} from "./comparative-genomics";
import {
  EXTANT_REFERENCE_ASSEMBLY_TOOL_ID,
  EXTANT_REFERENCE_ASSEMBLY_TOOL_VERSION,
} from "./extant-reference-assemblies";

export const EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID = "agentlas.materialize-extant-archosaur-locus-panel" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION = "1.0.0" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_LAB_ID = "comparative-genomics" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_RESULT_SCHEMA = "agentlas.science-extant-archosaur-locus-panel-result/v1" as const;

const INPUT_ROLE = "extant-archosaur-locus-panel-request";
const INPUT_MIME = "application/vnd.agentlas.science.extant-archosaur-locus-panel-input+json";
const GENE_TREE_ASSESSMENT_ROLE = "comparative-genomics-assessment-source";
const GENE_TREE_ASSESSMENT_MIME = "application/vnd.agentlas.comparative-genomics-gene-tree+json";
const ASSEMBLY_ASSESSMENT_ROLE = "reference-assembly-manifest-source";
const ASSEMBLY_ASSESSMENT_MIME = "application/vnd.agentlas.extant-reference-assembly-manifest+json";

type JsonRecord = Record<string, unknown>;

type ExtantArchosaurRuntime = {
  ENGINE_VERSION: string;
  REQUEST_SCHEMA: string;
  RESULT_SCHEMA: string;
  materializeExtantArchosaurLocusPanel(input: JsonRecord): JsonRecord;
};

type VerifiedParent = {
  run: ScienceResearchRun;
  assessment: JsonRecord;
  assessmentBytes: Buffer;
  assessmentOutput: ScienceResearchRunResource;
  contentSha256: string;
};

type PureResult = JsonRecord & {
  decision: JsonRecord;
  selection: JsonRecord;
  analysis: JsonRecord;
  publicationTable: JsonRecord;
  spec: JsonRecord;
  evidenceBoundary: JsonRecord;
  warnings: string[];
};

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return scienceExtantArchosaurLocusPanelCanonicalJson(value);
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || !value || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
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

function parseJson(bytes: Buffer, code: string): JsonRecord {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return record(value, code);
  } catch {
    fail(code);
  }
}

function runtime(): ExtantArchosaurRuntime {
  const loaded = loadSciencePluginRuntime<Partial<ExtantArchosaurRuntime>>(
    "agentlas-comparative-genomics",
    "runtime/extant-archosaur-locus-panel.cjs",
    12 * 1024 * 1024,
  ).runtime;
  if (loaded.ENGINE_VERSION !== "0.1.0"
    || loaded.REQUEST_SCHEMA !== "agentlas.comparative-genomics.extant-archosaur-locus-panel-request/v1"
    || loaded.RESULT_SCHEMA !== "agentlas.comparative-genomics.extant-archosaur-locus-panel-result/v1"
    || typeof loaded.materializeExtantArchosaurLocusPanel !== "function") {
    fail("science-extant-archosaur-locus-panel-runtime-invalid");
  }
  return loaded as ExtantArchosaurRuntime;
}

function verifyManifest(run: ScienceResearchRun, store: ScienceStore, expectedInputCount: number, expectedOutputCount: number): void {
  if (run.inputs.length !== expectedInputCount || run.outputs.length !== expectedOutputCount
    || sha256(canonicalJson(run.inputs.map(resourceEnvelope))) !== run.inputManifestSha256
    || sha256(canonicalJson(run.outputs.map(resourceEnvelope))) !== run.outputManifestSha256) {
    fail("science-extant-archosaur-locus-panel-parent-manifest-invalid");
  }
  [...run.inputs, ...run.outputs].forEach((resource) => store.readRunBlob(resource));
}

function verifyGeneTreeParent(store: ScienceStore, projectId: string, runId: string): VerifiedParent {
  const run = store.getResearchRunForProject(projectId, runId);
  if (!run || run.status !== "succeeded" || run.toolId !== COMPARATIVE_GENOMICS_TOOL_ID
    || run.toolVersion !== COMPARATIVE_GENOMICS_TOOL_VERSION || run.parentRunId !== null) {
    fail("science-extant-archosaur-locus-panel-gene-tree-parent-invalid");
  }
  verifyManifest(run, store, 1, 5);
  const expected = [
    ["ensembl-release-response", "application/json"],
    ["ensembl-compara-gene-tree-response", "application/json"],
    ["comparative-genomics-assessment", GENE_TREE_ASSESSMENT_MIME],
    ["alignment-qc-publication-table", "application/vnd.agentlas.science-table+json"],
    ["comparative-gene-tree-figure", "application/vnd.vega.v5+json"],
  ] as const;
  run.outputs.forEach((output, index) => {
    const contract = expected[index]!;
    if (output.ordinal !== index + 1 || output.role !== contract[0] || output.mimeType !== contract[1]
      || output.artifactId !== null || output.artifactVersion !== null) {
      fail("science-extant-archosaur-locus-panel-gene-tree-parent-output-invalid");
    }
  });
  const assessmentOutput = run.outputs[2]!;
  const assessmentBytes = store.readRunBlob(assessmentOutput);
  const assessment = parseJson(assessmentBytes, "science-extant-archosaur-locus-panel-gene-tree-assessment-invalid");
  const request = record(assessment.request, "science-extant-archosaur-locus-panel-gene-tree-assessment-invalid");
  if (assessment.schema !== "agentlas.comparative-genomics-gene-tree/v1"
    || assessment.provider !== "ensembl-compara" || assessment.rooted !== true
    || request.sequenceType !== "cdna") {
    fail("science-extant-archosaur-locus-panel-gene-tree-assessment-invalid");
  }
  const sourceBindings = store.getResearchRunSourceBindings(projectId, run.id);
  const sourceOutputBindings = store.getResearchRunSourceOutputBindings(projectId, run.id);
  if (sourceBindings.length !== 2 || sourceOutputBindings.length !== 2
    || sourceBindings.some((binding, index) => binding.ordinal !== index + 1
      || sourceOutputBindings[index]?.outputOrdinal !== index + 1
      || binding.contentSha256 !== sourceOutputBindings[index]?.outputSha256)) {
    fail("science-extant-archosaur-locus-panel-gene-tree-source-lineage-invalid");
  }
  return {
    run,
    assessment,
    assessmentBytes,
    assessmentOutput,
    contentSha256: scienceEvidenceGraphResearchRunContentSha256(run),
  };
}

function verifyAssemblyParent(store: ScienceStore, projectId: string, runId: string): VerifiedParent {
  const run = store.getResearchRunForProject(projectId, runId);
  if (!run || run.status !== "succeeded" || run.toolId !== EXTANT_REFERENCE_ASSEMBLY_TOOL_ID
    || run.toolVersion !== EXTANT_REFERENCE_ASSEMBLY_TOOL_VERSION || run.parentRunId !== null) {
    fail("science-extant-archosaur-locus-panel-assembly-parent-invalid");
  }
  const assessmentOutput = run.outputs.find((output) => output.role === "extant-reference-assembly-assessment");
  const tableOutput = run.outputs.find((output) => output.role === "extant-reference-assembly-publication-table");
  if (!assessmentOutput || !tableOutput || assessmentOutput.mimeType !== ASSEMBLY_ASSESSMENT_MIME
    || tableOutput.mimeType !== "application/vnd.agentlas.science-table+json"
    || assessmentOutput.artifactId !== null || assessmentOutput.artifactVersion !== null
    || tableOutput.artifactId !== null || tableOutput.artifactVersion !== null) {
    fail("science-extant-archosaur-locus-panel-assembly-parent-output-invalid");
  }
  const rawCount = run.outputs.length - 2;
  if (rawCount < 9 || (rawCount - 1) % 4 !== 0 || assessmentOutput.ordinal !== rawCount + 1 || tableOutput.ordinal !== rawCount + 2) {
    fail("science-extant-archosaur-locus-panel-assembly-parent-output-invalid");
  }
  verifyManifest(run, store, 1, rawCount + 2);
  const assessmentBytes = store.readRunBlob(assessmentOutput);
  const assessment = parseJson(assessmentBytes, "science-extant-archosaur-locus-panel-assembly-assessment-invalid");
  if (assessment.schema !== "agentlas.extant-reference-assembly-manifest/v1" || assessment.provider !== "ensembl"
    || !Array.isArray(assessment.assemblies) || !Array.isArray(assessment.providerRelease)) {
    fail("science-extant-archosaur-locus-panel-assembly-assessment-invalid");
  }
  const sourceBindings = store.getResearchRunSourceBindings(projectId, run.id);
  const sourceOutputBindings = store.getResearchRunSourceOutputBindings(projectId, run.id);
  if (sourceBindings.length !== rawCount || sourceOutputBindings.length !== rawCount
    || sourceBindings.some((binding, index) => binding.ordinal !== index + 1
      || sourceOutputBindings[index]?.outputOrdinal !== index + 1
      || binding.contentSha256 !== sourceOutputBindings[index]?.outputSha256)) {
    fail("science-extant-archosaur-locus-panel-assembly-source-lineage-invalid");
  }
  return {
    run,
    assessment,
    assessmentBytes,
    assessmentOutput,
    contentSha256: scienceEvidenceGraphResearchRunContentSha256(run),
  };
}

function parentLineage(geneTree: VerifiedParent, assembly: VerifiedParent): ScienceExtantArchosaurLocusPanelParentLineage {
  return createScienceExtantArchosaurLocusPanelParentLineage({
    schema: "agentlas.science.extant-archosaur-locus-panel-parent-lineage/v1",
    geneTree: {
      ordinal: 1,
      role: "primary",
      runId: geneTree.run.id,
      toolId: COMPARATIVE_GENOMICS_TOOL_ID,
      toolVersion: COMPARATIVE_GENOMICS_TOOL_VERSION,
      runContentSha256: geneTree.contentSha256,
      inputManifestSha256: geneTree.run.inputManifestSha256,
      outputManifestSha256: geneTree.run.outputManifestSha256!,
      environmentSha256: geneTree.run.environmentSha256,
      assessmentOutput: {
        ordinal: geneTree.assessmentOutput.ordinal,
        role: geneTree.assessmentOutput.role,
        mimeType: geneTree.assessmentOutput.mimeType,
        sha256: geneTree.assessmentOutput.sha256,
      },
    },
    referenceAssembly: {
      ordinal: 2,
      role: "reference-assembly-manifest",
      runId: assembly.run.id,
      toolId: EXTANT_REFERENCE_ASSEMBLY_TOOL_ID,
      toolVersion: EXTANT_REFERENCE_ASSEMBLY_TOOL_VERSION,
      runContentSha256: assembly.contentSha256,
      inputManifestSha256: assembly.run.inputManifestSha256,
      outputManifestSha256: assembly.run.outputManifestSha256!,
      environmentSha256: assembly.run.environmentSha256,
      assessmentOutput: {
        ordinal: assembly.assessmentOutput.ordinal,
        role: assembly.assessmentOutput.role,
        mimeType: assembly.assessmentOutput.mimeType,
        sha256: assembly.assessmentOutput.sha256,
      },
    },
  });
}

function toSharedAnalysis(
  pure: PureResult,
  geneTree: VerifiedParent,
  assembly: VerifiedParent,
  parents: ScienceExtantArchosaurLocusPanelParentLineage,
): ScienceExtantArchosaurLocusPanelAnalysis {
  const pureAnalysis = record(pure.analysis, "science-extant-archosaur-locus-panel-result-invalid");
  const locus = record(pureAnalysis.locus, "science-extant-archosaur-locus-panel-result-invalid");
  const mrca = record(pureAnalysis.mrca, "science-extant-archosaur-locus-panel-result-invalid");
  const inducedPath = record(pureAnalysis.inducedPath, "science-extant-archosaur-locus-panel-result-invalid");
  const selection = record(pure.selection, "science-extant-archosaur-locus-panel-result-invalid");
  const decision = record(pure.decision, "science-extant-archosaur-locus-panel-result-invalid");
  const leafQc = Array.isArray(pureAnalysis.leafQc) ? pureAnalysis.leafQc : fail("science-extant-archosaur-locus-panel-result-invalid");
  const siteBins = Array.isArray(pureAnalysis.siteBins) ? pureAnalysis.siteBins : fail("science-extant-archosaur-locus-panel-result-invalid");
  const parentAssessmentLeaves = Array.isArray(geneTree.assessment.leaves) ? geneTree.assessment.leaves : fail("science-extant-archosaur-locus-panel-result-invalid");
  const assemblies = Array.isArray(assembly.assessment.assemblies) ? assembly.assessment.assemblies : fail("science-extant-archosaur-locus-panel-result-invalid");
  const leafById = new Map(parentAssessmentLeaves.map((item) => {
    const leaf = record(item, "science-extant-archosaur-locus-panel-result-invalid");
    return [String(leaf.nodeId), leaf] as const;
  }));
  const assemblyByTaxonomy = new Map<number, JsonRecord>();
  assemblies.forEach((item) => {
    const candidate = record(item, "science-extant-archosaur-locus-panel-result-invalid");
    const taxonomyId = Number(candidate.taxonomyId);
    if (Number.isSafeInteger(taxonomyId) && !assemblyByTaxonomy.has(taxonomyId)) assemblyByTaxonomy.set(taxonomyId, candidate);
  });
  const selectedIds = [
    ...(Array.isArray(selection.avianLeafNodeIds) ? selection.avianLeafNodeIds : []),
    ...(Array.isArray(selection.crocodilianLeafNodeIds) ? selection.crocodilianLeafNodeIds : []),
  ].map(String);
  const members = leafQc.map((raw) => {
    const qc = record(raw, "science-extant-archosaur-locus-panel-result-invalid");
    const nodeId = text(qc.leafNodeId, "science-extant-archosaur-locus-panel-result-invalid");
    const leaf = leafById.get(nodeId);
    const taxonomyId = Number(qc.taxonomyId);
    const assemblyRecord = assemblyByTaxonomy.get(taxonomyId);
    if (!leaf || !assemblyRecord || !selectedIds.includes(nodeId) || typeof leaf.alignedSequence !== "string") {
      fail("science-extant-archosaur-locus-panel-result-lineage-invalid");
    }
    return {
      group: qc.group === "avian" ? "avian" as const : qc.group === "crocodilian" ? "crocodilian" as const : fail("science-extant-archosaur-locus-panel-result-invalid"),
      nodeId,
      taxonomyId,
      scientificName: text(qc.scientificName, "science-extant-archosaur-locus-panel-result-invalid"),
      geneId: text(qc.geneId, "science-extant-archosaur-locus-panel-result-invalid"),
      assemblyName: text(assemblyRecord.assemblyName, "science-extant-archosaur-locus-panel-result-invalid"),
      assemblyAccession: text(assemblyRecord.assemblyAccession, "science-extant-archosaur-locus-panel-result-invalid"),
      ensemblRelease: Number(assemblyRecord.ensemblRelease),
      alignedSequenceSha256: sha256(leaf.alignedSequence),
      alignmentLength: Number(locus.alignmentLength),
      residueCount: Number(qc.residueCount),
      gapFraction: Number(qc.gapFraction),
      missingFraction: Number(qc.missingFraction),
    };
  });
  if (members.length !== selectedIds.length) fail("science-extant-archosaur-locus-panel-result-member-count-invalid");
  const positionBins = siteBins.map((raw, index) => {
    const bin = record(raw, "science-extant-archosaur-locus-panel-result-invalid");
    const comparedColumnCount = Number(bin.crossGroupCallableSiteCount);
    const differingColumnCount = Number(bin.lineageDistinctObservedStateSiteCount);
    return {
      ordinal: index + 1,
      startColumn: Number(bin.startSite),
      endColumn: Number(bin.endSite),
      comparedColumnCount,
      differingColumnCount,
      differenceFraction: comparedColumnCount === 0 ? 0 : Number((differingColumnCount / comparedColumnCount).toFixed(6)),
    };
  });
  const withinGroupVariableSiteCount = siteBins.reduce((sum, raw) => {
    const bin = record(raw, "science-extant-archosaur-locus-panel-result-invalid");
    return sum + Number(bin.avianVariableSiteCount) + Number(bin.crocodilianVariableSiteCount);
  }, 0);
  const betweenGroupDifferingSiteCount = siteBins.reduce((sum, raw) => sum + Number(record(raw, "science-extant-archosaur-locus-panel-result-invalid").lineageDistinctObservedStateSiteCount), 0);
  // A site can be invariant within both groups yet differ between groups; the
  // shared diagnostics count any variable site and must therefore dominate the
  // between-group count without double-counting the bounded alignment.
  const variableSiteCount = Math.max(withinGroupVariableSiteCount, betweenGroupDifferingSiteCount);
  const providerRelease = [...new Set([
    ...(Array.isArray(geneTree.assessment.providerRelease) ? geneTree.assessment.providerRelease.map(Number) : []),
    ...(Array.isArray(assembly.assessment.providerRelease) ? assembly.assessment.providerRelease.map(Number) : []),
  ])].filter(Number.isSafeInteger).sort((left, right) => right - left);
  const analysisCore = {
    schema: "agentlas.science.extant-archosaur-locus-panel/v1" as const,
    methodRevision: "extant-archosaur-locus-panel/v1" as const,
    title: text(pure.title, "science-extant-archosaur-locus-panel-result-invalid"),
    status: decision.status as "candidate-for-exploratory-asr" | "review-required" | "blocked",
    source: {
      parentLineageSha256: parents.lineageSha256,
      geneTreeRunId: geneTree.run.id,
      referenceAssemblyRunId: assembly.run.id,
      provider: "ensembl-compara+ensembl" as const,
      providerRelease,
      geneTreeId: text(locus.geneTreeId, "science-extant-archosaur-locus-panel-result-invalid"),
      alignmentSha256: text(locus.alignmentSha256, "science-extant-archosaur-locus-panel-result-invalid"),
    },
    selection: {
      sequenceType: "cdna" as const,
      alignmentLength: Number(locus.alignmentLength),
      avianLeafNodeIds: (Array.isArray(selection.avianLeafNodeIds) ? selection.avianLeafNodeIds : []).map(String).sort((a, b) => a.localeCompare(b, "en")),
      crocodilianLeafNodeIds: (Array.isArray(selection.crocodilianLeafNodeIds) ? selection.crocodilianLeafNodeIds : []).map(String).sort((a, b) => a.localeCompare(b, "en")),
    },
    members,
    positionBins,
    diagnostics: {
      selectedLeafCount: members.length,
      avianLeafCount: members.filter((member) => member.group === "avian").length,
      crocodilianLeafCount: members.filter((member) => member.group === "crocodilian").length,
      alignmentColumnCount: Number(locus.alignmentLength),
      variableSiteCount,
      betweenGroupDifferingSiteCount,
      duplicationNodeCount: Array.isArray(inducedPath.duplicationOrGeneSplitNodeIds) ? inducedPath.duplicationOrGeneSplitNodeIds.length : 0,
      lowSupportNodeCount: Array.isArray(inducedPath.lowSupportNodeIds) ? inducedPath.lowSupportNodeIds.length : 0,
    },
    publicationTable: {
      schema: "agentlas.science-table/v1" as const,
      title: `${text(pure.title, "science-extant-archosaur-locus-panel-result-invalid")}: selected extant lineage QC`,
      columns: [
        { id: "group", label: "Extant group", type: "string" as const, unit: null },
        { id: "scientificName", label: "Extant taxon", type: "string" as const, unit: null },
        { id: "taxonomyId", label: "NCBI taxonomy ID", type: "integer" as const, unit: null },
        { id: "geneId", label: "Ensembl gene ID", type: "string" as const, unit: null },
        { id: "assemblyAccession", label: "Assembly accession", type: "string" as const, unit: null },
        { id: "ensemblRelease", label: "Ensembl release", type: "integer" as const, unit: null },
        { id: "residueCount", label: "Non-gap residues", type: "integer" as const, unit: "nt" },
        { id: "gapFraction", label: "Gap fraction", type: "number" as const, unit: "fraction" },
        { id: "missingFraction", label: "Missing fraction", type: "number" as const, unit: "fraction" },
      ],
      rows: members.map((member) => [member.group, member.scientificName, member.taxonomyId, member.geneId, member.assemblyAccession, member.ensemblRelease, member.residueCount, member.gapFraction, member.missingFraction]),
      notes: [
        "Rows describe caller-selected extant lineages and exact assembly identities only.",
        "The tree and alignment are provider inferences; between-group differences are deterministic derivations from observed extant alignment records.",
        "No ancestral sequence, extinct-species genome, chromosome organization, phenotype, embryo viability, or hatching claim is emitted.",
      ],
    },
    spec: record(pure.spec, "science-extant-archosaur-locus-panel-result-invalid"),
    contentReceipts: {
      publicationTable: { sha256: scienceExtantArchosaurLocusPanelSha256({
        schema: "agentlas.science-table/v1",
        title: `${text(pure.title, "science-extant-archosaur-locus-panel-result-invalid")}: selected extant lineage QC`,
        columns: [
          { id: "group", label: "Extant group", type: "string", unit: null },
          { id: "scientificName", label: "Extant taxon", type: "string", unit: null },
          { id: "taxonomyId", label: "NCBI taxonomy ID", type: "integer", unit: null },
          { id: "geneId", label: "Ensembl gene ID", type: "string", unit: null },
          { id: "assemblyAccession", label: "Assembly accession", type: "string", unit: null },
          { id: "ensemblRelease", label: "Ensembl release", type: "integer", unit: null },
          { id: "residueCount", label: "Non-gap residues", type: "integer", unit: "nt" },
          { id: "gapFraction", label: "Gap fraction", type: "number", unit: "fraction" },
          { id: "missingFraction", label: "Missing fraction", type: "number", unit: "fraction" },
        ],
        rows: members.map((member) => [member.group, member.scientificName, member.taxonomyId, member.geneId, member.assemblyAccession, member.ensemblRelease, member.residueCount, member.gapFraction, member.missingFraction]),
        notes: [
          "Rows describe caller-selected extant lineages and exact assembly identities only.",
          "The tree and alignment are provider inferences; between-group differences are deterministic derivations from observed extant alignment records.",
          "No ancestral sequence, extinct-species genome, chromosome organization, phenotype, embryo viability, or hatching claim is emitted.",
        ],
      }), mimeType: "application/vnd.agentlas.science-table+json" as const },
      figure: { sha256: scienceExtantArchosaurLocusPanelSha256(pure.spec), mimeType: "application/vnd.vega.v5+json" as const },
    },
    evidenceBoundary: {
      evidenceClass: "extant-comparative-proxy" as const,
      observed: ["exact-provider-response-bytes", "extant-sequence-records-returned-by-provider", "version-pinned-extant-reference-assembly-metadata"] as ["exact-provider-response-bytes", "extant-sequence-records-returned-by-provider", "version-pinned-extant-reference-assembly-metadata"],
      inferred: ["orthology-paralogy", "multiple-sequence-alignment", "rooted-gene-tree", "between-group-sequence-differences"] as ["orthology-paralogy", "multiple-sequence-alignment", "rooted-gene-tree", "between-group-sequence-differences"],
      hypothetical: [] as [],
      prohibitedInference: ["extinct-species-dna", "extinct-species-genome", "chromosome-reconstruction", "phenotype", "embryo-viability", "hatching"] as ["extinct-species-dna", "extinct-species-genome", "chromosome-reconstruction", "phenotype", "embryo-viability", "hatching"],
      publicationGrade: false as const,
    },
    warnings: Array.isArray(pure.warnings) ? pure.warnings.map(String) : ["Independent alignment, topology, substitution-model, taxon-sampling, and experimental review remain required."],
  } satisfies Omit<ScienceExtantArchosaurLocusPanelAnalysis, "deterministicHash">;
  // The shared constructor recomputes all receipts and the deterministic hash;
  // this prevents the host from trusting the plugin's richer, non-persisted QC shape.
  return createScienceExtantArchosaurLocusPanelAnalysis(analysisCore);
}

function outputLineage(run: ScienceResearchRun): ScienceExtantArchosaurLocusPanelOutputLineage {
  const analysis = run.outputs[0]!;
  const table = run.outputs[1]!;
  const figure = run.outputs[2]!;
  return createScienceExtantArchosaurLocusPanelOutputLineage({
    schema: "agentlas.science.extant-archosaur-locus-panel-output-lineage/v1",
    runId: run.id,
    toolId: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID,
    toolVersion: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION,
    inputManifestSha256: run.inputManifestSha256,
    outputManifestSha256: run.outputManifestSha256!,
    environmentSha256: run.environmentSha256,
    analysis: { ordinal: analysis.ordinal, role: analysis.role, mimeType: analysis.mimeType, sha256: analysis.sha256 },
    publicationTable: { ordinal: table.ordinal, role: table.role, mimeType: table.mimeType, sha256: table.sha256 },
    figure: { ordinal: figure.ordinal, role: figure.role, mimeType: figure.mimeType, sha256: figure.sha256 },
  });
}

function artifactForRun(
  store: ScienceStore,
  run: ScienceResearchRun,
  geneTree: VerifiedParent,
  assembly: VerifiedParent,
  parents: ScienceExtantArchosaurLocusPanelParentLineage,
  analysis: ScienceExtantArchosaurLocusPanelAnalysis,
): ScienceArtifact {
  const outputs = outputLineage(run);
  const lineage = createScienceExtantArchosaurLocusPanelArtifactLineage(parents, outputs);
  const payload = { schema: "agentlas.science.extant-archosaur-locus-panel-artifact/v1" as const, analysis, spec: analysis.spec, source: lineage };
  let artifact = store.getArtifactForSourceRun(run.projectId, run.id, EXTANT_ARCHOSAUR_LOCUS_PANEL_LAB_ID);
  if (artifact && canonicalJson(artifact.version.payload) !== canonicalJson(payload)) fail("science-extant-archosaur-locus-panel-artifact-run-mismatch");
  if (!artifact) {
    artifact = store.createArtifact({
      projectId: run.projectId,
      sourceRunId: run.id,
      kind: "chart.vega",
      title: analysis.title,
      rendererId: "agentlas.vega",
      rendererVersion: "6.4.0",
      rendererBinding: null,
      payload,
      semantic: {
        title: analysis.title,
        summary: "Extant avian/crocodilian locus QC for exploratory comparative analysis; no extinct genome or ancestral sequence is produced.",
        entities: analysis.members.map((member) => ({ id: member.geneId, label: member.scientificName, type: `${member.group}-extant-gene` })),
        observations: [
          { label: "Selected extant leaves", value: analysis.diagnostics.selectedLeafCount, unit: "count" },
          { label: "Alignment columns", value: analysis.diagnostics.alignmentColumnCount, unit: "nt" },
          { label: "Between-group differing sites", value: analysis.diagnostics.betweenGroupDifferingSiteCount, unit: "count" },
        ],
        warnings: analysis.warnings,
      },
      provenance: {
        sourceRunId: run.id,
        sourceRefs: [`research-run:${geneTree.run.id}:output:${geneTree.assessmentOutput.ordinal}`, `research-run:${assembly.run.id}:output:${assembly.assessmentOutput.ordinal}`],
        datasetSha256: [geneTree.contentSha256, assembly.contentSha256, geneTree.assessmentOutput.sha256, assembly.assessmentOutput.sha256, run.outputs[0]!.sha256, run.outputs[1]!.sha256, run.outputs[2]!.sha256],
        codeSha256: sha256(`${EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID}@${EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION}:agentlas-comparative-genomics@0.1.0`),
        environmentSha256: run.environmentSha256,
      },
      linkage: {
        labId: EXTANT_ARCHOSAUR_LOCUS_PANEL_LAB_ID,
        origin: { surface: "conversation", conversationId: run.conversationId, messageId: run.originMessageId, loopSessionId: null, runId: run.id, branchId: null },
        parent: null,
        inputs: [],
      },
    });
  }
  store.bindSucceededRunArtifact({
    requestId: stableUuid(`science-extant-archosaur-locus-panel-artifact-binding:v1:${run.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
    projectId: run.projectId,
    runId: run.id,
    outputOrdinal: 1,
    artifactId: artifact.id,
    artifactVersion: artifact.currentVersion,
    expectedArtifactContentSha256: artifact.version.contentSha256,
  });
  return artifact;
}

function verifyChild(
  store: ScienceStore,
  run: ScienceResearchRun,
  descriptor: ScienceExtantArchosaurLocusPanelInputDescriptor,
  geneTree: VerifiedParent,
  assembly: VerifiedParent,
  analysis: ScienceExtantArchosaurLocusPanelAnalysis,
): void {
  if (run.status !== "succeeded" || run.toolId !== EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID
    || run.toolVersion !== EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION || run.parentRunId !== geneTree.run.id
    || run.inputs.length !== 3 || run.outputs.length !== 3) fail("science-extant-archosaur-locus-panel-replay-invalid");
  const parentBindings = store.getResearchRunParentBindings(run.projectId, run.id);
  if (parentBindings.length !== 2 || parentBindings[0]?.role !== "primary" || parentBindings[0]?.parentRunId !== geneTree.run.id
    || parentBindings[1]?.role !== "reference-assembly-manifest" || parentBindings[1]?.parentRunId !== assembly.run.id) {
    fail("science-extant-archosaur-locus-panel-parent-binding-invalid");
  }
  const expectedInputs = [
    [INPUT_ROLE, INPUT_MIME],
    [GENE_TREE_ASSESSMENT_ROLE, GENE_TREE_ASSESSMENT_MIME],
    [ASSEMBLY_ASSESSMENT_ROLE, ASSEMBLY_ASSESSMENT_MIME],
  ] as const;
  run.inputs.forEach((input, index) => {
    const expected = expectedInputs[index]!;
    if (input.ordinal !== index + 1 || input.role !== expected[0] || input.mimeType !== expected[1] || input.artifactId !== null || input.artifactVersion !== null) {
      fail("science-extant-archosaur-locus-panel-replay-invalid");
    }
  });
  if (!store.readRunBlob(run.inputs[0]!).equals(Buffer.from(canonicalJson(descriptor), "utf8"))
    || !store.readRunBlob(run.inputs[1]!).equals(geneTree.assessmentBytes)
    || !store.readRunBlob(run.inputs[2]!).equals(assembly.assessmentBytes)
    || run.inputs[1]!.sha256 !== geneTree.assessmentOutput.sha256 || run.inputs[2]!.sha256 !== assembly.assessmentOutput.sha256) {
    fail("science-extant-archosaur-locus-panel-replay-invalid");
  }
  const outputBytes = [Buffer.from(canonicalJson(analysis), "utf8"), Buffer.from(canonicalJson(analysis.publicationTable), "utf8"), Buffer.from(canonicalJson(analysis.spec), "utf8")];
  const expectedOutputs = [
    ["extant-archosaur-locus-panel-analysis", "application/vnd.agentlas.science.extant-archosaur-locus-panel+json"],
    ["extant-archosaur-locus-panel-publication-table", "application/vnd.agentlas.science-table+json"],
    ["extant-archosaur-locus-panel-figure", "application/vnd.vega.v5+json"],
  ] as const;
  run.outputs.forEach((output, index) => {
    const expected = expectedOutputs[index]!;
    if (output.ordinal !== index + 1 || output.role !== expected[0] || output.mimeType !== expected[1] || output.artifactId !== null || output.artifactVersion !== null
      || !store.readRunBlob(output).equals(outputBytes[index]!)) fail("science-extant-archosaur-locus-panel-replay-invalid");
  });
  if (sha256(canonicalJson(run.inputs.map(resourceEnvelope))) !== run.inputManifestSha256
    || sha256(canonicalJson(run.outputs.map(resourceEnvelope))) !== run.outputManifestSha256) fail("science-extant-archosaur-locus-panel-replay-invalid");
}

export interface ExtantArchosaurLocusPanelInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  parentRunId: string;
  referenceAssemblyRunId: string;
  avianLeafNodeIds: string[];
  crocodilianLeafNodeIds: string[];
  title?: string;
}

export class ScienceExtantArchosaurLocusPanelService {
  constructor(private readonly store: ScienceStore) {}

  materialize(input: ExtantArchosaurLocusPanelInput): ScienceExtantArchosaurLocusPanelResult {
    const engine = runtime();
    const geneTree = verifyGeneTreeParent(this.store, input.projectId, input.parentRunId);
    const assembly = verifyAssemblyParent(this.store, input.projectId, input.referenceAssemblyRunId);
    const descriptor = normalizeScienceExtantArchosaurLocusPanelInputDescriptor({
      schema: "agentlas.science.extant-archosaur-locus-panel-input/v1",
      geneTreeRunId: geneTree.run.id,
      referenceAssemblyRunId: assembly.run.id,
      avianLeafNodeIds: input.avianLeafNodeIds,
      crocodilianLeafNodeIds: input.crocodilianLeafNodeIds,
      title: input.title?.trim() || "Extant archosaur locus panel",
    });
    const parents = parentLineage(geneTree, assembly);
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const geneTreeBlob = this.store.putRunBlob(geneTree.assessmentBytes);
    const assemblyBlob = this.store.putRunBlob(assembly.assessmentBytes);
    const inputs = [
      { role: INPUT_ROLE, mimeType: INPUT_MIME, ...descriptorBlob, artifactId: null, artifactVersion: null },
      { role: GENE_TREE_ASSESSMENT_ROLE, mimeType: GENE_TREE_ASSESSMENT_MIME, ...geneTreeBlob, artifactId: null, artifactVersion: null },
      { role: ASSEMBLY_ASSESSMENT_ROLE, mimeType: ASSEMBLY_ASSESSMENT_MIME, ...assemblyBlob, artifactId: null, artifactVersion: null },
    ];
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      parentRunId: geneTree.run.id,
      parentBindings: [
        { ordinal: 1, role: "primary", parentRunId: geneTree.run.id },
        { ordinal: 2, role: "reference-assembly-manifest", parentRunId: assembly.run.id },
      ],
      toolId: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID,
      toolVersion: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs.map(resourceEnvelope))),
      environmentSha256: sha256(canonicalJson({
        policy: "extant-archosaur-locus-panel-v1",
        plugin: "agentlas-comparative-genomics@0.2.0",
        engine: `extant-archosaur-locus-panel@${engine.ENGINE_VERSION}`,
        parentLineageSha256: parents.lineageSha256,
        runtime: "electron-main",
      })),
      inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const pure = engine.materializeExtantArchosaurLocusPanel({
        schema: engine.REQUEST_SCHEMA,
        title: descriptor.title,
        comparativeAssessment: geneTree.assessment,
        assemblyManifest: assembly.assessment,
        selection: { avianLeafNodeIds: descriptor.avianLeafNodeIds, crocodilianLeafNodeIds: descriptor.crocodilianLeafNodeIds },
      }) as PureResult;
      const analysis = toSharedAnalysis(pure, geneTree, assembly, parents);
      verifyChild(this.store, run, descriptor, geneTree, assembly, analysis);
      const artifact = artifactForRun(this.store, run, geneTree, assembly, parents, analysis);
      return { schema: EXTANT_ARCHOSAUR_LOCUS_PANEL_RESULT_SCHEMA, toolId: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID, toolVersion: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION, runId: run.id, geneTreeRunId: geneTree.run.id, referenceAssemblyRunId: assembly.run.id, title: analysis.title, status: analysis.status, analysis, artifact: { id: artifact.id, version: artifact.currentVersion, contentSha256: artifact.version.contentSha256 }, replayed: true };
    }
    if (created.replayed || run.status !== "running") fail(`science-extant-archosaur-locus-panel-run-${run.status}`);
    try {
      const pure = engine.materializeExtantArchosaurLocusPanel({
        schema: engine.REQUEST_SCHEMA,
        title: descriptor.title,
        comparativeAssessment: geneTree.assessment,
        assemblyManifest: assembly.assessment,
        selection: { avianLeafNodeIds: descriptor.avianLeafNodeIds, crocodilianLeafNodeIds: descriptor.crocodilianLeafNodeIds },
      }) as PureResult;
      if (pure.schema !== engine.RESULT_SCHEMA || pure.decision?.status === undefined) fail("science-extant-archosaur-locus-panel-result-invalid");
      const analysis = toSharedAnalysis(pure, geneTree, assembly, parents);
      const outputBytes = [
        Buffer.from(canonicalJson(analysis), "utf8"),
        Buffer.from(canonicalJson(analysis.publicationTable), "utf8"),
        Buffer.from(canonicalJson(analysis.spec), "utf8"),
      ];
      const outputs = [
        { role: "extant-archosaur-locus-panel-analysis", mimeType: "application/vnd.agentlas.science.extant-archosaur-locus-panel+json", ...this.store.putRunBlob(outputBytes[0]!), artifactId: null, artifactVersion: null },
        { role: "extant-archosaur-locus-panel-publication-table", mimeType: "application/vnd.agentlas.science-table+json", ...this.store.putRunBlob(outputBytes[1]!), artifactId: null, artifactVersion: null },
        { role: "extant-archosaur-locus-panel-figure", mimeType: "application/vnd.vega.v5+json", ...this.store.putRunBlob(outputBytes[2]!), artifactId: null, artifactVersion: null },
      ];
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`),
        projectId: input.projectId,
        runId: run.id,
        status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs.map(resourceEnvelope))),
        summary: `${analysis.status} extant avian/crocodilian locus QC over ${analysis.diagnostics.alignmentColumnCount} alignment columns; exploratory only and not an extinct genome or ancestral sequence.`,
        outputs,
      }).run;
      verifyChild(this.store, run, descriptor, geneTree, assembly, analysis);
      const artifact = artifactForRun(this.store, run, geneTree, assembly, parents, analysis);
      return { schema: EXTANT_ARCHOSAUR_LOCUS_PANEL_RESULT_SCHEMA, toolId: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID, toolVersion: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION, runId: run.id, geneTreeRunId: geneTree.run.id, referenceAssemblyRunId: assembly.run.id, title: analysis.title, status: analysis.status, analysis, artifact: { id: artifact.id, version: artifact.currentVersion, contentSha256: artifact.version.contentSha256 }, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson([])), summary: error instanceof Error ? error.message.slice(0, 1_000) : "science-extant-archosaur-locus-panel-failed", outputs: [] });
      throw error;
    }
  }
}
