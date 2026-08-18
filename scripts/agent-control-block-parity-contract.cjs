#!/usr/bin/env node
/*
 * 제어 블록 스트리핑 — Desktop ↔ Mobile 패리티 게이트.
 *
 * `mobile/contracts/agent-control-blocks.fixtures.json` 은 두 표면 중 어느 쪽도
 * 소유하지 않는 공유 픽스처다. 같은 파일을 Flutter 쪽
 * `test/agent_control_blocks_parity_test.dart` 가 읽는다. 두 구현의 출력이
 * 갈라지면 폰 화면에 `## Memory Events` JSON 이나 `<<agentlas-one-followups>>`
 * 원문이 답변인 척 뜬다 — 실제로 1.0.9 에서 그렇게 나갔다.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  stripAgentControlBlocks,
  AGENT_CONTROL_HEADINGS,
  AGENT_ASK_OPEN,
  AGENT_ASK_CLOSE,
  AGENT_FOLLOWUPS_OPEN,
  AGENT_FOLLOWUPS_CLOSE,
  AGENT_MULTIMODAL_MARKER,
} = require("../dist/shared/agent-control-blocks.js");
const { stripMobileBridgeControlFences } = require("../dist/electron/mobile-bridge/sanitize.js");
const { flattenAskFences } = require("../dist/shared/ask-fence-flatten.js");

const fixturePath = path.resolve(__dirname, "../../mobile/contracts/agent-control-blocks.fixtures.json");
assert.ok(
  fs.existsSync(fixturePath),
  `shared fixture is missing: ${fixturePath}. Mobile reads the same file — never fork it.`,
);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
assert.ok(
  Array.isArray(fixtures.cases) && fixtures.cases.length >= 20,
  "shared fixture must keep at least 20 cases",
);

for (const testCase of fixtures.cases) {
  assert.equal(
    stripAgentControlBlocks(testCase.input),
    testCase.expected,
    `settled text mismatch: ${testCase.name}`,
  );
  assert.equal(
    stripAgentControlBlocks(testCase.input, { streaming: true }),
    testCase.expectedStreaming,
    `streaming text mismatch: ${testCase.name}`,
  );
  // 브리지 진입점 계약(2026-08-18 갱신): 질문 펜스는 **평문화 후** 스트립한다 —
  // 지우면 모바일 사용자는 질문받은 사실조차 모른다. 기대값은 문자열이 아니라
  // 정본 함수 합성으로 잰다(게이트는 구현 문장이 아니라 계약을 못박는다).
  assert.equal(
    stripMobileBridgeControlFences(testCase.input),
    stripAgentControlBlocks(flattenAskFences(testCase.input, "ko")),
    `bridge entry point diverged from the shared ruleset: ${testCase.name}`,
  );
}

const FORBIDDEN = [
  ...AGENT_CONTROL_HEADINGS,
  AGENT_ASK_OPEN,
  AGENT_ASK_CLOSE,
  AGENT_FOLLOWUPS_OPEN,
  AGENT_FOLLOWUPS_CLOSE,
  AGENT_MULTIMODAL_MARKER,
];

for (const testCase of fixtures.cases) {
  for (const streaming of [false, true]) {
    const output = stripAgentControlBlocks(testCase.input, { streaming });
    for (const token of FORBIDDEN) {
      assert.ok(
        !output.includes(token),
        `${testCase.name} leaked "${token}" (streaming: ${streaming})`,
      );
    }
  }
}

// 적대적 반복에서도 열려서 실패하지 않는다. 상한을 넘기면 남은 첫 토큰 이후를
// 통째로 버린다 — electron/memory/events.ts stripAllMemoryEventBlocks 와 같은 규칙.
const spam = Array(200).fill('## Memory Events\n```json\n{"candidates":[]}\n```').join("\n");
const adversarial = stripAgentControlBlocks(`본문\n${spam}`);
assert.ok(!adversarial.includes("## Memory Events"), "adversarial repetition leaked a control heading");
assert.ok(adversarial.startsWith("본문"), "adversarial fallback discarded the real answer");

// ── 텔레그램도 같은 규칙을 쓴다 ────────────────────────────────────────────
// 텔레그램은 `<<agentlas-ask>>` 와 멀티모달 마커를 **평문으로 바꿔** 보여주므로
// 자기 처리를 갖는다. 하지만 나머지 제어 블록은 지워야 할 값이고, 예전에는 그
// 처리가 아예 없어 모바일이 겪은 유출을 텔레그램 사용자가 그대로 받았다.
const { flattenSentinelsForTelegram } = require("../dist/electron/telegram/connect.js");
const TELEGRAM_FORBIDDEN = [
  ...AGENT_CONTROL_HEADINGS,
  AGENT_FOLLOWUPS_OPEN,
  AGENT_FOLLOWUPS_CLOSE,
  AGENT_MULTIMODAL_MARKER,
];
for (const testCase of fixtures.cases) {
  for (const locale of ["ko", "en"]) {
    const output = flattenSentinelsForTelegram(testCase.input, locale);
    for (const token of TELEGRAM_FORBIDDEN) {
      assert.ok(
        !output.includes(token),
        `telegram leaked "${token}" for ${testCase.name} (${locale})`,
      );
    }
  }
}

console.log(
  `agent control-block parity: ${fixtures.cases.length} shared cases + adversarial fallback OK`,
);
console.log("agent control-block parity: telegram uses the same ruleset");
