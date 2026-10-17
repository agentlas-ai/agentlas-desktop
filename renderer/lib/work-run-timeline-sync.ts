import type { InvocationRunReceipt, RunEventUi } from "@shared/types";

/**
 * Work's run window over runLedger.chatTimeline: the last 40 runs of a chat, each with its first 400 events
 * (listChatRunTimeline: invoke_started rows newest first, each run's events ORDER BY seq ASC LIMIT 400).
 */
export const WORK_TIMELINE_RUNS = 40;
export const WORK_TIMELINE_EVENTS_PER_RUN = 400;

export interface WorkRunTimelineEntry { receipt: InvocationRunReceipt; events: RunEventUi[] }

/** One chat's per-run projections, each kept with the exact receipt it was projected from. */
export interface WorkRunProjectionCache<P> {
  readonly chatId: string;
  readonly runs: ReadonlyMap<string, { readonly signature: string; readonly projection: P }>;
}

/**
 * A run's events change only together with its receipt: every append moves eventCount and updatedAt, a retention trim
 * moves eventCount, a terminal row moves status and finishedAt. An identical receipt means the run projects the same.
 */
function receiptSignature(receipt: InvocationRunReceipt): string {
  return JSON.stringify(receipt);
}

/**
 * What a settle asks runLedger.chatTimeline for. With projections of this chat already held: one event per run, which is
 * enough to learn the window's runs and their current receipts (a few KB per run). Without: the full window, the same
 * read thread open makes.
 */
export function workRunTimelineRequest<P>(cache: WorkRunProjectionCache<P> | null, chatId: string): { maxRuns: number; eventsPerRun: number } {
  return { maxRuns: WORK_TIMELINE_RUNS, eventsPerRun: cache?.chatId === chatId ? 1 : WORK_TIMELINE_EVENTS_PER_RUN };
}

/** Project every run of a full window read (thread open) and keep each projection with its receipt. */
export function seedWorkRunProjections<P>(
  chatId: string,
  timeline: readonly WorkRunTimelineEntry[],
  project: (entry: WorkRunTimelineEntry) => P,
): { projections: P[]; cache: WorkRunProjectionCache<P> } {
  const runs = new Map<string, { signature: string; projection: P }>();
  const projections: P[] = [];
  for (const entry of timeline) {
    // A row without a run id is never attached (the Work projection drops it too), so it is neither kept nor shown.
    if (!entry?.receipt?.runId) continue;
    const run = { signature: receiptSignature(entry.receipt), projection: project(entry) };
    runs.set(entry.receipt.runId, run);
    projections.push(run.projection);
  }
  return { projections, cache: { chatId, runs } };
}

/**
 * Settle: the same projections a full window read would give, reading events only for the runs whose receipt changed.
 *
 * `timeline` is the chatTimeline read made with workRunTimelineRequest(cache, chatId) for this same `cache`. Without
 * projections of this chat it is the full window and is projected whole. Otherwise it names the current window (run
 * set and order from Main, as the full read would) with current receipts; a run whose receipt equals the one its kept
 * projection came from keeps it, any other run is read alone (`events`) and projected. The run that just settled
 * reuses the events the caller already read for it (`settled`, ORDER BY seq ASC with at least the window's limit).
 * Measured before (perf R-02 / H4): each settle downloaded 40 runs x 400 events, 5.5-9.7 MB, although one run changed.
 */
export async function syncWorkRunProjections<P>(input: {
  chatId: string;
  cache: WorkRunProjectionCache<P> | null;
  timeline: readonly WorkRunTimelineEntry[];
  events: (runId: string) => Promise<RunEventUi[]>;
  full: () => Promise<WorkRunTimelineEntry[]>;
  project: (entry: WorkRunTimelineEntry) => P;
  settled?: { runId: string; events: readonly RunEventUi[] } | null;
}): Promise<{ projections: P[]; cache: WorkRunProjectionCache<P> }> {
  const { chatId, cache, project } = input;
  if (!cache || cache.chatId !== chatId) return seedWorkRunProjections(chatId, input.timeline, project);
  const fullRead = async () => seedWorkRunProjections(chatId, await input.full().catch(() => []), project);
  const window = input.timeline.filter((entry) => entry?.receipt?.runId);
  const changed = [...new Set(window
    .filter((entry) => cache.runs.get(entry.receipt.runId)?.signature !== receiptSignature(entry.receipt))
    .map((entry) => entry.receipt.runId))];
  // Each changed run read alone moves up to 400 events; past half the window one full read moves no more.
  if (changed.length > WORK_TIMELINE_RUNS / 2) return fullRead();
  let events: Map<string, RunEventUi[]>;
  try {
    events = new Map(await Promise.all(changed.map(async (runId) => {
      const known = input.settled?.runId === runId && input.settled.events.length > 0
        ? input.settled.events.slice(0, WORK_TIMELINE_EVENTS_PER_RUN) : null;
      return [runId, known ?? await input.events(runId)] as const;
    })));
  } catch {
    // A failed single-run read must not show a partial transcript: read the window whole, as before.
    return fullRead();
  }
  const runs = new Map<string, { signature: string; projection: P }>();
  const projections: P[] = [];
  for (const entry of window) {
    const runId = entry.receipt.runId;
    const signature = receiptSignature(entry.receipt);
    const kept = cache.runs.get(runId);
    const run = kept && kept.signature === signature
      ? kept
      : runs.get(runId)?.signature === signature
        ? runs.get(runId)!
        : { signature, projection: project({ receipt: entry.receipt, events: events.get(runId) ?? [] }) };
    runs.set(runId, run);
    projections.push(run.projection);
  }
  return { projections, cache: { chatId, runs } };
}
