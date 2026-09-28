import type { InvocationHostStopCause, InvocationRunReceipt, RunEventUi } from "@shared/types";
import { isOneSteeringInterruption } from "@shared/one-auto-recovery";
import { projectOneActivityFromLedger, type OneActivityState } from "./one-activity";

/**
 * Where each run's work block sits in the thread.
 *
 * Main records `invoke_started` a few ms *before* it persists the prompt row
 * for that run (`electron/invocation/service.ts` → `mcp/client.ts
 * persistUserMessage`), so a run's own prompt is the first prompt-authored row
 * at or after the run start, bounded by the next run's start. The block is
 * drawn right after that prompt and before the answer the run produced.
 */

/** How far a run's own prompt row may sit from its start (Main persists it inside the same request). */
const PROMPT_ROW_WINDOW_MS = 120_000;

export interface OneThreadRunBlock {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: InvocationRunReceipt["status"];
  interruptionCause?: "steering";
  /** Main stopped this run itself (app closed, Goal paused/deleted) — not a run error. */
  hostStopCause?: InvocationHostStopCause;
  state: OneActivityState;
}

/**
 * Keep deliberate steering separate from an unexplained interrupted receipt.
 * This is intentionally fail-closed: only the exact typed ledger sequence
 * written by InvocationService may neutralize the ordinary interruption UI.
 */
export function oneRunInterruptionCause(
  receipt: InvocationRunReceipt,
  events: RunEventUi[],
): OneThreadRunBlock["interruptionCause"] {
  if (receipt.interruptionCause === "steering") return "steering";
  return isOneSteeringInterruption(receipt, events) ? "steering" : undefined;
}

export function projectThreadRuns(
  timeline: Array<{ receipt: InvocationRunReceipt; events: RunEventUi[] }>,
): OneThreadRunBlock[] {
  return timeline
    .filter((entry) => entry.receipt && entry.receipt.runId)
    .map((entry) => {
      const interruptionCause = oneRunInterruptionCause(entry.receipt, entry.events);
      return {
        runId: entry.receipt.runId,
        startedAt: entry.receipt.startedAt,
        ...(entry.receipt.finishedAt ? { finishedAt: entry.receipt.finishedAt } : {}),
        status: entry.receipt.status,
        ...(interruptionCause ? { interruptionCause } : {}),
        ...(entry.receipt.hostStopCause ? { hostStopCause: entry.receipt.hostStopCause } : {}),
        state: projectOneActivityFromLedger(entry.events, entry.receipt),
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export interface OneThreadPlanMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt?: string;
}

export interface OneThreadWorkPlan {
  /** message id → blocks drawn immediately after that message. */
  afterMessage: Map<string, OneThreadRunBlock[]>;
  /** Blocks whose prompt row is not in the visible list (drawn before the first message). */
  leading: OneThreadRunBlock[];
}

export function planOneThreadWork(input: {
  messages: OneThreadPlanMessage[];
  runs: OneThreadRunBlock[];
  /** The live run is drawn by the caller from live state; skip its settled twin. */
  excludeRunId?: string | null;
}): OneThreadWorkPlan {
  const afterMessage = new Map<string, OneThreadRunBlock[]>();
  const leading: OneThreadRunBlock[] = [];
  const durable = input.messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => typeof entry.message.createdAt === "string" && entry.message.createdAt);
  const runs = [...input.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    if (input.excludeRunId && run.runId === input.excludeRunId) continue;
    const nextStart = runs[runIndex + 1]?.startedAt;
    const prevStart = runs[runIndex - 1]?.startedAt;
    const startMs = Date.parse(run.startedAt);
    // 1) The prompt row nearest to the run start, on either side: Main persists
    //    the durable row a few ms *after* invoke_started, the renderer stamps an
    //    optimistic row a few hundred ms *before* it. The next turn's prompt is
    //    tens of seconds away, so "nearest within the window, not past the
    //    neighbouring runs" picks the right one for both row kinds.
    let anchor: { message: OneThreadPlanMessage; index: number } | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of durable) {
      const message = entry.message;
      if (message.role !== "user" && message.role !== "system") continue;
      const createdAt = message.createdAt!;
      if (nextStart && createdAt >= nextStart) continue;
      if (prevStart && createdAt <= prevStart) continue;
      const distance = Math.abs(Date.parse(createdAt) - startMs);
      if (distance > PROMPT_ROW_WINDOW_MS) continue;
      // Prefer the row after start on a tie (the durable twin over an optimistic one).
      if (distance < bestDistance || (distance === bestDistance && createdAt >= run.startedAt)) {
        bestDistance = distance;
        anchor = entry;
      }
    }
    // 2) Otherwise the last row that already existed when the run started.
    if (!anchor) {
      for (let index = durable.length - 1; index >= 0; index -= 1) {
        if (durable[index].message.createdAt! <= run.startedAt) {
          anchor = durable[index];
          break;
        }
      }
    }
    // 3) Rows without a timestamp (optimistic turns of a session-only
    //    conversation): the last prompt row in the list started this run.
    //
    //    ★ Only when *no* row carries a timestamp. A timestamped list that has
    //    no row at or before this run means the run is older than the loaded
    //    window (history reads the latest 200 rows, the ledger the latest 40
    //    runs) — its prompt is simply not on screen, so it leads the list.
    //    Owner 2026-09-28, Thread Marketing: 20 runs older than the window were
    //    all hung under the newest prompt, so the "계속" just sent sat 20 work
    //    blocks above the bottom and the screen showed old runs instead of it.
    if (!anchor && durable.length === 0) {
      for (let index = input.messages.length - 1; index >= 0; index -= 1) {
        const message = input.messages[index];
        if (message.role === "user" || message.role === "system") {
          anchor = { message, index };
          break;
        }
      }
    }
    if (!anchor) {
      leading.push(run);
      continue;
    }
    const list = afterMessage.get(anchor.message.id) ?? [];
    list.push(run);
    afterMessage.set(anchor.message.id, list);
  }
  return { afterMessage, leading };
}

/**
 * May the settlement of a run in `settleChatId` repaint the screen's live Activity?
 *
 * ★ 오너 신고 2026-09-28 — "X 자동화 결과가 Thread Marketing 단톡에 뜬다".
 * DB·원장에는 X 대화 행이 Thread 대화에 한 줄도 없었다(표시 전용 결함). X Marketing 의
 * 실행(484f24f2, 22:54:43Z 종료)이 끝난 직후 오너가 Thread Marketing 으로 옮겼고
 * (last_viewed 22:54:47Z), 끝난 실행의 정산(settleRun)이 refreshAll·영수증·원장 읽기를
 * 기다린 뒤 **어느 대화가 화면에 있는지 보지 않고** 그 실행의 Activity 를 화면에 칠했다.
 * 화면은 "방금 끝난 실행 = 이 대화의 마지막 블록"으로 그리므로(threadWorkPlan), X 의
 * 작업 블록과 단톡 대화가 Thread 대화 끝에 붙었다. 대화 전환은 runChatIdRef 를 새 대화로
 * 동기적으로 바꾸므로, 정산이 칠해도 되는지는 그 값 하나로 가른다.
 */
export function settledRunMayPaintScreen(input: {
  settleChatId: string;
  screenRunChatId: string | null;
}): boolean {
  return Boolean(input.settleChatId) && input.screenRunChatId === input.settleChatId;
}
