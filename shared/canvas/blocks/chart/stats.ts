import { z } from "zod";
import { esc, niceScale } from "../../kit";
import { list, loose, num, optionalNum, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { caption, catColor, clamp, css, decimals, fit, fmt, heading, legendRow, lineBoxes, mix, n1, pct, placeLabels, plotAxes, polar, regress, short, sum, textPx } from "./_parts-kit";

/** Statistical and comparison charts the model fills with numbers it has: scatter, bubble, box plot, radar and population pyramid. */
/** The white outline that keeps a label legible over gridlines and marks. */
const halo = (type: string) => `.fpc .a-${type} .a-hl{paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round}`;
const BLUE = "#2f5fd6", INK = "#101d24";

// ---- scatter -----------------------------------------------------------------------------------------------------------------------
const dot = z.object({ x: num, y: num, group: optionalText(20), label: optionalText(24) }).strip();

export const scatterPlot = defineAsset({
  type: "scatter_plot", category: "chart", width: "half",
  use: "Relationship between two numbers across five to sixty points, optionally grouped, labelled and with a trend line.",
  useKo: "두 수치의 관계를 5~60개 점으로 보여 주며 그룹 색, 점 이름, 추세선을 넣을 수 있습니다.",
  tags: ["scatter", "correlation", "relationship", "xy", "trend line", "산점도", "상관", "관계", "추세선"],
  notes: "points: x, y, optional group (colour) and label (shown only where it fits). xTitle and yTitle name the axes; xUnit and yUnit format the ticks. trend true draws the least-squares line with its R².",
  fields: { points: list(dot, 3, 60), xTitle: optionalText(30), yTitle: optionalText(30), xUnit: unit.default("count"), yUnit: unit.default("count"), trend: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Ad spend vs. new customers, by campaign", xTitle: "Ad spend ($K)", yTitle: "New customers", trend: true, caption: "Email converts best per dollar; social flattens out above $50K.", points: [
    { x: 12, y: 180, group: "Search" }, { x: 20, y: 260, group: "Search" }, { x: 28, y: 330, group: "Search" }, { x: 35, y: 420, group: "Search", label: "Brand" }, { x: 44, y: 470, group: "Search" }, { x: 52, y: 610, group: "Search" }, { x: 61, y: 650, group: "Search", label: "Competitor" }, { x: 72, y: 780, group: "Search" },
    { x: 8, y: 90, group: "Social" }, { x: 15, y: 150, group: "Social" }, { x: 24, y: 210, group: "Social" }, { x: 33, y: 260, group: "Social" }, { x: 41, y: 330, group: "Social", label: "Influencer" }, { x: 55, y: 380, group: "Social" }, { x: 68, y: 470, group: "Social" }, { x: 78, y: 520, group: "Social" },
    { x: 4, y: 120, group: "Email" }, { x: 6, y: 210, group: "Email" }, { x: 9, y: 260, group: "Email" }, { x: 11, y: 330, group: "Email" }, { x: 14, y: 390, group: "Email", label: "Referral" }, { x: 18, y: 430, group: "Email" }] },
  render(b, { ko, uid, T }) {
    const W = 440, H = 310, pts = b.points;
    const xs = niceScale(Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x)), 4), ys = niceScale(Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y)), 4);
    const ax = plotAxes({ W, H, xs, ys, xFmt: v => short(v, b.xUnit, ko), yFmt: v => short(v, b.yUnit, ko), xTitle: b.xTitle, yTitle: b.yTitle, pad: 7 });
    const groups = [...new Set(pts.map(p => p.group).filter((g): g is string => !!g))], colour = (p: { group?: string }) => catColor(p.group ? groups.indexOf(p.group) : 0);
    const marks = pts.map(p => ({ x: ax.X(p.x), y: ax.Y(p.y), r: 4.8, text: p.label }));
    const fitLine = b.trend ? regress(pts) : null, lo = Math.min(...pts.map(p => p.x)), hi = Math.max(...pts.map(p => p.x));
    const avoid = fitLine ? lineBoxes(ax.X(lo), ax.Y(fitLine.slope * lo + fitLine.intercept), ax.X(hi), ax.Y(fitLine.slope * hi + fitLine.intercept)) : [];
    const labels = placeLabels(marks, ax.plot, 16, 10.5, avoid).map(l => `<text x="${n1(l.x)}" y="${n1(l.y)}" text-anchor="${l.anchor}" dominant-baseline="central" class="a-mu a-hl">${esc(pts[l.i].label)}</text>`).join("");
    const trend = fitLine ? `<clipPath id="${uid}c"><rect x="${n1(ax.plot.l)}" y="${n1(ax.plot.t)}" width="${n1(ax.plot.r - ax.plot.l)}" height="${n1(ax.plot.b - ax.plot.t)}"/></clipPath><line x1="${n1(ax.X(lo))}" y1="${n1(ax.Y(fitLine.slope * lo + fitLine.intercept))}" x2="${n1(ax.X(hi))}" y2="${n1(ax.Y(fitLine.slope * hi + fitLine.intercept))}" clip-path="url(#${uid}c)" stroke="#34424a" stroke-width="1.6" stroke-dasharray="5 4" stroke-linecap="round"/>` : "";
    const dots = pts.map((p, i) => `<circle cx="${n1(marks[i].x)}" cy="${n1(marks[i].y)}" r="4.8" fill="${colour(p)}" fill-opacity=".8" stroke="#fff" stroke-width="1.2"/>`).join("");
    const key = legendRow(groups.map(g => ({ label: g, color: catColor(groups.indexOf(g)) })), 6, fitLine ? `<span><i class="a-tl"></i>${T("Trend", "추세")} · R² ${fitLine.r2.toFixed(2)}</span>` : "");
    return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${ax.svg}${trend}${dots}${labels}</svg>${key}${caption(b)}`;
  },
  summary: b => { const f = regress(b.points); return `${b.title ?? "Scatter plot"}: ${b.points.length} points${b.xTitle && b.yTitle ? `, ${b.yTitle} against ${b.xTitle}` : ""}${f ? `; trend slope ${+f.slope.toFixed(2)}, R² ${f.r2.toFixed(2)}` : ""}.`; },
  css: css("scatter_plot", `${halo("scatter_plot")}.fpc .a-scatter_plot .a-lg .a-tl{width:16px;height:0;border-top:2px dashed var(--ink2);border-radius:0;vertical-align:3px}`, "ax tx mu lg cap"),
});

// ---- bubble ------------------------------------------------------------------------------------------------------------------------
const bubble = z.object({ x: num, y: num, size: num, label: optionalText(24), group: optionalText(20) }).strip();

export const bubbleChart = defineAsset({
  type: "bubble_chart", category: "chart", width: "half",
  use: "Three numbers per item: position on two axes and bubble size (growth vs margin, sized by revenue), with a size key.",
  useKo: "항목마다 세 수치(가로·세로 위치와 버블 크기)를 보여 줍니다(성장률×마진, 크기=매출 등). 크기 범례 포함.",
  tags: ["bubble", "three variables", "size", "portfolio", "scatter", "버블", "거품", "3변수", "크기"],
  notes: "points: x, y, size (area follows size), label and optional group (colour). sizeTitle names the size; sizeUnit formats the size key. 3-30 points; keep labels short.",
  fields: { points: list(bubble, 3, 30), xTitle: optionalText(30), yTitle: optionalText(30), sizeTitle: optionalText(24), xUnit: unit.default("count"), yUnit: unit.default("count"), sizeUnit: unit.default("count"), caption: optionalText(120) },
  sample: { title: "Markets by growth and margin", xTitle: "Market growth (%)", yTitle: "Operating margin (%)", sizeTitle: "Revenue", xUnit: "count", yUnit: "count", sizeUnit: "usd", caption: "India and Indonesia grow fastest but earn the thinnest margins.", points: [
    { label: "US", x: 6, y: 24, size: 4800000, group: "Americas" }, { label: "Canada", x: 1, y: 22.5, size: 880000, group: "Americas" }, { label: "Brazil", x: 9, y: 12, size: 900000, group: "Americas" }, { label: "Mexico", x: 8, y: 14, size: 640000, group: "Americas" },
    { label: "Germany", x: 3, y: 19, size: 1900000, group: "Europe" }, { label: "UK", x: 4, y: 21, size: 1500000, group: "Europe" }, { label: "Japan", x: 2, y: 17, size: 1700000, group: "Asia" }, { label: "India", x: 14, y: 15, size: 1100000, group: "Asia" }, { label: "Indonesia", x: 12, y: 10, size: 520000, group: "Asia" }] },
  render(b, { ko, T }) {
    const W = 440, H = 320, pts = b.points, n = pts.length, rMax = n <= 8 ? 30 : n <= 14 ? 24 : n <= 22 ? 19 : 15, big = Math.max(...pts.map(p => Math.max(0, p.size)), 1);
    const radius = (v: number) => Math.max(3, rMax * Math.sqrt(Math.max(0, v) / big));
    const xs = niceScale(Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x)), 4), ys = niceScale(Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y)), 4);
    const ax = plotAxes({ W, H, xs, ys, xFmt: v => short(v, b.xUnit, ko), yFmt: v => short(v, b.yUnit, ko), xTitle: b.xTitle, yTitle: b.yTitle, pad: rMax });
    const groups = [...new Set(pts.map(p => p.group).filter((g): g is string => !!g))], colour = (p: { group?: string }) => catColor(p.group ? groups.indexOf(p.group) : 0);
    const order = pts.map((p, i) => ({ p, i })).sort((a, c) => c.p.size - a.p.size || a.i - c.i), r = order.map(o => radius(o.p.size));
    const inside = order.map((o, k) => !!o.p.label && textPx(o.p.label, 10.5, 700) + 6 <= r[k] * 1.8 && r[k] >= 12);
    const marks = order.map((o, k) => ({ x: ax.X(o.p.x), y: ax.Y(o.p.y), r: r[k], text: inside[k] ? undefined : o.p.label }));
    const bubbles = order.map((o, k) => `<circle cx="${n1(marks[k].x)}" cy="${n1(marks[k].y)}" r="${n1(r[k])}" fill="${colour(o.p)}" fill-opacity=".5" stroke="${colour(o.p)}" stroke-width="1.6"/>`).join("");
    const inner = order.map((o, k) => (inside[k] ? `<text x="${n1(marks[k].x)}" y="${n1(marks[k].y)}" text-anchor="middle" dominant-baseline="central" class="a-bl">${esc(o.p.label)}</text>` : "")).join("");
    const outer = placeLabels(marks, ax.plot).map(l => `<text x="${n1(l.x)}" y="${n1(l.y)}" text-anchor="${l.anchor}" dominant-baseline="central" class="a-mu a-hl">${esc(order[l.i].p.label)}</text>`).join("");
    // The size key is drawn in the chart's own scale (same viewBox width), so a key circle is exactly as large as the bubble it stands for.
    const kv = [big, big * 0.5, big * 0.1].map(v => +v.toPrecision(2)), kh = Math.ceil(rMax * 2 + 6), title = fit(b.sizeTitle ?? T("Size", "크기"), 110, 10.5, 700);
    let kx = textPx(title, 10.5, 700) + 14, key = `<text x="0" y="${n1(kh / 2)}" dominant-baseline="central" class="a-mu">${esc(title)}</text>`;
    for (const v of kv) {
      const kr = radius(v), label = short(v, b.sizeUnit, ko);
      if (kx + kr * 2 + textPx(label, 10.5) + 8 > W) break;
      key += `<circle cx="${n1(kx + kr)}" cy="${n1(kh - kr - 2)}" r="${n1(kr)}" fill="#f7f8f7" stroke="#9aa2a7" stroke-width="1.3"/><text x="${n1(kx + kr * 2 + 5)}" y="${n1(kh - kr - 2)}" dominant-baseline="central" class="a-mu">${esc(label)}</text>`;
      kx += kr * 2 + textPx(label, 10.5) + 22;
    }
    return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${ax.svg}${bubbles}${inner}${outer}</svg>${legendRow(groups.map(g => ({ label: g, color: catColor(groups.indexOf(g)) })), 6)}<svg class="a-key" viewBox="0 0 ${W} ${kh}" width="100%" aria-hidden="true">${key}</svg>${caption(b)}`;
  },
  summary: b => `${b.title ?? "Bubble chart"}: ${b.points.length} items${b.xTitle && b.yTitle ? `, ${b.yTitle} against ${b.xTitle}` : ""}; largest ${[...b.points].sort((a: { size: number }, c: { size: number }) => c.size - a.size).slice(0, 3).map((p: { label?: string; size: number }) => `${p.label ?? "item"} ${short(p.size, b.sizeUnit, false)}`).join(", ")}.`,
  css: css("bubble_chart", `${halo("bubble_chart")}.fpc .a-bubble_chart .a-bl{font-size:10.5px;font-weight:700;fill:var(--ink)}.fpc .a-bubble_chart .a-key{margin-top:10px}`, "ax tx mu lg cap"),
});

// ---- box plot ----------------------------------------------------------------------------------------------------------------------
const numList = z.preprocess(v => (v === null || v === undefined || v === "" ? [] : Array.isArray(v) ? v.slice(0, 10) : v), z.array(num));
const boxGroup = z.object({ label: text(22), min: num, q1: num, median: num, q3: num, max: num, outliers: numList.optional() }).strip();

export const boxPlot = defineAsset({
  type: "box_plot", category: "chart", width: "half",
  use: "Distribution of a number per group: min, quartiles, median, max and outliers, vertical or horizontal.",
  useKo: "그룹별 분포(최솟값·사분위수·중앙값·최댓값·이상치)를 상자 그림으로 세로 또는 가로로 보여 줍니다.",
  tags: ["box plot", "boxplot", "distribution", "quartile", "median", "outlier", "상자 그림", "분포", "사분위", "중앙값"],
  notes: "groups: label, min, q1, median, q3, max and optional outliers (up to 10 values). orientation vertical (default) or horizontal; axisTitle names the value axis; unit formats ticks and medians.",
  fields: { groups: list(boxGroup, 1, 8), unit: unit.default("count"), orientation: loose(["vertical", "horizontal"], { v: "vertical", column: "vertical", columns: "vertical", up: "vertical", h: "horizontal", row: "horizontal", rows: "horizontal", sideways: "horizontal" }, "vertical").optional(), axisTitle: optionalText(30), caption: optionalText(120) },
  sample: { title: "API response time by endpoint", unit: "count", axisTitle: "Response time (ms)", orientation: "vertical", caption: "Search has the widest spread; checkout is the slowest at the median.", groups: [
    { label: "Login", min: 42, q1: 58, median: 71, q3: 92, max: 128, outliers: [190, 240] }, { label: "Search", min: 35, q1: 80, median: 118, q3: 190, max: 310, outliers: [420, 505, 610] }, { label: "Checkout", min: 120, q1: 160, median: 205, q3: 252, max: 330, outliers: [470] },
    { label: "Profile", min: 28, q1: 44, median: 55, q3: 70, max: 96 }, { label: "Upload", min: 90, q1: 140, median: 176, q3: 240, max: 360, outliers: [520] }] },
  render(b, { ko, T }) {
    const gs = b.groups.map(g => { const v = [g.min, g.q1, g.median, g.q3, g.max].sort((p, q) => p - q), o = g.outliers ?? []; return { label: g.label, mn: v[0], q1: v[1], md: v[2], q3: v[3], mx: v[4], out: o }; });
    const all = gs.flatMap(g => [g.mn, g.mx, ...g.out]), ys = niceScale(Math.min(...all), Math.max(...all), 4), n = gs.length, fillBox = mix(BLUE, "#ffffff", 0.82);
    const med = (g: (typeof gs)[number]) => `${T("med", "중앙")} ${short(g.md, b.unit, ko)}`;
    const key = `<div class="a-lg"><span><i class="a-kb"></i>${T("Q1–Q3 box, line = median", "Q1–Q3 상자, 선 = 중앙값")}</span><span><i class="a-ko"></i>${T("outlier", "이상치")}</span></div>`;
    if (b.orientation === "horizontal") {
      const lw = clamp(Math.max(...gs.map(g => textPx(g.label, 11.5, 750))) + 6, 64, 118), L = lw + 10, R = 16, T0 = 8, P = 46, B = 24 + (b.axisTitle ? 16 : 0), W = 440, H = T0 + n * P + B;
      const X = (v: number) => L + ((v - ys.min) / (ys.max - ys.min)) * (W - L - R);
      const grid = ys.ticks.map(t => `<line x1="${n1(X(t))}" x2="${n1(X(t))}" y1="${T0}" y2="${n1(H - B)}" stroke="${t === ys.min ? "#cfd6d2" : "#eceeec"}"/><text x="${n1(X(t))}" y="${n1(H - B + 15)}" text-anchor="middle" class="a-ax">${esc(short(t, b.unit, ko))}</text>`).join("") + (b.axisTitle ? `<text x="${n1((L + W - R) / 2)}" y="${H - 3}" text-anchor="middle" class="a-tx">${esc(fit(b.axisTitle, W - L - R, 11.5))}</text>` : "");
      const rows = gs.map((g, i) => {
        const cy = T0 + P * (i + 0.5), bh = 20;
        return `<text x="0" y="${n1(cy - 2)}" font-size="11.5" font-weight="750" class="a-ink">${esc(fit(g.label, lw, 11.5, 750))}</text><text x="0" y="${n1(cy + 12)}" class="a-mu">${esc(fit(med(g), lw, 10.5))}</text>`
          + `<line x1="${n1(X(g.mn))}" x2="${n1(X(g.q1))}" y1="${n1(cy)}" y2="${n1(cy)}" stroke="${BLUE}" stroke-width="1.8"/><line x1="${n1(X(g.q3))}" x2="${n1(X(g.mx))}" y1="${n1(cy)}" y2="${n1(cy)}" stroke="${BLUE}" stroke-width="1.8"/>`
          + `<line x1="${n1(X(g.mn))}" x2="${n1(X(g.mn))}" y1="${n1(cy - 5)}" y2="${n1(cy + 5)}" stroke="${BLUE}" stroke-width="1.8"/><line x1="${n1(X(g.mx))}" x2="${n1(X(g.mx))}" y1="${n1(cy - 5)}" y2="${n1(cy + 5)}" stroke="${BLUE}" stroke-width="1.8"/>`
          + `<rect x="${n1(X(g.q1))}" y="${n1(cy - bh / 2)}" width="${n1(Math.max(2, X(g.q3) - X(g.q1)))}" height="${bh}" rx="3" fill="${fillBox}" stroke="${BLUE}" stroke-width="1.8"/><line x1="${n1(X(g.md))}" x2="${n1(X(g.md))}" y1="${n1(cy - bh / 2)}" y2="${n1(cy + bh / 2)}" stroke="${INK}" stroke-width="2.8"/>`
          + g.out.map(o => `<circle cx="${n1(X(o))}" cy="${n1(cy)}" r="3.2" fill="#fff" stroke="${BLUE}" stroke-width="1.6"/>`).join("");
      }).join("");
      return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${grid}${rows}</svg>${key}${caption(b)}`;
    }
    const W = 440, H = 320, T0 = 10, B = 48, R = 12, L = 8 + (b.axisTitle ? 16 : 0) + Math.max(...ys.ticks.map(t => textPx(short(t, b.unit, ko), 11, 600))) + 6, slot = (W - L - R) / n, bw = clamp(slot * 0.46, 14, 40);
    const Y = (v: number) => H - B - ((v - ys.min) / (ys.max - ys.min)) * (H - T0 - B);
    const grid = ys.ticks.map(t => `<line x1="${n1(L)}" x2="${n1(W - R)}" y1="${n1(Y(t))}" y2="${n1(Y(t))}" stroke="${t === ys.min ? "#cfd6d2" : "#e7e8e5"}"/><text x="${n1(L - 6)}" y="${n1(Y(t) + 3.8)}" text-anchor="end" class="a-ax">${esc(short(t, b.unit, ko))}</text>`).join("")
      + (b.axisTitle ? `<text transform="rotate(-90 11 ${n1((T0 + H - B) / 2)})" x="11" y="${n1((T0 + H - B) / 2)}" text-anchor="middle" class="a-tx">${esc(fit(b.axisTitle, H - T0 - B, 11.5))}</text>` : "");
    const cols = gs.map((g, i) => {
      const cx = L + slot * (i + 0.5), cap = bw * 0.28;
      return `<line x1="${n1(cx)}" x2="${n1(cx)}" y1="${n1(Y(g.mn))}" y2="${n1(Y(g.q1))}" stroke="${BLUE}" stroke-width="1.8"/><line x1="${n1(cx)}" x2="${n1(cx)}" y1="${n1(Y(g.q3))}" y2="${n1(Y(g.mx))}" stroke="${BLUE}" stroke-width="1.8"/>`
        + `<line x1="${n1(cx - cap)}" x2="${n1(cx + cap)}" y1="${n1(Y(g.mn))}" y2="${n1(Y(g.mn))}" stroke="${BLUE}" stroke-width="1.8"/><line x1="${n1(cx - cap)}" x2="${n1(cx + cap)}" y1="${n1(Y(g.mx))}" y2="${n1(Y(g.mx))}" stroke="${BLUE}" stroke-width="1.8"/>`
        + `<rect x="${n1(cx - bw / 2)}" y="${n1(Y(g.q3))}" width="${n1(bw)}" height="${n1(Math.max(2, Y(g.q1) - Y(g.q3)))}" rx="3" fill="${fillBox}" stroke="${BLUE}" stroke-width="1.8"/><line x1="${n1(cx - bw / 2)}" x2="${n1(cx + bw / 2)}" y1="${n1(Y(g.md))}" y2="${n1(Y(g.md))}" stroke="${INK}" stroke-width="2.8"/>`
        + g.out.map(o => `<circle cx="${n1(cx)}" cy="${n1(Y(o))}" r="3.2" fill="#fff" stroke="${BLUE}" stroke-width="1.6"/>`).join("")
        + `<text x="${n1(cx)}" y="${H - B + 17}" text-anchor="middle" font-size="11.5" font-weight="750" class="a-ink">${esc(fit(g.label, slot - 4, 11.5, 750))}</text><text x="${n1(cx)}" y="${H - B + 31}" text-anchor="middle" class="a-mu">${esc(fit(med(g), slot - 2, 10.5))}</text>`;
    }).join("");
    return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${grid}${cols}</svg>${key}${caption(b)}`;
  },
  summary: b => `${b.title ?? "Box plot"}: medians ${b.groups.map((g: { label: string; median: number }) => `${g.label} ${short(g.median, b.unit, false)}`).join(", ")}.`,
  css: css("box_plot", ".fpc .a-box_plot .a-ink{fill:var(--ink)}.fpc .a-box_plot .a-lg i{width:14px;height:10px;box-sizing:border-box;border:1.8px solid #2f5fd6;background:#dce5fa}.fpc .a-box_plot .a-lg .a-ko{width:9px;height:9px;border-radius:50%;background:#fff}", "ax tx mu lg cap"),
});

// ---- radar -------------------------------------------------------------------------------------------------------------------------
export const radarChart = defineAsset({
  type: "radar_chart", category: "chart", width: "half",
  use: "Compare one to three profiles across three to eight shared dimensions (skills, scores, product attributes).",
  useKo: "3~8개 공통 항목에서 한~세 개 대상의 프로필(역량·점수·제품 속성)을 거미줄 모양으로 비교합니다.",
  tags: ["radar", "spider", "web", "profile", "skills", "comparison", "레이더", "거미줄", "역량", "프로필"],
  notes: "axes names the dimensions (3-8); every series has one value per axis, in order. max is the outer ring (default: the largest value, rounded up). One series also prints its values beside the axis names.",
  fields: { axes: list(text(16), 3, 8), series: list(z.object({ name: text(24), values: list(num, 1, 8) }).strip(), 1, 3), max: optionalNum, unit: unit.default("count"), caption: optionalText(120) },
  sample: { title: "Vendor scorecard", max: 10, unit: "count", axes: ["Price", "Quality", "Support", "Delivery", "Security", "Integration"], series: [{ name: "Northwind", values: [7, 9, 6, 8, 9, 7] }, { name: "Contoso", values: [9, 6, 8, 6, 5, 8] }], caption: "Northwind wins on quality and security; Contoso on price and support." },
  render(b, { ko }) {
    const W = 440, H = 312, cx = 220, cy = 156, R = 108, n = b.axes.length, top = Math.max(...b.series.flatMap(s => s.values), b.max ?? 0, 1), scale = niceScale(0, b.max ?? top, 4);
    const ang = (k: number) => (k / n) * Math.PI * 2, pt = (k: number, v: number) => polar(cx, cy, R * clamp(v / scale.max, 0, 1), ang(k));
    const rings = scale.ticks.filter(t => t > 0).map(t => `<polygon points="${b.axes.map((_, k) => polar(cx, cy, (R * t) / scale.max, ang(k)).map(n1).join(",")).join(" ")}" fill="${t === scale.max ? "#f7f8f7" : "none"}" stroke="#dfe3e0" stroke-width="1"/>`).join("");
    const spokes = b.axes.map((_, k) => { const [x, y] = polar(cx, cy, R, ang(k)); return `<line x1="${cx}" y1="${cy}" x2="${n1(x)}" y2="${n1(y)}" stroke="#e3e7e4"/>`; }).join("");
    // Ring values sit between two axes (where no mark stands), on the edge of each ring, with a white outline.
    const scaleTicks = scale.ticks.filter(t => t > 0).map(t => { const [x, y] = polar(cx, cy, ((R * t) / scale.max) * Math.cos(Math.PI / n), Math.PI / n); return `<text x="${n1(x + 3)}" y="${n1(y + 3.5)}" class="a-ax a-hl">${esc(short(t, b.unit, ko))}</text>`; }).join("");
    const one = b.series.length === 1;
    const names = b.axes.map((name, k) => {
      const [x, y] = polar(cx, cy, R + 13, ang(k)), s = Math.sin(ang(k)), c = Math.cos(ang(k)), anchor = s > 0.3 ? "start" : s < -0.3 ? "end" : "middle", room = anchor === "middle" ? 110 : Math.max(48, anchor === "start" ? W - x - 4 : x - 4);
      const lines = one ? 2 : 1, y1 = c > 0.25 ? y - (lines - 1) * 13 : c < -0.25 ? y + 8 : y + 4 - (lines - 1) * 6.5;
      return `<text x="${n1(x)}" y="${n1(y1)}" text-anchor="${anchor}" class="a-tx">${esc(fit(name, room, 11.5))}</text>${one ? `<text x="${n1(x)}" y="${n1(y1 + 13)}" text-anchor="${anchor}" font-size="11.5" font-weight="800" fill="${catColor(0)}">${esc(short(b.series[0].values[k] ?? 0, b.unit, ko))}</text>` : ""}`;
    }).join("");
    const shapes = b.series.map((s, i) => {
      const c = catColor(i), p = b.axes.map((_, k) => pt(k, s.values[k] ?? 0));
      return `<polygon points="${p.map(q => q.map(n1).join(",")).join(" ")}" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/>${p.map(q => `<circle cx="${n1(q[0])}" cy="${n1(q[1])}" r="3.4" fill="#fff" stroke="${c}" stroke-width="2"/>`).join("")}`;
    }).join("");
    return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${rings}${spokes}${shapes}${scaleTicks}${names}</svg>${one ? "" : legendRow(b.series.map((s, i) => ({ label: s.name, color: catColor(i) })), 3)}${caption(b)}`;
  },
  summary: b => `${b.title ?? "Radar chart"}: ${b.series.map((s: { name: string; values: number[] }) => `${s.name} ${b.axes.map((a: string, k: number) => `${a} ${s.values[k] ?? 0}`).join(", ")}`).join("; ")}.`,
  css: css("radar_chart", halo("radar_chart"), "ax tx lg cap"),
});

// ---- population pyramid ------------------------------------------------------------------------------------------------------------
export const populationPyramid = defineAsset({
  type: "population_pyramid", category: "chart", width: "half",
  use: "Two groups back to back across age bands or categories (men and women by age, before and after, two audiences).",
  useKo: "두 집단을 연령대나 범주별로 좌우 대칭 막대로 비교합니다(성별 인구 피라미드, 전후 비교 등).",
  tags: ["population pyramid", "pyramid", "back to back", "age", "demographics", "인구 피라미드", "연령", "성별", "대칭 막대"],
  notes: "bands: label, left and right values. leftLabel and rightLabel name the groups. List bands youngest first (they stack from the bottom, like a pyramid); start top reverses that for plain categories.",
  fields: { leftLabel: text(20), rightLabel: text(20), bands: list(z.object({ label: text(14), left: num, right: num }).strip(), 2, 20), unit: unit.default("count"), start: loose(["bottom", "top"], { first_at_top: "top", top_down: "top", down: "top", first_at_bottom: "bottom", bottom_up: "bottom", up: "bottom" }, "bottom").optional(), caption: optionalText(120) },
  sample: { title: "US population by age, 2025", leftLabel: "Male", rightLabel: "Female", unit: "count", caption: "Millions of people. Women outnumber men from the 40s on.", bands: [
    { label: "0–9", left: 19.8, right: 18.9 }, { label: "10–19", left: 21.3, right: 20.3 }, { label: "20–29", left: 22.4, right: 21.5 }, { label: "30–39", left: 23.1, right: 22.8 }, { label: "40–49", left: 20.6, right: 20.9 },
    { label: "50–59", left: 20.9, right: 21.6 }, { label: "60–69", left: 19.0, right: 20.7 }, { label: "70–79", left: 12.6, right: 14.8 }, { label: "80+", left: 5.4, right: 8.6 }] },
  render(b, { ko, T }) {
    const W = 440, n = b.bands.length, P = clamp(Math.floor(330 / n), 14, 28), T0 = 34, B = 24, H = T0 + n * P + B, bh = P - (P >= 20 ? 6 : 4);
    const left = b.bands.map(x => Math.max(0, x.left)), right = b.bands.map(x => Math.max(0, x.right)), labels = b.bands.some(x => x.label.length > 0);
    const cw = clamp(Math.max(...b.bands.map(x => textPx(x.label, 11, 700))) + 14, 44, 84), side = (W - cw) / 2 - 2, showValues = n <= 12 && labels;
    const dp = decimals([...left, ...right]), val = (v: number) => ((b.unit === "count" || b.unit === "text") && dp > 0 && Math.max(...left, ...right) < 1000 ? v.toFixed(dp) : short(v, b.unit, ko)), room = showValues ? 34 : 4, scale = niceScale(0, Math.max(...left, ...right, 1), 3), len = (v: number) => (Math.max(0, v) / scale.max) * (side - room);
    const cl = (W - cw) / 2, cr = cl + cw, rowY = (k: number) => T0 + (b.start === "top" ? k : n - 1 - k) * P;
    const grid = scale.ticks.map(t => `<line x1="${n1(cl - len(t))}" x2="${n1(cl - len(t))}" y1="${T0}" y2="${T0 + n * P}" stroke="#eceeec"/><line x1="${n1(cr + len(t))}" x2="${n1(cr + len(t))}" y1="${T0}" y2="${T0 + n * P}" stroke="#eceeec"/>`
      + (t > 0 ? `<text x="${n1(cl - len(t))}" y="${T0 + n * P + 15}" text-anchor="middle" class="a-ax">${esc(short(t, b.unit, ko))}</text><text x="${n1(cr + len(t))}" y="${T0 + n * P + 15}" text-anchor="middle" class="a-ax">${esc(short(t, b.unit, ko))}</text>` : "")).join("");
    const rows = b.bands.map((x, k) => {
      const y = rowY(k), ly = len(left[k]), ry = len(right[k]), cy = y + P / 2;
      return `<rect x="${n1(cl - ly)}" y="${n1(y + (P - bh) / 2)}" width="${n1(ly)}" height="${bh}" rx="3" fill="${catColor(0)}"/><rect x="${n1(cr)}" y="${n1(y + (P - bh) / 2)}" width="${n1(ry)}" height="${bh}" rx="3" fill="${catColor(3)}"/>`
        + `<text x="${W / 2}" y="${n1(cy)}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" class="a-ink">${esc(fit(x.label, cw - 4, 11, 700))}</text>`
        + (showValues ? `<text x="${n1(cl - ly - 4)}" y="${n1(cy)}" text-anchor="end" dominant-baseline="central" class="a-mu">${esc(val(left[k]))}</text><text x="${n1(cr + ry + 4)}" y="${n1(cy)}" dominant-baseline="central" class="a-mu">${esc(val(right[k]))}</text>` : "");
    }).join("");
    const tl = sum(left), tr = sum(right), tt = tl + tr || 1;
    const head = `<circle cx="5" cy="9" r="4.5" fill="${catColor(0)}"/><text x="14" y="9" dominant-baseline="central" font-size="12.5" font-weight="750" class="a-ink">${esc(fit(b.leftLabel, 140, 12.5, 750))}</text><text x="14" y="25" dominant-baseline="central" class="a-mu">${pct(tl / tt)} ${T("of total", "비중")}</text>`
      + `<circle cx="${W - 5}" cy="9" r="4.5" fill="${catColor(3)}"/><text x="${W - 14}" y="9" text-anchor="end" dominant-baseline="central" font-size="12.5" font-weight="750" class="a-ink">${esc(fit(b.rightLabel, 140, 12.5, 750))}</text><text x="${W - 14}" y="25" text-anchor="end" dominant-baseline="central" class="a-mu">${pct(tr / tt)} ${T("of total", "비중")}</text>`;
    return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${head}${grid}${rows}</svg>${caption(b)}`;
  },
  summary: b => `${b.title ?? "Population pyramid"}: ${b.leftLabel} against ${b.rightLabel} across ${b.bands.length} bands (${b.bands[0].label} to ${b.bands[b.bands.length - 1].label}); ${b.leftLabel} total ${fmt(sum(b.bands.map((x: { left: number }) => x.left)), b.unit, false)}, ${b.rightLabel} total ${fmt(sum(b.bands.map((x: { right: number }) => x.right)), b.unit, false)}.`,
  css: css("population_pyramid", ".fpc .a-population_pyramid .a-ink{fill:var(--ink)}", "ax mu cap"),
});

export const ASSETS: readonly AnyAsset[] = [scatterPlot, bubbleChart, boxPlot, radarChart, populationPyramid];
