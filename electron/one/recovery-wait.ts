import { emitDesktopStoreChange } from "../store/change-bus";
import { onRuntimeSignal, runtimeSignalFloor } from "../runtime/runtime-signals";
import { registerIdleRetry, type IdleRetryHandle } from "../invocation/idle-retry";

/**
 * One's automatic recovery of a read-only run that kept failing in the same way ends the attempts of THAT situation, not the work.
 * The stop (shared/one-auto-recovery.ts oneRecoveryStopWaitsForChange) is kept here, in memory, until the situation changes: a runtime
 * signal (a sign-in, a detected runtime, a restored connection, a runtime that answered again; runtime/runtime-signals.ts) that comes
 * after the stop, at least RECOVERY_WAIT_SIGNAL_SPACING_MS later. Then the screen showing that chat is told once (store change
 * `one-recovery`, id = chat) and asks Main for the judgment again; Main counts only the attempts made since the signal
 * (desktop-recovery-admission.ts), so the budget of the new situation starts over.
 *
 * Nothing is stored: a restart drops the waits, and the screen asks for the judgment again when it shows the chat (the attempt count
 * reads the saved chain, and a new app version is a new situation). At most WAIT_CAP chats wait; the oldest is dropped first and is
 * judged again when its chat is shown. The waits ride the existing idle-retry helper: its timer exists only while a chat waits and
 * only reads the cross-process signal floor.
 */
export const RECOVERY_WAIT_SIGNAL_SPACING_MS = 5 * 60_000;
const WAIT_CAP = 64;

interface Waiting { runId: string; floor: number; armedAt: number }
const waits = new Map<string, Waiting>();
let handle: IdleRetryHandle | null = null;
let unsubscribe: (() => void) | null = null;

/** The wait for this chat is released once a signal newer than its stop has come and the spacing has passed. Pure. */
export function recoveryWaitReleasable(wait: { floor: number; armedAt: number }, signalFloor: number, now: number): boolean {
  return signalFloor > wait.floor && now - wait.armedAt >= RECOVERY_WAIT_SIGNAL_SPACING_MS;
}

function release(chatId: string): void {
  const wait = waits.get(chatId);
  if (!wait) return;
  let current = false;
  try {
    // Still the exact failed run of a room whose owner has not written since: otherwise nothing is left to continue.
    const admission = require("./desktop-recovery-admission") as typeof import("./desktop-recovery-admission");
    current = admission.desktopOneRecoveryScope(wait.runId, chatId) !== null;
  } catch { current = false; }
  if (!current) { waits.delete(chatId); return; }
  if (!recoveryWaitReleasable(wait, runtimeSignalFloor(), Date.now())) return;
  waits.delete(chatId);
  // The cached judgment of this chat would answer the screen's next ask with the old stop and block the new situation's judgment.
  forgetJudgment(chatId);
  emitDesktopStoreChange({ entity: "one-recovery", id: chatId });
}

function forgetJudgment(chatId: string): void {
  try { (require("./auto-recovery") as typeof import("./auto-recovery")).forgetOneRecoveryJudgment(chatId); } catch { /* the screen's next ask still reads the saved chain */ }
}

function ensureWatching(): void {
  if (handle) return;
  handle = registerIdleRetry({ name: "one-recovery-wait", pendingChats: () => [...waits.keys()], retry: release,
    fallbackMs: RECOVERY_WAIT_SIGNAL_SPACING_MS });
  unsubscribe = onRuntimeSignal(() => handle?.wakeAll());
}

/** A stop that waits for the situation to change. Idempotent for the same run; a newer run of the chat replaces the older wait. */
export function armOneRecoveryWait(input: { chatId: string; runId: string; now?: number }): void {
  if (!input.chatId || !input.runId) return;
  const now = input.now ?? Date.now();
  const same = waits.get(input.chatId)?.runId === input.runId;
  if (!same) {
    waits.delete(input.chatId);
    waits.set(input.chatId, { runId: input.runId, floor: runtimeSignalFloor(now), armedAt: now });
    while (waits.size > WAIT_CAP) {
      const oldest = waits.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      waits.delete(oldest);
      // A chat pushed out is not waiting any more: its screen forgets that it judged the run (no wake tick, no re-judgment storm), and the
      // next time the chat is shown it is judged again, which waits again.
      forgetJudgment(oldest);
      emitDesktopStoreChange({ entity: "one-recovery-dropped", id: oldest });
    }
  }
  ensureWatching();
  handle?.arm();
}

/** The chat is judged again, the owner spoke, or a retry started: nothing waits for it any more. */
export function clearOneRecoveryWait(chatId: string): void {
  waits.delete(chatId);
  handle?.arm();
}

/** Diagnostics and gates. */
export function oneRecoveryWaitingChats(): string[] { return [...waits.keys()]; }

/** Test only. */
export function resetOneRecoveryWaitsForTest(): void {
  waits.clear();
  handle?.dispose(); handle = null;
  unsubscribe?.(); unsubscribe = null;
}
