/**
 * The cause table of the Agentlas Harness (Agentlas 2.0 N3a, decision; docs/Agentlas2.0/audit/39-design-n-agentlas-harness.md section 11).
 *
 * One pure answer to "what does the host do next for this Goal": start, start on another runtime, wait (a ladder rung or a time),
 * wait for the owner, close, or nothing. It reads CLOSED values only - facts the host already holds as typed fields (a status, a
 * pause reason, a runner failure kind, a host stop cause, a boolean a typed predicate answered). It never reads prose, never matches
 * a pattern against a message, never calls a model, and names no new cause: the vocabulary is the one that exists
 * (shared/run-failure-cause.ts, runtime/runner.ts RunnerFailureKind, shared/types.ts InvocationHostStopCause).
 *
 * Two tables, read in this order:
 *   1. the Goal's own state, whatever its last turn was (decideGoalState): null means "the state says nothing, read the last turn";
 *   2. how the last turn ended (decideLastTurn): total - an unknown code, no code, or a shape that does not fit the contract is the
 *      last row, a wait on the app-side ladder, never a question to the owner and never a standstill.
 *
 * The ladders are the numbers that already stand in the code (pass-failure-verdict.ts, persistence-policy.ts, wake-arbiter.ts):
 *   rung "transient" (1) 30 s, 2 min, 8 min, then the next rung;
 *   rung "outside"   (2) 30 min, 2 h, 6 h, then every 6 h (a provider's limit or sign-in: the app never gives up, four looks a day);
 *   rung "inside"    (3) 5 min, 30 min, then every hour (a cause inside the app).
 * The key of a count is (Goal, cause code); sameCauseFailureStreak (long-run/wake-arbiter.ts) computes it from the run journal, so no
 * counter column exists. What resets it: a completed turn, another cause, the owner's word or button, a new launch of the app.
 */
import { NO_PROGRESS_RETRY_LIMIT } from "../../shared/long-run-checkpoint";
import { appSideRunFailure } from "../../shared/run-failure-cause";
import { isContextOverflowFailure } from "../runtime/session-generation";

/** The six actions of the table. */
export type HarnessActionKind = "start" | "start_other_runtime" | "wait" | "owner_wait" | "close" | "none";

export type HarnessLadder = "transient" | "outside" | "inside";

/** Repairs the host makes before a start, as typed names (never prose). */
export type HarnessRepair =
  /** A worker attempt still says "running" but no turn of this Goal lives: settle it as interrupted first (defect 5). */
  | "settle_attempt"
  /** The Goal sits in a status no process owns (verifying, waiting_worker, waiting_user, a waiting_tool with nothing behind it): put it back to running. */
  | "unstick_status"
  /** A transition that never finished (pausing, cancelling) is finished: cancelling ends as cancelled. */
  | "finish_transition";

export type HarnessWaitFor =
  | { kind: "ladder"; ladder: HarnessLadder; delayMs: number }
  /** A time somebody else named: the provider's reset, the daily wall's end, a timer wait. */
  | { kind: "at"; at: string }
  /** The thing waited on ends (a registered wait's subject, a login coming back): that signal wakes the Goal. */
  | { kind: "signal"; signal: "registered_wait" | "app_start" | "login_recovered" | "runtime_signal" };

export type HarnessCard =
  /** The Goal has no recorded owner instruction: the owner's word or Resume is the grant (rule R-a). */
  | "grant"
  /** A replay barrier: only the owner's Resume releases it (rule R-a). */
  | "barrier"
  /** The runtime's sign-in is gone and no other runtime can take the turn. */
  | "login"
  /** The app has an "app problem" line and a defect-report button, no question. */
  | "app_problem";

export interface HarnessDecision {
  action: HarnessActionKind;
  /** The row of the table that decided, as a stable id (tests and the audit read this, nothing else does). */
  row: string;
  wait?: HarnessWaitFor;
  card?: HarnessCard;
  repair?: HarnessRepair;
  /** "start" only: begin a new session generation instead of resuming the old one (a context-window overflow). */
  freshSession?: boolean;
}

/** Statuses a Goal never leaves on its own: a finished Goal. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface GoalStateFacts {
  /** The Goal's chat is gone (long_runs.root_chat_id is null and no chat holds the Goal id). */
  chatGone: boolean;
  status: string;
  pauseReason: string | null;
  /** The owner stopped it (longRunOwnerHold). */
  ownerHold: boolean;
  /** The Goal asked a question and rests for the answer (goalOwnerAnswerHold). */
  answerHold: boolean;
  /** No owner instruction is recorded for the Goal (no goal revision: GOAL_OWNER_GRANT_REQUIRED). */
  grantMissing: boolean;
  /** automaticGoalReplayBlockerCode(run) !== null. */
  replayBarrier: boolean;
  /** A registered wait is pending or claimed (latestGoalWaitSubscription). */
  registeredWait: boolean;
  /** When the registered wait looks next, if it says (ISO). */
  registeredWaitAt?: string | null;
  /** The daily wake wall is reached; ISO time it frees. */
  dailyWallUntil?: string | null;
  /** A retry the host scheduled and nobody started (pendingBlockedGoalRetry !== null). */
  scheduledRetry: boolean;
  /** A worker attempt (not a verifier) is "running". */
  attemptRunning: boolean;
  /** A turn of this Goal lives now: in this process, or another process holds the chat's lease. */
  turnLive: boolean;
  /** The Goal sits in a blocked_reason this table owns elsewhere (an owner-card code): not an orphan. */
  restingOnOwnerCode?: boolean;
}

const DRAFT_ROW = "draft_is_owners_start";

/**
 * Table 1. First matching row wins. Returns null when the state alone does not decide (the Goal is in a runnable shape and the last
 * turn tells what to do).
 */
export function decideGoalState(f: GoalStateFacts): HarnessDecision | null {
  if (TERMINAL.has(f.status)) return { action: "none", row: "terminal" };
  if (f.chatGone) return { action: "close", row: "conversation_gone" };
  // Terminal actions never wait on another state: a cancelling Goal ends even when a turn still shows.
  if (f.status === "cancelling") return { action: "close", row: "cancelling", repair: "finish_transition" };
  if (f.ownerHold || (f.status === "paused" && f.pauseReason === "user")) return { action: "none", row: "owner_stopped" };
  if (f.status === "pausing" && f.pauseReason === "user") return { action: "none", row: "owner_stopped_pausing" };
  // "pausing" is a pause whose transition has not finished: it carries the same reason and is read the same way.
  const pausing = f.status === "paused" || f.status === "pausing";
  if (pausing && f.pauseReason === "budget") return { action: "owner_wait", row: "paused_budget" };
  if (pausing && f.pauseReason === "approval_required") return { action: "owner_wait", row: "paused_approval" };
  // A pause the agent or the Science projection chose is that domain's own state; One and Work never write it.
  if (pausing && f.pauseReason === "agent_paused") return { action: "none", row: "paused_agent_domain" };
  if (f.answerHold) return { action: "owner_wait", row: "owner_answer_pending" };
  // A turn of the Goal lives (its own, the owner's in the same room, or another process's under the room's lease): it is the one thing
  // that may speak for the Goal, and the owner's own turn is the grant a missing one waits for. Nothing below applies while it lives.
  if (f.turnLive) return { action: "none", row: "turn_live" };
  if (f.grantMissing) return { action: "owner_wait", row: "grant_missing", card: "grant" };
  // The barrier is the owner's decision and the app never reopens it on its own; the card is asked at once, not after a wait.
  if (f.replayBarrier) return { action: "owner_wait", row: "replay_barrier", card: "barrier" };
  if (f.registeredWait) {
    return { action: "wait", row: "registered_wait",
      wait: f.registeredWaitAt ? { kind: "at", at: f.registeredWaitAt } : { kind: "signal", signal: "registered_wait" } };
  }
  if (f.dailyWallUntil) return { action: "wait", row: "daily_wake_wall", wait: { kind: "at", at: f.dailyWallUntil } };
  // From here the Goal is in no state anyone owns, unless a retry of the host rests on it.
  if (f.attemptRunning) return { action: "start", row: "attempt_never_closed", repair: "settle_attempt" };
  if (f.status === "draft") return { action: "none", row: DRAFT_ROW };
  if (f.scheduledRetry) return null;
  const ownerless = ["verifying", "waiting_worker", "waiting_user"].includes(f.status)
    || (f.status === "waiting_tool" && !f.restingOnOwnerCode)
    || f.status === "pausing";
  if (ownerless) return { action: "start", row: "status_without_owner", repair: f.status === "pausing" ? "finish_transition" : "unstick_status" };
  return null;
}

export type TurnEnd =
  /** Ended normally. */
  | { kind: "completed"; verification?: "again" | "passed" | "judged_done" | null;
      /** Verification results with the same digest as the one before it, in a row (long-run/goal-no-progress-wait.ts). */
      sameDigestInARow?: number }
  | { kind: "cancelled"; hostStopCause?: string | null }
  | { kind: "interrupted"; hostStopCause?: string | null }
  /** No end line, or the process that ran it is gone (a daemon that vanished). */
  | { kind: "none" }
  | { kind: "failed"; hostStopCause?: string | null;
      /** RunnerFailureKind when the run carries a typed one. */
      runtimeFailureKind?: string | null;
      contextOverflow?: boolean;
      appSide?: boolean;
      /** The run failure code; compared as a whole word with closed lists by the caller, never searched for text. */
      errorKnown?: boolean };

export interface LastTurnFacts {
  end: TurnEnd;
  /** Consecutive failed host starts with this one cause (sameCauseFailureStreak), counting the one that just ended. */
  failureStreak: number;
  /** The provider's own reset time for a limit, if it gave one (ISO). */
  providerResetAt?: string | null;
  /** The owner's pool has a runtime that is not cooling down (runtime/selection.ts). */
  otherRuntimeAvailable: boolean;
  /** Transient retries the turn already made inside itself. */
  transientRetriesInTurn: number;
  /** Consecutive wakes of this Goal that ended without finishing (the app closing twice in a row). */
  unfinishedWakesInARow: number;
  /** A context overflow already got its one fresh session. */
  freshSessionTried: boolean;
}

const LADDER_MS: Record<HarnessLadder, readonly number[]> = Object.freeze({
  transient: [30_000, 2 * 60_000, 8 * 60_000],
  outside: [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000],
  inside: [5 * 60_000, 30 * 60_000, 3_600_000],
});
/** Past the last step a rung repeats: outside every 6 h, inside every hour; the transient rung hands over to the outside rung. */
const LADDER_REPEAT_MS: Record<HarnessLadder, number> = { transient: 6 * 3_600_000, outside: 6 * 3_600_000, inside: 3_600_000 };

/** The wait after `streak` consecutive failures with one cause on a rung (streak 1 = the first failure). */
export function ladderDelayMs(ladder: HarnessLadder, streak: number): number {
  const steps = LADDER_MS[ladder];
  const index = Math.max(1, Math.floor(streak)) - 1;
  return index < steps.length ? steps[index]! : LADDER_REPEAT_MS[ladder];
}

function rung(ladder: HarnessLadder, streak: number, row: string, extra: Partial<HarnessDecision> = {}): HarnessDecision {
  // The transient rung ends after its three steps: the cause is then treated as outside the app, on the outside rung's first step.
  if (ladder === "transient" && streak > LADDER_MS.transient.length) {
    return { action: "wait", row, wait: { kind: "ladder", ladder: "outside", delayMs: ladderDelayMs("outside", streak - LADDER_MS.transient.length) }, ...extra };
  }
  return { action: "wait", row, wait: { kind: "ladder", ladder, delayMs: ladderDelayMs(ladder, streak) }, ...extra };
}

/** Table 2. Total: every input has an answer, and the last row is a wait, never `owner_wait` and never `close`. */
export function decideLastTurn(f: LastTurnFacts): HarnessDecision {
  const end = f.end;
  const streak = Math.max(1, f.failureStreak);
  if (end.kind === "completed") {
    if (end.verification === "passed" || end.verification === "judged_done") return { action: "close", row: "goal_done" };
    // The same verification result a second time in a row: the result already went to the owner; wait for a signal, no card.
    if ((end.sameDigestInARow ?? 0) >= NO_PROGRESS_RETRY_LIMIT) {
      return { action: "wait", row: "no_progress", wait: { kind: "signal", signal: "runtime_signal" } };
    }
    return { action: "start", row: "continue" };
  }
  if (end.kind === "cancelled" || end.kind === "interrupted" || end.kind === "failed" || end.kind === "none") {
    const stop = end.kind === "none" ? null : end.hostStopCause ?? null;
    if (stop === "goal_paused_by_user") return { action: "none", row: "stopped_by_owner" };
    if (stop === "goal_deleted_by_user") return { action: "close", row: "deleted_by_owner" };
    if (end.kind === "cancelled" && stop === null) return { action: "close", row: "cancelled" };
    if (stop === "app_closed" || stop === "update_restart" || end.kind === "none" || (end.kind === "interrupted" && stop === null)) {
      // The app's start signal resumes once; two interrupted wakes in a row mean the turn itself kills the app: the inside rung.
      if (f.unfinishedWakesInARow >= 2) return rung("inside", f.unfinishedWakesInARow - 1, "host_interrupted_twice");
      return { action: "start", row: "host_interrupted", wait: { kind: "signal", signal: "app_start" } };
    }
  }
  if (end.kind !== "failed") return rung("inside", streak, "unknown_end");
  const kind = end.runtimeFailureKind ?? null;
  if (kind === "quota" || kind === "rate_limit") {
    if (f.otherRuntimeAvailable) return { action: "start_other_runtime", row: "limit_other_runtime" };
    if (f.providerResetAt) return { action: "wait", row: "limit_reset_time", wait: { kind: "at", at: f.providerResetAt } };
    return rung("outside", streak, "limit_no_time");
  }
  if (kind === "auth") {
    if (f.otherRuntimeAvailable) return { action: "start_other_runtime", row: "auth_other_runtime" };
    return { action: "owner_wait", row: "auth_no_runtime", card: "login", wait: { kind: "signal", signal: "login_recovered" } };
  }
  if (end.contextOverflow) {
    return f.freshSessionTried ? rung("inside", streak, "context_again")
      : { action: "start", row: "context_overflow", freshSession: true };
  }
  if (kind === "timeout" || kind === "unavailable" || kind === "empty" || kind === "exit") {
    // Ladder 1 first (skipped when the turn already retried three times inside itself), then another runtime, then ladder 2.
    if (f.transientRetriesInTurn < 3 && streak <= LADDER_MS.transient.length) return rung("transient", streak, "transient");
    if (f.otherRuntimeAvailable) return { action: "start_other_runtime", row: "transient_other_runtime" };
    return rung("outside", Math.max(1, streak - (f.transientRetriesInTurn < 3 ? LADDER_MS.transient.length : 0)), "transient_exhausted");
  }
  if (kind === "refused" || kind === "unsupported") {
    if (f.otherRuntimeAvailable) return { action: "start_other_runtime", row: "refused_other_runtime" };
    return rung("inside", streak, "refused_no_runtime");
  }
  if (end.appSide) return rung("inside", streak, "app_defect", { card: "app_problem" });
  // Unknown code, no code, a shape that does not fit: ask nobody, stand nowhere.
  return rung("inside", streak, "unknown");
}

const RUNNER_FAILURE_KINDS: ReadonlySet<string> = new Set(["quota", "rate_limit", "auth", "refused", "empty", "exit", "timeout", "unavailable", "unsupported"]);
const HOST_STOP_CAUSES: ReadonlySet<string> = new Set(["app_closed", "update_restart", "goal_paused_by_user", "goal_deleted_by_user"]);
/** A managed adapter's own typed refusals for "the input does not fit the window" (long-run/pass-failure-verdict.ts modelContextFailureReason). */
const MANAGED_CONTEXT_CODES: ReadonlySet<string> = new Set(["model_context_capacity_exceeded", "local_context_limit_exceeded"]);

/**
 * A recorded terminal line of a turn (the run event `invoke_*` and its payload fields, as store/run-events keeps them) as the table's
 * closed input. Only typed fields are read: the kind of the event, hostStopCause, runtimeFailureKind/Source/ProviderCode, errorCode as a
 * whole word for the app-side families. No message text is ever looked at. A field outside its closed list reads as absent, which sends
 * the line to the last row of the table (a wait on the app-side ladder), never to a question.
 */
export function turnEndFromTerminalEvent(kind: string | null | undefined, payload: Record<string, unknown> | null | undefined): TurnEnd {
  const p = payload && typeof payload === "object" ? payload : {};
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const stopRaw = text(p.hostStopCause);
  const hostStopCause = stopRaw && HOST_STOP_CAUSES.has(stopRaw) ? stopRaw : null;
  if (kind === "invoke_completed") return { kind: "completed" };
  if (kind === "invoke_cancelled") return { kind: "cancelled", hostStopCause };
  if (kind === "invoke_interrupted") return { kind: "interrupted", hostStopCause };
  if (kind !== "invoke_failed" && kind !== "invoke_threw") return { kind: "none" };
  const kindRaw = text(p.runtimeFailureKind);
  const source = text(p.runtimeFailureSource);
  // A kind the runner only guessed from prose (source "heuristic") is not a typed fact: it does not pick a row.
  const runtimeFailureKind = kindRaw && RUNNER_FAILURE_KINDS.has(kindRaw) && source !== "heuristic" ? kindRaw : null;
  const providerCode = text(p.runtimeFailureProviderCode);
  const contextOverflow = source === "marker" && Boolean(providerCode)
    && (isContextOverflowFailure({ providerCode: providerCode ?? undefined }) || (kindRaw === "refused" && MANAGED_CONTEXT_CODES.has(providerCode!)));
  const runtimeFailure = kindRaw ? { kind: kindRaw, ...(source ? { source } : {}), ...(providerCode ? { providerCode } : {}) } : null;
  const appSide = appSideRunFailure(text(p.errorCode), runtimeFailure as never) !== null;
  return { kind: "failed", hostStopCause, runtimeFailureKind, contextOverflow, appSide };
}

/** The whole table: the Goal's state first, then the last turn. */
export function decideHarnessNext(state: GoalStateFacts, last: LastTurnFacts | null): HarnessDecision {
  return decideGoalState(state) ?? (last ? decideLastTurn(last) : { action: "start", row: "continue" });
}

/** Closed list of every row id, for the tests that prove each row is reachable. */
export const HARNESS_STATE_ROWS: readonly string[] = Object.freeze([
  "terminal", "conversation_gone", "cancelling", "owner_stopped", "owner_stopped_pausing", "paused_budget", "paused_approval",
  "paused_agent_domain", "owner_answer_pending", "grant_missing", "replay_barrier", "turn_live", "registered_wait", "daily_wake_wall",
  "attempt_never_closed", DRAFT_ROW, "status_without_owner",
]);
export const HARNESS_TURN_ROWS: readonly string[] = Object.freeze([
  "goal_done", "no_progress", "continue", "stopped_by_owner", "deleted_by_owner", "cancelled", "host_interrupted", "host_interrupted_twice",
  "limit_other_runtime", "limit_reset_time", "limit_no_time", "auth_other_runtime", "auth_no_runtime", "context_overflow", "context_again",
  "transient", "transient_other_runtime", "transient_exhausted", "refused_other_runtime", "refused_no_runtime", "app_defect", "unknown",
  "unknown_end",
]);
