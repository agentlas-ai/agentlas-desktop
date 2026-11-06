import { z } from "zod";
import { esc } from "../../kit";
import { list, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { block, clamp, cq, deco, em, figureParts, fit, glowOp, groundField, groundOf, kicker, mark, optionalPct, pct, shape, shown, stage, stagger, still, tint, trend, trendColor, trendOf, unitSpan, whole } from "./_stills";

/** Keyframe stills of motion graphics, the numbers: a big figure, three stats, a countdown, a ring gauge. Each is a 16:9 frame with its type in cqw. */

/** The width in em of a figure whose unit (sign, currency, suffix) is set at 58%. */
const figureWidth = (p: { pre: string; num: string; post: string }) => (em(p.num) + 0.58 * (em(p.pre) + em(p.post))) * 1.08 - 0.035 * [...p.pre + p.num + p.post].length;
const FIGURE = "font-weight:800;line-height:.9;letter-spacing:-.035em;white-space:nowrap";

/* ------------------------------------------------------------------------------------------------------------------ big_number */
export const bigNumber = defineAsset({
  type: "big_number", category: "motion", width: "half", frame: "16:9",
  use: "One huge figure (2.4M, +38%) as a poster frame: a label above, a line of context below and a small change chip.",
  useKo: "핵심 숫자 하나(2.4M, +38%)를 포스터처럼 크게 보여 주는 장면: 위에 라벨, 아래에 한 줄 설명과 작은 증감 칩.",
  tags: ["big number", "stat", "kpi", "hero number", "figure", "reveal", "motion", "숫자", "핵심 지표", "통계", "모션그래픽"],
  notes: "figure is shown as written (2.4M, +38%, $1.2B; at most 10 characters). delta is the chip text (+18% vs Q2); its sign sets the arrow unless trend is given. ground: ink, blue, green, violet, sunset or paper.",
  fields: { figure: text(10), label: text(40), context: optionalText(72), delta: optionalText(20), trend, ground: groundField("ink") },
  sample: { figure: "2.4M", label: "Monthly active users", context: "Highest since launch, driven by the new mobile app.", delta: "+18% vs Q2", trend: "up", ground: "ink" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "ink"), s = shape(g), p = figureParts(b.figure), t = trendOf(b.trend, b.delta);
    const size = Math.max(7, Math.min(27, 74 / figureWidth(p)));
    const art = `<defs><linearGradient id="${uid}g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${g.a}"/><stop offset="1" stop-color="${tint(g)}" stop-opacity=".55"/></linearGradient><radialGradient id="${uid}r" cx=".86" cy=".3" r=".6"><stop offset="0" stop-color="${g.b}" stop-opacity="${glowOp(g, 0.42)}"/><stop offset="1" stop-color="${g.b}" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#${uid}r)"/><circle cx="138" cy="38" r="58" fill="none" stroke="${s.hex}" stroke-opacity=".12" stroke-width=".5"/><circle cx="138" cy="38" r="33" fill="${s.hex}" fill-opacity=".07"/><circle cx="138" cy="38" r="41" pathLength="100" fill="none" stroke="url(#${uid}g)" stroke-width="9" stroke-linecap="round" stroke-dasharray="50 100" transform="rotate(140 138 38)"/>`;
    const chip = b.delta ? `<span style="display:inline-flex;align-items:center;gap:1cqw;flex:none;padding:1cqw 2.4cqw;border-radius:9cqw;border:1px solid var(--ln);background:rgba(var(--sh),.12);font-size:2.5cqw;font-weight:750;white-space:nowrap">${mark(t, trendColor(g, t))}${esc(b.delta)}</span>` : "";
    return `<div class="a-s" ${stage(g, "display:flex;flex-direction:column;justify-content:space-between;padding:6.5cqw 7cqw")}>${deco(art)}${kicker(b.label, stagger(1))}<div class="a-in" style="${stagger(2)};${FIGURE};font-size:${cq(size)}">${unitSpan(p.pre)}${esc(p.num)}${unitSpan(p.post)}</div><div class="a-in" style="${stagger(4)};display:flex;align-items:center;gap:2.6cqw">${chip}${b.context ? `<div style="font-size:2.5cqw;line-height:1.3;color:var(--mu);${clamp(2)}">${esc(b.context)}</div>` : ""}</div></div>`;
  },
  summary: b => `${b.label}: ${b.figure}${b.delta ? ` (${b.delta})` : ""}${b.context ? `. ${b.context}` : ""}`,
  css: still("big_number"),
});

/* ------------------------------------------------------------------------------------------------------------------ stat_reveal */
const stat = z.object({ figure: text(8), label: text(24), caption: optionalText(36) }).strip();
export const statReveal = defineAsset({
  type: "stat_reveal", category: "motion", width: "half", frame: "16:9",
  use: "Two to four headline stats side by side on a coloured ground, each a figure, a label and a tiny caption, separated by hairlines.",
  useKo: "색 배경 위에 핵심 수치 두~네 개를 나란히: 큰 숫자, 라벨, 작은 설명을 가는 선으로 구분.",
  tags: ["stats", "three stats", "kpi row", "reveal", "numbers", "metrics", "motion", "수치", "통계", "지표", "모션그래픽"],
  notes: "Three stats read best (two to four are drawn). figure at most 8 characters, as written (92%, $4.8M); heading is a short line above.",
  fields: { heading: optionalText(48), stats: list(stat, 2, 4), ground: groundField("blue") },
  sample: { heading: "Q3 at a glance", stats: [{ figure: "$4.8M", label: "Revenue", caption: "Up from $3.9M in Q2" }, { figure: "92%", label: "Retention", caption: "12-month cohorts" }, { figure: "1,284", label: "New customers", caption: "Across 38 countries" }], ground: "blue" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "blue"), s = shape(g), n = b.stats.length, colW = 88 / n - 4.4, cap = n === 2 ? 13.5 : n === 3 ? 10.6 : 8.4;
    const sizes = b.stats.map(st => Math.max(2, Math.min(cap, colW / figureWidth(figureParts(st.figure))))), top = Math.max(...sizes);
    const art = `<defs><radialGradient id="${uid}r" cx=".9" cy=".05" r=".55"><stop offset="0" stop-color="${g.b}" stop-opacity="${glowOp(g, 0.45)}"/><stop offset="1" stop-color="${g.b}" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#${uid}r)"/><circle cx="146" cy="6" r="44" fill="${s.hex}" fill-opacity=".07"/><circle cx="146" cy="6" r="30" fill="none" stroke="${s.hex}" stroke-opacity=".16" stroke-width=".5"/><circle cx="2" cy="98" r="52" fill="${s.hex}" fill-opacity=".05"/>`;
    const cols = b.stats.map((st, i) => {
      const p = figureParts(st.figure), size = sizes[i];
      return `<div class="a-c a-in" style="${stagger(i + 1, 0.12, 0.16)}"><i style="display:block;width:4cqw;height:.8cqw;margin-bottom:2cqw;border-radius:1cqw;background:var(--a)"></i><div style="display:flex;align-items:flex-end;height:${cq(top)};overflow:hidden"><div style="${FIGURE};line-height:1;font-size:${cq(size)}">${unitSpan(p.pre)}${esc(p.num)}${unitSpan(p.post)}</div></div><div style="margin-top:1.6cqw;font-size:2.8cqw;font-weight:750;line-height:1.2;${clamp(2)}">${esc(st.label)}</div>${st.caption ? `<div style="margin-top:.8cqw;font-size:2.2cqw;line-height:1.3;color:var(--mu);${clamp(2)}">${esc(st.caption)}</div>` : ""}</div>`;
    }).join("");
    return `<div class="a-s" ${stage(g, "display:flex;flex-direction:column;justify-content:space-between;padding:6.5cqw 6cqw")}>${deco(art)}${b.heading ? kicker(b.heading, stagger(0, 0.04), 70) : "<i></i>"}<div style="display:grid;grid-template-columns:repeat(${n},minmax(0,1fr))">${cols}</div></div>`;
  },
  summary: b => `${b.heading ? `${b.heading}: ` : ""}${b.stats.map(x => `${x.label} ${x.figure}${x.caption ? ` (${x.caption})` : ""}`).join("; ")}`,
  css: still("stat_reveal", ".a-c{min-width:0;padding:0 1.6cqw 0 2.8cqw;border-left:1px solid var(--ln)}.a-c:first-child{padding-left:0;border-left:0}"),
});

/* ------------------------------------------------------------------------------------------------------------------ countdown_card */
export const countdownCard = defineAsset({
  type: "countdown_card", category: "motion", width: "half", frame: "16:9",
  use: "A countdown poster: days, hours and minutes left in big tiles, the event's name, its date and an optional progress ring.",
  useKo: "카운트다운 포스터: 남은 일·시간·분을 큰 타일로, 행사 이름과 날짜, 선택적 진행 링.",
  tags: ["countdown", "timer", "days left", "event", "launch", "deadline", "motion", "카운트다운", "남은 시간", "디데이", "행사"],
  notes: "Give the time left at the moment you draw it (days, hours, minutes as numbers). progress (0-100) draws how much of the run-up has passed on the ring; leave it out for a plain dial.",
  fields: { event: text(48), days: whole(999), hours: whole(23), minutes: whole(59), date: optionalText(40), progress: optionalPct, ground: groundField("violet") },
  sample: { event: "Agentlas Summit 2026", days: 12, hours: 8, minutes: 45, date: "Dec 18, 2026 · 09:00 KST", progress: 68, ground: "violet" },
  render(b, { uid, T }) {
    const g = groundOf(b.ground, "violet"), s = shape(g), pad = (n: number) => String(n).padStart(2, "0");
    const prog = typeof b.progress === "number" && b.progress > 0.5 ? `<circle cx="80" cy="46" r="56" pathLength="100" fill="none" stroke="${g.a}" stroke-width="1.9" stroke-linecap="round" stroke-dasharray="${shown(b.progress)} 100" transform="rotate(-90 80 46)"/>` : "";
    const art = `<defs><radialGradient id="${uid}r" cx=".5" cy=".5" r=".55"><stop offset="0" stop-color="${g.b}" stop-opacity="${glowOp(g, 0.38)}"/><stop offset="1" stop-color="${g.b}" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#${uid}r)"/><circle cx="80" cy="46" r="56" fill="none" stroke="${s.hex}" stroke-opacity=".3" stroke-width="2.8" pathLength="100" stroke-dasharray=".4 1.1"/><circle cx="80" cy="46" r="63" fill="none" stroke="${s.hex}" stroke-opacity=".12" stroke-width=".4"/><circle cx="80" cy="46" r="50" fill="${s.hex}" fill-opacity=".05"/>${prog}`;
    const tile = (n: number, label: string, i: number, wide: boolean) => `<div class="a-tt a-in" style="${stagger(i + 1, 0.15, 0.14)}"><div style="font-size:${wide ? "8.6cqw" : "10.6cqw"};font-weight:800;line-height:1;letter-spacing:-.04em">${wide ? n : pad(n)}</div><div style="margin-top:1.1cqw;font-size:2.1cqw;font-weight:800;letter-spacing:.16em;text-transform:uppercase;opacity:.78">${esc(label)}</div></div>`;
    const colon = (i: number) => `<i class="a-in" style="${stagger(i, 0.15, 0.14)};font-style:normal;font-size:6.4cqw;font-weight:800;line-height:1;color:var(--a);padding-bottom:2cqw">:</i>`;
    const evSize = block(b.event, 54, 11.5, 5.8, 3.2, 1.1, -0.01);
    return `<div class="a-s" ${stage(g, "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.8cqw;padding:5cqw 6cqw;text-align:center")}>${deco(art)}<div class="a-in" style="${stagger(0, 0.05)};max-width:54cqw;font-size:${cq(evSize)};font-weight:800;letter-spacing:-.01em;line-height:1.1;${clamp(2)}">${esc(b.event)}</div><div style="display:flex;align-items:center;gap:1.4cqw">${tile(b.days, T("Days", "일"), 0, String(b.days).length > 2)}${colon(1)}${tile(b.hours, T("Hours", "시간"), 1, false)}${colon(2)}${tile(b.minutes, T("Minutes", "분"), 2, false)}</div>${b.date ? `<div class="a-in" style="${stagger(5)};display:inline-flex;align-items:center;gap:1.4cqw;max-width:52cqw;padding:1cqw 2.8cqw;border-radius:9cqw;border:1px solid var(--ln);background:rgba(var(--sh),.1);font-size:${cq(fit(b.date, 38, 2.4, 1.7))};font-weight:700;color:var(--mu)"><svg style="width:1.1em;height:1.1em;flex:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>${esc(b.date)}</div>` : ""}</div>`;
  },
  summary: b => `${b.event}: ${b.days} days, ${b.hours} hours, ${b.minutes} minutes left${b.date ? ` (${b.date})` : ""}${typeof b.progress === "number" ? `, ${shown(b.progress)}% of the run-up passed` : ""}.`,
  css: still("countdown_card", ".a-tt{width:18.6cqw;padding:2.2cqw 0 1.8cqw;border-radius:2.4cqw;border:1px solid var(--ln);background:rgba(var(--sh),.12)}.a-tt:first-child{border-color:transparent;background:var(--a);color:var(--on)}"),
});

/* ------------------------------------------------------------------------------------------------------------------ percent_ring_hero */
export const percentRingHero = defineAsset({
  type: "percent_ring_hero", category: "motion", width: "half", frame: "16:9",
  use: "A huge ring gauge with the percentage at poster scale in its middle, a title and a two-line description, optionally a second ring to compare.",
  useKo: "가운데 퍼센트를 포스터 크기로 담은 큰 링 게이지와 제목, 두 줄 설명. 비교용 두 번째 링도 가능.",
  tags: ["percent", "ring", "gauge", "progress", "completion", "share", "motion", "퍼센트", "링", "진행률", "달성률"],
  notes: "percent is 0-100. second (0-100) draws an inner ring, for example last year; label and secondLabel name the two rings in a small legend.",
  fields: { percent: pct, headline: text(48), description: optionalText(120), label: optionalText(20), second: optionalPct, secondLabel: optionalText(20), ground: groundField("green") },
  sample: { percent: 72, headline: "Projects shipped on time", description: "Share of 2026 launches that met their original ship date, up from 49% last year.", label: "2026", second: 49, secondLabel: "2025", ground: "green" },
  render(b, { uid }) {
    const g = groundOf(b.ground, "green"), s = shape(g), two = typeof b.second === "number", cx = 44, cy = 45, r1 = 33, w1 = two ? 8 : 11, r2 = 24, w2 = 6;
    const ring = (id: string, r: number, w: number, p: number, from: string, to: string) => `<linearGradient id="${uid}${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.hex}" stroke-opacity=".16" stroke-width="${w}"/>${p > 0.4 ? `<circle class="a-rg" cx="${cx}" cy="${cy}" r="${r}" pathLength="100" fill="none" stroke="url(#${uid}${id})" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${shown(p)} 100" transform="rotate(-90 ${cx} ${cy})"/>` : ""}`;
    const art = `<defs><radialGradient id="${uid}r" cx=".27" cy=".5" r=".5"><stop offset="0" stop-color="${g.b}" stop-opacity="${glowOp(g, 0.4)}"/><stop offset="1" stop-color="${g.b}" stop-opacity="0"/></radialGradient></defs><rect width="160" height="90" fill="url(#${uid}r)"/><circle cx="${cx}" cy="${cy}" r="${r1 + w1 / 2 + 5}" fill="none" stroke="${s.hex}" stroke-opacity=".12" stroke-width=".4"/>${ring("a", r1, w1, b.percent, g.a, tint(g))}${two ? ring("b", r2, w2, b.second as number, g.b, g.dark ? s.hex : "#f7b267") : ""}`;
    const inner = (two ? r2 - w2 / 2 : r1 - w1 / 2) * 2 * 0.625 * 0.88, box = inner / 0.88, psize = fit(`${shown(b.percent)}%`, inner, two ? 11 : 15.5, 4, -0.03);
    const hsize = block(b.headline, 38, 16, 6.4, 3.2, 1.1, -0.01, 1.08), dsize = b.description ? block(b.description, 38, 12.5, 2.8, 2, 1.38) : 0;
    const dot = (c: string) => `<i style="display:inline-block;width:1.7cqw;height:1.7cqw;margin-right:.9cqw;border-radius:50%;vertical-align:-.15cqw;background:${c}"></i>`;
    const legend = two ? `<div class="a-in" style="${stagger(4, 0.2)};display:flex;flex-wrap:wrap;gap:1cqw 2.6cqw;margin-top:.6cqw;font-size:2.3cqw;color:var(--mu)"><span>${dot(g.a)}${b.label ? `${esc(b.label)} ` : ""}<b style="color:var(--fg);font-weight:800">${shown(b.percent)}%</b></span><span>${dot(g.b)}${b.secondLabel ? `${esc(b.secondLabel)} ` : ""}<b style="color:var(--fg);font-weight:800">${shown(b.second as number)}%</b></span></div>` : "";
    return `<div class="a-s" ${stage(g)}>${deco(art, 0)}<div class="a-in" style="${stagger(0, 0.2)};position:absolute;left:${cq((cx * 100) / 160 - box / 2)};top:${cq((cy * 100) / 160 - box / 2)};width:${cq(box)};height:${cq(box)};display:flex;align-items:center;justify-content:center;font-size:${cq(psize)};font-weight:800;line-height:1;letter-spacing:-.03em">${esc(shown(b.percent))}${unitSpan("%", 0.5)}</div><div style="position:absolute;left:57cqw;right:5cqw;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:1.8cqw">${!two && b.label ? `<div class="a-in" style="${stagger(1, 0.2)};font-size:2.2cqw;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:var(--a);${clamp(1)}">${esc(b.label)}</div>` : ""}<div class="a-in" style="${stagger(2, 0.2)};font-size:${cq(hsize)};font-weight:800;letter-spacing:-.02em;line-height:1.1;${clamp(4)}">${esc(b.headline)}</div>${b.description ? `<div class="a-in" style="${stagger(3, 0.2)};font-size:${cq(dsize)};line-height:1.38;color:var(--mu);${clamp(4)}">${esc(b.description)}</div>` : ""}${legend}</div></div>`;
  },
  summary: b => `${b.headline}: ${shown(b.percent)}%${b.label ? ` (${b.label})` : ""}${typeof b.second === "number" ? `, against ${shown(b.second)}%${b.secondLabel ? ` (${b.secondLabel})` : ""}` : ""}${b.description ? `. ${b.description}` : ""}`,
  css: still("percent_ring_hero", ".a-rg{animation:a-percent_ring_hero-r 1.3s cubic-bezier(.3,.7,.2,1) .15s both}", "@keyframes a-percent_ring_hero-r{from{stroke-dasharray:0 100}}"),
});

export const ASSETS: readonly AnyAsset[] = [bigNumber, statReveal, countdownCard, percentRingHero];
