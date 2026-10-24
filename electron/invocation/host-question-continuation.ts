import type { McpInvocationRequest } from "../../shared/types";
import type { InvocationExecutionContext } from "../mcp/client";
import type { InvocationWorkspaceBinding } from "./workspace-binding";
import { getCommittedQuestionContinuation, readCommittedQuestionHostFence } from "../confirm";
import { questionContinuationHostFenceMatches, type QuestionContinuationHostFence } from "../confirm/question-host-fence";
import { canonicalInvocationRequestJson } from "../store/invocation-admissions";
import { invocationProcessOwner } from "../store/invocation-run-owners";

/** No structural/wire representation can mint this host-local continuation. */
declare const preparedQuestionBrand: unique symbol;
export interface PreparedHostQuestionContinuation { readonly [preparedQuestionBrand]: true }
interface PreparedQuestion {
  chatId: string; sourceMessageId: string; reply: string; requestHash: string;
  request: McpInvocationRequest; workspaceBinding?: InvocationWorkspaceBinding;
  executionContext: InvocationExecutionContext; fence: QuestionContinuationHostFence;
  processOwner: ReturnType<typeof invocationProcessOwner>;
  requestJson: string;
  /** Trusted composition only, held privately; never supplied through extension/renderer input. */
  assertCurrent: () => void;
  beforeSourceStart: () => void;
}
const preparedQuestions = new WeakMap<object,PreparedQuestion>();
const fail = (): never => { throw Object.assign(new Error("question-host-preparation-invalid"), {code:"question-host-preparation-invalid"}); };

export function sealPreparedHostQuestionContinuation(input: {
  chatId: string; sourceMessageId: string; reply: string; request: McpInvocationRequest;
  workspaceBinding?: InvocationWorkspaceBinding; executionContext: InvocationExecutionContext;
  fence: QuestionContinuationHostFence; assertCurrent: () => void; beforeSourceStart: () => void;
}): PreparedHostQuestionContinuation {
  const intent = getCommittedQuestionContinuation(input.chatId,input.sourceMessageId,input.reply);
  if (!intent || input.request.chatId !== input.chatId || input.request.runId !== intent.runId
    || typeof input.assertCurrent !== "function" || typeof input.beforeSourceStart !== "function" || !input.executionContext
    || !questionContinuationHostFenceMatches(readCommittedQuestionHostFence(input.chatId,input.sourceMessageId),input.fence)
    || input.request.permissions !== intent.request.permissions
    || canonicalInvocationRequestJson({chatId:input.chatId,userPrompt:"",runtimeSelection:input.request.runtimeSelection})
      !== canonicalInvocationRequestJson({chatId:input.chatId,userPrompt:"",runtimeSelection:intent.request.runtimeSelection})
    || Boolean(input.request.sessionRouting) !== Boolean(intent.request.sessionRouting)
    || input.request.oneTeamReportTurn === true) return fail();
  // The compiled user prompt intentionally differs from the bare canonical reply.
  // Only the actual trusted domain compiler may supply it; no reply-text parsing restores custody.
  input.assertCurrent();
  const request = structuredClone(input.request);
  const freeze = (value: unknown): void => { if(value && typeof value === "object") {
    for(const child of Object.values(value)) freeze(child); Object.freeze(value);
  }};
  freeze(request);
  const token = Object.freeze(Object.create(null)) as PreparedHostQuestionContinuation;
  preparedQuestions.set(token,{chatId:input.chatId,sourceMessageId:input.sourceMessageId,reply:input.reply.trim(),
    requestHash:intent.requestHash,request,workspaceBinding:input.workspaceBinding,executionContext:input.executionContext,
    fence:Object.freeze({...input.fence}),processOwner:invocationProcessOwner(),
    requestJson:canonicalInvocationRequestJson(request),assertCurrent:input.assertCurrent,beforeSourceStart:input.beforeSourceStart});
  return token;
}

/** Run immediately before reservation and again at the real source start boundary. */
export function assertPreparedHostQuestionContinuation(token: PreparedHostQuestionContinuation,
  expected: {chatId:string;sourceMessageId:string;requestHash:string}): Readonly<PreparedQuestion> {
  const value = token && typeof token === "object" ? preparedQuestions.get(token) : undefined;
  if (!value || value.chatId !== expected.chatId || value.sourceMessageId !== expected.sourceMessageId
    || value.requestHash !== expected.requestHash) return fail();
  const owner = invocationProcessOwner();
  if(owner.ownerId !== value.processOwner.ownerId || owner.ownerKind !== value.processOwner.ownerKind) return fail();
  const intent = getCommittedQuestionContinuation(value.chatId,value.sourceMessageId,value.reply);
  if(!intent || intent.runId !== value.request.runId || intent.requestHash !== value.requestHash
    || !questionContinuationHostFenceMatches(readCommittedQuestionHostFence(value.chatId,value.sourceMessageId),value.fence)) return fail();
  // Captured facts alone are insufficient after a busy/retry await. This private
  // validator re-reads the actual domain, owner/account, Stop, stage and lifetime.
  value.assertCurrent();
  if(canonicalInvocationRequestJson(value.request) !== value.requestJson) return fail();
  return value;
}
