import { z } from "zod";
import { esc } from "../../kit";
import { list, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { GROUNDS, block, clamp, cq, deco, em, fit, glowOp, groundField, groundOf, kicker, shape, stage, stagger, still, tint } from "./_stills";

/** Keyframe stills of motion graphics, the type: a quotation, a kinetic type poster, a news banner, a cinematic title. Each is a 16:9 frame with its type in cqw. */

/** The quotation mark: two marks, each a ball with a tail, drawn on a 48 x 30 box. */
const MARK = "M0 22C0 10 6 3 17 0L18.6 4.6C12 7 9.4 10.6 9 14.4A8 8 0 1 1 0 22ZM24 22C24 10 30 3 41 0L42.6 4.6C36 7 33.4 10.6 33 14.4A8 8 0 1 1 24 22Z";

/* ------------------------------------------------------------------------------------------------------------------ quote_card */
export const quoteCard = defineAsset({
  type: "quote_card", category: "motion", width: "half", frame: "16:9",
  use: "A pull quote as a poster frame: an oversized quotation mark, the quote in large type and an attribution with a short rule and a role.",
  useKo: "인용문을 포스터처럼: 큰 따옴표 도형, 큼직한 인용문, 짧은 선과 직함이 붙은 출처.",
  tags: ["quote", "pull quote", "testimonial", "citation", "saying", "motion", "인용", "명언", "후기", "따옴표"],
  notes: "quote is at most 180 characters; the type shrinks in steps as it grows. author is the name; role is the title or the source line.",
  fields: { quote: text(180), author: text(40), role: optionalText(50), ground: groundField("violet") },
  sample: { quote: "The best interface is the one you stop noticing, because the work simply gets done.", author: "Maya Lindqvist", role: "Head of Design, Northwind", ground: "violet" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "violet"), s = shape(g), size = block(b.quote, 80, 21, 8, 2.9, 1.24, -0.015);
    const art = `<defs><radialGradient id="${uid}r" cx=".2" cy=".1" r=".7"><stop offset="0" stop-color="${g.b}" stop-opacity="${glowOp(g, 0.4)}"/><stop offset="1" stop-color="${g.b}" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#${uid}r)"/><path d="${MARK}" transform="translate(152 84) rotate(180) scale(2.3)" fill="${s.hex}" fill-opacity=".07"/><circle cx="150" cy="10" r="30" fill="none" stroke="${s.hex}" stroke-opacity=".12" stroke-width=".5"/><circle cx="150" cy="10" r="18" fill="${s.hex}" fill-opacity=".06"/>`;
    const glyph = `<svg class="a-in" style="${stagger(0, 0.04)};width:15cqw;height:9.4cqw;flex:none" viewBox="0 0 48 30" aria-hidden="true"><defs><linearGradient id="${uid}m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g.a}"/><stop offset="1" stop-color="${tint(g)}"/></linearGradient></defs><path d="${MARK}" fill="url(#${uid}m)"/></svg>`;
    return `<div class="a-s" ${stage(g, "display:flex;flex-direction:column;justify-content:space-between;padding:6.5cqw 7cqw 6cqw")}>${deco(art)}${glyph}<div style="flex:1;display:flex;align-items:center;padding:1.2cqw 0"><div class="a-in" style="${stagger(1)};font-size:${cq(size)};font-weight:700;letter-spacing:-.015em;line-height:1.24;${clamp(6)}">${esc(b.quote)}</div></div><div class="a-in" style="${stagger(3)};display:flex;align-items:center;gap:2.2cqw"><i style="flex:none;width:7cqw;height:.7cqw;border-radius:1cqw;background:var(--a)"></i><div style="min-width:0"><div style="font-size:3cqw;font-weight:800;line-height:1.25;${clamp(1)}">${esc(b.author)}</div>${b.role ? `<div style="font-size:2.4cqw;line-height:1.3;color:var(--mu);${clamp(1)}">${esc(b.role)}</div>` : ""}</div></div></div>`;
  },
  summary: b => `“${b.quote}” — ${b.author}${b.role ? `, ${b.role}` : ""}`,
  css: still("quote_card"),
});

/* ------------------------------------------------------------------------------------------------------------------ kinetic_type */
const index = z.preprocess(v => { const n = typeof v === "string" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : undefined; }, z.number().optional());
/** How the nth line of the stack is set: its share of the largest size, weight, alignment and case. */
const LINES = [{ k: 1, w: 900, al: "flex-start", up: true, lh: 0.84 }, { k: 0.94, w: 900, al: "flex-end", up: true, lh: 0.84 }, { k: 1, w: 900, al: "flex-start", up: true, lh: 0.84 }, { k: 0.42, w: 500, al: "flex-end", up: false, lh: 1 }, { k: 0.66, w: 800, al: "center", up: false, lh: 0.95 }];
export const kineticType = defineAsset({
  type: "kinetic_type", category: "motion", width: "half", frame: "16:9",
  use: "A typographic poster: three to five words or short phrases stacked at different sizes and weights, one outlined and one marked with a colour bar.",
  useKo: "타이포그래피 포스터: 단어·짧은 구절 3~5개를 크기와 굵기를 달리해 쌓고, 하나는 외곽선, 하나는 색 막대로 강조.",
  tags: ["kinetic type", "typography", "poster", "title", "words", "slogan", "motion", "타이포", "포스터", "슬로건", "키네틱"],
  notes: "words are 3-5 short phrases (18 characters each), set in order from the top. outline and highlight are the 1-based line numbers to outline and to mark (default 2 and 3). tag is a small line above.",
  fields: { words: list(text(18), 3, 5), outline: index, highlight: index, tag: optionalText(28), ground: groundField("sunset") },
  sample: { words: ["Think", "bigger,", "move faster.", "Ship every week"], outline: 2, highlight: 3, tag: "Team principles · 01", ground: "sunset" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "sunset"), s = shape(g), n = b.words.length, out = (b.outline ?? 2) - 1, hi = (b.highlight ?? 3) - 1, avail = b.tag ? 38.5 : 44;
    const sizes = b.words.map((w, i) => { const l = LINES[i], bar = i === hi ? 2.8 : 0; return fit(l.up ? w.toUpperCase() : w, 86 - bar, 19 * l.k, 2.2, l.up ? -0.03 : 0, l.w >= 800 ? 1.08 : 1.02); });
    const cjk = b.words.map(w => /[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7a3\uff00-\uffef]/.test(w));
    const lhs = b.words.map((_, i) => (i === hi ? 1.18 : cjk[i] ? Math.max(1.06, LINES[i].lh) : LINES[i].lh));
    const total = sizes.reduce((a, v, i) => a + v * lhs[i], 0) + (n - 1) * 1, f = Math.min(1, avail / total);
    const art = `<defs><radialGradient id="${uid}r" cx=".9" cy=".1" r=".6"><stop offset="0" stop-color="${g.b}" stop-opacity="${glowOp(g, 0.5)}"/><stop offset="1" stop-color="${g.b}" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#${uid}r)"/><circle cx="146" cy="14" r="26" fill="${s.hex}" fill-opacity=".08"/><circle cx="146" cy="14" r="38" fill="none" stroke="${s.hex}" stroke-opacity=".18" stroke-width=".5"/><path d="M-4 80 40 100M10 76 54 100" stroke="${g.a}" stroke-opacity=".5" stroke-width="1.2"/>`;
    const lines = b.words.map((w, i) => {
      const l = LINES[i], size = sizes[i] * f, marked = i === hi, outlined = i === out && !marked;
      const look = marked ? `display:inline-block;line-height:1.08;padding:.02em .14em .04em;background:var(--a);color:var(--on)` : outlined ? `color:transparent;-webkit-text-stroke:${cq(Math.max(0.18, size * 0.022))} var(--fg)` : i === 4 ? "color:var(--a)" : i === 3 ? "color:var(--mu)" : "";
      return `<div class="a-in" style="${stagger(i, 0.1, 0.14)};align-self:${l.al};max-width:100%;font-size:${cq(size)};font-weight:${l.w};line-height:${lhs[i]};letter-spacing:${l.up ? "-.03em" : ".01em"};white-space:nowrap;${l.up ? "text-transform:uppercase;" : ""}${i === 4 ? "font-style:italic;" : ""}"><span style="${look}">${esc(w)}</span></div>`;
    }).join("");
    return `<div class="a-s" ${stage(g, "display:flex;flex-direction:column;justify-content:space-between;padding:5cqw 7cqw")}>${deco(art)}${b.tag ? kicker(b.tag, stagger(0, 0.02), 62, "var(--fg)") : "<i></i>"}<div style="display:flex;flex-direction:column;gap:1cqw">${lines}</div></div>`;
  },
  summary: b => `${b.tag ? `${b.tag}: ` : ""}${b.words.join(" / ")}`,
  css: still("kinetic_type"),
});

/* ------------------------------------------------------------------------------------------------------------------ headline_banner */
export const headlineBanner = defineAsset({
  type: "headline_banner", category: "motion", width: "half", frame: "16:9",
  use: "A news-style hero banner: a category tag, a big headline, a date line, with a diagonal colour block and a stripe.",
  useKo: "뉴스 스타일 히어로 배너: 분류 태그, 큰 헤드라인, 날짜 줄, 사선 색 블록과 줄무늬.",
  tags: ["headline", "banner", "news", "hero", "article", "breaking", "motion", "헤드라인", "뉴스", "배너", "기사"],
  notes: "headline is at most 80 characters and reads best in two or three lines; category is the tag above it (Markets, Energy, Opinion); dateline is a date or a byline.",
  fields: { category: text(24), headline: text(80), dateline: optionalText(40), ground: groundField("ink") },
  sample: { category: "Energy", headline: "Offshore wind clears its biggest hurdle", dateline: "Nov 6, 2026 · 4 min read", ground: "ink" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "ink"), s = shape(g), size = block(b.headline, 56, 24, 8.6, 3.6, 1.04, -0.025, 1.06);
    const art = `<defs><linearGradient id="${uid}f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g.a}"/><stop offset="1" stop-color="${tint(g)}"/></linearGradient><pattern id="${uid}p" width="4.4" height="4.4" patternUnits="userSpaceOnUse"><circle cx="1.2" cy="1.2" r=".62" fill="${g.on}" fill-opacity=".28"/></pattern></defs><polygon points="104,0 160,0 160,90 80,90" fill="${s.hex}" fill-opacity=".07"/><polygon points="122,0 160,0 160,90 98,90" fill="url(#${uid}f)"/><polygon points="122,0 160,0 160,90 98,90" fill="url(#${uid}p)"/><polygon points="115.5,0 119.5,0 95.5,90 91.5,90" fill="${g.a}"/><circle cx="150" cy="16" r="19" fill="none" stroke="${g.on}" stroke-opacity=".3" stroke-width=".6"/><circle cx="150" cy="16" r="9" fill="${g.on}" fill-opacity=".14"/><path d="M11 72H88" stroke="${s.hex}" stroke-opacity=".22" stroke-width=".4"/>`;
    return `<div class="a-s" ${stage(g, "display:flex;flex-direction:column;justify-content:space-between;padding:6.5cqw 7cqw")}>${deco(art)}<div class="a-in" style="${stagger(0, 0.04)};align-self:flex-start;max-width:56cqw;padding:.9cqw 2.2cqw;border-radius:.7cqw;background:var(--a);color:var(--on);font-size:2.3cqw;font-weight:800;line-height:1.2;letter-spacing:.14em;text-transform:uppercase;${clamp(1)}">${esc(b.category)}</div><div class="a-in" style="${stagger(1)};max-width:58cqw;font-size:${cq(size)};font-weight:800;line-height:1.04;letter-spacing:-.025em;${clamp(4)}">${esc(b.headline)}</div>${b.dateline ? `<div class="a-in" style="${stagger(3)};max-width:56cqw;display:flex;align-items:center;gap:1.6cqw;font-size:2.4cqw;font-weight:650;color:var(--mu)"><i style="flex:none;width:1.4cqw;height:1.4cqw;background:var(--a)"></i><span style="${clamp(1)}">${esc(b.dateline)}</span></div>` : "<i></i>"}</div>`;
  },
  summary: b => `${b.category}: ${b.headline}${b.dateline ? ` (${b.dateline})` : ""}`,
  css: still("headline_banner"),
});

/* ------------------------------------------------------------------------------------------------------------------ title_card */
export const titleCard = defineAsset({
  type: "title_card", category: "motion", width: "half", frame: "16:9",
  use: "A cinematic title card: a widely spaced title, a subtitle, a thin line and a year, centred on a vignette with light streaks.",
  useKo: "영화 타이틀 느낌의 카드: 자간 넓은 제목, 부제, 가는 선과 연도, 비네트 배경과 빛줄기.",
  tags: ["title card", "cinematic", "film", "intro", "opening", "trailer", "motion", "타이틀", "영화", "오프닝", "시네마틱"],
  notes: "title is at most 48 characters and is set in capitals with wide tracking (two lines when long); kicker is a small line above, year a short line below the rule.",
  fields: { title: text(48), subtitle: optionalText(80), kicker: optionalText(32), year: optionalText(12), ground: groundField("ink") },
  sample: { title: "The Long Signal", subtitle: "A documentary about the people who keep the internet running", kicker: "Agentlas Studio presents", year: "2026", ground: "ink" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "ink"), s = shape(g), up = b.title.toUpperCase(), w = em(up) * 1.05 + [...up].length * 0.2, one = 80 / w, single = one >= 4.4;
    const size = single ? Math.min(9, one) : Math.max(3.2, Math.min(6.4, 80 / (w / 2 * 1.14)));
    const bg = g.dark ? `radial-gradient(125% 105% at 50% 44%,${g === GROUNDS.ink ? "#2a4553" : g.bg[1]} 0%,${g.bg[0]} 64%,#000 140%)` : `radial-gradient(125% 105% at 50% 44%,#fffdf8 0%,${g.bg[1]} 58%,#cdc4ae 140%)`, hi = g.dark ? s.hex : g.b;
    const art = `<defs><linearGradient id="${uid}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${hi}" stop-opacity="0"/><stop offset=".5" stop-color="${hi}" stop-opacity="1"/><stop offset="1" stop-color="${hi}" stop-opacity="0"/></linearGradient><radialGradient id="${uid}h" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${hi}" stop-opacity=".55"/><stop offset="1" stop-color="${hi}" stop-opacity="0"/></radialGradient></defs><rect x="-10" y="43" width="180" height="8" fill="url(#${uid}s)" opacity=".1"/><rect x="0" y="46.4" width="160" height=".7" fill="url(#${uid}s)" opacity=".85"/><rect x="40" y="63" width="110" height=".4" fill="url(#${uid}s)" opacity=".5"/><rect x="10" y="27" width="70" height=".35" fill="url(#${uid}s)" opacity=".4"/><g transform="rotate(-24 80 45)"><rect x="-30" y="44.6" width="220" height="1.2" fill="url(#${uid}s)" opacity=".12"/></g><circle cx="9" cy="46.7" r="9" fill="url(#${uid}h)"/><path d="M9 39 10.1 45.6 17 46.7 10.1 47.8 9 54.4 7.9 47.8 1 46.7 7.9 45.6Z" fill="${hi}" fill-opacity=".9"/>`;
    const rule = `<i style="display:block;width:22cqw;height:1px;background:linear-gradient(90deg,transparent,var(--fg),transparent);opacity:.7"></i>`;
    return `<div class="a-s" ${stage(g, "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.1cqw;padding:5cqw 6cqw;text-align:center", bg)}>${deco(art)}${b.kicker ? `<div class="a-in" style="${stagger(0, 0.1)};max-width:80cqw;font-size:2cqw;font-weight:700;letter-spacing:.4em;text-transform:uppercase;color:var(--mu);${clamp(1)}">${esc(b.kicker)}</div>` : ""}<div class="a-in" style="${stagger(1, 0.1)};max-width:86cqw;font-size:${cq(size)};font-weight:700;letter-spacing:.2em;line-height:1.2;padding-left:.2em;text-transform:uppercase;text-shadow:0 0 ${cq(size * 1.6)} rgba(${s.rgb},.28);${clamp(2)}">${esc(b.title)}</div><div class="a-in" style="${stagger(2, 0.1)}">${rule}</div>${b.subtitle ? `<div class="a-in" style="${stagger(3, 0.1)};max-width:76cqw;font-size:${cq(block(b.subtitle, 74, 7, 2.5, 1.8, 1.5, 0.22))};font-weight:500;letter-spacing:.22em;line-height:1.5;text-transform:uppercase;color:var(--mu);${clamp(2)}">${esc(b.subtitle)}</div>` : ""}${b.year ? `<div class="a-in" style="${stagger(4, 0.1)};display:flex;align-items:center;gap:2cqw;font-size:2.4cqw;font-weight:700;letter-spacing:.3em;color:var(--a)"><i style="width:7cqw;height:1px;background:var(--ln)"></i>${esc(b.year)}<i style="width:7cqw;height:1px;background:var(--ln)"></i></div>` : ""}</div>`;
  },
  summary: b => `${b.kicker ? `${b.kicker}: ` : ""}${b.title}${b.subtitle ? ` — ${b.subtitle}` : ""}${b.year ? ` (${b.year})` : ""}`,
  css: still("title_card"),
});

export const ASSETS: readonly AnyAsset[] = [quoteCard, kineticType, headlineBanner, titleCard];
