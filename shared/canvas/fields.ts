import { z } from "zod";
import { financePresentNumber } from "../finance-present";
import { canvasFigure } from "./figures";

/**
 * The field readers every canvas block is written with (the 12 base blocks in schema.ts and every asset in blocks/). They are forgiving
 * about form (a number written as "$481.0M" or "26%", a word in another case or a synonym, text longer than a block shows) and strict about
 * substance (a value that is genuinely missing still fails), so a card is never refused for form and never shows a guess.
 */

/** Text longer than a block can show is cut with an ellipsis, not refused: the card is never lost for form. */
export const text = (max: number) => z.preprocess(value => (typeof value === "number" ? String(value) : value), z.string().transform(value => { const v = value.replace(/\s+/g, " ").trim(); return v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v; }).pipe(z.string().min(1)));
/** A list longer than a block can show keeps its first entries. */
export const list = <T extends z.ZodTypeAny>(item: T, min: number, max: number) => z.preprocess(value => (Array.isArray(value) ? value.slice(0, max) : value), z.array(item).min(min));
export const optionalText = (max: number) => z.preprocess(value => (value === null || value === "" ? undefined : value), text(max).optional());
export const figure = (value: unknown) => { const read = financePresentNumber(value); return typeof read === "number" ? read : canvasFigure(value).value; };
/** An object whose figure fields carry their unit in the text ("26%"): the unit is taken from the first such field unless one was given. */
export const withFigureUnit = (fields: string[]) => (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>; let found: string | undefined;
  for (const key of fields) if (typeof v[key] === "string") { const read = canvasFigure(v[key]); found ??= read.unit; }
  return found && (v.unit === undefined || v.unit === null || v.unit === "") ? { ...v, unit: found } : v;
};
export const num = z.preprocess(figure, z.number().finite());
/** "Not available" written as a value: the card refuses it (a KPI that holds no figure says nothing). */
export const NO_FIGURE = /^(?:n\/?a|na|none|null|unknown|—|–|-|tbd|tba|미정|없음|해당\s*없음)$/i;
export const optionalNum = z.preprocess(value => (value === null || value === "" ? undefined : figure(value)), z.number().finite().optional());
export const lower = <T extends [string, ...string[]]>(values: T) => z.preprocess(value => (typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : value), z.enum(values));
/** A fixed word read the way models write it: other case, a synonym, or (where a sensible default exists) anything else falls back to it. */
export const loose = <T extends [string, ...string[]]>(values: T, synonyms: Record<string, T[number]>, fallback?: T[number]) => z.preprocess(value => {
  if (typeof value !== "string") return value;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (values as readonly string[]).includes(key) ? key : synonyms[key] ?? fallback ?? key;
}, z.enum(values));
export const date = z.preprocess(value => (typeof value === "string" ? value.trim().slice(0, 10) : value), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))));
export const source = z.object({ title: text(160), url: z.string().trim().url().max(2000).refine(value => /^https?:\/\//i.test(value)) }).strip();

export const CANVAS_TONES = ["up", "down", "warn", "info", "neutral"] as const;
export const CANVAS_UNITS = ["usd", "usd_per_share", "percent", "count", "x", "bp", "krw", "eur", "jpy", "gbp", "cny", "text"] as const;
export const CANVAS_WIDTHS = ["full", "two_thirds", "half", "third"] as const;
export const tone = loose([...CANVAS_TONES] as [string, ...string[]], { positive: "up", good: "up", green: "up", success: "up", negative: "down", bad: "down", red: "down", danger: "down", warning: "warn", caution: "warn", amber: "warn", blue: "info", note: "info" }, "neutral");
export const unit = loose([...CANVAS_UNITS] as [string, ...string[]], { "$": "usd", dollar: "usd", dollars: "usd", usd_m: "usd", usd_mn: "usd", usd_bn: "usd", usd_b: "usd", eps: "usd_per_share", per_share: "usd_per_share", "%": "percent", pct: "percent", pp: "percent", ratio: "x", multiple: "x", times: "x", bps: "bp", basis_points: "bp", won: "krw", "₩": "krw", euro: "eur", yen: "jpy", pound: "gbp", yuan: "cny", number: "count", shares: "count", units: "count", days: "count", years: "count", string: "text" }, "count");
export const width = loose([...CANVAS_WIDTHS] as [string, ...string[]], { wide: "full", whole: "full", "100%": "full", "2/3": "two_thirds", twothirds: "two_thirds", "1/2": "half", "50%": "half", "1/3": "third", narrow: "third", one_third: "third" }, "full").optional();
/** The fields every block has: an optional heading and a grid width. */
export const base = { title: optionalText(80), width };
