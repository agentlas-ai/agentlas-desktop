import { z } from "zod";
import { esc } from "../../kit";
import { list, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { LABEL, MUTED, ROW, accent, day, docCss, hue, plain } from "./_shared";

/** People and publication pages: the resume, the meeting minutes, the certificate and the newsletter. */

// ── resume ───────────────────────────────────────────────────────────────────────────────────────────────────
export const resume = defineAsset({
  type: "resume", category: "document", width: "half", frame: "a4",
  use: "A resume or CV page: name, headline, contact line, summary, experience entries with bullets, skills chips and education.",
  useKo: "이력서 한 장: 이름, 직함, 연락처, 요약, 불릿이 있는 경력, 기술 칩, 학력.",
  tags: ["resume", "cv", "curriculum vitae", "experience", "skills", "education", "이력서", "경력", "기술", "학력", "자기소개"],
  notes: "Up to 3 experience entries with 1-2 bullets of at most 90 characters; up to 10 skills; up to 2 education entries.",
  fields: { name: text(40), headline: optionalText(70), contact: list(text(36), 1, 4), summary: optionalText(220), experience: list(z.object({ role: text(40), company: text(36), dates: text(22), bullets: list(text(90), 1, 2) }).strip(), 1, 3), skills: list(text(20), 1, 10), education: list(z.object({ school: text(40), detail: text(50), dates: optionalText(16) }).strip(), 1, 2), accent },
  sample: {
    name: "Maya Okafor", headline: "Product designer, health and fintech", contact: ["maya@okafor.example", "+1 415 555 0178", "Oakland, CA", "okafor.example/work"],
    summary: "Designer with eight years shipping consumer products used by millions. I lead research-to-launch work, from first sketches to measured outcomes, and mentor early-career designers.",
    experience: [{ role: "Senior Product Designer", company: "Lumen Health", dates: "2022 - now", bullets: ["Led the redesign of onboarding, lifting week-one activation from 38% to 57%.", "Built the design system used by 14 designers and 60 engineers."] }, { role: "Product Designer", company: "Ledgerly", dates: "2019 - 2022", bullets: ["Shipped the budgeting tool now used by 1.2M customers.", "Ran 120 usability sessions that reshaped the roadmap."] }, { role: "UX Designer", company: "Studio North", dates: "2017 - 2019", bullets: ["Delivered web and mobile work for 11 clients in retail and education."] }],
    skills: ["Product strategy", "Interaction design", "Prototyping", "User research", "Design systems", "Figma", "Accessibility", "Data storytelling"], education: [{ school: "California College of the Arts", detail: "BFA, Interaction Design", dates: "2013 - 2017" }, { school: "Nielsen Norman Group", detail: "UX Certification", dates: "2020" }], accent: "teal",
  },
  render(b, { ko }) {
    const exp = (e: { role: string; company: string; dates: string; bullets: string[] }) => `<div style="margin-bottom:2.8cqw"><div style="${ROW};align-items:baseline"><b class="a-el" style="font-size:2.3cqw">${esc(e.role)}</b><span style="flex:none;white-space:nowrap;${MUTED}">${esc(e.dates)}</span></div><div class="a-el" style="color:var(--ac);font-weight:650">${esc(e.company)}</div>${e.bullets.map(t => `<div style="position:relative;padding-left:2.2cqw;margin-top:.7cqw;font-size:1.95cqw;line-height:1.45"><i style="position:absolute;left:.3cqw;top:.85cqw;width:.8cqw;height:.8cqw;border-radius:50%;background:var(--ac)"></i><span class="a-lc" style="--n:2">${esc(t)}</span></div>`).join("")}</div>`;
    const sec = (k: string) => `<h3 style="padding-bottom:1cqw;margin-bottom:1.6cqw;border-bottom:.2cqw solid var(--line)">${k}</h3>`;
    return `<div class="a-pg" ${hue(b.accent, "teal", "", ko)}><h2 class="a-el" style="font-size:6.4cqw;letter-spacing:-.02em">${esc(b.name)}</h2>${b.headline ? `<div class="a-el" style="margin-top:.6cqw;font-size:2.7cqw;font-weight:650;color:var(--ac)">${esc(b.headline)}</div>` : ""}`
      + `<div style="display:flex;flex-wrap:wrap;gap:.6cqw 2.6cqw;margin-top:1.8cqw;height:5.4cqw;overflow:hidden;${MUTED}">${b.contact.map(c => `<span class="a-el" style="max-width:40cqw">${esc(c)}</span>`).join("")}</div><div style="height:.5cqw;background:var(--ac);margin:2.2cqw 0 3.4cqw"></div>`
      + `<div class="a-fl" style="flex:1;display:grid;grid-template-columns:minmax(0,1fr) 26cqw;gap:5cqw"><div>${b.summary ? `${sec("Profile")}<p class="a-sf" style="margin:0 0 3cqw;font-size:2cqw;line-height:1.55">${esc(b.summary)}</p>` : ""}${sec("Experience")}${b.experience.map(exp).join("")}</div>`
      + `<div style="padding-left:3cqw;border-left:.2cqw solid var(--line)">${sec("Skills")}<div style="display:flex;flex-wrap:wrap;gap:1cqw;margin-bottom:3cqw">${b.skills.map(s => `<em class="a-el" style="max-width:100%">${esc(s)}</em>`).join("")}</div>${sec("Education")}${b.education.map(e => `<div style="margin-bottom:1.8cqw;line-height:1.4"><b class="a-lc" style="--n:2">${esc(e.school)}</b><div class="a-lc" style="--n:2;${MUTED}">${esc(e.detail)}</div>${e.dates ? `<div style="${MUTED}">${esc(e.dates)}</div>` : ""}</div>`).join("")}</div></div></div>`;
  },
  summary: b => `Resume of ${plain(b.name)}${b.headline ? `, ${plain(b.headline)}` : ""}. Experience: ${b.experience.map(e => `${plain(e.role)} at ${plain(e.company)} (${plain(e.dates)})`).join("; ")}. Skills: ${b.skills.map(plain).join(", ")}. Education: ${b.education.map(e => plain(e.school)).join("; ")}.`,
  css: docCss("resume", ["pg", "fx", "h", "k", "e", "el", "lc"], ""),
});

// ── meeting_minutes ──────────────────────────────────────────────────────────────────────────────────────────
export const meetingMinutes = defineAsset({
  type: "meeting_minutes", category: "document", width: "half", frame: "a4",
  use: "Meeting minutes: title, date, time and place, attendees, agenda items with their decisions, and an action table with owners and due dates.",
  useKo: "회의록: 제목, 일시·장소, 참석자, 결정 사항이 있는 안건, 담당자와 기한이 있는 실행 항목 표.",
  tags: ["meeting minutes", "minutes", "agenda", "decisions", "action items", "attendees", "회의록", "안건", "결정", "참석자", "실행 항목"],
  notes: "Up to 6 attendees, 4 agenda items (topic at most 56, decision at most 80 characters), 5 actions with owner and due date.",
  fields: { title: text(70), date: text(24), time: optionalText(20), place: optionalText(40), attendees: list(text(26), 1, 6), agenda: list(z.object({ topic: text(56), decision: text(80) }).strip(), 1, 4), actions: list(z.object({ task: text(64), owner: text(20), due: text(14) }).strip(), 1, 5), accent },
  sample: {
    title: "Product planning sync, Q1 roadmap", date: "", time: "10:00 - 10:45", place: "Room 4B and Zoom", attendees: ["Dana Whitfield", "Maya Okafor", "Ibrahim Khan", "Aiko Sato", "Tomas Lund", "Priya Nair"],
    agenda: [{ topic: "Q1 roadmap priorities", decision: "Checkout redesign goes first; analytics export moves to Q2." }, { topic: "Hiring plan for the design team", decision: "Open one senior role now, a second after the January review." }, { topic: "Support backlog and tooling", decision: "Adopt the shared inbox pilot for four weeks, then decide." }],
    actions: [{ task: "Write the checkout redesign brief", owner: "Maya", due: "Oct 21" }, { task: "Post the senior designer role", owner: "Dana", due: "Oct 18" }, { task: "Set up the shared inbox pilot", owner: "Ibrahim", due: "Oct 28" }, { task: "Share the Q1 roadmap with sales", owner: "Priya", due: "Oct 24" }], accent: "blue",
  },
  render(b, { ko, T }) {
    const meta = (k: string, v: string) => `<div style="min-width:0"><div style="${LABEL}">${k}</div><b class="a-el" style="display:block;margin-top:.4cqw">${v}</b></div>`;
    const sec = (k: string, extra = "") => `<h3 style="margin:${extra || "2.8cqw 0 1.2cqw"}">${k}</h3>`;
    return `<div class="a-pg" ${hue(b.accent, "blue", "", ko)}><h3>${T("Meeting minutes", "회의록")}</h3><h2 class="a-lc" style="--n:2;font-size:4.6cqw;margin:1.2cqw 0 2.6cqw">${esc(b.title)}</h2>`
      + `<div style="display:grid;grid-template-columns:1.1fr .9fr 1.2fr;gap:2.4cqw;padding:1.6cqw 2.6cqw;border-radius:1.4cqw;background:var(--surface)">${meta(T("Date", "날짜"), esc(day(b.date, ko)))}${meta(T("Time", "시간"), esc(b.time ?? "—"))}${meta(T("Place", "장소"), esc(b.place ?? "—"))}</div>`
      + `${sec(T("Attendees", "참석자"))}<div style="display:flex;flex-wrap:wrap;gap:1cqw;max-height:9cqw;overflow:hidden">${b.attendees.map(a => `<em class="a-el" style="max-width:100%;background:var(--surface);color:var(--ink2)">${esc(a)}</em>`).join("")}</div>`
      + `${sec(T("Agenda and decisions", "안건과 결정"))}${b.agenda.map((a, i) => `<div style="display:grid;grid-template-columns:3.4cqw minmax(0,1fr);gap:1.4cqw;margin-bottom:1.4cqw"><span style="font-weight:800;color:var(--ac)">${i + 1}.</span><div style="min-width:0"><b class="a-el" style="display:block">${esc(a.topic)}</b><div class="a-lc" style="--n:2;margin-top:.6cqw;padding:.8cqw 1.6cqw;border-left:.7cqw solid var(--ac);background:var(--at);font-size:1.95cqw;line-height:1.45"><b style="color:var(--ac)">${T("Decision", "결정")}</b> · ${esc(a.decision)}</div></div></div>`).join("")}`
      + `${sec(T("Action items", "실행 항목"), "1.6cqw 0 .6cqw")}<div class="a-ro" style="padding-top:0;border-bottom:.3cqw solid var(--ink);${LABEL}"><span>${T("Action", "내용")}</span><span>${T("Owner", "담당")}</span><span>${T("Due", "기한")}</span></div>${b.actions.map(a => `<div class="a-ro"><span class="a-el" style="color:var(--ink)">${esc(a.task)}</span><b class="a-el">${esc(a.owner)}</b><span class="a-el" style="color:var(--muted)">${esc(a.due)}</span></div>`).join("")}</div>`;
  },
  summary: b => `Minutes: ${plain(b.title)}, ${plain(b.date)}${b.place ? `, ${plain(b.place)}` : ""}. ${b.attendees.length} attendees. Decisions: ${b.agenda.map(a => `${plain(a.topic)} - ${plain(a.decision)}`).join("; ")}. Actions: ${b.actions.map(a => `${plain(a.task)} (${plain(a.owner)}, ${plain(a.due)})`).join("; ")}.`,
  css: docCss("meeting_minutes", ["pg", "fx", "h", "k", "e", "el", "lc"], `
    § .a-ro{display:grid;grid-template-columns:minmax(0,1fr) 15cqw 12cqw;gap:1.5cqw;align-items:baseline;padding:.95cqw 0;border-bottom:.2cqw solid var(--line)}`),
});

// ── certificate ──────────────────────────────────────────────────────────────────────────────────────────────
/** The scalloped edge of a seal: alternating radii around a circle. */
const scallop = (cx: number, cy: number, outer: number, inner: number, n: number) => Array.from({ length: n * 2 }, (_, i) => { const a = (Math.PI * i) / n - Math.PI / 2, r = i % 2 ? inner : outer; return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`; }).join(" ");
const SCRIPT = "font-family:'Snell Roundhand','Segoe Script','Bradley Hand','Brush Script MT',cursive";

export const certificate = defineAsset({
  type: "certificate", category: "document", width: "half", frame: "4:3",
  use: "A certificate of achievement, completion or appreciation: ornate border, title, recipient, reason, date, two signature lines and a seal.",
  useKo: "수료증·감사장·상장: 장식 테두리, 제목, 수상자, 사유, 날짜, 서명란 두 곳, 인장.",
  tags: ["certificate", "award", "diploma", "achievement", "completion", "recognition", "수료증", "상장", "감사장", "인증서", "표창"],
  notes: "title such as Certificate of Completion; reason at most 140 characters; one or two signers; seal is a short word or year in the seal.",
  fields: { title: text(40), issuer: optionalText(40), recipient: text(40), reason: text(140), date: text(24), signers: list(z.object({ name: text(28), role: optionalText(28) }).strip(), 1, 2), seal: optionalText(10), accent },
  sample: { title: "Certificate of Achievement", issuer: "Lumen Learning Academy", recipient: "Maya Okafor", reason: "for completing the Advanced Product Design programme with distinction, including all twelve studio projects", date: "", signers: [{ name: "Elena Marquez", role: "Programme Director" }, { name: "Dr. Samuel Reyes", role: "Dean of Studies" }], seal: "2026", accent: "amber" },
  render(b, { ko, uid, T }) {
    const corner = `<g id="${uid}c" fill="none" stroke="var(--ac)"><path d="M12 12h30M12 12v30" stroke-width="1.8"/><path d="M12 30a18 18 0 0 0 18-18M12 38a26 26 0 0 0 26-26" stroke-width=".7"/><path d="M12 22a10 10 0 0 0 10-10" stroke-width=".7"/><circle cx="12" cy="12" r="3" fill="var(--ac)" stroke="none"/><path d="M46 12h8M12 46v8" stroke-width=".7"/></g>`;
    const art = `<svg viewBox="0 0 400 300" preserveAspectRatio="none" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%"><defs>${corner}</defs><rect x="6" y="6" width="388" height="288" rx="3" fill="none" stroke="var(--ac)" stroke-width="3"/><rect x="12" y="12" width="376" height="276" fill="none" stroke="var(--ac)" stroke-width=".8"/><rect x="15" y="15" width="370" height="270" fill="none" stroke="var(--ac)" stroke-width=".5" stroke-dasharray="1.2 2.4"/><use href="#${uid}c"/><use href="#${uid}c" transform="translate(400 0) scale(-1 1)"/><use href="#${uid}c" transform="translate(0 300) scale(1 -1)"/><use href="#${uid}c" transform="translate(400 300) scale(-1 -1)"/></svg>`;
    const seal = `<svg viewBox="0 0 40 50" aria-hidden="true" style="flex:none;width:12.5cqw"><path d="M13 30l-5 18 7-3 4 5 4-17zM27 30l5 18-7-3-4 5-4-17z" fill="var(--ac)" opacity=".75"/><polygon points="${scallop(20, 20, 19.5, 17, 24)}" fill="var(--ac)"/><circle cx="20" cy="20" r="14.2" fill="none" stroke="#fff" stroke-width=".8"/><circle cx="20" cy="20" r="12.2" fill="none" stroke="#fff" stroke-width=".4" stroke-dasharray=".8 1.2"/><path d="M20 8.6l1.6 3.5 3.8.4-2.8 2.6.8 3.8-3.4-1.9-3.4 1.9.8-3.8-2.8-2.6 3.8-.4z" fill="#fff"/><text x="20" y="28.6" text-anchor="middle" font-size="6.2" font-weight="800" fill="#fff" letter-spacing=".3">${esc(b.seal ?? "★")}</text></svg>`;
    const sign = (s: { name: string; role?: string }) => `<div style="flex:1;min-width:0;text-align:center;padding-bottom:1cqw"><div class="a-el" style="margin:0 3cqw;padding-bottom:.4cqw;border-bottom:.25cqw solid var(--ink);font-size:3.6cqw;line-height:1.2;color:var(--ink);${SCRIPT}">${esc(s.name)}</div><b class="a-el" style="display:block;margin-top:.6cqw;font-size:1.7cqw">${esc(s.name)}</b>${s.role ? `<div class="a-el" style="font-size:1.55cqw;color:var(--muted)">${esc(s.role)}</div>` : ""}</div>`;
    return `<div class="a-pg" ${hue(b.accent, "amber", "padding:5.4cqw 11cqw 4.6cqw;align-items:center;text-align:center;font-size:2cqw", ko)}>${art}${b.issuer ? `<h3 class="a-el" style="max-width:100%;position:relative">${esc(b.issuer)}</h3>` : ""}`
      + `<h2 class="a-lc" style="--n:2;position:relative;margin-top:1.2cqw;font-size:5.2cqw;line-height:1.1;letter-spacing:.01em">${esc(b.title)}</h2><div style="position:relative;display:flex;align-items:center;gap:1.4cqw;width:30cqw;margin:1.6cqw 0 1.4cqw;color:var(--ac)"><i style="flex:1;height:.25cqw;background:currentColor;opacity:.5"></i><i style="width:1.2cqw;height:1.2cqw;transform:rotate(45deg);background:currentColor"></i><i style="flex:1;height:.25cqw;background:currentColor;opacity:.5"></i></div>`
      + `<div style="position:relative;font-size:1.75cqw;letter-spacing:.06em;color:var(--muted)">${T("This certificate is proudly presented to", "위 사람에게 이 증서를 수여합니다")}</div><div class="a-el" style="position:relative;max-width:100%;margin:.6cqw 0 .4cqw;padding:0 4cqw .3cqw;border-bottom:.25cqw solid var(--line);font-size:8.6cqw;line-height:1.25;color:var(--ink);${SCRIPT}">${esc(b.recipient)}</div>`
      + `<p class="a-sf a-lc" style="--n:2;position:relative;margin:1.2cqw 0 0;max-width:86%;font-size:2.1cqw;line-height:1.5;color:var(--ink2)">${esc(b.reason)}</p><div style="position:relative;margin-top:1cqw;font-size:1.85cqw;font-style:italic;color:var(--muted)">${T("Awarded on", "수여일")} ${esc(day(b.date, ko))}</div>`
      + `<div style="position:relative;display:flex;align-items:flex-end;justify-content:center;gap:2cqw;width:100%;margin-top:auto">${sign(b.signers[0])}${seal}${b.signers[1] ? sign(b.signers[1]) : `<div style="flex:1"></div>`}</div></div>`;
  },
  summary: b => `${plain(b.title)}${b.issuer ? ` from ${plain(b.issuer)}` : ""}: presented to ${plain(b.recipient)} ${plain(b.reason)}. ${plain(b.date)}. Signed by ${b.signers.map(s => plain(s.name)).join(" and ")}.`,
  css: docCss("certificate", ["pg", "fx", "h", "k", "el", "lc"], ""),
});

// ── newsletter ───────────────────────────────────────────────────────────────────────────────────────────────
export const newsletter = defineAsset({
  type: "newsletter", category: "document", width: "half", frame: "a4",
  use: "A newsletter issue: masthead, issue and date, a lead story with headline and teaser, short briefs and a footer line.",
  useKo: "뉴스레터 한 호: 제호, 호수·날짜, 헤드라인과 요약이 있는 주요 기사, 짧은 소식, 하단 문구.",
  tags: ["newsletter", "issue", "masthead", "digest", "briefs", "bulletin", "뉴스레터", "소식지", "제호", "다이제스트", "사보"],
  notes: "masthead at most 30 characters; lead teaser at most 240; 1-3 briefs of at most 120 characters.",
  fields: { masthead: text(30), tagline: optionalText(50), issue: text(24), date: text(24), lead: z.object({ headline: text(70), teaser: text(240), tag: optionalText(18), byline: optionalText(30) }).strip(), briefs: list(z.object({ headline: text(46), text: text(120) }).strip(), 1, 3), footer: text(80), accent },
  sample: {
    masthead: "The Harbor Dispatch", tagline: "News from the waterfront district", issue: "Issue 42", date: "",
    lead: { headline: "The old ferry terminal reopens as a public market", teaser: "After four years of work, the 1923 terminal now holds 38 food stalls, a rooftop garden and a small museum of the harbour. Opening weekend drew more than 20,000 visitors, and vendors say the winter calendar is already full.", tag: "Cover story", byline: "By Lena Hartmann" },
    briefs: [{ headline: "Night ferry returns in November", text: "The 9:40 pm crossing resumes on weekends after a two-year pause, with fares unchanged at $4." }, { headline: "Library extends opening hours", text: "From Monday the harbour branch opens until 9 pm on weekdays, with quiet study rooms bookable online." }, { headline: "Seawall repairs reach midpoint", text: "Crews finished 600 of 1,200 metres; the promenade closure ends on December 6, a week ahead of plan." }],
    footer: "You are receiving this because you subscribed. Unsubscribe any time.", accent: "red",
  },
  render(b, { ko, uid }) {
    const hills = `<svg viewBox="0 0 100 44" preserveAspectRatio="xMidYMid slice" aria-hidden="true" style="flex:1;min-height:14cqw;width:100%;overflow:hidden;border-radius:1.2cqw;margin:2.6cqw 0 2cqw;display:block"><defs><linearGradient id="${uid}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ac)" stop-opacity=".85"/><stop offset="1" stop-color="var(--at)"/></linearGradient></defs><rect width="100" height="44" fill="url(#${uid}s)"/><circle cx="72" cy="15" r="8" fill="#fff" fill-opacity=".85"/><path d="M0 30C14 22 26 24 40 29s30 4 60-6v21H0z" fill="var(--ac)" opacity=".55"/><path d="M0 36C18 29 34 33 52 36s30-2 48-7v15H0z" fill="var(--ac)" opacity=".8"/><path d="M0 41c20-4 40-1 60 0s28-1 40-3v6H0z" fill="var(--ink2)" opacity=".85"/></svg>`;
    return `<div class="a-pg" ${hue(b.accent, "red", "", ko)}><div style="text-align:center;border-top:.9cqw solid var(--ink);padding-top:1.8cqw"><h2 class="a-el" style="font-size:8.4cqw;line-height:1.05;letter-spacing:-.02em">${esc(b.masthead)}</h2>${b.tagline ? `<div class="a-el a-sf" style="margin-top:.8cqw;font-style:italic;${MUTED}">${esc(b.tagline)}</div>` : ""}</div>`
      + `<div style="${ROW};margin-top:1.8cqw;padding:1cqw 0;border-top:.25cqw solid var(--ink);border-bottom:.25cqw solid var(--ink);font-size:1.6cqw;font-weight:750;letter-spacing:.12em;text-transform:uppercase"><span class="a-el">${esc(b.issue)}</span><span class="a-el" style="color:var(--muted)">${esc(day(b.date, ko))}</span></div>${hills}`
      + `${b.lead.tag ? `<h3>${esc(b.lead.tag)}</h3>` : ""}<h2 class="a-lc" style="--n:3;margin-top:.8cqw;font-size:4.2cqw;line-height:1.15">${esc(b.lead.headline)}</h2>${b.lead.byline ? `<div class="a-el" style="${MUTED};margin-top:.8cqw">${esc(b.lead.byline)}</div>` : ""}<p class="a-sf a-lc" style="--n:4;margin:1.2cqw 0 0;font-size:2.05cqw;line-height:1.5">${esc(b.lead.teaser)}</p>`
      + `<div style="display:grid;grid-template-columns:repeat(${b.briefs.length},minmax(0,1fr));gap:0;margin-top:2.6cqw;padding-top:2.2cqw;border-top:.25cqw solid var(--ink)">${b.briefs.map((x, i) => `<div style="min-width:0;padding:0 ${i === b.briefs.length - 1 ? 0 : 2.4}cqw 0 ${i ? 2.4 : 0}cqw;${i ? "border-left:.2cqw solid var(--line)" : ""}"><b class="a-sf a-lc" style="--n:2;font-size:2.3cqw;line-height:1.25">${esc(x.headline)}</b><p class="a-lc" style="--n:5;margin:.8cqw 0 0;font-size:1.8cqw;line-height:1.45;color:var(--muted)">${esc(x.text)}</p></div>`).join("")}</div>`
      + `<div class="a-lc" style="--n:2;margin-top:2.4cqw;padding-top:1.6cqw;border-top:.2cqw solid var(--line);font-size:1.5cqw;line-height:1.5;text-align:center;color:var(--faint)">${esc(b.footer)}</div></div>`;
  },
  summary: b => `${plain(b.masthead)}, ${plain(b.issue)}, ${plain(b.date)}. Lead: ${plain(b.lead.headline)} — ${plain(b.lead.teaser)} Briefs: ${b.briefs.map(x => plain(x.headline)).join("; ")}.`,
  css: docCss("newsletter", ["pg", "fx", "h", "k", "el", "lc"], ""),
});

export const ASSETS: readonly AnyAsset[] = [resume, meetingMinutes, certificate, newsletter];
