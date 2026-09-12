import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { getLongRunByGoalId, appendLongRunEvent, recordLongRunUsage } from "../store/long-runs";
import { recordRunEvent } from "../store/run-events";
import { longRunMonetaryRefusal, type LongRunUsageInput } from "./budget";

export interface InvocationAccountingOwner { goalId: string; attemptId: string | null }
interface Scope {
  invocationRunId: string;
  chatId: string;
  anchorId: string;
  readOwner: () => InvocationAccountingOwner | null;
}
const accountingContext = new AsyncLocalStorage<Scope>();

/** Main passes its own captured identity getter, never a model/renderer Goal hint. */
export function withInvocationAccounting<T>(input: {
  runId: string; chatId: string; readOwner: Scope["readOwner"];
}, call: () => T): T {
  const anchor = getDb().prepare("SELECT id,chat_id FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1")
    .get(input.runId) as { id: string; chat_id: string | null } | undefined;
  if (!anchor || anchor.chat_id !== input.chatId) throw new Error("accounting_invocation_anchor_missing");
  return accountingContext.run({ invocationRunId: input.runId, chatId: input.chatId, anchorId: anchor.id, readOwner: input.readOwner }, call);
}

/** Pre-start inference has its own marker; it is never an admitted invocation. */
export function withInvocationPreflightAccounting<T>(input: { runId: string; chatId: string }, call: () => T): T {
  if (!input.runId?.trim() || !input.chatId?.trim()) throw new Error("accounting_preflight_identity_required");
  const db = getDb();
  const chat = db.prepare("SELECT goal_id FROM chats WHERE id=?").get(input.chatId) as { goal_id: string | null } | undefined;
  if (!chat) throw new Error("accounting_preflight_chat_missing");
  if (db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind='invoke_started' LIMIT 1").get(input.runId)) {
    throw new Error("accounting_preflight_already_admitted");
  }
  const goal = chat.goal_id ? getLongRunByGoalId(chat.goal_id) : null;
  const goalId = goal && goal.surface !== "science" && goal.rootChatId === input.chatId ? goal.goalId : null;
  const anchor = recordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "invoke_preflight_started",
    sourceEventId: `preflight:${input.runId}`, payload: { schemaVersion: "agentlas.invocation-preflight.v1", goalId } });
  // An existing marker retains its original owner even if the chat was steered.
  const capturedGoalId = typeof anchor.payload?.goalId === "string" ? anchor.payload.goalId : null;
  return accountingContext.run({ invocationRunId: input.runId, chatId: input.chatId, anchorId: anchor.id,
    readOwner: () => capturedGoalId ? { goalId: capturedGoalId, attemptId: null } : null }, call);
}

export interface AccountedInferenceAttempt {
  sourceId: string;
  complete(usage: LongRunUsageInput["observedUsage"], outcome: "returned" | "failed" | "timeout" | "cancelled"): void;
}

/** Call only at an actual provider dispatch, after cache lookup. */
export function beginAccountedInference(input: { kind: string; model?: string | null; source?: string | null }): AccountedInferenceAttempt | null {
  const scope = accountingContext.getStore();
  if (!scope) return null;
  const owner = scope.readOwner();
  if (owner) {
    const goal = getLongRunByGoalId(owner.goalId);
    if (!goal || goal.surface === "science") throw new Error("accounting_goal_owner_invalid");
    if (["completed", "cancelled", "cancelling", "failed", "paused", "pausing"].includes(goal.status)) {
      throw new Error("accounting_goal_terminal");
    }
    const refusal = longRunMonetaryRefusal(goal);
    if (refusal) throw new Error(refusal);
  }
  const sourceId = `judgment:${scope.invocationRunId}:${randomUUID()}`;
  const usageIdentity = { sourceId, invocationRunId: scope.invocationRunId, scopeAnchorId: scope.anchorId,
    ...(owner?.attemptId ? { attemptId: owner.attemptId } : {}) };
  const db = getDb();
  db.transaction(() => {
    recordRunEvent({ runId: scope.invocationRunId, chatId: scope.chatId, kind: "runtime_usage_started", sourceEventId: `${sourceId}:started`,
      payload: { schemaVersion: "agentlas.inference-accounting.v1", sourceId, scopeAnchorId: scope.anchorId,
        attribution: owner ? "goal" : "unassigned", goalId: owner?.goalId ?? null, attemptId: owner?.attemptId ?? null, runtime: { kind: input.kind, model: input.model ?? null, source: input.source ?? null }, costStatus: "unknown" } });
    if (owner) appendLongRunEvent({ runId: getLongRunByGoalId(owner.goalId)!.id, kind: "run.usage_started", actorKind: "host",
      sourceEventId: `${sourceId}:started`, payload: { sourceId, invocationRunId: scope.invocationRunId, attemptId: owner.attemptId } });
  }).immediate();
  let settled = false;
  return { sourceId, complete: (observedUsage, outcome) => {
    // Timeout/Stop is a final observation. A late provider cannot replace it.
    if (settled) return;
    settled = true;
    db.transaction(() => {
      if (owner) recordLongRunUsage(owner.goalId, { ...usageIdentity, observedUsage });
      recordRunEvent({ runId: scope.invocationRunId, chatId: scope.chatId, kind: "runtime_usage_recorded", sourceEventId: `${sourceId}:result`,
        payload: { schemaVersion: "agentlas.inference-accounting.v1", sourceId, scopeAnchorId: scope.anchorId,
          attribution: owner ? "goal" : "unassigned", goalId: owner?.goalId ?? null, attemptId: owner?.attemptId ?? null, outcome,
          tokens: observedUsage ?? null, cost: { status: "unknown", usd: null, reasonCode: "provider_cost_unavailable" } } });
    }).immediate();
  } };
}
