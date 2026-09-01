import { createHash } from "node:crypto";

export const WORLD_BANK_BASE_URL = "https://api.worldbank.org/v2";
export const WORLD_BANK_HOST = "api.worldbank.org";

const INPUT_KEYS = new Set(["country", "indicator", "startYear", "endYear", "page", "per_page"]);
const OPTION_KEYS = new Set([
  "fetch",
  "timeoutMs",
  "maxResponseBytes",
  "retries",
  "retryDelayMs",
  "rateIntervalMs",
  "sleep",
  "now",
]);

const ISO_COUNTRY_PAIRS = `
AD:AND AE:ARE AF:AFG AG:ATG AI:AIA AL:ALB AM:ARM AO:AGO AQ:ATA AR:ARG AS:ASM AT:AUT AU:AUS AW:ABW AX:ALA AZ:AZE
BA:BIH BB:BRB BD:BGD BE:BEL BF:BFA BG:BGR BH:BHR BI:BDI BJ:BEN BL:BLM BM:BMU BN:BRN BO:BOL BQ:BES BR:BRA BS:BHS BT:BTN BV:BVT BW:BWA BY:BLR BZ:BLZ
CA:CAN CC:CCK CD:COD CF:CAF CG:COG CH:CHE CI:CIV CK:COK CL:CHL CM:CMR CN:CHN CO:COL CR:CRI CU:CUB CV:CPV CW:CUW CX:CXR CY:CYP CZ:CZE
DE:DEU DJ:DJI DK:DNK DM:DMA DO:DOM DZ:DZA
EC:ECU EE:EST EG:EGY EH:ESH ER:ERI ES:ESP ET:ETH
FI:FIN FJ:FJI FK:FLK FM:FSM FO:FRO FR:FRA
GA:GAB GB:GBR GD:GRD GE:GEO GF:GUF GG:GGY GH:GHA GI:GIB GL:GRL GM:GMB GN:GIN GP:GLP GQ:GNQ GR:GRC GS:SGS GT:GTM GU:GUM GW:GNB GY:GUY
HK:HKG HM:HMD HN:HND HR:HRV HT:HTI HU:HUN
ID:IDN IE:IRL IL:ISR IM:IMN IN:IND IO:IOT IQ:IRQ IR:IRN IS:ISL IT:ITA
JE:JEY JM:JAM JO:JOR JP:JPN
KE:KEN KG:KGZ KH:KHM KI:KIR KM:COM KN:KNA KP:PRK KR:KOR KW:KWT KY:CYM KZ:KAZ
LA:LAO LB:LBN LC:LCA LI:LIE LK:LKA LR:LBR LS:LSO LT:LTU LU:LUX LV:LVA LY:LBY
MA:MAR MC:MCO MD:MDA ME:MNE MF:MAF MG:MDG MH:MHL MK:MKD ML:MLI MM:MMR MN:MNG MO:MAC MP:MNP MQ:MTQ MR:MRT MS:MSR MT:MLT MU:MUS MV:MDV MW:MWI MX:MEX MY:MYS MZ:MOZ
NA:NAM NC:NCL NE:NER NF:NFK NG:NGA NI:NIC NL:NLD NO:NOR NP:NPL NR:NRU NU:NIU NZ:NZL
OM:OMN
PA:PAN PE:PER PF:PYF PG:PNG PH:PHL PK:PAK PL:POL PM:SPM PN:PCN PR:PRI PS:PSE PT:PRT PW:PLW PY:PRY
QA:QAT
RE:REU RO:ROU RS:SRB RU:RUS RW:RWA
SA:SAU SB:SLB SC:SYC SD:SDN SE:SWE SG:SGP SH:SHN SI:SVN SJ:SJM SK:SVK SL:SLE SM:SMR SN:SEN SO:SOM SR:SUR SS:SSD ST:STP SV:SLV SX:SXM SY:SYR SZ:SWZ
TC:TCA TD:TCD TF:ATF TG:TGO TH:THA TJ:TJK TK:TKL TL:TLS TM:TKM TN:TUN TO:TON TR:TUR TT:TTO TV:TUV TW:TWN TZ:TZA
UA:UKR UG:UGA UM:UMI US:USA UY:URY UZ:UZB
VA:VAT VC:VCT VE:VEN VG:VGB VI:VIR VN:VNM VU:VUT
WF:WLF WS:WSM
YE:YEM YT:MYT
ZA:ZAF ZM:ZMB ZW:ZWE
`.trim().split(/\s+/);

const ISO_ALPHA2 = new Set(ISO_COUNTRY_PAIRS.map((entry) => entry.slice(0, 2)));
const ISO_ALPHA3 = new Set(ISO_COUNTRY_PAIRS.map((entry) => entry.slice(3)));

export const APPROVED_AGGREGATE_CODES = Object.freeze([
  "ARB", "CEB", "CSS", "EAP", "EAR", "EAS", "ECA", "ECS", "EMU", "EUU",
  "FCS", "HIC", "HPC", "IBD", "IBT", "IDA", "IDB", "IDX", "LAC", "LCN",
  "LDC", "LIC", "LMC", "LTE", "MEA", "MIC", "MNA", "NAC", "OED", "OSS",
  "PRE", "PST", "SAS", "SSA", "SSF", "SST", "TEA", "TEC", "TLA", "TMN",
  "TSA", "TSS", "UMC", "WLD",
]);
const APPROVED_AGGREGATES = new Set(APPROVED_AGGREGATE_CODES);

const INDICATOR_RE = /^[A-Z0-9_]+(?:\.[A-Z0-9_]+){1,7}$/;
const YEAR_RE = /^\d{4}$/;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class EconomicDataError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "EconomicDataError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.details = isPlainObject(options.details) ? options.details : {};
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      details: this.details,
    };
  }
}

function fail(code, message, details = {}, options = {}) {
  throw new EconomicDataError(code, message, { ...options, details });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("INVALID_INPUT", `${label} contains an unknown field`, { field: key });
    }
  }
}

function boundedInteger(value, label, minimum, maximum, defaultValue) {
  const candidate = value === undefined ? defaultValue : value;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    fail("INVALID_INPUT", `${label} must be an integer between ${minimum} and ${maximum}`, {
      field: label,
      minimum,
      maximum,
    });
  }
  return candidate;
}

function normalizeCountry(value) {
  if (typeof value !== "string") {
    fail("INVALID_INPUT", "country must be an ISO2, ISO3, or approved aggregate code", { field: "country" });
  }
  const country = value.trim().toUpperCase();
  const valid = ISO_ALPHA2.has(country) || ISO_ALPHA3.has(country) || APPROVED_AGGREGATES.has(country);
  if (!valid) {
    fail("INVALID_INPUT", "country must be an ISO2, ISO3, or approved aggregate code", {
      field: "country",
      value: country,
    });
  }
  return country;
}

function normalizeIndicator(value) {
  if (typeof value !== "string") {
    fail("INVALID_INPUT", "indicator must be a World Bank indicator code", { field: "indicator" });
  }
  const indicator = value.trim().toUpperCase();
  if (indicator.length > 64 || !INDICATOR_RE.test(indicator)) {
    fail("INVALID_INPUT", "indicator must be a dot-delimited World Bank indicator code", {
      field: "indicator",
      value: indicator,
    });
  }
  return indicator;
}

function normalizeYear(value, field) {
  let year = value;
  if (typeof year === "string" && YEAR_RE.test(year)) year = Number(year);
  if (!Number.isInteger(year) || year < 1800 || year > 2200) {
    fail("INVALID_INPUT", `${field} must be a four-digit year between 1800 and 2200`, { field });
  }
  return year;
}

function normalizeInput(input) {
  if (!isPlainObject(input)) {
    fail("INVALID_INPUT", "input must be an object");
  }
  rejectUnknownKeys(input, INPUT_KEYS, "input");
  const country = normalizeCountry(input.country);
  const indicator = normalizeIndicator(input.indicator);
  const startYear = normalizeYear(input.startYear, "startYear");
  const endYear = normalizeYear(input.endYear, "endYear");
  if (startYear > endYear) {
    fail("INVALID_INPUT", "startYear must be less than or equal to endYear", { startYear, endYear });
  }
  return {
    country,
    indicator,
    startYear,
    endYear,
    page: boundedInteger(input.page, "page", 1, 10_000, 1),
    per_page: boundedInteger(input.per_page, "per_page", 1, 1_000, 1_000),
  };
}

function assertAllowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("POLICY_VIOLATION", "request URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== WORLD_BANK_HOST
    || url.port !== ""
    || !url.pathname.startsWith("/v2/country/")
    || !url.pathname.includes("/indicator/")
    || url.username !== ""
    || url.password !== ""
  ) {
    fail("POLICY_VIOLATION", "request URL is outside the World Bank allowlist", {
      scheme: url.protocol,
      host: url.hostname,
      path: url.pathname,
    });
  }
  return url;
}

export function buildWorldBankUrl(input) {
  const query = normalizeInput(input);
  const url = new URL(
    `/v2/country/${encodeURIComponent(query.country)}/indicator/${encodeURIComponent(query.indicator)}`,
    "https://api.worldbank.org",
  );
  url.searchParams.set("format", "json");
  url.searchParams.set("date", `${query.startYear}:${query.endYear}`);
  url.searchParams.set("page", String(query.page));
  url.searchParams.set("per_page", String(query.per_page));
  return assertAllowedUrl(url).href;
}

function responseInteger(value, label, minimum = 0) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < minimum) {
    fail("MALFORMED_RESPONSE", `World Bank response has invalid ${label}`, { field: label });
  }
  return number;
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    fail("MALFORMED_RESPONSE", `World Bank response has invalid ${label}`, { field: label });
  }
  return String(value);
}

function requiredString(value, label, maximum = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    fail("MALFORMED_RESPONSE", `World Bank response has invalid ${label}`, { field: label });
  }
  return value;
}

function normalizeRow(row, index) {
  if (!isPlainObject(row)) {
    fail("MALFORMED_RESPONSE", "World Bank response contains a malformed observation", { index });
  }
  if (!isPlainObject(row.indicator) || !isPlainObject(row.country)) {
    fail("MALFORMED_RESPONSE", "World Bank observation is missing indicator or country metadata", { index });
  }
  const indicatorCode = requiredString(row.indicator.id, `rows[${index}].indicator.id`, 64).toUpperCase();
  if (!INDICATOR_RE.test(indicatorCode)) {
    fail("MALFORMED_RESPONSE", "World Bank observation has an invalid indicator code", { index });
  }
  const indicatorName = requiredString(row.indicator.value, `rows[${index}].indicator.value`, 512);
  const countryId = requiredString(row.country.id, `rows[${index}].country.id`, 16).toUpperCase();
  const countryName = requiredString(row.country.value, `rows[${index}].country.value`, 256);
  const iso3Code = requiredString(row.countryiso3code, `rows[${index}].countryiso3code`, 16).toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(iso3Code)) {
    fail("MALFORMED_RESPONSE", "World Bank observation has an invalid country code", { index });
  }
  const date = requiredString(row.date, `rows[${index}].date`, 4);
  if (!YEAR_RE.test(date)) {
    fail("MALFORMED_RESPONSE", "World Bank observation date must be a four-digit year", { index });
  }
  if (row.value !== null && (typeof row.value !== "number" || !Number.isFinite(row.value))) {
    fail("MALFORMED_RESPONSE", "World Bank observation value must be a finite number or null", { index });
  }
  const unit = row.unit === null || row.unit === undefined || row.unit === ""
    ? ""
    : requiredString(row.unit, `rows[${index}].unit`, 128);
  const decimals = responseInteger(row.decimal, `rows[${index}].decimal`, 0);
  if (decimals > 12) {
    fail("MALFORMED_RESPONSE", "World Bank observation decimal precision is out of bounds", { index });
  }
  const observationStatus = row.obs_status === undefined || row.obs_status === null || row.obs_status === ""
    ? null
    : requiredString(row.obs_status, `rows[${index}].obs_status`, 64);
  return {
    identity: { indicatorCode, indicatorName, countryId, countryName, iso3Code, unit, decimals },
    observation: {
      date,
      value: row.value,
      unit,
      decimals,
      observationStatus,
    },
  };
}

export function normalizeWorldBankResponse(value) {
  if (!Array.isArray(value) || value.length !== 2 || !isPlainObject(value[0]) || !Array.isArray(value[1])) {
    fail("MALFORMED_RESPONSE", "World Bank JSON response must be a [metadata, observations] tuple");
  }
  const metadata = value[0];
  const pagination = {
    page: responseInteger(metadata.page, "page", 1),
    pages: responseInteger(metadata.pages, "pages", 0),
    perPage: responseInteger(metadata.per_page, "per_page", 1),
    total: responseInteger(metadata.total, "total", 0),
  };
  if (pagination.pages > 0 && pagination.page > pagination.pages) {
    fail("MALFORMED_RESPONSE", "World Bank response page exceeds total pages", pagination);
  }

  const observations = [];
  const seenDates = new Set();
  let seriesIdentity = null;
  for (let index = 0; index < value[1].length; index += 1) {
    const normalized = normalizeRow(value[1][index], index);
    const identity = normalized.identity;
    if (seriesIdentity === null) {
      seriesIdentity = identity;
    } else {
      const mismatch = Object.keys(seriesIdentity).find((key) => seriesIdentity[key] !== identity[key]);
      if (mismatch) {
        fail("MALFORMED_RESPONSE", "World Bank response mixes more than one series", { index, field: mismatch });
      }
    }
    if (seenDates.has(normalized.observation.date)) {
      fail("DUPLICATE_OBSERVATION", "World Bank response contains a duplicate observation date", {
        date: normalized.observation.date,
      });
    }
    seenDates.add(normalized.observation.date);
    observations.push(normalized.observation);
  }
  observations.sort((a, b) => b.date.localeCompare(a.date));

  return {
    schema: "agentlas.economic-data.world-bank-indicator.v1",
    provider: {
      id: "world-bank",
      name: "World Bank",
      apiVersion: "v2",
      sourceId: optionalString(metadata.sourceid, "sourceid"),
      lastUpdated: optionalString(metadata.lastupdated, "lastupdated"),
    },
    pagination,
    series: seriesIdentity === null
      ? { country: null, indicator: null, unit: null, decimals: null }
      : {
          country: {
            id: seriesIdentity.countryId,
            name: seriesIdentity.countryName,
            iso3Code: seriesIdentity.iso3Code,
          },
          indicator: {
            code: seriesIdentity.indicatorCode,
            name: seriesIdentity.indicatorName,
          },
          unit: seriesIdentity.unit,
          decimals: seriesIdentity.decimals,
        },
    observations,
  };
}

function boundedOption(value, label, minimum, maximum, defaultValue) {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_CLIENT_OPTIONS", `${label} must be an integer between ${minimum} and ${maximum}`, {
      field: label,
      minimum,
      maximum,
    });
  }
  return value;
}

async function readBoundedBytes(response, maximum) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      fail("MALFORMED_RESPONSE", "World Bank response has an invalid Content-Length header");
    }
    if (declared > maximum) {
      fail("RESPONSE_TOO_LARGE", "World Bank response exceeds the configured byte limit", {
        maximumBytes: maximum,
        declaredBytes: declared,
      });
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maximum) {
          await reader.cancel("response limit exceeded").catch(() => {});
          fail("RESPONSE_TOO_LARGE", "World Bank response exceeds the configured byte limit", {
            maximumBytes: maximum,
            receivedBytes: total,
          });
        }
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maximum) {
    fail("RESPONSE_TOO_LARGE", "World Bank response exceeds the configured byte limit", {
      maximumBytes: maximum,
      receivedBytes: bytes.byteLength,
    });
  }
  return bytes;
}

function normalizeCaughtError(error, signal) {
  if (error instanceof EconomicDataError) return error;
  if (signal?.aborted || error?.name === "AbortError") {
    return new EconomicDataError("TIMEOUT", "World Bank request timed out", { retryable: true, cause: error });
  }
  return new EconomicDataError("NETWORK_ERROR", "World Bank request failed", {
    retryable: true,
    cause: error,
    details: { causeName: typeof error?.name === "string" ? error.name : "Error" },
  });
}

export function createEconomicDataClient(options = {}) {
  if (!isPlainObject(options)) fail("INVALID_CLIENT_OPTIONS", "client options must be an object");
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      fail("INVALID_CLIENT_OPTIONS", "client options contain an unknown field", { field: key });
    }
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    fail("INVALID_CLIENT_OPTIONS", "a fetch implementation is required");
  }
  const timeoutMs = boundedOption(options.timeoutMs, "timeoutMs", 100, 30_000, 10_000);
  const maxResponseBytes = boundedOption(options.maxResponseBytes, "maxResponseBytes", 256, 10 * 1024 * 1024, 2 * 1024 * 1024);
  const retries = boundedOption(options.retries, "retries", 0, 3, 2);
  const retryDelayMs = boundedOption(options.retryDelayMs, "retryDelayMs", 0, 10_000, 250);
  const rateIntervalMs = boundedOption(options.rateIntervalMs, "rateIntervalMs", 0, 60_000, 250);
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => Date.now());
  if (typeof sleep !== "function" || typeof now !== "function") {
    fail("INVALID_CLIENT_OPTIONS", "sleep and now options must be functions");
  }

  let lastRequestStartedAt = Number.NEGATIVE_INFINITY;
  let rateQueue = Promise.resolve();

  async function waitForRateSlot() {
    let release;
    const predecessor = rateQueue;
    rateQueue = new Promise((resolve) => { release = resolve; });
    await predecessor;
    try {
      const waitMs = Math.max(0, lastRequestStartedAt + rateIntervalMs - now());
      if (waitMs > 0) await sleep(waitMs);
      lastRequestStartedAt = now();
    } finally {
      release();
    }
  }

  async function fetchOnce(url) {
    await waitForRateSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      assertAllowedUrl(url);
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response || typeof response.status !== "number") {
        fail("MALFORMED_RESPONSE", "fetch returned an invalid response object");
      }
      if (!response.ok) {
        throw new EconomicDataError("HTTP_ERROR", `World Bank request returned HTTP ${response.status}`, {
          status: response.status,
          retryable: RETRYABLE_STATUS.has(response.status),
          details: { statusText: typeof response.statusText === "string" ? response.statusText : "" },
        });
      }
      const bytes = await readBoundedBytes(response, maxResponseBytes);
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch (cause) {
        throw new EconomicDataError("INVALID_JSON", "World Bank response is not valid JSON", { cause });
      }
      return { bytes, parsed };
    } catch (error) {
      throw normalizeCaughtError(error, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchWorldBankIndicator(input) {
    const query = normalizeInput(input);
    const url = buildWorldBankUrl(query);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const { bytes, parsed } = await fetchOnce(url);
        const normalized = normalizeWorldBankResponse(parsed);
        return {
          ...normalized,
          query,
          request: { url },
          raw: {
            bytes: bytes.byteLength,
            sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          },
        };
      } catch (error) {
        lastError = normalizeCaughtError(error);
        if (!lastError.retryable || attempt === retries) throw lastError;
        await sleep(retryDelayMs * (2 ** attempt));
      }
    }
    throw lastError;
  }

  return Object.freeze({ fetchWorldBankIndicator });
}
