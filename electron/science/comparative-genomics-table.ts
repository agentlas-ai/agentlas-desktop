import { createHash } from "node:crypto";
import type {
  ScienceArtifact,
  ScienceDatasetCell,
  ScienceDatasetTablePayload,
  ScienceResearchRun,
  ScienceResearchRunResource,
} from "../../shared/science-contract";
import {
  SCIENCE_TABLE_ARTIFACT_KIND,
  SCIENCE_TABLE_RENDERER_ID,
  SCIENCE_TABLE_RENDERER_VERSION,
  SCIENCE_TABLE_SCHEMA,
  scienceTableSha256,
  validateScienceTablePayload,
} from "../../shared/science-table";
import {
  COMPARATIVE_GENOMICS_LAB_ID,
  COMPARATIVE_GENOMICS_TOOL_ID,
  COMPARATIVE_GENOMICS_TOOL_VERSION,
} from "./comparative-genomics";
import { ScienceStore, scienceEvidenceGraphResearchRunContentSha256 } from "./store";

export const COMPARATIVE_GENOMICS_TABLE_TOOL_ID = "agentlas.comparative-genomics-publication-table";
export const COMPARATIVE_GENOMICS_TABLE_TOOL_VERSION = "1.0.0";
export const COMPARATIVE_GENOMICS_TABLE_INPUT_ROLE = "comparative-genomics-table-projection";
export const COMPARATIVE_GENOMICS_TABLE_SOURCE_ROLE = "comparative-genomics-publication-table-source";
// Keep the core table output contract so the existing editable manuscript-table
// exporter can bind this derived run without a comparative-genomics special case.
export const COMPARATIVE_GENOMICS_TABLE_OUTPUT_ROLE = "normalized-table";
// The parent plugin emits its domain publication-table receipt with the
// science-table MIME. The child is a core normalized table, whose renderer and
// manuscript contracts intentionally use the dotted `science.table` MIME.
export const COMPARATIVE_GENOMICS_TABLE_OUTPUT_MIME = "application/vnd.agentlas.science.table+json";

const PARENT_INPUT_ROLE = "comparative-genomics-query";
const PARENT_INPUT_MIME = "application/vnd.agentlas.science.comparative-genomics-input+json";
const PARENT_OUTPUTS = [
  ["ensembl-release-response", "application/json"],
  ["ensembl-compara-gene-tree-response", "application/json"],
  ["comparative-genomics-assessment", "application/vnd.agentlas.comparative-genomics-gene-tree+json"],
  ["alignment-qc-publication-table", "application/vnd.agentlas.science-table+json"],
  ["comparative-gene-tree-figure", "application/vnd.vega.v5+json"],
] as const;

type JsonRecord = Record<string, unknown>;

export interface ComparativeGenomicsTableInput {
  requestId: string;
  projectId: string;
  parentRunId: string;
  title?: string;
}

export interface ComparativeGenomicsTableResult {
  schema: "agentlas.science-comparative-genomics-table-result/v1";
  runId: string;
  parentRunId: string;
  table: ScienceDatasetTablePayload;
  artifact: ScienceArtifact;
  replayed: boolean;
}

interface VerifiedParent {
  run: ScienceResearchRun;
  contentSha256: string;
  assessmentOutput: ScienceResearchRunResource;
  sourceTableOutput: ScienceResearchRunResource;
  sourceTableBytes: Buffer;
  assessment: JsonRecord;
  table: ScienceDatasetTablePayload;
  title: string;
  notes: string[];
  sequenceUnit: "aa" | "nt";
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

function exactKeys(value: JsonRecord, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function parseJson(bytes: Buffer, code: string): JsonRecord {
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), code);
  } catch {
    fail(code);
  }
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

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) fail(code);
  return value;
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(code);
  return Number(value);
}

function finiteFraction(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail(code);
  return value;
}

function formulaLooking(value: string): boolean {
  const trimmed = value.trimStart();
  return /^[=+@]/u.test(trimmed) || /^-(?!\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$)/u.test(trimmed);
}

function verifyParentAssessment(assessment: JsonRecord, sourceTableBytes: Buffer, sourceTableSha256: string): {
  table: ScienceDatasetTablePayload;
  title: string;
  notes: string[];
  sequenceUnit: "aa" | "nt";
} {
  if (assessment.schema !== "agentlas.comparative-genomics-gene-tree/v1"
    || assessment.provider !== "ensembl-compara" || assessment.rooted !== true
    || !Array.isArray(assessment.providerRelease) || assessment.providerRelease.length < 1
    || assessment.providerRelease.some((release) => !Number.isSafeInteger(release) || Number(release) < 1)
    || !Array.isArray(assessment.leaves) || assessment.leaves.length < 3
    || !Array.isArray(assessment.nodes) || !Array.isArray(assessment.warnings)) {
    fail("science-comparative-genomics-table-parent-assessment-invalid");
  }
  const request = record(assessment.request, "science-comparative-genomics-table-parent-assessment-invalid");
  const sequenceType = request.sequenceType;
  if (sequenceType !== "protein" && sequenceType !== "cdna") fail("science-comparative-genomics-table-parent-assessment-invalid");
  const sequenceUnit = sequenceType === "protein" ? "aa" : "nt";
  const alignment = record(assessment.alignment, "science-comparative-genomics-table-parent-assessment-invalid");
  const diagnostics = record(assessment.diagnostics, "science-comparative-genomics-table-parent-assessment-invalid");
  const publicationTable = record(assessment.publicationTable, "science-comparative-genomics-table-parent-publication-table-invalid");
  exactKeys(publicationTable, ["schema", "title", "columns", "rows", "notes"], "science-comparative-genomics-table-parent-publication-table-invalid");
  if (publicationTable.schema !== SCIENCE_TABLE_SCHEMA || !Array.isArray(publicationTable.columns)
    || !Array.isArray(publicationTable.rows) || !Array.isArray(publicationTable.notes)) {
    fail("science-comparative-genomics-table-parent-publication-table-invalid");
  }
  const expectedSourceColumns = [
    { id: "taxon", label: "Extant taxon", type: "string", unit: null },
    { id: "geneId", label: "Ensembl gene ID", type: "string", unit: null },
    { id: "proteinIds", label: "Sequence IDs", type: "string", unit: null },
    { id: "residues", label: "Non-gap residues", type: "integer", unit: sequenceUnit },
    { id: "gapFraction", label: "Gap fraction", type: "number", unit: "fraction" },
    { id: "missingFraction", label: "Missing fraction", type: "number", unit: "fraction" },
  ];
  if (canonicalJson(publicationTable.columns) !== canonicalJson(expectedSourceColumns)) {
    fail("science-comparative-genomics-table-parent-publication-table-invalid");
  }

  const rows: Array<Record<string, ScienceDatasetCell>> = [];
  const alignmentReceipts: string[] = [];
  for (const rawLeaf of assessment.leaves) {
    const leaf = record(rawLeaf, "science-comparative-genomics-table-parent-leaf-invalid");
    const scientificName = text(leaf.scientificName, "science-comparative-genomics-table-parent-leaf-invalid");
    const geneId = text(leaf.geneId, "science-comparative-genomics-table-parent-leaf-invalid");
    if (!Array.isArray(leaf.proteinIds) || leaf.proteinIds.some((id) => typeof id !== "string" || !id)) {
      fail("science-comparative-genomics-table-parent-leaf-invalid");
    }
    const alignedSequence = text(leaf.alignedSequence, "science-comparative-genomics-table-parent-leaf-invalid");
    if (!/^[A-Za-z*?\-.]+$/u.test(alignedSequence)) fail("science-comparative-genomics-table-parent-leaf-invalid");
    const gapCount = [...alignedSequence].filter((character) => character === "-").length;
    const missingCount = [...alignedSequence].filter((character) => character === "?" || character === ".").length;
    const residueCount = alignedSequence.length - gapCount - missingCount;
    const gapFraction = gapCount / alignedSequence.length;
    const missingFraction = missingCount / alignedSequence.length;
    if (integer(leaf.alignmentLength, "science-comparative-genomics-table-parent-leaf-invalid") !== alignedSequence.length
      || integer(leaf.residueCount, "science-comparative-genomics-table-parent-leaf-invalid") !== residueCount
      || finiteFraction(leaf.gapFraction, "science-comparative-genomics-table-parent-leaf-invalid") !== gapFraction
      || finiteFraction(leaf.missingFraction, "science-comparative-genomics-table-parent-leaf-invalid") !== missingFraction) {
      fail("science-comparative-genomics-table-parent-leaf-invalid");
    }
    const proteinIds = leaf.proteinIds as string[];
    rows.push({
      "Extant taxon": scientificName,
      "Ensembl gene ID": geneId,
      "Sequence IDs": proteinIds.join("; ") || null,
      [`Non-gap residues (${sequenceUnit})`]: residueCount,
      "Gap fraction": Number(gapFraction.toFixed(6)),
      "Missing fraction": Number(missingFraction.toFixed(6)),
    });
    alignmentReceipts.push(`${geneId}\t${alignedSequence}\n`);
  }
  const alignmentLength = integer(alignment.length, "science-comparative-genomics-table-parent-alignment-invalid");
  if (alignmentLength < 3 || assessment.leaves.some((rawLeaf) => record(rawLeaf, "science-comparative-genomics-table-parent-leaf-invalid").alignmentLength !== alignmentLength)
    || alignment.leafCount !== rows.length || alignment.sha256 !== sha256(alignmentReceipts.join(""))) {
    fail("science-comparative-genomics-table-parent-alignment-invalid");
  }
  const nodes = assessment.nodes.map((node) => record(node, "science-comparative-genomics-table-parent-diagnostics-invalid"));
  const duplicationNodeCount = nodes.filter((node) => node.event === "duplication" || node.event === "gene_split").length;
  const lowSupportNodeCount = nodes.filter((node) => typeof node.bootstrap === "number" && node.bootstrap < 70).length;
  if (diagnostics.nodeCount !== nodes.length || diagnostics.leafCount !== rows.length
    || diagnostics.duplicationNodeCount !== duplicationNodeCount || diagnostics.lowSupportNodeCount !== lowSupportNodeCount) {
    fail("science-comparative-genomics-table-parent-diagnostics-invalid");
  }
  const expectedSourceRows = rows.map((row) => [
    row["Extant taxon"], row["Ensembl gene ID"], row["Sequence IDs"], row[`Non-gap residues (${sequenceUnit})`],
    row["Gap fraction"], row["Missing fraction"],
  ]);
  if (canonicalJson(publicationTable.rows) !== canonicalJson(expectedSourceRows)
    || !publicationTable.notes.every((note) => typeof note === "string" && note.trim())
    || !Buffer.from(canonicalJson(publicationTable), "utf8").equals(sourceTableBytes)
    || sha256(sourceTableBytes) !== sourceTableSha256) {
    fail("science-comparative-genomics-table-parent-publication-table-invalid");
  }
  const deterministicHash = text(assessment.deterministicHash, "science-comparative-genomics-table-parent-hash-invalid");
  const core = { ...assessment };
  delete core.deterministicHash;
  if (!/^[a-f0-9]{64}$/u.test(deterministicHash) || deterministicHash !== sha256(canonicalJson(core))) {
    fail("science-comparative-genomics-table-parent-hash-invalid");
  }

  const columns: ScienceDatasetTablePayload["columns"] = [
    { name: "Extant taxon", logicalType: "string", nullable: false },
    { name: "Ensembl gene ID", logicalType: "string", nullable: false },
    { name: "Sequence IDs", logicalType: "string", nullable: true },
    { name: `Non-gap residues (${sequenceUnit})`, logicalType: "integer", nullable: false },
    { name: "Gap fraction", logicalType: "number", nullable: false },
    { name: "Missing fraction", logicalType: "number", nullable: false },
  ];
  const names = columns.map((column) => column.name);
  const nullCount = rows.reduce((total, row) => total + names.filter((name) => row[name] === null).length, 0);
  const formulaLikeCellCount = rows.reduce((total, row) => total + names.filter((name) => typeof row[name] === "string" && formulaLooking(row[name] as string)).length, 0);
  const profile = { rowCount: rows.length, columnCount: columns.length, nullCount, formulaLikeCellCount };
  const table = validateScienceTablePayload({
    schema: SCIENCE_TABLE_SCHEMA,
    columns,
    rows,
    profile,
    receipts: {
      parserId: COMPARATIVE_GENOMICS_TABLE_TOOL_ID,
      parserVersion: "1.0.0",
      rawSha256: sourceTableSha256,
      headerSha256: scienceTableSha256(names),
      rowsSha256: scienceTableSha256(rows),
      tableSha256: scienceTableSha256({ schema: SCIENCE_TABLE_SCHEMA, columns, rows, profile }),
    },
  });
  return {
    table,
    title: text(publicationTable.title, "science-comparative-genomics-table-parent-publication-table-invalid"),
    notes: publicationTable.notes as string[],
    sequenceUnit,
  };
}

function verifyParent(store: ScienceStore, projectId: string, parentRunId: string): VerifiedParent {
  const run = store.getResearchRunForProject(projectId, parentRunId);
  if (!run || run.status !== "succeeded" || run.toolId !== COMPARATIVE_GENOMICS_TOOL_ID
    || run.toolVersion !== COMPARATIVE_GENOMICS_TOOL_VERSION || run.parentRunId !== null
    || run.inputs.length !== 1 || run.outputs.length !== PARENT_OUTPUTS.length) {
    fail("science-comparative-genomics-table-parent-run-invalid");
  }
  const input = run.inputs[0]!;
  if (input.ordinal !== 1 || input.role !== PARENT_INPUT_ROLE || input.mimeType !== PARENT_INPUT_MIME
    || sha256(canonicalJson(run.inputs.map(resourceEnvelope))) !== run.inputManifestSha256) {
    fail("science-comparative-genomics-table-parent-input-invalid");
  }
  store.readRunBlob(input);
  run.outputs.forEach((output, index) => {
    const expected = PARENT_OUTPUTS[index]!;
    if (output.ordinal !== index + 1 || output.role !== expected[0] || output.mimeType !== expected[1]) {
      fail("science-comparative-genomics-table-parent-output-invalid");
    }
    store.readRunBlob(output);
  });
  if (sha256(canonicalJson(run.outputs.map(resourceEnvelope))) !== run.outputManifestSha256) {
    fail("science-comparative-genomics-table-parent-output-manifest-invalid");
  }
  const assessmentOutput = run.outputs[2]!;
  const sourceTableOutput = run.outputs[3]!;
  const assessment = parseJson(store.readRunBlob(assessmentOutput), "science-comparative-genomics-table-parent-assessment-invalid");
  const sourceTableBytes = store.readRunBlob(sourceTableOutput);
  const verified = verifyParentAssessment(assessment, sourceTableBytes, sourceTableOutput.sha256);
  return {
    run,
    contentSha256: scienceEvidenceGraphResearchRunContentSha256(run),
    assessmentOutput,
    sourceTableOutput,
    sourceTableBytes,
    assessment,
    ...verified,
  };
}

function expectedDescriptor(parent: VerifiedParent, title: string): JsonRecord {
  return {
    schema: "agentlas.science-comparative-genomics-table-input/v1",
    projection: "comparative-genomics-publication-table-to-core-table/v1",
    title,
    parent: {
      runId: parent.run.id,
      toolId: parent.run.toolId,
      toolVersion: parent.run.toolVersion,
      contentSha256: parent.contentSha256,
      assessmentOutput: {
        id: parent.assessmentOutput.id,
        ordinal: parent.assessmentOutput.ordinal,
        role: parent.assessmentOutput.role,
        mimeType: parent.assessmentOutput.mimeType,
        byteSize: parent.assessmentOutput.byteSize,
        sha256: parent.assessmentOutput.sha256,
      },
      publicationTableOutput: {
        id: parent.sourceTableOutput.id,
        ordinal: parent.sourceTableOutput.ordinal,
        role: parent.sourceTableOutput.role,
        mimeType: parent.sourceTableOutput.mimeType,
        byteSize: parent.sourceTableOutput.byteSize,
        sha256: parent.sourceTableOutput.sha256,
      },
    },
  };
}

export class ScienceComparativeGenomicsTableService {
  constructor(private readonly store: ScienceStore) {}

  materialize(input: ComparativeGenomicsTableInput): ComparativeGenomicsTableResult {
    const parent = verifyParent(this.store, input.projectId, input.parentRunId);
    const title = input.title === undefined ? parent.title : text(input.title, "science-comparative-genomics-table-title-invalid").trim();
    if (title.length > 240) fail("science-comparative-genomics-table-title-invalid");
    const descriptor = expectedDescriptor(parent, title);
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const sourceBlob = this.store.putRunBlob(parent.sourceTableBytes);
    const inputs = [
      { role: COMPARATIVE_GENOMICS_TABLE_INPUT_ROLE, mimeType: "application/vnd.agentlas.science.comparative-genomics-table-input+json", ...descriptorBlob, artifactId: null, artifactVersion: null },
      { role: COMPARATIVE_GENOMICS_TABLE_SOURCE_ROLE, mimeType: parent.sourceTableOutput.mimeType, ...sourceBlob, artifactId: null, artifactVersion: null },
    ];
    const environmentSha256 = sha256(canonicalJson({
      policy: "sealed-comparative-genomics-publication-table-projection-v1",
      parentContentSha256: parent.contentSha256,
      assessmentOutputSha256: parent.assessmentOutput.sha256,
      publicationTableOutputSha256: parent.sourceTableOutput.sha256,
      tool: `${COMPARATIVE_GENOMICS_TABLE_TOOL_ID}@${COMPARATIVE_GENOMICS_TABLE_TOOL_VERSION}`,
      runtime: "electron-main",
    }));
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: parent.run.conversationId,
      originMessageId: parent.run.originMessageId,
      parentRunId: parent.run.id,
      toolId: COMPARATIVE_GENOMICS_TABLE_TOOL_ID,
      toolVersion: COMPARATIVE_GENOMICS_TABLE_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs.map(resourceEnvelope))),
      environmentSha256,
      inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    this.verifyChildParentBinding(input.projectId, run, parent);
    if (created.replayed && run.status === "succeeded") {
      this.verifyChildRun(run, parent, descriptor, parent.table);
      return { schema: "agentlas.science-comparative-genomics-table-result/v1", runId: run.id, parentRunId: parent.run.id, table: parent.table, artifact: this.artifactForRun(parent, run, title), replayed: true };
    }
    if (run.status !== "running") fail(`science-comparative-genomics-table-run-${run.status}`);
    try {
      const outputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(parent.table), "utf8"));
      const outputs = [{ role: COMPARATIVE_GENOMICS_TABLE_OUTPUT_ROLE, mimeType: COMPARATIVE_GENOMICS_TABLE_OUTPUT_MIME, ...outputBlob, artifactId: null, artifactVersion: null }];
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`),
        projectId: input.projectId,
        runId: run.id,
        status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs.map(resourceEnvelope))),
        summary: `${parent.table.profile.rowCount} extant-sequence alignment-QC rows materialized from exact comparative-genomics output ordinal 4.`,
        outputs,
      }).run;
      this.verifyChildParentBinding(input.projectId, run, parent);
      this.verifyChildRun(run, parent, descriptor, parent.table);
      return { schema: "agentlas.science-comparative-genomics-table-result/v1", runId: run.id, parentRunId: parent.run.id, table: parent.table, artifact: this.artifactForRun(parent, run, title), replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        this.store.completeResearchRun({
          requestId: stableUuid(`${input.requestId}:failed`),
          projectId: input.projectId,
          runId: run.id,
          status: "failed",
          outputManifestSha256: sha256(canonicalJson([])),
          summary: error instanceof Error ? error.message.slice(0, 1000) : "science-comparative-genomics-table-failed",
          outputs: [],
        });
      }
      throw error;
    }
  }

  private verifyChildParentBinding(projectId: string, run: ScienceResearchRun, parent: VerifiedParent): void {
    const bindings = this.store.getResearchRunParentBindings(projectId, run.id);
    if (run.parentRunId !== parent.run.id || bindings.length !== 1 || bindings[0]?.ordinal !== 1
      || bindings[0]?.role !== "primary" || bindings[0]?.parentRunId !== parent.run.id
      || bindings[0]?.parentContentSha256 !== parent.contentSha256) {
      fail("science-comparative-genomics-table-parent-binding-invalid");
    }
  }

  private verifyChildRun(run: ScienceResearchRun, parent: VerifiedParent, descriptor: JsonRecord, table: ScienceDatasetTablePayload): void {
    if (run.status !== "succeeded" || run.toolId !== COMPARATIVE_GENOMICS_TABLE_TOOL_ID
      || run.toolVersion !== COMPARATIVE_GENOMICS_TABLE_TOOL_VERSION || run.inputs.length !== 2 || run.outputs.length !== 1) {
      fail("science-comparative-genomics-table-replay-invalid");
    }
    const descriptorInput = run.inputs[0]!;
    const sourceInput = run.inputs[1]!;
    const output = run.outputs[0]!;
    if (descriptorInput.ordinal !== 1 || descriptorInput.role !== COMPARATIVE_GENOMICS_TABLE_INPUT_ROLE
      || descriptorInput.mimeType !== "application/vnd.agentlas.science.comparative-genomics-table-input+json"
      || sourceInput.ordinal !== 2 || sourceInput.role !== COMPARATIVE_GENOMICS_TABLE_SOURCE_ROLE
      || sourceInput.mimeType !== parent.sourceTableOutput.mimeType || sourceInput.sha256 !== parent.sourceTableOutput.sha256
      || output.ordinal !== 1 || output.role !== COMPARATIVE_GENOMICS_TABLE_OUTPUT_ROLE || output.mimeType !== COMPARATIVE_GENOMICS_TABLE_OUTPUT_MIME
      || sha256(canonicalJson(run.inputs.map(resourceEnvelope))) !== run.inputManifestSha256
      || sha256(canonicalJson(run.outputs.map(resourceEnvelope))) !== run.outputManifestSha256
      || !this.store.readRunBlob(descriptorInput).equals(Buffer.from(canonicalJson(descriptor), "utf8"))
      || !this.store.readRunBlob(sourceInput).equals(parent.sourceTableBytes)
      || !this.store.readRunBlob(output).equals(Buffer.from(canonicalJson(table), "utf8"))) {
      fail("science-comparative-genomics-table-replay-invalid");
    }
  }

  private artifactForRun(parent: VerifiedParent, run: ScienceResearchRun, title: string): ScienceArtifact {
    let artifact = this.store.getArtifactForSourceRun(run.projectId, run.id, COMPARATIVE_GENOMICS_LAB_ID);
    if (artifact && (artifact.kind !== SCIENCE_TABLE_ARTIFACT_KIND || artifact.title !== title
      || artifact.version.rendererId !== SCIENCE_TABLE_RENDERER_ID || artifact.version.rendererVersion !== SCIENCE_TABLE_RENDERER_VERSION
      || canonicalJson(artifact.version.payload) !== canonicalJson(parent.table))) {
      fail("science-comparative-genomics-table-artifact-run-mismatch");
    }
    if (!artifact) {
      artifact = this.store.createArtifact({
        projectId: run.projectId,
        sourceRunId: run.id,
        kind: SCIENCE_TABLE_ARTIFACT_KIND,
        title,
        rendererId: SCIENCE_TABLE_RENDERER_ID,
        rendererVersion: SCIENCE_TABLE_RENDERER_VERSION,
        rendererBinding: null,
        payload: parent.table as unknown as Record<string, unknown>,
        semantic: {
          title,
          summary: `${parent.table.profile.rowCount} extant sequences with exact alignment-QC metrics derived from Ensembl Compara output bytes.`,
          entities: (parent.table.rows as Array<Record<string, ScienceDatasetCell>>).slice(0, 500).map((row) => ({
            id: String(row["Ensembl gene ID"]),
            label: String(row["Extant taxon"]),
            type: "extant-gene-sequence",
          })),
          observations: [
            { label: "Extant sequences", value: parent.table.profile.rowCount, unit: "count" },
            { label: "Table columns", value: parent.table.profile.columnCount, unit: "count" },
            { label: "Alignment unit", value: parent.sequenceUnit, unit: null },
          ],
          warnings: [
            ...parent.notes,
            ...(parent.assessment.warnings as unknown[]).filter((warning): warning is string => typeof warning === "string"),
          ],
        },
        provenance: {
          sourceRunId: run.id,
          sourceRefs: [`research-run:${parent.run.id}:output:3`, `research-run:${parent.run.id}:output:4`],
          // The generic editable-publication-table contract requires one exact
          // raw dataset receipt. The assessment and table schema remain sealed
          // in the child descriptor and immutable parent binding.
          datasetSha256: [parent.table.receipts.rawSha256],
          codeSha256: sha256(`${COMPARATIVE_GENOMICS_TABLE_TOOL_ID}@${COMPARATIVE_GENOMICS_TABLE_TOOL_VERSION}`),
          environmentSha256: run.environmentSha256,
        },
        linkage: {
          labId: COMPARATIVE_GENOMICS_LAB_ID,
          origin: {
            surface: "lab",
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
    const bindingResult = this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-comparative-genomics-table-artifact-binding:v1:${run.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`),
      projectId: run.projectId,
      runId: run.id,
      outputOrdinal: 1,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    const binding = bindingResult.binding;
    const output = run.outputs[0]!;
    if (binding.outputId !== output.id || binding.outputSha256 !== output.sha256
      || binding.artifactId !== artifact.id || binding.artifactVersion !== artifact.currentVersion
      || binding.artifactContentSha256 !== artifact.version.contentSha256) {
      fail("science-comparative-genomics-table-artifact-binding-invalid");
    }
    return artifact;
  }
}
