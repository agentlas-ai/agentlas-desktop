import { getDb } from "../store/db";
import { getChatGoalRevision } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId, getLongRunGoalRevisionBinding, longRunOwnerHold, recordLongRunCycle, nextBlockedGoalRetrySlot, pendingBlockedGoalRetry, scheduleBlockedGoalRetry, transitionLongRun } from "../store/long-runs";
import { ownsHostGoalLoop } from "./host-goal-surface";
import { latestTaskCheckpoint } from "./checkpoint";
import { observeOngoingOneGoalProgress } from "./goal-progress";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { latestGoalWaitSubscription, registerOngoingGoalCycle } from "./wait-subscriptions";

/** Host-only custody, never a model completion/progress claim. A native pass
 * cannot produce its own settled terminal checkpoint while it is still live. */
export interface NativeGoalEpisodeBinding {
  schemaVersion: "agentlas.native-goal-episode.v1";
  reason: "terminal_receipt_required";
  goalId: string; runId: string; chatId: string; invocationRunId: string;
  goalRevision: number; messageCursor: number;
}

function chatBinding(chatId: string): { goal_id: string | null } | undefined {
  return getDb().prepare("SELECT goal_id FROM chats WHERE id=?").get(chatId) as { goal_id: string | null } | undefined;
}
// This is a freshness fence, not author attribution or a permission grant.
function messageCursor(chatId: string): number {
  return (getDb().prepare("SELECT COALESCE(MAX(rowid),0) AS cursor FROM chat_messages WHERE chat_id=? AND role='user'")
    .get(chatId) as { cursor: number }).cursor;
}

export function captureNativeGoalEpisode(goalId: string, chatId: string, invocationRunId: string): NativeGoalEpisodeBinding | null {
  const run = getLongRunByGoalId(goalId), revision = getChatGoalRevision(goalId);
  if (!run || !ownsHostGoalLoop(run.surface) || run.status !== "running" || run.rootChatId !== chatId
    || !revision || revision.lifecycle !== "ongoing" || chatBinding(chatId)?.goal_id !== goalId
    || getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision || longRunOwnerHold(run.id)) return null;
  return { schemaVersion: "agentlas.native-goal-episode.v1", reason: "terminal_receipt_required",
    goalId, runId: run.id, chatId, invocationRunId, goalRevision: revision.revision, messageCursor: messageCursor(chatId) };
}

/** Only after Main terminal/effect settlement and independent verification.
 * Delayed callbacks cannot replace user timers, newer work, revisions or Stop.
 * The invocation is accounted once, including unavailable verification. */
export function settleNativeGoalEpisode(binding: NativeGoalEpisodeBinding, input: {
  checkpointId?: string | null; hasTransientAttachments?: boolean; now?: number;
} = {}): "waiting" | "stale" | "effects_uncertain" | "already_settled" | "authority_refused" {
  return getDb().transaction(() => {
    const run = getLongRunByGoalId(binding.goalId), revision = getChatGoalRevision(binding.goalId);
    const wait = latestGoalWaitSubscription(binding.goalId);
    const controller = getDb().prepare(`SELECT a.invocation_run_id FROM long_run_worker_attempts a
      JOIN long_run_workers w ON w.id=a.worker_id AND w.run_id=a.run_id
      WHERE a.run_id=? AND w.role='controller' ORDER BY a.rowid DESC LIMIT 1`)
      .get(binding.runId) as { invocation_run_id: string | null } | undefined;
    if (!run || run.id !== binding.runId || !ownsHostGoalLoop(run.surface) || run.status !== "running"
      || run.rootChatId !== binding.chatId || !revision || revision.lifecycle !== "ongoing"
      || revision.revision !== binding.goalRevision || getLongRunGoalRevisionBinding(run.id)?.revision !== binding.goalRevision
      || chatBinding(binding.chatId)?.goal_id !== binding.goalId || longRunOwnerHold(run.id)
      || messageCursor(binding.chatId) !== binding.messageCursor || controller?.invocation_run_id !== binding.invocationRunId
      || (wait && ["pending", "claimed"].includes(wait.state))) return "stale";
    const prior = getDb().prepare(`SELECT 1 FROM long_run_events WHERE run_id=? AND kind='run.native_episode_settled'
      AND json_extract(payload_json,'$.invocationRunId')=? LIMIT 1`).get(run.id, binding.invocationRunId);
    if (prior) return "already_settled";
    let effectsSettled = false;
    try { effectsSettled = readInvocationEffectBoundary({ invocationRunId: binding.invocationRunId,
      expectedChatId: binding.chatId }).effects === "settled"; }
    catch { /* Missing custody is uncertainty, never a no-effect assertion. */ }
    if (!effectsSettled) {
      // Reuse the existing durable, read-only effect-observation sweep. Its
      // typed observe retry restores the uncertainty reason at the due time;
      // it cannot turn this producer's prompt into an action replay.
      if (!pendingBlockedGoalRetry(run.id)) {
        const slot = nextBlockedGoalRetrySlot(run.id, input.now);
        scheduleBlockedGoalRetry({ runId: run.id, expectedVersion: run.version, kind: "observe",
          fromReason: "goal_wait_effects_uncertain", ...slot, detail: "native_episode_effect_receipt_unsettled",
          trigger: "native-episode-settlement", effectUncertain: true, appInstanceId: run.appInstanceId });
      }
      return "effects_uncertain";
    }
    const checkpoint = latestTaskCheckpoint(binding.goalId);
    const exactCheckpoint = input.checkpointId && checkpoint?.checkpointId === input.checkpointId
      && checkpoint.invocationRunId === binding.invocationRunId && checkpoint.goalRevision === binding.goalRevision
      && checkpoint.sideEffects.state === "settled";
    const observed = exactCheckpoint ? observeOngoingOneGoalProgress(binding.goalId) : { state: "unknown" as const, key: "" };
    const usefulProgress = observed.state === "evidence_observed" && observed.key !== run.lastProgressKey;
    const decision = recordLongRunCycle({ goalId: binding.goalId, ...(exactCheckpoint ? { verifiedCheckpointId: checkpoint!.checkpointId }
      : { sourceInvocationId: binding.invocationRunId }), progressState: observed.state, progressKey: observed.key || null,
      outcome: exactCheckpoint ? "native-episode-reconciled" : "native-episode-unverified" });
    if (!decision) throw new Error("one_goal_episode_cycle_record_failed");
    const betweenEpisodes = ["no_open_tasks", "stall_replan_required"].includes(decision.reason)
      && decision.status === "running" && decision.openTaskCount === 0;
    if (!decision.continue && !betweenEpisodes) {
      if (decision.status === "running") transitionLongRun({ runId: run.id, to: "blocked",
        actorKind: "host", reason: decision.reason });
      return "authority_refused";
    }
    const registered = registerOngoingGoalCycle({ goalId: binding.goalId, invocationRunId: binding.invocationRunId,
      hasTransientAttachments: input.hasTransientAttachments, now: input.now, usefulProgress });
    appendLongRunEvent({ runId: run.id, kind: "run.native_episode_settled", actorKind: "host",
      sourceEventId: `native-episode:${binding.invocationRunId}`, payload: { invocationRunId: binding.invocationRunId,
        goalRevision: binding.goalRevision, progressState: observed.state, usefulProgress,
        checkpointId: exactCheckpoint ? checkpoint!.checkpointId : null, waitId: registered.waitId, nextCheckAt: registered.nextCheckAt } });
    return "waiting";
  }).immediate();
}
