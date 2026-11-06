import { type CanvasAssetBlock, type CanvasBlock, type CanvasChart, type CanvasView, isBaseCanvasBlock } from "./schema";
import { assetByType, assetCssFor, assetHtml } from "./blocks/core";
import { CURRENCY, LINE_COLORS, PALETTE, bold, canvasDay, canvasFormat, esc, icon, labelWidth, niceAxis, scaled, signed } from "./kit";

// ---------------------------------------------------------------- HTML (desktop transcript and phone share it)

/** The card speaks the language its content is written in (Korean when the title or blocks are in Hangul), unless the caller says otherwise. */
let KO = false;
const T = (en: string, ko: string) => (KO ? ko : en);
export function canvasValue(value: number, unit: string = "usd"): string { return canvasFormat(value, unit, KO); }
const day = (iso: string) => canvasDay(iso, KO);
export function canvasKorean(view: CanvasView): boolean { return /[\uac00-\ud7a3]/.test(`${view.title} ${view.meta ?? ""} ${JSON.stringify(view.blocks).slice(0, 4000)}`); }

/** One icon for every source: the host does not read a publisher's kind from words in its title (owner: no host word judgment). */
const sourceIcon = (_title: string) => "doc";
export function canvasSourceShortName(title: string): string {
  const head = title.split(/\s[:|–—·•-]\s|:\s/)[0].replace(/\s*\([^)]*\)\s*$/, "").trim();
  const words = head.split(/\s+/);
  return words.length > 4 ? words.slice(0, 3).join(" ") : head || title;
}
const toneClass = (t?: string) => t === "up" ? "g" : t === "down" ? "r" : t === "warn" ? "a" : t === "info" ? "b" : "n";
const chip = (textValue: string, t?: string, iconName?: string, extra = "") => `<span class="chip ${toneClass(t)}${extra}">${iconName && iconName !== "none" ? icon(iconName) : ""}${esc(textValue)}</span>`;


type B<T extends CanvasBlock["type"]> = Extract<CanvasBlock, { type: T }>;
const head = (b: { title?: string }, fallback?: string, extra = "") => (b.title || fallback ? `<div class="sec">${esc(b.title ?? fallback)}${extra}</div>` : "");

function kpisHtml(b: B<"kpis">) {
  return `<div class="kpis" style="--n:${b.items.length}">${b.items.map((m, i) => {
    const change = typeof m.change === "number" ? m.change : typeof m.value === "number" && typeof m.prior === "number" && m.prior !== 0 ? (m.value / m.prior - 1) * 100 : null;
    const t = m.tone ?? (change === null ? undefined : change >= 0 ? "up" : "down");
    return `<div class="kpi" style="animation-delay:${0.06 * i}s"><div class="k">${esc(m.label)}</div><div class="v">${esc(typeof m.value === "string" ? m.value : canvasValue(m.value, m.unit))}</div><div class="d">${change === null ? "" : chip(signed(change, Math.abs(change) < 10 ? 1 : 0), t, change >= 0 ? "up" : "down", " small")}${esc(m.note ?? (typeof m.prior === "number" ? `${T("vs", "이전")} ${canvasValue(m.prior, m.unit)}` : ""))}</div></div>`;
  }).join("")}</div>`;
}
function barsHtml(b: B<"bars">) {
  const all = b.rows.flatMap(r => r.values), max = Math.max(1e-9, ...all.map(Math.abs)), neg = all.some(v => v < 0);
  const legend = b.series.length ? `<span class="legend">${b.series.map((s, i) => `<i class="${i === b.series.length - 1 ? "cur" : "prior"}"></i>${esc(s)}`).join("")}</span>` : "";
  return `${head(b, undefined, legend)}${b.rows.map((r, i) => `<div class="yrow${r.values.length === 1 ? " one" : ""}"><div class="yl">${esc(r.label)}</div><div class="ybars">${r.values.map((v, k) => {
    const last = k === r.values.length - 1, w = Math.abs(v) / max * (neg ? 40 : 72);
    return `<div class="ybar${neg ? " neg" : ""}"><i class="${last ? (v < 0 ? "curneg" : "cur") : "prior"}" style="width:${w.toFixed(2)}%;${neg ? (v < 0 ? `margin-left:${(40 - w).toFixed(2)}%` : "margin-left:40%") : ""};animation-delay:${(0.1 + i * 0.1 + k * 0.12).toFixed(2)}s"></i>${last ? `<b>${esc(canvasValue(v, b.unit))}</b>` : `<span>${esc(canvasValue(v, b.unit))}</span>`}</div>`;
  }).join("")}</div></div>`).join("")}`;
}
function rangesHtml(b: B<"ranges">) {
  const changeChip = b.change === "raised" ? chip(T("Raised", "상향"), "up", undefined, " small") : b.change === "lowered" ? chip(T("Lowered", "하향"), "down", undefined, " small") : b.change === "new" ? chip(T("New", "신규"), "info", undefined, " small") : "";
  return `${head(b, T("Range", "범위"), changeChip)}${b.items.map(g => {
    const u = g.unit ?? b.unit, { lo, hi } = niceAxis(g.low, g.high), x = (v: number) => ((v - lo) / (hi - lo)) * 100, mid = typeof g.marker === "number" ? g.marker : (g.low + g.high) / 2;
    const digits = (v: number) => (u in CURRENCY && Math.abs(v) >= 1e6 ? 3 : 2);
    const lab = u === "percent" ? `${g.low.toFixed(1)}–${g.high.toFixed(1)}%` : u === "usd_per_share" ? `$${g.low.toFixed(2)}–${g.high.toFixed(2)}` : (() => { const a = Math.max(Math.abs(g.low), Math.abs(g.high)), [d, sfx] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1, ""];
      if (d > 1 && g.low >= 0 && u in CURRENCY && !(u === "krw" && KO)) return `${CURRENCY[u]}${(g.low / d).toFixed(digits(g.low))}–${(g.high / d).toFixed(digits(g.high))}${sfx}`;
      return `${canvasValue(g.low, u)} – ${canvasValue(g.high, u)}`; })();
    const tick = (v: number) => (u === "percent" ? `${v.toFixed(1)}%` : u === "usd_per_share" ? `$${v.toFixed(2)}` : canvasValue(v, u).replace(/\.(\d)M$/, ".$1M"));
    return `<div class="range"><div class="rhead"><span>${esc(g.label)}</span><b>${esc(lab)}</b></div><div class="track"><i class="band" style="left:${x(g.low).toFixed(2)}%;width:${(x(g.high) - x(g.low)).toFixed(2)}%"></i><i class="mid" style="left:${x(mid).toFixed(2)}%"></i>${g.markerLabel ? `<em style="left:${x(mid).toFixed(2)}%">${esc(g.markerLabel)}</em>` : ""}</div><div class="ticks">${[0, 1, 2, 3].map(k => `<span>${esc(tick(lo + ((hi - lo) * k) / 3))}</span>`).join("")}</div></div>`;
  }).join("")}`;
}
function chartHtml(b: CanvasChart, uid: string) {
  if (!b.lines.length) return `${head(b)}<p class="muted">${esc(T("The price history could not be read for this chart.", "이 차트의 가격 자료를 읽지 못했습니다."))}</p>`;
  const W = 446, H = 210, change = b.mode === "change" || b.lines.length > 1;
  const lines = b.lines.map(l => ({ ...l, ys: l.points.map(p => (change ? (p.value / l.points[0].value - 1) * 100 : p.value)) }));
  const all = lines.flatMap(l => l.ys), vmin = Math.min(change ? 0 : Infinity, ...all), vmax = Math.max(change ? 0 : -Infinity, ...all), pad = Math.max(change ? 0.3 : (vmax - vmin) * 0.08 || 1, (vmax - vmin) * 0.12);
  const dates = [...new Set(lines.flatMap(l => l.points.map(p => p.date)))].sort(), di = new Map(dates.map((d, i) => [d, i]));
  const X = (i: number) => 40 + (i * (W - 48)) / Math.max(1, dates.length - 1), Y = (v: number) => 16 + ((vmax + pad - v) / (vmax - vmin + 2 * pad)) * (H - 40);
  const fmtY = (v: number) => (change ? `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(Math.abs(v) < 2 && v !== 0 ? 1 : 0)}%` : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(Math.abs(v) < 10 ? 2 : 1));
  const ticks = change ? [0, ...(vmin < -0.25 ? [Math.round(vmin) || Math.round(vmin * 2) / 2] : []), ...(vmax > 0.25 ? [Math.round(vmax) || Math.round(vmax * 2) / 2] : [])] : [vmin, (vmin + vmax) / 2, vmax];
  const paths = lines.map((l, k) => { const d = "M" + l.points.map((p, i) => `${X(di.get(p.date)!).toFixed(1)},${Y(l.ys[i]).toFixed(1)}`).join("L"); return { d, color: LINE_COLORS[k % 4], last: { x: X(di.get(l.points[l.points.length - 1].date)!), y: Y(l.ys[l.ys.length - 1]) } }; });
  const placed: { x: number; y: number; w: number }[] = [];
  const ann = b.annotations.map((a, k) => { const target = Date.parse(a.date); let best = 0; dates.forEach((d, i) => { if (Math.abs(Date.parse(d) - target) < Math.abs(Date.parse(dates[best]) - target)) best = i; });
    const l = lines[0], pi = l.points.findIndex(p => p.date >= dates[best]), y = Y(l.ys[Math.max(0, pi)]), x = X(best), w = labelWidth(a.label), bx = Math.max(0, Math.min(W - w, x - w / 2));
    // Labels never cover each other: below or above the point first, then the nearest free row.
    const free = (top: number) => top >= 0 && top + 26 <= H && placed.every(o => bx + w + 4 <= o.x || o.x + o.w + 4 <= bx || top + 30 <= o.y || o.y + 30 <= top);
    const first = y < H / 2 && k % 2 === 0 ? [14, -38] : [-38, 14];
    const below = [...first, ...[1, 2, 3, 4, 5, 6].flatMap(n => [14 + 30 * n, -38 - 30 * n])].find(off => free(y + off)) ?? first[0];
    placed.push({ x: bx, y: y + below, w });
    return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="#fff" stroke="#101d24" stroke-width="2.5"/><rect x="${bx.toFixed(1)}" y="${(y + below).toFixed(1)}" width="${w.toFixed(1)}" height="26" rx="8" fill="#101d24"/><text x="${(bx + w / 2).toFixed(1)}" y="${(y + below + 17.5).toFixed(1)}" text-anchor="middle" class="annt">${esc(a.label)}</text></g>`; }).join("");
  const legend = lines.length > 1 ? `<div class="clegend">${lines.map((l, k) => `<span><i style="background:${LINE_COLORS[k % 4]}"></i>${esc(l.label)} <b>${esc(signed(l.ys[l.ys.length - 1], 1))}</b></span>`).join("")}</div>` : "";
  return `${head(b)}<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"><defs><linearGradient id="g${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${paths[0].color}" stop-opacity=".16"/><stop offset="1" stop-color="${paths[0].color}" stop-opacity="0"/></linearGradient></defs>
    ${change ? `<line x1="40" x2="${W}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="#c9d0cc" stroke-dasharray="3 5"/>` : ""}${ticks.map(t => `<text x="0" y="${(Y(t) + 4).toFixed(1)}" class="axt">${esc(fmtY(t))}</text>`).join("")}
    ${lines.length === 1 ? `<path d="${paths[0].d}L${paths[0].last.x.toFixed(1)},${H - 10}L40,${H - 10}Z" fill="url(#g${uid})"/>` : ""}
    ${paths.map(p => `<path class="line" d="${p.d}" fill="none" stroke="${p.color}" stroke-width="3" stroke-linejoin="round" pathLength="1"/><circle cx="${p.last.x.toFixed(1)}" cy="${p.last.y.toFixed(1)}" r="5.5" fill="${p.color}" stroke="#fff" stroke-width="2.5"/>`).join("")}${ann}</svg>${legend}`;
}
const DIR: Record<string, [string, string, string]> = { supportive: ["g", "Supportive", "#118558"], pressure: ["r", "Pressure", "#cf3545"], mixed: ["a", "Mixed", "#b7791f"], unclear: ["n", "Unclear", "#8a959b"], depends: ["b", "Depends", "#2f5fd6"] };
const DIR_KO: Record<string, string> = { supportive: "우호적", pressure: "부담", mixed: "엇갈림", unclear: "불분명", depends: "조건부" };
function leansHtml(b: B<"leans">) {
  return `${head(b, T("Read", "판단"))}${b.rows.map((r, i) => { const [c, label, color] = DIR[r.direction], shown = KO ? DIR_KO[r.direction] : label, x = (v: number) => Math.max(1, Math.min(99, 50 + v * 24)), lo = x(r.low > 0 ? 0 : r.low), hi = x(r.high < 0 ? 0 : r.high);
    return `<div class="lrow" style="animation-delay:${(0.05 * i).toFixed(2)}s"><div class="ln">${esc(r.name)}</div><span class="chip ${c} dchip">${shown}</span><div class="meter"><i class="axis"></i><i class="lean" style="left:${(Math.min(lo, hi) - (Math.abs(hi - lo) < 3 ? 1.5 : 0)).toFixed(2)}%;width:${Math.max(3, Math.abs(hi - lo)).toFixed(2)}%;background:${color}"></i></div><div class="lw">${bold(r.reason)}</div></div>`; }).join("")}`;
}
function cellHtml(value: string | number | null, format: string, numeric = false) {
  // A missing value sits where its column's values sit (a numeric column is right-aligned, as its header).
  if (value === null) return `<td class="${numeric ? "num na" : "na"}">—</td>`;
  if (typeof value === "string") return `<td>${bold(value)}</td>`;
  if (format === "change") return `<td class="num ${value >= 0 ? "up" : "down"}">${esc(signed(value, Math.abs(value) < 10 ? 1 : 0))}</td>`;
  if (format === "percent") return `<td class="num">${esc(canvasValue(value, "percent"))}</td>`;
  if (format === "usd") return `<td class="num">${esc(canvasValue(value, "usd"))}</td>`;
  if (format === "multiple") return `<td class="num">${esc(canvasValue(value, "x"))}</td>`;
  return `<td class="num">${esc(value.toLocaleString("en-US", { maximumFractionDigits: 2 }))}</td>`;
}
function tableHtml(b: B<"table">) {
  return `${head(b)}<div class="tw"><table><thead><tr>${b.columns.map((c, i) => `<th${i && c.format !== "text" ? ' class="num"' : ""}>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${b.rows.map(r => `<tr>${b.columns.map((c, i) => cellHtml(r[i] ?? null, c.format, i > 0 && c.format !== "text")).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function heatColor(v: number, format: string, max: number) {
  if (format === "correlation") { const t = Math.max(-1, Math.min(1, v)); return t >= 0 ? `rgba(47,95,214,${(0.08 + 0.6 * t).toFixed(2)})` : `rgba(240,138,36,${(0.08 + 0.6 * -t).toFixed(2)})`; }
  const t = Math.max(-1, Math.min(1, v / max)); return t >= 0 ? `rgba(17,133,88,${(0.08 + 0.62 * t).toFixed(2)})` : `rgba(207,53,69,${(0.08 + 0.62 * -t).toFixed(2)})`;
}
function heatmapHtml(b: B<"heatmap">) {
  const flat = b.values.flat().filter((v): v is number => typeof v === "number"), max = Math.max(1e-9, ...flat.map(Math.abs));
  const fmt = (v: number) => (b.format === "correlation" ? v.toFixed(2) : b.format === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : b.format === "percent" ? `${v.toFixed(1)}%` : signed(v, 1));
  return `${head(b)}<div class="heat" style="grid-template-columns:minmax(90px,1.3fr) repeat(${b.columns.length},minmax(0,1fr))"><span></span>${b.columns.map(c => `<span class="hc">${esc(c)}</span>`).join("")}${b.rows.map((r, i) => `<span class="hr">${esc(r)}</span>${b.columns.map((_, k) => { const v = b.values[i]?.[k]; return typeof v === "number" ? `<span class="hv" style="background:${heatColor(v, b.format, max)};color:${Math.abs(v / max) > 0.6 && b.format !== "correlation" ? "#fff" : "#101d24"}">${esc(fmt(v))}</span>` : '<span class="hv na">—</span>'; }).join("")}`).join("")}</div>`;
}
function allocationHtml(b: B<"allocation">) {
  const total = b.items.reduce((s, it) => s + Math.max(0, it.weight), 0) || 1, C = 2 * Math.PI * 54; let acc = 0;
  const arcs = b.items.map((it, i) => { const w = Math.max(0, it.weight) / total, a = `<circle cx="70" cy="70" r="54" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="22" stroke-dasharray="${Math.max(0, w * C - 2).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-acc * C).toFixed(2)}" transform="rotate(-90 70 70)"/>`; acc += w; return a; }).join("");
  const target = b.items.some(it => typeof it.target === "number");
  return `${head(b, T("Allocation", "비중"))}<div class="alloc"><svg viewBox="0 0 140 140" width="140" height="140">${arcs}</svg><div class="alist">${b.items.map((it, i) => { const w = (Math.max(0, it.weight) / total) * 100;
    return `<div class="arow"><i style="background:${PALETTE[i % PALETTE.length]}"></i><span class="an">${esc(it.label)}</span><b>${w.toFixed(w < 10 ? 1 : 0)}%</b>${target && typeof it.target === "number" ? `<span class="at ${it.target > w ? "up" : it.target < w ? "down" : ""}">→ ${it.target.toFixed(it.target < 10 ? 1 : 0)}%</span>` : ""}${it.note ? `<span class="anote">${esc(it.note)}</span>` : ""}</div>`; }).join("")}</div></div>`;
}
function timelineHtml(b: B<"timeline">) {
  return `${head(b, T("Timeline", "흐름"))}<div class="tl">${b.items.map(it => `<div class="tli"><span class="dot ${toneClass(it.tone)}"></span><div><div class="tld">${esc(day(it.date))}</div><div class="tll">${bold(it.label)}</div>${it.detail ? `<div class="tlx">${bold(it.detail)}</div>` : ""}</div></div>`).join("")}</div>`;
}
function checklistHtml(b: B<"checklist">) {
  const mark: Record<string, [string, string]> = { pass: ["g", "check"], fail: ["r", "alert"], watch: ["a", "target"], unknown: ["n", "clock"] };
  return `${head(b, T("Checklist", "점검"))}${b.items.map(it => { const [c, ic] = mark[it.state]; return `<div class="ck"><span class="cki ${c}">${icon(ic, 14, 2.6)}</span><div><div class="ckt">${bold(it.text)}</div>${it.detail ? `<div class="ckd">${bold(it.detail)}</div>` : ""}</div></div>`; }).join("")}`;
}
function gaugeHtml(b: B<"gauge">) {
  const t = Math.max(0, Math.min(1, (b.value - b.min) / (b.max - b.min || 1))), a = Math.PI * (1 - t), cx = 100, cy = 96, r = 74, x = cx + r * Math.cos(a), y = cy - r * Math.sin(a);
  return `${head(b, b.label)}<div class="gauge"><svg viewBox="0 0 200 112" width="200" height="112"><defs><linearGradient id="gg"><stop offset="0" stop-color="#18b67e"/><stop offset=".5" stop-color="#f0b429"/><stop offset="1" stop-color="#cf3545"/></linearGradient></defs><path d="M26 96 A74 74 0 0 1 174 96" fill="none" stroke="url(#gg)" stroke-width="14" stroke-linecap="round"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="#fff" stroke="#101d24" stroke-width="3.5"/></svg><div class="gv">${esc(b.unit ? canvasValue(b.value, b.unit) : String(b.value))}</div><div class="gr"><span>${esc(b.low ?? (b.unit ? canvasValue(b.min, b.unit) : String(b.min)))}</span><span>${esc(b.high ?? (b.unit ? canvasValue(b.max, b.unit) : String(b.max)))}</span></div>${b.note ? `<p class="gn">${bold(b.note)}</p>` : ""}</div>`;
}
function noteHtml(b: B<"note">) {
  return `<div class="note"><div class="nh">${b.badge ? `<span class="tick mini">${esc(b.badge)}</span>` : ""}${b.title ? `<b>${esc(b.title)}</b>` : ""}<span class="grow"></span>${b.verdict ? chip(b.verdict.text, b.verdict.tone, "target") : ""}</div><p>${bold(b.text)}</p></div>`;
}
const DEFAULT_WIDTH: Record<string, string> = { kpis: "full", bars: "two_thirds", ranges: "third", chart: "half", leans: "half", table: "full", heatmap: "half", allocation: "half", timeline: "half", checklist: "half", gauge: "third", note: "half" };
function blockHtml(b: CanvasBlock | CanvasAssetBlock, uid: string) {
  if (!isBaseCanvasBlock(b)) return assetHtml(b, uid, KO);
  switch (b.type) {
    case "kpis": return kpisHtml(b); case "bars": return barsHtml(b); case "ranges": return rangesHtml(b); case "chart": return chartHtml(b, uid);
    case "leans": return leansHtml(b); case "table": return tableHtml(b); case "heatmap": return heatmapHtml(b); case "allocation": return allocationHtml(b);
    case "timeline": return timelineHtml(b); case "checklist": return checklistHtml(b); case "gauge": return gaugeHtml(b); case "note": return noteHtml(b);
  }
}

/** The line above the answer: what the owner's words were matched to, or how many sources were read, with source chips. */
export function canvasLeadHtml(view: CanvasView, locale?: "ko" | "en"): string {
  KO = locale ? locale === "ko" : canvasKorean(view);
  // A card of assets alone (a diagram, a slide, a document) read no sources: it has no line above it.
  if (!view.sources.length && !view.lead?.matched) return "";
  const matched = view.lead?.matched, asked = view.lead?.asked;
  const textHtml = matched ? (asked && matched.split(" · ")[0].trim().toLowerCase() !== asked.trim().toLowerCase() ? `${esc(asked)} → ${matched.split(" · ").map((part, i) => (i === 0 ? `<b>${esc(part)}</b>` : esc(part))).join(" · ")}` : matched.split(" · ").map((part, i) => (i === 0 ? `<b>${esc(part)}</b>` : esc(part))).join(" · "))
    : T(`Read ${view.sources.length} source${view.sources.length === 1 ? "" : "s"}`, `자료 ${view.sources.length}건을 읽었습니다`);
  const chips = view.sources.filter((s, i, all) => all.findIndex(o => canvasSourceShortName(o.title) === canvasSourceShortName(s.title)) === i).slice(0, matched ? 2 : 4).map(s => `<a class="src" href="${esc(s.url)}" target="_blank" rel="noreferrer" title="${esc(s.title)}">${icon(sourceIcon(s.title), 12)}${esc(canvasSourceShortName(s.title))}</a>`).join("");
  return `<div class="fpc-lead"><span class="ok">${icon("check", 15, 2.6)}</span><span>${textHtml}</span>${chips}</div>`;
}

/** The card itself. `uid` keeps gradient ids distinct when several cards share a page. */
export function canvasBodyHtml(view: CanvasView, uid = "0", locale?: "ko" | "en"): string {
  KO = locale ? locale === "ko" : canvasKorean(view);
  const header = `<header class="ch">${view.badge ? `<span class="tick">${esc(view.badge)}</span>` : ""}<span class="cname">${esc(view.title)}</span>${view.meta ? `<span class="cmeta">${esc(view.meta)}</span>` : ""}<span class="grow"></span>${view.chips.map(c => chip(c.text, c.tone, c.icon)).join("")}</header>`;
  const blocks = view.blocks.map((b, i) => `<section class="blk w-${(b as { width?: string }).width ?? DEFAULT_WIDTH[b.type] ?? assetByType(b.type)?.width ?? "full"} t-${b.type}">${blockHtml(b, `${uid}-${i}`)}</section>`).join("");
  const sources = !view.sources.length ? "" : `<div class="foot">${T("Sources", "출처")}${view.sources.map(s => `<a class="s" href="${esc(s.url)}" target="_blank" rel="noreferrer">${icon(sourceIcon(s.title), 13)}${esc(s.title)}</a>`).join("")}</div>`;
  return `<div class="fpc-card"${view.guide ? ` data-guide="${esc(view.guide)}"` : ""}>${header}<div class="grid">${blocks}</div>${sources}</div>`;
}

/** Scoped styles (every rule under .fpc). Pretendard where the app bundles it, the system face elsewhere. */
export const CANVAS_CSS = `
/* design variables the assets draw with (the base blocks above keep their own literals) */
.fpc{--ink:#101d24;--ink2:#34424a;--muted:#5c6870;--faint:#9aa2a7;--line:#e7e8e5;--surface:#f7f8f7;--green:#118558;--green2:#18b67e;--red:#cf3545;--amber:#b7791f;--amber2:#f0b429;--blue:#2f5fd6;--blue2:#7aa2ff;--orange:#f08a24;--pink:#d6336c;--violet:#a855f7;--teal:#0e9f6e}
.fpc figure.asset{margin:0;min-width:0}.fpc .asset svg{max-width:100%}.fpc .asset svg text{font-family:inherit}
.fpc .af{position:relative;overflow:hidden;container-type:inline-size;border-radius:14px;border:1px solid var(--line);background:#fff}
.fpc .af-16x9{aspect-ratio:16/9}.fpc .af-4x3{aspect-ratio:4/3}.fpc .af-1x1{aspect-ratio:1/1}.fpc .af-9x16{aspect-ratio:9/16;max-width:360px}.fpc .af-a4{aspect-ratio:210/297}.fpc .af-thumb{aspect-ratio:4/3;border-radius:12px}
.fpc{line-height:normal;word-break:keep-all;overflow-wrap:anywhere;font-family:"Pretendard Variable","Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;color:#101d24;font-feature-settings:"tnum" 1;-webkit-font-smoothing:antialiased}
.fpc *{box-sizing:border-box}
.fpc .i{display:inline-block;vertical-align:middle;flex:none}
.fpc-lead{display:flex;flex-wrap:wrap;align-items:center;gap:10px;min-height:30px;font-size:13.5px;font-weight:600;color:#5c6870}
.fpc-lead b{color:#101d24;font-weight:700}.fpc-lead .ok{display:inline-flex;color:#0e9f6e}
.fpc .src{min-height:26px;box-sizing:border-box;max-width:100%;border-radius:8px;background:#fff;border:1px solid #e7e8e5;padding:4px 9px;line-height:16px;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:650;color:#34424a;text-decoration:none}
.fpc-card{position:relative;margin:14px 0 6px;background:#fff;border:1px solid #e7e8e5;border-radius:20px;box-shadow:0 1px 2px rgba(16,29,36,.04),0 18px 48px rgba(16,29,36,.07);padding:22px 28px 18px;container-type:inline-size;animation:fpcrise .5s cubic-bezier(.2,.9,.25,1.15) both}
.fpc .ch{display:flex;flex-wrap:wrap;align-items:center;gap:12px 14px;min-height:44px}
.fpc .tick{height:34px;border-radius:10px;background:#101d24;color:#fff;font-size:15px;font-weight:800;letter-spacing:.04em;padding:0 12px;display:inline-flex;align-items:center}
.fpc .tick.mini{height:28px;font-size:13px}
.fpc .cname{font-size:20px;font-weight:750;letter-spacing:-.3px}.fpc .cmeta{font-size:13.5px;font-weight:600;color:#9aa2a7}.fpc .grow{flex:1}
.fpc .chip{height:30px;border-radius:15px;padding:0 13px;font-size:12.5px;font-weight:700;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.fpc .chip.small{height:24px;padding:0 9px}
.fpc .g{background:#e3f1eb;color:#118558}.fpc .r{background:#f8e6e8;color:#cf3545}.fpc .a{background:#fbf1de;color:#b7791f}.fpc .n{background:#eef0ee;color:#4a5860}.fpc .b{background:#e7eefc;color:#2f5fd6}
.fpc .grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:26px 40px;margin-top:22px}
.fpc .blk{min-width:0}.fpc .w-full{grid-column:span 12}.fpc .w-two_thirds{grid-column:span 8}.fpc .w-half{grid-column:span 6}.fpc .w-third{grid-column:span 4}
.fpc .sec{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:700;color:#53606a;letter-spacing:.01em;margin-bottom:12px}
.fpc .muted{font-size:13px;color:#9aa2a7}
.fpc .kpis{display:grid;grid-template-columns:repeat(var(--n,4),minmax(0,1fr));gap:16px}
.fpc .kpi{position:relative;height:132px;border-radius:16px;background:#f7f8f7;padding:18px 20px;animation:fpcrise .5s cubic-bezier(.2,.9,.25,1.15) both}
.fpc .k{font-size:13px;font-weight:650;color:#5c6870;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fpc .v{font-size:40px;font-weight:780;letter-spacing:-1.2px;margin-top:8px;line-height:1;white-space:nowrap}
.fpc .w-half .kpis,.fpc .w-third .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.fpc .w-third .v{font-size:30px}
@container (max-width:1100px){.fpc .v{font-size:33px;letter-spacing:-.9px}}
.fpc .w-half .lrow{grid-template-columns:minmax(84px,130px) 92px 84px minmax(0,1fr);gap:12px}
@container (max-width:1200px){.fpc .w-half .lrow,.fpc .w-third .lrow{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"n c" "m m" "w w";gap:6px 10px;padding:10px 0}.fpc .w-half .ln,.fpc .w-third .ln{grid-area:n}.fpc .w-half .dchip,.fpc .w-third .dchip{grid-area:c}.fpc .w-half .meter,.fpc .w-third .meter{grid-area:m}.fpc .w-half .lw,.fpc .w-third .lw{grid-area:w}}
.fpc .d{position:absolute;left:20px;right:12px;bottom:16px;display:flex;gap:8px;align-items:center;font-size:12.5px;font-weight:650;color:#9aa2a7;white-space:nowrap;overflow:hidden}
.fpc .legend{display:inline-flex;gap:12px;margin-left:8px;font-weight:600;color:#7a8682}.fpc .legend i{display:inline-block;width:12px;height:8px;border-radius:3px;margin-right:5px}
.fpc .legend i.prior{background:#dfe4e1}.fpc .legend i.cur{background:#18b67e}
.fpc .yrow{display:grid;grid-template-columns:150px minmax(0,1fr);align-items:center;min-height:72px}.fpc .yrow.one{min-height:44px}
.fpc .yl{font-size:14px;font-weight:700;color:#24323a}.fpc .ybars{display:grid;gap:6px}
.fpc .ybar{display:flex;align-items:center;gap:8px;min-width:0}
.fpc .ybar i{display:block;height:18px;border-radius:5px;transform-origin:left;animation:fpcgrow .8s cubic-bezier(.65,0,.35,1) both;flex:none}
.fpc .ybar .prior{background:#dfe4e1}.fpc .ybar .cur{height:22px;border-radius:6px;background:linear-gradient(90deg,#0b4f3c,#18b67e)}.fpc .ybar .curneg{height:22px;border-radius:6px;background:linear-gradient(90deg,#cf3545,#f08a8f);transform-origin:right}
.fpc .ybar span{font-size:12.5px;font-weight:650;color:#8a959b;white-space:nowrap}.fpc .ybar b{font-size:14px;font-weight:780;white-space:nowrap}
.fpc .ybar i{flex:0 1 auto;min-width:6px}.fpc .ybar b,.fpc .ybar span{flex:none}.fpc .yl{padding-right:10px}
.fpc .range{margin-bottom:22px}.fpc .rhead{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:14px;font-weight:700;color:#24323a}.fpc .rhead b{font-size:16px;font-weight:780;color:#118558;white-space:nowrap}
.fpc .track{position:relative;height:20px;margin-top:16px}.fpc .track::before{content:"";position:absolute;left:0;right:0;top:6px;height:8px;border-radius:4px;background:#e6eae7}
.fpc .band{position:absolute;top:0;height:20px;border-radius:10px;background:#18b67e;animation:fpcgrow .7s cubic-bezier(.65,0,.35,1) .35s both;transform-origin:center}
.fpc .mid{position:absolute;top:4px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#fff;border:3px solid #0b4f3c}
.fpc .track em{position:absolute;top:-20px;transform:translateX(-50%);font-style:normal;font-size:11px;font-weight:700;color:#0b4f3c;white-space:nowrap}
.fpc .ticks{display:flex;justify-content:space-between;margin-top:8px;font-size:11.5px;font-weight:600;color:#a3acb1}
.fpc svg{display:block;overflow:visible}.fpc .line{stroke-dasharray:1;animation:fpcdraw 1.6s cubic-bezier(.65,0,.35,1) .3s both}
.fpc .axt{font-size:11.5px;font-weight:600;fill:#a3acb1}.fpc .annt{font-size:12.5px;font-weight:700;fill:#fff}
.fpc .clegend{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:12.5px;font-weight:650;color:#5c6870}.fpc .clegend i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.fpc .lrow{display:grid;grid-template-columns:minmax(120px,190px) 104px minmax(90px,130px) minmax(0,1fr);align-items:center;gap:16px;min-height:64px;border-top:1px solid #f0f1ef;animation:fpcrise .45s ease-out both}
.fpc .ln{font-size:15px;font-weight:700}.fpc .dchip{justify-content:center;width:104px;padding:0}
.fpc .meter{position:relative;height:30px}.fpc .axis{position:absolute;left:4%;right:4%;top:11px;height:8px;border-radius:4px;background:#eceeec}
.fpc .axis::after{content:"";position:absolute;left:50%;top:-6px;width:1.5px;height:20px;background:#c9d0cc}
.fpc .lean{position:absolute;top:11px;height:8px;border-radius:4px;transform-origin:center;animation:fpcgrow .7s cubic-bezier(.65,0,.35,1) both}
.fpc .lw{font-size:13px;line-height:18px;color:#5c6870;font-weight:500}.fpc .lw b{color:#101d24}
.fpc .tw{overflow-x:auto}.fpc table{width:100%;border-collapse:collapse;font-size:14px}
.fpc th{text-align:left;font-size:12px;font-weight:700;color:#7a8682;padding:0 12px 10px 0;border-bottom:1px solid #eceeec;white-space:nowrap}
.fpc td{padding:12px 12px 12px 0;border-bottom:1px solid #f2f3f1;font-weight:600;color:#24323a}.fpc td.num,.fpc th.num{text-align:right;white-space:nowrap;overflow-wrap:normal}
.fpc td.up{color:#118558;font-weight:750}.fpc td.down{color:#cf3545;font-weight:750}.fpc td.na{color:#b9c3be}
.fpc .heat{display:grid;gap:4px;font-size:12.5px;font-weight:650}.fpc .hc{text-align:center;color:#7a8682;font-size:12px;padding-bottom:4px}
.fpc .hr{display:flex;align-items:center;color:#24323a;font-weight:700}.fpc .hv{height:38px;border-radius:8px;display:flex;align-items:center;justify-content:center;animation:fpcrise .4s ease-out both}.fpc .hv.na{background:#f4f5f4;color:#b9c3be}
.fpc .alloc{display:flex;gap:24px;align-items:center}.fpc .alist{flex:1;display:grid;gap:8px}
.fpc .arow{display:flex;align-items:center;gap:10px;font-size:13.5px;font-weight:650}.fpc .arow i{width:10px;height:10px;border-radius:3px;flex:none}
.fpc .an{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fpc .arow b{font-weight:780}
.fpc .at{font-weight:750;color:#7a8682}.fpc .at.up{color:#118558}.fpc .at.down{color:#cf3545}.fpc .anote{color:#9aa2a7;font-weight:600}
.fpc .tl{position:relative;display:grid;gap:14px;padding-left:4px}.fpc .tli{display:grid;grid-template-columns:18px minmax(0,1fr);gap:12px;align-items:start}
.fpc .dot{width:12px;height:12px;border-radius:50%;margin-top:4px;border:3px solid #fff;box-shadow:0 0 0 2px currentColor}.fpc .dot.n{color:#8a959b;background:#8a959b}.fpc .dot.g{background:#118558;color:#118558}.fpc .dot.r{background:#cf3545;color:#cf3545}.fpc .dot.a{background:#b7791f;color:#b7791f}.fpc .dot.b{background:#2f5fd6;color:#2f5fd6}
.fpc .tld{font-size:12px;font-weight:700;color:#9aa2a7}.fpc .tll{font-size:14.5px;font-weight:700;margin-top:2px}.fpc .tlx{font-size:13px;color:#5c6870;margin-top:3px;line-height:18px}
.fpc .ck{display:grid;grid-template-columns:28px minmax(0,1fr);gap:10px;align-items:start;padding:10px 0;border-top:1px solid #f0f1ef}
.fpc .cki{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center}.fpc .ckt{font-size:14.5px;font-weight:700}.fpc .ckd{font-size:13px;color:#5c6870;margin-top:2px;line-height:18px}
.fpc .gauge{display:grid;justify-items:center}.fpc .gv{font-size:34px;font-weight:780;letter-spacing:-1px;margin-top:-6px}.fpc .gr{display:flex;justify-content:space-between;width:200px;font-size:11.5px;font-weight:650;color:#9aa2a7}.fpc .gn{margin:10px 0 0;font-size:13px;line-height:19px;color:#5c6870;text-align:center}
.fpc .note{border-radius:16px;background:#f7f8f7;padding:16px 18px}.fpc .nh{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}.fpc .nh b{font-size:14px;font-weight:750;min-width:0;flex:1 1 120px}.fpc .nh .chip{flex:none}.fpc .nh .grow{display:none}
.fpc .note p{margin:12px 0 0;font-size:14px;line-height:21px;color:#34424a;font-weight:500}.fpc .note p b{font-weight:750;color:#101d24}
.fpc .src .i,.fpc .s .i{flex:none}.fpc .foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:22px;font-size:12.5px;font-weight:600;color:#9aa2a7}
.fpc .s{min-height:26px;box-sizing:border-box;max-width:100%;border-radius:8px;border:1px solid #e7e8e5;padding:4px 10px;line-height:16px;display:inline-flex;align-items:center;gap:6px;color:#45535b;font-weight:650;background:#fff;text-decoration:none}
@keyframes fpcrise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes fpcgrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes fpcdraw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.fpc *{animation:none!important}}
@container (max-width:900px){.fpc .grid{grid-template-columns:minmax(0,1fr);gap:26px}.fpc .blk{grid-column:1/-1!important}.fpc .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.fpc .lrow{grid-template-columns:150px 96px 110px minmax(0,1fr);gap:10px}}
@container (max-width:560px){.fpc-card{padding:18px 16px 14px;border-radius:18px}.fpc .kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.fpc .kpi{height:auto;padding:14px}.fpc .v{font-size:27px}.fpc .d{position:static;margin-top:10px;flex-wrap:wrap;white-space:normal;gap:6px}.fpc .sec{flex-wrap:wrap}.fpc .legend{margin-left:0}
  .fpc .lrow{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"n c" "m m" "w w";gap:6px 10px;padding:10px 0}.fpc .ln{grid-area:n}.fpc .dchip{grid-area:c}.fpc .meter{grid-area:m}.fpc .lw{grid-area:w}
  .fpc .yrow{grid-template-columns:110px minmax(0,1fr)}.fpc table{font-size:12.5px}.fpc th,.fpc td{padding-right:8px}.fpc .cname{font-size:18px}.fpc .alloc{flex-direction:column;align-items:stretch}.fpc .alloc svg{margin:0 auto}}
`;

/** The styles of the assets a card uses (the base styles are CANVAS_CSS); a page installs each asset's styles once, a phone's visual carries only its own. */
export function canvasAssetCss(view: CanvasView): string { return assetCssFor(view.blocks.filter(b => !isBaseCanvasBlock(b)).map(b => b.type)); }

/** A whole standalone document (the phone's sandboxed visual, the scenario renders): lead, card and styles. */
export function canvasDocument(view: CanvasView, options: { lead?: boolean; background?: string } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:${options.background ?? "transparent"}}body{padding:2px}${CANVAS_CSS}${canvasAssetCss(view)}</style></head><body><div class="fpc">${options.lead === false ? "" : canvasLeadHtml(view)}${canvasBodyHtml(view)}</div></body></html>`;
}

/** Cards stored before the canvas (finance.present kinds "earnings" and "impact") shown as the same blocks. */
export function canvasFromLegacy(view: { kind: string } & Record<string, unknown>): CanvasView | null {
  if (view.kind === "canvas") return view as unknown as CanvasView;
  const v = view as any;
  if (view.kind === "earnings") {
    const usd = (v.metrics as any[]).filter(m => m.unit === "usd" && typeof m.prior === "number" && m.prior > 0);
    const blocks: CanvasBlock[] = [{ type: "kpis", items: v.metrics.map((m: any) => ({ label: m.label, value: m.value, unit: m.unit, prior: m.prior ?? undefined, note: m.note })) } as CanvasBlock];
    if (usd.length) blocks.push({ type: "bars", width: v.guidance.length ? "two_thirds" : "full", title: `${v.priorPeriod ? `${v.priorPeriod} → ` : ""}${v.period} · $ millions`, unit: "usd", series: v.priorPeriod ? [v.priorPeriod, v.period] : [], rows: usd.map(m => ({ label: m.label, values: [m.prior, m.value] })) } as CanvasBlock);
    if (v.guidance.length) blocks.push({ type: "ranges", width: usd.length ? "third" : "full", title: v.guidancePeriod ?? "Outlook", unit: "usd", change: v.guidance.some((g: any) => g.change === "raised") ? "raised" : null, items: v.guidance.map((g: any) => ({ label: g.label, low: g.low, high: g.high, unit: g.unit })) } as CanvasBlock);
    const chips: CanvasView["chips"] = [];
    if (v.guidance.some((g: any) => g.change === "raised")) chips.push({ text: "Guidance raised", tone: "up", icon: "up" });
    if (v.nextReport) chips.push({ text: `Next report · ${day(v.nextReport.date)}${v.nextReport.timing ? `, ${String(v.nextReport.timing).replace("_", " ")}` : ""}`, tone: "neutral", icon: "clock" });
    return { kind: "canvas", title: v.company.name, badge: v.company.symbol, meta: [v.company.exchange, `${v.period} results`].filter(Boolean).join(" · "), chips, lead: { asked: v.asked, matched: `${v.company.name} · ${v.company.symbol}` }, blocks, sources: v.sources };
  }
  if (view.kind === "impact") {
    const blocks: CanvasBlock[] = [{ type: "leans", width: "half", title: "Sector read", rows: v.rows } as CanvasBlock];
    if (v.reaction) blocks.push({ type: "chart", width: "half", title: v.reaction.label, mode: "change", lines: [{ label: v.reaction.symbol, unit: v.reaction.currency, points: v.reaction.points.map((p: any) => ({ date: p.date, value: p.value })) }], annotations: v.reaction.annotations, missing: [] });
    for (const w of v.watch ?? []) blocks.push({ type: "note", width: "half", badge: w.symbol, title: "In your watchlist", verdict: { text: w.verdict === "act" ? "Consider acting" : w.verdict === "hold" ? "Hold" : "Watch, don't act", tone: w.verdict === "act" ? "down" : w.verdict === "hold" ? "neutral" : "warn" }, text: w.text } as CanvasBlock);
    return { kind: "canvas", title: v.title, badge: (String(v.title).match(/\b(US|EU|UK|KR|JP|CN)\b/) ?? ["US"])[0], meta: v.subtitle, chips: v.caveat ? [{ text: v.caveat, tone: "neutral", icon: "alert" }] : [], blocks, sources: v.sources };
  }
  return null;
}
