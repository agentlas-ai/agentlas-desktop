/**
 * Is any turn or model call running in this process right now? Background work that competes for the same local model
 * server (the tool-judgment measurement, external-tool-judgment.ts) runs only while nothing is, and pauses between its
 * steps as soon as something starts. Counted: every invocation scope (runtime/judgment-context.ts wraps each MCP
 * invocation — Work, One, automations — and the judgments inside it) and every local model runner call (Ollama, LM
 * Studio, MLX, the hub's managed runner). A step already sent finishes; the next one waits.
 */
let active = 0;
let lastChangeAt = Date.now();
const waiters = new Set<() => void>();

function changed(): void {
  lastChangeAt = Date.now();
  for (const wake of [...waiters]) wake();
}

/** Mark activity for the life of `run` (sync or async). */
export function trackTurnActivity<T>(run: () => T): T {
  active += 1; changed();
  let settled = false;
  const done = () => { if (settled) return; settled = true; active -= 1; changed(); };
  try {
    const result = run();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      (result as unknown as Promise<unknown>).then(done, done);
    } else done();
    return result;
  } catch (error) {
    done();
    throw error;
  }
}

export function activeTurnCount(): number {
  return active;
}

/** Resolves once nothing has been active for `quietMs`. Rejects only when `signal` aborts. */
export async function waitForNoActiveTurn(opts: { quietMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const quietMs = opts.quietMs ?? 2_000;
  for (;;) {
    opts.signal?.throwIfAborted();
    const idleFor = Date.now() - lastChangeAt;
    if (active === 0 && idleFor >= quietMs) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(finish, active === 0 ? quietMs - idleFor : 60_000);
      function finish() { clearTimeout(timer); waiters.delete(finish); opts.signal?.removeEventListener("abort", abort); resolve(); }
      function abort() { clearTimeout(timer); waiters.delete(finish); reject(opts.signal?.reason ?? new Error("aborted")); }
      waiters.add(finish);
      opts.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
