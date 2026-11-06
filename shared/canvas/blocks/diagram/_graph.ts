import { esc, labelWidth } from "../../kit";

/**
 * What the flow diagrams share (flow.ts, process.ts, board.ts): the card's colours as literals, text fitting, the SVG shell, arrowheads, and a
 * deterministic layered graph layout with orthogonal edge routing (longest-path layers, dummy vertices for long edges, barycentre ordering,
 * weighted-isotonic placement, one channel per bending edge). No randomness, no iteration to convergence: the same block draws the same picture.
 */
export type Pt = [number, number];
export const f = (v: number): number => Math.round(v * 10) / 10;

export const C = {
  ink: "#101d24", ink2: "#34424a", muted: "#5c6870", faint: "#9aa2a7", line: "#e7e8e5", edge: "#6b7882", soft: "#d3d9d6", surface: "#f7f8f7", white: "#fff",
  green: "#118558", green2: "#18b67e", red: "#cf3545", amber: "#b7791f", amber2: "#f0b429", blue: "#2f5fd6", blue2: "#7aa2ff",
  gT: "#e3f1eb", rT: "#f8e6e8", aT: "#fbf1de", bT: "#e7eefc", nT: "#eef0ee",
};
/** Fill, outline and text colour of a meaning: up good, down bad, warn caution, info blue, neutral grey. */
export const TONE: Record<string, { fill: string; stroke: string; ink: string }> = {
  up: { fill: C.gT, stroke: C.green2, ink: C.green }, down: { fill: C.rT, stroke: C.red, ink: C.red }, warn: { fill: C.aT, stroke: C.amber2, ink: C.amber },
  info: { fill: C.bT, stroke: C.blue2, ink: C.blue }, neutral: { fill: C.surface, stroke: C.soft, ink: C.muted },
};
/** Two hex colours mixed: t = 0 is a, t = 1 is b. */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map(i => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}
/** A blue that deepens along a sequence (steps of a process, a cycle). */
export const ramp = (i: number, n: number): string => mix("#4a7bea", "#1c3f9c", n <= 1 ? 0 : i / (n - 1));

/* ---------- text ---------- */
/** Rendered width of a label at `size` px (weight 650+ runs a little wider). */
export const tw = (s: string, size = 12.5, bold = false): number => Math.max(0, labelWidth(s) - 20) * (size / 12.5) * (bold ? 1.06 : 1);
export interface Wrapped { lines: string[]; width: number }
/** Wraps a label into at most `maxLines` lines no wider than `maxW`; what does not fit is cut with an ellipsis. */
export function wrap(value: string, maxW: number, maxLines: number, size = 12.5, bold = false): Wrapped {
  const w = (s: string) => tw(s, size, bold);
  const fitEnd = (s: string) => { if (w(s) <= maxW) return s; let out = ""; for (const ch of [...s]) { if (w(`${out}${ch}…`) > maxW) break; out += ch; } return `${out.trimEnd()}…`; };
  const pieces: string[] = [];
  for (const word of value.split(/\s+/).filter(Boolean)) {
    if (w(word) <= maxW) { pieces.push(word); continue; }
    let part = "";
    for (const ch of [...word]) { if (part && w(part + ch) > maxW) { pieces.push(part); part = ch; } else part += ch; }
    if (part) pieces.push(part);
  }
  let lines: string[] = [], cur = "";
  for (const piece of pieces) { const next = cur ? `${cur} ${piece}` : piece; if (!cur || w(next) <= maxW) cur = next; else { lines.push(cur); cur = piece; } }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) lines = [...lines.slice(0, maxLines - 1), fitEnd(`${lines.slice(maxLines - 1).join(" ")}…`)];
  if (!lines.length) lines = [""];
  return { lines, width: Math.max(...lines.map(w)) };
}
export interface TextOpts { size?: number; lh?: number; weight?: number; fill?: string; anchor?: "start" | "middle" | "end"; italic?: boolean; /** a white outline behind the glyphs, so a line passing under the text does not cut it */ halo?: boolean }
/** Lines of text centred vertically on `cy` (every string escaped). */
export function lines(ls: readonly string[], x: number, cy: number, o: TextOpts = {}): string {
  const size = o.size ?? 12.5, lh = o.lh ?? Math.round(size * 1.28), y0 = cy - ((ls.length - 1) * lh) / 2;
  return `<text text-anchor="${o.anchor ?? "middle"}" font-size="${size}" font-weight="${o.weight ?? 650}" fill="${o.fill ?? C.ink}"${o.italic ? ' font-style="italic"' : ""}${o.halo ? ' stroke="#fff" stroke-width="4" stroke-linejoin="round" paint-order="stroke"' : ""}>${ls.map((l, i) => `<tspan x="${f(x)}" y="${f(y0 + i * lh)}" dy=".35em">${esc(l)}</tspan>`).join("")}</text>`;
}
/** One short label on a rounded pill, centred on (x, y). Returns the markup and the pill's width. */
export function pill(x: number, y: number, label: string, o: { fill?: string; stroke?: string; ink?: string; size?: number; h?: number; maxW?: number } = {}): { svg: string; w: number; h: number } {
  const size = o.size ?? 11, h = o.h ?? 18, text = wrap(label, (o.maxW ?? 120) - 14, 1, size, true).lines[0], w = Math.max(h, tw(text, size, true) + 14);
  return { w, h, svg: `<rect x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${f(w)}" height="${h}" rx="${h / 2}" fill="${o.fill ?? C.white}" stroke="${o.stroke ?? C.soft}"/>${lines([text], x, y, { size, weight: 700, fill: o.ink ?? C.ink2 })}` };
}
const YES = /^(yes|y|true|ok|pass|passed|approved|accept|accepted|success|예|네|응|맞음|통과|승인|성공)$/i, NO = /^(no|n|false|fail|failed|reject|rejected|denied|error|아니오|아니요|아님|실패|거절|거부|반려)$/i;
/** Colour of an edge label: yes-like green, no-like red, anything else neutral. */
export function labelTone(label: string): { fill: string; stroke: string; ink: string } {
  const key = label.trim();
  return YES.test(key) ? { fill: C.gT, stroke: "#b9e0cf", ink: C.green } : NO.test(key) ? { fill: C.rT, stroke: "#efc4c9", ink: C.red } : { fill: C.white, stroke: C.soft, ink: C.ink2 };
}

/* ---------- SVG shell and strokes ---------- */
/** The drawing at its natural size, never wider than that, scrolling sideways instead of shrinking below ~72% (the text stays readable on a phone). */
export function shell(uid: string, w: number, h: number, defs: string, body: string): string {
  const max = Math.round(w), min = Math.round(Math.min(w, Math.max(w * 0.72, 380)));
  return `<div class="a-sc"><svg viewBox="0 0 ${f(w)} ${f(h)}" width="100%" aria-hidden="true" style="max-width:${max}px;min-width:${min}px">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg></div>`;
}
/** The css every SVG diagram needs (the shell scrolls, the drawing is centred); `type` is the asset's own name. */
export const shellCss = (type: string): string => `.fpc .a-${type} .a-sc{overflow-x:auto}.fpc .a-${type} svg{margin:0 auto}`;
export function arrow(id: string, color: string, open = false): string {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="${open ? 8.6 : 9}" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">${open ? `<path d="M1.6 1.6L8.6 5L1.6 8.4" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` : `<path d="M.6 1L9.6 5L.6 9Z" fill="${color}" stroke="${color}" stroke-width=".8" stroke-linejoin="round"/>`}</marker>`;
}
/** A polyline with its corners rounded (quadratic, radius r). Consecutive duplicate points are dropped. */
export function rounded(points: readonly Pt[], r = 9): string {
  const p: Pt[] = [];
  for (const q of points) { const l = p[p.length - 1]; if (!l || Math.abs(l[0] - q[0]) > 0.01 || Math.abs(l[1] - q[1]) > 0.01) p.push(q); }
  if (p.length < 2) return "";
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i], [x2, y2] = p[i + 1], l1 = Math.hypot(x1 - x0, y1 - y0), l2 = Math.hypot(x2 - x1, y2 - y1), rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.6 || Math.abs((x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1)) < 0.01) { d += `L${f(x1)},${f(y1)}`; continue; }
    d += `L${f(x1 - ((x1 - x0) / l1) * rr)},${f(y1 - ((y1 - y0) / l1) * rr)}Q${f(x1)},${f(y1)} ${f(x1 + ((x2 - x1) / l2) * rr)},${f(y1 + ((y2 - y1) / l2) * rr)}`;
  }
  const e = p[p.length - 1];
  return `${d}L${f(e[0])},${f(e[1])}`;
}
/** Where an edge's label sits: on the first segment near the source when it is long enough, else on the longest segment's middle. */
export function labelAt(pts: readonly Pt[], lw: number, lh: number, skipFirst = false): Pt | null {
  const segs = pts.slice(1).map((b, i) => { const a = pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]); return { a, b, len, horiz: Math.abs(b[1] - a[1]) <= Math.abs(b[0] - a[0]) }; }).filter(s => s.len > 0.5);
  if (!segs.length) return null;
  const ext = (s: { horiz: boolean }) => (s.horiz ? lw : lh);
  // an edge that shares its exit with a sibling is labelled further along, where the two have parted
  if (segs.length === 1) return [(segs[0].a[0] + segs[0].b[0]) / 2, (segs[0].a[1] + segs[0].b[1]) / 2];
  if (skipFirst && segs.length > 1) { const s = segs.slice(1).reduce((best, x) => (x.len > best.len ? x : best)); return [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]; }
  let pick = segs[0].len >= ext(segs[0]) + 10 ? 0 : -1;
  if (pick < 0) pick = segs.reduce((best, s, i) => (s.len > segs[best].len ? i : best), 0);
  const s = segs[pick], t = pick === 0 && s.len >= ext(s) + 10 ? Math.min(s.len / 2, ext(s) / 2 + 8) / s.len : 0.5;
  return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
}

export interface Box { x0: number; y0: number; x1: number; y1: number }
/** Positions for the labels of several edges: each on its own line, never over a node (`obstacles`) and never over another label; when the natural spot is taken, the nearest free point along the line. */
export function placeLabels(paths: readonly (readonly Pt[])[], sizes: readonly ({ w: number; h: number } | null)[], obstacles: readonly Box[], skipFirst: readonly boolean[] = []): (Pt | null)[] {
  const taken: Box[] = [], out: (Pt | null)[] = paths.map(() => null);
  const strokes = paths.map(pts => pts.slice(1).map((q, j): Box => { const p = pts[j]; return { x0: Math.min(p[0], q[0]) - 1.5, y0: Math.min(p[1], q[1]) - 1.5, x1: Math.max(p[0], q[0]) + 1.5, y1: Math.max(p[1], q[1]) + 1.5 }; }));
  paths.forEach((pts, i) => {
    const sz = sizes[i];
    if (!sz || pts.length < 2) return;
    const hw = sz.w / 2 + 3, hh = sz.h / 2 + 3, hit = (a: Pt, q: Box) => a[0] + hw > q.x0 && a[0] - hw < q.x1 && a[1] + hh > q.y0 && a[1] - hh < q.y1;
    const clear = (a: Pt) => !obstacles.some(q => hit(a, q)) && !taken.some(q => hit(a, q)), strict = (a: Pt) => clear(a) && !strokes.some((s, j) => j !== i && s.some(q => hit(a, q)));
    const base = labelAt(pts, sz.w, sz.h, skipFirst[i] ?? false);
    const search = (ok: (a: Pt) => boolean): Pt | null => {
      if (base && ok(base)) return base;
      let best: Pt | null = null, bestD = Infinity;
      pts.forEach((q, j) => {
        if (!j || !base) return;
        const p0 = pts[j - 1], len = Math.hypot(q[0] - p0[0], q[1] - p0[1]), steps = Math.max(1, Math.ceil(len / 6));
        for (let t = 0; t <= steps; t++) { const c: Pt = [p0[0] + ((q[0] - p0[0]) * t) / steps, p0[1] + ((q[1] - p0[1]) * t) / steps], d = Math.hypot(c[0] - base[0], c[1] - base[1]); if (d < bestD && ok(c)) { bestD = d; best = c; } }
      });
      return best;
    };
    const at = search(strict) ?? search(clear) ?? base;
    if (at) { taken.push({ x0: at[0] - sz.w / 2, y0: at[1] - sz.h / 2, x1: at[0] + sz.w / 2, y1: at[1] + sz.h / 2 }); out[i] = at; }
  });
  return out;
}

/* ---------- reading ids ---------- */
const key = (v: string) => v.trim().toLowerCase();
/** A lookup from what an edge names (an id, or failing that a label) to the index of its node; -1 when nothing matches. */
export function finder(items: readonly { id: string; label?: string }[]): (ref: string) => number {
  const byId = new Map<string, number>(), byLabel = new Map<string, number>();
  items.forEach((it, i) => { if (!byId.has(key(it.id))) byId.set(key(it.id), i); if (it.label && !byLabel.has(key(it.label))) byLabel.set(key(it.label), i); });
  return ref => byId.get(key(ref)) ?? byLabel.get(key(ref)) ?? -1;
}
/** The first of each id wins (a repeated id is dropped), so a node is never drawn twice. */
export function uniqueBy<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter(it => { const k = key(it.id); if (seen.has(k)) return false; seen.add(k); return true; });
}
export interface RawEdge { from: string; to: string; label?: string }
export interface Edge { from: number; to: number; label?: string }
/** Edges that name a node that is not there are ignored; a repeated pair keeps one edge (the labels joined when `join`); a self edge is kept only when `loops`. With no edges at all the nodes are chained in the order given. */
export function cleanEdges(count: number, raw: readonly RawEdge[], find: (ref: string) => number, o: { loops?: boolean; join?: boolean; chain?: boolean } = {}): Edge[] {
  const out: Edge[] = [], at = new Map<string, number>();
  for (const e of raw) {
    const a = find(e.from), b = find(e.to);
    if (a < 0 || b < 0 || (a === b && !o.loops)) continue;
    const k = `${a}>${b}`, seen = at.get(k);
    if (seen !== undefined) { if (o.join && e.label && out[seen].label !== e.label) out[seen].label = out[seen].label ? `${out[seen].label} / ${e.label}` : e.label; continue; }
    at.set(k, out.length); out.push({ from: a, to: b, label: e.label });
  }
  if (!out.length && o.chain !== false) for (let i = 0; i + 1 < count; i++) out.push({ from: i, to: i + 1 });
  return out;
}
/** A sentence of up to `max` characters from parts, cut at a word with an ellipsis. */
export function sentence(parts: readonly string[], max = 395): string {
  const s = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/* ---------- layered layout ---------- */
export interface LNode { w: number; h: number; diamond?: boolean; /** extra room on the positive side of the order axis (a self loop) */ loop?: number }
export interface LEdge { from: number; to: number; lw?: number; lh?: number }
export interface Rank { layer: number[]; rev: boolean[]; count: number; widest: number }
export interface Route { pts: Pt[]; label: Pt | null }
export interface Layout { pos: Pt[]; routes: Route[]; width: number; height: number }

/** Longest-path layers. A cycle is broken at the edge that closes it in depth-first order (that edge is `rev` and is drawn against the grain). */
export function rank(n: number, edges: readonly { from: number; to: number }[]): Rank {
  const out: number[][] = Array.from({ length: n }, () => []), indeg = new Array<number>(n).fill(0), rev = new Array<boolean>(edges.length).fill(false);
  edges.forEach((e, i) => { if (e.from !== e.to) { out[e.from].push(i); indeg[e.to]++; } });
  const state = new Array<number>(n).fill(0), roots = [...Array(n).keys()].filter(i => indeg[i] === 0);
  for (const r of [...roots, ...Array(n).keys()]) {
    if (state[r]) continue;
    const stack: [number, number][] = [[r, 0]]; state[r] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1], u = top[0];
      if (top[1] < out[u].length) { const ei = out[u][top[1]++], v = edges[ei].to; if (state[v] === 1) rev[ei] = true; else if (state[v] === 0) { state[v] = 1; stack.push([v, 0]); } }
      else { state[u] = 2; stack.pop(); }
    }
  }
  const layer = new Array<number>(n).fill(0), left = new Array<number>(n).fill(0), succ: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => { if (e.from === e.to) return; const a = rev[i] ? e.to : e.from, b = rev[i] ? e.from : e.to; succ[a].push(b); left[b]++; });
  const queue = [...Array(n).keys()].filter(i => left[i] === 0);
  for (let q = 0; q < queue.length; q++) { const u = queue[q]; for (const v of succ[u]) { layer[v] = Math.max(layer[v], layer[u] + 1); if (--left[v] === 0) queue.push(v); } }
  const count = n ? Math.max(...layer) + 1 : 0, per = new Array<number>(count).fill(0);
  layer.forEach(l => per[l]++);
  return { layer, rev, count, widest: Math.max(1, ...per) };
}

const DUMMY = 10, TRACK = 14;
/** Weighted placement: centres as close as possible to `want` (squared, weighted) while keeping the order and the minimum distances. */
function spread(want: readonly number[], weight: readonly number[], dist: readonly number[]): number[] {
  const n = want.length, off: number[] = [0];
  for (let i = 1; i < n; i++) off[i] = off[i - 1] + dist[i];
  const blocks: { sum: number; w: number; start: number; count: number }[] = [];
  for (let i = 0; i < n; i++) {
    const w = Math.max(0.01, weight[i]);
    blocks.push({ sum: (want[i] - off[i]) * w, w, start: i, count: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sum / a.w <= b.sum / b.w + 1e-9) break;
      a.sum += b.sum; a.w += b.w; a.count += b.count; blocks.pop();
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.count; k++) out.push(b.sum / b.w + off[b.start + k]);
  return out;
}

export function layout(nodes: readonly LNode[], edges: readonly LEdge[], rk: Rank, o: { dir: "tb" | "lr"; rankGap?: number; nodeGap?: number; margin?: number }): Layout {
  const tb = o.dir === "tb", rankGap = o.rankGap ?? 44, nodeGap = o.nodeGap ?? 28, margin = o.margin ?? 16, n = nodes.length, L = Math.max(1, rk.count);
  if (!n) return { pos: [], routes: [], width: margin * 2, height: margin * 2 };
  const er = nodes.map(nd => (tb ? nd.h : nd.w)), eo = nodes.map(nd => (tb ? nd.w : nd.h));
  const layerOf = [...rk.layer], real: number[] = nodes.map((_, i) => i), negE = eo.map(v => v / 2), posE = nodes.map((nd, i) => eo[i] / 2 + (nd.loop ?? 0));
  const chains: number[][] = [];
  edges.forEach((e, i) => {
    if (e.from === e.to) { chains.push([]); return; }
    const a = rk.rev[i] ? e.to : e.from, b = rk.rev[i] ? e.from : e.to, chain = [a];
    for (let k = rk.layer[a] + 1; k < rk.layer[b]; k++) { layerOf.push(k); real.push(-1); negE.push(DUMMY / 2); posE.push(DUMMY / 2); chain.push(layerOf.length - 1); }
    chain.push(b); chains.push(chain);
  });
  const V = layerOf.length, down: { to: number; w: number }[][] = Array.from({ length: V }, () => []), up: { to: number; w: number }[][] = Array.from({ length: V }, () => []);
  const primary = new Set<number>(), seenFrom = new Set<number>();
  edges.forEach((e, i) => { if (e.from !== e.to && !rk.rev[i] && !seenFrom.has(e.from)) { seenFrom.add(e.from); primary.add(i); } });
  chains.forEach((c, i) => { const w = rk.rev[i] ? 0.5 : primary.has(i) ? 3 : 1; for (let k = 0; k + 1 < c.length; k++) { down[c[k]].push({ to: c[k + 1], w }); up[c[k + 1]].push({ to: c[k], w }); } });

  // order inside each layer: breadth-first in edge order, then barycentre sweeps and adjacent swaps while they remove crossings
  let layers: number[][] = Array.from({ length: L }, () => []);
  const placed = new Array<boolean>(V).fill(false);
  for (let v = 0; v < V; v++) if (layerOf[v] === 0) { layers[0].push(v); placed[v] = true; }
  for (let k = 1; k < L; k++) {
    for (const p of layers[k - 1]) for (const d of down[p]) if (layerOf[d.to] === k && !placed[d.to]) { placed[d.to] = true; layers[k].push(d.to); }
    for (let v = 0; v < V; v++) if (layerOf[v] === k && !placed[v]) { placed[v] = true; layers[k].push(v); }
  }
  const idx = new Array<number>(V).fill(0), reindex = () => layers.forEach(l => l.forEach((v, i) => (idx[v] = i)));
  const crossings = () => {
    let c = 0;
    for (let k = 0; k + 1 < L; k++) {
      const es: [number, number][] = [];
      for (const v of layers[k]) for (const d of down[v]) es.push([idx[v], idx[d.to]]);
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) c++;
    }
    return c;
  };
  reindex();
  let best = layers.map(l => [...l]), bestC = crossings();
  for (let it = 0; it < 8 && bestC > 0; it++) {
    const downSweep = it % 2 === 0;
    for (let s = 0; s < L; s++) {
      const k = downSweep ? s : L - 1 - s, nb = downSweep ? up : down, bary = new Map<number, number>();
      layers[k].forEach((v, i) => bary.set(v, nb[v].length ? nb[v].reduce((a, d) => a + idx[d.to], 0) / nb[v].length : i));
      layers[k] = [...layers[k]].sort((a, b) => bary.get(a)! - bary.get(b)! || idx[a] - idx[b]);
      layers[k].forEach((v, i) => (idx[v] = i));
    }
    const c = crossings();
    if (c < bestC) { bestC = c; best = layers.map(l => [...l]); }
  }
  layers = best; reindex();
  for (let round = 0, improved = true; improved && round < 6 && bestC > 0; round++) {
    improved = false;
    for (let k = 0; k < L; k++) for (let i = 0; i + 1 < layers[k].length; i++) {
      const before = crossings();
      [layers[k][i], layers[k][i + 1]] = [layers[k][i + 1], layers[k][i]]; reindex();
      if (crossings() < before) improved = true; else { [layers[k][i], layers[k][i + 1]] = [layers[k][i + 1], layers[k][i]]; reindex(); }
    }
  }
  bestC = crossings();

  // the order axis: packed, then pulled towards the neighbours (the first edge of a node weighs most, so the main path runs straight)
  const gapOf = (a: number, b: number) => (real[a] >= 0 && real[b] >= 0 ? nodeGap : real[a] < 0 && real[b] < 0 ? 12 : 18);
  const distOf = (l: readonly number[]) => l.map((v, i) => (i === 0 ? 0 : posE[l[i - 1]] + negE[v] + gapOf(l[i - 1], v)));
  const pos = new Array<number>(V).fill(0);
  for (const l of layers) {
    if (!l.length) continue;
    const d = distOf(l); let x = 0;
    l.forEach((v, i) => { x = i === 0 ? negE[v] : x + d[i]; pos[v] = x; });
    const lo = Math.min(...l.map(v => pos[v] - negE[v])), hi = Math.max(...l.map(v => pos[v] + posE[v])), mid = (lo + hi) / 2;
    l.forEach(v => (pos[v] -= mid));
  }
  const pull = (k: number, from: typeof up) => {
    const l = layers[k], want: number[] = [], weight: number[] = [];
    for (const v of l) {
      const ns = from[v];
      if (real[v] < 0) { const both = [...up[v], ...down[v]]; want.push(both.reduce((a, d) => a + pos[d.to], 0) / Math.max(1, both.length)); weight.push(4); }
      else if (ns.length) { const sw = ns.reduce((a, d) => a + d.w, 0); want.push(ns.reduce((a, d) => a + d.w * pos[d.to], 0) / sw); weight.push(sw); }
      else { want.push(pos[v]); weight.push(0.05); }
    }
    spread(want, weight, distOf(l)).forEach((p, i) => (pos[l[i]] = p));
  };
  for (let it = 0; it < 6; it++) { for (let k = 1; k < L; k++) pull(k, up); for (let k = L - 2; k >= 0; k--) pull(k, down); }
  for (let k = 1; k < L; k++) pull(k, up);
  // straighten: the spine (each root followed along its first edges) runs dead straight, other single-parent chains under their parent when they can, and what is left gives way
  const spine = new Array<boolean>(V).fill(false);
  for (let r = 0; r < V; r++) if (!up[r].length) for (let v = r; v >= 0 && !spine[v]; v = down[v].find(d => d.w >= 3)?.to ?? -1) spine[v] = true;
  for (let k = 1; k < L; k++) {
    const l = layers[k], want: number[] = [], weight: number[] = [];
    for (const v of l) {
      const main = up[v].find(x => x.w >= 3)?.to ?? (up[v].length === 1 && (real[v] < 0 || down[up[v][0].to].length === 1) ? up[v][0].to : -1);
      want.push(main >= 0 ? pos[main] : pos[v]); weight.push(main >= 0 ? (spine[v] ? 1000 : 8) : 1);
    }
    spread(want, weight, distOf(l)).forEach((p, i) => (pos[l[i]] = p));
  }

  // ports: where each edge leaves its source and enters its target (the order-axis coordinate; a diamond may leave by a side vertex)
  type Out = { o: number; side: 0 | -1 | 1 };
  const outP: Out[] = chains.map(() => ({ o: 0, side: 0 })), inO = chains.map(() => 0);
  const outs: number[][] = nodes.map(() => []), ins: number[][] = nodes.map(() => []);
  chains.forEach((c, i) => { if (c.length > 1) { outs[c[0]].push(i); ins[c[c.length - 1]].push(i); } });
  // a port sits straight above or below where its edge goes, within 22 of the middle and at least 14 from its neighbours, so a straight edge stays straight
  const slotted = (u: number, items: number[], keyOf: (i: number) => number, put: (i: number, p: number) => void) => {
    const sorted = [...items].sort((a, b) => keyOf(a) - keyOf(b) || a - b), k = sorted.length, half = Math.max(0, Math.min(22, eo[u] / 2 - 8)), step = k > 1 ? Math.min(14, (2 * half) / (k - 1)) : 0;
    const want = sorted.map(i => Math.max(pos[u] - half, Math.min(pos[u] + half, keyOf(i)))), got = spread(want, want.map(() => 1), want.map((_, s) => (s === 0 ? 0 : step)));
    const lift = Math.max(0, pos[u] - half - got[0]) - Math.max(0, got[k - 1] - (pos[u] + half));
    sorted.forEach((i, s) => put(i, got[s] + lift));
  };
  nodes.forEach((nd, u) => {
    const nxt = (i: number) => pos[chains[i][1]], prv = (i: number) => pos[chains[i][chains[i].length - 2]];
    if (nd.diamond) {
      ins[u].forEach(i => (inO[i] = pos[u]));
      const sorted = [...outs[u]].sort((a, b) => nxt(a) - nxt(b) || a - b), l = layers[layerOf[u]];
      sorted.forEach(i => (outP[i] = { o: pos[u], side: 0 }));
      if (sorted.length >= 2) {
        const reach = eo[u] / 2 + 10, left = sorted.find(i => nxt(i) < pos[u] - reach), right = [...sorted].reverse().find(i => nxt(i) > pos[u] + reach);
        const clear = (i: number, s: -1 | 1) => l.every(e => real[e] < 0 || e === u || (s < 0 ? !(pos[e] < pos[u]) || pos[e] + posE[e] < nxt(i) - 8 : !(pos[e] > pos[u]) || pos[e] - negE[e] > nxt(i) + 8));
        if (left !== undefined && clear(left, -1)) outP[left] = { o: pos[u] - eo[u] / 2, side: -1 };
        if (right !== undefined && clear(right, 1)) outP[right] = { o: pos[u] + eo[u] / 2, side: 1 };
      }
    } else {
      slotted(u, outs[u], nxt, (i, p) => (outP[i] = { o: p, side: 0 }));
      slotted(u, ins[u], prv, (i, p) => (inO[i] = p));
    }
  });

  // one channel (track) per bending edge in each gap between two layers
  const gaps = Math.max(0, L - 1), tracks = new Map<string, number>(), segs: { g: number; lo: number; hi: number; key: string }[] = [], trackCount = new Array<number>(gaps).fill(0);
  const aOf = (i: number, j: number) => (j === 0 ? (outP[i].side === 0 ? outP[i].o : null) : pos[chains[i][j]]);
  const bOf = (i: number, j: number) => (j === chains[i].length - 2 ? inO[i] : pos[chains[i][j + 1]]);
  chains.forEach((c, i) => { for (let j = 0; j + 1 < c.length; j++) { const a = aOf(i, j), b = bOf(i, j); if (a !== null && Math.abs(a - b) > 0.5) segs.push({ g: layerOf[c[0]] + j, lo: Math.min(a, b), hi: Math.max(a, b), key: `${i}:${j}` }); } });
  for (let g = 0; g < gaps; g++) {
    const ends: number[] = [];
    for (const s of segs.filter(x => x.g === g).sort((a, b) => a.lo - b.lo || a.hi - b.hi)) {
      let t = ends.findIndex(e => e < s.lo - 6); if (t < 0) { t = ends.length; ends.push(0); }
      ends[t] = s.hi; tracks.set(s.key, t);
    }
    trackCount[g] = ends.length;
  }
  // the rank axis: layer thickness, then the gap after each layer (room for its channels and for the labels that sit on the first stretch)
  const thick = layers.map(l => Math.max(0, ...l.filter(v => real[v] >= 0).map(v => er[real[v]])));
  const firstOff = new Array<number>(gaps).fill(24), gapSize = new Array<number>(gaps).fill(rankGap);
  chains.forEach((c, i) => { if (c.length > 1 && edges[i].lw) { const g = layerOf[c[0]]; firstOff[g] = Math.max(firstOff[g], tb ? (edges[i].lh ?? 17) + 14 : (edges[i].lw ?? 0) + 24); } });
  for (let g = 0; g < gaps; g++) gapSize[g] = Math.max(rankGap, firstOff[g] + Math.max(0, trackCount[g] - 1) * TRACK + 22);
  const rr: number[] = [], top = margin; let at = top;
  for (let k = 0; k < L; k++) { at += k === 0 ? thick[0] / 2 : thick[k - 1] / 2 + gapSize[k - 1] + thick[k] / 2; rr.push(at); }
  const rb = (k: number) => rr[k] + thick[k] / 2, rt = (k: number) => rr[k] - thick[k] / 2;

  // routes (order axis, rank axis), then to the screen
  const lo = Math.min(...[...Array(V).keys()].map(v => pos[v] - negE[v])), hi = Math.max(...[...Array(V).keys()].map(v => pos[v] + posE[v])), shift = margin - lo;
  const toScreen = (p: Pt): Pt => (tb ? [p[0] + shift, p[1]] : [p[1], p[0] + shift]);
  const paths: Pt[][] = chains.map((c, i) => {
    if (c.length < 2) return [];
    const u = c[0], v = c[c.length - 1], L0 = layerOf[u], m = c.length - 1, sp = outP[i], pts: Pt[] = [sp.side === 0 ? [sp.o, rr[L0] + er[u] / 2] : [sp.o, rr[L0]]];
    for (let j = 0; j < m; j++) {
      const k = L0 + j, yEnd = j === m - 1 ? rr[k + 1] - er[v] / 2 : rt(k + 1), a = aOf(i, j);
      let target = bOf(i, j);
      if (j === m - 1 && a !== null && Math.abs(a - target) <= 3.2) target = a; // a jog of a pixel or two is not drawn: the edge lands straight, still on the node's side
      if (a === null) { pts.push([target, rr[L0]], [target, yEnd]); continue; }
      if (Math.abs(a - target) < 0.5) pts.push([target, yEnd]);
      else { const yc = rb(k) + firstOff[k] + (tracks.get(`${i}:${j}`) ?? 0) * TRACK; pts.push([a, yc], [target, yc], [target, yEnd]); }
    }
    return pts;
  });
  const screenPaths = paths.map(pts => pts.map(toScreen));
  const boxes: Box[] = [...Array(n).keys()].map(u => { const [x, y] = toScreen([pos[u], rr[layerOf[u]]]); return { x0: x - nodes[u].w / 2, y0: y - nodes[u].h / 2, x1: x + nodes[u].w / 2, y1: y + nodes[u].h / 2 }; });
  const labels = placeLabels(screenPaths, edges.map(e => (e.lw ? { w: e.lw, h: e.lh ?? 17 } : null)), boxes, chains.map((c, i) => c.length > 1 && outs[c[0]].filter(j => outP[j].side === outP[i].side).length > 1));
  const routes: Route[] = screenPaths.map((screen, i) => ({ pts: rk.rev[i] ? [...screen].reverse() : screen, label: labels[i] }));
  const span = hi - lo + margin * 2, depth = rr[L - 1] + thick[L - 1] / 2 + margin;
  return { pos: nodes.map((_, u) => toScreen([pos[u], rr[layerOf[u]]])), routes, width: tb ? span : depth, height: tb ? depth : span };
}

/** Two letters for a name's avatar ("Dana Lee" → DL, "Mina" → MI, "김민수" → 김민). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean), first = (s: string) => [...s][0] ?? "";
  return (parts.length > 1 ? first(parts[0]) + first(parts[1]) : [...(parts[0] ?? "")].slice(0, 2).join("")).toUpperCase();
}
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
