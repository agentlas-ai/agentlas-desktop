// 자동화 스케줄러 — 앱이 켜져 있는 동안 60초마다 due 자동화를 점검해 실행한다.
// 실행 = 타깃(firm/agent)의 백그라운드(division) chat을 만들어 runMcpInvocation로 promptTemplate을 돌린다.
// (M1: 인프로세스 타이머. 앱이 꺼져 있으면 안 돎 — launchd persistent 데몬은 후속 작업.)
import type { Automation } from "../shared/types";
import { dueAutomations, markAutomationRun, toggleAutomation } from "./store/automations";
import { getOrCreateAutomationSession } from "./store/chats";
import { runMcpInvocation } from "./mcp/client";
import { isStormbreakerLongRunPrompt } from "./hephaestus/loop-engineering";

let timer: ReturnType<typeof setInterval> | null = null;
const running = new Set<string>();

async function runOne(a: Automation): Promise<void> {
  if (running.has(a.id)) return; // 직전 실행이 아직 진행 중이면 건너뜀
  running.add(a.id);
  try {
    const chat = getOrCreateAutomationSession({
      automationId: a.id,
      ...(a.targetType === "firm" ? { firmId: a.targetId } : { agentId: a.targetId }),
    });
    const controller = new AbortController();
    const result = await runMcpInvocation(
      { chatId: chat.id, userPrompt: a.promptTemplate, permissions: "write" },
      () => {
        /* 백그라운드 실행 — UI 싱크 없음. 결과는 chat 메시지에 영속됨. */
      },
      controller.signal,
    );
    if (isStormbreakerLongRunPrompt(a.promptTemplate) && !result.stormbreakerContinueRequested) {
      toggleAutomation(a.id, false);
    }
  } catch (err) {
    console.error(`[automation] run failed (${a.name}):`, err);
  } finally {
    // 성공/실패와 무관하게 next_run_at을 전진시켜 즉시 재발화(무한 루프)를 막는다.
    try {
      markAutomationRun(a.id);
    } catch (err) {
      console.error("[automation] markAutomationRun failed:", err);
    }
    running.delete(a.id);
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
  await Promise.all(due.map((a) => runOne(a)));
}

function tick(): void {
  void runDueAutomationsNow();
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
