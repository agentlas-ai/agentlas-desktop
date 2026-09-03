import { createHash } from "node:crypto";
import type { ScienceArtifact, ScienceResearchRunResource, ScienceSource } from "../../shared/science-contract";
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
import { loadSciencePluginRuntime } from "./plugin-runtime";

export const OQMD_OPTIMADE_STRUCTURES_ENDPOINT = "https://oqmd.org/optimade/v1/structures";
const MAX_OQMD_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_OQMD_ATTEMPTS = 3;
const RETRYABLE_OQMD_STATUSES = new Set([429, 502, 503, 504]);
const OQMD_JSON_MIME_TYPES = new Set(["application/json", "application/vnd.api+json"]);

export function isOqmdJsonMimeType(value: string): boolean {
  return OQMD_JSON_MIME_TYPES.has(value);
}

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
  retrieval: MaterialsRetrievalReceipt;
  runId: string;
  artifact: ScienceArtifact;
  replayed: boolean;
}

type StoredMaterialsCatalogResult = Omit<MaterialsCatalogResult, "artifact" | "replayed"> & {
  projectId: string;
  normalized: ScienceMaterialsArtifactPayload["normalized"];
};

interface OqmdAttemptReceipt {
  attempt: number;
  status: number | null;
  contentType: string | null;
  mimeType: string | null;
  byteSize: number;
  sha256: string | null;
  bodyComplete: boolean;
  bodyBlobRef: string | null;
  retrievedAt: string;
  retryable: boolean;
  retryAfterMs: number | null;
}

interface OqmdAttempt extends Omit<OqmdAttemptReceipt, "bodyBlobRef"> {
  body: Buffer | null;
}

interface MaterialsRetrievalReceipt {
  schema: "agentlas.science-materials-retrieval/v2";
  attemptCount: number;
  attempts: OqmdAttemptReceipt[];
}

class OqmdFetchError extends Error {
  constructor(readonly code: string, readonly observedByteSize = 0) {
    super(code);
    this.name = "OqmdFetchError";
  }
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

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= maximum && !/[\u0000-\u001f]/u.test(text) ? text : null;
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

function materialsEnvironmentSha256(): string {
  return sha256(canonicalJson({
    policy: "oqmd-optimade-structures-v2",
    endpoint: OQMD_OPTIMADE_STRUCTURES_ENDPOINT,
    toolVersion: SCIENCE_MATERIALS_TOOL_VERSION,
    retryableStatuses: [...RETRYABLE_OQMD_STATUSES],
    maximumAttempts: MAX_OQMD_ATTEMPTS,
  }));
}

function responseContentType(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return null;
  if (contentType.length < 1 || contentType.length > 240 || /[\u0000-\u001f\u007f]/u.test(contentType)) {
    throw new OqmdFetchError("science-materials-response-content-type-invalid");
  }
  return contentType;
}

function mediaTypeFromContentType(contentType: string | null): string | null {
  const mime = (contentType ?? "").toLowerCase().split(";", 1)[0]!.trim();
  return mime || null;
}

function retryAfterMs(response: Response, now: number): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+$/u.test(raw)) return Math.min(Number(raw) * 1_000, 5_000);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.min(date - now, 5_000));
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null
    && (!/^\d+$/u.test(declaredHeader) || Number(declaredHeader) > MAX_OQMD_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new OqmdFetchError("science-materials-response-size-invalid");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_OQMD_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OqmdFetchError("science-materials-response-size-invalid", Math.min(total, MAX_OQMD_RESPONSE_BYTES + 1));
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof OqmdFetchError) throw error;
    throw new OqmdFetchError("science-materials-response-read-failed", total);
  }
  return Buffer.concat(chunks, total);
}

function publicAttempt(attempt: OqmdAttempt, bodyBlobRef: string | null): OqmdAttemptReceipt {
  const { body: _body, ...receipt } = attempt;
  return { ...receipt, bodyBlobRef };
}

function persistAttemptReceipt(store: ScienceStore, attempts: OqmdAttempt[]): MaterialsRetrievalReceipt {
  const receipts = attempts.map((attempt) => {
    if (!attempt.bodyComplete) {
      if (attempt.body !== null || attempt.sha256 !== null) throw new Error("science-materials-attempt-evidence-invalid");
      return publicAttempt(attempt, null);
    }
    if (attempt.body === null || attempt.sha256 !== sha256(attempt.body) || attempt.byteSize !== attempt.body.length) {
      throw new Error("science-materials-attempt-evidence-invalid");
    }
    const blob = store.putRunBlob(attempt.body);
    if (blob.sha256 !== attempt.sha256 || blob.byteSize !== attempt.byteSize) throw new Error("science-materials-attempt-evidence-invalid");
    return publicAttempt(attempt, blob.blobRef);
  });
  return { schema: "agentlas.science-materials-retrieval/v2", attemptCount: receipts.length, attempts: receipts };
}

async function fetchOqmd(
  url: URL,
  fetchImpl: typeof fetch,
  attempts: OqmdAttempt[],
  sleepImpl: (milliseconds: number) => Promise<void>,
  timeoutMs = 30_000,
): Promise<{ body: Buffer; retrievedAt: string; status: number; contentType: string | null; mimeType: string }> {
  if (url.origin !== "https://oqmd.org" || url.pathname !== "/optimade/v1/structures") throw new Error("science-materials-endpoint-denied");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("science-materials-timeout-invalid");
  const deadline = Date.now() + timeoutMs;
  for (let index = 0; index < MAX_OQMD_ATTEMPTS; index += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      attempts.push({
        attempt: index + 1,
        status: null,
        contentType: null,
        mimeType: null,
        byteSize: 0,
        sha256: null,
        bodyComplete: false,
        retrievedAt: new Date().toISOString(),
        retryable: false,
        retryAfterMs: null,
        body: null,
      });
      throw new OqmdFetchError("science-materials-timeout");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response | null = null;
    let attemptRecorded = false;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: "error",
        headers: {
          accept: "application/vnd.api+json, application/json;q=0.9",
          "user-agent": "Agentlas-Science/1.1 (materials research; https://agentlas.ai)",
        },
      });
      const retrievedAt = new Date().toISOString();
      let contentType: string | null = null;
      let contentTypeError: OqmdFetchError | null = null;
      try {
        contentType = responseContentType(response);
      } catch (error) {
        contentTypeError = error instanceof OqmdFetchError
          ? error
          : new OqmdFetchError("science-materials-response-content-type-invalid");
      }
      const mimeType = mediaTypeFromContentType(contentType);
      let body: Buffer;
      try {
        body = await readBoundedResponse(response);
      } catch (error) {
        const observedByteSize = error instanceof OqmdFetchError ? error.observedByteSize : 0;
        const retryable = RETRYABLE_OQMD_STATUSES.has(response.status);
        const canRetry = retryable && index + 1 < MAX_OQMD_ATTEMPTS && !controller.signal.aborted;
        const headerDelay = retryAfterMs(response, Date.now());
        const delay = canRetry
          ? Math.min(headerDelay ?? 250 * 2 ** index, Math.max(0, deadline - Date.now()))
          : null;
        attempts.push({
          attempt: index + 1,
          status: response.status,
          contentType,
          mimeType,
          byteSize: observedByteSize,
          sha256: null,
          bodyComplete: false,
          retrievedAt,
          retryable,
          retryAfterMs: delay,
          body: null,
        });
        attemptRecorded = true;
        if (controller.signal.aborted) throw new OqmdFetchError("science-materials-timeout", observedByteSize);
        if (canRetry) {
          if (delay && delay > 0) await sleepImpl(delay);
          continue;
        }
        if (retryable) throw new OqmdFetchError(`science-materials-http-${response.status}`, observedByteSize);
        throw error;
      }
      const retryable = RETRYABLE_OQMD_STATUSES.has(response.status);
      const headerDelay = retryAfterMs(response, Date.now());
      attempts.push({
        attempt: index + 1,
        status: response.status,
        contentType,
        mimeType,
        byteSize: body.length,
        sha256: sha256(body),
        bodyComplete: true,
        retrievedAt,
        retryable,
        retryAfterMs: retryable && index + 1 < MAX_OQMD_ATTEMPTS
          ? Math.min(headerDelay ?? 250 * 2 ** index, Math.max(0, deadline - Date.now()))
          : null,
        body,
      });
      attemptRecorded = true;
      if (response.status === 200) {
        if (contentTypeError) throw contentTypeError;
        if (!mimeType || !OQMD_JSON_MIME_TYPES.has(mimeType) || body.length < 2) {
          throw new OqmdFetchError("science-materials-response-invalid");
        }
        return { body, retrievedAt, status: response.status, contentType, mimeType };
      }
      if (!retryable || index + 1 >= MAX_OQMD_ATTEMPTS) {
        throw new OqmdFetchError(`science-materials-http-${response.status}`);
      }
      const delay = attempts.at(-1)?.retryAfterMs ?? 0;
      if (delay > 0) await sleepImpl(delay);
    } catch (error) {
      if (!attemptRecorded) {
        const retrievedAt = new Date().toISOString();
        attempts.push({
          attempt: index + 1,
          status: null,
          contentType: null,
          mimeType: null,
          byteSize: 0,
          sha256: null,
          bodyComplete: false,
          retrievedAt,
          retryable: false,
          retryAfterMs: null,
          body: null,
        });
      }
      if (error instanceof OqmdFetchError) throw error;
      throw new OqmdFetchError(error instanceof Error && error.name === "AbortError"
        ? "science-materials-timeout"
        : "science-materials-network-error");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new OqmdFetchError("science-materials-retry-exhausted");
}

function loadRuntime(): MaterialsRuntime {
  const { runtime } = loadSciencePluginRuntime<Partial<MaterialsRuntime>>(
    "agentlas-materials-science", "runtime/materials-science.cjs", 16 * 1024 * 1024,
  );
  if (typeof runtime.buildOqmdUrl !== "function" || typeof runtime.normalizeOqmdOptimade !== "function") throw new Error("science-materials-runtime-invalid");
  return runtime as MaterialsRuntime;
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(code);
  }
}

function validateRetrievalReceipt(value: unknown, code: string): MaterialsRetrievalReceipt {
  const retrieval = record(value);
  if (!retrieval || !exactKeys(retrieval, ["schema", "attemptCount", "attempts"])
    || retrieval.schema !== "agentlas.science-materials-retrieval/v2"
    || !Number.isSafeInteger(retrieval.attemptCount) || Number(retrieval.attemptCount) < 1 || Number(retrieval.attemptCount) > MAX_OQMD_ATTEMPTS
    || !Array.isArray(retrieval.attempts) || retrieval.attempts.length !== retrieval.attemptCount) {
    throw new Error(code);
  }
  const attemptCount = Number(retrieval.attemptCount);
  const attempts = retrieval.attempts.map((value, index) => {
    const attempt = record(value);
    if (!attempt || !exactKeys(attempt, ["attempt", "status", "contentType", "mimeType", "byteSize", "sha256", "bodyComplete", "bodyBlobRef", "retrievedAt", "retryable", "retryAfterMs"])
      || attempt.attempt !== index + 1
      || attempt.status !== null && (!Number.isSafeInteger(attempt.status) || Number(attempt.status) < 100 || Number(attempt.status) > 599)
      || attempt.contentType !== null && (typeof attempt.contentType !== "string" || attempt.contentType.length < 1 || attempt.contentType.length > 240 || /[\u0000-\u001f\u007f]/u.test(attempt.contentType))
      || attempt.mimeType !== null && !optionalText(attempt.mimeType, 240)
      || !Number.isSafeInteger(attempt.byteSize) || Number(attempt.byteSize) < 0 || Number(attempt.byteSize) > MAX_OQMD_RESPONSE_BYTES + 1
      || attempt.sha256 !== null && (typeof attempt.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(attempt.sha256))
      || typeof attempt.bodyComplete !== "boolean"
      || attempt.bodyBlobRef !== null && (typeof attempt.bodyBlobRef !== "string" || !/^science-run-blob:sha256:[a-f0-9]{64}$/u.test(attempt.bodyBlobRef))
      || typeof attempt.retrievedAt !== "string" || !Number.isFinite(Date.parse(attempt.retrievedAt))
      || typeof attempt.retryable !== "boolean"
      || attempt.retryAfterMs !== null && (!Number.isSafeInteger(attempt.retryAfterMs) || Number(attempt.retryAfterMs) < 0 || Number(attempt.retryAfterMs) > 5_000)) {
      throw new Error(code);
    }
    if (attempt.status === null) {
      if (attempt.contentType !== null || attempt.mimeType !== null || attempt.byteSize !== 0 || attempt.sha256 !== null || attempt.bodyComplete !== false || attempt.bodyBlobRef !== null || attempt.retryable !== false || attempt.retryAfterMs !== null) throw new Error(code);
    } else if (attempt.bodyComplete && (typeof attempt.sha256 !== "string" || attempt.bodyBlobRef === null)) {
      throw new Error(code);
    } else if (attempt.bodyComplete && Number(attempt.byteSize) > MAX_OQMD_RESPONSE_BYTES) {
      throw new Error(code);
    } else if (!attempt.bodyComplete && (attempt.sha256 !== null || attempt.bodyBlobRef !== null)) {
      throw new Error(code);
    }
    const status = attempt.status === null ? null : Number(attempt.status);
    const contentType = attempt.contentType === null ? null : String(attempt.contentType);
    if (attempt.mimeType !== mediaTypeFromContentType(contentType)
      || status !== null && attempt.retryable !== RETRYABLE_OQMD_STATUSES.has(status)
      || index + 1 < attemptCount && (status === null || !RETRYABLE_OQMD_STATUSES.has(status) || attempt.retryAfterMs === null)
      || index + 1 === attemptCount && attempt.retryAfterMs !== null
      || typeof attempt.sha256 === "string" && attempt.bodyBlobRef !== `science-run-blob:sha256:${attempt.sha256}`) {
      throw new Error(code);
    }
    return {
      attempt: index + 1,
      status,
      contentType,
      mimeType: attempt.mimeType === null ? null : String(attempt.mimeType),
      byteSize: Number(attempt.byteSize),
      sha256: attempt.sha256 === null ? null : String(attempt.sha256),
      bodyComplete: Boolean(attempt.bodyComplete),
      bodyBlobRef: attempt.bodyBlobRef === null ? null : String(attempt.bodyBlobRef),
      retrievedAt: String(attempt.retrievedAt),
      retryable: Boolean(attempt.retryable),
      retryAfterMs: attempt.retryAfterMs === null ? null : Number(attempt.retryAfterMs),
    };
  });
  return { schema: "agentlas.science-materials-retrieval/v2", attemptCount: attempts.length, attempts };
}

export class ScienceMaterialsCatalogService {
  constructor(
    private readonly store: ScienceStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly runtime: MaterialsRuntime = loadRuntime(),
    private readonly sleepImpl: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly timeoutMs = 30_000,
  ) {}

  private upsertSource(input: { requestId: string; projectId: string; canonicalUri: string; title: string; body: Buffer; mimeType: string; retrievedAt: string }): ScienceSource {
    const contentSha256 = sha256(input.body);
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.canonicalUri);
    if (!existing) return this.store.createSource({
      requestId: stableUuid(`${input.requestId}:source:${input.canonicalUri}:${contentSha256}`), projectId: input.projectId,
      kind: "database-record", canonicalUri: input.canonicalUri, title: input.title, authors: ["Open Quantum Materials Database"],
      publicationYear: null, publisher: "OQMD", containerTitle: "OPTIMADE structures",
      abstract: "Exact OQMD OPTIMADE response used to normalize crystal structures, lattice vectors, atomic sites, band gap, and formation energy without imputation.",
      accessState: "retrieved", contentSha256, mimeType: input.mimeType, retrievedAt: input.retrievedAt,
      retrievalMethod: `agentlas-materials-science:oqmd-optimade@${SCIENCE_MATERIALS_TOOL_VERSION}`, license: "CC-BY-4.0",
    }, input.body).source;
    if (existing.version.contentSha256 === contentSha256 && existing.version.mimeType === input.mimeType) return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.canonicalUri}:${contentSha256}`), projectId: input.projectId,
      sourceId: existing.id, accessState: "retrieved", contentSha256, mimeType: input.mimeType, retrievedAt: input.retrievedAt,
      retrievalMethod: `agentlas-materials-science:oqmd-optimade@${SCIENCE_MATERIALS_TOOL_VERSION}`, license: "CC-BY-4.0",
    }, input.body).source;
  }

  private storedResultForRun(projectId: string, runId: string): { stored: StoredMaterialsCatalogResult; inputSha256: string } {
    const run = this.store.getResearchRunForProject(projectId, runId);
    const input = run?.inputs[0];
    const rawOutput = run?.outputs[0];
    const resultOutput = run?.outputs[1];
    if (!run || run.status !== "succeeded" || run.toolId !== SCIENCE_MATERIALS_TOOL_ID || run.toolVersion !== SCIENCE_MATERIALS_TOOL_VERSION
      || run.environmentSha256 !== materialsEnvironmentSha256()
      || run.inputs.length !== 1 || input?.role !== "materials-query" || input.mimeType !== "application/vnd.agentlas.science-materials-query+json"
      || run.inputManifestSha256 !== sha256(canonicalJson(run.inputs.map(runResourceEnvelope)))
          || run.outputs.length !== 2 || rawOutput?.role !== "provider-response" || !isOqmdJsonMimeType(rawOutput.mimeType)
      || resultOutput?.role !== "materials-catalog" || resultOutput.mimeType !== "application/vnd.agentlas.science-materials-catalog+json"
      || run.outputManifestSha256 !== sha256(canonicalJson(run.outputs.map(runResourceEnvelope)))) {
      throw new Error("science-materials-run-closure-invalid");
    }
    const inputBytes = this.store.readRunBlob(input);
    const rawBytes = this.store.readRunBlob(rawOutput);
    const resultBytes = this.store.readRunBlob(resultOutput);
    const queryEnvelope = record(parseJson(inputBytes, "science-materials-run-closure-invalid"));
    const storedValue = parseJson(resultBytes, "science-materials-run-closure-invalid");
    const storedRecord = record(storedValue);
    if (!queryEnvelope || !exactKeys(queryEnvelope, ["schema", "provider", "query", "endpoint", "title"])
      || queryEnvelope.schema !== "agentlas.science-materials-query/v1" || queryEnvelope.provider !== "oqmd-optimade"
      || !storedRecord || !exactKeys(storedRecord, [
        "schema", "provider", "query", "title", "endpoint", "responseSha256", "retrievedAt",
        "sourceId", "sourceVersionId", "retrieval", "runId", "projectId", "normalized",
      ])
      || storedRecord.schema !== "agentlas.science-materials-catalog-result/v1" || storedRecord.provider !== "oqmd-optimade"
      || storedRecord.projectId !== projectId || storedRecord.runId !== runId
      || canonicalJson(storedRecord.query) !== canonicalJson(queryEnvelope.query)
      || storedRecord.endpoint !== queryEnvelope.endpoint || storedRecord.title !== queryEnvelope.title
      || typeof storedRecord.responseSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(storedRecord.responseSha256)
      || typeof storedRecord.retrievedAt !== "string" || !Number.isFinite(Date.parse(storedRecord.retrievedAt))
      || !inputBytes.equals(Buffer.from(canonicalJson(queryEnvelope), "utf8"))) {
      throw new Error("science-materials-run-closure-invalid");
    }
    const retrieval = validateRetrievalReceipt(storedRecord.retrieval, "science-materials-run-closure-invalid");
    const finalAttempt = retrieval.attempts.at(-1);
    if (!finalAttempt || finalAttempt.status !== 200 || !finalAttempt.mimeType || !OQMD_JSON_MIME_TYPES.has(finalAttempt.mimeType)
      || !finalAttempt.bodyComplete || finalAttempt.mimeType !== rawOutput.mimeType || finalAttempt.bodyBlobRef !== rawOutput.blobRef
      || finalAttempt.byteSize !== rawOutput.byteSize || finalAttempt.sha256 !== rawOutput.sha256
      || finalAttempt.retrievedAt !== storedRecord.retrievedAt) {
      throw new Error("science-materials-run-closure-invalid");
    }
    for (const attempt of retrieval.attempts) {
      if (!attempt.bodyComplete || !attempt.sha256 || !attempt.bodyBlobRef) continue;
      const attemptBytes = this.store.readRunBlob({
        blobRef: attempt.bodyBlobRef,
        sha256: attempt.sha256,
        byteSize: attempt.byteSize,
      });
      if (attemptBytes.length !== attempt.byteSize || sha256(attemptBytes) !== attempt.sha256) {
        throw new Error("science-materials-run-closure-invalid");
      }
    }
    const stored = storedRecord as unknown as StoredMaterialsCatalogResult;
    const payload = validateScienceMaterialsArtifactPayload({
      schema: SCIENCE_MATERIALS_ARTIFACT_SCHEMA,
      inputSha256: input.sha256,
      responseSha256: stored.responseSha256,
      source: { id: stored.sourceId, versionId: stored.sourceVersionId, canonicalUri: stored.endpoint },
      normalized: stored.normalized,
    });
    if (rawOutput.sha256 !== stored.responseSha256 || rawOutput.byteSize !== rawBytes.length
      || sha256(rawBytes) !== stored.responseSha256
      || canonicalJson(stored.retrieval) !== canonicalJson(retrieval)
      || !resultBytes.equals(Buffer.from(canonicalJson(stored), "utf8"))) {
      throw new Error("science-materials-run-closure-invalid");
    }
    const source = this.store.getSourceVersionForProject(projectId, stored.sourceId, stored.sourceVersionId);
    if (!source || source.canonicalUri !== stored.endpoint || source.version.accessState !== "retrieved"
      || source.version.mimeType !== finalAttempt.mimeType || source.version.contentSha256 !== stored.responseSha256
      || source.version.assetRef !== `science-source-cas:sha256:${stored.responseSha256}`
      || payload.normalized.normalizedSha256 !== stored.normalized.normalizedSha256) {
      throw new Error("science-materials-source-run-closure-invalid");
    }
    return { stored, inputSha256: input.sha256 };
  }

  private failedRunCode(
    projectId: string,
    runId: string,
    expectedInputEnvelope: Record<string, unknown>,
    expectedQuery: { elements: string[]; limit: number; offset: number },
  ): string {
    const run = this.store.getResearchRunForProject(projectId, runId);
    const input = run?.inputs[0];
    const receiptOutput = run?.outputs.at(-1);
    if (!run || run.status !== "failed" || run.toolId !== SCIENCE_MATERIALS_TOOL_ID || run.toolVersion !== SCIENCE_MATERIALS_TOOL_VERSION
      || run.environmentSha256 !== materialsEnvironmentSha256()
      || run.inputs.length !== 1 || input?.role !== "materials-query" || input.mimeType !== "application/vnd.agentlas.science-materials-query+json"
      || run.inputManifestSha256 !== sha256(canonicalJson(run.inputs.map(runResourceEnvelope)))
      || run.outputs.length < 1 || receiptOutput?.role !== "provider-receipt"
      || receiptOutput.mimeType !== "application/vnd.agentlas.science-materials-failure+json"
      || run.outputManifestSha256 !== sha256(canonicalJson(run.outputs.map(runResourceEnvelope)))) {
      throw new Error("science-materials-failed-run-closure-invalid");
    }
    const inputBytes = this.store.readRunBlob(input);
    const inputValue = parseJson(inputBytes, "science-materials-failed-run-closure-invalid");
    if (canonicalJson(inputValue) !== canonicalJson(expectedInputEnvelope)
      || !inputBytes.equals(Buffer.from(canonicalJson(inputValue), "utf8"))) {
      throw new Error("science-materials-failed-run-closure-invalid");
    }
    const receiptBytes = this.store.readRunBlob(receiptOutput);
    const failure = record(parseJson(receiptBytes, "science-materials-failed-run-closure-invalid"));
    if (!failure || !exactKeys(failure, ["schema", "provider", "endpoint", "query", "code", "retrieval"])
      || failure.schema !== "agentlas.science-materials-failure/v2" || failure.provider !== "oqmd-optimade"
      || failure.endpoint !== expectedInputEnvelope.endpoint
      || canonicalJson(failure.query) !== canonicalJson(expectedQuery)
      || !optionalText(failure.code, 240)
      || !receiptBytes.equals(Buffer.from(canonicalJson(failure), "utf8"))) {
      throw new Error("science-materials-failed-run-closure-invalid");
    }
    const retrieval = validateRetrievalReceipt(failure.retrieval, "science-materials-failed-run-closure-invalid");
    const responseAttempts = retrieval.attempts.filter((attempt) => attempt.bodyComplete);
    const responseOutputs = run.outputs.slice(0, -1);
    if (run.summary !== failure.code || responseOutputs.length !== responseAttempts.length) throw new Error("science-materials-failed-run-closure-invalid");
    for (const [index, attempt] of responseAttempts.entries()) {
      const output = responseOutputs[index];
      if (!output || output.role !== "provider-error-response" || output.mimeType !== (attempt.mimeType ?? "application/octet-stream")
        || output.byteSize !== attempt.byteSize || output.sha256 !== attempt.sha256
        || output.blobRef !== attempt.bodyBlobRef
        || sha256(this.store.readRunBlob(output)) !== attempt.sha256) {
        throw new Error("science-materials-failed-run-closure-invalid");
      }
    }
    return String(failure.code);
  }

  private artifactForRun(projectId: string, runId: string, stored: StoredMaterialsCatalogResult, inputSha256: string): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, SCIENCE_MATERIALS_LAB_ID);
    if (!artifact) return null;
    const expected = validateScienceMaterialsArtifactPayload({
      schema: SCIENCE_MATERIALS_ARTIFACT_SCHEMA,
      inputSha256,
      responseSha256: stored.responseSha256,
      source: { id: stored.sourceId, versionId: stored.sourceVersionId, canonicalUri: stored.endpoint },
      normalized: stored.normalized,
    });
    const actual = validateScienceMaterialsArtifactPayload(artifact.version.payload);
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("science-materials-artifact-run-mismatch");
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
      environmentSha256: materialsEnvironmentSha256(),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const { stored, inputSha256 } = this.storedResultForRun(input.projectId, run.id);
      const artifact = this.artifactForRun(input.projectId, run.id, stored, inputSha256)
        ?? this.createArtifact(input.projectId, stored, stored.normalized, run.environmentSha256, input.conversationId, input.originMessageId, inputSha256);
      const { projectId: _projectId, normalized: _normalized, ...result } = stored;
      return { ...result, artifact, replayed: true };
    }
    if (created.replayed && run.status === "failed") {
      throw new Error(this.failedRunCode(input.projectId, run.id, inputEnvelope, built.input));
    }
    if (created.replayed) throw new Error("science-materials-run-not-replayable");
    const observedAttempts: OqmdAttempt[] = [];
    try {
      const fetched = await fetchOqmd(url, this.fetchImpl, observedAttempts, this.sleepImpl, this.timeoutMs);
      const retrieval = persistAttemptReceipt(this.store, observedAttempts);
      const responseSha256 = sha256(fetched.body);
      const normalized = this.runtime.normalizeOqmdOptimade(parseJson(fetched.body, "science-materials-response-invalid"));
      if (normalized.schema !== SCIENCE_MATERIALS_RESULT_SCHEMA) throw new Error("science-materials-result-invalid");
      const expectedElements = built.input.elements.join("\u0000");
      if (normalized.structures.some((structure) => !Array.isArray(structure.elements)
        || structure.elements.some((element) => typeof element !== "string")
        || [...structure.elements as string[]].sort().join("\u0000") !== expectedElements)) {
        throw new Error("science-materials-provider-query-mismatch");
      }
      const source = this.upsertSource({
        requestId: input.requestId,
        projectId: input.projectId,
        canonicalUri: url.toString(),
        title,
        body: fetched.body,
        mimeType: fetched.mimeType,
        retrievedAt: fetched.retrievedAt,
      });
      const partial = {
        schema: "agentlas.science-materials-catalog-result/v1" as const, provider: "oqmd-optimade" as const,
        query: built.input, title, endpoint: url.toString(), responseSha256, retrievedAt: fetched.retrievedAt,
        sourceId: source.id, sourceVersionId: source.version.id, retrieval, runId: run.id,
      };
      const stored = { ...partial, projectId: input.projectId, normalized };
      const rawBlob = this.store.putRunBlob(fetched.body);
      const rawResource = { role: "provider-response", mimeType: fetched.mimeType, ...rawBlob, artifactId: null, artifactVersion: null };
      const resultBlob = this.store.putRunBlob(Buffer.from(canonicalJson(stored), "utf8"));
      const resultResource = { role: "materials-catalog", mimeType: "application/vnd.agentlas.science-materials-catalog+json", ...resultBlob, artifactId: null, artifactVersion: null };
      const outputs = [rawResource, resultResource];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: `${normalized.structureCount} exact OQMD OPTIMADE structures retrieved.`, outputs,
      });
      const verified = this.storedResultForRun(input.projectId, run.id);
      const artifact = this.createArtifact(input.projectId, verified.stored, verified.stored.normalized, run.environmentSha256, input.conversationId, input.originMessageId, verified.inputSha256);
      return { ...partial, artifact, replayed: false };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        if (observedAttempts.length === 0) {
          observedAttempts.push({
            attempt: 1, status: null, contentType: null, mimeType: null, byteSize: 0, sha256: null,
            bodyComplete: false, retrievedAt: new Date().toISOString(), retryable: false, retryAfterMs: null, body: null,
          });
        }
        const retrieval = persistAttemptReceipt(this.store, observedAttempts);
        const failure = {
          schema: "agentlas.science-materials-failure/v2",
          provider: "oqmd-optimade",
          endpoint: url.toString(),
          query: built.input,
          code: error instanceof Error ? error.message.slice(0, 240) : "science-materials-failed",
          retrieval,
        };
        const responseResources = observedAttempts.flatMap((attempt) => {
          if (!attempt.bodyComplete || attempt.body === null) return [];
          const responseBlob = this.store.putRunBlob(attempt.body);
          return [{ role: "provider-error-response", mimeType: attempt.mimeType ?? "application/octet-stream", ...responseBlob, artifactId: null, artifactVersion: null }];
        });
        const blob = this.store.putRunBlob(Buffer.from(canonicalJson(failure), "utf8"));
        const resource = { role: "provider-receipt", mimeType: "application/vnd.agentlas.science-materials-failure+json", ...blob, artifactId: null, artifactVersion: null };
        const outputs = [...responseResources, resource];
        this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson(outputs)), summary: failure.code, outputs });
      }
      throw error;
    }
  }
}
