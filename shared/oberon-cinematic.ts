// Oberon Cinematic Workflow — Oberon 자체의 컷 커버리지 엔진.
//
// 표준 영화 촬영 문법(샷 사이즈, 카메라 앵글, 동기화 조명, 180도 법칙, 커버리지 그리드)을
// 결정적 프롬프트 스캐폴드로 옮긴 모듈이다. 아래 템플릿은 전부 Oberon의 원본 서술이며,
// 산업 표준 촬영 개념을 자체 표현으로 정리한 것이다.
//
// 파이프라인:
//   단일 컷으로 의도 확인 → 커버리지 그리드/스택 생성 → (필요 시 행별 샷 지정 재생성)
//   → 개별 컷 추출 → 연속성(180도 법칙) 수정 → 영상화·편집

// ── 6하원칙 장면 구조화 ──────────────────────────────────────────────────────
// 프롬프트에 남는 AI의 임의 해석 범위를 줄이려면 장면을 여섯 축으로 분해한다.

export interface CinematicSceneSixW {
  /** 누가 — 피사체: 화면에 있는 인물 */
  who: string;
  /** 언제 — 시간대와 광질 */
  when: string;
  /** 어디서 — 장소/배경 */
  where: string;
  /** 어떻게 — 카메라와 조명(프레이밍·앵글·광원) */
  how: string;
  /** 무엇을 — 행동/상태 */
  what: string;
  /** 왜 — 감정/분위기 */
  why: string;
}

/** 6하원칙 답변을 한 컷 프롬프트로 병합한다. */
export function buildSixWScenePrompt(scene: CinematicSceneSixW): string {
  return [
    `누가: ${scene.who}`,
    `어디서: ${scene.where}`,
    `무엇을: ${scene.what}`,
    `어떻게: ${scene.how}`,
    `언제: ${scene.when}`,
    `왜: ${scene.why}`,
  ].join("\n");
}

/** 항목별 수정이 쉬운 JSON 구조 프롬프트. */
export function buildSixWJsonPrompt(scene: {
  who: string;
  where: string;
  what: string;
  camera: string;
  lighting: string;
  when: string;
  mood: string;
}): string {
  return JSON.stringify(
    {
      who: scene.who,
      where: scene.where,
      what: scene.what,
      camera: scene.camera,
      lighting: scene.lighting,
      when: scene.when,
      mood: scene.mood,
    },
    null,
    2,
  );
}

// ── 커버리지 그리드 — 섹션 스캐폴드 ──────────────────────────────────────────
// 그리드/스택 프롬프트를 구성하는 지시 블록. 패널 수(N)를 파라미터로 받아
// 3x3(9) / 4단 스택(4) 어디에도 재사용한다.

/** 캐릭터/장면 시트를 첨부할 때의 참조 규율 블록. */
export function referenceDisciplineBlock(): string {
  return [
    "[참조 규율] 첨부된 캐릭터 시트는 얼굴, 헤어, 체형, 피부톤의 고정 기준이다. 모든 패널에서 이 정체성을 흔들림 없이 유지한다.",
    "의상은 캐릭터 시트를 따르되, 장면 설명이 별도로 지정하면 장면 설명을 우선한다.",
    "첨부된 장면 시트는 공간, 미술, 색감, 조명 톤의 기준이며 프로덕션 디자인·소품·시간대는 여기서 파생한다. 장면 설명이 우선한다.",
  ].join("\n");
}

/** N개 패널로 커버리지를 짜는 구성 지시. 장면 유형별 표준 샷 문법을 자율 적용하게 둔다. */
export function coverageCompositionBlock(panelCount: number): string {
  return [
    `[커버리지 구성] 장면 설명을 바탕으로 서로 다른 샷 사이즈·카메라 앵글·감정을 담은 ${panelCount}개 패널을 한 이미지에 배치한다.`,
    "패널 순서를 기계적으로 고정하지 않고, 장면의 서사 기능에 맞는 표준 연출 조합을 선택한다:",
    "· 긴장·서스펜스: 인서트에서 공간을 서서히 드러내거나, 클로즈업↔와이드의 급전환으로 불안을 만든다.",
    "· 대화·감정: 오버더숄더, 리버스 앵글, 투샷에서 싱글로의 분리 등 대화 커버리지를 쓰고, 감정이 고조될수록 화각을 좁힌다.",
    "· 액션·추격: 빠른 화각 전환, 로우 앵글 임팩트 샷, 와이드 공간 파악 샷, 극단적 클로즈업 반응 샷을 섞어 운동감을 만든다.",
    "· 서정·회상: 느린 화각 변화, 롱렌즈 압축, 얕은 심도, 네거티브 스페이스로 감정적 거리를 시각화한다.",
    "· 전환·엔딩: 풀샷에서 익스트림 와이드로 확장하거나, 반대로 환경에서 디테일로 수렴한다.",
    "위 유형에 딱 들어맞지 않으면 장면의 핵심 감정과 기능을 판단해 가장 효과적인 조합을 구성한다.",
    "추출을 위해 각 패널 좌측 상단에 패널 번호를 삽입한다. 흰색 텍스트에 옅은 그림자, 최소 크기로 표시한다.",
  ].join("\n");
}

/** 포토리얼 촬영 스타일 — 통일된 그레이딩, 동기화 조명, 그레인, 심도. */
export function photographicStyleBlock(panelCount: number): string {
  return [
    "[촬영 스타일] 모든 패널은 포토리얼리스틱 텍스처로 생성한다. 시네마틱 컬러 그레이딩을 적용하되 " +
      `${panelCount}개 패널 전체에서 색온도와 그레이딩 톤을 통일한다.`,
    "조명은 동기화 원칙을 따른다. 모든 광원은 장면 안에서 출처가 설명 가능해야 한다. 렘브란트, 스플릿, 림 라이트, 실용광, 키아로스쿠로 중 감정에 맞는 기법을 고르고, 키 라이트 방향은 전 패널에서 일관되게 유지한다.",
    "필름 그레인은 무드에 맞춘다. 밝고 깨끗한 장면은 미세 그레인, 거칠고 어두운 장면은 강한 그레인. 피사계 심도는 화각에 연동한다. 넓은 화각은 깊은 심도, 좁은 화각은 얕은 심도.",
  ].join("\n");
}

/** 연속성 체크리스트. */
export function continuityChecklistBlock(panelCount: number): string {
  return (
    `[연속성 체크] ${panelCount}개 패널 전체에서 다음을 일관되게 유지한다: ` +
    "인물 외형, 조명 방향, 배경의 공간 논리, 의상과 소품, 부상·오염 같은 디테일, 색온도."
  );
}

/** 창작 원칙 — 나열이 아닌 영화적 언어. */
export const CREATIVE_PRINCIPLE_BLOCK =
  "[창작 원칙] 정책이 허용하는 범위에서 강한 시각적 스토리텔링을 추구한다. 설명적 나열이 아니라 영화적 언어로 보여준다.";

/** 추출 대비 패널 번호 기입. */
export function panelNumberingBlock(panelCount: number): string {
  return `[패널 번호] 각 패널 좌측 상단에 1부터 ${panelCount}까지 번호를 기입해 이후 개별 추출을 쉽게 한다.`;
}

/** 9장을 모두 살려야 할 때의 행별 샷 지정 — 표준 샷 사이즈/앵글 3열 구성. */
export const ROW_SHOT_SPEC = [
  "1행 (설정·맥락): 익스트림 롱 샷(ELS, 환경 속 작은 피사체) · 롱 샷(LS, 머리부터 발끝까지 전신) · 미디엄 롱 샷(무릎 위 프레임).",
  "2행 (핵심 커버리지): 미디엄 샷(MS, 허리 위 — 행동·상호작용) · 미디엄 클로즈업(MCU, 가슴 위) · 클로즈업(CU, 얼굴 타이트).",
  "3행 (디테일·앵글): 익스트림 클로즈업(ECU, 눈·손·소품 매크로) · 로우 앵글(피사체를 올려다봄) · 하이 앵글(피사체를 내려다봄).",
].join("\n");

export interface SceneGridInput {
  /** [장면 설명] — 하나의 순간만 담은 장면 프롬프트. */
  sceneDescription: string;
  /** 캐릭터/장면 시트를 첨부할 때만 참조 규율 블록 포함(기본 true). */
  withReferenceSheets?: boolean;
  /** 9장을 모두 살릴 때 행별 샷 지정 추가. */
  withRowShotSpec?: boolean;
  /** 패널 수 — 3x3=9, 4단 스택=4. */
  panelCount?: number;
}

/** 커버리지 그리드/스택 프롬프트를 조립한다. */
export function buildCoveragePrompt(input: SceneGridInput): string {
  const n = input.panelCount ?? 9;
  const parts = [`[장면 설명]\n${input.sceneDescription.trim()}`];
  if (input.withReferenceSheets !== false) parts.push(referenceDisciplineBlock());
  parts.push(
    input.withRowShotSpec
      ? `${coverageCompositionBlock(n)}\n패널별 샷 지정:\n${ROW_SHOT_SPEC}`
      : coverageCompositionBlock(n),
  );
  parts.push(
    photographicStyleBlock(n),
    continuityChecklistBlock(n),
    CREATIVE_PRINCIPLE_BLOCK,
    panelNumberingBlock(n),
  );
  return parts.join("\n");
}

/** 3x3(9패널) 커버리지 그리드. */
export function buildSceneGridPrompt(input: SceneGridInput): string {
  return buildCoveragePrompt({ ...input, panelCount: 9 });
}

/** 4단 스택 — 세로로 쌓인 4패널, 위→아래로 시간 순서 전개(시작→전개→핵심→마무리). */
export function buildSceneStackPrompt(input: SceneGridInput): string {
  const base = buildCoveragePrompt({ ...input, panelCount: 4 });
  return base.replace(
    "[커버리지 구성]",
    "[커버리지 구성 · 4단 스택] 세로로 쌓인 4개 패널을 위에서 아래로 시간 순서대로 전개한다(시작 → 전개 → 핵심 → 마무리).",
  );
}

// ── 스토리보드(흑백 스케치) — 실사 전 구도 검증 ─────────────────────────────
// 스케치는 색·질감을 빼고 구도만 싸게 검증한다. 사진 어휘를 넣지 않는다.

export interface StoryboardPanelInput {
  shotSize: string;
  angle: string;
  lensMm: string | number;
  subjectAction: string;
  spaceCore: string;
  composition: string;
  shotNumber: string | number;
}

export function buildStoryboardPanelPrompt(p: StoryboardPanelInput): string {
  return [
    "Monochrome storyboard panel, graphite pencil and charcoal sketch, confident rough linework.",
    `Shot: ${p.shotSize}, ${p.angle}, ${p.lensMm}mm lens perspective.`,
    `Scene: ${p.subjectAction}, in ${p.spaceCore}.`,
    `Composition: ${p.composition}.`,
    "Light gray tonal shading for depth; white paper visible at the edges.",
    `Handwritten label in the bottom-left corner: "${p.shotNumber}" — the only text in the frame.`,
    "Frame proportion inside the panel: 16:9.",
  ].join("\n");
}

export function buildStoryboardSequencePrompt(panels: StoryboardPanelInput[], cols = 3, rows = 2): string {
  const count = panels.length;
  const header = `A single image with ${count} monochrome storyboard sketch panels in a ${cols}x${rows} grid:`;
  const body = panels
    .map(
      (p) =>
        `Panel ${p.shotNumber}: ${p.shotSize}, ${p.angle}, ${p.lensMm}mm. ${p.subjectAction}, in ${p.spaceCore}. ${p.composition}.`,
    )
    .join("\n");
  const footer =
    "Graphite pencil and charcoal sketch style, confident rough linework, light gray tonal shading, white paper at the edges. A small handwritten shot number in each panel's bottom-left corner is the only text. Each panel's frame proportion: 16:9.";
  return `${header}\n${body}\n${footer}`;
}

// ── 개별 추출 · 연속성 수정 ─────────────────────────────────────────────────

/** 선택 패널을 2~3장씩 배치로 나눠 추출 프롬프트를 만든다(한 번에 전부는 실패하기 쉽다). */
export function buildPanelExtractionPrompts(panels: number[], batchSize: 2 | 3 = 3): string[] {
  const prompts: string[] = [];
  for (let i = 0; i < panels.length; i += batchSize) {
    const batch = panels.slice(i, i + batchSize);
    prompts.push(batch.map((n) => `${n}번 패널을 추출해 단독 스틸 컷으로 생성.`).join("\n"));
  }
  return prompts;
}

export interface ContinuityFix {
  panel: number;
  /** 예: "좌우 반전", "테이블 앞 인물 의상 변경 + 좌우 반전" */
  instruction: string;
  /** 사유 — 기본 "180도 법칙 위반". */
  reason?: string;
}

export function buildContinuityFixPrompt(fixes: ContinuityFix[]): string {
  return fixes
    .map((f, i) => `${i + 1}. ${f.panel}번 패널 ${f.instruction} — ${f.reason ?? "180도 법칙 위반"}`)
    .join("\n");
}

// ── 레퍼런스 차용 — 유지/변경/삭제 + 첨부 순서 ──────────────────────────────

export interface ReferenceBorrowInput {
  keep: string[];
  change: string[];
  remove?: string[];
}

export function buildReferenceBorrowPrompt(input: ReferenceBorrowInput): string {
  const parts: string[] = [...input.keep];
  if (input.remove?.length) parts.push(...input.remove);
  parts.push(...input.change);
  return parts.join("\n");
}

/** 색상 톤만 차용: 변경 대상이 첫 번째, 참조가 두 번째로 첨부됐을 때. */
export const COLOR_TONE_BORROW_PROMPT = "첫 번째 이미지의 모든 요소를 유지한 채 두 번째 이미지의 색상 톤을 적용한다.";
export const COLOR_PALETTE_BORROW_PROMPT = "첫 번째 이미지를 유지하고 색상 톤만 두 번째 이미지의 팔레트를 참조해 변경한다.";
export const REFERENCE_ATTACH_ORDER_RULE = "변경할 이미지를 첫 번째로, 참조할 이미지를 두 번째로 첨부한다. 순서가 바뀌면 프롬프트도 그에 맞춰 조정한다.";

// ── 프롬프트 린트 — 흔한 실수 감지(차단 아닌 경고) ──────────────────────────

export const QUALITY_KEYWORD_BLACKLIST = [
  "8K",
  "ultra HD",
  "masterpiece",
  "best quality",
  "extremely detailed",
  "professional photography",
  "award winning",
] as const;

export interface CinematicPromptFinding {
  rule: "quality_keyword_spam" | "emotion_without_visuals" | "multiple_moments";
  message: string;
}

export function lintCinematicPrompt(prompt: string): CinematicPromptFinding[] {
  const findings: CinematicPromptFinding[] = [];
  const hits = QUALITY_KEYWORD_BLACKLIST.filter((kw) => prompt.toLowerCase().includes(kw.toLowerCase()));
  if (hits.length >= 2) {
    findings.push({
      rule: "quality_keyword_spam",
      message: `추상적 품질 키워드 나열(${hits.join(", ")})은 효과가 약하다. 구체적 시각 정보(샷 사이즈, 조명 방향, 렌즈 느낌)가 훨씬 낫다.`,
    });
  }
  const visualVocab =
    /(light|lighting|조명|shot|샷|close-up|클로즈업|와이드|wide|angle|앵글|lens|렌즈|depth of field|심도|grain|그레인|palette|색감|톤|tone|framing|프레이밍|백라이트|역광)/i;
  if (prompt.trim().length > 0 && prompt.trim().length < 80 && !visualVocab.test(prompt)) {
    findings.push({
      rule: "emotion_without_visuals",
      message: "감정은 조명·색감·프레이밍으로 번역해야 한다. 예: '슬픔' → low-key lighting, desaturated cool tones, subject small in frame, wide shot.",
    });
  }
  if (/(하다가|한 뒤에?|그리고 나서|다음에|이후에)\s/.test(prompt) && /(나가|일어나|떠나|돌아)/.test(prompt)) {
    findings.push({
      rule: "multiple_moments",
      message: "여러 순간이 한 프롬프트에 섞여 있다. 하나의 이미지에는 하나의 순간만 담는다 — 나머지는 별도 샷으로 나눈다.",
    });
  }
  return findings;
}

// ── 파이프라인 메타 ──────────────────────────────────────────────────────────

export const CINEMATIC_PIPELINE_STAGES = [
  { id: "single_cut", label: "단일 컷으로 의도 확인" },
  { id: "grid_coverage", label: "커버리지 그리드" },
  { id: "panel_extract", label: "개별 추출" },
  { id: "continuity_fix", label: "연속성 수정" },
  { id: "animate_edit", label: "영상화·편집" },
] as const;

/** 커버리지가 넓게 필요하면 그리드, 시간 흐름·디테일 중심이면 스택. */
export function recommendPanelLayout(input: { shotCount?: number; needsTemporalFlow?: boolean; detailCritical?: boolean }):
  | "grid_3x3"
  | "stack_4" {
  if (input.needsTemporalFlow || input.detailCritical) return "stack_4";
  if ((input.shotCount ?? 0) >= 7) return "grid_3x3";
  return "stack_4";
}

// ── 워크플로우 오케스트레이터 ────────────────────────────────────────────────

export interface CinematicWorkflowInput {
  scene: CinematicSceneSixW | string;
  layout?: "grid_3x3" | "stack_4";
  shotCount?: number;
  needsTemporalFlow?: boolean;
  detailCritical?: boolean;
  withReferenceSheets?: boolean;
  withRowShotSpec?: boolean;
}

export interface CinematicWorkflowPlan {
  stages: typeof CINEMATIC_PIPELINE_STAGES;
  singleCutPrompt: string;
  lint: CinematicPromptFinding[];
  layout: "grid_3x3" | "stack_4";
  coverageSheet: { id: string; kind: "scene_grid_3x3" | "scene_stack_4"; prompt: string; aspectRatio: string };
  buildExtraction: (panels: number[]) => string[];
  buildFix: (fixes: ContinuityFix[]) => string;
}

export function buildCinematicWorkflow(input: CinematicWorkflowInput): CinematicWorkflowPlan {
  const sceneDescription = typeof input.scene === "string" ? input.scene : buildSixWScenePrompt(input.scene);
  const layout =
    input.layout ??
    recommendPanelLayout({
      shotCount: input.shotCount,
      needsTemporalFlow: input.needsTemporalFlow,
      detailCritical: input.detailCritical,
    });
  const coverageInput: SceneGridInput = {
    sceneDescription,
    withReferenceSheets: input.withReferenceSheets,
    withRowShotSpec: input.withRowShotSpec,
  };
  return {
    stages: CINEMATIC_PIPELINE_STAGES,
    singleCutPrompt: sceneDescription,
    lint: lintCinematicPrompt(sceneDescription),
    layout,
    coverageSheet: {
      id: layout === "grid_3x3" ? "scene_grid_3x3" : "scene_stack_4",
      kind: layout === "grid_3x3" ? "scene_grid_3x3" : "scene_stack_4",
      prompt: layout === "grid_3x3" ? buildSceneGridPrompt(coverageInput) : buildSceneStackPrompt(coverageInput),
      aspectRatio: "16:9",
    },
    buildExtraction: (panels) => buildPanelExtractionPrompts(panels),
    buildFix: (fixes) => buildContinuityFixPrompt(fixes),
  };
}
