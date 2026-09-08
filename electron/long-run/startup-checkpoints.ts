import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { McpInvocationRequest, RuntimeSelection } from "../../shared/types";
import { automaticGoalResumeRequest } from "../invocation/automatic-goal";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getDb } from "../store/db";
import { getInvocationRunReceipt } from "../store/run-events";
import { appendLongRunEvent, getLongRun, listLongRuns, transitionLongRun } from "../store/long-runs";
import { desktopAppInstanceId, assertDesktopLongRunAdmissionOpen } from "./app-runtime-coordinator";
import { latestTaskCheckpoint } from "./checkpoint";
import { reconcileHostPausedLongRuns } from "./startup-reconciler";
import { resolveDesktopRuntimeAdapter } from "./runtime-adapters";

export interface CheckpointStartupDispatcher {
  activeChatIds(): string[];
  start(request: McpInvocationRequest): { runId: string };
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
  assertDesktopLongRunAdmissionOpen();
  const appInstanceId = desktopAppInstanceId();
  const results: CheckpointStartupResult[] = [];
  // Include clean-shutdown pauses: they were already paused before boot and
  // therefore are absent from recoverInterruptedDesktopLongRunsAtStartup().
  const candidates = listLongRuns({ statuses: ["paused"], executionLocation: "desktop-local", limit: 500 });
  for (const candidate of candidates) {
    if (candidate.surface === "science" || !["app_closed", "crash_recovery"].includes(candidate.pauseReason ?? "")) continue;
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
      const previousInvocation = checkpoint.invocationRunId ? getInvocationRunReceipt(checkpoint.invocationRunId) : null;
      if (!previousInvocation || previousInvocation.status !== "completed" || previousInvocation.chatId !== chat.id) {
        refuse("checkpoint_invocation_not_settled"); continue;
      }
      // The request helper revalidates the exact current revision, original
      // authority and remaining budget without mutating state or writing a user event.
      const request = automaticGoalResumeRequest(chat.id, candidate.version);
      if (!request) { refuse("goal_authority_unavailable"); continue; }
      const worker = getDb().prepare("SELECT runtime_selection_json FROM long_run_workers WHERE run_id = ? AND role = 'controller' ORDER BY updated_at DESC LIMIT 1")
        .get(candidate.id) as { runtime_selection_json: string } | undefined;
      if (!worker) { refuse("runtime_binding_missing"); continue; }
      const selection = JSON.parse(worker.runtime_selection_json) as RuntimeSelection;
      resolveDesktopRuntimeAdapter(selection); // Reject an unknown stored runtime before admitting work.
      successorRunId = randomUUID();
      const resumedRequest: McpInvocationRequest = {
        ...request, runId: successorRunId, runtimeSelection: selection,
        ...(request.oneMode ? { onePermissionMode: request.permissions } : {}),
        userPrompt: `Resume the existing goal from host checkpoint ${checkpoint.checkpointId}. Inspect the existing workspace and gather its missing verification evidence. Preserve the goal's current criteria and original authority.`,
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
      const started = dispatcher.start(resumedRequest);
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
