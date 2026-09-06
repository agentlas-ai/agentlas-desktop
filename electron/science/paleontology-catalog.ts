import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { ScienceSource } from "../../shared/science-contract";
import { ScienceStore } from "./store";
import { loadSciencePluginRuntime } from "./plugin-runtime";

export const PALEONTOLOGY_CATALOG_TOOL_ID = "agentlas.pbdb-taxon-occurrences";
export const PALEONTOLOGY_CATALOG_TOOL_VERSION = "1.0.0";
export const PBDB_ENDPOINT = "https://paleobiodb.org/data1.2";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_RECORDS = 300;
const DIRECT_MOLECULAR_CLASSES = new Set(["direct-dna", "genome-sequence", "reconstructed-genome"]);
const OBSERVED_EVIDENCE_CLASSES = new Set(["fossil-occurrence", "stratigraphic-occurrence-support"]);
type PaleontologyEngine = {
  PLUGIN_VERSION: string;
  buildTaxonUrl(input: { taxonName: string }): { input: { taxonName: string }; url: string };
  buildOccurrencesUrl(input: { taxonName: string; limit: number; offset: number }): { input: Record<string, unknown>; url: string };
};
function readEngine(): PaleontologyEngine {
  const loaded = loadSciencePluginRuntime<Partial<PaleontologyEngine>>(
    "agentlas-paleontology",
    "runtime/paleontology.cjs",
    2 * 1024 * 1024,
  ).runtime;
  if (loaded.PLUGIN_VERSION !== "0.2.0" || typeof loaded.buildTaxonUrl !== "function"
    || typeof loaded.buildOccurrencesUrl !== "function") {
    throw new Error("science-paleontology-runtime-invalid");
  }
  return loaded as PaleontologyEngine;
}

export interface PaleontologyCatalogInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  taxonName: string;
  pageSize?: number;
  maxPages?: number;
  maxRecords?: number;
  title?: string;
}

export interface PaleontologyOccurrence {
  occurrenceId: string;
  collectionId: string;
  identifiedName: string;
  acceptedName: string;
  acceptedTaxonId: string;
  classification: { phylum: string | null; class: string | null; order: string | null; family: string | null; genus: string | null };
  age: { maxMa: number; minMa: number; midpointMa: number; halfRangeMa: number; isPointEstimate: false };
  stratigraphy: { earlyInterval: string | null; lateInterval: string | null; group: string | null; formation: string | null; member: string | null };
  coordinates: { longitude: number; latitude: number; basis: string | null; precision: string | null } | null;
  countryCode: string | null;
  state: string | null;
  primaryReference: string | null;
  providerRecordSha256: string;
}

export interface PaleontologyCatalogResult {
  schema: "agentlas.paleontology-catalog-result/v1";
  provider: "pbdb-data1.2";
  title: string;
  taxon: {
    taxonId: string;
    acceptedTaxonId: string;
    name: string;
    acceptedName: string;
    rank: string | null;
    parentTaxonId: string | null;
    parentName: string | null;
    isExtant: boolean;
    occurrenceCount: number;
    firstAppearance: { maxMa: number | null; minMa: number | null };
    lastAppearance: { maxMa: number | null; minMa: number | null };
    classification: { phylum: string | null; class: string | null; order: string | null; family: string | null; genus: string | null };
    providerRecordSha256: string;
  };
  occurrences: PaleontologyOccurrence[];
  pagination: { pageSize: number; maxPages: number; maxRecords: number; pagesFetched: number; recordsAvailable: number; recordsReturned: number; truncated: boolean };
  receipt: { taxonResponseSha256: string; occurrencePages: Array<{ offset: number; responseSha256: string; rowCount: number }> };
  sources: Array<{ role: "taxon-response" | "occurrence-page"; pageIndex?: number; sourceId: string; sourceVersionId: string; responseSha256: string }>;
  warnings: string[];
  evidenceBoundary: {
    observed: "fossil-occurrence-and-taxonomic-metadata";
    molecularEvidence: "none";
    prohibitedInference: Array<"direct-dna" | "genome-sequence" | "reconstructed-genome">;
  };
  runId: string;
  replayed: boolean;
}

export interface PaleontologyClaimGateInput {
  projectId: string;
  claimText: string;
  requestedEvidenceClass: string;
  evidence: Array<{ evidenceClass: string; sourceId: string; sourceVersionId: string; occurrenceId?: string }>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function stableUuid(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function row(value: unknown, code = "science-paleontology-response-schema-invalid"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return value.trim();
}
function nullableText(value: unknown, maximum = 4_000): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(String(value), maximum, "science-paleontology-response-schema-invalid");
}
function nullableProviderProse(value: unknown, maximum = 4_000): string | null {
  if (value === undefined || value === null || value === "") return null;
  // PBDB bibliography prose can contain provider-authored line wrapping. The
  // exact response bytes remain immutable in Source/Run storage; normalize
  // display whitespace only, while text() continues to reject other controls.
  return text(String(value).replace(/[\u0009-\u000d\u0020]+/gu, " "), maximum, "science-paleontology-response-schema-invalid");
}
function number(value: unknown, code = "science-paleontology-response-schema-invalid"): number {
  const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(result)) throw new Error(code);
  return result;
}
function optionalNumber(value: unknown): number | null {
  return value === undefined || value === null || value === "" ? null : number(value);
}
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, code: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(code);
  return Number(value);
}

async function fetchPbdb(url: URL, fetchImpl: typeof fetch): Promise<{ bytes: Buffer; status: number; retrievedAt: string }> {
  if (url.origin !== "https://paleobiodb.org" || !url.pathname.startsWith("/data1.2/")) throw new Error("science-paleontology-endpoint-denied");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(url, { redirect: "error", signal: controller.signal, headers: { accept: "application/json", "user-agent": "Agentlas-Science/1.0 (paleontology research; https://agentlas.ai)" } });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("science-paleontology-response-size-invalid");
    if (!response.ok) throw new Error(`science-paleontology-http-${response.status}`);
    const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (mime !== "application/json" || !response.body || (response.url && response.url !== url.toString())) throw new Error("science-paleontology-response-invalid");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("science-paleontology-response-size-invalid"); }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.length < 2) throw new Error("science-paleontology-response-invalid");
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("science-paleontology-response-invalid"); }
    return { bytes, status: response.status, retrievedAt: new Date().toISOString() };
  } finally { clearTimeout(timeout); }
}

function parseJson(bytes: Buffer): Record<string, unknown> {
  try { return row(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { throw new Error("science-paleontology-response-schema-invalid"); }
}
function records(payload: Record<string, unknown>): unknown[] {
  if (!Array.isArray(payload.records)) throw new Error("science-paleontology-response-schema-invalid");
  return payload.records;
}
function classification(value: Record<string, unknown>): PaleontologyCatalogResult["taxon"]["classification"] {
  const order = nullableText(value.order, 240);
  return {
    phylum: nullableText(value.phylum, 240), class: nullableText(value.class, 240),
    order: order === "NO_ORDER_SPECIFIED" ? null : order,
    family: nullableText(value.family, 240), genus: nullableText(value.genus, 240),
  };
}
function parseTaxon(payload: Record<string, unknown>, requestedName: string): PaleontologyCatalogResult["taxon"] {
  const list = records(payload);
  if (list.length !== 1) throw new Error("science-paleontology-provider-taxon-stale");
  const value = row(list[0]);
  const acceptedName = text(value.accepted_name ?? value.taxon_name, 500, "science-paleontology-response-schema-invalid");
  const acceptedTaxonId = text(String(value.accepted_no ?? value.taxon_no ?? ""), 80, "science-paleontology-response-schema-invalid");
  const returnedName = text(value.taxon_name, 500, "science-paleontology-response-schema-invalid");
  if (returnedName.toLocaleLowerCase() !== requestedName.toLocaleLowerCase() && acceptedName.toLocaleLowerCase() !== requestedName.toLocaleLowerCase()) {
    throw new Error("science-paleontology-provider-taxon-stale");
  }
  return {
    taxonId: text(String(value.taxon_no ?? ""), 80, "science-paleontology-response-schema-invalid"), acceptedTaxonId,
    name: returnedName, acceptedName,
    rank: nullableText(value.accepted_rank ?? value.taxon_rank, 80),
    parentTaxonId: nullableText(value.parent_no, 80), parentName: nullableText(value.parent_name, 500),
    isExtant: nullableText(value.is_extant, 40) !== "extinct",
    occurrenceCount: Math.max(0, number(value.n_occs)),
    firstAppearance: { maxMa: optionalNumber(value.firstapp_max_ma), minMa: optionalNumber(value.firstapp_min_ma) },
    lastAppearance: { maxMa: optionalNumber(value.lastapp_max_ma), minMa: optionalNumber(value.lastapp_min_ma) },
    classification: classification(value), providerRecordSha256: sha256(canonicalJson(value)),
  };
}
function parseOccurrence(value: unknown, taxon: PaleontologyCatalogResult["taxon"]): PaleontologyOccurrence {
  const raw = row(value);
  const acceptedName = text(raw.accepted_name, 500, "science-paleontology-response-schema-invalid");
  const acceptedTaxonId = text(String(raw.accepted_no ?? ""), 80, "science-paleontology-response-schema-invalid");
  // PBDB base_name intentionally includes descendants and synonyms. Exact leaf
  // queries must remain identity-stable, while higher taxa preserve each row's
  // own accepted identity instead of falsely rejecting legitimate descendants.
  if (["species", "subspecies"].includes(taxon.rank ?? "")
    && (acceptedTaxonId !== taxon.acceptedTaxonId || acceptedName !== taxon.acceptedName)) {
    throw new Error("science-paleontology-provider-taxon-stale");
  }
  const maxMa = number(raw.max_ma);
  const minMa = number(raw.min_ma);
  if (maxMa < minMa || minMa < 0) throw new Error("science-paleontology-response-schema-invalid");
  const longitude = optionalNumber(raw.lng);
  const latitude = optionalNumber(raw.lat);
  if ((longitude === null) !== (latitude === null) || (longitude !== null && (longitude < -180 || longitude > 180 || latitude! < -90 || latitude! > 90))) throw new Error("science-paleontology-response-schema-invalid");
  return {
    occurrenceId: text(String(raw.occurrence_no ?? ""), 80, "science-paleontology-response-schema-invalid"),
    collectionId: text(String(raw.collection_no ?? ""), 80, "science-paleontology-response-schema-invalid"),
    identifiedName: text(raw.identified_name, 500, "science-paleontology-response-schema-invalid"),
    acceptedName,
    acceptedTaxonId,
    classification: classification(raw),
    age: { maxMa, minMa, midpointMa: Number(((maxMa + minMa) / 2).toFixed(12)), halfRangeMa: Number(((maxMa - minMa) / 2).toFixed(12)), isPointEstimate: false },
    stratigraphy: {
      earlyInterval: nullableText(raw.early_interval, 240), lateInterval: nullableText(raw.late_interval, 240),
      group: nullableText(raw.geological_group ?? raw.group, 240), formation: nullableText(raw.formation, 240), member: nullableText(raw.geological_member ?? raw.member, 240),
    },
    coordinates: longitude === null ? null : { longitude, latitude: latitude!, basis: nullableText(raw.latlng_basis, 240), precision: nullableText(raw.latlng_precision, 240) },
    countryCode: nullableText(raw.cc, 8), state: nullableText(raw.state, 240),
    primaryReference: nullableProviderProse(raw.primary_reference, 8_000),
    providerRecordSha256: sha256(canonicalJson(raw)),
  };
}

export function evaluateSciencePaleontologyClaimGate(input: PaleontologyClaimGateInput): {
  schema: "agentlas.science-paleontology-claim-gate/v1";
  allowed: true;
  effectiveEvidenceClass: string;
  restrictions: string[];
  evidence: PaleontologyClaimGateInput["evidence"];
} {
  text(input.projectId, 160, "science-paleontology-claim-project-invalid");
  text(input.claimText, 20_000, "science-paleontology-claim-text-invalid");
  const requested = text(input.requestedEvidenceClass, 120, "science-paleontology-evidence-class-invalid");
  if (DIRECT_MOLECULAR_CLASSES.has(requested) || !OBSERVED_EVIDENCE_CLASSES.has(requested)) throw new Error("science-paleontology-evidence-class-escalation");
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 500) throw new Error("science-paleontology-evidence-invalid");
  for (const evidence of input.evidence) {
    if (!OBSERVED_EVIDENCE_CLASSES.has(evidence.evidenceClass) || !evidence.sourceId || !evidence.sourceVersionId) throw new Error("science-paleontology-evidence-class-escalation");
  }
  return {
    schema: "agentlas.science-paleontology-claim-gate/v1",
    allowed: true,
    effectiveEvidenceClass: requested,
    restrictions: ["not-direct-dna", "not-genome-sequence", "not-reconstructed-genome"],
    evidence: input.evidence.map((entry) => ({ ...entry })),
  };
}

export class SciencePaleontologyCatalogService {
  constructor(private readonly store: ScienceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  private upsertSource(input: { requestId: string; projectId: string; url: string; title: string; bytes: Buffer; retrievedAt: string; role: string }): ScienceSource {
    const digest = sha256(input.bytes);
    const existing = this.store.getSourceByCanonicalUriForProject(input.projectId, input.url);
    if (!existing) return this.store.createSource({
      requestId: stableUuid(`${input.requestId}:source:${input.url}:${digest}`), projectId: input.projectId, kind: "database-record", canonicalUri: input.url,
      title: input.title, authors: ["Paleobiology Database"], publicationYear: null, publisher: "Paleobiology Database",
      containerTitle: "PBDB Data Service 1.2", abstract: `Exact PBDB ${input.role} response preserved without molecular inference.`, accessState: "retrieved",
      contentSha256: digest, mimeType: "application/json", retrievedAt: input.retrievedAt,
      retrievalMethod: `agentlas-paleontology:pbdb-data1.2@${PALEONTOLOGY_CATALOG_TOOL_VERSION}`, license: "CC0-1.0",
    }, input.bytes).source;
    if (existing.version.contentSha256 === digest && existing.version.mimeType === "application/json") return existing;
    return this.store.appendSourceVersion({
      requestId: stableUuid(`${input.requestId}:source-version:${input.url}:${digest}`), projectId: input.projectId, sourceId: existing.id,
      accessState: "retrieved", contentSha256: digest, mimeType: "application/json", retrievedAt: input.retrievedAt,
      retrievalMethod: `agentlas-paleontology:pbdb-data1.2@${PALEONTOLOGY_CATALOG_TOOL_VERSION}`, license: "CC0-1.0",
    }, input.bytes).source;
  }

  async search(input: PaleontologyCatalogInput): Promise<PaleontologyCatalogResult> {
    const engine = readEngine();
    const taxonName = text(input.taxonName, 500, "science-paleontology-taxon-invalid");
    const pageSize = boundedInteger(input.pageSize, DEFAULT_PAGE_SIZE, 1, 100, "science-paleontology-page-size-invalid");
    const maxPages = boundedInteger(input.maxPages, DEFAULT_MAX_PAGES, 1, 20, "science-paleontology-max-pages-invalid");
    const maxRecords = boundedInteger(input.maxRecords, DEFAULT_MAX_RECORDS, 1, 2_000, "science-paleontology-max-records-invalid");
    const title = input.title === undefined ? `PBDB fossil evidence · ${taxonName}` : text(input.title, 240, "science-paleontology-title-invalid");
    const query = { taxonName, pageSize, maxPages, maxRecords };
    const inputBlob = this.store.putRunBlob(Buffer.from(canonicalJson({ schema: "agentlas.paleontology-catalog-query/v1", provider: "pbdb-data1.2", query, title }), "utf8"));
    const inputResource = { role: "paleontology-query", mimeType: "application/vnd.agentlas.paleontology-catalog-query+json", ...inputBlob, artifactId: null, artifactVersion: null };
    const created = this.store.createResearchRun({
      requestId: input.requestId, projectId: input.projectId, conversationId: input.conversationId, originMessageId: input.originMessageId,
      toolId: PALEONTOLOGY_CATALOG_TOOL_ID, toolVersion: PALEONTOLOGY_CATALOG_TOOL_VERSION, runtime: "electron-main",
      inputManifestSha256: sha256(canonicalJson([inputResource])), environmentSha256: sha256(canonicalJson({ policy: "pbdb-data1.2-fossil-evidence-v1", endpoint: PBDB_ENDPOINT, runtime: process.version })), inputs: [inputResource],
    });
    const run = this.store.getResearchRunForProject(input.projectId, created.run.id) ?? created.run;
    if (created.replayed && run.status === "succeeded") {
      const output = run.outputs.find((resource) => resource.role === "paleontology-catalog" && resource.mimeType === "application/vnd.agentlas.paleontology-catalog-results+json");
      if (!output) throw new Error("science-paleontology-replay-output-missing");
      const stored = JSON.parse(this.store.readRunBlob(output).toString("utf8")) as PaleontologyCatalogResult;
      if (stored.schema !== "agentlas.paleontology-catalog-result/v1" || stored.runId !== run.id) throw new Error("science-paleontology-replay-output-invalid");
      for (const resource of run.outputs) this.store.readRunBlob(resource);
      for (const binding of stored.sources) {
        const verified = this.store.getVerifiedJsonDatabaseSourceVersionForTool(input.projectId, binding.sourceId, binding.sourceVersionId);
        if (verified.source.version.contentSha256 !== binding.responseSha256 || sha256(verified.bytes) !== binding.responseSha256) throw new Error("science-paleontology-source-run-closure-invalid");
      }
      return { ...stored, replayed: true };
    }
    if (created.replayed) throw new Error(`science-paleontology-run-terminal-${run.status}`);
    const rawOutputs: Array<{ role: string; mimeType: string; byteSize: number; sha256: string; blobRef: string; artifactId: null; artifactVersion: null }> = [];
    try {
      const exactTaxonUrl = new URL(engine.buildTaxonUrl({ taxonName }).url);
      const fetchedTaxon = await fetchPbdb(exactTaxonUrl, this.fetchImpl);
      const taxon = parseTaxon(parseJson(fetchedTaxon.bytes), taxonName);
      const taxonSource = this.upsertSource({ requestId: input.requestId, projectId: input.projectId, url: exactTaxonUrl.toString(), title: `PBDB taxon · ${taxon.acceptedName}`, bytes: fetchedTaxon.bytes, retrievedAt: fetchedTaxon.retrievedAt, role: "taxon" });
      const taxonDigest = sha256(fetchedTaxon.bytes);
      rawOutputs.push({ role: "provider-taxon-response", mimeType: "application/json", ...this.store.putRunBlob(fetchedTaxon.bytes), artifactId: null, artifactVersion: null });
      const sources: PaleontologyCatalogResult["sources"] = [{ role: "taxon-response", sourceId: taxonSource.id, sourceVersionId: taxonSource.version.id, responseSha256: taxonDigest }];
      const pageReceipts: PaleontologyCatalogResult["receipt"]["occurrencePages"] = [];
      const occurrences: PaleontologyOccurrence[] = [];
      let recordsAvailable = 0;
      let pagesFetched = 0;
      for (let pageIndex = 0; pageIndex < maxPages && occurrences.length < maxRecords; pageIndex += 1) {
        const offset = pageIndex * pageSize;
        const url = new URL(engine.buildOccurrencesUrl({ taxonName: taxon.acceptedName, limit: pageSize, offset }).url);
        const fetched = await fetchPbdb(url, this.fetchImpl);
        const payload = parseJson(fetched.bytes);
        const pageRows = records(payload);
        const dataInfo = payload.datainfo && typeof payload.datainfo === "object" ? payload.datainfo as Record<string, unknown> : null;
        const availableCandidate = dataInfo?.records_found ?? dataInfo?.total_records ?? payload.records_found ?? payload.total_records;
        if (availableCandidate !== undefined) recordsAvailable = Math.max(recordsAvailable, number(availableCandidate));
        else recordsAvailable = Math.max(recordsAvailable, offset + pageRows.length);
        const digest = sha256(fetched.bytes);
        const pageSource = this.upsertSource({ requestId: input.requestId, projectId: input.projectId, url: url.toString(), title: `PBDB occurrences · ${taxon.acceptedName} · ${offset + 1}–${offset + pageRows.length}`, bytes: fetched.bytes, retrievedAt: fetched.retrievedAt, role: "occurrence page" });
        sources.push({ role: "occurrence-page", pageIndex, sourceId: pageSource.id, sourceVersionId: pageSource.version.id, responseSha256: digest });
        pageReceipts.push({ offset, responseSha256: digest, rowCount: pageRows.length });
        rawOutputs.push({ role: "provider-occurrence-page", mimeType: "application/json", ...this.store.putRunBlob(fetched.bytes), artifactId: null, artifactVersion: null });
        pagesFetched += 1;
        for (const occurrence of pageRows) {
          if (occurrences.length >= maxRecords) break;
          occurrences.push(parseOccurrence(occurrence, taxon));
        }
        if (pageRows.length < pageSize) break;
      }
      if (new Set(occurrences.map((occurrence) => occurrence.occurrenceId)).size !== occurrences.length) throw new Error("science-paleontology-occurrence-duplicate");
      recordsAvailable = Math.max(recordsAvailable, occurrences.length);
      const truncated = occurrences.length < recordsAvailable || (pagesFetched === maxPages && pageReceipts.at(-1)?.rowCount === pageSize);
      const partial: PaleontologyCatalogResult = {
        schema: "agentlas.paleontology-catalog-result/v1", provider: "pbdb-data1.2", title, taxon, occurrences,
        pagination: { pageSize, maxPages, maxRecords, pagesFetched, recordsAvailable, recordsReturned: occurrences.length, truncated },
        receipt: { taxonResponseSha256: taxonDigest, occurrencePages: pageReceipts }, sources,
        warnings: [
          "PBDB records are fossil occurrence and taxonomic evidence; they do not contain recovered dinosaur DNA or a genome.",
          "Numerical ages are intervals in millions of years before present; midpoint and half-range are summaries, not point estimates.",
          ...(truncated ? [`Bounded retrieval returned ${occurrences.length} of at least ${recordsAvailable} records.`] : []),
        ],
        evidenceBoundary: { observed: "fossil-occurrence-and-taxonomic-metadata", molecularEvidence: "none", prohibitedInference: ["direct-dna", "genome-sequence", "reconstructed-genome"] },
        runId: run.id, replayed: false,
      };
      const resultResource = { role: "paleontology-catalog", mimeType: "application/vnd.agentlas.paleontology-catalog-results+json", ...this.store.putRunBlob(Buffer.from(canonicalJson(partial), "utf8")), artifactId: null, artifactVersion: null };
      const outputs = [...rawOutputs, resultResource];
      this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "succeeded", outputManifestSha256: sha256(canonicalJson(outputs)), summary: `${occurrences.length} exact PBDB fossil occurrence records retrieved for ${taxon.acceptedName}; molecular evidence remains none.`, outputs });
      return partial;
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 240) : "science-paleontology-catalog-failed";
      const failureResource = { role: "provider-receipt", mimeType: "application/vnd.agentlas.paleontology-catalog-failure+json", ...this.store.putRunBlob(Buffer.from(canonicalJson({ schema: "agentlas.paleontology-catalog-failure/v1", provider: "pbdb-data1.2", code }), "utf8")), artifactId: null, artifactVersion: null };
      const outputs = [...rawOutputs, failureResource];
      const current = this.store.getResearchRunForProject(input.projectId, run.id);
      if (current?.status === "running") this.store.completeResearchRun({ requestId: stableUuid(`${input.requestId}:complete`), projectId: input.projectId, runId: run.id, status: "failed", outputManifestSha256: sha256(canonicalJson(outputs)), summary: code, outputs });
      throw error;
    }
  }
}
