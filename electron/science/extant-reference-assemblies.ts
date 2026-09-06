import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceResearchRunResource, ScienceSource } from "../../shared/science-contract";
import { ScienceStore } from "./store";
import { loadSciencePluginRuntime } from "./plugin-runtime";

export const EXTANT_REFERENCE_ASSEMBLY_TOOL_ID = "agentlas.extant-reference-assembly-manifest";
export const EXTANT_REFERENCE_ASSEMBLY_TOOL_VERSION = "1.0.0";
export const EXTANT_REFERENCE_ASSEMBLY_LAB_ID = "comparative-genomics";
const ENSEMBL_ORIGIN = "https://rest.ensembl.org";
const ENSEMBL_FTP_ORIGIN = "https://ftp.ensembl.org";
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FAILURE_RESPONSE_BYTES = 2 * 1024;
const MAX_FAILURE_RESPONSE_CHARACTERS = 1_000;

type JsonRecord = Record<string, unknown>;

export interface ExtantReferenceAssemblyRequest { species: string[] }

export interface ExtantReferenceAssemblyAssessment extends JsonRecord {
  schema: "agentlas.extant-reference-assembly-manifest/v1";
  provider: "ensembl";
  providerRelease: number[];
  request: ExtantReferenceAssemblyRequest;
  title: string;
  assemblies: Array<JsonRecord & {
    species: string;
    scientificName: string;
    taxonomyId: number;
    assemblyName: string;
    assemblyAccession: string;
    ensemblRelease: number;
    genomeRecordDataReleaseId: number;
    baseCount: number;
    topLevelRegionCount: number;
    fasta: JsonRecord & { filename: string; url: string; providerChecksum: string };
  }>;
  publicationTable: JsonRecord;
  evidenceBoundary: JsonRecord;
  warnings: string[];
  deterministicHash: string;
}

type Runtime = {
  PLUGIN_VERSION: string;
  ENSEMBL_ORIGIN: string;
  ENSEMBL_FTP_ORIGIN: string;
  stableStringify(value: unknown): string;
  buildReferenceAssemblyManifestRequest(input: ExtantReferenceAssemblyRequest): {
    input: ExtantReferenceAssemblyRequest;
    releaseUrl: string;
    requests: Array<{ species: string; genomeUrl: string; assemblyUrl: string; readmeUrl: string; checksumsUrl: string; fastaBaseUrl: string }>;
  };
  normalizeReferenceAssemblyManifest(input: {
    request: ExtantReferenceAssemblyRequest;
    releaseResponse: JsonRecord;
    speciesResponses: Array<{ species: string; genomeResponse: JsonRecord; assemblyResponse: JsonRecord; readmeText: string; checksumsText: string }>;
    title: string;
  }): ExtantReferenceAssemblyAssessment;
};

export interface ExtantReferenceAssemblyInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  species: string[];
  title?: string;
}

export interface ExtantReferenceAssemblyResult {
  schema: "agentlas.science-extant-reference-assembly-result/v1";
  provider: "ensembl";
  title: string;
  assessment: ExtantReferenceAssemblyAssessment;
  runId: string;
  sources: Array<{ id: string; versionId: string; url: string; sha256: string; role: string }>;
  artifact: ScienceArtifact;
  retrievedAt: string;
  replayed: boolean;
}

export interface ExtantReferenceAssemblyFailureReceipt extends JsonRecord {
  schema: "agentlas.science-extant-reference-assembly-failure-receipt/v1";
  runId: string | null;
  provider: "ensembl";
  status: number;
  endpoint: string;
  species: string | null;
  requestKind: "json" | "text";
  responseContentType: string;
  responseSnippet: string;
  responseSnippetBytes: number;
  responseSnippetSha256: string;
  responseSnippetTruncated: boolean;
  retrievedAt: string;
}

export class ScienceExtantReferenceAssemblyHttpError extends Error {
  constructor(public failureReceipt: ExtantReferenceAssemblyFailureReceipt) {
    super(`science-extant-reference-assembly-http-${failureReceipt.status}`);
    this.name = "ScienceExtantReferenceAssemblyHttpError";
  }
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
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
function envelope(resource: Pick<ScienceResearchRunResource, "role" | "mimeType" | "byteSize" | "sha256" | "blobRef" | "artifactId" | "artifactVersion">): JsonRecord {
  return { role: resource.role, mimeType: resource.mimeType, byteSize: resource.byteSize, sha256: resource.sha256, blobRef: resource.blobRef, artifactId: resource.artifactId, artifactVersion: resource.artifactVersion };
}
function runtime(): Runtime {
  const loaded = loadSciencePluginRuntime<Partial<Runtime>>("agentlas-comparative-genomics", "runtime/comparative-genomics.cjs", 12 * 1024 * 1024).runtime;
  if (loaded.PLUGIN_VERSION !== "0.2.0" || loaded.ENSEMBL_ORIGIN !== ENSEMBL_ORIGIN || loaded.ENSEMBL_FTP_ORIGIN !== ENSEMBL_FTP_ORIGIN
    || typeof loaded.stableStringify !== "function" || typeof loaded.buildReferenceAssemblyManifestRequest !== "function"
    || typeof loaded.normalizeReferenceAssemblyManifest !== "function") throw new Error("science-extant-reference-assembly-runtime-invalid");
  return loaded as Runtime;
}
function parseJson(bytes: Buffer, code: string): JsonRecord {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(code);
    return parsed as JsonRecord;
  } catch { throw new Error(code); }
}
function parseText(bytes: Buffer, code: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(code); }
}
async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new Error("science-extant-reference-assembly-response-too-large");
  if (!response.body) throw new Error("science-extant-reference-assembly-response-invalid");
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maximum) { await reader.cancel(); throw new Error("science-extant-reference-assembly-response-too-large"); }
    chunks.push(chunk);
  }
  if (total < 1) throw new Error("science-extant-reference-assembly-response-invalid");
  return Buffer.concat(chunks, total);
}
async function readFailureResponse(response: Response): Promise<{ body: Buffer; truncated: boolean }> {
  if (!response.body) return { body: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = MAX_FAILURE_RESPONSE_BYTES - total;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total = MAX_FAILURE_RESPONSE_BYTES;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
      if (total === MAX_FAILURE_RESPONSE_BYTES) {
        const next = await reader.read();
        truncated = !next.done;
        if (!next.done) await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    truncated = true;
    await reader.cancel().catch(() => undefined);
  }
  return { body: Buffer.concat(chunks, total), truncated };
}
function safeFailureSnippet(bytes: Buffer): { text: string; characterTruncated: boolean } {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "\ufffd");
  return { text: decoded.slice(0, MAX_FAILURE_RESPONSE_CHARACTERS), characterTruncated: decoded.length > MAX_FAILURE_RESPONSE_CHARACTERS };
}
async function fetchExact(url: string, kind: "json" | "text", fetchImpl: typeof fetch, species: string | null): Promise<{ body: Buffer; retrievedAt: string }> {
  const parsed = new URL(url);
  const restAllowed = parsed.origin === ENSEMBL_ORIGIN && (parsed.pathname === "/info/data" || parsed.pathname.startsWith("/info/genomes/") || parsed.pathname.startsWith("/info/assembly/"));
  const ftpAllowed = parsed.origin === ENSEMBL_FTP_ORIGIN && /^\/pub\/current_fasta\/[a-z][a-z0-9_]+\/dna\/(?:README|CHECKSUMS)$/u.test(parsed.pathname);
  if ((kind === "json" && !restAllowed) || (kind === "text" && !ftpAllowed)) throw new Error("science-extant-reference-assembly-endpoint-denied");
  const retryableStatuses = new Set([429, 500, 502, 503, 504]);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35_000);
    try {
      const response = await fetchImpl(parsed, { signal: controller.signal, redirect: "error", headers: { accept: kind === "json" ? "application/json" : "text/plain,*/*;q=0.1", "user-agent": "Agentlas-Science/1.0 (extant reference assembly manifest; https://agentlas.ai)" } });
      if (response.status !== 200) {
        const retrievedAt = new Date().toISOString();
        const captured = await readFailureResponse(response);
        const snippet = safeFailureSnippet(captured.body);
        const error = new ScienceExtantReferenceAssemblyHttpError({
          schema: "agentlas.science-extant-reference-assembly-failure-receipt/v1",
          runId: null,
          provider: "ensembl",
          status: response.status,
          endpoint: parsed.toString(),
          species,
          requestKind: kind,
          responseContentType: (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim().slice(0, 120),
          responseSnippet: snippet.text,
          responseSnippetBytes: captured.body.length,
          responseSnippetSha256: sha256(captured.body),
          responseSnippetTruncated: captured.truncated || snippet.characterTruncated,
          retrievedAt,
        });
        if (!retryableStatuses.has(response.status) || attempt === 2) throw error;
        lastError = error;
      } else {
        const mime = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim();
        if (kind === "json" && mime !== "application/json") { await response.body?.cancel().catch(() => undefined); throw new Error("science-extant-reference-assembly-response-invalid"); }
        if (kind === "text" && !["text/plain", "application/octet-stream", ""].includes(mime)) { await response.body?.cancel().catch(() => undefined); throw new Error("science-extant-reference-assembly-response-invalid"); }
        return { body: await readBounded(response, kind === "json" ? MAX_JSON_BYTES : MAX_TEXT_BYTES), retrievedAt: new Date().toISOString() };
      }
    } catch (error) {
      lastError = error;
      const transientNetworkFailure = error instanceof Error && (error.name === "AbortError" || error.name === "TypeError");
      if (!transientNetworkFailure || attempt === 2) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("science-extant-reference-assembly-fetch-failed");
}

export class ScienceExtantReferenceAssemblyService {
  constructor(private readonly store: ScienceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  private upsertSource(input: { requestId: string; projectId: string; url: string; title: string; content: Buffer; mimeType: string; retrievedAt: string; role: string }): ScienceSource {
    const digest = sha256(input.content);
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.url);
    if (!existing) return this.store.createSource({
      requestId: stableUuid(`${input.requestId}:source:${input.url}:${digest}`), projectId: input.projectId, kind: "database-record", canonicalUri: input.url,
      title: input.title, authors: ["Ensembl Project"], publicationYear: null, publisher: "Ensembl", containerTitle: "Ensembl data service",
      abstract: `Exact provider bytes for ${input.role}.`, accessState: "retrieved", contentSha256: digest, mimeType: input.mimeType,
      retrievedAt: input.retrievedAt, retrievalMethod: `agentlas-extant-reference-assembly:${input.role}@${EXTANT_REFERENCE_ASSEMBLY_TOOL_VERSION}`, license: "Ensembl Terms of Use",
    }, input.content).source;
    if (existing.version.contentSha256 === digest && existing.version.mimeType === input.mimeType) return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.url}:${digest}`), projectId: input.projectId, sourceId: existing.id,
      accessState: "retrieved", contentSha256: digest, mimeType: input.mimeType, retrievedAt: input.retrievedAt,
      retrievalMethod: `agentlas-extant-reference-assembly:${input.role}@${EXTANT_REFERENCE_ASSEMBLY_TOOL_VERSION}`, license: "Ensembl Terms of Use",
    }, input.content).source;
  }

  async build(input: ExtantReferenceAssemblyInput): Promise<ExtantReferenceAssemblyResult> {
    const engine = runtime();
    const built = engine.buildReferenceAssemblyManifestRequest({ species: input.species });
    const title = input.title?.trim() || "Version-pinned extant reference assembly manifest";
    if (!title || title.length > 240) throw new Error("science-extant-reference-assembly-title-invalid");
    const descriptor = { schema: "agentlas.science-extant-reference-assembly-input/v1", request: built.input, releaseEndpoint: built.releaseUrl, speciesEndpoints: built.requests, title };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(descriptor), "utf8"));
    const inputs = [{ role: "reference-assembly-manifest-query", mimeType: "application/vnd.agentlas.science.extant-reference-assembly-input+json", ...inputBlob, artifactId: null, artifactVersion: null }];
    const environmentSha256 = sha256(canonicalJson({ policy: "ensembl-extant-reference-assembly-manifest-v1", plugin: `agentlas-comparative-genomics@${engine.PLUGIN_VERSION}`, origins: [ENSEMBL_ORIGIN, ENSEMBL_FTP_ORIGIN], runtime: "electron-main" }));
    const created = this.store.createResearchRun({ requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId, toolId: EXTANT_REFERENCE_ASSEMBLY_TOOL_ID, toolVersion: EXTANT_REFERENCE_ASSEMBLY_TOOL_VERSION, runtime: "electron-main", inputManifestSha256: sha256(canonicalJson(inputs.map(envelope))), environmentSha256, inputs });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") return this.replay(input.projectId, run.id, built.input, title, built, true);
    if (created.replayed) throw new Error(`science-extant-reference-assembly-run-${run.status}`);
    try {
      const release = await fetchExact(built.releaseUrl, "json", this.fetchImpl, null);
      const rawSpecies = [];
      for (const request of built.requests) {
        const genome = await fetchExact(request.genomeUrl, "json", this.fetchImpl, request.species);
        const assembly = await fetchExact(request.assemblyUrl, "json", this.fetchImpl, request.species);
        const readme = await fetchExact(request.readmeUrl, "text", this.fetchImpl, request.species);
        const checksums = await fetchExact(request.checksumsUrl, "text", this.fetchImpl, request.species);
        rawSpecies.push({ request, genome, assembly, readme, checksums });
      }
      const assessment = engine.normalizeReferenceAssemblyManifest({
        request: built.input, releaseResponse: parseJson(release.body, "science-extant-reference-assembly-release-invalid"), title,
        speciesResponses: rawSpecies.map((item) => ({ species: item.request.species, genomeResponse: parseJson(item.genome.body, "science-extant-reference-assembly-genome-invalid"), assemblyResponse: parseJson(item.assembly.body, "science-extant-reference-assembly-assembly-invalid"), readmeText: parseText(item.readme.body, "science-extant-reference-assembly-readme-invalid"), checksumsText: parseText(item.checksums.body, "science-extant-reference-assembly-checksums-invalid") })),
      });
      const raw = [{ role: "ensembl-release-response", url: built.releaseUrl, title: "Ensembl data release receipt", mimeType: "application/json", ...release }];
      for (const item of rawSpecies) raw.push(
        { role: `ensembl-genome-metadata:${item.request.species}`, url: item.request.genomeUrl, title: `${item.request.species} genome metadata`, mimeType: "application/json", ...item.genome },
        { role: `ensembl-assembly-metadata:${item.request.species}`, url: item.request.assemblyUrl, title: `${item.request.species} assembly metadata`, mimeType: "application/json", ...item.assembly },
        { role: `ensembl-fasta-readme:${item.request.species}`, url: item.request.readmeUrl, title: `${item.request.species} FASTA README`, mimeType: "text/plain", ...item.readme },
        { role: `ensembl-fasta-checksums:${item.request.species}`, url: item.request.checksumsUrl, title: `${item.request.species} FASTA checksums`, mimeType: "text/plain", ...item.checksums },
      );
      const sources = raw.map((item) => ({ ...item, source: this.upsertSource({ requestId: input.requestId, projectId: input.projectId, url: item.url, title: item.title, content: item.body, mimeType: item.mimeType, retrievedAt: item.retrievedAt, role: item.role }) }));
      const outputs = raw.map((item) => ({ role: item.role, mimeType: item.mimeType, ...this.store.putRunBlob(item.body), artifactId: null, artifactVersion: null }));
      const assessmentOrdinal = outputs.length + 1;
      outputs.push({ role: "extant-reference-assembly-assessment", mimeType: "application/vnd.agentlas.extant-reference-assembly-manifest+json", ...this.store.putRunBlob(Buffer.from(engine.stableStringify(assessment), "utf8")), artifactId: null, artifactVersion: null });
      outputs.push({ role: "extant-reference-assembly-publication-table", mimeType: "application/vnd.agentlas.science-table+json", ...this.store.putRunBlob(Buffer.from(engine.stableStringify(assessment.publicationTable), "utf8")), artifactId: null, artifactVersion: null });
      this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded", outputManifestSha256: sha256(canonicalJson(outputs.map(envelope))), summary: `${assessment.assemblies.length} extant Ensembl assemblies were version-pinned to provider metadata and FASTA asset checksums; sequence contents were not downloaded.`, outputs });
      return this.materialize(input.projectId, input.conversationId, input.originMessageId, run.id, assessment, sources.map((item) => ({ source: item.source, url: item.url, sha256: sha256(item.body), role: item.role })), Math.max(...raw.map((item) => Date.parse(item.retrievedAt))), assessmentOrdinal, false);
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      const outputs = error instanceof ScienceExtantReferenceAssemblyHttpError
        ? [{
            role: "extant-reference-assembly-failure-receipt",
            mimeType: "application/vnd.agentlas.science.extant-reference-assembly-failure-receipt+json",
            ...this.store.putRunBlob(Buffer.from(canonicalJson({ ...error.failureReceipt, runId: run.id }), "utf8")),
            artifactId: null,
            artifactVersion: null,
          }]
        : [];
      if (error instanceof ScienceExtantReferenceAssemblyHttpError) error.failureReceipt = { ...error.failureReceipt, runId: run.id };
      if (current?.status === "running") this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson(outputs.map(envelope))), summary: error instanceof Error ? error.message.slice(0, 1000) : "science-extant-reference-assembly-failed", outputs });
      throw error;
    }
  }

  private replay(projectId: string, runId: string, request: ExtantReferenceAssemblyRequest, title: string, built: ReturnType<Runtime["buildReferenceAssemblyManifestRequest"]>, replayed: boolean): ExtantReferenceAssemblyResult {
    const engine = runtime();
    const run = this.store.getResearchRunForProject(projectId, runId);
    const rawCount = 1 + built.requests.length * 4;
    if (!run || run.status !== "succeeded" || run.toolId !== EXTANT_REFERENCE_ASSEMBLY_TOOL_ID || run.toolVersion !== EXTANT_REFERENCE_ASSEMBLY_TOOL_VERSION || run.outputs.length !== rawCount + 2) throw new Error("science-extant-reference-assembly-replay-invalid");
    const rawOutputs = run.outputs.slice(0, rawCount);
    const rawBytes = rawOutputs.map((output) => this.store.readRunBlob(output));
    const releaseResponse = parseJson(rawBytes[0]!, "science-extant-reference-assembly-replay-invalid");
    const speciesResponses = built.requests.map((item, index) => ({ species: item.species, genomeResponse: parseJson(rawBytes[1 + index * 4]!, "science-extant-reference-assembly-replay-invalid"), assemblyResponse: parseJson(rawBytes[2 + index * 4]!, "science-extant-reference-assembly-replay-invalid"), readmeText: parseText(rawBytes[3 + index * 4]!, "science-extant-reference-assembly-replay-invalid"), checksumsText: parseText(rawBytes[4 + index * 4]!, "science-extant-reference-assembly-replay-invalid") }));
    const assessment = engine.normalizeReferenceAssemblyManifest({ request, releaseResponse, speciesResponses, title });
    if (!this.store.readRunBlob(run.outputs[rawCount]!).equals(Buffer.from(engine.stableStringify(assessment), "utf8"))) throw new Error("science-extant-reference-assembly-replay-invalid");
    const endpoints = [built.releaseUrl, ...built.requests.flatMap((item) => [item.genomeUrl, item.assemblyUrl, item.readmeUrl, item.checksumsUrl])];
    const sources = endpoints.map((url, index) => {
      const source = this.store.getSourceByCanonicalUriForProject(projectId, url);
      if (!source || source.version.contentSha256 !== sha256(rawBytes[index]!)) throw new Error("science-extant-reference-assembly-source-run-closure-invalid");
      return { source, url, sha256: sha256(rawBytes[index]!), role: rawOutputs[index]!.role };
    });
    return this.materialize(projectId, run.conversationId, run.originMessageId, run.id, assessment, sources, Date.parse(run.finishedAt ?? run.startedAt), rawCount + 1, replayed);
  }

  private materialize(projectId: string, conversationId: string, originMessageId: string, runId: string, assessment: ExtantReferenceAssemblyAssessment, sources: Array<{ source: ScienceSource; url: string; sha256: string; role: string }>, retrievedAtMs: number, assessmentOrdinal: number, replayed: boolean): ExtantReferenceAssemblyResult {
    const bindings = this.store.bindSucceededResearchRunSources({ projectId, runId, bindings: sources.map((item, index) => ({ ordinal: index + 1, role: item.role, sourceId: item.source.id, sourceVersionId: item.source.version.id, outputOrdinal: index + 1 })) });
    if (bindings.some((binding, index) => binding.contentSha256 !== sources[index]!.sha256)) throw new Error("science-extant-reference-assembly-source-run-closure-invalid");
    let artifact = this.store.getArtifactForSourceRun(projectId, runId, EXTANT_REFERENCE_ASSEMBLY_LAB_ID);
    if (artifact && (artifact.kind !== "table" || artifact.version.rendererId !== "agentlas.table" || canonicalJson(artifact.version.payload) !== canonicalJson(assessment.publicationTable))) throw new Error("science-extant-reference-assembly-artifact-run-mismatch");
    if (!artifact) artifact = this.store.createArtifact({
      projectId, sourceRunId: runId, kind: "table", title: assessment.title, rendererId: "agentlas.table", rendererVersion: "1.0.0", rendererBinding: null, payload: assessment.publicationTable,
      semantic: { title: assessment.title, summary: `${assessment.assemblies.length} extant Ensembl reference assemblies pinned to accessions and provider FASTA checksums; sequence contents were not downloaded.`, entities: assessment.assemblies.map((item) => ({ id: item.assemblyAccession, label: item.scientificName, type: "extant-reference-assembly" })), observations: [{ label: "Assemblies", value: assessment.assemblies.length, unit: "count" }, { label: "Downloaded FASTA files", value: 0, unit: "count" }], warnings: assessment.warnings },
      provenance: { sourceRunId: runId, sourceRefs: sources.map((item) => item.url), datasetSha256: [...sources.map((item) => item.sha256), sha256(canonicalJson(assessment.publicationTable)), assessment.deterministicHash], codeSha256: sha256(`${EXTANT_REFERENCE_ASSEMBLY_TOOL_ID}@${EXTANT_REFERENCE_ASSEMBLY_TOOL_VERSION}:agentlas-comparative-genomics@0.2.0`), environmentSha256: this.store.getResearchRunForProject(projectId, runId)!.environmentSha256 },
      linkage: { labId: EXTANT_REFERENCE_ASSEMBLY_LAB_ID, origin: { surface: "conversation", conversationId, messageId: originMessageId, loopSessionId: null, runId, branchId: null }, parent: null, inputs: [] },
    });
    this.store.bindSucceededRunArtifact({ requestId: stableUuid(`science-extant-reference-assembly-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`), projectId, runId, outputOrdinal: assessmentOrdinal, artifactId: artifact.id, artifactVersion: artifact.currentVersion, expectedArtifactContentSha256: artifact.version.contentSha256 });
    return { schema: "agentlas.science-extant-reference-assembly-result/v1", provider: "ensembl", title: assessment.title, assessment, runId, sources: sources.map((item) => ({ id: item.source.id, versionId: item.source.version.id, url: item.url, sha256: item.sha256, role: item.role })), artifact, retrievedAt: new Date(retrievedAtMs).toISOString(), replayed };
  }
}
