import { z } from "zod";
import { optionalNum, optionalText, text, list } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { BLUE, EDGE, FAINT, INK, INK2, LINE, MUTED, SLATE, WHITE, aliased, baseCss, fit, hue, initials, keyOf, labelled, n, optList, resolver, svg, tw, txt, widest, wrap, type Hue } from "./_layout-b";

/* ================================================================== org_chart */

const person = aliased(
  { name: text(40), role: optionalText(60), id: optionalText(24), parent: optionalText(40), team: optionalText(20) },
  { name: ["label", "person"], role: ["title", "position", "job"], parent: ["reports_to", "reportsTo", "manager", "boss", "parent_id", "parentId", "reports"], team: ["department", "group", "unit"] },
);
interface OrgNode { name: string; role?: string; team?: string; parent: number; kids: number[]; depth: number }

/** The people as a forest: duplicates dropped, a parent found by id or by name, a dangling parent or a cycle turned into a root. */
function orgTree(people: ReadonlyArray<{ name: string; role?: string; id?: string; parent?: string; team?: string }>): OrgNode[] {
  const nodes: OrgNode[] = [], seenKeys = new Set<string>(), ids: [string, number][] = [], names: [string, number][] = [], ref: (string | undefined)[] = [];
  for (const p of people) {
    const key = keyOf(p.id ?? p.name);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    ids.push([p.id ?? p.name, nodes.length]); names.push([p.name, nodes.length]);
    nodes.push({ name: p.name, role: p.role, team: p.team, parent: -1, kids: [], depth: 0 });
    ref.push(p.parent);
  }
  const find = resolver([...ids, ...names]);
  nodes.forEach((nd, i) => { const r = ref[i], j = r ? find(r) : -1; nd.parent = j === i ? -1 : j; });
  for (let i = 0; i < nodes.length; i++) { // each node has one parent, so a cycle is a closed walk: cut it at its lowest index
    const path: number[] = [], seen = new Set<number>();
    let v = i;
    while (v >= 0 && !seen.has(v)) { seen.add(v); path.push(v); v = nodes[v].parent; }
    if (v >= 0) nodes[Math.min(...path.slice(path.indexOf(v)))].parent = -1;
  }
  nodes.forEach((nd, i) => { if (nd.parent >= 0) nodes[nd.parent].kids.push(i); });
  nodes.forEach(nd => { let d = 0, v = nd.parent; while (v >= 0) { d++; v = nodes[v].parent; } nd.depth = d; });
  return nodes;
}

const ONW = 184, ONH = 62, OGX = 14, OGY = 34, OIND = 26, OHG = 10;
function orgLayout(nodes: OrgNode[], hang: boolean) {
  const isHang = (i: number) => hang && nodes[i].kids.length >= 2 && nodes[i].kids.every(k => nodes[k].kids.length === 0);
  const memo = new Map<number, number>();
  const widthOf = (i: number): number => {
    const known = memo.get(i);
    if (known !== undefined) return known;
    const w = isHang(i) ? ONW + OIND : !nodes[i].kids.length ? ONW : Math.max(ONW, nodes[i].kids.reduce((s, k) => s + widthOf(k), 0) + OGX * (nodes[i].kids.length - 1));
    memo.set(i, w);
    return w;
  };
  const pos = nodes.map(() => ({ x: 0, y: 0 }));
  const place = (i: number, left: number, depth: number) => {
    const y = depth * (ONH + OGY), kids = nodes[i].kids;
    if (isHang(i)) { pos[i] = { x: left, y }; kids.forEach((k, j) => { pos[k] = { x: left + OIND, y: y + ONH + 14 + j * (ONH + OHG) }; }); return; }
    if (!kids.length) { pos[i] = { x: left, y }; return; }
    const total = kids.reduce((s, k) => s + widthOf(k), 0) + OGX * (kids.length - 1);
    let cx = left + (widthOf(i) - total) / 2;
    for (const k of kids) { place(k, cx, depth + 1); cx += widthOf(k) + OGX; }
    pos[i] = { x: (pos[kids[0]].x + pos[kids[kids.length - 1]].x) / 2, y };
  };
  let cursor = 0;
  for (const r of nodes.map((_, i) => i).filter(i => nodes[i].parent < 0)) { place(r, cursor, 0); cursor += widthOf(r) + OGX * 2; }
  return { pos, isHang, width: Math.max(ONW, cursor - OGX * 2), height: Math.max(ONH, ...pos.map(p => p.y + ONH)) };
}

export const orgChart = defineAsset({
  type: "org_chart", category: "diagram", width: "full",
  use: "Who reports to whom: a top-down organisation chart of up to 14 people with roles and team colours.",
  useKo: "누가 누구에게 보고하는지 보여주는 위에서 아래로 내려가는 조직도(최대 14명, 직함·팀 색).",
  tags: ["org chart", "organization", "hierarchy", "reporting", "team structure", "조직도", "직급", "보고 체계", "팀 구조"],
  notes: "Each person: name, optional role, id and parent (the manager's id or name; leave it out for the top person), optional team (colour). Up to 14 people.",
  fields: { people: list(person, 1, 14) },
  sample: { title: "Product company, leadership and leads", people: [
    { id: "ceo", name: "Priya Raman", role: "Chief Executive Officer", team: "Executive" },
    { id: "cto", name: "Daniel Okafor", role: "Chief Technology Officer", parent: "ceo", team: "Engineering" },
    { id: "cfo", name: "Mei Lin Wong", role: "Chief Financial Officer", parent: "ceo", team: "Finance" },
    { id: "cpo", name: "Sofia Alvarez", role: "Chief Product Officer", parent: "ceo", team: "Product" },
    { id: "coo", name: "Marcus Bell", role: "Chief Operating Officer", parent: "ceo", team: "Operations" },
    { id: "e1", name: "Arjun Mehta", role: "Platform Lead", parent: "cto", team: "Engineering" },
    { id: "e2", name: "Lena Fischer", role: "Mobile Lead", parent: "cto", team: "Engineering" },
    { id: "e3", name: "Yuki Tanaka", role: "Data Lead", parent: "cto", team: "Engineering" },
    { id: "f1", name: "Tomás Rivera", role: "Controller", parent: "cfo", team: "Finance" },
    { id: "f2", name: "Grace Obi", role: "FP&A Manager", parent: "cfo", team: "Finance" },
    { id: "p1", name: "Hannah Kim", role: "Design Lead", parent: "cpo", team: "Product" },
    { id: "p2", name: "Omar Haddad", role: "Research Lead", parent: "cpo", team: "Product" },
    { id: "o1", name: "Nora Lindqvist", role: "Support Lead", parent: "coo", team: "Operations" },
    { id: "o2", name: "Ravi Shah", role: "Operations Analyst", parent: "coo", team: "Operations" },
  ] },
  render(b) {
    const nodes = orgTree(b.people);
    let lay = orgLayout(nodes, false);
    if (lay.width > 840) lay = orgLayout(nodes, true);
    const { pos, isHang } = lay;
    // Colour: the named team, else the top-level branch the person belongs to.
    const teamOrder: string[] = [], teamIndex = (t: string) => { const k = keyOf(t); if (!teamOrder.includes(k)) teamOrder.push(k); return teamOrder.indexOf(k); };
    const hasTeams = nodes.some(nd => nd.team);
    const depth1 = nodes.map((_, i) => i).filter(i => nodes[i].depth === 1);
    const branchOf = (i: number) => { let v = i; while (nodes[v].depth > 1) v = nodes[v].parent; return v; };
    const hueOf = (i: number): Hue => (hasTeams ? (nodes[i].team ? hue(teamIndex(nodes[i].team as string)) : SLATE) : nodes[i].depth === 0 ? BLUE : hue(depth1.indexOf(branchOf(i))));
    const hues = nodes.map((_, i) => hueOf(i));
    const roots = nodes.map(nd => nd.parent < 0);
    const teams = hasTeams ? [...new Map(nodes.filter(nd => nd.team).map(nd => [keyOf(nd.team as string), nd.team as string])).values()] : [];
    const showLegend = teams.length > 1;
    // Connectors first, so the cards sit on top of them.
    let lines = "";
    const R = 7, stroke = `fill="none" stroke="${EDGE}" stroke-width="1.6" stroke-linecap="round"`;
    nodes.forEach((nd, i) => {
      if (!nd.kids.length) return;
      if (isHang(i)) {
        const sx = pos[i].x + 13, py = pos[i].y + ONH;
        for (const k of nd.kids) { const my = pos[k].y + ONH / 2; lines += `<path d="M${n(sx)},${n(py)}V${n(my - R)}Q${n(sx)},${n(my)} ${n(sx + R)},${n(my)}H${n(pos[k].x)}" ${stroke}/>`; }
        return;
      }
      const px = pos[i].x + ONW / 2, py = pos[i].y + ONH, my = py + OGY / 2;
      for (const k of nd.kids) {
        const cx = pos[k].x + ONW / 2, cy = pos[k].y;
        if (Math.abs(cx - px) < 1) lines += `<path d="M${n(px)},${n(py)}V${n(cy)}" ${stroke}/>`;
        else { const s = cx > px ? 1 : -1, r = Math.min(R, Math.abs(cx - px) / 2); lines += `<path d="M${n(px)},${n(py)}V${n(my - r)}Q${n(px)},${n(my)} ${n(px + s * r)},${n(my)}H${n(cx - s * r)}Q${n(cx)},${n(my)} ${n(cx)},${n(my + r)}V${n(cy)}" ${stroke}/>`; }
      }
    });
    const cards = nodes.map((nd, i) => {
      const { x, y } = pos[i], h = hues[i], top = roots[i] && nd.kids.length > 0, tx = x + 52, mw = ONW - 52 - 10;
      const role = nd.role ? wrap(nd.role, mw, 11, 2) : [], hb = 16 + (role.length ? 3 + role.length * 13 : 0), t0 = y + (ONH - hb) / 2;
      return `<rect x="${n(x)}" y="${n(y + 2)}" width="${ONW}" height="${ONH}" rx="11" fill="${INK}" fill-opacity=".06"/><rect x="${n(x)}" y="${n(y)}" width="${ONW}" height="${ONH}" rx="11" fill="${top ? INK : WHITE}" stroke="${top ? INK : LINE}"/>`
        + `<circle cx="${n(x + 26)}" cy="${n(y + ONH / 2)}" r="16" fill="${top ? "#fff" : h.soft}" fill-opacity="${top ? ".16" : "1"}" stroke="${top ? "#fff" : h.edge}" stroke-opacity="${top ? ".3" : "1"}"/>`
        + txt(x + 26, y + ONH / 2, [initials(nd.name)], { size: 11.5, weight: 800, fill: top ? WHITE : h.ink, anchor: "middle" })
        + txt(tx, t0 + 8, [fit(nd.name, mw, 13, true)], { size: 13, weight: 750, fill: top ? WHITE : INK })
        + (role.length ? txt(tx, t0 + 19 + (role.length * 13) / 2, role, { size: 11, weight: 550, fill: top ? "#c3ccc8" : MUTED, lh: 13 }) : "");
    }).join("");
    // Legend of teams, centred under the chart.
    let legend = "", H = lay.height;
    if (showLegend) {
      const items = teams.map((t, i) => ({ t: fit(t, 120, 11.5, true), h: hue(i) })), widths = items.map(it => 18 + tw(it.t, 11.5, true) + 16), total = widths.reduce((s, v) => s + v, 0);
      let lx = (lay.width - total) / 2 + 4;
      legend = items.map((it, i) => { const out = `<circle cx="${n(lx + 5)}" cy="${n(H + 30)}" r="5" fill="${it.h.solid}"/>${txt(lx + 16, H + 30, [it.t], { size: 11.5, weight: 650, fill: MUTED })}`; lx += widths[i]; return out; }).join("");
      H += 44;
    }
    return svg(lay.width + 2, H + 4, `<g transform="translate(1,1)">${lines}${cards}${legend}</g>`, { title: b.title });
  },
  summary: b => {
    const nodes = orgTree(b.people), roots = nodes.map((nd, i) => i).filter(i => nodes[i].parent < 0), depth = Math.max(...nodes.map(nd => nd.depth)) + 1;
    const head = roots.slice(0, 2).map(r => { const nd = nodes[r], reports = nd.kids.map(k => `${nodes[k].name}${nodes[k].role ? ` (${nodes[k].role})` : ""}`); return `${nd.name}${nd.role ? ` (${nd.role})` : ""}${reports.length ? ` has ${reports.length} direct report${reports.length === 1 ? "" : "s"}: ${reports.slice(0, 6).join(", ")}` : ""}`; }).join("; ");
    return `${b.title ?? "Org chart"}: ${nodes.length} people over ${depth} level${depth === 1 ? "" : "s"}. ${head}.`.slice(0, 400);
  },
  css: baseCss("org_chart"),
});

/* ================================================================== mind_map */

const branch = aliased(
  { label: text(30), children: optList(labelled(36), 3) },
  { label: ["name", "title", "text", "topic"], children: ["items", "nodes", "leaves", "subtopics", "points", "details", "sub"] },
);

export const mindMap = defineAsset({
  type: "mind_map", category: "diagram", width: "full",
  use: "A central topic with three to six coloured branches and up to three sub-points each, to open up an idea or plan.",
  useKo: "중심 주제에서 3~6개의 색 가지와 가지당 최대 3개의 하위 항목으로 아이디어를 펼치는 마인드맵.",
  tags: ["mind map", "brainstorm", "topic", "branches", "ideas", "마인드맵", "브레인스토밍", "아이디어", "가지"],
  notes: "topic is the centre; each branch has a label and up to 3 short children (strings). Six branches at most; they are laid out clockwise from the top right.",
  fields: { topic: text(40), branches: list(branch, 1, 6) },
  sample: { title: "Launching a newsletter", topic: "Launch a newsletter", branches: [
    { label: "Audience", children: ["Existing customers", "Industry peers", "Community members"] },
    { label: "Content", children: ["Weekly insight", "Case study", "Reader Q&A"] },
    { label: "Growth", children: ["Referral loop", "Social snippets"] },
    { label: "Tools", children: ["Email platform", "Analytics"] },
    { label: "Schedule", children: ["Tuesday morning", "Draft by Friday"] },
    { label: "Metrics", children: ["Open rate", "Click rate", "Unsubscribes"] },
  ] },
  render(b) {
    const MW = 156, BW = 126, LW = 138, G1 = 40, G2 = 30, PAD = 16, GAP = 14;
    const topicLines = wrap(b.topic, MW - 26, 14, 3, true), TH = Math.max(50, topicLines.length * 18 + 20);
    const items = b.branches.map((br, i) => {
      const lab = wrap(br.label, BW - 20, 12.5, 2, true), bh = lab.length > 1 ? 44 : 32;
      const leaves = br.children.map(c => wrap(c, LW - 4, 12, 2)), lh = leaves.map(l => l.length * 15 + 10);
      const leafTotal = lh.reduce((s, v) => s + v, 0) + Math.max(0, lh.length - 1) * 2;
      return { lab, bh, leaves, lh, leafTotal, h: hue(i), block: Math.max(bh, leafTotal) };
    });
    const k = Math.ceil(items.length / 2), right = items.slice(0, k), left = items.slice(k).reverse(); // clockwise from the top right
    const sideH = (side: typeof items) => side.reduce((s, it) => s + it.block, 0) + Math.max(0, side.length - 1) * GAP;
    const anyLeaf = items.some(it => it.leaves.length > 0), half = MW / 2 + G1 + BW + (anyLeaf ? G2 + LW : 0);
    const W = 2 * (half + PAD), H = Math.max(TH + 24, sideH(right), sideH(left)) + 2 * PAD, cx = W / 2, cy = H / 2;
    let curves = "", shapes = "";
    const side = (list: typeof items, dir: 1 | -1) => {
      let y = cy - sideH(list) / 2;
      for (const it of list) {
        const byc = y + it.block / 2, bx = dir > 0 ? cx + MW / 2 + G1 : cx - MW / 2 - G1 - BW, near = dir > 0 ? bx : bx + BW, far = dir > 0 ? bx + BW : bx, sx = cx + dir * (MW / 2 - 6);
        curves += `<path d="M${n(sx)},${n(cy)}C${n(sx + dir * 30)},${n(cy)} ${n(near - dir * 30)},${n(byc)} ${n(near)},${n(byc)}" fill="none" stroke="${it.h.solid}" stroke-width="3.6" stroke-linecap="round"/>`;
        shapes += `<rect x="${n(bx)}" y="${n(byc - it.bh / 2)}" width="${BW}" height="${it.bh}" rx="${it.bh / 2}" fill="${it.h.solid}"/>${txt(bx + BW / 2, byc, it.lab, { size: 12.5, weight: 750, fill: WHITE, anchor: "middle" })}`;
        let ly = byc - it.leafTotal / 2;
        it.leaves.forEach((lines, j) => {
          const top = ly, tx = dir > 0 ? far + G2 : far - G2, base = top + lines.length * 15 + 3, uw = Math.min(LW, widest(lines, 12) + 8);
          curves += `<path d="M${n(far)},${n(byc)}C${n(far + dir * 18)},${n(byc)} ${n(tx - dir * 18)},${n(base)} ${n(tx)},${n(base)}H${n(tx + dir * uw)}" fill="none" stroke="${it.h.solid}" stroke-opacity=".7" stroke-width="1.7" stroke-linecap="round"/>`;
          shapes += txt(tx + dir * 2, top + (lines.length * 15) / 2, lines, { size: 12, weight: 550, fill: INK2, anchor: dir > 0 ? "start" : "end", lh: 15 });
          ly += it.lh[j] + 2;
        });
        y += it.block + GAP;
      }
    };
    side(right, 1); side(left, -1);
    const topic = `<rect x="${n(cx - MW / 2)}" y="${n(cy - TH / 2)}" width="${MW}" height="${TH}" rx="${Math.min(TH / 2, 28)}" fill="${INK}"/>${txt(cx, cy, topicLines, { size: 14, weight: 800, fill: WHITE, anchor: "middle", lh: 18 })}`;
    return svg(W, H, `${curves}${topic}${shapes}`, { title: b.title });
  },
  summary: b => `${b.title ?? "Mind map"}: ${b.topic} — ${b.branches.map(br => `${br.label}${br.children.length ? ` (${br.children.join(", ")})` : ""}`).join("; ")}.`.slice(0, 400),
  css: baseCss("mind_map"),
});

/* ================================================================== tree_diagram */

const kind = z.preprocess(v => {
  if (typeof v !== "string") return undefined;
  const k = v.trim().toLowerCase();
  return /^(folder|dir|directory|group|category|branch)$/.test(k) ? "folder" : /^(file|doc|document|leaf)$/.test(k) ? "file" : /^(item|node|entry)$/.test(k) ? "item" : undefined;
}, z.enum(["folder", "file", "item"]).optional());
const level = z.preprocess(v => { const x = typeof v === "string" ? Number(v) : v; return typeof x === "number" && Number.isFinite(x) ? Math.round(x) : 0; }, z.number());
const treeNode = aliased(
  { label: text(40), level, count: optionalText(12), kind },
  { label: ["name", "text", "title"], level: ["depth", "indent", "lvl"], count: ["size", "n", "total", "value"] },
);

export const treeDiagram = defineAsset({
  type: "tree_diagram", category: "diagram", width: "half",
  use: "A hierarchy written as indented rows with connector lines and optional counts: a taxonomy, a category tree or a file tree.",
  useKo: "분류 체계·카테고리·파일 트리를 들여쓴 행과 연결선, 선택 개수로 보여주는 계층 트리.",
  tags: ["tree", "taxonomy", "hierarchy", "file tree", "categories", "트리", "계층", "분류", "파일 구조"],
  notes: "nodes in reading order, each with level (0 = root, 1 = its child, ...) and an optional short count such as \"1,240\". Up to 24 rows; levels deeper than 5 are flattened to 5.",
  fields: { nodes: list(treeNode, 1, 24) },
  sample: { title: "Product catalog by category", nodes: [
    { label: "Catalog", level: 0, count: "3,420" },
    { label: "Electronics", level: 1, count: "1,240" },
    { label: "Phones", level: 2, count: "420" },
    { label: "Android", level: 3, count: "260" },
    { label: "iOS", level: 3, count: "160" },
    { label: "Laptops", level: 2, count: "310" },
    { label: "Audio", level: 2, count: "510" },
    { label: "Home", level: 1, count: "980" },
    { label: "Kitchen", level: 2, count: "540" },
    { label: "Furniture", level: 2, count: "440" },
    { label: "Apparel", level: 1, count: "1,200" },
    { label: "Men", level: 2, count: "520" },
    { label: "Women", level: 2, count: "680" },
  ] },
  render(b) {
    const W = 460, ROW = 32, CH = 24, X0 = 14, IND = 26, rows = b.nodes.length;
    const lv: number[] = [];
    b.nodes.forEach((nd, i) => { lv.push(i === 0 ? 0 : Math.max(0, Math.min(5, Math.min(nd.level, lv[i - 1] + 1)))); });
    const parent = lv.map((l, i) => { for (let j = i - 1; j >= 0; j--) if (lv[j] < l) return j; return -1; });
    const hasKids = lv.map((l, i) => i + 1 < rows && lv[i + 1] > l);
    const countW = Math.max(0, ...b.nodes.map(nd => (nd.count ? tw(nd.count, 12, true) : 0))), colW = countW ? countW + 16 : 0, rx = W - X0;
    const yc = (i: number) => 14 + i * ROW + ROW / 2, cxOf = (i: number) => X0 + lv[i] * IND;
    const level = (l: number): { fill: string; edge: string; ink: string; icon: string } => (l === 0 ? { fill: INK, edge: INK, ink: WHITE, icon: "#c3ccc8" } : l === 1 ? { fill: "#e9effc", edge: "#bccdf5", ink: "#1f46a8", icon: "#2f5fd6" } : l === 2 ? { fill: "#e4f2ec", edge: "#acd8c4", ink: "#0b6a45", icon: "#118558" } : { fill: "#f4f5f4", edge: "#dde1de", ink: INK2, icon: MUTED });
    let lines = "", chips = "";
    b.nodes.forEach((nd, i) => {
      const p = parent[i];
      if (p >= 0) { const sx = cxOf(p) + 13, my = yc(i), r = 6; lines += `<path d="M${n(sx)},${n(yc(p) + CH / 2)}V${n(my - r)}Q${n(sx)},${n(my)} ${n(sx + r)},${n(my)}H${n(cxOf(i))}" fill="none" stroke="${EDGE}" stroke-width="1.5" stroke-linecap="round"/>`; }
      const c = level(lv[i]), x = cxOf(i), avail = rx - colW - x - 8, label = fit(nd.label, avail - 32, 12.5, true), cw = Math.min(avail, 28 + tw(label, 12.5, true) + 8), y = yc(i);
      const k = nd.kind ?? (hasKids[i] ? "folder" : "item");
      const icon = k === "folder" ? `<path transform="translate(${n(x + 8)},${n(y - 5.5)})" d="M0,2.5A1.5,1.5 0 0 1 1.5,1H4.8L6.4,2.8H11.5A1.5,1.5 0 0 1 13,4.3V9.5A1.5,1.5 0 0 1 11.5,11H1.5A1.5,1.5 0 0 1 0,9.5Z" fill="${c.icon}" fill-opacity=".9"/>`
        : k === "file" ? `<path transform="translate(${n(x + 9.5)},${n(y - 6)})" d="M0,1.5A1.5,1.5 0 0 1 1.5,0H6L10,4V10.5A1.5,1.5 0 0 1 8.5,12H1.5A1.5,1.5 0 0 1 0,10.5Z" fill="none" stroke="${c.icon}" stroke-width="1.4" stroke-linejoin="round"/>`
        : `<circle cx="${n(x + 14)}" cy="${n(y)}" r="3.2" fill="${c.icon}"/>`;
      chips += `<rect x="${n(x)}" y="${n(y - CH / 2)}" width="${n(cw)}" height="${CH}" rx="8" fill="${c.fill}" stroke="${c.edge}"/>${icon}${txt(x + 28, y, [label], { size: 12.5, weight: 650, fill: c.ink })}`;
      if (nd.count) chips += `<line x1="${n(x + cw + 8)}" x2="${n(rx - colW + 4)}" y1="${n(y)}" y2="${n(y)}" stroke="#dfe3e0" stroke-width="1.5" stroke-dasharray="1 5" stroke-linecap="round"/>${txt(rx, y, [nd.count], { size: 12, weight: 700, fill: MUTED, anchor: "end" })}`;
    });
    return svg(W, 28 + rows * ROW, `${lines}${chips}`, { title: b.title });
  },
  summary: b => {
    const roots = b.nodes.filter(nd => nd.level <= 0), top = b.nodes.filter(nd => nd.level === 1).slice(0, 6);
    return `${b.title ?? "Tree"}: ${roots[0]?.label ?? b.nodes[0].label}${roots[0]?.count ? ` (${roots[0].count})` : ""} with ${b.nodes.length} entries${top.length ? `; first level: ${top.map(t => `${t.label}${t.count ? ` ${t.count}` : ""}`).join(", ")}` : ""}.`.slice(0, 400);
  },
  css: baseCss("tree_diagram"),
});

/* ================================================================== network_graph */

const netNode = aliased({ id: text(24), label: optionalText(28), group: optionalText(20) }, { id: ["name", "label", "key"], label: ["name"], group: ["team", "cluster", "type", "category", "community"] });
const netLink = aliased({ from: text(24), to: text(24), weight: optionalNum }, { from: ["source", "src", "a"], to: ["target", "dst", "b"], weight: ["value", "strength", "w", "count"] });

/** Order of the ring: groups in the permutation, and inside a group the neighbours, that make the weighted chord length shortest. Deterministic. */
function ringOrder(count: number, group: number[], links: { a: number; b: number; w: number }[], skip: number): number[] {
  const ids = Array.from({ length: count }, (_, i) => i).filter(i => i !== skip), groups = [...new Set(ids.map(i => group[i]))];
  const slots = (order: number[]) => { const at = new Map<number, number>(); let s = 0; order.forEach((id, k) => { if (k && group[id] !== group[order[k - 1]]) s += 0.8; at.set(id, s); s += 1; }); return { at, total: s + (groups.length > 1 ? 0.8 : 0) }; };
  const cost = (order: number[]) => { const { at, total } = slots(order); let c = 0; for (const l of links) { const p = at.get(l.a), q = at.get(l.b); if (p === undefined || q === undefined) continue; c += l.w * Math.abs(Math.sin((Math.PI * (p - q)) / total)); } return c; };
  const members = (g: number) => ids.filter(i => group[i] === g);
  const perms = (arr: number[]): number[][] => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map(rest => [x, ...rest])));
  let best = groups.flatMap(members), bestCost = cost(best);
  if (groups.length > 1 && groups.length <= 6) for (const perm of perms(groups)) { const order = perm.flatMap(members), c = cost(order); if (c < bestCost - 1e-9) { best = order; bestCost = c; } }
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i + 1 < best.length; i++) {
      if (group[best[i]] !== group[best[i + 1]]) continue;
      const trial = [...best]; [trial[i], trial[i + 1]] = [trial[i + 1], trial[i]];
      const c = cost(trial);
      if (c < bestCost - 1e-9) { best = trial; bestCost = c; moved = true; }
    }
    if (!moved) break;
  }
  return best;
}

export const networkGraph = defineAsset({
  type: "network_graph", category: "diagram", width: "two_thirds",
  use: "Who or what is connected to whom: a network of up to 16 nodes in coloured groups, weighted links and a highlighted hub.",
  useKo: "최대 16개 노드가 그룹 색·연결 강도·중심 허브와 함께 어떻게 연결되는지 보여주는 네트워크 그래프.",
  tags: ["network", "graph", "relationships", "connections", "hub", "네트워크", "관계도", "연결", "허브"],
  notes: "nodes with an id and an optional label and group; links with from, to and an optional weight. Links to unknown ids are ignored. The best-connected node is drawn as the hub.",
  fields: { nodes: list(netNode, 2, 16), links: list(netLink, 0, 24) },
  sample: { title: "Who works with whom on the launch", nodes: [
    { id: "maya", label: "Maya (PM)", group: "Product" }, { id: "ben", label: "Ben", group: "Product" }, { id: "ines", label: "Inés", group: "Product" },
    { id: "kofi", label: "Kofi", group: "Engineering" }, { id: "li", label: "Li", group: "Engineering" }, { id: "sara", label: "Sara", group: "Engineering" }, { id: "jun", label: "Jun", group: "Engineering" },
    { id: "ana", label: "Ana", group: "Design" }, { id: "theo", label: "Theo", group: "Design" },
    { id: "zoe", label: "Zoe", group: "Marketing" }, { id: "raj", label: "Raj", group: "Marketing" }, { id: "eli", label: "Eli", group: "Marketing" },
  ], links: [
    { from: "maya", to: "ben", weight: 8 }, { from: "maya", to: "ines", weight: 5 }, { from: "maya", to: "kofi", weight: 9 }, { from: "maya", to: "li", weight: 6 },
    { from: "maya", to: "ana", weight: 7 }, { from: "maya", to: "zoe", weight: 6 }, { from: "maya", to: "sara", weight: 3 },
    { from: "kofi", to: "li", weight: 8 }, { from: "kofi", to: "sara", weight: 5 }, { from: "li", to: "jun", weight: 4 }, { from: "sara", to: "jun", weight: 6 },
    { from: "ana", to: "theo", weight: 9 }, { from: "ana", to: "kofi", weight: 4 }, { from: "theo", to: "ben", weight: 3 },
    { from: "zoe", to: "raj", weight: 7 }, { from: "raj", to: "eli", weight: 5 }, { from: "zoe", to: "eli", weight: 6 }, { from: "ines", to: "zoe", weight: 4 },
  ] },
  render(b, { T }) {
    const { nodes, links, hub } = netModel(b.nodes, b.links);
    const groupNames = [...new Map(nodes.map(nd => [keyOf(nd.group), nd.group])).values()], gi = nodes.map(nd => groupNames.findIndex(g => keyOf(g) === keyOf(nd.group)));
    const useHub = hub >= 0, order = ringOrder(nodes.length, gi, links, useHub ? hub : -1);
    const W = 640, rx = 172, ry = 148, H = 2 * (ry + 44) + 30, cx = W / 2, cy = (H - 30) / 2;
    const groupsWithGaps = new Set(order.map(i => gi[i])).size;
    const at = new Map<number, { x: number; y: number; a: number }>(); let s = 0;
    const total = order.length + (groupsWithGaps > 1 ? 0.8 * groupsWithGaps : 0);
    order.forEach((id, k) => { if (k && gi[id] !== gi[order[k - 1]]) s += 0.8; const a = -Math.PI / 2 + (2 * Math.PI * (s + 0.4 + 0.5)) / total; at.set(id, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), a }); s += 1; });
    if (useHub) at.set(hub, { x: cx, y: cy, a: 0 });
    const maxDeg = Math.max(1, ...nodes.map(nd => nd.degree)), maxW = Math.max(...links.map(l => l.w), 1);
    const radius = (i: number) => 8 + 11 * Math.sqrt(nodes[i].degree / maxDeg) + (i === hub ? 3 : 0);
    const multi = groupNames.length > 1;
    const hueOfNode = (i: number): Hue => (multi ? hue(gi[i]) : i === hub ? BLUE : SLATE);
    let edges = "";
    for (const l of [...links].sort((p, q) => p.w - q.w)) {
      const p = at.get(l.a), q = at.get(l.b);
      if (!p || !q) continue;
      const same = gi[l.a] === gi[l.b], color = same && multi ? hue(gi[l.a]).solid : "#8e99a0", sw = 1.2 + (2.8 * l.w) / maxW;
      const bend = l.a === hub || l.b === hub ? 0 : 0.38, mx = (p.x + q.x) / 2 + (cx - (p.x + q.x) / 2) * bend, my = (p.y + q.y) / 2 + (cy - (p.y + q.y) / 2) * bend;
      edges += `<path d="M${n(p.x)},${n(p.y)}Q${n(mx)},${n(my)} ${n(q.x)},${n(q.y)}" fill="none" stroke="${color}" stroke-opacity="${same && multi ? ".5" : ".42"}" stroke-width="${n(sw)}" stroke-linecap="round"/>`;
    }
    let dots = "", labels = "";
    nodes.forEach((nd, i) => {
      const p = at.get(i);
      if (!p) return;
      const h = hueOfNode(i), r = radius(i);
      if (i === hub) dots += `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(r + 7)}" fill="${h.soft}" stroke="${h.edge}" stroke-width="1.5"/>`;
      dots += `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(r)}" fill="${h.solid}" stroke="#fff" stroke-width="2.5"/>`;
      const label = fit(nd.label, 118, 12, i === hub), halo = `stroke="#fff" stroke-width="4" stroke-linejoin="round" paint-order="stroke"`;
      if (i === hub) { labels += txt(p.x, p.y + r + 20, [label], { size: 12.5, weight: 800, fill: INK, anchor: "middle" }).replace("<text ", `<text ${halo} `); return; }
      const c = Math.cos(p.a), sn = Math.sin(p.a), anchor = Math.abs(c) < 0.28 ? "middle" : c > 0 ? "start" : "end", off = r + 7;
      const lx = p.x + (anchor === "middle" ? 0 : Math.sign(c) * off), ly = anchor === "middle" ? p.y + Math.sign(sn) * (off + 6) : p.y + sn * 3;
      labels += txt(lx, ly, [label], { size: 12, weight: 650, fill: INK2, anchor: anchor as "start" | "middle" | "end" });
    });
    // Legend: group colours, and what the line width means.
    const entries = multi ? groupNames.map((g, i) => ({ t: fit(g, 100, 11.5, true), h: hue(i) })) : [];
    const widths = entries.map(e => 18 + tw(e.t, 11.5, true) + 14), note = T("Line width = link weight", "선 굵기 = 연결 강도"), noteW = maxW > 0 && links.some(l => l.w !== links[0]?.w) ? tw(note, 11.5, true) + 8 : 0;
    const totalW = widths.reduce((a, v) => a + v, 0) + noteW;
    let lx = (W - totalW) / 2, legend = "";
    entries.forEach((e, i) => { legend += `<circle cx="${n(lx + 5)}" cy="${H - 10}" r="5" fill="${e.h.solid}"/>${txt(lx + 16, H - 10, [e.t], { size: 11.5, weight: 650, fill: MUTED })}`; lx += widths[i]; });
    if (noteW) legend += txt(lx + 4, H - 10, [note], { size: 11.5, weight: 600, fill: FAINT });
    return svg(W, H, `${edges}${dots}${labels}${legend}`, { title: b.title });
  },
  summary: b => {
    const { nodes, links, hub } = netModel(b.nodes, b.links), groups = [...new Set(nodes.map(nd => nd.group).filter(Boolean))];
    const top = [...nodes].sort((p, q) => q.degree - p.degree).slice(0, 3).map(nd => `${nd.label} (${nd.degree})`);
    return `${b.title ?? "Network"}: ${nodes.length} nodes, ${links.length} links${groups.length > 1 ? `, ${groups.length} groups (${groups.slice(0, 5).join(", ")})` : ""}. ${hub >= 0 ? `Hub: ${nodes[hub].label}. ` : ""}Most connected: ${top.join(", ")}.`.slice(0, 400);
  },
  css: baseCss("network_graph"),
});

/** The graph the network draws: nodes unique by id (first wins), links resolved by id or label, undirected, merged, never to itself. */
function netModel(rawNodes: ReadonlyArray<{ id: string; label?: string; group?: string }>, rawLinks: ReadonlyArray<{ from: string; to: string; weight?: number }>) {
  const nodes: { id: string; label: string; group: string; degree: number }[] = [], seen = new Set<string>();
  for (const nd of rawNodes) {
    if (seen.has(keyOf(nd.id))) continue;
    seen.add(keyOf(nd.id));
    nodes.push({ id: nd.id, label: nd.label ?? nd.id, group: nd.group ?? "", degree: 0 });
  }
  const find = resolver([...nodes.map((nd, i) => [nd.id, i] as [string, number]), ...nodes.map((nd, i) => [nd.label, i] as [string, number])]);
  const merged = new Map<string, { a: number; b: number; w: number }>();
  for (const l of rawLinks) {
    const a = find(l.from), b = find(l.to);
    if (a < 0 || b < 0 || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`, w = Math.max(0.1, Math.abs(l.weight ?? 1)), known = merged.get(key);
    if (known) known.w = Math.max(known.w, w); else merged.set(key, { a: Math.min(a, b), b: Math.max(a, b), w });
  }
  const links = [...merged.values()], strength = nodes.map(() => 0);
  for (const l of links) { nodes[l.a].degree++; nodes[l.b].degree++; strength[l.a] += l.w; strength[l.b] += l.w; }
  let hub = -1;
  if (nodes.length >= 5) nodes.forEach((nd, i) => { if (nd.degree >= 3 && (hub < 0 || nd.degree > nodes[hub].degree || (nd.degree === nodes[hub].degree && strength[i] > strength[hub]))) hub = i; });
  return { nodes, links, hub };
}

export const ASSETS: readonly AnyAsset[] = [orgChart, mindMap, treeDiagram, networkGraph];
