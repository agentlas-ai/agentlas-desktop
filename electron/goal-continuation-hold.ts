import { createHash } from "node:crypto";
import { getDb } from "./store/db";
import { appendChatMessage, clearChatGoalBindingByGoalId, getChat } from "./store/chats";
import { emitDesktopStoreChange } from "./store/change-bus";
import { completeChatGoalContract } from "./store/chat-goals";
import { getAutomation, toggleAutomation, updateAutomation } from "./store/automations";
import {
  closeOpenGoalLedgerTasks,
  completeGoalLedgerGoal,
  goalProgressKeyForText,
  recordGoalLedgerCycle,
} from "./mcp/goal-ledger";
import {
  GOAL_RUN_SCHEDULE_BACKOFF,
  goalContinuationSchedule,
  isStormbreakerLongRunPrompt,
} from "./hephaestus/loop-engineering";
import { getLongRunByGoalId, longRunOwnerHold } from "./store/long-runs";
import { tryRecordRunEvent } from "./store/run-events";
import { goalStopReasonText } from "../shared/goal-stop-reason-text";

/* Goal continuation diagnostics never disable an authorized mandate. Independent
 * work resumes from current state on a bounded cadence while checks remain in
 * the background. Completion and explicit owner Stop are the terminal owners. */

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
    ? "확인이 필요한 내용은 남겨 두고, 현재 상태에서 할 수 있는 독립 작업을 이어갑니다."
    : "The pending question remains recorded while independent work continues from current state.";
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

const DIAGNOSTIC_EVENT = "goal_continuation_advisory_retry";
const FRESH_CONTEXT_MARKER = "\n\n[Agentlas continuation advisory]\n";

function ownerStoppedOrGoalEnded(goalId: string): boolean {
  const run = getLongRunByGoalId(goalId);
  return Boolean(run && (longRunOwnerHold(run.id) || ["completed", "cancelled", "cancelling"].includes(run.status)));
}

/** This CAS changes only retry timing/context, never enabled, grants, pins or the Goal binding. */
function scheduleAdvisoryContinuation(a: {
  id: string; goalId?: string | null; promptTemplate: string; scheduleHuman?: string;
}, runId: string, reasonCode: string, progressKey: string): void {
  if (!a.goalId) return;
  getDb().transaction(() => {
    const current = getAutomation(a.id);
    if (!current?.enabled || current.goalId !== a.goalId || current.promptTemplate !== a.promptTemplate
      || (a.scheduleHuman !== undefined && current.scheduleHuman !== a.scheduleHuman)
      || ownerStoppedOrGoalEnded(a.goalId!)) return;
    const fingerprint = createHash("sha256").update(`${reasonCode}\0${progressKey}`).digest("hex");
    const prior = getDb().prepare(`SELECT COUNT(*) AS n FROM run_events WHERE automation_id=? AND kind=? AND ts>?
      AND json_extract(payload_json,'$.fingerprint')=?`).get(a.id, DIAGNOSTIC_EVENT,
        new Date(Date.now()-24*60*60_000).toISOString(), fingerprint) as { n: number } | undefined;
    const retryIndex = Math.min(10, Math.max(0, Number(prior?.n ?? 0)));
    const delayMs = Math.min(6*60*60_000, 15*60_000*2**retryIndex);
    const nextAt = new Date(Date.now()+delayMs).toISOString();
    const basePrompt = current.promptTemplate.split(FRESH_CONTEXT_MARKER)[0]!;
    const prompt = basePrompt + FRESH_CONTEXT_MARKER +
      "Start a fresh episode from the current authorized Goal, owner instructions and exact durable receipts. " +
      "Keep the current runtime and action permissions. Previous action effects or result checks may still be unknown. " +
      "Do not replay a pending or uncertain action, invent an owner answer, or re-check the same unchanged observation with a model. " +
      "Choose the next independent useful task; delegate observation and repair in the background. " +
      "If no independent step is due, record the limitation once and keep the bounded host retry. Honor explicit owner Stop.";
    const updated = getDb().prepare(`UPDATE automations SET schedule=?, next_run_at=?, prompt_template=?
      WHERE id=? AND enabled=1 AND goal_id=? AND prompt_template=? AND schedule=?`)
      .run(GOAL_RUN_SCHEDULE_BACKOFF, nextAt, prompt, a.id, a.goalId, current.promptTemplate, current.scheduleHuman);
    if (updated.changes !== 1) return;
    tryRecordRunEvent({ runId, automationId: a.id, kind: DIAGNOSTIC_EVENT,
      sourceEventId: `${DIAGNOSTIC_EVENT}:${runId}`, payload: { reasonCode, fingerprint, retryIndex,
        nextAt, continuation: "fresh-independent-context", predecessorEffects: "unverified" } });
    emitDesktopStoreChange({ entity: "automation", id: a.id });
  })();
}

async function boundedLedgerRead<T>(operation: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<null>(resolve => {
      timer=setTimeout(() => resolve(null),5_000); timer.unref?.();
    })]);
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
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
  const current = getAutomation(a.id);
  if (!current?.enabled || current.goalId !== goalId || ownerStoppedOrGoalEnded(goalId)) return "hard-stop";
  const progressKey = goalProgressKeyForText(input.output ?? "");
  const advisoryRetry = (reasonCode: string): GoalContinuationSettlement => {
    scheduleAdvisoryContinuation(a, input.runId, reasonCode, progressKey);
    return "backoff";
  };
  const continueRequested = input.signals?.stormbreakerContinueRequested === true;
  const notice = (kind: NoticeKind, reason: string | null) => {
    surfaceGoalContinuationNotice({
      kind, goalId, automationId: a.id, automationName: a.name, runId: input.runId, reason, locale: input.locale,
    });
  };

  // The run itself failed: not a goal pass. Keep the goal, retry later, never every 10 minutes.
  if (input.runStatus === "error" || input.runStatus === "partial") {
    return advisoryRetry("goal_continuation_run_incomplete");
  }

  // The model's completion claim reaches the ledger here only: this chat is a
  // division, excluded from client.ts's goal contract block.
  const completionClaim = input.signals?.goalCompletionClaim;
  if (completionClaim?.claimed) {
    await boundedLedgerRead(() => closeOpenGoalLedgerTasks({
      goalId,
      evidence: completionClaim.evidence ?? `automation:${a.id} ${goalProgressKeyForText(input.output ?? "")}`,
      outcomeText: input.output ?? "",
      invocationRunId: input.runId,
    }));
  }
  const decision = await boundedLedgerRead(() => recordGoalLedgerCycle({
    goalId,
    progressKey,
    outcome: `run-${input.runOutcome}`,
  }));
  if (!decision) return advisoryRetry(goalContinuationNeedsOwner(input)
    ? "goal_continuation_owner_input_pending" : "goal_continuation_ledger_unavailable");
  const latest = getAutomation(a.id);
  if (!latest?.enabled || latest.goalId !== goalId || latest.promptTemplate !== a.promptTemplate
    || latest.scheduleHuman !== a.scheduleHuman) return "backoff";
  const hardStop = ownerStoppedOrGoalEnded(goalId);
  const verifiedComplete = !continueRequested
    && input.runStatus === "ok" && input.runOutcome === "accepted"
    && decision.reason === "no_open_tasks";
  if (verifiedComplete) {
    const completed = await boundedLedgerRead(() => completeGoalLedgerGoal({
      goalId, status: "completed", reason: "judged-ok-no-open-tasks-no-marker" }));
    if (completed !== true) return advisoryRetry("goal_continuation_completion_unverified");
    completeChatGoalContract(goalId, "completed");
    clearChatGoalBindingByGoalId(goalId);
    toggleAutomation(a.id, false);
    notice("completed", input.runOutcomeReason);
    return "completed";
  }
  if (hardStop) {
    toggleAutomation(a.id, false);
    notice("hard-stop", goalStopReasonText(decision.reason, decision.blockedReason, input.locale));
    return "hard-stop";
  }
  if (goalContinuationNeedsOwner(input)) return advisoryRetry("goal_continuation_owner_input_pending");
  if (!decision.continue) return advisoryRetry("goal_continuation_internal_diagnostic");
  if (decision.continue || continueRequested) {
    const cadence = goalContinuationSchedule(decision);
    if (a.scheduleHuman !== cadence) updateAutomation(a.id, { scheduleHuman: cadence });
    return "continue";
  }
  return advisoryRetry("goal_continuation_basis_pending");
}

/** A refused internal gate keeps a bounded fresh continuation; owner Stop stays authoritative. */

export function settleRefusedGoalContinuation(input: {
  automation: { id: string; name: string; goalId?: string | null; promptTemplate: string; enabled?: boolean };
  decision: { continue: boolean; reason: string; status: string | null; blockedReason: string | null };
  locale: "ko" | "en";
}): boolean {
  const a = input.automation;
  if (!a.goalId || !isStormbreakerLongRunPrompt(a.promptTemplate)) return false;
  if (input.decision.continue) return false;
  const current = getAutomation(a.id);
  if (!current?.enabled || current.goalId !== a.goalId || current.promptTemplate !== a.promptTemplate) return true;
  if (!ownerStoppedOrGoalEnded(a.goalId)) {
    const state = [a.goalId, input.decision.status ?? "", input.decision.reason, input.decision.blockedReason ?? ""].join("\0");
    scheduleAdvisoryContinuation(a, `gate-${createHash("sha256").update(state).digest("hex").slice(0,32)}`,
      "goal_continuation_gate_advisory", state);
    return true;
  }
  const state = [a.goalId, input.decision.status ?? "", input.decision.reason, input.decision.blockedReason ?? ""].join("\u0000");
  const noticeKey = `gate-${createHash("sha256").update(state, "utf8").digest("hex").slice(0, 32)}`;
  surfaceGoalContinuationNotice({
    kind: "hard-stop",
    goalId: a.goalId,
    automationId: a.id,
    automationName: a.name,
    runId: noticeKey,
    reason: goalStopReasonText(input.decision.reason, input.decision.blockedReason, input.locale),
    locale: input.locale,
  });
  if (a.enabled !== false) toggleAutomation(a.id, false);
  return true;
}
