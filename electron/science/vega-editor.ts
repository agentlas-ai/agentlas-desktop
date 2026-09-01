import type {
  AppendScienceArtifactVersionInput,
  AppendScienceArtifactVersionResult,
  ScienceArtifact,
  ScienceArtifactContext,
  ScienceArtifactSemanticSnapshot,
} from "../../shared/science-contract";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const TOKEN_RE = /^[a-z][a-z0-9-]{0,63}$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const UNSAFE_TEXT_RE = /(?:\b(?:https?|wss?|ftp|file):\/\/|\bjavascript:|\bdata:text\/html|<script\b|\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|=>)/iu;
const EXECUTABLE_KEYS = new Set(["url", "uri", "href", "src", "signal", "signals", "expr", "expression", "on", "test", "transform", "javascript", "script"]);
const REFERENCE_MARK_PREFIX = "agentlas-reference-";

export const SCIENCE_VEGA_EDIT_SCHEMA = "agentlas.science-vega-edit/v1" as const;
export const SCIENCE_VEGA_SEMANTIC_EDIT_SCHEMA = "agentlas.science-vega-semantic-edit/v2" as const;
export const SCIENCE_VEGA_EDITOR_CAPABILITY_SCHEMA = "agentlas.science-vega-editor-capability/v2" as const;
export const SCIENCE_VEGA_MARKS = ["bar", "line", "point"] as const;
export const SCIENCE_VEGA_COLORS = ["#3867d6", "#0b7285", "#7b61a8", "#c75d2c", "#2f7d4a"] as const;
export const SCIENCE_VEGA_PALETTES = ["agentlas", "colorblind", "viridis", "cividis", "magma"] as const;

const PALETTE_COLORS = Object.freeze({
  agentlas: ["#3867d6", "#0b7285", "#7b61a8", "#c75d2c", "#2f7d4a"],
  colorblind: ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#f0e442"],
  viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  cividis: ["#00204c", "#414d6b", "#7d7c78", "#bcae6c", "#ffea46"],
  magma: ["#000004", "#51127c", "#b73779", "#fc8961", "#fcfdbf"],
} satisfies Record<string, readonly string[]>);

export type ScienceVegaMark = typeof SCIENCE_VEGA_MARKS[number];
export type ScienceVegaColor = typeof SCIENCE_VEGA_COLORS[number];
export type ScienceVegaPalette = typeof SCIENCE_VEGA_PALETTES[number];
export type ScienceVegaAxisName = "x" | "y";

export interface ScienceVegaLegacyEditInput {
  schema: typeof SCIENCE_VEGA_EDIT_SCHEMA;
  requestId: string;
  projectId: string;
  artifactId: string;
  expectedArtifactVersion: number;
  expectedContentSha256: string;
  title: string;
  mark: ScienceVegaMark;
  color: ScienceVegaColor;
  actionContext?: { conversationId: string; originMessageId: string; turnId: string };
}

export type ScienceVegaSemanticPatch =
  | { op: "title"; value: string }
  | { op: "axis"; axis: ScienceVegaAxisName; title?: string; unit?: string | null; scale?: "linear" | "log"; domain?: [number, number]; tickCount?: number; grid?: boolean }
  | { op: "palette"; value: ScienceVegaPalette }
  | { op: "legend"; title?: string | null; orient?: "left" | "right" | "top" | "bottom"; direction?: "horizontal" | "vertical" }
  | { op: "style"; baseFontSizePt?: number; lineWidth?: number; pointSize?: number }
  | { op: "upsert-reference-line"; id: string; axis: ScienceVegaAxisName; value: number; label?: string | null; color?: string; lineWidth?: number; lineStyle?: "solid" | "dashed" | "dotted" }
  | { op: "remove-reference-line"; id: string };

export interface ScienceVegaSemanticEditInput {
  schema: typeof SCIENCE_VEGA_SEMANTIC_EDIT_SCHEMA;
  requestId: string;
  projectId: string;
  artifactId: string;
  expectedArtifactVersion: number;
  expectedContentSha256: string;
  patches: ScienceVegaSemanticPatch[];
  actionContext?: { conversationId: string; originMessageId: string; turnId: string };
}

export type ScienceVegaEditInput = ScienceVegaLegacyEditInput | ScienceVegaSemanticEditInput;

export interface ScienceVegaEditorCapability {
  schema: typeof SCIENCE_VEGA_EDITOR_CAPABILITY_SCHEMA;
  editable: boolean;
  mode: "legacy-single-mark" | "semantic" | "explore-only";
  reason: "editable" | "statistics-figure-immutable-original" | "unsupported-renderer" | "unsafe-or-unsupported-spec";
  layered: boolean;
  statisticsFigure: boolean;
  markCount: number;
  axes: { x: boolean; y: boolean };
  palette: boolean;
  legend: boolean;
  lineStyle: boolean;
  pointStyle: boolean;
  referenceLines: boolean;
  legacyMarkReplacement: boolean;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as JsonRecord : null;
}

function exactKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function safeText(value: unknown, maximum: number, error: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value) || UNSAFE_TEXT_RE.test(value)) throw new Error(error);
  return value.trim();
}

function finite(value: unknown, minimum: number, maximum: number, error: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(error);
  return Object.is(value, -0) ? 0 : value;
}

function parseActionContext(value: unknown): ScienceVegaEditInput["actionContext"] {
  if (value === undefined) return undefined;
  const context = record(value);
  if (!context || !exactKeys(context, ["conversationId", "originMessageId", "turnId"])
    || typeof context.conversationId !== "string" || !UUID_RE.test(context.conversationId)
    || typeof context.originMessageId !== "string" || !UUID_RE.test(context.originMessageId)
    || typeof context.turnId !== "string" || !UUID_RE.test(context.turnId)) throw new Error("science-vega-edit-action-context-invalid");
  return { conversationId: context.conversationId, originMessageId: context.originMessageId, turnId: context.turnId };
}

function parseCommon(input: JsonRecord) {
  if (typeof input.requestId !== "string" || !UUID_RE.test(input.requestId)
    || typeof input.projectId !== "string" || !UUID_RE.test(input.projectId)
    || typeof input.artifactId !== "string" || !UUID_RE.test(input.artifactId)) throw new Error("science-vega-edit-id-invalid");
  if (!Number.isSafeInteger(input.expectedArtifactVersion) || Number(input.expectedArtifactVersion) < 1) throw new Error("science-vega-edit-version-invalid");
  if (typeof input.expectedContentSha256 !== "string" || !SHA256_RE.test(input.expectedContentSha256)) throw new Error("science-vega-edit-content-invalid");
  return {
    requestId: input.requestId, projectId: input.projectId, artifactId: input.artifactId,
    expectedArtifactVersion: Number(input.expectedArtifactVersion), expectedContentSha256: input.expectedContentSha256.toLowerCase(),
    ...(input.actionContext === undefined ? {} : { actionContext: parseActionContext(input.actionContext) }),
  };
}

function parseAxisPatch(item: JsonRecord): ScienceVegaSemanticPatch {
  if (!exactKeys(item, ["op", "axis", "title", "unit", "scale", "domain", "tickCount", "grid"]) || !["x", "y"].includes(String(item.axis))) throw new Error("science-vega-semantic-axis-invalid");
  const present = (key: string) => Object.hasOwn(item, key);
  if (!["title", "unit", "scale", "domain", "tickCount", "grid"].some(present)) throw new Error("science-vega-semantic-axis-empty");
  if (present("unit") && !present("title")) throw new Error("science-vega-semantic-axis-unit-requires-title");
  const patch: Extract<ScienceVegaSemanticPatch, { op: "axis" }> = { op: "axis", axis: item.axis as ScienceVegaAxisName };
  if (present("title")) patch.title = safeText(item.title, 240, "science-vega-semantic-axis-title-invalid") as string;
  if (present("unit")) patch.unit = safeText(item.unit, 120, "science-vega-semantic-axis-unit-invalid", true);
  if (present("scale")) {
    if (item.scale !== "linear" && item.scale !== "log") throw new Error("science-vega-semantic-axis-scale-invalid");
    patch.scale = item.scale;
  }
  if (present("domain")) {
    if (!Array.isArray(item.domain) || item.domain.length !== 2) throw new Error("science-vega-semantic-axis-domain-invalid");
    const minimum = finite(item.domain[0], -Number.MAX_VALUE, Number.MAX_VALUE, "science-vega-semantic-axis-domain-invalid");
    const maximum = finite(item.domain[1], -Number.MAX_VALUE, Number.MAX_VALUE, "science-vega-semantic-axis-domain-invalid");
    if (minimum >= maximum) throw new Error("science-vega-semantic-axis-domain-invalid");
    patch.domain = [minimum, maximum];
  }
  if (present("tickCount")) {
    if (!Number.isSafeInteger(item.tickCount) || Number(item.tickCount) < 2 || Number(item.tickCount) > 50) throw new Error("science-vega-semantic-axis-ticks-invalid");
    patch.tickCount = Number(item.tickCount);
  }
  if (present("grid")) {
    if (typeof item.grid !== "boolean") throw new Error("science-vega-semantic-axis-grid-invalid");
    patch.grid = item.grid;
  }
  if (patch.scale === "log" && patch.domain && patch.domain[0] <= 0) throw new Error("science-vega-semantic-log-domain-invalid");
  return patch;
}

function parsePatch(value: unknown): ScienceVegaSemanticPatch {
  const item = record(value);
  if (!item || typeof item.op !== "string") throw new Error("science-vega-semantic-patch-invalid");
  if (item.op === "title") {
    if (!exactKeys(item, ["op", "value"])) throw new Error("science-vega-semantic-title-invalid");
    return { op: "title", value: safeText(item.value, 240, "science-vega-semantic-title-invalid") as string };
  }
  if (item.op === "axis") return parseAxisPatch(item);
  if (item.op === "palette") {
    if (!exactKeys(item, ["op", "value"]) || !SCIENCE_VEGA_PALETTES.includes(item.value as ScienceVegaPalette)) throw new Error("science-vega-semantic-palette-invalid");
    return { op: "palette", value: item.value as ScienceVegaPalette };
  }
  if (item.op === "legend") {
    if (!exactKeys(item, ["op", "title", "orient", "direction"])) throw new Error("science-vega-semantic-legend-invalid");
    const patch: Extract<ScienceVegaSemanticPatch, { op: "legend" }> = { op: "legend" };
    if (Object.hasOwn(item, "title")) patch.title = safeText(item.title, 240, "science-vega-semantic-legend-title-invalid", true);
    if (Object.hasOwn(item, "orient")) {
      if (!["left", "right", "top", "bottom"].includes(String(item.orient))) throw new Error("science-vega-semantic-legend-orient-invalid");
      patch.orient = item.orient as "left" | "right" | "top" | "bottom";
    }
    if (Object.hasOwn(item, "direction")) {
      if (item.direction !== "horizontal" && item.direction !== "vertical") throw new Error("science-vega-semantic-legend-direction-invalid");
      patch.direction = item.direction;
    }
    if (Object.keys(patch).length === 1) throw new Error("science-vega-semantic-legend-empty");
    return patch;
  }
  if (item.op === "style") {
    if (!exactKeys(item, ["op", "baseFontSizePt", "lineWidth", "pointSize"])) throw new Error("science-vega-semantic-style-invalid");
    const patch: Extract<ScienceVegaSemanticPatch, { op: "style" }> = { op: "style" };
    if (Object.hasOwn(item, "baseFontSizePt")) patch.baseFontSizePt = finite(item.baseFontSizePt, 5, 24, "science-vega-semantic-font-size-invalid");
    if (Object.hasOwn(item, "lineWidth")) patch.lineWidth = finite(item.lineWidth, 0.5, 12, "science-vega-semantic-line-width-invalid");
    if (Object.hasOwn(item, "pointSize")) patch.pointSize = finite(item.pointSize, 16, 1600, "science-vega-semantic-point-size-invalid");
    if (Object.keys(patch).length === 1) throw new Error("science-vega-semantic-style-empty");
    return patch;
  }
  if (item.op === "upsert-reference-line") {
    if (!exactKeys(item, ["op", "id", "axis", "value", "label", "color", "lineWidth", "lineStyle"])
      || typeof item.id !== "string" || !TOKEN_RE.test(item.id) || !["x", "y"].includes(String(item.axis))) throw new Error("science-vega-semantic-reference-line-invalid");
    const patch: Extract<ScienceVegaSemanticPatch, { op: "upsert-reference-line" }> = { op: "upsert-reference-line", id: item.id, axis: item.axis as ScienceVegaAxisName, value: finite(item.value, -Number.MAX_VALUE, Number.MAX_VALUE, "science-vega-semantic-reference-value-invalid") };
    if (Object.hasOwn(item, "label")) patch.label = safeText(item.label, 240, "science-vega-semantic-reference-label-invalid", true);
    if (Object.hasOwn(item, "color")) {
      if (typeof item.color !== "string" || !HEX_COLOR_RE.test(item.color)) throw new Error("science-vega-semantic-reference-color-invalid");
      patch.color = item.color.toLowerCase();
    }
    if (Object.hasOwn(item, "lineWidth")) patch.lineWidth = finite(item.lineWidth, 0.5, 12, "science-vega-semantic-reference-width-invalid");
    if (Object.hasOwn(item, "lineStyle")) {
      if (!["solid", "dashed", "dotted"].includes(String(item.lineStyle))) throw new Error("science-vega-semantic-reference-style-invalid");
      patch.lineStyle = item.lineStyle as "solid" | "dashed" | "dotted";
    }
    return patch;
  }
  if (item.op === "remove-reference-line") {
    if (!exactKeys(item, ["op", "id"]) || typeof item.id !== "string" || !TOKEN_RE.test(item.id)) throw new Error("science-vega-semantic-reference-line-invalid");
    return { op: "remove-reference-line", id: item.id };
  }
  throw new Error("science-vega-semantic-patch-invalid");
}

export function parseScienceVegaEditInput(value: unknown): ScienceVegaEditInput {
  const input = record(value);
  if (!input) throw new Error("science-vega-edit-input-invalid");
  const common = ["schema", "requestId", "projectId", "artifactId", "expectedArtifactVersion", "expectedContentSha256", "actionContext"];
  if (input.schema === SCIENCE_VEGA_EDIT_SCHEMA) {
    if (!exactKeys(input, [...common, "title", "mark", "color"])) throw new Error("science-vega-edit-input-invalid");
    const title = safeText(input.title, 240, "science-vega-edit-title-invalid") as string;
    if (!SCIENCE_VEGA_MARKS.includes(input.mark as ScienceVegaMark)) throw new Error("science-vega-edit-mark-invalid");
    if (!SCIENCE_VEGA_COLORS.includes(input.color as ScienceVegaColor)) throw new Error("science-vega-edit-color-invalid");
    return { schema: SCIENCE_VEGA_EDIT_SCHEMA, ...parseCommon(input), title, mark: input.mark as ScienceVegaMark, color: input.color as ScienceVegaColor };
  }
  if (input.schema === SCIENCE_VEGA_SEMANTIC_EDIT_SCHEMA) {
    if (!exactKeys(input, [...common, "patches"]) || !Array.isArray(input.patches) || input.patches.length < 1 || input.patches.length > 24) throw new Error("science-vega-semantic-input-invalid");
    const patches = input.patches.map(parsePatch);
    const targets = new Set<string>();
    for (const patch of patches) {
      const target = patch.op === "axis" ? `axis:${patch.axis}`
        : patch.op === "upsert-reference-line" || patch.op === "remove-reference-line" ? `reference:${patch.id}` : patch.op;
      if (targets.has(target)) throw new Error("science-vega-semantic-target-duplicate");
      targets.add(target);
    }
    return { schema: SCIENCE_VEGA_SEMANTIC_EDIT_SCHEMA, ...parseCommon(input), patches };
  }
  throw new Error("science-vega-edit-input-invalid");
}

function validateGenericVegaSpec(value: unknown): JsonRecord {
  const spec = record(value);
  if (!spec) throw new Error("science-vega-edit-unsupported-spec");
  if (Buffer.byteLength(JSON.stringify(spec), "utf8") > 3 * 1024 * 1024) throw new Error("science-vega-edit-spec-too-large");
  let nodes = 0;
  const visit = (entry: unknown, key: string, depth: number): void => {
    if (++nodes > 100_000 || depth > 40) throw new Error("science-vega-edit-spec-too-complex");
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error("science-vega-edit-spec-invalid");
      return;
    }
    if (typeof entry === "string") {
      const officialSchema = key === "$schema" && /^https:\/\/vega\.github\.io\/schema\/vega\/v[56]\.json$/u.test(entry);
      if (!officialSchema && UNSAFE_TEXT_RE.test(entry)) throw new Error("science-vega-edit-spec-remote-or-executable");
      return;
    }
    if (Array.isArray(entry)) { entry.forEach((child) => visit(child, key, depth + 1)); return; }
    const item = record(entry);
    if (!item) throw new Error("science-vega-edit-spec-invalid");
    for (const [childKey, child] of Object.entries(item)) {
      const normalized = childKey.toLowerCase();
      if (EXECUTABLE_KEYS.has(normalized) || ["__proto__", "prototype", "constructor"].includes(normalized) || /^on[a-z]/u.test(normalized)) throw new Error("science-vega-edit-spec-executable");
      visit(child, childKey, depth + 1);
    }
  };
  visit(spec, "", 0);
  if (spec.data !== undefined && (!Array.isArray(spec.data) || spec.data.some((entry) => !record(entry) || !Array.isArray(record(entry)?.values)))) throw new Error("science-vega-edit-inline-data-required");
  if (!Array.isArray(spec.scales) || !Array.isArray(spec.axes) || !Array.isArray(spec.marks) || spec.marks.length < 1) throw new Error("science-vega-edit-unsupported-spec");
  return spec;
}

function marks(spec: JsonRecord): JsonRecord[] {
  return (Array.isArray(spec.marks) ? spec.marks : []).map(record).filter((item): item is JsonRecord => item !== null);
}

function layered(spec: JsonRecord): boolean {
  const entries = marks(spec);
  return entries.length > 1 || entries.some((mark) => Array.isArray(mark.marks));
}

function scaleFor(spec: JsonRecord, axis: ScienceVegaAxisName): JsonRecord | null {
  return record((Array.isArray(spec.scales) ? spec.scales : []).find((entry) => record(entry)?.name === axis));
}

function axesFor(spec: JsonRecord, axis: ScienceVegaAxisName): JsonRecord[] {
  return (Array.isArray(spec.axes) ? spec.axes : []).map(record).filter((entry): entry is JsonRecord => entry?.scale === axis);
}

function encodeBlocks(mark: JsonRecord): JsonRecord[] {
  const encode = record(mark.encode);
  return [record(encode?.enter), record(encode?.update)].filter((entry): entry is JsonRecord => entry !== null);
}

function colorScaleNames(spec: JsonRecord): Set<string> {
  const names = new Set<string>();
  for (const mark of marks(spec)) for (const encode of encodeBlocks(mark)) for (const channel of ["fill", "stroke"]) {
    const value = record(encode[channel]);
    if (typeof value?.scale === "string") names.add(value.scale);
  }
  return names;
}

function continuous(scale: JsonRecord | null): boolean {
  return Boolean(scale) && [undefined, "linear", "log", "pow", "sqrt", "symlog"].includes(scale?.type as string | undefined);
}

export function scienceVegaSemanticEditorState(artifact: ScienceArtifact): ScienceVegaEditorCapability {
  const statisticsFigure = artifact.version.payload.schema === "agentlas.science.statistics-figure-artifact/v1";
  const base = { schema: SCIENCE_VEGA_EDITOR_CAPABILITY_SCHEMA, statisticsFigure, axes: { x: false, y: false }, palette: false, legend: false, lineStyle: false, pointStyle: false, referenceLines: false, legacyMarkReplacement: false } as const;
  if (artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega") return { ...base, editable: false, mode: "explore-only", reason: "unsupported-renderer", layered: false, markCount: 0 };
  if (statisticsFigure) {
    const spec = record(artifact.version.payload.spec);
    const markCount = Array.isArray(spec?.marks) ? spec.marks.length : 0;
    return { ...base, editable: false, mode: "explore-only", reason: "statistics-figure-immutable-original", layered: markCount > 1, markCount };
  }
  try {
    const spec = validateGenericVegaSpec(artifact.version.payload.spec);
    const markEntries = marks(spec);
    const isLayered = layered(spec);
    return {
      ...base, editable: true, mode: isLayered ? "semantic" : "legacy-single-mark", reason: "editable", layered: isLayered, markCount: markEntries.length,
      axes: { x: Boolean(scaleFor(spec, "x") && axesFor(spec, "x").length), y: Boolean(scaleFor(spec, "y") && axesFor(spec, "y").length) },
      palette: colorScaleNames(spec).size > 0 || !isLayered,
      legend: Array.isArray(spec.legends) && spec.legends.length > 0,
      lineStyle: markEntries.some((mark) => mark.type === "line"), pointStyle: markEntries.some((mark) => mark.type === "symbol"),
      referenceLines: continuous(scaleFor(spec, "x")) || continuous(scaleFor(spec, "y")), legacyMarkReplacement: !isLayered && markEntries.length === 1,
    };
  } catch {
    return { ...base, editable: false, mode: "explore-only", reason: "unsafe-or-unsupported-spec", layered: false, markCount: 0 };
  }
}

export function scienceVegaEditorState(artifact: ScienceArtifact): { title: string; mark: ScienceVegaMark; color: ScienceVegaColor } | null {
  if (!scienceVegaSemanticEditorState(artifact).legacyMarkReplacement) return null;
  const spec = record(artifact.version.payload.spec);
  const data = Array.isArray(spec?.data) ? spec.data : [];
  const scales = Array.isArray(spec?.scales) ? spec.scales : [];
  const marks = Array.isArray(spec?.marks) ? spec.marks : [];
  const table = record(data.find((entry) => record(entry)?.name === "table"));
  const xScale = record(scales.find((entry) => record(entry)?.name === "x"));
  const yScale = record(scales.find((entry) => record(entry)?.name === "y"));
  const xDomain = record(xScale?.domain);
  const yDomain = record(yScale?.domain);
  const firstMark = record(marks[0]);
  if (!table || !Array.isArray(table.values) || !xScale || !yScale || typeof xDomain?.field !== "string" || typeof yDomain?.field !== "string" || !firstMark) return null;
  const encode = record(firstMark.encode);
  const enter = record(encode?.enter);
  const colorValue = record(enter?.fill)?.value ?? record(enter?.stroke)?.value;
  const color = SCIENCE_VEGA_COLORS.includes(colorValue as ScienceVegaColor) ? colorValue as ScienceVegaColor : SCIENCE_VEGA_COLORS[0];
  const mark = firstMark.type === "line" ? "line" : firstMark.type === "symbol" ? "point" : firstMark.type === "rect" ? "bar" : null;
  if (!mark) return null;
  const titleValue = record(spec?.title)?.text ?? spec?.title;
  return { title: typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : artifact.version.semantic.title, mark, color };
}

function axisFields(spec: JsonRecord, axis: ScienceVegaAxisName): Set<string> {
  const fields = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const item = record(value);
    if (!item) return;
    if (item.scale === axis && typeof item.field === "string") fields.add(item.field);
    Object.values(item).forEach(visit);
  };
  visit(spec.marks);
  return fields;
}

function assertLogSafe(spec: JsonRecord, axis: ScienceVegaAxisName, domain?: [number, number]): void {
  if (domain?.[0] !== undefined && domain[0] <= 0) throw new Error("science-vega-semantic-log-domain-invalid");
  const fields = axisFields(spec, axis);
  let count = 0;
  for (const data of Array.isArray(spec.data) ? spec.data : []) for (const rowValue of Array.isArray(record(data)?.values) ? record(data)!.values as unknown[] : []) {
    const row = record(rowValue);
    if (!row) continue;
    for (const field of fields) if (Object.hasOwn(row, field)) {
      if (typeof row[field] !== "number" || !Number.isFinite(row[field]) || Number(row[field]) <= 0) throw new Error("science-vega-semantic-log-data-invalid");
      count += 1;
    }
  }
  if (!fields.size || !count) throw new Error("science-vega-semantic-log-data-unproven");
}

function applyAxis(spec: JsonRecord, patch: Extract<ScienceVegaSemanticPatch, { op: "axis" }>): void {
  const scale = scaleFor(spec, patch.axis);
  const axisEntries = axesFor(spec, patch.axis);
  if (!scale || !axisEntries.length) throw new Error("science-vega-semantic-axis-not-found");
  const visible = axisEntries.find((axis) => axis.labels !== false && axis.ticks !== false) ?? axisEntries[axisEntries.length - 1]!;
  if (patch.title !== undefined) visible.title = patch.unit ? `${patch.title} (${patch.unit})` : patch.title;
  if (patch.scale !== undefined || patch.domain !== undefined) {
    if (!continuous(scale)) throw new Error("science-vega-semantic-axis-not-continuous");
    if (patch.scale === "log") { assertLogSafe(spec, patch.axis, patch.domain); scale.type = "log"; scale.base = 10; scale.zero = false; }
    if (patch.scale === "linear") { scale.type = "linear"; delete scale.base; }
    if (patch.domain) scale.domain = [...patch.domain];
  }
  if (patch.tickCount !== undefined) visible.tickCount = patch.tickCount;
  if (patch.grid !== undefined) {
    const gridAxes = axisEntries.filter((axis) => axis.labels === false && axis.ticks === false);
    (gridAxes.length ? gridAxes : [visible]).forEach((axis) => { axis.grid = patch.grid; });
  }
}

function applyPalette(spec: JsonRecord, palette: ScienceVegaPalette): void {
  const colors = [...PALETTE_COLORS[palette]];
  const scaleNames = colorScaleNames(spec);
  let changed = 0;
  for (const entry of Array.isArray(spec.scales) ? spec.scales : []) {
    const scale = record(entry);
    if (scale && typeof scale.name === "string" && scaleNames.has(scale.name)) { scale.range = colors; changed += 1; }
  }
  if (changed) return;
  const markEntries = marks(spec);
  if (layered(spec) || markEntries.length !== 1) throw new Error("science-vega-semantic-palette-unproven");
  const mark = markEntries[0]!;
  const blocks = encodeBlocks(mark);
  const channel = mark.type === "line" ? "stroke" : "fill";
  const target = blocks.find((block) => record(block[channel])) ?? blocks[0];
  if (!target) throw new Error("science-vega-semantic-palette-unproven");
  target[channel] = { value: colors[0] };
}

function applyLegend(spec: JsonRecord, patch: Extract<ScienceVegaSemanticPatch, { op: "legend" }>): void {
  if (!Array.isArray(spec.legends) || !spec.legends.length) throw new Error("science-vega-semantic-legend-not-found");
  for (const entry of spec.legends) {
    const legend = record(entry);
    if (!legend) throw new Error("science-vega-semantic-legend-invalid");
    if (patch.title !== undefined) patch.title === null ? delete legend.title : legend.title = patch.title;
    if (patch.orient !== undefined) legend.orient = patch.orient;
    if (patch.direction !== undefined) legend.direction = patch.direction;
  }
}

function setMarkValue(mark: JsonRecord, channel: string, value: number): void {
  const encode = record(mark.encode) ?? (() => { const created: JsonRecord = {}; mark.encode = created; return created; })();
  const block = record(encode.update) ?? record(encode.enter) ?? (() => { const created: JsonRecord = {}; encode.update = created; return created; })();
  block[channel] = { value };
}

function applyStyle(spec: JsonRecord, patch: Extract<ScienceVegaSemanticPatch, { op: "style" }>): void {
  if (patch.baseFontSizePt !== undefined) {
    const px = Math.round(patch.baseFontSizePt * 96 / 72 * 100) / 100;
    const config = record(spec.config) ?? (() => { const value: JsonRecord = {}; spec.config = value; return value; })();
    for (const key of ["axis", "legend"]) {
      const group = record(config[key]) ?? (() => { const value: JsonRecord = {}; config[key] = value; return value; })();
      group.labelFontSize = px; group.titleFontSize = px;
    }
    const title = record(config.title) ?? (() => { const value: JsonRecord = {}; config.title = value; return value; })();
    title.fontSize = px * 1.25;
  }
  if (patch.lineWidth !== undefined) {
    const lines = marks(spec).filter((mark) => mark.type === "line");
    if (!lines.length) throw new Error("science-vega-semantic-line-mark-not-found");
    lines.forEach((mark) => setMarkValue(mark, "strokeWidth", patch.lineWidth!));
  }
  if (patch.pointSize !== undefined) {
    const points = marks(spec).filter((mark) => mark.type === "symbol");
    if (!points.length) throw new Error("science-vega-semantic-point-mark-not-found");
    points.forEach((mark) => setMarkValue(mark, "size", patch.pointSize!));
  }
}

function referenceNames(id: string): [string, string] {
  return [`${REFERENCE_MARK_PREFIX}${id}-rule`, `${REFERENCE_MARK_PREFIX}${id}-label`];
}

function upsertReferenceLine(spec: JsonRecord, patch: Extract<ScienceVegaSemanticPatch, { op: "upsert-reference-line" }>): void {
  const scale = scaleFor(spec, patch.axis);
  if (!continuous(scale)) throw new Error("science-vega-semantic-reference-axis-invalid");
  if (scale?.type === "log" && patch.value <= 0) throw new Error("science-vega-semantic-reference-log-value-invalid");
  if (Array.isArray(scale?.domain) && scale.domain.length === 2 && scale.domain.every((value) => typeof value === "number")
    && (patch.value < Number(scale.domain[0]) || patch.value > Number(scale.domain[1]))) throw new Error("science-vega-semantic-reference-outside-domain");
  const markEntries = Array.isArray(spec.marks) ? spec.marks : [];
  const [ruleName, labelName] = referenceNames(patch.id);
  const retained = markEntries.filter((entry) => ![ruleName, labelName].includes(String(record(entry)?.name ?? "")));
  const position = patch.axis === "x"
    ? { x: { scale: "x", value: patch.value }, y: { value: 0 }, y2: { field: { group: "height" } } }
    : { x: { value: 0 }, x2: { field: { group: "width" } }, y: { scale: "y", value: patch.value } };
  retained.push({ name: ruleName, type: "rule", encode: { update: { ...position, stroke: { value: patch.color ?? "#7a7672" }, strokeWidth: { value: patch.lineWidth ?? 1.5 }, strokeDash: { value: patch.lineStyle === "dotted" ? [2, 3] : patch.lineStyle === "dashed" ? [6, 4] : [] } } } });
  if (patch.label) {
    const labelPosition = patch.axis === "x"
      ? { x: { scale: "x", value: patch.value }, y: { value: 6 }, align: { value: "left" }, baseline: { value: "top" }, dx: { value: 4 } }
      : { x: { field: { group: "width" } }, y: { scale: "y", value: patch.value }, align: { value: "right" }, baseline: { value: "bottom" }, dy: { value: -4 } };
    retained.push({ name: labelName, type: "text", encode: { update: { ...labelPosition, text: { value: patch.label }, fill: { value: patch.color ?? "#7a7672" }, fontSize: { value: 11 } } } });
  }
  spec.marks = retained;
}

function removeReferenceLine(spec: JsonRecord, id: string): void {
  const [ruleName, labelName] = referenceNames(id);
  const current = Array.isArray(spec.marks) ? spec.marks : [];
  const retained = current.filter((entry) => ![ruleName, labelName].includes(String(record(entry)?.name ?? "")));
  if (retained.length === current.length) throw new Error("science-vega-semantic-reference-not-found");
  spec.marks = retained;
}

function markStructure(spec: JsonRecord): string {
  return JSON.stringify(marks(spec).filter((mark) => !String(mark.name ?? "").startsWith(REFERENCE_MARK_PREFIX)).map((mark) => ({ name: mark.name ?? null, type: mark.type ?? null, from: mark.from ?? null })));
}

function applySemanticEdit(artifact: ScienceArtifact, input: ScienceVegaSemanticEditInput) {
  const capability = scienceVegaSemanticEditorState(artifact);
  if (!capability.editable) {
    if (capability.reason === "statistics-figure-immutable-original") throw new Error("science-vega-edit-statistics-figure-immutable");
    throw new Error("science-vega-edit-unsupported-spec");
  }
  const payload = JSON.parse(JSON.stringify(artifact.version.payload)) as JsonRecord;
  const spec = validateGenericVegaSpec(payload.spec);
  const structure = markStructure(spec);
  let title = artifact.version.semantic.title;
  for (const patch of input.patches) {
    if (patch.op === "title") { title = patch.value; spec.title = { text: title, anchor: "middle", fontSize: 16, offset: 12 }; }
    else if (patch.op === "axis") applyAxis(spec, patch);
    else if (patch.op === "palette") applyPalette(spec, patch.value);
    else if (patch.op === "legend") applyLegend(spec, patch);
    else if (patch.op === "style") applyStyle(spec, patch);
    else if (patch.op === "upsert-reference-line") upsertReferenceLine(spec, patch);
    else removeReferenceLine(spec, patch.id);
  }
  if (markStructure(spec) !== structure) throw new Error("science-vega-semantic-mark-structure-changed");
  validateGenericVegaSpec(spec);
  return { payload, semantic: { ...artifact.version.semantic, title, summary: `${title} — bounded semantic Vega edit saved as an immutable Lab version; data bindings and mark-layer structure were preserved.` } };
}

export function applyScienceVegaEdit(artifact: ScienceArtifact, input: ScienceVegaEditInput): {
  payload: Record<string, unknown>;
  semantic: ScienceArtifactSemanticSnapshot;
} {
  if (input.schema === SCIENCE_VEGA_SEMANTIC_EDIT_SCHEMA) return applySemanticEdit(artifact, input);
  const editor = scienceVegaEditorState(artifact);
  if (!editor) {
    const capability = scienceVegaSemanticEditorState(artifact);
    if (capability.statisticsFigure) throw new Error("science-vega-edit-statistics-figure-immutable");
    if (capability.layered) throw new Error("science-vega-edit-layered-mark-replacement-unsafe");
    throw new Error("science-vega-edit-unsupported-spec");
  }
  const payload = JSON.parse(JSON.stringify(artifact.version.payload)) as Record<string, unknown>;
  const spec = validateGenericVegaSpec(payload.spec);
  const scales = Array.isArray(spec?.scales) ? spec.scales : [];
  const xScale = record(scales.find((entry) => record(entry)?.name === "x"));
  const yScale = record(scales.find((entry) => record(entry)?.name === "y"));
  const xField = record(xScale?.domain)?.field;
  const yField = record(yScale?.domain)?.field;
  if (typeof xField !== "string" || typeof yField !== "string") throw new Error("science-vega-edit-unsupported-spec");
  spec.title = { text: input.title, anchor: "middle", fontSize: 16, offset: 12 };
  const position = {
    x: { scale: "x", field: xField, band: 0.5 },
    y: { scale: "y", field: yField },
  };
  if (input.mark === "bar") {
    spec.marks = [{ type: "rect", from: { data: "table" }, encode: { enter: {
      x: { scale: "x", field: xField }, width: { scale: "x", band: 1 }, y: { scale: "y", field: yField }, y2: { scale: "y", value: 0 }, fill: { value: input.color },
    } } }];
  } else if (input.mark === "line") {
    spec.marks = [{ type: "line", from: { data: "table" }, encode: { enter: { ...position, stroke: { value: input.color }, strokeWidth: { value: 2.5 } } } }];
  } else {
    spec.marks = [{ type: "symbol", from: { data: "table" }, encode: { enter: { ...position, fill: { value: input.color }, size: { value: 110 } } } }];
  }
  validateGenericVegaSpec(spec);
  return {
    payload,
    semantic: {
      ...artifact.version.semantic,
      title: input.title,
      summary: `${input.title} — Data Visualization Lab에서 ${input.mark} 표현으로 저장된 검증 가능한 차트 버전입니다.`,
    },
  };
}

export interface ScienceVegaEditStore {
  getArtifactContextForProject(projectId: string, artifactId: string, artifactVersion?: number): ScienceArtifactContext | null;
  appendArtifactVersion(input: AppendScienceArtifactVersionInput): AppendScienceArtifactVersionResult;
}

export function commitScienceVegaEdit(store: ScienceVegaEditStore, input: ScienceVegaEditInput): AppendScienceArtifactVersionResult {
  const base = store.getArtifactContextForProject(input.projectId, input.artifactId, input.expectedArtifactVersion);
  if (!base) throw new Error("science-artifact-not-found");
  if (base.selectedVersion.contentSha256 !== input.expectedContentSha256) throw new Error("science-artifact-version-conflict");
  const baseArtifact: ScienceArtifact = {
    ...base.artifact,
    currentVersion: base.selectedVersion.version,
    version: base.selectedVersion,
  };
  const edit = applyScienceVegaEdit(baseArtifact, input);
  return store.appendArtifactVersion({
    requestId: input.requestId,
    projectId: input.projectId,
    artifactId: input.artifactId,
    expectedArtifactVersion: input.expectedArtifactVersion,
    expectedContentSha256: input.expectedContentSha256,
    payload: edit.payload,
    semantic: edit.semantic,
    provenance: base.selectedVersion.provenance,
    actionContext: input.actionContext,
  });
}
