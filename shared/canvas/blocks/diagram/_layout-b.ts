import { z } from "zod";
import { esc } from "../../kit";
import { text } from "../../fields";

/**
 * Helpers of the structure / concept / system diagrams (structure.ts, concept.ts, system.ts): ink and hues as literals an SVG attribute can use,
 * a text-width estimate with wrapping and clipping, tolerant readers for model-written lists, and the small graph routines (cycle breaking,
 * longest-path layers) the layouts share. Everything here is deterministic and never throws on a dangling, duplicate or cyclic input.
 */

/** The card's own ink, hairlines and surfaces (the variables of `.fpc`, as literals). */
export const INK = "#101d24", INK2 = "#34424a", MUTED = "#5c6870", FAINT = "#9aa2a7", LINE = "#e7e8e5", EDGE = "#c9d0cc", SURFACE = "#f7f8f7", WHITE = "#fff";

/** One category hue: a solid for strokes and fills with white text, a soft tint for grounds, an edge for borders and an ink for text on the tint. */
export interface Hue { solid: string; soft: string; edge: string; ink: string }
export const HUES: readonly Hue[] = [
  { solid: "#2f5fd6", soft: "#e9effc", edge: "#bccdf5", ink: "#1f46a8" },
  { solid: "#118558", soft: "#e4f2ec", edge: "#acd8c4", ink: "#0b6a45" },
  { solid: "#e07b12", soft: "#fdf0df", edge: "#f4cd9a", ink: "#9a540a" },
  { solid: "#8b4fd8", soft: "#f1e9fc", edge: "#d3bbf3", ink: "#6a35b0" },
  { solid: "#d6336c", soft: "#fbe8ef", edge: "#f1b8cd", ink: "#a3214f" },
  { solid: "#4b5d68", soft: "#eef1f2", edge: "#ccd3d7", ink: "#34424a" },
];
export const hue = (i: number): Hue => HUES[((i % HUES.length) + HUES.length) % HUES.length];
export const BLUE = HUES[0], GREEN = HUES[1], ORANGE = HUES[2], VIOLET = HUES[3], PINK = HUES[4], SLATE = HUES[5];
/** Red and amber of the card, for the states that carry meaning (blocked, caution). */
export const RED: Hue = { solid: "#cf3545", soft: "#f8e6e8", edge: "#eab3b9", ink: "#a82434" };
export const AMBER: Hue = { solid: "#b7791f", soft: "#fbf1de", edge: "#efd29c", ink: "#8a5a12" };

/** Numbers in markup: one decimal at most, no trailing zero. */
export const n = (v: number) => String(Math.round(v * 10) / 10);

const WIDE = (code: number) => code >= 0x1100 && (code <= 0x11ff || (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xff00 && code <= 0xffef));
/** Rendered width of a label in px at the given size: Hangul and CJK take a full em, Latin about half; a little generous so text never leaves its box. */
export function tw(value: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of value) {
    if (WIDE(ch.codePointAt(0) ?? 0)) w += 1;
    else if ("iljI.,:;'|!".includes(ch)) w += 0.3;
    else if (" ftr()[]/-\"".includes(ch)) w += 0.4;
    else if ("mwMW@".includes(ch)) w += 0.88;
    else if (ch >= "A" && ch <= "Z") w += 0.68;
    else w += 0.57;
  }
  return w * size * (bold ? 1.07 : 1.02);
}
/** The text cut to a width with an ellipsis. */
export function fit(value: string, maxW: number, size: number, bold = false): string {
  if (tw(value, size, bold) <= maxW) return value;
  const chars = [...value];
  let k = chars.length;
  while (k > 1 && tw(`${chars.slice(0, k).join("").trimEnd()}…`, size, bold) > maxW) k--;
  return `${chars.slice(0, k).join("").trimEnd()}…`;
}
/** The text broken into at most `maxLines` lines no wider than `maxW` (words stay whole unless one alone is too wide); the rest is cut with an ellipsis. */
export function wrap(value: string, maxW: number, size: number, maxLines: number, bold = false): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur && tw(`${cur} ${word}`, size, bold) <= maxW) { cur = `${cur} ${word}`; continue; }
    if (!cur && tw(word, size, bold) <= maxW) { cur = word; continue; }
    if (cur) { lines.push(cur); cur = ""; }
    if (tw(word, size, bold) <= maxW) { cur = word; continue; }
    let rest = [...word];
    while (rest.length) {
      let k = rest.length;
      while (k > 1 && tw(rest.slice(0, k).join(""), size, bold) > maxW) k--;
      const piece = rest.slice(0, k).join("");
      rest = rest.slice(k);
      if (rest.length) lines.push(piece); else cur = piece;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    return [...head, fit(lines.slice(maxLines - 1).join(" "), maxW, size, bold)];
  }
  return lines.length ? lines : [""];
}
/** The widest line of a wrapped block. */
export const widest = (lines: string[], size: number, bold = false) => Math.max(0, ...lines.map(l => tw(l, size, bold)));

export interface TextStyle { size?: number; weight?: number; fill?: string; anchor?: "start" | "middle" | "end"; lh?: number; italic?: boolean; opacity?: number; spacing?: number }
/** SVG text of one or more lines, the block vertically centred on `yc`. Lines are escaped here. */
export function txt(x: number, yc: number, lines: string[], s: TextStyle = {}): string {
  if (!lines.length) return "";
  const size = s.size ?? 12, lh = s.lh ?? Math.round(size * 1.3), first = yc - ((lines.length - 1) * lh) / 2 + size * 0.35;
  const attrs = `font-size="${size}" font-weight="${s.weight ?? 600}" fill="${s.fill ?? INK}"${s.anchor && s.anchor !== "start" ? ` text-anchor="${s.anchor}"` : ""}${s.italic ? ' font-style="italic"' : ""}${s.opacity !== undefined ? ` fill-opacity="${s.opacity}"` : ""}${s.spacing ? ` letter-spacing="${s.spacing}"` : ""}`;
  return `<text ${attrs}>${lines.map((l, i) => `<tspan x="${n(x)}" ${i ? `dy="${lh}"` : `y="${n(first)}"`}>${esc(l)}</tspan>`).join("")}</text>`;
}

/** The figure's wrapper: heading, then an SVG that scales with the card but never grows past its own drawn size. */
export function svg(w: number, h: number, inner: string, o: { title?: string; defs?: string; maxW?: number } = {}): string {
  const W = Math.ceil(w), H = Math.ceil(h);
  return `${o.title ? `<div class="sec">${esc(o.title)}</div>` : ""}<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${Math.round(o.maxW ?? W)}px" aria-hidden="true">${o.defs ? `<defs>${o.defs}</defs>` : ""}${inner}</svg>`;
}
/** CSS every diagram shares (centred, never wider than its drawing). Each asset appends its own to this under its own selector. */
export const baseCss = (type: string) => `.fpc .a-${type} svg{margin:0 auto}`;

/** The first letters of a name for an avatar: two for a Latin name, one for a Korean one. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = [...(words[0] ?? "")][0] ?? "?";
  if (WIDE(first.codePointAt(0) ?? 0)) return first;
  const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return `${first}${last ?? ""}`.toUpperCase();
}

/* ---------------------------------------------------------------- tolerant readers */

export const pick = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]; return undefined; };
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** An object whose keys may arrive under other names (`reports_to` for `parent`): the first present alias fills the missing key. */
export const aliased = <S extends z.ZodRawShape>(shape: S, aliases: Record<string, string[]>) => z.preprocess(v => {
  if (!isObj(v)) return v;
  const o: Record<string, unknown> = { ...v };
  for (const [key, alts] of Object.entries(aliases)) if (o[key] === undefined || o[key] === null || o[key] === "") { const found = pick(o, alts); if (found !== undefined) o[key] = found; }
  return o;
}, z.object(shape).strip());
/** A label written as a bare string or as an object with the text under label, name, text or title. */
export const labelled = (max: number) => z.preprocess(v => (isObj(v) ? pick(v, ["label", "name", "text", "title", "value"]) : v), text(max));
/** A list of ids written as an array, one string or "a, b". Never refused; blanks dropped. */
export const idList = (max: number) => z.preprocess(v => {
  const a = typeof v === "string" ? v.split(/[,;]/) : Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
  return a.map(x => (typeof x === "number" ? String(x) : x)).filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, max);
}, z.array(text(32)));
/** A number in 0..100, read from "40", "40%" or 0.4 written as a fraction when everything else is small; clamped. */
export const percent = z.preprocess(v => (typeof v === "string" ? Number(v.replace(/[%\s,]/g, "")) : v), z.number().finite().transform(v => Math.max(0, Math.min(100, v))));

/** Case-insensitive lookup key of an id or a name. */
export const keyOf = (value: string) => value.trim().toLowerCase();

/* ---------------------------------------------------------------- graph routines */

/**
 * Edges as [from, to] index pairs, with every edge that closes a cycle removed: a depth-first walk from node 0, 1, 2 ... following edges in
 * the order given; an edge to a node still on the walk's stack is dropped. Self edges and repeats are dropped too. Deterministic.
 */
export function acyclic(count: number, edges: ReadonlyArray<readonly [number, number]>): [number, number][] {
  const out: number[][] = Array.from({ length: count }, () => []);
  const seen = new Set<string>();
  for (const [a, b] of edges) { if (a === b || a < 0 || b < 0 || a >= count || b >= count || seen.has(`${a}>${b}`)) continue; seen.add(`${a}>${b}`); out[a].push(b); }
  const state = new Array<number>(count).fill(0), kept: [number, number][] = [];
  for (let s = 0; s < count; s++) {
    if (state[s]) continue;
    const stack: [number, number][] = [[s, 0]];
    state[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1], [v, i] = top;
      if (i >= out[v].length) { state[v] = 2; stack.pop(); continue; }
      top[1]++;
      const w = out[v][i];
      if (state[w] === 1) continue; // back edge: closes a cycle
      kept.push([v, w]);
      if (state[w] === 0) { state[w] = 1; stack.push([w, 0]); }
    }
  }
  return kept.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** Longest-path layers of a DAG: sources are layer 0; every node sits one layer right of its deepest predecessor. */
export function layersOf(count: number, edges: ReadonlyArray<readonly [number, number]>): number[] {
  const preds: number[][] = Array.from({ length: count }, () => []);
  for (const [a, b] of edges) preds[b].push(a);
  const layer = new Array<number>(count).fill(-1);
  const visit = (v: number): number => {
    if (layer[v] >= 0) return layer[v];
    layer[v] = 0; // guards a cycle that slipped in: treated as already placed
    let d = 0;
    for (const p of preds[v]) d = Math.max(d, visit(p) + 1);
    layer[v] = d;
    return d;
  };
  for (let v = 0; v < count; v++) visit(v);
  return layer;
}

/** A list that is always an array: a lone value becomes one entry, a missing one none; entries past `max` are dropped. */
export const optList = <T extends z.ZodTypeAny>(item: T, max: number) => z.preprocess(v => (Array.isArray(v) ? v.slice(0, max) : v === null || v === undefined || v === "" ? [] : [v]), z.array(item));

/** A polyline as a path with every corner rounded by up to `r` (never more than half of either segment). */
export function roundedPath(pts: ReadonlyArray<readonly [number, number]>, r = 8): string {
  if (pts.length < 2) return "";
  let d = `M${n(pts[0][0])},${n(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(cx - px, cy - py), l2 = Math.hypot(nx - cx, ny - cy), rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.5) { d += `L${n(cx)},${n(cy)}`; continue; }
    d += `L${n(cx + ((px - cx) / l1) * rr)},${n(cy + ((py - cy) / l1) * rr)}Q${n(cx)},${n(cy)} ${n(cx + ((nx - cx) / l2) * rr)},${n(cy + ((ny - cy) / l2) * rr)}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${n(last[0])},${n(last[1])}`;
}

/** Positions nearest to the wanted centres that keep their order and leave at least `sep[k]` between neighbour k-1 and k (pool-adjacent-violators). */
export function settle(want: number[], sep: number[]): number[] {
  const cum: number[] = []; let acc = 0;
  want.forEach((_, k) => { acc += k ? sep[k] : 0; cum.push(acc); });
  const blocks: { sum: number; count: number }[] = [];
  want.forEach((w, k) => {
    blocks.push({ sum: w - cum[k], count: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].count > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].count) {
      const top = blocks.pop() as { sum: number; count: number }, prev = blocks[blocks.length - 1];
      prev.sum += top.sum; prev.count += top.count;
    }
  });
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.count; i++) out.push(b.sum / b.count + cum[out.length]);
  return out;
}

/**
 * Finds an entry by the id or name another field wrote for it: case-insensitive, and tolerant of a text that was cut with an ellipsis at a
 * different length in the two fields. `entries` are [text, index] in priority order (ids before names); returns the index or -1.
 */
export function resolver(entries: ReadonlyArray<readonly [string, number]>): (ref: string) => number {
  const norm = (s: string) => keyOf(s).replace(/…$/, "").trim();
  const keys = entries.map(([t]) => norm(t));
  return (ref: string) => {
    const r = norm(ref);
    let i = keys.indexOf(r);
    if (i < 0 && r.length >= 8) i = keys.findIndex(k => k.length >= 8 && (k.startsWith(r) || r.startsWith(k)));
    return i < 0 ? -1 : entries[i][1];
  };
}
