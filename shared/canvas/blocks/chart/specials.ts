import { z } from "zod";
import { esc, niceScale } from "../../kit";
import { list, num, optionalNum, optionalText, text, tone, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { arcPath, caption, catColor, catSoft, clamp, css, fit, fmt, heading, legendItem, listCss, mix, n1, pct, short, sum, textPx } from "./_parts-kit";

/** Progress, target and flow charts the model fills with numbers it has: bullet, sankey, progress rings, progress bars and radial bars. */
const GOOD = "#cdeadd", MID = "#f9e7c4", BAD = "#f6d4d8";

// ---- bullet ------------------------------------------------------------------------------------------------------------------------
const bulletRow = z.object({ label: text(28), actual: num, target: num, poor: optionalNum, ok: optionalNum, max: optionalNum, unit: unit.optional(), lowerIsBetter: z.boolean().optional() }).strip();

export const bulletChart = defineAsset({
  type: "bullet_chart", category: "chart", width: "half",
  use: "Each KPI as one bar against its target tick, on poor, ok and good bands (revenue vs plan, churn vs limit), one to six rows.",
  useKo: "KPI마다 실적 막대를 목표선과 미흡·보통·양호 구간 위에 한 줄로 그립니다(매출 대 계획, 이탈률 대 한도 등). 1~6행.",
  tags: ["bullet", "kpi", "target", "scorecard", "actual vs target", "불릿", "목표", "달성", "스코어카드"],
  notes: "rows: label, actual, target, optional poor (worse threshold), ok (target-level threshold) and max (end of the scale); defaults follow the target. lowerIsBetter flips the bands for churn, cost, time. Each row may carry its own unit.",
  fields: { rows: list(bulletRow, 1, 6), unit: unit.default("count"), lowerIsBetter: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Q3 scorecard", caption: "Revenue and NPS beat plan; churn is just over the limit.", rows: [
    { label: "Revenue", actual: 4600000, target: 4200000, poor: 2500000, ok: 4200000, max: 5500000, unit: "usd" },
    { label: "New customers", actual: 1840, target: 2000, poor: 1200, ok: 2000, max: 2600, unit: "count" },
    { label: "Gross margin", actual: 61, target: 65, poor: 50, ok: 65, max: 80, unit: "percent" },
    { label: "Monthly churn", actual: 3.4, target: 3, poor: 4.5, ok: 3, max: 6, unit: "percent", lowerIsBetter: true },
    { label: "NPS", actual: 52, target: 50, poor: 30, ok: 50, max: 70, unit: "count" },
    { label: "First response (hours)", actual: 2.6, target: 4, poor: 8, ok: 4, max: 10, unit: "count", lowerIsBetter: true }] },
  render(b, { ko, T }) {
    const rows = b.rows.map(r => {
      const lower = r.lowerIsBetter ?? b.lowerIsBetter ?? false, u = r.unit ?? b.unit;
      const ok = r.ok ?? r.target, poor = r.poor ?? (lower ? ok * 1.25 : ok * 0.6);
      const end = Math.max(r.max ?? 0, lower ? Math.max(poor, ok) * 1.3 : Math.max(ok, r.target) * 1.25, r.actual * 1.06, r.target * 1.04);
      const lo = Math.min(0, r.actual, r.target, ok, poor), span = end - lo || 1, at = (v: number) => clamp(((v - lo) / span) * 100, 0, 100);
      // Band edges left to right and the rating of each band; a lower-is-better row reads good, ok, poor.
      const edges = lower ? [lo, Math.min(ok, poor), Math.max(ok, poor), end] : [lo, Math.min(poor, ok), Math.max(poor, ok), end], tint = lower ? [GOOD, MID, BAD] : [BAD, MID, GOOD];
      const rate = r.actual < edges[1] ? 0 : r.actual < edges[2] ? 1 : 2, dot = (lower ? ["var(--green)", "var(--amber)", "var(--red)"] : ["var(--red)", "var(--amber)", "var(--green)"])[rate];
      const bands = [0, 1, 2].map(i => `<i style="left:${n1(at(edges[i]))}%;width:${n1(at(edges[i + 1]) - at(edges[i]))}%;background:${tint[i]}"></i>`).join("");
      return `<div class="a-r"><div class="a-h"><span class="a-n">${esc(r.label)}</span><span class="a-v"><i style="width:8px;height:8px;border-radius:50%;align-self:center;background:${dot}"></i><b>${esc(short(r.actual, u, ko))}</b><small>${esc(`${T("target", "목표")} ${short(r.target, u, ko)}`)}</small></span></div>`
        + `<div class="a-bar"><div class="a-bands">${bands}<i class="a-act" style="left:${n1(at(lo))}%;width:${n1(at(r.actual) - at(lo))}%"></i></div><i class="a-tg" style="left:${n1(at(r.target))}%"></i></div></div>`;
    }).join("");
    const key = `<div class="a-lg"><span><i style="background:${BAD}"></i>${T("Poor", "미흡")}</span><span><i style="background:${MID}"></i>${T("OK", "보통")}</span><span><i style="background:${GOOD}"></i>${T("Good", "양호")}</span><span><i style="width:14px;height:6px;background:var(--ink)"></i>${T("Actual", "실적")}</span><span><i style="width:3px;height:14px;margin:0 8px 0 5px;background:var(--ink)"></i>${T("Target", "목표")}</span></div>`;
    return `${heading(b)}<div class="a-rows">${rows}</div>${key}${caption(b)}`;
  },
  summary: b => `${b.title ?? "Bullet chart"}: ${b.rows.map((r: { label: string; actual: number; target: number; unit?: string }) => `${r.label} ${short(r.actual, r.unit ?? b.unit, false)} vs target ${short(r.target, r.unit ?? b.unit, false)}`).join("; ")}.`,
  css: css("bullet_chart", ".fpc .a-bullet_chart .a-rows{display:grid;gap:15px}.fpc .a-bullet_chart .a-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:6px}.fpc .a-bullet_chart .a-n{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-weight:700;color:var(--ink2)}.fpc .a-bullet_chart .a-v{flex:none;display:flex;align-items:baseline;gap:6px;font-size:12px;color:var(--muted)}.fpc .a-bullet_chart .a-v b{font-size:15px;font-weight:800;color:var(--ink)}.fpc .a-bullet_chart .a-bar{position:relative;height:22px}.fpc .a-bullet_chart .a-bands{position:absolute;inset:0;border-radius:6px;overflow:hidden}.fpc .a-bullet_chart .a-bands i{position:absolute;top:0;bottom:0}.fpc .a-bullet_chart .a-bands .a-act{top:7px;bottom:7px;background:var(--ink);border-radius:0 3px 3px 0}.fpc .a-bullet_chart .a-tg{position:absolute;top:-3px;bottom:-3px;width:3px;margin-left:-1.5px;border-radius:2px;background:var(--ink)}", "lg cap"),
});

// ---- sankey ------------------------------------------------------------------------------------------------------------------------
const nodeName = z.preprocess(v => (v && typeof v === "object" ? ((v as Record<string, unknown>).name ?? (v as Record<string, unknown>).id ?? (v as Record<string, unknown>).label) : v), text(40));
const flow = z.preprocess(v => (v && typeof v === "object" ? { from: (v as Record<string, unknown>).from ?? (v as Record<string, unknown>).source, to: (v as Record<string, unknown>).to ?? (v as Record<string, unknown>).target, value: (v as Record<string, unknown>).value } : v), z.object({ from: text(40), to: text(40), value: num }).strip());

interface SankeyNode { name: string; col: number; in: number; out: number; val: number; y: number; h: number; order: number }
interface SankeyLink { from: number; to: number; value: number; sy: number; ty: number }
/** Deterministic layout: columns from the longest path (at most four), order by a few barycentre sweeps, one scale for every column, ribbons stacked inside each node. */
function sankeyLayout(names: readonly string[], links: readonly { from: string; to: string; value: number }[], H: number) {
  const idx = new Map(names.map((n, i) => [n, i])), edges = links.map(l => ({ from: idx.get(l.from)!, to: idx.get(l.to)!, value: l.value }));
  // Drop an edge that closes a loop (depth-first from the nodes nothing flows into).
  const out: number[][] = names.map(() => []), state = names.map(() => 0), keep = new Set<number>();
  edges.forEach((e, i) => out[e.from].push(i));
  const visit = (n: number) => { state[n] = 1; for (const i of out[n]) { const t = edges[i].to; if (state[t] === 1) continue; keep.add(i); if (state[t] === 0) visit(t); } state[n] = 2; };
  const hasIn = new Set(edges.map(e => e.to));
  names.forEach((_, n) => { if (!hasIn.has(n) && state[n] === 0) visit(n); });
  names.forEach((_, n) => { if (state[n] === 0) visit(n); });
  const dag = edges.filter((_, i) => keep.has(i));
  const depth = names.map(() => 0);
  for (let pass = 0; pass < names.length; pass++) for (const e of dag) if (depth[e.to] < depth[e.from] + 1) depth[e.to] = depth[e.from] + 1;
  const col = depth.map(d => Math.min(d, 3)), used = dag.filter(e => col[e.to] > col[e.from]);
  const nodes: SankeyNode[] = names.map((name, i) => ({ name, col: col[i], in: sum(used.filter(e => e.to === i).map(e => e.value)), out: sum(used.filter(e => e.from === i).map(e => e.value)), val: 0, y: 0, h: 0, order: i }));
  nodes.forEach(n => { n.val = Math.max(n.in, n.out); });
  const live = nodes.filter(n => n.val > 0);
  if (!live.length) return { nodes: live, ribbons: [] as SankeyLink[], k: 0, cols: 0, all: nodes };
  const cols = Math.max(...live.map(n => n.col)) + 1, byCol = Array.from({ length: cols }, (_, c) => live.filter(n => n.col === c));
  // Barycentre sweeps: a node sits near the weighted mean position of what feeds it (left to right), then of what it feeds (right to left).
  const pos = new Map<SankeyNode, number>();
  byCol.forEach(c => c.forEach((n, i) => pos.set(n, i)));
  const sweep = (c: SankeyNode[], side: "in" | "out") => {
    const key = (n: SankeyNode) => { const ws = used.filter(e => (side === "in" ? e.to : e.from) === nodes.indexOf(n)); const tot = sum(ws.map(e => e.value)); return tot > 0 ? sum(ws.map(e => e.value * (pos.get(nodes[side === "in" ? e.from : e.to]) ?? 0))) / tot : pos.get(n)!; };
    c.sort((a, b) => key(a) - key(b) || a.order - b.order).forEach((n, i) => pos.set(n, i));
  };
  for (let it = 0; it < 4; it++) { for (let c = 1; c < cols; c++) sweep(byCol[c], "in"); for (let c = cols - 2; c >= 0; c--) sweep(byCol[c], "out"); }
  const gap = 12, usable = H - 12;
  const k = Math.min(...byCol.map(c => (usable - gap * (c.length - 1)) / Math.max(1e-9, sum(c.map(n => n.val)))));
  byCol.forEach(c => { c.forEach(n => { n.h = Math.max(3, n.val * k); }); const total = sum(c.map(n => n.h)) + gap * (c.length - 1); let y = 6 + (usable - total) / 2; c.forEach(n => { n.y = y; y += n.h + gap; }); });
  const ribbons: SankeyLink[] = used.filter(e => nodes[e.from].val > 0 && nodes[e.to].val > 0).map(e => ({ from: e.from, to: e.to, value: e.value, sy: 0, ty: 0 }));
  nodes.forEach((n, i) => {
    let y = n.y; ribbons.filter(l => l.from === i).sort((a, b) => nodes[a.to].y - nodes[b.to].y).forEach(l => { l.sy = y; y += l.value * k; });
    y = n.y; ribbons.filter(l => l.to === i).sort((a, b) => nodes[a.from].y - nodes[b.from].y).forEach(l => { l.ty = y; y += l.value * k; });
  });
  return { nodes: live, ribbons, k, cols, all: nodes };
}

export const sankeyChart = defineAsset({
  type: "sankey_chart", category: "chart", width: "full",
  use: "Flows between two to four columns of nodes with ribbon thickness by value (revenue to profit, traffic sources to outcomes, budget allocation).",
  useKo: "2~4개 열의 항목 사이 흐름을 값에 비례한 리본으로 그립니다(매출→이익, 유입 경로→결과, 예산 배분 등).",
  tags: ["sankey", "flow", "allocation", "funnel", "ribbon", "산키", "흐름", "배분", "리본"],
  notes: "links: from, to, value (a node is named by its text; columns follow the longest path from the sources, at most four). nodes is optional and only sets the order and names; a loop or a link inside one column is left out. Up to 16 nodes and 30 links.",
  fields: { links: list(flow, 1, 30), nodes: list(nodeName, 2, 16).optional(), unit: unit.default("count"), caption: optionalText(120) },
  sample: { title: "From revenue to operating profit, FY2026", unit: "usd", caption: "Gross margin is 55%; operating profit is 15% of revenue.", links: [
    { from: "Hardware", to: "Revenue", value: 620000000 }, { from: "Software", to: "Revenue", value: 410000000 }, { from: "Services", to: "Revenue", value: 170000000 },
    { from: "Revenue", to: "Cost of sales", value: 540000000 }, { from: "Revenue", to: "Gross profit", value: 660000000 },
    { from: "Gross profit", to: "R&D", value: 220000000 }, { from: "Gross profit", to: "Sales & marketing", value: 180000000 }, { from: "Gross profit", to: "G&A", value: 80000000 }, { from: "Gross profit", to: "Operating profit", value: 180000000 }] },
  render(b, { ko, T }) {
    const names: string[] = [];
    const none = `${heading(b)}<p class="a-cap">${esc(T("No flows to draw.", "그릴 흐름이 없습니다."))}</p>`;
    for (const n of b.nodes ?? []) if (!names.includes(n)) names.push(n);
    const links: { from: string; to: string; value: number }[] = [];
    for (const l of b.links) {
      if (!(l.value > 0) || l.from === l.to) continue;
      const need = [l.from, l.to].filter((n, i, a) => !names.includes(n) && a.indexOf(n) === i).length;
      if (names.length + need > 16) continue;
      for (const n of [l.from, l.to]) if (!names.includes(n)) names.push(n);
      links.push(l);
    }
    if (!links.length) return none;
    const rough = sankeyLayout(names, links, 400);
    if (!rough.ribbons.length) return none;
    const mx = Math.max(...Array.from({ length: rough.cols }, (_, c) => rough.nodes.filter(n => n.col === c).length));
    const H = clamp(90 + 40 * mx, 250, 460), L = sankeyLayout(names, links, H), W = 620, ML = 108, MR = 132, NW = 12, step = L.cols > 1 ? (W - ML - MR - NW) / (L.cols - 1) : 0;
    const X = (c: number) => ML + c * step, color = (i: number) => catSoft(i);
    const ribbons = L.ribbons.map(r => {
      const t = Math.max(0.6, r.value * L.k), x0 = X(L.all[r.from].col) + NW, x1 = X(L.all[r.to].col), xm = (x0 + x1) / 2, y0 = r.sy, y1 = r.ty;
      return `<path d="M${n1(x0)},${n1(y0)}C${n1(xm)},${n1(y0)} ${n1(xm)},${n1(y1)} ${n1(x1)},${n1(y1)}L${n1(x1)},${n1(y1 + t)}C${n1(xm)},${n1(y1 + t)} ${n1(xm)},${n1(y0 + t)} ${n1(x0)},${n1(y0 + t)}Z" fill="${color(r.from)}" fill-opacity=".3"/>`;
    }).join("");
    const boxes = L.nodes.map(n => `<rect x="${n1(X(n.col))}" y="${n1(n.y)}" width="${NW}" height="${n1(n.h)}" rx="2.5" fill="${color(n.order)}"/>`).join("");
    const labels = L.nodes.map(n => {
      const first = n.col === 0, last = n.col === L.cols - 1 && L.cols > 1, x = first ? X(n.col) - 7 : X(n.col) + NW + 7, anchor = first ? "end" : "start", v = short(n.val, b.unit, ko);
      const budget = first ? ML - 12 : last ? MR - 12 : step - NW - 16, cy = n.y + n.h / 2, halo = first || last ? "" : " a-hl";
      if (n.h >= 24) return `<text x="${n1(x)}" y="${n1(cy - 3)}" text-anchor="${anchor}" class="a-nm${halo}">${esc(fit(n.name, budget, 11.5, 750))}</text><text x="${n1(x)}" y="${n1(cy + 11)}" text-anchor="${anchor}" class="a-mu${halo}">${esc(v)}</text>`;
      const vw = textPx(v, 10.5, 700) + 5;
      return `<text x="${n1(x)}" y="${n1(cy + 4)}" text-anchor="${anchor}" class="a-nm${halo}">${esc(fit(n.name, budget - vw, 11.5, 750))}<tspan class="a-sv" dx="5">${esc(v)}</tspan></text>`;
    }).join("");
    return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${ribbons}${boxes}${labels}</svg>${caption(b)}`;
  },
  summary: b => { const from = new Set<string>(b.links.map((l: { from: string }) => l.from)), to = new Set<string>(b.links.map((l: { to: string }) => l.to)); const top = [...b.links].sort((a: { value: number }, c: { value: number }) => c.value - a.value).slice(0, 4); return `${b.title ?? "Sankey chart"}: ${b.links.length} flows between ${new Set([...from, ...to]).size} nodes; largest ${top.map((l: { from: string; to: string; value: number }) => `${l.from} → ${l.to} ${short(l.value, b.unit, false)}`).join(", ")}.`; },
  css: css("sankey_chart", ".fpc .a-sankey_chart svg{max-width:760px}.fpc .a-sankey_chart .a-nm{font-size:11.5px;font-weight:750;fill:var(--ink)}.fpc .a-sankey_chart .a-sv{font-size:10.5px;font-weight:700;fill:var(--muted)}.fpc .a-sankey_chart .a-hl{paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round}", "mu cap"),
});

// ---- progress rings ----------------------------------------------------------------------------------------------------------------
const ring = z.object({ label: text(24), value: num, goal: num, suffix: optionalText(10) }).strip();
const unitless = (v: number) => (Math.abs(v) >= 1e6 ? short(v, "count", false) : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(+v.toFixed(1)));

export const progressRings = defineAsset({
  type: "progress_rings", category: "chart", width: "half",
  use: "One to four concentric rings, each a value against its goal, with an overall summary in the centre (daily goals, quotas).",
  useKo: "목표 대비 값을 1~4개의 동심원 링으로 보여 주고 가운데에 전체 달성률을 표시합니다(일일 목표, 할당량 등).",
  tags: ["rings", "activity", "goal", "progress", "concentric", "링", "활동", "목표", "달성률"],
  notes: "rings: label, value, goal and an optional suffix for the unit (kcal, min). A ring past its goal is drawn full and keeps its true percent. centerLabel names the average shown in the centre.",
  fields: { rings: list(ring, 1, 4), centerLabel: optionalText(20), caption: optionalText(120) },
  sample: { title: "Today's goals", rings: [{ label: "Move", value: 420, goal: 600, suffix: "kcal" }, { label: "Exercise", value: 25, goal: 30, suffix: "min" }, { label: "Stand", value: 9, goal: 12, suffix: "hr" }], caption: "Two short walks would close all three rings." },
  render(b, { T }) {
    const C = 100, n = b.rings.length, stroke = n <= 2 ? 18 : n === 3 ? 15 : 12, pitch = stroke + 4, r0 = 90 - stroke / 2 + 2;
    const frac = b.rings.map(r => (r.goal > 0 ? Math.max(0, r.value) / r.goal : 0)), avg = sum(frac.map(f => Math.min(1, f))) / n, inner = r0 - (n - 1) * pitch - stroke / 2 - 3;
    const arcs = b.rings.map((_, i) => {
      const r = r0 - i * pitch, c = catColor(i), f = Math.min(1, frac[i]);
      const track = `<circle cx="${C}" cy="${C}" r="${n1(r)}" fill="none" stroke="${mix(c, "#ffffff", 0.84)}" stroke-width="${stroke}"/>`;
      if (f <= 0) return track;
      const prog = f >= 0.9999 ? `<circle cx="${C}" cy="${C}" r="${n1(r)}" fill="none" stroke="${c}" stroke-width="${stroke}"/>` : `<path d="${arcPath(C, C, r, 0, f * Math.PI * 2)}" fill="none" stroke="${c}" stroke-width="${stroke}" stroke-linecap="round"/>`;
      // Past the goal the ring is full and a darker second lap shows how far over (capped at one more lap).
      const extra = frac[i] > 1.0001 ? `<path d="${arcPath(C, C, r, 0, Math.min(1, frac[i] - 1) * Math.PI * 2)}" fill="none" stroke="${mix(c, "#101d24", 0.38)}" stroke-width="${stroke}" stroke-linecap="round"/>` : "";
      return `${track}${prog}${extra}`;
    }).join("");
    const big = `${Math.round(avg * 100)}%`, fs = clamp(inner * 0.62, 13, 30), label = fit(b.centerLabel ?? (n === 1 ? b.rings[0].label : T("average", "평균")), inner * 2 - 6, 11);
    const centre = `<text x="${C}" y="${n1(C - 2)}" text-anchor="middle" dominant-baseline="central" font-size="${n1(fs)}" class="a-big">${esc(big)}</text><text x="${C}" y="${n1(C + fs * 0.62 + 2)}" text-anchor="middle" dominant-baseline="central" class="a-mu" font-size="10.5">${esc(label)}</text>`;
    const items = b.rings.map((r, i) => legendItem(catColor(i), r.label, `${unitless(r.value)} / ${unitless(r.goal)}${r.suffix ? ` ${r.suffix}` : ""}`, pct(frac[i]))).join("");
    return `${heading(b)}<div class="a-row"><svg viewBox="0 0 200 200" width="100%" aria-hidden="true">${arcs}${centre}</svg><ul class="a-ll">${items}</ul></div>${caption(b)}`;
  },
  summary: b => `${b.title ?? "Progress rings"}: ${b.rings.map((r: { label: string; value: number; goal: number; suffix?: string }) => `${r.label} ${unitless(r.value)} of ${unitless(r.goal)}${r.suffix ? ` ${r.suffix}` : ""} (${pct(r.goal > 0 ? Math.max(0, r.value) / r.goal : 0)})`).join("; ")}.`,
  css: css("progress_rings", ".fpc .a-progress_rings .a-row{display:flex;flex-wrap:wrap;align-items:center;gap:14px 24px}.fpc .a-progress_rings .a-row svg{flex:0 1 200px;width:200px;max-width:100%}.fpc .a-progress_rings .a-row .a-ll{flex:1 1 190px}.fpc .a-progress_rings .a-big{font-weight:800;fill:var(--ink);letter-spacing:-.02em}", "mu cap") + listCss("progress_rings"),
});

// ---- progress bars -----------------------------------------------------------------------------------------------------------------
const TONES: Record<string, [string, string]> = { up: ["#118558", "#18b67e"], warn: ["#b7791f", "#f0b429"], down: ["#cf3545", "#f08a8f"], info: ["#2f5fd6", "#7aa2ff"], neutral: ["#5c6870", "#9aa2a7"] };
const bar = z.object({ label: text(30), value: num, goal: optionalNum, status: tone.optional() }).strip();

export const progressBars = defineAsset({
  type: "progress_bars", category: "chart", width: "half",
  use: "Two to ten labelled progress bars, each a value against its goal with a percent and an optional status colour (tasks, quotas, funding).",
  useKo: "목표 대비 진행률을 라벨 붙은 막대 2~10개로 보여 주며 퍼센트와 상태 색을 선택적으로 넣습니다(과제, 할당량, 모금 등).",
  tags: ["progress", "bar", "goal", "completion", "status", "진행률", "진척", "목표 달성", "막대"],
  notes: "bars: label, value, goal (default 100, so percent values need none) and status up, warn, down, info or neutral. Without a status a bar is blue and turns green at its goal. One unit for the whole block.",
  fields: { bars: list(bar, 2, 10), unit: unit.default("count"), caption: optionalText(120) },
  sample: { title: "Sprint 42 progress, story points", unit: "count", caption: "Mobile is the risk: 5 of 18 points with three days left.", bars: [{ label: "Auth service", value: 21, goal: 21 }, { label: "Billing migration", value: 13, goal: 20, status: "warn" }, { label: "Search ranking", value: 8, goal: 16 }, { label: "Mobile release", value: 5, goal: 18, status: "down" }, { label: "Docs refresh", value: 9, goal: 10 }] },
  render(b, { ko }) {
    const rows = b.bars.map(r => {
      const goal = r.goal && r.goal > 0 ? r.goal : 100, f = Math.max(0, r.value) / goal, key = r.status ?? (f >= 1 ? "up" : "info"), [c1, c2] = TONES[key] ?? TONES.info;
      // A percent with no goal is its own percent: shown once.
      const figures = b.unit === "percent" && !(r.goal && r.goal > 0) ? `<em style="color:${c1}">${esc(fmt(r.value, b.unit, ko))}</em>` : `<b>${esc(fmt(r.value, b.unit, ko))}</b><small>/ ${esc(fmt(goal, b.unit, ko))}</small><em style="color:${c1}">${Math.round(f * 100)}%</em>`;
      return `<div class="a-r"><div class="a-h"><span class="a-n">${esc(r.label)}</span><span class="a-v">${figures}</span></div><div class="a-tr"><i style="width:${n1(clamp(f, 0, 1) * 100)}%;background:linear-gradient(90deg,${c1},${c2})"></i></div></div>`;
    }).join("");
    return `${heading(b)}<div class="a-rows">${rows}</div>${caption(b)}`;
  },
  summary: b => `${b.title ?? "Progress bars"}: ${b.bars.map((r: { label: string; value: number; goal?: number }) => { const g = r.goal && r.goal > 0 ? r.goal : 100; return `${r.label} ${fmt(r.value, b.unit, false)} of ${fmt(g, b.unit, false)} (${Math.round((Math.max(0, r.value) / g) * 100)}%)`; }).join("; ")}.`,
  css: css("progress_bars", ".fpc .a-progress_bars .a-rows{display:grid;gap:14px}.fpc .a-progress_bars .a-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:6px}.fpc .a-progress_bars .a-n{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-weight:700;color:var(--ink2)}.fpc .a-progress_bars .a-v{flex:none;display:flex;align-items:baseline;gap:5px;font-size:12px;color:var(--muted)}.fpc .a-progress_bars .a-v b{font-size:14px;font-weight:800;color:var(--ink)}.fpc .a-progress_bars .a-v em{min-width:38px;text-align:right;font-style:normal;font-size:13.5px;font-weight:800}.fpc .a-progress_bars .a-tr{height:9px;border-radius:5px;background:#eceeec;overflow:hidden}.fpc .a-progress_bars .a-tr i{display:block;height:100%;border-radius:5px}", "cap"),
});

// ---- radial bars -------------------------------------------------------------------------------------------------------------------
export const radialBarChart = defineAsset({
  type: "radial_bar_chart", category: "chart", width: "half",
  use: "Two to eight values ranked as concentric circular bars, each labelled at the start of its arc (a compact ranking).",
  useKo: "2~8개 값을 큰 순서대로 동심원 호 막대로 보여 주며 각 호의 시작점에 이름과 값을 붙입니다(간결한 순위).",
  tags: ["radial bar", "circular bar", "ranking", "arc", "polar", "방사형 막대", "원형 막대", "순위", "호"],
  notes: "bars: label and value, ranked largest first on the outside. max is the value of a full three-quarter turn (default: the largest value rounded up).",
  fields: { bars: list(z.object({ label: text(24), value: num }).strip(), 2, 8), unit: unit.default("count"), max: optionalNum, caption: optionalText(120) },
  sample: { title: "Support tickets by category, this week", unit: "count", caption: "Billing and login questions are 46% of the queue.", bars: [{ label: "Billing", value: 412 }, { label: "Login & access", value: 356 }, { label: "Performance", value: 281 }, { label: "Integrations", value: 214 }, { label: "Mobile app", value: 167 }, { label: "Other", value: 96 }] },
  render(b, { ko }) {
    const C = 150, n = b.bars.length, sorted = [...b.bars].sort((p, q) => q.value - p.value), top = Math.max(...sorted.map(s => s.value), 1), max = niceScale(0, b.max ?? top, 4).max;
    const R0 = 134, pitch = Math.min(30, (R0 - 28) / Math.max(1, n - 1)), stroke = Math.min(24, pitch - 4), span = Math.PI * 1.5, fs = clamp(stroke * 0.95, 9.5, 12);
    const rings = sorted.map((s, i) => {
      const r = R0 - i * pitch, f = clamp(Math.max(0, s.value) / max, 0, 1), c = catColor(0), cy = C - r;
      const value = short(s.value, b.unit, ko), x = C - stroke / 2 - 7;
      const name = fit(s.label, x - 8 - textPx(value, fs, 800) - 6, fs, 700);
      return `<path d="${arcPath(C, C, r, 0, span)}" fill="none" stroke="#eef0ee" stroke-width="${n1(stroke)}" stroke-linecap="round"/>`
        + (f > 0 ? `<path d="${arcPath(C, C, r, 0, Math.max(0.02, f) * span)}" fill="none" stroke="${mix(c, "#7aa2ff", i / Math.max(1, n - 1) * 0.7)}" stroke-width="${n1(stroke)}" stroke-linecap="round"/>` : "")
        + `<text x="${n1(x)}" y="${n1(cy)}" text-anchor="end" dominant-baseline="central" font-size="${n1(fs)}" font-weight="700" class="a-nm">${esc(name)}<tspan dx="6" font-weight="800" class="a-sv">${esc(value)}</tspan></text>`;
    }).join("");
    return `${heading(b)}<svg viewBox="0 0 300 300" width="100%" aria-hidden="true">${rings}</svg>${caption(b)}`;
  },
  summary: b => `${b.title ?? "Radial bar chart"}: ${[...b.bars].sort((p: { value: number }, q: { value: number }) => q.value - p.value).map((s: { label: string; value: number }) => `${s.label} ${short(s.value, b.unit, false)}`).join(", ")}.`,
  css: css("radial_bar_chart", ".fpc .a-radial_bar_chart svg{max-width:400px}.fpc .a-radial_bar_chart .a-nm{fill:var(--ink2)}.fpc .a-radial_bar_chart .a-sv{fill:var(--ink)}", "cap"),
});

export const ASSETS: readonly AnyAsset[] = [bulletChart, sankeyChart, progressRings, progressBars, radialBarChart];
