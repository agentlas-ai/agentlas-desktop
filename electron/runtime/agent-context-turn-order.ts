// Turns on one shared session run one after the other, in the order they arrived.
//
// Several conversations of a seat's agent use one journal and one native session (session-scope.ts). A second turn on that
// session used to be refused while the first ran (agent_context_delivery_busy, agent_context_prior_turn_unsettled), which
// is a dead end for an owner who simply typed in another conversation. This waits instead: first for the turns that arrived
// earlier, in this process and in the other one (a durable line in the database taken AT ARRIVAL: agent-context-turn-line.ts),
// then for a turn that holds the journal without a place in that line (the journal's open delivery and its run owner are the
// truth for an older build).
//
// The wait never lasts for ever and never ends in a bare code. It stops with a typed refusal (AgentContextTurnWaitError) when
//   - the turn ahead is parked: it waits for a person (a tool approval, a question), which nothing in the waiting
//     conversation can answer, so the caller says so at once and names what to do,
//   - the turn ahead died (its process is gone) and its run lease stays open longer than a restart needs to release it, or
//   - the wait reached its limit while the turn ahead was still running.
// The product caller (agent-context-admission.ts) passes onParked and waitPastLimit (no-dead-end sweep 2026-10-25): a parked or
// long turn ahead is then waited for with its reason on screen, and only a dead holder still ends the wait.
// The caller turns each into a plain sentence in the owner's language. No Electron import: the background service loads this
// file too.
import type { TurnLineHandle, TurnLineSnapshot } from "./agent-context-turn-line";

export const TURN_WAIT_MAX_MS = 20 * 60 * 1000;
/** A holder must have been parked this long before a waiter gives up on it (an approval that is answered within seconds is not a stop). */
export const TURN_PARK_GRACE_MS = 3_000;
/** A dead holder's open run lease is released by the next start of its kind of process (seconds); longer than this needs the owner. */
export const TURN_STUCK_GRACE_MS = 60_000;
const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 2_000;

export type AgentContextTurnWaitReason = "parked" | "stuck" | "expired";
export class AgentContextTurnWaitError extends Error {
  readonly code: string;
  readonly turnDelivery = "not-dispatched" as const;
  constructor(readonly reason: AgentContextTurnWaitReason, readonly parkedOn: string | null = null) {
    const code = reason === "parked" ? "agent_context_turn_parked" : reason === "stuck" ? "agent_context_turn_holder_stuck" : "agent_context_turn_wait_expired";
    super(code);
    this.name = "AgentContextTurnWaitError";
    this.code = code;
  }
}

export interface AgentContextTurnSlot {
  /** The turn waited for another one. */
  readonly waited: boolean;
  release(): void;
}
export interface AgentContextTurnSlotOptions {
  signal?: AbortSignal;
  /** True while a turn of ANOTHER conversation holds the session without a place in the line (the journal's open delivery, its run live). */
  blocked(): boolean;
  /** The chat and run of that turn, for telling a holder that died from one that is only slow. Read only while `blocked()` is true. */
  blockedTurn?(): { chatId: string; runId: string } | null;
  /** Takes this turn's place in the durable line at arrival; absent: the line of this process only. */
  line?(): TurnLineHandle;
  /** A native writer shared with another host must not fall back to a process-local line on store failure. */
  requireDurableLine?: boolean;
  /** Called once, when the turn starts to wait. */
  onWait?(): void;
  /**
   * When given, a turn ahead that waits for a person does not end this wait: this is called (once per kind) and the turn
   * keeps its place until the owner answers or stops there (no-dead-end sweep 2026-10-25: refusing it ended the owner's
   * message with "send again"). Without it the old refusal ("parked") stands.
   */
  onParked?(kind: string | null): void;
  /** True: the wait limit does not end the wait (the turn ahead is still running; the owner can stop either). */
  waitPastLimit?: boolean;
  maxWaitMs?: number;
  parkGraceMs?: number;
  stuckGraceMs?: number;
  /** Test seams. */
  now?(): number;
  sleep?(ms: number, signal: AbortSignal | undefined, wake: Promise<void>): Promise<void>;
  onWarn?(message: string): void;
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
 * Take the session's place in line. Resolves when this turn is first in line (in this process and in the database) and no
 * older turn holds the session. The slot is held until `release()`; the caller releases it when the turn is over, whatever its
 * outcome. Rejects with an AgentContextTurnWaitError when the wait must end without the session (see the header), and with the
 * signal's reason when the turn is cancelled; the place is released then.
 */
export async function acquireAgentContextTurnSlot(sessionKey: string, options: AgentContextTurnSlotOptions): Promise<AgentContextTurnSlot> {
  const ticket = Symbol(sessionKey), now = options.now ?? Date.now, sleep = options.sleep ?? defaultSleep;
  const warn = options.onWarn ?? ((message: string) => console.warn(`[session-turn-order] ${message}`));
  let queue = queues.get(sessionKey);
  if (!queue) queues.set(sessionKey, queue = []);
  queue.push(ticket);
  let place: TurnLineHandle | null = null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try { place?.release(); } catch { /* a place that cannot be removed is skipped once this process ends */ }
    const line = queues.get(sessionKey);
    if (line) { const at = line.indexOf(ticket); if (at >= 0) line.splice(at, 1); if (!line.length) queues.delete(sessionKey); }
    wakeAll(sessionKey);
  };
  let waited = false;
  try {
    if (options.requireDurableLine && !options.line) throw new Error("native_writer_durable_line_required");
    // The durable place is taken at arrival, before anything else of this turn is prepared. A store that cannot give one
    // (busy, unreadable) leaves this turn on the line of its own process, as before the durable line existed.
    if (options.line) {
      try { place = options.line(); }
      catch (error) { if (options.requireDurableLine) throw error; place = null; warn(`no place in the durable line, this process's line only: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const started = now(), limit = options.maxWaitMs ?? TURN_WAIT_MAX_MS;
    const parkGrace = options.parkGraceMs ?? TURN_PARK_GRACE_MS, stuckGrace = options.stuckGraceMs ?? TURN_STUCK_GRACE_MS;
    let delay = POLL_FIRST_MS, stuckSince: number | null = null, parkedTold: string | null | undefined = undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      let snapshot: TurnLineSnapshot | null = null;
      if (place) {
        try { snapshot = place.poll(); }
        catch (error) { if (options.requireDurableLine) throw error; warn(`the durable line could not be read, this process's line only: ${error instanceof Error ? error.message : String(error)}`); try { place.release(); } catch { /* skipped once the process ends */ } place = null; }
      }
      const blocked = options.blocked();
      if (queue[0] === ticket && (!snapshot || snapshot.head) && !blocked) return { waited, release };
      // The turn ahead waits for a person: nothing here can answer that, and waiting for it is only a stall.
      const holder = snapshot?.holder;
      if (holder?.parked && now() - holder.parked.since >= parkGrace) {
        if (!options.onParked) throw new AgentContextTurnWaitError("parked", holder.parked.kind);
        const kind = holder.parked.kind ?? null;
        if (parkedTold !== kind) { parkedTold = kind; try { options.onParked(kind); } catch { /* a status line never ends the wait */ } }
      }
      // A holder that died and left its run lease open: the next start of its kind of process releases it; if that does not come, the owner must.
      const turn = blocked ? options.blockedTurn?.() ?? null : null;
      const diedHolder = !!turn && !!snapshot?.dead.some(item => item.turn.chatId === turn.chatId && item.turn.runId === turn.runId);
      if (diedHolder) { stuckSince ??= now(); if (now() - stuckSince >= stuckGrace) throw new AgentContextTurnWaitError("stuck"); } else stuckSince = null;
      if (!waited) { waited = true; options.onWait?.(); }
      if (now() - started >= limit && !options.waitPastLimit) throw new AgentContextTurnWaitError("expired");
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
