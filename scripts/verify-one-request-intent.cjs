#!/usr/bin/env node

const assert = require("node:assert/strict");
const { classifyOneRequestIntent } = require("../dist/shared/one-request-intent.js");

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

for (const prompt of conversations) {
  assert.equal(classifyOneRequestIntent(prompt), "conversation", prompt);
}
for (const prompt of tasks) {
  assert.equal(classifyOneRequestIntent(prompt), "task", prompt);
}

console.log(JSON.stringify({ ok: true, conversations: conversations.length, tasks: tasks.length }));
