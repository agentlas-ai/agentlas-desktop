import { Buffer } from "node:buffer";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { findCanonicalTaskForChat, getCanonicalTask } from "../store/tasks";
import { readQuestionDecision, commitPendingConfirmationAnswer } from "../confirm";
import { invocationService } from "../invocation/service";
import { getInvocationRunReceipt } from "../store/run-events";
import { normalizeOneDecision } from "../../shared/one-decision";
import { ownerAnswerExecutionPermission } from "../../shared/invocation-permission";
import { composeQuestionDecisionReply } from "../../shared/question-reply";
import type { QuestionDecisionView } from "../../shared/question-decision";
import type { PendingConfirmation, QuestionContinuationReceipt } from "../../shared/types";
import { QUESTION_CONTINUATION_REPLY_MAX_BYTES, QUESTION_CONTINUATION_REPLY_MAX_LENGTH } from "../../shared/types";
import { isMobileCanonicalQuestionDecision, validateMobileCanonicalQuestionAnswer,
  MOBILE_CANONICAL_QUESTION_BANK_BYTES, MOBILE_CANONICAL_QUESTION_CONTRACT,
  type MobileCanonicalQuestionAnswerParams, type MobileCanonicalQuestionDecisionDto } from "../../shared/mobile-question-decision";
import { resolveScienceQuestionScopeForRuntimeChat, scienceQuestionHost } from "../science-host/question-continuation";
import { sendMobileScienceQuestionCommand } from "./science-chat";
import { sanitizeMobileBridgeText } from "./sanitize";

type Scope={projectId:string;conversationId:string};
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};

function current(chatId:string,sourceMessageId?:string) {
  const chat=getChat(chatId),task=findCanonicalTaskForChat(chatId);
  if(!chat || chat.archivedAt!==null || !task || task.archivedAt!==null || task.status!=="waiting-decision"
    || !task.originChatId || findCanonicalTaskForChat(task.originChatId)?.id!==task.id
    || getCanonicalTask(task.id)?.version!==task.version) return null;
  let science:Scope|null=null;
  try { science=resolveScienceQuestionScopeForRuntimeChat(chatId); } catch { /* Old/no SDK host has no registered Science ranges. */ }
  // An unregistered internal conversation never inherits generic navigation authority.
  if(chat.kind!=="user" && !science) return null;
  const question=science ? scienceQuestionHost().read({...science,...(sourceMessageId?{sourceMessageId}:{})})
    : readQuestionDecision(chatId,sourceMessageId);
  if(!question || question.chatId!==chatId || (sourceMessageId && question.sourceMessageId!==sourceMessageId)) return null;
  return {chat,task,question,science};
}
function textSafe(question:QuestionDecisionView):boolean {
  const texts=question.questions.flatMap(q=>[q.question,q.header??"",...q.options.flatMap(o=>[o.label,o.description??""])]);
  if(question.committed)texts.push(question.committed.reply);
  return texts.every(value=>sanitizeMobileBridgeText(value,QUESTION_CONTINUATION_REPLY_MAX_BYTES)===value);
}

/** Bounded opt-in bank; ordinary legacy listPendingConfirmations remains unchanged. */
export function projectMobileCanonicalQuestionDecisions(hostId:string,pending:readonly PendingConfirmation[]):MobileCanonicalQuestionDecisionDto[] {
  const candidates=new Set(pending.slice(0,20).map(value=>value.chatId));
  // Hidden registered working ranges have Tasks but are deliberately absent from
  // navigation and the global recent-user-chat list. This query grants nothing.
  const hidden=getDb().prepare(`SELECT origin_chat_id FROM tasks WHERE status='waiting-decision'
    AND archived_at IS NULL AND origin_chat_id IS NOT NULL ORDER BY updated_at DESC LIMIT 20`).all() as Array<{origin_chat_id:string}>;
  for(const row of hidden) {
    try { if(resolveScienceQuestionScopeForRuntimeChat(row.origin_chat_id))candidates.add(row.origin_chat_id); } catch { /* No old-SDK registered scope. */ }
  }
  const output:MobileCanonicalQuestionDecisionDto[]=[];let used=2;
  for(const chatId of candidates) {
    if(output.length===20)break;
    try {
      const state=current(chatId);if(!state || !state.question.awaitingOwner || !textSafe(state.question))continue;
      const {question,chat,task,science}=state,q=question.questions[0];
      const confirmation:PendingConfirmation={chatId,sourceMessageId:question.sourceMessageId,sourceRunId:question.sourceRunId,
        chatTitle:chat.title,question:q.question,...(q.header?{header:q.header}:{}),optionCount:q.options.length,
        options:q.options,multiSelect:q.multiSelect,agentId:chat.agentId??"",firmId:chat.firmId,
        requesterLabel:chat.title,requesterKind:chat.firmId?"firm":"agent",createdAt:question.createdAt};
      const row:MobileCanonicalQuestionDecisionDto={schemaVersion:1,decision:{authoritativeHostRef:hostId,
        canonicalTaskVersion:task.version,view:normalizeOneDecision(confirmation,task.id)},question,
        ...(science?{workingScope:{kind:"science",...science}}:{})};
      const size=Buffer.byteLength(JSON.stringify(row),"utf8")+1;
      if(!isMobileCanonicalQuestionDecision(row) || used+size>MOBILE_CANONICAL_QUESTION_BANK_BYTES)continue;
      output.push(row);used+=size;
    } catch { /* One unavailable range cannot forge or truncate another bank. */ }
  }
  return output;
}

export interface MobileCanonicalQuestionReceipt {
  schemaVersion:1;contractVersion:typeof MOBILE_CANONICAL_QUESTION_CONTRACT;
  sourceMessageId:string;questionBankSha256:string;taskId:string;taskVersion:number;
  receipt:QuestionContinuationReceipt;
}
/** Authenticated generic Decision branch. Source runtime/context never come from Mobile. */
export async function answerMobileCanonicalQuestion(params:MobileCanonicalQuestionAnswerParams,input:{
  idempotencyKey?:string;assertAccount():void;
}):Promise<MobileCanonicalQuestionReceipt> {
  const invalid=validateMobileCanonicalQuestionAnswer(params);if(invalid)return fail(invalid);
  if(input.idempotencyKey!==params.requestId)return fail("canonical_question_idempotency_invalid");
  const capture=()=>{
    input.assertAccount();
    const state=current(params.chatId,params.expectedQuestionMessageId);
    if(!state || state.task.id!==params.expectedTaskId || state.task.version!==params.expectedTaskVersion
      || state.question.questionBankSha256!==params.expectedQuestionBankSha256)return fail("canonical_question_binding_stale");
    return state;
  };
  const state=capture(),q=state.question;
  const reply=params.retryCommitted ? q.committed?.reply
    : composeQuestionDecisionReply(q.questions,params.questionAnswers??[],params.locale==="ko").reply;
  if(!reply || !reply.trim() || reply.length>QUESTION_CONTINUATION_REPLY_MAX_LENGTH
    || Buffer.byteLength(reply,"utf8")>QUESTION_CONTINUATION_REPLY_MAX_BYTES)return fail("canonical_question_reply_invalid");
  if(q.committed && q.committed.reply!==reply)return fail("canonical_question_answer_conflict");
  let receipt:QuestionContinuationReceipt;
  if(state.science) {
    const scope:Scope=state.science;
    // The daemon is the SDK execution owner. Main never prepares or dispatches
    // a domain continuation through the generic bare InvocationService path.
    receipt=await sendMobileScienceQuestionCommand({op:"questionDecisions.answer",input:{...scope,
      sourceMessageId:q.sourceMessageId,reply,locale:params.locale,...(params.retryCommitted?{retryCommitted:true}:{})},
      nativeOwnerIntent:true,ownerRequestId:params.requestId},input.assertAccount) as QuestionContinuationReceipt;
  } else {
    const source=getInvocationRunReceipt(q.sourceRunId);
    if(!source || source.chatId!==q.chatId || !source.executionPermission)return fail("canonical_question_source_invalid");
    capture();
    // The phone's tap is the owner's input: a question from a host-written turn (a read-only teammate report) does not
    // hold the answer to that turn's authority; the owner's own last turn does (shared/invocation-permission.ts).
    const permissions=ownerAnswerExecutionPermission(source,source.ownerAuthored===false?invocationService.latestOwnerReceipt(q.chatId):null);
    commitPendingConfirmationAnswer(q.chatId,reply,q.sourceMessageId,{locale:params.locale,permissions});
    receipt=await invocationService.continueCommittedQuestion(q.chatId,q.sourceMessageId,reply);
  }
  input.assertAccount();
  if(!receipt || receipt.chatId!==q.chatId || receipt.sourceMessageId!==q.sourceMessageId
    || typeof receipt.runId!=="string" || !["started","already-running","already-terminal","rejected"].includes(receipt.status))return fail("canonical_question_receipt_invalid");
  return {schemaVersion:1,contractVersion:MOBILE_CANONICAL_QUESTION_CONTRACT,sourceMessageId:q.sourceMessageId,
    questionBankSha256:q.questionBankSha256,taskId:state.task.id,taskVersion:state.task.version,receipt};
}
