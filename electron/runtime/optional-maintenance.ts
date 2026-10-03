/** Schedules optional work only after a guarded product-document boundary. */
export function createOptionalMaintenance(options: {
  run(signal: AbortSignal): Promise<boolean>;
  onFailure(): void;
  fallbackMs?: number;
  schedule?: (callback: () => void, delay: number) => () => void;
}) {
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return () => clearTimeout(timer);
  });
  let stopped = false;
  let completed = false;
  let generation = 0;
  let cancelFallback: (() => void) | undefined;
  let cancelDispatch: (() => void) | undefined;
  let active: AbortController | undefined;
  let running: Promise<void> | undefined;
  let current: { documentKey: unknown; generation: number; isCurrent: () => boolean; attempted: boolean } | undefined;
  const invalidate = () => {
    generation += 1;
    current = undefined;
    cancelFallback?.(); cancelFallback = undefined;
    cancelDispatch?.(); cancelDispatch = undefined;
    active?.abort();
  };
  const arm = (input: { documentKey: unknown; isCurrent(): boolean; paintOpportunity(): Promise<unknown> }) => {
    if (stopped || completed || current?.documentKey === input.documentKey) return;
    invalidate();
    const request = current = { documentKey: input.documentKey, generation, isCurrent: input.isCurrent, attempted: false };
    const valid = () => !stopped && !completed && current === request && input.isCurrent();
    const dispatch = () => {
      if (!valid() || request.attempted) return;
      cancelFallback?.(); cancelFallback = undefined;
      // Wait for an aborted old document's work to settle before the next job.
      if (running) { void running.then(dispatch); return; }
      request.attempted = true;
      cancelDispatch = schedule(() => {
        cancelDispatch = undefined;
        if (!valid()) return;
        const controller = active = new AbortController();
        running = Promise.resolve().then(() => {
          if (!valid() || controller.signal.aborted) return false;
          return options.run(controller.signal);
        }).then((started) => { if (started) completed = true; }, () => {
          // Observability must not turn optional failure into an unhandled rejection.
          if (!controller.signal.aborted) { try { options.onFailure(); } catch {} }
        }).finally(() => { if (active === controller) active = undefined; running = undefined; });
      }, 0);
    };
    cancelFallback = schedule(dispatch, options.fallbackMs ?? 30_000);
    // A hidden document can suspend rAF indefinitely. The bounded fallback uses
    // the same current-document and startup admission checks, never a bypass.
    void Promise.resolve().then(() => valid() ? input.paintOpportunity() : undefined).then(dispatch, () => {});
  };
  return { arm, invalidate, stop() { stopped = true; invalidate(); } };
}
