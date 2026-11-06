import { z } from "zod";
import { esc } from "../../kit";
import { figure, list, loose, num, optionalNum, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { CHIP, ball, cap, cells, chip, clamp, css, fit, flag, hue, markOf, mark, on, pct, type Hue } from "./_shared";

/** Tables that weigh options against each other: features across options, plans side by side, weighted criteria, and symbol matrices. */

// ---- comparison_table -------------------------------------------------------------------------------------------------------------------
const option = z.object({ name: text(22), note: optionalText(26), recommended: flag }).strip();
const featureRow = z.object({ group: optionalText(28), feature: optionalText(44), values: cells(26, 5) }).strip().refine(r => Boolean(r.group || r.feature), "a row needs a feature or a group");

export const comparisonTable = defineAsset({
  type: "comparison_table", category: "table", width: "full",
  use: "Features (rows) compared across two to five options (columns) with ticks, crosses, partial marks or short text, one column highlighted as the recommendation.",
  useKo: "두~다섯 가지 선택지(열)를 기능(행)별로 체크·엑스·부분·짧은 글로 비교하고 추천 열을 강조합니다.",
  tags: ["comparison", "compare", "versus", "vs", "features", "options", "recommended", "비교", "비교표", "기능 비교", "선택지", "추천"],
  notes: "Cells: yes / no / partial (or true / false), a dash for nothing, or text up to 26 characters. A row with only `group` is a section header. Flag one option `recommended` to highlight its column.",
  fields: { options: list(option, 2, 5), rows: list(featureRow, 1, 16), caption: optionalText(140) },
  sample: {
    title: "Build, buy or blend: the four options side by side",
    options: [{ name: "Build in-house", note: "12–16 weeks" }, { name: "Buy a SaaS tool", note: "2–3 weeks" }, { name: "Hybrid", note: "6–8 weeks", recommended: true }, { name: "Outsource", note: "8–10 weeks" }],
    rows: [
      { group: "Cost" },
      { feature: "Year-one cost", values: ["$310K", "$96K", "$158K", "$220K"] },
      { feature: "Predictable pricing", values: ["no", "yes", "yes", "partial"] },
      { group: "Fit" },
      { feature: "Matches our workflow", values: ["yes", "partial", "yes", "partial"] },
      { feature: "We own the roadmap", values: ["yes", "no", "partial", "no"] },
      { feature: "Connects to our CRM", values: ["yes", "yes", "yes", "partial"] },
      { group: "Risk" },
      { feature: "Avoids vendor lock-in", values: ["yes", "no", "partial", "no"] },
      { feature: "Live within a quarter", values: ["no", "yes", "yes", "partial"] },
    ],
    caption: "Hybrid gives the best fit and the lowest risk without the full cost of building.",
  },
  render(b, { ko, T }) {
    const hl = b.options.map(o => o.recommended), last = b.rows.length - 1;
    const body = (raw: string) => { const k = markOf(raw); return k === "text" ? esc(raw) : mark(k, raw || T("None", "없음")); };
    const head = `<tr><th class="a-f"></th>${b.options.map((o, k) => `<th scope="col" class="a-oh${hl[k] ? " a-hl" : ""}">${hl[k] ? `<em class="a-rc">${T("Recommended", "추천")}</em>` : ""}<b>${esc(o.name)}</b>${o.note ? `<span>${esc(o.note)}</span>` : ""}</th>`).join("")}</tr>`;
    const rows = b.rows.map((r, i) => {
      const end = i === last ? " a-end" : "";
      if (r.group) {
        // The label runs over the leading plain columns; a highlighted column keeps its tint through the group row.
        const segs = [{ span: 1, hl: false, label: true }];
        b.options.forEach((_, k) => { const tail = segs[segs.length - 1]; if (!hl[k] && !tail.hl) tail.span++; else segs.push({ span: 1, hl: hl[k], label: false }); });
        return `<tr>${segs.map(s => (s.label ? `<th scope="colgroup" colspan="${s.span}" class="a-gh${end}">${esc(r.group)}</th>` : `<td colspan="${s.span}" class="${s.hl ? "a-hl" : ""}${end}"></td>`)).join("")}</tr>`;
      }
      return `<tr><th scope="row" class="a-f${end}">${esc(r.feature)}</th>${b.options.map((_, k) => `<td class="a-v${hl[k] ? " a-hl" : ""}${end}">${body(r.values[k] ?? "")}</td>`).join("")}</tr>`;
    }).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-tw"><table style="--w:${150 + b.options.length * 104}px"><thead>${head}</thead><tbody>${rows}</tbody></table></div>${cap(b.caption)}`;
  },
  summary(b) {
    const rec = b.options.filter(o => o.recommended).map(o => o.name);
    const rows = b.rows.filter(r => r.feature).slice(0, 4).map(r => `${r.feature}: ${b.options.map((_, k) => r.values[k] || "–").join(" / ")}`);
    return fit(`${b.title ?? "Comparison"}: ${b.options.map(o => o.name).join(" vs ")}${rec.length ? `. Recommended: ${rec.join(", ")}` : ""}. ${rows.join("; ")}.`);
  },
  css: css("comparison_table", `
    & .a-tw{overflow-x:auto}
    & table{border-collapse:separate;border-spacing:0;min-width:var(--w)}
    & th,& td{padding:11px 10px;text-align:center;white-space:normal;border-bottom:1px solid #f0f1ef}
    & .a-f{position:sticky;left:0;background:#fff;text-align:left;padding-left:0;font-size:13.5px;font-weight:650;color:#34424a}
    & thead th{vertical-align:bottom;color:var(--ink);border-bottom-color:#e1e5e2}
    & .a-oh b{display:block;font-size:14.5px;font-weight:750}
    & .a-oh span{font-size:12px;font-weight:600;opacity:.6}
    & .a-rc{display:block;margin-bottom:4px;font-style:normal;font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.8}
    & .a-gh{max-width:0;padding:18px 0 8px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
    & .a-hl{background:#f3f6fe;border-bottom-color:#e4ebfb}
    & thead .a-hl{background:var(--blue);color:#fff;border-radius:12px 12px 0 0}
    & .a-end{border-bottom:0;border-radius:0 0 12px 12px}
    @container (max-width:560px){& table{min-width:0}& th,& td{min-width:74px;padding:9px 6px}& .a-f{width:104px;min-width:104px;font-size:12.5px}& .a-rc{font-size:9px;letter-spacing:0;white-space:nowrap}}
  `),
});

// ---- pricing_table ----------------------------------------------------------------------------------------------------------------------
const feature = z.preprocess(v => (typeof v === "string" || typeof v === "number" ? { text: String(v) } : v), z.object({ text: text(54), included: on }).strip());
const plan = z.object({ name: text(22), price: text(14), period: optionalText(16), blurb: optionalText(70), features: list(feature, 1, 8), popular: flag, cta: optionalText(24) }).strip();

export const pricingTable = defineAsset({
  type: "pricing_table", category: "table", width: "full",
  use: "Two to four plans side by side: name, price and period, feature lines with ticks, one plan marked popular, and a button-looking label.",
  useKo: "두~네 개 요금제를 나란히: 이름, 가격과 주기, 체크 기능 목록, 인기 요금제 강조, 버튼 모양 라벨.",
  tags: ["pricing", "plans", "tiers", "subscription", "price", "popular", "요금제", "가격표", "구독", "플랜"],
  notes: "price is text written as shown (\"$19\", \"Free\", \"Custom\"). A feature is a string, or { text, included: false } for a line the plan lacks. The button is a label, not a link.",
  fields: { plans: list(plan, 2, 4), note: optionalText(140) },
  sample: {
    title: "Plans for every team size",
    plans: [
      { name: "Starter", price: "Free", period: "forever", blurb: "For trying things out on your own.", cta: "Start free", features: ["1 workspace, 3 projects", "Basic reports", "Community support", { text: "Single sign-on", included: false }] },
      { name: "Team", price: "$19", period: "per seat / month", blurb: "For teams shipping every week.", cta: "Start 14-day trial", popular: true, features: ["Unlimited projects", "Advanced reports and exports", "Priority email support", "Integrations with 40+ tools", "Single sign-on"] },
      { name: "Business", price: "$49", period: "per seat / month", blurb: "For companies with security needs.", cta: "Talk to sales", features: ["Everything in Team", "Audit log and data residency", "Role-based access control", "Dedicated success manager", "99.9% uptime SLA"] },
    ],
    note: "Annual billing saves 20%. Prices exclude tax.",
  },
  render(b, { T }) {
    const blurbs = b.plans.some(p => p.blurb), rows = blurbs ? 5 : 4;
    const plans = b.plans.map(p => `<div class="a-pl${p.popular ? " a-pop" : ""}">${p.popular ? `<span class="a-tg">${T("Most popular", "가장 인기")}</span>` : ""}<div class="a-pn">${esc(p.name)}</div>${blurbs ? `<div class="a-pb">${p.blurb ? esc(p.blurb) : ""}</div>` : ""}<div class="a-pr"><b>${esc(p.price)}</b>${p.period ? `<span>${esc(p.period)}</span>` : ""}</div><span class="a-bt">${esc(p.cta ?? T("Get started", "시작하기"))}</span><div class="a-fl">${p.features.map(f => `<div class="a-fi"${f.included ? "" : ' style="color:var(--faint)"'}>${mark(f.included ? "yes" : "no", f.included ? T("Included", "포함") : T("Not included", "미포함"))}<span>${esc(f.text)}</span></div>`).join("")}</div></div>`).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-pg a-n${b.plans.length}" style="--n:${b.plans.length};--r:${rows}">${plans}</div>${cap(b.note)}`;
  },
  summary: b => fit(`${b.title ?? "Pricing"}: ${b.plans.map(p => `${p.name} ${p.price}${p.period ? ` ${p.period}` : ""}${p.popular ? " (most popular)" : ""}, ${p.features.filter(f => f.included).length} features`).join("; ")}.`),
  css: css("pricing_table", `
    & .a-pg{display:grid;grid-template-columns:repeat(var(--c,var(--n)),minmax(0,1fr));gap:16px}
    & .a-pl{position:relative;grid-row:span var(--r);display:grid;grid-template-rows:subgrid;row-gap:12px;padding:22px 20px;border:1px solid var(--line);border-radius:16px;font-size:15px;font-weight:750}
    & .a-pop{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue),0 14px 30px rgba(47,95,214,.16);background:#f8faff}
    & .a-tg{position:absolute;top:-11px;left:20px;padding:0 10px;border-radius:11px;background:var(--blue);color:#fff;font-size:11.5px;line-height:22px;font-weight:800}
    & .a-pb{font-size:12.5px;font-weight:550;color:var(--muted)}
    & .a-pr{font-size:13px;color:var(--muted)}
    & .a-pr b{margin-right:6px;font-size:32px;line-height:1.1;font-weight:800;color:var(--ink)}
    & .a-bt{display:grid;place-items:center;height:38px;border-radius:10px;background:#eef0ee;font-size:13.5px;font-weight:700}
    & .a-pop .a-bt{background:var(--blue);color:#fff}
    & .a-fl{display:grid;align-content:start;gap:9px;padding-top:14px;border-top:1px solid var(--line);font-size:13px;font-weight:600;color:#34424a}
    & .a-fi{display:grid;grid-template-columns:18px 1fr;gap:9px}
    @container (max-width:760px){& .a-n4{--c:2}}
    @container (max-width:560px){& .a-pg{--c:1}}
  `),
});

// ---- scorecard_table --------------------------------------------------------------------------------------------------------------------
const criterion = z.object({ name: text(40), weight: optionalNum, score: num, note: optionalText(70) }).strip();
const scale = z.preprocess(v => (v === null || v === undefined || v === "" ? 5 : figure(v)), z.number().finite().min(1).max(1000));

export const scorecardTable = defineAsset({
  type: "scorecard_table", category: "table", width: "two_thirds",
  use: "Criteria with a weight and a score (1-5 as dots or 0-100 as bars), a weighted total row and a rating chip, for evaluations and vendor or candidate scoring.",
  useKo: "기준별 가중치와 점수(1-5 점 또는 0-100 막대), 가중 합계와 등급 칩으로 평가·업체·후보 채점을 보여줍니다.",
  tags: ["scorecard", "score", "rating", "weighted", "criteria", "evaluation", "rubric", "점수표", "평가", "가중치", "채점", "기준"],
  notes: "max is the top score (5 by default; above 10 the scores are drawn as bars). Weights are relative numbers (30, 20 ...) and are normalised; leave them out for equal weights. The total and the rating are computed.",
  fields: { criteria: list(criterion, 1, 12), max: scale, display: loose(["auto", "dots", "bars"], { dot: "dots", circles: "dots", bar: "bars" }, "auto").optional(), rating: optionalText(20), caption: optionalText(140) },
  sample: {
    title: "Vendor evaluation: Northwind Analytics",
    max: 5,
    criteria: [
      { name: "Functionality", weight: 30, score: 4.5, note: "Covers all must-have reports" },
      { name: "Integration", weight: 20, score: 4 },
      { name: "Security and compliance", weight: 20, score: 3.5, note: "SOC 2 Type II; no regional hosting yet" },
      { name: "Support and onboarding", weight: 15, score: 4 },
      { name: "Total cost", weight: 15, score: 3 },
    ],
    caption: "Strong product fit; negotiate on price and ask for a data-residency date.",
  },
  render(b, { T }) {
    const max = b.max, dots = b.display === "dots" || (b.display !== "bars" && max <= 10), hasW = b.criteria.some(c => (c.weight ?? 0) > 0);
    const sw = hasW ? b.criteria.reduce((s, c) => s + Math.max(0, c.weight ?? 0), 0) : b.criteria.length;
    const wn = (c: (typeof b.criteria)[number]) => (hasW ? Math.max(0, c.weight ?? 0) / sw : 1 / b.criteria.length);
    const ratio = b.criteria.reduce((s, c) => s + wn(c) * (clamp(c.score, 0, max) / max), 0);
    const shown = (v: number) => (max > 10 ? String(Math.round(v)) : Number.isInteger(v) ? String(v) : v.toFixed(1));
    const visual = (v: number, strong = false) => {
      const f = clamp(v, 0, max) / max;
      const bar = dots ? `<span class="a-ds">${Array.from({ length: Math.max(1, Math.round(max)) }, (_, i) => `<i style="--p:${(clamp(f * Math.round(max) - i, 0, 1) * 100).toFixed(0)}%"></i>`).join("")}</span>` : `<span class="a-br" style="--p:${(f * 100).toFixed(1)}%"></span>`;
      return `<div class="a-sv">${bar}<b${strong ? ' style="font-size:17px;font-weight:800"' : ""}>${shown(v)}</b></div>`;
    };
    const level: [string, string, Hue] = ratio >= 0.85 ? ["Excellent", "매우 우수", "g"] : ratio >= 0.7 ? ["Good", "우수", "g"] : ratio >= 0.5 ? ["Fair", "보통", "a"] : ["Weak", "미흡", "r"];
    const rows = b.criteria.map(c => `<tr><td class="a-nm"><b>${esc(c.name)}</b>${c.note ? esc(c.note) : ""}</td>${hasW ? `<td class="a-wt">${pct(wn(c) * 100)}</td>` : ""}<td class="a-sc">${visual(c.score)}</td></tr>`).join("");
    const total = `<tr class="a-tt"><td class="a-nm"><b style="display:inline;margin-right:10px">${T("Weighted score", "가중 점수")}</b>${chip(b.rating ?? T(level[0], level[1]), level[2])}</td>${hasW ? `<td class="a-wt">100%</td>` : ""}<td class="a-sc">${visual(ratio * max, true)}</td></tr>`;
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-tw"><table><thead><tr><th>${T("Criterion", "기준")}</th>${hasW ? `<th style="text-align:right">${T("Weight", "가중치")}</th>` : ""}<th>${T("Score", "점수")} / ${shown(max)}</th></tr></thead><tbody>${rows}${total}</tbody></table></div>${cap(b.caption)}`;
  },
  summary(b) {
    const max = b.max, hasW = b.criteria.some(c => (c.weight ?? 0) > 0), sw = hasW ? b.criteria.reduce((s, c) => s + Math.max(0, c.weight ?? 0), 0) : b.criteria.length;
    const ratio = b.criteria.reduce((s, c) => s + ((hasW ? Math.max(0, c.weight ?? 0) / sw : 1 / b.criteria.length) * clamp(c.score, 0, max)) / max, 0);
    return fit(`${b.title ?? "Scorecard"}: weighted ${max > 10 ? Math.round(ratio * max) : (ratio * max).toFixed(1)} of ${max}. ${b.criteria.map(c => `${c.name} ${c.score}`).join(", ")}.`);
  },
  css: css("scorecard_table", CHIP, `
    & .a-tw{overflow-x:auto}
    & table{border-collapse:separate;border-spacing:0}
    & .a-nm{font-size:12px;line-height:17px;font-weight:550;color:var(--muted)}
    & .a-nm b{display:block;font-size:14px;line-height:20px;font-weight:700;color:var(--ink)}
    & .a-wt{width:1%;text-align:right;white-space:nowrap;font-size:13px;color:var(--muted)}
    & .a-sc{width:1%;padding-right:12px}
    & .a-sv{display:flex;align-items:center;justify-content:flex-end;gap:12px}
    & .a-sv b{min-width:30px;text-align:right;font-size:14px;font-weight:750}
    & .a-ds{display:flex;gap:4px}
    & .a-ds i{width:12px;height:12px;border-radius:50%;background:linear-gradient(90deg,var(--blue) var(--p),#e3e7e5 var(--p))}
    & .a-br{width:110px;height:8px;border-radius:4px;background:linear-gradient(90deg,var(--blue) var(--p),#eceeec var(--p))}
    & .a-tt td{padding:14px 12px;background:var(--surface);border:0}
    & .a-tt td:first-child{border-radius:12px 0 0 12px}& .a-tt td:last-child{border-radius:0 12px 12px 0}
  `),
});

// ---- matrix_table -----------------------------------------------------------------------------------------------------------------------
const matrixRow = z.object({ label: text(36), values: cells(14, 6) }).strip();
type Sym = { k: "ball"; level: number } | { k: "yes" | "no" | "dash" | "text" } | { k: "letter"; ch: string };
const LEVELS: [RegExp, number][] = [[/^(full|filled|●|⬤|100%|4\/4|complete)$/i, 4], [/^(three[ _-]?quarters?|3\/4|◕|75%)$/i, 3], [/^(half|◐|◑|partial|50%)$/i, 2], [/^(quarter|◔|25%)$/i, 1], [/^(empty|○|◯|none|0%)$/i, 0]];
function sym(raw: string): Sym {
  const v = raw.trim();
  for (const [re, level] of LEVELS) if (re.test(v)) return { k: "ball", level };
  if (/^[A-Z]$/.test(v)) return { k: "letter", ch: v };
  const m = markOf(v);
  return m === "half" ? { k: "ball", level: 2 } : { k: m };
}
const LETTER: Record<string, Hue> = { R: "b", A: "g", C: "a", I: "n" };

export const matrixTable = defineAsset({
  type: "matrix_table", category: "table", width: "two_thirds",
  use: "Rows by columns of symbols (filled, half and empty circles, ticks, numbers, or R/A/C/I letters) for a capability or responsibility matrix, with a legend.",
  useKo: "행×열을 기호(꽉 찬·반·빈 원, 체크, 숫자, R/A/C/I 문자)로 채워 역량·책임(RACI) 매트릭스와 범례를 보여줍니다.",
  tags: ["matrix", "raci", "capability", "responsibility", "harvey", "coverage", "symbols", "매트릭스", "역량", "책임", "라시", "커버리지"],
  notes: "Cells: full, three_quarter, half, quarter, empty (or ● ◐ ○), yes / no, a number, or a capital letter such as R A C I. Leave `legend` out to draw one from the symbols used.",
  fields: { columns: list(text(18), 2, 6), rows: list(matrixRow, 1, 12), legend: list(z.object({ symbol: text(12), label: text(30) }).strip(), 0, 6).optional(), caption: optionalText(140) },
  sample: {
    title: "Vendor capability coverage",
    columns: ["Vendor A", "Vendor B", "Vendor C", "Vendor D"],
    rows: [
      { label: "Single sign-on and SCIM", values: ["full", "full", "half", "empty"] },
      { label: "Audit logging", values: ["full", "three_quarter", "full", "quarter"] },
      { label: "Data residency options", values: ["half", "empty", "full", "empty"] },
      { label: "Uptime SLA and credits", values: ["full", "half", "three_quarter", "half"] },
      { label: "Self-serve onboarding", values: ["quarter", "full", "half", "full"] },
      { label: "Open API coverage", values: ["three_quarter", "three_quarter", "empty", "full"] },
    ],
  },
  render(b, { T }) {
    const LABEL: Record<number, [string, string]> = { 4: ["Full", "충족"], 3: ["Mostly", "대부분"], 2: ["Partial", "부분"], 1: ["Limited", "일부"], 0: ["None", "없음"] };
    const html = (raw: string) => {
      const s = sym(raw);
      if (s.k === "ball") return ball(s.level, T(...LABEL[s.level]));
      if (s.k === "letter") return `<span class="a-l${LETTER[s.ch] === "b" || LETTER[s.ch] === "g" ? " a-so" : ""}" ${hue(LETTER[s.ch] ?? "n")}>${esc(s.ch)}</span>`;
      if (s.k === "text") return /^[+\-−]?\d[\d.,]*%?$/.test(raw.trim()) ? `<b class="a-nu">${esc(raw)}</b>` : `<span class="a-tx">${esc(raw)}</span>`;
      return mark(s.k, raw || T("None", "없음"));
    };
    const used = new Set<string>(), seen = b.rows.flatMap(r => r.values).map(sym);
    let legend = (b.legend ?? []).map(l => ({ symbol: l.symbol, label: l.label }));
    if (!legend.length) {
      for (const s of seen) used.add(s.k === "ball" ? `b${s.level}` : s.k === "letter" ? `l${s.ch}` : s.k);
      const raci = ["R", "A", "C", "I"].filter(c => used.has(`l${c}`)), RACI: Record<string, [string, string]> = { R: ["Responsible", "실행"], A: ["Accountable", "책임"], C: ["Consulted", "자문"], I: ["Informed", "공유"] };
      legend = [...[4, 3, 2, 1, 0].filter(l => used.has(`b${l}`)).map(l => ({ symbol: ["empty", "quarter", "half", "three_quarter", "full"][l], label: T(...LABEL[l]) })), ...(used.has("yes") ? [{ symbol: "yes", label: T("Yes", "예") }] : []), ...(used.has("no") ? [{ symbol: "no", label: T("No", "아니오") }] : []), ...raci.map(c => ({ symbol: c, label: T(...RACI[c]) }))];
    }
    const head = `<tr><th class="a-f"></th>${b.columns.map(c => `<th scope="col">${esc(c)}</th>`).join("")}</tr>`;
    const rows = b.rows.map(r => `<tr><th scope="row" class="a-f">${esc(r.label)}</th>${b.columns.map((_, k) => `<td>${html(r.values[k] ?? "")}</td>`).join("")}</tr>`).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-tw"><table style="--w:${150 + b.columns.length * 84}px"><thead>${head}</thead><tbody>${rows}</tbody></table></div>${legend.length ? `<div class="a-lg">${legend.map(l => `<span>${html(l.symbol)}${esc(l.label)}</span>`).join("")}</div>` : ""}${cap(b.caption)}`;
  },
  summary(b) {
    const words: Record<string, string> = { full: "full", three_quarter: "mostly", half: "partial", quarter: "limited", empty: "none" };
    return fit(`${b.title ?? "Matrix"}: ${b.rows.slice(0, 6).map(r => `${r.label}: ${b.columns.map((c, k) => `${c} ${words[r.values[k]] ?? (r.values[k] || "–")}`).join(", ")}`).join("; ")}.`);
  },
  css: css("matrix_table", `
    & .a-tw{overflow-x:auto}
    & table{border-collapse:separate;border-spacing:0;min-width:var(--w)}
    & th,& td{padding:11px 8px;text-align:center;white-space:normal;border-bottom:1px solid #f0f1ef}
    & thead th{vertical-align:bottom;padding-bottom:10px;border-bottom-color:#e1e5e2;font-size:12.5px;color:#34424a}
    & .a-f{position:sticky;left:0;z-index:1;background:#fff;text-align:left;padding-left:0;font-size:13.5px;font-weight:650;color:#34424a}
    & tbody tr:last-child>*{border-bottom:0}
    & .a-l{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;font-size:12px;font-weight:800;background:rgba(var(--c),.14);color:rgb(var(--c))}
    & .a-so{background:rgb(var(--c));color:#fff}
    & .a-nu{font-size:13.5px;font-weight:750}
    & .a-tx{font-size:12.5px;font-weight:650;color:var(--ink2)}
    & .a-lg{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:12.5px;font-weight:650;color:var(--muted)}
    & .a-lg>span{display:inline-flex;align-items:center;gap:7px}
    @container (max-width:560px){& table{min-width:0}& th,& td{min-width:68px;padding:9px 4px}& thead th{font-size:11.5px}& .a-f{width:108px;min-width:108px;font-size:12.5px}}
  `),
});

export const ASSETS: readonly AnyAsset[] = [comparisonTable, pricingTable, scorecardTable, matrixTable];
