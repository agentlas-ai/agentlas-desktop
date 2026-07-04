// T-rex 슬라이드 모델 — 편집기가 다루는 "위치 기반 블록" JSON이 진실의 원천.
// 렌더러(DeckStage)는 이 모델을 16:9 무대에 그리고, 편집기는 이 모델을 직접 수정한다.
// 아트디렉션 라우터(목적→모드)는 PPT 에이전트 연구 결과를 옮긴 것:
//   cinematic(서사) / editorial(비즈니스·사진0) / diagrammatic(학술) / hybrid(스포츠·데이터).
//
// 로케일: 콘텐츠가 없을 때(스캐폴드/미완성 LLM 응답) 채우는 폴백·플레이스홀더 텍스트는
// 전부 locale 인자를 받는다(기본값 "ko" — 미갱신 호출부의 기존 동작 보존). "en"이면 자연스러운
// 영어 카피로 대체한다(직역이 아님). 프롬프트 분류용 정규식(MODE_HINTS 등)은 로케일과 무관.

import type { Locale } from "@/lib/i18n";
import { styleById, typeScale, type DecoKind, type StyleDna, type TypeScaleSteps } from "./styles";

export type ArtMode = "cinematic" | "editorial" | "diagrammatic" | "hybrid";
export type SceneKind = "none" | "dusk" | "impact" | "pitch" | "field";

// ── 캔버스 규격(레이아웃) ──────────────────────────────────────────
// 블록은 %(x/y/w)·cqw(폰트) 기반이라 어떤 비율에도 자동 적응한다. 규격은 화면 비율 + (인쇄) 실측 크기.
export type FormatUnit = "px" | "mm";
export type FormatGroup = "screen" | "social" | "print";
export interface DeckFormat {
  id: string;
  labelKo: string;
  labelEn: string;
  group: FormatGroup;
  w: number;
  h: number;
  unit: FormatUnit;
}

export const FORMATS: DeckFormat[] = [
  // 화면 / 프레젠테이션
  { id: "widescreen", labelKo: "와이드 16:9", labelEn: "Widescreen 16:9", group: "screen", w: 1920, h: 1080, unit: "px" },
  { id: "standard43", labelKo: "표준 4:3", labelEn: "Standard 4:3", group: "screen", w: 1024, h: 768, unit: "px" },
  { id: "desktop", labelKo: "데스크톱 웹 (1440)", labelEn: "Desktop web (1440)", group: "screen", w: 1440, h: 1024, unit: "px" },
  { id: "iphone", labelKo: "iPhone Pro", labelEn: "iPhone Pro", group: "screen", w: 393, h: 852, unit: "px" },
  { id: "android", labelKo: "Android", labelEn: "Android", group: "screen", w: 360, h: 800, unit: "px" },
  { id: "ipad", labelKo: 'iPad Pro 11"', labelEn: 'iPad Pro 11"', group: "screen", w: 834, h: 1194, unit: "px" },
  // 소셜 / 마케팅
  { id: "ig-square", labelKo: "인스타 정사각 1:1", labelEn: "Instagram square", group: "social", w: 1080, h: 1080, unit: "px" },
  { id: "ig-portrait", labelKo: "인스타 세로 4:5", labelEn: "Instagram portrait", group: "social", w: 1080, h: 1350, unit: "px" },
  { id: "story", labelKo: "스토리·릴스·쇼츠 9:16", labelEn: "Story · Reels 9:16", group: "social", w: 1080, h: 1920, unit: "px" },
  { id: "yt-thumb", labelKo: "유튜브 썸네일", labelEn: "YouTube thumbnail", group: "social", w: 1280, h: 720, unit: "px" },
  { id: "yt-banner", labelKo: "유튜브 채널아트", labelEn: "YouTube banner", group: "social", w: 2560, h: 1440, unit: "px" },
  { id: "x-header", labelKo: "X 헤더 3:1", labelEn: "X header 3:1", group: "social", w: 1500, h: 500, unit: "px" },
  { id: "li-post", labelKo: "링크드인 포스트", labelEn: "LinkedIn post", group: "social", w: 1200, h: 627, unit: "px" },
  { id: "li-cover", labelKo: "링크드인 커버", labelEn: "LinkedIn cover", group: "social", w: 1128, h: 191, unit: "px" },
  // 인쇄 (mm)
  { id: "a4", labelKo: "A4 세로", labelEn: "A4 portrait", group: "print", w: 210, h: 297, unit: "mm" },
  { id: "a4-land", labelKo: "A4 가로", labelEn: "A4 landscape", group: "print", w: 297, h: 210, unit: "mm" },
  { id: "a3", labelKo: "A3", labelEn: "A3", group: "print", w: 297, h: 420, unit: "mm" },
  { id: "card-kr", labelKo: "명함 (한국)", labelEn: "Business card (KR)", group: "print", w: 90, h: 50, unit: "mm" },
];

export const DEFAULT_FORMAT_ID = "widescreen";
export function formatById(id: string | undefined): DeckFormat {
  return FORMATS.find((f) => f.id === id) ?? FORMATS.find((f) => f.id === DEFAULT_FORMAT_ID)!;
}
/** CSS aspect-ratio 문자열(예: "1920 / 1080"). */
export function formatRatio(f: DeckFormat): string {
  return `${f.w} / ${f.h}`;
}

export type BlockKind = "kicker" | "title" | "subtitle" | "body" | "rule" | "pill" | "kpi" | "bar" | "footer" | "card" | "image" | "band" | "panel";

/** 패널 안 한 행 — 칩 라벨 + 굵은 주장 + (옵션) 부연 한 줄. 중기부 "실적/성과" 행 밀도. */
export interface PanelRow {
  label?: string;
  text: string;
  sub?: string;
}

export interface TrexBlock {
  id: string;
  kind: BlockKind;
  x: number; // % of slide width
  y: number; // % of slide height
  w: number; // % of slide width
  size?: number; // font size in cqw
  text?: string;
  value?: string;
  label?: string;
  align?: "left" | "center" | "right";
  accent?: boolean;
  weight?: number;
  h?: number; // % of slide height — 고정 높이 블록(카드 등)을 균등하게 채운다
  /** kpi 블록: 카드 서피스(면) 위에 올린다 — 맨몸 숫자가 떠 보이는 것 방지(h 필수). */
  surface?: boolean;
  /** card 블록: 헤더 바 패널(솔리드 잉크 바 제목 + 면 본문 — 컨설팅 패널 문법). */
  bar?: boolean;
  /** panel 블록: 헤더 바(label) + 조밀한 다중 행(중기부 실적/성과 패널). h 필수. */
  rows?: PanelRow[];
  inline?: boolean; // body: 번호(label)+텍스트를 한 줄에(목차 등)
  /** image 블록: 생성된 이미지(dataURL). 비어 있으면 렌더러가 생성중 플레이스홀더를 그린다. */
  src?: string;
  /** image 블록: 이미지 생성용 장면 설명(스타일 접미는 생성 시점에 dna.photoStyle로). */
  prompt?: string;
  /** image 블록: 풀블리드 위 텍스트 가독성용 다크 스크림 오버레이(공식 ①). */
  scrim?: boolean;
  /** image 블록: 소프트 엣지 — 한쪽을 배경으로 페이드아웃(공식 ③, 마스크 그라데이션). */
  fade?: "bottom" | "left" | "right";
}

export type SlideBg =
  | { kind: "solid"; color: string }
  | { kind: "gradient"; from: string; to: string; angle?: number }
  | { kind: "image"; src: string; scrim?: string };

export interface TrexSlide {
  id: string;
  bg: SlideBg;
  ink: string;
  scene: SceneKind; // 시네마틱/하이브리드 SVG 배경(없으면 "none")
  deco?: DecoKind; // Style DNA 장식 모티프 레이어(블록 뒤, 비인터랙티브)
  decoN?: string; // 장식용 인덱스 텍스트(스위스 거대 번호 등)
  decoV?: "cover" | "body" | "close"; // 데코 강도 변형(커버는 대담하게, 본문은 절제)
  blocks: TrexBlock[];
}

export interface TrexDeck {
  id: string;
  title: string;
  prompt: string;
  mode: ArtMode;
  /** Style DNA id(styles.ts). 없으면 레거시 모드 룩. */
  styleId?: string;
  accent: string;
  formatId: string;
  createdAt: number;
  slides: TrexSlide[];
}

export interface ModeTheme {
  mode: ArtMode;
  labelKo: string;
  labelEn: string;
  accent: string;
  ink: string;
  coverBg: SlideBg;
  bodyBg: SlideBg;
  closeBg: SlideBg;
  coverScene: SceneKind;
  closeScene: SceneKind;
}

export const MODE_THEMES: Record<ArtMode, ModeTheme> = {
  cinematic: {
    mode: "cinematic",
    labelKo: "시네마틱",
    labelEn: "Cinematic",
    accent: "#E89A3C",
    ink: "#ffffff",
    coverBg: { kind: "gradient", from: "#1d1430", to: "#b8512f", angle: 160 },
    bodyBg: { kind: "gradient", from: "#15140f", to: "#2c1d14", angle: 165 },
    closeBg: { kind: "gradient", from: "#0d0a12", to: "#9a3a1c", angle: 180 },
    coverScene: "dusk",
    closeScene: "impact",
  },
  editorial: {
    mode: "editorial",
    labelKo: "에디토리얼",
    labelEn: "Editorial",
    accent: "#C0202A",
    ink: "#23272E",
    coverBg: { kind: "solid", color: "#FBFAF8" },
    bodyBg: { kind: "solid", color: "#FBFAF8" },
    closeBg: { kind: "solid", color: "#1A1E24" },
    coverScene: "none",
    closeScene: "none",
  },
  diagrammatic: {
    mode: "diagrammatic",
    labelKo: "다이어그램",
    labelEn: "Diagrammatic",
    accent: "#1F7A6F",
    ink: "#1A1E24",
    coverBg: { kind: "solid", color: "#FBFAF8" },
    bodyBg: { kind: "solid", color: "#FBFAF8" },
    closeBg: { kind: "solid", color: "#F2F7F5" },
    coverScene: "none",
    closeScene: "none",
  },
  hybrid: {
    mode: "hybrid",
    labelKo: "다크 하이브리드",
    labelEn: "Dark Hybrid",
    accent: "#C9F24E",
    ink: "#ffffff",
    coverBg: { kind: "gradient", from: "#0a130d", to: "#142a1c", angle: 160 },
    bodyBg: { kind: "solid", color: "#0a130d" },
    closeBg: { kind: "gradient", from: "#0a130d", to: "#14241a", angle: 180 },
    coverScene: "field",
    closeScene: "pitch",
  },
};

const MODE_HINTS: Array<{ mode: ArtMode; rx: RegExp }> = [
  { mode: "editorial", rx: /컨설팅|전략|제안|보고|사업|비즈니스|매출|재무|시장|투자|영업|kpi|roi|분기|consult|business|report|strategy|finance|market|revenue|proposal/i },
  { mode: "diagrammatic", rx: /학술|논문|연구|화학|물리|생물|수학|세미나|메커니즘|분자|실험|academic|research|paper|chemistry|physics|biology|seminar|mechanism|molecul/i },
  { mode: "hybrid", rx: /월드컵|스포츠|경기|리그|선수|올림픽|랭킹|순위|게임|esports|sport|league|match|tournament|player|world ?cup|ranking/i },
  { mode: "cinematic", rx: /공룡|역사|자연|우주|여행|브랜드|런칭|이야기|다큐|감성|story|history|nature|space|travel|brand|launch|cinema|journey|documentary/i },
];

/** 프롬프트 → 아트디렉션 모드 (하이브리드 엔진 1단계; Phase 2에서 LLM 라우팅으로 교체 가능) */
export function routeMode(prompt: string): ArtMode {
  for (const h of MODE_HINTS) if (h.rx.test(prompt)) return h.mode;
  return "editorial";
}

export const MIN_SLIDES = 3;
export const MAX_SLIDES = 14;
export function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.max(MIN_SLIDES, Math.min(MAX_SLIDES, Math.round(n)));
}

let _seq = 0;
function bid(): string {
  _seq += 1;
  return `b${_seq.toString(36)}${(_seq * 2654435761) % 99991}`;
}

function cleanTitle(prompt: string, locale: Locale = "ko"): string {
  const t = prompt.trim().replace(/\s+/g, " ");
  if (t.length > 46) return `${t.slice(0, 44)}…`;
  return t || (locale === "ko" ? "제목 없는 덱" : "Untitled Deck");
}

/** KPI 값 길이에 맞춰 폰트를 줄여 좁은 열에서 줄바꿈/넘침을 막는다(짧은 값엔 영향 없음). */
function fitKpiSize(value: string | undefined, base: number): number {
  const n = (value || "").length;
  if (n <= 6) return base;
  if (n <= 9) return base * 0.82;
  if (n <= 12) return base * 0.68;
  return base * 0.56;
}

/** 제목 길이에 맞춰 폰트 크기를 줄여 ~2줄 안에 들어오게(겹침 방지 자동맞춤). */
function fitTitleSize(text: string, base: number): number {
  const n = plain(text).length;
  if (n <= 16) return base;
  if (n <= 26) return base * 0.82;
  if (n <= 38) return base * 0.66;
  return base * 0.54;
}

/** 프롬프트에서 짧은 포인트들을 뽑는다(콤마/구분자 기반의 가벼운 분해). */
function derivePoints(prompt: string, want: number, locale: Locale = "ko"): string[] {
  const parts = prompt
    .split(/[,，·•\n]|그리고|및|->|→/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  const fallback =
    locale === "ko"
      ? ["핵심 맥락", "현재 상태", "기회 영역", "주요 리스크", "다음 단계", "기대 효과"]
      : ["Key Context", "Current State", "Opportunity Areas", "Key Risks", "Next Steps", "Expected Impact"];
  const out: string[] = [...parts];
  let fi = 0;
  while (out.length < want) out.push(fallback[fi++ % fallback.length]);
  return out.slice(0, want).map((s) => (s.length > 24 ? `${s.slice(0, 22)}…` : s));
}

function footer(idx: number, total: number, ink: string, src?: string): TrexBlock {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  // 컨설팅 표준 풋라인: 수치가 있는 장은 좌측에 출처를 밝힌다(신뢰 신호). 없으면 브랜드.
  return { id: bid(), kind: "footer", x: 6, y: 90, w: 88, size: 1.05, text: src ? `${src} · Agentlas T-rex` : "Agentlas · T-rex", value: `${pad(idx + 1)} / ${pad(total)}` };
}

/** `**강조**` 마커 제거 — 길이 기반 폰트 적응/줄수 추정은 렌더 문자 수 기준이어야 한다. */
function plain(t: string | undefined): string {
  return (t || "").replace(/\*\*/g, "");
}

/** 빌더 옵션 — Style DNA + 이미지 패널 사용 여부(끄면 텍스트 전용 레이아웃 유지). */
interface BuildOpts {
  dna?: StyleDna | null;
  images?: boolean;
  /** 페이지 비율(높이/너비) — 폰트 앵커를 판형에 연속 연동("비율대로"). */
  aspect?: number;
}

// 레거시(스타일 미지정) 덱용 스케일 — 기존 크기 관행을 새 사다리 필드명에 맞춰 정리한 값.
const LEGACY_SCALE: TypeScaleSteps = { note: 1.2, h5: 1.45, h4: 2.2, h3: 2.2, h2: 3.2, h1: 4.2, display: 6.6, kpi: 8.5 };

/** 빌더가 쓰는 타입 스케일 — dna 있으면 스펙 1.2 사다리(페이지 비율 연동), 없으면 레거시 관행. */
function scaleOf(opts: BuildOpts | undefined, o: Orient): TypeScaleSteps {
  if (!opts?.dna) return LEGACY_SCALE;
  const aspect = opts.aspect ?? (o === "portrait" ? 16 / 9 : o === "square" ? 1 : 9 / 16);
  return typeScale(aspect);
}

/** 부제(서브 헤드라인) 길이 적응 — h2가 커서 긴 문장은 줄여 3줄 초과를 막는다(제목 2줄 규칙의 부제판). */
function fitSubSize(text: string, base: number): number {
  const n = plain(text).length;
  if (n <= 30) return base;
  if (n <= 48) return base * 0.85;
  return base * 0.72;
}

/**
 * 스펙 사다리용 제목 길이 적응 — 축소를 늦게 시작해 h1이 부제 h2보다 항상 크게 유지한다
 * (기존 fitTitleSize 임계는 옛 대형 base용이라 새 h1을 부제 아래로 떨어뜨리는 위계 역전 유발).
 * 2줄 대칭은 text-wrap:balance가 담당 — 여기선 3줄 방지만 맡는다.
 */
function fitTitleSpec(text: string, base: number): number {
  const n = plain(text).length;
  if (n <= 26) return base;
  if (n <= 38) return base * 0.88;
  if (n <= 52) return base * 0.78;
  return base * 0.68;
}

/** 이미지 패널 블록 — 생성 전엔 빈 src(렌더러가 생성중 표시), prompt에 장면 설명. */
function imageBlock(rect: { x: number; y: number; w: number; h: number }, prompt: string, fx?: { scrim?: boolean; fade?: "bottom" | "left" | "right" }): TrexBlock {
  return { id: bid(), kind: "image", ...rect, src: "", prompt, ...(fx?.scrim ? { scrim: true } : {}), ...(fx?.fade ? { fade: fx.fade } : {}) };
}

/**
 * 슬라이드 하단 인사이트 바 — 결론 한 줄로 하단 여백을 정보로 채운다(밀도 규칙).
 * 근접성: 룰과 텍스트는 붙이고(그룹 내), 위 콘텐츠와는 4% 그리드로 띄운다(그룹 간).
 */
function insightBlocks(c: SlideContent, o: Orient, locale: Locale, wPct = 88, opts?: BuildOpts): TrexBlock[] {
  if (!c.note) return [];
  const port = o === "portrait";
  const ts = scaleOf(opts, o);
  const y = port ? 80 : 76;
  return [
    { id: bid(), kind: "rule", x: 6, y, w: wPct, accent: false },
    { id: bid(), kind: "body", x: 6, y: y + 2.6, w: wPct, size: ts.h5, label: locale === "ko" ? "핵심" : "INSIGHT", text: c.note, inline: true },
  ];
}

/** 슬라이드 콘텐츠에서 이미지 장면 설명 유도(LLM img 필드 우선, 없으면 제목 기반). */
function imgPromptOf(c: SlideContent, deckTitle: string): string {
  return (c.img || "").trim() || `An evocative editorial photograph representing: ${c.title || deckTitle}`;
}

// ── 방향(레이아웃) 인지 ────────────────────────────────────────────
// 규격의 가로세로비로 방향을 판단해, 세로형(portrait)은 블록을 세로 스택으로 재배치한다.
export type Orient = "landscape" | "portrait" | "square";
export function orientationOf(f: DeckFormat): Orient {
  const r = f.w / f.h;
  if (r >= 1.25) return "landscape";
  if (r <= 0.85) return "portrait";
  return "square";
}

// ── 콘텐츠 스키마 — LLM(agy/codex) 또는 스캐폴드가 채우는 슬라이드별 실제 내용 ──
export interface KpiItem { value: string; label: string }
export interface BarItem { label: string; value: number }
export interface CardItem { label: string; text: string }
/** 2패널(실적/성과) — 헤더 제목 + 조밀한 행 묶음. 중기부 업무보고 밀도. */
export interface PanelSpec { title: string; rows: PanelRow[] }
export interface SlideContent {
  role: SlideRole;
  title?: string;
  items?: string[];
  kpis?: KpiItem[];
  bars?: BarItem[];
  cards?: CardItem[];
  steps?: CardItem[];
  /** 2패널 좌우 배치(실적→성과). 있으면 structure가 고밀도 2패널로 렌더. */
  panels?: PanelSpec[];
  stat?: KpiItem;
  text?: string;
  /** 수치 출처 한 줄(풋노트) — "출처: 중기부, 2025" 등. 컨설팅 표준: 모든 수치엔 출처. */
  src?: string;
  /** 제목 아래 스탠드퍼스트(리드) 한 줄 — 제목·note와 겹치지 않는 새 정보. 헤더 데드존을 정보로 채운다. */
  dek?: string;
  /** 슬라이드 하단 인사이트 문장(밀도·결론 — "So what"). */
  note?: string;
  /** 동반 사진의 장면 설명(LLM 작성, 텍스트 없는 이미지). */
  img?: string;
  /**
   * 레이아웃 아키타입(역할별 허용값) — 미지정이면 덱 안에서 자동 로테이션(연속 동일 금지).
   * structure: columns|bento|split|zigzag · metrics: row|bento|asym · process: timeline|cards · comparison: bars|asym
   */
  layout?: string;
}
export interface DeckContent {
  title: string;
  subtitle?: string;
  mode?: ArtMode;
  /** Style DNA id — LLM 또는 호출부가 지정(styles.ts). */
  styleId?: string;
  slides: SlideContent[]; // 중간 슬라이드(agenda..statement). 커버·클로징은 빌드시 추가.
}

// ── 슬라이드 타입별 빌더 (방향 인지 · 콘텐츠 구동) ──────────────────────

function coverSlide(theme: ModeTheme, total: number, o: Orient, title: string, subtitle?: string, locale: Locale = "ko", opts?: BuildOpts, deckTitle?: string, coverImg?: string): TrexSlide {
  const dna = opts?.dna;
  const port = o === "portrait";
  const sq = o === "square";
  const ink = dna?.coverInk ?? dna?.ink ?? theme.ink;
  const sub = subtitle || (locale === "ko" ? "핵심을 한 줄로 요약하세요." : "Summarize the key idea in one line.");
  const comp = dna?.coverComp ?? "classic";
  const withImg = !!dna && opts?.images !== false;
  const ts = scaleOf(opts, o);
  const coverPrompt = (coverImg || "").trim() || `A striking hero visual for a presentation titled "${deckTitle || title}"`;
  // Z-패턴 우상단 앵커 — 좌상단 킥커(로고 위치)와 짝을 이루는 메타(날짜).
  const meta = new Date().toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", { year: "numeric", month: "short" });

  let blocks: TrexBlock[];
  if (comp === "poster") {
    // 유파 포스터 구도(Z-패턴): 좌상 킥커 → 우상 메타 → 좌하 거대 제목 → 우하 페이지/CTA(푸터).
    const tw = withImg && !port ? 52 : port ? 88 : sq ? 86 : 82;
    const base = ts.display; // 스펙: 맨 앞장 제목 = h1(본문 헤드라인과 동일 단계)
    const tSize = (dna ? fitTitleSpec : fitTitleSize)(title, base);
    blocks = [
      ...(withImg
        ? [imageBlock(port ? { x: 0, y: 0, w: 100, h: 34 } : { x: 60, y: 0, w: 40, h: 100 }, coverPrompt)]
        : []),
      { id: bid(), kind: "kicker", x: 6, y: port ? 38 : 8, w: 50, size: ts.note, text: "T-REX · STUDIO" },
      ...(!port && !withImg ? [{ id: bid(), kind: "kicker" as const, x: 54, y: 8, w: 40, size: ts.note, text: meta, align: "right" as const }] : []),
      { id: bid(), kind: "subtitle", x: 6, y: port ? 44 : 36, w: withImg && !port ? 46 : port ? 80 : sq ? 62 : 46, size: fitSubSize(sub, ts.h2), text: sub },
      { id: bid(), kind: "rule", x: 6, y: port ? 54 : 50, w: port ? 14 : 10, accent: true },
      { id: bid(), kind: "title", x: 6, y: port ? 58 : 54, w: tw, size: tSize, text: title, weight: dna?.titleWeight ?? 800 },
      footer(0, total, ink),
    ];
  } else if (comp === "centered" && withImg && dna?.coverPhoto === "bleed") {
    // 공식① 풀블리드 — 사진이 화면 전체, 다크 스크림 위 밝은 타이포(보그 커버 문법).
    // 이미지 도착 전에도 성립: coverBg가 다크 필드라 밝은 잉크가 항상 읽힌다.
    const tSize = fitTitleSpec(title, ts.display);
    blocks = [
      imageBlock({ x: 0, y: 0, w: 100, h: 100 }, coverPrompt, { scrim: true }),
      { id: bid(), kind: "kicker", x: 10, y: port ? 7 : 8, w: 80, size: ts.note, text: "T-REX · STUDIO", align: "center" },
      { id: bid(), kind: "title", x: 8, y: port ? 36 : 38, w: 84, size: tSize, text: title, weight: dna?.titleWeight ?? 600, align: "center" },
      { id: bid(), kind: "rule", x: 46, y: port ? 62 : 66, w: 8, accent: true },
      { id: bid(), kind: "subtitle", x: port ? 12 : 20, y: port ? 68 : 72, w: port ? 76 : 60, size: fitSubSize(sub, ts.h2), text: sub, align: "center" },
      footer(0, total, ink),
    ];
  } else if (comp === "centered") {
    // 중앙 정렬의 품격(하라 등) — 킥커 · 플레이트 사진(소프트 엣지 페이드) · 제목 · 부제.
    // 컨설팅(챕터 밴드) 덱은 정부 보고서 표지 문법: 제목 상하 헤어라인(중기부 커버).
    const base = ts.display;
    const tSize = (dna ? fitTitleSpec : fitTitleSize)(title, base);
    const fade = dna?.coverPhoto === "plate" ? ("bottom" as const) : undefined;
    const gov = !!dna?.chapterBand && !port && plain(title).length <= 26; // 2줄 제목이면 헤어라인 생략(겹침 방지)
    blocks = [
      { id: bid(), kind: "kicker", x: 10, y: port ? 7 : 8, w: 80, size: ts.note, text: "T-REX · STUDIO", align: "center" },
      ...(withImg
        ? [imageBlock(port ? { x: 14, y: 13, w: 72, h: 30 } : { x: 31, y: 16, w: 38, h: 36 }, coverPrompt, { fade })]
        : [{ id: bid(), kind: "rule" as const, x: 46, y: port ? 22 : 26, w: 8, accent: true }]),
      ...(gov ? [{ id: bid(), kind: "rule" as const, x: 14, y: withImg ? 54 : 32, w: 72, accent: false }] : []),
      { id: bid(), kind: "title", x: 8, y: withImg ? (port ? 48 : 58) : port ? 34 : 36, w: 84, size: tSize, text: title, weight: dna?.titleWeight ?? 600, align: "center" },
      ...(gov ? [{ id: bid(), kind: "rule" as const, x: 14, y: withImg ? 72 : 50, w: 72, accent: true }] : []),
      { id: bid(), kind: "subtitle", x: port ? 12 : 20, y: withImg ? (port ? 72 : 80) : port ? 66 : 68, w: port ? 76 : 60, size: fitSubSize(sub, ts.h2), text: sub, align: "center" },
      footer(0, total, ink),
    ];
  } else if (comp === "banner") {
    // 비녤리 밴드 구도(Z-패턴 변형) — 상단 잉크 밴드 아래 볼드 제목 + 우측 사진 패널.
    const base = ts.display;
    const tSize = (dna ? fitTitleSpec : fitTitleSize)(title, base);
    blocks = [
      ...(withImg
        ? [imageBlock(port ? { x: 6, y: 44, w: 88, h: 34 } : { x: 60, y: 12, w: 34, h: 74 }, coverPrompt)]
        : []),
      { id: bid(), kind: "kicker", x: 6, y: port ? 3.4 : 4.2, w: 70, size: ts.note, text: "T-REX · STUDIO", accent: false },
      ...(!port && !withImg ? [{ id: bid(), kind: "kicker" as const, x: 54, y: 4.2, w: 40, size: ts.note, text: meta, align: "right" as const }] : []),
      { id: bid(), kind: "title", x: 6, y: port ? 14 : 22, w: withImg && !port ? 50 : port ? 88 : 84, size: tSize, text: title, weight: dna?.titleWeight ?? 800 },
      { id: bid(), kind: "rule", x: 6, y: port ? 40 : 60, w: port ? 20 : 14, accent: true },
      { id: bid(), kind: "subtitle", x: 6, y: port ? 82 : 68, w: withImg && !port ? 48 : port ? 84 : 52, size: fitSubSize(sub, ts.h2), text: sub },
      footer(0, total, ink),
    ];
  } else {
    const base = theme.mode === "hybrid" ? (port ? 9.5 : sq ? 7.2 : 6.6) : port ? 8.5 : sq ? 6.5 : 5.4;
    const tSize = (dna ? fitTitleSpec : fitTitleSize)(title, base);
    blocks = [
      { id: bid(), kind: "kicker", x: 6, y: port ? 8 : 12, w: 70, size: port ? 1.7 : 1.4, text: "T-REX · STUDIO" },
      { id: bid(), kind: "rule", x: 6, y: port ? 42 : 40, w: port ? 12 : 9, accent: true },
      { id: bid(), kind: "title", x: 6, y: port ? 46 : 45, w: port ? 88 : sq ? 82 : 74, size: tSize, text: title, weight: 800 },
      { id: bid(), kind: "subtitle", x: 6, y: port ? 74 : 74, w: port ? 84 : sq ? 70 : 54, size: port ? 2 : 1.7, text: sub },
      footer(0, total, theme.ink),
    ];
  }
  return { id: bid(), bg: theme.coverBg, ink, scene: dna ? "none" : theme.coverScene, blocks };
}

/**
 * 본문 슬라이드 헤더 — 타이포 위계의 축(F-패턴: 두괄식 제목을 상단 가로로 길게).
 * 크기는 전부 modular scale 단계(typescale.com)에서 온다 — 감으로 정한 숫자 금지.
 * 세로 리듬은 4% 그리드(8pt 법칙의 슬라이드 등가): pill 8 · 제목 16 · 룰 36 · 콘텐츠 44.
 */
function headerBlocks(theme: ModeTheme, idx: number, total: number, no: string, titleText: string, o: Orient, opts?: BuildOpts, dek?: string, dekW?: number, src?: string): TrexBlock[] {
  const port = o === "portrait";
  const sq = o === "square";
  const ts = scaleOf(opts, o);
  // 데드존 킬: 제목이 1줄(≤26자)이면 제목~콘텐츠 사이 빈 밴드를 dek(스탠드퍼스트)로 채운다.
  // 2줄 제목은 밴드를 제목이 이미 차지 → dek 생략(겹침 방지).
  const showDek = !!dek && !port && plain(titleText).length <= 26;
  // 컨설팅 문법(중기부 업무보고): 킥커 필 대신 네이비 사선 챕터 밴드 + 번호 칩.
  if (opts?.dna?.chapterBand && !port) {
    const roleLabel = (no.split("·")[1] || no).trim();
    return [
      { id: bid(), kind: "band", x: 0, y: 0, w: 100, h: 9, size: ts.note, value: String(idx), text: roleLabel },
      { id: bid(), kind: "title", x: 6, y: 14, w: 84, size: (opts?.dna ? fitTitleSpec : fitTitleSize)(titleText, ts.h1), text: titleText, weight: 800 },
      ...(showDek ? [{ id: bid(), kind: "subtitle" as const, x: 6, y: 25, w: dekW ?? 64, size: ts.h5, text: dek }] : []),
      { id: bid(), kind: "rule", x: 6, y: 36, w: 6, accent: true },
      footer(idx, total, theme.ink, src),
    ];
  }
  return [
    // 좌측 에지 액센트 바 — 전 본문 장 공통의 시스템 요소("한 벌로 설계됨" 신호).
    ...(opts?.dna && !port ? [{ id: bid(), kind: "rule" as const, x: 0, y: 0, w: 1, h: 100, accent: true }] : []),
    { id: bid(), kind: "pill", x: 6, y: 8, w: 30, size: ts.note, text: no },
    { id: bid(), kind: "title", x: 6, y: 16, w: port ? 88 : 84, size: (opts?.dna ? fitTitleSpec : fitTitleSize)(titleText, ts.h1), text: titleText, weight: 800 },
    ...(showDek ? [{ id: bid(), kind: "subtitle" as const, x: 6, y: 26, w: dekW ?? 64, size: ts.h5, text: dek }] : []),
    { id: bid(), kind: "rule", x: 6, y: port ? 32 : 36, w: port ? 9 : 6, accent: true },
    footer(idx, total, theme.ink, src),
  ];
}

function kpiSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko", opts?: BuildOpts): TrexSlide {
  const port = o === "portrait";
  const ts = scaleOf(opts, o);
  // 개수 적응형(2~4). 3열 고정이면 2개는 왼쪽 쏠림·4개는 유실 → 열을 개수에 맞춰 분배.
  const defaults =
    locale === "ko"
      ? [{ value: "—", label: "지표 1" }, { value: "—", label: "지표 2" }, { value: "—", label: "지표 3" }]
      : [{ value: "—", label: "Metric 1" }, { value: "—", label: "Metric 2" }, { value: "—", label: "Metric 3" }];
  const data = (c.kpis && c.kpis.length ? c.kpis : defaults).slice(0, 4);
  const n = data.length;
  const cw = 88 / n - 3; // 가로 열 폭
  // 60-30-10: 지표가 여럿일 땐 값을 잉크색으로 — 전부 액센트면 "주인공"이 사라진다.
  // 단독 지표(히어로)만 액센트를 허용한다. 액센트는 밑줄 바가 담당(10%).
  const hero = n === 1;
  const pillNo = locale === "ko" ? `${idx} · 한눈에` : `${idx} · At A Glance`;
  const title = c.title || (locale === "ko" ? "핵심 지표" : "Key Metrics");
  const head = headerBlocks(theme, idx, total, pillNo, title, o, opts, c.dek, undefined, c.src);
  const layout = !port && opts?.dna ? c.layout || "row" : "row";
  const hasNote = !!c.note;
  const H = hasNote ? 30 : 40; // 콘텐츠 밴드 높이(y44~)

  let kpis: TrexBlock[];
  let noteInHero = false;
  if (layout === "bento" && n === 3) {
    // 벤토 그리드(지표 3개 전용) — 히어로 셀 + 우측 2행. 셀 최소높이(패딩+value+label≈17%h)
    // 제약상 4개 이상은 row로 폴백. note는 짧을 때만 히어로 셀 본문으로 흡수(길면 카드 하단
    // 클리핑으로 문장이 잘려 보인다 → 인사이트 바 유지).
    noteInHero = !!c.note && c.note.length <= 90;
    const BH = noteInHero || !hasNote ? 40 : 30;
    const half = (BH - 3) / 2;
    const cell = (k: KpiItem, r: { x: number; y: number; w: number; h: number }, big: boolean, text?: string): TrexBlock => ({
      // 원포인트 강조: 히어로 셀 값만 액센트, 소셀 값은 잉크(60-30-10 — 숫자 전부 빨강 금지).
      id: bid(), kind: "card" as const, ...r, size: big ? ts.h5 * 1.1 : ts.h5 * 0.95, value: k.value, label: k.label, text: text ?? "", accent: big,
    });
    kpis = [
      cell(data[0], { x: 6, y: 44, w: 43, h: BH }, true, noteInHero ? c.note || "" : ""),
      cell(data[1], { x: 51, y: 44, w: 43, h: half }, false),
      cell(data[2], { x: 51, y: 44 + half + 3, w: 43, h: half }, false),
    ];
  } else if (layout === "asym" && n >= 2) {
    // 비대칭 1:2 — 좌 30% 히어로 지표(이 페이지의 주인공), 우 70% 나머지 지표 행.
    const rest = data.slice(1);
    const step = H / rest.length;
    kpis = [
      { id: bid(), kind: "kpi" as const, x: 6, y: 46, w: 26, size: fitKpiSize(data[0].value, ts.kpi * 1.2), value: data[0].value, label: data[0].label, accent: true },
      ...rest.map((k, i) => ({ id: bid(), kind: "kpi" as const, x: 38, y: 44 + i * step, w: 56, size: fitKpiSize(k.value, Math.min(ts.kpi * 0.7, step * 0.9)), value: k.value, label: k.label, accent: false })),
    ];
  } else {
    // 스탯 콜아웃 행 — 서피스 카드에 담고(플로팅 숫자 금지), 액센트는 첫 지표 하나만(원포인트).
    const surface = !port && !!opts?.dna;
    kpis = data.map((k, i) =>
      port
        ? { id: bid(), kind: "kpi" as const, x: 6, y: (n > 3 ? 34 : 38) + i * (n > 3 ? 11 : n < 3 ? 20 : 15), w: 88, size: fitKpiSize(k.value, ts.kpi * (n > 3 ? 0.9 : 1)), value: k.value, label: k.label, accent: hero }
        : { id: bid(), kind: "kpi" as const, x: 6 + i * (88 / n), y: 44, w: cw, ...(surface ? { h: H, surface: true } : {}), size: fitKpiSize(k.value, Math.min(cw * (o === "square" ? 0.25 : surface ? 0.19 : 0.225), ts.kpi)), value: k.value, label: k.label, accent: hero || (surface && i === 0) },
    );
  }
  return {
    id: bid(),
    bg: theme.bodyBg,
    ink: theme.ink,
    scene: "none",
    blocks: [...head, ...kpis, ...(noteInHero ? [] : insightBlocks(c, o, locale, 88, opts))],
  };
}

function barSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko", opts?: BuildOpts): TrexSlide {
  const ts = scaleOf(opts, o);
  const defaults =
    locale === "ko"
      ? [{ label: "항목 A", value: 82 }, { label: "항목 B", value: 64 }, { label: "항목 C", value: 48 }]
      : [{ label: "Item A", value: 82 }, { label: "Item B", value: 64 }, { label: "Item C", value: 48 }];
  const data = (c.bars && c.bars.length ? c.bars : defaults).slice(0, 4);
  const port = o === "portrait";
  const startY = port ? 40 : 44;
  const step = port ? 10 : 8;
  const pillNo = locale === "ko" ? `${idx} · 비교` : `${idx} · Comparison`;
  const title = c.title || (locale === "ko" ? "어디에 집중할 것인가" : "Where To Focus");
  const layout = !port && opts?.dna ? c.layout || "bars" : "bars";
  // 데이터-잉크 규율(원포인트): 최대값 막대 하나만 액센트, 나머지는 잉크 톤(dna 덱 한정 — 레거시 유지).
  const maxIdx = data.reduce((m, b, i) => (b.value > data[m].value ? i : m), 0);
  const barAccent = (i: number): { accent?: boolean } => (opts?.dna ? { accent: i === maxIdx } : {});
  const body: TrexBlock[] =
    layout === "asym" && data.length >= 2
      ? [
          // 비대칭 1:2 — 좌측에 1위 항목을 히어로 수치로(주인공), 우측에 전체 비교 바.
          { id: bid(), kind: "kpi" as const, x: 6, y: 46, w: 26, size: fitKpiSize(`${data[0].value}%`, ts.kpi * 1.1), value: `${data[0].value}%`, label: data[0].label, accent: true },
          ...data.map((b, i) => ({ id: bid(), kind: "bar" as const, x: 38, y: 44 + i * 8, w: 56, size: ts.h5 * 0.95, label: b.label, value: String(b.value), ...barAccent(i) })),
        ]
      : data.map((b, i) => ({ id: bid(), kind: "bar" as const, x: 6, y: startY + i * step, w: 88, size: ts.h5, label: b.label, value: String(b.value), ...barAccent(i) }));
  return {
    id: bid(),
    bg: theme.bodyBg,
    ink: theme.ink,
    scene: "none",
    blocks: [...headerBlocks(theme, idx, total, pillNo, title, o, opts, c.dek, undefined, c.src), ...body, ...insightBlocks(c, o, locale, 88, opts)],
  };
}

function cardsSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko", opts?: BuildOpts): TrexSlide {
  const port = o === "portrait";
  const ts = scaleOf(opts, o);
  // 개수 적응형(2~4). 고정 3열이면 2개 쏠림·4개 유실 → 열 분배. 좌측 정렬선 x=6 통일(정렬의 법칙).
  const elementLabel = (i: number) => (locale === "ko" ? `요소 ${i + 1}` : `Element ${i + 1}`);
  const defaults =
    locale === "ko"
      ? [{ label: "①", text: "요소 1" }, { label: "②", text: "요소 2" }, { label: "③", text: "요소 3" }]
      : [{ label: "①", text: "Element 1" }, { label: "②", text: "Element 2" }, { label: "③", text: "Element 3" }];
  const data = (c.cards && c.cards.length ? c.cards : defaults).slice(0, 4);
  const n = data.length;
  const hasNote = !!c.note;
  const cardH = hasNote ? 30 : 36;
  // 인포그래픽 도형 패널 — 슬라이드당 1장 생성해 전 카드가 배경으로 공유(텍스트는 HTML 오버레이).
  const panel = !!opts?.dna && opts?.images !== false;
  const pillNo = locale === "ko" ? `${idx} · 구조` : `${idx} · Structure`;
  const title = c.title || (locale === "ko" ? "세 갈래로 나뉜다" : "Three Pillars");
  const withImg = !!opts?.dna && opts?.images !== false;
  let layout = !port && opts?.dna ? c.layout || "columns" : "columns";
  // 컨설팅(챕터 밴드) 문법: 구조는 사진 교차(zigzag/split)가 아니라 패널이 표준 —
  // 칩 라벨이 행 높이를 키워 zigzag에서 이미지와 겹치기도 한다(벤치마크에도 사진 구조 장 없음).
  if (opts?.dna?.chapterBand && (layout === "zigzag" || layout === "split")) layout = "columns";
  const label = (cd: CardItem, i: number) => cd.label || elementLabel(i);

  // ── 2패널(실적→성과): 중기부 업무보고 밀도 — 좌/우 헤더 바 패널 + 조밀 행 + 사이 화살표 ──
  // c.panels가 있으면 그대로, 없어도 컨설팅 구조 슬라이드면 cards를 좌우로 갈라 패널화(고밀도 강제).
  const wantPanels = !port && !!opts?.dna?.chapterBand && (c.panels?.length || (layout === "twopanel"));
  if (wantPanels) {
    const head = headerBlocks(theme, idx, total, pillNo, title, o, opts, c.dek, undefined, c.src);
    const top = c.dek ? 34 : 30;
    const floor = hasNote ? 74 : 86;
    const h = floor - top;
    let specs: PanelSpec[] = c.panels && c.panels.length ? c.panels.slice(0, 2) : [];
    if (specs.length === 0) {
      // 폴백: cards를 2개 그룹으로 갈라 각 카드=한 행(라벨 칩 + 두 문장). 최소 밀도라도 2패널 유지.
      const half = Math.ceil(data.length / 2);
      const mk = (arr: CardItem[]): PanelRow[] => arr.map((cd, i) => ({ label: label(cd, i), text: cd.text }));
      const t1 = locale === "ko" ? "실적" : "What We Did";
      const t2 = locale === "ko" ? "성과" : "Results";
      specs = [{ title: t1, rows: mk(data.slice(0, half)) }, { title: t2, rows: mk(data.slice(half)) }];
    }
    const blocks: TrexBlock[] = [...head];
    const pw = specs.length === 2 ? 43 : 88;
    // ── 오버플로 방어: 행 수·문장 길이에 맞춰 폰트를 실측 축소하고, 그래도 넘치면 말줄임.
    // (한글 글리프 폭 ≈ 1em, 본문 줄간 1.4·부연 1.3 — DeckStage panel 렌더 기준)
    const aspect = opts?.aspect ?? 9 / 16; // h/w
    const rowN = Math.max(1, ...specs.map((sp) => sp.rows.length));
    const headerCqw = ts.h5 * 1.12 * 1.4 + 1.6; // 헤더 바(폰트×줄간+패딩) 대략 높이(cqw)
    const contentCqw = h * aspect - headerCqw - 1.6; // 패널 내부 세로 여유(cqw)
    const slotCqw = contentCqw / rowN; // 행당 세로 예산(cqw)
    const colCqw = pw - 3.4; // 패널 내부 가로 폭(cqw)
    // 5행 이상이면 본문 1줄+부연 1줄로 고정(벤치마크 밀도), 4행 이하는 본문 2줄 허용.
    const textLines = rowN >= 5 ? 1 : 2;
    const rowNeed = (f: number, hasSub: boolean) => textLines * f * 1.4 + (hasSub ? f * 0.86 * 1.3 : 0);
    let font = ts.h5;
    for (const k of [1, 0.92, 0.85, 0.78, 0.72]) {
      font = ts.h5 * k;
      if (rowNeed(font, specs.some((sp) => sp.rows.some((r) => r.sub))) <= slotCqw) break;
    }
    // 칩 라벨이 차지하는 인라인 폭을 뺀 본문 CPL로 말줄임 상한 산출.
    const clampRow = (r: PanelRow): PanelRow => {
      const chipCqw = r.label ? Math.min(plain(r.label).length * font * 0.82 + 2.4, colCqw * 0.5) : 0;
      const cpl = Math.max(6, Math.floor((colCqw - chipCqw) / font));
      const tcap = cpl * textLines;
      const t = plain(r.text);
      const text = t.length <= tcap ? r.text : `${t.slice(0, Math.max(0, tcap - 1)).trimEnd()}…`;
      let sub = r.sub;
      const subCpl = Math.max(6, Math.floor(colCqw / (font * 0.86)));
      if (sub && plain(sub).length > subCpl) sub = `${plain(sub).slice(0, subCpl - 1).trimEnd()}…`;
      return { label: r.label, text, sub };
    };
    specs.forEach((sp, i) => {
      const x = specs.length === 2 ? (i === 0 ? 6 : 51) : 6;
      blocks.push({ id: bid(), kind: "panel", x, y: top, w: pw, h, size: font, label: sp.title, rows: sp.rows.slice(0, 6).map(clampRow), value: String(textLines) });
    });
    // 실적→성과 화살표(두 패널 사이) — 벤치마크의 파란 삼각 커넥터.
    if (specs.length === 2) blocks.push({ id: bid(), kind: "pill", x: 48.5, y: top + h / 2 - 2.5, w: 3, size: ts.h4, text: "▶", accent: true });
    return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...blocks, ...insightBlocks(c, o, locale, 88, opts)] };
  }

  // ── 2분할(하프앤하프): 좌 텍스트 스택 + 우 엣지-투-엣지 이미지 ──
  if (layout === "split" && withImg) {
    const head = headerBlocks(theme, idx, total, pillNo, title, o, opts, c.dek, 42, c.src).map((b) =>
      b.kind === "title" ? { ...b, w: 42 } : b.kind === "footer" ? { ...b, w: 42 } : b,
    );
    const top = 44;
    const bottom = hasNote ? 74 : 86;
    const step = (bottom - top) / n;
    const rows: TrexBlock[] = [imageBlock({ x: 52, y: 0, w: 48, h: 100 }, imgPromptOf(c, title))];
    data.forEach((cd, i) => {
      const y = top + i * step;
      rows.push({ id: bid(), kind: "rule", x: 6, y, w: 40 });
      rows.push({ id: bid(), kind: "body", x: 6, y: y + 1.8, w: 40, size: ts.h5, label: label(cd, i), text: cd.text });
    });
    return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...head, ...rows, ...insightBlocks(c, o, locale, 42, opts)] };
  }

  // ── 벤토 그리드: 첫 카드 히어로 + 작은 셀 맞물림 ──
  if (layout === "bento" && n >= 3) {
    const H = hasNote ? 30 : 38;
    const half = (H - 3) / 2;
    const cell = (cd: CardItem, i: number, r: { x: number; y: number; w: number; h: number }, big: boolean): TrexBlock => ({
      // 작은 셀(h<15%)엔 본문이 물리적으로 안 들어간다(패딩+라벨+2문장≈22%h) → 라벨만(벤토 문법).
      id: bid(), kind: "card" as const, ...r, size: big ? ts.h5 : ts.h5 * 0.85, label: label(cd, i), text: r.h < 15 ? "" : cd.text, ...(panel ? { prompt: "panel", src: "" } : {}),
    });
    const cards =
      n >= 4
        ? [cell(data[0], 0, { x: 6, y: 44, w: 43, h: H }, true), cell(data[1], 1, { x: 51, y: 44, w: 43, h: half }, false), cell(data[2], 2, { x: 51, y: 44 + half + 3, w: 20, h: half }, false), cell(data[3], 3, { x: 74, y: 44 + half + 3, w: 20, h: half }, false)]
        : [cell(data[0], 0, { x: 6, y: 44, w: 43, h: H }, true), cell(data[1], 1, { x: 51, y: 44, w: 43, h: half }, false), cell(data[2], 2, { x: 51, y: 44 + half + 3, w: 43, h: half }, false)];
    return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...headerBlocks(theme, idx, total, pillNo, title, o, opts, c.dek, undefined, c.src), ...cards, ...insightBlocks(c, o, locale, 88, opts)] };
  }

  // ── 지그재그: [이미지|텍스트] 좌우 교차 — 리듬감 ──
  if (layout === "zigzag" && withImg && n <= 3) {
    const top = 42;
    const step = (hasNote ? 33 : 45) / n;
    const rows: TrexBlock[] = [];
    data.forEach((cd, i) => {
      const y = top + i * step;
      const imgLeft = i % 2 === 0;
      rows.push(imageBlock({ x: imgLeft ? 6 : 66, y, w: 28, h: step - 2.5 }, `${cd.label || ""} ${cd.text}`.trim()));
      rows.push({ id: bid(), kind: "body", x: imgLeft ? 38 : 6, y: y + 1, w: 56, size: ts.h5, label: label(cd, i), text: cd.text });
    });
    return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...headerBlocks(theme, idx, total, pillNo, title, o, opts, c.dek, undefined, c.src), ...rows, ...insightBlocks(c, o, locale, 88, opts)] };
  }

  // columns(가로+dna) = 헤더 바 패널(컨설팅 "실적/성과" 문법) — 바가 위계를 만들므로 도형 패널 배경은 생략.
  const cards: TrexBlock[] = data.map((cd, i) =>
    port
      ? { id: bid(), kind: "card" as const, x: 6, y: (n > 3 ? 34 : 38) + i * (n > 3 ? 11 : 13.5), w: 88, h: n > 3 ? 9.5 : 12, size: ts.h5, text: cd.text, label: label(cd, i), ...(panel ? { prompt: "panel", src: "" } : {}) }
      : opts?.dna
        ? { id: bid(), kind: "card" as const, x: 6 + i * (88 / n), y: 44, w: 88 / n - 3, h: cardH, size: n > 3 ? ts.h5 * 0.85 : ts.h5, text: cd.text, label: label(cd, i), bar: true }
        : { id: bid(), kind: "card" as const, x: 6 + i * (88 / n), y: 44, w: 88 / n - 3, h: cardH, size: n > 3 ? ts.h5 * 0.85 : ts.h5, text: cd.text, label: label(cd, i), ...(panel ? { prompt: "panel", src: "" } : {}) },
  );
  return {
    id: bid(),
    bg: theme.bodyBg,
    ink: theme.ink,
    scene: "none",
    blocks: [...headerBlocks(theme, idx, total, pillNo, title, o, opts, c.dek, undefined, c.src), ...cards, ...insightBlocks(c, o, locale, 88, opts)],
  };
}

function calloutSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko", opts?: BuildOpts): TrexSlide {
  const port = o === "portrait";
  const ts = scaleOf(opts, o);
  const headline = locale === "ko" ? "이 한 가지가 결정한다" : "The One Thing That Matters";
  const val = c.stat?.value || "76%";
  const lab = c.stat?.label || c.title || (locale === "ko" ? "핵심 수치" : "The Key Number");
  const note = c.text || c.note || (locale === "ko" ? "이 한 가지가 결정한다." : "This is the one thing that matters most.");
  const withImg = !!opts?.dna && opts?.images !== false;
  // 하이라이트의 히어로 수치가 이 페이지의 "10% 강조색" 주인공(60-30-10) — accent 유지.
  const body: TrexBlock[] = port
    ? [
        ...(withImg ? [imageBlock({ x: 6, y: 38, w: 88, h: 22 }, imgPromptOf(c, lab))] : []),
        { id: bid(), kind: "kpi", x: 6, y: withImg ? 64 : 40, w: 88, size: fitKpiSize(val, withImg ? ts.kpi : ts.kpi * 1.2), value: val, label: lab, accent: true },
        { id: bid(), kind: "subtitle", x: 6, y: withImg ? 82 : 68, w: 88, size: ts.h5, text: note },
      ]
    : withImg
      ? [
          { id: bid(), kind: "kpi", x: 6, y: 46, w: 30, size: fitKpiSize(val, ts.kpi), value: val, label: lab, accent: true },
          { id: bid(), kind: "subtitle", x: 38, y: 48, w: 25, size: ts.h5, text: note },
          imageBlock({ x: 66, y: 44, w: 28, h: 42 }, imgPromptOf(c, lab)),
        ]
      : [
          { id: bid(), kind: "kpi", x: 6, y: 48, w: 40, size: fitKpiSize(val, ts.kpi * 1.2), value: val, label: lab, accent: true },
          { id: bid(), kind: "subtitle", x: 52, y: 54, w: 42, size: ts.h5, text: note },
        ];
  const pillNo = locale === "ko" ? `${idx} · 핵심` : `${idx} · Highlight`;
  return {
    id: bid(),
    bg: theme.bodyBg,
    ink: theme.ink,
    scene: "none",
    blocks: [...headerBlocks(theme, idx, total, pillNo, c.title || headline, o, opts, c.dek, undefined, c.src), ...body, ...(c.text && c.note && c.note !== note ? insightBlocks(c, o, locale, withImg && !port ? 56 : 88, opts) : [])],
  };
}

// "감사합니다" 클로징 장표는 폐기(2026-07-02, 사용자 결정) — 정보 밀도 0인 낭비 장표.
// 덱은 마지막 statement(핵심 메시지)로 닫는다(pickRoles가 마지막 역할을 statement로 강제).

// ── 목차 / 과정 / 핵심메시지 레이아웃 (연구: 6대 표준 레이아웃) ──────────

function agendaSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko", opts?: BuildOpts): TrexSlide {
  const port = o === "portrait";
  const ts = scaleOf(opts, o);
  const defaultItems = locale === "ko" ? ["항목 1", "항목 2", "항목 3"] : ["Item 1", "Item 2", "Item 3"];
  const items = (c.items && c.items.length ? c.items : defaultItems).slice(0, 6);
  const n = items.length;
  // 헤더의 뜬 밑줄(rule)은 제거 — 죽은 공간의 주범. 대신 각 행 위 구분선으로 리듬을 준다.
  const pillNo = locale === "ko" ? `${idx} · 목차` : `${idx} · Agenda`;
  const title = c.title || (locale === "ko" ? "이 발표의 흐름" : "What We'll Cover");
  const head = headerBlocks(theme, idx, total, pillNo, title, o, opts).filter((b) => b.kind !== "rule" || b.h); // 가로 룰만 제거(세로 에지 바는 유지)
  const top = port ? 34 : 36;
  const bottom = port ? 90 : 88;
  const step = (bottom - top) / n;
  const size = n >= 5 ? ts.h4 * 0.9 : ts.h4; // 문단(행) 제목 = h4
  // 우측 이미지 레일 — 행이 짧아 우측 1/3이 죽는 목차의 고질을 사진으로 채운다(덩그라니 금지).
  const rail = !!opts?.dna && opts?.images !== false && !port && n <= 5;
  const rowW = rail ? 53 : 88;
  const rows: TrexBlock[] = rail ? [imageBlock({ x: 64, y: top, w: 30, h: bottom - top }, imgPromptOf(c, title))] : [];
  items.forEach((raw, i) => {
    // "제목 — 한 줄 설명" 분해 → 2줄 행. 근접성의 법칙: 제목-설명(그룹 내)은 붙이고,
    // 다음 행(그룹 간)과는 넓게 — within(0.36·step) < between(0.52·step).
    const m = raw.split(/\s+[—–-]\s+|:\s+/);
    const t = (m[0] || raw).trim();
    const desc = m.length > 1 ? m.slice(1).join(" ").trim() : "";
    const y = top + i * step;
    rows.push({ id: bid(), kind: "rule", x: 6, y, w: rowW }); // 행 위 얇은 구분선(비강조)
    rows.push({ id: bid(), kind: "body", x: 6, y: y + step * 0.1, w: rowW, size, label: `0${i + 1}`, text: t, inline: true });
    // 제목 텍스트의 실제 세로 점유(cqw→높이%: 16:9에서 ×1.78) 아래에 설명을 놓아야 겹치지 않는다.
    // step<10(행 5개 이상, 세로형 제외)이면 설명 생략 — 겹칠 바엔 제목만.
    if (desc && (port ? step >= 8 : step >= 10)) {
      const titleH = size * (port ? 1 : 1.78) * 1.35; // 폰트 cqw → 슬라이드 높이% (+행간)
      rows.push({ id: bid(), kind: "subtitle", x: port ? 12 : 11.4, y: y + step * 0.1 + titleH, w: port ? 82 : rail ? 47.6 : 82.6, size: ts.h5, text: desc });
    }
  });
  return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...head, ...rows] };
}

function processSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko", opts?: BuildOpts): TrexSlide {
  const port = o === "portrait";
  const ts = scaleOf(opts, o);
  const stepText = (i: number) => (locale === "ko" ? `단계 ${i + 1}` : `Step ${i + 1}`);
  const defaults =
    locale === "ko"
      ? [{ label: "STEP 1", text: "단계 1" }, { label: "STEP 2", text: "단계 2" }, { label: "STEP 3", text: "단계 3" }]
      : [{ label: "STEP 1", text: "Step 1" }, { label: "STEP 2", text: "Step 2" }, { label: "STEP 3", text: "Step 3" }];
  const data = (c.steps && c.steps.length ? c.steps : defaults).slice(0, 4);
  // "1단계: …" / "STEP 1 …" 접두어는 번호 뱃지와 중복 → 헤딩에서 제거
  const heading = (raw: string | undefined, i: number) => {
    const s = (raw || stepText(i)).replace(/^\s*\d+\s*단계\s*[:：·.\-]?\s*/, "").replace(/^\s*step\s*\d+\s*[:：·.\-]?\s*/i, "").trim();
    return s || stepText(i);
  };
  const num = (i: number) => `0${i + 1}`;
  const n = data.length;
  const hasNote = !!c.note;
  const panel = !!opts?.dna && opts?.images !== false;
  const pillNo = locale === "ko" ? `${idx} · 과정` : `${idx} · Process`;
  const title = c.title || (locale === "ko" ? "이렇게 진행된다" : "How This Unfolds");
  const layout = !port && opts?.dna ? c.layout || "timeline" : "cards";

  // ── 타임라인(로드맵 레일): 컬럼 상단 번호 칩 → 단계명 → 본문, 컬럼 사이 세로 헤어라인.
  // 번호를 텍스트 아래(라인 위)에 두는 교차 배치는 텍스트 높이 예측 불가로 겹침 사고의 근원 —
  // 번호를 맨 위로 올리면 아래로는 인사이트 바까지 전부 텍스트 예산이라 충돌이 구조적으로 없다.
  if (layout === "timeline") {
    const segW = 88 / n;
    const colW = segW - 4; // 본문 컬럼 폭(cqw)
    const chipY = 42;
    const textY = 48.5;
    const floorY = hasNote ? 74 : 86; // 인사이트 룰(76) 또는 푸터 위 안전선
    // 겹침 방지: 본문 가용 높이를 실측 추정해 폰트를 줄이고, 그래도 넘치면 문장을 잘라낸다.
    // (한글 글리프 폭 ≈ 1em, 줄간 1.5 — DeckStage 렌더 기준)
    const aspect = opts?.aspect ?? 9 / 16; // h/w — timeline은 가로형 전용
    const availCqw = (floorY - textY) * aspect; // %h → cqw
    const labelCqw = (lbl: string) => Math.ceil(lbl.length / Math.max(1, Math.floor(colW / 1.55))) * 1.5 * 1.35 + 0.5;
    const needCqw = (st: CardItem, i: number, f: number) => {
      const cpl = Math.max(1, Math.floor(colW / f));
      return labelCqw(heading(st.label, i)) + Math.ceil(plain(st.text).length / cpl) * f * 1.5;
    };
    let font = ts.h5 * 0.92;
    for (const k of [1, 0.92, 0.85, 0.78]) {
      font = ts.h5 * 0.92 * k;
      if (Math.max(...data.map((st, i) => needCqw(st, i, font))) <= availCqw) break;
    }
    const clamp = (st: CardItem, i: number) => {
      const cpl = Math.max(1, Math.floor(colW / font));
      const maxLines = Math.max(1, Math.floor((availCqw - labelCqw(heading(st.label, i))) / (font * 1.5)));
      const cap = maxLines * cpl;
      const t = plain(st.text);
      return t.length <= cap ? st.text || "" : `${t.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
    };
    const rows: TrexBlock[] = [];
    const chipMerge = !!opts?.dna?.listChip; // 컨설팅: 번호를 칩 라벨에 합쳐 이중 뱃지 방지
    data.forEach((st, i) => {
      const x = 6 + i * segW;
      // 컬럼 사이 세로 헤어라인(매거진 컬럼 문법) — 첫 컬럼 앞엔 없음.
      if (i > 0) rows.push({ id: bid(), kind: "rule", x: x - 2.2, y: chipY, w: 1, h: floorY - chipY, accent: false });
      if (!chipMerge) rows.push({ id: bid(), kind: "pill", x, y: chipY, w: 8, size: ts.note, text: num(i) });
      rows.push({ id: bid(), kind: "body", x, y: chipMerge ? chipY + 0.5 : textY, w: colW, size: font, label: chipMerge ? `${num(i)} · ${heading(st.label, i)}` : heading(st.label, i), text: clamp(st, i) });
    });
    return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...headerBlocks(theme, idx, total, pillNo, title, o, opts, c.dek, undefined, c.src), ...rows, ...insightBlocks(c, o, locale, 88, opts)] };
  }

  const steps: TrexBlock[] = data.map((s, i) =>
    port
      ? { id: bid(), kind: "card" as const, x: 6, y: 38 + i * (n > 3 ? 11 : 13.5), w: 88, h: n > 3 ? 9.5 : 12, size: ts.h5, value: num(i), label: heading(s.label, i), text: s.text, ...(panel ? { prompt: "panel", src: "" } : {}) }
      : { id: bid(), kind: "card" as const, x: 6 + i * (88 / n), y: 44, w: 88 / n - 3, h: hasNote ? 30 : 36, size: n > 3 ? ts.h5 * 0.85 : ts.h5, value: num(i), label: heading(s.label, i), text: s.text, ...(panel ? { prompt: "panel", src: "" } : {}) },
  );
  return {
    id: bid(),
    bg: theme.bodyBg,
    ink: theme.ink,
    scene: "none",
    blocks: [...headerBlocks(theme, idx, total, pillNo, title, o, opts, c.dek, undefined, c.src), ...steps, ...insightBlocks(c, o, locale, 88, opts)],
  };
}

/** 핵심 메시지 — 한 슬라이드 한 아이디어(연구: one idea per slide). 다크 전환 슬라이드. */
function statementSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko", opts?: BuildOpts): TrexSlide {
  const dna = opts?.dna;
  const port = o === "portrait";
  // closeBg가 어두운 모드(editorial)만 흰 글자로 뒤집는다. diagrammatic의 closeBg는
  // 밝은색(#F2F7F5)이라 흰 글자를 쓰면 안 보인다 → theme.ink(어두운색) 유지.
  const light = theme.mode === "editorial";
  const ink = dna ? (dna.closeInk ?? dna.ink) : light ? "#ffffff" : theme.ink;
  const msg = c.text || c.title || (locale === "ko" ? "핵심 메시지" : "The Key Message");
  const kickerText = locale === "ko" ? `${idx} · 핵심 메시지` : `${idx} · Key Message`;
  const withImg = !!dna && opts?.images !== false;
  const ts = scaleOf(opts, o);
  const tw = withImg && !port ? 46 : port ? 88 : 82;
  return {
    id: bid(),
    bg: theme.closeBg,
    ink,
    scene: "none",
    blocks: [
      ...(withImg ? [imageBlock(port ? { x: 6, y: 58, w: 88, h: 26 } : { x: 56, y: 14, w: 38, h: 62 }, imgPromptOf(c, msg))] : []),
      // 키커는 accent 색 대신 ink(muted)로 — editorial의 진한 빨강 액센트는 다크 배경에서 저대비.
      { id: bid(), kind: "kicker", x: 6, y: port ? 12 : 16, w: 50, size: ts.note, text: kickerText },
      { id: bid(), kind: "title", x: 6, y: port ? 22 : 28, w: tw, size: (dna ? fitTitleSpec : fitTitleSize)(msg, ts.display), text: msg, weight: dna?.titleWeight ?? 800 },
      { id: bid(), kind: "rule", x: 6, y: port ? 48 : 60, w: 10, accent: true },
      ...(c.note
        ? [{ id: bid(), kind: "subtitle" as const, x: 6, y: port ? 51 : 64, w: withImg && !port ? 44 : port ? 88 : 60, size: ts.h5, text: c.note }]
        : []),
      footer(idx, total, ink),
    ],
  };
}

// ── 역할 기반 레이아웃 레지스트리 (연구: 내용 타입별 스마트 레이아웃) ──────
export type SlideRole = "agenda" | "metrics" | "comparison" | "structure" | "process" | "highlight" | "statement";
const LAYOUTS: Record<SlideRole, (t: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale?: Locale, opts?: BuildOpts) => TrexSlide> = {
  agenda: agendaSlide,
  metrics: kpiSlide,
  comparison: barSlide,
  structure: cardsSlide,
  process: processSlide,
  highlight: calloutSlide,
  statement: statementSlide,
};

/**
 * 슬라이드 개수 → 내러티브 아크(역할 순서). 6장 이상이면 목차로 시작.
 * 클로징("감사합니다") 장표는 없다 — 마지막은 statement(핵심 메시지)로 강제해 강하게 닫는다.
 */
function pickRoles(total: number): SlideRole[] {
  const middle = Math.max(1, total - 1); // 커버만 제외
  const arc: SlideRole[] = [];
  if (total >= 6) arc.push("agenda");
  const rotation: SlideRole[] = ["metrics", "structure", "comparison", "process", "highlight", "statement"];
  let ri = 0;
  while (arc.length < middle) arc.push(rotation[ri++ % rotation.length]);
  const roles = arc.slice(0, middle);
  if (roles.length >= 2) roles[roles.length - 1] = "statement";
  return roles;
}

/** 역할별 스캐폴드 콘텐츠(프롬프트 파생 · LLM 미사용 시 폴백). */
function scaffoldContent(role: SlideRole, i: number, pts: string[], locale: Locale = "ko"): SlideContent {
  const p3 = pts.slice(i, i + 3).length >= 3 ? pts.slice(i, i + 3) : pts.slice(0, 3);
  const ko = locale === "ko";
  const noteOf = (t: string) =>
    ko ? `${t} — 이 항목이 다음 분기의 우선순위를 결정한다.` : `${t} — this determines next quarter's priority.`;
  switch (role) {
    case "agenda":
      return {
        role,
        title: ko ? "이 발표의 흐름" : "What We'll Cover",
        items: pts.slice(0, 4).map((t) => (ko ? `${t} — 현황과 시사점을 짚는다` : `${t} — status and implications`)),
      };
    case "metrics":
      return {
        role,
        title: ko ? "핵심 지표" : "Key Metrics",
        kpis: [{ value: ko ? "2.4조" : "$2.4T", label: p3[0] }, { value: "47%", label: p3[1] }, { value: "8.5x", label: p3[2] }],
        note: noteOf(p3[0]),
      };
    case "comparison":
      return { role, title: ko ? "어디에 집중할 것인가" : "Where To Focus", bars: [{ label: p3[0], value: 82 }, { label: p3[1], value: 64 }, { label: p3[2], value: 48 }], note: noteOf(p3[0]) };
    case "structure":
      return { role, title: ko ? "세 갈래로 나뉜다" : "Three Pillars", cards: p3.map((t, j) => ({ label: ["①", "②", "③"][j], text: t })), note: noteOf(p3[1]) };
    case "process":
      return { role, title: ko ? "이렇게 진행된다" : "How This Unfolds", steps: p3.map((t, j) => ({ label: `STEP ${j + 1}`, text: t })), note: noteOf(p3[2]) };
    case "highlight":
      return { role, title: ko ? "이 한 가지가 결정한다" : "The One Thing That Matters", stat: { value: "76%", label: p3[0] }, text: p3[1] };
    case "statement":
      return { role, text: p3[0], note: p3[1] };
  }
}

/** 콘텐츠(LLM 또는 스캐폴드) → 위치 기반 블록 덱. 커버·클로징 자동 추가, footer 번호 동기화. */
export function buildDeckFromContent(content: DeckContent, formatArg?: string, locale: Locale = "ko", styleArg?: string | null, imagesArg = true): TrexDeck {
  const mode: ArtMode = content.mode && MODE_THEMES[content.mode] ? content.mode : "editorial";
  // styleArg: string=명시 스타일, null=명시적 "기본 룩"(LLM styleId도 무시), undefined=콘텐츠에 위임.
  const dna = styleArg === null ? null : styleById(styleArg ?? content.styleId);
  const fmt = formatById(formatArg);
  const opts: BuildOpts = { dna, images: imagesArg, aspect: fmt.h / fmt.w };
  // Style DNA가 있으면 팔레트/배경을 유파 것으로 덮는다 — 레이아웃 빌더는 동일하게 재사용.
  const theme: ModeTheme = dna
    ? { ...MODE_THEMES[mode], accent: dna.accent, ink: dna.ink, coverBg: dna.coverBg, bodyBg: dna.bodyBg, closeBg: dna.closeBg, coverScene: "none", closeScene: "none" }
    : MODE_THEMES[mode];
  const o = orientationOf(formatById(formatArg));
  const title = cleanTitle(content.title || "", locale);
  const mids = (content.slides || []).filter((s): s is SlideContent => !!s && (s.role in LAYOUTS));
  const total = mids.length + 1; // 커버 + 본문. 클로징("감사합니다") 장표는 폐기.

  // 레이아웃 아키타입 로테이션 — LLM이 layout을 안 정했으면 덱 안에서 역할별 변형을 순환시켜
  // "매 장이 같은 3분할" 문제를 없앤다(전역 mid 인덱스로 섞어 한 덱 안에서 다양하게).
  const LAYOUT_ROTATION: Record<string, string[]> = {
    structure: imagesArg && dna ? ["columns", "bento", "split", "zigzag"] : ["columns", "bento"],
    metrics: ["row", "bento", "asym"],
    process: ["timeline", "cards"],
    comparison: ["bars", "asym"],
  };
  // 입력 객체를 mutate하지 않는다 — 같은 content로 여러 덱을 빌드해도(갤러리/재생성)
  // 로테이션이 눌러붙지 않게 복사본에 layout을 부여한다.
  const midsL = mids.map((m, i) => {
    if (m.layout) return m;
    const options = LAYOUT_ROTATION[m.role];
    return options ? { ...m, layout: options[i % options.length] } : m;
  });

  // 커버 이미지 장면: 첫 슬라이드의 img를 쓰거나 덱 제목에서 유도(LLM이 coverImg를 따로 주지 않으므로).
  const coverImg = (content.slides || []).map((s) => s?.img).find((v) => !!v);
  const slides: TrexSlide[] = [coverSlide(theme, total, o, title, content.subtitle, locale, opts, title, coverImg)];
  midsL.forEach((c, i) => slides.push(LAYOUTS[c.role](theme, i + 1, total, c, o, locale, opts)));
  slides.forEach((s, i) => {
    const f = s.blocks.find((b) => b.kind === "footer");
    if (f) f.value = `${i + 1 < 10 ? "0" : ""}${i + 1} / ${total < 10 ? "0" : ""}${total}`;
    if (dna) {
      // 장식 모티프 — 커버/본문/클로징별 DNA 데코 + 인덱스 텍스트(스위스 거대 번호 등).
      const v = i === 0 ? "cover" : i === slides.length - 1 ? "close" : "body";
      s.deco = v === "cover" ? dna.coverDeco : v === "close" ? dna.closeDeco : dna.bodyDeco;
      s.decoV = v;
      s.decoN = `${i + 1 < 10 ? "0" : ""}${i + 1}`;
    }
  });

  return {
    id: `deck_${Date.now().toString(36)}`,
    title,
    prompt: content.title || title,
    mode,
    ...(dna ? { styleId: dna.id } : {}),
    accent: dna?.accent ?? theme.accent,
    formatId: formatArg ?? DEFAULT_FORMAT_ID,
    createdAt: Date.now(),
    slides,
  };
}

/** LLM 출력(JSON 텍스트, 마크다운 펜스 허용) → DeckContent. 실패 시 null → 스캐폴드로 폴백. */
export function parseDeckContent(raw: string): DeckContent | null {
  try {
    let t = (raw || "").trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (m) t = m[0];
    const d = JSON.parse(t) as DeckContent;
    if (!d || typeof d.title !== "string" || !Array.isArray(d.slides) || d.slides.length === 0) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * 결정적 생성기 — 프롬프트 파생 스캐폴드 콘텐츠로 덱을 만든다(LLM 미사용/폴백).
 * 역할 기반 아크 + 방향 인지. LLM 경로는 buildDeckFromContent로 동일 레이아웃을 쓴다.
 */
export function generateDeck(prompt: string, modeArg?: ArtMode, countArg?: number, formatArg?: string, locale: Locale = "ko", styleArg?: string | null, imagesArg = true): TrexDeck {
  const mode = modeArg ?? routeMode(prompt);
  const total = clampCount(countArg ?? 5);
  const pts = derivePoints(prompt, Math.max(6, total), locale);
  const roles = pickRoles(total);
  const content: DeckContent = {
    title: cleanTitle(prompt, locale),
    subtitle:
      locale === "ko"
        ? "한 줄 프롬프트에서 시작한 덱 — 클릭해서 바로 편집할 수 있습니다."
        : "Built from a single prompt — click any block to start editing.",
    mode,
    slides: roles.map((role, i) => scaffoldContent(role, i, pts, locale)),
  };
  return buildDeckFromContent(content, formatArg, locale, styleArg, imagesArg);
}

/** 빈 블록 1개 — 편집기 "블록 추가" 팔레트용. 매번 살짝 어긋나게 스폰해 겹침을 피한다. */
export function newBlock(kind: BlockKind, locale: Locale = "ko"): TrexBlock {
  const id = bid();
  const j = _seq % 6;
  const ko = locale === "ko";
  const base: TrexBlock = { id, kind, x: 12 + j * 5, y: 28 + j * 7, w: 40, size: 2, align: "left" };
  switch (kind) {
    case "title":
      return { ...base, text: ko ? "새 제목" : "New Title", size: 3.4, weight: 800 };
    case "kicker":
      return { ...base, text: "LABEL", size: 1.4 };
    case "subtitle":
      return { ...base, text: ko ? "보조 설명을 입력하세요" : "Add a supporting subtitle", size: 1.6 };
    case "body":
      return { ...base, text: ko ? "본문 텍스트" : "Body text", size: 1.5 };
    case "pill":
      return { ...base, text: ko ? "태그" : "Tag", w: 18, size: 1.2 };
    case "rule":
      return { ...base, w: 8, accent: true };
    case "kpi":
      return { ...base, value: "42%", label: ko ? "지표 설명" : "Metric label", size: 6, w: 26, accent: true };
    case "bar":
      return { ...base, label: ko ? "항목" : "Item", value: "60", w: 80, size: 1.3 };
    case "card":
      return { ...base, label: ko ? "카드 제목" : "Card title", text: ko ? "카드 설명을 입력하세요" : "Add a card description", w: 26, h: 34, size: 1.45 };
    case "image":
      return { ...base, w: 30, h: 36, src: "", prompt: "" };
    case "footer":
      return { ...base, text: "Agentlas · T-rex", value: "01 / 05", w: 88, size: 1.05, x: 6, y: 90 };
    default:
      return base;
  }
}
