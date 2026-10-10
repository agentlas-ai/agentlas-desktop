import { supervisorError } from "../../shared/one-supervisor";
import type Database from "better-sqlite3";
import { supervisorHash, type SupervisorRequestRow } from "./supervisor-store";

export type WorkPhase = "queued" | "claimed" | "starting" | "running" | "held" | "completed" | "failed" | "cancelled";
export interface SupervisorWorkLease {
  command_id: string;
  one_id: string;
  task_id: string;
  chat_id: string;
  run_id: string;
  phase: WorkPhase;
  generation: number;
  owner_epoch: string | null;
  owner_kind: "desktop-main" | "work-daemon" | null;
  lease_until: number;
  reason: string | null;
  updated_at: number;
}
const LIVE = "'claimed','starting','running','held'";
const TERMINAL = new Set<WorkPhase>(["completed", "failed", "cancelled"]);

/** Native dispatch ownership, separate from the ingress ACK and provider session.
 * A claimed job has not crossed the durable starting boundary. Only that phase
 * may be requeued after expiry. Starting/running ambiguity always requires proof.
 */
export class OneSupervisorWorkQueue {
  constructor(readonly db: Database.Database, schemaOwner = true, private readonly now = Date.now) {
    if (schemaOwner) db.exec(`
      CREATE TABLE IF NOT EXISTS one_supervisor_work_jobs (
        command_id TEXT PRIMARY KEY REFERENCES one_supervisor_requests(command_id),
        one_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL CHECK(phase IN ('queued','claimed','starting','running','held','completed','failed','cancelled')),
        generation INTEGER NOT NULL DEFAULT 0, owner_epoch TEXT, owner_kind TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0, reason TEXT, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS one_supervisor_work_dispatch ON one_supervisor_work_jobs(one_id,phase,updated_at);
      CREATE INDEX IF NOT EXISTS one_supervisor_work_live ON one_supervisor_work_jobs(phase,updated_at);
      CREATE TABLE IF NOT EXISTS one_supervisor_host_identity (
        slot TEXT PRIMARY KEY CHECK(slot='active'), one_id TEXT NOT NULL,
        revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    // Followers never create/upgrade a schema. A missing table is a readiness
    // condition, not permission to start a second migration authority.
    for (const name of ["one_supervisor_work_jobs", "one_supervisor_host_identity"]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) {
        throw supervisorError('supervisor_work_schema_not_ready');
      }
    }
  }
  private write<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  setActiveIdentity(oneId: string): void {
    this.db.prepare(`INSERT INTO one_supervisor_host_identity(slot,one_id,revision,updated_at) VALUES('active',?,1,?)
      ON CONFLICT(slot) DO UPDATE SET one_id=excluded.one_id,revision=revision+1,updated_at=excluded.updated_at
      WHERE one_id<>excluded.one_id`).run(oneId, this.now());
  }
  activeIdentity(): string | null {
    return (this.db.prepare("SELECT one_id FROM one_supervisor_host_identity WHERE slot='active'").get() as {one_id: string} | undefined)?.one_id ?? null;
  }
  get(commandId: string): SupervisorWorkLease | null {
    return this.db.prepare("SELECT * FROM one_supervisor_work_jobs WHERE command_id=?").get(commandId) as SupervisorWorkLease | undefined ?? null;
  }
  forTask(taskId: string): SupervisorWorkLease | null {
    return this.db.prepare("SELECT * FROM one_supervisor_work_jobs WHERE task_id=?").get(taskId) as SupervisorWorkLease | undefined ?? null;
  }
  forRun(runId: string): SupervisorWorkLease | null {
    return this.db.prepare("SELECT * FROM one_supervisor_work_jobs WHERE run_id=?").get(runId) as SupervisorWorkLease | undefined ?? null;
  }
  list(oneId?: string): SupervisorWorkLease[] {
    return this.db.prepare(`SELECT * FROM one_supervisor_work_jobs ${oneId ? "WHERE one_id=?" : ""} ORDER BY rowid DESC LIMIT 100`)
      .all(...(oneId ? [oneId] : [])) as SupervisorWorkLease[];
  }
  active(): SupervisorWorkLease[] {
    return this.db.prepare("SELECT * FROM one_supervisor_work_jobs WHERE phase IN ('starting','running','held') LIMIT 100").all() as SupervisorWorkLease[];
  }
  enqueue(row: SupervisorRequestRow, chatId: string): SupervisorWorkLease {
    if (row.kind !== "work" || row.state !== "stored" || !row.task_id || !row.run_id) throw supervisorError('supervisor_work_ingress_invalid');
    return this.write(() => {
      const prior = this.get(row.command_id);
      if (prior) {
        if (prior.one_id !== row.one_id || prior.chat_id !== chatId || prior.run_id !== row.run_id || prior.task_id !== row.task_id) {
          throw supervisorError('supervisor_work_binding_conflict');
        }
        return prior;
      }
      if ((this.db.prepare(`SELECT count(*) AS n FROM one_supervisor_work_jobs WHERE one_id=? AND phase NOT IN ('completed','failed','cancelled')`)
        .get(row.one_id) as {n: number}).n >= 20) throw supervisorError('supervisor_work_queue_full');
      this.db.prepare(`INSERT INTO one_supervisor_work_jobs(command_id,one_id,task_id,chat_id,run_id,phase,updated_at)
        VALUES(?,?,?,?,?,'queued',?)`).run(row.command_id, row.one_id, row.task_id, chatId, row.run_id, this.now());
      return this.get(row.command_id)!;
    });
  }
  claim(input: {ownerEpoch: string; ownerKind: NonNullable<SupervisorWorkLease["owner_kind"]>; leaseMs?: number; capacity?: number}): SupervisorWorkLease | null {
    const leaseMs = input.leaseMs ?? 30_000;
    const capacity = input.capacity ?? 2;
    if (!input.ownerEpoch || input.ownerEpoch.length > 200 || !["desktop-main", "work-daemon"].includes(input.ownerKind)
      || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 120_000
      || !Number.isInteger(capacity) || capacity < 1 || capacity > 2) throw supervisorError('supervisor_work_claim_invalid');
    return this.write(() => {
      if ((this.db.prepare(`SELECT count(*) AS n FROM one_supervisor_work_jobs WHERE phase IN (${LIVE})`).get() as {n: number}).n >= capacity) return null;
      const candidate = this.db.prepare(`SELECT * FROM one_supervisor_work_jobs WHERE phase='queued'
        AND one_id=(SELECT one_id FROM one_supervisor_host_identity WHERE slot='active') ORDER BY rowid LIMIT 1`).get() as SupervisorWorkLease | undefined;
      if (!candidate) return null;
      const now = this.now();
      const changed = this.db.prepare(`UPDATE one_supervisor_work_jobs SET phase='claimed',generation=generation+1,
        owner_epoch=?,owner_kind=?,lease_until=?,reason=NULL,updated_at=? WHERE command_id=? AND phase='queued' AND generation=?`)
        .run(input.ownerEpoch, input.ownerKind, now + leaseMs, now, candidate.command_id, candidate.generation);
      return changed.changes === 1 ? this.get(candidate.command_id) : null;
    });
  }
  begin(lease: SupervisorWorkLease): SupervisorWorkLease | null {
    const now = this.now();
    const changed = this.db.prepare(`UPDATE one_supervisor_work_jobs SET phase='starting',updated_at=?
      WHERE command_id=? AND phase='claimed' AND owner_epoch=? AND generation=? AND lease_until>?
        AND one_id=(SELECT one_id FROM one_supervisor_host_identity WHERE slot='active')`)
      .run(now, lease.command_id, lease.owner_epoch, lease.generation, now);
    return changed.changes === 1 ? this.get(lease.command_id) : null;
  }
  transition(lease: SupervisorWorkLease, phase: WorkPhase, reason: string | null = null): SupervisorWorkLease | null {
    if (TERMINAL.has(lease.phase)) return null;
    const changed = this.db.prepare(`UPDATE one_supervisor_work_jobs SET phase=?,reason=?,updated_at=?,lease_until=?
      WHERE command_id=? AND phase=? AND owner_epoch IS ? AND generation=?`)
      .run(phase, reason?.slice(0, 240) ?? null, this.now(), TERMINAL.has(phase) ? 0 : lease.lease_until,
        lease.command_id, lease.phase, lease.owner_epoch, lease.generation);
    return changed.changes === 1 ? this.get(lease.command_id) : null;
  }
  heartbeat(lease: SupervisorWorkLease, leaseMs = 30_000): SupervisorWorkLease | null {
    const now = this.now();
    const changed = this.db.prepare(`UPDATE one_supervisor_work_jobs SET lease_until=?,updated_at=?
      WHERE command_id=? AND phase IN ('starting','running') AND owner_epoch=? AND generation=?`)
      .run(now + leaseMs, now, lease.command_id, lease.owner_epoch, lease.generation);
    return changed.changes === 1 ? this.get(lease.command_id) : null;
  }
  recoverUnstarted(): number {
    // A stale starter must successfully begin() before invoking a runtime. The
    // phase/generation CAS fences it after this provably pre-dispatch recovery.
    return Number(this.db.prepare(`UPDATE one_supervisor_work_jobs SET phase='queued',owner_epoch=NULL,owner_kind=NULL,
      lease_until=0,reason='unstarted_claim_recovered',updated_at=? WHERE phase='claimed' AND lease_until<=?`)
      .run(this.now(), this.now()).changes);
  }
  cancelUnstarted(lease: SupervisorWorkLease): boolean {
    return this.db.prepare(`UPDATE one_supervisor_work_jobs SET phase='cancelled',lease_until=0,
      reason='cancelled_before_dispatch',updated_at=? WHERE command_id=? AND generation=? AND (phase IN ('queued','claimed') OR (phase='held' AND reason='held_before_native_dispatch'))`)
      .run(this.now(), lease.command_id, lease.generation).changes === 1;
  }
  canCancelUnstarted(lease: SupervisorWorkLease): boolean {
    return ['queued','claimed'].includes(lease.phase) || lease.phase==='held' && lease.reason==='held_before_native_dispatch';
  }
  version(lease: SupervisorWorkLease): string {
    // Heartbeats are not new user-control versions. A claim or dispatch phase is.
    return supervisorHash([lease.command_id, lease.run_id, lease.phase, lease.generation, lease.owner_epoch]);
  }
}
