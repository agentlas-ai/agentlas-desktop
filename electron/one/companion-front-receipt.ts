import { createHash, verify, type KeyObject } from "node:crypto";
import type Database from "better-sqlite3";
import { COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";
import { companionFrontReceiptBytes, companionFrontFullChunkBytes } from "../../shared/companion-front-receipt";
import { supervisorExactResult } from "./supervisor-presentation";

type Identity={userId:string;workspaceId:string;authEpoch:number;accountSubject:string;deviceId:string;hostId:string;oneId:string};
type Permit={receipt:Record<string,unknown>;assertCurrent():void};
const permits=new WeakMap<object,Permit>();
type ChunkPermit={chunk:Record<string,unknown>;assertCurrent():void};
const chunkPermits=new WeakMap<object,ChunkPermit>();
export function takeCompanionFrontChunkPermit(capability:unknown):ChunkPermit|null {
  if(!capability||typeof capability!=="object")return null;const value=chunkPermits.get(capability);chunkPermits.delete(capability);
  if(!value)return null;try{value.assertCurrent();return value}catch{return null;}
}
export function takeCompanionFrontReceiptPermit(capability:unknown):Permit|null {
  if(!capability || typeof capability!=="object")return null;const value=permits.get(capability);permits.delete(capability);
  if(!value)return null;try{value.assertCurrent();return value}catch{return null;}
}
/** Reads the exact terminal run and its persisted assistant message. No text,
 * model or host may be supplied by the phone or inferred from a selection. */
export function createCompanionFrontReceiptOwner(options:{db:Database.Database;publicKey:KeyObject;identity():Identity|null;assertCurrent():void;
  nativeReceipt(runId:string):unknown;sign(capability:object):string;signChunk?(capability:object):string}) {
  const db=options.db;
  function read(commandId:string):{receipt:Record<string,unknown>;signature:string}|null {
    try {
      if(!/^[A-Za-z0-9_.:@-]{1,128}$/.test(commandId))return null;
      return db.transaction(()=>{
        options.assertCurrent();const identity=options.identity();if(!identity)return null;
        const row=db.prepare("SELECT * FROM one_companion_front_turns WHERE command_id=?").get(commandId) as
          {command_id:string;one_id:string;turn_id:string;payload_digest:string;run_id:string;chat_id:string;binding_json:string;state:string;terminal_receipt_json:string|null}|undefined;
        if(!row || row.state!=="terminal" || !row.terminal_receipt_json || row.one_id!==identity.oneId)return null;
        const binding=JSON.parse(row.binding_json) as Record<string,unknown>,stored=JSON.parse(row.terminal_receipt_json) as {runId?:unknown;chatId?:unknown;status?:unknown};
        if(binding.commandId!==commandId || binding.turnId!==row.turn_id || binding.payloadDigest!==row.payload_digest || binding.method!=="one.front-turn.send.v1" ||
          (["userId","workspaceId","authEpoch","accountSubject","deviceId","hostId","oneId"] as const).some(k=>binding[k]!==identity[k]))return null;
        const guard=()=>{options.assertCurrent();const current=options.identity();if(!current ||
          (["userId","workspaceId","authEpoch","accountSubject","deviceId","hostId","oneId"] as const).some(k=>current[k]!==identity[k]))throw new Error("companion_front_receipt_owner_changed");};
        const native=options.nativeReceipt(row.run_id) as {runId?:unknown;chatId?:unknown;status?:unknown;model?:unknown}|null;
        if(!native || native.runId!==row.run_id || native.chatId!==row.chat_id || stored.runId!==row.run_id || stored.chatId!==row.chat_id ||
          native.status!==stored.status || typeof native.status!=="string" || !["completed","failed","cancelled","interrupted"].includes(native.status))return null;
        db.exec(`CREATE TABLE IF NOT EXISTS one_companion_front_receipts (command_id TEXT PRIMARY KEY REFERENCES one_companion_front_turns(command_id) ON DELETE CASCADE,receipt_json TEXT NOT NULL,signature TEXT NOT NULL);
          CREATE TRIGGER IF NOT EXISTS one_companion_front_receipt_delete AFTER DELETE ON one_companion_front_turns BEGIN DELETE FROM one_companion_front_receipts WHERE command_id=OLD.command_id; END;`);
        const saved=db.prepare("SELECT receipt_json,signature FROM one_companion_front_receipts WHERE command_id=?").get(commandId) as {receipt_json:string;signature:string}|undefined;
        if(saved){const receipt=JSON.parse(saved.receipt_json) as Record<string,unknown>,other=receipt.binding as Record<string,unknown>;
          const bytes=companionFrontReceiptBytes(receipt),sig=Buffer.from(saved.signature,"base64url");
          if(!other || COMPANION_HANDOFF_PROOF_FIELDS.some(field=>other[field]!==binding[field]) || receipt.runId!==row.run_id || receipt.state!==native.status ||
            sig.length!==64 || sig.toString("base64url")!==saved.signature || !verify(null,bytes,options.publicKey,sig))return null;
          guard();return {receipt,signature:saved.signature};}
        let result="";
        if(native.status==="completed"){
          const exact=supervisorExactResult(db,row.chat_id,row.run_id);if(!exact || typeof exact.text!=="string")return null;
          // Mobile has no attachment delivery on this path yet. Keep the whole
          // result local rather than silently returning only the text.
          for(const table of ["chat_message_attachments","chat_file_message_bindings","chat_message_file_copies"]){
            if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
              db.prepare(`SELECT 1 FROM ${table} WHERE message_id=? LIMIT 1`).get(exact.id))return null;
          }
          if(/[\p{Cs}]/u.test(exact.text) || Buffer.byteLength(exact.text,"utf8")>6*1024*1024)return null;
          result=exact.text;
        }
        const owner=db.prepare("SELECT owner_kind FROM invocation_run_owners WHERE run_id=? AND chat_id=?").get(row.run_id,row.chat_id) as {owner_kind?:unknown}|undefined;
        const executionHost=owner && (owner.owner_kind==="desktop" || owner.owner_kind==="daemon" || owner.owner_kind==="terminal") ? owner.owner_kind : null;
        const executionModel=typeof native.model==="string" && native.model.trim() && native.model.length<=160 && !/[\p{Cs}\u0000-\u001f\u007f]/u.test(native.model) ? native.model : null;
        let receipt:Record<string,unknown>={binding,runId:row.run_id,state:native.status,result,resultDigest:createHash("sha256").update(result,"utf8").digest("hex"),executionModel,executionHost};
        if(native.status==="completed" && (Array.from(result).length>4_000 || result.length>8_000 || Buffer.byteLength(JSON.stringify({receipt,signature:"x".repeat(86)}),"utf8")>16*1024)) {
          const full=Buffer.from(result,"utf8"),preview=Array.from(result).slice(0,1000).join("");
          if(!preview.trim()||!options.signChunk)return null;
          receipt={...receipt,result:preview,resultDigest:createHash("sha256").update(preview,"utf8").digest("hex"),fullResultPending:true,
            fullDigest:createHash("sha256").update(full).digest("hex"),fullBytes:full.length,fullCount:Math.ceil(full.length/8192)};
        }
        companionFrontReceiptBytes(receipt);
        // The currently deployed Companion endpoint bounds the entire JSON
        // body, including escaping, binding and a 64-byte Ed25519 signature.
        if(Buffer.byteLength(JSON.stringify({receipt,signature:"x".repeat(86)}),"utf8")>16*1024)return null;
        guard();const capability=Object.freeze({});permits.set(capability,{receipt:structuredClone(receipt),assertCurrent:guard});
        const signature=options.sign(capability),sig=Buffer.from(signature,"base64url");
        if(sig.length!==64 || sig.toString("base64url")!==signature || !verify(null,companionFrontReceiptBytes(receipt),options.publicKey,sig))return null;
        guard();db.prepare("INSERT INTO one_companion_front_receipts(command_id,receipt_json,signature) VALUES(?,?,?)").run(commandId,JSON.stringify(receipt),signature);
        return {receipt,signature};
      }).immediate();
    }catch{return null;}
  }
  function readFullChunk(commandId:string,index:number):{chunk:Record<string,unknown>;signature:string}|null {
    if(!Number.isSafeInteger(index)||index<0||!options.signChunk)return null;
    const saved=read(commandId);if(!saved||saved.receipt.fullResultPending!==true)return null;
    try{return db.transaction(()=>{
      options.assertCurrent();const receipt=saved.receipt,b=receipt.binding as Record<string,unknown>;
      const row=db.prepare("SELECT run_id,chat_id,binding_json,state FROM one_companion_front_turns WHERE command_id=?").get(commandId) as
        {run_id:string;chat_id:string;binding_json:string;state:string}|undefined;
      if(!row||row.state!=="terminal"||row.run_id!==receipt.runId||row.binding_json!==JSON.stringify(b))return null;
      const exact=supervisorExactResult(db,row.chat_id,row.run_id);if(!exact||typeof exact.text!=="string"||/[\p{Cs}]/u.test(exact.text))return null;
      const bytes=Buffer.from(exact.text,"utf8"),digest=createHash("sha256").update(bytes).digest("hex"),count=Math.ceil(bytes.length/8192);
      if(digest!==receipt.fullDigest||bytes.length!==receipt.fullBytes||count!==receipt.fullCount||index>=count||!exact.text.startsWith(String(receipt.result)))return null;
      const part=bytes.subarray(index*8192,Math.min((index+1)*8192,bytes.length));
      const chunk={userId:b.userId,workspaceId:b.workspaceId,authEpoch:b.authEpoch,accountSubject:b.accountSubject,familyId:b.familyId,deviceId:b.deviceId,
        hostId:b.hostId,oneId:b.oneId,turnId:b.turnId,commandId:b.commandId,payloadDigest:b.payloadDigest,resultDigest:receipt.resultDigest,
        fullDigest:digest,totalBytes:bytes.length,index,count,chunkDigest:createHash("sha256").update(part).digest("hex"),data:part.toString("base64url")};
      companionFrontFullChunkBytes(chunk);
      const guard=()=>{options.assertCurrent();const identity=options.identity();if(!identity||
        (["userId","workspaceId","authEpoch","accountSubject","deviceId","hostId","oneId"] as const).some(k=>identity[k]!==b[k]))throw new Error("companion_front_chunk_owner_changed");
        const live=supervisorExactResult(db,row.chat_id,row.run_id);if(!live||live.id!==exact.id||live.text!==exact.text)throw new Error("companion_front_chunk_result_changed");};
      guard();const capability=Object.freeze({});chunkPermits.set(capability,{chunk:structuredClone(chunk),assertCurrent:guard});
      const signature=options.signChunk!(capability),sig=Buffer.from(signature,"base64url");
      if(sig.length!==64||sig.toString("base64url")!==signature||!verify(null,companionFrontFullChunkBytes(chunk),options.publicKey,sig))return null;
      guard();return {chunk,signature};
    }).immediate()}catch{return null;}
  }
  return Object.freeze({read,readFullChunk});
}
