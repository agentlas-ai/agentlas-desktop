// Oberon — Provider Router.
//
// API는 하나만 고집하지 않는다. 각 공급자는 강점/제약이 다르므로 샷별로
// "이 샷에 가장 맞는 모델"을 고른다. 어댑터 경계를 명확히 둬서 API가
// 바뀌거나 종료돼도(예: Sora) 교체만 하면 되게 한다.
//
// 수치는 2026년 기준 현행 리서치값(추정 포함). ~8s 클립(영상) / 이미지 1장(이미지).
// Oberon 리서치 워크플로우(provider/grammar/promptcraft/genre 합성)로 갱신됨.

import type { Locale } from "@/lib/i18n";
import type {
  ProviderMode,
  ProviderProfile,
  ProviderRouteScore,
  RouteDimension,
  RouteDimensionScore,
  ShotRoutingDecision,
  ShotSize,
} from "./types";

// ── i18n 접근자 ──────────────────────────────────────────
// 소비자가 entry.strengths / entry.bestFor 등을 직접 읽는 기존 패턴이라 원본
// 필드는 그대로 두고(source of truth), 표시용 문자열만 이 헬퍼로 고른다.
// (라우팅 결정로그의 동적 문자열(reason/log/note)은 이 파일의 알고리즘 출력이라
//  범위 밖 — 별도 태스크에서 로케일 파라미터를 받도록 다뤄야 한다.)

/** ko/en 문자열 쌍에서 로케일에 맞는 값을 고른다. en이 없으면 ko로 폴백. */
export function providerText(ko: string, en: string | undefined, locale: Locale): string {
  return locale === "en" && en ? en : ko;
}

/** ko/en 문자열 배열 쌍에서 로케일에 맞는 값을 고른다. en이 없거나 비면 ko로 폴백. */
export function providerList(ko: string[], en: string[] | undefined, locale: Locale): string[] {
  return locale === "en" && en && en.length ? en : ko;
}

/** ProviderModel + 영문 대응 필드 (notes). */
export interface ProviderModelI18n {
  model: string;
  modes: ProviderMode[];
  maxDurationSec: number;
  resolutions: string[];
  notes: string;
  notesEn: string;
}

/** ProviderProfile + 영문 대응 필드 (strengths/weaknesses/bestFor), models도 i18n 버전으로. */
export interface ProviderProfileI18n extends ProviderProfile {
  models: ProviderModelI18n[];
  strengthsEn: string[];
  weaknessesEn: string[];
  bestForEn: string;
}

export const PROVIDERS: ProviderProfileI18n[] = [
  {
    id: "veo",
    name: "Google Veo 3.1",
    kind: "video",
    models: [
      { model: "veo-3.1-generate-preview", modes: ["text_to_video", "image_to_video", "first_last_frame", "video_extend"], maxDurationSec: 8, resolutions: ["720p", "1080p", "4K"], notes: "네이티브 동기 오디오 · ref 3장 · extend 지원", notesEn: "Native synced audio · 3 reference images · extend supported" },
      { model: "veo-3.1-fast-generate-001", modes: ["text_to_video", "image_to_video", "first_last_frame"], maxDurationSec: 8, resolutions: ["720p", "1080p"], notes: "빠른 후보용 (4K 없음)", notesEn: "For fast candidates (no 4K)" },
      { model: "veo-3.1-lite-generate-001", modes: ["text_to_video", "image_to_video"], maxDurationSec: 8, resolutions: ["720p"], notes: "대량 드래프트", notesEn: "High-volume drafting" },
    ],
    supportsFirstLastFrame: true,
    supportsRefImage: true,
    refImageCount: 3,
    nativeAudio: true,
    strengths: ["네이티브 동기 대사·SFX·앰비언스", "프롬프트 충실도·물리 리얼리즘", "first/last frame 정밀 연결", "4K 옵션", "인물 일관성"],
    strengthsEn: ["Native synced dialogue, SFX, and ambience", "Prompt fidelity and physical realism", "Precise first/last-frame continuity", "4K option", "Character consistency"],
    weaknesses: ["8초 native 캡", "extend 시 720p로 드롭·드리프트", "in-context v2v 편집 없음", "1080p/4K 비용 상승"],
    weaknessesEn: ["8-second native cap", "Extend drops to 720p and drifts", "No in-context video-to-video editing", "Higher cost at 1080p/4K"],
    approxCostUsd: 3.2,
    bestFor: "대사·립싱크 히어로 샷, 정밀 컷 연결, 4K 파이널",
    bestForEn: "Dialogue / lip-sync hero shots, precise cut continuity, 4K finals",
    vaultKey: "GEMINI_API_KEY",
    status: "active",
  },
  {
    id: "seedance",
    name: "Seedance 2.0 (ByteDance)",
    kind: "video",
    models: [
      { model: "seedance-2.0", modes: ["text_to_video", "image_to_video", "first_last_frame", "video_to_video"], maxDurationSec: 15, resolutions: ["720p", "1080p", "2K"], notes: "리더보드 1위 화질 · 12-asset 멀티모달 조건 · 네이티브 오디오 · Runway/fal 경유", notesEn: "Leaderboard #1 quality · 12-asset multimodal conditioning · native audio · via Runway/fal" },
    ],
    supportsFirstLastFrame: true,
    supportsRefImage: true,
    refImageCount: 12,
    nativeAudio: true,
    strengths: ["현행 최고 화질·리얼리즘 (Elo 1위)", "12-asset 멀티모달 조건(text/image/video/audio)", "네이티브 오디오", "최대 15s·넓은 비율", "v2v에 가장 근접"],
    strengthsEn: ["Current best-in-class quality and realism (#1 Elo)", "12-asset multimodal conditioning (text/image/video/audio)", "Native audio", "Up to 15s, wide aspect-ratio support", "Closest thing to true video-to-video"],
    weaknesses: ["Runway 대비 툴링 미성숙", "일부 상업 클라이언트의 데이터 거버넌스 고려", "해상도 표기 불일치"],
    weaknessesEn: ["Tooling less mature than Runway", "Data-governance concerns for some commercial clients", "Inconsistent resolution labeling"],
    approxCostUsd: 1.4,
    bestFor: "최고 화질 프리미엄 테이크, 다중 레퍼런스 조건 샷",
    bestForEn: "Premium best-quality takes, shots with multiple reference conditions",
    vaultKey: "RUNWAY_API_KEY",
    status: "active",
  },
  {
    id: "runway",
    name: "Runway Gen-4.5",
    kind: "video",
    models: [
      { model: "gen-4.5", modes: ["text_to_video", "image_to_video"], maxDurationSec: 10, resolutions: ["1080p", "4K"], notes: "12 credits/s · 레퍼런스·Act-Two·Aleph 생태계", notesEn: "12 credits/s · references, Act-Two, and Aleph ecosystem" },
      { model: "gen-4-turbo", modes: ["text_to_video", "image_to_video"], maxDurationSec: 10, resolutions: ["720p", "1080p"], notes: "5 credits/s · 빠른 다량 후보", notesEn: "5 credits/s · fast high-volume candidates" },
      { model: "aleph-2.0", modes: ["video_to_video"], maxDurationSec: 5, resolutions: ["4K"], notes: "v2v 편집 — relight/restyle/object/new-angle (재촬영 없이 후반)", notesEn: "Video-to-video editing — relight/restyle/object/new-angle (post-production without reshoots)" },
    ],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 3,
    nativeAudio: false,
    strengths: ["최강 크리에이티브 툴링(references·Act-Two·Aleph)", "Aleph로 리라이트·리스타일·오브젝트 편집", "멀티모델 API 플랫폼"],
    strengthsEn: ["Strongest creative tooling (references, Act-Two, Aleph)", "Relight, restyle, and object editing via Aleph", "Multi-model API platform"],
    weaknesses: ["자사 모델 오디오 없음", "짧은 native 클립", "1080p 크레딧 비용 상승"],
    weaknessesEn: ["No native audio on in-house models", "Short native clip length", "Higher credit cost at 1080p"],
    approxCostUsd: 1.0,
    bestFor: "범용 테이크·레퍼런스 구동 샷, 후반 v2v 편집(Aleph)",
    bestForEn: "General-purpose takes, reference-driven shots, post-production v2v editing (Aleph)",
    vaultKey: "RUNWAY_API_KEY",
    status: "active",
  },
  {
    id: "luma",
    name: "Luma Ray 2",
    kind: "video",
    models: [
      { model: "ray-2", modes: ["text_to_video", "image_to_video", "first_last_frame", "video_extend"], maxDurationSec: 10, resolutions: ["720p", "1080p", "4K_upscale"], notes: "$0.08/s · 카메라컨트롤 타임라인 + 스토리보드 체이닝", notesEn: "$0.08/s · camera-control timeline + storyboard chaining" },
    ],
    supportsFirstLastFrame: true,
    supportsRefImage: true,
    refImageCount: 2,
    nativeAudio: false,
    strengths: ["빠르고 저렴(최고 가성비)", "자연스러운 모션·물리", "카메라컨트롤·스토리보드 체이닝", "프리비즈·대량 드래프트"],
    strengthsEn: ["Fast and cheap (best value)", "Natural motion and physics", "Camera control and storyboard chaining", "Previz and high-volume drafting"],
    weaknesses: ["오디오 없음", "Veo/Seedance 대비 화질 낮음", "다중 extend 드리프트"],
    weaknessesEn: ["No audio", "Lower quality than Veo/Seedance", "Drift over multiple extends"],
    approxCostUsd: 0.64,
    bestFor: "저비용·고속 프리비즈, 대량 establishing/무브 드래프트(후 업스케일)",
    bestForEn: "Low-cost, fast previz; bulk establishing/movement drafts (upscale later)",
    vaultKey: "LUMA_API_KEY",
    status: "active",
  },
  {
    id: "grok",
    name: "Grok Imagine (not enabled)",
    kind: "video",
    models: [
      { model: "runtime-default", modes: ["text_to_video", "image_to_video"], maxDurationSec: 15, resolutions: ["480p", "720p"], notes: "공식 CLI에서 미디어 capability를 검증할 수 없어 현재 비활성", notesEn: "Disabled until the official CLI exposes a verifiable media capability" },
    ],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 1,
    nativeAudio: false,
    strengths: ["API 키·추가 과금 없음(그록 구독 재사용)", "텍스트·이미지→비디오 겸용", "최대 15초", "로컬 CLI라 대량 드래프트에 부담 없음"],
    strengthsEn: ["No API key or extra billing (reuses the Grok subscription)", "Both text- and image-to-video", "Up to 15 seconds", "Local CLI — cheap enough for bulk drafting"],
    weaknesses: ["720p 캡(4K 없음)", "네이티브 오디오 없음", "first/last frame 정밀 연결 없음", "CLI 경유라 폴링·타임아웃 관리 필요"],
    weaknessesEn: ["720p cap (no 4K)", "No native audio", "No first/last-frame precision continuity", "Runs via CLI — needs polling/timeout care"],
    approxCostUsd: 0,
    bestFor: "키 없이 바로 도는 드래프트·프리비즈, 구독만으로 영상이 필요한 모든 샷",
    bestForEn: "Keyless instant drafts/previz — any shot that must work on subscription alone",
    vaultKey: "",
    status: "sunset",
  },
  {
    id: "nano_banana",
    name: "Nano Banana Pro (Gemini 3 Pro Image)",
    kind: "image",
    models: [
      { model: "gemini-3-pro-image", modes: ["image"], maxDurationSec: 0, resolutions: ["2K", "4K"], notes: "캐릭터 최대 5명·레퍼런스 14장 유지 · SynthID·C2PA · 배치 API", notesEn: "Up to 5 characters, 14 reference images retained · SynthID/C2PA · batch API" },
    ],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 14,
    nativeAudio: false,
    strengths: ["최강 다중 캐릭터·다중 소품 일관성", "4K·자유 비율", "멀티 이미지 퓨전·자연어 편집·정밀 텍스트", "대량 키프레임 배치"],
    strengthsEn: ["Strongest multi-character and multi-prop consistency", "4K, free aspect ratio", "Multi-image fusion, natural-language editing, precise text rendering", "Batch keyframe generation at scale"],
    weaknesses: ["SynthID 비활성 불가", "Imagen/Flash보다 비용 높음"],
    weaknessesEn: ["SynthID cannot be disabled", "Higher cost than Imagen/Flash"],
    approxCostUsd: 0.134,
    bestFor: "캐스트 락(≤5명)·의상/소품 유지·first/last 키프레임",
    bestForEn: "Cast lock (up to 5 characters), wardrobe/prop consistency, first/last keyframes",
    vaultKey: "GEMINI_API_KEY",
    status: "active",
  },
  {
    id: "gemini_flash_image",
    name: "Gemini 2.5 Flash Image",
    kind: "image",
    models: [{ model: "gemini-2.5-flash-image", modes: ["image"], maxDurationSec: 0, resolutions: ["1024", "2048"], notes: "$0.039 · 저비용 대량 키프레임", notesEn: "$0.039 · low-cost bulk keyframes" }],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 4,
    nativeAudio: false,
    strengths: ["저비용 대량 생성", "대화형 편집", "준수한 일관성"],
    strengthsEn: ["Low-cost bulk generation", "Conversational editing", "Solid consistency"],
    weaknesses: ["초고해상 약함", "Pro 대비 일관성 낮음"],
    weaknessesEn: ["Weak at ultra-high resolution", "Less consistent than Pro"],
    approxCostUsd: 0.039,
    bestFor: "대량 키프레임 드래프트·콘티 썸네일",
    bestForEn: "Bulk keyframe drafts and storyboard thumbnails",
    vaultKey: "GEMINI_API_KEY",
    status: "active",
  },
  {
    id: "imagen",
    name: "Google Imagen 4",
    kind: "image",
    models: [{ model: "imagen-4", modes: ["image"], maxDurationSec: 0, resolutions: ["1024", "2048"], notes: "$0.04 · 사진급 스틸 · SynthID · text-to-image 전용", notesEn: "$0.04 · photorealistic stills · SynthID · text-to-image only" }],
    supportsFirstLastFrame: false,
    supportsRefImage: false,
    refImageCount: 0,
    nativeAudio: false,
    strengths: ["사진급 디테일", "제품·광고 스틸", "텍스트 렌더링"],
    strengthsEn: ["Photorealistic detail", "Product and advertising stills", "Text rendering"],
    weaknesses: ["레퍼런스 편집 흐름 제한", "t2i 전용"],
    weaknessesEn: ["Limited reference-editing workflow", "Text-to-image only"],
    approxCostUsd: 0.04,
    bestFor: "제품 스틸·브랜드 이미지·무드 키프레임",
    bestForEn: "Product stills, brand imagery, and mood keyframes",
    vaultKey: "GEMINI_API_KEY",
    status: "active",
  },
  {
    id: "openai_image",
    name: "OpenAI gpt-image-1.5",
    kind: "image",
    models: [{ model: "gpt-image-1.5", modes: ["image"], maxDurationSec: 0, resolutions: ["1024", "1536"], notes: "~$0.042 · 마스크 인페인트 편집 · input_fidelity high", notesEn: "~$0.042 · mask inpainting edits · input_fidelity high" }],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 4,
    nativeAudio: false,
    strengths: ["지시 충실도", "마스크 기반 정밀 편집", "콘셉트 아트"],
    strengthsEn: ["Instruction fidelity", "Precise mask-based editing", "Concept art"],
    weaknesses: ["사진급 리얼리즘 변동", "고해상 비용 상승"],
    weaknessesEn: ["Inconsistent photorealism", "Higher cost at high resolution"],
    approxCostUsd: 0.042,
    bestFor: "콘셉트·캐릭터 시트·마스크 인페인트 수정",
    bestForEn: "Concept art, character sheets, and mask-inpainting revisions",
    vaultKey: "OPENAI_API_KEY",
    status: "active",
  },
  {
    id: "firefly",
    name: "Adobe Firefly Services",
    kind: "image",
    models: [{ model: "firefly-image-4", modes: ["image"], maxDurationSec: 0, resolutions: ["2048"], notes: "~$0.08 · 상업 라이선스 안전 · structure/style ref · generative fill", notesEn: "~$0.08 · commercially licensed-safe · structure/style reference · generative fill" }],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 2,
    nativeAudio: false,
    strengths: ["상업 사용 라이선스 안전(엔터프라이즈)", "structure/style reference", "업스케일·제너레이티브 필"],
    strengthsEn: ["Commercial-use license safety (enterprise)", "Structure/style reference", "Upscaling and generative fill"],
    weaknesses: ["크리에이티브 다양성 보수적", "크레딧 기반 가격"],
    weaknessesEn: ["Conservative creative diversity", "Credit-based pricing"],
    approxCostUsd: 0.08,
    bestFor: "브랜드 세이프 상업 광고 asset",
    bestForEn: "Brand-safe commercial advertising assets",
    vaultKey: "FIREFLY_API_KEY",
    status: "active",
  },
  {
    id: "sora",
    name: "OpenAI Sora 2",
    kind: "video",
    models: [{ model: "sora-2", modes: ["text_to_video", "image_to_video"], maxDurationSec: 12, resolutions: ["720p", "1080p"], notes: "API 2026-09-24 종료. 신규 의존 금지.", notesEn: "API sunsets 2026-09-24. Do not build new dependencies on it." }],
    supportsFirstLastFrame: false,
    supportsRefImage: false,
    refImageCount: 0,
    nativeAudio: true,
    strengths: ["프롬프트 표현력"],
    strengthsEn: ["Prompt expressiveness"],
    weaknesses: ["API 종료 예정(2026-09-24)", "후속 미발표", "core dependency 위험"],
    weaknessesEn: ["API scheduled to sunset (2026-09-24)", "No announced successor", "Risky as a core dependency"],
    approxCostUsd: 2.0,
    bestFor: "사용 안 함 (sunset) — Veo/Seedance로 마이그레이션",
    bestForEn: "Do not use (sunset) — migrate to Veo/Seedance",
    vaultKey: "OPENAI_API_KEY",
    status: "sunset",
  },
];

export const VIDEO_PROVIDERS = PROVIDERS.filter((p) => p.kind === "video" && p.status === "active");
export const IMAGE_PROVIDERS = PROVIDERS.filter((p) => p.kind === "image" && p.status === "active");

export function providerById(id: string): ProviderProfileI18n | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ── 라우팅 로직 (7차원 스코어드) ─────────────────────────
// 기존엔 if-else 휴리스틱 트리(첫 매칭이 곧 결정)였다. 이제 각 후보 프로바이더를
// 7개 차원으로 0-1 채점하고 가중합해 "근거 있는" 선택을 한다. 결과는 결정로그로
// 남겨 UI·내보내기에서 왜 이 프로바이더인지 추적할 수 있다. 전부 결정적(난수 없음).
//
// 차원: task_fit 30 · quality 20 · control 15 · reliability 15 · cost 10 · latency 5 · continuity 5
// premium(비용 무시) 모드에선 cost 가중을 0으로 두고 quality로 재배분한다.

export interface VideoRoutingInput {
  needsKeyframes: boolean;
  hasDialogue: boolean;
  movementEnergy: number; // 0-1
  size: ShotSize;
  premium: boolean; // 최고 품질 우선 (비용 무시)
}

/** 결정로그 전체를 반환 (providerId/mode/reason은 하위호환으로 최상단 유지). */
export type VideoRoutingResult = ShotRoutingDecision;

/** 차원별 가중치 (합 1.0). balanced는 "합리적 기본" — 검증된 툴링·비용을 중시해
 *  최고화질 한 모델로 쏠리지 않게 한다(프리미엄에서 화질을 몰아준다). */
const WEIGHTS_BALANCED: Record<RouteDimension, number> = {
  task_fit: 0.3,
  quality: 0.12,
  control: 0.15,
  reliability: 0.17,
  cost: 0.16,
  latency: 0.05,
  continuity: 0.05,
};
/** premium — 비용 무시, 화질·일관성 최우선. */
const WEIGHTS_PREMIUM: Record<RouteDimension, number> = {
  task_fit: 0.26,
  quality: 0.34,
  control: 0.14,
  reliability: 0.1,
  cost: 0, // 비용 무시
  latency: 0.02,
  continuity: 0.14,
};

/** 입력에 따라 동적으로 가중치를 정한다. 히어로샷(대사·정밀 클로즈업)은 비용 비중을
 *  적합도로 옮겨 "비싸도 맞는 모델"을 쓰게 한다(대사=립싱크 정밀이 비용보다 중요). */
function resolveWeights(input: VideoRoutingInput): {
  weights: Record<RouteDimension, number>;
  profile: "balanced" | "premium";
  note: string;
} {
  if (input.premium) return { weights: WEIGHTS_PREMIUM, profile: "premium", note: "프리미엄 — 비용 무시·화질/일관성 최우선" };
  const isCloseup = input.size === "CU" || input.size === "ECU" || input.size === "MCU";
  const heroShot = input.hasDialogue || (input.needsKeyframes && isCloseup);
  if (heroShot) {
    // 비용 비중을 적합도로 정확히 이전(합 보존) — "비싸도 맞는 모델"을 쓴다.
    const freed = WEIGHTS_BALANCED.cost - 0.04;
    const w = { ...WEIGHTS_BALANCED, task_fit: WEIGHTS_BALANCED.task_fit + freed, cost: 0.04 };
    return { weights: w, profile: "balanced", note: "히어로샷(대사·정밀) — 적합도 최우선, 비용 비중↓" };
  }
  return { weights: WEIGHTS_BALANCED, profile: "balanced", note: "균형 — 적합도·안정성·비용" };
}

/** 프로바이더별 정적 역량 프로파일 (0-1). 동적 차원(task_fit·cost)은 입력으로 계산. */
interface RoutingProfile {
  quality: number;
  control: number;
  reliability: number;
  latency: number;
  continuity: number;
  motion: number; // 카메라 무브·물리 정합
  dialogue: number; // 네이티브 동기 오디오·립싱크
}

const ROUTING_PROFILE: Record<string, RoutingProfile> = {
  // 화질·정합 최상, 8초 캡·폴링으로 latency는 중간. 네이티브 오디오 1위.
  veo: { quality: 0.92, control: 0.9, reliability: 0.88, latency: 0.45, continuity: 0.8, motion: 0.7, dialogue: 1.0 },
  // 현행 Elo 1위 화질·12-asset 일관성 최강, 단 툴링 미성숙으로 reliability 낮음.
  // 네이티브 오디오는 있으나 립싱크 정밀도는 Veo가 우위 → dialogue는 약간 낮게.
  seedance: { quality: 1.0, control: 0.82, reliability: 0.7, latency: 0.55, continuity: 0.95, motion: 0.8, dialogue: 0.82 },
  // 최강 크리에이티브 툴링(refs/Aleph)·안정적, 자사 오디오 없음.
  runway: { quality: 0.8, control: 0.95, reliability: 0.9, latency: 0.7, continuity: 0.75, motion: 0.7, dialogue: 0.2 },
  // 빠르고 저렴·모션 최강, 화질·오디오는 약함.
  luma: { quality: 0.68, control: 0.7, reliability: 0.85, latency: 0.9, continuity: 0.6, motion: 0.95, dialogue: 0.1 },
  // 구독 키리스(비용 0)·최대 15s가 강점. 화질 720p 캡·오디오 없음·정밀 연결 없음 → 드래프트/프리비즈 특화.
  grok: { quality: 0.6, control: 0.5, reliability: 0.75, latency: 0.6, continuity: 0.5, motion: 0.65, dialogue: 0.05 },
};

const DIMENSIONS: RouteDimension[] = ["task_fit", "quality", "control", "reliability", "cost", "latency", "continuity"];

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** 이 샷 의도에 대한 프로바이더 적합도 (0-1). 활성 의도들의 가중 평균. */
function taskFitRaw(input: VideoRoutingInput, prof: RoutingProfile, supportsFirstLast: boolean): number {
  const isCloseup = input.size === "CU" || input.size === "ECU" || input.size === "MCU";
  // 하드 요구사항(대사·정밀)은 want를 크게 줘 적합도를 지배 → 해당 특기 프로바이더가 이긴다.
  const precisionWant = input.needsKeyframes ? (isCloseup ? 1.5 : 0.9) : 0;
  const intents: Array<{ want: number; cap: number }> = [
    { want: input.hasDialogue ? 2.5 : 0, cap: prof.dialogue }, // 대사=립싱크는 사실상 veto
    { want: precisionWant, cap: prof.control * (supportsFirstLast ? 1 : 0.4) },
    { want: clamp01(input.movementEnergy), cap: prof.motion },
    { want: input.premium ? 1 : 0.3, cap: prof.quality }, // 품질은 항상 어느 정도 원함
  ];
  const wantSum = intents.reduce((a, x) => a + x.want, 0);
  if (wantSum <= 0) return prof.quality;
  return clamp01(intents.reduce((a, x) => a + x.want * x.cap, 0) / wantSum);
}

/** approxCostUsd를 후보 집합에서 역정규화 (가장 싼 게 1.0). */
function costRaw(provider: ProviderProfile, candidates: ProviderProfile[]): number {
  const costs = candidates.map((c) => c.approxCostUsd);
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  if (max <= min) return 1;
  return clamp01(1 - (provider.approxCostUsd - min) / (max - min));
}

function scoreProvider(
  provider: ProviderProfile,
  input: VideoRoutingInput,
  candidates: ProviderProfile[],
  weights: Record<RouteDimension, number>,
): ProviderRouteScore {
  const prof = ROUTING_PROFILE[provider.id] ?? {
    quality: 0.6,
    control: 0.6,
    reliability: 0.6,
    latency: 0.6,
    continuity: 0.6,
    motion: 0.6,
    dialogue: 0.4,
  };
  const raws: Record<RouteDimension, number> = {
    task_fit: taskFitRaw(input, prof, provider.supportsFirstLastFrame),
    quality: prof.quality,
    control: prof.control * (input.needsKeyframes ? (provider.supportsFirstLastFrame ? 1 : 0.5) : 1),
    reliability: prof.reliability,
    cost: costRaw(provider, candidates),
    latency: prof.latency,
    continuity: clamp01(prof.continuity * 0.7 + Math.min(1, provider.refImageCount / 12) * 0.3),
  };
  const dims: RouteDimensionScore[] = DIMENSIONS.map((d) => ({
    dimension: d,
    weight: weights[d],
    raw: Number(raws[d].toFixed(3)),
    weighted: Number((weights[d] * raws[d]).toFixed(4)),
  }));
  const total = Number((dims.reduce((a, x) => a + x.weighted, 0) * 100).toFixed(1));
  return { providerId: provider.id, total, dims };
}

const DIM_LABEL: Record<RouteDimension, string> = {
  task_fit: "적합도",
  quality: "화질",
  control: "컨트롤",
  reliability: "안정성",
  cost: "비용",
  latency: "속도",
  continuity: "일관성",
};

/** DIM_LABEL의 영문 대응. topDims()의 소비자(결정로그 UI)가 로케일에 맞춰 고를 수 있도록 제공. */
export const DIM_LABEL_EN: Record<RouteDimension, string> = {
  task_fit: "Task Fit",
  quality: "Quality",
  control: "Control",
  reliability: "Reliability",
  cost: "Cost",
  latency: "Speed",
  continuity: "Continuity",
};

/** 점수 카드에서 가장 기여가 큰 차원 2개를 뽑아 사유 문구로. */
function topDims(score: ProviderRouteScore, n = 2): string {
  return [...score.dims]
    .sort((a, b) => b.weighted - a.weighted)
    .slice(0, n)
    .map((d) => `${DIM_LABEL[d.dimension]} ${d.raw.toFixed(2)}`)
    .join("·");
}

export function routeVideoProvider(input: VideoRoutingInput): VideoRoutingResult {
  const candidates = VIDEO_PROVIDERS;
  const { weights, profile: weightProfile, note } = resolveWeights(input);

  const scores = candidates
    .map((p) => scoreProvider(p, input, candidates, weights))
    .sort((a, b) => b.total - a.total);

  // 폴백: 후보가 비면(있을 수 없지만) 안전 기본값.
  if (!scores.length) {
    return {
      providerId: "runway",
      mode: "image_to_video",
      reason: "후보 없음 — 기본 Runway",
      total: 0,
      scores: [],
      weightProfile,
      log: ["라우팅 후보가 없어 기본 프로바이더로 폴백."],
    };
  }

  const winner = scores[0];
  const runnerUp = scores[1];
  const winnerProfile = providerById(winner.providerId);
  const mode: ProviderMode =
    input.needsKeyframes && winnerProfile?.supportsFirstLastFrame ? "first_last_frame" : "image_to_video";
  const margin = runnerUp ? Number((winner.total - runnerUp.total).toFixed(1)) : undefined;

  const reason = `${winnerProfile?.name ?? winner.providerId} (${topDims(winner)})`;
  const log: string[] = [
    `가중치: ${note}`,
    ...scores
      .slice(0, 3)
      .map(
        (s, i) =>
          `${i === 0 ? "▶" : " "} ${(providerById(s.providerId)?.name ?? s.providerId).padEnd(18)} ${String(s.total).padStart(5)} (${topDims(s, 3)})`,
      ),
  ];
  if (runnerUp && margin !== undefined && margin < 4) {
    log.push(`⚠ 1·2위 격차 ${margin}점(박빙) — ${providerById(runnerUp.providerId)?.name ?? runnerUp.providerId} 대안 검토 가능`);
  }

  return {
    providerId: winner.providerId,
    mode,
    reason,
    total: winner.total,
    runnerUpId: runnerUp?.providerId,
    runnerUpTotal: runnerUp?.total,
    margin,
    scores,
    weightProfile,
    log,
  };
}

/** 키프레임/레퍼런스 이미지 생성용 프로바이더 라우팅. */
export function routeImageProvider(kind: "character" | "keyframe" | "product" | "concept"): {
  providerId: string;
  reason: string;
} {
  switch (kind) {
    case "character":
      return { providerId: "nano_banana", reason: "다중 캐릭터·소품 일관성 최강 → Nano Banana Pro" };
    case "keyframe":
      return { providerId: "nano_banana", reason: "first/last 프레임 정합·4K → Nano Banana Pro" };
    case "product":
      return { providerId: "imagen", reason: "제품·브랜드 스틸 사진급 → Imagen 4" };
    case "concept":
    default:
      return { providerId: "openai_image", reason: "콘셉트·무드보드 → OpenAI gpt-image-1.5" };
  }
}
