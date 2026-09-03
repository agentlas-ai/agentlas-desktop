import { createHash } from "node:crypto";
import type { ScienceSource } from "../../shared/science-contract";
import { ScienceStore } from "./store";
import { loadSciencePluginRuntime } from "./plugin-runtime";

export const EARTHQUAKE_CATALOG_TOOL_ID = "agentlas.earthquake-catalog";
export const EARTHQUAKE_CATALOG_TOOL_VERSION = "1.0.0";
export const EARTHQUAKE_EVENT_DETAIL_TOOL_ID = "agentlas.earthquake-event-detail";
export const EARTHQUAKE_EVENT_DETAIL_TOOL_VERSION = "1.0.0";

type EarthEngine = {
  PLUGIN_VERSION: string;
  USGS_ENDPOINT: string;
  USER_AGENT: string;
  MAX_RESPONSE_BYTES: number;
  buildUsgsUrl(input: Record<string, unknown>): { input: Record<string, unknown>; url: string };
  buildUsgsEventDetailUrl(input: { eventId: string }): { input: { eventId: string }; url: string };
  normalizeUsgsGeoJson(input: unknown, pagination?: { orderBy?: string; offset?: number; limit?: number }): Record<string, unknown> & { eventCount: number; normalizedSha256: string; warnings: string[]; events: Array<Record<string, unknown>> };
  normalizeUsgsEventDetail(input: unknown, expectedEventId?: string): Record<string, unknown> & { normalizedSha256: string; warnings: string[]; event: Record<string, unknown>; parameterTable: Record<string, unknown>; productTable: Record<string, unknown> };
  sha256(value: Buffer | string): string;
  stableStringify(value: unknown): string;
};

export interface EarthquakeCatalogInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  startTime: string;
  endTime: string;
  minMagnitude?: number;
  maxMagnitude?: number;
  minDepthKm?: number;
  maxDepthKm?: number;
  bounds?: { minLongitude: number; minLatitude: number; maxLongitude: number; maxLatitude: number };
  limit?: number;
  offset?: number;
  orderBy?: "time" | "time-asc" | "magnitude" | "magnitude-asc";
  title?: string;
}

export interface EarthquakeEventDetailInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  eventId: string;
  title?: string;
}

export interface EarthquakeEventDetailResult {
  schema: "agentlas.earthquake-event-detail-result/v1";
  provider: "usgs-fdsn-event";
  query: { eventId: string };
  title: string;
  detail: Record<string, unknown>;
  sourceId: string;
  sourceVersionId: string;
  receipt: Record<string, unknown>;
  warnings: string[];
  runId: string;
  replayed: boolean;
}

export interface EarthquakeCatalogResult {
  schema: "agentlas.earthquake-catalog-result/v1";
  provider: "usgs-fdsn-event";
  query: Record<string, unknown>;
  title: string;
  catalog: Record<string, unknown>;
  sourceId: string;
  sourceVersionId: string;
  receipt: Record<string, unknown>;
  warnings: string[];
  runId: string;
  replayed: boolean;
}

function readEngine(): EarthEngine {
  return loadSciencePluginRuntime<EarthEngine>(
    "agentlas-earth-science", "runtime/earth-science.cjs", 16 * 1024 * 1024,
  ).runtime;
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
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function optionalTitle(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 240 && !/[\u0000-\u001f]/.test(value) ? value.trim() : null;
}

async function fetchUsgs(url: URL, fetchImpl: typeof fetch, userAgent: string): Promise<{ body: Buffer; response: Response; retrievedAt: string; durationMs: number; contentType: string }> {
  if (url.origin !== "https://earthquake.usgs.gov" || url.pathname !== "/fdsnws/event/1/query") throw new Error("science-earthquake-endpoint-denied");
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "error", headers: { accept: "application/json", "user-agent": userAgent } });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 8 * 1024 * 1024) throw new Error("science-earthquake-response-size-invalid");
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`science-earthquake-http-${response.status}`);
    const mime = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0].trim();
    if (!new Set(["application/json", "application/geo+json"]).has(mime) || body.length < 2 || body.length > 8 * 1024 * 1024) throw new Error("science-earthquake-response-invalid");
    return { body, response, retrievedAt: new Date().toISOString(), durationMs: Date.now() - started, contentType: mime };
  } finally {
    clearTimeout(timeout);
  }
}

export class ScienceEarthquakeCatalogService {
  constructor(private readonly store: ScienceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  async search(input: EarthquakeCatalogInput): Promise<EarthquakeCatalogResult> {
    const engine = readEngine();
    const built = engine.buildUsgsUrl({
      startTime: input.startTime,
      endTime: input.endTime,
      ...(input.minMagnitude === undefined ? {} : { minMagnitude: input.minMagnitude }),
      ...(input.maxMagnitude === undefined ? {} : { maxMagnitude: input.maxMagnitude }),
      ...(input.minDepthKm === undefined ? {} : { minDepthKm: input.minDepthKm }),
      ...(input.maxDepthKm === undefined ? {} : { maxDepthKm: input.maxDepthKm }),
      ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
    });
    const url = new URL(built.url);
    const title = optionalTitle(input.title) ?? `USGS earthquakes · ${input.startTime.slice(0, 10)}–${input.endTime.slice(0, 10)}`;
    const requestDescriptor = { method: "GET", url: built.url, accept: "application/json", userAgent: engine.USER_AGENT };
    const requestSha256 = engine.sha256(engine.stableStringify(requestDescriptor));
    const inputEnvelope = { schema: "agentlas.earthquake-catalog-query/v1", provider: "usgs-fdsn-event", endpoint: engine.USGS_ENDPOINT, requestSha256, query: built.input, title };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = { role: "earthquake-query", mimeType: "application/vnd.agentlas.earthquake-catalog-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: EARTHQUAKE_CATALOG_TOOL_ID, toolVersion: EARTHQUAKE_CATALOG_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "usgs-fdsn-event-v2", plugin: `agentlas-earth-science@${engine.PLUGIN_VERSION}`, runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "catalog-results" && resource.mimeType === "application/vnd.agentlas.earthquake-catalog-results+json");
      if (!output) throw new Error("science-earthquake-replay-output-missing");
      const stored = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as EarthquakeCatalogResult;
      if (stored.schema !== "agentlas.earthquake-catalog-result/v1" || stored.runId !== run.id) throw new Error("science-earthquake-replay-output-invalid");
      return { ...stored, replayed: true };
    }
    try {
      const fetched = await fetchUsgs(url, this.fetchImpl, engine.USER_AGENT);
      const normalized = engine.normalizeUsgsGeoJson(JSON.parse(fetched.body.toString("utf8")), {
        orderBy: String(built.input.orderBy), offset: Number(built.input.offset), limit: Number(built.input.limit),
      });
      const rawResponseSha256 = engine.sha256(fetched.body);
      const receipt = {
        schema: "agentlas.science-source-receipt/v1", provider: "USGS Earthquake Hazards Program", endpoint: engine.USGS_ENDPOINT,
        requestUrl: built.url, requestSha256, responseUrl: built.url, httpStatus: fetched.response.status,
        rawResponseSha256, rawResponseBytes: fetched.body.length, responseContentType: fetched.contentType,
        normalizedSha256: normalized.normalizedSha256, retrievedAt: fetched.retrievedAt, attempts: 1, itemCount: normalized.eventCount,
        network: {
          method: "GET", requestUrl: built.url, accept: "application/json", userAgent: engine.USER_AGENT,
          responseUrl: built.url, httpStatus: fetched.response.status, responseContentType: fetched.contentType,
          rawResponseBytes: fetched.body.length, rawResponseSha256, redirects: "denied", attempts: 1,
        },
        limits: { responseBytes: engine.MAX_RESPONSE_BYTES, events: 2000, querySpanDays: 366, minIntervalMs: 1000, timeoutMs: 15000 },
      };
      let source: ScienceSource | null = this.store.getSourceByCanonicalUriForProject(input.projectId, built.url);
      if (!source) {
        source = this.store.createSource({
          requestId: stableUuid(`${input.requestId}:source:${requestSha256}`), projectId: input.projectId, kind: "database-record", canonicalUri: built.url,
          title, authors: ["U.S. Geological Survey"], publicationYear: null, publisher: "USGS", containerTitle: "FDSN Event Web Service",
          abstract: "Exact bounded USGS earthquake observations; missing magnitudes and place labels are preserved without imputation.", accessState: "retrieved",
          contentSha256: rawResponseSha256, mimeType: "application/geo+json", retrievedAt: fetched.retrievedAt,
          retrievalMethod: `agentlas-earth-science:usgs-fdsn-event@${engine.PLUGIN_VERSION}`, license: "USGS-public-domain",
        }, fetched.body).source;
      } else if (source.version.contentSha256 !== rawResponseSha256 || source.version.mimeType !== "application/geo+json") {
        source = this.store.appendSourceVersion({
          requestId: stableUuid(`${input.requestId}:source-version:${rawResponseSha256}`), projectId: input.projectId, sourceId: source.id,
          accessState: "retrieved", contentSha256: rawResponseSha256, mimeType: "application/geo+json", retrievedAt: fetched.retrievedAt,
          retrievalMethod: `agentlas-earth-science:usgs-fdsn-event@${engine.PLUGIN_VERSION}`, license: "USGS-public-domain",
        }, fetched.body).source;
      }
      const partial: EarthquakeCatalogResult = {
        schema: "agentlas.earthquake-catalog-result/v1", provider: "usgs-fdsn-event", query: built.input, title,
        catalog: normalized, sourceId: source.id, sourceVersionId: source.version.id, receipt, warnings: normalized.warnings, runId: run.id, replayed: false,
      };
      const rawBlob = this.store.putRunBlob(fetched.body);
      const rawResource = { role: "provider-response", mimeType: "application/geo+json", ...rawBlob, artifactId: null, artifactVersion: null };
      const resultBlob = this.store.putRunBlob(Buffer.from(canonicalJson(partial), "utf8"));
      const resultResource = { role: "catalog-results", mimeType: "application/vnd.agentlas.earthquake-catalog-results+json", ...resultBlob, artifactId: null, artifactVersion: null };
      const outputs = [rawResource, resultResource];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: `${normalized.eventCount} exact USGS earthquake observations retrieved.`, outputs,
      });
      return partial;
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 240) : "science-earthquake-catalog-failed";
      const failureBlob = this.store.putRunBlob(Buffer.from(canonicalJson({ schema: "agentlas.earthquake-catalog-failure/v1", provider: "usgs-fdsn-event", requestSha256, code }), "utf8"));
      const failureResource = { role: "provider-receipt", mimeType: "application/vnd.agentlas.earthquake-catalog-failure+json", ...failureBlob, artifactId: null, artifactVersion: null };
      this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson([failureResource])), summary: code, outputs: [failureResource] });
      throw error;
    }
  }

  async getEventDetail(input: EarthquakeEventDetailInput): Promise<EarthquakeEventDetailResult> {
    const engine = readEngine();
    const built = engine.buildUsgsEventDetailUrl({ eventId: input.eventId });
    const url = new URL(built.url);
    const title = optionalTitle(input.title) ?? `USGS earthquake detail · ${built.input.eventId}`;
    const requestDescriptor = { method: "GET", url: built.url, accept: "application/json", userAgent: engine.USER_AGENT };
    const requestSha256 = engine.sha256(engine.stableStringify(requestDescriptor));
    const inputEnvelope = { schema: "agentlas.earthquake-event-detail-query/v1", provider: "usgs-fdsn-event", endpoint: engine.USGS_ENDPOINT, requestSha256, query: built.input, title };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson(inputEnvelope), "utf8"));
    const inputResource = { role: "earthquake-event-detail-query", mimeType: "application/vnd.agentlas.earthquake-event-detail-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: EARTHQUAKE_EVENT_DETAIL_TOOL_ID, toolVersion: EARTHQUAKE_EVENT_DETAIL_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ policy: "usgs-fdsn-event-detail-v1", plugin: `agentlas-earth-science@${engine.PLUGIN_VERSION}`, runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "event-detail-results" && resource.mimeType === "application/vnd.agentlas.earthquake-event-detail-results+json");
      if (!output) throw new Error("science-earthquake-event-detail-replay-output-missing");
      const stored = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as EarthquakeEventDetailResult;
      if (stored.schema !== "agentlas.earthquake-event-detail-result/v1" || stored.runId !== run.id) throw new Error("science-earthquake-event-detail-replay-output-invalid");
      return { ...stored, replayed: true };
    }
    try {
      const fetched = await fetchUsgs(url, this.fetchImpl, engine.USER_AGENT);
      const detail = engine.normalizeUsgsEventDetail(JSON.parse(fetched.body.toString("utf8")), built.input.eventId);
      const rawResponseSha256 = engine.sha256(fetched.body);
      const receipt = {
        schema: "agentlas.science-source-receipt/v1", provider: "USGS Earthquake Hazards Program", endpoint: engine.USGS_ENDPOINT,
        requestUrl: built.url, requestSha256, rawResponseSha256, normalizedSha256: detail.normalizedSha256,
        retrievedAt: fetched.retrievedAt, durationMs: fetched.durationMs, httpStatus: fetched.response.status, itemCount: 1,
        limits: { responseBytes: engine.MAX_RESPONSE_BYTES, events: 1, timeoutMs: 15000 },
      };
      let source: ScienceSource | null = this.store.getSourceByCanonicalUriForProject(input.projectId, built.url);
      if (!source) {
        source = this.store.createSource({
          requestId: stableUuid(`${input.requestId}:source:${requestSha256}`), projectId: input.projectId, kind: "database-record", canonicalUri: built.url,
          title, authors: ["U.S. Geological Survey"], publicationYear: null, publisher: "USGS", containerTitle: "ANSS Comprehensive Earthquake Catalog",
          abstract: "Exact USGS ComCat event detail including origin quality, uncertainty, error ellipse, and product/content inventory.", accessState: "retrieved",
          contentSha256: rawResponseSha256, mimeType: "application/geo+json", retrievedAt: fetched.retrievedAt,
          retrievalMethod: `agentlas-earth-science:usgs-event-detail@${engine.PLUGIN_VERSION}`, license: "USGS-public-domain",
        }, fetched.body).source;
      } else if (source.version.contentSha256 !== rawResponseSha256 || source.version.mimeType !== "application/geo+json") {
        source = this.store.appendSourceVersion({
          requestId: stableUuid(`${input.requestId}:source-version:${rawResponseSha256}`), projectId: input.projectId, sourceId: source.id,
          accessState: "retrieved", contentSha256: rawResponseSha256, mimeType: "application/geo+json", retrievedAt: fetched.retrievedAt,
          retrievalMethod: `agentlas-earth-science:usgs-event-detail@${engine.PLUGIN_VERSION}`, license: "USGS-public-domain",
        }, fetched.body).source;
      }
      const partial: EarthquakeEventDetailResult = {
        schema: "agentlas.earthquake-event-detail-result/v1", provider: "usgs-fdsn-event", query: built.input, title,
        detail, sourceId: source.id, sourceVersionId: source.version.id, receipt, warnings: detail.warnings, runId: run.id, replayed: false,
      };
      const rawBlob = this.store.putRunBlob(fetched.body);
      const rawResource = { role: "provider-response", mimeType: "application/geo+json", ...rawBlob, artifactId: null, artifactVersion: null };
      const resultBlob = this.store.putRunBlob(Buffer.from(canonicalJson(partial), "utf8"));
      const resultResource = { role: "event-detail-results", mimeType: "application/vnd.agentlas.earthquake-event-detail-results+json", ...resultBlob, artifactId: null, artifactVersion: null };
      const outputs = [rawResource, resultResource];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: `Exact USGS event detail for ${built.input.eventId} retrieved with quality, uncertainty, and ${String(detail.productCount ?? 0)} products.`, outputs,
      });
      return partial;
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 240) : "science-earthquake-event-detail-failed";
      const failureBlob = this.store.putRunBlob(Buffer.from(canonicalJson({ schema: "agentlas.earthquake-event-detail-failure/v1", provider: "usgs-fdsn-event", requestSha256, code }), "utf8"));
      const failureResource = { role: "provider-receipt", mimeType: "application/vnd.agentlas.earthquake-event-detail-failure+json", ...failureBlob, artifactId: null, artifactVersion: null };
      this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson([failureResource])), summary: code, outputs: [failureResource] });
      throw error;
    }
  }
}
