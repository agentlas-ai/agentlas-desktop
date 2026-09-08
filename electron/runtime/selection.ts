import { isRuntimeCredentialUnavailable } from "./credential-access";
import { runtimeCooldown } from "./runtime-cooldown";
import type {
  AgentRuntimeOverride,
  RuntimeRole,
  RuntimeSelection,
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
import { agentlasServingRunnerLabel, runAgentlasServing } from "./agentlas-serving";
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
import { agentActivityKey, registerAgentResidency, touchAgentResidency } from "./agent-residency";
import { acpOrLegacyRunner, acpSessionKind, createAcpRunner } from "./acp";
import { resolveAcpAgentSpec } from "./acp-agents";
import { acquireLocalInferenceSlot } from "./local-inference-run-slots";
import { withNativeBrowserGuidance, type Runner, type RunnerFailure } from "./runner";
import { peekProviderUsedPercent } from "../usage";
import { listModelRoleMembers } from "../store/model-roles";

/**
 * CLI 러너를 전역 실행 슬롯으로 래핑 — 챗·firm·swarm·워크플로우·자동화가 각자 캡으로
 * 곱셈 스폰해도 동시 CLI 자식 수가 사용자 슬라이더(getAgentConcurrency)를 못 넘는다.
 * 슬롯이 차면 FIFO 대기(+상태 줄 표시), abort 시 즉시 이탈. 진짜 원격 API인 BYOK는
 * 로컬 자원을 거의 안 쓰므로 래핑하지 않는다 — 로컬 추론(Ollama/LM Studio/MLX)은
 * HTTP로 호출하지만 로컬 CPU/GPU를 쓰므로 아래 withLocalInferenceSlot으로 별도 래핑한다.
 * 주의: 러너 내부 재시도(runClaudeCode의 세션 복구 재귀)는 래핑 밖이라 이중 획득이 없다.
 */
function withRunSlot(runner: Runner, runtimeKind: string): Runner {
  return async (req, events) => {
    // 우선순위: 요청 명시값 → 호출 문맥(withRunPriority) → interactive.
    // 자동화 스케줄러·데몬 graph.run 이 background 문맥을 깔고, 채팅 턴은 기본값이다.
    const release = await acquireRunSlot(req.signal, () => {
      events.onStatus(
        req.locale === "ko"
          ? "다른 에이전트 실행이 끝나기를 기다리는 중... (동시 실행 한도)"
          : "Waiting for a free run slot... (concurrency limit)",
      );
    }, req.runPriority);
    /*
     * ★상주 등록 — 여기가 **공용 실행 경로**다.
     *
     * 채팅·firm·swarm·워크플로우·자동화, 그리고 network/cloud 로 소환된 에이전트의 로컬
     * 서브런(borrowed task force)까지 CLI 실행은 전부 이 래퍼를 지난다. 그래서 "누가
     * 언제 마지막으로 돌았는가"를 여기서 한 번만 적으면 12시간 스위퍼와 스웜 예산이
     * 같은 사실을 본다 — 호출부마다 적으면 언젠가 한 곳이 빠지고, 빠진 곳의 에이전트는
     * 등록소에서 영영 보이지 않는다.
     *
     * 이 행은 **활동 기록**이지 상주 세션이 아니다(holdsSession=false). 살아 있는
     * 프로세스를 실제로 붙드는 것은 ACP 세션 풀뿐이고, 그것만 예산을 소비한다 —
     * 일회성 `-p` CLI 를 "상주 중"이라고 말하지 않기 위한 구분이다.
     */
    const residencyKey = agentActivityKey({
      agentId: req.agentId ?? null,
      chatId: req.chatId ?? null,
      runtimeKind,
    });
    try {
      registerAgentResidency({
        key: residencyKey,
        agentId: req.agentId ?? null,
        chatId: req.chatId ?? null,
        runtimeKind,
        holdsSession: false,
        inUse: true,
      });
    } catch {
      // 등록소 실패가 실행을 막지 않는다 — 관측은 실행보다 뒤에 선다.
    }
    try {
      return await runner(req, events);
    } finally {
      try { touchAgentResidency(residencyKey, { inUse: false }); } catch { /* 관측 실패 무시 */ }
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

const runClaudeCodeSlotted = withRunSlot(runClaudeCode, "claude-code");
const runCodexSlotted = withRunSlot(runCodex, "codex");
const runAntigravitySlotted = withRunSlot(runAntigravity, "antigravity");
// B-grade runtimes route through the generic ACP runner (PRD 2026-08-15 D-5):
// cursor showed no tool calls, grok guessed tool kinds from `type` strings,
// kimi was absent from the terminal. `AGENTLAS_DISABLE_ACP=1` (or a kind list)
// restores the legacy hand drivers without a rebuild.
const runKimiSlotted = withRunSlot(acpOrLegacyRunner("kimi", runKimi), "kimi");
const runGrokSlotted = withRunSlot(acpOrLegacyRunner("grok", runGrok), "grok");
const runCursorSlotted = withRunSlot(acpOrLegacyRunner("cursor", runCursor), "cursor");
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
  agentlas: "Agentlas",
};

export interface RuntimeChoice {
  active: RuntimeStatus;
  picked: { runner: Runner; label: string } | null;
  override: AgentRuntimeOverride | null;
  unavailableOverride: AgentRuntimeOverride | null;
  /** Internal fallback path for a selected agent model. Kept out of chat copy. */
  fallbackStage?: "worker" | "connected";
  fallbackReason?: "runtime-unavailable" | "model-unavailable" | "quota-exceeded";
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
  const selected = pickRunnerWithoutHostGuidance(active);
  return selected ? { ...selected, runner: withNativeBrowserGuidance(selected.runner) } : null;
}

function pickRunnerWithoutHostGuidance(active: RuntimeStatus): { runner: Runner; label: string } | null {
  if (isRuntimeCredentialUnavailable(active)) {
    return {
      label: `BYOK · ${active.backend}`,
      runner: async (req) => ({
        text: "",
        failure: {
          kind: "auth",
          runtime: `byok:${active.backend}`,
          source: "marker",
          message: req.locale === "ko"
            ? `${active.backend}의 저장된 API 키에 접근할 수 없습니다. 도움말 메뉴에서 해당 API 키 접근을 다시 시도할 수 있습니다.`
            : `The saved ${active.backend} API key is unavailable. Use Help to retry access to this API key.`,
        },
      }),
    };
  }
  if (runtimeModelUnavailable(active, active.model)) {
    return {
      label: RUNNER_LABEL[active.kind] ?? active.label ?? active.kind,
      runner: async (req) => ({
        text: "",
        failure: {
          kind: "unsupported",
          runtime: active.kind === "byok" ? `byok:${active.backend}` : active.kind,
          source: "marker",
          message: req.locale === "ko"
            ? `선택한 모델 ${active.model}이 현재 ${active.kind} 모델 목록에 없습니다. 연결을 다시 확인하거나 사용 가능한 모델을 선택해 주세요.`
            : `The selected model ${active.model} is absent from the current ${active.kind} model list. Refresh the connection or select an available model.`,
        },
      }),
    };
  }
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
      runner: bindRuntimeSource(withRunSlot(createAcpRunner(spec), acpSessionKind(spec.id)), active.source),
      label: `${active.label ?? spec.label}${active.model ? ` · ${active.model}` : ""}`,
    };
  }
  if (active.kind === "ollama")
    return { runner: runOllamaSlotted, label: `Ollama${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "lmstudio")
    return { runner: runLMStudioSlotted, label: `LM Studio${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "mlx")
    return { runner: runMLXSlotted, label: `MLX${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "agentlas") {
    // 서버가 실행을 들고 있으므로 로컬 실행 슬롯을 잡지 않는다 — 이 기계의 CPU 를 쓰지 않는
    // 원격 호출이라, BYOK 와 같은 취급이 맞다.
    return { runner: runAgentlasServing, label: agentlasServingRunnerLabel(active.model) };
  }
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
  if (selection.kind === "agentlas") return { runner: runAgentlasServing, label: "Agentlas" };
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
  // Detection initializes a new store. An unmarked list can instead mean the
  // saved executable disappeared; detection order must not replace that choice.
  return null;
}

function runtimeMatchesOverride(runtime: RuntimeStatus, override: AgentRuntimeOverride): boolean {
  const selection = override.selection;
  if (runtime.kind !== selection.kind) return false;
  if (selection.backend && runtime.backend !== selection.backend) return false;
  if (selection.source && runtime.source !== selection.source) return false;
  return true;
}

// A near-limit warning still leaves usable quota. Only an exhausted snapshot
// excludes a candidate; actual provider quota/auth failures retain their cooldown.
const QUOTA_EXHAUSTED_PERCENT = 100;
const LOCAL_AUTHORITATIVE_MODEL_KINDS = new Set<RuntimeStatus["kind"]>(["ollama", "lmstudio", "mlx"]);

function runtimeModelUnavailable(runtime: RuntimeStatus, selectedModel: string | null | undefined): boolean {
  const model = selectedModel?.trim();
  if (!model || isRuntimeCredentialUnavailable(runtime)) return false;
  const discovery = runtime.modelDiscovery;
  // Failed/empty/stale discovery cannot prove that an explicit model was removed.
  if (discovery && (discovery.status !== "ok" || discovery.stale)) return false;
  // CLI picker catalogs may omit accepted aliases/hidden models even when the
  // read succeeds. Preserve the explicit request and let the runtime answer it.
  const authoritative = LOCAL_AUTHORITATIVE_MODEL_KINDS.has(runtime.kind);
  return authoritative && (runtime.availableModels?.length ?? 0) > 0
    && !runtime.availableModels!.includes(model);
}

function runtimeSelectionUnavailableReason(
  runtime: RuntimeStatus | undefined,
  selection: Pick<import("../../shared/types").RuntimeSelection, "kind" | "model">,
): RuntimeChoice["fallbackReason"] | null {
  if (!runtime || !pickRunner(runtime)) return "runtime-unavailable";
  // Preserve this selected identity and let its marker failure explain storage
  // access. A display catalog or cached quota cannot justify a silent swap.
  if (isRuntimeCredentialUnavailable(runtime)) return null;
  if (runtimeModelUnavailable(runtime, selection.model)) return "model-unavailable";
  const used = peekProviderUsedPercent(selection.kind);
  if (used !== null && used >= QUOTA_EXHAUSTED_PERCENT) return "quota-exceeded";
  return null;
}

function runtimeStatusSelection(runtime: RuntimeStatus): import("../../shared/types").RuntimeSelection {
  return {
    kind: runtime.kind,
    backend: runtime.backend,
    source: runtime.source,
    model: runtime.model ?? undefined,
    effort: runtime.effort ?? undefined,
    longContext: runtime.longContextEnabled,
  };
}

function runtimeMatchesSelection(
  runtime: RuntimeStatus,
  selection: Pick<RuntimeSelection, "kind" | "backend" | "source">,
): boolean {
  return runtime.kind === selection.kind
    && (!selection.backend || runtime.backend === selection.backend)
    && (!selection.source || runtime.source === selection.source);
}

function applyStoredRoleSelection(
  runtime: RuntimeStatus,
  selection: RuntimeSelection,
): RuntimeStatus {
  const model = selection.model ?? runtime.model;
  return {
    ...runtime,
    active: true,
    model,
    effort: effortForSelectedModel(runtime, model, selection.effort ?? runtime.effort),
    longContextEnabled: selection.longContext ?? runtime.longContextEnabled,
  };
}

/**
 * Returns live runtimes in the exact order stored in model_role_members.
 *
 * `pickActive()` is intentionally a UI/legacy helper: it follows the detected
 * runtime array and activeRoles. Execution fallback must not use that order,
 * because detection order is not the owner's priority list. An empty worker
 * pool inherits the orchestrator pool, matching the store contract.
 */
export function rolePriorityRuntimes(
  runtimes: RuntimeStatus[],
  role: RuntimeRole,
  options: {
    failedRuntime?: RuntimeStatus;
    failure?: Pick<RunnerFailure, "kind">;
    exclude?: RuntimeStatus[];
  } = {},
): RuntimeStatus[] {
  // Unavailable credential storage requires explicit recovery of the selected key.
  // Do not turn its marker failure into a run on another provider.
  if (isRuntimeCredentialUnavailable(options.failedRuntime)) return [];
  const ownMembers = listModelRoleMembers(role);
  const inherited = role === "worker" && ownMembers.length === 0;
  const members = inherited ? listModelRoleMembers("orchestrator") : ownMembers;
  const excluded = options.exclude ?? [];
  const blocked = (candidate: RuntimeStatus): boolean => {
    if (isRuntimeCredentialUnavailable(candidate)) return true;
    /*
     * ★이미 한도에 걸린 런타임으로 폴백하지 않는다 (실사용 실측 2026-09-07).
     *
     * 사용자가 제미나이를 골라 뒀는데 agy 가 한도로 실패했고, 폴백이 grok 을 골랐다.
     * 그런데 grok 은 **그 시점에 이미 한도 초과였다**(524673/500000, 24시간 롤링).
     * 죽은 것에서 죽은 것으로 넘어가느라 실패 두 번과 8분을 썼다. 후보 필터에
     * "지금 막혀 있다"는 개념이 없었기 때문이다. 시한이 지나면 스스로 다시 후보가 된다.
     */
    if (runtimeCooldown(candidate)) return true;
    if (excluded.some((item) => sameRuntimeIdentity(candidate, item))) return true;
    if (
      options.failedRuntime
      && options.failure
      && runtimeFailureSharesProviderDomain(candidate, options.failedRuntime, options.failure)
    ) return true;
    return false;
  };
  const out: RuntimeStatus[] = [];
  const pushCandidate = (candidate: RuntimeStatus | null): void => {
    if (!candidate || blocked(candidate) || !pickRunner(candidate)) return;
    const unavailable = runtimeSelectionUnavailableReason(candidate, runtimeStatusSelection(candidate));
    if (unavailable) return;
    if (!out.some((item) => sameRuntimeIdentity(item, candidate) && item.model === candidate.model)) {
      out.push(candidate);
    }
  };

  if (members.length > 0) {
    for (const member of members) {
      const matched = runtimes.find((runtime) => runtimeMatchesSelection(runtime, member.selection));
      if (!matched) continue;
      pushCandidate(applyStoredRoleSelection(matched, {
        ...member.selection,
        role,
        inherit: inherited,
      }));
    }
    return out;
  }

  // Legacy/unconfigured stores have no ordered pool yet. Keep the old active
  // role behavior only in that case; once a pool exists, no detection-order
  // runtime may be smuggled in ahead of its DB rows.
  const legacyActive = pickActive(runtimes, role);
  pushCandidate(legacyActive);
  return out;
}

function sameRuntimeIdentity(left: RuntimeStatus, right: RuntimeStatus): boolean {
  return left.kind === right.kind
    && left.backend === right.backend
    && left.source === right.source
    && left.acpAgentId === right.acpAgentId;
}

/** Quota/auth is provider-wide; other failures stay scoped to one runtime/model pair. */
export function runtimeFailureSharesProviderDomain(
  candidate: RuntimeStatus,
  failed: RuntimeStatus,
  failure: Pick<RunnerFailure, "kind">,
): boolean {
  if (failure.kind === "auth" || failure.kind === "quota") {
    return candidate.kind === failed.kind && candidate.backend === failed.backend;
  }
  // A transport/exit failure on one model must still allow the next model
  // configured on the same executable to run. Quota/auth remains provider-wide
  // above because that state is shared by the account, not the model.
  return sameRuntimeIdentity(candidate, failed) && candidate.model === failed.model;
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
  // A graph node override may intentionally pin only the runtime kind. In that
  // case, resolve the model from the requested role instead of borrowing the
  // automation's other-provider model (for example, Claude + gemini). An
  // explicit model remains authoritative and is never replaced by a role pick.
  const roleSelected = !selection.model && selection.role
    ? applyRoleSelection(matched, selection.role)
    : matched;
  const model = selection.model ?? roleSelected.model;
  const active: RuntimeStatus = {
    ...roleSelected,
    active: true,
    model,
    longContextEnabled: selection.longContext ?? roleSelected.longContextEnabled,
    effort: effortForSelectedModel(roleSelected, model, selection.effort ?? roleSelected.effort),
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
    const unavailableReason = runtimeSelectionUnavailableReason(matched, override.selection);
    if (matched && !unavailableReason) {
      const active = applyRuntimeOverride(matched, override);
      return { active, picked: pickRunner(active), override, unavailableOverride: null };
    }

    // An unavailable scoped seat falls back within the same execution role.
    // Specialist seats use the worker pool; CEO/controller seats use the
    // orchestrator pool. Never use detection order as the hidden fallback.
    const rolePriority = rolePriorityRuntimes(runtimes, role);
    const roleFallback = rolePriority[0] ?? null;
    const roleFallbackReason = roleFallback
      ? runtimeSelectionUnavailableReason(roleFallback, runtimeStatusSelection(roleFallback))
      : "runtime-unavailable";
    if (roleFallback && !roleFallbackReason && (
      !matched
      || roleFallback.kind !== matched.kind
      || roleFallback.backend !== matched.backend
      || roleFallback.model !== override.selection.model
    )) {
      return {
        active: roleFallback,
        picked: pickRunner(roleFallback),
        override: null,
        unavailableOverride: override,
        // Preserve the existing UI distinction for an absent model while the
        // actual candidate is now resolved from the requested role's DB pool.
        fallbackStage: role === "worker" || unavailableReason === "model-unavailable"
          ? "worker"
          : "connected",
        fallbackReason: unavailableReason ?? "runtime-unavailable",
      };
    }

    for (const candidate of runtimes) {
      if (isRuntimeCredentialUnavailable(candidate)) continue;
      const active = { ...candidate, active: true };
      if (runtimeSelectionUnavailableReason(active, runtimeStatusSelection(active))) continue;
      if (
        matched
        && active.kind === matched.kind
        && active.backend === matched.backend
        && active.model === override.selection.model
      ) continue;
      return {
        active,
        picked: pickRunner(active),
        override: null,
        unavailableOverride: override,
        fallbackStage: "connected",
        fallbackReason: unavailableReason ?? "runtime-unavailable",
      };
    }
    return null;
  }

  const savedActive = pickActive(runtimes, role);
  const active = isRuntimeCredentialUnavailable(savedActive)
    ? savedActive
    : rolePriorityRuntimes(runtimes, role)[0] ?? savedActive;
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
