import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceResearchRunResource, ScienceSource } from "../../shared/science-contract";
import { ScienceStore } from "./store";
import { loadSciencePluginRuntime } from "./plugin-runtime";

export const COMPARATIVE_GENOMICS_TOOL_ID = "agentlas.comparative-genomics-gene-tree";
export const COMPARATIVE_GENOMICS_TOOL_VERSION = "1.0.0";
export const COMPARATIVE_GENOMICS_LAB_ID = "comparative-genomics";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ENSEMBL_ORIGIN = "https://rest.ensembl.org";

type JsonRecord = Record<string, unknown>;

type ComparativeGenomicsRuntime = {
  PLUGIN_VERSION: string;
  ENSEMBL_ORIGIN: string;
  stableStringify(value: unknown): string;
  sha256(value: string): string;
  buildGeneTreeRequest(input: ComparativeGenomicsRequest): {
    input: ComparativeGenomicsRequest;
    releaseUrl: string;
    treeUrl: string;
  };
  normalizeGeneTree(input: {
    request: ComparativeGenomicsRequest;
    releaseResponse: JsonRecord;
    treeResponse: JsonRecord;
    title: string;
  }): ComparativeGenomicsAssessment;
};

export interface ComparativeGenomicsRequest {
  species: string;
  geneId: string;
  pruneTaxon: number;
  sequenceType: "protein" | "cdna";
}

export interface ComparativeGenomicsAssessment extends JsonRecord {
  schema: "agentlas.comparative-genomics-gene-tree/v1";
  provider: "ensembl-compara";
  providerRelease: number[];
  request: ComparativeGenomicsRequest;
  title: string;
  geneTreeId: string;
  rooted: true;
  targetNode: JsonRecord;
  nodes: JsonRecord[];
  leaves: Array<JsonRecord & { alignedSequence: string; geneId: string; scientificName: string }>;
  alignment: JsonRecord & { length: number; sha256: string; leafCount: number };
  diagnostics: JsonRecord & { nodeCount: number; leafCount: number; duplicationNodeCount: number; lowSupportNodeCount: number };
  publicationTable: JsonRecord;
  spec: JsonRecord;
  evidenceBoundary: JsonRecord;
  warnings: string[];
  deterministicHash: string;
}

export interface ComparativeGenomicsInput extends ComparativeGenomicsRequest {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  title?: string;
}

export interface ComparativeGenomicsResult {
  schema: "agentlas.science-comparative-genomics-result/v1";
  provider: "ensembl-compara";
  title: string;
  assessment: ComparativeGenomicsAssessment;
  runId: string;
  releaseSourceId: string;
  releaseSourceVersionId: string;
  treeSourceId: string;
  treeSourceVersionId: string;
  releaseEndpoint: string;
  treeEndpoint: string;
  releaseResponseSha256: string;
  treeResponseSha256: string;
  retrievedAt: string;
  artifact: ScienceArtifact;
  replayed: boolean;
}

export interface ComparativeGenomicsProviderValidationFailureReceipt extends JsonRecord {
  schema: "agentlas.science-comparative-genomics-provider-validation-failure/v1";
  runId: string | null;
  provider: "ensembl-compara";
  code: string;
  request: ComparativeGenomicsRequest;
  releaseEndpoint: string;
  treeEndpoint: string;
  observedRootTaxonomyId: number | string | null;
  observedRootScientificName: string | null;
  observedTaxonomyIds: Array<number | string>;
  releaseResponseSha256: string;
  treeResponseSha256: string;
  retrievedAt: string;
}

export class ScienceComparativeGenomicsProviderValidationError extends Error {
  constructor(public failureReceipt: ComparativeGenomicsProviderValidationFailureReceipt) {
    super(failureReceipt.code);
    this.name = "ScienceComparativeGenomicsProviderValidationError";
  }
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

function runResourceEnvelope(resource: Pick<ScienceResearchRunResource, "role" | "mimeType" | "byteSize" | "sha256" | "blobRef" | "artifactId" | "artifactVersion">): JsonRecord {
  return { role: resource.role, mimeType: resource.mimeType, byteSize: resource.byteSize, sha256: resource.sha256, blobRef: resource.blobRef, artifactId: resource.artifactId, artifactVersion: resource.artifactVersion };
}

function runtime(): ComparativeGenomicsRuntime {
  const loaded = loadSciencePluginRuntime<Partial<ComparativeGenomicsRuntime>>(
    "agentlas-comparative-genomics",
    "runtime/comparative-genomics.cjs",
    10 * 1024 * 1024,
  ).runtime;
  if (loaded.PLUGIN_VERSION !== "0.2.0" || loaded.ENSEMBL_ORIGIN !== ENSEMBL_ORIGIN
    || typeof loaded.buildGeneTreeRequest !== "function" || typeof loaded.normalizeGeneTree !== "function"
    || typeof loaded.stableStringify !== "function" || typeof loaded.sha256 !== "function") {
    throw new Error("science-comparative-genomics-runtime-invalid");
  }
  return loaded as ComparativeGenomicsRuntime;
}

function parseJson(bytes: Buffer, code: string): JsonRecord {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
    return value as JsonRecord;
  } catch { throw new Error(code); }
}

function observedRootTaxonomy(treeResponse: JsonRecord): { id: number | string | null; scientificName: string | null } {
  const tree = treeResponse.tree;
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return { id: null, scientificName: null };
  const taxonomy = (tree as JsonRecord).taxonomy;
  if (!taxonomy || typeof taxonomy !== "object" || Array.isArray(taxonomy)) return { id: null, scientificName: null };
  const record = taxonomy as JsonRecord;
  const id = typeof record.id === "number" || typeof record.id === "string" ? record.id : null;
  const scientificName = typeof record.scientific_name === "string" ? record.scientific_name.slice(0, 240) : null;
  return { id, scientificName };
}

function observedTaxonomyIds(treeResponse: JsonRecord): Array<number | string> {
  const ids = new Set<number | string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 256 || ids.size >= 2500 || !value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as JsonRecord;
    const taxonomy = record.taxonomy;
    if (taxonomy && typeof taxonomy === "object" && !Array.isArray(taxonomy)) {
      const id = (taxonomy as JsonRecord).id;
      if (typeof id === "number" || typeof id === "string") ids.add(id);
    }
    if (Array.isArray(record.children)) record.children.forEach((child) => visit(child, depth + 1));
  };
  visit(treeResponse.tree, 0);
  return [...ids].sort((left, right) => String(left).localeCompare(String(right), "en"));
}

async function readBounded(response: Response): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error("science-comparative-genomics-response-too-large");
  if (!response.body) throw new Error("science-comparative-genomics-response-invalid");
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("science-comparative-genomics-response-too-large"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function fetchJson(url: URL, fetchImpl: typeof fetch): Promise<{ body: Buffer; retrievedAt: string }> {
  const pathAllowed = url.pathname === "/info/data" || url.pathname.startsWith("/genetree/member/id/");
  if (url.origin !== ENSEMBL_ORIGIN || !pathAllowed) throw new Error("science-comparative-genomics-endpoint-denied");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "error", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "Agentlas-Science/1.0 (comparative genomics research; https://agentlas.ai)" } });
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw new Error(`science-comparative-genomics-http-${response.status}`); }
    const mime = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim();
    if (mime !== "application/json") { await response.body?.cancel().catch(() => undefined); throw new Error("science-comparative-genomics-response-invalid"); }
    const body = await readBounded(response);
    if (body.length < 2) throw new Error("science-comparative-genomics-response-invalid");
    return { body, retrievedAt: new Date().toISOString() };
  } finally { clearTimeout(timeout); }
}

function artifactPayload(assessment: ComparativeGenomicsAssessment, result: {
  runId: string; releaseEndpoint: string; treeEndpoint: string; releaseResponseSha256: string; treeResponseSha256: string;
}): JsonRecord {
  return {
    schema: "agentlas.science.comparative-genomics-artifact/v1",
    assessment: {
      schema: assessment.schema,
      provider: assessment.provider,
      providerRelease: assessment.providerRelease,
      request: assessment.request,
      title: assessment.title,
      geneTreeId: assessment.geneTreeId,
      rooted: assessment.rooted,
      targetNode: assessment.targetNode,
      nodes: assessment.nodes,
      alignment: assessment.alignment,
      diagnostics: assessment.diagnostics,
      publicationTable: assessment.publicationTable,
      evidenceBoundary: assessment.evidenceBoundary,
      warnings: assessment.warnings,
      deterministicHash: assessment.deterministicHash,
    },
    spec: assessment.spec,
    source: { runId: result.runId, releaseEndpoint: result.releaseEndpoint, treeEndpoint: result.treeEndpoint, releaseResponseSha256: result.releaseResponseSha256, treeResponseSha256: result.treeResponseSha256 },
  };
}

export class ScienceComparativeGenomicsService {
  constructor(private readonly store: ScienceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  private upsertSource(input: { requestId: string; projectId: string; canonicalUri: string; title: string; abstract: string; content: Buffer; retrievedAt: string; retrievalMethod: string }): ScienceSource {
    const contentSha256 = sha256(input.content);
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.canonicalUri);
    if (!existing) return this.store.createSource({
      requestId: stableUuid(`${input.requestId}:source:${input.canonicalUri}:${contentSha256}`), projectId: input.projectId,
      kind: "database-record", canonicalUri: input.canonicalUri, title: input.title, authors: ["Ensembl Project"], publicationYear: null,
      publisher: "Ensembl", containerTitle: "Ensembl REST API", abstract: input.abstract, accessState: "retrieved", contentSha256,
      mimeType: "application/json", retrievedAt: input.retrievedAt, retrievalMethod: input.retrievalMethod, license: "Ensembl Terms of Use",
    }, input.content).source;
    if (existing.version.contentSha256 === contentSha256 && existing.version.mimeType === "application/json") return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.canonicalUri}:${contentSha256}`), projectId: input.projectId,
      sourceId: existing.id, accessState: "retrieved", contentSha256, mimeType: "application/json", retrievedAt: input.retrievedAt,
      retrievalMethod: input.retrievalMethod, license: "Ensembl Terms of Use",
    }, input.content).source;
  }

  async build(input: ComparativeGenomicsInput): Promise<ComparativeGenomicsResult> {
    const engine = runtime();
    const request = { species: input.species, geneId: input.geneId, pruneTaxon: input.pruneTaxon, sequenceType: input.sequenceType };
    const built = engine.buildGeneTreeRequest(request);
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : `${request.geneId} · extant taxon ${request.pruneTaxon} comparative gene tree`;
    if (title.length > 240) throw new Error("science-comparative-genomics-title-invalid");
    const inputEnvelope = { schema: "agentlas.science-comparative-genomics-input/v1", request: built.input, releaseEndpoint: built.releaseUrl, treeEndpoint: built.treeUrl, title };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputs = [{ role: "comparative-genomics-query", mimeType: "application/vnd.agentlas.science.comparative-genomics-input+json", ...inputBlob, artifactId: null, artifactVersion: null }];
    const environmentSha256 = sha256(canonicalJson({ policy: "ensembl-compara-versioned-gene-tree-v1", plugin: `agentlas-comparative-genomics@${engine.PLUGIN_VERSION}`, origin: ENSEMBL_ORIGIN, runtime: "electron-main" }));
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: COMPARATIVE_GENOMICS_TOOL_ID, toolVersion: COMPARATIVE_GENOMICS_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson(inputs.map(runResourceEnvelope))), environmentSha256, inputs,
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") return this.replay(input.projectId, run.id, built.input, title, built.releaseUrl, built.treeUrl, true);
    if (created.replayed) throw new Error(`science-comparative-genomics-run-${run.status}`);
    let providerResponses: { release: Buffer; tree: Buffer } | null = null;
    try {
      const releaseResponse = await fetchJson(new URL(built.releaseUrl), this.fetchImpl);
      const treeResponse = await fetchJson(new URL(built.treeUrl), this.fetchImpl);
      providerResponses = { release: releaseResponse.body, tree: treeResponse.body };
      const releaseJson = parseJson(releaseResponse.body, "science-comparative-genomics-release-invalid");
      const treeJson = parseJson(treeResponse.body, "science-comparative-genomics-tree-invalid");
      let assessment: ComparativeGenomicsAssessment;
      try {
        assessment = engine.normalizeGeneTree({ request: built.input, releaseResponse: releaseJson, treeResponse: treeJson, title });
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 240) : "science-comparative-genomics-provider-validation-failed";
        const observedRoot = observedRootTaxonomy(treeJson);
        throw new ScienceComparativeGenomicsProviderValidationError({
          schema: "agentlas.science-comparative-genomics-provider-validation-failure/v1",
          runId: null,
          provider: "ensembl-compara",
          code,
          request: built.input,
          releaseEndpoint: built.releaseUrl,
          treeEndpoint: built.treeUrl,
          observedRootTaxonomyId: observedRoot.id,
          observedRootScientificName: observedRoot.scientificName,
          observedTaxonomyIds: observedTaxonomyIds(treeJson),
          releaseResponseSha256: sha256(releaseResponse.body),
          treeResponseSha256: sha256(treeResponse.body),
          retrievedAt: releaseResponse.retrievedAt > treeResponse.retrievedAt ? releaseResponse.retrievedAt : treeResponse.retrievedAt,
        });
      }
      const retrievedAt = releaseResponse.retrievedAt > treeResponse.retrievedAt ? releaseResponse.retrievedAt : treeResponse.retrievedAt;
      const releaseSource = this.upsertSource({ requestId: input.requestId, projectId: input.projectId, canonicalUri: built.releaseUrl, title: "Ensembl data release receipt", abstract: "Exact Ensembl release response used to version this comparative analysis.", content: releaseResponse.body, retrievedAt, retrievalMethod: `agentlas-comparative-genomics:release@${COMPARATIVE_GENOMICS_TOOL_VERSION}` });
      const treeSource = this.upsertSource({ requestId: input.requestId, projectId: input.projectId, canonicalUri: built.treeUrl, title, abstract: "Exact rooted Ensembl Compara gene tree and provider alignment; orthology, paralogy, alignment, and topology remain inferred.", content: treeResponse.body, retrievedAt, retrievalMethod: `agentlas-comparative-genomics:gene-tree@${COMPARATIVE_GENOMICS_TOOL_VERSION}` });
      const assessmentBytes = Buffer.from(engine.stableStringify(assessment), "utf8");
      const tableBytes = Buffer.from(engine.stableStringify(assessment.publicationTable), "utf8");
      const figureBytes = Buffer.from(engine.stableStringify(assessment.spec), "utf8");
      const outputs = [
        { role: "ensembl-release-response", mimeType: "application/json", ...this.store.putRunBlob(releaseResponse.body), artifactId: null, artifactVersion: null },
        { role: "ensembl-compara-gene-tree-response", mimeType: "application/json", ...this.store.putRunBlob(treeResponse.body), artifactId: null, artifactVersion: null },
        { role: "comparative-genomics-assessment", mimeType: "application/vnd.agentlas.comparative-genomics-gene-tree+json", ...this.store.putRunBlob(assessmentBytes), artifactId: null, artifactVersion: null },
        { role: "alignment-qc-publication-table", mimeType: "application/vnd.agentlas.science-table+json", ...this.store.putRunBlob(tableBytes), artifactId: null, artifactVersion: null },
        { role: "comparative-gene-tree-figure", mimeType: "application/vnd.vega.v5+json", ...this.store.putRunBlob(figureBytes), artifactId: null, artifactVersion: null },
      ];
      this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded", outputManifestSha256: sha256(canonicalJson(outputs.map(runResourceEnvelope))), summary: `${assessment.diagnostics.leafCount} extant aligned sequences in rooted Ensembl Compara tree ${assessment.geneTreeId}; ${assessment.diagnostics.duplicationNodeCount} duplication/gene-split nodes. No ancestral or extinct-species genome was emitted.`, outputs });
      return this.materialize(input.projectId, input.conversationId, input.originMessageId, run.id, assessment, releaseSource, treeSource, built.releaseUrl, built.treeUrl, sha256(releaseResponse.body), sha256(treeResponse.body), retrievedAt, false);
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      const outputs = error instanceof ScienceComparativeGenomicsProviderValidationError && providerResponses
        ? (() => {
            error.failureReceipt = { ...error.failureReceipt, runId: run.id };
            return [
              { role: "ensembl-release-response", mimeType: "application/json", ...this.store.putRunBlob(providerResponses.release), artifactId: null, artifactVersion: null },
              { role: "ensembl-compara-gene-tree-response", mimeType: "application/json", ...this.store.putRunBlob(providerResponses.tree), artifactId: null, artifactVersion: null },
              { role: "comparative-genomics-provider-validation-failure-receipt", mimeType: "application/vnd.agentlas.science.comparative-genomics-provider-validation-failure+json", ...this.store.putRunBlob(Buffer.from(canonicalJson(error.failureReceipt), "utf8")), artifactId: null, artifactVersion: null },
            ];
          })()
        : [];
      if (current?.status === "running") this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson(outputs.map(runResourceEnvelope))), summary: error instanceof Error ? error.message.slice(0, 1000) : "science-comparative-genomics-failed", outputs });
      throw error;
    }
  }

  private replay(projectId: string, runId: string, request: ComparativeGenomicsRequest, title: string, releaseEndpoint: string, treeEndpoint: string, replayed: boolean): ComparativeGenomicsResult {
    const engine = runtime();
    const run = this.store.getResearchRunForProject(projectId, runId);
    if (!run || run.status !== "succeeded" || run.toolId !== COMPARATIVE_GENOMICS_TOOL_ID || run.toolVersion !== COMPARATIVE_GENOMICS_TOOL_VERSION || run.outputs.length !== 5) throw new Error("science-comparative-genomics-replay-invalid");
    const releaseOutput = run.outputs.find((output) => output.role === "ensembl-release-response");
    const treeOutput = run.outputs.find((output) => output.role === "ensembl-compara-gene-tree-response");
    const assessmentOutput = run.outputs.find((output) => output.role === "comparative-genomics-assessment");
    if (!releaseOutput || !treeOutput || !assessmentOutput) throw new Error("science-comparative-genomics-replay-invalid");
    const releaseBytes = this.store.readRunBlob(releaseOutput);
    const treeBytes = this.store.readRunBlob(treeOutput);
    const assessment = engine.normalizeGeneTree({ request, releaseResponse: parseJson(releaseBytes, "science-comparative-genomics-replay-invalid"), treeResponse: parseJson(treeBytes, "science-comparative-genomics-replay-invalid"), title });
    const storedAssessment = this.store.readRunBlob(assessmentOutput);
    if (!storedAssessment.equals(Buffer.from(engine.stableStringify(assessment), "utf8"))) throw new Error("science-comparative-genomics-replay-invalid");
    const releaseSource = this.store.getSourceByCanonicalUriForProject(projectId, releaseEndpoint);
    const treeSource = this.store.getSourceByCanonicalUriForProject(projectId, treeEndpoint);
    if (!releaseSource || !treeSource || releaseSource.version.contentSha256 !== sha256(releaseBytes) || treeSource.version.contentSha256 !== sha256(treeBytes)) throw new Error("science-comparative-genomics-source-run-closure-invalid");
    return this.materialize(projectId, run.conversationId, run.originMessageId, run.id, assessment, releaseSource, treeSource, releaseEndpoint, treeEndpoint, sha256(releaseBytes), sha256(treeBytes), run.finishedAt ?? run.startedAt, replayed);
  }

  private materialize(projectId: string, conversationId: string, originMessageId: string, runId: string, assessment: ComparativeGenomicsAssessment, releaseSource: ScienceSource, treeSource: ScienceSource, releaseEndpoint: string, treeEndpoint: string, releaseResponseSha256: string, treeResponseSha256: string, retrievedAt: string, replayed: boolean): ComparativeGenomicsResult {
    const sourceBindings = this.store.bindSucceededResearchRunSources({
      projectId,
      runId,
      bindings: [
        { ordinal: 1, role: "ensembl-release-response", sourceId: releaseSource.id, sourceVersionId: releaseSource.version.id, outputOrdinal: 1 },
        { ordinal: 2, role: "ensembl-compara-gene-tree-response", sourceId: treeSource.id, sourceVersionId: treeSource.version.id, outputOrdinal: 2 },
      ],
    });
    if (sourceBindings[0]?.contentSha256 !== releaseResponseSha256 || sourceBindings[1]?.contentSha256 !== treeResponseSha256) {
      throw new Error("science-comparative-genomics-source-run-closure-invalid");
    }
    const payload = artifactPayload(assessment, { runId, releaseEndpoint, treeEndpoint, releaseResponseSha256, treeResponseSha256 });
    let artifact = this.store.getArtifactForSourceRun(projectId, runId, COMPARATIVE_GENOMICS_LAB_ID);
    if (artifact && canonicalJson(artifact.version.payload) !== canonicalJson(payload)) throw new Error("science-comparative-genomics-artifact-run-mismatch");
    if (!artifact) artifact = this.store.createArtifact({
      projectId, sourceRunId: runId, kind: "phylogeny.radial", title: assessment.title, rendererId: "agentlas.vega", rendererVersion: "6.4.0", rendererBinding: null, payload,
      semantic: {
        title: assessment.title,
        summary: `${assessment.diagnostics.leafCount} extant sequences in rooted Ensembl Compara gene tree ${assessment.geneTreeId}. This is not an extinct-species genome or ancestral sequence.`,
        entities: assessment.leaves.slice(0, 500).map((leaf) => ({ id: leaf.geneId, label: leaf.scientificName, type: "extant-gene-sequence" })),
        observations: [
          { label: "Extant aligned sequences", value: assessment.diagnostics.leafCount, unit: "count" },
          { label: "Alignment columns", value: assessment.alignment.length, unit: assessment.request.sequenceType === "protein" ? "aa" : "nt" },
          { label: "Duplication or gene-split nodes", value: assessment.diagnostics.duplicationNodeCount, unit: "count" },
        ],
        warnings: assessment.warnings,
      },
      provenance: { sourceRunId: runId, sourceRefs: [releaseEndpoint, treeEndpoint], datasetSha256: [releaseResponseSha256, treeResponseSha256, assessment.alignment.sha256, assessment.deterministicHash], codeSha256: sha256(`${COMPARATIVE_GENOMICS_TOOL_ID}@${COMPARATIVE_GENOMICS_TOOL_VERSION}:agentlas-comparative-genomics@0.2.0`), environmentSha256: this.store.getResearchRunForProject(projectId, runId)!.environmentSha256 },
      linkage: { labId: COMPARATIVE_GENOMICS_LAB_ID, origin: { surface: "conversation", conversationId, messageId: originMessageId, loopSessionId: null, runId, branchId: null }, parent: null, inputs: [] },
    });
    this.store.bindSucceededRunArtifact({ requestId: stableUuid(`science-comparative-genomics-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`), projectId, runId, outputOrdinal: 3, artifactId: artifact.id, artifactVersion: artifact.currentVersion, expectedArtifactContentSha256: artifact.version.contentSha256 });
    return { schema: "agentlas.science-comparative-genomics-result/v1", provider: "ensembl-compara", title: assessment.title, assessment, runId, releaseSourceId: releaseSource.id, releaseSourceVersionId: releaseSource.version.id, treeSourceId: treeSource.id, treeSourceVersionId: treeSource.version.id, releaseEndpoint, treeEndpoint, releaseResponseSha256, treeResponseSha256, retrievedAt, artifact, replayed };
  }
}
