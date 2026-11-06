import { z } from "zod";
import { esc } from "../../kit";
import { list, num, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { REST, caption, catColor, clamp, css, fit, fmt, heading, legendItem, legendRow, listCss, mix, n1, onFill, pct, polar, sector, short, sum, textPx, wholeCells } from "./_parts-kit";

/** Part-to-whole charts the model fills from numbers it already has: pie, donut, waffle, treemap, marimekko and funnel. */
const slice = z.object({ label: text(28), value: num }).strip();
function shares(values: readonly number[]) { const v = values.map(x => Math.max(0, x)), total = sum(v); return { total, share: v.map(x => (total > 0 ? x / total : 0)) }; }
const RING_CSS = (t: string) => `.fpc .a-${t} .a-row{display:flex;flex-wrap:wrap;align-items:center;gap:14px 24px}.fpc .a-${t} .a-row svg{flex:0 1 210px;width:210px;max-width:100%}.fpc .a-${t} .a-row .a-ll{flex:1 1 190px}`;

// ---- pie ---------------------------------------------------------------------------------------------------------------------------
export const pieChart = defineAsset({
  type: "pie_chart", category: "chart", width: "half",
  use: "Share of a whole across two to eight parts, with the percent on each slice and a legend of values.",
  useKo: "전체를 둘에서 여덟 조각으로 나눈 비율을 조각 위 퍼센트와 범례로 보여 줍니다.",
  tags: ["pie", "share", "part of whole", "percentage", "composition", "파이", "원형", "비율", "구성비"],
  notes: "slices: label and value (any unit; shares are computed). Keep to 8 or fewer; merge the tail into one 'Other' slice yourself. unit formats the legend values.",
  fields: { slices: list(slice, 2, 8), unit: unit.default("count"), caption: optionalText(120) },
  sample: { title: "Revenue by region, FY2026", unit: "usd", slices: [{ label: "North America", value: 41200000 }, { label: "Europe", value: 27100000 }, { label: "Asia-Pacific", value: 19300000 }, { label: "Latin America", value: 8200000 }, { label: "Middle East & Africa", value: 4200000 }], caption: "North America and Europe bring in just over two thirds of revenue." },
  render(b, { ko }) {
    const C = 110, R = 80, { share } = shares(b.slices.map(s => s.value));
    let a = 0, last: [number, number] | null = null;
    const marks = b.slices.map((s, i) => {
      const p = share[i];
      if (p <= 0) return "";
      const a0 = a, fill = catColor(i); a += p * Math.PI * 2;
      const body = p >= 0.9999 ? `<circle cx="${C}" cy="${C}" r="${R}" fill="${fill}"/>` : `<path d="${sector(C, C, 0, R, a0, a)}" fill="${fill}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`;
      const mid = (a0 + a) / 2;
      if (p >= 0.09) { const [x, y] = polar(C, C, R * 0.64, mid); return `${body}<text x="${n1(x)}" y="${n1(y)}" text-anchor="middle" dominant-baseline="central" class="a-pl" fill="${onFill(fill)}">${pct(p)}</text>`; }
      if (p >= 0.02) {
        const [x, y] = polar(C, C, R + 14, mid);
        if (last && Math.abs(last[0] - x) < 28 && Math.abs(last[1] - y) < 13) return body;
        last = [x, y];
        return `${body}<text x="${n1(x)}" y="${n1(y)}" text-anchor="middle" dominant-baseline="central" class="a-tx">${pct(p)}</text>`;
      }
      return body;
    }).join("");
    const items = b.slices.map((s, i) => legendItem(catColor(i), s.label, fmt(s.value, b.unit, ko), pct(share[i]))).join("");
    return `${heading(b)}<div class="a-row"><svg viewBox="0 0 220 220" width="100%" aria-hidden="true">${marks || `<circle cx="${C}" cy="${C}" r="${R}" fill="${REST}"/>`}</svg><ul class="a-ll">${items}</ul></div>${caption(b)}`;
  },
  summary: b => { const { share } = shares(b.slices.map((s: { value: number }) => s.value)); return `${b.title ?? "Pie chart"}: ${b.slices.map((s: { label: string; value: number }, i: number) => `${s.label} ${pct(share[i])} (${fmt(s.value, b.unit, false)})`).join("; ")}.`; },
  css: css("pie_chart", `${RING_CSS("pie_chart")}.fpc .a-pie_chart .a-pl{font-size:12px;font-weight:800}`, "tx cap") + listCss("pie_chart"),
});

// ---- donut -------------------------------------------------------------------------------------------------------------------------
export const donutChart = defineAsset({
  type: "donut_chart", category: "chart", width: "half",
  use: "Share of a whole as a ring with the total or a headline in the centre and a legend of values and shares.",
  useKo: "전체 대비 비율을 도넛으로 그리고 가운데에 합계나 핵심 값을, 옆에 값과 비중 범례를 둡니다.",
  tags: ["donut", "ring", "share", "part of whole", "total", "도넛", "비율", "구성비", "합계"],
  notes: "slices: 2-8 label/value pairs. centerValue and centerLabel replace the default centre (the total and the word Total); keep centerValue short.",
  fields: { slices: list(slice, 2, 8), unit: unit.default("count"), centerValue: optionalText(12), centerLabel: optionalText(20), caption: optionalText(120) },
  sample: { title: "Monthly spend by category", unit: "usd", centerLabel: "Spent in October", slices: [{ label: "Housing", value: 2150 }, { label: "Food & groceries", value: 780 }, { label: "Savings", value: 900 }, { label: "Transport", value: 420 }, { label: "Leisure", value: 360 }, { label: "Health", value: 310 }], caption: "Housing and savings take 62% of the month." },
  render(b, { ko, T }) {
    const C = 110, R = 104, r = 68, { total, share } = shares(b.slices.map(s => s.value));
    let a = 0;
    const ring = b.slices.map((s, i) => {
      const p = share[i];
      if (p <= 0) return "";
      const a0 = a; a += p * Math.PI * 2;
      return `<path d="${sector(C, C, r, R, a0, a)}" fill="${catColor(i)}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`;
    }).join("") || `<circle cx="${C}" cy="${C}" r="${(R + r) / 2}" fill="none" stroke="${REST}" stroke-width="${R - r}"/>`;
    const value = b.centerValue ?? short(total, b.unit, ko), fs = clamp(Math.floor((r * 2 * 0.8) / textPx(value, 1, 800)), 14, 30);
    const label = fit(b.centerLabel ?? T("Total", "합계"), r * 2 - 14, 12);
    const centre = `<text x="${C}" y="${n1(C - 5)}" text-anchor="middle" dominant-baseline="central" class="a-big" font-size="${fs}">${esc(value)}</text><text x="${C}" y="${n1(C + fs * 0.55 + 4)}" text-anchor="middle" dominant-baseline="central" class="a-mu" font-size="12">${esc(label)}</text>`;
    const items = b.slices.map((s, i) => legendItem(catColor(i), s.label, fmt(s.value, b.unit, ko), pct(share[i]))).join("");
    return `${heading(b)}<div class="a-row"><svg viewBox="0 0 220 220" width="100%" aria-hidden="true">${ring}${centre}</svg><ul class="a-ll">${items}</ul></div>${caption(b)}`;
  },
  summary: b => { const { total, share } = shares(b.slices.map((s: { value: number }) => s.value)); return `${b.title ?? "Donut chart"}: total ${b.centerValue ?? fmt(total, b.unit, false)}; ${b.slices.map((s: { label: string }, i: number) => `${s.label} ${pct(share[i])}`).join("; ")}.`; },
  css: css("donut_chart", `${RING_CSS("donut_chart")}.fpc .a-donut_chart .a-big{font-weight:800;fill:var(--ink);letter-spacing:-.02em}`, "mu cap") + listCss("donut_chart"),
});

// ---- waffle ------------------------------------------------------------------------------------------------------------------------
export const waffleChart = defineAsset({
  type: "waffle_chart", category: "chart", width: "half",
  use: "Share of a whole as a 10 by 10 grid of squares (one square is one percent) with a large headline percentage.",
  useKo: "전체 비율을 10×10 칸(한 칸 = 1%)으로 채워 보여 주고 큰 대표 퍼센트를 함께 둡니다.",
  tags: ["waffle", "grid", "percent", "share", "proportion", "와플", "격자", "비율", "퍼센트"],
  notes: "categories: 1-5 label/value pairs. With unit percent and values that add up to less than 100 the rest is drawn grey. The headline is the first category's share unless headline is given.",
  fields: { categories: list(slice, 1, 5), unit: unit.default("count"), headline: optionalText(10), headlineLabel: optionalText(40), caption: optionalText(120) },
  sample: { title: "Where orders come from", unit: "percent", categories: [{ label: "Mobile app", value: 48 }, { label: "Website", value: 31 }, { label: "In store", value: 14 }, { label: "Partners", value: 7 }], caption: "The app overtook the website in March." },
  render(b, { ko, T }) {
    const base = b.categories.map(c => ({ label: c.label, value: Math.max(0, c.value) })), known = sum(base.map(c => c.value));
    const rest = b.unit === "percent" && known < 99.5 && known > 0 ? [{ label: T("Rest", "나머지"), value: 100 - known, rest: true }] : [];
    const cats = [...base.map(c => ({ ...c, rest: false })), ...rest], total = sum(cats.map(c => c.value)), share = cats.map(c => (total > 0 ? c.value / total : 0)), count = wholeCells(share, 100);
    const color = (i: number) => (cats[i].rest ? REST : catColor(i));
    const cells: number[][] = cats.map(() => []);
    let k = 0;
    cats.forEach((_, i) => { for (let j = 0; j < count[i]; j++, k++) cells[i].push(k); });
    const grid = !(total > 0) ? `<g fill="${REST}">${Array.from({ length: 100 }, (_, n) => `<rect x="${(n % 10) * 20}" y="${Math.floor(n / 10) * 20}" width="17" height="17" rx="3.5"/>`).join("")}</g>` : cells.map((ks, i) => `<g fill="${color(i)}">${ks.map(n => `<rect x="${(n % 10) * 20}" y="${(9 - Math.floor(n / 10)) * 20}" width="17" height="17" rx="3.5"/>`).join("")}</g>`).join("");
    const head = b.headline ?? pct(share[0]), headLabel = b.headlineLabel ?? cats[0].label;
    const items = cats.map((c, i) => (b.unit === "percent" ? legendItem(color(i), c.label, pct(share[i]), "") : legendItem(color(i), c.label, fmt(c.value, b.unit, ko), pct(share[i])))).join("");
    return `${heading(b)}<div class="a-row"><svg viewBox="0 0 197 197" width="100%" aria-hidden="true">${grid}</svg><div class="a-side"><div class="a-hl" style="color:${catColor(0)}">${esc(head)}</div><div class="a-hs">${esc(headLabel)}</div><ul class="a-ll">${items}</ul></div></div>${caption(b)}`;
  },
  summary: b => { const { share } = shares(b.categories.map((c: { value: number }) => c.value)); return `${b.title ?? "Waffle chart"}: ${b.headline ? `${b.headline} ${b.headlineLabel ?? b.categories[0].label}; ` : ""}${b.categories.map((c: { label: string }, i: number) => `${c.label} ${pct(share[i])}`).join("; ")}.`; },
  css: css("waffle_chart", `${RING_CSS("waffle_chart")}.fpc .a-waffle_chart .a-row svg{flex-basis:200px;width:200px}.fpc .a-waffle_chart .a-side{flex:1 1 190px;min-width:0}.fpc .a-waffle_chart .a-hl{font-size:46px;line-height:1;font-weight:800;letter-spacing:-.03em}.fpc .a-waffle_chart .a-hs{margin:4px 0 14px;font-size:13.5px;font-weight:650;color:var(--muted)}`, "cap") + listCss("waffle_chart"),
});

// ---- treemap -----------------------------------------------------------------------------------------------------------------------
interface Rect { x: number; y: number; w: number; h: number }
/** Squarified layout (Bruls, Huizing, van Wijk): values sorted large to small, every one > 0; returns a rectangle per value inside `r`. */
function squarify(values: readonly number[], r: Rect): Rect[] {
  const total = sum(values), out: Rect[] = values.map(() => ({ x: r.x, y: r.y, w: 0, h: 0 }));
  if (!(total > 0) || r.w <= 0 || r.h <= 0) return out;
  const areas = values.map(v => (v / total) * r.w * r.h);
  const worst = (row: readonly number[], side: number) => { const s = sum(row); return Math.max((side * side * Math.max(...row)) / (s * s), (s * s) / (side * side * Math.min(...row))); };
  let { x, y, w, h } = r, i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h), row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) row.push(areas[j++]);
    const s = sum(row);
    if (w >= h) { const cw = s / h; let yy = y; row.forEach((a, k) => { const hh = a / cw; out[i + k] = { x, y: yy, w: cw, h: hh }; yy += hh; }); x += cw; w -= cw; }
    else { const rh = s / w; let xx = x; row.forEach((a, k) => { const ww = a / rh; out[i + k] = { x: xx, y, w: ww, h: rh }; xx += ww; }); y += rh; h -= rh; }
    i = j;
  }
  return out;
}
const inset = (r: Rect, d: number): Rect => ({ x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) });

export const treemapChart = defineAsset({
  type: "treemap_chart", category: "chart", width: "half",
  use: "Nested rectangles sized by value for four to sixteen parts of a whole, optionally grouped and coloured by group.",
  useKo: "전체를 4~16개 항목의 크기 비례 사각형으로 보여 주며 묶음(그룹)별로 색을 나눌 수 있습니다.",
  tags: ["treemap", "hierarchy", "proportion", "size", "groups", "트리맵", "계층", "비중", "면적"],
  notes: "items: label, value, optional group (same group name = same colour, laid out together). Squares too small for a label are listed under the chart.",
  fields: { items: list(z.object({ label: text(28), value: num, group: optionalText(20) }).strip(), 2, 16), unit: unit.default("count"), caption: optionalText(120) },
  sample: { title: "Monthly cloud spend by service", unit: "usd", items: [{ label: "EC2", value: 48200, group: "Compute" }, { label: "Lambda", value: 9300, group: "Compute" }, { label: "EKS", value: 6100, group: "Compute" }, { label: "S3", value: 21400, group: "Storage" }, { label: "EBS", value: 8700, group: "Storage" }, { label: "Glacier", value: 2600, group: "Storage" }, { label: "RDS", value: 18900, group: "Database" }, { label: "DynamoDB", value: 5400, group: "Database" }, { label: "ElastiCache", value: 3800, group: "Database" }, { label: "CloudFront", value: 7600, group: "Network" }, { label: "Route 53", value: 1200, group: "Network" }], caption: "Compute is 46% of the bill; EC2 alone is a third." },
  render(b, { ko }) {
    const W = 440, H = 290, leaves = b.items.map((it, i) => ({ ...it, i, v: Math.max(0, it.value) })).filter(it => it.v > 0).sort((a, c) => c.v - a.v || a.i - c.i);
    if (!leaves.length) return `${heading(b)}<p class="a-cap">${esc(b.items.map(i => i.label).join(", "))}</p>`;
    const grouped = leaves.some(l => l.group), groupNames = [...new Set(leaves.map(l => l.group ?? ""))];
    const groups = groupNames.map(g => ({ name: g, leaves: leaves.filter(l => (l.group ?? "") === g) })).map(g => ({ ...g, total: sum(g.leaves.map(l => l.v)) })).sort((a, c) => c.total - a.total);
    const max = leaves[0].v, boxes: { l: (typeof leaves)[number]; r: Rect; fill: string }[] = [];
    if (grouped) {
      const rects = squarify(groups.map(g => g.total), { x: 0, y: 0, w: W, h: H });
      groups.forEach((g, gi) => {
        const base = catColor(groupNames.indexOf(g.name)), inner = squarify(g.leaves.map(l => l.v), inset(rects[gi], 1.5));
        g.leaves.forEach((l, k) => boxes.push({ l, r: inset(inner[k], 0.75), fill: mix(base, "#ffffff", Math.min(0.42, k * 0.1)) }));
      });
    } else {
      const rects = squarify(leaves.map(l => l.v), { x: 0, y: 0, w: W, h: H });
      leaves.forEach((l, k) => boxes.push({ l, r: inset(rects[k], 0.75), fill: mix("#2f5fd6", "#ffffff", 0.72 * (1 - Math.sqrt(l.v / max))) }));
    }
    const dropped: string[] = [];
    const cells = boxes.map(({ l, r, fill }) => {
      const fs = r.w * r.h > 12000 ? 13 : r.w < 72 ? 10.5 : 11.5, ink = onFill(fill), val = short(l.v, b.unit, ko), rect = `<rect x="${n1(r.x)}" y="${n1(r.y)}" width="${n1(r.w)}" height="${n1(r.h)}" rx="5" fill="${fill}"/>`;
      const pad = r.w < 72 ? 6 : 8, name = fit(l.label, r.w - 2 * pad, fs, 750);
      const room = r.w >= 44 && r.h >= 24;
      if (room && (name === l.label || r.w >= 90)) {
        const v = r.h >= 40 ? `<text x="${n1(r.x + pad)}" y="${n1(r.y + 16 + fs + 1)}" font-size="${fs - 1}" font-weight="650" fill="${ink}" fill-opacity=".82">${esc(val)}</text>` : "";
        return `${rect}<text x="${n1(r.x + pad)}" y="${n1(r.y + 17)}" font-size="${fs}" font-weight="750" fill="${ink}">${esc(name)}</text>${v}`;
      }
      // A tall narrow tile takes its label turned upright; a tile too small for any label is listed under the chart.
      if (r.w >= 20 && textPx(l.label, 10.5, 750) <= r.h - 12) {
        const x = r.x + 6 + 10.5, y = r.y + r.h - 7, two = r.w >= 36 && textPx(val, 10, 650) + textPx(l.label, 10.5, 750) + 8 <= r.h - 12;
        return `${rect}<text transform="rotate(-90 ${n1(x)} ${n1(y)})" x="${n1(x)}" y="${n1(y)}" font-size="10.5" font-weight="750" fill="${ink}">${esc(l.label)}</text>${two ? `<text transform="rotate(-90 ${n1(x + 13)} ${n1(y)})" x="${n1(x + 13)}" y="${n1(y)}" font-size="10" font-weight="650" fill="${ink}" fill-opacity=".82">${esc(val)}</text>` : ""}`;
      }
      if (room && name.length - 1 >= l.label.length * 0.7) return `${rect}<text x="${n1(r.x + pad)}" y="${n1(r.y + 17)}" font-size="${fs}" font-weight="750" fill="${ink}">${esc(name)}</text>`;
      dropped.push(`${l.label} ${val}`);
      return rect;
    }).join("");
    const key = grouped ? legendRow(groups.map(g => ({ label: `${g.name || "—"} · ${short(g.total, b.unit, ko)}`, color: catColor(groupNames.indexOf(g.name)) })), 8) : "";
    const more = dropped.length ? `<p class="a-cap">${esc(`${ko ? "그 밖" : "Also"}: ${dropped.slice(0, 6).join(" · ")}${dropped.length > 6 ? ` +${dropped.length - 6}` : ""}`)}</p>` : "";
    return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${cells}</svg>${key}${more}${caption(b)}`;
  },
  summary: b => { const { share } = shares(b.items.map((i: { value: number }) => i.value)); const top = b.items.map((i: { label: string; value: number }, k: number) => ({ i, p: share[k] })).sort((x: { p: number }, y: { p: number }) => y.p - x.p).slice(0, 5); return `${b.title ?? "Treemap"}: ${b.items.length} items; largest ${top.map((t: { i: { label: string }; p: number }) => `${t.i.label} ${pct(t.p)}`).join(", ")}.`; },
  css: css("treemap_chart", ".fpc .a-treemap_chart svg{max-width:560px}", "lg cap"),
});

// ---- marimekko ---------------------------------------------------------------------------------------------------------------------
export const marimekkoChart = defineAsset({
  type: "marimekko_chart", category: "chart", width: "two_thirds",
  use: "Two-way share: columns as wide as their total, each split into segment shares (market share by region and vendor).",
  useKo: "열 너비는 열 합계, 열 안의 칸은 구성 비율로 그리는 가변 폭 누적 막대(지역×업체 점유율 등).",
  tags: ["marimekko", "mekko", "variable width", "market share", "stacked", "마리메코", "점유율", "가변 너비", "누적"],
  notes: "segments names the stack (2-6); each column has values in the same order. Column width is its total, segment height its share of that column.",
  fields: { segments: list(text(20), 2, 6), columns: list(z.object({ label: text(20), values: list(num, 1, 6) }).strip(), 2, 8), unit: unit.default("count"), caption: optionalText(120) },
  sample: { title: "Smartphone shipments by region and vendor, 2025", unit: "count", segments: ["Apple", "Samsung", "Xiaomi", "Others"], columns: [{ label: "N. America", values: [62, 30, 3, 25] }, { label: "Europe", values: [33, 30, 20, 12] }, { label: "APAC", values: [70, 62, 80, 98] }, { label: "LatAm", values: [10, 25, 22, 18] }, { label: "MEA", values: [8, 18, 14, 20] }], caption: "Shipments in millions. Column width is the region's total." },
  render(b, { ko }) {
    const W = 560, H = 300, top = 40, gap = 2, bottom = top + 240, cols = b.columns.map(c => ({ label: c.label, v: b.segments.map((_, k) => Math.max(0, c.values[k] ?? 0)) })).map(c => ({ ...c, total: sum(c.v) }));
    const grand = sum(cols.map(c => c.total));
    if (!(grand > 0)) return `${heading(b)}<p class="a-cap">${esc(b.columns.map(c => c.label).join(", "))}</p>`;
    let x = 0; const narrow: string[] = [];
    const draw = cols.map(c => {
      const w = (c.total / grand) * (W - gap * (cols.length - 1)), x0 = x; x += w + gap;
      if (c.total <= 0) return "";
      let y = bottom;
      const cells = c.v.map((v, k) => {
        const h = (v / c.total) * (bottom - top), y0 = y - h; y = y0;
        if (v <= 0) return "";
        const fill = catColor(k), label = w >= 34 && h >= 17 ? `<text x="${n1(x0 + w / 2)}" y="${n1(y0 + h / 2)}" text-anchor="middle" dominant-baseline="central" font-size="${w >= 60 && h >= 24 ? 12 : 10.5}" font-weight="750" fill="${onFill(fill)}">${pct(v / c.total)}</text>` : "";
        return `<rect x="${n1(x0)}" y="${n1(y0)}" width="${n1(w)}" height="${n1(h)}" fill="${fill}" stroke="#fff" stroke-width="1.5"/>${label}`;
      }).join("");
      const name = fit(c.label, w - 4, 12, 750), tot = short(c.total, b.unit, ko);
      if (w < 26) narrow.push(`${c.label} ${tot}`);
      const head = w < 26 ? "" : `<text x="${n1(x0 + w / 2)}" y="${top - 22}" text-anchor="middle" font-size="12" font-weight="750" class="a-ink">${esc(name)}</text>${w >= textPx(tot, 11) + 6 ? `<text x="${n1(x0 + w / 2)}" y="${top - 8}" text-anchor="middle" class="a-mu">${esc(tot)}</text>` : ""}`;
      return `${cells}${head}`;
    }).join("");
    const more = narrow.length ? `<p class="a-cap">${esc(`${ko ? "좁은 열" : "Narrow columns"}: ${narrow.join(" · ")}`)}</p>` : "";
    return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${draw}</svg>${legendRow(b.segments.map((s, k) => ({ label: s, color: catColor(k) })), 6)}${more}${caption(b)}`;
  },
  summary: b => { const tot = b.columns.map((c: { label: string; values: number[] }) => ({ l: c.label, t: sum(c.values.slice(0, b.segments.length).map((v: number) => Math.max(0, v))) })); const g = sum(tot.map((t: { t: number }) => t.t)) || 1; return `${b.title ?? "Marimekko chart"}: ${b.segments.join(", ")} across ${tot.map((t: { l: string; t: number }) => `${t.l} (${pct(t.t / g)} of total)`).join(", ")}.`; },
  css: css("marimekko_chart", ".fpc .a-marimekko_chart .a-ink{fill:var(--ink)}", "mu lg cap"),
});

// ---- funnel ------------------------------------------------------------------------------------------------------------------------
export const funnelChart = defineAsset({
  type: "funnel_chart", category: "chart", width: "half",
  use: "Stages that narrow from top to bottom (visits, sign-ups, paid) with each stage's value and the conversion to the next.",
  useKo: "방문→가입→결제처럼 위에서 아래로 좁아지는 단계별 값과 단계 간 전환율을 보여 줍니다.",
  tags: ["funnel", "conversion", "stages", "pipeline", "drop-off", "퍼널", "전환율", "단계", "깔때기"],
  notes: "stages in order from the widest to the narrowest (2-8), each a label and a count or amount. Conversion between stages and overall is computed.",
  fields: { stages: list(slice, 2, 8), unit: unit.default("count"), caption: optionalText(120) },
  sample: { title: "Sign-up funnel, last 30 days", unit: "count", stages: [{ label: "Site visits", value: 48200 }, { label: "Sign-up started", value: 15400 }, { label: "Account created", value: 11200 }, { label: "Trial activated", value: 6100 }, { label: "Paid", value: 2300 }], caption: "The biggest leak is between a visit and starting the sign-up." },
  render(b, { ko, T }) {
    const n = b.stages.length, rowH = n <= 5 ? 54 : n <= 6 ? 48 : 42, W = 440, H = rowH * n + 4, cx = 252, MAXW = 236;
    const vals = b.stages.map(s => Math.max(0, s.value)), top = Math.max(...vals, 1), wd = vals.map(v => Math.max(6, (v / top) * MAXW));
    const body = b.stages.map((s, i) => {
      const y = 2 + i * rowH, h = rowH - 3, wTop = wd[i], wNext = i + 1 < n ? wd[i + 1] : wd[i] * 0.78, wBot = wTop + (wNext - wTop) * (h / rowH);
      const fill = mix("#2f5fd6", "#8fb0ff", n > 1 ? i / (n - 1) : 0);
      const poly = `<polygon points="${n1(cx - wTop / 2)},${n1(y)} ${n1(cx + wTop / 2)},${n1(y)} ${n1(cx + wBot / 2)},${n1(y + h)} ${n1(cx - wBot / 2)},${n1(y + h)}" fill="${fill}"/>`;
      const label = `<text x="0" y="${n1(y + h / 2 - 3)}" class="a-tx">${esc(fit(s.label, 118, 11.5))}</text><text x="0" y="${n1(y + h / 2 + 14)}" font-size="14.5" font-weight="780" class="a-ink">${esc(fit(fmt(s.value, b.unit, ko), 118, 14.5, 780))}</text>`;
      let conv = "";
      if (i + 1 < n) {
        const ratio = vals[i] > 0 ? vals[i + 1] / vals[i] : 0, yy = y + rowH - 1.5, edge = cx + wNext / 2 + 5;
        conv = `<line x1="${n1(edge)}" x2="370" y1="${n1(yy)}" y2="${n1(yy)}" stroke="#d8ddda" stroke-dasharray="2 3"/><text x="376" y="${n1(yy + 4)}" font-size="12" font-weight="750" class="${ratio > 1 ? "a-warn" : "a-ink2"}">↓ ${pct(ratio)}</text>`;
      }
      return `${poly}${label}${conv}`;
    }).join("");
    const overall = vals[0] > 0 ? vals[n - 1] / vals[0] : 0;
    return `${heading(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${body}</svg><div class="a-ov"><b>${pct(overall)}</b><span>${esc(`${T("overall conversion", "전체 전환율")} · ${fit(b.stages[0].label, 110, 13)} → ${fit(b.stages[n - 1].label, 110, 13)}`)}</span></div>${caption(b)}`;
  },
  summary: b => { const v = b.stages.map((s: { value: number }) => s.value); return `${b.title ?? "Funnel"}: ${b.stages.map((s: { label: string; value: number }) => `${s.label} ${fmt(s.value, b.unit, false)}`).join(" → ")}; overall ${pct(v[0] > 0 ? v[v.length - 1] / v[0] : 0)}.`; },
  css: css("funnel_chart", ".fpc .a-funnel_chart .a-ink{fill:var(--ink)}.fpc .a-funnel_chart .a-ink2{fill:var(--muted)}.fpc .a-funnel_chart .a-warn{fill:var(--amber)}.fpc .a-funnel_chart .a-ov{display:flex;align-items:baseline;gap:10px;margin-top:10px;padding:10px 12px;border-radius:12px;background:var(--surface)}.fpc .a-funnel_chart .a-ov b{font-size:20px;font-weight:800;letter-spacing:-.02em}.fpc .a-funnel_chart .a-ov span{font-size:12.5px;font-weight:650;color:var(--muted)}", "tx cap"),
});

export const ASSETS: readonly AnyAsset[] = [pieChart, donutChart, waffleChart, treemapChart, marimekkoChart, funnelChart];
