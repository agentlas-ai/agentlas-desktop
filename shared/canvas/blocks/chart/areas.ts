import { z } from "zod";
import { esc } from "../../kit";
import { list, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { BLUE, LINES, SERIES, ZERO, axis, barPath, cap, css, curve, drawLabels, fitLabels, fitScale, frame, legend, maxTickWidth, nn, nullable, p, pointLabels, runs, short, svg, tw, yGrid } from "./_cartesian";

const line = (max: number, min = 1, points = 24) => list(z.object({ name: text(30), values: list(nullable, 2, points) }).strip(), min, max);
const pad = (values: (number | null)[], n: number) => Array.from({ length: n }, (_, i) => values[i] ?? null);
const ends = (b: { labels: string[] }) => `${b.labels[0]}–${b.labels[b.labels.length - 1]}`;
const trend = (b: { series: { name: string; values: (number | null)[] }[]; unit: string; labels: string[] }) => b.series.map(s => { const v = pad(s.values, b.labels.length).filter(nn); return `${s.name} ${short(v[0] ?? 0, b.unit, false)} → ${short(v[v.length - 1] ?? 0, b.unit, false)}`; }).join("; ");

/* ---------------------------------------------------------------- area_chart */
export const areaChart = defineAsset({
  type: "area_chart", category: "chart", width: "half",
  use: "A filled area under one to three series over ordered labels, for volume or accumulation over time.",
  useKo: "라벨 순서에 따른 한~세 개 계열을 면적으로 채워 양과 누적 추이를 보여 줍니다.",
  tags: ["area", "filled", "volume", "trend", "time series", "면적", "영역 차트", "추이", "누적"],
  notes: "labels up to 24, series up to 3 with one value per label (null leaves a gap). smooth rounds the curve; unit sets the number format. A single series prints its last value.",
  fields: { labels: list(text(14), 2, 24), series: line(3), unit: unit.default("count"), smooth: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Weekly signups and activations", labels: ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6", "Wk 7", "Wk 8", "Wk 9", "Wk 10"], unit: "count", smooth: true, series: [{ name: "Signups", values: [820, 910, 1040, 980, 1210, 1380, 1295, 1510, 1640, 1820] }, { name: "Activations", values: [410, 468, 530, 521, 640, 745, 702, 836, 915, 1043] }], caption: "Activation rose from 50% to 57% as signups more than doubled." },
  render(b, { uid, ko }) {
    const n = b.labels.length, W = 460, H = 232, T = 20, B = 28, R = 16, rows = b.series.map((s: { values: (number | null)[] }) => pad(s.values, n)), all = rows.flat().filter(nn);
    const scale = axis(Math.min(0, ...all), Math.max(0, ...all)), L = Math.ceil(maxTickWidth(scale, b.unit, ko)) + 12;
    const X = (i: number) => L + (i * (W - L - R)) / (n - 1), Y = (v: number) => T + ((scale.max - v) / (scale.max - scale.min)) * (H - T - B), base = Y(Math.max(0, scale.min)), one = rows.length === 1;
    const defs = rows.map((_: unknown, k: number) => `<linearGradient id="${uid}g${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${LINES[k]}" stop-opacity="${one ? 0.3 : 0.22}"/><stop offset="1" stop-color="${LINES[k]}" stop-opacity="0.02"/></linearGradient>`).join("");
    let fills = "", strokes = "";
    rows.forEach((row: (number | null)[], k: number) => {
      runs(row).forEach(run => {
        const pts = run.map(([i, v]) => [X(i), Y(v)] as [number, number]), d = curve(pts, b.smooth);
        if (run.length > 1) { fills += `<path d="${d}L${p(pts[pts.length - 1][0])},${p(base)}L${p(pts[0][0])},${p(base)}Z" fill="url(#${uid}g${k})"/>`; strokes += `<path d="${d}" fill="none" stroke="${LINES[k]}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`; }
        else strokes += `<circle cx="${p(pts[0][0])}" cy="${p(pts[0][1])}" r="3" fill="${LINES[k]}"/>`;
      });
      const last = runs(row).flat().pop();
      if (last) {
        const [i, v] = last;
        strokes += `<circle cx="${p(X(i))}" cy="${p(Y(v))}" r="4.5" fill="${LINES[k]}" stroke="#fff" stroke-width="2"><title>${esc(b.labels[i])} · ${esc(b.series[k].name)}: ${esc(short(v, b.unit, ko))}</title></circle>`;
        if (one) strokes += `<text x="${p(X(i))}" y="${p(Y(v) - 10)}" text-anchor="end" class="a-vl">${esc(short(v, b.unit, ko))}</text>`;
      }
    });
    return frame(b, svg(W, H, `<defs>${defs}</defs>${yGrid(scale, Y, L, W - R, b.unit, ko)}${fills}${strokes}${pointLabels(b.labels, X, W, H - 8)}`), legend(rows.length > 1 ? b.series.map((s: { name: string }, k: number) => ({ name: s.name, color: LINES[k], shape: "line" as const })) : []));
  },
  summary: b => cap(`${b.title ?? "Area chart"}: ${trend(b)} (${ends(b)}).`),
  css: css("area_chart"),
});

/* ------------------------------------------------------------ stacked_area_chart */
export const stackedAreaChart = defineAsset({
  type: "stacked_area_chart", category: "chart", width: "half",
  use: "Areas stacked over ordered labels to show how a total and its parts change together; normalize shows shares (100%).",
  useKo: "라벨 순서에 따라 합계와 구성 요소의 변화를 쌓은 면적으로 보여 줍니다(normalize는 비중 100%).",
  tags: ["stacked area", "composition over time", "mix", "share", "누적 면적", "구성 추이", "비중 변화"],
  notes: "labels up to 24, series 2-5 (stack order bottom to top), values >= 0 (a gap counts as 0). normalize draws shares of 100%; smooth rounds the curves.",
  fields: { labels: list(text(14), 2, 24), series: line(5, 2), unit: unit.default("count"), normalize: z.boolean().optional(), smooth: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Sessions by traffic source", labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"], unit: "count", smooth: true, series: [{ name: "Organic", values: [31200, 33400, 35100, 36800, 39500, 41200, 43800, 46300, 49100, 52400] }, { name: "Paid", values: [18400, 19800, 21300, 20100, 22600, 24800, 23900, 25700, 27400, 26800] }, { name: "Referral", values: [9200, 9800, 11000, 12400, 13100, 14800, 15200, 16900, 18300, 20100] }, { name: "Direct", values: [12100, 12300, 12800, 13000, 13600, 14100, 14400, 15100, 15500, 16200] }], caption: "Referral traffic more than doubled; total sessions are up 63%." },
  render(b, { ko }) {
    const n = b.labels.length, ns = b.series.length, W = 460, H = 240, T = 14, B = 28, R = 16, norm = !!b.normalize;
    const v = (k: number, i: number) => Math.max(0, b.series[k].values[i] ?? 0), totals = b.labels.map((_: string, i: number) => b.series.reduce((s: number, _x: unknown, k: number) => s + v(k, i), 0));
    const scale = norm ? { min: 0, max: 100, step: 25, ticks: [0, 25, 50, 75, 100] } : axis(0, Math.max(...totals)), tu = norm ? "percent" : b.unit, L = Math.ceil(maxTickWidth(scale, tu, ko)) + 12;
    const X = (i: number) => L + (i * (W - L - R)) / (n - 1), Y = (val: number) => T + ((scale.max - val) / (scale.max - scale.min)) * (H - T - B);
    const cum = b.series.map((_: unknown, k: number) => b.labels.map((__: string, i: number) => { let s = 0; for (let j = 0; j <= k; j++) s += v(j, i); return norm ? (totals[i] ? (s / totals[i]) * 100 : 0) : s; }));
    const bands = b.series.map((s: { name: string }, k: number) => {
      const up = b.labels.map((_: string, i: number) => [X(i), Y(cum[k][i])] as [number, number]), lo = b.labels.map((_: string, i: number) => [X(i), Y(k ? cum[k - 1][i] : 0)] as [number, number]).reverse();
      return `<path d="${curve(up, b.smooth)}${curve(lo, b.smooth).replace(/^M/, "L")}Z" fill="${SERIES[k % 5]}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"><title>${esc(s.name)}</title></path>`;
    }).join("");
    return frame(b, svg(W, H, `${yGrid(scale, Y, L, W - R, tu, ko)}${bands}<line x1="${L}" x2="${W - R}" y1="${p(Y(0))}" y2="${p(Y(0))}" stroke="${ZERO}"/>${pointLabels(b.labels, X, W, H - 8)}`), legend(b.series.map((s: { name: string }, k: number) => ({ name: s.name, color: SERIES[k % 5] }))));
  },
  summary: b => cap(`${b.title ?? "Stacked area"}${b.normalize ? " (shares)" : ""}: ${trend(b)} (${ends(b)}).`),
  css: css("stacked_area_chart"),
});

/* ---------------------------------------------------------------- step_chart */
export const stepChart = defineAsset({
  type: "step_chart", category: "chart", width: "half",
  use: "A step line for a value that holds until the next change (balances, plan prices, limits, rates), one to three series.",
  useKo: "다음 변경 전까지 값이 유지되는 항목(잔액·요금·한도·금리)을 계단선으로 보여 줍니다(1~3개 계열).",
  tags: ["step", "balance", "price", "holds", "stepped line", "계단", "계단식", "잔액", "가격 변동"],
  notes: "labels up to 24, series up to 3 with one value per label (null leaves a gap). Each value holds to the next label. fill shades under a single series. The axis fits the data (it need not start at zero).",
  fields: { labels: list(text(14), 2, 24), series: line(3), unit: unit.default("count"), fill: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Cash balance, Q4 2026", labels: ["Oct 1", "Oct 8", "Oct 15", "Oct 22", "Oct 29", "Nov 5", "Nov 12", "Nov 19"], unit: "usd", series: [{ name: "Operating account", values: [1840000, 1620000, 2410000, 2180000, 1950000, 1710000, 2530000, 2290000] }, { name: "Reserve", values: [1200000, 1200000, 1200000, 1500000, 1500000, 1500000, 1800000, 1800000] }], caption: "The reserve was topped up twice; the Oct 8 dip was payroll." },
  render(b, { uid, ko }) {
    const n = b.labels.length, W = 460, H = 232, T = 20, B = 28, R = 16, rows = b.series.map((s: { values: (number | null)[] }) => pad(s.values, n)), all = rows.flat().filter(nn);
    const scale = axis(Math.min(...all), Math.max(...all)), L = Math.ceil(maxTickWidth(scale, b.unit, ko)) + 12, one = rows.length === 1;
    const X = (i: number) => L + (i * (W - L - R)) / (n - 1), Y = (v: number) => T + ((scale.max - v) / (scale.max - scale.min)) * (H - T - B);
    let fills = "", strokes = "";
    rows.forEach((row: (number | null)[], k: number) => {
      runs(row).forEach(run => {
        const d = run.map(([i, v], j) => (j ? `H${p(X(i))}V${p(Y(v))}` : `M${p(X(i))},${p(Y(v))}`)).join("");
        if (b.fill && one && run.length > 1) fills += `<path d="${d}L${p(X(run[run.length - 1][0]))},${p(Y(scale.min))}L${p(X(run[0][0]))},${p(Y(scale.min))}Z" fill="url(#${uid}g)"/>`;
        strokes += `<path d="${d}" fill="none" stroke="${LINES[k]}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`;
        run.forEach(([i, v], j) => { if (j === 0 || j === run.length - 1 || v !== run[j - 1][1]) strokes += `<circle cx="${p(X(i))}" cy="${p(Y(v))}" r="${j === run.length - 1 ? 4.5 : 3.2}" fill="${j === run.length - 1 ? LINES[k] : "#fff"}" stroke="${LINES[k]}" stroke-width="2"><title>${esc(b.labels[i])} · ${esc(b.series[k].name)}: ${esc(short(v, b.unit, ko))}</title></circle>`; });
      });
      const last = runs(row).flat().pop();
      if (last && one) strokes += `<text x="${p(X(last[0]) - 8)}" y="${p(Y(last[1]) - 9)}" text-anchor="end" class="a-vl">${esc(short(last[1], b.unit, ko))}</text>`;
    });
    const defs = `<linearGradient id="${uid}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${LINES[0]}" stop-opacity=".22"/><stop offset="1" stop-color="${LINES[0]}" stop-opacity="0.02"/></linearGradient>`;
    return frame(b, svg(W, H, `<defs>${defs}</defs>${yGrid(scale, Y, L, W - R, b.unit, ko)}${fills}${strokes}${pointLabels(b.labels, X, W, H - 8)}`), legend(rows.length > 1 ? b.series.map((s: { name: string }, k: number) => ({ name: s.name, color: LINES[k], shape: "line" as const })) : []));
  },
  summary: b => cap(`${b.title ?? "Step chart"}: ${trend(b)} (${ends(b)}).`),
  css: css("step_chart"),
});

/* -------------------------------------------------------------- combo_chart */
const track = z.object({ name: text(30), unit: unit.default("count"), values: list(nullable, 2, 12) }).strip();
export const comboChart = defineAsset({
  type: "combo_chart", category: "chart", width: "half",
  use: "Bars on a left axis with a line on a right axis over the same labels (revenue bars with a margin % line), each in its own unit.",
  useKo: "같은 라벨 위에 왼쪽 축의 막대와 오른쪽 축의 선을 함께 그립니다(예: 매출 막대와 이익률 선).",
  tags: ["combo", "dual axis", "bars and line", "secondary axis", "margin", "혼합 차트", "이중 축", "막대와 선", "보조 축"],
  notes: "labels up to 12; bars and line each have name, unit and one value per label. The line reads the right axis. showValues prints the line's values.",
  fields: { labels: list(text(14), 2, 12), bars: track, line: track, showValues: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Revenue and gross margin", labels: ["Q1 25", "Q2 25", "Q3 25", "Q4 25", "Q1 26", "Q2 26", "Q3 26", "Q4 26"], bars: { name: "Revenue", unit: "usd", values: [4300000, 4800000, 5300000, 6100000, 6700000, 7500000, 8400000, 9500000] }, line: { name: "Gross margin", unit: "percent", values: [61.2, 62.5, 62.1, 64, 65.3, 66.8, 67.5, 69.1] }, caption: "Margin gained eight points while revenue more than doubled." },
  render(b, { ko, T: t }) {
    const n = b.labels.length, W = 460, H = 244, Tp = 22, B0 = 0, bars = pad(b.bars.values, n), pts = pad(b.line.values, n), bv = bars.filter(nn), lv = pts.filter(nn);
    const left = axis(Math.min(0, ...bv), Math.max(0, ...bv)), steps = left.ticks.length - 1, lmax = Math.max(...lv, 0), lmin = Math.min(...lv, 0), lo = lv.length && Math.min(...lv) > 0 && Math.min(...lv) >= 0.5 * lmax ? Math.min(...lv) : Math.min(0, lmin);
    const right = fitScale(lv.length ? lo : 0, lv.length ? Math.max(...lv) : 1, steps), L = Math.ceil(maxTickWidth(left, b.bars.unit, ko)) + 12, R = Math.ceil(maxTickWidth(right, b.line.unit, ko)) + 12;
    const bandW = (W - L - R) / n, fit = fitLabels(b.labels, bandW), B = B0 + 14 + fit.lines * 12.5 + 6, Yl = (v: number) => Tp + ((left.max - v) / (left.max - left.min)) * (H - Tp - B), Yr = (v: number) => Tp + ((right.max - v) / (right.max - right.min)) * (H - Tp - B);
    const barW = Math.min(bandW * 0.56, 34), cx = (i: number) => L + (i + 0.5) * bandW;
    const rects = bars.map((v, i) => (v === null ? "" : `<path d="${barPath(cx(i) - barW / 2, barW, Yl(v), Yl(0), 4)}" fill="${BLUE}" fill-opacity=".92"><title>${esc(b.labels[i])} · ${esc(b.bars.name)}: ${esc(short(v, b.bars.unit, ko))}</title></path>`)).join("");
    const orange = "#f08a24", d = runs(pts).map(run => curve(run.map(([i, v]) => [cx(i), Yr(v)] as [number, number]))).join("");
    const dots = pts.map((v, i) => (v === null ? "" : `<circle cx="${p(cx(i))}" cy="${p(Yr(v))}" r="4" fill="#fff" stroke="${orange}" stroke-width="2.4"><title>${esc(b.labels[i])} · ${esc(b.line.name)}: ${esc(short(v, b.line.unit, ko))}</title></circle>`)).join("");
    const vals = b.showValues ? pts.map((v, i) => (v === null || tw(short(v, b.line.unit, ko), 10.5) * 1.05 > bandW ? "" : `<text x="${p(cx(i))}" y="${p(Yr(v) - 9)}" text-anchor="middle" class="a-vl" style="fill:#8a5a12">${esc(short(v, b.line.unit, ko))}</text>`)).join("") : "";
    const inner = `${yGrid(left, Yl, L, W - R, b.bars.unit, ko)}${yGrid(right, Yr, L, W - R, b.line.unit, ko, "right", "#b7791f")}<line x1="${L}" x2="${W - R}" y1="${p(Yl(0))}" y2="${p(Yl(0))}" stroke="${ZERO}"/>${rects}<path d="${d}" fill="none" stroke="${orange}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>${dots}${vals}${drawLabels(fit.rows, b.labels.map((_: string, i: number) => cx(i)), H - B + 15, fit.size)}`;
    return frame(b, svg(W, H, inner), legend([{ name: `${b.bars.name} · ${t("left", "왼쪽")}`, color: BLUE }, { name: `${b.line.name} · ${t("right", "오른쪽")}`, color: orange, shape: "line" }], 40));
  },
  summary: b => { const f = (x: { values: (number | null)[]; unit: string }) => { const v = pad(x.values, b.labels.length).filter(nn); return `${short(v[0] ?? 0, x.unit, false)} → ${short(v[v.length - 1] ?? 0, x.unit, false)}`; }; return cap(`${b.title ?? "Combo chart"}: ${b.bars.name} ${f(b.bars)}; ${b.line.name} ${f(b.line)} (${ends(b)}).`); },
  css: css("combo_chart"),
});

export const ASSETS: readonly AnyAsset[] = [areaChart, stackedAreaChart, stepChart, comboChart];
