import { z } from "zod";
import { canvasFormat, esc } from "../../kit";
import { list, loose, num, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { C, arrow, clamp, f, initials, lines, pill, ramp, sentence, shell, shellCss, wrap } from "./_graph";

const even = (v: number) => Math.round(v / 2) * 2;
/** A count as it is written on a block: 1,240 stays whole, 12,400 is 12.4K, 3,100,000 is 3.1M. */
const short = (v: number) => { const a = Math.abs(v), g = (x: number, u: string) => `${v < 0 ? "−" : ""}${+x.toFixed(1)}${u}`; return a >= 1e6 ? g(a / 1e6, "M") : a >= 1e4 ? g(a / 1e3, "K") : Math.round(v).toLocaleString("en-US"); };

/* ===================================================== process_steps ===================================================== */
export const processSteps = defineAsset({
  type: "process_steps", category: "diagram", width: "full",
  use: "A short process as a row of chevron steps, each with a number, a title, one or two lines of description and an optional owner; it wraps to two rows when narrow.",
  useKo: "짧은 절차를 번호, 제목, 한두 줄 설명, 담당자가 달린 화살표 단계 한 줄로 그립니다(좁으면 두 줄로 접힙니다).",
  tags: ["process", "steps", "chevron", "stages", "how it works", "workflow", "roadmap of steps", "단계", "절차", "프로세스", "진행 순서", "화살표"],
  notes: "3 to 7 steps in order; the number is added. Keep a title under 40 characters and a description to a sentence. owner is a name or a team.",
  fields: { steps: list(z.object({ title: text(40), text: optionalText(120), owner: optionalText(24) }).strip(), 3, 7) },
  sample: {
    title: "How a release ships",
    steps: [
      { title: "Plan", text: "Scope the release and agree what is in and out.", owner: "Priya" },
      { title: "Build", text: "Implement behind flags and keep the main branch green.", owner: "Dev team" },
      { title: "Test", text: "Run the full suite and a one-day bug bash.", owner: "QA" },
      { title: "Review", text: "Security and product sign-off on the release notes.", owner: "Marcus" },
      { title: "Deploy", text: "Roll out to 5%, then 100%, and watch the dashboards.", owner: "SRE" },
    ],
  },
  render(b) {
    const n = b.steps.length;
    const items = b.steps.map((s, i) => {
      const color = ramp(i, n);
      return `<div class="a-st"><div class="a-c" style="background:${color}"><b style="color:${color}">${i + 1}</b><span>${esc(s.title)}</span></div>${s.text ? `<p>${esc(s.text)}</p>` : ""}${s.owner ? `<i><u>${esc(initials(s.owner))}</u>${esc(s.owner)}</i>` : ""}</div>`;
    }).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-r a-n${n}">${items}</div>`;
  },
  summary: b => sentence([`${b.title ?? "Process"} in ${b.steps.length} steps:`, ...b.steps.map((s, i) => `${i + 1} ${s.title}${s.owner ? ` (${s.owner})` : ""}${s.text ? ` - ${s.text.replace(/[.。]+$/, "")}` : ""}.`)]),
  css: [
    ".fpc .a-process_steps .a-r{display:grid;grid-template-columns:repeat(var(--c),minmax(0,1fr));row-gap:24px;padding-right:10px}",
    ".fpc .a-process_steps .a-n3{--c:3}.fpc .a-process_steps .a-n4{--c:4}.fpc .a-process_steps .a-n5{--c:5}.fpc .a-process_steps .a-n6{--c:6}.fpc .a-process_steps .a-n7{--c:7}",
    ".fpc .a-process_steps .a-st{min-width:0}",
    ".fpc .a-process_steps .a-c{display:flex;align-items:center;gap:9px;min-height:54px;padding:8px 22px 8px 24px;width:calc(100% + 10px);color:#fff;clip-path:polygon(0 0,calc(100% - 16px) 0,100% 50%,calc(100% - 16px) 100%,0 100%,16px 50%)}",
    ".fpc .a-process_steps .a-c b{flex:none;width:24px;height:24px;border-radius:50%;background:#fff;font-size:12.5px;font-weight:800;display:flex;align-items:center;justify-content:center}",
    ".fpc .a-process_steps .a-c span{min-width:0;font-size:13.5px;font-weight:750;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
    ".fpc .a-process_steps p{margin:10px 14px 0 24px;font-size:12.5px;line-height:1.45;color:#5c6870;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
    ".fpc .a-process_steps i{display:flex;align-items:center;gap:6px;width:fit-content;max-width:calc(100% - 28px);margin:9px 0 0 24px;padding:2px 10px 2px 3px;border-radius:12px;background:#f7f8f7;font-size:11.5px;font-style:normal;font-weight:650;color:#34424a}",
    ".fpc .a-process_steps u{flex:none;width:18px;height:18px;border-radius:50%;background:#e7eefc;color:#2f5fd6;font-size:9.5px;font-weight:800;text-decoration:none;display:flex;align-items:center;justify-content:center}",
    "@container (max-width:1000px){.fpc .a-process_steps .a-n7{--c:4}}@container (max-width:840px){.fpc .a-process_steps .a-n6{--c:3}}@container (max-width:700px){.fpc .a-process_steps .a-n5{--c:3}}@container (max-width:560px){.fpc .a-process_steps .a-n4{--c:2}}",
  ].join(""),
});

/* ===================================================== cycle_diagram ===================================================== */
export const cycleDiagram = defineAsset({
  type: "cycle_diagram", category: "diagram", width: "two_thirds",
  use: "A repeating loop of three to six numbered steps around a circle with curved arrows and a label in the centre (PDCA, a flywheel, a sprint cycle).",
  useKo: "3~6개의 번호 단계가 원을 따라 곡선 화살표로 이어지는 반복 순환을 그립니다(PDCA, 플라이휠, 스프린트 사이클).",
  tags: ["cycle", "loop", "flywheel", "pdca", "iteration", "continuous improvement", "circular", "순환", "사이클", "플라이휠", "반복", "선순환"],
  notes: "3 to 6 steps, clockwise from the top. center is the loop's name (short); centerSub a few words under it.",
  fields: { steps: list(z.object({ title: text(28), text: optionalText(80) }).strip(), 3, 6), center: optionalText(40), centerSub: optionalText(40) },
  sample: {
    title: "Continuous improvement",
    center: "PDCA",
    centerSub: "Repeat every sprint",
    steps: [
      { title: "Plan", text: "Pick one problem and set a measurable target." },
      { title: "Do", text: "Try the change on a small scale." },
      { title: "Check", text: "Compare the result with the target." },
      { title: "Act", text: "Adopt what worked, drop what did not." },
    ],
  },
  render(b, { uid, T }) {
    const n = b.steps.length, R = 124, r = 22, labelW = 168, side = labelW + r + 16, cx = side + R, W = cx * 2;
    const items = b.steps.map((s, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n, x = Math.cos(a), y = Math.sin(a), t = wrap(s.text ?? "", labelW - 8, 3, 12, false);
      return { s, i, a, nx: R * x, ny: R * y, x, y, t: s.text ? t : null, title: wrap(s.title, labelW - 8, 2, 13.5, true) };
    });
    const blockH = (it: (typeof items)[number]) => it.title.lines.length * 17 + (it.t ? it.t.lines.length * 15 + 4 : 0);
    const top = Math.max(R + r + 4, ...items.filter(it => it.y < -0.5).map(it => -it.ny + r + 10 + blockH(it))), bottom = Math.max(R + r + 4, ...items.filter(it => it.y > 0.5).map(it => it.ny + r + 10 + blockH(it)));
    const cy = top + 10, H = cy + bottom + 10;
    const arcs = items.map(it => {
      const next = items[(it.i + 1) % n], d = 2 * Math.asin((r + 8) / (2 * R)), a1 = it.a + d, a2 = (next.i === 0 ? -Math.PI / 2 + 2 * Math.PI : next.a) - d;
      return `<path d="M${f(cx + R * Math.cos(a1))},${f(cy + R * Math.sin(a1))}A${R},${R} 0 0 1 ${f(cx + R * Math.cos(a2))},${f(cy + R * Math.sin(a2))}" fill="none" stroke="${ramp(it.i, n)}" stroke-width="3.2" stroke-linecap="round" marker-end="url(#${uid}a${it.i})"/>`;
    }).join("");
    const nodes = items.map(it => {
      const x = cx + it.nx, y = cy + it.ny, color = ramp(it.i, n), onSide = Math.abs(it.x) >= 0.2, right = it.x > 0;
      const lx = onSide ? x + (right ? r + 14 : -(r + 14)) : x, anchor = onSide ? (right ? "start" : "end") : "middle";
      const h = blockH(it), ty = onSide ? y - h / 2 : it.y < 0 ? y - r - 10 - h : y + r + 10;
      const title = `<text text-anchor="${anchor}" font-size="13.5" font-weight="750" fill="${C.ink}">${it.title.lines.map((l, k) => `<tspan x="${f(lx)}" y="${f(ty + 8.5 + k * 17)}" dy=".35em">${esc(l)}</tspan>`).join("")}</text>`;
      const body = it.t ? `<text text-anchor="${anchor}" font-size="12" font-weight="500" fill="${C.muted}">${it.t.lines.map((l, k) => `<tspan x="${f(lx)}" y="${f(ty + it.title.lines.length * 17 + 4 + 7.5 + k * 15)}" dy=".35em">${esc(l)}</tspan>`).join("")}</text>` : "";
      return `<circle cx="${f(x)}" cy="${f(y)}" r="${r + 4}" fill="${color}" fill-opacity=".16"/><circle cx="${f(x)}" cy="${f(y)}" r="${r}" fill="${color}" stroke="#fff" stroke-width="2.5"/>${lines([String(it.i + 1)], x, y, { size: 16, weight: 800, fill: C.white })}${title}${body}`;
    }).join("");
    const inner = R - r - 16, c = b.center ? wrap(b.center, inner * 1.5, 3, 17, true) : null, sub = b.centerSub ? wrap(b.centerSub, inner * 1.5, 2, 12, false) : null;
    const total = (c ? c.lines.length * 21 : 0) + (sub ? sub.lines.length * 15 + (c ? 6 : 0) : 0), fallback = T(`${n}-step cycle`, `${n}단계 순환`);
    const centre = c || sub
      ? `${c ? lines(c.lines, cx, cy - total / 2 + (c.lines.length * 21) / 2, { size: 17, weight: 800, lh: 21 }) : ""}${sub ? lines(sub.lines, cx, cy - total / 2 + (c ? c.lines.length * 21 + 6 : 0) + (sub.lines.length * 15) / 2, { size: 12, weight: 550, fill: C.muted, lh: 15 }) : ""}`
      : lines([fallback], cx, cy, { size: 12.5, weight: 650, fill: C.faint });
    const defs = items.map(it => arrow(`${uid}a${it.i}`, ramp(it.i, n))).join("");
    const body = `<circle cx="${cx}" cy="${f(cy)}" r="${inner}" fill="${C.surface}" stroke="${C.line}"/><circle cx="${cx}" cy="${f(cy)}" r="${R}" fill="none" stroke="${C.line}" stroke-dasharray="2 6" stroke-linecap="round"/>${arcs}${centre}${nodes}`;
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${shell(uid, W, H, defs, body)}`;
  },
  summary: b => sentence([`${b.title ?? "Cycle"}${b.center ? ` (${b.center})` : ""}, ${b.steps.length} steps in a loop:`, ...b.steps.map((s, i) => `${i + 1} ${s.title}${s.text ? ` - ${s.text.replace(/[.。]+$/, "")}` : ""}.`), "Then back to step 1."]),
  css: shellCss("cycle_diagram"),
});

/* ===================================================== milestone_timeline ===================================================== */
const status = loose(["done", "now", "next"] as [string, ...string[]], { complete: "done", completed: "done", finished: "done", shipped: "done", past: "done", current: "now", active: "now", in_progress: "now", ongoing: "now", today: "now", upcoming: "next", planned: "next", pending: "next", future: "next", todo: "next" }, "next").optional();
const STATE = { done: { c: C.green2, ink: C.green }, now: { c: C.blue, ink: C.blue }, next: { c: "#aeb8b3", ink: C.muted } } as const;

export const milestoneTimeline = defineAsset({
  type: "milestone_timeline", category: "diagram", width: "full",
  use: "Dated milestones along a horizontal axis, alternating above and below, coloured done, now or next, with a marker for today.",
  useKo: "날짜가 있는 마일스톤을 가로 축 위아래로 번갈아 배치하고 완료·진행·예정 색을 입히며 오늘 표시를 둡니다.",
  tags: ["timeline", "milestones", "schedule", "project plan", "dates", "progress", "마일스톤", "일정", "타임라인", "프로젝트 계획", "진행 상황"],
  notes: "3 to 8 milestones in date order, evenly spaced. date is the text shown (\"Sep 30\", \"Q1 2027\"). status: done, now (today sits on it) or next; today: false hides the marker.",
  fields: {
    milestones: list(z.object({ date: text(20), title: text(48), text: optionalText(80), status }).strip(), 3, 8),
    today: z.boolean().optional(),
  },
  sample: {
    title: "Product launch plan",
    milestones: [
      { date: "Sep 2", title: "Kickoff", text: "Scope and owners agreed", status: "done" },
      { date: "Sep 30", title: "Design freeze", text: "Final screens approved", status: "done" },
      { date: "Oct 28", title: "Private beta", text: "120 teams invited", status: "done" },
      { date: "Nov 18", title: "Security review", text: "Pen test and fixes", status: "now" },
      { date: "Dec 9", title: "Public launch", text: "Announcement and pricing live", status: "next" },
      { date: "Jan 13", title: "Retrospective", text: "Lessons and the next quarter", status: "next" },
    ],
  },
  render(b, { uid, T }) {
    const ms = b.milestones, n = ms.length, W = 900, M = 74, step = (W - 2 * M) / (n - 1), cw = Math.min(188, Math.floor(2 * step - 18)), STEM = 38, PAD = 14;
    const X = (i: number) => M + i * step, st = (i: number) => (ms[i].status ?? "next") as keyof typeof STATE;
    const cards = ms.map(m => { const t = wrap(m.title, cw - 22, 2, 13, true), d = m.text ? wrap(m.text, cw - 22, 2, 11.5) : null; return { t, d, h: 14 + 15 + t.lines.length * 16 + (d ? 4 + d.lines.length * 14 : 0) + 8 }; });
    const above = Math.max(0, ...cards.filter((_c, i) => i % 2 === 0).map(c => c.h)), below = Math.max(0, ...cards.filter((_c, i) => i % 2 === 1).map(c => c.h));
    const A = PAD + above + STEM + (above ? 0 : -20), H = A + STEM + below + PAD + (below ? 0 : -20);
    const doneIdx = ms.map((_m, i) => i).filter(i => st(i) === "done"), nowIdx = ms.findIndex((_m, i) => st(i) === "now"), nextIdx = ms.findIndex((_m, i) => st(i) === "next");
    let todayX: number | null = null, onMilestone = false;
    if (b.today !== false) { if (nowIdx >= 0) { todayX = X(nowIdx); onMilestone = true; } else if (doneIdx.length && nextIdx >= 0) todayX = (X(doneIdx[doneIdx.length - 1]) + X(nextIdx)) / 2; }
    const progressTo = todayX ?? (doneIdx.length === n ? X(n - 1) : doneIdx.length ? X(doneIdx[doneIdx.length - 1]) : X(0));
    const axis = `<line x1="${M - 36}" x2="${W - M + 36}" y1="${A}" y2="${A}" stroke="${C.soft}" stroke-width="4" stroke-linecap="round"/>${progressTo > M - 36 ? `<line x1="${M - 36}" x2="${f(progressTo)}" y1="${A}" y2="${A}" stroke="${C.green2}" stroke-width="4" stroke-linecap="round"/>` : ""}`;
    const items = ms.map((m, i) => {
      const x = X(i), up = i % 2 === 0, s = st(i), c = STATE[s], card = cards[i], y0 = up ? A - STEM - card.h : A + STEM, cxl = clamp(x - cw / 2, 4, W - cw - 4);
      const stem = `<line x1="${f(x)}" x2="${f(x)}" y1="${A}" y2="${up ? A - STEM : A + STEM}" stroke="${c.c}" stroke-width="1.6"${s === "next" ? ' stroke-dasharray="3 3"' : ""}/>`;
      const box = `<rect x="${f(cxl)}" y="${f(y0)}" width="${cw}" height="${card.h}" rx="10" fill="${s === "now" ? C.bT : C.white}" stroke="${s === "now" ? C.blue2 : C.line}" stroke-width="1.3"/><rect x="${f(cxl)}" y="${f(y0 + 8)}" width="3.5" height="${card.h - 16}" rx="1.75" fill="${c.c}"/>`;
      let yy = y0 + 14;
      const date = `<text x="${f(cxl + 14)}" y="${f(yy)}" dy=".35em" font-size="11" font-weight="800" letter-spacing=".03em" fill="${c.ink}">${esc(m.date)}</text>`; yy += 15;
      const title = `<text font-size="13" font-weight="750" fill="${C.ink}">${card.t.lines.map((l, k) => `<tspan x="${f(cxl + 14)}" y="${f(yy + 8 + k * 16)}" dy=".35em">${esc(l)}</tspan>`).join("")}</text>`; yy += card.t.lines.length * 16 + 4;
      const desc = card.d ? `<text font-size="11.5" font-weight="500" fill="${C.muted}">${card.d.lines.map((l, k) => `<tspan x="${f(cxl + 14)}" y="${f(yy + 7 + k * 14)}" dy=".35em">${esc(l)}</tspan>`).join("")}</text>` : "";
      const dot = s === "done" ? `<circle cx="${f(x)}" cy="${A}" r="10" fill="${C.green2}" stroke="#fff" stroke-width="2.5"/><path d="M${f(x - 4)},${A + 0.5}l3 3l5-6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
        : s === "now" ? `<circle cx="${f(x)}" cy="${A}" r="17" fill="${C.blue}" fill-opacity=".16"/><circle cx="${f(x)}" cy="${A}" r="10" fill="#fff" stroke="${C.blue}" stroke-width="3.6"/>`
        : `<circle cx="${f(x)}" cy="${A}" r="8" fill="#fff" stroke="#aeb8b3" stroke-width="3"/>`;
      return `${stem}${box}${date}${title}${desc}${dot}`;
    }).join("");
    let flag = "";
    if (todayX !== null) flag = pill(todayX, onMilestone ? A + (nowIdx % 2 === 0 ? 27 : -27) : A, T("Today", "오늘"), { fill: C.ink, stroke: C.ink, ink: C.white, size: 10.5, h: 18 }).svg;
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${shell(uid, W, H, "", `${axis}${items}${flag}`)}`;
  },
  summary: b => sentence([`${b.title ?? "Timeline"}, ${b.milestones.length} milestones:`, ...b.milestones.map(m => `${m.date} ${m.title} (${m.status ?? "next"}).`)]),
  css: shellCss("milestone_timeline"),
});

/* ===================================================== funnel_flow ===================================================== */
export const funnelFlow = defineAsset({
  type: "funnel_flow", category: "diagram", width: "full",
  use: "A left-to-right pipeline of stages as connected blocks with the count in each, the drop-off percentage on each connector and a stub for what was lost (acquisition, sales pipeline).",
  useKo: "단계별 인원·건수를 연결된 블록으로 나열하고 연결선에 이탈률, 아래에 이탈 수를 보여주는 좌→우 파이프라인(획득, 영업 파이프라인)입니다.",
  tags: ["funnel", "pipeline", "conversion", "drop-off", "sales", "acquisition", "stages", "깔때기", "퍼널", "전환율", "이탈", "영업 파이프라인"],
  notes: "3 to 7 stages in order with the count that reached each; the drop-off is computed from the counts. unit sets the number format (count by default); lost names the lost branch.",
  fields: { stages: list(z.object({ label: text(28), count: num }).strip(), 3, 7), unit: unit.default("count"), lost: optionalText(24) },
  sample: {
    title: "Sales pipeline, Q3",
    unit: "count",
    lost: "Dropped",
    stages: [{ label: "Leads", count: 12400 }, { label: "Qualified", count: 5120 }, { label: "Demo held", count: 2300 }, { label: "Proposal sent", count: 1150 }, { label: "Closed won", count: 460 }],
  },
  render(b, { uid, ko, T }) {
    const st = b.stages, n = st.length, max = Math.max(...st.map(s => s.count), 1), bw = clamp(Math.floor((860 - (n - 1) * 66) / n), 104, 156), gap = 66, W = n * bw + (n - 1) * gap + 40, X0 = 20;
    const fmt = (v: number) => (b.unit === "count" || b.unit === "text" ? short(v) : canvasFormat(v, b.unit, ko));
    const hOf = (v: number) => even(72 + 40 * clamp(v / max, 0, 1)), hMax = hOf(max), CY = 20 + hMax / 2, base = CY + hMax / 2;
    const pct = (v: number) => `${Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)}%`.replace(".0%", "%");
    const blocks = st.map((s, i) => {
      const x = X0 + i * (bw + gap), h = hOf(s.count), color = i === n - 1 ? C.green : ramp(i, Math.max(2, n - 1)), t = wrap(s.label, bw - 20, 2, 12, true), ch = 26 + t.lines.length * 15, top = CY - ch / 2;
      return `<rect x="${f(x)}" y="${f(CY - h / 2)}" width="${bw}" height="${h}" rx="14" fill="${color}"/>${lines([fmt(s.count)], x + bw / 2, top + 11, { size: 19, weight: 800, fill: C.white })}${lines(t.lines, x + bw / 2, top + 26 + (t.lines.length * 15) / 2, { size: 12, weight: 650, fill: "#fff", lh: 15 })}`;
    }).join("");
    const links = st.slice(1).map((s, i) => {
      const prev = st[i], x1 = X0 + i * (bw + gap) + bw, x2 = x1 + gap, mid = x1 + gap / 2, lost = prev.count - s.count, drop = prev.count > 0 ? (lost / prev.count) * 100 : 0;
      const line = `<line x1="${f(x1 + 2)}" x2="${f(x2 - 1)}" y1="${CY}" y2="${CY}" stroke="${C.edge}" stroke-width="1.8" marker-end="url(#${uid}h)"/>`;
      const chip = pill(mid, CY - 17, lost > 0 ? `−${pct(drop)}` : lost < 0 ? `+${pct(Math.abs(drop))}` : "0%", lost > 0 ? { fill: C.rT, stroke: "#efc4c9", ink: C.red, size: 11, h: 19 } : lost < 0 ? { fill: C.gT, stroke: "#b9e0cf", ink: C.green, size: 11, h: 19 } : { fill: C.nT, stroke: C.soft, ink: C.muted, size: 11, h: 19 }).svg;
      const stub = lost > 0 ? `<path d="M${f(mid)},${CY + 3}L${f(mid)},${f(base + 20)}" fill="none" stroke="${C.red}" stroke-width="1.6" stroke-dasharray="3 3" marker-end="url(#${uid}l)"/>${lines([`−${fmt(lost)}`], mid, base + 40, { size: 12.5, weight: 800, fill: C.red })}${lines([wrap(b.lost ?? T("lost", "이탈"), gap + bw * 0.6, 1, 11, false).lines[0]], mid, base + 55, { size: 11, weight: 500, fill: C.muted })}` : "";
      return `${line}${chip}${stub}`;
    }).join("");
    const overall = st[0].count > 0 ? (st[n - 1].count / st[0].count) * 100 : 0, lx = X0 + (n - 1) * (bw + gap) + bw / 2;
    const total = lines([`${pct(overall)} ${T("of", "/")} ${wrap(st[0].label, 90, 1, 11).lines[0]}`], lx, base + 22, { size: 11.5, weight: 700, fill: C.green });
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${shell(uid, W, base + 72, `${arrow(`${uid}h`, C.edge)}${arrow(`${uid}l`, C.red)}`, `${blocks}${links}${total}`)}`;
  },
  summary(b) {
    const st = b.stages, fmt = (v: number) => (b.unit === "count" || b.unit === "text" ? short(v) : canvasFormat(v, b.unit, false));
    const steps = st.map((s, i) => `${s.label} ${fmt(s.count)}${i && st[i - 1].count > 0 ? ` (${(((st[i - 1].count - s.count) / st[i - 1].count) * 100).toFixed(0)}% dropped)` : ""}`).join(" → ");
    return sentence([`${b.title ?? "Funnel"}:`, `${steps}.`, st[0].count > 0 ? `Overall ${((st[st.length - 1].count / st[0].count) * 100).toFixed(1)}% convert.` : ""]);
  },
  css: shellCss("funnel_flow"),
});

export const ASSETS: readonly AnyAsset[] = [processSteps, cycleDiagram, milestoneTimeline, funnelFlow];
