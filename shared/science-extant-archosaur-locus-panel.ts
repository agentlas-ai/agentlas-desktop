import { createHash } from "node:crypto";

export const EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID = "agentlas.materialize-extant-archosaur-locus-panel" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION = "1.0.0" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_LAB_ID = "comparative-genomics" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_RENDERER_ID = "agentlas.vega" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_RENDERER_VERSION = "6.4.0" as const;

export const EXTANT_ARCHOSAUR_LOCUS_PANEL_INPUT_SCHEMA = "agentlas.science.extant-archosaur-locus-panel-input/v1" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_ANALYSIS_SCHEMA = "agentlas.science.extant-archosaur-locus-panel/v1" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_RESULT_SCHEMA = "agentlas.science-extant-archosaur-locus-panel-result/v1" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_ARTIFACT_SCHEMA = "agentlas.science.extant-archosaur-locus-panel-artifact/v1" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_PARENT_LINEAGE_SCHEMA = "agentlas.science.extant-archosaur-locus-panel-parent-lineage/v1" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_OUTPUT_LINEAGE_SCHEMA = "agentlas.science.extant-archosaur-locus-panel-output-lineage/v1" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_ARTIFACT_LINEAGE_SCHEMA = "agentlas.science.extant-archosaur-locus-panel-artifact-lineage/v1" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_RUNTIME_REQUEST_SCHEMA = "agentlas.comparative-genomics.extant-archosaur-locus-panel-request/v1" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_RUNTIME_RESULT_SCHEMA = "agentlas.comparative-genomics.extant-archosaur-locus-panel-result/v1" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_RUNTIME_ENGINE_VERSION = "0.1.0" as const;

export const EXTANT_ARCHOSAUR_LOCUS_PANEL_GENE_TREE_TOOL_ID = "agentlas.comparative-genomics-gene-tree" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_GENE_TREE_TOOL_VERSION = "1.0.0" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_ASSEMBLY_TOOL_ID = "agentlas.extant-reference-assembly-manifest" as const;
export const EXTANT_ARCHOSAUR_LOCUS_PANEL_ASSEMBLY_TOOL_VERSION = "1.0.0" as const;

export const EXTANT_ARCHOSAUR_LOCUS_PANEL_PARENT_ROLES = Object.freeze({
  geneTree: "primary",
  referenceAssembly: "reference-assembly-manifest",
} as const);

export const EXTANT_ARCHOSAUR_LOCUS_PANEL_RESOURCE_CONTRACT = Object.freeze({
  inputs: Object.freeze([
    Object.freeze({ ordinal: 1, role: "extant-archosaur-locus-panel-request", mimeType: "application/vnd.agentlas.science.extant-archosaur-locus-panel-input+json" }),
    Object.freeze({ ordinal: 2, role: "comparative-genomics-assessment-source", mimeType: "application/vnd.agentlas.comparative-genomics-gene-tree+json" }),
    Object.freeze({ ordinal: 3, role: "reference-assembly-manifest-source", mimeType: "application/vnd.agentlas.extant-reference-assembly-manifest+json" }),
  ]),
  outputs: Object.freeze([
    Object.freeze({ ordinal: 1, role: "extant-archosaur-locus-panel-analysis", mimeType: "application/vnd.agentlas.science.extant-archosaur-locus-panel+json" }),
    Object.freeze({ ordinal: 2, role: "extant-archosaur-locus-panel-publication-table", mimeType: "application/vnd.agentlas.science-table+json" }),
    Object.freeze({ ordinal: 3, role: "extant-archosaur-locus-panel-figure", mimeType: "application/vnd.vega.v5+json" }),
  ]),
} as const);

export const EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS = Object.freeze({
  minimumLeavesPerGroup: 2,
  maximumLeavesPerGroup: 4,
  minimumSelectedLeaves: 4,
  maximumSelectedLeaves: 8,
  maximumPositionBins: 400,
  maximumAlignmentColumns: 10_000_000,
  maximumWarnings: 32,
  maximumNotes: 32,
  maximumTextLength: 2_000,
} as const);

const SHA256_RE = /^[a-f0-9]{64}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const DNA_IUPAC_RE = /^[ACGTRYSWKMBDHVN?.-]+$/u;

type JsonRecord = Record<string, unknown>;
export type ScienceExtantArchosaurLocusPanelGroup = "avian" | "crocodilian";
export type ScienceExtantArchosaurLocusPanelStatus = "candidate-for-exploratory-asr" | "review-required" | "blocked";

export interface ScienceExtantArchosaurLocusPanelInputDescriptor {
  schema: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_INPUT_SCHEMA;
  geneTreeRunId: string;
  referenceAssemblyRunId: string;
  avianLeafNodeIds: string[];
  crocodilianLeafNodeIds: string[];
  title: string;
}

export interface ScienceExtantArchosaurLocusPanelResourcePointer {
  ordinal: number;
  role: string;
  mimeType: string;
  sha256: string;
}

export interface ScienceExtantArchosaurLocusPanelParentPointer {
  ordinal: 1 | 2;
  role: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_PARENT_ROLES[keyof typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_PARENT_ROLES];
  runId: string;
  toolId: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_GENE_TREE_TOOL_ID | typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_ASSEMBLY_TOOL_ID;
  toolVersion: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_GENE_TREE_TOOL_VERSION | typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_ASSEMBLY_TOOL_VERSION;
  runContentSha256: string;
  inputManifestSha256: string;
  outputManifestSha256: string;
  environmentSha256: string;
  assessmentOutput: ScienceExtantArchosaurLocusPanelResourcePointer;
}

export interface ScienceExtantArchosaurLocusPanelParentLineageCore {
  schema: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_PARENT_LINEAGE_SCHEMA;
  geneTree: ScienceExtantArchosaurLocusPanelParentPointer;
  referenceAssembly: ScienceExtantArchosaurLocusPanelParentPointer;
}

export interface ScienceExtantArchosaurLocusPanelParentLineage extends ScienceExtantArchosaurLocusPanelParentLineageCore {
  lineageSha256: string;
}

export interface ScienceExtantArchosaurLocusPanelOutputLineageCore {
  schema: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_OUTPUT_LINEAGE_SCHEMA;
  runId: string;
  toolId: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID;
  toolVersion: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION;
  inputManifestSha256: string;
  outputManifestSha256: string;
  environmentSha256: string;
  analysis: ScienceExtantArchosaurLocusPanelResourcePointer;
  publicationTable: ScienceExtantArchosaurLocusPanelResourcePointer;
  figure: ScienceExtantArchosaurLocusPanelResourcePointer;
}

export interface ScienceExtantArchosaurLocusPanelOutputLineage extends ScienceExtantArchosaurLocusPanelOutputLineageCore {
  lineageSha256: string;
}

export interface ScienceExtantArchosaurLocusPanelArtifactLineageCore {
  schema: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_ARTIFACT_LINEAGE_SCHEMA;
  parents: ScienceExtantArchosaurLocusPanelParentLineage;
  outputs: ScienceExtantArchosaurLocusPanelOutputLineage;
}

export interface ScienceExtantArchosaurLocusPanelArtifactLineage extends ScienceExtantArchosaurLocusPanelArtifactLineageCore {
  lineageSha256: string;
}

export interface ScienceExtantArchosaurLocusPanelMember {
  group: ScienceExtantArchosaurLocusPanelGroup;
  nodeId: string;
  taxonomyId: number;
  scientificName: string;
  geneId: string;
  assemblyName: string;
  assemblyAccession: string;
  ensemblRelease: number;
  alignedSequenceSha256: string;
  alignmentLength: number;
  residueCount: number;
  gapFraction: number;
  missingFraction: number;
}

export interface ScienceExtantArchosaurLocusPanelPositionBin {
  ordinal: number;
  startColumn: number;
  endColumn: number;
  comparedColumnCount: number;
  differingColumnCount: number;
  differenceFraction: number;
}

export interface ScienceExtantArchosaurLocusPanelPublicationTable {
  schema: "agentlas.science-table/v1";
  title: string;
  columns: Array<{ id: string; label: string; type: "string" | "integer" | "number"; unit: string | null }>;
  rows: Array<Array<string | number | null>>;
  notes: string[];
}

export interface ScienceExtantArchosaurLocusPanelAnalysis {
  schema: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_ANALYSIS_SCHEMA;
  methodRevision: "extant-archosaur-locus-panel/v1";
  title: string;
  status: ScienceExtantArchosaurLocusPanelStatus;
  source: {
    parentLineageSha256: string;
    geneTreeRunId: string;
    referenceAssemblyRunId: string;
    provider: "ensembl-compara+ensembl";
    providerRelease: number[];
    geneTreeId: string;
    alignmentSha256: string;
  };
  selection: {
    sequenceType: "cdna";
    alignmentLength: number;
    avianLeafNodeIds: string[];
    crocodilianLeafNodeIds: string[];
  };
  members: ScienceExtantArchosaurLocusPanelMember[];
  positionBins: ScienceExtantArchosaurLocusPanelPositionBin[];
  diagnostics: {
    selectedLeafCount: number;
    avianLeafCount: number;
    crocodilianLeafCount: number;
    alignmentColumnCount: number;
    variableSiteCount: number;
    betweenGroupDifferingSiteCount: number;
    duplicationNodeCount: number;
    lowSupportNodeCount: number;
  };
  publicationTable: ScienceExtantArchosaurLocusPanelPublicationTable;
  spec: JsonRecord;
  contentReceipts: {
    publicationTable: { sha256: string; mimeType: "application/vnd.agentlas.science-table+json" };
    figure: { sha256: string; mimeType: "application/vnd.vega.v5+json" };
  };
  evidenceBoundary: {
    evidenceClass: "extant-comparative-proxy";
    observed: ["exact-provider-response-bytes", "extant-sequence-records-returned-by-provider", "version-pinned-extant-reference-assembly-metadata"];
    inferred: ["orthology-paralogy", "multiple-sequence-alignment", "rooted-gene-tree", "between-group-sequence-differences"];
    hypothetical: [];
    prohibitedInference: ["extinct-species-dna", "extinct-species-genome", "chromosome-reconstruction", "phenotype", "embryo-viability", "hatching"];
    publicationGrade: false;
  };
  warnings: string[];
  deterministicHash: string;
}

export interface ScienceExtantArchosaurLocusPanelArtifactPayload {
  schema: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_ARTIFACT_SCHEMA;
  analysis: ScienceExtantArchosaurLocusPanelAnalysis;
  spec: JsonRecord;
  source: ScienceExtantArchosaurLocusPanelArtifactLineage;
}

export interface ScienceExtantArchosaurLocusPanelResult {
  schema: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_RESULT_SCHEMA;
  toolId: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID;
  toolVersion: typeof EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION;
  runId: string;
  geneTreeRunId: string;
  referenceAssemblyRunId: string;
  title: string;
  status: ScienceExtantArchosaurLocusPanelStatus;
  analysis: ScienceExtantArchosaurLocusPanelAnalysis;
  artifact: { id: string; version: number; contentSha256: string };
  replayed: boolean;
}

export const EXTANT_ARCHOSAUR_LOCUS_PANEL_PUBLICATION_COLUMNS = Object.freeze([
  Object.freeze({ id: "group", label: "Extant group", type: "string", unit: null }),
  Object.freeze({ id: "scientificName", label: "Extant taxon", type: "string", unit: null }),
  Object.freeze({ id: "taxonomyId", label: "NCBI taxonomy ID", type: "integer", unit: null }),
  Object.freeze({ id: "geneId", label: "Ensembl gene ID", type: "string", unit: null }),
  Object.freeze({ id: "assemblyAccession", label: "Assembly accession", type: "string", unit: null }),
  Object.freeze({ id: "ensemblRelease", label: "Ensembl release", type: "integer", unit: null }),
  Object.freeze({ id: "residueCount", label: "Non-gap residues", type: "integer", unit: "nt" }),
  Object.freeze({ id: "gapFraction", label: "Gap fraction", type: "number", unit: "fraction" }),
  Object.freeze({ id: "missingFraction", label: "Missing fraction", type: "number", unit: "fraction" }),
] as const);

export const EXTANT_ARCHOSAUR_LOCUS_PANEL_EVIDENCE_BOUNDARY = Object.freeze({
  evidenceClass: "extant-comparative-proxy",
  observed: Object.freeze(["exact-provider-response-bytes", "extant-sequence-records-returned-by-provider", "version-pinned-extant-reference-assembly-metadata"]),
  inferred: Object.freeze(["orthology-paralogy", "multiple-sequence-alignment", "rooted-gene-tree", "between-group-sequence-differences"]),
  hypothetical: Object.freeze([]),
  prohibitedInference: Object.freeze(["extinct-species-dna", "extinct-species-genome", "chromosome-reconstruction", "phenotype", "embryo-viability", "hatching"]),
  publicationGrade: false,
} as const);

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function text(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string") fail(code);
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || CONTROL_RE.test(normalized)) fail(code);
  return normalized;
}

function canonicalText(value: unknown, maximum: number, code: string): string {
  const normalized = text(value, maximum, code);
  if (normalized !== value) fail(code);
  return normalized;
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) fail(code);
  return value.toLowerCase();
}

function canonicalUuid(value: unknown, code: string): string {
  const normalized = uuid(value, code);
  if (normalized !== value) fail(code);
  return normalized;
}

function sha256Value(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) fail(code);
  return value;
}

function positiveInteger(value: unknown, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) fail(code);
  return Number(value);
}

function nonNegativeInteger(value: unknown, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) fail(code);
  return Number(value);
}

function fraction(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1 || Object.is(value, -0)) fail(code);
  return value;
}

function stringList(value: unknown, minimum: number, maximum: number, code: string, sort = false): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(code);
  const entries = value.map((entry) => canonicalText(entry, 240, code));
  if (new Set(entries).size !== entries.length) fail(code);
  const normalized = sort ? [...entries].sort((left, right) => left.localeCompare(right, "en")) : entries;
  if (sort && normalized.some((entry, index) => entry !== entries[index])) fail(code);
  return normalized;
}

export function scienceExtantArchosaurLocusPanelCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("science-extant-archosaur-locus-panel-canonical-number-invalid");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) fail("science-extant-archosaur-locus-panel-canonical-array-invalid");
    }
    return `[${value.map(scienceExtantArchosaurLocusPanelCanonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const item = value as JsonRecord;
    return `{${Object.keys(item).sort().map((key) => {
      if (item[key] === undefined) fail("science-extant-archosaur-locus-panel-canonical-value-invalid");
      return `${JSON.stringify(key)}:${scienceExtantArchosaurLocusPanelCanonicalJson(item[key])}`;
    }).join(",")}}`;
  }
  return fail("science-extant-archosaur-locus-panel-canonical-value-invalid");
}

export function scienceExtantArchosaurLocusPanelSha256(value: unknown): string {
  return createHash("sha256").update(scienceExtantArchosaurLocusPanelCanonicalJson(value), "utf8").digest("hex");
}

export function normalizeScienceExtantArchosaurLocusPanelInputDescriptor(value: unknown): ScienceExtantArchosaurLocusPanelInputDescriptor {
  const input = record(value, "science-extant-archosaur-locus-panel-input-invalid");
  if (!exactKeys(input, ["schema", "geneTreeRunId", "referenceAssemblyRunId", "avianLeafNodeIds", "crocodilianLeafNodeIds", "title"])
    || input.schema !== EXTANT_ARCHOSAUR_LOCUS_PANEL_INPUT_SCHEMA) fail("science-extant-archosaur-locus-panel-input-invalid");
  const geneTreeRunId = uuid(input.geneTreeRunId, "science-extant-archosaur-locus-panel-parent-run-invalid");
  const referenceAssemblyRunId = uuid(input.referenceAssemblyRunId, "science-extant-archosaur-locus-panel-parent-run-invalid");
  if (geneTreeRunId === referenceAssemblyRunId) fail("science-extant-archosaur-locus-panel-parent-run-invalid");
  const normalizeIds = (entries: unknown, code: string): string[] => {
    if (!Array.isArray(entries) || entries.length < EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.minimumLeavesPerGroup
      || entries.length > EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumLeavesPerGroup) fail(code);
    const ids = entries.map((entry) => text(entry, 240, code));
    if (new Set(ids).size !== ids.length) fail(code);
    return ids.sort((left, right) => left.localeCompare(right, "en"));
  };
  const avianLeafNodeIds = normalizeIds(input.avianLeafNodeIds, "science-extant-archosaur-locus-panel-avian-selection-invalid");
  const crocodilianLeafNodeIds = normalizeIds(input.crocodilianLeafNodeIds, "science-extant-archosaur-locus-panel-crocodilian-selection-invalid");
  if (avianLeafNodeIds.some((id) => crocodilianLeafNodeIds.includes(id))) fail("science-extant-archosaur-locus-panel-selection-overlap");
  return {
    schema: EXTANT_ARCHOSAUR_LOCUS_PANEL_INPUT_SCHEMA,
    geneTreeRunId,
    referenceAssemblyRunId,
    avianLeafNodeIds,
    crocodilianLeafNodeIds,
    title: text(input.title, 240, "science-extant-archosaur-locus-panel-title-invalid"),
  };
}

export function validateScienceExtantArchosaurLocusPanelInputDescriptor(value: unknown): ScienceExtantArchosaurLocusPanelInputDescriptor {
  const normalized = normalizeScienceExtantArchosaurLocusPanelInputDescriptor(value);
  if (scienceExtantArchosaurLocusPanelCanonicalJson(normalized) !== scienceExtantArchosaurLocusPanelCanonicalJson(value)) {
    fail("science-extant-archosaur-locus-panel-input-not-normalized");
  }
  return normalized;
}

function validateResourcePointer(value: unknown, expected: { ordinal?: number; role?: string; mimeType?: string }, code: string): ScienceExtantArchosaurLocusPanelResourcePointer {
  const pointer = record(value, code);
  if (!exactKeys(pointer, ["ordinal", "role", "mimeType", "sha256"])) fail(code);
  const normalized = {
    ordinal: positiveInteger(pointer.ordinal, 100_000, code),
    role: canonicalText(pointer.role, 240, code),
    mimeType: canonicalText(pointer.mimeType, 240, code),
    sha256: sha256Value(pointer.sha256, code),
  };
  if ((expected.ordinal !== undefined && normalized.ordinal !== expected.ordinal)
    || (expected.role !== undefined && normalized.role !== expected.role)
    || (expected.mimeType !== undefined && normalized.mimeType !== expected.mimeType)) fail(code);
  return normalized;
}

function validateParentPointer(value: unknown, kind: "geneTree" | "referenceAssembly"): ScienceExtantArchosaurLocusPanelParentPointer {
  const code = `science-extant-archosaur-locus-panel-${kind === "geneTree" ? "gene-tree" : "assembly"}-lineage-invalid`;
  const parent = record(value, code);
  if (!exactKeys(parent, ["ordinal", "role", "runId", "toolId", "toolVersion", "runContentSha256", "inputManifestSha256", "outputManifestSha256", "environmentSha256", "assessmentOutput"])) fail(code);
  const geneTree = kind === "geneTree";
  const expected = geneTree ? {
    ordinal: 1,
    role: EXTANT_ARCHOSAUR_LOCUS_PANEL_PARENT_ROLES.geneTree,
    toolId: EXTANT_ARCHOSAUR_LOCUS_PANEL_GENE_TREE_TOOL_ID,
    toolVersion: EXTANT_ARCHOSAUR_LOCUS_PANEL_GENE_TREE_TOOL_VERSION,
    assessment: { ordinal: 3, role: "comparative-genomics-assessment", mimeType: "application/vnd.agentlas.comparative-genomics-gene-tree+json" },
  } as const : {
    ordinal: 2,
    role: EXTANT_ARCHOSAUR_LOCUS_PANEL_PARENT_ROLES.referenceAssembly,
    toolId: EXTANT_ARCHOSAUR_LOCUS_PANEL_ASSEMBLY_TOOL_ID,
    toolVersion: EXTANT_ARCHOSAUR_LOCUS_PANEL_ASSEMBLY_TOOL_VERSION,
    assessment: { role: "extant-reference-assembly-assessment", mimeType: "application/vnd.agentlas.extant-reference-assembly-manifest+json" },
  } as const;
  if (parent.ordinal !== expected.ordinal || parent.role !== expected.role || parent.toolId !== expected.toolId || parent.toolVersion !== expected.toolVersion) fail(code);
  return {
    ordinal: expected.ordinal,
    role: expected.role,
    runId: canonicalUuid(parent.runId, code),
    toolId: expected.toolId,
    toolVersion: expected.toolVersion,
    runContentSha256: sha256Value(parent.runContentSha256, code),
    inputManifestSha256: sha256Value(parent.inputManifestSha256, code),
    outputManifestSha256: sha256Value(parent.outputManifestSha256, code),
    environmentSha256: sha256Value(parent.environmentSha256, code),
    assessmentOutput: validateResourcePointer(parent.assessmentOutput, expected.assessment, code),
  };
}

export function createScienceExtantArchosaurLocusPanelParentLineage(coreValue: ScienceExtantArchosaurLocusPanelParentLineageCore): ScienceExtantArchosaurLocusPanelParentLineage {
  const core = validateScienceExtantArchosaurLocusPanelParentLineageCore(coreValue);
  return { ...core, lineageSha256: scienceExtantArchosaurLocusPanelSha256(core) };
}

function validateScienceExtantArchosaurLocusPanelParentLineageCore(value: unknown): ScienceExtantArchosaurLocusPanelParentLineageCore {
  const lineage = record(value, "science-extant-archosaur-locus-panel-parent-lineage-invalid");
  if (!exactKeys(lineage, ["schema", "geneTree", "referenceAssembly"])
    || lineage.schema !== EXTANT_ARCHOSAUR_LOCUS_PANEL_PARENT_LINEAGE_SCHEMA) fail("science-extant-archosaur-locus-panel-parent-lineage-invalid");
  const geneTree = validateParentPointer(lineage.geneTree, "geneTree");
  const referenceAssembly = validateParentPointer(lineage.referenceAssembly, "referenceAssembly");
  if (geneTree.runId === referenceAssembly.runId) fail("science-extant-archosaur-locus-panel-parent-lineage-invalid");
  return { schema: EXTANT_ARCHOSAUR_LOCUS_PANEL_PARENT_LINEAGE_SCHEMA, geneTree, referenceAssembly };
}

export function validateScienceExtantArchosaurLocusPanelParentLineage(value: unknown): ScienceExtantArchosaurLocusPanelParentLineage {
  const lineage = record(value, "science-extant-archosaur-locus-panel-parent-lineage-invalid");
  if (!exactKeys(lineage, ["schema", "geneTree", "referenceAssembly", "lineageSha256"])) fail("science-extant-archosaur-locus-panel-parent-lineage-invalid");
  const core = validateScienceExtantArchosaurLocusPanelParentLineageCore({ schema: lineage.schema, geneTree: lineage.geneTree, referenceAssembly: lineage.referenceAssembly });
  const lineageSha256 = sha256Value(lineage.lineageSha256, "science-extant-archosaur-locus-panel-parent-lineage-invalid");
  if (lineageSha256 !== scienceExtantArchosaurLocusPanelSha256(core)) fail("science-extant-archosaur-locus-panel-parent-lineage-hash-invalid");
  return { ...core, lineageSha256 };
}

function validateScienceExtantArchosaurLocusPanelOutputLineageCore(value: unknown): ScienceExtantArchosaurLocusPanelOutputLineageCore {
  const code = "science-extant-archosaur-locus-panel-output-lineage-invalid";
  const lineage = record(value, code);
  if (!exactKeys(lineage, ["schema", "runId", "toolId", "toolVersion", "inputManifestSha256", "outputManifestSha256", "environmentSha256", "analysis", "publicationTable", "figure"])
    || lineage.schema !== EXTANT_ARCHOSAUR_LOCUS_PANEL_OUTPUT_LINEAGE_SCHEMA
    || lineage.toolId !== EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID || lineage.toolVersion !== EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION) fail(code);
  const [analysisContract, tableContract, figureContract] = EXTANT_ARCHOSAUR_LOCUS_PANEL_RESOURCE_CONTRACT.outputs;
  return {
    schema: EXTANT_ARCHOSAUR_LOCUS_PANEL_OUTPUT_LINEAGE_SCHEMA,
    runId: canonicalUuid(lineage.runId, code),
    toolId: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_ID,
    toolVersion: EXTANT_ARCHOSAUR_LOCUS_PANEL_TOOL_VERSION,
    inputManifestSha256: sha256Value(lineage.inputManifestSha256, code),
    outputManifestSha256: sha256Value(lineage.outputManifestSha256, code),
    environmentSha256: sha256Value(lineage.environmentSha256, code),
    analysis: validateResourcePointer(lineage.analysis, analysisContract, code),
    publicationTable: validateResourcePointer(lineage.publicationTable, tableContract, code),
    figure: validateResourcePointer(lineage.figure, figureContract, code),
  };
}

export function createScienceExtantArchosaurLocusPanelOutputLineage(coreValue: ScienceExtantArchosaurLocusPanelOutputLineageCore): ScienceExtantArchosaurLocusPanelOutputLineage {
  const core = validateScienceExtantArchosaurLocusPanelOutputLineageCore(coreValue);
  return { ...core, lineageSha256: scienceExtantArchosaurLocusPanelSha256(core) };
}

export function validateScienceExtantArchosaurLocusPanelOutputLineage(value: unknown): ScienceExtantArchosaurLocusPanelOutputLineage {
  const lineage = record(value, "science-extant-archosaur-locus-panel-output-lineage-invalid");
  if (!exactKeys(lineage, ["schema", "runId", "toolId", "toolVersion", "inputManifestSha256", "outputManifestSha256", "environmentSha256", "analysis", "publicationTable", "figure", "lineageSha256"])) fail("science-extant-archosaur-locus-panel-output-lineage-invalid");
  const core = validateScienceExtantArchosaurLocusPanelOutputLineageCore({
    schema: lineage.schema, runId: lineage.runId, toolId: lineage.toolId, toolVersion: lineage.toolVersion,
    inputManifestSha256: lineage.inputManifestSha256, outputManifestSha256: lineage.outputManifestSha256, environmentSha256: lineage.environmentSha256,
    analysis: lineage.analysis, publicationTable: lineage.publicationTable, figure: lineage.figure,
  });
  const lineageSha256 = sha256Value(lineage.lineageSha256, "science-extant-archosaur-locus-panel-output-lineage-invalid");
  if (lineageSha256 !== scienceExtantArchosaurLocusPanelSha256(core)) fail("science-extant-archosaur-locus-panel-output-lineage-hash-invalid");
  return { ...core, lineageSha256 };
}

export function createScienceExtantArchosaurLocusPanelArtifactLineage(
  parentsValue: ScienceExtantArchosaurLocusPanelParentLineage,
  outputsValue: ScienceExtantArchosaurLocusPanelOutputLineage,
): ScienceExtantArchosaurLocusPanelArtifactLineage {
  const parents = validateScienceExtantArchosaurLocusPanelParentLineage(parentsValue);
  const outputs = validateScienceExtantArchosaurLocusPanelOutputLineage(outputsValue);
  const core = { schema: EXTANT_ARCHOSAUR_LOCUS_PANEL_ARTIFACT_LINEAGE_SCHEMA, parents, outputs } as const;
  return { ...core, lineageSha256: scienceExtantArchosaurLocusPanelSha256(core) };
}

export function validateScienceExtantArchosaurLocusPanelArtifactLineage(value: unknown): ScienceExtantArchosaurLocusPanelArtifactLineage {
  const code = "science-extant-archosaur-locus-panel-artifact-lineage-invalid";
  const lineage = record(value, code);
  if (!exactKeys(lineage, ["schema", "parents", "outputs", "lineageSha256"])
    || lineage.schema !== EXTANT_ARCHOSAUR_LOCUS_PANEL_ARTIFACT_LINEAGE_SCHEMA) fail(code);
  const parents = validateScienceExtantArchosaurLocusPanelParentLineage(lineage.parents);
  const outputs = validateScienceExtantArchosaurLocusPanelOutputLineage(lineage.outputs);
  const core = { schema: EXTANT_ARCHOSAUR_LOCUS_PANEL_ARTIFACT_LINEAGE_SCHEMA, parents, outputs } as const;
  const lineageSha256 = sha256Value(lineage.lineageSha256, code);
  if (lineageSha256 !== scienceExtantArchosaurLocusPanelSha256(core)) fail("science-extant-archosaur-locus-panel-artifact-lineage-hash-invalid");
  return { ...core, lineageSha256 };
}

function validateMember(value: unknown, expectedGroup: ScienceExtantArchosaurLocusPanelGroup, expectedNodeId: string, alignmentLength: number, releases: readonly number[]): ScienceExtantArchosaurLocusPanelMember {
  const code = "science-extant-archosaur-locus-panel-member-invalid";
  const member = record(value, code);
  if (!exactKeys(member, ["group", "nodeId", "taxonomyId", "scientificName", "geneId", "assemblyName", "assemblyAccession", "ensemblRelease", "alignedSequenceSha256", "alignmentLength", "residueCount", "gapFraction", "missingFraction"])
    || member.group !== expectedGroup || member.nodeId !== expectedNodeId) fail(code);
  const normalized: ScienceExtantArchosaurLocusPanelMember = {
    group: expectedGroup,
    nodeId: canonicalText(member.nodeId, 240, code),
    taxonomyId: positiveInteger(member.taxonomyId, 2_147_483_647, code),
    scientificName: canonicalText(member.scientificName, 500, code),
    geneId: canonicalText(member.geneId, 240, code),
    assemblyName: canonicalText(member.assemblyName, 500, code),
    assemblyAccession: canonicalText(member.assemblyAccession, 240, code),
    ensemblRelease: positiveInteger(member.ensemblRelease, 100_000, code),
    alignedSequenceSha256: sha256Value(member.alignedSequenceSha256, code),
    alignmentLength: positiveInteger(member.alignmentLength, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumAlignmentColumns, code),
    residueCount: nonNegativeInteger(member.residueCount, alignmentLength, code),
    gapFraction: fraction(member.gapFraction, code),
    missingFraction: fraction(member.missingFraction, code),
  };
  if (normalized.alignmentLength !== alignmentLength || normalized.ensemblRelease !== releases[0]
    || normalized.gapFraction + normalized.missingFraction > 1 + Number.EPSILON) fail(code);
  return normalized;
}

function validatePositionBins(value: unknown, alignmentLength: number): ScienceExtantArchosaurLocusPanelPositionBin[] {
  const code = "science-extant-archosaur-locus-panel-position-bins-invalid";
  if (!Array.isArray(value) || value.length < 1 || value.length > EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumPositionBins) fail(code);
  let expectedStart = 1;
  const bins = value.map((entry, index) => {
    const bin = record(entry, code);
    if (!exactKeys(bin, ["ordinal", "startColumn", "endColumn", "comparedColumnCount", "differingColumnCount", "differenceFraction"])) fail(code);
    const startColumn = positiveInteger(bin.startColumn, alignmentLength, code);
    const endColumn = positiveInteger(bin.endColumn, alignmentLength, code);
    const width = endColumn - startColumn + 1;
    const comparedColumnCount = nonNegativeInteger(bin.comparedColumnCount, width, code);
    const differingColumnCount = nonNegativeInteger(bin.differingColumnCount, comparedColumnCount, code);
    const differenceFraction = fraction(bin.differenceFraction, code);
    const expectedFraction = comparedColumnCount === 0 ? 0 : Number((differingColumnCount / comparedColumnCount).toFixed(6));
    if (bin.ordinal !== index + 1 || startColumn !== expectedStart || endColumn < startColumn || differenceFraction !== expectedFraction) fail(code);
    expectedStart = endColumn + 1;
    return { ordinal: index + 1, startColumn, endColumn, comparedColumnCount, differingColumnCount, differenceFraction };
  });
  if (expectedStart !== alignmentLength + 1) fail(code);
  return bins;
}

function expectedPublicationRows(members: readonly ScienceExtantArchosaurLocusPanelMember[]): ScienceExtantArchosaurLocusPanelPublicationTable["rows"] {
  return members.map((member) => [
    member.group, member.scientificName, member.taxonomyId, member.geneId, member.assemblyAccession,
    member.ensemblRelease, member.residueCount, member.gapFraction, member.missingFraction,
  ]);
}

function validatePublicationTable(value: unknown, members: readonly ScienceExtantArchosaurLocusPanelMember[]): ScienceExtantArchosaurLocusPanelPublicationTable {
  const code = "science-extant-archosaur-locus-panel-publication-table-invalid";
  const table = record(value, code);
  if (!exactKeys(table, ["schema", "title", "columns", "rows", "notes"]) || table.schema !== "agentlas.science-table/v1"
    || scienceExtantArchosaurLocusPanelCanonicalJson(table.columns) !== scienceExtantArchosaurLocusPanelCanonicalJson(EXTANT_ARCHOSAUR_LOCUS_PANEL_PUBLICATION_COLUMNS)
    || !Array.isArray(table.rows) || scienceExtantArchosaurLocusPanelCanonicalJson(table.rows) !== scienceExtantArchosaurLocusPanelCanonicalJson(expectedPublicationRows(members))) fail(code);
  return {
    schema: "agentlas.science-table/v1",
    title: canonicalText(table.title, 500, code),
    columns: EXTANT_ARCHOSAUR_LOCUS_PANEL_PUBLICATION_COLUMNS.map((column) => ({ ...column })),
    rows: expectedPublicationRows(members),
    notes: stringList(table.notes, 1, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumNotes, code),
  };
}

export function validateScienceExtantArchosaurLocusPanelAnalysis(value: unknown): ScienceExtantArchosaurLocusPanelAnalysis {
  const code = "science-extant-archosaur-locus-panel-analysis-invalid";
  const analysis = record(value, code);
  if (!exactKeys(analysis, ["schema", "methodRevision", "title", "status", "source", "selection", "members", "positionBins", "diagnostics", "publicationTable", "spec", "contentReceipts", "evidenceBoundary", "warnings", "deterministicHash"])
    || analysis.schema !== EXTANT_ARCHOSAUR_LOCUS_PANEL_ANALYSIS_SCHEMA || analysis.methodRevision !== "extant-archosaur-locus-panel/v1"
    || !(["candidate-for-exploratory-asr", "review-required", "blocked"] as const).includes(analysis.status as ScienceExtantArchosaurLocusPanelStatus)) fail(code);

  const source = record(analysis.source, code);
  if (!exactKeys(source, ["parentLineageSha256", "geneTreeRunId", "referenceAssemblyRunId", "provider", "providerRelease", "geneTreeId", "alignmentSha256"])
    || source.provider !== "ensembl-compara+ensembl" || !Array.isArray(source.providerRelease)
    || source.providerRelease.length < 1 || source.providerRelease.length > 4) fail(code);
  const providerRelease = source.providerRelease.map((release) => positiveInteger(release, 100_000, code));
  if (new Set(providerRelease).size !== providerRelease.length || providerRelease.some((release, index) => index > 0 && release >= providerRelease[index - 1]!)) fail(code);
  const normalizedSource = {
    parentLineageSha256: sha256Value(source.parentLineageSha256, code),
    geneTreeRunId: canonicalUuid(source.geneTreeRunId, code),
    referenceAssemblyRunId: canonicalUuid(source.referenceAssemblyRunId, code),
    provider: "ensembl-compara+ensembl" as const,
    providerRelease,
    geneTreeId: canonicalText(source.geneTreeId, 240, code),
    alignmentSha256: sha256Value(source.alignmentSha256, code),
  };
  if (normalizedSource.geneTreeRunId === normalizedSource.referenceAssemblyRunId) fail(code);

  const selection = record(analysis.selection, code);
  if (!exactKeys(selection, ["sequenceType", "alignmentLength", "avianLeafNodeIds", "crocodilianLeafNodeIds"])
    || selection.sequenceType !== "cdna") fail(code);
  const alignmentLength = positiveInteger(selection.alignmentLength, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumAlignmentColumns, code);
  const avianLeafNodeIds = stringList(selection.avianLeafNodeIds, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.minimumLeavesPerGroup, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumLeavesPerGroup, code, true);
  const crocodilianLeafNodeIds = stringList(selection.crocodilianLeafNodeIds, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.minimumLeavesPerGroup, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumLeavesPerGroup, code, true);
  if (avianLeafNodeIds.some((id) => crocodilianLeafNodeIds.includes(id))) fail(code);
  const expectedMembers = [...avianLeafNodeIds.map((nodeId) => ({ group: "avian" as const, nodeId })), ...crocodilianLeafNodeIds.map((nodeId) => ({ group: "crocodilian" as const, nodeId }))];
  if (!Array.isArray(analysis.members) || analysis.members.length !== expectedMembers.length) fail(code);
  const members = analysis.members.map((member, index) => validateMember(member, expectedMembers[index]!.group, expectedMembers[index]!.nodeId, alignmentLength, providerRelease));
  if (new Set(members.map((member) => member.taxonomyId)).size !== members.length
    || new Set(members.map((member) => member.assemblyAccession)).size !== members.length
    || new Set(members.map((member) => member.geneId)).size !== members.length) fail(code);

  const positionBins = validatePositionBins(analysis.positionBins, alignmentLength);
  const diagnostics = record(analysis.diagnostics, code);
  if (!exactKeys(diagnostics, ["selectedLeafCount", "avianLeafCount", "crocodilianLeafCount", "alignmentColumnCount", "variableSiteCount", "betweenGroupDifferingSiteCount", "duplicationNodeCount", "lowSupportNodeCount"])) fail(code);
  const normalizedDiagnostics = {
    selectedLeafCount: positiveInteger(diagnostics.selectedLeafCount, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumSelectedLeaves, code),
    avianLeafCount: positiveInteger(diagnostics.avianLeafCount, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumLeavesPerGroup, code),
    crocodilianLeafCount: positiveInteger(diagnostics.crocodilianLeafCount, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumLeavesPerGroup, code),
    alignmentColumnCount: positiveInteger(diagnostics.alignmentColumnCount, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumAlignmentColumns, code),
    variableSiteCount: nonNegativeInteger(diagnostics.variableSiteCount, alignmentLength, code),
    betweenGroupDifferingSiteCount: nonNegativeInteger(diagnostics.betweenGroupDifferingSiteCount, alignmentLength, code),
    duplicationNodeCount: nonNegativeInteger(diagnostics.duplicationNodeCount, 10_000_000, code),
    lowSupportNodeCount: nonNegativeInteger(diagnostics.lowSupportNodeCount, 10_000_000, code),
  };
  if (normalizedDiagnostics.selectedLeafCount !== members.length || normalizedDiagnostics.avianLeafCount !== avianLeafNodeIds.length
    || normalizedDiagnostics.crocodilianLeafCount !== crocodilianLeafNodeIds.length || normalizedDiagnostics.alignmentColumnCount !== alignmentLength
    || normalizedDiagnostics.betweenGroupDifferingSiteCount > normalizedDiagnostics.variableSiteCount
    || positionBins.reduce((total, bin) => total + bin.differingColumnCount, 0) !== normalizedDiagnostics.betweenGroupDifferingSiteCount) fail(code);

  const publicationTable = validatePublicationTable(analysis.publicationTable, members);
  const spec = record(analysis.spec, code);
  if (spec.$schema !== "https://vega.github.io/schema/vega/v5.json") fail(code);
  const receipts = record(analysis.contentReceipts, code);
  const tableReceipt = record(receipts.publicationTable, code);
  const figureReceipt = record(receipts.figure, code);
  if (!exactKeys(receipts, ["publicationTable", "figure"])
    || !exactKeys(tableReceipt, ["sha256", "mimeType"]) || tableReceipt.mimeType !== "application/vnd.agentlas.science-table+json"
    || !exactKeys(figureReceipt, ["sha256", "mimeType"]) || figureReceipt.mimeType !== "application/vnd.vega.v5+json"
    || sha256Value(tableReceipt.sha256, code) !== scienceExtantArchosaurLocusPanelSha256(publicationTable)
    || sha256Value(figureReceipt.sha256, code) !== scienceExtantArchosaurLocusPanelSha256(spec)) fail("science-extant-archosaur-locus-panel-content-receipt-invalid");
  if (scienceExtantArchosaurLocusPanelCanonicalJson(analysis.evidenceBoundary) !== scienceExtantArchosaurLocusPanelCanonicalJson(EXTANT_ARCHOSAUR_LOCUS_PANEL_EVIDENCE_BOUNDARY)) fail("science-extant-archosaur-locus-panel-evidence-boundary-invalid");
  const warnings = stringList(analysis.warnings, 1, EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumWarnings, code);

  const normalizedCore = {
    schema: EXTANT_ARCHOSAUR_LOCUS_PANEL_ANALYSIS_SCHEMA,
    methodRevision: "extant-archosaur-locus-panel/v1" as const,
    title: canonicalText(analysis.title, 240, code),
    status: analysis.status as ScienceExtantArchosaurLocusPanelStatus,
    source: normalizedSource,
    selection: { sequenceType: "cdna" as const, alignmentLength, avianLeafNodeIds, crocodilianLeafNodeIds },
    members,
    positionBins,
    diagnostics: normalizedDiagnostics,
    publicationTable,
    spec,
    contentReceipts: {
      publicationTable: { sha256: String(tableReceipt.sha256), mimeType: "application/vnd.agentlas.science-table+json" as const },
      figure: { sha256: String(figureReceipt.sha256), mimeType: "application/vnd.vega.v5+json" as const },
    },
    evidenceBoundary: {
      evidenceClass: EXTANT_ARCHOSAUR_LOCUS_PANEL_EVIDENCE_BOUNDARY.evidenceClass,
      observed: [...EXTANT_ARCHOSAUR_LOCUS_PANEL_EVIDENCE_BOUNDARY.observed] as ScienceExtantArchosaurLocusPanelAnalysis["evidenceBoundary"]["observed"],
      inferred: [...EXTANT_ARCHOSAUR_LOCUS_PANEL_EVIDENCE_BOUNDARY.inferred] as ScienceExtantArchosaurLocusPanelAnalysis["evidenceBoundary"]["inferred"],
      hypothetical: [] as [],
      prohibitedInference: [...EXTANT_ARCHOSAUR_LOCUS_PANEL_EVIDENCE_BOUNDARY.prohibitedInference] as ScienceExtantArchosaurLocusPanelAnalysis["evidenceBoundary"]["prohibitedInference"],
      publicationGrade: false as const,
    },
    warnings,
  };
  const deterministicHash = sha256Value(analysis.deterministicHash, code);
  if (deterministicHash !== scienceExtantArchosaurLocusPanelSha256(normalizedCore)) fail("science-extant-archosaur-locus-panel-deterministic-hash-invalid");
  return { ...normalizedCore, deterministicHash };
}

export function createScienceExtantArchosaurLocusPanelAnalysis(
  core: Omit<ScienceExtantArchosaurLocusPanelAnalysis, "deterministicHash">,
): ScienceExtantArchosaurLocusPanelAnalysis {
  return validateScienceExtantArchosaurLocusPanelAnalysis({ ...core, deterministicHash: scienceExtantArchosaurLocusPanelSha256(core) });
}

export function validateScienceExtantArchosaurLocusPanelArtifactPayload(value: unknown): ScienceExtantArchosaurLocusPanelArtifactPayload {
  const code = "science-extant-archosaur-locus-panel-artifact-invalid";
  const payload = record(value, code);
  if (!exactKeys(payload, ["schema", "analysis", "spec", "source"]) || payload.schema !== EXTANT_ARCHOSAUR_LOCUS_PANEL_ARTIFACT_SCHEMA) fail(code);
  const analysis = validateScienceExtantArchosaurLocusPanelAnalysis(payload.analysis);
  const spec = record(payload.spec, code);
  const source = validateScienceExtantArchosaurLocusPanelArtifactLineage(payload.source);
  if (scienceExtantArchosaurLocusPanelCanonicalJson(spec) !== scienceExtantArchosaurLocusPanelCanonicalJson(analysis.spec)
    || source.parents.lineageSha256 !== analysis.source.parentLineageSha256
    || source.parents.geneTree.runId !== analysis.source.geneTreeRunId
    || source.parents.referenceAssembly.runId !== analysis.source.referenceAssemblyRunId
    || source.outputs.analysis.sha256 !== scienceExtantArchosaurLocusPanelSha256(analysis)
    || source.outputs.publicationTable.sha256 !== analysis.contentReceipts.publicationTable.sha256
    || source.outputs.figure.sha256 !== analysis.contentReceipts.figure.sha256) fail("science-extant-archosaur-locus-panel-artifact-lineage-closure-invalid");
  return { schema: EXTANT_ARCHOSAUR_LOCUS_PANEL_ARTIFACT_SCHEMA, analysis, spec, source };
}

export function assertScienceExtantArchosaurLocusPanelArtifactLineage(
  value: unknown,
  expectedParents: ScienceExtantArchosaurLocusPanelParentLineage,
  expectedOutputs: ScienceExtantArchosaurLocusPanelOutputLineage,
): ScienceExtantArchosaurLocusPanelArtifactPayload {
  const payload = validateScienceExtantArchosaurLocusPanelArtifactPayload(value);
  const parents = validateScienceExtantArchosaurLocusPanelParentLineage(expectedParents);
  const outputs = validateScienceExtantArchosaurLocusPanelOutputLineage(expectedOutputs);
  if (scienceExtantArchosaurLocusPanelCanonicalJson(payload.source.parents) !== scienceExtantArchosaurLocusPanelCanonicalJson(parents)
    || scienceExtantArchosaurLocusPanelCanonicalJson(payload.source.outputs) !== scienceExtantArchosaurLocusPanelCanonicalJson(outputs)) {
    fail("science-extant-archosaur-locus-panel-artifact-lineage-mismatch");
  }
  return payload;
}

export function isScienceExtantArchosaurDnaAlignment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= EXTANT_ARCHOSAUR_LOCUS_PANEL_LIMITS.maximumAlignmentColumns
    && value === value.toUpperCase() && DNA_IUPAC_RE.test(value);
}
