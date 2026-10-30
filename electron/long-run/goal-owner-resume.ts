/**
 * The owner's Resume of a Goal, one path for every surface that offers it: the desktop Goal chip (ipc chats:resumeGoal) and
 * the phone's goal sheet (mobile goal control chats.resumeGoal). Before this, only the desktop chip could resume; the phone
 * could pause a Goal and then had no way back (a phone message on a paused Goal runs as an ordinary turn and leaves it
 * paused), which the goal tree audit 2026-10-25 found as a dead end.
 *
 *  - No recorded grant: the press is the owner's instruction (explicit-goal-authority findOwnerResumeGoalGrant); the fence
 *    moves by exactly the one adoption event. goal_owner_grant_required only when the owner never spoke in the room.
 *  - A turn live in the room: the owner's resume is recorded (paused/blocked, or waiting for the owner's answer or grant,
 *    -> queued, actor user, owner hold released) and the blocked-goal sweep starts the Goal once that turn has ended.
 *  - Otherwise: the same transaction the chip always used (queueAutomaticGoalResume), then dispatch; a dispatch failure
 *    puts the host's own retry under the Goal (keepAcceptedResumeOwned), so the sweep starts it soon.
 * `expectedVersion` null (the phone): the press acts on the chat's current Goal at its current version; the goal id still
 * fences it, as the phone's pause and delete do.
 */
import { getChat } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, liveLongRunAttemptCount, longRunOwnerHold, nextBlockedGoalRetrySlot, pendingBlockedGoalRetry, queueOwnerHeldGoalForResume, scheduleBlockedGoalRetry } from "../store/long-runs";
import { goalHeldForOwnerAnswer, goalHeldForOwnerGrant } from "../../shared/goal-display-state";
import { adoptExplicitGoalGrant } from "./explicit-goal-authority";
import { confirmDesktopLongRunResumeDispatched, desktopAppInstanceId, failDesktopLongRunResumeDispatch, resumeDesktopLongRunManually } from "./app-runtime-coordinator";
import { supersedeGoalWaitForInvocation } from "./wait-subscriptions";
import { queueAutomaticGoalResume } from "../invocation/automatic-goal";
import { acknowledgeGoalExecutionResume } from "../automation-execution-control";
import { admitMainInvocation } from "../runtime/scheduled-root-context";
import type { McpInvocationRequest } from "../../shared/types";

export interface GoalOwnerResumeDispatcher {
  activeChatIds(): string[];
  start(request: McpInvocationRequest, ...rest: unknown[]): unknown;
}

export type GoalOwnerResumeOutcome = "dispatched" | "queued_after_turn" | "dispatch_queued" | "no_run" | "not_stopped";

/**
 * The press was shown as accepted ("dispatch_queued"), so a start that failed before any provider ran must not leave the Goal
 * running with nobody to start it. The failed-dispatch pause is read as running by the host's non-blocking rule, and the wait
 * the start superseded was put back as the Goal's next step (possibly hours away); neither wakes the Goal. The owner asked to
 * continue now: that wait is retired again and the host's own retry owns the next step, soon. Never throws - the press itself
 * already succeeded.
 */
function keepAcceptedResumeOwned(chatId: string, goalId: string, requestRunId: string | undefined, dispatcher: GoalOwnerResumeDispatcher,
  cause: string): void {
  try {
    const run = getLongRunByGoalId(goalId);
    if (!run || run.rootChatId !== chatId || !["queued", "running", "waiting_tool"].includes(run.status)
      || longRunOwnerHold(run.id) || liveLongRunAttemptCount(run.id) > 0 || dispatcher.activeChatIds().includes(chatId)) return;
    if (requestRunId) supersedeGoalWaitForInvocation(goalId, requestRunId);
    const fresh = getLongRunByGoalId(goalId);
    if (!fresh || !["queued", "running", "waiting_tool"].includes(fresh.status) || pendingBlockedGoalRetry(fresh.id)) return;
    const slot = nextBlockedGoalRetrySlot(fresh.id, Date.now(), { startup: true });
    scheduleBlockedGoalRetry({ runId: fresh.id, expectedVersion: fresh.version, kind: "resume", fromReason: "invocation_failed",
      retryIndex: slot.retryIndex, nextAt: slot.nextAt, detail: "owner_resume_dispatch_failed", trigger: "owner-resume",
      appInstanceId: desktopAppInstanceId() });
    console.warn(`[goal-owner-resume] start failed before any provider ran (${/^[a-z][a-z_0-9-]*(?::[a-z_0-9-]+)?$/.test(cause) ? cause : "owner_resume_dispatch_failed"}); the host retry owns the next step`);
  } catch (error) {
    console.warn("[goal-owner-resume] host retry after a failed start could not be scheduled:", error instanceof Error ? error.message : error);
  }
}

/** Run `attempt` at the Goal's current version; when a host event moves the version under it (the one conflict that says nothing
 * about the Goal's state), read the version again and repeat, a few times. Any other refusal is returned as it is. */
const RESUME_VERSION_ATTEMPTS = 3;
async function withFreshVersion<T>(current: () => number, attempt: (version: number) => T | Promise<T>): Promise<T> {
  for (let n = 0; ; n += 1) {
    try { return await attempt(current()); }
    catch (error) {
      if (n + 1 >= RESUME_VERSION_ATTEMPTS || !(error instanceof Error) || error.message !== "long_run_resume_version_conflict") throw error;
    }
  }
}

export async function resumeGoalAsOwner(input: { chatId: string; expectedGoalId: string; expectedVersion: number | null },
  dispatcher: GoalOwnerResumeDispatcher): Promise<GoalOwnerResumeOutcome> {
  const { chatId, expectedGoalId } = input;
  if (!expectedGoalId || getChat(chatId)?.goalId !== expectedGoalId) throw new Error("goal_control_binding_changed");
  // The press is the owner's instruction to continue THIS Goal (the id above fences it). The version the button was drawn
  // with is advisory: any host event (a sweep re-stamp, usage accounting, a wait note) moves it between the paint and the
  // press, and refusing on that made the Work cockpit answer "press resume once more" for a Goal that was plainly stopped
  // (the phone already passes null). The version is read here, and again if it moves under this call.
  const currentVersion = (): number => getLongRunByGoalId(expectedGoalId)?.version ?? 0;
  // Adopting the owner's grant appends one ledger event; the version is read again afterwards.
  if (!getChatGoalRevision(expectedGoalId)) adoptExplicitGoalGrant(expectedGoalId, undefined, { ownerResume: true });
  const run = getLongRunByGoalId(expectedGoalId);
  if (!run) return "no_run";
  if (!getChatGoalRevision(expectedGoalId)) throw Object.assign(new Error("goal_owner_grant_required"), { code: "goal_owner_grant_required" });
  if (dispatcher.activeChatIds().includes(chatId)) {
    // A Goal resting for the owner (its question, its start grant) is stopped too: the press ends that hold and queues the Goal
    // for the sweep, exactly as it starts it at once in an idle room. Returning not_stopped here dropped the press, and the
    // hold then waited for an owner message that the owner had already answered with the press.
    if (goalHeldForOwnerAnswer(run) || goalHeldForOwnerGrant(run)) {
      return queueOwnerHeldGoalForResume({ runId: run.id, appInstanceId: desktopAppInstanceId() }) ? "queued_after_turn" : "not_stopped";
    }
    if (run.status !== "paused" && run.status !== "blocked") return "not_stopped";
    return withFreshVersion(currentVersion, (version) => { resumeDesktopLongRunManually(run.id, version); return "queued_after_turn" as const; });
  }
  const revision = getChatGoalRevision(expectedGoalId);
  const { request, queued } = await withFreshVersion(currentVersion, (version) => queueAutomaticGoalResume(chatId, version));
  try {
    if (revision) acknowledgeGoalExecutionResume({ goalId: expectedGoalId, rootChatId: chatId, expectedRevision: revision.revision });
    confirmDesktopLongRunResumeDispatched(queued.id);
    dispatcher.start(request, undefined, undefined, undefined, "goal-continuation", admitMainInvocation(request.chatId, request.runId));
    return "dispatched";
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    try { failDesktopLongRunResumeDispatch(queued.id, cause); } catch { /* the retry below owns the Goal either way */ }
    keepAcceptedResumeOwned(chatId, expectedGoalId, request.runId, dispatcher, cause);
    return "dispatch_queued";
  }
}
