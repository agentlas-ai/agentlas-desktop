"use strict";

const { createHash } = require("node:crypto");

const INSPIRE_ENDPOINT = "https://inspirehep.net/api/literature";
const HEPDATA_RECORD_ENDPOINT = "https://www.hepdata.net/record";
const HEPDATA_TABLE_ENDPOINT = "https://www.hepdata.net/download/table";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DATASET_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 64;
const MAX_HEPDATA_ERRORS_PER_POINT = 128;
const MAX_HEPDATA_QUALIFIERS = 128;
const MAX_ANALYSIS_LABELS = 32;
const INSPIRE_SORTS = new Set(["relevance", "mostrecent", "mostcited"]);
const RETRYABLE_STATUS_CODES = Object.freeze([408, 429, 502, 503, 504]);
const DEFAULT_NETWORK_POLICY = Object.freeze({
  timeoutMs: 20_000,
  retries: 2,
  retryDelayMs: 500,
  maxRetryAfterMs: 30_000,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  inspireIntervalMs: 350,
  hepdataIntervalMs: 1_000,
  userAgent: "Agentlas-Physics/0.2.0 (INSPIRE and HEPData research; https://agentlas.ai)",
});

class PhysicsError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "PhysicsError";
    this.code = code;
    this.details = details;
  }
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PhysicsError("physics-non-finite-number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new PhysicsError("physics-json-value-invalid");
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new PhysicsError("physics-json-undefined");
    output[key] = canonicalValue(value[key]);
  }
  return output;
}

function stableStringify(value) { return JSON.stringify(canonicalValue(value)); }
function sha256(value) { return createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8")).digest("hex"); }

function exactObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new PhysicsError(`${label}-invalid`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new PhysicsError(`${label}-unknown-field`, `${label}: unknown field ${extras[0]}`);
  return value;
}

function text(value, min, max, label) {
  if (typeof value !== "string") throw new PhysicsError(`${label}-invalid`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new PhysicsError(`${label}-invalid`);
  return normalized;
}

function optionalText(value, max, label) {
  if (value === undefined || value === null || value === "") return null;
  return text(String(value), 1, max, label);
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new PhysicsError(`${label}-invalid`);
  return value;
}

function finite(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new PhysicsError(`${label}-invalid`);
  return Object.is(value, -0) ? 0 : value;
}

function safeHttpsUrl(value, allowedHosts, label) {
  const raw = optionalText(value, 4_096, label);
  if (raw === null) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new PhysicsError(`${label}-invalid`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !allowedHosts.has(parsed.hostname)) throw new PhysicsError(`${label}-invalid`);
  return parsed.toString();
}

function safeInspireSearchUrl(value, label) {
  const normalized = safeHttpsUrl(value, new Set(["inspirehep.net"]), label);
  if (normalized === null) return null;
  const parsed = new URL(normalized);
  if ((parsed.pathname !== "/api/literature" && parsed.pathname !== "/api/literature/") || parsed.hash) throw new PhysicsError(`${label}-invalid`);
  return normalized;
}

function normalizeInspireInput(input) {
  const value = exactObject(input, ["query", "limit", "page", "sort"], "physics-inspire-input");
  const query = text(value.query, 2, 500, "physics-inspire-query");
  const limit = value.limit === undefined ? 25 : integer(value.limit, 1, 100, "physics-inspire-limit");
  const page = value.page === undefined ? 1 : integer(value.page, 1, 100, "physics-inspire-page");
  const sort = value.sort === undefined ? "relevance" : text(value.sort, 1, 32, "physics-inspire-sort");
  if (!INSPIRE_SORTS.has(sort)) throw new PhysicsError("physics-inspire-sort-invalid");
  return { query, limit, page, sort };
}

function buildInspireUrl(input) {
  const normalized = normalizeInspireInput(input);
  const params = new URLSearchParams();
  params.set("fields", "titles,authors.full_name,abstracts,dois,arxiv_eprints,publication_info,citation_count,earliest_date,document_type");
  params.set("page", String(normalized.page));
  params.set("q", normalized.query);
  params.set("size", String(normalized.limit));
  if (normalized.sort !== "relevance") params.set("sort", normalized.sort);
  return { input: normalized, url: `${INSPIRE_ENDPOINT}?${params.toString()}` };
}

function firstArrayObject(value) {
  return Array.isArray(value) && value[0] && typeof value[0] === "object" ? value[0] : null;
}

function uniqueStrings(values, maxItems, maxLength, label) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = optionalText(value, maxLength, label);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

function normalizeInspireResponse(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.hits || !Array.isArray(raw.hits.hits)) throw new PhysicsError("inspire-response-invalid");
  if (raw.hits.hits.length > 100) throw new PhysicsError("inspire-result-count-limit");
  const papers = raw.hits.hits.map((hit, index) => {
    if (!hit || typeof hit !== "object" || Array.isArray(hit)) throw new PhysicsError("inspire-hit-invalid");
    const metadata = hit.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new PhysicsError("inspire-metadata-invalid");
    const id = text(String(hit.id ?? metadata.control_number ?? ""), 1, 40, "inspire-record-id");
    const titleEntry = firstArrayObject(metadata.titles);
    const title = text(String(titleEntry?.title ?? ""), 1, 2_000, "inspire-title");
    const allAuthors = (Array.isArray(metadata.authors) ? metadata.authors : []).map((author) => author?.full_name).filter((name) => typeof name === "string");
    const authors = uniqueStrings(allAuthors, 200, 300, "inspire-author");
    const abstracts = Array.isArray(metadata.abstracts) ? metadata.abstracts : [];
    const preferredAbstract = abstracts.find((entry) => entry?.source === "arXiv" && typeof entry.value === "string") ?? abstracts.find((entry) => typeof entry?.value === "string");
    const abstract = preferredAbstract ? text(String(preferredAbstract.value), 1, 20_000, "inspire-abstract") : null;
    const doiValues = (Array.isArray(metadata.dois) ? metadata.dois : []).map((entry) => entry?.value).filter((value) => typeof value === "string");
    const arxivValues = (Array.isArray(metadata.arxiv_eprints) ? metadata.arxiv_eprints : []).map((entry) => entry?.value).filter((value) => typeof value === "string");
    const publication = firstArrayObject(metadata.publication_info);
    const journal = publication ? {
      title: optionalText(publication.journal_title, 500, "inspire-journal-title"),
      volume: optionalText(publication.journal_volume, 100, "inspire-journal-volume"),
      articleId: optionalText(publication.artid ?? publication.page_start, 200, "inspire-article-id"),
      year: publication.year === undefined || publication.year === null ? null : integer(publication.year, 1600, 3000, "inspire-year"),
    } : null;
    const recordUrl = safeHttpsUrl(hit.links?.self ?? `https://inspirehep.net/api/literature/${id}`, new Set(["inspirehep.net"]), "inspire-record-url");
    return {
      rank: index + 1,
      id,
      title,
      authors,
      authorCount: allAuthors.length,
      abstract,
      dois: uniqueStrings(doiValues, 20, 300, "inspire-doi"),
      arxivIds: uniqueStrings(arxivValues, 20, 100, "inspire-arxiv"),
      earliestDate: optionalText(metadata.earliest_date, 80, "inspire-earliest-date"),
      citationCount: metadata.citation_count === undefined || metadata.citation_count === null ? null : integer(metadata.citation_count, 0, 2_147_483_647, "inspire-citation-count"),
      documentTypes: uniqueStrings(metadata.document_type, 30, 120, "inspire-document-type"),
      journal,
      recordUrl,
    };
  });
  if (new Set(papers.map((paper) => paper.id)).size !== papers.length) throw new PhysicsError("inspire-record-id-duplicate");
  const totalInput = raw.hits.total;
  const totalValue = Number.isInteger(totalInput)
    ? totalInput
    : totalInput && typeof totalInput === "object" && !Array.isArray(totalInput) && Number.isInteger(totalInput.value)
      ? totalInput.value
      : null;
  const totalRelation = Number.isInteger(totalInput) ? "eq" : totalInput?.relation === "gte" ? "gte" : totalInput?.relation === undefined || totalInput?.relation === "eq" ? "eq" : null;
  if (totalValue === null || totalRelation === null || totalValue < 0 || totalValue > Number.MAX_SAFE_INTEGER || totalValue < papers.length) throw new PhysicsError("inspire-total-invalid");
  if (raw.links !== undefined && (!raw.links || typeof raw.links !== "object" || Array.isArray(raw.links))) throw new PhysicsError("inspire-links-invalid");
  const selfUrl = safeInspireSearchUrl(raw.links?.self, "inspire-self-url");
  const nextUrl = safeInspireSearchUrl(raw.links?.next, "inspire-next-url");
  const normalized = {
    schema: "agentlas.physics.inspire-literature/v1",
    source: { provider: "INSPIRE", canonicalUri: "inspire:literature" },
    resultCount: papers.length,
    totalResults: totalValue,
    pagination: { returned: papers.length, totalRelation, hasNext: nextUrl !== null, selfUrl, nextUrl },
    papers,
    warnings: papers.some((paper) => paper.authorCount > paper.authors.length) ? ["At least one author list was capped at 200 names in the normalized projection; the raw-response hash preserves lineage."] : [],
  };
  return { ...normalized, normalizedSha256: sha256(stableStringify(normalized)) };
}

function normalizeHepDataRecordInput(input) {
  const value = exactObject(input, ["recordId", "version", "includeTables"], "physics-hepdata-record-input");
  const recordId = text(value.recordId, 4, 24, "physics-hepdata-record-id");
  if (!/^ins\d{1,16}$/.test(recordId)) throw new PhysicsError("physics-hepdata-record-id-invalid");
  const version = value.version === undefined ? null : integer(value.version, 1, 999, "physics-hepdata-version");
  const includeTables = value.includeTables === true;
  if (value.includeTables !== undefined && typeof value.includeTables !== "boolean") throw new PhysicsError("physics-hepdata-include-tables-invalid");
  return { recordId, version, includeTables };
}

function buildHepDataRecordUrl(input) {
  const normalized = normalizeHepDataRecordInput(input);
  const params = new URLSearchParams();
  params.set("format", "json");
  if (!normalized.includeTables) params.set("light", "true");
  if (normalized.version !== null) params.set("version", String(normalized.version));
  return { input: normalized, url: `${HEPDATA_RECORD_ENDPOINT}/${normalized.recordId}?${params.toString()}` };
}

function normalizeHepDataTableFetchInput(input) {
  const value = exactObject(input, ["recordId", "tableName", "version"], "physics-hepdata-table-fetch-input");
  const recordId = text(value.recordId, 4, 24, "physics-hepdata-record-id");
  if (!/^ins\d{1,16}$/.test(recordId)) throw new PhysicsError("physics-hepdata-record-id-invalid");
  const tableName = text(value.tableName, 1, 500, "physics-hepdata-table-name");
  const version = value.version === undefined || value.version === null ? null : integer(value.version, 1, 999, "physics-hepdata-version");
  return { recordId, tableName, version };
}

function buildHepDataTableUrl(input) {
  const normalized = normalizeHepDataTableFetchInput(input);
  const versionSegment = normalized.version === null ? "" : `/${normalized.version}`;
  return {
    input: normalized,
    url: `${HEPDATA_TABLE_ENDPOINT}/${normalized.recordId}/${encodeURIComponent(normalized.tableName)}${versionSegment}/json`,
  };
}

function normalizeHepDataRecord(raw, requestedRecordId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.record || typeof raw.record !== "object") throw new PhysicsError("hepdata-record-response-invalid");
  const record = raw.record;
  const recordId = text(String(record.inspire_id ? `ins${record.inspire_id}` : requestedRecordId), 4, 24, "hepdata-record-id");
  if (recordId !== requestedRecordId) throw new PhysicsError("hepdata-record-id-mismatch");
  const tablesInput = raw.data_tables === undefined || raw.data_tables === null ? [] : raw.data_tables;
  if (!Array.isArray(tablesInput) || tablesInput.length > 500) throw new PhysicsError("hepdata-table-list-invalid");
  const allowedHosts = new Set(["www.hepdata.net", "hepdata.net"]);
  const tables = tablesInput.map((table, index) => {
    if (!table || typeof table !== "object" || Array.isArray(table)) throw new PhysicsError("hepdata-table-metadata-invalid");
    const formats = {};
    if (table.data && typeof table.data === "object" && !Array.isArray(table.data)) {
      for (const format of ["json", "yaml", "csv", "root", "yoda", "yoda1", "yoda.h5"]) {
        if (table.data[format]) formats[format] = safeHttpsUrl(table.data[format], allowedHosts, "hepdata-table-url");
      }
    }
    return {
      ordinal: index + 1,
      id: optionalText(table.id, 120, "hepdata-table-id"),
      name: text(String(table.name ?? ""), 1, 500, "hepdata-table-name"),
      description: optionalText(table.description, 4_000, "hepdata-table-description"),
      location: optionalText(table.location, 1_000, "hepdata-table-location"),
      doi: optionalText(table.doi, 300, "hepdata-table-doi"),
      formats,
    };
  });
  const firstAuthor = typeof record.first_author === "string"
    ? optionalText(record.first_author, 500, "hepdata-first-author")
    : record.first_author && typeof record.first_author === "object" && !Array.isArray(record.first_author)
      ? optionalText(record.first_author.full_name, 500, "hepdata-first-author")
      : null;
  const normalized = {
    schema: "agentlas.physics.hepdata-record/v1",
    source: { provider: "HEPData", canonicalUri: `hepdata:record/${recordId}` },
    recordId,
    version: raw.version === undefined || raw.version === null ? optionalText(record.version, 40, "hepdata-version") : String(raw.version),
    title: text(String(record.title ?? ""), 1, 2_000, "hepdata-title"),
    abstract: optionalText(record.abstract ?? record.data_abstract, 20_000, "hepdata-abstract"),
    collaboration: Array.isArray(record.collaborations) ? uniqueStrings(record.collaborations, 50, 300, "hepdata-collaboration") : [],
    firstAuthor,
    year: record.year === undefined || record.year === null ? null : integer(Number(record.year), 1600, 3000, "hepdata-year"),
    doi: optionalText(record.doi, 300, "hepdata-doi"),
    hepdataDoi: optionalText(record.hepdata_doi, 300, "hepdata-doi"),
    arxivId: optionalText(record.arxiv_id, 100, "hepdata-arxiv"),
    journalInfo: optionalText(record.journal_info, 1_000, "hepdata-journal-info"),
    tableCount: tables.length,
    tables,
    publicUrl: `https://www.hepdata.net/record/${recordId}`,
  };
  return { ...normalized, normalizedSha256: sha256(stableStringify(normalized)) };
}

function normalizeScalar(value, label) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value, -Number.MAX_VALUE, Number.MAX_VALUE, label);
  if (typeof value === "string") return text(value, 1, 2_000, label);
  throw new PhysicsError(`${label}-invalid`);
}

function normalizeHepDataScalar(value, label, allowEmpty = false) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value, -Number.MAX_VALUE, Number.MAX_VALUE, label);
  if (typeof value === "string") return text(value, allowEmpty ? 0 : 1, 2_000, label);
  throw new PhysicsError(`${label}-invalid`);
}

const NUMBER_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const PERCENT_TOKEN = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)%$/;

function numericMeasurement(value) {
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!NUMBER_TOKEN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? (Object.is(parsed, -0) ? 0 : parsed) : null;
}

function errorDelta(value, center) {
  if (value === null || value === "") return { delta: null, relative: false };
  const direct = numericMeasurement(value);
  if (direct !== null) return { delta: direct, relative: false };
  if (typeof value !== "string") return { delta: null, relative: false };
  const match = PERCENT_TOKEN.exec(value.trim());
  if (!match || center === null) return { delta: null, relative: Boolean(match) };
  const percent = Number(match[1]);
  const delta = Math.abs(center) * percent / 100;
  return { delta: Number.isFinite(delta) ? delta : null, relative: true };
}

function rendererError(error, center) {
  const plus = errorDelta(error.plus, center);
  const minus = error.kind === "symmetric"
    ? { delta: plus.delta === null ? null : -plus.delta, relative: plus.relative }
    : errorDelta(error.minus, center);
  const plusCandidate = center === null || plus.delta === null ? null : center + plus.delta;
  const minusCandidate = center === null || minus.delta === null ? null : center + minus.delta;
  const plusEndpoint = plusCandidate !== null && Number.isFinite(plusCandidate) ? plusCandidate : null;
  const minusEndpoint = minusCandidate !== null && Number.isFinite(minusCandidate) ? minusCandidate : null;
  const endpoints = [center, plusEndpoint, minusEndpoint].filter((entry) => typeof entry === "number" && Number.isFinite(entry));
  return {
    label: error.label,
    sourceKind: error.kind,
    plusRaw: error.plus,
    minusRaw: error.minus,
    plusDelta: plus.delta,
    minusDelta: minus.delta,
    plusEndpoint,
    minusEndpoint,
    errorBarLow: endpoints.length >= 2 ? Math.min(...endpoints) : null,
    errorBarHigh: endpoints.length >= 2 ? Math.max(...endpoints) : null,
    relative: plus.relative || minus.relative,
    renderable: center !== null && (plus.delta !== null || minus.delta !== null),
  };
}

function buildHepDataRendererProjection(independentVariables, dependentVariables, pointCount) {
  const series = dependentVariables.map((variable, dependentIndex) => ({
    seriesId: `dependent-${dependentIndex + 1}`,
    dependentIndex,
    name: variable.header.name,
    units: variable.header.units,
    qualifiers: variable.qualifiers,
    points: variable.values.map((entry, pointIndex) => {
      const numericValue = numericMeasurement(entry.value);
      const independent = independentVariables.map((independentVariable, independentIndex) => {
        const raw = independentVariable.values[pointIndex];
        const numericValue = numericMeasurement(raw.value);
        const numericLow = numericMeasurement(raw.low);
        const numericHigh = numericMeasurement(raw.high);
        const midpointCandidate = numericLow !== null && numericHigh !== null ? (numericLow + numericHigh) / 2 : null;
        const midpoint = midpointCandidate !== null && Number.isFinite(midpointCandidate) ? midpointCandidate : null;
        return {
          independentIndex,
          name: independentVariable.header.name,
          units: independentVariable.header.units,
          value: raw.value,
          low: raw.low,
          high: raw.high,
          numericValue,
          numericLow,
          numericHigh,
          numericCenter: numericValue ?? midpoint,
        };
      });
      const errors = entry.errors.map((error) => rendererError(error, numericValue));
      return {
        ordinal: pointIndex + 1,
        independent,
        value: entry.value,
        numericValue,
        errors,
        renderable: numericValue !== null && (independent.length === 0 || independent.every((axis) => axis.numericCenter !== null)),
      };
    }),
  }));
  const recommendedMark = independentVariables.length === 0 ? "point" : independentVariables.length === 1 ? "point-errorbar" : independentVariables.length === 2 ? "heatmap" : "table";
  return {
    schema: "agentlas.physics.hepdata-renderer-series/v1",
    pointCount,
    independentDimensionCount: independentVariables.length,
    dependentSeriesCount: dependentVariables.length,
    recommendedMark,
    uncertaintyPolicy: "Each labeled uncertainty is projected separately. The optional chi-square analysis combines only labels the caller explicitly declares mutually independent; covariance is never inferred.",
    series,
  };
}

function normalizeHeader(header, fallback, label) {
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new PhysicsError(`${label}-invalid`);
  return { name: optionalText(header.name, 300, `${label}-name`) ?? fallback, units: optionalText(header.units, 160, `${label}-units`) };
}

function normalizeHepDataTable(input) {
  const value = exactObject(input, ["recordId", "tableName", "version", "table"], "physics-hepdata-table-input");
  const recordId = text(value.recordId, 4, 24, "physics-hepdata-record-id");
  if (!/^ins\d{1,16}$/.test(recordId)) throw new PhysicsError("physics-hepdata-record-id-invalid");
  const tableName = text(value.tableName, 1, 500, "physics-hepdata-table-name");
  const version = value.version === undefined || value.version === null ? null : integer(value.version, 1, 999, "physics-hepdata-version");
  const table = value.table;
  if (!table || typeof table !== "object" || Array.isArray(table)) throw new PhysicsError("hepdata-table-invalid");
  const independent = table.independent_variables;
  const dependent = table.dependent_variables;
  if (!Array.isArray(independent) || independent.length > 8 || !Array.isArray(dependent) || dependent.length > 64 || (dependent.length === 0 && independent.length > 0)) {
    throw new PhysicsError("hepdata-table-variables-invalid");
  }
  const pointCount = dependent.length === 0 ? 0 : dependent[0]?.values?.length;
  if (!Number.isInteger(pointCount) || pointCount < 0 || pointCount > MAX_ROWS) throw new PhysicsError("hepdata-table-point-count-invalid");
  const independentVariables = independent.map((variable, variableIndex) => {
    if (!variable || typeof variable !== "object" || !Array.isArray(variable.values) || variable.values.length !== pointCount) throw new PhysicsError("hepdata-independent-variable-invalid");
    return {
      header: normalizeHeader(variable.header, `independent_${variableIndex + 1}`, "hepdata-independent-header"),
      values: variable.values.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new PhysicsError("hepdata-independent-value-invalid");
        const hasValue = entry.value !== undefined && entry.value !== null;
        const hasLow = entry.low !== undefined && entry.low !== null;
        const hasHigh = entry.high !== undefined && entry.high !== null;
        if (!hasValue && !(hasLow && hasHigh) || hasLow !== hasHigh) throw new PhysicsError("hepdata-independent-bin-invalid");
        return {
          value: hasValue ? normalizeHepDataScalar(entry.value, "hepdata-independent-value", true) : null,
          low: hasLow ? normalizeHepDataScalar(entry.low, "hepdata-independent-low", true) : null,
          high: hasHigh ? normalizeHepDataScalar(entry.high, "hepdata-independent-high", true) : null,
        };
      }),
    };
  });
  const dependentVariables = dependent.map((variable, variableIndex) => {
    if (!variable || typeof variable !== "object" || !Array.isArray(variable.values) || variable.values.length !== pointCount) throw new PhysicsError("hepdata-dependent-variable-invalid");
    if (variable.qualifiers !== undefined && !Array.isArray(variable.qualifiers)) throw new PhysicsError("hepdata-qualifiers-invalid");
    if (Array.isArray(variable.qualifiers) && variable.qualifiers.length > MAX_HEPDATA_QUALIFIERS) throw new PhysicsError("hepdata-qualifiers-limit");
    const qualifiers = Array.isArray(variable.qualifiers) ? variable.qualifiers.map((qualifier) => {
      if (!qualifier || typeof qualifier !== "object") throw new PhysicsError("hepdata-qualifier-invalid");
      return { name: text(String(qualifier.name ?? ""), 1, 300, "hepdata-qualifier-name"), value: normalizeScalar(qualifier.value, "hepdata-qualifier-value"), units: optionalText(qualifier.units, 160, "hepdata-qualifier-units") };
    }) : [];
    return {
      header: normalizeHeader(variable.header, `dependent_${variableIndex + 1}`, "hepdata-dependent-header"),
      qualifiers,
      values: variable.values.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new PhysicsError("hepdata-dependent-value-invalid");
        if (entry.errors !== undefined && !Array.isArray(entry.errors)) throw new PhysicsError("hepdata-errors-invalid");
        if (Array.isArray(entry.errors) && entry.errors.length > MAX_HEPDATA_ERRORS_PER_POINT) throw new PhysicsError("hepdata-errors-limit");
        const errors = Array.isArray(entry.errors) ? entry.errors.map((error) => {
          if (!error || typeof error !== "object" || Array.isArray(error)) throw new PhysicsError("hepdata-error-invalid");
          const label = optionalText(error.label, 300, "hepdata-error-label");
          const hasSymmetric = error.symerror !== undefined && error.symerror !== null;
          const hasAsymmetric = error.asymerror !== undefined && error.asymerror !== null;
          if (hasSymmetric === hasAsymmetric) throw new PhysicsError("hepdata-error-invalid");
          if (hasSymmetric) return { label, kind: "symmetric", plus: normalizeHepDataScalar(error.symerror, "hepdata-symmetric-error"), minus: null };
          if (!error.asymerror || typeof error.asymerror !== "object" || Array.isArray(error.asymerror) || !Object.hasOwn(error.asymerror, "plus") || !Object.hasOwn(error.asymerror, "minus")) throw new PhysicsError("hepdata-error-invalid");
          return { label, kind: "asymmetric", plus: normalizeHepDataScalar(error.asymerror.plus, "hepdata-asymmetric-plus", true), minus: normalizeHepDataScalar(error.asymerror.minus, "hepdata-asymmetric-minus", true) };
        }) : [];
        return {
          value: entry.value === undefined || entry.value === null ? null : normalizeHepDataScalar(entry.value, "hepdata-dependent-value", true),
          errors,
        };
      }),
    };
  });
  const normalized = {
    schema: "agentlas.physics.hepdata-table/v1",
    source: { provider: "HEPData", canonicalUri: `hepdata:record/${recordId}/table/${encodeURIComponent(tableName)}${version === null ? "" : `/version/${version}`}` },
    recordId,
    tableName,
    version,
    pointCount,
    independentVariables,
    dependentVariables,
    rendererProjection: buildHepDataRendererProjection(independentVariables, dependentVariables, pointCount),
    rendererCompatibility: {
      rendererIds: ["agentlas.vega"],
      hostRequired: true,
      bundledRenderer: false,
      vtkSupported: false,
    },
  };
  const bytes = Buffer.byteLength(stableStringify(normalized));
  if (bytes > MAX_DATASET_BYTES) throw new PhysicsError("hepdata-normalized-table-too-large");
  return { ...normalized, normalizedBytes: bytes, normalizedSha256: sha256(stableStringify(normalized)) };
}

function verifiedHepDataTable(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== "agentlas.physics.hepdata-table/v1") {
    throw new PhysicsError("hepdata-analysis-table-invalid");
  }
  exactObject(value, ["schema", "source", "recordId", "tableName", "version", "pointCount", "independentVariables", "dependentVariables", "rendererProjection", "rendererCompatibility", "normalizedBytes", "normalizedSha256", "provenance"], "hepdata-analysis-table");
  const core = {
    schema: value.schema,
    source: value.source,
    recordId: value.recordId,
    tableName: value.tableName,
    version: value.version,
    pointCount: value.pointCount,
    independentVariables: value.independentVariables,
    dependentVariables: value.dependentVariables,
    rendererProjection: value.rendererProjection,
    rendererCompatibility: value.rendererCompatibility,
  };
  const serialized = stableStringify(core);
  if (!/^[a-f0-9]{64}$/.test(String(value.normalizedSha256 ?? "")) || sha256(serialized) !== value.normalizedSha256) {
    throw new PhysicsError("hepdata-analysis-table-hash-mismatch");
  }
  if (value.normalizedBytes !== Buffer.byteLength(serialized)) throw new PhysicsError("hepdata-analysis-table-bytes-mismatch");
  return core;
}

// Numerical Recipes-style regularized upper incomplete gamma. This is used only
// for the chi-square survival probability; contracts compare it with SciPy.
function logGamma(value) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.99999999999980993;
  const z = value - 1;
  for (let index = 0; index < coefficients.length; index += 1) x += coefficients[index] / (z + index + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function regularizedGammaQ(shape, value) {
  if (!(shape > 0) || value < 0 || !Number.isFinite(shape) || !Number.isFinite(value)) throw new PhysicsError("hepdata-analysis-gamma-input-invalid");
  if (value === 0) return 1;
  const epsilon = 1e-14;
  const tiny = 1e-300;
  const maximumIterations = 10_000;
  const logScale = -value + shape * Math.log(value) - logGamma(shape);
  if (value < shape + 1) {
    let term = 1 / shape;
    let sum = term;
    let denominator = shape;
    for (let index = 1; index <= maximumIterations; index += 1) {
      denominator += 1;
      term *= value / denominator;
      sum += term;
      if (Math.abs(term) <= Math.abs(sum) * epsilon) return Math.max(0, Math.min(1, 1 - sum * Math.exp(logScale)));
    }
    throw new PhysicsError("hepdata-analysis-gamma-nonconvergent");
  }
  let b = value + 1 - shape;
  let c = 1 / tiny;
  let d = 1 / Math.max(Math.abs(b), tiny);
  let fraction = d;
  for (let index = 1; index <= maximumIterations; index += 1) {
    const coefficient = -index * (index - shape);
    b += 2;
    d = coefficient * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + coefficient / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    fraction *= delta;
    if (Math.abs(delta - 1) <= epsilon) return Math.max(0, Math.min(1, Math.exp(logScale) * fraction));
  }
  throw new PhysicsError("hepdata-analysis-gamma-nonconvergent");
}

function analyzeHepDataChiSquare(input) {
  const value = exactObject(input, ["table", "dependentSeriesIndex", "prediction", "uncertaintyLabels", "fittedParameterCount"], "hepdata-analysis-input");
  const table = verifiedHepDataTable(value.table);
  if (table.independentVariables.length > 1) throw new PhysicsError("hepdata-analysis-dimensionality-unsupported");
  const dependentSeriesIndex = integer(value.dependentSeriesIndex, 0, Math.max(0, table.dependentVariables.length - 1), "hepdata-analysis-series-index");
  const series = table.dependentVariables[dependentSeriesIndex];
  if (!series) throw new PhysicsError("hepdata-analysis-series-index-invalid");
  const prediction = exactObject(value.prediction, ["label", "units", "values"], "hepdata-analysis-prediction");
  const predictionLabel = text(prediction.label, 1, 300, "hepdata-analysis-prediction-label");
  const predictionUnits = optionalText(prediction.units, 160, "hepdata-analysis-prediction-units");
  if (predictionUnits !== series.header.units) throw new PhysicsError("hepdata-analysis-units-mismatch", "Prediction units must exactly match the selected HEPData series units.");
  if (!Array.isArray(prediction.values) || prediction.values.length !== table.pointCount) throw new PhysicsError("hepdata-analysis-prediction-length-invalid");
  const predictions = prediction.values.map((entry, index) => entry === null ? null : finite(entry, -Number.MAX_VALUE, Number.MAX_VALUE, `hepdata-analysis-prediction-${index}`));
  if (!Array.isArray(value.uncertaintyLabels) || value.uncertaintyLabels.length < 1 || value.uncertaintyLabels.length > MAX_ANALYSIS_LABELS) {
    throw new PhysicsError("hepdata-analysis-uncertainty-labels-invalid");
  }
  const uncertaintyLabels = value.uncertaintyLabels.map((entry, index) => text(entry, 1, 300, `hepdata-analysis-uncertainty-label-${index}`));
  if (new Set(uncertaintyLabels).size !== uncertaintyLabels.length) throw new PhysicsError("hepdata-analysis-uncertainty-labels-duplicate");
  const fittedParameterCount = value.fittedParameterCount === undefined ? 0 : integer(value.fittedParameterCount, 0, 1_000, "hepdata-analysis-fitted-parameter-count");
  const projection = table.rendererProjection.series[dependentSeriesIndex];
  const rows = series.values.map((entry, pointIndex) => {
    const observed = numericMeasurement(entry.value);
    const expected = predictions[pointIndex];
    const axis = projection.points[pointIndex].independent[0] ?? null;
    if (observed === null || expected === null) {
      return { ordinal: pointIndex + 1, x: axis?.numericCenter ?? pointIndex + 1, xLow: axis?.numericLow ?? null, xHigh: axis?.numericHigh ?? null, observed, prediction: expected, residual: null, propagatedSigma: null, pull: null, chiSquareContribution: null, included: false, exclusionReason: observed === null ? "measurement-missing-or-nonnumeric" : "prediction-missing" };
    }
    const residual = observed - expected;
    const sigmas = uncertaintyLabels.map((label) => {
      const matches = projection.points[pointIndex].errors.filter((error) => error.label === label);
      if (matches.length !== 1) throw new PhysicsError("hepdata-analysis-uncertainty-component-missing", `Point ${pointIndex + 1} must contain exactly one uncertainty labeled ${label}.`);
      const component = matches[0];
      const directionalDelta = residual > 0 ? component.minusDelta : residual < 0 ? component.plusDelta : (component.plusDelta ?? component.minusDelta);
      if (directionalDelta === null || !Number.isFinite(directionalDelta) || Math.abs(directionalDelta) <= 0) {
        throw new PhysicsError("hepdata-analysis-uncertainty-component-invalid", `Point ${pointIndex + 1} uncertainty ${label} is not a positive numeric magnitude.`);
      }
      return Math.abs(directionalDelta);
    });
    const propagatedSigma = Math.sqrt(sigmas.reduce((sum, sigma) => sum + sigma * sigma, 0));
    const pull = residual / propagatedSigma;
    return { ordinal: pointIndex + 1, x: axis?.numericCenter ?? pointIndex + 1, xLow: axis?.numericLow ?? null, xHigh: axis?.numericHigh ?? null, observed, prediction: expected, residual, propagatedSigma, pull, chiSquareContribution: pull * pull, included: true, exclusionReason: null };
  });
  const included = rows.filter((row) => row.included);
  const degreesOfFreedom = included.length - fittedParameterCount;
  if (degreesOfFreedom <= 0) throw new PhysicsError("hepdata-analysis-degrees-of-freedom-invalid");
  const chiSquare = included.reduce((sum, row) => sum + row.chiSquareContribution, 0);
  const pValue = regularizedGammaQ(degreesOfFreedom / 2, chiSquare / 2);
  const axisHeader = table.independentVariables[0]?.header ?? { name: "Point", units: null };
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `${series.header.name}: measurement versus ${predictionLabel}`,
    columns: [
      { id: "ordinal", label: "Point", type: "number", unit: null },
      { id: "x", label: axisHeader.name, type: "number", unit: axisHeader.units },
      { id: "xLow", label: `${axisHeader.name} lower bound`, type: "number", unit: axisHeader.units },
      { id: "xHigh", label: `${axisHeader.name} upper bound`, type: "number", unit: axisHeader.units },
      { id: "observed", label: series.header.name, type: "number", unit: series.header.units },
      { id: "prediction", label: predictionLabel, type: "number", unit: predictionUnits },
      { id: "residual", label: "Residual", type: "number", unit: series.header.units },
      { id: "sigma", label: "Propagated uncertainty", type: "number", unit: series.header.units },
      { id: "pull", label: "Pull", type: "number", unit: null },
      { id: "chi2", label: "Chi-square contribution", type: "number", unit: null },
      { id: "included", label: "Included", type: "string", unit: null },
      { id: "reason", label: "Exclusion reason", type: "string", unit: null },
    ],
    rows: rows.map((row) => [row.ordinal, row.x, row.xLow, row.xHigh, row.observed, row.prediction, row.residual, row.propagatedSigma, row.pull, row.chiSquareContribution, String(row.included), row.exclusionReason]),
  };
  const plotRows = rows.filter((row) => row.included).map((row) => ({ x: row.x, observed: row.observed, prediction: row.prediction, residual: row.residual, sigma: row.propagatedSigma, pull: row.pull }));
  const vega = {
    schema: "agentlas.physics.hepdata-chi-square-vega/v1",
    rendererId: "agentlas.vega",
    measurementSpec: {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      description: `${series.header.name} measurement and ${predictionLabel} prediction with propagated one-sigma uncertainty.`,
      data: { values: plotRows },
      layer: [
        { mark: { type: "errorbar", ticks: true }, encoding: { x: { field: "x", type: "quantitative", title: axisHeader.name }, y: { field: "observed", type: "quantitative", title: series.header.name }, yError: { field: "sigma" } } },
        { mark: { type: "point", filled: true }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "observed", type: "quantitative" } } },
        { mark: { type: "line" }, encoding: { x: { field: "x", type: "quantitative" }, y: { field: "prediction", type: "quantitative" } } },
      ],
    },
    pullSpec: {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      description: "Directional normalized residuals used in the diagonal chi-square.",
      data: { values: plotRows },
      layer: [
        { mark: { type: "bar" }, encoding: { x: { field: "x", type: "quantitative", title: axisHeader.name }, y: { field: "pull", type: "quantitative", title: "Pull" } } },
        { mark: { type: "rule", color: "#555" }, encoding: { y: { datum: 0 } } },
      ],
    },
  };
  const normalized = {
    schema: "agentlas.physics.hepdata-chi-square-analysis/v1",
    sourceLineage: { normalizedTableSha256: value.table.normalizedSha256, recordId: table.recordId, tableName: table.tableName, version: table.version },
    series: { dependentSeriesIndex, name: series.header.name, units: series.header.units, predictionLabel },
    uncertaintyModel: { combination: "independent-quadrature", asymmetricPolicy: "direction-toward-prediction", labels: uncertaintyLabels },
    summary: { includedPointCount: included.length, excludedPointCount: rows.length - included.length, fittedParameterCount, degreesOfFreedom, chiSquare, reducedChiSquare: chiSquare / degreesOfFreedom, pValue },
    rows,
    publicationTable,
    vega,
    warnings: ["The selected uncertainty labels are treated as mutually independent diagonal components because the caller explicitly selected them; no covariance or correlation is inferred."],
  };
  const serialized = stableStringify(normalized);
  if (Buffer.byteLength(serialized) > MAX_DATASET_BYTES) throw new PhysicsError("hepdata-analysis-too-large");
  return { ...normalized, analysisBytes: Buffer.byteLength(serialized), analysisSha256: sha256(serialized) };
}

function normalizeNumericDataset(input) {
  const value = exactObject(input, ["title", "columns", "rows"], "physics-dataset-input");
  const title = text(value.title, 1, 500, "physics-dataset-title");
  if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > MAX_COLUMNS) throw new PhysicsError("physics-dataset-columns-invalid");
  const names = new Set();
  const columns = value.columns.map((column, index) => {
    const item = exactObject(column, ["name", "type", "unit"], "physics-dataset-column");
    const name = text(item.name, 1, 160, "physics-column-name");
    if (names.has(name)) throw new PhysicsError("physics-column-name-duplicate");
    names.add(name);
    const type = text(item.type, 1, 20, "physics-column-type");
    if (type !== "number" && type !== "string") throw new PhysicsError("physics-column-type-invalid");
    return { id: `c${index + 1}`, name, type, unit: optionalText(item.unit, 120, "physics-column-unit") };
  });
  if (!Array.isArray(value.rows) || value.rows.length > MAX_ROWS) throw new PhysicsError("physics-dataset-rows-invalid");
  const rows = value.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new PhysicsError("physics-dataset-row-width-invalid", `row ${rowIndex} has the wrong width`);
    return row.map((cell, columnIndex) => {
      if (cell === null) return null;
      return columns[columnIndex].type === "number"
        ? finite(cell, -Number.MAX_VALUE, Number.MAX_VALUE, "physics-dataset-number")
        : text(cell, 0, 2_000, "physics-dataset-string");
    });
  });
  const table = { schema: "agentlas.science-table/v1", title, columns, rows };
  const bytes = Buffer.byteLength(stableStringify(table));
  if (bytes > MAX_DATASET_BYTES) throw new PhysicsError("physics-dataset-too-large");
  const normalized = {
    schema: "agentlas.physics.user-dataset/v1",
    source: { provider: "user", canonicalUri: `agentlas-dataset:sha256:${sha256(stableStringify(table))}` },
    table,
    rowCount: rows.length,
    columnCount: columns.length,
    rendererCompatibility: { rendererIds: ["agentlas.vega"], hostRequired: true, bundledRenderer: false, vtkSupported: false },
  };
  return { ...normalized, normalizedBytes: bytes, normalizedSha256: sha256(stableStringify(normalized)) };
}

function createRateGate({ minIntervalMs, clockMs, sleep }) {
  let tail = Promise.resolve();
  let lastStartedAt = -Infinity;
  return async (operation) => {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, minIntervalMs - (clockMs() - lastStartedAt));
      if (waitMs) await sleep(waitMs);
      lastStartedAt = clockMs();
      return await operation();
    } finally { release(); }
  };
}

function responseContentLength(response) {
  const raw = response.headers?.get?.("content-length");
  if (raw === null || raw === undefined || raw === "") return null;
  if (!/^[0-9]+$/.test(String(raw))) throw new PhysicsError("physics-provider-content-length-invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new PhysicsError("physics-provider-content-length-invalid");
  return value;
}

async function readBoundedBody(response, maxBytes) {
  const declared = responseContentLength(response);
  if (declared !== null && declared > maxBytes) throw new PhysicsError("physics-provider-response-too-large", "Provider Content-Length exceeds the byte limit", { maximum: maxBytes, contentLength: declared });
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* byte cap is already enforced */ }
        throw new PhysicsError("physics-provider-response-too-large", "Streamed provider response exceeds the byte limit", { maximum: maxBytes, received: total });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response.arrayBuffer !== "function") throw new PhysicsError("physics-provider-response-invalid");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new PhysicsError("physics-provider-response-too-large", "Provider response exceeds the byte limit", { maximum: maxBytes, received: bytes.byteLength });
  return bytes;
}

async function readJsonResponse(response, maxBytes, provider) {
  if (!response || typeof response.status !== "number") throw new PhysicsError("physics-provider-response-invalid");
  const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase().split(";", 1)[0].trim();
  if (contentType !== "application/json") throw new PhysicsError("physics-provider-content-type-invalid", `${provider} returned ${contentType || "no content type"}`);
  const bytes = await readBoundedBody(response, maxBytes);
  try { return { bytes, contentType, parsed: JSON.parse(bytes.toString("utf8")) }; } catch { throw new PhysicsError("physics-provider-json-invalid"); }
}

function retryAfterMs(response, nowMs, maximum) {
  const raw = response.headers?.get?.("retry-after");
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const normalized = String(raw).trim();
  let delay;
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) delay = Number(normalized) * 1_000;
  else {
    const parsed = Date.parse(normalized);
    if (!Number.isFinite(parsed)) return null;
    delay = Math.max(0, parsed - nowMs);
  }
  return Math.min(maximum, Math.max(0, Math.ceil(delay)));
}

function validateClientOptions(options) {
  exactObject(options, ["fetchImpl", "clockMs", "sleep", "timeoutMs", "maxResponseBytes", "inspireIntervalMs", "hepdataIntervalMs", "retries", "retryDelayMs", "maxRetryAfterMs", "userAgent"], "physics-client-options");
  if (options.fetchImpl !== undefined && typeof options.fetchImpl !== "function") throw new PhysicsError("physics-fetch-invalid");
  if (options.clockMs !== undefined && typeof options.clockMs !== "function") throw new PhysicsError("physics-clock-invalid");
  if (options.sleep !== undefined && typeof options.sleep !== "function") throw new PhysicsError("physics-sleep-invalid");
  const policy = {
    timeoutMs: options.timeoutMs === undefined ? DEFAULT_NETWORK_POLICY.timeoutMs : integer(options.timeoutMs, 250, DEFAULT_NETWORK_POLICY.timeoutMs, "physics-timeout-ms"),
    maxResponseBytes: options.maxResponseBytes === undefined ? DEFAULT_NETWORK_POLICY.maxResponseBytes : integer(options.maxResponseBytes, 1_024, MAX_RESPONSE_BYTES, "physics-max-response-bytes"),
    inspireIntervalMs: options.inspireIntervalMs === undefined ? DEFAULT_NETWORK_POLICY.inspireIntervalMs : integer(options.inspireIntervalMs, 0, 10_000, "physics-inspire-interval-ms"),
    hepdataIntervalMs: options.hepdataIntervalMs === undefined ? DEFAULT_NETWORK_POLICY.hepdataIntervalMs : integer(options.hepdataIntervalMs, 0, 10_000, "physics-hepdata-interval-ms"),
    retries: options.retries === undefined ? DEFAULT_NETWORK_POLICY.retries : integer(options.retries, 0, 3, "physics-retries"),
    retryDelayMs: options.retryDelayMs === undefined ? DEFAULT_NETWORK_POLICY.retryDelayMs : integer(options.retryDelayMs, 0, 5_000, "physics-retry-delay-ms"),
    maxRetryAfterMs: options.maxRetryAfterMs === undefined ? DEFAULT_NETWORK_POLICY.maxRetryAfterMs : integer(options.maxRetryAfterMs, 0, DEFAULT_NETWORK_POLICY.maxRetryAfterMs, "physics-max-retry-after-ms"),
    userAgent: options.userAgent === undefined ? DEFAULT_NETWORK_POLICY.userAgent : text(options.userAgent, 8, 256, "physics-user-agent"),
  };
  return Object.freeze(policy);
}

function createPhysicsClient(options = {}) {
  const policy = validateClientOptions(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new PhysicsError("physics-fetch-unavailable");
  const clockMs = options.clockMs ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { timeoutMs, maxResponseBytes, inspireIntervalMs, hepdataIntervalMs } = policy;
  const inspireGate = createRateGate({ minIntervalMs: inspireIntervalMs, clockMs, sleep });
  const hepdataGate = createRateGate({ minIntervalMs: hepdataIntervalMs, clockMs, sleep });
  const fetchJson = async (request, provider, gate, normalize) => {
    let outcome = null;
    let attempts = 0;
    while (outcome === null) {
      attempts += 1;
      outcome = await gate(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(request.url, {
            method: "GET",
            headers: { accept: "application/json", "user-agent": policy.userAgent },
            redirect: "error",
            signal: controller.signal,
          });
          if (!response || typeof response.status !== "number") throw new PhysicsError("physics-provider-response-invalid");
          if (response.redirected || (response.url && new URL(response.url).toString() !== new URL(request.url).toString())) throw new PhysicsError("physics-provider-redirect-denied");
          if (RETRYABLE_STATUS_CODES.includes(response.status) && attempts <= policy.retries) {
            try { await response.body?.cancel?.(); } catch { /* response body is untrusted */ }
            const declared = retryAfterMs(response, clockMs(), policy.maxRetryAfterMs);
            const minimum = response.status === 429 && provider === "INSPIRE" ? 5_000 : 0;
            const fallback = Math.min(policy.maxRetryAfterMs, Math.max(minimum, policy.retryDelayMs * (2 ** (attempts - 1))));
            await sleep(declared === null ? fallback : Math.max(minimum, declared));
            return null;
          }
          if (response.status < 200 || response.status >= 300) {
            const retryAfter = optionalText(response.headers?.get?.("retry-after"), 120, "physics-retry-after");
            throw new PhysicsError("physics-provider-http-error", `${provider} request failed with HTTP ${response.status}`, { provider, status: response.status, retryAfter });
          }
          const parsed = await readJsonResponse(response, maxResponseBytes, provider);
          return { response, ...parsed };
        } catch (error) {
          if (controller.signal.aborted || error?.name === "AbortError") throw new PhysicsError("physics-provider-timeout", `${provider} request timed out`, { provider, timeoutMs });
          throw error;
        } finally { clearTimeout(timer); }
      });
    }
    const normalized = normalize(outcome.parsed);
    if (provider === "INSPIRE" && normalized.resultCount > request.input.limit) throw new PhysicsError("inspire-response-query-limit-exceeded");
    const requestDescriptor = { method: "GET", url: request.url, accept: "application/json" };
    const provenance = {
      schema: "agentlas.science-source-receipt/v1",
      provider,
      endpoint: new URL(request.url).origin + new URL(request.url).pathname,
      requestUrl: request.url,
      requestSha256: sha256(stableStringify(requestDescriptor)),
      rawResponseSha256: sha256(outcome.bytes),
      rawResponseBytes: outcome.bytes.byteLength,
      responseStatus: outcome.response.status,
      responseContentType: outcome.contentType,
      normalizedSha256: normalized.normalizedSha256,
      retrievedAt: new Date(clockMs()).toISOString(),
      attempts,
      itemCount: normalized.resultCount ?? normalized.tableCount ?? normalized.pointCount ?? 1,
      limits: { responseBytes: maxResponseBytes, timeoutMs, minimumIntervalMs: provider === "INSPIRE" ? inspireIntervalMs : hepdataIntervalMs, retries: policy.retries },
    };
    return { ...normalized, query: request.input, provenance };
  };
  return {
    searchInspireLiterature(input) {
      const request = buildInspireUrl(input);
      return fetchJson(request, "INSPIRE", inspireGate, normalizeInspireResponse);
    },
    fetchHepDataRecord(input) {
      const request = buildHepDataRecordUrl(input);
      return fetchJson(request, "HEPData", hepdataGate, (raw) => normalizeHepDataRecord(raw, request.input.recordId));
    },
    fetchHepDataTable(input) {
      const request = buildHepDataTableUrl(input);
      return fetchJson(request, "HEPData", hepdataGate, (raw) => normalizeHepDataTable({
        recordId: request.input.recordId,
        tableName: request.input.tableName,
        version: request.input.version,
        table: raw,
      }));
    },
    policy: { ...policy, retryableStatusCodes: [...RETRYABLE_STATUS_CODES] },
  };
}

module.exports = {
  HEPDATA_RECORD_ENDPOINT,
  HEPDATA_TABLE_ENDPOINT,
  INSPIRE_ENDPOINT,
  DEFAULT_NETWORK_POLICY,
  MAX_COLUMNS,
  MAX_DATASET_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_ROWS,
  RETRYABLE_STATUS_CODES,
  PhysicsError,
  buildHepDataRecordUrl,
  buildHepDataTableUrl,
  buildInspireUrl,
  createPhysicsClient,
  normalizeHepDataRecord,
  normalizeHepDataTable,
  analyzeHepDataChiSquare,
  normalizeInspireResponse,
  normalizeNumericDataset,
  readBoundedBody,
  sha256,
  stableStringify,
};
