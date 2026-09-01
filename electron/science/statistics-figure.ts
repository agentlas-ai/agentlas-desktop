import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  SCIENCE_FIGURE_ANALYSIS_RECEIPT_SCHEMA,
  SCIENCE_FIGURE_SPEC_SCHEMA,
  scienceFigureSha256,
  validateScienceFigureSpec,
  type ScienceFigureAxis,
  type ScienceFigureChartFamily,
  type ScienceFigureEncoding,
  type ScienceFigureScaleType,
  type ScienceFigureSpec,
} from "../../shared/science-figure";
import {
  SCIENCE_STATISTICS_FIGURE_ARTIFACT_SCHEMA,
  SCIENCE_STATISTICS_FIGURE_RENDERER_VERSION,
  SCIENCE_STATISTICS_TOOL_ID,
  SCIENCE_STATISTICS_TOOL_VERSION,
  scienceStatisticsSha256,
  validateScienceStatisticsAnalysisPayload,
  validateScienceStatisticsFigureArtifactPayload,
  type ScienceStatisticsFigureArtifactPayload,
  type ScienceStatisticsVisualization,
} from "../../shared/science-statistics";
import type { ScienceArtifact, ScienceArtifactVersion, ScienceResearchRun } from "../../shared/science-contract";

type JsonRecord = Record<string, unknown>;
type VegaLiteCompiler = { compile(spec: JsonRecord, options: Record<string, unknown>): { spec: unknown } };

let cachedVegaLiteCompiler: VegaLiteCompiler | null = null;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function cleanText(value: unknown, fallback: string, maximum = 500): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function vegaLiteCompiler(): VegaLiteCompiler {
  if (cachedVegaLiteCompiler) return cachedVegaLiteCompiler;
  const moduleEntry = require.resolve("vega-lite");
  const umdPath = path.join(path.dirname(moduleEntry), "vega-lite.min.js");
  const vegaModuleEntry = require.resolve("vega");
  const vegaUmdPath = path.join(path.dirname(vegaModuleEntry), "vega.min.js");
  const loadUmd = (filePath: string, requireFunction: NodeRequire): Record<string, unknown> => {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) {
      throw new Error("science-statistics-vega-lite-runtime-invalid");
    }
    const moduleRecord: { exports: Record<string, unknown> } = { exports: {} };
    const wrapper = new vm.Script(`(function(exports,module,require){${fs.readFileSync(filePath, "utf8")}\n})`, {
      filename: filePath,
    }).runInThisContext() as (exports: Record<string, unknown>, module: { exports: Record<string, unknown> }, requireFunction: NodeRequire) => void;
    wrapper(moduleRecord.exports, moduleRecord, requireFunction);
    return moduleRecord.exports;
  };
  const vega = loadUmd(vegaUmdPath, require);
  const restrictedRequire = ((specifier: string) => {
    if (specifier === "vega") return vega;
    throw new Error("science-statistics-vega-lite-runtime-dependency-invalid");
  }) as NodeRequire;
  const vegaLite = loadUmd(umdPath, restrictedRequire);
  const compile = vegaLite.compile;
  if (typeof compile !== "function") throw new Error("science-statistics-vega-lite-runtime-invalid");
  cachedVegaLiteCompiler = vegaLite as unknown as VegaLiteCompiler;
  return cachedVegaLiteCompiler;
}

function sourceSpecForVisualization(
  analysis: ReturnType<typeof validateScienceStatisticsAnalysisPayload>,
  visualization: ScienceStatisticsVisualization,
): JsonRecord {
  const artifact = record(analysis.result.artifacts[visualization.sourceArtifactIndex]);
  const sourceSpec = record(artifact?.payload);
  if (!sourceSpec || artifact?.kind !== "vega-lite" || artifact.role !== visualization.role
    || scienceStatisticsSha256(sourceSpec) !== visualization.sourceSpecSha256) {
    throw new Error("science-statistics-figure-source-binding-invalid");
  }
  return sourceSpec;
}

export function compileScienceStatisticsVisualization(sourceSpec: JsonRecord): JsonRecord {
  // Keep the same responsive normalization formerly applied in the analysis
  // worker, but compile only when a user opens/materializes this exact Figure.
  const nestedSpec = record(sourceSpec.spec);
  const isFaceted = Boolean(record(sourceSpec.facet) || record(sourceSpec.repeat));
  const compilationSource = Object.hasOwn(sourceSpec, "width")
    ? sourceSpec
    : isFaceted && nestedSpec
      ? {
        ...sourceSpec,
        autosize: { type: "pad", contains: "padding" },
        spec: {
          ...nestedSpec,
          ...(Object.hasOwn(nestedSpec, "width") ? {} : { width: 180 }),
          ...(Object.hasOwn(nestedSpec, "height") ? {} : { height: 220 }),
        },
      }
      : { ...sourceSpec, width: 480 };
  const compiled = record(vegaLiteCompiler().compile(compilationSource, { config: {} }).spec);
  const serialized = JSON.stringify(compiled);
  if (!compiled || Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024
    || /\bhttps?:\/\//u.test(serialized.replaceAll("https://vega.github.io/schema/vega/v6.json", ""))) {
    throw new Error("science-statistics-compiled-visualization-invalid");
  }
  return compiled;
}

function collectAvailableFields(sourceSpec: JsonRecord): string[] {
  const fields = new Set<string>();
  let nodes = 0;
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    if (normalized && normalized.length <= 240) fields.add(normalized);
  };
  const visit = (value: unknown, key = "", depth = 0): void => {
    if (++nodes > 100_000 || depth > 40 || fields.size >= 2_000) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    const item = record(value);
    if (!item) return;
    if (key === "values") for (const row of Array.isArray(value) ? value : []) {
      const rowRecord = record(row);
      if (rowRecord) Object.keys(rowRecord).forEach(add);
    }
    for (const [childKey, child] of Object.entries(item)) {
      if (childKey === "field") add(child);
      if (childKey === "values" && Array.isArray(child)) {
        for (const row of child) {
          const rowRecord = record(row);
          if (rowRecord) Object.keys(rowRecord).forEach(add);
        }
      }
      visit(child, childKey, depth + 1);
    }
  };
  visit(sourceSpec);
  if (fields.size === 0) fields.add("value");
  return [...fields].sort((a, b) => a.localeCompare(b));
}

function encodingNodes(sourceSpec: JsonRecord): JsonRecord[] {
  const encodings: JsonRecord[] = [];
  let nodes = 0;
  const visit = (value: unknown, depth = 0): void => {
    if (++nodes > 20_000 || depth > 24) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const item = record(value);
    if (!item) return;
    const encoding = record(item.encoding);
    if (encoding) encodings.push(encoding);
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(sourceSpec);
  return encodings;
}

function channelField(encodings: JsonRecord[], ...channels: string[]): string | null {
  for (const encoding of encodings) for (const channel of channels) {
    const entry = record(encoding[channel]);
    if (entry && typeof entry.field === "string" && entry.field.trim()) return entry.field.trim();
  }
  return null;
}

function sourceEncoding(sourceSpec: JsonRecord): ScienceFigureEncoding {
  const encodings = encodingNodes(sourceSpec);
  return {
    x: channelField(encodings, "x"),
    y: channelField(encodings, "y"),
    z: null,
    xLow: channelField(encodings, "xError", "xError2"),
    xHigh: channelField(encodings, "x2"),
    yLow: channelField(encodings, "yError", "yError2"),
    yHigh: channelField(encodings, "y2"),
    color: channelField(encodings, "color", "fill", "stroke"),
    size: channelField(encodings, "size"),
    shape: channelField(encodings, "shape"),
    series: channelField(encodings, "detail", "strokeDash"),
    label: channelField(encodings, "text", "tooltip"),
    facetRow: channelField(encodings, "row"),
    facetColumn: channelField(encodings, "column"),
  };
}

function sourceMarks(sourceSpec: JsonRecord): Set<string> {
  const marks = new Set<string>();
  let nodes = 0;
  const visit = (value: unknown, depth = 0): void => {
    if (++nodes > 20_000 || depth > 24) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const item = record(value);
    if (!item) return;
    if (typeof item.mark === "string") marks.add(item.mark);
    else if (record(item.mark) && typeof record(item.mark)?.type === "string") marks.add(String(record(item.mark)?.type));
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(sourceSpec);
  return marks;
}

const STATISTICS_CHART_FAMILY_BY_ROLE: Readonly<Record<string, ScienceFigureChartFamily>> = Object.freeze({
  "estimate-plot": "errorbar",
  distribution: "histogram",
  relationship: "heatmap",
  "interaction-plot": "line",
  "difference-distribution": "histogram",
  "coefficient-plot": "forest",
  "residual-distribution": "histogram",
  "odds-ratio-plot": "forest",
  calibration: "calibration",
  "incidence-rate-ratio-plot": "forest",
  "observed-fitted-plot": "scatter",
  "contingency-heatmap": "heatmap",
  "adjustment-plot": "scatter",
  "interval-plot": "errorbar",
  "survival-curve": "survival",
  "hazard-ratio-plot": "forest",
  "pca-score-plot": "scatter",
  "pca-scree-plot": "line",
  "pca-loading-heatmap": "heatmap",
  "time-series-plot": "line",
  "autocorrelation-plot": "stem",
  "paired-rank-profile": "line",
  "roc-curve": "roc",
  "precision-recall-curve": "precision-recall",
  "meta-analysis-forest": "forest",
  "meta-analysis-funnel": "funnel",
  "meta-analysis-influence": "bar",
  "distribution-fit-qq": "scatter",
  "distribution-fit-pp": "scatter",
  "lmm-fixed-effects-plot": "forest",
  "lmm-marginal-mean-profile": "line",
  "lmm-subject-trajectory-plot": "line",
  "lmm-random-intercept-plot": "forest",
  "lmm-diagnostic-grid": "scatter",
});

export const STATISTICS_FIGURE_CATALOG_VERSION = "1.6.0" as const;
export const SCIENCE_STATISTICS_NUMERIC_TEMPLATE_BY_SOURCE_ROLE: Readonly<Record<string, string>> = Object.freeze({
  "response-surface-grid": "numeric-3d-response-surface",
});

export function scienceStatisticsNumericTemplateIdForSourceRole(role: string): string | null {
  return SCIENCE_STATISTICS_NUMERIC_TEMPLATE_BY_SOURCE_ROLE[role] ?? null;
}
const STATISTICS_TEMPLATE_BY_ROLE: Readonly<Record<string, string>> = Object.freeze({
  "estimate-plot": "estimation-group-mean-intervals",
  distribution: "distribution-histogram-density",
  relationship: "multivariate-bivariate-count-heatmap",
  "interaction-plot": "estimation-factorial-interaction-means",
  "difference-distribution": "distribution-histogram-density",
  "coefficient-plot": "estimation-coefficient-dot-whisker",
  "residual-distribution": "distribution-histogram-density",
  "odds-ratio-plot": "contingency-odds-ratio-forest",
  calibration: "classification-calibration-curve",
  "incidence-rate-ratio-plot": "estimation-forest-intervals",
  "observed-fitted-plot": "regression-observed-predicted",
  "contingency-heatmap": "contingency-observed-count-heatmap",
  "adjustment-plot": "estimation-multiplicity-raw-adjusted-p",
  "interval-plot": "estimation-forest-intervals",
  "survival-curve": "survival-kaplan-meier",
  "hazard-ratio-plot": "survival-hazard-ratio-forest",
  "pca-score-plot": "multivariate-pca-score-plot",
  "pca-scree-plot": "multivariate-pca-scree-cumulative",
  "pca-loading-heatmap": "multivariate-pca-loading-heatmap",
  "time-series-plot": "time-series-observed-trend",
  "autocorrelation-plot": "time-series-acf-bounds",
  "paired-rank-profile": "estimation-paired-rank-profile",
  "roc-curve": "classification-roc-curve",
  "precision-recall-curve": "classification-precision-recall",
  "meta-analysis-forest": "estimation-meta-analysis-forest",
  "meta-analysis-funnel": "estimation-meta-analysis-funnel",
  "meta-analysis-influence": "estimation-meta-analysis-influence",
  "distribution-fit-qq": "distribution-fit-qq",
  "distribution-fit-pp": "distribution-fit-pp",
  "lmm-fixed-effects-plot": "estimation-coefficient-dot-whisker",
  "lmm-marginal-mean-profile": "estimation-lmm-marginal-mean-profile",
  "lmm-subject-trajectory-plot": "estimation-lmm-subject-trajectories",
  "lmm-random-intercept-plot": "estimation-lmm-random-intercept-caterpillar",
  "lmm-diagnostic-grid": "regression-lmm-diagnostic-grid",
});

function templateBinding(visualization: ScienceStatisticsVisualization): NonNullable<ScienceFigureSpec["panels"][number]["templateBinding"]> {
  const templateId = STATISTICS_TEMPLATE_BY_ROLE[visualization.role] ?? null;
  return {
    status: templateId === null ? "custom-untemplated" : "implemented",
    catalogVersion: STATISTICS_FIGURE_CATALOG_VERSION,
    templateId,
    sourceRole: visualization.role,
  };
}

function chartFamily(visualization: ScienceStatisticsVisualization, sourceSpec: JsonRecord): ScienceFigureChartFamily {
  const declared = STATISTICS_CHART_FAMILY_BY_ROLE[visualization.role];
  if (declared) return declared;
  const cue = `${visualization.role} ${visualization.title}`.toLowerCase();
  if (/kaplan|surviv/u.test(cue)) return "survival";
  if (/precision.?recall/u.test(cue)) return "precision-recall";
  if (/\broc\b|receiver operating/u.test(cue)) return "roc";
  if (/calibrat/u.test(cue)) return "calibration";
  if (/bland.?altman|agreement/u.test(cue)) return "bland-altman";
  if (/forest|coefficient|hazard ratio|odds ratio|interval/u.test(cue)) return "forest";
  if (/confusion|heatmap|matrix|correlation map|relationship/u.test(cue)) return "heatmap";
  if (/density/u.test(cue)) return "density";
  if (/histogram|distribution/u.test(cue)) return "histogram";
  if (/violin/u.test(cue)) return "violin";
  if (/box/u.test(cue)) return "box";
  if (/acf|pacf|autocorrelation|stem/u.test(cue)) return "stem";
  if (/time.?series|trajectory|longitudinal|trend.?plot/u.test(cue)) return "line";
  if (/correlation|association|observed.?predicted|observed.?fitted|residual/u.test(cue)) return "scatter";
  const marks = sourceMarks(sourceSpec);
  if (marks.has("boxplot")) return "box";
  if (marks.has("point") || marks.has("circle") || marks.has("square")) return "scatter";
  if (marks.has("tick") || marks.has("rule")) return "errorbar";
  if (marks.has("rect")) return "bar";
  if (marks.has("area")) return "area";
  return "line";
}

function channelDefinition(sourceSpec: JsonRecord, channel: "x" | "y"): JsonRecord | null {
  for (const encoding of encodingNodes(sourceSpec)) {
    const value = record(encoding[channel]);
    if (value && typeof value.field === "string") return value;
  }
  return null;
}

function scaleType(definition: JsonRecord | null): ScienceFigureScaleType {
  const scale = record(definition?.scale);
  const explicit = String(scale?.type ?? "");
  if (explicit === "log") return "log10";
  if (["sqrt", "symlog", "utc", "time", "band", "ordinal"].includes(explicit)) return explicit as ScienceFigureScaleType;
  if (definition?.type === "temporal") return "time";
  if (definition?.type === "ordinal" || definition?.type === "nominal") return "band";
  return "linear";
}

function axis(sourceSpec: JsonRecord, channel: "x" | "y", field: string | null): ScienceFigureAxis | null {
  if (!field) return null;
  const definition = channelDefinition(sourceSpec, channel);
  const scale = scaleType(definition);
  const axisDefinition = record(definition?.axis);
  const explicitTitle = definition?.title ?? axisDefinition?.title;
  const format = String(axisDefinition?.format ?? "");
  return {
    title: cleanText(explicitTitle, field),
    unit: null,
    scale: {
      type: scale,
      base: scale === "log10" ? 10 : null,
      constant: scale === "symlog" ? 1 : null,
      nice: true,
      clamp: false,
    },
    domain: null,
    tickCount: null,
    tickFormat: format.includes("%") ? "percent" : definition?.type === "temporal" ? "datetime" : "auto",
    grid: channel === "y",
    reverse: Boolean(record(definition?.scale)?.reverse),
  };
}

function interaction(sourceSpec: JsonRecord): ScienceFigureSpec["panels"][number]["interaction"] {
  const serialized = JSON.stringify(sourceSpec).toLowerCase();
  const interval = /"select"\s*:\s*\{[^}]*"type"\s*:\s*"interval"/u.test(serialized)
    || /"selection"\s*:\s*\{[^}]*"type"\s*:\s*"interval"/u.test(serialized);
  return {
    zoom: interval,
    pan: interval,
    brush: { enabled: interval, mode: interval ? "xy" : null },
    linkGroup: interval ? "statistics-selection" : null,
    rotate3d: false,
  };
}

export function createScienceStatisticsFigurePayload(input: {
  projectId: string;
  figureId: string;
  createdAt: string;
  parentArtifact: ScienceArtifact;
  parentVersion: ScienceArtifactVersion;
  run: ScienceResearchRun;
  visualizationIndex: number;
  title?: string;
}): ScienceStatisticsFigureArtifactPayload {
  const analysis = validateScienceStatisticsAnalysisPayload(input.parentVersion.payload);
  const visualization = analysis.visualizations[input.visualizationIndex];
  if (!visualization) throw new Error("science-statistics-figure-visualization-not-found");
  const sourceSpec = sourceSpecForVisualization(analysis, visualization);
  const compiledSpec = compileScienceStatisticsVisualization(sourceSpec);
  if (input.run.id !== input.parentArtifact.sourceRunId || input.run.status !== "succeeded"
    || input.run.toolId !== SCIENCE_STATISTICS_TOOL_ID || input.run.toolVersion !== SCIENCE_STATISTICS_TOOL_VERSION
    || !input.run.outputManifestSha256) throw new Error("science-statistics-figure-run-invalid");
  const title = cleanText(input.title, visualization.title, 240);
  const receiptCore = {
    schema: SCIENCE_FIGURE_ANALYSIS_RECEIPT_SCHEMA,
    projectId: input.projectId,
    analysisRunId: input.run.id,
    toolId: input.run.toolId,
    toolVersion: input.run.toolVersion,
    artifactId: input.parentArtifact.id,
    artifactVersion: input.parentVersion.version,
    artifactContentSha256: input.parentVersion.contentSha256,
    inputManifestSha256: input.run.inputManifestSha256,
    environmentSha256: input.run.environmentSha256,
    outputManifestSha256: input.run.outputManifestSha256,
  };
  const analysisReceipt = { ...receiptCore, receiptSha256: scienceFigureSha256(receiptCore) };
  const availableFields = collectAvailableFields(sourceSpec);
  const bindingCore = {
    id: "analysis-output",
    projectId: input.projectId,
    artifactId: input.parentArtifact.id,
    artifactVersion: input.parentVersion.version,
    artifactContentSha256: input.parentVersion.contentSha256,
    availableFields,
    analysisReceipt,
  };
  const binding = { ...bindingCore, bindingSha256: scienceFigureSha256(bindingCore) };
  const diagnosticPanelTitles = ["Conditional residuals vs fitted", "Conditional residual normal Q-Q", "Random-intercept normal Q-Q"];
  const diagnosticChildren = visualization.role === "lmm-diagnostic-grid" && Array.isArray(sourceSpec.vconcat)
    ? sourceSpec.vconcat.map(record).filter((item): item is JsonRecord => item !== null)
    : [];
  if (visualization.role === "lmm-diagnostic-grid" && diagnosticChildren.length !== 3) {
    throw new Error("science-statistics-lmm-diagnostic-grid-panels-invalid");
  }
  const panelSources = diagnosticChildren.length === 3 ? diagnosticChildren : [sourceSpec];
  const panelIds = panelSources.map((_, index) => panelSources.length === 1 ? "statistical-figure" : `statistical-figure-${index + 1}`);
  const panels = panelSources.map((panelSource, index) => {
    const encoding = sourceEncoding(panelSource);
    return {
      id: panelIds[index],
      title: panelSources.length === 1 ? title : diagnosticPanelTitles[index],
      chartFamily: chartFamily(visualization, sourceSpec),
      dataBindingId: binding.id,
      placement: {
        base: { row: index + 1, column: 1, rowSpan: 1, columnSpan: 1 },
        breakpoints: [{ breakpointId: "narrow", row: index + 1, column: 1, rowSpan: 1, columnSpan: 1 }],
      },
      encoding,
      axes: { x: axis(panelSource, "x", encoding.x), y: axis(panelSource, "y", encoding.y), z: null },
      legend: encoding.color || encoding.series || encoding.shape
        ? { show: true, position: "right" as const, orientation: "vertical" as const, title: null, maxItems: 50 }
        : null,
      colorbar: null,
      annotations: [],
      interaction: interaction(panelSource),
      templateBinding: templateBinding(visualization),
    };
  });
  const figureCore: Omit<ScienceFigureSpec, "specSha256"> = {
    schema: SCIENCE_FIGURE_SPEC_SCHEMA,
    figureId: input.figureId,
    version: 1,
    title,
    caption: `${title}. Generated from immutable ${analysis.method} analysis artifact version ${input.parentVersion.version}.`,
    data: [binding],
    layout: {
      type: "tiled",
      base: { rows: panelSources.length, columns: 1, gapPt: panelSources.length === 1 ? 0 : 8 },
      breakpoints: [{ id: "narrow", maxWidthPx: 700, rows: panelSources.length, columns: 1, gapPt: panelSources.length === 1 ? 0 : 8 }],
    },
    panels,
    export: {
      journalName: null,
      columnWidth: "double",
      widthMm: 180,
      heightMm: panelSources.length === 1 ? 110 : 210,
      background: "white",
      baseFontSizePt: 8,
      outputs: [
        { format: "png", dpi: 600, colorMode: "rgb" },
        { format: "svg", dpi: null, colorMode: "rgb" },
      ],
    },
    accessibility: {
      title,
      description: `${title}, a ${chartFamily(visualization, sourceSpec)} chart from the ${analysis.method} analysis.`,
      longDescription: `This figure is bound to statistics artifact ${input.parentArtifact.id} version ${input.parentVersion.version}. Exact plotted fields are ${availableFields.join(", ")}.`,
      colorVisionSafe: false,
      readingOrder: panelIds,
      panelAlternatives: panelIds.map((panelId, index) => ({
        panelId,
        text: panelSources.length === 1
          ? "The immutable parent analysis and inline chart data provide the exact values used by this panel."
          : `${diagnosticPanelTitles[index]}. The immutable parent analysis and inline diagnostic rows provide the exact values used by this panel.`,
      })),
    },
    provenance: {
      createdAt: input.createdAt,
      creator: { kind: "agent", id: "agentlas.figure-author", version: "1.0.0" },
      dataBindingsSha256: scienceFigureSha256([binding]),
      analysisReceiptSha256s: [analysisReceipt.receiptSha256],
      software: [
        { name: "Agentlas Science Statistics", version: SCIENCE_STATISTICS_TOOL_VERSION, contentSha256: scienceFigureSha256(`agentlas-statistics:${SCIENCE_STATISTICS_TOOL_VERSION}`) },
        { name: "Vega", version: SCIENCE_STATISTICS_FIGURE_RENDERER_VERSION, contentSha256: scienceFigureSha256(`vega:${SCIENCE_STATISTICS_FIGURE_RENDERER_VERSION}`) },
      ],
      notes: ["Figure semantics and renderer pixels remain bound to the immutable parent analysis version."],
    },
  };
  const figureSpec = validateScienceFigureSpec({ ...figureCore, specSha256: scienceFigureSha256(figureCore) });
  return validateScienceStatisticsFigureArtifactPayload({
    schema: SCIENCE_STATISTICS_FIGURE_ARTIFACT_SCHEMA,
    statisticsArtifact: {
      artifactId: input.parentArtifact.id,
      artifactVersion: input.parentVersion.version,
      contentSha256: input.parentVersion.contentSha256,
    },
    method: analysis.method,
    visualization: {
      index: input.visualizationIndex,
      sourceArtifactIndex: visualization.sourceArtifactIndex,
      sourceArtifactSha256: visualization.sourceArtifactSha256,
      sourceSpecSha256: visualization.sourceSpecSha256,
      role: visualization.role,
      title: visualization.title,
    },
    sourceSpec,
    originalSpecSha256: scienceStatisticsSha256(compiledSpec),
    spec: compiledSpec,
    figureSpec,
  });
}
