import type { InvocationHostStopCause, InvocationRunReceipt, RunEventUi } from "@shared/types";
import { isOneSteeringInterruption } from "@shared/one-auto-recovery";
import { ledgerWithSettleRows, projectOneActivityFromLedger, type OneActivityState } from "./one-activity";

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
  /** Main-persisted assistant row identity, never a timestamp/text guess. */
  answerMessageIds?: string[];
  startedAt: string;
  finishedAt?: string;
  status: InvocationRunReceipt["status"];
  interruptionCause?: "steering";
  /** Main stopped this run itself (app closed, Goal paused/deleted) — not a run error. */
  hostStopCause?: InvocationHostStopCause;
  /** A later run took this failed run's request over (receipt, from the ledger): recovered history, drawn quiet. */
  supersededByRunId?: string;
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

/**
 * `lateRows` (optional, per run): the rows a run longer than its event window still owes its block (lib/one-chat-outputs
 * withLateRunRows): the rows naming the outputs it wrote past the window, which add to the block's output list, and the rows
 * that settle it, which the block reads like the rest of the run's ledger (its ending, its answer ids). The other work rows
 * stay the window's.
 */
export function projectThreadRuns(
  timeline: Array<{ receipt: InvocationRunReceipt; events: RunEventUi[]; lateRows?: readonly RunEventUi[] }>,
): OneThreadRunBlock[] {
  return timeline
    .filter((entry) => entry.receipt && entry.receipt.runId)
    .map((entry) => {
      const ledger = ledgerWithSettleRows(entry.events, entry.lateRows);
      const interruptionCause = oneRunInterruptionCause(entry.receipt, ledger);
      return {
        runId: entry.receipt.runId,
        answerMessageIds: [...new Set(ledger.filter(event => event.runId === entry.receipt.runId && (!event.chatId || event.chatId === entry.receipt.chatId) && !event.agentId && event.kind === "mcp_final")
          .map(event => event.payload.durableMessageId).filter((id): id is string => typeof id === "string" && Boolean(id.trim())))],
        startedAt: entry.receipt.startedAt,
        ...(entry.receipt.finishedAt ? { finishedAt: entry.receipt.finishedAt } : {}),
        status: entry.receipt.status,
        ...(interruptionCause ? { interruptionCause } : {}),
        ...(entry.receipt.hostStopCause ? { hostStopCause: entry.receipt.hostStopCause } : {}),
        ...(entry.receipt.supersededByRunId ? { supersededByRunId: entry.receipt.supersededByRunId } : {}),
        state: projectOneActivityFromLedger(entry.events, entry.receipt, entry.lateRows),
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Receipt statuses Main owns while the run is still executing. */
export function isLiveRunStatus(status: InvocationRunReceipt["status"] | undefined): boolean {
  return status === "running" || status === "cancelling";
}

/**








 */
export function unattachedOpenThreadRuns(
  runs: readonly OneThreadRunBlock[],
  liveRunId: string | null,
  checked: ReadonlySet<string>,
): OneThreadRunBlock[] {
  return runs.filter((run) => run.runId !== liveRunId && !checked.has(`${run.runId}:${run.status}`)
    && (isLiveRunStatus(run.status)
      || (run.status === "interrupted" && !run.finishedAt && !run.interruptionCause && !run.hostStopCause)));
}

/**
 * Main's answer for those blocks: `live` runs are still executing (keep them live, follow them), `settled` runs reached a
 * receipt that differs from the block (re-read them so the block finishes), `confirmed` pairs need no further question.
 */
export function reconcileOpenThreadRuns(
  blocks: readonly OneThreadRunBlock[],
  receipts: ReadonlyArray<InvocationRunReceipt | null | undefined>,
): { live: InvocationRunReceipt[]; settled: InvocationRunReceipt[]; confirmed: string[] } {
  const live: InvocationRunReceipt[] = [], settled: InvocationRunReceipt[] = [], confirmed: string[] = [];
  blocks.forEach((block, index) => {
    const receipt = receipts[index];
    if (!receipt || receipt.runId !== block.runId) return;
    if (isLiveRunStatus(receipt.status)) live.push(receipt);
    else if (receipt.status === block.status && (receipt.finishedAt ?? null) === (block.finishedAt ?? null)) confirmed.push(`${block.runId}:${block.status}`);
    else settled.push(receipt);
  });
  return { live, settled, confirmed };
}

/** Replace the blocks Main re-read, by run id; every other block stays as it was. */
export function replaceThreadRunBlocks(runs: readonly OneThreadRunBlock[], fresh: readonly OneThreadRunBlock[]): OneThreadRunBlock[] {
  if (!fresh.length) return [...runs];
  const byId = new Map(fresh.map((block) => [block.runId, block]));
  return runs.map((run) => byId.get(run.runId) ?? run);
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










 */
export function settledRunMayPaintScreen(input: {
  settleChatId: string;
  screenRunChatId: string | null;
}): boolean {
  return Boolean(input.settleChatId) && input.screenRunChatId === input.settleChatId;
}
