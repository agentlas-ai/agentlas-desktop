import type { LoginPrerequisiteRef } from "../browser/login-recovery";
import { getDb } from "../store/db";
import { recordRunEvent } from "../store/run-events";
import { INVOCATION_BROWSER_LOGIN_WAIT_EVENT as EVENT, parseInvocationBrowserLoginWait,
  type InvocationBrowserLoginWait } from "../../shared/invocation-browser-login-wait";
export type { InvocationBrowserLoginWait } from "../../shared/invocation-browser-login-wait";

import type { BrowserLoginWait } from "../browser/login-prerequisite";
import type { InvocationExecutionContext } from "../mcp/client";
export type BrowserLoginWaitHandle = BrowserLoginWait;
/** Interactive Main provenance can follow a successor. Independent controllers
 * and exact-run/node capabilities must admit their own next attempt. */
export function canResumeInvocationBrowserLoginWait(context?: InvocationExecutionContext): boolean {
  return !context || ((context.source === "mobile" || context.source === "telegram")
    && !context.scienceRecovery && !context.scienceReview && !context.science && !context.aliveScience
    && !context.nodeId && !context.occurrenceId && !context.onWorkforcePrepareReceipt);
}
export function sameLoginPrerequisite(a: LoginPrerequisiteRef, b: LoginPrerequisiteRef): boolean {
  return a.prerequisiteId === b.prerequisiteId && a.runId === b.runId && a.chatId === b.chatId
    && a.nodeId === b.nodeId && a.sessionId === b.sessionId && a.generation === b.generation;
}
export function latestInvocationBrowserLoginWait(runId: string): InvocationBrowserLoginWait | null {
  const row = getDb().prepare("SELECT payload_json, chat_id FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
    .get(runId, EVENT) as { payload_json: string; chat_id: string | null } | undefined;
  if (!row) return null;
  try {
    return parseInvocationBrowserLoginWait(JSON.parse(row.payload_json).wait, runId, row.chat_id);
  } catch { return null; }
}
function persist(wait: InvocationBrowserLoginWait): void {
  if (!parseInvocationBrowserLoginWait(wait, wait.sourceInvocationId, wait.chatId))
    throw new Error("browser_login_wait_checkpoint_invalid");
  recordRunEvent({ runId: wait.sourceInvocationId, chatId: wait.chatId, kind: EVENT,
    sourceEventId: `browser-login-wait:${wait.prerequisite.prerequisiteId}:${wait.prerequisite.generation}:${wait.state}`,
    payload: { wait } });
}
export function registerInvocationBrowserLoginWait(wait: InvocationBrowserLoginWait): void {
  if (wait.state !== "waiting" || wait.prerequisite.runId !== wait.sourceInvocationId || wait.prerequisite.chatId !== wait.chatId)
    throw new Error("browser_login_wait_scope_mismatch");
  getDb().transaction(() => {
    const prior = latestInvocationBrowserLoginWait(wait.sourceInvocationId);
    if (prior) {
      if (prior.state !== "waiting" || !sameLoginPrerequisite(prior.prerequisite, wait.prerequisite))
        throw new Error("browser_login_wait_already_settled");
      return;
    }
    persist(wait);
  })();
}
/** Live verified capability plus durable custody. A process restart supplies neither. */
export function claimInvocationBrowserLoginWait(input: {
  wait: InvocationBrowserLoginWait; prerequisite: LoginPrerequisiteRef; ownerEpoch: string;
  successorInvocationId: string; isCurrent: () => boolean;
}): boolean {
  return getDb().transaction(() => {
    const current = latestInvocationBrowserLoginWait(input.wait.sourceInvocationId);
    if (!current || current.state !== "waiting" || !current.runtimeQuiesced
      || current.reason === "browser_login_resume_requires_source_controller"
      || current.ownerEpoch !== input.ownerEpoch || !sameLoginPrerequisite(current.prerequisite, input.prerequisite)
      || current.goalId !== input.wait.goalId || current.goalRevision !== input.wait.goalRevision || !input.isCurrent()) return false;
    persist({ ...current, state: "claimed", successorInvocationId: input.successorInvocationId });
    return true;
  })();
}
export function settleInvocationBrowserLoginWait(runId: string, state: "dispatched" | "cancelled" | "blocked", reason: string | null = null, successorInvocationId?: string): void {
  getDb().transaction(() => {
    const current = latestInvocationBrowserLoginWait(runId);
    if (!current || current.state === "cancelled" || current.state === "blocked" || current.state === "dispatched") return;
    persist({ ...current, state, reason, ...(successorInvocationId ? { successorInvocationId } : {}) });
  })();
}
