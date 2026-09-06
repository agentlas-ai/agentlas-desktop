import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { createHash } from "node:crypto";
import {
  SCIENCE_ASTRONOMY_LIGHT_CURVE_ARTIFACT_SCHEMA,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_ID,
  SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_VERSION,
  scienceAstronomySha256Json,
  validateScienceAstronomyLightCurveArtifactPayload,
  validateScienceAstronomyLightCurveInputDescriptor,
} from "../../../shared/science-astronomy";
import { loadSciencePluginRuntime } from "../plugin-runtime";

const NETWORK_MODULES = new Set([
  "http", "https", "http2", "net", "tls", "dns", "dgram",
  "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram",
]);
const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function blockedNetwork(request: unknown, ...rest: unknown[]) {
  if (typeof request === "string" && NETWORK_MODULES.has(request)) throw new Error("science-tool-network-denied");
  return originalLoad.call(this, request, ...rest);
};

type AstronomyRuntime = {
  PLUGIN_VERSION: string;
  LOMB_SCARGLE_SCHEMA: string;
  analyzeLightCurvePeriodicity(input: Record<string, unknown>): Record<string, unknown>;
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
  const inputStat = fs.lstatSync(inputPath);
  if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size < 2 || inputStat.size > 8 * 1024 * 1024) fail("science-tool-input-invalid");
  let descriptor: ReturnType<typeof validateScienceAstronomyLightCurveInputDescriptor>;
  try { descriptor = validateScienceAstronomyLightCurveInputDescriptor(JSON.parse(fs.readFileSync(inputPath, "utf8"))); }
  catch (error) { fail(error instanceof Error ? error.message : "science-tool-input-invalid"); }

  let resolvedRuntime: ReturnType<typeof loadSciencePluginRuntime<AstronomyRuntime>>;
  try {
    resolvedRuntime = loadSciencePluginRuntime<AstronomyRuntime>(
      "agentlas-astronomy", "runtime/astronomy.cjs", 16 * 1024 * 1024,
    );
  } catch { fail("science-tool-astronomy-runtime-unavailable"); }
  if (resolvedRuntime.sha256 !== descriptor.runtime.runtimeSha256) {
    fail("science-tool-astronomy-runtime-integrity-failed");
  }
  const runtime = resolvedRuntime.runtime;
  if (runtime.PLUGIN_VERSION !== SCIENCE_ASTRONOMY_LIGHT_CURVE_PLUGIN_VERSION
    || runtime.LOMB_SCARGLE_SCHEMA !== "agentlas.astronomy.lomb-scargle-periodogram/v1"
    || typeof runtime.analyzeLightCurvePeriodicity !== "function") fail("science-tool-astronomy-runtime-invalid");

  let result: Record<string, unknown>;
  try {
    result = runtime.analyzeLightCurvePeriodicity({
      sourceContentSha256: descriptor.sourceTable.rawSha256,
      ...descriptor.analysis,
      measurements: descriptor.measurements,
    });
  } catch (error) {
    const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code) : "science-tool-astronomy-analysis-failed";
    fail(/^[a-z0-9-]+$/u.test(code) ? code : "science-tool-astronomy-analysis-failed");
  }
  const publication = result.publication as Record<string, unknown> | undefined;
  const provenance = result.provenance as Record<string, unknown> | undefined;
  const summary = result.summary as Record<string, unknown> | undefined;
  const bestFit = result.bestFit as Record<string, unknown> | undefined;
  const figure = publication?.figure as Record<string, unknown> | undefined;
  const spec = figure?.spec as Record<string, unknown> | undefined;
  if (!publication || !provenance || !summary || !bestFit || !figure || !spec
    || provenance.sourceContentSha256 !== descriptor.sourceTable.rawSha256
    || provenance.inputSha256 !== scienceAstronomySha256Json({
      sourceContentSha256: descriptor.sourceTable.rawSha256,
      ...descriptor.analysis,
      measurements: [...descriptor.measurements].sort((left, right) => {
        if (left.time === null && right.time !== null) return 1;
        if (left.time !== null && right.time === null) return -1;
        if (left.time !== null && right.time !== null && left.time !== right.time) return left.time - right.time;
        return left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0;
      }),
    })) fail("science-tool-astronomy-analysis-integrity-failed");

  const payload = validateScienceAstronomyLightCurveArtifactPayload({
    schema: SCIENCE_ASTRONOMY_LIGHT_CURVE_ARTIFACT_SCHEMA,
    analysis: {
      schema: result.schema,
      algorithm: result.algorithm,
      settings: result.settings,
      summary: result.summary,
      warnings: result.warnings,
      boundaries: result.boundaries,
      bestFit: result.bestFit,
      provenance: result.provenance,
    },
    publication,
    spec,
    source: { artifact: descriptor.sourceTable, columns: descriptor.columns },
  });
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter((entry): entry is string => typeof entry === "string") : [];
  const output = {
    schema: "agentlas.science-tool-artifact-output/v1",
    artifact: {
      kind: "chart.vega",
      title: descriptor.title,
      rendererId: SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_ID,
      rendererVersion: SCIENCE_ASTRONOMY_LIGHT_CURVE_RENDERER_VERSION,
      payload,
      semantic: {
        title: descriptor.title,
        summary: `Generalized Lomb–Scargle analysis of ${String(summary.analysisEligibleRows)} eligible rows for ${descriptor.analysis.targetId}; the strongest finite grid period is ${String(bestFit.periodDays)} days.`,
        entities: [{ id: descriptor.sourceTable.artifactId, label: descriptor.analysis.targetId, type: "astronomical-light-curve" }],
        observations: [
          { label: "Input observations", value: Number(summary.inputRows), unit: "count" },
          { label: "Analysis-eligible observations", value: Number(summary.analysisEligibleRows), unit: "count" },
          { label: "Best grid period", value: Number(bestFit.periodDays), unit: "day" },
          { label: "Best grid power", value: Number(bestFit.power), unit: null },
        ],
        warnings,
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(output), "utf8");
  if (bytes.length > 4 * 1024 * 1024) fail("science-tool-output-too-large");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

main();
