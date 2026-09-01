import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceSource } from "../../shared/science-contract";
import { ScienceStore } from "./store";

export const GENOMICS_CATALOG_TOOL_ID = "agentlas.ensembl-variant-track";
export const GENOMICS_CATALOG_TOOL_VERSION = "1.0.0";
export const ENSEMBL_REST_ORIGIN = "https://rest.ensembl.org";

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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }

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
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 32 * 1024 * 1024) throw new Error("science-genomics-response-size-invalid");
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`science-genomics-http-${response.status}`);
    const mime = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim();
    if (mime !== "application/json" || body.length < 2 || body.length > 32 * 1024 * 1024) throw new Error("science-genomics-response-invalid");
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

function parseVariant(value: unknown, index: number, refName: string, rangeStart: number, rangeEnd: number): GenomicsVariant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`science-genomics-variant-${index}-invalid`);
  const record = value as Record<string, unknown>;
  const name = optionalText(record.id, 240) ?? optionalText(record.name, 240);
  const rowRefName = optionalText(record.seq_region_name, 120);
  const start = integer(record.start, rangeStart, rangeEnd, `science-genomics-variant-${index}-start-invalid`);
  const end = integer(record.end, start, rangeEnd, `science-genomics-variant-${index}-end-invalid`);
  if (!name || rowRefName !== refName) throw new Error(`science-genomics-variant-${index}-invalid`);
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

function parseVariants(value: unknown, refName: string, start: number, end: number): GenomicsVariant[] {
  if (!Array.isArray(value)) throw new Error("science-genomics-variants-response-invalid");
  if (value.length > 8_000) throw new Error("science-genomics-region-too-dense");
  const variants = value.map((row, index) => parseVariant(row, index, refName, start, end));
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) throw new Error("science-genomics-variant-duplicate");
  return variants.sort((left, right) => left.start - right.start || left.end - right.end || left.name.localeCompare(right.name, "en"));
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

  private artifactForRun(projectId: string, runId: string): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, "genomics-variants");
    if (!artifact) return null;
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
      environmentSha256: sha256(canonicalJson({ policy: "ensembl-clinvar-region-v1", origin: ENSEMBL_REST_ORIGIN, runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "genomics-catalog" && resource.mimeType === "application/vnd.agentlas.genomics-variant-track-result+json");
      if (!output) throw new Error("science-genomics-replay-output-missing");
      const stored = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as Omit<GenomicsVariantTrackResult, "artifact" | "replayed">;
      const artifact = this.artifactForRun(input.projectId, run.id)
        ?? this.createArtifact(stored, run.environmentSha256, input.projectId, input.conversationId, input.originMessageId);
      return { ...stored, artifact, replayed: true };
    }
    try {
      const [assemblyResponse, variantResponse] = await Promise.all([
        fetchEnsembl(assemblyUrl, this.fetchImpl),
        fetchEnsembl(variantUrl, this.fetchImpl),
      ]);
      const assembly = parseAssembly(JSON.parse(assemblyResponse.body.toString("utf8")), assemblyName, refName, end);
      const variants = parseVariants(JSON.parse(variantResponse.body.toString("utf8")), refName, start, end);
      const retrievedAt = assemblyResponse.retrievedAt > variantResponse.retrievedAt ? assemblyResponse.retrievedAt : variantResponse.retrievedAt;
      const assemblySource = this.upsertSource({
        requestId: input.requestId, projectId: input.projectId, canonicalUri: assemblyUrl.toString(),
        title: `${assembly.name} assembly metadata`, publisher: "Ensembl", content: assemblyResponse.body, retrievedAt,
        abstract: `Exact Ensembl assembly metadata used to validate ${refName} and the requested ${assembly.name} coordinate system.`,
        retrievalMethod: "agentlas-ensembl-variant-track:assembly@1.0.0",
      });
      const variantSource = this.upsertSource({
        requestId: input.requestId, projectId: input.projectId, canonicalUri: variantUrl.toString(),
        title, publisher: "Ensembl", content: variantResponse.body, retrievedAt,
        abstract: `Exact Ensembl overlap response for ClinVar variations in ${refName}:${start}-${end}; no coordinates or annotations are imputed.`,
        retrievalMethod: "agentlas-ensembl-variant-track:overlap@1.0.0",
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
      const artifact = this.createArtifact(partial, run.environmentSha256, input.projectId, input.conversationId, input.originMessageId);
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
    const payload = {
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
    const artifact = this.store.createArtifact({
      projectId,
      sourceRunId: result.runId,
      kind: "genomics.variant-track",
      title: result.title,
      rendererId: "agentlas.jbrowse",
      rendererVersion: "4.3.0",
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
        codeSha256: null,
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
