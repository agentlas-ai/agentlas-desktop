import { z } from "zod";
import { financePresentNumber } from "../finance-present";
import { canvasFigure, type CanvasLine } from "./figures";

/**
 * The result-card canvas (ui.canvas; finance.present is an alias): one card composed from generic blocks. No block belongs to a kind of question
 * or a domain — an earnings summary, an election's market impact, a portfolio review or a dividend plan are all compositions of the same blocks
 * ("no hard-coding by question type";: one tool, domains register only guides and data adapters). The model
 * supplies what it read; series a chart draws are read by the host through the adapter a domain registered (electron/canvas/registry.ts).
 * The same view renders as HTML for the desktop transcript and the phone (render.ts), so both show the same card.
 */

/** Text longer than a block can show is cut with an ellipsis, not refused: the card is never lost for form. */
const text = (max: number) => z.preprocess(value => (typeof value === "number" ? String(value) : value), z.string().transform(value => { const v = value.replace(/\s+/g, " ").trim(); return v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v; }).pipe(z.string().min(1)));
/** A list longer than a block can show keeps its first entries. */
const list = <T extends z.ZodTypeAny>(item: T, min: number, max: number) => z.preprocess(value => (Array.isArray(value) ? value.slice(0, max) : value), z.array(item).min(min));
const optionalText = (max: number) => z.preprocess(value => (value === null || value === "" ? undefined : value), text(max).optional());
const figure = (value: unknown) => { const read = financePresentNumber(value); return typeof read === "number" ? read : canvasFigure(value).value; };
/** An object whose figure fields carry their unit in the text ("26%"): the unit is taken from the first such field unless one was given. */
const withFigureUnit = (fields: string[]) => (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>; let found: string | undefined;
  for (const key of fields) if (typeof v[key] === "string") { const read = canvasFigure(v[key]); found ??= read.unit; }
  return found && (v.unit === undefined || v.unit === null || v.unit === "") ? { ...v, unit: found } : v;
};
const num = z.preprocess(figure, z.number().finite());
/** "Not available" written as a value: the card refuses it (a KPI that holds no figure says nothing). */
const NO_FIGURE = /^(?:n\/?a|na|none|null|unknown|—|–|-|tbd|tba|미정|없음|해당\s*없음)$/i;
/** A KPI's value: a figure (with the unit its marks imply), or a short word the model chose to show ("Raised", "Elevated"),
 *  shown as written with unit "text". A placeholder for a missing value stays text without the unit, so the schema refuses it. */
const kpiValue = (value: unknown) => {
  const v = withFigureUnit(["value", "prior"])(value);
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const item = { ...(v as Record<string, unknown>) };
  if (typeof item.value === "string") {
    const read = figure(item.value);
    if (typeof read === "number") item.value = read;
    else if (!NO_FIGURE.test(item.value.trim()) && item.value.trim().length <= 24) item.unit = "text";
    else item.value = undefined;
  } else if (typeof item.value === "number" && item.unit === "text") item.unit = undefined;
  return item;
};
const optionalNum = z.preprocess(value => (value === null || value === "" ? undefined : figure(value)), z.number().finite().optional());
const lower = <T extends [string, ...string[]]>(values: T) => z.preprocess(value => (typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : value), z.enum(values));
/** A fixed word read the way models write it: other case, a synonym, or (where a sensible default exists) anything else falls back to it. */
const loose = <T extends [string, ...string[]]>(values: T, synonyms: Record<string, T[number]>, fallback?: T[number]) => z.preprocess(value => {
  if (typeof value !== "string") return value;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (values as readonly string[]).includes(key) ? key : synonyms[key] ?? fallback ?? key;
}, z.enum(values));
const date = z.preprocess(value => (typeof value === "string" ? value.trim().slice(0, 10) : value), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))));
const source = z.object({ title: text(160), url: z.string().trim().url().max(2000).refine(value => /^https?:\/\//i.test(value)) }).strip();

export const CANVAS_TONES = ["up", "down", "warn", "info", "neutral"] as const;
export const CANVAS_UNITS = ["usd", "usd_per_share", "percent", "count", "x", "bp", "krw", "eur", "jpy", "gbp", "cny", "text"] as const;
export const CANVAS_WIDTHS = ["full", "two_thirds", "half", "third"] as const;
const tone = loose([...CANVAS_TONES] as [string, ...string[]], { positive: "up", good: "up", green: "up", success: "up", negative: "down", bad: "down", red: "down", danger: "down", warning: "warn", caution: "warn", amber: "warn", blue: "info", note: "info" }, "neutral");
const unit = loose([...CANVAS_UNITS] as [string, ...string[]], { "$": "usd", dollar: "usd", dollars: "usd", usd_m: "usd", usd_mn: "usd", usd_bn: "usd", usd_b: "usd", eps: "usd_per_share", per_share: "usd_per_share", "%": "percent", pct: "percent", pp: "percent", ratio: "x", multiple: "x", times: "x", bps: "bp", basis_points: "bp", won: "krw", "₩": "krw", euro: "eur", yen: "jpy", pound: "gbp", yuan: "cny", number: "count", shares: "count", units: "count", days: "count", years: "count", string: "text" }, "count");
const width = loose([...CANVAS_WIDTHS] as [string, ...string[]], { wide: "full", whole: "full", "100%": "full", "2/3": "two_thirds", twothirds: "two_thirds", "1/2": "half", "50%": "half", "1/3": "third", narrow: "third", one_third: "third" }, "full").optional();
const base = { title: optionalText(80), width };

const kpis = z.object({ type: z.literal("kpis"), ...base, items: list(z.preprocess(kpiValue, z.object({ label: text(40), value: z.union([z.number().finite(), text(24)]), unit: unit.default("usd"), prior: optionalNum, change: optionalNum, note: optionalText(60), tone: tone.optional() }).strip()), 1, 6) }).strip();
const bars = z.object({ type: z.literal("bars"), ...base, unit: unit.default("usd"), series: list(text(30), 0, 2).default([]),
  rows: list(z.object({ label: text(40), values: z.array(num).min(1).max(2), note: optionalText(40) }).strip(), 1, 12) }).strip();
const ranges = z.object({ type: z.literal("ranges"), ...base, unit: unit.default("usd"), change: z.preprocess(value => (value === "" ? null : value), lower(["raised", "maintained", "lowered", "new"]).nullable().optional()),
  items: list(z.object({ label: text(40), low: num, high: num, unit: unit.optional(), marker: optionalNum, markerLabel: optionalText(24) }).strip().transform(v => (v.low > v.high ? { ...v, low: v.high, high: v.low } : v)), 1, 5) }).strip();
const chartSeries = z.object({ assetId: optionalText(200), metric: lower(["price_history", "macro_series", "fx_rates"]).default("price_history"), query: optionalText(80), label: optionalText(40) }).strip()
  .refine(v => (v.metric === "price_history" ? !!v.assetId : !!v.query), "price_history needs assetId; macro_series and fx_rates need query");
const chart = z.object({ type: z.literal("chart"), ...base, series: list(chartSeries, 1, 4), period: z.preprocess(value => (typeof value === "string" ? value.trim().toUpperCase().replace("ALL", "all") : value), z.enum(["1M", "3M", "1Y", "5Y", "all"])).default("1M"),
  mode: lower(["level", "change"]).optional(), from: date.optional(), annotations: list(z.object({ date, label: text(36) }).strip(), 0, 4).default([]) }).strip();
const leans = z.object({ type: z.literal("leans"), ...base, rows: list(z.object({ name: text(48), direction: loose(["supportive", "pressure", "mixed", "unclear", "depends"], { positive: "supportive", bullish: "supportive", up: "supportive", tailwind: "supportive", benefit: "supportive", negative: "pressure", bearish: "pressure", down: "pressure", headwind: "pressure", hurt: "pressure", neutral: "unclear", flat: "unclear", uncertain: "unclear", conditional: "depends" }, "unclear"),
  low: num.transform(v => Math.max(-2, Math.min(2, v))), high: num.transform(v => Math.max(-2, Math.min(2, v))), reason: text(160) }).strip().transform(v => (v.low > v.high ? { ...v, low: v.high, high: v.low } : v)), 1, 10) }).strip();
const cell = z.preprocess(value => (value === undefined ? null : value), z.union([z.number().finite(), z.string().transform(v => (v.length > 80 ? `${v.slice(0, 79)}…` : v)), z.null()]));
const table = z.object({ type: z.literal("table"), ...base, columns: list(z.object({ label: text(30), format: loose(["text", "number", "usd", "percent", "change", "multiple"], { string: "text", currency: "usd", dollar: "usd", "%": "percent", pct: "percent", delta: "change", return: "change", x: "multiple", ratio: "multiple", count: "number", integer: "number" }, "text").default("text") }).strip(), 1, 8),
  rows: list(z.array(cell).min(1).max(8), 1, 20) }).strip();
/** Rows written as objects ({ label, values }) are the same table: labels become rows, their values the matrix. */
const heatmapRows = (value: unknown) => {
  if (!value || typeof value !== "object" || !Array.isArray((value as { rows?: unknown }).rows)) return value;
  const v = value as Record<string, unknown> & { rows: unknown[] };
  if (!v.rows.some(row => row && typeof row === "object" && !Array.isArray(row))) return v;
  const label = (row: unknown) => (row && typeof row === "object" ? String((row as Record<string, unknown>).label ?? (row as Record<string, unknown>).name ?? (row as Record<string, unknown>).row ?? "") : String(row));
  const values = v.values ?? v.rows.map(row => (row && typeof row === "object" ? (row as Record<string, unknown>).values ?? (row as Record<string, unknown>).cells ?? [] : []));
  return { ...v, rows: v.rows.map(label), values };
};
const heatmap = z.preprocess(heatmapRows, z.object({ type: z.literal("heatmap"), ...base, rows: list(text(30), 1, 12), columns: list(text(16), 1, 12),
  values: list(z.array(z.preprocess(value => (value === "" || value === undefined ? null : figure(value)), z.number().finite().nullable())), 1, 12), format: loose(["percent", "change", "number", "correlation"], { "%": "percent", pct: "percent", corr: "correlation", delta: "change", return: "change", score: "number", value: "number" }, "number").default("change") }).strip());
const allocation = z.object({ type: z.literal("allocation"), ...base, items: list(z.object({ label: text(30), weight: num, target: optionalNum, note: optionalText(30) }).strip(), 1, 12) }).strip();
const timeline = z.object({ type: z.literal("timeline"), ...base, items: list(z.object({ date, label: text(48), detail: optionalText(120), tone: tone.optional() }).strip(), 1, 10) }).strip();
const checklist = z.object({ type: z.literal("checklist"), ...base, items: list(z.object({ text: text(90), state: loose(["pass", "fail", "watch", "unknown"], { true: "pass", yes: "pass", ok: "pass", confirmed: "pass", met: "pass", false: "fail", no: "fail", refuted: "fail", missed: "fail", partial: "watch", mixed: "watch", pending: "watch", unverified: "unknown", unclear: "unknown" }, "unknown"), detail: optionalText(140) }).strip(), 1, 10) }).strip();
const gauge = z.preprocess(withFigureUnit(["value"]), z.object({ type: z.literal("gauge"), ...base, label: text(40), value: num, min: num, max: num, unit: unit.optional(), low: optionalText(20), high: optionalText(20), note: optionalText(120) }).strip()
  .transform(v => (v.min > v.max ? { ...v, min: v.max, max: v.min } : v)));
const note = z.object({ type: z.literal("note"), ...base, badge: optionalText(12), verdict: z.object({ text: text(30), tone: tone.default("neutral") }).strip().optional(), text: text(400) }).strip();

const BLOCK_SCHEMAS = { kpis, bars, ranges, chart, leans, table, heatmap, allocation, timeline, checklist, gauge, note } as const;
type BlockInput = { [K in keyof typeof BLOCK_SCHEMAS]: z.output<(typeof BLOCK_SCHEMAS)[K]> }[keyof typeof BLOCK_SCHEMAS];
/** Each block is checked against its own type's schema, so a refusal names the field that was wrong (a union says only "Invalid input"). */
const block = z.unknown().transform((value, ctx): BlockInput => {
  const type = value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string" ? (value as { type: string }).type.trim().toLowerCase() : "";
  const schema = (BLOCK_SCHEMAS as Record<string, z.ZodTypeAny>)[type];
  if (!schema) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["type"], message: `type must be one of ${Object.keys(BLOCK_SCHEMAS).join(", ")}` }); return z.NEVER; }
  const parsed = schema.safeParse({ ...(value as object), type });
  if (!parsed.success) { for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, message: `${type}: ${issue.message}` } as z.IssueData); return z.NEVER; }
  return parsed.data as BlockInput;
});
export const CANVAS_BLOCKS = ["kpis", "bars", "ranges", "chart", "leans", "table", "heatmap", "allocation", "timeline", "checklist", "gauge", "note"] as const;

/** What the model sends to finance.present. */
export const CanvasInputSchema = z.object({
  title: text(80), badge: optionalText(12), meta: optionalText(120),
  chips: list(z.object({ text: text(60), tone: tone.default("neutral"), icon: lower(["up", "down", "clock", "alert", "target", "check", "none"]).optional() }).strip(), 0, 4).default([]),
  lead: z.object({ asked: optionalText(60), matched: optionalText(120) }).strip().optional(),
  blocks: list(block, 1, 12),
  // A source whose url is not a web address is left off rather than refusing the card; at least one must remain.
  sources: z.preprocess(value => Array.isArray(value) ? value.filter(item => source.safeParse(item).success) : value, list(source, 1, 8)),
}).strip();
export type CanvasInput = z.output<typeof CanvasInputSchema>;
export type CanvasBlockInput = CanvasInput["blocks"][number];

export type CanvasChart = { type: "chart"; title?: string; width?: (typeof CANVAS_WIDTHS)[number]; mode: "level" | "change"; lines: CanvasLine[]; annotations: { date: string; label: string }[]; missing: string[] };
export type CanvasBlock = Exclude<CanvasBlockInput, { type: "chart" }> | CanvasChart;
export type CanvasView = Omit<CanvasInput, "blocks"> & { kind: "canvas"; guide?: string; blocks: CanvasBlock[] };

/** The stored view: shape-checked only (its contents were validated when it was built); read it as CanvasView. */
export const CanvasViewSchema = z.object({
  kind: z.literal("canvas"), title: z.string(), badge: z.string().optional(), meta: z.string().optional(),
  /** The method guide whose layout the host checked these blocks against (finance.guide topic). */
  guide: z.string().max(40).optional(),
  chips: z.array(z.object({ text: z.string(), tone: z.enum(CANVAS_TONES), icon: z.string().optional() }).strict()),
  lead: z.object({ asked: z.string().optional(), matched: z.string().optional() }).strict().optional(),
  blocks: z.array(z.object({ type: z.enum(CANVAS_BLOCKS) }).passthrough()).min(1).max(12),
  sources: z.array(z.object({ title: z.string(), url: z.string() }).strict()).min(1).max(8),
}).strict();

