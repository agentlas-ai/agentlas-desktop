import { z } from "zod";
import { esc } from "../../kit";
import { list, loose, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { GROUNDS, block, clamp, cq, deco, fit, figureParts, groundField, groundKey, groundOf, mark, shape, stage, stagger, still, trendOf, unitSpan, type Ground, type GroundId } from "./_stills";

/** Keyframe stills of motion graphics, the broadcast set: a lower third, a versus card, a before/after split, a ticker tape. Each is a 16:9 frame with its type in cqw. */

const plain = z.preprocess(v => (typeof v === "string" ? Number(v.replace(/[,$%\s]/g, "").replace("−", "-")) : v), z.number().finite());

/* ------------------------------------------------------------------------------------------------------------------ lower_third */
/** The plate colours of a lower third per ground: the name plate, the title strip and the accent bar. */
const PLATE: Record<GroundId, { plate: string; fg: string; strip: string; sfg: string; bar: string }> = {
  ink: { plate: "#f4f6f5", fg: "#101d24", strip: "linear-gradient(90deg,#16303b,#27434f)", sfg: "#fff", bar: "#38d39f" },
  blue: { plate: "#ffffff", fg: "#101d24", strip: "linear-gradient(90deg,#1b43b0,#2f5fd6)", sfg: "#fff", bar: "#ffd166" },
  green: { plate: "#ffffff", fg: "#06281f", strip: "linear-gradient(90deg,#0a5f42,#118558)", sfg: "#fff", bar: "#ffe27a" },
  violet: { plate: "#ffffff", fg: "#1d0b46", strip: "linear-gradient(90deg,#5421b0,#7c3aed)", sfg: "#fff", bar: "#ffe08a" },
  sunset: { plate: "#ffffff", fg: "#2a0a10", strip: "linear-gradient(90deg,#b4231d,#e8591f)", sfg: "#fff", bar: "#ffc766" },
  paper: { plate: "#101d24", fg: "#ffffff", strip: "linear-gradient(90deg,#f4f0e5,#fcfaf4)", sfg: "#101d24", bar: "#2f5fd6" },
};
/** Buildings of the fake video backdrop: [x, width, height] on a 160 x 90 frame, far row then near row. */
const FAR = [[0, 16, 30], [14, 11, 38], [24, 14, 27], [36, 10, 42], [46, 15, 31], [60, 11, 36], [70, 14, 29], [83, 10, 40], [92, 15, 33], [106, 12, 38], [117, 14, 28], [130, 11, 41], [140, 20, 32]];
const NEAR = [[0, 14, 22], [13, 10, 30], [22, 13, 20], [34, 9, 34], [42, 14, 25], [55, 10, 19], [64, 13, 36], [76, 11, 24], [86, 14, 31], [99, 10, 21], [108, 13, 29], [120, 12, 23], [131, 17, 34], [147, 13, 26]];
const LIVE_RED = "#ff4d5e";
export const lowerThird = defineAsset({
  type: "lower_third", category: "motion", width: "half", frame: "16:9",
  use: "A broadcast lower third: a name and a title line on a sliding colour plate over a dark video-like backdrop, with a channel tag.",
  useKo: "방송 자막(로어서드): 어두운 영상 배경 위로 이름과 직함이 색 판에 실려 들어오는 장면, 채널 태그 포함.",
  tags: ["lower third", "name plate", "caption", "broadcast", "speaker", "interview", "motion", "로어서드", "자막", "이름표", "방송", "인터뷰"],
  notes: "name at most 36 characters, role at most 60 (a job title or a place); channel is the small tag in the corner and live adds a LIVE mark. ground colours the plate and the bar.",
  fields: { name: text(36), role: text(60), channel: optionalText(24), live: z.boolean().optional(), ground: groundField("blue") },
  sample: { name: "Dr. Amara Okafor", role: "Marine biologist, Scripps Institution", channel: "Agentlas News", live: true, ground: "blue" },
  render(b, { uid }) {
    const key = groundKey(b.ground, "blue"), g = GROUNDS[key], p = PLATE[key], ink = GROUNDS.ink;
    const windows = NEAR.map(([x, w, h], i) => Array.from({ length: Math.max(1, Math.floor(w / 4)) * 2 }, (_, k) => ((i * 7 + k * 5) % 4 === 0 ? `<rect x="${(x + 1.8 + (k % Math.max(1, Math.floor(w / 4))) * 3.4).toFixed(1)}" y="${(90 - h + 3 + Math.floor(k / Math.max(1, Math.floor(w / 4))) * 4.6).toFixed(1)}" width="1.3" height="1.8" fill="#ffd98a" fill-opacity=".55"/>` : "")).join("")).join("");
    const art = `<defs><linearGradient id="${uid}k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2f44"/><stop offset=".6" stop-color="#101f2d"/><stop offset="1" stop-color="#091019"/></linearGradient><radialGradient id="${uid}w" cx=".72" cy=".52" r=".5"><stop offset="0" stop-color="${g.b}" stop-opacity=".38"/><stop offset="1" stop-color="${g.b}" stop-opacity="0"/></radialGradient><linearGradient id="${uid}d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".78"/></linearGradient></defs><rect width="160" height="90" fill="url(#${uid}k)"/><rect width="160" height="90" fill="url(#${uid}w)"/><circle cx="118" cy="30" r="7" fill="#fff" fill-opacity=".1"/><circle cx="132" cy="22" r="4" fill="${g.b}" fill-opacity=".16"/><circle cx="104" cy="44" r="3" fill="#fff" fill-opacity=".12"/><circle cx="144" cy="40" r="9" fill="#fff" fill-opacity=".06"/><circle cx="92" cy="26" r="2.2" fill="#fff" fill-opacity=".14"/>${FAR.map(([x, w, h]) => `<rect x="${x}" y="${90 - h - 14}" width="${w}" height="${h + 14}" fill="#0e1a27"/>`).join("")}${NEAR.map(([x, w, h]) => `<rect x="${x}" y="${90 - h}" width="${w}" height="${h}" fill="#070e15"/>`).join("")}${windows}<rect y="30" width="160" height="60" fill="url(#${uid}d)"/><path d="M6 12V6h6M148 6h6v6M154 78v6h-6M12 84H6v-6" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width=".4"/>`;
    const nameSize = fit(b.name, 66, 6.4, 2.4, -0.01), roleSize = fit(b.role, 66, 3.3, 1.8, 0, 1.02);
    const tag = b.channel || b.live ? `<div class="a-in" style="${stagger(4)};position:absolute;top:5cqw;right:5cqw;max-width:56cqw;display:flex;align-items:center;gap:1.4cqw;padding:.9cqw 2cqw;border-radius:.8cqw;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.42);color:#fff;font-size:2cqw;font-weight:800;line-height:1.2;letter-spacing:.14em;text-transform:uppercase">${b.live ? `<span style="display:flex;align-items:center;gap:.9cqw;flex:none"><i style="width:1.5cqw;height:1.5cqw;border-radius:50%;background:${LIVE_RED};box-shadow:0 0 1.6cqw ${LIVE_RED}"></i>Live</span>` : ""}${b.live && b.channel ? `<i style="width:1px;height:2.2cqw;background:rgba(255,255,255,.3)"></i>` : ""}${b.channel ? `<span style="${clamp(1)}">${esc(b.channel)}</span>` : ""}</div>` : "";
    return `<div class="a-s" ${stage(ink, "", "#0a1320")}>${deco(art)}${tag}<div class="a-pl" style="position:absolute;left:6cqw;bottom:9cqw;display:flex;align-items:stretch;max-width:88cqw"><i style="flex:none;width:1.5cqw;background:${p.bar}"></i><div style="display:flex;flex-direction:column;align-items:flex-start;min-width:0"><div style="max-width:100%;padding:1.5cqw 3.2cqw 1.3cqw 2.4cqw;background:${p.plate};color:${p.fg};font-size:${cq(nameSize)};font-weight:800;line-height:1.1;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(b.name)}</div><div style="max-width:100%;padding:.9cqw 3.2cqw .9cqw 2.4cqw;background:${p.strip};color:${p.sfg};font-size:${cq(roleSize)};font-weight:600;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(b.role)}</div></div></div></div>`;
  },
  summary: b => `${b.name}, ${b.role}${b.channel ? ` (${b.channel}${b.live ? ", live" : ""})` : b.live ? " (live)" : ""}`,
  css: still("lower_third", ".a-pl{animation:a-lower_third-w .85s cubic-bezier(.2,.8,.2,1) .12s both}", "@keyframes a-lower_third-w{from{opacity:0;transform:translateX(-9cqw)}}"),
});

/* ------------------------------------------------------------------------------------------------------------------ versus_card */
const side = z.object({ name: text(22), figure: text(8), caption: optionalText(32) }).strip();
/** The two colour worlds of a versus card for each ground: [left, right]. */
const PAIR: Record<GroundId, [GroundId, GroundId]> = { ink: ["ink", "blue"], blue: ["blue", "sunset"], green: ["green", "violet"], violet: ["violet", "sunset"], sunset: ["sunset", "ink"], paper: ["paper", "ink"] };
export const versusCard = defineAsset({
  type: "versus_card", category: "motion", width: "half", frame: "16:9",
  use: "A head-to-head card: two coloured halves, a name and one headline number each, and a VS badge in the middle.",
  useKo: "맞대결 카드: 두 색 반쪽에 각각 이름과 대표 숫자 하나, 가운데 VS 배지.",
  tags: ["versus", "vs", "comparison", "head to head", "a vs b", "matchup", "motion", "대결", "비교", "맞대결", "대"],
  notes: "a and b each hold name (22), figure (8, shown as written) and an optional caption; topic names what the numbers measure. ground picks the pair of colours (ink: ink and blue, blue: blue and sunset, green: green and violet ...).",
  fields: { a: side, b: side, topic: optionalText(40), ground: groundField("blue") },
  sample: { a: { name: "Plan A", figure: "4.2s", caption: "Median load time" }, b: { name: "Plan B", figure: "1.1s", caption: "Median load time" }, topic: "Page speed, mobile, p50", ground: "blue" },
  render(b, { uid }) {
    const [lk, rk] = PAIR[groundKey(b.ground, "blue")], gl = GROUNDS[lk], gr = GROUNDS[rk];
    const grad = (id: string, g: Ground) => `<linearGradient id="${uid}${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g.bg[0]}"/><stop offset=".6" stop-color="${g.bg[1]}"/><stop offset="1" stop-color="${g.bg[2]}"/></linearGradient>`;
    const sl = shape(gl), sr = shape(gr);
    const art = `<defs>${grad("l", gl)}${grad("r", gr)}</defs><polygon points="0,0 86,0 74,90 0,90" fill="url(#${uid}l)"/><polygon points="86,0 160,0 160,90 74,90" fill="url(#${uid}r)"/><circle cx="12" cy="86" r="34" fill="${sl.hex}" fill-opacity=".07"/><circle cx="12" cy="86" r="22" fill="none" stroke="${sl.hex}" stroke-opacity=".16" stroke-width=".5"/><circle cx="150" cy="6" r="36" fill="${sr.hex}" fill-opacity=".08"/><circle cx="150" cy="6" r="24" fill="none" stroke="${sr.hex}" stroke-opacity=".18" stroke-width=".5"/><polygon points="85.2,0 87,0 75.2,90 73.4,90" fill="#fff" fill-opacity=".85"/>`;
    const half = (x: z.output<typeof side>, g: Ground, left: number, i: number) => {
      const p = figureParts(x.figure), size = fit(x.figure, 33, 15, 2.4, -0.03);
      return `<div class="a-in" style="${stagger(i + 1, 0.1, 0.16)};position:absolute;top:0;bottom:0;left:${left}cqw;width:37cqw;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:${g.fg};--mu:${g.mu};--a:${g.a}"><div style="max-width:100%;font-size:2.7cqw;font-weight:800;line-height:1.2;letter-spacing:.12em;text-transform:uppercase;${clamp(2)}">${esc(x.name)}</div><i style="display:block;width:5cqw;height:.7cqw;margin:1.6cqw 0 1.8cqw;border-radius:1cqw;background:${g.a}"></i><div style="max-width:100%;font-size:${cq(size)};font-weight:800;line-height:.95;letter-spacing:-.035em;white-space:nowrap">${unitSpan(p.pre)}${esc(p.num)}${unitSpan(p.post)}</div>${x.caption ? `<div style="max-width:100%;margin-top:1.8cqw;font-size:2.4cqw;line-height:1.3;color:${g.mu};${clamp(2)}">${esc(x.caption)}</div>` : ""}</div>`;
    };
    const badge = `<div class="a-in" style="${stagger(0, 0.5)};position:absolute;left:50%;top:50%;width:13cqw;height:13cqw;margin:-6.5cqw 0 0 -6.5cqw;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#fff;color:#101d24;box-shadow:0 0 0 1.3cqw rgba(255,255,255,.28),0 1.6cqw 3.4cqw rgba(0,0,0,.3);font-size:4.6cqw;font-weight:900;font-style:italic;letter-spacing:-.04em">VS</div>`;
    const topic = b.topic ? `<div style="position:absolute;left:0;right:0;bottom:4cqw;display:flex;justify-content:center"><div class="a-in" style="${stagger(4, 0.1)};max-width:60cqw;padding:.9cqw 2.6cqw;border-radius:9cqw;background:rgba(0,0,0,.3);color:#fff;font-size:2.2cqw;font-weight:650;${clamp(1)}">${esc(b.topic)}</div></div>` : "";
    return `<div class="a-s" ${stage(GROUNDS.ink)}>${deco(art)}${half(b.a, gl, 5.5, 0)}${half(b.b, gr, 57.5, 1)}${badge}${topic}</div>`;
  },
  summary: b => `${b.a.name} ${b.a.figure} versus ${b.b.name} ${b.b.figure}${b.topic ? ` (${b.topic})` : ""}`,
  css: still("versus_card"),
});

/* ------------------------------------------------------------------------------------------------------------------ before_after_split */
const panel = z.object({ figure: text(8), label: optionalText(28), values: list(plain, 2, 8) }).strip();
const STONE: Ground = { bg: ["#232d33", "#37444c", "#53626c"], fg: "#fff", mu: "rgba(255,255,255,.62)", ln: "rgba(255,255,255,.2)", a: "#d9e0dd", on: "#101d24", b: "#9aa8b0", up: "#3ddc97", dn: "#ff7a85", dark: true };
export const beforeAfterSplit = defineAsset({
  type: "before_after_split", category: "motion", width: "half", frame: "16:9",
  use: "A before and after frame split down the middle: a headline figure and a small bar or line picture on each side, a change badge on the divider.",
  useKo: "가운데를 가른 전/후 장면: 양쪽에 대표 숫자와 작은 막대·선 그림, 경계선 위에 증감 배지.",
  tags: ["before after", "split", "comparison", "improvement", "result", "transformation", "motion", "전후", "비교", "개선", "결과"],
  notes: "before and after each hold figure (8, as written), an optional label and 2-8 values for the small picture (both drawn on one scale). delta is the badge text (-62%); good false colours it red. visual is bars or line.",
  fields: { visual: loose(["bars", "line"], { bar: "bars", column: "bars", columns: "bars", trend: "line", lines: "line", area: "line" }, "bars").optional(), before: panel, after: panel, delta: text(12), good: z.boolean().optional(), ground: groundField("green") },
  sample: { visual: "bars", before: { figure: "4.2 s", label: "Checkout time", values: [4.6, 4.4, 4.3, 4.5, 4.2, 4.2] }, after: { figure: "1.6 s", label: "Checkout time", values: [4.2, 3.1, 2.4, 2.0, 1.8, 1.6] }, delta: "−62%", good: true, ground: "green" },
  render(b, { uid, T }) {
    const g = groundOf(b.ground, "green"), sa = shape(g), line = b.visual === "line", dir = trendOf(undefined, b.delta), badgeColor = b.good === false ? "#cf3545" : "#18b67e";
    const all = [...b.before.values, ...b.after.values], lo = Math.min(0, ...all), hi = Math.max(...all, lo + 1), Y = (v: number) => 31 - ((v - lo) / (hi - lo)) * 27;
    const mini = (vals: number[], base: string, hot: string, area: string) => {
      const n = vals.length, X = (i: number) => (n === 1 ? 50 : 4 + (i * 92) / (n - 1));
      const Z = Y(0);
      if (!line) { const bw = Math.min(10, (92 / n) * 0.62), step = 92 / n; return `<path d="M2 ${Z.toFixed(1)}H98" stroke="${base}" stroke-width=".5"/>${vals.map((v, i) => { const x = 4 + i * step + (step - bw) / 2, y = Math.min(Z, Y(v)), h = Math.max(1.2, Math.abs(Z - Y(v))); return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.3" fill="${i === n - 1 ? hot : base}" fill-opacity="${i === n - 1 ? 1 : 0.55}"/>`; }).join("")}`; }
      const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
      return `<path d="M2 ${Z.toFixed(1)}H98" stroke="${base}" stroke-width=".5"/><path d="${d}L${X(n - 1).toFixed(1)},${Z.toFixed(1)}L${X(0).toFixed(1)},${Z.toFixed(1)}Z" fill="${area}" fill-opacity=".2"/><path d="${d}" fill="none" stroke="${hot}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${X(n - 1).toFixed(1)}" cy="${Y(vals[n - 1]).toFixed(1)}" r="2.6" fill="${hot}" stroke="${area}" stroke-opacity=".35" stroke-width="2.4"/>`;
    };
    const art = `<defs><linearGradient id="${uid}l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${STONE.bg[0]}"/><stop offset=".6" stop-color="${STONE.bg[1]}"/><stop offset="1" stop-color="${STONE.bg[2]}"/></linearGradient><linearGradient id="${uid}r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g.bg[0]}"/><stop offset=".55" stop-color="${g.bg[1]}"/><stop offset="1" stop-color="${g.bg[2]}"/></linearGradient></defs><rect width="80" height="90" fill="url(#${uid}l)"/><rect x="80" width="80" height="90" fill="url(#${uid}r)"/><circle cx="6" cy="94" r="38" fill="#fff" fill-opacity=".05"/><circle cx="154" cy="-2" r="40" fill="${sa.hex}" fill-opacity=".08"/><circle cx="154" cy="-2" r="26" fill="none" stroke="${sa.hex}" stroke-opacity=".2" stroke-width=".5"/><path d="M80 0V90" stroke="#fff" stroke-opacity=".7" stroke-width=".6"/>`;
    const col = (p: z.output<typeof panel>, tag: string, g2: Ground, side: "l" | "r", i: number) => {
      const parts = figureParts(p.figure), size = fit(p.figure, 31, 11, 2.4, -0.03);
      const base = side === "l" ? "#ffffff" : shape(g2).hex, hot = side === "l" ? "#e4eae7" : g2.a, area = side === "l" ? "#ffffff" : g2.a;
      return `<div class="a-in" style="${stagger(i, 0.12, 0.18)};position:absolute;top:0;bottom:0;${side === "l" ? "left:0;padding:6cqw 14cqw 6cqw 5cqw" : "left:50%;padding:6cqw 5cqw 6cqw 14cqw"};width:50%;display:flex;flex-direction:column;justify-content:space-between;color:${g2.fg};--mu:${g2.mu};--a:${g2.a}"><div style="font-size:2.1cqw;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:${g2.mu}">${esc(tag)}</div><div><div style="font-size:${cq(size)};font-weight:800;line-height:.95;letter-spacing:-.035em;white-space:nowrap">${unitSpan(parts.pre)}${esc(parts.num)}${unitSpan(parts.post)}</div>${p.label ? `<div style="margin-top:1.2cqw;font-size:2.5cqw;line-height:1.25;color:${g2.mu};${clamp(2)}">${esc(p.label)}</div>` : ""}</div><svg viewBox="0 0 100 34" style="width:100%;height:auto" aria-hidden="true">${mini(p.values, base, hot, area)}</svg></div>`;
    };
    const dsize = fit(b.delta, 20, 5, 2.6, -0.01, 1.1);
    const badge = `<div class="a-in" style="${stagger(3, 0.1, 0.18)};position:absolute;left:50%;top:50%;margin:-4.2cqw 0 0;display:flex;align-items:center;justify-content:center;width:0"><div style="flex:none;display:flex;align-items:center;gap:1.1cqw;max-width:25cqw;padding:1.3cqw 2.6cqw;border-radius:9cqw;background:${badgeColor};border:.6cqw solid #fff;box-shadow:0 1.4cqw 3cqw rgba(0,0,0,.3);color:#fff;font-size:${cq(dsize)};font-weight:800;line-height:1.05;white-space:nowrap">${mark(dir, "#fff")}${esc(b.delta)}</div></div>`;
    return `<div class="a-s" ${stage(g)}>${deco(art)}${col(b.before, T("Before", "이전"), STONE, "l", 0)}${col(b.after, T("After", "이후"), g, "r", 1)}${badge}</div>`;
  },
  summary: b => `Before ${b.before.figure}${b.before.label ? ` (${b.before.label})` : ""}, after ${b.after.figure}${b.after.label ? ` (${b.after.label})` : ""}: ${b.delta}`,
  css: still("before_after_split"),
});

/* ------------------------------------------------------------------------------------------------------------------ ticker_tape */
const tick = z.object({ symbol: text(8), value: text(9), change: text(8) }).strip();
export const tickerTape = defineAsset({
  type: "ticker_tape", category: "motion", width: "half", frame: "16:9",
  use: "A market or news ticker poster: a headline above a tilted tape of four to eight items (symbol, value, coloured change) running off the frame edge.",
  useKo: "시세·뉴스 티커 포스터: 헤드라인 아래 기울어진 띠에 항목 4~8개(종목, 값, 색 등락)가 프레임 밖으로 흘러가는 장면.",
  tags: ["ticker", "tape", "market", "stocks", "news ticker", "prices", "headline", "motion", "티커", "시세", "증시", "뉴스"],
  notes: "items are 4-8 entries of symbol (8), value (9) and change (8, signed: +1.2% or -0.8%); the sign sets the colour. Items past the frame edge are cut, so put the ones that matter first. kicker is a short tag above the headline.",
  fields: { headline: text(60), kicker: optionalText(24), items: list(tick, 4, 8), ground: groundField("ink") },
  sample: { headline: "Stocks close at a record as chipmakers lead", kicker: "Markets · Close", items: [{ symbol: "S&P 500", value: "5,842", change: "+0.8%" }, { symbol: "NASDAQ", value: "18,910", change: "+1.3%" }, { symbol: "DOW", value: "43,120", change: "-0.2%" }, { symbol: "NVDA", value: "$148.2", change: "+3.4%" }, { symbol: "BTC", value: "$71.4K", change: "-1.1%" }, { symbol: "EUR/USD", value: "1.083", change: "0.0%" }], ground: "ink" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "ink"), s = shape(g), ink = GROUNDS.ink, n = b.items.length, w = Math.max(14.5, Math.min(23, 94 / n)), hsize = block(b.headline, 80, 15, 6.4, 3.2, 1.08, -0.02, 1.06);
    const art = `<defs><radialGradient id="${uid}r" cx=".85" cy=".1" r=".6"><stop offset="0" stop-color="${g.b}" stop-opacity="${g.dark ? 0.4 : 0.16}"/><stop offset="1" stop-color="${g.b}" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#${uid}r)"/><circle cx="148" cy="8" r="30" fill="${s.hex}" fill-opacity=".06"/><circle cx="148" cy="8" r="44" fill="none" stroke="${s.hex}" stroke-opacity=".14" stroke-width=".5"/>`;
    const cell = (it: z.output<typeof tick>, i: number) => {
      const t = trendOf(undefined, it.change), color = t === "up" ? ink.up : t === "down" ? ink.dn : "rgba(255,255,255,.6)", vs = fit(it.value, w - 3.4, 5.6, 2.2, -0.03);
      return `<div style="flex:none;width:${cq(w)};padding:0 1.6cqw 0 2cqw;border-left:${i ? "1px solid rgba(255,255,255,.16)" : "0"};display:flex;flex-direction:column;justify-content:center;gap:.6cqw;overflow:hidden"><div style="font-size:2.3cqw;font-weight:800;letter-spacing:.08em;color:rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.symbol)}</div><div style="font-size:${cq(vs)};font-weight:800;line-height:1;letter-spacing:-.03em;color:#fff;white-space:nowrap;overflow:hidden">${esc(it.value)}</div><div style="display:flex;align-items:center;gap:.9cqw;font-size:2.5cqw;font-weight:800;color:${color};white-space:nowrap;overflow:hidden">${mark(t, color)}${esc(it.change)}</div></div>`;
    };
    const ghost = (b.kicker ?? b.items.map(it => it.symbol).join(" · ")).toUpperCase(), ghostRun = Array.from({ length: 6 }, () => esc(ghost)).join(`<span style="margin:0 2.2cqw">◆</span>`);
    return `<div class="a-s" ${stage(g)}>${deco(art)}<div style="position:absolute;left:7cqw;top:5.5cqw;width:80cqw">${b.kicker ? `<div class="a-in" style="${stagger(0, 0.04)};margin-bottom:1.6cqw;font-size:2.2cqw;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:var(--a);${clamp(1)}">${esc(b.kicker)}</div>` : ""}<div class="a-in" style="${stagger(1)};font-size:${cq(hsize)};font-weight:800;line-height:1.08;letter-spacing:-.02em;${clamp(2)}">${esc(b.headline)}</div></div><div class="a-in" style="${stagger(2, 0.2)};position:absolute;left:-12cqw;width:130cqw;top:${b.kicker ? 27.5 : 25.5}cqw;transform:rotate(-4deg)"><div style="display:flex;height:19cqw;padding-left:16cqw;background:${g.dark ? "rgba(4,12,16,.6)" : "#101d24"};border-top:1px solid rgba(255,255,255,.22);border-bottom:1px solid rgba(255,255,255,.22)">${b.items.map(cell).join("")}</div><div style="margin-top:1.4cqw;height:5.6cqw;display:flex;align-items:center;white-space:nowrap;overflow:hidden;background:var(--a);color:var(--on);font-size:2.2cqw;font-weight:800;letter-spacing:.16em"><span style="margin-left:6cqw">${ghostRun}</span></div></div></div>`;
  },
  summary: b => `${b.headline}: ${b.items.map(it => `${it.symbol} ${it.value} (${it.change})`).join("; ")}`,
  css: still("ticker_tape"),
});

export const ASSETS: readonly AnyAsset[] = [lowerThird, versusCard, beforeAfterSplit, tickerTape];
