#!/usr/bin/env node
// 작업 블록 줄 규칙 한 벌 — 오너 지시 2026-09-14 ("추론 과정 디스플레이 모듈화, One 것을 쓰라").
//
// 지키는 것(규칙, 코드 모양 아님):
//   1. 연속된 생각은 한 줄로 합쳐 시간을 누적한다; 상태 하트비트는 생각을 끊지 않는다.
//   2. 이름 없는/"unknown" 도구 이벤트는 줄이 되지 않는다(런타임 상태가 그 모양으로 온다).
//   3. 도구 객체는 사람이 읽는 한 줄: 프로젝트 폴더·홈 경로 축약, 96자 상한.
//   4. One 의 셀 빌더도 같은 병합 규칙을 부른다(헤드라인 없는 연속 생각 → 한 칸, 시간 누적).
//   5. Science 사본(agentlas-science/src/turn-activity-rows.ts)은 바이트 동일이다(있을 때만 잰다).
//
// Run: node scripts/qa-turn-activity-rows-contract.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const cache = new Map();
function loadTs(rel) {
  const file = path.join(root, rel);
  if (cache.has(file)) return cache.get(file);
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (request) => {
    if (request.startsWith("@shared/")) return loadTs(`shared/${request.slice("@shared/".length)}.ts`);
    if (request.startsWith("./") && !request.endsWith(".json")) {
      const target = path.relative(root, path.join(path.dirname(file), request));
      const candidate = fs.existsSync(path.join(root, `${target}.ts`)) ? `${target}.ts` : `${target}.tsx`;
      return loadTs(candidate);
    }
    return originalRequire(request);
  };
  cache.set(file, loaded.exports);
  loaded._compile(output, file);
  return loaded.exports;
}

const rows = loadTs("shared/turn-activity-rows.ts");
const turnWork = loadTs("renderer/lib/one-turn-work.ts");
const activity = loadTs("renderer/lib/one-activity.ts");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ✓ ${name}\n`); };
const t0 = Date.parse("2026-09-14T12:00:00.000Z");
const at = (ms) => new Date(t0 + ms).toISOString();

check("consecutive thoughts merge into one row with accumulated time; a status heartbeat between them does not split", () => {
  const out = rows.buildTurnActivityRows([
    { sequence: 1, kind: "reasoning", code: "runtime-thinking", at: at(0), phase: "start" },
    { sequence: 2, kind: "reasoning", code: "runtime-thinking", at: at(400), phase: "end" },
    { sequence: 3, kind: "status", code: "runtime-status", at: at(500), status: "CLI 프로세스 실행 중" },
    { sequence: 4, kind: "reasoning", code: "runtime-thinking", at: at(600), phase: "start" },
    { sequence: 5, kind: "reasoning", code: "runtime-thinking", at: at(1500), phase: "end", durationMs: 900 },
    { sequence: 6, kind: "tool", code: "tool-observed", at: at(2000), toolName: "Bash", toolSummary: "npm test" },
    { sequence: 7, kind: "reasoning", code: "runtime-thinking", at: at(2100), phase: "start" },
    { sequence: 8, kind: "reasoning", code: "runtime-thinking", at: at(2300), phase: "end" },
  ]);
  assert.deepEqual(out.map((row) => row.kind), ["reasoning", "tool", "reasoning"]);
  assert.equal(out[0].durationMs, 1300, "400ms + 900ms accumulate across the heartbeat");
  assert.equal(out[0].code, rows.TURN_ACTIVITY_MERGED_THOUGHT_CODE);
  assert.equal(out[2].durationMs, 200);
});

check("nameless and \"unknown\" tool events never become rows; a real tool keeps its shortened object", () => {
  const out = rows.buildTurnActivityRows([
    { sequence: 1, kind: "tool", code: "tool-observed", at: at(0), toolName: null },
    { sequence: 2, kind: "tool", code: "tool-observed", at: at(1), toolName: "unknown" },
    { sequence: 3, kind: "tool", code: "tool-observed", at: at(2), toolName: "Read", toolSummary: "/Users/researcher/Science/tpa-meta/comparables/  index.md" },
    { sequence: 4, kind: "tool", code: "tool-observed", at: at(3), toolName: "Bash", toolSummary: `UA="Mozilla/5.0 (Macintosh)" curl -sL ${"x".repeat(200)}` },
  ], { cwd: "/Users/researcher/Science/tpa-meta" });
  assert.deepEqual(out.map((row) => row.toolName), ["Read", "Bash"]);
  assert.equal(out[0].toolSummary, "comparables/ index.md", "the project folder prefix is gone and whitespace is collapsed");
  assert.equal(out[1].toolSummary.length, 96, "long shell lines are capped");
  assert.ok(out[1].toolSummary.endsWith("…"));
  assert.equal(rows.shortenToolObject("/home/alice/data/a.csv"), "~/data/a.csv", "home directories collapse to ~ even without options");
});

check("One's cell builder merges headline-less consecutive thoughts through the same helper", () => {
  let state = activity.initialOneActivityState();
  const events = [
    { kind: "reasoning", reasoning: { phase: "start" } },
    { kind: "reasoning", reasoning: { phase: "end", durationMs: 300 } },
    { kind: "reasoning", reasoning: { phase: "start" } },
    { kind: "reasoning", reasoning: { phase: "end", durationMs: 500 } },
    { kind: "reasoning", reasoning: { phase: "start" } },
    { kind: "reasoning", reasoning: { phase: "end", durationMs: 400 } },
    { kind: "tool-use", tool: { name: "Bash", id: "k", args: JSON.stringify({ command: "npm test" }), result: "ok" } },
  ];
  events.forEach((event, index) => { state = activity.reduceOneActivity(state, { sequence: index + 1, observedAt: at(index * 1000), ...event }); });
  const thoughts = state.items.filter((item) => item.kind === "reasoning");
  assert.ok(thoughts.length >= 2, `fixture: the reducer keeps separate thought items (${thoughts.length})`);
  const p = turnWork.buildOneWorkPresentation(state, "ko", null);
  const cells = p.cells.filter((cell) => cell.kind === "thought");
  assert.equal(cells.length, 1, `consecutive headline-less thoughts become one cell (${p.cells.map((c) => c.kind).join(",")})`);
  assert.equal(cells[0].durationMs, 1200, "their durations accumulate");
  assert.equal(turnWork.cellVerb(cells[0], "ko"), "생각함");
});

check("the Science copy of the module is byte-identical (measured only when the checkout is present)", () => {
  const canonical = path.join(root, "shared", "turn-activity-rows.ts");
  const copy = path.resolve(root, "..", "agentlas-science", "src", "turn-activity-rows.ts");
  if (!fs.existsSync(copy)) { process.stdout.write("    (agentlas-science checkout not present — parity not measured here)\n"); return; }
  const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(digest(copy), digest(canonical), "edit shared/turn-activity-rows.ts and copy it to agentlas-science/src/");
});

process.stdout.write(`turn activity rows contract: ${checks} checks passed\n`);
