import { z } from "zod";
import { date, loose, optionalText, text } from "../../fields";
import { defineAsset, sampleDay, type AnyAsset } from "../contract";
import { INK, INK2, KINDS, MUTED, avatarColor, circle, docIcon, fileFields, fit, flag, glyph, hash, initials, kindOf, nullable, optList, plural, r1, rect, rng, shadow, shadowDefs, tile, tileCss, tw, txt, wholeNum, wrap } from "./_shared";

/** The objects that are not files but are browsed like them: a folder, a web link, a mail, an event, a contact, a place and a note. */

// ---- folder_card ------------------------------------------------------------------------------------------------------------------------
const AMBER = KINDS.folder.color;
export const folderCard = defineAsset({
  type: "folder_card", category: "thumbnail", width: "third", frame: "thumb",
  use: "A folder as a preview tile: a folder shape with its item count, a few child names as chips and the total size.",
  useKo: "폴더를 미리보기 타일로 보여줍니다: 항목 수가 적힌 폴더 모양, 안에 든 이름 몇 개, 전체 크기.",
  tags: ["folder", "directory", "files", "project", "collection", "폴더", "디렉터리", "디렉토리", "썸네일"],
  notes: "children are up to 5 names inside (a trailing / marks a sub-folder); items is the total count of things in the folder.",
  fields: { ...fileFields, items: wholeNum, children: optList(text(40), 0, 5) },
  sample: { name: "Launch campaign", items: 128, size: "2.3 GB", modified: "Today", children: ["Brand guidelines.pdf", "Press kit/", "launch-film-final.mp4", "Budget-2027.xlsx", "Social posts/"] },
  render(b, { ko, T, uid }) {
    const count = b.items ?? b.children?.length;
    let s = `<defs>${shadowDefs(uid)}<linearGradient id="${uid}-f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8c758"/><stop offset="1" stop-color="#e29a10"/></linearGradient></defs>`;
    s += `<g transform="translate(${(b.children ?? []).length ? 0 : 98} 0)"><path d="M18 40a9 9 0 0 1 9-9h44a9 9 0 0 1 6.5 2.8l9 9.4a9 9 0 0 0 6.5 2.8H177a9 9 0 0 1 9 9V162a9 9 0 0 1-9 9H27a9 9 0 0 1-9-9Z" fill="#c98a0e"/>`;
    s += `<g transform="rotate(-3 100 80)">${rect(32, 48, 138, 70, "#fff", { rx: 4, filter: shadow(uid) })}${rect(40, 58, 70, 4, "#d9dfdb", { rx: 2 })}${rect(40, 67, 100, 3, "#e6eae8", { rx: 1.5 })}</g><g transform="rotate(2 100 80)">${rect(36, 54, 138, 66, "#f4f6f5", { rx: 4, stroke: "#e1e5e2" })}</g>`;
    s += `<path d="M18 78a9 9 0 0 1 9-9H177a9 9 0 0 1 9 9V162a9 9 0 0 1-9 9H27a9 9 0 0 1-9-9Z" fill="url(#${uid}-f)"/>`;
    if (count !== undefined) s += txt(102, 132, count.toLocaleString(ko ? "ko-KR" : "en-US"), count >= 10000 ? 28 : 34, { fill: "#fff", w: 800, anchor: "middle" }) + txt(102, 152, T(count === 1 ? "item" : "items", "항목"), 11.5, { fill: "#fff", w: 700, anchor: "middle", opacity: 0.92 });
    s += "</g>";
    (b.children ?? []).forEach((child, i) => {
      const isDir = child.endsWith("/"), name = isDir ? child.slice(0, -1) : child, label = fit(name, 10.8, 140, true), y = 20 + i * 32, w = tw(label, 10.8, true) + 42;
      s += rect(204, y, w, 26, "#fff", { rx: 13, stroke: "#e1e5e2" });
      s += isDir ? `<path d="M214 ${y + 8.5}a1.8 1.8 0 0 1 1.8-1.8h3.6l1.6 1.8h4.2a1.8 1.8 0 0 1 1.8 1.8v6.4a1.8 1.8 0 0 1-1.8 1.8h-9.4a1.8 1.8 0 0 1-1.8-1.8Z" fill="${AMBER}"/>` : docIcon(215, y + 5.5, KINDS[kindOf(name)].color);
      s += txt(232, y + 17.4, label, 10.8, { fill: INK2, w: 650 });
    });
    return tile({ label: T("FOLDER", "폴더"), name: b.name, meta: [count !== undefined ? plural(count, "item", "items", "개 항목", ko) : undefined, b.size, b.modified], svg: s });
  },
  summary: b => `Folder ${b.name}${b.items !== undefined ? `, ${b.items} items` : ""}${b.size ? `, ${b.size}` : ""}${b.children?.length ? `. Contains ${b.children.join(", ")}` : ""}.`,
  css: tileCss("folder_card", AMBER),
});

// ---- link_card --------------------------------------------------------------------------------------------------------------------------
const HERO = [["#2f5fd6", "#7aa2ff", "#38d39f"], ["#d6336c", "#f08a24", "#ffd27a"], ["#118558", "#38d39f", "#d9f2c4"], ["#7048e8", "#a855f7", "#7aa2ff"], ["#0b7285", "#22b8cf", "#ffd27a"], ["#14202a", "#2f5fd6", "#d6336c"]];
/** The hero strip of a link: shapes and a gradient drawn from the domain alone (no favicon, no image fetched), so a site always gets the same picture. */
function hero(u: string, domain: string): string {
  const h = hash(domain), pal = HERO[h % HERO.length], rand = rng(h);
  const cx = 240 + rand() * 110, cy = 8 + rand() * 40, tilt = Math.round(rand() * 50 - 25);
  let dots = ""; for (let i = 0; i < 4; i++) for (let j = 0; j < 7; j++) dots += `<circle cx="${22 + j * 9}" cy="${14 + i * 9}" r="1.3" fill="#fff" opacity=".4"/>`;
  return `<defs><linearGradient id="${u}-h" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pal[0]}"/><stop offset="1" stop-color="${pal[1]}"/></linearGradient></defs><rect width="400" height="74" fill="url(#${u}-h)"/>`
    + `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(40 + rand() * 18)}" fill="${pal[2]}" opacity=".55"/><circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(58 + rand() * 12)}" fill="none" stroke="#fff" stroke-opacity=".35"/>`
    + `<g transform="rotate(${tilt} 130 40)"><rect x="96" y="22" width="62" height="40" rx="9" fill="#fff" opacity=".2"/><rect x="118" y="36" width="62" height="40" rx="9" fill="${pal[2]}" opacity=".45"/></g>${dots}`
    + `<path d="M0 62C60 52 120 70 200 60S340 52 400 62V74H0Z" fill="#fff" opacity=".16"/>`;
}
export const linkCard = defineAsset({
  type: "link_card", category: "thumbnail", width: "third", frame: "thumb",
  use: "A web link as a preview tile: a generated hero strip, the domain, the page title and a short description.",
  useKo: "웹 링크를 미리보기 타일로 보여줍니다: 그려진 대표 이미지 띠, 도메인, 페이지 제목, 짧은 설명.",
  tags: ["link", "url", "website", "web page", "article", "bookmark", "링크", "웹사이트", "기사", "북마크"],
  notes: "name is the page title; domain like example.com (no https://); description is one or two sentences. The picture is drawn from the domain; nothing is fetched.",
  fields: { name: text(100), domain: text(50), description: optionalText(200), readTime: optionalText(16), published: optionalText(20) },
  sample: { name: "How we cut our cloud bill by 40% without slowing down", domain: "engineering.northwind.dev", description: "A practical walk-through of right-sizing, spot capacity and the cache changes that paid for themselves in a week.", readTime: "7 min read", published: "Oct 21" },
  render(b, { uid, T }) {
    const pal = HERO[hash(b.domain) % HERO.length], dom = b.domain.replace(/^https?:\/\//, "").replace(/^www\./, "");
    let s = rect(0, 0, 400, 195, "#fff") + hero(uid, b.domain);
    s += circle(30, 96, 8.8, pal[0]) + txt(30, 99.6, initials(dom).slice(0, 1), 10, { fill: "#fff", w: 800, anchor: "middle" }) + txt(45, 100, fit(dom, 10.8, 340), 10.8, { fill: MUTED, w: 650 });
    let y = 124; for (const l of wrap(b.name, 13.6, 360, 2, true)) { s += txt(20, y, l, 13.6, { w: 800 }); y += 16.5; }
    if (b.description) { y += 2; for (const l of wrap(b.description, 10, 360, y < 150 ? 3 : 2)) { s += txt(20, y, l, 10, { fill: INK2, w: 500 }); y += 13.2; } }
    return tile({ label: T("LINK", "링크"), name: b.name, meta: [dom, b.readTime, b.published], svg: s });
  },
  summary: b => `Link to ${b.domain}: ${b.name}${b.description ? `. ${b.description}` : ""}${b.readTime ? ` (${b.readTime})` : ""}`.slice(0, 390),
  css: tileCss("link_card", KINDS.link.color),
});

// ---- email_thumb ------------------------------------------------------------------------------------------------------------------------
export const emailThumb = defineAsset({
  type: "email_thumb", category: "thumbnail", width: "third", frame: "thumb",
  use: "An email as a preview tile: the sender with an initials avatar, the opening of the message and the attachment count.",
  useKo: "이메일을 미리보기 타일로 보여줍니다: 이니셜 아바타가 있는 보낸 사람, 본문 첫 부분, 첨부 개수.",
  tags: ["email", "mail", "message", "inbox", "attachment", "gmail", "이메일", "메일", "편지", "받은편지함"],
  notes: "subject is the strip title; snippet is the first sentences of the body (four lines are drawn); unread draws a blue dot; time like 9:41 AM or Yesterday.",
  fields: { subject: text(100), sender: text(40), address: optionalText(50), snippet: text(260), attachments: wholeNum, time: optionalText(20), unread: flag },
  sample: { subject: "Re: Contract renewal terms for 2027", sender: "Dana Reyes", address: "dana.reyes@northwind.com", snippet: "Thanks for the quick turnaround. I have attached the revised terms with the volume discount we discussed. Could you confirm the start date by Friday so legal can countersign?", attachments: 2, time: "9:41 AM", unread: true },
  render(b, { ko, T, uid }) {
    const color = avatarColor(b.sender);
    let s = `<defs>${shadowDefs(uid)}</defs>` + rect(20, 14, 360, 210, "#fff", { rx: 10, filter: shadow(uid) });
    s += circle(47, 44, 15, color) + txt(47, 48.6, initials(b.sender), 11.5, { fill: "#fff", w: 800, anchor: "middle" });
    s += txt(70, 42, fit(b.sender, 12.5, 260, true), 12.5, { w: 800 }) + (b.address ? txt(70, 55.4, fit(b.address, 9.2, 260), 9.2, { fill: MUTED, w: 500 }) : "");
    if (b.unread) s += circle(362, 42, 4.6, KINDS.link.color);
    s += rect(34, 70, 332, 1, "#eceeec");
    wrap(b.snippet, 10.2, 330, 4).forEach((l, i) => { s += txt(35, 90 + i * 15.2, l, 10.2, { fill: INK2, w: 500 }); });
    if (b.attachments) { const label = plural(b.attachments, "attachment", "attachments", "개 첨부", ko), w = tw(label, 9.6, true) + 34; s += rect(34, 152, w, 22, "#eef2f7", { rx: 11 }) + glyph("clip", 43, 157.5, 11, INK2, 2.4) + txt(59, 166.4, label, 9.6, { fill: INK2, w: 700 }); }
    return tile({ label: T("MAIL", "메일"), name: b.subject, meta: [b.time, b.unread ? T("Unread", "안 읽음") : undefined, b.address ? undefined : b.sender], svg: s });
  },
  summary: b => `Email from ${b.sender}${b.time ? ` at ${b.time}` : ""}${b.unread ? " (unread)" : ""}: ${b.subject}. ${b.snippet}${b.attachments ? ` ${b.attachments} attachments.` : ""}`.slice(0, 390),
  css: tileCss("email_thumb", KINDS.link.color),
});

// ---- calendar_event ---------------------------------------------------------------------------------------------------------------------
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], DAYS_KO = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const RED = "#d93a2f";
export const calendarEvent = defineAsset({
  type: "calendar_event", category: "thumbnail", width: "third", frame: "thumb",
  use: "A calendar event as a preview tile: a date tile, the title, the time range, the place and the attendees as initials.",
  useKo: "일정을 미리보기 타일로 보여줍니다: 날짜 타일, 제목, 시간대, 장소, 참석자 이니셜.",
  tags: ["calendar", "event", "meeting", "schedule", "appointment", "invite", "일정", "캘린더", "회의", "약속"],
  notes: "date is YYYY-MM-DD; start and end like 2:00 PM or 14:00; attendees are up to 8 names (five avatars are drawn, the rest become +N).",
  fields: { name: text(80), date, start: text(12), end: optionalText(12), location: optionalText(50), attendees: optList(text(32), 0, 8) },
  sample: { name: "Q4 planning workshop", date: sampleDay(164), start: "2:00 PM", end: "3:30 PM", location: "Room 4B · Seoul HQ", attendees: ["Dana Reyes", "Min-jun Park", "Sofia Alvarez", "Liam O'Brien", "Aiko Tanaka", "Noah Kim"] },
  render(b, { ko, T, uid }) {
    const d = new Date(`${b.date}T00:00:00Z`), month = ko ? `${d.getUTCMonth() + 1}월` : MONTHS[d.getUTCMonth()], day = d.getUTCDate(), weekday = (ko ? DAYS_KO : DAYS)[d.getUTCDay()], range = b.end ? `${b.start} – ${b.end}` : b.start;
    let s = `<defs>${shadowDefs(uid)}</defs>` + rect(22, 20, 108, 152, "#fff", { rx: 12, filter: shadow(uid) }) + `<path d="M22 32a12 12 0 0 1 12-12h84a12 12 0 0 1 12 12v22H22Z" fill="${RED}"/>`;
    s += txt(76, 43, month, 13, { fill: "#fff", w: 800, anchor: "middle", ls: ko ? 0 : 1.6 }) + txt(76, 108, String(day), 52, { w: 800, anchor: "middle" }) + txt(76, 145, weekday, 11.5, { fill: MUTED, w: 650, anchor: "middle" });
    s += rect(146, 20, 234, 98, "#fdeceb", { rx: 12 }) + rect(146, 20, 5, 98, RED, { rx: 2.5 });
    s += txt(164, 43, fit(b.name, 12.5, 202, true), 12.5, { w: 800 }) + txt(164, 70, fit(range, 17, 202, true), 17, { fill: "#a52a21", w: 800 });
    if (b.location) s += glyph("pin", 163, 82.5, 13, "#a52a21", 2.3) + txt(180, 93.5, fit(b.location, 10.4, 186), 10.4, { fill: INK2, w: 600 });
    const people = b.attendees ?? [], shown = people.slice(0, 5), extra = people.length - shown.length;
    shown.forEach((p, i) => { s += circle(162 + i * 23, 146, 13.5, avatarColor(p), { stroke: "#fff", sw: 2.2 }) + txt(162 + i * 23, 149.4, initials(p), 8.6, { fill: "#fff", w: 800, anchor: "middle" }); });
    if (extra > 0) s += circle(162 + shown.length * 23, 146, 13.5, "#e6e9e7", { stroke: "#fff", sw: 2.2 }) + txt(162 + shown.length * 23, 149.4, `+${extra}`, 9, { fill: INK2, w: 800, anchor: "middle" });
    if (people.length) s += txt(162 + (shown.length + (extra > 0 ? 1 : 0)) * 23 + 4, 150, ko ? `${people.length}명 참석` : `${people.length} ${T("going", "참석")}`, 10, { fill: MUTED, w: 650 });
    return tile({ label: T("EVENT", "일정"), name: b.name, meta: [range, b.location], svg: s });
  },
  summary: b => `Event ${b.name} on ${b.date}, ${b.end ? `${b.start} to ${b.end}` : b.start}${b.location ? ` at ${b.location}` : ""}${b.attendees?.length ? `, ${b.attendees.length} attendees` : ""}.`,
  css: tileCss("calendar_event", RED),
});

// ---- contact_card -----------------------------------------------------------------------------------------------------------------------
export const contactCard = defineAsset({
  type: "contact_card", category: "thumbnail", width: "third", frame: "thumb",
  use: "A person as a preview tile: an initials avatar with the name, role, company and the phone and email lines.",
  useKo: "사람(연락처)을 미리보기 타일로 보여줍니다: 이니셜 아바타와 이름, 직책, 회사, 전화·이메일.",
  tags: ["contact", "person", "profile", "business card", "address book", "phone", "연락처", "사람", "명함", "프로필"],
  notes: "Everything but name is optional; the avatar colour comes from the name.",
  fields: { name: text(50), role: optionalText(50), company: optionalText(50), phone: optionalText(28), email: optionalText(60) },
  sample: { name: "Dana Reyes", role: "VP of Partnerships", company: "Northwind Traders", phone: "+1 (415) 555-0142", email: "dana.reyes@northwind.com" },
  render(b, { T, uid }) {
    const color = avatarColor(b.name), lines = [b.phone && ["phone", b.phone], b.email && ["mail", b.email]].filter((x): x is string[] => !!x);
    let s = `<defs>${shadowDefs(uid)}<linearGradient id="${uid}-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".72"/></linearGradient></defs>` + rect(34, 18, 332, 156, "#fff", { rx: 13, filter: shadow(uid) });
    s += circle(88, 96, 34, `url(#${uid}-a)`) + circle(88, 96, 34, "none", { stroke: "#fff", sw: 2, opacity: 0.5 }) + txt(88, 105, initials(b.name), 25, { fill: "#fff", w: 800, anchor: "middle" });
    const top = lines.length ? 62 : 80; let y = top;
    s += txt(140, y, fit(b.name, 17, 212, true), 17, { w: 800 }); y += 17;
    if (b.role) { s += txt(140, y, fit(b.role, 10.6, 212), 10.6, { fill: MUTED, w: 600 }); y += 15; }
    if (b.company) { s += txt(140, y, fit(b.company, 10.6, 212, true), 10.6, { fill: INK2, w: 700 }); y += 15; }
    if (lines.length) { y += 3; s += rect(140, y, 212, 1, "#e6e9e7"); y += 16; lines.forEach(([g, t]) => { s += glyph(g, 140, y - 9.4, 12.5, g === "mail" ? KINDS.link.color : MUTED, 2.3) + txt(158, y, fit(t, 10.2, 192), 10.2, { fill: g === "mail" ? KINDS.link.color : INK2, w: 600 }); y += 17; }); }
    return tile({ label: T("CONTACT", "연락처"), name: b.name, meta: [b.role, b.company], svg: s });
  },
  summary: b => `Contact ${b.name}${b.role ? `, ${b.role}` : ""}${b.company ? ` at ${b.company}` : ""}${b.phone ? `, phone ${b.phone}` : ""}${b.email ? `, email ${b.email}` : ""}.`,
  css: tileCss("contact_card", "#0ca678"),
});

// ---- location_card ----------------------------------------------------------------------------------------------------------------------
export const locationCard = defineAsset({
  type: "location_card", category: "thumbnail", width: "third", frame: "thumb",
  use: "A place as a preview tile: an abstract map with roads, blocks, water and a pin, with the place name and address.",
  useKo: "장소를 미리보기 타일로 보여줍니다: 도로·블록·물이 그려진 추상 지도와 핀, 장소 이름과 주소.",
  tags: ["location", "place", "map", "address", "venue", "pin", "위치", "장소", "지도", "주소"],
  notes: "The map is a drawing seeded by the name (not the real streets). category like Café or Office; distance like 0.4 mi.",
  fields: { name: text(70), address: text(100), category: optionalText(24), distance: optionalText(14) },
  sample: { name: "Seongsu Roastery", address: "14 Achasan-ro 7-gil, Seongdong-gu, Seoul", category: "Café", distance: "0.4 km" },
  render(b, { T, uid }) {
    const h = hash(b.name), fx = h & 1, fy = h & 2, rand = rng(h);
    let blocks = ""; const xs = [-10, 64, 148, 232, 318, 410], ys = [-10, 44, 100, 154, 205];
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) { const x = xs[i] + 6 + rand() * 3, y = ys[j] + 6 + rand() * 3; blocks += rect(x, y, xs[i + 1] - xs[i] - 12 - rand() * 4, ys[j + 1] - ys[j] - 12 - rand() * 3, rand() > 0.72 ? "#d6dccd" : "#e2e6da", { rx: 5 }); }
    let trees = ""; for (let i = 0; i < 9; i++) trees += circle(300 + rand() * 90, 4 + rand() * 54, 3 + rand() * 3, "#b3d6a2", { opacity: 0.9 });
    const map = rect(0, 0, 400, 195, "#f3f4ee") + blocks + rect(300, -8, 120, 74, "#cfe7c2", { rx: 18 }) + trees
      + `<path d="M-4 112C28 106 58 124 92 142C122 158 146 178 168 205H-4Z" fill="#b8d8ee"/><path d="M-4 112C28 106 58 124 92 142C122 158 146 178 168 205" fill="none" stroke="#9cc6e4" stroke-width="2"/>`
      + `<path d="M-6 150L406 36" stroke="#f1d38a" stroke-width="13" stroke-linecap="round"/><path d="M-6 150L406 36" stroke="#fdebb4" stroke-width="9" stroke-linecap="round"/>`
      + `<path d="M232 -6L262 205" stroke="#fff" stroke-width="7"/>`;
    let s = `<defs>${shadowDefs(uid, 1.5, 2, 0.28)}</defs><g transform="translate(${fx ? 400 : 0} ${fy ? 195 : 0}) scale(${fx ? -1 : 1} ${fy ? -1 : 1})">${map}</g>`;
    s += circle(200, 104, 26, "#e03131", { opacity: 0.13 }) + `<ellipse cx="200" cy="104" rx="9" ry="3" fill="#101d24" opacity=".25"/><path d="M200 104C191 92 184 86 184 76a16 16 0 0 1 32 0c0 10-7 16-16 28Z" fill="#e03131" filter="url(#${shadow(uid)})"/>${circle(200, 76, 6.4, "#fff")}`;
    const tag = [b.category, b.distance].filter(Boolean).join(" · ");
    if (tag) { const w = tw(tag, 10, true) + 22; s += rect(12, 160, w, 22, "#fff", { rx: 11, filter: shadow(uid) }) + circle(24, 171, 3.4, "#e03131") + txt(32, 174.4, tag, 10, { fill: INK2, w: 750 }); }
    return tile({ label: T("PLACE", "장소"), name: b.name, meta: [b.address], svg: s });
  },
  summary: b => `Place ${b.name}, ${b.address}${b.category ? `. ${b.category}` : ""}${b.distance ? `, ${b.distance} away` : ""}.`,
  css: tileCss("location_card", "#e8590c"),
});

// ---- note_card --------------------------------------------------------------------------------------------------------------------------
const PAPER: Record<string, [string, string]> = { yellow: ["#fff3a8", "#e6cf5c"], blue: ["#cfe3ff", "#9fc0ee"], green: ["#d4f2d2", "#9fd49b"], pink: ["#ffd9e5", "#f0a9c3"], violet: ["#e6dcff", "#bfaaf0"], orange: ["#ffe1c2", "#f0b987"] };
const colour = nullable(loose(Object.keys(PAPER) as [string, ...string[]], { gold: "yellow", amber: "yellow", lemon: "yellow", cyan: "blue", sky: "blue", teal: "green", mint: "green", lime: "green", red: "pink", rose: "pink", purple: "violet", lilac: "violet", peach: "orange" }, "yellow").optional());
const item = z.preprocess(v => (typeof v === "string" ? { text: v } : v), z.object({ text: text(70), done: flag }).strip());
export const noteCard = defineAsset({
  type: "note_card", category: "thumbnail", width: "third", frame: "thumb",
  use: "A note as a preview tile drawn as a sticky note: a coloured paper with a title and a short checklist or a few lines of text.",
  useKo: "메모를 포스트잇 모양의 미리보기 타일로 보여줍니다: 색지 위의 제목과 짧은 체크리스트 또는 몇 줄의 글.",
  tags: ["note", "sticky", "memo", "checklist", "todo", "reminder", "메모", "포스트잇", "체크리스트", "할 일"],
  notes: "colour is yellow, blue, green, pink, violet or orange. items are up to 5 checklist rows ({text, done}, or plain strings); text is a short paragraph (use one of the two).",
  fields: { name: text(60), colour, text: optionalText(220), items: optList(item, 0, 5), modified: optionalText(24) },
  sample: { name: "Launch day checklist", colour: "yellow", modified: "Today", items: [{ text: "Final QA pass on checkout", done: true }, { text: "Publish release notes", done: true }, { text: "Email the beta waitlist", done: false }, { text: "Post on social channels", done: false }, { text: "Monitor errors for 2 hours", done: false }] },
  render(b, { ko, T, uid }) {
    const [paper, fold] = PAPER[b.colour ?? "yellow"] ?? PAPER.yellow, x = 90, w = 220, top = 14, items = b.items ?? [], done = items.filter(i => i.done).length;
    let s = `<defs>${shadowDefs(uid, 3, 3.6, 0.2)}<linearGradient id="${uid}-p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${paper}"/><stop offset="1" stop-color="${paper}" stop-opacity=".88"/></linearGradient></defs>`;
    s += `<g transform="rotate(-1.4 200 98)"><path d="M${x} ${top}H${x + w}V158L${x + w - 28} 190H${x}Z" fill="url(#${uid}-p)" filter="url(#${shadow(uid)})"/><path d="M${x + w} 158L${x + w - 28} 190V158Z" fill="${fold}"/>${rect(x + w / 2 - 28, top - 5, 56, 14, "#fff", { rx: 2, opacity: 0.55 })}`;
    let y = top + 36; for (const l of wrap(b.name, 15, w - 36, 2, true)) { s += txt(x + 18, y, l, 15, { fill: INK, w: 800 }); y += 18.5; }
    y += 5;
    if (b.text && !items.length) for (const l of wrap(b.text, 11, w - 36, 5)) { s += txt(x + 18, y, l, 11, { fill: INK2, w: 560 }); y += 15.5; }
    items.forEach(it => { if (y > 176) return; s += rect(x + 18, y - 8.4, 10, 10, it.done ? "#2d7d4f" : "none", { rx: 2.6, stroke: it.done ? "#2d7d4f" : "#5c6870", sw: 1.4 }) + (it.done ? glyph("check", x + 19, y - 7.4, 8, "#fff", 3.4) : "") + txt(x + 35, y, fit(it.text, 10.8, w - 56), 10.8, { fill: INK2, w: 600, opacity: it.done ? 0.5 : 1 }); y += 16.5; });
    return tile({ label: T("NOTE", "메모"), name: b.name, meta: [items.length ? (ko ? `${done}/${items.length} 완료` : `${done} of ${items.length} done`) : undefined, b.modified], svg: `${s}</g>` });
  },
  summary: b => `Note card ${b.name}${b.items?.length ? `: ${b.items.map(i => `${i.done ? "[x]" : "[ ]"} ${i.text}`).join(", ")}` : b.text ? `: ${b.text}` : ""}.`.slice(0, 390),
  css: tileCss("note_card", "#c28a0a"),
});

export const ASSETS: readonly AnyAsset[] = [folderCard, linkCard, emailThumb, calendarEvent, contactCard, locationCard, noteCard];
