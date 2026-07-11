import type { AgentEnvRequirement } from "./types";

export type MultimodalModality = "image" | "video" | "audio";

export type MultimodalProviderMode =
  | "cli-subscription"
  | "api-key"
  | "cloud-credentials"
  | "browser-delegated";

export interface MultimodalProvider {
  id: string;
  modality: MultimodalModality;
  label: string;
  labelKo: string;
  mode: MultimodalProviderMode;
  defaultModel?: string;
  envKeys: string[];
  setupUrl: string;
  docsUrl: string;
  billing: "subscription" | "paid-api" | "provider-billing";
  summary: string;
  summaryKo: string;
}

export interface MultimodalSettings {
  imageProvider: string;
  videoProvider: string;
  audioProvider: string;
  updatedAt?: string;
}

export interface MultimodalProviderStatus {
  modality: MultimodalModality;
  provider: MultimodalProvider;
  env: Array<{ key: string; hasValue: boolean }>;
  ready: boolean;
  /** 이 status가 "auto"(자동 선택) 해석 결과일 때 true — 패널의 자동 카드에 매칭한다. */
  auto?: boolean;
}

/**
 * "auto" = 지정 없이 가용한 엔진을 자동으로 고르라는 뜻.
 * 우선순위는 키 없는(구독/OAuth) 엔진 먼저 → 유료 API 순서(아래 *_PROVIDER_LADDER).
 */
export const AUTO_PROVIDER = "auto";

export const MULTIMODAL_PROVIDERS: MultimodalProvider[] = [
  {
    id: "codex-cli-image",
    modality: "image",
    label: "Codex CLI image",
    labelKo: "Codex CLI 이미지",
    mode: "cli-subscription",
    defaultModel: "runtime-default",
    envKeys: [],
    setupUrl: "https://developers.openai.com/codex",
    docsUrl: "https://developers.openai.com/codex",
    billing: "subscription",
    summary: "Uses the user's logged-in Codex/OpenAI subscription runtime when available.",
    summaryKo: "로그인된 Codex/OpenAI 구독 런타임을 우선 사용합니다.",
  },
  {
    id: "nanobanana-image",
    modality: "image",
    label: "Nano Banana (Antigravity CLI)",
    labelKo: "나노바나나 (Antigravity CLI)",
    mode: "cli-subscription",
    defaultModel: "gemini-image",
    envKeys: [],
    setupUrl: "https://antigravity.google/",
    docsUrl: "https://antigravity.google/",
    billing: "subscription",
    summary: "Keyless Gemini image (Nano Banana) via the logged-in Antigravity CLI (agy). No API key needed.",
    summaryKo: "로그인된 Antigravity CLI(agy)로 키 없이 Gemini 이미지(나노바나나)를 생성합니다. API 키 불필요.",
  },
  {
    id: "grok-cli-image",
    modality: "image",
    label: "Grok CLI image (Imagine)",
    labelKo: "Grok CLI 이미지 (Imagine)",
    mode: "cli-subscription",
    defaultModel: "grok-imagine-image",
    envKeys: [],
    setupUrl: "https://x.ai/cli",
    docsUrl: "https://x.ai/cli",
    billing: "subscription",
    summary: "Keyless Grok Imagine image generation via the logged-in official xAI Grok CLI (image_gen). No API key needed.",
    summaryKo: "로그인된 공식 xAI Grok CLI로 키 없이 Grok Imagine 이미지를 생성합니다(image_gen). API 키 불필요.",
  },
  {
    id: "openai-image",
    modality: "image",
    label: "OpenAI Images API",
    labelKo: "OpenAI 이미지 API",
    mode: "api-key",
    defaultModel: "gpt-image-2",
    envKeys: ["OPENAI_API_KEY"],
    setupUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://developers.openai.com/api/docs/guides/image-generation",
    billing: "paid-api",
    summary: "GPT Image generation and editing through OpenAI API keys.",
    summaryKo: "OpenAI API 키로 GPT Image 생성·편집을 실행합니다.",
  },
  {
    id: "google-image",
    modality: "image",
    label: "Google Imagen",
    labelKo: "Google Imagen",
    mode: "api-key",
    defaultModel: "imagen-4.0-generate-001",
    envKeys: ["GEMINI_API_KEY"],
    setupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs/imagen",
    billing: "paid-api",
    summary: "Imagen keyframe generation through Google AI Studio Gemini API keys.",
    summaryKo: "Google AI Studio Gemini API 키로 Imagen 키프레임 생성을 실행합니다.",
  },
  {
    id: "stability-image",
    modality: "image",
    label: "Stability AI",
    labelKo: "Stability AI",
    mode: "api-key",
    defaultModel: "stable-image-core",
    envKeys: ["STABILITY_API_KEY"],
    setupUrl: "https://platform.stability.ai/account/keys",
    docsUrl: "https://platform.stability.ai/docs/api-reference",
    billing: "paid-api",
    summary: "Image generation fallback for Stable Image and related hosted models.",
    summaryKo: "Stable Image 계열 호스팅 모델을 쓰는 이미지 fallback입니다.",
  },
  {
    id: "adobe-firefly",
    modality: "image",
    label: "Adobe Firefly Services",
    labelKo: "Adobe Firefly Services",
    mode: "cloud-credentials",
    defaultModel: "firefly",
    envKeys: ["FIREFLY_SERVICES_CLIENT_ID", "FIREFLY_SERVICES_CLIENT_SECRET"],
    setupUrl: "https://developer.adobe.com/firefly-services/",
    docsUrl: "https://developer.adobe.com/firefly-services/docs/",
    billing: "provider-billing",
    summary: "Adobe Firefly Services for brand-safe image workflows when credentials are available.",
    summaryKo: "Adobe Firefly Services 자격 증명이 있을 때 브랜드 안전 이미지 워크플로에 사용합니다.",
  },
  {
    id: "grok-cli-video",
    modality: "video",
    label: "Grok CLI video (Imagine)",
    labelKo: "Grok CLI 영상 (Imagine)",
    mode: "cli-subscription",
    defaultModel: "grok-imagine-video-1.5-preview",
    envKeys: [],
    setupUrl: "https://x.ai/cli",
    docsUrl: "https://x.ai/cli",
    billing: "subscription",
    summary: "Keyless Grok Imagine image-to-video via the logged-in official xAI Grok CLI (image_to_video, 1-15s). Requires a SuperGrok subscription. No API key needed.",
    summaryKo: "로그인된 공식 xAI Grok CLI로 키 없이 Grok Imagine 영상(이미지→비디오, 1~15초)을 생성합니다(image_to_video). SuperGrok 구독 필요, API 키 불필요.",
  },
  {
    id: "runway-video",
    modality: "video",
    label: "Runway API",
    labelKo: "Runway API",
    mode: "api-key",
    defaultModel: "gen4.5",
    envKeys: ["RUNWAY_API_KEY"],
    setupUrl: "https://dev.runwayml.com/",
    docsUrl: "https://docs.dev.runwayml.com/",
    billing: "paid-api",
    summary: "Primary video fallback for text/image/video-to-video generation tasks.",
    summaryKo: "텍스트·이미지·비디오 기반 영상 생성의 기본 fallback입니다.",
  },
  {
    id: "google-veo",
    modality: "video",
    label: "Google Veo",
    labelKo: "Google Veo",
    mode: "cloud-credentials",
    defaultModel: "veo-3.1-lite-generate-001",
    envKeys: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
    setupUrl: "https://console.cloud.google.com/agent-platform/studio/media/video",
    docsUrl: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate",
    billing: "paid-api",
    summary: "Google Cloud Agent Platform / Veo generation using Application Default Credentials.",
    summaryKo: "Google Cloud Agent Platform ADC 인증으로 Veo 영상을 생성합니다.",
  },
  {
    id: "higgsfield-video",
    modality: "video",
    label: "Higgsfield",
    labelKo: "Higgsfield",
    mode: "api-key",
    defaultModel: "image2video",
    envKeys: ["HIGGSFIELD_API_KEY"],
    setupUrl: "https://docs.higgsfield.ai/",
    docsUrl: "https://docs.higgsfield.ai/",
    billing: "paid-api",
    summary: "Director-grade named camera moves (DoP) and Soul ID character consistency; route via fal/Replicate for headless parallelism.",
    summaryKo: "감독급 네임드 카메라 무브(DoP)와 Soul ID 캐릭터 일관성. 병렬은 fal/Replicate 경유가 깔끔합니다.",
  },
  {
    id: "seedance-video",
    modality: "video",
    label: "Seedance 2.0 (via fal)",
    labelKo: "Seedance 2.0 (fal 경유)",
    mode: "api-key",
    defaultModel: "seedance-2.0",
    envKeys: ["FAL_KEY"],
    setupUrl: "https://fal.ai/dashboard/keys",
    docsUrl: "https://fal.ai/models/fal-ai/bytedance/seedance",
    billing: "paid-api",
    summary: "ByteDance Seedance 2.0 — bulk parallel workhorse: native audio, up to 12 reference files, lowest cost/highest throughput via aggregators.",
    summaryKo: "ByteDance Seedance 2.0 — 병렬 주력. 네이티브 오디오, 레퍼런스 최대 12개, 애그리게이터로 최저 비용·최고 처리량.",
  },
  {
    id: "luma-video",
    modality: "video",
    label: "Luma Ray 3",
    labelKo: "Luma Ray 3",
    mode: "api-key",
    defaultModel: "ray-3",
    envKeys: ["LUMA_API_KEY"],
    setupUrl: "https://lumalabs.ai/api/keys",
    docsUrl: "https://docs.lumalabs.ai/",
    billing: "paid-api",
    summary: "Luma Ray 3 — fast cheap establishing/insert shots; Character-Reference on base Ray 3; buy Scale units for guaranteed parallel capacity.",
    summaryKo: "Luma Ray 3 — 빠르고 저렴한 establishing/insert. base Ray 3 캐릭터 레퍼런스. 병렬 보장은 Scale 유닛.",
  },
  {
    id: "kling-video",
    modality: "video",
    label: "Kling 2.x (via aggregator)",
    labelKo: "Kling 2.x (애그리게이터)",
    mode: "api-key",
    defaultModel: "kling-2.5",
    envKeys: ["PIAPI_KEY"],
    setupUrl: "https://piapi.ai/workspace/key",
    docsUrl: "https://piapi.ai/docs/kling-api",
    billing: "paid-api",
    summary: "Kuaishou Kling — cheap high-quality i2v fill; official cap ~5 concurrent, route via PiAPI/fal for 20+ parallel.",
    summaryKo: "Kuaishou Kling — 저가 고품질 i2v. 공식 동시성 ~5라 PiAPI/fal로 20+ 병렬 라우팅.",
  },
  {
    id: "replicate-video",
    modality: "video",
    label: "Replicate",
    labelKo: "Replicate",
    mode: "api-key",
    defaultModel: "provider-model",
    envKeys: ["REPLICATE_API_TOKEN"],
    setupUrl: "https://replicate.com/account/api-tokens",
    docsUrl: "https://replicate.com/docs/reference/http",
    billing: "paid-api",
    summary: "Broad fallback for hosted open video, image, and audio models.",
    summaryKo: "호스팅 오픈 영상·이미지·오디오 모델을 넓게 쓰는 fallback입니다.",
  },
  {
    id: "openai-audio",
    modality: "audio",
    label: "OpenAI Audio",
    labelKo: "OpenAI 오디오",
    mode: "api-key",
    defaultModel: "gpt-4o-mini-tts",
    envKeys: ["OPENAI_API_KEY"],
    setupUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://developers.openai.com/api/docs/guides/text-to-speech",
    billing: "paid-api",
    summary: "Speech generation and transcription through OpenAI audio endpoints.",
    summaryKo: "OpenAI 오디오 endpoint로 음성 생성·전사를 처리합니다.",
  },
  {
    id: "elevenlabs-audio",
    modality: "audio",
    label: "ElevenLabs",
    labelKo: "ElevenLabs",
    mode: "api-key",
    defaultModel: "eleven_multilingual_v2",
    envKeys: ["ELEVENLABS_API_KEY"],
    setupUrl: "https://elevenlabs.io/app/settings/api-keys",
    docsUrl: "https://elevenlabs.io/docs/api-reference/text-to-speech/convert",
    billing: "paid-api",
    summary: "Voice generation fallback for production-grade TTS and voice design.",
    summaryKo: "프로덕션급 TTS와 음성 디자인용 음성 생성 fallback입니다.",
  },
  {
    id: "deepgram-audio",
    modality: "audio",
    label: "Deepgram",
    labelKo: "Deepgram",
    mode: "api-key",
    defaultModel: "nova-3",
    envKeys: ["DEEPGRAM_API_KEY"],
    setupUrl: "https://console.deepgram.com/",
    docsUrl: "https://developers.deepgram.com/documentation/",
    billing: "paid-api",
    summary: "Speech-to-text and realtime voice fallback for agent voice workflows.",
    summaryKo: "에이전트 음성 워크플로의 전사·실시간 음성 fallback입니다.",
  },
];

export const DEFAULT_MULTIMODAL_SETTINGS: MultimodalSettings = {
  // 기본값 = auto. 사용자가 따로 고르지 않으면 가용한 엔진(키리스 우선)을 자동 선택한다.
  imageProvider: AUTO_PROVIDER,
  // 영상도 auto — 실제 키/자격 증명이 확인된 provider만 선택한다.
  videoProvider: AUTO_PROVIDER,
  audioProvider: "openai-audio",
};

/**
 * "auto"일 때 시도 순서 — 키 없는(구독/OAuth) 엔진 먼저, 그다음 유료 API.
 * 런타임 가용성(bin/키 존재)은 electron 쪽 resolveActiveProvider가 이 순서대로 검사한다.
 */
export const PROVIDER_LADDERS: Record<MultimodalModality, string[]> = {
  image: [
    "codex-cli-image",
    "nanobanana-image",
    "grok-cli-image",
    "openai-image",
    "google-image",
    "stability-image",
    "adobe-firefly",
  ],
  video: [
    "grok-cli-video",
    "google-veo",
    "kling-video",
    "seedance-video",
    "runway-video",
    "luma-video",
    "replicate-video",
  ],
  audio: ["openai-audio", "elevenlabs-audio", "deepgram-audio"],
};

export function providerLadder(modality: MultimodalModality): MultimodalProvider[] {
  return PROVIDER_LADDERS[modality]
    .map((id) => getMultimodalProvider(id))
    .filter((p): p is MultimodalProvider => Boolean(p));
}

export function providersForModality(modality: MultimodalModality): MultimodalProvider[] {
  return MULTIMODAL_PROVIDERS.filter((provider) => provider.modality === modality);
}

export function getMultimodalProvider(id: string): MultimodalProvider | null {
  return MULTIMODAL_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function normalizeMultimodalSettings(input?: Partial<MultimodalSettings> | null): MultimodalSettings {
  const imageProvider = validProvider(input?.imageProvider, "image", DEFAULT_MULTIMODAL_SETTINGS.imageProvider);
  const videoProvider = validProvider(input?.videoProvider, "video", DEFAULT_MULTIMODAL_SETTINGS.videoProvider);
  const audioProvider = validProvider(input?.audioProvider, "audio", DEFAULT_MULTIMODAL_SETTINGS.audioProvider);
  return {
    imageProvider,
    videoProvider,
    audioProvider,
    ...(input?.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

export function selectedMultimodalProviders(settings: MultimodalSettings): MultimodalProvider[] {
  return [
    getMultimodalProvider(settings.imageProvider),
    getMultimodalProvider(settings.videoProvider),
    getMultimodalProvider(settings.audioProvider),
  ].filter((provider): provider is MultimodalProvider => Boolean(provider));
}

export function selectedMultimodalEnvKeys(settings: MultimodalSettings): string[] {
  const keys = selectedMultimodalProviders(settings).flatMap((provider) => provider.envKeys);
  return [...new Set(keys)].sort();
}

export function selectedMultimodalEnvRequirements(settings: MultimodalSettings): AgentEnvRequirement[] {
  const reqs = selectedMultimodalProviders(settings).flatMap((provider) =>
    provider.envKeys.map((key) => ({
      key,
      label: `${provider.label} key`,
      labelEn: `${provider.label} key`,
      required: provider.envKeys.length > 0,
      hint: provider.setupUrl,
      hintEn: provider.setupUrl,
    })),
  );
  const dedup = new Map<string, AgentEnvRequirement>();
  for (const req of reqs) {
    if (!dedup.has(req.key)) dedup.set(req.key, req);
  }
  return [...dedup.values()];
}

function validProvider(id: string | undefined, modality: MultimodalModality, fallback: string): string {
  if (id === AUTO_PROVIDER) return AUTO_PROVIDER;
  if (id && MULTIMODAL_PROVIDERS.some((provider) => provider.id === id && provider.modality === modality)) {
    return id;
  }
  return fallback;
}
