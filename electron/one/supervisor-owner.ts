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
}

/** One scheduler per local store. Account switches fence the previous identity;
 * a lease timeout alone never authorizes a second process to dispatch effects. */
export class OneSupervisorOwner {
  private readonly now: () => number;
  private readonly pid: number;
  private readonly leaseMs: number;
  private readonly ownerAlive: (pid: number) => boolean | null;
  constructor(private readonly db: Database.Database, private readonly options: SupervisorOwnerOptions) {
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.leaseMs = options.leaseMs ?? 60_000;
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
        if (row && row.phase !== "released" && this.ownerAlive(row.owner_pid) !== false) throw supervisorError('supervisor_owner_unconfirmed');
        this.db.prepare(`INSERT INTO one_supervisor_runtime_owner(slot,one_id,owner_epoch,owner_kind,owner_pid,generation,lease_until,phase)
          VALUES('personal',?,?,?,?,?,?,'active') ON CONFLICT(slot) DO UPDATE SET one_id=excluded.one_id,
          owner_epoch=excluded.owner_epoch,owner_kind=excluded.owner_kind,owner_pid=excluded.owner_pid,
          generation=excluded.generation,lease_until=excluded.lease_until,phase='active'`)
          .run(oneId,this.options.ownerEpoch,this.options.ownerKind,this.pid,(row?.generation ?? 0)+1,now+this.leaseMs);
      }
      return this.project(this.row()!);
    }).immediate();
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
