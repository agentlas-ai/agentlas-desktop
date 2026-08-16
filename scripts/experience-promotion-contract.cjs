#!/usr/bin/env node
/*
 * 경험 칩 승급 계약.
 *
 * 이 계약이 없을 때 실제로 일어난 일: 승급은 영수증의 run_id 로만 후보를 찾았고,
 * 그 id 를 싣는 경로는 채팅 하나뿐이었다. One durable 기억·임포트·복구로 들어온 후보는
 * 어떤 런에서도 대상이 되지 못해 영영 대기했다(실측: One 176건·appbridge 30건 승급 0).
 * 손으로 올릴 화면도 그 후보들에는 닿지 않았으므로, 사용자에게는 "승급하는 방법이 없다"가
 * 정확한 사실이었다. 조용히 0인 상태는 로그도 실패도 남기지 않는다 — 그래서 게이트가 필요하다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const store = fs.readFileSync(path.join(root, "electron/experience/store.ts"), "utf8");
const client = fs.readFileSync(path.join(root, "electron/mcp/client.ts"), "utf8");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log("experience-promotion-contract");

check("★대기 후보를 승급하는 경로가 존재한다", () => {
  assert.match(store, /export function promoteWaitingExperienceCandidates/,
    "run_id 없는 후보를 승급할 경로가 없다 — 그 후보들은 어떤 방법으로도 칩이 되지 못한다");
});

check("★그 경로는 run_id 를 조건으로 걸지 않는다", () => {
  const start = store.indexOf("export function promoteWaitingExperienceCandidates");
  assert.ok(start > 0, "함수를 못 찾았다");
  const body = store.slice(start, start + 2400);
  const query = body.slice(body.indexOf("FROM experience_candidates"), body.indexOf("LIMIT"));
  assert.ok(!/run_id/.test(query),
    "대기 후보 조회가 다시 run_id 를 요구한다 — 그러면 원래 결함으로 돌아간다");
  assert.match(body, /status = 'candidate'/, "대기 상태 후보를 고르지 않는다");
});

check("★안전 조건은 그대로다(성공 런 영수증·팩 기준·중복 방지)", () => {
  const start = store.indexOf("export function promoteWaitingExperienceCandidates");
  const body = store.slice(start, start + 2400);
  assert.match(body, /hasDurableRunStartReceipt\(runId\)/,
    "성공 런의 durable 영수증 확인이 빠졌다 — 실패한 턴의 경험이 승급된다");
  assert.match(body, /promoteExperienceCandidateFromRunReceipt/,
    "승급을 기존 검증 경로로 하지 않는다(팩 기준·중복 영수증 검사를 우회한다)");
});

check("★한 턴이 무한정 일하지 않는다(상한)", () => {
  const start = store.indexOf("export function promoteWaitingExperienceCandidates");
  const body = store.slice(start, start + 2400);
  assert.match(body, /LIMIT \?/, "조회에 상한이 없다");
  assert.match(body, /Math\.min\(/, "상한이 입력값으로 무제한 열려 있다");
});

/*
 * ★배선은 함수가 있는 것과 다르다. 이 코드베이스는 "선언은 있는데 아무도 안 읽는" 결함을
 * 이미 여러 번 겪었다 — 호출부가 사라지면 함수는 조용히 죽는다.
 */
check("★턴 종료가 실제로 그 경로를 부른다", () => {
  assert.match(client, /promoteWaitingExperienceCandidates\(\{/,
    "성공 턴에서 대기 후보 승급을 부르지 않는다 — 함수만 있고 아무 일도 일어나지 않는다");
  const callIdx = client.indexOf("promoteWaitingExperienceCandidates({");
  const guardIdx = client.lastIndexOf("oneToolFailureBlocksCompletion()", callIdx);
  assert.ok(guardIdx > 0 && callIdx - guardIdx < 2000,
    "실패/차단 턴을 거르는 조건 안에서 부르지 않는다");
});

check("★승급이 원장에 남는다(측정 가능해야 한다)", () => {
  const callIdx = client.indexOf("promoteWaitingExperienceCandidates({");
  const after = client.slice(callIdx, callIdx + 1400);
  assert.match(after, /experience_auto_promotion/,
    "원장 표식이 없다 — 다시 0이 되어도 아무도 모른다");
  assert.match(after, /waiting-backlog/, "대기분 승급을 런 생성분과 구분하지 않는다");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
