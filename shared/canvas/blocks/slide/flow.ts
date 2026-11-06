import { z } from "zod";
import { esc } from "../../kit";
import { list, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { ELL, accent, accentHex, body, clamp, head, lighten, linesOf, room, slide, sx } from "./_shared";

/** The slides that lay work out in time and in people: a timeline, a process, a roadmap, a SWOT and a team. */
const asObject = (key: string) => (v: unknown) => (typeof v === "string" ? { [key]: v } : v);

const milestone = z.object({ date: text(14), title: text(36), detail: optionalText(72) }).strip();
type Milestone = { date: string; title: string; detail?: string };
export const timelineSlide = defineAsset({
  type: "timeline_slide", category: "slide", width: "half", frame: "16:9",
  use: "A slide with a horizontal timeline of three to six dated milestones, each with a title and a one-line detail.",
  useKo: "날짜가 붙은 3~6개 이정표를 가로 타임라인으로 보여주는 슬라이드(제목과 한 줄 설명).",
  tags: ["slide", "timeline", "milestones", "history", "schedule", "dates", "슬라이드", "타임라인", "일정", "이정표"],
  notes: "Three to six milestones in order; date is a short label ('Jul 8', 'Q3', '2026'), title at most 36 characters, detail at most 72.",
  fields: { heading: text(64), items: list(milestone, 3, 6), footer: optionalText(48), accent },
  sample: { heading: "Q3 in six milestones", accent: "blue", footer: "Northwind Labs · Q3 review · 11", items: [{ date: "Jul 8", title: "Card-free trial test", detail: "Shown to 10% of new visitors first" }, { date: "Jul 29", title: "Help center relaunch", detail: "Search-first design, 140 new articles" }, { date: "Aug 19", title: "Partner program", detail: "14 agencies signed in three weeks" }, { date: "Sep 3", title: "Team plan beta", detail: "Shared dashboards for 200 accounts" }, { date: "Sep 17", title: "Mobile onboarding", detail: "Setup time cut from 9 to 3 minutes" }, { date: "Sep 30", title: "Record quarter", detail: "31,400 new accounts, up 38% on Q2" }] },
  render(b) {
    // Every block is as wide as its same-side neighbours allow (they stand two dots apart); the end blocks sit flush with the margins.
    const items = b.items as Milestone[], n = items.length, w = Math.min(30, (168 / (n - 1) - 2.4) / (1 + 2 / (n - 1))), step = (84 - w) / (n - 1), [dz, tz, xz] = n <= 4 ? [2.1, 2.7, 2.1] : [1.9, 2.2, 1.8];
    const half = room(b.heading, { footer: !!b.footer }) / 2 - 3.6, maxDetail = n <= 4 ? 3 : 2;
    const marks = items.map((it, i) => {
      const cx = w / 2 + i * step, bw = w, left = cx - w / 2, al = "center", above = i % 2 === 0;
      const tl = Math.min(2, linesOf(it.title, tz, bw)), dl = Math.max(1, Math.min(maxDetail, Math.floor((half - dz * 1.3 - tl * tz * 1.2 - 1) / (xz * 1.4))));
      return `<i class="a-sm" style="left:${cx.toFixed(1)}cqw;${above ? "bottom" : "top"}:50%;height:3.4cqw"></i><i class="a-dt" style="left:${cx.toFixed(1)}cqw"></i><div class="a-m" style="left:${left.toFixed(1)}cqw;width:${bw.toFixed(1)}cqw;text-align:${al};max-height:${half.toFixed(1)}cqw;${above ? "bottom" : "top"}:calc(50% + 3.4cqw)"><b>${esc(it.date)}</b><strong style="${clamp(tl)}">${esc(it.title)}</strong>${it.detail ? `<span style="${clamp(dl)}">${esc(it.detail)}</span>` : ""}</div>`;
    }).join("");
    return slide(b.accent, `${head(b.heading)}${body(`<div class="a-tl" style="--d:${dz}cqw;--t:${tz}cqw;--x:${xz}cqw"><i class="a-ln"></i>${marks}</div>`)}`, b.footer);
  },
  summary: b => `${b.heading}: ${(b.items as Milestone[]).map(it => `${it.date} ${it.title}${it.detail ? ` (${it.detail})` : ""}`).join("; ")}`,
  css: sx("timeline_slide", `.a-tl{position:absolute;inset:0}
.a-ln{position:absolute;left:0;right:0;top:50%;height:.7cqw;margin-top:-.35cqw;border-radius:9px;background:var(--ac2)}
.a-sm{position:absolute;width:.35cqw;margin-left:-.175cqw;background:var(--ac2)}
.a-dt{position:absolute;top:50%;width:2.6cqw;height:2.6cqw;margin:-1.3cqw 0 0 -1.3cqw;border-radius:50%;background:var(--ac);border:.55cqw solid #fdfcfa}
.a-m{position:absolute;display:flex;flex-direction:column;gap:.45cqw;overflow:hidden}
.a-m b{font-size:var(--d);line-height:1.25;font-weight:800;color:var(--ac)}
.a-m strong{font-size:var(--t);line-height:1.2;font-weight:760}
.a-m span{font-size:var(--x);line-height:1.4;font-weight:520;color:var(--muted)}`),
});

const stepItem = z.preprocess(asObject("title"), z.object({ title: text(28), detail: optionalText(72) }).strip());
type StepItem = { title: string; detail?: string };
export const processSlide = defineAsset({
  type: "process_slide", category: "slide", width: "half", frame: "16:9",
  use: "A slide that shows a process as three to five numbered steps along a connecting line, each with a title and a short line.",
  useKo: "3~5개 단계를 번호 원과 연결선으로 보여주는 프로세스 슬라이드(단계마다 제목과 짧은 설명).",
  tags: ["slide", "process", "steps", "flow", "how it works", "workflow", "슬라이드", "프로세스", "단계", "절차"],
  notes: "Three to five steps in order; title at most 28 characters, detail at most 72.",
  fields: { heading: text(64), steps: list(stepItem, 3, 5), footer: optionalText(48), accent },
  sample: { heading: "How a new account becomes a team", accent: "blue", footer: "Northwind Labs · Q3 review · 13", steps: [{ title: "Sign up", detail: "No card needed; ready in three minutes" }, { title: "Connect data", detail: "Import a spreadsheet or use the API" }, { title: "Build a dashboard", detail: "Start from one of twelve templates" }, { title: "Invite a teammate", detail: "Seats are free for the first 14 days" }, { title: "Upgrade", detail: "Team plan unlocks at the fourth seat" }] },
  render(b) {
    const steps = b.steps as StepItem[], n = steps.length, [tz, dz] = n === 3 ? [2.9, 2.2] : n === 4 ? [2.6, 2.1] : [2.3, 1.9];
    const col = steps.map((s, i) => `<li><span class="a-no">${i + 1}</span><b style="${clamp(2)}">${esc(s.title)}</b>${s.detail ? `<p style="${clamp(4)}">${esc(s.detail)}</p>` : ""}</li>`).join("");
    return slide(b.accent, `${head(b.heading)}${body(`<ol class="a-pr" style="grid-template-columns:repeat(${n},1fr);--t:${tz}cqw;--x:${dz}cqw"><i class="a-ln" style="left:${(50 / n).toFixed(2)}%;right:${(50 / n).toFixed(2)}%"></i>${col}</ol>`, "display:flex;align-items:center")}`, b.footer);
  },
  summary: b => `${b.heading}: ${(b.steps as StepItem[]).map((s, i) => `${i + 1}. ${s.title}${s.detail ? ` (${s.detail})` : ""}`).join("; ")}`,
  css: sx("process_slide", `.a-pr{position:relative;width:100%;margin:0;padding:0;list-style:none;display:grid;column-gap:1.2cqw}
.a-ln{position:absolute;top:3.2cqw;height:.6cqw;margin-top:-.3cqw;border-radius:9px;background:var(--ac2)}
.a-pr li{position:relative;min-width:0;display:flex;flex-direction:column;align-items:center;text-align:center;gap:1.1cqw;padding:0 .6cqw}
.a-no{width:6.4cqw;height:6.4cqw;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--ac);color:#fff;font-size:2.8cqw;font-weight:800;box-shadow:0 0 0 1cqw var(--ac2)}
.a-pr b{margin-top:1.2cqw;max-width:100%;font-size:var(--t);line-height:1.2;font-weight:800}
.a-pr p{margin:0;max-width:100%;font-size:var(--x);line-height:1.4;font-weight:520;color:var(--muted)}`),
});

const card = z.preprocess(asObject("title"), z.object({ title: text(40), note: optionalText(36) }).strip());
type Card = { title: string; note?: string };
export const roadmapSlide = defineAsset({
  type: "roadmap_slide", category: "slide", width: "half", frame: "16:9",
  use: "A roadmap slide with three columns (now, next, later) and up to four initiative cards in each.",
  useKo: "지금·다음·나중 세 열로 나눈 로드맵 슬라이드(열마다 과제 카드 최대 4개).",
  tags: ["slide", "roadmap", "now next later", "plan", "initiatives", "priorities", "슬라이드", "로드맵", "계획", "우선순위"],
  notes: "now, next and later each hold one to four cards; a card is a title (40 characters at most) with an optional note such as an owner or month. With four cards a column shows titles only.",
  fields: { heading: text(64), now: list(card, 1, 4), next: list(card, 1, 4), later: list(card, 1, 4), footer: optionalText(48), accent },
  sample: { heading: "Roadmap: from trial to team", accent: "blue", footer: "Northwind Labs · Q3 review · 14", now: [{ title: "Onboarding checklist", note: "Growth · ships in October" }, { title: "Teammate invite flow", note: "Product · October" }, { title: "Activation dashboard", note: "Data · October" }], next: [{ title: "Team plan analytics", note: "Product · Q4" }, { title: "Single sign-on", note: "Platform · Q4" }, { title: "Mobile home screen", note: "Mobile · Q4" }], later: [{ title: "Public API v2", note: "Platform · Q1" }, { title: "Template marketplace", note: "Growth · Q1" }] },
  render(b, { T }) {
    const cols = [{ k: "now", label: T("Now", "지금"), items: b.now }, { k: "next", label: T("Next", "다음"), items: b.next }, { k: "later", label: T("Later", "나중"), items: b.later }] as { k: string; label: string; items: Card[] }[];
    const [c] = accentHex(b.accent), tones = [c, lighten(c, 0.38), lighten(c, 0.66)];
    const avail = room(b.heading, { footer: !!b.footer }) - 4.6 - 3.2, w = 20.3, z = 1.95;
    const cardH = (tl: number, note: boolean) => 2.2 + tl * z * 1.25 + (note ? 1.6 * 1.3 + 0.3 : 0);
    const modes = [[2, true], [2, false], [1, true], [1, false]] as const;
    const [tl, note] = modes.find(([t, nt]) => Math.max(...cols.map(x => x.items.reduce((h, it, i) => h + cardH(Math.min(t, linesOf(it.title, z, w)), nt && !!it.note) + (i ? 1 : 0), 0))) <= avail) ?? modes[3];
    const html = cols.map((x, i) => `<section class="a-col"><h3><i style="background:${tones[i]}"></i>${esc(x.label)}<em>${x.items.length}</em></h3><ul>${x.items.map(it => `<li style="border-left-color:${tones[i]}"><b style="${clamp(tl)}">${esc(it.title)}</b>${note && it.note ? `<span style="${ELL}">${esc(it.note)}</span>` : ""}</li>`).join("")}</ul></section>`).join("");
    return slide(b.accent, `${head(b.heading)}${body(`<div class="a-cols">${html}</div>`)}`, b.footer);
  },
  summary: b => `${b.heading}: ${(["now", "next", "later"] as const).map(k => `${k[0].toUpperCase()}${k.slice(1)} — ${(b[k] as Card[]).map(x => x.title).join(", ")}`).join("; ")}`,
  css: sx("roadmap_slide", `.a-cols{height:100%;display:grid;grid-template-columns:repeat(3,1fr);gap:2cqw}
.a-col{min-width:0;min-height:0;display:flex;flex-direction:column;gap:1.3cqw;padding:1.6cqw;border-radius:1.6cqw;background:var(--surface);overflow:hidden}
.a-col h3{margin:0;display:flex;align-items:center;gap:.9cqw;font-size:1.8cqw;line-height:1.3;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink2)}
.a-col h3 i{width:1.4cqw;height:1.4cqw;border-radius:50%}
.a-col h3 em{margin-left:auto;font-style:normal;font-size:1.7cqw;letter-spacing:0;color:var(--faint)}
.a-col ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:1cqw;min-height:0}
.a-col li{display:flex;flex-direction:column;gap:.3cqw;padding:1.1cqw 1.3cqw;border:1px solid var(--line);border-left:.55cqw solid;border-radius:1.1cqw;background:#fff}
.a-col li b{font-size:1.95cqw;line-height:1.25;font-weight:750}
.a-col li span{font-size:1.6cqw;line-height:1.3;font-weight:560;color:var(--muted)}`),
});

const QUAD = [
  { k: "strengths", c: "#118558", d: "#0b6a45", bg: "#e4f5ec", en: "Strengths", ko: "강점" },
  { k: "weaknesses", c: "#c27a12", d: "#8f5a0a", bg: "#fff3da", en: "Weaknesses", ko: "약점" },
  { k: "opportunities", c: "#2f5fd6", d: "#2449a8", bg: "#e8eeff", en: "Opportunities", ko: "기회" },
  { k: "threats", c: "#cf3545", d: "#a3232f", bg: "#fde9eb", en: "Threats", ko: "위협" },
] as const;
const quad = list(text(44), 1, 4);
export const swotSlide = defineAsset({
  type: "swot_slide", category: "slide", width: "half", frame: "16:9",
  use: "A four-quadrant SWOT slide: strengths, weaknesses, opportunities and threats, two to four short bullets each.",
  useKo: "강점·약점·기회·위협 4분면 SWOT 슬라이드(분면마다 짧은 항목 2~4개).",
  tags: ["slide", "swot", "strengths", "weaknesses", "opportunities", "threats", "슬라이드", "스왓", "강점", "약점"],
  notes: "Each quadrant holds one to four short bullets (44 characters at most; with four bullets each stays on one line). heading is optional (default 'SWOT analysis').",
  fields: { heading: optionalText(48), strengths: quad, weaknesses: quad, opportunities: quad, threats: quad, footer: optionalText(48) },
  sample: { heading: "Where Northwind stands going into Q4", footer: "Northwind Labs · Q3 review · 15", strengths: ["Fast self-serve funnel", "Churn steady at 2.1% a month", "A help center customers use"], weaknesses: ["Activation stalls at 41%", "Enterprise deals take 74 days", "Thin mobile experience"], opportunities: ["Agency reseller network", "Template marketplace", "Teams that adopt from inside"], threats: ["Two well-funded rivals", "Rising paid-ad costs", "Mid-market budget freezes"] },
  render(b, { T }) {
    const heading = b.heading ?? T("SWOT analysis", "SWOT 분석"), avail = (room(heading, { footer: !!b.footer, oneLine: true }) - 1.4) / 2 - 5.4;
    const steps = [[2.2, 2], [2, 2], [1.9, 2], [1.8, 1]] as const;
    const hgt = (z: number, l: number) => Math.max(...QUAD.map(q => (b[q.k] as string[]).reduce((h, t, i) => h + Math.min(l, linesOf(t, z, 35)) * z * 1.25 + (i ? z * 0.35 : 0), 0)));
    const [z, l] = steps.find(([s2, k]) => hgt(s2, k) <= avail) ?? steps[steps.length - 1];
    const html = QUAD.map(q => `<section style="background:${q.bg};--c:${q.c}"><h3><i>${q.en[0]}</i><span style="color:${q.d}">${esc(T(q.en, q.ko))}</span></h3><ul style="font-size:${z}cqw">${(b[q.k] as string[]).map(t => `<li style="${clamp(l)}">${esc(t)}</li>`).join("")}</ul></section>`).join("");
    return slide(undefined, `${head(heading, { oneLine: true })}${body(`<div class="a-q">${html}</div>`)}`, b.footer);
  },
  summary: b => `${b.heading ?? "SWOT analysis"}: ${QUAD.map(q => `${q.en} — ${(b[q.k] as string[]).join(", ")}`).join("; ")}`,
  css: sx("swot_slide", `.a-q{height:100%;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:1.4cqw}
.a-q section{min-width:0;min-height:0;overflow:hidden;padding:1.1cqw 1.6cqw;border-radius:1.4cqw;display:flex;flex-direction:column;gap:.7cqw}
.a-q h3{margin:0;display:flex;align-items:center;gap:1cqw;font-size:2.1cqw;line-height:1.2;font-weight:800}
.a-q h3 i{width:2.6cqw;height:2.6cqw;border-radius:.7cqw;display:flex;align-items:center;justify-content:center;background:var(--c);color:#fff;font-style:normal;font-size:1.7cqw;font-weight:800}
.a-q ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:.35em;min-height:0}
.a-q li{position:relative;padding-left:1.1em;line-height:1.25;font-weight:560;color:var(--ink2)}
.a-q li::before{content:"";position:absolute;left:0;top:.5em;width:.4em;height:.4em;border-radius:50%;background:var(--c)}`),
});

const person = z.object({ name: text(28), role: text(34), bio: optionalText(80) }).strip();
type Person = { name: string; role: string; bio?: string };
const AVATAR: [string, string][] = [["#2f5fd6", "#6f94f5"], ["#0b7a5a", "#2fc08f"], ["#d9680f", "#f5a04d"], ["#c42a63", "#ee6f9d"], ["#6d28d9", "#a98af0"], ["#0b6f84", "#3fc0d6"]];
/** Two letters from a name: first and last initial for Latin names, the given name (last two characters) for a Korean or Chinese one. */
export function initials(name: string) {
  name = name.replace(/…$/, "");
  const words = name.trim().split(/\s+/).filter(Boolean), chars = [...name.replace(/\s+/g, "")];
  if (/[　-鿿가-힣]/.test(name)) return (chars.length >= 3 ? chars.slice(-2) : chars).join("");
  return (words.length >= 2 ? `${[...words[0]][0]}${[...words[words.length - 1]][0]}` : chars.slice(0, 2).join("")).toUpperCase();
}
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.codePointAt(0)!, 16777619); return (h ^ (h >>> 15)) >>> 0; };
export const teamSlide = defineAsset({
  type: "team_slide", category: "slide", width: "half", frame: "16:9",
  use: "A team slide with three to six people, each with an initials avatar, a name, a role and a one-line bio.",
  useKo: "3~6명의 팀원을 이니셜 아바타, 이름, 역할, 한 줄 소개로 보여주는 팀 소개 슬라이드.",
  tags: ["slide", "team", "people", "staff", "about us", "leadership", "슬라이드", "팀", "팀원", "소개"],
  notes: "Three to six people; the avatar shows initials on a colour chosen from the name, so the same person always looks the same. bio is at most 80 characters.",
  fields: { heading: text(64), people: list(person, 3, 6), footer: optionalText(48), accent },
  sample: { heading: "The squad behind Q4", accent: "blue", footer: "Northwind Labs · Q3 review · 16", people: [{ name: "Maya Chen", role: "CEO", bio: "Sets the bets and spends Fridays on customer calls" }, { name: "Arjun Rao", role: "Head of Growth", bio: "Runs the signup and activation experiments" }, { name: "Lena Fischer", role: "Design lead", bio: "Owns onboarding and the new help center" }, { name: "Diego Alvarez", role: "Engineering lead", bio: "Leads the six-person onboarding squad" }, { name: "Priya Nair", role: "Data scientist", bio: "Builds the activation and churn models" }, { name: "Sam Okafor", role: "Partnerships", bio: "Signed 14 agencies in three weeks" }] },
  render(b) {
    const ppl = b.people as Person[], n = ppl.length, tall = n <= 3, wrap = n >= 5, cols = tall ? n : n === 4 ? 2 : 3, rows = tall ? 1 : Math.ceil(n / cols), avail = room(b.heading, { footer: !!b.footer });
    const s = tall ? 9.6 : n === 4 ? 9 : 6.6, nz = tall ? 2.7 : n === 4 ? 2.5 : 2.2, rz = tall ? 2.1 : n === 4 ? 2 : 1.8, bz = tall ? 1.9 : n === 4 ? 1.9 : 1.7;
    const cellH = (avail - 2 * (rows - 1)) / rows, cardW = (84 - 2 * (cols - 1)) / cols, textW = tall ? 20 : wrap ? cardW - 3.6 : cardW - s - 3.6 - 1.6;
    // What a card keeps for the bio once the avatar, the name and the role have their room.
    const head2 = nz * 1.2 + rz * 1.3 + 0.4, fixed = tall ? 4.4 + s + 1.4 + head2 + 0.3 : wrap ? 3 + Math.max(s, head2) + 1 : 3 + head2 + 0.3;
    const html = ppl.map(p => {
      const [c1, c2] = AVATAR[hash(p.name) % AVATAR.length], room2 = Math.floor((cellH - fixed) / (bz * 1.4)), lines = p.bio ? Math.min(4, linesOf(p.bio, bz, textW), room2) : 0;
      const bio = (inner: string) => (p.bio && lines >= 1 ? `<span style="${clamp(lines)}">${esc(p.bio)}</span>` : "") + inner;
      const who = `<div><b>${esc(p.name)}</b><em>${esc(p.role)}</em>${wrap || tall ? "" : bio("")}</div>`;
      return `<div class="a-p"><i class="a-av" style="background:linear-gradient(135deg,${c1},${c2})">${esc(initials(p.name))}</i>${who}${wrap || tall ? bio("") : ""}</div>`;
    }).join("");
    return slide(b.accent, `${head(b.heading)}${body(`<div class="a-tm${tall ? " a-v" : wrap ? " a-g" : ""}" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},minmax(0,1fr));--s:${s}cqw;--n:${nz}cqw;--r:${rz}cqw;--b:${bz}cqw">${html}</div>`)}`, b.footer);
  },
  summary: b => `${b.heading}: ${(b.people as Person[]).map(p => `${p.name}, ${p.role}${p.bio ? ` — ${p.bio}` : ""}`).join("; ")}`,
  css: sx("team_slide", `.a-tm{height:100%;display:grid;gap:2cqw}
.a-p{min-width:0;min-height:0;display:flex;align-items:center;gap:1.6cqw;padding:1.5cqw 1.8cqw;border:1px solid var(--line);border-radius:1.6cqw;background:#fff;overflow:hidden}
.a-v .a-p{flex-direction:column;justify-content:center;text-align:center;padding:2.2cqw}
.a-g .a-p{display:grid;grid-template-columns:var(--s) 1fr;align-content:center;gap:1cqw 1.4cqw}
.a-g .a-p span{grid-column:1/-1;margin:0}
.a-av{flex:none;width:var(--s);height:var(--s);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-style:normal;font-size:calc(var(--s) * .36);font-weight:800;letter-spacing:.02em}
.a-p div{min-width:0;max-width:100%;display:flex;flex-direction:column;gap:.4cqw}
.a-p b{font-size:var(--n);line-height:1.2;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.a-p em{font-style:normal;font-size:var(--r);line-height:1.3;font-weight:700;color:var(--ac);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.a-p span{margin-top:.3cqw;font-size:var(--b);line-height:1.4;font-weight:520;color:var(--muted)}`),
});
export const ASSETS: readonly AnyAsset[] = [timelineSlide, processSlide, roadmapSlide, swotSlide, teamSlide];
