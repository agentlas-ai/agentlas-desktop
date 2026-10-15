import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { emitDesktopStoreChange } from "../store/change-bus";
import { isAppControlEvent } from "../app-control/ipc-registry";
import { getMemoryDb, getMemoryStoreInfo } from "../memory/database";
import { currentMemoryOwnerRef, learningActor, memoryTargetRevision, ownedMemoryRecord, ownerMemorySelect,
  editOwnedMemory, forgetOwnedMemory, type OwnerMemoryRecord } from "../memory/owner-mutations";
import { memoryAudienceKey } from "../memory/store";
import { inspectAppMemorySharing, setAppMemorySharing } from "../memory/agent-app-memory";
import { nativeTextsFor } from "../memory/native-text";
import { projectMemoryEmbeddings } from "./memory-map";
import { getAgentById } from "../mcp/registry";
import { looksSecret, redactSecrets } from "../../shared/secret-patterns";
import { isOneMemoryActor, memoryActorIds } from "../../shared/memory-actor-family";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
import { ONE_MEMORY_MAP_CONTRACT_VERSION, type OneMemoryMapKind, type OneMemoryMapScope } from "../../shared/one-memory-map";
import { DESKTOP_MEMORY_INSPECTOR_VERSION, type DesktopMemoryQuery, type DesktopMemoryQueryResult,
  type DesktopMemoryDetail, type DesktopMemoryEntry, type DesktopMemoryStatus } from "../../shared/desktop-memory-inspector";
const scopes = ["user_identity","team_memory","agent_repo","agent_team","project","session"];
const kinds = ["fact","decision","preference","risk","procedure","hypothesis","evidence","deprecation","conflict"];
const statusOf = (row: OwnerMemoryRecord): DesktopMemoryStatus => !row.content ? "forgotten" : row.superseded_at ? "superseded"
  : applicability(row).enabled === false ? "disabled" : "active";
function object(value: string | null): Record<string, unknown> { try { const parsed = JSON.parse(value ?? "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function applicability(row: OwnerMemoryRecord) { return object(row.applicability_json); }
function id(value: unknown): string | null { return typeof value === "string" && value.trim() && value.length <= 512 && !/[\u0000-\u001f]/.test(value) ? value.trim() : null; }
function safe(text: string): string { return redactSecrets(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g," "); }
function actorName(actor: string | null): string {
  if (!actor) return "Unknown / legacy";
  if (isOneMemoryActor(actor)) return "One";
  try { return getAgentById(actor)?.name ?? actor; } catch { return actor; }
}
function entry(row: OwnerMemoryRecord,native: string | undefined): DesktopMemoryEntry {
  const actor = learningActor(row), text = row.sensitivity === "secret" || looksSecret(native ?? row.content) ? "[Restricted content]" : safe(native ?? row.content);
  return { memoryId:row.id,ownerRef:currentMemoryOwnerRef(),actorId:actor,expectedRevision:memoryTargetRevision(row),expectedEpoch:getMemoryStoreInfo().revocationEpoch,
    kind:row.kind,scope:row.scope,content:text.slice(0,4_000),title:text.replace(/\s+/g," ").slice(0,160),status:statusOf(row),createdAt:row.created_at,
    actorName:actorName(actor),projectSlug:row.project_path ? row.project_path.split(/[\\/]/).filter(Boolean).at(-1) ?? null : row.project_id };
}
export function inspectMemoryDetail(input: { memoryId: string; ownerRef: string }): DesktopMemoryDetail {
  if (!id(input?.memoryId) || input.ownerRef !== currentMemoryOwnerRef()) throw new Error("memory_owner_custody_changed");
  const row = ownedMemoryRecord(input.memoryId), db = getMemoryDb(), store = getMemoryStoreInfo();
  const native = nativeTextsFor("memory_entry",[row.id]).get(row.id), app = applicability(row), base = entry(row,native);
  const origins = db.prepare("SELECT source_kind,source_id,source_revision FROM memory_origin_links WHERE memory_id=? ORDER BY source_kind,source_id,source_revision LIMIT 128").all(row.id) as Array<{source_kind:string;source_id:string;source_revision:string}>;
  const side = (()=>{ try { const values: unknown = JSON.parse(row.origin_refs_json ?? "[]"); return Array.isArray(values) ? values : []; } catch { return []; } })();
  const refs = new Map<string,{kind:string;id:string;revision:string|null}>();
  for (const origin of [...origins.map(item=>({kind:item.source_kind,id:item.source_id,revision:item.source_revision||null})),
    ...side.map(item=>typeof item === "string" ? {kind:"source",id:item,revision:null} : item)]) {
    if (!origin || typeof origin !== "object" || !id(origin.id) || looksSecret(origin.id)) continue;
    const ref = {kind:safe(String(origin.kind ?? "source")).slice(0,64),id:safe(origin.id),revision:typeof origin.revision === "string" ? safe(origin.revision).slice(0,512) : null};
    refs.set(JSON.stringify(ref),ref);
  }
  const projects = db.prepare("SELECT DISTINCT project_id AS id,relation FROM memory_project_links WHERE memory_id=? ORDER BY project_id,relation LIMIT 128").all(row.id) as DesktopMemoryDetail["projects"];
  const compatibility = app.compatibilityScope && typeof app.compatibilityScope === "object" ? app.compatibilityScope as {scope?:unknown;scopeRef?:unknown} : null;
  const channel = typeof app.recallChannel === "string" ? safe(app.recallChannel).slice(0,64) : "default";
  return { ...base,contentEnglish:row.sensitivity === "secret" || looksSecret(row.content) ? "[Restricted content]" : safe(row.content).slice(0,4_000),
    contentNative:native && row.sensitivity !== "secret" && !looksSecret(native) ? safe(native).slice(0,4_000) : null,
    sensitivity:row.sensitivity,confidence:row.confidence,originRefs:[...refs.values()].slice(0,64),projects,
    applicability:{scope:row.scope,projectIds:Array.isArray(app.projectIds) ? app.projectIds.filter((value):value is string=>Boolean(id(value))).slice(0,64) : [],
      actorId:id(app.actorId),chatId:id(app.chatId),enabled:app.enabled !== false,recallChannel:channel,
      compatibilityScope:compatibility && typeof compatibility.scope === "string" ? {scope:safe(compatibility.scope),scopeRef:id(compatibility.scopeRef)} : null},
    audience:{declaration:app.audience && typeof app.audience === "object" ? "existing_scope" : "unknown",scope:row.scope,sensitivity:row.sensitivity,recallChannel:channel},
    curationActor:row.curation_actor ?? "legacy",policyVersion:row.policy_version,authorityRevision:store.revision,bindingRevision:row.binding_revision,
    supersededAt:row.superseded_at,editable:base.status === "active" && memoryAudienceKey(row.id)!==null && Boolean(base.actorId) && row.sensitivity !== "secret" && !looksSecret(base.content) };
}
export function queryOwnedMemory(input: DesktopMemoryQuery = {}): DesktopMemoryQueryResult {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key=>!["actorId","projectId","scope","status","limit"].includes(key))) throw new Error("memory_inspector_query_invalid");
  if ((input.limit !== undefined && (typeof input.limit!=="number" || !Number.isFinite(input.limit))) || (input.actorId !== undefined && input.actorId !== null && !id(input.actorId)) || (input.projectId && !id(input.projectId))
    || (input.scope && !scopes.includes(input.scope)) || (input.status && !["active","disabled","superseded","forgotten","all"].includes(input.status))) throw new Error("memory_inspector_query_invalid");
  const db = getMemoryDb(), store = getMemoryStoreInfo(), ownerRef = currentMemoryOwnerRef();
  const owner = `(b.owner_namespace=? OR (b.owner_namespace IS NULL AND ?=1))`;
  const params = [store.ownerNamespace,store.ownerNamespace.startsWith("device-local:") ? 1 : 0];
  const actors = new Map<string|null,string>(), projectNames = new Map<string,string>();
  const actorRows = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(b.actor_id,''),m.agent_id) AS actor FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${owner}`).all(...params) as Array<{actor:string|null}>;
  for (const row of actorRows) actors.set(isOneMemoryActor(row.actor)?BUILTIN_ONE_AGENT_ID:row.actor,actorName(row.actor));
  const projectRows=db.prepare(`SELECT DISTINCT m.project_id AS id FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${owner} AND m.project_id IS NOT NULL
    UNION SELECT DISTINCT p.project_id AS id FROM memory_project_links p JOIN memory_entries m ON m.id=p.memory_id LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${owner}`).all(...params,...params) as Array<{id:string}>;
  for(const row of projectRows) projectNames.set(row.id,row.id);
  const filters=[owner], values: Array<string|number>=[...params];
  const actor=input.actorId===undefined?BUILTIN_ONE_AGENT_ID:input.actorId;
  if(actor!==null){const family=memoryActorIds(actor) as string[];filters.push(`COALESCE(NULLIF(b.actor_id,''),m.agent_id) IN (${family.map(()=>"?").join(",")})`);values.push(...family);}
  if(input.scope){filters.push("m.scope=?");values.push(input.scope);}
  if(input.projectId){filters.push("(m.project_id=? OR EXISTS(SELECT 1 FROM memory_project_links p WHERE p.memory_id=m.id AND p.project_id=?))");values.push(input.projectId,input.projectId);}
  const status=input.status??"active";
  if(status==="active")filters.push("m.content<>'' AND m.superseded_at IS NULL AND COALESCE(CASE WHEN json_valid(b.applicability_json) THEN json_extract(b.applicability_json,'$.enabled') END,1)<>0");
  if(status==="disabled")filters.push("m.content<>'' AND m.superseded_at IS NULL AND CASE WHEN json_valid(b.applicability_json) THEN json_extract(b.applicability_json,'$.enabled') END=0");
  if(status==="superseded")filters.push("m.content<>'' AND m.superseded_at IS NOT NULL");
  if(status==="forgotten")filters.push("m.content=''");
  const where=filters.join(" AND ");
  const total=Number((db.prepare(`SELECT COUNT(*) AS n FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${where}`).get(...values) as {n:number}).n);
  const limit=Math.max(1,Math.min(1000,Math.floor(input.limit??1000)));if(!Number.isFinite(limit))throw new Error("memory_inspector_query_invalid");
  const bounded=db.prepare(`${ownerMemorySelect} WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`).all(...values,limit) as OwnerMemoryRecord[];
  const natives=nativeTextsFor("memory_entry",bounded.map(row=>row.id));
  const entries=bounded.map(row=>entry(row,natives.get(row.id))), ids=new Set(bounded.map(row=>row.id));
  const positions=projectMemoryEmbeddings(bounded.map(row=>{let embedding:number[]|null=null;try {const parsed=JSON.parse(row.embedding_json??"null");if(Array.isArray(parsed)) embedding=parsed;}catch{}return{id:row.id,embedding};}));
  const edges=(bounded.length ? db.prepare(`SELECT from_memory_id,to_memory_id,relation_type,score FROM memory_relation_edges WHERE from_memory_id IN (${bounded.map(()=>"?").join(",")}) LIMIT 4000`).all(...bounded.map(row=>row.id)) : []) as Array<{from_memory_id:string;to_memory_id:string;relation_type:"similar_to"|"supersedes"|"contradicts";score:number|null}>;
  const scopedEdges=edges.filter(row=>ids.has(row.from_memory_id)&&ids.has(row.to_memory_id));
  const map={contractVersion:ONE_MEMORY_MAP_CONTRACT_VERSION,generatedAt:new Date().toISOString(),sourceRevision:`${ownerRef}:${store.revision}:${store.revocationEpoch}`,
    nodes:entries.map(row=>({id:row.memoryId,kind:(kinds.includes(row.kind)?row.kind:"hypothesis") as OneMemoryMapKind,scope:row.scope as OneMemoryMapScope,projectSlug:row.projectSlug,...(positions.get(row.memoryId)??{x:0.5,y:0.5}),density:0.5,relationCount:scopedEdges.filter(edge=>edge.from_memory_id===row.memoryId||edge.to_memory_id===row.memoryId).length,evidenceCount:0})),
    edges:scopedEdges.map(edge=>({from:edge.from_memory_id,to:edge.to_memory_id,relation:edge.relation_type,score:edge.score})),clusterCount:new Set(entries.map(row=>row.projectSlug??row.actorName)).size};
  return {schemaVersion:DESKTOP_MEMORY_INSPECTOR_VERSION,ownerRef,revocationEpoch:store.revocationEpoch,authorityRevision:store.revision,entries,map,total,truncated:bounded.length<total,
    actors:[...actors].map(([id,name])=>({id,name})),projects:[...projectNames].map(([id,name])=>({id,name}))};
}
export function registerDesktopMemoryInspectorIpc(input: {ipc:Pick<IpcMain,"handle">;assertTrustedSender(event:IpcMainInvokeEvent):unknown;onOwnerChanged?(listener:()=>void):()=>void}):void {
  input.onOwnerChanged?.(()=>emitDesktopStoreChange({entity:"one-profile"}));
  const guard=(event:IpcMainInvokeEvent)=>{if(isAppControlEvent(event)) throw new Error("memory_inspector_owner_renderer_required");input.assertTrustedSender(event);};
  input.ipc.handle("oneMemory:inspectQuery",(event,value)=>{guard(event);return queryOwnedMemory(value);});
  input.ipc.handle("oneMemory:inspectDetail",(event,value)=>{guard(event);return inspectMemoryDetail(value);});
  input.ipc.handle("oneMemory:inspectEdit",(event,value)=>{guard(event);const result=editOwnedMemory(value);emitDesktopStoreChange({entity:"agent",id:value.actorId});return result;});
  input.ipc.handle("oneMemory:inspectAppSharing",(event,value)=>{guard(event);return inspectAppMemorySharing(value);});
  input.ipc.handle("oneMemory:setAppSharing",(event,value)=>{guard(event);const result=setAppMemorySharing(value);emitDesktopStoreChange({entity:"agent",id:value.actorId});return result;});
  input.ipc.handle("oneMemory:inspectForget",(event,value)=>{guard(event);const result=forgetOwnedMemory(value);emitDesktopStoreChange({entity:"agent",id:value.actorId});return result;});
}
