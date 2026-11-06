import { z } from "zod";
import { CURRENCY, bold, canvasFormat, esc } from "../../kit";
import { list, loose } from "../../fields";

/**
 * What the document assets share: one accent hue per document, the date and money formats of a printed page, and the small
 * stylesheet every page starts from. A page is drawn on a white sheet sized in `cqw` (the frame's width), so it scales from a
 * phone to the desktop; the sheet clips whatever a script-length string could push past its edge, and the schema limits keep the
 * Latin worst case inside it.
 */

/** The hues a document may take. Strong tone + a soft tint for chips and grounds; both from the card's own palette. */
const HUES: Record<string, [string, string]> = {
  blue: ["var(--blue)", "#e7eefc"], green: ["var(--green)", "#e3f1eb"], red: ["var(--red)", "#f8e6e8"],
  amber: ["var(--amber)", "#fbf1de"], violet: ["#7c3aed", "#f1e9fd"], ink: ["var(--ink2)", "#eef0ee"],
};
const NAMES = ["auto", ...Object.keys(HUES)] as [string, ...string[]];
const SYNONYMS: Record<string, string> = {
  navy: "blue", indigo: "blue", cobalt: "blue", sky: "blue", azure: "blue", teal: "green", emerald: "green", forest: "green", mint: "green", cyan: "green",
  crimson: "red", burgundy: "red", maroon: "red", rose: "red", pink: "red", scarlet: "red", orange: "amber", gold: "amber", yellow: "amber", brown: "amber", bronze: "amber",
  purple: "violet", lilac: "violet", plum: "violet", black: "ink", grey: "ink", gray: "ink", slate: "ink", charcoal: "ink", dark: "ink", neutral: "ink", default: "auto", none: "auto",
};
/** Optional `accent`: a hue word, a synonym, or nothing (the document's own default). Anything else falls back to that default. */
export const accent = loose(NAMES, SYNONYMS, "auto").optional();
/** The style attribute that sets the document's accent (`--ac` strong, `--at` tint). `fallback` is the document's own hue. */
export function hue(value: string | undefined, fallback: string, extra = "", ko = false): string {
  const [strong, tint] = HUES[value && value !== "auto" ? value : fallback] ?? HUES.blue;
  // Korean labels need a larger size and tighter tracking than the spaced capitals of Latin ones (`--lb`, `--ls` feed `h3` and LABEL)
  return `style="--ac:${strong};--at:${tint}${ko ? ";--lb:1.9cqw;--ls:.05em" : ""}${extra ? `;${extra}` : ""}"`;
}

/** An optional list: absent or empty is "nothing to show"; a longer one keeps its first `max`. */
export const optList = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.preprocess(value => (value === null || (Array.isArray(value) && !value.length) ? undefined : value), list(item, 1, max).optional());

/** A date as a printed page writes it. An ISO date is spelled out in the card's language; any other string is shown as written. */
export function day(value: string, ko: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return value;
  return ko ? `${m[1]}년 ${+m[2]}월 ${+m[3]}일` : new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
/** An exact amount (cents kept) with its currency symbol; a unit that is not a currency falls back to the card's number format. */
export function money(value: number, unit: string, ko: boolean): string {
  const symbol = CURRENCY[unit];
  if (!symbol) return canvasFormat(value, unit, ko);
  const places = unit === "jpy" || unit === "krw" ? 0 : 2, n = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
  return unit === "krw" && ko ? `${value < 0 ? "−" : ""}${n}원` : `${value < 0 ? "−" : ""}${symbol}${n}`;
}
/** Money arithmetic without float noise. */
export const cents = (value: number) => Math.round(value * 100) / 100;
export const count = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Plain text for a summary: bold markers and angle brackets removed. */
export const plain = (value: unknown) => String(value ?? "").replace(/\*\*/g, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
/** Paragraphs of body text (`**bold**` allowed). */
export const paras = (items: readonly string[]) => items.map(item => `<p>${bold(item)}</p>`).join("");
/** The first letters of a name, for an avatar. */
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0]).join("").toUpperCase() || "?";
export { esc };

/** Inline pieces a page writes once or a few times (a rule would cost more of the 1500-character stylesheet than the markup does). */
export const ROW = "display:flex;justify-content:space-between;align-items:center;gap:2cqw";
export const MUTED = "font-size:1.8cqw;color:var(--muted)";
export const LABEL = "font-size:var(--lb,1.55cqw);font-weight:800;letter-spacing:var(--ls,.12em);text-transform:uppercase;color:var(--muted)";
export const RULE = "width:100%;border:0;border-top:.25cqw solid var(--line);margin:2cqw 0";

/**
 * The page stylesheet. `§` stands for `.fpc .a-<type>`; each piece is written once and an asset takes only those it uses (the gate allows
 * 1500 characters per asset, so the rest of a page's layout is written inline, where it is static). Semantic elements carry the roles:
 * h2 the page heading (serif), h3 a small accent label, p body text, b strong, em a chip.
 */
const SNIP: Record<string, string> = {
  // the sheet: fills the frame and clips what script-length text would push past its edge
  pg: `§ .a-pg{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;padding:6.5cqw 8cqw 6cqw;font-size:2.2cqw;line-height:1.5;color:var(--ink2)}`,
  // its children keep their height; `.a-fl` is the one that shrinks (and is cut) when the content is more than the sheet holds
  fx: `§ .a-pg>*{flex:none}§ .a-fl{flex:0 1 auto;min-height:0;overflow:hidden}`,
  h: `§ h2,§ .a-sf{font-family:Charter,Georgia,serif}§ h2{margin:0;font-size:4.6cqw;line-height:1.15;color:var(--ink);letter-spacing:-.01em}`,
  k: `§ h3{margin:0;font-size:var(--lb,1.55cqw);font-weight:800;letter-spacing:var(--ls,.14em);text-transform:uppercase;color:var(--ac)}`,
  p: `§ p{margin:0 0 1.5cqw}§ b{color:var(--ink)}`,
  e: `§ em{padding:.3cqw 1.5cqw;border-radius:9cqw;background:var(--at);color:var(--ac);font-style:normal;font-weight:750;font-size:1.7cqw;white-space:nowrap}`,
  el: `§ .a-el{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}`,
  lc: `§ .a-lc{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--n,3);overflow:hidden}`,
};
/** The stylesheet for one asset: the named base pieces, then its own rules, with `§` read as the asset's scope and the layout whitespace removed. */
export function docCss(type: string, parts: string[], own: string): string {
  return [...parts.map(name => SNIP[name]), own].join("\n").replace(/§/g, `.fpc .a-${type}`).replace(/\s*\n\s*/g, "").replace(/;}/g, "}");
}
