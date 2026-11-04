import { z } from "zod";

/**
 * finance.present: the answer's own result card. Two kinds the owner asked for by name ("Halo earning summary" and "What effect blue
 * wave in US election to US market."): a company's reported results, and how an event moves markets sector by sector.
 * The model supplies what it read (figures with their sources); the host draws it. The reaction chart of an impact card is never model-supplied:
 * the host reads the asset's daily closes itself (finance.query price_history) and draws those.
 * Input is forgiving about form (a number written as text or "$481.0M", a word in another case, a range given high-first); a value that is
 * genuinely missing still fails, so a card never shows a guess.
 */

const text = (max: number) => z.string().transform(value => value.replace(/\s+/g, " ").trim()).pipe(z.string().min(1).max(max));
const optionalText = (max: number) => z.preprocess(value => (value === null || value === "" ? undefined : value), text(max).optional());
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, tn: 1e12, trillion: 1e12 };
/** "481.0M", "$1.835 billion", "1,234", "−0.9" (Unicode minus) and 481000000 all read as numbers; anything else is left for the schema to refuse. */
export function financePresentNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cleaned = value.trim().replace(/[−–]/g, "-").replace(/[$,\s]/g, "").replace(/^US\$/i, "");
  const match = /^(-?\d+(?:\.\d+)?)([a-z]*)$/i.exec(cleaned);
  if (!match) return value;
  const scale = match[2] ? SCALE[match[2].toLowerCase()] : 1;
  return scale ? Number(match[1]) * scale : value;
}
const num = z.preprocess(financePresentNumber, z.number().finite());
const lower = <T extends [string, ...string[]]>(values: T) => z.preprocess(value => (typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : value), z.enum(values));
const date = z.preprocess(value => (typeof value === "string" ? value.trim().slice(0, 10) : value), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value));
const source = z.object({ title: text(120), url: z.string().trim().url().max(2000).refine(value => /^https?:\/\//i.test(value)) }).strip();

export const FINANCE_PRESENT_UNITS = ["usd", "usd_per_share", "percent", "count"] as const;
const metric = z.object({ label: text(40), value: num, prior: z.preprocess(value => (value === "" ? null : value), num.nullable().optional()), unit: lower([...FINANCE_PRESENT_UNITS]).default("usd"), note: optionalText(60) }).strip();
const guidance = z.object({ label: text(40), low: num, high: num, unit: lower(["usd", "usd_per_share", "percent"]).default("usd"),
  change: z.preprocess(value => (value === "" ? null : value), lower(["raised", "maintained", "lowered", "new"]).nullable().optional()) }).strip()
  .transform(value => (value.low > value.high ? { ...value, low: value.high, high: value.low } : value));

export const FinanceEarningsViewSchema = z.object({
  kind: z.literal("earnings"),
  asked: z.string().optional(),
  company: z.object({ symbol: z.string(), name: z.string(), exchange: z.string().optional() }).strict(),
  period: z.string(),
  priorPeriod: z.string().optional(),
  metrics: z.array(z.object({ label: z.string(), value: z.number(), prior: z.number().nullable().optional(), unit: z.enum(FINANCE_PRESENT_UNITS), note: z.string().optional() }).strict()).min(1).max(4),
  guidance: z.array(z.object({ label: z.string(), low: z.number(), high: z.number(), unit: z.enum(["usd", "usd_per_share", "percent"]), change: z.enum(["raised", "maintained", "lowered", "new"]).nullable().optional() }).strict()).max(3),
  guidancePeriod: z.string().optional(),
  nextReport: z.object({ date: z.string(), timing: z.enum(["before_open", "after_close", "during"]).nullable().optional() }).strict().nullable().optional(),
  sources: z.array(z.object({ title: z.string(), url: z.string() }).strict()).min(1).max(6),
}).strict();

export const FINANCE_PRESENT_DIRECTIONS = ["supportive", "pressure", "mixed", "unclear", "depends"] as const;
const clampLean = (value: number) => Math.max(-2, Math.min(2, value));
const row = z.object({ name: text(48), direction: lower([...FINANCE_PRESENT_DIRECTIONS]), low: num.transform(clampLean), high: num.transform(clampLean), reason: text(140) }).strip()
  .transform(value => (value.low > value.high ? { ...value, low: value.high, high: value.low } : value));
const reactionPoint = z.object({ date: z.string(), value: z.number(), change: z.number() }).strict();
export const FinanceImpactViewSchema = z.object({
  kind: z.literal("impact"),
  title: z.string(), subtitle: z.string().optional(), caveat: z.string().optional(),
  rows: z.array(z.object({ name: z.string(), direction: z.enum(FINANCE_PRESENT_DIRECTIONS), low: z.number(), high: z.number(), reason: z.string() }).strict()).min(2).max(8),
  reaction: z.object({ label: z.string(), symbol: z.string(), currency: z.string(), points: z.array(reactionPoint).min(2).max(400), annotations: z.array(z.object({ date: z.string(), label: z.string() }).strict()).max(3), sourceUrls: z.array(z.string()).max(4) }).strict().nullable(),
  watch: z.array(z.object({ symbol: z.string(), verdict: z.enum(["watch", "act", "hold"]), text: z.string() }).strict()).max(3),
  sources: z.array(z.object({ title: z.string(), url: z.string() }).strict()).min(1).max(6),
}).strict();

export type FinanceEarningsView = z.infer<typeof FinanceEarningsViewSchema>;
export type FinanceImpactView = z.infer<typeof FinanceImpactViewSchema>;

/** What the model sends. `reaction.assetId` names an asset finance.search returned or a saved one; the host reads its closes. */
export const FinancePresentInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("earnings"),
    asked: optionalText(60),
    company: z.object({ symbol: text(20), name: text(120), exchange: optionalText(40) }).strip(),
    period: text(40), priorPeriod: optionalText(40),
    metrics: z.array(metric).min(1).max(4),
    guidance: z.array(guidance).max(3).default([]), guidancePeriod: optionalText(40),
    nextReport: z.preprocess(value => (value === "" ? null : value), z.object({ date, timing: z.preprocess(value => (value === "" ? null : value), lower(["before_open", "after_close", "during"]).nullable().optional()) }).strip().nullable().optional()),
    sources: z.array(source).min(1).max(6),
  }).strip(),
  z.object({
    kind: z.literal("impact"),
    title: text(80), subtitle: optionalText(120), caveat: optionalText(120),
    rows: z.array(row).min(2).max(8),
    reaction: z.preprocess(value => (value === "" ? null : value), z.object({ assetId: text(200), label: text(80), from: date.optional(), annotations: z.array(z.object({ date, label: text(40) }).strip()).max(3).default([]) }).strip().nullable().optional()),
    watch: z.array(z.object({ symbol: text(20), verdict: lower(["watch", "act", "hold"]), text: text(220) }).strip()).max(3).default([]),
    sources: z.array(source).min(1).max(6),
  }).strip(),
]);
export type FinancePresentInput = z.output<typeof FinancePresentInputSchema>;

/** The kind word is matched in any case ("Earnings"). */
export function financePresentKind(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  return typeof value.kind === "string" ? { ...value, kind: value.kind.trim().toLowerCase() } : value;
}

/** Daily closes (finance.query price_history rows) as the reaction series: each point's change is against the first point on or after `from`. */
export function financeReactionSeries(result: { columns: readonly string[]; rows: readonly (string | number | null)[][]; sourceUrls?: readonly string[] }, from?: string): { symbol: string; currency: string; points: { date: string; value: number; change: number }[]; sourceUrls: string[] } | null {
  const at = (name: string) => result.columns.indexOf(name);
  const d = at("Observation date"), c = at("Close (raw)"), s = at("Symbol"), cur = at("Currency");
  if (d < 0 || c < 0) return null;
  const rows = result.rows.filter(row => typeof row[d] === "string" && typeof row[c] === "number" && Number.isFinite(row[c] as number))
    .map(row => ({ date: String(row[d]).slice(0, 10), value: row[c] as number, symbol: s >= 0 ? String(row[s] ?? "") : "", currency: cur >= 0 ? String(row[cur] ?? "") : "" }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const unique = rows.filter((row, i) => i === 0 || row.date !== rows[i - 1].date);
  const start = from ? Math.max(0, unique.findIndex(row => row.date >= from) - 1) : 0;
  const kept = unique.slice(start < 0 ? 0 : start);
  if (kept.length < 2) return null;
  const base = kept[0].value;
  return { symbol: kept[0].symbol, currency: kept[0].currency, points: kept.map(row => ({ date: row.date, value: row.value, change: base ? (row.value / base - 1) * 100 : 0 })), sourceUrls: [...(result.sourceUrls ?? [])].slice(0, 4) };
}
