import {BrowserWindow,dialog} from 'electron';
import {randomUUID,sign,verify} from 'node:crypto';
import {oneVaultCanonical} from '../../shared/one-vault';
import type {InstalledMcpServer} from '../../shared/types';
import {oneVaultDigest,oneVaultPublicKey,decodeOneVaultBase64} from './one-vault-crypto';
import {loadOneVaultApprovedHost} from './one-vault-service';
import type {OneVaultRuntime} from './one-vault-runtime';
import type {OneVaultScopedConsumerReceipt} from './one-vault-personal-adapter';
import type {OnePersonalNativeConsumerOwner} from './one-personal-native-owners';
/** Exact native source owner contract. Existing storage metadata has NO installed
 * endpoint/header relation, so its presence must never implement this port. */
export interface OnePersonalNativeMcpMapping {
 readonly pluginReleaseDigest:string;readonly bindingDigest:string;readonly configurationDigest:string;readonly sourceRevision:string;readonly nativeConsentReceiptId:string;
 readonly server:Readonly<InstalledMcpServer>;readonly provider:'elevenlabs-audio';readonly providerWorkspace:string;readonly region:string;
 readonly resourceId:string;readonly scope:'personal';readonly organizationId:null;readonly audience:'owner';readonly operations:readonly string[];
 readonly header:string;readonly prefix:''|'Bearer ';readonly decision:'allow'|'deny'|'unknown';readonly revision:string;
 stillCurrent():boolean;
}
export interface OnePersonalNativeMcpReference {
 readonly sourceRevision:string;readonly nativeConsentReceiptId:string;readonly serverId:string;readonly configurationDigest:string;
 readonly provider:string;readonly providerWorkspace:string;readonly resourceId:string;readonly scope:string;readonly organizationId:string|null;
 readonly region:string;readonly audience:string;readonly operations:readonly string[];readonly consumer:Readonly<OneVaultScopedConsumerReceipt>;
}
export interface OnePersonalNativeScopedConsumerPorts {
 runtime:OneVaultRuntime;focusedWindow():BrowserWindow|null;isNativeOwnerWindow(window:BrowserWindow):boolean;
 /** Independently current source/account/audience/MCP-domain owner, not a renderer DTO. */
 currentMapping(binding:Readonly<OneVaultScopedConsumerReceipt>):OnePersonalNativeMcpMapping|null;
 currentServer(serverId:string):Readonly<InstalledMcpServer>|null;
 configurationDigest(server:Readonly<InstalledMcpServer>):string;
}
/** SAME installed-reader holder implements install and the receiver. No secret is
 * retained, no duplicate reader is created, and construction grants nothing. */
const nativeConsumers=new WeakMap<OnePersonalNativeConsumerOwner,{receiver:ReturnType<typeof createOnePersonalScopedConsumerOwner>['receiver'];currentUse:ReturnType<typeof createOnePersonalScopedConsumerOwner>['currentUse']}>();
export function inspectOnePersonalScopedConsumerOwner(owner:OnePersonalNativeConsumerOwner){return nativeConsumers.get(owner)??null}
export function createOnePersonalScopedConsumerOwner(p:OnePersonalNativeScopedConsumerPorts){
 const entries=new Map<string,{binding:Readonly<OneVaultScopedConsumerReceipt>;mapping:OnePersonalNativeMcpMapping;value:object;rowId:string;read:(body:(secret:string)=>Promise<void>)=>Promise<void>;closed:boolean;receiver:object|null;use:object|null}>();
 const pending=new Set<string>();let closed=false;const refs=[p.runtime,p.focusedWindow,p.isNativeOwnerWindow,p.currentMapping,p.currentServer,p.configurationDigest];
 const live=()=>!closed&&refs.every((v,i)=>v===[p.runtime,p.focusedWindow,p.isNativeOwnerWindow,p.currentMapping,p.currentServer,p.configurationDigest][i]);
 const focused=(w:BrowserWindow)=>live()&&BrowserWindow.fromId(w.id)===w&&!w.isDestroyed()&&w.isFocused()&&p.isNativeOwnerWindow(w);
 const key=(b:Readonly<OneVaultScopedConsumerReceipt>)=>b.installationRevision;
 function mapping(binding:Readonly<OneVaultScopedConsumerReceipt>){
  if(!live())throw Error('one_personal_mcp_consumer_unavailable');const m=p.currentMapping(binding),owner=p.runtime.currentNativeOwner(),slot=p.runtime.journal.current(binding.slotId),server=m&&p.currentServer(m.server.id);
  if(!m||!/^[a-f0-9]{64}$/.test(m.pluginReleaseDigest)||m.decision!=='allow'||!m.revision||m.stillCurrent()!==true||!owner||binding.principalId!==owner.principalId||binding.sessionId!==owner.sessionId||binding.workspaceId!==owner.workspaceId||binding.hostId!==owner.hostId||slot.pendingOperation!==null||slot.generation!==binding.generation||slot.credentialRef!==binding.credentialRef||m.bindingDigest!==oneVaultDigest(binding)||m.scope!=='personal'||m.organizationId!==null||m.audience!=='owner'||m.provider!=='elevenlabs-audio'||!m.sourceRevision||!m.nativeConsentReceiptId||!m.resourceId||!m.providerWorkspace||!server||server.transport!=='http'||!server.url||server.envKeys.length!==1||server.envKeys[0]!=='ELEVENLABS_API_KEY'||p.configurationDigest(server)!==m.configurationDigest||p.configurationDigest(m.server)!==m.configurationDigest)throw Error('one_personal_mcp_mapping_unavailable');
  const context=p.runtime.resolveCommand(binding.commandId),b=context?.binding;if(!b||b.commandId!==binding.commandId||b.provider!==m.provider||b.providerWorkspace!==m.providerWorkspace||b.resourceId!==m.resourceId||b.region!==m.region||b.expectedGeneration!==binding.generation)throw Error('one_personal_mcp_original_source_unavailable');
  const url=new URL(server.url);if(url.origin!==new URL(b.endpoint).origin||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.href!==server.url||!/^[-!#$%&'*+.^_`|~0-9A-Za-z]{1,128}$/.test(m.header)||['host','cookie','set-cookie','proxy-authorization','content-length','connection','transfer-encoding'].includes(m.header.toLowerCase())||!['','Bearer '].includes(m.prefix))throw Error('one_personal_mcp_endpoint_unavailable');return m;
 }
 function proof(m:OnePersonalNativeMcpMapping){const {stillCurrent,...body}=m;return oneVaultDigest(body)}
 function current(e:ReturnType<typeof entries.get>){try{
  if(!e||e.closed)return false;const m=mapping(e.binding);if(proof(m)!==proof(e.mapping))return false;
  const row=p.runtime.sources.db.prepare('SELECT metadata_digest,disclosure_json,revoked_at FROM one_vault_native_approvals WHERE id=?').get(e.rowId) as {metadata_digest:string;disclosure_json:string;revoked_at:number|null}|undefined,host=p.runtime.trust.currentHostMetadata();
  if(!row||row.revoked_at!==null||!host)return false;const value=JSON.parse(row.disclosure_json),{signature,...body}=value;
  return oneVaultDigest(value)===row.metadata_digest&&oneVaultDigest(value)===oneVaultDigest(e.value)&&value.hostKeyId===host.hostKeyId&&value.trustGeneration===host.generation&&oneVaultDigest(value.owner)===oneVaultDigest(p.runtime.currentNativeOwner())&&verify('sha256',Buffer.from(oneVaultCanonical(['personal-mcp-consumer',body])),{key:oneVaultPublicKey(host.signingPublicKey),dsaEncoding:'ieee-p1363'},decodeOneVaultBase64(signature,64));
 }catch{return false}}
 function clearInstallation(binding:Readonly<OneVaultScopedConsumerReceipt>){const e=entries.get(key(binding));if(e){if(oneVaultDigest(e.binding)!==oneVaultDigest(binding))return false;e.closed=true;p.runtime.sources.db.prepare('UPDATE one_vault_native_approvals SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(p.runtime.sources.now?.()??Date.now(),e.rowId);entries.delete(key(binding))}return !pending.has(key(binding));}
 const consumer:OnePersonalNativeConsumerOwner={clearInstallation,
  authorizeCredentialRead:async binding=>{try{const m=mapping(binding),captured=proof(m);return{decision:'allow',bindingDigest:oneVaultDigest(binding),revision:m.revision,stillCurrent:()=>{try{return proof(mapping(binding))===captured}catch{return false}}}}catch{return{decision:'unknown',bindingDigest:'',revision:'',stillCurrent:()=>false}}},
  async install(binding,read){if(entries.has(key(binding))||pending.has(key(binding)))throw Error('one_personal_mcp_install_conflict');const w=p.focusedWindow();if(!w||!focused(w))throw Error('one_personal_mcp_focused_owner_required');const m=mapping(binding),digest=proof(m),owner=p.runtime.currentNativeOwner();pending.add(key(binding));let entry:ReturnType<typeof entries.get>;
   try{const response=await dialog.showMessageBox(w,{type:'question',title:'One 원래 요청의 MCP 연결 승인',message:'이 저장된 참조를 정확한 설치 서버에 연결할까요?',detail:`원래 요청: ${binding.commandId}\n계정: ${m.providerWorkspace} / ${m.region}\n리소스: ${m.resourceId}\n서버: ${m.server.id}\n엔드포인트: ${m.server.url}\n전달 헤더: ${m.header} (${m.prefix||'접두사 없음'})\n범위: 개인 / 소유자\n저장 버전: ${binding.generation}\n제공자 확인·유료 실행은 이 승인에 포함되지 않습니다.`,buttons:['취소','이 연결 승인'],defaultId:0,cancelId:0,noLink:true});
    if(response.response!==1||!focused(w)||proof(mapping(binding))!==digest||oneVaultDigest(p.runtime.currentNativeOwner())!==oneVaultDigest(owner))throw Error('one_personal_mcp_approval_changed');
    const host=await loadOneVaultApprovedHost(owner!.hostId,p.runtime.trust,p.runtime.sources.vault);if(!focused(w)||proof(mapping(binding))!==digest||oneVaultDigest(p.runtime.currentNativeOwner())!==oneVaultDigest(owner))throw Error('one_personal_mcp_approval_changed');
    const operation='personal-mcp-consumer:'+binding.commandId,prior=p.runtime.sources.db.prepare('SELECT id FROM one_vault_native_approvals WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get(operation) as {id:string}|undefined;
    const id=randomUUID(),body={schema:'agentlas.one-personal-mcp-consumer.v1',id,binding:structuredClone(binding),mappingDigest:digest,owner,hostKeyId:host.metadata.hostKeyId,trustGeneration:host.metadata.generation,expectedReceiptId:prior?.id??null},value={...body,signature:sign('sha256',Buffer.from(oneVaultCanonical(['personal-mcp-consumer',body])),{key:host.signingKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
    p.runtime.sources.db.transaction(()=>{const now=p.runtime.sources.db.prepare('SELECT id FROM one_vault_native_approvals WHERE operation_id=? ORDER BY rowid DESC LIMIT 1').get(operation) as {id:string}|undefined;if((now?.id??null)!==body.expectedReceiptId||!focused(w)||proof(mapping(binding))!==digest)throw Error('one_personal_mcp_approval_cas');p.runtime.sources.db.prepare('INSERT INTO one_vault_native_approvals VALUES(?,?,?,?,?,?,NULL)').run(id,operation,JSON.stringify(owner),oneVaultDigest(value),JSON.stringify(value),p.runtime.sources.now?.()??Date.now());}).immediate();
    entry={binding:Object.freeze(structuredClone(binding)),mapping:m,value,rowId:id,read,closed:false,receiver:null,use:null};entries.set(key(binding),entry);if(!current(entry))throw Error('one_personal_mcp_install_changed');const e=entry;return Object.freeze({current:()=>current(e)?structuredClone(e.binding):null,revoke:()=>{if(!clearInstallation(e.binding))throw Error('one_personal_mcp_cleanup_unknown')}});
   }catch(error){if(entry)clearInstallation(binding);throw error}finally{pending.delete(key(binding))}
  }};
 const receiver={current(reference:Readonly<OnePersonalNativeMcpReference>,server:Readonly<InstalledMcpServer>){const e=entries.get(key(reference.consumer));if(!e||!current(e))return null;const m=e.mapping;
  if(reference.serverId!==server.id||m.server.id!==server.id||reference.configurationDigest!==m.configurationDigest||p.configurationDigest(server)!==m.configurationDigest||reference.sourceRevision!==m.sourceRevision||reference.nativeConsentReceiptId!==m.nativeConsentReceiptId||oneVaultDigest(reference.consumer)!==oneVaultDigest(e.binding)||reference.provider!==m.provider||reference.providerWorkspace!==m.providerWorkspace||reference.region!==m.region||reference.resourceId!==m.resourceId||reference.scope!==m.scope||reference.organizationId!==m.organizationId||reference.audience!==m.audience||oneVaultDigest(reference.operations)!==oneVaultDigest(m.operations))return null;
  if(e.receiver){if((e.receiver as {referenceDigest:string}).referenceDigest!==oneVaultDigest(reference))return null;return e.receiver as ReturnType<typeof makeReceiver>}
  function makeReceiver(){return Object.freeze({installation:structuredClone(e!.binding),referenceDigest:oneVaultDigest(reference),configurationDigest:m.configurationDigest,sourceRevision:m.sourceRevision,nativeConsentReceiptId:m.nativeConsentReceiptId,url:m.server.url!,header:m.header,prefix:m.prefix,stillCurrent:()=>current(e),async consume(body:(secret:string)=>Promise<void>){if(!current(e))throw Error('one_personal_mcp_read_denied');let invoked=0,open=true;try{await e!.read(async secret=>{if(!open||++invoked!==1||!current(e))throw Error('one_personal_mcp_read_denied');await body(secret);if(!current(e))throw Error('one_personal_mcp_read_changed')});open=false;if(invoked!==1||!current(e))throw Error('one_personal_mcp_read_changed')}finally{open=false}}})}
  const result=makeReceiver();e.receiver=result;return result;
 }};
 function close(){closed=true;let unknown=false;for(const e of [...entries.values()])try{if(!clearInstallation(e.binding))unknown=true}catch{unknown=true}if(pending.size||unknown)throw Error('one_personal_mcp_cleanup_unknown')}
 function currentUse(binding:Readonly<OneVaultScopedConsumerReceipt>,server:Readonly<InstalledMcpServer>){const e=entries.get(key(binding));if(!e||!current(e)||oneVaultDigest(e.binding)!==oneVaultDigest(binding)||server.id!==e.mapping.server.id||p.configurationDigest(server)!==e.mapping.configurationDigest)return null;const m=e.mapping;if(e.use)return e.use as typeof result;const result=Object.freeze({commandId:binding.commandId,serverId:server.id,configurationDigest:m.configurationDigest,pluginReleaseDigest:m.pluginReleaseDigest,sourceRevision:m.sourceRevision,nativeConsentReceiptId:m.nativeConsentReceiptId,toolId:'elevenlabs-audio' as const,envKey:'ELEVENLABS_API_KEY' as const,provider:m.provider,providerWorkspace:m.providerWorkspace,resourceId:m.resourceId,scope:m.scope,organizationId:m.organizationId,region:m.region,credentialRef:binding.credentialRef,generation:binding.generation,audience:m.audience,operations:m.operations,stillCurrent:()=>current(e)});e.use=result;return result;}
 function invalidateSlot(slotId:string,generation:number){for(const e of [...entries.values()])if(e.binding.slotId===slotId&&e.binding.generation!==generation&&!clearInstallation(e.binding))throw Error('one_personal_mcp_cleanup_unknown')}
 const api=Object.freeze({consumer,receiver,currentUse,invalidateSlot,close});nativeConsumers.set(consumer,{receiver,currentUse});return api;
}
