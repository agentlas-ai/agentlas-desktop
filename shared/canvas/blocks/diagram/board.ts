import { z } from "zod";
import { esc } from "../../kit";
import { list, loose, num, optionalNum, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { C, clamp, f, initials, sentence } from "./_graph";

/* ===================================================== roadmap ===================================================== */
const roadStatus = loose(["done", "active", "planned", "risk", "blocked"] as [string, ...string[]], { complete: "done", completed: "done", shipped: "done", released: "done", in_progress: "active", wip: "active", doing: "active", current: "active", started: "active", upcoming: "planned", todo: "planned", backlog: "planned", scheduled: "planned", at_risk: "risk", delayed: "risk", slipping: "risk", warning: "risk", stuck: "blocked", paused: "blocked", on_hold: "blocked" }, "planned").optional();
const DOT: Record<string, string> = { done: C.green2, active: C.blue, planned: "#b9c3be", risk: C.amber2, blocked: C.red };
const COLUMN_BAR = [C.blue, C.blue2, "#b9c3be", "#d3d9d6"];

export const roadmap = defineAsset({
  type: "roadmap", category: "diagram", width: "full",
  use: "A roadmap in columns (now, next, later or quarters) of initiative cards with a tag and a status dot, optionally in rows by theme.",
  useKo: "지금·다음·나중(또는 분기) 열에 이니셔티브 카드를 놓고 태그와 상태 점을 붙이며, 테마별 행으로 나눌 수도 있는 로드맵입니다.",
  tags: ["roadmap", "now next later", "quarters", "initiatives", "plan", "themes", "product roadmap", "로드맵", "분기", "계획", "이니셔티브", "우선순위"],
  notes: "2 to 4 columns, at most 6 cards each. status: done, active, planned, risk, blocked. Give cards a theme to split the board into rows (up to 4 themes; cards without one go to Other).",
  fields: {
    columns: list(z.object({ name: text(24), sub: optionalText(30), items: list(z.object({ title: text(64), tag: optionalText(18), status: roadStatus, theme: optionalText(24) }).strip(), 0, 6).default([]) }).strip(), 2, 4),
  },
  sample: {
    title: "Product roadmap",
    columns: [
      { name: "Now", sub: "Q4 2026", items: [
        { title: "Self-serve onboarding", tag: "Activation", status: "active", theme: "Growth" }, { title: "Usage-based billing", tag: "Revenue", status: "risk", theme: "Growth" },
        { title: "Single sign-on", tag: "Enterprise", status: "done", theme: "Trust" }, { title: "Faster search index", tag: "Perf", status: "active", theme: "Platform" } ] },
      { name: "Next", sub: "Q1 2027", items: [
        { title: "Referral programme", tag: "Acquisition", status: "planned", theme: "Growth" }, { title: "Audit log export", tag: "Compliance", status: "planned", theme: "Trust" },
        { title: "Public API v2", tag: "Developers", status: "planned", theme: "Platform" } ] },
      { name: "Later", sub: "H2 2027", items: [
        { title: "Marketplace for templates", tag: "Ecosystem", status: "planned", theme: "Growth" }, { title: "Data residency options", tag: "Compliance", status: "blocked", theme: "Trust" } ] },
    ],
  },
  render(b, { ko, T }) {
    const cols = b.columns, themes: string[] = [];
    for (const c of cols) for (const it of c.items) if (it.theme && !themes.includes(it.theme) && themes.length < 4) themes.push(it.theme);
    const lane = (t?: string) => (t && themes.includes(t) ? themes.indexOf(t) : themes.length), lanes = themes.length ? [...themes, ...(cols.some(c => c.items.some(it => lane(it.theme) === themes.length)) ? [T("Other", "기타")] : [])] : [""];
    const card = (it: (typeof cols)[number]["items"][number]) => `<div class="a-cd"><i class="a-dt" style="background:${DOT[it.status ?? "planned"]}"></i><div>${esc(it.title)}${it.tag ? `<br><span class="a-tg">${esc(it.tag)}</span>` : ""}</div></div>`;
    const head = `<div class="a-hd${themes.length ? " a-L" : ""}">${themes.length ? "<span></span>" : ""}${cols.map((c, i) => `<div class="a-ch" style="--k:${COLUMN_BAR[i % 4]}"><b>${esc(c.name)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : ""}</div>`).join("")}</div>`;
    const rows = lanes.map((name, li) => `<div class="a-ro${themes.length ? " a-L" : ""}">${themes.length ? `<div class="a-lb">${esc(name)}</div>` : ""}${cols.map(c => { const items = c.items.filter(it => (themes.length ? lane(it.theme) : 0) === li); return `<div class="a-ce${items.length ? "" : " a-e"}"><div class="a-cn">${esc(c.name)}${c.sub ? ` · ${esc(c.sub)}` : ""}</div>${items.map(card).join("")}</div>`; }).join("")}</div>`).join("");
    const used = [...new Set(cols.flatMap(c => c.items.map(it => it.status ?? "planned")))], words: Record<string, [string, string]> = { done: ["Done", "완료"], active: ["In progress", "진행 중"], planned: ["Planned", "예정"], risk: ["At risk", "위험"], blocked: ["Blocked", "막힘"] };
    const legend = used.length ? `<div class="a-lg">${["done", "active", "planned", "risk", "blocked"].filter(k => used.includes(k)).map(k => `<span><i style="background:${DOT[k]}"></i>${esc(ko ? words[k][1] : words[k][0])}</span>`).join("")}</div>` : "";
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-rm" style="--n:${cols.length}">${head}${rows}${legend}</div>`;
  },
  summary: b => sentence([`${b.title ?? "Roadmap"}:`, ...b.columns.map(c => `${c.name}${c.sub ? ` (${c.sub})` : ""}: ${c.items.length ? c.items.map(it => `${it.title}${it.status && it.status !== "planned" ? ` [${it.status}]` : ""}`).join(", ") : "nothing yet"}.`)]),
  css: [
    ".fpc .a-roadmap .a-hd,.fpc .a-roadmap .a-ro{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:12px}.fpc .a-roadmap .a-L{grid-template-columns:96px repeat(var(--n),minmax(0,1fr))}",
    ".fpc .a-roadmap .a-hd{margin-bottom:10px}.fpc .a-roadmap .a-ro+.a-ro{margin-top:12px}",
    ".fpc .a-roadmap .a-ch{padding-top:9px;border-top:3px solid var(--k)}.fpc .a-roadmap .a-ch b{display:block;font-size:12.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.fpc .a-roadmap .a-ch small{font-size:12px;font-weight:600;color:#9aa2a7}",
    ".fpc .a-roadmap .a-lb{padding-top:12px;font-size:12.5px;font-weight:750;color:#34424a}",
    ".fpc .a-roadmap .a-ce{display:grid;gap:8px;align-content:start;padding:10px;min-height:64px;border-radius:14px;background:#f7f8f7}",
    ".fpc .a-roadmap .a-cn{display:none;font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#9aa2a7}",
    ".fpc .a-roadmap .a-cd{display:flex;gap:9px;padding:10px 12px;border-radius:11px;border:1px solid #e7e8e5;background:#fff;font-size:13px;font-weight:650;line-height:1.3}",
    ".fpc .a-roadmap .a-dt{flex:none;width:9px;height:9px;margin-top:4px;border-radius:50%}",
    ".fpc .a-roadmap .a-tg{display:inline-block;margin-top:6px;padding:1px 8px;border-radius:9px;background:#eef0ee;font-size:11px;font-weight:650;color:#4a5860}",
    ".fpc .a-roadmap .a-lg{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:14px;font-size:12px;font-weight:600;color:#5c6870}.fpc .a-roadmap .a-lg i{display:inline-block;width:9px;height:9px;margin-right:6px;border-radius:50%}",
    "@container (max-width:640px){.fpc .a-roadmap .a-hd{display:none}.fpc .a-roadmap .a-ro,.fpc .a-roadmap .a-L{grid-template-columns:1fr}.fpc .a-roadmap .a-cn{display:block}.fpc .a-roadmap .a-e{display:none}}",
  ].join(""),
});

/* ===================================================== journey_map ===================================================== */
const sentiment = (s: number) => (s >= 3.8 ? { c: C.green2, ink: C.green, t: C.gT } : s >= 2.8 ? { c: C.amber2, ink: C.amber, t: C.aT } : { c: C.red, ink: C.red, t: C.rT });

export const journeyMap = defineAsset({
  type: "journey_map", category: "diagram", width: "full",
  use: "A customer or user journey: stages across the top, a satisfaction curve through a 1-5 score per stage, and rows of actions, pain points and touchpoints under each stage.",
  useKo: "고객·사용자 여정을 단계별로 보여줍니다(단계, 1~5점 만족도 곡선, 단계별 행동·불편·접점 행).",
  tags: ["journey", "customer journey", "user journey", "experience", "touchpoints", "pain points", "satisfaction", "여정", "고객 여정", "사용자 여정", "접점", "불편", "만족도"],
  notes: "3 to 7 stages with a score from 1 (frustrated) to 5 (delighted). Up to 3 actions and 3 pain points per stage, each a short phrase; touchpoint is the channel (Email, App, Store). persona names who the journey is about.",
  fields: {
    persona: optionalText(60),
    stages: list(z.object({ name: text(24), score: num, actions: list(text(60), 0, 3).default([]), pains: list(text(60), 0, 3).default([]), touchpoint: optionalText(24) }).strip(), 3, 7),
  },
  sample: {
    title: "First-time buyer journey",
    persona: "Maya, a first-time buyer comparing three shops",
    stages: [
      { name: "Discover", score: 4, actions: ["Sees a friend's post", "Searches the shop's name"], pains: ["Too many similar shops"], touchpoint: "Social" },
      { name: "Compare", score: 3, actions: ["Reads reviews", "Checks delivery times"], pains: ["Prices differ by region"], touchpoint: "Website" },
      { name: "Purchase", score: 2, actions: ["Adds to the basket", "Creates an account"], pains: ["Forced sign-up", "Card form rejects once"], touchpoint: "Checkout" },
      { name: "Delivery", score: 3, actions: ["Tracks the parcel"], pains: ["No time window"], touchpoint: "Email, SMS" },
      { name: "Support", score: 5, actions: ["Chats about a size swap", "Gets a prepaid label"], pains: ["Has to repeat the order number"], touchpoint: "Chat" },
    ],
  },
  render(b, { uid, T }) {
    const st = b.stages, n = st.length, sc = st.map(s => clamp(s.score, 1, 5)), X = (i: number) => ((i + 0.5) / n) * 100, Y = (v: number) => 88 - ((v - 1) / 4) * 76;
    const pts = sc.map((v, i) => [X(i), Y(v)] as const);
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i + 1 < n; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)], cy = (v: number) => clamp(v, 4, 96);
      d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(cy(p1[1] + (p2[1] - p0[1]) / 6))} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(cy(p2[1] - (p3[1] - p1[1]) / 6))} ${f(p2[0])},${f(p2[1])}`;
    }
    const area = `${d}L${f(pts[n - 1][0])},100L${f(pts[0][0])},100Z`;
    const guides = [1, 3, 5].map(v => `<line x1="0" x2="100" y1="${f(Y(v))}" y2="${f(Y(v))}" stroke="#d3d9d6" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>`).join("");
    const svg = `<svg class="a-cv" viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true"><defs><linearGradient id="${uid}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.blue}" stop-opacity=".16"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0"/></linearGradient></defs>${guides}<path d="${area}" fill="url(#${uid}f)"/><path d="${d}" fill="none" stroke="${C.blue}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
    const dots = pts.map((p, i) => `<b class="a-pt" style="left:${f(p[0])}%;top:${f(p[1])}%;background:${sentiment(sc[i]).c}">${Math.round(sc[i] * 10) / 10}</b>`).join("");
    const cells = (render: (s: (typeof st)[number], i: number) => string) => st.map((s, i) => `<div class="a-c">${render(s, i)}</div>`).join("");
    const bullets = (xs: readonly string[], cls: string) => (xs.length ? `<ul class="${cls}">${xs.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<span class="a-no">–</span>`);
    const row = (label: string, body: string, cls = "") => `<div class="a-lb">${esc(label)}</div>${body}${cls}`;
    const rows = [
      row("", st.map((s, i) => `<div class="a-sg"><em style="background:${sentiment(sc[i]).c}">${i + 1}</em><b>${esc(s.name)}</b></div>`).join("")),
      st.some(s => s.actions.length) ? row(T("Actions", "행동"), cells(s => bullets(s.actions, "a-ls"))) : "",
      `<div class="a-lb">${esc(T("Feeling", "감정"))}<small>${esc(T("High", "높음"))}</small><small class="a-lo">${esc(T("Low", "낮음"))}</small></div><div class="a-cvc">${svg}${dots}</div>`,
      st.some(s => s.pains.length) ? row(T("Pain points", "불편"), cells(s => bullets(s.pains, "a-ls a-ps")).replace(/class="a-c"/g, 'class="a-c a-pc"')) : "",
      st.some(s => s.touchpoint) ? row(T("Touchpoint", "접점"), cells(s => (s.touchpoint ? `<span class="a-tp">${esc(s.touchpoint)}</span>` : `<span class="a-no">–</span>`))) : "",
    ].join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-sc"><div class="a-jm" style="--n:${n}">${b.persona ? `<div class="a-pe"><u>${esc(initials(b.persona))}</u>${esc(b.persona)}</div>` : ""}<div class="a-gr">${rows}</div></div></div>`;
  },
  summary(b) {
    const sc = (s: number) => Math.round(clamp(s, 1, 5) * 10) / 10;
    return sentence([`${b.title ?? "Journey map"}${b.persona ? ` for ${b.persona}` : ""}:`, ...b.stages.map(s => `${s.name} (satisfaction ${sc(s.score)}/5${s.touchpoint ? `, ${s.touchpoint}` : ""})${s.pains.length ? ` pain: ${s.pains.join("; ")}` : ""}.`)]);
  },
  css: [
    ".fpc .a-journey_map .a-sc{overflow-x:auto}.fpc .a-journey_map .a-jm{min-width:calc(96px + var(--n) * 122px)}",
    ".fpc .a-journey_map .a-pe{display:flex;align-items:center;gap:9px;margin-bottom:14px;font-size:13px;font-weight:650;color:#34424a}.fpc .a-journey_map u{flex:none;width:26px;height:26px;border-radius:50%;background:#101d24;color:#fff;font-size:10.5px;font-weight:800;text-decoration:none;display:flex;align-items:center;justify-content:center}",
    ".fpc .a-journey_map .a-gr{display:grid;grid-template-columns:96px repeat(var(--n),minmax(0,1fr));column-gap:10px}",
    ".fpc .a-journey_map .a-lb{padding:12px 6px 0 0;font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#9aa2a7;border-top:1px solid #e7e8e5;position:relative}.fpc .a-journey_map .a-lb small{position:absolute;right:8px;top:12px;font-size:10.5px;letter-spacing:0;text-transform:none;font-weight:600}.fpc .a-journey_map .a-lb small.a-lo{top:auto;bottom:8px}",
    ".fpc .a-journey_map .a-sg{display:flex;align-items:center;gap:8px;padding:0 0 12px;font-size:13.5px;font-weight:750}.fpc .a-journey_map .a-sg em{flex:none;width:22px;height:22px;border-radius:50%;color:#fff;font-size:11.5px;font-style:normal;font-weight:800;display:flex;align-items:center;justify-content:center}",
    ".fpc .a-journey_map .a-c{padding:10px 4px 10px 0;border-top:1px solid #e7e8e5;font-size:12.5px;line-height:1.4;color:#34424a}.fpc .a-journey_map .a-pc{color:#8f2431}",
    ".fpc .a-journey_map .a-ls{margin:0;padding:0 0 0 14px}.fpc .a-journey_map .a-ls li{margin-bottom:4px}.fpc .a-journey_map .a-ps li::marker{color:#cf3545}",
    ".fpc .a-journey_map .a-tp{display:inline-block;padding:2px 9px;border-radius:10px;background:#eef0ee;font-size:11.5px;font-weight:650;color:#4a5860}.fpc .a-journey_map .a-no{color:#b9c3be}",
    ".fpc .a-journey_map .a-cvc{grid-column:2/-1;position:relative;height:128px;border-top:1px solid #e7e8e5}.fpc .a-journey_map .a-cv{position:absolute;inset:0}",
    ".fpc .a-journey_map .a-pt{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 4px rgba(16,29,36,.22);color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center}",
  ].join(""),
});

/* ===================================================== kanban_board ===================================================== */
const priority = loose(["high", "medium", "low"] as [string, ...string[]], { urgent: "high", critical: "high", p0: "high", p1: "high", normal: "medium", med: "medium", p2: "medium", minor: "low", p3: "low" }, "medium").optional();
const PRIO: Record<string, string> = { high: C.red, medium: C.amber2, low: C.blue2 };
const AVATAR = [["#e7eefc", C.blue], ["#e3f1eb", C.green], ["#fbf1de", C.amber], ["#eef0ee", C.ink2]];

export const kanbanBoard = defineAsset({
  type: "kanban_board", category: "diagram", width: "full",
  use: "A kanban board: three to five columns with a card count (and an optional WIP limit), each holding up to five cards with tags, an assignee and a priority bar.",
  useKo: "3~5개 열의 칸반 보드를 그립니다(열별 카드 수와 WIP 한도, 카드별 태그·담당자·우선순위 막대).",
  tags: ["kanban", "board", "tasks", "backlog", "wip", "sprint", "cards", "칸반", "보드", "작업", "백로그", "스프린트", "카드"],
  notes: "3 to 5 columns, at most 5 cards each. wip is the column's limit: the count turns red when the cards exceed it. A card: title, up to 3 short tags, assignee (a name), priority (high, medium, low).",
  fields: {
    columns: list(z.object({
      name: text(24), wip: optionalNum,
      cards: list(z.object({ title: text(70), tags: list(text(14), 0, 3).default([]), assignee: optionalText(24), priority }).strip(), 0, 5).default([]),
    }).strip(), 3, 5),
  },
  sample: {
    title: "Sprint 42 board",
    columns: [
      { name: "Backlog", cards: [{ title: "Export invoices as CSV", tags: ["Billing"], assignee: "Dana Lee", priority: "low" }, { title: "Dark mode for the dashboard", tags: ["Design", "UI"], priority: "medium" }, { title: "Rate limits for the public API", tags: ["API"], assignee: "Omar Haddad", priority: "medium" }] },
      { name: "In progress", wip: 2, cards: [{ title: "Fix duplicate charges on retry", tags: ["Payments", "Bug"], assignee: "Sam Ortiz", priority: "high" }, { title: "Onboarding checklist v2", tags: ["Growth"], assignee: "Mina Park", priority: "medium" }, { title: "Migrate sessions to Redis", tags: ["Infra"], assignee: "Jo Chen", priority: "medium" }] },
      { name: "Review", wip: 3, cards: [{ title: "Webhook signature checks", tags: ["Security"], assignee: "Dana Lee", priority: "high" }, { title: "Empty states for reports", tags: ["UI"], assignee: "Mina Park", priority: "low" }] },
      { name: "Done", cards: [{ title: "Upgrade to Node 22", tags: ["Infra"], assignee: "Jo Chen" }, { title: "Billing page copy", tags: ["Content"], assignee: "Omar Haddad" }] },
    ],
  },
  render(b, { T }) {
    const cols = b.columns;
    const body = cols.map(c => {
      const over = typeof c.wip === "number" && c.wip > 0 && c.cards.length > c.wip, count = typeof c.wip === "number" && c.wip > 0 ? `${c.cards.length}/${Math.round(c.wip)}` : String(c.cards.length);
      const cards = c.cards.map(k => {
        const av = k.assignee ? AVATAR[[...k.assignee].reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR.length] : null;
        return `<div class="a-cd" style="--p:${PRIO[k.priority ?? ""] ?? "#d3d9d6"}"><div class="a-ti">${esc(k.title)}</div>${k.tags.length || av ? `<div class="a-ft"><span>${k.tags.map(t => `<em>${esc(t)}</em>`).join("")}</span>${av && k.assignee ? `<u title="${esc(k.assignee)}" style="background:${av[0]};color:${av[1]}">${esc(initials(k.assignee))}</u>` : ""}</div>` : ""}</div>`;
      }).join("");
      return `<div class="a-kc"><div class="a-kh"><b>${esc(c.name)}</b><span class="a-n${over ? " a-ov" : ""}">${count}</span></div>${cards || `<div class="a-em">${esc(T("No cards", "카드 없음"))}</div>`}</div>`;
    }).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-kb" style="--n:${cols.length}">${body}</div>`;
  },
  summary: b => sentence([`${b.title ?? "Kanban board"}:`, ...b.columns.map(c => `${c.name} (${c.cards.length}${c.wip ? `/${Math.round(c.wip)}` : ""}${c.wip && c.cards.length > c.wip ? ", over the limit" : ""}): ${c.cards.map(k => `${k.title}${k.assignee ? ` - ${k.assignee}` : ""}${k.priority === "high" ? " (high)" : ""}`).join(", ") || "empty"}.`)]),
  css: [
    ".fpc .a-kanban_board .a-kb{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:14px;align-items:start}",
    ".fpc .a-kanban_board .a-kc{display:grid;gap:9px;padding:10px;border-radius:16px;background:#f7f8f7}",
    ".fpc .a-kanban_board .a-kh{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 4px 4px}.fpc .a-kanban_board .a-kh b{min-width:0;font-size:13px;font-weight:800;letter-spacing:.01em}",
    ".fpc .a-kanban_board .a-n{flex:none;min-width:26px;padding:1px 8px;border-radius:11px;background:#fff;border:1px solid #e7e8e5;font-size:12px;font-weight:750;text-align:center;color:#5c6870}.fpc .a-kanban_board .a-ov{background:#f8e6e8;border-color:#efc4c9;color:#cf3545}",
    ".fpc .a-kanban_board .a-cd{position:relative;padding:11px 12px 10px 16px;border-radius:11px;background:#fff;border:1px solid #e7e8e5}.fpc .a-kanban_board .a-cd::before{content:\"\";position:absolute;left:6px;top:10px;bottom:10px;width:3.5px;border-radius:2px;background:var(--p)}",
    ".fpc .a-kanban_board .a-ti{font-size:13px;font-weight:650;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
    ".fpc .a-kanban_board .a-ft{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px}.fpc .a-kanban_board .a-ft span{display:flex;flex-wrap:wrap;gap:5px;min-width:0}",
    ".fpc .a-kanban_board em{padding:1px 8px;border-radius:9px;background:#eef0ee;font-size:11px;font-style:normal;font-weight:650;color:#4a5860}",
    ".fpc .a-kanban_board u{flex:none;width:24px;height:24px;border-radius:50%;font-size:10px;font-weight:800;text-decoration:none;display:flex;align-items:center;justify-content:center}.fpc .a-kanban_board .a-em{padding:14px 0;border:1.5px dashed #d3d9d6;border-radius:11px;font-size:12px;font-weight:600;text-align:center;color:#9aa2a7}",
    "@container (max-width:560px){.fpc .a-kanban_board .a-kb{grid-template-columns:1fr}}",
  ].join(""),
});

export const ASSETS: readonly AnyAsset[] = [roadmap, journeyMap, kanbanBoard];
