import { z } from "zod";
import { canvasFormat, esc } from "../../kit";
import { list, num, optionalNum, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { baseCss, clamp, dly, em, fitSize, fitText, glowDef, groundField, groundOf, hash, lineDef, n2, para, scene, sizeFor, stage } from "./_b";

/** Freeze-frames of a data story: a glowing timeline rail, a bar-chart race, a pulsing dot-matrix map. Frame 16:9, type in cqw. */

// ---------- 8. timeline_rail_hero ----------
const railNode = z.object({ date: text(12), label: text(24), note: optionalText(80) }).strip();
export const timelineRailHero = defineAsset({
  type: "timeline_rail_hero", category: "motion", width: "half", frame: "16:9",
  use: "A poster-like still of a horizontal glowing timeline with four to six dated nodes, the current one enlarged with a callout, and a headline: roadmaps, histories, project phases.",
  useKo: "날짜 달린 노드 4~6개가 놓인 빛나는 가로 타임라인 정지 화면: 현재 노드는 크게, 말풍선과 함께. 로드맵·연혁·프로젝트 단계.",
  tags: ["timeline", "roadmap", "milestones", "history", "rail", "phases", "타임라인", "로드맵", "연혁", "일정"],
  notes: "4-6 nodes in time order, each with a short date (12 characters), a label (24) and an optional note (80). current is the 1-based number of the node to enlarge (default 1).",
  fields: { headline: text(60), kicker: optionalText(28), nodes: list(railNode, 4, 6), current: optionalNum, ground: groundField("ink") },
  sample: { kicker: "ROADMAP 2026", headline: "Our road to general availability", nodes: [{ date: "Jan", label: "Private alpha", note: "Fifty teams test the first build." }, { date: "Mar", label: "Public beta", note: "Open sign-up, weekly releases." }, { date: "Jun", label: "Mobile apps", note: "iOS and Android ship together, built on the same engine." }, { date: "Sep", label: "Teams launch", note: "Shared workspaces and roles." }, { date: "Nov", label: "General availability", note: "Every plan, every region." }], current: 3, ground: "ink" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "ink"), S = stage(160, 90), n = b.nodes.length, cur = clamp(Math.round(b.current ?? 1), 1, n) - 1;
    const x0 = 18, x1 = 142, sp = (x1 - x0) / (n - 1), X = (i: number) => x0 + i * sp, RY = 64, cx = X(cur);
    const dateSize = n <= 4 ? 2.2 : 2, labSize = n <= 4 ? 3 : n === 5 ? 2.6 : 2.3;
    const nodes = b.nodes.map((nd, i) => {
      const x = X(i), delay = dly(i, 0.1, 0.08);
      if (i === cur) return `<g class="a-in" style="animation-delay:${delay}s"><circle cx="${n2(x)}" cy="${RY}" r="12.4" fill="${g.hi}" fill-opacity=".1"/><circle cx="${n2(x)}" cy="${RY}" r="8.8" fill="${g.hi}" fill-opacity=".2"/><circle cx="${n2(x)}" cy="${RY}" r="6.4" fill="url(#${uid}n)"/><circle cx="${n2(x)}" cy="${RY}" r="2.4" fill="#fff"/></g>`;
      if (i < cur) return `<g class="a-in" style="animation-delay:${delay}s"><circle cx="${n2(x)}" cy="${RY}" r="4.4" fill="${g.hi}" fill-opacity=".2"/><circle cx="${n2(x)}" cy="${RY}" r="2.5" fill="${g.hi}"/></g>`;
      return `<g class="a-in" style="animation-delay:${delay}s"><circle cx="${n2(x)}" cy="${RY}" r="2.6" fill="${g.bg[1]}" stroke="${g.fg}" stroke-opacity=".6" stroke-width=".7"/></g>`;
    }).join("");
    const cn = b.nodes[cur], bw = n === 6 ? 50 : 58, bh = cn.note ? 24 : 14, bx = clamp(cx - bw / 2, 8, 152 - bw), by = RY - 12 - bh, tx = clamp(cx, bx + 6, bx + bw - 6);
    const bubble = `<g class="a-in" style="animation-delay:.5s"><line x1="${n2(cx)}" y1="${n2(by + bh + 3)}" x2="${n2(cx)}" y2="${RY - 7}" stroke="${g.hi}" stroke-opacity=".55" stroke-width=".5" stroke-dasharray="1 1.2" stroke-linecap="round"/><path d="M${n2(bx + 4)} ${n2(by)}H${n2(bx + bw - 4)}Q${n2(bx + bw)} ${n2(by)} ${n2(bx + bw)} ${n2(by + 4)}V${n2(by + bh - 4)}Q${n2(bx + bw)} ${n2(by + bh)} ${n2(bx + bw - 4)} ${n2(by + bh)}H${n2(tx + 2.6)}L${n2(tx)} ${n2(by + bh + 3.2)}L${n2(tx - 2.6)} ${n2(by + bh)}H${n2(bx + 4)}Q${n2(bx)} ${n2(by + bh)} ${n2(bx)} ${n2(by + bh - 4)}V${n2(by + 4)}Q${n2(bx)} ${n2(by)} ${n2(bx + 4)} ${n2(by)}Z" fill="${g.fg}" fill-opacity=".13" stroke="${g.hi}" stroke-opacity=".7" stroke-width=".45"/></g>`;
    const bubbleText = S.block({ x: bx + 3.4, y: by + 2.6, w: bw - 6.8, delay: 0.6 }, para(esc(cn.date), { size: 2.1, weight: 800, ls: 0.14, color: g.hi, lines: 1, upper: true }) + para(esc(cn.label), { size: 3.1, weight: 800, lines: 1, mt: 0.3 }) + (cn.note ? para(esc(cn.note), { size: 2.2, weight: 500, lines: 2, lh: 1.25, op: 0.85, mt: 0.5 }) : ""));
    const rail = `<line x1="8" y1="${RY}" x2="152" y2="${RY}" stroke="${g.fg}" stroke-opacity=".18" stroke-width="1.4" stroke-linecap="round"/><line x1="8" y1="${RY}" x2="${n2(cx)}" y2="${RY}" stroke="${g.hi}" stroke-opacity=".12" stroke-width="7" stroke-linecap="round"/><line x1="8" y1="${RY}" x2="${n2(cx)}" y2="${RY}" stroke="${g.hi}" stroke-opacity=".28" stroke-width="3.6" stroke-linecap="round"/><line x1="8" y1="${RY}" x2="${n2(cx)}" y2="${RY}" stroke="url(#${uid}l)" stroke-width="1.4" stroke-linecap="round"/>`;
    const deco = S.svg(`<defs>${glowDef(`${uid}a`, g.hi2, 0.5)}${glowDef(`${uid}b`, g.hi, 0.22)}${lineDef(`${uid}n`, g.grad[0], g.grad[1])}<linearGradient id="${uid}l" gradientUnits="userSpaceOnUse" x1="8" y1="0" x2="${n2(cx)}" y2="0"><stop offset="0" stop-color="${g.hi2}"/><stop offset="1" stop-color="${g.hi}"/></linearGradient></defs><circle cx="148" cy="4" r="62" fill="url(#${uid}a)"/><circle cx="${n2(cx)}" cy="${RY}" r="46" fill="url(#${uid}b)"/><circle cx="148" cy="12" r="30" fill="none" stroke="${g.fg}" stroke-opacity=".1" stroke-width=".6"/><circle cx="148" cy="12" r="18" fill="none" stroke="${g.fg}" stroke-opacity=".16" stroke-width=".6"/>${rail}${bubble}${nodes}`);
    const below = b.nodes.map((nd, i) => {
      const x = X(i), isCur = i === cur, past = i < cur;
      return S.block({ x: x - sp / 2 + 1, y: RY + 7, w: sp - 2, align: "center", delay: dly(i, 0.3, 0.08) }, (isCur ? "" : para(esc(nd.date), { size: dateSize, weight: 800, ls: 0.12, color: past ? g.hi : undefined, op: past ? 1 : 0.6, lines: 1, upper: true })) + para(esc(nd.label), { size: isCur ? labSize + 0.5 : labSize, weight: isCur ? 800 : 700, color: isCur ? g.hi : undefined, op: isCur || past ? 1 : 0.62, lines: 2, lh: 1.15, mt: isCur ? 0 : 0.5 }));
    }).join("");
    const head = S.block({ x: 10, y: 6, w: 112 }, (b.kicker ? para(esc(b.kicker), { size: 2.1, weight: 800, ls: 0.16, color: g.hi, lines: 1, upper: true }) : "") + para(esc(b.headline), { size: sizeFor(b.headline, [[24, 5.4], [40, 4.6], [999, 4]]), weight: 800, lines: 2, lh: 1.12, ls: -0.02, mt: b.kicker ? 0.8 : 0 }));
    return scene(g, deco + head + bubbleText + below, 150);
  },
  summary: b => `${b.headline}: ${b.nodes.map((nd, i) => `${nd.date} ${nd.label}${i === clamp(Math.round(b.current ?? 1), 1, b.nodes.length) - 1 ? " (now)" : ""}`).join(" → ")}.`,
  css: baseCss("timeline_rail_hero"),
});

// ---------- 9. bar_race_still ----------
const raceBar = z.object({ name: text(22), value: num }).strip();
export const barRaceStill = defineAsset({
  type: "bar_race_still", category: "motion", width: "half", frame: "16:9",
  use: "A freeze-frame of a bar-chart race: three to eight ranked horizontal bars with names and values, a big period watermark and colours that follow the name.",
  useKo: "막대 경주 차트의 정지 화면: 순위대로 정렬된 가로 막대 3~8개와 이름·값, 큰 기간 워터마크, 이름에 따라 정해지는 색.",
  tags: ["bar race", "ranking", "leaderboard", "top", "race", "year", "순위", "막대 경주", "랭킹", "리더보드"],
  notes: "bars are sorted by value, largest first; one colour per name (the same name keeps its colour in every frame). period is the watermark (a year, a quarter, a date).",
  fields: { headline: optionalText(60), kicker: optionalText(28), bars: list(raceBar, 3, 8), unit: unit.default("count"), period: text(10), ground: groundField("ink") },
  sample: { kicker: "STREAMING SUBSCRIBERS", headline: "Who led the market, quarter by quarter", bars: [{ name: "Streamly", value: 238 }, { name: "Cineo", value: 204 }, { name: "Playbox", value: 176 }, { name: "Orbit TV", value: 141 }, { name: "Nova+", value: 118 }, { name: "Kinema", value: 97 }, { name: "Loop", value: 64 }], unit: "count", period: "2026 Q3", ground: "ink" },
  render(b, { uid, ko }) {
    const g = groundOf(b.ground, "ink"), S = stage(160, 90), bars = [...b.bars].sort((p, q) => q.value - p.value), n = bars.length;
    const top = Math.max(...bars.map(r => r.value), 1e-9), floor = Math.min(0, ...bars.map(r => r.value)), span = top - floor || 1;
    const used = new Set<number>(), hue = new Map<string, string>();
    [...bars].sort((p, q) => p.name.localeCompare(q.name)).forEach(r => { let h = hash(r.name.toLowerCase()) % g.hues.length; for (let k = 0; k < g.hues.length && used.has(h); k++) h = (h + 1) % g.hues.length; used.add(h); hue.set(r.name, g.hues[h]); });
    const y0 = b.headline || b.kicker ? 27 : 12, pitch = Math.min(11, (84 - y0) / n), bh = pitch * 0.66, bx = 48, maxL = 78;
    const pw = fitSize(b.period, 100, 38, 12, 800);
    const grid = [0, 0.25, 0.5, 0.75, 1].map(f => `<line x1="${n2(bx + f * maxL)}" y1="${n2(y0 - 1)}" x2="${n2(bx + f * maxL)}" y2="${n2(y0 + n * pitch)}" stroke="${g.fg}" stroke-opacity="${f === 0 ? 0.35 : 0.1}" stroke-width=".3" ${f === 0 ? "" : 'stroke-dasharray="1 1.6"'}/>`).join("");
    const rows = bars.map((r, i) => {
      const y = y0 + i * pitch + (pitch - bh) / 2, len = Math.max(bh, ((r.value - floor) / span) * maxL), c = hue.get(r.name)!, label = canvasFormat(r.value, b.unit, ko), lw = em(label, 800) * 3.5, inside = len > maxL - lw - 4;
      return `<g><rect class="a-gr" style="animation-delay:${dly(i, 0.1, 0.07)}s" x="${bx}" y="${n2(y)}" width="${n2(len)}" height="${n2(bh)}" rx="${n2(bh / 2)}" fill="${c}"/>${i === 0 ? `<rect x="${bx}" y="${n2(y - 1)}" width="${n2(len)}" height="${n2(bh + 2)}" rx="${n2(bh / 2 + 1)}" fill="${c}" fill-opacity=".22"/>` : ""}<g class="a-in" style="animation-delay:${dly(i, 0.3, 0.07)}s"><text x="${bx - 3.4}" y="${n2(y + bh / 2)}" dy=".36em" text-anchor="end" font-size="3.5" font-weight="${i === 0 ? 800 : 600}" fill="${g.fg}" fill-opacity="${i === 0 ? 1 : 0.85}">${esc(fitText(r.name, 36, 3.5, i === 0 ? 800 : 600))}</text><text x="${n2(inside ? bx + len - 2.6 : bx + len + 2.6)}" y="${n2(y + bh / 2)}" dy=".36em" text-anchor="${inside ? "end" : "start"}" font-size="3.5" font-weight="800" fill="${inside ? g.on : g.fg}" ${inside && c === "#ffffff" ? "" : ""}>${esc(label)}</text></g></g>`;
    }).join("");
    const deco = S.svg(`<defs>${glowDef(`${uid}a`, g.hi2, 0.4)}${glowDef(`${uid}b`, g.hi, 0.22)}</defs><circle cx="150" cy="86" r="70" fill="url(#${uid}a)"/><circle cx="6" cy="2" r="50" fill="url(#${uid}b)"/><text x="153" y="${n2(88 - pw * 0.16)}" text-anchor="end" font-size="${n2(pw)}" font-weight="800" letter-spacing="-1" fill="${g.fg}" fill-opacity=".11">${esc(b.period)}</text>${grid}${rows}`);
    const head = b.headline || b.kicker ? S.block({ x: 10, y: 6, w: 128 }, (b.kicker ? para(esc(b.kicker), { size: 2.1, weight: 800, ls: 0.16, color: g.hi, lines: 1, upper: true }) : "") + (b.headline ? para(esc(b.headline), { size: sizeFor(b.headline, [[30, 4.8], [46, 4], [999, 3.4]]), weight: 800, lines: 1, lh: 1.15, ls: -0.015, mt: b.kicker ? 0.8 : 0 }) : "")) : "";
    return scene(g, deco + head, 150);
  },
  summary: b => `${b.headline ?? "Ranking"} (${b.period}): ${[...b.bars].sort((p, q) => q.value - p.value).map((r, i) => `${i + 1}. ${r.name} ${canvasFormat(r.value, b.unit, false)}`).join(", ")}.`,
  css: baseCss("bar_race_still", ".fpc .a-bar_race_still .a-gr{transform-origin:left center;animation:a-bar_race_still-g .9s cubic-bezier(.2,.8,.2,1) both;transform-box:fill-box}@keyframes a-bar_race_still-g{from{transform:scaleX(0)}}"),
});

// ---------- 10. map_pulse ----------
/** Continent-like clusters as ellipses [lon, lat, rx, ry] in degrees: a deterministic, data-free base for the dot matrix. */
const LAND: readonly (readonly [number, number, number, number])[] = [
  [-100, 54, 32, 15], [-98, 38, 26, 12], [-152, 63, 14, 8], [-102, 24, 12, 8], [-92, 16, 8, 5], [-80, 9, 6, 3.5], [-77, 21, 5, 2], [-90, 73, 20, 5], [-42, 73, 14, 11], [-19, 65, 3.5, 2],
  [-62, 0, 16, 12], [-55, -14, 18, 12], [-64, -32, 11, 14], [-70, -48, 5, 8], [-76, -4, 5, 12],
  [10, 48, 20, 9], [15, 63, 8, 8], [26, 64, 6, 6], [-4, 40, 8, 5], [14, 42, 4, 6], [-2, 54, 4, 5], [-8, 53, 2, 2.5], [30, 52, 10, 6], [38, 56, 8, 6],
  [10, 24, 26, 12], [14, 6, 28, 10], [24, -8, 14, 14], [26, -26, 11, 9], [42, 8, 8, 8], [47, -19, 2.5, 6], [-6, 32, 7, 5], [30, 28, 10, 7],
  [75, 58, 38, 14], [130, 62, 34, 10], [90, 40, 30, 12], [110, 32, 14, 10], [78, 22, 10, 10], [46, 26, 12, 9], [100, 14, 6, 14], [127, 38, 4, 7], [138, 37, 3.5, 7], [142, 44, 3, 3], [121, 24, 2, 3], [37, 40, 10, 4],
  [102, -2, 6, 3], [113, 0, 6, 6], [110, -7, 6, 1.6], [121, -2, 3, 4.5], [138, -5, 8, 3.2], [122, 13, 3, 6],
  [134, -25, 18, 11], [147, -33, 7, 8], [172, -41, 3, 6], [175, -37, 2, 3],
];
/** Inland seas and gulfs cut out of the land: [lon, lat, rx, ry]. */
const SEAS: readonly (readonly [number, number, number, number])[] = [[18, 35.4, 17, 2.6], [34, 43.2, 5.5, 2.4], [51, 42, 2.6, 4.6], [-90, 24.6, 7, 3.6], [-85, 60, 7, 5], [20, 58.4, 3, 3.6], [38.5, 20, 1.7, 6.5], [51.5, 27, 3.2, 1.8], [135, 40.5, 3.6, 5], [88, 13, 5, 4], [-5, 37, 3, 1.2]];
const mapPoint = z.object({ name: text(18), value: text(14), lat: num, lon: num }).strip();
export const mapPulse = defineAsset({
  type: "map_pulse", category: "motion", width: "half", frame: "16:9",
  use: "A still of an abstract dot-matrix world map with three to six pulsing location markers, each with a name and a value, and a headline: where users, sales or events are.",
  useKo: "점으로 그린 추상 세계 지도 위에 이름과 값이 붙은 맥박 표시 3~6개를 놓은 정지 화면과 제목: 사용자·매출·행사 위치.",
  tags: ["map", "world", "locations", "pulse", "regions", "dot matrix", "지도", "세계", "위치", "지역"],
  notes: "points are 3-6 places with lat and lon in degrees (negative south and west), a name (18 characters) and a value (14). The map is drawn from a fixed dot pattern, no data needed.",
  fields: { headline: text(60), kicker: optionalText(28), points: list(mapPoint, 3, 6), ground: groundField("blue") },
  sample: { kicker: "LIVE ACTIVITY", headline: "Teams are shipping on every continent", points: [{ name: "Seoul", value: "12.4K teams", lat: 37.57, lon: 126.98 }, { name: "London", value: "8.1K teams", lat: 51.5, lon: -0.12 }, { name: "New York", value: "15.9K teams", lat: 40.71, lon: -74.0 }, { name: "São Paulo", value: "4.6K teams", lat: -23.55, lon: -46.63 }, { name: "Singapore", value: "6.2K teams", lat: 1.35, lon: 103.82 }, { name: "Sydney", value: "3.3K teams", lat: -33.87, lon: 151.21 }], ground: "blue" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "blue"), S = stage(160, 90), MX = 10, MY = 29, K = 140 / 348, LON0 = -170, LAT0 = 78;
    const px = (lon: number) => MX + (clamp(lon, -170, 178) - LON0) * K, py = (lat: number) => MY + (LAT0 - clamp(lat, -56, 78)) * K;
    const tiers: string[][] = [[], [], []];
    const step = 2.7;
    for (let lat = LAT0; lat >= -56; lat -= step) for (let lon = LON0; lon <= 178; lon += step) {
      const wob = 0.2 * Math.sin(lon * 0.21 + lat * 0.13) + 0.14 * Math.sin(lon * 0.07 - lat * 0.31) + 0.08 * Math.sin(lon * 0.45 + lat * 0.4);
      if (!LAND.some(([cx, cy, rx, ry]) => ((lon - cx) / rx) ** 2 + ((lat - cy) / ry) ** 2 < 1 + wob) || SEAS.some(([cx, cy, rx, ry]) => ((lon - cx) / rx) ** 2 + ((lat - cy) / ry) ** 2 < 1)) continue;
      tiers[hash(`${Math.round(lon)}:${Math.round(lat)}`) % 3].push(`M${px(lon).toFixed(1)} ${py(lat).toFixed(1)}h0`);
    }
    const dots = tiers.map((t, i) => `<path d="${t.join("")}" fill="none" stroke="${g.fg}" stroke-opacity="${[0.38, 0.58, 0.82][i]}" stroke-width=".82" stroke-linecap="round"/>`).join("");
    // Pills: for each marker the position around it with the least overlap with the other markers, earlier pills and the frame's edge.
    const placed: [number, number, number, number][] = [], pts = b.points.map(p => ({ ...p, x: px(p.lon), y: py(p.lat) }));
    const hit = (ax: number, ay: number, aw: number, ah: number, q: readonly number[]) => Math.max(0, Math.min(ax + aw, q[0] + q[2]) - Math.max(ax, q[0])) * Math.max(0, Math.min(ay + ah, q[1] + q[3]) - Math.max(ay, q[1]));
    const marks = pts.map((p, i) => {
      const name = fitText(p.name, 22, 2.6, 700), val = fitText(p.value, 25, 3.7, 800), w = Math.max(em(name) * 2.6, em(val, 800) * 3.7) + 5.6, h = 9.4;
      const spots: [number, number][] = [[3.6, -2.6 - h], [-3.6 - w, -2.6 - h], [3.6, 2.6], [-3.6 - w, 2.6], [-w / 2, -3.4 - h], [-w / 2, 3.4], [4.4, -h / 2], [-4.4 - w, -h / 2]];
      let at = spots[0], best = Infinity;
      for (const sp of spots) {
        const rx = p.x + sp[0], ry = p.y + sp[1];
        let cost = (Math.max(0, 4 - rx) + Math.max(0, rx + w - 156) + Math.max(0, 27 - ry) + Math.max(0, ry + h - 87)) * 60;
        for (const q of placed) cost += hit(rx, ry, w, h, q) * 3;
        for (const o of pts) cost += hit(rx, ry, w, h, [o.x - 6.5, o.y - 6.5, 13, 13]) * 2;
        if (cost < best - 1e-9) { best = cost; at = sp; }
      }
      const rx = clamp(p.x + at[0], 4, 156 - w), ry = clamp(p.y + at[1], 27, 87 - h); placed.push([rx, ry, w, h]);
      return `<g class="a-in" style="animation-delay:${dly(i, 0.25, 0.12)}s"><circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="9" fill="url(#${uid}p)"/><circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="6.2" fill="none" stroke="${g.hi}" stroke-opacity=".3" stroke-width=".5"/><circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="4" fill="none" stroke="${g.hi}" stroke-opacity=".55" stroke-width=".55"/><circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="2.2" fill="${g.hi}"/><circle cx="${n2(p.x)}" cy="${n2(p.y)}" r=".9" fill="${g.on}"/><rect x="${n2(rx)}" y="${n2(ry)}" width="${n2(w)}" height="${h}" rx="2.8" fill="${g.bg[0]}" fill-opacity="${g.dark ? 0.82 : 0.92}" stroke="${g.hi}" stroke-opacity=".6" stroke-width=".35"/><text x="${n2(rx + 2.8)}" y="${n2(ry + 3)}" dy=".36em" font-size="2.6" font-weight="700" fill="${g.fg}" fill-opacity=".85">${esc(name)}</text><text x="${n2(rx + 2.8)}" y="${n2(ry + 6.7)}" dy=".36em" font-size="3.7" font-weight="800" fill="${g.hi}">${esc(val)}</text></g>`;
    }).join("");
    const deco = S.svg(`<defs>${glowDef(`${uid}a`, g.hi2, 0.45)}${glowDef(`${uid}p`, g.hi, 0.55)}</defs><circle cx="80" cy="58" r="74" fill="url(#${uid}a)"/><g class="a-in" style="animation-delay:.05s">${dots}</g>${marks}`);
    const head = S.block({ x: 10, y: 6, w: 112 }, (b.kicker ? para(esc(b.kicker), { size: 2.1, weight: 800, ls: 0.16, color: g.hi, lines: 1, upper: true }) : "") + para(esc(b.headline), { size: sizeFor(b.headline, [[24, 5.4], [40, 4.6], [999, 4]]), weight: 800, lines: 2, lh: 1.12, ls: -0.02, mt: b.kicker ? 0.8 : 0 }));
    return scene(g, deco + head, 150);
  },
  summary: b => `${b.headline}: ${b.points.map(p => `${p.name} ${p.value}`).join(", ")}.`,
  css: baseCss("map_pulse"),
});

export const ASSETS: readonly AnyAsset[] = [timelineRailHero, barRaceStill, mapPulse];
