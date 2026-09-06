// 자동화 스케줄러 — 앱이 켜져 있는 동안 60초마다 due 자동화를 점검해 실행한다.
// 실행 = 타깃(firm/agent)의 백그라운드(division) chat을 만들어 runMcpInvocation로 promptTemplate을 돌린다.
// This is intentionally app-scoped: fully quitting Desktop stops local work.
import { app, Notification } from "electron";
import { randomUUID } from "node:crypto";
import type { Automation, AutomationRunRecord, RuntimeSelection } from "../shared/types";
import {
  dueAutomations,
  getAutomation,
  markAutomationRun,
  toggleAutomation,
  claimAutomationRun,
  renewAutomationRunLease,
  releaseAutomationRun,
  startGraphRun,
  touchGraphRun,
  updateGraphRunNode,
  finishGraphRun,
  countConsecutiveFailures,
  isAutomationRunParentMissingError,
  pinAutomationRuntimeIfUnset,
  getAutomationExecutionContractState,
  pinLegacyAutomationHubVersions,
  consumeRunInput,
  updateAutomation,
} from "./store/automations";
import { checkComputerUsePermissions } from "./mac-permissions";
import { appendChatMessage, clearChatGoalBindingByGoalId, listChatMessages } from "./store/chats";
import { completeChatGoalContract } from "./store/chat-goals";
import {
  closeOpenGoalLedgerTasks,
  completeGoalLedgerGoal,
  GOAL_HARD_STOP_REASONS,
  goalProgressKeyForText,
  goalLedgerShouldContinue,
  recordGoalLedgerCycle,
} from "./mcp/goal-ledger";
import { getOrCreateAutomationSession } from "./store/automation-sessions";
import { buildSystemOptimizerPrompt } from "./system-agents/system-optimizer";
import { runMcpInvocation } from "./mcp/client";
import { automationRuntimePermission } from "../shared/graph-node-protocol";
import { runGraph } from "./workflow/run-graph";
import { broadcastLiveRun } from "./workflow/live-run";
import {
  GOAL_COMPLETE_MARKER,
  goalCompletionProtocol,
  goalContinuationSchedule,
  isStormbreakerLongRunPrompt,
} from "./hephaestus/loop-engineering";
import { currentUiLocale } from "./ui-locale";
import { emitAutomationDone } from "./triggers/chain-bus";
import {
  classifyAutomationFailure,
  classifyAutomationOutcome,
  isJudgmentUnavailable,
  type AutomationResultStatus,
} from "./automation-result";
import { hasInvocationRunReceipt, observedToolActivity } from "./store/run-events";
import {
  recordMcpInvocationEvent,
  recordRunEvent,
  tryRecordFailureEvent,
  tryRecordRunEvent,
} from "./store/run-events";
import { notifyTelegramAutomationDone } from "./telegram/connect";
import {
  MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS,
  automationWatchdogError,
  awaitAutomationRunnerWithAbortGrace,
  createAutomationWatchdogState,
  evaluateAutomationWatchdog,
  noteAutomationWatchdogEvent,
  type AutomationWatchdogDecision,
} from "./automation-watchdog";
import { recoverStaleAutomationRuns } from "./store/db";
import { detectRuntimes } from "./runtime/detect";
import { rolePriorityRuntimes } from "./runtime/selection";
import { withRunPriority } from "./runtime/run-priority";
import { synthesizeLegacyGraph } from "./automation-emitter";
import { suspendAutomationForGraphReconciliation } from "./store/graph-reconciliation";
import { getSource as getMarketSource } from "./marketplace";
import {
  buildStrategyDirective,
  collectAutomationFailureContext,
  type AutomationFailureContext,
} from "./automation-strategy";
import { recordAutomationRecovery } from "./automation-recovery";
import { AUTOMATION_CONTINUITY_OPEN, AUTOMATION_CONTINUITY_CLOSE } from "./automation-continuity";
import type {
  TriggerDeliveryHooks,
  TriggerDispatchResult,
  TriggerEventPayload,
} from "./store/trigger-events";

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let installQuiescing = false;
const running = new Set<string>();

// 이 프로세스의 리스 소유자 식별자. 현재 제품 경로는 GUI만 실행하지만, 오래된
// headless 표식이 원장에 남아 있어도 소유자를 정확히 구분할 수 있게 형식은 유지한다.
const LEASE_OWNER = `${process.pid}:${process.argv.includes("--headless-automations") ? "headless" : "gui"}`;

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) return parsed;
  console.warn(
    `[automation] ignoring invalid ${name}=${JSON.stringify(raw.slice(0, 64))}; using ${fallback}`,
  );
  return fallback;
}

// 한 번의 점검에서 동시에 돌릴 자동화 수 상한. due가 한꺼번에 많이 쌓여도(앱이 오래 꺼져
// 있다 켜진 경우 등) 모든 에이전트 런을 동시에 띄우지 않게 막는다 — 저사양 기기에서
// CPU/RAM 폭주 방지. 각 런은 내부에서 다시 CLI/엔진 프로세스를 띄우므로 N을 작게 둔다.
const MAX_CONCURRENT_AUTOMATIONS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_CONCURRENCY",
  2,
  1,
  16,
);

/** 작업 배열을 최대 `limit`개씩만 동시 실행하는 경량 풀(외부 의존성 없음). */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  // 호출부가 나중에 늘어도 NaN/Infinity가 Array.from length=0으로 조용히 전량 스킵되지 않게
  // 풀 자체에서도 한 번 더 방어한다. 빈 queue만 lane 0이 정상이다.
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const size = Math.min(safeLimit, queue.length);
  const lanes = Array.from({ length: size }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      await worker(next);
    }
  });
  await Promise.all(lanes);
}

/** 완료 시 OS 알림(설계 §2.7 한계 #10 — 결과 미표출 해소). Notification 미지원이면 조용히 무시. */
function notifyDone(a: Automation, status: AutomationResultStatus, error?: string): void {
  try {
    if (!app.isReady()) return;
    if (!Notification.isSupported()) return;
    const ok = status === "ok";
    const skipped = status === "skipped";
    const partial = status === "partial";
    const waiting = status === "blocked" || status === "needs_input";
    new Notification({
      title: ok
        ? `Automation ran: ${a.name}`
        : skipped
          ? `Automation skipped: ${a.name}`
          : partial
            ? `Automation partially completed: ${a.name}`
            : waiting
              ? `Automation needs attention: ${a.name}`
              : `Automation failed: ${a.name}`,
      body: ok
        ? "Completed successfully."
        : error
          ? error.slice(0, 200)
          : skipped
            ? "Nothing was eligible to run."
            : waiting
              ? "It remains enabled and will retry on the next schedule."
              : "See run history.",
      silent: true,
    }).show();
  } catch (err) {
    console.error("[automation] notification failed:", err);
  }
}

/** Provider resume is an optimization, not the continuity authority. Every run receives a
 * bounded durable capsule so a backend switch or expired CLI session cannot erase the prior run. */
function buildAutomationContinuityPrompt(chatId: string, prompt: string, strategyDirective = ""): string {
  // 전략 진화 지시문(실패 스트릭이 있을 때만 비어 있지 않음)은 프롬프트 바로 앞에 붙는다 —
  // 재시도가 동일 방법을 그대로 반복하는 구조적 결함의 수리(run-graph 경로와 동일 계약).
  const effectivePrompt = strategyDirective ? `${strategyDirective}\n\n${prompt}` : prompt;
  const prior = listChatMessages(chatId, 12)
    .filter((message) => message.role === "assistant" || message.role === "system")
    .slice(-4)
    .map((message) => `[${message.role} ${message.createdAt}] ${message.text.replace(/\s+/g, " ").trim().slice(0, 1_200)}`);
  if (prior.length === 0) return effectivePrompt;
  return [
    AUTOMATION_CONTINUITY_OPEN,
    "This is the same durable automation session. Continue from these prior outcomes; do not restart setup or create a new CLI/session unless an explicit lifecycle error requires it.",
    ...prior,
    AUTOMATION_CONTINUITY_CLOSE,
    "",
    effectivePrompt,
  ].join("\n");
}

// ── 실패 처리 정책(2026-07-08) ─────────────────────────────────────────────
// 문제: 자동화가 실패해도 챗창에 아무 피드백이 없고(프롬프트만 복붙처럼 쌓임),
// 같은 시스템 원인이면 매 스케줄마다 실패 원인을 알 수 없었다.
// 정책: 실패 시 (1) Runtime Doctor가 아는 시스템 원인은 즉시 수리, (2) 실패 원인을
// 자동화 챗에 system 메시지로 표출, (3) 자동화 enabled 상태는 유지,
// (4) 수리 못 한 반복 실패는 System Optimizer(LLM) 원샷 진단 발사.
const OPTIMIZER_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 자동화당 최대 6시간에 1회
// 무활동 워치독 — 러너 이벤트가 이 시간 이상 끊기면 행(hang)으로 판정하고 자동 중단한다.
// 프로세스가 안 죽는 행은 실패 이벤트가 영영 안 와서 닥터/피드백 경로에 도달하지 못한다
// (실사고: Run now 후 중간 무반응 — 사용자는 30분 auto-abort까지 아무것도 못 봄).
// 긴 단일 툴 실행(빌드 등)도 있으므로 짧게 잡지 않는다. env로 조정 가능.
const STALL_INACTIVITY_MS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_STALL_MS",
  8 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000,
);
// Tool start/result events let us distinguish a dead idle runner from a healthy long-running
// single tool. Only the latter gets the wider silence budget; globally raising the idle timeout
// would merely hide real hangs for longer.
const ACTIVE_TOOL_STALL_MS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_ACTIVE_TOOL_STALL_MS",
  Math.max(STALL_INACTIVITY_MS, 20 * 60 * 1000),
  STALL_INACTIVITY_MS,
  MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS,
);
const OPTIMIZER_TIMEOUT_MS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_OPTIMIZER_TIMEOUT_MS",
  10 * 60 * 1000,
  1_000,
  30 * 60 * 1000,
);
const RUN_HEARTBEAT_INTERVAL_MS = 15_000;
const AUTOMATION_LEASE_HEARTBEAT_MS = boundedIntegerEnv(
  "AGENTLAS_AUTOMATION_LEASE_HEARTBEAT_MS",
  60_000,
  1_000,
  5 * 60_000,
);
const lastOptimizerRunAt = new Map<string, number>();
const optimizerControllers = new Map<string, AbortController>();

export class AutomationActiveRemovalError extends Error {
  readonly code = "automation_active_removal_blocked";

  constructor(readonly automationId: string, readonly phase: "run" | "optimizer") {
    super(
      phase === "optimizer"
        ? "Automation cleanup is still running. Wait for it to finish, then delete the automation."
        : "Automation is currently running. Wait for it to finish, then delete the automation.",
    );
    this.name = "AutomationActiveRemovalError";
  }
}

/**
 * Deletion is destructive while a write-capable runtime owns this automation.
 * Refuse instead of assuming AbortSignal compliance: a provider that ignores
 * cancellation could otherwise keep performing external actions after its DB,
 * chat, and user-visible parent were already deleted.
 */
export function assertAutomationRemovalSafe(automationId: string): void {
  if (running.has(automationId)) {
    throw new AutomationActiveRemovalError(automationId, "run");
  }
  if (optimizerControllers.has(automationId)) {
    throw new AutomationActiveRemovalError(automationId, "optimizer");
  }
}

/** 운영 진단/결정론 회귀용 — 실제로 적용된 유한 스케줄러 한계를 노출한다. */
export function automationSchedulerDiagnostics(): {
  maxConcurrentAutomations: number;
  stallInactivityMs: number;
  activeToolStallMs: number;
  optimizerTimeoutMs: number;
  leaseHeartbeatMs: number;
} {
  return {
    maxConcurrentAutomations: MAX_CONCURRENT_AUTOMATIONS,
    stallInactivityMs: STALL_INACTIVITY_MS,
    activeToolStallMs: ACTIVE_TOOL_STALL_MS,
    optimizerTimeoutMs: OPTIMIZER_TIMEOUT_MS,
    leaseHeartbeatMs: AUTOMATION_LEASE_HEARTBEAT_MS,
  };
}

function automationSessionInput(a: Automation): {
  automationId: string;
  agentId?: string;
  firmId?: string | null;
  projectId?: string | null;
  runtimeSelection?: RuntimeSelection | null;
} {
  return {
    automationId: a.id,
    projectId: a.projectId ?? null,
    runtimeSelection: a.runtimeSelection ?? null,
    ...(a.targetType === "firm" ? { firmId: a.targetId } : a.targetType === "agent" ? { agentId: a.targetId } : {}),
  };
}

/**
 * 스케줄러가 런타임에 넘기는 권한. 저장된 `executionPermission` 을 그대로 쓰지 않는다 —
 * 런타임에서 read 는 "쓰기 금지"가 아니라 **"도구 금지"** 이고, 도구 없는 자동화는
 * 자기 일을 못 한다(2026-08-13). 옛 청사진 경로가 read 로 못박아 만든 행이 그대로
 * 남아 있어서, 저장값을 믿으면 복구 실행조차 도구 없이 진단하게 된다.
 * 판정은 `automationRuntimePermission` 한 곳이 갖는다(그래프 경로와 같은 규칙).
 */
function schedulerExecutionPermission(_a: Automation): "read" | "write" {
  return automationRuntimePermission({ simulation: false });
}

/**
 * 실패 복구 진단은 저장된 자동화 계약보다 넓은 권한으로 올라가면 안 된다.
 * 본 실행은 구형 `read` 행도 조회 도구를 쓸 수 있도록 런타임 write를 받지만,
 * optimizer가 그 행을 write로 재해석하면 실패 원인과 복구 권한이 달라진다.
 */
function schedulerOptimizerPermission(a: Automation): "read" | "write" {
  return a.executionPermission === "read" ? "read" : automationRuntimePermission({ simulation: false });
}

function stripAutomationFailureCode(error: string): string {
  return error.replace(/^\s*\[[a-z0-9_.:-]+\]\s*/i, "").trim().slice(0, 1200);
}

function automationRuntimeLabel(selection: RuntimeSelection, ko: boolean): string {
  const labels: Record<string, string> = {
    "claude-code": ko ? "Claude Code" : "Claude Code",
    codex: "Codex",
    antigravity: "Antigravity",
    kimi: "Kimi",
    grok: "Grok",
    cursor: "Cursor",
    byok: ko ? "BYOK" : "BYOK",
    ollama: "Ollama",
    lmstudio: "LM Studio",
    mlx: "MLX",
    acp: "ACP",
    agentlas: "Agentlas",
  };
  const label = labels[selection.kind] ?? selection.kind;
  return selection.model ? `${label} · ${selection.model}` : label;
}

/** 실패 원인을 표출하고 아는 원인은 수리한다. 반복 실패도 자동화를 끄지는 않는다. */
function appendAutomationFailureNotice(
  chatId: string,
  error: string,
  runId?: string | null,
  currentRuntime?: RuntimeSelection | null,
): void {
  const ko = currentUiLocale() === "ko";
  const reason = stripAutomationFailureCode(error) || (ko ? "기록된 실패 사유가 없습니다." : "No failure reason was recorded.");
  const currentRuntimeLine = currentRuntime
    ? ko
      ? `현재 자동화 설정 실행 모델: ${automationRuntimeLabel(currentRuntime, true)}.`
      : `Current automation runtime setting: ${automationRuntimeLabel(currentRuntime, false)}.`
    : ko
      ? "현재 자동화 설정 실행 모델: 별도 고정 없음."
      : "Current automation runtime setting: no separate pin.";
  let toolEvidence = "";
  if (runId) {
    try {
      const activity = observedToolActivity(runId);
      toolEvidence = ko
        ? `호스트 실행 원장에 기록된 외부 도구 호출: ${activity.callCount}건.`
        : `External tool calls recorded by the host run ledger: ${activity.callCount}.`;
    } catch {
      /* A missing evidence row must not replace the authoritative failure reason. */
    }
  }
  const lines = ko
    ? [
      "자동화 최신 실행 상태: 완료되지 않았습니다.",
      currentRuntimeLine,
      `기록된 실행 사유: ${reason}`,
      toolEvidence,
      "이 안내가 이번 실행의 최신 사실입니다. 이전 대화의 브라우저·로그인 안내는 이번 실행 결과가 아닙니다.",
    ]
    : [
      "Latest automation run status: it did not complete.",
      currentRuntimeLine,
      `Recorded run reason: ${reason}`,
      toolEvidence,
      "This notice is the latest fact for this run. Earlier browser or login guidance in the conversation was not this run's result.",
    ];
  try {
    appendChatMessage(chatId, "system", lines.filter(Boolean).join("\n"));
  } catch (err) {
    console.error("[automation] deterministic failure notice could not be written:", err);
  }
}

/** 실패 원인을 표출하고 아는 원인은 수리한다. 반복 실패도 자동화를 끄지는 않는다. */
function handleAutomationFailure(a: Automation, error: string, failedRunId?: string | null): void {
  let streak = 1;
  try {
    streak = Math.max(1, countConsecutiveFailures(a.id));
  } catch {
    /* run_history 조회 실패는 스트릭 1로 취급 */
  }

  try {
    const chat = getOrCreateAutomationSession(automationSessionInput(a));
    let deterministicNoticeScheduled = false;
    // Operational evidence never becomes chat copy. The controller receives it
    // privately and authors the recovery action/result in the automation's own
    // session. No error dictionary or deterministic doctor chooses the route.
    const lastAt = lastOptimizerRunAt.get(a.id) ?? 0;
    if (
      !optimizerControllers.has(a.id) &&
      Date.now() - lastAt >= OPTIMIZER_MIN_INTERVAL_MS
    ) {
      lastOptimizerRunAt.set(a.id, Date.now());
      const optimizerController = new AbortController();
      optimizerControllers.set(a.id, optimizerController);
      const prompt = buildSystemOptimizerPrompt({
        automationName: a.name,
        errorMessage: error,
        doctorSummary: undefined,
        consecutiveFailures: streak,
      });
      const runId = `doctor-${a.id}-${Date.now()}`;
      const req = {
        runId,
        chatId: chat.chat.id,
        automationId: a.id,
        userPrompt: prompt,
        // 제품이 스스로 보내는 복구 지시다. 표시하면 "사용자가 이렇게 말했다"로 읽히고,
        // 세션 대화에 내부 프롬프트("Private evidence …")가 그대로 노출된다.
        promptOrigin: "system" as const,
        permissions: schedulerOptimizerPermission(a),
        toolMode: "auto" as const,
        hubMode: a.hubMode ?? "hub-allowed",
        // Recovery belongs to the failed automation. Without this pin the
        // optimizer silently used the global orchestrator (often Claude)
        // even when the automation itself was fixed to Antigravity.
        runtimeSelection: a.runtimeSelection,
      };
      tryRecordRunEvent({
        runId,
        kind: "system_optimizer_started",
        automationId: a.id,
        payload: { streak, paused: false },
      });
      let removeAbortListener = () => {};
      const abortGate = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          const reason = optimizerController.signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error(typeof reason === "string" ? reason : "System Optimizer cancelled"),
          );
        };
        optimizerController.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => optimizerController.signal.removeEventListener("abort", onAbort);
      });
      const optimizerTimer = setTimeout(() => {
        optimizerController.abort(
          new Error(
            `System Optimizer total timeout after ${Math.round(OPTIMIZER_TIMEOUT_MS / 1000)}s`,
          ),
        );
      }, OPTIMIZER_TIMEOUT_MS);
      if (optimizerTimer.unref) optimizerTimer.unref();
      // Promise.resolve().then은 동기 throw까지 같은 실패 경로로 수렴시킨다. abortGate를
      // race에 넣어 runner가 AbortSignal을 무시해도 cancel/timeout 시 lifecycle은 끝난다.
      // System Optimizer 복구 런도 무인 배경 작업이다 — 채팅 턴을 밀어내면 안 된다.
      const optimizerRun = Promise.resolve().then(() => withRunPriority("background", () =>
        runMcpInvocation(
          req,
          (ev) => recordMcpInvocationEvent(runId, req, ev),
          optimizerController.signal,
          undefined,
          { source: "automation" },
        ),
      ));
      void Promise.race([optimizerRun, abortGate])
        .catch((err) => {
          console.error("[automation] system optimizer run failed:", err);
          // 복구 시도가 죽은 사실은 콘솔에만 남으면 없는 것과 같다. 원래 자동화
          // 실패 고지와 분리된 호스트 행으로 남겨, 취소·타임아웃도 사용자가 확인하게 한다.
          const reason = err instanceof Error ? err.message : String(err);
          try {
            appendChatMessage(
              chat.chat.id,
              "system",
              `System Optimizer 진단 런 자체가 실패했습니다: ${reason.slice(0, 500)}`,
            );
          } catch (writeErr) {
            console.error("[automation] optimizer failure notice could not be written:", writeErr);
          }
        })
        .finally(() => {
          clearTimeout(optimizerTimer);
          removeAbortListener();
          if (optimizerControllers.get(a.id) === optimizerController) {
            optimizerControllers.delete(a.id);
          }
          appendAutomationFailureNotice(chat.chat.id, error, failedRunId, a.runtimeSelection);
        });
      deterministicNoticeScheduled = true;
    }
    if (!deterministicNoticeScheduled) appendAutomationFailureNotice(chat.chat.id, error, failedRunId, a.runtimeSelection);
  } catch (err) {
    console.error("[automation] failure feedback failed:", err);
  }

}

function requiresGraphReconciliation(detail: string | null | undefined): boolean {
  // A user-requested fresh occurrence can be rejected by the graph kernel
  // while the prior receipt is being reviewed. That rejection does not mean
  // the scheduler discovered a new unresolved side effect, so it must not
  // suspend the automation or manufacture another reconciliation card.
  return /(?:partial_reconciliation_required|ambiguous_side_effect|automation_partial_graph_changed)/i.test(detail ?? "");
}

/** 지금 도는 실행의 중단 손잡이 — 자동화 id 하나당 하나. */
const ABORT_BY_AUTOMATION = new Map<string, AbortController>();

/**
 * 도는 실행을 멈춘다. 멈출 것이 없으면 `false` — 멈춘 척하지 않는다.
 * 커널은 이미 중단을 다룰 줄 안다(runSignal + abortGraceMs): 진행 중 노드가 정리될
 * 시간을 준 뒤, 바깥에 반영됐는지 모르는 단계는 재조정 대기로 남는다.
 */
export function stopAutomationRun(automationId: string): boolean {
  const controller = ABORT_BY_AUTOMATION.get(automationId);
  if (!controller) return false;
  controller.abort(new Error("automation_stopped_by_user"));
  return true;
}

async function runOne(
  a: Automation,
  opts?: {
    claim?: boolean;
    advanceSchedule?: boolean;
    allowDisabledLease?: boolean;
    /** 시뮬레이션 실행 — 외부에 나가는 변경을 막고 무엇이 막혔는지 영수증으로 남긴다. */
    dryRun?: boolean;
    /** 실패한 occurrence를 재개하지 않고, 안전하게 허용될 때 새 occurrence로 시작한다. */
    fresh?: boolean;
    triggerDelivery?: TriggerDeliveryHooks;
    triggerContext?: TriggerEventPayload;
    /** The scheduled fire time. Recording the run and advancing the schedule
     *  must use the same clock, or a run fired for a past-due slot stamps
     *  last_run_at with wall-clock now while next_run_at advances from the slot,
     *  leaving next_run_at < last_run_at. Defaults to now for run-now/triggers. */
    fireTime?: Date;
    /** 완주 루프 ④의 1회 재시도 표식 — 재시도의 재시도를 막는다. */
    zeroToolRetried?: boolean;
    /** Preallocated by an immediate-ack caller and already durably requested. */
    runId?: string;
    preclaimed?: boolean;
  },
): Promise<TriggerDispatchResult> {
  if (installQuiescing) return { accepted: false };
  if (running.has(a.id)) return { accepted: false }; // 직전 실행이 아직 진행 중이면 건너뜀
  if (a.goalId) {
    const goalDecision = await goalLedgerShouldContinue(a.goalId);
    if (goalDecision && !goalDecision.continue) {
      // App-close/crash recovery is a durable pause. Merely starting the app,
      // catching up a schedule, or receiving a trigger cannot resume it.
      return { accepted: false };
    }
  }
  // 모든 실행 경로가 같은 크로스프로세스 리스를 사용한다. GUI의 Run now나 이벤트 트리거도
  // headless due 실행과 겹치면 외부 게시/결제 같은 부작용을 두 번 낼 수 있으므로 건너뛴다.
  if (
    opts?.claim && !opts.preclaimed &&
    !claimAutomationRun(a.id, LEASE_OWNER, new Date(), { allowDisabled: opts.allowDisabledLease === true })
  ) return { accepted: false };
  try {
    opts?.triggerDelivery?.onAccepted();
  } catch (error) {
    // The outbox receipt is the authority for an event-trigger occurrence. If
    // it cannot be advanced while we own the automation lease, do not execute.
    if (opts?.claim) {
      try {
        releaseAutomationRun(a.id, LEASE_OWNER);
      } catch {
        /* owner CAS protects a peer lease */
      }
    }
    console.error("[automation] trigger delivery acceptance failed:", error);
    return { accepted: false };
  }
  running.add(a.id);
  /**
   * 판정 어휘(ok/skipped/…)를 결과 어휘로 옮긴다. 두 어휘를 같은 것으로 쓰다가
   * 한 칸에 두 답이 섞였으므로, 옮기는 자리를 한 곳으로 못 박는다.
   */
  const outcomeOf = (verdict: AutomationResultStatus): AutomationRunRecord["outcome"] => {
    if (verdict === "ok" || verdict === "skipped") return "accepted";
    if (verdict === "needs_input") return "needs_input";
    if (verdict === "blocked") return "blocked";
    return "rejected";
  };
  let runStatus: AutomationResultStatus = "ok";
  /**
   * 판정의 답 — **나온 결과물이 쓸 만한가**. runStatus(끝까지 돌았는가)와 다른 질문이다.
   * null이면 판정을 부르지 않은 실행이다(예: 실행 자체를 못 한 preflight 스킵).
   */
  let runOutcome: AutomationRunRecord["outcome"] = null;
  let runOutcomeReason: string | null = null;
  /** 이번 실행이 "실패"가 아니라 "판정 불가"로 끝났는가 — 복구 워커·실패 표시의 억제 조건. */
  let judgmentUnavailableRun = false;
  let runError: string | null = null;
  /**
   * 커널이 남긴 원문 실패 문자열. runError는 사용자에게 보여줄 문장으로 교체되므로
   * 기계 판단(부수효과 모호 → 재실행 정지)은 반드시 이 값으로 한다.
   */
  let machineError: string | null = null;
  let output: string | undefined;
  let currentRunId: string | null = null;
  // 이번 실행 "이전"의 실패 스트릭 — 성공 시 복구 학습(recordAutomationRecovery) 판정에 쓴다.
  // markAutomationRun 이후에는 이번 결과가 이력에 섞여 사전 상태를 복원할 수 없다.
  let priorFailureContext: AutomationFailureContext = { streak: 0, recentErrors: [] };
  try {
    priorFailureContext = collectAutomationFailureContext(a.id);
  } catch {
    /* 이력 조회 실패는 복구 학습만 건너뛴다 */
  }
  let parentMissing = false;
  let leaseOwnershipLost = false;
  let leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let leaseRenewWarningEmitted = false;
  try {
    const controller = new AbortController();
    /*
     * ★사람이 멈출 수 있게 이 실행의 중단 손잡이를 등록한다.
     *
     * 컨트롤러는 원래 있었지만 **밖에서 부를 통로가 없어**, 잘못 도는 실행을 눈으로
     * 보면서도 끝날 때까지 기다려야 했다(다른 기능은 전부 취소가 있다:
     * invoke:cancel · hephaestus:cancelBuild · oberon:cancelRender).
     * 자동화는 사람이 안 볼 때 도는 것이라, 봤을 때 세울 수 있어야 한다.
     */
    ABORT_BY_AUTOMATION.set(a.id, controller);
    if (opts?.claim) {
      leaseHeartbeatTimer = setInterval(() => {
        try {
          const renewed = renewAutomationRunLease(
            a.id,
            LEASE_OWNER,
            new Date(),
            { allowDisabled: opts.allowDisabledLease === true },
          );
          if (!renewed) {
            leaseOwnershipLost = true;
            controller.abort(new Error("Automation execution lease ownership lost"));
          } else {
            leaseRenewWarningEmitted = false;
          }
        } catch (error) {
          // A single SQLITE_BUSY/I/O renewal miss is not proof that another
          // process owns the lease. Keep the run alive and retry next tick.
          if (!leaseRenewWarningEmitted) {
            leaseRenewWarningEmitted = true;
            const code = error && typeof error === "object" && "code" in error
              ? String((error as { code?: unknown }).code ?? "transient")
              : "transient";
            console.warn(`[automation] lease heartbeat deferred (${code.slice(0, 80)})`);
          }
        }
      }, AUTOMATION_LEASE_HEARTBEAT_MS);
      leaseHeartbeatTimer.unref?.();
    }
    const storedContract = getAutomationExecutionContractState(a.id);
    if (!storedContract) throw new Error(`Automation not found: ${a.id}`);
    if (storedContract.runtimeSelection === "invalid") {
      throw new Error(
        "pinned_runtime_contract_invalid: the saved runtime pin is malformed and requires an explicit runtime selection.",
      );
    }
    if (storedContract.hubMode === "invalid") {
      throw new Error(
        "automation_hub_mode_contract_invalid: the saved Hub routing policy is unknown and requires an explicit selection.",
      );
    }
    if (storedContract.runtimeSelection === "missing") {
      // Automations execute as workers. Resolve an unpinned automation from the
      // stored Worker role order; detection order must never choose its model.
      const activeRuntime = rolePriorityRuntimes(await detectRuntimes(), "worker")[0] ?? null;
      if (!activeRuntime) throw new Error("No runtime is available to pin for this automation.");
      a = pinAutomationRuntimeIfUnset(a.id, {
          kind: activeRuntime.kind,
          backend: activeRuntime.backend,
          source: activeRuntime.source,
          model: activeRuntime.model ?? undefined,
          longContext: activeRuntime.longContextEnabled,
          effort: activeRuntime.effort ?? undefined,
      });
      tryRecordRunEvent({
        runId: currentRunId ?? `automation-pin-${a.id}-${Date.now()}`,
        kind: "automation_runtime_pinned",
        automationId: a.id,
        payload: { kind: a.runtimeSelection?.kind, model: a.runtimeSelection?.model ?? null },
      });
      if (!a.runtimeSelection) {
        throw new Error(
          "pinned_runtime_contract_invalid: the runtime pin compare-and-set did not produce a valid exact selection.",
        );
      }
    }
    const missingHubSlugs = new Set<string>();
    if (a.targetType === "hub" && !a.targetVersion) missingHubSlugs.add(a.targetId);
    for (const node of a.graph?.nodes ?? []) {
      if (
        node.type === "agent" && node.config?.targetType === "hub" &&
        typeof node.config.ref === "string" && node.config.ref.trim() &&
        typeof node.config.targetVersion !== "string"
      ) {
        missingHubSlugs.add(node.config.ref.trim());
      }
    }
    if (missingHubSlugs.size > 0) {
      const exactHashes: Record<string, string> = {};
      for (const slug of [...missingHubSlugs].sort()) {
        const listing = await getMarketSource().getListingBySlug(slug);
        const packageHash = listing?.packageHash ?? listing?.cloudPackage?.packageHash;
        if (
          !listing || listing.slug !== slug || listing.callable !== true ||
          typeof packageHash !== "string" || !/^[0-9a-f]{64}$/.test(packageHash)
        ) {
          throw new Error(`automation_hub_version_pin_unavailable: exact callable release unavailable for ${slug}`);
        }
        exactHashes[slug] = packageHash;
      }
      const migrated = pinLegacyAutomationHubVersions(a.id, exactHashes);
      a = migrated.automation;
      if (migrated.pinned.length > 0) {
        tryRecordRunEvent({
          runId: currentRunId ?? `automation-hub-pin-${a.id}-${Date.now()}`,
          kind: "automation_hub_version_pinned",
          automationId: a.id,
          payload: { pins: migrated.pinned },
        });
      }
    }

    // Legacy rows must cross the same durable occurrence/checkpoint boundary as
    // visual graphs. A one-node prompt can still post externally and then fail;
    // running it through the old direct path would replay the whole prompt on
    // the next schedule with no ambiguity guard.
    if (!a.graph || a.graph.nodes.length === 0) {
      a = { ...a, graph: synthesizeLegacyGraph(a) };
    }
    // 컴퓨터유즈 자동화 preflight — macOS 접근성 권한이 없으면 실행하지 않고 '대기'로 스킵한다.
    // (예전엔 권한 없이 실행돼 브라우저 자동화가 부분 실행 후 먹통/혼란. 이제 빠르게 감지 →
    //  다음 예약에 자동 재시도, false-fail도 false-success도 아님.)
    const cuaPerm = a.toolMode === "computer-use" ? checkComputerUsePermissions() : null;
    if (cuaPerm && !cuaPerm.ok) {
      runStatus = "needs_input";
      runError =
        `macOS가 이 앱 실행본에 ${cuaPerm.missing.join(" · ")} 권한을 주지 않아 컴퓨터유즈 자동화를 건너뜁니다(먹통 방지). ` +
        // ★"켜세요"라는 경로 문장만으로는 부족하다 — 캔버스의 권한 카드가 설정 화면을
        //   바로 여는 버튼을 제공한다. 이미 켰다면 다른 실행본(설치본↔개발 실행)에 켰을 수 있다.
        `자동화 화면의 [설정 화면 바로 열기] 버튼으로 켜 주세요. 켜면 다음 예약에 자동 재시도합니다.`;
      console.warn(`[automation] CUA preflight skip (${a.name}): missing ${cuaPerm.missing.join(", ")}`);
    } else if (a.targetType === "hub" && !a.targetVersion) {
      runStatus = "needs_input";
      runError =
        "[hub_version_pin_required] automation_hub_version_pin_required: " +
        "정확한 Hub 패키지 버전을 선택해야 자동화를 실행할 수 있습니다. 자동화 편집 화면에서 Hub 대상을 다시 선택하세요.";
    } else if (a.graph && a.graph.nodes.length > 0) {
      // 그래프 경로 — 위상 러너로 실행. per-node 상태를 라이브 채널로 방송해 캔버스가 애니메이션.
      const runId = opts?.runId ?? `run-${a.id}-${Date.now()}`;
      currentRunId = runId;
      opts?.triggerDelivery?.onRunBound(runId);
      // 사람이 대기시켜 둔 입력을 이 실행에 묶는다. 소비는 한 번만 성공하므로
      // 같은 값으로 두 번 실행되지 않는다. 이벤트 트리거가 준 값이 있으면 그 위에 얹는다
      // — 사람이 방금 준 값이 자동 수집된 값보다 뒤에 오는 것이 사용자의 기대다.
      let graphInitialVars = opts?.triggerContext;
      if (!opts?.dryRun) {
        try {
          const pending = consumeRunInput(a.id, runId);
          if (pending) graphInitialVars = { ...(graphInitialVars ?? {}), ...pending.payload };
        } catch (error) {
          console.error("[automation] pending run input could not be bound:", error);
        }
      }
      // 무활동 워치독 — 그래프 경로도 이벤트가 끊기면 행으로 판정한다(노드 자체 타임아웃
      // 1800s보다 훨씬 먼저 사용자에게 실패 피드백이 가도록).
      const graphWatchdog = createAutomationWatchdogState();
      let lastDurableHeartbeatAt = 0;
      const persistGraphHeartbeat = (at = Date.now()): void => {
        if (at - lastDurableHeartbeatAt < RUN_HEARTBEAT_INTERVAL_MS) return;
        lastDurableHeartbeatAt = at;
        try {
          touchGraphRun(runId, new Date(at));
        } catch {
          // The live watchdog remains authoritative for this process. A later
          // event/tick can retry the durable cross-process heartbeat.
        }
      };
      let graphStall: AutomationWatchdogDecision | null = null;
      const graphStallTimer = setInterval(() => {
        const decision = evaluateAutomationWatchdog(
          graphWatchdog,
          STALL_INACTIVITY_MS,
          ACTIVE_TOOL_STALL_MS,
        );
        if (decision.stalled) {
          graphStall = decision;
          controller.abort(new Error(automationWatchdogError(decision)));
        }
      }, 30_000);
      let result;
      let acceptGraphEvents = true;
      try {
        // ★background 우선순위 — 이 실행에서 스폰되는 모든 러너/자식(run-graph 내부 포함)이
        //   실행 슬롯 2단 큐에서 사람이 기다리는 채팅 턴 뒤로 서고, nice 10 을 받는다.
        //   run-graph.ts 를 고치지 않고도 문맥(AsyncLocalStorage)으로 전파된다.
        const graphRun = Promise.resolve().then(() => withRunPriority("background", () =>
          runGraph(a, a.graph!, {
            signal: controller.signal,
            ...(opts?.dryRun ? { dryRun: true } : {}),
            ...(opts?.fresh ? { fresh: true } : {}),
          runId,
          occurrenceId: opts?.triggerDelivery?.occurrenceId,
          initialVars: graphInitialVars,
          sink: (ev) => {
              // A cancellation-ignoring runtime may emit after the scheduler's finite abort
              // boundary. Do not revive watchdog/live state after this run has been finalized.
              if (!acceptGraphEvents) return;
              noteAutomationWatchdogEvent(graphWatchdog, ev);
              persistGraphHeartbeat();
              // ★실패가 아닌 **상태 변화**도 화면에 보낸다 (커넥터 C44).
              //
              // 예전에는 `nodeState`가 붙은 이벤트만 건너갔다. 그래서 긴 노드가 도는 동안
              // 화면은 "실행 중"에서 멈춰 있고, 무엇을 하는 중인지·어디까지 왔는지가
              // 아무 데도 안 보였다. 사람은 그걸 "멈췄다"로 읽는다.
              //
              // Node-RED가 Status 노드를 따로 둔 이유가 정확히 이것이다 — 문서 원문:
              // *"MQTT 노드가 연결을 잃어도 에러 이벤트가 아니라 상태 변화만 일으킨다."*
              // 이 저장소의 stale-online 사고(요청 타임아웃이 연결을 안 죽여 영원히 온라인)도
              // 같은 모양이다: 실패는 아닌데 상태가 변했고, 그걸 받을 채널이 없었다.
              if (ev.nodeState || ev.kind === "tool-use" || ev.kind === "thinking" || ev.kind === "reasoning") {
                broadcastLiveRun(a.id, ev);
              }
            },
          }),
        ));
        result = await awaitAutomationRunnerWithAbortGrace(graphRun, controller.signal);
      } catch (err) {
        // abort로 runGraph가 던지면 스톨 메시지로 바꿔 닥터 timeout 분류에 태운다.
        if (graphStall) {
          throw new Error(automationWatchdogError(graphStall));
        }
        throw err;
      } finally {
    if (ABORT_BY_AUTOMATION.get(a.id) === controller) ABORT_BY_AUTOMATION.delete(a.id);
        acceptGraphEvents = false;
        clearInterval(graphStallTimer);
      }
      const graphError = graphStall
        ? automationWatchdogError(graphStall)
        : result.error ?? null;
      runStatus = result.ok && !graphStall ? "ok" : "error";
      runError = graphError;
      // 판정이 이 문장을 사용자용으로 갈아끼우기 전에 원문을 붙들어 둔다(안전 판단용).
      machineError = graphError;
      // 그래프 outputs 중 마지막 노드 출력을 체인 페이로드로 노출.
      const outVals = Object.values(result.outputs ?? {});
      output = outVals.length ? outVals[outVals.length - 1] : undefined;
      /*
       * ★판정에게 **마지막 글 한 줄**이 아니라 실행 기록을 준다.
       *   실측 2026-08-20 (캠페인 E3): 검증으로 끝나는 그래프의 마지막 출력은 `"pass"` 라,
       *   첨부 3건을 정확히 정리한 실행과 이미 다 처리돼 할 일이 없던 실행이 판정 눈에
       *   똑같았다. 후자가 "pass 라고만 하고 한 일이 없다"로 거절됐다 — "이미 한 건 다시
       *   하지 마"로 만든 자동화는 조용한 날마다 실패로 찍힌다.
       *   기록은 호스트가 적는다. 요약도 해석도 하지 않고, 노드 이름과 그 노드가 낸 값을
       *   선언 순서대로 옮긴다.
       */
      const runRecord = {
        steps: (a.graph?.nodes ?? [])
          .map((node) => ({
            label: String(node.label || node.id),
            output: String(result.outputs?.[node.id] ?? ""),
          }))
          .filter((step) => step.output.trim().length > 0),
      };
      if (runStatus === "ok") {
        // ★두 답을 두 칸에 남긴다.
        //
        // 예전에는 여기서 `runStatus = classified.outcome` 으로 **커널의 답을 지웠다**.
        // 커널은 "그래프가 끝까지 돌았다(ok)"고 했는데 화면에는 판정의 답만 남아
        // "내 확인 필요"로 보였고, 사용자는 성공인지 실패인지 알 수 없었다.
        // 두 값은 서로 다른 질문의 답이라 한 칸에 겹쳐 담을 수 없다:
        //   status  = 끝까지 돌았는가 (커널이 안다)
        //   outcome = 나온 결과물이 쓸 만한가 (판정이 본다)
        // ★판정에 **호스트가 센 도구 호출**을 함께 준다. 모델이 "게시했다"고 써도
        //   도구 호출이 0건이면 바깥은 그대로다 — 그 사실은 지어낼 수 없다.
        const classified = await classifyAutomationOutcome(output, {
          runtimeSelection: a.runtimeSelection,
          ...(currentRunId ? { toolActivity: observedToolActivity(currentRunId) } : {}),
          ...(runRecord.steps.length > 0 ? { runRecord } : {}),
          // 사람이 승인한 목표 — 이것 없이는 "시킨 대로 한 것"과 "다 못 한 것"을 못 가른다.
          declaredGoal: { name: a.name ?? null, goal: a.goal ?? null },
        });
        judgmentUnavailableRun = isJudgmentUnavailable(classified);
        runOutcome = judgmentUnavailableRun ? "unjudged" : outcomeOf(classified.outcome);
        runOutcomeReason = classified.reason ?? null;
        runError = classified.reasonCode && classified.reason
          ? `[${classified.reasonCode}] ${classified.reason}`
          : classified.reason;
        // runStatus는 건드리지 않는다. 후속 정책은 아래에서 두 값을 함께 보고 정한다.
      } else {
        const classified = await classifyAutomationFailure(graphError, {
          runtimeSelection: a.runtimeSelection,
        });
        runStatus = outVals.length > 0 ? "partial" : classified.status;
        runError = classified.reasonCode
          ? `[${classified.reasonCode}] ${classified.reason ?? graphError ?? "automation failed"}`
          : classified.reason ?? graphError;
      }
    } else {
      // 레거시 단일 프롬프트 경로(완전 backward-compat).
      const runId = opts?.runId ?? `run-${a.id}-${Date.now()}`;
      currentRunId = runId;
      let lastDurableHeartbeatAt = 0;
      const persistLegacyHeartbeat = (at = Date.now()): void => {
        if (at - lastDurableHeartbeatAt < RUN_HEARTBEAT_INTERVAL_MS) return;
        lastDurableHeartbeatAt = at;
        try {
          touchGraphRun(runId, new Date(at));
        } catch {
          /* best-effort; the in-process watchdog still receives the event */
        }
      };
      tryRecordRunEvent({
        runId,
        kind: "automation_legacy_started",
        automationId: a.id,
        payload: { targetType: a.targetType, toolMode: a.toolMode, hubMode: a.hubMode },
      });
      const emitLegacyState = (nodeId: string, nodeState: "pending" | "running" | "done" | "failed" | "skipped"): void => {
        try {
          updateGraphRunNode(runId, nodeId, nodeState);
        } catch {
          /* 스냅샷 실패는 실행을 막지 않는다 */
        }
        tryRecordRunEvent({
          runId,
          kind: "automation_legacy_node_state",
          automationId: a.id,
          nodeId,
          payload: { state: nodeState },
        });
        broadcastLiveRun(a.id, { kind: "partial", nodeId, nodeState, agentId: nodeId });
      };
      try {
        // flow/page.tsx의 synthesizeLegacyGraph 노드 id와 맞춰 단일 프롬프트 자동화도
        // 캔버스/상태 패널에서 즉시 보이게 한다.
        startGraphRun({
          runId,
          automationId: a.id,
          nodeIds: ["n0", "n1"],
          dryRun: opts?.dryRun === true,
        });
        emitLegacyState("n0", "done");
        emitLegacyState("n1", "running");
      } catch (snapshotError) {
        if (isAutomationRunParentMissingError(snapshotError)) throw snapshotError;
        /* 스냅샷 시작 실패는 무시 */
      }
      /*
       * goal 연속실행에만 종료 규약을 덧붙인다.
       *
       * promptTemplate은 자동화가 만들어질 때 DB에 굳는다. 규약을 프롬프트 빌더에만
       * 넣으면 **이미 존재하는 캠페인은 영원히 마커를 배우지 못해** 여전히 못 끝난다.
       * 실행 시점에 붙여야 옛 행도 같이 고쳐진다. 이미 들어 있으면 건드리지 않는다.
       */
      const withGoalCompletionProtocol = (prompt: string, goalId: string | null | undefined): string => {
        if (!goalId || prompt.includes(GOAL_COMPLETE_MARKER)) return prompt;
        return `${prompt}\n\n${goalCompletionProtocol(currentUiLocale())}`;
      };
      const chat = getOrCreateAutomationSession({
        automationId: a.id,
        projectId: a.projectId ?? null,
        runtimeSelection: a.runtimeSelection ?? null,
        ...(a.targetType === "firm" ? { firmId: a.targetId } : a.targetType === "agent" ? { agentId: a.targetId } : {}),
      });
      if (!hasInvocationRunReceipt(runId)) {
        recordRunEvent({
          runId,
          kind: "invoke_started",
          chatId: chat.chat.id,
          automationId: a.id,
          payload: {
            invocationSource: "automation",
            permissions: schedulerExecutionPermission(a),
            toolMode: a.toolMode ?? "auto",
            hubMode: a.targetType === "hub" ? "hub-first" : (a.hubMode ?? "hub-allowed"),
          },
        });
      }
      try {
        let runnerError: string | null = null;
        const req = {
          runId,
          chatId: chat.chat.id,
          automationId: a.id,
          userPrompt: withGoalCompletionProtocol(
            buildAutomationContinuityPrompt(
              chat.chat.id,
              a.promptTemplate,
              buildStrategyDirective(priorFailureContext),
            ),
            a.goalId,
          ),
          permissions: schedulerExecutionPermission(a),
          borrowAgents: a.targetType === "hub" ? [a.targetId] : undefined,
          // Hub 자동화는 위 preflight에서 exact package pin을 강제한다.
          borrowVersions:
            a.targetType === "hub" && a.targetVersion ? { [a.targetId]: a.targetVersion } : undefined,
          runtimeSelection: a.runtimeSelection,
          mcpBrowserProfileKey: `automation-${a.id}`,
          toolMode: a.toolMode ?? "auto",
          hubMode: a.targetType === "hub" ? "hub-first" as const : (a.hubMode ?? "hub-allowed"),
        };
        // 무활동 워치독 — 이벤트가 STALL_INACTIVITY_MS 동안 없으면 행으로 판정, abort.
        const invocationWatchdog = createAutomationWatchdogState();
        let stallDecision: AutomationWatchdogDecision | null = null;
        const stallTimer = setInterval(() => {
          const decision = evaluateAutomationWatchdog(
            invocationWatchdog,
            STALL_INACTIVITY_MS,
            ACTIVE_TOOL_STALL_MS,
          );
          if (decision.stalled) {
            stallDecision = decision;
            controller.abort(new Error(automationWatchdogError(decision)));
          }
        }, 30_000);
        let result;
        let acceptInvocationEvents = true;
        try {
          // background 우선순위 — 그래프 경로와 같은 규율(사람이 기다리는 턴이 앞선다).
          const invocationRun = Promise.resolve().then(() => withRunPriority("background", () =>
            runMcpInvocation(
              req,
              (ev) => {
                // Once the scheduler has crossed its abort boundary, ignore late callbacks from
                // a broken cancellation-ignoring runtime (including writes after DB shutdown).
                if (!acceptInvocationEvents) return;
                noteAutomationWatchdogEvent(invocationWatchdog, ev);
                persistLegacyHeartbeat();
                if (ev.kind === "error") {
                  runnerError = ev.error?.message || "runner failed";
                }
                if (ev.kind === "tool-use" && ev.tool?.isError) {
                  runnerError = ev.tool.result?.trim() || `${ev.tool.name} failed`;
                }
                recordMcpInvocationEvent(runId, req, ev);
              },
              controller.signal,
              undefined,
              { source: "automation" },
            ),
          ));
          result = await awaitAutomationRunnerWithAbortGrace(invocationRun, controller.signal);
        } catch (err) {
          if (stallDecision) {
            throw new Error(automationWatchdogError(stallDecision));
          }
          throw err;
        } finally {
          acceptInvocationEvents = false;
          clearInterval(stallTimer);
        }
        if (stallDecision) {
          throw new Error(automationWatchdogError(stallDecision));
        }
        output = result.finalText;
        if (runnerError) throw new Error(runnerError);
        if (!output?.trim()) throw new Error("Automation finished without an assistant result");
        // ★판정에 **호스트가 센 도구 호출**을 함께 준다. 모델이 "게시했다"고 써도
        //   도구 호출이 0건이면 바깥은 그대로다 — 그 사실은 지어낼 수 없다.
        const classified = await classifyAutomationOutcome(output, {
          runtimeSelection: a.runtimeSelection,
          ...(currentRunId ? { toolActivity: observedToolActivity(currentRunId) } : {}),
          declaredGoal: { name: a.name ?? null, goal: a.goal ?? null },
        });
        judgmentUnavailableRun = isJudgmentUnavailable(classified);
        // 그래프 경로와 같은 규율 — 판정의 답은 자기 칸으로 간다.
        // 여기서 runStatus를 덮으면 "끝까지 돌았다"는 사실이 다시 지워진다.
        runOutcome = judgmentUnavailableRun ? "unjudged" : outcomeOf(classified.outcome);
        runOutcomeReason = classified.reason ?? null;
        // 다만 판정이 명시적으로 "실패"·"건너뜀"이라고 본 것은 실행 결과 자체의 성질이라
        // (레거시 경로엔 커널이 없어 이 판정이 유일한 종료 신호다) runStatus에 반영한다.
        if (classified.outcome === "error" || classified.outcome === "partial"
          || classified.outcome === "skipped") {
          runStatus = classified.outcome;
        }
        runError = classified.reasonCode && classified.reason
          ? `[${classified.reasonCode}] ${classified.reason}`
          : classified.reason;
        // 판정 불가는 노드를 실패로 칠하지 않는다 — 노드는 끝까지 실행됐다.
        const legacyNodeFailed = !judgmentUnavailableRun &&
          (runStatus === "error" || runOutcome === "blocked" || runOutcome === "needs_input");
        emitLegacyState("n1", legacyNodeFailed ? "failed" : runStatus === "skipped" ? "skipped" : "done");
        try {
          finishGraphRun(runId, legacyNodeFailed ? "error" : "ok");
        } catch {
          /* ignore */
        }
        if (runStatus === "error") throw new Error(runError ?? "Automation result was classified as failed");
        if (isStormbreakerLongRunPrompt(a.promptTemplate)) {
          /*
           * persistent goal 연속실행의 종료/지속 판단.
           *
           * 예전 규칙(마커가 없으면 즉시 자기 종료)은 지속을 "모델이 마커를
           * 붙였는가"에 종속시켰다 — Codex와의 결정적 차이가 정확히 여기였다.
           * goal_id가 있는 행은 goal 원장이 판단한다:
           *   완료  = 판정기 ok + 모델도 계속 요청 없음 + 원장에도 미완 task 없음
           *           (세 신호 일치 시에만 goal을 닫고 정확히 이 행만 끈다)
           *   정지  = 예산 소진·무진전 정지·명시 종료 — 마커가 있어도 멈춘다
           *   지속  = 그 외 전부. goal 상태에 따라 케이던스만 조정한다
           *           (진행 중이면 짧게, 아니면 백오프).
           * goal_id가 없거나 원장에 닿지 못하면 기존 마커-단독 규칙 그대로다.
           */
          /*
           * ★모델의 완료 선언을 원장에 먼저 반영한다.
           *
           * 이 경로의 채팅은 division이라 client.ts의 goal 계약 블록에서 제외된다
           * (`chat.kind !== "division"`). 그래서 선언을 원장에 옮기는 일이 저기서
           * 일어나지 않고 여기서만 일어난다 — 이 몇 줄이 빠져 있으면 백그라운드
           * 연속실행은 `no_open_tasks`에 영원히 도달하지 못하고, 아래
           * verifiedComplete는 죽은 분기로 남는다(그게 정확히 수리 전 상태였다).
           */
          if (a.goalId && result.goalCompletionClaim?.claimed) {
            await closeOpenGoalLedgerTasks({
              goalId: a.goalId,
              evidence: result.goalCompletionClaim.evidence
                ?? `automation:${a.id} ${goalProgressKeyForText(output ?? "")}`,
              outcomeText: output ?? "",
              invocationRunId: runId,
            });
          }
          const goalDecision = a.goalId
            ? await recordGoalLedgerCycle({
                goalId: a.goalId,
                progressKey: goalProgressKeyForText(output ?? ""),
                outcome: `run-${runOutcome}`,
              })
            : null;
          if (a.goalId && goalDecision) {
            const hardStop = !goalDecision.continue && GOAL_HARD_STOP_REASONS.has(goalDecision.reason);
            // 판정기가 정확히 ok(수용)로 본 실행만 — skipped는 runStatus가 갈라내므로
            // runStatus==="ok" && runOutcome==="accepted" 조합이 "verdict ok"와 동치다.
            const verifiedComplete = !result.stormbreakerContinueRequested
              && runStatus === "ok" && runOutcome === "accepted"
              && goalDecision.reason === "no_open_tasks";
            if (verifiedComplete) {
              await completeGoalLedgerGoal({
                goalId: a.goalId,
                status: "completed",
                reason: "judged-ok-no-open-tasks-no-marker",
              });
              completeChatGoalContract(a.goalId, "completed");
              clearChatGoalBindingByGoalId(a.goalId);
              toggleAutomation(a.id, false);
            } else if (hardStop) {
              // goal은 blocked/예산소진으로 원장에 남는다(사람 호출). 재실행만 멈춘다.
              completeChatGoalContract(a.goalId, "blocked");
              clearChatGoalBindingByGoalId(a.goalId);
              toggleAutomation(a.id, false);
            } else if (goalDecision.continue || result.stormbreakerContinueRequested) {
              const cadence = goalContinuationSchedule(goalDecision);
              if (a.scheduleHuman !== cadence) {
                updateAutomation(a.id, { scheduleHuman: cadence });
              }
            } else {
              // 미완인데 계속할 근거도 없음(예: task 0건인데 판정은 ok가 아님) —
              // 완료를 주장하지 않고 재실행만 멈춘다. goal은 active로 남아
              // 사용자가 채팅에서 다시 밀 수 있다.
              toggleAutomation(a.id, false);
            }
          } else if (!result.stormbreakerContinueRequested) {
            toggleAutomation(a.id, false);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitLegacyState("n1", "failed");
        tryRecordFailureEvent({
          runId,
          source: "automation_legacy",
          automationId: a.id,
          nodeId: "n1",
          errorCode: "automation_failed",
          errorMessage: message,
        });
        try {
          finishGraphRun(runId, "error");
        } catch {
          /* ignore */
        }
        throw err;
      }
    }
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    // 사용자에게 보여줄 문장과, 제품이 안전 판단에 쓰는 기계 표식은 같은 문자열일 수 없다.
    // 판정은 원문을 읽기 좋은 한 문장으로 **교체**하므로, 교체된 문장에서 다시 표식을 찾으면
    // 없다. 원문을 따로 붙들어 둔다.
    machineError = rawError;
    const classified = await classifyAutomationFailure(rawError, {
      runtimeSelection: a.runtimeSelection,
    });
    runStatus = classified.status;
    // Keep the graph kernel's machine gate alongside the human explanation.
    // The fresh-run UI must be able to distinguish an intentional replay
    // refusal from an unrelated failed preflight; the judgment service is
    // allowed to rewrite prose, but it must not erase this typed boundary.
    const durableGateCode = rawError.match(
      /^(automation_(?:fresh_run_blocked|ambiguous_side_effect|partial_reconciliation_required|partial_graph_changed))(?::|$)/i,
    )?.[1] ?? null;
    const classifiedReason = classified.reasonCode
      ? `[${classified.reasonCode}] ${classified.reason ?? rawError}`
      : classified.reason ?? rawError;
    runError = durableGateCode
      ? `[${durableGateCode}] ${classifiedReason}`
      : classifiedReason;
    parentMissing = isAutomationRunParentMissingError(err);
    if (!parentMissing) {
      tryRecordFailureEvent({
        runId: currentRunId,
        source: "automation",
        automationId: a.id,
        errorCode: `automation_${runStatus}`,
        errorMessage: runError,
      });
      console.error(`[automation] run failed (${a.name}):`, err);
    }
  } finally {
    if (leaseHeartbeatTimer) {
      clearInterval(leaseHeartbeatTimer);
      leaseHeartbeatTimer = null;
    }
    // 스케줄 전진은 (1) trigger_type==="schedule"이고 (2) 이번 실행이 실제 예약 발사일 때만.
    // run-now·이벤트 트리거는 advanceSchedule=false로 전달돼 next_run_at을 건드리지 않는다
    // (예약 슬롯을 잡아먹거나 이벤트 자동화를 시계 스케줄로 승격하는 버그 방지).
    // run_history 기록·run_count·종료 정책은 어느 경우든 동일하게 적용한다.
    if (!leaseOwnershipLost) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          markAutomationRun(a.id, opts?.fireTime ?? new Date(), {
            status: runStatus,
            error: runError,
            advanceSchedule: opts?.advanceSchedule ?? true,
            // 판정이 "사람 손이 필요하다"고 본 실행은 지금까지처럼 발생을 소진하지 않는다
            // (max_runs 보존). status가 ok로 남아도 이 정책은 그대로다 — 정책은 판정을 본다.
            executionConsumed: (runStatus === "ok" || runStatus === "skipped")
              && runOutcome !== "needs_input" && runOutcome !== "blocked",
            outcome: runOutcome,
            outcomeReason: runOutcomeReason,
            suspendForReconciliation: requiresGraphReconciliation(machineError ?? runError),
            sourceRunId: currentRunId,
            output,
          });
          break;
        } catch (err) {
          const busy = err && typeof err === "object" && "code" in err &&
            (err.code === "SQLITE_BUSY" || err.code === "SQLITE_LOCKED");
          if (busy && attempt < 2) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
            continue;
          }
          console.error("[automation] markAutomationRun failed:", err);
          break;
        }
      }
    }
    // 재실행 정지는 커널이 남긴 결정론적 신호(부수효과가 반영됐는지 알 수 없음)만 보고 정한다.
    // 예전에는 여기에 runStatus(=LLM 판정 결과)까지 걸려 있었다. 판정 모델에 닿지 못하면
    // 상태가 error로 떨어져 조건이 어긋났고, 게시가 나갔는지 모르는 자동화가 다음 슬롯에
    // 그대로 다시 실행됐다 — 판정하지 못한 것이 위험한 재실행을 허용하는 근거가 될 수는 없다.
    if (!parentMissing && !leaseOwnershipLost && requiresGraphReconciliation(machineError ?? runError)) {
      try {
        // 스케줄은 markAutomationRun이 이미 지웠을 수도 있다(같은 결정의 두 경로).
        // 어느 쪽이 지웠든 사용자에게는 한 가지 사실만 남으면 된다 — 왜 멈췄고 무엇을 하면 되는가.
        // 조용한 정지는 고장과 구분되지 않는다: "예약해 둔 자동화가 그냥 안 돈다"로만 보인다.
        suspendAutomationForGraphReconciliation(a.id);
        const chat = getOrCreateAutomationSession(automationSessionInput(a));
        appendChatMessage(
          chat.chat.id,
          "system",
          [
            "이전 실행이 외부에 무언가를 반영했는지 확인되지 않아 자동 재실행을 멈췄습니다.",
            "같은 작업이 두 번 나가는 것을 막기 위한 조치이며, 자동화는 꺼지지 않았습니다.",
            "자동화 상세에서 어떤 단계가 실제로 반영됐는지 확인해 주시면 그 지점부터 이어서 실행합니다.",
          ].join(" "),
        );
      } catch (error) {
        console.error("[automation] graph reconciliation suspension failed:", error);
      }
    }
    // 복구 학습 — 실패 스트릭 후의 성공은 "다른 방법이 통했다"는 증거다. durable 복구
    // 이벤트 + 메모리/경험 자동 승격 + (동일 실패 2회 복구 시) 프롬프트 진화 자동 적용.
    // 어떤 실패도 런 결과에 영향을 주지 않는다(모듈 내부에서 전부 격리).
    if (
      runStatus === "ok" && runOutcome !== "needs_input" && runOutcome !== "blocked" &&
      !parentMissing && !leaseOwnershipLost &&
      priorFailureContext.streak >= 1 && currentRunId
    ) {
      try {
        recordAutomationRecovery({
          automation: a,
          runId: currentRunId,
          prior: priorFailureContext,
          output,
        });
      } catch (err) {
        console.error("[automation] recovery learning failed:", err);
      }
    }
    // 실패 피드백·수리 — run_history 기록(markAutomationRun) 이후에 호출해야
    // countConsecutiveFailures가 이번 실패를 포함한다.
    // 복구 워커는 "제품이 고칠 수 있는 것"에만 보낸다.
    //  · 판정 불가: 실행은 끝까지 갔고 우리가 결과를 못 읽었을 뿐이다.
    //  · needs_input: 사람이 결정하거나 값을 줘야 끝나는 상태다. 모델을 보내면
    //    "결과가 수용되지 않았다"는 거짓 전제로 사람만 할 수 있는 일을 시키는 셈이고,
    //    매 실행마다 호출이 한 번씩 더 나간다. 이 상태는 사용자에게 표면화하면 된다.
    // blocked·partial·error는 외부 제약 해소나 재시도로 실제로 나아질 수 있으므로 그대로 둔다.
    if (
      runStatus !== "ok" && runStatus !== "skipped" && runStatus !== "needs_input" &&
      runOutcome !== "needs_input" &&
      !judgmentUnavailableRun && !parentMissing && !leaseOwnershipLost
    ) {
      try {
        handleAutomationFailure(a, runError ?? "unknown error", currentRunId);
      } catch (err) {
        console.error("[automation] handleAutomationFailure failed:", err);
      }
    }
    if (!parentMissing && !leaseOwnershipLost && opts?.triggerDelivery) {
      try {
        // This scheduler-level result can differ from automation_runs.status:
        // a graph may finish mechanically but classify as partial/blocked.
        opts.triggerDelivery.onCompleted(runStatus, runError);
      } catch (error) {
        // The outbox will retry sealing the receipt after runOne returns. Until
        // then a graph-only `ok` is treated as ambiguous and never replayed.
        console.error("[automation] trigger delivery completion receipt failed:", error);
      }
    }
    // 예약 경로에서 이 프로세스가 실제로 획득한 리스만 해제한다. Run now/이벤트 경로는
    // 리스를 얻지 않았으므로 다른 프로세스의 due 클레임을 건드리지 않는다.
    if (opts?.claim) {
      try {
        releaseAutomationRun(a.id, LEASE_OWNER);
      } catch {
        /* best-effort 리스 해제 */
      }
    }
    if (!parentMissing && !leaseOwnershipLost) {
      notifyDone(a, runStatus, runError ?? undefined);
      void notifyTelegramAutomationDone(a, runStatus, {
        error: runError,
        output,
        at: new Date().toISOString(),
      }).catch((err) => {
        console.error("[automation] telegram report failed:", err);
      });
    }
    running.delete(a.id);
    // Durable chain fan-out은 markAutomationRun transaction에서 이미 끝났다.
    // 이 신호는 GUI outbox를 즉시 깨우는 저지연 가속일 뿐이다.
    if (!parentMissing && !leaseOwnershipLost) {
      try {
        emitAutomationDone({
          automationId: a.id,
          ok: runStatus === "ok",
          runId: currentRunId ?? undefined,
          output,
          at: new Date().toISOString(),
        });
      } catch {
        /* best-effort */
      }
    }
  }
  // ── 완주 루프 ④: 도구 0건 성공 주장은 재실행이 안전하다 ─────────────────
  // `claimed_without_tools` 는 "외부에 어떤 부작용도 관측되지 않았다"는 호스트의
  // 사실 판정이므로, 같은 발사를 도구가 실측된 런타임으로 한 번 더 돌려도 이중
  // 게시가 구조적으로 불가능하다. 실측 배경: agy 도구 미배선 기간, 자동화가
  // "게시했다"는 소설로 12연속 accepted — 사용자는 실패 화면 대신 애초에
  // 완주된 결과를 받았어야 했다. 재시도는 1회뿐이고(표식), 스케줄은 이미
  // 전진했으므로 advanceSchedule=false, 리스는 새로 잡는다.
  if (
    !opts?.zeroToolRetried &&
    !opts?.dryRun &&
    typeof runError === "string" &&
    runError.includes("[claimed_without_tools]")
  ) {
    // Main-owned automation pins are authoritative. A zero-tool claim is already
    // a failed exact run; retrying on the global worker pool would silently cross
    // providers (for example, Antigravity -> Claude) and make the dashboard chip
    // a lie. The original failure is durable and requires an explicit pin change.
    if (a.runtimeSelection) {
      console.error(
        `[automation] ${a.id} claimed success with zero tool calls — refusing cross-runtime retry for pinned ${a.runtimeSelection.kind}/${a.runtimeSelection.model ?? "default"}`,
      );
      return { accepted: true, automationId: a.id, runId: currentRunId, status: runStatus, error: runError, output };
    }
    // The retry must follow the dashboard's worker role. A hard-coded Claude
    // fallback made an Antigravity automation silently cross provider
    // boundaries and was indistinguishable from an accidental Claude call.
    const fallbackRuntime = rolePriorityRuntimes(await detectRuntimes(), "worker")[0] ?? null;
    if (!fallbackRuntime) {
      const retryError = "[zero_tool_retry_unavailable] no worker runtime is connected";
      console.error(`[automation] ${a.id} ${retryError}`);
      return { accepted: true, automationId: a.id, runId: currentRunId, status: "error", error: retryError, output };
    }
    const fallback: RuntimeSelection = {
      kind: fallbackRuntime.kind,
      backend: fallbackRuntime.backend,
      source: fallbackRuntime.source,
      model: fallbackRuntime.model ?? undefined,
      longContext: fallbackRuntime.longContextEnabled,
      effort: fallbackRuntime.effort ?? undefined,
    };
    // The authoritative-pin branch returned above, so this legacy retry path
    // intentionally has no saved runtime to compare against.
    const sameKind = false;
    if (!sameKind) {
      try {
        console.error(
          `[automation] ${a.id} claimed success with zero tool calls — retrying once on ${fallback.kind}/${fallback.model}`,
        );
        const retried = await runOne(
          { ...a, runtimeSelection: fallback },
          {
            claim: opts?.claim,
            advanceSchedule: false,
            allowDisabledLease: opts?.allowDisabledLease,
            triggerContext: opts?.triggerContext,
            zeroToolRetried: true,
            fresh: opts?.fresh,
          },
        );
        // ★사전 확인의 관측 기반 완결 — 재시도가 도구로 실제 완주했다면 그 사실을
        // 자동화에 영속한다. 다음 발사부터는 사후 재시도가 아니라 처음부터 검증된
        // 런타임으로 나간다(단어장·능력표 추측 없이, 이 기계에서 실측된 결과만).
        if (
          retried.accepted &&
          !(typeof retried.error === "string" && retried.error.includes("[claimed_without_tools]"))
        ) {
          try {
            updateAutomation(a.id, { runtimeSelection: fallback });
            console.error(
              `[automation] ${a.id} learned runtime ${fallback.kind}/${fallback.model} from a tool-proven retry`,
            );
          } catch (err) {
            console.error("[automation] failed to persist learned runtime:", err);
          }
        }
        return retried;
      } catch (err) {
        console.error("[automation] zero-tool retry failed:", err);
      }
    }
  }
  return { accepted: true, automationId: a.id, runId: currentRunId, status: runStatus, error: runError, output };
}

export async function runDueAutomationsNow(now: Date = new Date()): Promise<void> {
  if (installQuiescing) return;
  let due: Automation[];
  try {
    due = dueAutomations(now);
  } catch (err) {
    console.error("[automation] dueAutomations failed:", err);
    return;
  }
  // due-폴링 경로는 크로스프로세스 리스로 클레임(headless vs GUI 이중 실행 방지).
  await runWithConcurrency(due, MAX_CONCURRENT_AUTOMATIONS, async (a) => {
    await runOne(a, { claim: true, fireTime: now });
  });
}

/** "Run now" — 스케줄 무관하게 지정 자동화를 즉시 1회 실행(enabled 여부 무시). */
export async function runAutomationNow(id: string, opts?: { dryRun?: boolean; fresh?: boolean }): Promise<TriggerDispatchResult> {
  if (installQuiescing) throw new Error("Automation execution is paused while an update is prepared");
  const a = getAutomation(id);
  if (!a) throw new Error(`Automation not found: ${id}`);
  // Disabled automations remain manually runnable, but still acquire the same
  // shared lease as every scheduled/headless execution.
  const freshRunId = opts?.fresh
    ? `run-${id}-${Date.now()}-${randomUUID().slice(0, 8)}`
    : undefined;
  return runOne(a, {
    claim: true,
    advanceSchedule: false,
    allowDisabledLease: true,
    ...(opts?.dryRun ? { dryRun: true } : {}),
    ...(opts?.fresh ? { fresh: true, runId: freshRunId } : {}),
  });
}

export interface AutomationRunNowAck {
  accepted: boolean;
  automationId: string;
  runId: string | null;
  status: "queued" | "rejected";
}

/**
 * Mobile must not hold one RPC open for an entire automation. Acquire the same
 * cross-process lease synchronously, durably bind a runId, then execute in the
 * background. listRuns/live state are the result channel.
 */
export function enqueueAutomationRunNow(id: string): AutomationRunNowAck {
  if (installQuiescing) return { accepted: false, automationId: id, runId: null, status: "rejected" };
  const automation = getAutomation(id);
  if (!automation) throw new Error(`Automation not found: ${id}`);
  if (running.has(id)) return { accepted: false, automationId: id, runId: null, status: "rejected" };
  if (!claimAutomationRun(id, LEASE_OWNER, new Date(), { allowDisabled: true })) {
    return { accepted: false, automationId: id, runId: null, status: "rejected" };
  }
  const runId = `run-${id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    recordRunEvent({
      runId,
      kind: "automation_run_requested",
      automationId: id,
      payload: { source: "mobile", status: "queued" },
    });
  } catch (error) {
    try { releaseAutomationRun(id, LEASE_OWNER); } catch {}
    throw error;
  }
  void runOne(automation, {
    claim: true,
    preclaimed: true,
    runId,
    advanceSchedule: false,
    allowDisabledLease: true,
  }).catch((error) => console.error(`[automation] queued run failed (${id})`, error));
  return { accepted: true, automationId: id, runId, status: "queued" };
}

/**
 * 이벤트 트리거(fs/chain)가 발사할 때 호출 — 지정 자동화를 즉시 1회 실행한다.
 * 트리거 매니저에 주입되는 RunFn. due/Run now와 같은 리스를 획득해 중복 실행을 막는다.
 */
export async function runAutomationFromTrigger(
  id: string,
  ctx: TriggerEventPayload = {},
  triggerDelivery?: TriggerDeliveryHooks,
): Promise<TriggerDispatchResult> {
  if (installQuiescing) return { accepted: false };
  const a = getAutomation(id);
  if (!a) return { accepted: false };
  return runOne(a, { claim: true, advanceSchedule: false, triggerDelivery, triggerContext: ctx });
}

function tick(): void {
  if (installQuiescing) return;
  // A GUI and the optional headless runner may share this DB. Recovery only
  // closes snapshots that have been silent beyond the scheduler's absolute
  // active-tool ceiling; recent progress from either process keeps a run live.
  try {
    recoverStaleAutomationRuns();
  } catch (err) {
    console.error("[automation] stale run recovery failed:", err);
  }
  void runDueAutomationsNow();
  // 폴 트리거 구동(설계 §3.3) — 새 타이머 없이 같은 60초 틱에 얹는다. nextPollAt<=now인
  // poll 자동화만 검사(적응형 간격). 매니저 미기동(헤드리스 등)이면 no-op.
  void (async () => {
    try {
      const { pollTick } = await import("./triggers/manager");
      await pollTick();
    } catch {
      /* 매니저 미기동이면 무시 */
    }
  })();
}

export function startAutomationScheduler(): void {
  if (installQuiescing || timer) return;
  timer = setInterval(tick, 60_000);
  if (timer.unref) timer.unref();
  // 시작 직후 1회 점검 — 앱이 꺼져 있던 동안 놓친 due를 한 번 따라잡는다(누적 폭주 방지: markRun이 다음 미래로 전진).
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
  }, 5_000);
  startupTimer.unref?.();
}

export function stopAutomationScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  // 앱 종료/스케줄러 정지 시 보조 진단 런도 즉시 취소한다. runner가 신호를 무시해도
  // abortGate가 lifecycle을 settle하므로 optimizer 슬롯과 watchdog timer가 남지 않는다.
  for (const controller of optimizerControllers.values()) {
    if (!controller.signal.aborted) {
      controller.abort(new Error("System Optimizer cancelled because scheduler stopped"));
    }
  }
}

/**
 * Freeze new automation dispatch and wait for current DB-writing lifecycles to
 * finish before updater continuity is captured. A busy automation is not
 * cancelled or consumed; the install attempt fails closed and can be retried.
 */
export async function quiesceAutomationSchedulerForUpdate(
  timeoutMs = 12_000,
): Promise<() => void> {
  const shouldRestart = timer !== null || startupTimer !== null;
  installQuiescing = true;
  stopAutomationScheduler();
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (running.size > 0 || optimizerControllers.size > 0) {
    if (Date.now() >= deadline) {
      installQuiescing = false;
      if (shouldRestart) startAutomationScheduler();
      throw new Error("Active automation did not drain before update continuity capture");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    installQuiescing = false;
    if (shouldRestart) startAutomationScheduler();
  };
}
