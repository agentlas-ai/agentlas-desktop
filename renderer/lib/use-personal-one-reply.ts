"use client";
import { useEffect, useState } from "react";
import { ipc, ipcEvents } from "./ipc";
import { subscribeOrderedRunEvents } from "./ordered-run-events";
import { createFrameBatcher } from "./frame-coalescer";
import { createLiveReplyFeed, type LiveReplyState } from "./personal-one-live-reply";

/** Reuse Main's ordered delivery journal; route/run changes discard the old subscriber. Streamed text commits once per frame (personal-one-live-reply.ts). */
export function usePersonalOneReply(chatId:string|undefined,runId:string|undefined,refresh:()=>Promise<void>) {
  const [live,setLive]=useState<LiveReplyState|null>(null);
  useEffect(()=>{
    setLive(null);
    const api=ipc(),events=ipcEvents();
    if(!chatId || !runId || !api?.invoke?.replay || !events?.on) return;
    const batcher=createFrameBatcher({minIntervalMs:50});
    const feed=createLiveReplyFeed({runId,refresh,emit:setLive,batcher});
    const off=subscribeOrderedRunEvents({runId,chatId,
      listen:listener=>events.on(api.invoke.eventChannel(runId),listener),replay:input=>api.invoke.replay(input),
      consume:feed.consume,
      recover:async(value,checkpoint)=>{
        await refresh();if(!checkpoint.isCurrent())return false;
        feed.recover(value);return true;
      },
    });
    return ()=>{off();batcher.cancel();};
  },[chatId,runId,refresh]);
  return live?.runId===runId ? live : null;
}
