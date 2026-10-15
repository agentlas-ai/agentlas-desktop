import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb as productDb, openedStorePath } from "../store/db";
import { getMemoryDb, getMemoryStoreInfo } from "./database";

export const MEMORY_SOURCE_SCHEMA = "agentlas.memory-source.v1";
export interface MemorySourceRef { sourceId: string; metadataRevision: number; sourceRevision: string }
interface SourceInput {
  actorId: string | null; visibilityDomain: string; logicalKey: string; sourceKind: string;
  readerContract: string; writerContract: string; schemaVersion: string; sourceRevision: string;
  address: Record<string,string>; rangeUnit?: "none"|"seq"|"utf8"|"host-observation";
  rangeStart?: number; rangeEnd?: number; contentDigest?: string | null;
  /** Only an existing trusted host relocation/package adapter supplies this. */
  adoptAddress?: boolean; expectedMetadataRevision?: number;
}
type SourceRow = {
  source_id: string; producer_id: string; owner_namespace: string; actor_id: string|null;
  visibility_domain: string; logical_key: string; source_kind: string; reader_contract: string;
  writer_contract: string; schema_version: string; source_revision: string; address_json: string;
  range_unit: string; range_start: number; range_end: number; content_digest: string|null;
  metadata_revision: number;
};
const addressKeys = new Set(["path","ref","contextKey","operationId","endpoint","metaKey"]);
function text(value: unknown, maximum=1024, empty=false): asserts value is string {
  if(typeof value!=="string"||(!empty&&!value)||value.includes("\0")||Buffer.byteLength(value,"utf8")>maximum)throw new Error("memory_source_metadata_invalid");
}
function json(value:Record<string,string>):string { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b,"en")))); }
function assertOwner(db:Database.Database,owner:string):void {
  const row=db.prepare("SELECT value FROM memory_store_meta WHERE key='owner_namespace'").get() as {value:string}|undefined;
  if(row?.value!==owner)throw new Error("memory_source_owner_changed");
}
export function productSourceProducer(product:Database.Database):string {
  // The installed product store carries custody across launch, daemon and
  // explicit DB relocation. A path/digest never creates owner authority.
  if(product!==productDb()||openedStorePath()!==product.name)throw new Error("memory_source_product_unbound");
  const key="agentlas.source-producer.desktop.v1";
  product.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)").run(key,randomUUID());
  return (product.prepare("SELECT value FROM meta WHERE key=?").get(key) as {value:string}).value;
}
export function registerOriginalMemorySource(db:Database.Database,owner:string,producer:string,input:SourceInput):MemorySourceRef {
  assertOwner(db,owner);text(producer,512);if(input.actorId!==null)text(input.actorId,512);
  for(const value of [input.visibilityDomain,input.logicalKey,input.sourceKind,input.readerContract,input.writerContract,input.schemaVersion])text(value);
  text(input.sourceRevision,512,true);
  if(!input.address||!Object.keys(input.address).length||Object.keys(input.address).some(k=>!addressKeys.has(k)))throw new Error("memory_source_address_invalid");
  for(const value of Object.values(input.address))text(value,4096,true);
  const address=json(input.address);if(Buffer.byteLength(address)>8192)throw new Error("memory_source_address_invalid");
  const unit=input.rangeUnit??"none",start=input.rangeStart??0,end=input.rangeEnd??0,digest=input.contentDigest??null;
  if(!["none","seq","utf8","host-observation"].includes(unit)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start)throw new Error("memory_source_range_invalid");
  if(digest!==null&&!/^[a-f0-9]{64}$/.test(digest))throw new Error("memory_source_digest_invalid");
  return db.transaction(()=>{
    assertOwner(db,owner);const now=new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO memory_source_producers VALUES(?,?, 'desktop-product',?,?)").run(producer,owner,`product:${producer}`,now);
    const custody=db.prepare("SELECT owner_namespace,host_kind,custody_ref FROM memory_source_producers WHERE producer_id=?").get(producer) as {owner_namespace:string;host_kind:string;custody_ref:string};
    if(custody.owner_namespace!==owner||custody.host_kind!=="desktop-product"||custody.custody_ref!==`product:${producer}`)throw new Error("memory_source_producer_changed");
    const old=db.prepare("SELECT * FROM memory_source_catalogue WHERE producer_id=? AND owner_namespace=? AND actor_id IS ? AND visibility_domain=? AND reader_contract=? AND logical_key=?").get(producer,owner,input.actorId,input.visibilityDomain,input.readerContract,input.logicalKey) as SourceRow|undefined;
    const snapshot=[input.sourceKind,input.writerContract,input.schemaVersion,input.sourceRevision,address,unit,start,end,digest];
    if(old){
      if(old.address_json!==address&&(!input.adoptAddress||input.expectedMetadataRevision!==old.metadata_revision))throw new Error("memory_source_address_adoption_required");
      const prior=[old.source_kind,old.writer_contract,old.schema_version,old.source_revision,old.address_json,old.range_unit,old.range_start,old.range_end,old.content_digest];
      if(JSON.stringify(prior)===JSON.stringify(snapshot))return {sourceId:old.source_id,metadataRevision:old.metadata_revision,sourceRevision:input.sourceRevision};
    }
    const id=old?.source_id??randomUUID(),revision=(old?.metadata_revision??0)+1;
    if(old){const changed=db.prepare("UPDATE memory_source_catalogue SET source_kind=?,writer_contract=?,schema_version=?,source_revision=?,address_json=?,range_unit=?,range_start=?,range_end=?,content_digest=?,metadata_revision=?,updated_at=? WHERE source_id=? AND metadata_revision=?").run(...snapshot,revision,now,id,old.metadata_revision);if(changed.changes!==1)throw new Error("memory_source_changed");}
    else db.prepare("INSERT INTO memory_source_catalogue VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,producer,owner,input.actorId,input.visibilityDomain,input.logicalKey,input.sourceKind,input.readerContract,input.writerContract,input.schemaVersion,input.sourceRevision,address,unit,start,end,digest,revision,now,now);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,?,?,?,?,?)").run(id,revision,input.sourceRevision,address,unit,start,end,digest,now);
    return {sourceId:id,metadataRevision:revision,sourceRevision:input.sourceRevision};
  }).immediate();
}
/** Optional source catalogue failures never replace the original reader. */
export function observeProductSource(product:Database.Database,input:SourceInput):MemorySourceRef|null {
  try {
    const producer=productSourceProducer(product),db=getMemoryDb(),info=getMemoryStoreInfo();
    if(input.adoptAddress&&input.expectedMetadataRevision===undefined){
      const prior=db.prepare("SELECT metadata_revision FROM memory_source_catalogue WHERE producer_id=? AND owner_namespace=? AND actor_id IS ? AND visibility_domain=? AND reader_contract=? AND logical_key=?").get(producer,info.ownerNamespace,input.actorId,input.visibilityDomain,input.readerContract,input.logicalKey) as {metadata_revision:number}|undefined;
      input={...input,expectedMetadataRevision:prior?.metadata_revision};
    }
    return registerOriginalMemorySource(db,info.ownerNamespace,producer,input);
  }
  catch{return null;}
}
export function observeProjectMemoryFile(projectPath:string,relativePath:string,textValue:string):MemorySourceRef|null {
  const bytes=Buffer.from(textValue,"utf8"),hash=createHash("sha256").update(bytes).digest("hex");
  return observeProductSource(productDb(),{actorId:null,visibilityDomain:"activated-project",logicalKey:JSON.stringify([projectPath,relativePath]),sourceKind:"manual-file",readerContract:"desktop.activated-project-file.v1",writerContract:"manual-original",schemaVersion:"agentlas.project-memory-text.v1",sourceRevision:hash,address:{path:projectPath,ref:relativePath},rangeUnit:"utf8",rangeEnd:bytes.length,contentDigest:hash});
}
/** A catalogue address is never a filesystem/server permission. Only the
 * existing host reader closure can revalidate ACL, exact source revision and
 * bounded UTF-8/sequence range before and after producing bytes. */
export function readOriginalMemorySource(ref:MemorySourceRef,scope:{actorId:string|null;visibilityDomain:string;readerContract:string},range:{start:number;end:number},reader:(source:Readonly<SourceRow>,start:number,end:number)=>Buffer,assertCurrent:()=>void,maximum=131072):Buffer {
  assertCurrent();const db=getMemoryDb(),owner=getMemoryStoreInfo().ownerNamespace;
  const row=db.prepare("SELECT * FROM memory_source_catalogue WHERE source_id=? AND owner_namespace=? AND actor_id IS ? AND visibility_domain=? AND reader_contract=?").get(ref.sourceId,owner,scope.actorId,scope.visibilityDomain,scope.readerContract) as SourceRow|undefined;
  if(!row||row.metadata_revision!==ref.metadataRevision)throw new Error("memory_source_changed");
  if(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<row.range_start||range.end<range.start||range.end>row.range_end||!Number.isSafeInteger(maximum)||maximum<1||maximum>131072)throw new Error("memory_source_range_invalid");
  const result=reader(Object.freeze({...row}),range.start,range.end);assertCurrent();
  const current=db.prepare("SELECT metadata_revision FROM memory_source_catalogue WHERE source_id=? AND owner_namespace=?").get(row.source_id,owner) as {metadata_revision:number}|undefined;
  if(!current||current.metadata_revision!==ref.metadataRevision||!Buffer.isBuffer(result)||result.length>maximum)throw new Error("memory_source_changed");
  if(row.range_unit==="utf8")new TextDecoder("utf8",{fatal:true}).decode(result);
  return result;
}
