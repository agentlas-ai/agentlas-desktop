/**
 * AGI goal manager, P1 — the deterministic monitor (plan §3.1 "Monitor", R15 Kubernetes-style reconcile).
 *
 * Every beat it reads each goal's typed facts, classifies them (blocker.ts), keeps the incident record, and when an
 * incident is due it hands one claimed attempt to the installed handler, with durable backoff for unchanged state. It never
 * calls a model. Owner decisions 2026-09-28:
 *   D3 — it watches ALL One/Work goals, not only goals with AGI switched on (the YouTube goal never had a life);
 *   D7 (corrected) — no elapsed-time trigger at all; only typed signals open an incident.
 *
 * The Alive decision point unblock_attempt_due (commit 6fdcf31b) and this monitor converge on the same attempt
 * function, which dedupes by (goal, digest): whichever claims the due attempt first owns it, the other finds
 * the receipt. Blocked goals therefore never need a light (no-tools) model wake to be looked at.
 *
 * An attempt with no handler installed yet is recorded as no-handler and retried for the same state once one exists.
 */
import type Database from "better-sqlite3";
import { onDesktopStoreChange } from "../store/change-bus";
import { AGI_NON_ALTERNATIVE_ACTIONS, type AgiActionKind, classifyAgiBlocker, type AgiBlockerDiagnosis, type AgiBlockerFacts, type AgiGoalDisplayState } from "./blocker";
import { AgiIncidentStore, type AgiIncident } from "./incident-store";

export const AGI_MONITOR_INTERVAL_MS = 60_000;
/** Retry the same typed incident at 5, 10, 20, 40, then 60 minute intervals; new evidence has its own digest. */
export function agiRetryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(4, Math.max(0, attempts - 1)));
}

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
  /** Main rereads semantic state before rebasing a version-only ledger change. Never grants authority. */
  refreshFence?(): { goalId: string; runId: string; runVersion: number } | null;
}
export interface AgiUnblockResult {
  outcome: "acted" | "needs-human" | "failed" | "rested";
  code?: string;
  actions?: Array<{ action: string; result: string }>;
  tokens?: number;
}
export type AgiUnblockHandler = ((input: AgiUnblockInput) => AgiUnblockResult) & { isBusy?(goalId: string): boolean };

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
  private readonly sources = new Map<string, { runId: string | null; chatId: string | null }>();
  private readonly pending = new Set<string>();
  private readonly dueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
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
    this.unsubscribe = onDesktopStoreChange((change) => {
      if (!["chat", "long-run", "runtime", "capability-grant", "automation"].includes(change.entity)) return;
      for (const [goalId, source] of this.sources) {
        if (((change.entity === "chat" || change.entity === "long-run")
          && change.id !== (change.entity === "chat" ? source.chatId : source.runId)) || this.pending.has(goalId)) continue;
        this.pending.add(goalId);
        queueMicrotask(() => {
          this.pending.delete(goalId);
          if (!this.timer) return;
          try { this.reconcile(goalId, "monitor"); } catch (error) { console.warn("[agi-monitor] wake failed:", error); }
        });
      }
    });
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.unsubscribe?.(); this.unsubscribe = null; this.pending.clear(); for (const timer of this.dueTimers.values()) clearTimeout(timer); this.dueTimers.clear(); }

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
    for (const goalId of [...this.states.keys()]) if (!seen.has(goalId)) { this.states.delete(goalId); this.sources.delete(goalId); }
    return { goals: seen.size, attempts, diagnoses };
  }

  /**
   * Reconcile one goal now. Used by the beat, and by the Alive hook (unblock_attempt_due) so both paths share the
   * same durable attempt receipt and retry deadline.
   */
  reconcile(goalId: string, trigger: AgiUnblockInput["trigger"]): { diagnosis: AgiBlockerDiagnosis | null; attempted: boolean; result: AgiUnblockResult | null } {
    const nowMs = this.deps.now();
    const facts = this.deps.readFacts(goalId);
    if (!facts) {
      this.incidents.resolveGoal(goalId, "goal_gone", nowMs);
      this.states.delete(goalId);
      this.sources.delete(goalId);
      return { diagnosis: null, attempted: false, result: null };
    }
    this.sources.set(goalId, { runId: facts.runId, chatId: facts.chatId ?? null });
    const dueTimer = this.dueTimers.get(goalId);
    if (dueTimer) clearTimeout(dueTimer);
    this.dueTimers.delete(goalId);
    if (this.timer && Number.isFinite(facts.nextWakeAtMs) && facts.nextWakeAtMs! > nowMs) {
      const timer = setTimeout(() => {
        this.dueTimers.delete(goalId);
        if (this.timer) { try { this.reconcile(goalId, "monitor"); } catch (error) { console.warn("[agi-monitor] due wake failed:", error); } }
      }, Math.min(2_147_483_647, facts.nextWakeAtMs! - nowMs));
      timer.unref?.(); this.dueTimers.set(goalId, timer);
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
      // Claim and count atomically. No provider call or host action runs inside this transaction.
      const claimed = !facts.repairInFlight && !this.handler?.isBusy?.(goalId) && this.deps.db.transaction(() => {
        let prior = this.deps.db.prepare("SELECT outcome,code,at_ms FROM agi_unblock_attempts WHERE goal_id = ? AND state_digest = ?")
          .get(goalId, diagnosis.stateDigest) as { outcome: string; code: string | null; at_ms: number } | undefined;
        const current = this.incidents.get(incident!.id)!;
        // The async attempt-row write can fail after the model's own durable terminal write. Recover only
        // that exact host receipt; this does not observe an external effect or complete the user's Goal.
        if (prior?.code === "agi.model-attempt-dispatched" && this.deps.db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agi_model_attempts'").get()) {
          const id = `agi-model:${incident!.id.slice(-24)}:${diagnosis.stateDigest.slice(-16)}:${Math.max(1, current.attempts)}`;
          const terminal = this.deps.db.prepare(`SELECT status,actions_json,settled_at_ms FROM agi_model_attempts
            WHERE id=? AND goal_id=? AND incident_id=? AND state_digest=? AND status IN ('completed','failed','refused')`)
            .get(id, goalId, incident!.id, diagnosis.stateDigest) as { status: string; actions_json: string; settled_at_ms: number | null } | undefined;
          if (terminal && terminal.settled_at_ms !== null) {
            let actions: Array<{ action: string; result: string }> = [];
            try { const parsed: unknown = JSON.parse(terminal.actions_json);
              if (Array.isArray(parsed)) actions = parsed.filter((v): v is { action: string; result: string } =>
                Boolean(v) && typeof v.action === "string" && typeof v.result === "string");
            } catch { /* missing details cannot assert an accepted action */ }
            const accepted = actions.filter(a => !a.result.startsWith("refused:"));
            const outcome: AgiUnblockResult["outcome"] = terminal.status !== "completed" ? "failed"
              : accepted.some(a => !AGI_NON_ALTERNATIVE_ACTIONS.has(a.action as AgiActionKind)) ? "acted"
              : accepted.some(a => a.action === "ask_owner_once") ? "needs-human" : "rested";
            const recovered = { outcome, code: "agi.model-terminal-recovered", actions };
            const at = Math.min(nowMs, terminal.settled_at_ms);
            this.record(goalId, diagnosis.stateDigest, incident!.id, trigger, recovered, at, outcome);
            prior = { outcome, code: recovered.code, at_ms: at };
          }
        }
        // A wall-clock rollback must not park a retry in the future indefinitely. Rebase once, never on each beat.
        if (prior && prior.at_ms > nowMs) {
          this.deps.db.prepare("UPDATE agi_unblock_attempts SET at_ms=? WHERE goal_id=? AND state_digest=?")
            .run(nowMs, goalId, diagnosis.stateDigest);
          prior.at_ms = nowMs;
        }
        const retryable = prior && ["failed", "rested", "needs-human"].includes(prior.outcome)
          && prior.code !== "agi.model-attempt-dispatched" && nowMs - prior.at_ms >= agiRetryDelayMs(current.attempts);
        // A clock or timeout cannot prove an unfinished action/provider claim is dead.
        if (prior && !(prior.outcome === "no-handler" && this.handler) && !retryable) return false;
        if (!this.handler) {
          this.record(goalId, diagnosis.stateDigest, incident!.id, trigger, { outcome: "failed", code: "agi.no-handler" }, nowMs, "no-handler");
          return false;
        }
        this.record(goalId, diagnosis.stateDigest, incident!.id, trigger, { outcome: "failed", code: "agi.attempt-claimed" }, nowMs, "claimed");
        this.incidents.noteAttempt(incident!.id, nowMs);
        return true;
      }).immediate();
      if (claimed) {
        const expectedFenceState = facts.fenceState;
        const expectedRunId = facts.runId;
        try {
          result = this.handler!({ kind: "unblock_attempt_due", goalId, runId: facts.runId, runVersion: facts.runVersion,
            stateDigest: diagnosis.stateDigest, incidentId: incident.id, diagnosis, facts, trigger,
            refreshFence: () => {
              const live = this.deps.readFacts(goalId);
              if (!live || live.repairInFlight || live.fenceState !== expectedFenceState || live.runId !== expectedRunId || live.runVersion === null
                || classifyAgiBlocker(live).stateDigest !== diagnosis.stateDigest) return null;
              return { goalId, runId: live.runId!, runVersion: live.runVersion };
            } });
        } catch { result = { outcome: "failed", code: "agi.handler-threw" }; }
        this.record(goalId, diagnosis.stateDigest, incident.id, trigger, result, nowMs, result.outcome);
        attempted = true;
        incident = this.incidents.get(incident.id);
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
