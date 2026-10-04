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
import { tryRecordRunEvent } from "../store/run-events";
import { getPendingInvocationAdmissionForChat } from "../store/invocation-admissions";
import { currentUiLocale } from "../ui-locale";

export const GOAL_WAKE_DAILY_BUDGET = 48;
export const GOAL_WAKE_EVENT_KIND = "goal_wake_started";
const BUDGET_EVENT_KIND = "goal_wake_budget_reached";
const DAY_MS = 24 * 60 * 60_000;
/** A pending owner admission older than this belongs to a process that died; it must not hold a Goal back. */
const OWNER_REQUEST_FRESH_MS = 120_000;

export type GoalWakeSource = "sweep" | "alive" | "project-released" | "startup" | "observation" | "wait";

export interface GoalWakeGate {
  activeChatIds?(): string[];
  isChatBusy?(chatId: string): boolean;
  hasQueuedOwnerRequest?(chatId: string): boolean;
}

export type GoalWakeVerdict =
  | { start: true }
  | { start: false; reason: "chat_busy" | "owner_request_queued"; retryAt?: undefined }
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
  return [day, said, acted].filter((value): value is string => Boolean(value)).sort().at(-1)!;
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

/** One record per model turn a host path started for a Goal (counted by the budget, shown as "wakes today"). */
export function recordGoalWake(input: { runId: string; chatId: string; source: GoalWakeSource;
  invocationRunId?: string | null; cause?: string | null }): void {
  tryRecordRunEvent({ runId: input.invocationRunId || `goal-wake:${input.runId}:${Date.now()}`, chatId: input.chatId,
    kind: GOAL_WAKE_EVENT_KIND, payload: { longRunId: input.runId, source: input.source, cause: input.cause ?? null } });
}
