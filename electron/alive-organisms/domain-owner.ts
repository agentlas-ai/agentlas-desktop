/**
 * The One/Work Alive domain has one owner process (native-harness NH21; docs/2026-10-13-native-harness 10 §8 E4, 11 §7).
 *
 * Exactly one process runs the Alive clock, its store writes, wakes and action dispatch. The background service is
 * the preferred owner: it keeps the lives beating after the window closes and serves the phone. The window process
 * (Main) owns the domain only while no service holds it (development, no enrolled service, the service exited).
 *
 *   - A live owner is never displaced by age. A takeover needs the owner process to be gone (ESRCH) or its release.
 *   - A preferred service that finds a live window owner records a handoff request. The window releases at a quiescent
 *     point (no wake in flight), reserving the slot for that service, so a late settlement never lands on two owners
 *     and the window cannot grab the slot straight back.
 *   - Every hold is a (epoch, generation) lease; a host checks it before each beat.
 *
 * No electron import: the background service loads this module.
 */
import type Database from "better-sqlite3";

export type AliveDomainOwnerKind = "main" | "daemon";
export interface AliveDomainLease { readonly kind: AliveDomainOwnerKind; readonly epoch: string; readonly pid: number; readonly generation: number }
export interface AliveDomainHolder { kind: AliveDomainOwnerKind; pid: number; generation: number; phase: "active" | "handoff-requested" | "released" }
export type AliveDomainAcquire =
  | { state: "acquired"; lease: AliveDomainLease }
  /** The service asked the live window owner to hand over; it acquires once the window releases. */
  | { state: "requested"; holder: AliveDomainHolder }
  | { state: "held"; holder: AliveDomainHolder };

interface Row {
  owner_kind: AliveDomainOwnerKind; owner_epoch: string; owner_pid: number; generation: number;
  phase: "active" | "handoff-requested" | "released"; requested_epoch: string | null; requested_pid: number | null;
}

export function ensureAliveDomainOwnerSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS alive_domain_owner (
    slot TEXT PRIMARY KEY CHECK(slot='alive'),
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('main','daemon')),
    owner_epoch TEXT NOT NULL, owner_pid INTEGER NOT NULL, generation INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('active','handoff-requested','released')),
    requested_epoch TEXT, requested_pid INTEGER, updated_at_ms INTEGER NOT NULL)`);
}

/** kill(pid, 0): ESRCH is gone; EPERM is a live process of another user. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== "ESRCH"; }
}

const EPOCH = /^[A-Za-z0-9._:-]{8,128}$/;

export class AliveDomainOwner {
  private readonly alive: (pid: number) => boolean;
  private readonly now: () => number;

  constructor(private readonly db: Database.Database, options: { processAlive?(pid: number): boolean; now?(): number } = {}) {
    ensureAliveDomainOwnerSchema(db);
    this.alive = options.processAlive ?? processAlive;
    this.now = options.now ?? Date.now;
  }

  current(): (AliveDomainHolder & { epoch: string; requestedPid: number | null }) | null {
    const row = this.row();
    return row ? { kind: row.owner_kind, pid: row.owner_pid, generation: row.generation, phase: row.phase, epoch: row.owner_epoch,
      requestedPid: row.requested_pid } : null;
  }

  /** True while a live process other than `pid` holds (or has reserved) the domain. */
  heldElsewhere(pid: number = process.pid): AliveDomainHolder | null {
    const row = this.row();
    if (!row || row.owner_pid === pid) return null;
    if (row.phase === "released") {
      return row.requested_pid !== null && row.requested_pid !== pid && this.alive(row.requested_pid)
        ? { kind: "daemon", pid: row.requested_pid, generation: row.generation, phase: "released" } : null;
    }
    return this.alive(row.owner_pid) ? this.holder(row) : null;
  }

  acquire(kind: AliveDomainOwnerKind, epoch: string, pid: number = process.pid): AliveDomainAcquire {
    if (kind !== "main" && kind !== "daemon") throw new Error("alive_domain_owner_kind_invalid");
    if (!EPOCH.test(epoch) || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("alive_domain_owner_identity_invalid");
    return this.db.transaction((): AliveDomainAcquire => {
      const row = this.row();
      const nowMs = this.now();
      const take = (generation: number): AliveDomainAcquire => {
        this.db.prepare(`INSERT INTO alive_domain_owner(slot,owner_kind,owner_epoch,owner_pid,generation,phase,requested_epoch,requested_pid,updated_at_ms)
          VALUES ('alive',?,?,?,?,'active',NULL,NULL,?) ON CONFLICT(slot) DO UPDATE SET owner_kind=excluded.owner_kind,
          owner_epoch=excluded.owner_epoch,owner_pid=excluded.owner_pid,generation=excluded.generation,phase='active',
          requested_epoch=NULL,requested_pid=NULL,updated_at_ms=excluded.updated_at_ms`).run(kind, epoch, pid, generation, nowMs);
        return { state: "acquired", lease: Object.freeze({ kind, epoch, pid, generation }) };
      };
      if (!row) return take(1);
      if (row.owner_epoch === epoch && row.phase !== "released") {
        return { state: "acquired", lease: Object.freeze({ kind, epoch, pid, generation: row.generation }) };
      }
      if (row.phase === "released") {
        // A release for a handoff reserves the slot for that live requester; nobody else takes it meanwhile.
        if (row.requested_epoch !== null && row.requested_epoch !== epoch && row.requested_pid !== null && this.alive(row.requested_pid)) {
          return { state: "held", holder: { kind: "daemon", pid: row.requested_pid, generation: row.generation, phase: "released" } };
        }
        return take(row.generation + 1);
      }
      if (!this.alive(row.owner_pid)) return take(row.generation + 1);
      if (kind === "daemon" && row.owner_kind === "main") {
        if (row.phase !== "handoff-requested" || row.requested_epoch !== epoch) {
          this.db.prepare(`UPDATE alive_domain_owner SET phase='handoff-requested',requested_epoch=?,requested_pid=?,updated_at_ms=?
            WHERE slot='alive' AND owner_epoch=? AND generation=?`).run(epoch, pid, nowMs, row.owner_epoch, row.generation);
        }
        return { state: "requested", holder: { ...this.holder(row), phase: "handoff-requested" } };
      }
      return { state: "held", holder: this.holder(row) };
    }).immediate();
  }

  holds(lease: AliveDomainLease): boolean {
    const row = this.row();
    return Boolean(row && row.owner_epoch === lease.epoch && row.generation === lease.generation && row.phase !== "released");
  }

  /** A live service asked this holder to hand the domain over. A request from a service that died is ignored. */
  handoffRequested(lease: AliveDomainLease): boolean {
    const row = this.row();
    return Boolean(row && row.owner_epoch === lease.epoch && row.generation === lease.generation && row.phase === "handoff-requested"
      && row.requested_pid !== null && row.requested_pid !== lease.pid && this.alive(row.requested_pid));
  }

  /** Give the domain up. A handoff release keeps the requester's reservation so the slot goes to it and only to it. */
  release(lease: AliveDomainLease): boolean {
    return this.db.transaction(() => {
      const row = this.row();
      if (!row || row.owner_epoch !== lease.epoch || row.generation !== lease.generation || row.phase === "released") return false;
      const keepRequest = row.phase === "handoff-requested" && row.requested_pid !== null && this.alive(row.requested_pid);
      this.db.prepare(`UPDATE alive_domain_owner SET phase='released',requested_epoch=?,requested_pid=?,updated_at_ms=?
        WHERE slot='alive' AND owner_epoch=? AND generation=?`)
        .run(keepRequest ? row.requested_epoch : null, keepRequest ? row.requested_pid : null, this.now(), lease.epoch, lease.generation);
      return true;
    }).immediate();
  }

  private holder(row: Row): AliveDomainHolder {
    return { kind: row.owner_kind, pid: row.owner_pid, generation: row.generation, phase: row.phase };
  }

  private row(): Row | undefined {
    return this.db.prepare(`SELECT owner_kind,owner_epoch,owner_pid,generation,phase,requested_epoch,requested_pid
      FROM alive_domain_owner WHERE slot='alive'`).get() as Row | undefined;
  }
}
