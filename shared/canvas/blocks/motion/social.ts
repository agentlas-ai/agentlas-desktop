import { z } from "zod";
import { esc } from "../../kit";
import { list, optionalNum, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { baseCss, clamp, dly, em, fitText, glowDef, groundField, groundOf, hash, lineDef, n2, para, rng, scene, sizeFor, stage } from "./_b";

/** Stills made for a feed, a story, a wall and a player: a 1:1 post, a 9:16 story card, an A4 poster and a 16:9 audio card. */

const initialOf = (s: string) => ([...s.replace(/^[@#\s]+/, "")][0] ?? "A").toUpperCase();

// ---------- 5. social_post (1:1) ----------
export const socialPost = defineAsset({
  type: "social_post", category: "motion", width: "half", frame: "1:1",
  use: "A square social-media post still: a big headline, one supporting line, a bold accent shape, the account handle and a row of tags.",
  useKo: "소셜 미디어용 정사각 게시물 정지 화면: 큰 제목, 보조 문장 한 줄, 굵은 도형, 계정 이름과 태그 줄.",
  tags: ["social", "post", "instagram", "square", "announcement", "sns", "소셜", "게시물", "인스타그램", "정사각"],
  notes: "Headline 70 characters; tags are short words (up to 4, those that fit are drawn). handle is the account, with or without @.",
  fields: { headline: text(70), support: optionalText(120), handle: text(24), tags: list(text(16), 1, 4).optional(), kicker: optionalText(24), ground: groundField("sunset") },
  sample: { kicker: "NEW DROP", headline: "Ship the idea before it cools", support: "Three tools that turn a rough note into a finished page.", handle: "@agentlas", tags: ["#build", "#ship", "#ai"], ground: "sunset" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "sunset"), S = stage(100, 100);
    const k = b.kicker ? fitText(b.kicker.toUpperCase(), 56, 2.4, 800) : "", kw = k ? em(k, 800) * 2.4 + k.length * 0.45 + 9 : 0;
    const pill = k ? `<g class="a-in"><rect x="8" y="7" width="${n2(kw)}" height="6.4" rx="3.2" fill="${g.fg}" fill-opacity=".16" stroke="${g.fg}" stroke-opacity=".45" stroke-width=".3"/><circle cx="11.6" cy="10.2" r="1" fill="${g.fg}"/><text x="14.4" y="10.2" dy=".36em" font-size="2.4" font-weight="800" letter-spacing=".4" fill="${g.fg}">${esc(k)}</text></g>` : "";
    let x = 8, pills = "";
    (b.tags ?? []).forEach((t, i) => { const label = fitText(t, 22, 2.7, 700), w = em(label) * 2.7 + 5.6; if (x + w > 56) return; pills += `<g class="a-in" style="animation-delay:${dly(i, 0.5, 0.07)}s"><rect x="${n2(x)}" y="73" width="${n2(w)}" height="6.2" rx="3.1" fill="${g.fg}" fill-opacity=".14" stroke="${g.fg}" stroke-opacity=".4" stroke-width=".3"/><text x="${n2(x + w / 2)}" y="76.1" dy=".36em" text-anchor="middle" font-size="2.7" font-weight="700" fill="${g.fg}">${esc(label)}</text></g>`; x += w + 2; });
    const handle = fitText(b.handle, 38, 3.5, 700);
    const deco = S.svg(`<defs>${glowDef(`${uid}a`, g.mesh[0], 0.7)}${glowDef(`${uid}b`, g.mesh[1], 0.6)}${glowDef(`${uid}c`, g.hi2, 0.65)}${lineDef(`${uid}g`, g.grad[0], g.grad[1])}</defs><circle cx="6" cy="8" r="50" fill="url(#${uid}a)"/><circle cx="96" cy="104" r="60" fill="url(#${uid}c)"/><circle cx="100" cy="40" r="40" fill="url(#${uid}b)"/><path d="M100 0v30a30 30 0 0 1-30-30z" fill="${g.fg}" fill-opacity=".1"/><path d="M100 0v18a18 18 0 0 1-18-18z" fill="${g.fg}" fill-opacity=".14"/><g class="a-in" style="animation-delay:.2s"><circle cx="80" cy="84" r="44" fill="none" stroke="${g.fg}" stroke-opacity=".14" stroke-width=".5"/><circle cx="80" cy="84" r="34" fill="none" stroke="${g.fg}" stroke-opacity=".28" stroke-width=".5"/><circle cx="80" cy="84" r="25" fill="url(#${uid}g)"/><circle cx="71" cy="75" r="10" fill="#fff" fill-opacity=".22"/><circle cx="56" cy="64" r="3.2" fill="${g.hi2}"/><circle cx="93" cy="58" r="3.4" fill="none" stroke="${g.fg}" stroke-opacity=".7" stroke-width=".7"/><path d="M68 52v6M65 55h6" stroke="${g.fg}" stroke-opacity=".6" stroke-width=".7" stroke-linecap="round"/></g>${pill}${pills}<g class="a-in" style="animation-delay:.6s"><circle cx="11.8" cy="90.4" r="3.8" fill="url(#${uid}g)"/><text x="11.8" y="90.4" dy=".36em" text-anchor="middle" font-size="3.6" font-weight="800" fill="${g.on}">${esc(initialOf(b.handle))}</text><text x="17.6" y="90.4" dy=".36em" font-size="3.5" font-weight="700" fill="${g.fg}">${esc(handle)}</text></g>`);
    const body = S.block({ x: 8, y: 17, w: 84, delay: 0.12 }, para(esc(b.headline), { size: sizeFor(b.headline, [[14, 13], [24, 10.6], [40, 8.8], [56, 7.4], [999, 6]]), weight: 800, lines: 3, lh: 1.08, ls: -0.025 }) + (b.support ? para(esc(b.support), { size: 3.6, weight: 500, lines: 2, lh: 1.3, op: 0.86, mt: 2.4 }) : ""));
    return scene(g, deco + body, 155);
  },
  summary: b => `${b.kicker ? `${b.kicker}: ` : ""}${b.headline}${b.support ? ` — ${b.support}` : ""} (${b.handle}${b.tags?.length ? `, ${b.tags.join(" ")}` : ""})`,
  css: baseCss("social_post"),
});

// ---------- 6. story_card (9:16) ----------
export const storyCard = defineAsset({
  type: "story_card", category: "motion", width: "half", frame: "9:16",
  use: "A vertical story card still: a kicker at the top, a poster-scale headline in the centre and a swipe or call-to-action bar at the bottom.",
  useKo: "세로 스토리 카드 정지 화면: 위에 말머리, 가운데 포스터 크기 제목, 아래에 스와이프·행동 유도 막대.",
  tags: ["story", "vertical", "reel", "9:16", "mobile", "cta", "스토리", "세로", "릴스", "모바일"],
  notes: "Headline 60 characters, set at poster scale; cta is the bar's words (24 characters). handle is optional.",
  fields: { kicker: text(26), headline: text(60), sub: optionalText(80), cta: text(24), handle: optionalText(24), ground: groundField("violet") },
  sample: { kicker: "TODAY ONLY", headline: "Your best week starts now", sub: "Join the live session and bring one question.", cta: "Swipe up to join", handle: "@agentlas", ground: "violet" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "violet"), S = stage(90, 160);
    const bars = Array.from({ length: 5 }, (_, i) => `<rect x="${n2(7 + i * 15.2)}" y="6" width="14" height="1" rx=".5" fill="${i < 2 ? g.fg : g.fg}" fill-opacity="${i < 2 ? 0.95 : 0.3}"/>`).join("") + `<rect x="${n2(7 + 2 * 15.2)}" y="6" width="7" height="1" rx=".5" fill="${g.fg}"/>`;
    const k = fitText(b.kicker.toUpperCase(), 62, 3.1, 800), kw = em(k, 800) * 3.1 + k.length * 0.5 + 10;
    const handle = b.handle ? fitText(b.handle, 44, 3.4, 700) : "";
    const cta = fitText(b.cta, 46, 4.6, 800);
    const deco = S.svg(`<defs>${glowDef(`${uid}a`, g.mesh[0], 0.75)}${glowDef(`${uid}b`, g.mesh[1], 0.65)}${glowDef(`${uid}c`, g.hi2, 0.55)}${lineDef(`${uid}g`, g.grad[0], g.grad[1])}</defs><circle cx="84" cy="14" r="58" fill="url(#${uid}a)"/><circle cx="4" cy="150" r="70" fill="url(#${uid}c)"/><circle cx="90" cy="96" r="44" fill="url(#${uid}b)"/><path d="M0 112 90 84v16L0 130z" fill="${g.fg}" fill-opacity=".07"/><path d="M0 128 90 100v8L0 138z" fill="${g.fg}" fill-opacity=".07"/><circle cx="45" cy="76" r="52" fill="none" stroke="${g.fg}" stroke-opacity=".1" stroke-width=".7"/><circle cx="45" cy="76" r="38" fill="none" stroke="${g.fg}" stroke-opacity=".14" stroke-width=".7"/><g class="a-in" style="animation-delay:.25s"><circle cx="75" cy="45" r="8" fill="url(#${uid}g)"/><circle cx="72.6" cy="42.4" r="3.4" fill="#fff" fill-opacity=".3"/></g><g class="a-in" style="animation-delay:.35s"><rect x="10" y="116" width="9" height="9" rx="2.4" transform="rotate(18 14.5 120.5)" fill="${g.hi}" fill-opacity=".9"/><circle cx="77" cy="119" r="2.4" fill="${g.hi2}"/><path d="M60 122h10M65 117v10" stroke="${g.fg}" stroke-opacity=".6" stroke-width=".9" stroke-linecap="round"/></g>${bars}<g class="a-in" style="animation-delay:.1s"><circle cx="11.2" cy="16.4" r="4.2" fill="url(#${uid}g)"/><text x="11.2" y="16.4" dy=".36em" text-anchor="middle" font-size="4" font-weight="800" fill="${g.on}">${esc(initialOf(b.handle ?? b.kicker))}</text>${handle ? `<text x="18.2" y="16.4" dy=".36em" font-size="3.4" font-weight="700" fill="${g.fg}">${esc(handle)}</text>` : ""}</g><g class="a-in" style="animation-delay:.18s"><rect x="7" y="25" width="${n2(kw)}" height="7" rx="3.5" fill="${g.fg}" fill-opacity=".16" stroke="${g.fg}" stroke-opacity=".45" stroke-width=".3"/><circle cx="11.2" cy="28.5" r="1.1" fill="${g.fg}"/><text x="14.6" y="28.5" dy=".36em" font-size="3.1" font-weight="800" letter-spacing=".5" fill="${g.fg}">${esc(k)}</text></g><g class="a-in" style="animation-delay:.55s"><rect x="7" y="137" width="76" height="13" rx="6.5" fill="${g.fg}" fill-opacity=".18" stroke="${g.fg}" stroke-opacity=".5" stroke-width=".35"/><circle cx="16" cy="143.5" r="4.2" fill="${g.fg}"/><path d="m13.8 144.6 2.2-2.4 2.2 2.4" fill="none" stroke="${g.on}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><text x="${n2(25 + (52 - em(cta, 800) * 4.6) / 2)}" y="143.5" dy=".36em" font-size="4.6" font-weight="800" fill="${g.fg}">${esc(cta)}</text><path d="m76 141.4 2.4 2.1-2.4 2.1" fill="none" stroke="${g.fg}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></g><rect x="35" y="153.6" width="20" height=".9" rx=".45" fill="${g.fg}" fill-opacity=".5"/>`);
    const body = S.block({ x: 7, y: 38, w: 76, h: 90, mid: true, delay: 0.3 }, para(esc(b.headline), { size: sizeFor(b.headline, [[8, 21], [14, 16.4], [24, 13.4], [38, 10.8], [999, 8.6]]), weight: 800, lines: 5, lh: 1.04, ls: -0.03 }) + (b.sub ? para(esc(b.sub), { size: 4.4, weight: 500, lines: 3, lh: 1.3, op: 0.88, mt: 3.2 }) : ""));
    return scene(g, deco + body, 165);
  },
  summary: b => `${b.kicker}: ${b.headline}${b.sub ? ` — ${b.sub}` : ""} [${b.cta}]${b.handle ? ` ${b.handle}` : ""}`,
  css: baseCss("story_card"),
});

// ---------- 7. poster_layout (A4) ----------
export const posterLayout = defineAsset({
  type: "poster_layout", category: "motion", width: "half", frame: "a4",
  use: "An event or campaign poster still in portrait A4: a date block, a big title, up to four detail lines, geometric art and a footer line.",
  useKo: "세로 A4 행사·캠페인 포스터 정지 화면: 날짜 블록, 큰 제목, 세부 줄 최대 4개, 기하 도형 그림, 아래 한 줄.",
  tags: ["poster", "event", "campaign", "flyer", "a4", "date", "포스터", "행사", "전단", "캠페인"],
  notes: "day and month make the date block (day 4 characters, month 10), year is optional. details are up to four short lines (where, when, who, how).",
  fields: { title: text(50), kicker: optionalText(30), day: text(4), month: text(10), year: optionalText(6), details: list(text(40), 1, 4), footer: optionalText(60), ground: groundField("ink") },
  sample: { kicker: "AGENTLAS SUMMIT", title: "The future of work, built by agents", day: "12", month: "NOV", year: "2026", details: ["Seoul Convention Hall, Hall B", "Doors 18:30 · Talks 19:00", "Free with registration"], footer: "agentlas.com/summit · #AgentlasSummit", ground: "ink" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "ink"), S = stage(105, 148.5), dayU = b.day.length <= 2 ? 30 : b.day.length === 3 ? 22 : 17;
    const dayW = em(b.day, 800) * dayU, mx = 9 + dayW + 4, monthLabel = fitText(b.month.toUpperCase(), 96 - mx, 9, 800), monthSize = fitText(monthLabel, 96 - mx, 9, 800) === monthLabel ? 9 : 7;
    const kick = b.kicker ? `<g class="a-in"><rect x="9" y="8.2" width="6" height=".7" rx=".35" fill="${g.hi}"/><text x="17.4" y="8.55" dy=".36em" font-size="2.7" font-weight="800" letter-spacing=".5" fill="${g.hi}">${esc(fitText(b.kicker.toUpperCase(), 76, 2.7, 800))}</text></g>` : "";
    const stripes = Array.from({ length: 14 }, (_, i) => `<line x1="${n2(30 + i * 4.4)}" y1="36" x2="${n2(6 + i * 4.4)}" y2="90" />`).join("");
    const deco = S.svg(`<defs>${glowDef(`${uid}a`, g.mesh[0], 0.65)}${glowDef(`${uid}b`, g.mesh[2], 0.55)}${lineDef(`${uid}g`, g.grad[0], g.grad[1])}${lineDef(`${uid}h`, g.hi2, g.mesh[1])}<clipPath id="${uid}c"><circle cx="68" cy="62" r="24"/></clipPath></defs><circle cx="100" cy="12" r="56" fill="url(#${uid}a)"/><circle cx="6" cy="120" r="64" fill="url(#${uid}b)"/>${kick}<g class="a-in" style="animation-delay:.1s"><text x="9" y="${n2(14 + dayU * 0.74)}" font-size="${dayU}" font-weight="800" letter-spacing="-1" fill="${g.fg}">${esc(b.day)}</text><text x="${n2(mx)}" y="${n2(14 + dayU * 0.74 - (b.year ? 8.6 : 0))}" font-size="${monthSize}" font-weight="800" letter-spacing=".6" fill="${g.hi}">${esc(monthLabel)}</text>${b.year ? `<text x="${n2(mx)}" y="${n2(14 + dayU * 0.74)}" font-size="5" font-weight="700" letter-spacing=".5" fill="${g.fg}" fill-opacity=".85">${esc(fitText(b.year, 96 - mx, 5))}</text>` : ""}</g><g class="a-in" style="animation-delay:.25s"><circle cx="68" cy="62" r="41" fill="none" stroke="${g.fg}" stroke-opacity=".12" stroke-width=".5"/><circle cx="68" cy="62" r="32.5" fill="none" stroke="${g.fg}" stroke-opacity=".22" stroke-width=".5"/><circle cx="68" cy="62" r="24" fill="url(#${uid}g)"/><g clip-path="url(#${uid}c)" stroke="${g.on}" stroke-opacity=".2" stroke-width="1.1">${stripes}</g><circle cx="42" cy="71" r="14" fill="url(#${uid}h)" fill-opacity=".92"/><circle cx="42" cy="71" r="14" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width=".4"/><path d="M88 44l9 15.5H79z" fill="${g.fg}" fill-opacity=".9"/><path d="M88 44l9 15.5H79z" transform="translate(-2.4 2.8)" fill="none" stroke="${g.fg}" stroke-opacity=".6" stroke-width=".4"/><circle cx="20" cy="46" r="2.6" fill="${g.hi}"/><circle cx="94" cy="76" r="1.6" fill="${g.hi2}"/><path d="M9.6 62h6.4M12.8 58.8v6.4" stroke="${g.fg}" stroke-opacity=".7" stroke-width=".8" stroke-linecap="round"/></g>${b.footer ? `<line x1="9" y1="139.6" x2="96" y2="139.6" stroke="${g.fg}" stroke-opacity=".3" stroke-width=".35"/>` : ""}`);
    const title = S.block({ x: 9, y: 117, w: 87, bottom: true, delay: 0.35 }, para(esc(b.title), { size: sizeFor(b.title, [[10, 15], [18, 12.4], [30, 10], [999, 8.4]]), weight: 800, lines: 3, lh: 1.08, ls: -0.025 }));
    const rows = S.block({ x: 9, y: 120, w: 87, delay: 0.45 }, b.details.map((d, i) => para(esc(d), { size: 3.1, weight: 600, lines: 1, lh: 1.4, op: 0.9, cls: "a-dl" })).join(""));
    const foot = b.footer ? S.block({ x: 9, y: 141.4, w: 87, delay: 0.55 }, para(esc(b.footer), { size: 2.1, weight: 700, lines: 1, ls: 0.08, op: 0.75 })) : "";
    return scene(g, deco + title + rows + foot, 160);
  },
  summary: b => `${b.kicker ? `${b.kicker}: ` : ""}${b.title}. ${b.day} ${b.month}${b.year ? ` ${b.year}` : ""}. ${b.details.join("; ")}${b.footer ? `. ${b.footer}` : ""}`,
  css: baseCss("poster_layout", ".fpc .a-poster_layout .a-dl{position:relative;padding-left:3.6cqw}.fpc .a-poster_layout .a-dl::before{content:\"\";position:absolute;left:0;top:.62em;width:2cqw;height:.45cqw;border-radius:1cqw;background:currentColor;opacity:.8}"),
});

// ---------- 11. wave_audio_card (16:9) ----------
const secondsOf = (s?: string) => { if (!s) return NaN; const p = s.split(":").map(Number); return p.some(Number.isNaN) ? NaN : p.reduce((a, v) => a * 60 + v, 0); };
export const waveAudioCard = defineAsset({
  type: "wave_audio_card", category: "motion", width: "half", frame: "16:9",
  use: "A podcast or music card still: a large waveform drawn from peaks with a progress knob, the title, the host or artist and the time stamps.",
  useKo: "팟캐스트·음악 카드 정지 화면: 피크로 그린 큰 파형과 재생 위치 손잡이, 제목, 진행자·아티스트, 시간 표시.",
  tags: ["audio", "podcast", "music", "waveform", "player", "episode", "오디오", "팟캐스트", "음악", "파형"],
  notes: "peaks are 8-96 numbers (any scale; drawn relative to the largest). Without peaks a waveform is drawn from the title. progress is 0-1 or a percent; otherwise it follows elapsed over duration.",
  fields: { track: text(60), artist: text(40), kicker: optionalText(24), duration: text(8), elapsed: optionalText(8), progress: optionalNum, peaks: list(z.number().finite().min(0), 8, 96).optional(), ground: groundField("violet") },
  sample: { kicker: "EPISODE 42", track: "How small teams build with agents", artist: "The Build Notes · with Mina Park", duration: "42:18", elapsed: "17:05", peaks: [0.2, 0.35, 0.5, 0.42, 0.6, 0.75, 0.55, 0.4, 0.62, 0.8, 0.95, 0.7, 0.5, 0.58, 0.72, 0.9, 0.66, 0.45, 0.38, 0.5, 0.68, 0.85, 0.74, 0.52, 0.4, 0.3, 0.46, 0.64, 0.78, 0.6, 0.44, 0.34, 0.5, 0.7, 0.88, 0.76, 0.55, 0.42, 0.36, 0.48, 0.6, 0.72, 0.5, 0.38, 0.28, 0.4, 0.55, 0.45, 0.3, 0.22], ground: "violet" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "violet"), S = stage(160, 90), N = 64, r = rng(hash(b.track)), seed = hash(b.track);
    let p = b.progress !== undefined ? (b.progress > 1 ? b.progress / 100 : b.progress) : secondsOf(b.elapsed) / secondsOf(b.duration);
    p = clamp(Number.isFinite(p) ? p : 0.4, 0, 1);
    const peaks = b.peaks ?? Array.from({ length: N }, (_, i) => 0.3 + 0.32 * Math.abs(Math.sin(i * 0.31 + (seed % 7))) + 0.22 * Math.abs(Math.sin(i * 0.9 + (seed % 5))) + 0.16 * r());
    const top = Math.max(...peaks, 1e-9), bars = Array.from({ length: N }, (_, j) => { const a = Math.floor((j * peaks.length) / N), z = Math.max(a + 1, Math.floor(((j + 1) * peaks.length) / N)); let m = 0; for (let q = a; q < z; q++) m = Math.max(m, peaks[q] ?? 0); return clamp(m / top, 0.07, 1); });
    const x0 = 9, pitch = 142 / N, cy = 55, kx = x0 + p * 142, bw = pitch * 0.58;
    const wave = bars.map((v, j) => { const x = x0 + j * pitch + (pitch - bw) / 2, h = v * 21, played = x + bw / 2 <= kx; return `<rect x="${n2(x)}" y="${n2(cy - h / 2)}" width="${n2(bw)}" height="${n2(Math.max(1, h))}" rx="${n2(bw / 2)}" fill="${played ? `url(#${uid}p)` : g.fg}" ${played ? "" : 'fill-opacity=".34"'}/>`; }).join("");
    const pool = [...new Set([g.hi2, g.mesh[0], g.mesh[1], g.mesh[2], g.mesh[3], g.hi])], ia = seed % pool.length, ib = (ia + 1 + ((seed >> 4) % (pool.length - 1))) % pool.length, hueA = pool[ia], hueB = pool[ib];
    const art = `<g class="a-in"><clipPath id="${uid}k"><rect x="9" y="8" width="29" height="29" rx="5"/></clipPath><rect x="9" y="8" width="29" height="29" rx="5" fill="url(#${uid}t)"/><g clip-path="url(#${uid}k)"><circle cx="${n2(14 + (seed % 9))}" cy="${n2(14 + (seed % 7))}" r="14" fill="#fff" fill-opacity=".22"/><circle cx="33" cy="33" r="17" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width=".7"/><circle cx="33" cy="33" r="11" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width=".7"/><circle cx="33" cy="33" r="5" fill="#fff"/></g><rect x="9" y="8" width="29" height="29" rx="5" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width=".4"/></g>`;
    const t1 = fitText(b.elapsed ?? "", 24, 3.2, 700), t2 = fitText(b.duration, 24, 3.2, 700);
    const deco = S.svg(`<defs>${glowDef(`${uid}a`, g.mesh[0], 0.6)}${glowDef(`${uid}b`, g.mesh[1], 0.5)}${lineDef(`${uid}t`, hueA, hueB)}<linearGradient id="${uid}p" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${g.grad[1]}"/><stop offset="1" stop-color="${g.grad[0]}"/></linearGradient></defs><circle cx="150" cy="6" r="62" fill="url(#${uid}a)"/><circle cx="4" cy="94" r="56" fill="url(#${uid}b)"/>${art}<g class="a-in" style="animation-delay:.2s">${wave}</g><g class="a-in" style="animation-delay:.5s"><line x1="${n2(kx)}" y1="42" x2="${n2(kx)}" y2="68" stroke="#fff" stroke-width=".7" stroke-linecap="round"/><circle cx="${n2(kx)}" cy="${cy}" r="5.2" fill="#fff" fill-opacity=".25"/><circle cx="${n2(kx)}" cy="${cy}" r="3" fill="#fff"/><circle cx="${n2(kx)}" cy="${cy}" r="1.2" fill="${g.hi2}"/></g><g class="a-in" style="animation-delay:.6s">${b.elapsed ? `<text x="9" y="80" dy=".36em" font-size="3.2" font-weight="700" fill="${g.fg}" fill-opacity=".9">${esc(t1)}</text>` : ""}<text x="151" y="80" dy=".36em" text-anchor="end" font-size="3.2" font-weight="700" fill="${g.fg}" fill-opacity=".7">${esc(t2)}</text><circle cx="80" cy="80" r="5" fill="#fff"/><path d="M78.4 77.2 83 80l-4.6 2.8z" fill="${g.on}" stroke="${g.on}" stroke-width=".6" stroke-linejoin="round"/><path d="M68 77.6v4.8M72.6 77.6l-3 2.4 3 2.4zM92 77.6v4.8M87.4 77.6l3 2.4-3 2.4z" fill="${g.fg}" stroke="${g.fg}" stroke-width=".7" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/></g>`);
    const text1 = S.block({ x: 44, y: 8, w: 107, h: 29, mid: true, delay: 0.12 }, (b.kicker ? para(esc(b.kicker), { size: 2.1, weight: 800, ls: 0.16, color: g.hi, lines: 1, upper: true }) : "") + para(esc(b.track), { size: sizeFor(b.track, [[16, 6.4], [28, 5.2], [44, 4.4], [999, 3.9]]), weight: 800, lines: 2, lh: 1.12, ls: -0.02, mt: b.kicker ? 0.8 : 0 }) + para(esc(b.artist), { size: 2.9, weight: 600, lines: 1, op: 0.85, mt: 1 }));
    return scene(g, deco + text1, 155);
  },
  summary: b => `${b.kicker ? `${b.kicker}: ` : ""}${b.track} — ${b.artist}. ${b.elapsed ? `${b.elapsed} of ` : ""}${b.duration}.`,
  css: baseCss("wave_audio_card"),
});

export const ASSETS: readonly AnyAsset[] = [socialPost, storyCard, posterLayout, waveAudioCard];
