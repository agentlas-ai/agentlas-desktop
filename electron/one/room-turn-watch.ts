/*
 * The last-resort limit of one member turn in a lead room (fix, reworked after items 10 and 20b-6, and again in desktop values S2).
 * `timeoutMs` is not a number of this room: the caller passes the runner's own silence limit (invocation/outer-silence.ts), so the room
 * waits as long as the runner holds the turn alive, a tool call in flight included (it used to cut such a turn after its own 10 minutes
 * with no word). Counted as SILENCE: no real event for `timeoutMs`. Every event that is not a heartbeat starts the count again; a
 * heartbeat proves only that a process exists, it does not renew. The runner's own guard ends a silent turn first and says why.
 *
 * A turn whose run has VANISHED (the invocation service no longer knows the run and its settle signal never came: a zombie) is told by a
 * fact, not by time: `isLive` is asked every `livenessEveryMs` (the runner's own heartbeat period, so a live run has been heard from since
 * the last look) and two looks in a row that find no run end the turn (`onLost`). A run that waits for a slot is not asked. It does not run while the run WAITS for a slot (`queue_wait`: a run
 * slot, the local-inference pool, the room-member pool, and the tool-need judgement's slot, which reports through `setQueued`): it
 * starts when the run is let in. A card waiting on the owner expires on its own after 5 minutes, inside the 10.
 *
 * Pure (timers and the clock are injected), so a test drives it with a fake clock instead of waiting.
 */
export interface TurnWatch {
  /** The run was handed to the invocation service: the clocks start (they stop again if the run reports it is queued). */
  start(): void;
  /** Every invocation event of the run, by its machine-readable activity code (undefined for ordinary events). */
  event(activityCode: string | undefined): void;
  /** A queue signal from outside the event stream (the judgement's own slot wait): true = waiting, false = let in. */
  setQueued(queued: boolean): void;
  /** True between a queue wait and the first sign the run has been let in. */
  isQueued(): boolean;
  stop(): void;
}

/** The runner's heartbeat period (runtime/runner.ts startCliHeartbeat): between two looks a live run has reported at least once. */
export const LIVENESS_LOOK_MS = 60_000;

export function createTurnWatch(options: {
  timeoutMs: number; onTimeout: () => void; onQueuedChange?: (queued: boolean) => void;
  /** True while the invocation service still holds the run. Optional: without it only the silence limit applies. */
  isLive?: () => boolean; onLost?: () => void; livenessEveryMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown; clearTimer?: (handle: unknown) => void;
}): TurnWatch {
  const setTimer = options.setTimer ?? ((run, ms) => { const handle = setTimeout(run, ms); (handle as { unref?: () => void }).unref?.(); return handle; });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let lookHandle: unknown = null;
  let misses = 0;
  let queued = false;
  let stopped = false;
  let running = false;
  const clear = () => { if (handle !== null) { clearTimer(handle); handle = null; } };
  const clearLook = () => { if (lookHandle !== null) { clearTimer(lookHandle); lookHandle = null; } };
  const look = () => {
    clearLook();
    if (stopped || !running || !options.isLive) return;
    lookHandle = setTimer(() => {
      lookHandle = null;
      if (stopped) return;
      if (queued) { misses = 0; look(); return; }
      let live = true;
      try { live = options.isLive!(); } catch { live = true; } // a failing look says nothing
      misses = live ? 0 : misses + 1;
      if (misses >= 2) { stopped = true; clear(); try { options.onLost?.(); } catch { /* the caller ends the turn */ } return; }
      look();
    }, options.livenessEveryMs ?? LIVENESS_LOOK_MS);
  };
  const arm = () => { clear(); if (!stopped && running && !queued) handle = setTimer(() => { handle = null; if (!stopped) options.onTimeout(); }, options.timeoutMs); };
  const setQueuedState = (value: boolean) => {
    if (queued === value) return;
    queued = value;
    try { options.onQueuedChange?.(value); } catch { /* display only */ }
    if (value) clear(); else arm();
  };
  return {
    start() { if (stopped) return; running = true; arm(); look(); },
    event(code) {
      if (stopped) return;
      if (code === "queue_wait") { setQueuedState(true); return; }
      if (code === "runtime_wait") return; // a heartbeat is neither admission nor progress
      if (queued) { setQueuedState(false); return; }
      arm();
    },
    setQueued: setQueuedState,
    isQueued: () => queued,
    stop() { stopped = true; clear(); clearLook(); const was = queued; queued = false; if (was) { try { options.onQueuedChange?.(false); } catch { /* display only */ } } },
  };
}
