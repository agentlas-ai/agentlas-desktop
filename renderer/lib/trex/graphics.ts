// T-rex SVG 인포그래픽 에셋 라이브러리 — 결정적 벡터(차트·다이어그램·플로우).
//
// 왜 SVG 문자열인가:
//  - viewBox 스케일이라 판형/해상도 독립적(슬라이드 cqw 시스템과 동일 철학). 어떤 크기로 내보내도 선명.
//  - 색은 JS에서 실제 hex로 계산해 attribute에 박는다 — SVG presentation attr의 var()/color-mix는
//    모바일 브라우저에서 조용히 실패하는 함정이 있어(과거 전면 blank 사고), 어느 브라우저든 확실히 렌더.
//  - 다크 면 위 글자는 textOn(bg) 자동 대비(휘도<0.5면 흰색)로 "도형 안 글자 안 보임" 방지.
//  팔레트는 dna(accent/accent2/ink)에서 유도 → 유파/팔레트를 바꾸면 에셋도 그 색으로 재색칠된다.

import type { StyleDna } from "./styles";

// ── 팔레트 ──────────────────────────────────────────────────────────
export interface Pal {
  A: string; A2: string; INK: string; MU: string; FA: string; HL: string; BAND: string; SURF: string; MONO: string;
}

const TAU = Math.PI * 2;
function hx(h: string): [number, number, number] { const c = h.replace("#", ""); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
function toHex(r: number[]): string { return "#" + r.map((v) => ("0" + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2)).join(""); }
function mix(a: string, b: string, t: number): string { const x = hx(a), y = hx(b); return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]); }
function rgba(h: string, al: number): string { const c = hx(h); return `rgba(${c[0]},${c[1]},${c[2]},${al})`; }
function lum(hex: string): number { const c = hx(hex); const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }

/** dna → 에셋 팔레트. accent2 없으면 accent를 잉크로 살짝 어둡게. surface는 항상 흰색(모피즘 카드). */
export function palOf(dna?: StyleDna | null, accentFallback = "#1B64C2", inkFallback = "#15181D"): Pal {
  const A = dna?.accent ?? accentFallback;
  const INK = dna?.ink ?? inkFallback;
  const A2 = dna?.accent2 ?? mix(A, INK, 0.42);
  return {
    A, A2, INK,
    MU: mix(INK, "#FFFFFF", 0.42), // muted(부속 라벨)
    FA: mix(INK, "#FFFFFF", 0.9), // faint(그리드선)
    HL: mix(A, "#FFFFFF", 0.72), // highlight tint
    BAND: A2, // 다크 밴드/승자 패널
    SURF: "#FFFFFF",
    MONO: dna?.monoFont ?? "ui-monospace, SFMono-Regular, Menlo, monospace",
  };
}

// ── 모듈 스코프 팔레트(렌더 1회는 동기 실행이라 안전) ──────────────────
let A = "#1B64C2", A2 = "#0B3675", INK = "#15181D", MU = "#5A6472", FA = "#E6EAF0", HL = "#Bcd", BAND = "#0B3675", SURF = "#FFFFFF", MONO = "monospace";
function setPal(p: Pal) { A = p.A; A2 = p.A2; INK = p.INK; MU = p.MU; FA = p.FA; HL = p.HL; BAND = p.BAND; SURF = p.SURF; MONO = p.MONO; }
function tintL(k: number) { return mix(A, "#FFFFFF", k); }
function shadeL(k: number) { return mix(A, INK, k); }
function shadeAt(i: number, n: number) { return mix(tintL(0.3), shadeL(0.32), n > 1 ? i / (n - 1) : 0); }
function textOn(bg: string) { return lum(bg) < 0.5 ? "#fff" : INK; }

let _uid = 0;
function uid(pfx: string) { return pfx + ++_uid; } // 결정적 카운터(Math.random 배제)
function shorten(t: string | undefined, n: number): string { const s = (t || "").trim(); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s; }

// ── SVG 헬퍼 ────────────────────────────────────────────────────────
function el(inner: string, w: number, h: number, defs?: string): string {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%" style="display:block;overflow:visible" role="img">${defs ? "<defs>" + defs + "</defs>" : ""}${inner}</svg>`;
}
interface TxtOpts { s?: number; w?: number; f?: string; a?: string; mono?: boolean; ls?: string; }
function txt(x: number, y: number, s: string | number, o: TxtOpts = {}): string {
  return `<text x="${x}" y="${y}" font-size="${o.s || 10}" font-weight="${o.w || 600}" fill="${o.f || INK}" text-anchor="${o.a || "start"}"${o.mono ? ` font-family="${MONO}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""} style="font-variant-numeric:tabular-nums">${s}</text>`;
}
function pol(cx: number, cy: number, r: number, a: number): [number, number] { return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string { const p0 = pol(cx, cy, r, a0), p1 = pol(cx, cy, r, a1); const lg = (a1 - a0) % TAU > Math.PI ? 1 : 0; return `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)} A${r} ${r} 0 ${lg} 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`; }
function shDef(id: string): string { return `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#101828" flood-opacity="0.06"/><feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#101828" flood-opacity="0.13"/></filter>`; }
function shHero(id: string): string { return `<filter id="${id}" x="-70%" y="-70%" width="240%" height="240%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#101828" flood-opacity="0.06"/><feDropShadow dx="0" dy="9" stdDeviation="7" flood-color="#101828" flood-opacity="0.16"/></filter>`; }

const ICON: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/>',
  chart: '<path d="M4 20h16"/><path d="M7 20v-6"/><path d="M12 20V8"/><path d="M17 20v-9"/>',
  rocket: '<path d="M12 3c2.5 1.8 4 4.8 4 8l-4 3-4-3c0-3.2 1.5-6.2 4-8z"/><circle cx="12" cy="9.5" r="1.3"/><path d="M8.5 15l-2.5 4 4-1M15.5 15l2.5 4-4-1"/>',
  shield: '<path d="M12 3l7 3v5c0 4.6-3 7.8-7 9.5C8 18.8 5 15.6 5 11V6z"/><path d="M9 11.5l2 2 4-4.5"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.6 3.1 3 7 3s7-1.4 7-3V6"/><path d="M5 12c0 1.6 3.1 3 7 3s7-1.4 7-3"/>',
  bulb: '<path d="M9.5 18h5"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.7 10.7c.8.7 1.2 1.5 1.2 2.3h5c0-.8.4-1.6 1.2-2.3A6 6 0 0 0 12 3z"/>',
  expand: '<path d="M4 14v6h6"/><path d="M20 10V4h-6"/><path d="M4 20l7-7"/><path d="M20 4l-7 7"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  network: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 6a3 3 0 0 1 0 6"/><path d="M20.5 19c0-2.4-1.4-4-3.3-4.6"/>',
  arrowR: '<path d="M4 12h15"/><path d="M13 6l6 6-6 6"/>',
  alert: '<path d="M10.3 4.3L2.6 18a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4L13.7 4.3a1.6 1.6 0 0 0-2.7 0z"/><path d="M12 9.5v4"/><path d="M12 17.2v.2"/>',
};
const ICON_CYCLE = ["search", "chart", "rocket", "shield", "database", "bulb", "users", "network"];
function iconAt(i: number, given?: string): string { return given && ICON[given] ? given : ICON_CYCLE[i % ICON_CYCLE.length]; }
function icG(name: string, px: number, py: number, size: number, color: string): string {
  return `<g transform="translate(${(px - size / 2).toFixed(1)},${(py - size / 2).toFixed(1)}) scale(${(size / 24).toFixed(3)})" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ""}</g>`;
}

// ── 데이터 타입 ─────────────────────────────────────────────────────
export interface BarDatum { l: string; v: number; }
export interface StackDatum { l: string; a: number; b: number; c: number; }
export interface WaterDatum { l: string; v: number; t?: "total"; }
export interface DonutDatum { l: string; v: number; }
export interface FunnelRow { l: string; v: string; p?: string; }
export interface StepItem { icon?: string; label: string; sub?: string; }
export interface TimelineItem { icon?: string; d: string; l: string; s?: string; }
export interface IconItem { icon?: string; label?: string; }
export interface PyramidItem { icon?: string; l: string; }

// ── 차트 ────────────────────────────────────────────────────────────
function cBar(d: BarDatum[]): string {
  const W = 300, H = 175, pl = 8, pr = 8, pt = 22, pb = 30, iw = W - pl - pr, ih = H - pt - pb;
  const max = Math.max(...d.map((x) => x.v));
  const mi = d.reduce((m, x, i) => (x.v > d[m].v ? i : m), 0);
  const step = iw / d.length, bw = step * 0.56;
  let s = "";
  [0.5, 0.75, 1].forEach((g) => { const y = pt + ih - ih * g; s += `<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" stroke="${FA}" stroke-width="1"/>`; });
  d.forEach((x, i) => {
    const bh = ih * (x.v / max), bx = pl + i * step + (step - bw) / 2, by = pt + ih - bh;
    s += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${i === mi ? A : rgba(INK, 0.3)}"/>`;
    s += txt(bx + bw / 2, by - 4, x.v, { a: "middle", s: 10, w: 800, f: i === mi ? A : INK, mono: true });
    s += txt(bx + bw / 2, pt + ih + 13, x.l, { a: "middle", s: 9.5, w: 600, f: MU });
  });
  s += `<line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="${INK}" stroke-width="1.4"/>`;
  return el(s, W, H);
}
function cStack(d: StackDatum[]): string {
  const W = 300, H = 175, pl = 8, pr = 8, pt = 14, pb = 30, iw = W - pl - pr, ih = H - pt - pb;
  const tot = d.map((x) => x.a + x.b + x.c), max = Math.max(...tot);
  const step = iw / d.length, bw = step * 0.5, cols = [A, mix(A, FA, 0.45), FA];
  let s = "";
  d.forEach((x, i) => {
    const bx = pl + i * step + (step - bw) / 2; let y = pt + ih; const segs = [x.a, x.b, x.c];
    segs.forEach((v, j) => { const hh = ih * (v / max); y -= hh; s += `<rect x="${bx.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${cols[j]}"/>`; });
    s += txt(bx + bw / 2, pt + ih + 13, x.l, { a: "middle", s: 9.5, f: MU });
  });
  s += `<line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="${INK}" stroke-width="1.4"/>`;
  return el(s, W, H);
}
function cLine(d: BarDatum[]): string {
  const W = 300, H = 175, pl = 10, pr = 14, pt = 18, pb = 28, iw = W - pl - pr, ih = H - pt - pb;
  const vs = d.map((x) => x.v), mn = Math.min(...vs) * 0.9, mx = Math.max(...vs);
  const X = (i: number) => pl + iw * (i / (d.length - 1)), Y = (v: number) => pt + ih - ih * ((v - mn) / (mx - mn));
  let s = ""; [0.5, 1].forEach((g) => { const y = pt + ih - ih * g; s += `<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" stroke="${FA}"/>`; });
  const p = d.map((x, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(x.v).toFixed(1)).join(" ");
  s += `<path d="${p}" fill="none" stroke="${A}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  d.forEach((x, i) => { s += txt(X(i), pt + ih + 13, x.l, { a: "middle", s: 9, f: MU }); });
  const li = d.length - 1; s += `<circle cx="${X(li).toFixed(1)}" cy="${Y(d[li].v).toFixed(1)}" r="4" fill="${A}"/>`;
  s += txt(X(li), Y(d[li].v) - 8, d[li].v, { a: "end", s: 11, w: 800, f: A, mono: true });
  return el(s, W, H);
}
function cArea(d: BarDatum[]): string {
  const W = 300, H = 175, pl = 10, pr = 10, pt = 18, pb = 28, iw = W - pl - pr, ih = H - pt - pb;
  const vs = d.map((x) => x.v), mx = Math.max(...vs);
  const X = (i: number) => pl + iw * (i / (d.length - 1)), Y = (v: number) => pt + ih - ih * (v / mx);
  const line = d.map((x, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(x.v).toFixed(1)).join(" ");
  const fill = line + " L" + X(d.length - 1).toFixed(1) + " " + (pt + ih) + " L" + X(0).toFixed(1) + " " + (pt + ih) + " Z";
  const gid = uid("ag");
  let s = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${A}" stop-opacity="0.32"/><stop offset="1" stop-color="${A}" stop-opacity="0"/></linearGradient></defs>`;
  s += `<path d="${fill}" fill="url(#${gid})"/>`;
  s += `<path d="${line}" fill="none" stroke="${A}" stroke-width="2.2" stroke-linejoin="round"/>`;
  d.forEach((x, i) => { s += txt(X(i), pt + ih + 13, x.l, { a: "middle", s: 9, f: MU }); });
  s += `<line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="${INK}" stroke-width="1.2"/>`;
  return el(s, W, H);
}
function cDonut(d: DonutDatum[]): string {
  const W = 260, H = 200, cx = 94, cy = 100, r = 62, sw = 22, C = TAU * r;
  const tot = d.reduce((a, x) => a + x.v, 0); let off = 0;
  const cols = [A, A2, mix(A, FA, 0.55), FA];
  let s = `<g transform="rotate(-90 ${cx} ${cy})">`;
  d.forEach((x, i) => { const frac = x.v / tot, len = frac * C; s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${cols[i % cols.length]}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`; off += len; });
  s += "</g>";
  s += txt(cx, cy - 2, d[0].v + "%", { a: "middle", s: 24, w: 800, f: A, mono: true });
  s += txt(cx, cy + 15, d[0].l, { a: "middle", s: 9.5, f: MU });
  let ly = 44; d.forEach((x, i) => { s += `<rect x="182" y="${ly - 8}" width="9" height="9" rx="2" fill="${cols[i % cols.length]}"/>`; s += txt(196, ly, x.l, { s: 10, w: 700 }); s += txt(196, ly + 12, x.v + "%", { s: 9.5, f: MU, mono: true }); ly += 34; });
  return el(s, W, H);
}
function cWater(d: WaterDatum[]): string {
  const W = 300, H = 185, pl = 8, pr = 8, pt = 22, pb = 30, iw = W - pl - pr, ih = H - pt - pb;
  let run = 0; const pts = d.map((x) => { const start = run; if (x.t === "total") { run = x.v; return { s: 0, e: x.v, t: "total" }; } run += x.v; return { s: start, e: run, t: x.v >= 0 ? "up" : "down" }; });
  const max = Math.max(...pts.map((p) => Math.max(p.s, p.e)));
  const step = iw / d.length, bw = step * 0.56; const Y = (v: number) => pt + ih - ih * (v / max);
  let s = ""; let prevX: number | null = null;
  d.forEach((x, i) => {
    const p = pts[i], bx = pl + i * step + (step - bw) / 2, y0 = Y(Math.max(p.s, p.e)), y1 = Y(Math.min(p.s, p.e)), h = y1 - y0;
    const col = p.t === "total" ? BAND : p.t === "up" ? A : rgba(INK, 0.32);
    s += `<rect x="${bx.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, h).toFixed(1)}" rx="1.5" fill="${col}"/>`;
    if (prevX !== null) { const cy = Y(p.s); s += `<line x1="${prevX.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${MU}" stroke-width="1" stroke-dasharray="2 2"/>`; }
    prevX = bx + bw;
    const lab = p.t === "total" ? String(x.v) : x.v > 0 ? "+" + x.v : String(x.v);
    s += txt(bx + bw / 2, y0 - 4, lab, { a: "middle", s: 9, w: 800, f: p.t === "total" ? BAND : INK, mono: true });
    s += txt(bx + bw / 2, pt + ih + 13, x.l, { a: "middle", s: 9, f: MU });
  });
  s += `<line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="${INK}" stroke-width="1.4"/>`;
  return el(s, W, H);
}

// ── 다이어그램(SVG · 모피즘) ────────────────────────────────────────
function dProcess(d: string[]): string {
  const W = 304, H = 126, n = d.length, gap = 14, cw = (W - gap * (n - 1)) / n, y = 30, h = 64, id = uid("sh");
  let s = txt(0, 15, "단계별 진행", { s: 9.5, f: MU, mono: true, ls: ".06em" });
  d.forEach((x, i) => {
    const bx = i * (cw + gap);
    s += `<rect x="${bx.toFixed(1)}" y="${y}" width="${cw.toFixed(1)}" height="${h}" rx="11" fill="${SURF}" filter="url(#${id})"/>`;
    s += `<circle cx="${(bx + cw / 2).toFixed(1)}" cy="${y + 22}" r="12.5" fill="${A}"/>`;
    s += txt(bx + cw / 2, y + 25.5, "0" + (i + 1), { a: "middle", s: 11, w: 800, f: "#fff", mono: true });
    s += txt(bx + cw / 2, y + 50, x, { a: "middle", s: 10, w: 700, f: INK });
    if (i) { const ax = bx - gap / 2; s += `<path d="M${ax - 3.5} ${y + h / 2 - 4.5} L${ax + 3.5} ${y + h / 2} L${ax - 3.5} ${y + h / 2 + 4.5}" fill="none" stroke="${A}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`; }
  });
  return el(s, W, H, shDef(id));
}
function dTimeline(d: TimelineItem[]): string {
  const W = 304, H = 140, pl = 18, pr = 18, y = 44, n = d.length, iw = W - pl - pr, step = n > 1 ? iw / (n - 1) : 0, id = uid("sh");
  let s = `<line x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}" stroke="${mix(INK, SURF, 0.86)}" stroke-width="3" stroke-linecap="round"/>`;
  const lastX = pl + (n - 1) * step, cw = Math.min(step - 8, 82);
  s += `<line x1="${pl}" y1="${y}" x2="${lastX.toFixed(1)}" y2="${y}" stroke="${A}" stroke-width="3" stroke-linecap="round"/>`;
  d.forEach((x, i) => {
    const cxp = pl + i * step, hero = i === n - 1, lx = Math.max(pl - 2, Math.min(cxp - cw / 2, W - pr - cw + 2));
    s += txt(cxp, y - 12, x.d, { a: "middle", s: 9, w: 800, f: A, mono: true });
    s += `<circle cx="${cxp.toFixed(1)}" cy="${y}" r="${hero ? 7 : 5.5}" fill="${A}" stroke="${SURF}" stroke-width="2" filter="url(#${id})"/>`;
    s += `<rect x="${lx.toFixed(1)}" y="${y + 13}" width="${cw.toFixed(1)}" height="34" rx="9" fill="${SURF}" filter="url(#${id})"/>`;
    s += txt(lx + cw / 2, y + 27, x.l, { a: "middle", s: 9.5, w: 800, f: INK });
    if (x.s) s += txt(lx + cw / 2, y + 39, x.s, { a: "middle", s: 8, f: MU });
  });
  return el(s, W, H, shDef(id));
}
function sCycle2(items: IconItem[]): string {
  const W = 260, H = 222, cx = 130, cy = 110, r = 68, nr = 29, n = items.length, id = uid("sh"), hid = uid("h"), mk = uid("mk"), gid = uid("g");
  const defs = shDef(id) + shHero(hid) +
    `<marker id="${mk}" markerWidth="9" markerHeight="9" refX="4.8" refY="3.6" orient="auto"><path d="M0 0 L7 3.6 L0 7.2 Z" fill="${A}"/></marker>` +
    `<radialGradient id="${gid}" cx="0.5" cy="0.32" r="0.8"><stop offset="0" stop-color="${tintL(0.16)}"/><stop offset="1" stop-color="${A}"/></radialGradient>`;
  let s = "";
  for (let i = 0; i < n; i++) { const a0 = -Math.PI / 2 + (i / n) * TAU + 0.52, a1 = -Math.PI / 2 + ((i + 1) / n) * TAU - 0.52; s += `<path d="${arcPath(cx, cy, r + 4, a0, a1)}" fill="none" stroke="${A}" stroke-width="3" stroke-linecap="round" marker-end="url(#${mk})" opacity="0.9"/>`; }
  s += txt(cx, cy + 3, "성장 루프", { a: "middle", s: 10, w: 800, f: mix(INK, SURF, 0.42) });
  items.forEach((it, i) => { const a = -Math.PI / 2 + (i / n) * TAU, p = pol(cx, cy, r, a); s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${nr}" fill="url(#${gid})" filter="url(#${hid})"/>`; s += icG(iconAt(i, it.icon), p[0], p[1] - 5, 19, "#fff"); if (it.label) s += txt(p[0], p[1] + 13, it.label, { a: "middle", s: 8, w: 700, f: "#fff" }); });
  return el(s, W, H, defs);
}
function sFunnel2(d: FunnelRow[]): string {
  const W = 272, H = 204, pt = 8, cx = 104, topW = 192, botW = 74, n = d.length, gap = 6, sh = (H - pt - 8 - gap * (n - 1)) / n, id = uid("sh"), cid = uid("c");
  const colAt = (i: number) => mix(tintL(0.4), shadeL(0.36), n > 1 ? i / (n - 1) : 0);
  let g = `<g filter="url(#${id})">`;
  d.forEach((x, i) => { const y = pt + i * (sh + gap), wt = topW + (botW - topW) * (i / n), wb = topW + (botW - topW) * ((i + 1) / n); g += `<path d="M${(cx - wt / 2).toFixed(1)} ${y.toFixed(1)} L${(cx + wt / 2).toFixed(1)} ${y.toFixed(1)} L${(cx + wb / 2).toFixed(1)} ${(y + sh).toFixed(1)} L${(cx - wb / 2).toFixed(1)} ${(y + sh).toFixed(1)} Z" fill="${colAt(i)}"/>`; });
  g += "</g>";
  let s = g;
  d.forEach((x, i) => {
    const y = pt + i * (sh + gap), tc = textOn(colAt(i));
    s += txt(cx, y + sh / 2 - 2, x.l, { a: "middle", s: 9.5, w: 700, f: tc });
    s += txt(cx, y + sh / 2 + 11, x.v, { a: "middle", s: 12.5, w: 800, f: tc, mono: true });
    if (x.p) { s += `<rect x="${cx + topW / 2 - 2}" y="${y + sh / 2 - 8.5}" width="48" height="17" rx="8.5" fill="${SURF}" filter="url(#${cid})"/>`; s += txt(cx + topW / 2 + 22, y + sh / 2 + 3.5, x.p, { a: "middle", s: 8.5, w: 700, f: MU, mono: true }); }
  });
  return el(s, W, H, shDef(id) + shDef(cid));
}
function sPyramid2(d: PyramidItem[]): string {
  const W = 264, H = 190, ax = 132, ay = 14, baseY = 170, baseW = 200, n = d.length, sh = (baseY - ay) / n, gap = 3, id = uid("sh");
  let s = "";
  d.forEach((x, i) => {
    const y0 = ay + i * sh, y1 = y0 + sh - gap, w0 = baseW * (i / n), w1 = baseW * ((i + 1) / n), col = mix(A, SURF, (n - 1 - i) * 0.24), tc = textOn(col), cyy = y0 + sh / 2;
    const pth = i === 0 ? `M${ax} ${ay} L${(ax + w1 / 2).toFixed(1)} ${y1.toFixed(1)} L${(ax - w1 / 2).toFixed(1)} ${y1.toFixed(1)} Z` : `M${(ax - w0 / 2).toFixed(1)} ${y0.toFixed(1)} L${(ax + w0 / 2).toFixed(1)} ${y0.toFixed(1)} L${(ax + w1 / 2).toFixed(1)} ${y1.toFixed(1)} L${(ax - w1 / 2).toFixed(1)} ${y1.toFixed(1)} Z`;
    s += `<path d="${pth}" fill="${col}" filter="url(#${id})"/>`;
    if (i > 0) { s += icG(iconAt(i, x.icon), ax - 22, cyy, 15, tc); s += txt(ax + 8, cyy + 3.5, x.l, { a: "middle", s: 10, w: 700, f: tc }); } else s += txt(ax, cyy + 4, x.l, { a: "middle", s: 9, w: 800, f: tc });
  });
  return el(s, W, H, shDef(id));
}
function sHub2(items: IconItem[]): string {
  const W = 262, H = 210, cx = 131, cy = 104, R = 72, n = items.length, cr = 32, cw = 52, ch = 25, id = uid("sh"), hid = uid("h"), gid = uid("g"), halo = uid("halo");
  const defs = shDef(id) + shHero(hid) +
    `<radialGradient id="${gid}" cx="0.5" cy="0.34" r="0.75"><stop offset="0" stop-color="${tintL(0.18)}"/><stop offset="1" stop-color="${A}"/></radialGradient>` +
    `<radialGradient id="${halo}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${tintL(0.86)}"/><stop offset="1" stop-color="${tintL(0.86)}" stop-opacity="0"/></radialGradient>`;
  let s = `<circle cx="${cx}" cy="${cy}" r="98" fill="url(#${halo})"/>`; const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / n) * TAU, p = pol(cx, cy, R, a); pts.push(p); s += `<line x1="${cx}" y1="${cy}" x2="${p[0].toFixed(1)}" y2="${p[1].toFixed(1)}" stroke="${mix(INK, SURF, 0.78)}" stroke-width="1.5"/>`; }
  pts.forEach((p, i) => { s += `<rect x="${(p[0] - cw / 2).toFixed(1)}" y="${(p[1] - ch / 2).toFixed(1)}" width="${cw}" height="${ch}" rx="9" fill="${SURF}" filter="url(#${id})"/>`; s += txt(p[0], p[1] + 3.5, items[i].label ?? "", { a: "middle", s: 9.5, w: 700, f: INK }); });
  s += `<circle cx="${cx}" cy="${cy}" r="${cr}" fill="url(#${gid})" filter="url(#${hid})"/>`;
  s += icG("network", cx, cy, 24, "#fff");
  return el(s, W, H, defs);
}
function sOrg2(labels?: string[]): string {
  const W = 304, H = 182, bw = 74, bh = 32, id = uid("sh");
  const L = labels && labels.length >= 5 ? labels : ["대표", "전략", "제품", "운영", "실무팀"];
  function box(x: number, y: number, t: string, icon: string, dark: boolean): string {
    const bg = dark ? BAND : SURF, tc = textOn(bg);
    let s = `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="9" fill="${bg}" filter="url(#${id})"/>`;
    if (!dark) s += `<rect x="${x}" y="${y}" width="${bw}" height="3.5" rx="1.75" fill="${A}"/>`;
    s += icG(icon, x + 15, y + bh / 2 + (dark ? 0 : 1), 14, tc);
    s += txt(x + bw / 2 + 9, y + bh / 2 + 3.5 + (dark ? 0 : 1), t, { a: "middle", s: 9, w: 700, f: tc });
    return s;
  }
  const cx = W / 2 - bw / 2, y0 = 12, y1 = 78, y2 = 140, xs = [14, cx, W - bw - 14], midY = (y0 + bh + y1) / 2;
  let s = "";
  xs.forEach((x) => { s += `<path d="M${cx + bw / 2} ${y0 + bh} L${cx + bw / 2} ${midY} L${x + bw / 2} ${midY} L${x + bw / 2} ${y1}" fill="none" stroke="${mix(INK, SURF, 0.68)}" stroke-width="1.4"/>`; });
  s += `<line x1="${cx + bw / 2}" y1="${y1 + bh}" x2="${cx + bw / 2}" y2="${y2}" stroke="${mix(INK, SURF, 0.68)}" stroke-width="1.4"/>`;
  s += box(cx, y0, L[0], "shield", true);
  s += box(xs[0], y1, L[1], "chart", false) + box(cx, y1, L[2], "rocket", false) + box(xs[2], y1, L[3], "database", false);
  s += box(cx, y2, L[4], "users", false);
  return el(s, W, H, shDef(id));
}
interface ComparePanel { title: string; rows: { k: string; t: string }[]; }
function dCompare(left?: ComparePanel, right?: ComparePanel): string {
  const W = 304, H = 200, pw = 132, gap = W - pw * 2, y0 = 12, ph = H - y0 - 8, id = uid("sh");
  const L = left ?? { title: "기존 방식", rows: [{ k: "속도", t: "수기 취합 · 느림" }, { k: "범위", t: "인적 네트워크" }, { k: "검증", t: "사후 인지" }] };
  const R = right ?? { title: "데이터 방식", rows: [{ k: "속도", t: "실시간 자동 수집" }, { k: "범위", t: "전수 스크리닝" }, { k: "검증", t: "선제적 시그널" }] };
  function panel(x: number, p: ComparePanel, dark: boolean): string {
    const hd = dark ? A : mix(INK, SURF, 0.5), bg = dark ? BAND : SURF, tc = dark ? "#fff" : INK, kc = dark ? mix(A, SURF, 0.35) : MU;
    let s = `<rect x="${x}" y="${y0}" width="${pw}" height="${ph}" rx="12" fill="${bg}" filter="url(#${id})"/>`;
    s += `<path d="M${x + 12} ${y0} L${x + pw - 12} ${y0} Q${x + pw} ${y0} ${x + pw} ${y0 + 12} L${x + pw} ${y0 + 28} L${x} ${y0 + 28} L${x} ${y0 + 12} Q${x} ${y0} ${x + 12} ${y0} Z" fill="${hd}"/>`;
    s += txt(x + pw / 2, y0 + 18.5, p.title, { a: "middle", s: 11, w: 800, f: "#fff" });
    p.rows.forEach((rw, i) => { const ry = y0 + 48 + i * 40; s += txt(x + 13, ry, rw.k, { s: 8.5, w: 800, f: kc, mono: true }); s += txt(x + 13, ry + 13, rw.t, { s: 9.5, w: 600, f: tc }); });
    return s;
  }
  let s = panel(0, L, false) + panel(pw + gap, R, true);
  const mx = pw + gap / 2; s += `<circle cx="${mx}" cy="${y0 + ph / 2}" r="14" fill="${SURF}" filter="url(#${id})"/>` + txt(mx, y0 + ph / 2 + 3.5, "VS", { a: "middle", s: 9, w: 800, f: INK, mono: true });
  return el(s, W, H, shDef(id));
}

// ── 플로우(SVG · 단일 hue 셰이드) ───────────────────────────────────
function sChevronFlow(items: IconItem[]): string {
  const W = 308, H = 92, n = items.length, gap = 4, notch = 13, cw = (W - gap * (n - 1)) / n, y = 20, h = 52, id = uid("sh");
  let s = "";
  items.forEach((it, i) => { const x = i * (cw + gap), col = shadeAt(i, n); const pth = `M${x} ${y} L${x + cw - notch} ${y} L${x + cw} ${y + h / 2} L${x + cw - notch} ${y + h} L${x} ${y + h}${i ? ` L${x + notch} ${y + h / 2}` : ""} Z`; s += `<path d="${pth}" fill="${col}" filter="url(#${id})"/>`; s += icG(iconAt(i, it.icon), x + cw / 2 + 2, y + h / 2 - 8, 15, "#fff"); if (it.label) s += txt(x + cw / 2 + 2, y + h / 2 + 13, it.label, { a: "middle", s: 8.5, w: 700, f: "#fff" }); });
  return el(s, W, H, shDef(id));
}
function sSemiFan(items: IconItem[]): string {
  const W = 264, H = 150, cx = 132, cy = 140, R = 112, r = 54, n = items.length, gap = 0.035, id = uid("sh");
  let s = "";
  items.forEach((it, i) => {
    const a0 = Math.PI + (i / n) * Math.PI + gap, a1 = Math.PI + ((i + 1) / n) * Math.PI - gap, col = shadeAt(i, n);
    const o0 = pol(cx, cy, R, a0), o1 = pol(cx, cy, R, a1), i1 = pol(cx, cy, r, a1), i0 = pol(cx, cy, r, a0);
    s += `<path d="M${o0[0].toFixed(1)} ${o0[1].toFixed(1)} A${R} ${R} 0 0 1 ${o1[0].toFixed(1)} ${o1[1].toFixed(1)} L${i1[0].toFixed(1)} ${i1[1].toFixed(1)} A${r} ${r} 0 0 0 ${i0[0].toFixed(1)} ${i0[1].toFixed(1)} Z" fill="${col}" filter="url(#${id})"/>`;
    const am = (a0 + a1) / 2, pm = pol(cx, cy, (R + r) / 2, am);
    s += icG(iconAt(i, it.icon), pm[0], pm[1] - 7, 15, "#fff");
    s += txt(pm[0], pm[1] + 11, "0" + (i + 1), { a: "middle", s: 11, w: 800, f: "#fff", mono: true });
  });
  return el(s, W, H, shDef(id));
}
function sDiamondGrid(items: IconItem[]): string {
  const W = 308, H = 124, n = Math.min(items.length, 4), sz = 56, gap = (W - n * sz) / (n + 1), id = uid("sh");
  let s = "";
  items.slice(0, 4).forEach((it, i) => { const cx = gap + sz / 2 + i * (sz + gap), cy = 50, col = shadeAt(i, n); s += `<rect x="${cx - sz / 2}" y="${cy - sz / 2}" width="${sz}" height="${sz}" rx="9" transform="rotate(45 ${cx} ${cy})" fill="${col}" filter="url(#${id})"/>`; s += icG(iconAt(i, it.icon), cx, cy, 21, "#fff"); if (it.label) s += txt(cx, cy + sz / 2 + 16, it.label, { a: "middle", s: 9, w: 700, f: INK }); });
  return el(s, W, H, shDef(id));
}
function sStepsAscend(items: IconItem[]): string {
  const W = 308, H = 142, n = items.length, gap = 6, cw = (W - gap * (n - 1)) / n, baseY = 128, id = uid("sh");
  let s = "";
  items.forEach((it, i) => { const x = i * (cw + gap), bh = 44 + i * ((104 - 44) / (n > 1 ? n - 1 : 1)), y = baseY - bh, col = shadeAt(i, n); s += `<rect x="${x}" y="${y.toFixed(1)}" width="${cw.toFixed(1)}" height="${bh.toFixed(1)}" rx="8" fill="${col}" filter="url(#${id})"/>`; s += icG(iconAt(i, it.icon), x + cw / 2, y + 16, 16, "#fff"); s += txt(x + cw / 2, y + bh - 9, "0" + (i + 1), { a: "middle", s: 10, w: 800, f: rgba("#ffffff", 0.82), mono: true }); if (it.label) s += txt(x + cw / 2, baseY + 12, it.label, { a: "middle", s: 8.5, w: 700, f: INK }); });
  return el(s, W, H, shDef(id));
}
function sPuzzle(items: IconItem[]): string {
  const W = 310, H = 94, n = items.length, pw = (W - 4) / n, y = 20, h = 52, tab = 10, id = uid("sh");
  let s = "";
  items.forEach((it, i) => {
    const x = 2 + i * pw, cy = y + h / 2, col = shadeAt(i, n), first = i === 0, lastp = i === n - 1;
    let pth = `M${x} ${y} L${(x + pw).toFixed(1)} ${y}`;
    pth += lastp ? ` L${(x + pw).toFixed(1)} ${y + h}` : ` L${(x + pw).toFixed(1)} ${cy - tab} A${tab} ${tab} 0 1 1 ${(x + pw).toFixed(1)} ${cy + tab} L${(x + pw).toFixed(1)} ${y + h}`;
    pth += ` L${x} ${y + h}`;
    pth += first ? ` L${x} ${y}` : ` L${x} ${cy + tab} A${tab} ${tab} 0 1 1 ${x} ${cy - tab} L${x} ${y}`;
    pth += " Z";
    s += `<path d="${pth}" fill="${col}" filter="url(#${id})" stroke="${SURF}" stroke-width="1.5"/>`;
    s += txt(x + pw / 2, cy + 5, "0" + (i + 1), { a: "middle", s: 15, w: 800, f: "#fff", mono: true });
  });
  return el(s, W, H, shDef(id));
}
function sConverge(items: string[]): string {
  const W = 250, H = 210, cx = 125, cy = 104, cr = 37, R = 94, n = items.length, id = uid("sh"), hid = uid("h"), mk = uid("mk"), gid = uid("g");
  const defs = shDef(id) + shHero(hid) +
    `<marker id="${mk}" markerWidth="7" markerHeight="7" refX="5.4" refY="3.4" orient="auto"><path d="M0 0 L6.6 3.4 L0 6.8 Z" fill="${A}"/></marker>` +
    `<radialGradient id="${gid}" cx="0.5" cy="0.34" r="0.8"><stop offset="0" stop-color="${tintL(0.16)}"/><stop offset="1" stop-color="${A}"/></radialGradient>`;
  let s = "";
  for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / n) * TAU, p0 = pol(cx, cy, R, a), p1 = pol(cx, cy, cr + 11, a); s += `<line x1="${p0[0].toFixed(1)}" y1="${p0[1].toFixed(1)}" x2="${p1[0].toFixed(1)}" y2="${p1[1].toFixed(1)}" stroke="${shadeAt(i, n)}" stroke-width="8" stroke-linecap="round" marker-end="url(#${mk})"/>`; const pl2 = pol(cx, cy, R + 2, a); s += txt(pl2[0], pl2[1] + 3, items[i], { a: "middle", s: 8, w: 700, f: INK }); }
  s += `<circle cx="${cx}" cy="${cy}" r="${cr}" fill="url(#${gid})" filter="url(#${hid})"/>`;
  s += icG("network", cx, cy, 22, "#fff");
  return el(s, W, H, defs);
}

// ── 추가 데이터 타입 ────────────────────────────────────────────────
export interface BulletDatum { l: string; v: number; t?: number; }
export interface GroupDatum { l: string; a: number; b: number; }
export interface XYDatum { l: string; x: number; y: number; r?: number; }

// ── 추가 차트(10) ───────────────────────────────────────────────────
function cRadar(d: BarDatum[]): string {
  const W = 250, H = 210, cx = 125, cy = 108, R = 74, n = d.length;
  let s = "";
  [0.33, 0.66, 1].forEach((g) => { const pts = d.map((_, i) => { const a = -Math.PI / 2 + (i / n) * TAU, p = pol(cx, cy, R * g, a); return p[0].toFixed(1) + "," + p[1].toFixed(1); }); s += `<polygon points="${pts.join(" ")}" fill="none" stroke="${FA}" stroke-width="1"/>`; });
  d.forEach((_, i) => { const a = -Math.PI / 2 + (i / n) * TAU, p = pol(cx, cy, R, a); s += `<line x1="${cx}" y1="${cy}" x2="${p[0].toFixed(1)}" y2="${p[1].toFixed(1)}" stroke="${FA}"/>`; });
  const vp = d.map((x, i) => { const a = -Math.PI / 2 + (i / n) * TAU, p = pol(cx, cy, R * Math.max(0.06, Math.min(100, x.v) / 100), a); return p[0].toFixed(1) + "," + p[1].toFixed(1); });
  s += `<polygon points="${vp.join(" ")}" fill="${rgba(A, 0.18)}" stroke="${A}" stroke-width="2" stroke-linejoin="round"/>`;
  d.forEach((x, i) => { const a = -Math.PI / 2 + (i / n) * TAU, p = pol(cx, cy, R * Math.min(100, x.v) / 100, a), lp = pol(cx, cy, R + 13, a); s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6" fill="${A}"/>`; s += txt(lp[0], lp[1] + 3, x.l, { a: "middle", s: 8, w: 600, f: MU }); });
  return el(s, W, H);
}
function cGauge(d: BarDatum[]): string {
  const W = 250, H = 150, cx = 125, cy = 130, r = 86, v = Math.max(0, Math.min(100, d[0].v));
  const va = Math.PI + (v / 100) * Math.PI;
  let s = `<path d="${arcPath(cx, cy, r, Math.PI, Math.PI * 2)}" fill="none" stroke="${FA}" stroke-width="16" stroke-linecap="round"/>`;
  s += `<path d="${arcPath(cx, cy, r, Math.PI, va)}" fill="none" stroke="${A}" stroke-width="16" stroke-linecap="round"/>`;
  s += txt(cx, cy - 12, v + "%", { a: "middle", s: 30, w: 800, f: A, mono: true });
  s += txt(cx, cy + 5, d[0].l, { a: "middle", s: 9.5, f: MU });
  return el(s, W, H);
}
function cRings(d: BarDatum[]): string {
  const W = 250, H = 200, cx = 96, cy = 100, rs = [80, 62, 44], sw = 13, cols = [A, A2, mix(A, FA, 0.5)];
  let s = "";
  d.slice(0, 3).forEach((x, i) => { const r = rs[i], C = TAU * r, len = C * Math.max(0, Math.min(100, x.v)) / 100; s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${FA}" stroke-width="${sw}"/>`; s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${cols[i]}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`; });
  let ly = 60; d.slice(0, 3).forEach((x, i) => { s += `<rect x="188" y="${ly - 8}" width="9" height="9" rx="2" fill="${cols[i]}"/>`; s += txt(202, ly, x.l, { s: 9.5, w: 700 }); s += txt(202, ly + 12, x.v + "%", { s: 9, f: MU, mono: true }); ly += 32; });
  return el(s, W, H);
}
function cBullet(d: BulletDatum[]): string {
  const W = 300, H = 170, pl = 62, pr = 26, iw = W - pl - pr, rows = d.slice(0, 4), rowH = (H - 20) / rows.length;
  let s = "";
  rows.forEach((x, i) => { const y = 14 + i * rowH; s += txt(pl - 6, y + 11, x.l, { a: "end", s: 9, w: 700, f: INK }); s += `<rect x="${pl}" y="${y}" width="${iw}" height="15" rx="7.5" fill="${FA}"/>`; s += `<rect x="${pl}" y="${y}" width="${(iw * Math.min(100, x.v) / 100).toFixed(1)}" height="15" rx="7.5" fill="${A}"/>`; if (x.t != null) { const tx = pl + iw * Math.min(100, x.t) / 100; s += `<line x1="${tx.toFixed(1)}" y1="${y - 3}" x2="${tx.toFixed(1)}" y2="${y + 18}" stroke="${INK}" stroke-width="2"/>`; } s += txt(pl + iw + 4, y + 11, x.v, { s: 9, w: 800, f: A, mono: true }); });
  return el(s, W, H);
}
function cHBar(d: BarDatum[]): string {
  const W = 300, H = 175, pl = 70, pr = 30, rows = [...d].slice(0, 5), iw = W - pl - pr, rowH = (H - 16) / rows.length, max = Math.max(...rows.map((x) => x.v));
  const mi = rows.reduce((m, x, i) => (x.v > rows[m].v ? i : m), 0);
  let s = "";
  rows.forEach((x, i) => { const y = 10 + i * rowH, bw = iw * (x.v / max); s += txt(pl - 6, y + rowH / 2 + 1, x.l, { a: "end", s: 9, w: 700, f: i === mi ? A : INK }); s += `<rect x="${pl}" y="${y + 2}" width="${bw.toFixed(1)}" height="${rowH - 8}" rx="3" fill="${i === mi ? A : rgba(INK, 0.28)}"/>`; s += txt(pl + bw + 4, y + rowH / 2 + 1, x.v, { s: 9, w: 800, f: i === mi ? A : MU, mono: true }); });
  return el(s, W, H);
}
function cGroupBar(d: GroupDatum[]): string {
  const W = 300, H = 175, pl = 8, pr = 8, pt = 22, pb = 26, iw = W - pl - pr, ih = H - pt - pb, max = Math.max(...d.map((x) => Math.max(x.a, x.b)));
  const step = iw / d.length, bw = step * 0.28;
  let s = "";
  d.forEach((x, i) => { const bx = pl + i * step + step / 2; [x.a, x.b].forEach((v, j) => { const h = ih * (v / max), y = pt + ih - h, x0 = bx - bw + j * bw; s += `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${j ? mix(A, FA, 0.4) : A}"/>`; }); s += txt(bx, pt + ih + 13, x.l, { a: "middle", s: 9, f: MU }); });
  s += `<line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="${INK}" stroke-width="1.4"/>`;
  return el(s, W, H);
}
function cDot(d: BarDatum[]): string {
  const W = 300, H = 175, pl = 66, pr = 30, rows = d.slice(0, 5), iw = W - pl - pr, rowH = (H - 16) / rows.length, max = Math.max(...rows.map((x) => x.v));
  let s = "";
  rows.forEach((x, i) => { const y = 10 + i * rowH + rowH / 2, cxp = pl + iw * (x.v / max); s += txt(pl - 6, y + 3, x.l, { a: "end", s: 9, w: 700, f: INK }); s += `<line x1="${pl}" y1="${y}" x2="${cxp.toFixed(1)}" y2="${y}" stroke="${FA}" stroke-width="2"/>`; s += `<circle cx="${cxp.toFixed(1)}" cy="${y}" r="6.5" fill="${A}"/>`; s += txt(cxp + 12, y + 3, x.v, { s: 9, w: 800, f: A, mono: true }); });
  return el(s, W, H);
}
function cWaffle(d: BarDatum[]): string {
  const W = 200, H = 200, cell = 17, gap = 2.6, pct = Math.max(0, Math.min(100, d[0].v)), filled = Math.round(pct);
  let s = "";
  for (let i = 0; i < 100; i++) { const r = 9 - Math.floor(i / 10), c = i % 10, x = 6 + c * (cell + gap), y = 6 + r * (cell + gap); s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell}" height="${cell}" rx="3" fill="${i < filled ? A : mix(A, FA, 0.72)}"/>`; }
  s += txt(6, 198, `${pct}% · ${d[0].l}`, { s: 10, w: 800, f: A, mono: true });
  return el(s, W, H);
}
function cSlope(d: GroupDatum[]): string {
  const W = 260, H = 180, pl = 50, pr = 50, pt = 20, pb = 24, ih = H - pt - pb, rows = d.slice(0, 4);
  const all = rows.flatMap((x) => [x.a, x.b]), max = Math.max(...all), min = Math.min(...all);
  const Y = (v: number) => pt + ih - ih * ((v - min) / Math.max(1, max - min));
  let s = `<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="${FA}"/><line x1="${W - pr}" y1="${pt}" x2="${W - pr}" y2="${pt + ih}" stroke="${FA}"/>`;
  rows.forEach((x, i) => { const col = i === 0 ? A : rgba(INK, 0.35); s += `<line x1="${pl}" y1="${Y(x.a).toFixed(1)}" x2="${W - pr}" y2="${Y(x.b).toFixed(1)}" stroke="${col}" stroke-width="2.2"/>`; s += `<circle cx="${pl}" cy="${Y(x.a).toFixed(1)}" r="3.5" fill="${col}"/><circle cx="${W - pr}" cy="${Y(x.b).toFixed(1)}" r="3.5" fill="${col}"/>`; s += txt(pl - 5, Y(x.a) + 3, x.l, { a: "end", s: 8.5, w: 700, f: i === 0 ? A : MU }); s += txt(W - pr + 5, Y(x.b) + 3, String(x.b), { s: 8.5, w: 800, f: i === 0 ? A : MU, mono: true }); });
  s += txt(pl, pt - 6, "이전", { a: "middle", s: 8, f: MU }); s += txt(W - pr, pt - 6, "이후", { a: "middle", s: 8, f: MU });
  return el(s, W, H);
}
function cBubble(d: XYDatum[]): string {
  const W = 300, H = 190, pl = 30, pr = 16, pt = 14, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
  const rmax = Math.max(...d.map((x) => x.r ?? 10));
  let s = `<line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="${INK}" stroke-width="1.2"/><line x1="${pl}" y1="${pt}" x2="${pl}" y2="${pt + ih}" stroke="${FA}"/>`;
  d.forEach((x, i) => { const cx = pl + iw * (x.x / 100), cy = pt + ih - ih * (x.y / 100), r = 6 + 18 * ((x.r ?? 10) / rmax); s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${rgba(i === 0 ? A : A2, 0.55)}" stroke="${i === 0 ? A : A2}" stroke-width="1.5"/>`; s += txt(cx, cy + 3, x.l, { a: "middle", s: 8, w: 700, f: "#fff" }); });
  return el(s, W, H);
}

// ── 추가 다이어그램(12) ─────────────────────────────────────────────
function dVenn(items: string[]): string {
  const W = 260, H = 180, cy = 92, r = 58, cx1 = 96, cx2 = 164, id = uid("sh");
  let s = `<circle cx="${cx1}" cy="${cy}" r="${r}" fill="${rgba(A, 0.5)}" filter="url(#${id})"/><circle cx="${cx2}" cy="${cy}" r="${r}" fill="${rgba(A2, 0.5)}"/>`;
  s += txt(cx1 - 22, cy + 3, items[0] ?? "A", { a: "middle", s: 10, w: 800, f: "#fff" });
  s += txt(cx2 + 22, cy + 3, items[1] ?? "B", { a: "middle", s: 10, w: 800, f: "#fff" });
  s += txt((cx1 + cx2) / 2, cy + 3, items[2] ?? "공통", { a: "middle", s: 8.5, w: 800, f: INK });
  return el(s, W, H, shDef(id));
}
function dQuadrant(items: string[]): string {
  const W = 260, H = 220, m = 26, id = uid("sh");
  let s = `<rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" rx="8" fill="${SURF}" filter="url(#${id})"/>`;
  s += `<line x1="${W / 2}" y1="${m}" x2="${W / 2}" y2="${H - m}" stroke="${FA}" stroke-width="1.5"/><line x1="${m}" y1="${H / 2}" x2="${W - m}" y2="${H / 2}" stroke="${FA}" stroke-width="1.5"/>`;
  const qc: [number, number][] = [[W / 2 - (W / 2 - m) / 2, m + (H / 2 - m) / 2], [W / 2 + (W / 2 - m) / 2, m + (H / 2 - m) / 2], [W / 2 - (W / 2 - m) / 2, H / 2 + (H / 2 - m) / 2], [W / 2 + (W / 2 - m) / 2, H / 2 + (H / 2 - m) / 2]];
  const hero = 1;
  items.slice(0, 4).forEach((t, i) => { s += `<circle cx="${qc[i][0]}" cy="${qc[i][1]}" r="${i === hero ? 20 : 15}" fill="${i === hero ? A : rgba(A, 0.28)}"/>`; s += txt(qc[i][0], qc[i][1] + 3, t, { a: "middle", s: 8, w: 700, f: i === hero ? "#fff" : INK }); });
  s += txt(W / 2, 14, "높음 ↑", { a: "middle", s: 7.5, f: MU }); s += txt(W - 6, H / 2, "→", { a: "end", s: 9, f: MU });
  return el(s, W, H, shDef(id));
}
function dSwot(items: string[]): string {
  const W = 280, H = 200, g = 6, cw = (W - g) / 2, ch = (H - g) / 2, id = uid("sh");
  const heads = ["강점", "약점", "기회", "위협"]; const cols = [A, mix(A, INK, 0.3), A2, mix(A2, INK, 0.3)];
  let s = "";
  [[0, 0], [1, 0], [0, 1], [1, 1]].forEach((pos, i) => { const x = pos[0] * (cw + g), y = pos[1] * (ch + g); s += `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="9" fill="${cols[i]}" filter="url(#${id})"/>`; s += txt(x + 12, y + 20, heads[i], { s: 11, w: 800, f: "#fff" }); s += txt(x + 12, y + 38, items[i] ?? "", { s: 8.5, w: 500, f: rgba("#ffffff", 0.9) }); });
  return el(s, W, H, shDef(id));
}
function dRoadmap(d: GroupDatum[]): string {
  const W = 304, H = 170, pl = 66, pr = 14, pt = 24, iw = W - pl - pr, rows = d.slice(0, 4), rowH = (H - pt - 8) / rows.length, id = uid("sh");
  let s = "";
  [0, 25, 50, 75, 100].forEach((g, i) => { const x = pl + iw * g / 100; s += `<line x1="${x.toFixed(1)}" y1="${pt - 4}" x2="${x.toFixed(1)}" y2="${H - 6}" stroke="${FA}"/>`; s += txt(x, pt - 8, ["Q1", "Q2", "Q3", "Q4", ""][i], { a: "middle", s: 8, f: MU, mono: true }); });
  rows.forEach((x, i) => { const y = pt + i * rowH + 3, bx = pl + iw * Math.min(100, x.a) / 100, bw = iw * Math.min(100, x.b) / 100; s += txt(pl - 6, y + rowH / 2, x.l, { a: "end", s: 8.5, w: 700, f: INK }); s += `<rect x="${bx.toFixed(1)}" y="${y}" width="${Math.max(10, bw).toFixed(1)}" height="${rowH - 8}" rx="6" fill="${shadeAt(i, rows.length)}" filter="url(#${id})"/>`; });
  return el(s, W, H, shDef(id));
}
function dKanban(items: string[]): string {
  const W = 304, H = 180, g = 8, cols = ["할 일", "진행", "완료"], cw = (W - g * 2) / 3, id = uid("sh");
  let s = "";
  cols.forEach((c, ci) => { const x = ci * (cw + g); s += `<rect x="${x}" y="0" width="${cw}" height="${H}" rx="9" fill="${mix(A, SURF, 0.94)}"/>`; s += `<rect x="${x}" y="0" width="${cw}" height="22" rx="9" fill="${ci === 2 ? A : mix(A, SURF, 0.4)}"/>`; s += txt(x + cw / 2, 15, c, { a: "middle", s: 9.5, w: 800, f: "#fff" }); const mine = items.filter((_, k) => k % 3 === ci).slice(0, 3); mine.forEach((t, r) => { const cy = 30 + r * 44; s += `<rect x="${x + 7}" y="${cy}" width="${cw - 14}" height="36" rx="7" fill="${SURF}" filter="url(#${id})"/>`; s += `<rect x="${x + 7}" y="${cy}" width="4" height="36" rx="2" fill="${shadeAt(r, 3)}"/>`; s += txt(x + 16, cy + 22, shorten(t, 8), { s: 8.5, w: 600, f: INK }); }); });
  return el(s, W, H, shDef(id));
}
function dPipeline(items: IconItem[]): string {
  const W = 308, H = 110, n = items.length, gap = 6, notch = 16, cw = (W - gap * (n - 1)) / n, y = 26, h = 62, id = uid("sh");
  let s = "";
  items.forEach((it, i) => { const x = i * (cw + gap), col = shadeAt(i, n); const pth = `M${x} ${y} L${x + cw - notch} ${y} L${x + cw} ${y + h / 2} L${x + cw - notch} ${y + h} L${x} ${y + h}${i ? ` L${x + notch} ${y + h / 2}` : ""} Z`; s += `<path d="${pth}" fill="${col}" filter="url(#${id})"/>`; s += `<circle cx="${x + notch + 12}" cy="${y + h / 2}" r="11" fill="${rgba("#ffffff", 0.22)}"/>`; s += txt(x + notch + 12, y + h / 2 + 3.5, "0" + (i + 1), { a: "middle", s: 9, w: 800, f: "#fff", mono: true }); if (it.label) s += txt(x + notch + 28, y + h / 2 + 3.5, shorten(it.label, 6), { s: 9, w: 700, f: "#fff" }); });
  return el(s, W, H, shDef(id));
}
function dMatrix(items: string[]): string {
  const W = 240, H = 200, n = 3, m = 30, cell = (W - m) / n, id = uid("sh");
  let s = `<rect x="${m}" y="0" width="${W - m}" height="${cell * n}" rx="8" fill="${SURF}" filter="url(#${id})"/>`;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { const x = m + c * cell, y = r * cell, t = (r + c) / 4; s += `<rect x="${x + 2}" y="${y + 2}" width="${cell - 4}" height="${cell - 4}" rx="4" fill="${mix(FA, A, t)}"/>`; }
  ["상", "중", "하"].forEach((t, i) => s += txt(m - 6, i * cell + cell / 2 + 3, t, { a: "end", s: 9, w: 700, f: MU }));
  (items.length >= 3 ? items : ["A", "B", "C"]).slice(0, 3).forEach((t, i) => s += txt(m + i * cell + cell / 2, cell * n + 14, shorten(t, 4), { a: "middle", s: 8.5, w: 700, f: INK }));
  return el(s, W, H, shDef(id));
}
function dFishbone(items: string[]): string {
  const W = 308, H = 160, sy = 80, hx = 250, id = uid("sh");
  let s = `<line x1="14" y1="${sy}" x2="${hx}" y2="${sy}" stroke="${A}" stroke-width="3"/>`;
  s += `<path d="M${hx} ${sy - 16} L${W - 6} ${sy} L${hx} ${sy + 16} Z" fill="${A}" filter="url(#${id})"/>`;
  const bones = items.slice(0, 4);
  bones.forEach((t, i) => { const up = i % 2 === 0, bx = 40 + Math.floor(i / 2) * 90, by = up ? sy - 52 : sy + 52, jx = bx + 26; s += `<line x1="${bx}" y1="${by}" x2="${jx}" y2="${sy}" stroke="${shadeAt(i, 4)}" stroke-width="2.2"/>`; s += `<rect x="${bx - 30}" y="${by - 11}" width="60" height="22" rx="7" fill="${SURF}" filter="url(#${id})"/>`; s += txt(bx, by + 3.5, shorten(t, 6), { a: "middle", s: 8.5, w: 700, f: INK }); });
  return el(s, W, H, shDef(id));
}
function dLayers(items: string[]): string {
  const W = 280, H = 180, n = Math.min(items.length, 4), lh = (H - 12) / n, id = uid("sh");
  let s = "";
  items.slice(0, 4).forEach((t, i) => { const y = 6 + i * lh, col = shadeAt(i, n), inset = i * 10; s += `<rect x="${20 + inset}" y="${y}" width="${W - 40 - inset * 2}" height="${lh - 8}" rx="7" fill="${col}" filter="url(#${id})"/>`; s += txt(W / 2, y + (lh - 8) / 2 + 3, shorten(t, 14), { a: "middle", s: 9.5, w: 700, f: textOn(col) }); });
  return el(s, W, H, shDef(id));
}
function dGears(items: string[]): string {
  const W = 260, H = 180, id = uid("sh");
  const gear = (cx: number, cy: number, r: number, col: string, teeth: number) => { let g = `<g filter="url(#${id})">`; for (let i = 0; i < teeth; i++) { const a = (i / teeth) * TAU, p = pol(cx, cy, r + 6, a); g += `<rect x="${(p[0] - 4).toFixed(1)}" y="${(p[1] - 4).toFixed(1)}" width="8" height="8" transform="rotate(${(a * 180 / Math.PI).toFixed(1)} ${p[0].toFixed(1)} ${p[1].toFixed(1)})" fill="${col}"/>`; } g += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.4}" fill="${SURF}"/></g>`; return g; };
  const pos: [number, number, number][] = [[86, 78, 40], [172, 66, 30], [150, 132, 24]];
  let s = "";
  pos.forEach((p, i) => { s += gear(p[0], p[1], p[2], shadeAt(i, 3), 9); s += txt(p[0], p[1] + p[2] + 16, shorten(items[i] ?? "", 6), { a: "middle", s: 8.5, w: 700, f: INK }); });
  return el(s, W, H, shDef(id));
}
function dMindmap(items: IconItem[]): string {
  const W = 300, H = 200, cx = 150, cy = 100, id = uid("sh"), hid = uid("h"), gid = uid("g");
  const defs = shDef(id) + shHero(hid) + `<radialGradient id="${gid}" cx="0.5" cy="0.34" r="0.8"><stop offset="0" stop-color="${tintL(0.18)}"/><stop offset="1" stop-color="${A}"/></radialGradient>`;
  const n = items.length; let s = "";
  items.forEach((it, i) => { const a = -Math.PI / 2 + (i / n) * TAU, R = 76, p = pol(cx, cy, R, a), side = p[0] >= cx ? 1 : -1; s += `<path d="M${cx} ${cy} Q${(cx + p[0]) / 2} ${cy} ${p[0].toFixed(1)} ${p[1].toFixed(1)}" fill="none" stroke="${shadeAt(i, n)}" stroke-width="2.4"/>`; const bw = 62, bh = 24; s += `<rect x="${(p[0] - (side > 0 ? 4 : bw - 4)).toFixed(1)}" y="${(p[1] - bh / 2).toFixed(1)}" width="${bw}" height="${bh}" rx="8" fill="${SURF}" filter="url(#${id})"/>`; s += txt(p[0] + side * (bw / 2 - 4) * 0 + (side > 0 ? bw / 2 - 4 : -(bw / 2 - 4)), p[1] + 3.5, shorten(it.label ?? "", 7), { a: "middle", s: 8.5, w: 700, f: INK }); });
  s += `<circle cx="${cx}" cy="${cy}" r="30" fill="url(#${gid})" filter="url(#${hid})"/>`;
  s += icG("bulb", cx, cy, 22, "#fff");
  return el(s, W, H, defs);
}
function dCompareTable(items: string[]): string {
  const W = 300, H = 190, pl = 8, c1 = 150, c2 = 226, id = uid("sh"), rows = items.slice(0, 4);
  let s = `<rect x="${c2 - 8}" y="4" width="82" height="${H - 8}" rx="9" fill="${A}" filter="url(#${id})"/>`;
  s += txt(c1 + 20, 22, "기존", { a: "middle", s: 10, w: 800, f: MU }); s += txt(c2 + 33, 22, "제안", { a: "middle", s: 10, w: 800, f: "#fff" });
  rows.forEach((t, i) => { const y = 40 + i * ((H - 48) / rows.length); s += txt(pl, y + 4, shorten(t, 16), { s: 9, w: 600, f: INK }); s += icG("x", c1 + 20, y, 15, mix(INK, SURF, 0.55)); s += icG("check", c2 + 33, y, 15, "#fff"); if (i) s += `<line x1="${pl}" y1="${y - 12}" x2="${c2 - 14}" y2="${y - 12}" stroke="${FA}"/>`; });
  return el(s, W, H, shDef(id));
}

// ── 추가 플로우(8) ──────────────────────────────────────────────────
function fVSteps(items: StepItem[]): string {
  const W = 280, H = 200, n = Math.min(items.length, 4), rowH = H / n, x = 30, id = uid("sh");
  let s = "";
  items.slice(0, 4).forEach((it, i) => { const cy = rowH * i + rowH / 2; if (i < n - 1) s += `<line x1="${x}" y1="${cy + 15}" x2="${x}" y2="${cy + rowH - 15}" stroke="${mix(A, SURF, 0.7)}" stroke-width="2.5"/>`; s += `<circle cx="${x}" cy="${cy}" r="15" fill="${A}" filter="url(#${id})"/>`; s += txt(x, cy + 3.5, "0" + (i + 1), { a: "middle", s: 9.5, w: 800, f: "#fff", mono: true }); s += `<rect x="${x + 26}" y="${cy - rowH / 2 + 8}" width="${W - x - 40}" height="${rowH - 16}" rx="9" fill="${SURF}" filter="url(#${id})"/>`; s += txt(x + 40, cy - 2, shorten(it.label, 16), { s: 10.5, w: 800, f: INK }); if (it.sub) s += txt(x + 40, cy + 12, shorten(it.sub, 22), { s: 8.5, w: 500, f: MU }); });
  return el(s, W, H, shDef(id));
}
function fMilestone(items: TimelineItem[]): string {
  const W = 308, H = 140, y = 70, pl = 18, pr = 18, n = items.length, step = n > 1 ? (W - pl - pr) / (n - 1) : 0, id = uid("sh");
  let s = `<line x1="${pl}" y1="${y}" x2="${W - pr}" y2="${y}" stroke="${mix(A, SURF, 0.6)}" stroke-width="3"/>`;
  items.forEach((it, i) => { const x = pl + i * step, up = i % 2 === 0; s += `<line x1="${x.toFixed(1)}" y1="${y}" x2="${x.toFixed(1)}" y2="${up ? y - 30 : y + 30}" stroke="${A}" stroke-width="2"/>`; s += `<circle cx="${x.toFixed(1)}" cy="${y}" r="6" fill="${A}" stroke="${SURF}" stroke-width="2"/>`; const fy = up ? y - 52 : y + 34; s += `<rect x="${(x - 34).toFixed(1)}" y="${fy}" width="68" height="20" rx="6" fill="${A}" filter="url(#${id})"/>`; s += txt(x, fy + 13.5, shorten(it.l, 8), { a: "middle", s: 8.5, w: 700, f: "#fff" }); s += txt(x, up ? y + 16 : y - 10, it.d, { a: "middle", s: 8, w: 800, f: MU, mono: true }); });
  return el(s, W, H, shDef(id));
}
function fArrowStack(items: IconItem[]): string {
  const W = 260, H = 200, n = Math.min(items.length, 4), h = (H - 10) / n, id = uid("sh");
  let s = "";
  items.slice(0, 4).forEach((it, i) => { const y = 4 + i * h, w = W - 24 - i * 26, notch = 16; const pth = `M0 ${y} L${w - notch} ${y} L${w} ${y + (h - 6) / 2} L${w - notch} ${y + h - 6} L0 ${y + h - 6} Z`; s += `<path d="${pth}" fill="${shadeAt(i, n)}" filter="url(#${id})"/>`; s += icG(iconAt(i, it.icon), 22, y + (h - 6) / 2, 15, "#fff"); if (it.label) s += txt(40, y + (h - 6) / 2 + 3.5, shorten(it.label, 14), { s: 9.5, w: 700, f: "#fff" }); });
  return el(s, W, H, shDef(id));
}
function fCircleRow(items: IconItem[]): string {
  const W = 308, H = 110, n = items.length, r = 26, cy = 46, step = (W - 24) / n, id = uid("sh"), mk = uid("mk");
  const defs = shDef(id) + `<marker id="${mk}" markerWidth="8" markerHeight="8" refX="4.4" refY="3.4" orient="auto"><path d="M0 0 L6.6 3.4 L0 6.8 Z" fill="${A}"/></marker>`;
  let s = "";
  items.forEach((it, i) => { const cx = 12 + step * i + step / 2; if (i < n - 1) { const nx = 12 + step * (i + 1) + step / 2; s += `<line x1="${(cx + r + 2).toFixed(1)}" y1="${cy}" x2="${(nx - r - 6).toFixed(1)}" y2="${cy}" stroke="${A}" stroke-width="2" marker-end="url(#${mk})"/>`; } const hero = i === n - 1; s += `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${r}" fill="${hero ? A : SURF}" stroke="${A}" stroke-width="${hero ? 0 : 2}" filter="url(#${id})"/>`; s += icG(iconAt(i, it.icon), cx, cy - 3, 17, hero ? "#fff" : A); s += txt(cx, cy + 15, "0" + (i + 1), { a: "middle", s: 7.5, w: 800, f: hero ? "#fff" : A, mono: true }); if (it.label) s += txt(cx, cy + r + 14, shorten(it.label, 7), { a: "middle", s: 8.5, w: 700, f: INK }); });
  return el(s, W, H, defs);
}
function fRibbon(items: IconItem[]): string {
  const W = 308, H = 120, n = items.length, gap = 8, cw = (W - gap * (n - 1)) / n, y = 24, h = 56, tail = 10, id = uid("sh");
  let s = "";
  items.forEach((it, i) => { const x = i * (cw + gap), col = shadeAt(i, n); s += `<path d="M${x} ${y} L${x + cw} ${y} L${x + cw} ${y + h} L${x} ${y + h} L${x + tail} ${y + h / 2} Z" fill="${col}" filter="url(#${id})"/>`; s += `<path d="M${x + cw / 2 - 6} ${y + h} L${x + cw / 2 + 6} ${y + h} L${x + cw / 2} ${y + h + 12} Z" fill="${shadeL(0.4)}"/>`; s += txt(x + cw / 2 + tail / 2, y + h / 2 + 3, shorten(it.label ?? "0" + (i + 1), 8), { a: "middle", s: 9, w: 800, f: "#fff" }); });
  return el(s, W, H, shDef(id));
}
function fTimelineV(items: TimelineItem[]): string {
  const W = 280, H = 210, x = W / 2, n = Math.min(items.length, 4), rowH = H / n, id = uid("sh");
  let s = `<line x1="${x}" y1="6" x2="${x}" y2="${H - 6}" stroke="${mix(A, SURF, 0.66)}" stroke-width="2.5"/>`;
  items.slice(0, 4).forEach((it, i) => { const cy = rowH * i + rowH / 2, left = i % 2 === 0; s += `<circle cx="${x}" cy="${cy}" r="7" fill="${A}" stroke="${SURF}" stroke-width="2.5" filter="url(#${id})"/>`; const bw = 108, bx = left ? x - 18 - bw : x + 18; s += `<rect x="${bx}" y="${cy - 20}" width="${bw}" height="40" rx="9" fill="${SURF}" filter="url(#${id})"/>`; s += `<rect x="${left ? bx : bx}" y="${cy - 20}" width="4" height="40" rx="2" fill="${A}"/>`; s += `<text x="${bx + 12}" y="${cy - 5}" font-size="7.5" font-weight="800" fill="${A}" font-family="${MONO}">${it.d}</text>`; s += txt(bx + 12, cy + 8, shorten(it.l, 12), { s: 9, w: 700, f: INK }); });
  return el(s, W, H, shDef(id));
}
function fSpectrum(items: string[]): string {
  const W = 308, H = 120, y = 46, h = 22, gid = uid("g");
  const defs = `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${tintL(0.45)}"/><stop offset="1" stop-color="${shadeL(0.3)}"/></linearGradient>`;
  let s = `<rect x="14" y="${y}" width="${W - 28}" height="${h}" rx="11" fill="url(#${gid})"/>`;
  const n = items.length, iw = W - 28;
  items.forEach((t, i) => { const cx = 14 + iw * ((i + 0.5) / n); s += `<circle cx="${cx.toFixed(1)}" cy="${y + h / 2}" r="5" fill="${SURF}" stroke="${shadeAt(i, n)}" stroke-width="2.5"/>`; s += txt(cx, y - 8, shorten(t, 8), { a: "middle", s: 8.5, w: 700, f: INK }); s += txt(cx, y + h + 14, "0" + (i + 1), { a: "middle", s: 8, w: 800, f: MU, mono: true }); });
  s += txt(14, y + h + 30, "낮음", { s: 8, f: MU }); s += txt(W - 14, y + h + 30, "높음", { a: "end", s: 8, f: MU });
  return el(s, W, H, defs);
}
function fStageGate(d: FunnelRow[]): string {
  const W = 308, H = 150, n = d.length, gap = 6, cw = (W - gap * (n - 1)) / n, y = 24, id = uid("sh");
  let s = "";
  d.forEach((x, i) => { const bx = i * (cw + gap), h = 96 - i * (72 / Math.max(1, n - 1)), yy = y + (96 - h) / 2, col = shadeAt(i, n); s += `<rect x="${bx.toFixed(1)}" y="${yy.toFixed(1)}" width="${cw.toFixed(1)}" height="${h.toFixed(1)}" rx="8" fill="${col}" filter="url(#${id})"/>`; const tc = textOn(col); s += txt(bx + cw / 2, yy + h / 2 - 4, x.v, { a: "middle", s: 13, w: 800, f: tc, mono: true }); s += txt(bx + cw / 2, yy + h / 2 + 11, shorten(x.l, 6), { a: "middle", s: 8.5, w: 600, f: tc }); if (i < n - 1) s += `<path d="M${bx + cw + 1} ${y + 48} l4 -5 v10 z" fill="${MU}"/>`; });
  return el(s, W, H, shDef(id));
}

// ── 디스패처 ────────────────────────────────────────────────────────
export type AssetKind =
  | "bar" | "stackedBar" | "line" | "area" | "donut" | "waterfall"
  | "process" | "timeline" | "cycle" | "funnel" | "pyramid" | "hub" | "org" | "compare"
  | "chevronFlow" | "semiFan" | "diamondGrid" | "stepsAscend" | "puzzle" | "converge"
  // 추가 차트(10)
  | "radar" | "gauge" | "rings" | "bullet" | "hbar" | "groupBar" | "dotPlot" | "waffle" | "slope" | "bubble"
  // 추가 다이어그램(12)
  | "venn" | "quadrant" | "swot" | "roadmap" | "kanban" | "pipeline" | "matrix" | "fishbone" | "layers" | "gears" | "mindmap" | "compareTable"
  // 추가 플로우(8)
  | "vSteps" | "milestone" | "arrowStack" | "circleRow" | "ribbon" | "timelineV" | "spectrum" | "stageGate";

export const ASSET_KINDS: AssetKind[] = [
  "bar", "stackedBar", "line", "area", "donut", "waterfall",
  "process", "timeline", "cycle", "funnel", "pyramid", "hub", "org", "compare",
  "chevronFlow", "semiFan", "diamondGrid", "stepsAscend", "puzzle", "converge",
  "radar", "gauge", "rings", "bullet", "hbar", "groupBar", "dotPlot", "waffle", "slope", "bubble",
  "venn", "quadrant", "swot", "roadmap", "kanban", "pipeline", "matrix", "fishbone", "layers", "gears", "mindmap", "compareTable",
  "vSteps", "milestone", "arrowStack", "circleRow", "ribbon", "timelineV", "spectrum", "stageGate",
];

/** 각 에셋의 intrinsic 종횡비(h/w) — 레이아웃이 블록 높이를 잡을 때 참고. */
export const ASSET_ASPECT: Record<AssetKind, number> = {
  bar: 175 / 300, stackedBar: 175 / 300, line: 175 / 300, area: 175 / 300, donut: 200 / 260, waterfall: 185 / 300,
  process: 126 / 304, timeline: 140 / 304, cycle: 222 / 260, funnel: 204 / 272, pyramid: 190 / 264, hub: 210 / 262, org: 182 / 304, compare: 200 / 304,
  chevronFlow: 92 / 308, semiFan: 150 / 264, diamondGrid: 124 / 308, stepsAscend: 142 / 308, puzzle: 94 / 310, converge: 210 / 250,
  radar: 210 / 250, gauge: 150 / 250, rings: 200 / 250, bullet: 170 / 300, hbar: 175 / 300, groupBar: 175 / 300, dotPlot: 175 / 300, waffle: 200 / 200, slope: 180 / 260, bubble: 190 / 300,
  venn: 180 / 260, quadrant: 220 / 260, swot: 200 / 280, roadmap: 170 / 304, kanban: 180 / 304, pipeline: 110 / 308, matrix: 200 / 240, fishbone: 160 / 308, layers: 180 / 280, gears: 180 / 260, mindmap: 200 / 300, compareTable: 190 / 300,
  vSteps: 200 / 280, milestone: 140 / 308, arrowStack: 200 / 260, circleRow: 110 / 308, ribbon: 120 / 308, timelineV: 210 / 280, spectrum: 120 / 308, stageGate: 150 / 308,
};

export interface AssetSpec {
  kind: AssetKind;
  data?: unknown[]; // 차트류(bar/line/... ) 데이터
  items?: unknown[]; // 다이어그램/플로우 아이템
  panels?: { left?: ComparePanel; right?: ComparePanel }; // compare 전용
}

// 데모 폴백 — 데이터가 없어도 항상 뭔가 렌더(빈 슬롯 방지).
const DEMO = {
  bar: [{ l: "대학·대단지", v: 82 }, { l: "도심 상권", v: 61 }, { l: "교외", v: 39 }] as BarDatum[],
  stackedBar: [{ l: "1Q", a: 26, b: 18, c: 10 }, { l: "2Q", a: 32, b: 20, c: 9 }, { l: "3Q", a: 38, b: 24, c: 11 }, { l: "4Q", a: 44, b: 26, c: 14 }] as StackDatum[],
  line: [{ l: "M1", v: 12 }, { l: "M2", v: 19 }, { l: "M3", v: 16 }, { l: "M4", v: 28 }, { l: "M5", v: 38 }] as BarDatum[],
  area: [{ l: "21", v: 8 }, { l: "22", v: 14 }, { l: "23", v: 22 }, { l: "24", v: 31 }, { l: "25", v: 40 }] as BarDatum[],
  donut: [{ l: "자사", v: 44 }, { l: "A사", v: 28 }, { l: "B사", v: 18 }, { l: "기타", v: 10 }] as DonutDatum[],
  waterfall: [{ l: "매출", v: 120, t: "total" as const }, { l: "원가", v: -38 }, { l: "판관비", v: -22 }, { l: "금융", v: -8 }, { l: "영업익", v: 52, t: "total" as const }] as WaterDatum[],
  process: ["발굴", "분석", "실행", "검증"],
  timeline: [{ d: "26.1Q", l: "거점 검증", s: "규제 특구" }, { d: "26.3Q", l: "제휴 확장", s: "플랫폼 연동" }, { d: "27.1Q", l: "전국 상용화", s: "양산 개시" }] as TimelineItem[],
  cycle: [{ icon: "database", label: "수집" }, { icon: "chart", label: "분석" }, { icon: "bulb", label: "인사이트" }, { icon: "expand", label: "확장" }] as IconItem[],
  funnel: [{ l: "인지", v: "100%", p: "10만" }, { l: "관심", v: "48%", p: "4.8만" }, { l: "전환", v: "19%", p: "1.9만" }, { l: "재구매", v: "7%", p: "7천" }] as FunnelRow[],
  pyramid: [{ icon: "bulb", l: "비전" }, { icon: "chart", l: "전략" }, { icon: "rocket", l: "실행" }] as PyramidItem[],
  hub: [{ label: "투자" }, { label: "채용" }, { label: "홍보" }, { label: "데이터" }, { label: "제휴" }] as IconItem[],
  org: ["대표", "전략", "제품", "운영", "실무팀"],
  chevronFlow: [{ icon: "search", label: "발굴" }, { icon: "chart", label: "분석" }, { icon: "rocket", label: "실행" }, { icon: "shield", label: "검증" }] as IconItem[],
  semiFan: [{ icon: "bulb" }, { icon: "chart" }, { icon: "users" }, { icon: "rocket" }] as IconItem[],
  diamondGrid: [{ icon: "database", label: "수집" }, { icon: "chart", label: "분석" }, { icon: "users", label: "협업" }, { icon: "rocket", label: "실행" }] as IconItem[],
  stepsAscend: [{ icon: "search", label: "인지" }, { icon: "bulb", label: "관심" }, { icon: "chart", label: "전환" }, { icon: "rocket", label: "확장" }] as IconItem[],
  puzzle: [{}, {}, {}, {}] as IconItem[],
  converge: ["투자", "채용", "홍보", "데이터", "제휴"],
  radar: [{ l: "속도", v: 80 }, { l: "비용", v: 60 }, { l: "품질", v: 90 }, { l: "확장성", v: 70 }, { l: "안정성", v: 85 }] as BarDatum[],
  gauge: [{ l: "달성률", v: 72 }] as BarDatum[],
  rings: [{ l: "매출", v: 78 }, { l: "이익", v: 54 }, { l: "성장", v: 66 }] as BarDatum[],
  bullet: [{ l: "매출", v: 82, t: 90 }, { l: "이익", v: 64, t: 60 }, { l: "NPS", v: 71, t: 80 }] as BulletDatum[],
  hbar: [{ l: "서울", v: 92 }, { l: "경기", v: 74 }, { l: "부산", v: 58 }, { l: "대구", v: 43 }, { l: "광주", v: 31 }] as BarDatum[],
  groupBar: [{ l: "1Q", a: 32, b: 24 }, { l: "2Q", a: 40, b: 30 }, { l: "3Q", a: 47, b: 38 }, { l: "4Q", a: 55, b: 44 }] as GroupDatum[],
  dotPlot: [{ l: "인지", v: 88 }, { l: "고려", v: 62 }, { l: "구매", v: 41 }, { l: "재구매", v: 27 }] as BarDatum[],
  waffle: [{ l: "점유율", v: 64 }] as BarDatum[],
  slope: [{ l: "자사", a: 32, b: 58 }, { l: "경쟁", a: 44, b: 39 }] as GroupDatum[],
  bubble: [{ l: "A", x: 30, y: 70, r: 18 }, { l: "B", x: 60, y: 45, r: 26 }, { l: "C", x: 80, y: 82, r: 12 }] as XYDatum[],
  venn: ["기술", "시장", "기회"],
  quadrant: ["니치", "리더", "진입", "도전"],
  swot: ["내부 우위 요인", "보완 필요 영역", "시장 기회 요인", "외부 위협 요인"],
  roadmap: [{ l: "기획", a: 0, b: 25 }, { l: "개발", a: 20, b: 45 }, { l: "검증", a: 55, b: 25 }, { l: "출시", a: 78, b: 22 }] as GroupDatum[],
  kanban: ["요구 정의", "API 설계", "UI 구현", "QA 테스트", "배포", "문서화"],
  pipeline: [{ icon: "search", label: "발굴" }, { icon: "chart", label: "검토" }, { icon: "shield", label: "승인" }, { icon: "rocket", label: "집행" }] as IconItem[],
  matrix: ["영향도", "긴급도", "우선도"],
  fishbone: ["사람", "공정", "설비", "환경"],
  layers: ["애플리케이션", "서비스 로직", "데이터", "인프라"],
  gears: ["기획", "개발", "운영"],
  mindmap: [{ label: "제품" }, { label: "마케팅" }, { label: "영업" }, { label: "운영" }, { label: "재무" }] as IconItem[],
  compareTable: ["수작업 취합", "단일 소싱", "사후 대응", "높은 비용"],
  vSteps: [{ label: "진단", sub: "현황 데이터 수집" }, { label: "설계", sub: "우선순위 로드맵" }, { label: "실행", sub: "단계별 파일럿" }, { label: "정착", sub: "자동화·개선" }] as StepItem[],
  milestone: [{ d: "1월", l: "착수" }, { d: "3월", l: "MVP" }, { d: "6월", l: "베타" }, { d: "9월", l: "정식" }] as TimelineItem[],
  arrowStack: [{ icon: "search", label: "시장 조사" }, { icon: "bulb", label: "전략 수립" }, { icon: "rocket", label: "실행" }, { icon: "shield", label: "검증" }] as IconItem[],
  circleRow: [{ icon: "database", label: "수집" }, { icon: "chart", label: "분석" }, { icon: "bulb", label: "결정" }, { icon: "rocket", label: "실행" }] as IconItem[],
  ribbon: [{ label: "1단계" }, { label: "2단계" }, { label: "3단계" }, { label: "4단계" }] as IconItem[],
  timelineV: [{ d: "26 Q1", l: "거점 검증" }, { d: "26 Q3", l: "제휴 확장" }, { d: "27 Q1", l: "전국 상용화" }, { d: "27 Q4", l: "흑자 전환" }] as TimelineItem[],
  spectrum: ["도입", "확산", "성숙", "고도화"],
  stageGate: [{ l: "아이디어", v: "120" }, { l: "선별", v: "45" }, { l: "검증", v: "18" }, { l: "출시", v: "6" }] as FunnelRow[],
};

/** 에셋 스펙 + 팔레트 → SVG 마크업 문자열. DeckStage가 dangerouslySetInnerHTML로 렌더. */
export function renderAsset(spec: AssetSpec, pal: Pal): string {
  setPal(pal);
  const k = spec.kind;
  const data = (spec.data && spec.data.length ? spec.data : undefined);
  const items = (spec.items && spec.items.length ? spec.items : undefined);
  switch (k) {
    case "bar": return cBar((data as BarDatum[]) ?? DEMO.bar);
    case "stackedBar": return cStack((data as StackDatum[]) ?? DEMO.stackedBar);
    case "line": return cLine((data as BarDatum[]) ?? DEMO.line);
    case "area": return cArea((data as BarDatum[]) ?? DEMO.area);
    case "donut": return cDonut((data as DonutDatum[]) ?? DEMO.donut);
    case "waterfall": return cWater((data as WaterDatum[]) ?? DEMO.waterfall);
    case "process": return dProcess((items as string[]) ?? DEMO.process);
    case "timeline": return dTimeline((items as TimelineItem[]) ?? DEMO.timeline);
    case "cycle": return sCycle2((items as IconItem[]) ?? DEMO.cycle);
    case "funnel": return sFunnel2((data as FunnelRow[]) ?? DEMO.funnel);
    case "pyramid": return sPyramid2((items as PyramidItem[]) ?? DEMO.pyramid);
    case "hub": return sHub2((items as IconItem[]) ?? DEMO.hub);
    case "org": return sOrg2((items as string[]) ?? DEMO.org);
    case "compare": return dCompare(spec.panels?.left, spec.panels?.right);
    case "chevronFlow": return sChevronFlow((items as IconItem[]) ?? DEMO.chevronFlow);
    case "semiFan": return sSemiFan((items as IconItem[]) ?? DEMO.semiFan);
    case "diamondGrid": return sDiamondGrid((items as IconItem[]) ?? DEMO.diamondGrid);
    case "stepsAscend": return sStepsAscend((items as IconItem[]) ?? DEMO.stepsAscend);
    case "puzzle": return sPuzzle((items as IconItem[]) ?? DEMO.puzzle);
    case "converge": return sConverge((items as string[]) ?? DEMO.converge);
    case "radar": return cRadar((data as BarDatum[]) ?? DEMO.radar);
    case "gauge": return cGauge((data as BarDatum[]) ?? DEMO.gauge);
    case "rings": return cRings((data as BarDatum[]) ?? DEMO.rings);
    case "bullet": return cBullet((data as BulletDatum[]) ?? DEMO.bullet);
    case "hbar": return cHBar((data as BarDatum[]) ?? DEMO.hbar);
    case "groupBar": return cGroupBar((data as GroupDatum[]) ?? DEMO.groupBar);
    case "dotPlot": return cDot((data as BarDatum[]) ?? DEMO.dotPlot);
    case "waffle": return cWaffle((data as BarDatum[]) ?? DEMO.waffle);
    case "slope": return cSlope((data as GroupDatum[]) ?? DEMO.slope);
    case "bubble": return cBubble((data as XYDatum[]) ?? DEMO.bubble);
    case "venn": return dVenn((items as string[]) ?? DEMO.venn);
    case "quadrant": return dQuadrant((items as string[]) ?? DEMO.quadrant);
    case "swot": return dSwot((items as string[]) ?? DEMO.swot);
    case "roadmap": return dRoadmap((data as GroupDatum[]) ?? DEMO.roadmap);
    case "kanban": return dKanban((items as string[]) ?? DEMO.kanban);
    case "pipeline": return dPipeline((items as IconItem[]) ?? DEMO.pipeline);
    case "matrix": return dMatrix((items as string[]) ?? DEMO.matrix);
    case "fishbone": return dFishbone((items as string[]) ?? DEMO.fishbone);
    case "layers": return dLayers((items as string[]) ?? DEMO.layers);
    case "gears": return dGears((items as string[]) ?? DEMO.gears);
    case "mindmap": return dMindmap((items as IconItem[]) ?? DEMO.mindmap);
    case "compareTable": return dCompareTable((items as string[]) ?? DEMO.compareTable);
    case "vSteps": return fVSteps((items as StepItem[]) ?? DEMO.vSteps);
    case "milestone": return fMilestone((items as TimelineItem[]) ?? DEMO.milestone);
    case "arrowStack": return fArrowStack((items as IconItem[]) ?? DEMO.arrowStack);
    case "circleRow": return fCircleRow((items as IconItem[]) ?? DEMO.circleRow);
    case "ribbon": return fRibbon((items as IconItem[]) ?? DEMO.ribbon);
    case "timelineV": return fTimelineV((items as TimelineItem[]) ?? DEMO.timelineV);
    case "spectrum": return fSpectrum((items as string[]) ?? DEMO.spectrum);
    case "stageGate": return fStageGate((data as FunnelRow[]) ?? DEMO.stageGate);
    default: return el("", 300, 175);
  }
}
