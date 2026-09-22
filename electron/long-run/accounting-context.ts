import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { getLongRunByGoalId, appendLongRunEvent, recordLongRunUsage } from "../store/long-runs";
import { getChatGoalRevision } from "../store/chat-goals";
import { recordRunEvent } from "../store/run-events";
import { longRunMonetaryRefusal, type LongRunUsageInput } from "./budget";

export interface InvocationAccountingOwner { goalId: string; attemptId: string | null }
interface Scope {
  invocationRunId: string;
  chatId: string;
  anchorId: string;
  readOwner: () => InvocationAccountingOwner | null;
  allowHostPausedWait?: boolean;
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

/** Verification owns inference usage without reopening the task's sealed run.
 * This anchor is bookkeeping, not an admitted invocation or execution grant. */
export function withVerificationAccounting<T>(input: {
  executionId: string; anchorId: string; attemptId: string; goalId: string; chatId: string;
}, call: () => T): T {
  const anchor = getDb().prepare(`SELECT e.payload_json FROM run_events e
    JOIN long_run_worker_attempts a ON a.invocation_run_id=e.run_id
    JOIN long_run_workers w ON w.id=a.worker_id
    JOIN long_runs r ON r.id=a.run_id
    WHERE e.id=? AND e.run_id=? AND e.chat_id=? AND e.kind='verifier_execution_started'
      AND a.id=? AND a.state='running' AND w.role='verifier' AND w.run_id=r.id
      AND r.goal_id=? AND r.root_chat_id=e.chat_id`)
    .get(input.anchorId,input.executionId,input.chatId,input.attemptId,input.goalId) as {payload_json:string}|undefined;
  const identity = anchor ? JSON.parse(anchor.payload_json) : null;
  if (identity?.attemptId !== input.attemptId || identity?.goalId !== input.goalId) {
    throw new Error("accounting_verifier_anchor_missing");
  }
  return accountingContext.run({invocationRunId:input.executionId,chatId:input.chatId,anchorId:input.anchorId,
    readOwner:()=>({goalId:input.goalId,attemptId:input.attemptId})},call);
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

/** A scheduled stall diagnosis is not an invocation. Its inference usage is
 * anchored to the exact host-stored pending wait, never a caller's Goal hint. */
export function withGoalWaitAccounting<T>(input: {
  waitId: string; goalId: string; goalRevision: number; checkpointId: string; chatId: string;
}, call: () => T): T {
  const readOwner = (): InvocationAccountingOwner => {
    const run = getLongRunByGoalId(input.goalId);
    const revision = getChatGoalRevision(input.goalId);
    const row = run ? getDb().prepare("SELECT payload_json FROM long_run_events WHERE run_id=? AND kind='run.wait_subscription' ORDER BY seq DESC LIMIT 1")
      .get(run.id) as { payload_json: string } | undefined : undefined;
    let wait: Record<string, unknown> | null = null;
    try { wait = row ? JSON.parse(row.payload_json).subscription : null; } catch { /* Refuse malformed host state. */ }
    if (!run || run.surface !== "one" || run.rootChatId !== input.chatId
      || !["waiting_tool", "paused"].includes(run.status)
      || (run.status === "paused" && !["app_closed", "crash_recovery"].includes(run.pauseReason ?? ""))
      || revision?.lifecycle !== "ongoing" || revision.revision !== input.goalRevision
      || wait?.waitId !== input.waitId || wait?.goalId !== input.goalId
      || wait?.goalRevision !== input.goalRevision || wait?.chatId !== input.chatId
      || wait?.checkpointId !== input.checkpointId || wait?.state !== "pending"
      || wait?.recoveryMode !== "stall_replan") throw new Error("accounting_goal_wait_anchor_missing");
    return { goalId: input.goalId, attemptId: null };
  };
  readOwner();
  const executionId = `goal-wait-replan:${input.waitId}`;
  const anchor = recordRunEvent({ runId: executionId, chatId: input.chatId, kind: "goal_wait_replan_started",
    sourceEventId: `goal-wait-replan:${input.waitId}:started`, payload: {
      schemaVersion: "agentlas.goal-wait-replan-accounting.v1", waitId: input.waitId,
      goalId: input.goalId, goalRevision: input.goalRevision, checkpointId: input.checkpointId,
    } });
  return accountingContext.run({ invocationRunId: executionId, chatId: input.chatId,
    anchorId: anchor.id, readOwner, allowHostPausedWait: true }, call);
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
    if (["completed", "cancelled", "cancelling", "failed", "pausing"].includes(goal.status)
      || (goal.status === "paused" && !(scope.allowHostPausedWait
        && ["app_closed", "crash_recovery"].includes(goal.pauseReason ?? "")))) {
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
