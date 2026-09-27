import { createHash } from "node:crypto";
import { getDb } from "./store/db";
import { appendChatMessage, clearChatGoalBindingByGoalId, getChat } from "./store/chats";
import { emitDesktopStoreChange } from "./store/change-bus";
import { completeChatGoalContract } from "./store/chat-goals";
import { toggleAutomation, updateAutomation } from "./store/automations";
import {
  closeOpenGoalLedgerTasks,
  completeGoalLedgerGoal,
  GOAL_HARD_STOP_REASONS,
  goalProgressKeyForText,
  recordGoalLedgerCycle,
} from "./mcp/goal-ledger";
import {
  GOAL_RUN_SCHEDULE_BACKOFF,
  goalContinuationSchedule,
  isStormbreakerLongRunPrompt,
} from "./hephaestus/loop-engineering";

/*
 * Settlement of a hidden goal continuation run — the ONE place that decides
 * whether the continuation completes, stops, parks, backs off or keeps going.
 *
 * Why here and not inside runOne's legacy branch (where it used to live): every
 * automation row runs through the graph path (synthesizeLegacyGraph), so that
 * branch was never reached and none of these rules ran. Live 2026-09-27 (One
 * chat "Youtube launch", every-10m): the continuation re-woke every 10 minutes
 * on the same needs_input blocker (~716k input tokens per wake) while the goal
 * chat showed nothing; "X Marketing" logged 7 identical needs_input wakes.
 *
 *   completed  = judge ok(accepted) + no continue marker + ledger has no open task
 *                → ledger/contract closed, this row off, goal chat told once
 *   hard stop  = ledger says budget / blocked / terminal / paused
 *                → contract blocked, row off, goal chat told the reason once
 *   needs owner= judge needs_input → goal chat told once, row off (the owner's
 *                next turn re-enables exactly this row, mcp/client.ts)
 *   backoff    = the run itself failed (error / graph partial) → every-2h, no
 *                ledger cycle (a failed pass is not a goal pass)
 *   continue   = ledger or model asks for more → cadence from the ledger
 *   no basis   = unfinished but nothing asks to continue → row off, goal stays
 * Goal-less stormbreaker rows are not touched (their schedule is the contract).
 */

export type GoalContinuationSettlement =
  | "not-a-continuation" | "completed" | "hard-stop" | "needs-owner" | "backoff" | "continue" | "stopped-no-basis";

export interface GoalContinuationSignals {
  stormbreakerContinueRequested: boolean;
  goalCompletionClaim?: { claimed: boolean; evidence: string | null; goalId: string | null };
}

export function goalContinuationNeedsOwner(input: { runStatus: string; runOutcome: string | null }): boolean {
  return input.runStatus === "needs_input" || input.runOutcome === "needs_input";
}

export function goalContinuationSourceChat(goalId: string): string | null {
  try {
    const row = getDb().prepare("SELECT chat_id AS chatId FROM chat_goal_contracts WHERE goal_id = ? LIMIT 1")
      .get(goalId) as { chatId: string | null } | undefined;
    return row?.chatId && getChat(row.chatId) ? row.chatId : null;
  } catch {
    return null;
  }
}

type NoticeKind = "needs-owner" | "completed" | "hard-stop";

function noticeTail(kind: NoticeKind, locale: "ko" | "en"): string {
  if (kind === "completed") {
    return locale === "ko"
      ? "목표를 완료로 닫고 목표 이어가기를 껐어요."
      : "The goal is closed as completed and its continuation is turned off.";
  }
  if (kind === "hard-stop") {
    return locale === "ko"
      ? "목표 이어가기를 멈췄어요. 이 대화에서 다시 시키면 새로 이어갑니다."
      : "The goal continuation stopped. Ask again in this conversation to pick it up.";
  }
  return locale === "ko"
    ? "목표 이어가기를 멈춰 두었어요. 같은 확인을 10분마다 반복하지 않습니다. 필요한 일을 마치거나 답을 보내 주시면 이 대화에서 다시 이어갑니다."
    : "The goal continuation is paused so it does not re-check the same thing every 10 minutes. Finish the step above or reply here and it continues from this conversation.";
}

/** Writes one owner-facing line for this run into the goal chat. Idempotent per run. */
export function surfaceGoalContinuationNotice(input: {
  kind: NoticeKind;
  goalId: string;
  automationId: string;
  automationName: string;
  runId: string;
  reason: string | null;
  locale: "ko" | "en";
}): string | null {
  const chatId = goalContinuationSourceChat(input.goalId);
  if (!chatId) return null;
  const db = getDb();
  const already = db.prepare(
    "SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'system' AND host_notice_json LIKE ? LIMIT 1",
  ).get(chatId, `%"runId":${JSON.stringify(input.runId)}%`) as { id: string } | undefined;
  if (already) return already.id;
  const reason = (input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 1_200);
  const fallback = input.kind === "needs-owner"
    ? (input.locale === "ko" ? "입력이 필요합니다." : "Needs your input.")
    : "";
  const body = [input.automationName, reason || fallback, noticeTail(input.kind, input.locale)].filter(Boolean).join("\n\n");
  const message = appendChatMessage(chatId, "system", body, {
    hostNotice: { purpose: "automation-report", runId: input.runId, automationId: input.automationId },
  });
  emitDesktopStoreChange({ entity: "chat", id: chatId });
  return message.id;
}

export async function settleGoalContinuationRun(input: {
  automation: { id: string; name: string; goalId?: string | null; promptTemplate: string; scheduleHuman: string };
  runId: string;
  runStatus: string;
  runOutcome: string | null;
  runOutcomeReason: string | null;
  runError: string | null;
  output: string | null;
  signals: GoalContinuationSignals | null;
  locale: "ko" | "en";
}): Promise<GoalContinuationSettlement> {
  const a = input.automation;
  // Only goal-bound continuations are settled here. A goal-less stormbreaker row keeps
  // its own schedule: a missing continue signal must not silently disable a recurring
  // automation (scripts/test-automations-store.cjs "Storm Long Run").
  if (!isStormbreakerLongRunPrompt(a.promptTemplate) || !a.goalId) return "not-a-continuation";
  const goalId = a.goalId;
  const continueRequested = input.signals?.stormbreakerContinueRequested === true;
  const notice = (kind: NoticeKind, reason: string | null) => {
    surfaceGoalContinuationNotice({
      kind, goalId, automationId: a.id, automationName: a.name, runId: input.runId, reason, locale: input.locale,
    });
  };

  // The run itself failed: not a goal pass. Keep the goal, retry later, never every 10 minutes.
  if (input.runStatus === "error" || input.runStatus === "partial") {
    if (a.scheduleHuman !== GOAL_RUN_SCHEDULE_BACKOFF) updateAutomation(a.id, { scheduleHuman: GOAL_RUN_SCHEDULE_BACKOFF });
    return "backoff";
  }

  // The model's completion claim reaches the ledger here only: this chat is a
  // division, excluded from client.ts's goal contract block.
  if (input.signals?.goalCompletionClaim?.claimed) {
    await closeOpenGoalLedgerTasks({
      goalId,
      evidence: input.signals.goalCompletionClaim.evidence ?? `automation:${a.id} ${goalProgressKeyForText(input.output ?? "")}`,
      outcomeText: input.output ?? "",
      invocationRunId: input.runId,
    });
  }
  const decision = await recordGoalLedgerCycle({
    goalId,
    progressKey: goalProgressKeyForText(input.output ?? ""),
    outcome: `run-${input.runOutcome}`,
  });
  if (!decision) {
    if (goalContinuationNeedsOwner(input)) {
      notice("needs-owner", input.runOutcomeReason ?? input.runError ?? input.output);
      toggleAutomation(a.id, false);
      return "needs-owner";
    }
    if (!continueRequested) {
      toggleAutomation(a.id, false);
      return "stopped-no-basis";
    }
    return "continue";
  }
  const hardStop = !decision.continue && GOAL_HARD_STOP_REASONS.has(decision.reason);
  const verifiedComplete = !continueRequested
    && input.runStatus === "ok" && input.runOutcome === "accepted"
    && decision.reason === "no_open_tasks";
  if (verifiedComplete) {
    await completeGoalLedgerGoal({ goalId, status: "completed", reason: "judged-ok-no-open-tasks-no-marker" });
    completeChatGoalContract(goalId, "completed");
    clearChatGoalBindingByGoalId(goalId);
    toggleAutomation(a.id, false);
    notice("completed", input.runOutcomeReason);
    return "completed";
  }
  if (hardStop) {
    completeChatGoalContract(goalId, "blocked");
    clearChatGoalBindingByGoalId(goalId);
    toggleAutomation(a.id, false);
    notice("hard-stop", [decision.reason, decision.blockedReason].filter(Boolean).join(" · "));
    return "hard-stop";
  }
  if (goalContinuationNeedsOwner(input)) {
    notice("needs-owner", input.runOutcomeReason ?? input.runError ?? input.output);
    toggleAutomation(a.id, false);
    return "needs-owner";
  }
  if (decision.continue || continueRequested) {
    const cadence = goalContinuationSchedule(decision);
    if (a.scheduleHuman !== cadence) updateAutomation(a.id, { scheduleHuman: cadence });
    return "continue";
  }
  // Unfinished but nothing asks to continue: stop re-running, claim nothing; the goal stays active.
  toggleAutomation(a.id, false);
  return "stopped-no-basis";
}

/**
 * The pre-run gate refused this continuation because the ledger says stop
 * (blocked / terminal / paused / budget). Before this, the gate only returned
 * "not accepted": the row stayed enabled with a past next_run_at and the owner
 * was never told — live 2026-09-27 "X Marketing": ledger blocked
 * (auto_goal_owner_review_required) since 11:53Z, row still on every-10m.
 *
 * Disable the row and tell the goal chat once per ledger state. The goal
 * contract and the chat's goal binding stay as they are: the owner's next turn
 * (mcp/client.ts) or Resume (ipc.ts) re-enables exactly this row. Transient
 * refusals (waiting_*, verifying, revision pending, replan) are left alone.
 */
export function settleRefusedGoalContinuation(input: {
  automation: { id: string; name: string; goalId?: string | null; promptTemplate: string; enabled?: boolean };
  decision: { continue: boolean; reason: string; status: string | null; blockedReason: string | null };
  locale: "ko" | "en";
}): boolean {
  const a = input.automation;
  if (!a.goalId || !isStormbreakerLongRunPrompt(a.promptTemplate)) return false;
  if (input.decision.continue || !GOAL_HARD_STOP_REASONS.has(input.decision.reason)) return false;
  const state = [a.goalId, input.decision.status ?? "", input.decision.reason, input.decision.blockedReason ?? ""].join("\u0000");
  const noticeKey = `gate-${createHash("sha256").update(state, "utf8").digest("hex").slice(0, 32)}`;
  surfaceGoalContinuationNotice({
    kind: "hard-stop",
    goalId: a.goalId,
    automationId: a.id,
    automationName: a.name,
    runId: noticeKey,
    reason: [input.decision.reason, input.decision.blockedReason].filter(Boolean).join(" · "),
    locale: input.locale,
  });
  if (a.enabled !== false) toggleAutomation(a.id, false);
  return true;
}
