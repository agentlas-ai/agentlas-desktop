import { createHash } from "node:crypto";
import { sameMemoryActor } from "../../shared/memory-actor-family";
export interface MemoryRecallScope { projectId?: string|null; projectPath?: string|null; agentId?: string|null;
  chatId?: string|null; visibilityDomain?: string|null; recallBoundary?: "assigned-target" }
export interface MemoryRecallPolicyRow { scope:string;project_id:string|null;project_path:string|null;agent_id:string|null;chat_id:string|null;
  binding_owner?:string|null;binding_actor?:string|null;applicability_json?:string|null }
const fields=new Set(["scope","projectIds","projectPathHash","actorId","chatId","recallChannel","enabled","compatibilityScope","visibilityDomain","audience"]);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>Boolean(v)&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v as object).sort().join()===keys.sort().join();
/** Policy precedes ranking/embedding. Scope comes from an actual host reader. */
export function allowsOrdinaryMemoryRecall(row:MemoryRecallPolicyRow,scope:MemoryRecallScope,owner:string):boolean {
  if(scope.recallBoundary === "assigned-target")return false;
  if(!row.binding_owner)return owner.startsWith("device-local:");
  if(row.binding_owner!==owner)return false;
  let p:Record<string,unknown>;try {p=JSON.parse(row.applicability_json??"{}");}catch{return false;}
  if(!p||typeof p!=="object"||Array.isArray(p)||Object.keys(p).some(k=>!fields.has(k))
    ||(p.enabled!==undefined&&p.enabled!==true)||(p.scope!==undefined&&p.scope!==row.scope)
    ||(p.recallChannel!==undefined&&p.recallChannel!=="default")||p.compatibilityScope!==undefined)return false;
  const actor=row.binding_actor??row.agent_id;
  if(p.actorId!==undefined&&p.actorId!==null&&(typeof p.actorId!=="string"||!sameMemoryActor(p.actorId,actor)))return false;
  if((row.scope==="agent_repo"||row.scope==="session")&&actor!==null&&!sameMemoryActor(actor,scope.agentId??null))return false;
  if(p.projectIds!==undefined) {
    if(!Array.isArray(p.projectIds)||p.projectIds.some(v=>typeof v!=="string"||v!==row.project_id))return false;
    // The original default writer records the origin project even for portable
    // agent/user learning. Scope/path and an explicit audience still determine
    // applicability; origin alone cannot turn portable learning into a grant.
    if((row.scope==="project"||row.project_path!==null||p.audience!==undefined)
      &&p.projectIds.some(v=>v!==scope.projectId))return false;
  }
  if(p.projectPathHash!==undefined&&p.projectPathHash!==null&&p.projectPathHash!==createHash("sha256").update(scope.projectPath??"").digest("hex"))return false;
  // For portable learning chat_id records origin; only session scope constrains its reader.
  if(p.chatId!==undefined&&p.chatId!==null&&(p.chatId!==row.chat_id||(row.scope==="session"&&p.chatId!==scope.chatId)))return false;
  if(p.visibilityDomain!==undefined&&p.visibilityDomain!==scope.visibilityDomain)return false;
  if(p.audience===undefined)return true;
  const a=p.audience;if(!exact(a,["schemaVersion","receiver","visibilityDomain"])||a.schemaVersion!=="agentlas.surface-memory-audience.v1"
    ||!scope.visibilityDomain||a.visibilityDomain!==scope.visibilityDomain)return false;
  const target=a.receiver;
  if(exact(target,["kind","appId","projectId","actorId"])&&target.kind==="agent-app")return target.projectId===scope.projectId
    &&target.actorId===scope.agentId&&scope.visibilityDomain===`agent-app:${target.appId}`;
  if(exact(target,["kind","lifeId","organism","actorId"])&&target.kind==="alive-controller")return target.actorId===scope.agentId
    &&scope.visibilityDomain===`alive-decision:${target.organism}:${target.lifeId}`;
  return false;
}
