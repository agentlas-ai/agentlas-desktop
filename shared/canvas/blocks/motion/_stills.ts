import { z } from "zod";
import { loose } from "../../fields";
import { esc } from "../../kit";

/**
 * What the keyframe stills (type.ts, numbers.ts, lower.ts) share: the colour worlds, text fitting that picks a font size from the text's length,
 * the entrance animation and the trend helpers. A still is a 16:9 frame whose type is sized in cqw; every colour comes from a table here
 * (never from the block's own text), so the markup stays inert.
 */
export interface Ground { bg: readonly [string, string, string]; fg: string; mu: string; ln: string; a: string; on: string; b: string; up: string; dn: string; dark: boolean }
export const GROUND_IDS = ["ink", "blue", "green", "violet", "sunset", "paper"] as const;
export type GroundId = (typeof GROUND_IDS)[number];
const LIGHT_MU = "rgba(255,255,255,.7)", LIGHT_LN = "rgba(255,255,255,.22)";
export const GROUNDS: Record<GroundId, Ground> = {
  ink: { bg: ["#070d12", "#12212a", "#223742"], fg: "#fff", mu: "rgba(255,255,255,.64)", ln: "rgba(255,255,255,.2)", a: "#38d39f", on: "#04201a", b: "#7aa2ff", up: "#3ddc97", dn: "#ff7a85", dark: true },
  blue: { bg: ["#112875", "#2f5fd6", "#78a4ff"], fg: "#fff", mu: LIGHT_MU, ln: LIGHT_LN, a: "#ffd166", on: "#2a1d00", b: "#9be7ff", up: "#6ff2b6", dn: "#ffa3ab", dark: true },
  green: { bg: ["#04291f", "#0c7550", "#3fd9a4"], fg: "#fff", mu: LIGHT_MU, ln: LIGHT_LN, a: "#ffe27a", on: "#2a2200", b: "#d2ffe9", up: "#c4ff94", dn: "#ffb4a6", dark: true },
  violet: { bg: ["#2f0f73", "#7436e6", "#bda7ff"], fg: "#fff", mu: LIGHT_MU, ln: LIGHT_LN, a: "#ffe08a", on: "#2b1c00", b: "#ffc2ec", up: "#8dfcc4", dn: "#ffb0b8", dark: true },
  sunset: { bg: ["#7a0f2e", "#d9432a", "#f7a640"], fg: "#fff", mu: "rgba(255,255,255,.78)", ln: "rgba(255,255,255,.26)", a: "#ffd45c", on: "#3a0b12", b: "#fff1c9", up: "#b9ffd9", dn: "#ffd0c8", dark: true },
  paper: { bg: ["#fcfaf4", "#f4f0e5", "#e5dfcf"], fg: "#101d24", mu: "rgba(16,29,36,.62)", ln: "rgba(16,29,36,.16)", a: "#2f5fd6", on: "#fff", b: "#f08a24", up: "#118558", dn: "#cf3545", dark: false },
};
const SYNONYMS: Record<string, GroundId> = { dark: "ink", black: "ink", night: "ink", navy: "blue", indigo: "blue", teal: "green", emerald: "green", purple: "violet", lilac: "violet", orange: "sunset", warm: "sunset", red: "sunset", light: "paper", white: "paper", cream: "paper", ivory: "paper" };
/** The colour world of a still: ink, blue, green, violet, sunset or paper (light). `fallback` is the world an unknown word or a missing field takes. */
export const groundField = (fallback: GroundId) => loose([...GROUND_IDS] as [string, ...string[]], SYNONYMS, fallback).optional();
/** The second accent of a ground (the far end of a gradient stroke): its own `b`, a light blue on paper where the orange turns muddy. */
export const tint = (g: Ground) => (g.dark ? g.b : "#7aa2ff");
/** A glow's opacity: as given on a dark ground, softer on paper. */
export const glowOp = (g: Ground, v: number) => +(g.dark ? v : v * 0.4).toFixed(2);
export const groundKey = (id: string | undefined, fallback: GroundId): GroundId => (id && id in GROUNDS ? id : fallback) as GroundId;
export const groundOf = (id: string | undefined, fallback: GroundId): Ground => GROUNDS[(id ?? fallback) as GroundId] ?? GROUNDS[fallback];
/** The shape colour of a ground: white on the dark ones, ink on paper. `rgb` is the same as a triplet for rgba(). */
export const shape = (g: Ground) => ({ hex: g.dark ? "#ffffff" : "#101d24", rgb: g.dark ? "255,255,255" : "16,29,36" });

/** The stage's style attribute: it fills the frame, carries the ground's variables and gradient (or `bg`) and any `layout` declarations. The only inline style built from a table. */
export function stage(g: Ground, layout = "", bg?: string): string {
  const s = shape(g);
  return `style="position:absolute;inset:0;z-index:0;overflow:hidden;color:var(--fg);${layout ? `${layout};` : ""}--fg:${g.fg};--mu:${g.mu};--ln:${g.ln};--sh:${s.rgb};--a:${g.a};--on:${g.on};--b:${g.b};--up:${g.up};--dn:${g.dn};background:${bg ?? `linear-gradient(135deg,${g.bg[0]},${g.bg[1]} 55%,${g.bg[2]})`}"`;
}
/** The full-frame decoration svg (viewBox 160 x 90 = the frame), fading in at `delay` seconds; it sits behind the stage's text (the stage is its stacking context). */
export const deco = (inner: string, delay = 0, extra = "") => `<svg class="a-dc a-in" style="position:absolute;inset:0;z-index:-1;width:100%;height:100%;--d:${delay}s${extra}" viewBox="0 0 160 90" aria-hidden="true">${inner}</svg>`;
/** Lines of text kept to `n`, cut with an ellipsis. */
export const clamp = (n: number) => `display:-webkit-box;-webkit-line-clamp:${n};-webkit-box-orient:vertical;overflow:hidden`;
/** A small label in capitals with an accent rule above it (the kicker of a poster). */
export const kicker = (label: string, delay: string, width = 62, color = "var(--mu)") => `<div class="a-in" style="${delay};max-width:${width}cqw;font-size:2.3cqw;font-weight:800;line-height:1.3;letter-spacing:.15em;text-transform:uppercase;color:${color};${clamp(2)}"><i style="display:block;width:6cqw;height:.7cqw;margin-bottom:1.5cqw;border-radius:1cqw;background:var(--a)"></i>${esc(label)}</div>`;

/** The css every still starts with (its root and the entrance), written for `type`; `rules` hold selectors relative to the block. */
export function still(type: string, rules = "", frames = ""): string {
  const all = `&{border:0}.a-in{animation:a-${type}-x .9s cubic-bezier(.2,.8,.2,1) var(--d,0s) both}${rules}`;
  const scoped = all.replace(/([^{}]+)\{([^{}]*)\}/g, (_m, sel: string, body: string) => `${sel.split(",").map(part => { const p = part.trim(); return p === "&" ? `.fpc .a-${type}` : `.fpc .a-${type} ${p}`; }).join(",")}{${body}}`);
  return `${scoped}@keyframes a-${type}-x{from{opacity:0;transform:translateY(1.6cqw)}}${frames}`;
}
/** The delay variable of the n-th element of an entrance (a stagger). */
export const stagger = (n: number, base = 0.06, step = 0.12) => `--d:${(base + n * step).toFixed(2)}s`;

/** Width of a string in em: a rough face-independent measure (capitals and digits wider, narrow marks narrower, Hangul and CJK a full em). */
export function em(s: string): number {
  let w = 0;
  for (const c of s) {
    if (/[ᄀ-ᇿ　-鿿가-힣＀-￯]/.test(c)) w += 1;
    else if (/[A-Z]/.test(c)) w += 0.68;
    else if (/[0-9]/.test(c)) w += 0.6;
    else if (c === " ") w += 0.28;
    else if (/[.,:;'|!iIlj]/.test(c)) w += 0.3;
    else if (c === "m" || c === "w") w += 0.82;
    else if (/[MW%@]/.test(c)) w += 0.95;
    else w += 0.54;
  }
  return w;
}
/** The largest font size in cqw, within [min, max], at which one line of `s` fits `width` cqw (`track` is letter spacing in em, `weight` widens heavy faces). */
export function fit(s: string, width: number, max: number, min: number, track = 0, weight = 1.06): number {
  const w = em(s) * weight + [...s].length * track;
  return +Math.max(min, Math.min(max, width / Math.max(w, 0.5))).toFixed(2);
}
/** The largest font size in cqw, within [min, max], at which `s` wrapped to `width` takes at most `height` cqw at line height `lh`. */
export function block(s: string, width: number, height: number, max: number, min: number, lh = 1.2, track = 0, weight = 1.05): number {
  const total = em(s) * weight + [...s].length * track;
  for (let size = max; size > min; size -= 0.2) if (Math.ceil((total * size) / (width * 0.9)) * size * lh <= height) return +size.toFixed(2);
  return min;
}
export const cq = (n: number) => `${+n.toFixed(2)}cqw`;

/** A whole number a model wrote any way ("12", "12.4", "12 days"), held to [0, max]. */
export const whole = (max: number) => z.preprocess(v => { const n = typeof v === "string" ? Number(v.replace(/[^\d.-]/g, "")) : v; return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : v; }, z.number().int());
/** A percentage 0-100 ("72", "72%", 0.72 stays 0.72). */
export const pct = z.preprocess(v => { const n = typeof v === "string" ? Number(v.replace(/[%\s,]/g, "")) : v; return typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : v; }, z.number());
export const optionalPct = z.preprocess(v => (v === null || v === "" ? undefined : v), pct.optional());
export const shown = (n: number) => `${+n.toFixed(1)}`;
/** A number read from a model's text ("1,240", "$3.2", "−4"), or null for a gap. */
export const value = z.preprocess(v => (v === null || v === "" || v === undefined ? null : typeof v === "string" ? Number(v.replace(/[,$%\s]/g, "").replace("−", "-")) : v), z.number().finite().nullable());

export type Trend = "up" | "down" | "flat";
export const trend = loose(["up", "down", "flat"], { positive: "up", rise: "up", gain: "up", increase: "up", good: "up", negative: "down", fall: "down", decrease: "down", loss: "down", bad: "down", neutral: "flat", none: "flat", same: "flat" }, "flat").optional();
/** The direction a change text reads: its own sign unless the block states one. */
export const trendOf = (stated: string | undefined, changeText: string | undefined): Trend => (stated as Trend | undefined) ?? (/^\s*[+▲↑]/.test(changeText ?? "") ? "up" : /^\s*[-−–▼↓]/.test(changeText ?? "") ? "down" : "flat");
export const trendColor = (g: Ground, t: Trend) => (t === "up" ? g.up : t === "down" ? g.dn : g.mu);
/** A small direction mark (triangle up or down, a dash when flat) in `color`; sized by the surrounding font. */
export const mark = (t: Trend, color: string) => `<svg style="width:.8em;height:.8em;flex:none" viewBox="0 0 10 10" aria-hidden="true">${t === "up" ? `<path d="M5 1.2 9.4 8.8H.6Z" fill="${color}"/>` : t === "down" ? `<path d="M5 8.8 9.4 1.2H.6Z" fill="${color}"/>` : `<rect x="1" y="4" width="8" height="2.2" rx="1.1" fill="${color}"/>`}</svg>`;
/** A figure written "+38%" or "$2.4M" split in its sign/currency, its digits and its unit, so the unit can be set small and in the accent colour. */
export function figureParts(s: string): { pre: string; num: string; post: string } {
  const m = /^(\D*?)(\d[\d.,]*)(.*)$/.exec(s);
  return m ? { pre: m[1], num: m[2], post: m[3] } : { pre: "", num: s, post: "" };
}
export const unitSpan = (s: string, scale = 0.58) => (s ? `<span style="font-size:${scale}em;font-weight:700;letter-spacing:0;color:var(--a);vertical-align:.36em">${esc(s)}</span>` : "");
