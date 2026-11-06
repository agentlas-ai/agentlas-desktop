import { z } from "zod";
import { CURRENCY, esc, korean, niceScale } from "../../kit";
import { figure } from "../../fields";

/** Helpers the model-supplied chart assets of this folder share: number and label fitting, axes, shapes, the legend and the base styles. Pure; nothing here reads a block. */

/** A series value: a number the way a model writes it, or null for a gap. */
export const nullable = z.preprocess(v => (v === null || v === "" || v === undefined ? null : figure(v)), z.number().finite().nullable());
/** An optional "which row to highlight": a label or a 0-based index. */
export const highlight = z.preprocess(v => (v === null || v === "" ? undefined : v), z.union([z.number(), z.string()]).optional());

export const INK = "#101d24", INK2 = "#34424a", MUTED = "#5c6870", GRID = "#eceeec", ZERO = "#c9d0cc";
export const BLUE = "#2f5fd6", BLUE_L = "#7aa2ff", GREEN = "#18b67e", GREEN_D = "#118558", RED = "#cf3545", ORANGE = "#f08a24", GREY = "#b9c3be";
/** Fills for several series or stacked segments: one blue family first (a comparison reads as one thing), then green, orange and a neutral. */
export const SERIES = [BLUE, BLUE_L, GREEN, ORANGE, GREY];
export const LINES = [BLUE, GREEN, ORANGE];

/** Rendered width of `s` at `size` px (a per-letter estimate; a Hangul letter counts a full em). */
const em = (c: string) => (/[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7a3\uff00-\uffef]/.test(c) ? 1.02 : /[A-Z]/.test(c) ? (c === "I" ? 0.33 : c === "M" || c === "W" ? 0.88 : 0.66) : /[0-9]/.test(c) ? 0.6 : /[mw]/.test(c) ? 0.82 : /[ijlt]/.test(c) ? 0.31 : /[rf]/.test(c) ? 0.38 : /[a-z]/.test(c) ? 0.54 : /[ .,:;'|!]/.test(c) ? 0.3 : /[-–−—]/.test(c) ? 0.45 : /[$€£¥%+×]/.test(c) ? 0.62 : 0.58);
export const tw = (s: string, size = 11) => [...s].reduce((w, c) => w + em(c), 0) * size * 1.02;
export function clipPx(s: string, max: number, size = 11): string {
  if (tw(s, size) <= max) return s;
  const chars = [...s];
  while (chars.length > 1 && tw(`${chars.join("")}…`, size) > max) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}
/** A label on at most two lines inside `max` px: it breaks at a space, and the last line is cut with an ellipsis. */
export function wrapLabel(s: string, max: number, size = 11, lines = 2): string[] {
  if (tw(s, size) <= max) return [s];
  const words = s.split(" ");
  if (lines < 2 || words.length < 2) return [clipPx(s, max, size)];
  let first = words[0], i = 1;
  while (i < words.length && tw(`${first} ${words[i]}`, size) <= max) first += ` ${words[i++]}`;
  return [clipPx(first, max, size), clipPx(words.slice(i).join(" "), max, size)];
}
/** Category labels under bands `bandW` wide: all of them on up to two lines (11px, then 10px), or every k-th one when the others would still be cut. */
export function fitLabels(labels: string[], bandW: number): { rows: (string[] | null)[]; lines: number; size: number } {
  let rows: (string[] | null)[] = [], size = 11;
  for (const [k, sz] of [[1, 11], [1, 10], [2, 11], [3, 11], [4, 11]]) {
    const avail = k * bandW - 4;
    rows = labels.map((l, i) => (i % k === 0 ? wrapLabel(l, avail, sz) : null)); size = sz;
    if (k === 4 || rows.every((r, i) => !r || r.join(" ") === labels[i])) break;
  }
  return { rows, lines: Math.max(1, ...rows.map(r => r?.length ?? 0)), size };
}
/** The SVG text of `fitLabels` rows, centred on `centers`, first line at baseline `y`. */
export function drawLabels(rows: (string[] | null)[], centers: number[], y: number, size = 11): string {
  return rows.map((r, i) => (r ? `<text x="${p(centers[i])}" y="${y}" text-anchor="middle" class="a-ax"${size !== 11 ? ` style="font-size:${size}px"` : ""}>${r.map((line, j) => `<tspan x="${p(centers[i])}" dy="${j ? size * 1.14 : 0}">${esc(line)}</tspan>`).join("")}</text>` : "")).join("");
}

export const p = (n: number) => String(Math.round(n * 10) / 10);
const trim = (x: number, d: number) => String(+x.toFixed(d));
/** A magnitude for an axis or a value label: 1,430 · 12.5K · 3.2M. */
export function cmp(a: number): string {
  if (a >= 1e12) return `${trim(a / 1e12, a < 1e13 ? 2 : 1)}T`;
  if (a >= 1e9) return `${trim(a / 1e9, a < 1e10 ? 2 : 1)}B`;
  if (a >= 1e6) return `${trim(a / 1e6, a < 1e7 ? 2 : 1)}M`;
  if (a >= 1e4) return `${trim(a / 1e3, a < 1e5 ? 1 : 0)}K`;
  if (a >= 1e3) return Math.round(a).toLocaleString("en-US");
  return trim(a, a < 10 ? 2 : a < 100 ? 1 : 0);
}
/** A number with its unit, short enough for an axis tick or a label on a bar. */
export function short(v: number, unit: string, ko: boolean): string {
  const s = v < 0 ? "−" : "", a = Math.abs(v);
  if (unit === "krw" && ko) return korean(v);
  if (unit in CURRENCY) return `${s}${CURRENCY[unit]}${cmp(a)}`;
  if (unit === "usd_per_share") return `${s}$${a.toFixed(2)}`;
  if (unit === "percent") return `${s}${trim(a, a < 10 ? 2 : a < 100 ? 1 : 0)}%`;
  if (unit === "x") return `${s}${trim(a, 1)}×`;
  if (unit === "bp") return `${v >= 0 ? "+" : "−"}${Math.round(a)}bp`;
  return `${s}${cmp(a)}`;
}
/** The same for an axis tick: a per-share price drops its cents when it has none ($205 rather than $205.00). */
export const tick = (v: number, unit: string, ko: boolean) => (unit === "usd_per_share" ? `${v < 0 ? "−" : ""}$${+Math.abs(v).toFixed(2)}` : short(v, unit, ko));
/** A change with its sign: +$1.2M, −14%. */
export const delta = (v: number, unit: string, ko: boolean) => (unit === "bp" ? short(v, unit, ko) : `${v < 0 ? "−" : "+"}${short(Math.abs(v), unit, ko)}`);
/** A change between two values as a percent (null when the start is zero). */
export const pct = (from: number, to: number) => (from === 0 ? null : ((to - from) / Math.abs(from)) * 100);
/** How far a value moved, in the unit's own terms: percentage points for a percent, basis points for bp, a percent change otherwise. */
export function change(from: number, to: number, unit: string): string {
  const d = to - from, sign = d < 0 ? "−" : "+";
  if (unit === "percent") return `${sign}${+Math.abs(d).toFixed(1)}pp`;
  if (unit === "bp") return `${sign}${Math.round(Math.abs(d))}bp`;
  const c = pct(from, to);
  return c === null ? "—" : pctText(c);
}
export const pctText = (v: number) => `${v < 0 ? "−" : "+"}${trim(Math.abs(v), Math.abs(v) < 10 ? 1 : 0)}%`;
/** Up/down colour of a move: green for better, red for worse (`lowerIsBetter` flips it), neutral for no move. */
export function moveColor(from: number, to: number, lowerIsBetter?: boolean): string {
  if (to === from) return "#8a959b";
  return (to > from) !== !!lowerIsBetter ? GREEN_D : RED;
}
/** Text-safe form of the same colours (a lighter green is unreadable as text). */
export const moveText = moveColor;

export type Scale = ReturnType<typeof niceScale>;
const clean = (v: number, step: number) => (Math.abs(v) < step / 1e6 ? 0 : Number(v.toPrecision(12)));
/** An axis with exactly `n` intervals (so a second axis shares the first one's gridlines). */
export function fitScale(min: number, max: number, n: number): Scale {
  if (!(max > min)) { const pad = Math.abs(max) * 0.1 || 1; min -= pad; max += pad; }
  const raw = (max - min) / n, mag = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 2, 2.5, 5, 10, 20, 25, 50, 100]) {
    const step = k * mag, lo = Math.floor(min / step + 1e-9) * step;
    if (lo + n * step >= max - step * 1e-9) return { min: clean(lo, step), max: clean(lo + n * step, step), step, ticks: Array.from({ length: n + 1 }, (_, i) => clean(lo + i * step, step)) };
  }
  return niceScale(min, max, n);
}
/** The axis for [min, max] with the least empty room above and below (3, 4 or 5 intervals, at most six ticks). */
export function axis(min: number, max: number): Scale {
  const waste = (s: Scale) => (s.max - max + (min - s.min)) / (s.max - s.min || 1);
  const all = [4, 3, 5].map(n => niceScale(min, max, n)).filter(s => s.ticks.length <= 6);
  return all.reduce((best, s) => (waste(s) < waste(best) - 1e-9 ? s : best), all[0] ?? niceScale(min, max, 4));
}
export const maxTickWidth = (scale: Scale, unit: string, ko: boolean) => Math.max(...scale.ticks.map(t => tw(tick(t, unit, ko))));

/** Horizontal gridlines with their tick labels on the left (x = L - 6). `Y` maps a value to a y. */
export function yGrid(scale: Scale, Y: (v: number) => number, L: number, xEnd: number, unit: string, ko: boolean, side: "left" | "right" = "left", color?: string): string {
  return scale.ticks.map(t => {
    const y = Y(t);
    const line = side === "left" ? `<line x1="${L}" x2="${p(xEnd)}" y1="${p(y)}" y2="${p(y)}" stroke="${t === 0 && scale.min < 0 ? ZERO : GRID}"/>` : "";
    const x = side === "left" ? L - 6 : xEnd + 6;
    return `${line}<text x="${p(x)}" y="${p(y + 3.8)}" text-anchor="${side === "left" ? "end" : "start"}" class="a-ax"${color ? ` style="fill:${color}"` : ""}>${esc(tick(t, unit, ko))}</text>`;
  }).join("");
}

/** A bar from `yBase` to `yFar` with the far end rounded (r = 0 for a flat one). */
export function barPath(x: number, w: number, yFar: number, yBase: number, r: number): string {
  const h = Math.abs(yFar - yBase);
  if (h < 0.4) return "";
  const rr = Math.max(0, Math.min(r, w / 2, h)), d = yFar < yBase ? 1 : -1;
  return `M${p(x)},${p(yBase)}V${p(yFar + d * rr)}Q${p(x)},${p(yFar)} ${p(x + rr)},${p(yFar)}H${p(x + w - rr)}Q${p(x + w)},${p(yFar)} ${p(x + w)},${p(yFar + d * rr)}V${p(yBase)}Z`;
}

/** A path through `pts`: straight, or smooth through them without overshoot (monotone cubic). */
export function curve(pts: [number, number][], smooth?: boolean): string {
  const n = pts.length;
  if (!n) return "";
  if (!smooth || n < 3) return pts.map((q, i) => `${i ? "L" : "M"}${p(q[0])},${p(q[1])}`).join("");
  const m = pts.slice(1).map((q, i) => (q[1] - pts[i][1]) / (q[0] - pts[i][0])), t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (2 * m[i - 1] * m[i]) / (m[i - 1] + m[i]));
  t.push(m[n - 2]);
  let d = `M${p(pts[0][0])},${p(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) { const h = (pts[i + 1][0] - pts[i][0]) / 3; d += `C${p(pts[i][0] + h)},${p(pts[i][1] + t[i] * h)} ${p(pts[i + 1][0] - h)},${p(pts[i + 1][1] - t[i + 1] * h)} ${p(pts[i + 1][0])},${p(pts[i + 1][1])}`; }
  return d;
}
/** Consecutive non-null values as runs of [index, value]. */
export function runs(values: (number | null)[]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  values.forEach((v, i) => { if (v === null) { cur = null; return; } if (!cur) { cur = []; out.push(cur); } cur.push([i, v]); });
  return out;
}

export const svg = (W: number, H: number, inner: string) => `<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${inner}</svg>`;
export interface LegendItem { name: string; color: string; shape?: "box" | "line" | "dot" }
export const legend = (items: LegendItem[], clipTo = 30) => (items.length ? `<div class="a-lg">${items.map(s => `<span><i class="${s.shape === "line" ? "a-li" : s.shape === "dot" ? "a-do" : ""}" style="background:${s.color}"></i>${esc([...s.name].length > clipTo ? `${[...s.name].slice(0, clipTo - 1).join("")}…` : s.name)}</span>`).join("")}</div>` : "");
/** The block's heading, its drawing, an optional legend and an optional caption. */
export function frame(b: { title?: string; caption?: string }, inner: string, extra = ""): string {
  return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${inner}${extra}${b.caption ? `<p class="a-cap">${esc(b.caption)}</p>` : ""}`;
}

const BASE = "@ svg{max-width:640px}@ .a-ax{font-size:11px;font-weight:600;fill:#7a8682}@ .a-vl{font-size:10.5px;font-weight:700;fill:#34424a;paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round}@ .a-lg{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:12.5px;font-weight:650;color:#5c6870}@ .a-lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}@ .a-lg .a-li{width:16px;height:3px;border-radius:2px;vertical-align:3px}@ .a-lg .a-do{border-radius:50%}@ .a-cap{margin:8px 0 0;font-size:13px;line-height:19px;color:#5c6870}";
/** The asset's styles: the shared base plus `extra`; `@` stands for the asset's own selector prefix. */
export function css(type: string, extra = "", base = true): string {
  return `${base ? BASE : ""}${extra}`.replace(/@/g, `.fpc .a-${type}`);
}

/** A summary kept to what a listener needs (the registry cuts at 400). */
export const cap = (s: string, n = 380) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** One row of a horizontal ranking: a label, a track with a bar (or a stem and a dot) and the value. */
export interface HRow { label: string; value: number; hl: boolean; dim: boolean }
export function hRows(kind: "bar" | "lolli", rows: HRow[], unit: string, ko: boolean): string {
  const lo = Math.min(0, ...rows.map(r => r.value)), hi = Math.max(0, ...rows.map(r => r.value)), span = hi - lo || 1;
  const at = (v: number) => ((v - lo) / span) * 100, z = at(0);
  const body = rows.map(r => {
    const x = at(r.value), left = Math.min(z, x), width = Math.abs(x - z), neg = r.value < 0;
    const color = neg ? RED : r.dim ? GREY : BLUE;
    const mark = kind === "bar"
      ? `<i class="a-bar" style="left:${p(left)}%;width:${p(width)}%;background:${color}"></i>`
      : `<i class="a-bar" style="left:${p(left)}%;width:${p(width)}%"></i><i class="a-dot${r.hl ? " a-hl" : ""}" style="left:${p(x)}%;background:${neg ? RED : r.hl ? ORANGE : BLUE}"></i>`;
    return `<span class="a-n${r.hl ? " a-on" : ""}" title="${esc(r.label)}">${esc(r.label)}</span><span class="a-t">${lo < 0 ? `<u class="a-z" style="left:${p(z)}%"></u>` : ""}${mark}</span><b class="a-v${r.hl ? " a-on" : ""}">${esc(short(r.value, unit, ko))}</b>`;
  }).join("");
  return `<div class="a-hb a-k-${kind}">${body}</div>`;
}
/** Resolves a `highlight` (label or 0-based index) against the rows as given. */
export function pickHighlight(h: string | number | undefined, labels: string[]): number {
  if (h === undefined) return -1;
  if (typeof h === "number") return Number.isInteger(h) && h >= 0 && h < labels.length ? h : -1;
  const key = h.trim().toLowerCase(), at = labels.findIndex(l => l.trim().toLowerCase() === key);
  if (at >= 0) return at;
  const n = Number(key);
  return key !== "" && Number.isInteger(n) && n >= 0 && n < labels.length ? n : -1;
}
export const HROWS_CSS = "@ .a-cap{margin:10px 0 0;font-size:13px;line-height:19px;color:#5c6870}@ .a-hb{display:grid;grid-template-columns:minmax(72px,34%) minmax(0,1fr) auto;align-items:center;gap:9px 12px}@ .a-n{font-size:13px;font-weight:650;color:#34424a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@ .a-n.a-on,@ .a-v.a-on{color:#101d24;font-weight:800}@ .a-t{position:relative;height:14px}@ .a-v{font-size:13px;font-weight:750;text-align:right;min-width:44px;white-space:nowrap}@ .a-z{position:absolute;top:-3px;bottom:-3px;width:1px;background:#c9d0cc}@ .a-bar{position:absolute;top:0;bottom:0;border-radius:7px;min-width:3px}";

/** Labels along a point axis (x = X(i)): every k-th one, k from the widest label and the room, plus the last when it has the room; the ends stay inside [0, W]. */
export function pointLabels(labels: string[], X: (i: number) => number, W: number, y: number, size = 11): string {
  const n = labels.length, shown = labels.map(l => clipPx(l, 80, size)), maxW = Math.max(...shown.map(l => tw(l, size))) + 8;
  const step = n > 1 ? Math.abs(X(n - 1) - X(0)) / (n - 1) : 1000, k = Math.max(1, Math.ceil(maxW / step)), idx = new Set<number>();
  for (let i = 0; i < n; i += k) idx.add(i);
  if ((n - 1 - Math.max(...idx)) * step >= maxW) idx.add(n - 1);
  return [...idx].map(i => {
    const w = tw(shown[i], size), x = X(i), over = x + w / 2 > W, under = x - w / 2 < 0;
    return `<text x="${p(over ? W : under ? 0 : x)}" y="${y}" text-anchor="${over ? "end" : under ? "start" : "middle"}" class="a-ax">${esc(shown[i])}</text>`;
  }).join("");
}
export const nn = (v: number | null): v is number => v !== null;
