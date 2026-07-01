// Oberon — 타이포그래피 시스템 (목표 5: 글자가 들어갈 경우 폰트 다양화).
//
// 영상에 들어가는 모든 글자(타이틀 카드 · 로어서드 · 자막 · CTA · 엔드카드)를
// "장르·무드에 맞는 폰트 페어링"으로 자동 선택한다. 사람이 폰트를 고르지 않아도
// 시네마틱하게 보이도록 큐레이션된 라이브러리 + 페어링 규칙을 코드로 박제한다.
//
// 핵심: 한 작품은 보통 2-3개 폰트만 쓴다 (디스플레이 1 · 본문/자막 1 · 액센트 1).
// 폰트를 많이 쓰면 아마추어로 보인다. 다양화 = "장르마다 다른 페어링"이지
// "한 작품 안에서 폰트 난사"가 아니다.

import type { Locale } from "@/lib/i18n";
import type { FilmFormat, Genre } from "./types";

// ── 폰트 카테고리 ────────────────────────────────────────

export type FontCategory =
  | "editorial_serif" // 격조·드라마·다큐 (Playfair, Canela)
  | "geometric_sans" // 모던·테크·광고 (Inter Tight, Sora)
  | "grotesque_sans" // 중립·스위스·범용 (Helvetica-류)
  | "condensed_sans" // 트레일러·임팩트·뉴스 (Oswald, Bebas)
  | "humanist_sans" // 따뜻·친근·라이프스타일 (Pretendard, Noto)
  | "slab_serif" // 강건·복고·스포츠 (Roboto Slab)
  | "mono" // 테크·SF·코드·HUD (JetBrains Mono)
  | "handwritten" // 감성·개인적·메모 (Caveat)
  | "display_black"; // 포스터·임팩트·블록버스터 (Anton, Archivo Black)

export interface FontSpec {
  id: string;
  /** 사람이 읽는 이름. */
  name: string;
  category: FontCategory;
  /** CSS font-family 스택 (한글 폴백 포함). */
  stack: string;
  /** Google Fonts 패밀리명 (웹폰트 로딩용, 없으면 시스템). */
  googleFamily?: string;
  /** 로딩할 weight들. */
  weights: number[];
  /** 어울리는 무드 키워드 (페어링·검색). */
  moods: string[];
  /** 한글 지원 여부 — 한국어 자막/타이틀에 쓸 수 있는가. */
  cjk: boolean;
}

// ── 큐레이션된 폰트 라이브러리 ───────────────────────────
// Google Fonts 우선(무료·임베드 가능). 한글은 Pretendard/Noto Sans KR 폴백.

export const FONT_LIBRARY: Record<string, FontSpec> = {
  playfair: {
    id: "playfair",
    name: "Playfair Display",
    category: "editorial_serif",
    stack: `"Playfair Display", "Noto Serif KR", Georgia, serif`,
    googleFamily: "Playfair+Display:wght@400;600;700;900",
    weights: [400, 600, 700, 900],
    moods: ["격조", "드라마", "로맨스", "럭셔리", "elegant", "editorial"],
    cjk: false,
  },
  fraunces: {
    id: "fraunces",
    name: "Fraunces",
    category: "editorial_serif",
    stack: `"Fraunces", "Noto Serif KR", Georgia, serif`,
    googleFamily: "Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900",
    weights: [400, 600, 900],
    moods: ["시네마틱", "감성", "빈티지", "warm", "cinematic"],
    cjk: false,
  },
  interTight: {
    id: "interTight",
    name: "Inter Tight",
    category: "geometric_sans",
    stack: `"Inter Tight", "Pretendard Variable", "Pretendard", system-ui, sans-serif`,
    googleFamily: "Inter+Tight:wght@400;500;600;700;800",
    weights: [400, 500, 600, 700, 800],
    moods: ["모던", "테크", "광고", "sleek", "clean", "product"],
    cjk: false,
  },
  sora: {
    id: "sora",
    name: "Sora",
    category: "geometric_sans",
    stack: `"Sora", "Pretendard Variable", system-ui, sans-serif`,
    googleFamily: "Sora:wght@400;600;700;800",
    weights: [400, 600, 700, 800],
    moods: ["미래", "SF", "테크", "futuristic", "sleek"],
    cjk: false,
  },
  oswald: {
    id: "oswald",
    name: "Oswald",
    category: "condensed_sans",
    stack: `"Oswald", "Pretendard", system-ui, sans-serif`,
    googleFamily: "Oswald:wght@400;500;600;700",
    weights: [400, 500, 600, 700],
    moods: ["트레일러", "임팩트", "뉴스", "스포츠", "bold", "epic"],
    cjk: false,
  },
  bebas: {
    id: "bebas",
    name: "Bebas Neue",
    category: "condensed_sans",
    stack: `"Bebas Neue", "Oswald", system-ui, sans-serif`,
    googleFamily: "Bebas+Neue",
    weights: [400],
    moods: ["포스터", "임팩트", "헤드라인", "energetic", "bold"],
    cjk: false,
  },
  anton: {
    id: "anton",
    name: "Anton",
    category: "display_black",
    stack: `"Anton", "Archivo Black", system-ui, sans-serif`,
    googleFamily: "Anton",
    weights: [400],
    moods: ["블록버스터", "액션", "임팩트", "epic", "loud"],
    cjk: false,
  },
  archivoBlack: {
    id: "archivoBlack",
    name: "Archivo Black",
    category: "display_black",
    stack: `"Archivo Black", "Anton", system-ui, sans-serif`,
    googleFamily: "Archivo+Black",
    weights: [400],
    moods: ["브랜드", "포스터", "강렬", "loud", "modern"],
    cjk: false,
  },
  pretendard: {
    id: "pretendard",
    name: "Pretendard",
    category: "humanist_sans",
    stack: `"Pretendard Variable", "Pretendard", "Noto Sans KR", system-ui, sans-serif`,
    weights: [400, 500, 600, 700, 800],
    moods: ["한글", "친근", "라이프스타일", "warm", "clean", "ko"],
    cjk: true,
  },
  notoSansKr: {
    id: "notoSansKr",
    name: "Noto Sans KR",
    category: "humanist_sans",
    stack: `"Noto Sans KR", "Pretendard", system-ui, sans-serif`,
    googleFamily: "Noto+Sans+KR:wght@400;500;700;900",
    weights: [400, 500, 700, 900],
    moods: ["한글", "범용", "자막", "neutral", "ko"],
    cjk: true,
  },
  notoSerifKr: {
    id: "notoSerifKr",
    name: "Noto Serif KR",
    category: "editorial_serif",
    stack: `"Noto Serif KR", Georgia, serif`,
    googleFamily: "Noto+Serif+KR:wght@400;600;700;900",
    weights: [400, 600, 700, 900],
    moods: ["한글", "격조", "사극", "드라마", "elegant", "ko"],
    cjk: true,
  },
  robotoSlab: {
    id: "robotoSlab",
    name: "Roboto Slab",
    category: "slab_serif",
    stack: `"Roboto Slab", "Noto Serif KR", serif`,
    googleFamily: "Roboto+Slab:wght@400;500;700;800",
    weights: [400, 500, 700, 800],
    moods: ["강건", "복고", "다큐", "스포츠", "sturdy"],
    cjk: false,
  },
  jetbrainsMono: {
    id: "jetbrainsMono",
    name: "JetBrains Mono",
    category: "mono",
    stack: `"JetBrains Mono", "SF Mono", ui-monospace, monospace`,
    googleFamily: "JetBrains+Mono:wght@400;500;700",
    weights: [400, 500, 700],
    moods: ["테크", "SF", "HUD", "코드", "futuristic", "data"],
    cjk: false,
  },
  spaceGrotesk: {
    id: "spaceGrotesk",
    name: "Space Grotesk",
    category: "grotesque_sans",
    stack: `"Space Grotesk", "Pretendard", system-ui, sans-serif`,
    googleFamily: "Space+Grotesk:wght@400;500;600;700",
    weights: [400, 500, 600, 700],
    moods: ["스위스", "테크", "모던", "에디토리얼", "clean", "modern"],
    cjk: false,
  },
  caveat: {
    id: "caveat",
    name: "Caveat",
    category: "handwritten",
    stack: `"Caveat", "Nanum Pen Script", cursive`,
    googleFamily: "Caveat:wght@400;600;700",
    weights: [400, 600, 700],
    moods: ["감성", "개인적", "메모", "handwritten", "intimate"],
    cjk: false,
  },
};

export type FontId = keyof typeof FONT_LIBRARY;

// ── 텍스트 역할별 스타일 ─────────────────────────────────

export type TextRole =
  | "title" // 메인 타이틀 카드 (작품명)
  | "subtitle_caption" // 화면 하단 대사 자막 (가독성 최우선)
  | "lower_third" // 인물/장소 소개 (이름·직함)
  | "kicker" // 챕터/날짜/위치 라벨 (작은 트래킹 대문자)
  | "cta" // 행동 유도 (광고 마지막 "지금 구매")
  | "end_card"; // 엔드카드/로고 슬레이트

/** 한 텍스트 요소의 완전한 타이포 스펙 — 렌더러/자막 번인에 그대로 쓴다. */
export interface TextStyleSpec {
  role: TextRole;
  fontId: FontId;
  /** 프레임 높이 대비 글자 크기 % (해상도 독립). */
  sizePct: number;
  weight: number;
  /** em 단위 자간. 디스플레이는 타이트, 캡션은 넓게. */
  tracking: number;
  case: "none" | "upper" | "title";
  /** 화면 내 기본 위치. */
  position:
    | "center"
    | "lower_center"
    | "lower_left"
    | "upper_left"
    | "upper_center"
    | "thirds_lower_left";
  fill: string;
  /** 자막 가독성: 외곽선 또는 반투명 배경 박스. */
  outline?: { color: string; widthPx: number };
  boxBg?: string;
  /** 등장/퇴장 모션. */
  motion: "cut" | "fade" | "slide_up" | "type_on" | "scale_in" | "track_in";
  /** 안전영역 안쪽 마진 % (방송/소셜 자막 안전). */
  safeAreaPct: number;
}

/** 작품 전체에 적용되는 타이포 키트 — engine이 brief로부터 결정. */
export interface TypographyKit {
  /** 디스플레이(타이틀·CTA)용 폰트. */
  displayFontId: FontId;
  /** 본문/자막용 폰트 (한국어면 cjk 폰트 강제). */
  bodyFontId: FontId;
  /** 라벨/키커용 액센트 폰트 (보통 mono 또는 condensed). */
  accentFontId: FontId;
  /** 역할별 완성 스타일. */
  styles: Record<TextRole, TextStyleSpec>;
  /** 페어링 근거 (UI 표시·내보내기). */
  rationale: string;
  /** 임베드해야 할 Google Fonts 패밀리들. */
  googleFamilies: string[];
}

// ── 장르 → 페어링 프리셋 ─────────────────────────────────
// {디스플레이, 본문, 액센트} 3종. 한국어 작품이면 본문은 cjk로 오버라이드.

interface Pairing {
  display: FontId;
  body: FontId;
  accent: FontId;
  rationale: string;
  rationaleEn: string;
}

const GENRE_PAIRINGS: Record<Genre, Pairing> = {
  commercial: {
    display: "interTight",
    body: "pretendard",
    accent: "spaceGrotesk",
    rationale: "모던 지오메트릭 + 휴머니스트 본문 — 깨끗한 브랜드 광고 룩",
    rationaleEn: "Modern geometric display + humanist body — a clean brand-ad look",
  },
  drama: {
    display: "fraunces",
    body: "notoSansKr",
    accent: "spaceGrotesk",
    rationale: "시네마틱 세리프 디스플레이 + 중립 자막 — 감정 드라마",
    rationaleEn: "Cinematic serif display + neutral captions — emotional drama",
  },
  action: {
    display: "anton",
    body: "pretendard",
    accent: "jetbrainsMono",
    rationale: "블랙 디스플레이 + 강한 본문 + 모노 라벨 — 임팩트 액션",
    rationaleEn: "Black display + strong body + mono labels — high-impact action",
  },
  thriller: {
    display: "oswald",
    body: "notoSansKr",
    accent: "jetbrainsMono",
    rationale: "컨덴스드 + 모노 — 긴장·수사·뉴스 톤",
    rationaleEn: "Condensed + mono — tense, investigative, news-style tone",
  },
  romance: {
    display: "playfair",
    body: "notoSerifKr",
    accent: "caveat",
    rationale: "에디토리얼 세리프 + 손글씨 액센트 — 따뜻한 로맨스",
    rationaleEn: "Editorial serif + handwritten accent — warm romance",
  },
  scifi: {
    display: "sora",
    body: "pretendard",
    accent: "jetbrainsMono",
    rationale: "지오메트릭 + 모노 HUD — 미래·테크 SF",
    rationaleEn: "Geometric + mono HUD — futuristic, tech-forward sci-fi",
  },
  documentary: {
    display: "robotoSlab",
    body: "notoSansKr",
    accent: "spaceGrotesk",
    rationale: "슬랩 + 중립 자막 — 신뢰감 다큐멘터리",
    rationaleEn: "Slab serif + neutral captions — a trustworthy documentary tone",
  },
  fantasy: {
    display: "playfair",
    body: "notoSerifKr",
    accent: "fraunces",
    rationale: "세리프 디스플레이 — 서사·판타지 격조",
    rationaleEn: "Serif display — epic, narrative fantasy elegance",
  },
  horror: {
    display: "oswald",
    body: "notoSansKr",
    accent: "jetbrainsMono",
    rationale: "컨덴스드 + 모노 — 불안·차가운 호러",
    rationaleEn: "Condensed + mono — unsettling, cold horror",
  },
  comedy: {
    display: "archivoBlack",
    body: "pretendard",
    accent: "caveat",
    rationale: "두꺼운 디스플레이 + 손글씨 — 경쾌한 코미디",
    rationaleEn: "Bold display + handwritten accent — light-hearted comedy",
  },
};

/** 숏폼/소셜은 자막이 핵심 — 본문을 더 두껍고 크게. */
const FORMAT_TONE: Partial<Record<FilmFormat, Partial<Pairing>>> = {
  trailer: {
    display: "anton",
    accent: "jetbrainsMono",
    rationale: "트레일러 — 블랙 임팩트 타이틀, 모노 날짜 카드",
    rationaleEn: "Trailer — bold black-display titles, mono date cards",
  },
  music_video: {
    display: "bebas",
    accent: "spaceGrotesk",
    rationale: "뮤직비디오 — 포스터 디스플레이, 리드미컬 라벨",
    rationaleEn: "Music video — poster-style display, rhythmic labels",
  },
  social_short: {
    display: "archivoBlack",
    accent: "interTight",
    rationale: "소셜 숏폼 — 두꺼운 자막 친화 타이틀(엄지 정지)",
    rationaleEn: "Social short — bold, caption-friendly titles (thumb-stopping)",
  },
};

// ── 역할별 스타일 빌더 ───────────────────────────────────

function buildStyles(kit: { display: FontId; body: FontId; accent: FontId }): Record<TextRole, TextStyleSpec> {
  return {
    title: {
      role: "title",
      fontId: kit.display,
      sizePct: 9.5,
      weight: heaviest(kit.display),
      tracking: -0.01,
      case: "none",
      position: "center",
      fill: "#FFFFFF",
      outline: { color: "rgba(0,0,0,0.45)", widthPx: 2 },
      motion: "track_in",
      safeAreaPct: 10,
    },
    subtitle_caption: {
      role: "subtitle_caption",
      fontId: kit.body,
      sizePct: 4.6,
      weight: 600,
      tracking: 0,
      case: "none",
      position: "lower_center",
      fill: "#FFFFFF",
      // 자막은 어떤 배경에서도 읽혀야 한다 — 외곽선 + 반투명 박스 둘 다.
      outline: { color: "rgba(0,0,0,0.9)", widthPx: 3 },
      boxBg: "rgba(0,0,0,0.34)",
      motion: "fade",
      safeAreaPct: 8,
    },
    lower_third: {
      role: "lower_third",
      fontId: kit.body,
      sizePct: 5.2,
      weight: 700,
      tracking: 0,
      case: "none",
      position: "thirds_lower_left",
      fill: "#FFFFFF",
      outline: { color: "rgba(0,0,0,0.5)", widthPx: 1.5 },
      motion: "slide_up",
      safeAreaPct: 8,
    },
    kicker: {
      role: "kicker",
      fontId: kit.accent,
      sizePct: 2.6,
      weight: 600,
      tracking: 0.22,
      case: "upper",
      position: "upper_left",
      fill: "rgba(255,255,255,0.92)",
      motion: "fade",
      safeAreaPct: 8,
    },
    cta: {
      role: "cta",
      fontId: kit.display,
      sizePct: 6.8,
      weight: heaviest(kit.display),
      tracking: 0,
      case: "none",
      position: "center",
      fill: "#FFFFFF",
      motion: "scale_in",
      safeAreaPct: 12,
    },
    end_card: {
      role: "end_card",
      fontId: kit.display,
      sizePct: 7.5,
      weight: heaviest(kit.display),
      tracking: 0.02,
      case: "none",
      position: "center",
      fill: "#FFFFFF",
      motion: "fade",
      safeAreaPct: 14,
    },
  };
}

function heaviest(id: FontId): number {
  const w = FONT_LIBRARY[id].weights;
  return w[w.length - 1];
}

// ── 메인: brief → TypographyKit ──────────────────────────

export interface TypographyInput {
  genre: Genre;
  format: FilmFormat;
  /** 영상 속 대사 언어 (UI 로케일과 별개). */
  language: "ko" | "en";
  tone: string[];
  /** rationale 등 표시 텍스트의 UI 로케일 (기본 "ko" — 기존 호출부 호환). */
  locale?: Locale;
}

export function pickTypography(input: TypographyInput): TypographyKit {
  const locale = input.locale ?? "ko";
  const base = { ...GENRE_PAIRINGS[input.genre] };
  const override = FORMAT_TONE[input.format];
  if (override?.display) base.display = override.display;
  if (override?.accent) base.accent = override.accent;

  // 한국어 작품 — 본문/자막은 반드시 한글 지원 폰트로.
  if (input.language === "ko" && !FONT_LIBRARY[base.body].cjk) {
    base.body = FONT_LIBRARY[base.display].category === "editorial_serif" ? "notoSerifKr" : "notoSansKr";
  }
  // 디스플레이가 한글 미지원인데 한국어 타이틀이 필요할 수 있음 → 폴백 동반(스택에 이미 포함).

  // 무드 기반 미세 조정 — neon/cyber면 액센트를 mono로.
  const t = input.tone.map((x) => x.toLowerCase()).join(" ");
  if (/(neon|cyber|tech|hud|data|코드|미래)/.test(t)) base.accent = "jetbrainsMono";
  if (/(luxury|럭셔리|elegant|격조|premium)/.test(t) && FONT_LIBRARY[base.display].category !== "editorial_serif") {
    base.display = "playfair";
  }

  const styles = buildStyles(base);
  const genrePairing = GENRE_PAIRINGS[input.genre];
  const rationale =
    locale === "ko"
      ? [genrePairing.rationale, override?.rationale].filter(Boolean).join(" · ")
      : [genrePairing.rationaleEn, override?.rationaleEn].filter(Boolean).join(" · ");
  const googleFamilies = collectGoogleFamilies([base.display, base.body, base.accent]);

  return {
    displayFontId: base.display,
    bodyFontId: base.body,
    accentFontId: base.accent,
    styles,
    rationale,
    googleFamilies,
  };
}

function collectGoogleFamilies(ids: FontId[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const fam = FONT_LIBRARY[id].googleFamily;
    if (fam) out.add(fam);
  }
  return Array.from(out);
}

/** Google Fonts CSS2 import URL — 렌더러에서 동적 로딩 / 내보내기 HTML head에 삽입. */
export function googleFontsHref(kit: TypographyKit): string | null {
  if (!kit.googleFamilies.length) return null;
  const families = kit.googleFamilies.map((f) => `family=${f}`).join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/** 자막 번인용 스타일을 ffmpeg/ASS 호환 힌트로 — delivery 단계에서 사용. */
export function captionStyleHint(kit: TypographyKit): string {
  const s = kit.styles.subtitle_caption;
  const f = FONT_LIBRARY[s.fontId];
  return [
    `font: ${f.name}`,
    `weight ${s.weight}`,
    `size ${s.sizePct}% of frame height`,
    `position ${s.position}`,
    s.outline ? `outline ${s.outline.widthPx}px ${s.outline.color}` : "",
    s.boxBg ? `box ${s.boxBg}` : "",
    `safe-area ${s.safeAreaPct}%`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** 키프레임/영상 프롬프트가 "글자를 그리지 말라"고 지시하기 위한 보조 —
 *  글자는 생성 모델이 아니라 후반 번인으로 넣는다(깨진 텍스트 방지). */
export const TEXT_RENDER_POLICY =
  "Do not render any on-screen text, titles, subtitles, captions, logos, or UI inside the generated frame — all typography is composited in post with the project's font kit.";
