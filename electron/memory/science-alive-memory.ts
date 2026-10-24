import { createHash } from "node:crypto";
import { ALIVE_CONTROLLER_SLUG, builtinAgentId } from "../architecture/manifest";
import { agentContextOwnerBinding } from "../runtime/agent-context-admission";
import { captureSurfaceMemoryCustody, readSurfaceMemory, type SurfaceMemoryRecall } from "./surface-recall";
import { normalizeChatRuntimeSelection } from "../store/chats";
import type { RuntimeSelection } from "../../shared/types";

const held = new Map<string, { chatId:string; actorId:string; assertCurrent():void; recall(query:string):SurfaceMemoryRecall|null }>();
const digest = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = ():never => {throw Object.assign(new Error("science_alive_memory_source_changed"),{code:"science_alive_memory_source_changed"});};
/** Called only by the original Science Alive host runtime. The installed
 * package's prepared principal owns life/scope; no source DTO grants recall. */
export function registerScienceAliveMemoryRun(input: {chatId:string;agentId:string;wakeId:string;controlEpoch:number;
  attachmentId:string;selection:RuntimeSelection}): () => void {
  if(held.has(input.wakeId))fail();
  const science = require("agentlas-science") as typeof import("agentlas-science");
  // Older packages lack the original principal reader. Keep their existing
  // source execution usable without bridging any private memory.
  if(typeof science.scienceStore!=="function")return ()=>{};
  const store = science.scienceStore(), lifetime = store.aliveLifetime(), custody = captureSurfaceMemoryCustody();
  const owner = digest(agentContextOwnerBinding()), selection = digest(input.selection);
  const authority = {agentId:input.agentId,wakeId:input.wakeId,controlEpoch:input.controlEpoch,attachmentId:input.attachmentId,domain:"science"};
  const principal = () => {
    const actual=lifetime.preparedToolPrincipal(authority,Date.now());
    if(typeof actual.scope.projectId!=="string"||typeof actual.scope.conversationId!=="string"
      ||actual.agentId!==store.scienceAliveAgentId(actual.scope.projectId))return fail();
    const current=store.aliveResearchContinuationAuthority(actual.scope.projectId,actual.scope.conversationId);
    if(current.stopped||!current.fullAutonomyStanding)fail();
    if(digest(normalizeChatRuntimeSelection(actual.runtimeBinding))!==selection)fail();
    return digest([actual.agentId,actual.controlEpoch,actual.attachmentGeneration,actual.scope,actual.runtimeBinding,
      current.conversationStopEpoch,current.approvalPolicySha256]);
  };
  const source = principal(), actorId = builtinAgentId(ALIVE_CONTROLLER_SLUG);
  let memory:SurfaceMemoryRecall|null=null;
  const entry = {chatId:input.chatId,actorId,assertCurrent(){
    if(held.get(input.wakeId)!==entry||science.scienceStore()!==store||owner!==digest(agentContextOwnerBinding())
      ||selection!==digest(input.selection)||principal()!==source)fail();
    custody?.assertCurrent();memory?.assertCurrent();
  },recall(query:string){
    entry.assertCurrent();
    const life=lifetime.get(input.agentId);if(!life)return fail();
    const headerBytes=160,baseBytes=Buffer.byteLength(query,"utf8");
    const remaining=life.budget.tokenLimit===null?96:Math.max(0,life.budget.tokenLimit-life.budget.tokensUsed-Math.ceil((baseBytes+headerBytes)/3));
    memory=custody?readSurfaceMemory({receiver:{kind:"alive-controller",organism:"science",actorId,lifeId:input.agentId},
      visibilityDomain:`alive-decision:science:${input.agentId}`,query,maxApproxTokens:Math.max(0,Math.min(96,remaining,Math.floor((65536-baseBytes-headerBytes)/3))),
      custody,assertHost(){if(held.get(input.wakeId)!==entry||principal()!==source||owner!==digest(agentContextOwnerBinding()))fail();}}):null;
    return memory;
  }};
  held.set(input.wakeId,entry);
  try {entry.assertCurrent();} catch(error) {if(held.get(input.wakeId)===entry)held.delete(input.wakeId);throw error;}
  return ()=>{if(held.get(input.wakeId)===entry)held.delete(input.wakeId);};
}
export function scienceAliveMemory(runId:string|undefined,chatId:string,actorId:string,query:string):SurfaceMemoryRecall|null {
  const entry=runId?held.get(runId):undefined;
  if(!entry)return null;
  if(entry.chatId!==chatId||entry.actorId!==actorId)fail();
  return entry.recall(query);
}
export function scienceAliveMemoryGuard(runId:string|undefined,chatId:string):()=>void {
  const entry=runId?held.get(runId):undefined;
  if(!entry)return ()=>{};
  if(entry.chatId!==chatId)fail();
  return ()=>entry.assertCurrent();
}
