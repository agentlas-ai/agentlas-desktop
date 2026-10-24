import { createHash } from "node:crypto";
import { scienceConversationService, scienceStore } from "agentlas-science";
import type { McpInvocationRequest, QuestionContinuationReceipt, RuntimeSelection } from "../../shared/types";
import { QUESTION_CONTINUATION_REPLY_MAX_BYTES, QUESTION_CONTINUATION_REPLY_MAX_LENGTH } from "../../shared/types";
import { projectQuestionDecisionText, type QuestionDecisionView } from "../../shared/question-decision";
import { normalizeRuntimeSelectionInput } from "../../shared/runtime-selection";
import { currentUiLocale } from "../ui-locale";
import { composeQuestionReply } from "../../shared/question-reply";
import { commitPendingConfirmationAnswer, committedQuestionContinuationIsCurrent, getCommittedQuestionContinuation, readCommittedQuestionHostFence, readQuestionDecision, observeQuestionHostOwnerIntent, reconfirmCommittedQuestionHostFence } from "../confirm";
import { questionContinuationHostFenceMatches, type QuestionContinuationHostFence } from "../confirm/question-host-fence";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getInvocationRunReceipt } from "../store/run-events";
import { agentContextOwnerBinding } from "../runtime/agent-context-admission";
import { workingSessionScope } from "../runtime/session-scope";
import { invocationService } from "../invocation/service";
import { sealPreparedHostQuestionContinuation } from "../invocation/host-question-continuation";
import type { InvocationExecutionContext } from "../mcp/client";
import type { InvocationWorkspaceBinding } from "../invocation/workspace-binding";

type Scope = {projectId:string;conversationId:string};
type Control = {schema:string;conversationControlEpoch:number;stopped:boolean;executionRevision:number;
  lifetime:{agentId:string;controlEpoch:number;status:string}|null;
  budget:{conversationId:string;epoch:number;status:string}|null;loop:{id:string;version:number;status:string}|null};
export interface ScienceQuestionPreparationInput extends Scope {
  sourceTurnId:string; sourceRunId:string; sourceMessageId:string; sourceMessageSha256:string;
  invocationRunId:string; reply:string; requestHash:string; expectedControlFence:Control;
  runtimeSelection:RuntimeSelection|null; permissions:"read"|"write"|"full"; locale?:"ko"|"en";
}
type Store = ReturnType<typeof scienceStore> & {
  canonicalDecisionControlFence(projectId:string,conversationId:string):Control;
  canonicalDecisionSourceReference(projectId:string,conversationId:string,turnId:string):{sourceMessageId:string;sourceContentSha256:string;sourceRawContentSha256?:string}|null;
};
type Prepared = {turn:ReturnType<Store["getTurnByInvocationRunId"]> & {};
  userMessage:unknown;request:McpInvocationRequest;workspaceBinding?:InvocationWorkspaceBinding;executionContext:InvocationExecutionContext};
type Conversations = {prepareCommittedQuestionTurn(input:ScienceQuestionPreparationInput):Prepared;
  admitPreparedQuestionDispatch(turnId:string,invocationRunId:string):void};
const fail = (code:string):never => {throw Object.assign(new Error(code),{code});};
const stable = (value:unknown):string => JSON.stringify(value,(_key,item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
const sha = (value:string):string => createHash("sha256").update(value,"utf8").digest("hex");
const isId = (value:unknown):value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
function exactScope(input:Scope) {
  if(!input || !isId(input.projectId) || !isId(input.conversationId)) return fail("science-question-scope-invalid");
  const store=scienceStore() as Store;
  const binding=store.getConversationRuntimeBinding(input.projectId,input.conversationId);
  const reverse=binding && store.getConversationScopeForRuntimeChat(binding.runtimeChatId);
  const registered=binding && workingSessionScope(getDb(),binding.runtimeChatId);
  const chat=binding && getChat(binding.runtimeChatId);
  if(!binding || !reverse || reverse.projectId!==input.projectId || reverse.conversationId!==input.conversationId
    || !registered || registered.projectId!==input.projectId || !chat || chat.archivedAt!==null || !chat.agentId) return fail("science-question-scope-invalid");
  return {store,binding,registered,chat};
}
function sourceFor(scope:ReturnType<typeof exactScope>,view:QuestionDecisionView,allowLegacyRead=false) {
  const source=scope.store.getTurnByInvocationRunId(view.sourceRunId);
  if(!source || source.projectId!==scope.binding.projectId || source.conversationId!==scope.binding.conversationId
    || source.runtimeChatId!==view.chatId || source.runtimeChatId!==scope.binding.runtimeChatId) return fail("science-question-source-mismatch");
  const reference=scope.store.canonicalDecisionSourceReference(source.projectId,source.conversationId,source.id);
  if(!reference || reference.sourceMessageId!==view.sourceMessageId) return fail("science-question-source-mismatch");
  // The SDK validates its normalized assistant text independently. The shared
  // journal owns the raw bytes; never compare these different representations.
  if(reference.sourceRawContentSha256===undefined) {
    if(!allowLegacyRead) return fail("science-question-source-raw-reference-missing");
  } else if(reference.sourceRawContentSha256!==view.sourceMessageSha256) return fail("science-question-source-mismatch");
  const actual=getDb().prepare(`SELECT DISTINCT agent_id FROM run_events WHERE chat_id=? AND run_id=? AND kind='mcp_final'
    AND json_valid(payload_json) AND json_extract(payload_json,'$.durableMessageId')=? LIMIT 2`)
    .all(view.chatId,view.sourceRunId,view.sourceMessageId) as Array<{agent_id:string|null}>;
  if(actual.length!==1 || actual[0].agent_id!==scope.chat.agentId) return fail("science-question-actor-mismatch");
  return source;
}
function sourceIdentityFence(scope:ReturnType<typeof exactScope>,view:QuestionDecisionView,sourceTurnId:string) {
  return {ownerSha256:agentContextOwnerBinding().ownerScope,
    scopeSha256:sha(stable({projectId:scope.binding.projectId,conversationId:scope.binding.conversationId,
      runtimeChatId:scope.binding.runtimeChatId,agentId:scope.chat.agentId,registered:scope.registered,
      sourceTurnId,sourceRunId:view.sourceRunId,sourceMessageId:view.sourceMessageId,sourceMessageSha256:view.sourceMessageSha256}))};
}
function currentFence(scope:ReturnType<typeof exactScope>,view:QuestionDecisionView,sourceTurnId:string) {
  if(typeof scope.store.canonicalDecisionControlFence!=="function") return fail("science-question-host-unavailable");
  const control=scope.store.canonicalDecisionControlFence(scope.binding.projectId,scope.binding.conversationId);
  return {control,fence:{...sourceIdentityFence(scope,view,sourceTurnId),controlSha256:sha(stable(control))}};
}
let installed:ReturnType<typeof createScienceQuestionHost>|null=null;

/** Shared native/Mobile adapters use this exact registered range resolver, never titles or model fields. */
export function resolveScienceQuestionScopeForRuntimeChat(chatId:string):Scope|null {
  const scope=scienceStore().getConversationScopeForRuntimeChat(chatId);
  if(!scope) return null;
  try { return exactScope(scope).binding.runtimeChatId===chatId ? scope : null; } catch {return null;}
}

/** One thin domain adapter. Main and daemon install it with their actual owner fence. */
export function createScienceQuestionHost(assertExecution:()=>void=()=>{}) {
  const ownerAnswers=new WeakMap<object,{requestId:string}>();
  const preparations=new WeakMap<object,{scope:Scope;view:QuestionDecisionView;fence:QuestionContinuationHostFence}>();
  const read=(input:Scope & {sourceTurnId?:string;sourceMessageId?:string}):QuestionDecisionView|null => {
    const scope=exactScope(input);
    let sourceMessageId:string|undefined=input.sourceMessageId;
    if(input.sourceTurnId) {
      const turn=scope.store.getTurnForProject(input.projectId,input.sourceTurnId);
      if(!turn || turn.conversationId!==input.conversationId || turn.runtimeChatId!==scope.binding.runtimeChatId) return null;
      const reference=scope.store.canonicalDecisionSourceReference(input.projectId,input.conversationId,turn.id);
      if(!reference || (sourceMessageId && sourceMessageId!==reference.sourceMessageId)) return null;
      sourceMessageId=reference.sourceMessageId;
    }
    const view=readQuestionDecision(scope.binding.runtimeChatId,sourceMessageId);
    if(!view) return null;
    if(!committedQuestionContinuationIsCurrent(view.chatId,view.sourceMessageId)
      && !(view.committed && getInvocationRunReceipt(view.committed.continuationRunId))) return null;
    const source=sourceFor(scope,view,true),held=readCommittedQuestionHostFence(view.chatId,view.sourceMessageId);
    const current=sourceIdentityFence(scope,view,source.id);
    if(held && (held.ownerSha256!==current.ownerSha256 || held.scopeSha256!==current.scopeSha256)) return null;
    const reference=scope.store.canonicalDecisionSourceReference(source.projectId,source.conversationId,source.id);
    if(!reference?.sourceRawContentSha256) return {...view,readOnlyReason:"legacy-source-reference"};
    if(view.committed && !held) return {...view,readOnlyReason:"legacy-control-fence"};
    if(typeof scope.store.canonicalDecisionControlFence!=="function") return {...view,readOnlyReason:"host-unavailable"};
    const control=scope.store.canonicalDecisionControlFence(input.projectId,input.conversationId);
    if(control.stopped || !control.budget || control.budget.status!=="active") return {...view,readOnlyReason:"control-changed"};
    return view;
  };
  const assertPreparation=(raw:unknown) => {
    const held=raw && typeof raw === "object" ? preparations.get(raw) : undefined;
    if(!held) return fail("science-question-preparation-required");
    // Only this host's frozen, privately minted object can reach this assertion.
    const input=raw as ScienceQuestionPreparationInput;
    assertExecution();
    const scope=exactScope(held.scope);
    const current=readQuestionDecision(scope.binding.runtimeChatId,input.sourceMessageId);
    if(!current || current.sourceRunId!==held.view.sourceRunId || current.sourceMessageSha256!==held.view.sourceMessageSha256
      || current.questionBankSha256!==held.view.questionBankSha256) return fail("science-question-source-mismatch");
    if(!committedQuestionContinuationIsCurrent(current.chatId,current.sourceMessageId)) return fail("science-question-superseded");
    const source=sourceFor(scope,current);
    const now=currentFence(scope,current,source.id);
    const intent=getCommittedQuestionContinuation(current.chatId,current.sourceMessageId,input.reply);
    if(!intent || intent.runId!==input.invocationRunId || intent.requestHash!==input.requestHash
      || input.projectId!==held.scope.projectId || input.conversationId!==held.scope.conversationId
      || input.sourceTurnId!==source.id || input.sourceRunId!==current.sourceRunId
      || input.sourceMessageSha256!==current.sourceMessageSha256
      || stable(input.expectedControlFence)!==stable(now.control)
      || !questionContinuationHostFenceMatches(now.fence,held.fence)
      || !questionContinuationHostFenceMatches(readCommittedQuestionHostFence(current.chatId,current.sourceMessageId),held.fence)) return fail("science-question-control-changed");
    return {replyMaxChars:QUESTION_CONTINUATION_REPLY_MAX_LENGTH,replyMaxBytes:QUESTION_CONTINUATION_REPLY_MAX_BYTES};
  };
  const answer=async(input:Scope & {sourceMessageId:string;reply:string;retryCommitted?:true;locale?:"ko"|"en"}):Promise<QuestionContinuationReceipt> => {
    assertExecution();
    const ownerIntent=input && typeof input === "object" ? ownerAnswers.get(input) : undefined;
    if(!ownerIntent) return fail("science-question-owner-intent-required");
    if(!input || !isId(input.sourceMessageId) || typeof input.reply!=="string"
      || (input.retryCommitted!==undefined && input.retryCommitted!==true)) return fail("science-question-answer-invalid");
    const scope=exactScope(input),view=readQuestionDecision(scope.binding.runtimeChatId,input.sourceMessageId);
    if(!view) return fail("science-question-not-pending");
    const source=sourceFor(scope,view);
    const reply=input.retryCommitted ? view.committed?.reply : input.reply.trim();
    if(!reply || (view.committed && view.committed.reply!==reply)) return fail("science-question-answer-conflict");
    const held=readCommittedQuestionHostFence(view.chatId,view.sourceMessageId),identity=sourceIdentityFence(scope,view,source.id);
    if(view.committed && (!held || held.ownerSha256!==identity.ownerSha256 || held.scopeSha256!==identity.scopeSha256))
      return fail("science-question-committed-read-only");
    const prior=getCommittedQuestionContinuation(view.chatId,view.sourceMessageId,reply);
    // Genuine accepted receipt recovery is read-only, including after Stop/account-safe owner navigation.
    if(prior && getInvocationRunReceipt(prior.runId)) return invocationService.continueCommittedQuestion(view.chatId,view.sourceMessageId,reply);
    if(!committedQuestionContinuationIsCurrent(view.chatId,view.sourceMessageId)) return fail("science-question-superseded");
    const service=scienceConversationService() as unknown as Conversations;
    if(typeof service.prepareCommittedQuestionTurn!=="function" || typeof service.admitPreparedQuestionDispatch!=="function") return fail("science-question-host-unavailable");
    const now=currentFence(scope,view,source.id);
    if(now.control.stopped || (now.control.budget && now.control.budget.status!=="active")) return fail("science-question-control-changed");
    const observed=observeQuestionHostOwnerIntent({chatId:view.chatId,sourceMessageId:view.sourceMessageId,reply,
      requestId:ownerIntent.requestId,fence:now.fence});
    if(view.committed && !questionContinuationHostFenceMatches(readCommittedQuestionHostFence(view.chatId,view.sourceMessageId),now.fence)) {
      reconfirmCommittedQuestionHostFence(observed);
    }
    const sourceReceipt=getInvocationRunReceipt(view.sourceRunId);
    if(!sourceReceipt || sourceReceipt.chatId!==view.chatId || !sourceReceipt.executionPermission) return fail("science-question-source-mismatch");
    const selection=scope.store.executionRevision(input.projectId,input.conversationId).runtimeSelection ?? source.runtimeSelection;
    if(!selection) return fail("science-question-runtime-unavailable");
    const runtimeSelection=normalizeRuntimeSelectionInput(selection,{allowInherit:false});
    commitPendingConfirmationAnswer(view.chatId,reply,view.sourceMessageId,{locale:input.locale ?? currentUiLocale(),permissions:sourceReceipt.executionPermission,
      runtimeSelection,sessionRouting:false},now.fence);
    const intent=getCommittedQuestionContinuation(view.chatId,view.sourceMessageId,reply);
    if(!intent) return fail("science-question-commit-missing");
    const preparation:ScienceQuestionPreparationInput={projectId:input.projectId,conversationId:input.conversationId,
      sourceTurnId:source.id,sourceRunId:view.sourceRunId,sourceMessageId:view.sourceMessageId,sourceMessageSha256:view.sourceMessageSha256,
      invocationRunId:intent.runId,reply,requestHash:intent.requestHash,expectedControlFence:structuredClone(now.control),
      runtimeSelection:intent.request.runtimeSelection ?? null,permissions:intent.request.permissions ?? sourceReceipt.executionPermission,
      locale:intent.request.locale};
    const freeze=(item:unknown):void=>{if(item&&typeof item==="object"){for(const value of Object.values(item))freeze(value);Object.freeze(item);}};
    freeze(preparation);
    preparations.set(preparation,{scope:{projectId:input.projectId,conversationId:input.conversationId},view,fence:now.fence});
    const prepared=service.prepareCommittedQuestionTurn(preparation);
    const token=sealPreparedHostQuestionContinuation({chatId:view.chatId,sourceMessageId:view.sourceMessageId,reply,
      request:prepared.request,workspaceBinding:prepared.workspaceBinding,executionContext:prepared.executionContext,fence:now.fence,
      assertCurrent:()=>{assertPreparation(preparation);},
      beforeSourceStart:()=>{assertPreparation(preparation);service.admitPreparedQuestionDispatch(prepared.turn.id,prepared.turn.invocationRunId);}});
    return invocationService.continueCommittedQuestion(view.chatId,view.sourceMessageId,reply,undefined,token);
  };
  const port={read,answer,assertPreparation,projectText:projectQuestionDecisionText,composeReply:composeQuestionReply};
  const host={...port,port,answerFromOwner(input:Parameters<typeof answer>[0],intent:{requestId:string}) {
    if(!intent || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.requestId)) return fail("science-question-owner-intent-invalid");
    const owned={...input}; ownerAnswers.set(owned,{requestId:intent.requestId});
    return answer(owned);
  }};
  installed=host;
  return host;
}

/** Resolve the installed execution host; never construct a second SDK runtime for Mobile. */
export function scienceQuestionHost() {
  if(!installed) return fail("science-question-host-unavailable");
  return installed;
}
