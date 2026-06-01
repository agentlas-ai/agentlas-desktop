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
}

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
    label: "Google Gemini Image",
    labelKo: "Google Gemini 이미지",
    mode: "api-key",
    defaultModel: "gemini-3.1-flash-image",
    envKeys: ["GOOGLE_API_KEY"],
    setupUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs/image-generation",
    billing: "paid-api",
    summary: "Gemini/Nano Banana image generation and editing via Google AI Studio keys.",
    summaryKo: "Google AI Studio 키로 Gemini/Nano Banana 이미지 생성·편집을 실행합니다.",
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
    defaultModel: "veo",
    envKeys: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"],
    setupUrl: "https://console.cloud.google.com/vertex-ai/media-studio",
    docsUrl: "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/overview",
    billing: "provider-billing",
    summary: "Vertex AI Veo for high-end video generation with Google Cloud credentials.",
    summaryKo: "Google Cloud 자격 증명으로 Vertex AI Veo 고품질 영상 생성을 실행합니다.",
  },
  {
    id: "openai-sora",
    modality: "video",
    label: "OpenAI Sora API",
    labelKo: "OpenAI Sora API",
    mode: "api-key",
    defaultModel: "sora",
    envKeys: ["OPENAI_API_KEY"],
    setupUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://developers.openai.com/api/docs/guides/video-generation",
    billing: "paid-api",
    summary: "OpenAI video generation fallback when the account has Sora API access.",
    summaryKo: "계정에 Sora API 접근 권한이 있을 때 OpenAI 영상 생성 fallback으로 사용합니다.",
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
    summary: "Creator-video provider slot for Higgsfield-style cinematic workflows.",
    summaryKo: "Higgsfield 계열 시네마틱 크리에이터 영상 워크플로용 provider 슬롯입니다.",
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
  imageProvider: "codex-cli-image",
  videoProvider: "runway-video",
  audioProvider: "openai-audio",
};

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
  if (id && MULTIMODAL_PROVIDERS.some((provider) => provider.id === id && provider.modality === modality)) {
    return id;
  }
  return fallback;
}
