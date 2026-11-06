import { z } from "zod";
import { LINE_COLORS, canvasFormat, clip, compact, esc, labelWidth, niceScale } from "../../kit";
import { list, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";

/** Model-supplied numbers as a line (or area) chart. The base `chart` block draws series the host reads; this one draws what the answer already holds. */
const value = z.preprocess(v => (v === null || v === "" || v === undefined ? null : typeof v === "string" ? Number(v.replace(/[,$%\s]/g, "")) : v), z.number().finite().nullable());

export const lineChart = defineAsset({
  type: "line_chart", category: "chart", width: "half",
  use: "Trend of one to four series over ordered labels (months, years, steps), from numbers you already have.",
  useKo: "이미 가진 숫자로 라벨 순서에 따른 한~네 개 계열의 추세선(월·연도·단계)을 그립니다.",
  tags: ["line", "trend", "time series", "area", "추세", "선 그래프", "꺾은선", "시계열"],
  notes: "One value per label per series, null for a gap. unit sets the number format; fill draws an area under a single series.",
  fields: { labels: list(text(14), 2, 24), series: list(z.object({ name: text(30), values: list(value, 2, 24) }).strip(), 1, 4), unit: unit.default("count"), fill: z.boolean().optional(), caption: optionalText(120) },
  sample: { title: "Monthly active users", labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"], unit: "count", fill: true, series: [{ name: "2026", values: [12000, 15400, 14800, 19200, 23100, 27800] }, { name: "2025", values: [9000, 10200, 11800, 12100, 13900, 15200] }], caption: "Growth accelerated after the April launch." },
  render(b, { ko, uid }) {
    const W = 460, H = 220, L = 46, R = 12, T = 14, B = 28, n = b.labels.length;
    const all = b.series.flatMap(s => s.values.filter((v): v is number => v !== null));
    const scale = niceScale(Math.min(0, ...all), Math.max(...all, 1), 4);
    const X = (i: number) => L + (i * (W - L - R)) / Math.max(1, n - 1), Y = (v: number) => T + ((scale.max - v) / (scale.max - scale.min)) * (H - T - B);
    const grid = scale.ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="#e7e8e5"/><text x="${L - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="a-ax">${esc(b.unit === "count" || b.unit === "text" ? compact(t) : canvasFormat(t, b.unit, ko))}</text>`).join("");
    // A label is cut to 8 characters and every k-th one is shown, k from the widest label and the room each one has.
    const shown = b.labels.map(l => clip(l, 8)), every = Math.max(1, Math.ceil(Math.max(...shown.map(l => labelWidth(l) * 0.75)) / ((W - L - R) / Math.max(1, n - 1))));
    const xl = shown.map((l, i) => (i % every === 0 ? `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="a-ax">${esc(l)}</text>` : "")).join("");
    const paths = b.series.map((s, k) => {
      const color = LINE_COLORS[k % 4]; let d = "", pen = false, last = -1;
      s.values.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; last = i; });
      const area = b.fill && b.series.length === 1 && !s.values.includes(null) ? `<path d="${d}L${X(n - 1).toFixed(1)},${Y(0).toFixed(1)}L${X(0).toFixed(1)},${Y(0).toFixed(1)}Z" fill="url(#${uid}a)"/>` : "";
      const dots = s.values.map((v, i) => (v === null ? "" : `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${i === last ? 4.5 : 2.5}" fill="${i === last ? color : "#fff"}" stroke="${color}" stroke-width="2"/>`)).join("");
      return `${area}<path d="${d}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    }).join("");
    const legend = b.series.length > 1 ? `<div class="a-lg">${b.series.map((s, k) => `<span><i style="background:${LINE_COLORS[k % 4]}"></i>${esc(clip(s.name, 30))}</span>`).join("")}</div>` : "";
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"><defs><linearGradient id="${uid}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${LINE_COLORS[0]}" stop-opacity=".18"/><stop offset="1" stop-color="${LINE_COLORS[0]}" stop-opacity="0"/></linearGradient></defs>${grid}${xl}${paths}</svg>${legend}${b.caption ? `<p class="a-cap">${esc(b.caption)}</p>` : ""}`;
  },
  summary: b => `${b.title ?? "Line chart"}: ${b.series.map(s => { const v = s.values.filter((x): x is number => x !== null); return `${s.name} ${compact(v[0])} → ${compact(v[v.length - 1])}`; }).join("; ")} (${b.labels[0]}–${b.labels[b.labels.length - 1]}).`,
  css: ".fpc .a-line_chart svg{max-width:640px}.fpc .a-line_chart .a-ax{font-size:11px;font-weight:600;fill:var(--faint)}.fpc .a-line_chart .a-lg{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;font-size:12.5px;font-weight:650;color:var(--muted)}.fpc .a-line_chart .a-lg i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}.fpc .a-line_chart .a-cap{margin:8px 0 0;font-size:13px;line-height:19px;color:var(--muted)}",
});
export const ASSETS: readonly AnyAsset[] = [lineChart];
