import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { InstalledMcpServer, McpServerStatus } from '../../shared/types';
import type { OneActionAuthorityPort, OneActionAuthorityRequest } from '../../shared/one-authority';
import type { PersonalDataCollectInput, PersonalDataSourceState, PersonalDataTarget } from '../../shared/one-personal-data';
import type { PreparedMcpBinding } from '../mcp-tools/prepared-transport';
import type { OnePersonalDataService } from '../one/personal-data-service';
import { personalDataError, personalDataHash, personalDataId, personalDataTarget } from '../one/personal-data-store';
import { createInstalledGmailPersonalSource, GmailPersonalIntakeSubscriptions, type GmailCurrentReadConsent, type GmailDiscoveredHistoryContract, type GmailPersonalCodecs, type GmailPersonalNativePorts } from './gmail-personal-data';

export interface GmailRegistrationActor { principalId:string;sessionId:string;workspaceId:string;oneId:string;hostId:string }
export interface GmailRegistrationSelection {
  serverId:string;expectedAccountRef:string;target:PersonalDataTarget;budgetId:string;
  query:string;labelIds:string[];allowMessageBody:boolean;allowHistory:boolean;purpose:string;
}
/** A CURRENT native source grant and opaque prepared transport. No token values cross this port. */
export interface GmailRegistrationCustody {
  decision:'allow'|'deny'|'unknown';permissionRevision:string;audienceGrantRevision:string;credentialGeneration:string;
  expectedAccountRef:string;prepared:PreparedMcpBinding|null;
}
export interface GmailRegistrationDiscovery {
  /** Previously discovered by an explicit native connector test, never renderer-authored. */
  status:McpServerStatus;history?:GmailDiscoveredHistoryContract;codecs?:GmailPersonalCodecs;
}
export interface GmailNativeApprovalRequest {
  consentId:string;proposalDigest:string;expectedRevision:number;actor:GmailRegistrationActor;
  selection:GmailRegistrationSelection;toolDigests:Record<string,string>;authorityRevision:string;permissionRevision:string;audienceGrantRevision:string;credentialGeneration:string;
}
export interface GmailNativeApprovalReceipt {
  consentId:string;proposalDigest:string;actorDigest:string;authorityRevision:string;proofRef:string;
}
export interface GmailRegistrationPorts {
  db:Database.Database;actor():GmailRegistrationActor;listInstalled():InstalledMcpServer[];
  discovery(serverId:string):GmailRegistrationDiscovery|null;
  /** Only exact already granted native selections; renderer never authors account or source authority. */
  selections?(actor:Readonly<GmailRegistrationActor>):readonly GmailRegistrationSelection[];
  custody(selection:Readonly<GmailRegistrationSelection>,actor:Readonly<GmailRegistrationActor>):GmailRegistrationCustody;
  /** Exact source/audience/purpose grant. Admin status alone is never this grant. */
  authority:OneActionAuthorityPort;
  assertTarget(target:PersonalDataTarget,actor:GmailRegistrationActor):void;
  assertBudget(input:PersonalDataCollectInput):void;
  /** Main-only, authenticates the displayed exact request and returns a native proof; no renderer boolean. */
  reviewNative(request:Readonly<GmailNativeApprovalRequest>):Promise<GmailNativeApprovalReceipt|null>;
  sourceNative:GmailPersonalNativePorts;discoverPrepared?(serverId:string,prepared:PreparedMcpBinding):Promise<McpServerStatus>;service:Pick<OnePersonalDataService,'registerSource'|'sourceControl'|'collect'>;
  sourceState(target:PersonalDataTarget,sourceId:string):PersonalDataSourceState|null;
  subscribeOwnerWake(listener:()=>void):()=>void;
}
type ConsentStatus='proposal'|'approved'|'paused'|'revoked';
interface Ledger {
  consentId:string;revision:number;status:ConsentStatus;actor:GmailRegistrationActor;selection:GmailRegistrationSelection;
  serverDigest:string;toolDigests:Record<string,string>;contractDigest:string;authorityRevision:string;
  permissionRevision:string;audienceGrantRevision:string;credentialGeneration:string;proposalDigest:string;
  approval:GmailNativeApprovalReceipt|null;sourceId:string|null;createdAt:string;
}
/** Value-free status: no message bytes, query, account identity, URL, command, env names, or proof. */
export interface GmailRegistrationCatalogEntry {serverId:string;label:string;enabled:boolean;availability:'review-required'|'permission-required';selections:GmailRegistrationSelection[];consents:Array<{consentId:string;revision:number;status:ConsentStatus;sourceId:string|null;target:PersonalDataTarget;intake:{revision:number;enabled:boolean}|null}>}
export interface GmailRegistrationReceipt {consentId:string;revision:number;status:ConsentStatus;sourceId:string|null;sourceStatus:string|null}
function deny(code='gmail_personal_permission_required'):never {throw personalDataError(code);}
function selection(raw:GmailRegistrationSelection):GmailRegistrationSelection {
  const s=structuredClone(raw);s.target=personalDataTarget(s.target);personalDataId(s.serverId);personalDataId(s.budgetId);
  if(!/^gmail-account:[a-f0-9]{64}$/.test(s.expectedAccountRef)||typeof s.query!=='string'||!s.query.trim()||s.query.length>500
    ||typeof s.purpose!=='string'||!s.purpose.trim()||s.purpose.length>500||!Array.isArray(s.labelIds)||s.labelIds.length>16
    ||s.labelIds.some(l=>typeof l!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(l))||new Set(s.labelIds).size!==s.labelIds.length
    ||typeof s.allowHistory!=='boolean'||typeof s.allowMessageBody!=='boolean')deny('gmail_personal_selection_invalid');
  return s;
}
function actorEqual(a:GmailRegistrationActor,b:GmailRegistrationActor):boolean{return personalDataHash(a)===personalDataHash(b);}

/** Same native DB, connector registry, service and owner wake. Construction/catalog never probes a provider. */
export class GmailPersonalRegistrationService {
  private readonly active=new Map<string,()=>void>();private readonly activating=new Set<string>();
  private readonly subscriptions:GmailPersonalIntakeSubscriptions;
  constructor(private readonly ports:GmailRegistrationPorts){
    ports.db.exec('CREATE TABLE IF NOT EXISTS one_gmail_native_consents(consent_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,status TEXT NOT NULL,principal_id TEXT NOT NULL,value_json TEXT NOT NULL)');
    this.subscriptions=new GmailPersonalIntakeSubscriptions({db:ports.db,subscribeOwnerWake:ports.subscribeOwnerWake,
      assertOwner:()=>{ports.actor();},assertCurrent:i=>{const r=this.findSource(i);this.current(r,'gmail-intake');},
      assertBudget:i=>ports.assertBudget(i),collect:i=>ports.service.collect(i),
      state:i=>{const s=ports.sourceState(i.target,i.sourceId);if(!s)deny('gmail_personal_source_missing');return s;},control:i=>ports.service.sourceControl(i)});
  }
  private read(id:string):Ledger {personalDataId(id);const row=this.ports.db.prepare('SELECT value_json FROM one_gmail_native_consents WHERE consent_id=?').get(id) as {value_json:string}|undefined;if(!row)deny('gmail_personal_consent_missing');return JSON.parse(row.value_json) as Ledger;}
  private assertActor(r:Ledger,terminal=false):void {const a=this.ports.actor();if(!actorEqual(terminal?{...a,sessionId:''}:a,terminal?{...r.actor,sessionId:''}:r.actor))deny('gmail_personal_session_changed');this.ports.assertTarget(r.selection.target,a);}
  private save(r:Ledger,expected:number):void {
    this.ports.db.transaction(()=>{const prior=this.ports.db.prepare('SELECT revision FROM one_gmail_native_consents WHERE consent_id=?').get(r.consentId) as {revision:number}|undefined;
      if((prior?.revision??0)!==expected)deny('gmail_personal_consent_revision_conflict');
      this.ports.db.prepare('INSERT INTO one_gmail_native_consents VALUES(?,?,?,?,?) ON CONFLICT(consent_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,value_json=excluded.value_json')
        .run(r.consentId,r.revision,r.status,r.actor.principalId,JSON.stringify(r));}).immediate();
  }
  private discovery(s:GmailRegistrationSelection):{server:InstalledMcpServer;discovery:GmailRegistrationDiscovery;digests:Record<string,string>;contractDigest:string} {
    const server=this.ports.sourceNative.getServer(s.serverId),d=this.ports.discovery(s.serverId);
    if(!server?.enabled||server.configurationValid===false||!d?.status.connected||d.status.id!==server.id)deny();
    const required=['gmail_get_profile','gmail_search_email_ids','gmail_read_email',...(s.allowHistory?[d.history?.toolName??'']:[])];
    const digests:Record<string,string>={};for(const name of required){const match=d.status.tools.filter(t=>t.name===name);if(!name||match.length!==1)deny();digests[name]=this.ports.sourceNative.schemaDigest(match[0]);}
    if(s.allowHistory&&d.history?.expectedSchemaDigest!==digests[d.history?.toolName??''])deny();
    return {server,discovery:d,digests,contractDigest:personalDataHash([digests,s.allowHistory?{name:d.history?.toolName,digest:d.history?.expectedSchemaDigest}:null])};
  }
  private authorize(s:GmailRegistrationSelection,a:GmailRegistrationActor,action:string):{custody:GmailRegistrationCustody;revision:string} {
    if(s.target.oneId!==a.oneId||s.target.deploymentId!==a.hostId)deny('gmail_personal_target_mismatch');
    this.ports.assertTarget(s.target,a);
    const c=this.ports.custody(Object.freeze(structuredClone(s)),Object.freeze({...a}));
    if(c.decision!=='allow'||!c.prepared||c.expectedAccountRef!==s.expectedAccountRef||!c.permissionRevision||!c.credentialGeneration||!c.audienceGrantRevision||c.prepared.server.id!==s.serverId)deny();
    const request:OneActionAuthorityRequest={principalId:a.principalId,sessionId:a.sessionId,workspaceId:a.workspaceId,oneId:a.oneId,hostId:a.hostId,
      scope:s.target.scope,organizationId:s.target.organizationId,projectId:s.target.projectId,resourceId:`${s.target.spaceId}:${s.target.pageId}`,
      purpose:s.purpose,payerId:a.principalId,action,taskId:null,runId:null,controlVersion:null,permissionRevision:c.permissionRevision,
      credentialGeneration:c.credentialGeneration,sourceRefs:[s.serverId,s.expectedAccountRef],audience:s.target.audience};
    const decision=this.ports.authority.current(Object.freeze(request));if(decision.decision!=='allow'||!decision.revision)deny();
    this.ports.assertBudget({target:s.target,sourceId:`gmail-consent:${personalDataHash(s)}`,budgetId:s.budgetId});return {custody:c,revision:decision.revision};
  }
  private current(r:Ledger,action:string):GmailRegistrationCustody {
    try{this.assertActor(r);const latest=this.read(r.consentId);if(!['approved','paused'].includes(latest.status)||latest.revision!==r.revision||latest.proposalDigest!==r.proposalDigest||!latest.approval)deny('gmail_personal_consent_changed');
      const d=this.discovery(r.selection),a=this.authorize(r.selection,r.actor,action);
      if(personalDataHash(d.server)!==r.serverDigest||d.contractDigest!==r.contractDigest||a.custody.permissionRevision!==r.permissionRevision
        ||a.custody.audienceGrantRevision!==r.audienceGrantRevision||a.custody.credentialGeneration!==r.credentialGeneration||a.revision!==r.authorityRevision)deny('gmail_personal_grant_changed');return a.custody;
    }catch(e){this.active.get(r.consentId)?.();this.active.delete(r.consentId);throw e;}
  }
  private findSource(i:PersonalDataCollectInput):Ledger {const rows=this.ports.db.prepare("SELECT value_json FROM one_gmail_native_consents WHERE principal_id=? AND status='approved'").all(this.ports.actor().principalId) as Array<{value_json:string}>;
    const r=rows.map(row=>JSON.parse(row.value_json) as Ledger).find(r=>r.sourceId===i.sourceId&&personalDataHash(r.selection.target)===personalDataHash(i.target)&&r.selection.budgetId===i.budgetId);
    if(!r||!this.active.has(r.consentId))deny('gmail_personal_registration_required');return r;}
  catalog():GmailRegistrationCatalogEntry[]{const a=this.ports.actor(),rows=this.ports.db.prepare('SELECT value_json FROM one_gmail_native_consents WHERE principal_id=?').all(a.principalId) as Array<{value_json:string}>;
    const allowed=(this.ports.selections?.(Object.freeze({...a}))??[]).slice(0,20).flatMap(raw=>{try{const s=selection(raw);this.discovery(s);this.authorize(s,a,'gmail-propose');return [s];}catch{return [];}});
    return this.ports.listInstalled().map(server=>({serverId:server.id,label:server.name,enabled:server.enabled,availability:this.ports.discovery(server.id)?.status.connected?'review-required':'permission-required',selections:allowed.filter(s=>s.serverId===server.id),
      consents:rows.map(row=>JSON.parse(row.value_json) as Ledger).filter(r=>r.selection.serverId===server.id&&actorEqual(r.actor,a)).flatMap(r=>{try{this.assertActor(r);return [{consentId:r.consentId,revision:r.revision,status:r.status,sourceId:r.sourceId,target:r.selection.target,intake:r.sourceId?this.subscriptions.status({target:r.selection.target,sourceId:r.sourceId,budgetId:r.selection.budgetId}):null}];}catch{return [];}})}));}
  propose(raw:GmailRegistrationSelection&{commandId?:string}):GmailRegistrationReceipt {const {commandId,...scope}=raw;if(commandId!==undefined&&(personalDataId(commandId).length>160))deny('gmail_personal_selection_invalid');const s=selection(scope),a=structuredClone(this.ports.actor()),d=this.discovery(s),auth=this.authorize(s,a,'gmail-propose');
    const consentId=`gmail-consent:${commandId??randomUUID()}`;
    const prior=this.ports.db.prepare('SELECT value_json FROM one_gmail_native_consents WHERE consent_id=?').get(consentId) as {value_json:string}|undefined;
    if(prior){const r=JSON.parse(prior.value_json) as Ledger;this.assertActor(r);if(personalDataHash(r.selection)!==personalDataHash(s))deny('gmail_personal_command_conflict');return this.receipt(r);}
    const base={consentId,revision:1,status:'proposal' as const,actor:a,selection:s,serverDigest:personalDataHash(d.server),toolDigests:d.digests,contractDigest:d.contractDigest,
      authorityRevision:auth.revision,permissionRevision:auth.custody.permissionRevision,audienceGrantRevision:auth.custody.audienceGrantRevision,credentialGeneration:auth.custody.credentialGeneration,approval:null,sourceId:null,createdAt:new Date().toISOString()};
    const r:Ledger={...base,proposalDigest:personalDataHash(base)};this.save(r,0);return this.receipt(r);}
  async approve(input:{consentId:string;expectedRevision:number}):Promise<GmailRegistrationReceipt>{const r=this.read(input.consentId);this.assertActor(r);
    if(r.status!=='proposal'||r.revision!==input.expectedRevision)deny('gmail_personal_consent_revision_conflict');
    const before=this.authorize(r.selection,r.actor,'gmail-approve'),d=this.discovery(r.selection);
    if(personalDataHash(d.server)!==r.serverDigest||d.contractDigest!==r.contractDigest||before.custody.permissionRevision!==r.permissionRevision||before.custody.credentialGeneration!==r.credentialGeneration||before.custody.audienceGrantRevision!==r.audienceGrantRevision)deny('gmail_personal_grant_changed');
    const request:GmailNativeApprovalRequest={consentId:r.consentId,expectedRevision:r.revision,proposalDigest:r.proposalDigest,actor:r.actor,selection:r.selection,toolDigests:r.toolDigests,
      authorityRevision:before.revision,permissionRevision:r.permissionRevision,audienceGrantRevision:r.audienceGrantRevision,credentialGeneration:r.credentialGeneration};
    const approval=await this.ports.reviewNative(Object.freeze(structuredClone(request)));this.assertActor(r);const after=this.authorize(r.selection,r.actor,'gmail-approve');
    if(!approval||approval.consentId!==r.consentId||approval.proposalDigest!==r.proposalDigest||approval.actorDigest!==personalDataHash(r.actor)||approval.authorityRevision!==after.revision||!approval.proofRef
      ||before.revision!==after.revision||personalDataHash(before.custody)!==personalDataHash(after.custody)||personalDataHash(this.discovery(r.selection).server)!==r.serverDigest||this.discovery(r.selection).contractDigest!==r.contractDigest)deny('gmail_personal_native_approval_required');
    const next={...r,revision:r.revision+1,status:'approved' as const,authorityRevision:after.revision,approval:structuredClone(approval)};this.save(next,r.revision);return this.receipt(next);}
  async register(input:{consentId:string;expectedRevision:number}):Promise<GmailRegistrationReceipt>{let r=this.read(input.consentId);this.assertActor(r);
    if(r.status!=='approved'||r.revision!==input.expectedRevision||this.activating.has(r.consentId))deny('gmail_personal_consent_revision_conflict');
    if(this.active.has(r.consentId)){this.current(r,'gmail-register');return this.receipt(r);}this.activating.add(r.consentId);
    try {this.current(r,'gmail-register');const discovery=this.discovery(r.selection),id=`gmail-native:${personalDataHash([r.selection.target,r.selection.serverId,r.selection.expectedAccountRef,r.actor,r.proposalDigest,r.permissionRevision,r.audienceGrantRevision,r.credentialGeneration,r.contractDigest]).slice(0,32)}`;
      const consent={current:():GmailCurrentReadConsent=>{this.current(r,'gmail-read');return {principalRef:r.actor.principalId,sessionRevision:personalDataHash(r.actor),consentRevision:r.proposalDigest,permissionRevision:r.permissionRevision,credentialGeneration:r.credentialGeneration,
        audienceGrantRevision:r.audienceGrantRevision,purpose:r.selection.purpose,query:r.selection.query,labelIds:[...r.selection.labelIds],allowMessageBody:r.selection.allowMessageBody,allowHistory:r.selection.allowHistory};},
        assertRead:()=>{this.current(r,'gmail-read');},assertAccount:(i:{accountRef:string})=>{this.current(r,'gmail-account');if(i.accountRef!==r.selection.expectedAccountRef)deny('gmail_personal_account_mismatch');}};
      const native:GmailPersonalNativePorts={...this.ports.sourceNative,testServerById:async serverId=>{this.current(r,'gmail-discover');const status=await (this.ports.discoverPrepared?this.ports.discoverPrepared(serverId,this.current(r,'gmail-discover').prepared!):this.ports.sourceNative.testServerById(serverId));this.current(r,'gmail-discover');
        for(const [name,digest] of Object.entries(r.toolDigests)){const t=status.tools.filter(t=>t.name===name);if(t.length!==1||this.ports.sourceNative.schemaDigest(t[0])!==digest)deny('gmail_personal_schema_changed');}return status;}};
      const prepared=await createInstalledGmailPersonalSource({serverId:r.selection.serverId,target:r.selection.target,connectorId:id,consent,native,codecs:discovery.discovery.codecs,history:discovery.discovery.history,
        callOptions:()=>({prepared:this.current(r,'gmail-provider').prepared!})});this.current(r,'gmail-register');
      const stop=native.registerSource(id,{label:'Gmail · native approved read scope',port:prepared.port,assertConsent:prepared.assertConsent});this.active.set(r.consentId,stop);
      try{const binding=prepared.port.binding(r.selection.target),existing=this.ports.sourceState(r.selection.target,binding.sourceId);
        if(existing&&personalDataHash(existing.binding)!==personalDataHash(binding))deny('gmail_personal_source_binding_changed');
        const source=existing??this.ports.service.registerSource(r.selection.target,id);
        if(source.status==='paused'||source.status==='disconnected')this.ports.service.sourceControl({target:r.selection.target,sourceId:binding.sourceId,action:'resume',expectedRevision:source.revision});
        const next={...r,revision:r.revision+1,sourceId:binding.sourceId};this.save(next,r.revision);r=next;return this.receipt(r);
      }catch(e){stop();this.active.delete(r.consentId);throw e;}
    }finally{this.activating.delete(r.consentId);}}
  private receipt(r:Ledger):GmailRegistrationReceipt{return {consentId:r.consentId,revision:r.revision,status:r.status,sourceId:r.sourceId,sourceStatus:r.sourceId?this.ports.sourceState(r.selection.target,r.sourceId)?.status??null:null};}
  private stop(r:Ledger):void{this.active.get(r.consentId)?.();this.active.delete(r.consentId);
    if(r.sourceId){const s=this.ports.sourceState(r.selection.target,r.sourceId);if(s)this.ports.service.sourceControl({target:r.selection.target,sourceId:r.sourceId,action:'pause',expectedRevision:s.revision});}}
  pause(input:{consentId:string;expectedRevision:number}):GmailRegistrationReceipt{return this.terminal(input,'paused');}
  revoke(input:{consentId:string;expectedRevision:number}):GmailRegistrationReceipt{return this.terminal(input,'revoked');}
  private terminal(input:{consentId:string;expectedRevision:number},status:'paused'|'revoked'):GmailRegistrationReceipt{const r=this.read(input.consentId);this.assertActor(r,true);if(r.revision!==input.expectedRevision||r.status==='revoked')deny('gmail_personal_consent_revision_conflict');
    const next={...r,revision:r.revision+1,status};this.save(next,r.revision);this.stop(next);return this.receipt(next);}
  resume(input:{consentId:string;expectedRevision:number}):GmailRegistrationReceipt{const r=this.read(input.consentId);this.assertActor(r);if(r.status!=='paused'||r.revision!==input.expectedRevision)deny('gmail_personal_consent_revision_conflict');this.current(r,'gmail-resume');
    const next={...r,revision:r.revision+1,status:'approved' as const};this.save(next,r.revision);return this.receipt(next);}
  configureIntake(input:{consentId:string;expectedRevision:number;subscriptionRevision:number;enabled:boolean}):{subscriptionId:string;revision:number;enabled:boolean}{const r=this.read(input.consentId);this.assertActor(r);if(r.revision!==input.expectedRevision||!r.sourceId)deny('gmail_personal_consent_revision_conflict');
    if(input.enabled){this.current(r,'gmail-intake');if(r.status!=='approved'||!this.active.has(r.consentId))deny('gmail_personal_registration_required');}
    return this.subscriptions.configure({target:r.selection.target,sourceId:r.sourceId,budgetId:r.selection.budgetId},input.subscriptionRevision,input.enabled);}
  /** Main session/grant/generation/config events call this; no provider or passive profile read. */
  invalidateCurrent():void{for(const id of [...this.active.keys()]){const r=this.read(id);try{this.current(r,'gmail-current');}catch{try{this.stop(r);}catch{/* Consent/provider remains denied even if native pause outcome is uncertain. */}}}}
  close():void{this.subscriptions.close();for(const id of [...this.active.keys()]){try{this.stop(this.read(id));}catch{this.active.get(id)?.();this.active.delete(id);}}}
}

export interface NativeGmailRegistrationOptions {
  discovery:GmailRegistrationPorts['discovery'];custody:GmailRegistrationPorts['custody'];personalAuthority:OneActionAuthorityPort;
  selections?:GmailRegistrationPorts['selections'];
  reviewNative:GmailRegistrationPorts['reviewNative'];subscribeOwnerWake:GmailRegistrationPorts['subscribeOwnerWake'];
}
/** Main supplies consent review, current custody, native cached discovery and existing timer subscription.
 * Unbound Business is unknown through currentOneActionAuthority; no synchronous cached async allow. */
export async function createNativeGmailPersonalRegistration(options:NativeGmailRegistrationOptions):Promise<GmailPersonalRegistrationService>{
  const [store,auth,profile,host,registry,client,schema,runtime,supervisor,authority]=await Promise.all([import('../store/db'),import('../auth'),import('../store/one-profile'),import('../one/host-identity'),import('../mcp-tools/registry'),import('../mcp-tools/client'),import('../mcp-tools/tool-schema'),import('../one/personal-data-runtime'),import('../one/supervisor'),import('../one/action-authority')]);
  const db=store.getDb(),service=runtime.onePersonalDataNativeService();
  const actor=():GmailRegistrationActor=>{const s=auth.getAuthenticatedSessionBinding();if(!s||s.expiresAt!==null&&s.expiresAt<=Date.now())deny('gmail_personal_sign_in_required');return {principalId:s.userId,sessionId:s.sessionId,workspaceId:s.workspaceId,oneId:profile.getOneProfile().oneId,hostId:host.oneNativeHostIdentity().hostId};};
  const assertTarget=(target:PersonalDataTarget,a:GmailRegistrationActor)=>{const acl=db.prepare('SELECT principal_id FROM one_personal_data_acl WHERE target_key=?').get(personalDataHash(target)) as {principal_id:string}|undefined;if(!acl||acl.principal_id!==a.principalId)deny('gmail_personal_target_acl_denied');};
  const assertBudget=(i:PersonalDataCollectInput)=>{const b=supervisor.oneSupervisor().budgets({oneId:i.target.oneId,budgetId:i.budgetId})[0];if(!b||b.limitUsd!==null&&(b.availableUsd??0)<b.reserveUsd)deny('gmail_personal_budget_unavailable');};
  const sourceNative:GmailPersonalNativePorts={db,getServer:registry.getServer,schemaDigest:schema.mcpToolSchemaDigest,call:async(server,name,args,options)=>{const prepared=options.prepared;if(!prepared||personalDataHash(prepared.server)!==personalDataHash(server))deny('gmail_personal_prepared_config_changed');return client.callServerToolContent(prepared.server,name,args,options);},registerSource:runtime.registerOnePersonalSource,
    testServerById:async()=>deny('gmail_personal_scoped_discovery_required')};
  return new GmailPersonalRegistrationService({db,actor,listInstalled:registry.listInstalledServers,discovery:options.discovery,selections:options.selections,custody:options.custody,authority:{current:request=>authority.currentOneActionAuthority(request,options.personalAuthority)},
    reviewNative:options.reviewNative,assertTarget,assertBudget,sourceNative,service,discoverPrepared:async(id,prepared)=>{const server=registry.getServer(id);if(!server||prepared.server.id!==id||personalDataHash(prepared.server)!==personalDataHash(server))deny('gmail_personal_prepared_config_changed');return client.testServerConnection(prepared.server,{prepared});},subscribeOwnerWake:options.subscribeOwnerWake,
    sourceState:(target,sourceId)=>{const row=db.prepare('SELECT value_json FROM one_personal_data_sources WHERE target_key=? AND source_id=?').get(personalDataHash(target),sourceId) as {value_json:string}|undefined;return row?JSON.parse(row.value_json) as PersonalDataSourceState:null;}});
}
