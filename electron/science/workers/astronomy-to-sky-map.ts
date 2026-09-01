import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { createHash } from "node:crypto";
import {
  SCIENCE_ASTRONOMY_SOURCE_AUTHORITY,
  createScienceAstronomyRendererReceipt,
  isScienceAstronomySourceAuthority,
  type ScienceAstronomySourceAuthority,
} from "../../../shared/science-astronomy";

const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram"]);
const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function blockedNetwork(request: unknown, ...rest: unknown[]) {
  if (typeof request === "string" && NETWORK_MODULES.has(request)) throw new Error("science-tool-network-denied");
  return originalLoad.call(this, request, ...rest);
};
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

type CatalogObject = {
  id: string; mainId: string; raDeg: number; decDeg: number; objectType: string; spectralType: string | null;
  parallaxMas: number | null; properMotionRaMasYr: number | null; properMotionDecMasYr: number | null;
  radialVelocityKmS: number | null; redshift: number | null;
};

type Input = {
  schema: "agentlas.science-astronomy-to-sky-map-input/v1";
  title: string;
  catalogRunId: string;
  catalogOutputSha256: string;
  rawResponseSha256: string;
  provider: "simbad-tap";
  query: { centerRaDeg: number; centerDecDeg: number; radiusDeg: number; limit: number; adql: string };
  sourceId: string;
  sourceVersionId: string;
  receipt: {
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
      responseBytes: number; objects: number; radiusDeg: number; rateIntervalMs: number;
      timeoutMs: number; retries: number; maxSourceAgeMs: number;
    };
  };
  objects: CatalogObject[];
};

function fail(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
function exactObject(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid-${field}`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== allowed.length || Object.keys(record).some((key) => !allowed.includes(key))) fail(`invalid-${field}`);
  return record;
}
function text(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(`invalid-${field}`);
  return value.trim();
}
function finite(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail(`invalid-${field}`);
  return value;
}
function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(`invalid-${field}`);
  return value as number;
}
function nullableFinite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`invalid-${field}`);
  return Object.is(value, -0) ? 0 : value;
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) fail(`invalid-${field}`);
  return value;
}
function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) fail(`invalid-${field}`);
  return value;
}
function isoDate(value: unknown, field: string): string {
  const exact = text(value, 80, field);
  const milliseconds = Date.parse(exact);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== exact) fail(`invalid-${field}`);
  return exact;
}
function decimal(value: number): string { return Object.is(value, -0) ? "0" : String(value); }
function compareObjects(left: CatalogObject, right: CatalogObject): number {
  if (left.mainId !== right.mainId) return left.mainId < right.mainId ? -1 : 1;
  return left.raDeg - right.raDeg || left.decDeg - right.decDeg;
}

function main(): void {
  const [inputArg, outputArg] = process.argv.slice(2);
  const cwd = fs.realpathSync(process.cwd());
  const inputPath = path.resolve(String(inputArg ?? ""));
  const outputPath = path.resolve(String(outputArg ?? ""));
  if (inputPath !== path.join(cwd, "input.json") || outputPath !== path.join(cwd, "output.json")) fail("science-tool-path-denied");
  const inputStat = fs.lstatSync(inputPath);
  if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size < 2 || inputStat.size > 8 * 1024 * 1024) fail("science-tool-input-invalid");
  let input: Input;
  try { input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as Input; }
  catch { fail("science-tool-input-json-invalid"); }
  exactObject(input, ["schema", "title", "catalogRunId", "catalogOutputSha256", "rawResponseSha256", "provider", "query", "sourceId", "sourceVersionId", "receipt", "objects"], "input-schema");
  if (!input || input.schema !== "agentlas.science-astronomy-to-sky-map-input/v1" || input.provider !== "simbad-tap") fail("science-tool-input-schema-invalid");
  const title = text(input.title, 240, "title");
  const catalogRunId = uuid(input.catalogRunId, "catalog-run-id");
  const catalogOutputSha256 = sha256(input.catalogOutputSha256, "catalog-output-sha");
  const rawResponseSha256 = sha256(input.rawResponseSha256, "raw-response-sha");
  const sourceId = uuid(input.sourceId, "source-id");
  const sourceVersionId = uuid(input.sourceVersionId, "source-version-id");
  exactObject(input.query, ["centerRaDeg", "centerDecDeg", "radiusDeg", "limit", "adql"], "query");
  const centerRaDeg = finite(input.query?.centerRaDeg, 0, 359.99999999, "center-ra");
  const centerDecDeg = finite(input.query?.centerDecDeg, -90, 90, "center-dec");
  const radiusDeg = finite(input.query?.radiusDeg, 0.001, 10, "radius");
  const limit = integer(input.query?.limit, 1, 500, "limit");
  const adql = text(input.query?.adql, 20_000, "adql");
  if (input.query.adql !== adql) fail("science-tool-query-adql-invalid");
  const expectedAdql = `SELECT TOP ${limit} main_id,ra,dec,otype,sp_type,plx_value,pmra,pmdec,rvz_radvel,rvz_redshift FROM basic WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${decimal(centerRaDeg)},${decimal(centerDecDeg)},${decimal(radiusDeg)})) ORDER BY main_id`;
  if (adql !== expectedAdql) fail("science-tool-query-adql-invalid");
  if (!Array.isArray(input.objects) || input.objects.length > limit) fail("science-tool-catalog-objects-invalid");
  const objects = input.objects.map((object, index) => {
    exactObject(object, ["id", "mainId", "raDeg", "decDeg", "objectType", "spectralType", "parallaxMas", "properMotionRaMasYr", "properMotionDecMasYr", "radialVelocityKmS", "redshift"], `object-${index}`);
    return {
    id: uuid(object.id, `object-${index}-id`),
    mainId: text(object.mainId, 500, `object-${index}-main-id`),
    raDeg: finite(object.raDeg, 0, 359.99999999, `object-${index}-ra`),
    decDeg: finite(object.decDeg, -90, 90, `object-${index}-dec`),
    objectType: text(object.objectType, 80, `object-${index}-type`),
    spectralType: object.spectralType === null ? null : text(object.spectralType, 160, `object-${index}-spectral-type`),
    parallaxMas: nullableFinite(object.parallaxMas, `object-${index}-parallax`),
    properMotionRaMasYr: nullableFinite(object.properMotionRaMasYr, `object-${index}-proper-motion-ra`),
    properMotionDecMasYr: nullableFinite(object.properMotionDecMasYr, `object-${index}-proper-motion-dec`),
    radialVelocityKmS: nullableFinite(object.radialVelocityKmS, `object-${index}-radial-velocity`),
    redshift: nullableFinite(object.redshift, `object-${index}-redshift`),
  }; });
  if (new Set(objects.map((object) => object.id)).size !== objects.length) fail("science-tool-catalog-object-duplicate");
  if (JSON.stringify([...objects].sort(compareObjects)) !== JSON.stringify(objects)) fail("science-tool-catalog-object-order-invalid");
  exactObject(input.receipt, ["provider", "sourceAuthority", "endpoint", "requestSha256", "responseSha256", "retrievedAt", "durationMs", "httpStatus", "rowCount", "contentType", "byteSize", "attempts", "normalizedSha256", "limits"], "receipt");
  if (input.receipt.provider !== "simbad-tap" || !isScienceAstronomySourceAuthority(input.receipt.sourceAuthority)
    || input.receipt.endpoint !== SCIENCE_ASTRONOMY_SOURCE_AUTHORITY.endpoint) fail("science-tool-source-authority-invalid");
  const requestSha256 = sha256(input.receipt.requestSha256, "request-sha");
  const responseSha256 = sha256(input.receipt.responseSha256, "response-sha");
  const normalizedSha256 = sha256(input.receipt.normalizedSha256, "normalized-sha");
  const requestUrl = new URL(SCIENCE_ASTRONOMY_SOURCE_AUTHORITY.endpoint);
  requestUrl.searchParams.append("REQUEST", "doQuery");
  requestUrl.searchParams.append("LANG", "ADQL");
  requestUrl.searchParams.append("FORMAT", "json");
  requestUrl.searchParams.append("QUERY", adql);
  const expectedRequestSha256 = createHash("sha256").update(requestUrl.toString(), "utf8").digest("hex");
  if (requestSha256 !== expectedRequestSha256 || responseSha256 !== rawResponseSha256) fail("science-tool-receipt-hash-invalid");
  const retrievedAt = isoDate(input.receipt.retrievedAt, "retrieved-at");
  integer(input.receipt.durationMs, 0, Number.MAX_SAFE_INTEGER, "duration-ms");
  if (input.receipt.httpStatus !== 200 || !["application/json", "text/json"].includes(input.receipt.contentType)
    || integer(input.receipt.rowCount, 0, 500, "row-count") !== objects.length
    || integer(input.receipt.byteSize, 2, 8 * 1024 * 1024, "byte-size") < 2
    || integer(input.receipt.attempts, 1, 3, "attempts") < 1) fail("science-tool-receipt-invalid");
  const limits = exactObject(input.receipt.limits, ["responseBytes", "objects", "radiusDeg", "rateIntervalMs", "timeoutMs", "retries", "maxSourceAgeMs"], "receipt-limits");
  if (limits.responseBytes !== 8 * 1024 * 1024 || limits.objects !== 500 || limits.radiusDeg !== 10
    || limits.rateIntervalMs !== 500 || limits.timeoutMs !== 15_000 || limits.retries !== 2
    || limits.maxSourceAgeMs !== 24 * 60 * 60 * 1_000) fail("science-tool-receipt-limits-invalid");
  const typedCounts = new Map<string, number>();
  for (const object of objects) typedCounts.set(object.objectType, (typedCounts.get(object.objectType) ?? 0) + 1);
  const topTypes = [...typedCounts.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)).slice(0, 12);
  const catalog = {
    provider: "simbad-tap" as const,
    sourceId,
    sourceVersionId,
    center: { raDeg: centerRaDeg, decDeg: centerDecDeg },
    radiusDeg,
    objects,
    objectTypeCounts: topTypes.map(([type, count]) => ({ type, count })),
  };
  const view = { projection: "local-tangent", invertRightAscension: true, selectedObjectId: objects[0]?.id ?? null };
  const rendererReceipt = createScienceAstronomyRendererReceipt({ catalog, view });
  const output = {
    schema: "agentlas.science-tool-artifact-output/v1",
    artifact: {
      kind: "astronomy.sky-catalog",
      title,
      rendererId: "agentlas.d3-sky",
      rendererVersion: "7.9.0",
      payload: {
        catalog,
        view,
        provenance: {
          astronomyCatalogRunId: catalogRunId,
          astronomyCatalogOutputSha256: catalogOutputSha256,
          rawResponseSha256,
          requestSha256,
          responseSha256,
          normalizedSha256,
          endpoint: SCIENCE_ASTRONOMY_SOURCE_AUTHORITY.endpoint,
          retrievedAt,
          adql,
          sourceAuthority: SCIENCE_ASTRONOMY_SOURCE_AUTHORITY,
          rendererReceipt,
        },
      },
      semantic: {
        title,
        summary: `Interactive local-tangent sky catalog built from ${objects.length} exact SIMBAD TAP rows. Coordinates and measured fields are preserved without imputation.`,
        entities: objects.slice(0, 100).map((object) => ({ id: object.id, label: object.mainId, type: object.objectType })),
        observations: [
          { label: "Catalog objects", value: objects.length, unit: null },
          { label: "Objects with parallax", value: objects.filter((object) => object.parallaxMas !== null).length, unit: null },
          { label: "Objects with radial velocity", value: objects.filter((object) => object.radialVelocityKmS !== null).length, unit: null },
          { label: "Cone radius", value: radiusDeg, unit: "deg" },
        ],
        warnings: objects.length ? [] : ["The exact SIMBAD cone search returned no catalog objects; an empty sky view is preserved."],
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(output), "utf8");
  if (bytes.length > 4 * 1024 * 1024) fail("science-tool-output-too-large");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

main();
