import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { RunnerFailureKind } from "../runtime/runner";

/** Private host metadata in the existing meta table. No public event/schema change. */
export interface RetryResource {
  owner: string; kind: string; backend?: string | null; source?: string | null;
  model?: string | null; acpAgentId?: string | null;
  configuration?: string | null;
}
export interface RetryGoal { goalId: string; revision: number }
export interface RetryWindow { until: number; kind: RunnerFailureKind }
interface Episode { version: 1; failures: number; generation: number; lastCall: string; closed?: boolean }
interface GoalFloor extends RetryWindow { version: 1; revision: number; resource: string }
export interface TeamRetryFacts { version: 1; selfRecoverable: boolean; notBefore: number | null }
const MAX_TIME = 8_640_000_000_000_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prefix = "runtime-retry:v1:";
export function retryResourceKey(resource: RetryResource, broad = false): string {
  if (!resource.owner || !resource.kind) throw new Error("runtime_retry_resource_invalid");
  return hash([resource.owner, resource.kind, resource.backend ?? null,
    ...(broad ? [] : [resource.source ?? null, resource.model ?? null]),
    resource.kind === "acp" ? resource.acpAgentId ?? null : null, resource.configuration ?? null]);
}
const broadFailure = (kind: RunnerFailureKind) => ["quota", "rate_limit", "auth"].includes(kind);
const validTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Closed private timing projection, before generic diagnostic payload truncation. */
export function taskForceRetryFacts(value: unknown, now = Date.now()): TeamRetryFacts | null {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== "object") return null;
  const report = value as { causes?: unknown; effects?: unknown };
  if (!Array.isArray(report.causes) || !Array.isArray(report.effects) || report.causes.length > 1000 || report.effects.length > 1000) return null;
  const roots = report.causes.filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .filter(v => !(Array.isArray(v.blockedBy) && v.blockedBy.length));
  if (!roots.length) return null;
  let notBefore: number | null = null;
  for (const root of roots) {
    const at = typeof root.retryAfterHint === "string" ? Date.parse(root.retryAfterHint) : Number.NaN;
    const duration = typeof root.retryAfterMs === "number" && Number.isFinite(root.retryAfterMs) && root.retryAfterMs >= 0
      ? Math.min(MAX_TIME, now + Math.ceil(root.retryAfterMs)) : Number.NaN;
    for (const candidate of [at, duration]) if (validTime(candidate) && candidate > now) notBefore = Math.max(notBefore ?? 0, candidate);
  }
  const selfRecoverable = report.causes.every(v => !!v && typeof v === "object" && !Array.isArray(v))
    && roots.every(v => v.recovery === "wait-capacity" || v.recovery === "retry-preparation")
    && report.effects.every(v => !!v && typeof v === "object" && !Array.isArray(v)
      && ["not-attempted", "withheld", "verified"].includes(String(v.state)));
  return { version: 1, selfRecoverable, notBefore };
}

export function createRuntimeRetryStore(database: () => Database.Database) {
  const read = <T>(key: string): T | null => {
    const row = database().prepare("SELECT value FROM meta WHERE key=?").get(prefix + key) as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value) as T; } catch { throw new Error("runtime_retry_metadata_invalid"); }
  };
  const write = (key: string, value: unknown) => database().prepare(`INSERT INTO meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(prefix + key, JSON.stringify(value));
  const episodeKey = (resource: RetryResource, goal: RetryGoal) => "episode:" + hash([goal.goalId, goal.revision, retryResourceKey(resource)]);
  const attemptKey = (resource: RetryResource, goal: RetryGoal, callId: string) => "attempt:" + hash([goal.goalId, goal.revision, retryResourceKey(resource), callId]);
  const floorKey = (goalId: string) => "goal-floor:" + hash(goalId);
  const episode = (resource: RetryResource, goal: RetryGoal): Episode => {
    const row = read<Episode>(episodeKey(resource, goal));
    if (row && (row.version !== 1 || !counter(row.failures) || !counter(row.generation) || typeof row.lastCall !== "string"
      || row.closed !== undefined && typeof row.closed !== "boolean")) {
      throw new Error("runtime_retry_episode_invalid");
    }
    return row ?? { version: 1, failures: 0, generation: 0, lastCall: "" };
  };
  const window = (resource: RetryResource, now = Date.now()): RetryWindow | null => {
    const rows = [false, true].map(broad => read<RetryWindow>("window:" + retryResourceKey(resource, broad)));
    for (const row of rows) if (row && (!validTime(row.until) || !["quota", "rate_limit", "unavailable", "timeout", "empty", "exit", "auth", "refused", "unsupported", "unknown"].includes(row.kind))) {
      throw new Error("runtime_retry_window_invalid");
    }
    return rows.filter((row): row is RetryWindow => row !== null && row.until > now).sort((a, b) => b.until - a.until)[0] ?? null;
  };
  const goalFloor = (goal: RetryGoal, now = Date.now()): GoalFloor | null => {
    const row = read<GoalFloor>(floorKey(goal.goalId));
    if (row && (row.version !== 1 || !counter(row.revision) || !validTime(row.until) || typeof row.resource !== "string")) {
      throw new Error("runtime_retry_goal_floor_invalid");
    }
    return row && row.revision === goal.revision && row.until > now ? row : null;
  };
  return {
    window, goalFloor,
    closeRunBudget(runId: string): void { write("run-budget-closed:" + hash(runId), true); },
    runBudgetClosed(runId: string): boolean { return read<boolean>("run-budget-closed:" + hash(runId)) === true; },
    recordRunWait(runId: string, wait: RetryWindow): void {
      if (!validTime(wait.until)) throw new Error("runtime_retry_time_invalid");
      database().transaction(() => {
        const key = "run:" + hash(runId), previous = read<RetryWindow>(key);
        if (previous && !validTime(previous.until)) throw new Error("runtime_retry_window_invalid");
        if (!previous || previous.until < wait.until) write(key, wait);
      }).immediate();
    },
    runWait(runId: string): RetryWindow | null {
      const wait = read<RetryWindow>("run:" + hash(runId));
      if (wait && !validTime(wait.until)) throw new Error("runtime_retry_window_invalid");
      return wait;
    },
    recordTeamWait(runId: string, report: unknown, now = Date.now()): void {
      const facts = taskForceRetryFacts(report, now);
      if (facts) database().transaction(() => {
        const key = "team:" + hash(runId), previous = read<TeamRetryFacts>(key);
        if (previous?.notBefore !== undefined && previous.notBefore !== null && !validTime(previous.notBefore)) throw new Error("runtime_retry_team_wait_invalid");
        write(key, { ...facts, notBefore: facts.notBefore === null ? previous?.notBefore ?? null : Math.max(facts.notBefore, previous?.notBefore ?? 0) });
      }).immediate();
    },
    teamWait(runId: string): TeamRetryFacts | null {
      const facts = read<TeamRetryFacts>("team:" + hash(runId));
      if (facts && (facts.version !== 1 || typeof facts.selfRecoverable !== "boolean"
        || (facts.notBefore !== null && !validTime(facts.notBefore)))) throw new Error("runtime_retry_team_wait_invalid");
      return facts;
    },
    holdGoal(goal: RetryGoal, until: number, kind: RunnerFailureKind, resourceTag: string): void {
      if (!validTime(until)) throw new Error("runtime_retry_time_invalid");
      database().transaction(() => {
        const previous = goalFloor(goal, 0);
        write(floorKey(goal.goalId), { version: 1, revision: goal.revision,
          resource: hash(resourceTag), until: Math.max(previous?.until ?? 0, until), kind });
      }).immediate();
    },
    failures: (resource: RetryResource, goal: RetryGoal) => episode(resource, goal).failures,
    budgetExhausted: (resource: RetryResource, goal: RetryGoal): boolean => episode(resource, goal).closed === true,
    /** Reserve before dispatch, atomically across hosts. A crash cannot replenish
     * the allowance; success settles only its own generation below. */
    admit(resource: RetryResource, goal: RetryGoal, callId: string, maxFailures: number, validate?: () => void): number | null {
      if (!callId || !Number.isSafeInteger(maxFailures) || maxFailures < 1) throw new Error("runtime_retry_admission_invalid");
      return database().transaction(() => {
        validate?.();
        const previous=episode(resource,goal);
        if (previous.closed || previous.failures >= maxFailures) return null;
        if (previous.generation >= Number.MAX_SAFE_INTEGER) throw new Error("runtime_retry_counter_exhausted");
        if (read<unknown>(attemptKey(resource,goal,callId)) !== null) throw new Error("runtime_retry_call_identity_reused");
        const closed = previous.failures+1>=maxFailures;
        // closedByAdmit lets refund() reopen exactly the closure this reservation caused (an older host's receipt simply lacks it).
        write(attemptKey(resource,goal,callId), {state:"admitted",...(closed?{closedByAdmit:true}:{})});
        write(episodeKey(resource,goal), {...previous,failures:previous.failures+1,generation:previous.generation+1,
          lastCall:callId,closed});
        return previous.generation+1;
      }).immediate();
    },
    /** Give back the one attempt admit() reserved for `callId`, when the caller holds a machine fact that the call never reached
     * the provider (turnDelivery "not-dispatched", or aborted before the runner was entered). Exactly once per call identity:
     * only a receipt still "admitted" is refunded, then it is "refunded", which failure() and admit() both treat as settled. A
     * call that already recorded a failure, a different host's reservation and a call whose delivery is unknown are untouched
     * (the attempt stays spent). Generation is never lowered, so a late success of an older call still cannot erase a newer one. */
    refund(resource: RetryResource, goal: RetryGoal, callId: string, maxFailures: number): boolean {
      if (!callId || !Number.isSafeInteger(maxFailures) || maxFailures < 1) throw new Error("runtime_retry_admission_invalid");
      return database().transaction(() => {
        const receiptKey = attemptKey(resource,goal,callId);
        const receipt = read<{state?:string;closedByAdmit?:boolean}|number>(receiptKey);
        if (receipt === null || typeof receipt !== "object" || receipt.state !== "admitted") return false;
        const previous = episode(resource,goal);
        if (previous.failures < 1) return false;
        const failures = previous.failures-1;
        const closed = previous.closed === true && !(receipt.closedByAdmit === true && failures < maxFailures);
        write(receiptKey, {state:"refunded"});
        write(episodeKey(resource,goal), {...previous,failures,closed:closed?true:undefined});
        return true;
      }).immediate();
    },
    /** Snapshot before an admitted call. A late success cannot erase a newer failed call. */
    generation: (resource: RetryResource, goal: RetryGoal) => {
      const value = episode(resource, goal).generation;
      if (value >= Number.MAX_SAFE_INTEGER) throw new Error("runtime_retry_counter_exhausted");
      return value;
    },
    failure(resource: RetryResource, input: { kind: RunnerFailureKind; notBefore?: number | null; callId: string; goal?: RetryGoal;
      budget?: { maxFailures: number } }): number | undefined {
      if (!input.callId || input.callId.length > 512) throw new Error("runtime_retry_call_identity_invalid");
      return database().transaction(() => {
        if (input.notBefore !== undefined && input.notBefore !== null) {
          if (!validTime(input.notBefore)) throw new Error("runtime_retry_time_invalid");
          const key = "window:" + retryResourceKey(resource, broadFailure(input.kind));
          const previous = read<RetryWindow>(key);
          if (previous && !validTime(previous.until)) throw new Error("runtime_retry_window_invalid");
          const until = Math.max(input.notBefore, previous?.until ?? 0);
          write(key, { until, kind: input.kind });
          if (input.goal) {
            const previousFloor = goalFloor(input.goal, 0);
            write(floorKey(input.goal.goalId), { version: 1, revision: input.goal.revision,
              resource: retryResourceKey(resource), until: Math.max(until, previousFloor?.until ?? 0), kind: input.kind });
          }
        }
        if (input.goal) {
          const receiptKey = attemptKey(resource,input.goal,input.callId);
          const receipt=read<{state?:string}|number>(receiptKey);
          if (receipt !== null && (typeof receipt !== "object" || receipt.state !== "admitted")) return;
          const previous = episode(resource, input.goal);
          if (previous.generation >= Number.MAX_SAFE_INTEGER || previous.failures >= Number.MAX_SAFE_INTEGER) throw new Error("runtime_retry_counter_exhausted");
          if (input.budget && (!Number.isSafeInteger(input.budget.maxFailures) || input.budget.maxFailures < 1)) throw new Error("runtime_retry_budget_invalid");
          const failures=receipt !== null ? Math.max(1,previous.failures) : previous.failures+1;
          const closed = previous.closed || Boolean(input.budget && failures >= input.budget.maxFailures);
          write(receiptKey, 1);
          write(episodeKey(resource, input.goal), { version: 1, failures,
            generation: Math.min(Number.MAX_SAFE_INTEGER, previous.generation + 1), lastCall: input.callId,
            ...(closed ? { closed: true } : {}) });
          return previous.generation + 1;
        }
      }).immediate();
    },
    success(resource: RetryResource, goal: RetryGoal, generation: number): void {
      database().transaction(() => {
        const previous = episode(resource, goal);
        if (previous.generation === generation) write(episodeKey(resource, goal), { ...previous, failures: 0, closed: undefined });
        const floor = goalFloor(goal, 0);
        // An actually selected different resource is authorized by its existing host selection,
        // not by this store. It may continue independent work; the failed provider window stays.
        if (floor?.resource !== retryResourceKey(resource) || floor.until <= Date.now()) {
          database().prepare("DELETE FROM meta WHERE key=?").run(prefix + floorKey(goal.goalId));
        }
      }).immediate();
    },
  };
}
