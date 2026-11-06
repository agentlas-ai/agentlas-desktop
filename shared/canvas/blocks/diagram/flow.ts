import { z } from "zod";
import { esc } from "../../kit";
import { list, loose, optionalNum, optionalText, text, tone } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { C, TONE, arrow, clamp, cleanEdges, f, finder, edgeTone, layout, lines, pill, placeLabels, rank, rounded, sentence, shell, shellCss, tw, uniqueBy, wrap, type Box, type Pt } from "./_graph";

const even = (v: number) => Math.round(v / 2) * 2;

/* ===================================================== flowchart ===================================================== */
const KINDS = ["step", "start", "end", "decision", "io", "note"] as [string, ...string[]];
const kind = loose(KINDS, { process: "step", action: "step", task: "step", begin: "start", terminator: "end", terminal: "end", stop: "end", finish: "end", condition: "decision", branch: "decision", if: "decision", gateway: "decision", choice: "decision", input: "io", output: "io", data: "io", document: "io", comment: "note", annotation: "note", remark: "note" }, "step").optional();
const direction = loose(["tb", "lr"] as [string, ...string[]], { td: "tb", top_down: "tb", top_to_bottom: "tb", down: "tb", vertical: "tb", lr: "lr", left_to_right: "lr", right: "lr", horizontal: "lr" }, "tb").optional();

interface Shape { k: string; t: ReturnType<typeof wrap>; w: number; h: number; size: number; weight: number }
function shapeOf(k: string, label: string, cap: number): Shape {
  if (k === "decision") { const t = wrap(label, Math.min(cap, 104), 3, 12, true); return { k, t, size: 12, weight: 700, w: even(Math.max(116, t.width / 0.6 + 8)), h: even(Math.max(64, (t.lines.length * 15) / 0.46 + 6)) }; }
  if (k === "start" || k === "end") { const t = wrap(label, cap, 2, 12.5, true); return { k, t, size: 12.5, weight: 700, w: even(Math.max(92, t.width + 40)), h: even(Math.max(38, t.lines.length * 16 + 18)) }; }
  if (k === "io") { const t = wrap(label, cap, 3, 12.5, true); return { k, t, size: 12.5, weight: 650, w: even(Math.max(100, t.width + 58)), h: even(Math.max(42, t.lines.length * 16 + 22)) }; }
  if (k === "note") { const t = wrap(label, cap, 3, 11.5); return { k, t, size: 11.5, weight: 500, w: even(Math.max(90, t.width + 30)), h: even(Math.max(36, t.lines.length * 15 + 18)) }; }
  const t = wrap(label, cap, 3, 12.5, true);
  return { k: "step", t, size: 12.5, weight: 650, w: even(Math.max(96, t.width + 30)), h: even(Math.max(42, t.lines.length * 16 + 22)) };
}
/** One flowchart node: the shape for its kind with its text. */
function drawNode(s: Shape, cx: number, cy: number): string {
  const x = cx - s.w / 2, y = cy - s.h / 2, w = s.w, h = s.h;
  const txt = (fill = C.ink) => lines(s.t.lines, cx, cy, { size: s.size, weight: s.weight, fill });
  switch (s.k) {
    case "start": return `<rect x="${f(x)}" y="${f(y)}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.ink}"/>${txt(C.white)}`;
    case "end": return `<rect x="${f(x + 1)}" y="${f(y + 1)}" width="${w - 2}" height="${h - 2}" rx="${(h - 2) / 2}" fill="${C.white}" stroke="${C.ink}" stroke-width="2"/>${txt()}`;
    case "decision": return `<path d="M${f(cx)},${f(y)}L${f(x + w)},${f(cy)}L${f(cx)},${f(y + h)}L${f(x)},${f(cy)}Z" fill="${C.aT}" stroke="${C.amber2}" stroke-width="1.6" stroke-linejoin="round"/>${txt()}`;
    case "io": { const k = 10; return `<path d="M${f(x + k)},${f(y)}L${f(x + w)},${f(y)}L${f(x + w - k)},${f(y + h)}L${f(x)},${f(y + h)}Z" fill="${C.bT}" stroke="${C.blue2}" stroke-width="1.6" stroke-linejoin="round"/>${txt()}`; }
    case "note": { const k = 10; return `<path d="M${f(x)},${f(y)}L${f(x + w - k)},${f(y)}L${f(x + w)},${f(y + k)}L${f(x + w)},${f(y + h)}L${f(x)},${f(y + h)}Z" fill="${C.surface}" stroke="${C.faint}" stroke-width="1.3" stroke-dasharray="4 3" stroke-linejoin="round"/><path d="M${f(x + w - k)},${f(y)}L${f(x + w - k)},${f(y + k)}L${f(x + w)},${f(y + k)}" fill="none" stroke="${C.faint}" stroke-width="1.3"/>${txt(C.muted)}`; }
    default: return `<rect x="${f(x)}" y="${f(y + 2)}" width="${w}" height="${h}" rx="10" fill="${C.line}"/><rect x="${f(x)}" y="${f(y)}" width="${w}" height="${h}" rx="10" fill="${C.white}" stroke="#c5cdc9" stroke-width="1.5"/>${txt()}`;
  }
}

export const flowchart = defineAsset({
  type: "flowchart", category: "diagram", width: "full",
  use: "A process or decision flow as boxes and arrows: steps, yes/no decisions, inputs and outputs, merging and looping back.",
  useKo: "처리 절차나 의사결정 흐름을 상자와 화살표로 그립니다(단계, 예/아니오 분기, 입출력, 합류와 되돌아가기).",
  tags: ["flowchart", "flow", "process", "decision", "workflow", "steps", "branch", "순서도", "흐름도", "프로세스", "분기", "절차"],
  notes: "At most 14 nodes and 24 edges. Kinds: start, step, decision, io, end, note. Edges name node ids; without edges the nodes are chained in order. An edge may carry tone (up green, down red, warn, info) to colour its label, e.g. up for a yes branch; no tone is neutral. direction: tb (default) or lr.",
  fields: {
    nodes: list(z.object({ id: text(24), label: text(80), kind }).strip(), 2, 14),
    edges: list(z.object({ from: text(24), to: text(24), label: optionalText(24), tone: tone.optional() }).strip(), 0, 24).default([]),
    direction,
  },
  sample: {
    title: "Order fulfilment",
    direction: "tb",
    nodes: [
      { id: "placed", label: "Order placed", kind: "start" }, { id: "pay", label: "Validate payment", kind: "step" }, { id: "paid", label: "Payment approved?", kind: "decision" },
      { id: "stock", label: "Items in stock?", kind: "decision" }, { id: "pack", label: "Pick and pack", kind: "step" }, { id: "ship", label: "Ship with tracking", kind: "step" },
      { id: "done", label: "Delivered", kind: "end" }, { id: "back", label: "Create backorder", kind: "step" }, { id: "decline", label: "Email decline notice", kind: "io" },
      { id: "cancel", label: "Order cancelled", kind: "end" }, { id: "note", label: "Restock takes 3–5 days", kind: "note" },
    ],
    edges: [
      { from: "placed", to: "pay" }, { from: "pay", to: "paid" }, { from: "paid", to: "stock", label: "Yes", tone: "up" }, { from: "paid", to: "decline", label: "No", tone: "down" }, { from: "decline", to: "cancel" },
      { from: "stock", to: "pack", label: "Yes", tone: "up" }, { from: "stock", to: "back", label: "No", tone: "down" }, { from: "back", to: "pack", label: "Restocked" }, { from: "pack", to: "ship" }, { from: "ship", to: "done" }, { from: "back", to: "note" },
    ],
  },
  render(b, { uid }) {
    const nodes = uniqueBy(b.nodes), edges = cleanEdges(nodes.length, b.edges, finder(nodes)), tb = b.direction !== "lr", rk = rank(nodes.length, edges);
    const cap = tb ? clamp(Math.floor((820 - (rk.widest - 1) * 30) / rk.widest) - 30, 88, 150) : clamp(Math.floor((820 - (rk.count - 1) * 64) / rk.count) - 30, 88, 150);
    const shapes = nodes.map(n => shapeOf(n.kind ?? "step", n.label, cap));
    const labels = edges.map(e => (e.label ? pill(0, 0, e.label, { maxW: 100 }) : null));
    const g = layout(shapes.map(s => ({ w: s.w, h: s.h, diamond: s.k === "decision" })), edges.map((e, i) => ({ from: e.from, to: e.to, lw: labels[i]?.w ?? 0, lh: 18 })), rk, { dir: tb ? "tb" : "lr", rankGap: tb ? 46 : 54, nodeGap: tb ? 30 : 26, margin: 14 });
    const paths = edges.map((e, i) => {
      const note = shapes[e.from].k === "note" || shapes[e.to].k === "note", d = rounded(g.routes[i].pts, 10);
      return d ? `<path d="${d}" fill="none" stroke="${note ? C.faint : C.edge}" stroke-width="${note ? 1.3 : 1.7}"${note ? ' stroke-dasharray="4 4"' : ` marker-end="url(#${uid}h)"`}/>` : "";
    }).join("");
    const chips = edges.map((e, i) => { const at = g.routes[i].label; if (!e.label || !at) return ""; const t = edgeTone(e.tone); return pill(at[0], at[1], e.label, { ...t, maxW: 100 }).svg; }).join("");
    const body = `${paths}${shapes.map((s, i) => drawNode(s, g.pos[i][0], g.pos[i][1])).join("")}${chips}`;
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${shell(uid, g.width, g.height, arrow(`${uid}h`, C.edge), body)}`;
  },
  summary(b) {
    const nodes = uniqueBy(b.nodes), edges = cleanEdges(nodes.length, b.edges, finder(nodes)), rk = rank(nodes.length, edges);
    const order = nodes.map((_, i) => i).sort((a, c) => rk.layer[a] - rk.layer[c] || a - c);
    const walk = order.map(i => { const outs = edges.filter(e => e.from === i); return `${nodes[i].label}${outs.length ? ` → ${outs.map(e => `${e.label ? `${e.label}: ` : ""}${nodes[e.to].label}`).join(", ")}` : ""}`; });
    return sentence([`${b.title ?? "Flowchart"}, ${b.direction === "lr" ? "left to right" : "top to bottom"}:`, `${walk.join("; ")}.`]);
  },
  css: shellCss("flowchart"),
});


/* ===================================================== swimlane_diagram ===================================================== */
const laneField = z.preprocess(v => (typeof v === "string" ? { name: v } : v), z.object({ id: optionalText(20), name: text(28) }).strip());
const stepKind = loose(["step", "decision", "start", "end"] as [string, ...string[]], { process: "step", action: "step", task: "step", condition: "decision", gateway: "decision", branch: "decision", begin: "start", stop: "end", finish: "end", terminal: "end" }, "step").optional();
const LANE_TONES = ["info", "up", "warn"];

export const swimlaneDiagram = defineAsset({
  type: "swimlane_diagram", category: "diagram", width: "full",
  use: "A process split by who does each step: horizontal lanes for the actors, steps placed along a time axis, arrows that cross lanes at each hand-off.",
  useKo: "누가 어떤 단계를 맡는지 담당자별 가로 레인으로 나누고, 시간 순서대로 단계와 인계 화살표를 그립니다.",
  tags: ["swimlane", "lanes", "actors", "handoff", "responsibility", "process", "workflow", "스윔레인", "레인", "역할", "담당", "인계", "업무 흐름"],
  notes: "2-5 lanes, at most 14 steps. A step names its lane (by name) and may set at (the time column, 1-based); without at the columns follow the links. Without links the steps are chained in order. A link may carry tone (up green, down red, warn, info) to colour its label; no tone is neutral.",
  fields: {
    lanes: list(laneField, 2, 5),
    steps: list(z.object({ id: text(24), lane: text(28), label: text(60), kind: stepKind, at: optionalNum }).strip(), 2, 14),
    links: list(z.object({ from: text(24), to: text(24), label: optionalText(20), tone: tone.optional() }).strip(), 0, 24).default([]),
  },
  sample: {
    title: "Support ticket hand-offs",
    lanes: [{ name: "Customer" }, { name: "Support agent" }, { name: "Engineering" }],
    steps: [
      { id: "submit", lane: "Customer", label: "Submit ticket", kind: "start" }, { id: "triage", lane: "Support agent", label: "Triage and classify" }, { id: "bug", lane: "Support agent", label: "Needs a code fix?", kind: "decision" },
      { id: "reply", lane: "Support agent", label: "Send workaround" }, { id: "fix", lane: "Engineering", label: "Reproduce and patch" }, { id: "review", lane: "Engineering", label: "Review and release" },
      { id: "confirm", lane: "Support agent", label: "Confirm fix with customer" }, { id: "closed", lane: "Customer", label: "Ticket closed", kind: "end" },
    ],
    links: [
      { from: "submit", to: "triage" }, { from: "triage", to: "bug" }, { from: "bug", to: "reply", label: "No", tone: "down" }, { from: "bug", to: "fix", label: "Yes", tone: "up" }, { from: "fix", to: "review" },
      { from: "review", to: "confirm" }, { from: "reply", to: "closed" }, { from: "confirm", to: "closed" },
    ],
  },
  render(b, { uid, T }) {
    const laneOf = (ref: string) => { const k = ref.trim().toLowerCase(), i = b.lanes.findIndex(l => l.name.trim().toLowerCase() === k || (l.id ?? "").trim().toLowerCase() === k); return i < 0 ? 0 : i; };
    const steps = uniqueBy(b.steps), lane = steps.map(s => laneOf(s.lane)), edges = cleanEdges(steps.length, b.links, finder(steps)), rk = rank(steps.length, edges);
    let col = steps.map((s, i) => (typeof s.at === "number" ? Math.max(0, Math.min(13, Math.round(s.at) - 1)) : rk.layer[i]));
    for (let pass = 0; pass < 80; pass++) {
      let moved = false;
      edges.forEach((e, i) => { if (!rk.rev[i] && col[e.to] <= col[e.from]) { col[e.to] = col[e.from] + 1; moved = true; } });
      steps.forEach((_, i) => { for (let j = 0; j < i; j++) if (lane[j] === lane[i] && col[j] === col[i]) { col[i]++; moved = true; } });
      if (!moved) break;
    }
    const used = [...new Set(col)].sort((a, c) => a - c); col = col.map(c => used.indexOf(c));
    const C_ = Math.max(1, used.length), HEAD = 112, TOP = 30, colW = clamp(Math.floor((1000 - HEAD - 16) / C_), 116, 168), W = HEAD + C_ * colW + 16, nodeW = colW - 38;
    const shapes = steps.map(s => {
      const k = s.kind ?? "step";
      if (k === "decision") { const t = wrap(s.label, nodeW * 0.62, 3, 11, true); return { k, t, h: even(Math.max(64, (t.lines.length * 14) / 0.5 + 8)), size: 11 }; }
      if (k === "start" || k === "end") { const t = wrap(s.label, nodeW - 20, 2, 11.5, true); return { k, t, h: even(Math.max(34, t.lines.length * 15 + 16)), size: 11.5 }; }
      const t = wrap(s.label, nodeW - 14, 3, 11.5, true); return { k: "step", t, h: even(Math.max(40, t.lines.length * 15 + 18)), size: 11.5 };
    });
    const laneH = b.lanes.map((_, l) => Math.max(82, ...steps.map((_s, i) => (lane[i] === l ? shapes[i].h + 36 : 0)))), laneTop: number[] = [];
    laneH.reduce((at, h, l) => { laneTop[l] = at; return at + h; }, TOP);
    const H = TOP + laneH.reduce((a, h) => a + h, 0) + 2, cx = (c: number) => HEAD + c * colW + colW / 2, cy = (l: number) => laneTop[l] + laneH[l] / 2;
    const X = steps.map((_, i) => cx(col[i])), Y = steps.map((_, i) => cy(lane[i]));
    const between = (l: number, c1: number, c2: number) => steps.some((_, i) => lane[i] === l && col[i] > Math.min(c1, c2) && col[i] < Math.max(c1, c2));
    const route = (e: { from: number; to: number }, off: (key: string) => number): Pt[] => {
      const u = e.from, v = e.to, cu = col[u], cv = col[v], lu = lane[u], lv = lane[v], uR = X[u] + nodeW / 2, vL = X[v] - nodeW / 2;
      const after = (c: number) => cx(c) + colW / 2 + off(`g${c}`), before = (c: number) => cx(c) - colW / 2 + off(`g${c - 1}`);
      const margin = lv > lu ? laneTop[lu] + laneH[lu] - 9 : laneTop[lu] + 9;
      if (cv > cu) {
        if (lu === lv) {
          if (!between(lu, cu, cv)) return [[uR, Y[u]], [vL, Y[v]]];
          const yt = laneTop[lu] + 9 + off(`t${lu}`), g1 = after(cu), g2 = before(cv); return [[uR, Y[u]], [g1, Y[u]], [g1, yt], [g2, yt], [g2, Y[v]], [vL, Y[v]]];
        }
        if (!between(lu, cu, cv)) { const g = before(cv); return [[uR, Y[u]], [g, Y[u]], [g, Y[v]], [vL, Y[v]]]; }
        if (!between(lv, cu, cv)) { const g = after(cu); return [[uR, Y[u]], [g, Y[u]], [g, Y[v]], [vL, Y[v]]]; }
        const g1 = after(cu), g2 = before(cv), ym = margin + off(`m${lu}`); return [[uR, Y[u]], [g1, Y[u]], [g1, ym], [g2, ym], [g2, Y[v]], [vL, Y[v]]];
      }
      if (cv === cu && lu !== lv && !steps.some((_, i) => col[i] === cu && lane[i] > Math.min(lu, lv) && lane[i] < Math.max(lu, lv))) return [[X[u], Y[u] + (lv > lu ? shapes[u].h / 2 : -shapes[u].h / 2)], [X[v], Y[v] + (lv > lu ? -shapes[v].h / 2 : shapes[v].h / 2)]];
      const g1 = after(cu), ym = (lu === lv ? laneTop[lu] + 9 : margin) + off(`m${lu}`);
      return [[uR, Y[u]], [g1, Y[u]], [g1, ym], [X[v], ym], [X[v], Y[v] + (lu === lv || lv > lu ? -shapes[v].h / 2 : shapes[v].h / 2)]];
    };
    const uses = new Map<string, number>(), seen = new Map<string, number>();
    edges.forEach(e => route(e, k => { uses.set(k, (uses.get(k) ?? 0) + 1); return 0; }));
    const paths = edges.map(e => route(e, k => { const n = uses.get(k) ?? 1, i = seen.get(k) ?? 0; seen.set(k, i + 1); return n < 2 ? 0 : clamp((i - (n - 1) / 2) * 7, -11, 11); }));
    const chipSizes = edges.map(e => (e.label ? { w: pill(0, 0, e.label, { maxW: 100 }).w, h: 18 } : null));
    const boxes: Box[] = steps.map((_, i) => ({ x0: X[i] - nodeW / 2, y0: Y[i] - shapes[i].h / 2, x1: X[i] + nodeW / 2, y1: Y[i] + shapes[i].h / 2 }));
    const at = placeLabels(paths, chipSizes, boxes, edges.map(() => false));
    const bands = b.lanes.map((l, i) => {
      const t = TONE[LANE_TONES[i % 3]], y = laneTop[i], h = laneH[i], head = wrap(l.name, HEAD - 34, 3, 12, true);
      return `<rect x="0" y="${f(y)}" width="${W}" height="${h}" fill="${i % 2 ? "#fbfbfa" : "#f5f7f6"}"/><rect x="0" y="${f(y)}" width="${HEAD}" height="${h}" fill="${C.white}" fill-opacity=".72"/><rect x="0" y="${f(y)}" width="5" height="${h}" fill="${t.stroke}"/>${lines(head.lines, 18, y + h / 2, { size: 12, weight: 700, anchor: "start", fill: C.ink })}${i ? `<line x1="0" x2="${W}" y1="${f(y)}" y2="${f(y)}" stroke="${C.line}"/>` : ""}`;
    }).join("");
    const axis = `<line x1="${HEAD + 6}" x2="${W - 10}" y1="15" y2="15" stroke="${C.faint}" stroke-width="1.3" marker-end="url(#${uid}o)"/>${used.map((_, c) => `<circle cx="${f(cx(c))}" cy="15" r="2.6" fill="${C.faint}"/>`).join("")}<text x="${HEAD - 12}" y="15" dy=".35em" text-anchor="end" font-size="11" font-weight="700" fill="${C.faint}">${esc(T("Time", "시간"))}</text>`;
    const nodes = steps.map((s, i) => {
      const t = TONE[LANE_TONES[lane[i] % 3]], sh = shapes[i], x = X[i], y = Y[i], w = nodeW, h = sh.h, txt = (fill = C.ink) => lines(sh.t.lines, x, y, { size: sh.size, weight: 700, fill });
      if (sh.k === "start") return `<rect x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.ink}"/>${txt(C.white)}`;
      if (sh.k === "end") return `<rect x="${f(x - w / 2 + 1)}" y="${f(y - h / 2 + 1)}" width="${w - 2}" height="${h - 2}" rx="${(h - 2) / 2}" fill="${C.white}" stroke="${C.ink}" stroke-width="2"/>${txt()}`;
      if (sh.k === "decision") return `<path d="M${f(x)},${f(y - h / 2)}L${f(x + w / 2)},${f(y)}L${f(x)},${f(y + h / 2)}L${f(x - w / 2)},${f(y)}Z" fill="${t.fill}" stroke="${t.stroke}" stroke-width="1.6" stroke-linejoin="round"/>${txt()}`;
      return `<rect x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${w}" height="${h}" rx="9" fill="${t.fill}" stroke="${t.stroke}" stroke-width="1.5"/>${txt()}`;
    }).join("");
    const strokes = paths.map(d => `<path d="${rounded(d, 9)}" fill="none" stroke="${C.edge}" stroke-width="1.6" marker-end="url(#${uid}h)"/>`).join("");
    const chips = edges.map((e, i) => (e.label && at[i] ? pill(at[i]![0], at[i]![1], e.label, { ...edgeTone(e.tone), maxW: 100 }).svg : "")).join("");
    const body = `<g clip-path="url(#${uid}k)">${bands}${axis}</g><rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${C.line}"/>${strokes}${nodes}${chips}`;
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${shell(uid, W, H, `${arrow(`${uid}h`, C.edge)}${arrow(`${uid}o`, C.faint, true)}<clipPath id="${uid}k"><rect width="${W}" height="${H}" rx="12"/></clipPath>`, body)}`;
  },
  summary(b) {
    const steps = uniqueBy(b.steps), laneOf = (ref: string) => { const k = ref.trim().toLowerCase(), i = b.lanes.findIndex(l => l.name.trim().toLowerCase() === k || (l.id ?? "").trim().toLowerCase() === k); return i < 0 ? 0 : i; };
    const edges = cleanEdges(steps.length, b.links, finder(steps)), hand = edges.filter(e => laneOf(steps[e.from].lane) !== laneOf(steps[e.to].lane));
    return sentence([`${b.title ?? "Swimlane diagram"}: ${b.lanes.map(l => l.name).join(", ")}.`, ...b.lanes.map((l, i) => `${l.name} does ${steps.filter(s => laneOf(s.lane) === i).map(s => s.label).join(", ") || "nothing"}.`), hand.length ? `Hand-offs: ${hand.map(e => `${steps[e.from].label} to ${steps[e.to].label}`).join("; ")}.` : ""]);
  },
  css: shellCss("swimlane_diagram"),
});

/* ===================================================== sequence_diagram ===================================================== */
const msgKind = loose(["call", "return", "async", "self"] as [string, ...string[]], { sync: "call", request: "call", reply: "return", response: "return", dashed: "return", event: "async", message: "async", signal: "async", loop: "self" }, "call").optional();
const partField = z.preprocess(v => (typeof v === "string" ? { name: v } : v), z.object({ id: optionalText(20), name: text(26) }).strip());

export const sequenceDiagram = defineAsset({
  type: "sequence_diagram", category: "diagram", width: "full",
  use: "Who sends what to whom, in order: participants with lifelines and messages (calls, returns, async signals, self calls), with optional notes and activation bars.",
  useKo: "참여자와 생명선, 호출·응답·비동기·자기 호출 메시지를 순서대로 그려 누가 누구에게 무엇을 보내는지 보여줍니다(메모와 활성 막대 포함).",
  tags: ["sequence", "sequence diagram", "messages", "lifeline", "api", "request response", "interaction", "시퀀스", "시퀀스 다이어그램", "메시지", "호출", "응답", "통신"],
  notes: "2-6 participants, at most 18 messages in order. kind: call (default), return (dashed), async, self. A message may carry a note shown under it. Messages naming an unknown participant are ignored.",
  fields: {
    participants: list(partField, 2, 6),
    messages: list(z.object({ from: text(26), to: text(26), label: text(70), kind: msgKind, note: optionalText(80) }).strip(), 1, 18),
    activations: z.boolean().optional(),
  },
  sample: {
    title: "Checkout and payment",
    participants: [{ name: "Customer" }, { name: "Web app" }, { name: "Payments" }, { name: "Warehouse" }],
    messages: [
      { from: "Customer", to: "Web app", label: "Place order" }, { from: "Web app", to: "Payments", label: "Authorise card" }, { from: "Payments", to: "Web app", label: "Authorised", kind: "return" },
      { from: "Web app", to: "Warehouse", label: "Reserve items", kind: "async" }, { from: "Warehouse", to: "Warehouse", label: "Check stock levels", kind: "self", note: "Stock is held for 15 minutes" },
      { from: "Warehouse", to: "Web app", label: "Items reserved", kind: "return" }, { from: "Web app", to: "Customer", label: "Order confirmation", kind: "return" },
    ],
  },
  render(b, { uid }) {
    const parts = b.participants, n = parts.length, find = (ref: string) => parts.findIndex(p => [p.name, p.id ?? ""].some(k => k.trim().toLowerCase() === ref.trim().toLowerCase()));
    const msgs = b.messages.map(m => ({ ...m, a: find(m.from), z: find(m.to) })).filter(m => m.a >= 0 && m.z >= 0).map(m => ({ ...m, k: m.a === m.z ? "self" : m.kind === "self" ? "call" : (m.kind ?? "call") }));
    const colW = clamp(Math.floor(840 / n), 150, 230), lastSelf = msgs.some(m => m.k === "self" && m.a === n - 1), W = n * colW + 48 + (lastSelf ? 96 : 0), lx = (i: number) => 24 + colW / 2 + i * colW;
    const heads = parts.map(p => wrap(p.name, Math.min(colW - 30, 160) - 20, 2, 12.5, true)), HH = Math.max(38, ...heads.map(h => h.lines.length * 16 + 20)), hw = Math.min(colW - 22, 168);
    let y = 8 + HH + 30;
    const rows = msgs.map(m => {
      const note = m.note ? wrap(m.note, Math.min(colW * 1.5, 250) - 22, 3, 11.5) : null;
      let row: { m: typeof m; t: ReturnType<typeof wrap>; top: number; y: number; loop: number; noteTop: number; note: ReturnType<typeof wrap> | null; arrowY: number };
      if (m.k === "self") {
        const t = wrap(m.label, i1(m.a, n, colW), 2, 12, true), loop = Math.max(24, t.lines.length * 14 + 4), top = y; y += loop + 18;
        row = { m, t, top, y: top, loop, noteTop: 0, note, arrowY: top };
      } else {
        const span = Math.abs(lx(m.z) - lx(m.a)), t = wrap(m.label, span - 22, 2, 12, true), top = y, arrowY = top + t.lines.length * 14 + 8; y = arrowY + 18;
        row = { m, t, top, y: arrowY, loop: 0, noteTop: 0, note, arrowY };
      }
      if (note) { row.noteTop = y + 2; y += note.lines.length * 15 + 14 + 16; }
      return row;
    });
    const H = y + 10;
    // activation bars: a call opens one on its target, a return from that participant closes it
    type Bar = { p: number; y0: number; y1: number; depth: number };
    const bars: Bar[] = [], open: Bar[][] = parts.map(() => []);
    if (b.activations !== false) {
      rows.forEach(r => {
        if (r.m.k === "call") { const bar = { p: r.m.z, y0: r.arrowY, y1: H - 20, depth: open[r.m.z].length }; open[r.m.z].push(bar); bars.push(bar); }
        else if (r.m.k === "return") { const bar = open[r.m.a].pop(); if (bar) bar.y1 = r.arrowY; }
      });
    }
    const edgeX = (p: number, yy: number, toward: number) => { const ds = bars.filter(x => x.p === p && yy >= x.y0 - 0.5 && yy <= x.y1 + 0.5).map(x => x.depth); return ds.length ? lx(p) + toward * (5 + (Math.max(...ds)) * 4.5) : lx(p); };
    const lifelines = parts.map((_, i) => `<line x1="${f(lx(i))}" x2="${f(lx(i))}" y1="${8 + HH}" y2="${f(H - 12)}" stroke="${C.soft}" stroke-width="1.4" stroke-dasharray="5 5"/>`).join("");
    const barSvg = bars.map(x => `<rect x="${f(lx(x.p) - 4.5 + x.depth * 4.5)}" y="${f(x.y0 - 2)}" width="9" height="${f(Math.max(10, x.y1 - x.y0 + 6))}" rx="2.5" fill="${C.bT}" stroke="${C.blue2}" stroke-width="1.2"/>`).join("");
    const arrows = rows.map(r => {
      const { m, t } = r, color = m.k === "async" ? C.blue : m.k === "return" ? "#7a8690" : C.ink2, mk = m.k === "async" ? "a" : m.k === "return" ? "r" : "c", dash = m.k === "return" ? ' stroke-dasharray="5 4"' : "";
      if (m.k === "self") { const x0 = edgeX(m.a, r.top + 2, 1), d = rounded([[x0, r.top + 2], [x0 + 30, r.top + 2], [x0 + 30, r.top + r.loop], [x0 + 1, r.top + r.loop]], 8); return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" marker-end="url(#${uid}c)"/>${lines(t.lines, x0 + 40, r.top + r.loop / 2 + 1, { size: 12, weight: 650, anchor: "start", fill: C.ink })}`; }
      const dir = m.z > m.a ? 1 : -1, x0 = edgeX(m.a, r.arrowY, dir), x1 = edgeX(m.z, r.arrowY, -dir);
      return `<line x1="${f(x0)}" x2="${f(x1)}" y1="${f(r.arrowY)}" y2="${f(r.arrowY)}" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#${uid}${mk})"/>${lines(t.lines, (lx(m.a) + lx(m.z)) / 2, r.top + (t.lines.length * 14) / 2, { size: 12, weight: m.k === "return" ? 550 : 650, fill: m.k === "async" ? C.blue : m.k === "return" ? C.muted : C.ink, lh: 14, halo: true })}`;
    }).join("");
    const notes = rows.map(r => {
      if (!r.note) return "";
      const nw = Math.max(110, r.note.width + 22), h = r.note.lines.length * 15 + 14, x = Math.min(W - 8 - nw, Math.max(8, lx(r.m.z) - nw / 2)), k = 9;
      return `<path d="M${f(x)},${f(r.noteTop)}L${f(x + nw - k)},${f(r.noteTop)}L${f(x + nw)},${f(r.noteTop + k)}L${f(x + nw)},${f(r.noteTop + h)}L${f(x)},${f(r.noteTop + h)}Z" fill="${C.aT}" stroke="${C.amber2}" stroke-width="1.2" stroke-linejoin="round"/>${lines(r.note.lines, x + nw / 2, r.noteTop + h / 2, { size: 11.5, weight: 550, fill: C.ink2 })}`;
    }).join("");
    const headSvg = parts.map((p, i) => `<rect x="${f(lx(i) - hw / 2)}" y="${10}" width="${hw}" height="${HH}" rx="10" fill="${C.line}"/><rect x="${f(lx(i) - hw / 2)}" y="8" width="${hw}" height="${HH}" rx="10" fill="${C.white}" stroke="#c5cdc9" stroke-width="1.5"/>${lines(heads[i].lines, lx(i), 8 + HH / 2, { size: 12.5, weight: 700 })}`).join("");
    const defs = `${arrow(`${uid}c`, C.ink2)}${arrow(`${uid}r`, "#7a8690", true)}${arrow(`${uid}a`, C.blue, true)}`;
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${shell(uid, W, H, defs, `${lifelines}${barSvg}${arrows}${notes}${headSvg}`)}`;
  },
  summary(b) {
    const parts = b.participants, find = (ref: string) => parts.findIndex(p => [p.name, p.id ?? ""].some(k => k.trim().toLowerCase() === ref.trim().toLowerCase()));
    const msgs = b.messages.filter(m => find(m.from) >= 0 && find(m.to) >= 0);
    return sentence([`${b.title ?? "Sequence diagram"} between ${parts.map(p => p.name).join(", ")}:`, ...msgs.map((m, i) => `${i + 1}. ${m.from === m.to ? `${m.from} (self)` : `${m.from} to ${m.to}`}: ${m.label}${m.note ? ` (${m.note})` : ""}.`)]);
  },
  css: shellCss("sequence_diagram"),
});
/** Room for a self message's label to the right of its lifeline (more beside the last participant, which has no neighbour). */
const i1 = (i: number, n: number, colW: number) => (i === n - 1 ? 110 : colW - 62);

/* ===================================================== state_diagram ===================================================== */
const stateKind = loose(["normal", "initial", "final"] as [string, ...string[]], { state: "normal", start: "initial", begin: "initial", entry: "initial", end: "final", stop: "final", terminal: "final", exit: "final" }, "normal").optional();

export const stateDiagram = defineAsset({
  type: "state_diagram", category: "diagram", width: "full",
  use: "A lifecycle as states and the transitions between them: an initial dot, named states, final states, labelled transitions and self-loops.",
  useKo: "상태와 상태 전이를 그려 수명주기를 보여줍니다(시작점, 상태, 종료 상태, 전이 조건, 자기 전이).",
  tags: ["state", "state machine", "lifecycle", "transition", "status", "fsm", "상태", "상태도", "상태 전이", "수명주기", "라이프사이클"],
  notes: "At most 12 states and 24 transitions. kind: normal, initial (a dot, no label) or final. tone colours a state (up, down, warn, info). A transition may carry tone too, to colour its label. A transition with the same from and to is a self-loop. direction: lr (default) or tb.",
  fields: {
    states: list(z.object({ id: text(24), label: optionalText(40), kind: stateKind, tone: tone.optional() }).strip(), 2, 12),
    transitions: list(z.object({ from: text(24), to: text(24), label: optionalText(30), tone: tone.optional() }).strip(), 0, 24).default([]),
    direction,
  },
  sample: {
    title: "Order lifecycle",
    direction: "lr",
    states: [
      { id: "start", kind: "initial" }, { id: "created", label: "Created" }, { id: "paid", label: "Paid", tone: "info" }, { id: "packed", label: "Packed" }, { id: "shipped", label: "Shipped" },
      { id: "delivered", label: "Delivered", kind: "final", tone: "up" }, { id: "cancelled", label: "Cancelled", kind: "final", tone: "down" }, { id: "refunded", label: "Refunded", kind: "final", tone: "warn" },
    ],
    transitions: [
      { from: "start", to: "created" }, { from: "created", to: "paid", label: "payment captured" }, { from: "created", to: "cancelled", label: "customer cancels" }, { from: "paid", to: "packed", label: "stock picked" },
      { from: "paid", to: "refunded", label: "refund requested" }, { from: "packed", to: "shipped", label: "carrier pickup" }, { from: "shipped", to: "shipped", label: "tracking update" }, { from: "shipped", to: "delivered", label: "signed for" },
    ],
  },
  render(b, { uid }) {
    const states = uniqueBy(b.states), find = finder(states.map(s => ({ id: s.id, label: s.label }))), all = cleanEdges(states.length, b.transitions, find, { loops: true, join: true }), tb = b.direction === "tb";
    const edges = all.filter(e => e.from !== e.to), loops = new Map<number, string | undefined>(); all.forEach(e => { if (e.from === e.to) loops.set(e.from, e.label); });
    const rk = rank(states.length, edges), cap = tb ? clamp(Math.floor((820 - (rk.widest - 1) * 40) / rk.widest) - 32, 80, 130) : clamp(Math.floor((820 - (rk.count - 1) * 80) / rk.count) - 32, 78, 130);
    const sh = states.map((s, i) => {
      const k = s.kind ?? "normal", label = s.label ?? s.id, pad = loops.has(i) ? (tb ? 30 + Math.min(tw(loops.get(i) ?? "", 11, true) + 14, 96) : 50) : 0;
      if (k === "initial") return { k, w: 18, h: 18, t: wrap("", 10, 1), pad };
      if (k === "final" && !s.label) return { k, w: 26, h: 26, t: wrap("", 10, 1), pad };
      const t = wrap(label, cap, 2, 12.5, true); return { k, w: even(Math.max(86, t.width + 34)), h: even(Math.max(40, t.lines.length * 16 + 22)), t, pad };
    });
    const chips = edges.map(e => (e.label ? pill(0, 0, e.label, { maxW: 118 }) : null));
    const g = layout(sh.map(s => ({ w: s.w, h: s.h, loop: s.pad })), edges.map((e, i) => ({ from: e.from, to: e.to, lw: chips[i]?.w ?? 0, lh: 18 })), rk, { dir: tb ? "tb" : "lr", rankGap: tb ? 48 : 56, nodeGap: tb ? 34 : 30, margin: 16 });
    const strokes = edges.map((_, i) => { const d = rounded(g.routes[i].pts, 10); return d ? `<path d="${d}" fill="none" stroke="${C.edge}" stroke-width="1.7" marker-end="url(#${uid}h)"/>` : ""; }).join("");
    const nodeSvg = states.map((s, i) => {
      const [x, y] = g.pos[i], d = sh[i], t = TONE[s.tone ?? "neutral"] ?? TONE.neutral;
      if (d.k === "initial") return `<circle cx="${f(x)}" cy="${f(y)}" r="9" fill="${C.ink}"/>`;
      if (d.k === "final" && !s.label) return `<circle cx="${f(x)}" cy="${f(y)}" r="12" fill="${C.white}" stroke="${s.tone && s.tone !== "neutral" ? t.stroke : C.ink}" stroke-width="2"/><circle cx="${f(x)}" cy="${f(y)}" r="6.5" fill="${s.tone && s.tone !== "neutral" ? t.stroke : C.ink}"/>`;
      const body = `<rect x="${f(x - d.w / 2)}" y="${f(y - d.h / 2 + 2)}" width="${d.w}" height="${d.h}" rx="14" fill="${C.line}"/><rect x="${f(x - d.w / 2)}" y="${f(y - d.h / 2)}" width="${d.w}" height="${d.h}" rx="14" fill="${s.tone && s.tone !== "neutral" ? t.fill : C.white}" stroke="${s.tone && s.tone !== "neutral" ? t.stroke : "#c5cdc9"}" stroke-width="1.6"/>`;
      const ring = d.k === "final" ? `<rect x="${f(x - d.w / 2 + 4)}" y="${f(y - d.h / 2 + 4)}" width="${d.w - 8}" height="${d.h - 8}" rx="10" fill="none" stroke="${s.tone && s.tone !== "neutral" ? t.stroke : "#c5cdc9"}" stroke-width="1.2"/>` : "";
      return `${body}${ring}${lines(d.t.lines, x, y, { size: 12.5, weight: 700 })}`;
    }).join("");
    const loopSvg = [...loops.entries()].map(([i, label]) => {
      const [x, y] = g.pos[i], d = sh[i];
      if (d.k === "initial") return "";
      const path = tb
        ? `M${f(x + d.w / 2)},${f(y - 9)}C${f(x + d.w / 2 + 26)},${f(y - 15)} ${f(x + d.w / 2 + 26)},${f(y + 15)} ${f(x + d.w / 2 + 1)},${f(y + 9)}`
        : `M${f(x - 9)},${f(y + d.h / 2)}C${f(x - 15)},${f(y + d.h / 2 + 26)} ${f(x + 15)},${f(y + d.h / 2 + 26)} ${f(x + 9)},${f(y + d.h / 2 + 1)}`;
      let chip = "";
      if (label) { const p = pill(0, 0, label, { maxW: 140 }); chip = tb ? pill(x + d.w / 2 + 27 + p.w / 2, y, label, { maxW: 140 }).svg : pill(x, y + d.h / 2 + 33, label, { maxW: 140 }).svg; }
      return `<path d="${path}" fill="none" stroke="${C.edge}" stroke-width="1.7" marker-end="url(#${uid}h)"/>${chip}`;
    }).join("");
    const labels = edges.map((e, i) => { const at = g.routes[i].label; return e.label && at ? pill(at[0], at[1], e.label, { ...edgeTone(e.tone), maxW: 118 }).svg : ""; }).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${shell(uid, g.width, g.height, arrow(`${uid}h`, C.edge), `${strokes}${loopSvg}${nodeSvg}${labels}`)}`;
  },
  summary(b) {
    const states = uniqueBy(b.states), find = finder(states.map(s => ({ id: s.id, label: s.label }))), name = (i: number) => (states[i].kind === "initial" ? "Start" : states[i].label ?? states[i].id), edges = cleanEdges(states.length, b.transitions, find, { loops: true, join: true });
    const start = states.findIndex(s => s.kind === "initial"), finals = states.map((s, i) => (s.kind === "final" ? name(i) : "")).filter(Boolean);
    return sentence([`${b.title ?? "State diagram"}: ${states.filter(s => s.kind !== "initial").length} states${start >= 0 ? ", starting at the initial dot" : ""}${finals.length ? `, ending in ${finals.join(" or ")}` : ""}.`, ...edges.map(e => `${e.from === e.to ? `${name(e.from)} loops` : `${name(e.from)} to ${name(e.to)}`}${e.label ? ` on ${e.label}` : ""}.`)]);
  },
  css: shellCss("state_diagram"),
});

/* ===================================================== decision_tree ===================================================== */
const treeKind = loose(["decision", "chance", "outcome"] as [string, ...string[]], { question: "decision", choice: "decision", root: "decision", option: "decision", event: "chance", uncertainty: "chance", random: "chance", probability: "chance", result: "outcome", leaf: "outcome", end: "outcome", terminal: "outcome" }, "decision").optional();
const outcomeTone = loose(["good", "neutral", "bad"] as [string, ...string[]], { up: "good", positive: "good", green: "good", success: "good", win: "good", best: "good", down: "bad", negative: "bad", red: "bad", loss: "bad", worst: "bad", warn: "neutral", mixed: "neutral", info: "neutral" }, "neutral").optional();
const OUTCOME = { good: { fill: C.gT, stroke: C.green2, ink: C.green }, neutral: { fill: C.nT, stroke: "#b9c3be", ink: C.ink2 }, bad: { fill: C.rT, stroke: C.red, ink: C.red } } as const;

export const decisionTree = defineAsset({
  type: "decision_tree", category: "diagram", width: "full",
  use: "A decision under uncertainty as a tree: a question, its options, chance branches with probabilities, and outcomes with values coloured good, neutral or bad.",
  useKo: "불확실한 상황의 의사결정을 나무로 그립니다(질문, 선택지, 확률이 붙은 분기, 좋음·보통·나쁨으로 색을 입힌 결과와 값).",
  tags: ["decision tree", "options", "probability", "expected value", "outcome", "risk", "scenario", "의사결정", "의사결정 나무", "확률", "기댓값", "선택지", "시나리오"],
  notes: "At most 14 nodes and 20 branches, read as a tree from the first node (a node keeps its first parent). Node kinds: decision, chance, outcome (a leaf is an outcome). value is the payoff text, ev the expected value, tone (good, neutral, bad) colours an outcome. A branch may carry a label, p (a probability) and best (the recommended path).",
  fields: {
    nodes: list(z.object({ id: text(24), label: text(60), kind: treeKind, value: optionalText(14), ev: optionalText(16), tone: outcomeTone }).strip(), 2, 14),
    branches: list(z.object({ from: text(24), to: text(24), label: optionalText(28), p: optionalText(8), best: z.boolean().optional() }).strip(), 1, 20),
  },
  sample: {
    title: "Launch the premium tier?",
    nodes: [
      { id: "q", label: "Launch the premium tier this quarter?", kind: "decision" }, { id: "c1", label: "Market response", kind: "chance", ev: "+$210K" }, { id: "c2", label: "Competitor move", kind: "chance", ev: "+$130K" },
      { id: "o1", label: "Strong demand", kind: "outcome", value: "+$480K", tone: "good" }, { id: "o2", label: "Mixed uptake", kind: "outcome", value: "+$120K", tone: "neutral" }, { id: "o3", label: "Weak demand", kind: "outcome", value: "−$150K", tone: "bad" },
      { id: "o4", label: "We lead the category", kind: "outcome", value: "+$200K", tone: "good" }, { id: "o5", label: "Competitor ships first", kind: "outcome", value: "+$60K", tone: "neutral" },
    ],
    branches: [
      { from: "q", to: "c1", label: "Launch now", best: true }, { from: "q", to: "c2", label: "Wait a quarter" },
      { from: "c1", to: "o1", p: "40%" }, { from: "c1", to: "o2", p: "40%" }, { from: "c1", to: "o3", p: "20%" }, { from: "c2", to: "o4", p: "50%" }, { from: "c2", to: "o5", p: "50%" },
    ],
  },
  render(b, { uid, T }) {
    const nodes = uniqueBy(b.nodes), find = finder(nodes), n = nodes.length, parent = new Array<number>(n).fill(-1);
    type Kid = { to: number; label?: string; p?: string; best?: boolean };
    const kids: Kid[][] = nodes.map(() => []);
    for (const e of b.branches) {
      const a = find(e.from), c = find(e.to);
      if (a < 0 || c < 0 || a === c || parent[c] >= 0) continue;
      let up = a, loop = false;
      while (up >= 0) { if (up === c) { loop = true; break; } up = parent[up]; }
      if (!loop) { parent[c] = a; kids[a].push({ to: c, label: e.label, p: e.p, best: e.best }); }
    }
    const depth = nodes.map((_, i) => { let d = 0, u = parent[i]; while (u >= 0 && d < n) { d++; u = parent[u]; } return d; });
    const kindOf = (i: number) => nodes[i].kind ?? (kids[i].length === 0 ? "outcome" : kids[i].every(k => k.p) ? "chance" : "decision");
    const sh = nodes.map((nd, i) => {
      const k = kindOf(i), t = wrap(nd.label, 124, 3, 12.5, true), vw = nd.value ? tw(nd.value, 13, true) : 0;
      return { k, t, vw, w: even(k === "outcome" ? Math.max(104, t.width + 28 + (nd.value ? vw + 18 : 0)) : Math.max(104, t.width + 46)), h: even(Math.max(46, t.lines.length * 16 + 22)) };
    });
    const D = Math.max(0, ...depth) + 1, colW = Array.from({ length: D }, (_, d) => Math.max(0, ...sh.filter((_s, i) => depth[i] === d).map(s => s.w)));
    sh.forEach((s, i) => { s.w = colW[depth[i]]; });
    const gap = Array.from({ length: D }, (_, d) => clamp(Math.max(0, ...nodes.flatMap((_nd, i) => (depth[i] === d + 1 ? [...kids[parent[i]].filter(k => k.to === i)] : [])).map(k => Math.max(k.label ? tw(k.label, 11.5) : 0, k.p ? tw(k.p, 10.5, true) + 14 : 0))) + 50, 84, 190));
    const x0 = [] as number[]; colW.reduce((at, w, d) => { x0[d] = at; return at + w + gap[d]; }, 14);
    const hasEv = nodes.some(nd => nd.ev), S = Math.max(...sh.map(s => s.h)) + (hasEv ? 40 : 30), y = new Array<number>(n).fill(0);
    let leaf = 0;
    const place = (i: number): void => { if (!kids[i].length) { y[i] = 14 + S / 2 + leaf++ * S; return; } kids[i].forEach(k => place(k.to)); y[i] = (y[kids[i][0].to] + y[kids[i][kids[i].length - 1].to]) / 2; };
    nodes.forEach((_, i) => { if (parent[i] < 0) place(i); });
    const W = x0[D - 1] + colW[D - 1] + 14, H = 14 + Math.max(1, leaf) * S + 4, NX = (i: number) => x0[depth[i]];
    const base: string[] = [], best: string[] = [], texts: string[] = [];
    nodes.forEach((_, i) => kids[i].forEach(k => {
      const sx = NX(i) + sh[i].w, tx = NX(k.to), xm = x0[depth[i]] + colW[depth[i]] + 16, py = y[i], cy = y[k.to];
      const d = rounded([[sx, py], [xm, py], [xm, cy], [tx, cy]], 9), line = `<path d="${d}" fill="none" stroke="${k.best ? C.green : C.edge}" stroke-width="${k.best ? 2.4 : 1.6}" marker-end="url(#${uid}${k.best ? "g" : "h"})"/>`;
      (k.best ? best : base).push(line);
      const run = tx - xm, xc = (xm + tx) / 2;
      if (k.label) texts.push(lines([wrap(k.label, run - 10, 1, 11.5).lines[0]], xc, cy - 9, { size: 11.5, weight: 600, fill: k.best ? C.green : C.ink2, halo: true }));
      if (k.p) texts.push(pill(xc, k.label ? cy + 11 : cy, k.p, { fill: C.bT, stroke: C.blue2, ink: C.blue, size: 10.5, h: 17 }).svg);
    }));
    const nodeSvg = nodes.map((nd, i) => {
      const d = sh[i], x = NX(i), top = y[i] - d.h / 2, k = d.k, o = OUTCOME[(nd.tone ?? "neutral") as keyof typeof OUTCOME] ?? OUTCOME.neutral;
      let box: string, label: string;
      if (k === "outcome") {
        box = `<rect x="${f(x)}" y="${f(top)}" width="${d.w}" height="${d.h}" rx="9" fill="${o.fill}" stroke="${o.stroke}" stroke-width="1.6"/>`;
        label = `${lines(d.t.lines, x + 14, y[i], { size: 12.5, weight: 650, anchor: "start" })}${nd.value ? `<text x="${f(x + d.w - 12)}" y="${f(y[i])}" dy=".35em" text-anchor="end" font-size="13" font-weight="800" fill="${o.ink}">${esc(nd.value)}</text>` : ""}`;
      } else {
        const stroke = k === "chance" ? C.blue : C.ink, glyph = k === "chance" ? `<circle cx="${f(x + 16)}" cy="${f(y[i])}" r="5.5" fill="${C.blue}"/>` : `<rect x="${f(x + 11)}" y="${f(y[i] - 5.5)}" width="11" height="11" rx="2.5" fill="${C.ink}"/>`;
        box = `<rect x="${f(x)}" y="${f(top + 2)}" width="${d.w}" height="${d.h}" rx="${k === "chance" ? Math.min(d.h / 2, 22) : 9}" fill="${C.line}"/><rect x="${f(x)}" y="${f(top)}" width="${d.w}" height="${d.h}" rx="${k === "chance" ? Math.min(d.h / 2, 22) : 9}" fill="${C.white}" stroke="${stroke}" stroke-width="1.8"/>${glyph}`;
        label = lines(d.t.lines, x + 30, y[i], { size: 12.5, weight: 700, anchor: "start" });
      }
      const onBest = kids.some(ks => ks.some(kk => kk.to === i && kk.best)), ev = nd.ev ? pill(x + d.w / 2, top + d.h, `${T("EV", "기댓값")} ${nd.ev}`, { fill: onBest ? C.gT : C.bT, stroke: onBest ? C.green2 : C.blue2, ink: onBest ? C.green : C.blue, size: 11, h: 19, maxW: 150 }).svg : "";
      return `${box}${label}${ev}`;
    }).join("");
    return `${b.title ? `<div class="sec">${esc(b.title)}</div>` : ""}${shell(uid, W, H, `${arrow(`${uid}h`, C.edge)}${arrow(`${uid}g`, C.green)}`, `${base.join("")}${best.join("")}${nodeSvg}${texts.join("")}`)}`;
  },
  summary(b) {
    const nodes = uniqueBy(b.nodes), find = finder(nodes), parent = new Array<number>(nodes.length).fill(-1);
    type Kid = { to: number; label?: string; p?: string; best?: boolean };
    const kids: Kid[][] = nodes.map(() => []);
    for (const e of b.branches) { const a = find(e.from), c = find(e.to); if (a < 0 || c < 0 || a === c || parent[c] >= 0) continue; let up = a, loop = false; while (up >= 0) { if (up === c) { loop = true; break; } up = parent[up]; } if (!loop) { parent[c] = a; kids[a].push({ to: c, label: e.label, p: e.p, best: e.best }); } }
    const walk = (i: number, d: number): string => `${nodes[i].label}${nodes[i].value ? ` ${nodes[i].value}` : ""}${nodes[i].ev ? ` (EV ${nodes[i].ev})` : ""}${kids[i].length && d < 6 ? ` → ${kids[i].map(k => `${k.best ? "[best] " : ""}${k.label ? `${k.label}: ` : ""}${k.p ? `${k.p} ` : ""}${walk(k.to, d + 1)}`).join("; ")}` : ""}`;
    const roots = nodes.map((_, i) => i).filter(i => parent[i] < 0);
    return sentence([`${b.title ?? "Decision tree"}:`, roots.map(r => walk(r, 0)).join(" | ")]);
  },
  css: shellCss("decision_tree"),
});

export const ASSETS: readonly AnyAsset[] = [flowchart, swimlaneDiagram, sequenceDiagram, stateDiagram, decisionTree];
