/**
 * One signal-driven retry helper for everything the host owes a chat (a teammate's report, a child session's result, a host
 * recovery turn): "tell the owner of this work again when the room can take it". It never gives up by count or by age. It
 * wakes a retry only on a state signal and notifies, it never decides: each retry keeps its own guard that makes sure only one
 * attempt is in flight (live chat, claim row, idempotency key).
 *
 * Signals: a run ended (onSettled), a chat left the active set (onActiveChats, diff against the previous set), a full
 * steer queue has room again (onSteerQueueCapacity), the signed-in account came back (onAuthRestored).
 * Fallback: Desktop Main and the background service are separate processes and cannot see each other's onSettled, so a timer
 * is the only path for a room that frees in the other process. It runs only while `pendingChats()` is not empty and is off
 * (no timer object at all) when nothing waits.
 */
export interface IdleRetrySignals {
  onSettled(listener: (envelope: { chatId: string }) => void | Promise<void>): () => void;
  onActiveChats?(listener: (chatIds: string[]) => void): () => void;
  onSteerQueueCapacity?(listener: (chatId: string) => void): () => void;
  /** The signed-in account is back (auth.onAuthSessionRestored). */
  onAuthRestored?(listener: () => void): () => void;
}

export interface IdleRetryOptions {
  name: string;
  /** Chats that have a waiting row right now. Cheap and read-only. */
  pendingChats(): string[];
  /** Try once more for this chat. Must be safe to call at any time (its own guard decides). */
  retry(chatId: string): void;
  fallbackMs: number;
}

export interface IdleRetryHandle {
  /** A waiting row was just written: make sure the fallback timer runs. */
  arm(): void;
  /** Run the retry for every pending chat now (a signal that names no chat). */
  wakeAll(): void;
  timerArmed(): boolean;
  dispose(): void;
}

interface Registration extends IdleRetryOptions { timer: ReturnType<typeof setTimeout> | null; queued: Set<string> }
const registrations = new Set<Registration>();
const boundServices = new WeakSet<object>();
let previousActive = new Set<string>();

function safePending(reg: Registration): string[] {
  try { return reg.pendingChats(); } catch { return []; }
}

function settleTimer(reg: Registration): void {
  const waiting = safePending(reg).length > 0;
  if (!waiting) { if (reg.timer) { clearTimeout(reg.timer); reg.timer = null; } return; }
  if (reg.timer) return;
  reg.timer = setTimeout(() => {
    reg.timer = null;
    for (const chatId of safePending(reg)) notify(reg, chatId);
    settleTimer(reg);
  }, reg.fallbackMs);
  reg.timer.unref?.();
}

function notify(reg: Registration, chatId: string): void {
  if (reg.queued.has(chatId)) return;
  reg.queued.add(chatId);
  queueMicrotask(() => {
    reg.queued.delete(chatId);
    if (!registrations.has(reg)) return;
    try { if (safePending(reg).includes(chatId)) reg.retry(chatId); }
    catch (error) { console.warn(`[idle-retry:${reg.name}] retry deferred:`, error instanceof Error ? error.message : error); }
    settleTimer(reg);
  });
}

function signalChat(chatId: string): void { for (const reg of [...registrations]) notify(reg, chatId); }
function signalAll(): void { for (const reg of [...registrations]) for (const chatId of safePending(reg)) notify(reg, chatId); }

export function registerIdleRetry(options: IdleRetryOptions): IdleRetryHandle {
  const reg: Registration = { ...options, timer: null, queued: new Set() };
  registrations.add(reg);
  settleTimer(reg);
  return {
    arm: () => settleTimer(reg),
    wakeAll: () => { for (const chatId of safePending(reg)) notify(reg, chatId); },
    timerArmed: () => reg.timer !== null,
    dispose: () => { if (reg.timer) clearTimeout(reg.timer); reg.timer = null; registrations.delete(reg); },
  };
}

/** Subscribes the shared signals once per service. Every module that registers a retry may call this; only the first call binds. */
export function bindIdleRetrySignals(signals: IdleRetrySignals): void {
  if (boundServices.has(signals)) return;
  boundServices.add(signals);
  signals.onSettled((envelope) => { signalChat(envelope.chatId); });
  signals.onActiveChats?.((chatIds) => {
    const now = new Set(chatIds);
    for (const chatId of previousActive) if (!now.has(chatId)) signalChat(chatId);
    previousActive = now;
  });
  signals.onSteerQueueCapacity?.((chatId) => signalChat(chatId));
  if (signals.onAuthRestored) signals.onAuthRestored(() => signalAll());
  else bindAuthRestoredOnce();
}

let authBound = false;
/** The account's own restore event, read lazily so a host without it (contract runs) still loads this file. */
function bindAuthRestoredOnce(): void {
  if (authBound) return;
  authBound = true;
  try { (require("../auth") as typeof import("../auth")).onAuthSessionRestored(() => signalAll()); } catch { /* the fallback timer still wakes */ }
}

/** The signed-in account is back: wake every waiting chat of every registration (called by a module that owns the auth hook). */
export function wakeAllIdleRetries(): void { signalAll(); }

/** Names of registrations whose fallback timer is on right now (diagnostics and gates: nothing waiting means an empty list). */
export function armedIdleRetries(): string[] { return [...registrations].filter((reg) => reg.timer !== null).map((reg) => reg.name); }
