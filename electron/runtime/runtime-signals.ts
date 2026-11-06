/**
 * The facts that make a stopped request worth trying again, as one small signal channel.
 *
 * A request that stopped because a runtime could not take it (usage limit, sign-in, no connection) does not wait on a counter or
 * on the owner: it waits for the thing that was wrong to change. Four things say so:
 *  - "signed-in": a person signed in again or saved a key (forgetRuntimeSignIn);
 *  - "detected": a runtime that was not usable is usable now (runtime detection saw it come up);
 *  - "connection": the machine was offline and is online again;
 *  - "recovered": a runtime that was marked signed out answered a real request.
 * The time a provider stated for a limit to lift is not an event; waiters read it themselves (invocation/host-recovery.ts).
 *
 * A signal is a notification, never a decision: every waiter keeps its own guard that makes sure only one attempt starts. The
 * newest signal time is also kept in the one existing `meta` row below, so the other process of the same store (Desktop Main and
 * the background service) sees it without a second channel. Nothing is queued and nothing grows: a single timestamp.
 *
 * This file stays a leaf (no store import at load) so the cooldown module and runtime detection can use it.
 */
export type RuntimeSignalKind = "signed-in" | "detected" | "connection" | "recovered";
export interface RuntimeSignal { kind: RuntimeSignalKind; runtime?: string; at: number }

/** Written only here; read by the retry store and by waiting recoveries. One row, overwritten, never deleted. */
export const RUNTIME_SIGNAL_META_KEY = "runtime-signal:v1:floor";

const listeners = new Set<(signal: RuntimeSignal) => void>();
let lastAt = 0;
let lastKind: RuntimeSignalKind | null = null;
let storedFloor: { read: number; value: number } | null = null;
/** The persisted floor is re-read at most this often by a poller; an own emit is always visible at once. */
const STORED_FLOOR_TTL_MS = 2_000;

function database(): { prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown } } | null {
  try { return (require("../store/db") as typeof import("../store/db")).getDb() as never; } catch { return null; }
}

function writeFloor(at: number): void {
  try {
    database()?.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(excluded.value AS INTEGER) > CAST(meta.value AS INTEGER)")
      .run(RUNTIME_SIGNAL_META_KEY, String(at));
  } catch { /* the in-memory floor and the listeners still work; another process sees it at the next signal */ }
}

/** Something that was wrong with a runtime changed. Never throws. */
export function emitRuntimeSignal(kind: RuntimeSignalKind, runtime?: string, now = Date.now()): void {
  const at = Math.max(now, lastAt + 1);
  lastAt = at;
  lastKind = kind;
  storedFloor = null;
  writeFloor(at);
  const signal: RuntimeSignal = { kind, ...(runtime ? { runtime } : {}), at };
  for (const listener of [...listeners]) {
    try { listener(signal); } catch { /* a listener never stops the others */ }
  }
}

export function onRuntimeSignal(listener: (signal: RuntimeSignal) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The kind of the newest signal this process saw (null: none, or it came from the other process). */
export function lastRuntimeSignalKind(): RuntimeSignalKind | null { return lastKind; }

/** The newest signal time seen by this process or written by the other process of the store (0 when none). */
export function runtimeSignalFloor(now = Date.now()): number {
  if (!storedFloor || now - storedFloor.read >= STORED_FLOOR_TTL_MS) {
    let value = 0;
    try {
      const row = database()?.prepare("SELECT value FROM meta WHERE key=?").get(RUNTIME_SIGNAL_META_KEY) as { value?: unknown } | undefined;
      const parsed = Number(row?.value);
      if (Number.isSafeInteger(parsed) && parsed > 0) value = parsed;
    } catch { value = 0; }
    storedFloor = { read: now, value };
  }
  return Math.max(lastAt, storedFloor.value);
}

const CONNECTION_POLL_MS = 10_000;
let connectionWatchers = 0;
let connectionTimer: ReturnType<typeof setInterval> | null = null;
let wasOnline: boolean | null = null;

function netOnline(): boolean | null {
  try {
    const online = (require("electron") as { net?: { online?: unknown } }).net?.online;
    return typeof online === "boolean" ? online : null;
  } catch { return null; }
}

/**
 * Turns "the machine was offline and is online again" into a "connection" signal while at least one waiter needs it. The timer
 * exists only between the first watch and the last stop (nothing waits: no timer), and it reads one boolean. Without an Electron
 * `net` (a plain Node host) it does nothing and the waiter's own probe time covers the case.
 */
export function watchConnection(): () => void {
  connectionWatchers += 1;
  if (!connectionTimer && netOnline() !== null) {
    wasOnline = netOnline();
    connectionTimer = setInterval(() => {
      const online = netOnline();
      if (online === null) return;
      if (wasOnline === false && online) emitRuntimeSignal("connection");
      wasOnline = online;
    }, CONNECTION_POLL_MS);
    connectionTimer.unref?.();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    connectionWatchers = Math.max(0, connectionWatchers - 1);
    if (connectionWatchers === 0 && connectionTimer) { clearInterval(connectionTimer); connectionTimer = null; wasOnline = null; }
  };
}

/** Diagnostics and gates: is the connection poll running right now (nothing waiting means false). */
export function connectionWatchActive(): boolean { return connectionTimer !== null; }

/** Test only: forget listeners, the floor and the watch. */
export function resetRuntimeSignalsForTest(): void {
  listeners.clear(); lastAt = 0; lastKind = null; storedFloor = null;
  if (connectionTimer) clearInterval(connectionTimer);
  connectionTimer = null; connectionWatchers = 0; wasOnline = null;
}
