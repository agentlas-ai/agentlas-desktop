import { z } from "zod";
import { bold, canvasFormat, clip, compact, esc, icon, niceScale } from "../../kit";
import { list, loose, num, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { ELL, accent, accentHex, body, clamp, fit, flag, head, linesOf, pick, room, slide, sx } from "./_shared";

/** The data slides: one big figure, a chart, a table, a comparison and a price list. */
/** A figure for a label: counts keep one decimal in thousands (19.8K), other units read as the card's own formats. */
const money = (v: number, u: string, ko: boolean) => (u === "count" || u === "text" ? (Math.abs(v) >= 1e3 && Math.abs(v) < 1e6 ? `${v < 0 ? "−" : ""}${+(Math.abs(v) / 1e3).toFixed(1)}K` : compact(v)) : canvasFormat(v, u, ko));
const asObject = (key: string) => (v: unknown) => (typeof v === "string" ? { [key]: v } : v);
type Point = { label: string; value: number };

export const bigStatSlide = defineAsset({
  type: "big_stat_slide", category: "slide", width: "half", frame: "16:9",
  use: "A slide built around one giant statistic with its label, a sentence of context and a small three-bar trend that supports it.",
  useKo: "핵심 수치 하나를 크게 보여주는 슬라이드: 라벨, 한 문장 설명, 그 수치를 받치는 3개 막대 추이.",
  tags: ["slide", "big number", "stat", "kpi", "metric", "headline figure", "슬라이드", "핵심 수치", "지표", "숫자"],
  notes: "stat is the figure as written ('+38%', '$4.2M', '31,400'; 12 characters at most). points are exactly three {label, value} pairs; unit formats the values.",
  fields: { kicker: optionalText(28), stat: text(12), label: text(60), context: optionalText(160), points: list(z.object({ label: text(10), value: num }).strip(), 3, 3).optional(), unit: unit.default("count"), trend: optionalText(40), footer: optionalText(48), accent },
  sample: { kicker: "Q3 headline", stat: "+38%", label: "growth in new accounts, quarter over quarter", context: "31,400 new accounts joined in Q3, led by self-serve signups after the card-free trial launched in April.", unit: "count", trend: "New accounts per quarter", points: [{ label: "Q1", value: 19800 }, { label: "Q2", value: 22800 }, { label: "Q3", value: 31400 }], accent: "blue", footer: "Northwind Labs · Q3 review · 3" },
  render(b, { ko }) {
    const pts = (b.points ?? []) as Point[], max = Math.max(...pts.map(p => Math.abs(p.value)), 1);
    const size = fit(b.stat, pts.length ? 49 : 80, [[19, 1], [16, 1], [13.5, 1], [11, 1], [9, 1], [7.5, 1]]);
    const left = `<div class="a-l">${b.kicker ? `<div class="a-kk" style="font-size:1.7cqw;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--ac)">${esc(b.kicker)}</div>` : ""}<div class="a-st" style="font-size:${size}cqw">${esc(b.stat)}</div><div class="a-lb" style="${clamp(2)}">${esc(b.label)}</div>${b.context ? `<p class="a-cx" style="${clamp(4)}">${esc(b.context)}</p>` : ""}</div>`;
    const mini = pts.length ? `<div class="a-mc">${b.trend ? `<b style="${ELL}">${esc(b.trend)}</b>` : ""}<div class="a-bars">${pts.map(p => `<div><b style="${ELL};max-width:100%">${esc(money(p.value, b.unit, ko))}</b><i style="height:${(3 + (Math.abs(p.value) / max) * 9).toFixed(1)}cqw"></i><span style="${ELL};max-width:100%">${esc(p.label)}</span></div>`).join("")}</div></div>` : "";
    return slide(b.accent, body(left + mini, `display:grid;grid-template-columns:${pts.length ? "1fr 29cqw" : "1fr"};gap:5cqw;align-items:center`), b.footer, "justify-content:center");
  },
  summary: b => `${b.stat} ${b.label}${b.context ? `. ${b.context}` : ""}${b.points ? ` Trend: ${(b.points as Point[]).map(p => `${p.label} ${p.value}`).join(", ")}.` : ""}`,
  css: sx("big_stat_slide", `.a-l{min-width:0;display:flex;flex-direction:column;gap:1.3cqw}
.a-st{font-weight:800;line-height:.95;letter-spacing:-.045em;color:var(--ac);white-space:nowrap}
.a-lb{font-size:3.2cqw;line-height:1.2;font-weight:800}
.a-cx{margin:0;font-size:2.3cqw;line-height:1.45;font-weight:520;color:var(--muted)}
.a-mc{padding:2.4cqw;border-radius:2cqw;background:var(--ac2);display:flex;flex-direction:column;gap:1.6cqw}
.a-mc>b{font-size:1.8cqw;line-height:1.3;font-weight:800;color:var(--muted)}
.a-bars{height:20cqw;display:grid;grid-template-columns:repeat(3,1fr);gap:1.8cqw;align-items:end}
.a-bars>div{display:flex;flex-direction:column;align-items:center;gap:.8cqw;min-width:0}
.a-bars i{display:block;width:100%;border-radius:.9cqw .9cqw .3cqw .3cqw;background:var(--ac);opacity:.32}
.a-bars>div:last-child i{opacity:1}
.a-bars b{font-size:2cqw;font-weight:800}
.a-bars span{font-size:1.8cqw;font-weight:650;color:var(--muted)}`),
});

const kind = loose(["bar", "line"], { bars: "bar", column: "bar", columns: "bar", lines: "line", trend: "line", area: "line" }, "bar").optional();
export const chartSlide = defineAsset({
  type: "chart_slide", category: "slide", width: "half", frame: "16:9",
  use: "A slide with a heading, a takeaway sentence and a bar or line chart drawn from labels and values you supply, with one point highlighted.",
  useKo: "제목, 핵심 문장과 함께 직접 준 라벨·값으로 그린 막대 또는 선 차트 슬라이드(강조 항목 선택).",
  tags: ["slide", "chart", "bar", "line", "graph", "data", "슬라이드", "차트", "막대", "그래프"],
  notes: "kind is bar (default) or line. labels and values pair up (2-8). highlight is a label (or its 1-based position); the last point is highlighted by default. takeaway may use **bold**.",
  fields: { heading: text(64), takeaway: optionalText(120), kind, labels: list(text(10), 2, 8), values: list(num, 2, 8), unit: unit.default("count"), highlight: optionalText(10), note: optionalText(60), footer: optionalText(48), accent },
  sample: { heading: "New accounts nearly doubled in a year", takeaway: "Q3 brought **31,400** new accounts, up from 19,800 in Q1, with the biggest step after the April launch.", kind: "bar", labels: ["Q4 '25", "Q1", "Q2", "Q3"], values: [17200, 19800, 22800, 31400], unit: "count", highlight: "Q3", note: "Source: Northwind product analytics", accent: "blue", footer: "Northwind Labs · Q3 review · 6" },
  render(b, { ko, uid }) {
    const n = Math.min(b.labels.length, b.values.length), labs = (b.labels as string[]).slice(0, n), vals = (b.values as number[]).slice(0, n), [c, soft] = accentHex(b.accent);
    const isLine = b.kind === "line", W = b.takeaway ? 400 : 640, H = 230, L = 12, R = 12, T = 30, B = 34, slot = (W - L - R) / n;
    const lo = Math.min(...vals), hi = Math.max(...vals), scale = isLine && lo > hi * 0.4 ? niceScale(lo - (hi - lo) * 0.15, hi, 3) : niceScale(Math.min(0, lo), Math.max(0, hi), 3);
    const Y = (v: number) => T + ((scale.max - v) / (scale.max - scale.min)) * (H - T - B), X = (i: number) => L + slot * (i + 0.5), z0 = Y(Math.max(scale.min, Math.min(0, scale.max)));
    const want = (b.highlight ?? "").toLowerCase(), find = want ? labs.findIndex(l => l.toLowerCase() === want) : -1, at = Number(b.highlight), hl = find >= 0 ? find : Number.isInteger(at) && at >= 1 && at <= n ? at - 1 : n - 1;
    const grid = scale.ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="${t === 0 ? "#cfd6d2" : "#e9eae7"}"/>`).join("");
    const xl = labs.map((l, i) => `<text x="${X(i).toFixed(1)}" y="${H - 11}" text-anchor="middle" font-size="14" font-weight="${i === hl ? 800 : 600}" fill="${i === hl ? "#101d24" : "#5c6870"}">${esc(clip(l, n > 6 ? 6 : 9))}</text>`).join("");
    const vl = (i: number, y: number) => `<text x="${X(i).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="${n > 6 ? 14 : 15.5}" font-weight="800" fill="${i === hl ? c : "#34424a"}">${esc(money(vals[i], b.unit, ko))}</text>`;
    let marks = "";
    if (isLine) {
      const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
      marks = `<defs><linearGradient id="${uid}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".2"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs><path d="${d}L${X(n - 1).toFixed(1)},${z0.toFixed(1)}L${X(0).toFixed(1)},${z0.toFixed(1)}Z" fill="url(#${uid}a)"/><path d="${d}" fill="none" stroke="${c}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>${vals.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${i === hl ? 6.5 : 4.5}" fill="${i === hl ? c : "#fff"}" stroke="${c}" stroke-width="2.6"/>${vl(i, Y(v) - 12)}`).join("")}`;
    } else {
      const bw = Math.min(56, slot * 0.6);
      marks = vals.map((v, i) => { const y = Math.min(Y(v), z0), h = Math.max(2, Math.abs(Y(v) - z0)); return `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="${i === hl ? c : soft}"/>${vl(i, v >= 0 ? y - 8 : y + h + 17)}`; }).join("");
    }
    const left = b.takeaway ? `<div class="a-tk"><p>${bold(b.takeaway)}</p>${b.note ? `<small>${esc(b.note)}</small>` : ""}</div>` : "";
    return slide(b.accent, `${head(b.heading)}${body(`${left}<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%;min-width:0" role="img" aria-hidden="true">${grid}${marks}${xl}</svg>`, `display:grid;grid-template-columns:${b.takeaway ? "27cqw 1fr" : "1fr"};grid-template-rows:minmax(0,1fr);gap:4cqw`)}`, b.footer);
  },
  summary: b => `${b.heading}${b.takeaway ? `: ${String(b.takeaway).replace(/\*\*/g, "")}` : ""} (${b.kind ?? "bar"} chart: ${(b.labels as string[]).slice(0, 8).map((l, i) => `${l} ${b.values[i]}`).join(", ")})`,
  css: sx("chart_slide", `.a-tk{min-width:0;display:flex;flex-direction:column;justify-content:center;gap:2cqw;padding-left:2.2cqw;border-left:.6cqw solid var(--ac)}
.a-tk p{${clamp(7)};margin:0;font-size:2.7cqw;line-height:1.38;font-weight:620;color:var(--ink2)}
.a-tk b{font-weight:800;color:var(--ac)}
.a-tk small{font-size:1.7cqw;line-height:1.35;font-weight:600;color:var(--faint)}`),
});

/** A table cell: empty is allowed, a number is written as text, long text is cut. */
const cell = (max: number) => z.preprocess(v => (v === null || v === undefined ? "" : typeof v === "number" ? String(v) : v), z.string().transform(v => { const t = v.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; }));
const NUMERIC = /^[−+\-–]?\s*[$€£¥₩]?\s*\d[\d,.]*\s*(?:%|[KMBkmb]|x|×|pts?|bp|원|만|억|조)?$/;
export const tableSlide = defineAsset({
  type: "table_slide", category: "slide", width: "half", frame: "16:9",
  use: "A slide with a heading and a compact table (up to six rows and five columns) with one highlighted row and right-aligned numbers.",
  useKo: "제목과 간결한 표(최대 6행 5열)가 있는 슬라이드: 강조 행 하나, 숫자는 오른쪽 정렬.",
  tags: ["slide", "table", "rows", "columns", "data", "grid", "슬라이드", "표", "테이블", "데이터"],
  notes: "columns is 2-5 headers; each row is a list of cells in the same order. highlight is the 1-based row to emphasise. A cell starting with + or − is coloured as a change.",
  fields: { heading: text(64), columns: list(text(18), 2, 5), rows: list(list(cell(28), 1, 5), 1, 6), highlight: z.preprocess(v => (v === null || v === "" ? undefined : v), z.coerce.number().int().min(1).max(6).optional()), note: optionalText(80), footer: optionalText(48), accent },
  sample: { heading: "Acquisition by channel, Q3", columns: ["Channel", "New accounts", "Share", "vs Q2"], rows: [["Self-serve signup", "12,950", "41%", "+38%"], ["Partner referrals", "6,280", "20%", "+22%"], ["Content and SEO", "4,710", "15%", "+9%"], ["Paid ads", "3,140", "10%", "−6%"], ["Events", "4,320", "14%", "+31%"]], highlight: 1, note: "Accounts that completed signup in Q3; shares are rounded.", accent: "blue", footer: "Northwind Labs · Q3 review · 7" },
  render(b) {
    const cols = b.columns as string[], k = cols.length, rows = (b.rows as string[][]).map(r => Array.from({ length: k }, (_, i) => r[i] ?? ""));
    const numeric = cols.map((_, i) => { const cells = rows.map(r => r[i]).filter(Boolean); return i > 0 && cells.length > 0 && cells.filter(x => NUMERIC.test(x)).length / cells.length >= 0.6; });
    const avail = room(b.heading, { footer: !!b.footer, oneLine: true }) - (b.note ? 3.7 : 0), z = pick([2.7, 2.5, 2.3, 2.1, 1.95, 1.8], s => rows.length * (s * 2.2 + 0.22) + s * 1.66 + 0.45, avail);
    const first = k >= 4 ? 30 : 40, rest = ((100 - first) / (k - 1)).toFixed(2);
    const th = cols.map((c, i) => `<th${numeric[i] ? ' class="a-n"' : ""}>${esc(c)}</th>`).join("");
    const tr = rows.map((r, ri) => `<tr${b.highlight === ri + 1 ? ' class="a-hl"' : ""}>${r.map((v, i) => `<td class="${numeric[i] ? "a-n" : ""}${/^\+/.test(v) && NUMERIC.test(v) ? " a-up" : /^[−–-]\s*\d/.test(v) && NUMERIC.test(v) ? " a-dn" : ""}">${esc(v)}</td>`).join("")}</tr>`).join("");
    return slide(b.accent, `${head(b.heading, { oneLine: true })}${body(`<table class="a-t" style="font-size:${z}cqw"><colgroup>${cols.map((_, i) => `<col style="width:${i ? rest : first}%">`).join("")}</colgroup><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>${b.note ? `<p class="a-nt">${esc(b.note)}</p>` : ""}`)}`, b.footer);
  },
  summary: b => `${b.heading}: ${(b.columns as string[]).join(" | ")}; ${(b.rows as string[][]).map(r => r.join(" | ")).join("; ")}`,
  css: sx("table_slide", `.a-t{width:100%;border-collapse:collapse;table-layout:fixed}
.a-t th{padding:.5em .7em;font-size:.72em;line-height:1.3;font-weight:800;letter-spacing:.05em;text-transform:uppercase;text-align:left;color:var(--muted);border-bottom:2px solid var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.a-t td{padding:.45em .7em;line-height:1.3;font-weight:560;color:var(--ink2);border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.a-t td:first-child{font-weight:760;color:var(--ink)}
.a-t .a-n{text-align:right;font-variant-numeric:tabular-nums}
.a-t .a-up{color:var(--green)}
.a-t .a-dn{color:var(--red)}
.a-t .a-hl td{background:var(--ac2);color:var(--ink);font-weight:800;border-bottom-color:transparent}
.a-t .a-hl td:first-child{border-radius:.8cqw 0 0 .8cqw}
.a-t .a-hl td:last-child{border-radius:0 .8cqw .8cqw 0}
.a-nt{margin:1.2cqw 0 0;font-size:1.7cqw;line-height:1.35;font-weight:560;color:var(--faint)}`),
});

const YES = /^(?:yes|y|true|✓|✔|✅|included|있음|예|o)$/i, NO = /^(?:no|n|false|✗|✕|✘|x|none|—|–|-|없음|아니오|아니요)$/i;
const side = z.preprocess(asObject("name"), z.object({ name: text(22), tag: optionalText(16) }).strip());
const winner = loose(["a", "b", "none"], { left: "a", first: "a", right: "b", second: "b", neither: "none", tie: "none", no: "none" }, "none").optional();
export const comparisonSlide = defineAsset({
  type: "comparison_slide", category: "slide", width: "half", frame: "16:9",
  use: "A slide that sets two options side by side (A vs B) over three to five attributes, with ticks or short values and one highlighted winner column.",
  useKo: "두 대안(A 대 B)을 3~5개 속성으로 나란히 비교하는 슬라이드: 체크·짧은 값, 우세한 열 강조.",
  tags: ["slide", "comparison", "versus", "vs", "compare", "options", "슬라이드", "비교", "대조", "선택지"],
  notes: "a and b are the option names. Each row has a label and a value for each side; 'yes'/'no' draw a tick or a dash. winner is a, b or none (the highlighted column).",
  fields: { heading: text(64), a: side, b: side, winner, rows: list(z.object({ label: text(30), a: cell(24), b: cell(24) }).strip(), 3, 5), footer: optionalText(48), accent },
  sample: { heading: "Build the onboarding squad or buy a tool?", a: { name: "Build in-house", tag: "Option A" }, b: { name: "Buy a platform", tag: "Option B" }, winner: "a", accent: "blue", footer: "Northwind Labs · Q3 review · 10", rows: [{ label: "Fits our product", a: "yes", b: "no" }, { label: "Time to launch", a: "10 weeks", b: "3 weeks" }, { label: "Year-one cost", a: "$180K", b: "$96K" }, { label: "We own the data", a: "yes", b: "yes" }, { label: "Needs new hires", a: "2 engineers", b: "no" }] },
  render(b, { T }) {
    const rows = b.rows as { label: string; a: string; b: string }[], n = rows.length, w = b.winner, avail = room(b.heading, { footer: !!b.footer, oneLine: true });
    // [size, lines a cell may take]: the first step whose tallest row fits (the rows share the height equally).
    const steps = [[2.6, 2], [2.4, 2], [2.2, 2], [2, 2], [2.2, 1], [2, 1]] as const;
    const rowH = (z: number, l: number) => Math.max(...rows.map(r => Math.max(linesOf(r.label, z, 27, l), linesOf(r.a, z, 23, l), linesOf(r.b, z, 23, l)))) * z * 1.25 + 1.2;
    const [z, l] = steps.find(([s2, k]) => 6.4 + n * rowH(s2, k) <= avail) ?? steps[steps.length - 1];
    const one = (v: string) => (YES.test(v) ? `<span class="a-ok">${icon("check", 18, 3)}</span>` : NO.test(v) ? '<span class="a-no">—</span>' : `<span style="${clamp(l)}">${esc(v)}</span>`);
    const hd = (k: "a" | "b") => `<div class="a-hd${w === k ? " a-w" : ""}"><b>${esc(b[k].name)}</b>${w === k ? `<em>${T("Recommended", "추천")}</em>` : b[k].tag ? `<em>${esc(b[k].tag)}</em>` : ""}</div>`;
    const cells = rows.map(r => `<div class="a-lb"><span style="${clamp(l)}">${esc(r.label)}</span></div><div${w === "a" ? ' class="a-w"' : ""}>${one(r.a)}</div><div${w === "b" ? ' class="a-w"' : ""}>${one(r.b)}</div>`).join("");
    return slide(b.accent, `${head(b.heading, { oneLine: true })}${body(`<div class="a-cmp" style="font-size:${z}cqw;grid-template-rows:auto repeat(${n},minmax(0,1fr))"><div></div>${hd("a")}${hd("b")}${cells}</div>`)}`, b.footer);
  },
  summary: b => `${b.heading}: ${b.a.name} vs ${b.b.name}. ${(b.rows as { label: string; a: string; b: string }[]).map(r => `${r.label}: ${r.a} / ${r.b}`).join("; ")}${b.winner && b.winner !== "none" ? `. Recommended: ${b[b.winner as "a" | "b"].name}` : ""}`,
  css: sx("comparison_slide", `.a-cmp{height:100%;display:grid;grid-template-columns:1.15fr 1fr 1fr;max-height:36cqw}
.a-cmp>div{min-width:0;display:flex;align-items:center;justify-content:center;padding:0 1.4cqw;border-bottom:1px solid var(--line);font-weight:640;color:var(--ink2);text-align:center}
.a-cmp>.a-lb{justify-content:flex-start;text-align:left;font-weight:700;color:var(--ink)}
.a-cmp>.a-hd{flex-direction:column;gap:.35em;padding:.6em 1em;border-bottom:2px solid var(--ink);color:var(--ink)}
.a-hd b{max-width:100%;font-size:1.1em;line-height:1.2;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.a-hd em{max-width:100%;font-style:normal;font-size:.68em;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.a-cmp>.a-w{background:var(--ac2)}
.a-cmp>.a-hd.a-w{background:var(--ac);color:#fff;border-bottom-color:var(--ac);border-radius:1.2cqw 1.2cqw 0 0}
.a-hd.a-w em{color:#fff;opacity:.85}
.a-ok{display:inline-flex;width:1.5em;height:1.5em;border-radius:50%;align-items:center;justify-content:center;background:var(--green);color:#fff}
.a-no{color:var(--faint);font-weight:700}`),
});

const plan = z.object({ name: text(18), price: text(12), period: optionalText(16), features: list(text(32), 2, 5), recommended: z.preprocess(flag, z.boolean()).optional() }).strip();
type Plan = { name: string; price: string; period?: string; features: string[]; recommended?: boolean };
export const pricingSlide = defineAsset({
  type: "pricing_slide", category: "slide", width: "half", frame: "16:9",
  use: "A pricing slide: two or three plan columns, each with a price and a short feature list, and one recommended plan highlighted.",
  useKo: "요금 슬라이드: 2~3개 요금제 열, 가격과 짧은 기능 목록, 추천 요금제 하나 강조.",
  tags: ["slide", "pricing", "plans", "tiers", "subscription", "price", "슬라이드", "요금", "요금제", "가격"],
  notes: "Two or three plans; mark one with recommended: true. price is written as shown ('$29', 'Free', '₩49,000'); period is the unit ('per user / month').",
  fields: { heading: text(64), plans: list(plan, 2, 3), footer: optionalText(48), accent },
  sample: { heading: "Three plans, one clear upgrade path", accent: "blue", footer: "Northwind Labs · Q3 review · 9", plans: [{ name: "Starter", price: "Free", period: "for one project", features: ["1 workspace", "Community support", "7-day history"] }, { name: "Team", price: "$24", period: "per user / month", recommended: true, features: ["Unlimited projects", "Shared dashboards", "Priority support", "90-day history"] }, { name: "Scale", price: "$79", period: "per user / month", features: ["Single sign-on", "Audit log", "Dedicated manager", "Custom retention"] }] },
  render(b, { T }) {
    const plans = b.plans as Plan[], n = plans.length, cw = (84 - 2.6 * (n - 1)) / n - 4.4, avail = room(b.heading, { footer: !!b.footer }) - 1.6, rec = plans.findIndex(p => p.recommended);
    // [size, lines a feature may take]: the first step whose longest list fits under the name, the price and the period.
    const steps = [[2.2, 2], [2, 2], [2.1, 1], [1.9, 1], [1.8, 1]] as const;
    const hgt = (z: number, l: number) => Math.max(...plans.map(p => 16.4 + p.features.reduce((h, f, i) => h + Math.min(l, linesOf(f, z, cw - 3.2)) * z * 1.3 + (i ? z * 0.55 : 0), 0)));
    const [z, l] = steps.find(([s2, k]) => hgt(s2, k) <= avail) ?? steps[steps.length - 1];
    const REC = "background:var(--ac);border-color:var(--ac);box-shadow:0 1.4cqw 3cqw rgba(16,29,36,.18);--tx:#fff;--mu:rgba(255,255,255,.82);--ln:rgba(255,255,255,.3);--ck:rgba(255,255,255,.22);--cc:#fff";
    const BADGE = "position:absolute;top:-1.5cqw;left:50%;transform:translateX(-50%);padding:.4cqw 1.5cqw;border-radius:99px;background:#fff;color:var(--ac);border:1px solid var(--ac);font-size:1.5cqw;font-style:normal;font-weight:800;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap";
    const card = (p: Plan, i: number) => `<div class="a-pl"${i === rec ? ` style="${REC}"` : ""}>${i === rec ? `<em style="${BADGE}">${T("Recommended", "추천")}</em>` : ""}<h3 style="${ELL}">${esc(p.name)}</h3><div class="a-pr" style="font-size:${fit(p.price, cw, [[4.8, 1], [4, 1], [3.4, 1], [2.8, 1]])}cqw">${esc(p.price)}</div><div class="a-pd" style="${ELL}">${p.period ? esc(p.period) : ""}</div><ul style="font-size:${z}cqw">${p.features.map(f => `<li><span>${icon("check", 14, 3)}</span><b style="${clamp(l)}">${esc(f)}</b></li>`).join("")}</ul></div>`;
    return slide(b.accent, `${head(b.heading)}${body(`<div class="a-pls" style="grid-template-columns:repeat(${n},1fr)">${plans.map(card).join("")}</div>`, "padding-top:1.6cqw")}`, b.footer);
  },
  summary: b => `${b.heading}: ${(b.plans as Plan[]).map(p => `${p.name} ${p.price}${p.period ? ` ${p.period}` : ""}${p.recommended ? " (recommended)" : ""} — ${p.features.join(", ")}`).join("; ")}`,
  css: sx("pricing_slide", `.a-pls{height:100%;display:grid;gap:2.6cqw}
.a-pl{position:relative;min-width:0;display:flex;flex-direction:column;padding:1.9cqw 2.2cqw;border:1px solid var(--line);border-radius:1.8cqw;background:#fff}
.a-pl>*{flex:none}
.a-pl h3{margin:0;font-size:2.1cqw;line-height:1.2;font-weight:800;color:var(--mu,var(--muted))}
.a-pr{margin-top:.5cqw;font-weight:800;line-height:1.05;letter-spacing:-.03em;white-space:nowrap}
.a-pd{min-height:2.2cqw;margin:.3cqw 0 1.2cqw;font-size:1.7cqw;line-height:1.3;font-weight:600;color:var(--mu,var(--muted))}
.a-pl ul{flex:1 1 0;min-height:0;overflow:hidden;margin:0;padding:1.4cqw 0 0;list-style:none;border-top:1px solid var(--ln,var(--line));display:flex;flex-direction:column;gap:.55em}
.a-pl li{display:grid;grid-template-columns:1.5em 1fr;gap:.2em;align-items:start}
.a-pl li span{width:1.2em;height:1.2em;margin-top:.1em;border-radius:50%;background:var(--ck,var(--ac2));color:var(--cc,var(--ac));display:flex;align-items:center;justify-content:center}
.a-pl li b{font-weight:560;line-height:1.3;color:var(--tx,var(--ink2))}`),
});
export const ASSETS: readonly AnyAsset[] = [bigStatSlide, chartSlide, tableSlide, comparisonSlide, pricingSlide];
