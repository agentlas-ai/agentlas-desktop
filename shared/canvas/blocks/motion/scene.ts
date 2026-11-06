import { z } from "zod";
import { esc } from "../../kit";
import { list, loose, num, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { baseCss, clamp, dly, em, fitSize, fitText, glowDef, glyphAt, glyphField, groundField, groundOf, lineDef, n2, para, scene, sizeFor, stage } from "./_b";

/** Freeze-frames of an animated explainer: a process, an icon burst, a mesh cover, a certified stamp, a chapter title. Frame 16:9, type in cqw, entrance animation ends on the still. */

// ---------- 1. process_hero ----------
const step = z.object({ title: text(26), line: optionalText(48) }).strip();
export const processHero = defineAsset({
  type: "process_hero", category: "motion", width: "half", frame: "16:9",
  use: "A poster-like still of a three or four step process: big numbered shapes joined by a flowing line, a headline above and a title and short line per step.",
  useKo: "세 단계나 네 단계 과정을 큰 번호 도형과 흐르는 선으로 보여 주는 포스터형 정지 화면: 위에 제목, 단계마다 이름과 짧은 설명.",
  tags: ["process", "steps", "how it works", "flow", "explainer", "motion", "프로세스", "단계", "작동 방식", "설명 영상"],
  notes: "3-4 steps, each a title (26 characters) and an optional line (48). ground: ink, blue, green, violet, sunset or paper.",
  fields: { headline: text(70), kicker: optionalText(28), steps: list(step, 3, 4), ground: groundField("blue") },
  sample: { kicker: "HOW IT WORKS", headline: "From first idea to a live product in four moves", steps: [{ title: "Describe the goal", line: "Say what you need in plain words." }, { title: "Hire the team", line: "Agents are matched to every role." }, { title: "Review the plan", line: "Approve each step before work starts." }, { title: "Ship and learn", line: "Results land in one place, ready to share." }], ground: "blue" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "blue"), S = stage(160, 90), n = b.steps.length, colW = 140 / n, s = n === 3 ? 20 : 18;
    const X = (i: number) => 10 + colW * (i + 0.5), Y = (i: number) => (i % 2 ? 47 : 43);
    const way: [number, number][] = [[-6, 54], ...b.steps.map((_, i) => [X(i), Y(i)] as [number, number]), [166, 36]];
    let d = `M${way[0][0]} ${way[0][1]}`, beads = "";
    for (let i = 1; i < way.length; i++) {
      const [x0, y0] = way[i - 1], [x1, y1] = way[i], h = (x1 - x0) * 0.5;
      d += `C${n2(x0 + h)} ${y0} ${n2(x1 - h)} ${y1} ${x1} ${y1}`;
      if (i >= 2 && i < way.length - 1) { const a = (Math.atan2(1.5 * (y1 - y0), 0.75 * (x1 - x0)) * 180) / Math.PI; beads += `<path transform="translate(${n2((x0 + x1) / 2)} ${n2((y0 + y1) / 2)}) rotate(${n2(a)})" d="M-1.5-2.1 1.2 0-1.5 2.1" fill="none" stroke="${g.hi}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>`; }
    }
    const nodes = b.steps.map((st, i) => {
      const x = X(i), y = Y(i), h = s * 0.7;
      return `<g class="a-in" style="animation-delay:${dly(i, 0.15, 0.14)}s"><rect x="${n2(x - h)}" y="${n2(y - h)}" width="${n2(h * 2)}" height="${n2(h * 2)}" rx="${n2(s * 0.46)}" fill="${g.hi}" opacity=".16"/><rect x="${n2(x - s * 0.55)}" y="${n2(y - s * 0.55)}" width="${n2(s * 1.1)}" height="${n2(s * 1.1)}" rx="${n2(s * 0.4)}" fill="none" stroke="${g.fg}" stroke-opacity=".28" stroke-width=".5"/><rect x="${n2(x - s / 2)}" y="${n2(y - s / 2)}" width="${s}" height="${s}" rx="${n2(s * 0.32)}" fill="url(#${uid}n)"/><circle cx="${n2(x - s * 0.22)}" cy="${n2(y - s * 0.24)}" r="${n2(s * 0.26)}" fill="#fff" opacity=".16"/><text x="${n2(x)}" y="${n2(y)}" dy=".36em" text-anchor="middle" font-size="${n === 3 ? 9.6 : 8.6}" font-weight="800" fill="${g.on}">${i + 1}</text></g>`;
    }).join("");
    const cols = b.steps.map((st, i) => S.block({ x: X(i) - colW / 2 + 1.5, y: Y(i) + s / 2 + 3.5, w: colW - 3, align: "center", delay: dly(i, 0.3, 0.14) }, para(esc(st.title), { size: n === 3 ? 3.2 : 2.9, weight: 800, lines: 2, lh: 1.12 }) + (st.line ? para(esc(st.line), { size: n === 3 ? 2.4 : 2.15, weight: 500, lines: 3, lh: 1.28, op: 0.82, mt: 0.6 }) : ""))).join("");
    const deco = S.svg(`<defs>${glowDef(`${uid}g`, g.hi2, 0.55)}${glowDef(`${uid}h`, g.hi, 0.28)}${lineDef(`${uid}n`, g.grad[0], g.grad[1])}<linearGradient id="${uid}l" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="160" y2="0"><stop offset="0" stop-color="${g.hi2}"/><stop offset="1" stop-color="${g.hi}"/></linearGradient></defs><circle cx="150" cy="4" r="64" fill="url(#${uid}g)"/><circle cx="6" cy="92" r="52" fill="url(#${uid}h)"/><circle cx="142" cy="12" r="38" fill="none" stroke="${g.fg}" stroke-opacity=".13" stroke-width=".6"/><circle cx="142" cy="12" r="25" fill="none" stroke="${g.fg}" stroke-opacity=".2" stroke-width=".6"/><circle cx="142" cy="12" r="11" fill="${g.fg}" fill-opacity=".1"/><path d="${d}" fill="none" stroke="${g.fg}" stroke-opacity=".12" stroke-width="6.5" stroke-linecap="round"/><path d="${d}" fill="none" stroke="url(#${uid}l)" stroke-width="1.3" stroke-linecap="round"/>${beads}${nodes}`);
    const head = S.block({ x: 10, y: 6, w: 110 }, (b.kicker ? para(esc(b.kicker), { size: 2.1, weight: 800, ls: 0.16, color: g.hi, lines: 1, upper: true }) : "") + para(esc(b.headline), { size: sizeFor(b.headline, [[20, 6], [34, 5.2], [50, 4.5], [999, 4]]), weight: 800, lines: 2, lh: 1.08, ls: -0.02, mt: b.kicker ? 0.8 : 0 }));
    return scene(g, deco + head + cols);
  },
  summary: b => `${b.kicker ? `${b.kicker}: ` : ""}${b.headline}. ${b.steps.map((st, i) => `${i + 1}. ${st.title}${st.line ? ` (${st.line})` : ""}`).join(" ")}`,
  css: baseCss("process_hero"),
});

// ---------- 2. icon_burst ----------
const burstItem = z.object({ icon: glyphField("star"), label: text(16) }).strip();
export const iconBurst = defineAsset({
  type: "icon_burst", category: "motion", width: "half", frame: "16:9",
  use: "A still of one central badge with six to ten labelled geometric icons radiating around it on rings, with a headline: features, benefits, a product's parts.",
  useKo: "가운데 배지 둘레에 라벨 달린 기하 아이콘 6~10개가 고리를 따라 퍼지는 정지 화면과 제목: 기능, 장점, 제품 구성.",
  tags: ["icons", "features", "benefits", "burst", "hub", "radial", "아이콘", "기능", "장점", "방사형"],
  notes: "icon is a word: bolt shield chart chat globe lock heart star cloud mail bell user clock bulb rocket check code search leaf target (synonyms such as security, growth, team work). core is the badge text (10 characters); labels 16.",
  fields: { headline: text(60), kicker: optionalText(28), core: text(10), items: list(burstItem, 6, 10), ground: groundField("ink") },
  sample: { kicker: "ONE WORKSPACE", headline: "Everything your team needs, in one place", core: "Atlas", items: [{ icon: "bolt", label: "Fast sync" }, { icon: "shield", label: "Secure" }, { icon: "chart", label: "Insights" }, { icon: "chat", label: "Team chat" }, { icon: "globe", label: "Global" }, { icon: "lock", label: "Private" }, { icon: "heart", label: "Loved" }, { icon: "star", label: "Top rated" }], ground: "ink" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "ink"), S = stage(160, 90), cx = 80, cy = 55, n = b.items.length, sides: number[][] = [[], []];
    b.items.forEach((_, i) => sides[i % 2].push(i));
    const pos = b.items.map((_, i) => {
      const side = i % 2, list = sides[side], k = list.indexOf(i), m = list.length, dy = (k - (m - 1) / 2) * 12.5, sign = side === 0 ? 1 : -1;
      return { x: cx + sign * 36 * Math.sqrt(Math.max(0, 1 - (dy / 29) ** 2)), y: cy + dy, sign };
    });
    const spokes = pos.map(p => `<line x1="${cx}" y1="${cy}" x2="${n2(p.x)}" y2="${n2(p.y)}" stroke="${g.hi}" stroke-opacity=".4" stroke-width=".5" stroke-dasharray="1 1.5" stroke-linecap="round"/>`).join("");
    const chips = b.items.map((it, i) => {
      const p = pos[i], r = 5.4, lx = p.x + p.sign * (r + 2.4), maxW = p.sign > 0 ? 152 - lx : lx - 8;
      return `<g class="a-in" style="animation-delay:${dly(i, 0.2, 0.08)}s"><circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="8.4" fill="${g.hi}" opacity=".14"/><circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="${r}" fill="url(#${uid}c)"/>${glyphAt(it.icon, p.x, p.y, 6.6, g.on, 2.1)}<text x="${n2(lx)}" y="${n2(p.y)}" dy=".36em" text-anchor="${p.sign > 0 ? "start" : "end"}" font-size="3.6" font-weight="700" fill="${g.fg}">${esc(fitText(it.label, Math.min(maxW, 30), 3.6))}</text></g>`;
    }).join("");
    const coreSize = fitSize(b.core, 19, 6.6, 3.2, 800);
    const deco = S.svg(`<defs>${glowDef(`${uid}g`, g.hi2, 0.5)}${glowDef(`${uid}h`, g.hi, 0.3)}${lineDef(`${uid}c`, g.grad[0], g.grad[1])}${lineDef(`${uid}b`, g.grad[1], g.grad[0])}</defs><circle cx="${cx}" cy="${cy}" r="62" fill="url(#${uid}g)"/><circle cx="${cx}" cy="${cy}" r="30" fill="url(#${uid}h)"/><circle cx="${cx}" cy="${cy}" r="54" fill="none" stroke="${g.fg}" stroke-opacity=".08" stroke-width=".6"/><circle cx="${cx}" cy="${cy}" r="42" fill="none" stroke="${g.fg}" stroke-opacity=".12" stroke-width=".6"/><circle cx="${cx}" cy="${cy}" r="30" fill="none" stroke="${g.fg}" stroke-opacity=".16" stroke-width=".6"/><circle cx="${cx}" cy="${cy}" r="18.5" fill="none" stroke="${g.hi}" stroke-opacity=".5" stroke-width=".7" stroke-dasharray="1.2 1.8" stroke-linecap="round"/>${spokes}<g class="a-in"><circle cx="${cx}" cy="${cy}" r="14.5" fill="${g.hi}" opacity=".18"/><circle cx="${cx}" cy="${cy}" r="11.5" fill="url(#${uid}b)"/><circle cx="${cx - 3}" cy="${cy - 4}" r="6" fill="#fff" opacity=".16"/><text x="${cx}" y="${cy}" dy=".36em" text-anchor="middle" font-size="${n2(coreSize)}" font-weight="800" fill="${g.on}">${esc(b.core)}</text></g>${chips}`);
    const head = S.block({ x: 8, y: 6, w: 76 }, (b.kicker ? para(esc(b.kicker), { size: 2.1, weight: 800, ls: 0.16, color: g.hi, lines: 1, upper: true }) : "") + para(esc(b.headline), { size: sizeFor(b.headline, [[24, 5.6], [40, 4.8], [999, 4.2]]), weight: 800, lines: 2, lh: 1.1, ls: -0.015, mt: b.kicker ? 0.8 : 0 }));
    return scene(g, deco + head, 140);
  },
  summary: b => `${b.headline}. ${b.core} at the centre of ${b.items.map(i => i.label).join(", ")}.`,
  css: baseCss("icon_burst"),
});

// ---------- 3. gradient_cover ----------
export const gradientCover = defineAsset({
  type: "gradient_cover", category: "motion", width: "half", frame: "16:9",
  use: "A mesh-gradient cover still for a report, a video or a deck section: a kicker, a poster-scale headline, a subtitle and a footer line.",
  useKo: "보고서·영상·섹션의 표지용 메시 그라데이션 정지 화면: 말머리, 큰 제목, 부제, 아래 한 줄.",
  tags: ["cover", "gradient", "mesh", "title", "report", "video", "표지", "그라데이션", "커버", "제목"],
  notes: "Headline 80 characters; the footer is one short line (author, date, edition). ground: ink, blue, green, violet, sunset or paper.",
  fields: { headline: text(80), kicker: optionalText(28), subtitle: optionalText(100), footer: optionalText(60), ground: groundField("violet") },
  sample: { kicker: "ANNUAL REPORT 2026", headline: "A year of compounding growth", subtitle: "What moved, what stalled and what we build next", footer: "Agentlas Research · Published November 2026", ground: "violet" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "violet"), S = stage(160, 90), m = g.mesh, light = !g.dark;
    const spots: [number, number, number, string, number][] = [[16, 10, 66, m[0], 0.95], [146, 14, 62, m[1], 0.92], [104, 96, 74, m[2], 0.9], [20, 92, 56, m[3], 0.85], [152, 74, 50, m[4], 0.85], [88, 34, 44, "#ffffff", light ? 0.5 : 0.16]];
    const defs = spots.map((sp, i) => glowDef(`${uid}m${i}`, sp[3], sp[4])).join("") + glowDef(`${uid}s`, g.bg[0], light ? 0 : 0.7);
    const blobs = spots.map((sp, i) => `<circle cx="${sp[0]}" cy="${sp[1]}" r="${sp[2]}" fill="url(#${uid}m${i})"/>`).join("");
    const dots = [0, 1, 2, 3, 4].flatMap(c => [0, 1, 2].map(r => `<circle cx="${n2(130 + c * 4.6)}" cy="${n2(64 + r * 4.6)}" r=".7" fill="${g.fg}" opacity="${n2(0.5 - c * 0.07)}"/>`)).join("");
    const k = b.kicker ? fitText(b.kicker.toUpperCase(), 74, 3.2, 800) : "", kw = k ? em(k, 800) * 3.2 + k.length * 0.5 + 11 : 0;
    const pill = k ? `<g class="a-in" style="animation-delay:.1s"><rect x="9" y="8" width="${n2(kw)}" height="7.2" rx="3.6" fill="${g.fg}" fill-opacity=".14" stroke="${g.fg}" stroke-opacity=".4" stroke-width=".35"/><circle cx="13.2" cy="11.6" r="1.1" fill="${g.fg}"/><text x="17" y="11.6" dy=".36em" font-size="3.2" font-weight="800" letter-spacing=".5" fill="${g.fg}">${esc(k)}</text></g>` : "";
    const deco = S.svg(`<defs>${defs}</defs>${blobs}<circle cx="30" cy="70" r="75" fill="url(#${uid}s)"/><circle cx="124" cy="38" r="44" fill="none" stroke="${g.fg}" stroke-opacity=".12" stroke-width=".6"/><circle cx="124" cy="38" r="30" fill="none" stroke="${g.fg}" stroke-opacity=".18" stroke-width=".6"/><circle cx="124" cy="38" r="16" fill="none" stroke="${g.fg}" stroke-opacity=".26" stroke-width=".6"/><circle cx="124" cy="38" r="4" fill="${g.fg}" fill-opacity=".5"/>${dots}${pill}${b.footer ? `<line x1="9" y1="77.5" x2="151" y2="77.5" stroke="${g.fg}" stroke-opacity=".3" stroke-width=".35"/>` : ""}`);
    const text1 = S.block({ x: 9, y: b.subtitle ? 63 : 70, w: 118, bottom: true, delay: 0.2 }, para(esc(b.headline), { size: sizeFor(b.headline, [[16, 9.4], [28, 7.6], [44, 6.2], [62, 5.2], [999, 4.5]]), weight: 800, lines: 3, lh: 1.04, ls: -0.025 }));
    const sub = b.subtitle ? S.block({ x: 9, y: 65, w: 104, delay: 0.32 }, para(esc(b.subtitle), { size: 2.6, weight: 500, lines: 2, lh: 1.3, op: 0.88 })) : "";
    const foot = b.footer ? S.block({ x: 9, y: 80, w: 142, delay: 0.42 }, para(esc(b.footer), { size: 2.05, weight: 700, lines: 1, ls: 0.1, op: 0.8, upper: true })) : "";
    return scene(g, deco + text1 + sub + foot, 160);
  },
  summary: b => [b.kicker, b.headline, b.subtitle, b.footer].filter(Boolean).join(" — "),
  css: baseCss("gradient_cover"),
});

// ---------- 4. badge_stamp ----------
const KINDS = ["approved", "new", "beta", "verified", "sale"] as [string, ...string[]];
const KIND_LOOK: Record<string, { color: string; lite: string; word: [string, string]; low: [string, string] }> = {
  approved: { color: "#0f8a5f", lite: "#2fcf95", word: ["APPROVED", "승인됨"], low: ["OFFICIAL SEAL", "공식 승인"] },
  new: { color: "#e8590c", lite: "#ffa23d", word: ["NEW", "신규"], low: ["JUST LAUNCHED", "방금 출시"] },
  beta: { color: "#6d28d9", lite: "#a78bfa", word: ["BETA", "베타"], low: ["EARLY ACCESS", "얼리 액세스"] },
  verified: { color: "#2347b8", lite: "#6c97ff", word: ["VERIFIED", "인증됨"], low: ["CERTIFIED", "공식 인증"] },
  sale: { color: "#d1243c", lite: "#ff6b81", word: ["SALE", "세일"], low: ["LIMITED TIME", "기간 한정"] },
};
const scallop = (r: number, amp: number, bumps: number) => { const steps = bumps * 10; let d = ""; for (let i = 0; i < steps; i++) { const t = (i / steps) * Math.PI * 2, rad = r - amp * (1 - Math.abs(Math.sin((bumps * t) / 2))); d += `${i ? "L" : "M"}${n2(rad * Math.cos(t))} ${n2(rad * Math.sin(t))}`; } return `${d}Z`; };
const starPath = (cx: number, cy: number, r1: number, r2: number) => { let d = ""; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? r2 : r1; d += `${i ? "L" : "M"}${n2(cx + r * Math.cos(a))} ${n2(cy + r * Math.sin(a))}`; } return `${d}Z`; };
export const badgeStamp = defineAsset({
  type: "badge_stamp", category: "motion", width: "half", frame: "16:9",
  use: "A still with a round tilted certification stamp (approved, new, beta, verified or sale) with arced text and a star ring, beside a headline and a supporting line.",
  useKo: "기울어진 둥근 인증 도장(승인·신규·베타·인증·세일)과 호 모양 글자, 별 고리를 제목·보조 문장 옆에 놓은 정지 화면.",
  tags: ["stamp", "badge", "approved", "verified", "sale", "seal", "도장", "인증", "배지", "승인"],
  notes: "kind picks the stamp: approved, new, beta, verified or sale (its word follows the card language). detail is the small arced line along the bottom (28 characters).",
  fields: { headline: text(60), note: optionalText(110), kicker: optionalText(24), kind: loose(KINDS, { approve: "approved", ok: "approved", passed: "approved", pass: "approved", certified: "verified", verify: "verified", official: "verified", discount: "sale", offer: "sale", deal: "sale", promo: "sale", launch: "new", fresh: "new", preview: "beta", alpha: "beta", early: "beta" }, "approved").default("approved"), detail: optionalText(28), ground: groundField("paper") },
  sample: { kicker: "COMPLIANCE REVIEW", headline: "Cleared for release", note: "Security, privacy and accessibility checks all passed on the final build.", kind: "approved", detail: "Release 4.2 · Nov 2026", ground: "paper" },
  render(b, { uid, T }) {
    const g = groundOf(b.ground, "paper"), S = stage(160, 90), look = KIND_LOOK[b.kind] ?? KIND_LOOK.approved, word = T(look.word[0], look.word[1]);
    const low = fitText((b.detail ?? T(look.low[0], look.low[1])).toUpperCase(), 60, 3.4, 700), R = 20.4;
    const stars = Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return starPath(27.6 * Math.cos(a), 27.6 * Math.sin(a), 1.55, 0.65); }).join("");
    const rays = Array.from({ length: 14 }, (_, k) => { const a0 = (k * 2 * Math.PI) / 14, a1 = a0 + Math.PI / 14; return `M117 45L${n2(117 + 150 * Math.cos(a0))} ${n2(45 + 150 * Math.sin(a0))}L${n2(117 + 150 * Math.cos(a1))} ${n2(45 + 150 * Math.sin(a1))}Z`; }).join("");
    const sparkle = (r: number) => `M0 ${-r}Q0 0 ${r} 0Q0 0 0 ${r}Q0 0 ${-r} 0Q0 0 0 ${-r}Z`;
    const mark = b.kind === "beta" ? `<text x="0" y="0.6" dy=".36em" text-anchor="middle" font-size="17" font-weight="800" fill="${look.color}">β</text>`
      : b.kind === "sale" ? `<g fill="none" stroke="${look.color}" stroke-width="2.4" stroke-linecap="round"><circle cx="-3.6" cy="-3.9" r="2.5"/><circle cx="3.6" cy="3.9" r="2.5"/><path d="M5.2-6.6-5.2 6.6"/></g>`
      : b.kind === "new" ? `<path d="${sparkle(8.4)}" fill="${look.color}"/><path d="${sparkle(3.2)}" transform="translate(6.6 -6.2)" fill="${look.color}"/>`
      : b.kind === "verified" ? `<path d="M0-8.6 7.8-5.6v5.4C7.8 4.1 4.6 7.4 0 9 -4.6 7.4-7.8 4.1-7.8-.2v-5.4z" fill="${look.color}"/><path d="m-3.6 0.4 2.5 2.5 4.6-5.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="m-7.4 0.6 5 5L7.6-5.4" fill="none" stroke="${look.color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    const stamp = `<g class="a-in a-sl"><g transform="translate(117 45) rotate(-9)"><circle r="40" fill="url(#${uid}p)"/><path d="${scallop(33, 1.7, 22)}" transform="translate(1.4 1.8)" fill="#000" opacity=".16"/><path d="${scallop(33, 1.7, 22)}" fill="url(#${uid}k)"/><circle r="30.6" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width=".5"/><path d="${stars}" fill="#fff" fill-opacity=".9"/><circle r="25.8" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width=".35"/><circle r="17.4" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width=".35"/><path id="${uid}t" d="M${-R} 0A${R} ${R} 0 0 1 ${R} 0" fill="none"/><path id="${uid}u" d="M-24.6 0A24.6 24.6 0 0 0 24.6 0" fill="none"/><text font-size="${n2(fitSize(word, 40, 5.6, 3.4, 800))}" font-weight="800" letter-spacing="1.1" fill="#fff"><textPath href="#${uid}t" startOffset="50%" text-anchor="middle">${esc(word)}</textPath></text><text font-size="3.4" font-weight="700" letter-spacing=".6" fill="#fff" fill-opacity=".92"><textPath href="#${uid}u" startOffset="50%" text-anchor="middle">${esc(low)}</textPath></text><circle r="12.6" fill="#fff"/><circle r="12.6" fill="none" stroke="${look.color}" stroke-opacity=".25" stroke-width=".5"/>${mark}</g></g>`;
    const deco = S.svg(`<defs>${glowDef(`${uid}p`, look.lite, g.dark ? 0.5 : 0.3)}${lineDef(`${uid}k`, look.lite, look.color)}${glowDef(`${uid}a`, g.mesh[0], 0.7)}${glowDef(`${uid}b`, g.mesh[1], 0.7)}</defs><circle cx="14" cy="86" r="52" fill="url(#${uid}a)"/><circle cx="150" cy="4" r="44" fill="url(#${uid}b)"/><path d="${rays}" fill="${look.color}" opacity="${g.dark ? 0.12 : 0.07}"/>${stamp}<circle cx="12" cy="10" r="1.4" fill="${g.hi}"/><circle cx="68" cy="84" r="1" fill="${g.hi2}"/><circle cx="150" cy="82" r="1.6" fill="${g.hi}"/><path d="m92 10 1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5z" fill="${g.hi2}" opacity=".85"/>`);
    const left = S.block({ x: 10, y: 10, w: 68, h: 70, mid: true, delay: 0.1 }, (b.kicker ? para(esc(b.kicker), { size: 2.1, weight: 800, ls: 0.16, color: look.color, lines: 1, upper: true }) : "") + para(esc(b.headline), { size: sizeFor(b.headline, [[14, 8.4], [22, 7], [36, 5.8], [999, 4.8]]), weight: 800, lines: 3, lh: 1.06, ls: -0.02, mt: b.kicker ? 1 : 0 }) + (b.note ? para(esc(b.note), { size: 2.5, weight: 500, lines: 3, lh: 1.32, op: 0.8, mt: 1.6 }) : ""));
    return scene(g, deco + left, 160);
  },
  summary: b => `${(KIND_LOOK[b.kind] ?? KIND_LOOK.approved).word[0]} stamp: ${b.headline}${b.note ? `. ${b.note}` : ""}${b.detail ? ` (${b.detail})` : ""}`,
  css: baseCss("badge_stamp", ".fpc .a-badge_stamp .a-sl{animation-name:a-badge_stamp-y;animation-duration:.7s;animation-delay:.25s;animation-timing-function:cubic-bezier(.3,1.5,.5,1)}@keyframes a-badge_stamp-y{from{opacity:0;transform:scale(1.7) rotate(-22deg)}}"),
});

// ---------- 12. chapter_title ----------
export const chapterTitle = defineAsset({
  type: "chapter_title", category: "motion", width: "half", frame: "16:9",
  use: "A video chapter title still: a huge chapter number, the chapter name, a progress dots row (n of total) and a thin timeline strip at the bottom.",
  useKo: "영상 챕터 타이틀 정지 화면: 거대한 챕터 번호, 챕터 이름, n/총수 진행 점 줄, 아래의 얇은 타임라인 띠.",
  tags: ["chapter", "title card", "video", "progress", "section", "챕터", "타이틀", "영상", "진행"],
  notes: "number is the chapter's place, total the chapter count (dots show up to 12, the strip up to 24). series is the video name, time the chapter's start.",
  fields: { number: num, total: num, chapter: text(60), series: optionalText(40), time: optionalText(10), ground: groundField("green") },
  sample: { number: 3, total: 8, chapter: "Why the first week decides everything", series: "The Onboarding Playbook", time: "04:32", ground: "green" },
  render(b, { uid, T }) {
    const g = groundOf(b.ground, "green"), S = stage(160, 90);
    const total = clamp(Math.round(b.total), 1, 24), num0 = Math.max(1, Math.round(b.number)), cur = clamp(b.total > 24 ? Math.ceil((num0 * 24) / b.total) : num0, 1, total);
    const label = String(num0).padStart(2, "0"), size = label.length <= 2 ? 62 : label.length === 3 ? 42 : 30;
    const dots = total <= 12 ? Array.from({ length: total }, (_, i) => {
      const x = 94 + i * 5.2, y = 66;
      return i + 1 === cur ? `<circle cx="${n2(x)}" cy="${y}" r="3.1" fill="none" stroke="${g.hi}" stroke-width=".7"/><circle cx="${n2(x)}" cy="${y}" r="1.9" fill="${g.hi}"/>` : `<circle cx="${n2(x)}" cy="${y}" r="1.5" fill="${i + 1 < cur ? g.hi : "none"}" ${i + 1 < cur ? "" : `stroke="${g.fg}" stroke-opacity=".5" stroke-width=".5"`}/>`;
    }).join("") : "";
    const segW = (140 - (total - 1) * 0.8) / total;
    const strip = Array.from({ length: total }, (_, i) => `<rect x="${n2(10 + i * (segW + 0.8))}" y="${i + 1 === cur ? 79.6 : 80.2}" width="${n2(segW)}" height="${i + 1 === cur ? 2.2 : 1.1}" rx=".55" fill="${i + 1 < cur ? g.hi : i + 1 === cur ? "#fff" : g.fg}" ${i + 1 > cur ? 'fill-opacity=".28"' : ""}/>`).join("");
    const head = n2(10 + (cur - 0.5) * (segW + 0.8) - 0.4);
    const deco = S.svg(`<defs>${glowDef(`${uid}g`, g.hi2, 0.5)}${glowDef(`${uid}h`, g.hi, 0.26)}${lineDef(`${uid}n`, "#ffffff", g.hi)}</defs><circle cx="30" cy="44" r="62" fill="url(#${uid}g)"/><circle cx="150" cy="86" r="50" fill="url(#${uid}h)"/><circle cx="48" cy="40" r="46" fill="none" stroke="${g.fg}" stroke-opacity=".1" stroke-width=".6"/><circle cx="48" cy="40" r="34" fill="none" stroke="${g.fg}" stroke-opacity=".12" stroke-width=".6"/><g class="a-in"><text x="${n2(9 + 2.2)}" y="${n2(14 + size * 0.74 + 2.2)}" font-size="${size}" font-weight="800" fill="none" stroke="${g.fg}" stroke-opacity=".4" stroke-width=".6" letter-spacing="-2">${label}</text><text x="9" y="${n2(14 + size * 0.74)}" font-size="${size}" font-weight="800" fill="url(#${uid}n)" letter-spacing="-2">${label}</text></g><line x1="86.5" y1="14" x2="86.5" y2="70" stroke="${g.fg}" stroke-opacity=".3" stroke-width=".4"/>${dots}${strip}<circle cx="${head}" cy="80.7" r="1.9" fill="#fff"/><circle cx="${head}" cy="80.7" r="3.4" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width=".4"/>`);
    const right = S.block({ x: 94, y: 14, w: 58, h: 46, mid: true, delay: 0.18 }, para(`${esc(T("CHAPTER", "챕터"))} ${num0} / ${esc(String(Math.round(b.total)))}`, { size: 2.1, weight: 800, ls: 0.16, color: g.hi, lines: 1 }) + para(esc(b.chapter), { size: sizeFor(b.chapter, [[14, 6.6], [26, 5.4], [40, 4.5], [999, 3.9]]), weight: 800, lines: 3, lh: 1.08, ls: -0.02, mt: 1 }));
    const foot = (b.series ? S.block({ x: 10, y: 84, w: 100, delay: 0.4 }, para(esc(b.series), { size: 2.05, weight: 700, lines: 1, ls: 0.08, op: 0.82, upper: true })) : "") + (b.time ? S.block({ x: 112, y: 84, w: 38, align: "right", delay: 0.4 }, para(esc(b.time), { size: 2.05, weight: 700, lines: 1, ls: 0.08, op: 0.82 })) : "");
    return scene(g, deco + right + foot, 155);
  },
  summary: b => `Chapter ${Math.round(b.number)} of ${Math.round(b.total)}: ${b.chapter}${b.series ? ` — ${b.series}` : ""}${b.time ? ` (${b.time})` : ""}`,
  css: baseCss("chapter_title"),
});

export const ASSETS: readonly AnyAsset[] = [processHero, iconBurst, gradientCover, badgeStamp, chapterTitle];
