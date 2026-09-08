import type { InvocationRunReceipt, RunEventUi } from "@shared/types";
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
  state: OneActivityState;
}

export function projectThreadRuns(
  timeline: Array<{ receipt: InvocationRunReceipt; events: RunEventUi[] }>,
): OneThreadRunBlock[] {
  return timeline
    .filter((entry) => entry.receipt && entry.receipt.runId)
    .map((entry) => ({
      runId: entry.receipt.runId,
      startedAt: entry.receipt.startedAt,
      ...(entry.receipt.finishedAt ? { finishedAt: entry.receipt.finishedAt } : {}),
      status: entry.receipt.status,
      state: projectOneActivityFromLedger(entry.events, entry.receipt),
    }))
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
    if (!anchor) {
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
