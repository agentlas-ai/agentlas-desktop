import { z } from "zod";
import { esc } from "../../kit";
import { list, loose, num, optionalNum, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { GREEN, INK2, RED, ZERO, axis, barPath, cap, change, css, delta, drawLabels, fitLabels, frame, legend, maxTickWidth, moveColor, p, short, svg, tw, yGrid, clipPx, GRID, BLUE } from "./_cartesian";

const pair = list(text(14), 2, 2);
const move = list(z.object({ label: text(30), from: num, to: num }).strip(), 2, 10);
const MARK = "#8a959b";

/** Moves label centres apart until no two are closer than `gap` (kept inside [lo, hi]). */
function spread(ys: number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b]), out = [...ys];
  const push = () => { for (let k = 1; k < order.length; k++) if (out[order[k]] - out[order[k - 1]] < gap) out[order[k]] = out[order[k - 1]] + gap; };
  if (order.length) out[order[0]] = Math.max(out[order[0]], lo);
  push();
  const last = order[order.length - 1];
  if (out[last] > hi) { out[last] = hi; for (let k = order.length - 2; k >= 0; k--) if (out[order[k + 1]] - out[order[k]] < gap) out[order[k]] = out[order[k + 1]] - gap; }
  return out;
}

/* --------------------------------------------------------------- slope_chart */
export const slopeChart = defineAsset({
  type: "slope_chart", category: "chart", width: "half",
  use: "Before-and-after lines between two periods for three to ten items, coloured by whether each rose or fell.",
  useKo: "두 시점 사이의 항목별 변화를 기울기 선으로 보여 줍니다(3~10개 항목, 오르면 초록·내리면 빨강).",
  tags: ["slope", "before after", "change", "two periods", "rank change", "슬로프", "전후 비교", "변화", "두 시점"],
  notes: "periods are the two column names (e.g. 2024, 2025); each item has a label and a from and to value in the same unit. lowerIsBetter flips the colours (churn, cost, time).",
  fields: { periods: pair, items: move, unit: unit.default("count"), lowerIsBetter: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Net revenue retention by segment", periods: ["2024", "2025"], unit: "percent", items: [{ label: "Enterprise", from: 112, to: 118 }, { label: "Mid-market", from: 104, to: 109 }, { label: "Startups", from: 89, to: 94 }, { label: "Nonprofit", from: 97, to: 102 }, { label: "Public sector", from: 101, to: 99 }, { label: "SMB", from: 96, to: 91 }], caption: "Four of six segments improved; SMB lost five points." },
  render(b, { ko }) {
    const items = b.items as { label: string; from: number; to: number }[], n = items.length, W = 460, top = 38, H = top + Math.max(176, n * 22) + 12, x1 = 178, x2 = W - 116;
    const all = items.flatMap(i => [i.from, i.to]), lo = Math.min(...all), hi = Math.max(...all), Y = (v: number) => top + (hi === lo ? 0.5 : (hi - v) / (hi - lo)) * (H - top - 12);
    const left = spread(items.map(i => Y(i.from)), 16, top, H - 12), right = spread(items.map(i => Y(i.to)), 16, top, H - 12);
    const head = (x: number, t: string) => `<text x="${x}" y="16" text-anchor="middle" class="a-pn">${esc(clipPx(t, 90, 13))}</text><line x1="${x}" x2="${x}" y1="24" y2="${H - 6}" stroke="${GRID}" stroke-dasharray="2 4"/>`;
    const body = items.map((it, i) => {
      const c = moveColor(it.from, it.to, b.lowerIsBetter), a = short(it.from, b.unit, ko), z = short(it.to, b.unit, ko);
      const lab = clipPx(it.label, x1 - 20 - tw(a, 12) - 8, 12);
      return `<line x1="${x1}" y1="${p(Y(it.from))}" x2="${x2}" y2="${p(Y(it.to))}" stroke="${c}" stroke-width="2.4" stroke-linecap="round"><title>${esc(it.label)}: ${esc(a)} → ${esc(z)}</title></line>`
        + `<circle cx="${x1}" cy="${p(Y(it.from))}" r="4" fill="${c}"/><circle cx="${x2}" cy="${p(Y(it.to))}" r="4" fill="${c}"/>`
        + `<text x="${x1 - 12}" y="${p(left[i] + 4)}" text-anchor="end" class="a-sv2">${esc(a)}</text><text x="${p(x1 - 12 - tw(a, 12) - 8)}" y="${p(left[i] + 4)}" text-anchor="end" class="a-rl">${esc(lab)}</text>`
        + `<text x="${x2 + 12}" y="${p(right[i] + 4)}" class="a-sv2">${esc(z)}</text><text x="${p(x2 + 12 + tw(z, 12) + 8)}" y="${p(right[i] + 4)}" class="a-ch" fill="${c}">${esc(change(it.from, it.to, b.unit))}</text>`;
    }).join("");
    return frame(b, svg(W, H, `${head(x1, b.periods[0])}${head(x2, b.periods[1])}${body}`));
  },
  summary: b => cap(`${b.title ?? "Slope chart"} (${b.periods[0]} → ${b.periods[1]}): ${(b.items as { label: string; from: number; to: number }[]).map(i => `${i.label} ${short(i.from, b.unit, false)} → ${short(i.to, b.unit, false)}`).join("; ")}.`),
  css: css("slope_chart", "@ .a-pn{font-size:13px;font-weight:800;fill:#101d24}@ .a-rl{font-size:12px;font-weight:650;fill:#5c6870}@ .a-sv2{font-size:12px;font-weight:750;fill:#101d24}@ .a-ch{font-size:12px;font-weight:750}"),
});

/* ------------------------------------------------------------ dumbbell_chart */
export const dumbbellChart = defineAsset({
  type: "dumbbell_chart", category: "chart", width: "half",
  use: "Two values per row joined by a bar (this period against the last), with the gap and its size highlighted.",
  useKo: "행마다 두 값(예: 작년과 올해)을 막대로 이어 격차와 변화 크기를 강조합니다.",
  tags: ["dumbbell", "gap", "two points", "before after", "year over year", "덤벨", "격차", "전년 대비", "두 값 비교"],
  notes: "periods are the two names; each item has a label and a from and to value in one unit, up to 12 rows. lowerIsBetter flips the colours (cost, time, churn).",
  fields: { periods: pair, items: list(z.object({ label: text(30), from: num, to: num }).strip(), 2, 12), unit: unit.default("count"), lowerIsBetter: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Customer satisfaction by channel", periods: ["2024", "2025"], unit: "percent", items: [{ label: "Live chat", from: 82, to: 88 }, { label: "Email", from: 74, to: 79 }, { label: "Phone", from: 69, to: 71 }, { label: "Help center", from: 58, to: 66 }, { label: "In-app messages", from: 77, to: 75 }, { label: "Community forum", from: 63, to: 70 }], caption: "Self-serve channels closed most of the gap; in-app slipped two points." },
  render(b, { ko, T }) {
    const items = b.items as { label: string; from: number; to: number }[], n = items.length, W = 460, rowH = 28, L0 = 124, R0 = 66, top = 6, H = top + n * rowH + 26;
    const all = items.flatMap(i => [i.from, i.to]), scale = axis(Math.min(...all), Math.max(...all)), X = (v: number) => L0 + ((v - scale.min) / (scale.max - scale.min)) * (W - L0 - R0 - 8);
    const grid = scale.ticks.map(t => `<line x1="${p(X(t))}" x2="${p(X(t))}" y1="${top}" y2="${top + n * rowH}" stroke="${t === 0 && scale.min < 0 ? ZERO : GRID}"/><text x="${p(X(t))}" y="${H - 6}" text-anchor="middle" class="a-ax">${esc(short(t, b.unit, ko))}</text>`).join("");
    const rows = items.map((it, i) => {
      const y = top + i * rowH + rowH / 2, c = moveColor(it.from, it.to, b.lowerIsBetter), x0 = X(it.from), x1 = X(it.to);
      return `<text x="0" y="${p(y + 4)}" class="a-rl">${esc(clipPx(it.label, L0 - 14, 12))}</text>`
        + `<line x1="${p(x0)}" x2="${p(x1)}" y1="${p(y)}" y2="${p(y)}" stroke="${c}" stroke-opacity=".45" stroke-width="10" stroke-linecap="round"/>`
        + `<circle cx="${p(x0)}" cy="${p(y)}" r="5" fill="${MARK}" stroke="#fff" stroke-width="1.5"><title>${esc(b.periods[0])}: ${esc(short(it.from, b.unit, ko))}</title></circle><circle cx="${p(x1)}" cy="${p(y)}" r="5.5" fill="${BLUE}" stroke="#fff" stroke-width="1.5"><title>${esc(b.periods[1])}: ${esc(short(it.to, b.unit, ko))}</title></circle>`
        + `<text x="${W}" y="${p(y + 4)}" text-anchor="end" class="a-dl" fill="${c}">${esc(change(it.from, it.to, b.unit))}</text>`;
    }).join("");
    return frame(b, svg(W, H, `${grid}${rows}`), legend([{ name: b.periods[0], color: MARK, shape: "dot" }, { name: b.periods[1], color: BLUE, shape: "dot" }]));
  },
  summary: b => cap(`${b.title ?? "Dumbbell chart"} (${b.periods[0]} → ${b.periods[1]}): ${(b.items as { label: string; from: number; to: number }[]).map(i => `${i.label} ${short(i.from, b.unit, false)} → ${short(i.to, b.unit, false)}`).join("; ")}.`),
  css: css("dumbbell_chart", "@ .a-rl{font-size:12px;font-weight:650;fill:#34424a}@ .a-dl{font-size:12px;font-weight:750}"),
});

/* ----------------------------------------------------------- waterfall_chart */
const kind = loose(["delta", "total"], { start: "total", end: "total", subtotal: "total", sum: "total", result: "total", opening: "total", closing: "total", balance: "total", increase: "delta", decrease: "delta", change: "delta", step: "delta", add: "delta", gain: "delta", loss: "delta" }, "delta").optional();
export const waterfallChart = defineAsset({
  type: "waterfall_chart", category: "chart", width: "half",
  use: "How a start value becomes an end value through increases and decreases, with subtotals (a bridge: ARR, profit, headcount).",
  useKo: "시작 값이 증가·감소 단계를 거쳐 끝 값이 되는 과정을 소계와 함께 보여 줍니다(ARR·이익·인원 브리지).",
  tags: ["waterfall", "bridge", "walk", "variance", "increase decrease", "워터폴", "브리지", "증감", "증감 분석"],
  notes: "steps 3-12 in order. kind is delta (a change, signed value) or total (start, subtotal or end: a bar from zero; leave value out to use the running sum). The first step is a total unless set.",
  fields: { steps: list(z.object({ label: text(18), value: optionalNum, kind }).strip(), 3, 12), unit: unit.default("count"), caption: optionalText(120) },
  sample: { title: "ARR bridge, Q3 2026", unit: "usd", steps: [{ label: "Starting ARR", value: 12400000, kind: "total" }, { label: "New logos", value: 2100000 }, { label: "Expansion", value: 1300000 }, { label: "Before losses", kind: "total" }, { label: "Contraction", value: -600000 }, { label: "Churn", value: -900000 }, { label: "Ending ARR", kind: "total" }], caption: "Net new ARR of $1.9M: 15% growth in the quarter." },
  render(b, { ko, T }) {
    type Bar = { label: string; total: boolean; from: number; to: number; value: number };
    let run = 0; const bars: Bar[] = (b.steps as { label: string; value?: number; kind?: string }[]).map((s, i) => {
      const total = s.kind === "total" || (s.kind === undefined && (i === 0 || s.value === undefined));
      if (total) { const to = s.value ?? run; const out = { label: s.label, total, from: 0, to, value: to }; run = to; return out; }
      const v = s.value ?? 0, out = { label: s.label, total, from: run, to: run + v, value: v }; run += v; return out;
    });
    const n = bars.length, W = 460, H = 250, R = 8, Tp = 22, all = bars.flatMap(q => [q.from, q.to]), scale = axis(Math.min(0, ...all), Math.max(0, ...all));
    const L = Math.ceil(maxTickWidth(scale, b.unit, ko)) + 12, bandW = (W - L - R) / n, fit = fitLabels(bars.map(q => q.label), bandW), B = 14 + fit.lines * 12.5 + 6, barW = Math.min(bandW * 0.66, 40);
    const Y = (v: number) => Tp + ((scale.max - v) / (scale.max - scale.min)) * (H - Tp - B), cx = (i: number) => L + (i + 0.5) * bandW;
    let shapes = "", labels = "", joins = "";
    bars.forEach((q, i) => {
      const color = q.total ? INK2 : q.value >= 0 ? GREEN : RED, hi = Math.max(q.from, q.to), lo = Math.min(q.from, q.to), x = cx(i) - barW / 2;
      shapes += `<path d="${q.total ? barPath(x, barW, Y(q.to), Y(0), 4) : barPath(x, barW, Y(hi), Y(lo), 3)}" fill="${color}"><title>${esc(q.label)}: ${esc(q.total ? short(q.value, b.unit, ko) : delta(q.value, b.unit, ko))}</title></path>`;
      const text = q.total ? short(q.value, b.unit, ko) : delta(q.value, b.unit, ko), below = !q.total && q.value < 0 || q.total && q.to < 0;
      if (tw(text, 10.5) * 1.05 <= bandW) labels += `<text x="${p(cx(i))}" y="${p(below ? Y(lo) + 13 : Y(hi) - 5)}" text-anchor="middle" class="a-vl">${esc(text)}</text>`;
      if (i < n - 1) joins += `<line x1="${p(x + barW)}" x2="${p(cx(i + 1) - barW / 2)}" y1="${p(Y(q.to))}" y2="${p(Y(q.to))}" stroke="#aab4ae" stroke-dasharray="2 2"/>`;
    });
    return frame(b, svg(W, H, `${yGrid(scale, Y, L, W - R, b.unit, ko)}<line x1="${L}" x2="${W - R}" y1="${p(Y(0))}" y2="${p(Y(0))}" stroke="${ZERO}"/>${joins}${shapes}${labels}${drawLabels(fit.rows, bars.map((_, i) => cx(i)), H - B + 15, fit.size)}`), legend([{ name: T("Increase", "증가"), color: GREEN }, { name: T("Decrease", "감소"), color: RED }, { name: T("Total", "합계"), color: INK2 }]));
  },
  summary: b => { let run = 0; const parts = (b.steps as { label: string; value?: number; kind?: string }[]).map((s, i) => { const total = s.kind === "total" || (s.kind === undefined && (i === 0 || s.value === undefined)); if (total) { run = s.value ?? run; return `${s.label} ${short(run, b.unit, false)}`; } run += s.value ?? 0; return `${s.label} ${delta(s.value ?? 0, b.unit, false)}`; }); return cap(`${b.title ?? "Waterfall"}: ${parts.join(", ")}.`); },
  css: css("waterfall_chart"),
});

export const ASSETS: readonly AnyAsset[] = [slopeChart, dumbbellChart, waterfallChart];
