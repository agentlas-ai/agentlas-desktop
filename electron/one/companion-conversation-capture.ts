/**
 * Optional Desktop source journal. SQLite triggers capture changes in the same
 * transaction as every writer, including older independent Terminal writers.
 * No startup route installs this until verified account binding and the server
 * conversation authority exist. Source records contain IDs only, never text.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
export type ConversationCaptureBinding = { userId:string; workspaceId:string; authEpoch:number; oneId:string; chatId:string;
  conversationId:string; generation:string; originId:string; ownerNamespace:string };
export type ConversationCaptureProof = ConversationCaptureBinding & { assertCurrent():void; mediaComplete?(messageId:string):boolean };
export type ConversationCaptureVerifier = (binding:ConversationCaptureBinding)=>Promise<ConversationCaptureProof|null>;
const id=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_.:@-]{1,200}$/.test(v);
const nat=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
function valid(v:unknown):v is ConversationCaptureBinding {
  return record(v)&&Object.keys(v).sort().join(",")==="authEpoch,chatId,conversationId,generation,oneId,originId,ownerNamespace,userId,workspaceId"&&
    [v.userId,v.workspaceId,v.oneId,v.chatId,v.conversationId,v.generation,v.originId,v.ownerNamespace].every(id)&&nat(v.authEpoch);
}
function normalized(b:ConversationCaptureBinding):ConversationCaptureBinding { return {userId:b.userId,workspaceId:b.workspaceId,authEpoch:b.authEpoch,
  oneId:b.oneId,chatId:b.chatId,conversationId:b.conversationId,generation:b.generation,originId:b.originId,ownerNamespace:b.ownerNamespace}; }
function same(a:ConversationCaptureBinding,b:ConversationCaptureBinding):boolean {
  return ["userId","workspaceId","authEpoch","oneId","chatId","conversationId","generation","originId","ownerNamespace"].every(k=>a[k as keyof ConversationCaptureBinding]===b[k as keyof ConversationCaptureBinding]);
}
function current(proof:ConversationCaptureProof):void {const r=proof.assertCurrent() as unknown;if(r!==undefined){
  if(r&&typeof(r as {then?:unknown}).then==="function")void Promise.resolve(r).catch(()=>{});throw new Error("capture_proof_not_synchronous");}}
function mediaComplete(proof:ConversationCaptureProof,messageId:string):boolean {
  if(typeof proof.mediaComplete!=="function")return false;
  const result=proof.mediaComplete(messageId) as unknown;
  if(result&&typeof(result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});
  return result===true;
}
const bindingKey=(b:ConversationCaptureBinding)=>createHash("sha256").update(JSON.stringify([b.ownerNamespace,b.userId,b.workspaceId,b.authEpoch,b.oneId,b.chatId,b.conversationId,b.generation,b.originId])).digest("hex");
const VISIBLE_OLD="OLD.role IN ('user','assistant') AND OLD.row_scope IS NOT 'view'";
const VISIBLE_NEW="NEW.role IN ('user','assistant') AND NEW.row_scope IS NOT 'view'";
const TRIGGERS=["one_companion_capture_insert","one_companion_capture_update","one_companion_capture_delete",
  ...["chat_message_attachments","chat_file_message_bindings"].flatMap(table=>["insert","update","delete"].map(op=>`one_companion_capture_${table}_${op}`))];
function triggerFingerprint(db:Database.Database):string {
  const rows=db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${TRIGGERS.map(()=>"?").join(",")}) ORDER BY name`).all(...TRIGGERS) as Array<{name:string;sql:string}>;
  if(rows.length!==TRIGGERS.length||rows.some(row=>!row.sql))throw new Error("capture_triggers_missing");
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function schemaVersion(db:Database.Database):number {return Number((db.prepare("PRAGMA schema_version").get() as {schema_version:number}).schema_version);}
function install(db:Database.Database):void {
  const bindingTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_companion_capture_bindings'").get();
  const active=bindingTable?Number((db.prepare("SELECT COUNT(*) AS n FROM one_companion_capture_bindings WHERE state='active'").get() as {n:number}).n):0;
  if(active>0){
    const guard=db.prepare("SELECT schema_version,trigger_digest FROM one_companion_capture_guard WHERE id=1").get() as {schema_version:number;trigger_digest:string}|undefined;
    if(!guard||guard.schema_version!==schemaVersion(db)||guard.trigger_digest!==triggerFingerprint(db))throw new Error("capture_integrity_changed");
    return;
  }
  const mediaTables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_message_attachments','chat_file_message_bindings')").all() as Array<{name:string}>;
  if(new Set(mediaTables.map(row=>row.name)).size!==2)throw new Error("capture_media_schema_unavailable");
  db.exec(`CREATE TABLE IF NOT EXISTS one_companion_capture_bindings(
    binding_key TEXT PRIMARY KEY,chat_id TEXT NOT NULL UNIQUE,binding_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','retired'))
  );CREATE TABLE IF NOT EXISTS one_companion_capture_events(
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,binding_key TEXT NOT NULL,message_id TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN ('upsert','deleted'))
  );CREATE INDEX IF NOT EXISTS one_companion_capture_by_binding ON one_companion_capture_events(binding_key,sequence);
  CREATE TRIGGER IF NOT EXISTS one_companion_capture_insert AFTER INSERT ON chat_messages WHEN ${VISIBLE_NEW} BEGIN
    INSERT INTO one_companion_capture_events(binding_key,message_id,operation)
      SELECT binding_key,NEW.id,'upsert' FROM one_companion_capture_bindings WHERE chat_id=NEW.chat_id AND state='active';
  END;
  CREATE TRIGGER IF NOT EXISTS one_companion_capture_update AFTER UPDATE OF id,chat_id,role,text,created_at,row_scope,host_notice_json,speaker_agent_id ON chat_messages BEGIN
    INSERT INTO one_companion_capture_events(binding_key,message_id,operation)
      SELECT binding_key,OLD.id,'deleted' FROM one_companion_capture_bindings WHERE chat_id=OLD.chat_id AND state='active' AND ${VISIBLE_OLD}
        AND (OLD.id<>NEW.id OR OLD.chat_id<>NEW.chat_id OR NOT (${VISIBLE_NEW}));
    INSERT INTO one_companion_capture_events(binding_key,message_id,operation)
      SELECT binding_key,NEW.id,'upsert' FROM one_companion_capture_bindings WHERE chat_id=NEW.chat_id AND state='active' AND ${VISIBLE_NEW};
  END;
  CREATE TRIGGER IF NOT EXISTS one_companion_capture_delete AFTER DELETE ON chat_messages WHEN ${VISIBLE_OLD} BEGIN
    INSERT INTO one_companion_capture_events(binding_key,message_id,operation)
      SELECT binding_key,OLD.id,'deleted' FROM one_companion_capture_bindings WHERE chat_id=OLD.chat_id AND state='active';
  END`);
  db.exec("CREATE TABLE IF NOT EXISTS one_companion_capture_guard(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,trigger_digest TEXT NOT NULL)");
  for(const table of ["chat_message_attachments","chat_file_message_bindings"]) {
    for(const operation of ["INSERT","UPDATE","DELETE"]) {
      const refs=operation==="UPDATE"?["OLD","NEW"]:[operation==="DELETE"?"OLD":"NEW"];
      const body=refs.map(ref=>`INSERT INTO one_companion_capture_events(binding_key,message_id,operation)
        SELECT b.binding_key,m.id,'upsert' FROM one_companion_capture_bindings b JOIN chat_messages m ON m.chat_id=b.chat_id
        WHERE b.state='active' AND m.chat_id=${ref}.chat_id AND m.id=${ref}.message_id AND m.role IN ('user','assistant') AND m.row_scope IS NOT 'view';`).join("\n");
      db.exec(`CREATE TRIGGER IF NOT EXISTS one_companion_capture_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN ${body} END`);
    }
  }
  const version=schemaVersion(db),digest=triggerFingerprint(db);
  db.prepare("INSERT INTO one_companion_capture_guard(id,schema_version,trigger_digest) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version,trigger_digest=excluded.trigger_digest").run(version,digest);
}
/** Register a verified chat and atomically capture its existing visible rows. */
export function createCompanionConversationCapture(options:{db:Database.Database;verify:ConversationCaptureVerifier}) {
  const {db,verify}=options;if(typeof verify!=="function")throw new TypeError("capture_config");
  return async(raw:unknown)=>{
    if(!valid(raw))return {status:"unavailable" as const};
    const b=normalized(JSON.parse(JSON.stringify(raw)) as ConversationCaptureBinding),bytes=JSON.stringify(b);
    let proof:ConversationCaptureProof|null;try{proof=await verify(b)}catch{return {status:"unavailable" as const}}
    if(!valid(b)||JSON.stringify(b)!==bytes||!proof||!same(proof,b)||typeof proof.assertCurrent!=="function")return {status:"unavailable" as const};
    try{return db.transaction(()=>{
      current(proof!);
      const chat=db.prepare("SELECT chat_id FROM one_supervisor_conversations WHERE one_id=? AND chat_id=?").get(b.oneId,b.chatId);
      if(!chat)throw new Error("capture_chat_mismatch");
      install(db);
      const key=bindingKey(b),stored=db.prepare("SELECT binding_key,binding_json,state FROM one_companion_capture_bindings WHERE chat_id=?").get(b.chatId) as {binding_key:string;binding_json:string;state:string}|undefined;
      if(stored){if(stored.binding_key!==key||stored.binding_json!==JSON.stringify(b)||stored.state!=="active")throw new Error("capture_binding_conflict");current(proof!);return {status:"existing" as const};}
      db.prepare("INSERT INTO one_companion_capture_bindings(binding_key,chat_id,binding_json,state) VALUES(?,?,?,'active')").run(key,b.chatId,JSON.stringify(b));
      // Existing history is kept as its own source. Server ordering/alias proof
      // must be established separately; it is not inferred from timestamps.
      db.prepare(`INSERT INTO one_companion_capture_events(binding_key,message_id,operation)
        SELECT ?,id,'upsert' FROM chat_messages WHERE chat_id=? AND role IN ('user','assistant') AND row_scope IS NOT 'view' ORDER BY created_at,rowid`).run(key,b.chatId);
      current(proof!);return {status:"registered" as const};
    }).immediate()}catch{return {status:"unavailable" as const}}
  };
}
/** Stop future event capture for this exact binding; existing events remain fenced. */
export function createCompanionConversationCaptureRetire(options:{db:Database.Database;verify:ConversationCaptureVerifier}) {
  const {db,verify}=options;if(typeof verify!=="function")throw new TypeError("capture_config");
  return async(raw:unknown)=>{
    if(!valid(raw))return false;const b=normalized(JSON.parse(JSON.stringify(raw)) as ConversationCaptureBinding),bytes=JSON.stringify(b);
    let proof:ConversationCaptureProof|null;try{proof=await verify(b)}catch{return false}
    if(!valid(b)||JSON.stringify(b)!==bytes||!proof||!same(proof,b)||typeof proof.assertCurrent!=="function")return false;
    try{return db.transaction(()=>{current(proof!);const key=bindingKey(b),row=db.prepare("SELECT binding_json,state FROM one_companion_capture_bindings WHERE binding_key=?").get(key) as {binding_json:string;state:string}|undefined;
      if(!row||row.binding_json!==JSON.stringify(b))return false;if(row.state==="retired")return true;
      const result=db.prepare("UPDATE one_companion_capture_bindings SET state='retired' WHERE binding_key=? AND state='active'").run(key);current(proof!);return result.changes===1;
    }).immediate()}catch{return false}
  };
}

/** Actual Desktop account/profile/host adapter; no production verifier is registered yet. */
async function ownedCaptureOperation(raw:unknown,options:{verify?:ConversationCaptureVerifier;originId:()=>string|null},operation:"install"|"retire"|"read") {
  if(!options?.verify||typeof options.originId!=="function"||!valid(raw))return null;
  const b=normalized(JSON.parse(JSON.stringify(raw)) as ConversationCaptureBinding),bytes=JSON.stringify(b),auth=await import("../auth");
  const session=auth.getAuthenticatedSessionBinding();
  const hostCurrent=()=>{try{const value=options.originId() as unknown;
    if(value&&typeof(value as {then?:unknown}).then==="function")void Promise.resolve(value).catch(()=>{});
    return value===b.originId;
  }catch{return false}};
  const sessionCurrent=()=>{const now=auth.getAuthenticatedSessionBinding();return !!session&&!!now&&now.userId===session.userId&&
    now.workspaceId===session.workspaceId&&now.sessionId===session.sessionId&&(now.expiresAt===null||now.expiresAt>Date.now());};
  if(!session||session.userId!==b.userId||session.workspaceId!==b.workspaceId||!sessionCurrent()||!hostCurrent())return null;
  let proof:ConversationCaptureProof|null;try{proof=await options.verify(b)}catch{return null}
  if(!proof||!valid(b)||JSON.stringify(b)!==bytes||!same(proof,b)||typeof proof.assertCurrent!=="function"||!sessionCurrent()||!hostCurrent())return null;
  const [profiles,memory,store]=await Promise.all([import("../store/one-profile"),import("../memory/database"),import("../store/db")]);
  if(!sessionCurrent())return null;
  try {
    const profile=profiles.peekOneProfile(),info=memory.getMemoryStoreInfo(),db=store.getDb();
    if(profile.state!=="present"||profile.userId!==session.userId||profile.workspaceId!==session.workspaceId||profile.oneId!==b.oneId||
       info.ownerNamespace!==b.ownerNamespace||!sessionCurrent()||!hostCurrent())return null;
    const guard=async()=>({...proof!,assertCurrent(){
      if(!sessionCurrent()||store.getDb()!==db||!hostCurrent())throw new Error("capture_owner_changed");
      const now=profiles.peekOneProfile(),custody=memory.getMemoryStoreInfo();
      if(now.state!=="present"||now.userId!==profile.userId||now.workspaceId!==profile.workspaceId||now.oneId!==profile.oneId||now.revision!==profile.revision||
         custody.ownerNamespace!==info.ownerNamespace||custody.revocationEpoch!==info.revocationEpoch)throw new Error("capture_owner_changed");
      current(proof!);
    }});
    if(operation==="retire")return await createCompanionConversationCaptureRetire({db,verify:guard})(b);
    if(operation==="read")return await createCompanionConversationCaptureRead({db,verify:guard})(b);
    return await createCompanionConversationCapture({db,verify:guard})(b);
  }catch{return null}
}
export function installVerifiedCompanionConversationCapture(raw:unknown,options:{verify?:ConversationCaptureVerifier;originId:()=>string|null}) {
  return ownedCaptureOperation(raw,options,"install");
}
export function retireVerifiedCompanionConversationCapture(raw:unknown,options:{verify?:ConversationCaptureVerifier;originId:()=>string|null}) {
  return ownedCaptureOperation(raw,options,"retire");
}

/**
 * Reads one locally consistent source generation, not a cross-device timeline.
 * Media or an unverifiable history gap stops the whole read; nothing is omitted.
 */
export function createCompanionConversationCaptureRead(options:{db:Database.Database;verify:ConversationCaptureVerifier}) {
  const {db,verify}=options;if(typeof verify!=="function")throw new TypeError("capture_config");
  return async(raw:unknown)=>{
    const unavailable=(reason:string)=>({status:"unavailable" as const,reason});
    if(!valid(raw))return unavailable("binding_invalid");
    const b=normalized(JSON.parse(JSON.stringify(raw)) as ConversationCaptureBinding),bytes=JSON.stringify(b);
    let proof:ConversationCaptureProof|null;try{proof=await verify(b)}catch{return unavailable("authority_unavailable")}
    if(!valid(b)||JSON.stringify(b)!==bytes||!proof||!same(proof,b)||typeof proof.assertCurrent!=="function")return unavailable("owner_mismatch");
    try{return db.transaction(()=>{
      current(proof!);const key=bindingKey(b);
      const binding=db.prepare("SELECT binding_json,state FROM one_companion_capture_bindings WHERE binding_key=? AND chat_id=?").get(key,b.chatId) as {binding_json:string;state:string}|undefined;
      if(!binding||binding.state!=="active"||binding.binding_json!==bytes)throw new Error("capture_binding_unavailable");
      // With an active binding install() only verifies the recorded schema and
      // trigger fingerprint; it never repairs a gap and calls it complete.
      install(db);
      const rows=db.prepare(`SELECT e.message_id,e.operation,e.sequence,
        (SELECT MIN(first.sequence) FROM one_companion_capture_events first WHERE first.binding_key=e.binding_key AND first.message_id=e.message_id) AS origin_order,
        EXISTS(SELECT 1 FROM one_companion_capture_events d WHERE d.binding_key=e.binding_key AND d.message_id=e.message_id AND d.operation='deleted' AND d.sequence<e.sequence) AS had_delete
        FROM one_companion_capture_events e WHERE e.binding_key=? AND e.sequence=(SELECT MAX(last.sequence) FROM one_companion_capture_events last
          WHERE last.binding_key=e.binding_key AND last.message_id=e.message_id) ORDER BY origin_order LIMIT 2049`).all(key) as Array<{
            message_id:string;operation:"upsert"|"deleted";sequence:number;origin_order:number;had_delete:number}>;
      if(rows.length>2048)return unavailable("source_too_large");
      const item=db.prepare("SELECT role,text,created_at,row_scope FROM chat_messages WHERE id=? AND chat_id=?");
      const media=db.prepare(`SELECT EXISTS(SELECT 1 FROM chat_message_attachments WHERE message_id=? AND chat_id=?) OR
        EXISTS(SELECT 1 FROM chat_file_message_bindings WHERE message_id=? AND chat_id=?) AS present`);
      let size=0;const items:Array<Record<string,unknown>>=[];
      for(const row of rows) {
        if(row.operation==="deleted") {items.push({sourceId:row.message_id,originOrder:row.origin_order,revision:row.sequence,state:"deleted"});continue;}
        if(row.had_delete)throw new Error("source_id_resurrection");
        const value=item.get(row.message_id,b.chatId) as {role:string;text:string;created_at:string;row_scope:string|null}|undefined;
        if(!value||!["user","assistant"].includes(value.role)||value.row_scope==="view"||typeof value.text!=="string"||
           typeof value.created_at!=="string")throw new Error("source_row_unavailable");
        // Old Desktop releases stored marker-only files without durable message
        // bindings. Missing attachment rows alone cannot prove a text-only turn.
        if((media.get(row.message_id,b.chatId,row.message_id,b.chatId) as {present:number}).present||
           !mediaComplete(proof!,row.message_id))return unavailable("media_unavailable");
        size+=Buffer.byteLength(value.text,"utf8");if(size>512*1024)return unavailable("source_too_large");
        items.push({sourceId:row.message_id,originOrder:row.origin_order,revision:row.sequence,state:"active",role:value.role,text:value.text,createdAt:value.created_at,mediaState:"none"});
      }
      const through=Number((db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM one_companion_capture_events WHERE binding_key=?").get(key) as {n:number}).n);
      current(proof!);return {status:"ready" as const,through,items};
    }).immediate()}catch{return unavailable("source_unavailable")}
  };
}

export function readVerifiedCompanionConversationCapture(raw:unknown,options:{verify?:ConversationCaptureVerifier;originId:()=>string|null}) {
  return ownedCaptureOperation(raw,options,"read");
}
