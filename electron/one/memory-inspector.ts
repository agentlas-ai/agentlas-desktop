import { decodeStoredVector } from "../memory/local-embedding";
import { createHash } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { emitDesktopStoreChange } from "../store/change-bus";
import { isAppControlEvent } from "../app-control/ipc-registry";
import { getMemoryDb, getMemoryStoreInfo, memoryRoot } from "../memory/database";
import { layoutOf, openStore, rootClock } from "../memory/stores";
import { readSet, setFingerprint, setStores } from "../memory/store-set";
import { currentMemoryOwnerRef, learningActor, memoryTargetRevision, ownedMemoryRecord, ownerMemorySelect, recordStore,
  editOwnedMemory, forgetOwnedMemory, type OwnerMemoryRecord } from "../memory/owner-mutations";
import { memoryAudienceKey } from "../memory/store";
import { inspectAppMemorySharing, setAppMemorySharing } from "../memory/agent-app-memory";
import { nativeTextsFor } from "../memory/native-text";
import { derivedSkillsForRecords } from "../memory/derived-skills";
import { projectMemoryEmbeddings } from "./memory-map";
import { getAgentById } from "../mcp/registry";
import { readSharedIdRows, sharedOpenHere } from "../memory/shared-ids";
import { looksSecret, redactSecrets } from "../../shared/secret-patterns";
import { isOneMemoryActor, memoryActorIds } from "../../shared/memory-actor-family";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
import { ONE_MEMORY_MAP_CONTRACT_VERSION, type OneMemoryMapKind, type OneMemoryMapScope } from "../../shared/one-memory-map";
import { DESKTOP_MEMORY_INSPECTOR_VERSION, type DesktopMemorySharing, type DesktopMemoryQuery, type DesktopMemoryQueryResult,
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
  const row = ownedMemoryRecord(input.memoryId), store = getMemoryStoreInfo();
  // a row that lives in another store has its links there.
  const rowStore = recordStore(row);
  const db = (rowStore ? openStore(rowStore, store.ownerNamespace, getMemoryDb(), memoryRoot()).store?.db : null) ?? getMemoryDb();
  const native = rowStore ? (()=>{ try { return (db.prepare("SELECT content_native FROM memory_entry_native WHERE entry_id=?").get(row.id) as {content_native:string}|undefined)?.content_native; } catch { return undefined; } })() : nativeTextsFor("memory_entry",[row.id]).get(row.id), app = applicability(row), base = entry(row,native);
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
    supersededAt:row.superseded_at,editable:base.status === "active" && !recordStore(row) && memoryAudienceKey(row.id)!==null && Boolean(base.actorId) && row.sensitivity !== "secret" && !looksSecret(base.content) };
}
/**
 * the mark of a Personal line on the memory screen. One read of the account's table per query, and only when shared memory was opened here (the first-merge mark): before that nothing is added and the screen is what it was.
 * "from" = a card another place said (its source tag, or a table row whose `by` names another place); "local" = a table row in state L; a shared kind (fact, identity, boundary with its structure) with any other state is `shared`; the rest is the agent's own.
 */
function sharingReader(db: ReturnType<typeof getMemoryDb>): (row: OwnerMemoryRecord) => DesktopMemorySharing | undefined {
  let rows: ReturnType<typeof readSharedIdRows> | null = null, open = false;
  try { open = sharedOpenHere(db); if (open) rows = readSharedIdRows(db); } catch { open = false; }
  return (row) => {
    if (!open || !rows || row.scope !== "user_identity") return undefined;
    const kindShared = row.kind === "fact" || (() => { try { const c = JSON.parse(row.context_json || "{}") as { ticket_kind?: unknown; boundary?: unknown }; return c.ticket_kind === "identity" || (c.ticket_kind === "boundary" && c.boundary !== undefined); } catch { return false; } })();
    if (!kindShared) return { kind: "own" };
    const r = rows.get(row.id);
    if (r?.state === "L") return { kind: "local" };
    const taken = /"hope-server-fact:/.test(row.evidence_json ?? "") || (r?.state === "S" && r.by !== null);
    return taken ? { kind: "from", name: null } : { kind: "shared" };
  };
}
let pickerCache: { key: string; actors: Array<[string|null,string]>; projects: Array<[string,string]> } | null = null;
export function queryOwnedMemory(input: DesktopMemoryQuery = {}): DesktopMemoryQueryResult {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key=>!["actorId","projectId","scope","status","limit"].includes(key))) throw new Error("memory_inspector_query_invalid");
  if ((input.limit !== undefined && (typeof input.limit!=="number" || !Number.isFinite(input.limit))) || (input.actorId !== undefined && input.actorId !== null && !id(input.actorId)) || (input.projectId && !id(input.projectId))
    || (input.scope && !scopes.includes(input.scope)) || (input.status && !["active","disabled","superseded","forgotten","all"].includes(input.status))) throw new Error("memory_inspector_query_invalid");
  const db = getMemoryDb(), store = getMemoryStoreInfo(), ownerRef = currentMemoryOwnerRef();
  const owner = `(b.owner_namespace=? OR (b.owner_namespace IS NULL AND ?=1))`;
  const params = [store.ownerNamespace,store.ownerNamespace.startsWith("device-local:") ? 1 : 0];
  const actors = new Map<string|null,string>(), projectNames = new Map<string,string>();
  // The two DISTINCT scans (about 23 ms on 50k rows) only feed the pickers. They read this one store, so they are reused while its revision, its
  // epoch and SQLite's data_version (other connections' commits) are unchanged; one entry, replaced on change (item 10).
  let dataVersion: unknown = null; try { dataVersion = db.pragma("data_version", { simple: true }); } catch { /* no key: always rescan */ }
  // not OFF — the pickers also name the actors and projects that only live in other stores; the key then carries the stores' stat fingerprint (stat only).
  const setContext = (() => { try { return layoutOf(db) === "central" ? null : { memoryRoot: memoryRoot(), owner: store.ownerNamespace, rootDb: db }; } catch { return null; } })();
  const actorFilter = input.actorId === undefined ? BUILTIN_ONE_AGENT_ID : input.actorId;
  const storeList = setContext ? setStores(setContext, actorFilter === null ? {} : { agentId: actorFilter }) : [];
  const pickerStores = setContext ? setStores(setContext, {}) : [];
  const fingerprint = setContext ? createHash("sha256").update(setFingerprint(pickerStores, rootClock(db))).digest("hex").slice(0, 16) : "";
  const listKey = dataVersion === null ? null : `${store.ownerNamespace}:${store.revision}:${store.revocationEpoch}:${String(dataVersion)}${fingerprint ? `:s${fingerprint}` : ""}`;
  if (listKey !== null && pickerCache?.key === listKey) {
    for (const [key, name] of pickerCache.actors) actors.set(key, name);
    for (const [key, name] of pickerCache.projects) projectNames.set(key, name);
  } else {
    const actorRows = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(b.actor_id,''),m.agent_id) AS actor FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${owner}`).all(...params) as Array<{actor:string|null}>;
    for (const row of actorRows) actors.set(isOneMemoryActor(row.actor)?BUILTIN_ONE_AGENT_ID:row.actor,actorName(row.actor));
    const projectRows=db.prepare(`SELECT DISTINCT m.project_id AS id FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${owner} AND m.project_id IS NOT NULL
      UNION SELECT DISTINCT p.project_id AS id FROM memory_project_links p JOIN memory_entries m ON m.id=p.memory_id LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${owner}`).all(...params,...params) as Array<{id:string}>;
    for(const row of projectRows) projectNames.set(row.id,row.id);
    if (setContext) {
      const picked = readSet(setContext, pickerStores, "inspect-pickers", sub => ({
        actors: (sub.prepare(`SELECT DISTINCT COALESCE(NULLIF(b.actor_id,''),m.agent_id) AS actor FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${owner}`).all(...params) as Array<{actor:string|null}>).map(row=>row.actor),
        projects: (sub.prepare(`SELECT DISTINCT m.project_id AS id FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${owner} AND m.project_id IS NOT NULL
          UNION SELECT DISTINCT p.project_id AS id FROM memory_project_links p JOIN memory_entries m ON m.id=p.memory_id LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${owner}`).all(...params,...params) as Array<{id:string}>).map(row=>row.id),
      }), value => value.actors.length + value.projects.length);
      for (const item of picked.results) {
        for (const actor of item.value.actors) actors.set(isOneMemoryActor(actor)?BUILTIN_ONE_AGENT_ID:actor,actorName(actor));
        for (const id of item.value.projects) projectNames.set(id,id);
      }
    }
    if (listKey !== null) pickerCache = { key: listKey, actors: [...actors], projects: [...projectNames] };
  }
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
  const rootTotal=Number((db.prepare(`SELECT COUNT(*) AS n FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${where}`).get(...values) as {n:number}).n);
  const limit=Math.max(1,Math.min(1000,Math.floor(input.limit??1000)));if(!Number.isFinite(limit))throw new Error("memory_inspector_query_invalid");
  const rootBounded=db.prepare(`${ownerMemorySelect} WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`).all(...values,limit) as OwnerMemoryRecord[];
  // the other stores' share of the same query (count, newest rows, original wording, edges) — only the stores that changed since the last call are opened.
  const fromStores = setContext ? readSet(setContext, storeList, `inspect:${JSON.stringify([where,values,limit])}`, sub => {
    const n=Number((sub.prepare(`SELECT COUNT(*) AS n FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE ${where}`).get(...values) as {n:number}).n);
    const found=sub.prepare(`${ownerMemorySelect} WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`).all(...values,limit) as OwnerMemoryRecord[];
    const nativeText=new Map<string,string>();
    try { for (let at=0; at<found.length; at+=400) { const part=found.slice(at,at+400); for (const item of sub.prepare(`SELECT entry_id,content_native FROM memory_entry_native WHERE entry_id IN (${part.map(()=>"?").join(",")})`).all(...part.map(row=>row.id)) as Array<{entry_id:string;content_native:string}>) nativeText.set(item.entry_id,item.content_native); } } catch { /* this store has no original-wording table */ }
    let edgeRows: Array<{from_memory_id:string;to_memory_id:string;relation_type:"similar_to"|"supersedes"|"contradicts";score:number|null}> = [];
    try { edgeRows=found.length ? sub.prepare(`SELECT from_memory_id,to_memory_id,relation_type,score FROM memory_relation_edges WHERE from_memory_id IN (${found.map(()=>"?").join(",")}) LIMIT 4000`).all(...found.map(row=>row.id)) as typeof edgeRows : []; } catch { /* no edge table */ }
    return { n, found, nativeText: [...nativeText], edgeRows };
  }, value => value.found.length + value.edgeRows.length + 1) : null;
  const total=rootTotal + (fromStores ? fromStores.results.reduce((sum,item)=>sum+item.value.n,0) : 0);
  const bounded=fromStores ? [...rootBounded,...fromStores.results.flatMap(item=>item.value.found.map(row=>{ const copy={...row}; Object.defineProperty(copy,Symbol.for("agentlas.memory-store-of"),{value:item.ref,enumerable:false}); return copy; }))] // a copy: the store set's cache hands the same row object to every call, and a second tag on it threw (#1)
    .sort((a,b)=>a.created_at<b.created_at?1:a.created_at>b.created_at?-1:a.id<b.id?1:a.id>b.id?-1:0).slice(0,limit) : rootBounded;
  const natives=nativeTextsFor("memory_entry",rootBounded.map(row=>row.id));
  if (fromStores) for (const item of fromStores.results) for (const [entryId,text] of item.value.nativeText) natives.set(entryId,text);
  // Redesign backend C: the skills made from each line, one pass over the agents' skill promotions for the whole list (memory/derived-skills.ts); absent = not known.
  const derived=derivedSkillsForRecords(bounded);
  const sharingOf=sharingReader(db);
  const entries=bounded.map(row=>{const line=entry(row,natives.get(row.id)),skills=derived.get(row.id),sharing=row.scope==="user_identity"?sharingOf(row):undefined;return {...(skills===undefined?line:{...line,derivedSkills:skills}),...(sharing?{sharing}:{})};}), ids=new Set(bounded.map(row=>row.id));
  const positions=projectMemoryEmbeddings(bounded.map(row=>{const embedding:number[]|null=decodeStoredVector(row.embedding_json);return{id:row.id,embedding};}));
  const edges=(bounded.length ? db.prepare(`SELECT from_memory_id,to_memory_id,relation_type,score FROM memory_relation_edges WHERE from_memory_id IN (${bounded.map(()=>"?").join(",")}) LIMIT 4000`).all(...bounded.map(row=>row.id)) : []) as Array<{from_memory_id:string;to_memory_id:string;relation_type:"similar_to"|"supersedes"|"contradicts";score:number|null}>;
  const allEdges=fromStores ? [...edges,...fromStores.results.flatMap(item=>item.value.edgeRows)] : edges;
  const scopedEdges=allEdges.filter(row=>ids.has(row.from_memory_id)&&ids.has(row.to_memory_id));
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
