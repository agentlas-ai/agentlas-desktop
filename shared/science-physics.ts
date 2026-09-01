import { createHash } from "node:crypto";

export const SCIENCE_PHYSICS_ARTIFACT_SCHEMA = "agentlas.science.physics-data-artifact/v1" as const;
export const SCIENCE_PHYSICS_DATASET_SCHEMA = "agentlas.physics.user-dataset/v1" as const;
export const SCIENCE_PHYSICS_TABLE_SCHEMA = "agentlas.science-table/v1" as const;
export const SCIENCE_PHYSICS_TOOL_ID = "agentlas.physics-dataset" as const;
export const SCIENCE_PHYSICS_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_PHYSICS_LAB_ID = "physics-data" as const;
export const SCIENCE_PHYSICS_INSPIRE_SOURCE_TOOL_ID = "agentlas.physics-inspire-live-source" as const;
export const SCIENCE_PHYSICS_HEPDATA_SOURCE_TOOL_ID = "agentlas.physics-hepdata-live-table" as const;
export const SCIENCE_PHYSICS_LIVE_SOURCE_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_PHYSICS_LIVE_ARTIFACT_SCHEMA = "agentlas.science.physics-live-source-vega/v1" as const;
export const SCIENCE_PHYSICS_LIVE_EVIDENCE_SCHEMA = "agentlas.science.physics-live-source-evidence/v1" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_URI_RE = /^agentlas-dataset:sha256:[a-f0-9]{64}$/;
type JsonRecord = Record<string, unknown>;

export interface SciencePhysicsColumn {
  id: string;
  name: string;
  type: "number" | "string";
  unit: string | null;
}

export interface SciencePhysicsDatasetArtifactPayload {
  schema: typeof SCIENCE_PHYSICS_ARTIFACT_SCHEMA;
  inputSha256: string;
  normalized: {
    schema: typeof SCIENCE_PHYSICS_DATASET_SCHEMA;
    source: { provider: "user"; canonicalUri: string };
    table: {
      schema: typeof SCIENCE_PHYSICS_TABLE_SCHEMA;
      title: string;
      columns: SciencePhysicsColumn[];
      rows: Array<Array<string | number | null>>;
    };
    rowCount: number;
    columnCount: number;
    rendererCompatibility: { rendererIds: ["agentlas.vega"]; hostRequired: true; bundledRenderer: false; vtkSupported: false };
    normalizedBytes: number;
    normalizedSha256: string;
  };
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function exactKeys(value: JsonRecord, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  return Object.fromEntries(Object.keys(value as JsonRecord).sort().flatMap((key) => {
    const child = (value as JsonRecord)[key];
    return child === undefined ? [] : [[key, canonicalValue(child)]];
  }));
}

export function sciencePhysicsSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function safeText(value: unknown, maximum: number, code: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return allowEmpty ? value : value.trim();
}

export function validateSciencePhysicsDatasetArtifactPayload(value: unknown): SciencePhysicsDatasetArtifactPayload {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 5 * 1024 * 1024) throw new Error("science-physics-artifact-size-limit");
  const payload = record(value);
  if (!payload || !exactKeys(payload, ["schema", "inputSha256", "normalized"])
    || payload.schema !== SCIENCE_PHYSICS_ARTIFACT_SCHEMA || typeof payload.inputSha256 !== "string" || !SHA256_RE.test(payload.inputSha256)) {
    throw new Error("science-physics-artifact-invalid");
  }
  const normalized = record(payload.normalized);
  if (!normalized || !exactKeys(normalized, ["schema", "source", "table", "rowCount", "columnCount", "rendererCompatibility", "normalizedBytes", "normalizedSha256"])
    || normalized.schema !== SCIENCE_PHYSICS_DATASET_SCHEMA || typeof normalized.normalizedSha256 !== "string" || !SHA256_RE.test(normalized.normalizedSha256)
    || !Number.isSafeInteger(normalized.normalizedBytes) || Number(normalized.normalizedBytes) < 1 || Number(normalized.normalizedBytes) > 4 * 1024 * 1024) {
    throw new Error("science-physics-dataset-invalid");
  }
  const source = record(normalized.source);
  if (!source || !exactKeys(source, ["provider", "canonicalUri"]) || source.provider !== "user"
    || typeof source.canonicalUri !== "string" || !SOURCE_URI_RE.test(source.canonicalUri)) throw new Error("science-physics-source-invalid");
  const table = record(normalized.table);
  if (!table || !exactKeys(table, ["schema", "title", "columns", "rows"]) || table.schema !== SCIENCE_PHYSICS_TABLE_SCHEMA
    || !Array.isArray(table.columns) || table.columns.length < 1 || table.columns.length > 64 || !Array.isArray(table.rows) || table.rows.length > 10_000) {
    throw new Error("science-physics-table-invalid");
  }
  const columns = table.columns.map((entry, index) => {
    const column = record(entry);
    if (!column || !exactKeys(column, ["id", "name", "type", "unit"]) || column.id !== `c${index + 1}`
      || !["number", "string"].includes(String(column.type)) || (column.unit !== null && typeof column.unit !== "string")) throw new Error("science-physics-column-invalid");
    return {
      id: String(column.id),
      name: safeText(column.name, 160, "science-physics-column-invalid"),
      type: column.type as "number" | "string",
      unit: column.unit === null ? null : safeText(column.unit, 120, "science-physics-column-invalid"),
    };
  });
  if (new Set(columns.map((column) => column.name)).size !== columns.length) throw new Error("science-physics-column-duplicate");
  const rows = table.rows.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== columns.length) throw new Error("science-physics-row-width-invalid");
    return entry.map((cell, index) => {
      if (cell === null) return null;
      if (columns[index].type === "number") {
        if (typeof cell !== "number" || !Number.isFinite(cell)) throw new Error("science-physics-cell-invalid");
        return Object.is(cell, -0) ? 0 : cell;
      }
      return safeText(cell, 2_000, "science-physics-cell-invalid", true);
    });
  });
  if (normalized.rowCount !== rows.length || normalized.columnCount !== columns.length) throw new Error("science-physics-table-count-invalid");
  const compatibility = record(normalized.rendererCompatibility);
  if (!compatibility || !exactKeys(compatibility, ["rendererIds", "hostRequired", "bundledRenderer", "vtkSupported"])
    || JSON.stringify(compatibility.rendererIds) !== JSON.stringify(["agentlas.vega"])
    || compatibility.hostRequired !== true || compatibility.bundledRenderer !== false || compatibility.vtkSupported !== false) {
    throw new Error("science-physics-renderer-compatibility-invalid");
  }
  const normalizedCore = {
    schema: SCIENCE_PHYSICS_DATASET_SCHEMA,
    source: { provider: "user" as const, canonicalUri: String(source.canonicalUri) },
    table: { schema: SCIENCE_PHYSICS_TABLE_SCHEMA, title: safeText(table.title, 500, "science-physics-title-invalid"), columns, rows },
    rowCount: rows.length,
    columnCount: columns.length,
    rendererCompatibility: { rendererIds: ["agentlas.vega"] as ["agentlas.vega"], hostRequired: true as const, bundledRenderer: false as const, vtkSupported: false as const },
  };
  const expectedBytes = Buffer.byteLength(JSON.stringify(canonicalValue(normalizedCore.table)), "utf8");
  if (normalized.normalizedBytes !== expectedBytes || normalized.normalizedSha256 !== sciencePhysicsSha256(normalizedCore)
    || source.canonicalUri !== `agentlas-dataset:sha256:${sciencePhysicsSha256(normalizedCore.table)}`) throw new Error("science-physics-receipt-invalid");
  return {
    schema: SCIENCE_PHYSICS_ARTIFACT_SCHEMA,
    inputSha256: payload.inputSha256,
    normalized: { ...normalizedCore, normalizedBytes: expectedBytes, normalizedSha256: String(normalized.normalizedSha256) },
  };
}

export interface SciencePhysicsLiveTableColumn {
  id: string;
  label: string;
  type: "number" | "string";
  unit: string | null;
}

export interface SciencePhysicsLiveTable {
  schema: typeof SCIENCE_PHYSICS_TABLE_SCHEMA;
  columns: SciencePhysicsLiveTableColumn[];
  rows: Array<Array<string | number | null>>;
}

export interface SciencePhysicsLiveSourceEvidence {
  schema: typeof SCIENCE_PHYSICS_LIVE_EVIDENCE_SCHEMA;
  provider: "inspire-hep" | "hepdata";
  runId: string;
  inputSha256: string;
  normalizedSha256: string[];
  projectionSha256: string;
  renderSha256: string;
  projectionRowCount: number;
  missingValueCount: number;
  missingValuePolicy: "preserve-null";
  sources: Array<{
    sourceId: string;
    sourceVersionId: string;
    canonicalUri: string;
    responseSha256: string;
  }>;
  networkReceipts: Array<{
    schema: "agentlas.science.physics-network-receipt/v1";
    provider: "inspire-hep" | "hepdata";
    outputRole: "provider-response" | "record-response" | "table-response";
    requestUrl: string;
    requestSha256: string;
    responseSha256: string;
    responseBytes: number;
    responseStatus: number;
    responseContentType: "application/json";
    retrievedAt: string;
    attempts: number;
    policy: {
      timeoutMs: number;
      maxResponseBytes: number;
      minimumIntervalMs: number;
      retries: number;
      maxRetryAfterMs: number;
      retryableStatusCodes: [408, 429, 502, 503, 504];
      redirects: "deny";
    };
  }>;
  citations: Array<{
    kind: "record" | "journal-doi" | "dataset-doi" | "table-doi" | "table-download";
    doi: string | null;
    url: string;
  }>;
}

export interface SciencePhysicsLiveArtifactPayload {
  schema: typeof SCIENCE_PHYSICS_LIVE_ARTIFACT_SCHEMA;
  table: SciencePhysicsLiveTable;
  spec: Record<string, unknown>;
  evidence: SciencePhysicsLiveSourceEvidence;
}

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DOI_RE = /^10\.\d{4,9}\/\S+$/i;
const PHYSICS_RETRYABLE_STATUS_CODES = [408, 429, 502, 503, 504] as const;

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function physicsLiveUrl(value: unknown, provider: SciencePhysicsLiveSourceEvidence["provider"], code: string): string {
  const raw = safeText(value, 4_000, code);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(code); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(code);
  if (provider === "inspire-hep") {
    if (!((parsed.hostname === "inspirehep.net" && parsed.pathname.startsWith("/api/literature")) || parsed.hostname === "doi.org")) throw new Error(code);
  } else if (!["www.hepdata.net", "hepdata.net", "doi.org"].includes(parsed.hostname)) {
    throw new Error(code);
  }
  return parsed.toString();
}

export function validateSciencePhysicsLiveArtifactPayload(value: unknown): SciencePhysicsLiveArtifactPayload {
  let serialized = "";
  try { serialized = JSON.stringify(value); } catch { throw new Error("science-physics-live-artifact-invalid"); }
  if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) throw new Error("science-physics-live-artifact-size-limit");
  const payload = record(value);
  if (!payload || !exactKeys(payload, ["schema", "table", "spec", "evidence"]) || payload.schema !== SCIENCE_PHYSICS_LIVE_ARTIFACT_SCHEMA) {
    throw new Error("science-physics-live-artifact-invalid");
  }
  const table = record(payload.table);
  if (!table || !exactKeys(table, ["schema", "columns", "rows"]) || table.schema !== SCIENCE_PHYSICS_TABLE_SCHEMA
    || !Array.isArray(table.columns) || table.columns.length < 1 || table.columns.length > 64
    || !Array.isArray(table.rows) || table.rows.length > 50_000) throw new Error("science-physics-live-table-invalid");
  const columns = table.columns.map((entry) => {
    const column = record(entry);
    if (!column || !exactKeys(column, ["id", "label", "type", "unit"]) || !["number", "string"].includes(String(column.type))
      || (column.unit !== null && typeof column.unit !== "string")) throw new Error("science-physics-live-column-invalid");
    return {
      id: safeText(column.id, 120, "science-physics-live-column-invalid"),
      label: safeText(column.label, 300, "science-physics-live-column-invalid"),
      type: column.type as "number" | "string",
      unit: column.unit === null ? null : safeText(column.unit, 160, "science-physics-live-column-invalid"),
    };
  });
  if (new Set(columns.map((column) => column.id)).size !== columns.length) throw new Error("science-physics-live-column-duplicate");
  const rows = table.rows.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== columns.length) throw new Error("science-physics-live-row-invalid");
    return entry.map((cell, index) => {
      if (cell === null) return null;
      if (columns[index]!.type === "number") {
        if (typeof cell !== "number" || !Number.isFinite(cell)) throw new Error("science-physics-live-cell-invalid");
        return Object.is(cell, -0) ? 0 : cell;
      }
      return safeText(cell, 100_000, "science-physics-live-cell-invalid", true);
    });
  });
  const spec = record(payload.spec);
  if (!spec) throw new Error("science-physics-live-vega-invalid");
  const evidence = record(payload.evidence);
  if (!evidence || !exactKeys(evidence, ["schema", "provider", "runId", "inputSha256", "normalizedSha256", "projectionSha256", "renderSha256", "projectionRowCount", "missingValueCount", "missingValuePolicy", "sources", "networkReceipts", "citations"])
    || evidence.schema !== SCIENCE_PHYSICS_LIVE_EVIDENCE_SCHEMA || !["inspire-hep", "hepdata"].includes(String(evidence.provider))
    || typeof evidence.runId !== "string" || !UUID_RE.test(evidence.runId)
    || typeof evidence.inputSha256 !== "string" || !SHA256_RE.test(evidence.inputSha256)
    || typeof evidence.projectionSha256 !== "string" || !SHA256_RE.test(evidence.projectionSha256)
    || typeof evidence.renderSha256 !== "string" || !SHA256_RE.test(evidence.renderSha256)
    || !Array.isArray(evidence.normalizedSha256) || evidence.normalizedSha256.length < 1 || evidence.normalizedSha256.length > 4
    || evidence.normalizedSha256.some((item) => typeof item !== "string" || !SHA256_RE.test(item))
    || !Number.isSafeInteger(evidence.projectionRowCount) || evidence.projectionRowCount !== rows.length
    || !Number.isSafeInteger(evidence.missingValueCount) || Number(evidence.missingValueCount) < 0
    || evidence.missingValuePolicy !== "preserve-null" || !Array.isArray(evidence.sources)
    || !Array.isArray(evidence.networkReceipts) || !Array.isArray(evidence.citations)) {
    throw new Error("science-physics-live-evidence-invalid");
  }
  const provider = evidence.provider as SciencePhysicsLiveSourceEvidence["provider"];
  const sources = evidence.sources.map((entry) => {
    const source = record(entry);
    if (!source || !exactKeys(source, ["sourceId", "sourceVersionId", "canonicalUri", "responseSha256"])
      || !UUID_RE.test(String(source.sourceId)) || !UUID_RE.test(String(source.sourceVersionId))
      || typeof source.responseSha256 !== "string" || !SHA256_RE.test(source.responseSha256)) throw new Error("science-physics-live-source-invalid");
    return {
      sourceId: String(source.sourceId), sourceVersionId: String(source.sourceVersionId),
      canonicalUri: physicsLiveUrl(source.canonicalUri, provider, "science-physics-live-source-invalid"),
      responseSha256: String(source.responseSha256),
    };
  });
  if (sources.length !== (provider === "inspire-hep" ? 1 : 2)) throw new Error("science-physics-live-source-count-invalid");
  const expectedRoles: SciencePhysicsLiveSourceEvidence["networkReceipts"][number]["outputRole"][] = provider === "inspire-hep"
    ? ["provider-response"]
    : ["record-response", "table-response"];
  const expectedMinimumIntervalMs = provider === "inspire-hep" ? 350 : 1_000;
  const networkReceipts = evidence.networkReceipts.map((entry, index) => {
    const receipt = record(entry);
    const policy = receipt ? record(receipt.policy) : null;
    if (!receipt || !exactKeys(receipt, ["schema", "provider", "outputRole", "requestUrl", "requestSha256", "responseSha256", "responseBytes", "responseStatus", "responseContentType", "retrievedAt", "attempts", "policy"])
      || receipt.schema !== "agentlas.science.physics-network-receipt/v1" || receipt.provider !== provider
      || receipt.outputRole !== expectedRoles[index]
      || typeof receipt.requestSha256 !== "string" || !SHA256_RE.test(receipt.requestSha256)
      || typeof receipt.responseSha256 !== "string" || !SHA256_RE.test(receipt.responseSha256)
      || !Number.isSafeInteger(receipt.responseBytes) || Number(receipt.responseBytes) < 2 || Number(receipt.responseBytes) > 16 * 1024 * 1024
      || !Number.isSafeInteger(receipt.responseStatus) || Number(receipt.responseStatus) < 200 || Number(receipt.responseStatus) > 299
      || receipt.responseContentType !== "application/json"
      || !exactIsoTimestamp(receipt.retrievedAt)
      || !Number.isSafeInteger(receipt.attempts) || Number(receipt.attempts) < 1 || Number(receipt.attempts) > 3
      || !policy || !exactKeys(policy, ["timeoutMs", "maxResponseBytes", "minimumIntervalMs", "retries", "maxRetryAfterMs", "retryableStatusCodes", "redirects"])
      || policy.timeoutMs !== 20_000 || policy.maxResponseBytes !== 16 * 1024 * 1024
      || policy.minimumIntervalMs !== expectedMinimumIntervalMs || policy.retries !== 2 || policy.maxRetryAfterMs !== 30_000
      || JSON.stringify(policy.retryableStatusCodes) !== JSON.stringify(PHYSICS_RETRYABLE_STATUS_CODES) || policy.redirects !== "deny") {
      throw new Error("science-physics-live-network-receipt-invalid");
    }
    const requestUrl = physicsLiveUrl(receipt.requestUrl, provider, "science-physics-live-network-receipt-invalid");
    const source = sources[index];
    if (!source || requestUrl !== source.canonicalUri || receipt.responseSha256 !== source.responseSha256
      || receipt.requestSha256 !== sciencePhysicsSha256({ method: "GET", url: requestUrl, accept: "application/json" })) {
      throw new Error("science-physics-live-network-lineage-invalid");
    }
    return {
      schema: "agentlas.science.physics-network-receipt/v1" as const,
      provider,
      outputRole: receipt.outputRole as SciencePhysicsLiveSourceEvidence["networkReceipts"][number]["outputRole"],
      requestUrl,
      requestSha256: String(receipt.requestSha256),
      responseSha256: String(receipt.responseSha256),
      responseBytes: Number(receipt.responseBytes),
      responseStatus: Number(receipt.responseStatus),
      responseContentType: "application/json" as const,
      retrievedAt: String(receipt.retrievedAt),
      attempts: Number(receipt.attempts),
      policy: {
        timeoutMs: 20_000,
        maxResponseBytes: 16 * 1024 * 1024,
        minimumIntervalMs: expectedMinimumIntervalMs,
        retries: 2,
        maxRetryAfterMs: 30_000,
        retryableStatusCodes: [...PHYSICS_RETRYABLE_STATUS_CODES] as [408, 429, 502, 503, 504],
        redirects: "deny" as const,
      },
    };
  });
  if (networkReceipts.length !== expectedRoles.length) throw new Error("science-physics-live-network-receipt-count-invalid");
  const citations = evidence.citations.map((entry) => {
    const citation = record(entry);
    if (!citation || !exactKeys(citation, ["kind", "doi", "url"]) || !["record", "journal-doi", "dataset-doi", "table-doi", "table-download"].includes(String(citation.kind))) {
      throw new Error("science-physics-live-citation-invalid");
    }
    const doi = citation.doi === null ? null : safeText(citation.doi, 300, "science-physics-live-citation-invalid");
    if ((citation.kind === "journal-doi" || citation.kind === "dataset-doi" || citation.kind === "table-doi") && (!doi || !DOI_RE.test(doi))) {
      throw new Error("science-physics-live-citation-invalid");
    }
    return {
      kind: citation.kind as SciencePhysicsLiveSourceEvidence["citations"][number]["kind"],
      doi,
      url: physicsLiveUrl(citation.url, provider, "science-physics-live-citation-invalid"),
    };
  });
  if (citations.length < 1 || citations.length > 500) throw new Error("science-physics-live-citation-invalid");
  const missingValueCount = rows.reduce((count, row) => count + row.filter((cell) => cell === null).length, 0);
  const normalizedTable: SciencePhysicsLiveTable = { schema: SCIENCE_PHYSICS_TABLE_SCHEMA, columns, rows };
  if (evidence.projectionSha256 !== sciencePhysicsSha256(normalizedTable) || evidence.missingValueCount !== missingValueCount) {
    throw new Error("science-physics-live-projection-receipt-invalid");
  }
  if (evidence.renderSha256 !== sciencePhysicsSha256(spec)) throw new Error("science-physics-live-render-receipt-invalid");
  return {
    schema: SCIENCE_PHYSICS_LIVE_ARTIFACT_SCHEMA,
    table: normalizedTable,
    spec,
    evidence: {
      schema: SCIENCE_PHYSICS_LIVE_EVIDENCE_SCHEMA,
      provider,
      runId: String(evidence.runId),
      inputSha256: String(evidence.inputSha256),
      normalizedSha256: evidence.normalizedSha256 as string[],
      projectionSha256: String(evidence.projectionSha256),
      renderSha256: String(evidence.renderSha256),
      projectionRowCount: rows.length,
      missingValueCount,
      missingValuePolicy: "preserve-null",
      sources,
      networkReceipts,
      citations,
    },
  };
}
