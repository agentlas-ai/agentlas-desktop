#!/usr/bin/env node
/*
 * 레지스트리 → 사람이 보는 지도 (HTML).
 *
 * 손으로 그린 그림은 반드시 코드와 갈라진다. 이 지도는 레지스트리에서 **생성**되므로
 * 커넥터를 하나 고치면 그림도 같이 바뀐다 — 그림이 거짓말을 할 수 없다.
 *
 *   node scripts/gen-graph-map.cjs [출력경로]
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const reg = (n) => JSON.parse(fs.readFileSync(path.join(root, "shared", "graph-registry", `${n}.json`), "utf8"));
const blocks = reg("blocks");
const connectors = reg("connectors");
const envelopes = reg("envelopes");
const fields = reg("fields");
const errors = reg("errors");

const envById = new Map(envelopes.envelopes.map((e) => [e.id, e]));
const errById = new Map(errors.errors.map((e) => [e.code, e]));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const sides = (v) => String(v ?? "").split("|").map((x) => x.trim()).filter(Boolean);
const live = (s) => s === "implemented";
const val = (v) => esc(v === null ? "null" : v);

const blockTitle = new Map(blocks.blocks.map((b) => [b.kind, b.title]));
const actorTitle = new Map((connectors.actors ?? []).map((a) => [a.id, a.title]));
const nameOf = (id) => blockTitle.get(id) ?? actorTitle.get(id) ?? id;

// ── 전체 그림. 실물 커넥터만 그린다 — 종이 위 선을 그리면 지도가 거짓말한다. ──
const nid = (s) => s.replace(/[^A-Za-z0-9_]/g, "_");
const drawn = new Set();
const edges = [];
for (const c of connectors.connectors) {
  if (!live(c.status)) continue;
  for (const from of sides(c.from)) {
    for (const to of sides(c.to)) {
      const key = `${from}>${to}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      edges.push(`  ${nid(from)}["${nameOf(from)}"] --> ${nid(to)}["${nameOf(to)}"]`);
    }
  }
}

const chip = (status) => `<span class="chip ${live(status) ? "on" : "off"}">${live(status) ? "실물" : "선언만"}</span>`;

function fieldLine(p) {
  return `
          <li>
            <span class="fname">${esc(p.field)}</span>${p.grade ? `<span class="grade ${esc(p.grade)}">${esc(p.grade)}</span>` : ""}
            ${p.values ? `<span class="vals">${p.values.map(val).join(" · ")}</span>` : ""}
            ${p.note ? `<p>${esc(p.note)}</p>` : ""}
          </li>`;
}

function connectorCard(c) {
  const env = envById.get(c.envelope);
  const carries = (env?.payload ?? []).map(fieldLine).join("");
  const returns = (env?.returns ?? []).map(fieldLine).join("");
  const fails = (c.failures ?? []).map((code) => {
    const e = errById.get(code);
    return `<span class="err" title="${esc(e?.note ?? e?.cardKey ?? "")}">${esc(code)}</span>`;
  }).join("");
  return `
      <article class="card${live(c.status) ? "" : " ghost"}" id="${esc(c.id)}">
        <header>
          <span class="cid">${esc(c.id)}</span>
          <h3>${esc(c.title)}</h3>
          ${chip(c.status)}
        </header>
        <p class="wire">
          <span class="end">${esc(sides(c.from).map(nameOf).join(" / "))}</span>
          <span class="arrow" aria-hidden="true"></span>
          <span class="end">${esc(sides(c.to).map(nameOf).join(" / "))}</span>
        </p>
        <p class="env">${esc(c.envelope)}${env?.implementedAs ? `<span class="where">${esc(env.implementedAs)}</span>` : ""}</p>
        ${c.note ? `<p class="why">${esc(c.note)}</p>` : ""}
        ${carries ? `<div class="carries"><h4>건너가는 것</h4><ul>${carries}</ul></div>` : ""}
        ${returns ? `<div class="carries"><h4>돌아오는 것</h4><ul>${returns}</ul></div>` : ""}
        ${fails ? `<p class="fails"><span class="lbl">여기서 나는 실패</span>${fails}</p>` : ""}
      </article>`;
}

const phaseSections = (connectors.phases ?? []).map((ph) => {
  const rows = connectors.connectors.filter((c) => c.phase === ph.id);
  if (!rows.length) return "";
  const liveCount = rows.filter((c) => live(c.status)).length;
  return `
    <section class="phase">
      <header class="phead">
        <h3>${esc(ph.title)}</h3>
        <span class="count">${liveCount}/${rows.length}</span>
        <p>${esc(ph.note)}</p>
      </header>
      ${rows.map(connectorCard).join("")}
    </section>`;
}).join("");

const blockCards = blocks.blocks.map((b) => `
      <article class="block${live(b.status) ? "" : " ghost"}">
        <header><h3>${esc(b.title)}</h3><span class="kind">${esc(b.kind)}</span>${chip(b.status)}</header>
        ${b.note ? `<p class="why">${esc(b.note)}</p>` : ""}
        ${b.owns?.length ? `<p class="owns">${b.owns.map((o) => `<span class="fname">${esc(o)}</span>`).join("")}</p>` : ""}
        <ul class="fns">${(b.functions ?? []).map((fn) => `
          <li>
            <span class="fn">${esc(fn.title)}</span>${chip(fn.status)}
            ${fn.note ? `<p>${esc(fn.note)}</p>` : ""}
            ${(fn.sub ?? []).length ? `<ul>${fn.sub.map((s) => `<li>${esc(s.title)}${chip(s.status)}${s.note ? `<p>${esc(s.note)}</p>` : ""}</li>`).join("")}</ul>` : ""}
          </li>`).join("")}</ul>
      </article>`).join("");

const fieldRows = fields.fields
  .slice()
  .sort((a, b) => (a.on === b.on ? (a.name < b.name ? -1 : 1) : (a.on < b.on ? -1 : 1)))
  .map((f) => `
        <tr class="grade-${esc(f.grade)}">
          <td><span class="fname">${esc(f.name)}</span></td>
          <td class="where">${esc(f.on)}${f.appliesTo ? `<br><span class="applies">${esc(f.appliesTo.join(" · "))}</span>` : ""}</td>
          <td><span class="grade ${esc(f.grade)}">${esc(f.grade)}</span></td>
          <td class="vals-cell">${f.values ? f.values.map((v) => `<span>${val(v)}</span>`).join("") : esc(f.type ?? "")}</td>
          <td>${esc(f.unknown ?? "")}</td>
        </tr>`).join("");

const liveConn = connectors.connectors.filter((c) => live(c.status)).length;

const html = `<title>Agentlas Graph — 블록과 커넥터</title>
<style>
:root {
  --ground: #fbfcfd;
  --panel: #f0f4f7;
  --line: #d5dee6;
  --ink: #101519;
  --ink-2: #5a6874;
  --trace: #0d6f7d;
  --trace-soft: #cfe7ec;
  --critical: #a83428;
  --degradable: #8a5a0d;
  --extension: #6d7a86;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Pretendard", "Apple SD Gothic Neo", "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0d1116;
    --panel: #161c23;
    --line: #262f39;
    --ink: #e3eaf0;
    --ink-2: #92a1af;
    --trace: #46b8c8;
    --trace-soft: #17343b;
    --critical: #e07463;
    --degradable: #cfa252;
    --extension: #8895a2;
  }
}
:root[data-theme="dark"] {
  --ground: #0d1116;
  --panel: #161c23;
  --line: #262f39;
  --ink: #e3eaf0;
  --ink-2: #92a1af;
  --trace: #46b8c8;
  --trace-soft: #17343b;
  --critical: #e07463;
  --degradable: #cfa252;
  --extension: #8895a2;
}
:root[data-theme="light"] {
  --ground: #fbfcfd;
  --panel: #f0f4f7;
  --line: #d5dee6;
  --ink: #101519;
  --ink-2: #5a6874;
  --trace: #0d6f7d;
  --trace-soft: #cfe7ec;
  --critical: #a83428;
  --degradable: #8a5a0d;
  --extension: #6d7a86;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font: 15px/1.7 var(--sans);
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1000px; margin: 0 auto; padding: 40px 20px 96px; }

.masthead { border-bottom: 2px solid var(--ink); padding-bottom: 20px; }
.eyebrow {
  font-family: var(--mono); font-size: 11px; letter-spacing: .16em;
  text-transform: uppercase; color: var(--trace); margin: 0 0 10px;
}
h1 { font-size: clamp(27px, 4.6vw, 38px); line-height: 1.15; margin: 0 0 12px; letter-spacing: -.028em; text-wrap: balance; }
.lede { margin: 0; color: var(--ink-2); max-width: 62ch; }
.lede code { font-family: var(--mono); font-size: 13px; color: var(--ink); }

.stats { display: flex; flex-wrap: wrap; gap: 1px; background: var(--line); border: 1px solid var(--line); margin-top: 24px; }
.stats div { flex: 1 1 140px; background: var(--ground); padding: 12px 14px; }
.stats b { display: block; font-family: var(--mono); font-size: 22px; line-height: 1.25; font-variant-numeric: tabular-nums; }
.stats b i { font-style: normal; color: var(--ink-2); }
.stats span { font-size: 11px; color: var(--ink-2); letter-spacing: .03em; }

.section-head { margin: 56px 0 18px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.section-head h2 { font-size: 20px; margin: 0; letter-spacing: -.018em; }
.section-head p { margin: 7px 0 0; color: var(--ink-2); font-size: 14px; max-width: 64ch; }

.diagram { border: 1px solid var(--line); background: var(--panel); padding: 16px; overflow-x: auto; }

.blocks { display: grid; gap: 10px; }
.block, .card {
  border: 1px solid var(--line); background: var(--panel); padding: 15px 17px;
}
.block.ghost, .card.ghost { background: transparent; border-style: dashed; }
.block > header, .card > header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 7px; }
.block h3, .card h3 { font-size: 15px; margin: 0; letter-spacing: -.012em; }
.card h3 { flex: 1 1 220px; }
.kind { font-family: var(--mono); font-size: 11.5px; color: var(--trace); }

.chip {
  font-family: var(--mono); font-size: 10px; letter-spacing: .07em;
  padding: 2px 7px; border: 1px solid var(--line); color: var(--ink-2); white-space: nowrap;
}
.chip.on { color: var(--trace); border-color: var(--trace); }

.phase { margin-top: 34px; }
.phead {
  display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 10px;
  border-left: 3px solid var(--trace); padding: 1px 0 10px 13px; margin-bottom: 12px;
}
.phead h3 { font-size: 17px; margin: 0; letter-spacing: -.015em; }
.phead p { grid-column: 1 / -1; margin: 5px 0 0; color: var(--ink-2); font-size: 13.5px; max-width: 64ch; }
.count { font-family: var(--mono); font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }

.cid {
  font-family: var(--mono); font-size: 11px; background: var(--ink); color: var(--ground);
  padding: 2px 7px; letter-spacing: .05em;
}
.card.ghost .cid { background: var(--ink-2); }

.wire { display: flex; align-items: center; gap: 10px; margin: 0 0 7px; font-size: 13.5px; flex-wrap: wrap; }
.end { font-weight: 600; }
.arrow { flex: 1 1 40px; min-width: 34px; height: 1px; background: var(--trace); position: relative; }
.arrow::after {
  content: ""; position: absolute; right: -1px; top: -3.5px;
  border-left: 6px solid var(--trace);
  border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent;
}

.env { font-family: var(--mono); font-size: 11.5px; color: var(--trace); margin: 0 0 9px; word-break: break-word; }
.env .where { color: var(--ink-2); margin-left: 10px; }
.why { margin: 0 0 10px; font-size: 13.5px; max-width: 68ch; }

.carries h4 {
  font-family: var(--mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--ink-2); margin: 11px 0 6px; font-weight: 500;
}
.carries ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.carries li { padding-left: 11px; border-left: 2px solid var(--trace-soft); font-size: 13px; }
.carries li p { margin: 2px 0 0; color: var(--ink-2); font-size: 12.5px; max-width: 66ch; }
.fname { font-family: var(--mono); font-size: 12.5px; }
.vals { font-family: var(--mono); font-size: 11px; color: var(--ink-2); margin-left: 7px; }

.grade { font-family: var(--mono); font-size: 10px; letter-spacing: .05em; margin-left: 7px; }
.grade.critical { color: var(--critical); }
.grade.degradable { color: var(--degradable); }
.grade.extension { color: var(--extension); }

.fails { margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.fails .lbl {
  font-family: var(--mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--ink-2); margin-right: 3px;
}
.err { font-family: var(--mono); font-size: 11px; color: var(--critical); border: 1px solid currentColor; padding: 1px 6px; cursor: help; }

.owns { display: flex; flex-wrap: wrap; gap: 5px; margin: 9px 0; }
.owns .fname { border: 1px solid var(--line); padding: 1px 6px; }
.fns { list-style: none; margin: 9px 0 0; padding: 0; display: grid; gap: 8px; }
.fns > li { padding-left: 11px; border-left: 2px solid var(--trace-soft); font-size: 13.5px; }
.fns .fn { font-weight: 600; margin-right: 6px; }
.fns p { margin: 3px 0 0; color: var(--ink-2); font-size: 12.5px; max-width: 66ch; }
.fns ul { list-style: none; margin: 6px 0 0; padding: 0 0 0 10px; display: grid; gap: 4px; font-size: 12.5px; color: var(--ink-2); }

.tablewrap { overflow-x: auto; border: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th {
  background: var(--ground); font-family: var(--mono); font-size: 10px;
  letter-spacing: .12em; text-transform: uppercase; color: var(--ink-2); font-weight: 500;
  text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); white-space: nowrap;
}
td { padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr { border-left: 3px solid transparent; }
tbody tr.grade-critical { border-left-color: var(--critical); }
tbody tr.grade-degradable { border-left-color: var(--degradable); }
tbody tr.grade-extension { border-left-color: var(--extension); }
td.where { color: var(--ink-2); font-size: 12px; }
.applies { font-family: var(--mono); font-size: 10.5px; }
td.vals-cell span {
  font-family: var(--mono); font-size: 11px; display: inline-block;
  border: 1px solid var(--line); padding: 0 5px; margin: 0 3px 3px 0;
}

.tail { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--ink-2); font-size: 12.5px; }
.tail code { font-family: var(--mono); font-size: 12px; color: var(--ink); }
:focus-visible { outline: 2px solid var(--trace); outline-offset: 2px; }
</style>

<div class="wrap">
  <header class="masthead">
    <p class="eyebrow">graph/1 · registry</p>
    <h1>블록과 커넥터</h1>
    <p class="lede">그래프가 무엇으로 이뤄져 있고, 그 사이로 무엇이 건너가는가.
      이 문서는 <code>shared/graph-registry/</code> 에서 <b>생성</b>됩니다 —
      손으로 그린 그림이 아니라서 코드와 갈라질 수 없습니다.</p>
    <div class="stats">
      <div><b>${blocks.blocks.length}</b><span>블록</span></div>
      <div><b>${liveConn}<i>/${connectors.connectors.length}</i></b><span>커넥터 · 실물/전체</span></div>
      <div><b>${envelopes.envelopes.length}</b><span>봉투</span></div>
      <div><b>${fields.fields.length}</b><span>필드</span></div>
      <div><b>${errors.errors.length}</b><span>오류 코드</span></div>
    </div>
  </header>

  <div class="section-head">
    <h2>전체 그림</h2>
    <p>실물로 이어진 것만 그립니다. 선언만 된 선을 그리면 지도가 거짓말을 합니다.</p>
  </div>
  <div class="diagram">
<pre class="mermaid">
graph LR
${edges.join("\n")}
</pre>
  </div>

  <div class="section-head">
    <h2>빌딩블록 ${blocks.blocks.length}종</h2>
    <p>각 블록이 무슨 일을 하고, 어떤 필드를 자기 것으로 가지는가.</p>
  </div>
  <div class="blocks">${blockCards}</div>

  <div class="section-head">
    <h2>커넥터 ${connectors.connectors.length}개</h2>
    <p>번호가 아니라 <b>실행 수명주기</b> 순서로 묶었습니다. 각 커넥터는 무엇이 무엇에게 무엇을 건네고,
      거기서 어떤 실패가 날 수 있는지를 말합니다.</p>
  </div>
  ${phaseSections}

  <div class="section-head">
    <h2>필드 사전 ${fields.fields.length}개</h2>
    <p>등급이 <b>모르는 값을 만났을 때 어떻게 할지</b>를 정합니다.
      <span class="grade critical">critical</span> 거절 ·
      <span class="grade degradable">degradable</span> 그 항목만 강등 ·
      <span class="grade extension">extension</span> 버리지 말고 통과</p>
  </div>
  <div class="tablewrap">
    <table>
      <thead><tr><th>필드</th><th>어디에</th><th>등급</th><th>값</th><th>모르면 어떻게 하나</th></tr></thead>
      <tbody>${fieldRows}</tbody>
    </table>
  </div>

  <p class="tail">
    갱신 <code>node scripts/gen-graph-map.cjs</code> · 검사 <code>npm run test:graph-registry-conformance</code><br>
    레지스트리에 없는 어휘를 코드가 쓰면 게이트가 실패합니다. 그래서 이 지도가 실제보다 성길 수 없습니다.
  </p>
</div>`;

const out = process.argv[2] ?? path.join(root, "..", "graph-map.html");
fs.writeFileSync(out, html);
console.log(`생성: ${out}`);
console.log(`  블록 ${blocks.blocks.length} · 커넥터 ${liveConn}/${connectors.connectors.length} · 봉투 ${envelopes.envelopes.length} · 필드 ${fields.fields.length}`);
