// Oberon — 시네마틱 프롬프트 컴포저.
//
// ShotSpec + Continuity Bible를 받아 프로바이더가 바로 쓸 수 있는 고품질
// 생성 프롬프트를 만든다. 사람이 수백 개 샷 프롬프트를 직접 쓰지 않게 하는 핵심.
//
// 프롬프트 구조: [subject/action] · [framing] · [camera/lens/movement] ·
//                [lighting] · [palette/film stock] · [mood] · [DNA] · [aspect]

import { ANGLES, LENSES, MOVEMENTS, SHOT_SIZES } from "./taxonomy";
import { TEXT_RENDER_POLICY } from "./typography";
import type {
  AspectRatio,
  CameraSpec,
  ContinuityBible,
  ReferenceEntry,
  Scene,
  ShotSize,
} from "./types";

// ── 워드 뱅크 — 출력 품질을 안정적으로 끌어올리는 어휘 ──────

export const FILM_STOCKS = [
  "shot on Arri Alexa, cinematic color science",
  "Kodak Vision3 500T film grain",
  "anamorphic 2x squeeze, oval bokeh",
  "RED Komodo, crisp highlight rolloff",
  "35mm film, subtle halation",
];

export const LIGHTING_LIBRARY: Record<string, string> = {
  warm: "warm practical lamps, soft motivated key, gentle falloff",
  cold: "cool moonlight key, steel-blue ambience, hard rim light",
  high_key: "high-key even lighting, bright and clean, minimal shadow",
  low_key: "low-key chiaroscuro, deep shadows, single soft key",
  golden: "golden hour backlight, long warm shadows, hazy atmosphere",
  neon: "neon practicals, cyan-magenta color contrast, wet reflective surfaces",
  studio: "softbox studio lighting, controlled gradient background, product clarity",
  natural: "naturalistic window light, soft overcast diffusion",
};

export const MOOD_LIBRARY: Record<string, string> = {
  cinematic: "cinematic, filmic, premium production value",
  warm: "intimate, warm, tender",
  tense: "tense, suspenseful, charged",
  epic: "epic scale, awe, grandeur",
  melancholic: "melancholic, wistful, quiet",
  energetic: "energetic, kinetic, vibrant",
  sleek: "sleek, modern, aspirational",
  gritty: "gritty, raw, handheld realism",
};

/** 이미지/스틸 공통 네거티브 — 해부 오류·아티팩트 방지 (리서치 검증). */
export const IMAGE_NEGATIVE = [
  "deformed hands",
  "extra fingers",
  "missing fingers",
  "fused fingers",
  "extra limbs",
  "malformed face",
  "warped face",
  "asymmetrical eyes",
  "crossed eyes",
  "disfigured",
  "distorted proportions",
  "bad anatomy",
  "plastic skin",
  "uncanny",
  "low resolution",
  "blurry",
  "jpeg artifacts",
  "watermark",
  "text",
  "logo distortion",
  "oversaturated",
  "blown highlights",
  "cartoonish",
  "3d render look",
];

/** 영상 전용 템포럴 네거티브 — 프레임 간 정체성/모션 붕괴 방지. */
export const VIDEO_NEGATIVE_TEMPORAL = [
  "flickering",
  "strobing",
  "morphing",
  "identity shift",
  "face changing",
  "warping",
  "jittery motion",
  "stuttering",
  "ghosting",
  "melting",
  "inconsistent lighting",
  "jello effect",
  "temporal artifacts",
  "object permanence failure",
  "crossed eye-line",
  // 연속성 캐논 — 시간·조명 드리프트와 의상 플리커 (세계가 샷 중간에 표류하는 실패 모드).
  "sudden day-to-night jump",
  "inconsistent shadow direction",
  "shadow direction flip",
  "wardrobe color change mid-shot",
  "fabric texture shift",
  "accessory appearing or disappearing",
  "waxy complexion",
];

/** 영상 생성 기본 네거티브 (이미지 + 템포럴). */
export const DEFAULT_NEGATIVE = [...IMAGE_NEGATIVE, ...VIDEO_NEGATIVE_TEMPORAL].join(", ");

// ── 톤 → 라이팅/무드 매핑 ────────────────────────────────

function lightingForTone(tone: string[], sceneTimeOfDay: string): string {
  const t = tone.map((x) => x.toLowerCase());
  const day = sceneTimeOfDay.toLowerCase();
  if (day.includes("밤") || day.includes("night")) {
    if (t.some((x) => x.includes("neon") || x.includes("city") || x.includes("도시"))) return LIGHTING_LIBRARY.neon;
    return LIGHTING_LIBRARY.low_key;
  }
  if (day.includes("golden") || day.includes("일몰") || day.includes("새벽") || day.includes("dawn")) return LIGHTING_LIBRARY.golden;
  if (t.some((x) => x.includes("warm") || x.includes("따뜻"))) return LIGHTING_LIBRARY.warm;
  if (t.some((x) => x.includes("cold") || x.includes("차가"))) return LIGHTING_LIBRARY.cold;
  if (t.some((x) => x.includes("sleek") || x.includes("product") || x.includes("광고"))) return LIGHTING_LIBRARY.studio;
  return LIGHTING_LIBRARY.natural;
}

function moodPhrase(tone: string[]): string {
  const mapped = tone
    .map((x) => MOOD_LIBRARY[x.toLowerCase()])
    .filter(Boolean);
  if (mapped.length) return mapped.join(", ");
  return MOOD_LIBRARY.cinematic;
}

export function cameraPhrase(camera: CameraSpec): string {
  return [
    SHOT_SIZES[camera.size].framing,
    ANGLES[camera.angle].framing,
    MOVEMENTS[camera.movement].framing,
    LENSES[camera.lens].framing,
  ].join(", ");
}

// ── 핵심: 샷 생성 프롬프트 ───────────────────────────────

export interface ComposeShotInput {
  action: string;
  dialogue?: string;
  camera: CameraSpec;
  scene: Scene;
  bible: ContinuityBible;
  tone: string[];
  refs: ReferenceEntry[]; // 이 샷이 참조하는 자산
  aspect: AspectRatio;
  // ── 업그레이드: 부가 연출 레이어 (모두 선택) ──
  /** 직전 샷에서 물려받은 연속성 구문 (continuity-chain). */
  continuityNote?: string;
  /** 초 단위 카메라·액션 안무 (directing). */
  motionPhrase?: string;
  /** Veo 네이티브 동기 오디오 디렉션 (audio-dialogue). */
  audioDirection?: string;
  /** 컷 아웃 전환 지시 (directing.transitionDirective). */
  transitionDirective?: string;
  /** true면 프레임 안에 글자를 그리지 말라고 지시(자막은 후반 번인). */
  suppressOnScreenText?: boolean;
}

export function composeShotPrompt(input: ComposeShotInput): string {
  const { action, dialogue, camera, scene, bible, tone, refs, aspect } = input;
  const lighting = lightingForTone(tone, scene.timeOfDay);
  const mood = moodPhrase(tone);
  const stock = FILM_STOCKS[(scene.index + camera.size.length) % FILM_STOCKS.length];

  const subjects = refs
    .filter((r) => r.kind === "character")
    .map((r) => `${r.name} (${r.lockedTraits.slice(0, 3).join(", ")})`)
    .join("; ");
  const locationRef = refs.find((r) => r.kind === "location");

  const parts: string[] = [];
  // 0) 연속성 — 직전 샷에서 이어받는 상태를 맨 앞에 둔다 (메모리 체인).
  if (input.continuityNote) parts.push(input.continuityNote);
  // 1) 액션 + 인물 (정체성 고정)
  parts.push(subjects ? `${action}. Featuring ${subjects}` : action);
  // 2) 장소
  if (locationRef) parts.push(`in ${locationRef.name} (${locationRef.lockedTraits.slice(0, 2).join(", ")})`);
  else parts.push(`location: ${scene.location}`);
  // 3) 카메라
  parts.push(cameraPhrase(camera));
  // 3b) 초 단위 모션 안무 — "시간 위에서 어떻게 움직이는가".
  if (input.motionPhrase) parts.push(input.motionPhrase);
  // 4) 라이팅
  parts.push(lighting);
  // 5) 팔레트 + 필름 스톡
  const palette = bible.colorPalette.map((s) => s.name).slice(0, 3).join(", ");
  parts.push(`${bible.filmStock || stock}${palette ? `, color palette: ${palette}` : ""}`);
  // 6) 무드 + DNA
  parts.push(mood);
  if (bible.visualDirection) parts.push(bible.visualDirection);
  // 7) 대사·오디오 — 구조화된 오디오 디렉션이 있으면 우선, 없으면 단순 립싱크.
  if (input.audioDirection) parts.push(input.audioDirection);
  else if (dialogue) parts.push(`character speaking in sync, mouth precisely lip-synced: "${dialogue}"`);
  // 7b) 전환 지시 (컷 아웃 핸들).
  if (input.transitionDirective) parts.push(input.transitionDirective);
  // 8) 글자 금지 — 자막/타이틀은 후반 합성 (깨진 텍스트 방지).
  if (input.suppressOnScreenText) parts.push(TEXT_RENDER_POLICY);
  // 9) 비율
  parts.push(`${aspect} aspect ratio, high detail, sharp focus`);

  return parts.join(". ").replace(/\.\./g, ".");
}

export function composeNegativePrompt(extra: string[] = []): string {
  const all = [...DEFAULT_NEGATIVE.split(", "), ...extra];
  return Array.from(new Set(all)).join(", ");
}

// ── 레퍼런스(캐릭터/공간/소품) 생성 프롬프트 ─────────────

export function composeReferencePrompt(args: {
  kind: ReferenceEntry["kind"];
  name: string;
  description: string;
  tone: string[];
  visualDirection: string;
}): string {
  const { kind, name, tone, visualDirection } = args;
  const mood = moodPhrase(tone);
  // 설명이 비었거나 이름과 같으면(예: setting을 이름/설명 양쪽에 쓴 location)
  // "X: X"처럼 중복되지 않게 이름만 쓴다.
  const description = args.description.trim();
  const dedup = description && description !== name.trim() ? description : "";
  const subject = (sep: string) => (dedup ? `${name}${sep}${dedup}` : name);
  if (kind === "character") {
    // 마스터 시트 V2 규격 — 클린 그리드(정면·3/4·측면·전신·표정), 패널 ≤6,
    // 이미지 안 텍스트는 패널 헤더만. 얼굴/의상 일관성이 시트의 존재 이유.
    return `Photoreal CHARACTER MASTER SHEET for ${subject(": ")}. Clean editorial multi-panel grid on a soft neutral background — 6 panels or fewer: 정면(FRONT) large portrait, 3/4 three-quarter view, 측면(SIDE) profile, 전신(FULL BODY) in the locked main outfit head to shoe, 표정(EXPRESSION) row of 2-3 head close-ups. Identical face, hair, outfit and lighting in EVERY panel. ONLY panel header labels printed (Korean + English in parentheses) — no other in-image text, no hex codes, no long captions. ${mood}. ${visualDirection}. Natural soft light, identity-locked, NO Japanese text, NO watermark, 2K detail.`;
  }
  if (kind === "location") {
    return `Establishing reference of ${subject(": ")}. Wide empty plate plus key angles, consistent architecture and props, ${mood}. ${visualDirection}. Photorealistic depth, accurate spatial layout.`;
  }
  if (kind === "wardrobe") {
    return `Wardrobe reference: ${subject(" — ")}. Flat lay and on-figure, consistent color and material. ${visualDirection}.`;
  }
  if (kind === "prop") {
    return `Prop reference: ${subject(" — ")}. Isolated on neutral background, multiple angles, macro detail. ${visualDirection}.`;
  }
  if (kind === "vehicle") {
    return `Vehicle reference: ${subject(" — ")}. 3/4 hero angle and side profile, consistent paint and details. ${visualDirection}.`;
  }
  return `Style frame: ${subject(" — ")}. ${mood}. ${visualDirection}.`;
}

// ── 키프레임(첫/끝 프레임) 프롬프트 ──────────────────────

export function composeKeyframePrompt(args: {
  which: "first" | "last";
  shotAction: string;
  camera: CameraSpec;
  refs: ReferenceEntry[];
  bible: ContinuityBible;
  aspect: AspectRatio;
}): string {
  const { which, shotAction, camera, refs, bible, aspect } = args;
  const subjects = refs.filter((r) => r.kind === "character").map((r) => r.name).join(", ");
  const phase = which === "first" ? "start of the action" : "end of the action, ready for the next cut";
  return [
    `Single still keyframe (${which} frame, ${phase}): ${shotAction}`,
    subjects ? `featuring ${subjects} (identity-locked from reference)` : "",
    cameraPhrase(camera),
    bible.lightingStyle,
    bible.visualDirection,
    `${aspect} aspect ratio, clean composition, stable framing for video interpolation`,
  ]
    .filter(Boolean)
    .join(". ");
}

/** ShotSize별 권장 듀레이션 보정 — 클로즈업은 짧게, 와이드는 길게. */
export function suggestShotDuration(size: ShotSize, base: number): number {
  const factor: Record<ShotSize, number> = {
    ECU: 0.6,
    CU: 0.8,
    MCU: 0.9,
    MS: 1.0,
    MLS: 1.1,
    FS: 1.15,
    LS: 1.25,
    ELS: 1.4,
  };
  return Math.max(1.2, Math.min(8, Number((base * factor[size]).toFixed(1))));
}
