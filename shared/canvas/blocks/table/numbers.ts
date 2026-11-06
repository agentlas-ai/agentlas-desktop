import { z } from "zod";
import { bold, canvasFormat, esc, signed } from "../../kit";
import { figure, list, loose, num, optionalNum, optionalText, text, tone, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { cap, clamp, css, fit, flag, hue, on, type Hue } from "./_shared";

/** Tables of figures: definitions, rankings, budgets and pivots. */

const TONE_HUE: Record<string, Hue> = { up: "g", down: "r", warn: "a", info: "b" };
/** canvasFormat, except that Korean won in the hundred-millions keep their decimals (1.2억원, not 1억원): a plan and an actual must not read the same when they differ. */
const money = (v: number, u: string, ko: boolean) => (u === "text" ? String(v) : u === "krw" && ko && Math.abs(v) >= 1e8 && Math.abs(v) < 1e12 ? `${v < 0 ? "−" : ""}${+(Math.abs(v) / 1e8).toFixed(2)}억원` : canvasFormat(v, u, ko));

// ---- definition_table -------------------------------------------------------------------------------------------------------------------
const pair = z.object({ key: text(30), value: text(90), tone: tone.optional() }).strip();
const section = z.object({ heading: optionalText(40), items: list(pair, 1, 10) }).strip();
const cols = z.preprocess(v => (Number(v) === 1 ? 1 : 2), z.union([z.literal(1), z.literal(2)]));

export const definitionTable = defineAsset({
  type: "definition_table", category: "table", width: "two_thirds",
  use: "Key and value pairs in one or two columns, with muted keys, strong values and optional section headings, for a brief, a spec or a profile.",
  useKo: "키-값 쌍을 한두 열로, 흐린 키와 굵은 값, 선택적 섹션 제목과 함께 보여줍니다(개요·사양·프로필).",
  tags: ["definition", "key value", "details", "spec", "profile", "summary", "properties", "facts", "상세", "사양", "정보", "개요", "속성"],
  notes: "sections hold the pairs; a section with no heading is drawn without one. columns is 1 or 2 (default 2). tone (up, down, warn, info) colours a value. **bold** marks part of a value.",
  fields: { sections: list(section, 1, 4), columns: cols, caption: optionalText(140) },
  sample: {
    title: "Project brief: website relaunch",
    columns: 2,
    sections: [
      { heading: "Overview", items: [{ key: "Owner", value: "Dana Kim, Head of Product" }, { key: "Sponsor", value: "VP Marketing" }, { key: "Status", value: "On track", tone: "up" }, { key: "Start date", value: "Sep 14, 2026" }, { key: "Target launch", value: "**Nov 20, 2026**" }, { key: "Budget", value: "$240,000" }] },
      { heading: "Delivery", items: [{ key: "Team size", value: "9 people across 3 teams" }, { key: "Method", value: "Two-week sprints" }, { key: "Open risks", value: "3, one needs a decision", tone: "warn" }, { key: "Next milestone", value: "Design sign-off, Oct 30" }] },
    ],
  },
  render(b) {
    const body = b.sections.map(s => `${s.heading ? `<div class="a-sh">${esc(s.heading)}</div>` : ""}<dl class="a-dl" style="--n:${b.columns}">${s.items.map(i => `<div class="a-pr"${i.tone && TONE_HUE[i.tone] ? ` ${hue(TONE_HUE[i.tone])}` : ""}><dt>${esc(i.key)}</dt><dd${i.tone && TONE_HUE[i.tone] ? ' class="a-t"' : ""}>${bold(i.value)}</dd></div>`).join("")}</dl>`).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${body}${cap(b.caption)}`;
  },
  summary: b => fit(`${b.title ?? "Details"}: ${b.sections.flatMap(s => s.items).slice(0, 10).map(i => `${i.key} ${i.value.replace(/\*\*/g, "")}`).join("; ")}.`),
  css: css("definition_table", `
    & .a-sh{margin:20px 0 4px;font-size:11px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;color:#7a8682}
    & .sec+.a-sh{margin-top:0}
    & .a-dl{margin:0;columns:var(--n);column-gap:48px}
    & .a-pr{display:grid;grid-template-columns:minmax(84px,40%) minmax(0,1fr);gap:12px;padding:11px 0;border-bottom:1px solid #f2f3f1;break-inside:avoid}
    & dt{font-size:13px;font-weight:600;color:var(--muted)}
    & dd{margin:0;font-size:14.5px;font-weight:700;color:var(--ink)}
    & dd b{font-weight:800}
    & .a-t{color:rgb(var(--c))}
    @container (max-width:560px){& .a-dl{columns:1}& .a-pr{grid-template-columns:minmax(76px,36%) minmax(0,1fr)}}
  `),
});

// ---- ranking_table ----------------------------------------------------------------------------------------------------------------------
const entry = z.object({ name: text(36), value: num, change: optionalNum, note: optionalText(40) }).strip();
const MEDAL = ["background:linear-gradient(135deg,#f7cd5f,#dfa11f);color:#5b3d00", "background:linear-gradient(135deg,#e3e8e5,#aeb8b4);color:#33414a", "background:linear-gradient(135deg,#f5bb88,#d98440);color:#5a2f0a"];
const ARROW = { up: '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1l4.2 7H.8z" fill="currentColor"/></svg>', down: '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 9L.8 2h8.4z" fill="currentColor"/></svg>' };

export const rankingTable = defineAsset({
  type: "ranking_table", category: "table", width: "two_thirds",
  use: "A ranked list: rank number, name, a value with an inline bar and a change arrow against the last period, with the top three emphasised.",
  useKo: "순위표: 순위, 이름, 막대가 붙은 값, 직전 기간 대비 증감 화살표를 보이고 상위 3위를 강조합니다.",
  tags: ["ranking", "leaderboard", "top", "rank", "league table", "top 10", "순위", "랭킹", "상위", "리더보드", "순위표"],
  notes: "Rows are drawn in the order given (rank 1 first). value uses unit; change is the percent change against the last period (positive = up). note is a short line under the name.",
  fields: { items: list(entry, 2, 12), unit: unit.default("count"), valueLabel: optionalText(20), changeLabel: optionalText(20), caption: optionalText(140) },
  sample: {
    title: "Top markets by revenue, Q3 2026",
    unit: "usd", valueLabel: "Revenue", changeLabel: "vs Q2",
    items: [
      { name: "United States", value: 4820000, change: 12.4, note: "Enterprise-led growth" },
      { name: "Germany", value: 2310000, change: 8.1 },
      { name: "Japan", value: 1940000, change: -3.2, note: "Currency headwind" },
      { name: "United Kingdom", value: 1620000, change: 5.7 },
      { name: "Brazil", value: 1180000, change: 21.3, note: "Fastest growing" },
      { name: "Canada", value: 1040000, change: 2.4 },
      { name: "South Korea", value: 1020000, change: 9.9 },
      { name: "France", value: 1010000, change: -6.5 },
    ],
  },
  render(b, { ko, T }) {
    const max = Math.max(1e-9, ...b.items.map(i => i.value)), hasC = b.items.some(i => typeof i.change === "number");
    const rows = b.items.map((it, i) => {
      const top = i < 3, c = it.change;
      const change = typeof c === "number" ? (Math.abs(c) < 0.05 ? `<span class="a-ch">–</span>` : `<span class="a-ch" ${hue(c > 0 ? "g" : "r")}>${c > 0 ? ARROW.up : ARROW.down}${Math.abs(c).toFixed(Math.abs(c) < 10 ? 1 : 0)}%</span>`) : `<span class="a-ch"></span>`;
      return `<div class="a-rw${top ? " a-top" : ""}"><span class="a-rk"${top ? ` style="${MEDAL[i]}"` : ""}>${i + 1}</span><span class="a-nm">${esc(it.name)}${it.note ? `<small>${esc(it.note)}</small>` : ""}</span><span class="a-bt"><i style="width:${clamp((Math.max(0, it.value) / max) * 100, it.value > 0 ? 1.5 : 0, 100).toFixed(1)}%"></i></span><b class="a-vl">${esc(money(it.value, b.unit, ko))}</b>${hasC ? change : ""}</div>`;
    }).join("");
    const head = `<div class="a-rw a-rh"><span>#</span><span>${T("Name", "이름")}</span><span></span><span class="a-vl">${esc(b.valueLabel ?? T("Value", "값"))}</span>${hasC ? `<span class="a-ch">${esc(b.changeLabel ?? T("Change", "증감"))}</span>` : ""}</div>`;
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-tb" style="--k:34px minmax(0,1.3fr) minmax(0,1.5fr) 84px${hasC ? " 72px" : ""}">${head}${rows}</div>${cap(b.caption)}`;
  },
  summary: b => fit(`${b.title ?? "Ranking"}: ${b.items.slice(0, 8).map((i, k) => `${k + 1}. ${i.name} ${b.unit === "text" ? i.value : canvasFormat(i.value, b.unit, false)}${typeof i.change === "number" ? ` (${signed(i.change, 1)})` : ""}`).join("; ")}.`),
  css: css("ranking_table", `
    & .a-rw{display:grid;grid-template-columns:var(--k);gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid #f2f3f1;font-size:13.5px;font-weight:600;color:#34424a}
    & .a-rh{padding:0 0 9px;border-color:#eceeec}
    & .a-rh span{font-size:12px;font-weight:700;color:#7a8682}
    & .a-rk{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;font-size:12.5px;font-weight:800;color:var(--faint)}
    & .a-nm{min-width:0;font-size:14.5px;font-weight:650;color:var(--ink)}
    & .a-top .a-nm{font-weight:750}
    & .a-nm small{display:block;margin-top:1px;font-size:12px;font-weight:550;color:var(--muted)}
    & .a-bt{height:8px;border-radius:4px;background:#eef0ee;overflow:hidden}
    & .a-bt i{display:block;height:100%;border-radius:4px;background:var(--blue2)}
    & .a-top .a-bt i{background:var(--blue)}
    & .a-vl{text-align:right;font-size:14.5px;font-weight:750;color:var(--ink)}
    & .a-ch{display:inline-flex;align-items:center;justify-content:flex-end;gap:4px;font-size:12.5px;font-weight:700;color:rgb(var(--c,122,134,130))}
    @container (max-width:560px){& .a-rh{display:none}& .a-rw{grid-template-columns:34px minmax(0,1fr) auto auto;grid-template-areas:"r n v c" "r b b b";row-gap:6px}& .a-rk{grid-area:r}& .a-nm{grid-area:n}& .a-bt{grid-area:b}& .a-vl{grid-area:v}& .a-ch{grid-area:c}}
  `),
});

// ---- budget_table -----------------------------------------------------------------------------------------------------------------------
const line = z.object({ label: text(40), planned: num, actual: num, group: optionalText(28) }).strip();
const basis = loose(["expense", "revenue"], { cost: "expense", costs: "expense", spend: "expense", spending: "expense", budget: "expense", income: "revenue", sales: "revenue", target: "revenue", earnings: "revenue" }, "expense").optional();

export const budgetTable = defineAsset({
  type: "budget_table", category: "table", width: "full",
  use: "Planned against actual per category with the variance (coloured by sign, with a thin variance bar), subtotals per group and a total row.",
  useKo: "범주별 계획 대비 실적과 차이(부호별 색, 얇은 차이 막대), 그룹 소계와 합계 행을 보여줍니다.",
  tags: ["budget", "variance", "planned", "actual", "forecast", "spend", "expenses", "p&l", "예산", "실적", "차이", "집행", "소계", "계획"],
  notes: "unit sets the currency (usd, krw, eur ...). basis is expense (over plan is red, the default) or revenue (over plan is green). Rows with the same consecutive group get a heading and a subtotal; the total is computed from the rows.",
  fields: { rows: list(line, 1, 12), unit: unit.default("usd"), basis, total: on, caption: optionalText(140) },
  sample: {
    title: "Marketing budget, Q3 2026",
    unit: "usd", basis: "expense",
    rows: [
      { label: "Search ads", planned: 48000, actual: 52400, group: "Paid media" },
      { label: "Social ads", planned: 36000, actual: 33100, group: "Paid media" },
      { label: "Display and video", planned: 18000, actual: 19900, group: "Paid media" },
      { label: "Agency retainer", planned: 30000, actual: 30000, group: "Content" },
      { label: "Video production", planned: 22000, actual: 27500, group: "Content" },
      { label: "Freelance writers", planned: 9000, actual: 7200, group: "Content" },
      { label: "Events and sponsorships", planned: 25000, actual: 18600 },
      { label: "Tools and software", planned: 6500, actual: 6900 },
    ],
    caption: "Paid media and video overran; events came in under plan and offset about half of it.",
  },
  render(b, { ko, T }) {
    const revenue = b.basis === "revenue";
    const pctOf = (p: number, a: number) => (p !== 0 ? ((a - p) / Math.abs(p)) * 100 : null);
    const all = b.rows.map(r => pctOf(r.planned, r.actual)).filter((x): x is number => x !== null);
    const sum = (rs: typeof b.rows) => ({ p: rs.reduce((s, r) => s + r.planned, 0), a: rs.reduce((s, r) => s + r.actual, 0) });
    const top = Math.max(5, ...all.map(Math.abs));
    const fig = (v: number) => esc(money(v, b.unit, ko));
    const variance = (p: number, a: number) => {
      const d = a - p, pc = pctOf(p, a), h: Hue = Math.abs(d) < 1e-9 ? "n" : (d > 0) === revenue ? "g" : "r";
      const w = pc === null ? 0 : clamp((Math.abs(pc) / top) * 50, Math.abs(d) < 1e-9 ? 0 : 1, 50);
      return `<td class="a-vr" ${hue(h)}><div class="a-vt"><span>${d === 0 ? T("On plan", "계획 일치") : `${d > 0 ? "+" : "−"}${fig(Math.abs(d))}`}</span>${pc === null || d === 0 ? "" : `<em>${esc(signed(pc, Math.abs(pc) < 10 ? 1 : 0))}</em>`}</div><span class="a-vb"><i style="${d >= 0 ? "left" : "right"}:50%;width:${w.toFixed(1)}%"></i></span></td>`;
    };
    const money4 = (label: string, p: number, a: number, cls: string) => `<tr class="${cls}"><td class="a-lb">${label}</td><td class="a-n">${fig(p)}</td><td class="a-n">${fig(a)}</td>${variance(p, a)}</tr>`;
    let body = "", i = 0;
    while (i < b.rows.length) {
      const g = b.rows[i].group;
      let j = i; while (j < b.rows.length && b.rows[j].group === g) j++;
      const run = b.rows.slice(i, j);
      if (g) body += `<tr><td class="a-gh" colspan="4">${esc(g)}</td></tr>`;
      body += run.map(r => money4(esc(r.label), r.planned, r.actual, "")).join("");
      if (g && run.length > 1) { const s = sum(run); body += money4(`${T("Subtotal", "소계")}`, s.p, s.a, "a-sub"); }
      i = j;
    }
    if (b.total) { const s = sum(b.rows); body += money4(T("Total", "합계"), s.p, s.a, "a-tot"); }
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-tw"><table><thead><tr><th>${T("Category", "항목")}</th><th class="a-n">${T("Planned", "계획")}</th><th class="a-n">${T("Actual", "실적")}</th><th class="a-n">${T("Variance", "차이")}</th></tr></thead><tbody>${body}</tbody></table></div>${cap(b.caption)}`;
  },
  summary(b) {
    const p = b.rows.reduce((s, r) => s + r.planned, 0), a = b.rows.reduce((s, r) => s + r.actual, 0), d = a - p;
    return fit(`${b.title ?? "Budget"}: planned ${money(p, b.unit, false)}, actual ${money(a, b.unit, false)}, variance ${d >= 0 ? "+" : "−"}${money(Math.abs(d), b.unit, false)}${p ? ` (${signed((d / Math.abs(p)) * 100, 1)})` : ""}. ${b.rows.slice(0, 5).map(r => `${r.label} ${money(r.actual, b.unit, false)} of ${money(r.planned, b.unit, false)}`).join("; ")}.`);
  },
  css: css("budget_table", `
    & .a-tw{overflow-x:auto}
    & table{border-collapse:separate;border-spacing:0;min-width:440px}
    & th.a-n,& td.a-n{text-align:right;white-space:nowrap}
    & th{padding:0 12px 10px 0}
    & td{padding:10px 12px 10px 0;font-size:13.5px}
    & .a-lb{font-weight:650;color:var(--ink)}
    & .a-gh{padding:18px 0 6px;font-size:11px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;color:#7a8682}
    & .a-vr{width:34%;min-width:150px}
    & .a-vt{display:flex;justify-content:space-between;gap:10px;font-size:13px;font-weight:750;color:rgb(var(--c))}
    & .a-vt em{font-style:normal;font-weight:650;opacity:.8}
    & .a-vb{position:relative;display:block;height:5px;margin-top:6px;border-radius:3px;background:#eef0ee}
    & .a-vb::before{content:"";position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:#c9d0cc}
    & .a-vb i{position:absolute;top:0;bottom:0;border-radius:3px;background:rgb(var(--c))}
    & .a-sub td{background:var(--surface);font-weight:700}
    & .a-tot td{padding:13px 12px 13px 0;border-top:2px solid var(--ink);border-bottom:0;font-size:14.5px;font-weight:800}
    & .a-sub td:first-child{padding-left:12px;border-radius:10px 0 0 10px}
    & .a-sub td:last-child{border-radius:0 10px 10px 0}
    @container (max-width:560px){& table{min-width:0}& td{font-size:12.5px;padding-right:6px}& th{padding-right:6px}& .a-vr{width:auto;min-width:76px}& .a-vt{flex-direction:column;gap:0;font-size:12px;white-space:nowrap}}
  `),
});

// ---- pivot_table ------------------------------------------------------------------------------------------------------------------------
const cellNum = z.preprocess(v => (v === null || v === undefined || v === "" ? null : figure(v)), z.number().finite().nullable());
const pivotRow = z.object({ label: text(28), values: list(cellNum, 1, 6) }).strip();

export const pivotTable = defineAsset({
  type: "pivot_table", category: "table", width: "full",
  use: "A cross-tab: row headers, column headers, numbers in the body with row and column totals, and optional heat tinting of the cells.",
  useKo: "교차표: 행·열 머리글, 본문 숫자, 행·열 합계와 선택적 히트 색조를 보여줍니다.",
  tags: ["pivot", "cross tab", "crosstab", "matrix of numbers", "totals", "heat", "summary table", "피벗", "교차표", "집계", "합계", "히트맵"],
  notes: "One value per column in each row (null for a gap). Totals are computed (turn off with totals: false). heat: true tints each cell by its size. unit formats every number (count by default).",
  fields: { corner: optionalText(24), columns: list(text(16), 1, 6), rows: list(pivotRow, 1, 12), unit: unit.default("count"), totals: on, heat: flag, caption: optionalText(140) },
  sample: {
    title: "Support tickets by category and priority, September",
    corner: "Category", unit: "count", totals: true, heat: true,
    columns: ["Low", "Medium", "High", "Urgent"],
    rows: [
      { label: "Billing", values: [84, 132, 41, 9] },
      { label: "Sign-in and access", values: [57, 96, 63, 22] },
      { label: "Performance", values: [18, 44, 71, 35] },
      { label: "Integrations", values: [33, 67, 38, 12] },
      { label: "Data export", values: [29, 41, 16, 4] },
      { label: "Other", values: [102, 58, 14, 2] },
    ],
    caption: "Performance carries the most urgent load; billing is high volume but mostly low priority.",
  },
  render(b, { ko, T }) {
    const n = b.columns.length, m = b.rows.map(r => Array.from({ length: n }, (_, c) => r.values[c] ?? null));
    const flat = m.flat().filter((v): v is number => v !== null), lo = Math.min(...flat), hi = Math.max(...flat);
    const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0), colTotals = b.columns.map((_, c) => sum(m.map(r => r[c])));
    const fig = (v: number | null) => (v === null ? "–" : esc(money(v, b.unit, ko)));
    const tint = (v: number | null) => (b.heat && v !== null && hi > lo ? ` style="background:rgba(47,95,214,${(0.05 + 0.4 * ((v - lo) / (hi - lo))).toFixed(2)})"` : "");
    const head = `<tr><th scope="col">${b.corner ? esc(b.corner) : ""}</th>${b.columns.map(c => `<th scope="col">${esc(c)}</th>`).join("")}${b.totals ? `<th scope="col" class="a-tt">${T("Total", "합계")}</th>` : ""}</tr>`;
    const rows = b.rows.map((r, i) => `<tr><th scope="row">${esc(r.label)}</th>${m[i].map(v => `<td${tint(v)}>${fig(v)}</td>`).join("")}${b.totals ? `<td class="a-tt">${fig(sum(m[i]))}</td>` : ""}</tr>`).join("");
    const foot = b.totals ? `<tr class="a-tr"><th scope="row">${T("Total", "합계")}</th>${colTotals.map(v => `<td>${fig(v)}</td>`).join("")}<td class="a-tt">${fig(sum(colTotals))}</td></tr>` : "";
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-tw"><table style="--w:${130 + (n + (b.totals ? 1 : 0)) * 80}px"><thead>${head}</thead><tbody>${rows}${foot}</tbody></table></div>${cap(b.caption)}`;
  },
  summary(b) {
    const n = b.columns.length, tot = b.rows.reduce((s, r) => s + r.values.slice(0, n).reduce<number>((x, v) => x + (v ?? 0), 0), 0);
    return fit(`${b.title ?? "Pivot"}: ${b.rows.length} rows by ${b.columns.join(", ")}; grand total ${money(tot, b.unit, false)}. ${b.rows.slice(0, 5).map(r => `${r.label} ${money(r.values.slice(0, n).reduce<number>((x, v) => x + (v ?? 0), 0), b.unit, false)}`).join("; ")}.`);
  },
  css: css("pivot_table", `
    & .a-tw{overflow-x:auto}
    & table{border-collapse:separate;border-spacing:0;min-width:var(--w)}
    & th,& td{padding:10px 12px;text-align:right;white-space:nowrap;border-bottom:1px solid #f0f1ef}
    & th:first-child{position:sticky;left:0;z-index:1;padding-left:0;background:#fff;text-align:left;font-size:13.5px;font-weight:650;color:var(--ink)}
    & thead th{border-bottom-color:#e1e5e2;font-size:12.5px;color:#34424a}
    & td{font-size:13.5px;font-weight:600}
    & .a-tt{background:var(--surface);font-weight:800;color:var(--ink)}
    & .a-tr>*{border-top:2px solid var(--ink);border-bottom:0;background:var(--surface);font-weight:800}
    & .a-tr th{padding-left:12px;background:var(--surface)}
    @container (max-width:560px){& table{min-width:0}& th,& td{padding:9px 6px}& th:first-child{width:84px;font-size:12.5px;white-space:normal}}
  `),
});

export const ASSETS: readonly AnyAsset[] = [definitionTable, rankingTable, budgetTable, pivotTable];
