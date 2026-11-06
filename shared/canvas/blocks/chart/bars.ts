import { z } from "zod";
import { esc } from "../../kit";
import { list, optionalNum, optionalText, text, num, unit, loose } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { BLUE, GRID, HROWS_CSS, INK, ORANGE, RED, SERIES, ZERO, axis, barPath, cap, css, drawLabels, fitLabels, frame, highlight, legend, maxTickWidth, nullable, p, pickHighlight, hRows, short, svg, tw, yGrid, type HRow } from "./_cartesian";

const grouped = (max: number, min = 1) => list(z.object({ name: text(30), values: list(nullable, 1, 12) }).strip(), min, max);
const rankItems = list(z.object({ label: text(40), value: num }).strip(), 2, 12);
const sortMode = loose(["desc", "asc", "none"], { descending: "desc", high_to_low: "desc", ranked: "desc", ascending: "asc", low_to_high: "asc", given: "none", as_given: "none", unsorted: "none", off: "none" }, "desc").optional();
const ordered = <T extends { value: number }>(items: T[], mode: string | undefined) => (mode === "none" ? items : [...items].sort((a, b) => (mode === "asc" ? a.value - b.value : b.value - a.value)));

/* ------------------------------------------------------------------ bar_chart */
export const barChart = defineAsset({
  type: "bar_chart", category: "chart", width: "half",
  use: "Vertical bars comparing values per category, one series or several grouped side by side, from numbers you already have.",
  useKo: "이미 가진 숫자로 항목별 값을 세로 막대로 비교합니다(한 계열 또는 여러 계열을 묶어서).",
  tags: ["bar", "column", "compare", "grouped", "category", "막대", "막대그래프", "비교", "항목별"],
  notes: "labels up to 12, series up to 5 with one value per label (null skips a bar). unit sets the number format; showValues prints the value on each bar.",
  fields: { labels: list(text(16), 1, 12), series: grouped(5), unit: unit.default("count"), showValues: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Revenue by region", labels: ["North America", "EMEA", "APAC", "LATAM", "Public sector"], unit: "usd", showValues: true, series: [{ name: "FY2026", values: [4200000, 2850000, 1960000, 940000, 1310000] }, { name: "FY2025", values: [3650000, 2310000, 1240000, 810000, 1180000] }], caption: "APAC grew fastest: up 58% on the year." },
  render(b, { ko }) {
    const n = b.labels.length, ns = b.series.length, W = 460, H = 236, R = 8, rows = b.series.map(s => b.labels.map((_, i) => s.values[i] ?? null));
    const all = rows.flat().filter((v): v is number => v !== null), scale = axis(Math.min(0, ...all), Math.max(0, ...all));
    const L = Math.ceil(maxTickWidth(scale, b.unit, ko)) + 12, T = b.showValues ? 22 : 12, bandW = (W - L - R) / n, fit = fitLabels(b.labels, bandW), B = 14 + fit.lines * 12.5 + 6;
    const Y = (v: number) => T + ((scale.max - v) / (scale.max - scale.min)) * (H - T - B), base = Y(0);
    const gap = ns > 1 ? 2 : 0, groupW = Math.min(bandW * (ns > 1 ? 0.8 : 0.62), ns * 34 + gap * (ns - 1)), barW = (groupW - gap * (ns - 1)) / ns;
    const widest = Math.max(0, ...all.map(v => tw(short(v, b.unit, ko), 10.5))), labelled = b.showValues && (ns === 1 ? widest * 1.05 <= bandW : widest * 1.05 <= barW + 6);
    let bars = "", vals = "";
    rows.forEach((row, k) => row.forEach((v, i) => {
      if (v === null) return;
      const x = L + i * bandW + (bandW - groupW) / 2 + k * (barW + gap), yv = Y(v);
      bars += `<path d="${barPath(x, barW, yv, base, Math.min(5, barW / 2))}" fill="${SERIES[k % 5]}"><title>${esc(b.labels[i])} · ${esc(b.series[k].name)}: ${esc(short(v, b.unit, ko))}</title></path>`;
      if (labelled) vals += `<text x="${p(x + barW / 2)}" y="${p(v >= 0 ? yv - 5 : yv + 13)}" text-anchor="middle" class="a-vl">${esc(short(v, b.unit, ko))}</text>`;
    }));
    const centers = b.labels.map((_, i) => L + (i + 0.5) * bandW);
    return frame(b, svg(W, H, `${yGrid(scale, Y, L, W - R, b.unit, ko)}<line x1="${L}" x2="${W - R}" y1="${p(base)}" y2="${p(base)}" stroke="${ZERO}"/>${bars}${vals}${drawLabels(fit.rows, centers, H - B + 15, fit.size)}`), legend(ns > 1 ? b.series.map((s, k) => ({ name: s.name, color: SERIES[k % 5] })) : []));
  },
  summary: b => cap(`${b.title ?? "Bar chart"}: ${b.series.map(s => `${s.name} — ${b.labels.map((l, i) => (s.values[i] == null ? "" : `${l} ${short(s.values[i] as number, b.unit, false)}`)).filter(Boolean).join(", ")}`).join("; ")}.`),
  css: css("bar_chart"),
});

/* ------------------------------------------------------- horizontal_bar_chart */
export const horizontalBarChart = defineAsset({
  type: "horizontal_bar_chart", category: "chart", width: "half",
  use: "A ranked list as horizontal bars with the value at the end of each, for long labels or many categories; one row can be highlighted.",
  useKo: "긴 항목 이름이나 많은 항목의 순위를 가로 막대와 값으로 보여 주고, 한 줄을 강조할 수 있습니다.",
  tags: ["horizontal bar", "ranking", "top", "leaderboard", "rank", "가로 막대", "순위", "상위", "랭킹"],
  notes: "items up to 12 (label, value); sort is desc by default (asc or none to keep the order). highlight is a label or a 0-based index. Negative values draw in red from a zero line.",
  fields: { items: rankItems, unit: unit.default("count"), sort: sortMode, highlight, caption: optionalText(120) },
  sample: { title: "Signups by acquisition channel", unit: "count", highlight: "Referrals", items: [{ label: "Organic search", value: 4820 }, { label: "Referrals", value: 3140 }, { label: "Paid social", value: 2610 }, { label: "Email campaigns", value: 1980 }, { label: "Partner marketplace", value: 1420 }, { label: "Events and webinars", value: 880 }, { label: "Direct", value: 760 }], caption: "Referrals convert 2.3x better than paid social." },
  render(b, { ko }) {
    const at = pickHighlight(b.highlight, b.items.map((i: { label: string }) => i.label)), rows = ordered(b.items.map((it: { label: string; value: number }, i: number) => ({ ...it, hl: i === at })), b.sort);
    const hr: HRow[] = rows.map(r => ({ label: r.label, value: r.value, hl: r.hl, dim: at >= 0 && !r.hl }));
    return frame(b, hRows("bar", hr, b.unit, ko));
  },
  summary: b => cap(`${b.title ?? "Ranking"}: ${ordered(b.items, b.sort).map((i: { label: string; value: number }) => `${i.label} ${short(i.value, b.unit, false)}`).join(", ")}.`),
  css: css("horizontal_bar_chart", `${HROWS_CSS}@ .a-t{background:#f1f3f2;border-radius:7px}`, false),
});

/* --------------------------------------------------------- stacked_bar_chart */
export const stackedBarChart = defineAsset({
  type: "stacked_bar_chart", category: "chart", width: "half",
  use: "Stacked vertical bars showing how each category's total splits into two to five parts; normalize shows shares (100%).",
  useKo: "항목별 합계가 두~다섯 개 구성으로 나뉘는 모습을 쌓은 세로 막대로 보여 줍니다(normalize는 비중 100%).",
  tags: ["stacked bar", "composition", "mix", "share", "breakdown", "누적 막대", "구성", "비중", "분해"],
  notes: "labels up to 12, series 2-5 (stack order bottom to top), values >= 0. normalize draws every bar to 100%. showValues prints each segment that fits; totals are printed above the bars.",
  fields: { labels: list(text(16), 1, 12), series: grouped(5, 2), unit: unit.default("count"), normalize: z.boolean().optional(), showValues: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Revenue by line of business", labels: ["Q1 25", "Q2 25", "Q3 25", "Q4 25", "Q1 26", "Q2 26", "Q3 26", "Q4 26"], unit: "usd", series: [{ name: "Subscription", values: [3100000, 3400000, 3900000, 4300000, 4800000, 5200000, 5900000, 6400000] }, { name: "Services", values: [800000, 900000, 700000, 1000000, 900000, 1100000, 1000000, 1200000] }, { name: "Usage", values: [400000, 500000, 700000, 800000, 1000000, 1200000, 1500000, 1900000] }], caption: "Usage revenue grew from 9% to 20% of the mix." },
  render(b, { ko }) {
    const n = b.labels.length, ns = b.series.length, W = 460, H = 244, R = 8, norm = !!b.normalize;
    const val = (k: number, i: number) => Math.max(0, b.series[k].values[i] ?? 0), totals = b.labels.map((_: string, i: number) => b.series.reduce((s: number, _x: unknown, k: number) => s + val(k, i), 0));
    const scale = norm ? { min: 0, max: 100, step: 25, ticks: [0, 25, 50, 75, 100] } : axis(0, Math.max(...totals, 1)), tu = norm ? "percent" : b.unit;
    const L = Math.ceil(maxTickWidth(scale, tu, ko)) + 12, T = norm ? 12 : 22, bandW = (W - L - R) / n, fit = fitLabels(b.labels, bandW), B = 14 + fit.lines * 12.5 + 6;
    const Y = (v: number) => T + ((scale.max - v) / (scale.max - scale.min)) * (H - T - B), barW = Math.min(bandW * 0.64, 44);
    let bars = "", vals = "";
    b.labels.forEach((l: string, i: number) => {
      const x = L + i * bandW + (bandW - barW) / 2, tot = totals[i], top = (() => { for (let k = ns - 1; k >= 0; k--) if (val(k, i) > 0) return k; return -1; })();
      let acc = 0;
      b.series.forEach((s: { name: string }, k: number) => {
        const v = val(k, i); if (!(v > 0)) return;
        const share = norm ? (v / tot) * 100 : v, y0 = Y(acc), y1 = Y(acc + share);
        bars += `<path d="${barPath(x, barW, y1, y0, k === top ? 5 : 0)}" fill="${SERIES[k % 5]}" stroke="#fff" stroke-width="1"><title>${esc(l)} · ${esc(s.name)}: ${esc(short(v, b.unit, ko))}${norm ? ` (${Math.round(share)}%)` : ""}</title></path>`;
        const text = norm ? `${Math.round(share)}%` : short(v, b.unit, ko);
        if (b.showValues && y0 - y1 >= 15 && tw(text, 10) + 6 <= barW) vals += `<text x="${p(x + barW / 2)}" y="${p((y0 + y1) / 2 + 3.6)}" text-anchor="middle" class="a-sv" fill="${k === 0 || k === 3 ? "#fff" : INK}">${esc(text)}</text>`;
        acc += share;
      });
      if (!norm && tw(short(tot, b.unit, ko), 10.5) * 1.05 <= bandW) vals += `<text x="${p(x + barW / 2)}" y="${p(Y(tot) - 5)}" text-anchor="middle" class="a-vl">${esc(short(tot, b.unit, ko))}</text>`;
    });
    const centers = b.labels.map((_: string, i: number) => L + (i + 0.5) * bandW);
    return frame(b, svg(W, H, `${yGrid(scale, Y, L, W - R, tu, ko)}<line x1="${L}" x2="${W - R}" y1="${p(Y(0))}" y2="${p(Y(0))}" stroke="${ZERO}"/>${bars}${vals}${drawLabels(fit.rows, centers, H - B + 15, fit.size)}`), legend(b.series.map((s: { name: string }, k: number) => ({ name: s.name, color: SERIES[k % 5] }))));
  },
  summary: b => cap(`${b.title ?? "Stacked bars"}${b.normalize ? " (shares)" : ""}: ${b.series.map((s: { name: string; values: (number | null)[] }) => `${s.name} ${short(s.values[0] ?? 0, b.unit, false)} → ${short(s.values[Math.min(s.values.length, b.labels.length) - 1] ?? 0, b.unit, false)}`).join("; ")} (${b.labels[0]}–${b.labels[b.labels.length - 1]}).`),
  css: css("stacked_bar_chart", "@ .a-sv{font-size:10px;font-weight:700}"),
});

/* ------------------------------------------------------------ lollipop_chart */
export const lollipopChart = defineAsset({
  type: "lollipop_chart", category: "chart", width: "half",
  use: "A sorted list as light stems ending in dots with the value beside each, a quieter alternative to bars for many items.",
  useKo: "정렬된 항목을 줄기와 점으로 가볍게 보여 주고 값을 옆에 표시합니다(막대보다 가벼운 순위 표현).",
  tags: ["lollipop", "stem", "dot plot", "ranking", "sorted", "롤리팝", "점 그래프", "순위", "정렬"],
  notes: "items up to 12 (label, value); sort is desc by default. highlight is a label or a 0-based index (its dot turns orange). Negative values hang left of a zero line in red.",
  fields: { items: rankItems, unit: unit.default("count"), sort: sortMode, highlight, caption: optionalText(120) },
  sample: { title: "Feature adoption by module", unit: "percent", highlight: "Alerts", items: [{ label: "Dashboards", value: 82 }, { label: "Reports", value: 74 }, { label: "Alerts", value: 61 }, { label: "Public API", value: 48 }, { label: "Integrations", value: 37 }, { label: "Automations", value: 29 }, { label: "Audit log", value: 18 }], caption: "Share of active workspaces using each module in October." },
  render(b, { ko }) {
    const at = pickHighlight(b.highlight, b.items.map((i: { label: string }) => i.label)), rows = ordered(b.items.map((it: { label: string; value: number }, i: number) => ({ ...it, hl: i === at })), b.sort);
    return frame(b, hRows("lolli", rows.map(r => ({ label: r.label, value: r.value, hl: r.hl, dim: false })), b.unit, ko));
  },
  summary: b => cap(`${b.title ?? "Ranking"}: ${ordered(b.items, b.sort).map((i: { label: string; value: number }) => `${i.label} ${short(i.value, b.unit, false)}`).join(", ")}.`),
  css: css("lollipop_chart", `${HROWS_CSS}@ .a-t{height:20px}@ .a-t::before{content:"";position:absolute;left:0;right:0;top:50%;border-top:1px dashed #dfe4e1}@ .a-bar{top:9px;bottom:auto;height:2px;min-width:0;border-radius:1px;background:#b9c3be}@ .a-dot{position:absolute;top:3px;width:14px;height:14px;margin-left:-7px;border-radius:50%;box-shadow:0 0 0 2px #fff}`, false),
});

/* ----------------------------------------------------------------- histogram */
export const histogram = defineAsset({
  type: "histogram", category: "chart", width: "half",
  use: "The distribution of a measure as touching bars over value ranges (bins), with an optional mean and median marker.",
  useKo: "측정값의 분포를 구간(bin)별 막대로 보여 주고 평균·중앙값 표시선을 더할 수 있습니다.",
  tags: ["histogram", "distribution", "bins", "frequency", "latency", "히스토그램", "분포", "구간", "빈도"],
  notes: "bins up to 30 (from, to, count), contiguous and of equal width. unit formats the x axis (usd, percent, count ...). mean and median are x values in the same unit.",
  fields: { bins: list(z.object({ from: num, to: num, count: num }).strip(), 3, 30), unit: unit.default("count"), mean: optionalNum, median: optionalNum, caption: optionalText(120) },
  sample: { title: "API response time, last 7 days (ms)", unit: "count", mean: 238, median: 223, bins: [[0, 50, 12], [50, 100, 96], [100, 150, 258], [150, 200, 372], [200, 250, 341], [250, 300, 262], [300, 350, 181], [350, 400, 119], [400, 450, 73], [450, 500, 41], [500, 550, 22], [550, 600, 11]].map(([from, to, count]) => ({ from, to, count })), caption: "1,788 requests; 95% finished within 450 ms." },
  render(b, { ko, T }) {
    const W = 460, H = 236, R = 10, bins = [...b.bins].sort((a: { from: number }, c: { from: number }) => a.from - c.from) as { from: number; to: number; count: number }[];
    const x0 = bins[0].from, x1 = Math.max(...bins.map(q => q.to), x0 + 1), scale = axis(0, Math.max(...bins.map(q => Math.max(0, q.count)), 1));
    const L = Math.ceil(maxTickWidth(scale, "count", ko)) + 12, top = 24, B = 34, X = (v: number) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v: number) => top + ((scale.max - v) / (scale.max - scale.min)) * (H - top - B);
    const bars = bins.map(q => { const x = X(q.from) + 0.8, w = Math.max(1, X(q.to) - X(q.from) - 1.6); return `<path d="${barPath(x, w, Y(Math.max(0, q.count)), Y(0), 3)}" fill="${BLUE}"><title>${esc(short(q.from, b.unit, ko))}–${esc(short(q.to, b.unit, ko))}: ${esc(short(q.count, "count", ko))}</title></path>`; }).join("");
    const edges = [...new Set([...bins.map(q => q.from), ...bins.map(q => q.to)])].sort((a, c) => a - c), maxW = Math.max(...edges.map(e => tw(short(e, b.unit, ko)))) + 10, k = Math.max(1, Math.ceil(maxW / ((W - L - R) / Math.max(1, edges.length - 1))));
    const ticks = edges.map((e, i) => { if (i % k !== 0) return ""; const txt = short(e, b.unit, ko), over = X(e) + tw(txt) / 2 > W; return `<line x1="${p(X(e))}" x2="${p(X(e))}" y1="${p(Y(0))}" y2="${p(Y(0) + 4)}" stroke="${ZERO}"/><text x="${p(over ? W : X(e))}" y="${p(Y(0) + 16)}" text-anchor="${over ? "end" : "middle"}" class="a-ax">${esc(txt)}</text>`; }).join("");
    const marks = ([[b.median, T("Median", "중앙값"), INK, ""], [b.mean, T("Mean", "평균"), "#b7791f", "4 3"]] as [number | undefined, string, string, string][]).filter(m => m[0] !== undefined && m[0] >= x0 && m[0] <= x1).sort((a, c) => (a[0] as number) - (c[0] as number));
    const lines = marks.map((m, i) => { const x = X(m[0] as number), side = marks.length > 1 ? (i === 0 ? "end" : "start") : x > W - 90 ? "end" : "start"; return `<line x1="${p(x)}" x2="${p(x)}" y1="${top - 6}" y2="${p(Y(0))}" stroke="${m[2]}" stroke-width="1.8"${m[3] ? ` stroke-dasharray="${m[3]}"` : ""}/><text x="${p(x + (side === "end" ? -5 : 5))}" y="${top - 9}" text-anchor="${side}" class="a-vl" fill="${m[2]}" style="fill:${m[2]}">${esc(m[1])} ${esc(short(m[0] as number, b.unit, ko))}</text>`; }).join("");
    return frame(b, svg(W, H, `${yGrid(scale, Y, L, W - R, "count", ko)}${bars}${ticks}${lines}`));
  },
  summary: b => { const bins = b.bins as { from: number; to: number; count: number }[], total = bins.reduce((s, q) => s + q.count, 0), peak = bins.reduce((a, q) => (q.count > a.count ? q : a), bins[0]); return cap(`${b.title ?? "Histogram"}: ${short(total, "count", false)} observations in ${bins.length} bins, most in ${short(peak.from, b.unit, false)}–${short(peak.to, b.unit, false)}${b.median !== undefined ? `; median ${short(b.median, b.unit, false)}` : ""}${b.mean !== undefined ? `; mean ${short(b.mean, b.unit, false)}` : ""}.`); },
  css: css("histogram"),
});

export const ASSETS: readonly AnyAsset[] = [barChart, horizontalBarChart, stackedBarChart, lollipopChart, histogram];
