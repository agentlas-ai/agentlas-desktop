import https from 'node:https';
import path from 'node:path';
import {constants,promises as fs,readFileSync,writeFileSync,realpathSync,lstatSync,mkdirSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {OneProviderError,type OneProviderAction,type OneProviderReceipt} from '../../shared/one-provider';
import {OneProviderBroker,OneProviderTransportError,type OneProviderPorts,type OneProviderLease,type OneProviderEffect,type OneProviderEffectPort,type OneProviderHttpReply} from './one-provider-broker';
import {oneVaultDigest} from './one-vault-crypto';
import type {OneVaultJournal} from './one-vault-journal';
const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
interface MediaRecord {id:string;modality:string;providerId:string;modelId:string;clientRequestKey:string;inputDigest:string;intent:unknown;lifecycle:string;version:number;providerCheckpoint:unknown;result:{path:string;sha256:string;receipt:unknown}|null}
interface MediaStore {
 registerMediaOperation(input:{id:string;modality:'audio';providerId:string;modelId:string;clientRequestKey:string;inputDigest:string;intent:unknown;spendLimitUsd:number|null;capabilities:{submitRecovery:'none';statusLookup:'none';cancellation:'local_only'}}):MediaRecord;
 getMediaOperation(id:string):MediaRecord|null;
 patchMediaOperation(input:{id:string;expectedVersion:number;patch:Record<string,unknown>;reasonCode:string}):MediaRecord;
}
function existingMediaStore():MediaStore {
 // Lazy: importing/configuring the adapter must not open a profile or make provider calls.
 const registry=require('../multimodal/media-operation-registry') as Pick<MediaStore,'registerMediaOperation'>;
 const store=require('../store/media-operations') as Omit<MediaStore,'registerMediaOperation'>;
 return {registerMediaOperation:registry.registerMediaOperation,getMediaOperation:store.getMediaOperation,patchMediaOperation:store.patchMediaOperation};
}
const HOSTS=new Set(['api.elevenlabs.io','api.eu.residency.elevenlabs.io','api.in.residency.elevenlabs.io','api.sg.residency.elevenlabs.io']);
/** Native HTTPS only. No redirects, env/argv, retry middleware, raw errors, logging or arbitrary hosts. */
export function oneProviderNativeHttps(input:Parameters<OneProviderPorts['http']>[0]):Promise<OneProviderHttpReply> {
 let url:URL;try{url=new URL(input.url);}catch{return Promise.reject(new OneProviderError('provider_route_unavailable'));}const names=[...url.searchParams.keys()];
 const read=input.method==='GET'&&['/v1/user','/v1/models'].includes(url.pathname)&&!url.search;
 const speech=input.method==='POST'&&/^\/v1\/text-to-speech\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)&&names.length===2&&new Set(names).size===2&&names.includes('output_format')&&names.includes('enable_logging')&&url.searchParams.get('output_format')==='pcm_24000'&&['true','false'].includes(url.searchParams.get('enable_logging')??'');
 if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||url.username||url.password||url.hash||url.port&&url.port!=='443'||(!read&&!speech)||input.redirect!=='error'||!Number.isSafeInteger(input.maxResponseBytes)||input.maxResponseBytes<1||input.maxResponseBytes>32*1024*1024||Object.keys(input.headers).sort().join('|')!=='accept|content-type|xi-api-key'||typeof input.headers['xi-api-key']!=='string'||input.headers['xi-api-key'].length>8192||/\r|\n/.test(input.headers['xi-api-key'])||(input.body!==null&&Buffer.byteLength(input.body)>64*1024))return Promise.reject(new OneProviderError('provider_route_unavailable'));
 return new Promise((resolve,reject)=>{
  let settled=false;const chunks:Buffer[]=[];let size=0;let timer:ReturnType<typeof setTimeout>|undefined;
  const fail=(kind:'network'|'timeout')=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);chunks.length=0;reject(new OneProviderTransportError(kind));};
  const request=https.request({protocol:'https:',hostname:url.hostname,port:443,path:url.pathname+url.search,method:input.method,headers:input.headers,rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:16384,agent:false},response=>{
   response.on('data',(value:Buffer)=>{size+=value.length;if(size>input.maxResponseBytes){response.destroy();request.destroy();fail('network');return;}chunks.push(Buffer.from(value));});
   response.on('aborted',()=>fail('network'));response.on('error',()=>fail('network'));
   response.on('end',()=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);const mime=response.headers['content-type'];resolve({status:response.statusCode??0,mime:typeof mime==='string'?mime:'',body:Buffer.concat(chunks)});chunks.length=0;});
  });
  request.on('error',()=>fail('network'));request.setTimeout(30000,()=>{request.destroy();fail('timeout');});
  timer=setTimeout(()=>{request.destroy();fail('timeout');},45000);
  if(input.body!==null)request.write(input.body);request.end();
 });
}
export interface OneProviderRuntimePorts {
 /** Main-minted current action from existing Supervisor; never deserialize a caller's action DTO. */
 currentAction(operationId:string):OneProviderAction|null;
 currentDecision(action:Readonly<OneProviderAction>,phase:'read'|'dispatch'|'publish'):Promise<{decision:'allow'|'deny'|'unknown';lease:OneProviderLease|null}>;
 journal:OneVaultJournal;vault:{readSecret(ref:string):Promise<string|null>};
 text(operationId:string):Promise<string>;
 /** Existing approved media path bound to this action/workspace/resource. Not a renderer path. */
 approvedMediaPath(action:Readonly<OneProviderAction>):string|null;
 authenticateReceipt(receipt:Omit<OneProviderReceipt,'hostKeyId'|'signature'>):OneProviderReceipt;
 /** Verify persisted receipts against the currently approved host key before reuse. */
 verifyReceipt(receipt:OneProviderReceipt):boolean;
 now?:()=>number;
}
function validReceipt(value:unknown):value is OneProviderReceipt {const v=value as Partial<OneProviderReceipt>|null;return !!v&&v.schema==='agentlas.one-provider.v1'&&typeof v.operationId==='string'&&typeof v.actionDigest==='string'&&typeof v.signature==='string'&&['verified','audio_ready','failed','outcome_unknown'].includes(v.state??'');}
/** Private filesystem adapter. Every file name is derived; no provider/client supplied paths. */
class PrivateArtifacts {
 private handles=new Map<string,{path:string;digest:string;size:number}>();
 constructor(private readonly p:OneProviderRuntimePorts){}
 directory(id:string):string {
  const action=this.p.currentAction(id),given=action&&this.p.approvedMediaPath(Object.freeze(structuredClone(action)));
  if(!action||!given||!path.isAbsolute(given))throw new OneProviderError('authority_denied');
  const root=realpathSync(given);if(root!==path.resolve(given)||!lstatSync(root).isDirectory())throw new OneProviderError('authority_denied');
  const folder=path.join(root,'.one-provider-'+hash(id));try{mkdirSync(folder,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw new OneProviderError('provider_failure');}
  if(lstatSync(folder).isSymbolicLink()||!lstatSync(folder).isDirectory()||realpathSync(folder)!==folder)throw new OneProviderError('authority_denied');
  return folder;
 }
 private write(file:string,bytes:Uint8Array,digest:string):void {
  let fd:number|undefined;
  try{fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,bytes);fsyncSync(fd);}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||hash(readFileSync(file))!==digest)throw new OneProviderError('provider_failure');}
  finally{if(fd!==undefined)closeSync(fd);}
 }
 async put(id:string,digest:string,wav:Uint8Array):Promise<{artifactId:string}> {
  if(!/^[a-f0-9]{64}$/.test(digest)||hash(wav)!==digest)throw new OneProviderError('audio_invalid');
  const file=path.join(this.directory(id),digest+'.wav');this.write(file,wav,digest);
  const artifactId=`one-audio:${hash(id)}:${digest}`;this.handles.set(artifactId,{path:file,digest,size:wav.byteLength});return{artifactId};
 }
 async read(id:string):Promise<Uint8Array>{const held=this.handles.get(id);if(!held)throw new OneProviderError('audio_invalid');const handle=await fs.open(held.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.size!==held.size)throw new OneProviderError('audio_invalid');const bytes=await handle.readFile();if(hash(bytes)!==held.digest)throw new OneProviderError('audio_invalid');return bytes;}finally{await handle.close();}}
 result(receipt:OneProviderReceipt):{path:string;sha256:string;receipt:OneProviderReceipt} {
  if(receipt.audio){const held=this.handles.get(receipt.audio.artifactId);if(!held||held.digest!==receipt.audio.sha256)throw new OneProviderError('audio_invalid');return{path:held.path,sha256:held.digest,receipt};}
  // Capability verification yields a signed receipt artifact, explicitly NOT an audio output.
  const bytes=Buffer.from(JSON.stringify(receipt)),sha256=hash(bytes),file=path.join(this.directory(receipt.operationId),sha256+'.receipt.json');this.write(file,bytes,sha256);return{path:file,sha256,receipt};
 }
}
export function createOneProviderMediaEffects(store:MediaStore,artifacts:{result(receipt:OneProviderReceipt):{path:string;sha256:string;receipt:OneProviderReceipt}},verifyReceipt:(receipt:OneProviderReceipt)=>boolean=()=>false):OneProviderEffectPort {
 const map=(r:MediaRecord):OneProviderEffect=>{
  if(r.modality!=='audio'||r.providerId!=='elevenlabs-audio')throw new OneProviderError('operation_conflict');
  const value=r.result?.receipt??(r.providerCheckpoint as {oneProviderReceipt?:unknown}|null)?.oneProviderReceipt;
  const candidate=validReceipt(value)?value:null;
  const receipt=candidate&&(['failed','outcome_unknown'].includes(candidate.state)||r.lifecycle==='succeeded')?candidate:null;
  if(receipt&&(!verifyReceipt(receipt)||receipt.operationId!==r.id||receipt.actionDigest!==r.inputDigest))throw new OneProviderError('operation_conflict');
  return{operationId:r.id,actionDigest:r.inputDigest,version:r.version,state:r.lifecycle==='submit_intent'?'submit_intent':r.lifecycle==='succeeded'?'succeeded':r.lifecycle==='failed'?'failed':r.lifecycle==='outcome_unknown'?'outcome_unknown':'submitting',receipt};
 };
 return{
  get:id=>{const r=store.getMediaOperation(id);return r?map(r):null;},
  register:(action,digest)=>map(store.registerMediaOperation({id:action.operationId,modality:'audio',providerId:'elevenlabs-audio',modelId:action.modelId,clientRequestKey:action.operationId,inputDigest:digest,intent:{schema:'agentlas.one-provider-intent.v1',actionDigest:digest,binding:action.binding,kind:action.kind,credentialGeneration:action.credentialGeneration,voiceId:action.voiceId,outputFormat:action.outputFormat,textDigest:action.textDigest,enableProviderLogging:action.enableProviderLogging},spendLimitUsd:action.binding.cost?.currency==='USD'?action.binding.cost.maxMinor/100:null,capabilities:{submitRecovery:'none',statusLookup:'none',cancellation:'local_only'}})),
  claim:(id,version)=>{const r=store.getMediaOperation(id);if(!r||r.version!==version||r.lifecycle!=='submit_intent')return false;try{store.patchMediaOperation({id,expectedVersion:version,patch:{lifecycle:'submitting'},reasonCode:'one_provider_native_dispatch'});return true;}catch(e){if((e as Error).message==='media_operation_revision_conflict')return false;throw new OneProviderError('provider_uncertain');}},
  settle:(id,receipt)=>{
   let r=store.getMediaOperation(id);if(!r||r.inputDigest!==receipt.actionDigest||r.id!==receipt.operationId)throw new OneProviderError('operation_conflict');
   if(['succeeded','failed'].includes(r.lifecycle)){const existing=map(r).receipt;if(!existing||oneVaultDigest(existing)!==oneVaultDigest(receipt))throw new OneProviderError('operation_conflict');return;}
   const checkpoint={oneProviderReceipt:receipt};
   if(receipt.state==='verified'||receipt.state==='audio_ready'){
    if(r.lifecycle==='submitting'||r.lifecycle==='provider_accepted'||r.lifecycle==='running')r=store.patchMediaOperation({id,expectedVersion:r.version,patch:{lifecycle:'verifying',providerCheckpoint:checkpoint},reasonCode:'one_provider_output_verified'});
    const result=artifacts.result(receipt);store.patchMediaOperation({id,expectedVersion:r.version,patch:{lifecycle:'succeeded',providerCheckpoint:checkpoint,result},reasonCode:'one_provider_receipt_stored'});
   }else store.patchMediaOperation({id,expectedVersion:r.version,patch:{lifecycle:receipt.state==='outcome_unknown'?'outcome_unknown':'failed',providerCheckpoint:checkpoint,failureCode:receipt.errorCode??'provider_failure',failureMessage:receipt.errorCode??'provider_failure'},reasonCode:'one_provider_safe_outcome'});
  },
 };
}
export class OneProviderRuntime {
 private readonly broker:OneProviderBroker;
 constructor(private readonly p:OneProviderRuntimePorts,store:MediaStore=existingMediaStore(),http:OneProviderPorts['http']=oneProviderNativeHttps){
  const artifacts=new PrivateArtifacts(p),effects=createOneProviderMediaEffects(store,artifacts,r=>p.verifyReceipt(r));
  this.broker=new OneProviderBroker({action:id=>p.currentAction(id),journal:p.journal,vault:p.vault,text:id=>p.text(id),effects,artifacts,http,authenticateReceipt:r=>p.authenticateReceipt(r),now:p.now,
   authorize:async(action,phase)=>{const decision=await p.currentDecision(Object.freeze(structuredClone(action)),phase);if(decision.decision!=='allow'||!decision.lease)throw new OneProviderError(decision.decision==='deny'?'authority_denied':'authority_unavailable');if(!decision.lease.stillCurrent())throw new OneProviderError('authority_denied');return decision.lease;}});
 }
 executeMainOperation(operationId:string):Promise<OneProviderReceipt>{if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(operationId))return Promise.reject(new OneProviderError('authority_denied'));return this.broker.execute(operationId);}
}
let runtime:OneProviderRuntime|null=null;
export function configureOneProviderRuntimePorts(ports:OneProviderRuntimePorts):OneProviderRuntime {if(runtime)throw new OneProviderError('authority_denied');runtime=new OneProviderRuntime(ports);return runtime;}
export function currentOneProviderRuntime():OneProviderRuntime|null{return runtime;}
