#!/usr/bin/env node
/*
 * 에이전트 아키텍처 마이그레이션 계약.
 *
 * 이 제품은 업데이트로 아키텍처가 바뀐다. 그런데 새 배선은 대개 "앞으로 만들어질 것"에만
 * 붙고, 이미 등록된 에이전트는 옛 상태로 남는다 — 그래서 오래 쓴 사용자일수록 새 기능이
 * 비어 있는 역설이 생겼다(실측: 라이브 저장소 170명 중 경험 칩을 가진 에이전트 5명, 칩 26개).
 *
 * 마이그레이션 층은 그 간격을 메우는 상시 층이다. 이 계약은 그 층이 **모두에게, 한 번씩,
 * 결과를 남기며** 돈다는 것을 지킨다. 순수 문자열 검사로 끝내지 않고, 실제로 회귀했던
 * 판정(환경 택소노미)은 빌드 산출물을 불러 행동으로 확인한다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const migrations = read("electron/architecture/agent-migrations.ts");
const backfill = read("electron/experience/backfill.ts");
const main = read("electron/main.ts");
const db = read("electron/store/db.ts");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log("agent-architecture-migration-contract");

check("★부팅이 실제로 마이그레이션을 돌린다", () => {
  assert.match(main, /import \{ migrateRegisteredAgents \}/, "부팅이 마이그레이션을 import 하지 않는다");
  assert.match(main, /migrateRegisteredAgents\(\)/,
    "마이그레이션을 부르는 곳이 없다 — 층만 있고 아무에게도 도달하지 않는다");
});

check("★스윕 대상은 등록된 전원이다(빈 에이전트만이 아니다)", () => {
  const idx = migrations.indexOf("export function migrateRegisteredAgents");
  const body = migrations.slice(idx, idx + 900);
  assert.match(body, /SELECT id FROM installed_agents/,
    "등록 전체를 대상으로 하지 않는다");
  assert.ok(!/WHERE[\s\S]{0,120}NOT EXISTS/.test(body),
    "대상을 조건으로 좁힌다 — 좁힌 조건에서 빠진 사용자에게는 업데이트가 도달하지 않는다");
});

check("★원장은 (에이전트 × 단계)다 — 앱 버전이 아니다", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS agent_architecture_migrations/,
    "원장 테이블이 스키마에 없다");
  assert.match(db, /PRIMARY KEY \(agent_id, step_id\)/,
    "원장 키가 (에이전트, 단계)가 아니다 — 새 단계가 기존 에이전트에게 돌지 않거나 매번 중복 실행된다");
});

/*
 * ★`noop` 은 종결이 아니다. 오늘 설치돼 이력이 없는 에이전트는 모든 단계가 noop 으로 닫히는데,
 * 그 뒤 아무리 돌려도 단계가 다시 오지 않으면 그 에이전트는 영원히 빈 채로 남는다 — 이 층이
 * 고치려던 병과 정확히 같은 모양이다.
 */
check("★applied 만 종결이고 noop/failed 는 이력이 늘면 다시 돈다", () => {
  const idx = migrations.indexOf("function pendingStepsFor");
  const body = migrations.slice(idx, migrations.indexOf("function recordOutcome"));
  assert.match(body, /outcome === "applied"/, "applied 를 종결로 구분하지 않는다");
  assert.match(body, /lastActivityAt\(agentId\)/, "이력 증가를 보지 않는다");
  assert.match(body, /activity > seen\.appliedAt/, "이력이 늘어도 다시 돌지 않는다");
});

check("★한 단계의 실패가 나머지를 막지 않고, 실패도 원장에 남는다", () => {
  const idx = migrations.indexOf("export function migrateRegisteredAgents");
  const body = migrations.slice(idx);
  assert.match(body, /outcome = \{ outcome: "failed"/,
    "실패를 결과로 만들지 않는다 — 예외가 스윕 전체를 멈춘다");
  assert.match(body, /recordOutcome\(agentId, step, outcome\)/,
    "결과를 원장에 적지 않는다 — 매 부팅 같은 실패를 반복하며 아무도 모른다");
});

check("★단계 id 는 유일하다(원장 키가 겹치면 한쪽이 영원히 안 돈다)", () => {
  const ids = [...migrations.matchAll(/^\s{4}id: "([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 1, "등록된 단계가 하나도 없다");
  assert.equal(new Set(ids).size, ids.length, `단계 id 가 중복된다: ${ids.join(", ")}`);
});

/*
 * ★회귀 방지 1 — 환경 택소노미.
 *
 * 백필이 `runtimeKind: "unknown"` 을 넘기던 동안 수집은 전부
 * `environment-taxonomy-unavailable` 로 건너뛰어졌다. 후보 0 → 칩 0. 문자열 검사로는
 * "unknown 이 아니다"까지만 알 수 있으므로, 실제 판정기를 불러 확인한다.
 */
check("★백필이 넘기는 환경이 택소노미에 실제로 적격이다", () => {
  const match = backfill.match(/runtimeKind: "([^"]+)"/);
  assert.ok(match, "백필이 런타임 종류를 넘기지 않는다");
  const taxonomyPath = path.join(root, "dist/electron/experience/taxonomy.js");
  if (!fs.existsSync(taxonomyPath)) {
    throw new Error("dist 가 없어 행동으로 확인할 수 없다 — npm run build:electron 후 다시 돌려라");
  }
  const taxonomy = require(taxonomyPath);
  const profile = taxonomy.canonicalEnvironmentProfile({
    platform: process.platform, arch: process.arch, runtimeKind: match[1],
  });
  assert.equal(
    taxonomy.isRuntimeEligibleExperienceEnvironmentProfile(profile), true,
    `백필 환경 "${match[1]}" 은 택소노미가 거절한다 — 수집이 통째로 건너뛰어져 칩이 0이 된다`,
  );
});

/*
 * ★회귀 방지 2 — 시작 영수증은 이 에이전트 이름으로 남지 않는다.
 *
 * 실행이 시작될 때는 누가 맡을지 정해지지 않아 `agent_id` 가 NULL 이다(스웜·편성 실행).
 * 그래서 "이 에이전트의 invoke_started" 를 찾으면 항상 0건이고, 승급 근거가 영원히 없다 —
 * 실측: 실행 6건 모두 영수증을 갖고 있는데도 0으로 보였다.
 */
check("★실행 id 는 에이전트 이벤트에서 얻고 영수증은 실행 전체에 묻는다", () => {
  for (const [label, source, fnName] of [
    ["마이그레이션", migrations, "function durableRunIdFor"],
    ["백필", backfill, "function pastTurnsFor"],
  ]) {
    const idx = source.indexOf(fnName);
    assert.ok(idx > 0, `${label}: ${fnName} 을 못 찾았다`);
    const body = source.slice(idx, idx + 1200);
    const sql = body.slice(body.indexOf("`"), body.indexOf(").all"));
    assert.ok(
      !/agent_id = \?[\s\S]{0,200}kind IN \([^)]*_started/.test(sql),
      `${label}: 이 에이전트 이름으로 시작 이벤트를 찾는다 — 그 행은 agent_id 가 NULL 이라 항상 0건이다`,
    );
    assert.match(body, /hasDurableRunStartReceipt\(/,
      `${label}: 영수증을 실행 전체에 묻지 않는다`);
  }
});

check("★경험 보정은 추측한 기준으로 묶지 않는다", () => {
  const idx = migrations.indexOf('id: "experience-base-hash');
  const body = migrations.slice(idx, idx + 900);
  assert.match(body, /if \(!currentExperienceBaseHash\(agentId\)\)/,
    "기준을 못 구해도 진행한다 — 나중에 진짜 기준이 생기면 그 경험이 전부 무효가 된다");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
