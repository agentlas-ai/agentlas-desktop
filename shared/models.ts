// BYOK 모델 카탈로그 + 런타임별 컨텍스트 관리 정책.
// main(러너/감지)과 renderer(설정/채팅 UI)가 공유한다.
//
// 핵심 구분 (CONTEXT_MANAGED_BY):
//  - "runtime"  : CLI 도구(Claude Code/Codex/Gemini)가 세션·컨텍스트 윈도우·압축을 자체적으로
//                 자동 관리한다. Agentlas는 위임만 하고 모델/압축을 손대지 않는다 → UI도 "자동"으로 표기.
//  - "agentlas" : BYOK 직접 API / Ollama — 대화 히스토리를 Agentlas가 직접 들고 있으므로
//                 모델 선택·1M 컨텍스트·히스토리 압축을 Agentlas가 구현/적용한다.
import type { RuntimeKind } from "./types";

export type ByokBackend =
  | "anthropic"
  | "openai"
  | "google"
  | "upstage"
  | "custom"
  // Anthropic Messages API 호환 서드파티(구독/종량제) — base URL만 프리셋으로 바꿔 호출한다.
  | "glm"
  | "kimi"
  | "deepseek";

export interface ModelOption {
  /** vendor API에 그대로 전달되는 모델 ID */
  id: string;
  /** UI 표시 라벨 */
  label: string;
  /** 기본 컨텍스트 윈도우(토큰) — 압축 임계값 산정의 기준 */
  contextWindow: number;
  /** 이미지 입력(멀티모달) 지원 여부 */
  multimodal: boolean;
  /** 긴 컨텍스트(≥1M) 지원 모델이면 설정 */
  longContext?: {
    /** 확장 컨텍스트 토큰 수 (예: 1_000_000) */
    tokens: number;
    /**
     * - "auto"        : 모델이 기본 제공 (헤더/옵션 불필요) — OpenAI GPT-4.1, Gemini 등
     * - "beta-header" : Anthropic 1M 베타 헤더가 있어야 활성 → 사용자 토글(opt-in)
     */
    mode: "auto" | "beta-header";
  };
}

/** Anthropic 1M 컨텍스트 베타 헤더 값. beta-header 모델 + 사용자 토글 ON일 때만 전송. */
export const ANTHROPIC_1M_BETA = "context-1m-2025-08-07";

// ── 카탈로그 ─────────────────────────────────────────────
// 모델 ID/세대는 여기서만 관리. 새 모델 추가는 이 배열에 한 줄.
export const BYOK_MODELS: Record<ByokBackend, ModelOption[]> = {
  anthropic: [
    {
      id: "claude-opus-4-8",
      label: "Claude Opus 4.8",
      contextWindow: 200_000,
      multimodal: true,
      longContext: { tokens: 1_000_000, mode: "beta-header" },
    },
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      contextWindow: 200_000,
      multimodal: true,
      longContext: { tokens: 1_000_000, mode: "beta-header" },
    },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5",
      contextWindow: 200_000,
      multimodal: true,
    },
  ],
  openai: [
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      contextWindow: 1_000_000,
      multimodal: true,
      longContext: { tokens: 1_000_000, mode: "auto" },
    },
    { id: "gpt-4o", label: "GPT-4o", contextWindow: 128_000, multimodal: true },
    { id: "gpt-4o-mini", label: "GPT-4o mini", contextWindow: 128_000, multimodal: true },
  ],
  google: [
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      contextWindow: 1_000_000,
      multimodal: true,
      longContext: { tokens: 1_000_000, mode: "auto" },
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      contextWindow: 1_000_000,
      multimodal: true,
      longContext: { tokens: 1_000_000, mode: "auto" },
    },
    {
      id: "gemini-1.5-flash",
      label: "Gemini 1.5 Flash",
      contextWindow: 1_000_000,
      multimodal: true,
      longContext: { tokens: 1_000_000, mode: "auto" },
    },
  ],
  // Upstage Solar — Korean sovereign LLM (OpenAI-compatible API). Text-only (no multimodal).
  upstage: [
    { id: "solar-pro2", label: "Solar Pro 2 (한국 소버린)", contextWindow: 65_536, multimodal: false },
    {
      id: "solar-pro3",
      label: "Solar Pro 3",
      contextWindow: 131_072,
      multimodal: false,
      longContext: { tokens: 131_072, mode: "auto" },
    },
    { id: "solar-mini", label: "Solar Mini", contextWindow: 32_768, multimodal: false },
  ],
  custom: [
    { id: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 64_000, multimodal: false },
    { id: "grok-2-latest", label: "Grok 2", contextWindow: 131_072, multimodal: false },
    { id: "glm-4", label: "GLM-4", contextWindow: 128_000, multimodal: false },
    { id: "custom", label: "Other Compatible Model", contextWindow: 128_000, multimodal: false }
  ],
  // ── Anthropic Messages API 호환 서드파티 ──────────────────
  // 모델 ID는 각 프로바이더가 자체 관리 — 세대가 바뀌면 갱신. 잘못된 ID는 서버가 거부할 뿐 크래시 없음.
  // "custom" 항목으로 사용자가 최신 모델명을 직접 입력할 수 있게 둔다.
  glm: [
    { id: "glm-4.6", label: "GLM-4.6", contextWindow: 200_000, multimodal: false },
    { id: "glm-4.5-air", label: "GLM-4.5 Air", contextWindow: 128_000, multimodal: false },
    { id: "custom", label: "다른 GLM 모델 직접 입력", contextWindow: 200_000, multimodal: false },
  ],
  kimi: [
    { id: "kimi-k2-0711-preview", label: "Kimi K2", contextWindow: 128_000, multimodal: false },
    { id: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo", contextWindow: 128_000, multimodal: false },
    { id: "custom", label: "다른 Kimi 모델 직접 입력", contextWindow: 128_000, multimodal: false },
  ],
  deepseek: [
    { id: "deepseek-chat", label: "DeepSeek Chat (V3)", contextWindow: 64_000, multimodal: false },
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)", contextWindow: 64_000, multimodal: false },
    { id: "custom", label: "다른 DeepSeek 모델 직접 입력", contextWindow: 64_000, multimodal: false },
  ],
};

/** 백엔드별 기본 모델 — 사용자가 명시 선택 전 fallback. */
export const DEFAULT_BYOK_MODEL: Record<ByokBackend, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
  upstage: "solar-pro2",
  custom: "deepseek-chat",
  glm: "glm-4.6",
  kimi: "kimi-k2-0711-preview",
  deepseek: "deepseek-chat",
};

const BYOK_BACKENDS_ALL: ByokBackend[] = [
  "anthropic",
  "openai",
  "google",
  "upstage",
  "custom",
  "glm",
  "kimi",
  "deepseek",
];

function isByokBackend(backend: string): backend is ByokBackend {
  return (BYOK_BACKENDS_ALL as string[]).includes(backend);
}

/**
 * Anthropic Messages API 호환 서드파티 프로바이더 프리셋.
 * base URL만 프리셋으로 바꾸면 Claude 호환 클라이언트(우리 앱 포함)로 그대로 호출된다.
 * 사용자는 키만 입력하면 되고(연결 시 base URL 자동 주입), 구독 플랜이 있으면 그 키로 구독 쿼터를 쓴다.
 */
export interface AnthropicCompatProvider {
  label: string;
  /** `${baseUrl}/v1/messages` 로 호출 */
  baseUrl: string;
  /** 키 발급 페이지 */
  signupUrl: string;
  /** 정액 구독(코딩 플랜) 존재 여부 — UI 안내용 */
  hasSubscription: boolean;
}

export const ANTHROPIC_COMPAT_PROVIDERS: Partial<Record<ByokBackend, AnthropicCompatProvider>> = {
  glm: {
    label: "GLM (Z.ai)",
    baseUrl: "https://api.z.ai/api/anthropic",
    signupUrl: "https://z.ai/subscribe",
    hasSubscription: true,
  },
  kimi: {
    label: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.ai/anthropic",
    signupUrl: "https://platform.moonshot.ai/console/api-keys",
    hasSubscription: true,
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    signupUrl: "https://platform.deepseek.com/api_keys",
    hasSubscription: false,
  },
};

export function anthropicCompatProvider(backend: string): AnthropicCompatProvider | undefined {
  return (ANTHROPIC_COMPAT_PROVIDERS as Record<string, AnthropicCompatProvider | undefined>)[backend];
}

export function byokModels(backend: string): ModelOption[] {
  return isByokBackend(backend) ? BYOK_MODELS[backend] : [];
}

export function findByokModel(
  backend: string,
  id: string | null | undefined,
): ModelOption | undefined {
  if (!id) return undefined;
  return byokModels(backend).find((m) => m.id === id);
}

export function defaultByokModel(backend: string): string | undefined {
  return isByokBackend(backend) ? DEFAULT_BYOK_MODEL[backend] : undefined;
}

/**
 * 모델이 긴 컨텍스트를 "지금" 쓸 수 있으면 토큰 수, 아니면 null.
 * - auto 모드: 항상 사용 가능
 * - beta-header 모드: enabled(사용자 토글)가 true일 때만
 */
export function activeLongContextTokens(
  backend: string,
  id: string | null | undefined,
  enabled: boolean,
): number | null {
  const m = findByokModel(backend, id);
  if (!m?.longContext) return null;
  if (m.longContext.mode === "auto" || enabled) return m.longContext.tokens;
  return null;
}

/** 압축 임계값 산정용 — 긴 컨텍스트가 활성이면 그 토큰, 아니면 모델 기본 윈도우. */
export function effectiveContextWindow(
  backend: string,
  id: string | null | undefined,
  longEnabled: boolean,
): number {
  const m = findByokModel(backend, id);
  const long = activeLongContextTokens(backend, id, longEnabled);
  return long ?? m?.contextWindow ?? 128_000;
}

/** beta-header 토글이 의미 있는 모델인지 (UI에 1M 토글을 보여줄지 결정) */
export function needsLongContextToggle(
  backend: string,
  id: string | null | undefined,
): boolean {
  return findByokModel(backend, id)?.longContext?.mode === "beta-header";
}

/** 컨텍스트/압축을 누가 관리하는가. [[runner]] 위임 정책의 단일 출처. */
export const CONTEXT_MANAGED_BY: Record<RuntimeKind, "runtime" | "agentlas"> = {
  "claude-code": "runtime",
  codex: "runtime",
  gemini: "runtime",
  grok: "runtime",
  cursor: "runtime",
  byok: "agentlas",
  ollama: "agentlas",
  lmstudio: "agentlas",
  mlx: "agentlas",
};

// ── CLI 런타임 모델 선택 ──────────────────────────────────
// CLI 도구는 컨텍스트·압축을 자체 관리하지만(CONTEXT_MANAGED_BY === "runtime"),
// 모델은 `--model`(또는 codex/gemini의 -m)로 고를 수 있다. 컨텍스트 관리와 모델 선택은 독립.
// 빈 model(undefined)은 "구독 기본 모델" — --model을 전달하지 않는다.
//
// 헤드리스(-p) 한계: Claude Code의 인터랙티브 메뉴에 있는 "빠른 모드"와 `model[1m]`(1M) 변형은
// CLI 플래그가 없어 옮길 수 없다. 대신 claude는 `--effort`(작업량)를 지원한다.
/** 보조 표기 키. 라벨은 하드코딩하지 말고 cliModelTagLabel()로 로케일 변환. */
export type CliModelTag = "legacy" | "preview";

export interface CliModelOption {
  /** CLI 모델 플래그에 전달하는 값. claude는 opus/sonnet/haiku 별칭 또는 풀ID(claude-opus-4-7 등) */
  id: string;
  label: string;
  /** Host-authored Workforce capacity tier. Omitted when the host has no stable classification. */
  workforceTier?: "economy" | "balanced" | "frontier";
  /** 보조 표기 키(로케일 무관). 표시 라벨은 cliModelTagLabel(tag, locale). */
  tag?: CliModelTag;
}

// tag 키 → 로케일별 표시 라벨. IPC로는 키만 넘기고, 렌더러에서 로케일에 맞춰 변환.
const CLI_MODEL_TAG_LABELS: Record<CliModelTag, { ko: string; en: string }> = {
  legacy: { ko: "레거시", en: "Legacy" },
  preview: { ko: "프리뷰", en: "Preview" },
};

/** CLI 모델의 보조 표기(tag)를 로케일 라벨로. tag 없으면 빈 문자열. */
export function cliModelTagLabel(tag: string | undefined, locale: string): string {
  if (!tag) return "";
  const entry = CLI_MODEL_TAG_LABELS[tag as CliModelTag];
  if (!entry) return tag;
  return locale === "ko" ? entry.ko : entry.en;
}

// 모델 ID/라벨은 여기서만 관리 — 새 세대는 이 배열에 한 줄. 잘못된 ID는 CLI가 거부할 뿐 크래시 없음.
export const CLI_MODELS: Partial<Record<RuntimeKind, CliModelOption[]>> = {
  // Claude Code — `claude --model`. 별칭(opus/sonnet/haiku)은 항상 최신, 레거시는 풀ID.
  "claude-code": [
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "opus", label: "Opus 4.8", workforceTier: "frontier" },
    { id: "sonnet", label: "Sonnet 4.6", workforceTier: "balanced" },
    { id: "haiku", label: "Haiku 4.5", workforceTier: "economy" },
    { id: "claude-opus-4-7", label: "Opus 4.7", tag: "legacy", workforceTier: "frontier" },
    { id: "claude-opus-4-6", label: "Opus 4.6", tag: "legacy", workforceTier: "frontier" },
  ],
  // Codex — `codex exec -m <model>`. 구독 기본 외 명시 모델.
  codex: [
    // Modern Codex uses the GPT family directly. This is only an offline
    // fallback/label catalog; detect.ts prefers the signed-in account's
    // ~/.codex/models_cache.json and never invents a `gpt-5.6-codex` alias.
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", tag: "preview", workforceTier: "frontier" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", tag: "preview", workforceTier: "balanced" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", tag: "preview", workforceTier: "economy" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", tag: "legacy" },
  ],
  // Gemini — `gemini -m <model>`.
  gemini: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  // Grok CLI — `grok --model <id>` (GROK_MODEL). 정적 폴백 — detect가 `grok models`로 라이브 목록을 덮어쓴다.
  grok: [
    { id: "grok-4.5", label: "Grok 4.5" },
    { id: "grok-4.3", label: "Grok 4.3" },
    { id: "grok-4.20-non-reasoning", label: "Grok 4.20" },
  ],
  // Cursor Agent CLI — Auto is the safe default because Cursor's subscription
  // inventory changes per account. Composer is the dedicated Cursor model.
  cursor: [
    { id: "auto", label: "Cursor Auto" },
    { id: "composer-2.5", label: "Composer 2.5" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "opus-4.8", label: "Opus 4.8" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

export function cliModels(kind: string): CliModelOption[] {
  return (CLI_MODELS as Record<string, CliModelOption[] | undefined>)[kind] ?? [];
}

// ── 작업량(reasoning effort) — Claude Code `--effort` 전용 ─────
// CLI 값: low/medium/high/xhigh/max. (xhigh = 인터랙티브 메뉴의 "Extra")
export interface EffortOption {
  id: string;
  label: string;
}
export const CLAUDE_EFFORTS: EffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra" },
  { id: "max", label: "Max" },
];

/** 이 런타임이 작업량(effort) 선택을 지원하는가 — 현재 claude-code만. */
export function runtimeEfforts(kind: string): EffortOption[] {
  return kind === "claude-code" ? CLAUDE_EFFORTS : [];
}

/** 이 런타임이 모델 선택 UI를 가질 수 있는가 (BYOK = 항상, CLI = 카탈로그 있을 때, ollama = 받은 모델 있을 때 UI에서 판단) */
export function hasModelPicker(kind: string): boolean {
  return kind === "byok" || cliModels(kind).length > 0;
}

/** 런타임 상태로부터 모델 옵션 목록 — BYOK 카탈로그 / CLI 카탈로그 / Ollama 동적 목록 통합. */
export function modelOptionsFor(
  kind: string,
  backend: string | null | undefined,
  availableModels?: string[] | null,
): CliModelOption[] {
  if (kind === "byok") {
    return byokModels(backend ?? "").map((m) => ({ id: m.id, label: m.label }));
  }
  if (kind === "ollama" || kind === "lmstudio" || kind === "mlx") {
    return (availableModels ?? []).map((m) => ({ id: m, label: m }));
  }
  // Cursor's `agent models` (and future CLI discovery adapters) is the
  // account-authoritative source. Preserve unknown new IDs instead of hiding
  // them behind a stale UI catalog.
  if (availableModels && availableModels.length > 0) {
    const catalog = cliModels(kind);
    return availableModels.map((id) => catalog.find((item) => item.id === id) ?? { id, label: id });
  }
  return cliModels(kind);
}
