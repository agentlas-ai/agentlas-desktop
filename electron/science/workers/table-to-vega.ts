import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram"]);
const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function blockedNetwork(request: unknown, ...rest: unknown[]) {
  if (typeof request === "string" && NETWORK_MODULES.has(request)) throw new Error("science-tool-network-denied");
  return originalLoad.call(this, request, ...rest);
};

type Input = {
  schema: "agentlas.science-table-to-vega-input/v1";
  title: string;
  xField: string;
  yField: string;
  rows: Array<Record<string, string | number>>;
};

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function text(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(`invalid-${field}`);
  return value.trim();
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
  if (!input || input.schema !== "agentlas.science-table-to-vega-input/v1") fail("science-tool-input-schema-invalid");
  const title = text(input.title, 240, "title");
  const xField = text(input.xField, 80, "x-field");
  const yField = text(input.yField, 80, "y-field");
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 5_000) fail("science-tool-rows-invalid");
  const rows = input.rows.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`science-tool-row-${index}-invalid`);
    const x = raw[xField];
    const y = raw[yField];
    if ((typeof x !== "string" && typeof x !== "number") || (typeof x === "number" && !Number.isFinite(x))) fail(`science-tool-row-${index}-x-invalid`);
    if (typeof y !== "number" || !Number.isFinite(y)) fail(`science-tool-row-${index}-y-invalid`);
    return { [xField]: x, [yField]: y };
  });
  const values = rows.map((row) => Number(row[yField]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const output = {
    schema: "agentlas.science-tool-artifact-output/v1",
    artifact: {
      kind: "chart.vega",
      title,
      rendererId: "agentlas.vega",
      rendererVersion: "6.4.0",
      payload: {
        spec: {
          width: 640,
          height: 360,
          padding: { left: 64, right: 24, top: 24, bottom: 56 },
          data: [{ name: "table", values: rows }],
          scales: [
            { name: "x", type: "band", domain: { data: "table", field: xField }, range: "width", padding: 0.24 },
            { name: "y", type: "linear", domain: { data: "table", field: yField }, nice: true, zero: true, range: "height" },
          ],
          axes: [
            { orient: "bottom", scale: "x", title: xField, labelOverlap: true },
            { orient: "left", scale: "y", title: yField, grid: true },
          ],
          marks: [{
            type: "rect",
            from: { data: "table" },
            encode: {
              enter: {
                x: { scale: "x", field: xField },
                width: { scale: "x", band: 1 },
                y: { scale: "y", field: yField },
                y2: { scale: "y", value: 0 },
                fill: { value: "#3867d6" },
              },
            },
          }],
        },
      },
      semantic: {
        title,
        summary: `A deterministic bar chart generated from ${rows.length} measured rows by the isolated table-to-Vega tool.`,
        entities: [],
        observations: [
          { label: "Rows", value: rows.length, unit: null },
          { label: "Minimum", value: min, unit: null },
          { label: "Maximum", value: max, unit: null },
          { label: "Mean", value: mean, unit: null },
        ],
        warnings: [],
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(output), "utf8");
  if (bytes.length > 4 * 1024 * 1024) fail("science-tool-output-too-large");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

main();
