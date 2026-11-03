import type Database from 'better-sqlite3';
import {createGeneratedVideoReceipts,type Scope} from './generated-video-receipts';
import {captureVideoWitness} from './file-witness';
/** Host-only adapter. It is never serialized to a renderer, model, or tool child. */
export function createHostVideoCustody(input:{db:Database.Database;scope:Scope;signal:AbortSignal;currentAccount:()=>string|null;isLive:(scope:Scope)=>boolean;ownsSettledAssistantMessage:(scope:Scope,id:string)=>boolean}) {
 const receipts=createGeneratedVideoReceipts(input), observed=new Set<string>();let finalized=false;
 /** Call only with the ID returned by the real host media start, after its operation row exists. */
 function started(operationId:string):boolean {if(finalized||input.signal.aborted)return false;try{receipts.start(input.scope,operationId);return true}catch{return false}}
 /** The path and digest come exclusively from the existing successful media operation. */
 async function ready(operationId:string):Promise<boolean>{
  if(finalized||input.signal.aborted)return false;
  try {
   const row=input.db.prepare("SELECT result_path,result_sha256,lifecycle FROM media_operations WHERE id=? AND modality='video'").get(operationId) as {result_path:string;result_sha256:string;lifecycle:string}|undefined;
   if(!row||row.lifecycle!=='succeeded'||typeof row.result_path!=='string'||typeof row.result_sha256!=='string')return false;
   const witness=await captureVideoWitness(row.result_path,row.result_sha256,input.signal);
   if(finalized||input.signal.aborted)return false;
   receipts.observed(input.scope,operationId,witness);observed.add(operationId);return true;
  }catch{return false}
 }
 /** Invoke only after the existing run lifetime drains; a final stream event alone is insufficient. */
 function settled(messageId:string):{sealed:string[];unknown:string[]}{
  finalized=true;const sealed:string[]=[],unknown:string[]=[];
  for(const operationId of observed){try{if(input.signal.aborted)throw Error('video_stopped');receipts.seal(input.scope,operationId,messageId);sealed.push(operationId)}catch{unknown.push(operationId)}}
  observed.clear();return {sealed,unknown};
 }
 return {started,ready,settled};
}

export type HostVideoCustody = ReturnType<typeof createHostVideoCustody>;
