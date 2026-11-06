/*
 * A graph agent step whose room is busy with another run waits for the room instead of failing.
 *
 * Since 2026-10-17 the YouTube room carries two owner-made daily producers: the daily graph (cdf732ca, its steps run in the
 * room) and the owner's /goal Goal (09:32Z, its turns run in the same room and the sweep resumes it between turns). A step
 * claims the room's run ownership before its work unit begins (run-graph.ts), so a step that found a Goal turn running was
 * refused invocation_chat_owned_by_other_run and the step failed: the night's run ended at step 1 with "the room is busy".
 * An owner message to a busy room waits in the send queue (renderer-send-queue.ts); a graph step now waits the same way,
 * polling the claim. While it waits the node's deadline is held (graphRoomWaitHold, read by the node timer and the run
 * watchdog like graphTeamStepHold): waiting for a room is not a stalled node.
 *
 * There is no time limit. A holder that is alive keeps the room however long its turn takes; a holder that died is taken over
 * by claimInvocationRunOwner itself (store/invocation-run-owners.ts), so the next poll's claim succeeds and no clock decides it.
 * Polling costs one local claim per tick and no model call: every 15 s at first, every 60 s once the wait passed 10 minutes.
 * After ROOM_WAIT_LONG_MS one `waiting_long` fact is reported (the wait goes on). Another occurrence of the same automation
 * cannot join the wait: the scheduler admits one run per automation (running set + claimAutomationRun lease).
 */

/** The refusals that mean "another run holds this room right now" (store/invocation-run-owners.ts). */
const ROOM_BUSY_CODES = new Set(["invocation_chat_owned_by_other_run", "invocation_chat_busy_other_host"]);
/** After this long a wait is reported once as `waiting_long`; it is a fact for the run history, not a limit. */
export const ROOM_WAIT_LONG_MS = 3 * 60 * 60_000;
export const ROOM_WAIT_POLL_MS = 15_000;
/** Past this wait the poll slows down: a turn that long is not about to end within seconds. */
export const ROOM_WAIT_SLOW_AFTER_MS = 10 * 60_000;
export const ROOM_WAIT_SLOW_POLL_MS = 60_000;

const holds = new Map<string, number>();
const holdKey = (runId: string, nodeId: string): string => `${runId}\u0000${nodeId}`;

/** Until when the node's deadline must not cut it because it is waiting for its room; null when it is not waiting. */
export function graphRoomWaitHold(runId: string, nodeId: string): number | null {
  return holds.get(holdKey(runId, nodeId)) ?? null;
}

function busyCode(error: unknown): string | null {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && ROOM_BUSY_CODES.has(code) ? code : null;
}

export async function claimRoomWhenFree<T>(input: {
  runId: string;
  nodeId: string;
  claim: () => T;
  signal: AbortSignal;
  /** Once, when the step starts waiting; once at ROOM_WAIT_LONG_MS; once more when it gets the room or the owner stops it. */
  onWait?: (event: { phase: "waiting" | "waiting_long" | "claimed" | "gave-up"; code: string; waitedMs: number }) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Test override: a fixed poll interval. */
  pollMs?: number;
  longWaitMs?: number;
}): Promise<T> {
  const now = input.now ?? Date.now;
  const longWaitMs = input.longWaitMs ?? ROOM_WAIT_LONG_MS;
  const sleep = input.sleep ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = (): void => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", stop, { once: true });
  }));
  const key = holdKey(input.runId, input.nodeId);
  const startedAt = now();
  let waitingCode: string | null = null;
  let reportedLong = false;
  try {
    for (;;) {
      try {
        const lease = input.claim();
        if (waitingCode) input.onWait?.({ phase: "claimed", code: waitingCode, waitedMs: now() - startedAt });
        return lease;
      } catch (error) {
        const code = busyCode(error);
        if (!code || input.signal.aborted) {
          // Only an owner stop ends the wait; the clock never does.
          if (code && waitingCode) input.onWait?.({ phase: "gave-up", code, waitedMs: now() - startedAt });
          throw error;
        }
        const waitedMs = now() - startedAt;
        if (!waitingCode) input.onWait?.({ phase: "waiting", code, waitedMs: 0 });
        else if (!reportedLong && waitedMs >= longWaitMs) {
          reportedLong = true;
          input.onWait?.({ phase: "waiting_long", code, waitedMs });
        }
        waitingCode = code;
        const pollMs = input.pollMs ?? (waitedMs >= ROOM_WAIT_SLOW_AFTER_MS ? ROOM_WAIT_SLOW_POLL_MS : ROOM_WAIT_POLL_MS);
        holds.set(key, now() + pollMs * 4);
        await sleep(pollMs, input.signal);
      }
    }
  } finally {
    holds.delete(key);
  }
}
