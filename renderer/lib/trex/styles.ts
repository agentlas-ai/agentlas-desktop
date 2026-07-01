// T-rex Style DNA — 디자인 거장/유파의 시각 언어를 규칙 집합으로 인코딩한다.
// AI가 "고흐 화풍"을 재현하는 원리(스타일=명시적 규칙)를 슬라이드에 적용:
// 각 DNA는 타이포그래피(서체 짝·자간·굵기), 팔레트, 커버 구도, 장식 모티프를 정의하고
// 렌더러(DeckStage)와 빌더(model.ts)가 이를 소비한다. styleId 없는 기존 덱은 그대로
// 레거시 룩으로 렌더된다(하위호환).
//
// 서체 전략: macOS 시스템 서체(Didot·Futura·Avenir·Helvetica Neue)를 CSS 스택으로 쓴다 —
// 번들 없이 거장 타이포를 재현하고, 없는 플랫폼은 Pretendard로 우아하게 강등된다.
// 한글은 스택 뒤의 한글 폰트가 받는다(라틴 디스플레이 + 한글 본문 혼합 조판은 실제
// 매거진/포스터의 표준 관행).

import type { SlideBg } from "./model";

export type StyleId = "swiss" | "bauhaus" | "didot" | "vignelli" | "brutal" | "hara";

/** 장식 모티프 레이어 — DeckStage의 Deco 컴포넌트가 그린다(블록 뒤, 비인터랙티브). */
export type DecoKind =
  | "none"
  | "swiss-index" // 거대 페이지 번호 + 베이스라인 그리드(뮐러-브로크만)
  | "bauhaus-geo" // 원색 기하 도형(원·삼각·바)
  | "didot-frame" // 이중 헤어라인 프레임 + 다이아 오너먼트(패션 매거진)
  | "vignelli-band" // 두꺼운 수평 밴드(NYC 지하철 사이니지)
  | "brutal-frame" // 두꺼운 원시 보더 + 모서리 마크
  | "hara-void"; // 거의 아무것도 없음 — 점 하나와 헤어라인(여백의 디자인)

/** 커버 구도 변형 — 같은 콘텐츠를 유파의 전형 구도로 배치한다. */
export type CoverComp = "classic" | "poster" | "centered" | "banner";

export interface StyleDna {
  id: StyleId;
  nameKo: string;
  nameEn: string;
  /** UI 툴팁용 철학 한 줄. */
  hintKo: string;
  hintEn: string;
  /** 제목·KPI·거대 숫자용 디스플레이 서체 스택. */
  displayFont: string;
  /** 본문·카드·부제용 서체 스택. */
  bodyFont: string;
  /** 킥커/푸터/번호용 보조 서체(주로 모노). 없으면 bodyFont. */
  monoFont?: string;
  titleWeight: number;
  titleTracking: string;
  titleTransform: "uppercase" | "none";
  titleLineHeight: number;
  kickerTracking: string;
  /** 카드 모서리(cqw). 0 = 직각(스위스/브루탈). */
  radius: number;
  /** 카드 보더 두께 배율(1 = 기존). */
  borderScale: number;
  /** 카드에 하드 오프셋 섀도(브루탈리즘). */
  hardShadow?: boolean;
  accent: string;
  /** 보조 액센트(바우하우스 노랑 등). 없으면 accent. */
  accent2?: string;
  ink: string;
  /** 커버/클로징 잉크 오버라이드(색 필드 커버 등). */
  coverInk?: string;
  closeInk?: string;
  coverBg: SlideBg;
  bodyBg: SlideBg;
  closeBg: SlideBg;
  coverDeco: DecoKind;
  bodyDeco: DecoKind;
  closeDeco: DecoKind;
  coverComp: CoverComp;
  /** 유파 사진 아트디렉션 — 이미지 생성 프롬프트에 접미되는 룩 규정(고흐 화풍의 사진 버전). */
  photoStyle: string;
  /**
   * 타이포그래피 스케일 비율(typescale.com의 modular scale) — 폰트 크기를 감이 아니라
   * base × ratio^n 의 수학적 비례로 만든다. 1.333=perfect fourth, 1.414=augmented fourth,
   * 1.5=perfect fifth. 유파의 성격(조용함↔드라마)에 맞는 비율을 쓴다.
   */
  typeRatio: number;
}

/** modular scale의 이름 붙은 단계(cqw) — 모든 빌더가 이 단계만 쓴다(매직넘버 금지). */
export interface TypeScaleSteps {
  /** 킥커·푸터·캡션 — s(-1) */
  caption: number;
  /** 본문·부제·인사이트 — base s(0) */
  body: number;
  /** 카드 라벨·강조 본문 — s(1) */
  label: number;
  /** 아젠다 행 제목·서브섹션 — s(2) */
  h2: number;
  /** 섹션(본문 슬라이드) 제목 — s(4), 슬라이드 실용 범위로 클램프 */
  h1: number;
  /** 커버·스테이트먼트 제목 — s(5) 클램프 */
  display: number;
  /** KPI 히어로·포스터 커버 — s(5)×1.2 클램프 */
  jumbo: number;
}

const TYPE_BASE = 1.4; // cqw — 본문 기준 크기(16:9에서 ≈ 26px @1920)

/** dna.typeRatio → 이름 붙은 스케일 단계. 상한/하한은 16:9 슬라이드의 실용 범위. */
export function typeScale(dna: StyleDna): TypeScaleSteps {
  const r = dna.typeRatio;
  const s = (n: number) => TYPE_BASE * Math.pow(r, n);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    caption: Math.max(0.95, s(-1)),
    body: TYPE_BASE,
    label: s(1),
    h2: s(2),
    h1: clamp(s(4), 3.8, 5.6),
    display: clamp(s(5), 5.6, 8.6),
    jumbo: clamp(s(5) * 1.2, 6.8, 10.5),
  };
}

const HELVETICA = '"Helvetica Neue", Helvetica, Arial, Pretendard, "Apple SD Gothic Neo", sans-serif';
const FUTURA = 'Futura, "Avenir Next", "Century Gothic", Pretendard, "Apple SD Gothic Neo", sans-serif';
const AVENIR = '"Avenir Next", Avenir, Pretendard, "Apple SD Gothic Neo", sans-serif';
const DIDOT = 'Didot, "Bodoni 72", "Playfair Display", Georgia, "AppleMyungjo", "Nanum Myeongjo", serif';
const GEORGIA = 'Georgia, "Iowan Old Style", "AppleMyungjo", "Nanum Myeongjo", serif';
const MONO = '"SF Mono", Menlo, "IBM Plex Mono", monospace';

export const STYLES: Record<StyleId, StyleDna> = {
  // 요제프 뮐러-브로크만 — 수학적 그리드, 좌측 정렬 거대 활자, 빨강/검정/백지.
  swiss: {
    id: "swiss",
    nameKo: "스위스",
    nameEn: "Swiss",
    hintKo: "뮐러-브로크만 — 그리드, Helvetica, 거대 활자",
    hintEn: "Müller-Brockmann — grid, Helvetica, monumental type",
    displayFont: HELVETICA,
    bodyFont: HELVETICA,
    monoFont: MONO,
    titleWeight: 800,
    titleTracking: "-.035em",
    titleTransform: "none",
    titleLineHeight: 1.02,
    kickerTracking: ".32em",
    radius: 0,
    borderScale: 1,
    accent: "#DE3F2B",
    ink: "#16130F",
    coverInk: "#FFFFFF",
    closeInk: "#FFFFFF",
    coverBg: { kind: "solid", color: "#DE3F2B" },
    bodyBg: { kind: "solid", color: "#F5F3EE" },
    closeBg: { kind: "solid", color: "#141210" },
    coverDeco: "swiss-index",
    bodyDeco: "swiss-index",
    closeDeco: "none",
    coverComp: "poster",
    photoStyle:
      "Bold minimalist studio photography in the Swiss International Style: a single strong subject, off-white seamless background, vermilion-red and black accents, hard geometric shadows, high contrast, poster-like composition",
    typeRatio: 1.414,
  },
  // 바우하우스 — 원색 기하 도형, Futura, 대각의 에너지.
  bauhaus: {
    id: "bauhaus",
    nameKo: "바우하우스",
    nameEn: "Bauhaus",
    hintKo: "원색 기하 도형과 Futura — 형태는 기능을 따른다",
    hintEn: "Primary-color geometry and Futura — form follows function",
    displayFont: FUTURA,
    bodyFont: AVENIR,
    monoFont: MONO,
    titleWeight: 700,
    titleTracking: "-.01em",
    titleTransform: "none",
    titleLineHeight: 1.08,
    kickerTracking: ".4em",
    radius: 0.4,
    borderScale: 1,
    accent: "#D53A2F",
    accent2: "#E9B32A",
    ink: "#1E1A16",
    closeInk: "#F5EFE3",
    coverBg: { kind: "solid", color: "#F2E9DC" },
    bodyBg: { kind: "solid", color: "#F5EFE3" },
    closeBg: { kind: "solid", color: "#27447C" },
    coverDeco: "bauhaus-geo",
    bodyDeco: "bauhaus-geo",
    closeDeco: "bauhaus-geo",
    coverComp: "poster",
    photoStyle:
      "Bauhaus-inspired abstract composition photograph: primary colors (red, yellow, blue), geometric wooden shapes, matte paper texture, warm cream background, museum catalog lighting",
    typeRatio: 1.333,
  },
  // 패션 에디토리얼 — Didot, 아이보리, 헤어라인, 중앙 정렬의 품격.
  didot: {
    id: "didot",
    nameKo: "에디토리얼 세리프",
    nameEn: "Didot Editorial",
    hintKo: "보그의 문법 — Didot 세리프, 아이보리, 헤어라인",
    hintEn: "The Vogue grammar — Didot serif, ivory, hairlines",
    displayFont: DIDOT,
    bodyFont: GEORGIA,
    monoFont: MONO,
    titleWeight: 500,
    titleTracking: ".01em",
    titleTransform: "none",
    titleLineHeight: 1.14,
    kickerTracking: ".5em",
    radius: 0,
    borderScale: 0.8,
    accent: "#8E1F2C",
    ink: "#171412",
    closeInk: "#F4EFE6",
    coverBg: { kind: "solid", color: "#FAF7F0" },
    bodyBg: { kind: "solid", color: "#FAF7F0" },
    closeBg: { kind: "solid", color: "#151210" },
    coverDeco: "didot-frame",
    bodyDeco: "didot-frame",
    closeDeco: "didot-frame",
    coverComp: "centered",
    photoStyle:
      "Black-and-white high-fashion editorial photography, Vogue magazine style: dramatic chiaroscuro lighting, elegant composition, film grain, timeless and luxurious mood",
    typeRatio: 1.5,
  },
  // 마시모 비녤리 — 두꺼운 밴드, Helvetica 볼드, 무자비한 정보 위계.
  vignelli: {
    id: "vignelli",
    nameKo: "비녤리 모던",
    nameEn: "Vignelli Modern",
    hintKo: "NYC 지하철의 문법 — 밴드, 볼드, 위계",
    hintEn: "The NYC subway grammar — bands, bold, hierarchy",
    displayFont: HELVETICA,
    bodyFont: HELVETICA,
    monoFont: MONO,
    titleWeight: 800,
    titleTracking: "-.03em",
    titleTransform: "none",
    titleLineHeight: 1.05,
    kickerTracking: ".18em",
    radius: 0,
    borderScale: 1.2,
    accent: "#D62828",
    ink: "#101010",
    coverInk: "#101010",
    closeInk: "#FFFFFF",
    coverBg: { kind: "solid", color: "#FFFFFF" },
    bodyBg: { kind: "solid", color: "#FFFFFF" },
    closeBg: { kind: "solid", color: "#D62828" },
    coverDeco: "vignelli-band",
    bodyDeco: "vignelli-band",
    closeDeco: "none",
    coverComp: "banner",
    photoStyle:
      "Clean modernist architectural photography: strong horizontal and vertical lines, white and red palette, precise composition, generous sky, documentary clarity",
    typeRatio: 1.414,
  },
  // 브루탈리즘 — 원시 보더, 모노스페이스, 콘크리트와 세이프티 오렌지.
  brutal: {
    id: "brutal",
    nameKo: "브루탈리스트",
    nameEn: "Brutalist",
    hintKo: "장식을 벗긴 구조 — 원시 보더, 모노, 하드 섀도",
    hintEn: "Structure stripped bare — raw borders, mono, hard shadows",
    displayFont: HELVETICA,
    bodyFont: HELVETICA,
    monoFont: MONO,
    titleWeight: 800,
    titleTracking: "-.02em",
    titleTransform: "uppercase",
    titleLineHeight: 1.0,
    kickerTracking: ".22em",
    radius: 0,
    borderScale: 2.2,
    hardShadow: true,
    accent: "#FF4D00",
    ink: "#141414",
    closeInk: "#E8E6E0",
    coverBg: { kind: "solid", color: "#E8E6E0" },
    bodyBg: { kind: "solid", color: "#E8E6E0" },
    closeBg: { kind: "solid", color: "#141414" },
    coverDeco: "brutal-frame",
    bodyDeco: "brutal-frame",
    closeDeco: "brutal-frame",
    coverComp: "poster",
    photoStyle:
      "Raw brutalist photography: harsh direct flash, high contrast, concrete textures, industrial subject, gritty street energy, desaturated with one safety-orange accent",
    typeRatio: 1.5,
  },
  // 하라 켄야 — 비움(Emptiness). 여백이 콘텐츠를 받치는 그릇이 된다.
  hara: {
    id: "hara",
    nameKo: "하라 미니멀",
    nameEn: "Hara Minimal",
    hintKo: "하라 켄야의 비움 — 여백, 점 하나, 침묵의 타이포",
    hintEn: "Kenya Hara's emptiness — whitespace, a single dot, quiet type",
    displayFont: AVENIR,
    bodyFont: AVENIR,
    monoFont: MONO,
    titleWeight: 500,
    titleTracking: ".02em",
    titleTransform: "none",
    titleLineHeight: 1.3,
    kickerTracking: ".44em",
    radius: 0.2,
    borderScale: 0.7,
    accent: "#C7472E",
    ink: "#3A3A38",
    coverBg: { kind: "solid", color: "#FBFBF9" },
    bodyBg: { kind: "solid", color: "#FBFBF9" },
    closeBg: { kind: "solid", color: "#F4F4F1" },
    coverDeco: "hara-void",
    bodyDeco: "hara-void",
    closeDeco: "hara-void",
    coverComp: "centered",
    photoStyle:
      "Japanese minimalist still-life photography in the style of MUJI campaigns: vast empty horizon, soft diffused light, muted neutral palette, quiet zen composition, single small subject",
    typeRatio: 1.333,
  },
};

export const STYLE_IDS: StyleId[] = ["swiss", "bauhaus", "didot", "vignelli", "brutal", "hara"];

export function styleById(id: string | undefined | null): StyleDna | null {
  if (!id) return null;
  return (STYLES as Record<string, StyleDna>)[id] ?? null;
}

// 주제 → 스타일 라우터(아트디렉션 라우터의 스타일 축 확장). 명시 선택이 항상 우선.
const STYLE_HINTS: Array<{ id: StyleId; rx: RegExp }> = [
  { id: "didot", rx: /패션|뷰티|럭셔리|명품|브랜딩|매거진|문화|예술|전시|웨딩|fashion|beauty|luxury|magazine|culture|art|gallery|wedding|couture/i },
  { id: "bauhaus", rx: /디자인|교육|워크숍|창의|아이디어|건축|스튜디오|design|education|workshop|creative|architecture|studio|maker/i },
  { id: "brutal", rx: /게임|스트리트|힙합|이스포츠|해커톤|크립토|밈|스타트업 위크|game|street|hip.?hop|esports|hackathon|crypto|meme|rave/i },
  { id: "hara", rx: /미니멀|철학|에세이|명상|웰니스|공예|차분|minimal|philosophy|essay|meditation|wellness|craft|calm|zen/i },
  { id: "vignelli", rx: /보고|재무|분기|실적|컨설팅|운영|지표|로드맵|report|finance|quarterly|earnings|consult|operations|kpi|roadmap/i },
  { id: "swiss", rx: /피치|투자|전략|테크|제품|런칭|컨퍼런스|세미나|pitch|invest|strategy|tech|product|launch|conference|seminar|keynote/i },
];

/**
 * 프롬프트 → 스타일. 매치 없으면 null(레거시 모드 룩 유지) — 기존 덱/기존 동작 보존이
 * 기본값이고, 스타일은 명시 선택 또는 주제 매치로만 켜진다.
 */
export function routeStyle(prompt: string): StyleId | null {
  for (const h of STYLE_HINTS) if (h.rx.test(prompt)) return h.id;
  return null;
}
