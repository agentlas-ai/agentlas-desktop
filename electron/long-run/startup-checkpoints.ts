import { latestGoalWaitSubscription } from "./wait-subscriptions";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { McpInvocationRequest } from "../../shared/types";
import { automaticGoalResumeRequest } from "../invocation/automatic-goal";
import { appendChatMessage, getChat, getChatWorkingFolder } from "../store/chats";
import { currentUiLocale } from "../ui-locale";
import { getDb } from "../store/db";
import { prepareCheckpointContinuation } from "./continuation";
import { appendLongRunEvent, getLongRun, listLongRuns, transitionLongRun } from "../store/long-runs";
import { desktopAppInstanceId, assertDesktopLongRunAdmissionOpen } from "./app-runtime-coordinator";
import { latestTaskCheckpoint } from "./checkpoint";
import { reconcileHostPausedLongRuns } from "./startup-reconciler";

export interface CheckpointStartupDispatcher {
  activeChatIds(): string[];
  start(request: McpInvocationRequest, workspaceBinding?: undefined, executionContext?: undefined, questionContinuation?: undefined, hostNoticePurpose?: "goal-continuation"): { runId: string };
}

export interface CheckpointStartupResult {
  runId: string;
  status: "started" | "skipped";
  reason: string;
}

/** Called only after auth, plugins, IPC and queued user directions have been
 * reconciled. A host pause between settled turns is resumable; an unknown
 * native side effect or newer user direction is not permission to replay. */
export function resumeSettledGoalCheckpoints(dispatcher: CheckpointStartupDispatcher): CheckpointStartupResult[] {
  try {
    assertDesktopLongRunAdmissionOpen();
  } catch (error) {
    // A quit/update handoff can close the coordinator between the startup
    // bootstrap stages and this optional recovery pass. There is no work to
    // admit after that boundary, so treat it as an expected no-op instead of
    // surfacing a second Electron startup error.
    if (error instanceof Error && error.message === "desktop_long_run_admission_closed") return [];
    throw error;
  }
  const appInstanceId = desktopAppInstanceId();
  const results: CheckpointStartupResult[] = [];
  // Include clean-shutdown pauses: they were already paused before boot and
  // therefore are absent from recoverInterruptedDesktopLongRunsAtStartup().
  const candidates = listLongRuns({ statuses: ["paused"], executionLocation: "desktop-local", limit: 500 });
  for (const candidate of candidates) {
    if (candidate.surface === "science" || !["app_closed", "crash_recovery"].includes(candidate.pauseReason ?? "")) continue;
    // Pending subscriptions restore observation, not ordinary inference.
    // A claimed wake without a dispatch receipt is inspectable, never replayed.
    const wait = latestGoalWaitSubscription(candidate.goalId);
    if (wait && ["pending", "claimed"].includes(wait.state)) continue;
    const evaluated = getDb().prepare("SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = 'run.checkpoint_startup' AND json_extract(payload_json, '$.appInstanceId') = ? LIMIT 1")
      .get(candidate.id, appInstanceId);
    if (evaluated) continue;
    const refuse = (reason: string): void => {
      appendLongRunEvent({ runId: candidate.id, kind: "run.checkpoint_startup", actorKind: "host",
        payload: { appInstanceId, status: "skipped", reason } });
      results.push({ runId: candidate.id, status: "skipped", reason });
    };
    let successorRunId: string | null = null;
    try {
      const decision = reconcileHostPausedLongRuns([candidate.id])[0]?.decision;
      if (!decision?.resume) { refuse(decision && !decision.resume ? decision.reason : "run_missing"); continue; }
      const checkpoint = latestTaskCheckpoint(candidate.goalId);
      if (!checkpoint || checkpoint.disposition !== "retry_required") { refuse("checkpoint_missing_or_not_resumable"); continue; }
      if (checkpoint.sideEffects.state !== "settled") { refuse("checkpoint_side_effects_uncertain"); continue; }
      const chatId = candidate.rootChatId;
      const chat = chatId ? getChat(chatId) : null;
      if (!chat || chat.goalId !== candidate.goalId || chat.originSurface !== candidate.surface) { refuse("chat_binding_changed"); continue; }
      if (dispatcher.activeChatIds().includes(chat.id)) { refuse("chat_busy"); continue; }
      const cwd = getChatWorkingFolder(chat.id);
      if (!cwd || cwd !== checkpoint.workspacePath || !statSync(cwd).isDirectory()) { refuse("workspace_changed"); continue; }
      // A human direction queued during the old invocation must not disappear
      // merely because boot recovery changed its delivery state to cancelled.
      const pendingDirection = getDb().prepare("SELECT 1 FROM invocation_steers WHERE original_run_id = ? AND status IN ('queued','draining','cancelled','failed') LIMIT 1")
        .get(checkpoint.invocationRunId ?? "");
      const newerMessage = getDb().prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND created_at > ? LIMIT 1")
        .get(chat.id, checkpoint.createdAt);
      if (pendingDirection || newerMessage) { refuse("newer_user_direction"); continue; }
      const continuation = prepareCheckpointContinuation(checkpoint);
      // The request helper revalidates the exact current revision, original
      // authority and remaining budget without mutating state or writing a user event.
      const request = automaticGoalResumeRequest(chat.id, candidate.version);
      if (!request) { refuse("goal_authority_unavailable"); continue; }
      const selection = continuation.runtimeSelection;
      successorRunId = randomUUID();
      const resumedRequest: McpInvocationRequest = {
        ...request, runId: successorRunId, runtimeSelection: selection,
        ...(request.oneMode ? { onePermissionMode: request.permissions } : {}),
        userPrompt: continuation.userPrompt,
      };
      // The event, CAS transition and fresh invocation identity commit together.
      // No await separates this claim from start, so a person cannot be raced
      // after the final state/binding checks in this host process.
      getDb().transaction(() => {
        const current = getLongRun(candidate.id);
        if (!current || current.version !== candidate.version || current.status !== "paused"
          || getChat(chat.id)?.goalId !== candidate.goalId) throw new Error("checkpoint_startup_state_changed");
        transitionLongRun({ runId: current.id, to: "queued", actorKind: "host",
          reason: "checkpoint-startup-resume", expectedVersion: current.version, appInstanceId });
        appendLongRunEvent({ runId: current.id, kind: "run.checkpoint_startup", actorKind: "host",
          payload: { appInstanceId, checkpointId: checkpoint.checkpointId, invocationRunId: successorRunId, status: "claimed" } });
      })();
      /*
       * 재시작 자동 재개는 그 실행의 런타임을 정확히 복원한다(설계). 그 사이 사람이 대화의 모델을 바꿔 두었다면
       * 조용히 옛 모델로 이어가면 안 된다 — 무엇으로 이어가고 지금 선택은 무엇이며 바꾸려면 어떻게 하는지 한 줄(2026-09-14).
       */
      const chosen = getChat(chat.id)?.runtimeSelection ?? null;
      if (chosen && (chosen.kind !== selection.kind || (chosen.model ?? null) !== (selection.model ?? null))) {
        const label = (value: { kind: string; model?: string | null }) => `${value.kind}${value.model ? ` · ${value.model}` : ""}`;
        const text = currentUiLocale() === "ko"
          ? `이 작업은 시작할 때 고른 ${label(selection)} 로 이어갑니다 · 지금 선택은 ${label(chosen)} 입니다 — 새 모델로 하려면 중지한 뒤 다시 보내 주세요.`
          : `This task continues with ${label(selection)}, the runtime it started with · your current choice is ${label(chosen)} — to use the new model, stop and send again.`;
        appendChatMessage(chat.id, "assistant", text, { hostNotice: { purpose: "goal-continuation", runId: successorRunId } });
      }
      const started = dispatcher.start(resumedRequest, undefined, undefined, undefined, "goal-continuation");
      if (started.runId !== successorRunId) throw new Error("checkpoint_startup_dispatch_identity_mismatch");
      const current = getLongRun(candidate.id);
      if (current?.status === "queued") transitionLongRun({ runId: current.id, to: "running", actorKind: "host",
        reason: "checkpoint-startup-dispatched", expectedVersion: current.version, appInstanceId });
      appendLongRunEvent({ runId: candidate.id, kind: "run.checkpoint_startup_dispatched", actorKind: "host",
        payload: { appInstanceId, checkpointId: checkpoint.checkpointId, invocationRunId: successorRunId } });
      results.push({ runId: candidate.id, status: "started", reason: "settled_checkpoint" });
    } catch (error) {
      const current = getLongRun(candidate.id);
      if (successorRunId && current && ["queued", "running"].includes(current.status)) {
        transitionLongRun({ runId: current.id, to: "paused", actorKind: "host", reason: "runtime_unavailable" });
      }
      const code = error instanceof Error && /^[a-z_]+(?::[a-z_]+)?$/.test(error.message)
        ? error.message : "checkpoint_startup_unavailable";
      refuse(code);
    }
  }
  return results;
}
