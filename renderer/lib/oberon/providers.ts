// Oberon — Provider Router.
//
// API는 하나만 고집하지 않는다. 각 공급자는 강점/제약이 다르므로 샷별로
// "이 샷에 가장 맞는 모델"을 고른다. 어댑터 경계를 명확히 둬서 API가
// 바뀌거나 종료돼도(예: Sora) 교체만 하면 되게 한다.
//
// 수치는 2026년 기준 현행 리서치값(추정 포함). ~8s 클립(영상) / 이미지 1장(이미지).
// Oberon 리서치 워크플로우(provider/grammar/promptcraft/genre 합성)로 갱신됨.

import type { ProviderMode, ProviderProfile, ShotSize } from "./types";

export const PROVIDERS: ProviderProfile[] = [
  {
    id: "veo",
    name: "Google Veo 3.1",
    kind: "video",
    models: [
      { model: "veo-3.1-generate-preview", modes: ["text_to_video", "image_to_video", "first_last_frame", "video_extend"], maxDurationSec: 8, resolutions: ["720p", "1080p", "4K"], notes: "네이티브 동기 오디오 · ref 3장 · extend 지원" },
      { model: "veo-3.1-fast-generate-001", modes: ["text_to_video", "image_to_video", "first_last_frame"], maxDurationSec: 8, resolutions: ["720p", "1080p"], notes: "빠른 후보용 (4K 없음)" },
      { model: "veo-3.1-lite-generate-001", modes: ["text_to_video", "image_to_video"], maxDurationSec: 8, resolutions: ["720p"], notes: "대량 드래프트" },
    ],
    supportsFirstLastFrame: true,
    supportsRefImage: true,
    refImageCount: 3,
    nativeAudio: true,
    strengths: ["네이티브 동기 대사·SFX·앰비언스", "프롬프트 충실도·물리 리얼리즘", "first/last frame 정밀 연결", "4K 옵션", "인물 일관성"],
    weaknesses: ["8초 native 캡", "extend 시 720p로 드롭·드리프트", "in-context v2v 편집 없음", "1080p/4K 비용 상승"],
    approxCostUsd: 3.2,
    bestFor: "대사·립싱크 히어로 샷, 정밀 컷 연결, 4K 파이널",
    vaultKey: "GEMINI_API_KEY",
    status: "active",
  },
  {
    id: "seedance",
    name: "Seedance 2.0 (ByteDance)",
    kind: "video",
    models: [
      { model: "seedance-2.0", modes: ["text_to_video", "image_to_video", "first_last_frame", "video_to_video"], maxDurationSec: 15, resolutions: ["720p", "1080p", "2K"], notes: "리더보드 1위 화질 · 12-asset 멀티모달 조건 · 네이티브 오디오 · Runway/fal 경유" },
    ],
    supportsFirstLastFrame: true,
    supportsRefImage: true,
    refImageCount: 12,
    nativeAudio: true,
    strengths: ["현행 최고 화질·리얼리즘 (Elo 1위)", "12-asset 멀티모달 조건(text/image/video/audio)", "네이티브 오디오", "최대 15s·넓은 비율", "v2v에 가장 근접"],
    weaknesses: ["Runway 대비 툴링 미성숙", "일부 상업 클라이언트의 데이터 거버넌스 고려", "해상도 표기 불일치"],
    approxCostUsd: 1.4,
    bestFor: "최고 화질 프리미엄 테이크, 다중 레퍼런스 조건 샷",
    vaultKey: "RUNWAY_API_KEY",
    status: "active",
  },
  {
    id: "runway",
    name: "Runway Gen-4.5",
    kind: "video",
    models: [
      { model: "gen-4.5", modes: ["text_to_video", "image_to_video"], maxDurationSec: 10, resolutions: ["1080p", "4K"], notes: "12 credits/s · 레퍼런스·Act-Two·Aleph 생태계" },
      { model: "gen-4-turbo", modes: ["text_to_video", "image_to_video"], maxDurationSec: 10, resolutions: ["720p", "1080p"], notes: "5 credits/s · 빠른 다량 후보" },
      { model: "aleph-2.0", modes: ["video_to_video"], maxDurationSec: 5, resolutions: ["4K"], notes: "v2v 편집 — relight/restyle/object/new-angle (재촬영 없이 후반)" },
    ],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 3,
    nativeAudio: false,
    strengths: ["최강 크리에이티브 툴링(references·Act-Two·Aleph)", "Aleph로 리라이트·리스타일·오브젝트 편집", "멀티모델 API 플랫폼"],
    weaknesses: ["자사 모델 오디오 없음", "짧은 native 클립", "1080p 크레딧 비용 상승"],
    approxCostUsd: 1.0,
    bestFor: "범용 테이크·레퍼런스 구동 샷, 후반 v2v 편집(Aleph)",
    vaultKey: "RUNWAY_API_KEY",
    status: "active",
  },
  {
    id: "luma",
    name: "Luma Ray 2",
    kind: "video",
    models: [
      { model: "ray-2", modes: ["text_to_video", "image_to_video", "first_last_frame", "video_extend"], maxDurationSec: 10, resolutions: ["720p", "1080p", "4K_upscale"], notes: "$0.08/s · 카메라컨트롤 타임라인 + 스토리보드 체이닝" },
    ],
    supportsFirstLastFrame: true,
    supportsRefImage: true,
    refImageCount: 2,
    nativeAudio: false,
    strengths: ["빠르고 저렴(최고 가성비)", "자연스러운 모션·물리", "카메라컨트롤·스토리보드 체이닝", "프리비즈·대량 드래프트"],
    weaknesses: ["오디오 없음", "Veo/Seedance 대비 화질 낮음", "다중 extend 드리프트"],
    approxCostUsd: 0.64,
    bestFor: "저비용·고속 프리비즈, 대량 establishing/무브 드래프트(후 업스케일)",
    vaultKey: "LUMA_API_KEY",
    status: "active",
  },
  {
    id: "nano_banana",
    name: "Nano Banana Pro (Gemini 3 Pro Image)",
    kind: "image",
    models: [
      { model: "gemini-3-pro-image", modes: ["image"], maxDurationSec: 0, resolutions: ["2K", "4K"], notes: "캐릭터 최대 5명·레퍼런스 14장 유지 · SynthID·C2PA · 배치 API" },
    ],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 14,
    nativeAudio: false,
    strengths: ["최강 다중 캐릭터·다중 소품 일관성", "4K·자유 비율", "멀티 이미지 퓨전·자연어 편집·정밀 텍스트", "대량 키프레임 배치"],
    weaknesses: ["SynthID 비활성 불가", "Imagen/Flash보다 비용 높음"],
    approxCostUsd: 0.134,
    bestFor: "캐스트 락(≤5명)·의상/소품 유지·first/last 키프레임",
    vaultKey: "GEMINI_API_KEY",
    status: "active",
  },
  {
    id: "gemini_flash_image",
    name: "Gemini 2.5 Flash Image",
    kind: "image",
    models: [{ model: "gemini-2.5-flash-image", modes: ["image"], maxDurationSec: 0, resolutions: ["1024", "2048"], notes: "$0.039 · 저비용 대량 키프레임" }],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 4,
    nativeAudio: false,
    strengths: ["저비용 대량 생성", "대화형 편집", "준수한 일관성"],
    weaknesses: ["초고해상 약함", "Pro 대비 일관성 낮음"],
    approxCostUsd: 0.039,
    bestFor: "대량 키프레임 드래프트·콘티 썸네일",
    vaultKey: "GEMINI_API_KEY",
    status: "active",
  },
  {
    id: "imagen",
    name: "Google Imagen 4",
    kind: "image",
    models: [{ model: "imagen-4", modes: ["image"], maxDurationSec: 0, resolutions: ["1024", "2048"], notes: "$0.04 · 사진급 스틸 · SynthID · text-to-image 전용" }],
    supportsFirstLastFrame: false,
    supportsRefImage: false,
    refImageCount: 0,
    nativeAudio: false,
    strengths: ["사진급 디테일", "제품·광고 스틸", "텍스트 렌더링"],
    weaknesses: ["레퍼런스 편집 흐름 제한", "t2i 전용"],
    approxCostUsd: 0.04,
    bestFor: "제품 스틸·브랜드 이미지·무드 키프레임",
    vaultKey: "GEMINI_API_KEY",
    status: "active",
  },
  {
    id: "openai_image",
    name: "OpenAI gpt-image-1.5",
    kind: "image",
    models: [{ model: "gpt-image-1.5", modes: ["image"], maxDurationSec: 0, resolutions: ["1024", "1536"], notes: "~$0.042 · 마스크 인페인트 편집 · input_fidelity high" }],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 4,
    nativeAudio: false,
    strengths: ["지시 충실도", "마스크 기반 정밀 편집", "콘셉트 아트"],
    weaknesses: ["사진급 리얼리즘 변동", "고해상 비용 상승"],
    approxCostUsd: 0.042,
    bestFor: "콘셉트·캐릭터 시트·마스크 인페인트 수정",
    vaultKey: "OPENAI_API_KEY",
    status: "active",
  },
  {
    id: "firefly",
    name: "Adobe Firefly Services",
    kind: "image",
    models: [{ model: "firefly-image-4", modes: ["image"], maxDurationSec: 0, resolutions: ["2048"], notes: "~$0.08 · 상업 라이선스 안전 · structure/style ref · generative fill" }],
    supportsFirstLastFrame: false,
    supportsRefImage: true,
    refImageCount: 2,
    nativeAudio: false,
    strengths: ["상업 사용 라이선스 안전(엔터프라이즈)", "structure/style reference", "업스케일·제너레이티브 필"],
    weaknesses: ["크리에이티브 다양성 보수적", "크레딧 기반 가격"],
    approxCostUsd: 0.08,
    bestFor: "브랜드 세이프 상업 광고 asset",
    vaultKey: "FIREFLY_API_KEY",
    status: "active",
  },
  {
    id: "sora",
    name: "OpenAI Sora 2",
    kind: "video",
    models: [{ model: "sora-2", modes: ["text_to_video", "image_to_video"], maxDurationSec: 12, resolutions: ["720p", "1080p"], notes: "API 2026-09-24 종료. 신규 의존 금지." }],
    supportsFirstLastFrame: false,
    supportsRefImage: false,
    refImageCount: 0,
    nativeAudio: true,
    strengths: ["프롬프트 표현력"],
    weaknesses: ["API 종료 예정(2026-09-24)", "후속 미발표", "core dependency 위험"],
    approxCostUsd: 2.0,
    bestFor: "사용 안 함 (sunset) — Veo/Seedance로 마이그레이션",
    vaultKey: "OPENAI_API_KEY",
    status: "sunset",
  },
];

export const VIDEO_PROVIDERS = PROVIDERS.filter((p) => p.kind === "video" && p.status === "active");
export const IMAGE_PROVIDERS = PROVIDERS.filter((p) => p.kind === "image" && p.status === "active");

export function providerById(id: string): ProviderProfile | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ── 라우팅 로직 ──────────────────────────────────────────
// 샷의 의도(키프레임 필요, 사이즈/움직임, 대사 유무, 예산)에 따라
// 가장 맞는 영상 프로바이더와 모드를 고른다.

export interface VideoRoutingInput {
  needsKeyframes: boolean;
  hasDialogue: boolean;
  movementEnergy: number; // 0-1
  size: ShotSize;
  premium: boolean; // 최고 품질 우선 (비용 무시)
}

export interface VideoRoutingResult {
  providerId: string;
  mode: ProviderMode;
  reason: string;
}

export function routeVideoProvider(input: VideoRoutingInput): VideoRoutingResult {
  const { needsKeyframes, hasDialogue, movementEnergy, size, premium } = input;

  // 1) 대사·립싱크·오디오 동기 → Veo (네이티브 오디오 + first/last + 인물 일관성)
  if (hasDialogue) {
    return {
      providerId: "veo",
      mode: needsKeyframes ? "first_last_frame" : "image_to_video",
      reason: "대사·립싱크·동기 오디오 → Veo 3.1 (네이티브 오디오)",
    };
  }

  // 2) 정밀 컷 연결(first/last) 필요 클로즈업 → Veo (정합 우선)
  if (needsKeyframes && (size === "CU" || size === "ECU" || size === "MCU")) {
    return { providerId: "veo", mode: "first_last_frame", reason: "정밀 컷 연결(first/last) + 인물 정합 → Veo 3.1" };
  }

  // 3) 프리미엄 최고 화질 (비용 무시) → Seedance (리더보드 1위)
  if (premium) {
    return {
      providerId: "seedance",
      mode: needsKeyframes ? "first_last_frame" : "image_to_video",
      reason: "최고 화질·다중 레퍼런스 조건 → Seedance 2.0",
    };
  }

  // 4) 큰 카메라 무브·영화적 establishing → Luma (모션·물리·저비용)
  if (movementEnergy >= 0.7) {
    return { providerId: "luma", mode: "image_to_video", reason: "영화적 카메라 무브·물리 정합 → Luma Ray 2" };
  }

  // 5) 그 외 범용·다량 후보 → Runway (툴링·레퍼런스)
  return { providerId: "runway", mode: "image_to_video", reason: "범용 테이크·레퍼런스 구동 → Runway Gen-4.5" };
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
