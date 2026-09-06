/** Main-owned bridge from a judged user request to the existing durable ledger.
 * This module does not dispatch a provider, schedule work or grant permissions.
 */
import type { GoalIntakeDecision, GoalCriterion, GoalSourceMessage } from "../../shared/auto-goal";
import { LONG_RUN_TERMINAL_STATUSES, type LongRunBudget } from "../../shared/long-run";
import { getDb } from "../store/db";
import { createStoredAutomaticGoal, completeChatGoalContract } from "../store/chat-goals";
import {
  appendLongRunEvent, bindCurrentGoalRevisionToLongRun, createLongRun, getLongRun,
  longRunContinueDecision, resumeLongRunByUser, transitionLongRun, type LongRunRecord,
} from "../store/long-runs";

function userSource(chatId: string, messageId: string): GoalSourceMessage {
  const row = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(messageId) as
    { chat_id: string; role: string; text: string } | undefined;
  if (!row || row.chat_id !== chatId || row.role !== "user") throw new Error("auto_goal_user_source_required");
  return { chatId, messageId, role: "user", text: row.text };
}

function finiteBudget(budget: LongRunBudget): void {
  if (!Number.isSafeInteger(budget.maxCycles) || budget.maxCycles! < 1 ||
      (budget.maxCostUsd !== null && (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0)) ||
      !Number.isSafeInteger(budget.maxWorkers) || budget.maxWorkers! < 1 ||
      !budget.wallclockDeadline || !Number.isFinite(Date.parse(budget.wallclockDeadline)) ||
      Date.parse(budget.wallclockDeadline) <= Date.now()) throw new Error("auto_goal_finite_budget_required");
}

export function admitJudgedAutomaticGoal(input: {
  goalId: string;
  chatId: string;
  sourceMessageId: string;
  decision: GoalIntakeDecision;
  acceptanceCriteria: readonly GoalCriterion[];
  /** Must come from the host's existing authority context, never a model grant. */
  authorityRefs: readonly string[];
  budget: LongRunBudget;
}): LongRunRecord | null {
  const source = userSource(input.chatId, input.sourceMessageId);
  if (input.decision.intent !== "execute" || input.decision.commitment !== "now" || input.decision.messageId !== source.messageId) return null;
  finiteBudget(input.budget);
  return getDb().transaction(() => {
    const chat = getDb().prepare("SELECT goal_id, origin_surface, project_id FROM chats WHERE id = ?").get(input.chatId) as
      { goal_id: string | null; origin_surface: string | null; project_id: string | null } | undefined;
    if (!chat || chat.origin_surface === "science") throw new Error("auto_goal_surface_not_supported");
    if (chat.goal_id && chat.goal_id !== input.goalId) throw new Error("auto_goal_chat_already_bound");
    const revision = createStoredAutomaticGoal({ goalId: input.goalId, source, decision: input.decision,
      acceptanceCriteria: input.acceptanceCriteria, authorityRefs: input.authorityRefs, createdAt: new Date().toISOString() });
    if (!revision) return null;
    const run = createLongRun({ goalId: input.goalId, rootChatId: input.chatId, projectId: chat.project_id,
      surface: chat.origin_surface === "one" ? "one" : "work", objective: revision.objective,
      acceptanceCriteria: revision.acceptanceCriteria.map((criterion) => criterion.text),
      runtimeFallbackPolicy: "locked", status: "queued", budget: input.budget });
    // A replay must never re-arm a cancelled/completed campaign.
    if (LONG_RUN_TERMINAL_STATUSES.has(run.status)) return run;
    const bound = bindCurrentGoalRevisionToLongRun(run.id, run.version);
    getDb().prepare("UPDATE chats SET goal_id = ? WHERE id = ?").run(input.goalId, input.chatId);
    return bound;
  })();
}

/** Persist control before adapter interruption. A non-settled worker leaves
 * pausing/cancelling durable; the adapter must settle it after interrupt returns.
 */
export function controlAutomaticGoal(input: {
  runId: string;
  sourceMessageId: string;
  command: "pause" | "cancel" | "resume";
  expectedVersion?: number;
  appInstanceId: string;
}): LongRunRecord {
  return getDb().transaction(() => {
    let run = getLongRun(input.runId);
    if (!run || run.surface === "science" || !run.rootChatId) throw new Error("auto_goal_control_not_allowed");
    const source = userSource(run.rootChatId, input.sourceMessageId);
    if (LONG_RUN_TERMINAL_STATUSES.has(run.status)) return run;
    if (input.command === "resume") {
      if (input.expectedVersion === undefined) throw new Error("auto_goal_resume_version_required");
      finiteBudget(run.budget);
      if (run.cycleCount >= run.budget.maxCycles! || (run.budget.maxCostUsd !== null && run.costUsedUsd >= run.budget.maxCostUsd)) throw new Error("auto_goal_budget_exhausted");
      // The scheduler retains a blocked contract while stopping continuation.
      // Only this explicit user resume may reactivate it, within the same CAS
      // transaction and without resetting any consumed budget.
      getDb().prepare(`UPDATE chat_goal_contracts SET status = 'active', completed_at = NULL, updated_at = ?
        WHERE goal_id = ? AND chat_id = ? AND status = 'blocked'`).run(new Date().toISOString(), run.goalId, run.rootChatId);
      run = resumeLongRunByUser(run.id, input.appInstanceId, input.expectedVersion);
      if (!longRunContinueDecision(run.goalId)?.continue) throw new Error("auto_goal_resume_not_ready");
    } else if (input.command === "cancel") {
      run = transitionLongRun({ runId: run.id, to: ["draft", "paused", "blocked"].includes(run.status) ? "cancelled" : "cancelling", actorKind: "user" });
    } else if (!["paused", "blocked", "pausing", "cancelling"].includes(run.status)) {
      run = transitionLongRun({ runId: run.id, to: ["draft", "queued"].includes(run.status) ? "paused" : "pausing", actorKind: "user", reason: "user" });
    }
    const unsettled = getDb().prepare("SELECT COUNT(*) AS n FROM long_run_worker_attempts WHERE run_id = ? AND state IN ('running','uncertain')")
      .get(run.id) as { n: number };
    if (unsettled.n === 0 && ["pausing", "cancelling"].includes(run.status)) {
      run = transitionLongRun({ runId: run.id, to: run.status === "pausing" ? "paused" : "cancelled", actorKind: "host", reason: "user" });
    }
    if (run.status === "cancelled") {
      completeChatGoalContract(run.goalId, "cancelled");
      getDb().prepare("UPDATE chats SET goal_id = NULL WHERE id = ? AND goal_id = ?").run(run.rootChatId, run.goalId);
    }
    appendLongRunEvent({ runId: run.id, kind: "run.user_control", actorKind: "user", actorId: source.messageId,
      payload: { command: input.command, status: run.status } });
    return getLongRun(run.id)!;
  })();
}
