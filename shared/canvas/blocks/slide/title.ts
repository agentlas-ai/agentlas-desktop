import { esc } from "../../kit";
import { loose, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";

/** The coloured grounds a slide, a poster or a cover can take. Defined once per file that needs them; the colours are the card's own. */
const GROUNDS = ["ink", "blue", "green", "violet", "sunset"] as const;
const ground = loose([...GROUNDS] as [string, ...string[]], { dark: "ink", black: "ink", navy: "blue", teal: "green", purple: "violet", orange: "sunset", warm: "sunset" }, "ink").optional();

export const titleSlide = defineAsset({
  type: "title_slide", category: "slide", width: "half", frame: "16:9",
  use: "A presentation's opening slide: headline, subtitle, a small kicker above and a byline below.",
  useKo: "발표의 첫 슬라이드: 제목, 부제, 위쪽 말머리와 아래쪽 발표자 표기.",
  tags: ["slide", "title", "cover", "opening", "deck", "ppt", "슬라이드", "표지", "제목", "발표"],
  notes: "ground picks the colour: ink, blue, green, violet or sunset. The headline is at most 80 characters; keep it to one idea.",
  fields: { headline: text(80), subtitle: optionalText(120), kicker: optionalText(30), byline: optionalText(60), ground },
  sample: { headline: "Q3 growth review: where the new users came from", subtitle: "Product and marketing, with next quarter's plan", kicker: "QUARTERLY REVIEW", byline: "Growth team · October 2026", ground: "blue" },
  render(b, { uid }) {
    return `<div class="a-s a-g-${b.ground ?? "ink"}"><svg class="a-deco" viewBox="0 0 160 90" preserveAspectRatio="xMaxYMid slice" aria-hidden="true"><defs><radialGradient id="${uid}r" cx=".7" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#${uid}r)"/><circle cx="132" cy="22" r="34" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width=".6"/><circle cx="132" cy="22" r="22" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width=".6"/><circle cx="132" cy="22" r="10" fill="#fff" fill-opacity=".14"/></svg>${b.kicker ? `<div class="a-k">${esc(b.kicker)}</div>` : ""}<h2 style="font-size:${b.headline.length > 56 ? 4.2 : b.headline.length > 36 ? 5.2 : 6.2}cqw">${esc(b.headline)}</h2>${b.subtitle ? `<p>${esc(b.subtitle)}</p>` : ""}${b.byline ? `<div class="a-by">${esc(b.byline)}</div>` : ""}</div>`;
  },
  summary: b => [b.kicker, b.headline, b.subtitle, b.byline].filter(Boolean).join(" — "),
  css: ".fpc .a-title_slide{border:0}.fpc .a-title_slide .a-s{position:absolute;inset:0;padding:7cqw 8cqw;display:flex;flex-direction:column;justify-content:flex-end;gap:1.4cqw;color:#fff;background:linear-gradient(135deg,#101d24,#24323a)}.fpc .a-title_slide .a-g-blue{background:linear-gradient(135deg,#1c3f9c,#2f5fd6 60%,#7aa2ff)}.fpc .a-title_slide .a-g-green{background:linear-gradient(135deg,#0b4f3c,#118558 60%,#38d39f)}.fpc .a-title_slide .a-g-violet{background:linear-gradient(135deg,#4c1d95,#7c3aed 60%,#c4b5fd)}.fpc .a-title_slide .a-g-sunset{background:linear-gradient(135deg,#b4231d,#f08a24 60%,#ffd27a)}.fpc .a-title_slide .a-deco{position:absolute;inset:0;width:100%;height:100%}.fpc .a-title_slide .a-k{position:relative;font-size:1.9cqw;font-weight:800;letter-spacing:.16em;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:78%}.fpc .a-title_slide h2{position:relative;margin:0;line-height:1.12;font-weight:800;letter-spacing:-.02em;max-width:78%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.fpc .a-title_slide p{position:relative;margin:0;font-size:2.7cqw;line-height:1.4;font-weight:500;opacity:.9;max-width:70%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.fpc .a-title_slide .a-by{position:relative;margin-top:2.4cqw;font-size:1.9cqw;font-weight:650;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:78%}",
});
export const ASSETS: readonly AnyAsset[] = [titleSlide];
