#!/usr/bin/env node
/**
 * 로컬·BYOK 런타임의 도구 왕복 계약 — "일의 크기로 끊지 않는다".
 *
 * 배경: 상한이 8이었다. 읽고·고치고·확인만 해도 서너 번이라, 정상적인 긴 작업이
 * 폭주 방벽에 먼저 닿아 "답에 도달하지 못했습니다"로 통째로 버려졌다. 이 경로는
 * ollama·local-openai·BYOK(사용자 키) 세 런타임이 전부 쓴다.
 *
 * 못박는 계약(구현 문장이 아니라 결과):
 *  1. 막힘의 정의는 횟수가 아니라 **진전 없음**이다 — 같은 도구를 같은 인자로 반복.
 *  2. 도구나 인자가 달라지면 몇 번을 돌든 막힘이 아니다.
 *  3. 폭주 방벽은 남아 있되, 정상적인 긴 작업보다 훨씬 위에 있다.
 *
 * 실행: node scripts/local-tool-loop-progress-contract.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist/electron/runtime/local-tool-loop.js");
if (!fs.existsSync(dist)) {
  console.error(`빌드 산출물이 없다: ${dist}\n먼저 'npx tsc -p electron/tsconfig.json' 을 돌릴 것.`);
  process.exit(2);
}
const { trackToolTurnProgress, toolTurnSignature } = require(dist);

const failures = [];
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}\n       ${error.message}`); }
}

const call = (name, args) => ({ id: "x", type: "function", function: { name, arguments: JSON.stringify(args) } });

/** 도구 호출 열을 실제 판정 함수에 순서대로 먹여, 몇 번째에 막힘으로 서는지 돌려준다. */
function runTurns(turns) {
  let state = { signature: "", identicalTurns: 0 };
  for (let index = 0; index < turns.length; index += 1) {
    const progress = trackToolTurnProgress(state, turns[index]);
    state = { signature: progress.signature, identicalTurns: progress.identicalTurns };
    if (progress.stalled) return index + 1;
  }
  return null;
}

check("서로 다른 도구 왕복 20번은 막힘이 아니다 — 옛 상한 8을 한참 넘는다", () => {
  const turns = Array.from({ length: 20 }, (_, index) => [call("read_file", { path: `file-${index}.ts` })]);
  assert.strictEqual(runTurns(turns), null, "정상적인 긴 작업이 여전히 끊긴다");
});

check("같은 도구라도 인자가 달라지면 진전이다", () => {
  const turns = Array.from({ length: 12 }, (_, index) => [call("search", { query: `q${index}` })]);
  assert.strictEqual(runTurns(turns), null);
});

check("같은 도구를 같은 인자로 반복하면 3번째에 선다", () => {
  const turns = Array.from({ length: 10 }, () => [call("list_dir", { path: "." })]);
  assert.strictEqual(runTurns(turns), 3, "진전 없는 반복이 계속 돈다");
});

check("반복 도중 다른 호출이 끼면 다시 세기 시작한다", () => {
  const same = [call("list_dir", { path: "." })];
  const other = [call("read_file", { path: "a.ts" })];
  assert.strictEqual(runTurns([same, same, other, same, same]), null);
  assert.strictEqual(runTurns([same, same, other, same, same, same]), 6);
});

check("한 턴에 여러 도구를 부르면 그 묶음 전체가 지문이다", () => {
  const pair = [call("read_file", { path: "a" }), call("read_file", { path: "b" })];
  const flipped = [call("read_file", { path: "b" }), call("read_file", { path: "a" })];
  assert.notStrictEqual(toolTurnSignature(pair), toolTurnSignature(flipped), "순서가 다르면 다른 지문이어야 한다");
  assert.strictEqual(runTurns([pair, pair, pair]), 3);
});

check("폭주 방벽은 남아 있고, 정상 작업보다 훨씬 위에 있다", () => {
  const source = fs.readFileSync(path.join(root, "electron/runtime/local-tool-loop.ts"), "utf8");
  const match = source.match(/const MAX_TOOL_LOOP_TURNS = (\d+);/);
  assert.ok(match, "폭주 방벽이 사라졌다 — 상한 없는 루프는 밤새 돈다");
  assert.ok(Number(match[1]) >= 100, `방벽이 ${match[1]} 로 너무 낮다 — 긴 작업이 여기에 먼저 닿는다`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
