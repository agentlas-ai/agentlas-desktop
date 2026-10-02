/**
 * AGI goal manager, P1 — the deterministic monitor (plan §3.1 "Monitor", R15 Kubernetes-style reconcile).
 *
 * Every beat it reads each goal's typed facts, classifies them (blocker.ts), keeps the incident record, and when an
 * incident is due it hands exactly one unblock attempt per exact state digest to the installed handler. It never
 * calls a model. Owner decisions 2026-09-28:
 *   D3 — it watches ALL One/Work goals, not only goals with AGI switched on (the YouTube goal never had a life);
 *   D7 (corrected) — no elapsed-time trigger at all; only typed signals open an incident.
 *
 * The Alive decision point unblock_attempt_due (commit 6fdcf31b) and this monitor converge on the same attempt
 * function, which dedupes by (goal, digest): whichever reaches a state first spends its one attempt, the other finds
 * the receipt. Blocked goals therefore never need a light (no-tools) model wake to be looked at.
 *
 * An attempt with no handler installed yet is recorded as no-handler and retried for the same state once one exists.
 */
import type Database from "better-sqlite3";
import { classifyAgiBlocker, type AgiBlockerDiagnosis, type AgiBlockerFacts, type AgiGoalDisplayState } from "./blocker";
import { AgiIncidentStore, type AgiIncident } from "./incident-store";

export const AGI_MONITOR_INTERVAL_MS = 60_000;

export interface AgiUnblockInput {
  kind: "unblock_attempt_due";
  goalId: string;
  runId: string | null;
  runVersion: number | null;
  stateDigest: string;
  incidentId: string;
  diagnosis: AgiBlockerDiagnosis;
  /** The typed facts the diagnosis was made from (signal details such as the login domain or receipt ref). */
  facts?: AgiBlockerFacts;
  /** Where the attempt came from (the Alive hook or the monitor's own beat). */
  trigger: "monitor" | "alive-hook";
}
export interface AgiUnblockResult {
  outcome: "acted" | "needs-human" | "failed" | "rested";
  code?: string;
  actions?: Array<{ action: string; result: string }>;
  tokens?: number;
}
export type AgiUnblockHandler = (input: AgiUnblockInput) => AgiUnblockResult;

export interface AgiMonitorDeps {
  db: Database.Database;
  now(): number;
  listGoalIds(): string[];
  readFacts(goalId: string): AgiBlockerFacts | null;
  /** The executor (P3). Absent → attempts are recorded as no-handler and retried once one is installed. */
  handler?: AgiUnblockHandler | null;
  /** Monitor facts changed (goal chip / AGI incident chip refresh). */
  onChanged?(goalId: string): void;
}

export interface AgiGoalMonitorState {
  goalId: string;
  display: AgiGoalDisplayState;
  incident: Pick<AgiIncident, "id" | "ownerClass" | "causeKind" | "reasonCode" | "attempts" | "openedAtMs"> | null;
  defects: AgiBlockerDiagnosis["defects"];
}

export function ensureAgiAttemptSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agi_unblock_attempts (
    goal_id TEXT NOT NULL,
    state_digest TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    outcome TEXT NOT NULL,
    code TEXT,
    result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
    at_ms INTEGER NOT NULL,
    PRIMARY KEY(goal_id, state_digest))`);
}

export class AgiGoalMonitor {
  readonly incidents: AgiIncidentStore;
  private readonly states = new Map<string, AgiGoalMonitorState>();
  private handler: AgiUnblockHandler | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Model calls this monitor made. Always 0 — asserted by the contract. */
  readonly modelCalls = 0;

  constructor(private readonly deps: AgiMonitorDeps) {
    this.incidents = new AgiIncidentStore(deps.db);
    ensureAgiAttemptSchema(deps.db);
    this.handler = deps.handler ?? null;
  }

  setHandler(handler: AgiUnblockHandler | null): void { this.handler = handler; }

  state(goalId: string): AgiGoalMonitorState | null { return this.states.get(goalId) ?? null; }

  start(intervalMs = AGI_MONITOR_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (error) { console.warn("[agi-monitor] tick failed:", error); } }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One reconcile pass over every monitored goal. Returns what it did (for contracts and logs). */
  tick(): { goals: number; attempts: number; diagnoses: AgiBlockerDiagnosis[] } {
    const diagnoses: AgiBlockerDiagnosis[] = [];
    let attempts = 0;
    const seen = new Set<string>();
    for (const goalId of this.deps.listGoalIds()) {
      seen.add(goalId);
      try {
        const result = this.reconcile(goalId, "monitor");
        if (result.diagnosis) diagnoses.push(result.diagnosis);
        if (result.attempted) attempts += 1;
      } catch (error) { console.warn("[agi-monitor] goal reconcile failed:", goalId, error); }
    }
    for (const goalId of [...this.states.keys()]) if (!seen.has(goalId)) this.states.delete(goalId);
    return { goals: seen.size, attempts, diagnoses };
  }

  /**
   * Reconcile one goal now. Used by the beat, and by the Alive hook (unblock_attempt_due) so both paths share the
   * same one-attempt-per-state receipt.
   */
  reconcile(goalId: string, trigger: AgiUnblockInput["trigger"]): { diagnosis: AgiBlockerDiagnosis | null; attempted: boolean; result: AgiUnblockResult | null } {
    const nowMs = this.deps.now();
    const facts = this.deps.readFacts(goalId);
    if (!facts) {
      this.incidents.resolveGoal(goalId, "goal_gone", nowMs);
      this.states.delete(goalId);
      return { diagnosis: null, attempted: false, result: null };
    }
    const diagnosis = classifyAgiBlocker(facts);
    const before = this.states.get(goalId);
    let incident: AgiIncident | null = null;
    if (!diagnosis.attemptDue) {
      // Running, finished, or an explicit owner stop: nothing is an impediment AGI owns.
      this.incidents.resolveGoal(goalId, diagnosis.display === "terminal" ? "goal_terminal"
        : diagnosis.display === "paused" ? "owner_stop" : "running", nowMs);
    } else {
      incident = this.incidents.open(diagnosis, facts.runId, nowMs).incident;
    }
    let attempted = false;
    let result: AgiUnblockResult | null = null;
    if (incident && diagnosis.attemptDue) {
      const prior = this.deps.db.prepare("SELECT outcome,code,at_ms FROM agi_unblock_attempts WHERE goal_id = ? AND state_digest = ?")
        .get(goalId, diagnosis.stateDigest) as { outcome: string; code: string | null; at_ms: number } | undefined;
      const retryable = prior && ["failed", "rested", "needs-human"].includes(prior.outcome)
        && prior.code !== "agi.model-attempt-dispatched" && nowMs - prior.at_ms >= AGI_MONITOR_INTERVAL_MS;
      const due = !prior || (prior.outcome === "no-handler" && this.handler) || retryable;
      if (due) {
        if (!this.handler) {
          this.record(goalId, diagnosis.stateDigest, incident.id, trigger, { outcome: "failed", code: "agi.no-handler" }, nowMs, "no-handler");
        } else {
          // Claim first (crash between claim and settle = the state's one attempt is spent, never twice).
          this.record(goalId, diagnosis.stateDigest, incident.id, trigger, { outcome: "failed", code: "agi.attempt-claimed" }, nowMs, "claimed");
          this.incidents.noteAttempt(incident.id, nowMs);
          try {
            result = this.handler({ kind: "unblock_attempt_due", goalId, runId: facts.runId, runVersion: facts.runVersion,
              stateDigest: diagnosis.stateDigest, incidentId: incident.id, diagnosis, facts, trigger });
          } catch {
            result = { outcome: "failed", code: "agi.handler-threw" };
          }
          this.record(goalId, diagnosis.stateDigest, incident.id, trigger, result, nowMs, result.outcome);
          attempted = true;
          incident = this.incidents.get(incident.id);
        }
      }
    }
    const next: AgiGoalMonitorState = {
      goalId, display: diagnosis.display, defects: diagnosis.defects,
      incident: incident && incident.status === "open" ? { id: incident.id, ownerClass: incident.ownerClass, causeKind: incident.causeKind,
        reasonCode: incident.reasonCode, attempts: incident.attempts, openedAtMs: incident.openedAtMs } : null,
    };
    this.states.set(goalId, next);
    if (!before || JSON.stringify(before) !== JSON.stringify(next)) {
      try { this.deps.onChanged?.(goalId); } catch { /* a refresh signal cannot fail the beat */ }
    }
    return { diagnosis, attempted, result };
  }

  private record(goalId: string, digest: string, incidentId: string, trigger: string, result: AgiUnblockResult, nowMs: number, outcome: string): void {
    this.deps.db.prepare(`INSERT INTO agi_unblock_attempts(goal_id,state_digest,incident_id,trigger,outcome,code,result_json,at_ms)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(goal_id,state_digest) DO UPDATE SET outcome=excluded.outcome, code=excluded.code,
      result_json=excluded.result_json, at_ms=excluded.at_ms, trigger=excluded.trigger`)
      .run(goalId, digest, incidentId, trigger, outcome, result.code ?? null, JSON.stringify(result), nowMs);
  }
}
