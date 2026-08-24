#!/usr/bin/env node
/**
 * 오너 규칙: 답할 수 없는 것은 보여주지 않는다.
 *
 * 사고(손님 보고 2026-08-24): 승인함에 "Question text ending with ?" 라는 항목이
 * 12일째 박혀 있었다. 그것은 우리가 봇에게 주는 **질문 서식의 안내문**이다. 봇이
 * 자기 질문으로 바꿔 채우지 않고 그대로 제출했고, 걸러내는 곳이 없어 사용자 화면까지
 * 올라왔다. 진짜 질문이 아니라 답해도 이어갈 내용이 없으니 사라지지도 않았다.
 *
 * 계약:
 *  1) 서식을 그대로 낸 질문은 막는다 — 대화창에도, 승인함에도 뜨지 않는다.
 *  2) 진짜 질문은 막지 않는다(오폭 금지). 한국어·영어 모두.
 *  3) 판정은 한 곳에서 온다 — 받는 쪽과 목록 만드는 쪽이 같은 함수를 쓴다.
 *     두 벌이면 한쪽만 고쳐져 다시 새어 나온다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const built = path.join(root, "dist", "shared", "types.js");
assert.ok(fs.existsSync(built), "dist 가 없다 — 먼저 npm run build:electron");
const { isUnfilledQuestionTemplate } = require(built);
assert.equal(typeof isUnfilledQuestionTemplate, "function", "공용 판정 함수가 없다");

// ── 1) 막아야 하는 것 ──
const mustBlock = [
  ["손님이 본 그 항목", { question: "Question text ending with ?", header: "Short label", options: [{ label: "Option A" }, { label: "Option B" }] }],
  ["대소문자·공백만 다름", { question: "  question text ENDING with ?  ", options: [{ label: "가" }, { label: "나" }] }],
  ["질문은 채웠는데 선택지가 서식 그대로", { question: "어떻게 할까요?", options: [{ label: "Option A" }, { label: "Option B" }] }],
];
for (const [name, input] of mustBlock) {
  assert.equal(isUnfilledQuestionTemplate(input), true, `막아야 하는데 통과했다: ${name}`);
  console.log(`  막음 ✓ ${name}`);
}

// ── 2) 막으면 안 되는 것 (오폭) ──
const mustPass = [
  ["한국어 진짜 질문", { question: "한국어 어시스턴트를 어떻게 설정할까요?", header: "설정", options: [{ label: "덮어쓴다" }, { label: "새로 만든다" }] }],
  ["영어 진짜 질문", { question: "Which model should I use?", header: "Model", options: [{ label: "Opus" }, { label: "Sonnet" }] }],
  ["짧은 이름만 안 채움 — 답은 할 수 있다", { question: "삭제할까요?", header: "Short label", options: [{ label: "삭제" }, { label: "취소" }] }],
  ["선택지 하나만 서식 같음", { question: "어디에 넣을까요?", options: [{ label: "Option A" }, { label: "새 폴더" }] }],
];
for (const [name, input] of mustPass) {
  assert.equal(isUnfilledQuestionTemplate(input), false, `막으면 안 되는데 막았다: ${name}`);
  console.log(`  통과 ✓ ${name}`);
}

// ── 3) 판정이 한 곳에서 오는가 ──
for (const rel of ["electron/confirm/index.ts", "renderer/lib/ask-question.ts"]) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  assert.ok(
    src.includes("isUnfilledQuestionTemplate("),
    `${rel} 이 공용 판정을 안 쓴다 — 한쪽만 막으면 다른 쪽으로 샌다`,
  );
}
console.log("  판정 정의: 한 곳(대화창 + 승인함이 같은 함수) ✓");

// ── 4) 서식 문구가 바뀌면 이 게이트가 눈이 먼다 ──
const runner = fs.readFileSync(path.join(root, "electron", "runtime", "runner.ts"), "utf8");
assert.ok(
  runner.includes("Question text ending with ?"),
  "봇에게 주는 서식 문구가 바뀌었다 — 판정도 함께 갱신해야 이 검사가 의미를 갖는다",
);

console.log("unanswerable questions PASS: 서식을 그대로 낸 질문은 화면에 오르지 않고, 진짜 질문은 그대로 통과한다");
