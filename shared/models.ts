// BYOK 모델 카탈로그 + 런타임별 컨텍스트 관리 정책.
// main(러너/감지)과 renderer(설정/채팅 UI)가 공유한다.
//
// 핵심 구분 (CONTEXT_MANAGED_BY):
//  - "runtime"  : CLI 도구(Claude Code/Codex/Gemini)가 세션·컨텍스트 윈도우·압축을 자체적으로
//                 자동 관리한다. Agentlas는 위임만 하고 모델/압축을 손대지 않는다 → UI도 "자동"으로 표기.
//  - "agentlas" : BYOK 직접 API / Ollama — 대화 히스토리를 Agentlas가 직접 들고 있으므로
//                 모델 선택·1M 컨텍스트·히스토리 압축을 Agentlas가 구현/적용한다.
import type { RuntimeKind } from "./types";

export type ByokBackend = "anthropic" | "openai" | "google" | "upstage" | "custom";

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
};

/** 백엔드별 기본 모델 — 사용자가 명시 선택 전 fallback. */
export const DEFAULT_BYOK_MODEL: Record<ByokBackend, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
  upstage: "solar-pro2",
  custom: "deepseek-chat",
};

function isByokBackend(backend: string): backend is ByokBackend {
  return backend === "anthropic" || backend === "openai" || backend === "google" || backend === "upstage" || backend === "custom";
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
  byok: "agentlas",
  ollama: "agentlas",
};

// ── CLI 런타임 모델 선택 ──────────────────────────────────
// CLI 도구는 컨텍스트·압축을 자체 관리하지만(CONTEXT_MANAGED_BY === "runtime"),
// 모델은 `--model`(또는 codex/gemini의 -m)로 고를 수 있다. 컨텍스트 관리와 모델 선택은 독립.
// 빈 model(undefined)은 "구독 기본 모델" — --model을 전달하지 않는다.
//
// 헤드리스(-p) 한계: Claude Code의 인터랙티브 메뉴에 있는 "빠른 모드"와 `model[1m]`(1M) 변형은
// CLI 플래그가 없어 옮길 수 없다. 대신 claude는 `--effort`(작업량)를 지원한다.
export interface CliModelOption {
  /** CLI 모델 플래그에 전달하는 값. claude는 opus/sonnet/haiku 별칭 또는 풀ID(claude-opus-4-7 등) */
  id: string;
  label: string;
  /** "레거시" 같은 보조 표기 */
  tag?: string;
}

// 모델 ID/라벨은 여기서만 관리 — 새 세대는 이 배열에 한 줄. 잘못된 ID는 CLI가 거부할 뿐 크래시 없음.
export const CLI_MODELS: Partial<Record<RuntimeKind, CliModelOption[]>> = {
  // Claude Code — `claude --model`. 별칭(opus/sonnet/haiku)은 항상 최신, 레거시는 풀ID.
  "claude-code": [
    { id: "opus", label: "Opus 4.8" },
    { id: "sonnet", label: "Sonnet 4.6" },
    { id: "haiku", label: "Haiku 4.5" },
    { id: "claude-opus-4-7", label: "Opus 4.7", tag: "레거시" },
    { id: "claude-opus-4-6", label: "Opus 4.6", tag: "레거시" },
  ],
  // Codex — `codex exec -m <model>`. 구독 기본 외 명시 모델.
  codex: [
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { id: "gpt-5.1", label: "GPT-5.1" },
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
  ],
  // Gemini — `gemini -m <model>`.
  gemini: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
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
  if (kind === "ollama") {
    return (availableModels ?? []).map((m) => ({ id: m, label: m }));
  }
  return cliModels(kind);
}
