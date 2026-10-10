import {createHash} from 'node:crypto';
import {ONE_PROVIDER_SCHEMA,OneProviderError,type OneProviderAction,type OneProviderAudio,type OneProviderErrorCode,type OneProviderReceipt} from '../../shared/one-provider';
import {oneVaultDigest,validateOneVaultBinding} from './one-vault-crypto';
import {oneVaultSlot,type OneVaultJournal} from './one-vault-journal';
import type {OneVaultRequest} from '../../shared/one-vault';
const REGION_BASES:Readonly<Record<string,string>>={global:'https://api.elevenlabs.io',eu:'https://api.eu.residency.elevenlabs.io',in:'https://api.in.residency.elevenlabs.io',sg:'https://api.sg.residency.elevenlabs.io'};
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
export interface OneProviderLease {
 stillCurrent():boolean;endpoint:string;providerWorkspace:string;region:string;
 modelIds:readonly string[];voiceIds:readonly string[];outputFormats:readonly string[];
 /** Current budget admission quote for this exact action, from existing Supervisor budget owner. */
 charge:{currency:string;upperBoundMinor:number;consentRevision:string}|null;
 allowProviderLogging:boolean;zeroRetentionAvailable:boolean;allowIdentityRead:boolean;
}
export interface OneProviderEffect {
 operationId:string;actionDigest:string;version:number;
 state:'submit_intent'|'submitting'|'succeeded'|'failed'|'outcome_unknown';receipt:OneProviderReceipt|null;
}
export interface OneProviderEffectPort {
 /** Adapt to existing media-operation create/get/patch CAS, modality audio, recovery none.
  * This is an effect ledger only. No new work queue, request engine or provider table. */
 get(id:string):OneProviderEffect|null;
 register(action:OneProviderAction,digest:string):OneProviderEffect;
 claim(id:string,expectedVersion:number):boolean;
 settle(id:string,receipt:OneProviderReceipt):void;
}
export interface OneProviderHttpReply {status:number;mime:string;body:Uint8Array}
/** Only trusted transport adapters construct this machine marker; messages are discarded. */
export class OneProviderTransportError extends Error {constructor(readonly transportCode:'network'|'timeout'){super('provider_transport_failure');}}
export interface OneProviderPorts {
 action(id:string):OneProviderAction|null;
 authorize(action:OneProviderAction,phase:'read'|'dispatch'|'publish'):Promise<OneProviderLease>;
 journal:OneVaultJournal;vault:{readSecret(ref:string):Promise<string|null>};
 /** Only the private in-process HTTPS adapter receives this header; never generic RPC/logging middleware.
  * Adapter MUST use redirect:error, bounded body size <= 32 MiB, finite timeout, no automatic retries. */
 http(input:{url:string;method:'GET'|'POST';headers:Record<string,string>;body:string|null;redirect:'error';maxResponseBytes:number}):Promise<OneProviderHttpReply>;
 text(actionId:string):Promise<string>;
 effects:OneProviderEffectPort;
 /** Host-authenticated receipt using existing approved host signing custody and receipt domain. */
 authenticateReceipt(receipt:Omit<OneProviderReceipt,'hostKeyId'|'signature'>):OneProviderReceipt;
 /** Owner-selected artifact sink; cannot accept provider paths. Readback verifies exact bytes. */
 artifacts:{put(operationId:string,digest:string,wav:Uint8Array):Promise<{artifactId:string}>;read(artifactId:string):Promise<Uint8Array>};
 now?:()=>number;
}
/** Exhaustive machine-code map; no regex/prose classification or provider message forwarding. */
export function classifyOneProviderFailure(status:number,body:Uint8Array):OneProviderErrorCode {
 let code:unknown;try{const v=JSON.parse(Buffer.from(body).toString('utf8'));code=v?.detail?.status??v?.code;}catch{}
 const known:Record<string,OneProviderErrorCode>={invalid_api_key:'provider_unauthenticated',token_expired:'provider_expired',key_revoked:'provider_revoked',insufficient_permissions:'provider_permission',ip_not_allowed:'provider_ip_restricted',workspace_mismatch:'provider_workspace',region_mismatch:'provider_region',quota_exceeded:'provider_quota',payment_required:'provider_billing',too_many_requests:'provider_rate_limited'};
 if(typeof code==='string'&&Object.hasOwn(known,code))return known[code];
 if(status===401)return 'provider_unauthenticated';if(status===403)return 'provider_permission';if(status===402)return 'provider_billing';if(status===429)return 'provider_rate_limited';return status>=500?'provider_uncertain':'provider_failure';
}
/** Exact PCM16LE decoder: PCM has no compressed frames and each signed sample is decoded.
 * Containers are generated locally only AFTER the endpoint format/MIME/length contracts hold. */
export function verifyOnePcmAudio(pcm:Uint8Array,mime:string,minMs:number,maxMs:number):{wav:Buffer;audio:Omit<OneProviderAudio,'artifactId'>} {
 const bytes=Buffer.from(pcm);
 if(!['audio/pcm','audio/x-pcm','application/octet-stream'].includes(mime.split(';')[0].trim().toLowerCase()) || bytes.length<2 || bytes.length%2 || bytes.length>32*1024*1024)throw new OneProviderError('audio_invalid');
 // Reject common error/container responses even when a server mislabels their MIME.
 const prefix=bytes.subarray(0,16).toString('ascii').trimStart();
 if(/^(?:\{|\[|<|RIFF|ID3|OggS)/.test(prefix))throw new OneProviderError('audio_invalid');
 const samples=bytes.length/2,durationMs=Math.round(samples*1000/24000);
 if(durationMs<minMs||durationMs>maxMs)throw new OneProviderError('audio_invalid');
 let power=0;for(let offset=0;offset<bytes.length;offset+=2){const value=bytes.readInt16LE(offset);power+=value*value;}
 if(!Number.isFinite(power)||power===0)throw new OneProviderError('audio_invalid');
 const wav=Buffer.alloc(44+bytes.length);wav.write('RIFF',0);wav.writeUInt32LE(36+bytes.length,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(bytes.length,40);bytes.copy(wav,44);
 verifyOneWav(wav);
 return {wav,audio:{sha256:sha(wav),sizeBytes:wav.length,mime:'audio/wav',container:'wav',codec:'pcm_s16le',sampleRate:24000,channels:1,decodedSamples:samples,durationMs}};
}
export function verifyOneWav(bytes:Uint8Array):void {
 const b=Buffer.from(bytes);if(b.length<46||b.toString('ascii',0,4)!=='RIFF'||b.readUInt32LE(4)!==b.length-8||b.toString('ascii',8,16)!=='WAVEfmt '||b.readUInt32LE(16)!==16||b.readUInt16LE(20)!==1||b.readUInt16LE(22)!==1||b.readUInt32LE(24)!==24000||b.readUInt32LE(28)!==48000||b.readUInt16LE(32)!==2||b.readUInt16LE(34)!==16||b.toString('ascii',36,40)!=='data'||b.readUInt32LE(40)!==b.length-44||(b.length-44)%2)throw new OneProviderError('audio_invalid');
 for(let i=44;i<b.length;i+=2)b.readInt16LE(i);
}
export class OneProviderBroker {
 constructor(private readonly p:OneProviderPorts){}
 private now(){return this.p.now?.()??Date.now();}
 private action(id:string):OneProviderAction {
  const value=this.p.action(id);if(!value||value.operationId!==id)throw new OneProviderError('authority_denied');
  const a=structuredClone(value);validateOneVaultBinding(a.binding);
  if(a.schema!==ONE_PROVIDER_SCHEMA || !['verify','tts'].includes(a.kind) || a.binding.provider!=='elevenlabs-audio' || a.outputFormat!=='pcm_24000' || a.modelId!=='eleven_multilingual_v2' || !/^[A-Za-z0-9_-]{1,128}$/.test(a.voiceId) || !/^[a-f0-9]{64}$/.test(a.textDigest) || !Number.isSafeInteger(a.credentialGeneration) || a.credentialGeneration<1 || a.binding.expectedGeneration!==a.credentialGeneration || !Number.isSafeInteger(a.expiresAt) || a.expiresAt<=this.now() || !Number.isSafeInteger(a.minDurationMs) || !Number.isSafeInteger(a.maxDurationMs) || a.minDurationMs<1 || a.maxDurationMs<a.minDurationMs || a.maxDurationMs>600000 || typeof a.enableProviderLogging!=='boolean')throw new OneProviderError('provider_route_unavailable');
  return a;
 }
 private slot(a:OneProviderAction){return oneVaultSlot({binding:a.binding} as OneVaultRequest);}
 private credential(a:OneProviderAction):string {
  const slot=this.p.journal.current(this.slot(a));
  if(slot.pendingOperation!==null||slot.generation!==a.credentialGeneration||!slot.credentialRef)throw new OneProviderError('generation_changed');return slot.credentialRef;
 }
 private current(a:OneProviderAction,lease:OneProviderLease):void {
  if(!lease.stillCurrent()||oneVaultDigest(this.action(a.operationId))!==oneVaultDigest(a))throw new OneProviderError('authority_denied');this.credential(a);
 }
 private async authorized(a:OneProviderAction,phase:'read'|'dispatch'|'publish'):Promise<OneProviderLease>{
  let lease:OneProviderLease;try{lease=await this.p.authorize(a,phase);}catch(error){throw error instanceof OneProviderError&&error.code==='authority_denied'?error:new OneProviderError('authority_unavailable');}
  this.current(a,lease);
  if(lease.endpoint!==REGION_BASES[a.binding.region]||a.binding.endpoint!==lease.endpoint||lease.region!==a.binding.region||lease.providerWorkspace!==a.binding.providerWorkspace||!lease.modelIds.includes(a.modelId)||!lease.voiceIds.includes(a.voiceId)||!lease.outputFormats.includes(a.outputFormat)||!a.binding.operations.includes(a.kind==='tts'?'tts':'verify'))throw new OneProviderError('provider_route_unavailable');
  if(!lease.allowIdentityRead || !a.binding.operations.includes('provider_identity') || (a.enableProviderLogging?!lease.allowProviderLogging:!lease.zeroRetentionAvailable))throw new OneProviderError('provider_permission');
  if(a.kind==='tts'){
   const cost=a.binding.cost,quote=lease.charge;if(!cost||!quote)throw new OneProviderError('cost_unknown');
   if(!Number.isSafeInteger(quote.upperBoundMinor)||quote.upperBoundMinor<0||quote.currency!==cost.currency||quote.consentRevision!==cost.consentRevision||quote.upperBoundMinor>cost.maxMinor)throw new OneProviderError('cost_exceeded');
  }
  return lease;
 }
 private receipt(a:OneProviderAction,state:OneProviderReceipt['state'],errorCode:OneProviderErrorCode|null,audio:OneProviderAudio|null=null):OneProviderReceipt {
  const b=a.binding;return this.p.authenticateReceipt({schema:ONE_PROVIDER_SCHEMA,operationId:a.operationId,actionDigest:oneVaultDigest(a),taskId:b.taskId,runId:b.runId,controlVersion:b.controlVersion,authorityRevision:b.authorityRevision,permissionRevision:b.permissionRevision,hostId:b.hostId,principalId:b.principalId,organizationId:b.organizationId,workspaceId:b.workspaceId,resourceId:b.resourceId,provider:'elevenlabs-audio',providerWorkspace:b.providerWorkspace,region:b.region,credentialGeneration:a.credentialGeneration,state,errorCode,audio,observedAt:this.now()});
 }
 private settled(a:OneProviderAction,receipt:OneProviderReceipt):OneProviderReceipt {
  try{this.p.effects.settle(a.operationId,receipt);return receipt;}catch{return this.receipt(a,'outcome_unknown','provider_uncertain');}
 }
 /** Id-only dedicated Main invocation. No key/endpoint/grant/tool args can widen the authority. */
 async execute(id:string):Promise<OneProviderReceipt>{
  const a=this.action(id),digest=oneVaultDigest(a);let lease=await this.authorized(a,'read');
  const existing=this.p.effects.get(id);
  if(existing){if(existing.actionDigest!==digest)throw new OneProviderError('operation_conflict');return existing.receipt??this.receipt(a,'outcome_unknown','provider_uncertain');}
  let key:string|undefined;let headers:Record<string,string>={};let claimed=false,dispatched=false;
  try{
   const ref=this.credential(a),raw=await this.p.vault.readSecret(ref);this.current(a,lease);
   if(!raw)throw new OneProviderError('generation_changed');
   const record=JSON.parse(raw);if(record.schema!=='agentlas.one-vault-record.v1'||record.generation!==a.credentialGeneration||typeof record.value!=='string'||!record.value||record.value.length>8192)throw new OneProviderError('generation_changed');
   // Stored operation receipt must agree with the active slot, not only a claimed JSON generation.
   const source=this.p.journal.get(record.operationId);if(source?.state!=='saved'||source.credentialRef!==ref||source.requestDigest!==record.requestDigest)throw new OneProviderError('generation_changed');
   key=String(record.value);record.value='';
   let text='';if(a.kind==='tts'){text=await this.p.text(id);this.current(a,lease);if(typeof text!=='string'||text.length<1||text.length>10000||sha(text)!==a.textDigest)throw new OneProviderError('input_changed');}
   lease=await this.authorized(a,'dispatch');this.current(a,lease);
   const effect=this.p.effects.register(a,digest);
   if(effect.actionDigest!==digest)throw new OneProviderError('operation_conflict');
   if(effect.state!=='submit_intent'||!this.p.effects.claim(id,effect.version))return effect.receipt??this.receipt(a,'outcome_unknown','provider_uncertain');
   claimed=true;this.current(a,lease);
   headers={'xi-api-key':key,'content-type':'application/json','accept':a.kind==='tts'?'audio/pcm':'application/json'};
   dispatched=true;
   const identity=await this.p.http({url:`${lease.endpoint}/v1/user`,method:'GET',headers,body:null,redirect:'error',maxResponseBytes:1024*1024});
   this.current(a,lease);
   if(identity.body.byteLength>1024*1024)throw new OneProviderError('provider_failure');
   if(identity.status!==200)throw new OneProviderError(classifyOneProviderFailure(identity.status,identity.body));
   if(identity.mime.split(';')[0].trim()!=='application/json')throw new OneProviderError('provider_workspace');
   let workspace:unknown;try{workspace=JSON.parse(Buffer.from(identity.body).toString('utf8'))?.workspace_id;}catch{}
   if(workspace!==a.binding.providerWorkspace)throw new OneProviderError('provider_workspace');
   lease=await this.authorized(a,'dispatch');this.current(a,lease);
   const url=a.kind==='verify'?`${lease.endpoint}/v1/models`:`${lease.endpoint}/v1/text-to-speech/${a.voiceId}?output_format=pcm_24000&enable_logging=${a.enableProviderLogging?'true':'false'}`;
   dispatched=true;
   const reply=await this.p.http({url,method:a.kind==='verify'?'GET':'POST',headers,body:a.kind==='tts'?JSON.stringify({text,model_id:a.modelId}):null,redirect:'error',maxResponseBytes:32*1024*1024});
   const echoesCredential=Buffer.from(reply.body).includes(Buffer.from(key));
   delete headers['xi-api-key'];key=undefined;text='';this.current(a,lease);
   if(reply.body.byteLength>32*1024*1024)throw new OneProviderError('provider_uncertain');
   if(reply.status!==200){const code=classifyOneProviderFailure(reply.status,reply.body);const result=this.receipt(a,code==='provider_uncertain'?'outcome_unknown':'failed',code);return this.settled(a,result);}
   if(echoesCredential)throw new OneProviderError('provider_failure');
   let audio:OneProviderAudio|null=null;
   if(a.kind==='verify'){
    if(reply.mime.split(';')[0].trim()!=='application/json')throw new OneProviderError('provider_failure');
    const models=JSON.parse(Buffer.from(reply.body).toString('utf8'));
    if(!Array.isArray(models)||!models.some(m=>m?.model_id===a.modelId&&m.can_do_text_to_speech===true))throw new OneProviderError('provider_permission');
   }else{
    const verified=verifyOnePcmAudio(reply.body,reply.mime,a.minDurationMs,a.maxDurationMs);
    lease=await this.authorized(a,'publish');this.current(a,lease);
    const artifact=await this.p.artifacts.put(id,verified.audio.sha256,verified.wav);this.current(a,lease);
    if(!/^[A-Za-z0-9._:/-]{1,256}$/.test(artifact.artifactId))throw new OneProviderError('audio_invalid');
    const readback=await this.p.artifacts.read(artifact.artifactId);this.current(a,lease);verifyOneWav(readback);
    if(sha(readback)!==verified.audio.sha256||readback.byteLength!==verified.audio.sizeBytes)throw new OneProviderError('audio_invalid');
    audio={...verified.audio,artifactId:artifact.artifactId};
   }
   lease=await this.authorized(a,'publish');this.current(a,lease);
   const receipt=this.receipt(a,a.kind==='tts'?'audio_ready':'verified',null,audio);return this.settled(a,receipt);
  }catch(e){
   const code=e instanceof OneProviderError?e.code:e instanceof OneProviderTransportError?'provider_network':dispatched?'provider_uncertain':'provider_failure';
   const state=dispatched&&['authority_denied','authority_unavailable','generation_changed','provider_uncertain','provider_network'].includes(code)?'outcome_unknown':'failed';
   const receipt=this.receipt(a,state,code);
   return claimed?this.settled(a,receipt):receipt;
  }finally{if(headers)delete headers['xi-api-key'];key=undefined;}
 }
}
