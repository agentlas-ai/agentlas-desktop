import { z } from "zod";
import { list, loose, optionalNum, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { AMBER, BLUE, GREEN, INK, INK2, LINE, MUTED, ORANGE, PINK, SLATE, VIOLET, WHITE, acyclic, aliased, baseCss, fit, idList, isObj, keyOf, layersOf, n, optList, resolver, roundedPath, settle, svg, tw, txt, wrap, type Hue } from "./_layout-b";

/* ================================================================== layered_architecture */

const comp = z.preprocess(
  v => (typeof v === "string" || typeof v === "number" ? { name: String(v) } : v),
  aliased({ name: text(26), note: optionalText(30) }, { name: ["label", "text", "title"], note: ["detail", "description", "desc"] }),
);
const archLayer = aliased(
  { name: text(28), components: optList(comp, 5), note: optionalText(44) },
  { name: ["label", "title", "layer"], components: ["items", "modules", "services", "parts", "boxes", "children"], note: ["description", "detail", "desc"] },
);
const LAYER_HUES: Hue[] = [BLUE, GREEN, VIOLET];
const CC_HUES: Hue[] = [ORANGE, PINK, SLATE];

export const layeredArchitecture = defineAsset({
  type: "layered_architecture", category: "diagram", width: "full",
  use: "A system as stacked horizontal layers (presentation, services, data ...), each with a few component boxes, and optional cross-cutting concerns on the side.",
  useKo: "시스템을 프레젠테이션·서비스·데이터 같은 가로 계층으로 쌓고 계층별 구성요소와 보안·관측 같은 공통 관심사를 옆에 보여주는 계층형 아키텍처.",
  tags: ["architecture", "layers", "stack", "system design", "tiers", "components", "아키텍처", "계층", "시스템 구조", "스택"],
  notes: "layers top to bottom, each with a name and 1-5 components (strings, or {name, note}). crosscutting: up to 3 short names drawn as vertical bars on the right. arrows: false hides the arrows between layers.",
  fields: { layers: list(archLayer, 2, 6), crosscutting: optList(labelled22(), 3), arrows: z.boolean().optional() },
  sample: { title: "Order platform architecture", crosscutting: ["Security", "Observability"], layers: [
    { name: "Presentation", note: "What people touch", components: ["Web app", "Mobile app", "Admin console"] },
    { name: "API and services", note: "Business rules", components: [{ name: "API gateway", note: "routing, rate limits" }, "Orders", "Billing", "Notifications"] },
    { name: "Data", note: "Systems of record", components: ["PostgreSQL", "Redis cache", "Object storage", "Search index"] },
    { name: "Infrastructure", components: ["Kubernetes", "CI/CD", "Terraform"] },
  ] },
  render(b) {
    const ls = b.layers, cc = b.crosscutting, arrows = b.arrows !== false;
    const W = 860, PAD = 6, BAR = 34, BG = 8, LABW = 142, RH = 80, GY = arrows ? 30 : 12, ccW = cc.length ? cc.length * (BAR + BG) + 6 : 0, rowW = W - 2 * PAD - ccW;
    const H = 2 * PAD + ls.length * RH + (ls.length - 1) * GY;
    let out = "";
    const ax0 = PAD + LABW + 16, ax1 = PAD + rowW - 14, acx = (ax0 + ax1) / 2;
    ls.forEach((l, i) => {
      const y = PAD + i * (RH + GY), h = LAYER_HUES[i % LAYER_HUES.length], ym = y + RH / 2;
      out += `<rect x="${PAD}" y="${n(y)}" width="${rowW}" height="${RH}" rx="14" fill="${h.soft}" stroke="${h.edge}"/>`;
      const nameLines = wrap(l.name, LABW - 26, 13.5, l.note ? 2 : 3, true), noteLines = l.note ? wrap(l.note, LABW - 26, 11, nameLines.length > 1 ? 1 : 2) : [], bh = nameLines.length * 17 + (noteLines.length ? 4 + noteLines.length * 14 : 0), top = ym - bh / 2;
      out += txt(PAD + 16, top + (nameLines.length * 17) / 2, nameLines, { size: 13.5, weight: 800, fill: h.ink, lh: 17 });
      if (noteLines.length) out += txt(PAD + 16, top + nameLines.length * 17 + 4 + (noteLines.length * 14) / 2, noteLines, { size: 11, weight: 550, fill: MUTED, lh: 14 });
      out += `<path d="M${PAD + LABW + 4},${n(y + 14)}V${n(y + RH - 14)}" stroke="${h.edge}" stroke-width="1.4"/>`;
      const m = l.components.length;
      if (m) {
        const gap = 10, cw = Math.min(204, (ax1 - ax0 - gap * (m - 1)) / m), total = cw * m + gap * (m - 1), bh2 = RH - 26;
        let x = ax0 + (ax1 - ax0 - total) / 2;
        for (const c of l.components) {
          const lines = c.note ? [fit(c.name, cw - 16, 12.5, true)] : wrap(c.name, cw - 16, 12.5, 2, true);
          out += `<rect x="${n(x)}" y="${n(ym - bh2 / 2 + 1.5)}" width="${n(cw)}" height="${bh2}" rx="10" fill="${INK}" fill-opacity=".05"/><rect x="${n(x)}" y="${n(ym - bh2 / 2)}" width="${n(cw)}" height="${bh2}" rx="10" fill="${WHITE}" stroke="${h.edge}"/>`;
          out += txt(x + cw / 2, ym - (c.note ? 7 : 0), lines, { size: 12.5, weight: 750, fill: INK, anchor: "middle", lh: 15 });
          if (c.note) out += txt(x + cw / 2, ym + 10, [fit(c.note, cw - 16, 10.5)], { size: 10.5, weight: 550, fill: MUTED, anchor: "middle" });
          x += cw + gap;
        }
      }
      if (arrows && i + 1 < ls.length) {
        const y0 = y + RH + 4, y1 = y + RH + GY - 4;
        out += `<path d="M${n(acx)},${n(y0)}V${n(y1)}M${n(acx - 4.5)},${n(y1 - 6)}L${n(acx)},${n(y1)}L${n(acx + 4.5)},${n(y1 - 6)}M${n(acx - 4.5)},${n(y0 + 6)}L${n(acx)},${n(y0)}L${n(acx + 4.5)},${n(y0 + 6)}" fill="none" stroke="#9aa6ac" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
    });
    cc.forEach((name, k) => {
      const x = PAD + rowW + 10 + k * (BAR + BG), h = CC_HUES[k % CC_HUES.length], mid = H / 2;
      out += `<rect x="${n(x)}" y="${PAD}" width="${BAR}" height="${H - 2 * PAD}" rx="12" fill="${h.soft}" stroke="${h.edge}" stroke-dasharray="4 3"/>`;
      out += `<g transform="translate(${n(x + BAR / 2)},${n(mid)}) rotate(-90)">${txt(0, 0, [fit(name, H - 2 * PAD - 28, 12.5, true)], { size: 12.5, weight: 800, fill: h.ink, anchor: "middle" })}</g>`;
    });
    return svg(W, H + PAD, out, { title: b.title });
  },
  summary: b => `${b.title ?? "Layered architecture"}, top to bottom: ${b.layers.map(l => `${l.name}${l.components.length ? ` (${l.components.map(c => c.name).join(", ")})` : ""}`).join(" → ")}${b.crosscutting.length ? `. Cross-cutting: ${b.crosscutting.join(", ")}` : ""}.`.slice(0, 400),
  css: baseCss("layered_architecture"),
});
function labelled22() { return z.preprocess(v => (isObj(v) ? v.name ?? v.label ?? v.text : v), text(22)); }

/* ================================================================== er_diagram */

const keyKind = z.preprocess(v => {
  if (typeof v === "boolean") return v ? "pk" : undefined;
  if (typeof v !== "string") return undefined;
  const k = v.toLowerCase();
  return /pk|primary/.test(k) ? "pk" : /fk|foreign|ref/.test(k) ? "fk" : /uq|uniq/.test(k) ? "uq" : undefined;
}, z.enum(["pk", "fk", "uq"]).optional());
const erField = z.preprocess(v => {
  if (typeof v === "string" || typeof v === "number") return { name: String(v) };
  if (!isObj(v)) return v;
  const o = { ...v };
  if (o.key === undefined || o.key === null) o.key = o.pk === true || o.primary === true || o.is_pk === true ? "pk" : o.fk === true || o.foreign === true || o.is_fk === true ? "fk" : o.unique === true || o.uq === true ? "uq" : o.constraint ?? o.flag;
  return o;
}, aliased({ name: text(24), type: optionalText(14), key: keyKind }, { name: ["column", "field", "label", "attribute"], type: ["datatype", "data_type", "kind", "dtype"] }));
const erEntity = aliased({ name: text(24), fields: optList(erField, 8) }, { name: ["table", "label", "entity", "title"], fields: ["columns", "attributes", "attrs", "cols", "properties"] });
const relKind = loose(["one_to_many", "one_to_one", "many_to_one", "many_to_many"], {
  "1:n": "one_to_many", "1:m": "one_to_many", "1:many": "one_to_many", "1..*": "one_to_many", "1_to_n": "one_to_many", has_many: "one_to_many", "1:*": "one_to_many", one_many: "one_to_many",
  "1:1": "one_to_one", "1..1": "one_to_one", has_one: "one_to_one", one_one: "one_to_one",
  "n:1": "many_to_one", "m:1": "many_to_one", "many:1": "many_to_one", "*:1": "many_to_one", belongs_to: "many_to_one", many_one: "many_to_one",
  "n:m": "many_to_many", "m:n": "many_to_many", "n:n": "many_to_many", "*:*": "many_to_many", many_many: "many_to_many",
}, "one_to_many");
const erRel = aliased({ from: text(24), to: text(24), kind: relKind.optional(), label: optionalText(24) }, { from: ["source", "a", "left", "parent"], to: ["target", "b", "right", "child"], kind: ["type", "cardinality", "relation", "rel"], label: ["name", "text", "verb"] });

type Side = "t" | "b" | "l" | "r";
const OUT: Record<Side, [number, number]> = { r: [1, 0], l: [-1, 0], t: [0, -1], b: [0, 1] };
/** One end of a relationship at an entity edge: two bars for "one", a crow's foot for "many". `out` points from the entity into the line. */
function endMark(px: number, py: number, side: Side, many: boolean): string {
  const [ox, oy] = OUT[side], qx = -oy, qy = ox, at = (d: number, s: number) => `${n(px + ox * d + qx * s)},${n(py + oy * d + qy * s)}`;
  const d = many ? `M${at(14, 0)}L${at(0, 7)}M${at(14, 0)}L${at(0, 0)}M${at(14, 0)}L${at(0, -7)}` : `M${at(8, -6)}L${at(8, 6)}M${at(13, -6)}L${at(13, 6)}`;
  return `<path d="${d}" fill="none" stroke="#6d7a82" stroke-width="1.6" stroke-linecap="round"/>`;
}

const SLOTS: Record<number, [number, number][]> = {
  1: [[0, 0]], 2: [[0, 0], [1, 0]], 3: [[1, 0], [0, 0], [2, 0]], 4: [[0, 0], [1, 0], [0, 1], [1, 1]],
  5: [[1, 0], [0, 0], [2, 0], [1, 1], [0, 1]], 6: [[1, 0], [0, 0], [2, 0], [1, 1], [0, 1], [2, 1]],
};

/** Entities and the relationships between them that exist: unique names, unknown ends and repeats dropped. */
function erModel(rawEntities: ReadonlyArray<{ name: string; fields: ReadonlyArray<{ name: string; type?: string; key?: "pk" | "fk" | "uq" }> }>, rawRels: ReadonlyArray<{ from: string; to: string; kind?: string; label?: string }>) {
  const entities: { name: string; fields: { name: string; type?: string; key?: "pk" | "fk" | "uq" }[] }[] = [], seenNames = new Set<string>();
  for (const e of rawEntities) { if (seenNames.has(keyOf(e.name))) continue; seenNames.add(keyOf(e.name)); entities.push({ name: e.name, fields: [...e.fields] }); }
  const find = resolver(entities.map((e, i) => [e.name, i] as [string, number]));
  const rels: { a: number; b: number; kind: string; label?: string }[] = [], seen = new Set<string>();
  for (const r of rawRels) {
    const a = find(r.from), b = find(r.to);
    if (a < 0 || b < 0) continue;
    const id = `${a}>${b}|${r.label ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id); rels.push({ a, b, kind: r.kind ?? "one_to_many", label: r.label });
  }
  return { entities, rels };
}

export const erDiagram = defineAsset({
  type: "er_diagram", category: "diagram", width: "full",
  use: "A data model: two to six entities as table cards (fields, types, primary and foreign keys) joined by one-to-many or many-to-many relationships.",
  useKo: "엔티티 2~6개를 필드·타입·PK/FK가 있는 테이블 카드로 그리고 일대다·다대다 관계선으로 잇는 ER 다이어그램.",
  tags: ["er diagram", "database", "schema", "entities", "tables", "relationships", "data model", "ERD", "데이터 모델", "스키마", "테이블", "관계"],
  notes: "entities: name and up to 8 fields {name, type, key: pk|fk|uq}. relations: {from, to, kind: one_to_many | one_to_one | many_to_one | many_to_many, label} by entity name; unknown names are ignored.",
  fields: { entities: list(erEntity, 2, 6), relations: optList(erRel, 10) },
  sample: { title: "Online store data model", entities: [
    { name: "customers", fields: [{ name: "id", type: "uuid", key: "pk" }, { name: "name", type: "text" }, { name: "email", type: "text", key: "uq" }, { name: "created_at", type: "timestamp" }] },
    { name: "orders", fields: [{ name: "id", type: "uuid", key: "pk" }, { name: "customer_id", type: "uuid", key: "fk" }, { name: "status", type: "text" }, { name: "total", type: "decimal" }, { name: "placed_at", type: "timestamp" }] },
    { name: "order_items", fields: [{ name: "id", type: "uuid", key: "pk" }, { name: "order_id", type: "uuid", key: "fk" }, { name: "product_id", type: "uuid", key: "fk" }, { name: "quantity", type: "int" }, { name: "unit_price", type: "decimal" }] },
    { name: "products", fields: [{ name: "id", type: "uuid", key: "pk" }, { name: "sku", type: "text", key: "uq" }, { name: "name", type: "text" }, { name: "price", type: "decimal" }, { name: "stock", type: "int" }] },
    { name: "payments", fields: [{ name: "id", type: "uuid", key: "pk" }, { name: "order_id", type: "uuid", key: "fk" }, { name: "method", type: "text" }, { name: "amount", type: "decimal" }, { name: "paid_at", type: "timestamp" }] },
  ], relations: [
    { from: "customers", to: "orders", kind: "one_to_many", label: "places" },
    { from: "orders", to: "order_items", kind: "one_to_many", label: "contains" },
    { from: "products", to: "order_items", kind: "one_to_many", label: "sold as" },
    { from: "orders", to: "payments", kind: "one_to_many", label: "paid by" },
  ] },
  render(b) {
    const { entities, rels } = erModel(b.entities, b.relations);
    const N = entities.length, EW = 192, HEAD = 32, ROW = 22, CG = 100, RG = 78, PADX = 14, selfPad = rels.some(r => r.a === r.b) ? 40 : 0;
    // Fill order: the best-connected entity first, then its neighbours, so related tables sit next to each other.
    const adj = entities.map(() => new Set<number>());
    for (const r of rels) if (r.a !== r.b) { adj[r.a].add(r.b); adj[r.b].add(r.a); }
    const order: number[] = [], seen = new Set<number>();
    while (order.length < N) {
      let start = -1;
      entities.forEach((_, i) => { if (!seen.has(i) && (start < 0 || adj[i].size > adj[start].size)) start = i; });
      const queue = [start];
      while (queue.length) {
        const v = queue.shift() as number;
        if (seen.has(v)) continue;
        seen.add(v); order.push(v);
        queue.push(...[...adj[v]].filter(w => !seen.has(w)).sort((p, q) => adj[q].size - adj[p].size || p - q));
      }
    }
    const slots = SLOTS[Math.min(6, Math.max(1, N))], cols = Math.max(...slots.map(s => s[0])) + 1, rows = Math.max(...slots.map(s => s[1])) + 1;
    const hOf = (i: number) => HEAD + Math.max(1, entities[i].fields.length) * ROW + 8;
    const slotOf = new Map<number, [number, number]>(order.map((e, k) => [e, slots[k]]));
    const rowH = Array.from({ length: rows }, (_, r) => Math.max(0, ...entities.map((_, i) => (slotOf.get(i)?.[1] === r ? hOf(i) : 0))));
    const TOP = 22 + 10 * Math.min(3, rels.filter(r => r.a !== r.b && slotOf.get(r.a)?.[1] === 0 && slotOf.get(r.b)?.[1] === 0 && Math.abs((slotOf.get(r.a)?.[0] ?? 0) - (slotOf.get(r.b)?.[0] ?? 0)) > 1).length);
    const rowY = rowH.map((_, r) => TOP + rowH.slice(0, r).reduce((s, v) => s + v + RG, 0));
    const box = entities.map((_, i) => { const [c, r] = slotOf.get(i) ?? [0, 0]; return { x: PADX + c * (EW + CG), y: rowY[r], w: EW, h: hOf(i), col: c, row: r }; });
    const W = PADX * 2 + cols * EW + (cols - 1) * CG + selfPad, H = TOP + rowH.reduce((s, v) => s + v, 0) + (rows - 1) * RG + 16;

    // Which edge of which box each relationship leaves from.
    interface Conn { rel: number; a: number; b: number; sa: Side; sb: Side }
    const conns: Conn[] = rels.map((r, k) => {
      const A = box[r.a], B = box[r.b];
      if (r.a === r.b) return { rel: k, a: r.a, b: r.b, sa: "r", sb: "r" };
      if (A.row === B.row) return Math.abs(A.col - B.col) === 1 ? { rel: k, a: r.a, b: r.b, sa: A.col < B.col ? "r" : "l", sb: A.col < B.col ? "l" : "r" } : { rel: k, a: r.a, b: r.b, sa: "t", sb: "t" };
      return { rel: k, a: r.a, b: r.b, sa: A.row < B.row ? "b" : "t", sb: A.row < B.row ? "t" : "b" };
    });
    // Anchors on each side, spread along it in the order of the other end so lines do not cross needlessly.
    const bucket = new Map<string, { c: number; end: "a" | "b"; other: number }[]>();
    conns.forEach((c, ci) => {
      if (c.a === c.b) return;
      ([["a", c.a, c.sa, c.b], ["b", c.b, c.sb, c.a]] as const).forEach(([end, bi, side, oi]) => {
        const key = `${bi}${side}`, o = box[oi], other = side === "t" || side === "b" ? o.x + o.w / 2 : o.y + o.h / 2;
        bucket.set(key, [...(bucket.get(key) ?? []), { c: ci, end, other }]);
      });
    });
    const point = new Map<string, [number, number]>();
    for (const [key, items] of bucket) {
      const bi = parseInt(key, 10), side = key.slice(String(bi).length) as Side, bx = box[bi], sorted = [...items].sort((p, q) => p.other - q.other || p.c - q.c);
      sorted.forEach((it, k) => {
        const m = sorted.length;
        point.set(`${it.c}${it.end}`, side === "t" || side === "b" ? [bx.x + bx.w / 2 + (k - (m - 1) / 2) * 22, side === "t" ? bx.y : bx.y + bx.h] : [side === "l" ? bx.x : bx.x + bx.w, Math.min(bx.y + HEAD / 2 + k * 16, bx.y + bx.h - 10)]);
      });
    }
    // A relationship of an entity with itself loops out of the right edge near the bottom of the card.
    conns.forEach((c, ci) => { if (c.a === c.b) { const bx = box[c.a], y1 = Math.max(bx.y + HEAD / 2 + 40, bx.y + bx.h - 40); point.set(`${ci}a`, [bx.x + bx.w, y1]); point.set(`${ci}b`, [bx.x + bx.w, y1 + 22]); } });
    // Horizontal channels: each route that runs sideways between rows (or over a skipped column) gets its own lane.
    const lane = new Map<number, number>(), laneY = (ci: number, gap: number) => rowY[gap + 1] - 12 - (lane.get(ci) ?? 0) * 9;
    const channelOf = (c: Conn) => (c.sa === c.sb ? box[c.a].row - 1 : Math.min(box[c.a].row, box[c.b].row));
    const byGap = new Map<number, number[]>();
    conns.forEach((c, ci) => { if (c.a !== c.b && (c.sa === "b" || c.sa === "t" || c.sa === c.sb) && c.sa !== "l" && c.sa !== "r" && channelOf(c) >= 0) byGap.set(channelOf(c), [...(byGap.get(channelOf(c)) ?? []), ci]); });
    for (const ids of byGap.values()) [...ids].sort((p, q) => (point.get(`${p}a`) as [number, number])[0] + (point.get(`${p}b`) as [number, number])[0] - (point.get(`${q}a`) as [number, number])[0] - (point.get(`${q}b`) as [number, number])[0] || p - q).forEach((ci, k) => lane.set(ci, k));
    const topLane = new Map<number, number>();
    let lines = "", marks = "", tags = "";
    const routes: { ci: number; pts: [number, number][] }[] = [];
    conns.forEach((c, ci) => {
      const r = rels[c.rel], pa = point.get(`${ci}a`) as [number, number], pb = point.get(`${ci}b`) as [number, number];
      let pts: [number, number][];
      if (c.a === c.b) pts = [pa, [pa[0] + 26, pa[1]], [pb[0] + 26, pb[1]], pb];
      else if (c.sa === "r" || c.sa === "l") { const left = box[c.a].x < box[c.b].x ? box[c.a] : box[c.b], mid = left.x + left.w + CG / 2; pts = [pa, [mid, pa[1]], [mid, pb[1]], pb]; }
      else if (c.sa === c.sb) {
        const row = box[c.a].row, yc = row === 0 ? rowY[0] - 12 - (topLane.get(0) ?? 0) * 10 : laneY(ci, row - 1);
        if (row === 0) topLane.set(0, (topLane.get(0) ?? 0) + 1);
        pts = [pa, [pa[0], yc], [pb[0], yc], pb];
      } else { const ymid = laneY(ci, channelOf(c)); pts = [pa, [pa[0], ymid], [pb[0], ymid], pb]; }
      pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5).filter((p, i, all) => i === 0 || i === all.length - 1 || Math.abs((p[0] - all[i - 1][0]) * (all[i + 1][1] - p[1]) - (p[1] - all[i - 1][1]) * (all[i + 1][0] - p[0])) > 0.5);
      routes.push({ ci, pts });
      lines += `<path d="${roundedPath(pts, 8)}" fill="none" stroke="#8e99a0" stroke-width="1.6" stroke-linejoin="round"/>`;
      const kind = r.kind, manyA = kind === "many_to_one" || kind === "many_to_many", manyB = kind === "one_to_many" || kind === "many_to_many";
      marks += endMark(pa[0], pa[1], c.sa, manyA) + endMark(pb[0], pb[1], c.sb, manyB);
    });
    // Labels go on the first stretch of their own line where they cover no card, no other label and no other line; a label that finds no such place is left out.
    interface R { x0: number; y0: number; x1: number; y1: number }
    const cardBoxes: R[] = box.map(bx => ({ x0: bx.x - 3, y0: bx.y - 3, x1: bx.x + bx.w + 3, y1: bx.y + bx.h + 3 })), placedLabels: R[] = [];
    const crosses = (rect: R, pts: [number, number][]) => pts.slice(0, -1).some((p, i) => { const q = pts[i + 1], x0 = Math.min(p[0], q[0]), x1 = Math.max(p[0], q[0]), y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1]); return x1 >= rect.x0 && x0 <= rect.x1 && y1 >= rect.y0 && y0 <= rect.y1; });
    routes.forEach(({ ci, pts }) => {
      const text = rels[conns[ci].rel].label;
      if (!text) return;
      const segs = pts.slice(0, -1).map((p, i) => ({ p, q: pts[i + 1], len: Math.hypot(pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]) })).filter(sg => sg.len >= 40).sort((u, v) => v.len - u.len).slice(0, 3);
      for (const sg of segs) for (const f of [0.5, 0.3, 0.7, 0.18, 0.82]) {
        const horiz = Math.abs(sg.q[1] - sg.p[1]) < 0.5, label = fit(text, horiz ? Math.min(sg.len - 20, 96) : 96, 10.5, true), lw = tw(label, 10.5, true) + 8;
        const mx = sg.p[0] + (sg.q[0] - sg.p[0]) * f, my = sg.p[1] + (sg.q[1] - sg.p[1]) * f, lx = horiz ? mx : mx + 6 + lw / 2, ly = horiz ? my - 9 : my;
        const rect: R = { x0: lx - lw / 2, y0: ly - 8, x1: lx + lw / 2, y1: ly + 8 };
        if (cardBoxes.some(o => rect.x0 < o.x1 && rect.x1 > o.x0 && rect.y0 < o.y1 && rect.y1 > o.y0) || placedLabels.some(o => rect.x0 < o.x1 + 3 && rect.x1 > o.x0 - 3 && rect.y0 < o.y1 + 2 && rect.y1 > o.y0 - 2) || routes.some(o => o.ci !== ci && crosses(rect, o.pts)) || rect.x0 < 2 || rect.x1 > W - 2) continue;
        placedLabels.push(rect);
        tags += `<rect x="${n(rect.x0)}" y="${n(rect.y0)}" width="${n(lw)}" height="16" rx="4" fill="#fff" fill-opacity=".94"/>${txt(lx, ly, [label], { size: 10.5, weight: 650, fill: MUTED, anchor: "middle" })}`;
        return;
      }
    });
    // The table cards.
    const KEY: Record<string, { fill: string; ink: string }> = { pk: { fill: AMBER.soft, ink: AMBER.ink }, fk: { fill: BLUE.soft, ink: BLUE.ink }, uq: { fill: SLATE.soft, ink: SLATE.ink } };
    const cards = entities.map((e, i) => {
      const { x, y, w, h } = box[i];
      let s = `<rect x="${n(x)}" y="${n(y + 2)}" width="${w}" height="${h}" rx="12" fill="${INK}" fill-opacity=".06"/><rect x="${n(x)}" y="${n(y)}" width="${w}" height="${h}" rx="12" fill="${WHITE}" stroke="${LINE}"/>`;
      s += `<path d="M${n(x)},${n(y + HEAD)}V${n(y + 12)}Q${n(x)},${n(y)} ${n(x + 12)},${n(y)}H${n(x + w - 12)}Q${n(x + w)},${n(y)} ${n(x + w)},${n(y + 12)}V${n(y + HEAD)}Z" fill="${INK}"/>`;
      s += txt(x + 14, y + HEAD / 2, [fit(e.name, w - 28, 13, true)], { size: 13, weight: 800, fill: WHITE });
      e.fields.forEach((f, k) => {
        const fy = y + HEAD + k * ROW + ROW / 2 + 3;
        if (k) s += `<path d="M${n(x + 10)},${n(fy - ROW / 2)}H${n(x + w - 10)}" stroke="#f0f1ef"/>`;
        if (f.key) s += `<rect x="${n(x + 10)}" y="${n(fy - 7)}" width="20" height="14" rx="4" fill="${KEY[f.key].fill}"/>${txt(x + 20, fy, [f.key.toUpperCase()], { size: 8.5, weight: 800, fill: KEY[f.key].ink, anchor: "middle" })}`;
        const type = f.type ? fit(f.type, 62, 10) : "", typeW = type ? tw(type, 10, true) + 10 : 0;
        if (type) s += `<rect x="${n(x + w - 10 - typeW)}" y="${n(fy - 7)}" width="${n(typeW)}" height="14" rx="4" fill="#f2f4f3"/>${txt(x + w - 10 - typeW / 2, fy, [type], { size: 10, weight: 600, fill: MUTED, anchor: "middle" })}`;
        s += txt(x + 36, fy, [fit(f.name, w - 36 - typeW - 18, 11.5, f.key === "pk")], { size: 11.5, weight: f.key === "pk" ? 750 : 600, fill: INK2 });
      });
      return s;
    }).join("");
    return svg(W, H, `${lines}${cards}${marks}${tags}`, { title: b.title });
  },
  summary: b => {
    const { entities, rels } = erModel(b.entities, b.relations), word = (k: string) => k.replace(/_/g, "-").replace("-to-", " to ");
    return `${b.title ?? "ER diagram"}: ${entities.map(e => `${e.name} (${e.fields.map(f => `${f.name}${f.key ? ` ${f.key.toUpperCase()}` : ""}`).slice(0, 5).join(", ")}${e.fields.length > 5 ? ", ..." : ""})`).join("; ")}. Relationships: ${rels.length ? rels.map(r => `${entities[r.a].name} ${word(r.kind)} ${entities[r.b].name}${r.label ? ` (${r.label})` : ""}`).join("; ") : "none"}.`.slice(0, 400);
  },
  css: baseCss("er_diagram"),
});

/* ================================================================== dependency_graph */

const status = loose(["todo", "active", "done", "blocked"], {
  pending: "todo", planned: "todo", open: "todo", not_started: "todo", backlog: "todo", waiting: "blocked", stuck: "blocked", at_risk: "blocked", blocker: "blocked",
  in_progress: "active", started: "active", doing: "active", wip: "active", running: "active", ongoing: "active", complete: "done", completed: "done", finished: "done", closed: "done", shipped: "done",
}, "todo").optional();
const task = aliased(
  { id: text(20), label: optionalText(34), status, after: idList(6), days: optionalNum },
  { id: ["name", "key", "label"], label: ["name", "title"], after: ["depends_on", "dependsOn", "needs", "requires", "deps", "depends", "prerequisites", "blocked_by", "blockedBy", "predecessors", "upstream"], days: ["duration", "effort", "estimate", "weight"] },
);

type DepStatus = "todo" | "active" | "done" | "blocked";
/** The tasks as a DAG: unique ids, unknown references dropped, cycles broken, layers by longest path, and the critical path. */
function depModel(tasks: ReadonlyArray<{ id: string; label?: string; status?: string; after: string[]; days?: number }>, critical: string[]) {
  const nodes: { id: string; label: string; status: DepStatus; days?: number }[] = [], seen = new Set<string>(), refs: string[][] = [];
  for (const t of tasks) { if (seen.has(keyOf(t.id))) continue; seen.add(keyOf(t.id)); nodes.push({ id: t.id, label: t.label ?? t.id, status: (t.status as DepStatus | undefined) ?? "todo", days: t.days }); refs.push(t.after); }
  const find = resolver([...nodes.map((nd, i) => [nd.id, i] as [string, number]), ...nodes.map((nd, i) => [nd.label, i] as [string, number])]);
  const raw: [number, number][] = [];
  refs.forEach((list, to) => { for (const r of list) { const from = find(r); if (from >= 0) raw.push([from, to]); } });
  const edges = acyclic(nodes.length, raw), layer = layersOf(nodes.length, edges);
  // Critical path: the ids the answer named, else the longest chain (by days when given, by steps otherwise).
  const named = new Set(critical.map(c => find(c)).filter(v => v >= 0));
  let crit = new Set<number>();
  if (named.size >= 2) crit = named;
  else if (edges.length) {
    const w = nodes.map(nd => Math.max(0.1, nd.days ?? 1)), dist = w.map(v => v), prev = nodes.map(() => -1);
    for (const v of nodes.map((_, i) => i).sort((p, q) => layer[p] - layer[q] || p - q)) for (const [a, b] of edges) if (b === v && dist[a] + w[v] > dist[v] + 1e-9) { dist[v] = dist[a] + w[v]; prev[v] = a; }
    let end = 0;
    dist.forEach((d, i) => { if (d > dist[end] + 1e-9) end = i; });
    for (let v = end; v >= 0; v = prev[v]) crit.add(v);
  }
  const critEdges = new Set(edges.filter(([a, b]) => crit.has(a) && crit.has(b)).map(([a, b]) => `${a}>${b}`));
  return { nodes, edges, layer, crit, critEdges };
}

const STATUS_STYLE: Record<DepStatus, { fill: string; edge: string; ink: string }> = {
  done: { fill: "#f0f8f4", edge: "#acd8c4", ink: "#0b6a45" }, active: { fill: "#eef3fe", edge: "#bccdf5", ink: "#1f46a8" },
  blocked: { fill: "#fdeff0", edge: "#eab3b9", ink: "#a82434" }, todo: { fill: "#ffffff", edge: "#d6dcd9", ink: "#5c6870" },
};
function statusIcon(s: DepStatus, cx: number, cy: number): string {
  if (s === "done") return `<circle cx="${n(cx)}" cy="${n(cy)}" r="7.5" fill="${GREEN.solid}"/><path d="M${n(cx - 3.4)},${n(cy + 0.2)}L${n(cx - 1)},${n(cy + 2.7)}L${n(cx + 3.6)},${n(cy - 2.6)}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (s === "active") return `<circle cx="${n(cx)}" cy="${n(cy)}" r="6.8" fill="#fff" stroke="${BLUE.solid}" stroke-width="2"/><circle cx="${n(cx)}" cy="${n(cy)}" r="2.8" fill="${BLUE.solid}"/>`;
  if (s === "blocked") return `<circle cx="${n(cx)}" cy="${n(cy)}" r="7.5" fill="#cf3545"/><path d="M${n(cx - 3.6)},${n(cy)}H${n(cx + 3.6)}" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/>`;
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="6.8" fill="#fff" stroke="#b9c3be" stroke-width="1.8"/>`;
}

export const dependencyGraph = defineAsset({
  type: "dependency_graph", category: "diagram", width: "full",
  use: "Tasks or modules and what each one waits for, as a left-to-right dependency graph with the critical path highlighted and done, in-progress and blocked states coloured.",
  useKo: "작업·모듈이 무엇을 기다리는지 왼쪽에서 오른쪽으로 보여주고 핵심 경로와 완료·진행·막힘 상태를 색으로 표시하는 의존성 그래프.",
  tags: ["dependency", "dag", "critical path", "tasks", "build order", "project plan", "의존성", "핵심 경로", "작업 순서", "선후 관계"],
  notes: "tasks: id, optional label, status (todo, active, done, blocked), after (ids it waits for) and optional days. critical: optional ids of the critical path; if left out the longest chain (by days) is computed. Up to 16 tasks; cycles are broken and unknown ids ignored.",
  fields: { tasks: list(task, 2, 16), critical: idList(16) },
  sample: { title: "Release plan: what waits for what", tasks: [
    { id: "spec", label: "Write spec", status: "done", days: 3, after: [] },
    { id: "design", label: "UI design", status: "done", days: 4, after: ["spec"] },
    { id: "schema", label: "Data model", status: "done", days: 2, after: ["spec"] },
    { id: "api", label: "Build API", status: "active", days: 8, after: ["schema"] },
    { id: "ui", label: "Build UI", status: "active", days: 5, after: ["design"] },
    { id: "auth", label: "SSO integration", status: "blocked", days: 3, after: ["api"] },
    { id: "e2e", label: "Integration tests", status: "todo", days: 3, after: ["api", "ui"] },
    { id: "sec", label: "Security review", status: "todo", days: 2, after: ["auth", "e2e"] },
    { id: "perf", label: "Load testing", status: "todo", days: 2, after: ["e2e"] },
    { id: "launch", label: "Launch", status: "todo", days: 1, after: ["sec", "perf"] },
  ], critical: [] },
  render(b, { uid, T }) {
    const { nodes, edges, layer, crit, critEdges } = depModel(b.tasks, b.critical);
    // Left to right while the chain is short; a long chain runs top to bottom so the text stays readable.
    const L = Math.max(...layer) + 1, LR = L <= 6, GAP = LR ? 40 : 44, NH = 50, NW = LR ? Math.max(104, Math.min(150, Math.floor((980 - (L - 1) * GAP) / L))) : 150, PAD = 12;
    const EU = LR ? NW : NH, EV = LR ? NH : NW, STEP = EU + GAP, xy = (u: number, v: number): [number, number] => (LR ? [u, v] : [v, u]);
    // Items: every task plus a pass-through slot in each layer an edge crosses.
    interface Item { real: number; layer: number; h: number }
    const items: Item[] = nodes.map((_, i) => ({ real: i, layer: layer[i], h: EV }));
    interface Hop { from: number; to: number }
    const hops: Hop[] = [], chains: number[][] = [];
    edges.forEach(([a, c]) => {
      const chain = [a];
      for (let l = layer[a] + 1; l < layer[c]; l++) { items.push({ real: -1, layer: l, h: 8 }); chain.push(items.length - 1); }
      chain.push(c);
      chains.push(chain);
      for (let k = 0; k + 1 < chain.length; k++) hops.push({ from: chain[k], to: chain[k + 1] });
    });
    const cols: number[][] = Array.from({ length: L }, () => []);
    items.forEach((it, i) => cols[it.layer].push(i));
    const preds = items.map(() => [] as number[]), succs = items.map(() => [] as number[]);
    for (const h of hops) { preds[h.to].push(h.from); succs[h.from].push(h.to); }
    // Order inside each layer by the mean position of the neighbours (a few sweeps), then place by the neighbours' positions.
    const posOf = new Map<number, number>();
    cols.forEach(c => c.forEach((it, k) => posOf.set(it, k)));
    for (let sweep = 0; sweep < 4; sweep++) {
      const down = sweep % 2 === 0;
      for (let l = down ? 1 : L - 2; down ? l < L : l >= 0; l += down ? 1 : -1) {
        const nb = (it: number) => (down ? preds[it] : succs[it]), bary = (it: number) => (nb(it).length ? nb(it).reduce((sum, p) => sum + (posOf.get(p) ?? 0), 0) / nb(it).length : posOf.get(it) ?? 0);
        cols[l] = [...cols[l]].sort((p, q) => bary(p) - bary(q) || (posOf.get(p) ?? 0) - (posOf.get(q) ?? 0));
        cols[l].forEach((it, k) => posOf.set(it, k));
      }
    }
    const space = (col: number[]) => col.map((it, k) => (k ? (items[col[k - 1]].h + items[it].h) / 2 + (items[it].real < 0 || items[col[k - 1]].real < 0 ? 8 : 16) : 0));
    const v = items.map(() => 0), extent = cols.map(c => c.reduce((sum, it, k) => sum + items[it].h + (k ? space(c)[k] - (items[c[k - 1]].h + items[it].h) / 2 : 0), 0)), vMax = Math.max(...extent, EV);
    cols.forEach((c, l) => { let y = (vMax - extent[l]) / 2; const sp = space(c); c.forEach((it, k) => { if (k) y += sp[k] - (items[c[k - 1]].h + items[it].h) / 2; v[it] = y + items[it].h / 2; y += items[it].h; }); });
    for (let round = 0; round < 4; round++) {
      for (let l = 1; l < L; l++) { const want = cols[l].map(it => (preds[it].length ? preds[it].reduce((sum, p) => sum + v[p], 0) / preds[it].length : v[it])); settle(want, space(cols[l])).forEach((val, k) => { v[cols[l][k]] = val; }); }
      for (let l = L - 2; l >= 0; l--) { const want = cols[l].map(it => (succs[it].length ? succs[it].reduce((sum, p) => sum + v[p], 0) / succs[it].length : v[it])); settle(want, space(cols[l])).forEach((val, k) => { v[cols[l][k]] = val; }); }
    }
    const vMin = Math.min(...items.map((it, i) => v[i] - it.h / 2)), vShift = PAD + 8 - vMin;
    items.forEach((_, i) => { v[i] += vShift; });
    const vEnd = Math.max(...items.map((it, i) => v[i] + it.h / 2)), U = (it: number) => PAD + 6 + items[it].layer * STEP;
    // Vertical runs inside a gap are spread so parallel edges do not sit on one line.
    const gapHops = new Map<number, Hop[]>();
    for (const h of hops) if (Math.abs(v[h.from] - v[h.to]) > 0.5) gapHops.set(items[h.from].layer, [...(gapHops.get(items[h.from].layer) ?? []), h]);
    const mid = new Map<Hop, number>();
    for (const [l, hs] of gapHops) {
      const sorted = [...hs].sort((p, q) => v[p.from] - v[q.from] || v[p.to] - v[q.to]), step = Math.min(8, (GAP - 18) / Math.max(1, sorted.length));
      sorted.forEach((h, k) => mid.set(h, PAD + 6 + l * STEP + EU + GAP / 2 + (k - (sorted.length - 1) / 2) * step));
    }
    const route = (chain: number[]) => {
      const pts: [number, number][] = [xy(U(chain[0]) + EU, v[chain[0]])];
      for (let k = 0; k + 1 < chain.length; k++) {
        const h = hops.find(x => x.from === chain[k] && x.to === chain[k + 1]) as Hop, m = mid.get(h);
        if (m !== undefined) pts.push(xy(m, v[h.from]), xy(m, v[h.to]));
        pts.push(xy(U(h.to), v[h.to]));
        if (items[h.to].real < 0) pts.push(xy(U(h.to) + EU, v[h.to]));
      }
      return pts;
    };
    const idA = `${uid}da`, idB = `${uid}db`;
    const defs = `<marker id="${idA}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,1L10,5L0,9Z" fill="#9aa6ac"/></marker><marker id="${idB}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,1L10,5L0,9Z" fill="${INK}"/></marker>`;
    let plain = "", strong = "";
    edges.forEach(([a, c], ei) => {
      const isCrit = critEdges.has(`${a}>${c}`), path = `<path d="${roundedPath(route(chains[ei]), 9)}" fill="none" stroke="${isCrit ? INK : "#b4bfc5"}" stroke-width="${isCrit ? 2.6 : 1.6}" stroke-linejoin="round" marker-end="url(#${isCrit ? idB : idA})"/>`;
      if (isCrit) strong += path; else plain += path;
    });
    let cards = "";
    nodes.forEach((nd, i) => {
      const st = STATUS_STYLE[nd.status], [cx, cy] = xy(U(i) + EU / 2, v[i]), x = cx - NW / 2, y = cy - NH / 2, isCrit = crit.has(i), days = nd.days !== undefined ? `${+nd.days.toFixed(1)}d` : "", dw = days ? tw(days, 10, true) + 12 : 0;
      cards += `<rect x="${n(x)}" y="${n(y + 2)}" width="${NW}" height="${NH}" rx="11" fill="${INK}" fill-opacity=".06"/><rect x="${n(x)}" y="${n(y)}" width="${NW}" height="${NH}" rx="11" fill="${st.fill}" stroke="${isCrit ? INK : st.edge}" stroke-width="${isCrit ? 2 : 1.2}"/>`;
      cards += statusIcon(nd.status, x + 18, cy);
      cards += txt(x + 33, cy, wrap(nd.label, NW - 33 - 8, 12, 2, true), { size: 12, weight: 700, fill: nd.status === "todo" ? INK : st.ink, lh: 14.5 });
      if (days) cards += `<rect x="${n(x + NW - 10 - dw)}" y="${n(y - 7.5)}" width="${n(dw)}" height="15" rx="7.5" fill="#fff" stroke="${isCrit ? INK : "#d6dcd9"}"/>${txt(x + NW - 10 - dw / 2, y, [days], { size: 10, weight: 750, fill: MUTED, anchor: "middle" })}`;
    });
    // Legend: the states that occur, and the critical path when there is one.
    const present = (["done", "active", "blocked", "todo"] as DepStatus[]).filter(k => nodes.some(nd => nd.status === k));
    const names: Record<DepStatus, string> = { done: T("Done", "완료"), active: T("In progress", "진행 중"), blocked: T("Blocked", "막힘"), todo: T("To do", "예정") };
    const entries = [...present.map(k => ({ k: k as DepStatus | "crit", t: names[k as DepStatus] })), ...(crit.size ? [{ k: "crit" as const, t: T("Critical path", "핵심 경로") }] : [])];
    const widths = entries.map(e => 24 + tw(e.t, 11.5, true) + 18), legendW = widths.reduce((sum, w) => sum + w, 0);
    const drawW = LR ? PAD * 2 + 12 + L * NW + (L - 1) * GAP : vEnd + PAD + 8, drawH = LR ? vEnd + PAD + 8 : PAD + 12 + L * NH + (L - 1) * GAP;
    const W = Math.max(drawW, legendW + 2 * PAD), ox = (W - drawW) / 2, ly = drawH + 22;
    let lx = (W - legendW) / 2, legend = "";
    entries.forEach((e, i) => {
      legend += e.k === "crit" ? `<path d="M${n(lx)},${n(ly)}H${n(lx + 18)}" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>` : statusIcon(e.k, lx + 8, ly).replace(/r="7\.5"/g, 'r="6.5"').replace(/r="6\.8"/g, 'r="6"');
      legend += txt(lx + 24, ly, [e.t], { size: 11.5, weight: 650, fill: MUTED });
      lx += widths[i];
    });
    return svg(W, ly + 14, `<g transform="translate(${n(ox)},0)">${plain}${strong}${cards}</g>${legend}`, { title: b.title, defs });
  },
  summary: b => {
    const { nodes, edges, crit } = depModel(b.tasks, b.critical), count = (s: DepStatus) => nodes.filter(nd => nd.status === s).length;
    const path = [...crit].sort((p, q) => p - q).map(i => nodes[i].label);
    return `${b.title ?? "Dependency graph"}: ${nodes.length} tasks, ${edges.length} dependencies (${count("done")} done, ${count("active")} in progress, ${count("blocked")} blocked, ${count("todo")} to do).${path.length ? ` Critical path: ${path.join(" → ")}.` : ""}`.slice(0, 400);
  },
  css: baseCss("dependency_graph"),
});

export const ASSETS: readonly AnyAsset[] = [layeredArchitecture, erDiagram, dependencyGraph];
