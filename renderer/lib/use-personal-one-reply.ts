"use client";
import { useEffect, useState } from "react";
import type { SupervisorActivityItem } from "../../shared/one-supervisor";
import type { McpRunKeyRequest } from "../../shared/types";
import { ipc, ipcEvents } from "./ipc";
import { subscribeOrderedRunEvents } from "./ordered-run-events";

/** Reuse Main's ordered delivery journal; route/run changes discard the old subscriber. */
export function usePersonalOneReply(chatId:string|undefined,runId:string|undefined,refresh:()=>Promise<void>) {
  const [live,setLive]=useState<{runId:string;text:string;activity:SupervisorActivityItem[];keyRequest:McpRunKeyRequest|null}|null>(null);
  useEffect(()=>{
    setLive(null);
    const api=ipc(),events=ipcEvents();
    if(!chatId || !runId || !api?.invoke?.replay || !events?.on) return;
    let text='',reasoningKey='reasoning';
    let keyRequest:McpRunKeyRequest|null=null;
    const activity=new Map<string,SupervisorActivityItem>();
    const publish=()=>setLive({runId,text,activity:[...activity.values()].slice(-20),keyRequest});
    return subscribeOrderedRunEvents({runId,chatId,
      listen:listener=>events.on(api.invoke.eventChannel(runId),listener),replay:input=>api.invoke.replay(input),
      consume:event=>{
        if(event.agentId || event.nodeId) return;
        if(event.kind==='partial') {
          if(event.durableMessageId) {text='';void refresh();}
          else if(typeof event.text==='string') text=event.text.slice(0,24_000);
          else if(typeof event.delta==='string') text=(text+event.delta).slice(0,24_000);
        } else if(event.kind==='reasoning') {
          if(event.reasoning?.phase==='start') reasoningKey=`reasoning:${event.sequence ?? 0}`;
          if(event.reasoning?.phase==='start'||event.reasoning?.phase==='end') activity.set(reasoningKey,{id:reasoningKey,kind:'reasoning',label:'Thinking',state:event.reasoning.phase==='end'?'completed':'running',summary:event.reasoning.phase==='end'?event.reasoning.text?.slice(0,2000):undefined,durationMs:event.reasoning.durationMs});
        } else if(event.kind==='tool-use' && event.tool) {
          const key=`tool:${event.tool.id ?? event.sequence}`;
          activity.set(key,{id:key,kind:'tool',label:event.tool.name.slice(0,240),state:event.tool.isError?'failed':event.tool.result!==undefined?'completed':'running'});
        } else if(event.kind==='mcp-key-request' && event.keyRequest?.runId===runId
          && event.keyRequest.requestId===runId && event.keyRequest.expiresAt>Date.now()) {
          keyRequest=event.keyRequest;
        } else if(event.kind==='final' || event.kind==='error') {text='';keyRequest=null;void refresh();}
        publish();
      },
      recover:async(value,checkpoint)=>{
        await refresh();if(!checkpoint.isCurrent())return false;
        text=value.partialText?.slice(0,24_000) ?? '';publish();return true;
      },
    });
  },[chatId,runId,refresh]);
  return live?.runId===runId ? live : null;
}
