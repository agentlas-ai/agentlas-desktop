"use client";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkStartAPI, WorkStartInput, WorkStartOptions } from '@shared/work-start';
import { useT } from '@/lib/i18n';
import { ipc } from '@/lib/ipc';

export function workStartBridge(): WorkStartAPI | null { return (ipc() as ReturnType<typeof ipc> & { workStart?: WorkStartAPI })?.workStart ?? null; }
const STORAGE='agentlas.work-start.pending.v1';
export function persistWorkStart(input: Omit<WorkStartInput,'intentId'>): WorkStartInput {
  const body=JSON.stringify(input);let prior:WorkStartInput|null=null;
  try { prior=JSON.parse(window.localStorage.getItem(STORAGE)??'null'); } catch { /* invalid abandoned draft */ }
  if(prior){const {intentId,...rest}=prior;if(JSON.stringify(rest)===body)return prior;}
  const result={intentId:crypto.randomUUID(),...input};const serialized=JSON.stringify(result);window.localStorage.setItem(STORAGE,serialized);
  if(window.localStorage.getItem(STORAGE)!==serialized)throw new Error('work_start_draft_not_saved');return result;
}
export function pendingWorkStart(): WorkStartInput | null { try { const item=JSON.parse(window.localStorage.getItem(STORAGE)??'null');return item&&typeof item.intentId==='string'&&typeof item.prompt==='string'?item:null; }catch{return null;} }
export function clearWorkStart(intentId:string):void { const pending=pendingWorkStart();if(pending?.intentId===intentId)window.localStorage.removeItem(STORAGE); }

export type WorkStartRecoveryTarget = { intentId:string; chatId:string };
type WorkStartRecoveryState = WorkStartRecoveryTarget & (
  | { phase:'loading' }
  | { phase:'unavailable' }
  | { phase:'ready'; prompt:string; hasAttachments:boolean }
);

/** Read only the exact saved Work start; never claim, send, or change a draft here. */
export function useWorkStartRecovery(target:WorkStartRecoveryTarget|null): {
  state:WorkStartRecoveryState|null; retry:()=>void;
} {
  const [state,setState]=useState<WorkStartRecoveryState|null>(null);
  const [attempt,setAttempt]=useState(0);
  const intentId=target?.intentId,chatId=target?.chatId;
  useEffect(()=>{
    if(!intentId||!chatId)return;
    let active=true;
    setState({intentId,chatId,phase:'loading'});
    void Promise.resolve().then(()=>{
      if(!active)return null;
      const bridge=workStartBridge();
      return bridge ? bridge.get({intentId,chatId}) : null;
    }).then(saved=>{
      if(!active)return;
      if(!saved||saved.intentId!==intentId||saved.chatId!==chatId||typeof saved.prompt!=='string'){
        setState({intentId,chatId,phase:'unavailable'});return;
      }
      const options=saved.options;
      const hasAttachments=Boolean((Array.isArray(options?.images)&&options.images.length)||(Array.isArray(options?.files)&&options.files.length));
      setState({intentId,chatId,phase:'ready',prompt:saved.prompt,hasAttachments});
    }).catch(()=>{if(active)setState({intentId,chatId,phase:'unavailable'});});
    return()=>{active=false;};
  },[intentId,chatId,attempt]);
  const visible=state&&state.intentId===intentId&&state.chatId===chatId?state:null;
  return {state:visible,retry:()=>setAttempt(value=>value+1)};
}

/** Main claims the exact durable intent once. Recovery is read-only and does not repeat a possibly dispatched start. */
export function useWorkStartHandoff({intentId,chatId,ready,send,prefill,notice,recover}:{intentId:string|null;chatId:string;ready:boolean;send:(text:string,options?:WorkStartOptions)=>Promise<boolean>;prefill:(text:string)=>void;notice:(message:string)=>void;recover:(target:WorkStartRecoveryTarget|null)=>void}):void {
  const {locale}=useT();
  const handled=useRef(new Map<string,{epoch:number;settled:boolean}>());
  const view=useRef({intentId,chatId,epoch:0});
  const mounted=useRef(false),current=useRef({intentId,chatId,send,prefill,notice,recover});
  useLayoutEffect(()=>{
    if(view.current.intentId!==intentId||view.current.chatId!==chatId)view.current={intentId,chatId,epoch:view.current.epoch+1};
    current.current={intentId,chatId,send,prefill,notice,recover};
  });
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(!intentId||!chatId||!ready)return;
    const epoch=view.current.epoch,key=JSON.stringify([intentId,chatId]);
    const isCurrent=()=>mounted.current&&current.current.intentId===intentId&&current.current.chatId===chatId&&view.current.epoch===epoch;
    const prior=handled.current.get(key);
    if(prior){
      // A view left and returned while a claim was in flight: inspect the receipt, never claim again.
      if(prior.epoch!==epoch&&!prior.settled){current.current.recover({intentId,chatId});current.current.notice(locale==='ko'?'이전 시작의 실행 여부를 확인한 뒤 원문을 사용해 주세요.':'Check whether the previous start ran before using its original text.');}
      return;
    }
    const bridge=workStartBridge();if(!bridge)return;
    const handling={epoch,settled:false};handled.current.set(key,handling);
    const showRecovery=()=>{if(isCurrent())current.current.recover({intentId,chatId});};
    void (async()=>{
      // A claim that Main refused took nothing: it is atomic, so asking once more is safe and nothing was sent yet.
      let result:Awaited<ReturnType<WorkStartAPI['claim']>>|undefined;
      for(let attempt=0;attempt<2&&!result;attempt+=1){
        try {result=await bridge.claim({intentId,chatId});}
        catch {if(attempt===0)await new Promise(resolve=>setTimeout(resolve,400));}
        if(!isCurrent())return;
      }
      if(!result){
        // Still refused, so the start never ran: the owner's text goes back to the composer, exactly as before.
        if(isCurrent()){const pending=pendingWorkStart();if(pending?.intentId===intentId)current.current.prefill(pending.prompt);current.current.notice(locale==='ko'?'작업이 시작되지 않아 입력을 작성창에 되돌려 두었습니다.':'Work did not start; your input is back in the composer.');}
        return;
      }
      if(!result?.receipt||result.receipt.intentId!==intentId||result.receipt.chatId!==chatId||typeof result.receipt.prompt!=='string'){
        showRecovery();current.current.notice(locale==='ko'?'시작 요청을 확인하지 못했습니다. 원문과 대화를 확인해 주세요.':'The start request could not be confirmed. Review the original text and conversation.');return;
      }
      if(!result.claimToken){
        if(result.receipt.status!=='accepted'){current.current.prefill(result.receipt.prompt);showRecovery();current.current.notice(locale==='ko'?'이전 시작의 실행 여부를 확인한 뒤 원문을 사용해 주세요.':'Check whether the previous start ran before using its original text.');}
        else handling.settled=true;
        return;
      }
      let accepted:boolean;
      try {accepted=await current.current.send(result.receipt.prompt,result.receipt.options);}
      catch {if(isCurrent()){showRecovery();current.current.notice(locale==='ko'?'전송 결과를 확인하지 못했습니다. 원문과 대화를 확인해 주세요.':'The send result could not be confirmed. Review the original text and conversation.');}return;}
      // Settling only records an outcome the send already decided; it is idempotent for this claim, so a lost reply is
      // asked again once. Whether the record could be written never changes what the owner sees: an admitted start is
      // running and a refused one is back in the composer (the send reports its own reason).
      for(let attempt=0;attempt<2;attempt+=1){
        try {await bridge.settle({intentId,chatId,claimToken:result.claimToken,accepted});break;}
        catch {if(attempt===0)await new Promise(resolve=>setTimeout(resolve,300));}
      }
      if(accepted){handling.settled=true;if(isCurrent())current.current.recover(null);try{clearWorkStart(intentId);}catch{/* the accepted start is not undone by draft cleanup */}}
      else if(isCurrent())current.current.prefill(result.receipt.prompt);
    })();
  },[intentId,chatId,ready]);
}
