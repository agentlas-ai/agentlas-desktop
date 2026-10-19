// Turns on one shared session run one after the other, in the order they arrived.
//
// Several conversations of a seat's agent use one journal and one native session (session-scope.ts). A second turn on that
// session used to be refused while the first ran (agent_context_delivery_busy, agent_context_prior_turn_unsettled), which
// is a dead end for an owner who simply typed in another conversation. This waits instead: first for the turns of this
// process that arrived earlier (a FIFO per session, held for the length of the turn), then for a turn of another
// process (the window process and the background service share the database, so the journal's open delivery is the truth).
// It never decides anything else: when the wait ends for any reason other than "free", the caller's existing checks run
// unchanged and give the answer they always gave. No Electron import: the background service loads this file too.

export const TURN_WAIT_MAX_MS = 20 * 60 * 1000;
const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 2_000;

export interface AgentContextTurnSlot {
  /** The turn waited for another one. */
  readonly waited: boolean;
  /** The wait ran out before the session was free: the caller's own checks decide, exactly as before the wait existed. */
  readonly timedOut: boolean;
  release(): void;
}
export interface AgentContextTurnSlotOptions {
  signal?: AbortSignal;
  /** True while a turn of ANOTHER process holds the session. Polled; the caller reads the journal and the run owners. */
  blocked(): boolean;
  /** Called once, when the turn starts to wait. */
  onWait?(): void;
  maxWaitMs?: number;
  /** Test seams. */
  now?(): number;
  sleep?(ms: number, signal: AbortSignal | undefined, wake: Promise<void>): Promise<void>;
}

const queues = new Map<string, symbol[]>();
const wakeups = new Map<string, Set<() => void>>();
const wakeAll = (key: string): void => { for (const wake of [...wakeups.get(key) ?? []]) wake(); };

function defaultSleep(ms: number, signal: AbortSignal | undefined, wake: Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("agent_context_turn_wait_cancelled")); };
    function done(): void { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); }
    void wake.then(done);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Take the session's place in line. Resolves when this turn is first in line in this process and no other process holds
 * the session. The slot is held until `release()`; the caller releases it when the turn is over, whatever its outcome.
 */
export async function acquireAgentContextTurnSlot(sessionKey: string, options: AgentContextTurnSlotOptions): Promise<AgentContextTurnSlot> {
  const ticket = Symbol(sessionKey), now = options.now ?? Date.now, sleep = options.sleep ?? defaultSleep;
  let queue = queues.get(sessionKey);
  if (!queue) queues.set(sessionKey, queue = []);
  queue.push(ticket);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const line = queues.get(sessionKey);
    if (line) { const at = line.indexOf(ticket); if (at >= 0) line.splice(at, 1); if (!line.length) queues.delete(sessionKey); }
    wakeAll(sessionKey);
  };
  let waited = false;
  try {
    const started = now(), limit = options.maxWaitMs ?? TURN_WAIT_MAX_MS;
    let delay = POLL_FIRST_MS;
    for (;;) {
      options.signal?.throwIfAborted();
      if (queue[0] === ticket && !options.blocked()) return { waited, timedOut: false, release };
      if (!waited) { waited = true; options.onWait?.(); }
      if (now() - started >= limit) return { waited, timedOut: true, release };
      let wake!: () => void;
      const woken = new Promise<void>(resolve => { wake = resolve; });
      const set = wakeups.get(sessionKey) ?? new Set<() => void>();
      set.add(wake); wakeups.set(sessionKey, set);
      try { await sleep(delay, options.signal, woken); }
      finally { set.delete(wake); if (!set.size && wakeups.get(sessionKey) === set) wakeups.delete(sessionKey); }
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
  } catch (error) {
    release();
    throw error;
  }
}

/** Test and diagnostics only: how many turns of this process wait for, or hold, each session. */
export function agentContextTurnLines(): Array<{ sessionKey: string; length: number }> {
  return [...queues].map(([sessionKey, line]) => ({ sessionKey, length: line.length }));
}
