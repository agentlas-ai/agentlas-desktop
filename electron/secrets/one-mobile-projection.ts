import {findCanonicalTaskForChat} from '../store/tasks';
import {getChat} from '../store/chats';
import {OneVaultError,type OneVaultRequest} from '../../shared/one-vault';
import {oneVaultDigest} from './one-vault-crypto';
import type {OneVaultRuntime} from './one-vault-runtime';
export interface OneMobileChatProjection {taskId:string|null;taskVersion:number|null}
export interface OneMobileNativeAdmissionProjection {
 hostId:string;chatId:string;commandId:string;taskId:string;runId:string;controlVersion:string|null;
 requestDigest:string;chatProjection:OneMobileChatProjection;
}
export interface OneMobileChatReaders {
 /** Read existing native records only. These are not authority producers. */
 chat(id:string):{id:string}|null;
 canonicalTask(id:string):{id:string;version:number}|null;
}
const nativeReaders:OneMobileChatReaders={chat:getChat,canonicalTask:findCanonicalTaskForChat};
function denied():never{throw new OneVaultError('authority_denied')}
function snapshot(runtime:OneVaultRuntime,request:OneVaultRequest,readers:OneMobileChatReaders):OneMobileNativeAdmissionProjection {
 const b=request.binding,a=runtime.anchor(b.commandId),c=runtime.resolveCommand(b.commandId);
 if(!a||!c||a.commandId!==b.commandId||a.taskId!==b.taskId||a.runId!==b.runId||a.controlVersion!==b.controlVersion)denied();
 // Compare every native context field, not UI ids or a numeric interpretation of control.
 // Generation can advance after the immutable request was consumed; it is not a chat revision.
 for(const k of Object.keys(c.binding) as Array<keyof typeof c.binding>){if(k!=='expectedGeneration'&&oneVaultDigest(c.binding[k])!==oneVaultDigest(b[k]))denied();}
 if(!readers.chat(a.chatId)||readers.chat(a.chatId)?.id!==a.chatId)denied();
 const task=readers.canonicalTask(a.chatId);
 if(task&&(!task.id||!Number.isSafeInteger(task.version)||task.version<1))denied();
 const chatProjection=task?{taskId:task.id,taskVersion:task.version}:{taskId:null,taskVersion:null};
 return{hostId:b.hostId,chatId:a.chatId,commandId:b.commandId,taskId:b.taskId,runId:b.runId,controlVersion:b.controlVersion,requestDigest:oneVaultDigest(request),chatProjection};
}
/** Active original custody only. A relation does not grant access and never becomes an RPC
 * authority DTO. Terminal recovery requires its own original-source native producer. */
export function pinOneMobileNativeProjection(runtime:OneVaultRuntime,request:OneVaultRequest,current:()=>boolean,readers:OneMobileChatReaders=nativeReaders):{value:Readonly<OneMobileNativeAdmissionProjection>;stillCurrent():boolean}{
 if(!current())denied();
 const value=snapshot(runtime,request,readers),digest=oneVaultDigest(value),anchorDigest=oneVaultDigest(runtime.anchor(request.binding.commandId));
 Object.freeze(value.chatProjection);Object.freeze(value);
 const stillCurrent=()=>{try{return current()&&oneVaultDigest(runtime.anchor(request.binding.commandId))===anchorDigest&&oneVaultDigest(snapshot(runtime,request,readers))===digest}catch{return false}};
 if(!stillCurrent())denied();
 return{value,stillCurrent};
}

/** Retained status is tied to the SAME durable operation, not an active execution anchor.
 * Mutable settlement state/generation may advance only as validated by retainedOperation;
 * original request, effect, custody, current source revisions and canonical relation stay pinned. */
export function pinOneMobileRecoveryProjection(runtime:OneVaultRuntime,request:OneVaultRequest,current:()=>boolean,readers:OneMobileChatReaders=nativeReaders):{value:Readonly<OneMobileNativeAdmissionProjection>;stillCurrent():boolean}{
 const snapshot=()=>{
  const r=runtime.retainedOperation(request.binding.commandId);if(!current()||!r||oneVaultDigest(r.evidence.request)!==oneVaultDigest(request))denied();
  const chatId=r.evidence.executionChatId;if(readers.chat(chatId)?.id!==chatId)denied();
  const task=readers.canonicalTask(chatId);if(task&&(!task.id||!Number.isSafeInteger(task.version)||task.version<1))denied();
  const {operationState:_,...evidence}=r.evidence;
  return{value:{hostId:request.binding.hostId,chatId,commandId:request.binding.commandId,taskId:request.binding.taskId,runId:request.binding.runId,controlVersion:request.binding.controlVersion,requestDigest:oneVaultDigest(request),chatProjection:task?{taskId:task.id,taskVersion:task.version}:{taskId:null,taskVersion:null}},identity:{evidence,context:{...r.context,binding:{...r.context.binding,expectedGeneration:request.binding.expectedGeneration}}}};
 };
 const initial=snapshot(),digest=oneVaultDigest(initial),value=initial.value;Object.freeze(value.chatProjection);Object.freeze(value);
 const stillCurrent=()=>{try{return oneVaultDigest(snapshot())===digest}catch{return false}};
 if(!stillCurrent())denied();return{value,stillCurrent};
}
