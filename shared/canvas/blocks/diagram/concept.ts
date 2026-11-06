import { z } from "zod";
import { esc } from "../../kit";
import { list, optionalText, text, tone } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { AMBER, BLUE, EDGE, FAINT, GREEN, INK, INK2, ORANGE, RED, VIOLET, WHITE, aliased, baseCss, fit, idList, isObj, keyOf, labelled, n, optList, percent, pick, resolver, svg, tw, txt, wrap, type Hue } from "./_layout-b";

/* ================================================================== venn_diagram */

const vset = aliased({ name: text(24), items: optList(labelled(26), 3) }, { name: ["label", "title", "set"], items: ["only", "elements", "members", "points", "unique"] });
const overlap = aliased({ between: idList(3), label: text(48) }, { between: ["sets", "intersection", "overlap"], label: ["name", "text", "title", "value"] });

export const vennDiagram = defineAsset({
  type: "venn_diagram", category: "diagram", width: "half",
  use: "How two or three sets overlap: translucent circles with a label for each set and for what lies in the overlaps.",
  useKo: "두세 개 집합이 어떻게 겹치는지, 집합 이름과 겹치는 영역의 설명을 반투명 원으로 보여주는 벤 다이어그램.",
  tags: ["venn", "overlap", "intersection", "sets", "common ground", "벤 다이어그램", "교집합", "겹침", "집합"],
  notes: "sets: 2 or 3, each with a name and up to 3 short items for what is only in that set. overlaps: [{ between: [set names], label }] for the shared regions (two sets, or all three).",
  fields: { sets: list(vset, 2, 3), overlaps: optList(overlap, 4) },
  sample: { title: "What makes a product manager", sets: [
    { name: "Design", items: ["User research", "Visual craft"] },
    { name: "Technology", items: ["Architecture", "Code quality"] },
    { name: "Business", items: ["Market sizing", "Pricing"] },
  ], overlaps: [
    { between: ["Design", "Technology"], label: "Prototyping" },
    { between: ["Design", "Business"], label: "Positioning" },
    { between: ["Technology", "Business"], label: "Unit economics" },
    { between: ["Design", "Technology", "Business"], label: "Product sense" },
  ] },
  render(b) {
    const sets = b.sets, k = sets.length, hues: Hue[] = k === 2 ? [BLUE, ORANGE] : [BLUE, ORANGE, GREEN];
    const byName = resolver(sets.map((s, i) => [s.name, i] as [string, number]));
    const find = (ref: string) => {
      let i = byName(ref);
      if (i < 0) { const m = /^(?:set\s*)?([abc1-3])$/.exec(keyOf(ref)); if (m) i = "abc".includes(m[1]) ? "abc".indexOf(m[1]) : Number(m[1]) - 1; }
      return i < k ? i : -1;
    };
    const region = new Map<string, string>();
    for (const o of b.overlaps) { const ids = [...new Set(o.between.map(find))].filter(i => i >= 0).sort(); if (ids.length >= 2 && !region.has(ids.join(""))) region.set(ids.join(""), o.label); }
    const W = 480, cx = W / 2;
    let R: number, centers: { x: number; y: number }[], H: number, G = { x: cx, y: 0 };
    if (k === 2) { R = 114; const d = 124, cy = 40 + R; centers = [{ x: cx - d / 2, y: cy }, { x: cx + d / 2, y: cy }]; G = { x: cx, y: cy }; H = cy + R + 14; }
    else { R = 116; const d = 128, rho = d / Math.sqrt(3), ay = 34 + R; G = { x: cx, y: ay + rho / 2 }; centers = [{ x: cx - d / 2, y: ay }, { x: cx + d / 2, y: ay }, { x: cx, y: G.y + rho }]; H = centers[2].y + R + 34; }
    const unit = (p: { x: number; y: number }) => { const dx = p.x - G.x, dy = p.y - G.y, l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; };
    // The anchor and the width each region's text gets.
    const spots = new Map<string, { x: number; y: number; w: number }>();
    if (k === 2) { spots.set("0", { x: centers[0].x - 52, y: G.y, w: 96 }); spots.set("1", { x: centers[1].x + 52, y: G.y, w: 96 }); spots.set("01", { x: cx, y: G.y, w: 84 }); }
    else {
      centers.forEach((c, i) => { const u = unit(c); spots.set(String(i), { x: c.x + u.x * 0.6 * R, y: c.y + u.y * 0.6 * R, w: 88 }); });
      [[0, 1], [0, 2], [1, 2]].forEach(([i, j]) => { const mid = { x: (centers[i].x + centers[j].x) / 2, y: (centers[i].y + centers[j].y) / 2 }, u = unit(mid); spots.set(`${i}${j}`, { x: mid.x + u.x * 0.42 * R, y: mid.y + u.y * 0.42 * R, w: 74 }); });
      spots.set("012", { x: G.x, y: G.y + 2, w: 62 });
    }
    const circles = centers.map((c, i) => `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${R}" fill="${hues[i].solid}" fill-opacity=".2" stroke="${hues[i].solid}" stroke-opacity=".9" stroke-width="1.8"/>`).join("");
    let labels = "";
    sets.forEach((s, i) => {
      const c = centers[i], below = k === 3 && i === 2;
      labels += txt(c.x, below ? c.y + R + 20 : c.y - R - 12, [fit(s.name, 120, 13.5, true)], { size: 13.5, weight: 800, fill: hues[i].ink, anchor: "middle" });
      const spot = spots.get(String(i));
      if (spot && s.items.length) { const lines = s.items.flatMap(it => wrap(it, spot.w, 11.5, 2)); labels += txt(spot.x, spot.y, lines.slice(0, 5), { size: 11.5, weight: 550, fill: INK2, anchor: "middle", lh: 14 }); }
    });
    for (const [key, label] of region) {
      const spot = spots.get(key);
      if (spot) labels += txt(spot.x, spot.y, wrap(label, spot.w, 11.5, 4, true), { size: 11.5, weight: 800, fill: INK, anchor: "middle", lh: 14 });
    }
    return svg(W, H, `${circles}${labels}`, { title: b.title });
  },
  summary: b => {
    const names = b.sets.map(s => s.name), parts = b.sets.map(s => `only ${s.name}${s.items.length ? `: ${s.items.join(", ")}` : ""}`);
    return `${b.title ?? "Venn diagram"} of ${names.join(", ")}. ${parts.join("; ")}. Shared: ${b.overlaps.length ? b.overlaps.map(o => `${o.between.join(" + ")} = ${o.label}`).join("; ") : "none given"}.`.slice(0, 400);
  },
  css: baseCss("venn_diagram"),
});

/* ================================================================== quadrant_matrix */

const quadrants = z.preprocess(v => {
  const take = (o: Record<string, unknown>, keys: string[]) => { const x = pick(o, keys); return typeof x === "string" || typeof x === "number" ? String(x) : undefined; };
  if (Array.isArray(v)) { const [tl, tr, bl, br] = v.map(x => (isObj(x) ? pick(x, ["label", "name", "title"]) : x)); return { tl, tr, bl, br }; }
  if (isObj(v)) return { tl: take(v, ["tl", "top_left", "topLeft", "topleft", "upper_left"]), tr: take(v, ["tr", "top_right", "topRight", "topright", "upper_right"]), bl: take(v, ["bl", "bottom_left", "bottomLeft", "bottomleft", "lower_left"]), br: take(v, ["br", "bottom_right", "bottomRight", "bottomright", "lower_right"]) };
  return undefined;
}, z.object({ tl: optionalText(26), tr: optionalText(26), bl: optionalText(26), br: optionalText(26) }).strip().optional());
const qitem = aliased({ label: text(28), x: percent, y: percent, tone: tone.optional() }, { label: ["name", "text", "title"] });
const TONE_HUE: Record<string, Hue> = { up: GREEN, down: RED, warn: AMBER, info: BLUE };

interface Box { x0: number; y0: number; x1: number; y1: number }
const hit = (a: Box, b: Box, pad = 2) => a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad;

export const quadrantMatrix = defineAsset({
  type: "quadrant_matrix", category: "diagram", width: "half",
  use: "Place items on a 2x2 by two scores (impact vs effort, risk vs likelihood) with named quadrants and labelled dots.",
  useKo: "두 기준(영향도·노력, 위험·가능성)으로 항목을 2x2 사분면에 점으로 배치하고 사분면 이름을 붙이는 매트릭스.",
  tags: ["quadrant", "matrix", "2x2", "priority", "impact effort", "prioritization", "사분면", "매트릭스", "우선순위", "영향도"],
  notes: "x and y run 0-100 (x to the right, y upward). Axis labels and the low/high ends are short; quadrants are [top-left, top-right, bottom-left, bottom-right]. Up to 16 items; each may carry a tone (up, down, warn, info, neutral) for its colour.",
  fields: { xLabel: text(28), yLabel: text(28), xLow: optionalText(16), xHigh: optionalText(16), yLow: optionalText(16), yHigh: optionalText(16), quadrants, items: list(qitem, 1, 16) },
  sample: { title: "Backlog: impact versus effort", xLabel: "Effort", xLow: "Low", xHigh: "High", yLabel: "Impact", yLow: "Low", yHigh: "High",
    quadrants: { tl: "Quick wins", tr: "Major projects", bl: "Fill-ins", br: "Reconsider" },
    items: [
      { label: "Onboarding checklist", x: 18, y: 88, tone: "up" }, { label: "Saved searches", x: 30, y: 70 }, { label: "Dark mode", x: 24, y: 34 },
      { label: "CSV export", x: 14, y: 52 }, { label: "SSO", x: 78, y: 82, tone: "up" }, { label: "Mobile app", x: 90, y: 66 },
      { label: "AI summaries", x: 66, y: 94 }, { label: "Custom themes", x: 72, y: 24, tone: "warn" }, { label: "Legacy import", x: 84, y: 12, tone: "down" }, { label: "Email digest", x: 40, y: 20 },
    ] },
  render(b) {
    const W = 480, PX = 54, PY = 12, PW = 410, PH = 300, GAP = 4, qw = (PW - GAP) / 2, qh = (PH - GAP) / 2, q = b.quadrants ?? {};
    const rects = [[PX, PY, "#f7f8f7"], [PX + qw + GAP, PY, "#f1f3f2"], [PX, PY + qh + GAP, "#f1f3f2"], [PX + qw + GAP, PY + qh + GAP, "#f7f8f7"]] as const;
    let out = rects.map(([x, y, f]) => `<rect x="${n(x)}" y="${n(y)}" width="${n(qw)}" height="${n(qh)}" rx="14" fill="${f}"/>`).join("");
    // Quadrant names sit in the outer corners and are obstacles for the labels.
    const obstacles: Box[] = [];
    const names: [string | undefined, number, number, "start" | "end"][] = [[q.tl, PX + 14, PY + 18, "start"], [q.tr, PX + PW - 14, PY + 18, "end"], [q.bl, PX + 14, PY + PH - 16, "start"], [q.br, PX + PW - 14, PY + PH - 16, "end"]];
    for (const [name, x, y, anchor] of names) {
      if (!name) continue;
      const label = fit(name.toUpperCase(), qw - 40, 10.5, true), w = tw(label, 10.5, true) + 8;
      out += txt(x, y, [label], { size: 10.5, weight: 800, fill: "#7d898f", anchor, spacing: 0.6 });
      obstacles.push({ x0: anchor === "start" ? x - 2 : x - w, y0: y - 8, x1: anchor === "start" ? x + w : x + 2, y1: y + 8 });
    }
    // Dots at their scores; two dots too close are moved apart along a fixed spiral.
    const sx = (v: number) => PX + 14 + (v / 100) * (PW - 28), sy = (v: number) => PY + 14 + (1 - v / 100) * (PH - 28);
    const dots: { x: number; y: number }[] = [];
    const bad = (c: { x: number; y: number }) => dots.some(d => Math.hypot(d.x - c.x, d.y - c.y) < 15) || obstacles.some(o => c.x > o.x0 - 8 && c.x < o.x1 + 8 && c.y > o.y0 - 8 && c.y < o.y1 + 8);
    for (const it of b.items) {
      let p = { x: sx(it.x), y: sy(it.y) };
      if (bad(p)) {
        search: for (const r of [15, 22, 30, 38]) for (let a = 0; a < 12; a++) {
          const c = { x: sx(it.x) + r * Math.cos((a * Math.PI) / 6), y: sy(it.y) + r * Math.sin((a * Math.PI) / 6) };
          if (c.x > PX + 8 && c.x < PX + PW - 8 && c.y > PY + 8 && c.y < PY + PH - 8 && !bad(c)) { p = c; break search; }
        }
      }
      dots.push(p);
    }
    const placed: Box[] = [...obstacles, ...dots.map(d => ({ x0: d.x - 8, y0: d.y - 8, x1: d.x + 8, y1: d.y + 8 }))];
    let labels = "", marks = "", leaders = "";
    b.items.forEach((it, i) => {
      const d = dots[i], own = obstacles.length + i, h = it.tone ? TONE_HUE[it.tone] ?? { solid: "#5c6870" } : BLUE;
      marks += `<circle cx="${n(d.x)}" cy="${n(d.y)}" r="6.5" fill="${h.solid}" stroke="#fff" stroke-width="2"/>`;
      // The label goes where it covers nothing: next to its dot, else shifted with a leader line, else shortened; when nothing is free it is left out (the dot stays).
      for (const maxW of [150, 96]) {
        const label = fit(it.label, maxW, 11.5, true), lw = tw(label, 11.5, true) + 2;
        const tries: { x0: number; y0: number; a: "start" | "end" | "middle" }[] = [{ x0: d.x + 10, y0: d.y - 7, a: "start" }, { x0: d.x - 10 - lw, y0: d.y - 7, a: "end" }, { x0: d.x - lw / 2, y0: d.y - 23, a: "middle" }, { x0: d.x - lw / 2, y0: d.y + 9, a: "middle" }];
        for (const dy of [-15, 15, -30, 30, -45, 45, -60, 60, -75, 75]) { tries.push({ x0: d.x + 10, y0: d.y - 7 + dy, a: "start" }); tries.push({ x0: d.x - 10 - lw, y0: d.y - 7 + dy, a: "end" }); }
        const free = tries.find(t => {
          const box = { x0: t.x0, y0: t.y0, x1: t.x0 + lw, y1: t.y0 + 14 };
          return !(box.x0 < PX + 4 || box.x1 > PX + PW - 4 || box.y0 < PY + 2 || box.y1 > PY + PH - 2) && !placed.some((o, j) => j !== own && hit(box, o));
        });
        if (!free) continue;
        const box = { x0: free.x0, y0: free.y0, x1: free.x0 + lw, y1: free.y0 + 14 };
        placed.push(box);
        if (tries.indexOf(free) > 3) leaders += `<path d="M${n(d.x)},${n(d.y)}L${n(free.a === "start" ? box.x0 - 2 : box.x1 + 2)},${n(box.y0 + 7)}" stroke="#b9c3be" stroke-width="1" stroke-linecap="round"/>`;
        const tx = free.a === "start" ? box.x0 : free.a === "end" ? box.x1 : (box.x0 + box.x1) / 2;
        labels += txt(tx, box.y0 + 7, [label], { size: 11.5, weight: 650, fill: INK, anchor: free.a }).replace("<text ", '<text stroke="#fff" stroke-opacity=".85" stroke-width="3.2" stroke-linejoin="round" paint-order="stroke" ');
        break;
      }
    });
    out += leaders + marks + labels;
    // Axes: a line with an arrowhead and, along it, low end, title and high end.
    const ax = PY + PH + 10, ay = PX - 10, endText = { size: 11, weight: 600, fill: FAINT };
    out += `<path d="M${PX},${ax}H${PX + PW}m-5,-3.5l5,3.5l-5,3.5" fill="none" stroke="${EDGE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M${ay},${PY + PH}V${PY}m-3.5,5l3.5,-5l3.5,5" fill="none" stroke="${EDGE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    out += txt(PX + PW / 2, ax + 19, [fit(b.xLabel, 200, 12, true)], { size: 12, weight: 750, fill: INK2, anchor: "middle" });
    if (b.xLow) out += txt(PX, ax + 19, [fit(b.xLow, 90, 11, true)], { ...endText, anchor: "start" });
    if (b.xHigh) out += txt(PX + PW, ax + 19, [fit(b.xHigh, 90, 11, true)], { ...endText, anchor: "end" });
    const rot = (x: number, y: number, s: string, o: Parameters<typeof txt>[3]) => `<g transform="translate(${n(x)},${n(y)}) rotate(-90)">${txt(0, 0, [s], o)}</g>`;
    out += rot(PX - 22, PY + PH / 2, fit(b.yLabel, 140, 12, true), { size: 12, weight: 750, fill: INK2, anchor: "middle" });
    if (b.yLow) out += rot(PX - 22, PY + PH, fit(b.yLow, 64, 11, true), { ...endText, anchor: "start" });
    if (b.yHigh) out += rot(PX - 22, PY, fit(b.yHigh, 64, 11, true), { ...endText, anchor: "end" });
    return svg(W, PY + PH + 40, out, { title: b.title });
  },
  summary: b => {
    const q = b.quadrants ?? {}, where = (it: { x: number; y: number }) => `${it.y >= 50 ? "top" : "bottom"}-${it.x >= 50 ? "right" : "left"}`;
    const names = [q.tl && `top-left ${q.tl}`, q.tr && `top-right ${q.tr}`, q.bl && `bottom-left ${q.bl}`, q.br && `bottom-right ${q.br}`].filter(Boolean).join(", ");
    return `${b.title ?? "Quadrant matrix"}: x = ${b.xLabel}, y = ${b.yLabel}${names ? `; quadrants ${names}` : ""}. Items: ${b.items.map(it => `${it.label} (${where(it)})`).join(", ")}.`.slice(0, 400);
  },
  css: baseCss("quadrant_matrix"),
});

/* ================================================================== pyramid_diagram */

const layer = aliased({ label: text(28), detail: optionalText(110) }, { label: ["name", "title", "level", "text"], detail: ["description", "desc", "note", "text_detail", "body"] });
const mix = (a: string, b: string, t: number) => { const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16)); return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("")}`; };

export const pyramidDiagram = defineAsset({
  type: "pyramid_diagram", category: "diagram", width: "two_thirds",
  use: "A hierarchy of three to six stacked layers, narrow at the top and wide at the base, each with a short description beside it.",
  useKo: "위가 좁고 아래가 넓은 3~6단 계층(욕구 단계, DIKW 등)을 층 이름과 옆 설명으로 보여주는 피라미드.",
  tags: ["pyramid", "hierarchy", "levels", "layers", "dikw", "hierarchy of needs", "피라미드", "계층", "단계", "욕구 단계"],
  notes: "layers[0] is the top (the apex). Each layer: a short label and an optional description. inverted: true draws the widest layer first (a funnel).",
  fields: { layers: list(layer, 2, 6), inverted: z.boolean().optional() },
  sample: { title: "From data to wisdom", layers: [
    { label: "Wisdom", detail: "Judgement: knowing what to do and why, and when not to act." },
    { label: "Knowledge", detail: "Patterns understood and connected, so they can be applied to new cases." },
    { label: "Information", detail: "Data given context: who, what, where and when." },
    { label: "Data", detail: "Raw facts and figures with no interpretation yet." },
  ] },
  render(b) {
    const ls = b.layers, k = ls.length, hasDetail = ls.some(l => l.detail), inv = !!b.inverted;
    const PW = 320, W0 = 96, lh = k <= 3 ? 74 : k === 4 ? 66 : k === 5 ? 58 : 52, gap = 4, Ht = k * lh + (k - 1) * gap, padY = 8, W = hasDetail ? 680 : PW + 24, cx = hasDetail ? 12 + PW / 2 : W / 2;
    const half = (y: number) => (inv ? PW - (PW - W0) * (y / Ht) : W0 + (PW - W0) * (y / Ht)) / 2;
    let shapes = "", notes = "";
    ls.forEach((l, i) => {
      const y0 = padY + i * (lh + gap), y1 = y0 + lh, ym = (y0 + y1) / 2, t = k > 1 ? i / (k - 1) : 0, fill = mix("#17358f", "#5b86ee", inv ? 1 - t : t);
      const a = half(y0 - padY), c = half(y1 - padY), mid = half(ym - padY);
      shapes += `<path d="M${n(cx - a)},${n(y0)}L${n(cx + a)},${n(y0)}L${n(cx + c)},${n(y1)}L${n(cx - c)},${n(y1)}Z" fill="${fill}" stroke="#fff" stroke-width="1" stroke-linejoin="round"/>`;
      const inner = Math.max(40, 2 * Math.min(a, c) * 0.78 - 10), lines = wrap(l.label, Math.min(inner + 12, 2 * mid - 22), 12.5, 2, true);
      shapes += txt(cx, ym, lines, { size: 12.5, weight: 750, fill: WHITE, anchor: "middle", lh: 15 });
      if (l.detail) {
        const x1 = cx + mid + 8, tx = 12 + PW + 26, dl = wrap(l.detail, W - tx - 8, 12.5, 3);
        notes += `<path d="M${n(x1)},${n(ym)}H${n(tx - 8)}" stroke="#cfd6d2" stroke-width="1.4" stroke-dasharray="1 4.5" stroke-linecap="round"/><circle cx="${n(x1)}" cy="${n(ym)}" r="2.6" fill="${fill}"/>`;
        notes += txt(tx, ym, dl, { size: 12.5, weight: 500, fill: INK2, lh: 16.5 });
      }
    });
    return svg(W, Ht + padY * 2, `${shapes}${notes}`, { title: b.title });
  },
  summary: b => `${b.title ?? "Pyramid"} (${b.inverted ? "widest first" : "top to base"}): ${b.layers.map(l => `${l.label}${l.detail ? ` — ${l.detail}` : ""}`).join("; ")}.`.slice(0, 400),
  css: baseCss("pyramid_diagram"),
});

/* ================================================================== swot_matrix */

const bullets = list(labelled(110), 1, 5);

export const swotMatrix = defineAsset({
  type: "swot_matrix", category: "diagram", width: "two_thirds",
  use: "A SWOT analysis: strengths, weaknesses, opportunities and threats as a colour-coded 2x2 with a few bullets each.",
  useKo: "강점·약점·기회·위협을 색으로 구분한 2x2에 항목별 불릿으로 정리하는 SWOT 분석.",
  tags: ["swot", "strengths", "weaknesses", "opportunities", "threats", "strategy", "강점", "약점", "기회", "위협", "스왓"],
  notes: "2-5 short bullets per quadrant. center is an optional label for the subject (it sits where the four meet).",
  fields: { strengths: bullets, weaknesses: bullets, opportunities: bullets, threats: bullets, center: optionalText(30) },
  sample: { title: "SWOT: regional coffee roaster", center: "Roastery 2027",
    strengths: ["Loyal subscription base of 8,000 homes", "Direct trade with 12 farms", "Fast, flexible small-batch roasting"],
    weaknesses: ["One roasting site, no backup capacity", "Little brand awareness outside the region", "Thin margins on wholesale"],
    opportunities: ["Office and hotel contracts reopening", "Growing demand for single-origin coffee", "Retail partnerships with grocers"],
    threats: ["Green coffee prices up 30% in a year", "Large chains launching premium lines", "Shipping costs and delays"] },
  render(b, { T }) {
    const cell = (k: string, letter: string, title: string, items: string[]) => `<div class="a-q a-q-${k}"><div class="a-h"><i>${letter}</i><b>${esc(title)}</b></div><ul>${items.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}<div class="a-sw${b.center ? " a-hc" : ""}">${cell("s", "S", T("Strengths", "강점"), b.strengths)}${cell("w", "W", T("Weaknesses", "약점"), b.weaknesses)}${cell("o", "O", T("Opportunities", "기회"), b.opportunities)}${cell("t", "T", T("Threats", "위협"), b.threats)}${b.center ? `<div class="a-c">${esc(b.center)}</div>` : ""}</div>`;
  },
  summary: b => `${b.title ?? "SWOT"}${b.center ? ` (${b.center})` : ""}. Strengths: ${b.strengths.join("; ")}. Weaknesses: ${b.weaknesses.join("; ")}. Opportunities: ${b.opportunities.join("; ")}. Threats: ${b.threats.join("; ")}.`.slice(0, 400),
  css: [
    ".fpc .a-swot_matrix .a-sw{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:12px}.fpc .a-swot_matrix .a-hc{row-gap:34px}",
    ".fpc .a-swot_matrix .a-q{min-width:0;padding:14px 16px;border-radius:16px;border:1px solid #e3e7e4;background:var(--b)}",
    ".fpc .a-swot_matrix .a-q-s{--c:#118558;--b:#eaf5ef;--k:#0b6a45}.fpc .a-swot_matrix .a-q-w{--c:#b7791f;--b:#fbf3e2;--k:#8a5a12}",
    ".fpc .a-swot_matrix .a-q-o{--c:#2f5fd6;--b:#eaf0fd;--k:#1f46a8}.fpc .a-swot_matrix .a-q-t{--c:#cf3545;--b:#fbeaec;--k:#a82434}",
    ".fpc .a-swot_matrix .a-h{display:flex;align-items:center;gap:9px;margin-bottom:10px}.fpc .a-swot_matrix .a-h i{flex:none;width:26px;height:26px;border-radius:50%;background:var(--c);color:#fff;font-style:normal;font-size:13px;font-weight:800;line-height:26px;text-align:center}",
    ".fpc .a-swot_matrix .a-h b{flex:1;min-width:0;font-size:14.5px;font-weight:780;color:var(--k)}",
    ".fpc .a-swot_matrix ul{margin:0;padding-left:18px;display:grid;gap:7px}.fpc .a-swot_matrix li{font-size:13.5px;line-height:19px;font-weight:550;color:#24323a}.fpc .a-swot_matrix li::marker{color:var(--c)}",
    ".fpc .a-swot_matrix .a-c{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:44%;padding:8px 16px;border-radius:999px;background:#101d24;color:#fff;font-size:12.5px;font-weight:800;text-align:center;box-shadow:0 0 0 5px #fff}",
    "@container (max-width:560px){.fpc .a-swot_matrix .a-sw{grid-template-columns:1fr}.fpc .a-swot_matrix .a-c{display:none}.fpc .a-swot_matrix .a-hc{row-gap:12px}}",
  ].join(""),
});

/* ================================================================== fishbone_diagram */

const category = aliased({ name: text(24), causes: optList(labelled(48), 4) }, { name: ["label", "category", "title", "group"], causes: ["items", "reasons", "factors", "children", "sub_causes", "subcauses"] });
const BONE_HUES = [BLUE, GREEN, ORANGE, VIOLET];

export const fishboneDiagram = defineAsset({
  type: "fishbone_diagram", category: "diagram", width: "full",
  use: "Root-cause analysis (Ishikawa): an effect at the head, four to six cause categories as bones, each with a few short causes.",
  useKo: "문제(결과)를 머리에 두고 원인 범주 4~6개를 뼈대로, 각 범주의 세부 원인을 가지로 보여주는 인과(피시본) 다이어그램.",
  tags: ["fishbone", "ishikawa", "root cause", "cause and effect", "problem analysis", "피시본", "특성요인도", "원인 분석", "인과"],
  notes: "effect is the problem; 2-6 categories (people, process, tools, materials ...) alternate above and below the spine, each with up to 4 short causes.",
  fields: { effect: text(60), categories: list(category, 2, 6) },
  sample: { title: "Why deliveries arrive late", effect: "Late deliveries", categories: [
    { name: "People", causes: ["Short-staffed at peak", "Drivers new to routes", "Unclear hand-offs"] },
    { name: "Process", causes: ["Manual dispatch", "No buffer time", "Late order cut-off"] },
    { name: "Tools", causes: ["Routing app lags", "Scanner battery faults", "No live tracking"] },
    { name: "Environment", causes: ["Road works", "Weather delays", "Parking limits"] },
    { name: "Materials", causes: ["Damaged packaging", "Labels unreadable"] },
    { name: "Management", causes: ["No delay metrics", "Targets set per day", "Slow escalation"] },
  ] },
  render(b) {
    const cats = b.categories, cols = Math.ceil(cats.length / 2), maxCauses = Math.max(1, ...cats.map(c => c.causes.length));
    const RIB = 112, DX = 58, PITCH = 172, X0 = 192, DY = 40 + maxCauses * 27, LABH = 28, TOP = 12, ys = TOP + LABH + DY + 14;
    const headLines = wrap(b.effect, 128, 14, 4, true), HW = 152, HH = Math.max(64, headLines.length * 18 + 26);
    const headX = X0 + (cols - 1) * PITCH + 76, W = headX + HW + 8, H = 2 * (TOP + LABH + DY + 14) + 2;
    let out = `<path d="M14,${ys}H${headX - 8}" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/><path d="M${headX - 18},${ys - 8}L${headX - 3},${ys}L${headX - 18},${ys + 8}Z" fill="${INK}"/>`;
    cats.forEach((c, i) => {
      const up = i % 2 === 0, dir = up ? -1 : 1, xa = X0 + Math.floor(i / 2) * PITCH, h = BONE_HUES[i % BONE_HUES.length], ox = xa - DX, oy = ys + dir * DY;
      out += `<path d="M${n(ox)},${n(oy)}L${n(xa)},${ys}" stroke="${h.solid}" stroke-width="2.6" stroke-linecap="round"/>`;
      const lw = Math.max(88, Math.min(150, tw(c.name, 12.5, true) + 28)), ly = up ? oy - LABH : oy;
      out += `<rect x="${n(ox - lw / 2)}" y="${n(ly)}" width="${n(lw)}" height="${LABH}" rx="${LABH / 2}" fill="${h.solid}"/>${txt(ox, ly + LABH / 2, [fit(c.name, lw - 20, 12.5, true)], { size: 12.5, weight: 750, fill: WHITE, anchor: "middle" })}`;
      const m = c.causes.length;
      c.causes.forEach((cause, j) => {
        const t = m === 1 ? 0.5 : 0.17 + (0.62 * j) / (m - 1), bx = xa - DX * t, by = ys + dir * DY * t, lines = wrap(cause, RIB - 6, 11.5, 2);
        out += `<path d="M${n(bx)},${n(by)}H${n(bx - RIB)}" stroke="${h.solid}" stroke-opacity=".55" stroke-width="1.5" stroke-linecap="round"/><circle cx="${n(bx)}" cy="${n(by)}" r="2.6" fill="${h.solid}"/>`;
        out += txt(bx - RIB + 2, by + dir * (4 + (lines.length * 13) / 2) , lines, { size: 11.5, weight: 550, fill: INK2, lh: 13 });
      });
    });
    out += `<rect x="${headX}" y="${n(ys - HH / 2)}" width="${HW}" height="${HH}" rx="16" fill="${INK}"/>${txt(headX + HW / 2, ys, headLines, { size: 14, weight: 800, fill: WHITE, anchor: "middle", lh: 18 })}`;
    return svg(W, H, out, { title: b.title });
  },
  summary: b => `${b.title ?? "Fishbone"}: effect "${b.effect}". Causes by category: ${b.categories.map(c => `${c.name}${c.causes.length ? ` (${c.causes.join(", ")})` : ""}`).join("; ")}.`.slice(0, 400),
  css: baseCss("fishbone_diagram"),
});

export const ASSETS: readonly AnyAsset[] = [vennDiagram, quadrantMatrix, pyramidDiagram, swotMatrix, fishboneDiagram];
