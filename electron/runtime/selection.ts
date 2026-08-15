import type {
  AgentRuntimeOverride,
  RuntimeRole,
  RuntimeStatus,
} from "../../shared/types";
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
import { runAntigravity } from "./antigravity";
import { runKimi } from "./kimi";
import { runGrok } from "./grok";
import { runCursor } from "./cursor";
import { runOllama } from "./ollama";
import { runLMStudio } from "./lmstudio";
import { runMLX } from "./mlx";
import { acquireRunSlot } from "./run-slots";
import { acpOrLegacyRunner, createAcpRunner } from "./acp";
import { resolveAcpAgentSpec } from "./acp-agents";
import { acquireLocalInferenceSlot } from "./local-inference-run-slots";
import type { Runner } from "./runner";

/**
 * CLI 러너를 전역 실행 슬롯으로 래핑 — 챗·firm·swarm·워크플로우·자동화가 각자 캡으로
 * 곱셈 스폰해도 동시 CLI 자식 수가 사용자 슬라이더(getAgentConcurrency)를 못 넘는다.
 * 슬롯이 차면 FIFO 대기(+상태 줄 표시), abort 시 즉시 이탈. 진짜 원격 API인 BYOK는
 * 로컬 자원을 거의 안 쓰므로 래핑하지 않는다 — 로컬 추론(Ollama/LM Studio/MLX)은
 * HTTP로 호출하지만 로컬 CPU/GPU를 쓰므로 아래 withLocalInferenceSlot으로 별도 래핑한다.
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

/**
 * 로컬 추론(Ollama/LM Studio/MLX) 전용 실행 슬롯 래퍼. CLI 자식 프로세스 예산과는
 * 별개의(보통 훨씬 낮은) 한도를 쓴다 — 로컬 추론 요청 1건이 이미 코어 대부분/GPU를
 * 쓰므로 CLI와 같은 예산으로 게이트하면 과다 산정되고, 아예 안 걸면 여러 에이전트가
 * 동시에 로컬 모델을 때려 컴퓨터를 못 쓰게 만들 수 있다.
 */
function withLocalInferenceSlot(runner: Runner): Runner {
  return async (req, events) => {
    const release = await acquireLocalInferenceSlot(req.signal, () => {
      events.onStatus(
        req.locale === "ko"
          ? "다른 로컬 추론이 끝나기를 기다리는 중... (동시 실행 한도)"
          : "Waiting for a free local inference slot... (concurrency limit)",
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
const runAntigravitySlotted = withRunSlot(runAntigravity);
// B-grade runtimes route through the generic ACP runner (PRD 2026-08-15 D-5):
// cursor showed no tool calls, grok guessed tool kinds from `type` strings,
// kimi was absent from the terminal. `AGENTLAS_DISABLE_ACP=1` (or a kind list)
// restores the legacy hand drivers without a rebuild.
const runKimiSlotted = withRunSlot(acpOrLegacyRunner("kimi", runKimi));
const runGrokSlotted = withRunSlot(acpOrLegacyRunner("grok", runGrok));
const runCursorSlotted = withRunSlot(acpOrLegacyRunner("cursor", runCursor));
const runOllamaSlotted = withLocalInferenceSlot(runOllama);
const runLMStudioSlotted = withLocalInferenceSlot(runLMStudio);
const runMLXSlotted = withLocalInferenceSlot(runMLX);

function bindRuntimeSource(runner: Runner, source: string | undefined): Runner {
  return (req, events) => runner({ ...req, ...(source ? { runtimeSource: source } : {}) }, events);
}

const RUNNER_LABEL: Record<string, string> = {
  "claude-code": "Claude Code CLI",
  codex: "Codex CLI",
  antigravity: "Antigravity CLI",
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

/**
 * Runtime-level effort is only a fallback when the selected model actually
 * advertises it. A chat can pin a different Codex model while omitting effort;
 * carrying the runtime's current model effort across that boundary attached
 * `max` to Spark (whose live profile stops at `xhigh`) and the provider rejected
 * the entire turn before any answer could be committed.
 */
export function effortForSelectedModel(
  runtime: RuntimeStatus,
  model: string | null | undefined,
  requested: string | null | undefined,
): string | null | undefined {
  if (!model) return requested;
  const supported = runtime.allocationModelProfiles?.[model]?.efforts;
  if (supported === undefined) return requested;
  const defaultEffort = runtime.allocationModelProfiles?.[model]?.defaultEffort;
  if (requested == null) return defaultEffort ?? supported[0] ?? null;
  if (supported.includes(requested)) return requested;
  // An exact, empty profile means the host could not validate any explicit
  // effort. Let the provider use its model default rather than inventing one.
  if (supported.length === 0) return null;
  const known = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const requestedRank = known.indexOf(requested);
  if (requestedRank < 0) return null;
  const below = supported.filter((candidate) => {
    const rank = known.indexOf(candidate);
    return rank >= 0 && rank <= requestedRank;
  });
  return below.at(-1) ?? defaultEffort ?? supported[0] ?? null;
}

export function pickRunner(active: RuntimeStatus): { runner: Runner; label: string } | null {
  if (active.kind === "claude-code") return { runner: runClaudeCodeSlotted, label: RUNNER_LABEL["claude-code"] };
  if (active.kind === "codex") return { runner: runCodexSlotted, label: RUNNER_LABEL.codex };
  if (active.kind === "antigravity") {
    return {
      runner: bindRuntimeSource(runAntigravitySlotted, active.source),
      label: RUNNER_LABEL.antigravity,
    };
  }
  // The detected executable travels with the request so the ACP runner spawns
  // exactly the binary detection verified (never a sibling from PATH).
  if (active.kind === "kimi")
    return { runner: bindRuntimeSource(runKimiSlotted, active.source), label: RUNNER_LABEL.kimi };
  if (active.kind === "grok")
    return { runner: bindRuntimeSource(runGrokSlotted, active.source), label: `Grok CLI${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "cursor")
    return { runner: bindRuntimeSource(runCursorSlotted, active.source), label: `Cursor Agent${active.model && active.model !== "auto" ? ` · ${active.model}` : " · Auto"}` };
  if (active.kind === "acp") {
    // Open seat: the spec (built-in or user profile) is looked up by acpAgentId;
    // the detected executable travels as runtimeSource so we spawn exactly it.
    const spec = resolveAcpAgentSpec(active.acpAgentId);
    if (!spec) return null;
    return {
      runner: bindRuntimeSource(withRunSlot(createAcpRunner(spec)), active.source),
      label: `${active.label ?? spec.label}${active.model ? ` · ${active.model}` : ""}`,
    };
  }
  if (active.kind === "ollama")
    return { runner: runOllamaSlotted, label: `Ollama${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "lmstudio")
    return { runner: runLMStudioSlotted, label: `LM Studio${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "mlx")
    return { runner: runMLXSlotted, label: `MLX${active.model ? ` · ${active.model}` : ""}` };
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

/**
 * Exact DB-independent runner for One's recovery plane. It never selects a
 * different runtime and never acquires a DB-backed concurrency slot. This path
 * is only for tool-free judgment while the operational store is unavailable.
 */
export function pickRecoveryRunner(selection: Pick<RuntimeStatus, "kind"> & { source?: string; acpAgentId?: string }): {
  runner: Runner;
  label: string;
} | null {
  if (selection.kind === "claude-code") return { runner: runClaudeCode, label: RUNNER_LABEL["claude-code"] };
  if (selection.kind === "codex") return { runner: runCodex, label: RUNNER_LABEL.codex };
  if (selection.kind === "antigravity") {
    return {
      runner: bindRuntimeSource(runAntigravity, selection.source),
      label: RUNNER_LABEL.antigravity,
    };
  }
  if (selection.kind === "kimi") return { runner: bindRuntimeSource(acpOrLegacyRunner("kimi", runKimi), selection.source), label: RUNNER_LABEL.kimi };
  if (selection.kind === "grok") return { runner: bindRuntimeSource(acpOrLegacyRunner("grok", runGrok), selection.source), label: RUNNER_LABEL.grok };
  if (selection.kind === "cursor") return { runner: bindRuntimeSource(acpOrLegacyRunner("cursor", runCursor), selection.source), label: RUNNER_LABEL.cursor };
  if (selection.kind === "acp") {
    const spec = resolveAcpAgentSpec(selection.acpAgentId);
    if (!spec) return null;
    return { runner: bindRuntimeSource(createAcpRunner(spec), selection.source), label: spec.label };
  }
  if (selection.kind === "ollama") return { runner: runOllama, label: "Ollama" };
  if (selection.kind === "lmstudio") return { runner: runLMStudio, label: "LM Studio" };
  if (selection.kind === "mlx") return { runner: runMLX, label: "MLX" };
  return null;
}

function applyRoleSelection(runtime: RuntimeStatus, role: RuntimeRole): RuntimeStatus {
  const selection = runtime.roleSelections?.[role];
  if (!selection) return { ...runtime, active: true };
  const model = selection.model ?? runtime.model;
  return {
    ...runtime,
    active: true,
    model,
    effort: effortForSelectedModel(runtime, model, selection.effort ?? runtime.effort),
    longContextEnabled: selection.longContext ?? runtime.longContextEnabled,
  };
}

export function pickActive(
  list: RuntimeStatus[],
  role: RuntimeRole = "orchestrator",
): RuntimeStatus | null {
  const matched = list.find(
    (runtime) =>
      runtime.activeRoles?.includes(role) ||
      (role === "orchestrator" && runtime.active),
  );
  if (matched) return applyRoleSelection(matched, role);
  if (role === "worker") {
    const orchestrator = list.find(
      (runtime) =>
        runtime.activeRoles?.includes("orchestrator") || runtime.active,
    );
    if (orchestrator) return applyRoleSelection(orchestrator, "orchestrator");
  }
  return list[0] ? { ...list[0], active: true } : null;
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
  const model = selection.model ?? matched.model;
  const active: RuntimeStatus = {
    ...matched,
    active: true,
    model,
    longContextEnabled: selection.longContext ?? matched.longContextEnabled,
    effort: effortForSelectedModel(matched, model, selection.effort ?? matched.effort),
  };
  return { active, picked: pickRunner(active), override: null, unavailableOverride: null };
}

export function applyRuntimeOverride(
  runtime: RuntimeStatus,
  override: AgentRuntimeOverride,
): RuntimeStatus {
  const model =
    override.selection.model !== undefined
      ? override.selection.model
      : runtime.model;
  return {
    ...runtime,
    active: true,
    source: override.selection.source ?? runtime.source,
    model,
    longContextEnabled:
      override.selection.longContext !== undefined
        ? override.selection.longContext
        : runtime.longContextEnabled,
    effort: effortForSelectedModel(
      runtime,
      model,
      override.selection.effort !== undefined
        ? override.selection.effort
        : runtime.effort,
    ),
  };
}

export function selectRuntimeForTargets(
  runtimes: RuntimeStatus[],
  targets: RuntimeOverrideTarget[],
  role: RuntimeRole = "orchestrator",
): RuntimeChoice | null {
  const override = findAgentRuntimeOverride(targets);
  if (override) {
    const matched = runtimes.find((runtime) => runtimeMatchesOverride(runtime, override));
    if (matched) {
      const active = applyRuntimeOverride(matched, override);
      return { active, picked: pickRunner(active), override, unavailableOverride: null };
    }
  }

  const active = pickActive(runtimes, role);
  if (!active) return null;
  return {
    active,
    picked: pickRunner(active),
    override: null,
    unavailableOverride: override ?? null,
  };
}

export interface InvocationRuntimeResolution {
  choice: RuntimeChoice | AgentAppRuntimeChoice | null;
  /** true = the invocation pin was used verbatim (fail-closed when unavailable). */
  pinHonored: boolean;
  /** Non-null when a chat-surface pin stepped aside for a Library assignment. */
  pinYieldedToOverride: AgentRuntimeOverride | null;
}

/**
 * Single decision point for "which runtime runs this invocation".
 *
 * WHY: a chat runtime pin and a Library per-agent/per-firm assignment are two
 * settings surfaces claiming the same decision. The pin used to short-circuit
 * the whole override path, so the narrower agent-scoped assignment was dropped
 * without a word — and the "assigned runtime unavailable" notice was skipped
 * too. The chat pin is only a conversation default, so it now yields to an
 * explicit assignment and reports that it did. An unattended Main-owned
 * automation pin stays authoritative: it is a fail-closed contract that also
 * pins the CLI session namespace.
 */
export function selectInvocationRuntime(
  runtimes: RuntimeStatus[],
  targets: RuntimeOverrideTarget[],
  options: {
    pin?: import("../../shared/types").RuntimeSelection | null;
    /** true = Main-owned unattended automation pin, false = chat-surface pin. */
    pinIsAuthoritative: boolean;
    agentAppMode?: boolean;
  },
): InvocationRuntimeResolution {
  const assigned =
    options.pin && !options.pinIsAuthoritative ? findAgentRuntimeOverride(targets) : null;
  if (options.pin && !assigned) {
    return {
      choice: selectExactRuntime(runtimes, options.pin),
      pinHonored: true,
      pinYieldedToOverride: null,
    };
  }
  const choice = options.agentAppMode
    ? selectAgentAppRuntimeForTargets(runtimes, targets)
    : selectRuntimeForTargets(runtimes, targets);
  return { choice, pinHonored: false, pinYieldedToOverride: assigned };
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
