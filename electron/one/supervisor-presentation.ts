import type Database from "better-sqlite3";
import type { McpInvocationEvent } from "../../shared/types";
import type { SupervisorActivityItem, SupervisorReplyTurn } from "../../shared/one-supervisor";
import type { SupervisorRequestRow } from "./supervisor-store";

/** A time-nearby assistant row or a worker final is not this root run's answer. */
export function supervisorExactResult(db:Database.Database,chatId:string,runId:string|null):{id:string;text:string}|null {
  if (!runId || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='run_events'").get()) return null;
  return db.prepare(`SELECT m.id,m.text FROM run_events e JOIN chat_messages m
    ON m.id=json_extract(e.payload_json,'$.durableMessageId') AND m.chat_id=e.chat_id AND m.role='assistant'
    WHERE e.run_id=? AND e.chat_id=? AND e.kind='mcp_final' AND e.node_id IS NULL
      AND json_valid(e.payload_json) AND json_extract(e.payload_json,'$.agentNodeId') IS NULL
    ORDER BY e.seq DESC LIMIT 1`).get(runId,chatId) as {id:string;text:string}|undefined ?? null;
}

export function supervisorReplyTurns(db:Database.Database,chatId:string,requests:SupervisorRequestRow[],live?:{runId:string;events:McpInvocationEvent[]} | null):SupervisorReplyTurn[] {
  const hasEvents=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='run_events'").get();
  return requests.filter(row=>row.kind==='reply' && row.run_id && row.user_message_id).reverse().map(row=>{
    const activity=new Map<string,SupervisorActivityItem>();
    const add=(id:string,kind:SupervisorActivityItem['kind'],label:unknown,state:SupervisorActivityItem['state'],summary?:unknown,duration?:unknown)=>{
      if (typeof label !== 'string' || !label.trim()) return;
      activity.set(id,{id,kind,label:label.slice(0,240),state,
        ...(typeof summary === 'string' && summary.trim() ? {summary:summary.slice(0,2000)} : {}),
        ...(typeof duration === 'number' && Number.isFinite(duration) && duration>=0 ? {durationMs:duration} : {})});
    };
    if (hasEvents) {
      const events=db.prepare(`SELECT seq,kind,payload_json FROM run_events WHERE run_id=? AND chat_id=?
        AND node_id IS NULL AND kind IN ('mcp_reasoning','mcp_tool-use','mcp_thinking','mcp_lifecycle')
        ORDER BY seq DESC LIMIT 60`).all(row.run_id,chatId) as Array<{seq:number;kind:string;payload_json:string}>;
      let reasoningSpan='reasoning';
      for (const event of events.reverse()) {
        let payload:Record<string,unknown>;try {payload=JSON.parse(event.payload_json);} catch {continue;}
        if (payload.agentNodeId) continue;
        if (event.kind==='mcp_reasoning') {
          if(payload.reasoningPhase!=='start' && payload.reasoningPhase!=='end')continue;
          if (payload.reasoningPhase==='start') reasoningSpan=`reasoning:${event.seq}`;
          add(reasoningSpan,'reasoning','Thinking',payload.reasoningPhase==='end'?'completed':'running',payload.reasoningPhase==='end'?payload.reasoningText:undefined,payload.reasoningDurationMs);
        } else if (event.kind==='mcp_tool-use') {
          add(`tool:${payload.toolId ?? event.seq}`,'tool',payload.toolName,payload.toolIsError===true?'failed':payload.toolCompleted===true?'completed':'running');
        }
      }
    }
    if (!hasEvents && live?.runId === row.run_id) {
      let reasoningSpan='live:reasoning';
      for (const event of live.events.slice(-80)) {
        if (event.agentId || event.nodeId) continue;
        if (event.kind==='reasoning') {
          if (event.reasoning?.phase==='start') reasoningSpan=`live:reasoning:${event.sequence ?? 0}`;
          // Do not mirror private token deltas into a saved/public summary.
          if(event.reasoning?.phase!=='delta') add(reasoningSpan,'reasoning','Thinking',event.reasoning?.phase==='end'?'completed':'running',event.reasoning?.text,event.reasoning?.durationMs);
        } else if(event.kind==='tool-use') add(`tool:${event.tool?.id ?? event.sequence}`,'tool',event.tool?.name,event.tool?.isError?'failed':event.tool?.result!==undefined?'completed':'running');
      }
    }
    const terminal=['completed','cancelled','failed'].includes(row.state);
    return {commandId:row.command_id,runId:row.run_id!,userMessageId:row.user_message_id!,
      assistantMessageId:supervisorExactResult(db,chatId,row.run_id)?.id ?? null,state:row.state,createdAt:row.created_at,
      activity:[...activity.values()].slice(-20).map(item=>terminal && item.state==='running'?{...item,state:'interrupted' as const}:item)};
  });
}
