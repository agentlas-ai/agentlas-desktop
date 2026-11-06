import { esc } from "../../kit";
import { loose } from "../../fields";

/**
 * What every slide of the deck shares, so a whole deck reads as one design: the five colour worlds (the same as title_slide's), the frame
 * (margins in cqw, headline, footer line), the fit rules that pick a type size from the length of a text, and `sx`, which scopes css.
 * Everything here is a fixed table or a pure function: nothing from a block reaches a style attribute except through these tables.
 */
export const GROUNDS = ["ink", "blue", "green", "violet", "sunset"] as const;
const SYNONYMS: Record<string, (typeof GROUNDS)[number]> = { dark: "ink", black: "ink", gray: "ink", grey: "ink", navy: "blue", teal: "green", purple: "violet", orange: "sunset", warm: "sunset", red: "sunset", yellow: "sunset" };
/** The colour a dark slide (section, closing, quote) stands on. */
export const ground = loose([...GROUNDS] as [string, ...string[]], SYNONYMS, "ink").optional();
/** The accent of a light slide: the same five words, so one deck word picks one colour world everywhere. */
export const accent = loose([...GROUNDS] as [string, ...string[]], SYNONYMS, "blue").optional();

const GROUND_BG: Record<string, string> = {
  ink: "linear-gradient(135deg,#101d24,#24323a)", blue: "linear-gradient(135deg,#1c3f9c,#2f5fd6 60%,#7aa2ff)", green: "linear-gradient(135deg,#0b4f3c,#118558 60%,#38d39f)",
  violet: "linear-gradient(135deg,#4c1d95,#7c3aed 60%,#c4b5fd)", sunset: "linear-gradient(135deg,#b4231d,#f08a24 60%,#ffd27a)",
};
/** [accent that reads on white, soft tint of it, tinted ground for a quote]. */
const ACCENT: Record<string, [string, string, string]> = {
  ink: ["#24323a", "#e9ecee", "#efeee8"], blue: ["#2f5fd6", "#e8eeff", "#e6edff"], green: ["#118558", "#e1f4ea", "#e0f3e8"], violet: ["#7c3aed", "#f0e8fe", "#eee6fd"], sunset: ["#d9680f", "#ffeedb", "#ffeedc"],
};
/** The accent as colours for a drawing: [the accent, a pale tint of it for the quiet marks]. */
export const accentHex = (a?: string): [string, string] => { const [c] = ACCENT[a ?? "blue"] ?? ACCENT.blue; return [c, lighten(c, 0.68)]; };
/** A colour mixed with white by `t` (0 keeps it, 1 is white). */
export function lighten(hex: string, t: number) {
  const n = parseInt(hex.slice(1), 16), mix = (v: number) => Math.round(v + (255 - v) * t);
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map(v => mix(v).toString(16).padStart(2, "0")).join("")}`;
}
/** The inline style of a dark slide: its gradient, white type and the footer colours. */
export const darkStyle = (g?: string) => `background:${GROUND_BG[g ?? "ink"] ?? GROUND_BG.ink};color:#fff;--fc:rgba(255,255,255,.74);--fl:rgba(255,255,255,.28)`;
/** The inline style of a light slide: its accent and the tint of it. */
export const accentStyle = (a?: string) => { const [c, t, q] = ACCENT[a ?? "blue"] ?? ACCENT.blue; return `--ac:${c};--ac2:${t};--aq:${q}`; };

/** Width of a text in em, measured against the card's face and rounded up a little: a Hangul or CJK character about 0.95, a Latin letter about 0.5. */
export const em = (s: string) => [...s].reduce((w, c) => w + (/[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7a3\uff00-\uffef]/.test(c) ? 0.95 : c === " " ? 0.28 : /[il.,;:'!|()\[\]]/.test(c) ? 0.27 : /[tfrjI]/.test(c) ? 0.38 : /[mwMW@%]/.test(c) ? 0.85 : /[A-Z0-9]/.test(c) ? 0.62 : 0.53), 0);
/** The first [size in cqw, lines] step whose estimated line count holds in `width` (cqw); the last step when none does (the css clips with an ellipsis). */
export function fit(s: string, width: number, steps: readonly (readonly [number, number])[]): number {
  const w = em(s);
  for (const [size, lines] of steps) if (Math.ceil((w * size) / (width * 0.94)) <= lines) return size;
  return steps[steps.length - 1][0];
}
/** Headline steps: one line from 4.6 to 3.8cqw, else two lines from 4.0 to 3.2cqw. */
export const HEAD: readonly (readonly [number, number])[] = [[4.6, 1], [4.2, 1], [3.8, 1], [4.0, 2], [3.6, 2], [3.2, 2]];

/**
 * The parts every slide shares are fixed inline styles (constants below, never built from a block's text): the css of an asset is limited, and this
 * keeps it for what is particular to that slide. A later declaration in the same attribute wins, so a slide passes `extra` to adjust one.
 */
const FRAME = "position:absolute;inset:0;padding:6.4cqw 8cqw 8.8cqw;display:flex;flex-direction:column;gap:2.8cqw";
const H2 = "margin:0;font-weight:800;line-height:1.16;letter-spacing:-.02em;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden";
const KICK = "margin-bottom:.9cqw;font-size:1.7cqw;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--ac,inherit)";
const FOOT = "position:absolute;left:8cqw;right:8cqw;bottom:3.4cqw;display:flex;justify-content:space-between;gap:3cqw;padding-top:1cqw;border-top:1px solid var(--fl,var(--line));font-size:1.6cqw;line-height:1.3;font-weight:650;color:var(--fc,var(--faint));white-space:nowrap";
export const kicker = (s: string, extra = "") => `<div class="a-kk" style="${KICK}${extra}">${esc(s)}</div>`;
export const h2 = (s: string, size: number, extra = "") => `<h2 style="${H2};font-size:${size}cqw${extra}">${esc(s)}</h2>`;
/** The slide's headline (with an optional kicker above it), sized to its length in a column `width` cqw wide. */
export const head = (heading: string, o: { kicker?: string; width?: number; oneLine?: boolean } = {}) => `<header class="a-h" style="flex:none;min-width:0">${o.kicker ? kicker(o.kicker) : ""}${h2(heading, fit(heading, o.width ?? 84, o.oneLine ? HEAD1 : HEAD), o.oneLine ? ";-webkit-line-clamp:1" : "")}</header>`;
/** Headline steps for a slide that cannot spare a second line: 4.2 down to 3cqw, cut with an ellipsis. */
export const HEAD1: readonly (readonly [number, number])[] = [[4.2, 1], [3.8, 1], [3.4, 1], [3, 1]];

/** The body area under the headline: it takes the rest of the frame and holds what a slide draws. */
export const body = (inner: string, extra = "") => `<div class="a-b" style="flex:1;min-height:0;position:relative${extra ? `;${extra}` : ""}">${inner}</div>`;
/** The slim footer: "Deck name · 4" splits into the name and a page number at the right. */
export function foot(footer?: string, box?: { left?: number; right?: number }) {
  if (!footer) return "";
  const m = /^(.*\S)\s*[·|•]\s*(\d{1,3})$/.exec(footer);
  return `<footer class="a-ft" style="${FOOT}${box ? `;left:${box.left ?? 8}cqw;right:${box.right ?? 8}cqw` : ""}"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(m ? m[1] : footer)}</span>${m ? `<b style="color:var(--ac,inherit);font-weight:800">${esc(m[2])}</b>` : ""}</footer>`;
}
/** A light slide: the accent, the body and the footer (the bottom margin shrinks when there is no footer). */
export const slide = (a: string | undefined, body: string, footer?: string, extra = "", box?: { left?: number; right?: number }) => `<div class="a-s" style="${FRAME};background:#fdfcfa;color:var(--ink);${accentStyle(a)}${footer ? "" : ";padding-bottom:6.4cqw"}${extra ? `;${extra}` : ""}">${body}${foot(footer, box)}</div>`;
/** A dark slide: the ground and the body (no footer margin when there is no footer). */
export const dark = (g: string | undefined, body: string, footer?: string, extra = "", box?: { left?: number; right?: number }) => `<div class="a-s" style="${FRAME};${darkStyle(g)}${footer ? "" : ";padding-bottom:6.4cqw"}${extra ? `;${extra}` : ""}">${body}${foot(footer, box)}</div>`;

/** The height (cqw) left for the body of a light slide under its headline: the frame minus margins, the headline lines, the kicker and the gap. */
export function room(heading: string, o: { kicker?: boolean; footer?: boolean; width?: number; oneLine?: boolean } = {}) {
  const width = o.width ?? 84, size = fit(heading, width, o.oneLine ? HEAD1 : HEAD), lines = o.oneLine ? 1 : Math.min(2, Math.ceil((em(heading) * size) / (width * 0.94)));
  return 56.25 - 6.4 - (o.footer ? 8.8 : 6.4) - lines * size * 1.16 - (o.kicker ? 2.6 : 0) - 2.8;
}
/** The first size whose estimated height holds in `avail` cqw; the smallest when none does (the css clips). */
export const pick = (sizes: readonly number[], height: (size: number) => number, avail: number) => sizes.find(z => height(z) <= avail) ?? sizes[sizes.length - 1];
/** Estimated line count of a text at `size` cqw in a column `width` cqw wide, never more than `max`. */
export const linesOf = (s: string, size: number, width: number, max = 9) => Math.min(max, Math.max(1, Math.ceil((em(s) * size) / (width * 0.95))));

/** A soft ring decoration for the dark slides (the same light as title_slide's), `kind` moves it. */
export const deco = (uid: string, kind: "top" | "corner") => {
  const [cx, cy] = kind === "top" ? [132, 22] : [158, 88];
  return `<svg class="a-deco" style="position:absolute;inset:0;width:100%;height:100%" viewBox="0 0 160 90" preserveAspectRatio="xMaxYMid slice" aria-hidden="true"><defs><radialGradient id="${uid}r" cx="${(cx / 160).toFixed(2)}" cy="${(cy / 90).toFixed(2)}" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#${uid}r)"/><circle cx="${cx}" cy="${cy}" r="34" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width=".6"/><circle cx="${cx}" cy="${cy}" r="22" fill="none" stroke="#fff" stroke-opacity=".26" stroke-width=".6"/><circle cx="${cx}" cy="${cy}" r="10" fill="#fff" fill-opacity=".13"/></svg>`;
};

/** Writes css without the card's scope: `&` is the frame, every other selector is placed under `.fpc .a-<type>`; whitespace is dropped. */
export const sx = (type: string, rules: string) => rules.replace(/\n\s*/g, "").replace(/([^{}]+)\{/g, (_m, sels: string) => `${sels.split(",").map(s => (s.trim() === "&" ? `.fpc .a-${type}` : `.fpc .a-${type} ${s.trim()}`)).join(",")}{`);
/** Clamp a block of text to `n` lines with an ellipsis (a fixed rule, written once per slide that needs it). */
export const clamp = (n: number) => `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${n};overflow:hidden`;
/** A flag read the way models write it: true, "true", "yes", 1. */
export const flag = (v: unknown) => v === true || v === 1 || (typeof v === "string" && /^(?:true|yes|y|1|recommended|best)$/i.test(v.trim()));
/** One line, cut with an ellipsis (inline, so a slide's css keeps its room). */
export const ELL = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
export const pad2 = (n: number) => String(n).padStart(2, "0");
