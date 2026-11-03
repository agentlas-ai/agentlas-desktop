/** Activity signal the Cloud host sends with each renewal (`activity: { lastActivityAt, busy }`).
 *
 * The web server extends the sandbox timeout only while `busy` is true or `lastActivityAt` is recent. Without
 * that, a sandbox is kept alive by the renewal itself and never idles to a pause.
 *
 *  - busy: a model run or tool child is live, or a One review/check-in is queued or about to fire.
 *  - lastActivityAt: the latest of the phone's last state-changing request (message, approval, control) and the last
 *    time the host was busy; 0 when neither has happened. Starting the host is NOT activity: a computer that nobody
 *    uses idles out by the server's rule instead of being counted as used for the first minutes.
 *
 * An error while reading an input counts as busy: a broken probe keeps the computer up (the behaviour before this
 * signal existed) rather than pausing it in the middle of an answer. */
export interface ManagedOneActivity { lastActivityAt: number; busy: boolean }
export interface ManagedOneActivityInputs {
  now(): number;
  /** Epoch ms of the phone's last state-changing request, or 0. Polling reads and keepalives do not count. */
  phoneActivityAt(): number;
  /** Live model runs plus live tool child processes. */
  liveWork(): number;
  /** True while a One check-in is due within `lookaheadMs` or its review is queued or running. */
  scheduledWork(lookaheadMs: number): boolean;
}
export const MANAGED_ONE_SCHEDULE_LOOKAHEAD_MS = 2 * 60_000;

export function createManagedOneActivityMonitor(inputs: ManagedOneActivityInputs): { sample(): ManagedOneActivity } {
  let lastBusyAt = 0;
  return {
    sample(): ManagedOneActivity {
      const now = inputs.now();
      let busy: boolean;
      try { busy = inputs.liveWork() > 0 || inputs.scheduledWork(MANAGED_ONE_SCHEDULE_LOOKAHEAD_MS); }
      catch { busy = true; }
      if (busy) lastBusyAt = now;
      let phone = 0;
      try { phone = inputs.phoneActivityAt(); } catch { phone = now; }
      const lastActivityAt = Math.min(now, Math.max(lastBusyAt, Number.isFinite(phone) ? phone : 0));
      return { lastActivityAt, busy };
    },
  };
}

/** A check-in or review older than this no longer counts: a held or stuck row must not keep a computer awake forever. */
export const MANAGED_ONE_SCHEDULE_STALE_MS = 15 * 60_000;
/** `scheduledWork` against the One supervisor tables: a check-in due within the lookahead (or overdue by less than the
 * stale window), or a notice created within the stale window whose review is pending or claimed. */
export function oneScheduledWork(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, now: number, lookaheadMs: number): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_supervisor_checkins'").get()) return false;
  if (db.prepare("SELECT 1 FROM one_supervisor_checkins WHERE active=1 AND next_at<=? AND next_at>? LIMIT 1").get(now + lookaheadMs, now - MANAGED_ONE_SCHEDULE_STALE_MS)) return true;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_supervisor_notices'").get()) return false;
  return !!db.prepare("SELECT 1 FROM one_supervisor_notices WHERE review_state IN ('pending','claimed') AND created_at>=? LIMIT 1").get(new Date(now - MANAGED_ONE_SCHEDULE_STALE_MS).toISOString());
}

/** The server extends the sandbox timeout while the computer was used in the last 5 minutes (same window as its idle pause). */
export const MANAGED_ONE_ACTIVITY_WINDOW_MS = 5 * 60_000;
export const MANAGED_ONE_ACTIVITY_PUSH_MS = 60_000;
export const MANAGED_ONE_TOKEN_RENEW_MARGIN_MS = 2 * 60_000;
/** Whether the 30 second host tick should call the server now: always when the token is near expiry, otherwise only while
 * the computer is in use and at most once per push interval. An idle computer stays silent, so its sandbox timeout runs out. */
export function shouldPushManagedOneRenewal(input: { now: number; expiresAt: number; lastRenewalAt: number; activity: ManagedOneActivity }): boolean {
  if (input.expiresAt - input.now <= MANAGED_ONE_TOKEN_RENEW_MARGIN_MS) return true;
  const inUse = input.activity.busy || input.now - input.activity.lastActivityAt < MANAGED_ONE_ACTIVITY_WINDOW_MS;
  return inUse && input.now - input.lastRenewalAt >= MANAGED_ONE_ACTIVITY_PUSH_MS;
}
/** More than the renewal margin of token left: the call reports activity only and the server keeps our credentials (credentials: null). */
export function isManagedOneActivityOnlyRenewal(now: number, expiresAt: number): boolean {
  return expiresAt - now > MANAGED_ONE_TOKEN_RENEW_MARGIN_MS;
}
