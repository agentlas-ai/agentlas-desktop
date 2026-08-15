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

  await check("★작업 폴더가 워크스페이스로 등록된다(등록 없으면 쓰기가 조용히 버려진다)", () => {
    const src = fs.readFileSync(path.join(root, "electron/runtime/antigravity.ts"), "utf8");
    assert.match(
      src,
      /agyReadDirs = runReq\.cwd \? \[runReq\.cwd, \.\.\.agyAdditionalDirs\]/,
      "cwd가 --add-dir로 등록되지 않는다 — 모델이 DONE이라 답해도 파일이 안 생긴다",
    );
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
