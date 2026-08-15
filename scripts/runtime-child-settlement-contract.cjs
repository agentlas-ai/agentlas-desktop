#!/usr/bin/env node
/**
 * 러너 정산 계약 — "자식이 죽으면 실행도 끝난다".
 *
 * 배경: Node 계약상 `close`는 자식의 stdio가 전부 닫혀야 온다. CLI가 파이프를 상속한
 * 손자(MCP 서버·language server)를 남기고 죽으면 `close`가 영영 오지 않는다. 러너가
 * `close`에서만 정산하면 실행 Promise는 영구 pending이 되고, 사람이 손으로 중지할
 * 때까지 "진행 중"에 머문다. 그 중단 스트림이 표식 없이 저장되면 완료 보고로 읽힌다.
 *
 * 이 게이트가 못박는 계약(구현 문장이 아니라 결과):
 *  1. 손자가 파이프를 붙든 채 자식이 죽어도 close가 온다 → 실행이 정산된다.
 *  2. 정상 종료는 그대로 즉시 정산된다(헬퍼가 방해하지 않는다).
 *  3. CLI를 띄우는 러너 전부에 붙어 있다 — 특례는 특례 안 붙은 형제를 지뢰로 만든다.
 *  4. 중단된 부분 답변은 중단이라고 적힌 채 저장된다(U+FFFD면 그 사실도).
 *  5. 빈 답은 빈 말풍선으로 저장되지 않는다.
 *
 * 실행: node scripts/runtime-child-settlement-contract.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const failures = [];
let passed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ok  ${name}`); })
    .catch((error) => { failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}\n       ${error.message}`); });
}

const distRunner = path.join(root, "dist/electron/runtime/runner.js");
if (!fs.existsSync(distRunner)) {
  console.error(`빌드 산출물이 없다: ${distRunner}\n먼저 'npx tsc -p electron/tsconfig.json'을 돌릴 것.`);
  process.exit(2);
}
const { ensureChildCloseAfterExit } = require(distRunner);
const { markInterruptedPartial } = require(path.join(root, "dist/electron/invocation/interrupted-partial.js"));

/** 손자가 stdout/stderr를 상속한 채 부모만 죽는 자식. */
function spawnOrphanedStdioChild() {
  const child = spawn("/bin/bash", ["-c", "sleep 30 & echo hi; exit 0"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

/**
 * 가짜 agy를 실제 러너(runAntigravity)로 돌린다 — 스트림 계약을 결과로 검증한다.
 * `isAgyBinaryPath`가 파일명만 보므로 임시 디렉터리의 `agy` 스크립트로 주입된다.
 */
const { runAntigravity } = require(path.join(root, "dist/electron/runtime/antigravity.js"));
const fakeAgyDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-contract-"));
const fakeAgyBin = path.join(fakeAgyDir, "agy");

async function runFakeAgy(body, timeoutMs = 40_000) {
  fs.writeFileSync(fakeAgyBin, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const run = runAntigravity(
    {
      runtimeSource: fakeAgyBin,
      userPrompt: "hi",
      systemPrompt: "sys",
      history: [],
      locale: "ko",
      permission: "read",
      cwd: fakeAgyDir,
    },
    { onPartial: () => {}, onStatus: () => {}, onUsage: () => {} },
  );
  /*
   * ★이 게이트가 지키는 결함의 증상은 "실패"가 아니라 "영원히 안 끝남"이다.
   * 타임아웃 없이 두면 회귀가 났을 때 게이트가 실패하는 대신 CI를 멈춘다
   * (변이 시험에서 실측: 헬퍼를 무력화하자 게이트가 그대로 행했다).
   * 좀비를 재현하는 게이트는 스스로 좀비가 되지 않아야 한다.
   */
  let timer;
  const guard = new Promise((_, rejectGuard) => {
    timer = setTimeout(
      () => rejectGuard(new Error(`러너가 ${timeoutMs}ms 안에 정산하지 않았다 — 실행이 좀비로 남는다`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([run, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const started = Date.now();
    child.on("close", () => { if (!done) { done = true; resolve(Date.now() - started); } });
    setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
  });
}

async function main() {
  console.log("runtime-child-settlement-contract");

  // 1. 대조군 — 시나리오가 여전히 유효한가. 헬퍼 없이는 close가 오지 않아야 한다.
  //    (이 단언이 깨지면 Node/OS가 동작을 바꾼 것이므로, 아래 본시험의 의미도 다시 봐야 한다.)
  await check("대조군: 손자가 파이프를 붙들면 close가 오지 않는다", async () => {
    const child = spawnOrphanedStdioChild();
    const elapsed = await waitForClose(child, 2_000);
    child.kill("SIGKILL");
    assert.equal(elapsed, null, `close가 ${elapsed}ms에 왔다 — 시나리오가 더는 재현되지 않는다`);
  });

  // 2. 본시험 — 헬퍼를 붙이면 같은 자식이 정산된다.
  await check("★손자가 파이프를 붙들어도 exit 유예 뒤 close가 온다", async () => {
    const child = spawnOrphanedStdioChild();
    let announced = 0;
    ensureChildCloseAfterExit(child, () => { announced += 1; }, 200);
    const elapsed = await waitForClose(child, 5_000);
    child.kill("SIGKILL");
    assert.notEqual(elapsed, null, "close가 끝내 오지 않았다 — 실행이 좀비로 남는다");
    assert.equal(announced, 1, "고아 stdio 사실을 한 번 알려야 한다(조용한 정산 금지)");
  });

  // 3. 정상 종료는 방해받지 않는다 — 유예 타이머가 정상 경로를 늦추면 안 된다.
  await check("정상 종료는 즉시 close, 고아 통지 없음", async () => {
    const child = spawn("/bin/bash", ["-c", "echo hi; exit 0"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    let announced = 0;
    ensureChildCloseAfterExit(child, () => { announced += 1; }, 3_000);
    const elapsed = await waitForClose(child, 3_000);
    assert.notEqual(elapsed, null, "정상 자식의 close가 오지 않았다");
    assert.ok(elapsed < 1_000, `정상 종료가 ${elapsed}ms로 지연됐다 — 유예가 정상 경로를 막는다`);
    assert.equal(announced, 0, "정상 종료인데 고아 stdio로 보고했다");
  });

  /*
   * 4. 형제 누락 방지 — 한 러너에서 배운 계약은 **CLI를 띄우는 모든 러너**에 있어야 한다.
   *
   * ★이 검사는 원래 러너 셋을 이름으로 박아 두고 있었다. 그래서 같은 병이 남아 있던
   * cursor·grok·kimi 를 한 번도 보지 못했다(실측: 셋 다 close 전용, exit 구독 0,
   * 심장박동 0). 하드코딩된 형제 목록은 형제가 늘어나는 순간 조용히 맹인이 된다.
   * 목록 대신 **자식을 띄우는가**로 대상을 정한다.
   *
   * ★2차 맹인: 그 "자식을 띄우는가"를 `: Runner =` 선언으로 좁혔더니 이번엔 acp.ts 를
   * 건너뛰었다 — ACP 러너는 팩토리(`createAcpRunner`)라 그 문장이 없는데, 정작
   * cursor·grok·kimi 의 **실제 실행 경로**가 거기다(ACP_PREFERRED_KINDS). 손 드라이버
   * 쪽만 고쳐 두면 안 쓰이는 경로에만 수리가 있는 셈이 된다. 그래서 판별을 선언 문법이
   * 아니라 **행동**으로 바꾼다: 실행 수명의 자식은 중지·정리를 위해 반드시 추적된다.
   */
  await check("★CLI를 띄우는 모든 러너가 자식 정산 헬퍼를 단다", () => {
    const runtimeDir = path.join(root, "electron/runtime");
    const spawning = fs.readdirSync(runtimeDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, src: fs.readFileSync(path.join(runtimeDir, name), "utf8") }))
      // 실행용 스폰만 — 짧은 버전/모델 프로브는 자체 타임아웃으로 끝난다.
      // 이 헬퍼들을 **정의**하는 파일(exec.ts)은 제공자이지 러너가 아니다 — 이름이 아니라
      // export 여부로 가른다.
      .filter(({ src }) => !/export function (spawnCli|trackRunChild)\b/.test(src))
      .filter(({ src }) => /spawnCli\(/.test(src) && /trackRunChild\(/.test(src));

    assert.ok(spawning.length >= 6, `스폰 러너를 ${spawning.length}개만 찾았다 — 탐지가 깨졌다`);

    const missing = spawning
      .filter(({ src }) => !/\bensureChildCloseAfterExit\(child/.test(src) || !/\bstartCliHeartbeat\(child/.test(src))
      .map(({ name }) => name);
    assert.deepEqual(missing, [], `자식 정산이 빠진 러너: ${missing.join(", ")}`);
  });

  /*
   * ★도구 호출을 **읽어 놓고** 화면에 올리지 않는 러너가 없어야 한다.
   *
   * 실측: antigravity 는 스트림에서 step_type:"tool" 과 tool_name 을 그대로 받고도
   * onTool 을 부르지 않았다. 그래서 agy 로 돌린 실행은 활동 목록에도 출력 패널에도
   * 아무것도 남기지 못했고, 사용자에게는 "작업 중" 한 줄만 몇 분씩 보였다 —
   * 다른 런타임에서는 Write/Bash 가 보이는 자리다.
   *
   * 도구를 아예 파싱하지 않는 드라이버(cursor: 설계상 도구 표시가 없어 ACP 로 대체됨)는
   * 이 계약의 대상이 아니다. 읽은 것을 버리는 것만 잡는다.
   */
  await check("★도구를 파싱하는 러너는 그것을 화면에 올린다", () => {
    const runtimeDir = path.join(root, "electron/runtime");
    const parsers = fs.readdirSync(runtimeDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, src: fs.readFileSync(path.join(runtimeDir, name), "utf8") }))
      // 러너만 본다 — 문자열 표나 모델 목록에도 "tool_name" 같은 낱말은 들어 있다.
      .filter(({ src }) => /RunnerEvents/.test(src))
      .filter(({ src }) => /tool_name|tool_call|step_type === "tool"|toolCallId/.test(src));

    assert.ok(parsers.length >= 3, `도구를 파싱하는 러너를 ${parsers.length}개만 찾았다 — 탐지가 깨졌다`);

    const silent = parsers
      .filter(({ src }) => !/onTool\??\.?\(/.test(src))
      .map(({ name }) => name);
    assert.deepEqual(silent, [], `도구를 읽고도 화면에 올리지 않는 러너: ${silent.join(", ")}`);
  });

  /*
   * ★사용자가 누른 중지는 실패가 아니다 — 그 사실이 화면까지 가야 한다.
   *
   * 실측: 인자 없이 abort() 하면 신호에 DOM 기본 사유가 실리고, 화면에 영어 문구
   * "This operation was aborted" 가 오류로 떴다. 사용자는 자기가 멈춘 것을 실패로 본다.
   */
  await check("★중지는 사유를 싣고, 표식은 사람 문장으로 나간다", () => {
    const lifecycle = fs.readFileSync(path.join(root, "electron/runtime/invocation-lifecycle.ts"), "utf8");
    assert.match(lifecycle, /STOPPED_BY_USER/, "중지 사유 표식이 없다");
    assert.ok(!/controller\.abort\(\)/.test(lifecycle), "abort 에 사유를 넘기지 않는다 — DOM 기본 문구가 화면으로 간다");

    const abortReason = fs.readFileSync(path.join(root, "electron/runtime/abort-reason.ts"), "utf8");
    assert.match(abortReason, /STOPPED_BY_USER/, "표식을 알아보지 못한다");
    assert.match(abortReason, /tStatus\(/, "표식을 로케일 문장으로 바꾸지 않는다 — 기계 문자열이 화면에 뜬다");
  });

  await check("★심장박동은 종료 경로에서 반드시 멈춘다(타이머 누수 금지)", () => {
    const runtimeDir = path.join(root, "electron/runtime");
    const leaking = fs.readdirSync(runtimeDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, src: fs.readFileSync(path.join(runtimeDir, name), "utf8") }))
      .filter(({ src }) => /\bstartCliHeartbeat\(child/.test(src))
      // 반환된 정리 함수를 어떤 이름으로 받든 종료 경로에서 호출해야 한다.
      // 이름을 열거하면 새 러너가 다른 이름을 쓰는 순간 또 맹인이 된다 — 모양으로 본다.
      .filter(({ src }) => !/\b(stop|clear)\w*[Hh]eartbeat\w*\(\)/.test(src))
      .map(({ name }) => name);
    assert.deepEqual(leaking, [], `심장박동 정리를 부르지 않는 러너: ${leaking.join(", ")}`);
  });

  // 5. 중단 표식 — 부분 답변이 완결 답변으로 읽히면 안 된다.
  await check("★중단 부분 답변에 중단 표식이 붙는다(ko/en)", () => {
    const ko = markInterruptedPartial("작업을 모두 완료했습니다.", "ko");
    assert.ok(ko.includes("중단된 답변"), "한국어 중단 표식 누락");
    assert.ok(ko.trimEnd().endsWith("작업을 모두 완료했습니다."), "본문이 보존되지 않았다");
    const en = markInterruptedPartial("All done.", "en");
    assert.ok(/Interrupted answer/.test(en), "영어 중단 표식 누락");
  });

  await check("★U+FFFD 오염이면 깨졌다는 사실도 함께 적는다", () => {
    const dirty = markInterruptedPartial("완�되었습니다", "ko");
    assert.ok(dirty.includes("깨졌"), "오염 고지 누락 — 복원 불가라면 최소한 말해야 한다");
    const clean = markInterruptedPartial("정상 본문", "ko");
    assert.ok(!clean.includes("깨졌"), "멀쩡한 본문에 오염 고지를 붙였다");
  });

  // 6. 취소·실패 저장 경로가 표식을 거치는지 — 원문 직행이면 4·5가 무의미해진다.
  await check("취소/실패 저장 경로가 표식 함수를 거친다", () => {
    const src = fs.readFileSync(path.join(root, "electron/invocation/service.ts"), "utf8");
    assert.match(
      src,
      /appendChatMessage\(\s*runReq\.chatId,\s*"assistant",\s*markInterruptedPartial\(/,
      "중단 부분 답변이 표식 없이 저장된다",
    );
  });

  // 7. 빈 답이 빈 말풍선으로 남지 않는다 — 단, 조용히 삼키지도 않는다.
  await check("빈 최종 답은 저장 전에 걸러지고 사실은 원장에 남는다", () => {
    const src = fs.readFileSync(path.join(root, "electron/mcp/client.ts"), "utf8");
    assert.match(src, /if \(displayWithFloor\.trim\(\)\) \{\s*\n\s*appendChatMessage\(chat\.id, "assistant", displayWithFloor\);/, "빈 답 가드가 없다");
    assert.match(src, /emptyDisplayText: true/, "빈 답 사실이 원장에 남지 않는다 — 조용한 삭제 금지");
  });

  // 8. 재시작으로도 안 사라지는 "진행 중" — 부팅 시점의 running은 정의상 고아다.
  await check("★부팅 시 고아 running Task를 정산한다(거짓 성공 금지)", () => {
    const tasksSrc = fs.readFileSync(path.join(root, "electron/store/tasks.ts"), "utf8");
    assert.match(tasksSrc, /export function settleInterruptedTasksOnBoot\(/, "부팅 정산 함수가 없다");
    assert.match(
      tasksSrc,
      /WHERE status = 'running'/,
      "정산 대상이 running이 아니다",
    );
    assert.ok(
      !/setCanonicalTaskStatus\(row\.id, "completed"\)/.test(tasksSrc),
      "고아를 completed로 덮으면 끝나지 않은 실행이 성공으로 둔갑한다",
    );
    assert.ok(
      !/status IN \('running',\s*'waiting-decision'\)/.test(tasksSrc),
      "waiting-decision은 사람의 답을 기다리는 정당한 상태 — 정산 대상이 아니다",
    );

    const mainSrc = fs.readFileSync(path.join(root, "electron/main.ts"), "utf8");
    assert.match(mainSrc, /settleInterruptedTasksOnBoot\(\)/, "부팅 시퀀스가 정산을 부르지 않는다");
    assert.match(mainSrc, /host-restarted-mid-run/, "정산 사유가 원장에 남지 않는다");
  });

  // 9. end-to-end — 가짜 agy를 실제 러너로 돌린다. 위 단언들이 소스 모양을 보는 반면
  //    여기서는 결과만 본다(구현 문장이 아니라 계약).
  await check("★E2E: 개행 없는 마지막 result 라인이 정본으로 잡힌다", async () => {
    const res = await runFakeAgy(
      `printf '%s\\n' '{"event":"step_update","step":{"step_type":"agent_response","text_delta":"완"}}'\n` +
      `printf '%s' '{"event":"result","result":{"status":"DONE","response":"완료되었습니다 — 정본"}}'`,
    );
    assert.equal(res.text, "완료되었습니다 — 정본", "마지막 줄에 개행이 없으면 정본을 놓친다");
  });

  await check("★E2E: 온전한 정본이 오염된 델타 누적본을 이긴다", async () => {
    const res = await runFakeAgy(
      `printf '%s\\n' '{"event":"step_update","step":{"step_type":"agent_response","text_delta":"완�"}}'\n` +
      `printf '%s\\n' '{"event":"result","result":{"status":"DONE","response":"완료되었습니다"}}'`,
    );
    assert.equal(res.text.includes("�"), false, "오염된 델타가 본문이 됐다");
  });

  await check("E2E: 후보가 전부 오염이면 오염본을 답으로 내지 않는다", async () => {
    const res = await runFakeAgy(
      `printf '%s\\n' '{"event":"step_update","step":{"step_type":"agent_response","text_delta":"완�"}}'\n` +
      `printf '%s\\n' '{"event":"result","result":{"status":"DONE","response":"완�되었습니다"}}'`,
    ).catch((error) => ({ threw: error }));
    assert.ok(
      res.threw || !res.text.includes("�"),
      "눈에 보이게 깨진 본문이 정상 답으로 저장됐다",
    );
  });

  // ★이 게이트의 심장 — 93분 좀비가 유예 안에 정산되는지를 실제 러너 경로로 확인한다.
  await check("★E2E: 손자가 파이프를 붙들어도 러너가 유예 안에 정산한다", async () => {
    const started = Date.now();
    const res = await runFakeAgy(
      `sleep 60 &\n` +
      `printf '%s\\n' '{"event":"result","result":{"status":"DONE","response":"정산됨"}}'\n` +
      `exit 0`,
    );
    const elapsed = Date.now() - started;
    assert.equal(res.text, "정산됨", "정산은 됐지만 본문이 유실됐다");
    assert.ok(elapsed < 30_000, `정산까지 ${elapsed}ms — 유예가 너무 길거나 걸리지 않았다`);
  });

  await check("E2E: 대용량 출력도 손실 없이 정산된다(destroy가 데이터를 버리지 않는다)", async () => {
    const res = await runFakeAgy(
      `sleep 60 &\n` +
      `for i in $(seq 1 3000); do printf '%s\\n' '{"event":"step_update","step":{"step_type":"agent_response","text_delta":"가"}}'; done\n` +
      `printf '%s\\n' '{"event":"result","result":{"status":"DONE","response":"끝"}}'\n` +
      `exit 0`,
    );
    assert.equal(res.text, "끝", "대용량 뒤 마지막 result가 유실됐다");
  });

  // 10. 쓰기 권한 실행이 실제로 쓸 수 있는가 — 형제 러너와 같은 규칙.
  await check("★권한 칩이 agy 권한 플래그로 번역된다", () => {
    const { antigravityPermissionArgs } = require(path.join(root, "dist/electron/runtime/antigravity.js"));
    assert.deepEqual(antigravityPermissionArgs("read"), [], "읽기 전용에 도구를 열었다");
    assert.deepEqual(antigravityPermissionArgs(undefined), [], "권한 미지정에 도구를 열었다");
    const write = antigravityPermissionArgs("write");
    assert.ok(write.includes("--dangerously-skip-permissions"), "쓰기 권한인데 도구가 자동 거부된다");
    assert.ok(write.includes("--sandbox"), "쓰기 권한은 셸을 묶어야 한다(codex workspace-write 대응)");
    const full = antigravityPermissionArgs("full");
    assert.ok(full.includes("--dangerously-skip-permissions"), "full 권한인데 도구가 자동 거부된다");
    assert.ok(!full.includes("--sandbox"), "full은 샌드박스를 풀어야 한다");
  });

  /*
   * ★이 검사는 원래 대입문 한 줄을 문자 그대로 못박고 있었다. 그래서 **다른 대입문**이
   * 뒤에서 같은 변수를 갈아치우는 것을 보지 못했다: 프롬프트가 길어 파일 부트스트랩을
   * 타면 목록이 통째로 교체되면서 작업 폴더가 빠졌고, agy 는 파일을 자기 스크래치에
   * 만들었다. 모델은 "만들었다"고 답하고 사용자 폴더는 비어 있다.
   *
   * 그래서 구현 문장이 아니라 계약을 단언한다: 이 목록에 값을 넣는 **모든** 지점이
   * 작업 폴더를 유지해야 한다. 갈래가 늘어도 자동으로 걸린다.
   */
  await check("★작업 폴더가 워크스페이스로 등록된다 — 모든 대입 지점에서(등록 없으면 쓰기가 딴 데로 간다)", () => {
    const src = fs.readFileSync(path.join(root, "electron/runtime/antigravity.ts"), "utf8");
    const assignments = src.split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      // 선언(let)도 대입이다 — 접두사를 빠뜨리면 첫 지점을 통째로 놓친다.
      .filter(({ line }) => /^(let|const|var)?\s*agyReadDirs\s*=/.test(line));
    assert.ok(assignments.length >= 2, `agyReadDirs 대입을 ${assignments.length}개만 찾았다 — 탐지가 깨졌다`);

    // 대입은 여러 줄에 걸칠 수 있으므로 대입 지점부터 다음 대입/블록 끝까지를 본다.
    const offenders = [];
    for (const { no } of assignments) {
      const window = src.split("\n").slice(no - 1, no + 4).join("\n");
      if (!/agyWorkDir/.test(window)) offenders.push(no);
    }
    assert.deepEqual(offenders, [], `작업 폴더를 빠뜨린 agyReadDirs 대입: ${offenders.join(", ")}행`);

    /*
     * ★그리고 스폰 cwd 와 등록 폴더는 같은 값에서 나와야 한다. 둘을 따로 계산하면
     * 기본값이 갈리고, 실측에서 정확히 그 일이 있었다: cwd 는 agentRunCwd() 로
     * 폴백하는데 등록 목록은 빈 채로 남아 --add-dir 가 인자에서 통째로 사라졌다.
     */
    assert.match(src, /const agyWorkDir = runReq\.cwd \?\? agentRunCwd\(\)/,
      "작업 폴더 폴백이 한 곳에서 정해지지 않는다");
    assert.match(src, /cwd: agyWorkDir,/,
      "스폰 cwd 가 등록 폴더와 다른 식으로 계산된다 — 둘이 갈리면 쓰기가 딴 데로 간다");
    assert.ok(!/cwd: req\.cwd \?\? agentRunCwd\(\)/.test(src),
      "스폰 cwd 가 여전히 따로 계산된다");
  });

  /*
   * ★권한 칩은 런타임 인자로 **강제**돼야 한다 — 모델의 선의로 지켜지는 경계는 경계가
   * 아니다. 실측(1.0.16 이전): 읽기 권한으로 파일 생성을 시켰더니 claude 는 그냥 만들었고
   * codex·antigravity·grok 셋은 거절했다. read 에 인자를 하나도 주지 않고 "헤드리스면
   * 알아서 거부된다"고 가정한 결과였다.
   */
  await check("★읽기 권한이 인자로 강제된다(모델의 선의에 맡기지 않는다)", () => {
    const cc = fs.readFileSync(path.join(root, "electron/runtime/claude-code.ts"), "utf8");
    assert.match(cc, /--disallowed-tools/, "claude read 갈래가 변경 도구를 막지 않는다");
    for (const tool of ["Write", "Edit", "NotebookEdit", "Bash"]) {
      assert.ok(new RegExp(`"${tool}"`).test(cc), `read 차단 목록에 ${tool} 이 없다 — 그것으로 파일을 쓸 수 있다`);
    }

    const cx = fs.readFileSync(path.join(root, "electron/runtime/codex.ts"), "utf8");
    assert.match(cx, /"--sandbox", "read-only"/, "codex read 갈래가 read-only 샌드박스를 잃었다");
  });

  /*
   * ★런타임이 준 사유를 그대로 들고 나온다. JSON-RPC 는 규격 코드에 규격 문구를 쓰므로
   * 진짜 이유는 `data` 에 온다 — 실측: goose 는 message="Internal error", data 에
   * "GOOSE_PROVIDER 없음". message 만 읽으면 화면에 두 단어만 남는다.
   */
  await check("★ACP 실패는 message 가 아니라 data 의 사유까지 싣는다", () => {
    const src = fs.readFileSync(path.join(root, "electron/runtime/acp.ts"), "utf8");
    assert.match(src, /err instanceof AcpRpcError \? err\.data/, "ACP 에러의 data 를 읽지 않는다");
    assert.match(src, /authMethods/, "인증 안내를 에이전트가 광고한 목록에서 가져오지 않는다");
    // 한도 소진에 "로그인하라"고 답하면 될 리 없는 일을 시키는 것이다.
    assert.match(src, /quota\s*\?\s*"quota"/, "한도 소진이 인증 실패로 분류된다");
    assert.match(src, /prescription && !quota/, "한도 소진에 로그인 안내가 붙는다");
  });

  await check("★세션 규칙이 권한과 같은 말을 한다(도구 열림/닫힘 일관)", () => {
    const src = fs.readFileSync(path.join(root, "electron/runtime/antigravity.ts"), "utf8");
    assert.match(src, /agyToolsAllowed\s*\?/, "세션 규칙이 권한에 따라 갈리지 않는다");
    assert.match(src, /Tools ARE available and pre-approved/, "도구가 열린 실행에 사용 지시가 없다");
    // 도구가 열린 실행에 '시도하지 마라'가 남아 있으면 시스템 프롬프트와 정면 충돌한다.
    const guardIdx = src.indexOf("agyToolsAllowed");
    const denyIdx = src.indexOf("Tool calls cannot be approved here");
    assert.ok(guardIdx >= 0 && denyIdx > guardIdx, "무조건 도구 금지 고지가 남아 있다");
  });

  /*
   * 진짜 agy를 부르는 검증은 토큰과 시간을 쓴다 — 기본은 끄고 옵트인으로 둔다.
   * AGENTLAS_GATE_LIVE_AGY=1 로 켜면 실제 파일이 만들어지는지까지 확인한다.
   */
  if (process.env.AGENTLAS_GATE_LIVE_AGY === "1") {
    await check("★LIVE: 쓰기 권한 실행이 실제 파일을 만든다", async () => {
      const { runAntigravity } = require(path.join(root, "dist/electron/runtime/antigravity.js"));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-live-write-"));
      try {
        await runAntigravity(
          {
            userPrompt: "Create a file named gate-proof.txt in the current working directory containing exactly OK. Then reply with just DONE.",
            systemPrompt: "You are a build agent.",
            history: [],
            locale: "en",
            permission: "write",
            cwd: dir,
            backendLabel: "Antigravity",
          },
          { onPartial: () => {}, onStatus: () => {}, onUsage: () => {} },
        );
        assert.ok(
          fs.existsSync(path.join(dir, "gate-proof.txt")),
          "모델이 완료를 보고했는데 파일이 없다 — 쓰기가 조용히 버려졌다",
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  } else {
    console.log("  --  LIVE agy 검증은 건너뜀 (AGENTLAS_GATE_LIVE_AGY=1로 켤 것)");
  }

  fs.rmSync(fakeAgyDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
