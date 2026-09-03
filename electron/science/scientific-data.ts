import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { ScienceSource } from "../../shared/science-contract";
import { ScienceStore } from "./store";

export const SCIENTIFIC_DATA_TOOL_ID = "agentlas.scientific-data";
export const SCIENTIFIC_DATA_TOOL_VERSION = "1.0.0";

export const SCIENTIFIC_DATA_PROVIDERS = ["rcsb-pdb", "pubchem"] as const;
export type ScientificDataProvider = typeof SCIENTIFIC_DATA_PROVIDERS[number];

export type ScientificDataQuery =
  | { provider: "rcsb-pdb"; entryId: string }
  | { provider: "pubchem"; namespace: "cid" | "name" | "inchikey"; value: string };

export interface ScientificDataSourceDescriptor {
  id: ScientificDataProvider;
  version: string;
  label: string;
  domains: string[];
  entityKinds: string[];
  status: "ready";
  policyUrl: string;
  licensePolicy: "provider-cc0" | "contributor-specific";
  materializer: "agentlas.source-to-molstar" | "agentlas.source-to-ketcher" | null;
}

export interface ScientificDataHttpReceipt {
  endpointOrigin: string;
  endpointPath: string;
  endpointSearch: string;
  requestSha256: string;
  responseSha256: string | null;
  retrievedAt: string;
  durationMs: number;
  status: "ok" | "error";
  httpStatus: number | null;
  mimeType: string | null;
  byteSize: number;
  retryCount: number;
  headers: {
    etag: string | null;
    lastModified: string | null;
    retryAfter: string | null;
    rateLimit: string | null;
    rateRemaining: string | null;
    throttlingControl: string | null;
  };
  errorCode: string | null;
}

export interface ScientificDataRetrievalResult {
  schema: "agentlas.scientific-data-retrieval/v1";
  provider: ScientificDataProvider;
  providerVersion: string;
  canonicalExternalId: string;
  entityKind: "protein-structure" | "compound";
  metadata:
    | { kind: "rcsb-entry"; title: string; authors: string[]; publicationYear: number | null }
    | { kind: "pubchem-compound"; cid: string; title: string; canonicalSmiles: string | null };
  source: ScienceSource;
  receipts: ScientificDataHttpReceipt[];
  materialization: {
    status: "ready" | "source-only";
    toolId: "agentlas.source-to-molstar" | "agentlas.source-to-ketcher" | null;
    retrievalRunId: string;
    sourceId: string;
    sourceVersionId: string;
    reason: string | null;
  };
  runId: string;
  replayed: boolean;
}

export interface RetrieveScientificDataInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  query: ScientificDataQuery;
}

const DESCRIPTORS: readonly ScientificDataSourceDescriptor[] = Object.freeze([
  Object.freeze({
    id: "rcsb-pdb", version: "1.0.0", label: "RCSB Protein Data Bank",
    domains: ["life-science", "chemistry"], entityKinds: ["protein-structure"], status: "ready",
    policyUrl: "https://www.rcsb.org/pages/usage-policy", licensePolicy: "provider-cc0",
    materializer: "agentlas.source-to-molstar",
  }),
  Object.freeze({
    id: "pubchem", version: "1.0.0", label: "PubChem",
    domains: ["chemistry", "life-science"], entityKinds: ["compound"], status: "ready",
    policyUrl: "https://pubchem.ncbi.nlm.nih.gov/docs/data-sources", licensePolicy: "contributor-specific",
    materializer: "agentlas.source-to-ketcher",
  }),
]);

const PROVIDER_HOSTS: Record<ScientificDataProvider, Set<string>> = {
  "rcsb-pdb": new Set(["data.rcsb.org", "files.rcsb.org"]),
  pubchem: new Set(["pubchem.ncbi.nlm.nih.gov"]),
};
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_STRUCTURE_BYTES = 32 * 1024 * 1024;
const MAX_CHEMISTRY_BYTES = 4 * 1024 * 1024;
const singleFlights = new Map<string, Promise<ScientificDataRetrievalResult>>();
const singleFlightInputSha256 = new Map<string, string>();
const originStarts = new Map<string, Promise<number>>();

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function exactText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(code);
  return value.trim();
}

function normalizedQuery(query: ScientificDataQuery): ScientificDataQuery {
  if (!query || typeof query !== "object" || !SCIENTIFIC_DATA_PROVIDERS.includes(query.provider)) throw new Error("science-data-provider-invalid");
  if (query.provider === "rcsb-pdb") {
    const entryId = exactText(query.entryId, 12, "science-data-rcsb-id-invalid").toUpperCase();
    if (!/^[0-9][A-Z0-9]{3}$/.test(entryId)) throw new Error("science-data-rcsb-id-invalid");
    return { provider: "rcsb-pdb", entryId };
  }
  if (!["cid", "name", "inchikey"].includes(query.namespace)) throw new Error("science-data-pubchem-namespace-invalid");
  const maximum = query.namespace === "name" ? 240 : 80;
  const value = exactText(query.value, maximum, "science-data-pubchem-value-invalid");
  if (query.namespace === "cid" && !/^[1-9]\d{0,11}$/.test(value)) throw new Error("science-data-pubchem-cid-invalid");
  if (query.namespace === "inchikey" && !/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/i.test(value)) throw new Error("science-data-pubchem-inchikey-invalid");
  if (query.namespace === "name" && !/^[\p{L}\p{N}][\p{L}\p{N} .,'()+\-]{0,239}$/u.test(value)) throw new Error("science-data-pubchem-name-invalid");
  return { provider: "pubchem", namespace: query.namespace, value: query.namespace === "inchikey" ? value.toUpperCase() : value };
}

function allowedUrl(provider: ScientificDataProvider, url: URL): void {
  if (url.protocol !== "https:" || url.username || url.password || url.port || !PROVIDER_HOSTS[provider].has(url.hostname.toLowerCase())) throw new Error("science-data-endpoint-denied");
  const pathAllowed = provider === "rcsb-pdb"
    ? (url.hostname === "data.rcsb.org" && url.pathname.startsWith("/rest/v1/core/entry/")) || (url.hostname === "files.rcsb.org" && /^\/download\/[0-9A-Z]{4}\.cif$/i.test(url.pathname))
    : url.hostname === "pubchem.ncbi.nlm.nih.gov" && url.pathname.startsWith("/rest/pug/compound/");
  if (!pathAllowed) throw new Error("science-data-endpoint-denied");
}

function headerReceipt(headers: Headers): ScientificDataHttpReceipt["headers"] {
  return {
    etag: headers.get("etag"), lastModified: headers.get("last-modified"), retryAfter: headers.get("retry-after"),
    rateLimit: headers.get("x-ratelimit-limit") ?? headers.get("x-rate-limit-limit"),
    rateRemaining: headers.get("x-ratelimit-remaining") ?? headers.get("x-rate-limit-remaining"),
    throttlingControl: headers.get("x-throttling-control"),
  };
}

async function waitForOrigin(origin: string, minimumIntervalMs: number): Promise<void> {
  const prior = originStarts.get(origin) ?? Promise.resolve(0);
  const next = prior.then(async (last) => {
    const wait = Math.max(0, last + minimumIntervalMs - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    return Date.now();
  });
  originStarts.set(origin, next.catch(() => Date.now()));
  await next;
}

async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) throw new Error("science-data-response-too-large");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maximum) { await reader.cancel(); throw new Error("science-data-response-too-large"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function retryDelay(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(5_000, Math.round(seconds * 1_000)));
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, Math.min(5_000, date - Date.now()));
  }
  return Math.min(2_000, 250 * (2 ** attempt));
}

type SafeFetch = { bytes: Buffer; receipt: ScientificDataHttpReceipt };

async function safeFetch(
  provider: ScientificDataProvider,
  url: URL,
  expectedMime: readonly string[],
  maximumBytes: number,
  fetchImpl: typeof fetch,
): Promise<SafeFetch> {
  allowedUrl(provider, url);
  const started = Date.now();
  const requestSha256 = sha256(canonicalJson({ method: "GET", origin: url.origin, path: url.pathname, search: url.search }));
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForOrigin(url.origin, provider === "pubchem" ? 250 : 200);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetchImpl(url, {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: { accept: expectedMime.join(", "), "user-agent": "Agentlas-Science/1.0 (scientific data retrieval; https://agentlas.ai)" },
      });
      lastResponse = response;
      const mimeType = (response.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0].trim();
      if ((response.status === 429 || response.status === 503) && attempt < 2) {
        await readBounded(response, 64 * 1024).catch(() => Buffer.alloc(0));
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      if (!response.ok) throw new Error(`science-data-http-${response.status}`);
      if (!expectedMime.includes(mimeType)) throw new Error("science-data-response-mime-invalid");
      const bytes = await readBounded(response, maximumBytes);
      if (!bytes.length) throw new Error("science-data-response-empty");
      return {
        bytes,
        receipt: {
          endpointOrigin: url.origin, endpointPath: url.pathname, requestSha256, responseSha256: sha256(bytes),
          endpointSearch: url.search,
          retrievedAt: new Date().toISOString(), durationMs: Date.now() - started, status: "ok", httpStatus: response.status,
          mimeType, byteSize: bytes.length, retryCount: attempt, headers: headerReceipt(response.headers), errorCode: null,
        },
      };
    } catch (error) {
      if (attempt < 2 && (error instanceof DOMException && error.name === "AbortError")) continue;
      const mimeType = (lastResponse?.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0].trim() || null;
      throw Object.assign(error instanceof Error ? error : new Error("science-data-fetch-failed"), {
        receipt: {
          endpointOrigin: url.origin, endpointPath: url.pathname, requestSha256, responseSha256: null,
          endpointSearch: url.search,
          retrievedAt: new Date().toISOString(), durationMs: Date.now() - started, status: "error", httpStatus: lastResponse?.status ?? null,
          mimeType, byteSize: 0, retryCount: attempt, headers: lastResponse ? headerReceipt(lastResponse.headers) : headerReceipt(new Headers()),
          errorCode: error instanceof Error ? error.message.slice(0, 240) : "science-data-fetch-failed",
        } satisfies ScientificDataHttpReceipt,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("science-data-retry-exhausted");
}

function jsonRecord(bytes: Buffer, code: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(code); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function rcsbMetadata(record: Record<string, unknown>, entryId: string): { title: string; authors: string[]; publicationYear: number | null } {
  const struct = record.struct && typeof record.struct === "object" ? record.struct as Record<string, unknown> : {};
  const title = typeof struct.title === "string" && struct.title.trim() ? struct.title.trim().slice(0, 1_000) : `RCSB PDB ${entryId}`;
  const audit = Array.isArray(record.audit_author) ? record.audit_author : [];
  const authors = audit.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).name ?? "").trim() : "").filter(Boolean).slice(0, 500);
  const accession = record.rcsb_accession_info && typeof record.rcsb_accession_info === "object" ? record.rcsb_accession_info as Record<string, unknown> : {};
  const year = typeof accession.initial_release_date === "string" ? Number(accession.initial_release_date.slice(0, 4)) : NaN;
  return { title, authors, publicationYear: Number.isSafeInteger(year) && year >= 1000 && year <= 3000 ? year : null };
}

function pubchemProperty(record: Record<string, unknown>): { cid: string; title: string; canonicalSmiles: string | null } {
  const table = record.PropertyTable && typeof record.PropertyTable === "object" ? record.PropertyTable as Record<string, unknown> : {};
  const properties = Array.isArray(table.Properties) ? table.Properties : [];
  const first = properties[0] && typeof properties[0] === "object" ? properties[0] as Record<string, unknown> : null;
  if (!first || !Number.isSafeInteger(first.CID) || Number(first.CID) < 1) throw new Error("science-data-pubchem-property-invalid");
  const cid = String(first.CID);
  const title = typeof first.Title === "string" && first.Title.trim() ? first.Title.trim().slice(0, 1_000) : `PubChem CID ${cid}`;
  const smiles = typeof first.ConnectivitySMILES === "string" ? first.ConnectivitySMILES : typeof first.SMILES === "string" ? first.SMILES : null;
  return { cid, title, canonicalSmiles: smiles };
}

function assertPubChemSdf(bytes: Buffer): void {
  if (bytes.length > MAX_CHEMISTRY_BYTES) throw new Error("science-data-response-too-large");
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("science-data-pubchem-sdf-invalid"); }
  if ((value.match(/^\$\$\$\$\s*$/gm) ?? []).length !== 1
    || !/\$\$\$\$\s*$/.test(value)) {
    throw new Error("science-data-pubchem-sdf-invalid");
  }
}

type RunResourceLike = {
  role: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  blobRef: string;
  artifactId: string | null;
  artifactVersion: number | null;
};

function manifestResource(resource: RunResourceLike): RunResourceLike {
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

function receiptRecord(value: unknown): ScientificDataHttpReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-data-run-receipt-invalid");
  const receipt = value as Record<string, unknown>;
  const headers = receipt.headers && typeof receipt.headers === "object" && !Array.isArray(receipt.headers)
    ? receipt.headers as Record<string, unknown>
    : null;
  if (!exactKeys(receipt, [
    "endpointOrigin", "endpointPath", "endpointSearch", "requestSha256", "responseSha256", "retrievedAt", "durationMs",
    "status", "httpStatus", "mimeType", "byteSize", "retryCount", "headers", "errorCode",
  ]) || !headers || !exactKeys(headers, ["etag", "lastModified", "retryAfter", "rateLimit", "rateRemaining", "throttlingControl"])
    || receipt.status !== "ok" || receipt.httpStatus !== 200 || receipt.errorCode !== null
    || typeof receipt.endpointOrigin !== "string" || typeof receipt.endpointPath !== "string" || typeof receipt.endpointSearch !== "string"
    || typeof receipt.requestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.requestSha256)
    || typeof receipt.responseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.responseSha256)
    || typeof receipt.mimeType !== "string" || !receipt.mimeType
    || typeof receipt.retrievedAt !== "string" || !Number.isFinite(Date.parse(receipt.retrievedAt))
    || !Number.isSafeInteger(receipt.durationMs) || Number(receipt.durationMs) < 0
    || !Number.isSafeInteger(receipt.byteSize) || Number(receipt.byteSize) < 1
    || !Number.isSafeInteger(receipt.retryCount) || Number(receipt.retryCount) < 0 || Number(receipt.retryCount) > 2
    || Object.values(headers).some((header) => header !== null && typeof header !== "string")) {
    throw new Error("science-data-run-receipt-invalid");
  }
  return receipt as unknown as ScientificDataHttpReceipt;
}

function sourceForBytes(
  store: ScienceStore,
  requestId: string,
  projectId: string,
  metadata: { canonicalUri: string; title: string; authors: string[]; publicationYear: number | null; publisher: string; license: string | null },
  bytes: Buffer,
  mimeType: string,
  retrievalMethod: string,
  retrievedAt: string,
): ScienceSource {
  const digest = sha256(bytes);
  const existing = store.getSourceByCanonicalUriForProject(projectId, metadata.canonicalUri);
  if (!existing) return store.createSource({
    requestId, projectId, kind: "database-record", canonicalUri: metadata.canonicalUri, title: metadata.title,
    authors: metadata.authors, publicationYear: metadata.publicationYear, publisher: metadata.publisher,
    accessState: "retrieved", contentSha256: digest, mimeType, retrievedAt, retrievalMethod, license: metadata.license,
  }, bytes).source;
  if (existing.publisher !== metadata.publisher || existing.title !== metadata.title
    || canonicalJson(existing.authors) !== canonicalJson(metadata.authors)
    || existing.publicationYear !== metadata.publicationYear) {
    throw new Error("science-data-source-identity-conflict");
  }
  if (existing.version.contentSha256 === digest && existing.version.mimeType?.split(";", 1)[0].toLowerCase() === mimeType) {
    if (existing.version.retrievalMethod !== retrievalMethod || existing.version.license !== metadata.license) {
      throw new Error("science-data-source-identity-conflict");
    }
    return existing;
  }
  return store.appendSourceVersion({
    requestId, projectId, sourceId: existing.id, accessState: "retrieved", contentSha256: digest,
    mimeType, retrievedAt, retrievalMethod, license: metadata.license,
  }, bytes).source;
}

export type ScientificDataMaterializerAvailability = (toolId: NonNullable<ScientificDataSourceDescriptor["materializer"]>) => boolean;

export function listScientificDataSources(materializerAvailable: ScientificDataMaterializerAvailability = (toolId) => toolId === "agentlas.source-to-molstar"): ScientificDataSourceDescriptor[] {
  return DESCRIPTORS.map((item) => ({
    ...item,
    domains: [...item.domains],
    entityKinds: [...item.entityKinds],
    materializer: item.materializer && materializerAvailable(item.materializer) ? item.materializer : null,
  }));
}

export class ScienceScientificDataService {
  constructor(
    private readonly store: ScienceStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly materializerAvailable: ScientificDataMaterializerAvailability = (toolId) => toolId === "agentlas.source-to-molstar",
  ) {}

  listSources(): ScientificDataSourceDescriptor[] { return listScientificDataSources(this.materializerAvailable); }

  private storedResultForRun(
    projectId: string,
    runId: string,
    expectedQuery?: ScientificDataQuery,
  ): ScientificDataRetrievalResult {
    const run = this.store.getResearchRunForProject(projectId, runId);
    const input = run?.inputs[0];
    const metadataOutput = run?.outputs[0];
    const structureOutput = run?.outputs[1];
    const resultOutput = run?.outputs[2];
    if (!run || run.status !== "succeeded" || run.toolId !== SCIENTIFIC_DATA_TOOL_ID || run.toolVersion !== SCIENTIFIC_DATA_TOOL_VERSION
      || run.runtime !== "electron-main" || run.inputs.length !== 1 || run.outputs.length !== 3
      || input?.role !== "scientific-data-query" || input.mimeType !== "application/vnd.agentlas.scientific-data-query+json"
      || metadataOutput?.role !== "provider-metadata-response" || metadataOutput.mimeType !== "application/json"
      || structureOutput?.role !== "provider-structure-response"
      || resultOutput?.role !== "scientific-data-retrieval" || resultOutput.mimeType !== "application/vnd.agentlas.scientific-data-retrieval+json") {
      throw new Error("science-data-run-closure-invalid");
    }
    if (sha256(canonicalJson(run.inputs.map(manifestResource))) !== run.inputManifestSha256
      || !run.outputManifestSha256
      || sha256(canonicalJson(run.outputs.map(manifestResource))) !== run.outputManifestSha256) {
      throw new Error("science-data-run-manifest-invalid");
    }
    const inputBytes = this.store.readRunBlob(input);
    const metadataBytes = this.store.readRunBlob(metadataOutput);
    const structureBytes = this.store.readRunBlob(structureOutput);
    const resultBytes = this.store.readRunBlob(resultOutput);
    let queryEnvelope: Record<string, unknown>;
    let resultRecord: Record<string, unknown>;
    try {
      queryEnvelope = jsonRecord(inputBytes, "science-data-run-query-invalid");
      resultRecord = jsonRecord(resultBytes, "science-data-run-result-invalid");
    } catch {
      throw new Error("science-data-run-closure-invalid");
    }
    const rawQuery = queryEnvelope.query && typeof queryEnvelope.query === "object" && !Array.isArray(queryEnvelope.query)
      ? queryEnvelope.query as ScientificDataQuery
      : null;
    let query: ScientificDataQuery;
    try { query = normalizedQuery(rawQuery as ScientificDataQuery); }
    catch { throw new Error("science-data-run-query-invalid"); }
    if (!exactKeys(queryEnvelope, ["schema", "query"]) || queryEnvelope.schema !== "agentlas.scientific-data-query/v1"
      || !inputBytes.equals(Buffer.from(canonicalJson({ schema: "agentlas.scientific-data-query/v1", query }), "utf8"))
      || (expectedQuery && canonicalJson(query) !== canonicalJson(normalizedQuery(expectedQuery)))) {
      throw new Error("science-data-run-query-invalid");
    }
    if (!exactKeys(resultRecord, ["schema", "provider", "providerVersion", "canonicalExternalId", "entityKind", "metadata", "source", "receipts", "materialization", "runId", "replayed"])
      || resultRecord.schema !== "agentlas.scientific-data-retrieval/v1" || resultRecord.provider !== query.provider
      || resultRecord.providerVersion !== "1.0.0" || resultRecord.runId !== run.id || resultRecord.replayed !== false
      || !resultBytes.equals(Buffer.from(canonicalJson(resultRecord), "utf8"))) {
      throw new Error("science-data-run-result-invalid");
    }
    const receipts = Array.isArray(resultRecord.receipts) ? resultRecord.receipts.map(receiptRecord) : [];
    if (receipts.length !== 2) throw new Error("science-data-run-receipt-invalid");
    const [metadataReceipt, structureReceipt] = receipts;
    if (metadataReceipt.responseSha256 !== metadataOutput.sha256 || metadataReceipt.byteSize !== metadataOutput.byteSize
      || metadataReceipt.mimeType !== metadataOutput.mimeType || metadataReceipt.responseSha256 !== sha256(metadataBytes)
      || structureReceipt.responseSha256 !== structureOutput.sha256 || structureReceipt.byteSize !== structureOutput.byteSize
      || structureReceipt.mimeType !== structureOutput.mimeType || structureReceipt.responseSha256 !== sha256(structureBytes)) {
      throw new Error("science-data-run-receipt-invalid");
    }
    const resultSource = resultRecord.source && typeof resultRecord.source === "object" && !Array.isArray(resultRecord.source)
      ? resultRecord.source as ScienceSource
      : null;
    const materialization = resultRecord.materialization && typeof resultRecord.materialization === "object" && !Array.isArray(resultRecord.materialization)
      ? resultRecord.materialization as Record<string, unknown>
      : null;
    if (!resultSource || !materialization || !exactKeys(materialization, ["status", "toolId", "retrievalRunId", "sourceId", "sourceVersionId", "reason"])
      || materialization.retrievalRunId !== run.id || materialization.sourceId !== resultSource.id
      || materialization.sourceVersionId !== resultSource.version.id) {
      throw new Error("science-data-run-source-binding-invalid");
    }
    const expectedMaterializer = query.provider === "rcsb-pdb" ? "agentlas.source-to-molstar" : "agentlas.source-to-ketcher";
    if (materialization.status === "ready") {
      if (materialization.toolId !== expectedMaterializer || materialization.reason !== null) throw new Error("science-data-run-materialization-invalid");
    } else if (materialization.status === "source-only") {
      if (materialization.toolId !== null || typeof materialization.reason !== "string" || !materialization.reason.trim()) {
        throw new Error("science-data-run-materialization-invalid");
      }
    } else {
      throw new Error("science-data-run-materialization-invalid");
    }
    const source = this.store.getSourceVersionForProject(projectId, resultSource.id, resultSource.version.id);
    if (!source || canonicalJson(source) !== canonicalJson(resultSource) || source.kind !== "database-record"
      || source.version.accessState !== "retrieved" || source.version.contentSha256 !== structureOutput.sha256
      || source.version.assetRef !== `science-source-cas:sha256:${structureOutput.sha256}`) {
      throw new Error("science-data-run-source-binding-invalid");
    }
    if (query.provider === "rcsb-pdb") {
      const parsedMetadata = rcsbMetadata(jsonRecord(metadataBytes, "science-data-rcsb-metadata-invalid"), query.entryId);
      const expectedMetadata = { kind: "rcsb-entry", ...parsedMetadata };
      const verified = this.store.getVerifiedSourceVersionForTool(projectId, source.id, source.version.id);
      const metadataPath = `/rest/v1/core/entry/${query.entryId}`;
      const structurePath = `/download/${query.entryId}.cif`;
      if (resultRecord.canonicalExternalId !== query.entryId || resultRecord.entityKind !== "protein-structure"
        || canonicalJson(resultRecord.metadata) !== canonicalJson(expectedMetadata)
        || source.canonicalUri !== `pdb:${query.entryId}` || source.publisher !== "RCSB Protein Data Bank"
        || source.title !== parsedMetadata.title || canonicalJson(source.authors) !== canonicalJson(parsedMetadata.authors)
        || source.publicationYear !== parsedMetadata.publicationYear
        || source.version.mimeType !== "chemical/x-cif" || source.version.license !== "CC0-1.0"
        || source.version.retrievalMethod !== "agentlas-scientific-data:rcsb-pdb@1.0.0"
        || verified.format !== "mmcif" || !verified.bytes.equals(structureBytes)
        || metadataReceipt.endpointOrigin !== "https://data.rcsb.org" || metadataReceipt.endpointPath !== metadataPath || metadataReceipt.endpointSearch !== ""
        || metadataReceipt.requestSha256 !== sha256(canonicalJson({ method: "GET", origin: "https://data.rcsb.org", path: metadataPath, search: "" }))
        || structureReceipt.endpointOrigin !== "https://files.rcsb.org" || structureReceipt.endpointPath !== structurePath || structureReceipt.endpointSearch !== ""
        || structureReceipt.requestSha256 !== sha256(canonicalJson({ method: "GET", origin: "https://files.rcsb.org", path: structurePath, search: "" }))) {
        throw new Error("science-data-run-source-binding-invalid");
      }
    } else {
      const property = pubchemProperty(jsonRecord(metadataBytes, "science-data-pubchem-property-invalid"));
      const expectedMetadata = { kind: "pubchem-compound", ...property };
      assertPubChemSdf(structureBytes);
      const verified = this.store.getVerifiedChemistrySourceVersionForTool(projectId, source.id, source.version.id);
      const encoded = encodeURIComponent(query.value);
      const propertyPath = `/rest/pug/compound/${query.namespace}/${encoded}/property/Title,ConnectivitySMILES,InChIKey/JSON`;
      const sdfPath = `/rest/pug/compound/cid/${property.cid}/record/SDF`;
      if (resultRecord.canonicalExternalId !== property.cid || resultRecord.entityKind !== "compound"
        || canonicalJson(resultRecord.metadata) !== canonicalJson(expectedMetadata)
        || source.canonicalUri !== `https://pubchem.ncbi.nlm.nih.gov/compound/${property.cid}` || source.publisher !== "PubChem"
        || source.title !== property.title || canonicalJson(source.authors) !== "[]" || source.publicationYear !== null
        || source.version.mimeType !== "chemical/x-mdl-sdfile" || source.version.license !== null
        || source.version.retrievalMethod !== "agentlas-scientific-data:pubchem@1.0.0;license=contributor-specific"
        || !verified.bytes.equals(structureBytes)
        || metadataReceipt.endpointOrigin !== "https://pubchem.ncbi.nlm.nih.gov" || metadataReceipt.endpointPath !== propertyPath || metadataReceipt.endpointSearch !== ""
        || metadataReceipt.requestSha256 !== sha256(canonicalJson({ method: "GET", origin: "https://pubchem.ncbi.nlm.nih.gov", path: propertyPath, search: "" }))
        || structureReceipt.endpointOrigin !== "https://pubchem.ncbi.nlm.nih.gov" || structureReceipt.endpointPath !== sdfPath || structureReceipt.endpointSearch !== "?record_type=3d"
        || structureReceipt.requestSha256 !== sha256(canonicalJson({ method: "GET", origin: "https://pubchem.ncbi.nlm.nih.gov", path: sdfPath, search: "?record_type=3d" }))) {
        throw new Error("science-data-run-source-binding-invalid");
      }
    }
    return resultRecord as unknown as ScientificDataRetrievalResult;
  }

  retrieve(input: RetrieveScientificDataInput): Promise<ScientificDataRetrievalResult> {
    const inputSha256 = sha256(canonicalJson(input));
    const prior = singleFlights.get(input.requestId);
    if (prior) return singleFlightInputSha256.get(input.requestId) === inputSha256
      ? prior
      : Promise.reject(new Error("science-data-request-replay-conflict"));
    const operation = this.retrieveOnce(input).finally(() => {
      singleFlights.delete(input.requestId);
      singleFlightInputSha256.delete(input.requestId);
    });
    singleFlights.set(input.requestId, operation);
    singleFlightInputSha256.set(input.requestId, inputSha256);
    return operation;
  }

  private async retrieveOnce(input: RetrieveScientificDataInput): Promise<ScientificDataRetrievalResult> {
    const query = normalizedQuery(input.query);
    const descriptor = DESCRIPTORS.find((item) => item.id === query.provider)!;
    const inputBytes = Buffer.from(canonicalJson({ schema: "agentlas.scientific-data-query/v1", query }), "utf8");
    const inputBlob = this.store.putRunBlob(inputBytes);
    const inputResource = { role: "scientific-data-query", mimeType: "application/vnd.agentlas.scientific-data-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: SCIENTIFIC_DATA_TOOL_ID, toolVersion: SCIENTIFIC_DATA_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])),
      environmentSha256: sha256(canonicalJson({ adapter: descriptor, policy: "scientific-data-fetch-policy-v1", runtime: process.version })),
      inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      return { ...this.storedResultForRun(input.projectId, run.id, query), replayed: true };
    }
    if (created.replayed && run.status !== "running") {
      throw new Error("science-data-run-terminal");
    }
    const receipts: ScientificDataHttpReceipt[] = [];
    try {
      let source: ScienceSource;
      let canonicalExternalId: string;
      let entityKind: ScientificDataRetrievalResult["entityKind"];
      let providerMetadata: ScientificDataRetrievalResult["metadata"];
      let metadataBytes: Buffer;
      let structureBytes: Buffer;
      if (query.provider === "rcsb-pdb") {
        const metadataUrl = new URL(`https://data.rcsb.org/rest/v1/core/entry/${query.entryId}`);
        const metadataFetch = await safeFetch("rcsb-pdb", metadataUrl, ["application/json"], MAX_METADATA_BYTES, this.fetchImpl);
        receipts.push(metadataFetch.receipt);
        metadataBytes = metadataFetch.bytes;
        const metadata = rcsbMetadata(jsonRecord(metadataFetch.bytes, "science-data-rcsb-metadata-invalid"), query.entryId);
        const structureUrl = new URL(`https://files.rcsb.org/download/${query.entryId}.cif`);
        const structureFetch = await safeFetch("rcsb-pdb", structureUrl, ["chemical/x-cif", "chemical/x-mmcif", "text/plain"], MAX_STRUCTURE_BYTES, this.fetchImpl);
        receipts.push(structureFetch.receipt);
        structureBytes = structureFetch.bytes;
        source = sourceForBytes(this.store, stableUuid(`${input.requestId}:source:${query.entryId}`), input.projectId, {
          canonicalUri: `pdb:${query.entryId}`, title: metadata.title, authors: metadata.authors,
          publicationYear: metadata.publicationYear, publisher: "RCSB Protein Data Bank", license: "CC0-1.0",
        }, structureFetch.bytes, "chemical/x-cif", `agentlas-scientific-data:rcsb-pdb@${descriptor.version}`, structureFetch.receipt.retrievedAt);
        canonicalExternalId = query.entryId;
        entityKind = "protein-structure";
        providerMetadata = { kind: "rcsb-entry", ...metadata };
      } else {
        const namespace = query.namespace === "inchikey" ? "inchikey" : query.namespace;
        const encoded = encodeURIComponent(query.value);
        const propertyUrl = new URL(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${namespace}/${encoded}/property/Title,ConnectivitySMILES,InChIKey/JSON`);
        const propertyFetch = await safeFetch("pubchem", propertyUrl, ["application/json"], MAX_METADATA_BYTES, this.fetchImpl);
        receipts.push(propertyFetch.receipt);
        metadataBytes = propertyFetch.bytes;
        const property = pubchemProperty(jsonRecord(propertyFetch.bytes, "science-data-pubchem-property-invalid"));
        const sdfUrl = new URL(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${property.cid}/record/SDF?record_type=3d`);
        const sdfFetch = await safeFetch("pubchem", sdfUrl, ["chemical/x-mdl-sdfile", "text/plain"], MAX_CHEMISTRY_BYTES, this.fetchImpl);
        receipts.push(sdfFetch.receipt);
        assertPubChemSdf(sdfFetch.bytes);
        structureBytes = sdfFetch.bytes;
        source = sourceForBytes(this.store, stableUuid(`${input.requestId}:source:${property.cid}`), input.projectId, {
          canonicalUri: `https://pubchem.ncbi.nlm.nih.gov/compound/${property.cid}`, title: property.title, authors: [],
          publicationYear: null, publisher: "PubChem", license: null,
        }, sdfFetch.bytes, "chemical/x-mdl-sdfile", `agentlas-scientific-data:pubchem@${descriptor.version};license=contributor-specific`, sdfFetch.receipt.retrievedAt);
        canonicalExternalId = property.cid;
        entityKind = "compound";
        providerMetadata = { kind: "pubchem-compound", ...property };
      }
      const result: ScientificDataRetrievalResult = {
        schema: "agentlas.scientific-data-retrieval/v1", provider: query.provider, providerVersion: descriptor.version,
        canonicalExternalId, entityKind, metadata: providerMetadata, source, receipts,
        materialization: descriptor.materializer && this.materializerAvailable(descriptor.materializer)
          ? { status: "ready", toolId: descriptor.materializer, retrievalRunId: run.id, sourceId: source.id, sourceVersionId: source.version.id, reason: null }
          : { status: "source-only", toolId: null, retrievalRunId: run.id, sourceId: source.id, sourceVersionId: source.version.id, reason: `The source-bound ${query.provider === "rcsb-pdb" ? "RCSB-to-Mol*" : "PubChem-to-Ketcher"} materializer is not installed.` },
        runId: run.id, replayed: false,
      };
      const metadataReceipt = receipts[0];
      const structureReceipt = receipts[1];
      if (!metadataReceipt?.mimeType || !structureReceipt?.mimeType) throw new Error("science-data-receipts-incomplete");
      const metadataBlob = this.store.putRunBlob(metadataBytes);
      const metadataResource = {
        role: "provider-metadata-response", mimeType: metadataReceipt.mimeType,
        ...metadataBlob, artifactId: null, artifactVersion: null,
      };
      const structureBlob = this.store.putRunBlob(structureBytes);
      const structureResource = {
        role: "provider-structure-response", mimeType: structureReceipt.mimeType,
        ...structureBlob, artifactId: null, artifactVersion: null,
      };
      const outputBytes = Buffer.from(canonicalJson(result), "utf8");
      const outputBlob = this.store.putRunBlob(outputBytes);
      const outputResource = { role: "scientific-data-retrieval", mimeType: "application/vnd.agentlas.scientific-data-retrieval+json", ...outputBlob, artifactId: null, artifactVersion: null };
      const outputs = [metadataResource, structureResource, outputResource];
      this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded",
        outputManifestSha256: sha256(canonicalJson(outputs)), summary: `Retrieved ${query.provider} ${canonicalExternalId} with exact provider responses and an immutable project Source.`, outputs,
      });
      return this.storedResultForRun(input.projectId, run.id, query);
    } catch (error) {
      const receipt = (error as { receipt?: ScientificDataHttpReceipt }).receipt;
      if (receipt) receipts.push(receipt);
      const failureBytes = Buffer.from(canonicalJson({ schema: "agentlas.scientific-data-failure/v1", provider: query.provider, receipts }), "utf8");
      const failureBlob = this.store.putRunBlob(failureBytes);
      const failureResource = { role: "scientific-data-receipts", mimeType: "application/vnd.agentlas.scientific-data-failure+json", ...failureBlob, artifactId: null, artifactVersion: null };
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({
        requestId: stableUuid(`${input.requestId}:failed`), projectId: input.projectId, runId: run.id, status: "failed",
        outputManifestSha256: sha256(canonicalJson([failureResource])), summary: error instanceof Error ? error.message.slice(0, 1_000) : "Scientific data retrieval failed.", outputs: [failureResource],
      });
      throw error;
    }
  }
}
