#!/usr/bin/env node
// 재개 좌표는 **점유**이지 낙인이 아니다 — 집은 실행이 죽으면 다시 집을 수 있어야 한다.
//
// 배경(2026-08-20 실측). 이 머신의 저장소에 소비된 재개 좌표가 302건 있었고, 그중
// **아직 도는 것은 0건**이었다. 좌표를 집은 실행이 죽으면 표식만 남는데, 다음 실행은
// 그 표식만 보고 이렇게 거절했다:
//
//   RESUME_CONFLICT: 다른 실행이 이미 같은 지점에서 이어서 돌고 있습니다.
//
// 아무것도 돌고 있지 않았다. 그 자동화는 **영구히 실행 불가**가 되고, 사람이 할 수 있는
// 일은 없다 — 누를 때마다 같은 말을 듣는다.
//
// 막으려던 것은 "동시에 두 실행이 같은 좌표를 재개하는 것"이지 "다시는 재개하지 않는
// 것"이 아니다. 이 게이트는 그 둘을 갈라 지킨다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// ★better-sqlite3 는 네이티브라 이 Node 의 ABI 로 빌드된 것이 필요하다. 저장소 사본이
//   다른 ABI 로 빌드돼 있으면(전자 앱용) 이 게이트는 **못 돈다** — 못 도는 것을 통과로
//   적지 않고, 무엇이 없어 못 쟀는지 말하고 건너뛴다.
const req = createRequire(import.meta.url);
try { req("better-sqlite3"); } catch (error) {
  console.log("SKIP resume-coordinate — better-sqlite3 가 이 Node 의 ABI 로 빌드돼 있지 않습니다:");
  console.log("  " + String(error && error.message).split(String.fromCharCode(10))[0].slice(0, 160));
  console.log("  (rebuilt dependencies successfully 뒤 다시 도세요. 통과로 세지 않습니다.)");
  process.exit(0);
}

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}: ${detail}`);
}

const dir = mkdtempSync(join(tmpdir(), "resume-lease-"));
process.env.AGENTLAS_STORE_PATH = join(dir, "store.sqlite");

const { getDb, initStore } = await import("../dist/electron/store/db.js");
initStore();
const { consumeGraphResumeCoordinate } = await import("../dist/electron/store/automations.js");
const db = getDb();

const nowIso = () => new Date().toISOString();
const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function seedRun(id, status, activityIso, consumedIso) {
  db.prepare(
    `INSERT INTO automation_runs (id, automation_id, started_at, last_activity_at, status,
       node_states_json, resume_consumed_at)
     VALUES (?, 'a-1', ?, ?, ?, '{}', ?)`,
  ).run(id, activityIso, activityIso, status, consumedIso);
}

// 1) 아무도 안 집은 좌표는 집을 수 있다.
seedRun("fresh", "error", nowIso(), null);
check(
  "an-unclaimed-coordinate-can-be-taken",
  consumeGraphResumeCoordinate("fresh") === true,
  "아무도 집지 않은 좌표를 못 집습니다 — 재개가 아예 불가능해집니다.",
);

// 2) 방금 집힌 좌표는 두 번째가 못 집는다(동시성은 그대로 지킨다).
check(
  "a-live-claim-still-wins-once",
  consumeGraphResumeCoordinate("fresh") === false,
  "같은 좌표를 둘이 집었습니다 — 이미 끝난 단계가 두 번 실행될 수 있습니다.",
);

// 3) 집은 실행이 오래전에 죽었으면 다시 집을 수 있다. ★이게 302건이 갇혀 있던 자리다.
seedRun("dead", "error", longAgo, longAgo);
check(
  "a-dead-claim-does-not-block-forever",
  consumeGraphResumeCoordinate("dead") === true,
  "죽은 실행의 표식이 그 자동화를 영구히 막습니다 — 실측 302건이 이 상태였고 도는 것은 0건이었습니다.",
);

// 4) 죽은 것으로 판정하는 근거는 시간이지 status 한 칸이 아니다.
//    좀비(상태는 running 인데 오래 조용한) 실행도 길을 막으면 안 된다.
seedRun("zombie", "running", longAgo, longAgo);
check(
  "a-silent-zombie-does-not-block-forever",
  consumeGraphResumeCoordinate("zombie") === true,
  "상태만 running 인 좀비가 길을 막습니다 — 이 저장소에는 close 를 못 받아 영원히 running 인 실행이 실재했습니다.",
);

// 5) 진짜로 지금 도는 실행은 지켜야 한다.
seedRun("alive", "running", nowIso(), nowIso());
check(
  "a-truly-live-run-is-protected",
  consumeGraphResumeCoordinate("alive") === false,
  "지금 도는 실행의 좌표를 빼앗았습니다 — 같은 단계가 두 번 실행됩니다.",
);

try { db.close(); } catch { /* noop */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
if (failures.length > 0) {
  console.error("\nresume-coordinate 게이트 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
