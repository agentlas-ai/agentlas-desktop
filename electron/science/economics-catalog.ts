import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ScienceArtifact, ScienceSource } from "../../shared/science-contract";
import {
  SCIENCE_ECONOMICS_ARTIFACT_SCHEMA,
  SCIENCE_ECONOMICS_EVIDENCE_SCHEMA,
  SCIENCE_ECONOMICS_LAB_ID,
  SCIENCE_ECONOMICS_TABLE_SCHEMA,
  SCIENCE_ECONOMICS_TOOL_ID,
  SCIENCE_ECONOMICS_TOOL_VERSION,
  WORLD_BANK_NORMALIZED_SCHEMA,
  createScienceEconomicIndicatorVegaSpec,
  scienceEconomicsSha256,
  validateScienceEconomicIndicatorArtifactPayload,
  type ScienceEconomicIndicatorArtifactPayload,
  type ScienceEconomicIndicatorTableRow,
} from "../../shared/science-economics";
import { ScienceStore } from "./store";

const WORLD_BANK_ORIGIN = "https://api.worldbank.org";
const WORLD_BANK_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const WORLD_BANK_TIMEOUT_MS = 20_000;
const ECONOMICS_RESULT_SCHEMA = "agentlas.science.economic-indicator-result/v1" as const;
const ECONOMICS_RECEIPT_SCHEMA = "agentlas.science.economic-indicator-receipt/v1" as const;
const ECONOMICS_FAILURE_SCHEMA = "agentlas.science.economic-indicator-failure/v1" as const;

type WorldBankNormalized = {
  schema: typeof WORLD_BANK_NORMALIZED_SCHEMA;
  provider: { id: "world-bank"; name: "World Bank"; apiVersion: "v2"; sourceId: string | null; lastUpdated: string | null };
  pagination: { page: number; pages: number; perPage: number; total: number };
  series: {
    country: { id: string; name: string; iso3Code: string };
    indicator: { code: string; name: string };
    unit: string;
    decimals: number;
  };
  observations: Array<{ date: string; value: number | null; unit: string; decimals: number; observationStatus: string | null }>;
};

type WorldBankRuntime = {
  buildWorldBankUrl(input: { country: string; indicator: string; startYear: number; endYear: number; page?: number; per_page?: number }): string;
  normalizeWorldBankResponse(input: unknown): unknown;
};

type ScienceEconomicsQuery = { country: string; indicator: string; startYear: number; endYear: number };

export interface ScienceEconomicsCatalogInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  country: string;
  indicator: string;
  startYear: number;
  endYear: number;
  title?: string;
}

export interface ScienceEconomicsCatalogReceipt {
  schema: typeof ECONOMICS_RECEIPT_SCHEMA;
  provider: "world-bank";
  request: ScienceEconomicIndicatorArtifactPayload["evidence"]["request"];
  response: ScienceEconomicIndicatorArtifactPayload["evidence"]["response"] & { durationMs: number };
  normalization: ScienceEconomicIndicatorArtifactPayload["evidence"]["normalization"];
  source: ScienceEconomicIndicatorArtifactPayload["evidence"]["source"];
}

export interface ScienceEconomicsCatalogResult {
  schema: typeof ECONOMICS_RESULT_SCHEMA;
  provider: "world-bank";
  query: { country: string; indicator: string; startYear: number; endYear: number };
  title: string;
  sourceId: string;
  sourceVersionId: string;
  receipt: ScienceEconomicsCatalogReceipt;
  artifact: ScienceArtifact;
  runId: string;
  replayed: boolean;
}

type FetchedWorldBankResponse = {
  body: Buffer;
  status: number;
  mimeType: string;
  ok: boolean;
  retrievedAt: string;
  durationMs: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().flatMap((key) => object[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(object[key])}`]).join(",")}}`;
  }
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function optionalTitle(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("science-economics-title-invalid");
  return value.trim();
}

function safeText(value: unknown, maximum: number, code: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return allowEmpty ? value : value.trim();
}

function safeInteger(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(code);
  return Number(value);
}

function loadRuntime(): WorldBankRuntime {
  const runtimePath = path.resolve(__dirname, "../../../plugins/agentlas-economic-data/runtime/economic-data.cjs");
  const runtime = createRequire(__filename)(runtimePath) as Partial<WorldBankRuntime>;
  if (typeof runtime.buildWorldBankUrl !== "function" || typeof runtime.normalizeWorldBankResponse !== "function") throw new Error("science-economics-runtime-invalid");
  return runtime as WorldBankRuntime;
}

function validateWorldBankUrl(value: unknown): string {
  const raw = safeText(value, 4_000, "science-economics-endpoint-invalid");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("science-economics-endpoint-invalid"); }
  if (url.origin !== WORLD_BANK_ORIGIN || url.username || url.password
    || !/^\/v2\/country\/[^/]+\/indicator\/[^/]+$/.test(url.pathname)
    || url.searchParams.get("format") !== "json" || !url.searchParams.get("date")) throw new Error("science-economics-endpoint-denied");
  return url.toString();
}

function validateNormalizedWorldBankResponse(value: unknown, query: ScienceEconomicsQuery): WorldBankNormalized {
  const normalized = record(value);
  if (!normalized || !exactKeys(normalized, ["schema", "provider", "pagination", "series", "observations"])
    || normalized.schema !== WORLD_BANK_NORMALIZED_SCHEMA) throw new Error("science-economics-normalized-response-invalid");
  const provider = record(normalized.provider);
  const providerKeysValid = provider && (
    exactKeys(provider, ["id", "name", "apiVersion", "sourceId", "lastUpdated"])
    || exactKeys(provider, ["id", "name", "apiVersion", "sourceId", "lastUpdated", "sourceNote"])
    || exactKeys(provider, ["id", "name", "apiVersion", "sourceId", "lastUpdated", "sourceNotes"])
  );
  if (!provider || !providerKeysValid
    || provider.id !== "world-bank" || provider.name !== "World Bank" || provider.apiVersion !== "v2") {
    throw new Error("science-economics-provider-metadata-invalid");
  }
  const sourceId = provider.sourceId === null ? null : safeText(provider.sourceId, 160, "science-economics-provider-metadata-invalid");
  const lastUpdated = provider.lastUpdated === null ? null : safeText(provider.lastUpdated, 160, "science-economics-provider-metadata-invalid");

  const pagination = record(normalized.pagination);
  if (!pagination || !exactKeys(pagination, ["page", "pages", "perPage", "total"])) throw new Error("science-economics-pagination-invalid");
  const normalizedPagination = {
    page: safeInteger(pagination.page, 1, 1_000_000, "science-economics-pagination-invalid"),
    pages: safeInteger(pagination.pages, 0, 1_000_000, "science-economics-pagination-invalid"),
    perPage: safeInteger(pagination.perPage, 1, 20_000, "science-economics-pagination-invalid"),
    total: safeInteger(pagination.total, 0, 100_000_000, "science-economics-pagination-invalid"),
  };
  if (normalizedPagination.page !== 1 || normalizedPagination.pages > 1) throw new Error("science-economics-pagination-incomplete");

  const series = record(normalized.series);
  const country = record(series?.country);
  const indicator = record(series?.indicator);
  if (!series || !exactKeys(series, ["country", "indicator", "unit", "decimals"])
    || !country || !exactKeys(country, ["id", "name", "iso3Code"])
    || !indicator || !exactKeys(indicator, ["code", "name"])) throw new Error("science-economics-series-invalid");
  const normalizedSeries = {
    country: {
      id: safeText(country.id, 80, "science-economics-series-invalid"),
      name: safeText(country.name, 500, "science-economics-series-invalid"),
      iso3Code: safeText(country.iso3Code, 20, "science-economics-series-invalid"),
    },
    indicator: {
      code: safeText(indicator.code, 160, "science-economics-series-invalid"),
      name: safeText(indicator.name, 500, "science-economics-series-invalid"),
    },
    unit: safeText(series.unit, 240, "science-economics-series-invalid", true),
    decimals: safeInteger(series.decimals, 0, 20, "science-economics-series-invalid"),
  };
  if (normalizedSeries.indicator.code !== query.indicator) throw new Error("science-economics-indicator-mismatch");
  if (!Array.isArray(normalized.observations) || normalized.observations.length > 20_000) throw new Error("science-economics-observations-invalid");
  const observations = normalized.observations.map((entry) => {
    const observation = record(entry);
    if (!observation || !exactKeys(observation, ["date", "value", "unit", "decimals", "observationStatus"])) throw new Error("science-economics-observation-invalid");
    const date = safeText(observation.date, 4, "science-economics-observation-invalid");
    const year = /^\d{4}$/.test(date) ? Number(date) : NaN;
    const observationValue = observation.value === null ? null
      : typeof observation.value === "number" && Number.isFinite(observation.value) ? (Object.is(observation.value, -0) ? 0 : observation.value) : undefined;
    if (!Number.isSafeInteger(year) || year < query.startYear || year > query.endYear || observationValue === undefined
      || observation.unit !== normalizedSeries.unit || observation.decimals !== normalizedSeries.decimals) {
      throw new Error("science-economics-observation-invalid");
    }
    const observationStatus = observation.observationStatus === null ? null
      : safeText(observation.observationStatus, 240, "science-economics-observation-invalid");
    return { date, value: observationValue, unit: normalizedSeries.unit, decimals: normalizedSeries.decimals, observationStatus };
  });
  if (new Set(observations.map((observation) => observation.date)).size !== observations.length
    || observations.some((observation, index) => index > 0 && Number(observations[index - 1]!.date) <= Number(observation.date))) {
    throw new Error("science-economics-observation-order-invalid");
  }
  return {
    schema: WORLD_BANK_NORMALIZED_SCHEMA,
    provider: { id: "world-bank", name: "World Bank", apiVersion: "v2", sourceId, lastUpdated },
    pagination: normalizedPagination,
    series: normalizedSeries,
    observations,
  };
}

function sourceNotesFromNormalized(value: unknown): string[] {
  const provider = record(record(value)?.provider);
  if (!provider) return [];
  const candidates = Array.isArray(provider.sourceNotes) ? provider.sourceNotes : provider.sourceNote === undefined || provider.sourceNote === null ? [] : [provider.sourceNote];
  return candidates.map((note) => safeText(note, 2_000, "science-economics-provider-metadata-invalid"));
}

async function fetchWorldBank(url: URL, fetchImpl: typeof fetch): Promise<FetchedWorldBankResponse> {
  if (url.origin !== WORLD_BANK_ORIGIN || !/^\/v2\/country\/[^/]+\/indicator\/[^/]+$/.test(url.pathname)) throw new Error("science-economics-endpoint-denied");
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORLD_BANK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: "application/json", "user-agent": "Agentlas-Science/1.0 (World Bank indicator research; https://agentlas.ai)" },
    });
    const declaredBytes = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredBytes) && declaredBytes > WORLD_BANK_RESPONSE_LIMIT_BYTES) throw new Error("science-economics-response-size-invalid");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 2 || body.length > WORLD_BANK_RESPONSE_LIMIT_BYTES) throw new Error("science-economics-response-size-invalid");
    return {
      body,
      status: response.status,
      mimeType: (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]!.trim(),
      ok: response.ok,
      retrievedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseReceipt(value: unknown, payload: ScienceEconomicIndicatorArtifactPayload): ScienceEconomicsCatalogReceipt {
  const receipt = record(value);
  const response = record(receipt?.response);
  if (!receipt || !exactKeys(receipt, ["schema", "provider", "request", "response", "normalization", "source"])
    || receipt.schema !== ECONOMICS_RECEIPT_SCHEMA || receipt.provider !== "world-bank" || !response
    || !exactKeys(response, ["sha256", "byteSize", "mimeType", "httpStatus", "retrievedAt", "durationMs"])) {
    throw new Error("science-economics-replay-receipt-invalid");
  }
  const durationMs = safeInteger(response.durationMs, 0, 86_400_000, "science-economics-replay-receipt-invalid");
  const expected = {
    schema: ECONOMICS_RECEIPT_SCHEMA,
    provider: "world-bank" as const,
    request: payload.evidence.request,
    response: { ...payload.evidence.response, durationMs },
    normalization: payload.evidence.normalization,
    source: payload.evidence.source,
  };
  if (canonicalJson(receipt) !== canonicalJson(expected)) throw new Error("science-economics-replay-receipt-invalid");
  return expected;
}

export class ScienceEconomicsCatalogService {
  constructor(
    private readonly store: ScienceStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly runtime: WorldBankRuntime = loadRuntime(),
  ) {}

  private upsertSource(input: {
    requestId: string;
    projectId: string;
    canonicalUri: string;
    title: string;
    body: Buffer;
    retrievedAt: string;
    sourceId: string | null;
    lastUpdated: string | null;
  }): ScienceSource {
    const contentSha256 = sha256(input.body);
    const sourceMetadata = [input.sourceId ? `source ${input.sourceId}` : null, input.lastUpdated ? `updated ${input.lastUpdated}` : null].filter(Boolean).join(", ");
    const abstract = `Exact World Bank Indicators API response${sourceMetadata ? ` (${sourceMetadata})` : ""}; missing observations are retained as null without imputation.`;
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.canonicalUri);
    if (!existing) {
      return this.store.createSource({
        requestId: stableUuid(`${input.requestId}:source:${input.canonicalUri}:${contentSha256}`),
        projectId: input.projectId,
        kind: "database-record",
        canonicalUri: input.canonicalUri,
        title: input.title,
        authors: ["World Bank"],
        publicationYear: null,
        publisher: "World Bank",
        containerTitle: "World Bank Indicators API v2",
        abstract,
        accessState: "retrieved",
        contentSha256,
        mimeType: "application/json",
        retrievedAt: input.retrievedAt,
        retrievalMethod: "agentlas-economic-data:world-bank-indicator@1.0.0",
        license: "World Bank Terms of Use",
      }, input.body).source;
    }
    if (existing.version.contentSha256 === contentSha256 && existing.version.mimeType === "application/json") return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.canonicalUri}:${contentSha256}`),
      projectId: input.projectId,
      sourceId: existing.id,
      accessState: "retrieved",
      contentSha256,
      mimeType: "application/json",
      retrievedAt: input.retrievedAt,
      retrievalMethod: "agentlas-economic-data:world-bank-indicator@1.0.0",
      license: "World Bank Terms of Use",
    }, input.body).source;
  }

  private artifactForRun(projectId: string, runId: string): ScienceArtifact | null {
    const artifact = this.store.getArtifactForSourceRun(projectId, runId, SCIENCE_ECONOMICS_LAB_ID);
    if (!artifact) return null;
    const payload = validateScienceEconomicIndicatorArtifactPayload(artifact.version.payload);
    if (payload.evidence.runId !== runId) throw new Error("science-economics-artifact-run-mismatch");
    this.assertRunClosure(projectId, payload);
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-economics-run-artifact-binding:v1:${projectId}:${runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId,
      runId,
      outputOrdinal: 3,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  private createArtifact(input: {
    projectId: string;
    conversationId: string;
    originMessageId: string;
    runId: string;
    environmentSha256: string;
    payload: ScienceEconomicIndicatorArtifactPayload;
  }): ScienceArtifact {
    const payload = validateScienceEconomicIndicatorArtifactPayload(input.payload);
    this.assertRunClosure(input.projectId, payload);
    const titleValue = record(record(payload.spec)?.title)?.text;
    const title = safeText(titleValue, 240, "science-economics-title-invalid");
    const observedCount = payload.table.rows.length - payload.evidence.normalization.missingValueCount;
    const artifact = this.store.createArtifact({
      projectId: input.projectId,
      sourceRunId: input.runId,
      kind: "chart.vega",
      title,
      rendererId: "agentlas.vega",
      rendererVersion: "6.4.0",
      rendererBinding: null,
      payload: payload as unknown as Record<string, unknown>,
      semantic: {
        title,
        summary: `${observedCount} exact World Bank ${payload.evidence.normalization.series.indicator.name} observations rendered as an interactive line and point chart; ${payload.evidence.normalization.missingValueCount} missing values remain null without imputation.`,
        entities: [
          { id: payload.evidence.normalization.series.country.iso3Code, label: payload.evidence.normalization.series.country.name, type: "country-or-economy" },
          { id: payload.evidence.normalization.series.indicator.code, label: payload.evidence.normalization.series.indicator.name, type: "economic-indicator" },
        ],
        observations: [
          { label: "Rows", value: payload.table.rows.length, unit: null },
          { label: "Observed values", value: observedCount, unit: null },
          { label: "Missing values", value: payload.evidence.normalization.missingValueCount, unit: null },
          { label: "Provider decimals", value: payload.evidence.normalization.series.decimals, unit: null },
        ],
        warnings: [
          ...(payload.evidence.normalization.missingValueCount > 0 ? [`${payload.evidence.normalization.missingValueCount} provider missing value(s) are preserved as null and are neither plotted nor imputed.`] : []),
          ...payload.evidence.normalization.provider.sourceNotes,
        ],
      },
      provenance: {
        sourceRunId: input.runId,
        sourceRefs: [payload.evidence.source.canonicalUri],
        datasetSha256: [payload.evidence.response.sha256, payload.evidence.normalization.sha256],
        codeSha256: null,
        environmentSha256: input.environmentSha256,
      },
      linkage: {
        labId: SCIENCE_ECONOMICS_LAB_ID,
        origin: {
          surface: "conversation",
          conversationId: input.conversationId,
          messageId: input.originMessageId,
          loopSessionId: null,
          runId: input.runId,
          branchId: null,
        },
        parent: null,
        inputs: [],
      },
    });
    this.store.bindSucceededRunArtifact({
      requestId: stableUuid(`science-economics-run-artifact-binding:v1:${input.projectId}:${input.runId}:${artifact.id}:${artifact.currentVersion}`),
      projectId: input.projectId,
      runId: input.runId,
      outputOrdinal: 3,
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      expectedArtifactContentSha256: artifact.version.contentSha256,
    });
    return artifact;
  }

  private assertRunClosure(projectId: string, payload: ScienceEconomicIndicatorArtifactPayload): void {
    const run = this.store.getResearchRunForProject(projectId, payload.evidence.runId);
    const rawOutput = run?.outputs[0];
    const receiptOutput = run?.outputs[1];
    const payloadOutput = run?.outputs[2];
    if (!run || run.status !== "succeeded" || run.toolId !== SCIENCE_ECONOMICS_TOOL_ID || run.toolVersion !== SCIENCE_ECONOMICS_TOOL_VERSION
      || run.inputs.length !== 1 || run.inputs[0]?.role !== "economic-indicator-query"
      || run.inputs[0]?.mimeType !== "application/vnd.agentlas.science.economic-indicator-query+json"
      || run.outputs.length !== 3
      || rawOutput?.role !== "provider-response" || rawOutput.mimeType !== "application/json"
      || receiptOutput?.role !== "provider-receipt" || receiptOutput.mimeType !== "application/vnd.agentlas.science.economic-indicator-receipt+json"
      || payloadOutput?.role !== "economic-indicator-artifact-payload" || payloadOutput.mimeType !== "application/vnd.agentlas.science.economic-indicator-artifact+json") {
      throw new Error("science-economics-run-closure-invalid");
    }
    const rawBytes = this.store.readRunBlob(rawOutput);
    const storedPayloadBytes = this.store.readRunBlob(payloadOutput);
    if (rawOutput.sha256 !== payload.evidence.response.sha256 || rawOutput.byteSize !== payload.evidence.response.byteSize
      || sha256(rawBytes) !== payload.evidence.response.sha256
      || payloadOutput.sha256 !== sha256(Buffer.from(canonicalJson(payload), "utf8"))
      || !storedPayloadBytes.equals(Buffer.from(canonicalJson(payload), "utf8"))) {
      throw new Error("science-economics-run-closure-invalid");
    }
    const source = this.store.getSourceVersionForProject(projectId, payload.evidence.source.id, payload.evidence.source.versionId);
    if (!source || source.canonicalUri !== payload.evidence.source.canonicalUri || source.version.accessState !== "retrieved"
      || source.version.mimeType !== "application/json" || source.version.contentSha256 !== payload.evidence.response.sha256
      || source.version.assetRef !== `science-source-cas:sha256:${payload.evidence.response.sha256}`) {
      throw new Error("science-economics-source-run-closure-invalid");
    }
    const receipt = parseReceipt(JSON.parse(this.store.readRunBlob(receiptOutput).toString("utf8")), payload);
    if (receipt.response.sha256 !== rawOutput.sha256 || receipt.source.id !== source.id || receipt.source.versionId !== source.version.id) {
      throw new Error("science-economics-receipt-run-closure-invalid");
    }
  }

  async fetchSeries(input: ScienceEconomicsCatalogInput): Promise<ScienceEconomicsCatalogResult> {
    const requestedTitle = optionalTitle(input.title);
    const builtUrl = validateWorldBankUrl(this.runtime.buildWorldBankUrl({
      country: input.country,
      indicator: input.indicator,
      startYear: input.startYear,
      endYear: input.endYear,
      page: 1,
      per_page: 1000,
    }));
    const url = new URL(builtUrl);
    const query: ScienceEconomicsQuery = {
      country: safeText(input.country, 3, "science-economics-country-invalid").toUpperCase(),
      indicator: safeText(input.indicator, 64, "science-economics-indicator-invalid").toUpperCase(),
      startYear: input.startYear,
      endYear: input.endYear,
    };
    const requestDescriptor = { method: "GET" as const, url: builtUrl, headers: { accept: "application/json" } };
    const requestSha256 = sha256(canonicalJson(requestDescriptor));
    const inputEnvelope = {
      schema: "agentlas.science.economic-indicator-query/v1",
      provider: "world-bank",
      query,
      request: { method: "GET", url: builtUrl, sha256: requestSha256 },
      title: requestedTitle,
      missingValuePolicy: "preserve-null",
    };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = {
      role: "economic-indicator-query",
      mimeType: "application/vnd.agentlas.science.economic-indicator-query+json",
      ...inputBlob,
      artifactId: null,
      artifactVersion: null,
    };
    const created = this.store.createResearchRun({
      requestId: input.requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originMessageId: input.originMessageId,
      toolId: SCIENCE_ECONOMICS_TOOL_ID,
      toolVersion: SCIENCE_ECONOMICS_TOOL_VERSION,
      runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({
        policy: "world-bank-indicator-exact-bytes-preserve-null-v1",
        plugin: "agentlas-economic-data@1.0.0",
        endpoint: WORLD_BANK_ORIGIN,
        runtime: process.version,
      })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;

    if (created.replayed && run.status === "failed") {
      const failureOutput = run.outputs.find((output) => output.role === "provider-receipt" && output.mimeType === "application/vnd.agentlas.science.economic-indicator-failure+json");
      const failure = failureOutput ? record(JSON.parse(this.store.readRunBlob(failureOutput).toString("utf8"))) : null;
      const code = typeof failure?.code === "string" ? failure.code : "science-economics-prior-run-failed";
      throw new Error(code);
    }
    if (created.replayed && run.status === "running") throw new Error("science-economics-run-in-progress");
    if (created.replayed && run.status === "succeeded") {
      const payloadOutput = run.outputs.find((output) => output.role === "economic-indicator-artifact-payload"
        && output.mimeType === "application/vnd.agentlas.science.economic-indicator-artifact+json");
      const receiptOutput = run.outputs.find((output) => output.role === "provider-receipt"
        && output.mimeType === "application/vnd.agentlas.science.economic-indicator-receipt+json");
      if (!payloadOutput || !receiptOutput) throw new Error("science-economics-replay-output-missing");
      const payload = validateScienceEconomicIndicatorArtifactPayload(JSON.parse(this.store.readRunBlob(payloadOutput).toString("utf8")));
      if (payload.evidence.runId !== run.id || canonicalJson(payload.evidence.query) !== canonicalJson(query)) throw new Error("science-economics-replay-output-invalid");
      const receipt = parseReceipt(JSON.parse(this.store.readRunBlob(receiptOutput).toString("utf8")), payload);
      const artifact = this.artifactForRun(input.projectId, run.id) ?? this.createArtifact({
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        runId: run.id,
        environmentSha256: run.environmentSha256,
        payload,
      });
      const title = artifact.title;
      return {
        schema: ECONOMICS_RESULT_SCHEMA,
        provider: "world-bank",
        query,
        title,
        sourceId: payload.evidence.source.id,
        sourceVersionId: payload.evidence.source.versionId,
        receipt,
        artifact,
        runId: run.id,
        replayed: true,
      };
    }

    let fetched: FetchedWorldBankResponse | null = null;
    try {
      fetched = await fetchWorldBank(url, this.fetchImpl);
      if (!fetched.ok) throw new Error(`science-economics-http-${fetched.status}`);
      if (fetched.mimeType !== "application/json") throw new Error("science-economics-response-mime-invalid");
      let providerPayload: unknown;
      try { providerPayload = JSON.parse(fetched.body.toString("utf8")); } catch { throw new Error("science-economics-response-json-invalid"); }
      const runtimeNormalized = this.runtime.normalizeWorldBankResponse(providerPayload);
      const normalized = validateNormalizedWorldBankResponse(runtimeNormalized, query);
      const sourceNotes = sourceNotesFromNormalized(runtimeNormalized);
      const responseSha256 = sha256(fetched.body);
      const normalizedSha256 = scienceEconomicsSha256(normalized);
      const title = requestedTitle ?? `${normalized.series.indicator.name} · ${normalized.series.country.name} · ${input.startYear}–${input.endYear}`;
      const source = this.upsertSource({
        requestId: input.requestId,
        projectId: input.projectId,
        canonicalUri: builtUrl,
        title,
        body: fetched.body,
        retrievedAt: fetched.retrievedAt,
        sourceId: normalized.provider.sourceId,
        lastUpdated: normalized.provider.lastUpdated,
      });
      const rows: ScienceEconomicIndicatorTableRow[] = normalized.observations
        .map((observation) => ({ ...observation }))
        .sort((left, right) => Number(left.date) - Number(right.date));
      const missingValueCount = rows.filter((row) => row.value === null).length;
      const payload = validateScienceEconomicIndicatorArtifactPayload({
        schema: SCIENCE_ECONOMICS_ARTIFACT_SCHEMA,
        table: {
          schema: SCIENCE_ECONOMICS_TABLE_SCHEMA,
          columns: [
            { id: "date", label: "Year", type: "string", unit: null, nullable: false },
            { id: "value", label: normalized.series.indicator.name, type: "number", unit: normalized.series.unit || null, nullable: true },
            { id: "unit", label: "Unit", type: "string", unit: null, nullable: false },
            { id: "decimals", label: "Decimals", type: "number", unit: null, nullable: false },
            { id: "observationStatus", label: "Observation status", type: "string", unit: null, nullable: true },
          ],
          rows,
        },
        spec: createScienceEconomicIndicatorVegaSpec(rows, title, normalized.series.indicator.name, normalized.series.unit),
        evidence: {
          schema: SCIENCE_ECONOMICS_EVIDENCE_SCHEMA,
          runId: run.id,
          query,
          source: { id: source.id, versionId: source.version.id, canonicalUri: builtUrl },
          request: { method: "GET", url: builtUrl, sha256: requestSha256 },
          response: {
            sha256: responseSha256,
            byteSize: fetched.body.length,
            mimeType: "application/json",
            httpStatus: fetched.status,
            retrievedAt: fetched.retrievedAt,
          },
          normalization: {
            schema: WORLD_BANK_NORMALIZED_SCHEMA,
            sha256: normalizedSha256,
            rowCount: rows.length,
            missingValueCount,
            missingValuePolicy: "preserve-null",
            pagination: normalized.pagination,
            provider: { sourceId: normalized.provider.sourceId, lastUpdated: normalized.provider.lastUpdated, sourceNotes },
            series: normalized.series,
          },
        },
      });
      const receipt: ScienceEconomicsCatalogReceipt = {
        schema: ECONOMICS_RECEIPT_SCHEMA,
        provider: "world-bank",
        request: payload.evidence.request,
        response: { ...payload.evidence.response, durationMs: fetched.durationMs },
        normalization: payload.evidence.normalization,
        source: payload.evidence.source,
      };
      const rawBlob = this.store.putRunBlob(fetched.body);
      const receiptBlob = this.store.putRunBlob(Buffer.from(canonicalJson(receipt), "utf8"));
      const payloadBlob = this.store.putRunBlob(Buffer.from(canonicalJson(payload), "utf8"));
      const outputs = [
        { role: "provider-response", mimeType: "application/json", ...rawBlob, artifactId: null, artifactVersion: null },
        { role: "provider-receipt", mimeType: "application/vnd.agentlas.science.economic-indicator-receipt+json", ...receiptBlob, artifactId: null, artifactVersion: null },
        { role: "economic-indicator-artifact-payload", mimeType: "application/vnd.agentlas.science.economic-indicator-artifact+json", ...payloadBlob, artifactId: null, artifactVersion: null },
      ];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`),
        projectId: input.projectId,
        runId: run.id,
        status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)),
        summary: `${rows.length - missingValueCount} exact World Bank observations retrieved; ${missingValueCount} missing values preserved as null.`,
        outputs,
      });
      const artifact = this.createArtifact({
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        runId: run.id,
        environmentSha256: run.environmentSha256,
        payload,
      });
      return {
        schema: ECONOMICS_RESULT_SCHEMA,
        provider: "world-bank",
        query,
        title,
        sourceId: source.id,
        sourceVersionId: source.version.id,
        receipt,
        artifact,
        runId: run.id,
        replayed: false,
      };
    } catch (error) {
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") {
        const code = error instanceof Error ? error.message.slice(0, 240) : "science-economics-provider-failed";
        const responseEvidence = fetched ? {
          sha256: sha256(fetched.body),
          byteSize: fetched.body.length,
          mimeType: fetched.mimeType || "application/octet-stream",
          httpStatus: fetched.status,
          retrievedAt: fetched.retrievedAt,
          durationMs: fetched.durationMs,
        } : null;
        const failure = {
          schema: ECONOMICS_FAILURE_SCHEMA,
          provider: "world-bank",
          request: { method: "GET", url: builtUrl, sha256: requestSha256 },
          response: responseEvidence,
          code,
        };
        const failureBlob = this.store.putRunBlob(Buffer.from(canonicalJson(failure), "utf8"));
        const outputs = [
          ...(fetched ? [{ role: "provider-response", mimeType: fetched.mimeType || "application/octet-stream", ...this.store.putRunBlob(fetched.body), artifactId: null, artifactVersion: null }] : []),
          { role: "provider-receipt", mimeType: "application/vnd.agentlas.science.economic-indicator-failure+json", ...failureBlob, artifactId: null, artifactVersion: null },
        ];
        this.store.completeResearchRun({
          requestId: stableUuid(`${input.requestId}:complete`),
          projectId: input.projectId,
          runId: run.id,
          status: "failed",
          outputManifestSha256: sha256(canonicalJson(outputs)),
          summary: code,
          outputs,
        });
      }
      throw error;
    }
  }
}
