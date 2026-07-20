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
  | "glm"
  | "kimi"
  | "deepseek"
  | "minimax"
  | "xai"
  | "openrouter";

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

// Provider model IDs are intentionally not compiled into the app. The main
// process reads each provider's live catalog and the UI always offers a manual
// model-ID escape hatch. This keeps new model generations usable without a
// desktop release. Unknown capabilities stay unknown; we never invent a
// context-window or multimodal claim from a model-name regex.
export const BYOK_MODELS: Record<ByokBackend, ModelOption[]> = {
  anthropic: [],
  openai: [],
  google: [],
  upstage: [],
  custom: [],
  glm: [],
  kimi: [],
  deepseek: [],
  minimax: [],
  xai: [],
  openrouter: [],
};

/** No versioned BYOK default is pinned. Discovery/manual selection is authoritative. */
export const DEFAULT_BYOK_MODEL: Partial<Record<ByokBackend, string>> = {};

const BYOK_BACKENDS_ALL: ByokBackend[] = [
  "anthropic",
  "openai",
  "google",
  "upstage",
  "custom",
  "glm",
  "kimi",
  "deepseek",
  "minimax",
  "xai",
  "openrouter",
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
  kimi: "runtime",
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

// CLI inventories are runtime-authoritative. Only vendor-maintained aliases or
// non-versioned automatic selectors live here as offline fallbacks.
export const CLI_MODELS: Partial<Record<RuntimeKind, CliModelOption[]>> = {
  // Claude Code aliases follow the account's current generation.
  "claude-code": [
    { id: "opus", label: "Opus", workforceTier: "frontier" },
    { id: "sonnet", label: "Sonnet", workforceTier: "balanced" },
    { id: "haiku", label: "Haiku", workforceTier: "economy" },
  ],
  codex: [],
  gemini: [],
  // Kimi Code membership chooses the live account model. Keep the model
  // omitted unless the CLI itself exposes an authoritative inventory.
  kimi: [],
  grok: [],
  cursor: [{ id: "auto", label: "Cursor Auto" }],
};

const DISCOVERED_CLI_MODELS = new Map<string, CliModelOption[]>();

// Codex publishes capacity siblings with stable semantic suffixes while the
// version prefix changes. Classify the suffix, never a versioned model ID.
// Completing a family only after two siblings were actually discovered keeps
// the host's Workforce tier map coherent without turning these inferred
// siblings into picker options; RuntimeStatus.availableModels remains the
// signed-in account's exact inventory.
const CODEX_WORKFORCE_SUFFIXES = [
  { suffix: "-sol", workforceTier: "frontier" },
  { suffix: "-terra", workforceTier: "balanced" },
  { suffix: "-luna", workforceTier: "economy" },
] as const satisfies ReadonlyArray<{
  suffix: string;
  workforceTier: NonNullable<CliModelOption["workforceTier"]>;
}>;

function codexTier(id: string): CliModelOption["workforceTier"] {
  return CODEX_WORKFORCE_SUFFIXES.find((entry) => id.endsWith(entry.suffix))?.workforceTier;
}

/** Register a runtime-owned CLI inventory without compiling model versions into Desktop. */
export function registerDiscoveredCliModels(kind: string, modelIds: readonly string[]): void {
  const unique = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
  const models = unique.map((id) => ({ id, label: id, ...(codexTier(id) ? { workforceTier: codexTier(id) } : {}) }));

  if (kind === "codex") {
    const families = new Map<string, Set<string>>();
    for (const id of unique) {
      const match = CODEX_WORKFORCE_SUFFIXES.find((entry) => id.endsWith(entry.suffix));
      if (!match) continue;
      const prefix = id.slice(0, -match.suffix.length);
      if (!prefix) continue;
      const siblings = families.get(prefix) ?? new Set<string>();
      siblings.add(match.suffix);
      families.set(prefix, siblings);
    }
    for (const [prefix, siblings] of families) {
      if (siblings.size < 2) continue;
      for (const entry of CODEX_WORKFORCE_SUFFIXES) {
        const id = `${prefix}${entry.suffix}`;
        if (!models.some((model) => model.id === id)) {
          models.push({ id, label: id, workforceTier: entry.workforceTier });
        }
      }
    }
  }

  DISCOVERED_CLI_MODELS.set(kind, models);
}

export function cliModels(kind: string): CliModelOption[] {
  return DISCOVERED_CLI_MODELS.get(kind) ??
    (CLI_MODELS as Record<string, CliModelOption[] | undefined>)[kind] ??
    [];
}

// ── 작업량(reasoning effort) — installed runtime discovery only ─────
export interface EffortOption {
  id: string;
  label: string;
}
export const CLAUDE_EFFORTS: EffortOption[] = [];

/** Static effort fallbacks are intentionally empty; detect.ts supplies live values. */
export function runtimeEfforts(_kind: string): EffortOption[] {
  return [];
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
