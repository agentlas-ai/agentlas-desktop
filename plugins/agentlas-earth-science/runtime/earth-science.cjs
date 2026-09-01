"use strict";

const { createHash } = require("node:crypto");

const PLUGIN_VERSION = "0.5.0";
const USGS_ORIGIN = "https://earthquake.usgs.gov";
const USGS_QUERY_PATH = "/fdsnws/event/1/query";
const USGS_ENDPOINT = `${USGS_ORIGIN}${USGS_QUERY_PATH}`;
const NOAA_COOPS_ORIGIN = "https://api.tidesandcurrents.noaa.gov";
const NOAA_COOPS_QUERY_PATH = "/api/prod/datagetter";
const NOAA_COOPS_ENDPOINT = `${NOAA_COOPS_ORIGIN}${NOAA_COOPS_QUERY_PATH}`;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 2_000;
const MAX_COOPS_OBSERVATIONS = 7_500;
const MAX_OFFSET = 1_000_000;
const MAX_QUERY_SPAN_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_COOPS_SPAN_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_PRODUCTS = 1_000;
const MAX_PRODUCT_CONTENTS = 2_000;
const MIN_GUTENBERG_RICHTER_EVENTS = 50;
const MAX_GUTENBERG_RICHTER_EVENTS = MAX_EVENTS;
const MIN_OMORI_UTSU_EVENTS = 20;
const MAX_OMORI_UTSU_BINS = 500;
const LOG10_E = Math.LOG10E;
const NORMAL_CRITICAL_VALUES = Object.freeze({
  "0.9": 1.6448536269514722,
  "0.95": 1.959963984540054,
  "0.99": 2.5758293035489004,
});
const ORDER_BY = new Set(["time", "time-asc", "magnitude", "magnitude-asc"]);
const COOPS_DATUMS = new Set(["CRD", "IGLD", "LWD", "MHHW", "MHW", "MTL", "MSL", "MLW", "MLLW", "NAVD", "STND"]);
const COOPS_UNITS = new Set(["metric", "english"]);
const CONTENT_TYPES = new Set(["application/json", "application/geo+json", "application/vnd.geo+json"]);
const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const USER_AGENT = `Agentlas-Earth-Science/${PLUGIN_VERSION} (official Earth observations; https://agentlas.ai)`;

class EarthScienceError extends Error {
  constructor(code, message = code, details = null, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EarthScienceError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EarthScienceError("earth-non-finite-number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new EarthScienceError("earth-json-value-invalid");
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new EarthScienceError("earth-json-undefined");
    output[key] = canonicalValue(value[key]);
  }
  return output;
}

function stableStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8")).digest("hex");
}

function exactObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new EarthScienceError(`${label}-invalid`);
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new EarthScienceError(`${label}-unknown-field`, `${label}: unknown field ${extras[0]}`, { unknownFields: extras.sort() });
  return value;
}

function text(value, min, max, label) {
  if (typeof value !== "string") throw new EarthScienceError(`${label}-invalid`);
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new EarthScienceError(`${label}-invalid`);
  }
  return normalized;
}

function finite(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new EarthScienceError(`${label}-invalid`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new EarthScienceError(`${label}-invalid`);
  return value;
}

function isoInstant(value, label) {
  const raw = text(value, 10, 80, label);
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(raw)) throw new EarthScienceError(`${label}-timezone-required`);
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis)) throw new EarthScienceError(`${label}-invalid`);
  return { millis, iso: new Date(millis).toISOString() };
}

function optionalText(value, max, label) {
  if (value === null || value === undefined || value === "") return null;
  return text(String(value), 1, max, label);
}

function optionalFinite(value, min, max, label) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return finite(numeric, min, max, label);
}

function optionalInteger(value, min, max, label) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  return integer(numeric, min, max, label);
}

function optionalIsoInstant(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return isoInstant(String(value), label).iso;
}

function normalizeEventId(value) {
  const eventId = text(value, 1, 120, "usgs-event-id");
  if (!/^[A-Za-z0-9._-]+$/.test(eventId)) throw new EarthScienceError("usgs-event-id-invalid");
  return eventId;
}

function normalizeSearchInput(input) {
  const value = exactObject(input, ["startTime", "endTime", "minMagnitude", "maxMagnitude", "minDepthKm", "maxDepthKm", "bounds", "limit", "offset", "orderBy"], "earth-search-input");
  const start = isoInstant(value.startTime, "earth-start-time");
  const end = isoInstant(value.endTime, "earth-end-time");
  if (start.millis >= end.millis || end.millis - start.millis > MAX_QUERY_SPAN_MS) {
    throw new EarthScienceError("earth-time-window-invalid", "earth query window must be positive and at most 366 days");
  }
  const minMagnitude = value.minMagnitude === undefined ? 0 : finite(value.minMagnitude, -2, 10, "earth-min-magnitude");
  const maxMagnitude = value.maxMagnitude === undefined || value.maxMagnitude === null ? null : finite(value.maxMagnitude, -2, 10, "earth-max-magnitude");
  if (maxMagnitude !== null && maxMagnitude < minMagnitude) throw new EarthScienceError("earth-magnitude-range-invalid");
  const minDepthKm = value.minDepthKm === undefined ? -100 : finite(value.minDepthKm, -100, 1_000, "earth-min-depth");
  const maxDepthKm = value.maxDepthKm === undefined ? 1_000 : finite(value.maxDepthKm, -100, 1_000, "earth-max-depth");
  if (minDepthKm > maxDepthKm) throw new EarthScienceError("earth-depth-range-invalid");
  const limit = value.limit === undefined ? 500 : integer(value.limit, 1, MAX_EVENTS, "earth-limit");
  const offset = value.offset === undefined ? 1 : integer(value.offset, 1, MAX_OFFSET, "earth-offset");
  const orderBy = value.orderBy === undefined ? "time" : text(value.orderBy, 1, 32, "earth-order-by");
  if (!ORDER_BY.has(orderBy)) throw new EarthScienceError("earth-order-by-invalid");
  let bounds = null;
  if (value.bounds !== undefined && value.bounds !== null) {
    const box = exactObject(value.bounds, ["minLongitude", "minLatitude", "maxLongitude", "maxLatitude"], "earth-bounds");
    bounds = {
      minLongitude: finite(box.minLongitude, -180, 180, "earth-min-longitude"),
      minLatitude: finite(box.minLatitude, -90, 90, "earth-min-latitude"),
      maxLongitude: finite(box.maxLongitude, -180, 180, "earth-max-longitude"),
      maxLatitude: finite(box.maxLatitude, -90, 90, "earth-max-latitude"),
    };
    if (bounds.minLongitude >= bounds.maxLongitude || bounds.minLatitude >= bounds.maxLatitude) {
      throw new EarthScienceError("earth-bounds-invalid", "USGS rectangular bounds cannot cross the antimeridian");
    }
  }
  return { startTime: start.iso, endTime: end.iso, minMagnitude, maxMagnitude, minDepthKm, maxDepthKm, bounds, limit, offset, orderBy };
}

function assertOfficialUsgsUrl(value, kind) {
  let url;
  try { url = new URL(value); } catch (error) { throw new EarthScienceError("usgs-endpoint-denied", "USGS URL is invalid", null, error); }
  if (url.protocol !== "https:" || url.origin !== USGS_ORIGIN || url.pathname !== USGS_QUERY_PATH || url.username || url.password || url.port || url.hash) {
    throw new EarthScienceError("usgs-endpoint-denied", "Only the official USGS FDSN event query endpoint is allowed");
  }
  const entries = [...url.searchParams.entries()];
  const names = entries.map(([name]) => name);
  if (new Set(names).size !== names.length) throw new EarthScienceError("usgs-endpoint-denied", "Duplicate USGS query parameters are denied");
  if (kind === "detail") {
    if (names.length !== 2 || names[0] !== "eventid" || names[1] !== "format" || url.searchParams.get("format") !== "geojson") {
      throw new EarthScienceError("usgs-endpoint-denied", "USGS event detail must use the fixed eventid GeoJSON query");
    }
    normalizeEventId(url.searchParams.get("eventid"));
  } else if (kind === "search") {
    const allowed = new Set(["endtime", "eventtype", "format", "limit", "maxdepth", "maxmagnitude", "maxlatitude", "maxlongitude", "mindepth", "minmagnitude", "minlatitude", "minlongitude", "offset", "orderby", "starttime"]);
    if (names.some((name) => !allowed.has(name)) || url.searchParams.get("format") !== "geojson" || url.searchParams.get("eventtype") !== "earthquake") {
      throw new EarthScienceError("usgs-endpoint-denied", "USGS search query is outside the fixed earthquake GeoJSON contract");
    }
  } else throw new EarthScienceError("usgs-endpoint-kind-invalid");
  return url.toString();
}

function buildUsgsUrl(input) {
  const normalized = normalizeSearchInput(input);
  const params = new URLSearchParams();
  params.set("endtime", normalized.endTime);
  params.set("eventtype", "earthquake");
  params.set("format", "geojson");
  params.set("limit", String(normalized.limit));
  params.set("maxdepth", String(normalized.maxDepthKm));
  if (normalized.maxMagnitude !== null) params.set("maxmagnitude", String(normalized.maxMagnitude));
  if (normalized.bounds) {
    params.set("maxlatitude", String(normalized.bounds.maxLatitude));
    params.set("maxlongitude", String(normalized.bounds.maxLongitude));
  }
  params.set("mindepth", String(normalized.minDepthKm));
  params.set("minmagnitude", String(normalized.minMagnitude));
  if (normalized.bounds) {
    params.set("minlatitude", String(normalized.bounds.minLatitude));
    params.set("minlongitude", String(normalized.bounds.minLongitude));
  }
  params.set("offset", String(normalized.offset));
  params.set("orderby", normalized.orderBy);
  params.set("starttime", normalized.startTime);
  const url = assertOfficialUsgsUrl(`${USGS_ENDPOINT}?${params.toString()}`, "search");
  return { input: normalized, url };
}

function buildUsgsEventDetailUrl(input) {
  const value = exactObject(input, ["eventId"], "earth-detail-input");
  const eventId = normalizeEventId(value.eventId);
  const params = new URLSearchParams();
  params.set("eventid", eventId);
  params.set("format", "geojson");
  return { input: { eventId }, url: assertOfficialUsgsUrl(`${USGS_ENDPOINT}?${params.toString()}`, "detail") };
}

function normalizeCoopsStationId(value) {
  const stationId = text(value, 7, 7, "noaa-coops-station-id");
  if (!/^\d{7}$/.test(stationId)) throw new EarthScienceError("noaa-coops-station-id-invalid");
  return stationId;
}

function coopsUtcMinute(instant, label) {
  if (instant.millis % 60_000 !== 0) {
    throw new EarthScienceError(`${label}-precision-invalid`, "NOAA CO-OPS query times must resolve exactly to a UTC minute");
  }
  const [date, time] = instant.iso.slice(0, 16).split("T");
  return `${date.replaceAll("-", "")} ${time}`;
}

function normalizeCoopsWaterLevelInput(input) {
  const value = exactObject(input, ["stationId", "startTime", "endTime", "datum", "units"], "noaa-coops-input");
  const stationId = normalizeCoopsStationId(value.stationId);
  const start = isoInstant(value.startTime, "noaa-coops-start-time");
  const end = isoInstant(value.endTime, "noaa-coops-end-time");
  if (start.millis >= end.millis || end.millis - start.millis > MAX_COOPS_SPAN_MS) {
    throw new EarthScienceError("noaa-coops-time-window-invalid", "NOAA CO-OPS water-level windows must be positive and at most 31 days");
  }
  const datum = text(value.datum, 2, 8, "noaa-coops-datum").toUpperCase();
  if (!COOPS_DATUMS.has(datum)) throw new EarthScienceError("noaa-coops-datum-invalid");
  const units = value.units === undefined ? "metric" : text(value.units, 1, 16, "noaa-coops-units").toLowerCase();
  if (!COOPS_UNITS.has(units)) throw new EarthScienceError("noaa-coops-units-invalid");
  return {
    stationId,
    startTime: start.iso,
    endTime: end.iso,
    datum,
    units,
    beginDate: coopsUtcMinute(start, "noaa-coops-start-time"),
    endDate: coopsUtcMinute(end, "noaa-coops-end-time"),
  };
}

function assertOfficialNoaaCoopsUrl(value) {
  let url;
  try { url = new URL(value); } catch (error) { throw new EarthScienceError("noaa-coops-endpoint-denied", "NOAA CO-OPS URL is invalid", null, error); }
  if (url.protocol !== "https:" || url.origin !== NOAA_COOPS_ORIGIN || url.pathname !== NOAA_COOPS_QUERY_PATH || url.username || url.password || url.port || url.hash) {
    throw new EarthScienceError("noaa-coops-endpoint-denied", "Only the official NOAA CO-OPS production data endpoint is allowed");
  }
  const entries = [...url.searchParams.entries()];
  const names = entries.map(([name]) => name);
  const expectedNames = ["application", "begin_date", "datum", "end_date", "format", "product", "station", "time_zone", "units"];
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index]) || new Set(names).size !== names.length) {
    throw new EarthScienceError("noaa-coops-endpoint-denied", "NOAA CO-OPS query parameters are outside the fixed water-level contract");
  }
  if (url.searchParams.get("application") !== "AgentlasEarthScience"
    || url.searchParams.get("format") !== "json"
    || url.searchParams.get("product") !== "water_level"
    || url.searchParams.get("time_zone") !== "gmt"
    || !COOPS_DATUMS.has(url.searchParams.get("datum"))
    || !COOPS_UNITS.has(url.searchParams.get("units"))) {
    throw new EarthScienceError("noaa-coops-endpoint-denied", "NOAA CO-OPS fixed product, UTC, datum, unit, or format contract was violated");
  }
  normalizeCoopsStationId(url.searchParams.get("station"));
  if (!/^\d{8} \d{2}:\d{2}$/.test(url.searchParams.get("begin_date") ?? "") || !/^\d{8} \d{2}:\d{2}$/.test(url.searchParams.get("end_date") ?? "")) {
    throw new EarthScienceError("noaa-coops-endpoint-denied", "NOAA CO-OPS request dates must use deterministic UTC-minute form");
  }
  return url.toString();
}

function buildNoaaCoopsWaterLevelUrl(input) {
  const normalized = normalizeCoopsWaterLevelInput(input);
  const params = new URLSearchParams();
  params.set("application", "AgentlasEarthScience");
  params.set("begin_date", normalized.beginDate);
  params.set("datum", normalized.datum);
  params.set("end_date", normalized.endDate);
  params.set("format", "json");
  params.set("product", "water_level");
  params.set("station", normalized.stationId);
  params.set("time_zone", "gmt");
  params.set("units", normalized.units);
  const { beginDate, endDate, ...query } = normalized;
  return { input: query, url: assertOfficialNoaaCoopsUrl(`${NOAA_COOPS_ENDPOINT}?${params.toString()}`) };
}

function safeHttpsUrl(value, allowedHosts, label) {
  const raw = optionalText(value, 2_048, label);
  if (raw === null) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new EarthScienceError(`${label}-invalid`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !allowedHosts.has(parsed.hostname) || parsed.hash) {
    throw new EarthScienceError(`${label}-invalid`);
  }
  return parsed.toString();
}

function commaTokens(value, label) {
  if (value === null || value === undefined || value === "") return [];
  const raw = text(String(value), 1, 20_000, label);
  const tokens = raw.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length > 500) throw new EarthScienceError(`${label}-limit`);
  if (tokens.some((token) => token.length > 160 || /[\u0000-\u001f\u007f]/.test(token))) throw new EarthScienceError(`${label}-invalid`);
  return [...new Set(tokens)].sort();
}

function normalizeEventFeature(feature, index = 0) {
  if (!feature || typeof feature !== "object" || Array.isArray(feature) || feature.type !== "Feature") {
    throw new EarthScienceError("usgs-feature-invalid", `feature ${index} is invalid`);
  }
  const id = normalizeEventId(String(feature.id ?? ""));
  const geometry = feature.geometry;
  if (!geometry || geometry.type !== "Point" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 3) {
    throw new EarthScienceError("usgs-point-geometry-invalid");
  }
  const longitude = finite(geometry.coordinates[0], -180, 180, "usgs-longitude");
  const latitude = finite(geometry.coordinates[1], -90, 90, "usgs-latitude");
  const depthKm = finite(geometry.coordinates[2], -100, 1_000, "usgs-depth");
  const properties = feature.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new EarthScienceError("usgs-properties-invalid");
  const timeMillis = integer(properties.time, -8_640_000_000_000_000, 8_640_000_000_000_000, "usgs-time");
  const updatedMillis = properties.updated === null || properties.updated === undefined
    ? null : integer(properties.updated, -8_640_000_000_000_000, 8_640_000_000_000_000, "usgs-updated");
  const tsunamiRaw = properties.tsunami;
  if (![0, 1, null, undefined].includes(tsunamiRaw)) throw new EarthScienceError("usgs-tsunami-flag-invalid");
  return {
    id,
    time: new Date(timeMillis).toISOString(),
    updatedAt: updatedMillis === null ? null : new Date(updatedMillis).toISOString(),
    magnitude: optionalFinite(properties.mag, -2, 10, "usgs-magnitude"),
    magnitudeType: optionalText(properties.magType, 40, "usgs-magnitude-type"),
    place: optionalText(properties.place, 600, "usgs-place"),
    title: optionalText(properties.title, 600, "usgs-title"),
    longitude,
    latitude,
    depthKm,
    quality: {
      stationCount: optionalInteger(properties.nst, 0, 2_147_483_647, "usgs-station-count"),
      azimuthalGapDeg: optionalFinite(properties.gap, 0, 360, "usgs-azimuthal-gap"),
      minimumStationDistanceDeg: optionalFinite(properties.dmin, 0, 180, "usgs-minimum-station-distance"),
      rmsTravelTimeResidualSec: optionalFinite(properties.rms, 0, 100_000, "usgs-rms"),
    },
    intensity: {
      communityReportedCdi: optionalFinite(properties.cdi, 0, 12, "usgs-cdi"),
      estimatedMmi: optionalFinite(properties.mmi, 0, 12, "usgs-mmi"),
    },
    feltReports: properties.felt === null || properties.felt === undefined ? null : integer(properties.felt, 0, 2_147_483_647, "usgs-felt"),
    significance: properties.sig === null || properties.sig === undefined ? null : integer(properties.sig, 0, 2_147_483_647, "usgs-significance"),
    tsunami: tsunamiRaw === 1,
    tsunamiFlag: tsunamiRaw === 1,
    alert: optionalText(properties.alert, 40, "usgs-alert"),
    status: optionalText(properties.status, 80, "usgs-status"),
    eventType: optionalText(properties.type, 120, "usgs-event-type"),
    network: optionalText(properties.net, 80, "usgs-network"),
    networkCode: optionalText(properties.code, 160, "usgs-network-code"),
    identifiers: commaTokens(properties.ids, "usgs-identifiers"),
    contributingSources: commaTokens(properties.sources, "usgs-sources"),
    productTypes: commaTokens(properties.types, "usgs-product-types"),
    detailUrl: safeHttpsUrl(properties.detail, new Set(["earthquake.usgs.gov"]), "usgs-detail-url"),
    publicUrl: safeHttpsUrl(properties.url, new Set(["earthquake.usgs.gov"]), "usgs-public-url"),
  };
}

function compareNullableMagnitude(left, right, ascending) {
  if (left.magnitude === null && right.magnitude === null) return 0;
  if (left.magnitude === null) return 1;
  if (right.magnitude === null) return -1;
  return ascending ? left.magnitude - right.magnitude : right.magnitude - left.magnitude;
}

function sortEvents(events, orderBy) {
  const copy = [...events];
  copy.sort((left, right) => {
    if (orderBy === "time-asc") return left.time.localeCompare(right.time) || left.id.localeCompare(right.id);
    if (orderBy === "magnitude" || orderBy === "magnitude-asc") {
      return compareNullableMagnitude(left, right, orderBy === "magnitude-asc") || right.time.localeCompare(left.time) || left.id.localeCompare(right.id);
    }
    return right.time.localeCompare(left.time) || left.id.localeCompare(right.id);
  });
  return copy;
}

function normalizeSourceMetadata(metadata, featureCount) {
  if (metadata === null || metadata === undefined) return { generatedAt: null, title: null, status: null, api: null, count: featureCount };
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new EarthScienceError("usgs-metadata-invalid");
  const generated = metadata.generated === null || metadata.generated === undefined ? null : integer(metadata.generated, -8_640_000_000_000_000, 8_640_000_000_000_000, "usgs-metadata-generated");
  const count = metadata.count === null || metadata.count === undefined ? featureCount : integer(metadata.count, 0, MAX_EVENTS, "usgs-metadata-count");
  if (count !== featureCount) throw new EarthScienceError("usgs-metadata-count-mismatch", "USGS metadata count does not match the returned feature count");
  return {
    generatedAt: generated === null ? null : new Date(generated).toISOString(),
    title: optionalText(metadata.title, 600, "usgs-metadata-title"),
    status: optionalInteger(metadata.status, 100, 599, "usgs-metadata-status"),
    api: optionalText(metadata.api, 80, "usgs-metadata-api"),
    count,
  };
}

function normalizeUsgsGeoJson(raw, options = {}) {
  exactObject(options, ["orderBy", "offset", "limit"], "earth-normalize-options");
  const orderBy = options.orderBy === undefined ? "time" : text(options.orderBy, 1, 32, "earth-order-by");
  if (!ORDER_BY.has(orderBy)) throw new EarthScienceError("earth-order-by-invalid");
  const offset = options.offset === undefined ? 1 : integer(options.offset, 1, MAX_OFFSET, "earth-offset");
  const limit = options.limit === undefined ? MAX_EVENTS : integer(options.limit, 1, MAX_EVENTS, "earth-limit");
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.type !== "FeatureCollection" || !Array.isArray(raw.features)) {
    throw new EarthScienceError("usgs-feature-collection-invalid");
  }
  if (raw.features.length > MAX_EVENTS || raw.features.length > limit) throw new EarthScienceError("usgs-feature-count-limit");
  const ids = new Set();
  const events = sortEvents(raw.features.map((feature, index) => normalizeEventFeature(feature, index)), orderBy);
  for (const event of events) {
    if (ids.has(event.id)) throw new EarthScienceError("usgs-event-id-duplicate");
    ids.add(event.id);
  }
  const features = events.map((event) => ({
    type: "Feature",
    id: event.id,
    geometry: { type: "Point", coordinates: [event.longitude, event.latitude, event.depthKm] },
    properties: {
      time: event.time,
      updatedAt: event.updatedAt,
      magnitude: event.magnitude,
      magnitudeType: event.magnitudeType,
      place: event.place,
      stationCount: event.quality.stationCount,
      azimuthalGapDeg: event.quality.azimuthalGapDeg,
      minimumStationDistanceDeg: event.quality.minimumStationDistanceDeg,
      rmsTravelTimeResidualSec: event.quality.rmsTravelTimeResidualSec,
      feltReports: event.feltReports,
      significance: event.significance,
      tsunami: event.tsunami,
      tsunamiFlag: event.tsunamiFlag,
      alert: event.alert,
      status: event.status,
      eventType: event.eventType,
      network: event.network,
      publicUrl: event.publicUrl,
    },
  }));
  const bbox = events.length ? [
    Math.min(...events.map((event) => event.longitude)),
    Math.min(...events.map((event) => event.latitude)),
    Math.min(...events.map((event) => event.depthKm)),
    Math.max(...events.map((event) => event.longitude)),
    Math.max(...events.map((event) => event.latitude)),
    Math.max(...events.map((event) => event.depthKm)),
  ] : null;
  const warnings = [];
  if (events.some((event) => event.magnitude === null)) warnings.push("Some USGS events have no preferred magnitude.");
  if (events.some((event) => event.place === null)) warnings.push("Some USGS events have no place label.");
  if (events.length === limit) warnings.push("This page is full; additional USGS events may exist. Continue with pagination.nextOffset.");
  const geojson = { type: "FeatureCollection", features };
  if (bbox) geojson.bbox = bbox;
  const table = {
    schema: "agentlas.science-table/v1",
    columns: [
      { id: "eventId", label: "USGS event id", type: "string", unit: null },
      { id: "time", label: "Origin time", type: "datetime", unit: null },
      { id: "magnitude", label: "Magnitude", type: "number", unit: null },
      { id: "depthKm", label: "Depth", type: "number", unit: "km" },
      { id: "longitude", label: "Longitude", type: "number", unit: "degree" },
      { id: "latitude", label: "Latitude", type: "number", unit: "degree" },
      { id: "stationCount", label: "Stations", type: "integer", unit: "count" },
      { id: "azimuthalGapDeg", label: "Azimuthal gap", type: "number", unit: "degree" },
      { id: "minimumStationDistanceDeg", label: "Nearest station distance", type: "number", unit: "degree" },
      { id: "rmsTravelTimeResidualSec", label: "RMS travel-time residual", type: "number", unit: "s" },
      { id: "place", label: "Place", type: "string", unit: null },
    ],
    rows: events.map((event) => [event.id, event.time, event.magnitude, event.depthKm, event.longitude, event.latitude, event.quality.stationCount, event.quality.azimuthalGapDeg, event.quality.minimumStationDistanceDeg, event.quality.rmsTravelTimeResidualSec, event.place]),
  };
  const sourceMetadata = normalizeSourceMetadata(raw.metadata, events.length);
  const pagination = {
    offset,
    limit,
    returnedCount: events.length,
    nextOffset: events.length === limit ? offset + limit : null,
    completeness: events.length === limit ? "additional-results-possible" : "page-complete",
  };
  const qualityCoverage = {
    stationCount: events.filter((event) => event.quality.stationCount !== null).length,
    azimuthalGap: events.filter((event) => event.quality.azimuthalGapDeg !== null).length,
    minimumStationDistance: events.filter((event) => event.quality.minimumStationDistanceDeg !== null).length,
    rmsTravelTimeResidual: events.filter((event) => event.quality.rmsTravelTimeResidualSec !== null).length,
  };
  const legacyEvents = events.map((event) => ({
    id: event.id,
    time: event.time,
    updatedAt: event.updatedAt,
    magnitude: event.magnitude,
    magnitudeType: event.magnitudeType,
    place: event.place,
    longitude: event.longitude,
    latitude: event.latitude,
    depthKm: event.depthKm,
    feltReports: event.feltReports,
    significance: event.significance,
    tsunami: event.tsunami,
    alert: event.alert,
    status: event.status,
    eventType: event.eventType,
    detailUrl: event.detailUrl,
    publicUrl: event.publicUrl,
  }));
  const normalized = {
    schema: "agentlas.earth.usgs-earthquake-catalog/v1",
    contractRevision: "quality-pagination-detail-compatible/v2",
    source: {
      provider: "USGS Earthquake Hazards Program",
      collection: "ANSS Comprehensive Earthquake Catalog (ComCat)",
      canonicalUri: "usgs:fdsn-event/1",
      endpoint: USGS_ENDPOINT,
    },
    sourceMetadata,
    orderBy,
    eventCount: events.length,
    pagination,
    qualityCoverage,
    events: legacyEvents,
    observations: events,
    geojson,
    table,
    rendererCompatibility: {
      primaryMimeType: "application/geo+json",
      hostRequired: true,
      rendererIds: ["agentlas.maplibre", "agentlas.cesium", "agentlas.vega"],
      bundledRenderer: false,
    },
    warnings,
  };
  return { ...normalized, normalizedSha256: sha256(stableStringify(normalized)) };
}

function rounded(value, digits = 12) {
  const factor = 10 ** digits;
  const result = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new EarthScienceError(`${label}-invalid`);
  return value;
}

function validateGutenbergRichterCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new EarthScienceError("earth-gr-catalog-invalid");
  }
  const catalog = exactObject(value, [
    "schema", "contractRevision", "source", "sourceMetadata", "orderBy", "eventCount", "pagination", "qualityCoverage",
    "events", "observations", "geojson", "table", "rendererCompatibility", "warnings", "normalizedSha256", "query", "provenance",
  ], "earth-gr-catalog");
  if (catalog.schema !== "agentlas.earth.usgs-earthquake-catalog/v1" || catalog.contractRevision !== "quality-pagination-detail-compatible/v2") {
    throw new EarthScienceError("earth-gr-catalog-schema-invalid");
  }
  if (!Array.isArray(catalog.observations) || catalog.observations.length < 1 || catalog.observations.length > MAX_GUTENBERG_RICHTER_EVENTS
    || catalog.eventCount !== catalog.observations.length) {
    throw new EarthScienceError("earth-gr-catalog-events-invalid");
  }
  const normalizedSha256 = assertSha256(catalog.normalizedSha256, "earth-gr-catalog-normalized-sha256");
  const { normalizedSha256: _normalizedSha256, query, provenance, ...normalizedCore } = catalog;
  if (sha256(stableStringify(normalizedCore)) !== normalizedSha256) throw new EarthScienceError("earth-gr-catalog-normalized-sha256-mismatch");
  const exactQuery = exactObject(query, ["startTime", "endTime", "minMagnitude", "maxMagnitude", "minDepthKm", "maxDepthKm", "bounds", "limit", "offset", "orderBy"], "earth-gr-query");
  const start = isoInstant(exactQuery.startTime, "earth-gr-start-time");
  const end = isoInstant(exactQuery.endTime, "earth-gr-end-time");
  if (end.millis <= start.millis || end.millis - start.millis > MAX_QUERY_SPAN_MS) throw new EarthScienceError("earth-gr-time-window-invalid");
  if (exactQuery.offset !== 1) throw new EarthScienceError("earth-gr-first-page-required");
  const pagination = exactObject(catalog.pagination, ["offset", "limit", "returnedCount", "nextOffset", "completeness"], "earth-gr-pagination");
  if (pagination.offset !== 1 || pagination.returnedCount !== catalog.eventCount || pagination.nextOffset !== null || pagination.completeness !== "page-complete") {
    throw new EarthScienceError("earth-gr-complete-catalog-required", "Gutenberg-Richter analysis requires a complete first-page catalog; narrow the query until USGS pagination is complete");
  }
  const receipt = exactObject(provenance, [
    "schema", "provider", "endpoint", "requestUrl", "requestSha256", "responseUrl", "httpStatus", "rawResponseSha256", "rawResponseBytes",
    "responseContentType", "normalizedSha256", "retrievedAt", "attempts", "itemCount", "network", "limits",
  ], "earth-gr-provenance");
  if (receipt.schema !== "agentlas.science-source-receipt/v1" || receipt.provider !== "USGS Earthquake Hazards Program"
    || receipt.endpoint !== USGS_ENDPOINT || receipt.normalizedSha256 !== normalizedSha256 || receipt.itemCount !== catalog.eventCount
    || !Number.isSafeInteger(receipt.rawResponseBytes) || receipt.rawResponseBytes < 1) {
    throw new EarthScienceError("earth-gr-provenance-invalid");
  }
  const rawResponseSha256 = assertSha256(receipt.rawResponseSha256, "earth-gr-raw-response-sha256");
  const requestSha256 = assertSha256(receipt.requestSha256, "earth-gr-request-sha256");
  const expectedRequestUrl = buildUsgsUrl(exactQuery).url;
  const expectedRequestSha256 = sha256(stableStringify({ method: "GET", url: expectedRequestUrl, accept: "application/json", userAgent: USER_AGENT }));
  if (receipt.requestUrl !== expectedRequestUrl || receipt.responseUrl !== expectedRequestUrl || requestSha256 !== expectedRequestSha256
    || receipt.httpStatus !== 200 || !CONTENT_TYPES.has(receipt.responseContentType)) {
    throw new EarthScienceError("earth-gr-request-receipt-invalid");
  }
  const network = exactObject(receipt.network, ["method", "requestUrl", "accept", "userAgent", "responseUrl", "httpStatus", "responseContentType", "rawResponseBytes", "rawResponseSha256", "redirects", "attempts"], "earth-gr-network");
  if (network.rawResponseSha256 !== rawResponseSha256 || network.rawResponseBytes !== receipt.rawResponseBytes
    || network.requestUrl !== receipt.requestUrl || network.responseUrl !== receipt.responseUrl || network.redirects !== "denied") {
    throw new EarthScienceError("earth-gr-network-receipt-invalid");
  }
  return { catalog, query: exactQuery, start, end, receipt, normalizedSha256, rawResponseSha256, requestSha256 };
}

function normalizeGutenbergRichterInput(value) {
  const input = exactObject(value, ["catalog", "completenessMagnitude", "binWidth", "magnitudeType", "confidenceLevel"], "earth-gr-input");
  const completenessMagnitude = finite(input.completenessMagnitude, -2, 10, "earth-gr-completeness-magnitude");
  const binWidth = input.binWidth === undefined ? 0.1 : finite(input.binWidth, 0.01, 1, "earth-gr-bin-width");
  const magnitudeType = text(input.magnitudeType, 1, 40, "earth-gr-magnitude-type").toLowerCase();
  const confidenceLevel = input.confidenceLevel === undefined ? 0.95 : finite(input.confidenceLevel, 0.9, 0.99, "earth-gr-confidence-level");
  if (!Object.hasOwn(NORMAL_CRITICAL_VALUES, String(confidenceLevel))) throw new EarthScienceError("earth-gr-confidence-level-invalid");
  const aligned = Math.abs(completenessMagnitude / binWidth - Math.round(completenessMagnitude / binWidth));
  if (aligned > 1e-8) throw new EarthScienceError("earth-gr-completeness-bin-alignment-invalid");
  return { ...validateGutenbergRichterCatalog(input.catalog), completenessMagnitude, binWidth, magnitudeType, confidenceLevel };
}

function analyzeGutenbergRichter(value) {
  const input = normalizeGutenbergRichterInput(value);
  if (input.query.minMagnitude > input.completenessMagnitude) {
    throw new EarthScienceError("earth-gr-query-truncates-completeness", "USGS query minimum magnitude is above the declared completeness threshold");
  }
  const seenIds = new Set();
  const auditRows = [];
  const included = [];
  const excludedByReason = { missingMagnitude: 0, magnitudeTypeMismatch: 0, belowCompleteness: 0 };
  for (const rawEvent of input.catalog.observations) {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) throw new EarthScienceError("earth-gr-event-invalid");
    const id = normalizeEventId(String(rawEvent.id ?? ""));
    if (seenIds.has(id)) throw new EarthScienceError("earth-gr-event-id-duplicate");
    seenIds.add(id);
    const instant = isoInstant(rawEvent.time, "earth-gr-event-time");
    if (instant.millis < input.start.millis || instant.millis > input.end.millis) throw new EarthScienceError("earth-gr-event-outside-source-window");
    const magnitude = rawEvent.magnitude === null ? null : finite(rawEvent.magnitude, -2, 10, "earth-gr-event-magnitude");
    const magnitudeType = rawEvent.magnitudeType === null ? null : text(rawEvent.magnitudeType, 1, 40, "earth-gr-event-magnitude-type").toLowerCase();
    let exclusionReason = null;
    if (magnitude === null) exclusionReason = "missing-magnitude";
    else if (magnitudeType !== input.magnitudeType) exclusionReason = "magnitude-type-mismatch";
    else if (magnitude < input.completenessMagnitude) exclusionReason = "below-completeness";
    if (exclusionReason === "missing-magnitude") excludedByReason.missingMagnitude += 1;
    else if (exclusionReason === "magnitude-type-mismatch") excludedByReason.magnitudeTypeMismatch += 1;
    else if (exclusionReason === "below-completeness") excludedByReason.belowCompleteness += 1;
    else {
      if (Math.abs(magnitude / input.binWidth - Math.round(magnitude / input.binWidth)) > 1e-8) {
        throw new EarthScienceError("earth-gr-magnitude-bin-alignment-invalid", "Included magnitudes must align to the declared catalog bin width", { eventId: id, magnitude, binWidth: input.binWidth });
      }
      included.push({ id, time: instant.iso, magnitude });
    }
    auditRows.push([id, instant.iso, magnitude, magnitudeType, exclusionReason === null, exclusionReason]);
  }
  if (included.length < MIN_GUTENBERG_RICHTER_EVENTS) {
    throw new EarthScienceError("earth-gr-sample-inadequate", `At least ${MIN_GUTENBERG_RICHTER_EVENTS} complete, same-type magnitudes at or above Mc are required`, { includedCount: included.length, minimum: MIN_GUTENBERG_RICHTER_EVENTS });
  }
  included.sort((left, right) => left.magnitude - right.magnitude || left.time.localeCompare(right.time) || left.id.localeCompare(right.id));
  const distinctBins = new Set(included.map((event) => Math.round(event.magnitude / input.binWidth)));
  if (distinctBins.size < 3) throw new EarthScienceError("earth-gr-magnitude-range-inadequate", "At least three occupied magnitude bins are required");
  const meanMagnitude = included.reduce((sum, event) => sum + event.magnitude, 0) / included.length;
  const effectiveThreshold = input.completenessMagnitude - input.binWidth / 2;
  const denominator = meanMagnitude - effectiveThreshold;
  if (!(denominator > 0)) throw new EarthScienceError("earth-gr-mle-denominator-invalid");
  const bValue = LOG10_E / denominator;
  const standardError = bValue / Math.sqrt(included.length);
  const criticalValue = NORMAL_CRITICAL_VALUES[String(input.confidenceLevel)];
  const confidenceInterval = {
    lower: Math.max(0, bValue - criticalValue * standardError),
    upper: bValue + criticalValue * standardError,
  };
  const aValue = Math.log10(included.length) + bValue * input.completenessMagnitude;
  const maximumMagnitude = included[included.length - 1].magnitude;
  const maximumBinIndex = Math.round((maximumMagnitude - input.completenessMagnitude) / input.binWidth);
  const rows = [];
  for (let index = 0; index <= maximumBinIndex; index += 1) {
    const threshold = rounded(input.completenessMagnitude + index * input.binWidth);
    const nextThreshold = rounded(threshold + input.binWidth);
    const binCount = included.filter((event) => event.magnitude >= threshold - 1e-10 && event.magnitude < nextThreshold - 1e-10).length;
    const cumulativeCount = included.filter((event) => event.magnitude >= threshold - 1e-10).length;
    rows.push({
      magnitudeThreshold: threshold,
      binCount,
      cumulativeCount,
      log10CumulativeCount: rounded(Math.log10(cumulativeCount)),
      fittedLog10CumulativeCount: rounded(aValue - bValue * threshold),
    });
  }
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: "Gutenberg–Richter magnitude–frequency distribution",
    columns: [
      { id: "magnitudeThreshold", label: "Magnitude threshold", type: "number", unit: input.magnitudeType },
      { id: "binCount", label: "Events in bin", type: "integer", unit: "count" },
      { id: "cumulativeCount", label: "Events ≥ threshold", type: "integer", unit: "count" },
      { id: "log10CumulativeCount", label: "log10 cumulative count", type: "number", unit: null },
      { id: "fittedLog10CumulativeCount", label: "Aki MLE fitted log10 count", type: "number", unit: null },
    ],
    rows: rows.map((row) => [row.magnitudeThreshold, row.binCount, row.cumulativeCount, row.log10CumulativeCount, row.fittedLog10CumulativeCount]),
    notes: [
      `Completeness threshold Mc=${input.completenessMagnitude} ${input.magnitudeType}; bin width ΔM=${input.binWidth}.`,
      "Aki maximum-likelihood b estimate uses the discrete-bin correction Mc − ΔM/2; uncertainty is the asymptotic Aki standard error b/sqrt(N).",
    ],
  };
  const eventAuditTable = {
    schema: "agentlas.science-table/v1",
    title: "Earthquake inclusion audit",
    columns: [
      { id: "eventId", label: "USGS event id", type: "string", unit: null },
      { id: "time", label: "Origin time", type: "datetime", unit: null },
      { id: "magnitude", label: "Preferred magnitude", type: "number", unit: null },
      { id: "magnitudeType", label: "Magnitude type", type: "string", unit: null },
      { id: "included", label: "Included", type: "boolean", unit: null },
      { id: "exclusionReason", label: "Exclusion reason", type: "string", unit: null },
    ],
    rows: auditRows,
  };
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: "Gutenberg–Richter magnitude–frequency relation",
    background: "white",
    width: 560,
    height: 360,
    data: { values: rows },
    layer: [
      {
        mark: { type: "line", color: "#B85C38", strokeWidth: 2 },
        encoding: {
          x: { field: "magnitudeThreshold", type: "quantitative", title: `Magnitude (${input.magnitudeType})` },
          y: { field: "fittedLog10CumulativeCount", type: "quantitative", title: "log₁₀ N(M ≥ threshold)" },
          tooltip: [
            { field: "magnitudeThreshold", type: "quantitative", title: "Threshold" },
            { field: "fittedLog10CumulativeCount", type: "quantitative", title: "Fitted log₁₀ N", format: ".4f" },
          ],
        },
      },
      {
        mark: { type: "point", filled: true, color: "#2E6F62", size: 72 },
        encoding: {
          x: { field: "magnitudeThreshold", type: "quantitative", title: `Magnitude (${input.magnitudeType})` },
          y: { field: "log10CumulativeCount", type: "quantitative", title: "log₁₀ N(M ≥ threshold)" },
          tooltip: [
            { field: "magnitudeThreshold", type: "quantitative", title: "Threshold" },
            { field: "cumulativeCount", type: "quantitative", title: "Cumulative events" },
            { field: "binCount", type: "quantitative", title: "Events in bin" },
          ],
        },
      },
    ],
    config: { axis: { labelFontSize: 11, titleFontSize: 12 }, view: { stroke: "#D8D5D0" } },
  };
  const includedEventIds = included.map((event) => event.id).sort();
  const selection = {
    totalEvents: input.catalog.eventCount,
    includedCount: included.length,
    excludedCount: input.catalog.eventCount - included.length,
    excludedByReason,
    completenessMagnitude: input.completenessMagnitude,
    binWidth: input.binWidth,
    magnitudeType: input.magnitudeType,
    includedEventIdsSha256: sha256(stableStringify(includedEventIds)),
  };
  const estimates = {
    estimator: "Aki maximum likelihood with discrete-bin correction",
    formula: "b=log10(e)/(mean(M)-(Mc-ΔM/2))",
    uncertainty: "asymptotic Aki standard error b/sqrt(N)",
    sampleSize: included.length,
    meanMagnitude: rounded(meanMagnitude),
    effectiveThreshold: rounded(effectiveThreshold),
    aValue: rounded(aValue),
    bValue: rounded(bValue),
    standardError: rounded(standardError),
    confidenceLevel: input.confidenceLevel,
    confidenceInterval: { lower: rounded(confidenceInterval.lower), upper: rounded(confidenceInterval.upper) },
  };
  const contentReceipts = {
    publicationTable: contentReceipt("gutenberg-richter-publication-table", "application/vnd.agentlas.science-table+json", publicationTable),
    eventAuditTable: contentReceipt("gutenberg-richter-event-audit", "application/vnd.agentlas.science-table+json", eventAuditTable),
    figure: contentReceipt("gutenberg-richter-magnitude-frequency", "application/vnd.vegalite.v5+json", vegaLite),
  };
  const core = {
    schema: "agentlas.earth.gutenberg-richter-analysis/v1",
    methodRevision: "aki-mle-discrete-bin/v1",
    source: {
      provider: input.receipt.provider,
      endpoint: input.receipt.endpoint,
      requestUrl: input.receipt.requestUrl,
      requestSha256: input.requestSha256,
      rawResponseSha256: input.rawResponseSha256,
      rawResponseBytes: input.receipt.rawResponseBytes,
      normalizedCatalogSha256: input.normalizedSha256,
      timeWindow: { startTime: input.start.iso, endTime: input.end.iso, inclusive: true },
    },
    selection,
    estimates,
    publicationTable,
    eventAuditTable,
    vegaLite,
    contentReceipts,
    assumptions: [
      "Mc is supplied explicitly by the researcher; this tool does not estimate magnitude completeness.",
      "Only one explicit USGS preferred magnitude type is analyzed; cross-scale magnitude conversion is not performed.",
      "The Aki standard error and confidence interval are asymptotic and do not replace domain review of catalog independence, spatial homogeneity, or completeness.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...core, analysisSha256: sha256(stableStringify(core)) };
}

function normalizeOmoriUtsuInput(value) {
  const input = exactObject(value, [
    "catalog", "mainshockTime", "observationStartTime", "observationEndTime", "completenessStartTime",
    "completenessMagnitude", "magnitudeType", "rateBinWidthSeconds", "parameterBounds",
  ], "earth-omori-input");
  const catalogInput = validateGutenbergRichterCatalog(input.catalog);
  const mainshock = isoInstant(input.mainshockTime, "earth-omori-mainshock-time");
  const observationStart = isoInstant(input.observationStartTime, "earth-omori-observation-start-time");
  const observationEnd = isoInstant(input.observationEndTime, "earth-omori-observation-end-time");
  const completenessStart = isoInstant(input.completenessStartTime, "earth-omori-completeness-start-time");
  if (mainshock.millis >= observationStart.millis || observationStart.millis >= observationEnd.millis) {
    throw new EarthScienceError("earth-omori-observation-window-invalid", "mainshock < observation start < observation end is required");
  }
  if (completenessStart.millis < observationStart.millis || completenessStart.millis >= observationEnd.millis) {
    throw new EarthScienceError("earth-omori-completeness-window-invalid", "completeness start must lie inside the observation window and precede its end");
  }
  if (observationStart.millis < catalogInput.start.millis || observationEnd.millis > catalogInput.end.millis) {
    throw new EarthScienceError("earth-omori-window-outside-catalog", "the exact observation window must be contained by the source catalog query");
  }
  const completenessMagnitude = finite(input.completenessMagnitude, -2, 10, "earth-omori-completeness-magnitude");
  if (catalogInput.query.minMagnitude > completenessMagnitude) {
    throw new EarthScienceError("earth-omori-query-truncates-completeness", "USGS query minimum magnitude is above the declared completeness threshold");
  }
  const magnitudeType = text(input.magnitudeType, 1, 40, "earth-omori-magnitude-type").toLowerCase();
  const rateBinWidthSeconds = integer(input.rateBinWidthSeconds, 60, 31 * 24 * 60 * 60, "earth-omori-rate-bin-width-seconds");
  const fitDurationSeconds = (observationEnd.millis - completenessStart.millis) / 1_000;
  const binCount = Math.ceil(fitDurationSeconds / rateBinWidthSeconds);
  if (binCount < 4 || binCount > MAX_OMORI_UTSU_BINS) {
    throw new EarthScienceError("earth-omori-bin-count-invalid", `rate bins must produce between 4 and ${MAX_OMORI_UTSU_BINS} rows`, { binCount });
  }
  const bounds = exactObject(input.parameterBounds, ["pMin", "pMax", "cMinSeconds", "cMaxSeconds"], "earth-omori-parameter-bounds");
  const parameterBounds = {
    pMin: finite(bounds.pMin, 0.1, 5, "earth-omori-p-min"),
    pMax: finite(bounds.pMax, 0.1, 5, "earth-omori-p-max"),
    cMinSeconds: finite(bounds.cMinSeconds, 0.001, fitDurationSeconds, "earth-omori-c-min-seconds"),
    cMaxSeconds: finite(bounds.cMaxSeconds, 0.001, fitDurationSeconds, "earth-omori-c-max-seconds"),
  };
  if (parameterBounds.pMin >= parameterBounds.pMax || parameterBounds.cMinSeconds >= parameterBounds.cMaxSeconds) {
    throw new EarthScienceError("earth-omori-parameter-bounds-invalid");
  }
  return {
    ...catalogInput, mainshock, observationStart, observationEnd, completenessStart, completenessMagnitude,
    magnitudeType, rateBinWidthSeconds, fitDurationSeconds, binCount, parameterBounds,
  };
}

function omoriIntegral(p, cSeconds, startSeconds, endSeconds) {
  if (!(endSeconds > startSeconds) || !(cSeconds > 0) || !(p > 0)) return NaN;
  if (Math.abs(p - 1) < 1e-10) return Math.log((endSeconds + cSeconds) / (startSeconds + cSeconds));
  return ((endSeconds + cSeconds) ** (1 - p) - (startSeconds + cSeconds) ** (1 - p)) / (1 - p);
}

function fitBoundedOmoriUtsu(eventSeconds, startSeconds, endSeconds, bounds) {
  const score = (p, logC) => {
    const cSeconds = Math.exp(logC);
    const integral = omoriIntegral(p, cSeconds, startSeconds, endSeconds);
    if (!(integral > 0) || !Number.isFinite(integral)) return null;
    const k = eventSeconds.length / integral;
    const logLikelihood = eventSeconds.length * Math.log(k)
      - p * eventSeconds.reduce((sum, time) => sum + Math.log(time + cSeconds), 0) - k * integral;
    return Number.isFinite(logLikelihood) ? { p, cSeconds, k, logLikelihood } : null;
  };
  const pLower = bounds.pMin;
  const pUpper = bounds.pMax;
  const cLower = Math.log(bounds.cMinSeconds);
  const cUpper = Math.log(bounds.cMaxSeconds);
  let pLo = pLower;
  let pHi = pUpper;
  let cLo = cLower;
  let cHi = cUpper;
  let best = null;
  for (let round = 0; round < 6; round += 1) {
    const points = round === 0 ? 81 : 21;
    const pStep = (pHi - pLo) / (points - 1);
    const cStep = (cHi - cLo) / (points - 1);
    for (let pi = 0; pi < points; pi += 1) {
      const p = pi === points - 1 ? pHi : pLo + pi * pStep;
      for (let ci = 0; ci < points; ci += 1) {
        const logC = ci === points - 1 ? cHi : cLo + ci * cStep;
        const candidate = score(p, logC);
        if (candidate && (!best || candidate.logLikelihood > best.logLikelihood + 1e-12
          || (Math.abs(candidate.logLikelihood - best.logLikelihood) <= 1e-12 && (candidate.p < best.p
            || (candidate.p === best.p && candidate.cSeconds < best.cSeconds))))) best = candidate;
      }
    }
    if (!best) break;
    const bestLogC = Math.log(best.cSeconds);
    pLo = Math.max(pLower, best.p - pStep);
    pHi = Math.min(pUpper, best.p + pStep);
    cLo = Math.max(cLower, bestLogC - cStep);
    cHi = Math.min(cUpper, bestLogC + cStep);
  }
  if (!best) return null;
  const pTolerance = Math.max(1e-8, (pUpper - pLower) * 1e-7);
  const cTolerance = Math.max(1e-8, (cUpper - cLower) * 1e-7);
  return {
    ...best,
    atBoundary: Math.abs(best.p - pLower) <= pTolerance || Math.abs(best.p - pUpper) <= pTolerance
      || Math.abs(Math.log(best.cSeconds) - cLower) <= cTolerance || Math.abs(Math.log(best.cSeconds) - cUpper) <= cTolerance,
  };
}

function omoriVega(decayRows, status) {
  const common = { $schema: "https://vega.github.io/schema/vega-lite/v5.json", background: "white", width: 560, height: 340 };
  const decay = {
    ...common,
    title: "Omori–Utsu aftershock decay",
    data: { values: decayRows },
    layer: [
      {
        transform: [{ filter: "datum.observedRatePerDay > 0" }],
        mark: { type: "point", filled: true, color: "#2E6F62", size: 70 },
        encoding: {
          x: { field: "centerSeconds", type: "quantitative", scale: { type: "log" }, title: "Seconds since mainshock (log)" },
          y: { field: "observedRatePerDay", type: "quantitative", scale: { type: "log" }, title: "Aftershocks per day (log)" },
          tooltip: [{ field: "count", type: "quantitative" }, { field: "observedRatePerDay", type: "quantitative", format: ".5g" }],
        },
      },
      {
        transform: [{ filter: "datum.fittedRatePerDay != null && datum.fittedRatePerDay > 0" }],
        mark: { type: "line", color: "#B85C38", strokeWidth: 2 },
        encoding: {
          x: { field: "centerSeconds", type: "quantitative", scale: { type: "log" }, title: "Seconds since mainshock (log)" },
          y: { field: "fittedRatePerDay", type: "quantitative", scale: { type: "log" }, title: "Aftershocks per day (log)" },
        },
      },
    ],
    config: { axis: { labelFontSize: 11, titleFontSize: 12 }, view: { stroke: "#D8D5D0" } },
    description: `Fit status: ${status}`,
  };
  const residuals = {
    ...common,
    title: "Omori–Utsu Pearson residuals by time bin",
    data: { values: decayRows },
    layer: [
      { mark: { type: "rule", color: "#7A7772" }, encoding: { y: { datum: 0 } } },
      {
        transform: [{ filter: "datum.pearsonResidual != null" }],
        mark: { type: "bar", color: "#5C7080" },
        encoding: {
          x: { field: "centerSeconds", type: "quantitative", title: "Seconds since mainshock" },
          y: { field: "pearsonResidual", type: "quantitative", title: "Pearson residual" },
          tooltip: [{ field: "count", type: "quantitative" }, { field: "expectedCount", type: "quantitative", format: ".5g" }, { field: "pearsonResidual", type: "quantitative", format: ".4f" }],
        },
      },
    ],
    config: { axis: { labelFontSize: 11, titleFontSize: 12 }, view: { stroke: "#D8D5D0" } },
    description: `Fit status: ${status}`,
  };
  return { decay, residuals };
}

function analyzeOmoriUtsu(value) {
  const input = normalizeOmoriUtsuInput(value);
  const seenIds = new Set();
  const included = [];
  const auditRows = [];
  const excludedByReason = {
    outsideObservationWindow: 0, beforeCompletenessBoundary: 0, missingMagnitude: 0,
    magnitudeTypeMismatch: 0, belowCompletenessMagnitude: 0,
  };
  for (const rawEvent of input.catalog.observations) {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) throw new EarthScienceError("earth-omori-event-invalid");
    const id = normalizeEventId(String(rawEvent.id ?? ""));
    if (seenIds.has(id)) throw new EarthScienceError("earth-omori-event-id-duplicate");
    seenIds.add(id);
    const instant = isoInstant(rawEvent.time, "earth-omori-event-time");
    if (instant.millis < input.start.millis || instant.millis > input.end.millis) throw new EarthScienceError("earth-omori-event-outside-source-window");
    const magnitude = rawEvent.magnitude === null ? null : finite(rawEvent.magnitude, -2, 10, "earth-omori-event-magnitude");
    const magnitudeType = rawEvent.magnitudeType === null ? null : text(rawEvent.magnitudeType, 1, 40, "earth-omori-event-magnitude-type").toLowerCase();
    let exclusionReason = null;
    if (instant.millis < input.observationStart.millis || instant.millis > input.observationEnd.millis) exclusionReason = "outside-observation-window";
    else if (instant.millis < input.completenessStart.millis) exclusionReason = "before-completeness-boundary";
    else if (magnitude === null) exclusionReason = "missing-magnitude";
    else if (magnitudeType !== input.magnitudeType) exclusionReason = "magnitude-type-mismatch";
    else if (magnitude < input.completenessMagnitude) exclusionReason = "below-completeness-magnitude";
    if (exclusionReason === "outside-observation-window") excludedByReason.outsideObservationWindow += 1;
    else if (exclusionReason === "before-completeness-boundary") excludedByReason.beforeCompletenessBoundary += 1;
    else if (exclusionReason === "missing-magnitude") excludedByReason.missingMagnitude += 1;
    else if (exclusionReason === "magnitude-type-mismatch") excludedByReason.magnitudeTypeMismatch += 1;
    else if (exclusionReason === "below-completeness-magnitude") excludedByReason.belowCompletenessMagnitude += 1;
    else included.push({ id, time: instant.iso, millis: instant.millis, magnitude });
    auditRows.push([id, instant.iso, magnitude, magnitudeType, exclusionReason === null, exclusionReason]);
  }
  included.sort((left, right) => left.millis - right.millis || left.id.localeCompare(right.id));
  const startSeconds = (input.completenessStart.millis - input.mainshock.millis) / 1_000;
  const endSeconds = (input.observationEnd.millis - input.mainshock.millis) / 1_000;
  const eventSeconds = included.map((event) => (event.millis - input.mainshock.millis) / 1_000);
  const distinctSeconds = new Set(eventSeconds).size;
  const occupiedBins = new Set(eventSeconds.map((time) => Math.min(input.binCount - 1, Math.floor((time - startSeconds) / input.rateBinWidthSeconds)))).size;
  const insufficiencyReasons = [];
  if (included.length < MIN_OMORI_UTSU_EVENTS) insufficiencyReasons.push("minimum-included-events-not-met");
  if (distinctSeconds < 5) insufficiencyReasons.push("temporal-spread-inadequate");
  if (occupiedBins < 4) insufficiencyReasons.push("minimum-occupied-time-bins-not-met");
  const fit = insufficiencyReasons.length ? null : fitBoundedOmoriUtsu(eventSeconds, startSeconds, endSeconds, input.parameterBounds);
  let status = insufficiencyReasons.length ? "insufficient-data" : fit && !fit.atBoundary ? "complete" : "invalid";
  const statusReasons = [...insufficiencyReasons];
  if (!fit && !insufficiencyReasons.length) statusReasons.push("numerical-fit-failed");
  if (fit?.atBoundary) statusReasons.push("parameter-estimate-at-boundary");
  const decayRows = [];
  let pearsonChiSquare = 0;
  for (let index = 0; index < input.binCount; index += 1) {
    const binStart = startSeconds + index * input.rateBinWidthSeconds;
    const binEnd = Math.min(endSeconds, binStart + input.rateBinWidthSeconds);
    const count = eventSeconds.filter((time) => time >= binStart && (index === input.binCount - 1 ? time <= binEnd : time < binEnd)).length;
    const duration = binEnd - binStart;
    const expectedCount = fit ? fit.k * omoriIntegral(fit.p, fit.cSeconds, binStart, binEnd) : null;
    const pearsonResidual = expectedCount && expectedCount > 0 ? (count - expectedCount) / Math.sqrt(expectedCount) : null;
    if (pearsonResidual !== null) pearsonChiSquare += pearsonResidual ** 2;
    decayRows.push({
      binStartSeconds: rounded(binStart, 6), binEndSeconds: rounded(binEnd, 6), centerSeconds: rounded((binStart + binEnd) / 2, 6),
      count, observedRatePerDay: rounded(count * 86_400 / duration),
      expectedCount: expectedCount === null ? null : rounded(expectedCount),
      fittedRatePerDay: expectedCount === null ? null : rounded(expectedCount * 86_400 / duration),
      pearsonResidual: pearsonResidual === null ? null : rounded(pearsonResidual),
    });
  }
  const estimates = fit ? {
    estimator: "bounded profile Poisson maximum likelihood",
    intensityFormula: "lambda(t)=K/(t+c)^p",
    timeUnit: "second since mainshock",
    p: rounded(fit.p), cSeconds: rounded(fit.cSeconds), k: rounded(fit.k),
    kUnit: "events*second^(p-1)", logLikelihood: rounded(fit.logLikelihood), atParameterBoundary: fit.atBoundary,
    bounds: input.parameterBounds,
    search: { coarseGrid: [81, 81], refinementRounds: 5, refinementGrid: [21, 21], cAxis: "logarithmic" },
  } : null;
  const publicationTable = {
    schema: "agentlas.science-table/v1", title: "Omori–Utsu aftershock decay by time bin",
    columns: [
      { id: "binStartSeconds", label: "Bin start", type: "number", unit: "s since mainshock" },
      { id: "binEndSeconds", label: "Bin end", type: "number", unit: "s since mainshock" },
      { id: "centerSeconds", label: "Bin center", type: "number", unit: "s since mainshock" },
      { id: "count", label: "Observed events", type: "integer", unit: "count" },
      { id: "observedRatePerDay", label: "Observed rate", type: "number", unit: "events/day" },
      { id: "expectedCount", label: "Fitted expected events", type: "number", unit: "count" },
      { id: "fittedRatePerDay", label: "Fitted rate", type: "number", unit: "events/day" },
      { id: "pearsonResidual", label: "Pearson residual", type: "number", unit: null },
    ],
    rows: decayRows.map((row) => [row.binStartSeconds, row.binEndSeconds, row.centerSeconds, row.count, row.observedRatePerDay, row.expectedCount, row.fittedRatePerDay, row.pearsonResidual]),
    notes: [`Status: ${status}.`, "Zero-count bins are retained. Fit begins at the explicit time-completeness boundary."],
  };
  const eventAuditTable = {
    schema: "agentlas.science-table/v1", title: "Omori–Utsu event inclusion audit",
    columns: [
      { id: "eventId", label: "USGS event id", type: "string", unit: null },
      { id: "time", label: "Origin time", type: "datetime", unit: null },
      { id: "magnitude", label: "Preferred magnitude", type: "number", unit: null },
      { id: "magnitudeType", label: "Magnitude type", type: "string", unit: null },
      { id: "included", label: "Included", type: "boolean", unit: null },
      { id: "exclusionReason", label: "Exclusion reason", type: "string", unit: null },
    ], rows: auditRows,
  };
  const vegaLite = omoriVega(decayRows, status);
  const includedEventIdsSha256 = sha256(stableStringify(included.map((event) => event.id).sort()));
  const selection = {
    totalEvents: input.catalog.eventCount, includedCount: included.length, excludedCount: input.catalog.eventCount - included.length,
    excludedByReason, occupiedTimeBins: occupiedBins, distinctEventTimes: distinctSeconds,
    completenessMagnitude: input.completenessMagnitude, magnitudeType: input.magnitudeType,
    mainshockTime: input.mainshock.iso, observationWindow: { startTime: input.observationStart.iso, endTime: input.observationEnd.iso, inclusive: true },
    completenessStartTime: input.completenessStart.iso, rateBinWidthSeconds: input.rateBinWidthSeconds, includedEventIdsSha256,
  };
  const inputReceipt = contentReceipt("omori-utsu-fit-input", "application/vnd.agentlas.earth.omori-utsu-input+json", {
    normalizedCatalogSha256: input.normalizedSha256, rawResponseSha256: input.rawResponseSha256, requestSha256: input.requestSha256,
    selection, parameterBounds: input.parameterBounds, methodRevision: "bounded-profile-poisson-mle/v1",
  });
  const contentReceipts = {
    input: inputReceipt,
    publicationTable: contentReceipt("omori-utsu-publication-table", "application/vnd.agentlas.science-table+json", publicationTable),
    eventAuditTable: contentReceipt("omori-utsu-event-audit", "application/vnd.agentlas.science-table+json", eventAuditTable),
    decayFigure: contentReceipt("omori-utsu-decay-figure", "application/vnd.vegalite.v5+json", vegaLite.decay),
    residualFigure: contentReceipt("omori-utsu-residual-figure", "application/vnd.vegalite.v5+json", vegaLite.residuals),
  };
  const core = {
    schema: "agentlas.earth.omori-utsu-aftershock-analysis/v1", methodRevision: "bounded-profile-poisson-mle/v1", status, statusReasons,
    source: {
      provider: input.receipt.provider, endpoint: input.receipt.endpoint, requestUrl: input.receipt.requestUrl,
      requestSha256: input.requestSha256, rawResponseSha256: input.rawResponseSha256, rawResponseBytes: input.receipt.rawResponseBytes,
      normalizedCatalogSha256: input.normalizedSha256, catalogTimeWindow: { startTime: input.start.iso, endTime: input.end.iso, inclusive: true },
    },
    selection, estimates,
    diagnostics: fit ? { pearsonChiSquare: rounded(pearsonChiSquare), degreesOfFreedom: Math.max(0, input.binCount - 3), binCount: input.binCount } : null,
    publicationTable, eventAuditTable, vegaLite, contentReceipts,
    assumptions: [
      "The mainshock, observation window, time-completeness boundary, magnitude completeness, and magnitude type are researcher-supplied and are not inferred.",
      "A single Omori–Utsu sequence with non-homogeneous Poisson intensity is fit; background seismicity, secondary triggering, declustering, and forecast validation are not modeled.",
      "A boundary estimate is returned with invalid status so parameter bounds must be reviewed before scientific use.",
    ],
    rendererCompatibility: { rendererId: "agentlas.vega", hostRequired: true, bundledRenderer: false, interactive: "tooltip-only" },
  };
  return { ...core, analysisSha256: sha256(stableStringify(core)) };
}

function normalizeCoopsObservation(value, index, query) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EarthScienceError("noaa-coops-observation-invalid", `observation ${index} is invalid`);
  const rawTime = text(value.t, 16, 16, "noaa-coops-observation-time");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(rawTime)) throw new EarthScienceError("noaa-coops-observation-time-invalid");
  const timeMillis = Date.parse(`${rawTime.replace(" ", "T")}:00.000Z`);
  const canonicalMinute = Number.isFinite(timeMillis) ? new Date(timeMillis).toISOString().slice(0, 16).replace("T", " ") : "";
  if (canonicalMinute !== rawTime) throw new EarthScienceError("noaa-coops-observation-time-invalid");
  const startMillis = Date.parse(query.startTime);
  const endMillis = Date.parse(query.endTime);
  if (timeMillis < startMillis || timeMillis > endMillis) {
    throw new EarthScienceError("noaa-coops-observation-outside-window", "NOAA CO-OPS returned an observation outside the exact requested UTC window", { index, time: rawTime });
  }
  const qualityRaw = value.q === null || value.q === undefined || value.q === "" ? null : text(String(value.q), 1, 16, "noaa-coops-quality").toLowerCase();
  if (qualityRaw !== null && !new Set(["p", "v"]).has(qualityRaw)) throw new EarthScienceError("noaa-coops-quality-invalid");
  const flagsRaw = value.f === null || value.f === undefined || value.f === "" ? [] : text(String(value.f), 1, 120, "noaa-coops-flags").split(",");
  if (flagsRaw.length > 16 || flagsRaw.some((flag) => !/^[0-9A-Za-z-]{1,16}$/.test(flag))) throw new EarthScienceError("noaa-coops-flags-invalid");
  return {
    time: new Date(timeMillis).toISOString(),
    value: optionalFinite(value.v, -100_000, 100_000, "noaa-coops-water-level"),
    standardDeviation: optionalFinite(value.s, 0, 100_000, "noaa-coops-standard-deviation"),
    quality: qualityRaw === "p" ? "preliminary" : qualityRaw === "v" ? "verified" : null,
    flags: flagsRaw,
  };
}

function contentReceipt(role, mimeType, value) {
  const content = stableStringify(value);
  return { schema: "agentlas.science-content-receipt/v1", role, mimeType, bytes: Buffer.byteLength(content, "utf8"), sha256: sha256(content) };
}

function normalizeNoaaCoopsWaterLevel(raw, queryInput) {
  const query = normalizeCoopsWaterLevelInput(queryInput);
  const { beginDate: _beginDate, endDate: _endDate, ...publicQuery } = query;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EarthScienceError("noaa-coops-response-invalid");
  if (raw.error !== undefined) {
    const message = raw.error && typeof raw.error === "object" && !Array.isArray(raw.error)
      ? optionalText(raw.error.message, 2_000, "noaa-coops-provider-error-message")
      : null;
    throw new EarthScienceError("noaa-coops-provider-error", message ?? "NOAA CO-OPS returned an error response");
  }
  if (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata) || !Array.isArray(raw.data)) {
    throw new EarthScienceError("noaa-coops-response-invalid");
  }
  if (raw.data.length > MAX_COOPS_OBSERVATIONS) throw new EarthScienceError("noaa-coops-observation-limit");
  const stationId = normalizeCoopsStationId(String(raw.metadata.id ?? ""));
  if (stationId !== publicQuery.stationId) {
    throw new EarthScienceError("noaa-coops-station-mismatch", "NOAA CO-OPS response station does not match the request", { expected: publicQuery.stationId, actual: stationId });
  }
  const station = {
    id: stationId,
    name: text(String(raw.metadata.name ?? ""), 1, 500, "noaa-coops-station-name"),
    longitude: optionalFinite(raw.metadata.lon, -180, 180, "noaa-coops-station-longitude"),
    latitude: optionalFinite(raw.metadata.lat, -90, 90, "noaa-coops-station-latitude"),
    coordinateReferenceSystem: "EPSG:4326",
  };
  if (station.longitude === null || station.latitude === null) throw new EarthScienceError("noaa-coops-station-coordinate-missing");
  const observations = raw.data.map((value, index) => normalizeCoopsObservation(value, index, publicQuery))
    .sort((left, right) => left.time.localeCompare(right.time));
  for (let index = 1; index < observations.length; index += 1) {
    if (observations[index - 1].time === observations[index].time) throw new EarthScienceError("noaa-coops-observation-time-duplicate");
  }
  const valueUnit = publicQuery.units === "metric" ? "m" : "ft";
  const stationGeojson = {
    type: "Feature",
    id: station.id,
    geometry: { type: "Point", coordinates: [station.longitude, station.latitude] },
    properties: { stationId: station.id, name: station.name, provider: "NOAA CO-OPS" },
  };
  const table = {
    schema: "agentlas.science-table/v1",
    columns: [
      { id: "time", label: "Observation time (UTC)", type: "datetime", unit: null },
      { id: "waterLevel", label: `Water level relative to ${publicQuery.datum}`, type: "number", unit: valueUnit },
      { id: "standardDeviation", label: "Standard deviation", type: "number", unit: valueUnit },
      { id: "quality", label: "NOAA verification state", type: "string", unit: null },
      { id: "flags", label: "NOAA quality flags", type: "string", unit: null },
    ],
    rows: observations.map((item) => [item.time, item.value, item.standardDeviation, item.quality, item.flags.join(",")]),
  };
  const vegaLite = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    description: `NOAA CO-OPS observed water level at station ${station.id}; no interpolation or prediction.`,
    data: { values: observations.map((item) => ({ time: item.time, waterLevel: item.value, quality: item.quality })) },
    mark: { type: "line", point: false },
    encoding: {
      x: { field: "time", type: "temporal", title: "UTC" },
      y: { field: "waterLevel", type: "quantitative", title: `Water level (${valueUnit}, ${publicQuery.datum})`, scale: { zero: false } },
      color: { field: "quality", type: "nominal", title: "NOAA state" },
      tooltip: [
        { field: "time", type: "temporal", title: "UTC" },
        { field: "waterLevel", type: "quantitative", title: `Water level (${valueUnit})` },
        { field: "quality", type: "nominal", title: "NOAA state" },
      ],
    },
  };
  const contentReceipts = {
    stationGeojson: contentReceipt("station-geojson", "application/geo+json", stationGeojson),
    observationTable: contentReceipt("water-level-observation-table", "application/vnd.agentlas.science-table+json", table),
    timeSeriesFigure: contentReceipt("water-level-time-series", "application/vnd.vegalite.v5+json", vegaLite),
  };
  const warnings = [];
  if (!observations.length) warnings.push("NOAA CO-OPS returned no water-level observations for the exact station and UTC interval.");
  if (observations.some((item) => item.value === null)) warnings.push("Some NOAA CO-OPS water-level values are missing and remain null; no interpolation was applied.");
  if (observations.some((item) => item.quality === "preliminary")) warnings.push("The series contains NOAA preliminary observations that may be revised after verification.");
  const normalized = {
    schema: "agentlas.earth.noaa-coops-water-level-series/v1",
    source: {
      provider: "NOAA Center for Operational Oceanographic Products and Services",
      collection: "CO-OPS Water Level Observations",
      canonicalUri: `noaa-coops:station:${station.id}:water-level`,
      endpoint: NOAA_COOPS_ENDPOINT,
    },
    query: publicQuery,
    station,
    measurement: { phenomenon: "water-level", valueUnit, verticalDatum: publicQuery.datum, timeZone: "UTC", samplingInterval: "provider-observed" },
    observationCount: observations.length,
    observations,
    stationGeojson,
    table,
    vegaLite,
    contentReceipts,
    rendererCompatibility: {
      primaryMimeType: "application/vnd.vegalite.v5+json",
      hostRequired: true,
      rendererIds: ["agentlas.vega", "agentlas.maplibre", "agentlas.cesium"],
      bundledRenderer: false,
    },
    warnings,
  };
  return { ...normalized, normalizedSha256: sha256(stableStringify(normalized)) };
}

function normalizeContentManifest(contents, productIndex) {
  if (contents === null || contents === undefined) return [];
  if (!contents || typeof contents !== "object" || Array.isArray(contents)) throw new EarthScienceError("usgs-product-content-invalid");
  const entries = Object.entries(contents);
  if (entries.length > MAX_PRODUCT_CONTENTS) throw new EarthScienceError("usgs-product-content-limit");
  return entries.map(([path, content], index) => {
    const safePath = path === "" ? "" : text(path, 1, 1_024, "usgs-product-content-path");
    if (safePath.startsWith("/") || safePath.includes("\\") || safePath.split("/").includes("..")) throw new EarthScienceError("usgs-product-content-path-invalid");
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new EarthScienceError("usgs-product-content-invalid", `product ${productIndex} content ${index} is invalid`);
    const length = optionalInteger(content.length, 0, Number.MAX_SAFE_INTEGER, "usgs-product-content-length");
    const lastModified = content.lastModified === null || content.lastModified === undefined ? null : integer(content.lastModified, -8_640_000_000_000_000, 8_640_000_000_000_000, "usgs-product-content-modified");
    const sha256Base64 = optionalText(content.sha256, 200, "usgs-product-content-sha256");
    if (sha256Base64 !== null && !/^[A-Za-z0-9+/]{43}=$/.test(sha256Base64)) throw new EarthScienceError("usgs-product-content-sha256-invalid");
    return {
      path: safePath,
      contentType: optionalText(content.contentType, 200, "usgs-product-content-type"),
      lengthBytes: length,
      lastModifiedAt: lastModified === null ? null : new Date(lastModified).toISOString(),
      url: safeHttpsUrl(content.url, new Set(["earthquake.usgs.gov"]), "usgs-product-content-url"),
      sha256Base64,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeProduct(product, inferredType, index) {
  if (!product || typeof product !== "object" || Array.isArray(product)) throw new EarthScienceError("usgs-product-invalid");
  const type = optionalText(product.type, 80, "usgs-product-type") ?? inferredType;
  if (type !== inferredType) throw new EarthScienceError("usgs-product-type-mismatch");
  const updateTime = integer(product.updateTime, -8_640_000_000_000_000, 8_640_000_000_000_000, "usgs-product-update-time");
  const content = normalizeContentManifest(product.contents ?? product.content, index);
  return {
    id: text(String(product.id ?? ""), 1, 500, "usgs-product-id"),
    type,
    source: text(String(product.source ?? ""), 1, 80, "usgs-product-source"),
    code: text(String(product.code ?? ""), 1, 160, "usgs-product-code"),
    updatedAt: new Date(updateTime).toISOString(),
    updateTime,
    status: text(String(product.status ?? ""), 1, 80, "usgs-product-status"),
    preferredWeight: integer(product.preferredWeight, -2_147_483_648, 2_147_483_647, "usgs-product-preferred-weight"),
    properties: product.properties && typeof product.properties === "object" && !Array.isArray(product.properties) ? product.properties : {},
    content,
    contentCount: content.length,
    declaredContentBytes: content.reduce((total, item) => total + (item.lengthBytes ?? 0), 0),
  };
}

function normalizeProducts(value) {
  if (value === null || value === undefined) return { inventory: [], byType: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EarthScienceError("usgs-products-invalid");
  const inventory = [];
  for (const [type, products] of Object.entries(value)) {
    if (!/^[a-z0-9-]{1,80}$/.test(type) || !Array.isArray(products)) throw new EarthScienceError("usgs-product-group-invalid");
    for (const product of products) {
      if (inventory.length >= MAX_PRODUCTS) throw new EarthScienceError("usgs-product-limit");
      inventory.push(normalizeProduct(product, type, inventory.length));
    }
  }
  inventory.sort((left, right) => left.type.localeCompare(right.type) || right.preferredWeight - left.preferredWeight || right.updateTime - left.updateTime || left.id.localeCompare(right.id));
  const byType = {};
  for (const product of inventory) byType[product.type] = (byType[product.type] ?? 0) + 1;
  return { inventory, byType };
}

function preferredProduct(inventory, type) {
  return inventory.filter((product) => product.type === type && product.status.toUpperCase() !== "DELETE")
    .sort((left, right) => right.preferredWeight - left.preferredWeight || right.updateTime - left.updateTime || left.id.localeCompare(right.id))[0] ?? null;
}

function productNumber(properties, key, min, max, label) {
  return optionalFinite(properties[key], min, max, label);
}

function productInteger(properties, key, min, max, label) {
  return optionalInteger(properties[key], min, max, label);
}

function scientificOrigin(product) {
  if (!product) return null;
  const properties = product.properties;
  return {
    productId: product.id,
    source: product.source,
    code: product.code,
    updatedAt: product.updatedAt,
    evaluationStatus: optionalText(properties["evaluation-status"], 80, "usgs-origin-evaluation-status"),
    reviewStatus: optionalText(properties["review-status"], 80, "usgs-origin-review-status"),
    depthType: optionalText(properties["depth-type"], 160, "usgs-origin-depth-type"),
    eventType: optionalText(properties["event-type"] ?? properties.eventtype, 120, "usgs-origin-event-type"),
    originTime: optionalIsoInstant(properties.eventtime, "usgs-origin-time"),
    location: {
      longitude: productNumber(properties, "longitude", -180, 180, "usgs-origin-longitude"),
      latitude: productNumber(properties, "latitude", -90, 90, "usgs-origin-latitude"),
      depthKm: productNumber(properties, "depth", -100, 1_000, "usgs-origin-depth"),
    },
    magnitude: {
      value: productNumber(properties, "magnitude", -2, 10, "usgs-origin-magnitude"),
      type: optionalText(properties["magnitude-type"], 40, "usgs-origin-magnitude-type"),
      source: optionalText(properties["magnitude-source"], 80, "usgs-origin-magnitude-source"),
      stationCount: productInteger(properties, "magnitude-num-stations-used", 0, 2_147_483_647, "usgs-origin-magnitude-stations"),
    },
    quality: {
      stationCount: productInteger(properties, "num-stations-used", 0, 2_147_483_647, "usgs-origin-stations"),
      phaseCount: productInteger(properties, "num-phases-used", 0, 2_147_483_647, "usgs-origin-phases"),
      azimuthalGapDeg: productNumber(properties, "azimuthal-gap", 0, 360, "usgs-origin-gap"),
      minimumStationDistanceDeg: productNumber(properties, "minimum-distance", 0, 180, "usgs-origin-minimum-distance"),
      rmsTravelTimeResidualSec: productNumber(properties, "standard-error", 0, 100_000, "usgs-origin-standard-error"),
    },
    uncertainty: {
      originTimeErrorSec: productNumber(properties, "eventtime-error", 0, 100_000, "usgs-origin-time-error"),
      horizontalErrorKm: productNumber(properties, "horizontal-error", 0, 100_000, "usgs-origin-horizontal-error"),
      verticalErrorKm: productNumber(properties, "vertical-error", 0, 100_000, "usgs-origin-vertical-error"),
      latitudeErrorDeg: productNumber(properties, "latitude-error", 0, 180, "usgs-origin-latitude-error"),
      longitudeErrorDeg: productNumber(properties, "longitude-error", 0, 360, "usgs-origin-longitude-error"),
      magnitudeError: productNumber(properties, "magnitude-error", 0, 100, "usgs-origin-magnitude-error"),
      errorEllipse: {
        semiMajorAxisM: productNumber(properties, "error-ellipse-major", 0, 100_000_000, "usgs-origin-error-ellipse-major"),
        semiIntermediateAxisM: productNumber(properties, "error-ellipse-intermediate", 0, 100_000_000, "usgs-origin-error-ellipse-intermediate"),
        semiMinorAxisM: productNumber(properties, "error-ellipse-minor", 0, 100_000_000, "usgs-origin-error-ellipse-minor"),
        majorAxisAzimuthDeg: productNumber(properties, "error-ellipse-azimuth", -360, 360, "usgs-origin-error-ellipse-azimuth"),
        majorAxisPlungeDeg: productNumber(properties, "error-ellipse-plunge", -360, 360, "usgs-origin-error-ellipse-plunge"),
        majorAxisRotationDeg: productNumber(properties, "error-ellipse-rotation", -360, 360, "usgs-origin-error-ellipse-rotation"),
      },
      confidenceLevel: null,
      confidenceLevelNote: "USGS origin product fields do not provide a uniform confidence level; values are preserved without inventing one.",
    },
  };
}

function normalizeUsgsEventDetail(raw, expectedEventId = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.type !== "Feature") throw new EarthScienceError("usgs-event-detail-invalid");
  const event = normalizeEventFeature(raw);
  if (expectedEventId !== null && event.id !== normalizeEventId(expectedEventId)) {
    throw new EarthScienceError("usgs-event-detail-id-mismatch", "USGS event detail id does not match the requested event id", { expectedEventId, actualEventId: event.id });
  }
  const products = normalizeProducts(raw.properties?.products);
  const originProduct = preferredProduct(products.inventory, "origin") ?? preferredProduct(products.inventory, "phase-data");
  const preferredOrigin = scientificOrigin(originProduct);
  const pointGeojson = {
    type: "Feature",
    id: event.id,
    geometry: { type: "Point", coordinates: [event.longitude, event.latitude, event.depthKm] },
    properties: { time: event.time, magnitude: event.magnitude, magnitudeType: event.magnitudeType, place: event.place, status: event.status, network: event.network },
  };
  const parameterTable = {
    schema: "agentlas.science-table/v1",
    columns: [
      { id: "eventId", label: "USGS event id", type: "string", unit: null },
      { id: "originTime", label: "Origin time", type: "datetime", unit: null },
      { id: "longitude", label: "Longitude", type: "number", unit: "degree" },
      { id: "latitude", label: "Latitude", type: "number", unit: "degree" },
      { id: "depthKm", label: "Depth", type: "number", unit: "km" },
      { id: "magnitude", label: "Magnitude", type: "number", unit: null },
      { id: "horizontalErrorKm", label: "Horizontal error", type: "number", unit: "km" },
      { id: "verticalErrorKm", label: "Vertical error", type: "number", unit: "km" },
      { id: "originTimeErrorSec", label: "Origin-time error", type: "number", unit: "s" },
      { id: "magnitudeError", label: "Magnitude error", type: "number", unit: null },
      { id: "stationCount", label: "Stations used", type: "integer", unit: "count" },
      { id: "phaseCount", label: "Phases used", type: "integer", unit: "count" },
    ],
    rows: [[
      event.id,
      preferredOrigin?.originTime ?? event.time,
      preferredOrigin?.location.longitude ?? event.longitude,
      preferredOrigin?.location.latitude ?? event.latitude,
      preferredOrigin?.location.depthKm ?? event.depthKm,
      preferredOrigin?.magnitude.value ?? event.magnitude,
      preferredOrigin?.uncertainty.horizontalErrorKm ?? null,
      preferredOrigin?.uncertainty.verticalErrorKm ?? null,
      preferredOrigin?.uncertainty.originTimeErrorSec ?? null,
      preferredOrigin?.uncertainty.magnitudeError ?? null,
      preferredOrigin?.quality.stationCount ?? event.quality.stationCount,
      preferredOrigin?.quality.phaseCount ?? null,
    ]],
  };
  const productTable = {
    schema: "agentlas.science-table/v1",
    columns: [
      { id: "type", label: "Product type", type: "string", unit: null },
      { id: "source", label: "Source network", type: "string", unit: null },
      { id: "status", label: "Status", type: "string", unit: null },
      { id: "updatedAt", label: "Updated", type: "datetime", unit: null },
      { id: "preferredWeight", label: "Preferred weight", type: "integer", unit: null },
      { id: "contentCount", label: "Content files", type: "integer", unit: "count" },
      { id: "declaredContentBytes", label: "Declared content size", type: "integer", unit: "byte" },
    ],
    rows: products.inventory.map((product) => [product.type, product.source, product.status, product.updatedAt, product.preferredWeight, product.contentCount, product.declaredContentBytes]),
  };
  const normalized = {
    schema: "agentlas.earth.usgs-earthquake-event-detail/v1",
    source: {
      provider: "USGS Earthquake Hazards Program",
      collection: "ANSS Comprehensive Earthquake Catalog (ComCat)",
      canonicalUri: `usgs:event:${event.id}`,
      endpoint: USGS_ENDPOINT,
    },
    event,
    preferredOrigin,
    productCount: products.inventory.length,
    productTypes: products.byType,
    products: products.inventory.map(({ properties, updateTime, ...product }) => product),
    pointGeojson,
    parameterTable,
    productTable,
    rendererCompatibility: {
      geojsonMimeType: "application/geo+json",
      tableSchema: "agentlas.science-table/v1",
      rendererIds: ["agentlas.maplibre", "agentlas.cesium", "agentlas.vega"],
      bundledRenderer: false,
    },
    warnings: preferredOrigin ? [] : ["No active USGS origin or phase-data product was present; detailed uncertainty fields are unavailable."],
  };
  return { ...normalized, normalizedSha256: sha256(stableStringify(normalized)) };
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
    } finally {
      release();
    }
  };
}

function responseContentType(response) {
  return String(response.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

function validateContentType(response, providerLabel) {
  const actual = responseContentType(response);
  if (!CONTENT_TYPES.has(actual)) throw new EarthScienceError("earth-provider-content-type-denied", `${providerLabel} response Content-Type is not allowed`, { actual: actual || null });
  return actual;
}

function precheckContentLength(response, maxBytes, providerLabel) {
  const header = response.headers?.get?.("content-length");
  if (header === null || header === undefined || header === "") return;
  if (!/^[0-9]+$/.test(String(header))) throw new EarthScienceError("earth-provider-content-length-invalid");
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw new EarthScienceError("earth-provider-content-length-invalid");
  if (length > maxBytes) throw new EarthScienceError("earth-provider-response-too-large", `${providerLabel} Content-Length exceeds the response limit`, { contentLength: length, maxBytes });
}

async function readBoundedBody(response, maxBytes, providerLabel) {
  precheckContentLength(response, maxBytes, providerLabel);
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* response cap already enforced */ }
        throw new EarthScienceError("earth-provider-response-too-large", `${providerLabel} streamed response exceeds the response limit`, { receivedBytes: total, maxBytes });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response.arrayBuffer !== "function") throw new EarthScienceError("earth-provider-response-invalid");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new EarthScienceError("earth-provider-response-too-large");
  return bytes;
}

function parseJsonBytes(bytes, providerLabel) {
  let jsonText;
  try { jsonText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (error) { throw new EarthScienceError("earth-provider-utf8-invalid", `${providerLabel} response is not valid UTF-8`, null, error); }
  try { return JSON.parse(jsonText); } catch (error) { throw new EarthScienceError("earth-provider-json-invalid", `${providerLabel} response is not valid JSON`, null, error); }
}

function parseRetryAfter(value, nowMs, maxRetryAfterMs) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  let milliseconds;
  if (/^\d+$/.test(raw)) milliseconds = Number(raw) * 1_000;
  else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    milliseconds = Math.max(0, at - nowMs);
  }
  return Math.min(milliseconds, maxRetryAfterMs);
}

function createEarthScienceClient(options = {}) {
  exactObject(options, ["fetchImpl", "clockMs", "sleep", "minIntervalMs", "timeoutMs", "maxResponseBytes", "retries", "retryDelayMs", "maxRetryAfterMs"], "earth-client-options");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new EarthScienceError("earth-fetch-unavailable");
  const clockMs = options.clockMs ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const minIntervalMs = options.minIntervalMs === undefined ? 1_000 : integer(options.minIntervalMs, 0, 60_000, "earth-min-interval");
  const timeoutMs = options.timeoutMs === undefined ? 15_000 : integer(options.timeoutMs, 1, 120_000, "earth-timeout");
  const maxResponseBytes = options.maxResponseBytes === undefined ? MAX_RESPONSE_BYTES : integer(options.maxResponseBytes, 1, MAX_RESPONSE_BYTES, "earth-max-response-bytes");
  const retries = options.retries === undefined ? 2 : integer(options.retries, 0, 4, "earth-retries");
  const retryDelayMs = options.retryDelayMs === undefined ? 250 : integer(options.retryDelayMs, 0, 10_000, "earth-retry-delay");
  const maxRetryAfterMs = options.maxRetryAfterMs === undefined ? 10_000 : integer(options.maxRetryAfterMs, 0, 60_000, "earth-max-retry-after");
  const gate = createRateGate({ minIntervalMs, clockMs, sleep });

  async function requestJson(request, kind) {
    const officialUrl = kind === "noaa-water-level" ? assertOfficialNoaaCoopsUrl(request.url) : assertOfficialUsgsUrl(request.url, kind);
    const providerLabel = kind === "noaa-water-level" ? "NOAA CO-OPS" : "USGS";
    return gate(async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(officialUrl, {
            method: "GET",
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
            redirect: "error",
            signal: controller.signal,
          });
          if (!response || typeof response !== "object") throw new EarthScienceError("earth-provider-response-invalid");
          if (response.redirected) throw new EarthScienceError("earth-provider-redirect-denied");
          if (response.url) {
            let finalUrl;
            try { finalUrl = new URL(response.url).toString(); } catch { throw new EarthScienceError("earth-provider-final-url-invalid"); }
            if (finalUrl !== officialUrl) throw new EarthScienceError("earth-provider-final-url-denied", `${providerLabel} response URL differs from the exact request URL`, { expected: officialUrl, actual: finalUrl });
          }
          if (!response.ok) {
            const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"), clockMs(), maxRetryAfterMs);
            const error = new EarthScienceError("earth-provider-http-error", `${providerLabel} request failed with HTTP ${response.status}`, { status: response.status, retryAfterMs, attempt });
            if (RETRYABLE_STATUS_CODES.has(response.status) && attempt <= retries) {
              await sleep(retryAfterMs ?? retryDelayMs * (2 ** (attempt - 1)));
              lastError = error;
              continue;
            }
            throw error;
          }
          const contentType = validateContentType(response, providerLabel);
          const bytes = await readBoundedBody(response, maxResponseBytes, providerLabel);
          return {
            bytes,
            parsed: parseJsonBytes(bytes, providerLabel),
            attempts: attempt,
            contentType,
            retrievedAt: new Date(clockMs()).toISOString(),
            httpStatus: response.status,
            responseUrl: response.url ? new URL(response.url).toString() : officialUrl,
          };
        } catch (error) {
          if (error?.name === "AbortError") throw new EarthScienceError("earth-provider-timeout", `${providerLabel} request timed out`, { timeoutMs });
          if (error instanceof EarthScienceError) throw error;
          lastError = new EarthScienceError("earth-provider-network-error", `${providerLabel} request failed`, { attempt }, error);
          if (attempt <= retries) {
            await sleep(retryDelayMs * (2 ** (attempt - 1)));
            continue;
          }
          throw lastError;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError ?? new EarthScienceError("earth-provider-request-failed");
    });
  }

  function receipt(request, response, normalized, itemCount, provider = "usgs") {
    const requestDescriptor = { method: "GET", url: request.url, accept: "application/json", userAgent: USER_AGENT };
    const isNoaa = provider === "noaa-coops";
    return {
      schema: "agentlas.science-source-receipt/v1",
      provider: isNoaa ? "NOAA Center for Operational Oceanographic Products and Services" : "USGS Earthquake Hazards Program",
      endpoint: isNoaa ? NOAA_COOPS_ENDPOINT : USGS_ENDPOINT,
      requestUrl: request.url,
      requestSha256: sha256(stableStringify(requestDescriptor)),
      responseUrl: response.responseUrl,
      httpStatus: response.httpStatus,
      rawResponseSha256: sha256(response.bytes),
      rawResponseBytes: response.bytes.length,
      responseContentType: response.contentType,
      normalizedSha256: normalized.normalizedSha256,
      retrievedAt: response.retrievedAt,
      attempts: response.attempts,
      itemCount,
      network: {
        method: "GET",
        requestUrl: request.url,
        accept: "application/json",
        userAgent: USER_AGENT,
        responseUrl: response.responseUrl,
        httpStatus: response.httpStatus,
        responseContentType: response.contentType,
        rawResponseBytes: response.bytes.length,
        rawResponseSha256: sha256(response.bytes),
        redirects: "denied",
        attempts: response.attempts,
      },
      limits: isNoaa
        ? { responseBytes: maxResponseBytes, observations: MAX_COOPS_OBSERVATIONS, querySpanDays: 31, minIntervalMs, timeoutMs, retries }
        : { responseBytes: maxResponseBytes, events: MAX_EVENTS, products: MAX_PRODUCTS, querySpanDays: 366, maxOffset: MAX_OFFSET, minIntervalMs, timeoutMs, retries },
    };
  }

  return {
    async searchUsgsEarthquakes(input) {
      const request = buildUsgsUrl(input);
      const response = await requestJson(request, "search");
      const normalized = normalizeUsgsGeoJson(response.parsed, { orderBy: request.input.orderBy, offset: request.input.offset, limit: request.input.limit });
      return { ...normalized, query: request.input, provenance: receipt(request, response, normalized, normalized.eventCount) };
    },
    async getUsgsEventDetail(input) {
      const request = buildUsgsEventDetailUrl(input);
      const response = await requestJson(request, "detail");
      const normalized = normalizeUsgsEventDetail(response.parsed, request.input.eventId);
      return { ...normalized, query: request.input, provenance: receipt(request, response, normalized, 1) };
    },
    async fetchNoaaCoopsWaterLevels(input) {
      const request = buildNoaaCoopsWaterLevelUrl(input);
      const response = await requestJson(request, "noaa-water-level");
      const normalized = normalizeNoaaCoopsWaterLevel(response.parsed, request.input);
      return { ...normalized, provenance: receipt(request, response, normalized, normalized.observationCount, "noaa-coops") };
    },
  };
}

module.exports = {
  CONTENT_TYPES,
  EarthScienceError,
  MIN_GUTENBERG_RICHTER_EVENTS,
  MIN_OMORI_UTSU_EVENTS,
  MAX_OMORI_UTSU_BINS,
  MAX_GUTENBERG_RICHTER_EVENTS,
  MAX_COOPS_OBSERVATIONS,
  MAX_COOPS_SPAN_MS,
  MAX_EVENTS,
  MAX_OFFSET,
  MAX_PRODUCTS,
  MAX_QUERY_SPAN_MS,
  MAX_RESPONSE_BYTES,
  NOAA_COOPS_ENDPOINT,
  PLUGIN_VERSION,
  RETRYABLE_STATUS_CODES,
  USGS_ENDPOINT,
  USER_AGENT,
  assertOfficialUsgsUrl,
  assertOfficialNoaaCoopsUrl,
  analyzeGutenbergRichter,
  analyzeOmoriUtsu,
  buildNoaaCoopsWaterLevelUrl,
  buildUsgsEventDetailUrl,
  buildUsgsUrl,
  canonicalValue,
  createEarthScienceClient,
  normalizeSearchInput,
  normalizeCoopsWaterLevelInput,
  normalizeNoaaCoopsWaterLevel,
  normalizeGutenbergRichterInput,
  normalizeOmoriUtsuInput,
  omoriIntegral,
  normalizeUsgsEventDetail,
  normalizeUsgsGeoJson,
  sha256,
  stableStringify,
};
