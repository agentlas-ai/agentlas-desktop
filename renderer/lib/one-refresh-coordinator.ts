/** Keep one read in flight and collapse invalidations into one fresh trailing read. */
export function createCoalescedRefresh<T>(
  execute: (input: T) => Promise<void>,
  merge: (previous: T, incoming: T) => T,
): { request(input: T): Promise<void>; dispose(): void } {
  type Waiter = { resolve(): void; reject(error: unknown): void };
  let pending: { input: T; waiters: Waiter[] } | null = null;
  let running = false;
  let disposed = false;
  const start = () => {
    if (running || disposed) return;
    running = true;
    // Defer until running owns the read, including synchronous invalidations.
    void Promise.resolve().then(async () => {
      while (pending && !disposed) {
        const next = pending;
        pending = null;
        try {
          await execute(next.input);
          // Each caller waits for its own batch, not future polling forever.
          for (const waiter of next.waiters) waiter.resolve();
        } catch (error) {
          for (const waiter of next.waiters) waiter.reject(error);
        }
      }
    }).finally(() => {
      running = false;
      // Cover an invalidation arriving at the completion microtask boundary.
      if (pending && !disposed) start();
    });
  };
  return {
    request(input) {
      if (disposed) return Promise.resolve();
      const promise = new Promise<void>((resolve, reject) => {
        if (pending) {
          pending.input = merge(pending.input, input);
          pending.waiters.push({ resolve, reject });
        } else pending = { input, waiters: [{ resolve, reject }] };
      });
      start();
      return promise;
    },
    dispose() {
      disposed = true;
      for (const waiter of pending?.waiters ?? []) waiter.resolve();
      pending = null;
    },
  };
}
