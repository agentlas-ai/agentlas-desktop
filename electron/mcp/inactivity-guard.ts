import type { McpInvocationEvent } from "../../shared/types";

/** Runtime/queue heartbeats prove process liveness, not semantic task progress. */
export function eventRenewsInactivityGuard(
  event: Pick<McpInvocationEvent, "activity">,
): boolean {
  return event.activity?.code !== "runtime_wait" && event.activity?.code !== "queue_wait";
}

export function createInactivityGuard(input: {
  timeoutMs: number;
  onTimeout: () => void;
  clock?: {
    schedule: (callback: () => void, delayMs: number) => unknown;
    cancel: (handle: unknown) => void;
  };
}): {
  record: (event: Pick<McpInvocationEvent, "activity">) => void;
  refresh: () => void;
  dispose: () => void;
} {
  let disposed = false;
  let timer: unknown = null;
  const schedule = input.clock?.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancel = input.clock?.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const refresh = () => {
    if (disposed) return;
    if (timer) cancel(timer);
    timer = schedule(() => {
      if (disposed) return;
      disposed = true;
      timer = null;
      input.onTimeout();
    }, input.timeoutMs);
  };
  const record = (event: Pick<McpInvocationEvent, "activity">) => {
    if (eventRenewsInactivityGuard(event)) refresh();
  };
  const dispose = () => {
    disposed = true;
    if (timer) cancel(timer);
    timer = null;
  };
  refresh();
  return { record, refresh, dispose };
}
