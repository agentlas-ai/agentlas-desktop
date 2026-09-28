/**
 * AGI goal manager, P0 — the incident record (plan §2 R11/R12, §3.2).
 *
 * One row per (goal, exact blocked-state digest). The row is the impediment as a first-class object: class, age,
 * attempts, the actions taken and the reflections ("tried X, evidence Y, ruled out Z", R2). A state that leaves and
 * comes back later is the same digest and reopens the same row, so a ruled-out action stays ruled out.
 *
 * Main-owned side table (created lazily, like the alive_* tables). Host facts only; no prose from a model is stored
 * as a fact, reflections are typed codes plus short evidence refs.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AgiActionKind, AgiBlockerDiagnosis } from "./blocker";

export interface AgiReflection {
  atMs: number;
  action: AgiActionKind;
  /** ok | refused:<code> | failed:<code> */
  result: string;
  evidenceRefs: string[];
  /** The action must not be repeated on this incident (R2). */
  ruledOut: boolean;
}

export interface AgiIncident {
  id: string;
  goalId: string;
  runId: string | null;
  stateDigest: string;
  status: "open" | "resolved";
  display: AgiBlockerDiagnosis["display"];
  ownerClass: AgiBlockerDiagnosis["ownerClass"];
  causeKind: AgiBlockerDiagnosis["causeKind"];
  boundary: AgiBlockerDiagnosis["boundary"];
  reasonCode: string;
  diagnosis: AgiBlockerDiagnosis;
  attempts: number;
  reflections: AgiReflection[];
  openedAtMs: number;
  updatedAtMs: number;
  closedAtMs: number | null;
  closeReason: string | null;
}

export function ensureAgiIncidentSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agi_incidents (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    run_id TEXT,
    state_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','resolved')),
    display TEXT NOT NULL,
    owner_class TEXT NOT NULL CHECK(owner_class IN ('our_defect','agent_resolvable','human_only')),
    cause_kind TEXT NOT NULL,
    boundary TEXT,
    reason_code TEXT NOT NULL,
    diagnosis_json TEXT NOT NULL CHECK(json_valid(diagnosis_json)),
    attempts INTEGER NOT NULL DEFAULT 0,
    reflections_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(reflections_json)),
    opened_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER,
    close_reason TEXT,
    UNIQUE(goal_id, state_digest))`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_agi_incidents_goal_status ON agi_incidents(goal_id, status, updated_at_ms DESC)");
}

interface Row {
  id: string; goal_id: string; run_id: string | null; state_digest: string; status: "open" | "resolved"; display: string;
  owner_class: string; cause_kind: string; boundary: string | null; reason_code: string; diagnosis_json: string;
  attempts: number; reflections_json: string; opened_at_ms: number; updated_at_ms: number; closed_at_ms: number | null;
  close_reason: string | null;
}

function fromRow(row: Row): AgiIncident {
  let reflections: AgiReflection[] = [];
  try { const parsed = JSON.parse(row.reflections_json); if (Array.isArray(parsed)) reflections = parsed; } catch { /* keep empty */ }
  return {
    id: row.id, goalId: row.goal_id, runId: row.run_id, stateDigest: row.state_digest, status: row.status,
    display: row.display as AgiIncident["display"], ownerClass: row.owner_class as AgiIncident["ownerClass"],
    causeKind: row.cause_kind as AgiIncident["causeKind"], boundary: row.boundary as AgiIncident["boundary"],
    reasonCode: row.reason_code, diagnosis: JSON.parse(row.diagnosis_json) as AgiBlockerDiagnosis, attempts: row.attempts,
    reflections, openedAtMs: row.opened_at_ms, updatedAtMs: row.updated_at_ms, closedAtMs: row.closed_at_ms, closeReason: row.close_reason,
  };
}

export class AgiIncidentStore {
  constructor(private readonly db: Database.Database) { ensureAgiIncidentSchema(db); }

  get(id: string): AgiIncident | null {
    const row = this.db.prepare("SELECT * FROM agi_incidents WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  byDigest(goalId: string, stateDigest: string): AgiIncident | null {
    const row = this.db.prepare("SELECT * FROM agi_incidents WHERE goal_id = ? AND state_digest = ?").get(goalId, stateDigest) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  openForGoal(goalId: string): AgiIncident[] {
    return (this.db.prepare("SELECT * FROM agi_incidents WHERE goal_id = ? AND status = 'open' ORDER BY updated_at_ms DESC")
      .all(goalId) as Row[]).map(fromRow);
  }

  /**
   * Open (or reopen) the incident for this exact state. Any other open incident of the goal is resolved as
   * state_changed: the world moved, so its blocker is no longer the current one.
   */
  open(diagnosis: AgiBlockerDiagnosis, runId: string | null, nowMs: number): { incident: AgiIncident; created: boolean; reopened: boolean } {
    let created = false;
    let reopened = false;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE agi_incidents SET status='resolved', closed_at_ms=?, close_reason='state_changed', updated_at_ms=?
        WHERE goal_id=? AND status='open' AND state_digest<>?`).run(nowMs, nowMs, diagnosis.goalId, diagnosis.stateDigest);
      const existing = this.byDigest(diagnosis.goalId, diagnosis.stateDigest);
      if (!existing) {
        this.db.prepare(`INSERT INTO agi_incidents(id,goal_id,run_id,state_digest,status,display,owner_class,cause_kind,boundary,reason_code,
          diagnosis_json,opened_at_ms,updated_at_ms) VALUES (?,?,?,?,'open',?,?,?,?,?,?,?,?)`)
          .run(`agi-incident:${randomUUID()}`, diagnosis.goalId, runId, diagnosis.stateDigest, diagnosis.display, diagnosis.ownerClass,
            diagnosis.causeKind, diagnosis.boundary, diagnosis.reasonCode, JSON.stringify(diagnosis), nowMs, nowMs);
        created = true;
      } else if (existing.status === "resolved") {
        this.db.prepare(`UPDATE agi_incidents SET status='open', closed_at_ms=NULL, close_reason=NULL, updated_at_ms=?, diagnosis_json=?
          WHERE id=?`).run(nowMs, JSON.stringify(diagnosis), existing.id);
        reopened = true;
      }
    })();
    return { incident: this.byDigest(diagnosis.goalId, diagnosis.stateDigest)!, created, reopened };
  }

  /** The goal has nothing typed holding it: every open incident is resolved. */
  resolveGoal(goalId: string, reason: string, nowMs: number): number {
    return this.db.prepare(`UPDATE agi_incidents SET status='resolved', closed_at_ms=?, close_reason=?, updated_at_ms=?
      WHERE goal_id=? AND status='open'`).run(nowMs, reason, nowMs, goalId).changes;
  }

  noteAttempt(id: string, nowMs: number): void {
    this.db.prepare("UPDATE agi_incidents SET attempts = attempts + 1, updated_at_ms = ? WHERE id = ?").run(nowMs, id);
  }

  reflect(id: string, reflection: AgiReflection): void {
    const incident = this.get(id);
    if (!incident) return;
    const reflections = [...incident.reflections, reflection].slice(-40);
    this.db.prepare("UPDATE agi_incidents SET reflections_json = ?, updated_at_ms = ? WHERE id = ?")
      .run(JSON.stringify(reflections), reflection.atMs, id);
  }

  /** Actions ruled out on this incident (R2): the next attempt may not repeat them. */
  ruledOut(id: string): Set<AgiActionKind> {
    return new Set((this.get(id)?.reflections ?? []).filter((entry) => entry.ruledOut).map((entry) => entry.action));
  }
}
