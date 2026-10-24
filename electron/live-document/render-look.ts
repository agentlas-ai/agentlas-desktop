import type { LiveChartGroupLook, LiveChartLook, LiveLookColor, LiveShapeLook } from "../../shared/live-document";

/*
 * Drawing for document.render of what a slide shape looks like in the file (LiveShape.look, codecs/pptx-look.ts): preset outlines
 * as SVG paths, native charts as SVG from the chart part's cached values. Pure markup (no script, no electron import): the render
 * window runs no page script and the layout is tested without a window.
 *
 * Fidelity target is design review, not print: the colours, the shape outlines, the bars, slices and lines with their relative
 * sizes, labels and legend are the file's. Fonts, label placement and axis rounding are this layout's own.
 */

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HEX = /^#[0-9a-fA-F]{6}$/;
const OFFICE_ACCENTS = ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const f = (n: number): string => String(Math.round(n * 100) / 100);

export function cssColor(color: LiveLookColor | undefined): string | undefined {
  if (!color || !HEX.test(color.hex)) return undefined;
  if (color.alpha === undefined) return color.hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${f(color.alpha)})`;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// ── preset geometry ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type Pt = [number, number];
const poly = (points: Pt[]): string => `M${points.map(([x, y]) => `${f(x)},${f(y)}`).join("L")}Z`;

/** Arrow pointing right inside w x h; other directions map these points. */
function arrowRight(w: number, h: number, shaft = 0.5, head = 0.5): Pt[] {
  const hx = Math.max(0, w - Math.min(w, h) * head), y1 = h * (1 - shaft) / 2, y2 = h * (1 + shaft) / 2;
  return [[0, y1], [hx, y1], [hx, 0], [w, h / 2], [hx, h], [hx, y2], [0, y2]];
}

/** The outline of a DrawingML preset as an SVG path in a w x h box (pixels). Unknown presets: the bounding rectangle. */
export function presetPath(geom: string | undefined, w: number, h: number, adjRaw?: number): { d: string; open?: boolean } {
  const m = Math.min(w, h);
  const adj = (fallback: number) => (adjRaw === undefined ? fallback : adjRaw / 100000);
  switch (geom) {
    case undefined: case "rect": case "flowChartProcess": case "custom":
      return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]) };
    case "roundRect": case "flowChartAlternateProcess": case "round2SameRect": case "round1Rect": {
      const r = Math.min(m / 2, m * Math.max(0, adj(0.16667)));
      return { d: `M${f(r)},0H${f(w - r)}A${f(r)},${f(r)} 0 0 1 ${f(w)},${f(r)}V${f(h - r)}A${f(r)},${f(r)} 0 0 1 ${f(w - r)},${f(h)}H${f(r)}A${f(r)},${f(r)} 0 0 1 0,${f(h - r)}V${f(r)}A${f(r)},${f(r)} 0 0 1 ${f(r)},0Z` };
    }
    case "flowChartTerminator": {
      const r = m / 2;
      return { d: `M${f(r)},0H${f(w - r)}A${f(r)},${f(r)} 0 0 1 ${f(w - r)},${f(h)}H${f(r)}A${f(r)},${f(r)} 0 0 1 ${f(r)},0Z` };
    }
    case "ellipse": case "flowChartConnector":
      return { d: `M0,${f(h / 2)}A${f(w / 2)},${f(h / 2)} 0 1 0 ${f(w)},${f(h / 2)}A${f(w / 2)},${f(h / 2)} 0 1 0 0,${f(h / 2)}Z` };
    case "donut": {
      const t = m * adj(0.25);
      const ring = (rx: number, ry: number, x0: number) => `M${f(x0)},${f(h / 2)}A${f(rx)},${f(ry)} 0 1 0 ${f(w - x0)},${f(h / 2)}A${f(rx)},${f(ry)} 0 1 0 ${f(x0)},${f(h / 2)}Z`;
      return { d: ring(w / 2, h / 2, 0) + ring(Math.max(0, w / 2 - t), Math.max(0, h / 2 - t), t) };
    }
    case "line": case "straightConnector1": case "bentConnector2": case "bentConnector3": case "curvedConnector3":
      return { d: `M0,0L${f(w)},${f(h)}`, open: true };
    case "triangle": { const x = w * adj(0.5); return { d: poly([[x, 0], [w, h], [0, h]]) }; }
    case "rtTriangle": return { d: poly([[0, 0], [w, h], [0, h]]) };
    case "diamond": case "flowChartDecision": return { d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) };
    case "parallelogram": case "flowChartInputOutput": { const x = m * adj(0.25); return { d: poly([[x, 0], [w, 0], [w - x, h], [0, h]]) }; }
    case "trapezoid": { const x = m * adj(0.25); return { d: poly([[x, 0], [w - x, 0], [w, h], [0, h]]) }; }
    case "hexagon": { const x = m * adj(0.25); return { d: poly([[x, 0], [w - x, 0], [w, h / 2], [w - x, h], [x, h], [0, h / 2]]) }; }
    case "octagon": { const x = m * adj(0.29289); return { d: poly([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]]) }; }
    case "pentagon": return { d: poly([[w / 2, 0], [w, h * 0.382], [w * 0.809, h], [w * 0.191, h], [0, h * 0.382]]) };
    case "homePlate": { const x = Math.min(w, m * adj(0.5)); return { d: poly([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h]]) }; }
    case "chevron": { const x = Math.min(w / 2, m * adj(0.5)); return { d: poly([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h], [x, h / 2]]) }; }
    case "rightArrow": return { d: poly(arrowRight(w, h)) };
    case "leftArrow": return { d: poly(arrowRight(w, h).map(([x, y]) => [w - x, y])) };
    case "downArrow": return { d: poly(arrowRight(h, w).map(([x, y]) => [y, x])) };
    case "upArrow": return { d: poly(arrowRight(h, w).map(([x, y]) => [y, h - x])) };
    case "leftRightArrow": {
      const head = Math.min(w / 2, m * 0.5), y1 = h / 4, y2 = h * 3 / 4;
      return { d: poly([[0, h / 2], [head, 0], [head, y1], [w - head, y1], [w - head, 0], [w, h / 2], [w - head, h], [w - head, y2], [head, y2], [head, h]]) };
    }
    case "plus": case "mathPlus": {
      const t = m * (geom === "plus" ? adj(0.25) : 0.235);
      return { d: poly([[t, 0], [w - t, 0], [w - t, t], [w, t], [w, h - t], [w - t, h - t], [w - t, h], [t, h], [t, h - t], [0, h - t], [0, t], [t, t]].map(([x, y]) => [x, y] as Pt)) };
    }
    case "star5": {
      const pts: Pt[] = [];
      for (let i = 0; i < 10; i += 1) {
        const r = i % 2 ? 0.382 : 1, a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)]);
      }
      return { d: poly(pts) };
    }
    default:
      return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]) };
  }
}

/** One shape's geometry as an absolutely placed SVG (pixels), with its fill and outline; rotation and flips around its centre. */
export function shapeSvg(look: LiveShapeLook, box: { left: number; top: number; width: number; height: number }, pxPerPt: number, fallbackFill?: string): string {
  const { width: w, height: h } = box;
  const geometry = presetPath(look.geom, w, h, look.adj);
  const fill = geometry.open ? "none" : look.fill === "none" ? "none" : cssColor(look.fill === undefined ? undefined : look.fill) ?? fallbackFill ?? "none";
  const stroke = look.line ? cssColor(look.line.color) : undefined;
  const strokeWidth = look.line ? Math.max(0.75, look.line.width * pxPerPt) : 0;
  const pad = Math.ceil(strokeWidth / 2) + 1;
  const transforms = [look.rot ? `rotate(${f(look.rot)}deg)` : "", look.flipH ? "scaleX(-1)" : "", look.flipV ? "scaleY(-1)" : ""].filter(Boolean).join(" ");
  return `<svg class="g" data-geom="${esc(look.geom ?? "rect")}" style="left:${f(box.left - pad)}px;top:${f(box.top - pad)}px;width:${f(w + pad * 2)}px;height:${f(h + pad * 2)}px${transforms ? `;transform:${transforms}` : ""}" viewBox="${f(-pad)} ${f(-pad)} ${f(w + pad * 2)} ${f(h + pad * 2)}">`
    + `<path d="${geometry.d}" fill="${fill}" fill-rule="evenodd"${stroke ? ` stroke="${stroke}" stroke-width="${f(strokeWidth)}"${look.line?.dash ? ` stroke-dasharray="${f(strokeWidth * 3)} ${f(strokeWidth * 2)}"` : ""}` : ""}/></svg>`;
}

// ── charts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A number as an Excel number-format code shows it (the subset charts use: decimals, thousands, percent). */
export function formatChartValue(value: number, code?: string): string {
  if (!code || code === "General") return String(Number(value.toFixed(2)));
  const percent = code.includes("%");
  const decimals = (/\.(0+)/.exec(code)?.[1] ?? "").length;
  const shown = percent ? value * 100 : value;
  const text = shown.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: /#,##|0,0/.test(code) });
  return percent ? `${text}%` : text;
}

function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const raw = span / 5, power = 10 ** Math.floor(Math.log10(raw)), unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
}

function text(x: number, y: number, body: string, size: number, color: string, anchor: "start" | "middle" | "end" = "middle", extra = ""): string {
  return `<text x="${f(x)}" y="${f(y)}" font-size="${f(size)}" fill="${color}" text-anchor="${anchor}" dominant-baseline="central"${extra}>${esc(body)}</text>`;
}

const textWidth = (body: string, size: number): number => [...body].reduce((sum, ch) => sum + (/[ᄀ-￿]/.test(ch) ? size : size * 0.58), 0);

interface Entry { label: string; color: string }

function legendBox(entries: Entry[], position: NonNullable<LiveChartLook["legend"]>, area: { x: number; y: number; w: number; h: number }, size: number, ink: string): { svg: string; area: typeof area } {
  if (!entries.length) return { svg: "", area };
  const swatch = size * 0.8, gap = size * 0.6;
  const widths = entries.map((e) => swatch + gap * 0.5 + textWidth(e.label, size));
  let svg = "";
  if (position === "r" || position === "l" || position === "tr") {
    const colW = Math.min(area.w * 0.4, Math.max(...widths) + gap * 2);
    const x0 = position === "l" ? area.x + gap : area.x + area.w - colW + gap;
    const top = area.y + area.h / 2 - (entries.length * size * 1.5) / 2;
    entries.forEach((e, i) => {
      const y = top + i * size * 1.5 + size * 0.75;
      svg += `<rect x="${f(x0)}" y="${f(y - swatch / 2)}" width="${f(swatch)}" height="${f(swatch)}" fill="${e.color}"/>` + text(x0 + swatch + gap * 0.5, y, e.label, size, ink, "start");
    });
    return { svg: `<g class="legend">${svg}</g>`, area: position === "l" ? { ...area, x: area.x + colW, w: area.w - colW } : { ...area, w: area.w - colW } };
  }
  const total = widths.reduce((s, w) => s + w + gap, -gap);
  let x = area.x + Math.max(0, (area.w - total) / 2);
  const y = position === "t" ? area.y + size * 0.9 : area.y + area.h - size * 0.9;
  for (const [i, e] of entries.entries()) {
    svg += `<rect x="${f(x)}" y="${f(y - swatch / 2)}" width="${f(swatch)}" height="${f(swatch)}" fill="${e.color}"/>` + text(x + swatch + gap * 0.5, y, e.label, size, ink, "start");
    x += widths[i] + gap;
  }
  return { svg: `<g class="legend">${svg}</g>`, area: position === "t" ? { ...area, y: area.y + size * 1.8, h: area.h - size * 1.8 } : { ...area, h: area.h - size * 1.8 } };
}

function seriesColor(chart: LiveChartLook, group: LiveChartGroupLook, s: number, point?: number): string {
  const palette = chart.palette?.length ? chart.palette : OFFICE_ACCENTS;
  const series = group.series[s];
  if (point !== undefined) {
    const own = series.points?.[point];
    if (own && HEX.test(own)) return own;
    if (group.type === "pie" || group.type === "doughnut" || (group.varyColors && group.series.length === 1)) return palette[point % palette.length];
  }
  return series.color && HEX.test(series.color) ? series.color : palette[s % palette.length];
}

function pieSvg(chart: LiveChartLook, group: LiveChartGroupLook, area: { x: number; y: number; w: number; h: number }, size: number): string {
  const series = group.series[0];
  if (!series) return "";
  const values = series.values.map((v) => (v !== null && v > 0 ? v : 0));
  const total = values.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return "";
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2, r = Math.max(4, Math.min(area.w, area.h) / 2 - size * 0.4);
  const inner = group.type === "doughnut" ? r * Math.max(10, Math.min(90, group.holeSize ?? 50)) / 100 : 0;
  let angle = -Math.PI / 2, svg = "";
  values.forEach((value, i) => {
    if (!value) return;
    const sweep = (value / total) * Math.PI * 2, end = angle + sweep, large = sweep > Math.PI ? 1 : 0, color = seriesColor(chart, group, 0, i);
    const p = (rad: number, a: number): Pt => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    const [x1, y1] = p(r, angle), [x2, y2] = p(r, end);
    const d = sweep >= Math.PI * 2 - 1e-6
      ? `M${f(cx - r)},${f(cy)}A${f(r)},${f(r)} 0 1 1 ${f(cx + r)},${f(cy)}A${f(r)},${f(r)} 0 1 1 ${f(cx - r)},${f(cy)}Z` + (inner ? `M${f(cx - inner)},${f(cy)}A${f(inner)},${f(inner)} 0 1 0 ${f(cx + inner)},${f(cy)}A${f(inner)},${f(inner)} 0 1 0 ${f(cx - inner)},${f(cy)}Z` : "")
      : inner
        ? (() => { const [x3, y3] = p(inner, end), [x4, y4] = p(inner, angle); return `M${f(x1)},${f(y1)}A${f(r)},${f(r)} 0 ${large} 1 ${f(x2)},${f(y2)}L${f(x3)},${f(y3)}A${f(inner)},${f(inner)} 0 ${large} 0 ${f(x4)},${f(y4)}Z`; })()
        : `M${f(cx)},${f(cy)}L${f(x1)},${f(y1)}A${f(r)},${f(r)} 0 ${large} 1 ${f(x2)},${f(y2)}Z`;
    svg += `<path class="slice" data-index="${i}" d="${d}" fill="${color}" fill-rule="evenodd" stroke="#ffffff" stroke-width="1"/>`;
    const labels = group.labels;
    if (labels && (labels.value || labels.percent || labels.category)) {
      const mid = angle + sweep / 2, at = inner ? (r + inner) / 2 : r * 0.62;
      const parts = [labels.category ? chart.categories[i] ?? "" : "", labels.value ? formatChartValue(value, labels.percent ? undefined : labels.format) : "", labels.percent ? formatChartValue(value / total, labels.format?.includes("%") ? labels.format : "0%") : ""].filter(Boolean);
      svg += text(cx + at * Math.cos(mid), cy + at * Math.sin(mid), parts.join(" "), size, luminance(color) < 140 ? "#ffffff" : "#1b1b1b");
    }
    angle = end;
  });
  return svg;
}

function axesSvg(chart: LiveChartLook, groups: LiveChartGroupLook[], area: { x: number; y: number; w: number; h: number }, size: number, ink: string): string {
  const n = chart.categories.length;
  if (!n) return "";
  const horizontal = groups.some((g) => g.type === "bar" && g.dir === "bar");
  const percent = groups.some((g) => g.grouping === "percentStacked");
  // The value range: stacked groups add up per category, the rest are single values; zero is always on the axis.
  let lo = 0, hi = 0;
  for (const g of groups) {
    const stacked = g.grouping === "stacked" || g.grouping === "percentStacked";
    for (let c = 0; c < n; c += 1) {
      if (stacked) {
        let pos = 0, neg = 0, sum = 0;
        for (const s of g.series) { const v = s.values[c] ?? 0; if (v >= 0) pos += v; else neg += v; sum += Math.abs(v); }
        if (g.grouping === "percentStacked") { hi = Math.max(hi, sum ? 1 : 0); lo = Math.min(lo, sum ? neg / sum : 0); }
        else { hi = Math.max(hi, pos); lo = Math.min(lo, neg); }
      } else for (const s of g.series) { const v = s.values[c]; if (v !== null && v !== undefined) { hi = Math.max(hi, v); lo = Math.min(lo, v); } }
    }
  }
  if (chart.min !== undefined) lo = chart.min;
  if (chart.max !== undefined) hi = chart.max;
  if (hi === lo) hi = lo + 1;
  const step = percent ? 0.2 : niceStep(hi - lo);
  const top = chart.max !== undefined ? hi : Math.ceil(hi / step - 1e-9) * step, bottom = chart.min !== undefined ? lo : Math.floor(lo / step + 1e-9) * step;
  const ticks: number[] = [];
  for (let v = bottom; v <= top + step * 1e-6 && ticks.length < 40; v += step) ticks.push(Number(v.toFixed(10)));
  const tickText = (v: number) => formatChartValue(v, percent ? "0%" : undefined);
  const valueLabelW = chart.valueAxis === false ? 0 : Math.max(...ticks.map((v) => textWidth(tickText(v), size))) + size * 0.6;
  const catLabelH = chart.categoryAxis === false ? 0 : size * 1.8;
  const catLabelW = chart.categoryAxis === false ? 0 : Math.min(area.w * 0.3, Math.max(...chart.categories.map((c) => textWidth(c, size))) + size * 0.6);
  const plot = horizontal
    ? { x: area.x + catLabelW, y: area.y + size * 0.6, w: area.w - catLabelW - size * 0.6, h: area.h - size * 0.6 - (chart.valueAxis === false ? 0 : size * 1.8) }
    : { x: area.x + valueLabelW, y: area.y + size * 0.6, w: area.w - valueLabelW - size * 0.4, h: area.h - size * 0.6 - catLabelH };
  if (plot.w <= 4 || plot.h <= 4) return "";
  const scale = (v: number) => (v - bottom) / (top - bottom);
  // Value v as a pixel along the value axis (y for columns, x for horizontal bars).
  const at = (v: number) => (horizontal ? plot.x + scale(v) * plot.w : plot.y + plot.h - scale(v) * plot.h);
  const band = (horizontal ? plot.h : plot.w) / n;
  // Horizontal bars list the first category at the bottom, next to the origin, as Office does.
  const bandStart = (c: number) => (horizontal ? plot.y + (n - 1 - c) * band : plot.x + c * band);
  let svg = "";
  for (const v of ticks) {
    const p = at(v);
    if (chart.gridlines !== false && (chart.gridlines || v === 0)) svg += horizontal ? `<line x1="${f(p)}" y1="${f(plot.y)}" x2="${f(p)}" y2="${f(plot.y + plot.h)}" stroke="#d9d9d9" stroke-width="1"/>` : `<line x1="${f(plot.x)}" y1="${f(p)}" x2="${f(plot.x + plot.w)}" y2="${f(p)}" stroke="#d9d9d9" stroke-width="1"/>`;
    if (chart.valueAxis !== false) svg += horizontal ? text(p, plot.y + plot.h + size * 0.9, tickText(v), size, ink) : text(plot.x - size * 0.3, p, tickText(v), size, ink, "end");
  }
  const zero = at(Math.max(bottom, Math.min(top, 0)));
  svg += horizontal ? `<line x1="${f(zero)}" y1="${f(plot.y)}" x2="${f(zero)}" y2="${f(plot.y + plot.h)}" stroke="#8c8c8c" stroke-width="1"/>` : `<line x1="${f(plot.x)}" y1="${f(zero)}" x2="${f(plot.x + plot.w)}" y2="${f(zero)}" stroke="#8c8c8c" stroke-width="1"/>`;
  if (chart.categoryAxis !== false) chart.categories.forEach((c, i) => {
    const mid = bandStart(i) + band / 2;
    svg += horizontal ? text(plot.x - size * 0.3, mid, c, size, ink, "end") : text(mid, plot.y + plot.h + size * 0.9, c, size, ink);
  });
  const barGroups = groups.filter((g) => g.type === "bar");
  const valueLabel = (g: LiveChartGroupLook, v: number, x: number, y: number) => (g.labels?.value ? text(x, y, formatChartValue(v, g.labels.format), size, ink) : "");
  for (const g of barGroups) {
    const stacked = g.grouping === "stacked" || g.grouping === "percentStacked";
    const groupWidth = band / 2.5, slot = stacked ? groupWidth : groupWidth / Math.max(1, g.series.length);
    for (let c = 0; c < n; c += 1) {
      let pos = 0, neg = 0;
      const sum = g.grouping === "percentStacked" ? g.series.reduce((t, s) => t + Math.abs(s.values[c] ?? 0), 0) || 1 : 1;
      g.series.forEach((s, si) => {
        const raw = s.values[c];
        if (raw === null || raw === undefined) return;
        const v = raw / sum;
        const from = stacked ? (v >= 0 ? pos : neg) : 0, to = from + v;
        if (stacked) { if (v >= 0) pos = to; else neg = to; }
        const offset = bandStart(c) + (band - groupWidth) / 2 + (stacked ? 0 : si * slot);
        const a = at(from), b = at(to), color = seriesColor(chart, g, si, c);
        const rect = horizontal
          ? { x: Math.min(a, b), y: offset, w: Math.abs(b - a), h: slot }
          : { x: offset, y: Math.min(a, b), w: slot, h: Math.abs(b - a) };
        svg += `<rect class="bar" data-series="${si}" data-category="${c}" x="${f(rect.x)}" y="${f(rect.y)}" width="${f(rect.w)}" height="${f(rect.h)}" fill="${color}"/>`;
        svg += horizontal ? valueLabel(g, raw, rect.x + rect.w + size * 1.2, rect.y + rect.h / 2) : valueLabel(g, raw, rect.x + rect.w / 2, rect.y - size * 0.7);
      });
    }
  }
  for (const g of groups.filter((item) => item.type === "line" || item.type === "area")) {
    const stacked = g.grouping === "stacked" || g.grouping === "percentStacked";
    const base = Array<number>(n).fill(0);
    g.series.forEach((s, si) => {
      const color = seriesColor(chart, g, si);
      const pts: Array<Pt | null> = s.values.slice(0, n).map((v, c) => {
        if (v === null || v === undefined) return null;
        const total = g.grouping === "percentStacked" ? g.series.reduce((t, x) => t + Math.abs(x.values[c] ?? 0), 0) || 1 : 1;
        const value = (stacked ? base[c] : 0) + v / total;
        if (stacked) base[c] = value;
        const mid = bandStart(c) + band / 2;
        return horizontal ? [at(value), mid] : [mid, at(value)];
      });
      const drawn = pts.filter((p): p is Pt => !!p);
      if (!drawn.length) return;
      if (g.type === "area") {
        svg += `<path class="area" data-series="${si}" d="M${f(drawn[0][0])},${f(zero)}L${drawn.map(([x, y]) => `${f(x)},${f(y)}`).join("L")}L${f(drawn[drawn.length - 1][0])},${f(zero)}Z" fill="${color}" fill-opacity="0.85"/>`;
      } else {
        const width = Math.max(1.5, (s.width ?? 2.25) * (size / (chart.textSize ?? 10)) * 0.75);
        svg += `<polyline class="line" data-series="${si}" points="${drawn.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${f(width)}" stroke-linejoin="round"/>`;
        for (const [x, y] of drawn) svg += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(width * 1.4)}" fill="${color}"/>`;
      }
      if (g.labels?.value) s.values.slice(0, n).forEach((v, c) => { const p = pts[c]; if (p && v !== null) svg += text(p[0], p[1] - size * 0.9, formatChartValue(v, g.labels?.format), size, ink); });
    });
  }
  return svg;
}

/** The chart as SVG in a w x h box (pixels); `pxPerPt` turns the file's point sizes into this picture's pixels. */
export function chartSvg(chart: LiveChartLook, w: number, h: number, pxPerPt: number): string {
  const size = Math.max(9, (chart.textSize ?? 10) * pxPerPt);
  const ink = chart.textColor && HEX.test(chart.textColor) ? chart.textColor : "#404040";
  let area = { x: size * 0.4, y: size * 0.4, w: w - size * 0.8, h: h - size * 0.8 };
  let svg = chart.background && HEX.test(chart.background) ? `<rect width="${f(w)}" height="${f(h)}" fill="${chart.background}"/>` : "";
  if (chart.title) { svg += text(w / 2, area.y + size * 0.9, chart.title, size * 1.3, ink, "middle", ` font-weight="700"`); area = { ...area, y: area.y + size * 2, h: area.h - size * 2 }; }
  const pie = chart.groups.find((g) => g.type === "pie" || g.type === "doughnut");
  if (chart.unsupported && !chart.groups.length) {
    svg += text(w / 2, h / 2, `${chart.unsupported} chart (drawn by Office; not drawn here)`, size, ink);
    return `<svg class="chart" data-chart="${esc(chart.unsupported)}" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
  }
  const entries: Entry[] = pie
    ? chart.categories.map((c, i) => ({ label: c, color: seriesColor(chart, pie, 0, i) }))
    : chart.groups.flatMap((g) => g.series.map((s, si) => ({ label: s.name || `Series ${si + 1}`, color: seriesColor(chart, g, si) })));
  if (chart.legend) { const placed = legendBox(entries, chart.legend, area, size, ink); svg += placed.svg; area = placed.area; }
  svg += pie ? pieSvg(chart, pie, area, size) : axesSvg(chart, chart.groups, area, size, ink);
  return `<svg class="chart" data-chart="${esc(pie ? pie.type : chart.groups.map((g) => g.type).join("+"))}" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}" xmlns="http://www.w3.org/2000/svg" font-family="inherit">${svg}</svg>`;
}
