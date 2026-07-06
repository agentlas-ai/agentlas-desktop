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

export type StyleId = "swiss" | "bauhaus" | "didot" | "vignelli" | "brutal" | "hara" | "consulting" | "aurora";

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
   * 카드 처리 공식 — "테두리 대신 면(fill) 또는 부드러운 그림자(shadow)".
   * border는 브루탈리즘처럼 보더 자체가 조형 언어인 유파만 쓴다.
   */
  cardStyle: "fill" | "shadow" | "border";
  /**
   * 커버 사진 공식 — panel(하프앤하프: 엣지-투-엣지 분할), bleed(풀블리드+스크림+밝은 글자),
   * plate(중앙 플레이트, 소프트 엣지 페이드).
   */
  coverPhoto: "panel" | "bleed" | "plate";
  /**
   * 인포그래픽 도형 패널 룩 — 카드 배경으로 쓸 "디자인된 빈 패널" 이미지의 생성 규정.
   * 중앙은 반드시 비워(텍스트 안전영역) 텍스트는 HTML로만 얹는다(굽지 않기 원칙).
   */
  graphicStyle: string;
  // ── 컨설팅·보고서 문법(중기부 업무보고·MBB 벤치마크, 2026-07-04) ──
  /** 상단 챕터 밴드(네이비 사선 밴드 + 번호 칩 + 챕터명) — 본문 장 헤더를 밴드형으로. */
  chapterBand?: boolean;
  /** 밴드·헤더바 패널의 솔리드 색(없으면 ink). 중기부 네이비 #0B3675. */
  band?: string;
  /** 본문 `**강조**`의 형광펜 색(불투명). 없으면 accent 16% 틴트. */
  highlight?: string;
  /** 리스트 행 라벨을 아웃라인 필 칩으로(중기부 "기술혁신/수출/창업" 문법). */
  listChip?: boolean;
  // ── 프리미엄 색시스템(모던 SaaS/테크, 2026-07-06) ──
  /** accent2→accent 그라데이션을 액센트 요소(바·KPI 값·룰)에 적용. */
  gradient?: boolean;
  /** 컬러 글로우 — 카드·패널 그림자를 강조색으로(검정 아님, 발광). */
  glow?: boolean;
}

/**
 * 타이포그래피 스케일(사용자 스펙 2026-07-02) — 비율 1.2(minor third) 고정 사다리.
 * A4 기준 실측: h1 35.84pt · h2 29.86 · h3 24.89 · h4 20.74 · h5 17.28 · 주석 11pt.
 * 역할 매핑: h1=표지 제목+본문 헤드라인 / h2=표지·상단 서브 헤드라인 / h3=박스·컨텐츠 제목 /
 * h4=문단(리스트 행) 제목 / h5=박스 안 본문 / note=주석(킥커·푸터·캡션).
 * 페이지 크기 연동: pt값을 캔버스 폭 기준 cqw로 환산 — A4 세로(595pt)에선 스펙 pt와 일치하고,
 * 16:9(표준 960pt 폭)에선 같은 비례로 축소된다.
 */
export interface TypeScaleSteps {
  /** 주석 — 킥커·푸터·pill·캡션(11pt급) */
  note: number;
  /** 본문 — 박스 안의 글·부제·인사이트(17.28pt급) */
  h5: number;
  /** 문단 제목 — 리스트 행 제목(20.74pt급) */
  h4: number;
  /** 컨텐츠(박스) 제목 — 카드 라벨(24.89pt급) */
  h3: number;
  /** 서브 헤드라인 — 표지 부제(29.86pt급) */
  h2: number;
  /** 헤드라인 — 표지 제목·본문 페이지 제목(35.84pt급) */
  h1: number;
  /** 표지/스테이트먼트 제목 — 스펙상 h1과 동일(레거시만 별도 값) */
  display: number;
  /** KPI 숫자 — 텍스트 위계 밖(데이터 표시), h1에서 두 단계 위(×1.44) */
  kpi: number;
}

/**
 * 페이지 비율 연동 앵커 — h5 = 2.4 × √(높이/너비) cqw. 글자의 물리 크기를 페이지의
 * 기하평균(√(w·h))에 비례시키는 연속식이라 어떤 판형이든 "비율대로" 스케일된다:
 * 16:9 → 1.80(=17.28pt/960pt) · A4 세로 → 2.85(스펙 pt 실측과 일치) · 9:16 → 3.20 · 1:1 → 2.40.
 * 나머지 단계는 전부 ×1.2 사다리(minor third) — 감으로 정한 크기 금지.
 */
export function typeScale(aspect: number): TypeScaleSteps {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 9 / 16;
  const h5 = Math.max(1.5, Math.min(3.4, 2.4 * Math.sqrt(a)));
  const r = 1.2;
  const h4 = h5 * r;
  const h3 = h4 * r;
  const h2 = h3 * r;
  const h1 = h2 * r;
  return { note: h5 * (11 / 17.28), h5, h4, h3, h2, h1, display: h1, kpi: h1 * r * r };
}

const HELVETICA = '"Helvetica Neue", Helvetica, Arial, Pretendard, "Apple SD Gothic Neo", sans-serif';
const FUTURA = 'Futura, "Avenir Next", "Century Gothic", Pretendard, "Apple SD Gothic Neo", sans-serif';
const AVENIR = '"Avenir Next", Avenir, Pretendard, "Apple SD Gothic Neo", sans-serif';
const DIDOT = 'Didot, "Bodoni 72", "Playfair Display", Georgia, "AppleMyungjo", "Nanum Myeongjo", serif';
const GEORGIA = 'Georgia, "Iowan Old Style", "AppleMyungjo", "Nanum Myeongjo", serif';
const MONO = '"SF Mono", Menlo, "IBM Plex Mono", monospace';
// 한국 보고서 표준 고딕 — 시스템 우선(Pretendard→Apple SD→맑은고딕), 라틴은 시스템 산세리프.
const GOTHIC = 'Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", -apple-system, "Segoe UI", sans-serif';

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
    cardStyle: "fill",
    coverPhoto: "panel",
    graphicStyle:
      "Flat off-white rectangular panel in Swiss International Style: one thin vermilion-red geometric accent line along the top edge and a small red square in the top-left corner, hard-edged, print-poster finish, the entire center completely empty and plain",
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
    cardStyle: "fill",
    coverPhoto: "panel",
    graphicStyle:
      "Warm cream rectangular panel in Bauhaus print style: a small cluster of primary-color shapes (red circle, yellow triangle, blue bar) in the top-right corner only, matte paper texture, the entire center completely empty and plain",
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
    coverInk: "#F4EFE6",
    coverBg: { kind: "solid", color: "#181412" },
    bodyBg: { kind: "solid", color: "#FAF7F0" },
    closeBg: { kind: "solid", color: "#151210" },
    coverDeco: "didot-frame",
    bodyDeco: "didot-frame",
    closeDeco: "didot-frame",
    coverComp: "centered",
    photoStyle:
      "Black-and-white high-fashion editorial photography, Vogue magazine style: dramatic chiaroscuro lighting, elegant composition, film grain, timeless and luxurious mood",
    cardStyle: "shadow",
    coverPhoto: "bleed",
    graphicStyle:
      "Ivory rectangular panel in vintage fashion-magazine style: a delicate thin double-line frame hugging the edges with tiny corner ornaments, letterpress finish, the entire center completely empty and plain",
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
    cardStyle: "fill",
    coverPhoto: "panel",
    graphicStyle:
      "Clean white rectangular panel in modernist style: a single bold red horizontal band along the very top edge, nothing else, precise and flat, the entire center completely empty and plain",
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
    cardStyle: "border",
    coverPhoto: "panel",
    graphicStyle:
      "Raw light-concrete textured rectangular panel in brutalist print style: a thick black border around the edges, slightly rough grain, the entire center completely empty and plain",
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
    cardStyle: "shadow",
    coverPhoto: "plate",
    graphicStyle:
      "Soft warm-white washi paper textured rectangular panel, zen minimal: a single tiny vermilion dot near the top-left corner, extremely quiet, the entire center completely empty and plain",
  },
  // 컨설팅·보고서 — 한국 정부 업무보고/MBB 문법: 네이비 챕터 밴드, 헤더바 패널,
  // 아웃라인 필 칩 행, 노란 형광펜, 파랑 강조 제목, 출처 풋라인 (벤치마크: 중기부 업무보고 2025).
  consulting: {
    id: "consulting",
    nameKo: "컨설팅 보고서",
    nameEn: "Consulting Report",
    hintKo: "정부 업무보고·MBB — 챕터 밴드, 패널, 형광펜, 출처",
    hintEn: "Gov briefing & MBB — chapter band, panels, highlighter, sources",
    displayFont: GOTHIC,
    bodyFont: GOTHIC,
    monoFont: GOTHIC,
    titleWeight: 800,
    titleTracking: "-.025em",
    titleTransform: "none",
    titleLineHeight: 1.16,
    kickerTracking: ".06em",
    radius: 0.5,
    borderScale: 1,
    accent: "#1B64C2",
    accent2: "#FFE94A",
    ink: "#15181D",
    coverInk: "#0B3675",
    closeInk: "#FFFFFF",
    coverBg: { kind: "gradient", from: "#EEF2F8", to: "#D8E1EE", angle: 160 },
    bodyBg: { kind: "solid", color: "#FFFFFF" },
    closeBg: { kind: "solid", color: "#0B3675" },
    coverDeco: "none",
    bodyDeco: "none",
    closeDeco: "none",
    coverComp: "centered",
    photoStyle:
      "Clean Korean corporate report photography: soft blue-grey gradient light, subtle upward arrows or light rays, professional and restrained, government briefing aesthetic, no clutter",
    cardStyle: "shadow",
    coverPhoto: "plate",
    graphicStyle:
      "Flat white rectangular corporate panel with a thin navy top border line and a very pale blue-grey header strip, Korean government report style, crisp and formal, the entire center completely empty and plain",
    chapterBand: true,
    band: "#0B3675",
    highlight: "#FFE94A",
    listChip: true,
  },
  // 오로라 — 모던 SaaS/테크: 인디고→바이올렛 그라데이션 램프 + 컬러 글로우(Stripe/Linear 계열).
  aurora: {
    id: "aurora",
    nameKo: "오로라",
    nameEn: "Aurora",
    hintKo: "모던 SaaS — 인디고→바이올렛 그라데이션 · 컬러 글로우",
    hintEn: "Modern SaaS — indigo→violet gradient, colored glow",
    displayFont: GOTHIC,
    bodyFont: GOTHIC,
    monoFont: MONO,
    titleWeight: 800,
    titleTracking: "-.02em",
    titleTransform: "none",
    titleLineHeight: 1.14,
    kickerTracking: ".12em",
    radius: 1.3,
    borderScale: 1,
    accent: "#4F46E5",
    accent2: "#A855F7",
    ink: "#1E1B2E",
    coverInk: "#FFFFFF",
    closeInk: "#FFFFFF",
    coverBg: { kind: "gradient", from: "#4F46E5", to: "#7C3AED", angle: 135 },
    bodyBg: { kind: "solid", color: "#F7F7FB" },
    closeBg: { kind: "gradient", from: "#312E81", to: "#4C1D95", angle: 160 },
    coverDeco: "none",
    bodyDeco: "none",
    closeDeco: "none",
    coverComp: "centered",
    photoStyle:
      "Modern premium SaaS/tech visual: indigo-to-violet gradient, soft glow, subtle glassmorphism, aurora mesh background, clean vivid and dimensional",
    cardStyle: "shadow",
    coverPhoto: "bleed",
    graphicStyle:
      "Flat white rounded panel with a subtle indigo-violet gradient accent along the top edge and a soft colored glow, modern SaaS style, the entire center empty and plain",
    gradient: true,
    glow: true,
  },
};

export const STYLE_IDS: StyleId[] = ["swiss", "bauhaus", "didot", "vignelli", "brutal", "hara", "consulting", "aurora"];

// ── 모던 색조합 팔레트(50) ──────────────────────────────────────────
// 유파(art-school) 대신 "색조합"으로 가는 방향. aurora의 구조(폰트·레이아웃·gradient·glow)를
// 팩토리로 재사용하고 색만 스왑한다. ink/bg는 accent에서 자동 유도(응집된 톤) → 스펙 최소화.
export interface Palette { id: string; nameKo: string; nameEn: string; accent: string; accent2: string; }

function _hx(h: string): [number, number, number] { const c = h.replace("#", ""); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
function _mix(a: string, b: string, t: number): string { const x = _hx(a), y = _hx(b); const f = (i: number) => ("0" + Math.round(x[i] + (y[i] - x[i]) * t).toString(16)).slice(-2); return "#" + f(0) + f(1) + f(2); }

/** 팔레트 스펙 → 완전한 StyleDna(gradient+glow on). ink=딥틴트, bg=near-white 틴트, closeBg=딥 그라데이션. */
export function paletteStyle(p: Palette): StyleDna {
  const ink = _mix(p.accent, "#0A0A12", 0.86); // 살짝 색을 머금은 근-검정(본문 대비 확보)
  const bg = _mix(p.accent, "#FFFFFF", 0.955); // near-white 틴트
  const dk = (c: string) => _mix(c, "#0B0B16", 0.6); // 클로징용 딥 셰이드
  return {
    id: p.id as StyleId, nameKo: p.nameKo, nameEn: p.nameEn,
    hintKo: `색조합 — ${p.nameKo}`, hintEn: `Palette — ${p.nameEn}`,
    displayFont: GOTHIC, bodyFont: GOTHIC, monoFont: MONO,
    titleWeight: 800, titleTracking: "-.02em", titleTransform: "none", titleLineHeight: 1.14, kickerTracking: ".12em",
    radius: 1.3, borderScale: 1,
    accent: p.accent, accent2: p.accent2, ink, coverInk: "#FFFFFF", closeInk: "#FFFFFF",
    coverBg: { kind: "gradient", from: p.accent, to: p.accent2, angle: 135 },
    bodyBg: { kind: "solid", color: bg },
    closeBg: { kind: "gradient", from: dk(p.accent), to: dk(p.accent2), angle: 160 },
    coverDeco: "none", bodyDeco: "none", closeDeco: "none", coverComp: "centered",
    photoStyle: "Modern premium palette visual: soft gradient and colored glow, clean, vivid and dimensional",
    cardStyle: "shadow", coverPhoto: "bleed",
    graphicStyle: "Flat white rounded panel with a subtle gradient accent edge and soft colored glow, modern SaaS style, center empty and plain",
    gradient: true, glow: true,
  };
}

export const PALETTES: Palette[] = [
  { id: "indigo", nameKo: "인디고", nameEn: "Indigo", accent: "#4F46E5", accent2: "#7C3AED" },
  { id: "violet", nameKo: "바이올렛", nameEn: "Violet", accent: "#7C3AED", accent2: "#A855F7" },
  { id: "purple", nameKo: "퍼플", nameEn: "Purple", accent: "#9333EA", accent2: "#C026D3" },
  { id: "fuchsia", nameKo: "푸시아", nameEn: "Fuchsia", accent: "#C026D3", accent2: "#DB2777" },
  { id: "pink", nameKo: "핑크", nameEn: "Pink", accent: "#DB2777", accent2: "#E11D48" },
  { id: "rose", nameKo: "로즈", nameEn: "Rose", accent: "#E11D48", accent2: "#F43F5E" },
  { id: "red", nameKo: "레드", nameEn: "Red", accent: "#DC2626", accent2: "#EA580C" },
  { id: "orange", nameKo: "오렌지", nameEn: "Orange", accent: "#EA580C", accent2: "#F59E0B" },
  { id: "amber", nameKo: "앰버", nameEn: "Amber", accent: "#D97706", accent2: "#EAB308" },
  { id: "gold", nameKo: "골드", nameEn: "Gold", accent: "#CA8A04", accent2: "#84CC16" },
  { id: "lime", nameKo: "라임", nameEn: "Lime", accent: "#65A30D", accent2: "#16A34A" },
  { id: "green", nameKo: "그린", nameEn: "Green", accent: "#16A34A", accent2: "#10B981" },
  { id: "emerald", nameKo: "에메랄드", nameEn: "Emerald", accent: "#059669", accent2: "#14B8A6" },
  { id: "teal", nameKo: "틸", nameEn: "Teal", accent: "#0D9488", accent2: "#06B6D4" },
  { id: "cyan", nameKo: "시안", nameEn: "Cyan", accent: "#0891B2", accent2: "#0EA5E9" },
  { id: "sky", nameKo: "스카이", nameEn: "Sky", accent: "#0284C7", accent2: "#3B82F6" },
  { id: "blue", nameKo: "블루", nameEn: "Blue", accent: "#2563EB", accent2: "#4F46E5" },
  { id: "royal", nameKo: "로열블루", nameEn: "Royal", accent: "#1D4ED8", accent2: "#7C3AED" },
  { id: "cobalt", nameKo: "코발트", nameEn: "Cobalt", accent: "#1E40AF", accent2: "#0EA5E9" },
  { id: "ocean", nameKo: "오션", nameEn: "Ocean", accent: "#0369A1", accent2: "#0D9488" },
  { id: "slate", nameKo: "슬레이트", nameEn: "Slate", accent: "#475569", accent2: "#64748B" },
  { id: "graphite", nameKo: "그래파이트", nameEn: "Graphite", accent: "#334155", accent2: "#0EA5E9" },
  { id: "midnight", nameKo: "미드나잇", nameEn: "Midnight", accent: "#312E81", accent2: "#6D28D9" },
  { id: "grape", nameKo: "그레이프", nameEn: "Grape", accent: "#6D28D9", accent2: "#DB2777" },
  { id: "plum", nameKo: "플럼", nameEn: "Plum", accent: "#86198F", accent2: "#BE185D" },
  { id: "berry", nameKo: "베리", nameEn: "Berry", accent: "#9D174D", accent2: "#DB2777" },
  { id: "crimson", nameKo: "크림슨", nameEn: "Crimson", accent: "#B91C1C", accent2: "#E11D48" },
  { id: "sunset", nameKo: "선셋", nameEn: "Sunset", accent: "#EA580C", accent2: "#DB2777" },
  { id: "coral", nameKo: "코랄", nameEn: "Coral", accent: "#F43F5E", accent2: "#FB923C" },
  { id: "peach", nameKo: "피치", nameEn: "Peach", accent: "#FB7185", accent2: "#FBBF24" },
  { id: "mustard", nameKo: "머스타드", nameEn: "Mustard", accent: "#A16207", accent2: "#65A30D" },
  { id: "olive", nameKo: "올리브", nameEn: "Olive", accent: "#4D7C0F", accent2: "#0D9488" },
  { id: "forest", nameKo: "포레스트", nameEn: "Forest", accent: "#166534", accent2: "#0D9488" },
  { id: "jade", nameKo: "제이드", nameEn: "Jade", accent: "#047857", accent2: "#0891B2" },
  { id: "mint", nameKo: "민트", nameEn: "Mint", accent: "#10B981", accent2: "#06B6D4" },
  { id: "aqua", nameKo: "아쿠아", nameEn: "Aqua", accent: "#06B6D4", accent2: "#3B82F6" },
  { id: "azure", nameKo: "애저", nameEn: "Azure", accent: "#0EA5E9", accent2: "#6366F1" },
  { id: "sapphire", nameKo: "사파이어", nameEn: "Sapphire", accent: "#1E3A8A", accent2: "#2563EB" },
  { id: "denim", nameKo: "데님", nameEn: "Denim", accent: "#3B5BDB", accent2: "#5C7CFA" },
  { id: "periwinkle", nameKo: "페리윙클", nameEn: "Periwinkle", accent: "#6366F1", accent2: "#A855F7" },
  { id: "lavender", nameKo: "라벤더", nameEn: "Lavender", accent: "#8B5CF6", accent2: "#EC4899" },
  { id: "orchid", nameKo: "오키드", nameEn: "Orchid", accent: "#A21CAF", accent2: "#7C3AED" },
  { id: "magenta", nameKo: "마젠타", nameEn: "Magenta", accent: "#DB2777", accent2: "#9333EA" },
  { id: "wine", nameKo: "와인", nameEn: "Wine", accent: "#9F1239", accent2: "#BE123C" },
  { id: "brick", nameKo: "브릭", nameEn: "Brick", accent: "#9A3412", accent2: "#C2410C" },
  { id: "rust", nameKo: "러스트", nameEn: "Rust", accent: "#B45309", accent2: "#DC2626" },
  { id: "terracotta", nameKo: "테라코타", nameEn: "Terracotta", accent: "#C2410C", accent2: "#E11D48" },
  { id: "sage", nameKo: "세이지", nameEn: "Sage", accent: "#4D7C0F", accent2: "#059669" },
  { id: "steel", nameKo: "스틸", nameEn: "Steel", accent: "#0F766E", accent2: "#1D4ED8" },
  { id: "charcoal", nameKo: "차콜", nameEn: "Charcoal", accent: "#1F2937", accent2: "#4F46E5" },
];

const PALETTE_MAP: Record<string, StyleDna> = Object.fromEntries(PALETTES.map((p) => [p.id, paletteStyle(p)]));
export const PALETTE_IDS: string[] = PALETTES.map((p) => p.id);

export function styleById(id: string | undefined | null): StyleDna | null {
  if (!id) return null;
  return (STYLES as Record<string, StyleDna>)[id] ?? PALETTE_MAP[id] ?? null;
}

// 주제 → 스타일 라우터(아트디렉션 라우터의 스타일 축 확장). 명시 선택이 항상 우선.
const STYLE_HINTS: Array<{ id: StyleId; rx: RegExp }> = [
  // 비즈니스·보고서 계열은 컨설팅 문법이 1순위(벤치마크: 중기부 업무보고·혁신의숲 IR).
  { id: "consulting", rx: /보고|업무보고|IR|사업계획|재무|분기|실적|컨설팅|운영|지표|전략|투자|정부|부처|정책|리뷰|report|briefing|business plan|finance|quarterly|earnings|consult|operations|kpi|strategy|invest|policy|review/i },
  { id: "didot", rx: /패션|뷰티|럭셔리|명품|브랜딩|매거진|문화|예술|전시|웨딩|fashion|beauty|luxury|magazine|culture|art|gallery|wedding|couture/i },
  { id: "bauhaus", rx: /디자인|교육|워크숍|창의|아이디어|건축|스튜디오|design|education|workshop|creative|architecture|studio|maker/i },
  { id: "brutal", rx: /게임|스트리트|힙합|이스포츠|해커톤|크립토|밈|스타트업 위크|game|street|hip.?hop|esports|hackathon|crypto|meme|rave/i },
  { id: "hara", rx: /미니멀|철학|에세이|명상|웰니스|공예|차분|minimal|philosophy|essay|meditation|wellness|craft|calm|zen/i },
  { id: "vignelli", rx: /사이니지|타임테이블|시각체계|signage|timetable|grid system/i },
  { id: "swiss", rx: /피치|테크|제품|런칭|컨퍼런스|세미나|pitch|tech|product|launch|conference|seminar|keynote/i },
];

/**
 * 프롬프트 → 스타일. 매치 없으면 null(레거시 모드 룩 유지) — 기존 덱/기존 동작 보존이
 * 기본값이고, 스타일은 명시 선택 또는 주제 매치로만 켜진다.
 */
export function routeStyle(prompt: string): StyleId | null {
  for (const h of STYLE_HINTS) if (h.rx.test(prompt)) return h.id;
  return null;
}
