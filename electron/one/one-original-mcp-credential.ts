import {getServer} from '../mcp-tools/registry';
import {mcpServerConfigurationDigest} from '../mcp-tools/prepared-transport';
import {currentOnePersonalNativeOriginal,withOnePersonalNativeOriginal} from '../secrets/one-personal-native-entry';
import {authorizeSupervisorNativeOrigin} from './supervisor-native-runtime';
import {oneVaultDigest} from '../secrets/one-vault-crypto';
import {createOneMcpScopedCredentialAdapter,type OneMcpCredentialNativeOwners} from '../plugins/one-vault-mcp-credential';
import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
/** Same existing original source owner, narrowed to the members consumed here.
 * This type is not a grant and creates no registry or alternate source owner. */
export interface OneOriginalMcpSource {
 current(original:Readonly<import('../secrets/one-personal-native-entry').OnePersonalNativeOriginal>,anchor:Readonly<import('../secrets/one-vault-runtime').OneVaultRuntimeAnchor>,runtime:OneVaultRuntime):{readonly owners:{stillCurrent():boolean}}|null;
}

/** Main-only call seam for the SAME source owner and existing scoped MCP adapter.
 * It creates no grant, reader, registry, plugin install, environment or transport.
 * Native plugin account/release selection and approved ref owner are mandatory. */
export async function prepareOneOriginalInstalledMcpCredential(
 runtime:OneVaultRuntime,source:OneOriginalMcpSource|null,
 credentialOwner:OneMcpCredentialNativeOwners|null,serverId:string,envKey:string,
){
 if(!source||!credentialOwner)throw Error('one_original_mcp_source_owner_unbound');
 const original=currentOnePersonalNativeOriginal();if(!original?.request.runId)throw Error('one_original_mcp_origin_unbound');
 authorizeSupervisorNativeOrigin(original.origin,original.request);
 const rows=runtime.sources.db.prepare("SELECT command_id FROM one_supervisor_requests WHERE one_id=? AND run_id=? AND kind IN ('reply','work','follow-up','chat-send')").all(runtime.sources.oneId(),original.request.runId) as Array<{command_id:string}>;
 const anchor=rows.length===1?runtime.anchor(rows[0].command_id):null,native=runtime.currentNativeOwner();
 if(!anchor||!native||anchor.runId!==original.request.runId||anchor.chatId!==original.request.chatId)throw Error('one_original_mcp_original_changed');
 const sourceCurrent=source.current,bundle=sourceCurrent.call(source,original,Object.freeze(anchor),runtime);
 if(bundle?.owners.stillCurrent()!==true)throw Error('one_original_mcp_source_owner_unbound');
 const server=getServer(serverId);if(!server||!server.enabled||server.configurationValid===false||!server.envKeys.includes(envKey))throw Error('one_original_mcp_installed_selection_unavailable');
 const configuration=mcpServerConfigurationDigest(server),ownerDigest=oneVaultDigest(native),anchorDigest=oneVaultDigest(anchor);
 const current=()=>{
  try{authorizeSupervisorNativeOrigin(original.origin,original.request);
   const actual=currentOnePersonalNativeOriginal(),installed=getServer(serverId);
   return actual?.origin===original.origin&&oneVaultDigest(actual.request)===oneVaultDigest(original.request)
    &&source.current===sourceCurrent&&sourceCurrent.call(source,original,anchor,runtime)===bundle&&bundle.owners.stillCurrent()===true
    &&oneVaultDigest(runtime.currentNativeOwner())===ownerDigest&&oneVaultDigest(runtime.anchor(anchor.commandId))===anchorDigest
    &&!!installed&&mcpServerConfigurationDigest(installed)===configuration;
  }catch{return false;}
 };
 // Existing adapter alone verifies independent account/release/source selection,
 // native consent, signed request, exact slot/ref/generation and scoped read ACK.
 const reference=await createOneMcpScopedCredentialAdapter(runtime,credentialOwner).prepareReference(Object.freeze(server),envKey);
 if(!current())throw Error('one_original_mcp_current_source_changed');
 const context=runtime.resolveCommand(anchor.commandId),b=context?.binding,c=reference.consumer;
 if(!b||b.commandId!==anchor.commandId||b.runId!==anchor.runId||b.taskId!==anchor.taskId||b.controlVersion!==anchor.controlVersion
  ||b.principalId!==native.principalId||b.sessionId!==native.sessionId||b.workspaceId!==native.workspaceId
  ||b.scope!==reference.scope||b.organizationId!==reference.organizationId||b.resourceId!==reference.resourceId
  ||b.provider!==reference.provider||b.providerWorkspace!==reference.providerWorkspace||b.region!==reference.region
  ||b.expectedGeneration!==c.generation||c.commandId!==anchor.commandId||c.hostId!==native.hostId
  ||reference.serverId!==serverId||reference.configurationDigest!==configuration||c.keyName!==envKey||!current())throw Error('one_original_mcp_reference_scope_changed');
 return reference; // Value-free. Never pass this object to resolvedEnv/readEnvVar.
}

/** The already installed native consumer owns this reader. Receipt/presence alone
 * cannot implement it. Endpoint/header/account selection needs its own current
 * native source approval; no grant is derived from server labels or this DTO. */
export interface OneOriginalMcpCredentialReceiver {
 current(reference: Readonly<import('../plugins/one-vault-mcp-credential').OneMcpCredentialReference>, server: Readonly<import('../../shared/types').InstalledMcpServer>): {
  readonly installation: import('../secrets/one-vault-personal-adapter').OneVaultScopedConsumerReceipt;
  /** Native source owner's already approved MCP audience/target relation. The
   * installer must not mint this from a Page grant or the supplied reference. */
  readonly referenceDigest: string; readonly configurationDigest: string;
  readonly sourceRevision: string; readonly nativeConsentReceiptId: string;
  readonly url: string; readonly header: string; readonly prefix: '' | 'Bearer ';
  stillCurrent(): boolean;
  consume(body: (secret: string) => Promise<void>): Promise<void>;
 } | null;
}
export interface OneOriginalMcpTransportOwners {
 readonly serverId: string; readonly runtime: OneVaultRuntime;
 readonly source: OneOriginalMcpSource;
 readonly credentialOwner: OneMcpCredentialNativeOwners;
 readonly receiver: OneOriginalMcpCredentialReceiver;
}
/** Observed HTTP rejection only, after the installed consumer acknowledged and
 * current source/ref checks completed. It makes no claim about provider effects.
 * No response body, credential, URL or account is attached to this safe fault. */
export class OneMcpScopedHttpStatusError extends Error {
 readonly code='one_mcp_scoped_http_rejected' as const;
 readonly retryAllowed=false as const;
 readonly category:'authentication'|'permission'|'billing'|'quota'|'http';
 constructor(readonly status:number){
  super('one_mcp_scoped_http_rejected:'+status);this.name='OneMcpScopedHttpStatusError';
  this.category=status===401?'authentication':status===403?'permission':status===402?'billing':status===429?'quota':'http';
 }
}
/** Value-free observation for this exact prepared capability; never authority,
 * a provider effect settlement or permission to retry. Null is not success. */
export type OneMcpScopedOutcome = Readonly<
 | {kind:'http-rejected';status:number;category:OneMcpScopedHttpStatusError['category'];retryAllowed:false}
 | {kind:'outcome-unknown';retryAllowed:false}
>;
/** Buffer only bounded JSON while the existing scoped reader still owns secret.
 * Streaming/binary responses cannot outlive that reader and fail closed. Limits
 * match MCP proxy MAX_FRAME_BYTES (16 MiB) and client CONNECT_TIMEOUT_MS (45s). */
async function scopedMcpResponse(response:Response,secret:string,check:()=>void,signal?:AbortSignal|null):Promise<Response>{
 const refuse=():never=>{throw Error('one_mcp_scoped_response_unavailable')};
 if(!response.ok){void response.body?.cancel().catch(()=>{});return new Response(null,{status:response.status})}
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 let onAbort:(()=>void)|undefined;const safeHeaders=new Headers();
 try{
  check();if(signal?.aborted)refuse();
  response.headers.forEach((value,name)=>{if(name.includes(secret.toLowerCase())||value.includes(secret))refuse();});
  for(const name of ['mcp-session-id','mcp-protocol-version']){const value=response.headers.get(name);if(value!==null){if(value.length>8192)refuse();safeHeaders.set(name,value)}}
  const mime=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase(),emptyStatus=[202,204,205].includes(response.status);
  if(mime!=='application/json'&&!emptyStatus)refuse();
  const deadline=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(Error('one_mcp_scoped_response_unavailable'));timer=setTimeout(onAbort,45_000);signal?.addEventListener('abort',onAbort,{once:true})});
  const chunks:Uint8Array[]=[];let size=0;
  reader=response.body?.getReader();
  if(reader)for(;;){const chunk=await Promise.race([reader.read(),deadline]);check();if(signal?.aborted)refuse();if(chunk.done)break;size+=chunk.value.byteLength;if(size>16*1024*1024)refuse();chunks.push(chunk.value)}
  check();if(!size&&emptyStatus)return new Response(null,{status:response.status,headers:safeHeaders});
  if(mime!=='application/json')refuse();
  const data=JSON.parse(Buffer.concat(chunks,size).toString('utf8')) as unknown,stack:unknown[]=[data];
  // Decoded JSON strings AND property names catch escaped reflection as well.
  while(stack.length){const value=stack.pop();if(typeof value==='string'){if(value.includes(secret))refuse()}else if(value&&typeof value==='object'){for(const [key,item] of Object.entries(value)){if(key.includes(secret))refuse();stack.push(item)}}}
  check();if(signal?.aborted)refuse();safeHeaders.set('content-type','application/json');
  return new Response(JSON.stringify(data),{status:response.status,headers:safeHeaders});
 }finally{
  if(timer)clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);
  if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}
  else void response.body?.cancel().catch(()=>{});
 }
}

/** Invoked by the existing config builder, consumed by the existing Main proxy.
 * No reader is installed here. The returned capability is never serialized. */
export async function prepareOneOriginalMcpTransport(owners: OneOriginalMcpTransportOwners, server: Readonly<import('../../shared/types').InstalledMcpServer>) {
 const deny=():never=>{throw Error('one_mcp_scoped_transport_unavailable')};
 if(!owners?.receiver||owners.serverId!==server.id||server.transport!=='http'||server.envKeys.length!==1||server.envKeys[0]!=='ELEVENLABS_API_KEY'||!server.url)deny();
 const target=new URL(server.url!);if(target.protocol!=='https:'||target.username||target.password||target.hash||target.search)deny();
 const original=currentOnePersonalNativeOriginal();if(!original)deny();
 const captured=original!,native=owners.runtime.currentNativeOwner();if(!native)deny();const nativeDigest=oneVaultDigest(native);
 const inOriginal=<T>(body:()=>T)=>withOnePersonalNativeOriginal(captured.origin,captured.request,body);
 const prepare=()=>inOriginal(()=>prepareOneOriginalInstalledMcpCredential(owners.runtime,owners.source,owners.credentialOwner,owners.serverId,'ELEVENLABS_API_KEY'));
 const reference=await prepare(),digest=oneVaultDigest(reference),configuration=mcpServerConfigurationDigest(server);
 const providerEndpoint=owners.runtime.resolveCommand(reference.consumer.commandId)?.binding.endpoint;
 if(!providerEndpoint||new URL(providerEndpoint).origin!==target.origin)deny();
 const receiveCurrent=owners.receiver.current,receiver=receiveCurrent.call(owners.receiver,reference,server);
 if(!receiver||receiver.stillCurrent()!==true||receiver.referenceDigest!==digest||receiver.configurationDigest!==configuration||receiver.sourceRevision!==reference.sourceRevision||receiver.nativeConsentReceiptId!==reference.nativeConsentReceiptId||oneVaultDigest(receiver.installation)!==oneVaultDigest(reference.consumer)||receiver.url!==target.href
  ||!/^[-!#$%&'*+.^_`|~0-9A-Za-z]{1,128}$/.test(receiver.header)||['host','cookie','set-cookie','content-length','transfer-encoding','connection'].includes(receiver.header.toLowerCase())
  ||!['','Bearer '].includes(receiver.prefix))deny();
 const installed=receiver!,installation=oneVaultDigest(installed.installation),header=installed.header,prefix=installed.prefix;
 const currentMethod=installed.stillCurrent,consume=installed.consume;
 let closed=false,uncertain=false;let terminalOutcome:OneMcpScopedOutcome|null=null;
 const current=()=>{try{
  authorizeSupervisorNativeOrigin(captured.origin,captured.request);
  const actual=getServer(server.id),slot=owners.runtime.journal.current(reference.consumer.slotId);
  return !closed&&!uncertain&&oneVaultDigest(owners.runtime.currentNativeOwner())===nativeDigest
   &&owners.runtime.resolveCommand(reference.consumer.commandId)?.binding.endpoint===providerEndpoint
   &&!!actual&&mcpServerConfigurationDigest(actual)===configuration&&slot.pendingOperation===null&&slot.generation===reference.consumer.generation&&slot.credentialRef===reference.consumer.credentialRef
   &&owners.receiver.current===receiveCurrent&&receiveCurrent.call(owners.receiver,reference,server)===installed&&installed.stillCurrent===currentMethod&&installed.consume===consume&&installed.stillCurrent()===true
   &&installed.referenceDigest===digest&&installed.configurationDigest===configuration&&installed.sourceRevision===reference.sourceRevision&&installed.nativeConsentReceiptId===reference.nativeConsentReceiptId
   &&installed.url===target.href&&installed.header===header&&installed.prefix===prefix&&oneVaultDigest(installed.installation)===installation
   &&oneVaultDigest(owners.credentialOwner.consumer.current(reference.consumer.commandId,'elevenlabs-audio','ELEVENLABS_API_KEY'))===installation;
 }catch{return false}};
 const check=()=>{if(!current())deny()};check();
 return Object.freeze({reference,current,outcome:()=>terminalOutcome,close(){closed=true},
  async fetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
   check();const url=input instanceof Request?input.url:String(input);
   // This receiver covers one approved Streamable HTTP endpoint only. Neither
   // redirects nor server-selected event endpoints inherit the credential.
   if(url!==target.href||input instanceof Request&&input.bodyUsed)deny();
   const fresh=await prepare();check();if(oneVaultDigest(fresh)!==digest)deny();
   const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
   if(headers.has(header)||headers.has('authorization')||headers.has('cookie')||headers.has('proxy-authorization'))deny();
   let attempts=0,open=true,completed=false,sent=false,fault=false;const outcome:{response:Response|null}={response:null};let knownFault:OneMcpScopedHttpStatusError|null=null;
   try{
    await inOriginal(()=>consume.call(installed,async secret=>{
     attempts++;if(!open||attempts!==1){fault=true;deny()}check();
     if(typeof secret!=='string'||!secret||secret.length>65536||/[\r\n\0]/.test(secret))deny();
     headers.set(header,prefix+secret);
     try{check();sent=true;const raw=await fetch(input,{...init,headers,redirect:'error',credentials:'omit'});check();outcome.response=await scopedMcpResponse(raw,secret,check,init?.signal??(input instanceof Request?input.signal:undefined));check();completed=true}
     finally{headers.delete(header);secret=''}
    }));
    open=false;check();if(attempts!==1||fault||!completed||!outcome.response)deny();
    const after=await prepare();check();if(oneVaultDigest(after)!==digest)deny();
    const response=outcome.response!;
    if(!response.ok){
     if(!Number.isInteger(response.status)||response.status<100||response.status>599)deny();
     // Terminal for this capability even when the HTTP rejection is known.
     // No automatic retry, replacement credential or extra grant follows.
     knownFault=new OneMcpScopedHttpStatusError(response.status);terminalOutcome=Object.freeze({kind:'http-rejected',status:knownFault.status,category:knownFault.category,retryAllowed:false});closed=true;throw knownFault;
    }
    return outcome.response!;
   }catch(error){open=false;if(knownFault&&error===knownFault)throw knownFault;if(sent){uncertain=true;terminalOutcome=Object.freeze({kind:'outcome-unknown',retryAllowed:false})}throw Error(sent?'one_mcp_scoped_outcome_unknown':'one_mcp_scoped_transport_unavailable')}
  },
 });
}

/** Main's genuine selection claim survives a missing/failed current owner. A
 * resolver must not map an unavailable selected owner to route:legacy. This is
 * routing metadata only, never a grant and never accepted from renderer/RPC. */
export type OneOriginalMcpSelection =
 | Readonly<{route:'legacy'}>
 | Readonly<{route:'scoped';serverId:string;owners:OneOriginalMcpTransportOwners|null}>;
export type OneOriginalMcpAvailability =
 | Readonly<{route:'legacy'}>
 | Readonly<{route:'scoped';available:boolean;credentialState:'saved'|'unavailable';connection:'unverified';errorCode:'one_mcp_scoped_transport_unavailable'|null}>;
/** No secret consumption, connection probe, provider dispatch or installation.
 * available only means a current candidate for the owned prepared proxy; the
 * config builder reauthorizes independently before constructing that proxy. */
export async function inspectOneOriginalMcpAvailability(selection:OneOriginalMcpSelection,server:Readonly<import('../../shared/types').InstalledMcpServer>):Promise<OneOriginalMcpAvailability>{
 let saved=false;
 const unavailable=():OneOriginalMcpAvailability=>Object.freeze({route:'scoped',available:false,credentialState:saved?'saved':'unavailable',connection:'unverified',errorCode:'one_mcp_scoped_transport_unavailable'});
 try{
  if(selection?.route==='legacy')return Object.freeze({route:'legacy'});
  if(selection?.route!=='scoped'||typeof selection.serverId!=='string'||!selection.serverId)return unavailable();
  if(selection.serverId!==server.id)return Object.freeze({route:'legacy'});
  const owners=selection.owners;if(!owners||owners.serverId!==selection.serverId)return unavailable();
  await prepareOneOriginalInstalledMcpCredential(owners.runtime,owners.source,owners.credentialOwner,owners.serverId,'ELEVENLABS_API_KEY');saved=true;
  try{
   const capability=await prepareOneOriginalMcpTransport(owners,server);
   try{if(!capability.current())return unavailable();return Object.freeze({route:'scoped',available:true,credentialState:'saved',connection:'unverified',errorCode:null})}
   finally{capability.close()}
  }catch{
   // Preserve presence only if the same current source/ref can still prove it.
   try{await prepareOneOriginalInstalledMcpCredential(owners.runtime,owners.source,owners.credentialOwner,owners.serverId,'ELEVENLABS_API_KEY')}catch{saved=false}
   return unavailable();
  }
 }catch{return unavailable()}
}
