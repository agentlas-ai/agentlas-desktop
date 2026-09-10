/** Main-owned bridge from a judged user request to the existing durable ledger.
 * This module does not dispatch a provider, schedule work or grant permissions.
 */
import type { GoalIntakeDecision, GoalCriterion, GoalSourceMessage } from "../../shared/auto-goal";
import { LONG_RUN_TERMINAL_STATUSES, type LongRunBudget } from "../../shared/long-run";
import { getDb } from "../store/db";
import { createStoredAutomaticGoal, completeChatGoalContract } from "../store/chat-goals";
import { getChat, setChatGoalBinding } from "../store/chats";
import {
  appendLongRunEvent, bindCurrentGoalRevisionToLongRun, createLongRun, getLongRun, getLongRunByGoalId,
  longRunContinueDecision, resumeLongRunByUser, transitionLongRun, type LongRunRecord,
} from "../store/long-runs";

function userSource(chatId: string, messageId: string): GoalSourceMessage {
  const row = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?").get(messageId) as
    { chat_id: string; role: string; text: string } | undefined;
  if (!row || row.chat_id !== chatId || row.role !== "user") throw new Error("auto_goal_user_source_required");
  return { chatId, messageId, role: "user", text: row.text };
}

/*
 * ★오너 지시 2026-09-08: 주기·시간 무제한.
 *
 * 예전에는 주기와 마감을 **필수**로 요구해서, 무제한(null)을 주면 곧바로 거절했다. 이제
 * null 은 "제한 없음"이라는 뜻으로 받는다. 값이 들어오면 그 값이 말이 되는지는 그대로 본다 —
 * 무제한을 허용하는 것과 잘못된 값을 허용하는 것은 다르다.
 */
function finiteBudget(budget: LongRunBudget): void {
  const badCycles = budget.maxCycles != null
    && (!Number.isSafeInteger(budget.maxCycles) || budget.maxCycles < 1);
  const badCost = budget.maxCostUsd !== null
    && (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0);
  const badWorkers = !Number.isSafeInteger(budget.maxWorkers) || budget.maxWorkers! < 1;
  const badDeadline = budget.wallclockDeadline != null
    && (!Number.isFinite(Date.parse(budget.wallclockDeadline))
      || Date.parse(budget.wallclockDeadline) <= Date.now());
  if (badCycles || badCost || badWorkers || badDeadline) throw new Error("auto_goal_finite_budget_required");
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
    if (chat.goal_id && chat.goal_id !== input.goalId) {
      const priorRun = getLongRunByGoalId(chat.goal_id);
      // Older releases could leave a chat bound to a campaign that had already
      // terminated. Repair that stale binding inside the same admission
      // transaction so the next user request does not lose automatic Goal
      // tracking. A live prior campaign remains authoritative.
      if (!priorRun || !LONG_RUN_TERMINAL_STATUSES.has(priorRun.status)) {
        throw new Error("auto_goal_chat_already_bound");
      }
      completeChatGoalContract(priorRun.goalId, priorRun.status === "completed" ? "completed" : "cancelled");
      // Release through the binding writer, never raw SQL: setChatGoalBinding is
      // the only path that emits the store-change signal, and skipping it leaves a
      // finished Goal drawn as still running until the next unrelated refresh.
      setChatGoalBinding(input.chatId, null);
      chat.goal_id = null;
    }
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
      /*
       * ★null 은 "무제한"이지 0 이 아니다. `run.cycleCount >= null` 은 자바스크립트에서
       * `0 >= 0` 으로 풀려 **첫 주기부터 예산 소진**이 된다 — 무제한이 오히려 즉시 종료가
       * 되는 자리라, 상한을 푸는 변경에서 반드시 함께 고쳐야 한다.
       */
      const cyclesExhausted = run.budget.maxCycles != null && run.cycleCount >= run.budget.maxCycles;
      const costExhausted = run.budget.maxCostUsd !== null && run.costUsedUsd >= run.budget.maxCostUsd;
      if (cyclesExhausted || costExhausted) throw new Error("auto_goal_budget_exhausted");
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
      /*
       * ★원장만 바꾸고 화면에 알리지 않으면, 끝난 목표가 화면에서 계속 진행 중이다.
       *
       * 여기는 결속을 직접 SQL 로 풀고 있었다. 그러면 setChatGoalBinding 안의
       * emitDesktopStoreChange 를 지나지 않아 **대화 화면이 갱신 신호를 못 받는다.**
       * 나머지 세 완료 지점은 전부 그 함수를 쓴다 — 이 자리만 달랐다.
       * (QA 실측 2026-09-08: 원장이 닫힌 뒤에도 목표 칩과 "목표 추진" 토글이 그대로였다.)
       */
      const rootChatId = run.rootChatId;
      if (rootChatId && getChat(rootChatId)?.goalId === run.goalId) setChatGoalBinding(rootChatId, null);
    }
    appendLongRunEvent({ runId: run.id, kind: "run.user_control", actorKind: "user", actorId: source.messageId,
      payload: { command: input.command, status: run.status } });
    return getLongRun(run.id)!;
  })();
}
