import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { createHash } from "node:crypto";
import {
  SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA,
  SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA,
  SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V3_SCHEMA,
  SCIENCE_STATISTICS_EXECUTION_RECEIPT_SCHEMA,
  scienceStatisticsSha256,
  validateScienceStatisticsDataTableProjectionReceipt,
  validateScienceStatisticsExecutionBinding,
} from "../../../shared/science-statistics";
import { loadSciencePluginRuntime } from "../plugin-runtime";

const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram", "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram"]);
const REQUIRED_PROCESS_LIMIT_ARGS = Object.freeze([
  "--max-old-space-size=192",
  "--max-semi-space-size=16",
  "--stack-size=8192",
]);
const STATISTICS_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const STATISTICS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function blockedNetwork(request: unknown, ...rest: unknown[]) {
  if (typeof request === "string" && NETWORK_MODULES.has(request)) throw new Error("science-tool-network-denied");
  return originalLoad.call(this, request, ...rest);
};

type StatisticsEngine = {
  analyze(request: Record<string, unknown>): StatisticsResult;
  publicError(error: unknown): { code: string; message: string };
};
type StatisticsResult = Record<string, unknown> & { method: string; artifacts: Array<Record<string, unknown>>; artifactReceipts: Array<{ sha256: string }> };

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function numericRange(values: readonly number[]): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return { minimum, maximum };
}

function readEngine(): StatisticsEngine {
  try {
    return loadSciencePluginRuntime<StatisticsEngine>(
      "agentlas-science-statistics", "runtime/engine.cjs", 16 * 1024 * 1024,
    ).runtime;
  } catch { return fail("science-statistics-engine-invalid"); }
}

async function main(): Promise<void> {
  if (!REQUIRED_PROCESS_LIMIT_ARGS.every((argument) => process.execArgv.includes(argument))) {
    fail("science-statistics-process-limits-invalid");
  }
  const [inputArg, outputArg] = process.argv.slice(2);
  const cwd = fs.realpathSync(process.cwd());
  const inputPath = path.resolve(String(inputArg ?? ""));
  const outputPath = path.resolve(String(outputArg ?? ""));
  if (inputPath !== path.join(cwd, "input.json") || outputPath !== path.join(cwd, "output.json")) fail("science-tool-path-denied");
  const inputStat = fs.lstatSync(inputPath);
  if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size < 2 || inputStat.size > STATISTICS_MAX_INPUT_BYTES) fail("science-statistics-input-invalid");
  const inputBytes = fs.readFileSync(inputPath);
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(inputBytes.toString("utf8")) as Record<string, unknown>; } catch { fail("science-statistics-input-json-invalid"); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("science-statistics-input-envelope-invalid");
  const hasInlineData = Object.hasOwn(envelope, "data");
  const hasSourceTable = Object.hasOwn(envelope, "sourceTable");
  const hasDataProjection = Object.hasOwn(envelope, "dataProjection");
  const allowedKeys = hasSourceTable
    ? ["schema", "method", "sourceTable", "dataProjection", "options", "executionBinding"]
    : ["schema", "method", "data", "options", "executionBinding"];
  const requiredKeys = hasSourceTable
    ? ["schema", "method", "sourceTable", "dataProjection", "executionBinding"]
    : ["schema", "method", "data", "executionBinding"];
  if (Object.keys(envelope).some((key) => !allowedKeys.includes(key))
    || !requiredKeys.every((key) => Object.hasOwn(envelope, key))
    || hasInlineData === hasSourceTable || hasSourceTable !== hasDataProjection
    || typeof envelope.method !== "string") fail("science-statistics-input-envelope-invalid");
  let executionBinding: ReturnType<typeof validateScienceStatisticsExecutionBinding>;
  try { executionBinding = validateScienceStatisticsExecutionBinding(envelope.executionBinding, envelope.method); }
  catch (error) { fail(error instanceof Error ? error.message : "science-statistics-execution-binding-invalid"); }
  let requestData = envelope.data;
  let projectionReceipt: ReturnType<typeof validateScienceStatisticsDataTableProjectionReceipt> | null = null;
  if (hasSourceTable) {
    const sourceTable = record(envelope.sourceTable);
    const projection = record(envelope.dataProjection);
    const projectedData = record(projection?.data);
    if (!sourceTable || !projection || !exactKeys(projection, ["data", "receipt"]) || !projectedData) fail("science-statistics-data-table-projection-invalid");
    try { projectionReceipt = validateScienceStatisticsDataTableProjectionReceipt(projection.receipt); }
    catch (error) { fail(error instanceof Error ? error.message : "science-statistics-data-table-projection-receipt-invalid"); }
    const sourceArtifact = { artifactId: sourceTable.artifactId, artifactVersion: sourceTable.artifactVersion, contentSha256: sourceTable.contentSha256 };
    if (canonicalJson(sourceArtifact) !== canonicalJson(projectionReceipt.sourceArtifact)
      || executionBinding.inputArtifacts.length !== 1
      || canonicalJson(executionBinding.inputArtifacts[0]) !== canonicalJson(projectionReceipt.sourceArtifact)
      || scienceStatisticsSha256(projectedData) !== projectionReceipt.projectedDataSha256) {
      fail("science-statistics-data-table-projection-binding-invalid");
    }
    if (projectionReceipt.schema === SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_SCHEMA) {
      if (envelope.method !== "kaplan_meier"
        || !exactKeys(sourceTable, ["artifactId", "artifactVersion", "contentSha256", "timeColumn", "eventColumn", "label"])
        || !exactKeys(projectedData, ["time", "event", "label"])
        || !Array.isArray(projectedData.time) || !Array.isArray(projectedData.event)
        || projectedData.time.length < 1 || projectedData.time.length !== projectedData.event.length
        || projectedData.time.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        || projectedData.event.some((value) => typeof value !== "number" || (value !== 0 && value !== 1))
        || typeof projectedData.label !== "string") fail("science-statistics-data-table-projection-invalid");
      const projectedTime = projectedData.time as number[];
      const projectedEvent = projectedData.event as number[];
      const includedRows = projectedTime.map((time, rowIndex) => ({ rowIndex, time, event: projectedEvent[rowIndex] }));
      if (sourceTable.timeColumn !== projectionReceipt.timeColumn || sourceTable.eventColumn !== projectionReceipt.eventColumn
        || sourceTable.label !== projectionReceipt.label || projectedData.label !== projectionReceipt.label
        || projectedTime.length !== projectionReceipt.includedRowCount
        || scienceStatisticsSha256(includedRows) !== projectionReceipt.includedRowsSha256) {
        fail("science-statistics-data-table-projection-binding-invalid");
      }
    } else if (projectionReceipt.schema === SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V3_SCHEMA) {
      const columns = projectionReceipt.columns;
      const fixedEffects = columns.fixedEffects;
      const expectedDataKeys = columns.observationLabelColumn === null
        ? ["y", "groups", "predictors", "outcomeLabel", "groupLabel"]
        : ["y", "groups", "predictors", "outcomeLabel", "groupLabel", "observationLabels"];
      if (envelope.method !== "gaussian_random_intercept_lmm" || sourceTable.method !== projectionReceipt.method
        || sourceTable.projectionKind !== projectionReceipt.projectionKind
        || !exactKeys(sourceTable, ["artifactId", "artifactVersion", "contentSha256", "method", "projectionKind", "outcomeColumn", "groupColumn", "observationLabelColumn", "fixedEffects"])
        || canonicalJson(sourceTable) !== canonicalJson({ ...projectionReceipt.sourceArtifact, method: projectionReceipt.method, projectionKind: projectionReceipt.projectionKind, ...columns })
        || !exactKeys(projectedData, expectedDataKeys)
        || projectedData.outcomeLabel !== columns.outcomeColumn || projectedData.groupLabel !== columns.groupColumn
        || !Array.isArray(projectedData.y) || !Array.isArray(projectedData.groups) || !Array.isArray(projectedData.predictors)
        || projectedData.y.length !== projectionReceipt.includedRowCount || projectedData.groups.length !== projectedData.y.length
        || projectedData.predictors.length !== fixedEffects.length) fail("science-statistics-data-table-projection-invalid");
      const y = projectedData.y as unknown[];
      const groups = projectedData.groups as unknown[];
      const observationLabels = columns.observationLabelColumn === null ? null : projectedData.observationLabels;
      if (observationLabels !== null && (!Array.isArray(observationLabels) || observationLabels.length !== y.length
        || observationLabels.some((value) => typeof value !== "string" || !value.trim() || value.length > 128)
        || new Set(observationLabels).size !== observationLabels.length)) fail("science-statistics-data-table-projection-invalid");
      if (y.some((value) => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15)
        || groups.some((value) => typeof value !== "string" || !value.trim() || value.length > 128)) fail("science-statistics-data-table-projection-invalid");
      const groupCounts = new Map<string, number>();
      (groups as string[]).forEach((group) => groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1));
      if (groupCounts.size < 5 || [...groupCounts.values()].some((count) => count < 2)) fail("science-statistics-data-table-projection-invalid");
      const fixedValues: Array<Array<number | string>> = [];
      for (let index = 0; index < fixedEffects.length; index += 1) {
        const spec = fixedEffects[index];
        const predictor = record((projectedData.predictors as unknown[])[index]);
        if (!predictor || predictor.name !== spec.column || predictor.type !== spec.type || !Array.isArray(predictor.values)
          || predictor.values.length !== y.length) fail("science-statistics-data-table-projection-invalid");
        if (spec.type === "numeric") {
          if (!exactKeys(predictor, ["name", "type", "values"])
            || predictor.values.some((value) => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15)) {
            fail("science-statistics-data-table-projection-invalid");
          }
          const values = predictor.values as number[];
          const range = numericRange(values);
          if (range.minimum === range.maximum) fail("science-statistics-data-table-projection-invalid");
          fixedValues.push(values);
        } else {
          if (!exactKeys(predictor, ["name", "type", "values", "reference"]) || predictor.reference !== spec.reference
            || predictor.values.some((value) => typeof value !== "string" || !value.trim() || value.length > 128)) {
            fail("science-statistics-data-table-projection-invalid");
          }
          const values = predictor.values as string[];
          const observedLevels = [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
          if (canonicalJson(observedLevels) !== canonicalJson(spec.levels)
            || values.every((value, rowIndex) => value === groups[rowIndex])) fail("science-statistics-data-table-projection-invalid");
          fixedValues.push(values);
        }
      }
      const includedRows = y.map((outcome, rowIndex) => ({
        rowIndex,
        outcome,
        group: groups[rowIndex],
        ...(observationLabels === null ? {} : { observationLabel: (observationLabels as unknown[])[rowIndex] }),
        fixedEffectValues: fixedValues.map((values) => values[rowIndex]),
      }));
      if (scienceStatisticsSha256(includedRows) !== projectionReceipt.includedRowsSha256) {
        fail("science-statistics-data-table-projection-binding-invalid");
      }
    } else if (projectionReceipt.schema === SCIENCE_STATISTICS_DATA_TABLE_PROJECTION_RECEIPT_V2_SCHEMA) {
      if (envelope.method !== projectionReceipt.method || sourceTable.method !== projectionReceipt.method
        || sourceTable.projectionKind !== projectionReceipt.projectionKind
        || projectionReceipt.includedRowCount < 1) fail("science-statistics-data-table-projection-binding-invalid");
      if (projectionReceipt.method === "welch_one_way_anova") {
        if (!exactKeys(sourceTable, ["artifactId", "artifactVersion", "contentSha256", "method", "projectionKind", "groupColumn", "valueColumn"])
          || !exactKeys(projectedData, ["groups"])
          || sourceTable.groupColumn !== (projectionReceipt.columns as Record<string, unknown>).groupColumn
          || sourceTable.valueColumn !== (projectionReceipt.columns as Record<string, unknown>).valueColumn
          || !Array.isArray(projectedData.groups)) fail("science-statistics-data-table-projection-invalid");
      } else if (projectionReceipt.method === "friedman_test") {
        if (!exactKeys(sourceTable, ["artifactId", "artifactVersion", "contentSha256", "method", "projectionKind", "blockColumn", "conditionColumn", "valueColumn"])
          || !exactKeys(projectedData, ["conditions"])
          || sourceTable.blockColumn !== (projectionReceipt.columns as Record<string, unknown>).blockColumn
          || sourceTable.conditionColumn !== (projectionReceipt.columns as Record<string, unknown>).conditionColumn
          || sourceTable.valueColumn !== (projectionReceipt.columns as Record<string, unknown>).valueColumn
          || !Array.isArray(projectedData.conditions)) fail("science-statistics-data-table-projection-invalid");
      } else if (projectionReceipt.method === "roc_curve_analysis") {
        const expectedDataKeys = Object.hasOwn(projectedData, "observationLabels") ? ["outcomes", "scores", "observationLabels"] : ["outcomes", "scores"];
        if (!exactKeys(sourceTable, ["artifactId", "artifactVersion", "contentSha256", "method", "projectionKind", "outcomeColumn", "scoreColumn", "observationLabelColumn"])
          || !exactKeys(projectedData, expectedDataKeys)
          || sourceTable.outcomeColumn !== (projectionReceipt.columns as Record<string, unknown>).outcomeColumn
          || sourceTable.scoreColumn !== (projectionReceipt.columns as Record<string, unknown>).scoreColumn
          || sourceTable.observationLabelColumn !== (projectionReceipt.columns as Record<string, unknown>).observationLabelColumn
          || !Array.isArray(projectedData.outcomes) || !Array.isArray(projectedData.scores)) fail("science-statistics-data-table-projection-invalid");
      } else {
        const columns = projectionReceipt.columns as Record<string, unknown>;
        const response = record(projectedData.response);
        const factors = Array.isArray(projectedData.factors) ? projectedData.factors.map(record) : [];
        if (!exactKeys(sourceTable, ["artifactId", "artifactVersion", "contentSha256", "method", "projectionKind", "responseColumn", "factor1Column", "factor2Column"])
          || !exactKeys(projectedData, ["response", "factors"])
          || sourceTable.responseColumn !== columns.responseColumn || sourceTable.factor1Column !== columns.factor1Column || sourceTable.factor2Column !== columns.factor2Column
          || !response || !exactKeys(response, ["name", "values"]) || response.name !== columns.responseColumn || !Array.isArray(response.values)
          || factors.length !== 2 || factors.some((factor) => !factor || !exactKeys(factor, ["name", "values", "coding"]))) {
          fail("science-statistics-data-table-projection-invalid");
        }
        const responseValues = response.values as unknown[];
        const factor1 = factors[0] as Record<string, unknown>; const factor2 = factors[1] as Record<string, unknown>;
        const factor1Values = factor1.values as unknown[]; const factor2Values = factor2.values as unknown[];
        if (factor1.name !== columns.factor1Column || factor2.name !== columns.factor2Column
          || !Array.isArray(factor1Values) || !Array.isArray(factor2Values)
          || responseValues.length !== projectionReceipt.includedRowCount || responseValues.length < 9
          || factor1Values.length !== responseValues.length || factor2Values.length !== responseValues.length
          || [...responseValues, ...factor1Values, ...factor2Values].some((value) => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15)) {
          fail("science-statistics-data-table-projection-invalid");
        }
        const coding = (values: unknown[], raw: unknown) => {
          const entry = record(raw); const numeric = values as number[];
          const minimum = Math.min(...numeric); const maximum = Math.max(...numeric); const halfRange = (maximum - minimum) / 2; const center = minimum + halfRange;
          return entry && exactKeys(entry, ["kind", "center", "halfRange"])
            && entry.kind === "center-half-range-to-minus-one-one" && entry.center === center && entry.halfRange === halfRange && halfRange > 0;
        };
        const includedRows = responseValues.map((responseValue, rowIndex) => ({ rowIndex, response: responseValue, factor1: factor1Values[rowIndex], factor2: factor2Values[rowIndex] }));
        if (!coding(factor1Values, factor1.coding) || !coding(factor2Values, factor2.coding)
          || scienceStatisticsSha256(includedRows) !== projectionReceipt.includedRowsSha256) fail("science-statistics-data-table-projection-binding-invalid");
      }
    }
    requestData = projectedData;
  } else if (executionBinding.inputArtifacts.length > 0) {
    fail("science-statistics-inline-artifact-binding-forbidden");
  }
  const request = {
    schema: envelope.schema,
    method: envelope.method,
    data: requestData,
    ...(Object.hasOwn(envelope, "options") ? { options: envelope.options } : {}),
  };
  const engine = readEngine();
  let result: StatisticsResult;
  try { result = engine.analyze(request); } catch (error) { const safe = engine.publicError(error); fail(`${safe.code}:${safe.message}`); }
  const visualizations: Array<Record<string, unknown>> = [];
  for (let index = 0; index < result.artifacts.length; index += 1) {
    const artifact = result.artifacts[index];
    if (artifact.kind !== "vega-lite") continue;
    const payload = artifact.payload as Record<string, unknown>;
    visualizations.push({
      sourceArtifactIndex: index,
      sourceArtifactSha256: result.artifactReceipts[index]?.sha256,
      sourceSpecSha256: scienceStatisticsSha256(payload),
      role: String(artifact.role ?? "statistical-figure"),
      title: String(payload.title ?? artifact.role ?? "Statistical figure"),
    });
  }
  const selectedTableIndex = result.artifacts.findIndex((artifact) => artifact.kind === "table");
  if (selectedTableIndex < 0) fail("science-statistics-table-output-missing");
  const table = result.artifacts[selectedTableIndex]?.payload as Record<string, unknown>;
  const sample = result.sample && typeof result.sample === "object" && !Array.isArray(result.sample) ? result.sample as Record<string, unknown> : {};
  const tests = Array.isArray(result.tests) ? result.tests as Array<Record<string, unknown>> : [];
  const observations = [
    { label: "Method", value: result.method, unit: null },
    ...Object.entries(sample).slice(0, 8).flatMap(([label, value]) => typeof value === "number" && Number.isFinite(value) ? [{ label, value, unit: null }] : []),
    ...tests.slice(0, 4).flatMap((test, index) => typeof test.pValue === "number" && Number.isFinite(test.pValue) ? [{ label: `${String(test.name ?? `Test ${index + 1}`)} p`, value: test.pValue, unit: null }] : []),
  ];
  const inputSha256 = digest(inputBytes);
  const executionReceiptCore = {
    schema: SCIENCE_STATISTICS_EXECUTION_RECEIPT_SCHEMA,
    inputSha256,
    engineRequestHash: String(result.requestHash),
    executionBindingSha256: executionBinding.bindingSha256,
    visualizationsSha256: scienceStatisticsSha256(visualizations),
    ...(projectionReceipt ? { projectionReceiptSha256: projectionReceipt.receiptSha256 } : {}),
  };
  const payload = {
    schema: "agentlas.science.statistics-analysis-artifact/v1",
    inputSha256,
    method: result.method,
    executionBinding,
    executionReceipt: { ...executionReceiptCore, receiptSha256: scienceStatisticsSha256(executionReceiptCore) },
    ...(projectionReceipt ? { projectionReceipt } : {}),
    result,
    selectedTableIndex,
    visualizations,
  };
  const output = {
    schema: "agentlas.science-tool-artifact-output/v1",
    artifact: {
      kind: "table",
      title: String(table.title ?? `Statistical analysis: ${result.method}`),
      rendererId: "agentlas.table",
      rendererVersion: "1.0.0",
      payload,
      semantic: {
        title: String(table.title ?? `Statistical analysis: ${result.method}`),
        summary: `A receipt-bound ${result.method} result with ${result.artifacts.length} publication artifact(s), generated by the isolated Agentlas Science Statistics engine.`,
        entities: [],
        observations,
        warnings: Array.isArray(result.assumptions)
          ? (result.assumptions as Array<Record<string, unknown>>).filter((item) => String(item.status ?? "").includes("requires")).map((item) => `${String(item.name ?? "Assumption")}: ${String(item.status)}`).slice(0, 50)
          : [],
      },
    },
  };
  const outputBytes = Buffer.from(JSON.stringify(output), "utf8");
  if (outputBytes.length > STATISTICS_MAX_OUTPUT_BYTES) fail("science-statistics-output-too-large");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try { fs.writeFileSync(fd, outputBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

void main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
