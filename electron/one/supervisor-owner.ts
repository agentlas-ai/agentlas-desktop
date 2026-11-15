import { supervisorError } from "../../shared/one-supervisor";
import type Database from "better-sqlite3";
import type { SupervisorRuntimeOwner } from "../../shared/one-supervisor-runtime";

interface OwnerRow {
  one_id: string; owner_epoch: string; owner_kind: SupervisorRuntimeOwner["ownerKind"];
  owner_pid: number; generation: number; lease_until: number; phase: SupervisorRuntimeOwner["phase"];
}
export interface SupervisorOwnerOptions {
  ownerEpoch: string;
  ownerKind: SupervisorRuntimeOwner["ownerKind"];
  pid?: number;
  now?: () => number;
  leaseMs?: number;
  /** Only a conclusive false admits takeover. Unknown/EPERM is not death. */
  ownerAlive?: (pid: number) => boolean | null;
  /** Monotonic milliseconds (does not run during sleep). Injected by the gate. */
  monotonic?: () => number;
}

/** A pid that lives proves nothing alone: a copied profile names another app's pid, and after a reboot the number belongs to
 * some other program (Windows reuses pids fast). A live owner moves its lease (the work executor asserts every second and a
 * lease with less than half left is renewed), so a lease that is past its end and does not move for this long, seen by two
 * looks of one contender on a clock that stops during sleep, has no owner behind it. Fencing (assertToken) already refuses
 * the old identity once the row changes, so a frozen-but-alive owner cannot dispatch after the takeover. */
export const OWNER_STALE_OBSERVATION_MS = 10_000;
/** The daemon-holds-the-domain reading (Main's start): a lease past its end by more than the longest lease is not "held". */
export const OWNER_HELD_GRACE_MS = 120_000;
/** True when a row names a live holder: pid alive and the lease renewed within the longest lease plus the grace. */
export function ownerRowHeld(row: { owner_pid: number; lease_until: number; phase: string }, now: number, alive: (pid: number) => boolean | null): boolean {
  if (row.phase === "released" || alive(row.owner_pid) === false) return false;
  return row.lease_until > now - OWNER_HELD_GRACE_MS;
}

/** One scheduler per local store. Account switches fence the previous identity;
 * a lease timeout alone never authorizes a second process to dispatch effects. */
export class OneSupervisorOwner {
  private readonly now: () => number;
  private readonly pid: number;
  private readonly leaseMs: number;
  private readonly ownerAlive: (pid: number) => boolean | null;
  private readonly monotonic: () => number;
  /** The one expired lease this contender has looked at, and when (in memory only: nothing is stored). */
  private staleLook: { key: string; at: number } | null = null;
  constructor(private readonly db: Database.Database, private readonly options: SupervisorOwnerOptions) {
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.monotonic = options.monotonic ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.ownerAlive = options.ownerAlive ?? (pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException)?.code === "ESRCH" ? false : null; }
    });
    if (!options.ownerEpoch || options.ownerEpoch.length > 200 || !["desktop-main", "work-daemon"].includes(options.ownerKind)
      || !Number.isSafeInteger(this.pid) || this.pid < 1 || !Number.isSafeInteger(this.leaseMs) || this.leaseMs < 100 || this.leaseMs > 120_000) {
      throw supervisorError('supervisor_owner_options_invalid');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS one_supervisor_runtime_owner (
      slot TEXT PRIMARY KEY CHECK(slot='personal'), one_id TEXT NOT NULL,
      owner_epoch TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_pid INTEGER NOT NULL,
      generation INTEGER NOT NULL, lease_until INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('active','draining','released'))
    )`);
  }
  private row(): OwnerRow | null {
    return this.db.prepare("SELECT * FROM one_supervisor_runtime_owner WHERE slot='personal'").get() as OwnerRow | undefined ?? null;
  }
  private project(row: OwnerRow): SupervisorRuntimeOwner {
    return {oneId:row.one_id,ownerEpoch:row.owner_epoch,ownerKind:row.owner_kind,generation:row.generation,leaseUntil:row.lease_until,phase:row.phase};
  }
  current(): SupervisorRuntimeOwner | null { const row=this.row();return row ? this.project(row) : null; }
  assert(oneId: string, control = false): SupervisorRuntimeOwner {
    if (!oneId || oneId.length > 200) throw supervisorError('supervisor_owner_identity_invalid');
    // Read-only while this process still holds a fresh lease for the same identity. The work executor
    // asserts every second; renewing on each call committed a write per tick and kept the idle store busy
    // (perf MP-03). The lease is renewed once less than half of it remains; takeover still needs a dead pid.
    const seen=this.row();
    if (seen?.owner_epoch === this.options.ownerEpoch && seen.owner_pid === this.pid && seen.owner_kind === this.options.ownerKind
      && seen.one_id === oneId && (seen.phase === "active" || seen.phase === "draining" && control)
      && seen.lease_until - this.now() > this.leaseMs / 2) return this.project(seen);
    return this.db.transaction(() => {
      const row=this.row(), now=this.now();
      if (row?.owner_epoch === this.options.ownerEpoch && row.owner_pid === this.pid && row.owner_kind === this.options.ownerKind) {
        if (row.phase === "released" || row.phase === "draining" && !control) throw supervisorError('supervisor_owner_admission_closed');
        // A control command cannot silently acquire another signed-in identity.
        if (control && row.one_id !== oneId) throw supervisorError('supervisor_owner_identity_changed');
        this.db.prepare(`UPDATE one_supervisor_runtime_owner SET one_id=?,generation=generation+?,lease_until=?
          WHERE slot='personal' AND owner_epoch=? AND generation=?`)
          .run(oneId,row.one_id===oneId?0:1,now+this.leaseMs,this.options.ownerEpoch,row.generation);
      } else {
        if (row && row.phase !== "released" && this.ownerAlive(row.owner_pid) !== false) {
          const settled = this.staleOwnerSettled(row, now);
          if (!settled) throw Object.assign(supervisorError('supervisor_owner_unconfirmed'), { ownerKind: row.owner_kind, leaseExpired: row.lease_until <= now,
            retryAfterMs: row.lease_until <= now ? OWNER_STALE_OBSERVATION_MS : Math.max(1000, row.lease_until - now) });
          console.info("[one-supervisor] owner takeover", { reason: "stale_lease_unchanged", ownerKind: row.owner_kind, observedMs: settled });
        }
        this.db.prepare(`INSERT INTO one_supervisor_runtime_owner(slot,one_id,owner_epoch,owner_kind,owner_pid,generation,lease_until,phase)
          VALUES('personal',?,?,?,?,?,?,'active') ON CONFLICT(slot) DO UPDATE SET one_id=excluded.one_id,
          owner_epoch=excluded.owner_epoch,owner_kind=excluded.owner_kind,owner_pid=excluded.owner_pid,
          generation=excluded.generation,lease_until=excluded.lease_until,phase='active'`)
          .run(oneId,this.options.ownerEpoch,this.options.ownerKind,this.pid,(row?.generation ?? 0)+1,now+this.leaseMs);
      }
      return this.project(this.row()!);
    }).immediate();
  }
  /** The observed milliseconds when the row's lease is past its end and has not moved for the whole observation; else 0. */
  private staleOwnerSettled(row: OwnerRow, now: number): number {
    if (row.lease_until > now) { this.staleLook = null; return 0; }
    const key = `${row.owner_epoch}|${row.generation}|${row.lease_until}|${row.owner_pid}`, at = this.monotonic();
    if (this.staleLook?.key !== key) { this.staleLook = { key, at }; return 0; }
    const seen = at - this.staleLook.at;
    return seen >= OWNER_STALE_OBSERVATION_MS ? Math.max(1, seen) : 0;
  }
  assertToken(token: SupervisorRuntimeOwner, control = false): void {
    const row=this.row();
    if (!row || row.owner_epoch!==token.ownerEpoch || row.owner_kind!==token.ownerKind || row.one_id!==token.oneId
      || row.generation!==token.generation || row.lease_until<=this.now() || row.phase==='released' || row.phase==='draining'&&!control) {
      throw supervisorError('supervisor_owner_fenced');
    }
  }
  closeAdmission(): void {
    this.db.prepare("UPDATE one_supervisor_runtime_owner SET phase='draining' WHERE slot='personal' AND owner_epoch=? AND phase='active'")
      .run(this.options.ownerEpoch);
  }
  /** Caller must first prove that its native invocations and callbacks drained. */
  release(): void {
    this.db.prepare("UPDATE one_supervisor_runtime_owner SET phase='released',lease_until=0 WHERE slot='personal' AND owner_epoch=? AND phase='draining'")
      .run(this.options.ownerEpoch);
  }
}
