// Oberon 시네마틱 가이드 엔진 — "시네마틱 이미지 생성 가이드"(율파파, oasis-dentist-28a.notion.site)
// 워크플로우의 결정적 구현.
//
// 원칙: 가이드 원문이 곧 엔진이다. 아래 템플릿 문자열들은 가이드 7장(실전 예시)·6장(멀티 패널)·
// 5장(프롬프트 구조화)·4장(레퍼런스 차용)에서 **토씨 그대로** 옮겨온 정본이며, 슬롯([장면 설명] 등)만
// 입력으로 채운다. 문구를 "개선"하지 말 것 — 검증 테스트(test-oberon-cinematic-guide.cjs)가
// 원문 일치를 계약으로 강제한다. 가이드 전문 사본: docs/oberon-cinematic-guide/ch1~10.md
//
// 가이드 파이프라인 (7장):
//   단일 컷으로 의도 확인 → 3x3 그리드로 커버리지 → (실패 시 행별 샷 지정 재생성)
//   → 개별 추출(2~3장씩) → 연속성 수정(180도 법칙 등) → 영상화·편집

// ── 5장: 6하원칙 구조화 ──────────────────────────────────────────────────────

/** 6하원칙(5W1H) — 가이드 5장: "누가·언제·어디서·어떻게·무엇을·왜"로 임의 결정의 범위를 줄인다. */
export interface CinematicSceneSixW {
  /** 누가 — 피사체: 어떤 인물이 화면에 있는가 */
  who: string;
  /** 언제 — 시간대: 낮인가 밤인가, 어떤 빛인가 */
  when: string;
  /** 어디서 — 장소/배경: 어떤 공간에서 일어나는가 */
  where: string;
  /** 어떻게 — 카메라/조명: 어떤 프레이밍과 조명으로 잡는가 */
  how: string;
  /** 무엇을 — 행동/상태: 인물이 무엇을 하고 있는가 */
  what: string;
  /** 왜 — 감정/분위기: 이 컷이 전달하는 느낌은 무엇인가 */
  why: string;
}

/** 6하원칙 답변을 가이드 5장 예시 형식(항목 나열)으로 병합한 단일 컷 프롬프트. */
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

/** 가이드 5장의 JSON 구조화 형식 — "특정 항목만 수정하기 쉽습니다". */
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

// ── 7장: 3×3 그리드 — 섹션 템플릿 (토씨 그대로) ─────────────────────────────

/** 7장 [레퍼런스 규칙] 원문. 캐릭터/장면 시트를 첨부하는 그리드 생성의 절대 기준 문단. */
export const GRID_REFERENCE_RULES = `[레퍼런스 규칙] 첨부된 캐릭터시트는 인물의 얼굴, 헤어스타일, 체형, 피부톤에 대한 절대 기준이다. 9개 패널 전체에서 이 기준을 정확히 유지한다. 의상은 캐릭터시트를 기본으로 따르되, 장면 설명에서 별도로 지정한 경우 장면 설명이 우선한다.
첨부된 장면시트는 환경, 미술, 색감, 조명 톤의 기준이다. 프로덕션 디자인, 소품 배치, 시간대 설정은 장면시트에서 파생한다. 장면 설명에서 별도로 지정한 경우 장면 설명이 우선한다.`;

/** 7장 [이미지 스택 구성] 원문 — 할리우드 연출 문법 자율 적용 지침. */
export const GRID_STACK_COMPOSITION = `[이미지 스택 구성] 장면 설명을 바탕으로 다양한 구도와 카메라 앵글, 감정을 구성하는 3*3 이미지 그리드를 생성한다.
9개 패널은 장면의 서사적 맥락에 따라 할리우드 영화 연출 문법을 자율적으로 적용한다. 화각, 앵글, 구도의 순서를 고정하지 않으며, 다음의 연출 원칙 중 장면에 가장 적합한 방식을 판단하여 시퀀스를 구성한다.
서스펜스·공포 장면이라면 히치콕 방식을 고려한다. 디테일 인서트로 시작해 서서히 공간을 드러내거나, 돌리 줄으로 공간 왜곡 효과를 암시한다. 클로즈업에서 와이드로의 풀백, 또는 와이드에서 극단적 클로즈업으로의 점프를 활용한다.
대화·감정 장면이라면 숫-리버스숫, OTS, 투숫에서 싱글로의 분리 등 고전적 대화 연출 문법을 적용한다. 감정 고조에 따라 화각이 점진적으로 좁아지는 구성을 우선한다.
액션·추격 장면이라면 빠른 화각 전환, 로우앵글의 임팩트 샷, 와이드의 공간 파악 샷, 극단적 클로즈업의 반응 샷을 조합한다. 정적 구도와 동적 구도의 대비를 통해 운동감을 극대화한다.
서정·회상 장면이라면 느린 화각 변화, 롱렌즈 압축, 얕은 심도, 네거티브 스페이스를 적극 활용한다. 인물이 환경에 묻히거나 분리되는 구성으로 감정적 거리감을 시각화한다.
전환·엔딩 장면이라면 풀숫에서 익스트림 와이드로의 확장, 또는 반대로 환경에서 디테일로 수렴하는 구성을 고려한다.
위 분류에 정확히 해당하지 않는 장면이라면, 장면의 핵심 감정과 서사적 기능을 분석하여 가장 효과적인 연출 조합을 자율적으로 구성한다.
각 패널의 좌측 상단에 추출과 분리를 위한 패널 번호를 삽입한다. 흰색 텍스트에 드롭서도우, 최소한의 크기로 표시한다.`;

/** 7장 [촬영 스타일] 원문 — 포토리얼/동기화 조명/그레인/심도 규칙. */
export const GRID_SHOOTING_STYLE = `[촬영 스타일] 모든 패널은 포토리얼리스틱 텍스처로 생성한다. 시네마틱 컴러 그레이딩을 적용하되, 9개 패널 전체에서 색온도와 그레이딩 톤을 통일한다.
조명은 동기화된 조명을 원칙으로 한다. 모든 광원은 장면 내에서 출처가 설명 가능해야 한다. 렌브란트, 스플릿, 림라이트, 실용 조명, 키아로스쿠로 중 장면의 감정에 맞는 기법을 선택한다. 키라이트의 방향은 9개 패널에서 일관되게 유지한다.
필름 그레인은 장면의 무드에 맞춘다. 깨끗한 장면은 미세한 그레인, 거칠거나 어두운 장면은 강한 그레인을 적용한다. 피사계 심도는 화각에 연동한다. 넓은 화각은 깊은 심도, 좁은 화각은 얕은 심도를 적용한다.`;

/** 7장 [연속성 체크] 원문. */
export const GRID_CONTINUITY_CHECK = `[연속성 체크] 9개 패널 전체에서 다음 항목의 연속성을 반드시 유지한다: 인물 외형, 조명 방향, 배경의 공간적 논리, 의상과 소품, 부상이나 오염 같은 디테일, 색온도.`;

/** 7장 [창작 원칙] 원문. */
export const GRID_CREATIVE_PRINCIPLE = `[창작 원칙] 콘텐츠 정책이 허용하는 범위 내에서 최대한 강한 시각적 스토리텔링을 추구한다. 설명적 나열이 아니라 영화적 언어로 보여준다.`;

/** 7장 [기타 사항] 원문 — 패널 번호 기입(추출 대비). */
export const GRID_MISC = `[기타 사항] 각 패널에는 좌측 상단에 숫자 1~9까지 기입하여 차후 추출하여 생성하기 용이하도록 한다.`;

/** 7장 행별 샷 지정 원문 — "9장을 모두 살리는 방향"의 재생성에 사용. */
export const GRID_ROW_SHOT_SPEC = `1행 (배경 설정 및 맥락): 익스트림 롱 샷 (ELS): 광활한 환경 속에서 피사체가 작게 보임. 롱 샷 (LS): 피사체 또는 그룹의 전체 모습이 머리부터 발끝까지 보임. 미디엄 롱 샷 (아메리칸/3-4): 무릎 위부터 프레임 구성.
2행 (핵심 커버리지): 미디엄 샷 (MS): 허리 위부터 프레임 구성. 상호작용이나 행동에 초점. 미디엄 클로즈업 (MCU): 가슴 위부터 프레임 구성. 주요 피사체의 친밀한 프레임. 클로즈업 (CU): 얼굴(들에) 타이트하게 프레임 구성.
3행 (디테일 및 앵글): 익스트림 클로즈업 (ECU): 주요 특징(눈, 손, 소품 등)에 강렬하게 초점을 맞춘 매크로 디테일. 로우 앵글 샷 (웜 아이): 지면에서 피사체를 올려다보는 앵글. 하이 앵글 샷 (버드 아이): 위에서 피사체를 내려다보는 앵글.`;

export interface SceneGridInput {
  /** [장면 설명] — 6하원칙/구조화로 완성한 장면 프롬프트 (하나의 프롬프트에는 하나의 순간만). */
  sceneDescription: string;
  /** 캐릭터/장면 시트를 첨부하는 경우에만 [레퍼런스 규칙] 문단 포함 (기본 true — 가이드 권장 흐름). */
  withReferenceSheets?: boolean;
  /** 행별 샷 지정 — 9장을 모두 살려야 할 때 7장 원문 사양을 덧붙인다. */
  withRowShotSpec?: boolean;
}

/** 7장 실전 예시의 3×3 그리드 프롬프트 — 섹션 순서·문구 원문 그대로. */
export function buildSceneGridPrompt(input: SceneGridInput): string {
  const parts = [`[장면 설명]\n${input.sceneDescription.trim()}`];
  if (input.withReferenceSheets !== false) parts.push(GRID_REFERENCE_RULES);
  parts.push(
    input.withRowShotSpec
      ? `${GRID_STACK_COMPOSITION}\n패널별 샷 지정은 이렇게 추가합니다:\n${GRID_ROW_SHOT_SPEC}`
      : GRID_STACK_COMPOSITION,
  );
  parts.push(GRID_SHOOTING_STYLE, GRID_CONTINUITY_CHECK, GRID_CREATIVE_PRINCIPLE, GRID_MISC);
  return parts.join("\n");
}

// ── 6장: 4단 이미지 스택 ─────────────────────────────────────────────────────
// 6장 정의: "하나의 이미지 안에 4개의 패널을 세로로(또는 가로로) 쌓습니다.
// 위에서 아래로 읽으면 시간 순서대로 장면이 전개" — 시간 흐름(시작→전개→핵심→마무리) 시각화.
// 프롬프트 골격은 7장 그리드 템플릿을 정본으로 하되 패널 수·배치만 4단 스택으로 치환한다.

export function buildSceneStackPrompt(input: SceneGridInput): string {
  const nine = buildSceneGridPrompt(input);
  return nine
    .replaceAll("3*3 이미지 그리드", "4단 이미지 스택(세로로 쌓인 4개 패널, 위에서 아래로 시간 순서대로 장면이 전개)")
    .replaceAll("9개 패널", "4개 패널")
    .replaceAll("숫자 1~9까지", "숫자 1~4까지");
}

// ── 6장: 스토리보드(흑백 스케치) — 원문 템플릿 ───────────────────────────────
// "스토리보드는 스케치, 키프레임은 실사 — 스토리보드 프롬프트에는 사진 질감·색·시네마틱
// 색보정 어휘를 넣지 않습니다."

export interface StoryboardPanelInput {
  /** 샷 크기 (예: 미디엄 샷) */
  shotSize: string;
  /** 앵글 (예: 로우 앵글) */
  angle: string;
  /** 렌즈 mm (예: 35) */
  lensMm: string | number;
  /** 인물 단순 묘사 + 행동 */
  subjectAction: string;
  /** 공간 핵심 요소만 */
  spaceCore: string;
  /** 피사체 위치, 시선 방향, 전경/배경 깊이 */
  composition: string;
  /** 샷 번호 라벨 */
  shotNumber: string | number;
}

/** 6장 스토리보드 패널 프롬프트 — 원문 템플릿의 슬롯만 채운다. */
export function buildStoryboardPanelPrompt(p: StoryboardPanelInput): string {
  return `Monochrome storyboard panel, graphite pencil and charcoal sketch
style, confident rough linework.
Shot: ${p.shotSize}, ${p.angle}, ${p.lensMm}mm lens perspective.
Scene: ${p.subjectAction}, in ${p.spaceCore}.
Composition: ${p.composition}.
Light gray tonal shading for depth, white paper background visible
at edges. Small handwritten label in bottom-left corner:
"${p.shotNumber}" — the only text in the frame.
Frame proportion inside the panel: 16:9.`;
}

/** 6장 시퀀스 시트 — "one single image containing 6 monochrome sketch panels arranged in a 3x2 grid" 식 지시. */
export function buildStoryboardSequencePrompt(panels: StoryboardPanelInput[], cols = 3, rows = 2): string {
  const count = panels.length;
  const header = `One single image containing ${count} monochrome sketch panels arranged in a ${cols}x${rows} grid. Each panel is a storyboard sketch:`;
  const body = panels
    .map(
      (p) =>
        `Panel ${p.shotNumber}: ${p.shotSize}, ${p.angle}, ${p.lensMm}mm lens perspective. ${p.subjectAction}, in ${p.spaceCore}. ${p.composition}.`,
    )
    .join("\n");
  const footer = `Graphite pencil and charcoal sketch style, confident rough linework. Light gray tonal shading for depth, white paper background visible at edges. Small handwritten label in the bottom-left corner of each panel with its shot number — the only text in each frame. Frame proportion inside each panel: 16:9.`;
  return `${header}\n${body}\n${footer}`;
}

// ── 7장: 개별 추출 · 연속성 수정 ─────────────────────────────────────────────

/** 7장 추출 문구 원형: "1번 (또는 1행 1열) 이미지를 추출하여 1장의 스틸 컷으로 생성."
 *  "이 프롬프트가 한번에 되지 않을 가능성이 있습니다, 따라서 2~3장씩 한번에 생성해주시는게 좋습니다."
 *  → 패널 목록을 2~3장 배치로 나눠 프롬프트 배열을 돌려준다. */
export function buildPanelExtractionPrompts(panels: number[], batchSize: 2 | 3 = 3): string[] {
  const prompts: string[] = [];
  for (let i = 0; i < panels.length; i += batchSize) {
    const batch = panels.slice(i, i + batchSize);
    prompts.push(batch.map((n) => `${n}번 이미지를 추출하여 1장의 스틸 컷으로 생성.`).join("\n"));
  }
  return prompts;
}

export interface ContinuityFix {
  panel: number;
  /** 예: "좌우반전", "테이블 앞 여자의 의상 변경 및 좌우반전" */
  instruction: string;
  /** 위배 사유 — 기본 "180도 법칙 위배" (7장 예시 형식). */
  reason?: string;
}

/** 7장 수정 지시 형식: "3번 이미지 좌우반전 - 180도 법칙 위배" */
export function buildContinuityFixPrompt(fixes: ContinuityFix[]): string {
  return fixes
    .map((f, i) => `${i + 1}. ${f.panel}번 이미지 ${f.instruction} - ${f.reason ?? "180도 법칙 위배"}`)
    .join("\n");
}

// ── 4장: 레퍼런스 차용 — 유지/변경/삭제 + 첨부 순서 규칙 ──────────────────────

export interface ReferenceBorrowInput {
  /** 유지할 것 — "첫 번째 이미지의 구도, 조명, 카메라 앵글, 배경을 그대로 유지한다." 식 문장들 */
  keep: string[];
  /** 변경할 것 */
  change: string[];
  /** 삭제할 것 (없으면 생략) */
  remove?: string[];
}

/** 4장의 차용 프롬프트 골격 — 유지/변경(/삭제)을 명확히 구분해 지시한다. */
export function buildReferenceBorrowPrompt(input: ReferenceBorrowInput): string {
  const parts: string[] = [...input.keep];
  if (input.remove?.length) parts.push(...input.remove);
  parts.push(...input.change);
  return parts.join("\n");
}

/** 4장 색상톤 차용 원문: 변경할 이미지가 '첫번째', 참조할 이미지가 '두번째'로 첨부됐을 때. */
export const COLOR_TONE_BORROW_PROMPT = `첫번째 이미지의 모든 것을 유지한 채로 두번째 이미지의 색상톤을 적용한다.`;
export const COLOR_PALETTE_BORROW_PROMPT = `첫번째 이미지의 모든 요소를 유지한 채, 색상 톤만 두번째 이미지의 색상팔레트를 참조하여 변경한다.`;
/** 4장 첨부 순서 규칙 — 프롬프트와 첨부 순서가 일치해야 한다. */
export const REFERENCE_ATTACH_ORDER_RULE = `변경할 이미지를 ‘첫번째’로 첨부하고 참조할 이미지를 ‘두번째’로 참조해야 합니다. 만약 이 순서가 바뀌었다면 프롬프트도 그에 맞추어 작성해야 합니다.`;

// ── 5장: 자주 하는 실수 — 린트 규칙 ─────────────────────────────────────────

/** 실수 3 원문: "이런 키워드 나열은 Nano Banana 2에서 거의 효과가 없습니다." —
 *  "cinematic, photorealistic, film grain 정도면 충분합니다." */
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

/** 가이드 5장 "자주 하는 실수" 감지 — 차단이 아니라 경고(가이드는 교육 문서다). */
export function lintCinematicPrompt(prompt: string): CinematicPromptFinding[] {
  const findings: CinematicPromptFinding[] = [];
  const hits = QUALITY_KEYWORD_BLACKLIST.filter((kw) => prompt.toLowerCase().includes(kw.toLowerCase()));
  if (hits.length >= 2) {
    findings.push({
      rule: "quality_keyword_spam",
      message: `추상적 품질 키워드 나열(${hits.join(", ")})은 거의 효과가 없습니다 — 구체적인 시각 정보(샷 사이즈, 조명 방향, 렌즈 느낌)가 훨씬 효과적입니다. "cinematic, photorealistic, film grain" 정도면 충분합니다.`,
    });
  }
  // 실수 1: 감정만 쓰고 시각 정보(조명/프레이밍/렌즈 계열 어휘)가 전혀 없는 짧은 프롬프트
  const visualVocab =
    /(light|lighting|조명|shot|샷|close-up|클로즈업|와이드|wide|angle|앵글|lens|렌즈|depth of field|심도|grain|그레인|palette|색감|톤|tone|framing|프레이밍|백라이트|역광)/i;
  if (prompt.trim().length > 0 && prompt.trim().length < 80 && !visualVocab.test(prompt)) {
    findings.push({
      rule: "emotion_without_visuals",
      message:
        "감정은 조명, 색감, 프레이밍으로 번역해야 합니다. 예: \"슬프다\"는 \"low-key lighting, desaturated cool tones, character small in frame, wide shot\"이 됩니다.",
    });
  }
  // 실수 2: 하나의 프롬프트에 여러 순간(…하다가, …한 뒤, 그리고 나서)
  if (/(하다가|한 뒤에?|그리고 나서|다음에|이후에)\s/.test(prompt) && /(나가|일어나|떠나|돌아)/.test(prompt)) {
    findings.push({
      rule: "multiple_moments",
      message: "하나의 이미지로 표현할 수 없습니다. 이것은 여러 개의 샷입니다. 하나의 프롬프트에는 하나의 순간만 담습니다.",
    });
  }
  return findings;
}

// ── 파이프라인 메타 — 가이드 7장 흐름의 결정적 표현 ─────────────────────────

export const CINEMATIC_PIPELINE_STAGES = [
  { id: "single_cut", label: "단일 컷으로 의도 확인" },
  { id: "grid_coverage", label: "3x3 그리드로 커버리지" },
  { id: "panel_extract", label: "개별 추출" },
  { id: "continuity_fix", label: "수정" },
  { id: "animate_edit", label: "영상화·편집" },
] as const;

/** 6장 선택 기준: 샷 수 많음/커버리지 탐색 → 그리드, 시간 흐름/디테일/짧은 장면 → 4단 스택. */
export function recommendPanelLayout(input: { shotCount?: number; needsTemporalFlow?: boolean; detailCritical?: boolean }):
  | "grid_3x3"
  | "stack_4" {
  if (input.needsTemporalFlow || input.detailCritical) return "stack_4";
  if ((input.shotCount ?? 0) >= 7) return "grid_3x3";
  return "stack_4"; // "처음이라면 4단 스택부터 시작하는 것을 추천합니다."
}

// ── 워크플로우 오케스트레이터 — 7장 흐름 전체를 하나의 호출 단위로 ────────────

export interface CinematicWorkflowInput {
  /** 6하원칙 답변 또는 이미 완성된 장면 설명 문자열. */
  scene: CinematicSceneSixW | string;
  /** 생략 시 recommendPanelLayout이 결정. */
  layout?: "grid_3x3" | "stack_4";
  shotCount?: number;
  needsTemporalFlow?: boolean;
  detailCritical?: boolean;
  withReferenceSheets?: boolean;
  withRowShotSpec?: boolean;
}

export interface CinematicWorkflowPlan {
  stages: typeof CINEMATIC_PIPELINE_STAGES;
  /** 1단계: 단일 컷으로 의도 확인 — 이 프롬프트로 1장 생성해 목적 부합 확인. */
  singleCutPrompt: string;
  /** 가이드 5장 실수 감지 — 경고가 있으면 프롬프트를 먼저 손보라는 신호. */
  lint: CinematicPromptFinding[];
  /** 2단계 레이아웃 결정 + 커버리지 프롬프트 (startSheets에 그대로 넣을 수 있는 item). */
  layout: "grid_3x3" | "stack_4";
  coverageSheet: { id: string; kind: "scene_grid_3x3" | "scene_stack_4"; prompt: string; aspectRatio: string };
  /** 3단계: 선택한 패널들을 2~3장씩 추출하는 프롬프트 배치. */
  buildExtraction: (panels: number[]) => string[];
  /** 4단계: 180도 법칙 위반 등 수정 지시. */
  buildFix: (fixes: ContinuityFix[]) => string;
}

/** 7장 파이프라인을 스테이지 산출물로 조립한다. 생성 실행은 기존 keyframes/sheets 인프라 몫. */
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
