#!/usr/bin/env node
// L4 재기동 계약 게이트 — 결과를 단언한다:
//   죽은(스톨) 실행이 error로 닫힐 때,
//   · goal-bound(automations.goal_id) 자동화는 next_run_at이 지금으로 당겨져
//     다음 60초 tick에 재투입된다("에이전트가 죽으면 다시 띄워서 계속 진행"),
//   · goal 없는 자동화는 원래 스케줄을 그대로 유지한다.
// 부수 계약: createAutomation의 goalId 영속과 goal 축 조회(findAutomationByGoalId).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-goal-reinject-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "store.sqlite");
app.setPath("userData", path.join(tempDir, "user-data"));

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const automations = require("../dist/electron/store/automations.js");
  const db = store.getDb();

  const make = (name, goalId) =>
    automations.createAutomation({
      name,
      scheduleHuman: "every-30m",
      targetType: "agent",
      targetId: "agent-x",
      promptTemplate: "<<stormbreaker-long-run>>\nSource chat: chat-x",
      createdBy: "agent",
      // 판정 모델 없는 하네스 — 결정적 null 판정으로 toolMode 프로브를 잠재운다.
      judged: () => null,
      ...(goalId ? { goalId } : {}),
    });

  const goalBound = make("goal-bound continuation", "goal:gate:reinject");
  const plain = make("plain continuation", null);

  assert.equal(goalBound.goalId, "goal:gate:reinject", "goalId must persist through createAutomation");
  assert.equal(
    automations.findAutomationByGoalId("goal:gate:reinject")?.id,
    goalBound.id,
    "the goal axis must resolve to exactly its continuation row",
  );
  assert.ok(
    Date.parse(goalBound.nextRunAt) > Date.now(),
    "precondition: both automations start with a future schedule",
  );

  const tenHoursAgo = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
  const insertRun = db.prepare(
    "INSERT INTO automation_runs (id, automation_id, started_at, status, node_states_json, last_activity_at) VALUES (?, ?, ?, 'running', '{}', ?)",
  );
  insertRun.run("run-goal", goalBound.id, tenHoursAgo, tenHoursAgo);
  insertRun.run("run-plain", plain.id, tenHoursAgo, tenHoursAgo);

  const recovered = store.recoverStaleAutomationRuns(new Date());
  assert.equal(recovered, 2, "both silent runs must be closed by recovery");
  for (const runId of ["run-goal", "run-plain"]) {
    const run = db.prepare("SELECT status FROM automation_runs WHERE id = ?").get(runId);
    assert.equal(run.status, "error", `${runId} must be closed as error`);
  }

  const boundary = new Date(Date.now() + 1_000).toISOString();
  const nextRuns = new Map(
    db.prepare("SELECT id, next_run_at FROM automations").all().map((row) => [row.id, row.next_run_at]),
  );
  assert.ok(
    nextRuns.get(goalBound.id) <= boundary,
    "a goal-bound automation whose run died must be re-injected for the next tick",
  );
  assert.ok(
    nextRuns.get(plain.id) > boundary,
    "an automation without a goal must keep its original schedule",
  );

  // 멱등성 — 두 번째 복구가 스케줄을 다시 건드리거나 실행을 재닫지 않는다.
  assert.equal(store.recoverStaleAutomationRuns(new Date()), 0, "recovery must be idempotent");

  console.log("goal reinjection contract: PASS");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
