import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceResearchRunResource, ScienceSource } from "../../shared/science-contract";
import jbrowseRuntimeManifest from "../../shared/science-jbrowse-runtime.json";
import { ScienceStore } from "./store";

export const GENOMICS_CATALOG_TOOL_ID = "agentlas.ensembl-variant-track";
export const GENOMICS_CATALOG_TOOL_VERSION = "1.1.0";
export const ENSEMBL_REST_ORIGIN = "https://rest.ensembl.org";
const MAX_ENSEMBL_RESPONSE_BYTES = 32 * 1024 * 1024;
const JBROWSE_RENDERER_ID = "agentlas.jbrowse" as const;

if (jbrowseRuntimeManifest.schema !== "agentlas.science-jbrowse-runtime-manifest/v1"
  || jbrowseRuntimeManifest.rendererId !== JBROWSE_RENDERER_ID
  || jbrowseRuntimeManifest.projectionVersion !== 2
  || !/^[a-f0-9]{64}$/.test(jbrowseRuntimeManifest.entrySha256)) {
  throw new Error("science-jbrowse-runtime-manifest-invalid");
}

export interface GenomicsVariantTrackInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  species: string;
  assembly: string;
  refName: string;
  start: number;
  end: number;
  title?: string;
}

export interface GenomicsVariant {
  id: string;
  name: string;
  refName: string;
  start: number;
  end: number;
  start0: number;
  end0: number;
  strand: number;
  source: string;
  alleles: string[];
  consequenceTypes: string[];
  clinicalSignificance: string[];
}

export interface GenomicsVariantTrackResult {
  schema: "agentlas.genomics-variant-track-result/v1";
  provider: "ensembl-rest";
  query: {
    species: string;
    assembly: string;
    refName: string;
    start: number;
    end: number;
    variantSet: "ClinVar";
  };
  title: string;
  assembly: {
    name: string;
    defaultCoordSystemVersion: string;
    refNameLength: number;
    aliases: string[];
  };
  variants: GenomicsVariant[];
  assemblySourceId: string;
  assemblySourceVersionId: string;
  variantSourceId: string;
  variantSourceVersionId: string;
  assemblyEndpoint: string;
  variantEndpoint: string;
  assemblyResponseSha256: string;
  variantResponseSha256: string;
  retrievedAt: string;
  runId: string;
  artifact: ScienceArtifact;
  replayed: boolean;
}

type StoredGenomicsVariantTrackResult = Omit<GenomicsVariantTrackResult, "artifact" | "replayed">;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function genomicsEnvironmentSha256(): string {
  return sha256(canonicalJson({
    policy: "ensembl-clinvar-region-v2",
    origin: ENSEMBL_REST_ORIGIN,
    runtime: "electron-main",
    toolVersion: GENOMICS_CATALOG_TOOL_VERSION,
  }));
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function safeToken(value: unknown, maximum: number, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) throw new Error(code);
  return value;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= maximum && !/[\u0000-\u001f]/.test(text) ? text : null;
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(code);
  return Number(value);
}

function stringArray(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => optionalText(item, maximumLength)).filter((item): item is string => Boolean(item)))].slice(0, maximumItems);
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(code);
  }
}

function runResourceEnvelope(resource: ScienceResearchRunResource): Record<string, unknown> {
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

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null
    && (!/^\d+$/u.test(declaredHeader) || Number(declaredHeader) > MAX_ENSEMBL_RESPONSE_BYTES)) {
    throw new Error("science-genomics-response-size-invalid");
  }
  if (!response.body) throw new Error("science-genomics-response-invalid");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > MAX_ENSEMBL_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("science-genomics-response-size-invalid");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function fetchEnsembl(url: URL, fetchImpl: typeof fetch, timeoutMs = 25_000): Promise<{ body: Buffer; status: number; retrievedAt: string }> {
  if (url.origin !== ENSEMBL_REST_ORIGIN || !url.pathname.startsWith("/info/assembly/") && !url.pathname.startsWith("/overlap/region/")) {
    throw new Error("science-genomics-endpoint-denied");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "Agentlas-Science/1.0 (genomics research; https://agentlas.ai)",
      },
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`science-genomics-http-${response.status}`);
    }
    const mime = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim();
    if (mime !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("science-genomics-response-invalid");
    }
    const body = await readBoundedResponse(response);
    if (body.length < 2) throw new Error("science-genomics-response-invalid");
    return { body, status: response.status, retrievedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}

function parseAssembly(value: unknown, requestedAssembly: string, refName: string, end: number): GenomicsVariantTrackResult["assembly"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-genomics-assembly-response-invalid");
  const record = value as Record<string, unknown>;
  const name = optionalText(record.assembly_name, 120);
  const defaultCoordSystemVersion = optionalText(record.default_coord_system_version, 120);
  if (!name || !defaultCoordSystemVersion || requestedAssembly !== name && requestedAssembly !== defaultCoordSystemVersion) {
    throw new Error("science-genomics-assembly-mismatch");
  }
  if (!Array.isArray(record.top_level_region)) throw new Error("science-genomics-assembly-regions-invalid");
  const region = record.top_level_region.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return String((entry as Record<string, unknown>).name ?? "") === refName;
  }) as Record<string, unknown> | undefined;
  if (!region) throw new Error("science-genomics-reference-not-found");
  const refNameLength = integer(region.length, end, 500_000_000, "science-genomics-reference-length-invalid");
  const aliases = stringArray(region.synonyms, 24, 120);
  return { name, defaultCoordSystemVersion, refNameLength, aliases };
}

function parseVariant(value: unknown, index: number, refName: string, rangeStart: number, rangeEnd: number, refNameLength: number): GenomicsVariant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`science-genomics-variant-${index}-invalid`);
  const record = value as Record<string, unknown>;
  const name = optionalText(record.id, 240) ?? optionalText(record.name, 240);
  const rowRefName = optionalText(record.seq_region_name, 120);
  const start = integer(record.start, 1, refNameLength, `science-genomics-variant-${index}-start-invalid`);
  const end = integer(record.end, 0, refNameLength, `science-genomics-variant-${index}-end-invalid`);
  const isInsertion = end === start - 1;
  if (!name || rowRefName !== refName) throw new Error(`science-genomics-variant-${index}-invalid`);
  if (!isInsertion && end < start) throw new Error(`science-genomics-variant-${index}-end-invalid`);
  const overlapsRequestedRegion = end >= rangeStart && start <= rangeEnd;
  if (!overlapsRequestedRegion) throw new Error(`science-genomics-variant-${index}-outside-requested-region`);
  const strand = record.strand === -1 ? -1 : record.strand === 1 ? 1 : 0;
  const source = optionalText(record.source, 120) ?? "Ensembl";
  const consequenceTypes = stringArray(
    Array.isArray(record.consequence_type) ? record.consequence_type : record.consequence_type ? [record.consequence_type] : [],
    24,
    160,
  );
  return {
    id: stableUuid(`ensembl-variation:v1:${name}:${refName}:${start}:${end}`),
    name,
    refName,
    start,
    end,
    start0: start - 1,
    end0: end,
    strand,
    source,
    alleles: stringArray(record.alleles, 24, 240),
    consequenceTypes,
    clinicalSignificance: stringArray(record.clinical_significance, 24, 160),
  };
}

function parseVariants(value: unknown, refName: string, start: number, end: number, refNameLength: number): GenomicsVariant[] {
  if (!Array.isArray(value)) throw new Error("science-genomics-variants-response-invalid");
  if (value.length > 8_000) throw new Error("science-genomics-region-too-dense");
  const variants = value.map((row, index) => parseVariant(row, index, refName, start, end, refNameLength));
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) throw new Error("science-genomics-variant-duplicate");
  return variants.sort((left, right) => left.start - right.start || left.end - right.end || left.name.localeCompare(right.name, "en"));
}

function genomicsArtifactPayload(result: StoredGenomicsVariantTrackResult): Record<string, unknown> {
  return {
    schema: "agentlas.science-genomics-variant-track/v1",
    assembly: {
      species: result.query.species,
      name: result.assembly.name,
      defaultCoordSystemVersion: result.assembly.defaultCoordSystemVersion,
      refNameLength: result.assembly.refNameLength,
      aliases: result.assembly.aliases,
    },
    region: { refName: result.query.refName, start: result.query.start, end: result.query.end },
    variants: result.variants,
    provenance: {
      runId: result.runId,
      assemblySourceId: result.assemblySourceId,
      assemblySourceVersionId: result.assemblySourceVersionId,
      variantSourceId: result.variantSourceId,
      variantSourceVersionId: result.variantSourceVersionId,
      assemblyEndpoint: result.assemblyEndpoint,
      variantEndpoint: result.variantEndpoint,
      assemblyResponseSha256: result.assemblyResponseSha256,
      variantResponseSha256: result.variantResponseSha256,
      retrievedAt: result.retrievedAt,
    },
  };
}

export class ScienceGenomicsCatalogService {
  constructor(private readonly store: ScienceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  private upsertSource(input: {
    requestId: string; projectId: string; canonicalUri: string; title: string; publisher: string;
    abstract: string; content: Buffer; retrievedAt: string; retrievalMethod: string;
  }): ScienceSource {
    const contentSha256 = sha256(input.content);
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.canonicalUri);
    if (!existing) {
      return this.store.createSource({
        requestId: stableUuid(`${input.requestId}:source:${input.canonicalUri}:${contentSha256}`),
        projectId: input.projectId, kind: "database-record", canonicalUri: input.canonicalUri, title: input.title,
        authors: ["Ensembl Project"], publicationYear: null, publisher: input.publisher, containerTitle: "Ensembl REST API",
        abstract: input.abstract, accessState: "retrieved", contentSha256, mimeType: "application/json",
        retrievedAt: input.retrievedAt, retrievalMethod: input.retrievalMethod, license: "Ensembl Terms of Use",
      }, input.content).source;
    }
    if (existing.version.contentSha256 === contentSha256 && existing.version.mimeType === "application/json") return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.canonicalUri}:${contentSha256}`), projectId: input.projectId,
      sourceId: existing.id, accessState: "retrieved", contentSha256, mimeType: "application/json", retrievedAt: input.retrievedAt,
      retrievalMethod: input.retrievalMethod, license: "Ensembl Terms of Use",
    }, input.content).source;
  }

  private storedResultForRun(projectId: string, runId: string): StoredGenomicsVariantTrackResult {
    const run = this.store.getResearchRunForProject(projectId, runId);
    const input = run?.inputs[0];
    const assemblyOutput = run?.outputs[0];
    const variantOutput = run?.outputs[1];
    const resultOutput = run?.outputs[2];
    if (!run || run.status !== "succeeded" || run.toolId !== GENOMICS_CATALOG_TOOL_ID || run.toolVersion !== GENOMICS_CATALOG_TOOL_VERSION
      || run.environmentSha256 !== genomicsEnvironmentSha256()
      || run.inputs.length !== 1 || input?.role !== "genomics-query" || input.mimeType !== "application/vnd.agentlas.genomics-variant-track-query+json"
      || run.inputManifestSha256 !== sha256(canonicalJson(run.inputs.map(runResourceEnvelope)))
      || run.outputs.length !== 3 || assemblyOutput?.role !== "assembly-response" || assemblyOutput.mimeType !== "application/json"
      || variantOutput?.role !== "provider-response" || variantOutput.mimeType !== "application/json"
      || resultOutput?.role !== "genomics-catalog" || resultOutput.mimeType !== "application/vnd.agentlas.genomics-variant-track-result+json"
      || run.outputManifestSha256 !== sha256(canonicalJson(run.outputs.map(runResourceEnvelope)))) {
      throw new Error("science-genomics-run-closure-invalid");
    }
    const inputBytes = this.store.readRunBlob(input);
    const assemblyBytes = this.store.readRunBlob(assemblyOutput);
    const variantBytes = this.store.readRunBlob(variantOutput);
    const resultBytes = this.store.readRunBlob(resultOutput);
    let envelopeValue: unknown;
    let assemblyValue: unknown;
    let variantsValue: unknown;
    let storedValue: unknown;
    try {
      envelopeValue = parseJson(inputBytes, "science-genomics-run-closure-invalid");
      assemblyValue = parseJson(assemblyBytes, "science-genomics-run-closure-invalid");
      variantsValue = parseJson(variantBytes, "science-genomics-run-closure-invalid");
      storedValue = parseJson(resultBytes, "science-genomics-run-closure-invalid");
    } catch { throw new Error("science-genomics-run-closure-invalid"); }
    const envelope = record(envelopeValue);
    const queryValue = record(envelope?.query);
    const storedRecord = record(storedValue);
    if (!envelope || !exactKeys(envelope, ["schema", "provider", "query", "assemblyEndpoint", "variantEndpoint", "title"])
      || envelope.schema !== "agentlas.genomics-variant-track-query/v1" || envelope.provider !== "ensembl-rest"
      || !queryValue || !exactKeys(queryValue, ["species", "assembly", "refName", "start", "end", "variantSet"])
      || queryValue.variantSet !== "ClinVar"
      || !storedRecord || !exactKeys(storedRecord, [
        "schema", "provider", "query", "title", "assembly", "variants",
        "assemblySourceId", "assemblySourceVersionId", "variantSourceId", "variantSourceVersionId",
        "assemblyEndpoint", "variantEndpoint", "assemblyResponseSha256", "variantResponseSha256", "retrievedAt", "runId",
      ])
      || storedRecord.schema !== "agentlas.genomics-variant-track-result/v1" || storedRecord.provider !== "ensembl-rest"
      || storedRecord.runId !== runId || storedRecord.title !== envelope.title
      || storedRecord.assemblyEndpoint !== envelope.assemblyEndpoint || storedRecord.variantEndpoint !== envelope.variantEndpoint
      || typeof storedRecord.retrievedAt !== "string" || !Number.isFinite(Date.parse(storedRecord.retrievedAt))) {
      throw new Error("science-genomics-run-closure-invalid");
    }
    const query = {
      species: safeToken(queryValue.species, 80, /^[a-z][a-z0-9_]+$/, "science-genomics-run-closure-invalid"),
      assembly: safeToken(queryValue.assembly, 120, /^[A-Za-z0-9_.-]+$/, "science-genomics-run-closure-invalid"),
      refName: safeToken(queryValue.refName, 120, /^[A-Za-z0-9_.-]+$/, "science-genomics-run-closure-invalid"),
      start: integer(queryValue.start, 1, 500_000_000, "science-genomics-run-closure-invalid"),
      end: integer(queryValue.end, 1, 500_000_000, "science-genomics-run-closure-invalid"),
      variantSet: "ClinVar" as const,
    };
    const title = optionalText(envelope.title, 240);
    if (!title || storedRecord.title !== title
      || !inputBytes.equals(Buffer.from(canonicalJson(envelope), "utf8"))) {
      throw new Error("science-genomics-run-closure-invalid");
    }
    if (query.end < query.start || query.end - query.start + 1 > 1_000_000) throw new Error("science-genomics-run-closure-invalid");
    const assemblyEndpoint = String(envelope.assemblyEndpoint);
    const variantEndpoint = String(envelope.variantEndpoint);
    const expectedAssemblyUrl = new URL(`/info/assembly/${encodeURIComponent(query.species)}`, ENSEMBL_REST_ORIGIN);
    expectedAssemblyUrl.searchParams.set("content-type", "application/json");
    const expectedRegion = `${encodeURIComponent(query.refName)}:${query.start}-${query.end}`;
    const expectedVariantUrl = new URL(`/overlap/region/${encodeURIComponent(query.species)}/${expectedRegion}`, ENSEMBL_REST_ORIGIN);
    expectedVariantUrl.search = "?feature=variation;variant_set=ClinVar;content-type=application/json";
    if (assemblyEndpoint !== expectedAssemblyUrl.toString() || variantEndpoint !== expectedVariantUrl.toString()) {
      throw new Error("science-genomics-run-closure-invalid");
    }
    const assembly = parseAssembly(assemblyValue, query.assembly, query.refName, query.end);
    const variants = parseVariants(variantsValue, query.refName, query.start, query.end, assembly.refNameLength);
    const assemblyResponseSha256 = sha256(assemblyBytes);
    const variantResponseSha256 = sha256(variantBytes);
    const stored = storedRecord as unknown as StoredGenomicsVariantTrackResult;
    const expected: StoredGenomicsVariantTrackResult = {
      schema: "agentlas.genomics-variant-track-result/v1",
      provider: "ensembl-rest",
      query,
      title,
      assembly,
      variants,
      assemblySourceId: stored.assemblySourceId,
      assemblySourceVersionId: stored.assemblySourceVersionId,
      variantSourceId: stored.variantSourceId,
      variantSourceVersionId: stored.variantSourceVersionId,
      assemblyEndpoint,
      variantEndpoint,
      assemblyResponseSha256,
      variantResponseSha256,
      retrievedAt: stored.retrievedAt,
      runId,
    };
    if (assemblyOutput.sha256 !== assemblyResponseSha256 || variantOutput.sha256 !== variantResponseSha256
      || stored.assemblyResponseSha256 !== assemblyResponseSha256 || stored.variantResponseSha256 !== variantResponseSha256
      || !resultBytes.equals(Buffer.from(canonicalJson(stored), "utf8"))
      || canonicalJson(stored) !== canonicalJson(expected)) {
      throw new Error("science-genomics-run-closure-invalid");
    }
    const assemblySource = this.store.getSourceVersionForProject(projectId, stored.assemblySourceId, stored.assemblySourceVersionId);
    const variantSource = this.store.getSourceVersionForProject(projectId, stored.variantSourceId, stored.variantSourceVersionId);
    if (!assemblySource || assemblySource.canonicalUri !== assemblyEndpoint || assemblySource.version.accessState !== "retrieved"
      || assemblySource.version.mimeType !== "application/json" || assemblySource.version.contentSha256 !== assemblyResponseSha256
      || assemblySource.version.assetRef !== `science-source-cas:sha256:${assemblyResponseSha256}`
      || !variantSource || variantSource.canonicalUri !== variantEndpoint || variantSource.version.accessState !== "retrieved"
      || variantSource.version.mimeType !== "application/json" || variantSource.version.contentSha256 !== variantResponseSha256
      || variantSource.version.assetRef !== `science-source-cas:sha256:${variantResponseSha256}`) {
      throw new Error("science-genomics-source-run-closure-invalid");
    }
    return expected;
  }

  private failedRunCode(
    projectId: string,
    runId: string,
    query: GenomicsVariantTrackResult["query"],
    expectedInputEnvelope: Record<string, unknown>,
  ): string {
    const run = this.store.getResearchRunForProject(projectId, runId);
    const input = run?.inputs[0];
    const output = run?.outputs[0];
    if (!run || run.status !== "failed" || run.toolId !== GENOMICS_CATALOG_TOOL_ID
      || run.toolVersion !== GENOMICS_CATALOG_TOOL_VERSION || run.environmentSha256 !== genomicsEnvironmentSha256()
      || run.inputs.length !== 1
      || input?.role !== "genomics-query"
      || input.mimeType !== "application/vnd.agentlas.genomics-variant-track-query+json"
      || run.inputManifestSha256 !== sha256(canonicalJson(run.inputs.map(runResourceEnvelope)))
      || run.outputs.length !== 1
      || output?.role !== "provider-receipt"
      || output.mimeType !== "application/vnd.agentlas.genomics-variant-track-failure+json"
      || run.outputManifestSha256 !== sha256(canonicalJson(run.outputs.map(runResourceEnvelope)))) {
      throw new Error("science-genomics-failed-run-closure-invalid");
    }
    const inputBytes = this.store.readRunBlob(input);
    const inputValue = parseJson(inputBytes, "science-genomics-failed-run-closure-invalid");
    if (canonicalJson(inputValue) !== canonicalJson(expectedInputEnvelope)
      || !inputBytes.equals(Buffer.from(canonicalJson(inputValue), "utf8"))) {
      throw new Error("science-genomics-failed-run-closure-invalid");
    }
    const bytes = this.store.readRunBlob(output);
    const value = record(parseJson(bytes, "science-genomics-failed-run-closure-invalid"));
    const code = optionalText(value?.code, 240);
    if (!value || !exactKeys(value, ["schema", "provider", "query", "code"])
      || value.schema !== "agentlas.genomics-variant-track-failure/v1"
      || value.provider !== "ensembl-rest" || !code
      || canonicalJson(value.query) !== canonicalJson(query)
      || !bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
      throw new Error("science-genomics-failed-run-closure-invalid");
    }
    return code;
  }

  private artifactForRun(projectId: string, runId: string, stored: StoredGenomicsVariantTrackResult): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, "genomics-variants");
    if (!artifact) return null;
    if (canonicalJson(artifact.version.payload) !== canonicalJson(genomicsArtifactPayload(stored))) {
      throw new Error("science-genomics-artifact-run-mismatch");
    }
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-genomics-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId, runId, outputOrdinal: 3, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  async search(input: GenomicsVariantTrackInput): Promise<GenomicsVariantTrackResult> {
    const species = safeToken(input.species, 80, /^[a-z][a-z0-9_]+$/, "science-genomics-species-invalid");
    const assemblyName = safeToken(input.assembly, 120, /^[A-Za-z0-9_.-]+$/, "science-genomics-assembly-invalid");
    const refName = safeToken(input.refName, 120, /^[A-Za-z0-9_.-]+$/, "science-genomics-reference-invalid");
    const start = integer(input.start, 1, 500_000_000, "science-genomics-start-invalid");
    const end = integer(input.end, start, 500_000_000, "science-genomics-end-invalid");
    if (end - start + 1 > 1_000_000) throw new Error("science-genomics-region-too-large");
    const title = optionalText(input.title, 240) ?? `Ensembl ClinVar variants · ${refName}:${start}-${end}`;
    const assemblyUrl = new URL(`/info/assembly/${encodeURIComponent(species)}`, ENSEMBL_REST_ORIGIN);
    assemblyUrl.searchParams.set("content-type", "application/json");
    const region = `${encodeURIComponent(refName)}:${start}-${end}`;
    const variantUrl = new URL(`/overlap/region/${encodeURIComponent(species)}/${region}`, ENSEMBL_REST_ORIGIN);
    variantUrl.search = "?feature=variation;variant_set=ClinVar;content-type=application/json";
    const query = { species, assembly: assemblyName, refName, start, end, variantSet: "ClinVar" as const };
    const inputEnvelope = {
      schema: "agentlas.genomics-variant-track-query/v1", provider: "ensembl-rest", query,
      assemblyEndpoint: assemblyUrl.toString(), variantEndpoint: variantUrl.toString(), title,
    };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = { role: "genomics-query", mimeType: "application/vnd.agentlas.genomics-variant-track-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: GENOMICS_CATALOG_TOOL_ID, toolVersion: GENOMICS_CATALOG_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: genomicsEnvironmentSha256(),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const stored = this.storedResultForRun(input.projectId, run.id);
      const artifact = this.artifactForRun(input.projectId, run.id, stored)
        ?? this.createArtifact(stored, run.environmentSha256, input.projectId, input.conversationId, input.originMessageId);
      return { ...stored, artifact, replayed: true };
    }
    if (created.replayed && run.status === "failed") {
      throw new Error(this.failedRunCode(input.projectId, run.id, query, inputEnvelope));
    }
    if (created.replayed) throw new Error("science-genomics-run-not-replayable");
    try {
      const assemblyResponse = await fetchEnsembl(assemblyUrl, this.fetchImpl);
      const assembly = parseAssembly(parseJson(assemblyResponse.body, "science-genomics-assembly-response-invalid"), assemblyName, refName, end);
      const variantResponse = await fetchEnsembl(variantUrl, this.fetchImpl);
      const variants = parseVariants(parseJson(variantResponse.body, "science-genomics-variants-response-invalid"), refName, start, end, assembly.refNameLength);
      const retrievedAt = assemblyResponse.retrievedAt > variantResponse.retrievedAt ? assemblyResponse.retrievedAt : variantResponse.retrievedAt;
      const assemblySource = this.upsertSource({
        requestId: input.requestId, projectId: input.projectId, canonicalUri: assemblyUrl.toString(),
        title: `${assembly.name} assembly metadata`, publisher: "Ensembl", content: assemblyResponse.body, retrievedAt,
        abstract: `Exact Ensembl assembly metadata used to validate ${refName} and the requested ${assembly.name} coordinate system.`,
        retrievalMethod: `agentlas-ensembl-variant-track:assembly@${GENOMICS_CATALOG_TOOL_VERSION}`,
      });
      const variantSource = this.upsertSource({
        requestId: input.requestId, projectId: input.projectId, canonicalUri: variantUrl.toString(),
        title, publisher: "Ensembl", content: variantResponse.body, retrievedAt,
        abstract: `Exact Ensembl overlap response for ClinVar variations in ${refName}:${start}-${end}; no coordinates or annotations are imputed.`,
        retrievalMethod: `agentlas-ensembl-variant-track:overlap@${GENOMICS_CATALOG_TOOL_VERSION}`,
      });
      const partial: Omit<GenomicsVariantTrackResult, "artifact" | "replayed"> = {
        schema: "agentlas.genomics-variant-track-result/v1", provider: "ensembl-rest", query, title, assembly, variants,
        assemblySourceId: assemblySource.id, assemblySourceVersionId: assemblySource.version.id,
        variantSourceId: variantSource.id, variantSourceVersionId: variantSource.version.id,
        assemblyEndpoint: assemblyUrl.toString(), variantEndpoint: variantUrl.toString(),
        assemblyResponseSha256: sha256(assemblyResponse.body), variantResponseSha256: sha256(variantResponse.body),
        retrievedAt, runId: run.id,
      };
      const assemblyBlob = this.store.putRunBlob(assemblyResponse.body);
      const variantBlob = this.store.putRunBlob(variantResponse.body);
      const resultBytes = Buffer.from(canonicalJson(partial), "utf8");
      if (resultBytes.length > 4 * 1024 * 1024) throw new Error("science-genomics-artifact-too-large");
      const resultBlob = this.store.putRunBlob(resultBytes);
      const outputs = [
        { role: "assembly-response", mimeType: "application/json", ...assemblyBlob, artifactId: null, artifactVersion: null },
        { role: "provider-response", mimeType: "application/json", ...variantBlob, artifactId: null, artifactVersion: null },
        { role: "genomics-catalog", mimeType: "application/vnd.agentlas.genomics-variant-track-result+json", ...resultBlob, artifactId: null, artifactVersion: null },
      ];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)),
        summary: `${variants.length} exact Ensembl ClinVar variations retrieved for ${refName}:${start}-${end} on ${assembly.name}.`, outputs,
      });
      const verified = this.storedResultForRun(input.projectId, run.id);
      const artifact = this.createArtifact(verified, run.environmentSha256, input.projectId, input.conversationId, input.originMessageId);
      return { ...partial, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        const failure = {
          schema: "agentlas.genomics-variant-track-failure/v1", provider: "ensembl-rest", query,
          code: error instanceof Error ? error.message.slice(0, 240) : "science-genomics-catalog-failed",
        };
        const failureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(failure), "utf8"));
        const outputs = [{ role: "provider-receipt", mimeType: "application/vnd.agentlas.genomics-variant-track-failure+json", ...failureBlob, artifactId: null, artifactVersion: null }];
        this.store.completeResearchRun({
          requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "failed",
          outputManifestSha256: sha256(canonicalJson(outputs)), summary: failure.code, outputs,
        });
      }
      throw error;
    }
  }

  private createArtifact(
    result: Omit<GenomicsVariantTrackResult, "artifact" | "replayed">,
    environmentSha256: string,
    projectId: string,
    conversationId: string,
    originMessageId: string,
  ): ScienceArtifact {
    const payload = genomicsArtifactPayload(result);
    const artifact = this.store.createArtifact({
      projectId,
      sourceRunId: result.runId,
      kind: "genomics.variant-track",
      title: result.title,
      rendererId: JBROWSE_RENDERER_ID,
      rendererVersion: jbrowseRuntimeManifest.rendererVersion,
      rendererBinding: null,
      payload,
      semantic: {
        title: result.title,
        summary: `Interactive JBrowse 2 view of ${result.variants.length} exact Ensembl ClinVar variation records on ${result.assembly.name} ${result.query.refName}:${result.query.start}-${result.query.end}.`,
        entities: result.variants.slice(0, 200).map((variant) => ({ id: variant.id, label: variant.name, type: "sequence-variant" })),
        observations: [
          { label: "Variants", value: result.variants.length, unit: null },
          { label: "Region span", value: result.query.end - result.query.start + 1, unit: "bp" },
          { label: "Clinically annotated", value: result.variants.filter((variant) => variant.clinicalSignificance.length > 0).length, unit: null },
        ],
        warnings: result.variants.length ? [] : ["Ensembl returned no ClinVar variations for the exact requested region."],
      },
      provenance: {
        sourceRunId: result.runId,
        sourceRefs: [result.assemblyEndpoint, result.variantEndpoint],
        datasetSha256: [result.assemblyResponseSha256, result.variantResponseSha256],
        codeSha256: jbrowseRuntimeManifest.entrySha256,
        environmentSha256,
      },
      linkage: {
        labId: "genomics-variants",
        origin: {
          surface: "conversation",
          conversationId,
          messageId: originMessageId,
          loopSessionId: null,
          runId: result.runId,
          branchId: null,
        },
        parent: null,
        inputs: [],
      },
    });
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-genomics-run-artifact-binding:v1:${projectId}:${result.runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId, runId: result.runId, outputOrdinal: 3, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }
}
