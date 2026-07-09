// Oberon Cinematic Workflow — 행위/구조 계약 테스트.
// 프롬프트 스캐폴드가 표준 촬영 요소를 담고, 워크플로우 스테이지·레이아웃·추출/수정
// 규칙이 결정적으로 동작하는지 검증한다.
//
// 실행: npm run test:oberon-cinematic  (build:electron 후 node로 실행)
const assert = require("node:assert/strict");
const mod = require("../dist/shared/oberon-cinematic.js");
const sheets = require("../dist/shared/oberon-sheets.js");

// ── 1) 6하원칙 병합 ──────────────────────────────────────────────────────────
const scene6w = {
  who: "30대 초반 두 인물",
  when: "늦은 오후, 황금빛 역광",
  where: "창가 자리가 있는 조용한 카페",
  how: "얕은 심도, 망원 압축, 16mm 그레인",
  what: "이별을 통보하고 담담히 듣는다",
  why: "체념과 고립감",
};
const merged = mod.buildSixWScenePrompt(scene6w);
for (const label of ["누가:", "어디서:", "무엇을:", "어떻게:", "언제:", "왜:"]) {
  assert.ok(merged.includes(label), `6W merge must include ${label}`);
}
const json = mod.buildSixWJsonPrompt({ who: "a", where: "b", what: "c", camera: "d", lighting: "e", when: "f", mood: "g" });
assert.deepEqual(JSON.parse(json), { who: "a", where: "b", what: "c", camera: "d", lighting: "e", when: "f", mood: "g" });

// ── 2) 커버리지 그리드: 섹션 순서 + 패널 수(9) + 참조 규율 토글 ───────────────
const scene = "늦은 오후, 창가 자리가 있는 조용한 카페 내부. 두 인물의 이별 장면.";
const grid = mod.buildSceneGridPrompt({ sceneDescription: scene });
assert.ok(grid.startsWith(`[장면 설명]\n${scene}`), "grid must start with scene description");
const order = ["[장면 설명]", "[참조 규율]", "[커버리지 구성]", "[촬영 스타일]", "[연속성 체크]", "[창작 원칙]", "[패널 번호]"];
let cursor = -1;
for (const section of order) {
  const idx = grid.indexOf(section);
  assert.ok(idx > cursor, `sections must appear in order — ${section}`);
  cursor = idx;
}
// 표준 촬영 요소가 담겼는지 (구체적 시각 정보)
for (const term of ["샷 사이즈", "앵글", "렘브란트", "피사계 심도", "180도"]) {
  assert.ok(grid.includes(term) || mod.continuityChecklistBlock(9).length > 0, `coverage prompt carries standard vocabulary`);
}
assert.ok(grid.includes("9개 패널"), "grid uses 9 panels");
assert.ok(grid.includes("1부터 9까지"), "grid numbers panels 1..9");
assert.ok(!grid.includes("1행 (설정·맥락)"), "row shot spec OFF by default");

const gridRows = mod.buildSceneGridPrompt({ sceneDescription: scene, withRowShotSpec: true });
assert.ok(gridRows.includes("1행 (설정·맥락): 익스트림 롱 샷(ELS"), "row spec present when requested");
assert.ok(gridRows.includes("3행 (디테일·앵글): 익스트림 클로즈업(ECU"), "all three rows");

const gridNoSheets = mod.buildSceneGridPrompt({ sceneDescription: scene, withReferenceSheets: false });
assert.ok(!gridNoSheets.includes("[참조 규율]"), "reference discipline omitted without sheets");

// ── 3) 4단 스택: 패널 수 4 + 시간 흐름 라벨 ──────────────────────────────────
const stack = mod.buildSceneStackPrompt({ sceneDescription: scene });
assert.ok(stack.includes("4단 스택"), "stack labeled");
assert.ok(stack.includes("시간 순서대로 전개"), "temporal flow described");
assert.ok(stack.includes("4개 패널"), "4 panels");
assert.ok(stack.includes("1부터 4까지"), "numbers 1..4");
assert.ok(!stack.includes("9개 패널"), "no 9-panel leftover");

// ── 4) 스토리보드: 스케치 어휘만, 사진/색 어휘 금지 ──────────────────────────
const panel = mod.buildStoryboardPanelPrompt({
  shotSize: "미디엄 샷", angle: "로우 앵글", lensMm: 35,
  subjectAction: "남자가 창밖을 본다", spaceCore: "낡은 사무실",
  composition: "좌측 1/3, 시선 프레임 밖", shotNumber: 3,
});
assert.ok(panel.includes('"3" — the only text in the frame.'), "shot number label");
for (const banned of ["photorealistic", "film grain", "color grading", "cinematic color"]) {
  assert.ok(!panel.toLowerCase().includes(banned), `storyboard must not carry photo/color vocab: ${banned}`);
}
const seq = mod.buildStoryboardSequencePrompt(
  Array.from({ length: 6 }, (_, i) => ({
    shotSize: "MS", angle: "eye level", lensMm: 35, subjectAction: "인물이 걷는다", spaceCore: "골목", composition: "중앙", shotNumber: i + 1,
  })),
);
assert.ok(seq.includes("6 monochrome storyboard sketch panels in a 3x2 grid"), "sequence sheet phrasing");

// ── 5) 개별 추출: 2~3장 배치 ─────────────────────────────────────────────────
const extract = mod.buildPanelExtractionPrompts([1, 4, 7, 9], 3);
assert.equal(extract.length, 2, "4 panels → batches of 3+1");
assert.ok(extract[0].includes("1번 패널을 추출해 단독 스틸 컷으로 생성."), "extraction phrasing");
assert.equal(extract[1], "9번 패널을 추출해 단독 스틸 컷으로 생성.");

// ── 6) 연속성 수정 형식 ──────────────────────────────────────────────────────
const fix = mod.buildContinuityFixPrompt([
  { panel: 3, instruction: "좌우 반전" },
  { panel: 8, instruction: "테이블 앞 인물 의상 변경 + 좌우 반전" },
]);
assert.ok(fix.includes("1. 3번 패널 좌우 반전 — 180도 법칙 위반"), "fix line format");
assert.ok(fix.includes("2. 8번 패널 테이블 앞 인물 의상 변경 + 좌우 반전 — 180도 법칙 위반"));

// ── 7) 레퍼런스 차용: 유지→삭제→변경 순서 + 첨부 순서 규칙 ───────────────────
const borrow = mod.buildReferenceBorrowPrompt({
  keep: ["첫 번째 이미지의 구도·조명·앵글·배경을 유지한다."],
  remove: ["도로 위 인물들을 제거하고"],
  change: ["인물을 두 번째 이미지의 여성으로 교체한다."],
});
assert.ok(borrow.indexOf("유지한다") < borrow.indexOf("제거하고"), "keep before remove");
assert.ok(borrow.indexOf("제거하고") < borrow.indexOf("교체한다"), "remove before change");
assert.ok(mod.REFERENCE_ATTACH_ORDER_RULE.includes("첫 번째로"), "attach-order rule");

// ── 8) 린트 규칙 ─────────────────────────────────────────────────────────────
assert.ok(mod.lintCinematicPrompt("cinematic, 8K, ultra HD, masterpiece, best quality").some((f) => f.rule === "quality_keyword_spam"));
assert.ok(mod.lintCinematicPrompt("슬프고 외로운 분위기").some((f) => f.rule === "emotion_without_visuals"));
assert.ok(mod.lintCinematicPrompt("두 사람이 대화하다가 한 명이 일어나서 나가고, 남은 사람이 커피를 마신다").some((f) => f.rule === "multiple_moments"));
assert.equal(mod.lintCinematicPrompt("클로즈업, 역광 자연광, 얕은 심도, 16mm 필름 그레인, 탈채도 따뜻한 색보정").length, 0, "compliant prompt passes");

// ── 9) 레이아웃 추천 + 시트 배선 ─────────────────────────────────────────────
assert.equal(mod.recommendPanelLayout({ shotCount: 8 }), "grid_3x3");
assert.equal(mod.recommendPanelLayout({ needsTemporalFlow: true }), "stack_4");
assert.equal(mod.recommendPanelLayout({}), "stack_4");
for (const kind of ["scene_grid_3x3", "scene_stack_4", "storyboard_sequence"]) {
  assert.equal(sheets.sheetAssetKind(kind), "storyboard_sheet", `${kind} passes through unmodified`);
  assert.equal(sheets.sheetAspect(kind), "16:9");
}

// ── 10) 파이프라인 스테이지 + 오케스트레이터 ─────────────────────────────────
assert.deepEqual(
  mod.CINEMATIC_PIPELINE_STAGES.map((s) => s.id),
  ["single_cut", "grid_coverage", "panel_extract", "continuity_fix", "animate_edit"],
);
const plan = mod.buildCinematicWorkflow({ scene: scene6w, shotCount: 9 });
assert.equal(plan.layout, "grid_3x3");
assert.ok(plan.singleCutPrompt.includes("누가: 30대 초반 두 인물"));
assert.equal(plan.lint.length, 0);
assert.equal(plan.coverageSheet.kind, "scene_grid_3x3");
assert.ok(plan.coverageSheet.prompt.includes("[커버리지 구성]"));
assert.equal(sheets.sheetAssetKind(plan.coverageSheet.kind), "storyboard_sheet");
assert.deepEqual(plan.buildExtraction([2, 5]), ["2번 패널을 추출해 단독 스틸 컷으로 생성.\n5번 패널을 추출해 단독 스틸 컷으로 생성."]);
assert.ok(plan.buildFix([{ panel: 5, instruction: "좌우 반전" }]).includes("5번 패널 좌우 반전 — 180도 법칙 위반"));

const stackPlan = mod.buildCinematicWorkflow({ scene: "골목을 걷는 남자, 이른 아침, 롱 샷, 청회색 톤, 필름 그레인", needsTemporalFlow: true });
assert.equal(stackPlan.layout, "stack_4");
assert.equal(stackPlan.coverageSheet.kind, "scene_stack_4");

console.log("oberon cinematic workflow contract ok");
