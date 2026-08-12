#!/usr/bin/env node
/*
 * goal 완료 경로 계약.
 *
 * 수리 전 이 제품은 goal 을 completed 로 끝낼 수 없었다. 원장 CLI 는 8개
 * 하위명령을 노출하는데 데스크탑 브리지가 감싼 것은 5개뿐이었고, 빠진 셋이
 * 전부 task 층이었다. create 가 심는 `task:bootstrap` 을 닫는 코드가 없어
 * openTaskCount 가 영원히 1 → 판정 사유 `no_open_tasks` 도달 불가 →
 * 그 사유를 요구하는 완료 판정이 영원히 거짓. 남는 종료는 사용자 취소와
 * blocked 뿐이었다.
 *
 * 이 게이트는 소스를 읽어 "그렇게 짜여 있다"를 확인하지 않는다. 실제 원장을
 * 격리 홈에서 왕복시키고, 마커 파서와 완료 판정을 실행해서 잰다. 예외는 순서
 * 불변식 두 개뿐인데, 그것은 구현 문장이 아니라 계약 자체다(선언을 반영하기
 * 전에 판정을 읽으면 방금 닫은 항목이 안 보인다).
 *
 * 사용 파일: dist/electron/** (build:electron 산출물)
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const checks = [];
function ok(name) {
  checks.push(name);
  console.log(`  ok  ${name}`);
}

// ── 1. 마커 파서 ──────────────────────────────────────────────────────────
const loop = require(path.join(ROOT, "dist/electron/hephaestus/loop-engineering.js"));
const { GOAL_COMPLETE_MARKER, stripGoalCompleteMarker, goalCompletionVerdict } = loop;

{
  const bare = stripGoalCompleteMarker(`전부 확인했습니다.\n${GOAL_COMPLETE_MARKER}`);
  assert.equal(bare.claimed, true, "맨 마커가 선언으로 안 잡혔다");
  assert.equal(bare.evidence, null);
  assert.ok(!bare.text.includes("agentlas-goal-complete"), "마커가 본문에 남았다");
  assert.equal(bare.text, "전부 확인했습니다.");

  const withEvidence = stripGoalCompleteMarker(
    "완료.\n<<agentlas-goal-complete: hello.txt 23B 생성 확인>>",
  );
  assert.equal(withEvidence.claimed, true);
  assert.equal(withEvidence.evidence, "hello.txt 23B 생성 확인");
  assert.ok(!withEvidence.text.includes("agentlas-goal-complete"));

  // 선언은 꼬리에만 오지 않는다 — 위치를 보면 놓치고, 놓치면 goal 이 영원히 안 닫힌다.
  const midText = stripGoalCompleteMarker(
    `근거는 아래와 같습니다.\n${GOAL_COMPLETE_MARKER}\n감사합니다.`,
  );
  assert.equal(midText.claimed, true, "본문 중간의 선언을 놓쳤다");
  assert.ok(!midText.text.includes("agentlas-goal-complete"));
  assert.ok(midText.text.includes("감사합니다"), "선언 뒤 본문이 잘렸다");

  // 여러 번 적혔으면 근거가 있는 첫 선언을 남긴다.
  const repeated = stripGoalCompleteMarker(
    `${GOAL_COMPLETE_MARKER}\n중간\n<<agentlas-goal-complete: 실제 근거>>`,
  );
  assert.equal(repeated.claimed, true);
  assert.equal(repeated.evidence, "실제 근거");
  assert.ok(!repeated.text.includes("agentlas-goal-complete"));

  const none = stripGoalCompleteMarker("그냥 답변입니다.");
  assert.equal(none.claimed, false);
  assert.equal(none.text, "그냥 답변입니다.", "선언이 없으면 본문을 건드리지 않는다");

  assert.equal(stripGoalCompleteMarker("").claimed, false);
  ok("완료 선언 마커를 회수하고 본문에서 지운다 (맨/근거/중간/중복/부재)");
}

// ── 2. 완료 판정 — 세 신호 일치 ───────────────────────────────────────────
{
  assert.equal(
    goalCompletionVerdict({ claimed: true, continueRequested: false, ledgerReason: "no_open_tasks" }),
    true,
    "세 신호가 일치하는데 완료가 아니다",
  );
  assert.equal(
    goalCompletionVerdict({ claimed: false, continueRequested: false, ledgerReason: "no_open_tasks" }),
    false,
    "선언 없이 완료됐다",
  );
  assert.equal(
    goalCompletionVerdict({ claimed: true, continueRequested: true, ledgerReason: "no_open_tasks" }),
    false,
    "할 일이 남았다는데 완료됐다",
  );
  // 예산 소진·무진전 정지에서 모델이 완료를 선언해도 완료가 아니다.
  for (const reason of ["open_tasks_remain", "goal_blocked", "budget_cycles_exhausted", "goal_terminal"]) {
    assert.equal(
      goalCompletionVerdict({ claimed: true, continueRequested: false, ledgerReason: reason }),
      false,
      `원장 사유 ${reason} 인데 완료로 판정됐다`,
    );
  }
  assert.equal(
    goalCompletionVerdict({ claimed: true, continueRequested: false, ledgerReason: null }),
    false,
    "원장에 못 닿았는데(판정 null) 완료로 판정됐다",
  );
  ok("완료는 선언·계속없음·원장 no_open_tasks 세 신호가 모두 맞을 때만이다");
}

// ── 3. 모델이 마커를 배울 수 있는가 ───────────────────────────────────────
{
  const ko = loop.goalCompletionProtocol("ko");
  const en = loop.goalCompletionProtocol("en");
  for (const [name, text] of [["ko", ko], ["en", en]]) {
    assert.ok(text.includes(GOAL_COMPLETE_MARKER), `${name} 종료 규약에 마커가 없다`);
  }
  const continuation = loop.buildGoalDrivenContinuationPrompt({
    pass: 2,
    objective: "테스트",
    openTaskCount: 1,
    previousOutput: "이전",
  });
  assert.ok(
    continuation.includes(GOAL_COMPLETE_MARKER),
    "goal 연속 프롬프트가 완료 마커를 알려주지 않는다 — 모델이 끝낼 방법을 모른다",
  );
  const longRun = loop.buildStormbreakerLongRunPrompt({
    sourceChatId: "c1",
    previousOutput: "이전",
    userPrompt: "요청",
  });
  assert.ok(
    longRun.includes(GOAL_COMPLETE_MARKER),
    "백그라운드 연속실행 프롬프트가 완료 마커를 알려주지 않는다",
  );
  ok("착수 규약·연속 프롬프트·백그라운드 프롬프트가 모두 마커를 알려준다");
}

// ── 4. 순서 불변식 ────────────────────────────────────────────────────────
// 선언을 원장에 반영하기 전에 판정을 읽으면 방금 닫은 항목이 보이지 않는다.
// 이건 구현 문장이 아니라 계약이라 위치로 잰다.
{
  const client = fs.readFileSync(path.join(ROOT, "electron/mcp/client.ts"), "utf8");
  const closeAt = client.indexOf("closeOpenGoalLedgerTasks({");
  // 최종 판정 읽기 = 마지막 recordGoalLedgerCycle. 라이브 루프의 사이클 기록은
  // 선언 회수보다 앞에 있는 게 정상이므로 첫 등장으로 재면 안 된다.
  const recordAt = client.lastIndexOf("recordGoalLedgerCycle({");
  assert.ok(closeAt > 0, "채팅 경로가 미완 task 를 닫지 않는다");
  assert.ok(recordAt > 0, "채팅 경로의 최종 사이클 기록을 못 찾았다");
  assert.ok(closeAt < recordAt, "채팅 경로가 선언을 반영하기 전에 판정을 읽는다");

  const scheduler = fs.readFileSync(path.join(ROOT, "electron/automation-scheduler.ts"), "utf8");
  const schedClose = scheduler.indexOf("closeOpenGoalLedgerTasks({");
  const schedRecord = scheduler.indexOf("const goalDecision = a.goalId");
  assert.ok(schedClose > 0, "스케줄러가 미완 task 를 닫지 않는다 — division 채팅은 여기서만 닫을 수 있다");
  assert.ok(schedRecord > 0, "스케줄러의 사이클 기록을 못 찾았다");
  assert.ok(schedClose < schedRecord, "스케줄러가 선언을 반영하기 전에 판정을 읽는다");

  /*
   * 라이브 패스 루프도 선언을 그 자리에서 처리해야 한다. 최종 지점에서만 처리하면
   *   ① 그 패스의 본문이 마커를 단 채 대화에 영속되고(appendChatMessage 가 루프 안에 있다),
   *   ② 원장이 아직 미완이라 goalDrivenPass 가 계속 참이 되어 모델이 매번 "끝났다"고
   *      말하는데도 루프가 상한까지 돈다 — 고치려던 무한 진행이 형태만 바꿔 되돌아온다.
   * 두 지점을 하나로 합치는 리팩터링을 한다면 이 단언도 같이 갱신해야 한다.
   */
  const stripCount = (client.match(/stripGoalCompleteMarker\(/g) ?? []).length;
  const closeCount = (client.match(/closeOpenGoalLedgerTasks\(\{/g) ?? []).length;
  assert.ok(stripCount >= 2, "완료 선언 회수가 패스 루프와 최종 지점 양쪽에 있지 않다");
  assert.ok(closeCount >= 2, "완료 선언이 나온 패스에서 바로 원장에 반영되지 않는다");
  ok("두 표면 모두 선언을 원장에 반영한 뒤에 판정을 읽고, 패스 루프도 그 자리에서 처리한다");
}

// ── 5. 원장 왕복 (라이브) ─────────────────────────────────────────────────
// 격리 AGENTLAS_HOME 에서 실제 CLI 를 돌린다. 오너의 실제 원장은 건드리지 않는다.
{
  const ledger = require(path.join(ROOT, "dist/electron/mcp/goal-ledger.js"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-goal-gate-"));
  const projectDir = path.join(home, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousHome = process.env.AGENTLAS_HOME;
  process.env.AGENTLAS_HOME = home;

  const runtimeRoot = path.join(os.homedir(), ".agentlas", "runtime", "current");
  const engineAvailable = fs.existsSync(path.join(runtimeRoot, "agentlas_cloud", "__main__.py"));

  const finish = () => {
    if (previousHome === undefined) delete process.env.AGENTLAS_HOME;
    else process.env.AGENTLAS_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  };

  if (!engineAvailable) {
    // 엔진이 없으면 브리지는 fail-soft 여야 한다 — 그 자체가 계약이다.
    (async () => {
      const decision = await ledger.goalLedgerShouldContinue("goal:gate:absent", projectDir);
      assert.equal(decision, null, "엔진이 없는데 판정이 null 이 아니다 (fail-soft 위반)");
      const closed = await ledger.closeOpenGoalLedgerTasks({ goalId: "goal:gate:absent", projectDir });
      assert.equal(closed, 0, "엔진이 없는데 task 를 닫았다고 보고했다");
      finish();
      ok("Hephaestus 런타임이 없으면 원장 호출이 fail-soft 로 기존 동작을 유지한다 (왕복은 건너뜀)");
      console.log(`\ngoal completion contract: ${checks.length} checks passed (ledger round-trip skipped: engine absent)`);
    })().catch((err) => {
      finish();
      console.error(err);
      process.exit(1);
    });
    return;
  }

  (async () => {
    const goalId = `goal:gate:${process.pid}`;
    const created = await ledger.ensureGoalLedgerGoal({
      goalId,
      objective: "게이트 왕복 검증",
      acceptanceCriteria: ["원장이 완료로 닫힌다"],
      projectDir,
    });
    assert.equal(created, true, "goal 생성 실패");

    // ★수리 전 상태의 재현: 새 goal 은 bootstrap task 를 갖고 태어난다.
    const seeded = await ledger.listGoalLedgerTasks(goalId, projectDir);
    assert.ok(Array.isArray(seeded) && seeded.length >= 1, "새 goal 에 미완 task 가 없다");
    assert.ok(
      seeded.some((task) => task.taskId === "task:bootstrap"),
      "원장이 심는 bootstrap task 를 못 봤다 — 이 항목이 안 닫히는 게 결함의 뿌리였다",
    );

    const before = await ledger.goalLedgerShouldContinue(goalId, projectDir);
    assert.equal(before.reason, "open_tasks_remain", "미완 task 가 있는데 사유가 다르다");
    assert.equal(before.continue, true);

    const closedCount = await ledger.closeOpenGoalLedgerTasks({
      goalId,
      evidence: "gate: 왕복 검증",
      projectDir,
    });
    assert.ok(closedCount >= 1, "미완 task 를 하나도 닫지 못했다");

    const after = await ledger.goalLedgerShouldContinue(goalId, projectDir);
    assert.equal(
      after.reason,
      "no_open_tasks",
      "task 를 닫았는데도 no_open_tasks 에 도달하지 못했다 — 완료 판정이 다시 죽었다",
    );
    assert.equal(after.continue, false);
    assert.equal(after.openTaskCount, 0);

    assert.equal(
      goalCompletionVerdict({ claimed: true, continueRequested: false, ledgerReason: after.reason }),
      true,
      "라이브 판정으로 완료 판정이 참이 되지 않는다",
    );

    const done = await ledger.completeGoalLedgerGoal({
      goalId,
      status: "completed",
      reason: "gate",
      projectDir,
    });
    assert.equal(done, true, "goal 을 completed 로 닫지 못했다");

    // 되읽기는 should-continue 로 한다. goal 스냅샷 리더는 같은 파일의 다른
    // 작업(수용 기준 계약)이 들고 있어, 이 게이트가 그것에 의존하면 두 작업이
    // 함께 있어야만 초록이 된다 — 게이트는 자기 계약만 재야 한다.
    const terminal = await ledger.goalLedgerShouldContinue(goalId, projectDir);
    assert.equal(terminal.status, "completed", "원장에 completed 로 남지 않았다");
    assert.equal(terminal.continue, false, "완료된 goal 이 계속하라고 답한다");

    finish();
    ok("라이브 원장 왕복: create → bootstrap task → 닫기 → no_open_tasks → completed");
    console.log(`\ngoal completion contract: ${checks.length} checks passed`);
  })().catch((err) => {
    finish();
    console.error(err);
    process.exit(1);
  });
}
