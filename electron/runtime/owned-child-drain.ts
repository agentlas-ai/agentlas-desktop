import type { ChildProcess } from "node:child_process";

/** Physical custody only. Register immediately after spawn; conveys no authority. */
export function createOwnedChildDrain(child: ChildProcess): {
  readonly closed: Promise<void>;
  stop(options?: { graceMs?: number; forceAfterMs?: number }): Promise<void>;
} {
  let ended = false, stopping = false, termRequested = false, forceRequested = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined, forceTimer: ReturnType<typeof setTimeout> | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  child.on("error", () => { /* The caller owns the error outcome; close owns drain. */ });
  child.once("close", () => {
    if (ended) return;
    ended = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); resolveClosed();
  });
  const schedule = (delay: number, action: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!ended) action(); }, delay);
    timers.add(timer); return timer;
  };
  const kill = (signal: "SIGTERM" | "SIGKILL") => { if (!ended) { try { child.kill(signal); } catch { /* Request failure never proves death. */ } } };
  return {
    closed,
    stop(options = {}) {
      if (ended) return closed;
      const term = () => {
        if (!termRequested) { termRequested = true; kill("SIGTERM"); }
        if (options.forceAfterMs !== undefined && !ended && forceTimer === undefined && !forceRequested) {
          forceTimer = schedule(Math.max(0, options.forceAfterMs), () => { forceRequested = true; kill("SIGKILL"); });
        }
      };
      if ((options.graceMs ?? 0) > 0) {
        if (!stopping) graceTimer = schedule(options.graceMs!, term);
      } else {
        // An explicit Stop must not wait behind an earlier stdin-close grace.
        if (graceTimer !== undefined) { clearTimeout(graceTimer); timers.delete(graceTimer); graceTimer = undefined; }
        term();
      }
      stopping = true;
      return closed;
    },
  };
}

/** The materialized child uses the same drain implementation; no runtime import. */
export const OWNED_CHILD_DRAIN_SOURCE = `const createOwnedChildDrain = ${createOwnedChildDrain.toString()};`;
