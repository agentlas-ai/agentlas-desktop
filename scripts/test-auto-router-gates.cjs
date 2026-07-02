#!/usr/bin/env node
// plain 대화 감지 / Hephaestus 에스컬레이션 게이트 회귀 테스트.
// 실행: npm run build:electron && node scripts/test-auto-router-gates.cjs
const assert = require("node:assert/strict");
const {
  isPlainConversationalPrompt,
  isEscalationWorthyPrompt,
} = require("../dist/electron/agents/auto-router.js");

// plain으로 판정되어야 하는 것들 — 라우팅/에스컬레이션 전부 스킵, 즉답
const plain = ["안녕", "안녕하세요!", "고마워", "감사합니다", "ㅋㅋㅋ", "hi", "Hello", "thanks", "ok", "넵", "좋아요", "수고했어", ""];
for (const p of plain) {
  assert.equal(isPlainConversationalPrompt(p), true, `plain이어야 함: "${p}"`);
  assert.equal(isEscalationWorthyPrompt(p), false, `에스컬레이션 안 함: "${p}"`);
}

// plain이 아니어야 하는 것들 — 짧아도 작업 지시는 라우팅 경로 유지
const tasky = [
  "빌드 고쳐줘",
  "결제 버그 찾아줘",
  "fix the login bug",
  "PPT 만들어줘",
  "안녕하세요, 이번 분기 마케팅 계획을 세우고 각 채널별 담당 에이전트를 배정해 주세요",
];
for (const p of tasky) {
  assert.equal(isPlainConversationalPrompt(p), false, `plain이면 안 됨: "${p}"`);
}

// 에스컬레이션 가치: 멀티도메인/파이프라인 신호 또는 충분히 복합적인 요청
assert.equal(isEscalationWorthyPrompt("웹마스터랑 카피라이터 여러 에이전트 동시에 불러서 랜딩 만들어줘"), true);
assert.equal(isEscalationWorthyPrompt("리서치 → 초안 → 검수 파이프라인으로 처리해줘"), true);
assert.equal(isEscalationWorthyPrompt("Run this as a team, in parallel"), true);
// 짧은 단일 작업은 로컬 스코어러로 충분 — 15초 라우팅 선지연 금지
assert.equal(isEscalationWorthyPrompt("빌드 고쳐줘"), false);
assert.equal(isEscalationWorthyPrompt("fix typo in README"), false);
// 긴 복합 요청(80자 이상)은 에스컬레이션
assert.equal(
  isEscalationWorthyPrompt(
    "이번 신제품 출시를 위해 시장 조사를 하고, 조사 결과를 바탕으로 포지셔닝 문서를 작성한 다음, 그걸로 랜딩 페이지 카피와 광고 소재 초안까지 이어서 만들어 주세요.",
  ),
  true,
);

console.log("test-auto-router-gates: PASS");
