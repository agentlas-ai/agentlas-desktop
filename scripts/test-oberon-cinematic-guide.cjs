// 오베론 시네마틱 가이드 엔진 — 원문 일치(토씨) 계약 테스트.
//
// 핵심 계약: shared/oberon-cinematic-guide.ts의 템플릿 상수들은
// docs/oberon-cinematic-guide/ch6.md·ch7.md에 저장된 가이드 원문에
// **정확한 부분 문자열로** 존재해야 한다. 누군가 템플릿 문구를 "개선"하면
// 이 테스트가 깨진다 — 가이드가 곧 스펙이다.
//
// 실행: npm run test:oberon-cinematic-guide  (build:electron 후 node로 실행)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const guide = (name) => fs.readFileSync(path.join(root, "docs", "oberon-cinematic-guide", name), "utf8");
const mod = require("../dist/shared/oberon-cinematic-guide.js");
const sheets = require("../dist/shared/oberon-sheets.js");

const ch6 = guide("ch6.md");
const ch7 = guide("ch7.md");

// ── 1) 토씨 계약: 그리드 섹션 원문이 ch7.md에 그대로 존재 ────────────────────
for (const [name, constant] of [
  ["GRID_REFERENCE_RULES", mod.GRID_REFERENCE_RULES],
  ["GRID_STACK_COMPOSITION", mod.GRID_STACK_COMPOSITION],
  ["GRID_SHOOTING_STYLE", mod.GRID_SHOOTING_STYLE],
  ["GRID_CONTINUITY_CHECK", mod.GRID_CONTINUITY_CHECK],
  ["GRID_CREATIVE_PRINCIPLE", mod.GRID_CREATIVE_PRINCIPLE],
  ["GRID_MISC", mod.GRID_MISC],
  ["GRID_ROW_SHOT_SPEC", mod.GRID_ROW_SHOT_SPEC],
]) {
  assert.ok(
    ch7.includes(constant),
    `${name} must appear VERBATIM in docs/oberon-cinematic-guide/ch7.md — 템플릿 문구를 바꾸지 마라, 가이드가 스펙이다.`,
  );
}

// 스토리보드 패널 템플릿의 고정 문구가 ch6.md 원문과 일치 (슬롯 제외 라인)
for (const line of [
  "Monochrome storyboard panel, graphite pencil and charcoal sketch",
  "style, confident rough linework.",
  "Light gray tonal shading for depth, white paper background visible",
  "Frame proportion inside the panel: 16:9.",
]) {
  assert.ok(ch6.includes(line), `storyboard template line must match ch6.md verbatim: "${line}"`);
}
assert.ok(
  ch6.includes("one single image containing 6 monochrome sketch panels arranged in a 3x2 grid"),
  "sequence-sheet phrase must exist in ch6.md",
);

// ── 2) 그리드 프롬프트 조립: 섹션 순서 + 행별 샷 지정 옵션 ────────────────────
const scene = "늦은 오후, 창가 자리가 있는 조용한 서울의 카페 내부.";
const grid = mod.buildSceneGridPrompt({ sceneDescription: scene });
assert.ok(grid.startsWith(`[장면 설명]\n${scene}`), "grid prompt must start with [장면 설명]");
const order = ["[장면 설명]", "[레퍼런스 규칙]", "[이미지 스택 구성]", "[촬영 스타일]", "[연속성 체크]", "[창작 원칙]", "[기타 사항]"];
let cursor = -1;
for (const section of order) {
  const idx = grid.indexOf(section);
  assert.ok(idx > cursor, `grid sections must appear in guide order — ${section}`);
  cursor = idx;
}
assert.ok(!grid.includes("1행 (배경 설정 및 맥락)"), "row shot spec must be OFF by default");

const gridWithRows = mod.buildSceneGridPrompt({ sceneDescription: scene, withRowShotSpec: true });
assert.ok(gridWithRows.includes("1행 (배경 설정 및 맥락): 익스트림 롱 샷 (ELS)"), "row spec verbatim when requested");
assert.ok(gridWithRows.includes("3행 (디테일 및 앵글): 익스트림 클로즈업 (ECU)"), "all three rows present");

const gridNoSheets = mod.buildSceneGridPrompt({ sceneDescription: scene, withReferenceSheets: false });
assert.ok(!gridNoSheets.includes("[레퍼런스 규칙]"), "reference rules omitted when no sheets attached");

// ── 3) 4단 스택 변환: 패널 수·번호·배치만 치환, 나머지 문구는 그리드와 동일 ────
const stack = mod.buildSceneStackPrompt({ sceneDescription: scene });
assert.ok(stack.includes("4단 이미지 스택"), "stack layout named");
assert.ok(stack.includes("위에서 아래로 시간 순서대로 장면이 전개"), "temporal-flow definition from ch6");
assert.ok(!stack.includes("9개 패널"), "no 9-panel wording left in stack prompt");
assert.ok(stack.includes("4개 패널"), "panel count adjusted to 4");
assert.ok(stack.includes("숫자 1~4까지"), "panel numbering adjusted to 1~4");

// ── 4) 스토리보드: 사진 질감·색 어휘 금지 (ch6: "스토리보드는 스케치, 키프레임은 실사") ──
const panel = mod.buildStoryboardPanelPrompt({
  shotSize: "미디엄 샷",
  angle: "로우 앵글",
  lensMm: 35,
  subjectAction: "남자가 창밖을 본다",
  spaceCore: "낡은 사무실",
  composition: "피사체 좌측 1/3, 시선은 프레임 밖 오른쪽",
  shotNumber: 3,
});
assert.ok(panel.includes('"3" — the only text in the frame.'), "shot number label slot filled");
for (const banned of ["photorealistic", "film grain", "color grading", "cinematic color"]) {
  assert.ok(!panel.toLowerCase().includes(banned), `storyboard must not contain photo/color vocabulary: ${banned}`);
}
const seq = mod.buildStoryboardSequencePrompt([panel, panel, panel, panel, panel, panel].map((_, i) => ({
  shotSize: "미디엄 샷", angle: "아이 레벨", lensMm: 35,
  subjectAction: "인물이 걷는다", spaceCore: "골목", composition: "중앙 배치", shotNumber: i + 1,
})));
assert.ok(seq.includes("6 monochrome sketch panels arranged in a 3x2 grid"), "sequence sheet phrasing");

// ── 5) 개별 추출: 문구 원형 + 2~3장 배치 규칙 ────────────────────────────────
const extract = mod.buildPanelExtractionPrompts([1, 4, 7, 9], 3);
assert.equal(extract.length, 2, "4 panels split into batches of 3+1");
assert.ok(extract[0].includes("1번 이미지를 추출하여 1장의 스틸 컷으로 생성."), "extraction phrasing verbatim");
assert.equal(extract[1], "9번 이미지를 추출하여 1장의 스틸 컷으로 생성.");

// ── 6) 연속성 수정: ch7 수정 지시 형식 그대로 ─────────────────────────────────
const fix = mod.buildContinuityFixPrompt([
  { panel: 3, instruction: "좌우반전" },
  { panel: 8, instruction: "테이블 앞 여자의 의상 변경 및 좌우반전" },
]);
assert.ok(fix.includes("1. 3번 이미지 좌우반전 - 180도 법칙 위배"), "fix line format matches ch7");
assert.ok(fix.includes("2. 8번 이미지 테이블 앞 여자의 의상 변경 및 좌우반전 - 180도 법칙 위배"));

// ── 7) 레퍼런스 차용(4장): 색상톤/팔레트 문구 원문 + 첨부 순서 규칙 ───────────
assert.equal(mod.COLOR_TONE_BORROW_PROMPT, "첫번째 이미지의 모든 것을 유지한 채로 두번째 이미지의 색상톤을 적용한다.");
assert.ok(mod.REFERENCE_ATTACH_ORDER_RULE.includes("변경할 이미지를 ‘첫번째’로 첨부"));
const borrow = mod.buildReferenceBorrowPrompt({
  keep: ["첫 번째 이미지의 구도, 조명, 카메라 앵글, 배경을 그대로 유지한다."],
  remove: ["도로 위의 오토바이와 ATV를 탄 다섯 명을 모두 제거하고"],
  change: ["인물만 두 번째 이미지의 여성으로 교체한다."],
});
assert.ok(borrow.indexOf("유지한다") < borrow.indexOf("제거하고"), "keep before remove");
assert.ok(borrow.indexOf("제거하고") < borrow.indexOf("교체한다"), "remove before change");

// ── 8) 린트(5장 실수 규칙) ───────────────────────────────────────────────────
const spam = mod.lintCinematicPrompt("cinematic, 8K, ultra HD, masterpiece, best quality, extremely detailed");
assert.ok(spam.some((f) => f.rule === "quality_keyword_spam"), "quality keyword spam detected");
const emo = mod.lintCinematicPrompt("슬프고 외로운 분위기");
assert.ok(emo.some((f) => f.rule === "emotion_without_visuals"), "emotion-only prompt detected");
const multi = mod.lintCinematicPrompt("두 사람이 카페에서 대화하다가 한 명이 일어나서 나가고, 남은 사람이 커피를 마신다");
assert.ok(multi.some((f) => f.rule === "multiple_moments"), "multiple moments detected");
const clean = mod.lintCinematicPrompt(
  "늦은 오후 카페, 클로즈업, 역광 자연광, 얕은 심도, 16mm 필름 그레인, 탈채도된 따뜻한 색보정",
);
assert.equal(clean.length, 0, "guide-compliant prompt passes lint");

// ── 9) 레이아웃 추천(6장 기준) + 시트 배선 ───────────────────────────────────
assert.equal(mod.recommendPanelLayout({ shotCount: 8 }), "grid_3x3", "7샷 이상 → 그리드");
assert.equal(mod.recommendPanelLayout({ needsTemporalFlow: true }), "stack_4", "시간 흐름 → 4단 스택");
assert.equal(mod.recommendPanelLayout({}), "stack_4", "처음이라면 4단 스택부터");

for (const kind of ["scene_grid_3x3", "scene_stack_4", "storyboard_sequence"]) {
  assert.equal(sheets.sheetAssetKind(kind), "storyboard_sheet", `${kind} must pass through unmodified (storyboard_sheet)`);
  assert.equal(sheets.sheetAspect(kind), "16:9", `${kind} aspect`);
}

// ── 10) 파이프라인 스테이지가 가이드 3줄 요약 흐름과 일치 ─────────────────────
assert.deepEqual(
  mod.CINEMATIC_PIPELINE_STAGES.map((s) => s.label),
  ["단일 컷으로 의도 확인", "3x3 그리드로 커버리지", "개별 추출", "수정", "영상화·편집"],
  "pipeline stages must mirror ch7's 3-line summary flow",
);

// ── 11) 워크플로우 오케스트레이터: 6하원칙 장면 → 스테이지 산출물 일습 ─────────
const plan = mod.buildCinematicWorkflow({
  scene: {
    who: "30대 초반의 한국인 남자와 같은 또래의 한국인 여자",
    when: "늦은 오후, 역광으로 들어오는 황금빛 자연광",
    where: "창가 자리가 있는 조용한 서울의 카페 내부",
    how: "얕은 피사계 심도, 망원 렌즈 압축 효과, 16mm 필름 그레인",
    what: "남자가 이별을 통보하고 여자는 담담하게 듣고 있다",
    why: "고립감과 체념이 공존하는 무거운 분위기",
  },
  shotCount: 9,
});
assert.equal(plan.layout, "grid_3x3", "9샷 커버리지 → 그리드 추천");
assert.ok(plan.singleCutPrompt.includes("누가: 30대 초반의 한국인 남자"), "6하원칙 병합 프롬프트");
assert.equal(plan.lint.length, 0, "guide-compliant 6W scene passes lint");
assert.equal(plan.coverageSheet.kind, "scene_grid_3x3");
assert.ok(plan.coverageSheet.prompt.includes("[이미지 스택 구성]"), "coverage prompt uses verbatim grid template");
assert.equal(sheets.sheetAssetKind(plan.coverageSheet.kind), "storyboard_sheet", "coverage sheet flows through keyframes passthrough");
assert.deepEqual(plan.buildExtraction([2, 5]), ["2번 이미지를 추출하여 1장의 스틸 컷으로 생성.\n5번 이미지를 추출하여 1장의 스틸 컷으로 생성."]);
assert.ok(plan.buildFix([{ panel: 5, instruction: "좌우반전" }]).includes("5번 이미지 좌우반전 - 180도 법칙 위배"));

const stackPlan = mod.buildCinematicWorkflow({ scene: "골목을 걷는 남자, 이른 아침, 롱 샷, 차가운 청회색 톤, 필름 그레인", needsTemporalFlow: true });
assert.equal(stackPlan.layout, "stack_4", "시간 흐름 장면 → 4단 스택");
assert.equal(stackPlan.coverageSheet.kind, "scene_stack_4");

console.log("oberon cinematic guide contract ok (verbatim templates + workflow)");
