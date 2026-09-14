#!/usr/bin/env node
"use strict";

/*
 * 스킬 라이브러리는 **메뉴판이 되면 안 된다.**
 *
 * 스킬 145개의 설명을 다 실으면 59,213자(영어 기준 약 14,800토큰)다. 연구 루프는 수십 턴을 돌므로
 * 그 값이 턴마다 나간다. 오너 합격 조건이 정확히 이것이다 — "토큰 낭비 없게 메뉴판을 적절하게".
 *
 * 그래서 노출하는 것은 도구 몇 개뿐이고, 후보는 **지금 있는 자리**(열어 둔 랩 / 하네스 단계)로
 * 좁혀서 준다. 검색어를 잘 지어내야 찾아지는 구조는 이미 실패했다 — "compare two groups unequal
 * variance" 에 networkx 가 1등으로 나왔다.
 *
 * 이 검사는 소스 문자열을 대조하지 않는다. 플러그인이 쓰는 그 함수를 실제로 불러 **바이트를 잰다.**
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "plugins", "agentlas-science-skills");
const skills = require(path.join(root, "runtime", "skills.cjs"));
const tools = JSON.parse(fs.readFileSync(path.join(root, "schemas", "tools.json"), "utf8"));
const index = skills.skillIndex;

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

// ── 상시 비용: 도구 정의만 프롬프트에 산다 ──────────────────────────────────
const ALWAYS_ON_LIMIT = 4_000;
assert.ok(
  bytes(tools) <= ALWAYS_ON_LIMIT,
  `도구 정의가 ${bytes(tools)}자다. 이 값은 매 턴 나간다 — ${ALWAYS_ON_LIMIT}자를 넘기지 말 것`,
);

// 설명 전부를 실으면 얼마인지 같이 재서, 이 검사가 무엇을 막고 있는지 눈에 보이게 한다.
const everyDescription = index.skills.reduce((sum, skill) => sum + skill.description.length, 0);
assert.ok(everyDescription > 40_000, "설명 총량이 갑자기 작아졌다 — 색인이 비었는지 확인할 것");

// ── 한 자리에서 돌려주는 양 ─────────────────────────────────────────────────
// 사람이 한 번에 고를 수 있는 수를 넘으면 그것도 메뉴판이다.
const PLACE_LIMIT = 6_000;
const PLACE_COUNT_LIMIT = 25;
const places = [
  ...index.labs.map((lab) => ({ lab })),
  ...index.stages.map((stage) => ({ stage })),
];
let widest = 0;
for (const place of places) {
  const result = skills.skillsHere(place);
  const size = bytes(result);
  widest = Math.max(widest, size);
  assert.ok(size <= PLACE_LIMIT, `${JSON.stringify(place)} 가 ${size}자를 돌려준다 — ${PLACE_LIMIT}자 이하로`);
  assert.ok(
    result.procedures.length <= PLACE_COUNT_LIMIT,
    `${JSON.stringify(place)} 에 ${result.procedures.length}개가 걸려 있다 — 한 자리는 ${PLACE_COUNT_LIMIT}개 이하로 나눌 것`,
  );
  // 후보가 0개여도 조용히 빈 배열만 주면 모델은 "그런 건 없다"로 읽는다. 다음 행동을 줘야 한다.
  assert.ok(result.note && result.note.trim().length > 0, `${JSON.stringify(place)} 에 다음 행동 안내가 없다`);
}

// ── 자리를 안 주면 거절한다(전체를 쏟지 않는다) ─────────────────────────────
assert.throws(
  () => skills.skillsHere({}),
  (error) => error.code === "science-skill-place-required",
  "자리 없이 부르면 전체를 돌려주면 안 된다",
);

// ── 하네스 단계에는 랩과 무관한 공통 절차가 실제로 걸려 있어야 한다 ─────────
// 실험 설계·가설 수립·논문 작성은 화학이든 천문이든 똑같이 필요하다. 랩에만 매달면
// 그 랩을 안 연 연구자는 영영 못 본다.
const MUST_BE_FILED = {
  hypotheses: "hypothesis-generation",
  "plan-protocols": "experimental-design",
  manuscript: "scientific-writing",
  interpretation: "scientific-critical-thinking",
};
for (const [stage, name] of Object.entries(MUST_BE_FILED)) {
  const names = skills.skillsHere({ stage }).procedures.map((row) => row.name);
  assert.ok(names.includes(name), `${stage} 단계에 "${name}" 이 없다`);
}

// ── 라이선스 경계: 들어오면 안 되는 것 ──────────────────────────────────────
// alphagenome 은 프런트매터가 MIT 라 기계 판정을 통과하지만 그 서비스가 비상업 전용이다.
// docx/pdf/pptx/xlsx 는 Anthropic 독점이라 재배포가 금지돼 있다.
for (const banned of ["alphagenome", "docx", "pdf", "pptx", "xlsx"]) {
  assert.ok(
    !index.skills.some((skill) => skill.name === banned),
    `"${banned}" 이 번들에 들어왔다 — 상용 배포가 불가한 스킬이다`,
  );
}

// ── 본문은 골랐을 때만 읽는다 ───────────────────────────────────────────────
const opened = skills.openSkill({ name: "experimental-design" });
assert.ok(opened.procedure.length > 5_000, "절차 전문이 비어 있다");
assert.throws(
  () => skills.openSkill({ name: "../../etc/passwd" }),
  (error) => error.code === "science-skill-not-found",
  "색인에 없는 이름으로 파일을 읽으면 안 된다",
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  skills: index.count,
  alwaysOnBytes: bytes(tools),
  widestPlaceBytes: widest,
  everyDescriptionBytes: everyDescription,
})}\n`);
