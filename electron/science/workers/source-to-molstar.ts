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
  schema: "agentlas.science-source-to-molstar-input/v1";
  title: string;
  source: { id: string; versionId: string; contentSha256: string; format: "pdb" | "mmcif" };
  representation: "cartoon" | "ball-and-stick" | "surface";
  colorTheme: "chain-id" | "element-symbol" | "secondary-structure";
};

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function main(): void {
  const [inputArg, outputArg] = process.argv.slice(2);
  const cwd = fs.realpathSync(process.cwd());
  const inputPath = path.resolve(String(inputArg ?? ""));
  const outputPath = path.resolve(String(outputArg ?? ""));
  if (inputPath !== path.join(cwd, "input.json") || outputPath !== path.join(cwd, "output.json")) fail("science-tool-path-denied");
  const stat = fs.lstatSync(inputPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 8 * 1024 * 1024) fail("science-tool-input-invalid");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as Input;
  if (!input || input.schema !== "agentlas.science-source-to-molstar-input/v1" || !input.source) fail("science-tool-input-schema-invalid");
  const output = {
    schema: "agentlas.science-tool-artifact-candidate/v2",
    artifact: {
      kind: "protein.structure",
      title: input.title,
      rendererId: "agentlas.molstar",
      payload: {
        structure: {
          sourceId: input.source.id,
          sourceVersionId: input.source.versionId,
          contentSha256: input.source.contentSha256,
          format: input.source.format,
        },
        representation: input.representation,
        colorTheme: input.colorTheme,
      },
      semantic: {
        title: input.title,
        summary: `A source-bound ${input.source.format.toUpperCase()} structure prepared for interactive Mol* inspection.`,
        entities: [{ id: input.source.id, label: input.title, type: "structure-source" }],
        observations: [{ label: "Source format", value: input.source.format, unit: null }],
        warnings: [],
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(output), "utf8");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

main();
