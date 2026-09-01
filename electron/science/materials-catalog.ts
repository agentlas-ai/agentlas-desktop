import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ScienceArtifact, ScienceSource } from "../../shared/science-contract";
import {
  SCIENCE_MATERIALS_ARTIFACT_SCHEMA,
  SCIENCE_MATERIALS_LAB_ID,
  SCIENCE_MATERIALS_RESULT_SCHEMA,
  SCIENCE_MATERIALS_TOOL_ID,
  SCIENCE_MATERIALS_TOOL_VERSION,
  validateScienceMaterialsArtifactPayload,
  type ScienceMaterialsArtifactPayload,
} from "../../shared/science-materials";
import { ScienceStore } from "./store";

export const OQMD_OPTIMADE_STRUCTURES_ENDPOINT = "https://oqmd.org/optimade/v1/structures";

type MaterialsRuntime = {
  buildOqmdUrl(input: { elements: string[]; limit?: number; offset?: number }): { input: { elements: string[]; limit: number; offset: number }; url: string };
  normalizeOqmdOptimade(value: unknown): ScienceMaterialsArtifactPayload["normalized"];
};

export interface MaterialsCatalogInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  elements: string[];
  limit?: number;
  offset?: number;
  title?: string;
}

export interface MaterialsCatalogResult {
  schema: "agentlas.science-materials-catalog-result/v1";
  provider: "oqmd-optimade";
  query: { elements: string[]; limit: number; offset: number };
  title: string;
  endpoint: string;
  responseSha256: string;
  retrievedAt: string;
  sourceId: string;
  sourceVersionId: string;
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

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= maximum && !/[\u0000-\u001f]/u.test(text) ? text : null;
}

async function fetchOqmd(url: URL, fetchImpl: typeof fetch, timeoutMs = 30_000): Promise<{ body: Buffer; retrievedAt: string; status: number }> {
  if (url.origin !== "https://oqmd.org" || url.pathname !== "/optimade/v1/structures") throw new Error("science-materials-endpoint-denied");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: "application/json", "user-agent": "Agentlas-Science/1.0 (materials research; https://agentlas.ai)" },
    });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 8 * 1024 * 1024) throw new Error("science-materials-response-size-invalid");
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`science-materials-http-${response.status}`);
    const mime = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim();
    if (mime !== "application/json" || body.length < 2 || body.length > 8 * 1024 * 1024) throw new Error("science-materials-response-invalid");
    return { body, retrievedAt: new Date().toISOString(), status: response.status };
  } finally { clearTimeout(timer); }
}

function loadRuntime(): MaterialsRuntime {
  const runtimePath = path.resolve(__dirname, "../../../plugins/agentlas-materials-science/runtime/materials-science.cjs");
  const runtime = createRequire(__filename)(runtimePath) as Partial<MaterialsRuntime>;
  if (typeof runtime.buildOqmdUrl !== "function" || typeof runtime.normalizeOqmdOptimade !== "function") throw new Error("science-materials-runtime-invalid");
  return runtime as MaterialsRuntime;
}

export class ScienceMaterialsCatalogService {
  constructor(private readonly store: ScienceStore, private readonly fetchImpl: typeof fetch = fetch, private readonly runtime: MaterialsRuntime = loadRuntime()) {}

  private upsertSource(input: { requestId: string; projectId: string; canonicalUri: string; title: string; body: Buffer; retrievedAt: string }): ScienceSource {
    const contentSha256 = sha256(input.body);
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.canonicalUri);
    if (!existing) return this.store.createSource({
      requestId: stableUuid(`${input.requestId}:source:${input.canonicalUri}:${contentSha256}`), projectId: input.projectId,
      kind: "database-record", canonicalUri: input.canonicalUri, title: input.title, authors: ["Open Quantum Materials Database"],
      publicationYear: null, publisher: "OQMD", containerTitle: "OPTIMADE structures",
      abstract: "Exact OQMD OPTIMADE response used to normalize crystal structures, lattice vectors, atomic sites, band gap, and formation energy without imputation.",
      accessState: "retrieved", contentSha256, mimeType: "application/json", retrievedAt: input.retrievedAt,
      retrievalMethod: "agentlas-materials-science:oqmd-optimade@1.0.0", license: "CC-BY-4.0",
    }, input.body).source;
    if (existing.version.contentSha256 === contentSha256 && existing.version.mimeType === "application/json") return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.canonicalUri}:${contentSha256}`), projectId: input.projectId,
      sourceId: existing.id, accessState: "retrieved", contentSha256, mimeType: "application/json", retrievedAt: input.retrievedAt,
      retrievalMethod: "agentlas-materials-science:oqmd-optimade@1.0.0", license: "CC-BY-4.0",
    }, input.body).source;
  }

  private artifactForRun(projectId: string, runId: string): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, SCIENCE_MATERIALS_LAB_ID);
    if (!artifact) return null;
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-materials-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId, runId, outputOrdinal: 2, artifactId: artifact.id, artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  private createArtifact(projectId: string, input: Omit<MaterialsCatalogResult, "artifact" | "replayed">, normalized: ScienceMaterialsArtifactPayload["normalized"], environmentSha256: string, conversationId: string, originMessageId: string, inputSha256: string): ScienceArtifact {
    const payload = validateScienceMaterialsArtifactPayload({
      schema: SCIENCE_MATERIALS_ARTIFACT_SCHEMA,
      inputSha256,
      responseSha256: input.responseSha256,
      source: { id: input.sourceId, versionId: input.sourceVersionId, canonicalUri: input.endpoint },
      normalized,
    });
    const artifact = this.store.createArtifact({
      projectId,
      sourceRunId: input.runId,
      kind: "table",
      title: input.title,
      rendererId: "agentlas.table",
      rendererVersion: "1.0.0",
      rendererBinding: null,
      payload: payload as unknown as Record<string, unknown>,
      semantic: {
        title: input.title,
        summary: `${normalized.structureCount} OQMD OPTIMADE crystal structures with exact lattice/site data and non-imputed material properties.`,
        entities: normalized.structures.slice(0, 50).map((structure) => ({ id: String(structure.id ?? "unknown"), label: String(structure.formulaReduced ?? structure.formulaDescriptive ?? structure.id ?? "structure"), type: "crystal-structure" })),
        observations: [
          { label: "Structures", value: normalized.structureCount, unit: null },
          { label: "Band gaps reported", value: normalized.table.rows.filter((row) => row[4] !== null).length, unit: null },
          { label: "Formation energies reported", value: normalized.table.rows.filter((row) => row[5] !== null).length, unit: null },
        ],
        warnings: [...normalized.warnings],
      },
      provenance: {
        sourceRunId: input.runId,
        sourceRefs: [input.endpoint],
        datasetSha256: [input.responseSha256, normalized.normalizedSha256],
        codeSha256: null,
        environmentSha256,
      },
      linkage: {
        labId: SCIENCE_MATERIALS_LAB_ID,
        origin: { surface: "conversation", conversationId, messageId: originMessageId, loopSessionId: null, runId: input.runId, branchId: null },
        parent: null,
        inputs: [],
      },
    });
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-materials-run-artifact-binding:v1:${projectId}:${input.runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId, runId: input.runId, outputOrdinal: 2,
      artifactId: artifact.id, artifactVersion: artifact.currentVersion, expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  async search(input: MaterialsCatalogInput): Promise<MaterialsCatalogResult> {
    const built = this.runtime.buildOqmdUrl({ elements: input.elements, ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.offset === undefined ? {} : { offset: input.offset }) });
    const url = new URL(built.url);
    if (url.origin !== "https://oqmd.org" || url.pathname !== "/optimade/v1/structures") throw new Error("science-materials-endpoint-denied");
    const title = optionalText(input.title, 240) ?? `OQMD structures · ${built.input.elements.join("–")}`;
    const inputEnvelope = { schema: "agentlas.science-materials-query/v1", provider: "oqmd-optimade", query: built.input, endpoint: url.toString(), title };
    const inputBytes = Buffer.from(canonicalJson(inputEnvelope), "utf8");
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = { role: "materials-query", mimeType: "application/vnd.agentlas.science-materials-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: SCIENCE_MATERIALS_TOOL_ID, toolVersion: SCIENCE_MATERIALS_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "oqmd-optimade-structures-v1", endpoint: OQMD_OPTIMADE_STRUCTURES_ENDPOINT, runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "materials-catalog" && resource.mimeType === "application/vnd.agentlas.science-materials-catalog+json");
      if (!output) throw new Error("science-materials-replay-output-missing");
      const stored = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as Omit<MaterialsCatalogResult, "artifact" | "replayed"> & { projectId: string; normalized: ScienceMaterialsArtifactPayload["normalized"] };
      if (stored.schema !== "agentlas.science-materials-catalog-result/v1" || stored.runId !== run.id || stored.projectId !== input.projectId) throw new Error("science-materials-replay-output-invalid");
      const artifact = this.artifactForRun(input.projectId, run.id) ?? this.createArtifact(input.projectId, stored, stored.normalized, run.environmentSha256, input.conversationId, input.originMessageId, run.inputs[0]!.sha256);
      const { projectId: _projectId, normalized: _normalized, ...result } = stored;
      return { ...result, artifact, replayed: true };
    }
    try {
      const fetched = await fetchOqmd(url, this.fetchImpl);
      const responseSha256 = sha256(fetched.body);
      const normalized = this.runtime.normalizeOqmdOptimade(JSON.parse(fetched.body.toString("utf8")));
      if (normalized.schema !== SCIENCE_MATERIALS_RESULT_SCHEMA) throw new Error("science-materials-result-invalid");
      const source = this.upsertSource({ requestId: input.requestId, projectId: input.projectId, canonicalUri: url.toString(), title, body: fetched.body, retrievedAt: fetched.retrievedAt });
      const partial = {
        schema: "agentlas.science-materials-catalog-result/v1" as const, provider: "oqmd-optimade" as const,
        query: built.input, title, endpoint: url.toString(), responseSha256, retrievedAt: fetched.retrievedAt,
        sourceId: source.id, sourceVersionId: source.version.id, runId: run.id,
      };
      const stored = { ...partial, projectId: input.projectId, normalized };
      const rawBlob = this.store.putRunBlob(fetched.body);
      const rawResource = { role: "provider-response", mimeType: "application/json", ...rawBlob, artifactId: null, artifactVersion: null };
      const resultBlob = this.store.putRunBlob(Buffer.from(canonicalJson(stored), "utf8"));
      const resultResource = { role: "materials-catalog", mimeType: "application/vnd.agentlas.science-materials-catalog+json", ...resultBlob, artifactId: null, artifactVersion: null };
      const outputs = [rawResource, resultResource];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: `${normalized.structureCount} exact OQMD OPTIMADE structures retrieved.`, outputs,
      });
      const artifact = this.createArtifact(input.projectId, stored, normalized, run.environmentSha256, input.conversationId, input.originMessageId, inputResource.sha256);
      return { ...partial, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        const failure = { schema: "agentlas.science-materials-failure/v1", provider: "oqmd-optimade", endpoint: url.toString(), code: error instanceof Error ? error.message.slice(0, 240) : "science-materials-failed" };
        const blob = this.store.putRunBlob(Buffer.from(canonicalJson(failure), "utf8"));
        const resource = { role: "provider-receipt", mimeType: "application/vnd.agentlas.science-materials-failure+json", ...blob, artifactId: null, artifactVersion: null };
        this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson([resource])), summary: failure.code, outputs: [resource] });
      }
      throw error;
    }
  }
}
