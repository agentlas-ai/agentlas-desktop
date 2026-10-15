/**
 * One process's seat in the Alive domain (NH21). It holds the owner lease (domain-owner.ts) and runs the organism host
 * only while it holds it: acquire → build a fresh host for this ownership → start; fenced or handed over → stop.
 *
 * The watcher below beats no life and spends no model call: it only reads the one owner row. The organism clocks
 * belong to the host, and the host exists only in the owning process, so there is never a second clock for a life.
 * The window process hands over to a live service only at a quiescent point (no wake in flight); the service never
 * hands over to the window except by stopping (quit, idle exit, crash), and a dead owner is taken over at once.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { AliveDomainOwner, type AliveDomainLease, type AliveDomainOwnerKind } from "./domain-owner";

export interface AliveDomainHostHandle {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** No wake in flight and no beat running: a settlement cannot arrive after the handoff. */
  quiescent(): boolean;
}

export interface AliveDomainParticipantOptions {
  kind: AliveDomainOwnerKind;
  db: Database.Database;
  /** Build a host for this exact ownership (its fence is `holds(lease)`, its process start is the acquisition). */
  createHost(lease: AliveDomainLease, fence: () => boolean): AliveDomainHostHandle;
  owner?: AliveDomainOwner;
  epoch?: string;
  pid?: number;
  watchMs?: number;
  /** Main hands over only while it can still reach the service (its screens forward owner edits there). */
  canHandOver?(): boolean;
  onChange?(state: AliveDomainParticipantState): void;
  log?(line: string): void;
}

export type AliveDomainParticipantState =
  | { role: "owner"; kind: AliveDomainOwnerKind; generation: number }
  | { role: "standby"; holder: AliveDomainOwnerKind | null }
  | { role: "handing-over" }
  | { role: "stopped" };

export const ALIVE_DOMAIN_WATCH_MS = 2_000;

export function createAliveDomainParticipant(options: AliveDomainParticipantOptions) {
  const owner = options.owner ?? new AliveDomainOwner(options.db);
  const epoch = options.epoch ?? `${options.kind}-${randomUUID()}`;
  const pid = options.pid ?? process.pid;
  let lease: AliveDomainLease | null = null;
  let host: AliveDomainHostHandle | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let state: AliveDomainParticipantState = { role: "standby", holder: null };
  let waitingLogged = false;
  const set = (next: AliveDomainParticipantState) => {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    try { options.onChange?.(next); } catch { /* an observer cannot change ownership */ }
  };
  const stopHost = () => {
    const current = host;
    host = null;
    try { current?.stop(); } catch (error) { options.log?.(`[alive-domain] host stop failed: ${error instanceof Error ? error.message : String(error)}`); }
  };

  function tick(): void {
    if (stopped) return;
    try {
      if (lease) {
        if (!owner.holds(lease)) {
          // Only a release or this process's death ends a hold; reaching here means the row moved under us. Stop beating.
          stopHost(); lease = null;
          options.log?.("[alive-domain] ownership fenced; host stopped");
          set({ role: "standby", holder: owner.current()?.kind ?? null });
          return;
        }
        if (options.kind === "main" && owner.handoffRequested(lease) && (options.canHandOver?.() ?? true)) {
          if (!host || host.quiescent()) {
            set({ role: "handing-over" });
            stopHost();
            owner.release(lease); lease = null; waitingLogged = false;
            options.log?.("[alive-domain] handed over to the background service");
            set({ role: "standby", holder: "daemon" });
          } else if (!waitingLogged) {
            waitingLogged = true;
            options.log?.("[alive-domain] handoff requested; waiting for the wake in flight to settle");
          }
        }
        return;
      }
      const result = owner.acquire(options.kind, epoch, pid);
      if (result.state !== "acquired") { set({ role: "standby", holder: result.holder.kind }); return; }
      lease = result.lease;
      const held = lease;
      host = options.createHost(held, () => !stopped && lease === held && owner.holds(held));
      host.start();
      set({ role: "owner", kind: options.kind, generation: held.generation });
    } catch (error) {
      options.log?.(`[alive-domain] watch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    epoch,
    start(): void {
      if (stopped || timer) return;
      tick();
      timer = setInterval(tick, options.watchMs ?? ALIVE_DOMAIN_WATCH_MS);
      timer.unref?.();
    },
    /** Quit / service shutdown: stop the host first (it closes admission and its clocks), then release the lease. */
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      stopHost();
      if (lease) { try { owner.release(lease); } catch { /* the store may already be closing; a dead owner is taken over */ } }
      lease = null;
      set({ role: "stopped" });
    },
    tick,
    state(): AliveDomainParticipantState { return state; },
    lease(): AliveDomainLease | null { return lease; },
    owns(): boolean { return lease !== null && host !== null && host.isRunning() && owner.holds(lease); },
  };
}

export type AliveDomainParticipant = ReturnType<typeof createAliveDomainParticipant>;
