import { z } from "zod";
import { esc } from "../../kit";
import { list, loose, optionalNum, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { CHIP, RGB, cap, chip, clamp, css, fit, hash, hue, initials, longDay, shortDay, type Hue } from "./_shared";

/** Tables of work in motion: a day's schedule, project status, the people on a team, and what changed in each release. */

// ---- schedule_table ---------------------------------------------------------------------------------------------------------------------
/** "09:30", "9:30 pm", "T14:00" or 9.5 as minutes after midnight; anything else stays unread and the block is refused. */
function readTime(v: unknown): unknown {
  if (typeof v === "number") return v >= 0 && v <= 24 ? Math.round(v * 60) : v;
  if (typeof v !== "string") return v;
  const iso = v.match(/T(\d{2}):(\d{2})/), clock = v.match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i), hour = v.match(/^\s*(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\s*$/i);
  const [h, m, ap] = iso ? [iso[1], iso[2], ""] : clock ? [clock[1], clock[2], clock[3] ?? ""] : hour ? [hour[1], "0", hour[2]] : [];
  if (h === undefined) return Number.NaN;
  let hh = Number(h);
  if (/^p/i.test(ap ?? "") && hh < 12) hh += 12;
  if (/^a/i.test(ap ?? "") && hh === 12) hh = 0;
  return hh * 60 + Number(m);
}
const minute = z.preprocess(readTime, z.number().int().min(0).max(1440));
const endMinute = z.preprocess(v => (v === null || v === "" ? undefined : readTime(v)), z.number().int().min(0).max(1440).optional());
const hm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const event = z.object({ title: text(48), track: optionalText(20), start: minute, end: endMinute, place: optionalText(24) }).strip();
const TRACK_HUES: Hue[] = ["b", "g", "a"];

export const scheduleTable = defineAsset({
  type: "schedule_table", category: "table", width: "full",
  use: "A day or week schedule as a time grid (time slots down, tracks or days across, event blocks with titles), or as a plain agenda list.",
  useKo: "하루·한 주 일정을 시간 격자(시간대 세로, 트랙·요일 가로, 일정 블록)나 단순 아젠다 목록으로 보여줍니다.",
  tags: ["schedule", "agenda", "timetable", "calendar", "time grid", "program", "일정", "시간표", "아젠다", "프로그램", "세션"],
  notes: "events: { title, track, start, end, place }; times like 09:30 or 2:30 pm. tracks are the columns (rooms, days); an event's track picks its column. mode \"agenda\" draws a list instead of the grid. On a narrow screen the grid becomes the agenda.",
  fields: { mode: loose(["grid", "agenda"], { list: "agenda", timetable: "grid", calendar: "grid", table: "grid" }, "grid").optional(), tracks: list(text(20), 1, 5).optional(), events: list(event, 1, 14), caption: optionalText(140) },
  sample: {
    title: "Launch day program · Thursday, Oct 15",
    tracks: ["Main stage", "Workshop A", "Workshop B"],
    events: [
      { title: "Opening keynote", track: "Main stage", start: "09:00", end: "09:45", place: "Hall 1" },
      { title: "Product roadmap", track: "Main stage", start: "10:00", end: "10:30" },
      { title: "Customer panel", track: "Main stage", start: "11:00", end: "12:00" },
      { title: "Live demo: what is new", track: "Main stage", start: "13:30", end: "14:30" },
      { title: "Closing Q&A", track: "Main stage", start: "15:30", end: "16:15" },
      { title: "Design systems at scale", track: "Workshop A", start: "09:30", end: "10:30", place: "Room 2" },
      { title: "Security deep dive", track: "Workshop A", start: "11:00", end: "12:30" },
      { title: "Data modelling lab", track: "Workshop A", start: "14:00", end: "15:30" },
      { title: "Hands-on: automations", track: "Workshop B", start: "10:00", end: "11:30", place: "Room 3" },
      { title: "Integrations clinic", track: "Workshop B", start: "13:30", end: "15:00" },
    ],
    caption: "Lunch is served from 12:30 to 13:30 in the atrium.",
  },
  render(b, { T }) {
    const tracks = b.tracks ?? ([...new Set(b.events.map(e => e.track).filter((t): t is string => Boolean(t)))].slice(0, 5));
    const names = tracks.length ? tracks : [""];
    const ev = b.events.map(e => {
      const i = e.track ? names.findIndex(t => t.toLowerCase() === e.track!.toLowerCase()) : 0;
      return { ...e, ti: Math.max(0, i), e: Math.min(1440, Math.max(e.start + 15, e.end ?? e.start + 60)) };
    });
    const lo = Math.floor(Math.min(...ev.map(e => e.start)) / 60) * 60, hi = Math.max(lo + 60, Math.ceil(Math.max(...ev.map(e => e.e)) / 60) * 60);
    const span = hi - lo, ppm = span <= 600 ? 0.95 : span <= 840 ? 0.75 : 0.55, H = Math.round(span * ppm);
    const hueOf = (i: number) => hue(TRACK_HUES[i % 3]);
    // Overlaps in one column sit side by side; more than a column can hold turns the block into the agenda list.
    const lanes = (ti: number) => { const ends: number[] = []; for (const e of ev.filter(x => x.ti === ti).sort((a, c) => a.start - c.start || a.e - c.e)) { const k = ends.findIndex(end => end <= e.start); ends[k < 0 ? ends.length : k] = e.e; } return ends.length; };
    const crowded = Math.max(...names.map((_, ti) => lanes(ti))) > (names.length >= 4 ? 2 : 3), agendaOnly = b.mode === "agenda" || crowded;
    const cols = names.map((_, ti) => {
      // Events that overlap in one column sit side by side.
      const mine = ev.filter(e => e.ti === ti).sort((a, c) => a.start - c.start || a.e - c.e), ends: number[] = [], lane = new Map<(typeof mine)[number], number>();
      for (const e of mine) { let k = ends.findIndex(end => end <= e.start); if (k < 0) k = ends.length; ends[k] = e.e; lane.set(e, k); }
      const n = Math.max(1, ends.length);
      return mine.map(e => {
        const h = Math.max(18, (e.e - e.start) * ppm - 2), time = h >= 40, lines = clamp(Math.floor((h - 10 - (time ? 16 : 0)) / 16), 1, 3);
        return `<div class="a-ev" style="--c:${RGB[TRACK_HUES[ti % 3]]};--l:${lines};top:${((e.start - lo) * ppm).toFixed(1)}px;height:${h.toFixed(1)}px;left:${((lane.get(e)! / n) * 100).toFixed(2)}%;width:${(100 / n).toFixed(2)}%"><b>${esc(e.title)}</b>${time ? `<span>${hm(e.start)}–${hm(e.e)}${e.place ? ` · ${esc(e.place)}` : ""}</span>` : ""}</div>`;
      }).join("");
    });
    const labels = Array.from({ length: span / 60 }, (_, i) => `<span style="top:${(i * 60 * ppm).toFixed(1)}px">${hm(lo + i * 60)}</span>`).join("");
    const grid = `<div class="a-gr" style="--n:${names.length}"><span></span>${names.map((t, i) => `<div class="a-hd" ${hueOf(i)}>${esc(t)}</div>`).join("")}<div class="a-tm" style="height:${H}px">${labels}</div>${cols.map(c => `<div class="a-tk" style="height:${H}px;--h:${(60 * ppm).toFixed(1)}px">${c}</div>`).join("")}</div>`;
    const groups = names.map((t, ti) => ({ t, ti, items: ev.filter(e => e.ti === ti).sort((a, c) => a.start - c.start) })).filter(g => g.items.length);
    const agenda = `<div class="a-ag${agendaOnly ? "" : " a-alt"}">${groups.map(g => `${names.length > 1 ? `<div class="a-hd" style="--c:${RGB[TRACK_HUES[g.ti % 3]]};margin-top:16px">${esc(g.t)}</div>` : ""}${g.items.map(e => `<div class="a-ar" ${hueOf(g.ti)}><span class="a-at">${hm(e.start)}–${hm(e.e)}</span><div><b>${esc(e.title)}</b>${e.place ? esc(e.place) : ""}</div></div>`).join("")}`).join("")}</div>`;
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${agendaOnly ? "" : grid}${agenda}${cap(b.caption)}`;
  },
  summary(b) {
    const first = [...b.events].sort((a, c) => a.start - c.start).slice(0, 4).map(e => `${hm(e.start)} ${e.title}${e.track ? ` (${e.track})` : ""}`);
    return fit(`${b.title ?? "Schedule"}: ${b.events.length} events${b.tracks ? ` across ${b.tracks.join(", ")}` : ""}. ${first.join("; ")}.`);
  },
  css: css("schedule_table", `
    & .a-gr{display:grid;grid-template-columns:44px repeat(var(--n),minmax(0,1fr))}
    & .a-hd{padding:0 8px 10px;border-bottom:2px solid rgb(var(--c));font-size:12.5px;font-weight:700}
    & .a-tm{position:relative}
    & .a-tm span{position:absolute;right:8px;transform:translateY(-50%);font-size:11px;font-weight:600;color:var(--faint)}
    & .a-tk{position:relative;border:solid var(--line);border-width:0 0 1px 1px;background:linear-gradient(var(--line) 1px,transparent 1px) 0 0/100% var(--h)}
    & .a-ev{position:absolute;padding:4px 8px;border-radius:8px;border-left:3px solid rgb(var(--c));background:linear-gradient(rgba(var(--c),.12),rgba(var(--c),.12)) #fff;overflow:hidden;font-size:11.5px;font-weight:600;color:var(--muted)}
    & .a-ev b{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--l);overflow:hidden;font-size:12.5px;font-weight:700;color:var(--ink)}
    & .a-ev span{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    & .a-alt{display:none}
    & .a-ar{display:grid;grid-template-columns:96px 1fr;gap:12px;padding:10px 12px;border-bottom:1px solid #f2f3f1;border-left:3px solid rgb(var(--c));font-size:12.5px;color:var(--muted)}
    & .a-at{font-size:13px;font-weight:700;color:var(--ink2)}
    & .a-ar b{display:block;font-size:14px;color:var(--ink)}
    @container (max-width:560px){& .a-gr{display:none}& .a-alt{display:block}}
  `),
});

// ---- status_table -----------------------------------------------------------------------------------------------------------------------
const STATUS = ["green", "amber", "red", "grey"] as const;
const status = loose([...STATUS] as [string, ...string[]], { on_track: "green", ok: "green", good: "green", done: "green", complete: "green", completed: "green", healthy: "green", at_risk: "amber", risk: "amber", warning: "amber", caution: "amber", yellow: "amber", watch: "amber", delayed: "amber", off_track: "red", blocked: "red", late: "red", critical: "red", bad: "red", behind: "red", not_started: "grey", gray: "grey", paused: "grey", none: "grey", na: "grey", pending: "grey" }, "grey");
const statusItem = z.object({ name: text(48), status, label: optionalText(18), owner: optionalText(24), due: optionalText(16), progress: optionalNum }).strip();
const STATUS_HUE: Record<string, Hue> = { green: "g", amber: "a", red: "r", grey: "n" };
const STATUS_WORD: Record<string, [string, string]> = { green: ["On track", "정상"], amber: ["At risk", "주의"], red: ["Off track", "지연"], grey: ["Not started", "대기"] };

export const statusTable = defineAsset({
  type: "status_table", category: "table", width: "full",
  use: "Project or workstream status: a red, amber or green dot with a label, owner, due date and a progress bar per row, under a strip counting each status.",
  useKo: "프로젝트·업무 현황: 행마다 빨강·주황·초록 점과 상태, 담당자, 마감일, 진행 막대를 보이고 위에 상태별 개수를 요약합니다.",
  tags: ["status", "rag", "red amber green", "tracker", "progress", "projects", "owner", "due", "현황", "상태", "진행", "트래커", "담당자", "마감"],
  notes: "status: green, amber, red or grey (on_track, at_risk, off_track, not_started are read too); label overrides the word shown. progress is 0-100; due is a date or short text. The count strip is computed.",
  fields: { items: list(statusItem, 1, 12), caption: optionalText(140) },
  sample: {
    title: "Q4 launch: workstream status",
    items: [
      { name: "Pricing and packaging", status: "green", owner: "Dana Kim", due: "", progress: 100 },
      { name: "Onboarding flow redesign", status: "green", owner: "Marcus Lee", due: "", progress: 82 },
      { name: "Billing migration", status: "amber", label: "At risk", owner: "Priya Nair", due: "", progress: 55 },
      { name: "Partner integrations", status: "amber", owner: "Tomas Rivera", due: "", progress: 40 },
      { name: "Security review", status: "red", label: "Blocked", owner: "Sofia Alvarez", due: "", progress: 30 },
      { name: "Launch campaign", status: "green", owner: "Jin Park", due: "", progress: 64 },
      { name: "Help center content", status: "grey", owner: "Ana Costa", due: "", progress: 0 },
    ],
  },
  render(b, { ko, T }) {
    const counts = STATUS.map(s => ({ s, n: b.items.filter(i => i.status === s).length })).filter(c => c.n > 0);
    const hasO = b.items.some(i => i.owner), hasD = b.items.some(i => i.due), hasP = b.items.some(i => typeof i.progress === "number");
    const k = ["minmax(0,2.2fr)", "128px", ...(hasO ? ["minmax(0,1fr)"] : []), ...(hasD ? ["76px"] : []), ...(hasP ? ["112px"] : [])].join(" ");
    const word = (s: string) => T(...STATUS_WORD[s]);
    const strip = `<div class="a-cn">${counts.map(c => `<div class="a-ct" ${hue(STATUS_HUE[c.s])}><b>${c.n}</b>${esc(word(c.s))}</div>`).join("")}</div>`;
    const head = `<div class="a-rw a-rh"><span class="a-n">${T("Item", "항목")}</span><span class="a-s">${T("Status", "상태")}</span>${hasO ? `<span class="a-o">${T("Owner", "담당")}</span>` : ""}${hasD ? `<span class="a-d">${T("Due", "마감")}</span>` : ""}${hasP ? `<span class="a-p">${T("Progress", "진행")}</span>` : ""}</div>`;
    const rows = b.items.map(i => {
      const p = typeof i.progress === "number" ? clamp(i.progress, 0, 100) : null;
      return `<div class="a-rw"><span class="a-n">${esc(i.name)}</span><span class="a-s"><i class="a-dt" ${hue(STATUS_HUE[i.status])}></i>${esc(i.label ?? word(i.status))}</span>${hasO ? `<span class="a-o">${i.owner ? esc(i.owner) : "–"}</span>` : ""}${hasD ? `<span class="a-d">${i.due ? esc(shortDay(i.due, ko)) : "–"}</span>` : ""}${hasP ? `<span class="a-p">${p === null ? "–" : `<i class="a-pb" style="--c:${RGB[STATUS_HUE[i.status]]};--p:${p}%"></i><b>${Math.round(p)}%</b>`}</span>` : ""}</div>`;
    }).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${strip}<div class="a-tb" style="--k:${k}">${head}${rows}</div>${cap(b.caption)}`;
  },
  summary(b) {
    const c = STATUS.map(s => [s, b.items.filter(i => i.status === s).length] as const).filter(([, n]) => n);
    return fit(`${b.title ?? "Status"}: ${c.map(([s, n]) => `${n} ${STATUS_WORD[s][0].toLowerCase()}`).join(", ")}. ${b.items.slice(0, 6).map(i => `${i.name} ${i.label ?? STATUS_WORD[i.status][0].toLowerCase()}${typeof i.progress === "number" ? ` ${Math.round(i.progress)}%` : ""}`).join("; ")}.`);
  },
  css: css("status_table", `
    & .a-cn{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
    & .a-ct{display:flex;align-items:baseline;gap:8px;padding:9px 16px;border-radius:12px;background:rgba(var(--c),.1);font-size:13px;font-weight:650;color:rgb(var(--c))}
    & .a-ct b{font-size:22px;line-height:1;font-weight:800}
    & .a-rw{display:grid;grid-template-columns:var(--k);gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid #f2f3f1;font-size:13.5px;font-weight:600;color:#34424a}
    & .a-rh{padding:0 0 9px;border-color:#eceeec}
    & .a-rh span{font-size:12px;font-weight:700;color:#7a8682}
    & .a-n{font-weight:700;color:var(--ink)}
    & .a-s,& .a-p{display:flex;align-items:center;gap:8px}
    & .a-dt{flex:none;width:9px;height:9px;border-radius:50%;background:rgb(var(--c))}
    & .a-pb{width:56px;height:6px;border-radius:3px;background:linear-gradient(90deg,rgb(var(--c)) var(--p),#e9ecea var(--p))}
    @container (max-width:560px){& .a-rh{display:none}& .a-rw{grid-template-columns:minmax(0,1.2fr) minmax(0,.7fr) minmax(0,1.1fr);row-gap:6px}& .a-n{grid-column:span 2}}
  `),
});

// ---- roster_table -----------------------------------------------------------------------------------------------------------------------
const person = z.object({ name: text(32), role: optionalText(32), team: optionalText(24), status: optionalText(16), contact: optionalText(44) }).strip();
const AVATAR = ["47,95,214", "17,133,88", "183,121,31", "214,51,108", "124,58,237", "14,143,134"];
function statusHue(s: string): Hue {
  if (/^(active|online|available|in office|working|재직|근무|활동)/i.test(s)) return "g";
  if (/(away|leave|vacation|ooo|out of office|travel|휴가|부재|자리)/i.test(s)) return "a";
  if (/(busy|dnd|do not disturb|blocked|바쁨|방해)/i.test(s)) return "r";
  if (/(offline|inactive|former|left|퇴사|오프라인|비활성)/i.test(s)) return "n";
  return "b";
}

export const rosterTable = defineAsset({
  type: "roster_table", category: "table", width: "full",
  use: "A list of people with an initials avatar, name, role, team, status chip and contact, for a team, attendee list, owners or a directory.",
  useKo: "사람 목록을 이니셜 아바타, 이름, 역할, 팀, 상태 칩, 연락처로 보여줍니다(팀·참석자·담당자·명단).",
  tags: ["roster", "people", "team", "directory", "members", "staff", "contacts", "avatar", "명단", "팀원", "인원", "연락처", "구성원"],
  notes: "Only name is required. status is free text (Active, Away, On leave ...) drawn as a chip. Columns with no value in any row are left out. The avatar colour comes from the name.",
  fields: { people: list(person, 1, 12), caption: optionalText(140) },
  sample: {
    title: "Product team",
    people: [
      { name: "Dana Kim", role: "Head of Product", team: "Product", status: "Active", contact: "dana.kim@northwind.example" },
      { name: "Marcus Lee", role: "Staff Engineer", team: "Platform", status: "Active", contact: "marcus.lee@northwind.example" },
      { name: "Priya Nair", role: "Product Designer", team: "Design", status: "Away", contact: "priya.nair@northwind.example" },
      { name: "Tomas Rivera", role: "Data Analyst", team: "Insights", status: "On leave", contact: "tomas.rivera@northwind.example" },
      { name: "Sofia Alvarez", role: "Security Engineer", team: "Platform", status: "Busy", contact: "sofia.alvarez@northwind.example" },
      { name: "박지민", role: "Customer Success Lead", team: "Success", status: "Active", contact: "+82 10 5555 0142" },
    ],
  },
  render(b, { T }) {
    const hasT = b.people.some(p => p.team), hasS = b.people.some(p => p.status), hasC = b.people.some(p => p.contact);
    const k = ["minmax(0,2.2fr)", ...(hasT ? ["minmax(0,1fr)"] : []), ...(hasS ? ["104px"] : []), ...(hasC ? ["minmax(0,1.7fr)"] : [])].join(" ");
    const head = `<div class="a-rw a-rh"><span>${T("Person", "이름")}</span>${hasT ? `<span class="a-t">${T("Team", "팀")}</span>` : ""}${hasS ? `<span class="a-s">${T("Status", "상태")}</span>` : ""}${hasC ? `<span class="a-k">${T("Contact", "연락처")}</span>` : ""}</div>`;
    const rows = b.people.map(p => `<div class="a-rw"><span class="a-pp"><i class="a-av" style="--c:${AVATAR[hash(p.name) % AVATAR.length]}">${esc(initials(p.name))}</i><span><b>${esc(p.name)}</b>${p.role ? esc(p.role) : ""}</span></span>${hasT ? `<span class="a-t">${p.team ? esc(p.team) : "–"}</span>` : ""}${hasS ? `<span class="a-s">${p.status ? chip(p.status, statusHue(p.status)) : ""}</span>` : ""}${hasC ? `<span class="a-k">${p.contact ? esc(p.contact) : "–"}</span>` : ""}</div>`).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-tb" style="--k:${k}">${head}${rows}</div>${cap(b.caption)}`;
  },
  summary: b => fit(`${b.title ?? "Roster"}: ${b.people.length} people. ${b.people.slice(0, 8).map(p => `${p.name}${p.role ? `, ${p.role}` : ""}${p.status ? ` (${p.status})` : ""}`).join("; ")}.`),
  css: css("roster_table", CHIP, `
    & .a-rw{display:grid;grid-template-columns:var(--k);gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid #f2f3f1;font-size:13.5px;font-weight:600;color:#34424a}
    & .a-rh{padding:0 0 9px;border-color:#eceeec;font-size:12px;font-weight:700;color:#7a8682}
    & .a-pp{display:flex;align-items:center;gap:12px;min-width:0;font-size:12.5px;color:var(--muted)}
    & .a-pp>span{min-width:0}
    & .a-pp b{display:block;font-size:14.5px;font-weight:700;color:var(--ink)}
    & .a-av{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:rgba(var(--c),.14);color:rgb(var(--c));font-size:13px;font-style:normal;font-weight:800}
    & .a-k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
    @container (max-width:560px){& .a-rh{display:none}& .a-rw{grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);grid-template-areas:"p s" "t k";row-gap:4px}& .a-pp{grid-area:p}& .a-s{grid-area:s}& .a-t{grid-area:t;padding-left:48px}& .a-k{grid-area:k}}
  `),
});

// ---- changelog_table --------------------------------------------------------------------------------------------------------------------
const TYPES = ["new", "improved", "fixed", "removed"] as const;
const changeType = loose([...TYPES] as [string, ...string[]], { added: "new", add: "new", feature: "new", feat: "new", enhanced: "improved", improvement: "improved", change: "improved", changed: "improved", update: "improved", updated: "improved", bugfix: "fixed", fix: "fixed", bug: "fixed", deprecated: "removed", remove: "removed", deleted: "removed", breaking: "removed" }, "improved");
const change = z.object({ type: changeType, text: text(100) }).strip();
const release = z.object({ version: text(14), date: optionalText(16), label: optionalText(16), changes: list(change, 1, 6) }).strip();
const TYPE_HUE: Record<string, Hue> = { new: "g", improved: "b", fixed: "a", removed: "r" };
const TYPE_WORD: Record<string, [string, string]> = { new: ["New", "신규"], improved: ["Improved", "개선"], fixed: ["Fixed", "수정"], removed: ["Removed", "제거"] };

export const changelogTable = defineAsset({
  type: "changelog_table", category: "table", width: "two_thirds",
  use: "Release notes: each release with a version chip, a date and its changes tagged new, improved, fixed or removed in colour.",
  useKo: "릴리스 노트: 릴리스마다 버전 칩, 날짜, 신규·개선·수정·제거 태그가 붙은 변경 목록을 보여줍니다.",
  tags: ["changelog", "release notes", "versions", "updates", "what's new", "history", "변경 내역", "릴리스 노트", "업데이트", "버전", "패치"],
  notes: "type: new, improved, fixed or removed (added, fix, change ... are read too). Newest release first; at most 6 releases of 6 changes. label is a small word beside the version, such as Latest.",
  fields: { releases: list(release, 1, 6), caption: optionalText(140) },
  sample: {
    title: "What changed in Atlas",
    releases: [
      { version: "v2.6.0", date: "", label: "Latest", changes: [{ type: "new", text: "Shared workspaces let a whole team edit one library" }, { type: "improved", text: "Search is about three times faster on large libraries" }, { type: "fixed", text: "Exports no longer drop the last row of a table" }] },
      { version: "v2.5.2", date: "", changes: [{ type: "fixed", text: "Sync no longer stalls after the laptop wakes from sleep" }, { type: "fixed", text: "Opening an empty project could crash the app" }, { type: "improved", text: "Clearer message when a sign-in has expired" }] },
      { version: "v2.5.0", date: "", changes: [{ type: "new", text: "Dark mode, following the system setting" }, { type: "new", text: "Export to CSV and Parquet" }, { type: "removed", text: "The legacy v1 importer; use the migration tool instead" }] },
      { version: "v2.4.0", date: "", changes: [{ type: "improved", text: "Keyboard shortcuts are shown in every menu" }, { type: "fixed", text: "Wrong sort order for dates before 1970" }] },
    ],
  },
  render(b, { ko, T }) {
    const rows = b.releases.map(r => `<div class="a-rl"><div class="a-vh"><span class="a-vc">${esc(r.version)}</span>${r.label ? chip(r.label, "g") : ""}${r.date ? `<span class="a-dd">${esc(longDay(r.date, ko))}</span>` : ""}</div><div class="a-cl">${r.changes.map(c => `<div class="a-ch">${chip(T(...TYPE_WORD[c.type]), TYPE_HUE[c.type], "a-tg")}<span>${esc(c.text)}</span></div>`).join("")}</div></div>`).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-ls">${rows}</div>${cap(b.caption)}`;
  },
  summary: b => fit(`${b.title ?? "Changelog"}: ${b.releases.map(r => `${r.version}${r.date ? ` (${r.date})` : ""}: ${r.changes.map(c => `${c.type} ${c.text}`).slice(0, 2).join(", ")}`).join("; ")}.`),
  css: css("changelog_table", CHIP, `
    & .a-rl{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px 20px;padding:16px 0;border-top:1px solid var(--line)}
    & .a-vh{display:flex;flex-wrap:wrap;align-items:center;align-content:start;gap:6px 8px}
    & .a-vc{padding:3px 10px;border-radius:8px;background:var(--ink);color:#fff;font-size:13px;font-weight:750}
    & .a-dd{flex-basis:100%;font-size:12.5px;font-weight:600;color:var(--muted)}
    & .a-cl{display:grid;gap:9px}
    & .a-ch{display:flex;align-items:flex-start;gap:10px;font-size:13.5px;line-height:22px;font-weight:600;color:#34424a}
    & .a-tg{flex:none;min-width:70px;text-align:center}
    @container (max-width:560px){& .a-rl{grid-template-columns:minmax(0,1fr)}}
  `),
});

export const ASSETS: readonly AnyAsset[] = [scheduleTable, statusTable, rosterTable, changelogTable];
