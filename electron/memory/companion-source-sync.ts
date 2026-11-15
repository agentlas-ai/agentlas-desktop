/**
 * Disabled Companion source import boundary. A caller must supply a real,
 * account-bound source verifier; no route or production verifier is installed.
 * Imported model-generated summaries remain disabled for recall until provenance
 * and live deletion fencing have their own verified product contract.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getAuthenticatedSessionBinding } from "../auth";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
import { looksSecret } from "../../shared/secret-patterns";
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import { insertMemoryEntry, type NewMemoryEntry } from "./store";
import { revokeOneMemoryEntry } from "./revocations";

type Item = { id:string; kind:"identity"|"preference"|"fact"|"boundary"; text:string };
export type CompanionSourceSnapshot = { version:1; complete:true; userId:string; workspaceId:string; generation:string; revision:number; items:Item[] };
export type VerifiedCompanionSource = { userId:string; workspaceId:string; generation:string; assertCurrent():void };
export type CompanionSnapshotVerifier = (snapshot:CompanionSourceSnapshot)=>Promise<VerifiedCompanionSource|null>;
type Entry = { id:string };
type Revoked = { sourceMemoryIds:string[] } | null;
type Ports = { db:Database.Database; ownerNamespace:string; insert:(entry:NewMemoryEntry)=>Entry; revoke:(id:string)=>Revoked };
type Mapping = { source_id:string; memory_id:string; digest:string; state:"active"|"removed"|"local_forget" };
const idOk=(s:unknown):s is string=>typeof s==="string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(s);
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value),"utf8").digest("hex");
const unavailable=(reason:string)=>({status:"unavailable" as const,reason});
// The currently defined wire version has no durable deletion evidence.
function hasDurableLineage(_snapshot:CompanionSourceSnapshot):boolean { return false; }
function assertSynchronous(proof:VerifiedCompanionSource):void {
  const result=proof.assertCurrent() as unknown;
  if(result!==undefined) {
    if(result && typeof (result as {then?:unknown}).then==='function') void Promise.resolve(result).catch(()=>{});
    throw new Error("companion_authority_not_synchronous");
  }
}

/** Version 1 has no lineage or explicit deletion evidence. */
function valid(snapshot:unknown):snapshot is CompanionSourceSnapshot {
  if(!snapshot || typeof snapshot!=="object" || Array.isArray(snapshot)) return false;
  const s=snapshot as CompanionSourceSnapshot;
  if(Object.keys(s).sort().join(",")!=="complete,generation,items,revision,userId,version,workspaceId") return false;
  if(s.version!==1 || s.complete!==true || !idOk(s.userId) || !idOk(s.workspaceId) || !idOk(s.generation)
    || !Number.isSafeInteger(s.revision) || s.revision<0 || !Array.isArray(s.items) || s.items.length>40) return false;
  const seen=new Set<string>();
  for(const item of s.items) {
    if(!item || typeof item!=="object" || Object.keys(item).sort().join(",")!=="id,kind,text" || !/^f_[A-Za-z0-9_-]{6,24}$/.test(item.id) || seen.has(item.id)
      || !["identity","preference","fact","boundary"].includes(item.kind) || typeof item.text!=="string"
      || !item.text.trim() || Array.from(item.text).length>200 || /[\u0000-\u001f\u007f]/u.test(item.text) || looksSecret(item.text)) return false;
    seen.add(item.id);
  }
  return true;
}

/**
 * The verifier must authenticate the authoritative complete snapshot and bind
 * it to the current owner and workspace. This is an internal port, not evidence
 * by itself; production supplies no verifier or caller today.
 */
export function createCompanionSourceSync(ports:Ports, verify?:CompanionSnapshotVerifier) {
  return async (snapshot:unknown) => {
    if(!verify || !valid(snapshot)) return unavailable("source_unavailable");
    // v1 omits persistent lineage tombstones. Even the first import could
    // resurrect a previously forgotten fact after source history expires.
    // Keep this adapter closed until a tombstone-bearing protocol exists.
    if(!hasDurableLineage(snapshot)) return unavailable("lineage_contract_required");
    /* The guarded implementation below is retained for a future protocol
       migration; it must not be enabled for a v1 projection. */
    let proof:VerifiedCompanionSource|null;
    try { proof=await verify(snapshot); } catch { return unavailable("source_unavailable"); }
    if(!proof || proof.userId!==snapshot.userId || proof.workspaceId!==snapshot.workspaceId || proof.generation!==snapshot.generation
      || typeof proof.assertCurrent!=="function") return unavailable("identity_unverified");
    const scope=digest([ports.ownerNamespace,snapshot.userId,snapshot.workspaceId]);
    const ordered=[...snapshot.items].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    const snapshotDigest=digest(ordered.map(({id,kind,text})=>[id,kind,text]));
    try {
      return ports.db.transaction(()=>{
        assertSynchronous(proof!);
        ports.db.exec(`CREATE TABLE IF NOT EXISTS memory_companion_sources (
          scope_key TEXT PRIMARY KEY, generation TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL
        ); CREATE TABLE IF NOT EXISTS memory_companion_entries (
          scope_key TEXT NOT NULL, source_id TEXT NOT NULL, memory_id TEXT NOT NULL, digest TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('active','removed','local_forget')), PRIMARY KEY(scope_key,source_id), UNIQUE(memory_id)
        );`);
        const source=ports.db.prepare("SELECT generation,revision,digest FROM memory_companion_sources WHERE scope_key=?").get(scope) as {generation:string;revision:number;digest:string}|undefined;
        if(source && source.generation!==snapshot.generation) return unavailable("source_generation_changed");
        if(source && snapshot.revision<source.revision) return unavailable("stale_snapshot");
        if(source && snapshot.revision===source.revision && source.digest!==snapshotDigest) return unavailable("revision_conflict");
        const entries=ports.db.prepare("SELECT source_id,memory_id,digest,state FROM memory_companion_entries WHERE scope_key=?").all(scope) as Mapping[];
        const existing=new Map(entries.map(row=>[row.source_id,row]));
        const incoming=new Set(ordered.map(item=>item.id));
        // A changed fact gets a new ID but retains its lineage. A missing ID
        // could therefore mean correction, deletion, expiry, or incomplete
        // authority data. The v1 projection cannot distinguish these cases.
        // Refuse the whole snapshot before creating or revoking any entry.
        if(entries.some(row=>row.state==="active" && !incoming.has(row.source_id)))
          throw new Error("companion_lineage_transition_unavailable");
        for(const item of ordered) {
          const prior=existing.get(item.id), itemDigest=digest([item.kind,item.text]);
          if(prior && prior.digest!==itemDigest) throw new Error("companion_source_changed");
          if(prior && prior.state==="removed") throw new Error("companion_source_resurrected");
          if(prior) {
            const live=ports.db.prepare("SELECT superseded_at,content FROM memory_entries WHERE id=?").get(prior.memory_id) as {superseded_at:string|null;content:string}|undefined;
            if(prior.state==="active" && (!live || live.superseded_at!==null || !live.content)) {
              ports.db.prepare("UPDATE memory_companion_entries SET state='local_forget' WHERE scope_key=? AND source_id=? AND state='active'").run(scope,item.id);
            }
            continue;
          }
          const inserted=ports.insert({scope:"agent_repo",kind:"hypothesis",content:item.text,agentId:BUILTIN_ONE_AGENT_ID,
            sensitivity:"private",enabled:false,originRefs:[{kind:"source",id:`companion:${scope}:${item.id}`,revision:String(snapshot.revision)}]});
          if(!inserted || typeof inserted.id!=="string" || !inserted.id) throw new Error("companion_insert_unconfirmed");
          ports.db.prepare("INSERT INTO memory_companion_entries(scope_key,source_id,memory_id,digest,state) VALUES(?,?,?,?,'active')").run(scope,item.id,inserted.id,itemDigest);
        }
        assertSynchronous(proof!);
        ports.db.prepare(`INSERT INTO memory_companion_sources(scope_key,generation,revision,digest) VALUES(?,?,?,?)
          ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,digest=excluded.digest`).run(scope,snapshot.generation,snapshot.revision,snapshotDigest);
        return {status:"stored" as const,revision:snapshot.revision,recallEnabled:false as const};
      }).immediate();
    } catch { return unavailable("snapshot_not_applied"); }
  };
}

/** No verifier means no memory DB is opened and no import takes place. */
export async function syncCompanionSourceSnapshot(snapshot:unknown, verify?:CompanionSnapshotVerifier) {
  if(!verify || !valid(snapshot)) return unavailable("source_unavailable");
  if(!hasDurableLineage(snapshot)) return unavailable("lineage_contract_required");
  const session=getAuthenticatedSessionBinding();
  if(!session || session.userId!==snapshot.userId || session.workspaceId!==snapshot.workspaceId
    || (session.expiresAt!==null && session.expiresAt<=Date.now())) return unavailable("identity_unverified");
  let proof:VerifiedCompanionSource|null;
  try { proof=await verify(snapshot); } catch { return unavailable("source_unavailable"); }
  if(!proof || proof.userId!==snapshot.userId || proof.workspaceId!==snapshot.workspaceId || proof.generation!==snapshot.generation
    || typeof proof.assertCurrent!=="function") return unavailable("identity_unverified");
  const afterVerification=getAuthenticatedSessionBinding();
  if(!afterVerification || afterVerification.userId!==session.userId || afterVerification.workspaceId!==session.workspaceId
    || afterVerification.sessionId!==session.sessionId || (afterVerification.expiresAt!==null && afterVerification.expiresAt<=Date.now()))
    return unavailable("identity_unverified");
  const db=getMemoryDb(), info=getMemoryStoreInfo();
  return createCompanionSourceSync({db,ownerNamespace:info.ownerNamespace,insert:insertMemoryEntry,
    // K7'' (audit D12): this door does not go through `forgetOwnedMemory` on purpose. The forget here is the SERVER's own (the snapshot says the card is gone there): `forgetOwnedMemory` would tell the mirror to send a `gone` for the line back to
    // the server that just said it, and its fences (`assertTarget`: the owner's screen revision and epoch) belong to a person's click, not to a sync. What a forget needs beyond the stamp is done inside `revokeOneMemoryEntry` itself
    // (stamp, same words of the same owner, turn records, other stores and indexes, the older versions, the project-file and agent-nest cleanup outbox - queued and retried); the immediate project-file/derived-skill report is the screen's.
    revoke:id=>revokeOneMemoryEntry(id,BUILTIN_ONE_AGENT_ID)},async ()=>{
      return {...proof!,assertCurrent(){
        const current=getAuthenticatedSessionBinding();
        if(!current || current.userId!==session.userId || current.workspaceId!==session.workspaceId || current.sessionId!==session.sessionId
          || (current.expiresAt!==null && current.expiresAt<=Date.now()) || getMemoryDb()!==db || getMemoryStoreInfo().ownerNamespace!==info.ownerNamespace) throw new Error("companion_owner_changed");
        assertSynchronous(proof!);
      }};
    })(snapshot);
}
