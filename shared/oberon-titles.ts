// Oberon — 타이틀/캡션 번인 스펙 + 결정적 HTML 빌더 (HyperFrames 방식).
//
// 연구(HyperFrames, Apache-2.0) 권고: "글자는 생성 모델이 아니라 코드로 결정적으로
// 합성한다". 타이포 키트(renderer/lib/oberon/typography.ts)가 만든 TextStyleSpec을
// 여기 직렬화 형태(OberonTextStyle)로 옮기고, 그 스펙을 결정적 HTML로 렌더한다.
// 그 HTML을 (electron 측) Chromium 오프스크린으로 PNG 래스터화 → ffmpeg overlay/concat.
//
// 핵심 이점: ffmpeg의 drawtext/subtitles(libfreetype/libass) 필터에 의존하지 않는다
// — 많은 ffmpeg 빌드(Homebrew 등)가 그 필터 없이 빌드돼 있다. overlay/concat/color는
// 코어 필터라 항상 존재. Chromium이 한글·웹폰트·레이아웃을 정확히 그린다.
//
// 이 파일은 renderer/electron 양쪽에서 import한다 — DOM/electron 의존 없는 순수 TS.

export type OberonTitlePosition =
  | "center"
  | "lower_center"
  | "lower_left"
  | "upper_left"
  | "upper_center"
  | "thirds_lower_left";

export type OberonTextCase = "none" | "upper" | "title";

/** 한 텍스트 요소의 직렬화 가능한 완성 스타일. */
export interface OberonTextStyle {
  /** 사람이 읽는 폰트명. */
  fontName: string;
  /** CSS font-family 스택 (한글 폴백 포함). 없으면 카테고리로 폴백. */
  fontStack?: string;
  /** 폰트 카테고리 (폴백 스택 해석용). */
  fontCategory: string;
  /** 한글 등 CJK 글리프가 필요한가. */
  cjk: boolean;
  /** 프레임 높이 대비 글자 크기 % (해상도 독립). */
  sizePct: number;
  weight: number;
  /** em 단위 자간. */
  tracking: number;
  case: OberonTextCase;
  position: OberonTitlePosition;
  /** #RRGGBB / rgba(). */
  fill: string;
  outline?: { color: string; widthPx: number };
  /** 반투명 박스 배경 (자막 가독성). */
  boxBg?: string;
  /** 안전영역 안쪽 마진 % (방송/소셜). */
  safeAreaPct: number;
}

/** 전체 프레임 카드 (타이틀/엔드/CTA) — 영상 앞뒤에 붙는 독립 세그먼트. */
export interface OberonTitleCard {
  kind: "title" | "end_card" | "cta";
  lines: string[];
  style: OberonTextStyle;
  /** 카드 배경색 (#RRGGBB) — 보통 검정. */
  bg: string;
  durationSec: number;
}

/** 본편 위에 시간 구간으로 얹는 로어서드(이름/직함). */
export interface OberonLowerThird {
  lines: string[];
  style: OberonTextStyle;
  startSec: number;
  endSec: number;
}

/** 후반 번인 자막 큐. */
export interface OberonSubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
  voiceover?: boolean;
}

/** 한 작품의 번인 전체 스펙 — OberonRenderRequest.titles로 전달. */
export interface OberonTitleSpec {
  aspectRatio: string; // "16:9" | "9:16" | "1:1"
  titleCard?: OberonTitleCard;
  endCard?: OberonTitleCard;
  lowerThirds: OberonLowerThird[];
  subtitles: OberonSubtitleCue[];
  subtitleStyle?: OberonTextStyle;
  /** 웹폰트 로딩용 <link href> (Google Fonts CSS2). 온라인이면 풀 피델리티, 아니면 시스템 폴백. */
  fontImportHref?: string;
  /** 폰트 페어링 근거(메타·내보내기). */
  rationale?: string;
}

// ── 프레임 기하 ──────────────────────────────────────────

export interface FrameSize {
  w: number;
  h: number;
}

/** 종횡비 → 픽셀 (기준 높이 720, 짝수 보정 — H.264 yuv420p 요구). */
export function frameSizeFor(aspectRatio: string, baseHeight = 720): FrameSize {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  switch (aspectRatio) {
    case "9:16":
      return { w: even((baseHeight * 9) / 16), h: even(baseHeight) };
    case "1:1":
      return { w: even(baseHeight), h: even(baseHeight) };
    case "4:5":
      return { w: even((baseHeight * 4) / 5), h: even(baseHeight) };
    case "2.39:1":
      return { w: even(baseHeight * 2.39), h: even(baseHeight) };
    case "16:9":
    default:
      return { w: even((baseHeight * 16) / 9), h: even(baseHeight) };
  }
}

/** 프레임 높이 대비 % → px. */
export function pxFromPct(pct: number, frameH: number): number {
  return Math.max(8, Math.round((pct / 100) * frameH));
}

// ── 텍스트 케이스 / 이스케이프 ───────────────────────────

export function applyCase(text: string, c: OberonTextCase): string {
  if (c === "upper") return text.toUpperCase();
  if (c === "title") return text.replace(/\b\w/g, (m) => m.toUpperCase());
  return text;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ── 폰트 스택 폴백 ───────────────────────────────────────

const CATEGORY_FALLBACK: Record<string, string> = {
  editorial_serif: `Georgia, "Times New Roman", serif`,
  geometric_sans: `system-ui, "Helvetica Neue", Arial, sans-serif`,
  grotesque_sans: `"Helvetica Neue", Arial, sans-serif`,
  condensed_sans: `"Arial Narrow", "Helvetica Neue", sans-serif`,
  humanist_sans: `system-ui, "Helvetica Neue", sans-serif`,
  slab_serif: `Rockwell, Georgia, serif`,
  mono: `"SF Mono", ui-monospace, monospace`,
  handwritten: `"Bradley Hand", cursive`,
  display_black: `"Arial Black", "Helvetica Neue", sans-serif`,
};
const CJK_FALLBACK = `"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif`;

function fontFamily(style: OberonTextStyle): string {
  const base = style.fontStack || CATEGORY_FALLBACK[style.fontCategory] || `system-ui, sans-serif`;
  // 한글이면 CJK 폴백을 스택 끝에 보장.
  return style.cjk ? `${base}, ${CJK_FALLBACK}` : base;
}

// ── CSS 조립 ─────────────────────────────────────────────

function placement(style: OberonTextStyle): string {
  const safe = `${style.safeAreaPct}%`;
  switch (style.position) {
    case "center":
      return `inset:0; align-items:center; justify-content:center; text-align:center;`;
    case "lower_center":
      return `left:${safe}; right:${safe}; bottom:${safe}; justify-content:center; text-align:center;`;
    case "lower_left":
      return `left:${safe}; bottom:${safe}; justify-content:flex-start; text-align:left;`;
    case "upper_left":
      return `left:${safe}; top:${safe}; justify-content:flex-start; text-align:left;`;
    case "upper_center":
      return `left:${safe}; right:${safe}; top:${safe}; justify-content:center; text-align:center;`;
    case "thirds_lower_left":
      return `left:${safe}; top:62%; right:${safe}; justify-content:flex-start; text-align:left;`;
    default:
      return `inset:0; align-items:center; justify-content:center; text-align:center;`;
  }
}

function textShadow(style: OberonTextStyle): string {
  if (!style.outline) return "text-shadow:0 2px 8px rgba(0,0,0,0.35);";
  const c = style.outline.color;
  const w = Math.max(1, style.outline.widthPx);
  // 4방향 외곽선 + 약한 드롭섀도(가독성).
  return `text-shadow:${w}px 0 0 ${c}, -${w}px 0 0 ${c}, 0 ${w}px 0 ${c}, 0 -${w}px 0 ${c}, ${w}px ${w}px 0 ${c}, -${w}px -${w}px 0 ${c}, 0 3px 10px rgba(0,0,0,0.4);`;
}

function blockCss(style: OberonTextStyle, frameH: number): string {
  const px = pxFromPct(style.sizePct, frameH);
  const box = style.boxBg
    ? `background:${style.boxBg}; padding:${Math.round(px * 0.28)}px ${Math.round(px * 0.5)}px; border-radius:${Math.round(px * 0.18)}px;`
    : "";
  return [
    `font-family:${fontFamily(style)};`,
    `font-weight:${style.weight};`,
    `font-size:${px}px;`,
    `letter-spacing:${style.tracking}em;`,
    `line-height:1.18;`,
    `color:${style.fill};`,
    `text-transform:${style.case === "upper" ? "uppercase" : style.case === "title" ? "capitalize" : "none"};`,
    textShadow(style),
    box,
    `display:inline-block; max-width:90%; white-space:pre-wrap; word-break:keep-all;`,
  ].join("");
}

function fontLink(spec?: { fontImportHref?: string }): string {
  return spec?.fontImportHref ? `<link rel="stylesheet" href="${escapeHtml(spec.fontImportHref)}">` : "";
}

function docShell(w: number, h: number, bodyBg: string, inner: string, fontHref?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${fontLink({ fontImportHref: fontHref })}<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:${bodyBg};font-smooth:always;-webkit-font-smoothing:antialiased}
.frame{position:absolute;inset:0;display:flex}
.slot{position:absolute;display:flex}
</style></head><body>${inner}</body></html>`;
}

function linesHtml(lines: string[]): string {
  return lines.map((l) => escapeHtml(l)).join("<br>");
}

/** 전체 프레임 카드 HTML (불투명 배경 + 위치된 텍스트 블록). */
export function cardHtml(card: OberonTitleCard, w: number, h: number, fontHref?: string): string {
  const lines = card.lines.map((l) => applyCase(l, card.style.case));
  const inner = `<div class="slot" style="${placement(card.style)}"><div style="${blockCss(card.style, h)}">${linesHtml(lines)}</div></div>`;
  return docShell(w, h, card.bg || "#000000", inner, fontHref);
}

/** 투명 배경 오버레이 HTML (로어서드/자막 — 위치된 텍스트 블록 1개). */
export function textOverlayHtml(lines: string[], style: OberonTextStyle, w: number, h: number, fontHref?: string): string {
  const cased = lines.map((l) => applyCase(l, style.case));
  const inner = `<div class="slot" style="${placement(style)}"><div style="${blockCss(style, h)}">${linesHtml(cased)}</div></div>`;
  return docShell(w, h, "transparent", inner, fontHref);
}

// ── SRT 직렬화 (사이드카 내보내기·디버그용; 번인은 PNG로) ──

function fmtSrtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const p = (n: number, wd = 2) => String(n).padStart(wd, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(millis, 3)}`;
}

export function subtitlesToSrt(cues: OberonSubtitleCue[]): string {
  return (
    cues
      .filter((c) => c.text.trim() && c.endSec > c.startSec)
      .map((c, i) => {
        const label = c.voiceover ? "(V.O.) " : "";
        return `${i + 1}\n${fmtSrtTime(c.startSec)} --> ${fmtSrtTime(c.endSec)}\n${label}${c.text}`;
      })
      .join("\n\n") + "\n"
  );
}
