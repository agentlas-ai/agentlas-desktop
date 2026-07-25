#!/usr/bin/env node
// plain 대화 감지 / Hephaestus 에스컬레이션 게이트 회귀 테스트.
// 실행: npm run build:electron && node scripts/test-auto-router-gates.cjs
const assert = require("node:assert/strict");
const {
  isPlainConversationalPrompt,
  isEscalationWorthyPrompt,
  shouldAutoEngageNetworkWorkforce,
  selectAutoRoutedAgent,
  selectAutoRoutedAgentJudged,
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

const complexPrompt = "여러 전문 에이전트가 시장 조사와 제품 설계, 백엔드 구현, 품질 검증을 각각 맡고 결과를 순서대로 통합해 주세요.";
const eligible = {
  agentAppMode: false,
  networkAutoEnabled: true,
  globalOrchestrator: true,
  hasPriorContext: false,
  prompt: complexPrompt,
};
assert.equal(shouldAutoEngageNetworkWorkforce(eligible), true, "fresh top-level complex prompt must enter Workforce");
assert.equal(shouldAutoEngageNetworkWorkforce({ ...eligible, networkAutoEnabled: false }), false, "saved opt-out must win");
assert.equal(shouldAutoEngageNetworkWorkforce({ ...eligible, hasPriorContext: true }), false, "continuations stay in their current session");
assert.equal(shouldAutoEngageNetworkWorkforce({ ...eligible, globalOrchestrator: false }), false, "specialists must not recursively auto-route");
assert.equal(shouldAutoEngageNetworkWorkforce({ ...eligible, agentAppMode: true }), false, "Agent Apps remain isolated");
assert.equal(shouldAutoEngageNetworkWorkforce({ ...eligible, prompt: "fix typo in README" }), false, "short single tasks stay local");

// ── Judged final assignment: the model decides; lexical+embedding = recruitment/fallback ──
(async () => {
  const agent = (id, name, systemPrompt, tagline = "") => ({
    id, slug: id, name, nameEn: name, tagline, taglineEn: tagline, systemPrompt,
    mcpServers: [], envRequirements: [], kind: "single", visibility: "normal",
  });
  const inactive = () => ({ activeModel: false, eligibleIds: new Set() });
  const translator = agent("legal-translator", "Legal Translator", "Translates contracts.", "Contract translation specialist");
  const seeder = agent("comment-seeder", "Comment Seeder", "Posts community comments.", "Community comment automation");

  // (a) The judge can pick an agent with lexical score ZERO — an Arabic request no
  //     wordlist or name overlap could ever recruit.
  const arabicPrompt = "ترجم هذا العقد إلى الإنجليزية مع الحفاظ على الصياغة القانونية";
  assert.equal(
    selectAutoRoutedAgent(arabicPrompt, [translator, seeder], "en", { allowFallback: false, semanticRoute: inactive }),
    null,
    "documented lexical miss: the scorer sees nothing in the Arabic request",
  );
  const judged = await selectAutoRoutedAgentJudged(arabicPrompt, [translator, seeder], "en", {
    allowFallback: false,
    semanticRoute: inactive,
    judgeFn: async (spec) => {
      assert.equal(spec.kind, "agent-auto-route");
      assert.ok(spec.labels.includes("none"), "the judge must be allowed to answer none");
      assert.equal(spec.fallback, "none", "the lexical miss must be offered as the fallback prior");
      assert.ok(spec.labels.includes("legal-translator"), "a zero-score agent must still be in the judged pool");
      return { verdict: "legal-translator", source: "llm", confidence: 0.9, reason: "contract translation" };
    },
  });
  assert.equal(judged.source, "llm");
  assert.equal(judged.choice.agent.id, "legal-translator", "the judged verdict must pick an agent with lexical score 0");

  // (b) A judged "none" vetoes a lexically-recruited mis-route.
  const baity = "Post a translated legal note as a community comment draft"; // overlaps seeder terms
  const vetoed = await selectAutoRoutedAgentJudged(baity, [translator, seeder], "en", {
    allowFallback: false,
    semanticRoute: inactive,
    judgeFn: async () => ({ verdict: "none", source: "llm", confidence: 0.8, reason: "coordinator should answer" }),
  });
  assert.equal(vetoed.source, "llm");
  assert.equal(vetoed.choice, null, "a judged none must override lexical recruitment");

  // (c) No model = today's lexical+embedding behavior, labeled fallback.
  const namedPrompt = "Use Comment Seeder to post the weekly thread";
  const fallback = await selectAutoRoutedAgentJudged(namedPrompt, [translator, seeder], "en", {
    allowFallback: false,
    semanticRoute: inactive,
    judgeFn: async (spec) => ({ verdict: spec.fallback, source: "fallback", confidence: 0, reason: "no model" }),
  });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.choice.agent.id, "comment-seeder", "no model keeps the previous lexical route");

  // (d) A hallucinated slug never routes: fall back to the lexical choice.
  const hallucinated = await selectAutoRoutedAgentJudged(namedPrompt, [translator, seeder], "en", {
    allowFallback: false,
    semanticRoute: inactive,
    judgeFn: async () => ({ verdict: "made-up-agent", source: "llm", confidence: 0.9, reason: "?" }),
  });
  assert.equal(hallucinated.source, "fallback");
  assert.equal(hallucinated.choice.agent.id, "comment-seeder");

  // (e) allowFallback + judged none = the default coordinator, never a mis-route.
  const pmSoul = agent("agentlas-pm-soul", "Project Coordinator", "Coordinate work.");
  const coordinated = await selectAutoRoutedAgentJudged(baity, [translator, seeder, pmSoul], "en", {
    allowFallback: true,
    semanticRoute: inactive,
    judgeFn: async () => ({ verdict: "none", source: "llm", confidence: 0.8, reason: "no specialist" }),
  });
  assert.equal(coordinated.choice.agent.id, "agentlas-pm-soul");

  console.log("test-auto-router-gates: PASS");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
