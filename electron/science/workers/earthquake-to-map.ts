import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram"]);
const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function blockedNetwork(request: unknown, ...rest: unknown[]) {
  if (typeof request === "string" && NETWORK_MODULES.has(request)) throw new Error("science-tool-network-denied");
  return originalLoad.call(this, request, ...rest);
};

type Event = {
  id: string; time: string; updatedAt: string; magnitude: number | null; magnitudeType: string | null; place: string | null;
  longitude: number; latitude: number; depthKm: number; feltReports: number | null; significance: number; tsunami: boolean;
  alert: string | null; status: string; eventType: string; detailUrl: string; publicUrl: string;
};
type Input = {
  schema: "agentlas.science-earthquake-to-map-input/v1"; title: string; catalogRunId: string; catalogOutputSha256: string;
  rawResponseSha256: string; provider: "usgs-fdsn-event"; query: Record<string, unknown>; sourceId: string; sourceVersionId: string;
  receipt: Record<string, unknown>; catalog: { schema: string; eventCount: number; events: Event[]; normalizedSha256: string; warnings: string[] };
};

function fail(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
function text(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(`invalid-${field}`);
  return value.trim();
}
function nullableText(value: unknown, maximum: number, field: string): string | null { return value === null ? null : text(value, maximum, field); }
function finite(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail(`invalid-${field}`);
  return value;
}

function main(): void {
  const [inputArg, outputArg] = process.argv.slice(2);
  const cwd = fs.realpathSync(process.cwd()); const inputPath = path.resolve(String(inputArg ?? "")); const outputPath = path.resolve(String(outputArg ?? ""));
  if (inputPath !== path.join(cwd, "input.json") || outputPath !== path.join(cwd, "output.json")) fail("science-tool-path-denied");
  const inputStat = fs.lstatSync(inputPath);
  if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size < 2 || inputStat.size > 8 * 1024 * 1024) fail("science-tool-input-invalid");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as Input;
  if (!input || input.schema !== "agentlas.science-earthquake-to-map-input/v1" || input.provider !== "usgs-fdsn-event"
    || input.catalog?.schema !== "agentlas.earth.usgs-earthquake-catalog/v1") fail("science-tool-input-schema-invalid");
  const title = text(input.title, 240, "title");
  if (!/^[a-f0-9-]{36}$/i.test(input.catalogRunId) || !/^[a-f0-9]{64}$/.test(input.catalogOutputSha256) || !/^[a-f0-9]{64}$/.test(input.rawResponseSha256)
    || !/^[a-f0-9-]{36}$/i.test(input.sourceId) || !/^[a-f0-9-]{36}$/i.test(input.sourceVersionId)) fail("science-tool-lineage-invalid");
  if (!Array.isArray(input.catalog.events) || input.catalog.events.length > 2_000 || input.catalog.eventCount !== input.catalog.events.length) fail("science-tool-events-invalid");
  const events = input.catalog.events.map((event, index) => ({
    id: text(event.id, 120, `event-${index}-id`), time: text(event.time, 80, `event-${index}-time`), updatedAt: text(event.updatedAt, 80, `event-${index}-updated`),
    magnitude: event.magnitude === null ? null : finite(event.magnitude, -2, 10, `event-${index}-magnitude`),
    magnitudeType: nullableText(event.magnitudeType, 40, `event-${index}-magnitude-type`), place: nullableText(event.place, 500, `event-${index}-place`),
    longitude: finite(event.longitude, -180, 180, `event-${index}-longitude`), latitude: finite(event.latitude, -90, 90, `event-${index}-latitude`),
    depthKm: finite(event.depthKm, -10, 1_000, `event-${index}-depth`), feltReports: event.feltReports === null ? null : finite(event.feltReports, 0, Number.MAX_SAFE_INTEGER, `event-${index}-felt`),
    significance: finite(event.significance, 0, 10_000, `event-${index}-significance`), tsunami: event.tsunami === true,
    alert: nullableText(event.alert, 40, `event-${index}-alert`), status: text(event.status, 80, `event-${index}-status`), eventType: text(event.eventType, 80, `event-${index}-type`),
    detailUrl: text(event.detailUrl, 2_000, `event-${index}-detail`), publicUrl: text(event.publicUrl, 2_000, `event-${index}-public`),
  }));
  if (new Set(events.map((event) => event.id)).size !== events.length) fail("science-tool-event-duplicate");
  const plotted = events.map((event) => ({
    ...event,
    plotMagnitude: event.magnitude ?? 1.5,
    displayPlace: `${event.place ?? "USGS place unavailable"} · M${event.magnitude ?? "missing"} · ${event.depthKm} km`,
  }));
  const output = {
    schema: "agentlas.science-tool-artifact-output/v1",
    artifact: {
      kind: "chart.vega", title, rendererId: "agentlas.vega", rendererVersion: "6.4.0",
      payload: {
        spec: {
          width: 720, height: 390, padding: { left: 16, right: 105, top: 24, bottom: 32 }, background: "#ffffff",
          projections: [{ name: "world", type: "equalEarth", scale: 118, translate: [360, 195] }],
          data: [
            { name: "sphere", values: [{ type: "Sphere" }] },
            { name: "graticule", transform: [{ type: "graticule", step: [30, 30] }] },
            { name: "events", values: plotted, transform: [{ type: "geopoint", projection: "world", fields: ["longitude", "latitude"], as: ["x", "y"] }] },
          ],
          scales: [
            { name: "depth", type: "linear", domain: { data: "events", field: "depthKm" }, range: ["#d7e8e4", "#163f38"], nice: true },
            { name: "magnitude", type: "sqrt", domain: [0, 10], range: [36, 520], zero: true },
          ],
          legends: [{ fill: "depth", title: "Depth (km)", orient: "right", gradientLength: 180 }],
          marks: [
            { type: "shape", from: { data: "sphere" }, transform: [{ type: "geoshape", projection: "world" }], encode: { enter: { fill: { value: "#f5f6f4" }, stroke: { value: "#c8cdc9" }, strokeWidth: { value: 1 } } } },
            { type: "shape", from: { data: "graticule" }, transform: [{ type: "geoshape", projection: "world" }], encode: { enter: { fill: { value: "transparent" }, stroke: { value: "#d9d8d3" }, strokeWidth: { value: 0.7 } } } },
            { type: "symbol", from: { data: "events" }, encode: { enter: { x: { field: "x" }, y: { field: "y" }, size: { scale: "magnitude", field: "plotMagnitude" }, fill: { scale: "depth", field: "depthKm" }, fillOpacity: { value: 0.82 }, stroke: { value: "#ffffff" }, strokeWidth: { value: 0.8 }, tooltip: { field: "displayPlace" } }, hover: { fillOpacity: { value: 1 }, strokeWidth: { value: 1.7 } } } },
          ],
        },
        catalog: { provider: "usgs-fdsn-event", sourceId: input.sourceId, sourceVersionId: input.sourceVersionId, query: input.query, normalizedSha256: input.catalog.normalizedSha256, events },
        provenance: {
          earthquakeCatalogRunId: input.catalogRunId, earthquakeCatalogOutputSha256: input.catalogOutputSha256, rawResponseSha256: input.rawResponseSha256,
          requestSha256: text(input.receipt.requestSha256, 64, "request-sha"), normalizedSha256: text(input.receipt.normalizedSha256, 64, "normalized-sha"),
          endpoint: text(input.receipt.endpoint, 4_000, "endpoint"), retrievedAt: text(input.receipt.retrievedAt, 80, "retrieved-at"),
        },
      },
      semantic: {
        title, summary: `Interactive equal-Earth map built from ${events.length} exact USGS earthquake observations. Magnitude, depth, event time, and missing provider values remain explicit.`,
        entities: events.slice(0, 100).map((event) => ({ id: event.id, label: event.place ?? event.id, type: event.eventType })),
        observations: [
          { label: "Mapped events", value: events.length, unit: null },
          { label: "Missing magnitudes", value: events.filter((event) => event.magnitude === null).length, unit: null },
          { label: "Tsunami flags", value: events.filter((event) => event.tsunami).length, unit: null },
          { label: "Maximum magnitude", value: events.reduce((maximum, event) => event.magnitude === null ? maximum : Math.max(maximum, event.magnitude), -2), unit: null },
        ], warnings: Array.isArray(input.catalog.warnings) ? input.catalog.warnings.slice(0, 50) : [],
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(output), "utf8");
  if (bytes.length > 4 * 1024 * 1024) fail("science-tool-output-too-large");
  const fd = fs.openSync(outputPath, "wx", 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

main();
