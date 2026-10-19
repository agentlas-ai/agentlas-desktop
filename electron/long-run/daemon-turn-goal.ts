/**


















 */
import { LONG_RUN_TERMINAL_STATUSES } from "../../shared/long-run";
import { completeChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { getChat, setChatGoalBinding } from "../store/chats";
import { getDb } from "../store/db";
import {
  appendLongRunEvent, getLongRunByGoalId, liveLongRunAttemptCount, longRunOwnerHold, transitionLongRun, type LongRunRecord,
} from "../store/long-runs";

export const DAEMON_TURN_GOAL_SETTLED_EVENT = "run.daemon_turn_settled";
const AUTO_GOAL_PREFIX = "goal:auto-message:";
const SUCCESS_KINDS = ["invoke_completed"];
const FAILURE_KINDS = ["invoke_failed", "invoke_threw"];
const STOP_KINDS = ["invoke_cancelled", "invoke_interrupted"];
const TERMINAL_KINDS = [...SUCCESS_KINDS, ...FAILURE_KINDS, ...STOP_KINDS];

export type DaemonTurnGoalAction =
  | "started" | "completed" | "cancelled" | "paused" | "unchanged" | "skipped";
export interface DaemonTurnGoalResult { goalId: string; action: DaemonTurnGoalAction; detail: string }

const result = (goalId: string, action: DaemonTurnGoalAction, detail: string): DaemonTurnGoalResult => ({ goalId, action, detail });

/** The service run Main admitted this Goal for: the run named by the admitted intake marker, owned by a daemon lease. */
function sourceDaemonRun(run: LongRunRecord): { runId: string; ended: boolean } | null {
  if (!run.rootChatId) return null;
  const db = getDb();
  const marker = db.prepare(`SELECT run_id FROM run_events WHERE kind = 'automatic_goal_intake_completed' AND chat_id = ?
      AND json_extract(payload_json, '$.goalId') = ? AND json_extract(payload_json, '$.outcome') = 'admitted'
      ORDER BY ts ASC LIMIT 1`).get(run.rootChatId, run.goalId) as { run_id: string } | undefined;
  if (!marker) return null;
  const owner = db.prepare("SELECT owner_kind, chat_id, state FROM invocation_run_owners WHERE run_id = ?").get(marker.run_id) as
    { owner_kind: string; chat_id: string; state: string } | undefined;
  if (!owner || owner.owner_kind !== "daemon" || owner.chat_id !== run.rootChatId) return null;
  return { runId: marker.run_id, ended: owner.state === "released" };
}

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

function terminalOf(runId: string): { kind: string; errorCode: string | null; verifier: string | null } | null {
  const db = getDb();
  const marks = TERMINAL_KINDS.map(() => "?").join(",");
  const terminal = db.prepare(`SELECT kind, payload_json FROM run_events WHERE run_id = ? AND kind IN (${marks}) ORDER BY ts DESC, seq DESC LIMIT 1`)
    .get(runId, ...TERMINAL_KINDS) as { kind: string; payload_json: string } | undefined;
  if (!terminal) return null;
  let errorCode: string | null = null;
  try {
    const code = (JSON.parse(terminal.payload_json) as { errorCode?: unknown }).errorCode;
    if (typeof code === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(code)) errorCode = code;
  } catch { /* the kind alone decides */ }
  // A team run carries its own verifier verdict; a failed verdict is not a completed run even when the turn returned.
  const receipt = db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'task_force_execution_receipt' ORDER BY ts DESC, seq DESC LIMIT 1")
    .get(runId) as { payload_json: string } | undefined;
  let verifier: string | null = null;
  if (receipt) {
    try {
      const status = (JSON.parse(receipt.payload_json) as { verifierStatus?: unknown }).verifierStatus;
      if (typeof status === "string") verifier = status;
    } catch { /* no verdict */ }
  }
  return { kind: terminal.kind, errorCode, verifier };
}

function releaseChat(chatId: string, goalId: string): void {
  if (getChat(chatId)?.goalId === goalId) setChatGoalBinding(chatId, null);
}

function recordSettlement(run: LongRunRecord, sourceRunId: string, outcome: string, extra: Record<string, unknown> = {}): void {
  appendLongRunEvent({ runId: run.id, kind: DAEMON_TURN_GOAL_SETTLED_EVENT, actorKind: "host",
    payload: { invocationRunId: sourceRunId, outcome, ...extra } });
}

/** Move one Goal along its service turn. Safe to call at any time and from any process that shares the store. */
export function followDaemonTurnGoal(goalId: string): DaemonTurnGoalResult {
  if (!goalId.startsWith(AUTO_GOAL_PREFIX)) return result(goalId, "skipped", "not_automatic_goal");
  let run = getLongRunByGoalId(goalId);
  if (!run || LONG_RUN_TERMINAL_STATUSES.has(run.status)) return result(goalId, "skipped", "goal_terminal_or_missing");
  if (run.surface === "science" || run.hostOwnerKind !== "desktop" || !run.rootChatId) return result(goalId, "skipped", "not_desktop_room_goal");
  if (!["queued", "running"].includes(run.status)) return result(goalId, "skipped", "status_not_followed");
  if (getChatGoalRevision(goalId)?.lifecycle !== "finite") return result(goalId, "skipped", "not_finite");
  const source = sourceDaemonRun(run);
  if (!source) return result(goalId, "skipped", "not_daemon_turn_goal");
  // Something else already works this Goal (a Desktop controller turn, the owner's pause): it is theirs to settle.
  if (run.cycleCount > 0 || liveLongRunAttemptCount(run.id) > 0 || longRunOwnerHold(run.id)) return result(goalId, "skipped", "goal_has_other_owner");
  if (getDb().prepare("SELECT 1 FROM long_run_worker_attempts WHERE run_id = ? LIMIT 1").get(run.id)) return result(goalId, "skipped", "goal_has_controller_attempt");
  if (newerLiveTurn(run.rootChatId, source.runId)) return result(goalId, "skipped", "newer_turn_live");
  const chatId = run.rootChatId;
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

  if (!source.ended) {
    if (run.status === "queued") { step("running", "daemon-turn-started"); return result(goalId, "started", source.runId); }
    return result(goalId, "unchanged", "turn_live");
  }
  const terminal = terminalOf(source.runId);
  if (!terminal) return result(goalId, "skipped", "no_terminal_event");

  if (SUCCESS_KINDS.includes(terminal.kind) && terminal.verifier !== "fail") {
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
  const rows = getDb().prepare(`SELECT goal_id FROM long_runs WHERE goal_id LIKE 'goal:auto-message:%' AND status IN ('queued','running')
      AND surface IN ('one','work') AND host_owner_kind = 'desktop' AND cycle_count = 0 ORDER BY updated_at ASC LIMIT ?`).all(limit) as Array<{ goal_id: string }>;
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
