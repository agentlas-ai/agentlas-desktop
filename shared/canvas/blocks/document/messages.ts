import { z } from "zod";
import { bold, esc, icon } from "../../kit";
import { list, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { accent, day, docCss, hue, initials, optList, plain } from "./_shared";

/** Message views that flow with the card (no page frame): an email and a two-person chat thread. */

const avatar = (name: string, size: number, extra = "") => `<i style="flex:none;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:var(--ac);color:#fff;font-style:normal;font-weight:750;font-size:${Math.round(size * 0.38)}px;letter-spacing:.02em;${extra}">${esc(initials(name))}</i>`;
const MUTED = "font-size:12.5px;color:var(--muted)";

export const emailMessage = defineAsset({
  type: "email_message", category: "document", width: "two_thirds",
  use: "One email as a mail client shows it: sender, recipients, date, subject, label chips, body paragraphs and an optional quoted reply and attachments.",
  useKo: "메일 화면 형태의 이메일 한 통: 보낸 사람, 받는 사람, 날짜, 제목, 라벨, 본문 문단, 선택적 인용 답장과 첨부.",
  tags: ["email", "mail", "message", "inbox", "reply", "draft", "이메일", "메일", "편지함", "답장", "초안"],
  notes: "1-4 body paragraphs of at most 520 characters (**bold** allowed). quote is the earlier message being replied to; attachments are file names.",
  fields: { subject: text(110), fromName: text(40), fromEmail: optionalText(50), to: text(80), cc: optionalText(80), date: text(30), labels: optList(text(16), 4), paragraphs: list(text(520), 1, 4), attachments: optList(text(36), 3), quote: z.preprocess(v => (v === null ? undefined : v), z.object({ who: text(60), text: text(300) }).strip().optional()), accent },
  sample: {
    subject: "Re: Q4 launch checklist and the November 3 date", fromName: "Dana Whitfield", fromEmail: "dana@calderfinch.example", to: "me, Maya Okafor", cc: "Ibrahim Khan", date: "Oct 14, 2026, 9:12 AM", labels: ["Inbox", "Launch", "Important"],
    paragraphs: ["Thanks for the quick turnaround. I read through the checklist last night and I think we can hold **November 3** for the launch if two things happen this week.", "First, legal needs to sign off the revised terms by Thursday. Second, the support team wants a dry run of the new help centre on Friday morning, so could you make sure the staging site is ready by then?", "I have attached the updated timeline. Let me know if anything looks off and I will adjust before the leadership sync.", "Best, Dana"],
    attachments: ["Launch-timeline-v3.pdf", "Support-dry-run-plan.docx"], quote: { who: "On Oct 13, 2026, Maya Okafor wrote", text: "The design work is done and engineering says the build will be ready by the end of the week. Are we still aiming for November 3, or should we plan for the following Monday?" }, accent: "blue",
  },
  render(b, { ko, T }) {
    const chips = (b.labels ?? []).map(l => `<em>${esc(l)}</em>`).join("");
    const body = b.paragraphs.map(p => `<p>${bold(p)}</p>`).join("");
    return `<div class="a-em" ${hue(b.accent, "blue")}><div style="height:3px;background:var(--ac)"></div><div style="padding:18px 22px 14px"><div style="font-size:19px;line-height:1.3;font-weight:750;color:var(--ink);overflow-wrap:anywhere">${esc(b.subject)}</div>${chips ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${chips}</div>` : ""}</div>`
      + `<div style="display:flex;gap:12px;align-items:flex-start;padding:0 22px 14px">${avatar(b.fromName, 40)}<div style="min-width:0;flex:1"><div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline"><div class="a-el"><b style="font-size:14.5px;color:var(--ink)">${esc(b.fromName)}</b>${b.fromEmail ? ` <span style="${MUTED}">&lt;${esc(b.fromEmail)}&gt;</span>` : ""}</div><span style="flex:none;${MUTED}">${esc(day(b.date, ko))}</span></div><div class="a-el" style="${MUTED}">${T("to", "받는 사람")} ${esc(b.to)}</div>${b.cc ? `<div class="a-el" style="${MUTED}">${T("cc", "참조")} ${esc(b.cc)}</div>` : ""}</div></div>`
      + `<div class="a-bd">${body}</div>`
      + `${b.attachments ? `<div style="display:flex;flex-wrap:wrap;gap:8px;padding:0 22px 16px">${b.attachments.map(a => `<span class="a-el" style="display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;font-weight:650;color:var(--ink2)">${icon("doc", 14)}${esc(a)}</span>`).join("")}</div>` : ""}`
      + `${b.quote ? `<div style="margin:0 22px 20px;padding:2px 0 2px 14px;border-left:3px solid var(--line);font-size:13.5px;line-height:1.5;color:var(--muted)"><div style="font-weight:650;margin-bottom:4px">${esc(b.quote.who)}:</div><div class="a-lc" style="--n:4">${esc(b.quote.text)}</div></div>` : ""}</div>`;
  },
  summary: b => `Email from ${plain(b.fromName)} to ${plain(b.to)}, ${plain(b.date)}: ${plain(b.subject)}. ${plain(b.paragraphs[0])}${b.attachments ? ` Attachments: ${b.attachments.map(plain).join(", ")}.` : ""}`,
  css: docCss("email_message", ["el", "lc"], `
    § .a-em{overflow:hidden;border:1px solid var(--line);border-radius:14px;background:#fff;font-size:14.5px;line-height:1.6;color:var(--ink2)}
    § .a-em em{padding:2px 10px;border-radius:99px;background:var(--at);color:var(--ac);font-style:normal;font-size:12px;font-weight:700}
    § .a-bd{padding:2px 22px 4px;overflow-wrap:anywhere}
    § .a-bd p{margin:0 0 12px}
    § b{color:var(--ink)}`),
});

export const chatThread = defineAsset({
  type: "chat_thread", category: "document", width: "half",
  use: "A chat conversation between two people: speech bubbles with names and times, and an optional day divider.",
  useKo: "두 사람의 대화: 이름과 시간이 있는 말풍선, 선택적인 날짜 구분선.",
  tags: ["chat", "conversation", "messages", "thread", "dm", "bubbles", "채팅", "대화", "메신저", "말풍선", "카톡"],
  notes: "2-10 messages; the first sender is on the left, the other on the right. Each message at most 200 characters. Add title for the conversation name.",
  fields: { day: optionalText(24), messages: list(z.object({ from: text(24), time: optionalText(12), text: text(200) }).strip(), 2, 10), accent },
  sample: {
    title: "Maya Chen and Daniel Ortiz", day: "Tuesday, Oct 13",
    messages: [{ from: "Maya Chen", time: "9:41", text: "Morning! Did the vendor send the revised quote?" }, { from: "Daniel Ortiz", time: "9:43", text: "Just landed. It's 8% lower than the first one, and they added free onboarding." }, { from: "Daniel Ortiz", time: "9:43", text: "Forwarding it to you now." }, { from: "Maya Chen", time: "9:47", text: "Perfect. If the numbers hold I'll take it to finance this afternoon." }, { from: "Daniel Ortiz", time: "9:48", text: "Great. One catch: the price is only valid until Friday." }, { from: "Maya Chen", time: "9:50", text: "Then let's move fast. Can you join the 2 pm call?" }, { from: "Daniel Ortiz", time: "9:51", text: "Yes, I'll be there. I'll bring the comparison sheet." }],
    accent: "blue",
  },
  render(b) {
    const first = b.messages[0].from, names = [...new Set(b.messages.map(m => m.from))].slice(0, 2);
    let prev = "";
    const rows = b.messages.map(m => {
      const mine = m.from !== first, head = m.from !== prev; prev = m.from;
      return `<div class="a-${mine ? "r" : "l"}">${head ? `<div class="a-nm">${esc(m.from)}</div>` : ""}<div class="a-bb">${esc(m.text)}${m.time ? `<i>${esc(m.time)}</i>` : ""}</div></div>`;
    }).join("");
    const divider = b.day ? `<div style="display:flex;align-items:center;gap:10px;margin:0 0 4px;font-size:11.5px;font-weight:700;color:var(--faint)"><i style="flex:1;height:1px;background:var(--line)"></i><span class="a-el">${esc(b.day)}</span><i style="flex:1;height:1px;background:var(--line)"></i></div>` : "";
    return `<div class="a-ch" ${hue(b.accent, "blue")}><div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)"><div style="display:flex">${names.map((n, i) => avatar(n, 30, `${i ? "margin-left:-6px;" : ""}border:2px solid #fff;${i ? "background:var(--ink2)" : ""}`)).join("")}</div><div class="a-el" style="font-size:14.5px;font-weight:750;color:var(--ink)">${esc(b.title ?? names.join(" · "))}</div></div><div class="a-ms">${divider}${rows}</div></div>`;
  },
  summary: b => `Chat${b.title ? ` ${plain(b.title)}` : ""}${b.day ? `, ${plain(b.day)}` : ""}: ${b.messages.map(m => `${plain(m.from)}${m.time ? ` ${plain(m.time)}` : ""}: ${plain(m.text)}`).join(" / ")}`,
  css: docCss("chat_thread", ["el"], `
    § .a-ch{overflow:hidden;border:1px solid var(--line);border-radius:16px;background:#fff;font-size:14px;line-height:1.45}
    § .a-ms{display:flex;flex-direction:column;gap:4px;padding:14px 16px 16px}
    § .a-l,§ .a-r{display:flex;flex-direction:column;gap:2px;max-width:82%}
    § .a-r{align-self:flex-end;align-items:flex-end}
    § .a-nm{margin:6px 6px 0;font-size:11.5px;font-weight:650;color:var(--muted)}
    § .a-bb{padding:8px 13px;border-radius:16px;overflow-wrap:anywhere}
    § .a-l .a-bb{background:var(--surface);color:var(--ink);border-bottom-left-radius:5px}
    § .a-r .a-bb{background:var(--ac);color:#fff;border-bottom-right-radius:5px}
    § .a-bb i{float:right;margin:7px 0 -2px 12px;font-style:normal;font-size:11px;line-height:1.3;opacity:.65}`),
});

export const ASSETS: readonly AnyAsset[] = [emailMessage, chatThread];
