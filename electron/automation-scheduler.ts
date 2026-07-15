// 자동화 스케줄러 — 앱이 켜져 있는 동안 60초마다 due 자동화를 점검해 실행한다.
// 실행 = 타깃(firm/agent)의 백그라운드(division) chat을 만들어 runMcpInvocation로 promptTemplate을 돌린다.
// (M1: 인프로세스 타이머. 앱이 꺼져 있으면 안 돎 — launchd persistent 데몬은 후속 작업.)
import { app, Notification } from "electron";
import type { Automation } from "../shared/types";
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
} from "./store/automations";
import { checkComputerUsePermissions } from "./mac-permissions";
import { getOrCreateAutomationSession, appendChatMessage, listChatMessages } from "./store/chats";
import { runRuntimeDoctor, type DoctorReport } from "./system-agents/runtime-doctor";
import { buildSystemOptimizerPrompt } from "./system-agents/system-optimizer";
import { runMcpInvocation } from "./mcp/client";
import { runGraph } from "./workflow/run-graph";
import { broadcastLiveRun } from "./workflow/live-run";
import { isStormbreakerLongRunPrompt } from "./hephaestus/loop-engineering";
import { emitAutomationDone } from "./triggers/chain-bus";
import { classifyAutomationOutput, type AutomationResultStatus } from "./automation-result";
import {
  recordMcpInvocationEvent,
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
import { pickActive } from "./runtime/selection";

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let installQuiescing = false;
const running = new Set<string>();

// 이 프로세스의 리스 소유자 식별자(설계 §2.6). headless launchd 러너 vs GUI를 구분해
// claimed_at/lease_owner에 기록한다. 같은 due 행을 둘이 이중 실행하지 않게 한다.
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
    new Notification({
      title: ok ? `Automation ran: ${a.name}` : skipped ? `Automation skipped: ${a.name}` : `Automation failed: ${a.name}`,
      body: ok ? "Completed successfully." : error ? error.slice(0, 200) : skipped ? "Nothing was eligible to run." : "See run history.",
      silent: true,
    }).show();
  } catch (err) {
    console.error("[automation] notification failed:", err);
  }
}

/** Provider resume is an optimization, not the continuity authority. Every run receives a
 * bounded durable capsule so a backend switch or expired CLI session cannot erase the prior run. */
function buildAutomationContinuityPrompt(chatId: string, prompt: string): string {
  const prior = listChatMessages(chatId, 12)
    .filter((message) => message.role === "assistant" || message.role === "system")
    .slice(-4)
    .map((message) => `[${message.role} ${message.createdAt}] ${message.text.replace(/\s+/g, " ").trim().slice(0, 1_200)}`);
  if (prior.length === 0) return prompt;
  return [
    "[Agentlas automation continuity capsule]",
    "This is the same durable automation session. Continue from these prior outcomes; do not restart setup or create a new CLI/session unless an explicit lifecycle error requires it.",
    ...prior,
    "[/Agentlas automation continuity capsule]",
    "",
    prompt,
  ].join("\n");
}

// ── 실패 처리 정책(2026-07-08) ─────────────────────────────────────────────
// 문제: 자동화가 실패해도 챗창에 아무 피드백이 없고(프롬프트만 복붙처럼 쌓임),
// 같은 프롬프트를 매 스케줄마다 무한 재실행했다(시스템 원인이면 전부 실패).
// 정책: 실패 시 (1) Runtime Doctor가 아는 시스템 원인은 즉시 수리, (2) 실패 원인을
// 자동화 챗에 system 메시지로 표출, (3) 수리 못 했고 연속 실패가 임계에 닿으면
// 자동 일시정지, (4) 수리 못 한 반복 실패는 System Optimizer(LLM) 원샷 진단 발사.
const FAILURE_PAUSE_THRESHOLD = 3;
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
} {
  return {
    automationId: a.id,
    ...(a.targetType === "firm" ? { firmId: a.targetId } : a.targetType === "agent" ? { agentId: a.targetId } : {}),
  };
}

/** Scheduler authority is capped at read/write even for malformed legacy objects. */
function schedulerExecutionPermission(a: Automation): "read" | "write" {
  return a.executionPermission === "read" ? "read" : "write";
}

/** 실패 원인을 챗에 표출하고, 아는 원인은 수리하고, 반복 실패는 멈춘다. best-effort. */
function handleAutomationFailure(a: Automation, error: string): void {
  let doctor: DoctorReport | null = null;
  try {
    doctor = runRuntimeDoctor(error);
  } catch (err) {
    console.error("[automation] runtime doctor failed:", err);
  }
  let streak = 1;
  try {
    streak = Math.max(1, countConsecutiveFailures(a.id));
  } catch {
    /* run_history 조회 실패는 스트릭 1로 취급 */
  }

  const lines: string[] = [`⚠️ Automation failed (연속 ${streak}회): ${error.slice(0, 400)}`];
  if (doctor?.summary) lines.push(`🩺 Runtime Doctor: ${doctor.summary}`);
  for (const act of doctor?.actions ?? []) lines.push(`🔧 ${act.title} — ${act.detail}`);

  let paused = false;
  if (doctor?.repaired) {
    lines.push("✅ 시스템 원인을 자동 수리했습니다. 다음 예약에 자동으로 재시도합니다.");
  } else if (streak >= FAILURE_PAUSE_THRESHOLD) {
    try {
      toggleAutomation(a.id, false);
      paused = true;
      lines.push(
        `⏸️ ${streak}회 연속 실패로 자동 일시정지했습니다(같은 프롬프트 무한 재실행 방지). 원인 해결 후 자동화 화면에서 다시 켜세요.`,
      );
    } catch (err) {
      console.error("[automation] auto-pause failed:", err);
    }
  }

  try {
    const chat = getOrCreateAutomationSession(automationSessionInput(a));
    appendChatMessage(chat.id, "system", lines.join("\n"));

    // 결정론 수리가 못 잡은 반복 실패 → System Optimizer 원샷 진단(같은 챗에 기록됨).
    const lastAt = lastOptimizerRunAt.get(a.id) ?? 0;
    if (
      !doctor?.repaired &&
      streak >= 2 &&
      !optimizerControllers.has(a.id) &&
      Date.now() - lastAt >= OPTIMIZER_MIN_INTERVAL_MS
    ) {
      lastOptimizerRunAt.set(a.id, Date.now());
      const optimizerController = new AbortController();
      optimizerControllers.set(a.id, optimizerController);
      const prompt = buildSystemOptimizerPrompt({
        automationName: a.name,
        errorMessage: error,
        doctorSummary: doctor?.summary,
        consecutiveFailures: streak,
      });
      const runId = `doctor-${a.id}-${Date.now()}`;
      const req = {
        runId,
        chatId: chat.id,
        userPrompt: prompt,
        permissions: schedulerExecutionPermission(a),
        toolMode: "auto" as const,
        hubMode: a.hubMode ?? "hub-allowed",
      };
      tryRecordRunEvent({
        runId,
        kind: "system_optimizer_started",
        automationId: a.id,
        payload: { streak, paused, doctorKind: doctor?.kind ?? "unknown" },
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
      const optimizerRun = Promise.resolve().then(() =>
        runMcpInvocation(
          req,
          (ev) => recordMcpInvocationEvent(runId, req, ev),
          optimizerController.signal,
          undefined,
          { source: "automation" },
        ),
      );
      void Promise.race([optimizerRun, abortGate])
        .catch((err) => {
          console.error("[automation] system optimizer run failed:", err);
          try {
            appendChatMessage(chat.id, "system", `⚠️ System Optimizer 진단 런 자체가 실패했습니다: ${err instanceof Error ? err.message : String(err)}`);
          } catch {
            /* best-effort */
          }
        })
        .finally(() => {
          clearTimeout(optimizerTimer);
          removeAbortListener();
          if (optimizerControllers.get(a.id) === optimizerController) {
            optimizerControllers.delete(a.id);
          }
        });
    }
  } catch (err) {
    console.error("[automation] failure feedback failed:", err);
  }

  if (paused) {
    try {
      if (app.isReady() && Notification.isSupported()) {
        new Notification({
          title: `Automation paused: ${a.name}`,
          body: `${streak}회 연속 실패로 자동 일시정지했습니다. 챗의 진단 메시지를 확인하세요.`,
          silent: true,
        }).show();
      }
    } catch {
      /* best-effort */
    }
  }
}

async function runOne(
  a: Automation,
  opts?: { claim?: boolean; advanceSchedule?: boolean; allowDisabledLease?: boolean },
): Promise<void> {
  if (installQuiescing) return;
  if (running.has(a.id)) return; // 직전 실행이 아직 진행 중이면 건너뜀
  // 모든 실행 경로가 같은 크로스프로세스 리스를 사용한다. GUI의 Run now나 이벤트 트리거도
  // headless due 실행과 겹치면 외부 게시/결제 같은 부작용을 두 번 낼 수 있으므로 건너뛴다.
  if (
    opts?.claim &&
    !claimAutomationRun(a.id, LEASE_OWNER, new Date(), { allowDisabled: opts.allowDisabledLease === true })
  ) return;
  running.add(a.id);
  let runStatus: AutomationResultStatus = "ok";
  let runError: string | null = null;
  let output: string | undefined;
  let currentRunId: string | null = null;
  let parentMissing = false;
  let leaseOwnershipLost = false;
  let leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let leaseRenewWarningEmitted = false;
  try {
    const controller = new AbortController();
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
    if (!a.runtimeSelection) {
      const activeRuntime = pickActive(await detectRuntimes());
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
    }
    // 컴퓨터유즈 자동화 preflight — macOS 접근성 권한이 없으면 실행하지 않고 '대기'로 스킵한다.
    // (예전엔 권한 없이 실행돼 브라우저 자동화가 부분 실행 후 먹통/혼란. 이제 빠르게 감지 →
    //  다음 예약에 자동 재시도, false-fail도 false-success도 아님.)
    const cuaPerm = a.toolMode === "computer-use" ? checkComputerUsePermissions() : null;
    if (cuaPerm && !cuaPerm.ok) {
      runStatus = "skipped";
      runError =
        `macOS ${cuaPerm.missing.join(" · ")} 권한이 꺼져 있어 컴퓨터유즈 자동화를 건너뜁니다(먹통 방지). ` +
        `시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 Agentlas를 켜세요. 켜면 다음 예약에 자동 재시도합니다.`;
      console.warn(`[automation] CUA preflight skip (${a.name}): missing ${cuaPerm.missing.join(", ")}`);
    } else if (a.graph && a.graph.nodes.length > 0) {
      // 그래프 경로 — 위상 러너로 실행. per-node 상태를 라이브 채널로 방송해 캔버스가 애니메이션.
      const runId = `run-${a.id}-${Date.now()}`;
      currentRunId = runId;
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
        const graphRun = Promise.resolve().then(() =>
          runGraph(a, a.graph!, {
            signal: controller.signal,
            runId,
            sink: (ev) => {
              // A cancellation-ignoring runtime may emit after the scheduler's finite abort
              // boundary. Do not revive watchdog/live state after this run has been finalized.
              if (!acceptGraphEvents) return;
              noteAutomationWatchdogEvent(graphWatchdog, ev);
              persistGraphHeartbeat();
              if (ev.nodeState) broadcastLiveRun(a.id, ev);
            },
          }),
        );
        result = await awaitAutomationRunnerWithAbortGrace(graphRun, controller.signal);
      } catch (err) {
        // abort로 runGraph가 던지면 스톨 메시지로 바꿔 닥터 timeout 분류에 태운다.
        if (graphStall) {
          throw new Error(automationWatchdogError(graphStall));
        }
        throw err;
      } finally {
        acceptGraphEvents = false;
        clearInterval(graphStallTimer);
      }
      runStatus = result.ok && !graphStall ? "ok" : "error";
      runError = graphStall
        ? automationWatchdogError(graphStall)
        : result.error ?? null;
      // 그래프 outputs 중 마지막 노드 출력을 체인 페이로드로 노출.
      const outVals = Object.values(result.outputs ?? {});
      output = outVals.length ? outVals[outVals.length - 1] : undefined;
      if (runStatus === "ok") {
        const classified = classifyAutomationOutput(output);
        runStatus = classified.status;
        runError = classified.reason;
      }
    } else {
      // 레거시 단일 프롬프트 경로(완전 backward-compat).
      const runId = `run-${a.id}-${Date.now()}`;
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
        startGraphRun({ runId, automationId: a.id, nodeIds: ["n0", "n1"] });
        emitLegacyState("n0", "done");
        emitLegacyState("n1", "running");
      } catch (snapshotError) {
        if (isAutomationRunParentMissingError(snapshotError)) throw snapshotError;
        /* 스냅샷 시작 실패는 무시 */
      }
      const chat = getOrCreateAutomationSession({
        automationId: a.id,
        ...(a.targetType === "firm" ? { firmId: a.targetId } : a.targetType === "agent" ? { agentId: a.targetId } : {}),
      });
      try {
        let runnerError: string | null = null;
        const req = {
          runId,
          chatId: chat.id,
          userPrompt: buildAutomationContinuityPrompt(chat.id, a.promptTemplate),
          permissions: schedulerExecutionPermission(a),
          borrowAgents: a.targetType === "hub" ? [a.targetId] : undefined,
          // 핀이 있으면 그 버전으로만 실행한다. 없으면 기존대로 latest — 즉 작성자가 재게시하면
          // 이 자동화의 지시문이 예고 없이 바뀐다. 핀은 그 drift를 명시적 실패로 바꾼다.
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
          const invocationRun = Promise.resolve().then(() =>
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
          );
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
        const classified = classifyAutomationOutput(output);
        runStatus = classified.status;
        runError = classified.reason;
        emitLegacyState("n1", runStatus === "error" ? "failed" : runStatus === "skipped" ? "skipped" : "done");
        try {
          finishGraphRun(runId, runStatus === "error" ? "error" : "ok");
        } catch {
          /* ignore */
        }
        if (runStatus === "error") throw new Error(runError ?? "Automation result was classified as failed");
        if (isStormbreakerLongRunPrompt(a.promptTemplate) && !result.stormbreakerContinueRequested) {
          toggleAutomation(a.id, false);
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
    runStatus = "error";
    runError = err instanceof Error ? err.message : String(err);
    parentMissing = isAutomationRunParentMissingError(err);
    if (!parentMissing) {
      tryRecordFailureEvent({
        runId: currentRunId,
        source: "automation",
        automationId: a.id,
        errorCode: "automation_failed",
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
      try {
        markAutomationRun(a.id, new Date(), {
          status: runStatus,
          error: runError,
          advanceSchedule: opts?.advanceSchedule ?? true,
        });
      } catch (err) {
        console.error("[automation] markAutomationRun failed:", err);
      }
    }
    // 실패 피드백·수리·자동 일시정지 — run_history 기록(markAutomationRun) 이후에 호출해야
    // countConsecutiveFailures가 이번 실패를 포함한다.
    if (runStatus === "error" && !parentMissing && !leaseOwnershipLost) {
      try {
        handleAutomationFailure(a, runError ?? "unknown error");
      } catch (err) {
        console.error("[automation] handleAutomationFailure failed:", err);
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
    // 체인 트리거용 완료 이벤트 방출(설계 §3.4 Tier 0 #2). 인프로세스 EventEmitter.
    if (!parentMissing && !leaseOwnershipLost) {
      try {
        emitAutomationDone({ automationId: a.id, ok: runStatus === "ok", output, at: new Date().toISOString() });
      } catch {
        /* best-effort */
      }
    }
  }
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
  await runWithConcurrency(due, MAX_CONCURRENT_AUTOMATIONS, (a) => runOne(a, { claim: true }));
}

/** "Run now" — 스케줄 무관하게 지정 자동화를 즉시 1회 실행(enabled 여부 무시). */
export async function runAutomationNow(id: string): Promise<void> {
  if (installQuiescing) throw new Error("Automation execution is paused while an update is prepared");
  const a = getAutomation(id);
  if (!a) throw new Error(`Automation not found: ${id}`);
  // Disabled automations remain manually runnable, but still acquire the same
  // shared lease as every scheduled/headless execution.
  await runOne(a, { claim: true, advanceSchedule: false, allowDisabledLease: true });
}

/**
 * 이벤트 트리거(fs/chain)가 발사할 때 호출 — 지정 자동화를 즉시 1회 실행한다.
 * 트리거 매니저에 주입되는 RunFn. due/Run now와 같은 리스를 획득해 중복 실행을 막는다.
 */
export async function runAutomationFromTrigger(id: string): Promise<void> {
  if (installQuiescing) return;
  const a = getAutomation(id);
  if (!a) return;
  await runOne(a, { claim: true, advanceSchedule: false });
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
