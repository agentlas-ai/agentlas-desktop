import { INTELLECT_UI_LIMITS, validateIntellectUiDocument, type IntellectUiDocument } from "./intellect-ui";
import { sanitizeChartSpec } from "./chart-spec";

/** Typed chat views use the same bounded validators as answer blocks. HTML runs only in the visual sandbox. */
export type InlineUiPresentationContent =
  | { kind: "native"; document: IntellectUiDocument }
  | { kind: "visual"; html: string }
  | { kind: "chart"; spec: Record<string, unknown> };

export const INLINE_VISUAL_HTML_MAX_BYTES = 512 * 1024;
export type InlineVisualHtmlRejectCode = "empty" | "too-large" | "meta-refresh" | "base-tag";
export function screenInlineVisualHtml(html: string): { ok: true } | { ok: false; code: InlineVisualHtmlRejectCode } {
  if (!html.trim()) return { ok: false, code: "empty" };
  if (new TextEncoder().encode(html).byteLength > INLINE_VISUAL_HTML_MAX_BYTES) return { ok: false, code: "too-large" };
  if (/<meta[^>]+http-equiv\s*=\s*["']?\s*refresh/i.test(html)) return { ok: false, code: "meta-refresh" };
  if (/<base[\s>]/i.test(html)) return { ok: false, code: "base-tag" };
  return { ok: true };
}

export type InlineUiContentValidation =
  | { ok: true; content: InlineUiPresentationContent }
  | { ok: false; reason: string };

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonData(value: unknown, ancestors = new Set<object>(), depth = 0, budget = { nodes: 0 }): boolean {
  if (++budget.nodes > 50_000 || depth > 48) return false;
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || (!Array.isArray(value) && !plainObject(value)) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.values(value).every(child => jsonData(child, ancestors, depth + 1, budget));
  ancestors.delete(value);
  return valid;
}

export function validateInlineUiPresentationContent(value: unknown): InlineUiContentValidation {
  try {
    if (!plainObject(value) || !jsonData(value)) return { ok: false, reason: "ui_content_invalid" };
    const field = value.kind === "native" ? "document" : value.kind === "visual" ? "html" : value.kind === "chart" ? "spec" : null;
    if (!field || Object.keys(value).some(key => key !== "kind" && key !== field)) return { ok: false, reason: "ui_content_invalid" };
    if (value.kind === "native") {
      const serialized = JSON.stringify(value.document);
      if (typeof serialized !== "string" || serialized.length > INTELLECT_UI_LIMITS.sourceChars) return { ok: false, reason: "ui_content_too_large" };
      const checked = validateIntellectUiDocument(value.document);
      return checked.document && !checked.errors.length
        ? { ok: true, content: { kind: "native", document: checked.document } }
        : { ok: false, reason: `ui_native_${checked.errors[0]?.code ?? "invalid_document"}` };
    }
    if (value.kind === "visual") {
      if (typeof value.html !== "string") return { ok: false, reason: "ui_visual_invalid" };
      const checked = screenInlineVisualHtml(value.html);
      return checked.ok ? { ok: true, content: { kind: "visual", html: value.html } } : { ok: false, reason: `ui_visual_${checked.code}` };
    }
    const checked = sanitizeChartSpec(value.spec);
    return checked.ok ? { ok: true, content: { kind: "chart", spec: checked.spec } } : { ok: false, reason: `ui_chart_${checked.code}` };
  } catch { return { ok: false, reason: "ui_content_invalid" }; }
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (maxLength = 160) => ({ type: "string", maxLength });
const number = { type: "number", minimum: -INTELLECT_UI_LIMITS.magnitude, maximum: INTELLECT_UI_LIMITS.magnitude };
const id = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" };
const expression = { $ref: "#/$defs/expression" };
const children = { type: "array", maxItems: INTELLECT_UI_LIMITS.nodes, items: { $ref: "#/$defs/node" } };
const node = (type: string, properties: Record<string, unknown>, required: string[] = []) => object({ type: { const: type }, id, ...properties }, ["type", ...required]);
const scalar = { type: ["string", "number", "boolean", "null"] };
const nodeSchema = { oneOf: [
  ...["container", "card"].map(type => node(type, { title: string(), layout: { enum: ["vertical", "horizontal", "grid"] }, children }, ["children"])),
  node("text", { text: string(4000), tone: { enum: ["default", "muted", "success", "warning"] } }, ["text"]),
  { ...node("metric", { label: string(), value: { anyOf: [string(240), number] }, expression, unit: string(), description: string(4000) }, ["label"]), anyOf: [{ required: ["value"] }, { required: ["expression"] }] },
  node("calculator", { label: string(), expression, precision: { type: "integer", minimum: 0, maximum: 8 }, unit: string() }, ["label", "expression"]),
  node("table", { title: string(), columns: { type: "array", minItems: 1, maxItems: 12, items: string() }, rows: { type: "array", maxItems: 100, items: { type: "array", maxItems: 12, items: scalar } } }, ["columns", "rows"]),
  node("chart", { title: string(), chartType: { enum: ["bar", "line"] }, labels: { type: "array", minItems: 1, maxItems: 100, items: string() }, series: { type: "array", minItems: 1, maxItems: 6, items: object({ name: string(), values: { type: "array", maxItems: 100, items: number } }, ["name", "values"]) }, yLabel: string() }, ["chartType", "labels", "series"]),
  node("diagram", { title: string(), nodes: { type: "array", minItems: 1, maxItems: 32, items: object({ id, label: string() }, ["id", "label"]) }, edges: { type: "array", maxItems: 64, items: object({ from: id, to: id, label: string(), bidirectional: { type: "boolean" } }, ["from", "to"]) }, layout: { enum: ["horizontal", "vertical"] } }, ["nodes", "edges"]),
  node("input", { label: string(), inputType: { enum: ["number", "text"] }, value: { anyOf: [string(240), number] }, min: number, max: number, step: number }, ["id", "label"]),
  node("select", { label: string(), options: { type: "array", minItems: 1, maxItems: 32, items: object({ label: string(), value: string(240) }, ["label", "value"]) }, value: string(240) }, ["id", "label", "options"]),
  node("slider", { label: string(), min: number, max: number, step: number, value: number }, ["id", "label", "min", "max"]),
  node("button", { label: string(), action: object({ type: { const: "followup" }, prompt: string(4000), includeInputs: { type: "array", maxItems: 128, items: id } }, ["type", "prompt"]) }, ["label", "action"]),
] };

/** One schema is shared by canonical tools and the existing host gateway; conditional ownership lives in the host. */
export const UI_PRESENT_INPUT_SCHEMA: Record<string, unknown> = {
  ...object({
    content: { oneOf: [
      object({ kind: { const: "native" }, document: object({ version: { const: 1 }, id, title: string(), children }, ["version", "children"]) }, ["kind", "document"]),
      object({ kind: { const: "visual" }, html: string(INLINE_VISUAL_HTML_MAX_BYTES) }, ["kind", "html"]),
      object({ kind: { const: "chart" }, spec: { type: "object", additionalProperties: true } }, ["kind", "spec"]),
    ] },
    commandId: string(500), callId: string(500), resultRef: string(500), viewId: string(500),
    chatId: string(500), turnId: string(500), title: string(), fallbackText: string(4000),
    resourceRef: string(500), structuredResultRef: string(500), artifactRefs: { type: "array", maxItems: 128, items: string(500) },
    display: { enum: ["inline", "fullscreen", "pip"] }, reason: { enum: ["result", "decision", "required-input", "meaningful-progress"] },
    state: { enum: ["running", "ready", "awaiting-input", "failed", "cancelled"] },
  }),
  anyOf: [{ required: ["content"] }, { required: ["callId", "resultRef", "viewId"] }],
  $defs: {
    node: nodeSchema,
    expression: { oneOf: [number, object({ input: id }, ["input"]), object({ op: { enum: ["add", "sub", "mul", "div", "pow", "min", "max", "abs", "round"] }, args: { type: "array", minItems: 1, maxItems: 8, items: expression } }, ["op", "args"])] },
  },
};
