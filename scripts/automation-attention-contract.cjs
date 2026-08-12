#!/usr/bin/env node
/*
 * "이 실행은 사람이 봐야 하는가" — 한 벌의 규칙.
 *
 * 실측(2026-08-12): 데스크탑 실행 기록 패널은 status ∪ outcome ∪ acknowledgedAt 을
 * 보는데 모바일 브리지 투영은 status 만 봤다. 그래서 판정이 **반려**한 실행
 * (status "ok" + outcome "rejected")이 폰에는 "완료"로 도착하고 알림 종도 안 울렸다.
 *
 * 이 게이트는 두 표면이 **같은 함수**를 부르는지가 아니라, 그 함수가 각 경우에
 * 무엇을 답하는지를 못박는다.
 */

const assert = require("node:assert/strict");

const {
  automationRunNeedsAttention,
} = require("../dist/shared/automation-attention.js");

const run = (patch) => ({
  status: "ok",
  outcome: null,
  acknowledgedAt: null,
  ...patch,
});

// ── 실행 자체가 끝나지 못한 경우 ──────────────────────────────────────────
for (const status of ["error", "partial", "blocked", "needs_input"]) {
  assert.equal(
    automationRunNeedsAttention(run({ status })),
    true,
    `status ${status} must ask for attention`,
  );
}
assert.equal(automationRunNeedsAttention(run({ status: "ok" })), false);
assert.equal(automationRunNeedsAttention(run({ status: "skipped" })), false);

// ── 실행은 멀쩡한데 결과물이 사람 손을 필요로 하는 경우 ────────────────────
// 이게 폰에서 통째로 빠져 있던 계열이다.
for (const outcome of ["needs_input", "blocked", "rejected"]) {
  assert.equal(
    automationRunNeedsAttention(run({ status: "ok", outcome })),
    true,
    `a run that finished but was judged ${outcome} must still ask for attention`,
  );
}
assert.equal(
  automationRunNeedsAttention(run({ status: "ok", outcome: "accepted" })),
  false,
);
assert.equal(
  automationRunNeedsAttention(run({ status: "ok", outcome: "unjudged" })),
  false,
  "an unjudged result is not by itself a demand on the user",
);

// ── 사용자가 이미 봤으면 다시 요구하지 않는다 ──────────────────────────────
// 이게 없으면 해소 수단 없는 배지가 영원히 눌러앉는다(2026-08-06 오너 보고).
assert.equal(
  automationRunNeedsAttention(
    run({ status: "error", acknowledgedAt: "2026-08-12T00:00:00.000Z" }),
  ),
  false,
);
assert.equal(
  automationRunNeedsAttention(
    run({ status: "ok", outcome: "rejected", acknowledgedAt: "2026-08-12T00:00:00.000Z" }),
  ),
  false,
);

// ── 없는 실행은 요구가 아니다 ──────────────────────────────────────────────
assert.equal(automationRunNeedsAttention(null), false);
assert.equal(automationRunNeedsAttention(undefined), false);

console.log("automation attention: one rule, status and outcome and acknowledgement");
