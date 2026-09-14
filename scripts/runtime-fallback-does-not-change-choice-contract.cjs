#!/usr/bin/env node
"use strict";
/*
 * 폴백은 이번 실행의 우회로지 사용자의 모델 선택이 아니다 — 계약.
 *
 * ★왜 있나 (오너 실사용 보고 2026-09-07):
 *   "제미나이로 했는데" / "왜 자꾸 그록으로 바뀌냐" / "One이 지혼자 막 모델이 바뀜" /
 *   "자꾸 걍 그록만 호출된다"
 *
 *   실측한 연쇄:
 *     ① 제미나이(agy)가 한도로 실패 — 그 시점 실측 문구는
 *        "Individual quota reached … Resets in 3m32s" (즉 몇 분이면 풀린다)
 *     ② 폴백이 grok 을 골랐다 — 그런데 grok 은 **이미 한도 초과였다**
 *        (429 free-usage-exhausted, 524673/500000, 24시간 롤링)
 *     ③ 그 폴백 선택을 **세 곳이 영구 저장**했다:
 *        Main  → setChatRuntimeSelection(chat.id, …)
 *        렌더러 → writeStoredOneRuntimeSelection(…)  ← One 의 **전역** localStorage 핀
 *        렌더러 → api.chats.setRuntimeSelection(…)
 *   결과: 몇 분짜리 한도 하나로 One 이 통째로, 영구히 grok 으로 굳었다.
 *
 * 이 게이트가 지키는 것 셋:
 *   1) 쿨다운 판단이 값으로 옳다(순수 함수, 고장 주입 포함).
 *   2) Main 의 폴백이 저장하지 않는다.
 *   3) 렌더러의 폴백 처리가 저장하지 않는다.
 *   ★2와 3은 **같이** 지켜야 한다 — 한쪽만 고치면 다른 쪽이 계속 덮어쓴다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cooldownPath = path.join(root, "dist/electron/runtime/runtime-cooldown.js");
assert.ok(fs.existsSync(cooldownPath), "dist 가 없습니다 — 먼저 tsc -p electron/tsconfig.json");
const cooldown = require(cooldownPath);

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

const agy = { kind: "antigravity", backend: "google", source: "agy", model: "gemini-3.8-flash-high" };
const grok = { kind: "grok", backend: "xai", source: "grok", model: "grok-4.6" };

check("한도 실패는 시한부로 기록되고, 시한이 지나면 스스로 풀린다", () => {
  cooldown.resetRuntimeCooldownsForTest();
  const now = 1_000_000;
  assert.equal(cooldown.runtimeCooldown(agy, now), null, "전제: 처음엔 막혀 있지 않다");
  const noted = cooldown.noteRuntimeFailure(agy, {
    kind: "quota",
    message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3m32s.",
    retryAfterHint: "Resets in 3m32s",
  }, now);
  assert.ok(noted, "한도 실패가 기록되지 않았다");
  assert.equal(noted.until, now + (3 * 60 + 32) * 1000, "런타임이 말한 복구 시각을 안 썼다");
  assert.ok(cooldown.runtimeCooldown(agy, now + 60_000), "3분 뒤에도 아직 막혀 있어야 한다");
  assert.equal(
    cooldown.runtimeCooldown(agy, noted.until + 1),
    null,
    "시한이 지났는데 안 풀렸다 — 사용자가 손대야 원래 모델로 돌아가게 된다",
  );
});

check("모델이 다르면 다른 한도다 — 같은 CLI 라도 함께 잠기지 않는다", () => {
  cooldown.resetRuntimeCooldownsForTest();
  const now = 2_000_000;
  cooldown.noteRuntimeFailure(agy, { kind: "quota", message: "x", retryAfterHint: undefined }, now);
  assert.ok(cooldown.runtimeCooldown(agy, now));
  assert.equal(cooldown.runtimeCooldown({ ...agy, model: "gemini-3.7-flash-high" }, now), null);
});

check("잠글 만한 실패만 잠근다 — 요청 자체의 문제로 런타임을 죽이지 않는다", () => {
  cooldown.resetRuntimeCooldownsForTest();
  const now = 3_000_000;
  for (const kind of ["refused", "empty", "exit", "unsupported", "timeout"]) {
    assert.equal(
      cooldown.noteRuntimeFailure(agy, { kind, message: "m", retryAfterHint: undefined }, now),
      null,
      `${kind} 이 런타임을 잠갔다 — 한 번의 거절로 모델이 사라진다`,
    );
  }
  assert.ok(cooldown.noteRuntimeFailure(agy, { kind: "quota", message: "m" }, now), "한도는 잠가야 한다");
  cooldown.resetRuntimeCooldownsForTest();
  assert.ok(cooldown.noteRuntimeFailure(agy, { kind: "auth", message: "m" }, now), "인증 만료도 잠가야 한다");
});

check("복구 시각을 못 읽어도 잠기고, 하루짜리 안내를 그대로 믿지는 않는다", () => {
  cooldown.resetRuntimeCooldownsForTest();
  const now = 4_000_000;
  const blind = cooldown.noteRuntimeFailure(agy, { kind: "quota", message: "m" }, now);
  assert.equal(blind.until, now + 10 * 60_000, "시각을 모를 때의 보수적 기본값이 아니다");
  cooldown.resetRuntimeCooldownsForTest();
  const far = cooldown.noteRuntimeFailure(grok, {
    kind: "quota",
    message: "Usage resets over a rolling 24-hour window",
    retryAfterHint: new Date(now + 24 * 3_600_000).toISOString(),
  }, now);
  assert.equal(far.until, now + 60 * 60_000, "24시간을 그대로 받으면 멀쩡해진 런타임이 하루 잠긴다");
});

check("사용자가 그 모델을 직접 다시 고르면 우리 짐작보다 사용자가 먼저다", () => {
  cooldown.resetRuntimeCooldownsForTest();
  const now = 5_000_000;
  cooldown.noteRuntimeFailure(agy, { kind: "quota", message: "m" }, now);
  assert.ok(cooldown.runtimeCooldown(agy, now));
  cooldown.clearRuntimeCooldown(agy);
  assert.equal(cooldown.runtimeCooldown(agy, now), null);
});

check("복구 시각 파서 — ISO·상대시간 둘 다, 못 읽으면 정직하게 null", () => {
  const now = 6_000_000;
  assert.equal(cooldown.parseRetryHint("Resets in 25m37s", now), now + (25 * 60 + 37) * 1000);
  assert.equal(cooldown.parseRetryHint("try again in 45s", now), now + 45_000);
  assert.equal(cooldown.parseRetryHint("resets in 2h", now), now + 2 * 3_600_000);
  assert.equal(cooldown.parseRetryHint(new Date(now + 90_000).toISOString(), now), now + 90_000);
  assert.equal(cooldown.parseRetryHint("soon", now), null);
  assert.equal(cooldown.parseRetryHint(undefined, now), null);
  // 이미 지난 시각을 미래로 읽으면 안 된다.
  assert.equal(cooldown.parseRetryHint(new Date(now - 90_000).toISOString(), now), null);
});

/* ── 양쪽 끝 — 저장하지 않는다 ─────────────────────────────────────────────── */

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label}: 시작 표식을 못 찾았습니다 (${startMarker})`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${label}: 끝 표식을 못 찾았습니다 (${endMarker})`);
  return source.slice(start, end);
}

check("★Main 의 폴백이 저장된 선택을 바꾸지 않는다", () => {
  const src = fs.readFileSync(path.join(root, "electron/mcp/client.ts"), "utf8");
  const body = sliceBetween(
    src,
    "const emitControllerRuntimeFallback = (",
    "if (controllerFallbackBeforeRun) {",
    "Main 폴백",
  );
  const calls = body.split("\n").filter((line) =>
    !/^\s*(\/\/|\*|\/\*)/.test(line) && /setChatRuntimeSelection\s*\(/.test(line));
  assert.deepEqual(
    calls,
    [],
    `폴백이 사용자의 저장된 선택을 덮어씁니다 — 몇 분짜리 한도 하나로 모델이 영구히 바뀝니다:\n${calls.join("\n")}`,
  );
  // 그리고 그 사실을 사용자에게 말해야 한다(무엇으로 이어가고, 선택은 그대로라는 것).
  assert.match(body, /저장된 선택은/, "저장된 선택이 유지된다는 사실을 사용자에게 말하지 않습니다");
});

check("★렌더러도 저장하지 않는다 — 한쪽만 고치면 다른 쪽이 덮어쓴다", () => {
  const src = fs.readFileSync(path.join(root, "renderer/components/one/OneShell.tsx"), "utf8");
  const body = sliceBetween(
    src,
    'if (event.kind === "notice" && event.notice?.code === "runtime-fallback"',
    'if (event.kind === "mcp-key-request") {',
    "렌더러 폴백",
  );
  const forbidden = [
    ["writeStoredOneRuntimeSelection", "One 의 전역 모델 핀을 덮어씁니다 — 새 대화까지 폴백 모델로 시작합니다"],
    ["chats.setRuntimeSelection", "대화의 저장된 모델을 영구히 바꿉니다"],
    ["setOneRuntime(", "작성창의 모델 칩을 폴백 모델로 갈아치웁니다"],
  ];
  for (const [needle, why] of forbidden) {
    const hit = body.split("\n").filter((line) =>
      !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes(needle));
    assert.deepEqual(hit, [], `${needle}: ${why}\n${hit.join("\n")}`);
  }
});

check("★Work attach/replay도 이번 실행의 폴백을 다음 선택으로 되먹이지 않는다", () => {
  const src = fs.readFileSync(path.join(root, "renderer/components/TaskCockpit.tsx"), "utf8");
  const body = sliceBetween(
    src,
    'if (notice.code === "runtime-fallback" && ev.runtimeSelection) {',
    "transcriptRevisionRef.current += 1;",
    "Work 폴백",
  );
  for (const [needle, why] of [
    ["setChat(", "대화의 다음 요청 모델을 임시 폴백으로 바꿉니다"],
    ["setActiveRuntime(", "작성창의 다음 요청 모델을 임시 폴백으로 바꿉니다"],
    ["chats.setRuntimeSelection", "대화의 저장된 모델을 영구히 바꿉니다"],
  ]) {
    const hit = body.split("\n").filter((line) =>
      !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes(needle));
    assert.deepEqual(hit, [], `${needle}: ${why}\n${hit.join("\n")}`);
  }
});

check("★고장 주입 — 위 두 검사가 실제로 빨간불이 된다", () => {
  // 이 스캔이 아무것도 못 잡는 모양이면 위 두 검사는 장식이다. 옛 고장을 넣어 확인한다.
  const brokenMain = [
    "const emitControllerRuntimeFallback = (",
    "  let persisted = true;",
    "  setChatRuntimeSelection(chat.id, nextSelection);",
    "if (controllerFallbackBeforeRun) {",
  ].join("\n");
  const body = sliceBetween(brokenMain, "const emitControllerRuntimeFallback = (", "if (controllerFallbackBeforeRun) {", "주입");
  const calls = body.split("\n").filter((line) =>
    !/^\s*(\/\/|\*|\/\*)/.test(line) && /setChatRuntimeSelection\s*\(/.test(line));
  assert.equal(calls.length, 1, "옛 고장을 다시 넣었는데 스캔이 못 잡았다 — 이 게이트는 헛돌고 있다");

  // 주석 안의 언급은 결함이 아니다(현재 소스에 설명 주석이 실제로 들어 있다).
  const commented = "const emitControllerRuntimeFallback = (\n  // setChatRuntimeSelection(chat.id, x) 를 예전에 불렀다\nif (controllerFallbackBeforeRun) {";
  const commentBody = sliceBetween(commented, "const emitControllerRuntimeFallback = (", "if (controllerFallbackBeforeRun) {", "주입2");
  assert.equal(
    commentBody.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /setChatRuntimeSelection\s*\(/.test(line)).length,
    0,
    "주석을 결함으로 셌다",
  );
});

check("폴백 후보 선택이 쿨다운을 실제로 본다", () => {
  const src = fs.readFileSync(path.join(root, "electron/runtime/selection.ts"), "utf8");
  const body = sliceBetween(src, "const blocked = (candidate: RuntimeStatus): boolean => {", "const out: RuntimeStatus[] = [];", "후보 필터");
  assert.match(
    body,
    /runtimeCooldown\(candidate\)/,
    "이미 한도에 걸린 런타임으로 폴백합니다 — 죽은 것에서 죽은 것으로 넘어갑니다",
  );
});

process.stdout.write(`\nruntime-fallback-does-not-change-choice-contract: ${checks} checks passed\n`);
