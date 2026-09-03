import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceResearchRun, ScienceResearchRunResource } from "../../shared/science-contract";
import { loadSciencePluginRuntime } from "./plugin-runtime";
import { ScienceStore, scienceEvidenceGraphResearchRunContentSha256 } from "./store";
import {
  COMPARATIVE_GENOMICS_TOOL_ID,
  COMPARATIVE_GENOMICS_TOOL_VERSION,
} from "./comparative-genomics";

export const HYPOTHETICAL_ASR_TOOL_ID = "agentlas.comparative-genomics-hypothetical-fitch-asr";
export const HYPOTHETICAL_ASR_TOOL_VERSION = "0.1.0";
export const HYPOTHETICAL_ASR_RESULT_SCHEMA = "agentlas.science-hypothetical-asr-result/v1" as const;
export const HYPOTHETICAL_ASR_LAB_ID = "comparative-genomics" as const;

const ASR_REQUEST_SCHEMA = "agentlas.comparative-genomics.hypothetical-asr-request/v1";
const ASR_ENGINE_RESULT_SCHEMA = "agentlas.comparative-genomics.hypothetical-asr-result/v1";
const INPUT_ROLE = "hypothetical-asr-request";
const PARENT_ASSESSMENT_ROLE = "comparative-genomics-assessment-source";
const OUTPUT_ROLE = "hypothetical-ancestral-state-ambiguity-sets";
const INPUT_MIME = "application/vnd.agentlas.science.hypothetical-asr-input+json";
const ASSESSMENT_MIME = "application/vnd.agentlas.comparative-genomics-gene-tree+json";
const OUTPUT_MIME = "application/vnd.agentlas.comparative-genomics.hypothetical-asr-result+json";
const TABLE_ROLE = "hypothetical-asr-site-table";
const TABLE_MIME = "application/vnd.agentlas.science-table+json";
const FIGURE_ROLE = "hypothetical-asr-ambiguity-figure";
const FIGURE_MIME = "application/vnd.vega.v5+json";
const PARENT_OUTPUTS = [
  ["ensembl-release-response", "application/json"],
  ["ensembl-compara-gene-tree-response", "application/json"],
  ["comparative-genomics-assessment", ASSESSMENT_MIME],
  ["alignment-qc-publication-table", "application/vnd.agentlas.science-table+json"],
  ["comparative-gene-tree-figure", "application/vnd.vega.v5+json"],
] as const;

type JsonRecord = Record<string, unknown>;

interface HypotheticalAsrRuntime {
  ENGINE_VERSION: string;
  REQUEST_SCHEMA: string;
  RESULT_SCHEMA: string;
  reconstructHypotheticalAncestor(input: JsonRecord): JsonRecord;
  stableStringify(value: unknown): string;
}

interface VerifiedParent {
  run: ScienceResearchRun;
  contentSha256: string;
  assessmentOutput: ScienceResearchRunResource;
  assessmentBytes: Buffer;
  engineRequest: JsonRecord;
}

export interface HypotheticalAsrInput {
  requestId: string;
  projectId: string;
  parentRunId: string;
  targetNodeId: string;
}

export interface HypotheticalAsrResult {
  schema: typeof HYPOTHETICAL_ASR_RESULT_SCHEMA;
  toolId: typeof HYPOTHETICAL_ASR_TOOL_ID;
  runId: string;
  parentRunId: string;
  targetNodeId: string;
  evidenceStatus: "hypothetical";
  assessment: JsonRecord;
  publicationTable: JsonRecord;
  artifact: ScienceArtifact;
  replayed: boolean;
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

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || !value || value.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) fail(code);
  return value;
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

function runtime(): HypotheticalAsrRuntime {
  const loaded = loadSciencePluginRuntime<Partial<HypotheticalAsrRuntime>>(
    "agentlas-comparative-genomics",
    "runtime/hypothetical-asr.cjs",
    2 * 1024 * 1024,
  ).runtime;
  if (loaded.ENGINE_VERSION !== HYPOTHETICAL_ASR_TOOL_VERSION
    || loaded.REQUEST_SCHEMA !== ASR_REQUEST_SCHEMA || loaded.RESULT_SCHEMA !== ASR_ENGINE_RESULT_SCHEMA
    || typeof loaded.reconstructHypotheticalAncestor !== "function" || typeof loaded.stableStringify !== "function") {
    fail("science-hypothetical-asr-runtime-invalid");
  }
  return loaded as HypotheticalAsrRuntime;
}

function verifyParent(store: ScienceStore, projectId: string, parentRunId: string, targetNodeId: string): VerifiedParent {
  const run = store.getResearchRunForProject(projectId, parentRunId);
  if (!run || run.status !== "succeeded" || run.toolId !== COMPARATIVE_GENOMICS_TOOL_ID
    || run.toolVersion !== COMPARATIVE_GENOMICS_TOOL_VERSION || run.parentRunId !== null
    || run.inputs.length !== 1 || run.outputs.length !== PARENT_OUTPUTS.length) {
    fail("science-hypothetical-asr-parent-run-invalid");
  }
  store.readRunBlob(run.inputs[0]!);
  if (sha256(canonicalJson(run.inputs.map(resourceEnvelope))) !== run.inputManifestSha256) {
    fail("science-hypothetical-asr-parent-input-manifest-invalid");
  }
  run.outputs.forEach((output, index) => {
    const expected = PARENT_OUTPUTS[index]!;
    if (output.ordinal !== index + 1 || output.role !== expected[0] || output.mimeType !== expected[1]) {
      fail("science-hypothetical-asr-parent-output-invalid");
    }
    store.readRunBlob(output);
  });
  if (sha256(canonicalJson(run.outputs.map(resourceEnvelope))) !== run.outputManifestSha256) {
    fail("science-hypothetical-asr-parent-output-manifest-invalid");
  }

  const assessmentOutput = run.outputs[2]!;
  const assessmentBytes = store.readRunBlob(assessmentOutput);
  const assessment = parseJson(assessmentBytes, "science-hypothetical-asr-parent-assessment-invalid");
  if (assessment.schema !== "agentlas.comparative-genomics-gene-tree/v1"
    || assessment.provider !== "ensembl-compara" || assessment.rooted !== true
    || !Array.isArray(assessment.nodes) || !Array.isArray(assessment.leaves)) {
    fail("science-hypothetical-asr-parent-assessment-invalid");
  }
  const request = record(assessment.request, "science-hypothetical-asr-parent-assessment-invalid");
  if (request.sequenceType !== "cdna") fail("science-hypothetical-asr-parent-must-be-cdna");
  const deterministicHash = assessment.deterministicHash;
  const assessmentCore = { ...assessment };
  delete assessmentCore.deterministicHash;
  if (typeof deterministicHash !== "string" || !/^[a-f0-9]{64}$/u.test(deterministicHash)
    || deterministicHash !== sha256(canonicalJson(assessmentCore))) {
    fail("science-hypothetical-asr-parent-assessment-hash-invalid");
  }

  const normalizedNodes = (assessment.nodes as unknown[]).map((value) => {
    const node = record(value, "science-hypothetical-asr-parent-node-invalid");
    return {
      id: text(node.nodeId, "science-hypothetical-asr-parent-node-invalid"),
      parentId: node.parentId === null ? null : text(node.parentId, "science-hypothetical-asr-parent-node-invalid"),
      leaf: node.leaf,
    };
  });
  if (new Set(normalizedNodes.map((node) => node.id)).size !== normalizedNodes.length) {
    fail("science-hypothetical-asr-parent-node-invalid");
  }
  const nodeById = new Map(normalizedNodes.map((node) => [node.id, node]));
  const childrenById = new Map(normalizedNodes.map((node) => [node.id, [] as string[]]));
  for (const node of normalizedNodes) {
    if (node.parentId === null) continue;
    if (!nodeById.has(node.parentId)) fail("science-hypothetical-asr-parent-node-invalid");
    childrenById.get(node.parentId)!.push(node.id);
  }
  const roots = normalizedNodes.filter((node) => node.parentId === null);
  if (roots.length !== 1) fail("science-hypothetical-asr-parent-tree-invalid");
  for (const node of normalizedNodes) {
    const children = childrenById.get(node.id)!;
    if ((node.leaf !== true && node.leaf !== false) || (node.leaf === true ? children.length !== 0 : children.length !== 2)) {
      fail("science-hypothetical-asr-parent-tree-not-bifurcating");
    }
  }

  const leaves = (assessment.leaves as unknown[]).map((value) => {
    const leaf = record(value, "science-hypothetical-asr-parent-leaf-invalid");
    const leafId = text(leaf.nodeId, "science-hypothetical-asr-parent-leaf-invalid");
    const sequence = leaf.alignedSequence;
    if (typeof sequence !== "string" || !/^[ACGTRYSWKMBDHVN-]+$/u.test(sequence)) {
      fail("science-hypothetical-asr-parent-dna-alignment-invalid");
    }
    if (nodeById.get(leafId)?.leaf !== true) fail("science-hypothetical-asr-parent-leaf-invalid");
    return { leafId, sequence, extant: true, evidenceStatus: "observed" };
  });
  const treeLeafIds = normalizedNodes.filter((node) => node.leaf === true).map((node) => node.id).sort();
  const alignedLeafIds = leaves.map((leaf) => leaf.leafId).sort();
  if (new Set(alignedLeafIds).size !== alignedLeafIds.length
    || canonicalJson(treeLeafIds) !== canonicalJson(alignedLeafIds)) {
    fail("science-hypothetical-asr-parent-leaf-invalid");
  }
  const alignment = record(assessment.alignment, "science-hypothetical-asr-parent-alignment-invalid");
  const alignmentReceipt = (assessment.leaves as unknown[]).map((value) => {
    const leaf = record(value, "science-hypothetical-asr-parent-leaf-invalid");
    return `${String(leaf.geneId)}\t${String(leaf.alignedSequence)}\n`;
  }).join("");
  if (alignment.leafCount !== leaves.length || alignment.sha256 !== sha256(alignmentReceipt)) {
    fail("science-hypothetical-asr-parent-alignment-invalid");
  }

  const engineRequest = {
    schema: ASR_REQUEST_SCHEMA,
    moleculeType: "dna",
    tree: {
      rooted: true,
      rootId: roots[0]!.id,
      nodes: normalizedNodes.map((node) => ({ id: node.id, children: childrenById.get(node.id)!.sort() })),
    },
    targetNodeId: text(targetNodeId, "science-hypothetical-asr-target-node-invalid"),
    alignment: { sequences: leaves },
  };
  return { run, contentSha256: scienceEvidenceGraphResearchRunContentSha256(run), assessmentOutput, assessmentBytes, engineRequest };
}

function expectedDescriptor(parent: VerifiedParent): JsonRecord {
  return {
    schema: "agentlas.science-hypothetical-asr-input/v1",
    method: "deterministic-fitch-parsimony-ambiguity-sets",
    evidenceStatus: "hypothetical",
    publicationGrade: false,
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
    },
    engineRequest: parent.engineRequest,
  };
}

function visualProducts(assessment: JsonRecord): { publicationTable: JsonRecord; spec: JsonRecord; payload: JsonRecord } {
  const target = record(assessment.target, "science-hypothetical-asr-engine-result-invalid");
  const diagnostics = record(assessment.diagnostics, "science-hypothetical-asr-engine-result-invalid");
  const alignment = record(assessment.alignment, "science-hypothetical-asr-engine-result-invalid");
  if (!Array.isArray(assessment.sites) || !Array.isArray(assessment.limitations)) fail("science-hypothetical-asr-engine-result-invalid");
  const rows = assessment.sites.map((rawSite) => {
    const site = record(rawSite, "science-hypothetical-asr-engine-result-invalid");
    if (!Number.isSafeInteger(site.site) || Number(site.site) < 1 || !Array.isArray(site.states)
      || typeof site.displayState !== "string" || typeof site.ambiguous !== "boolean"
      || !Number.isSafeInteger(site.minimumChangeCount) || site.evidenceStatus !== "hypothetical") {
      fail("science-hypothetical-asr-engine-result-invalid");
    }
    return [site.site, site.states.join("/"), site.displayState, site.ambiguous, site.minimumChangeCount, "hypothetical"];
  });
  const title = `Exploratory Fitch ambiguity at ${String(target.nodeId)}`;
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `${title}: site-level states`,
    columns: [
      { id: "site", label: "Alignment site", type: "integer", unit: "position" },
      { id: "states", label: "Fitch state set", type: "string", unit: null },
      { id: "displayState", label: "IUPAC display", type: "string", unit: null },
      { id: "ambiguous", label: "Ambiguous", type: "boolean", unit: null },
      { id: "minimumChanges", label: "Minimum changes", type: "integer", unit: "count" },
      { id: "evidenceStatus", label: "Evidence status", type: "string", unit: null },
    ],
    rows,
    notes: [
      "This is a deterministic Fitch-parsimony ambiguity set over exact extant cDNA alignment states.",
      "It is exploratory and hypothetical, not a likelihood, posterior probability, confidence interval, or publication-grade ASR.",
      "It does not represent recovered extinct DNA, an extinct genome, chromosome structure, phenotype, embryo viability, or hatching.",
    ],
  };
  const values = rows.map((row) => ({ site: row[0], state: row[2], ambiguous: row[3], minimumChanges: row[4] }));
  const spec = {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    width: 760,
    height: 300,
    padding: { left: 56, right: 24, top: 70, bottom: 48 },
    title: { text: title, subtitle: `${String(alignment.leafCount)} extant leaves · ${String(alignment.siteCount)} sites · hypothetical only`, anchor: "start", fontSize: 16, subtitleFontSize: 11 },
    data: [{ name: "sites", values }],
    scales: [
      { name: "x", type: "linear", domain: { data: "sites", field: "site" }, range: "width", nice: false, zero: false },
      { name: "y", type: "linear", domain: { data: "sites", field: "minimumChanges" }, range: "height", nice: true, zero: true },
      { name: "color", type: "ordinal", domain: [false, true], range: ["#4F7D68", "#B5654D"] },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "Alignment site" },
      { orient: "left", scale: "y", title: "Minimum Fitch changes" },
    ],
    marks: [
      { type: "symbol", from: { data: "sites" }, encode: { update: { x: { scale: "x", field: "site" }, y: { scale: "y", field: "minimumChanges" }, size: { value: 56 }, fill: { scale: "color", field: "ambiguous" }, tooltip: { field: "state" } } } },
    ],
  };
  const payload = {
    schema: "agentlas.science.hypothetical-asr-artifact/v1",
    assessment: { schema: assessment.schema, engine: assessment.engine, evidenceStatus: assessment.evidenceStatus, target, alignment, diagnostics, limitations: assessment.limitations, deterministicHash: assessment.deterministicHash },
    publicationTable,
    spec,
    evidenceBoundary: { publicationGrade: false, evidenceStatus: "hypothetical", prohibitedInference: ["posterior-probability", "likelihood", "confidence", "extinct-species-dna", "extinct-species-genome", "chromosome-reconstruction", "phenotype", "embryo-viability", "hatching"] },
  };
  return { publicationTable, spec, payload };
}

export class ScienceHypotheticalAsrService {
  constructor(private readonly store: ScienceStore) {}

  reconstruct(input: HypotheticalAsrInput): HypotheticalAsrResult {
    const engine = runtime();
    const parent = verifyParent(this.store, input.projectId, input.parentRunId, input.targetNodeId);
    const descriptor = expectedDescriptor(parent);
    const descriptorBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const assessmentBlob = this.store.putRunBlob(parent.assessmentBytes);
    const inputs = [
      { role: INPUT_ROLE, mimeType: INPUT_MIME, ...descriptorBlob, artifactId: null, artifactVersion: null },
      { role: PARENT_ASSESSMENT_ROLE, mimeType: ASSESSMENT_MIME, ...assessmentBlob, artifactId: null, artifactVersion: null },
    ];
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: parent.run.conversationId,
      originMessageId: parent.run.originMessageId,
      parentRunId: parent.run.id,
      toolId: HYPOTHETICAL_ASR_TOOL_ID,
      toolVersion: HYPOTHETICAL_ASR_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs.map(resourceEnvelope))),
      environmentSha256: sha256(canonicalJson({
        policy: "extant-cdna-non-root-internal-fitch-ambiguity-sets-v1",
        parentContentSha256: parent.contentSha256,
        parentAssessmentSha256: parent.assessmentOutput.sha256,
        plugin: `agentlas-comparative-genomics@0.2.0`,
        engine: `fitch-parsimony-ambiguity-sets@${engine.ENGINE_VERSION}`,
        publicationGrade: false,
        runtime: "electron-main",
      })),
      inputs,
    });
    let run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    this.verifyParentBinding(input.projectId, run, parent);
    if (created.replayed && run.status === "succeeded") {
      return this.replay(run, parent, descriptor, engine);
    }
    if (run.status !== "running") fail(`science-hypothetical-asr-run-${run.status}`);
    try {
      const assessment = engine.reconstructHypotheticalAncestor(parent.engineRequest);
      if (assessment.schema !== ASR_ENGINE_RESULT_SCHEMA || assessment.evidenceStatus !== "hypothetical") {
        fail("science-hypothetical-asr-engine-result-invalid");
      }
      const products = visualProducts(assessment);
      const outputBlob = this.store.putRunBlob(Buffer.from(engine.stableStringify(assessment), "utf8"));
      const tableBlob = this.store.putRunBlob(Buffer.from(canonicalJson(products.publicationTable), "utf8"));
      const figureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(products.spec), "utf8"));
      const outputs = [
        { role: OUTPUT_ROLE, mimeType: OUTPUT_MIME, ...outputBlob, artifactId: null, artifactVersion: null },
        { role: TABLE_ROLE, mimeType: TABLE_MIME, ...tableBlob, artifactId: null, artifactVersion: null },
        { role: FIGURE_ROLE, mimeType: FIGURE_MIME, ...figureBlob, artifactId: null, artifactVersion: null },
      ];
      run = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`),
        projectId: input.projectId,
        runId: run.id,
        status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs.map(resourceEnvelope))),
        summary: `Exploratory hypothetical Fitch ambiguity sets for internal node ${input.targetNodeId}; not publication-grade ASR and not an extinct genome, phenotype, embryo, or hatching result.`,
        outputs,
      }).run;
      this.verifyParentBinding(input.projectId, run, parent);
      this.verifyChild(run, parent, descriptor, assessment, products, engine);
      const artifact = this.artifactForRun(run, parent, assessment, products);
      return {
        schema: HYPOTHETICAL_ASR_RESULT_SCHEMA,
        toolId: HYPOTHETICAL_ASR_TOOL_ID,
        runId: run.id,
        parentRunId: parent.run.id,
        targetNodeId: String(record(assessment.target, "science-hypothetical-asr-engine-result-invalid").nodeId),
        evidenceStatus: "hypothetical",
        assessment,
        publicationTable: products.publicationTable,
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
          summary: error instanceof Error ? error.message.slice(0, 1000) : "science-hypothetical-asr-failed",
          outputs: [],
        });
      }
      throw error;
    }
  }

  private verifyParentBinding(projectId: string, run: ScienceResearchRun, parent: VerifiedParent): void {
    const bindings = this.store.getResearchRunParentBindings(projectId, run.id);
    if (run.parentRunId !== parent.run.id || bindings.length !== 1 || bindings[0]?.ordinal !== 1
      || bindings[0]?.role !== "primary" || bindings[0]?.parentRunId !== parent.run.id
      || bindings[0]?.parentContentSha256 !== parent.contentSha256) {
      fail("science-hypothetical-asr-parent-binding-invalid");
    }
  }

  private verifyChild(run: ScienceResearchRun, parent: VerifiedParent, descriptor: JsonRecord, assessment: JsonRecord, products: ReturnType<typeof visualProducts>, engine: HypotheticalAsrRuntime): void {
    if (run.status !== "succeeded" || run.toolId !== HYPOTHETICAL_ASR_TOOL_ID || run.toolVersion !== HYPOTHETICAL_ASR_TOOL_VERSION
      || run.inputs.length !== 2 || run.outputs.length !== 3) fail("science-hypothetical-asr-replay-invalid");
    const descriptorInput = run.inputs[0]!;
    const sourceInput = run.inputs[1]!;
    const output = run.outputs[0]!;
    const tableOutput = run.outputs[1]!;
    const figureOutput = run.outputs[2]!;
    if (descriptorInput.ordinal !== 1 || descriptorInput.role !== INPUT_ROLE || descriptorInput.mimeType !== INPUT_MIME
      || sourceInput.ordinal !== 2 || sourceInput.role !== PARENT_ASSESSMENT_ROLE || sourceInput.mimeType !== ASSESSMENT_MIME
      || sourceInput.sha256 !== parent.assessmentOutput.sha256 || output.ordinal !== 1 || output.role !== OUTPUT_ROLE || output.mimeType !== OUTPUT_MIME
      || tableOutput.ordinal !== 2 || tableOutput.role !== TABLE_ROLE || tableOutput.mimeType !== TABLE_MIME
      || figureOutput.ordinal !== 3 || figureOutput.role !== FIGURE_ROLE || figureOutput.mimeType !== FIGURE_MIME
      || sha256(canonicalJson(run.inputs.map(resourceEnvelope))) !== run.inputManifestSha256
      || sha256(canonicalJson(run.outputs.map(resourceEnvelope))) !== run.outputManifestSha256
      || !this.store.readRunBlob(descriptorInput).equals(Buffer.from(canonicalJson(descriptor), "utf8"))
      || !this.store.readRunBlob(sourceInput).equals(parent.assessmentBytes)
      || !this.store.readRunBlob(output).equals(Buffer.from(engine.stableStringify(assessment), "utf8"))
      || !this.store.readRunBlob(tableOutput).equals(Buffer.from(canonicalJson(products.publicationTable), "utf8"))
      || !this.store.readRunBlob(figureOutput).equals(Buffer.from(canonicalJson(products.spec), "utf8"))) {
      fail("science-hypothetical-asr-replay-invalid");
    }
  }

  private artifactForRun(run: ScienceResearchRun, parent: VerifiedParent, assessment: JsonRecord, products: ReturnType<typeof visualProducts>): ScienceArtifact {
    const targetNodeId = String(record(assessment.target, "science-hypothetical-asr-engine-result-invalid").nodeId);
    const diagnostics = record(assessment.diagnostics, "science-hypothetical-asr-engine-result-invalid");
    const title = `Exploratory Fitch ambiguity at ${targetNodeId}`;
    const payload = { ...products.payload, source: { runId: run.id, parentRunId: parent.run.id, parentContentSha256: parent.contentSha256, parentAssessmentSha256: parent.assessmentOutput.sha256 } };
    let artifact = this.store.getArtifactForSourceRun(run.projectId, run.id, HYPOTHETICAL_ASR_LAB_ID);
    if (artifact && (artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega" || canonicalJson(artifact.version.payload) !== canonicalJson(payload))) fail("science-hypothetical-asr-artifact-run-mismatch");
    if (!artifact) artifact = this.store.createArtifact({
      projectId: run.projectId, sourceRunId: run.id, kind: "chart.vega", title, rendererId: "agentlas.vega", rendererVersion: "6.4.0", rendererBinding: null, payload,
      semantic: { title, summary: `${String(diagnostics.ambiguousSiteCount)} ambiguous sites under deterministic Fitch parsimony; hypothetical and not publication-grade.`, entities: [{ id: targetNodeId, label: targetNodeId, type: "hypothetical-internal-node" }], observations: [{ label: "Ambiguous sites", value: Number(diagnostics.ambiguousSiteCount), unit: "count" }, { label: "Minimum changes", value: Number(diagnostics.totalMinimumChangeCount), unit: "count" }], warnings: (assessment.limitations as string[]) },
      provenance: { sourceRunId: run.id, sourceRefs: [`research-run:${parent.run.id}:output:3`], datasetSha256: [parent.contentSha256, parent.assessmentOutput.sha256, run.outputs[0]!.sha256, run.outputs[1]!.sha256, run.outputs[2]!.sha256], codeSha256: sha256(`${HYPOTHETICAL_ASR_TOOL_ID}@${HYPOTHETICAL_ASR_TOOL_VERSION}:agentlas-comparative-genomics@0.2.0`), environmentSha256: run.environmentSha256 },
      linkage: { labId: HYPOTHETICAL_ASR_LAB_ID, origin: { surface: "conversation", conversationId: run.conversationId, messageId: run.originMessageId, loopSessionId: null, runId: run.id, branchId: null }, parent: null, inputs: [] },
    });
    this.store.bindSucceededRunArtifact({ requestId: stableUuid(`science-hypothetical-asr-artifact-binding:v1:${run.projectId}:${run.id}:${artifact.id}:${artifact.currentVersion}`), projectId: run.projectId, runId: run.id, outputOrdinal: 1, artifactId: artifact.id, artifactVersion: artifact.currentVersion, expectedArtifactContentSha256: artifact.version.contentSha256 });
    return artifact;
  }

  private replay(run: ScienceResearchRun, parent: VerifiedParent, descriptor: JsonRecord, engine: HypotheticalAsrRuntime): HypotheticalAsrResult {
    const assessment = engine.reconstructHypotheticalAncestor(parent.engineRequest);
    const products = visualProducts(assessment);
    this.verifyChild(run, parent, descriptor, assessment, products, engine);
    const targetNodeId = String(record(assessment.target, "science-hypothetical-asr-replay-invalid").nodeId);
    return {
      schema: HYPOTHETICAL_ASR_RESULT_SCHEMA,
      toolId: HYPOTHETICAL_ASR_TOOL_ID,
      runId: run.id,
      parentRunId: parent.run.id,
      targetNodeId,
      evidenceStatus: "hypothetical",
      assessment,
      publicationTable: products.publicationTable,
      artifact: this.artifactForRun(run, parent, assessment, products),
      replayed: true,
    };
  }
}
