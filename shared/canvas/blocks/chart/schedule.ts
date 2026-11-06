import { z } from "zod";
import { canvasDay, esc } from "../../kit";
import { date, list, num, optionalNum, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { BLUE, GREEN, GREY, ORANGE, cap, cmp, css, frame, p } from "./_cartesian";

const DAY = 864e5, ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`), iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const monthName = (t: number, ko: boolean, year = false) => { const d = new Date(t), yy = String(d.getUTCFullYear()).slice(2); return ko ? `${year ? `${yy}년 ` : ""}${d.getUTCMonth() + 1}월` : `${d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}${year ? ` '${yy}` : ""}`; };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Daily order counts for the sample: weekdays busier than weekends, a rising trend and a steady pseudo-random wobble (real answers supply their own). */
const SAMPLE_DAYS = (() => {
  let seed = 17;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: number[] = [];
  for (let i = 0, day = new Date(Date.UTC(2026, 5, 22)); i < 138; i++, day = new Date(day.getTime() + DAY)) {
    const dow = day.getUTCDay(), base = dow === 0 || dow === 6 ? 9 : dow === 5 ? 27 : 34, growth = 1 + i / 138 * 0.7;
    out.push(i === 12 || i === 77 ? 0 : Math.round(base * growth * (0.55 + rnd() * 0.9)));
  }
  return out;
})();

/* ---------------------------------------------------------- calendar_heatmap */
const CAL = ["#eef0ee", "#cdeedd", "#8fdcb9", "#18b67e", "#0b6b47"];
export const calendarHeatmap = defineAsset({
  type: "calendar_heatmap", category: "chart", width: "half",
  use: "A day-by-day grid of weeks (like a contribution graph) showing how activity or volume varies across 8 to 26 weeks.",
  useKo: "8~26주 동안 하루 단위 활동량을 주간 격자(기여 그래프 형태)로 보여 줍니다.",
  tags: ["calendar", "heatmap", "contribution", "daily", "activity", "streak", "캘린더", "히트맵", "일별", "활동량"],
  notes: "start is the first day. days is a list of values day by day from start, or of {date, value} for a sparse list (missing days count as 0); up to 400 entries. weeks (8-26) is optional: left out, the grid runs to the last day. valueLabel names the thing counted (orders, commits).",
  fields: { start: date, days: list(z.union([z.object({ date, value: num }).strip(), num]), 1, 400), weeks: optionalNum, valueLabel: optionalText(20), caption: optionalText(120) },
  sample: { title: "Orders per day", start: "", days: SAMPLE_DAYS, valueLabel: "orders", caption: "Weekends run at about a quarter of weekday volume, and the trend is rising." },
  render(b, { ko, T }) {
    const items = b.days as (number | { date: string; value: number })[], start = ms(b.start), dow = new Date(start).getUTCDay(), g0 = start - dow * DAY, vals = new Map<number, number>();
    items.forEach((it, i) => { if (typeof it === "number") vals.set(dow + i, it); else { const off = Math.round((ms(it.date) - g0) / DAY); if (off >= dow) vals.set(off, it.value); } });
    const last = Math.max(dow, ...vals.keys()), weeks = b.weeks !== undefined ? clamp(Math.round(b.weeks), 8, 26) : clamp(Math.ceil((last + 1) / 7), 8, 26), end = b.weeks !== undefined ? weeks * 7 - 1 : Math.min(last, weeks * 7 - 1);
    const W = 460, L = 28, top = 20, step = clamp(Math.floor((W - L - 4) / weeks), 14, 20), cell = step - 3, H = top + 7 * step + 2;
    const pos = [...vals.entries()].filter(([o, v]) => o >= dow && o <= end && v > 0).map(([, v]) => v).sort((a, c) => a - c), q = (f: number) => pos[Math.min(pos.length - 1, Math.floor(pos.length * f))] ?? 0, t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
    const level = (v: number) => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4), noun = b.valueLabel ?? T("value", "값");
    let cells = "", total = 0, active = 0, best = { v: 0, o: dow };
    for (let o = dow; o <= end; o++) {
      const v = vals.get(o) ?? 0, col = Math.floor(o / 7), row = o % 7, day = g0 + o * DAY;
      total += v; if (v > 0) active++; if (v > best.v) best = { v, o };
      cells += `<rect x="${L + col * step}" y="${top + row * step}" width="${cell}" height="${cell}" rx="3" fill="${CAL[level(v)]}"><title>${esc(canvasDay(iso(day), ko))}: ${esc(cmp(v))} ${esc(noun)}</title></rect>`;
    }
    let months = "", lastX = -99;
    for (let col = 0; col * 7 <= end; col++) {
      let label = "";
      for (let r = 0; r < 7; r++) { const o = col * 7 + r; if (o >= dow && o <= end && (new Date(g0 + o * DAY).getUTCDate() === 1 || o === dow)) { label = monthName(g0 + o * DAY, ko); break; } }
      const x = L + col * step;
      if (label && x - lastX >= 30) { months += `<text x="${x}" y="12" class="a-ax">${esc(label)}</text>`; lastX = x; }
      else if (label && lastX === L) { months = `<text x="${x}" y="12" class="a-ax">${esc(label)}</text>`; lastX = x; }
    }
    const days = [[1, T("Mon", "월")], [3, T("Wed", "수")], [5, T("Fri", "금")]].map(([r, d]) => `<text x="0" y="${top + (r as number) * step + cell - 2}" class="a-ax">${esc(String(d))}</text>`).join("");
    const key = `<span class="a-ky">${esc(T("Less", "적음"))}${CAL.map(c => `<i style="background:${c}"></i>`).join("")}${esc(T("More", "많음"))}</span>`;
    const stats = `<div class="a-st"><span><b>${esc(cmp(total))}</b> ${esc(noun)}</span><span><b>${esc(cmp(best.v))}</b> ${esc(T("best day", "최고 하루"))} · ${esc(canvasDay(iso(g0 + best.o * DAY), ko))}</span><span><b>${active}</b>/${end - dow + 1} ${esc(T("active days", "활동일"))}</span>${key}</div>`;
    return frame(b, `<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true">${months}${days}${cells}</svg>${stats}`);
  },
  summary: b => { const items = b.days as (number | { value: number })[], vs = items.map(i => (typeof i === "number" ? i : i.value)), total = vs.reduce((s, v) => s + v, 0); return cap(`${b.title ?? "Calendar heatmap"}: ${cmp(total)} ${b.valueLabel ?? "total"} from ${b.start}, ${vs.filter(v => v > 0).length} active days of ${vs.length}, best day ${cmp(Math.max(...vs))}.`); },
  css: css("calendar_heatmap", "@ svg{max-width:640px}@ .a-ax{font-size:11px;font-weight:600;fill:#7a8682}@ .a-st{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin-top:10px;font-size:12.5px;font-weight:600;color:#5c6870}@ .a-st b{font-weight:780;color:#101d24}@ .a-ky{display:inline-flex;align-items:center;gap:3px;margin-left:auto;font-size:11.5px;color:#7a8682}@ .a-ky i{display:inline-block;width:11px;height:11px;border-radius:3px}@ .a-ky i:first-of-type{margin-left:4px}@ .a-ky i:last-of-type{margin-right:4px}@ .a-cap{margin:8px 0 0;font-size:13px;line-height:19px;color:#5c6870}", false),
});

/* --------------------------------------------------------------- gantt_chart */
const GROUPS = [BLUE, GREEN, ORANGE, "#7aa2ff", GREY];
export const ganttChart = defineAsset({
  type: "gantt_chart", category: "chart", width: "full",
  use: "A schedule of tasks as bars on a date axis, grouped into phases, with optional progress, milestone diamonds and a today marker.",
  useKo: "작업 일정을 날짜 축 위의 막대로 보여 줍니다(단계별 묶음, 진행률, 마일스톤 다이아몬드, 오늘 표시 선택).",
  tags: ["gantt", "schedule", "timeline", "project plan", "milestone", "roadmap", "간트", "일정", "프로젝트 계획", "마일스톤"],
  notes: "tasks 2-14 (label, start, end inclusive, optional group and progress 0-100), grouped by first appearance; up to 6 milestones (label, date); today is a date. The axis fits the earliest start to the latest end.",
  fields: { tasks: list(z.object({ label: text(32), start: date, end: date, group: optionalText(24), progress: optionalNum }).strip(), 2, 14), milestones: z.preprocess(v => (v === null ? undefined : v), list(z.object({ label: text(28), date }).strip(), 1, 6).optional()), today: z.preprocess(v => (v === null || v === "" ? undefined : v), date.optional()), caption: optionalText(120) },
  sample: {
    title: "Mobile launch plan", today: "",
    tasks: [
      { label: "User research", start: "", end: "", group: "Discovery", progress: 100 }, { label: "Scope and specification", start: "", end: "", group: "Discovery", progress: 100 },
      { label: "Backend API", start: "", end: "", group: "Build", progress: 55 }, { label: "Mobile app", start: "", end: "", group: "Build", progress: 35 }, { label: "Admin console", start: "", end: "", group: "Build", progress: 10 },
      { label: "QA and security review", start: "", end: "", group: "Launch" }, { label: "Beta rollout", start: "", end: "", group: "Launch" },
    ],
    milestones: [{ label: "Design freeze", date: "" }, { label: "Beta opens", date: "" }, { label: "General availability", date: "" }],
    caption: "Build is the critical path; beta opens on December 14.",
  },
  render(b, { ko, T }) {
    type Task = { label: string; start: string; end: string; group?: string; progress?: number };
    const tasks = (b.tasks as Task[]).map(t => (ms(t.end) < ms(t.start) ? { ...t, start: t.end, end: t.start } : t)), miles = (b.milestones ?? []) as { label: string; date: string }[];
    const lo = Math.min(...tasks.map(t => ms(t.start)), ...miles.map(m => ms(m.date))), hi = Math.max(...tasks.map(t => ms(t.end) + DAY), ...miles.map(m => ms(m.date) + DAY)), pad = Math.max(DAY, (hi - lo) * 0.02), t0 = lo - pad, t1 = hi + pad, span = t1 - t0;
    const X = (t: number) => ((t - t0) / span) * 100, days = span / DAY;
    const order: string[] = []; for (const t of tasks) if (!order.includes(t.group ?? "")) order.push(t.group ?? "");
    // Axis ticks: Mondays for a short plan, month starts for a longer one, thinned to at most seven.
    let ticks: number[] = [];
    if (days <= 70) { let d = t0; while (new Date(d).getUTCDay() !== 1) d += DAY; for (; d < t1; d += 7 * DAY) ticks.push(d); }
    else { const d0 = new Date(t0); for (let y = d0.getUTCFullYear(), m = d0.getUTCMonth(); Date.UTC(y, m, 1) < t1; m++) { if (m > 11) { m = 0; y++; } const t = Date.UTC(y, m, 1); if (t >= t0) ticks.push(t); } }
    const keep = Math.ceil(ticks.length / 7); ticks = ticks.filter((_, i) => i % keep === 0);
    const rows: { kind: "head" | "task" | "mile"; label: string; g: number; t?: Task; m?: { label: string; date: string } }[] = [];
    order.forEach((g, gi) => { if (g) rows.push({ kind: "head", label: g, g: gi }); tasks.filter(t => (t.group ?? "") === g).forEach(t => rows.push({ kind: "task", label: t.label, g: gi, t })); });
    if (miles.length) { rows.push({ kind: "head", label: T("Milestones", "마일스톤"), g: -1 }); miles.forEach(m => rows.push({ kind: "mile", label: m.label, g: -1, m })); }
    const today = b.today && ms(b.today) >= t0 && ms(b.today) < t1 ? ms(b.today) : null, n = rows.length;
    const grid = ticks.map(t => `<u class="a-gl" style="left:${p(X(t))}%"></u>`).join("") + (today !== null ? `<u class="a-tn" style="left:${p(X(today) + 50 / days)}%"></u>` : "");
    const first = ticks.length && X(ticks[0]) > 14 ? `<span class="a-tk" style="left:0">${esc(days <= 70 ? canvasDay(iso(lo), ko) : monthName(lo, ko))}</span>` : "", axis = first + ticks.filter(t => X(t) <= (days <= 70 ? 86 : 92)).map(t => `<span class="a-tk" style="left:${p(X(t))}%">${esc(days <= 70 ? canvasDay(iso(t), ko) : monthName(t, ko, days > 330 && (new Date(t).getUTCMonth() === 0 || t === ticks[0])))}</span>`).join("") + (today !== null ? `<u class="a-tn a-th" style="left:${p(X(today) + 50 / days)}%"></u><b class="a-tt" style="left:${p(X(today) + 50 / days)}%">${esc(T("Today", "오늘"))}</b>` : "");
    const body = rows.map(r => {
      if (r.kind === "head") return `<div class="a-gh">${esc(r.label)}</div>`;
      if (r.kind === "mile") { const x = X(ms(r.m!.date) + DAY / 2), right = x > 78; return `<div class="a-gn a-ind" title="${esc(r.label)}">${esc(r.label)}</div><div class="a-tr"><i class="a-dm" style="left:${p(x)}%"></i><small class="a-md" style="${right ? `right:${p(100 - x)}%;margin-right:12px` : `left:${p(x)}%;margin-left:12px`}">${esc(canvasDay(r.m!.date, ko))}</small></div>`; }
      const t = r.t!, color = GROUPS[r.g % 5] ?? BLUE, l = X(ms(t.start)), w = Math.max(0.8, X(ms(t.end) + DAY) - l), pr = t.progress === undefined ? null : clamp(t.progress, 0, 100);
      return `<div class="a-gn${order.length > 1 || order[0] ? " a-ind" : ""}" title="${esc(r.label)}">${esc(r.label)}</div><div class="a-tr"><i class="a-bar" style="left:${p(l)}%;width:${p(w)}%;background:${color}" title="${esc(canvasDay(t.start, ko))} – ${esc(canvasDay(t.end, ko))}${pr === null ? "" : ` · ${Math.round(pr)}%`}">${pr === null ? "" : `<s style="width:${p(pr)}%"></s>`}</i></div>`;
    }).join("");
    return frame(b, `<div class="a-gt" style="grid-template-rows:${today !== null ? 40 : 24}px repeat(${n},28px)"><div></div><div class="a-xs">${axis}</div><div class="a-ov">${grid}</div>${body}</div>`);
  },
  summary: b => { const tasks = b.tasks as { label: string; start: string; end: string }[], from = tasks.map(t => t.start).sort()[0], to = tasks.map(t => t.end).sort().reverse()[0]; return cap(`${b.title ?? "Gantt chart"}: ${tasks.length} tasks from ${from} to ${to}${(b.milestones ?? []).length ? `; milestones ${(b.milestones as { label: string; date: string }[]).map(m => `${m.label} ${m.date}`).join(", ")}` : ""}.`); },
  css: css("gantt_chart", "@ .a-gt{display:grid;grid-template-columns:minmax(96px,30%) minmax(0,1fr);position:relative;--g:#eceeec}@ .a-xs{position:relative}@ .a-tk{position:absolute;bottom:3px;padding-left:5px;font-size:11px;font-weight:600;color:#7a8682;white-space:nowrap}@ .a-tt{position:absolute;top:0;transform:translateX(-50%);padding:1px 7px;border-radius:9px;background:#cf3545;color:#fff;font-size:10.5px;font-weight:750}@ .a-ov{position:absolute;grid-column:2;grid-row:2/-1;top:0;bottom:0;left:0;right:0;pointer-events:none}@ .a-gl{position:absolute;top:0;bottom:0;width:1px;background:var(--g)}@ .a-tn{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#cf3545;opacity:.8}@ .a-th{top:16px}@ .a-gh{grid-column:1/-1;display:flex;align-items:flex-end;padding-bottom:3px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#5c6870}@ .a-gn{align-self:center;padding-right:10px;font-size:13px;font-weight:650;color:#34424a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@ .a-ind{padding-left:8px}@ .a-tr{position:relative;align-self:stretch}@ .a-bar{position:absolute;top:7px;height:14px;border-radius:7px;overflow:hidden;opacity:.95}@ .a-bar s{position:absolute;left:0;top:0;bottom:0;background:rgba(16,29,36,.28)}@ .a-dm{position:absolute;top:8px;width:12px;height:12px;margin-left:-6px;transform:rotate(45deg);border-radius:2px;background:#101d24}@ .a-md{position:absolute;top:7px;font-size:11.5px;font-weight:650;color:#5c6870;white-space:nowrap}@ .a-cap{margin:10px 0 0;font-size:13px;line-height:19px;color:#5c6870}", false),
});

export const ASSETS: readonly AnyAsset[] = [calendarHeatmap, ganttChart];
