import { z } from "zod";
import { bold, esc } from "../../kit";
import { list, loose, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { accent, body, clamp, fit, ground, h2, head, kicker, linesOf, room, slide, sx } from "./_shared";
import { scene, sceneSvg } from "./scenes";

/** The content slides: bullets, two columns, a pull quote and an illustration with its caption. */
const asObject = (key: string) => (v: unknown) => (typeof v === "string" ? { [key]: v } : v);
const plain = (s: string) => s.replace(/\*\*/g, "");
type Bullet = { text: string; sub?: string[] };
const bullet = z.preprocess(asObject("text"), z.object({ text: text(110), sub: list(text(80), 0, 2).optional() }).strip());

export const bulletsSlide = defineAsset({
  type: "bullets_slide", category: "slide", width: "half", frame: "16:9",
  use: "A content slide: a heading and three to six bullets, each with an optional bold lead-in and up to two sub-points.",
  useKo: "내용 슬라이드: 제목과 3~6개의 글머리 항목(앞부분 굵게 가능), 항목마다 하위 항목 최대 2개.",
  tags: ["slide", "bullets", "list", "points", "content", "슬라이드", "글머리", "목록", "요점", "발표"],
  notes: "Write a bullet as '**Lead-in** rest of the sentence' for a bold start. Each bullet is at most 110 characters, a sub-point at most 80. With many sub-points the slide joins them on one line, and with six bullets it may leave them out so the text stays readable. accent: blue, green, violet, sunset or ink.",
  fields: { heading: text(64), kicker: optionalText(28), bullets: list(bullet, 3, 6), footer: optionalText(48), accent },
  sample: { kicker: "Highlights", heading: "What drove growth in Q3", accent: "blue", footer: "Northwind Labs · Q3 review · 3", bullets: [{ text: "**Self-serve signups** grew 38% after the April launch", sub: ["Free trial now needs no card", "Setup time fell from 9 to 3 minutes"] }, { text: "**Partner referrals** became our second-largest channel", sub: ["14 agencies now resell Northwind"] }, { text: "**Churn** held at 2.1% a month while prices rose" }, { text: "**Support load** per account fell 22% with the new help center" }] },
  render(b) {
    const items = b.bullets as Bullet[], avail = room(b.heading, { kicker: !!b.kicker, footer: !!b.footer });
    // Three modes, tried from the roomiest: sub-points under each bullet, sub-points joined on one line, then one line per bullet and no sub-points.
    const height = (z: number, mode: number) => items.reduce((h, it, i) => h + (mode === 2 ? 1 : Math.min(2, linesOf(plain(it.text), z, 78))) * z * 1.3 + (it.sub?.length && mode < 2 ? (mode ? 1 : it.sub.length) * z * 0.78 * 1.32 + 0.4 * z : 0) + (i ? z * 0.7 : 0), 0);
    const [mode, size] = ([[0, 3], [0, 2.7], [0, 2.4], [1, 2.4], [1, 2.2], [2, 2.4], [2, 2.2], [2, 2]] as const).find(([m, z]) => height(z, m) <= avail) ?? ([2, 2] as const);
    const li = items.map(it => `<li><i></i><div><p${mode === 2 ? ' style="-webkit-line-clamp:1"' : ""}>${bold(it.text)}</p>${it.sub?.length && mode < 2 ? `<ul>${(mode ? [it.sub.join(" · ")] : it.sub).map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}</div></li>`).join("");
    return slide(b.accent, `${head(b.heading, { kicker: b.kicker })}${body(`<ul class="a-ul" style="font-size:${size}cqw">${li}</ul>`)}`, b.footer);
  },
  summary: b => `${b.heading}: ${(b.bullets as Bullet[]).map(it => `${plain(it.text)}${it.sub?.length ? ` (${it.sub.join("; ")})` : ""}`).join("; ")}`,
  css: sx("bullets_slide", `.a-ul{height:100%;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;justify-content:space-evenly}
.a-ul>li{display:grid;grid-template-columns:1.9em 1fr;align-items:start;min-height:0;overflow:hidden}
.a-ul>li>i{width:.42em;height:.42em;margin:.45em 0 0 .1em;border-radius:.12em;background:var(--ac)}
.a-ul p{${clamp(2)};margin:0;line-height:1.3;font-weight:540;color:var(--ink2)}
.a-ul b{font-weight:800;color:var(--ink)}
.a-ul ul{margin:.3em 0 0;padding:0;list-style:none;font-size:.78em;font-weight:520;color:var(--muted)}
.a-ul ul li{${clamp(1)};position:relative;padding-left:1.1em;line-height:1.32}
.a-ul ul li::before{content:"";position:absolute;left:0;top:.62em;width:.5em;height:2px;background:var(--faint)}`),
});

const column = z.object({ heading: text(28), points: list(text(84), 2, 4) }).strip();
type Column = { heading: string; points: string[] };
export const twoColumnSlide = defineAsset({
  type: "two_column_slide", category: "slide", width: "half", frame: "16:9",
  use: "A content slide with two side-by-side columns, each with its own subheading and two to four points (before/after, pros/cons, us/them).",
  useKo: "두 열 내용 슬라이드: 열마다 소제목과 2~4개 항목(전/후, 장/단점, 우리/상대).",
  tags: ["slide", "two column", "columns", "pros cons", "before after", "슬라이드", "두 열", "장단점", "비교", "발표"],
  notes: "left and right each hold a heading (28 characters at most) and 2-4 points (84 characters at most).",
  fields: { heading: text(64), kicker: optionalText(28), left: column, right: column, footer: optionalText(48), accent },
  sample: { heading: "What worked and what to fix", accent: "blue", footer: "Northwind Labs · Q3 review · 5", left: { heading: "What worked", points: ["A card-free trial lifted signups 38%", "Agency referrals cost 40% less per account", "The new help center cut tickets by a fifth"] }, right: { heading: "What to fix", points: ["Activation stays at 41% after week one", "Enterprise deals still close in 74 days", "Mobile onboarding loses one user in three"] } },
  render(b) {
    const cols = [b.left, b.right] as Column[], avail = room(b.heading, { kicker: !!b.kicker, footer: !!b.footer });
    // Each step is [size, lines a point may take]; the last two keep a point to one line when two do not fit.
    const steps = [[2.8, 2], [2.5, 2], [2.2, 2], [2, 2], [2.2, 1], [2, 1]] as const;
    const height = (z: number, n: number) => Math.max(...cols.map(c => z * 1.25 * 1.3 + z * 0.9 + c.points.reduce((h, p, i) => h + Math.min(n, linesOf(p, z, 35)) * z * 1.3 + (i ? z * 0.75 : 0), 0)));
    const [size, lines] = steps.find(([z, n]) => height(z, n) <= avail) ?? steps[steps.length - 1];
    const col = (c: Column, k: number) => `<section class="a-c${k}"><h3>${esc(c.heading)}</h3><ul>${c.points.map(p => `<li><i></i><span${lines === 1 ? ' style="-webkit-line-clamp:1"' : ""}>${esc(p)}</span></li>`).join("")}</ul></section>`;
    return slide(b.accent, `${head(b.heading, { kicker: b.kicker })}${body(`<div class="a-cols" style="font-size:${size}cqw">${col(cols[0], 1)}<div class="a-vl"></div>${col(cols[1], 2)}</div>`)}`, b.footer);
  },
  summary: b => `${b.heading}: ${[b.left, b.right].map((c: Column) => `${c.heading} — ${c.points.join("; ")}`).join(" | ")}`,
  css: sx("two_column_slide", `.a-cols{height:100%;display:grid;grid-template-columns:1fr 1px 1fr;gap:0 3.4cqw}
.a-vl{background:var(--line)}
.a-cols section{min-width:0;overflow:hidden}
.a-cols h3{margin:0 0 .9em;font-size:1.25em;line-height:1.2;font-weight:800;color:var(--ac);display:flex;align-items:center;gap:.5em}
.a-cols h3::before{content:"";flex:none;width:1.1em;height:.22em;border-radius:2px;background:currentColor}
.a-cols ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:.75em}
.a-cols li{display:grid;grid-template-columns:1.4em 1fr;align-items:start}
.a-cols li i{width:.42em;height:.42em;margin:.5em 0 0 .08em;border-radius:.12em;background:var(--ac)}
.a-cols span{${clamp(2)};line-height:1.3;font-weight:540;color:var(--ink2)}
.a-c2 h3{color:var(--ink2)}
.a-c2 li i{background:var(--faint)}`),
});

export const quoteSlide = defineAsset({
  type: "quote_slide", category: "slide", width: "half", frame: "16:9",
  use: "A pull-quote slide: one quotation with its author and role on a softly tinted ground, with an oversized quotation mark.",
  useKo: "인용 슬라이드: 옅은 색 배경 위에 큰 따옴표 장식과 함께 인용문 하나와 발언자·직함.",
  tags: ["slide", "quote", "pull quote", "testimonial", "citation", "슬라이드", "인용", "명언", "고객 후기", "발표"],
  notes: "ground tints the slide: ink (paper), blue, green, violet or sunset. The quote is at most 200 characters; the text shrinks to fit.",
  fields: { quote: text(200), author: text(40), role: optionalText(60), footer: optionalText(48), ground },
  sample: { quote: "Every roadmap bet we made this year started as a customer call. Listening was our best growth channel.", author: "Maya Chen", role: "CEO, Northwind Labs", ground: "sunset", footer: "Northwind Labs · Q3 review · 8" },
  render(b) {
    const size = fit(b.quote, 84, [[4.8, 2], [4.2, 3], [3.6, 4], [3.1, 5], [2.7, 6]]);
    return slide(b.ground ?? "ink", `<div class="a-q" aria-hidden="true">“</div><div class="a-ring" aria-hidden="true"></div><blockquote style="font-size:${size}cqw">${esc(b.quote)}</blockquote><div class="a-by"><i></i><div><b>${esc(b.author)}</b>${b.role ? `<span>${esc(b.role)}</span>` : ""}</div></div>`, b.footer, "padding-top:15cqw;background:var(--aq)");
  },
  summary: b => `“${b.quote}” — ${b.author}${b.role ? `, ${b.role}` : ""}`,
  css: sx("quote_slide", `.a-q{position:absolute;left:6.6cqw;top:2.4cqw;font:800 24cqw/1 Georgia,"Times New Roman",serif;color:var(--ac)}
.a-ring{position:absolute;right:-9cqw;bottom:-14cqw;width:40cqw;height:40cqw;border-radius:50%;background:var(--ac);opacity:.08}
blockquote{position:relative;flex:1;min-height:0;margin:0;display:flex;align-items:center;font-weight:700;line-height:1.28;letter-spacing:-.015em;overflow:hidden}
blockquote::first-line{color:var(--ink)}
.a-by{position:relative;flex:none;display:flex;align-items:center;gap:1.6cqw}
.a-by i{width:4.4cqw;height:.55cqw;border-radius:2px;background:var(--ac)}
.a-by div{display:flex;flex-direction:column;gap:.3cqw;min-width:0}
.a-by b{font-size:2.5cqw;font-weight:800}
.a-by span{font-size:2cqw;font-weight:600;color:var(--muted)}`),
});

export const imageCaptionSlide = defineAsset({
  type: "image_caption_slide", category: "slide", width: "half", frame: "16:9",
  use: "A slide with a drawn illustration on one side (sunset, mountains, ocean, city, forest or abstract) and a heading, text and caption on the other.",
  useKo: "한쪽에 그린 일러스트(노을·산·바다·도시·숲·추상), 다른 쪽에 제목·본문·캡션이 있는 슬라이드.",
  tags: ["slide", "image", "illustration", "photo", "caption", "scene", "슬라이드", "이미지", "일러스트", "캡션"],
  notes: "scene: sunset, mountains, ocean, city, forest or abstract. side puts the illustration on the left (default) or right. body is at most 220 characters.",
  fields: { scene, side: loose(["left", "right"], { l: "left", r: "right", image_left: "left", image_right: "right" }, "left").optional(), kicker: optionalText(28), heading: text(60), body: optionalText(220), caption: optionalText(80), footer: optionalText(48), accent },
  sample: { scene: "mountains", side: "left", kicker: "Looking ahead", heading: "Q4 is about the climb from trial to team", body: "Most new accounts try Northwind alone. Our next gains come from getting a second and third teammate to join in the first two weeks.", caption: "Goal: 55% of new accounts invite a teammate by day 14", accent: "blue", footer: "Northwind Labs · Q3 review · 12" },
  render(b, { uid }) {
    const left = b.side !== "right", W = 36, hs = fit(b.heading, W, [[4.2, 2], [3.6, 3], [3.2, 3]]);
    // The body takes the lines the column has left under the headline, the kicker and the caption, so no line is ever cut through.
    const hl = Math.min(3, linesOf(b.heading, hs, W)), cl = b.caption ? Math.min(2, linesOf(b.caption, 1.9, W - 2.6)) : 0;
    const pl = Math.max(1, Math.floor((40.8 - hl * hs * 1.16 - (b.kicker ? 2.6 : 0) - (b.caption ? cl * 1.9 * 1.4 + 2.8 : 0) - 2) / (2.4 * 1.5)));
    const text = `<div class="a-tx" style="${left ? "left:50cqw;right:8cqw" : "left:8cqw;right:50cqw"}">${b.kicker ? kicker(b.kicker, ";flex:none") : ""}${h2(b.heading, hs, `;-webkit-line-clamp:3;flex:none`)}${b.body ? `<p style="-webkit-line-clamp:${pl}">${esc(b.body)}</p>` : ""}${b.caption ? `<div class="a-cp"><i></i>${esc(b.caption)}</div>` : ""}</div>`;
    return slide(b.accent, `<div class="a-pic" style="${left ? "left:0" : "right:0"}">${sceneSvg(b.scene, uid)}</div>${text}`, b.footer, "", left ? { left: 50, right: 8 } : { left: 8, right: 50 });
  },
  summary: b => [b.heading, b.body, b.caption ? `Caption: ${b.caption}` : "", `(${b.scene} illustration)`].filter(Boolean).join(" — "),
  css: sx("image_caption_slide", `.a-pic{position:absolute;top:0;bottom:0;width:44cqw;overflow:hidden}
.a-tx{position:absolute;top:6.4cqw;bottom:9cqw;display:flex;flex-direction:column;justify-content:center;min-width:0}
.a-tx p{${clamp(6)};flex:none;margin:2cqw 0 0;font-size:2.4cqw;line-height:1.5;font-weight:520;color:var(--ink2)}
.a-cp{${clamp(2)};flex:none;position:relative;margin-top:2.8cqw;padding-left:2.6cqw;font-size:1.9cqw;line-height:1.4;font-weight:650;color:var(--muted)}
.a-cp i{position:absolute;left:0;top:.55em;width:1.6cqw;height:2px;background:var(--ac)}`),
});
export const ASSETS: readonly AnyAsset[] = [bulletsSlide, twoColumnSlide, quoteSlide, imageCaptionSlide];
