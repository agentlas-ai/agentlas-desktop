"use client";
import { useEffect, useRef } from 'react';
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

/** Main claims the exact durable intent once. An interrupted handoff restores a draft rather than silently running twice. */
export function useWorkStartHandoff({intentId,chatId,ready,send,prefill,notice}:{intentId:string|null;chatId:string;ready:boolean;send:(text:string,options?:WorkStartOptions)=>Promise<boolean>;prefill:(text:string)=>void;notice:(message:string)=>void}):void {
  const {locale}=useT();
  const handled=useRef(new Set<string>());
  const mounted=useRef(false),current=useRef({intentId,chatId,send,prefill,notice});
  current.current={intentId,chatId,send,prefill,notice};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(!intentId||!chatId||!ready||handled.current.has(intentId))return;
    const bridge=workStartBridge();if(!bridge)return;handled.current.add(intentId);const isCurrent=()=>mounted.current&&current.current.intentId===intentId&&current.current.chatId===chatId;
    void (async()=>{
      const result=await bridge.claim({intentId,chatId});if(!isCurrent())return;
      if(!result.claimToken){if(result.receipt.status!=='accepted'){current.current.prefill(result.receipt.prompt);current.current.notice(locale==='ko'?'이전 시작이 중단됐습니다. 요청은 보존되어 있습니다. 대화를 확인한 뒤 다시 보내 주세요.':'The previous start was interrupted. Your request is preserved; review the conversation before sending again.');}return;}
      const accepted=await current.current.send(result.receipt.prompt,result.receipt.options);
      await bridge.settle({intentId,chatId,claimToken:result.claimToken,accepted});
      if(accepted)clearWorkStart(intentId);else if(isCurrent())current.current.prefill(result.receipt.prompt);
    })().catch((error)=>{if(isCurrent()){const pending=pendingWorkStart();if(pending?.intentId===intentId)current.current.prefill(pending.prompt);current.current.notice(locale==='ko'?'작업을 시작하지 못했습니다. 입력을 보존했습니다. 대화를 확인한 뒤 다시 시도해 주세요.':'Work could not start. Your input is preserved. Review the conversation before trying again.');}});
  },[intentId,chatId,ready]);
}
