#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  classifyOneRequestIntent,
  lexicalOneRequestIntent,
  ONE_REQUEST_INTENT_JUDGMENT_KIND,
  oneRequestIntentJudgmentInput,
} = require("../dist/shared/one-request-intent.js");

const conversations = [
  "안녕하세요",
  "고마워요",
  "한국의 수도가 어디야?",
  "Why is the sky blue?",
  "One 언어 어디서 바꿈?",
];

const tasks = [
  "아이와 제주 2박 3일 여행 계획을 짜줘. 날짜별 일정, 이동 순서, 예상 비용, 체크리스트까지 만들어줘.",
  "이 문제집 3번 문제를 초등학생도 이해하게 해설해줘.",
  "매일 20분씩 영어 회화를 공부할 계획을 만들어줘.",
  "50만원 이하 공기청정기 중 우리 집에 맞는 제품을 찾아서 비교해줘.",
  "최저가격을 검색하고 믿을 수 있는 판매처를 정리해줘.",
  "이 내용을 Word 문서로 작성해줘.",
  "매출 자료를 Excel 표로 만들어줘.",
  "이 사진들로 20초 소개 영상을 만들어줘.",
  "Plan a three-day family trip with a $1,000 budget and a checklist.",
  "Create an Excel spreadsheet comparing the five products.",
];

// The wordlists survive ONLY as the judge's prior — lexicalOneRequestIntent.
for (const prompt of conversations) {
  assert.equal(lexicalOneRequestIntent(prompt), "conversation", prompt);
}
for (const prompt of tasks) {
  assert.equal(lexicalOneRequestIntent(prompt), "task", prompt);
}

assert.equal(ONE_REQUEST_INTENT_JUDGMENT_KIND, "one-request-intent");
assert.equal(oneRequestIntentJudgmentInput("  a\n b  "), "a b");

// (a) A stub judge verdict decides — task fires on phrasing every wordlist misses.
const arabicWork = "رتّب لي خطة سفر ليومين مع ميزانية وقائمة تحقق";
assert.equal(classifyOneRequestIntent(arabicWork, () => "task"), "task",
  "a judged task verdict must win over a wordlist miss");
// A judged "conversation" vetoes a wordlist false positive.
assert.equal(classifyOneRequestIntent("최저가격 검색이 뭐야?", () => "conversation"), "conversation",
  "a judged conversation verdict must override an incidental wordlist hit");

// (b) NO connected-model verdict → UNDECIDED, never the keyword/lexical verdict.
assert.equal(classifyOneRequestIntent(arabicWork, () => null), "undecided",
  "no model → undecided, not the wordlist verdict");
assert.equal(classifyOneRequestIntent(tasks[0]), "undecided",
  "no judged reader (renderer / no model) → undecided");
assert.notEqual(classifyOneRequestIntent(tasks[0], () => null), "task",
  "a no-model turn must NOT be keyword-classified as task");
assert.notEqual(classifyOneRequestIntent(tasks[0], () => null), lexicalOneRequestIntent(tasks[0]),
  "the no-model outcome must not equal the wordlist verdict");

console.log(JSON.stringify({ ok: true, conversations: conversations.length, tasks: tasks.length, undecided: true }));
