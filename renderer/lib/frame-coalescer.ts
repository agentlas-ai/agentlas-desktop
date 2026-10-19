import type { McpInvocationEvent } from "@shared/types";
import { isLivePartialCommitBoundary } from "@shared/interrupted-partial";

/**






 */

export interface FrameBatcherOptions {
  /** At most one flush per this many ms (in addition to one per frame). goose, jan and VS Code use 50 ms. */
  minIntervalMs?: number;
  /** Flush by timer when no frame comes (hidden window). */
  hiddenFallbackMs?: number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
  isHidden?: () => boolean;
}

export interface FrameBatcher {
  enqueue(task: () => void): void;
  /** Run every queued task now, in order. */
  flush(): void;
  /** Drop queued tasks (unmount). */
  cancel(): void;
  readonly size: number;
}

export function createFrameBatcher(options: FrameBatcherOptions = {}): FrameBatcher {
  const minIntervalMs = options.minIntervalMs ?? 0;
  const hiddenFallbackMs = options.hiddenFallbackMs ?? 100;
  const requestFrame = options.requestFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  const now = options.now ?? (() => Date.now());
  const isHidden = options.isHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  let tasks: Array<() => void> = [];
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  const disarm = () => {
    if (frame !== null) { cancelFrame(frame); frame = null; }
    if (timer !== null) { clearTimer(timer); timer = null; }
  };
  const due = () => {
    disarm();
    const wait = lastFlushAt + minIntervalMs - now();
    if (wait > 0 && tasks.length) { timer = setTimer(due, wait); return; }
    flush();
  };
  const arm = () => {
    if (frame !== null || timer !== null) return;
    if (!isHidden()) frame = requestFrame(due);
    timer = setTimer(due, Math.max(hiddenFallbackMs, minIntervalMs));
  };
  function flush(): void {
    disarm();
    if (!tasks.length) return;
    const run = tasks;
    tasks = [];
    lastFlushAt = now();
    let failure: { error: unknown } | null = null;
    for (const task of run) {
      try { task(); } catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
  }
  return {
    enqueue(task) { tasks.push(task); arm(); },
    flush,
    cancel() { disarm(); tasks = []; },
    get size() { return tasks.length; },
  };
}

/**
 * A run event that only moves the live answer bubble and the activity reducer: streamed root text (not a turn-commit
 * boundary, no goal result), a teammate's streamed text, or a thought delta. Everything else is applied at once,
 * after the queued stream updates.
 */
export function isLiveStreamTick(event: McpInvocationEvent): boolean {
  if (event.goalResult || event.durableMessageId) return false;
  if (event.kind === "partial") return !isLivePartialCommitBoundary(event);
  return event.kind === "reasoning" && event.reasoning?.phase === "delta";
}
