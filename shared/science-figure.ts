import { createHash } from "node:crypto";

export const SCIENCE_FIGURE_SPEC_SCHEMA = "agentlas.science.figure-spec/v1" as const;
export const SCIENCE_FIGURE_ANALYSIS_RECEIPT_SCHEMA = "agentlas.science.figure-analysis-receipt/v1" as const;
export const SCIENCE_FIGURE_MAX_PANELS = 12 as const;

/**
 * Semantic figure families, deliberately independent from renderer IDs and
 * installed renderer capabilities. Capability resolution belongs to the host.
 */
export const SCIENCE_FIGURE_CHART_FAMILIES = [
  "line", "step", "area", "stacked-area", "scatter", "bubble", "bar", "grouped-bar", "stacked-bar",
  "histogram", "density", "box", "violin", "beeswarm", "errorbar", "forest", "survival", "roc",
  "precision-recall", "calibration", "bland-altman", "heatmap", "contour", "filled-contour", "image",
  "stem", "polar", "radar", "waterfall", "funnel", "parallel-coordinates", "sankey", "network",
  "geographic-map", "genomic-track", "phylogeny", "scatter3d", "surface3d", "mesh3d", "contour3d",
  "volume3d", "vector-field3d", "molecule3d", "crystal3d", "sky3d",
] as const;

export type ScienceFigureChartFamily = typeof SCIENCE_FIGURE_CHART_FAMILIES[number];
export type ScienceFigureScaleType = "linear" | "log10" | "symlog" | "sqrt" | "time" | "utc" | "ordinal" | "band";
export type ScienceFigureValue = string | number;

export interface ScienceFigureAnalysisReceipt {
  schema: typeof SCIENCE_FIGURE_ANALYSIS_RECEIPT_SCHEMA;
  projectId: string;
  analysisRunId: string;
  toolId: string;
  toolVersion: string;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  inputManifestSha256: string;
  environmentSha256: string;
  outputManifestSha256: string;
  receiptSha256: string;
}

export interface ScienceFigureDataBinding {
  id: string;
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  availableFields: string[];
  analysisReceipt: ScienceFigureAnalysisReceipt;
  bindingSha256: string;
}

export interface ScienceFigureGridDefinition {
  rows: number;
  columns: number;
  gapPt: number;
}

export interface ScienceFigureBreakpoint extends ScienceFigureGridDefinition {
  id: string;
  maxWidthPx: number;
}

export interface ScienceFigureLayout {
  type: "tiled";
  base: ScienceFigureGridDefinition;
  breakpoints: ScienceFigureBreakpoint[];
}

export interface ScienceFigureGridPlacement {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
}

export interface ScienceFigureResponsivePlacement extends ScienceFigureGridPlacement {
  breakpointId: string;
}

export interface ScienceFigurePanelPlacement {
  base: ScienceFigureGridPlacement;
  breakpoints: ScienceFigureResponsivePlacement[];
}

export interface ScienceFigureEncoding {
  x: string | null;
  y: string | null;
  z: string | null;
  xLow: string | null;
  xHigh: string | null;
  yLow: string | null;
  yHigh: string | null;
  color: string | null;
  size: string | null;
  shape: string | null;
  series: string | null;
  label: string | null;
  facetRow: string | null;
  facetColumn: string | null;
}

export interface ScienceFigureScale {
  type: ScienceFigureScaleType;
  base: 2 | 10 | null;
  constant: number | null;
  nice: boolean;
  clamp: boolean;
}

export interface ScienceFigureDomain {
  min: ScienceFigureValue;
  max: ScienceFigureValue;
}

export interface ScienceFigureAxis {
  title: string;
  unit: string | null;
  scale: ScienceFigureScale;
  domain: ScienceFigureDomain | null;
  tickCount: number | null;
  tickFormat: "auto" | "number" | "percent" | "scientific" | "date" | "datetime";
  grid: boolean;
  reverse: boolean;
}

export interface ScienceFigureLegend {
  show: boolean;
  position: "top" | "right" | "bottom" | "left" | "inside";
  orientation: "horizontal" | "vertical";
  title: string | null;
  maxItems: number;
}

export interface ScienceFigureColorbar {
  show: boolean;
  position: "right" | "left" | "top" | "bottom";
  title: string | null;
  palette: "viridis" | "cividis" | "magma" | "inferno" | "plasma" | "blue-red" | "grayscale";
  reverse: boolean;
  scale: "linear" | "log10" | "symlog";
  domain: { min: number; max: number } | null;
}

export interface ScienceFigureAnnotationStyle {
  color: string;
  fontSizePt: number;
  lineWidthPt: number;
  lineStyle: "solid" | "dashed" | "dotted";
}

export interface ScienceFigureAnnotation {
  id: string;
  kind: "text" | "point" | "line" | "region" | "arrow";
  text: string;
  coordinate: "data" | "panel";
  x: ScienceFigureValue;
  y: ScienceFigureValue;
  z: ScienceFigureValue | null;
  x2: ScienceFigureValue | null;
  y2: ScienceFigureValue | null;
  style: ScienceFigureAnnotationStyle;
}

export interface ScienceFigureBrush {
  enabled: boolean;
  mode: "x" | "y" | "xy" | "lasso" | null;
}

export interface ScienceFigureInteraction {
  zoom: boolean;
  pan: boolean;
  brush: ScienceFigureBrush;
  linkGroup: string | null;
  rotate3d: boolean;
}

export interface ScienceFigureTemplateBinding {
  status: "implemented" | "custom-untemplated";
  catalogVersion: string;
  templateId: string | null;
  sourceRole: string;
}

export interface ScienceFigurePanel {
  id: string;
  title: string;
  chartFamily: ScienceFigureChartFamily;
  dataBindingId: string;
  placement: ScienceFigurePanelPlacement;
  encoding: ScienceFigureEncoding;
  axes: { x: ScienceFigureAxis | null; y: ScienceFigureAxis | null; z: ScienceFigureAxis | null };
  legend: ScienceFigureLegend | null;
  colorbar: ScienceFigureColorbar | null;
  annotations: ScienceFigureAnnotation[];
  interaction: ScienceFigureInteraction;
  templateBinding?: ScienceFigureTemplateBinding;
}

export interface ScienceFigureExportOutput {
  format: "png" | "svg" | "pdf";
  dpi: number | null;
  colorMode: "rgb" | "cmyk";
}

export interface ScienceFigurePublicationExport {
  journalName: string | null;
  columnWidth: "single" | "one-and-half" | "double" | "custom";
  widthMm: number;
  heightMm: number;
  background: "white" | "transparent";
  baseFontSizePt: number;
  outputs: ScienceFigureExportOutput[];
}

export interface ScienceFigureAccessibility {
  title: string;
  description: string;
  longDescription: string;
  colorVisionSafe: boolean;
  readingOrder: string[];
  panelAlternatives: Array<{ panelId: string; text: string }>;
}

export interface ScienceFigureProvenance {
  createdAt: string;
  creator: { kind: "human" | "agent" | "hybrid"; id: string; version: string };
  dataBindingsSha256: string;
  analysisReceiptSha256s: string[];
  software: Array<{ name: string; version: string; contentSha256: string }>;
  notes: string[];
}

export interface ScienceFigureSpec {
  schema: typeof SCIENCE_FIGURE_SPEC_SCHEMA;
  figureId: string;
  version: number;
  title: string;
  caption: string;
  data: ScienceFigureDataBinding[];
  layout: ScienceFigureLayout;
  panels: ScienceFigurePanel[];
  export: ScienceFigurePublicationExport;
  accessibility: ScienceFigureAccessibility;
  provenance: ScienceFigureProvenance;
  specSha256: string;
}

type JsonRecord = Record<string, unknown>;

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-z][a-z0-9._-]{0,159}$/;
const PANEL_TOKEN_RE = /^[a-z][a-z0-9-]{0,63}$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const REMOTE_REFERENCE_RE = /(?:\b(?:https?|wss?|ftp):\/\/|\bjavascript:|\bdata:text\/html)/i;
const ARBITRARY_CODE_RE = /(?:<script\b|\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|=>)/i;
const FORBIDDEN_KEYS = new Set(["url", "uri", "href", "src", "script", "javascript", "expression", "expr", "transform", "signal"]);
const CHART_FAMILIES = new Set<string>(SCIENCE_FIGURE_CHART_FAMILIES);
const THREE_DIMENSIONAL_FAMILIES = new Set<ScienceFigureChartFamily>([
  "scatter3d", "surface3d", "mesh3d", "contour3d", "volume3d", "vector-field3d", "molecule3d", "crystal3d", "sky3d",
]);
const COORDINATE_3D_FAMILIES = new Set<ScienceFigureChartFamily>([
  "scatter3d", "surface3d", "mesh3d", "contour3d", "volume3d", "vector-field3d", "sky3d",
]);

function record(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as JsonRecord : null;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function assertSafeJsonTree(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("science-figure-nonfinite-number-forbidden");
    return;
  }
  if (typeof value === "string") {
    if (REMOTE_REFERENCE_RE.test(value)) throw new Error("science-figure-remote-reference-forbidden");
    if (ARBITRARY_CODE_RE.test(value)) throw new Error("science-figure-arbitrary-code-forbidden");
    return;
  }
  if (typeof value !== "object") throw new Error("science-figure-non-json-value-forbidden");
  if (seen.has(value)) throw new Error("science-figure-circular-value-forbidden");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertSafeJsonTree(child, seen);
    seen.delete(value);
    return;
  }
  const item = record(value);
  if (!item) throw new Error("science-figure-non-plain-object-forbidden");
  for (const [key, child] of Object.entries(item)) {
    const normalized = key.toLocaleLowerCase("en-US");
    if (FORBIDDEN_KEYS.has(normalized) || normalized === "__proto__" || normalized === "prototype" || normalized === "constructor" || /^on[a-z]/.test(normalized)) {
      throw new Error("science-figure-executable-key-forbidden");
    }
    assertSafeJsonTree(child, seen);
  }
  seen.delete(value);
}

function canonicalValue(value: unknown): unknown {
  assertSafeJsonTree(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  const item = value as JsonRecord;
  return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonicalValue(item[key])]));
}

/** Canonical JSON SHA-256 with sorted object keys and preserved array order. */
export function scienceFigureSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

/** Hashes a figure core; an existing self-hash is deliberately excluded. */
export function scienceFigureSpecSha256(value: unknown): string {
  const item = record(value);
  if (!item) throw new Error("science-figure-spec-invalid");
  const core = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "specSha256"));
  return scienceFigureSha256(core);
}

function text(value: unknown, maxLength: number, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maxLength) throw new Error(`science-figure-${field}-invalid`);
  return value;
}

function nullableText(value: unknown, maxLength: number, field: string): string | null {
  return value === null ? null : text(value, maxLength, field);
}

function integer(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`science-figure-${field}-invalid`);
  return Number(value);
}

function finite(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`science-figure-${field}-invalid`);
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(`science-figure-${field}-invalid`);
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`science-figure-${field}-invalid`);
  return value;
}

function token(value: unknown, field: string, panel = false): string {
  if (typeof value !== "string" || !(panel ? PANEL_TOKEN_RE : TOKEN_RE).test(value)) throw new Error(`science-figure-${field}-invalid`);
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const result = text(value, 40, field);
  if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error(`science-figure-${field}-invalid`);
  return result;
}

function validateAnalysisReceipt(value: unknown): ScienceFigureAnalysisReceipt {
  const receipt = record(value);
  if (!receipt || !exactKeys(receipt, [
    "schema", "projectId", "analysisRunId", "toolId", "toolVersion", "artifactId", "artifactVersion",
    "artifactContentSha256", "inputManifestSha256", "environmentSha256", "outputManifestSha256", "receiptSha256",
  ]) || receipt.schema !== SCIENCE_FIGURE_ANALYSIS_RECEIPT_SCHEMA) throw new Error("science-figure-analysis-receipt-invalid");
  const core = {
    schema: SCIENCE_FIGURE_ANALYSIS_RECEIPT_SCHEMA,
    projectId: uuid(receipt.projectId, "analysis-receipt-project-id"),
    analysisRunId: uuid(receipt.analysisRunId, "analysis-run-id"),
    toolId: token(receipt.toolId, "analysis-tool-id"),
    toolVersion: text(receipt.toolVersion, 80, "analysis-tool-version"),
    artifactId: uuid(receipt.artifactId, "analysis-artifact-id"),
    artifactVersion: integer(receipt.artifactVersion, 1, Number.MAX_SAFE_INTEGER, "analysis-artifact-version"),
    artifactContentSha256: sha256(receipt.artifactContentSha256, "analysis-artifact-content-sha256"),
    inputManifestSha256: sha256(receipt.inputManifestSha256, "analysis-input-manifest-sha256"),
    environmentSha256: sha256(receipt.environmentSha256, "analysis-environment-sha256"),
    outputManifestSha256: sha256(receipt.outputManifestSha256, "analysis-output-manifest-sha256"),
  };
  const receiptSha256 = sha256(receipt.receiptSha256, "analysis-receipt-sha256");
  if (scienceFigureSha256(core) !== receiptSha256) throw new Error("science-figure-analysis-receipt-hash-invalid");
  return { ...core, receiptSha256 };
}

function validateDataBindings(value: unknown): ScienceFigureDataBinding[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error("science-figure-data-bindings-invalid");
  const bindings = value.map((entry) => {
    const binding = record(entry);
    if (!binding || !exactKeys(binding, [
      "id", "projectId", "artifactId", "artifactVersion", "artifactContentSha256", "availableFields", "analysisReceipt", "bindingSha256",
    ])) throw new Error("science-figure-data-binding-invalid");
    const availableFields = Array.isArray(binding.availableFields)
      ? binding.availableFields.map((field) => text(field, 240, "data-field")) : (() => { throw new Error("science-figure-data-fields-invalid"); })();
    if (availableFields.length < 1 || availableFields.length > 2_000 || new Set(availableFields).size !== availableFields.length) {
      throw new Error("science-figure-data-fields-invalid");
    }
    const analysisReceipt = validateAnalysisReceipt(binding.analysisReceipt);
    const core = {
      id: token(binding.id, "data-binding-id", true),
      projectId: uuid(binding.projectId, "data-project-id"),
      artifactId: uuid(binding.artifactId, "data-artifact-id"),
      artifactVersion: integer(binding.artifactVersion, 1, Number.MAX_SAFE_INTEGER, "data-artifact-version"),
      artifactContentSha256: sha256(binding.artifactContentSha256, "data-artifact-content-sha256"),
      availableFields,
      analysisReceipt,
    };
    if (analysisReceipt.projectId !== core.projectId || analysisReceipt.artifactId !== core.artifactId
      || analysisReceipt.artifactVersion !== core.artifactVersion || analysisReceipt.artifactContentSha256 !== core.artifactContentSha256) {
      throw new Error("science-figure-data-binding-stale");
    }
    const bindingSha256 = sha256(binding.bindingSha256, "data-binding-sha256");
    if (scienceFigureSha256(core) !== bindingSha256) throw new Error("science-figure-data-binding-hash-invalid");
    return { ...core, bindingSha256 };
  });
  if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length
    || new Set(bindings.map((binding) => `${binding.projectId}:${binding.artifactId}:${binding.artifactVersion}`)).size !== bindings.length) {
    throw new Error("science-figure-data-binding-duplicate");
  }
  const projectIds = new Set(bindings.map((binding) => binding.projectId));
  if (projectIds.size !== 1) throw new Error("science-figure-cross-project-data-forbidden");
  return bindings;
}

function validateGrid(value: unknown, field: string): ScienceFigureGridDefinition {
  const grid = record(value);
  if (!grid || !exactKeys(grid, ["rows", "columns", "gapPt"])) throw new Error(`science-figure-${field}-invalid`);
  return {
    rows: integer(grid.rows, 1, SCIENCE_FIGURE_MAX_PANELS, `${field}-rows`),
    columns: integer(grid.columns, 1, SCIENCE_FIGURE_MAX_PANELS, `${field}-columns`),
    gapPt: finite(grid.gapPt, 0, 72, `${field}-gap`),
  };
}

function validateLayout(value: unknown): ScienceFigureLayout {
  const layout = record(value);
  if (!layout || !exactKeys(layout, ["type", "base", "breakpoints"]) || layout.type !== "tiled" || !Array.isArray(layout.breakpoints)
    || layout.breakpoints.length < 1 || layout.breakpoints.length > 4) throw new Error("science-figure-layout-invalid");
  const base = validateGrid(layout.base, "layout-base");
  const breakpoints = layout.breakpoints.map((entry) => {
    const item = record(entry);
    if (!item || !exactKeys(item, ["id", "maxWidthPx", "rows", "columns", "gapPt"])) throw new Error("science-figure-breakpoint-invalid");
    const grid = validateGrid({ rows: item.rows, columns: item.columns, gapPt: item.gapPt }, "breakpoint-grid");
    return { id: token(item.id, "breakpoint-id", true), maxWidthPx: integer(item.maxWidthPx, 320, 4_096, "breakpoint-width"), ...grid };
  });
  if (new Set(breakpoints.map((entry) => entry.id)).size !== breakpoints.length
    || new Set(breakpoints.map((entry) => entry.maxWidthPx)).size !== breakpoints.length
    || breakpoints.some((entry, index) => index > 0 && entry.maxWidthPx <= breakpoints[index - 1].maxWidthPx)) {
    throw new Error("science-figure-breakpoints-invalid");
  }
  return { type: "tiled", base, breakpoints };
}

function validateGridPlacement(value: unknown, grid: ScienceFigureGridDefinition, field: string): ScienceFigureGridPlacement {
  const placement = record(value);
  if (!placement || !exactKeys(placement, ["row", "column", "rowSpan", "columnSpan"])) throw new Error(`science-figure-${field}-invalid`);
  const result = {
    row: integer(placement.row, 1, grid.rows, `${field}-row`),
    column: integer(placement.column, 1, grid.columns, `${field}-column`),
    rowSpan: integer(placement.rowSpan, 1, grid.rows, `${field}-row-span`),
    columnSpan: integer(placement.columnSpan, 1, grid.columns, `${field}-column-span`),
  };
  if (result.row + result.rowSpan - 1 > grid.rows || result.column + result.columnSpan - 1 > grid.columns) {
    throw new Error("science-figure-panel-span-invalid");
  }
  return result;
}

function validatePanelPlacement(value: unknown, layout: ScienceFigureLayout): ScienceFigurePanelPlacement {
  const placement = record(value);
  if (!placement || !exactKeys(placement, ["base", "breakpoints"]) || !Array.isArray(placement.breakpoints)) {
    throw new Error("science-figure-panel-placement-invalid");
  }
  const base = validateGridPlacement(placement.base, layout.base, "panel-base-placement");
  const breakpointPlacements = placement.breakpoints.map((entry) => {
    const item = record(entry);
    if (!item || !exactKeys(item, ["breakpointId", "row", "column", "rowSpan", "columnSpan"])) {
      throw new Error("science-figure-panel-breakpoint-placement-invalid");
    }
    const breakpointId = token(item.breakpointId, "panel-breakpoint-id", true);
    const breakpoint = layout.breakpoints.find((candidate) => candidate.id === breakpointId);
    if (!breakpoint) throw new Error("science-figure-panel-breakpoint-not-found");
    return { breakpointId, ...validateGridPlacement({ row: item.row, column: item.column, rowSpan: item.rowSpan, columnSpan: item.columnSpan }, breakpoint, "panel-responsive-placement") };
  });
  if (breakpointPlacements.length !== layout.breakpoints.length
    || new Set(breakpointPlacements.map((item) => item.breakpointId)).size !== layout.breakpoints.length) {
    throw new Error("science-figure-panel-breakpoint-coverage-invalid");
  }
  return { base, breakpoints: breakpointPlacements };
}

function validateScale(value: unknown): ScienceFigureScale {
  const scale = record(value);
  if (!scale || !exactKeys(scale, ["type", "base", "constant", "nice", "clamp"])
    || !["linear", "log10", "symlog", "sqrt", "time", "utc", "ordinal", "band"].includes(String(scale.type))
    || typeof scale.nice !== "boolean" || typeof scale.clamp !== "boolean") throw new Error("science-figure-scale-invalid");
  const type = scale.type as ScienceFigureScaleType;
  const base = scale.base === null ? null : integer(scale.base, 2, 10, "scale-base") as 2 | 10;
  const constant = scale.constant === null ? null : finite(scale.constant, Number.MIN_VALUE, Number.MAX_VALUE, "scale-constant");
  if (type === "log10" && base !== 10 || type !== "log10" && base !== null || type === "symlog" && constant === null
    || type !== "symlog" && constant !== null) throw new Error("science-figure-scale-parameters-invalid");
  return { type, base, constant, nice: scale.nice, clamp: scale.clamp };
}

function figureValue(value: unknown, field: string): ScienceFigureValue {
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  return text(value, 240, field);
}

function validateAxis(value: unknown): ScienceFigureAxis | null {
  if (value === null) return null;
  const axis = record(value);
  if (!axis || !exactKeys(axis, ["title", "unit", "scale", "domain", "tickCount", "tickFormat", "grid", "reverse"])
    || !["auto", "number", "percent", "scientific", "date", "datetime"].includes(String(axis.tickFormat))
    || typeof axis.grid !== "boolean" || typeof axis.reverse !== "boolean") throw new Error("science-figure-axis-invalid");
  const scale = validateScale(axis.scale);
  let domain: ScienceFigureDomain | null = null;
  if (axis.domain !== null) {
    const item = record(axis.domain);
    if (!item || !exactKeys(item, ["min", "max"])) throw new Error("science-figure-axis-domain-invalid");
    domain = { min: figureValue(item.min, "axis-domain-min"), max: figureValue(item.max, "axis-domain-max") };
    if (typeof domain.min !== typeof domain.max || typeof domain.min === "number" && domain.min >= Number(domain.max)
      || typeof domain.min === "string" && domain.min >= String(domain.max)) throw new Error("science-figure-axis-domain-invalid");
    if (scale.type === "log10" && (typeof domain.min !== "number" || domain.min <= 0)) throw new Error("science-figure-log-domain-invalid");
    if (["time", "utc"].includes(scale.type) && (typeof domain.min !== "string" || Number.isNaN(Date.parse(domain.min)) || Number.isNaN(Date.parse(String(domain.max))))) {
      throw new Error("science-figure-time-domain-invalid");
    }
  }
  return {
    title: text(axis.title, 500, "axis-title"),
    unit: nullableText(axis.unit, 120, "axis-unit"),
    scale,
    domain,
    tickCount: axis.tickCount === null ? null : integer(axis.tickCount, 2, 50, "axis-tick-count"),
    tickFormat: axis.tickFormat as ScienceFigureAxis["tickFormat"],
    grid: axis.grid,
    reverse: axis.reverse,
  };
}

const ENCODING_KEYS = ["x", "y", "z", "xLow", "xHigh", "yLow", "yHigh", "color", "size", "shape", "series", "label", "facetRow", "facetColumn"] as const;

function validateEncoding(value: unknown, fields: Set<string>): ScienceFigureEncoding {
  const encoding = record(value);
  if (!encoding || !exactKeys(encoding, ENCODING_KEYS)) throw new Error("science-figure-encoding-invalid");
  const normalized = Object.fromEntries(ENCODING_KEYS.map((key) => {
    const field = encoding[key] === null ? null : text(encoding[key], 240, `encoding-${key}`);
    if (field !== null && !fields.has(field)) throw new Error("science-figure-encoding-field-not-found");
    return [key, field];
  })) as unknown as ScienceFigureEncoding;
  return normalized;
}

function validateLegend(value: unknown): ScienceFigureLegend | null {
  if (value === null) return null;
  const legend = record(value);
  if (!legend || !exactKeys(legend, ["show", "position", "orientation", "title", "maxItems"])
    || typeof legend.show !== "boolean" || !["top", "right", "bottom", "left", "inside"].includes(String(legend.position))
    || !["horizontal", "vertical"].includes(String(legend.orientation))) throw new Error("science-figure-legend-invalid");
  return {
    show: legend.show,
    position: legend.position as ScienceFigureLegend["position"],
    orientation: legend.orientation as ScienceFigureLegend["orientation"],
    title: nullableText(legend.title, 240, "legend-title"),
    maxItems: integer(legend.maxItems, 1, 500, "legend-max-items"),
  };
}

function validateColorbar(value: unknown): ScienceFigureColorbar | null {
  if (value === null) return null;
  const colorbar = record(value);
  if (!colorbar || !exactKeys(colorbar, ["show", "position", "title", "palette", "reverse", "scale", "domain"])
    || typeof colorbar.show !== "boolean" || typeof colorbar.reverse !== "boolean"
    || !["right", "left", "top", "bottom"].includes(String(colorbar.position))
    || !["viridis", "cividis", "magma", "inferno", "plasma", "blue-red", "grayscale"].includes(String(colorbar.palette))
    || !["linear", "log10", "symlog"].includes(String(colorbar.scale))) throw new Error("science-figure-colorbar-invalid");
  let domain: { min: number; max: number } | null = null;
  if (colorbar.domain !== null) {
    const item = record(colorbar.domain);
    if (!item || !exactKeys(item, ["min", "max"])) throw new Error("science-figure-colorbar-domain-invalid");
    domain = { min: finite(item.min, -Number.MAX_VALUE, Number.MAX_VALUE, "colorbar-min"), max: finite(item.max, -Number.MAX_VALUE, Number.MAX_VALUE, "colorbar-max") };
    if (domain.min >= domain.max || colorbar.scale === "log10" && domain.min <= 0) throw new Error("science-figure-colorbar-domain-invalid");
  }
  return {
    show: colorbar.show,
    position: colorbar.position as ScienceFigureColorbar["position"],
    title: nullableText(colorbar.title, 240, "colorbar-title"),
    palette: colorbar.palette as ScienceFigureColorbar["palette"],
    reverse: colorbar.reverse,
    scale: colorbar.scale as ScienceFigureColorbar["scale"],
    domain,
  };
}

function validateAnnotations(value: unknown, is3d: boolean): ScienceFigureAnnotation[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("science-figure-annotations-invalid");
  const annotations = value.map((entry) => {
    const annotation = record(entry);
    if (!annotation || !exactKeys(annotation, ["id", "kind", "text", "coordinate", "x", "y", "z", "x2", "y2", "style"])
      || !["text", "point", "line", "region", "arrow"].includes(String(annotation.kind))
      || !["data", "panel"].includes(String(annotation.coordinate))) throw new Error("science-figure-annotation-invalid");
    const style = record(annotation.style);
    if (!style || !exactKeys(style, ["color", "fontSizePt", "lineWidthPt", "lineStyle"])
      || typeof style.color !== "string" || !HEX_COLOR_RE.test(style.color)
      || !["solid", "dashed", "dotted"].includes(String(style.lineStyle))) throw new Error("science-figure-annotation-style-invalid");
    const kind = annotation.kind as ScienceFigureAnnotation["kind"];
    const x2 = annotation.x2 === null ? null : figureValue(annotation.x2, "annotation-x2");
    const y2 = annotation.y2 === null ? null : figureValue(annotation.y2, "annotation-y2");
    const z = annotation.z === null ? null : figureValue(annotation.z, "annotation-z");
    if (["line", "region", "arrow"].includes(kind) && (x2 === null || y2 === null) || !is3d && z !== null) throw new Error("science-figure-annotation-coordinates-invalid");
    return {
      id: token(annotation.id, "annotation-id", true),
      kind,
      text: text(annotation.text, 2_000, "annotation-text"),
      coordinate: annotation.coordinate as ScienceFigureAnnotation["coordinate"],
      x: figureValue(annotation.x, "annotation-x"),
      y: figureValue(annotation.y, "annotation-y"),
      z,
      x2,
      y2,
      style: {
        color: style.color,
        fontSizePt: finite(style.fontSizePt, 4, 72, "annotation-font-size"),
        lineWidthPt: finite(style.lineWidthPt, 0.1, 20, "annotation-line-width"),
        lineStyle: style.lineStyle as ScienceFigureAnnotationStyle["lineStyle"],
      },
    };
  });
  if (new Set(annotations.map((item) => item.id)).size !== annotations.length) throw new Error("science-figure-annotation-duplicate");
  return annotations;
}

function validateInteraction(value: unknown, is3d: boolean): ScienceFigureInteraction {
  const interaction = record(value);
  if (!interaction || !exactKeys(interaction, ["zoom", "pan", "brush", "linkGroup", "rotate3d"])
    || typeof interaction.zoom !== "boolean" || typeof interaction.pan !== "boolean" || typeof interaction.rotate3d !== "boolean") {
    throw new Error("science-figure-interaction-invalid");
  }
  const brush = record(interaction.brush);
  if (!brush || !exactKeys(brush, ["enabled", "mode"]) || typeof brush.enabled !== "boolean"
    || brush.mode !== null && !["x", "y", "xy", "lasso"].includes(String(brush.mode))
    || brush.enabled !== (brush.mode !== null)) throw new Error("science-figure-brush-invalid");
  if (!is3d && interaction.rotate3d || is3d && brush.enabled && brush.mode !== "lasso") throw new Error("science-figure-interaction-dimensionality-invalid");
  const linkGroup = interaction.linkGroup === null ? null : token(interaction.linkGroup, "interaction-link-group", true);
  if (linkGroup !== null && !interaction.zoom && !interaction.pan && !brush.enabled) throw new Error("science-figure-interaction-link-inert");
  return { zoom: interaction.zoom, pan: interaction.pan, brush: { enabled: brush.enabled, mode: brush.mode as ScienceFigureBrush["mode"] }, linkGroup, rotate3d: interaction.rotate3d };
}

function validateTemplateBinding(value: unknown): ScienceFigureTemplateBinding {
  const binding = record(value);
  if (!binding || !exactKeys(binding, ["status", "catalogVersion", "templateId", "sourceRole"])
    || !["implemented", "custom-untemplated"].includes(String(binding.status))) {
    throw new Error("science-figure-template-binding-invalid");
  }
  const status = binding.status as ScienceFigureTemplateBinding["status"];
  const templateId = binding.templateId === null ? null : token(binding.templateId, "figure-template-id", true);
  const catalogVersion = text(binding.catalogVersion, 40, "figure-template-catalog-version");
  if (status === "implemented" !== (templateId !== null)) throw new Error("science-figure-template-binding-invalid");
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u.test(catalogVersion)) throw new Error("science-figure-template-binding-invalid");
  return {
    status,
    catalogVersion,
    templateId,
    sourceRole: token(binding.sourceRole, "figure-template-source-role", true),
  };
}

function validatePanels(value: unknown, layout: ScienceFigureLayout, bindings: ScienceFigureDataBinding[]): ScienceFigurePanel[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SCIENCE_FIGURE_MAX_PANELS) throw new Error("science-figure-panels-invalid");
  const bindingMap = new Map(bindings.map((binding) => [binding.id, binding]));
  const panels = value.map((entry) => {
    const panel = record(entry);
    const coreKeys = ["id", "title", "chartFamily", "dataBindingId", "placement", "encoding", "axes", "legend", "colorbar", "annotations", "interaction"];
    if (!panel || !(exactKeys(panel, coreKeys) || exactKeys(panel, [...coreKeys, "templateBinding"]))
      || typeof panel.chartFamily !== "string" || !CHART_FAMILIES.has(panel.chartFamily)) throw new Error("science-figure-panel-invalid");
    const chartFamily = panel.chartFamily as ScienceFigureChartFamily;
    const dataBindingId = token(panel.dataBindingId, "panel-data-binding-id", true);
    const binding = bindingMap.get(dataBindingId);
    if (!binding) throw new Error("science-figure-panel-data-binding-not-found");
    const axes = record(panel.axes);
    if (!axes || !exactKeys(axes, ["x", "y", "z"])) throw new Error("science-figure-panel-axes-invalid");
    const is3d = THREE_DIMENSIONAL_FAMILIES.has(chartFamily);
    const encoding = validateEncoding(panel.encoding, new Set(binding.availableFields));
    const normalizedAxes = { x: validateAxis(axes.x), y: validateAxis(axes.y), z: validateAxis(axes.z) };
    if (!is3d && (encoding.z !== null || normalizedAxes.z !== null) || COORDINATE_3D_FAMILIES.has(chartFamily) && (encoding.x === null || encoding.y === null || encoding.z === null)) {
      throw new Error("science-figure-panel-dimensionality-invalid");
    }
    if (encoding.z !== null && normalizedAxes.z === null) throw new Error("science-figure-panel-z-axis-required");
    const colorbar = validateColorbar(panel.colorbar);
    if (colorbar?.show && encoding.color === null && !["heatmap", "contour", "filled-contour", "surface3d", "volume3d"].includes(chartFamily)) {
      throw new Error("science-figure-colorbar-channel-required");
    }
    return {
      id: token(panel.id, "panel-id", true),
      title: text(panel.title, 500, "panel-title"),
      chartFamily,
      dataBindingId,
      placement: validatePanelPlacement(panel.placement, layout),
      encoding,
      axes: normalizedAxes,
      legend: validateLegend(panel.legend),
      colorbar,
      annotations: validateAnnotations(panel.annotations, is3d),
      interaction: validateInteraction(panel.interaction, is3d),
      ...(panel.templateBinding === undefined ? {} : { templateBinding: validateTemplateBinding(panel.templateBinding) }),
    };
  });
  if (new Set(panels.map((panel) => panel.id)).size !== panels.length) throw new Error("science-figure-panel-duplicate");

  const assertNoOverlap = (placements: Array<{ panelId: string; placement: ScienceFigureGridPlacement }>, layoutId: string) => {
    const occupied = new Map<string, string>();
    for (const item of placements) {
      for (let row = item.placement.row; row < item.placement.row + item.placement.rowSpan; row += 1) {
        for (let column = item.placement.column; column < item.placement.column + item.placement.columnSpan; column += 1) {
          const cell = `${row}:${column}`;
          if (occupied.has(cell)) throw new Error(`science-figure-panel-overlap:${layoutId}`);
          occupied.set(cell, item.panelId);
        }
      }
    }
  };
  assertNoOverlap(panels.map((panel) => ({ panelId: panel.id, placement: panel.placement.base })), "base");
  for (const breakpoint of layout.breakpoints) {
    assertNoOverlap(panels.map((panel) => ({ panelId: panel.id, placement: panel.placement.breakpoints.find((item) => item.breakpointId === breakpoint.id)! })), breakpoint.id);
  }

  const linkGroups = new Map<string, ScienceFigurePanel[]>();
  for (const panel of panels) if (panel.interaction.linkGroup) {
    const group = linkGroups.get(panel.interaction.linkGroup) ?? [];
    group.push(panel); linkGroups.set(panel.interaction.linkGroup, group);
  }
  for (const [groupId, group] of linkGroups) {
    if (group.length < 2 || new Set(group.map((panel) => THREE_DIMENSIONAL_FAMILIES.has(panel.chartFamily))).size !== 1) {
      throw new Error(`science-figure-interaction-link-invalid:${groupId}`);
    }
  }
  return panels;
}

function validatePublicationExport(value: unknown): ScienceFigurePublicationExport {
  const publication = record(value);
  if (!publication || !exactKeys(publication, ["journalName", "columnWidth", "widthMm", "heightMm", "background", "baseFontSizePt", "outputs"])
    || !["single", "one-and-half", "double", "custom"].includes(String(publication.columnWidth))
    || !["white", "transparent"].includes(String(publication.background)) || !Array.isArray(publication.outputs)
    || publication.outputs.length < 1 || publication.outputs.length > 3) throw new Error("science-figure-publication-export-invalid");
  const columnWidth = publication.columnWidth as ScienceFigurePublicationExport["columnWidth"];
  const widthMm = finite(publication.widthMm, 40, 240, "publication-width");
  const ranges: Record<Exclude<ScienceFigurePublicationExport["columnWidth"], "custom">, [number, number]> = {
    single: [80, 95], "one-and-half": [115, 140], double: [160, 190],
  };
  if (columnWidth !== "custom" && (widthMm < ranges[columnWidth][0] || widthMm > ranges[columnWidth][1])) {
    throw new Error("science-figure-journal-column-width-invalid");
  }
  const outputs = publication.outputs.map((entry) => {
    const output = record(entry);
    if (!output || !exactKeys(output, ["format", "dpi", "colorMode"])
      || !["png", "svg", "pdf"].includes(String(output.format)) || !["rgb", "cmyk"].includes(String(output.colorMode))) {
      throw new Error("science-figure-export-output-invalid");
    }
    const format = output.format as ScienceFigureExportOutput["format"];
    const dpi = output.dpi === null ? null : integer(output.dpi, 150, 1_200, "export-dpi");
    if (format === "png" && (dpi === null || output.colorMode !== "rgb") || format !== "png" && dpi !== null || format === "svg" && output.colorMode !== "rgb") {
      throw new Error("science-figure-export-format-invalid");
    }
    return { format, dpi, colorMode: output.colorMode as ScienceFigureExportOutput["colorMode"] };
  });
  if (new Set(outputs.map((output) => output.format)).size !== outputs.length || !outputs.some((output) => output.format === "svg" || output.format === "pdf")) {
    throw new Error("science-figure-publication-output-set-invalid");
  }
  return {
    journalName: nullableText(publication.journalName, 500, "journal-name"),
    columnWidth,
    widthMm,
    heightMm: finite(publication.heightMm, 30, 300, "publication-height"),
    background: publication.background as ScienceFigurePublicationExport["background"],
    baseFontSizePt: finite(publication.baseFontSizePt, 5, 24, "publication-font-size"),
    outputs,
  };
}

function validateAccessibility(value: unknown, panels: ScienceFigurePanel[]): ScienceFigureAccessibility {
  const accessibility = record(value);
  if (!accessibility || !exactKeys(accessibility, ["title", "description", "longDescription", "colorVisionSafe", "readingOrder", "panelAlternatives"])
    || typeof accessibility.colorVisionSafe !== "boolean" || !Array.isArray(accessibility.readingOrder) || !Array.isArray(accessibility.panelAlternatives)) {
    throw new Error("science-figure-accessibility-invalid");
  }
  const panelIds = panels.map((panel) => panel.id);
  const readingOrder = accessibility.readingOrder.map((id) => token(id, "reading-order-panel-id", true));
  const panelAlternatives = accessibility.panelAlternatives.map((entry) => {
    const item = record(entry);
    if (!item || !exactKeys(item, ["panelId", "text"])) throw new Error("science-figure-panel-alternative-invalid");
    return { panelId: token(item.panelId, "alternative-panel-id", true), text: text(item.text, 8_000, "alternative-text") };
  });
  const sortedPanelIds = [...panelIds].sort();
  if (new Set(readingOrder).size !== panelIds.length || [...readingOrder].sort().join("\0") !== sortedPanelIds.join("\0")
    || new Set(panelAlternatives.map((item) => item.panelId)).size !== panelIds.length
    || panelAlternatives.map((item) => item.panelId).sort().join("\0") !== sortedPanelIds.join("\0")) {
    throw new Error("science-figure-accessibility-panel-coverage-invalid");
  }
  return {
    title: text(accessibility.title, 500, "accessibility-title"),
    description: text(accessibility.description, 2_000, "accessibility-description"),
    longDescription: text(accessibility.longDescription, 20_000, "accessibility-long-description"),
    colorVisionSafe: accessibility.colorVisionSafe,
    readingOrder,
    panelAlternatives,
  };
}

function validateProvenance(value: unknown, data: ScienceFigureDataBinding[]): ScienceFigureProvenance {
  const provenance = record(value);
  if (!provenance || !exactKeys(provenance, ["createdAt", "creator", "dataBindingsSha256", "analysisReceiptSha256s", "software", "notes"])
    || !Array.isArray(provenance.analysisReceiptSha256s) || !Array.isArray(provenance.software) || !Array.isArray(provenance.notes)) {
    throw new Error("science-figure-provenance-invalid");
  }
  const creator = record(provenance.creator);
  if (!creator || !exactKeys(creator, ["kind", "id", "version"]) || !["human", "agent", "hybrid"].includes(String(creator.kind))) {
    throw new Error("science-figure-creator-invalid");
  }
  const analysisReceiptSha256s = provenance.analysisReceiptSha256s.map((item) => sha256(item, "provenance-analysis-receipt-sha256"));
  const expectedReceipts = [...new Set(data.map((binding) => binding.analysisReceipt.receiptSha256))].sort();
  if (analysisReceiptSha256s.join("\0") !== expectedReceipts.join("\0")) throw new Error("science-figure-provenance-receipts-stale");
  const software = provenance.software.map((entry) => {
    const item = record(entry);
    if (!item || !exactKeys(item, ["name", "version", "contentSha256"])) throw new Error("science-figure-software-provenance-invalid");
    return { name: text(item.name, 240, "software-name"), version: text(item.version, 80, "software-version"), contentSha256: sha256(item.contentSha256, "software-content-sha256") };
  });
  if (software.length < 1 || software.length > 20 || new Set(software.map((item) => `${item.name}:${item.version}`)).size !== software.length) {
    throw new Error("science-figure-software-provenance-invalid");
  }
  const dataBindingsSha256 = sha256(provenance.dataBindingsSha256, "data-bindings-sha256");
  if (dataBindingsSha256 !== scienceFigureSha256(data)) throw new Error("science-figure-provenance-data-stale");
  const notes = provenance.notes.map((note) => text(note, 2_000, "provenance-note"));
  if (notes.length > 100) throw new Error("science-figure-provenance-notes-invalid");
  return {
    createdAt: isoTimestamp(provenance.createdAt, "provenance-created-at"),
    creator: { kind: creator.kind as ScienceFigureProvenance["creator"]["kind"], id: token(creator.id, "creator-id"), version: text(creator.version, 80, "creator-version") },
    dataBindingsSha256,
    analysisReceiptSha256s,
    software,
    notes,
  };
}

/**
 * Strictly parses and validates a publication Figure Spec. It performs
 * structural, scope, immutable-receipt, responsive-layout, accessibility and
 * self-hash checks, but intentionally does not select a renderer.
 */
export function validateScienceFigureSpec(value: unknown): ScienceFigureSpec {
  assertSafeJsonTree(value);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024) throw new Error("science-figure-spec-size-limit-exceeded");
  const spec = record(value);
  if (!spec || !exactKeys(spec, [
    "schema", "figureId", "version", "title", "caption", "data", "layout", "panels", "export", "accessibility", "provenance", "specSha256",
  ]) || spec.schema !== SCIENCE_FIGURE_SPEC_SCHEMA) throw new Error("science-figure-spec-invalid");
  const data = validateDataBindings(spec.data);
  const layout = validateLayout(spec.layout);
  const panels = validatePanels(spec.panels, layout, data);
  const core = {
    schema: SCIENCE_FIGURE_SPEC_SCHEMA,
    figureId: uuid(spec.figureId, "figure-id"),
    version: integer(spec.version, 1, Number.MAX_SAFE_INTEGER, "version"),
    title: text(spec.title, 1_000, "title"),
    caption: text(spec.caption, 20_000, "caption"),
    data,
    layout,
    panels,
    export: validatePublicationExport(spec.export),
    accessibility: validateAccessibility(spec.accessibility, panels),
    provenance: validateProvenance(spec.provenance, data),
  };
  const specSha256 = sha256(spec.specSha256, "spec-sha256");
  if (scienceFigureSha256(core) !== specSha256) throw new Error("science-figure-spec-hash-invalid");
  return { ...core, specSha256 };
}

export const parseScienceFigureSpec = validateScienceFigureSpec;
