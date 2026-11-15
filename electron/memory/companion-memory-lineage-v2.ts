/** Isolated mirror for an authenticated, complete lineage-v2 envelope. No
 * production verifier, migration or recall consumer is registered here. */
import {createHash} from "node:crypto";
import type Database from "better-sqlite3";
import {looksSecret} from "../../shared/secret-patterns";

type Active={id:string;lineageId:string;revision:number;state:"active";kind:"identity"|"preference"|"fact";text:string};
type Deleted={id:string;lineageId:string;revision:number;state:"deleted";reason?:"superseded"|"forgotten"};
type Item=Active|Deleted;
export type LineageV2Snapshot={schema:"agentlas.one-memory-lineage.v2";complete:true;userId:string;workspaceId:string;generation:string;revision:number;forgetEpoch:number;aliases:Record<string,string>;items:Item[]};
export type LineageV2Proof={userId:string;workspaceId:string;generation:string;ownerNamespace:string;assertCurrent():void};
export type LineageV2Verifier=(snapshot:LineageV2Snapshot)=>Promise<LineageV2Proof|null>;
type Prior={source_id:string;lineage_id:string;source_revision:number;source_state:"active"|"deleted";reason:string|null;digest:string;visible_state:string};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const hash=(x:unknown)=>createHash("sha256").update(JSON.stringify(x),"utf8").digest("hex");
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
const exact=(x:Record<string,unknown>,names:string[])=>Object.keys(x).sort().join(",")===[...names].sort().join(",");
const id=(x:unknown)=>typeof x==="string"&&/^[A-Za-z0-9_.:@-]{1,128}$/.test(x);
const lineage=(x:unknown):x is string=>typeof x==="string"&&/^ml_[A-Za-z0-9_-]{22}$/.test(x);
const nat=(x:unknown):x is number=>Number.isSafeInteger(x)&&(x as number)>=0&&(x as number)<Number.MAX_SAFE_INTEGER;
const itemDigest=(x:Item)=>hash(x.state==="active"?[x.id,x.lineageId,x.revision,x.state,x.kind,x.text]:[x.id,x.lineageId,x.revision,x.state,x.reason??null]);
function check(raw:unknown):{snapshot:LineageV2Snapshot;roots:Map<string,string>}|null {
  if(!object(raw)||!exact(raw,["schema","complete","userId","workspaceId","generation","revision","forgetEpoch","aliases","items"])||
    raw.schema!=="agentlas.one-memory-lineage.v2"||raw.complete!==true||!id(raw.userId)||!id(raw.workspaceId)||!id(raw.generation)||
    !nat(raw.revision)||!nat(raw.forgetEpoch)||!object(raw.aliases)||Object.keys(raw.aliases).length>4096||!Array.isArray(raw.items)||raw.items.length>4096)return null;
  const ids=new Set<string>(),lineages=new Set<string>();
  for(const item of raw.items){
    if(!object(item)||typeof item.id!=="string"||!/^f_[A-Za-z0-9_-]{11}$/.test(item.id)||ids.has(item.id)||!lineage(item.lineageId)||
      !nat(item.revision)||item.revision<1||item.revision>raw.revision)return null;
    ids.add(item.id);lineages.add(item.lineageId);
    if(item.state==="active"){
      if(!exact(item,["id","lineageId","revision","state","kind","text"])||!['identity','preference','fact'].includes(String(item.kind))||
        typeof item.text!=="string"||!item.text.trim()||Array.from(item.text).length>200||/[\p{Cs}\u0000-\u001f\u007f]/u.test(item.text)||looksSecret(item.text))return null;
    }else if(item.state==="deleted"){
      if(!(exact(item,["id","lineageId","revision","state"])||exact(item,["id","lineageId","revision","state","reason"]))||
        !(item.reason===undefined||item.reason==="superseded"||item.reason==="forgotten"))return null;
    }else return null;
  }
  for(const [from,to] of Object.entries(raw.aliases))if(!lineage(from)||!lineage(to)||from===to||!lineages.has(from)||!lineages.has(to))return null;
  const roots=new Map<string,string>();
  for(const start of lineages){let at=start;const seen=new Set<string>(),path:string[]=[];
    while(!roots.has(at)&&Object.hasOwn(raw.aliases,at)){if(seen.has(at))return null;seen.add(at);path.push(at);at=raw.aliases[at] as string;}
    const root=roots.get(at)??at;roots.set(at,root);for(const entry of path)roots.set(entry,root);
  }
  const active=new Set<string>(),forgotten=new Set<string>();
  for(const item of raw.items as Item[]){const root=roots.get(item.lineageId)!;if(item.state==="active"){if(active.has(root))return null;active.add(root);}
    else if(item.reason!=="superseded")forgotten.add(root);}
  if([...active].some(root=>forgotten.has(root)))return null;
  return {snapshot:raw as LineageV2Snapshot,roots};
}
/** Canonical server-shared snapshot digest; validation rejects cyclic and
 * incomplete lineage before any server-signed value can be compared. */
export function companionLineageV2SnapshotDigest(value:unknown):string|null {
  const parsed=check(value);if(!parsed)return null;const s=parsed.snapshot;
  const aliases=Object.entries(s.aliases).sort(([a],[b])=>compare(a,b));
  const items=[...s.items].sort((a,b)=>compare(a.id,b.id)).map(item=>[item.id,item.lineageId,item.revision,item.state,
    item.state==="active"?item.kind:null,item.state==="active"?item.text:null,item.state==="deleted"?item.reason??null:null]);
  return hash([s.schema,s.userId,s.workspaceId,s.generation,s.revision,s.forgetEpoch,aliases,items]);
}
function current(proof:LineageV2Proof){const v=proof.assertCurrent() as unknown;if(v!==undefined){if(v&&typeof(v as {then?:unknown}).then==="function")void Promise.resolve(v).catch(()=>{});throw Error("lineage_proof_not_synchronous");}}
function snapshotDigest(s:LineageV2Snapshot){return hash([s.generation,s.revision,s.forgetEpoch,Object.entries(s.aliases).sort(([a],[b])=>compare(a,b)),[...s.items].sort((a,b)=>compare(a.id,b.id)).map(itemDigest)]);}
function freezeTree(value:unknown):void {
  if(!value||typeof value!=="object"||Object.isFrozen(value))return;
  for(const child of Object.values(value))freezeTree(child);
  Object.freeze(value);
}
async function authorize(raw:unknown,ownerNamespace:string,verify:LineageV2Verifier){
  if(!check(raw))return null;const snapshot=JSON.parse(JSON.stringify(raw)) as LineageV2Snapshot,bytes=JSON.stringify(snapshot);freezeTree(snapshot);
  let proof:LineageV2Proof|null;try{proof=await verify(snapshot)}catch{return null;}
  const parsed=check(snapshot);if(!parsed||JSON.stringify(snapshot)!==bytes||!proof||proof.userId!==snapshot.userId||proof.workspaceId!==snapshot.workspaceId||
    proof.generation!==snapshot.generation||proof.ownerNamespace!==ownerNamespace||typeof proof.assertCurrent!=="function")return null;
  return {snapshot,roots:parsed.roots,proof,scope:hash([ownerNamespace,snapshot.userId,snapshot.workspaceId]),digest:snapshotDigest(snapshot)};
}
/** Keeps its own schema: old snapshots and legacy mirrors cannot be silently
 * upgraded, and local forgetting follows alias merges without restoring text. */
export function createCompanionMemoryLineageV2(input:{db:Database.Database;ownerNamespace:string;verify:LineageV2Verifier}){
  const {db,ownerNamespace,verify}=input;if(!id(ownerNamespace)||typeof verify!=="function")throw TypeError("lineage_sync_config");
  async function apply(raw:unknown){
    const a=await authorize(raw,ownerNamespace,verify);if(!a)return {status:"unavailable" as const,reason:"authority_or_snapshot_invalid"};
    try{return db.transaction(()=>{
      current(a.proof);
      const legacy=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_companion_v2_sources'").get();
      if(legacy&&db.prepare("SELECT 1 FROM memory_companion_v2_sources WHERE scope_key=?").get(a.scope))throw Error("legacy_migration_required");
      db.exec(`CREATE TABLE IF NOT EXISTS memory_companion_lineage_v2_sources(scope_key TEXT PRIMARY KEY,generation TEXT NOT NULL,revision INTEGER NOT NULL,forget_epoch INTEGER NOT NULL,digest TEXT NOT NULL,aliases_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_companion_lineage_v2_items(scope_key TEXT NOT NULL,source_id TEXT NOT NULL,lineage_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_state TEXT NOT NULL,reason TEXT,digest TEXT NOT NULL,visible_state TEXT NOT NULL,kind TEXT,text TEXT,PRIMARY KEY(scope_key,source_id));
        CREATE TABLE IF NOT EXISTS memory_companion_lineage_v2_forget(scope_key TEXT NOT NULL,lineage_id TEXT NOT NULL,PRIMARY KEY(scope_key,lineage_id));
        CREATE TABLE IF NOT EXISTS memory_companion_lineage_v2_forget_outbox(scope_key TEXT NOT NULL,generation TEXT NOT NULL,lineage_id TEXT NOT NULL,source_id TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state='pending'),PRIMARY KEY(scope_key,generation,lineage_id));`);
      const previous=db.prepare("SELECT generation,revision,forget_epoch,digest,aliases_json FROM memory_companion_lineage_v2_sources WHERE scope_key=?").get(a.scope) as {generation:string;revision:number;forget_epoch:number;digest:string;aliases_json:string}|undefined;
      if(previous&&(previous.generation!==a.snapshot.generation||a.snapshot.revision<previous.revision||a.snapshot.forgetEpoch<previous.forget_epoch||
        previous.revision===a.snapshot.revision&&previous.digest!==a.digest))throw Error("source_revision_conflict");
      const oldAliases=previous?JSON.parse(previous.aliases_json) as Record<string,string>:{};
      if(Object.entries(oldAliases).some(([from,to])=>a.snapshot.aliases[from]!==to))throw Error("alias_history_changed");
      if(previous&&Object.keys(a.snapshot.aliases).length>Object.keys(oldAliases).length&&a.snapshot.forgetEpoch<=previous.forget_epoch)throw Error("alias_epoch_conflict");
      const rows=db.prepare("SELECT source_id,lineage_id,source_revision,source_state,reason,digest,visible_state FROM memory_companion_lineage_v2_items WHERE scope_key=?").all(a.scope) as Prior[];
      const old=new Map(rows.map(row=>[row.source_id,row])),incoming=new Set(a.snapshot.items.map(item=>item.id));
      if(rows.some(row=>!incoming.has(row.source_id)))throw Error("missing_lineage");
      const marks=db.prepare("SELECT lineage_id FROM memory_companion_lineage_v2_forget WHERE scope_key=?").all(a.scope) as {lineage_id:string}[];
      const hiddenRoots=new Set(marks.map(mark=>a.roots.get(mark.lineage_id)));if(hiddenRoots.has(undefined))throw Error("missing_local_forget_lineage");
      const put=db.prepare(`INSERT INTO memory_companion_lineage_v2_items(scope_key,source_id,lineage_id,source_revision,source_state,reason,digest,visible_state,kind,text) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scope_key,source_id) DO UPDATE SET source_revision=excluded.source_revision,source_state=excluded.source_state,reason=excluded.reason,digest=excluded.digest,visible_state=excluded.visible_state,kind=excluded.kind,text=excluded.text`);
      for(const item of a.snapshot.items){const prior=old.get(item.id),digest=itemDigest(item);
        if(prior&&(prior.lineage_id!==item.lineageId||item.revision<prior.source_revision||item.revision===prior.source_revision&&prior.digest!==digest||
          prior.source_state==="deleted"&&item.state!=="deleted"||prior.source_state==="deleted"&&prior.reason!=="superseded"&&item.state==="deleted"&&item.reason==="superseded"||
          prior.source_state==="active"&&item.state==="active"&&prior.digest!==digest))throw Error("item_revision_conflict");
        if(previous&&prior&&prior.source_state==="active"&&item.state==="deleted"&&a.snapshot.forgetEpoch<=previous.forget_epoch)throw Error("forget_epoch_conflict");
        const hidden=hiddenRoots.has(a.roots.get(item.lineageId));const state=hidden?"local_forget":item.state;
        put.run(a.scope,item.id,item.lineageId,item.revision,item.state,item.state==="deleted"?item.reason??null:null,digest,state,state==="active"&&item.state==="active"?item.kind:null,state==="active"&&item.state==="active"?item.text:null);
      }
      current(a.proof);db.prepare(`INSERT INTO memory_companion_lineage_v2_sources(scope_key,generation,revision,forget_epoch,digest,aliases_json) VALUES(?,?,?,?,?,?)
        ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,forget_epoch=excluded.forget_epoch,digest=excluded.digest,aliases_json=excluded.aliases_json`)
        .run(a.scope,a.snapshot.generation,a.snapshot.revision,a.snapshot.forgetEpoch,a.digest,JSON.stringify(a.snapshot.aliases));
      return {status:"stored" as const,revision:a.snapshot.revision,recallEnabled:false as const};
    }).immediate()}catch{return {status:"unavailable" as const,reason:"snapshot_not_applied"};}
  }
  async function forget(raw:unknown,sourceId:string){
    const a=await authorize(raw,ownerNamespace,verify);if(!a||typeof sourceId!=="string")return false;
    try{return db.transaction(()=>{current(a.proof);
      const source=db.prepare("SELECT generation,revision,forget_epoch,digest FROM memory_companion_lineage_v2_sources WHERE scope_key=?").get(a.scope) as {generation:string;revision:number;forget_epoch:number;digest:string}|undefined;
      if(!source||source.generation!==a.snapshot.generation||source.revision!==a.snapshot.revision||source.forget_epoch!==a.snapshot.forgetEpoch||source.digest!==a.digest)return false;
      const item=a.snapshot.items.find(row=>row.id===sourceId);if(!item)return false;const root=a.roots.get(item.lineageId);if(!root)return false;
      db.prepare("INSERT OR IGNORE INTO memory_companion_lineage_v2_forget(scope_key,lineage_id) VALUES(?,?)").run(a.scope,item.lineageId);
      // A pending source mutation is durable even when this process exits.
      // No sender or ACK may be inferred from this local record.
      db.prepare("INSERT OR IGNORE INTO memory_companion_lineage_v2_forget_outbox(scope_key,generation,lineage_id,source_id,request_id,state) VALUES(?,?,?,?,?,'pending')")
        .run(a.scope,a.snapshot.generation,item.lineageId,item.id,hash([a.scope,a.snapshot.generation,item.lineageId]));
      const update=db.prepare("UPDATE memory_companion_lineage_v2_items SET visible_state='local_forget',kind=NULL,text=NULL WHERE scope_key=? AND source_id=?");
      for(const row of a.snapshot.items)if(a.roots.get(row.lineageId)===root)update.run(a.scope,row.id);
      current(a.proof);return true;
    }).immediate()}catch{return false;}
  }
  /** No ACK is inferred: entries remain pending until an authenticated
   * server deletion/receipt contract is implemented. */
  async function pending(raw:unknown){
    const a=await authorize(raw,ownerNamespace,verify);if(!a)return null;
    try{return db.transaction(()=>{current(a.proof);
      const source=db.prepare("SELECT generation,revision,forget_epoch,digest FROM memory_companion_lineage_v2_sources WHERE scope_key=?").get(a.scope) as {generation:string;revision:number;forget_epoch:number;digest:string}|undefined;
      if(!source||source.generation!==a.snapshot.generation||source.revision!==a.snapshot.revision||source.forget_epoch!==a.snapshot.forgetEpoch||source.digest!==a.digest)return null;
      const rows=db.prepare("SELECT lineage_id,source_id,request_id FROM memory_companion_lineage_v2_forget_outbox WHERE scope_key=? AND generation=? AND state='pending' ORDER BY request_id").all(a.scope,a.snapshot.generation) as {lineage_id:string;source_id:string;request_id:string}[];
      current(a.proof);return rows.map(row=>({lineageId:row.lineage_id,sourceId:row.source_id,requestId:row.request_id}));
    }).immediate()}catch{return null;}
  }
  return Object.freeze({apply,forget,pending});
}
