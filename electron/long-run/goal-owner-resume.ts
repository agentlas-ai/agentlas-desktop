/**
 * The owner's Resume of a Goal, one path for every surface that offers it: the desktop Goal chip (ipc chats:resumeGoal) and
 * the phone's goal sheet (mobile goal control chats.resumeGoal). Before this, only the desktop chip could resume; the phone
 * could pause a Goal and then had no way back (a phone message on a paused Goal runs as an ordinary turn and leaves it
 * paused), which the goal tree audit 2026-10-25 found as a dead end.
 *
 *  - No recorded grant: the press is the owner's instruction (explicit-goal-authority findOwnerResumeGoalGrant); the fence
 *    moves by exactly the one adoption event. goal_owner_grant_required only when the owner never spoke in the room.
 *  - A turn live in the room: the owner's resume is recorded (paused/blocked -> queued, actor user, owner hold released)
 *    and the blocked-goal sweep starts the Goal once that turn has ended.
 *  - Otherwise: the same transaction the chip always used (queueAutomaticGoalResume), then dispatch; a dispatch failure
 *    leaves the Goal queued for the sweep (failDesktopLongRunResumeDispatch).
 * `expectedVersion` null (the phone): the press acts on the chat's current Goal at its current version; the goal id still
 * fences it, as the phone's pause and delete do.
 */
import { getChat } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId } from "../store/long-runs";
import { adoptExplicitGoalGrant } from "./explicit-goal-authority";
import { confirmDesktopLongRunResumeDispatched, failDesktopLongRunResumeDispatch, resumeDesktopLongRunManually } from "./app-runtime-coordinator";
import { queueAutomaticGoalResume } from "../invocation/automatic-goal";
import { acknowledgeGoalExecutionResume } from "../automation-execution-control";
import { admitMainInvocation } from "../runtime/scheduled-root-context";
import type { McpInvocationRequest } from "../../shared/types";

export interface GoalOwnerResumeDispatcher {
  activeChatIds(): string[];
  start(request: McpInvocationRequest, ...rest: unknown[]): unknown;
}

export type GoalOwnerResumeOutcome = "dispatched" | "queued_after_turn" | "dispatch_queued" | "no_run" | "not_stopped";

export async function resumeGoalAsOwner(input: { chatId: string; expectedGoalId: string; expectedVersion: number | null },
  dispatcher: GoalOwnerResumeDispatcher): Promise<GoalOwnerResumeOutcome> {
  const { chatId, expectedGoalId } = input;
  if (!expectedGoalId || getChat(chatId)?.goalId !== expectedGoalId) throw new Error("goal_control_binding_changed");
  let fence = input.expectedVersion ?? getLongRunByGoalId(expectedGoalId)?.version ?? 0;
  if (!getChatGoalRevision(expectedGoalId)) {
    const before = getLongRunByGoalId(expectedGoalId);
    const adopted = adoptExplicitGoalGrant(expectedGoalId, undefined, { ownerResume: true });
    const after = getLongRunByGoalId(expectedGoalId);
    if (adopted && before && after && before.version === fence) fence = after.version;
  }
  const run = getLongRunByGoalId(expectedGoalId);
  if (!run) return "no_run";
  if (!getChatGoalRevision(expectedGoalId)) throw Object.assign(new Error("goal_owner_grant_required"), { code: "goal_owner_grant_required" });
  if (dispatcher.activeChatIds().includes(chatId)) {
    if (run.status !== "paused" && run.status !== "blocked") return "not_stopped";
    resumeDesktopLongRunManually(run.id, fence);
    return "queued_after_turn";
  }
  const revision = getChatGoalRevision(expectedGoalId);
  const { request, queued } = await queueAutomaticGoalResume(chatId, fence);
  try {
    if (revision) acknowledgeGoalExecutionResume({ goalId: expectedGoalId, rootChatId: chatId, expectedRevision: revision.revision });
    confirmDesktopLongRunResumeDispatched(queued.id);
    dispatcher.start(request, undefined, undefined, undefined, "goal-continuation", admitMainInvocation(request.chatId, request.runId));
    return "dispatched";
  } catch (error) {
    failDesktopLongRunResumeDispatch(queued.id, error instanceof Error ? error.message : String(error));
    return "dispatch_queued";
  }
}
