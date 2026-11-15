// A turn's run slot, lent out while a person decides.
//
// A turn that shows an approval card or a question and then waits for the owner used to keep its run slot for the whole wait
// (up to 5 minutes a card): with every slot held by turns waiting for a person, nothing else could start. The run wrapper
// (selection.ts withRunSlot / withLocalInferenceSlot) now makes one lease per turn; the code that really waits for a person
// (tool-approval.ts requestToolApproval, confirm/ask-user.ts askUser, browser/connect.ts browserRequestApproval) wraps that
// wait in `waitingForPerson`, which lets the slot go before the card is shown and takes one again, in the original queue
// lane, once the answer is in. A wait that is answered from a saved rule never reaches the wrapper, so an ordinary turn does
// not touch its slot at all.
//
// Zero dependencies on purpose (run-priority.ts rule): selection, tool-approval, ask-user, the MCP proxy and the browser
// approval server all import it (its only import is node:async_hooks, like run-priority.ts).
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

export interface SlotLease {
  /** A person is now deciding: let the slot go if this turn holds one. */
  pause(): void;
  /** The decision is in: hold a slot again (queued in the turn's own lane). Never rejects. */
  resume(): Promise<void>;
}

/**
 * How many turns of one slot pool may have let their slot go at this moment. A turn that lets its slot go still has its CLI process
 * (it waits for the person's answer), so without a bound the live processes were "slots + every turn waiting for a person" (
 * #6: 737 turns live on 1 slot in a fuzz; a night of automation turns each asking for approval could pile up dozens of CLIs). With it
 * the live processes are at most the slots held plus this many: twice the limit (and the owner's one reserved slot, run-slots.ts).
 */
export interface LendBudget { tryLend(): boolean; giveBack(): void }
export function createLendBudget(limit: () => number): LendBudget {
  let lent = 0;
  return {
    tryLend: () => { if (lent >= Math.max(1, limit())) return false; lent += 1; return true; },
    giveBack: () => { if (lent > 0) lent -= 1; },
  };
}

const scope = new AsyncLocalStorage<SlotLease>();
// The turn's abort signal, and every signal made for one of its calls (a child of it, the MCP proxy's per-call signal, the browser
// sheet's signal), name its lease. A resident connection's callback runs in another turn's async context, so where an ask carries a
// signal the signal is the only key; the async scope serves an ask with no signal at all.
const bySignal = new WeakMap<AbortSignal, SlotLease>();

/**
 * One lease for a turn that already holds `initial`. `reacquire` queues for a new slot (it rejects when the turn is aborted).
 * `close()` is the turn's end: it gives back whatever is held now and makes any slot still being waited for go back at once.
 * The bookkeeping holds one fact only - whether this turn holds a slot - so a slot can be released or taken once per
 * hold: no double release, no double take.
 */
export function createSlotLease(initial: () => void, reacquire: () => Promise<() => void>, budget?: LendBudget): SlotLease & { close(): void } {
  // The retake runs later, from wherever the answer arrives: it keeps the async context of the turn that made the lease
  // (its lead-room queue report, its priority).
  const retake = AsyncResource.bind(reacquire);
  let held = true;
  let giveBack: () => void = initial;
  let closed = false;
  let queued: Promise<void> | null = null;
  /** This lease's slot is lent out now and counted in the pool's budget; it is counted back once, when a slot is held again or the turn ends. */
  let lent = false;
  const countBack = (): void => { if (!lent) return; lent = false; budget?.giveBack(); };
  const letGo = (): void => {
    if (!held) return;
    held = false;
    const release = giveBack;
    giveBack = () => undefined;
    release();
  };
  const take = (): Promise<void> => {
    if (held || closed) return Promise.resolve();
    queued ??= retake().then((release) => {
      queued = null;
      if (closed) { release(); return; }
      held = true;
      giveBack = release;
      countBack();
    }, (error) => { queued = null; throw error; });
    return queued;
  };
  return {
    // A pool whose lent turns have reached its limit lets no more go: the turn keeps its slot through this wait, as before N0b.
    pause: () => {
      if (!held) return;
      if (budget && !budget.tryLend()) return;
      lent = budget !== undefined;
      letGo();
    },
    resume: async () => {
      // A turn that was stopped while it waited is not given a slot back: it only has to end.
      try { await take(); } catch { /* an aborted wait for a slot is the turn ending, not a failure of the answer */ }
    },
    close: () => { closed = true; letGo(); countBack(); },
  };
}

/** Runs `fn` with `lease` as the current turn's lease (the async scope), and names it under the turn's signal. */
export function runWithSlotLease<T>(lease: SlotLease, signal: AbortSignal | undefined, fn: () => T): T {
  if (signal) bySignal.set(signal, lease);
  return scope.run(lease, fn);
}

export function currentSlotLease(): SlotLease | undefined { return scope.getStore(); }

/** A signal made for one call of a turn (the MCP proxy's per-call signal, the browser sheet's) names that turn's lease. */
export function registerSlotLeaseSignal(signal: AbortSignal, lease: SlotLease | undefined): void {
  if (lease && !bySignal.has(signal)) bySignal.set(signal, lease);
}

/**
 * Lets the slot go while `wait` (a card or question a person answers) is pending, and takes one again before the answer is
 * returned. Settling is unconditional: whatever `wait` does, the lease resumes exactly once. `signals` is the asking call's signal
 * and its ancestors (nearest first): the first one that names a lease is the turn's. An ask with no signal uses the async scope.
 * A call outside any turn that holds a slot (an API run, a terminal command) returns `wait` unchanged.
 */
export function waitingForPerson<T>(wait: Promise<T>, signals?: AbortSignal | readonly (AbortSignal | undefined)[]): Promise<T> {
  const list = signals === undefined ? [] : Array.isArray(signals) ? signals : [signals as AbortSignal];
  let lease: SlotLease | undefined;
  let signalled = false;
  for (const signal of list) {
    if (!signal) continue;
    signalled = true;
    lease = bySignal.get(signal);
    if (lease) break;
  }
  if (!signalled) lease = scope.getStore();
  if (!lease) return wait;
  lease.pause();
  return wait.then(
    async (value) => { await lease.resume(); return value; },
    async (error) => { await lease.resume(); throw error; },
  );
}
