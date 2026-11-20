import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { RunnerFailureKind } from "../runtime/runner";
import { RUNTIME_SIGNAL_META_KEY } from "../runtime/runtime-signals";
import { runtimeAccountChanged } from "../runtime/runtime-account";

/** Private host metadata in the existing meta table. No public event/schema change. */
export interface RetryResource {
  owner: string; kind: string; backend?: string | null; source?: string | null;
  model?: string | null; acpAgentId?: string | null;
  configuration?: string | null;
  /** Opaque fingerprint of the provider account the runtime was signed in to (runtime/runtime-account.ts); absent when the runtime reports none. */
  account?: string | null;
}
export interface RetryGoal { goalId: string; revision: number }
/** `probeAt`: the last time a real provider call answered for this window (the failure that wrote it, or a probe). `runtime`/`account`
 * are stamped on records not keyed by the resource (goal floors, run waits) so a record of another account can be told apart. */
export interface RetryWindow { until: number; kind: RunnerFailureKind; probeAt?: number; runtime?: string; account?: string }
/** A refused window lets ONE real call through (a probe) at most this often, when the owner explicitly sends. Chosen value, not measured:
 * a probe costs one request the provider refuses at once (no model tokens), so spacing only has to prevent a storm; five minutes is long
 * enough that a repeated send cannot hammer the provider and short enough that an upgraded plan or an early reset is found within one
 * coffee. It never exceeds the window itself (a window is read as expired by its own time). */
export const RUNTIME_RETRY_PROBE_GAP_MS = 5 * 60 * 1000;
interface Episode { version: 1; failures: number; generation: number; lastCall: string; closed?: boolean; lastFailureAt?: number }
/** A spent budget is not permanent. What reopens it is a fact: a runtime signal newer than the last failure (a sign-in, a runtime
 * that came up, the connection back; runtime/runtime-signals.ts) admits the next call at once as a probe. This long after the last
 * failure, with no signal at all, is only the backstop probe. A probe that fails closes the episode again (and restarts the clock);
 * a success resets it. Rows without a timestamp (written before this field existed) count as expired, so an old closure opens on
 * its own at the next admission. */
export const RUNTIME_RETRY_REOPEN_AFTER_MS = 2 * 60 * 60 * 1000;
const reopenExpired = (row: Episode, now: number, signalFloor = 0) =>
  row.lastFailureAt === undefined || row.lastFailureAt + RUNTIME_RETRY_REOPEN_AFTER_MS <= now || signalFloor > row.lastFailureAt;
interface GoalFloor extends RetryWindow { version: 1; revision: number; resource: string }
const accountStamp = (resource?: RetryResource): { runtime?: string; account?: string } =>
  resource?.account ? { runtime: resource.kind, account: resource.account } : {};
export interface TeamRetryFacts { version: 1; selfRecoverable: boolean; notBefore: number | null }
const MAX_TIME = 8_640_000_000_000_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prefix = "runtime-retry:v1:";
export function retryResourceKey(resource: RetryResource, broad = false): string {
  if (!resource.owner || !resource.kind) throw new Error("runtime_retry_resource_invalid");
  return hash([resource.owner, resource.kind, resource.backend ?? null,
    ...(broad ? [] : [resource.source ?? null, resource.model ?? null]),
    resource.kind === "acp" ? resource.acpAgentId ?? null : null, resource.configuration ?? null,
    // Only when the runtime names its account: a key without one stays what it was, and a window is never shared across accounts.
    ...(resource.account ? [resource.account] : [])]);
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
  /** The newest runtime signal time (0 when none). A store that cannot read it behaves as before: only the backstop reopens. */
  const signalFloor = (): number => {
    try {
      const row = database().prepare("SELECT value FROM meta WHERE key=?").get(RUNTIME_SIGNAL_META_KEY) as { value: string } | undefined;
      const value = Number(row?.value);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch { return 0; }
  };
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
      || row.closed !== undefined && typeof row.closed !== "boolean"
      || row.lastFailureAt !== undefined && !validTime(row.lastFailureAt))) {
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
    return row && row.revision === goal.revision && row.until > now && !runtimeAccountChanged(row.runtime, row.account) ? row : null;
  };
  return {
    window, goalFloor,
    /**
     * Once per store: quota windows written before a model-only refusal had its own scope were kept on the whole runtime (a
     * model that needs paid credits closed every model of the runtime until the subscription's reset date). They are facts the
     * provider says again on the next refusal, so they are dropped and re-learned with the right scope. Returns how many were dropped.
     */
    dropQuotaWindowsOnce(): number {
      const marker = prefix + "scope-migrated";
      return database().transaction(() => {
        if (database().prepare("SELECT 1 FROM meta WHERE key=?").get(marker)) return 0;
        const dropped = database().prepare("DELETE FROM meta WHERE key LIKE ? AND value LIKE ?")
          .run(prefix + "window:%", '%"kind":"quota"%').changes;
        write("scope-migrated", true);
        return dropped;
      }).immediate();
    },
    closeRunBudget(runId: string): void { write("run-budget-closed:" + hash(runId), true); },
    runBudgetClosed(runId: string): boolean { return read<boolean>("run-budget-closed:" + hash(runId)) === true; },
    recordRunWait(runId: string, wait: RetryWindow, resource?: RetryResource): void {
      if (!validTime(wait.until)) throw new Error("runtime_retry_time_invalid");
      database().transaction(() => {
        const key = "run:" + hash(runId), previous = read<RetryWindow>(key);
        if (previous && !validTime(previous.until)) throw new Error("runtime_retry_window_invalid");
        // A wait recorded for another account is not a fact about this one: it never raises the new wait.
        const previousHolds = previous && !runtimeAccountChanged(previous.runtime, previous.account);
        if (!previousHolds || previous.until < wait.until) write(key, { until: wait.until, kind: wait.kind, ...accountStamp(resource) });
      }).immediate();
    },
    runWait(runId: string): RetryWindow | null {
      const wait = read<RetryWindow>("run:" + hash(runId));
      if (wait && !validTime(wait.until)) throw new Error("runtime_retry_window_invalid");
      return wait && !runtimeAccountChanged(wait.runtime, wait.account) ? wait : null;
    },
    /** The provider answered a probe: this run's recorded wait is no longer true. */
    clearRunWait(runId: string): void { database().prepare("DELETE FROM meta WHERE key=?").run(prefix + "run:" + hash(runId)); },
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
    holdGoal(goal: RetryGoal, until: number, kind: RunnerFailureKind, resourceTag: string, resource?: RetryResource): void {
      if (!validTime(until)) throw new Error("runtime_retry_time_invalid");
      database().transaction(() => {
        const previous = goalFloor(goal, 0);
        // With the resource named, the floor is tied to it exactly like the floor a failure writes, so lifting the window lifts it too.
        write(floorKey(goal.goalId), { version: 1, revision: goal.revision,
          resource: resource ? retryResourceKey(resource) : hash(resourceTag), until: Math.max(previous?.until ?? 0, until), kind, ...accountStamp(resource) });
      }).immediate();
    },
    /**
     * The one real call a refused window lets through. Returns true when the caller may dispatch a probe now: a window of this
     * resource is active and no real provider answer (the failure that wrote it, or an earlier probe) is newer than
     * RUNTIME_RETRY_PROBE_GAP_MS. The claim is written before dispatch in one immediate transaction, so two hosts or two
     * simultaneous sends cannot both probe, and a crash mid-call still spends the slot. A clock that went backwards (probeAt in
     * the future) never blocks: it counts as no earlier probe.
     */
    claimProbe(resource: RetryResource, now = Date.now(), gapMs = RUNTIME_RETRY_PROBE_GAP_MS): boolean {
      return database().transaction(() => {
        const rows = [false, true].map(broad => "window:" + retryResourceKey(resource, broad))
          .map(key => ({ key, row: read<RetryWindow>(key) }))
          .filter((entry): entry is { key: string; row: RetryWindow } => !!entry.row && validTime(entry.row.until) && entry.row.until > now);
        if (!rows.length) return false;
        const last = Math.max(0, ...rows.map(({ row }) => validTime(row.probeAt) && row.probeAt <= now ? row.probeAt : 0));
        if (last > 0 && now - last < gapMs) return false;
        for (const { key, row } of rows) write(key, { ...row, probeAt: now });
        return true;
      }).immediate();
    },
    /** The provider answered a probe: the window(s) of this resource, and the Goal floors tied to them, are lifted. A window of a
     * different account or another model is a different key and stays. */
    clearWindow(resource: RetryResource): void {
      database().transaction(() => {
        for (const broad of [false, true]) database().prepare("DELETE FROM meta WHERE key=?").run(prefix + "window:" + retryResourceKey(resource, broad));
        database().prepare("DELETE FROM meta WHERE key LIKE ? AND value LIKE ?")
          .run(prefix + "goal-floor:%", `%"resource":"${retryResourceKey(resource)}"%`);
      }).immediate();
    },
    failures: (resource: RetryResource, goal: RetryGoal) => episode(resource, goal).failures,
    /** Closed and not yet due for its probe. An expired closure is not exhausted: the next admit() lets one call through. */
    budgetExhausted: (resource: RetryResource, goal: RetryGoal, now = Date.now()): boolean => {
      const row = episode(resource, goal);
      return row.closed === true && !reopenExpired(row, now, signalFloor());
    },
    /** When a spent budget next allows a probe; null while the budget is not spent. */
    retryReopenAt(resource: RetryResource, goal: RetryGoal): number | null {
      const row = episode(resource, goal);
      if (row.closed !== true) return null;
      if (row.lastFailureAt === undefined || signalFloor() > row.lastFailureAt) return Date.now();
      return row.lastFailureAt + RUNTIME_RETRY_REOPEN_AFTER_MS;
    },
    /** Reserve before dispatch, atomically across hosts. A crash cannot replenish
     * the allowance; success settles only its own generation below. */
    admit(resource: RetryResource, goal: RetryGoal, callId: string, maxFailures: number, validate?: () => void): number | null {
      if (!callId || !Number.isSafeInteger(maxFailures) || maxFailures < 1) throw new Error("runtime_retry_admission_invalid");
      return database().transaction(() => {
        validate?.();
        const now = Date.now();
        let previous=episode(resource,goal);
        if (previous.closed || previous.failures >= maxFailures) {
          if (!reopenExpired(previous, now, signalFloor())) return null;
          // Probe: one more call is allowed; its reservation below closes the episode again unless it succeeds.
          previous = {...previous, failures: Math.max(0, maxFailures-1), closed: undefined};
        }
        if (previous.generation >= Number.MAX_SAFE_INTEGER) throw new Error("runtime_retry_counter_exhausted");
        if (read<unknown>(attemptKey(resource,goal,callId)) !== null) throw new Error("runtime_retry_call_identity_reused");
        const closed = previous.failures+1>=maxFailures;
        // closedByAdmit lets refund() reopen exactly the closure this reservation caused (an older host's receipt simply lacks it).
        write(attemptKey(resource,goal,callId), {state:"admitted",...(closed?{closedByAdmit:true}:{})});
        write(episodeKey(resource,goal), {...previous,failures:previous.failures+1,generation:previous.generation+1,
          lastCall:callId,closed,lastFailureAt:now});
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
      /** The refusal closes only this model (shared/runtime-failure-scope.ts): the wait is kept on the model, not on the whole runtime. */
      modelOnly?: boolean; budget?: { maxFailures: number };
      /** The call was the one probe a refused window allowed: what the provider says now replaces the stored time (never only the later of the two). */
      probe?: boolean }): number | undefined {
      if (!input.callId || input.callId.length > 512) throw new Error("runtime_retry_call_identity_invalid");
      return database().transaction(() => {
        if (input.notBefore !== undefined && input.notBefore !== null) {
          if (!validTime(input.notBefore)) throw new Error("runtime_retry_time_invalid");
          const key = "window:" + retryResourceKey(resource, broadFailure(input.kind) && input.modelOnly !== true);
          const previous = read<RetryWindow>(key);
          if (previous && !validTime(previous.until)) throw new Error("runtime_retry_window_invalid");
          const until = input.probe === true ? input.notBefore : Math.max(input.notBefore, previous?.until ?? 0);
          write(key, { until, kind: input.kind, probeAt: Date.now() });
          if (input.probe === true && input.modelOnly !== true) {
            // The provider's fresh word applies to the whole runtime: the sibling row of this resource (model-narrow) follows it.
            const other = "window:" + retryResourceKey(resource, !broadFailure(input.kind));
            const sibling = other === key ? null : read<RetryWindow>(other);
            if (sibling && validTime(sibling.until)) write(other, { ...sibling, until, probeAt: Date.now() });
          }
          if (input.goal) {
            const previousFloor = goalFloor(input.goal, 0);
            write(floorKey(input.goal.goalId), { version: 1, revision: input.goal.revision,
              resource: retryResourceKey(resource), until: input.probe === true ? until : Math.max(until, previousFloor?.until ?? 0),
              kind: input.kind, ...accountStamp(resource) });
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
            lastFailureAt: Date.now(), ...(closed ? { closed: true } : {}) });
          return previous.generation + 1;
        }
      }).immediate();
    },
    success(resource: RetryResource, goal: RetryGoal, generation: number): void {
      database().transaction(() => {
        const previous = episode(resource, goal);
        if (previous.generation === generation) write(episodeKey(resource, goal), { ...previous, failures: 0, closed: undefined, lastFailureAt: undefined });
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
