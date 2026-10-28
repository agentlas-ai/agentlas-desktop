import { getDb } from "../store/db";
import { getChat, setChatContinuousMode, setChatGoalBinding } from "../store/chats";
import { completeChatGoalContract } from "../store/chat-goals";
import { appendLongRunEvent, getLongRunByGoalId, transitionLongRun, type LongRunRecord } from "../store/long-runs";
import { LONG_RUN_TERMINAL_STATUSES } from "../../shared/long-run";
import { hostOwnerCardDecisionForReply, type HostOwnerCardDecision, type HostOwnerCardKind } from "./goal-owner-card";

/*
 * The owner's answer to a host-written Goal card is a typed decision, stored as such, and a stop is applied by the host
 * whatever any judge or verifier can do at that moment (owner rule: close/stop/cancel never depend on another state).
 *
 * Finance validation 2026-10-28 (codex gpt-6.1-terra, isolated app): the Goal stopped on the idle card, the owner picked
 * "여기서 멈추고 지금까지를 정리해 주세요", and the Goal did not stop. The choice reached the host only as the reply text, so the
 * owner turn reopened the Goal like any other message (stoppedGoalMessageReopens), the summary turn was verified
 * inconclusive, the same card was posted again and the room sat in "waiting for your answer"; the owner-answer judge that
 * could have read the words was unavailable the whole time (judge_unavailable:unsupported).
 *
 * Now the card is recorded on the Goal's ledger when it is posted (which message, which kind), and an owner reply that is
 * exactly one of that card's options (goal-owner-card.ts: the closed set of replies the app's own answer paths write) is
 * the decision. "stop_and_summarize" ends the Goal (cancelled, contract closed, room unbound, its own continuation
 * automation switched off) before the owner's turn starts; the turn then runs as an ordinary turn and writes the summary
 * the owner asked for, once. "continue_on_own_judgment" is recorded and the turn resumes the Goal as before.
 */
export const HOST_OWNER_CARD_POSTED_KIND = "run.owner_card_posted";
export const HOST_OWNER_CARD_DECIDED_KIND = "run.owner_card_decided";
export const OWNER_CARD_STOP_REASON = "owner_card_stop_and_summarize";

export interface PendingHostOwnerCard {
  cardKind: HostOwnerCardKind;
  sourceMessageId: string;
  seq: number;
}

/** Ledger fact: the host posted this card for this Goal, as this chat message. Written right after the message. */
export function recordHostOwnerCardPosted(input: { longRunId: string; cardKind: HostOwnerCardKind; sourceMessageId: string; invocationRunId: string }): void {
  appendLongRunEvent({ runId: input.longRunId, kind: HOST_OWNER_CARD_POSTED_KIND, actorKind: "host",
    payload: { cardKind: input.cardKind, sourceMessageId: input.sourceMessageId, invocationRunId: input.invocationRunId } });
}

/** The newest card the host posted for this run that no decision has answered yet. */
export function pendingHostOwnerCard(longRunId: string): PendingHostOwnerCard | null {
  const posted = getDb().prepare(`SELECT seq, payload_json FROM long_run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1`)
    .get(longRunId, HOST_OWNER_CARD_POSTED_KIND) as { seq: number; payload_json: string } | undefined;
  if (!posted) return null;
  const decided = getDb().prepare(`SELECT 1 FROM long_run_events WHERE run_id = ? AND kind = ? AND seq > ? LIMIT 1`)
    .get(longRunId, HOST_OWNER_CARD_DECIDED_KIND, posted.seq);
  if (decided) return null;
  try {
    const payload = JSON.parse(posted.payload_json) as { cardKind?: unknown; sourceMessageId?: unknown };
    if (payload.cardKind !== "goal_idle_stop" || typeof payload.sourceMessageId !== "string" || !payload.sourceMessageId) return null;
    return { cardKind: payload.cardKind, sourceMessageId: payload.sourceMessageId, seq: posted.seq };
  } catch { return null; }
}

export interface HostOwnerCardAnswer {
  run: LongRunRecord;
  card: PendingHostOwnerCard;
  decision: HostOwnerCardDecision;
}

/**
 * The typed decision this owner reply makes on the Goal's pending host card, or null (no pending card, another card's answer,
 * or a reply that is not exactly one of the card's options). `sourceMessageId`, when the answer path names the question it
 * answers (the question sheet, the phone's canonical answer), must be that card.
 */
export function hostOwnerCardAnswer(input: { goalId: string | null | undefined; chatId: string; reply: unknown; sourceMessageId?: string | null }): HostOwnerCardAnswer | null {
  if (!input.goalId) return null;
  const run = getLongRunByGoalId(input.goalId);
  if (!run || run.surface === "science" || run.rootChatId !== input.chatId || LONG_RUN_TERMINAL_STATUSES.has(run.status)) return null;
  const card = pendingHostOwnerCard(run.id);
  if (!card) return null;
  if (input.sourceMessageId && input.sourceMessageId !== card.sourceMessageId) return null;
  const decision = hostOwnerCardDecisionForReply(card.cardKind, input.reply);
  return decision ? { run, card, decision } : null;
}

function recordDecision(answer: HostOwnerCardAnswer, via: string): void {
  appendLongRunEvent({ runId: answer.run.id, kind: HOST_OWNER_CARD_DECIDED_KIND, actorKind: "user",
    payload: { cardKind: answer.card.cardKind, decision: answer.decision, sourceMessageId: answer.card.sourceMessageId, via: via.slice(0, 40) } });
}

/**
 * Apply the owner's decision. Returns "stopped" when the Goal was ended here (the caller's turn is then an ordinary turn of
 * the room), "continue" when it was only recorded. A stop never waits on a judge, a verifier, a runtime or a live turn of
 * another chat; the only thing that can refuse it is the Goal having moved on (ended, rebound) — then nothing is written.
 */
export function applyHostOwnerCardDecision(answer: HostOwnerCardAnswer, input: { chatId: string; via: string }): "stopped" | "continue" | "unchanged" {
  if (answer.decision !== "stop_and_summarize") {
    recordDecision(answer, input.via);
    return "continue";
  }
  const goalId = answer.run.goalId;
  const ended = getDb().transaction((): boolean => {
    const current = getLongRunByGoalId(goalId);
    if (!current || current.id !== answer.run.id || LONG_RUN_TERMINAL_STATUSES.has(current.status)) return false;
    if (pendingHostOwnerCard(current.id)?.seq !== answer.card.seq) return false;
    recordDecision(answer, input.via);
    appendLongRunEvent({ runId: current.id, kind: "run.user_control", actorKind: "user",
      payload: { action: "stop", decision: answer.decision, source: "owner_card", sourceMessageId: answer.card.sourceMessageId,
        chatId: input.chatId, goalId } });
    // Appending a ledger event advances the run's version: fence the transitions on the row as it is now.
    let run = getLongRunByGoalId(goalId) ?? current;
    if (!["draft", "paused", "blocked", "cancelling"].includes(run.status)) {
      run = transitionLongRun({ runId: run.id, to: "cancelling", actorKind: "user", reason: OWNER_CARD_STOP_REASON, expectedVersion: run.version });
    }
    transitionLongRun({ runId: run.id, to: "cancelled", actorKind: "user", reason: OWNER_CARD_STOP_REASON, expectedVersion: run.version });
    completeChatGoalContract(goalId, "cancelled");
    if (getChat(input.chatId)?.goalId === goalId) {
      setChatGoalBinding(input.chatId, null);
      setChatContinuousMode(input.chatId, false);
    }
    return true;
  })();
  if (!ended) return "unchanged";
  // The Goal's own continuation automation (if this Goal was started by one) stops with it, exactly as the Goal's Stop control
  // does; a row whose creation owner is not this Goal is never touched.
  try {
    const { findAutomationByGoalId, toggleAutomation } = require("../store/automations") as typeof import("../store/automations");
    const { currentAutomationGoalExecutionOwnerMatches } = require("../automation-execution-control") as typeof import("../automation-execution-control");
    const continuation = findAutomationByGoalId(goalId);
    if (continuation?.enabled && currentAutomationGoalExecutionOwnerMatches(continuation.id, goalId, input.chatId, answer.run.id)) {
      toggleAutomation(continuation.id, false);
    }
  } catch (error) {
    console.warn("[goal-owner-card] continuation automation could not be switched off:", error instanceof Error ? error.message : String(error));
  }
  return "stopped";
}
