import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram"]);
const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function blockedNetwork(request: unknown, ...rest: unknown[]) {
  if (typeof request === "string" && NETWORK_MODULES.has(request)) throw new Error("science-tool-network-denied");
  return originalLoad.call(this, request, ...rest);
};

type Occurrence = {
  id: string; gbifKey: string; scientificName: string; species: string | null; genus: string | null; family: string | null;
  order: string | null; className: string | null; phylum: string | null; kingdom: string | null;
  latitude: number; longitude: number; eventDate: string | null; year: number | null; basisOfRecord: string;
  countryCode: string | null; datasetKey: string | null; issues: string[];
};

type Input = {
  schema: "agentlas.science-biodiversity-to-map-input/v1";
  title: string;
  catalogRunId: string;
  catalogOutputSha256: string;
  rawResponseSha256: string;
  provider: "gbif-occurrence";
  query: { scientificName: string; countryCode: string | null; fromYear: number | null; toYear: number | null; limit: number; hasCoordinate: true; occurrenceStatus: "PRESENT" };
  sourceId: string;
  sourceVersionId: string;
  receipt: { endpoint: string; requestSha256: string; responseSha256: string; retrievedAt: string; rowCount: number; totalCount: number };
  occurrences: Occurrence[];
};

function fail(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
function text(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(`invalid-${field}`);
  return value.trim();
}
function nullableText(value: unknown, maximum: number, field: string): string | null {
  if (value === null) return null;
  return text(value, maximum, field);
}
function finite(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail(`invalid-${field}`);
  return value;
}

function main(): void {
  const [inputArg, outputArg] = process.argv.slice(2);
  const cwd = fs.realpathSync(process.cwd());
  const inputPath = path.resolve(String(inputArg ?? ""));
  const outputPath = path.resolve(String(outputArg ?? ""));
  if (inputPath !== path.join(cwd, "input.json") || outputPath !== path.join(cwd, "output.json")) fail("science-tool-path-denied");
  const inputStat = fs.lstatSync(inputPath);
  if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size < 2 || inputStat.size > 8 * 1024 * 1024) fail("science-tool-input-invalid");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as Input;
  if (!input || input.schema !== "agentlas.science-biodiversity-to-map-input/v1" || input.provider !== "gbif-occurrence") fail("science-tool-input-schema-invalid");
  const title = text(input.title, 240, "title");
  if (!/^[a-f0-9-]{36}$/i.test(input.catalogRunId) || !/^[a-f0-9]{64}$/.test(input.catalogOutputSha256) || !/^[a-f0-9]{64}$/.test(input.rawResponseSha256)) fail("science-tool-catalog-lineage-invalid");
  if (!/^[a-f0-9-]{36}$/i.test(input.sourceId) || !/^[a-f0-9-]{36}$/i.test(input.sourceVersionId)) fail("science-tool-source-lineage-invalid");
  const scientificName = text(input.query?.scientificName, 500, "scientific-name");
  if (input.query?.hasCoordinate !== true || input.query?.occurrenceStatus !== "PRESENT") fail("science-tool-query-policy-invalid");
  if (!Array.isArray(input.occurrences) || input.occurrences.length > 300) fail("science-tool-occurrences-invalid");
  const occurrences = input.occurrences.map((occurrence, index) => ({
    id: text(occurrence.id, 80, `occurrence-${index}-id`),
    gbifKey: text(occurrence.gbifKey, 40, `occurrence-${index}-gbif-key`),
    scientificName: text(occurrence.scientificName, 500, `occurrence-${index}-name`),
    species: nullableText(occurrence.species, 500, `occurrence-${index}-species`),
    genus: nullableText(occurrence.genus, 240, `occurrence-${index}-genus`),
    family: nullableText(occurrence.family, 240, `occurrence-${index}-family`),
    order: nullableText(occurrence.order, 240, `occurrence-${index}-order`),
    className: nullableText(occurrence.className, 240, `occurrence-${index}-class`),
    phylum: nullableText(occurrence.phylum, 240, `occurrence-${index}-phylum`),
    kingdom: nullableText(occurrence.kingdom, 240, `occurrence-${index}-kingdom`),
    latitude: finite(occurrence.latitude, -90, 90, `occurrence-${index}-latitude`),
    longitude: finite(occurrence.longitude, -180, 180, `occurrence-${index}-longitude`),
    eventDate: nullableText(occurrence.eventDate, 120, `occurrence-${index}-event-date`),
    year: occurrence.year === null ? null : finite(occurrence.year, 1000, 3000, `occurrence-${index}-year`),
    basisOfRecord: text(occurrence.basisOfRecord, 120, `occurrence-${index}-basis`),
    countryCode: nullableText(occurrence.countryCode, 2, `occurrence-${index}-country`),
    datasetKey: nullableText(occurrence.datasetKey, 80, `occurrence-${index}-dataset`),
    issues: Array.isArray(occurrence.issues) ? occurrence.issues.map((issue, issueIndex) => text(issue, 160, `occurrence-${index}-issue-${issueIndex}`)).slice(0, 100) : [],
  }));
  if (new Set(occurrences.map((occurrence) => occurrence.id)).size !== occurrences.length) fail("science-tool-occurrence-duplicate");
  const basisCounts = new Map<string, number>();
  for (const occurrence of occurrences) basisCounts.set(occurrence.basisOfRecord, (basisCounts.get(occurrence.basisOfRecord) ?? 0) + 1);
  const plotted = occurrences.map((occurrence) => ({
    id: occurrence.id, gbifKey: occurrence.gbifKey, scientificName: occurrence.scientificName,
    longitude: occurrence.longitude, latitude: occurrence.latitude, year: occurrence.year,
    basisOfRecord: occurrence.basisOfRecord, countryCode: occurrence.countryCode,
    issueCount: occurrence.issues.length,
  }));
  const output = {
    schema: "agentlas.science-tool-artifact-output/v1",
    artifact: {
      kind: "chart.vega",
      title,
      rendererId: "agentlas.vega",
      rendererVersion: "6.4.0",
      payload: {
        spec: {
          width: 720,
          height: 390,
          padding: { left: 16, right: 130, top: 24, bottom: 32 },
          background: "#ffffff",
          projections: [{ name: "world", type: "equalEarth", scale: 118, translate: [360, 195] }],
          data: [
            { name: "graticule", transform: [{ type: "graticule", step: [30, 30] }] },
            { name: "occurrences", values: plotted, transform: [{ type: "geopoint", projection: "world", fields: ["longitude", "latitude"], as: ["x", "y"] }] },
          ],
          scales: [{ name: "basis", type: "ordinal", domain: { data: "occurrences", field: "basisOfRecord" }, range: { scheme: "tableau10" } }],
          legends: [{ fill: "basis", title: "Basis of record", orient: "right", symbolType: "circle", labelLimit: 180 }],
          marks: [
            { type: "shape", from: { data: "graticule" }, transform: [{ type: "geoshape", projection: "world" }], encode: { enter: { fill: { value: "transparent" }, stroke: { value: "#d9d8d3" }, strokeWidth: { value: 0.7 } } } },
            { type: "symbol", from: { data: "occurrences" }, encode: { enter: { x: { field: "x" }, y: { field: "y" }, size: { value: 72 }, fill: { scale: "basis", field: "basisOfRecord" }, fillOpacity: { value: 0.78 }, stroke: { value: "#ffffff" }, strokeWidth: { value: 0.8 }, tooltip: { field: "scientificName" } }, update: { fillOpacity: { value: 0.78 } }, hover: { fillOpacity: { value: 1 }, size: { value: 140 } } } },
          ],
        },
        catalog: {
          provider: "gbif-occurrence",
          sourceId: input.sourceId,
          sourceVersionId: input.sourceVersionId,
          query: input.query,
          occurrences,
          basisOfRecordCounts: [...basisCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([basisOfRecord, count]) => ({ basisOfRecord, count })),
        },
        provenance: {
          biodiversityCatalogRunId: input.catalogRunId,
          biodiversityCatalogOutputSha256: input.catalogOutputSha256,
          rawResponseSha256: input.rawResponseSha256,
          requestSha256: text(input.receipt?.requestSha256, 64, "request-sha"),
          responseSha256: text(input.receipt?.responseSha256, 64, "response-sha"),
          endpoint: text(input.receipt?.endpoint, 4_000, "endpoint"),
          retrievedAt: text(input.receipt?.retrievedAt, 80, "retrieved-at"),
        },
      },
      semantic: {
        title,
        summary: `Interactive equal-Earth occurrence map built from ${occurrences.length} exact GBIF rows for ${scientificName}. Coordinates, dates, dataset ids, and provider issue flags are preserved without imputation.`,
        entities: occurrences.slice(0, 100).map((occurrence) => ({ id: occurrence.id, label: occurrence.scientificName, type: occurrence.basisOfRecord })),
        observations: [
          { label: "Mapped occurrences", value: occurrences.length, unit: null },
          { label: "Records with provider issues", value: occurrences.filter((occurrence) => occurrence.issues.length > 0).length, unit: null },
          { label: "Distinct datasets", value: new Set(occurrences.map((occurrence) => occurrence.datasetKey).filter(Boolean)).size, unit: null },
          { label: "Indexed total", value: finite(input.receipt?.totalCount, 0, Number.MAX_SAFE_INTEGER, "total-count"), unit: null },
        ],
        warnings: occurrences.length ? [] : ["The exact coordinate-bearing GBIF query returned no occurrences; an empty map is preserved."],
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(output), "utf8");
  if (bytes.length > 4 * 1024 * 1024) fail("science-tool-output-too-large");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

main();
