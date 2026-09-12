import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, getLongRunAttemptGoalRevision } from "../store/long-runs";
import { recordRunEvent } from "../store/run-events";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";
import { decodeRuntimeEvidence } from "../../shared/runtime-evidence";
import type { AgentDownloadIdentity, AgentDownloadResult } from "../browser/download-registry";

interface Scope {runId:string;chatId:string;agentId:string|null;signal:AbortSignal;readOwner:()=>{goalId:string;attemptId:string|null}|null}
const contexts=new AsyncLocalStorage<Scope>();
export function withBrowserDownloadProofContext<T>(scope:Scope,action:()=>T):T{return contexts.run(scope,action);}
function bound(input:{goalId:string;attemptId:string;invocationRunId:string;chatId:string}) {
  const goal=getChatGoalRevision(input.goalId),run=getLongRunByGoalId(input.goalId);
  if(!goal||!run||goal.chatId!==input.chatId||run.rootChatId!==input.chatId||getChat(input.chatId)?.goalId!==input.goalId||!["running","verifying"].includes(run.status))return null;
  const attempt=getDb().prepare(`SELECT a.id,w.permission_profile FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id=a.worker_id
    WHERE a.id=? AND a.run_id=? AND a.invocation_run_id=? AND w.role='controller'`).get(input.attemptId,run.id,input.invocationRunId) as {id:string;permission_profile:string}|undefined;
  if(!attempt||!["write","full"].includes(attempt.permission_profile)||getLongRunAttemptGoalRevision(run.id,attempt.id)!==goal.revision)return null;
  return {goalRevision:goal.revision,permission:attempt.permission_profile};
}
export async function browserDownloadAvailable(chatId?:string,agentId?:string):Promise<boolean>{
  const scope=contexts.getStore();
  if(!process.versions.electron||!scope||scope.signal.aborted||scope.chatId!==chatId||scope.agentId!==agentId||!scope.readOwner())return false;
  const {canUseAgentBrowserDownload}=await import("../browser/agent-download");
  return canUseAgentBrowserDownload(scope.chatId);
}
function toolReceipts(runId:string,chatId:string,toolId:string){
  const rows=getDb().prepare("SELECT id,seq,payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='mcp_tool-use' AND json_extract(payload_json,'$.toolId')=? ORDER BY seq").all(runId,chatId,toolId) as {id:string;seq:number;payload_json:string}[];
  if(rows.length!==2)return null;
  const [start,result]=rows.map(row=>JSON.parse(row.payload_json));
  return start.toolName==='browser_download'&&result.toolName==='browser_download'&&typeof start.toolResultPreview!=='string'&&typeof result.toolResultPreview==='string'&&result.toolIsError===false?rows:null;
}
export function beginBrowserDownloadProof(input:{chatId?:string;agentId?:string;permission?:string;toolId?:string;toolName:string;signal?:AbortSignal}){
  const scope=contexts.getStore(),owner=scope?.readOwner();
  if(!scope||scope.signal.aborted||input.chatId!==scope.chatId||input.agentId!==scope.agentId||!input.toolId||input.toolId.length>512||input.toolName!=='browser_download'||!owner?.attemptId)return null;
  const base={goalId:owner.goalId,attemptId:owner.attemptId,invocationRunId:scope.runId,chatId:scope.chatId},captured=bound(base);
  if(!captured||captured.permission!==input.permission)return null;
  const signal=input.signal ? AbortSignal.any([scope.signal,input.signal]) : scope.signal;
  let result:AgentDownloadResult|null=null,called=false,completed=false;
  const current=()=>!signal.aborted&&bound(base)?.goalRevision===captured.goalRevision&&!getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? AND kind IN ('invoke_completed','invoke_failed','invoke_threw','invoke_cancelled','invoke_interrupted') LIMIT 1").get(scope.runId);
  return {
    async download(rawUrl:string){
      if(called||!current())throw new Error("browser_download_scope_changed");called=true;
      const url=new URL(rawUrl.trim()).toString();
      const identity:AgentDownloadIdentity={invocationRunId:scope.runId,chatId:scope.chatId,goalId:owner.goalId,goalRevision:captured.goalRevision,attemptId:owner.attemptId!,toolId:input.toolId!,requestUrlDigest:createHash("sha256").update(url).digest("hex")};
      const {downloadInTaskBrowser}=await import("../browser/agent-download");
      result=await downloadInTaskBrowser({url,identity,signal,current});
      return {id:result.id,fileName:result.fileName,bytes:result.receivedBytes,savePath:result.savePath};
    },
    async complete(downloadId:string){
      if(completed)return;completed=true;
      if(!result||result.id!==downloadId||!current())return;
      const tools=toolReceipts(scope.runId,scope.chatId,input.toolId!);
      if(!tools)return;
      const {readAgentBrowserDownload}=await import("../browser/download-registry");
      const actual=readAgentBrowserDownload(downloadId,result.identity);
      if(!actual||!current())return;
      recordRunEvent({runId:scope.runId,chatId:scope.chatId,kind:'runtime_download_observed',sourceEventId:`browser-download:${tools[1].id}`,payload:{
        schemaVersion:'agentlas.browser-download-proof.v1',...actual.identity,downloadId:actual.id,fileName:actual.fileName,bytes:actual.receivedBytes,
        sha256:actual.sha256,sourceOrigin:actual.sourceOrigin,startEventId:tools[0].id,resultEventId:tools[1].id}});
    },
  };
}
export interface CurrentDownloadProof {ref:string;downloadId:string;fileName:string;bytes:number;sha256:string;sourceOrigin:string|null}
export async function currentBrowserDownloadProofs(input:{goalId:string;invocationRunId:string;goalRevision:number}):Promise<CurrentDownloadProof[]>{
  const goal=getChatGoalRevision(input.goalId);
  if(!goal||goal.revision!==input.goalRevision)return [];
  const effect=readInvocationEffectBoundary({invocationRunId:input.invocationRunId,expectedChatId:goal.chatId});
  if(!effect.terminal||effect.effects!=='settled')return [];
  const terminal=getDb().prepare("SELECT seq FROM run_events WHERE id=?").get(effect.terminalEventId) as {seq:number}|undefined;
  if(!terminal)return [];
  const rows=getDb().prepare("SELECT id,seq,payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='runtime_download_observed' ORDER BY seq DESC LIMIT 33").all(input.invocationRunId,goal.chatId) as {id:string;seq:number;payload_json:string}[];
  if(rows.length>32)return [];
  let total=0;
  try {
    for(const row of rows){const bytes=JSON.parse(row.payload_json).bytes;if(!Number.isSafeInteger(bytes)||bytes<0)return [];total+=bytes;}
  } catch { return []; }
  if(total>64*1024*1024)return [];
  const {readAgentBrowserDownload}=await import("../browser/download-registry"),proofs:CurrentDownloadProof[]=[];
  for(const row of rows)try{
    const data=JSON.parse(row.payload_json),correlation=decodeRuntimeEvidence(data.runtimeEvidence)?.correlation;
    if(row.seq>=terminal.seq||data.schemaVersion!=='agentlas.browser-download-proof.v1'||data.goalId!==input.goalId||data.goalRevision!==input.goalRevision
      ||correlation?.attemptId!==data.attemptId||correlation?.invocationRunId!==input.invocationRunId||correlation?.goalId!==input.goalId||correlation?.goalRevision!==input.goalRevision)continue;
    const identity:AgentDownloadIdentity={invocationRunId:input.invocationRunId,chatId:goal.chatId,goalId:input.goalId,goalRevision:input.goalRevision,attemptId:data.attemptId,toolId:data.toolId,requestUrlDigest:data.requestUrlDigest};
    if(!bound(identity))continue;
    const tools=toolReceipts(input.invocationRunId,goal.chatId,data.toolId);
    if(!tools||tools[0].id!==data.startEventId||tools[1].id!==data.resultEventId||tools[1].seq>=row.seq)continue;
    const current=readAgentBrowserDownload(data.downloadId,identity);
    if(!current||current.sha256!==data.sha256||current.receivedBytes!==data.bytes||current.fileName!==data.fileName)continue;
    proofs.push({ref:`download-proof:${row.id}`,downloadId:current.id,fileName:current.fileName,bytes:current.receivedBytes,sha256:current.sha256,sourceOrigin:current.sourceOrigin});
  }catch{/* Invalid or stale state remains unavailable. */}
  return proofs;
}
