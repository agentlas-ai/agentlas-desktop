// The scheduler shared by the unattended Main-process memory jobs (dreaming, the English migration, the learning proposer).
// It never polls; see createIdleJob.
import { AsyncResource } from "node:async_hooks";
import { powerMonitor } from "electron";
import { onDesktopStoreChange } from "../store/change-bus";
import { onceBackgroundRunCouldStart, runSlotsQuietForMs, runSlotStats } from "../runtime/run-slots";

export interface IdleJob {
  /** A signal: something this job reads may have changed. Looks at it shortly, whatever the timer was aimed at. */
  wake(): void;
  /** Subscribes to the signals and takes the start-up look after `firstLookMs`. */
  start(firstLookMs?: number): void;
  stop(): void;
}
/** Signals arrive in bursts (a run ends while the curator commits); they are merged into one look. */
const IDLE_JOB_DEBOUNCE_MS = 1_000;
/** Other processes' commits and this process's chat writes arrive in bursts too; one look after they settle (due() is a cheap read). */
const IDLE_JOB_STORE_SETTLE_MS = 30_000;
// Node timers overflow near 24.8 days; a longer wait is re-aimed when it fires.
const IDLE_JOB_MAX_TIMER_MS = 24 * 60 * 60_000;
// Nothing signals "the machine became idle", so a look is aimed at the moment the idle guard could pass. An owner who keeps
// working would otherwise be looked at every few minutes: each look that finds them busy again waits at least twice as long
// as the one before (up to eight looks, never longer than six hours apart), then the next signal starts over.
const IDLE_JOB_QUIET_TRIES = 8;
const IDLE_JOB_QUIET_FLOOR_CAP_MS = 6 * 60 * 60_000;
/** A pass that threw or changed nothing is repeated at 5 minutes (the dreaming spacing), 30 minutes and 2 hours, then left to the next signal. */
export const IDLE_JOB_FAILURE_WAITS_MS: readonly number[] = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

/**
 * The scheduler of the unattended Main-process jobs (dreaming, this migration, the learning proposer). It never polls:
 * a look happens at start, on a signal (wake(), a run slot freed, a chat or runtime change from any process, the machine
 * waking from sleep) or at a time the job named.
 *  - due(): a cheap read. null = nothing to do, so no timer is left; otherwise the earliest time (ms) a pass may start.
 *  - waitMs(): how long until the machine is quiet enough for a pass (0 = now). The look is then aimed at that moment,
 *    a bounded number of times per signal.
 *  - pass(): the work. true = stored state moved (due() is read again at once); false or a throw = nothing changed.
 * While a run holds or waits for a slot nothing is scheduled: the free slot is the signal.
 */
export function createIdleJob(job: {
  due(): number | null;
  waitMs(): number | Promise<number>;
  pass(): Promise<boolean>;
  /** Extra in-process signals; each takes the wake function and returns its unsubscribe. */
  signals?: ReadonlyArray<(wake: () => void) => () => void>;
  /** Called on every signal, for a job whose "something may have changed" is the signal itself. */
  onSignal?(): void;
}): IdleJob {
  let started = false, busy = false, again = false;
  let timer: NodeJS.Timeout | null = null, timerAt = 0;
  let quietTries = 0, failures = 0;
  let unsubscribe: Array<() => void> = [];
  // The context a look runs in. A signal reaches wake() from whoever emitted it (a run that just ended, a memory write inside a model call's scope), and the timer made there kept that
  // emitter's async context: the learning proposer's pass ran inside the first-run labels call's model-call scope, so its model call was written to the ledger as `first-run-labels`
  // (trial, repair 8 R2). Every look runs in the context this job was started in instead (a job's own start, never an emitter's).
  let lookContext: AsyncResource | null = null;
  const aim = (at: number): void => {
    if (!started) return;
    const wait = Math.max(0, Math.min(IDLE_JOB_MAX_TIMER_MS, at - Date.now()));
    const when = Date.now() + wait;
    if (timer) {
      if (timerAt <= when) return;
      clearTimeout(timer);
    }
    timerAt = when;
    const fire = (): void => { timer = null; void look(); };
    timer = setTimeout(lookContext ? lookContext.bind(fire) : fire, wait);
    timer.unref?.();
  };
  const failureWait = (): number | null => {
    const wait = IDLE_JOB_FAILURE_WAITS_MS[failures];
    failures += 1;
    return wait === undefined ? null : Date.now() + wait;
  };
  const wake = (): void => {
    if (!started) return;
    job.onSignal?.();
    quietTries = 0;
    failures = 0;
    if (busy) again = true;
    else aim(Date.now() + IDLE_JOB_DEBOUNCE_MS);
  };
  const onFreeSlot = (): void => {
    if (!started) return;
    // Renewed each time, so every run that ends is a signal. A slot freed during this job's own pass is usually its own
    // model call ending, and the end of the pass is read anyway.
    onceBackgroundRunCouldStart(onFreeSlot);
    if (!busy) wake();
  };
  const look = async (): Promise<void> => {
    if (!started) return;
    if (busy) { again = true; return; }
    busy = true;
    let next: number | null = null;
    try {
      const due = job.due();
      if (due === null) { /* Nothing to do: no timer until a signal. */ }
      else if (due > Date.now()) next = due;
      else {
        const slots = runSlotStats();
        if (slots.inUse > 0 || slots.queued > 0) onceBackgroundRunCouldStart(onFreeSlot);
        else {
          const wait = await job.waitMs();
          if (wait > 0) {
            if (quietTries < IDLE_JOB_QUIET_TRIES) {
              const floor = quietTries === 0 ? 0 : Math.min(IDLE_JOB_QUIET_FLOOR_CAP_MS, wait * 2 ** quietTries);
              next = Date.now() + Math.max(wait, floor);
              quietTries += 1;
            }
          } else if (await job.pass()) {
            quietTries = 0;
            failures = 0;
            next = Date.now();
          } else next = failureWait();
        }
      }
    } catch {
      next = failureWait();
    } finally {
      busy = false;
    }
    if (again) {
      // A signal arrived during the look: read again shortly instead of trusting what this look saw.
      again = false;
      aim(Date.now() + IDLE_JOB_DEBOUNCE_MS);
    } else if (next !== null) aim(next);
  };
  return {
    wake,
    start(firstLookMs = IDLE_JOB_DEBOUNCE_MS): void {
      if (started) return;
      started = true;
      lookContext = new AsyncResource("agentlas-idle-job");
      quietTries = 0;
      failures = 0;
      const stopBus = onDesktopStoreChange((change) => {
        if (change.entity !== "chat" && change.entity !== "runtime") return;
        job.onSignal?.();
        if (busy) { again = true; return; }
        // A run in this process frees its slot when it ends, and that wakes the job; nothing to do until then.
        const slots = runSlotStats();
        if (slots.inUse > 0 || slots.queued > 0) return;
        aim(Date.now() + IDLE_JOB_STORE_SETTLE_MS);
      });
      // A timer does not count the time the machine slept: read the due time again after it wakes.
      const onResume = (): void => wake();
      try { powerMonitor.on("resume", onResume); } catch { /* No power events here: the other signals remain. */ }
      unsubscribe = [stopBus, () => { try { powerMonitor.removeListener("resume", onResume); } catch { /* never attached */ } },
        ...(job.signals ?? []).map((subscribe) => subscribe(wake))];
      // The run slots keep one registration per function, so this stays a single listener however often it is renewed.
      onceBackgroundRunCouldStart(onFreeSlot);
      aim(Date.now() + Math.max(0, firstLookMs));
    },
    stop(): void {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const off of unsubscribe) { try { off(); } catch { /* already gone */ } }
      unsubscribe = [];
    },
  };
}

/** A job that has not finished a pass for this long while its work waits counts the app's own quiet as idle (see idleSecondsOrAppQuiet). */
export const IDLE_JOB_STARVED_AFTER_MS = 6 * 60 * 60_000;
/**
 * The idle seconds a background job reads (desktop 3, signal B3). System idle is the rule; but some machines never report idle (a remote-desktop tool or computer use keeps
 * "the user is active" asserted - measured, runtime/run-slots.ts runSlotsQuietForMs), and a job gated on it alone then never ran and, after eight looks, had no timer at all.
 * After IDLE_JOB_STARVED_AFTER_MS without a finished pass (`lastPassAt`, never earlier than this process's start) the seconds this app has had no run in a slot count as idle too -
 * the same substitute the English migration has always used. Every guard of the job (the wait, the pass, the mid-pass "owner came back" check) reads this one number, so a run that takes a
 * slot ends the quiet and aborts a pass exactly as a returning owner does.
 */
export function idleSecondsOrAppQuiet(systemIdleSeconds: number, lastPassAt: number, now = Date.now()): number {
  if (now - lastPassAt < IDLE_JOB_STARVED_AFTER_MS) return systemIdleSeconds;
  return Math.max(systemIdleSeconds, runSlotsQuietForMs(now) / 1000);
}
