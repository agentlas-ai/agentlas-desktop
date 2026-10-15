import path from "node:path";
import fs from "node:fs";
import { getDb } from "../store/db";
import { getMemoryDb, getMemoryStoreInfo, memoryRoot, type MemoryStoreInfo } from "./database";
import { productSourceProducer, registerOriginalMemorySource, type MemorySourceRef } from "./source-catalogue";
import { isWorkspaceAsset } from "../agents/workspace-snapshot";

export interface AdmittedPackageAsset { path:string; role:string; digest:string; byteLength:number; generated?:boolean }
export interface PackageSourceObservation { readonly owner:MemoryStoreInfo|null }
/** Catalogue metadata cannot supply package admission or provider permission. */
export function capturePackageSourceOwner():PackageSourceObservation {
  try{return Object.freeze({owner:getMemoryStoreInfo()});}catch{return Object.freeze({owner:null});}
}
export function isGeneratedMemoryDeclaration(text:string):boolean {
  try {const value=JSON.parse(text);return value?.schemaVersion==="agentlas.memory-view.v1"&&value?.generated===true;}
  catch{return false;}
}
export function assertOriginalPackageDeclaration(root:string,text:string):void {
  const relative=path.relative(memoryRoot(),fs.realpathSync.native(root));
  if(relative===""||(!relative.startsWith(`..${path.sep}`)&&relative!==".."&&!path.isAbsolute(relative))||isGeneratedMemoryDeclaration(text))
    throw new Error("generated_memory_not_package_declaration");
}
/** Only the admitted reader passes its live registration/revision closure.
 * Roots, digests, slugs and catalogue UUIDs never replace that closure. */
export function observeAdmittedPackageSources(observation:PackageSourceObservation,input:{agentId:string;root:string;assets:readonly AdmittedPackageAsset[];assertCurrent:()=>void}):Map<string,MemorySourceRef> {
  const refs=new Map<string,MemorySourceRef>();if(!observation.owner)return refs;
  try {
    const current=()=>{input.assertCurrent();const info=getMemoryStoreInfo();const before=observation.owner!;
      if(info.ownerNamespace!==before.ownerNamespace||info.path!==before.path||info.revocationEpoch!==before.revocationEpoch)throw new Error("memory_package_owner_changed");};
    const producer=productSourceProducer(getDb()),db=getMemoryDb(),owner=observation.owner.ownerNamespace;
    // A registered new package revision may relocate its staged immutable
    // copy. A path/digest match alone is never an adoption instruction.
    db.transaction(()=>{
      current();
      for(const asset of input.assets){
        if(asset.generated||!isWorkspaceAsset(asset.path)||!["instruction","skill","manifest","knowledge","tool"].includes(asset.role))continue;
        const logicalKey=asset.path,domain=`package:${input.agentId}`;
        const old=db.prepare("SELECT metadata_revision FROM memory_source_catalogue WHERE producer_id=? AND owner_namespace=? AND actor_id=? AND visibility_domain=? AND reader_contract='desktop.admitted-package.v1' AND logical_key=?").get(producer,owner,input.agentId,domain,logicalKey) as {metadata_revision:number}|undefined;
        const ref=registerOriginalMemorySource(db,owner,producer,{actorId:input.agentId,visibilityDomain:domain,logicalKey,sourceKind:`portable-package-${asset.role}`,readerContract:"desktop.admitted-package.v1",writerContract:"original-package-owner",schemaVersion:"agentlas.runtime-assets.v1",sourceRevision:JSON.stringify(["agentlas.package-asset.v1",asset.digest]),address:{path:input.root,ref:asset.path},rangeUnit:"utf8",rangeEnd:asset.byteLength,contentDigest:asset.digest,adoptAddress:true,expectedMetadataRevision:old?.metadata_revision});
        refs.set(asset.path,ref);
      }
      current();
    }).immediate();
  }catch{return new Map();}
  return refs;
}
