import { z } from "zod";
import { bold, esc } from "../../kit";
import { list, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { LABEL, MUTED, ROW, RULE, accent, day, docCss, hue, paras, plain } from "./_shared";

/** Prose pages: the cover, the memo, the letter, the contract page and the press release. */

export const reportCover = defineAsset({
  type: "report_cover", category: "document", width: "third", frame: "a4",
  use: "The cover page of a report, study or handout: title, subtitle, organisation, author, date and an optional Confidential tag.",
  useKo: "보고서·연구·자료집의 표지: 제목, 부제, 기관, 작성자, 날짜와 선택적인 대외비 표시.",
  tags: ["cover", "report", "title page", "front page", "표지", "보고서", "커버", "표제"],
  notes: "title is at most 80 characters. accent: blue, green, red, amber, violet or ink. tag is a short stamp such as Confidential or Draft.",
  fields: { title: text(80), subtitle: optionalText(140), organisation: optionalText(40), author: optionalText(50), date: optionalText(24), tag: optionalText(24), accent },
  sample: { title: "Annual Sustainability Report 2026", subtitle: "Emissions, energy and supply-chain progress across Northwind's operations", organisation: "Northwind Logistics", author: "Office of Sustainability · Priya Nair", date: "October 2026", tag: "Confidential", accent: "green" },
  render(b, { ko, T }) {
    return `<div class="a-pg" ${hue(b.accent, "blue", "", ko)}><div style="${ROW}"><b class="a-el" style="display:flex;align-items:center;gap:1.4cqw;font-size:2.5cqw"><i style="flex:none;width:3cqw;height:3cqw;border-radius:.6cqw;background:var(--ac)"></i>${esc(b.organisation ?? "")}</b>${b.tag ? `<em>${esc(b.tag)}</em>` : ""}</div>`
      + `<svg class="a-art" viewBox="0 0 84 54" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="84" height="54" fill="var(--at)"/><path d="M84 54V6a48 48 0 0 0-48 48z" fill="var(--ac)"/><path d="M84 54V26a28 28 0 0 0-28 28z" fill="#fff" fill-opacity=".24"/><circle cx="26" cy="16" r="7" fill="var(--ink)"/><g stroke="var(--ac)" stroke-width=".45" opacity=".55"><path d="M0 34h30M0 38h24M0 42h18M0 46h12"/></g></svg>`
      + `<h3>${T("Report", "보고서")}</h3><h2 class="a-lc">${esc(b.title)}</h2>${b.subtitle ? `<p class="a-sub a-lc">${esc(b.subtitle)}</p>` : ""}`
      + `<div style="${ROW};align-items:flex-end;gap:3cqw;margin-top:5cqw;padding-top:2.4cqw;border-top:.35cqw solid var(--ink);font-size:2.4cqw;color:var(--ink)"><div class="a-el">${b.author ? `<span style="display:block;${LABEL};font-size:1.8cqw">${T("Prepared by", "작성")}</span><b>${esc(b.author)}</b>` : ""}</div><b style="white-space:nowrap">${esc(b.date ?? "")}</b></div></div>`;
  },
  summary: b => [`${plain(b.title)} (report cover)`, b.subtitle, b.organisation, b.author, b.date, b.tag].filter(Boolean).map(plain).join(" — "),
  css: docCss("report_cover", ["pg", "fx", "h", "k", "e", "el", "lc"], `
    § .a-art{flex:1;min-height:0;width:100%;overflow:hidden;margin:4.5cqw 0 5cqw;border-radius:1.4cqw}
    § h3{font-size:var(--lb,1.9cqw)}
    § h2{--n:5;font-size:7.4cqw;line-height:1.08;margin:1.6cqw 0 2cqw}
    § .a-sub{margin:0;font-size:2.8cqw;line-height:1.4;color:var(--muted)}`),
});

export const memo = defineAsset({
  type: "memo", category: "document", width: "half", frame: "a4",
  use: "An internal memorandum: To/From/Date/Subject header, two to four paragraphs and an action-items list with owners.",
  useKo: "사내 메모: 수신·발신·날짜·제목 머리글, 2~4개 문단, 담당자가 있는 실행 항목 목록.",
  tags: ["memo", "memorandum", "internal", "note to team", "action items", "메모", "사내", "공지", "실행 항목"],
  notes: "2-4 paragraphs of at most 230 characters (**bold** allowed); up to 5 action items, each with an owner and an optional due date.",
  fields: { organisation: optionalText(40), to: text(70), from: text(70), cc: optionalText(70), date: text(24), subject: text(90), paragraphs: list(text(230), 2, 4), actions: list(z.object({ task: text(70), owner: text(20), due: optionalText(12) }).strip(), 1, 5), accent },
  sample: {
    organisation: "Calder & Finch", to: "Operations leadership team", from: "Dana Whitfield, VP Operations", cc: "Finance, Facilities", date: "", subject: "Q4 warehouse consolidation: timeline and decisions needed",
    paragraphs: ["We will consolidate the Reno and Sparks warehouses into a single site by **December 18**. The move removes 14% of fixed cost and shortens average delivery by one day for 62% of orders.", "Freight carriers are confirmed for the weekend of **November 21-22**. Receiving at Reno stops on November 14 so inventory can be counted twice before the move begins.", "Staffing: all 118 warehouse employees keep their roles. Shift leads will meet with HR on October 28 to confirm commuting support for the longer drive to the new site.", "Two decisions are open: whether to keep the Sparks cold room through January, and who signs off the revised safety plan. Both are needed by **October 23**."],
    actions: [{ task: "Confirm cold-room lease option with the landlord", owner: "Maya R.", due: "Oct 20" }, { task: "Circulate the revised safety plan for sign-off", owner: "Ibrahim K.", due: "Oct 23" }, { task: "Freeze inbound orders at Reno", owner: "Tomas L.", due: "Nov 14" }, { task: "Brief customer success on delivery windows", owner: "Aiko S.", due: "Nov 18" }], accent: "blue",
  },
  render(b, { ko, T }) {
    const row = (k: string, v: string) => `<dt style="padding-top:.3cqw;${LABEL}">${k}</dt><dd class="a-el" style="margin:0;color:var(--ink);font-weight:600">${v}</dd>`;
    return `<div class="a-pg" ${hue(b.accent, "blue", "", ko)}><div style="${ROW};align-items:baseline"><b class="a-sf" style="font-size:3.4cqw;letter-spacing:.22em;text-transform:uppercase">${T("Memorandum", "메모")}</b><span class="a-el" style="${MUTED}">${esc(b.organisation ?? "")}</span></div><div style="width:12cqw;height:.9cqw;margin:2.4cqw 0 3cqw;background:var(--ac)"></div>`
      + `<dl style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:.9cqw 3cqw;margin:0">${row(T("To", "수신"), esc(b.to))}${row(T("From", "발신"), esc(b.from))}${b.cc ? row(T("Cc", "참조"), esc(b.cc)) : ""}${row(T("Date", "날짜"), esc(day(b.date, ko)))}<dt style="padding-top:.3cqw;${LABEL}">${T("Subject", "제목")}</dt><dd class="a-sf a-lc" style="--n:2;margin:0;color:var(--ink);font-weight:700;font-size:2.6cqw;line-height:1.25">${esc(b.subject)}</dd></dl><hr style="${RULE}">`
      + `<div class="a-fl a-sf" style="font-size:2.1cqw;line-height:1.55">${paras(b.paragraphs)}</div>`
      + `<div style="margin-top:2cqw;padding:2.2cqw 2.8cqw;border-radius:1.4cqw;background:var(--surface)"><h3>${T("Action items", "실행 항목")}</h3><div style="display:grid;gap:.9cqw;margin-top:1.2cqw">${b.actions.map(a => `<div style="display:grid;grid-template-columns:2cqw minmax(0,1fr) auto 8cqw;gap:1.6cqw;align-items:center"><i style="width:1.9cqw;height:1.9cqw;border:.3cqw solid var(--ac);border-radius:.5cqw"></i><span class="a-el">${esc(a.task)}</span><em>${esc(a.owner)}</em><span class="a-el" style="${MUTED};text-align:right">${esc(a.due ?? "")}</span></div>`).join("")}</div></div></div>`;
  },
  summary: b => `Memo to ${plain(b.to)} from ${plain(b.from)}, ${plain(b.date)}: ${plain(b.subject)}. ${b.paragraphs.length} paragraphs; actions: ${b.actions.map(a => `${plain(a.task)} (${plain(a.owner)})`).join("; ")}.`,
  css: docCss("memo", ["pg", "fx", "h", "k", "p", "e", "el", "lc"], ""),
});

export const letter = defineAsset({
  type: "letter", category: "document", width: "half", frame: "a4",
  use: "A formal letter: sender block, date, recipient, salutation, two or three paragraphs, closing and a signature.",
  useKo: "공식 서한: 발신인 블록, 날짜, 수신인, 호칭, 2~3개 문단, 맺음말과 서명.",
  tags: ["letter", "formal letter", "cover letter", "correspondence", "편지", "서한", "공문", "커버레터"],
  notes: "sender and recipient are lists of up to 3 lines (name first). 2-3 paragraphs of at most 300 characters (**bold** allowed).",
  fields: { sender: list(text(54), 1, 3), date: text(24), recipient: list(text(54), 1, 3), subject: optionalText(80), salutation: text(40), paragraphs: list(text(300), 2, 3), closing: optionalText(30), signature: text(40), role: optionalText(50), accent },
  sample: {
    sender: ["Elena Marquez", "Director of Partnerships, Lumen Learning", "212 Pearl Street, Suite 4, Boston, MA 02110"], date: "", recipient: ["Mr. Anthony Rhodes", "Head of Procurement, Calder & Finch", "88 Mill Road, Providence, RI 02903"],
    subject: "Renewal of the 2027 licensing agreement", salutation: "Dear Mr. Rhodes,",
    paragraphs: ["Thank you for a productive year working together. Over the past twelve months your teams completed **4,200 course enrolments**, and the feedback from your staff has shaped three features we shipped this autumn, including the new manager dashboard.", "I am writing to propose renewing the licensing agreement for 2027 on the current terms, with the analytics add-on included at no extra charge for the first year. The renewal also locks in this year's per-seat price through December 2027.", "If this suits you, I would be glad to send a draft agreement by the end of the month and to meet in person to walk through it. Please let me know which week in November works best for you and your legal team."],
    closing: "Warm regards,", signature: "Elena Marquez", role: "Director of Partnerships", accent: "ink",
  },
  render(b, { ko, T }) {
    return `<div class="a-pg" ${hue(b.accent, "ink", "", ko)}><div style="padding-top:2.4cqw;border-top:.9cqw solid var(--ac)"><b class="a-sf a-el" style="display:block;font-size:3.1cqw;line-height:1.25">${esc(b.sender[0])}</b>${b.sender.slice(1).map(s => `<span class="a-el" style="display:block;font-size:1.85cqw;line-height:1.45;color:var(--muted)">${esc(s)}</span>`).join("")}</div>`
      + `<div style="margin:4.5cqw 0 3cqw;font-size:2.1cqw;color:var(--muted)">${esc(day(b.date, ko))}</div><div style="color:var(--ink);line-height:1.45">${b.recipient.map(s => `<div class="a-el">${esc(s)}</div>`).join("")}</div>`
      + `${b.subject ? `<b class="a-el" style="margin-top:3cqw">${esc(b.subject)}</b>` : ""}<div style="margin:3cqw 0 1.6cqw;color:var(--ink)">${esc(b.salutation)}</div><div class="a-fl a-sf" style="font-size:2.15cqw;line-height:1.55">${paras(b.paragraphs)}</div>`
      + `<div style="margin-top:1cqw;color:var(--ink)">${esc(b.closing ?? T("Sincerely,", "감사합니다."))}</div><div class="a-sg">${esc(b.signature)}</div><b>${esc(b.signature)}</b>${b.role ? `<span class="a-el" style="${MUTED}">${esc(b.role)}</span>` : ""}</div>`;
  },
  summary: b => `Letter from ${plain(b.sender[0])} to ${plain(b.recipient[0])}, ${plain(b.date)}${b.subject ? `, re: ${plain(b.subject)}` : ""}. ${b.paragraphs.length} paragraphs, signed ${plain(b.signature)}.`,
  css: docCss("letter", ["pg", "fx", "h", "p", "el"], `
    § .a-sg{margin:1.4cqw 0 .4cqw;font:italic 5.4cqw/1.1 "Snell Roundhand","Segoe Script","Bradley Hand","Brush Script MT",cursive;color:var(--ac);white-space:nowrap;overflow:hidden}`),
});

export const contractPage = defineAsset({
  type: "contract_page", category: "document", width: "half", frame: "a4",
  use: "A page of a contract or agreement: title, parties line, numbered clauses with headings and signature lines for the signers.",
  useKo: "계약서 한 면: 제목, 당사자 문구, 제목 있는 번호 조항과 서명란.",
  tags: ["contract", "agreement", "terms", "clauses", "signature", "nda", "계약서", "약관", "조항", "서명"],
  notes: "2-5 clauses (heading at most 36 characters, body at most 250); one or two signers with an optional role and date.",
  fields: { title: text(70), parties: text(150), clauses: list(z.object({ heading: text(36), body: text(250) }).strip(), 2, 5), signers: list(z.object({ name: text(36), role: optionalText(36), date: optionalText(20) }).strip(), 1, 2), reference: optionalText(40), accent },
  sample: {
    title: "Mutual Non-Disclosure Agreement", parties: "This Agreement is made on October 14, 2026 between Lumen Learning, Inc. (the Disclosing Party) and Calder & Finch LLC (the Receiving Party).",
    clauses: [{ heading: "Confidential Information", body: "Confidential Information means all non-public business, technical and financial information disclosed in writing, orally or by inspection, and marked or reasonably understood to be confidential." }, { heading: "Obligations", body: "The Receiving Party shall use the Confidential Information solely to evaluate the proposed relationship, shall protect it with at least the care it gives its own, and shall not disclose it to any third party without written consent." }, { heading: "Exclusions", body: "These obligations do not apply to information that is public through no fault of the Receiving Party, was already known to it, or is independently developed without use of the Confidential Information." }, { heading: "Term", body: "This Agreement remains in force for two years from the date above; the duty of confidence survives for five years after disclosure." }, { heading: "Governing Law", body: "This Agreement is governed by the laws of the State of Delaware, without regard to its conflict-of-law rules, and both parties submit to the courts of that State." }],
    signers: [{ name: "Elena Marquez", role: "Director of Partnerships, Lumen Learning", date: "Oct 14, 2026" }, { name: "Anthony Rhodes", role: "Head of Procurement, Calder & Finch", date: "Oct 15, 2026" }], reference: "NDA-2026-0412", accent: "ink",
  },
  render(b, { ko, T }) {
    return `<div class="a-pg" ${hue(b.accent, "ink", "", ko)}><div style="text-align:center;padding-bottom:2.6cqw;border-bottom:.25cqw solid var(--ink);margin-bottom:2.6cqw"><h2 class="a-lc" style="--n:2;font-size:3.5cqw;letter-spacing:.06em;text-transform:uppercase">${esc(b.title)}</h2><p class="a-sf" style="margin:1.6cqw 0 0;font-style:italic;font-size:1.9cqw;color:var(--muted)">${bold(b.parties)}</p></div>`
      + `<div class="a-fl a-sf" style="flex:1;font-size:2cqw;line-height:1.5">${b.clauses.map((c, i) => `<div style="display:flex;gap:1.6cqw;margin-bottom:2cqw"><span style="flex:none;width:3cqw;font-weight:800;color:var(--ac)">${i + 1}.</span><div><b style="display:block;font-size:2.1cqw">${esc(c.heading)}</b><p style="margin:.2cqw 0 0;text-align:justify">${bold(c.body)}</p></div></div>`).join("")}</div>`
      + `<div style="display:flex;gap:6cqw;margin-top:2cqw">${b.signers.map(s => `<div style="flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.45;${MUTED}"><i style="height:6.4cqw;border-bottom:.3cqw solid var(--ink);margin-bottom:1cqw"></i><b class="a-el" style="font-size:2cqw">${esc(s.name)}</b>${s.role ? `<span class="a-el">${esc(s.role)}</span>` : ""}<span class="a-el">${T("Date", "날짜")}: ${esc(s.date ?? "")}</span></div>`).join("")}</div>`
      + `<div style="${ROW};margin-top:3cqw;padding-top:1.6cqw;border-top:.2cqw solid var(--line);font-size:1.5cqw;letter-spacing:.06em;color:var(--faint)"><span class="a-el">${esc(b.reference ?? "")}</span><span>${T("Page 1", "1쪽")}</span></div></div>`;
  },
  summary: b => `${plain(b.title)}: ${plain(b.parties)} Clauses: ${b.clauses.map((c, i) => `${i + 1}. ${plain(c.heading)}`).join("; ")}. Signers: ${b.signers.map(s => plain(s.name)).join(", ")}.`,
  css: docCss("contract_page", ["pg", "fx", "h", "p", "el", "lc"], ""),
});

export const pressRelease = defineAsset({
  type: "press_release", category: "document", width: "half", frame: "a4",
  use: "A press release: dateline, headline, subhead, body paragraphs, the About boilerplate and a media contact.",
  useKo: "보도자료: 발신지·날짜, 제목, 부제, 본문 문단, 회사 소개와 언론 문의처.",
  tags: ["press release", "announcement", "media", "news release", "boilerplate", "보도자료", "언론", "발표", "공지"],
  notes: "headline at most 80 characters; 2-3 paragraphs of at most 320 characters; the dateline opens the first paragraph.",
  fields: { organisation: text(40), release: optionalText(30), dateline: text(48), headline: text(80), subhead: optionalText(120), paragraphs: list(text(320), 2, 3), about: text(220), contact: z.object({ name: text(40), email: optionalText(50), phone: optionalText(24) }).strip(), accent },
  sample: {
    organisation: "Northwind Logistics", release: "For immediate release", dateline: "PORTLAND, Ore., Oct. 14, 2026", headline: "Northwind Logistics cuts delivery emissions 31% with an all-electric fleet",
    subhead: "The 400-vehicle fleet now covers every route inside the Pacific Northwest.",
    paragraphs: ["Northwind Logistics today announced that its regional delivery fleet is fully electric, ending a three-year transition that began with a 12-vehicle pilot in Portland and grew to 400 vehicles across Oregon, Washington and Idaho.", "The change removes an estimated **18,600 tonnes** of CO2 a year and is expected to lower fuel and maintenance cost per parcel by 9% by the end of 2027, as depots complete their move to overnight charging.", "\"Customers asked for faster delivery and a smaller footprint,\" said Priya Nair, Chief Sustainability Officer. \"With electric vans we can now offer both, and our drivers tell us the routes are quieter and calmer.\""],
    about: "Northwind Logistics is a regional carrier delivering 2.4 million parcels a month across the Pacific Northwest. Founded in 2009, the company employs 3,100 people.", contact: { name: "Jordan Ellis, Communications", email: "press@northwind.example", phone: "+1 503 555 0142" }, accent: "green",
  },
  render(b, { ko, T }) {
    const [first, ...rest] = b.paragraphs;
    return `<div class="a-pg" ${hue(b.accent, "blue", "", ko)}><div style="${ROW}"><b class="a-el" style="display:flex;align-items:center;gap:1.4cqw"><i style="flex:none;width:2.4cqw;height:2.4cqw;border-radius:.5cqw;background:var(--ac)"></i>${esc(b.organisation)}</b><h3 style="white-space:nowrap">${esc(b.release ?? T("For immediate release", "즉시 배포"))}</h3></div><hr style="width:100%;border:0;border-top:.5cqw solid var(--ink);margin:2.2cqw 0 3cqw">`
      + `<h2 class="a-lc" style="--n:4;font-size:5.4cqw;line-height:1.12">${esc(b.headline)}</h2>${b.subhead ? `<p class="a-sf a-lc" style="--n:2;margin:1.8cqw 0 3cqw;font-style:italic;font-size:2.6cqw;line-height:1.4;color:var(--muted)">${esc(b.subhead)}</p>` : ""}`
      + `<div class="a-fl a-sf" style="font-size:2.15cqw;line-height:1.55"><p><b style="letter-spacing:.04em;font-size:1.9cqw">${esc(b.dateline)}</b> — ${bold(first)}</p>${paras(rest)}<div style="text-align:center;letter-spacing:.5em;color:var(--faint);font-weight:700">###</div></div>`
      + `<div style="display:grid;grid-template-columns:1.5fr 1fr;gap:4cqw;margin-top:2.4cqw;padding-top:2.4cqw;border-top:.25cqw solid var(--line);font-size:1.75cqw;line-height:1.45"><div><h3>${T("About", "소개")} ${esc(b.organisation)}</h3><p class="a-lc" style="--n:4;margin:.8cqw 0 0;color:var(--muted)">${esc(b.about)}</p></div><div style="min-width:0;display:flex;flex-direction:column"><h3 style="margin-bottom:.8cqw">${T("Media contact", "언론 문의")}</h3><b class="a-el">${esc(b.contact.name)}</b>${b.contact.email ? `<span class="a-el" style="color:var(--muted)">${esc(b.contact.email)}</span>` : ""}${b.contact.phone ? `<span class="a-el" style="color:var(--muted)">${esc(b.contact.phone)}</span>` : ""}</div></div></div>`;
  },
  summary: b => `Press release, ${plain(b.dateline)}: ${plain(b.headline)}${b.subhead ? ` — ${plain(b.subhead)}` : ""}. Contact: ${plain(b.contact.name)}.`,
  css: docCss("press_release", ["pg", "fx", "h", "k", "p", "el", "lc"], ""),
});

export const ASSETS: readonly AnyAsset[] = [reportCover, memo, letter, contractPage, pressRelease];
