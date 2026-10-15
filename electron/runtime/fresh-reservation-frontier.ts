/** Retries observation of one already-closed original fact only. The caller owns
 * every source/tuple/owner/receipt guard and stops on a false guard. This helper
 * grants no execution authority and never retries producers, RPCs or cleanup. */
export function createClosedFactRetry(ports: {
  observe(): void | Promise<void>;
  schedule(retry: () => void, delayMs: number): void | (() => void);
}) {
  let stopped = false, scheduled = false, running = false, requested = false;
  let delayMs = 25, cancel: void | (() => void);
  const stop = () => { stopped = true; requested = false; scheduled = false; if (cancel) cancel(); cancel = undefined; };
  function request(): void {
    if (stopped) return;
    if (running) { requested = true; return; }
    if (scheduled) return;
    scheduled = true;
    try {
      cancel = ports.schedule(() => {
        cancel = undefined; scheduled = false;
        if (stopped) return;
        running = true;
        const complete = () => { running = false; if (requested) { requested = false; request(); } };
        try {
          const result = ports.observe();
          if (result) void Promise.resolve(result).then(complete, () => { stop(); complete(); });
          else complete();
        } catch { stop(); complete(); } // Unexpected observer failure is not a new closed fact.
      }, delayMs);
      delayMs = Math.min(5_000, delayMs * 2);
    } catch { stop(); }
  }
  return Object.freeze({ request, stop, get pending() { return scheduled || requested; } });
}

/** Process-private local setup frontier. It owns no DB, permission or dispatch
 * authority: the native creator supplies its exact freshly-created row closure. */
export function createFreshReservationFrontier(ports: {
  tryReject(): boolean;
  schedule(retry: () => void, delayMs: number): void;
  onFailure(error: unknown): void;
}) {
  let phase: "reserved" | "source-entered" | "closing" | "closed" | "held" = "reserved";
  let reported = false;
  const retry = createClosedFactRetry({ observe: reject, schedule: ports.schedule });
  const report = (error: unknown) => { if (!reported) { reported = true; try { ports.onFailure(error); } catch { /* Keep the original setup error. */ } } };
  function reject(): void {
    if (phase !== "closing" || retry.pending) return;
    try { phase = ports.tryReject() ? "closed" : "held"; retry.stop(); }
    catch (error) {
      report(error);
      // A thrown storage observation is not a failed source guard. Retain the
      // exact original closure until its CAS succeeds or explicitly returns false.
      retry.request();
    }
  }
  return Object.freeze({
    get phase() { return phase; },
    enterSource<T>(body: () => T): T {
      if (phase !== "reserved") throw new Error("fresh_reservation_source_already_entered_or_closed");
      phase = "source-entered"; // Before invoking any opaque source, even if it throws.
      return body();
    },
    closeBeforeSource(): void {
      if (phase === "reserved") phase = "closing";
      reject();
    },
  });
}
