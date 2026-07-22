import type { AgentRuntimeOverride, RuntimeStatus } from "../../shared/types";
import { findAgentRuntimeOverride, type RuntimeOverrideTarget } from "../store/agent-runtime-overrides";
import {
  runAnthropicByok,
  runCustomByok,
  runDeepseekByok,
  runGlmByok,
  runGoogleByok,
  runKimiByok,
  runMinimaxByok,
  runOpenAIByok,
  runOpenRouterByok,
  runUpstageByok,
  runXaiByok,
} from "./byok";
import { runClaudeCode } from "./claude-code";
import { runCodex } from "./codex";
import { isAgyBinaryPath, runGemini } from "./gemini";
import { runKimi } from "./kimi";
import { runGrok } from "./grok";
import { runCursor } from "./cursor";
import { runOllama } from "./ollama";
import { runLMStudio } from "./lmstudio";
import { runMLX } from "./mlx";
import { acquireRunSlot } from "./run-slots";
import type { Runner } from "./runner";

/**
 * CLI 러너를 전역 실행 슬롯으로 래핑 — 챗·firm·swarm·워크플로우·자동화가 각자 캡으로
 * 곱셈 스폰해도 동시 CLI 자식 수가 사용자 슬라이더(getAgentConcurrency)를 못 넘는다.
 * 슬롯이 차면 FIFO 대기(+상태 줄 표시), abort 시 즉시 이탈. HTTP 런타임(BYOK/Ollama)은
 * 로컬 CPU를 거의 안 쓰므로 래핑하지 않는다.
 * 주의: 러너 내부 재시도(runClaudeCode의 세션 복구 재귀)는 래핑 밖이라 이중 획득이 없다.
 */
function withRunSlot(runner: Runner): Runner {
  return async (req, events) => {
    const release = await acquireRunSlot(req.signal, () => {
      events.onStatus(
        req.locale === "ko"
          ? "다른 에이전트 실행이 끝나기를 기다리는 중... (동시 실행 한도)"
          : "Waiting for a free run slot... (concurrency limit)",
      );
    });
    try {
      return await runner(req, events);
    } finally {
      release();
    }
  };
}

const runClaudeCodeSlotted = withRunSlot(runClaudeCode);
const runCodexSlotted = withRunSlot(runCodex);
const runGeminiSlotted = withRunSlot(runGemini);
const runKimiSlotted = withRunSlot(runKimi);
const runGrokSlotted = withRunSlot(runGrok);
const runCursorSlotted = withRunSlot(runCursor);

const RUNNER_LABEL: Record<string, string> = {
  "claude-code": "Claude Code CLI",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  kimi: "Kimi Code CLI",
  grok: "Grok CLI",
  cursor: "Cursor Agent CLI",
  "byok:anthropic": "Anthropic API",
  "byok:openai": "OpenAI API",
  "byok:google": "Google API",
  "byok:upstage": "Upstage Solar API",
  "byok:custom": "Custom OpenAI API",
  "byok:glm": "GLM (Z.ai)",
  "byok:kimi": "Kimi (Moonshot)",
  "byok:deepseek": "DeepSeek",
  "byok:minimax": "MiniMax",
  "byok:xai": "xAI",
  "byok:openrouter": "OpenRouter",
};

export interface RuntimeChoice {
  active: RuntimeStatus;
  picked: { runner: Runner; label: string } | null;
  override: AgentRuntimeOverride | null;
  unavailableOverride: AgentRuntimeOverride | null;
}

export interface AgentAppRuntimeChoice extends RuntimeChoice {
  /** Brave MCP is allowed only when the target's selected runtime is Claude Code. */
  capabilityRuntimeEligible: boolean;
  /** Unsafe CLI selection replaced by a stateless-safe no-tool runner. */
  fallbackFromKind: RuntimeStatus["kind"] | null;
}

export function pickRunner(active: RuntimeStatus): { runner: Runner; label: string } | null {
  if (active.kind === "claude-code") return { runner: runClaudeCodeSlotted, label: RUNNER_LABEL["claude-code"] };
  if (active.kind === "codex") return { runner: runCodexSlotted, label: RUNNER_LABEL.codex };
  if (active.kind === "gemini") {
    return {
      runner: runGeminiSlotted,
      label: isAgyBinaryPath(active.source) ? "Antigravity CLI" : RUNNER_LABEL.gemini,
    };
  }
  if (active.kind === "kimi")
    return { runner: runKimiSlotted, label: RUNNER_LABEL.kimi };
  if (active.kind === "grok")
    return { runner: runGrokSlotted, label: `Grok CLI${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "cursor")
    return { runner: runCursorSlotted, label: `Cursor Agent${active.model && active.model !== "auto" ? ` · ${active.model}` : " · Auto"}` };
  if (active.kind === "ollama")
    return { runner: runOllama, label: `Ollama${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "lmstudio")
    return { runner: runLMStudio, label: `LM Studio${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "mlx")
    return { runner: runMLX, label: `MLX${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "byok") {
    if (active.backend === "anthropic")
      return { runner: runAnthropicByok, label: RUNNER_LABEL["byok:anthropic"] };
    if (active.backend === "openai")
      return { runner: runOpenAIByok, label: RUNNER_LABEL["byok:openai"] };
    if (active.backend === "google")
      return { runner: runGoogleByok, label: RUNNER_LABEL["byok:google"] };
    if (active.backend === "upstage")
      return { runner: runUpstageByok, label: RUNNER_LABEL["byok:upstage"] };
    if (active.backend === "custom")
      return { runner: runCustomByok, label: RUNNER_LABEL["byok:custom"] };
    if (active.backend === "glm")
      return { runner: runGlmByok, label: RUNNER_LABEL["byok:glm"] };
    if (active.backend === "kimi")
      return { runner: runKimiByok, label: RUNNER_LABEL["byok:kimi"] };
    if (active.backend === "deepseek")
      return { runner: runDeepseekByok, label: RUNNER_LABEL["byok:deepseek"] };
    if (active.backend === "minimax")
      return { runner: runMinimaxByok, label: RUNNER_LABEL["byok:minimax"] };
    if (active.backend === "xai")
      return { runner: runXaiByok, label: RUNNER_LABEL["byok:xai"] };
    if (active.backend === "openrouter")
      return { runner: runOpenRouterByok, label: RUNNER_LABEL["byok:openrouter"] };
  }
  return null;
}

export function pickActive(list: RuntimeStatus[]): RuntimeStatus | null {
  return list.find((r) => r.active) ?? list[0] ?? null;
}

/**
 * 핀된 자동화 런타임이 지금 이 머신에서 실제로 존재(감지)하는지.
 * (사인인 여부는 detect가 모르므로 여기서는 판단하지 않는다 — 그건 실행 중 auth 실패로만 드러난다.)
 */
export function pinnedRuntimeAvailable(
  runtimes: RuntimeStatus[],
  selection: import("../../shared/types").RuntimeSelection,
): boolean {
  return selectExactRuntime(runtimes, selection) !== null;
}

/**
 * 핀된 런타임이 없거나(미설치/미감지) 로그아웃일 때 자동화를 죽이지 않기 위한 대체 런타임.
 * `avoidKind`(실패한 런타임 종류)는 제외하고, 실제 실행 가능한 러너가 붙는 런타임만 고른다.
 * 활성 런타임을 우선하되, 그게 제외 대상이면 실행 가능한 다른 런타임을 반환한다.
 */
export function healthyAlternativeRuntime(
  runtimes: RuntimeStatus[],
  avoidKind: RuntimeStatus["kind"] | null,
): RuntimeStatus | null {
  const usable = runtimes.filter(
    (runtime) => (!avoidKind || runtime.kind !== avoidKind) && Boolean(pickRunner({ ...runtime, active: true })),
  );
  return usable.find((runtime) => runtime.active) ?? usable[0] ?? null;
}

/**
 * 핀된 런타임이 정확히 감지되지 않을 때의 치유 대상.
 * 1) 같은 종류가 (경로/모델만 달라진 채) 존재하면 종류를 바꾸지 않고 그 인스턴스로만 재정렬(source_drift).
 * 2) 그 종류가 완전히 없으면(미설치) 실행 가능한 다른 종류로 대체(kind_substituted).
 * 정확히 감지되면 null(치유 불필요). 아무 런타임도 없으면 null(정직히 no-runtime 표면화).
 */
export function resolvePinnedRuntimeHeal(
  runtimes: RuntimeStatus[],
  selection: import("../../shared/types").RuntimeSelection,
): { runtime: RuntimeStatus; reason: "source_drift" | "kind_substituted" } | null {
  if (selectExactRuntime(runtimes, selection)) return null;
  const sameKind = runtimes.find(
    (runtime) => runtime.kind === selection.kind && Boolean(pickRunner({ ...runtime, active: true })),
  );
  if (sameKind) return { runtime: sameKind, reason: "source_drift" };
  const alternative = healthyAlternativeRuntime(runtimes, selection.kind);
  if (alternative) return { runtime: alternative, reason: "kind_substituted" };
  return null;
}

/** 감지된 런타임을 그대로 다시 핀 가능한 RuntimeSelection으로 변환(치유된 이번 실행에만 in-memory 적용). */
export function selectionFromRuntime(
  runtime: RuntimeStatus,
): import("../../shared/types").RuntimeSelection {
  return {
    kind: runtime.kind,
    ...(runtime.backend ? { backend: runtime.backend } : {}),
    ...(runtime.source ? { source: runtime.source } : {}),
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.longContextEnabled != null ? { longContext: runtime.longContextEnabled } : {}),
    ...(runtime.effort ? { effort: runtime.effort } : {}),
  };
}

function runtimeMatchesOverride(runtime: RuntimeStatus, override: AgentRuntimeOverride): boolean {
  const selection = override.selection;
  if (runtime.kind !== selection.kind) return false;
  if (selection.backend && runtime.backend !== selection.backend) return false;
  return true;
}

export function selectExactRuntime(
  runtimes: RuntimeStatus[],
  selection: import("../../shared/types").RuntimeSelection,
): RuntimeChoice | null {
  const matched = runtimes.find((runtime) => {
    if (runtime.kind !== selection.kind) return false;
    if (selection.backend && runtime.backend !== selection.backend) return false;
    if (selection.source && runtime.source !== selection.source) return false;
    return true;
  });
  if (!matched) return null;
  const active: RuntimeStatus = {
    ...matched,
    active: true,
    model: selection.model ?? matched.model,
    longContextEnabled: selection.longContext ?? matched.longContextEnabled,
    effort: selection.effort ?? matched.effort,
  };
  return { active, picked: pickRunner(active), override: null, unavailableOverride: null };
}

export function applyRuntimeOverride(
  runtime: RuntimeStatus,
  override: AgentRuntimeOverride,
): RuntimeStatus {
  return {
    ...runtime,
    active: true,
    source: override.selection.source ?? runtime.source,
    model:
      override.selection.model !== undefined
        ? override.selection.model
        : runtime.model,
    longContextEnabled:
      override.selection.longContext !== undefined
        ? override.selection.longContext
        : runtime.longContextEnabled,
    effort:
      override.selection.effort !== undefined
        ? override.selection.effort
        : runtime.effort,
  };
}

export function selectRuntimeForTargets(
  runtimes: RuntimeStatus[],
  targets: RuntimeOverrideTarget[],
): RuntimeChoice | null {
  const override = findAgentRuntimeOverride(targets);
  if (override) {
    const matched = runtimes.find((runtime) => runtimeMatchesOverride(runtime, override));
    if (matched) {
      const active = applyRuntimeOverride(matched, override);
      return { active, picked: pickRunner(active), override, unavailableOverride: null };
    }
  }

  const active = pickActive(runtimes);
  if (!active) return null;
  return {
    active,
    picked: pickRunner(active),
    override: null,
    unavailableOverride: override ?? null,
  };
}

function agentAppStatelessSafe(runtime: RuntimeStatus): boolean {
  return (
    runtime.kind === "claude-code" ||
    runtime.kind === "byok" ||
    runtime.kind === "ollama" ||
    runtime.kind === "lmstudio" ||
    runtime.kind === "mlx"
  );
}

/**
 * Runtimes that cannot prove the Agent App zero-builtins contract are replaced
 * by a detected stateless-safe runner. Capability eligibility remains tied to
 * the target's original runtime so fallback never widens MCP authority.
 */
export function selectAgentAppRuntimeForTargets(
  runtimes: RuntimeStatus[],
  targets: RuntimeOverrideTarget[],
): AgentAppRuntimeChoice | null {
  const preferred = selectRuntimeForTargets(runtimes, targets);
  if (!preferred) return null;
  const capabilityRuntimeEligible = preferred.active.kind === "claude-code";
  if (preferred.picked && agentAppStatelessSafe(preferred.active)) {
    return { ...preferred, capabilityRuntimeEligible, fallbackFromKind: null };
  }
  const fallback = [...runtimes]
    .filter(agentAppStatelessSafe)
    .sort((left, right) => {
      const rank = (runtime: RuntimeStatus) => runtime.kind === "claude-code" ? 0 : runtime.kind === "byok" ? 1 : 2;
      return rank(left) - rank(right);
    })
    .find((runtime) => Boolean(pickRunner(runtime)));
  if (!fallback) return null;
  const active = { ...fallback, active: true };
  return {
    active,
    picked: pickRunner(active),
    override: null,
    unavailableOverride: preferred.unavailableOverride,
    capabilityRuntimeEligible: false,
    fallbackFromKind: preferred.active.kind,
  };
}
