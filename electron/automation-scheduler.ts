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
  releaseAutomationRun,
  startGraphRun,
  updateGraphRunNode,
  finishGraphRun,
} from "./store/automations";
import { getOrCreateAutomationSession } from "./store/chats";
import { runMcpInvocation } from "./mcp/client";
import { runGraph } from "./workflow/run-graph";
import { broadcastLiveRun } from "./workflow/live-run";
import { isStormbreakerLongRunPrompt } from "./hephaestus/loop-engineering";
import { emitAutomationDone } from "./triggers/chain-bus";

let timer: ReturnType<typeof setInterval> | null = null;
const running = new Set<string>();

// 이 프로세스의 리스 소유자 식별자(설계 §2.6). headless launchd 러너 vs GUI를 구분해
// claimed_at/lease_owner에 기록한다. 같은 due 행을 둘이 이중 실행하지 않게 한다.
const LEASE_OWNER = `${process.pid}:${process.argv.includes("--headless-automations") ? "headless" : "gui"}`;

// 한 번의 점검에서 동시에 돌릴 자동화 수 상한. due가 한꺼번에 많이 쌓여도(앱이 오래 꺼져
// 있다 켜진 경우 등) 모든 에이전트 런을 동시에 띄우지 않게 막는다 — 저사양 기기에서
// CPU/RAM 폭주 방지. 각 런은 내부에서 다시 CLI/엔진 프로세스를 띄우므로 N을 작게 둔다.
const MAX_CONCURRENT_AUTOMATIONS = Number(
  process.env.AGENTLAS_AUTOMATION_CONCURRENCY ?? 2,
);

/** 작업 배열을 최대 `limit`개씩만 동시 실행하는 경량 풀(외부 의존성 없음). */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  const size = Math.max(1, Math.min(limit, queue.length));
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
function notifyDone(a: Automation, ok: boolean, error?: string): void {
  try {
    if (!app.isReady()) return;
    if (!Notification.isSupported()) return;
    new Notification({
      title: ok ? `Automation ran: ${a.name}` : `Automation failed: ${a.name}`,
      body: ok ? "Completed successfully." : error ? error.slice(0, 200) : "See run history.",
      silent: true,
    }).show();
  } catch (err) {
    console.error("[automation] notification failed:", err);
  }
}

async function runOne(a: Automation, opts?: { claim?: boolean; advanceSchedule?: boolean }): Promise<void> {
  if (running.has(a.id)) return; // 직전 실행이 아직 진행 중이면 건너뜀
  // due-폴링 경로만 크로스프로세스 리스로 클레임한다(설계 §2.6). 명시적 "Run now"/트리거
  // 발사는 클레임을 건너뛴다(사용자/이벤트가 의도한 즉시 실행이므로 GUI/headless 경합 무관).
  if (opts?.claim && !claimAutomationRun(a.id, LEASE_OWNER)) return;
  running.add(a.id);
  let ok = true;
  let runError: string | null = null;
  let output: string | undefined;
  try {
    const controller = new AbortController();
    if (a.graph && a.graph.nodes.length > 0) {
      // 그래프 경로 — 위상 러너로 실행. per-node 상태를 라이브 채널로 방송해 캔버스가 애니메이션.
      const runId = `run-${a.id}-${Date.now()}`;
      const result = await runGraph(a, a.graph, {
        signal: controller.signal,
        runId,
        sink: (ev) => {
          if (ev.nodeState) broadcastLiveRun(a.id, ev);
        },
      });
      ok = result.ok;
      runError = result.error ?? null;
      // 그래프 outputs 중 마지막 노드 출력을 체인 페이로드로 노출.
      const outVals = Object.values(result.outputs ?? {});
      output = outVals.length ? outVals[outVals.length - 1] : undefined;
    } else {
      // 레거시 단일 프롬프트 경로(완전 backward-compat).
      const runId = `run-${a.id}-${Date.now()}`;
      const emitLegacyState = (nodeId: string, nodeState: "pending" | "running" | "done" | "failed" | "skipped"): void => {
        try {
          updateGraphRunNode(runId, nodeId, nodeState);
        } catch {
          /* 스냅샷 실패는 실행을 막지 않는다 */
        }
        broadcastLiveRun(a.id, { kind: "partial", nodeId, nodeState, agentId: nodeId });
      };
      try {
        // flow/page.tsx의 synthesizeLegacyGraph 노드 id와 맞춰 단일 프롬프트 자동화도
        // 캔버스/상태 패널에서 즉시 보이게 한다.
        startGraphRun({ runId, automationId: a.id, nodeIds: ["n0", "n1"] });
        emitLegacyState("n0", "done");
        emitLegacyState("n1", "running");
      } catch {
        /* 스냅샷 시작 실패는 무시 */
      }
      const chat = getOrCreateAutomationSession({
        automationId: a.id,
        ...(a.targetType === "firm" ? { firmId: a.targetId } : { agentId: a.targetId }),
      });
      try {
        let runnerError: string | null = null;
        const result = await runMcpInvocation(
          { chatId: chat.id, userPrompt: a.promptTemplate, permissions: "write" },
          (ev) => {
            if (ev.kind === "error") {
              runnerError = ev.error?.message || "runner failed";
            }
          },
          controller.signal,
        );
        output = result.finalText;
        if (runnerError) throw new Error(runnerError);
        if (!output?.trim()) throw new Error("Automation finished without an assistant result");
        emitLegacyState("n1", "done");
        try {
          finishGraphRun(runId, "ok");
        } catch {
          /* ignore */
        }
        if (isStormbreakerLongRunPrompt(a.promptTemplate) && !result.stormbreakerContinueRequested) {
          toggleAutomation(a.id, false);
        }
      } catch (err) {
        emitLegacyState("n1", "failed");
        try {
          finishGraphRun(runId, "error");
        } catch {
          /* ignore */
        }
        throw err;
      }
    }
  } catch (err) {
    ok = false;
    runError = err instanceof Error ? err.message : String(err);
    console.error(`[automation] run failed (${a.name}):`, err);
  } finally {
    // 스케줄 전진은 (1) trigger_type==="schedule"이고 (2) 이번 실행이 실제 예약 발사일 때만.
    // run-now·이벤트 트리거는 advanceSchedule=false로 전달돼 next_run_at을 건드리지 않는다
    // (예약 슬롯을 잡아먹거나 이벤트 자동화를 시계 스케줄로 승격하는 버그 방지).
    // run_history 기록·run_count·종료 정책은 어느 경우든 동일하게 적용한다.
    try {
      markAutomationRun(a.id, new Date(), {
        status: ok ? "ok" : "error",
        error: runError,
        advanceSchedule: opts?.advanceSchedule ?? true,
      });
    } catch (err) {
      console.error("[automation] markAutomationRun failed:", err);
    }
    try {
      releaseAutomationRun(a.id);
    } catch {
      /* best-effort 리스 해제 */
    }
    notifyDone(a, ok, runError ?? undefined);
    running.delete(a.id);
    // 체인 트리거용 완료 이벤트 방출(설계 §3.4 Tier 0 #2). 인프로세스 EventEmitter.
    try {
      emitAutomationDone({ automationId: a.id, ok, output, at: new Date().toISOString() });
    } catch {
      /* best-effort */
    }
  }
}

export async function runDueAutomationsNow(now: Date = new Date()): Promise<void> {
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
  const a = getAutomation(id);
  if (!a) throw new Error(`Automation not found: ${id}`);
  await runOne(a, { advanceSchedule: false });
}

/**
 * 이벤트 트리거(fs/chain)가 발사할 때 호출 — 지정 자동화를 즉시 1회 실행한다.
 * 트리거 매니저에 주입되는 RunFn. 클레임 없이 실행(이벤트가 의도한 즉시 실행).
 */
export async function runAutomationFromTrigger(id: string): Promise<void> {
  const a = getAutomation(id);
  if (!a) return;
  await runOne(a, { advanceSchedule: false });
}

function tick(): void {
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
  if (timer) return;
  timer = setInterval(tick, 60_000);
  if (timer.unref) timer.unref();
  // 시작 직후 1회 점검 — 앱이 꺼져 있던 동안 놓친 due를 한 번 따라잡는다(누적 폭주 방지: markRun이 다음 미래로 전진).
  setTimeout(tick, 5_000);
}

export function stopAutomationScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
