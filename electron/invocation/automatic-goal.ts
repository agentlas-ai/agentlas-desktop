import { resumeDesktopLongRunManually } from "../long-run/app-runtime-coordinator";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, getLongRunGoalRevisionBinding } from "../store/long-runs";
import { getDb } from "../store/db";
import { tryRecordRunEvent } from "../store/run-events";
import { admitJudgedAutomaticGoal } from "../long-run/auto-goal-controller";
import { resolveAutomaticGoalIntent } from "../long-run/judged-auto-goal-intent";
import type { GoalSourceMessage } from "../../shared/auto-goal";
import type { LongRunRecord } from "../store/long-runs";

/** Bounded default, not a promise to finish within three passes. Unfinished
 * goals retain their criteria and pause. Money metering is unavailable here:
 * null explicitly means no monetary enforcement, never an invented $0 cost.
 */
export const AUTOMATIC_GOAL_CYCLE_LIMIT = 3;
export const AUTOMATIC_GOAL_TIME_LIMIT_MS = 10 * 60_000;

export async function prepareInvocationAutomaticGoal(input: {
  runId: string;
  chatId: string;
  sourceMessageId: string;
  userPrompt: string;
  permission: string;
  signal: AbortSignal;
  resolveIntent?: typeof resolveAutomaticGoalIntent;
}): Promise<LongRunRecord | null> {
  try {
    if (input.signal.aborted) return null;
    const row = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?")
      .get(input.sourceMessageId) as { chat_id: string; role: string; text: string } | undefined;
    if (!row || row.role !== "user" || row.chat_id !== input.chatId || row.text !== input.userPrompt) {
      throw new Error("auto_goal_source_mismatch");
    }
    const source: GoalSourceMessage = { chatId: input.chatId, messageId: input.sourceMessageId, role: "user", text: row.text };
    const decision = await (input.resolveIntent ?? resolveAutomaticGoalIntent)(source, { signal: input.signal, timeoutMs: 4_000 });
    if (input.signal.aborted) return null;
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "automatic_goal_intake", payload: {
      sourceMessageId: source.messageId, intent: decision.intent, commitment: decision.commitment,
      classified: decision.intent !== "unknown",
    } });
    if (decision.intent !== "execute" || decision.commitment !== "now") return null;
    return admitJudgedAutomaticGoal({
      goalId: `goal:auto-message:${source.messageId}`, chatId: source.chatId, sourceMessageId: source.messageId, decision,
      acceptanceCriteria: [
        { id: "requested-outcome", text: `Every deliverable requested in user message ${source.messageId} is complete.` },
        { id: "scope", text: "The original request's constraints, exclusions and permission boundaries are preserved." },
        { id: "evidence", text: "Completion is supported by current evidence on the requested output surface; unverified work remains open." },
      ],
      authorityRefs: [`invocation:${input.runId}:permission:${input.permission}`],
      budget: { maxCycles: AUTOMATIC_GOAL_CYCLE_LIMIT, maxCostUsd: null, maxWorkers: 2,
        wallclockDeadline: new Date(Date.now() + AUTOMATIC_GOAL_TIME_LIMIT_MS).toISOString() },
    });
  } catch (error) {
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "automatic_goal_intake_unavailable", payload: {
      sourceMessageId: input.sourceMessageId,
      reason: error instanceof Error && /^auto_goal_[a-z_]+$/.test(error.message) ? error.message : "classification_or_admission_failed",
    } });
    return null;
  }
}

/** Explicit UI resume reuses the same campaign and remaining budget. It never
 * reclassifies the synthetic continuation as a new user request. */
export function automaticGoalResumeRequest(chatId: string, expectedVersion: number): import("../../shared/types").McpInvocationRequest | null {
  const chat = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(chatId) as { goal_id: string | null } | undefined;
  if (!chat?.goal_id) return null;
  const revision = getChatGoalRevision(chat.goal_id);
  if (!revision) return null;
  const run = getLongRunByGoalId(chat.goal_id);
  if (!run || run.surface === "science" || run.rootChatId !== chatId || revision.chatId !== chatId) throw new Error("auto_goal_resume_surface_mismatch");
  if (run.version !== expectedVersion) throw new Error("long_run_resume_version_conflict");
  if (!["paused", "blocked"].includes(run.status)) throw new Error("auto_goal_resume_not_stopped");
  if (getLongRunGoalRevisionBinding(run.id)?.revision !== revision.revision) throw new Error("auto_goal_resume_revision_pending");
  const pending = getDb().prepare("SELECT COUNT(*) AS n FROM long_run_worker_attempts WHERE run_id = ? AND state IN ('running','uncertain')").get(run.id) as { n: number };
  if (pending.n) throw new Error("auto_goal_resume_attempt_unsettled");
  if (run.budget.maxCycles == null || run.cycleCount >= run.budget.maxCycles ||
      !run.budget.wallclockDeadline || Date.parse(run.budget.wallclockDeadline) <= Date.now() ||
      (run.budget.maxCostUsd !== null && run.costUsedUsd >= run.budget.maxCostUsd)) throw new Error("auto_goal_budget_exhausted");
  const authority = revision.authorityRefs.map((ref) => /^invocation:([^:]+):permission:(read|write|full)$/.exec(ref)).find(Boolean);
  if (!authority) throw new Error("auto_goal_resume_authority_missing");
  return { chatId, promptOrigin: "system", taskIntent: "task", permissions: authority[2] as "read" | "write" | "full",
    ...(run.surface === "one" ? { oneMode: true } : {}),
    userPrompt: `Resume the existing goal within its remaining budget and original permissions. Preserve every original constraint and acceptance criterion. Verify the actual output before claiming completion.\n\n${revision.objective}` };
}

export function queueAutomaticGoalResume(chatId: string, expectedVersion: number) {
  return getDb().transaction(() => {
    const request = automaticGoalResumeRequest(chatId, expectedVersion);
    if (!request) throw new Error("long_run_resume_dispatch_unavailable");
    const chat = getDb().prepare("SELECT goal_id FROM chats WHERE id = ?").get(chatId) as { goal_id: string };
    const run = getLongRunByGoalId(chat.goal_id)!;
    getDb().prepare("UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ? WHERE goal_id = ? AND status = 'blocked'")
      .run(new Date().toISOString(), run.goalId);
    return { request, queued: resumeDesktopLongRunManually(run.id, expectedVersion) };
  })();
}
