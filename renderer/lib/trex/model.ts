// T-rex 슬라이드 모델 — 편집기가 다루는 "위치 기반 블록" JSON이 진실의 원천.
// 렌더러(DeckStage)는 이 모델을 16:9 무대에 그리고, 편집기는 이 모델을 직접 수정한다.
// 아트디렉션 라우터(목적→모드)는 PPT 에이전트 연구 결과를 옮긴 것:
//   cinematic(서사) / editorial(비즈니스·사진0) / diagrammatic(학술) / hybrid(스포츠·데이터).
//
// 로케일: 콘텐츠가 없을 때(스캐폴드/미완성 LLM 응답) 채우는 폴백·플레이스홀더 텍스트는
// 전부 locale 인자를 받는다(기본값 "ko" — 미갱신 호출부의 기존 동작 보존). "en"이면 자연스러운
// 영어 카피로 대체한다(직역이 아님). 프롬프트 분류용 정규식(MODE_HINTS 등)은 로케일과 무관.

import type { Locale } from "@/lib/i18n";

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

export type BlockKind = "kicker" | "title" | "subtitle" | "body" | "rule" | "pill" | "kpi" | "bar" | "footer" | "card";

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
  inline?: boolean; // body: 번호(label)+텍스트를 한 줄에(목차 등)
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
  blocks: TrexBlock[];
}

export interface TrexDeck {
  id: string;
  title: string;
  prompt: string;
  mode: ArtMode;
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
  const n = text.length;
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

function footer(idx: number, total: number, ink: string): TrexBlock {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return { id: bid(), kind: "footer", x: 6, y: 90, w: 88, size: 1.05, text: "Agentlas · T-rex", value: `${pad(idx + 1)} / ${pad(total)}` };
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
export interface SlideContent {
  role: SlideRole;
  title?: string;
  items?: string[];
  kpis?: KpiItem[];
  bars?: BarItem[];
  cards?: CardItem[];
  steps?: CardItem[];
  stat?: KpiItem;
  text?: string;
}
export interface DeckContent {
  title: string;
  subtitle?: string;
  mode?: ArtMode;
  slides: SlideContent[]; // 중간 슬라이드(agenda..statement). 커버·클로징은 빌드시 추가.
}

// ── 슬라이드 타입별 빌더 (방향 인지 · 콘텐츠 구동) ──────────────────────

function coverSlide(theme: ModeTheme, total: number, o: Orient, title: string, subtitle?: string, locale: Locale = "ko"): TrexSlide {
  const port = o === "portrait";
  const sq = o === "square";
  const base = theme.mode === "hybrid" ? (port ? 9.5 : sq ? 7.2 : 6.6) : port ? 8.5 : sq ? 6.5 : 5.4;
  const tSize = fitTitleSize(title, base);
  return {
    id: bid(),
    bg: theme.coverBg,
    ink: theme.ink,
    scene: theme.coverScene,
    blocks: [
      { id: bid(), kind: "kicker", x: 6, y: port ? 8 : 12, w: 70, size: port ? 1.7 : 1.4, text: "T-REX · STUDIO" },
      { id: bid(), kind: "rule", x: 6, y: port ? 42 : 40, w: port ? 12 : 9, accent: true },
      { id: bid(), kind: "title", x: 6, y: port ? 46 : 45, w: port ? 88 : sq ? 82 : 74, size: tSize, text: title, weight: 800 },
      {
        id: bid(),
        kind: "subtitle",
        x: 6,
        y: port ? 74 : 74,
        w: port ? 84 : sq ? 70 : 54,
        size: port ? 2 : 1.7,
        text: subtitle || (locale === "ko" ? "핵심을 한 줄로 요약하세요." : "Summarize the key idea in one line."),
      },
      footer(0, total, theme.ink),
    ],
  };
}

function headerBlocks(theme: ModeTheme, idx: number, total: number, no: string, titleText: string, o: Orient): TrexBlock[] {
  const port = o === "portrait";
  const sq = o === "square";
  return [
    { id: bid(), kind: "pill", x: 6, y: port ? 9 : 11, w: 30, size: port ? 1.5 : 1.2, text: no },
    { id: bid(), kind: "title", x: 6, y: port ? 18 : 20, w: port ? 90 : 78, size: fitTitleSize(titleText, port ? 4.6 : sq ? 3.8 : 3.1), text: titleText, weight: 800 },
    { id: bid(), kind: "rule", x: 6, y: port ? 32 : 35, w: port ? 9 : 6, accent: true },
    footer(idx, total, theme.ink),
  ];
}

function kpiSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko"): TrexSlide {
  const port = o === "portrait";
  // 개수 적응형(2~4). 3열 고정이면 2개는 왼쪽 쏠림·4개는 유실 → 열을 개수에 맞춰 분배.
  const defaults =
    locale === "ko"
      ? [{ value: "—", label: "지표 1" }, { value: "—", label: "지표 2" }, { value: "—", label: "지표 3" }]
      : [{ value: "—", label: "Metric 1" }, { value: "—", label: "Metric 2" }, { value: "—", label: "Metric 3" }];
  const data = (c.kpis && c.kpis.length ? c.kpis : defaults).slice(0, 4);
  const n = data.length;
  const cw = 88 / n - 3; // 가로 열 폭
  const kpis: TrexBlock[] = data.map((k, i) =>
    port
      ? { id: bid(), kind: "kpi" as const, x: 8, y: (n > 3 ? 36 : 40) + i * (n > 3 ? 14 : n < 3 ? 22 : 18), w: 84, size: fitKpiSize(k.value, n > 3 ? 6.8 : 8.5), value: k.value, label: k.label, accent: true }
      : { id: bid(), kind: "kpi" as const, x: 6 + i * (88 / n), y: 50, w: cw, size: fitKpiSize(k.value, cw * (o === "square" ? 0.24 : 0.21)), value: k.value, label: k.label, accent: true },
  );
  const pillNo = locale === "ko" ? `${idx} · 한눈에` : `${idx} · At A Glance`;
  const title = c.title || (locale === "ko" ? "핵심 지표" : "Key Metrics");
  return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...headerBlocks(theme, idx, total, pillNo, title, o), ...kpis] };
}

function barSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko"): TrexSlide {
  const defaults =
    locale === "ko"
      ? [{ label: "항목 A", value: 82 }, { label: "항목 B", value: 64 }, { label: "항목 C", value: 48 }]
      : [{ label: "Item A", value: 82 }, { label: "Item B", value: 64 }, { label: "Item C", value: 48 }];
  const data = (c.bars && c.bars.length ? c.bars : defaults).slice(0, 4);
  const port = o === "portrait";
  const startY = port ? 42 : 47;
  const step = port ? 12 : 10;
  const pillNo = locale === "ko" ? `${idx} · 비교` : `${idx} · Comparison`;
  const title = c.title || (locale === "ko" ? "어디에 집중할 것인가" : "Where To Focus");
  return {
    id: bid(),
    bg: theme.bodyBg,
    ink: theme.ink,
    scene: "none",
    blocks: [
      ...headerBlocks(theme, idx, total, pillNo, title, o),
      ...data.map((b, i) => ({ id: bid(), kind: "bar" as const, x: 6, y: startY + i * step, w: 88, size: port ? 1.7 : 1.3, label: b.label, value: String(b.value) })),
    ],
  };
}

function cardsSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko"): TrexSlide {
  const port = o === "portrait";
  // 개수 적응형(2~4). 고정 3열이면 2개 쏠림·4개 유실 → 열 분배.
  const elementLabel = (i: number) => (locale === "ko" ? `요소 ${i + 1}` : `Element ${i + 1}`);
  const defaults =
    locale === "ko"
      ? [{ label: "①", text: "요소 1" }, { label: "②", text: "요소 2" }, { label: "③", text: "요소 3" }]
      : [{ label: "①", text: "Element 1" }, { label: "②", text: "Element 2" }, { label: "③", text: "Element 3" }];
  const data = (c.cards && c.cards.length ? c.cards : defaults).slice(0, 4);
  const n = data.length;
  const cards: TrexBlock[] = data.map((cd, i) =>
    port
      ? { id: bid(), kind: "card" as const, x: 8, y: (n > 3 ? 35 : 40) + i * (n > 3 ? 13 : 17), w: 84, h: n > 3 ? 11 : 15, size: 1.7, text: cd.text, label: cd.label || elementLabel(i) }
      : { id: bid(), kind: "card" as const, x: 6 + i * (88 / n), y: 46, w: 88 / n - 3, h: 37, size: n > 3 ? 1.25 : 1.45, text: cd.text, label: cd.label || elementLabel(i) },
  );
  const pillNo = locale === "ko" ? `${idx} · 구조` : `${idx} · Structure`;
  const title = c.title || (locale === "ko" ? "세 갈래로 나뉜다" : "Three Pillars");
  return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...headerBlocks(theme, idx, total, pillNo, title, o), ...cards] };
}

function calloutSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko"): TrexSlide {
  const port = o === "portrait";
  const headline = locale === "ko" ? "이 한 가지가 결정한다" : "The One Thing That Matters";
  const val = c.stat?.value || "76%";
  const lab = c.stat?.label || c.title || (locale === "ko" ? "핵심 수치" : "The Key Number");
  const note = c.text || (locale === "ko" ? "이 한 가지가 결정한다." : "This is the one thing that matters most.");
  const body: TrexBlock[] = port
    ? [
        { id: bid(), kind: "kpi", x: 8, y: 40, w: 84, size: fitKpiSize(val, 16), value: val, label: lab, accent: true },
        { id: bid(), kind: "subtitle", x: 8, y: 68, w: 84, size: 2.2, text: note },
      ]
    : [
        { id: bid(), kind: "kpi", x: 7, y: 50, w: 40, size: fitKpiSize(val, o === "square" ? 11 : 9), value: val, label: lab, accent: true },
        { id: bid(), kind: "subtitle", x: 52, y: 56, w: 42, size: 1.7, text: note },
      ];
  const pillNo = locale === "ko" ? `${idx} · 핵심` : `${idx} · Highlight`;
  return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...headerBlocks(theme, idx, total, pillNo, c.title || headline, o), ...body] };
}

function closeSlide(theme: ModeTheme, total: number, o: Orient, title?: string, subtitle?: string, locale: Locale = "ko"): TrexSlide {
  const light = theme.mode === "editorial";
  const port = o === "portrait";
  const kickerText = locale === "ko" ? "맺음말" : "Closing";
  const titleText = title || (locale === "ko" ? "감사합니다" : "Thank You");
  const subtitleText = subtitle || (locale === "ko" ? "질문과 논의를 환영합니다." : "Questions and discussion are welcome.");
  return {
    id: bid(),
    bg: theme.closeBg,
    ink: light ? "#ffffff" : theme.ink,
    scene: theme.closeScene,
    blocks: [
      { id: bid(), kind: "kicker", x: 6, y: port ? 12 : 16, w: 60, size: port ? 1.5 : 1.3, text: kickerText },
      { id: bid(), kind: "rule", x: 6, y: port ? 24 : 27, w: 8, accent: true },
      { id: bid(), kind: "title", x: 6, y: port ? 30 : 32, w: port ? 88 : 80, size: fitTitleSize(titleText, port ? 5.5 : o === "square" ? 4.6 : 4), text: titleText, weight: 800 },
      { id: bid(), kind: "subtitle", x: 6, y: port ? 60 : 58, w: port ? 84 : 60, size: port ? 2 : 1.6, text: subtitleText },
      footer(total - 1, total, light ? "#ffffff" : theme.ink),
    ],
  };
}

// ── 목차 / 과정 / 핵심메시지 레이아웃 (연구: 6대 표준 레이아웃) ──────────

function agendaSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko"): TrexSlide {
  const port = o === "portrait";
  const defaultItems = locale === "ko" ? ["항목 1", "항목 2", "항목 3"] : ["Item 1", "Item 2", "Item 3"];
  const items = (c.items && c.items.length ? c.items : defaultItems).slice(0, port ? 6 : 5);
  const n = items.length;
  // 헤더의 뜬 밑줄(rule)은 제거 — 죽은 공간의 주범. 대신 각 행 위 구분선으로 리듬을 준다.
  const pillNo = locale === "ko" ? `${idx} · 목차` : `${idx} · Agenda`;
  const title = c.title || (locale === "ko" ? "이 발표의 흐름" : "What We'll Cover");
  const head = headerBlocks(theme, idx, total, pillNo, title, o).filter((b) => b.kind !== "rule");
  const top = port ? 36 : 39;
  const bottom = port ? 90 : 88;
  const step = (bottom - top) / n;
  const size = port ? 2.4 : n >= 5 ? 2.05 : 2.35;
  const rows: TrexBlock[] = [];
  items.forEach((t, i) => {
    const y = top + i * step;
    rows.push({ id: bid(), kind: "rule", x: 7, y, w: 86 }); // 행 위 얇은 구분선(비강조)
    rows.push({ id: bid(), kind: "body", x: 7, y: y + step * 0.3, w: 86, size, label: `0${i + 1}`, text: t, inline: true });
  });
  return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...head, ...rows] };
}

function processSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko"): TrexSlide {
  const port = o === "portrait";
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
  const steps: TrexBlock[] = data.map((s, i) =>
    port
      ? { id: bid(), kind: "card" as const, x: 8, y: 40 + i * (n > 3 ? 12.5 : 17), w: 84, h: n > 3 ? 11 : 15, size: 1.7, value: num(i), label: heading(s.label, i), text: s.text }
      : { id: bid(), kind: "card" as const, x: 6 + i * (88 / n), y: 46, w: 88 / n - 3, h: 37, size: 1.4, value: num(i), label: heading(s.label, i), text: s.text },
  );
  const pillNo = locale === "ko" ? `${idx} · 과정` : `${idx} · Process`;
  const title = c.title || (locale === "ko" ? "이렇게 진행된다" : "How This Unfolds");
  return { id: bid(), bg: theme.bodyBg, ink: theme.ink, scene: "none", blocks: [...headerBlocks(theme, idx, total, pillNo, title, o), ...steps] };
}

/** 핵심 메시지 — 한 슬라이드 한 아이디어(연구: one idea per slide). 다크 전환 슬라이드. */
function statementSlide(theme: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale: Locale = "ko"): TrexSlide {
  const port = o === "portrait";
  // closeBg가 어두운 모드(editorial)만 흰 글자로 뒤집는다. diagrammatic의 closeBg는
  // 밝은색(#F2F7F5)이라 흰 글자를 쓰면 안 보인다 → theme.ink(어두운색) 유지.
  const light = theme.mode === "editorial";
  const msg = c.text || c.title || (locale === "ko" ? "핵심 메시지" : "The Key Message");
  const kickerText = locale === "ko" ? `${idx} · 핵심 메시지` : `${idx} · Key Message`;
  return {
    id: bid(),
    bg: theme.closeBg,
    ink: light ? "#ffffff" : theme.ink,
    scene: "none",
    blocks: [
      // 키커는 accent 색 대신 ink(muted)로 — editorial의 진한 빨강 액센트는 다크 배경에서 저대비.
      { id: bid(), kind: "kicker", x: 6, y: port ? 18 : 22, w: 50, size: port ? 1.5 : 1.3, text: kickerText },
      { id: bid(), kind: "title", x: 6, y: port ? 30 : 34, w: port ? 88 : 82, size: fitTitleSize(msg, port ? 6.5 : 4.8), text: msg, weight: 800 },
      { id: bid(), kind: "rule", x: 6, y: port ? 58 : 62, w: 10, accent: true },
      footer(idx, total, light ? "#ffffff" : theme.ink),
    ],
  };
}

// ── 역할 기반 레이아웃 레지스트리 (연구: 내용 타입별 스마트 레이아웃) ──────
export type SlideRole = "agenda" | "metrics" | "comparison" | "structure" | "process" | "highlight" | "statement";
const LAYOUTS: Record<SlideRole, (t: ModeTheme, idx: number, total: number, c: SlideContent, o: Orient, locale?: Locale) => TrexSlide> = {
  agenda: agendaSlide,
  metrics: kpiSlide,
  comparison: barSlide,
  structure: cardsSlide,
  process: processSlide,
  highlight: calloutSlide,
  statement: statementSlide,
};

/** 슬라이드 개수 → 내러티브 아크(역할 순서). 6장 이상이면 목차로 시작. */
function pickRoles(total: number): SlideRole[] {
  const middle = Math.max(0, total - 2); // 커버·클로징 제외
  const arc: SlideRole[] = [];
  if (total >= 6) arc.push("agenda");
  const rotation: SlideRole[] = ["metrics", "structure", "comparison", "process", "highlight", "statement"];
  let ri = 0;
  while (arc.length < middle) arc.push(rotation[ri++ % rotation.length]);
  return arc.slice(0, middle);
}

/** 역할별 스캐폴드 콘텐츠(프롬프트 파생 · LLM 미사용 시 폴백). */
function scaffoldContent(role: SlideRole, i: number, pts: string[], locale: Locale = "ko"): SlideContent {
  const p3 = pts.slice(i, i + 3).length >= 3 ? pts.slice(i, i + 3) : pts.slice(0, 3);
  const ko = locale === "ko";
  switch (role) {
    case "agenda":
      return { role, title: ko ? "이 발표의 흐름" : "What We'll Cover", items: pts.slice(0, 4) };
    case "metrics":
      return {
        role,
        title: ko ? "핵심 지표" : "Key Metrics",
        kpis: [{ value: ko ? "2.4조" : "$2.4T", label: p3[0] }, { value: "47%", label: p3[1] }, { value: "8.5x", label: p3[2] }],
      };
    case "comparison":
      return { role, title: ko ? "어디에 집중할 것인가" : "Where To Focus", bars: [{ label: p3[0], value: 82 }, { label: p3[1], value: 64 }, { label: p3[2], value: 48 }] };
    case "structure":
      return { role, title: ko ? "세 갈래로 나뉜다" : "Three Pillars", cards: p3.map((t, j) => ({ label: ["①", "②", "③"][j], text: t })) };
    case "process":
      return { role, title: ko ? "이렇게 진행된다" : "How This Unfolds", steps: p3.map((t, j) => ({ label: `STEP ${j + 1}`, text: t })) };
    case "highlight":
      return { role, title: ko ? "이 한 가지가 결정한다" : "The One Thing That Matters", stat: { value: "76%", label: p3[0] }, text: p3[1] };
    case "statement":
      return { role, text: p3[0] };
  }
}

/** 콘텐츠(LLM 또는 스캐폴드) → 위치 기반 블록 덱. 커버·클로징 자동 추가, footer 번호 동기화. */
export function buildDeckFromContent(content: DeckContent, formatArg?: string, locale: Locale = "ko"): TrexDeck {
  const mode: ArtMode = content.mode && MODE_THEMES[content.mode] ? content.mode : "editorial";
  const theme = MODE_THEMES[mode];
  const o = orientationOf(formatById(formatArg));
  const title = cleanTitle(content.title || "", locale);
  const mids = (content.slides || []).filter((s): s is SlideContent => !!s && (s.role in LAYOUTS));
  const total = mids.length + 2;

  const slides: TrexSlide[] = [coverSlide(theme, total, o, title, content.subtitle, locale)];
  mids.forEach((c, i) => slides.push(LAYOUTS[c.role](theme, i + 1, total, c, o, locale)));
  slides.push(closeSlide(theme, total, o, undefined, undefined, locale));
  slides.forEach((s, i) => {
    const f = s.blocks.find((b) => b.kind === "footer");
    if (f) f.value = `${i + 1 < 10 ? "0" : ""}${i + 1} / ${total < 10 ? "0" : ""}${total}`;
  });

  return { id: `deck_${Date.now().toString(36)}`, title, prompt: content.title || title, mode, accent: theme.accent, formatId: formatArg ?? DEFAULT_FORMAT_ID, createdAt: Date.now(), slides };
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
export function generateDeck(prompt: string, modeArg?: ArtMode, countArg?: number, formatArg?: string, locale: Locale = "ko"): TrexDeck {
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
  return buildDeckFromContent(content, formatArg, locale);
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
    case "footer":
      return { ...base, text: "Agentlas · T-rex", value: "01 / 05", w: 88, size: 1.05, x: 6, y: 90 };
    default:
      return base;
  }
}
