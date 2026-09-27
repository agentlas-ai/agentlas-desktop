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
 *
 * 실행: electron scripts/goal-completion-contract.cjs (ELECTRON_RUN_AS_NODE 금지 —
 * 아래 참고)
 *
 * ★2026-09-03(e3e7095b) 이후 ensureGoalLedgerGoal 등은 Python 원장이 아니라
 *   dist/electron/store/long-runs.js(=better-sqlite3, Electron ABI)로 간다.
 *   그런데 이 게이트는 npm run build:electron && `node` 로만 돌게 남아 있었다 —
 *   getDb()가 "Store not initialized" 로 던지고, ensureGoalLedgerGoal 의
 *   try/catch 가 그것을 삼켜 "goal 생성 실패"라는 엉뚱한 단언만 남겼다.
 *   store 초기화 자체가 빠진 낡은 게이트였다(플레인 node 로는 better-sqlite3 의
 *   Electron ABI 도 못 연다). 격리 store 를 실제로 초기화하도록 고친다.
 *
 * ★2026-09-06 두 번째 결함: 위 수리가 `app.setPath`/`app.whenReady()`를 쓰는데
 *   npm 스크립트는 여전히 `ELECTRON_RUN_AS_NODE=1`을 달고 있었다. 그 플래그가 서면
 *   `require("electron")`은 앱 모듈이 아니라 바이너리 경로 문자열을 돌려주므로
 *   `app`이 `undefined`가 되어 `app.setPath`에서 즉시 던진다(better-sqlite3의
 *   Electron ABI 자체는 이 플래그와 무관하게 이미 맞다 — 같은 바이너리다). 형제
 *   게이트 goal-reinjection-contract.cjs 가 쓰는 대로 플래그 없이 `electron`으로만
 *   돈다.
 *
 * ★2026-09-06 세 번째 결함(진짜 남은 것): closeOpenGoalLedgerTasks 는 더 이상 task 를
 *   직접 닫지 않는다 — electron/long-run/verifier.ts 의 verifyGoalCompletionClaim 을
 *   불러 수용 기준마다 judgeRequired(연결된 모델)에게 진짜 판정을 묻는다.
 *   collectDurableGoalVerificationEvidence 가 invocationRunId 로 완료된 실행과
 *   구체적 도구 결과를 못 찾으면(ready:false) 판정 자체를 건너뛰고 전부
 *   inconclusive 로 죽는다 — 그러면 이 왕복은 영원히 통과 못 한다.
 *   이 머신은 `claude` CLI 가 설치·로그인돼 있어(AGENTLAS_JUDGE_RUNTIME 은 별개 —
 *   그건 Ollama/LM Studio/MLX 같은 로컬 HTTP 런타임 아래서 OS 파이썬 엔진에게만
 *   쓰인다; CLI 구독은 이 데스크탑 자체의 judgment.ts 판정 서비스가 처리한다),
 *   완료된 invocation(run_events: invoke_started → mcp_tool-use(toolResultPreview
 *   있음) → invoke_completed)을 먼저 심어 ready:true 를 만들고 실제 모델 판정을
 *   받는다. 판정 호출은 agentRunCwd()(userData 아래 scratch, 이 저장소 밖)에서
 *   `--setting-sources ""`로 스폰돼(judgment.ts의 untrustedNoTools 경로) 이
 *   저장소의 CLAUDE.md/페르소나가 분류 요청을 인사말로 삼키는 사고를 이미 막는다.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const storeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-goal-completion-store-"));
process.env.AGENTLAS_STORE_PATH = path.join(storeHome, "agentlas.sqlite");
app.setPath("userData", path.join(storeHome, "user-data"));

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

  // The scheduler's goal-continuation settlement lives in one function every path calls
  // (goal-continuation-hold.ts settleGoalContinuationRun, 2026-09-27: the copy inside the
  // scheduler's legacy branch was unreachable). The ordering invariant is measured there.
  const scheduler = fs.readFileSync(path.join(ROOT, "electron/goal-continuation-hold.ts"), "utf8");
  assert.match(fs.readFileSync(path.join(ROOT, "electron/automation-scheduler.ts"), "utf8"), /settleGoalContinuationRun\(/,
    "the scheduler does not call the shared goal-continuation settlement");
  const schedClose = scheduler.indexOf("closeOpenGoalLedgerTasks({");
  const schedRecord = scheduler.indexOf("const decision = await recordGoalLedgerCycle(");
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
(async () => {
  await app.whenReady();
  // ensureGoalLedgerGoal 등은 이제 better-sqlite3 store 를 직접 연다 — 부르기 전에
  // 반드시 초기화돼 있어야 한다("Store not initialized" 를 삼켜 "goal 생성 실패"로
  // 잘못 보고하던 자리).
  require(path.join(ROOT, "dist/electron/store/db.js")).initStore();
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
      process.exit(0);
    })().catch((err) => {
      finish();
      console.error(err);
      process.exit(1);
    });
    return;
  }

  (async () => {
    const goalId = `goal:gate:${process.pid}`;
    // 완료 판정은 마커·판정 규칙만으로 안 끝난다 — closeOpenGoalLedgerTasks 는
    // verifyGoalCompletionClaim(long-run/verifier.ts)을 실제로 불러 수용 기준마다
    // **연결된 모델의 판정**(judgeRequired)을 받는다. 증빙(invocationRunId)이 없으면
    // collectDurableGoalVerificationEvidence 가 ready:false 로 판정 자체를 건너뛰고
    // 모든 항목이 inconclusive 로 죽는다 — 그래서 이 라이브 왕복은 host가 실제로 갖고
    // 있는 원장 증빙(완료된 invocation + 구체적 도구 결과)을 먼저 심는다.
    const runEvents = require(path.join(ROOT, "dist/electron/store/run-events.js"));
    const invocationRunId = `run:gate:${process.pid}`;
    runEvents.recordRunEvent({ runId: invocationRunId, kind: "invoke_started", payload: {} });
    runEvents.recordRunEvent({
      runId: invocationRunId,
      kind: "mcp_tool-use",
      payload: {
        toolName: "Write",
        toolArgs: JSON.stringify({ file_path: "hello.txt", content: "hello" }),
        toolResultPreview: "hello.txt 23B 생성 확인",
      },
    });
    runEvents.recordRunEvent({ runId: invocationRunId, kind: "invoke_completed", payload: {} });

    const created = await ledger.ensureGoalLedgerGoal({
      goalId,
      objective: "게이트 왕복 검증",
      acceptanceCriteria: ["도구 결과가 hello.txt 파일 생성을 확인한다"],
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

    // 이 호출이 실제 연결된 모델(이 머신은 claude CLI 로그인 상태)에 판정을 묻는다 —
    // 소스 문장이 아니라 실행되는 판정 함수를 잰다. 판정 서비스는 판정 호출을
    // agentRunCwd()(scratch, 프로젝트 밖)에서 --setting-sources "" 로 스폰해
    // 이 저장소의 CLAUDE.md/페르소나가 분류 요청을 삼키지 못하게 이미 격리한다.
    const closedCount = await ledger.closeOpenGoalLedgerTasks({
      goalId,
      evidence: "gate: hello.txt 생성 확인",
      outcomeText: "hello.txt 파일을 만들고 생성을 확인했습니다.",
      invocationRunId,
      projectDir,
    });
    assert.ok(closedCount >= 1, "미완 task 를 하나도 닫지 못했다 — 연결된 모델 판정이 통과(passed)를 내지 못했다");

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
    // ★2026-09-06 네 번째 결함: 이 성공 경로엔 process.exit(0)이 없었다. 실패 경로만
    // (catch에서) 종료해서, 이 왕복이 실제로 끝까지 통과한 첫 실행에서 Electron 프로세스가
    // 무기한 살아남았다(실측: 22분 뒤에도 살아있어 직접 kill). CI 라면 그대로 행에 걸린다.
    process.exit(0);
  })().catch((err) => {
    finish();
    console.error(err);
    process.exit(1);
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
