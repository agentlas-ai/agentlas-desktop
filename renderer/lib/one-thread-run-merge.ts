import type { InvocationRunReceipt, RunEventUi } from "@shared/types";

/**







 */

/** Window and per-run event count of the full re-read this replaces (`listChatRunTimeline` defaults). */
export const THREAD_RUN_WINDOW = 40;
export const THREAD_RUN_EVENTS_PER_RUN = 400;

export interface ThreadRunBlockLike {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: InvocationRunReceipt["status"];
  hostStopCause?: InvocationRunReceipt["hostStopCause"];
  supersededByRunId?: string;
}

type TimelineEntry = { receipt: InvocationRunReceipt; events: RunEventUi[]; outputRows?: readonly RunEventUi[] };

const LIVE_STATUSES = new Set(["running", "cancelling"]);

function sameReceiptFacts(block: ThreadRunBlockLike, receipt: InvocationRunReceipt): boolean {
  return block.startedAt === receipt.startedAt
    && block.status === receipt.status
    && (block.finishedAt ?? null) === (receipt.finishedAt ?? null)
    && (block.hostStopCause ?? null) === (receipt.hostStopCause ?? null)
    // A later run taking a failed run's request over changes that older block: only a full re-read is exact.
    && (block.supersededByRunId ?? null) === (receipt.supersededByRunId ?? null);
}

export function mergeSettledThreadRun<B extends ThreadRunBlockLike>(
  previous: readonly B[],
  timelineHead: readonly TimelineEntry[],
  settledRunId: string,
  /** The settled run's ledger events in seq order; only the first THREAD_RUN_EVENTS_PER_RUN are used. */
  settledEvents: readonly RunEventUi[],
  project: (timeline: TimelineEntry[]) => B[],
  /** The rows naming the settled run's outputs past its first THREAD_RUN_EVENTS_PER_RUN events (lib/one-chat-outputs). */
  settledOutputRows?: readonly RunEventUi[],
): B[] | null {
  const head = timelineHead.filter((entry) => entry.receipt && entry.receipt.runId);
  const settled = head.find((entry) => entry.receipt.runId === settledRunId);
  if (!settled) return null;
  const known = new Map(previous.map((block) => [block.runId, block]));
  for (const entry of head) {
    if (entry.receipt.runId === settledRunId) continue;
    const block = known.get(entry.receipt.runId);
    // A run this view never projected, one still going, or one whose receipt moved: only a full re-read is exact.
    if (!block || LIVE_STATUSES.has(entry.receipt.status) || !sameReceiptFacts(block, entry.receipt)) return null;
  }
  const [settledBlock] = project([{
    receipt: settled.receipt,
    events: settledEvents.slice(0, THREAD_RUN_EVENTS_PER_RUN),
    ...(settledOutputRows?.length ? { outputRows: settledOutputRows } : {}),
  }]);
  if (!settledBlock) return null;
  // The window is the head's runs: a block that slid out of the newest 40 leaves, as it would on a full re-read.
  const window = new Set(head.map((entry) => entry.receipt.runId));
  return [...previous.filter((block) => window.has(block.runId) && block.runId !== settledRunId), settledBlock]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
