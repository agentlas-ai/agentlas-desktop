import type { InvocationRunReceipt, RunEventUi } from "@shared/types";
import { projectOneActivityFromLedger, type OneActivityArtifact } from "./one-activity";

/** How many of a run's first events every One screen reads (`runLedger.events` answers 500 at most). */
export const ONE_RUN_EVENT_WINDOW = 500;

interface RunLedgerOutputsApi {
  runLedger?: {
    outputsAfter?: (runId: string, afterSeq: number) => Promise<unknown>;
    settleRowsAfter?: (runId: string, afterSeq: number) => Promise<unknown>;
  } | null;
}

/**
 * The rows a run's ledger holds after the event window that name its later outputs, to hand to
 * `projectOneActivityFromLedger(events, receipt, rows)` together with the window.
 *
 * The output rail is projected from the first 500 rows of a run. A run longer than that (a Goal pass with thousands of tool
 * calls, or a 584-event run whose last two outputs come after the 500th) lost every output it wrote past the window, on the
 * full One view's restore and on a split pane alike, and the rail shrank when a long run settled and the screen re-read it.
 * Main answers the outputs that lie past the window from the sealed bindings (electron/store/run-events.ts
 * listRunOutputEventsAfter); the projector merges them as it merges the window's own, so a rail never depends on run length.
 *
 * A window that is not full held the whole run: nothing is asked. A bridge without `outputsAfter` (an older host), an answer
 * that is not rows, or a failed call adds nothing: the rail is then the window's, as before.
 */
export async function readRunOutputsAfterWindow(
  api: RunLedgerOutputsApi | null | undefined,
  runId: string | null | undefined,
  events: readonly RunEventUi[],
  window: number = ONE_RUN_EVENT_WINDOW,
): Promise<RunEventUi[]> {
  if (!runId || events.length < window) return [];
  const afterSeq = events[events.length - 1]?.seq;
  const runLedger = api?.runLedger;
  if (typeof runLedger?.outputsAfter !== "function" || !Number.isSafeInteger(afterSeq) || afterSeq < 0) return [];
  try {
    const rows = await runLedger.outputsAfter(runId, afterSeq);
    return Array.isArray(rows) ? (rows as RunEventUi[]) : [];
  } catch {
    return [];
  }
}

/**
 * The rows a run's ledger holds after the event window that settle it (`mcp_final`, `invoke_completed`, the failure and stop
 * rows), to hand to the projectors together with the window.
 *
 * A run longer than the window has its ending past it. A projection that never reads the ending draws the run unsettled: Work
 * could not tell which answer the run produced (the anchor `mcp_final.durableMessageId` lies past the 400th row of the long
 * runs measured) and drew the run's work as a row of its own, tool rows whose result lies past the window read as still
 * running, and the tokens and the failure reason were missing. Main answers these rows (electron/store/run-events.ts
 * listRunSettleRowsAfter); the projectors replay them after the window.
 *
 * The same guards as `readRunOutputsAfterWindow`: a window that is not full held the whole run, and a bridge without the call
 * (an older host), an answer that is not rows, or a failed call adds nothing: the run is then the window's, as before.
 */
export async function readRunSettleRowsAfterWindow(
  api: RunLedgerOutputsApi | null | undefined,
  runId: string | null | undefined,
  events: readonly RunEventUi[],
  window: number = ONE_RUN_EVENT_WINDOW,
): Promise<RunEventUi[]> {
  if (!runId || events.length < window) return [];
  const afterSeq = events[events.length - 1]?.seq;
  const runLedger = api?.runLedger;
  if (typeof runLedger?.settleRowsAfter !== "function" || !Number.isSafeInteger(afterSeq) || afterSeq < 0) return [];
  try {
    const rows = await runLedger.settleRowsAfter(runId, afterSeq);
    return Array.isArray(rows) ? (rows as RunEventUi[]) : [];
  } catch {
    return [];
  }
}

/**
 * Everything a run longer than the event window still owes its projection: the rows naming its later outputs and the rows
 * that settle it, oldest first. Hand the result to `projectOneActivityFromLedger(events, receipt, lateRows)` (it replays the
 * output rows into the output list and appends the settling rows to the window) and to the anchor reads that take the
 * window's rows. Asks only when the window is full; never throws.
 */
export async function readRunLateRowsAfterWindow(
  api: RunLedgerOutputsApi | null | undefined,
  runId: string | null | undefined,
  events: readonly RunEventUi[],
  window: number = ONE_RUN_EVENT_WINDOW,
): Promise<RunEventUi[]> {
  // One ask after the other, so a window read four runs at a time never has more than four asks in flight.
  const outputs = await readRunOutputsAfterWindow(api, runId, events, window);
  const settle = await readRunSettleRowsAfterWindow(api, runId, events, window);
  if (outputs.length === 0) return settle;
  if (settle.length === 0) return outputs;
  // A settling row that also names an output is one row.
  const named = new Set(outputs.map((row) => row.id));
  return [...outputs, ...settle.filter((row) => !named.has(row.id))].sort((a, b) => a.seq - b.seq);
}

/** Runs of one window asked about at once: each ask is one read in Main and a window holds at most 40 runs. */
const LATE_OUTPUT_READS_AT_ONCE = 4;

/** A `runLedger.chatTimeline` entry, plus the rows a run longer than its event window still owes its projection. */
export interface RunTimelineEntryWithLateRows {
  receipt: InvocationRunReceipt;
  events: RunEventUi[];
  lateRows?: readonly RunEventUi[];
}

/**
 * The same timeline, each run whose event window is full carrying the rows it still owes its projection (`lateRows`: the rows
 * naming its later outputs and the rows that settle it, `readRunLateRowsAfterWindow`), which the per-run projections
 * (`projectOneActivityFromLedger(events, receipt, lateRows)`) add to the run.
 *
 * The thread's work blocks (a window of 40 runs x 400 events) and the Work screen's run projections (the same window) draw each
 * run from the first 400 rows of the run, so a long run lost the outputs it wrote after the 400th row and its ending: the
 * answer it produced (Work drew its work as a row of its own), the rows still open at the window's edge, its tokens. Only runs
 * whose window is full are asked (a shorter one held the whole run), at most a few at a time, and an entry with nothing to add
 * is returned as it came. The window is the one the timeline was read with; the asking itself never throws.
 */
export async function withLateRunRows<T extends RunTimelineEntryWithLateRows>(
  api: RunLedgerOutputsApi | null | undefined,
  timeline: readonly T[],
  eventWindow: number,
): Promise<T[]> {
  const full = timeline.filter((entry) => Boolean(entry?.receipt?.runId) && Array.isArray(entry.events) && entry.events.length >= eventWindow);
  if (full.length === 0) return [...timeline];
  const rows = new Map<T, RunEventUi[]>();
  let next = 0;
  const worker = async () => {
    while (next < full.length) {
      const entry = full[next++];
      const late = await readRunLateRowsAfterWindow(api, entry.receipt.runId, entry.events, eventWindow);
      if (late.length > 0) rows.set(entry, late);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LATE_OUTPUT_READS_AT_ONCE, full.length) }, worker));
  return timeline.map((entry) => (rows.has(entry) ? { ...entry, lateRows: rows.get(entry)! } : entry));
}

/**
 * The outputs a split-view pane lists for its chat: exactly what the full One view's Outputs panel lists for that chat.
 *
 * The full view restores a chat's Activity from its latest run alone (OneShell: invoke.latestReceipt -> runLedger.events(run, 500)
 * + the run's later outputs -> projectOneActivityFromLedger(events, receipt, outputRows) -> activity.artifacts -> TaskSidePanel
 * items), and a run that starts resets it to that run (beginOneActivityState: "the Activity speaks for that one run"). Inside the
 * run the reducer merges every later save of the same output into one entry that opens the newest bytes
 * (mergeVerifiedSurfaceArtifacts, key = shared/one-artifacts.ts oneArtifactRailMergeKey: kind, Task, chat, label). The pane
 * projects with the same function over the same rows, and asks for the same later outputs through the same helper.
 *
 * The pane used to join the events of the chat's last four runs and project them as ONE run. The reducer seals at the first
 * terminal event of that joined stream, so only the oldest of the four runs could ever contribute: a run that finished
 * without a file followed by a run that wrote one showed no output at all, each of the two alone showed it, and the pane's
 * Outputs button never carried a count.
 *
 * `runs` is the `runLedger.chatTimeline` answer, oldest first; the newest run is the last entry (the pane asks for that one
 * run). Anything that is not that answer, a run without events, or a projection that cannot be read lists nothing.
 */
export async function projectLatestRunArtifacts(
  api: RunLedgerOutputsApi | null | undefined,
  runs: unknown,
): Promise<OneActivityArtifact[]> {
  if (!Array.isArray(runs) || runs.length === 0) return [];
  const latest = runs[runs.length - 1] as { receipt?: InvocationRunReceipt | null; events?: unknown } | null;
  const events = latest && Array.isArray(latest.events) ? (latest.events as RunEventUi[]) : [];
  if (events.length === 0) return [];
  try {
    const outputRows = await readRunOutputsAfterWindow(api, latest?.receipt?.runId ?? events[0]?.runId, events);
    return projectOneActivityFromLedger(events, latest?.receipt ?? null, outputRows).artifacts;
  } catch {
    return [];
  }
}
