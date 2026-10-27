import { currentGoalExecutionObligations, currentGoalObligationsSatisfied } from "./goal-obligation-context";
/** An automatic Goal admitted for a turn the background service ran follows that turn.
 *
 * Goal custody is Desktop-only, so a goal-free One turn that runs in the service (team rooms included) finishes there as an
 * ordinary turn and only its intake moves to Main (goal-intake-forward.ts). Main then admitted the Goal as `queued` and nothing
 * ever moved it: production 2026-10-15T23:12Z, rooms fc53939f (AB-GPT) and a1ab9a72 (AB-Light). The team runs executed and
 * failed with task-force-verification-failed, yet both long_runs stayed queued with started_at empty, both contracts stayed
 * active, and the rooms stayed bound, so the next owner message was attached to a Goal whose run had long ended and the AGI
 * monitor reported a failed run for a Goal that "never started".
 *
 * The turn is the Goal's only run, so the Goal follows it, in the existing vocabulary and only for a finite Goal (a continuous
 * Goal keeps its own episode loop):
 *  - the turn is live  -> running (the run started)
 *  - invoke_completed (team run: verifier passed) -> verifying -> completed, contract completed, room unbound
 *  - a bounded series ("1시간에 1회씩 최대 10개": the revision carries a cadence, shared/auto-goal.ts GoalCadence): the turn was the
 *    series' first run, not the Goal, so no outcome of that turn but the owner's own stop ends it. The Goal rests on a host-owned
 *    schedule (waiting_tool + a retry one interval after the turn ended, store/long-runs.ts scheduleBlockedGoalRetry) and the
 *    sweep resumes it as an ordinary Goal turn on Desktop, where timer waits are allowed up to the series' end
 *    (goal-deadline.ts). Contract and room binding stay. That holds when the turn finished, when the team left work, and when it
 *    FAILED for any typed cause (quota, login, a refusal, a provider or app failure) or was interrupted by the app closing: the
 *    run missed its slot and the next cycle tries again (owner 2026-10-21, X marketing room: "failures and quota are held and
 *    retried next cycle, never cancelled"). One exception: a turn that ended on a question card (invoke_completed with
 *    decisionRequested) waits for the owner's answer instead, the same hold a question takes, because the next cycle must never
 *    act on a request nobody has approved (real posting on the owner's account starts only after the owner's approval).
 *  - a team run that did not verify (invoke_failed task-force-verification-failed, or invoke_completed with a failed team
 *    verifier): work is left, and the room already told the owner what and that saying "continue" picks it up
 *    (borrowed-task-force.ts taskForceIncompleteMessage) -> held for the owner's answer: the same hold a question card takes
 *    (waiting_tool + goal_owner_answer_required). Contract and room binding stay, nothing wakes the Goal, and the owner's next
 *    message, "continue" included, resumes THIS Goal (stoppedGoalMessageReopens). Owner 2026-10-21, X marketing room: the Goal
 *    used to be cancelled 31 s after such a turn and the room's promise ended up false.
 *  - invoke_failed / invoke_threw for any other cause (a refusal, a provider or app failure) of a Goal that is not a series ->
 *    cancelling -> cancelled, contract cancelled, room unbound (the service has no controller that could retry it; the owner's
 *    next message starts a fresh Goal). Only the typed unverified-team code holds; no failure is read by its words.
 *  - invoke_cancelled -> owner pause (also for a series); invoke_interrupted -> host pause (app_closed) except for a series, which
 *    takes its next slot; both pauses resume on the owner's next message
 * A Goal the host parked (paused app_closed / crash_recovery) while the turn ran on is followed too, from queued: the pause came from
 * Desktop quitting or restarting, not from the turn (an interrupted turn leaves that pause standing).
 * Idempotent and fenced: it acts only on a Goal nothing else has taken over (no controller attempt, no newer live turn in the
 * chat, no owner hold), and a repeated call finds the Goal already settled.
 *
 * No electron import: the background service loads this without Electron (test-daemon-loads-without-electron). */
import { goalHeldForOwnerAnswer } from "../../shared/goal-display-state";
import { LONG_RUN_TERMINAL_STATUSES } from "../../shared/long-run";
import { completeChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { desktopAppInstanceId } from "./app-runtime-coordinator";
import { getChat, setChatGoalBinding } from "../store/chats";
import { getDb } from "../store/db";
import {
  appendLongRunEvent, getLongRunByGoalId, holdGoalForOwnerAnswer, liveLongRunAttemptCount, longRunOwnerHold, pendingBlockedGoalRetry,
  scheduleBlockedGoalRetry, transitionLongRun, type LongRunRecord,
} from "../store/long-runs";

export const DAEMON_TURN_GOAL_SETTLED_EVENT = "run.daemon_turn_settled";
const AUTO_GOAL_PREFIX = "goal:auto-message:";
const SUCCESS_KINDS = ["invoke_completed"];
const FAILURE_KINDS = ["invoke_failed", "invoke_threw"];
const STOP_KINDS = ["invoke_cancelled", "invoke_interrupted"];
const TERMINAL_KINDS = [...SUCCESS_KINDS, ...FAILURE_KINDS, ...STOP_KINDS];
/** The code a team run's error carries when its execution did not verify (mcp/client.ts runBoundTaskForceInvocation; the gate
 * asserts both files still agree). A typed code, never the reply's words. */
export const TASK_FORCE_UNVERIFIED_CODE = "task-force-verification-failed";

export type DaemonTurnGoalAction =
  | "started" | "completed" | "held" | "scheduled" | "cancelled" | "paused" | "unchanged" | "skipped";
export interface DaemonTurnGoalResult { goalId: string; action: DaemonTurnGoalAction; detail: string }

const result = (goalId: string, action: DaemonTurnGoalAction, detail: string): DaemonTurnGoalResult => ({ goalId, action, detail });

/** The service run Main admitted this Goal for: the run named by the admitted intake marker, owned by a daemon lease. */
function sourceDaemonRun(run: LongRunRecord): { runId: string; ended: boolean; ownerId: string } | null {
  if (!run.rootChatId) return null;
  const db = getDb();
  const marker = db.prepare(`SELECT run_id FROM run_events WHERE kind = 'automatic_goal_intake_completed' AND chat_id = ?
      AND json_extract(payload_json, '$.goalId') = ? AND json_extract(payload_json, '$.outcome') = 'admitted'
      ORDER BY ts ASC LIMIT 1`).get(run.rootChatId, run.goalId) as { run_id: string } | undefined;
  if (!marker) return null;
  const owner = db.prepare("SELECT owner_kind, owner_id, chat_id, state FROM invocation_run_owners WHERE run_id = ?").get(marker.run_id) as
    { owner_kind: string; owner_id: string; chat_id: string; state: string } | undefined;
  if (!owner || owner.owner_kind !== "daemon" || owner.chat_id !== run.rootChatId) return null;
  return { runId: marker.run_id, ended: owner.state === "released", ownerId: owner.owner_id };
}

/** Pause reasons the host itself writes when its process ends (app quit, restart recovery). A Goal parked there is the host's to
 * settle, unlike a pause the owner or a blocker wrote. */
const HOST_PAUSE_REASONS = new Set(["app_closed", "crash_recovery"]);

/** The user message a service run answers: the row it bound as its prompt or, for a retry or recovery that appends none, the
 * latest user row it started from. A new owner message always binds its own row first, so it is never mistaken for a retry. */
function promptMessageOfRun(runId: string): string | null {
  const db = getDb();
  const bound = db.prepare(`SELECT json_extract(payload_json, '$.promptMessageId') AS id FROM run_events
      WHERE run_id = ? AND kind = 'invoke_prompt_bound' ORDER BY seq LIMIT 1`).get(runId) as { id: string | null } | undefined;
  if (bound?.id) return bound.id;
  const started = db.prepare(`SELECT json_extract(payload_json, '$.latestUserMessageRowId') AS row FROM run_events
      WHERE run_id = ? AND kind = 'invoke_started' ORDER BY seq LIMIT 1`).get(runId) as { row: number | null } | undefined;
  if (typeof started?.row !== "number") return null;
  const message = db.prepare("SELECT id FROM chat_messages WHERE rowid = ? AND role = 'user'").get(started.row) as { id: string } | undefined;
  return message?.id ?? null;
}

/** True when Main admitted `goalId` for the user message the service run `runId` answers. Such a Goal follows every service run
 * of that message (the first one, and the host's retries and recoveries of it, followDaemonTurnGoal), so none of them holds
 * producer custody or is refused for lacking it. A Goal admitted for another message is not covered. */
export function goalAdmittedForServiceRun(runId: string, goalId: string): boolean {
  if (!goalId.startsWith(AUTO_GOAL_PREFIX) || promptMessageOfRun(runId) !== goalId.slice(AUTO_GOAL_PREFIX.length)) return false;
  return getDb().prepare(`SELECT 1 FROM run_events WHERE kind = 'automatic_goal_intake_completed'
      AND json_extract(payload_json, '$.goalId') = ? AND json_extract(payload_json, '$.outcome') = 'admitted' LIMIT 1`)
    .get(goalId) !== undefined;
}

/** A turn of the same chat that started after the service run and is still live: it owns the room now. */
function newerLiveTurn(chatId: string, sourceRunId: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM invocation_run_owners WHERE chat_id = ? AND run_id != ? AND state != 'released'
      AND created_at >= (SELECT created_at FROM invocation_run_owners WHERE run_id = ?) LIMIT 1`).get(chatId, sourceRunId, sourceRunId);
  return !!row;
}

interface DaemonTurnTerminal {
  kind: string;
  errorCode: string | null;
  verifier: string | null;
  at: string | null;
  /** The turn ended on a question card for the owner (invocation/service.ts seals invoke_completed with decisionRequested). */
  decisionRequested: boolean;
  /** A team run that left work only for a reason nobody has to answer (see selfRecoverableTeamFailure), and how long to wait first. */
  selfRecoverable: boolean;
  retryAfterMs: number | null;
}

/** A team run that left work for a reason nobody has to answer: every root cause (one not merely blocked by another) is a wait for
 * capacity or a retry of a preparation that never reached a provider, and no external effect may have happened. Read from the typed
 * failure report in the run ledger, never from words. Anything else (authority, a decision, an unknown effect, no report) is the
 * owner's to answer. */
function selfRecoverableTeamFailure(report: unknown): { selfRecoverable: boolean; retryAfterMs: number | null } {
  const none = { selfRecoverable: false, retryAfterMs: null };
  if (!report || typeof report !== "object") return none;
  const { causes, effects } = report as { causes?: unknown; effects?: unknown };
  if (!Array.isArray(causes) || !Array.isArray(effects)) return none;
  const roots = (causes as Array<Record<string, unknown> | null>).filter((cause): cause is Record<string, unknown> =>
    !!cause && typeof cause === "object" && !(Array.isArray(cause.blockedBy) && cause.blockedBy.length > 0));
  if (!roots.length || !roots.every((cause) => cause.recovery === "wait-capacity" || cause.recovery === "retry-preparation")) return none;
  if ((effects as Array<Record<string, unknown> | null>).some((effect) => !!effect && ["attempted", "uncertain"].includes(String(effect.state)))) return none;
  let wait = 0;
  for (const cause of roots) {
    const hinted = typeof cause.retryAfterHint === "string" ? Date.parse(cause.retryAfterHint) - Date.now() : Number.NaN;
    const ms = typeof cause.retryAfterMs === "number" && Number.isFinite(cause.retryAfterMs) ? cause.retryAfterMs : Number.isFinite(hinted) ? hinted : 0;
    wait = Math.max(wait, ms);
  }
  return { selfRecoverable: true, retryAfterMs: wait > 0 ? wait : null };
}

function terminalOf(runId: string): DaemonTurnTerminal | null {
  const db = getDb();
  const marks = TERMINAL_KINDS.map(() => "?").join(",");
  const terminal = db.prepare(`SELECT kind, payload_json, ts FROM run_events WHERE run_id = ? AND kind IN (${marks}) ORDER BY ts DESC, seq DESC LIMIT 1`)
    .get(runId, ...TERMINAL_KINDS) as { kind: string; payload_json: string; ts: string | null } | undefined;
  if (!terminal) return null;
  let errorCode: string | null = null;
  let decisionRequested = false;
  try {
    const payload = JSON.parse(terminal.payload_json) as { errorCode?: unknown; decisionRequested?: unknown };
    if (typeof payload.errorCode === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(payload.errorCode)) errorCode = payload.errorCode;
    decisionRequested = payload.decisionRequested === true;
  } catch { /* the kind alone decides */ }
  // A team run carries its own verifier verdict; a failed verdict is not a completed run even when the turn returned.
  const receipt = db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'task_force_execution_receipt' ORDER BY ts DESC, seq DESC LIMIT 1")
    .get(runId) as { payload_json: string } | undefined;
  let verifier: string | null = null;
  let recoverable: { selfRecoverable: boolean; retryAfterMs: number | null } = { selfRecoverable: false, retryAfterMs: null };
  if (receipt) {
    try {
      const payload = JSON.parse(receipt.payload_json) as { verifierStatus?: unknown; failureReport?: unknown };
      if (typeof payload.verifierStatus === "string") verifier = payload.verifierStatus;
      recoverable = selfRecoverableTeamFailure(payload.failureReport);
    } catch { /* no verdict */ }
  }
  return { kind: terminal.kind, errorCode, verifier, at: typeof terminal.ts === "string" ? terminal.ts : null, decisionRequested, ...recoverable };
}

/** A team run that ended with work left: the typed unverified-team code, or a turn that returned with a failed team verifier. */
function taskForceLeftWork(terminal: { kind: string; errorCode: string | null; verifier: string | null }): boolean {
  return (SUCCESS_KINDS.includes(terminal.kind) && terminal.verifier === "fail")
    || (terminal.kind === "invoke_failed" && terminal.errorCode === TASK_FORCE_UNVERIFIED_CODE);
}

function releaseChat(chatId: string, goalId: string): void {
  if (getChat(chatId)?.goalId === goalId) setChatGoalBinding(chatId, null);
}

function recordSettlement(run: LongRunRecord, sourceRunId: string, outcome: string, extra: Record<string, unknown> = {}): void {
  appendLongRunEvent({ runId: run.id, kind: DAEMON_TURN_GOAL_SETTLED_EVENT, actorKind: "host",
    payload: { invocationRunId: sourceRunId, outcome, ...extra } });
}

/** The Goal and the service run it follows, or the reason it is not this follower's to move. One definition for the follower and for
 * the Desktop startup recovery, so the two never disagree about which Goals are the follower's. */
function followTarget(goalId: string): { run: LongRunRecord; chatId: string; source: { runId: string; ended: boolean; ownerId: string } } | DaemonTurnGoalResult {
  if (!goalId.startsWith(AUTO_GOAL_PREFIX)) return result(goalId, "skipped", "not_automatic_goal");
  const run = getLongRunByGoalId(goalId);
  if (!run || LONG_RUN_TERMINAL_STATUSES.has(run.status)) return result(goalId, "skipped", "goal_terminal_or_missing");
  if (run.surface === "science" || run.hostOwnerKind !== "desktop" || !run.rootChatId) return result(goalId, "skipped", "not_desktop_room_goal");
  // A Goal the host parked because Desktop quit or restarted (an older release paused it on every startup, the quit path still does)
  // is followed too: its service turn went on without Desktop, and left parked the Goal became a resume candidate that redid the
  // finished work. A pause the owner or a blocker wrote is theirs and stays.
  const hostParked = run.status === "paused" && HOST_PAUSE_REASONS.has(run.pauseReason ?? "");
  if (!["queued", "running"].includes(run.status) && !hostParked) return result(goalId, "skipped", "status_not_followed");
  if (getChatGoalRevision(goalId)?.lifecycle !== "finite") return result(goalId, "skipped", "not_finite");
  const source = sourceDaemonRun(run);
  if (!source) return result(goalId, "skipped", "not_daemon_turn_goal");
  // Something else already works this Goal (a Desktop controller turn, the owner's pause): it is theirs to settle.
  if (run.cycleCount > 0 || liveLongRunAttemptCount(run.id) > 0 || longRunOwnerHold(run.id)) return result(goalId, "skipped", "goal_has_other_owner");
  if (getDb().prepare("SELECT 1 FROM long_run_worker_attempts WHERE run_id = ? LIMIT 1").get(run.id)) return result(goalId, "skipped", "goal_has_controller_attempt");
  if (newerLiveTurn(run.rootChatId, source.runId)) return result(goalId, "skipped", "newer_turn_live");
  return { run, chatId: run.rootChatId, source };
}

/** True when the follower will close this Goal on its next pass: its only run was a service turn that has already ended with a
 * terminal event. Desktop startup recovery leaves such a Goal queued/running instead of pausing it as crash_recovery - the pause
 * took it out of the follower's reach, and the host then started a new Main episode that redid work the service had finished
 * (an extra write-permission turn nobody asked for). A service turn that ended without a terminal event is not covered: its Goal
 * keeps the ordinary recovery.
 *
 * A service turn that is STILL running is covered when the service that owns it is the one this Desktop just reattached to
 * (`liveDaemonBootId`, the boot id its ping named; the run's lease names the same boot, as run-events.ts daemonOwnsLiveRun reads it).
 * The Desktop's empty activeRuns says nothing about a turn another process hosts: pausing that Goal as crash_recovery let the
 * startup resume start a second turn on top of the live one, or redo the work once it finished. Without that proof (no service, or
 * a lease of an earlier boot whose process is gone) a non-released lease is stale and the Goal keeps the ordinary recovery. */
export function serviceTurnGoalAwaitsFollower(goalId: string, options: { liveDaemonBootId?: string | null } = {}): boolean {
  const target = followTarget(goalId);
  if ("action" in target) return false;
  if (!target.source.ended) return Boolean(options.liveDaemonBootId) && target.source.ownerId === options.liveDaemonBootId;
  return terminalOf(target.source.runId) !== null;
}

/** Move one Goal along its service turn. Safe to call at any time and from any process that shares the store. */
export function followDaemonTurnGoal(goalId: string): DaemonTurnGoalResult {
  const target = followTarget(goalId);
  if ("action" in target) return target;
  let run = target.run;
  const { source, chatId } = target;
  // The service (another process) may still be writing its own turn tail into this ledger: fence each step on a fresh read.
  const step = (to: Parameters<typeof transitionLongRun>[0]["to"], reason: string, actorKind: "host" | "user" = "host"): LongRunRecord => {
    for (let attempt = 0; ; attempt += 1) {
      const fresh = getLongRunByGoalId(goalId);
      if (!fresh || LONG_RUN_TERMINAL_STATUSES.has(fresh.status) || longRunOwnerHold(fresh.id) && actorKind !== "user") throw new Error("daemon_turn_goal_state_changed");
      try { run = transitionLongRun({ runId: fresh.id, to, actorKind, reason, expectedVersion: fresh.version }); return run; }
      catch (error) {
        if (attempt >= 3 || !(error instanceof Error) || error.message !== "long_run_transition_version_conflict") throw error;
      }
    }
  };

  /** running -> waiting_tool holding for the owner's answer (store/long-runs.ts holdGoalForOwnerAnswer), fenced like step().
   * False when another process (Main's sweep, the owner's next turn) held it first: the hold is theirs and recorded once. */
  const hold = (): boolean => {
    for (let attempt = 0; ; attempt += 1) {
      const fresh = getLongRunByGoalId(goalId);
      if (!fresh || LONG_RUN_TERMINAL_STATUSES.has(fresh.status) || longRunOwnerHold(fresh.id)) throw new Error("daemon_turn_goal_state_changed");
      if (goalHeldForOwnerAnswer(fresh)) { run = fresh; return false; }
      try { run = holdGoalForOwnerAnswer({ runId: fresh.id, expectedVersion: fresh.version, invocationRunId: source.runId }); return true; }
      catch (error) {
        if (attempt >= 3 || !(error instanceof Error) || error.message !== "goal_owner_answer_hold_state_changed") throw error;
      }
    }
  };

  /** A bounded series: rest on the host's own schedule, the next run one interval after this one ended. False when another
   * process (Main's sweep, the owner's next turn) scheduled it first. */
  const scheduleNextRun = (nextAt: string, why = { fromReason: "series_next_run", detail: "series_interval", trigger: "daemon-turn-series" }): boolean => {
    for (let attempt = 0; ; attempt += 1) {
      const fresh = getLongRunByGoalId(goalId);
      if (!fresh || LONG_RUN_TERMINAL_STATUSES.has(fresh.status) || longRunOwnerHold(fresh.id)) throw new Error("daemon_turn_goal_state_changed");
      if (goalHeldForOwnerAnswer(fresh) || pendingBlockedGoalRetry(fresh.id)) return false;
      try {
        run = scheduleBlockedGoalRetry({ runId: fresh.id, expectedVersion: fresh.version, kind: "resume", fromReason: why.fromReason, retryIndex: 0,
          nextAt, detail: why.detail, trigger: why.trigger, requestedBy: "host", appInstanceId: desktopAppInstanceId() });
        return true;
      } catch (error) {
        if (attempt >= 3 || !(error instanceof Error) || error.message !== "blocked_goal_retry_state_changed") throw error;
      }
    }
  };

  if (!source.ended) {
    if (run.status === "queued") { step("running", "daemon-turn-started"); return result(goalId, "started", source.runId); }
    return result(goalId, "unchanged", "turn_live");
  }
  const terminal = terminalOf(source.runId);
  if (!terminal) return result(goalId, "skipped", "no_terminal_event");

  // A Goal the host parked (paused app_closed / crash_recovery) while its service turn ran on: an interrupted turn is exactly what
  // that pause says and its ordinary resume redoes the interrupted work, so it stands. Any other end settles it like a live Goal,
  // starting from queued (the only way out of paused for the host).
  if (run.status === "paused") {
    if (terminal.kind === "invoke_interrupted") return result(goalId, "skipped", "host_pause_stands");
    step("queued", "daemon-turn-adopted");
  }

  // A bounded series: this turn was its first run, whatever came of it (the series is the work that is left). Only the owner's
  // own stop (invoke_cancelled) leaves it to the pause below. A question card the turn ended on holds the Goal for the owner's
  // answer, like any question: scheduling would let the next cycle act on a request nobody has approved. Everything else --
  // finished, a team that left work, a verifier that failed, a failure of any typed cause (quota, login, a refusal, a provider or
  // app failure), the app closing under the turn -- takes the next slot: the host schedules the next run one interval after
  // this one ended and the sweep retries it then. Failures are never read by their words, only by their kind.
  const cadence = getChatGoalRevision(goalId)?.cadence;
  if (cadence && terminal.kind !== "invoke_cancelled") {
    if (run.status === "queued") step("running", "daemon-turn-started");
    if (SUCCESS_KINDS.includes(terminal.kind) && terminal.decisionRequested) {
      if (!hold()) return result(goalId, "unchanged", "held_by_another_process");
      recordSettlement(run, source.runId, "held_for_owner", { reason: "owner_question", series: true });
      return result(goalId, "held", source.runId);
    }
    const endedAt = terminal.at ? Date.parse(terminal.at) : Number.NaN;
    const nextAt = new Date(Math.max(Date.now(), (Number.isFinite(endedAt) ? endedAt : Date.now()) + cadence.everySeconds * 1_000)).toISOString();
    if (!scheduleNextRun(nextAt)) return result(goalId, "unchanged", "scheduled_by_another_process");
    const missed = SUCCESS_KINDS.includes(terminal.kind) ? null : terminal.kind;
    recordSettlement(run, source.runId, "series_next_run_scheduled", { nextAt, everySeconds: cadence.everySeconds, maxRuns: cadence.maxRuns,
      errorCode: terminal.errorCode, verifier: terminal.verifier, ...(missed ? { afterFailure: missed } : {}) });
    return result(goalId, "scheduled", nextAt);
  }
  if (SUCCESS_KINDS.includes(terminal.kind) && terminal.verifier !== "fail") {
    // A turn that ended on a question card is not a completion for any finite Goal: the owner's answer decides what comes next
    // (approval before a post, a choice), exactly as the Main host holds the Goal on a pending question (invocation/service.ts
    // holdGoalForOwnerAnswer) and as the series and obligation branches hold here. Completing it closed the contract and unbound the
    // room, so the owner's answer ran as an ordinary turn and could not continue the Goal.
    if (terminal.decisionRequested) {
      if (run.status === "queued") step("running", "daemon-turn-started");
      if (!hold()) return result(goalId, "unchanged", "held_by_another_process");
      recordSettlement(run, source.runId, "held_for_owner", { reason: "owner_question" });
      return result(goalId, "held", source.runId);
    }
    const goal = getChatGoalRevision(goalId);
    if (goal && currentGoalExecutionObligations(goal) && !currentGoalObligationsSatisfied(goalId)) {
      if (!scheduleNextRun(new Date().toISOString())) return result(goalId, "unchanged", "scheduled_by_another_process");
      recordSettlement(run, source.runId, "participant_review_required");
      return result(goalId, "scheduled", "goal_execution_obligations_unmet");
    }
    if (run.status === "queued") step("running", "daemon-turn-started");
    step("verifying", "daemon-turn-completed");
    appendLongRunEvent({ runId: run.id, kind: "verification.model_judgment_accepted", actorKind: "host",
      payload: { reason: "daemon_turn_completed", invocationRunId: source.runId, verifier: terminal.verifier } });
    step("completed", "daemon-turn-completed");
    completeChatGoalContract(goalId, "completed");
    releaseChat(chatId, goalId);
    recordSettlement(run, source.runId, "completed", { verifier: terminal.verifier });
    return result(goalId, "completed", source.runId);
  }
  // The team did not verify its work: what is left is the room's reply and "continue" is its promise, so the Goal keeps that promise
  // (held for the owner's answer, room still bound) instead of being cancelled out from under it.
  if (taskForceLeftWork(terminal)) {
    if (run.status === "queued") step("running", "daemon-turn-started");
    // Work left only for a reason nobody has to answer (a wait for capacity, a preparation that never reached a provider): the owner
    // is not asked. The Goal resumes by itself as an ordinary Goal turn after the wait, under that controller's own retry limits.
    if (terminal.selfRecoverable) {
      const waitMs = Math.min(Math.max(terminal.retryAfterMs ?? 60_000, 15_000), 15 * 60_000);
      const nextAt = new Date(Date.now() + waitMs).toISOString();
      if (!scheduleNextRun(nextAt, { fromReason: "task_force_capacity_wait", detail: "task_force_capacity_wait", trigger: "daemon-turn-goal" })) return result(goalId, "unchanged", "scheduled_by_another_process");
      recordSettlement(run, source.runId, "auto_retry_scheduled", { nextAt, errorCode: terminal.errorCode, verifier: terminal.verifier });
      return result(goalId, "scheduled", nextAt);
    }
    if (!hold()) return result(goalId, "unchanged", "held_by_another_process");
    recordSettlement(run, source.runId, "held_for_owner", { errorCode: terminal.errorCode, verifier: terminal.verifier });
    return result(goalId, "held", source.runId);
  }
  if (SUCCESS_KINDS.includes(terminal.kind) || FAILURE_KINDS.includes(terminal.kind)) {
    const reason = terminal.kind === "invoke_completed" ? "task_force_verifier_failed" : terminal.errorCode ?? "invocation_failed";
    step("cancelling", `daemon-turn-failed:${reason}`.slice(0, 200));
    step("cancelled", `daemon-turn-failed:${reason}`.slice(0, 200));
    completeChatGoalContract(goalId, "cancelled");
    releaseChat(chatId, goalId);
    recordSettlement(run, source.runId, "failed", { errorCode: terminal.errorCode, verifier: terminal.verifier });
    return result(goalId, "cancelled", reason);
  }
  // Stopped turns: the Goal rests where an owner stop (or the host closing) puts any Goal, and the next owner message resumes it.
  const ownerStop = terminal.kind === "invoke_cancelled";
  if (ownerStop) {
    appendLongRunEvent({ runId: run.id, kind: "run.user_control", actorKind: "user",
      payload: { action: "pause", source: "daemon-turn-stop", chatId, goalId, invocationRunId: source.runId } });
  }
  if (run.status === "running") step("pausing", ownerStop ? "user" : "app_closed", ownerStop ? "user" : "host");
  step("paused", ownerStop ? "user" : "app_closed", ownerStop ? "user" : "host");
  recordSettlement(run, source.runId, ownerStop ? "owner_stopped" : "interrupted");
  return result(goalId, "paused", terminal.kind);
}

/** The room's bound Goal, settled first when it belongs to an ended service turn. */
export function followDaemonTurnGoalOfChat(chatId: string): DaemonTurnGoalResult | null {
  const goalId = getChat(chatId)?.goalId;
  return goalId ? followDaemonTurnGoal(goalId) : null;
}

/** Every unsettled automatic Goal of a service turn (Main's periodic pass and attach). */
export function settleDaemonTurnGoals(limit = 50): DaemonTurnGoalResult[] {
  // Host-parked Goals (paused by Desktop quitting or restarting) count only when a service turn was admitted for them, and come
  // after the live ones so a pile of parked Goals never crowds a queued one out of the window.
  const rows = getDb().prepare(`SELECT goal_id FROM long_runs WHERE goal_id LIKE 'goal:auto-message:%'
      AND (status IN ('queued','running')
        OR (status = 'paused' AND pause_reason IN ('app_closed','crash_recovery')
          AND EXISTS (SELECT 1 FROM run_events m JOIN invocation_run_owners o ON o.run_id = m.run_id AND o.owner_kind = 'daemon'
            WHERE m.kind = 'automatic_goal_intake_completed' AND m.chat_id = long_runs.root_chat_id
              AND json_extract(m.payload_json, '$.goalId') = long_runs.goal_id AND json_extract(m.payload_json, '$.outcome') = 'admitted')))
      AND surface IN ('one','work') AND host_owner_kind = 'desktop' AND cycle_count = 0
      ORDER BY CASE WHEN status = 'paused' THEN 1 ELSE 0 END, updated_at ASC LIMIT ?`).all(limit) as Array<{ goal_id: string }>;
  const out: DaemonTurnGoalResult[] = [];
  for (const row of rows) {
    try {
      const r = followDaemonTurnGoal(row.goal_id);
      if (r.action !== "skipped" && r.action !== "unchanged") out.push(r);
    } catch (error) {
      console.warn("[long-run] daemon-turn goal could not follow its turn:", row.goal_id, error instanceof Error ? error.message : String(error));
    }
  }
  return out;
}
