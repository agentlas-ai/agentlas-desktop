'use client';
import {useState} from 'react';
import type {OneProviderNativeAPI} from '@shared/one-provider-native';
import {OneProviderControls} from './OneProviderControls';
/** Parent supplies a native original command and current typed IPC adapter; absence stays unavailable. */
export function OneProviderFeature({commandId,api,onSecuritySetup}:{commandId:string|null;api:OneProviderNativeAPI|null;onSecuritySetup?():Promise<void>}){
 const [open,setOpen]=useState(false);
 return <><button type="button" onClick={()=>setOpen(true)}>제공자 연결·음성</button>{commandId?<OneProviderControls open={open} commandId={commandId} api={api} onClose={()=>setOpen(false)} onSecuritySetup={onSecuritySetup}/>:open?<div role="status">원래 One 요청이 확인되지 않았습니다. <button onClick={()=>setOpen(false)}>닫기</button></div>:null}</>;
}
