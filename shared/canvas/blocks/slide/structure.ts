import { z } from "zod";
import { esc } from "../../kit";
import { list, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { accent, clamp, dark, deco, fit, ground, h2, kicker, pad2, slide, sx } from "./_shared";

/** The slides that give a deck its shape: the agenda, the section divider and the closing slide. */
const asObject = (key: string) => (v: unknown) => (typeof v === "string" ? { [key]: v } : v);
const agendaItem = z.preprocess(asObject("title"), z.object({ title: text(56), time: optionalText(14) }).strip());
const step = z.preprocess(asObject("text"), z.object({ text: text(64), when: optionalText(14) }).strip());

export const agendaSlide = defineAsset({
  type: "agenda_slide", category: "slide", width: "half", frame: "16:9",
  use: "A presentation's agenda: a heading and three to seven numbered items, each with an optional time or duration.",
  useKo: "발표의 안건 슬라이드: 제목과 번호가 붙은 3~7개 항목, 항목마다 시간(선택).",
  tags: ["slide", "agenda", "outline", "contents", "schedule", "슬라이드", "안건", "목차", "순서", "발표"],
  notes: "Items are short topics (56 characters at most); time is a duration or a clock time like '10 min'. accent picks the colour: blue, green, violet, sunset or ink.",
  fields: { heading: optionalText(36), subtitle: optionalText(60), items: list(agendaItem, 3, 7), footer: optionalText(48), accent },
  sample: { heading: "Agenda", subtitle: "Q3 review · Tuesday, October 14", accent: "blue", footer: "Northwind Labs · Q3 review · 2", items: [{ title: "Q3 results at a glance", time: "5 min" }, { title: "Where the new users came from", time: "10 min" }, { title: "Pricing and plan changes", time: "10 min" }, { title: "Roadmap: now, next and later", time: "15 min" }, { title: "Risks and open questions", time: "10 min" }, { title: "Decisions and next steps", time: "5 min" }] },
  render(b, { ko }) {
    const n = b.items.length, size = n <= 4 ? 3 : n === 5 ? 2.8 : n === 6 ? 2.5 : 2.3, heading = b.heading ?? (ko ? "안건" : "Agenda");
    const items = b.items.map((it: { title: string; time?: string }, i: number) => `<li><i>${pad2(i + 1)}</i><span>${esc(it.title)}</span>${it.time ? `<em>${esc(it.time)}</em>` : ""}</li>`).join("");
    return slide(b.accent, `<div class="a-l">${h2(heading, fit(heading, 23, [[4.6, 1], [4.2, 2], [3.6, 2]]))}${b.subtitle ? `<p>${esc(b.subtitle)}</p>` : ""}<div class="a-big" aria-hidden="true">${pad2(n)}</div></div><ol class="a-ol" style="font-size:${size}cqw">${items}</ol>`, b.footer, "flex-direction:row;gap:5cqw");
  },
  summary: b => `${b.heading ?? "Agenda"}: ${b.items.map((it: { title: string; time?: string }, i: number) => `${i + 1}. ${it.title}${it.time ? ` (${it.time})` : ""}`).join("; ")}`,
  css: sx("agenda_slide", `
.a-l{flex:0 0 23cqw;min-width:0;display:flex;flex-direction:column}
.a-l p{${clamp(3)};margin:1.4cqw 0 0;font-size:2.1cqw;line-height:1.35;font-weight:600;color:var(--muted)}
.a-big{margin-top:auto;font-size:17cqw;line-height:.8;font-weight:800;letter-spacing:-.04em;color:var(--ac2)}
.a-ol{flex:1;min-width:0;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;justify-content:center}
.a-ol li{flex:1 1 0;max-height:8cqw;min-height:0;display:grid;grid-template-columns:5.2cqw 1fr auto;align-items:center;gap:1.2cqw}
.a-ol li+li{border-top:1px solid var(--line)}
.a-ol i{font-style:normal;font-size:.86em;font-weight:800;color:var(--ac)}
.a-ol span{${clamp(2)};font-weight:650;line-height:1.22}
.a-ol em{font-style:normal;font-size:.68em;font-weight:700;color:var(--muted);background:var(--surface);border-radius:99px;padding:.5cqw 1.5cqw;white-space:nowrap}`),
});

export const sectionSlide = defineAsset({
  type: "section_slide", category: "slide", width: "half", frame: "16:9",
  use: "A section divider slide on a colour ground: a big section number, the section title and one line describing it.",
  useKo: "색 배경의 구역 구분 슬라이드: 큰 구역 번호, 구역 제목과 한 줄 설명.",
  tags: ["slide", "section", "divider", "chapter", "part", "슬라이드", "섹션", "구분", "장", "발표"],
  notes: "ground picks the colour: ink, blue, green, violet or sunset. number is the section's number or letter (4 characters at most); the description is one line.",
  fields: { number: optionalText(4), label: optionalText(24), heading: text(60), description: optionalText(110), footer: optionalText(48), ground },
  sample: { number: "02", heading: "Where the new users came from", description: "Four channels brought in 82% of the 31,400 new accounts.", footer: "Northwind Labs · Q3 review · 4", ground: "green" },
  render(b, { uid, T }) {
    const size = fit(b.heading, 62, [[6.2, 1], [5.4, 2], [4.6, 2], [4, 2]]);
    return dark(b.ground, `${deco(uid, "top")}${b.number ? `<div class="a-n" aria-hidden="true">${esc(b.number)}</div>` : ""}<div class="a-t">${kicker(b.label ?? T("Section", "섹션"), ";margin:0;opacity:.82;color:inherit")}${h2(b.heading, size, ";line-height:1.1;letter-spacing:-.025em")}${b.description ? `<p>${esc(b.description)}</p>` : ""}</div>`, b.footer, "justify-content:flex-end");
  },
  summary: b => [b.number ? `Section ${b.number}` : "Section", b.heading, b.description].filter(Boolean).join(" — "),
  css: sx("section_slide", `&{border:0}
.a-n{position:absolute;left:7.2cqw;top:3.6cqw;font-size:19cqw;line-height:1;font-weight:800;letter-spacing:-.05em;color:rgba(255,255,255,.24)}
.a-t{position:relative;display:flex;flex-direction:column;gap:1.5cqw;max-width:70%}
.a-t p{${clamp(2)};margin:0;font-size:2.6cqw;line-height:1.4;font-weight:500;opacity:.92}`),
});

export const closingSlide = defineAsset({
  type: "closing_slide", category: "slide", width: "half", frame: "16:9",
  use: "A closing slide on a colour ground: a thank-you or call-to-action headline, up to three next steps and a contact line.",
  useKo: "색 배경의 마무리 슬라이드: 감사·행동 제안 제목, 다음 단계 최대 3개와 연락처 한 줄.",
  tags: ["slide", "closing", "thank you", "next steps", "contact", "end", "슬라이드", "마무리", "감사", "다음 단계"],
  notes: "ground picks the colour: ink, blue, green, violet or sunset. Each next step is one short sentence with an optional date in 'when'.",
  fields: { kicker: optionalText(30), headline: text(60), steps: list(step, 1, 3).optional(), contact: optionalText(80), footer: optionalText(48), ground },
  sample: { kicker: "Thank you", headline: "Let's make Q4 the quarter we ship", ground: "ink", contact: "growth@northwind.example · northwind.example/q3", footer: "Northwind Labs · Q3 review · 17", steps: [{ text: "Approve the Team plan price change", when: "Oct 17" }, { text: "Staff the onboarding squad with two engineers", when: "Oct 24" }, { text: "Review the activation metrics together", when: "Nov 7" }] },
  render(b, { uid, T }) {
    const hs = fit(b.headline, b.steps ? 36 : 62, [[6.2, 1], [5.6, 2], [4.8, 3], [4, 3]]);
    const steps = b.steps ? `<div class="a-r">${kicker(T("Next steps", "다음 단계"), ";opacity:.82;margin-bottom:1.6cqw;color:inherit")}<ol>${b.steps.map((s: { text: string; when?: string }, i: number) => `<li><i>${i + 1}</i><div><span>${esc(s.text)}</span>${s.when ? `<em>${esc(s.when)}</em>` : ""}</div></li>`).join("")}</ol></div>` : "";
    return dark(b.ground, `${deco(uid, "corner")}<div class="a-c">${b.kicker ? kicker(b.kicker, ";margin:0;opacity:.82;color:inherit") : ""}${h2(b.headline, hs, ";-webkit-line-clamp:3;line-height:1.1;letter-spacing:-.025em")}${b.contact ? `<p>${esc(b.contact)}</p>` : ""}</div>${steps}`, b.footer, "flex-direction:row;gap:5cqw;align-items:stretch");
  },
  summary: b => [b.kicker, b.headline, b.steps?.length ? `Next: ${b.steps.map((s: { text: string; when?: string }) => `${s.text}${s.when ? ` (${s.when})` : ""}`).join("; ")}` : "", b.contact].filter(Boolean).join(" — "),
  css: sx("closing_slide", `&{border:0}
.a-c{position:relative;flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:1.4cqw}
.a-c p{${clamp(2)};margin:auto 0 0;padding-top:2cqw;font-size:2cqw;line-height:1.35;font-weight:600;opacity:.88}
.a-r{position:relative;flex:0 0 46%;min-width:0;display:flex;flex-direction:column;justify-content:center}
.a-r ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:1.4cqw}
.a-r li{display:grid;grid-template-columns:4cqw 1fr;align-items:center;gap:1.4cqw;padding:1.5cqw 1.8cqw;border-radius:1.6cqw;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.24)}
.a-r i{width:4cqw;height:4cqw;border-radius:50%;background:#fff;color:var(--ink);font-style:normal;font-size:2cqw;font-weight:800;display:flex;align-items:center;justify-content:center}
.a-r div{min-width:0;display:flex;flex-direction:column;gap:.5cqw}
.a-r span{${clamp(2)};font-size:2.2cqw;line-height:1.25;font-weight:650}
.a-r em{font-style:normal;font-size:1.8cqw;font-weight:700;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`),
});
export const ASSETS: readonly AnyAsset[] = [agendaSlide, sectionSlide, closingSlide];
