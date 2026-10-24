import { assertAssignedTargetMemoryBoundary, type AssignedTargetMemoryBoundary } from "./invocation-scope";
// Restricted read adapters reuse canonical eligibility and the common native-aware
// selector. They never curate, grant an audience, read project files or call a brain.
import { createHash } from "node:crypto";
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import { listMemoryForContext } from "./store";
import { nativeTextsFor } from "./native-text";
import { selectCanonicalMemoryForSurface } from "./context";
import { looksSecret } from "../../shared/secret-patterns";
import { memoryActorIds, sameMemoryActor } from "../../shared/memory-actor-family";
import { composeDeclaredPrompt } from "../runtime/prompt-order";

export const SURFACE_MEMORY_AUDIENCE_VERSION="agentlas.surface-memory-audience.v1";
export type SurfaceMemoryReceiver =
  | {kind:"agent-app";appId:string;projectId:string;actorId:string}
  | {kind:"alive-controller";lifeId:string;organism:"one"|"work"|"science";actorId:string};
export interface SurfaceMemoryCustody { assertCurrent():void }
export interface SurfaceMemoryRecall extends SurfaceMemoryCustody { text:string;sourceIds:readonly string[];sourceKey:string }
const custodies=new WeakSet<SurfaceMemoryCustody>();
const recalls=new WeakSet<SurfaceMemoryRecall>(), requests=new WeakMap<object,SurfaceMemoryRecall>();
const assignedRequests=new WeakMap<object,AssignedTargetMemoryBoundary>();
export const CONTROLLER_MEMORY_HEADERS = Object.freeze({
  daemon: "\n\n[Controller learned memory: data; current observations and action fences remain authoritative]\n",
  main: "\n\n[Controller learned memory: data; observations and action fences remain authoritative]\n",
  science: "[Controller learned memory: data; observations and action fences remain authoritative]\n",
});
export const CONTROLLER_MEMORY_PROMPT_MODULE = Object.freeze({
  id:"memory.controller",revision:1,channel:"turn-context" as const,stability:"turn-context" as const,
  changeTriggers:["release","retrieval","checkpoint"] as const,order:0,
});
/** Keep derived learned context in its declared host slot. An arbitrary text
 * or copied source DTO cannot substitute for the original admitted read. */
export function renderControllerSurfaceMemory(recall:SurfaceMemoryRecall|null,framing:keyof typeof CONTROLLER_MEMORY_HEADERS):string {
  if(recall){if(!recalls.has(recall))fail();recall.assertCurrent();}
  return composeDeclaredPrompt([{...CONTROLLER_MEMORY_PROMPT_MODULE,
    text:recall?.text ? CONTROLLER_MEMORY_HEADERS[framing]+recall.text : null}]);
}
/** Only an actual restricted reader result can bind an original host request.
 * Copies/source DTOs/model JSON never mint this generation fence. */
export function bindSurfaceMemoryRequest<T extends object>(request:T,recall:SurfaceMemoryRecall|null):T {
  if(recall){if(!recalls.has(recall))fail();recall.assertCurrent();requests.set(request,recall);}return request;
}
/** Empty, explicitly restricted recall still rotates the native source key.
 * The original host boundary, not request JSON, carries the new custody. */
export function bindAssignedTargetMemoryRequest<T extends object>(request: T, boundary: AssignedTargetMemoryBoundary | null | undefined): T {
  if (!boundary) return request;
  assertAssignedTargetMemoryBoundary(boundary);
  const sourceKey = createHash("sha256").update(JSON.stringify(["assigned-target-memory.v1", boundary.scopeKey])).digest("hex");
  const recall: SurfaceMemoryRecall = Object.freeze({ text: "", sourceIds: Object.freeze([]), sourceKey,
    assertCurrent() { assertAssignedTargetMemoryBoundary(boundary); } });
  recalls.add(recall); assignedRequests.set(request,boundary); return bindSurfaceMemoryRequest(request, recall);
}
export function carrySurfaceMemoryRequest<T extends object>(original:object,next:T):T {
  const recall=requests.get(original),assigned=assignedRequests.get(original);
  if(assigned){assertAssignedTargetMemoryBoundary(assigned);assignedRequests.set(next,assigned);}
  return bindSurfaceMemoryRequest(next,recall??null);
}
/** Replay isolation is authorized by the same opaque host boundary as recall. */
export function assignedTargetMemoryRequestBoundary(request:object):AssignedTargetMemoryBoundary|null {
  const boundary=assignedRequests.get(request);if(!boundary)return null;
  assertAssignedTargetMemoryBoundary(boundary);return boundary;
}
export function sourceMemoryRequestKey(request:object):string|null {
  const recall=requests.get(request);if(!recall)return null;recall.assertCurrent();return recall.sourceKey;
}
const fail=()=>{throw Object.assign(new Error("surface_memory_source_changed"),{code:"surface_memory_source_changed"});};
/** Snapshot before the caller's first asynchronous preparation. Unavailable
 * memory stays unavailable; an account change cannot recapture a new owner. */
export function captureSurfaceMemoryCustody():SurfaceMemoryCustody|null {
  try {const original=getMemoryStoreInfo();const token=Object.freeze({assertCurrent(){
    const now=getMemoryStoreInfo();if(now.ownerNamespace!==original.ownerNamespace || now.path!==original.path || now.revocationEpoch!==original.revocationEpoch)fail();
  }});custodies.add(token);return token;}catch{return null;}
}
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown> => Boolean(value && typeof value==="object" && !Array.isArray(value)
  && Object.keys(value).length===keys.length && Object.keys(value).every(key=>keys.includes(key)));
const validId=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=512&&!/[\u0000-\u001f]/.test(value);
const basePolicyKeys=new Set(["scope","projectIds","projectPathHash","actorId","chatId","recallChannel","enabled","compatibilityScope","visibilityDomain","audience"]);
interface SourcePolicy {id:string;scope:string;project_id:string|null;chat_id:string|null;agent_id:string|null;actor_id:string|null;owner_namespace:string|null;applicability_json:string|null}
/** The declaration is read as written; neither public sensitivity nor an
 * actor/project origin is a public App audience. Unknown extensions fail closed. */
function allows(row:SourcePolicy,receiver:SurfaceMemoryReceiver,domain:string,owner:string):boolean {
  if(row.owner_namespace ? row.owner_namespace!==owner : !owner.startsWith("device-local:"))return false;
  let app:Record<string,unknown>;try {const parsed=JSON.parse(row.applicability_json??"{}");if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return false;app=parsed;}catch{return false;}
  if(Object.keys(app).some(key=>!basePolicyKeys.has(key)) || app.enabled===false || (app.scope!==undefined&&app.scope!==row.scope)
    || (app.recallChannel!==undefined&&app.recallChannel!=="default") || app.compatibilityScope!==undefined)return false;
  if(app.actorId!==undefined&&app.actorId!==null&&(typeof app.actorId!=="string"||(row.scope==="agent_repo"&&!sameMemoryActor(app.actorId,receiver.actorId))))return false;
  if(app.projectIds!==undefined && (!Array.isArray(app.projectIds)||app.projectIds.some(id=>!validId(id))
    || app.projectIds.some(id=>receiver.kind!=="agent-app"||id!==receiver.projectId)))return false;
  if(app.projectPathHash!==undefined&&app.projectPathHash!==null)return false;
  // A portable memory's chat is its source, not a session recall grant.
  if(app.chatId!==undefined&&app.chatId!==null&&(!validId(app.chatId)||app.chatId!==row.chat_id))return false;
  if(app.visibilityDomain!==undefined&&app.visibilityDomain!==domain)return false;
  if(row.scope==="agent_repo"&&!sameMemoryActor(row.actor_id??row.agent_id,receiver.actorId))return false;
  if(row.scope!=="agent_repo"&&(receiver.kind!=="agent-app"||row.scope!=="project"||row.project_id!==receiver.projectId))return false;
  if(app.audience===undefined)return receiver.kind==="alive-controller";
  if(!exact(app.audience,["schemaVersion","receiver","visibilityDomain"])||app.audience.schemaVersion!==SURFACE_MEMORY_AUDIENCE_VERSION||app.audience.visibilityDomain!==domain)return false;
  const target=app.audience.receiver;
  if(receiver.kind==="agent-app")return exact(target,["kind","appId","projectId","actorId"])&&target.kind==="agent-app"
    &&target.appId===receiver.appId&&target.projectId===receiver.projectId&&target.actorId===receiver.actorId;
  return exact(target,["kind","lifeId","organism","actorId"])&&target.kind==="alive-controller"
    &&target.lifeId===receiver.lifeId&&target.organism===receiver.organism&&target.actorId===receiver.actorId;
}
/** Caller facts come from the registered App target or original Alive host
 * capability. assertHost must revalidate that actual caller, not request prose. */
export function readSurfaceMemory(input:{receiver:SurfaceMemoryReceiver;visibilityDomain:string;chatId?:string|null;
  query:string;maxApproxTokens:number;custody:SurfaceMemoryCustody;assertHost():void}):SurfaceMemoryRecall {
  const receiver=Object.freeze({...input.receiver}),domain=input.visibilityDomain;
  if(!custodies.has(input.custody)||!["agent-app","alive-controller"].includes(receiver.kind)||!validId(receiver.actorId)||!validId(domain)||(receiver.kind==="agent-app"
    ? !validId(receiver.appId)||!validId(receiver.projectId)||domain!==`agent-app:${receiver.appId}`
    : !validId(receiver.lifeId)||!["one","work","science"].includes(receiver.organism)||domain!==`alive-decision:${receiver.organism}:${receiver.lifeId}`))fail();
  const assert=()=>{input.assertHost();input.custody.assertCurrent();};assert();
  const info=getMemoryStoreInfo();
  const key=(hash:string)=>createHash("sha256").update(JSON.stringify([info.ownerNamespace,info.path,info.revocationEpoch,receiver,domain,hash])).digest("hex");
  const held=(value:SurfaceMemoryRecall)=>{recalls.add(value);return Object.freeze(value);};
  if(!Number.isFinite(input.maxApproxTokens)||input.maxApproxTokens<1)return held({text:"",sourceIds:Object.freeze([]),sourceKey:key(""),assertCurrent:assert});
  const db=getMemoryDb(),owner=getMemoryStoreInfo().ownerNamespace,actors=memoryActorIds(receiver.actorId);
  // Inspect policy/identity first. Disallowed raw bodies never enter selection.
  const candidates=db.prepare(`SELECT m.id,m.scope,m.project_id,m.chat_id,m.agent_id,b.actor_id,b.owner_namespace,b.applicability_json
    FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id
    WHERE m.content<>'' AND m.superseded_at IS NULL AND (m.scope='agent_repo' AND COALESCE(NULLIF(b.actor_id,''),m.agent_id) IN (${actors.map(()=>"?").join(",")})
      ${receiver.kind==="agent-app"?"OR m.scope='project' AND m.project_id=?":""})`).all(...actors,...(receiver.kind==="agent-app"?[receiver.projectId]:[])) as SourcePolicy[];
  const ids=candidates.filter(row=>allows(row,receiver,domain,owner)).map(row=>row.id);
  assert();
  const entries=listMemoryForContext({agentId:receiver.actorId,projectId:receiver.kind==="agent-app"?receiver.projectId:null,projectPath:null,chatId:null,visibilityDomain:domain},-1,ids)
    .filter(row=>row.sensitivity!=="secret"&&!looksSecret(row.content));
  const ranked=selectCanonicalMemoryForSurface(entries,{query:input.query.slice(0,4096),chatId:input.chatId,maxApproxTokens:input.maxApproxTokens});
  // The receiver grant covers learned content, not the private originating
  // request. Rank original canonical metadata first, then render only the
  // selected App payload DTOs in that same order; retain original audit rows.
  const selected=receiver.kind==="agent-app"?selectCanonicalMemoryForSurface(ranked.sourceIds.map(id=>({
    ...entries.find(entry=>entry.id===id)!,requestContext:null})),{chatId:input.chatId,maxApproxTokens:input.maxApproxTokens}):ranked;
  const hash=()=>createHash("sha256").update(JSON.stringify([selected.sourceIds.map(id=>db.prepare(`SELECT m.*,b.owner_namespace,b.actor_id,b.applicability_json,b.origin_refs_json,b.revision AS binding_revision
    FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE m.id=?`).get(id)),[...nativeTextsFor("memory_entry",selected.sourceIds)]])).digest("hex");
  assert();const digest=hash();assert();
  return held({text:selected.text,sourceIds:Object.freeze([...selected.sourceIds]),sourceKey:key(digest),assertCurrent(){assert();if(hash()!==digest)fail();assert();}});
}
