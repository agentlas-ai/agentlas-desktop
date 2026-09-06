"use strict";

const crypto = require("node:crypto");

const PLUGIN_ID = "agentlas-astronomy";
const PLUGIN_VERSION = "1.2.2";
const SIMBAD_ORIGIN = "https://simbad.cds.unistra.fr";
const SIMBAD_TAP_PATH = "/simbad/sim-tap/sync";
const SIMBAD_TAP_ENDPOINT = `${SIMBAD_ORIGIN}${SIMBAD_TAP_PATH}`;
const CATALOG_SCHEMA = "agentlas.astronomy.simbad-catalog/v1";
const ASTROMETRIC_KINEMATICS_SCHEMA = "agentlas.astronomy.astrometric-kinematics/v1";
const LOMB_SCARGLE_SCHEMA = "agentlas.astronomy.lomb-scargle-periodogram/v1";
const PROVENANCE_SCHEMA = "agentlas.provenance-receipt/v1";
const ASTROMETRIC_KINEMATICS_ALGORITHM = deepFreeze({
  id: "agentlas.astronomy.astrometric-kinematics",
  version: "1.0.0",
  properMotionConvention: "mu_alpha_star=mu_alpha*cos(dec)",
  errorEllipseConvention: "position-angle-north-through-east-deg",
  distanceEstimator: "naive-inverse-parallax",
  uncertaintyPropagation: "first-order-delta-method",
  confidenceInterval: "normal-two-sided-95-percent",
  parallaxProperMotionCovariance: "assumed-zero-not-provided-by-input",
  transverseVelocityConstantKmS: 4.74047,
  normalCriticalValue95: 1.959963984540054,
  officialErrorEllipseDocumentation: "https://simbad.cds.unistra.fr/Pages/guide/errell.htx",
});
const LOMB_SCARGLE_ALGORITHM = deepFreeze({
  id: "agentlas.astronomy.generalized-lomb-scargle",
  version: "1.0.0",
  method: "weighted-floating-mean-generalized-lomb-scargle",
  model: "y(t)=offset+cosineCoefficient*cos(2*pi*f*(t-timeOrigin))+sineCoefficient*sin(2*pi*f*(t-timeOrigin))",
  normalization: "standard-power=1-residual-sum-of-squares-at-frequency/constant-model-residual-sum-of-squares",
  frequencyGrid: "inclusive-linear-frequency-grid",
  weighting: "inverse-variance-when-resolved-weighting-is-weighted; otherwise equal-weight",
  timeOrigin: "minimum-analysis-eligible-time",
  windowFunction: "squared-modulus-of-normalized-weighted-complex-sampling-transform",
  falseAlarmProbability: "baluev-2008-analytic-upper-bound-on-standard-normalized-power",
  falseAlarmInterpretation: "analytic upper bound under the declared white-noise model; a returned 0 is a numerical floor, not exact certainty",
  periodUncertainty: "montgomery-odonoghue-1999-frequency-standard-error-propagated-to-period",
  periodUncertaintyInterpretation: "standard-error estimate under the single-sinusoid model, not a confidence interval",
  reference: {
    title: "The generalised Lomb-Scargle periodogram: A new formalism for the floating-mean and Keplerian periodograms",
    authors: "M. Zechmeister and M. Kuerster",
    doi: "10.1051/0004-6361:200811296",
    url: "https://www.aanda.org/articles/aa/pdf/2009/11/aa11296-08.pdf",
  },
  falseAlarmReference: {
    title: "Assessing the statistical significance of periodogram peaks",
    authors: "R. V. Baluev",
    doi: "10.1111/j.1365-2966.2008.12689.x",
    note: "Analytic upper bound via the Davies extreme-value bound; see also VanderPlas 2018, doi:10.3847/1538-4365/aab766, eq. 21-22.",
  },
  periodUncertaintyReference: {
    title: "A derivation of the errors for least squares fitting to time series data",
    authors: "M. H. Montgomery and D. O'Donoghue",
    note: "Delta Scuti Star Newsletter 13, 28. Frequency standard error sigma_f = sqrt(6/N) * sigma_residual / (pi * T * amplitude), propagated to period by sigma_P = P^2 * sigma_f.",
  },
});
const LOMB_SCARGLE_BOUNDARIES = deepFreeze([
  "The Baluev false-alarm probability is an analytic upper bound under an independent Gaussian white-noise model; correlated noise, mis-scaled errors, and aliases can invalidate that interpretation.",
  "The Montgomery-O'Donoghue period value is a local single-sinusoid standard-error estimate, not a confidence interval and not an alias resolution.",
  "A returned false-alarm probability of 0 is the numerical lower floor of the bounded calculation, not exact certainty.",
  "No detrending, red-noise model, multi-harmonic fit, or transit template is applied; the declared astronomical time system is preserved verbatim.",
]);

/**
 * The chance that pure noise would produce a peak at least this strong, anywhere in the searched
 * band.
 *
 * The question a light curve is asked is almost always "is this real, or is it the noise?", and a
 * peak height alone cannot answer it: a tall peak in a wide frequency search is ordinary. This is
 * the Baluev (2008) analytic bound, which prices the width of the search rather than assuming the
 * grid points are independent -- the assumption that makes naive estimates wrong by orders of
 * magnitude. Deterministic, so the same series always gets the same number; no simulation, no seed.
 *
 * `power` is the standard normalized power in [0,1], the same quantity this periodogram reports.
 * Returns a probability in [0,1]; the bound is conservative, so a small value is trustworthy in the
 * direction that matters.
 */
function baluevFalseAlarmProbability(power, pointCount, maximumFrequencyPerDay, points) {
  // Three fitted parameters (offset, cosine, sine) leave N-3 degrees of freedom.
  const degreesOfFreedom = pointCount - 3;
  if (!(degreesOfFreedom > 0) || !(power > 0) || power >= 1) return null;
  // Weighted spread of the observation times: this, not the raw baseline, sets how many independent
  // frequencies a search of this width really contains.
  const weightSum = points.reduce((sum, point) => sum + point.weight, 0);
  if (!(weightSum > 0)) return null;
  const meanTime = points.reduce((sum, point) => sum + point.weight * point.time, 0) / weightSum;
  const timeVariance = points.reduce((sum, point) => sum + point.weight * (point.time - meanTime) ** 2, 0) / weightSum;
  if (!(timeVariance > 0)) return null;
  const effectiveBaseline = Math.sqrt(4 * Math.PI * timeVariance);
  const searchWidth = maximumFrequencyPerDay * effectiveBaseline;
  // Single-frequency probability, then the extreme-value correction over the whole band.
  const singleFrequency = (1 - power) ** (0.5 * degreesOfFreedom);
  const tau = searchWidth * (1 - power) ** (0.5 * (degreesOfFreedom - 1)) * Math.sqrt(0.5 * (pointCount - 1) * power);
  const combined = -Math.expm1(-tau) + singleFrequency * Math.exp(-tau);
  if (!Number.isFinite(combined)) return null;
  return Math.min(1, Math.max(0, combined));
}

/**
 * How well the period itself is pinned down, in days.
 *
 * A period with no uncertainty cannot be compared with a published one, which is most of what a
 * reader wants to do with it. Montgomery and O'Donoghue's frequency standard error, propagated to
 * the period. Null when the fit has no amplitude or no baseline to measure against, because an
 * invented interval is worse than an absent one.
 */
function periodStandardErrorDays(periodDays, pointCount, baselineDays, amplitude, residualRootMeanSquare) {
  if (!(periodDays > 0) || !(pointCount > 0) || !(baselineDays > 0) || !(amplitude > 0)) return null;
  if (!Number.isFinite(residualRootMeanSquare) || residualRootMeanSquare <= 0) return null;
  const frequencyStandardError = Math.sqrt(6 / pointCount) * residualRootMeanSquare / (Math.PI * baselineDays * amplitude);
  const periodError = periodDays ** 2 * frequencyStandardError;
  return Number.isFinite(periodError) && periodError > 0 ? periodError : null;
}
const LOMB_SCARGLE_LIMITS = deepFreeze({
  minMeasurements: 5,
  maxMeasurements: 2000,
  minDistinctTimes: 5,
  minFrequencyCount: 32,
  maxFrequencyCount: 5000,
  minPeaks: 1,
  maxPeaks: 20,
  maxPeriodRatio: 1_000_000_000,
});
const SOURCE_AUTHORITY = deepFreeze({
  schema: "agentlas.astronomy.official-source/v1",
  providerId: "simbad-tap",
  databaseName: "SIMBAD Astronomical Database",
  operatorName: "Centre de Données astronomiques de Strasbourg",
  institutionCode: "CDS",
  endpoint: SIMBAD_TAP_ENDPOINT,
  documentationUrl: "https://simbad.cds.unistra.fr/Pages/guide/sim-url.htx",
  access: "official-public-anonymous",
});

const CONTENT_TYPE_ALLOWLIST = deepFreeze({
  json: ["application/json", "text/json"],
  csv: ["text/csv", "application/csv"],
  tsv: ["text/tab-separated-values", "text/tsv"],
});
const RETRYABLE_STATUS_CODES = deepFreeze([408, 429, 502, 503, 504]);
const DEFAULT_POLICY = deepFreeze({
  timeoutMs: 15000,
  retries: 2,
  retryDelayMs: 250,
  rateIntervalMs: 500,
  maxRetryAfterMs: 10000,
  maxResponseBytes: 8 * 1024 * 1024,
  maxSourceAgeMs: 24 * 60 * 60 * 1000,
  maxObjects: 500,
  minRadiusDeg: 0.001,
  maxRadiusDeg: 10,
  userAgent: "Agentlas-Astronomy/1.2.2 (SIMBAD TAP object research; https://agentlas.ai)",
  contentTypes: CONTENT_TYPE_ALLOWLIST,
  retryableStatusCodes: RETRYABLE_STATUS_CODES,
});

const COLUMN_DEFINITIONS = deepFreeze([
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
]);
const SOURCE_COLUMNS = COLUMN_DEFINITIONS.map((column) => column.sourceName);
const OPTIONAL_FIELDS = [
  "spectralType",
  "parallaxMas",
  "properMotionRaMasYr",
  "properMotionDecMasYr",
  "radialVelocityKmS",
  "redshift",
];

class AstronomyDataError extends Error {
  constructor(code, message = code, details = null, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AstronomyDataError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AstronomyDataError("astronomy-canonical-number-invalid");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new AstronomyDataError("astronomy-canonical-value-invalid");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactObject(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AstronomyDataError(code);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AstronomyDataError(code, code, { unknownFields: unknown.sort() });
}

function finiteNumber(value, field, minimum, maximum, maximumExclusive = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AstronomyDataError(`simbad-${field}-invalid`, `${field} must be a finite number`);
  }
  if (value < minimum || (maximumExclusive ? value >= maximum : value > maximum)) {
    throw new AstronomyDataError(`simbad-${field}-out-of-range`, `${field} is outside the allowed range`, { minimum, maximum, maximumExclusive });
  }
  return Object.is(value, -0) ? 0 : value;
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AstronomyDataError(`simbad-${field}-invalid`, `${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function decimal(value) {
  if (Object.is(value, -0)) return "0";
  return String(value);
}

function normalizeSearchInput(input) {
  exactObject(input, ["centerRaDeg", "centerDecDeg", "radiusDeg", "limit", "format"], "simbad-search-input-invalid");
  const centerRaDeg = finiteNumber(input.centerRaDeg, "center-ra-deg", 0, 360, true);
  const centerDecDeg = finiteNumber(input.centerDecDeg, "center-dec-deg", -90, 90);
  const radiusDeg = finiteNumber(input.radiusDeg, "radius-deg", DEFAULT_POLICY.minRadiusDeg, DEFAULT_POLICY.maxRadiusDeg);
  const limit = input.limit === undefined ? 100 : boundedInteger(input.limit, "limit", 1, DEFAULT_POLICY.maxObjects);
  const format = input.format === undefined ? "json" : input.format;
  if (!Object.hasOwn(CONTENT_TYPE_ALLOWLIST, format)) throw new AstronomyDataError("simbad-format-invalid");
  return { centerRaDeg, centerDecDeg, radiusDeg, limit, format };
}

function buildAdql(input) {
  return `SELECT TOP ${input.limit} main_id,ra,dec,otype,sp_type,plx_value,pmra,pmdec,rvz_radvel,rvz_redshift FROM basic WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${decimal(input.centerRaDeg)},${decimal(input.centerDecDeg)},${decimal(input.radiusDeg)})) ORDER BY main_id`;
}

function assertAllowedSimbadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AstronomyDataError("simbad-endpoint-denied", "SIMBAD URL is invalid", null, error);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== SIMBAD_ORIGIN ||
    url.hostname !== "simbad.cds.unistra.fr" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== SIMBAD_TAP_PATH ||
    url.hash !== ""
  ) throw new AstronomyDataError("simbad-endpoint-denied", "Only the official SIMBAD TAP sync endpoint is allowed");

  const entries = [...url.searchParams.entries()];
  const names = entries.map(([name]) => name);
  const exactNames = ["REQUEST", "LANG", "FORMAT", "QUERY"];
  if (entries.length !== exactNames.length || names.some((name, index) => name !== exactNames[index])) {
    throw new AstronomyDataError("simbad-endpoint-denied", "SIMBAD TAP parameters must be the exact uppercase allowlist", { names });
  }
  if (url.searchParams.get("REQUEST") !== "doQuery" || url.searchParams.get("LANG") !== "ADQL") {
    throw new AstronomyDataError("simbad-endpoint-denied", "SIMBAD TAP request contract is invalid");
  }
  if (!Object.hasOwn(CONTENT_TYPE_ALLOWLIST, url.searchParams.get("FORMAT"))) {
    throw new AstronomyDataError("simbad-endpoint-denied", "SIMBAD TAP format is not allowed");
  }
  const query = url.searchParams.get("QUERY");
  const numberToken = "(-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?)";
  const match = typeof query === "string" ? new RegExp(`^SELECT TOP ([1-9][0-9]{0,2}) main_id,ra,dec,otype,sp_type,plx_value,pmra,pmdec,rvz_radvel,rvz_redshift FROM basic WHERE 1=CONTAINS\\(POINT\\('ICRS',ra,dec\\),CIRCLE\\('ICRS',${numberToken},${numberToken},${numberToken}\\)\\) ORDER BY main_id$`).exec(query) : null;
  if (!match) {
    throw new AstronomyDataError("simbad-endpoint-denied", "SIMBAD TAP query is outside the fixed cone-search template");
  }
  const reconstructed = buildAdql({
    limit: boundedInteger(Number(match[1]), "limit", 1, DEFAULT_POLICY.maxObjects),
    centerRaDeg: finiteNumber(Number(match[2]), "center-ra-deg", 0, 360, true),
    centerDecDeg: finiteNumber(Number(match[3]), "center-dec-deg", -90, 90),
    radiusDeg: finiteNumber(Number(match[4]), "radius-deg", DEFAULT_POLICY.minRadiusDeg, DEFAULT_POLICY.maxRadiusDeg),
  });
  if (query !== reconstructed) throw new AstronomyDataError("simbad-endpoint-denied", "SIMBAD TAP query is not canonical");
  return url.toString();
}

function buildSimbadUrl(input) {
  const normalized = normalizeSearchInput(input);
  const adql = buildAdql(normalized);
  const url = new URL(SIMBAD_TAP_ENDPOINT);
  url.searchParams.append("REQUEST", "doQuery");
  url.searchParams.append("LANG", "ADQL");
  url.searchParams.append("FORMAT", normalized.format);
  url.searchParams.append("QUERY", adql);
  const exactUrl = assertAllowedSimbadUrl(url.toString());
  return {
    input: { ...normalized, adql },
    url: exactUrl,
    requestSha256: sha256(exactUrl),
  };
}

function utf8(value) {
  const bytes = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), "utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AstronomyDataError("simbad-response-utf8-invalid", "SIMBAD response is not valid UTF-8", null, error);
  }
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { inQuotes = false; afterQuote = true; }
      } else field += char;
      continue;
    }
    if (afterQuote && char !== delimiter && char !== "\r" && char !== "\n") {
      throw new AstronomyDataError("simbad-response-delimited-invalid", "Unexpected character after closing quote");
    }
    if (char === '"') {
      if (field !== "" || afterQuote) throw new AstronomyDataError("simbad-response-delimited-invalid", "Unexpected quote in unquoted field");
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      afterQuote = false;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      afterQuote = false;
      continue;
    }
    field += char;
    afterQuote = false;
  }
  if (inQuotes) throw new AstronomyDataError("simbad-response-delimited-invalid", "Unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length && rows.at(-1).every((cell) => cell === "")) rows.pop();
  return rows;
}

function parsePayload(value, format) {
  if (format === "json") {
    if (value && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return value;
    try {
      return JSON.parse(utf8(value));
    } catch (error) {
      if (error instanceof AstronomyDataError) throw error;
      throw new AstronomyDataError("simbad-response-json-invalid", "SIMBAD JSON response could not be parsed", null, error);
    }
  }
  const parsed = parseDelimited(utf8(value), format === "csv" ? "," : "\t");
  if (!parsed.length) throw new AstronomyDataError("simbad-response-header-invalid", "SIMBAD response has no header");
  parsed[0][0] = parsed[0][0].replace(/^\uFEFF/, "");
  return { metadata: parsed[0].map((name) => ({ name })), data: parsed.slice(1) };
}

function nullableString(value, field, rowIndex) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new AstronomyDataError("simbad-response-row-invalid", `${field} must be a string or null`, { rowIndex, field });
  const normalized = value.normalize("NFC").trim();
  return normalized === "" ? null : normalized;
}

function requiredString(value, field, rowIndex) {
  const normalized = nullableString(value, field, rowIndex);
  if (normalized === null) throw new AstronomyDataError("simbad-response-row-invalid", `${field} is required`, { rowIndex, field });
  return normalized;
}

function nullableNumber(value, field, rowIndex) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new AstronomyDataError("simbad-response-row-invalid", `${field} must be a finite number or null`, { rowIndex, field });
  return Object.is(number, -0) ? 0 : number;
}

function requiredNumber(value, field, rowIndex, minimum, maximum) {
  const number = nullableNumber(value, field, rowIndex);
  if (number === null || number < minimum || number > maximum) {
    throw new AstronomyDataError("simbad-response-row-invalid", `${field} is outside its valid range`, { rowIndex, field, minimum, maximum });
  }
  return number;
}

function stableObjectId(mainId) {
  return `simbad:${sha256(mainId.normalize("NFC"))}`;
}

function normalizeRow(row, rowIndex) {
  if (!Array.isArray(row) || row.length !== SOURCE_COLUMNS.length) {
    throw new AstronomyDataError("simbad-response-row-invalid", "SIMBAD row has an unexpected number of columns", { rowIndex, expected: SOURCE_COLUMNS.length, actual: Array.isArray(row) ? row.length : null });
  }
  const mainId = requiredString(row[0], "mainId", rowIndex);
  const raDeg = requiredNumber(row[1], "raDeg", rowIndex, 0, 360);
  if (raDeg >= 360) throw new AstronomyDataError("simbad-response-row-invalid", "raDeg is outside its valid range", { rowIndex, field: "raDeg", minimum: 0, maximumExclusive: 360 });
  return {
    stableObjectId: stableObjectId(mainId),
    mainId,
    raDeg,
    decDeg: requiredNumber(row[2], "decDeg", rowIndex, -90, 90),
    objectType: requiredString(row[3], "objectType", rowIndex),
    spectralType: nullableString(row[4], "spectralType", rowIndex),
    parallaxMas: nullableNumber(row[5], "parallaxMas", rowIndex),
    properMotionRaMasYr: nullableNumber(row[6], "properMotionRaMasYr", rowIndex),
    properMotionDecMasYr: nullableNumber(row[7], "properMotionDecMasYr", rowIndex),
    radialVelocityKmS: nullableNumber(row[8], "radialVelocityKmS", rowIndex),
    redshift: nullableNumber(row[9], "redshift", rowIndex),
  };
}

function compareObjects(left, right) {
  if (left.mainId !== right.mainId) return left.mainId < right.mainId ? -1 : 1;
  if (left.raDeg !== right.raDeg) return left.raDeg - right.raDeg;
  return left.decDeg - right.decDeg;
}

function normalizeSimbadResponse(value, options = {}) {
  exactObject(options, ["format"], "simbad-normalize-options-invalid");
  const format = options.format === undefined ? "json" : options.format;
  if (!Object.hasOwn(CONTENT_TYPE_ALLOWLIST, format)) throw new AstronomyDataError("simbad-format-invalid");
  const payload = parsePayload(value, format);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AstronomyDataError("simbad-response-shape-invalid");
  if (!Array.isArray(payload.metadata) || !Array.isArray(payload.data)) throw new AstronomyDataError("simbad-response-shape-invalid");
  const metadataNames = payload.metadata.map((column, index) => {
    if (!column || typeof column !== "object" || Array.isArray(column) || typeof column.name !== "string") {
      throw new AstronomyDataError("simbad-response-metadata-invalid", "SIMBAD metadata column is invalid", { index });
    }
    return column.name.replace(/^\uFEFF/, "");
  });
  if (canonicalJson(metadataNames) !== canonicalJson(SOURCE_COLUMNS)) {
    throw new AstronomyDataError("simbad-response-columns-invalid", "SIMBAD response columns do not match the fixed projection", { expected: SOURCE_COLUMNS, actual: metadataNames });
  }
  if (payload.data.length > DEFAULT_POLICY.maxObjects) {
    throw new AstronomyDataError("simbad-response-object-limit-exceeded", "SIMBAD response exceeds the normalized object limit", { maximum: DEFAULT_POLICY.maxObjects, actual: payload.data.length });
  }
  const normalizedRows = payload.data.map(normalizeRow);
  const uniqueObjects = new Map();
  let duplicateRowsRemoved = 0;
  for (const object of normalizedRows) {
    const existing = uniqueObjects.get(object.stableObjectId);
    if (!existing) {
      uniqueObjects.set(object.stableObjectId, object);
      continue;
    }
    if (canonicalJson(existing) !== canonicalJson(object)) {
      throw new AstronomyDataError("simbad-response-object-conflict", "SIMBAD returned conflicting rows for one stable object", {
        stableObjectId: object.stableObjectId,
        mainId: object.mainId,
      });
    }
    duplicateRowsRemoved += 1;
  }
  const objects = [...uniqueObjects.values()].sort(compareObjects);
  const missingValueCount = objects.reduce((count, object) => count + OPTIONAL_FIELDS.filter((field) => object[field] === null).length, 0);
  const normalizedCore = { columns: COLUMN_DEFINITIONS, objects };
  return {
    schema: CATALOG_SCHEMA,
    provider: {
      id: "simbad-tap",
      name: "SIMBAD Astronomical Database",
      institution: "CDS",
      endpoint: SIMBAD_TAP_ENDPOINT,
      authentication: "none",
    },
    format,
    columns: COLUMN_DEFINITIONS,
    inputObjectCount: normalizedRows.length,
    objectCount: objects.length,
    duplicateRowsRemoved,
    missingValueCount,
    objects,
    normalizedSha256: sha256(canonicalJson(normalizedCore)),
  };
}

function contentType(response) {
  return String(response.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

function validateContentType(response, format) {
  const actual = contentType(response);
  if (!CONTENT_TYPE_ALLOWLIST[format].includes(actual)) {
    throw new AstronomyDataError("simbad-response-content-type-denied", "SIMBAD response content type is not allowed", { expected: CONTENT_TYPE_ALLOWLIST[format], actual: actual || null });
  }
  return actual;
}

function precheckContentLength(response, maximum) {
  const header = response.headers?.get?.("content-length");
  if (header === null || header === undefined || header === "") return;
  if (!/^[0-9]+$/.test(String(header))) throw new AstronomyDataError("simbad-response-content-length-invalid");
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw new AstronomyDataError("simbad-response-content-length-invalid");
  if (length > maximum) throw new AstronomyDataError("simbad-response-too-large", "SIMBAD response Content-Length exceeds the byte limit", { maximum, contentLength: length });
}

async function readBoundedBody(response, maximum) {
  precheckContentLength(response, maximum);
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* the byte cap is already enforced */ }
        throw new AstronomyDataError("simbad-response-too-large", "SIMBAD streamed response exceeds the byte limit", { maximum, received: total });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response.arrayBuffer !== "function") throw new AstronomyDataError("simbad-response-body-invalid");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximum) throw new AstronomyDataError("simbad-response-too-large", "SIMBAD response exceeds the byte limit", { maximum, received: bytes.length });
  return bytes;
}

function retryAfterMs(response, nowMs, maximum) {
  const raw = response.headers?.get?.("retry-after");
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  let delay;
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(text)) delay = Number(text) * 1000;
  else {
    const date = Date.parse(text);
    if (!Number.isFinite(date)) return null;
    delay = Math.max(0, date - nowMs);
  }
  return Math.min(maximum, Math.max(0, Math.ceil(delay)));
}

function validateClientOptions(options) {
  exactObject(options, ["fetchImpl", "clockMs", "sleep", "timeoutMs", "retries", "retryDelayMs", "rateIntervalMs", "maxRetryAfterMs", "maxResponseBytes", "userAgent"], "astronomy-client-options-invalid");
  if (options.fetchImpl !== undefined && typeof options.fetchImpl !== "function") throw new AstronomyDataError("astronomy-client-fetch-invalid");
  if (options.clockMs !== undefined && typeof options.clockMs !== "function") throw new AstronomyDataError("astronomy-client-clock-invalid");
  if (options.sleep !== undefined && typeof options.sleep !== "function") throw new AstronomyDataError("astronomy-client-sleep-invalid");
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_POLICY.timeoutMs : boundedInteger(options.timeoutMs, "timeout-ms", 250, 30000);
  const retries = options.retries === undefined ? DEFAULT_POLICY.retries : boundedInteger(options.retries, "retries", 0, 3);
  const retryDelayMs = options.retryDelayMs === undefined ? DEFAULT_POLICY.retryDelayMs : boundedInteger(options.retryDelayMs, "retry-delay-ms", 0, 5000);
  const rateIntervalMs = options.rateIntervalMs === undefined ? DEFAULT_POLICY.rateIntervalMs : boundedInteger(options.rateIntervalMs, "rate-interval-ms", 0, 10000);
  const maxRetryAfterMs = options.maxRetryAfterMs === undefined ? DEFAULT_POLICY.maxRetryAfterMs : boundedInteger(options.maxRetryAfterMs, "max-retry-after-ms", 0, DEFAULT_POLICY.maxRetryAfterMs);
  const maxResponseBytes = options.maxResponseBytes === undefined ? DEFAULT_POLICY.maxResponseBytes : boundedInteger(options.maxResponseBytes, "max-response-bytes", 1024, DEFAULT_POLICY.maxResponseBytes);
  const userAgent = options.userAgent === undefined ? DEFAULT_POLICY.userAgent : options.userAgent;
  if (typeof userAgent !== "string" || userAgent.length < 8 || userAgent.length > 256 || /[\r\n]/.test(userAgent)) throw new AstronomyDataError("astronomy-client-user-agent-invalid");
  return { timeoutMs, retries, retryDelayMs, rateIntervalMs, maxRetryAfterMs, maxResponseBytes, userAgent };
}

function createAstronomyClient(options = {}) {
  const policy = validateClientOptions(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new AstronomyDataError("astronomy-client-fetch-unavailable");
  const clockMs = options.clockMs ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastRequestStart = Number.NEGATIVE_INFINITY;
  let rateTail = Promise.resolve();

  async function waitForRateSlot() {
    let release;
    const previous = rateTail;
    rateTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const wait = Math.max(0, lastRequestStart + policy.rateIntervalMs - clockMs());
      if (wait > 0) await sleep(wait);
      lastRequestStart = clockMs();
    } finally {
      release();
    }
  }

  async function fetchOnce(built, attempt) {
    await waitForRateSlot();
    assertAllowedSimbadUrl(built.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      const response = await fetchImpl(built.url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: CONTENT_TYPE_ALLOWLIST[built.input.format].join(", "),
          "User-Agent": policy.userAgent,
        },
      });
      if (!response || typeof response.status !== "number") throw new AstronomyDataError("simbad-response-invalid");
      if (response.redirected) throw new AstronomyDataError("simbad-redirect-denied");
      if (response.url && assertAllowedSimbadUrl(response.url) !== built.url) throw new AstronomyDataError("simbad-redirect-denied");
      if (RETRYABLE_STATUS_CODES.includes(response.status) && attempt <= policy.retries) {
        try { await response.body?.cancel?.(); } catch { /* no response body is trusted */ }
        const declared = retryAfterMs(response, clockMs(), policy.maxRetryAfterMs);
        const fallback = Math.min(policy.maxRetryAfterMs, policy.retryDelayMs * (2 ** (attempt - 1)));
        await sleep(declared ?? fallback);
        return null;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new AstronomyDataError("simbad-http-error", `SIMBAD returned HTTP ${response.status}`, { status: response.status });
      }
      const actualContentType = validateContentType(response, built.input.format);
      const bytes = await readBoundedBody(response, policy.maxResponseBytes);
      return { response, bytes, actualContentType };
    } catch (error) {
      if (error instanceof AstronomyDataError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new AstronomyDataError("simbad-timeout", `SIMBAD request exceeded ${policy.timeoutMs} ms`, { timeoutMs: policy.timeoutMs }, error);
      }
      throw new AstronomyDataError("simbad-network-error", "SIMBAD request failed", null, error);
    } finally {
      clearTimeout(timer);
    }
  }

  async function search(input) {
    const built = buildSimbadUrl(input);
    let outcome = null;
    let attempts = 0;
    while (outcome === null) {
      attempts += 1;
      try {
        outcome = await fetchOnce(built, attempts);
      } catch (error) {
        const retryable = error instanceof AstronomyDataError && ["simbad-network-error", "simbad-timeout"].includes(error.code);
        if (!retryable || attempts > policy.retries) throw error;
        const delay = Math.min(policy.maxRetryAfterMs, policy.retryDelayMs * (2 ** (attempts - 1)));
        await sleep(delay);
      }
    }
    const normalized = normalizeSimbadResponse(outcome.bytes, { format: built.input.format });
    if (normalized.objectCount > built.input.limit) {
      throw new AstronomyDataError("simbad-response-query-limit-exceeded", "SIMBAD returned more objects than requested", { limit: built.input.limit, actual: normalized.objectCount });
    }
    const retrievedAt = new Date(clockMs()).toISOString();
    return {
      ...normalized,
      query: { ...built.input },
      provenance: {
        schema: PROVENANCE_SCHEMA,
        sourceAuthority: SOURCE_AUTHORITY,
        request: { method: "GET", url: built.url, requestSha256: built.requestSha256 },
        response: {
          status: outcome.response.status,
          contentType: outcome.actualContentType,
          byteLength: outcome.bytes.length,
          rawSha256: sha256(outcome.bytes),
          retrievedAt,
          freshUntil: new Date(clockMs() + DEFAULT_POLICY.maxSourceAgeMs).toISOString(),
          attempts,
        },
      },
    };
  }

  return Object.freeze({
    search,
    describeCapabilities: () => require("../capabilities.json"),
    policy: deepFreeze({ ...policy, contentTypes: CONTENT_TYPE_ALLOWLIST, retryableStatusCodes: RETRYABLE_STATUS_CODES }),
  });
}

const ASTROMETRIC_EXCLUSION_REASONS = deepFreeze([
  "parallax-missing",
  "parallax-nonpositive",
  "parallax-uncertainty-missing",
  "fractional-parallax-error-exceeds-threshold",
  "proper-motion-components-missing",
  "proper-motion-uncertainty-missing",
  "zero-proper-motion-delta-method-undefined",
  "fractional-proper-motion-error-exceeds-threshold",
]);

function requiredOwn(object, fields, code) {
  const missingFields = fields.filter((field) => !Object.hasOwn(object, field));
  if (missingFields.length) throw new AstronomyDataError(code, code, { missingFields });
}

function analysisText(value, field, maximum) {
  if (typeof value !== "string") throw new AstronomyDataError(`astronomy-kinematics-${field}-invalid`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AstronomyDataError(`astronomy-kinematics-${field}-invalid`);
  }
  return normalized;
}

function analysisNullableNumber(value, field, minimum, maximum, minimumExclusive = false) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)
    || (minimumExclusive ? value <= minimum : value < minimum) || value > maximum) {
    throw new AstronomyDataError(`astronomy-kinematics-${field}-invalid`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeProperMotionErrorEllipse(value, rowIndex) {
  if (value === null) return null;
  exactObject(value, ["majorMasYr", "minorMasYr", "angleDeg"], "astronomy-kinematics-error-ellipse-invalid");
  requiredOwn(value, ["majorMasYr", "minorMasYr", "angleDeg"], "astronomy-kinematics-error-ellipse-invalid");
  const majorMasYr = analysisNullableNumber(value.majorMasYr, `row-${rowIndex}-pm-error-major`, 0, 1_000_000);
  const minorMasYr = analysisNullableNumber(value.minorMasYr, `row-${rowIndex}-pm-error-minor`, 0, 1_000_000);
  const angleDeg = analysisNullableNumber(value.angleDeg, `row-${rowIndex}-pm-error-angle`, 0, 180);
  if (majorMasYr === null || minorMasYr === null || angleDeg === null || angleDeg >= 180) {
    throw new AstronomyDataError("astronomy-kinematics-error-ellipse-invalid", "Proper-motion error ellipse values must be finite and angleDeg must be in [0, 180)", { rowIndex });
  }
  return { majorMasYr, minorMasYr, angleDeg };
}

function normalizeAstrometricKinematicsInput(input) {
  exactObject(input, ["sourceContentSha256", "measurements", "maxFractionalParallaxError", "maxFractionalProperMotionError"], "astronomy-kinematics-input-invalid");
  requiredOwn(input, ["sourceContentSha256", "measurements"], "astronomy-kinematics-input-invalid");
  if (typeof input.sourceContentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceContentSha256)) {
    throw new AstronomyDataError("astronomy-kinematics-source-hash-invalid");
  }
  if (!Array.isArray(input.measurements) || input.measurements.length < 1 || input.measurements.length > DEFAULT_POLICY.maxObjects) {
    throw new AstronomyDataError("astronomy-kinematics-measurements-invalid", "measurements must contain 1 through 500 rows");
  }
  const maxFractionalParallaxError = input.maxFractionalParallaxError === undefined
    ? 0.2
    : analysisNullableNumber(input.maxFractionalParallaxError, "max-fractional-parallax-error", 0.01, 0.5);
  const maxFractionalProperMotionError = input.maxFractionalProperMotionError === undefined
    ? 0.2
    : analysisNullableNumber(input.maxFractionalProperMotionError, "max-fractional-proper-motion-error", 0.01, 0.5);
  if (maxFractionalParallaxError === null || maxFractionalProperMotionError === null) {
    throw new AstronomyDataError("astronomy-kinematics-threshold-invalid");
  }

  const seenIds = new Set();
  const measurements = input.measurements.map((row, rowIndex) => {
    exactObject(row, [
      "stableObjectId", "mainId", "parallaxMas", "parallaxErrorMas", "properMotionRaMasYr",
      "properMotionDecMasYr", "properMotionErrorEllipse",
    ], "astronomy-kinematics-measurement-invalid");
    requiredOwn(row, [
      "stableObjectId", "mainId", "parallaxMas", "parallaxErrorMas", "properMotionRaMasYr",
      "properMotionDecMasYr", "properMotionErrorEllipse",
    ], "astronomy-kinematics-measurement-invalid");
    const stableObjectIdValue = analysisText(row.stableObjectId, `row-${rowIndex}-stable-object-id`, 160);
    const mainId = analysisText(row.mainId, `row-${rowIndex}-main-id`, 500);
    if (seenIds.has(stableObjectIdValue)) {
      throw new AstronomyDataError("astronomy-kinematics-duplicate-object-id", "stableObjectId values must be unique", { rowIndex, stableObjectId: stableObjectIdValue });
    }
    seenIds.add(stableObjectIdValue);
    if (stableObjectIdValue.startsWith("simbad:") && stableObjectIdValue !== stableObjectId(mainId)) {
      throw new AstronomyDataError("astronomy-kinematics-simbad-object-id-invalid", "SIMBAD stableObjectId does not match mainId", { rowIndex });
    }
    const parallaxMas = analysisNullableNumber(row.parallaxMas, `row-${rowIndex}-parallax`, -1_000_000, 1_000_000);
    const parallaxErrorMas = analysisNullableNumber(row.parallaxErrorMas, `row-${rowIndex}-parallax-error`, 0, 1_000_000, true);
    const properMotionRaMasYr = analysisNullableNumber(row.properMotionRaMasYr, `row-${rowIndex}-pm-ra`, -10_000_000, 10_000_000);
    const properMotionDecMasYr = analysisNullableNumber(row.properMotionDecMasYr, `row-${rowIndex}-pm-dec`, -10_000_000, 10_000_000);
    const properMotionErrorEllipse = normalizeProperMotionErrorEllipse(row.properMotionErrorEllipse, rowIndex);
    if (parallaxMas === null && parallaxErrorMas !== null) {
      throw new AstronomyDataError("astronomy-kinematics-orphan-parallax-error", "A parallax uncertainty requires a parallax measurement", { rowIndex });
    }
    if ((properMotionRaMasYr === null || properMotionDecMasYr === null) && properMotionErrorEllipse !== null) {
      throw new AstronomyDataError("astronomy-kinematics-orphan-proper-motion-error", "A proper-motion error ellipse requires both proper-motion components", { rowIndex });
    }
    return {
      stableObjectId: stableObjectIdValue,
      mainId,
      parallaxMas,
      parallaxErrorMas,
      properMotionRaMasYr,
      properMotionDecMasYr,
      properMotionErrorEllipse,
    };
  }).sort((left, right) => left.stableObjectId === right.stableObjectId
    ? (left.mainId < right.mainId ? -1 : left.mainId > right.mainId ? 1 : 0)
    : (left.stableObjectId < right.stableObjectId ? -1 : 1));

  return {
    sourceContentSha256: input.sourceContentSha256,
    maxFractionalParallaxError,
    maxFractionalProperMotionError,
    measurements,
  };
}

function ellipseCovariance(ellipse) {
  const angleRad = ellipse.angleDeg * Math.PI / 180;
  const sin = Math.sin(angleRad);
  const cos = Math.cos(angleRad);
  const majorVariance = ellipse.majorMasYr ** 2;
  const minorVariance = ellipse.minorMasYr ** 2;
  return {
    varianceRa: sin ** 2 * majorVariance + cos ** 2 * minorVariance,
    varianceDec: cos ** 2 * majorVariance + sin ** 2 * minorVariance,
    covarianceRaDec: (majorVariance - minorVariance) * cos * sin,
  };
}

function safeVariance(value, scale, code) {
  const tolerance = Math.max(1, scale) * Number.EPSILON * 64;
  if (value < -tolerance) throw new AstronomyDataError(code, code, { value, tolerance });
  return Math.max(0, value);
}

function confidenceInterval95(estimate, standardError) {
  if (estimate === null || standardError === null) return null;
  const delta = ASTROMETRIC_KINEMATICS_ALGORITHM.normalCriticalValue95 * standardError;
  return { lower: estimate - delta, upper: estimate + delta };
}

function deriveAstrometricKinematicsRow(measurement, thresholds) {
  const reasons = [];
  const hasProperMotion = measurement.properMotionRaMasYr !== null && measurement.properMotionDecMasYr !== null;
  const properMotionTotalMasYr = hasProperMotion
    ? Math.hypot(measurement.properMotionRaMasYr, measurement.properMotionDecMasYr)
    : null;
  let properMotionTotalErrorMasYr = null;
  let errorEllipseCovariance = null;
  if (hasProperMotion && measurement.properMotionErrorEllipse !== null) {
    errorEllipseCovariance = ellipseCovariance(measurement.properMotionErrorEllipse);
    if (properMotionTotalMasYr > 0) {
      const gradientRa = measurement.properMotionRaMasYr / properMotionTotalMasYr;
      const gradientDec = measurement.properMotionDecMasYr / properMotionTotalMasYr;
      const variance = gradientRa ** 2 * errorEllipseCovariance.varianceRa
        + gradientDec ** 2 * errorEllipseCovariance.varianceDec
        + 2 * gradientRa * gradientDec * errorEllipseCovariance.covarianceRaDec;
      const scale = errorEllipseCovariance.varianceRa + errorEllipseCovariance.varianceDec;
      properMotionTotalErrorMasYr = Math.sqrt(safeVariance(variance, scale, "astronomy-kinematics-proper-motion-variance-invalid"));
    }
  }

  const parallaxSignalToNoise = measurement.parallaxMas !== null && measurement.parallaxErrorMas !== null
    ? measurement.parallaxMas / measurement.parallaxErrorMas
    : null;
  const fractionalParallaxError = measurement.parallaxMas !== null && measurement.parallaxMas > 0 && measurement.parallaxErrorMas !== null
    ? measurement.parallaxErrorMas / measurement.parallaxMas
    : null;
  const fractionalProperMotionError = properMotionTotalMasYr !== null && properMotionTotalMasYr > 0 && properMotionTotalErrorMasYr !== null
    ? properMotionTotalErrorMasYr / properMotionTotalMasYr
    : null;
  const distancePc = measurement.parallaxMas !== null && measurement.parallaxMas > 0
    ? 1000 / measurement.parallaxMas
    : null;
  const distanceStandardErrorPc = distancePc !== null && measurement.parallaxErrorMas !== null
    ? 1000 * measurement.parallaxErrorMas / (measurement.parallaxMas ** 2)
    : null;
  const transverseVelocityKmS = distancePc !== null && properMotionTotalMasYr !== null
    ? ASTROMETRIC_KINEMATICS_ALGORITHM.transverseVelocityConstantKmS * properMotionTotalMasYr / measurement.parallaxMas
    : null;
  let transverseVelocityStandardErrorKmS = null;
  if (transverseVelocityKmS !== null && properMotionTotalErrorMasYr !== null && measurement.parallaxErrorMas !== null) {
    const factor = ASTROMETRIC_KINEMATICS_ALGORITHM.transverseVelocityConstantKmS;
    const varianceFromProperMotion = (factor / measurement.parallaxMas) ** 2 * properMotionTotalErrorMasYr ** 2;
    const varianceFromParallax = (factor * properMotionTotalMasYr / (measurement.parallaxMas ** 2)) ** 2 * measurement.parallaxErrorMas ** 2;
    transverseVelocityStandardErrorKmS = Math.sqrt(safeVariance(
      varianceFromProperMotion + varianceFromParallax,
      varianceFromProperMotion + varianceFromParallax,
      "astronomy-kinematics-transverse-velocity-variance-invalid",
    ));
  }

  if (measurement.parallaxMas === null) reasons.push("parallax-missing");
  else if (measurement.parallaxMas <= 0) reasons.push("parallax-nonpositive");
  else if (measurement.parallaxErrorMas === null) reasons.push("parallax-uncertainty-missing");
  else if (fractionalParallaxError > thresholds.maxFractionalParallaxError) reasons.push("fractional-parallax-error-exceeds-threshold");
  if (!hasProperMotion) reasons.push("proper-motion-components-missing");
  else if (measurement.properMotionErrorEllipse === null) reasons.push("proper-motion-uncertainty-missing");
  else if (properMotionTotalMasYr === 0) reasons.push("zero-proper-motion-delta-method-undefined");
  else if (fractionalProperMotionError > thresholds.maxFractionalProperMotionError) reasons.push("fractional-proper-motion-error-exceeds-threshold");

  return {
    stableObjectId: measurement.stableObjectId,
    mainId: measurement.mainId,
    measurements: {
      parallaxMas: measurement.parallaxMas,
      parallaxErrorMas: measurement.parallaxErrorMas,
      properMotionRaMasYr: measurement.properMotionRaMasYr,
      properMotionDecMasYr: measurement.properMotionDecMasYr,
      properMotionErrorEllipse: measurement.properMotionErrorEllipse,
    },
    derived: {
      properMotionTotalMasYr,
      properMotionTotalErrorMasYr,
      properMotionErrorCovariance: errorEllipseCovariance,
      parallaxSignalToNoise,
      fractionalParallaxError,
      fractionalProperMotionError,
      distancePc,
      distanceStandardErrorPc,
      distanceCi95Pc: confidenceInterval95(distancePc, distanceStandardErrorPc),
      transverseVelocityKmS,
      transverseVelocityStandardErrorKmS,
      transverseVelocityCi95KmS: confidenceInterval95(transverseVelocityKmS, transverseVelocityStandardErrorKmS),
    },
    inferenceEligible: reasons.length === 0,
    exclusionReasons: reasons,
  };
}

function publicationTable(rows) {
  return {
    schema: "agentlas.astronomy.publication-table/v1",
    title: "Astrometric distance and transverse velocity estimates",
    missingValueToken: "—",
    columns: [
      { key: "mainId", label: "Object", unit: null, datatype: "string" },
      { key: "parallaxMas", label: "Parallax", unit: "mas", datatype: "number|null" },
      { key: "parallaxErrorMas", label: "Parallax s.e.", unit: "mas", datatype: "number|null" },
      { key: "properMotionTotalMasYr", label: "Total proper motion", unit: "mas/yr", datatype: "number|null" },
      { key: "properMotionTotalErrorMasYr", label: "Proper-motion s.e.", unit: "mas/yr", datatype: "number|null" },
      { key: "parallaxSignalToNoise", label: "Parallax S/N", unit: null, datatype: "number|null" },
      { key: "fractionalParallaxError", label: "Fractional parallax error", unit: null, datatype: "number|null" },
      { key: "fractionalProperMotionError", label: "Fractional proper-motion error", unit: null, datatype: "number|null" },
      { key: "distancePc", label: "Inverse-parallax distance", unit: "pc", datatype: "number|null" },
      { key: "distanceStandardErrorPc", label: "Distance s.e.", unit: "pc", datatype: "number|null" },
      { key: "distanceCi95Pc", label: "Distance 95% interval", unit: "pc", datatype: "interval|null" },
      { key: "transverseVelocityKmS", label: "Transverse velocity", unit: "km/s", datatype: "number|null" },
      { key: "transverseVelocityStandardErrorKmS", label: "Velocity s.e.", unit: "km/s", datatype: "number|null" },
      { key: "transverseVelocityCi95KmS", label: "Velocity 95% interval", unit: "km/s", datatype: "interval|null" },
      { key: "inferenceEligible", label: "Inference eligible", unit: null, datatype: "boolean" },
      { key: "exclusionReasons", label: "Exclusion reasons", unit: null, datatype: "string[]" },
    ],
    rows: rows.map((row) => ({
      stableObjectId: row.stableObjectId,
      mainId: row.mainId,
      parallaxMas: row.measurements.parallaxMas,
      parallaxErrorMas: row.measurements.parallaxErrorMas,
      properMotionTotalMasYr: row.derived.properMotionTotalMasYr,
      properMotionTotalErrorMasYr: row.derived.properMotionTotalErrorMasYr,
      parallaxSignalToNoise: row.derived.parallaxSignalToNoise,
      fractionalParallaxError: row.derived.fractionalParallaxError,
      fractionalProperMotionError: row.derived.fractionalProperMotionError,
      distancePc: row.derived.distancePc,
      distanceStandardErrorPc: row.derived.distanceStandardErrorPc,
      distanceCi95Pc: row.derived.distanceCi95Pc,
      transverseVelocityKmS: row.derived.transverseVelocityKmS,
      transverseVelocityStandardErrorKmS: row.derived.transverseVelocityStandardErrorKmS,
      transverseVelocityCi95KmS: row.derived.transverseVelocityCi95KmS,
      inferenceEligible: row.inferenceEligible,
      exclusionReasons: row.exclusionReasons,
    })),
    notes: [
      "Distances are naive inverse-parallax point estimates; rows failing the declared fractional-error thresholds are not inference eligible.",
      "Standard errors and 95% intervals use first-order delta propagation and assume zero covariance between parallax and proper motion.",
      "Proper-motion component covariance is reconstructed from the supplied SIMBAD-style error ellipse using its position angle.",
      "Missing measurements and uncertainties remain null and are rendered with the declared missing-value token.",
    ],
  };
}

function publicationFigure(rows, provenance) {
  const values = rows.filter((row) => row.inferenceEligible).map((row) => ({
    stableObjectId: row.stableObjectId,
    mainId: row.mainId,
    distancePc: row.derived.distancePc,
    distanceCiLowerPc: row.derived.distanceCi95Pc.lower,
    distanceCiUpperPc: row.derived.distanceCi95Pc.upper,
    transverseVelocityKmS: row.derived.transverseVelocityKmS,
    velocityCiLowerKmS: row.derived.transverseVelocityCi95KmS.lower,
    velocityCiUpperKmS: row.derived.transverseVelocityCi95KmS.upper,
  }));
  return {
    schema: "agentlas.astronomy.publication-figure/v1",
    rendererId: "vega-lite",
    rendererRequirement: ">=5.0.0 <7.0.0",
    title: "Distance and transverse velocity with propagated 95% intervals",
    altText: `${values.length} inference-eligible astronomical objects plotted by inverse-parallax distance and transverse velocity, with horizontal and vertical 95% uncertainty intervals.`,
    exportRecommendation: { widthMm: 85, dpi: 600, colorSpace: "sRGB" },
    spec: {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      description: "Astrometric distance versus transverse velocity with propagated 95% intervals.",
      width: 480,
      height: 320,
      data: { values },
      layer: [
        {
          mark: { type: "rule", strokeWidth: 1, color: "#6B7280" },
          encoding: {
            x: { field: "distanceCiLowerPc", type: "quantitative", title: "Inverse-parallax distance (pc)" },
            x2: { field: "distanceCiUpperPc" },
            y: { field: "transverseVelocityKmS", type: "quantitative", title: "Transverse velocity (km/s)" },
          },
        },
        {
          mark: { type: "rule", strokeWidth: 1, color: "#6B7280" },
          encoding: {
            x: { field: "distancePc", type: "quantitative", title: "Inverse-parallax distance (pc)" },
            y: { field: "velocityCiLowerKmS", type: "quantitative", title: "Transverse velocity (km/s)" },
            y2: { field: "velocityCiUpperKmS" },
          },
        },
        {
          mark: { type: "point", filled: true, size: 64, color: "#255C99", stroke: "#FFFFFF", strokeWidth: 0.75 },
          encoding: {
            x: { field: "distancePc", type: "quantitative", title: "Inverse-parallax distance (pc)" },
            y: { field: "transverseVelocityKmS", type: "quantitative", title: "Transverse velocity (km/s)" },
            tooltip: [
              { field: "mainId", type: "nominal", title: "Object" },
              { field: "distancePc", type: "quantitative", title: "Distance (pc)", format: ".4g" },
              { field: "transverseVelocityKmS", type: "quantitative", title: "vₜ (km/s)", format: ".4g" },
            ],
          },
        },
      ],
      config: {
        background: "#FFFFFF",
        axis: { labelColor: "#1F2937", titleColor: "#111827", gridColor: "#E5E7EB", domainColor: "#6B7280" },
        view: { stroke: null },
      },
      usermeta: provenance,
    },
  };
}

function analyzeAstrometricKinematics(input) {
  const normalizedInput = normalizeAstrometricKinematicsInput(input);
  const thresholds = {
    maxFractionalParallaxError: normalizedInput.maxFractionalParallaxError,
    maxFractionalProperMotionError: normalizedInput.maxFractionalProperMotionError,
  };
  const rows = normalizedInput.measurements.map((measurement) => deriveAstrometricKinematicsRow(measurement, thresholds));
  const summary = {
    inputRows: rows.length,
    rowsWithDistancePointEstimate: rows.filter((row) => row.derived.distancePc !== null).length,
    rowsWithTransverseVelocityPointEstimate: rows.filter((row) => row.derived.transverseVelocityKmS !== null).length,
    inferenceEligibleRows: rows.filter((row) => row.inferenceEligible).length,
    excludedRows: rows.filter((row) => !row.inferenceEligible).length,
    exclusionCounts: Object.fromEntries(ASTROMETRIC_EXCLUSION_REASONS.map((reason) => [reason, rows.filter((row) => row.exclusionReasons.includes(reason)).length])),
  };
  const inputSha256 = sha256(canonicalJson(normalizedInput));
  const algorithmSha256 = sha256(canonicalJson(ASTROMETRIC_KINEMATICS_ALGORITHM));
  const table = publicationTable(rows);
  const tableSha256 = sha256(canonicalJson(table));
  const figureProvenance = {
    schema: "agentlas.astronomy.figure-provenance/v1",
    sourceContentSha256: normalizedInput.sourceContentSha256,
    inputSha256,
    algorithmSha256,
    tableSha256,
  };
  const figure = publicationFigure(rows, figureProvenance);
  const figureSha256 = sha256(canonicalJson(figure));
  const core = {
    schema: ASTROMETRIC_KINEMATICS_SCHEMA,
    algorithm: ASTROMETRIC_KINEMATICS_ALGORITHM,
    thresholds,
    rows,
    summary,
    publication: { table, figure },
  };
  const resultSha256 = sha256(canonicalJson(core));
  return {
    ...core,
    provenance: {
      schema: "agentlas.astronomy.analysis-provenance/v1",
      pluginId: PLUGIN_ID,
      pluginVersion: PLUGIN_VERSION,
      sourceContentSha256: normalizedInput.sourceContentSha256,
      inputSha256,
      algorithmSha256,
      tableSha256,
      figureSha256,
      resultSha256,
    },
  };
}

const LIGHT_CURVE_TIME_SYSTEMS = deepFreeze(["BJD_TDB", "BJD_UTC", "HJD_UTC", "JD_UTC", "MJD_UTC", "relative-day"]);
const LIGHT_CURVE_VALUE_KINDS = deepFreeze(["magnitude", "flux", "relative-flux", "generic"]);
const LIGHT_CURVE_WEIGHTING_MODES = deepFreeze(["auto", "weighted", "unweighted"]);
const LIGHT_CURVE_EXCLUSION_REASONS = deepFreeze([
  "user-excluded",
  "time-missing",
  "value-missing",
  "uncertainty-missing-for-weighted-fit",
]);

function periodogramText(value, field, maximum) {
  if (typeof value !== "string") throw new AstronomyDataError(`astronomy-periodogram-${field}-invalid`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AstronomyDataError(`astronomy-periodogram-${field}-invalid`);
  }
  return normalized;
}

function periodogramNullableNumber(value, field, minimum, maximum, minimumExclusive = false) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)
    || (minimumExclusive ? value <= minimum : value < minimum) || value > maximum) {
    throw new AstronomyDataError(`astronomy-periodogram-${field}-invalid`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function periodogramNumber(value, field, minimum, maximum, minimumExclusive = false) {
  const normalized = periodogramNullableNumber(value, field, minimum, maximum, minimumExclusive);
  if (normalized === null) throw new AstronomyDataError(`astronomy-periodogram-${field}-invalid`);
  return normalized;
}

function normalizeLombScargleInput(input) {
  exactObject(input, [
    "sourceContentSha256", "targetId", "timeSystem", "timeOffsetDays", "valueKind", "valueUnit", "weighting",
    "minimumPeriodDays", "maximumPeriodDays", "frequencyCount", "maximumPeaks", "measurements",
  ], "astronomy-periodogram-input-invalid");
  requiredOwn(input, [
    "sourceContentSha256", "targetId", "timeSystem", "timeOffsetDays", "valueKind", "valueUnit", "weighting",
    "minimumPeriodDays", "maximumPeriodDays", "frequencyCount", "measurements",
  ], "astronomy-periodogram-input-invalid");
  if (typeof input.sourceContentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceContentSha256)) {
    throw new AstronomyDataError("astronomy-periodogram-source-hash-invalid");
  }
  const targetId = periodogramText(input.targetId, "target-id", 500);
  if (!LIGHT_CURVE_TIME_SYSTEMS.includes(input.timeSystem)) throw new AstronomyDataError("astronomy-periodogram-time-system-invalid");
  const timeOffsetDays = periodogramNumber(input.timeOffsetDays, "time-offset-days", -1_000_000_000, 1_000_000_000);
  if (!LIGHT_CURVE_VALUE_KINDS.includes(input.valueKind)) throw new AstronomyDataError("astronomy-periodogram-value-kind-invalid");
  const valueUnit = input.valueUnit === null ? null : periodogramText(input.valueUnit, "value-unit", 80);
  if (!LIGHT_CURVE_WEIGHTING_MODES.includes(input.weighting)) throw new AstronomyDataError("astronomy-periodogram-weighting-invalid");
  const minimumPeriodDays = periodogramNumber(input.minimumPeriodDays, "minimum-period-days", 1e-9, 1_000_000_000, true);
  const maximumPeriodDays = periodogramNumber(input.maximumPeriodDays, "maximum-period-days", 1e-9, 1_000_000_000, true);
  if (maximumPeriodDays <= minimumPeriodDays || maximumPeriodDays / minimumPeriodDays > LOMB_SCARGLE_LIMITS.maxPeriodRatio) {
    throw new AstronomyDataError("astronomy-periodogram-period-range-invalid");
  }
  if (!Number.isSafeInteger(input.frequencyCount)
    || input.frequencyCount < LOMB_SCARGLE_LIMITS.minFrequencyCount
    || input.frequencyCount > LOMB_SCARGLE_LIMITS.maxFrequencyCount) {
    throw new AstronomyDataError("astronomy-periodogram-frequency-count-invalid");
  }
  const maximumPeaks = input.maximumPeaks === undefined ? 5 : input.maximumPeaks;
  if (!Number.isSafeInteger(maximumPeaks) || maximumPeaks < LOMB_SCARGLE_LIMITS.minPeaks || maximumPeaks > LOMB_SCARGLE_LIMITS.maxPeaks) {
    throw new AstronomyDataError("astronomy-periodogram-maximum-peaks-invalid");
  }
  if (!Array.isArray(input.measurements)
    || input.measurements.length < LOMB_SCARGLE_LIMITS.minMeasurements
    || input.measurements.length > LOMB_SCARGLE_LIMITS.maxMeasurements) {
    throw new AstronomyDataError("astronomy-periodogram-measurements-invalid", `measurements must contain ${LOMB_SCARGLE_LIMITS.minMeasurements} through ${LOMB_SCARGLE_LIMITS.maxMeasurements} rows`);
  }
  const seenIds = new Set();
  const measurements = input.measurements.map((row, rowIndex) => {
    exactObject(row, ["observationId", "time", "value", "standardError", "use"], "astronomy-periodogram-measurement-invalid");
    requiredOwn(row, ["observationId", "time", "value", "standardError", "use"], "astronomy-periodogram-measurement-invalid");
    const observationId = periodogramText(row.observationId, `row-${rowIndex}-observation-id`, 160);
    if (seenIds.has(observationId)) {
      throw new AstronomyDataError("astronomy-periodogram-duplicate-observation-id", "observationId values must be unique", { rowIndex, observationId });
    }
    seenIds.add(observationId);
    const time = periodogramNullableNumber(row.time, `row-${rowIndex}-time`, -1_000_000_000, 1_000_000_000);
    if (time !== null && !Number.isFinite(time + timeOffsetDays)) throw new AstronomyDataError("astronomy-periodogram-absolute-time-invalid", "time plus timeOffsetDays must be finite", { rowIndex });
    const value = periodogramNullableNumber(row.value, `row-${rowIndex}-value`, -1e15, 1e15);
    const standardError = periodogramNullableNumber(row.standardError, `row-${rowIndex}-standard-error`, 1e-12, 1e15, true);
    if (typeof row.use !== "boolean") throw new AstronomyDataError("astronomy-periodogram-use-invalid", "use must be boolean", { rowIndex });
    return { observationId, time, value, standardError, use: row.use };
  }).sort((left, right) => {
    if (left.time === null && right.time !== null) return 1;
    if (left.time !== null && right.time === null) return -1;
    if (left.time !== null && right.time !== null && left.time !== right.time) return left.time - right.time;
    return left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0;
  });
  return {
    sourceContentSha256: input.sourceContentSha256,
    targetId,
    timeSystem: input.timeSystem,
    timeOffsetDays,
    valueKind: input.valueKind,
    valueUnit,
    weighting: input.weighting,
    minimumPeriodDays,
    maximumPeriodDays,
    frequencyCount: input.frequencyCount,
    maximumPeaks,
    measurements,
  };
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function solveThreeByThree(matrix, vector) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  const scale = Math.max(1, ...augmented.flat().map(Math.abs));
  const tolerance = scale * Number.EPSILON * 1024;
  for (let column = 0; column < 3; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) pivotRow = row;
    }
    if (Math.abs(augmented[pivotRow][column]) <= tolerance) return null;
    if (pivotRow !== column) [augmented[pivotRow], augmented[column]] = [augmented[column], augmented[pivotRow]];
    const pivot = augmented[column][column];
    for (let item = column; item < 4; item += 1) augmented[column][item] /= pivot;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let item = column; item < 4; item += 1) augmented[row][item] -= factor * augmented[column][item];
    }
  }
  const solution = augmented.map((row) => row[3]);
  return solution.every(Number.isFinite) ? solution : null;
}

function sinusoidFit(points, frequencyPerDay, timeOrigin) {
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const vector = [0, 0, 0];
  const angularFrequency = 2 * Math.PI * frequencyPerDay;
  for (const point of points) {
    const cosine = Math.cos(angularFrequency * (point.time - timeOrigin));
    const sine = Math.sin(angularFrequency * (point.time - timeOrigin));
    const basis = [1, cosine, sine];
    for (let row = 0; row < 3; row += 1) {
      vector[row] += point.weight * basis[row] * point.value;
      for (let column = 0; column < 3; column += 1) matrix[row][column] += point.weight * basis[row] * basis[column];
    }
  }
  const coefficients = solveThreeByThree(matrix, vector);
  if (!coefficients) return null;
  let residualSum = 0;
  for (const point of points) {
    const angle = angularFrequency * (point.time - timeOrigin);
    const fitted = coefficients[0] + coefficients[1] * Math.cos(angle) + coefficients[2] * Math.sin(angle);
    residualSum += point.weight * (point.value - fitted) ** 2;
  }
  return { offset: coefficients[0], cosineCoefficient: coefficients[1], sineCoefficient: coefficients[2], residualSum: Math.max(0, residualSum) };
}

function samplingWindowPower(points, frequencyPerDay, timeOrigin) {
  let real = 0;
  let imaginary = 0;
  for (const point of points) {
    const angle = 2 * Math.PI * frequencyPerDay * (point.time - timeOrigin);
    real += point.weight * Math.cos(angle);
    imaginary += point.weight * Math.sin(angle);
  }
  return Math.min(1, Math.max(0, real ** 2 + imaginary ** 2));
}

function unitPhase(value) {
  const remainder = value % 1;
  return remainder < 0 ? remainder + 1 : remainder;
}

function lightCurveObservationTable(rows, metadata) {
  return {
    schema: "agentlas.astronomy.light-curve-observation-table/v1",
    title: `${metadata.targetId} light-curve observations and fitted residuals`,
    columns: [
      { key: "observationId", label: "Observation ID", datatype: "string", unit: null },
      { key: "time", label: `Time (${metadata.timeSystem}; offset ${metadata.timeOffsetDays})`, datatype: "number|null", unit: "day" },
      { key: "value", label: "Observed value", datatype: "number|null", unit: metadata.valueUnit },
      { key: "standardError", label: "Standard error", datatype: "number|null", unit: metadata.valueUnit },
      { key: "analysisEligible", label: "Analysis eligible", datatype: "boolean", unit: null },
      { key: "exclusionReasons", label: "Exclusion reasons", datatype: "string[]", unit: null },
      { key: "phase", label: "Best-period phase", datatype: "number|null", unit: "cycle" },
      { key: "fittedValue", label: "Best-fit sinusoid", datatype: "number|null", unit: metadata.valueUnit },
      { key: "residual", label: "Residual", datatype: "number|null", unit: metadata.valueUnit },
    ],
    rows,
    missingValueToken: "NA",
    notes: [
      "Every input observation is retained; missing and user-excluded rows are not imputed.",
      `Resolved weighting mode: ${metadata.resolvedWeighting}.`,
      "Phase, fitted value, and residual are model-derived quantities, not measurements.",
    ],
  };
}

function lightCurvePeakTable(peaks, metadata) {
  return {
    schema: "agentlas.astronomy.lomb-scargle-peak-table/v1",
    title: `${metadata.targetId} generalized Lomb-Scargle local grid peaks`,
    columns: [
      { key: "rank", label: "Rank", datatype: "integer", unit: null },
      { key: "periodDays", label: "Grid period", datatype: "number", unit: "day" },
      { key: "frequencyPerDay", label: "Frequency", datatype: "number", unit: "1/day" },
      { key: "power", label: "Standard GLS power", datatype: "number", unit: null },
      { key: "windowPower", label: "Sampling-window power", datatype: "number", unit: null },
      { key: "amplitude", label: "Sinusoid amplitude", datatype: "number", unit: metadata.valueUnit },
    ],
    rows: peaks,
    notes: [
      "Peaks are local maxima on the declared finite grid and are not independent detections.",
      "The result includes a Baluev analytic false-alarm upper bound and a Montgomery-O'Donoghue period standard-error estimate when numerically resolvable; neither is a calibrated detection probability or confidence interval.",
      "A returned false-alarm probability of 0 is a numerical floor, not exact certainty.",
    ],
  };
}

function lightCurvePeriodogramTable(periodogram, metadata) {
  return {
    schema: "agentlas.astronomy.lomb-scargle-periodogram-table/v1",
    title: `${metadata.targetId} generalized Lomb-Scargle grid`,
    columns: [
      { key: "gridIndex", label: "Grid index", datatype: "integer", unit: null },
      { key: "frequencyPerDay", label: "Frequency", datatype: "number", unit: "1/day" },
      { key: "periodDays", label: "Period", datatype: "number", unit: "day" },
      { key: "power", label: "Standard GLS power", datatype: "number|null", unit: null },
      { key: "windowPower", label: "Sampling-window power", datatype: "number", unit: null },
    ],
    rows: periodogram,
    notes: [
      "The frequency grid is linear, inclusive, and exactly bounded by the requested minimum and maximum periods.",
      "Null power identifies a singular sinusoid design at that exact grid frequency.",
    ],
  };
}

/**
 * The scale for an axis that carries a measurement rather than a count.
 *
 * Vega-Lite anchors a quantitative scale at zero by default. That is right for a count and wrong
 * for a measurement: a radial velocity near -21.5 km/s, a magnitude near 12, a normalized flux near
 * 1.0 all collapse to a flat line once the axis is padded down to zero, and the figure stops
 * showing the one thing it exists to show. Measured on the rendered panels, the folded transit
 * filled 5% of its own height and the Keplerian orbit 4% -- the discovery and the fit were both
 * invisible while every number in the table was correct.
 *
 * `magnitude` additionally runs brighter-upward, which is a display convention and not a scale
 * choice, so it travels with the same helper rather than being remembered separately at each site.
 */
function measurementScale(valueKind, extra) {
  return { zero: false, nice: true, ...(valueKind === "magnitude" ? { reverse: true } : {}), ...(extra ?? {}) };
}

function lightCurvePublicationFigure(periodogram, foldedRows, modelRows, bestPeak, metadata, provenance) {
  const valueTitle = metadata.valueUnit ? `Observed value (${metadata.valueUnit})` : "Observed value";
  const yScale = measurementScale(metadata.valueKind);
  return {
    schema: "agentlas.astronomy.light-curve-publication-figure/v1",
    rendererId: "vega-lite",
    rendererRequirement: ">=5.0.0 <7.0.0",
    title: `${metadata.targetId}: generalized Lomb-Scargle periodogram and folded light curve`,
    altText: `Two-panel figure for ${metadata.targetId}. The upper panel shows generalized Lomb-Scargle power and sampling-window power over ${periodogram.length} frequencies. The lower panel folds ${foldedRows.length} observations at the strongest grid period of ${bestPeak.periodDays} days.`,
    exportRecommendation: { widthMm: 178, dpi: 600, colorSpace: "sRGB" },
    spec: {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      description: "Generalized Lomb-Scargle periodogram with sampling window and best-period folded observations.",
      vconcat: [
        {
          width: 720,
          height: 260,
          layer: [
            {
              data: { values: periodogram.filter((row) => row.power !== null) },
              mark: { type: "line", color: "#255C99", strokeWidth: 1.8, clip: true },
              encoding: {
                x: { field: "periodDays", type: "quantitative", title: "Trial period (day)", scale: { type: "log" } },
                y: { field: "power", type: "quantitative", title: "Standard GLS power", scale: { domain: [0, 1] } },
                tooltip: [
                  { field: "periodDays", type: "quantitative", title: "Period (day)", format: ".8g" },
                  { field: "frequencyPerDay", type: "quantitative", title: "Frequency (1/day)", format: ".8g" },
                  { field: "power", type: "quantitative", title: "GLS power", format: ".6f" },
                ],
              },
            },
            {
              data: { values: periodogram },
              mark: { type: "line", color: "#9CA3AF", strokeDash: [5, 4], strokeWidth: 1.2, opacity: 0.8, clip: true },
              encoding: {
                x: { field: "periodDays", type: "quantitative", title: "Trial period (day)", scale: { type: "log" } },
                y: { field: "windowPower", type: "quantitative", title: "Standard GLS power", scale: { domain: [0, 1] } },
              },
            },
            {
              data: { values: [{ periodDays: bestPeak.periodDays }] },
              mark: { type: "rule", color: "#C2415D", strokeWidth: 1.5 },
              encoding: { x: { field: "periodDays", type: "quantitative", scale: { type: "log" } } },
            },
          ],
        },
        {
          width: 720,
          height: 260,
          layer: [
            {
              data: { values: modelRows },
              mark: { type: "line", color: "#C2415D", strokeWidth: 1.8 },
              encoding: {
                x: { field: "phase", type: "quantitative", title: `Phase at ${Number(bestPeak.periodDays.toPrecision(6))} day grid period`, scale: { domain: [0, 1] } },
                y: { field: "fittedValue", type: "quantitative", title: valueTitle, scale: yScale },
              },
            },
            {
              data: { values: foldedRows.filter((row) => row.errorLower !== null) },
              mark: { type: "rule", color: "#6B7280", strokeWidth: 1 },
              encoding: {
                x: { field: "phase", type: "quantitative", title: `Phase at ${Number(bestPeak.periodDays.toPrecision(6))} day grid period`, scale: { domain: [0, 1] } },
                y: { field: "errorLower", type: "quantitative", title: valueTitle, scale: yScale },
                y2: { field: "errorUpper" },
              },
            },
            {
              data: { values: foldedRows },
              mark: { type: "point", filled: true, color: "#255C99", size: 50, stroke: "#FFFFFF", strokeWidth: 0.7 },
              encoding: {
                x: { field: "phase", type: "quantitative", title: `Phase at ${Number(bestPeak.periodDays.toPrecision(6))} day grid period`, scale: { domain: [0, 1] } },
                y: { field: "value", type: "quantitative", title: valueTitle, scale: yScale },
                tooltip: [
                  { field: "observationId", type: "nominal", title: "Observation" },
                  { field: "phase", type: "quantitative", title: "Phase", format: ".6f" },
                  { field: "value", type: "quantitative", title: "Observed", format: ".8g" },
                  { field: "residual", type: "quantitative", title: "Residual", format: ".8g" },
                ],
              },
            },
          ],
        },
      ],
      spacing: 22,
      config: {
        background: "#FFFFFF",
        axis: { labelColor: "#1F2937", titleColor: "#111827", gridColor: "#E5E7EB", domainColor: "#6B7280" },
        view: { stroke: null },
      },
      usermeta: provenance,
    },
  };
}

function analyzeLightCurvePeriodicity(input) {
  const normalizedInput = normalizeLombScargleInput(input);
  const initialRows = normalizedInput.measurements.map((measurement) => {
    const exclusionReasons = [];
    if (!measurement.use) exclusionReasons.push("user-excluded");
    if (measurement.time === null) exclusionReasons.push("time-missing");
    if (measurement.value === null) exclusionReasons.push("value-missing");
    return { measurement, exclusionReasons };
  });
  const completeRows = initialRows.filter((row) => row.exclusionReasons.length === 0);
  const allCompleteRowsHaveUncertainty = completeRows.length > 0 && completeRows.every((row) => row.measurement.standardError !== null);
  const resolvedWeighting = normalizedInput.weighting === "auto"
    ? (allCompleteRowsHaveUncertainty ? "weighted" : "unweighted")
    : normalizedInput.weighting;
  if (resolvedWeighting === "weighted") {
    for (const row of initialRows) {
      if (row.exclusionReasons.length === 0 && row.measurement.standardError === null) row.exclusionReasons.push("uncertainty-missing-for-weighted-fit");
    }
  }
  const eligibleRows = initialRows.filter((row) => row.exclusionReasons.length === 0);
  if (eligibleRows.length < LOMB_SCARGLE_LIMITS.minMeasurements) {
    throw new AstronomyDataError("astronomy-periodogram-insufficient-eligible-observations", "At least five analysis-eligible observations are required", { eligible: eligibleRows.length });
  }
  const distinctTimes = [...new Set(eligibleRows.map((row) => row.measurement.time))].sort((left, right) => left - right);
  if (distinctTimes.length < LOMB_SCARGLE_LIMITS.minDistinctTimes) {
    throw new AstronomyDataError("astronomy-periodogram-insufficient-distinct-times", "At least five distinct analysis-eligible times are required", { distinctTimes: distinctTimes.length });
  }
  const timeOrigin = distinctTimes[0];
  const baselineDays = distinctTimes.at(-1) - timeOrigin;
  if (!(baselineDays > 0)) throw new AstronomyDataError("astronomy-periodogram-baseline-invalid");
  const cadences = distinctTimes.slice(1).map((time, index) => time - distinctTimes[index]);
  const medianCadenceDays = median(cadences);
  const maximumGapDays = Math.max(...cadences);
  const warnings = [];
  if (normalizedInput.weighting === "auto" && resolvedWeighting === "unweighted") warnings.push("auto-weighting-fell-back-to-unweighted-missing-uncertainties");
  if (resolvedWeighting === "unweighted" && eligibleRows.some((row) => row.measurement.standardError !== null)) warnings.push("measurement-uncertainties-not-used-by-unweighted-fit");
  if (distinctTimes.length < eligibleRows.length) warnings.push("duplicate-observation-times-present");
  if (normalizedInput.maximumPeriodDays > baselineDays) warnings.push("maximum-period-exceeds-observation-baseline");
  if (medianCadenceDays !== null && normalizedInput.minimumPeriodDays < 2 * medianCadenceDays) warnings.push("minimum-period-below-twice-median-cadence-alias-risk");
  if (medianCadenceDays !== null && maximumGapDays > 5 * medianCadenceDays) warnings.push("large-sampling-gaps-window-alias-risk");

  const minimumError = resolvedWeighting === "weighted"
    ? Math.min(...eligibleRows.map((row) => row.measurement.standardError))
    : null;
  const rawWeights = eligibleRows.map((row) => resolvedWeighting === "weighted"
    ? (minimumError / row.measurement.standardError) ** 2
    : 1);
  const rawWeightSum = rawWeights.reduce((sum, value) => sum + value, 0);
  const points = eligibleRows.map((row, index) => ({
    observationId: row.measurement.observationId,
    time: row.measurement.time,
    value: row.measurement.value,
    standardError: row.measurement.standardError,
    weight: rawWeights[index] / rawWeightSum,
  }));
  const weightedMean = points.reduce((sum, point) => sum + point.weight * point.value, 0);
  const constantModelResidualSum = points.reduce((sum, point) => sum + point.weight * (point.value - weightedMean) ** 2, 0);
  const secondMoment = points.reduce((sum, point) => sum + point.weight * point.value ** 2, 0);
  if (constantModelResidualSum <= Math.max(1, secondMoment) * Number.EPSILON * 1024) {
    throw new AstronomyDataError("astronomy-periodogram-constant-series", "The analysis-eligible series has no resolvable variance");
  }

  const minimumFrequencyPerDay = 1 / normalizedInput.maximumPeriodDays;
  const maximumFrequencyPerDay = 1 / normalizedInput.minimumPeriodDays;
  const frequencyStepPerDay = (maximumFrequencyPerDay - minimumFrequencyPerDay) / (normalizedInput.frequencyCount - 1);
  const fits = [];
  const periodogram = [];
  for (let gridIndex = 0; gridIndex < normalizedInput.frequencyCount; gridIndex += 1) {
    const frequencyPerDay = gridIndex === normalizedInput.frequencyCount - 1
      ? maximumFrequencyPerDay
      : minimumFrequencyPerDay + gridIndex * frequencyStepPerDay;
    const fit = sinusoidFit(points, frequencyPerDay, timeOrigin);
    fits.push(fit);
    const power = fit === null ? null : Math.min(1, Math.max(0, 1 - fit.residualSum / constantModelResidualSum));
    periodogram.push({
      gridIndex,
      frequencyPerDay,
      periodDays: 1 / frequencyPerDay,
      power,
      windowPower: samplingWindowPower(points, frequencyPerDay, timeOrigin),
    });
  }
  const validRows = periodogram.filter((row) => row.power !== null);
  if (!validRows.length) throw new AstronomyDataError("astronomy-periodogram-no-valid-frequency", "Every frequency produced a singular design");
  const localMaxima = validRows.filter((row) => {
    const left = row.gridIndex === 0 ? null : periodogram[row.gridIndex - 1].power;
    const right = row.gridIndex === periodogram.length - 1 ? null : periodogram[row.gridIndex + 1].power;
    return (left === null || row.power >= left) && (right === null || row.power >= right);
  });
  const peakRows = (localMaxima.length ? localMaxima : validRows)
    .sort((left, right) => right.power - left.power || left.gridIndex - right.gridIndex)
    .slice(0, normalizedInput.maximumPeaks)
    .map((row, index) => {
      const fit = fits[row.gridIndex];
      return {
        rank: index + 1,
        gridIndex: row.gridIndex,
        frequencyPerDay: row.frequencyPerDay,
        periodDays: row.periodDays,
        power: row.power,
        windowPower: row.windowPower,
        offset: fit.offset,
        cosineCoefficient: fit.cosineCoefficient,
        sineCoefficient: fit.sineCoefficient,
        amplitude: Math.hypot(fit.cosineCoefficient, fit.sineCoefficient),
        phaseOfMaximumValue: unitPhase(Math.atan2(fit.sineCoefficient, fit.cosineCoefficient) / (2 * Math.PI)),
        normalizedResidualRootMeanSquare: Math.sqrt(fit.residualSum),
      };
    });
  const bestPeak = peakRows[0];
  const bestFit = fits[bestPeak.gridIndex];
  const pointById = new Map(points.map((point) => [point.observationId, point]));
  const rows = initialRows.map(({ measurement, exclusionReasons }) => {
    const point = pointById.get(measurement.observationId) ?? null;
    const phase = point ? unitPhase((point.time - timeOrigin) * bestPeak.frequencyPerDay) : null;
    const fittedValue = point === null ? null : bestFit.offset
      + bestFit.cosineCoefficient * Math.cos(2 * Math.PI * phase)
      + bestFit.sineCoefficient * Math.sin(2 * Math.PI * phase);
    return {
      observationId: measurement.observationId,
      time: measurement.time,
      absoluteTime: measurement.time === null ? null : measurement.time + normalizedInput.timeOffsetDays,
      value: measurement.value,
      standardError: measurement.standardError,
      use: measurement.use,
      analysisEligible: point !== null,
      exclusionReasons,
      normalizedWeight: point?.weight ?? null,
      phase,
      fittedValue,
      residual: point === null ? null : point.value - fittedValue,
    };
  });
  const foldedRows = rows.filter((row) => row.analysisEligible).map((row) => ({
    observationId: row.observationId,
    phase: row.phase,
    value: row.value,
    standardError: row.standardError,
    errorLower: row.standardError === null ? null : row.value - row.standardError,
    errorUpper: row.standardError === null ? null : row.value + row.standardError,
    fittedValue: row.fittedValue,
    residual: row.residual,
  })).sort((left, right) => left.phase - right.phase || (left.observationId < right.observationId ? -1 : 1));
  const modelRows = Array.from({ length: 101 }, (_, index) => {
    const phase = index / 100;
    return {
      phase,
      fittedValue: bestFit.offset
        + bestFit.cosineCoefficient * Math.cos(2 * Math.PI * phase)
        + bestFit.sineCoefficient * Math.sin(2 * Math.PI * phase),
    };
  });
  const metadata = {
    targetId: normalizedInput.targetId,
    timeSystem: normalizedInput.timeSystem,
    timeOffsetDays: normalizedInput.timeOffsetDays,
    valueKind: normalizedInput.valueKind,
    valueUnit: normalizedInput.valueUnit,
    requestedWeighting: normalizedInput.weighting,
    resolvedWeighting,
  };
  const observationsTable = lightCurveObservationTable(rows, metadata);
  const peaksTable = lightCurvePeakTable(peakRows, metadata);
  const periodogramTable = lightCurvePeriodogramTable(periodogram, metadata);
  const inputSha256 = sha256(canonicalJson(normalizedInput));
  const algorithmSha256 = sha256(canonicalJson(LOMB_SCARGLE_ALGORITHM));
  const observationsTableSha256 = sha256(canonicalJson(observationsTable));
  const peaksTableSha256 = sha256(canonicalJson(peaksTable));
  const periodogramTableSha256 = sha256(canonicalJson(periodogramTable));
  const figureProvenance = {
    schema: "agentlas.astronomy.figure-provenance/v1",
    sourceContentSha256: normalizedInput.sourceContentSha256,
    inputSha256,
    algorithmSha256,
    observationsTableSha256,
    peaksTableSha256,
    periodogramTableSha256,
  };
  const figure = lightCurvePublicationFigure(periodogram, foldedRows, modelRows, bestPeak, metadata, figureProvenance);
  const figureSha256 = sha256(canonicalJson(figure));
  const summary = {
    inputRows: rows.length,
    analysisEligibleRows: points.length,
    excludedRows: rows.length - points.length,
    exclusionCounts: Object.fromEntries(LIGHT_CURVE_EXCLUSION_REASONS.map((reason) => [reason, rows.filter((row) => row.exclusionReasons.includes(reason)).length])),
    distinctAnalysisTimes: distinctTimes.length,
    baselineDays,
    medianCadenceDays,
    maximumGapDays,
    validFrequencyCount: validRows.length,
    singularFrequencyCount: periodogram.length - validRows.length,
    localPeakCount: localMaxima.length,
  };
  const settings = {
    targetId: normalizedInput.targetId,
    timeSystem: normalizedInput.timeSystem,
    timeOffsetDays: normalizedInput.timeOffsetDays,
    valueKind: normalizedInput.valueKind,
    valueUnit: normalizedInput.valueUnit,
    requestedWeighting: normalizedInput.weighting,
    resolvedWeighting,
    minimumPeriodDays: normalizedInput.minimumPeriodDays,
    maximumPeriodDays: normalizedInput.maximumPeriodDays,
    minimumFrequencyPerDay,
    maximumFrequencyPerDay,
    frequencyStepPerDay,
    frequencyCount: normalizedInput.frequencyCount,
    maximumPeaks: normalizedInput.maximumPeaks,
    timeOrigin,
  };
  // The two numbers a reader needs before believing a peak are computed by declared analytic
  // methods. Each remains null when its inputs cannot resolve the estimate.
  const residualScale = bestPeak.normalizedResidualRootMeanSquare;
  const bestFitSummary = {
    ...bestPeak,
    constantModelMean: weightedMean,
    constantModelResidualSum,
    falseAlarmProbability: baluevFalseAlarmProbability(
      bestPeak.power, points.length, maximumFrequencyPerDay, points,
    ),
    periodStandardErrorDays: periodStandardErrorDays(
      bestPeak.periodDays, points.length, baselineDays, bestPeak.amplitude, residualScale,
    ),
  };
  if (bestFitSummary.falseAlarmProbability === null) warnings.push("false-alarm-probability-not-computed");
  if (bestFitSummary.periodStandardErrorDays === null) warnings.push("period-uncertainty-not-computed");
  warnings.push("single-sinusoid-model-only");
  const core = {
    schema: LOMB_SCARGLE_SCHEMA,
    algorithm: LOMB_SCARGLE_ALGORITHM,
    settings,
    summary,
    warnings,
    boundaries: LOMB_SCARGLE_BOUNDARIES,
    periodogram,
    peaks: peakRows,
    bestFit: bestFitSummary,
    publication: { observationsTable, peaksTable, periodogramTable, figure },
  };
  const resultSha256 = sha256(canonicalJson(core));
  return {
    ...core,
    provenance: {
      schema: "agentlas.astronomy.analysis-provenance/v1",
      pluginId: PLUGIN_ID,
      pluginVersion: PLUGIN_VERSION,
      sourceContentSha256: normalizedInput.sourceContentSha256,
      inputSha256,
      algorithmSha256,
      observationsTableSha256,
      peaksTableSha256,
      periodogramTableSha256,
      figureSha256,
      resultSha256,
    },
  };
}

module.exports = {
  measurementScale,
  ASTROMETRIC_EXCLUSION_REASONS,
  ASTROMETRIC_KINEMATICS_ALGORITHM,
  ASTROMETRIC_KINEMATICS_SCHEMA,
  LIGHT_CURVE_EXCLUSION_REASONS,
  LIGHT_CURVE_TIME_SYSTEMS,
  LIGHT_CURVE_VALUE_KINDS,
  LIGHT_CURVE_WEIGHTING_MODES,
  LOMB_SCARGLE_ALGORITHM,
  LOMB_SCARGLE_LIMITS,
  LOMB_SCARGLE_SCHEMA,
  AstronomyDataError,
  CATALOG_SCHEMA,
  COLUMN_DEFINITIONS,
  CONTENT_TYPE_ALLOWLIST,
  DEFAULT_POLICY,
  PLUGIN_ID,
  PLUGIN_VERSION,
  PROVENANCE_SCHEMA,
  RETRYABLE_STATUS_CODES,
  SOURCE_AUTHORITY,
  SIMBAD_ORIGIN,
  SIMBAD_TAP_ENDPOINT,
  SIMBAD_TAP_PATH,
  assertAllowedSimbadUrl,
  analyzeLightCurvePeriodicity,
  analyzeAstrometricKinematics,
  buildSimbadUrl,
  canonicalJson,
  createAstronomyClient,
  normalizeSimbadResponse,
  normalizeAstrometricKinematicsInput,
  normalizeLombScargleInput,
  sha256,
};
