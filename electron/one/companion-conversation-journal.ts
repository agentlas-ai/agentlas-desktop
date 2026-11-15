/**
 * Disabled continuity journal. This preserves a verified ordered snapshot without
 * merging either existing transcript or enabling a product read/recall path.
 * The verifier must establish the shared conversation, account, device, consent,
 * source writer fence, complete deletion lineage, and media completeness.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

type Origin = "companion" | "desktop";
type Base = { source: Origin; originId: string; sourceId: string; messageId: string; sequence: number; revision: number };
type Entry = (Base & { state:"active"; role:"user"|"assistant"; text:string; createdAt:string; mediaState:"none" }) |
  (Base & { state:"deleted" });
export type ContinuityConversationSnapshot = { version:1; complete:true; userId:string; workspaceId:string; authEpoch:number;
  oneId:string; conversationId:string; generation:string; revision:number; forgetEpoch:number; items:Entry[] };
export type ContinuityConversationProof = { userId:string; workspaceId:string; authEpoch:number; oneId:string; conversationId:string;
  generation:string; ownerNamespace:string; assertCurrent():void };
export type ContinuityConversationVerifier = (snapshot:ContinuityConversationSnapshot)=>Promise<ContinuityConversationProof|null>;
const id = (v:unknown):v is string => typeof v === "string" && /^[A-Za-z0-9_.:@-]{1,200}$/.test(v);
const nat = (v:unknown):v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const obj = (v:unknown):v is Record<string,unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v:Record<string,unknown>,expected:string) => Object.keys(v).sort().join(",") === expected;
const hash = (v:unknown) => createHash("sha256").update(JSON.stringify(v),"utf8").digest("hex");
const key = (e:Entry) => JSON.stringify([e.source,e.originId,e.sourceId]);
const digestEntry = (e:Entry) => e.state === "deleted" ? hash([e.source,e.originId,e.sourceId,e.messageId,e.sequence,e.revision,e.state])
  : hash([e.source,e.originId,e.sourceId,e.messageId,e.sequence,e.revision,e.state,e.role,e.text,e.createdAt,e.mediaState]);
function valid(v:unknown):v is ContinuityConversationSnapshot {
  if(!obj(v) || !keys(v,"authEpoch,complete,conversationId,forgetEpoch,generation,items,oneId,revision,userId,version,workspaceId") ||
     v.version!==1 || v.complete!==true || !id(v.userId) || !id(v.workspaceId) || !id(v.oneId) || !id(v.conversationId) || !id(v.generation) ||
     !nat(v.authEpoch) || !nat(v.revision) || !nat(v.forgetEpoch) || !Array.isArray(v.items) || v.items.length>2048) return false;
  const seen=new Set<string>(),seq=new Set<number>(),messages=new Set<string>();
  for(const e of v.items) {
    if(!obj(e) || (e.source!=="companion" && e.source!=="desktop") || !id(e.originId) || !id(e.sourceId) || !id(e.messageId) ||
       !nat(e.sequence) || e.sequence===0 || !nat(e.revision) || e.revision>v.revision) return false;
    const k=JSON.stringify([e.source,e.originId,e.sourceId]);if(seen.has(k)||seq.has(e.sequence)||messages.has(e.messageId))return false;seen.add(k);seq.add(e.sequence);messages.add(e.messageId);
    if(e.state==="deleted") {if(!keys(e,"messageId,originId,revision,sequence,source,sourceId,state"))return false;continue;}
    if(e.state!=="active" || !keys(e,"createdAt,mediaState,messageId,originId,revision,role,sequence,source,sourceId,state,text") ||
       (e.role!=="user" && e.role!=="assistant") || e.mediaState!=="none" || typeof e.text!=="string" ||
       !e.text.trim() || e.text.length>8000 || Array.from(e.text).length>4000 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(e.text) ||
       typeof e.createdAt!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.createdAt) ||
       !Number.isFinite(Date.parse(e.createdAt)) || new Date(e.createdAt).toISOString()!==e.createdAt) return false;
  }
  return true;
}
function current(proof:ContinuityConversationProof) {
  const result=proof.assertCurrent() as unknown;
  if(result!==undefined) {if(result && typeof (result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});throw new Error("conversation_proof_not_synchronous");}
}
function snapshotDigest(s:ContinuityConversationSnapshot):string {
  const entries=[...s.items].sort((a,b)=>a.sequence-b.sequence);
  return hash([s.authEpoch,s.generation,s.revision,s.forgetEpoch,entries.map(digestEntry)]);
}
type Saved = {source:string;origin_id:string;source_id:string;message_id:string;sequence:number;source_revision:number;state:"active"|"deleted"|"local_delete";digest:string};

/** Transactional application of a complete proof-backed snapshot. */
export function createCompanionConversationJournal(options:{db:Database.Database;ownerNamespace:string;verify:ContinuityConversationVerifier}) {
  const {db,ownerNamespace,verify}=options;
  if(!id(ownerNamespace)||typeof verify!=="function")throw new TypeError("conversation_journal_config");
  return async(raw:unknown)=>{
    const fail=(reason:string)=>({status:"unavailable" as const,reason});
    if(!valid(raw))return fail("invalid_snapshot");
    const snapshot=JSON.parse(JSON.stringify(raw)) as ContinuityConversationSnapshot,bytes=JSON.stringify(snapshot);
    let proof:ContinuityConversationProof|null;
    try{proof=await verify(snapshot)}catch{return fail("authority_unavailable")}
    if(!valid(snapshot)||JSON.stringify(snapshot)!==bytes || !proof || proof.userId!==snapshot.userId || proof.workspaceId!==snapshot.workspaceId ||
       proof.authEpoch!==snapshot.authEpoch || proof.oneId!==snapshot.oneId || proof.conversationId!==snapshot.conversationId ||
       proof.generation!==snapshot.generation || proof.ownerNamespace!==ownerNamespace || typeof proof.assertCurrent!=="function")return fail("owner_mismatch");
    const scope=hash([ownerNamespace,snapshot.userId,snapshot.workspaceId,snapshot.oneId,snapshot.conversationId]),digest=snapshotDigest(snapshot);
    try{return db.transaction(()=>{
      current(proof!);
      db.exec(`CREATE TABLE IF NOT EXISTS one_companion_conversation_sources (
        scope_key TEXT PRIMARY KEY, auth_epoch INTEGER NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL,forget_epoch INTEGER NOT NULL,digest TEXT NOT NULL
      );CREATE TABLE IF NOT EXISTS one_companion_conversation_items (
        scope_key TEXT NOT NULL,source TEXT NOT NULL,origin_id TEXT NOT NULL,source_id TEXT NOT NULL,message_id TEXT NOT NULL,sequence INTEGER NOT NULL,
        source_revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','deleted','local_delete')),role TEXT,text TEXT,created_at TEXT,digest TEXT NOT NULL,
        PRIMARY KEY(scope_key,source,origin_id,source_id),UNIQUE(scope_key,message_id),UNIQUE(scope_key,sequence)
      )`);
      const source=db.prepare("SELECT auth_epoch,generation,revision,forget_epoch,digest FROM one_companion_conversation_sources WHERE scope_key=?").get(scope) as {auth_epoch:number;generation:string;revision:number;forget_epoch:number;digest:string}|undefined;
      if(source && (source.auth_epoch!==snapshot.authEpoch || source.generation!==snapshot.generation || source.revision>snapshot.revision ||
         source.forget_epoch>snapshot.forgetEpoch || (source.revision===snapshot.revision && source.digest!==digest)))throw new Error("conversation_revision_conflict");
      const rows=db.prepare("SELECT source,origin_id,source_id,message_id,sequence,source_revision,state,digest FROM one_companion_conversation_items WHERE scope_key=?").all(scope) as Saved[];
      const old=new Map(rows.map(row=>[JSON.stringify([row.source,row.origin_id,row.source_id]),row])),incoming=new Set(snapshot.items.map(key));
      if(rows.some(row=>!incoming.has(JSON.stringify([row.source,row.origin_id,row.source_id]))))throw new Error("conversation_lineage_missing");
      const upsert=db.prepare(`INSERT INTO one_companion_conversation_items(scope_key,source,origin_id,source_id,message_id,sequence,source_revision,state,role,text,created_at,digest)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,source,origin_id,source_id) DO UPDATE SET source_revision=excluded.source_revision,
        state=excluded.state,role=excluded.role,text=excluded.text,created_at=excluded.created_at,digest=excluded.digest`);
      for(const entry of snapshot.items) {
        const prior=old.get(key(entry)),itemDigest=digestEntry(entry);
        if(prior && (prior.message_id!==entry.messageId || prior.sequence!==entry.sequence || entry.revision<prior.source_revision ||
          (entry.revision===prior.source_revision && itemDigest!==prior.digest) || (prior.state==="deleted" && entry.state!=="deleted")))throw new Error("conversation_item_conflict");
        const state=prior?.state==="local_delete"?"local_delete":entry.state;
        upsert.run(scope,entry.source,entry.originId,entry.sourceId,entry.messageId,entry.sequence,entry.revision,state,
          state==="active"&&entry.state==="active"?entry.role:null,state==="active"&&entry.state==="active"?entry.text:null,
          state==="active"&&entry.state==="active"?entry.createdAt:null,itemDigest);
      }
      current(proof!);
      db.prepare(`INSERT INTO one_companion_conversation_sources(scope_key,auth_epoch,generation,revision,forget_epoch,digest) VALUES(?,?,?,?,?,?)
        ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,forget_epoch=excluded.forget_epoch,digest=excluded.digest`)
        .run(scope,snapshot.authEpoch,snapshot.generation,snapshot.revision,snapshot.forgetEpoch,digest);
      return {status:"stored" as const,revision:snapshot.revision,readEnabled:false as const};
    }).immediate()}catch{return fail("snapshot_not_applied")}
  };
}

/** Records a local delete without changing the independently owned source chat. */
export function createCompanionConversationLocalDelete(options:{db:Database.Database;ownerNamespace:string;verify:ContinuityConversationVerifier}) {
  const {db,ownerNamespace,verify}=options;
  if(!id(ownerNamespace)||typeof verify!=="function")throw new TypeError("conversation_journal_config");
  return async(raw:unknown,target:{source:Origin;originId:string;sourceId:string})=>{
    if(!valid(raw)||!target || (target.source!=="companion"&&target.source!=="desktop")||!id(target.originId)||!id(target.sourceId))return false;
    const fixedTarget={source:target.source,originId:target.originId,sourceId:target.sourceId};
    const snapshot=JSON.parse(JSON.stringify(raw)) as ContinuityConversationSnapshot,bytes=JSON.stringify(snapshot);
    let proof:ContinuityConversationProof|null;
    try{proof=await verify(snapshot)}catch{return false}
    if(!valid(snapshot)||JSON.stringify(snapshot)!==bytes || !proof || proof.userId!==snapshot.userId || proof.workspaceId!==snapshot.workspaceId ||
       proof.authEpoch!==snapshot.authEpoch || proof.oneId!==snapshot.oneId || proof.conversationId!==snapshot.conversationId ||
       proof.generation!==snapshot.generation || proof.ownerNamespace!==ownerNamespace || typeof proof.assertCurrent!=="function")return false;
    const scope=hash([ownerNamespace,snapshot.userId,snapshot.workspaceId,snapshot.oneId,snapshot.conversationId]),digest=snapshotDigest(snapshot);
    try{return db.transaction(()=>{
      current(proof!);
      const source=db.prepare("SELECT auth_epoch,generation,revision,forget_epoch,digest FROM one_companion_conversation_sources WHERE scope_key=?").get(scope) as {auth_epoch:number;generation:string;revision:number;forget_epoch:number;digest:string}|undefined;
      if(!source||source.auth_epoch!==snapshot.authEpoch||source.generation!==snapshot.generation||source.revision!==snapshot.revision||
         source.forget_epoch!==snapshot.forgetEpoch||source.digest!==digest)return false;
      const row=db.prepare("SELECT state FROM one_companion_conversation_items WHERE scope_key=? AND source=? AND origin_id=? AND source_id=?")
        .get(scope,fixedTarget.source,fixedTarget.originId,fixedTarget.sourceId) as {state:string}|undefined;
      if(!row||row.state==="deleted")return false;
      if(row.state==="local_delete")return true;
      const changed=db.prepare(`UPDATE one_companion_conversation_items SET state='local_delete',role=NULL,text=NULL,created_at=NULL
        WHERE scope_key=? AND source=? AND origin_id=? AND source_id=? AND state='active'`).run(scope,fixedTarget.source,fixedTarget.originId,fixedTarget.sourceId);
      current(proof!);return changed.changes===1;
    }).immediate()}catch{return false}
  };
}

/** Reads only an exactly current, fully verified snapshot; never creates a source chat. */
export function createCompanionConversationRead(options:{db:Database.Database;ownerNamespace:string;verify:ContinuityConversationVerifier}) {
  const {db,ownerNamespace,verify}=options;
  if(!id(ownerNamespace)||typeof verify!=="function")throw new TypeError("conversation_journal_config");
  return async(raw:unknown)=>{
    if(!valid(raw))return null;
    const snapshot=JSON.parse(JSON.stringify(raw)) as ContinuityConversationSnapshot,bytes=JSON.stringify(snapshot);
    let proof:ContinuityConversationProof|null;
    try{proof=await verify(snapshot)}catch{return null}
    if(!valid(snapshot)||JSON.stringify(snapshot)!==bytes || !proof || proof.userId!==snapshot.userId || proof.workspaceId!==snapshot.workspaceId ||
       proof.authEpoch!==snapshot.authEpoch || proof.oneId!==snapshot.oneId || proof.conversationId!==snapshot.conversationId ||
       proof.generation!==snapshot.generation || proof.ownerNamespace!==ownerNamespace || typeof proof.assertCurrent!=="function")return null;
    const scope=hash([ownerNamespace,snapshot.userId,snapshot.workspaceId,snapshot.oneId,snapshot.conversationId]),digest=snapshotDigest(snapshot);
    try{return db.transaction(()=>{
      current(proof!);
      const source=db.prepare("SELECT auth_epoch,generation,revision,forget_epoch,digest FROM one_companion_conversation_sources WHERE scope_key=?").get(scope) as {auth_epoch:number;generation:string;revision:number;forget_epoch:number;digest:string}|undefined;
      if(!source||source.auth_epoch!==snapshot.authEpoch||source.generation!==snapshot.generation||source.revision!==snapshot.revision||
         source.forget_epoch!==snapshot.forgetEpoch||source.digest!==digest)return null;
      const values=db.prepare(`SELECT message_id AS messageId,source,origin_id AS originId,source_id AS sourceId,sequence,role,text,created_at AS createdAt
        FROM one_companion_conversation_items WHERE scope_key=? AND state='active' ORDER BY sequence`).all(scope) as Array<{
          messageId:string;source:Origin;originId:string;sourceId:string;sequence:number;role:"user"|"assistant";text:string;createdAt:string}>;
      current(proof!);return {revision:snapshot.revision,messages:values};
    }).immediate()}catch{return null}
  };
}

type Operation = "apply" | "read" | "delete";
/** Actual Desktop owner adapter. No unverified or missing source can enable it. */
async function ownedConversationOperation(raw:unknown,verify:ContinuityConversationVerifier|undefined,operation:Operation,
    target?:{source:Origin;originId:string;sourceId:string}) {
  if(!verify||!valid(raw))return null;
  const fixedTarget=target ? {source:target.source,originId:target.originId,sourceId:target.sourceId} : undefined;
  const snapshot=JSON.parse(JSON.stringify(raw)) as ContinuityConversationSnapshot,bytes=JSON.stringify(snapshot);
  const auth=await import("../auth"),session=auth.getAuthenticatedSessionBinding();
  const sessionCurrent=()=>{const now=auth.getAuthenticatedSessionBinding();return !!session&&!!now&&now.userId===session.userId&&
    now.workspaceId===session.workspaceId&&now.sessionId===session.sessionId&&(now.expiresAt===null||now.expiresAt>Date.now());};
  if(!session||session.userId!==snapshot.userId||session.workspaceId!==snapshot.workspaceId||!sessionCurrent())return null;
  let proof:ContinuityConversationProof|null;
  try{proof=await verify(snapshot)}catch{return null}
  if(!proof||!sessionCurrent()||!valid(snapshot)||JSON.stringify(snapshot)!==bytes||proof.userId!==snapshot.userId||proof.workspaceId!==snapshot.workspaceId||
     proof.authEpoch!==snapshot.authEpoch||proof.oneId!==snapshot.oneId||proof.conversationId!==snapshot.conversationId||
     proof.generation!==snapshot.generation||typeof proof.assertCurrent!=="function")return null;
  const [profiles,memory,store]=await Promise.all([import("../store/one-profile"),import("../memory/database"),import("../store/db")]);
  if(!sessionCurrent())return null;
  try{
    const profile=profiles.peekOneProfile();
    if(profile.state!=="present"||profile.userId!==session.userId||profile.workspaceId!==session.workspaceId||profile.oneId!==snapshot.oneId)return null;
    const info=memory.getMemoryStoreInfo(),db=store.getDb();
    if(proof.ownerNamespace!==info.ownerNamespace||!sessionCurrent())return null;
    const row=db.prepare("SELECT chat_id FROM one_supervisor_conversations WHERE one_id=?").get(snapshot.oneId) as {chat_id:string}|undefined;
    if(!row?.chat_id)return null;
    const guarded=async()=>({...proof!,assertCurrent(){
      if(!sessionCurrent()||store.getDb()!==db)throw new Error("conversation_owner_changed");
      const now=profiles.peekOneProfile(),custody=memory.getMemoryStoreInfo();
      const currentRow=db.prepare("SELECT chat_id FROM one_supervisor_conversations WHERE one_id=?").get(snapshot.oneId) as {chat_id:string}|undefined;
      if(now.state!=="present"||now.userId!==profile.userId||now.workspaceId!==profile.workspaceId||now.oneId!==profile.oneId||
         now.revision!==profile.revision||custody.ownerNamespace!==info.ownerNamespace||custody.revocationEpoch!==info.revocationEpoch||currentRow?.chat_id!==row.chat_id)
        throw new Error("conversation_owner_changed");
      current(proof!);
    }});
    if(operation==="apply")return await createCompanionConversationJournal({db,ownerNamespace:info.ownerNamespace,verify:guarded})(snapshot);
    if(operation==="read")return await createCompanionConversationRead({db,ownerNamespace:info.ownerNamespace,verify:guarded})(snapshot);
    if(!fixedTarget)return null;
    return await createCompanionConversationLocalDelete({db,ownerNamespace:info.ownerNamespace,verify:guarded})(snapshot,fixedTarget);
  }catch{return null}
}
export function applyVerifiedCompanionConversation(raw:unknown,verify?:ContinuityConversationVerifier) {
  return ownedConversationOperation(raw,verify,"apply");
}
export function readVerifiedCompanionConversation(raw:unknown,verify?:ContinuityConversationVerifier) {
  return ownedConversationOperation(raw,verify,"read");
}
export function deleteVerifiedCompanionConversationItem(raw:unknown,target:{source:Origin;originId:string;sourceId:string},verify?:ContinuityConversationVerifier) {
  return ownedConversationOperation(raw,verify,"delete",target);
}
