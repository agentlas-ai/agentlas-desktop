import { CURRENCY, LINE_COLORS, PALETTE, canvasFormat, compact, esc, niceScale } from "../../kit";

/**
 * Helpers the part-to-whole, statistical and progress charts (parts.ts, stats.ts, specials.ts) share: the categorical fills, colour maths,
 * number formats for tight places, text fitting, arcs and the pieces of markup every one of them repeats. Nothing here draws a whole chart.
 */

/** Categorical fills in reading order: the four series hues first, then the rest of the card palette. */
export const CAT: readonly string[] = [LINE_COLORS[0], LINE_COLORS[2], LINE_COLORS[1], LINE_COLORS[3], PALETTE[2], PALETTE[10], PALETTE[6], PALETTE[7], PALETTE[4], PALETTE[0], PALETTE[8], PALETTE[11]];
export const catColor = (i: number) => CAT[((i % CAT.length) + CAT.length) % CAT.length];
export const REST = "#e3e7e4";
/** The same fills without the near-black one (for marks that stand for nodes, where black would read as a total). */
export const catSoft = (i: number) => { const soft = CAT.filter(c => c !== PALETTE[0]); return soft[((i % soft.length) + soft.length) % soft.length]; };

export const sum = (values: readonly number[]) => values.reduce((s, v) => s + v, 0);
/** A coordinate with at most one decimal, never NaN. */
export const n1 = (v: number) => (Number.isFinite(v) ? String(+v.toFixed(1)) : "0");
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---- colour -------------------------------------------------------------------------------------------------------------------------
const rgb = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const channel = (n: number) => { const c = n / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** A colour t of the way from a to b (both #rrggbb). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * clamp(t, 0, 1)).toString(16).padStart(2, "0")).join("")}`;
}
/** The text colour that reads best on a fill: white or the card's ink, whichever has the higher contrast. */
export function onFill(hex: string): string {
  const [r, g, b] = rgb(hex), lum = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.061 ? "#fff" : "#101d24";
}

// ---- numbers ------------------------------------------------------------------------------------------------------------------------
/** A number with its unit, for a legend or a row (room to spare). */
export const fmt = (v: number, unit: string, ko: boolean) => canvasFormat(v, unit, ko);
/** The same for an axis tick or a label inside a drawing: the short form of the unit. */
export function short(v: number, unit: string, ko: boolean): string {
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  if (unit === "percent") return `${sign}${+a.toFixed(a < 10 ? 1 : 0)}%`;
  if (unit === "x") return `${+v.toFixed(1)}×`;
  if (unit === "krw" && ko) return canvasFormat(v, unit, ko);
  if (unit in CURRENCY) return `${sign}${CURRENCY[unit]}${compact(a)}`;
  if (unit === "usd_per_share" || unit === "bp") return canvasFormat(v, unit, ko);
  return compact(v);
}
/** A share (0..1) as a percent: one decimal under 10%, "<1%" for a sliver. */
export function pct(share: number): string {
  const v = share * 100;
  if (!(v > 0)) return "0%";
  if (v < 1) return "<1%";
  return `${v < 9.95 ? v.toFixed(1) : Math.round(v)}%`;
}

// ---- text ---------------------------------------------------------------------------------------------------------------------------
const WIDE = /[ᄀ-ᇿ　-鿿가-힣＀-￯]/;
/** Rough width in px of a label at a font size: Hangul counts a full em, narrow Latin letters a third, capitals more. */
export function textPx(value: string, size = 12, weight = 650): number {
  const bump = weight >= 700 ? 1.06 : 1;
  return [...value].reduce((w, c) => w + (WIDE.test(c) ? 1 : /[il.,:;'|!]/.test(c) ? 0.28 : /[ft1 ]/.test(c) ? 0.36 : /[mwMW]/.test(c) ? 0.86 : /[A-Z0-9%$&]/.test(c) ? 0.64 : 0.55) * bump, 0) * size;
}
/** The label cut with an ellipsis so it fits `px` at the size. */
export function fit(value: string, px: number, size = 12, weight = 650): string {
  if (textPx(value, size, weight) <= px) return value;
  let out = "";
  for (const c of [...value]) { if (textPx(`${out}${c}…`, size, weight) > px) break; out += c; }
  return out.trim() ? `${out.trimEnd()}…` : "…";
}

// ---- geometry -----------------------------------------------------------------------------------------------------------------------
/** A point on a circle: angle in radians, 0 at 12 o'clock and growing clockwise. */
export const polar = (cx: number, cy: number, r: number, a: number): [number, number] => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
/** A pie slice (r0 = 0) or a ring segment from angle a0 to a1. */
export function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const full = a1 - a0 >= Math.PI * 2 - 1e-4, end = full ? a0 + Math.PI * 2 - 1e-4 : a1, big = end - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, r1, a0), [x1, y1] = polar(cx, cy, r1, end);
  if (r0 <= 0) return `M${n1(cx)},${n1(cy)}L${n1(x0)},${n1(y0)}A${n1(r1)},${n1(r1)} 0 ${big} 1 ${n1(x1)},${n1(y1)}Z`;
  const [x2, y2] = polar(cx, cy, r0, end), [x3, y3] = polar(cx, cy, r0, a0);
  return `M${n1(x0)},${n1(y0)}A${n1(r1)},${n1(r1)} 0 ${big} 1 ${n1(x1)},${n1(y1)}L${n1(x2)},${n1(y2)}A${n1(r0)},${n1(r0)} 0 ${big} 0 ${n1(x3)},${n1(y3)}Z`;
}
/** An open arc (a ring stroke) from a0 to a1. */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const end = Math.min(a1, a0 + Math.PI * 2 - 1e-4), big = end - a0 > Math.PI ? 1 : 0, [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, end);
  return `M${n1(x0)},${n1(y0)}A${n1(r)},${n1(r)} 0 ${big} 1 ${n1(x1)},${n1(y1)}`;
}

/** Whole cells for each share so that they add up to `total` (largest remainder). */
export function wholeCells(shares: readonly number[], total: number): number[] {
  const raw = shares.map(s => s * total), base = raw.map(Math.floor);
  let left = total - sum(base);
  raw.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i).forEach(({ i }) => { if (left > 0) { base[i]++; left--; } });
  return base;
}

// ---- labels next to marks, trend ---------------------------------------------------------------------------------------------------------
export interface Box { x0: number; y0: number; x1: number; y1: number }
const hit = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
export interface Placed { i: number; x: number; y: number; anchor: "start" | "end" | "middle" }
/** Puts a label beside each mark that has one (right, left, above, then below) wherever it touches no mark and no earlier label and stays inside `area`; a label with no free spot is left out. */
export function placeLabels(marks: readonly { x: number; y: number; r: number; text?: string }[], area: { l: number; t: number; r: number; b: number }, max = 16, size = 10.5, avoid: readonly Box[] = []): Placed[] {
  const boxes: Box[] = [...marks.map(m => ({ x0: m.x - m.r, y0: m.y - m.r, x1: m.x + m.r, y1: m.y + m.r })), ...avoid], out: Placed[] = [], h = size + 3;
  for (let i = 0; i < marks.length && out.length < max; i++) {
    const m = marks[i];
    if (!m.text) continue;
    const w = textPx(m.text, size, 650) + 3;
    const spots: (Box & { x: number; anchor: Placed["anchor"]; y: number })[] = [
      { x: m.x + m.r + 4, y: m.y, anchor: "start", x0: m.x + m.r + 3, x1: m.x + m.r + 4 + w, y0: m.y - h / 2, y1: m.y + h / 2 },
      { x: m.x - m.r - 4, y: m.y, anchor: "end", x0: m.x - m.r - 4 - w, x1: m.x - m.r - 3, y0: m.y - h / 2, y1: m.y + h / 2 },
      { x: m.x, y: m.y - m.r - 3 - h / 2, anchor: "middle", x0: m.x - w / 2, x1: m.x + w / 2, y0: m.y - m.r - 3 - h, y1: m.y - m.r - 3 },
      { x: m.x, y: m.y + m.r + 3 + h / 2, anchor: "middle", x0: m.x - w / 2, x1: m.x + w / 2, y0: m.y + m.r + 3, y1: m.y + m.r + 3 + h },
    ];
    const spot = spots.find(s => s.x0 >= area.l && s.x1 <= area.r && s.y0 >= area.t && s.y1 <= area.b && !boxes.some(b => hit(s, b)));
    if (spot) { boxes.push(spot); out.push({ i, x: spot.x, y: spot.y, anchor: spot.anchor }); }
  }
  return out;
}
/** Boxes along a line segment (px), for labels to keep clear of it. */
export function lineBoxes(x1: number, y1: number, x2: number, y2: number, half = 4): Box[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 6));
  return Array.from({ length: steps + 1 }, (_, i) => { const x = x1 + ((x2 - x1) * i) / steps, y = y1 + ((y2 - y1) * i) / steps; return { x0: x - half, y0: y - half, x1: x + half, y1: y + half }; });
}
/** The most decimals (up to 2) any of the values is written with. */
export const decimals = (values: readonly number[]) => Math.min(2, Math.max(0, ...values.map(v => { const s = String(+v.toFixed(2)), i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; })));
/** Least-squares line through the points and its R², or null when x does not vary. */
export function regress(points: readonly { x: number; y: number }[]): { slope: number; intercept: number; r2: number } | null {
  const n = points.length, mx = sum(points.map(p => p.x)) / n, my = sum(points.map(p => p.y)) / n;
  const sxx = sum(points.map(p => (p.x - mx) ** 2)), syy = sum(points.map(p => (p.y - my) ** 2)), sxy = sum(points.map(p => (p.x - mx) * (p.y - my)));
  if (!(sxx > 0)) return null;
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 1 };
}

// ---- axes ---------------------------------------------------------------------------------------------------------------------------
type Scale = ReturnType<typeof niceScale>;
export interface AxisKit { X(v: number): number; Y(v: number): number; svg: string; plot: { l: number; t: number; r: number; b: number } }
/** Gridlines, tick labels and axis titles of a two-axis plot; returns the maps from data to drawing and the markup (draw it first, the marks after). `pad` keeps marks that sit on an edge (a bubble) inside the plot. */
export function plotAxes(o: { W: number; H: number; xs: Scale; ys: Scale; xFmt(v: number): string; yFmt(v: number): string; xTitle?: string; yTitle?: string; pad?: number; top?: number; right?: number }): AxisKit {
  const { W, H, xs, ys } = o, pad = o.pad ?? 0, T = o.top ?? 10, R = o.right ?? 14, B = 22 + (o.xTitle ? 18 : 0);
  const L = 8 + (o.yTitle ? 16 : 0) + Math.max(...ys.ticks.map(t => textPx(o.yFmt(t), 11, 600))) + 6;
  const X = (v: number) => L + pad + ((v - xs.min) / (xs.max - xs.min)) * (W - L - R - 2 * pad), Y = (v: number) => H - B - pad - ((v - ys.min) / (ys.max - ys.min)) * (H - T - B - 2 * pad);
  const grid = ys.ticks.map(t => `<line x1="${n1(L)}" x2="${n1(W - R)}" y1="${n1(Y(t))}" y2="${n1(Y(t))}" stroke="${t === ys.min ? "#cfd6d2" : "#e7e8e5"}"/><text x="${n1(L - 6)}" y="${n1(Y(t) + 3.8)}" text-anchor="end" class="a-ax">${esc(o.yFmt(t))}</text>`).join("")
    + xs.ticks.map(t => `<line x1="${n1(X(t))}" x2="${n1(X(t))}" y1="${n1(T)}" y2="${n1(H - B)}" stroke="#f1f2f0"/><text x="${n1(X(t))}" y="${n1(H - B + 15)}" text-anchor="middle" class="a-ax">${esc(o.xFmt(t))}</text>`).join("");
  const titles = (o.xTitle ? `<text x="${n1((L + W - R) / 2)}" y="${H - 3}" text-anchor="middle" class="a-tx">${esc(fit(o.xTitle, W - L - R, 11.5))}</text>` : "")
    + (o.yTitle ? `<text transform="rotate(-90 11 ${n1((T + H - B) / 2)})" x="11" y="${n1((T + H - B) / 2)}" text-anchor="middle" class="a-tx">${esc(fit(o.yTitle, H - T - B, 11.5))}</text>` : "");
  return { X, Y, svg: `${grid}${titles}`, plot: { l: L, t: T, r: W - R, b: H - B } };
}

// ---- markup the charts repeat ---------------------------------------------------------------------------------------------------------
export const heading = (b: { title?: string }) => (b.title ? `<div class="sec">${esc(b.title)}</div>` : "");
export const caption = (b: { caption?: string }) => (b.caption ? `<p class="a-cap">${esc(b.caption)}</p>` : "");
/** A row of colour keys (HTML, so it wraps and stays legible on a phone). */
export const legendRow = (items: readonly { label: string; color: string }[], max = 8, extra = "") => (items.length || extra ? `<div class="a-lg">${items.slice(0, max).map(i => `<span><i style="background:${i.color}"></i>${esc(fit(i.label, 150, 12.5))}</span>`).join("")}${extra}</div>` : "");
/** One legend line: swatch, label, a value and a share (a four-column grid; the label is cut, never wrapped). */
export const legendItem = (color: string, label: string, value: string, share: string) => `<li><i style="background:${color}"></i><span class="a-ln">${esc(label)}</span><b>${esc(value)}</b><em>${esc(share)}</em></li>`;

/** The css pieces every chart here repeats, scoped to the asset: only the parts named in `use` (ax tick text, tx label text, mu small muted text, lg colour keys, cap caption) are written, then the asset's own `extra`. */
export function css(type: string, extra = "", use = "ax tx mu lg cap"): string {
  const p = `.fpc .a-${type}`, has = (k: string) => use.split(" ").includes(k);
  return `${p} svg{max-width:640px}${has("ax") ? `${p} .a-ax{font-size:11px;font-weight:600;fill:var(--faint)}` : ""}${has("tx") ? `${p} .a-tx{font-size:11.5px;font-weight:650;fill:var(--ink2)}` : ""}${has("mu") ? `${p} .a-mu{font-size:10.5px;font-weight:650;fill:var(--muted)}` : ""}`
    + (has("lg") ? `${p} .a-lg{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:12.5px;font-weight:650;color:var(--muted)}${p} .a-lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}` : "")
    + (has("cap") ? `${p} .a-cap{margin:10px 0 0;font-size:13px;line-height:19px;color:var(--muted)}` : "") + extra;
}
/** The css of a legend list (swatch, label, value, share) under an asset. */
export const listCss = (type: string) => {
  const p = `.fpc .a-${type} .a-ll`;
  return `${p}{list-style:none;margin:0;padding:0;display:grid;gap:8px;min-width:0}${p} li{display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;gap:8px;align-items:center;font-size:13px;color:var(--ink2)}${p} i{width:10px;height:10px;border-radius:3px}${p} .a-ln{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}${p} b{font-weight:780;color:var(--ink)}${p} em{font-style:normal;text-align:right;min-width:36px;font-weight:650;color:var(--muted)}${p} em:empty{display:none}`;
};
