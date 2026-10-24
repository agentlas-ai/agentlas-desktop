import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { QuestionDecisionView } from "../../shared/question-decision";
import type { QuestionDecisionAnswer } from "../../shared/question-reply";
import { composeQuestionDecisionReply } from "../../shared/question-reply";
import { askSkipReply } from "../../shared/ask-action-bar";

type Scope={projectId:string;conversationId:string};
export type ScienceQuestionReadInput=Scope & {sourceTurnId?:string;sourceMessageId?:string};
export type ScienceQuestionAnswerInput=Scope & {sourceMessageId:string;reply:string;retryCommitted?:true;locale?:"ko"|"en"};
export interface ScienceQuestionOwnerCapture extends Scope { assertCurrent():void }
const row=(value:unknown):Record<string,unknown>|null=>value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : null;
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The view is a renderer, not a broker. The current signed presentation owns the click. */
export function registerScienceQuestionDecisionIpc(options:{
  ipcMain:Pick<IpcMain,"handle">;
  captureOwner(event:IpcMainInvokeEvent,envelope:unknown):ScienceQuestionOwnerCapture;
  read(input:ScienceQuestionReadInput):Promise<QuestionDecisionView|null>|QuestionDecisionView|null;
  answer(input:ScienceQuestionAnswerInput,requestId:string):Promise<unknown>;
}):void {
  const captured=(event:IpcMainInvokeEvent,envelope:unknown)=>{
    const capture=options.captureOwner(event,envelope),input=row(row(envelope)?.input);
    if(!input || input.projectId!==capture.projectId || input.conversationId!==capture.conversationId) return fail("science-question-view-scope-changed");
    return {capture,input};
  };
  options.ipcMain.handle("science:questionDecisions:read",async(event,envelope)=>{
    const {capture,input}=captured(event,envelope);
    if(Object.keys(input).some(key=>!["projectId","conversationId","sourceTurnId","sourceMessageId"].includes(key))) return fail("science-question-read-invalid");
    const result=await options.read({projectId:capture.projectId,conversationId:capture.conversationId,
      ...(typeof input.sourceTurnId === "string" ? {sourceTurnId:input.sourceTurnId} : {}),
      ...(typeof input.sourceMessageId === "string" ? {sourceMessageId:input.sourceMessageId} : {})});
    capture.assertCurrent();
    return result;
  });
  options.ipcMain.handle("science:questionDecisions:answer",async(event,envelope)=>{
    const {capture,input}=captured(event,envelope);
    if(Object.keys(input).some(key=>!["projectId","conversationId","sourceMessageId","questionBankSha256","answers","ko","retryCommitted","skip","requestId"].includes(key))
      || typeof input.sourceMessageId!=="string" || typeof input.questionBankSha256!=="string" || typeof input.ko!=="boolean"
      || typeof input.requestId!=="string" || !UUID.test(input.requestId) || !Array.isArray(input.answers)
      || (input.skip!==undefined && input.skip!==true) || (input.retryCommitted!==undefined && input.retryCommitted!==true)
      || ((input.skip===true || input.retryCommitted===true) && input.answers.length!==0)
      || (input.skip===true && input.retryCommitted===true)) return fail("science-question-answer-invalid");
    const view=await options.read({projectId:capture.projectId,conversationId:capture.conversationId,sourceMessageId:input.sourceMessageId});
    capture.assertCurrent();
    if(!view || view.sourceMessageId!==input.sourceMessageId || view.questionBankSha256!==input.questionBankSha256) return fail("science-question-bank-changed");
    const reply=input.retryCommitted===true ? view.committed?.reply
      : input.skip===true ? askSkipReply(input.ko ? "ko" : "en",view.questions.map(question=>question.question).join(" / "))
      : composeQuestionDecisionReply(view.questions,input.answers as QuestionDecisionAnswer[],input.ko).reply;
    if(!reply) return fail("science-question-answer-empty");
    // This is the accepted owner-intent boundary. Later navigation affects only
    // UI application, exactly as One/Work; actual Stop/control/account is re-read at start.
    capture.assertCurrent();
    return options.answer({projectId:capture.projectId,conversationId:capture.conversationId,sourceMessageId:view.sourceMessageId,
      reply,locale:input.ko ? "ko" : "en",...(input.retryCommitted===true ? {retryCommitted:true} : {})},input.requestId);
  });
}
