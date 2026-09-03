import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { createHash } from "node:crypto";
import { loadSciencePluginRuntime } from "../plugin-runtime";

const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram"]);
const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function blockedNetwork(request: unknown, ...rest: unknown[]) {
  if (typeof request === "string" && NETWORK_MODULES.has(request)) throw new Error("science-tool-network-denied");
  return originalLoad.call(this, request, ...rest);
};

type PhysicsRuntime = { normalizeNumericDataset(input: unknown): Record<string, unknown> };

function fail(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
function digest(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }

function readPhysicsRuntime(): PhysicsRuntime {
  try {
    return loadSciencePluginRuntime<PhysicsRuntime>(
      "agentlas-physics", "runtime/physics.cjs", 16 * 1024 * 1024,
    ).runtime;
  } catch { return fail("science-physics-runtime-invalid"); }
}

function main(): void {
  const [inputArg, outputArg] = process.argv.slice(2);
  const cwd = fs.realpathSync(process.cwd());
  const inputPath = path.resolve(String(inputArg ?? ""));
  const outputPath = path.resolve(String(outputArg ?? ""));
  if (inputPath !== path.join(cwd, "input.json") || outputPath !== path.join(cwd, "output.json")) fail("science-tool-path-denied");
  const stat = fs.lstatSync(inputPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 4 * 1024 * 1024) fail("science-physics-input-invalid");
  const inputBytes = fs.readFileSync(inputPath);
  let input: Record<string, unknown>;
  try { input = JSON.parse(inputBytes.toString("utf8")) as Record<string, unknown>; } catch { fail("science-physics-input-json-invalid"); }
  const normalized = readPhysicsRuntime().normalizeNumericDataset(input);
  const table = normalized.table as Record<string, unknown>;
  const columns = Array.isArray(table?.columns) ? table.columns as Array<Record<string, unknown>> : [];
  const rows = Array.isArray(table?.rows) ? table.rows as unknown[][] : [];
  const units = columns.filter((column) => typeof column.unit === "string" && column.unit).map((column) => `${String(column.name)} (${String(column.unit)})`);
  const output = {
    schema: "agentlas.science-tool-artifact-output/v1",
    artifact: {
      kind: "table",
      title: String(table.title ?? "Physics dataset"),
      rendererId: "agentlas.table",
      rendererVersion: "1.0.0",
      payload: { schema: "agentlas.science.physics-data-artifact/v1", inputSha256: digest(inputBytes), normalized },
      semantic: {
        title: String(table.title ?? "Physics dataset"),
        summary: `A typed Physics measurement dataset with ${rows.length} exact rows and ${columns.length} columns, normalized without truncation by the installed Agentlas Physics runtime.`,
        entities: columns.slice(0, 64).map((column) => ({ id: String(column.id), label: String(column.name), type: String(column.type) })),
        observations: [
          { label: "Rows", value: rows.length, unit: null },
          { label: "Columns", value: columns.length, unit: null },
          { label: "Columns with units", value: units.length, unit: null },
          { label: "Missing cells", value: rows.reduce((count, row) => count + row.filter((cell) => cell === null).length, 0), unit: null },
        ],
        warnings: [],
      },
    },
  };
  const outputBytes = Buffer.from(JSON.stringify(output), "utf8");
  if (outputBytes.length > 5 * 1024 * 1024) fail("science-physics-output-too-large");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try { fs.writeFileSync(fd, outputBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

main();
