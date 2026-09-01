import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ScienceSource } from "../../shared/science-contract";
import {
  SCIENCE_ASTRONOMY_SOURCE_AUTHORITY,
  isScienceAstronomySourceAuthority,
  type ScienceAstronomySourceAuthority,
} from "../../shared/science-astronomy";
import { ScienceStore } from "./store";

export const ASTRONOMY_CATALOG_TOOL_ID = "agentlas.astronomy-catalog";
export const ASTRONOMY_CATALOG_TOOL_VERSION = "1.0.0";
export const SIMBAD_TAP_ENDPOINT = "https://simbad.cds.unistra.fr/simbad/sim-tap/sync";
const SOURCE_CLOCK_SKEW_MS = 60_000;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SIMBAD_COLUMNS = [
  { sourceName: "main_id", field: "mainId", datatype: "string", unit: null },
  { sourceName: "ra", field: "raDeg", datatype: "number", unit: "deg" },
  { sourceName: "dec", field: "decDeg", datatype: "number", unit: "deg" },
  { sourceName: "otype", field: "objectType", datatype: "string", unit: null },
  { sourceName: "sp_type", field: "spectralType", datatype: "string|null", unit: null },
  { sourceName: "plx_value", field: "parallaxMas", datatype: "number|null", unit: "mas" },
  { sourceName: "pmra", field: "properMotionRaMasYr", datatype: "number|null", unit: "mas/yr" },
  { sourceName: "pmdec", field: "properMotionDecMasYr", datatype: "number|null", unit: "mas/yr" },
  { sourceName: "rvz_radvel", field: "radialVelocityKmS", datatype: "number|null", unit: "km/s" },
  { sourceName: "rvz_redshift", field: "redshift", datatype: "number|null", unit: null },
] as const;

export interface AstronomyCatalogInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  centerRaDeg: number;
  centerDecDeg: number;
  radiusDeg: number;
  limit?: number;
  title?: string;
}

export interface AstronomyCatalogObject {
  id: string;
  mainId: string;
  raDeg: number;
  decDeg: number;
  objectType: string;
  spectralType: string | null;
  parallaxMas: number | null;
  properMotionRaMasYr: number | null;
  properMotionDecMasYr: number | null;
  radialVelocityKmS: number | null;
  redshift: number | null;
}

export interface AstronomyCatalogReceipt {
  provider: "simbad-tap";
  sourceAuthority: ScienceAstronomySourceAuthority;
  endpoint: string;
  requestSha256: string;
  responseSha256: string;
  retrievedAt: string;
  durationMs: number;
  httpStatus: number;
  rowCount: number;
  contentType: string;
  byteSize: number;
  attempts: number;
  normalizedSha256: string;
  limits: {
    responseBytes: number;
    objects: number;
    radiusDeg: number;
    rateIntervalMs: number;
    timeoutMs: number;
    retries: number;
    maxSourceAgeMs: number;
  };
}

export interface AstronomyCatalogResult {
  schema: "agentlas.astronomy-catalog-result/v1";
  provider: "simbad-tap";
  query: {
    centerRaDeg: number;
    centerDecDeg: number;
    radiusDeg: number;
    limit: number;
    adql: string;
  };
  title: string;
  objects: AstronomyCatalogObject[];
  sourceId: string;
  sourceVersionId: string;
  receipt: AstronomyCatalogReceipt;
  warnings: string[];
  runId: string;
  replayed: boolean;
}

type AstronomyProviderPolicy = {
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  rateIntervalMs: number;
  maxRetryAfterMs: number;
  maxResponseBytes: number;
  maxSourceAgeMs: number;
  maxObjects: number;
  minRadiusDeg: number;
  maxRadiusDeg: number;
  userAgent: string;
  contentTypes: Readonly<Record<"json" | "csv" | "tsv", readonly string[]>>;
  retryableStatusCodes: readonly number[];
};

type BuiltSimbadRequest = {
  input: { centerRaDeg: number; centerDecDeg: number; radiusDeg: number; limit: number; format: "json"; adql: string };
  url: string;
  requestSha256: string;
};

type NormalizedSimbadCatalog = {
  schema: "agentlas.astronomy.simbad-catalog/v1";
  provider: { id: "simbad-tap"; name: string; institution: string; endpoint: string; authentication: "none" };
  format: "json";
  columns: Array<{ sourceName: string; field: string; datatype: string; unit: string | null }>;
  objectCount: number;
  inputObjectCount: number;
  duplicateRowsRemoved: number;
  missingValueCount: number;
  objects: Array<{
    stableObjectId: string;
    mainId: string;
    raDeg: number;
    decDeg: number;
    objectType: string;
    spectralType: string | null;
    parallaxMas: number | null;
    properMotionRaMasYr: number | null;
    properMotionDecMasYr: number | null;
    radialVelocityKmS: number | null;
    redshift: number | null;
  }>;
  normalizedSha256: string;
};

type AstronomyRuntime = {
  SIMBAD_ORIGIN: string;
  SIMBAD_TAP_PATH: string;
  SIMBAD_TAP_ENDPOINT: string;
  DEFAULT_POLICY: AstronomyProviderPolicy;
  buildSimbadUrl(input: { centerRaDeg: number; centerDecDeg: number; radiusDeg: number; limit: number; format: "json" }): BuiltSimbadRequest;
  normalizeSimbadResponse(value: unknown, options: { format: "json" }): NormalizedSimbadCatalog;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f]/.test(normalized) ? normalized : null;
}

function validateCatalogInput(input: AstronomyCatalogInput): AstronomyCatalogInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-astronomy-catalog-input-invalid");
  const unknownFields = Object.keys(input).filter((key) => ![
    "requestId", "projectId", "conversationId", "originMessageId", "centerRaDeg", "centerDecDeg", "radiusDeg", "limit", "title",
  ].includes(key));
  if (unknownFields.length || !UUID_RE.test(input.requestId) || !UUID_RE.test(input.projectId)
    || !UUID_RE.test(input.conversationId) || !UUID_RE.test(input.originMessageId)) {
    throw new Error("science-astronomy-catalog-input-invalid");
  }
  if (input.title !== undefined && boundedText(input.title, 240) === null) throw new Error("science-astronomy-catalog-title-invalid");
  return input;
}

function assertFreshSource(
  receipt: AstronomyCatalogReceipt,
  source: ScienceSource,
  policy: AstronomyProviderPolicy,
  nowMs: number,
): void {
  const retrievedAtMs = Date.parse(receipt.retrievedAt);
  if (!isScienceAstronomySourceAuthority(receipt.sourceAuthority)
    || receipt.endpoint !== SCIENCE_ASTRONOMY_SOURCE_AUTHORITY.endpoint
    || !Number.isFinite(retrievedAtMs) || new Date(retrievedAtMs).toISOString() !== receipt.retrievedAt
    || source.version.retrievedAt !== receipt.retrievedAt || receipt.limits.maxSourceAgeMs !== policy.maxSourceAgeMs
    || retrievedAtMs > nowMs + SOURCE_CLOCK_SKEW_MS) {
    throw new Error("science-astronomy-catalog-source-time-invalid");
  }
  if (nowMs - retrievedAtMs > policy.maxSourceAgeMs) throw new Error("science-astronomy-catalog-source-stale");
}

function loadRuntime(): AstronomyRuntime {
  const runtimePath = path.resolve(__dirname, "../../../plugins/agentlas-astronomy/runtime/astronomy.cjs");
  const stat = fs.lstatSync(runtimePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("science-astronomy-runtime-invalid");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtime = require(runtimePath) as AstronomyRuntime;
  if (!runtime || typeof runtime.buildSimbadUrl !== "function" || typeof runtime.normalizeSimbadResponse !== "function"
    || runtime.SIMBAD_ORIGIN !== "https://simbad.cds.unistra.fr" || runtime.SIMBAD_TAP_PATH !== "/simbad/sim-tap/sync"
    || runtime.SIMBAD_TAP_ENDPOINT !== SIMBAD_TAP_ENDPOINT) throw new Error("science-astronomy-runtime-invalid");
  return runtime;
}

function validatePolicy(value: AstronomyProviderPolicy): AstronomyProviderPolicy {
  if (!value || typeof value !== "object" || value.timeoutMs !== 15_000 || value.retries !== 2 || value.retryDelayMs !== 250
    || value.rateIntervalMs !== 500 || value.maxRetryAfterMs !== 10_000 || value.maxResponseBytes !== 8 * 1024 * 1024
    || value.maxSourceAgeMs !== 24 * 60 * 60 * 1_000
    || value.maxObjects !== 500 || value.minRadiusDeg !== 0.001 || value.maxRadiusDeg !== 10
    || typeof value.userAgent !== "string" || !value.userAgent.trim()
    || !value.contentTypes || !Array.isArray(value.contentTypes.json)
    || canonicalJson(value.contentTypes) !== canonicalJson({
      json: ["application/json", "text/json"],
      csv: ["text/csv", "application/csv"],
      tsv: ["text/tab-separated-values", "text/tsv"],
    })
    || canonicalJson(value.retryableStatusCodes) !== canonicalJson([408, 429, 502, 503, 504])) {
    throw new Error("science-astronomy-provider-policy-invalid");
  }
  return value;
}

function validateBuiltRequest(value: BuiltSimbadRequest, runtime: AstronomyRuntime): { built: BuiltSimbadRequest; url: URL } {
  if (!value || typeof value !== "object" || typeof value.url !== "string" || typeof value.requestSha256 !== "string"
    || !value.input || typeof value.input !== "object" || value.input.format !== "json"
    || typeof value.input.adql !== "string" || !value.input.adql
    || !/^[a-f0-9]{64}$/.test(value.requestSha256) || value.requestSha256 !== sha256(value.url)) {
    throw new Error("science-astronomy-request-invalid");
  }
  const url = new URL(value.url);
  const keys = [...url.searchParams.keys()];
  if (url.protocol !== "https:" || url.origin !== runtime.SIMBAD_ORIGIN || url.pathname !== runtime.SIMBAD_TAP_PATH
    || url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== ""
    || canonicalJson(keys) !== canonicalJson(["REQUEST", "LANG", "FORMAT", "QUERY"])
    || url.searchParams.getAll("REQUEST").length !== 1 || url.searchParams.get("REQUEST") !== "doQuery"
    || url.searchParams.getAll("LANG").length !== 1 || url.searchParams.get("LANG") !== "ADQL"
    || url.searchParams.getAll("FORMAT").length !== 1 || url.searchParams.get("FORMAT") !== "json"
    || url.searchParams.getAll("QUERY").length !== 1 || url.searchParams.get("QUERY") !== value.input.adql
    || [...url.searchParams.keys()].some((key) => key !== key.toUpperCase())) {
    throw new Error("science-astronomy-endpoint-denied");
  }
  return { built: value, url };
}

function catalogObjects(value: NormalizedSimbadCatalog, limit: number): AstronomyCatalogObject[] {
  if (!value || value.schema !== "agentlas.astronomy.simbad-catalog/v1" || value.provider?.id !== "simbad-tap"
    || value.provider.endpoint !== SIMBAD_TAP_ENDPOINT || value.format !== "json" || !Array.isArray(value.columns)
    || canonicalJson(value.columns) !== canonicalJson(SIMBAD_COLUMNS)
    || !Array.isArray(value.objects) || value.objects.length > limit || value.objectCount !== value.objects.length
    || !Number.isSafeInteger(value.inputObjectCount) || value.inputObjectCount < value.objectCount || value.inputObjectCount > limit
    || !Number.isSafeInteger(value.duplicateRowsRemoved) || value.duplicateRowsRemoved !== value.inputObjectCount - value.objectCount
    || !Number.isSafeInteger(value.missingValueCount) || value.missingValueCount < 0
    || typeof value.normalizedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.normalizedSha256)
    || value.normalizedSha256 !== sha256(canonicalJson({ columns: value.columns, objects: value.objects }))) {
    throw new Error("science-astronomy-catalog-response-schema-invalid");
  }
  const nullableNumber = (candidate: unknown): candidate is number | null => candidate === null || (typeof candidate === "number" && Number.isFinite(candidate));
  const objects = value.objects.map((object) => {
    const stableObjectId = object && typeof object === "object" ? boundedText(object.stableObjectId, 160) : null;
    const mainId = object && typeof object === "object" ? boundedText(object.mainId, 500) : null;
    const objectType = object && typeof object === "object" ? boundedText(object.objectType, 80) : null;
    const spectralType = object && typeof object === "object" && object.spectralType !== null ? boundedText(object.spectralType, 160) : null;
    if (!object || typeof object !== "object" || stableObjectId !== object.stableObjectId || mainId !== object.mainId
      || objectType !== object.objectType || typeof object.raDeg !== "number" || !Number.isFinite(object.raDeg)
      || object.raDeg < 0 || object.raDeg >= 360 || typeof object.decDeg !== "number" || !Number.isFinite(object.decDeg)
      || object.decDeg < -90 || object.decDeg > 90 || (object.spectralType !== null && spectralType !== object.spectralType)
      || !nullableNumber(object.parallaxMas) || !nullableNumber(object.properMotionRaMasYr)
      || !nullableNumber(object.properMotionDecMasYr) || !nullableNumber(object.radialVelocityKmS) || !nullableNumber(object.redshift)
      || object.stableObjectId !== `simbad:${sha256(object.mainId.normalize("NFC"))}`) {
      throw new Error("science-astronomy-catalog-row-invalid");
    }
    return {
      id: stableUuid(`simbad-object:v1:${object.stableObjectId}`),
      mainId: object.mainId,
      raDeg: object.raDeg,
      decDeg: object.decDeg,
      objectType: object.objectType,
      spectralType: object.spectralType,
      parallaxMas: object.parallaxMas,
      properMotionRaMasYr: object.properMotionRaMasYr,
      properMotionDecMasYr: object.properMotionDecMasYr,
      radialVelocityKmS: object.radialVelocityKmS,
      redshift: object.redshift,
    };
  });
  if (new Set(objects.map((object) => object.id)).size !== objects.length) throw new Error("science-astronomy-catalog-object-duplicate");
  const ordered = [...value.objects].sort((left, right) => {
    if (left.mainId !== right.mainId) return left.mainId < right.mainId ? -1 : 1;
    return left.raDeg - right.raDeg || left.decDeg - right.decDeg;
  });
  const missingValueCount = value.objects.reduce((count, object) => count + [
    object.spectralType, object.parallaxMas, object.properMotionRaMasYr, object.properMotionDecMasYr,
    object.radialVelocityKmS, object.redshift,
  ].filter((candidate) => candidate === null).length, 0);
  if (canonicalJson(ordered) !== canonicalJson(value.objects) || missingValueCount !== value.missingValueCount) {
    throw new Error("science-astronomy-catalog-response-schema-invalid");
  }
  return objects;
}

class AstronomyProviderFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean, cause?: unknown) {
    super(code);
    this.name = "AstronomyProviderFailure";
    this.code = code;
    this.retryable = retryable;
    if (cause !== undefined) this.cause = cause;
  }
}

async function boundedResponseBytes(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new AstronomyProviderFailure("science-astronomy-catalog-response-size-invalid", false);
  }
  if (!response.body) throw new AstronomyProviderFailure("science-astronomy-catalog-response-size-invalid", false);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteSize = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteSize += chunk.value.byteLength;
      if (byteSize > maximum) {
        await reader.cancel("science-astronomy-catalog-response-size-invalid");
        throw new AstronomyProviderFailure("science-astronomy-catalog-response-size-invalid", false);
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    if (error instanceof AstronomyProviderFailure) throw error;
    throw new AstronomyProviderFailure("science-astronomy-catalog-network-error", true, error);
  } finally {
    reader.releaseLock();
  }
  if (byteSize < 2) throw new AstronomyProviderFailure("science-astronomy-catalog-response-size-invalid", false);
  return Buffer.concat(chunks, byteSize);
}

type FetchedSimbad = { body: Buffer; status: number; contentType: string; retrievedAt: string; durationMs: number; attempts: number };

export class ScienceAstronomyCatalogService {
  private providerQueue: Promise<void> = Promise.resolve();
  private nextProviderStartAt = 0;

  constructor(
    private readonly store: ScienceStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly runtime: AstronomyRuntime = loadRuntime(),
    private readonly clockMs: () => number = Date.now,
  ) {}

  private async waitForProviderSlot(intervalMs: number): Promise<void> {
    const previous = this.providerQueue;
    let release = (): void => undefined;
    this.providerQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, this.nextProviderStartAt - this.clockMs());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.nextProviderStartAt = this.clockMs() + intervalMs;
    } finally {
      release();
    }
  }

  private retryDelay(response: Response | null, attempt: number, policy: AstronomyProviderPolicy): number {
    const retryAfter = response?.headers.get("retry-after")?.trim() ?? "";
    if (retryAfter) {
      const milliseconds = /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1_000
        : Math.max(0, Date.parse(retryAfter) - this.clockMs());
      if (Number.isFinite(milliseconds)) return Math.min(policy.maxRetryAfterMs, Math.max(0, Math.ceil(milliseconds)));
    }
    return Math.min(policy.maxRetryAfterMs, policy.retryDelayMs * (2 ** (attempt - 1)));
  }

  private async fetchSimbad(url: URL, policy: AstronomyProviderPolicy): Promise<FetchedSimbad> {
    const overallStarted = this.clockMs();
    let lastFailure: Error | null = null;
    for (let attempt = 1; attempt <= policy.retries + 1; attempt += 1) {
      await this.waitForProviderSlot(policy.rateIntervalMs);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
      let response: Response | null = null;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          signal: controller.signal,
          redirect: "error",
          headers: { Accept: policy.contentTypes.json.join(", "), "User-Agent": policy.userAgent },
        });
        if (response.redirected || (response.url && response.url !== url.toString())) {
          throw new AstronomyProviderFailure("science-astronomy-catalog-redirect-denied", false);
        }
        const declared = response.headers.get("content-length");
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > policy.maxResponseBytes)) {
          throw new AstronomyProviderFailure("science-astronomy-catalog-response-size-invalid", false);
        }
        if (policy.retryableStatusCodes.includes(response.status) && attempt <= policy.retries) {
          await response.body?.cancel().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, this.retryDelay(response, attempt, policy)));
          continue;
        }
        if (!response.ok) throw new AstronomyProviderFailure(`science-astronomy-catalog-http-${response.status}`, false);
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim();
        if (!policy.contentTypes.json.includes(contentType)) {
          throw new AstronomyProviderFailure("science-astronomy-catalog-content-type-invalid", false);
        }
        const body = await boundedResponseBytes(response, policy.maxResponseBytes);
        return {
          body,
          status: response.status,
          contentType,
          retrievedAt: new Date(this.clockMs()).toISOString(),
          durationMs: Math.max(0, this.clockMs() - overallStarted),
          attempts: attempt,
        };
      } catch (error) {
        const aborted = controller.signal.aborted;
        const failure = error instanceof AstronomyProviderFailure
          ? error
          : aborted
            ? new AstronomyProviderFailure("science-astronomy-catalog-timeout", true, error)
            : new AstronomyProviderFailure("science-astronomy-catalog-network-error", true, error);
        lastFailure = failure;
        if (failure.retryable && attempt <= policy.retries) {
          await response?.body?.cancel().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, this.retryDelay(null, attempt, policy)));
          continue;
        }
        throw lastFailure;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastFailure ?? new Error("science-astronomy-catalog-fetch-failed");
  }

  private upsertSource(input: {
    requestId: string;
    projectId: string;
    canonicalUri: string;
    title: string;
    body: Buffer;
    responseSha256: string;
    retrievedAt: string;
  }): ScienceSource {
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.canonicalUri);
    if (!existing) {
      return this.store.createSource({
        requestId: stableUuid(`${input.requestId}:source:${input.responseSha256}`),
        projectId: input.projectId,
        kind: "database-record",
        canonicalUri: input.canonicalUri,
        title: input.title,
        authors: ["Centre de Données astronomiques de Strasbourg"],
        publicationYear: null,
        publisher: "SIMBAD Astronomical Database",
        containerTitle: "SIMBAD TAP",
        abstract: "Exact bounded SIMBAD TAP response bytes; provider null measurements are preserved without imputation.",
        accessState: "retrieved",
        contentSha256: input.responseSha256,
        mimeType: "application/json",
        retrievedAt: input.retrievedAt,
        retrievalMethod: "agentlas-astronomy:simbad-tap@1.0.0",
      }, input.body).source;
    }
    if (existing.version.accessState === "retrieved" && existing.version.contentSha256 === input.responseSha256
      && existing.version.mimeType === "application/json" && existing.version.retrievedAt === input.retrievedAt) return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.responseSha256}`),
      projectId: input.projectId,
      sourceId: existing.id,
      accessState: "retrieved",
      contentSha256: input.responseSha256,
      mimeType: "application/json",
      retrievedAt: input.retrievedAt,
      retrievalMethod: "agentlas-astronomy:simbad-tap@1.0.0",
    }, input.body).source;
  }

  private replayResult(projectId: string, runId: string, policy: AstronomyProviderPolicy): AstronomyCatalogResult {
    const run = this.store.getResearchRunForProject(projectId, runId);
    const raw = run?.outputs.find((resource) => resource.role === "provider-response" && resource.mimeType === "application/json");
    const result = run?.outputs.find((resource) => resource.role === "catalog-results" && resource.mimeType === "application/vnd.agentlas.astronomy-catalog-results+json");
    if (!run || run.status !== "succeeded" || run.outputs.length !== 2 || !raw || !result) {
      throw new Error("science-astronomy-catalog-replay-output-missing");
    }
    let stored: AstronomyCatalogResult;
    try { stored = JSON.parse(this.store.readRunBlob(result).toString("utf8")) as AstronomyCatalogResult; }
    catch { throw new Error("science-astronomy-catalog-replay-output-invalid"); }
    const source = this.store.getSourceVersionForProject(projectId, stored.sourceId, stored.sourceVersionId);
    if (stored.schema !== "agentlas.astronomy-catalog-result/v1" || stored.runId !== run.id || stored.provider !== "simbad-tap"
      || stored.receipt.responseSha256 !== raw.sha256 || stored.receipt.byteSize !== raw.byteSize
      || !source || source.version.accessState !== "retrieved" || source.version.contentSha256 !== raw.sha256
      || source.version.mimeType !== "application/json") {
      throw new Error("science-astronomy-catalog-replay-output-invalid");
    }
    this.store.readRunBlob(raw);
    assertFreshSource(stored.receipt, source, policy, this.clockMs());
    return { ...stored, replayed: true };
  }

  async search(input: AstronomyCatalogInput): Promise<AstronomyCatalogResult> {
    validateCatalogInput(input);
    const policy = validatePolicy(this.runtime.DEFAULT_POLICY);
    const request = validateBuiltRequest(this.runtime.buildSimbadUrl({
      centerRaDeg: input.centerRaDeg,
      centerDecDeg: input.centerDecDeg,
      radiusDeg: input.radiusDeg,
      limit: input.limit ?? 100,
      format: "json",
    }), this.runtime);
    const { centerRaDeg, centerDecDeg, radiusDeg, limit, adql } = request.built.input;
    const title = boundedText(input.title, 240) ?? `SIMBAD catalog · RA ${centerRaDeg.toFixed(4)}° · Dec ${centerDecDeg.toFixed(4)}°`;
    const url = request.url;
    const requestSha256 = request.built.requestSha256;
    const inputEnvelope = { schema: "agentlas.astronomy-catalog-query/v1", provider: "simbad-tap", centerRaDeg, centerDecDeg, radiusDeg, limit, title, adql, endpoint: SIMBAD_TAP_ENDPOINT, requestSha256 };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = { role: "catalog-query", mimeType: "application/vnd.agentlas.astronomy-catalog-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      toolId: ASTRONOMY_CATALOG_TOOL_ID,
      toolVersion: ASTRONOMY_CATALOG_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "agentlas-astronomy-simbad-v1", providerPolicy: policy, endpoint: SIMBAD_TAP_ENDPOINT, runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed) {
      if (run.status === "succeeded") return this.replayResult(input.projectId, run.id, policy);
      if (run.status === "failed") {
        const failure = run.outputs.find((resource) => resource.role === "provider-receipt"
          && resource.mimeType === "application/vnd.agentlas.astronomy-catalog-failure+json");
        if (!failure || run.outputs.length !== 1) throw new Error("science-astronomy-catalog-replay-output-invalid");
        let storedFailure: Record<string, unknown>;
        try { storedFailure = JSON.parse(this.store.readRunBlob(failure).toString("utf8")) as Record<string, unknown>; }
        catch { throw new Error("science-astronomy-catalog-replay-output-invalid"); }
        if (storedFailure.schema !== "agentlas.astronomy-catalog-failure/v1" || storedFailure.requestSha256 !== requestSha256
          || typeof storedFailure.code !== "string") throw new Error("science-astronomy-catalog-replay-output-invalid");
        throw new Error(storedFailure.code);
      }
      throw new Error("science-astronomy-catalog-run-in-progress");
    }
    try {
      const fetched = await this.fetchSimbad(url, policy);
      const responseSha256 = sha256(fetched.body);
      let responsePayload: unknown;
      try { responsePayload = JSON.parse(fetched.body.toString("utf8")); }
      catch { throw new Error("science-astronomy-catalog-response-json-invalid"); }
      const normalized = this.runtime.normalizeSimbadResponse(responsePayload, { format: "json" });
      const objects = catalogObjects(normalized, limit);
      const receipt: AstronomyCatalogReceipt = {
        provider: "simbad-tap",
        sourceAuthority: SCIENCE_ASTRONOMY_SOURCE_AUTHORITY,
        endpoint: SIMBAD_TAP_ENDPOINT,
        requestSha256,
        responseSha256,
        retrievedAt: fetched.retrievedAt,
        durationMs: fetched.durationMs,
        httpStatus: fetched.status,
        rowCount: objects.length,
        contentType: fetched.contentType,
        byteSize: fetched.body.length,
        attempts: fetched.attempts,
        normalizedSha256: normalized.normalizedSha256,
        limits: {
          responseBytes: policy.maxResponseBytes,
          objects: policy.maxObjects,
          radiusDeg: policy.maxRadiusDeg,
          rateIntervalMs: policy.rateIntervalMs,
          timeoutMs: policy.timeoutMs,
          retries: policy.retries,
          maxSourceAgeMs: policy.maxSourceAgeMs,
        },
      };
      const canonicalSourceUrl = new URL(SIMBAD_TAP_ENDPOINT);
      canonicalSourceUrl.searchParams.set("agentlas_query_sha256", requestSha256);
      const canonicalUri = canonicalSourceUrl.toString();
      const source = this.upsertSource({ requestId: input.requestId, projectId: input.projectId, canonicalUri, title, body: fetched.body, responseSha256, retrievedAt: fetched.retrievedAt });
      const partial = {
        schema: "agentlas.astronomy-catalog-result/v1" as const,
        provider: "simbad-tap" as const,
        query: { centerRaDeg, centerDecDeg, radiusDeg, limit, adql },
        title,
        objects,
        sourceId: source.id,
        sourceVersionId: source.version.id,
        receipt,
        warnings: objects.length ? [] : ["SIMBAD returned no objects for the exact cone search; the empty result is preserved."],
        runId: run.id,
        replayed: false,
      };
      if (source.version.accessState !== "retrieved" || source.version.contentSha256 !== responseSha256 || source.version.mimeType !== "application/json") {
        throw new Error("science-astronomy-catalog-source-closure-invalid");
      }
      assertFreshSource(receipt, source, policy, this.clockMs());
      const rawBlob = this.store.putRunBlob(fetched.body);
      if (rawBlob.sha256 !== responseSha256 || rawBlob.byteSize !== fetched.body.length) throw new Error("science-astronomy-catalog-source-closure-invalid");
      const rawResource = { role: "provider-response", mimeType: "application/json", ...rawBlob, artifactId: null, artifactVersion: null };
      const resultBytes = Buffer.from(canonicalJson(partial), "utf8");
      const resultBlob = this.store.putRunBlob(resultBytes);
      const resultResource = { role: "catalog-results", mimeType: "application/vnd.agentlas.astronomy-catalog-results+json", ...resultBlob, artifactId: null, artifactVersion: null };
      const outputs = [rawResource, resultResource];
      const completed = this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id,
        status: "succeeded", outputManifestSha256: sha256(canonicalJson(outputs)),
        summary: `${objects.length} exact SIMBAD objects retrieved for the requested ICRS cone.`, outputs,
      });
      if (completed.run.status !== "succeeded" || completed.run.outputs.length !== 2
        || completed.run.outputs[0]?.sha256 !== responseSha256 || completed.run.outputs[0]?.byteSize !== fetched.body.length
        || completed.run.outputs[1]?.sha256 !== resultBlob.sha256
        || completed.run.outputManifestSha256 !== sha256(canonicalJson(outputs))) {
        throw new Error("science-astronomy-catalog-run-closure-invalid");
      }
      return partial;
    } catch (error) {
      const failure = { schema: "agentlas.astronomy-catalog-failure/v1", provider: "simbad-tap", endpoint: SIMBAD_TAP_ENDPOINT, requestSha256, code: error instanceof Error ? error.message.slice(0, 240) : "science-astronomy-catalog-failed" };
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        const failureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(failure), "utf8"));
        const failureResource = { role: "provider-receipt", mimeType: "application/vnd.agentlas.astronomy-catalog-failure+json", ...failureBlob, artifactId: null, artifactVersion: null };
        this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson([failureResource])), summary: failure.code, outputs: [failureResource] });
      }
      throw error;
    }
  }
}
