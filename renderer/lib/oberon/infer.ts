// Oberon — 브리프 추론. 사용자는 "제목 + 자유 프롬프트 + 참고자료"만 넣고,
// 에이전트가 장르·톤·설정·캐릭터·길이를 추론해 기획안 단계에서 채워둔다(거기서 수정/승인).
// 실제 LLM 라우팅 시 이 휴리스틱을 대체하면 된다.

import type { Locale } from "@/lib/i18n";
import { FORMAT_DEFAULT_DURATION } from "./taxonomy";
import { emptyBrief } from "./presets";
import type { AspectRatio, FilmBrief, FilmFormat, Genre } from "./types";

const FORMAT_KEYWORDS: [RegExp, FilmFormat][] = [
  [/(모션\s*그래픽|motion\s*graphics?|프레이머|framer|리모션|remotion).*(60\s*초|1\s*분)|(60\s*초|1\s*분).*(모션\s*그래픽|motion\s*graphics?|프레이머|framer|리모션|remotion)/i, "motion_graphics_60"],
  [/모션\s*그래픽|motion\s*graphics?|프레이머|framer|리모션|remotion/i, "motion_graphics_30"],
  [/트레일러|trailer|예고편/i, "trailer"],
  [/뮤직\s*비디오|뮤비|music\s*video|\bmv\b/i, "music_video"],
  [/숏폼|쇼츠|쇼트폼|틱톡|릴스|reels|shorts|tiktok|세로\s*영상/i, "social_short"],
  [/단편\s*드라마|웹드라마|드라마/i, "short_drama"],
  [/시네마틱|단편\s*영화|short\s*film/i, "cinematic_short"],
  [/60\s*초|1\s*분/i, "commercial_60"],
  [/30\s*초|광고|\bcf\b|commercial|\bad\b/i, "commercial_30"],
];

const GENRE_KEYWORDS: [RegExp, Genre][] = [
  [/\bsf\b|sci-?fi|공상과학|우주|로봇|미래|사이버|디스토피아/i, "scifi"],
  [/액션|추격|전투|싸움|폭발/i, "action"],
  [/스릴러|추적|범죄|미스터리|긴박/i, "thriller"],
  [/로맨스|사랑|연인|멜로|설렘/i, "romance"],
  [/공포|호러|horror|귀신|좀비/i, "horror"],
  [/코미디|웃긴|개그|유머/i, "comedy"],
  [/판타지|마법|요정/i, "fantasy"],
  [/다큐|documentary|인터뷰/i, "documentary"],
  [/광고|제품|브랜드|런칭|세일|product|brand/i, "commercial"],
];

const TONE_KEYWORDS: [RegExp, string][] = [
  [/네온|neon|사이버/i, "neon"],
  [/따뜻|포근|warm|온화/i, "warm"],
  [/차가|cold|서늘/i, "cold"],
  [/세련|sleek|모던|고급|프리미엄/i, "sleek"],
  [/웅장|에픽|장엄|epic/i, "epic"],
  [/긴장|tense|불안|조마조마/i, "tense"],
  [/우울|쓸쓸|멜랑|melanchol|애잔/i, "melancholic"],
  [/활기|에너지|energetic|발랄|역동/i, "energetic"],
  [/관능|sensual|매혹/i, "sensual"],
  [/거친|gritty|투박/i, "gritty"],
  [/밝|bright|화사|경쾌/i, "bright"],
];

const LOCATION_LEXICON = [
  "오피스", "사무실", "카페", "거리", "도시", "숲", "바다", "해변", "우주", "기지", "주방",
  "스튜디오", "골목", "공원", "학교", "병원", "지하철", "옥상", "클럽", "사막", "산", "호텔", "공장", "연구소", "정원",
];

function firstSentence(text: string): string {
  const m = text.split(/(?<=[.!?。…])\s|\n/)[0]?.trim();
  return (m || text).slice(0, 160);
}

function pickFormat(text: string): FilmFormat {
  for (const [re, fmt] of FORMAT_KEYWORDS) if (re.test(text)) return fmt;
  return "commercial_30";
}

function pickGenre(text: string, format: FilmFormat): Genre {
  for (const [re, g] of GENRE_KEYWORDS) if (re.test(text)) return g;
  return format === "commercial_30" || format === "commercial_60" || format === "motion_graphics_30" || format === "motion_graphics_60" || format === "social_short" ? "commercial" : "drama";
}

function pickTone(text: string): string[] {
  const found = TONE_KEYWORDS.filter(([re]) => re.test(text)).map(([, t]) => t);
  found.push("cinematic");
  return Array.from(new Set(found)).slice(0, 4);
}

function pickSetting(text: string): string {
  for (const loc of LOCATION_LEXICON) {
    const idx = text.indexOf(loc);
    if (idx >= 0) {
      // 키워드가 속한 절 전체를 이름으로 쓴다 — 고정 폭(6자)으로 자르면
      // "비 내리는 오후의 작은 카페"가 "후의 작은 카페"처럼 어절 중간에서 깨진다.
      const boundary = Math.max(...[...".!?。…,，;:\n·"].map((p) => text.lastIndexOf(p, idx)));
      let phrase = text
        .slice(boundary + 1, idx + loc.length)
        .replace(/^[^가-힣A-Za-z0-9]+/, "")
        .trim();
      // 절이 지나치게 길면 키워드 쪽 어절부터 살려서 줄인다(어절 경계 유지).
      if (phrase.length > 40) {
        const words = phrase.split(/\s+/);
        while (words.length > 1 && words.join(" ").length > 40) words.shift();
        phrase = words.join(" ");
      }
      return phrase || loc;
    }
  }
  return "";
}

function extractCharacters(text: string, locale: Locale = "ko"): FilmBrief["characters"] {
  const stop = new Set(["AI", "CF", "MV", "OK", "TV", "API", "CEO", "SF", "UI", "UX"]);
  const caps = Array.from(new Set((text.match(/\b[A-Z][A-Z]{1,}\b/g) || []).filter((w) => !stop.has(w))));
  const leadRole = locale === "ko" ? "주연" : "Lead";
  const supportRole = locale === "ko" ? "조연" : "Supporting";
  return caps.slice(0, 3).map((name, i) => ({ name, role: i === 0 ? leadRole : supportRole, description: "" }));
}

export function inferBriefFromPrompt(input: {
  title: string;
  prompt: string;
  references: string[];
  /** 사용자가 명시한 포맷(미지정이면 프롬프트에서 추론). */
  format?: FilmFormat | "";
  /** 생성되는 라벨 텍스트 및 기본 대사 언어의 로케일 (기본 "ko" — 기존 호출부 호환). */
  locale?: Locale;
}): FilmBrief {
  const locale = input.locale ?? "ko";
  const prompt = input.prompt.trim();
  const text = `${input.title}\n${prompt}`;
  const format = input.format || pickFormat(text);
  const genre = pickGenre(text, format);
  const aspect: AspectRatio =
    format === "social_short" ? "9:16" : format === "cinematic_short" || format === "trailer" ? "2.39:1" : "16:9";
  return {
    ...emptyBrief(locale),
    title: input.title.trim() || "Untitled",
    format,
    genre,
    aspect,
    durationSec: FORMAT_DEFAULT_DURATION[format],
    logline: firstSentence(prompt) || input.title.trim(),
    synopsis: prompt,
    audience: "",
    tone: pickTone(text),
    visualReferences: input.references,
    characters: extractCharacters(prompt, locale),
    setting: pickSetting(prompt),
    mustInclude: [],
    mustAvoid: [],
    language: locale,
  };
}
