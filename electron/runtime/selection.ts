import { isRuntimeCredentialUnavailable, RUNTIME_CREDENTIAL_UNAVAILABLE_CODE, runtimeModelUnavailableByInventory } from "./credential-access";
import { invocationBreaker, invocationBreakerKey } from "./invocation-breaker";
import { runtimeCooldown, runtimeCooldownForSelection } from "./runtime-cooldown";
import { runtimeReadsWithTools } from "../../shared/runtime-capabilities";
import { withDurableRuntimeRetry } from "./durable-retry";
import { withModelImageBudget } from "./model-image-budget";
import type {
  AgentRuntimeOverride,
  RuntimeRole,
  RuntimeSelection,
  RuntimeStatus,
} from "../../shared/types";
import { agentFollowedRole, agentOwnOrderOverrides, findAgentRuntimeOverride, type RuntimeOverrideTarget } from "../store/agent-runtime-overrides";
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
import { runLMStudio, lmStudioHost } from "./lmstudio";
import { runMLX } from "./mlx";
import { ollamaHost, runOllama } from "./ollama";
import { runManagedLocalModel } from "../local-model-hub/runtime-adapter";
import { acquireRunSlot, beginRunActivity, runSlotLendBudget } from "./run-slots";
import { createSlotLease, runWithSlotLease } from "./run-slot-lease";
import { withHostNativeWriter } from "./native-writer-host";
import { agentActivityKey, registerAgentResidency, touchAgentResidency } from "./agent-residency";
import { ACP_AGENTS, acpDisabledFor, acpOrLegacyRunner, acpSessionKind, createAcpRunner, type AcpAgentSpec } from "./acp";
import { resolveAcpAgentSpec } from "./acp-agents";
import { acquireLocalInferenceSlot, localInferenceLendBudget } from "./local-inference-run-slots";
import { markRefusedBeforeDispatch, tagPickedRunnerKind, withNativeBrowserGuidance, type Runner, type RunnerEvents, type RunnerFailure, type RunnerRequest, type RunnerResult } from "./runner";
import { getSubscriptionCreditUse, peekProviderQuotaExhausted } from "../usage";
import { peekAgentlasCreditsAvailable } from "../billing";
import { listModelRoleMembers } from "../store/model-roles";
import { CONNECTABLE_RUNTIMES, ollamaModelListIncludes, ollamaModelNamesEqual, type ConnectableRuntime } from "../../shared/runtime-connect";
import { probeRuntimeAuthForRun } from "./runtime-connect";
import { abortReasonError } from "./abort-reason";
import { withAgentContext } from "./agent-context";
import { responsesContextPolicy } from "./responses-context-policy";
import { withDaemonAgentContext } from "./agent-context-admission";
import { withOversizedInputSpill } from "./oversized-input";
import { currentModelCallScope, withModelCallLedger } from "./model-call-ledger";
import { currentRunPriority, harnessOpenedTurn, slotPriorityForCall } from "./run-priority";
import { withRemoteCurationRuntime } from "./remote-curation-binding";
import { withMemorySourceRunner } from "../memory/source-custody";

/**
 * The auth probe is an observation: its result is logged (and refreshes the connect chips' cache), and nothing decides on
 * it. The provider stays authoritative for an auth failure. It used to be awaited before every turn while holding the run
 * slot: `agy models` and `grok models` are network calls, about 3.1 s on average and up to 7.7 s per agy turn
 * (independent review wave 2, desktop-w2-05). It now runs beside the turn, at most once a minute per runtime and source.
 * Not per working folder: a run in another folder or product home never refreshes the chips' cache (probeRuntimeAuthForRun),
 * so its probe only wrote a log line. Production 1.3.57 ran `codex login status` 349 times, 200–1,425 ms each, because every
 * folder had its own minute (performance review 2026-10-17, H6).
 */
const RUNTIME_AUTH_PROBE_INTERVAL_MS = 60_000;
const runtimeAuthProbeStartedAt = new Map<string, number>();

/**
 * A typed failure these host wrappers return before any runner is entered. It says so (RuntimeTurnDelivery "not-dispatched"):
 * without it mcp/client.ts cannot tell the refusal from a dispatched turn and reports "the request may have acted"
 * (runtime_turn_unsettled), which skips the role-pool fallback and closes the send queue's retry on a message no model saw.
 * ownerControlTerminal stays "uncertain" like local-tool-loop refusedBeforeDispatch: no follow-up episode runs on a refusal.
 */
function refusedBeforeRunner(failure: RunnerFailure): RunnerResult {
  return { text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure };
}

/**
 * The typed failure a run is ended with when the auth probe beside it measured "signed out" (trial, repair 8 R1). Same shape as a provider's own auth
 * failure (kind "auth", source "marker"), so every caller that already writes the shared "signed out" fact and the login cooldown from a failed run
 * (judgment.ts recordAttempt, mcp/client.ts) does it with its own full runtime identity, and the next background call is skipped before dispatch by that cooldown.
 */
export const SIGNED_OUT_PROBE_CODE = "runtime_signed_out_probe";
function signedOutProbeFailure(kind: string, locale: RunnerRequest["locale"]): RunnerFailure {
  return { kind: "auth", runtime: kind, source: "marker", providerCode: SIGNED_OUT_PROBE_CODE,
    message: locale === "ko" ? "이 실행기는 로그인되어 있지 않아 호출을 멈췄습니다. 로그인한 뒤 다시 시도하세요."
      : "This runtime is signed out, so the call was stopped. Sign in and try again." };
}

/**
 * Per-turn, before the provider or its reusable session is used. Unknown probes are not authentication.
 *
 * The probe is measured beside the run. Its answer used to be only logged, so a signed-out CLI whose run never ends (the trial: `codex login status`
 * said "Not logged in" 70 ms after the call started and the call ran its whole 300 s) kept waiting. A probe that measured "signed-out" now ends the run it
 * was started for, as an auth failure, when that run has produced nothing yet (no answer text and no tool: a run that is answering is signed in, whatever a
 * status command says; the provider stays authoritative then). Any other probe state (unknown, signed-in, timeout, not-installed) changes nothing.
 */
export function withRuntimeAuthProbe(runner: Runner, runtimeKind: string): Runner {
  if (!CONNECTABLE_RUNTIMES.includes(runtimeKind as ConnectableRuntime)) return runner;
  const kind = runtimeKind as ConnectableRuntime;
  return async (req, events) => {
    if (req.signal?.aborted) throw abortReasonError(req);
    const probeKey = `${kind}\0${req.runtimeSource ?? ""}`;
    const now = Date.now();
    let signedOutProbe: Promise<boolean> | null = null;
    if ((runtimeAuthProbeStartedAt.get(probeKey) ?? -Infinity) + RUNTIME_AUTH_PROBE_INTERVAL_MS <= now) {
      runtimeAuthProbeStartedAt.set(probeKey, now);
      // Only measured codes and command evidence: no credential values, stdout, account, source path or env.
      signedOutProbe = probeRuntimeAuthForRun(kind, { runtimeSource: req.runtimeSource, env: req.env, cwd: req.cwd }).then((probe) => {
        console.info("[runtime-auth-probe]", JSON.stringify({ schemaVersion: "agentlas.runtime-auth-before-run.v1", kind,
          state: probe.state, reason: probe.reason ?? probe.state, checkedAt: probe.checkedAt, latencyMs: probe.latencyMs, evidence: probe.evidence }));
        return probe.state === "signed-out";
      }, () => {
        console.info("[runtime-auth-probe]", JSON.stringify({ schemaVersion: "agentlas.runtime-auth-before-run.v1", kind,
          state: "unknown", reason: "probe-failed" }));
        return false;
      });
    }
    // The provider remains authoritative for auth failure and runtime fallback; absent status commands (Kimi) and
    // timeouts never block a valid run.
    if (req.signal?.aborted) throw abortReasonError(req);
    // Re-read after slot/auth waits: the owner may have turned spending off
    // since selection. Unknown observations do not manufacture exhaustion.
    if (["claude-code", "codex"].includes(kind) && !getSubscriptionCreditUse()
      && peekProviderQuotaExhausted(kind, Date.now(), req.model)) {
      // Host admission is unavailable before dispatch, not a request refusal
      // or a provider quota failure that adds cooldown or paid fallback.
      return refusedBeforeRunner({ kind: "unavailable", source: "marker", runtime: kind,
        providerCode: "subscription_credits_disabled",
        message: req.locale === "ko" ? "구독 한도가 소진됐고 크레딧 자동 사용이 꺼져 있어 시작하지 않았습니다."
          : "This run was not started: the subscription limit is reached and automatic credit use is off." });
    }
    if (!signedOutProbe) return runner(req, events);
    // The probe started for this run may end it. The run gets its own signal that follows the caller's (same reason), so the caller's Stop still reads as its own.
    const stop = new AbortController();
    const relay = (): void => stop.abort(req.signal?.reason);
    req.signal?.addEventListener("abort", relay, { once: true });
    const state: { answering: boolean; finished: boolean; cut: RunnerFailure | null } = { answering: false, finished: false, cut: null };
    const watched: RunnerEvents = { ...events,
      onPartial: (chunk) => { state.answering = true; events.onPartial(chunk); },
      ...(events.onTool ? { onTool: (...args: Parameters<NonNullable<RunnerEvents["onTool"]>>) => { state.answering = true; events.onTool?.(...args); } } : {}) };
    void signedOutProbe.then((signedOut) => {
      if (!signedOut || state.answering || state.finished || req.signal?.aborted) return;
      state.cut = signedOutProbeFailure(kind, req.locale);
      stop.abort(new Error(state.cut.message));
    });
    try {
      const result = await runner({ ...req, signal: stop.signal }, watched);
      return state.cut && !result.text ? { text: "", ownerControlTerminal: "uncertain", failure: state.cut } : result;
    } catch (error) {
      if (state.cut && !req.signal?.aborted) return { text: "", ownerControlTerminal: "uncertain", failure: state.cut };
      throw error;
    } finally {
      state.finished = true;
      req.signal?.removeEventListener("abort", relay);
    }
  };
}

/**
 * CLI 러너를 전역 실행 슬롯으로 래핑 — 챗·firm·swarm·워크플로우·자동화가 각자 캡으로
 * 곱셈 스폰해도 동시 CLI 자식 수가 사용자 슬라이더(getAgentConcurrency)를 못 넘는다.
 * 슬롯이 차면 FIFO 대기(+상태 줄 표시), abort 시 즉시 이탈. 진짜 원격 API인 BYOK는
 * 로컬 자원을 거의 안 쓰므로 래핑하지 않는다 — 로컬 추론(Ollama/LM Studio/MLX)은
 * HTTP로 호출하지만 로컬 CPU/GPU를 쓰므로 아래 withLocalInferenceSlot으로 별도 래핑한다.
 * 주의: 러너 내부 재시도(runClaudeCode의 세션 복구 재귀)는 래핑 밖이라 이중 획득이 없다.
 */
function withRunSlot(runner: Runner, runtimeKind: string): Runner {
  const checkedRunner = withRuntimeAuthProbe(runner, runtimeKind);
  return async (req, events) => {
    // The native handle namespace follows the actual transport, using the same inventory/switch as its dispatcher.
    const acp = ACP_AGENTS[runtimeKind];
    const writerKind = acp && !acpDisabledFor(runtimeKind) ? acpSessionKind(acp.id) : runtimeKind;
    return withHostNativeWriter(writerKind, req, events, async () => {
    // 우선순위: 요청 명시값 → 호출 문맥(withRunPriority) → interactive.
    // 자동화 스케줄러·데몬 graph.run 이 background 문맥을 깔고, 채팅 턴은 기본값이다.
    // 오너 턴 안에서 맡긴 일(firm/swarm/task-force 워커·플래너·종합, 큐레이터)은 오너 레인을 쓰지 않는다(NH20).
    const slotPriority = req.runPriority ?? slotPriorityForCall(currentRunPriority(), currentModelCallScope()?.role);
    const onSlotQueued = () => {
      events.onStatus(
        req.locale === "ko"
          ? "다른 에이전트 실행이 끝나기를 기다리는 중... (동시 실행 한도)"
          : "Waiting for a free run slot... (concurrency limit)",
        { code: "queue_wait" }, // machine-readable: a lead room's time limit does not run while a member waits for a slot
      );
    };
    const release = await acquireRunSlot(req.signal, onSlotQueued, slotPriority);
    // N0b: while a person decides on a card or question this turn raised, the slot is let go and taken again in the same lane.
    // A person's answer is the owner's hand: the slot is taken again in the owner lane (queued behind owner turns only, never behind
    // an automation pass that was started meanwhile), and a pool whose lent slots reached its limit lends no more (run-slot-lease.ts).
    const slotLease = createSlotLease(release, () => acquireRunSlot(req.signal, onSlotQueued, "owner"), runSlotLendBudget);
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
      return await runWithSlotLease(slotLease, req.signal, () => checkedRunner(req, events));
    } finally {
      try { touchAgentResidency(residencyKey, { inUse: false }); } catch { /* 관측 실패 무시 */ }
      slotLease.close();
    }
    });
  };
}

/**
 * API runs (BYOK, Agentlas serving) hold no CLI child, so they were never counted: the run-slot "busy" signal and the quiet clock
 * said "idle" while an API turn was streaming, and a host-opened turn (a goal continuation, a teammate's message) on an API runner
 * started without any bound, after a restart all of them at once (N8). This wrapper marks the run as working, and sends a turn
 * the product opened through a run slot like a CLI turn; the owner's own message takes no slot and starts exactly as before.
 */
export function withApiRunActivity(runner: Runner): Runner {
  return async (req, events) => {
    const endActivity = beginRunActivity();
    let slotLease: ReturnType<typeof createSlotLease> | null = null;
    try {
      if (!harnessOpenedTurn()) return await runner(req, events);
      const slotPriority = req.runPriority ?? slotPriorityForCall(currentRunPriority(), currentModelCallScope()?.role);
      const onSlotQueued = () => {
        events.onStatus(
          req.locale === "ko"
            ? "다른 에이전트 실행이 끝나기를 기다리는 중... (동시 실행 한도)"
            : "Waiting for a free run slot... (concurrency limit)",
          { code: "queue_wait" },
        );
      };
      const release = await acquireRunSlot(req.signal, onSlotQueued, slotPriority);
      slotLease = createSlotLease(release, () => acquireRunSlot(req.signal, onSlotQueued, "owner"), runSlotLendBudget);
      return await runWithSlotLease(slotLease, req.signal, () => runner(req, events));
    } finally {
      slotLease?.close();
      endActivity();
    }
  };
}

/**
 * 로컬 추론(LM Studio/MLX/Agentlas Local) 전용 실행 슬롯 래퍼. CLI 자식 프로세스 예산과는
 * 별개의(보통 훨씬 낮은) 한도를 쓴다 — 로컬 추론 요청 1건이 이미 코어 대부분/GPU를
 * 쓰므로 CLI와 같은 예산으로 게이트하면 과다 산정되고, 아예 안 걸면 여러 에이전트가
 * 동시에 로컬 모델을 때려 컴퓨터를 못 쓰게 만들 수 있다.
 */
function withLocalInferenceSlot(runner: Runner): Runner {
  return async (req, events) => {
    // N8: a local-inference run has its own pool but is work like any other: the busy signal and the quiet clock count it.
    const endActivity = beginRunActivity();
    try {
    const slotPriority = req.runPriority ?? slotPriorityForCall(currentRunPriority(), currentModelCallScope()?.role);
    const onSlotQueued = () => {
      events.onStatus(
        req.locale === "ko"
          ? "다른 로컬 추론이 끝나기를 기다리는 중... (동시 실행 한도)"
          : "Waiting for a free local inference slot... (concurrency limit)",
        { code: "queue_wait" },
      );
    };
    const release = await acquireLocalInferenceSlot(req.signal, onSlotQueued, slotPriority);
    const slotLease = createSlotLease(release, () => acquireLocalInferenceSlot(req.signal, onSlotQueued, "owner"), localInferenceLendBudget);
    try {
      return await runWithSlotLease(slotLease, req.signal, () => runner(req, events));
    } finally {
      slotLease.close();
    }
    } finally {
      endActivity();
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
// The local loop imports the common selector through MCP; resolve the
// exported const only at dispatch, after that module cycle has initialized.
const runOllamaSlotted = withLocalInferenceSlot((req, events) => runOllama(req, events));
const runLMStudioSlotted = withLocalInferenceSlot(runLMStudio);
const runMLXSlotted = withLocalInferenceSlot(runMLX);
const runManagedLocalModelSlotted = withLocalInferenceSlot(runManagedLocalModel);
const runAnthropicByokActive = withApiRunActivity((req, events) => runAnthropicByok(req, events));
const runOpenAIByokActive = withApiRunActivity((req, events) => runOpenAIByok(req, events));
const runGoogleByokActive = withApiRunActivity((req, events) => runGoogleByok(req, events));
const runUpstageByokActive = withApiRunActivity((req, events) => runUpstageByok(req, events));
const runCustomByokActive = withApiRunActivity((req, events) => runCustomByok(req, events));
const runGlmByokActive = withApiRunActivity((req, events) => runGlmByok(req, events));
const runKimiByokActive = withApiRunActivity((req, events) => runKimiByok(req, events));
const runDeepseekByokActive = withApiRunActivity((req, events) => runDeepseekByok(req, events));
const runMinimaxByokActive = withApiRunActivity((req, events) => runMinimaxByok(req, events));
const runXaiByokActive = withApiRunActivity((req, events) => runXaiByok(req, events));
const runOpenRouterByokActive = withApiRunActivity((req, events) => runOpenRouterByok(req, events));
const runAgentlasServingActive = withApiRunActivity((req, events) => runAgentlasServing(req, events));

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

/**
 * The name a person reads for a runtime kind ("Claude Code", not "claude-code").
 * Chat copy used the raw kind (QA 2026-09-27: "claude-code을(를) 사용하도록 선택했습니다").
 */
export function runtimeDisplayName(kind: string): string {
  const label = RUNNER_LABEL[kind];
  if (!label) return kind;
  return label.replace(/ CLI$/, "");
}

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
  // effortDefault "provider": with nothing chosen the runner sends no effort and the CLI applies its own per-model
  // default. The lowest advertised level was sent instead (claude-code ran `--effort low`, below Claude's own default).
  const providerDefault = runtime.allocationModelProfiles?.[model]?.effortDefault === "provider";
  if (requested == null) return defaultEffort ?? (providerDefault ? null : supported[0] ?? null);
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
  return below.at(-1) ?? defaultEffort ?? (providerDefault ? null : supported[0] ?? null);
}

/** Bootstrap-only monotonic provider restriction. A missing/expired host lease never falls back. */
let servingOnlyHostCurrent: (() => boolean) | undefined;
export function configureServingOnlyHostPolicy(current: () => boolean): void {
  if (typeof current !== "function") throw new Error("runtime_host_policy_invalid");
  if (servingOnlyHostCurrent) throw new Error("runtime_host_policy_immutable");
  servingOnlyHostCurrent = current;
}
function hostRuntimeAllowed(kind: string): boolean {
  if (!servingOnlyHostCurrent) return true;
  try { return kind === "agentlas" && servingOnlyHostCurrent() === true; } catch { return false; }
}

export function pickRunner(active: RuntimeStatus): { runner: Runner; label: string } | null {
  if (!hostRuntimeAllowed(active.kind)) return null;
  const resolvedSpec = active.kind === "acp" ? resolveAcpAgentSpec(active.acpAgentId) : null;
  // One immutable selected spec supplies both the spawned runner and its
  // portable/native binding; a shared executable must not merge ACP profiles.
  const spec = resolvedSpec ? { ...resolvedSpec, args: [...resolvedSpec.args] } : null;
  const localIdentity = active.kind === "ollama" ? ollamaHost() : undefined;
  const configurationIdentity = localIdentity ?? (spec ? JSON.stringify([spec.id,spec.command,spec.args,spec.registryId??null]) : undefined);
  const selectedIdentity = JSON.stringify([active.kind, active.backend, active.source, active.acpAgentId ?? null]);
  const configurationCurrent = () => {
    if (selectedIdentity !== JSON.stringify([active.kind, active.backend, active.source, active.acpAgentId ?? null])) return false;
    if (active.kind === "ollama") return ollamaHost() === localIdentity;
    if (active.kind !== "acp") return true;
    const current = resolveAcpAgentSpec(active.acpAgentId);
    return configurationIdentity === JSON.stringify(current ? [current.id,current.command,current.args,current.registryId??null] : null);
  };
  const unfitted = pickRunnerWithoutHostGuidance(active, spec);
  // Pictures are fitted to this runtime's provider limits right at the adapter (runtime/model-image-budget.ts, owner).
  const selected = unfitted ? { ...unfitted, runner: withModelImageBudget(unfitted.runner, active.kind) } : null;
  // 모든 제품 경로가 여기를 지난다 — 어느 루프에 버그가 있어도 실패하는 런타임을 분당 수만 번 띄우지 못한다(invocation-breaker).
  // The kind tag lets an inheriting caller (the memory curator) read this runtime's declared request limits.
  const picked = selected
    ? { ...selected, runner: tagPickedRunnerKind(invocationBreaker.wrap(withNativeBrowserGuidance(withDaemonAgentContext(withAgentContext(
      // Innermost: the ledger sees the request after every host wrapper, exactly as the adapter does (context-reduction C01).
      withMemorySourceRunner(withRemoteCurationRuntime(withModelCallLedger(withDurableRuntimeRetry(async(req,events)=>{if(!configurationCurrent())throw markRefusedBeforeDispatch(Object.assign(new Error("runtime_selected_configuration_changed"),{code:"runtime_selected_configuration_changed"}));return selected.runner(req,events);}, active), { kind: active.kind, backend: active.backend ?? null, model: active.model ?? null, effort: null }), active, configurationCurrent)),
      { kind: active.kind, ...(active.backend ? { backend: active.backend } : {}) },
      { configurationSource:active.source,configurationIdentity }),
      { kind: active.kind,configurationIdentity,...(active.backend ? { backend: active.backend } : {}) }), active.kind), invocationBreakerKey(active), selected.label), active.kind) }
    : null;
  // Outer pass: pictures are resized before the agent context journals the turn or the daemon receives it (sizes only; the
  // inner pass above also fits the count, once earlier turns' pictures are added).
  // An input larger than half of the model's window is kept as a file and goes as a reference (runtime/oversized-input.ts); outermost, so the
  // journal and the daemon only ever see the reference.
  return picked ? { ...picked, runner: tagPickedRunnerKind(withOversizedInputSpill(withModelImageBudget(picked.runner, active.kind, { combine: false }),
    { kind: active.kind, ...(active.backend ? { backend: active.backend } : {}) }), active.kind) } : null;
}

function pickRunnerWithoutHostGuidance(active: RuntimeStatus, acpSpec: AcpAgentSpec | null): { runner: Runner; label: string } | null {
  if (isRuntimeCredentialUnavailable(active)) {
    return {
      label: `BYOK · ${active.backend}`,
      // The code keeps this keychain refusal apart from a provider sign-in failure: no cooldown, no "signed out" mark, no
      // CLI sign-in card (runtime-cooldown.ts noteRuntimeFailure; mcp/client.ts emitTerminalRecoveryFailure).
      runner: async (req) => refusedBeforeRunner({
        kind: "auth",
        runtime: `byok:${active.backend}`,
        source: "marker",
        providerCode: RUNTIME_CREDENTIAL_UNAVAILABLE_CODE,
        message: req.locale === "ko"
          ? `${active.backend}의 저장된 API 키에 접근할 수 없습니다. 도움말 메뉴에서 해당 API 키 접근을 다시 시도할 수 있습니다.`
          : `The saved ${active.backend} API key is unavailable. Use Help to retry access to this API key.`,
      }),
    };
  }
  if (runtimeModelUnavailable(active, active.model)) {
    return {
      label: RUNNER_LABEL[active.kind] ?? active.label ?? active.kind,
      runner: async (req) => refusedBeforeRunner({
        kind: "unsupported",
        runtime: active.kind === "byok" ? `byok:${active.backend}` : active.kind,
        source: "marker",
        providerCode: "runtime_model_unavailable",
        message: req.locale === "ko"
          ? `선택한 모델 ${active.model}이 현재 ${active.kind} 모델 목록에 없습니다. 연결을 다시 확인하거나 사용 가능한 모델을 선택해 주세요.`
          : `The selected model ${active.model} is absent from the current ${active.kind} model list. Refresh the connection or select an available model.`,
      }),
    };
  }
  if (active.kind === "claude-code") return { runner: bindRuntimeSource(runClaudeCodeSlotted, active.source), label: RUNNER_LABEL["claude-code"] };
  if (active.kind === "codex") return { runner: bindRuntimeSource(runCodexSlotted, active.source), label: RUNNER_LABEL.codex };
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
    const spec = acpSpec;
    if (!spec) return null;
    return {
      runner: bindRuntimeSource(withRunSlot(createAcpRunner(spec), acpSessionKind(spec.id)), active.source),
      label: `${active.label ?? spec.label}${active.model ? ` · ${active.model}` : ""}`,
    };
  }
  // The explicit external server/model remains a distinct local runtime; a
  // managed-model migration cannot silently substitute its selected identity.
  if (active.kind === "ollama") return { runner: runOllamaSlotted, label: `Ollama${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "lmstudio")
    return { runner: runLMStudioSlotted, label: `LM Studio${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "mlx")
    return { runner: runMLXSlotted, label: `MLX${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "agentlas-local")
    return { runner: runManagedLocalModelSlotted, label: `Agentlas Local${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "agentlas") {
    // 서버가 실행을 들고 있으므로 로컬 실행 슬롯을 잡지 않는다 — 이 기계의 CPU 를 쓰지 않는
    // 원격 호출이라, BYOK 와 같은 취급이 맞다. (.)
    return { runner: runAgentlasServingActive, label: agentlasServingRunnerLabel(active.model) };
  }
  if (active.kind === "byok") {
    if (active.backend === "anthropic")
      return { runner: runAnthropicByokActive, label: RUNNER_LABEL["byok:anthropic"] };
    if (active.backend === "openai")
      return { runner: runOpenAIByokActive, label: RUNNER_LABEL["byok:openai"] };
    if (active.backend === "google")
      return { runner: runGoogleByokActive, label: RUNNER_LABEL["byok:google"] };
    if (active.backend === "upstage")
      return { runner: runUpstageByokActive, label: RUNNER_LABEL["byok:upstage"] };
    if (active.backend === "custom")
      return { runner: runCustomByokActive, label: RUNNER_LABEL["byok:custom"] };
    if (active.backend === "glm")
      return { runner: runGlmByokActive, label: RUNNER_LABEL["byok:glm"] };
    if (active.backend === "kimi")
      return { runner: runKimiByokActive, label: RUNNER_LABEL["byok:kimi"] };
    if (active.backend === "deepseek")
      return { runner: runDeepseekByokActive, label: RUNNER_LABEL["byok:deepseek"] };
    if (active.backend === "minimax")
      return { runner: runMinimaxByokActive, label: RUNNER_LABEL["byok:minimax"] };
    if (active.backend === "xai")
      return { runner: runXaiByokActive, label: RUNNER_LABEL["byok:xai"] };
    if (active.backend === "openrouter")
      return { runner: runOpenRouterByokActive, label: RUNNER_LABEL["byok:openrouter"] };
  }
  return null;
}

/**
 * Exact DB-independent runner for One's recovery plane. It never selects a
 * different runtime. Local inference shares the normal in-memory FIFO queue,
 * with a conservative limit if the operational store cannot be read. This
 * path is only for tool-free judgment while that store is unavailable.
 */
export function pickRecoveryRunner(selection: Pick<RuntimeStatus, "kind"> & { source?: string; acpAgentId?: string }): {
  runner: Runner;
  label: string;
} | null {
  if (!hostRuntimeAllowed(selection.kind)) return null;
  if (selection.kind === "claude-code") return { runner: bindRuntimeSource(withRuntimeAuthProbe(runClaudeCode, "claude-code"), selection.source), label: RUNNER_LABEL["claude-code"] };
  if (selection.kind === "codex") return { runner: bindRuntimeSource(withRuntimeAuthProbe(runCodex, "codex"), selection.source), label: RUNNER_LABEL.codex };
  if (selection.kind === "antigravity") {
    return {
      runner: bindRuntimeSource(withRuntimeAuthProbe(runAntigravity, "antigravity"), selection.source),
      label: RUNNER_LABEL.antigravity,
    };
  }
  if (selection.kind === "kimi") return { runner: bindRuntimeSource(withRuntimeAuthProbe(acpOrLegacyRunner("kimi", runKimi), "kimi"), selection.source), label: RUNNER_LABEL.kimi };
  if (selection.kind === "grok") return { runner: bindRuntimeSource(withRuntimeAuthProbe(acpOrLegacyRunner("grok", runGrok), "grok"), selection.source), label: RUNNER_LABEL.grok };
  if (selection.kind === "cursor") return { runner: bindRuntimeSource(withRuntimeAuthProbe(acpOrLegacyRunner("cursor", runCursor), "cursor"), selection.source), label: RUNNER_LABEL.cursor };
  if (selection.kind === "acp") {
    const spec = resolveAcpAgentSpec(selection.acpAgentId);
    if (!spec) return null;
    return { runner: bindRuntimeSource(createAcpRunner(spec), selection.source), label: spec.label };
  }
  if (selection.kind === "agentlas") return { runner: runAgentlasServing, label: "Agentlas" };
  if (selection.kind === "ollama") return { runner: runOllamaSlotted, label: "Ollama" };
  if (selection.kind === "agentlas-local") return { runner: runManagedLocalModelSlotted, label: "Agentlas Local" };
  if (selection.kind === "lmstudio") return { runner: runLMStudioSlotted, label: "LM Studio" };
  if (selection.kind === "mlx") return { runner: runMLXSlotted, label: "MLX" };
  return null;
}

function applyRoleSelection(runtime: RuntimeStatus, role: RuntimeRole): RuntimeStatus {
  const selection = runtime.roleSelections?.[role];
  if (!selection) return { ...runtime, active: true };
  const model = selection.model;
  return {
    ...runtime,
    active: true,
    model,
    effort: selection.effort == null
      ? selection.effort
      : effortForSelectedModel(runtime, model, selection.effort),
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
  if (selection.kind === "acp" && runtime.acpAgentId !== selection.acpAgentId) return false;
  return true;
}

/** Keep credential refusals ahead of inventory conclusions. */
export function runtimeModelUnavailable(runtime: RuntimeStatus, selectedModel: string | null | undefined): boolean {
  if (!selectedModel?.trim() || isRuntimeCredentialUnavailable(runtime)) return false;
  return runtimeModelUnavailableByInventory(runtime, selectedModel, ollamaModelListIncludes);
}

/** Keep exact pins on their selected provider unless its own authoritative
 * inventory proves the model absent or its credential cannot be read. */
export function pinnedRuntimeCredentialOrModelUnavailable(runtime: RuntimeStatus): boolean {
  return isRuntimeCredentialUnavailable(runtime) || runtimeModelUnavailable(runtime, runtime.model);
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
  // A near-limit warning still leaves usable quota. Only an exhausted snapshot
  // excludes a candidate; actual provider quota/auth failures retain their cooldown.
  // 역할 풀 선택(detect.ts rolePoolGates)도 같은 판정을 쓴다 — shared/runtime-quota.
  if (peekProviderQuotaExhausted(selection.kind, Date.now(), selection.model ?? undefined)) return "quota-exceeded";
  return null;
}

/**
 * Why an exact runtime the owner chose cannot take a dispatch right now (null = usable). A room's pinned model that
 * serves its teammates is checked with this before each dispatch: an unusable pin is a typed refusal, never a swap.
 */
export function pinnedRuntimeUnavailableReason(runtime: RuntimeStatus): string | null {
  const cooling = runtimeCooldown(runtime);
  if (cooling) return `cooldown-${cooling.kind}`;
  return runtimeSelectionUnavailableReason(runtime, runtimeStatusSelection(runtime)) ?? null;
}

function runtimeStatusSelection(runtime: RuntimeStatus): import("../../shared/types").RuntimeSelection {
  return {
    kind: runtime.kind,
    backend: runtime.backend,
    source: runtime.source,
    acpAgentId: runtime.acpAgentId,
    label: runtime.label,
    model: runtime.model ?? undefined,
    effort: runtime.effort ?? undefined,
    longContext: runtime.longContextEnabled,
  };
}

export function runtimeMatchesSelection(
  runtime: RuntimeStatus,
  selection: Pick<RuntimeSelection, "kind" | "backend" | "source" | "acpAgentId">,
): boolean {
  return runtime.kind === selection.kind
    && (!selection.backend || runtime.backend === selection.backend)
    && (!selection.source || runtime.source === selection.source)
    && (selection.kind !== "acp" || Boolean(selection.acpAgentId) && runtime.acpAgentId === selection.acpAgentId);
}

function applyStoredRoleSelection(
  runtime: RuntimeStatus,
  selection: RuntimeSelection,
): RuntimeStatus {
  const model = selection.model;
  return {
    ...runtime,
    active: true,
    model,
    effort: selection.effort == null
      ? selection.effort
      : effortForSelectedModel(runtime, model, selection.effort),
    longContextEnabled: selection.longContext ?? runtime.longContextEnabled,
  };
}

/**
 * One exact owner choice (a goal chat's model chip) → the live runtime it names, gated
 * exactly like a role-pool member: credential readable, not in cooldown, model present,
 * quota not exhausted. null means "not usable right now" — the caller falls back to the pool.
 * Used by agent-created automations that follow the owner's current configuration
 * (automation-runtime-plan.ts) instead of a stale copied pin.
 */
export function runtimeForOwnerSelection(
  runtimes: RuntimeStatus[],
  selection: RuntimeSelection | null | undefined,
): RuntimeStatus | null {
  if (!selection) return null;
  const matched = runtimes.find((runtime) => runtimeMatchesSelection(runtime, selection));
  if (!matched) return null;
  const candidate = applyStoredRoleSelection(matched, selection);
  if (isRuntimeCredentialUnavailable(candidate) || runtimeCooldown(candidate)) return null;
  if (runtimeSelectionUnavailableReason(candidate, runtimeStatusSelection(candidate))) return null;
  return candidate;
}

/** Only host/provider machine markers block replay; diagnostic prose is not authority. */
export function runtimeFailureBlocksReplay(failure: Pick<RunnerFailure, "providerCode"> | null | undefined): boolean {
  return failure?.providerCode === "serving_reconciliation_required"
    || failure?.providerCode === "runtime_turn_unsettled"
    || failure?.providerCode === "automation_no_progress_loop";
}

/**
 * True when this failure must not be replayed on another runtime, whatever the candidates are. rolePriorityRuntimes returns
 * nothing for it, and a caller that adds a candidate of its own (the light front's own lane) asks the same question first,
 * so an empty pool that merely has nobody left is told apart from a replay guard.
 */
export function roleFallbackBlocked(options: {
  failedRuntime?: RuntimeStatus;
  failure?: Pick<RunnerFailure, "kind" | "providerCode">;
  /**
   * The caller holds proof that this unsettled turn acted on nothing (runtime/unsettled-fallback.ts decides, from the effect
   * boundary and the pin). It lifts the unsettled-turn block only; an unsettled serving settlement and a no-progress loop stand.
   */
  unsettledNoEffectProven?: boolean;
}): boolean {
  // The serving provider may already have generated billable tokens. An
  // unresolved settlement must stop this invocation, not replay the prompt on
  // another configured runtime.
  if (runtimeFailureBlocksReplay(options.failure)
    && !(options.unsettledNoEffectProven === true && options.failure?.providerCode === "runtime_turn_unsettled")) return true;
  // The managed local runner has not processed these images. Team/controller
  // recovery must not forward them to another provider as an outage retry.
  if (options.failure?.kind === "unsupported"
    && options.failure.providerCode === "local_model_image_input_unsupported") return true;
  // Unavailable credential storage requires explicit recovery of the selected key.
  // Do not turn its marker failure into a run on another provider.
  return isRuntimeCredentialUnavailable(options.failedRuntime);
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
    failure?: Pick<RunnerFailure, "kind" | "providerCode"> & Partial<Pick<RunnerFailure, "source">>;
    exclude?: RuntimeStatus[];
    /** Post-dispatch paid fallback requires explicit evidence that replay is safe. */
    allowCreditFallback?: boolean;
    /** Use legacy active runtime when no role rows exist (default true). */
    allowLegacyActive?: boolean;
    /** See roleFallbackBlocked: the unsettled turn is proven to have acted on nothing. */
    unsettledNoEffectProven?: boolean;
  } = {},
): RuntimeStatus[] {
  if (roleFallbackBlocked(options)) return [];
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
    // An attempted entry identifies one executable/model pair. Excluding the
    // whole executable here silently removed the next configured model even
    // though non-auth/non-quota failures are model-scoped below.
    if (excluded.some((item) => sameRuntimeModel(candidate, item))) return true;
    if (
      options.failedRuntime
      && options.failure
      && runtimeFailureSharesProviderDomain(candidate, options.failedRuntime, options.failure)
    ) return true;
    return false;
  };
  const out: RuntimeStatus[] = [];
  let quotaFallbackEligible = options.failure?.kind === "quota" && options.failure.source === "marker"
    && options.failedRuntime?.kind !== "agentlas";
  const pushCandidate = (candidate: RuntimeStatus | null): void => {
    if (!candidate) return;
    const cooling = runtimeCooldown(candidate);
    if (!options.failure && cooling?.kind === "quota" && candidate.kind !== "agentlas") quotaFallbackEligible = true;
    if (blocked(candidate) || !pickRunner(candidate)) return;
    const unavailable = runtimeSelectionUnavailableReason(candidate, runtimeStatusSelection(candidate));
    if (!options.failure && unavailable === "quota-exceeded" && candidate.kind !== "agentlas") quotaFallbackEligible = true;
    if (unavailable) return;
    if (!out.some((item) => sameRuntimeModel(item, candidate))) {
      out.push(candidate);
    }
  };
  const appendQuotaCreditFallback = (): void => {
    if (options.allowCreditFallback === false || (options.failure && options.allowCreditFallback !== true)
      || !quotaFallbackEligible || !peekAgentlasCreditsAvailable()) return;
    // Credits are a quota-only last resort after the owner's configured pool.
    // Auth/storage failures and unresolved external effects never enter here.
    const serving = runtimes.find(runtime => runtime.kind === "agentlas" && !runtime.signInRequired);
    if (serving) pushCandidate({ ...serving, active: true });
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
    appendQuotaCreditFallback();
    return out;
  }

  // Legacy/unconfigured stores have no ordered pool yet. Keep the old active
  // role behavior only in that case; once a pool exists, no detection-order
  // runtime may be smuggled in ahead of its DB rows.
  if (options.allowLegacyActive === false) return out;
  const legacyActive = pickActive(runtimes, role);
  pushCandidate(legacyActive);
  appendQuotaCreditFallback();
  return out;
}

/**
 * Where a step that runs at read permission and may use tools starts: the runtime it was going to use when that runtime reads
 * with tools (shared/runtime-capabilities.ts readWithTools), else the first runtime of `pool` (the caller's own ordered
 * candidates, rolePriorityRuntimes) that does and can take a dispatch. Capability rows decide; no runtime is named here.
 * `pinned` keeps the owner's exact pick, `browserOnly` (toolMode "browser") keeps the runtime, and a pool with nobody capable keeps the runtime: both run answer-only on it
 * (antigravity.ts antigravityAnswerOnlyRequest), so no read step ends refused.
 */
export function routeReadStepRuntime(
  active: RuntimeStatus,
  pool: readonly RuntimeStatus[],
  options: { permission: string | undefined; pinned?: boolean; browserOnly?: boolean },
): RuntimeStatus {
  // A browser-only run reaches its page through the runtime's own browser surface, not the read tool surface this routing is about
  // (antigravity.ts antigravityAnswerOnlyRequest leaves it alone too): it keeps the runtime it was going to use.
  if (options.permission !== "read" || options.pinned || options.browserOnly || runtimeReadsWithTools(active.kind)) return active;
  return pool.find((candidate) => runtimeReadsWithTools(candidate.kind) && pickRunner(candidate)) ?? active;
}

/**
 * The runtime that takes a turn over when the one it was going to use is listed but has no runner (an open ACP seat whose
 * profile was removed, a provider this host no longer allows). The owner's pool order first (rolePriorityRuntimes already
 * leaves out what is cooling down, exhausted or without a runner), then any other connected runtime that can take a dispatch
 * by the same test an unavailable Library assignment uses. Null = nothing can run. Never used for a runtime the owner pinned.
 */
export function nextRunnableRuntime(
  runtimes: RuntimeStatus[],
  unrunnable: RuntimeStatus,
  role: RuntimeRole = "orchestrator",
): RuntimeStatus | null {
  const pooled = rolePriorityRuntimes(runtimes, role, { exclude: [unrunnable] })[0];
  if (pooled) return pooled;
  for (const candidate of runtimes) {
    if (sameRuntimeModel(candidate, unrunnable) || isRuntimeCredentialUnavailable(candidate)
      || candidate.signInRequired || runtimeCooldown(candidate)) continue;
    const active = { ...candidate, active: true };
    if (runtimeSelectionUnavailableReason(active, runtimeStatusSelection(active))) continue;
    return active;
  }
  return null;
}

function sameRuntimeIdentity(left: RuntimeStatus, right: RuntimeStatus): boolean {
  return left.kind === right.kind
    && left.backend === right.backend
    && left.source === right.source
    && left.acpAgentId === right.acpAgentId;
}

/** One configured model may be written with or without Ollama's default tag. */
function sameRuntimeModel(left: RuntimeStatus, right: RuntimeStatus): boolean {
  if (!sameRuntimeIdentity(left, right)) return false;
  if (left.kind === "ollama" && left.model && right.model)
    return ollamaModelNamesEqual(left.model, right.model);
  return left.model === right.model;
}

/** Quota/rate-limit/auth is provider-wide (for open ACP seats: seat-wide); other failures stay scoped to one runtime/model pair. */
export function runtimeFailureSharesProviderDomain(
  candidate: RuntimeStatus,
  failed: RuntimeStatus,
  failure: Pick<RunnerFailure, "kind">,
): boolean {
  if (failure.kind === "auth" || failure.kind === "quota" || failure.kind === "rate_limit") {
    // Open ACP seats share one kind but can be different accounts: a limit on one keeps the others as candidates (records that name their seat are kept per seat).
    return candidate.kind === failed.kind && candidate.backend === failed.backend
      && (candidate.kind !== "acp" || candidate.acpAgentId === failed.acpAgentId);
  }
  // A transport/exit failure on one model must still allow the next model
  // configured on the same executable to run. Quota/auth remains provider-wide
  // above because that state is shared by the account, not the model.
  return sameRuntimeModel(candidate, failed);
}

/**
 * How the runtime an invocation resolved differs from the runtime a Goal checkpoint pinned.
 * `identity`: a different engine, executable, model or ACP seat — running it would run something nobody chose.
 * `tuning`: the same engine and model whose effort or long-context setting the resolution normalized (an effort the
 * model does not offer, an inventory that changed since the pin). A pin that names no model leaves the model to the
 * role's pick, which is no difference.
 */
export function goalRuntimePinDrift(
  pinned: Pick<import("../../shared/types").RuntimeSelection, "kind" | "backend" | "source" | "model" | "effort" | "longContext" | "acpAgentId">,
  confirmed: Pick<import("../../shared/types").RuntimeSelection, "kind" | "backend" | "source" | "model" | "effort" | "longContext">,
  confirmedAcpAgentId: string | null | undefined,
): { identity: boolean; tuning: boolean } {
  return {
    identity: confirmed.kind !== pinned.kind
      || confirmed.backend !== pinned.backend
      || confirmed.source !== pinned.source
      || (pinned.model !== undefined && confirmed.model !== pinned.model)
      || (pinned.acpAgentId !== undefined && confirmedAcpAgentId !== pinned.acpAgentId),
    tuning: (pinned.effort !== undefined && confirmed.effort !== pinned.effort)
      || (pinned.longContext !== undefined && confirmed.longContext !== pinned.longContext),
  };
}

export function selectExactRuntime(
  runtimes: RuntimeStatus[],
  selection: import("../../shared/types").RuntimeSelection,
): RuntimeChoice | null {
  const matched = runtimes.find((runtime) => runtimeMatchesSelection(runtime, selection));
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

/**
 * An agent's own model order (store/agent-runtime-overrides.ts): the first of its lines whose runtime is connected, has the model and
 * is not out of quota. Null when none can run (the caller then takes the existing unavailable-assignment path, which ends at the global
 * pool), or when the override is not an agent's own order.
 */
function firstUsableOwnLine(runtimes: RuntimeStatus[], first: AgentRuntimeOverride): AgentRuntimeOverride | null {
  if (first.scope !== "agent") return null;
  for (const line of agentOwnOrderOverrides(first.targetId)) {
    const matched = runtimes.find((runtime) => runtimeMatchesOverride(runtime, line));
    // A line whose runtime is resting after a rate limit, quota or sign-in failure is skipped like one that is not connected: the next line of the owner's own order takes the turn
    // instead of every turn starting on the resting line and failing until the limit ends (desktop 3, Workspace B-2). When no line is usable the first stays, as before.
    if (matched && !runtimeSelectionUnavailableReason(matched, line.selection) && !(line.selection.source ? runtimeCooldownForSelection(line.selection) : null) && !runtimeCooldown(matched)) return line;
  }
  return null;
}

/**
 * The rest of an agent's own order as candidates once a turn on one of its lines failed (desktop 3, Workspace B-2, the turn-time half): before the turn starts `firstUsableOwnLine` skips a line that is
 * resting, but a turn that started on line 1 and failed went on to the global Orchestrator pool only, so line 2 of the agent's own order was never tried (and a pool that is empty, or the same provider, ended the
 * turn with nothing left to try). The caller puts these BEFORE the pool's candidates. Same rules as the pool: nothing at all where a replay guard stands (`roleFallbackBlocked`), no resting runtime, no runtime that
 * shares the failed provider's domain, no unconnected or unrunnable line. `override` is the one the turn started on; anything but an agent's own order gives nothing. Reads only.
 */
export function ownOrderFallbackRuntimes(
  runtimes: RuntimeStatus[],
  override: AgentRuntimeOverride | null | undefined,
  options: {
    failedRuntime: RuntimeStatus;
    failure: Pick<RunnerFailure, "kind" | "providerCode"> & Partial<Pick<RunnerFailure, "source">>;
    unsettledNoEffectProven?: boolean;
  },
): RuntimeStatus[] {
  if (!override || override.scope !== "agent") return [];
  if (roleFallbackBlocked(options)) return [];
  const out: RuntimeStatus[] = [];
  for (const line of agentOwnOrderOverrides(override.targetId)) {
    const matched = runtimes.find((runtime) => runtimeMatchesOverride(runtime, line));
    if (!matched) continue;
    const candidate = applyRuntimeOverride(matched, line);
    if (isRuntimeCredentialUnavailable(candidate) || runtimeCooldown(candidate)) continue;
    if (line.selection.source && runtimeCooldownForSelection(line.selection)) continue;
    if (runtimeFailureSharesProviderDomain(candidate, options.failedRuntime, options.failure)) continue;
    if (runtimeSelectionUnavailableReason(matched, line.selection) || !pickRunner(candidate)) continue;
    if (!out.some((item) => sameRuntimeModel(item, candidate))) out.push(candidate);
  }
  return out;
}

export function selectRuntimeForTargets(
  runtimes: RuntimeStatus[],
  targets: RuntimeOverrideTarget[],
  role: RuntimeRole = "orchestrator",
  /** The role an agent with nothing stored follows in this turn (Worker in an ordinary agent's one-to-one chat); absent = `role`. */
  unsetRole?: RuntimeRole,
): RuntimeChoice | null {
  const found = findAgentRuntimeOverride(targets);
  // An agent the owner told to follow the Worker or the Orchestrator order reads that global order at this turn (nothing is copied);
  // an agent with nothing stored follows `unsetRole` when the turn names one, else the role its turn kind always used. A team pin (found)
  // and the owner's own pick are decided before this, so the default never beats them.
  const followed = found ? null : agentFollowedRole(targets.find((target) => target.scope === "agent" && target.targetId)?.targetId);
  if (followed) role = followed;
  else if (!found && unsetRole) role = unsetRole;
  // A Worker order nobody can run now (every line gone or out of quota) is the Orchestrator's, never a dead turn.
  if (!found && role === "worker" && (followed || unsetRole) && rolePriorityRuntimes(runtimes, "worker").length === 0) role = "orchestrator";
  const override = found && found.scope === "agent" ? (firstUsableOwnLine(runtimes, found) ?? found) : found;
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
    /** The role an agent with nothing stored follows (runtime/agent-default-role.ts); absent = the Orchestrator, as before. */
    unsetRole?: RuntimeRole;
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
    : selectRuntimeForTargets(runtimes, targets, "orchestrator", options.unsetRole);
  return { choice, pinHonored: false, pinYieldedToOverride: assigned };
}

function agentAppStatelessSafe(runtime: RuntimeStatus): boolean {
  return (
    runtime.kind === "claude-code" ||
    runtime.kind === "byok" ||
    runtime.kind === "lmstudio" ||
    runtime.kind === "mlx" ||
    runtime.kind === "agentlas-local"
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
