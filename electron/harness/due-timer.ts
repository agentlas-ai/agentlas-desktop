/**
 * The Agentlas Harness' one timer (Agentlas 2.0 N3c, decision; docs/Agentlas2.0/audit/39-design-n-agentlas-harness.md section 11).
 *
 * One-shot, aimed at the earliest time any registered source says it owes a look, never a period. A source answers two questions and
 * nothing else: when is my next look (nextAt: a number or null) and do that look (run). With nothing owed anywhere there is NO timer
 * at all: a resting app fires nothing and writes nothing. With something owed far away the aim is capped at 24 h (a setTimeout past
 * 2^31 ms fires at once, the 24.8-day overflow of defect 7), so a look 40 days away costs one empty wake-up a day, which only
 * aims again.
 *
 * What moves the aim: a source's own write (aim, from the change bus), the app starting (start: every source looks once), the machine
 * waking from sleep or the wall clock jumping (wake: every source looks once; Main hears powerMonitor "resume", the background service
 * sees its 0.5 s heartbeat skip - beat). A fire of the timer itself re-reads every source's nextAt, so a clock that went backwards (the
 * fire is early) or forwards (the fire is late) is the same answer: sources whose time has passed run once, the rest aim again.
 *
 * A source whose time has passed but whose run did not advance it (a look that found the room busy) is held for holdMs before it is
 * asked again, so a line that cannot be taken is a bounded retry, never a spin. The timer itself calls no model and writes nothing.
 */
export const DUE_TIMER_MAX_MS = 24 * 60 * 60_000;
/** A heartbeat that arrives this much later than its own period means the machine slept or the wall clock jumped. */
export const DUE_CLOCK_JUMP_MS = 5_000;
const DUE_FULL_LOOK_DEDUPE_MS = 10_000;

export type DueWhy = "due" | "start" | "wake" | "signal";

export interface DueSource {
  name: string;
  /** Epoch ms of the next look this source owes, or null. Cheap (one indexed read); called on every aim. */
  nextAt(): number | null;
  /** Does the look. Errors are caught by the timer. `due` is true when the source's own time passed. */
  run(why: DueWhy): void | Promise<void>;
  /** After a run that left nextAt() in the past, wait this long before asking again (default 30 s). */
  holdMs?: number;
}

export interface DueTimerPorts {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (source: string, error: unknown) => void;
}

export interface DueTimer {
  /** Re-read every source and aim the one timer. Cheap; nothing armed when no source owes a look. */
  aim(): void;
  /** The app just started: every source looks once (catching up what a signal missed while the app was closed). */
  start(): Promise<void>;
  /** The machine woke or the clock jumped: every source looks once (a look is idempotent), then the aim is renewed. */
  wake(why?: "resume" | "clock_jump"): Promise<void>;
  /** The 0.5 s heartbeat of a process that has one: a gap far beyond its period is a wake. */
  beat(): void;
  stop(): void;
  /** Test and audit seams. */
  armedFor(): number | null;
  stats(): { fires: number; runs: number; wakes: number };
}

export function createDueTimer(sources: readonly DueSource[], ports: DueTimerPorts = {}): DueTimer {
  const now = ports.now ?? Date.now;
  const setTimer = ports.setTimer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; });
  const clearTimer = ports.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const onError = ports.onError ?? ((source, error) => console.warn(`[due-timer] ${source} failed:`, error instanceof Error ? error.message : error));
  const heldUntil = new Map<string, number>();
  const counters = { fires: 0, runs: 0, wakes: 0 };
  let handle: unknown = null, armedAt: number | null = null, stopped = false, running = false, runAgain = false, lastBeat = now();
  let lastFullLook = Number.NEGATIVE_INFINITY;

  const next = (source: DueSource): number | null => {
    let at: number | null = null;
    try { at = source.nextAt(); } catch (error) { onError(source.name, error); return null; }
    if (at === null || !Number.isFinite(at)) return null;
    const held = heldUntil.get(source.name) ?? 0;
    return Math.max(at, held);
  };

  const aim = (): void => {
    if (stopped) return;
    let soonest: number | null = null;
    for (const source of sources) {
      const at = next(source);
      if (at !== null && (soonest === null || at < soonest)) soonest = at;
    }
    if (soonest === null) { // nothing owed anywhere: no timer exists
      if (handle !== null) { clearTimer(handle); handle = null; armedAt = null; }
      return;
    }
    const target = Math.min(soonest, now() + DUE_TIMER_MAX_MS);
    // An armed timer that fires no later than the target is kept: its fire re-reads everything and aims again.
    if (handle !== null && armedAt !== null && armedAt <= target) return;
    if (handle !== null) clearTimer(handle);
    armedAt = target;
    handle = setTimer(() => { handle = null; armedAt = null; counters.fires += 1; void fire("due"); },
      Math.max(0, Math.min(DUE_TIMER_MAX_MS, target - now())));
  };

  const runSource = async (source: DueSource, why: DueWhy): Promise<void> => {
    counters.runs += 1;
    try { await source.run(why); } catch (error) { onError(source.name, error); }
    // A look that left its own time in the past is held, never re-run in a loop.
    let still: number | null = null;
    try { still = source.nextAt(); } catch { still = null; }
    if (still !== null && still <= now()) heldUntil.set(source.name, now() + (source.holdMs ?? 30_000));
    else heldUntil.delete(source.name);
  };

  async function fire(why: DueWhy, wantEverySource = false): Promise<void> {
    if (stopped) return;
    if (running) { runAgain = true; return; }
    // Two wake signals in a row (the lid opened, then the screen unlocked, then the heartbeat saw the gap) are one wake: a second full
    // look within 10 s asks only the sources whose time has passed.
    let everySource = wantEverySource && now() - lastFullLook > DUE_FULL_LOOK_DEDUPE_MS;
    if (everySource) lastFullLook = now();
    running = true;
    try {
      do {
        runAgain = false;
        const at = now(), allThisPass = everySource;
        everySource = false; // a signal that arrived while this pass ran asks only the sources whose time has passed
        for (const source of sources) {
          if (stopped) return;
          const due = next(source);
          if (allThisPass || (due !== null && due <= at)) await runSource(source, allThisPass ? why : "due");
        }
      } while (runAgain && !stopped);
    } finally { running = false; aim(); }
  }

  return {
    aim,
    start: () => fire("start", true),
    wake: async (why) => { counters.wakes += 1; void why; await fire("wake", true); },
    beat: () => {
      const at = now(), gap = at - lastBeat;
      lastBeat = at;
      // A forward jump (sleep, clock set ahead) or a backward one: either way the timer's own clock no longer says when the look is due.
      if (gap > DUE_CLOCK_JUMP_MS || gap < -DUE_CLOCK_JUMP_MS) { counters.wakes += 1; void fire("wake", true); }
    },
    stop: () => { stopped = true; if (handle !== null) clearTimer(handle); handle = null; armedAt = null; },
    armedFor: () => armedAt,
    stats: () => ({ ...counters }),
  };
}
