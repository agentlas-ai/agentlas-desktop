/**
 * One answer to "may this Goal start a model turn now" (docs/2026-10-04-owner-first-goal-scheduling/PLAN.md,
 * layer rule 6 and P1; owner 2026-10-04).
 *
 * Six places started a Goal's next turn, each with its own spacing: the minute sweep, a turn's follow-up, the
 * wait poller, the effect observer, the startup checkpoint pass and Alive. On the owner's DB (Thread Marketing,
 * 2026-10-04) they combined into 39 identical ~247k-token turns an hour, and one of them took the room while the
 * owner's own message was in preflight. The paths that start on their own schedule (sweep, Alive, a released
 * project, the wait poller, the effect observer) ask here first; every path, including the startup replay of an
 * interrupted turn, records its start here.
 *
 * Policy, in order:
 *  1. The owner first: a turn already live in the room, or the owner's request waiting to start, wins.
 *  2. A barrier, not a pace: at most GOAL_WAKE_DAILY_BUDGET host starts per Goal in 24 h without the owner
 *     speaking or using a Goal control. Pacing is the follow-up policy (store/long-runs goalTurnFollowUpPlan);
 *     this cap only stops a loop nobody saw. Reaching it is said once in the room.
 *
 * Wake records live in run_events (indexed by chat, kind, time), not in the long-run ledger: a ledger event bumps
 * the run version that resume and observation paths fence on.
 */
import { getDb } from "../store/db";
import { appendChatMessage } from "../store/chats";
import { recordRunEvent, tryRecordRunEvent } from "../store/run-events";
import { getPendingInvocationAdmissionForChat } from "../store/invocation-admissions";
import { currentUiLocale } from "../ui-locale";

export const GOAL_WAKE_DAILY_BUDGET = 48;
export const GOAL_WAKE_EVENT_KIND = "goal_wake_started";
const BUDGET_EVENT_KIND = "goal_wake_budget_reached";
export const GOAL_WAKE_DEFERRED_EVENT_KIND = "goal_wake_deferred";
export const GOAL_WAKE_OWNER_CONTROL_EVENT_KIND = "goal_wake_owner_control";
export const GOAL_WAKE_CANCELLED_EVENT_KIND = "goal_wake_cancelled";
const DAY_MS = 24 * 60 * 60_000;
/** A pending owner admission older than this belongs to a process that died; it must not hold a Goal back. */
const OWNER_REQUEST_FRESH_MS = 120_000;

/** "agi": a teammate session the AGI unblocker starts for the Goal (agi/wiring.ts through hostGoalWake below). */
export type GoalWakeSource = "sweep" | "alive" | "project-released" | "startup" | "observation" | "wait" | "agi" | "continuation";

export interface GoalWakeGate {
  activeChatIds?(): string[];
  isChatBusy?(chatId: string): boolean;
  hasQueuedOwnerRequest?(chatId: string): boolean;
}

export type GoalWakeVerdict =
  | { start: true }
  | { start: false; reason: "chat_busy" | "owner_request_queued"; retryAt?: string }
  | { start: false; reason: "wake_budget_reached"; retryAt: string };

/** The owner's own request is waiting to start in this room (a queued steer, or a reserved start in preflight). */
export function ownerRequestWaiting(chatId: string, gate?: GoalWakeGate, now = Date.now()): boolean {
  if (gate?.hasQueuedOwnerRequest?.(chatId)) return true;
  try {
    const pending = getPendingInvocationAdmissionForChat(chatId);
    return Boolean(pending && now - Date.parse(pending.pendingAt) < OWNER_REQUEST_FRESH_MS);
  } catch { return false; }
}

/** The later of: 24 h ago, the owner's last message in the room, the owner's last Goal control. */
function windowFloor(runId: string, chatId: string, now: number): string {
  const day = new Date(now - DAY_MS).toISOString();
  const said = (getDb().prepare("SELECT MAX(created_at) AS at FROM chat_messages WHERE chat_id = ? AND role = 'user'")
    .get(chatId) as { at: string | null } | undefined)?.at ?? null;
  const acted = (getDb().prepare("SELECT MAX(occurred_at) AS at FROM long_run_events WHERE run_id = ? AND kind = 'run.user_control'")
    .get(runId) as { at: string | null } | undefined)?.at ?? null;
  const hostControl = (getDb().prepare(`SELECT MAX(ts) AS at FROM run_events WHERE chat_id = ? AND kind = ?
    AND json_extract(payload_json,'$.longRunId') = ?`).get(chatId, GOAL_WAKE_OWNER_CONTROL_EVENT_KIND, runId) as { at: string | null } | undefined)?.at ?? null;
  return [day, said, acted, hostControl].filter((value): value is string => Boolean(value)).sort().at(-1)!;
}

export function goalWakeWindow(runId: string, chatId: string, now = Date.now()): { count: number; oldest: string | null; since: string } {
  const since = windowFloor(runId, chatId, now);
  const row = getDb().prepare(`SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM run_events
    WHERE chat_id = ? AND kind = ? AND ts > ? AND json_extract(payload_json, '$.longRunId') = ?`)
    .get(chatId, GOAL_WAKE_EVENT_KIND, since, runId) as { n: number; oldest: string | null };
  return { count: row.n, oldest: row.oldest, since };
}

function tellBudgetOnce(runId: string, chatId: string, window: { count: number; since: string }, retryAt: string): void {
  const told = getDb().prepare(`SELECT 1 FROM run_events WHERE chat_id = ? AND kind = ? AND ts > ?
    AND json_extract(payload_json, '$.longRunId') = ? LIMIT 1`).get(chatId, BUDGET_EVENT_KIND, window.since, runId);
  if (told) return;
  const noticeRunId = `goal-wake-budget:${runId}:${window.since}`;
  tryRecordRunEvent({ runId: noticeRunId, chatId, kind: BUDGET_EVENT_KIND,
    payload: { longRunId: runId, count: window.count, budget: GOAL_WAKE_DAILY_BUDGET, retryAt } });
  const at = new Date(retryAt);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  try {
    appendChatMessage(chatId, "assistant", currentUiLocale() === "ko"
      ? `이 목표를 지난 24시간 동안 직접 입력 없이 ${window.count}번 깨웠습니다. ${clock}까지 더 깨우지 않습니다. 말을 걸거나 목표에서 이어가기를 누르면 바로 이어갑니다.`
      : `This goal was woken ${window.count} times in the last 24 hours without your input. It will not be woken again before ${clock}. Send a message or resume the goal to continue now.`,
    { hostNotice: { purpose: "host-status", runId: noticeRunId, status: "needs-owner" } });
  } catch (error) { console.warn("[wake-arbiter] budget notice failed:", error); }
}

/**
 * The same move for the same cause (owner 2026-09-24 persistent-autonomy rule: at most twice, then a different move or a wait
 * with the cause and its next wake time). Windows VM 2026-10-24 (logs/r2-main-nsis.log 13:01-13:12Z): every resume of a Work
 * Goal failed at the tool-config build (mcp-runtime-config-unavailable, native-browser-config-unbound) and the sweep resumed
 * it again every 60 s, each a paid start, because nothing here looked at how the previous wakes ended. The turn-follow-up
 * spacing did not help: the background verifier's own completed attempt reset its count after every failed turn.
 *
 * The streak is read from this arbiter's own wake records (goal_wake_started, one per host start, keyed by the invocation)
 * and each invocation's terminal run event (its machine errorCode). Prose is never read. The streak ends at a completed turn,
 * a cancelled or host-stopped turn, a different cause, the owner speaking or using a Goal control (windowFloor), or a new
 * launch of the app (an update or relaunch may have changed what failed: one prompt look is owed, as for retries).
 * Only the paths that replay the Goal's own continuation ask (sweep, Alive, a released project, startup). A satisfied wait, an
 * AGI teammate tactic (a different move) and Science keep their own rules.
 */
export const SAME_CAUSE_WAKE_REASON = "same_cause_backoff";
/** Wait before the same move after the 1st and the 2nd consecutive failure with one cause. */
export const SAME_CAUSE_RETRY_DELAYS_MS: readonly number[] = [5 * 60_000, 30 * 60_000];
/** After the same move was made twice for one cause: the Goal waits with that cause and looks again at this spacing. */
export const SAME_CAUSE_WAIT_MS = 6 * 60 * 60_000;
const SAME_CAUSE_SCAN_LIMIT = 12;
const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
const TERMINAL_KINDS = ["invoke_completed", "invoke_failed", "invoke_cancelled", "invoke_interrupted", "invoke_threw"] as const;

export interface SameCauseWakeHold {
  cause: string;
  /** Consecutive failed host starts with this cause. */
  failures: number;
  lastFailedAt: string;
  retryAt: string;
}

/** Consecutive failed host starts of this Goal with one machine cause, newest first; null when the last one did not fail. */
export function sameCauseFailureStreak(runId: string, chatId: string, now = Date.now()): Omit<SameCauseWakeHold, "retryAt"> | null {
  const floor = [windowFloor(runId, chatId, now), PROCESS_STARTED_AT].sort().at(-1)!;
  const wakes = getDb().prepare(`SELECT run_id AS invocationRunId FROM run_events WHERE chat_id = ? AND kind = ? AND ts > ?
    AND json_extract(payload_json, '$.longRunId') = ? ORDER BY ts DESC, seq DESC LIMIT ?`)
    .all(chatId, GOAL_WAKE_EVENT_KIND, floor, runId, SAME_CAUSE_SCAN_LIMIT) as Array<{ invocationRunId: string }>;
  const terminalOf = getDb().prepare(`SELECT kind, ts, payload_json FROM run_events WHERE run_id = ? AND kind IN (${TERMINAL_KINDS.map(() => "?").join(",")})
    ORDER BY seq DESC LIMIT 1`);
  let cause: string | null = null, failures = 0, lastFailedAt: string | null = null;
  for (const wake of wakes) {
    const terminal = terminalOf.get(wake.invocationRunId, ...TERMINAL_KINDS) as { kind: string; ts: string; payload_json: string } | undefined;
    if (!terminal || (terminal.kind !== "invoke_failed" && terminal.kind !== "invoke_threw")) break;
    let payload: { errorCode?: unknown; hostStopCause?: unknown } = {};
    try { payload = JSON.parse(terminal.payload_json); } catch { /* an unreadable receipt is still a failure */ }
    if (payload.hostStopCause) break; // the app or the owner stopped it: not the move failing
    const code = typeof payload.errorCode === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(payload.errorCode) ? payload.errorCode : "invoke_failed_uncoded";
    if (cause !== null && code !== cause) break;
    cause = code; failures += 1; lastFailedAt ??= terminal.ts;
  }
  return cause && lastFailedAt ? { cause, failures, lastFailedAt } : null;
}

/** When the same move may next be made for this Goal; null = now. */
export function sameCauseWakeHold(runId: string, chatId: string, now = Date.now()): SameCauseWakeHold | null {
  const streak = sameCauseFailureStreak(runId, chatId, now);
  if (!streak) return null;
  const delay = SAME_CAUSE_RETRY_DELAYS_MS[streak.failures - 1] ?? SAME_CAUSE_WAIT_MS;
  const retryAt = Date.parse(streak.lastFailedAt) + delay;
  return Number.isFinite(retryAt) && retryAt > now ? { ...streak, retryAt: new Date(retryAt).toISOString() } : null;
}

export type GoalContinuationWakeVerdict = GoalWakeVerdict
  | { start: false; reason: typeof SAME_CAUSE_WAKE_REASON; retryAt: string; cause: string; failures: number };

/** decideGoalWake for the paths that replay the Goal's own continuation, plus the same-cause rule above. */
export function decideGoalContinuationWake(input: Parameters<typeof decideGoalWake>[0]): GoalContinuationWakeVerdict {
  const verdict = decideGoalWake(input);
  if (!verdict.start) return verdict;
  const hold = sameCauseWakeHold(input.runId, input.chatId, input.now ?? Date.now());
  return hold ? { start: false, reason: SAME_CAUSE_WAKE_REASON, retryAt: hold.retryAt, cause: hold.cause, failures: hold.failures } : verdict;
}

export function decideGoalWake(input: {
  runId: string; chatId: string; source: GoalWakeSource; gate?: GoalWakeGate;
  /** Effect observations are background looks that may run beside a live turn; they skip only the idle check. */
  requireIdleChat?: boolean; now?: number;
}): GoalWakeVerdict {
  const now = input.now ?? Date.now();
  if (input.requireIdleChat !== false
    && (input.gate?.activeChatIds?.().includes(input.chatId) || input.gate?.isChatBusy?.(input.chatId))) {
    return { start: false, reason: "chat_busy" };
  }
  if (ownerRequestWaiting(input.chatId, input.gate, now)) return { start: false, reason: "owner_request_queued" };
  const window = goalWakeWindow(input.runId, input.chatId, now);
  if (window.count >= GOAL_WAKE_DAILY_BUDGET && window.oldest) {
    const retryAt = new Date(Date.parse(window.oldest) + DAY_MS).toISOString();
    tellBudgetOnce(input.runId, input.chatId, window, retryAt);
    return { start: false, reason: "wake_budget_reached", retryAt };
  }
  return { start: true };
}

/**
 * A host path that starts model work for a Goal outside the paths above (the AGI unblocker handing a tactic to a teammate) goes
 * through the same answer: refused with a typed code (goal_wake_budget_reached | goal_wake_owner_request_queued |
 * goal_wake_chat_busy) before anything starts, and recorded once when it did start new work. Production Yotube room: AGI
 * teammate dispatches 27 on 10-18 and 96 on 10-19, none of them counted against the Goal's wakes.
 */
export interface HostGoalWakeInput {
  runId: string; chatId: string; source: GoalWakeSource; cause?: string | null; now?: number;
  gate?: GoalWakeGate; invocationRunId?: string | null;
}

/** A deferred wake is scheduling, not a failed model turn. Domain callers keep
 * their current reservation and retry without manufacturing a terminal result. */
export function tryHostGoalWake<T>(input: HostGoalWakeInput, start: () => T,
  startedNew: (result: T) => boolean): { start: true; result: T } | Extract<GoalWakeVerdict, { start: false }> {
  const verdict = decideGoalWake(input);
  if (!verdict.start) {
    if (!input.invocationRunId) return verdict;
    const retryAt = verdict.retryAt ?? new Date((input.now ?? Date.now()) + 1_000).toISOString();
    recordRunEvent({ runId: input.invocationRunId, chatId: input.chatId, kind: GOAL_WAKE_DEFERRED_EVENT_KIND,
      payload: { longRunId: input.runId, source: input.source, cause: input.cause ?? null, reason: verdict.reason, retryAt } });
    return { ...verdict, retryAt };
  }
  const result = start();
  if (startedNew(result)) recordGoalWake({ runId: input.runId, chatId: input.chatId, source: input.source,
    invocationRunId: input.invocationRunId, cause: input.cause ?? null });
  return { start: true, result };
}

export function hostGoalWake<T>(input: HostGoalWakeInput, start: () => T, startedNew: (result: T) => boolean): T {
  const outcome = tryHostGoalWake(input, start, startedNew);
  if (!outcome.start) throw new Error(outcome.reason === "wake_budget_reached" ? "goal_wake_budget_reached" : `goal_wake_${outcome.reason}`);
  return outcome.result;
}

/** One record per model turn a host path started for a Goal (counted by the budget, shown as "wakes today"). */
export function recordGoalWake(input: { runId: string; chatId: string; source: GoalWakeSource;
  invocationRunId?: string | null; cause?: string | null }): void {
  tryRecordRunEvent({ runId: input.invocationRunId || `goal-wake:${input.runId}:${Date.now()}`, chatId: input.chatId,
    kind: GOAL_WAKE_EVENT_KIND, payload: { longRunId: input.runId, source: input.source, cause: input.cause ?? null } });
}

export interface HostGoalWakeDeferral {
  reason: "chat_busy" | "owner_request_queued" | "wake_budget_reached";
  retryAt: string;
  deferredAt: string;
}
/** Exact unstarted invocation reservation. The domain revalidates its own
 * queued turn on restore; the shared journal owns the scheduling fact. */
export function readHostGoalWakeDeferral(input: { runId: string; chatId: string; invocationRunId: string }, now = Date.now()): HostGoalWakeDeferral | null {
  const row = getDb().prepare(`SELECT kind,ts,payload_json FROM run_events
    WHERE run_id = ? AND chat_id = ? AND kind IN (?,?,?)
      AND json_extract(payload_json,'$.longRunId') = ? ORDER BY seq DESC LIMIT 1`)
    .get(input.invocationRunId, input.chatId, GOAL_WAKE_DEFERRED_EVENT_KIND, GOAL_WAKE_EVENT_KIND, GOAL_WAKE_CANCELLED_EVENT_KIND, input.runId) as { kind: string; ts: string; payload_json: string } | undefined;
  if (!row || row.kind !== GOAL_WAKE_DEFERRED_EVENT_KIND) return null;
  let payload: { reason?: unknown; retryAt?: unknown };
  try { payload = JSON.parse(row.payload_json); } catch { return null; }
  if (!["chat_busy", "owner_request_queued", "wake_budget_reached"].includes(String(payload.reason))
    || typeof payload.retryAt !== "string" || !Number.isFinite(Date.parse(payload.retryAt))) return null;
  const floor = windowFloor(input.runId, input.chatId, now);
  if (!Number.isFinite(Date.parse(row.ts))) return null;
  return { reason: payload.reason as HostGoalWakeDeferral["reason"], deferredAt: row.ts,
    retryAt: floor > row.ts ? new Date(now).toISOString() : payload.retryAt };
}

/** Trusted owner UI control only; callers validate the actual action and scope.
 * The same reset works for every host without inventing a user chat message. */
export function recordHostGoalOwnerControl(input: { runId: string; chatId: string; cause: string; requestId?: string }): void {
  recordRunEvent({ runId: `goal-owner-control:${input.runId}`, chatId: input.chatId, kind: GOAL_WAKE_OWNER_CONTROL_EVENT_KIND,
    payload: { longRunId: input.runId, cause: input.cause }, ...(input.requestId ? { sourceEventId: `owner-control:${input.requestId}` } : {}) });
}

export function cancelHostGoalWakeDeferral(input: { runId: string; chatId: string; invocationRunId: string }): void {
  recordRunEvent({ runId: input.invocationRunId, chatId: input.chatId, kind: GOAL_WAKE_CANCELLED_EVENT_KIND,
    payload: { longRunId: input.runId } });
}
