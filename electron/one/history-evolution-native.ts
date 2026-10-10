import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { SupervisorRequestRow } from './supervisor-store';
import { assertNativeHistoryBudgetProof, type NativeHistoryBudgetProof, type NativeHistoryBudgetRequest } from './history-native-budget-glue';
import type { PersonalDataSourcePort } from './personal-data-connector';
import type { PersonalDataTarget, PersonalDataProposal, PersonalDataTaskAnchor, PersonalDataWriteReceipt, PersonalDataSourceBinding, PersonalDataProvenance } from '../../shared/one-personal-data';
import type { HistoryEvolutionCandidate, HistoryEvolutionDraft, EvolutionEnvelope } from '../../shared/one-history-evolution';
import type { OneActionAuthorityPort, OneActionAuthorityRequest } from '../../shared/one-authority';
import type { SupervisorCommandReceipt, SupervisorControlInput, SupervisorWorkInput } from '../../shared/one-supervisor';
import type { OneSurfaceManifestV1 } from '../../shared/one-surface';
import { OneHistoryEvolutionService, createAgentWorkspaceHistoryEvolutionAssets, createComputerHistoryEvolutionSource, historyEvolutionReviewHash, type HistoryEvolutionPorts } from './history-evolution';
import { OnePersonalDataStore, personalDataHash, personalDataId, personalDataError } from './personal-data-store';

export interface NativeHistoryActor {principalId:string;sessionId:string;workspaceId:string;oneId:string;hostId:string}
export interface NativeHistoryExactManifest {commandId:string;taskId:string;runId:string;chatId:string;controlVersion:string;manifest:OneSurfaceManifestV1;manifestDigest:string;text:string}
export interface NativeHistoryApprovedReview {approvalId:string;candidateId:string;revision:number;reviewedHash:string;actorDigest:string;authorityRevision:string}
export interface NativeHistoryArtifact {anchor:PersonalDataTaskAnchor;readBackVerified:true}
export interface NativeHistoryEvolutionPorts {
  db:Database.Database;actor():NativeHistoryActor;
  registerProvenance(id:string,registration:{label:string;port:PersonalDataSourcePort;assertConsent(target:PersonalDataTarget):string}):()=>void;assertTarget(target:PersonalDataTarget,actor:NativeHistoryActor):void;
  policy:HistoryEvolutionPorts['policy'];organizationAuthorityConnected():boolean;
  history:HistoryEvolutionPorts['history'];evaluator:HistoryEvolutionPorts['evaluator']|null;
  supervisor:{startWork(input:SupervisorWorkInput):SupervisorCommandReceipt;control(input:SupervisorControlInput):SupervisorCommandReceipt|Promise<SupervisorCommandReceipt>;receipt(input:{oneId:string;commandId:string}):SupervisorCommandReceipt|null};
  /** Existing ambient One invocation, provider budget and native task/run/control custody, not a renderer claim. */
  assertProducerCustody(input:{commandId:string;taskId:string;runId:string;chatId:string}):void;
  assertProducerAssetScope(input:{kind:'skill'|'toolchain'|'agent';request:unknown;envelope:EvolutionEnvelope}):void;
  exactManifest(target:PersonalDataTarget,commandId:string):Promise<NativeHistoryExactManifest|null>;
  /** Parent reuses its exact immutable Page artifact producer/ledger. Missing adapter is unavailable. */
  materialize(target:PersonalDataTarget,exact:NativeHistoryExactManifest):Promise<NativeHistoryArtifact|null>|null;
  agentWorkspace:Omit<Parameters<typeof createAgentWorkspaceHistoryEvolutionAssets>[0],'collectGeneratedChange'>;
  producedAgentChange(input:{target:PersonalDataTarget;commandId:string;candidateId:string;exact:NativeHistoryExactManifest}):Promise<Awaited<ReturnType<Parameters<typeof createAgentWorkspaceHistoryEvolutionAssets>[0]['collectGeneratedChange']>>>;
  /** Optional actual frozen Toolchain/plugin asset adapter; never use publishToolchainVersion's live validation as the local oracle. */
  otherAssets?:HistoryEvolutionPorts['assets'];
  reviewNative(input:{actor:NativeHistoryActor;candidate:HistoryEvolutionCandidate;reviewedHash:string;authorityRevision:string}):Promise<NativeHistoryApprovedReview|null>;
  reviewFeedbackNative(input:{actor:NativeHistoryActor;candidate:HistoryEvolutionCandidate;proposal:PersonalDataProposal;authorityRevision:string}):Promise<{proposalId:string;proposalDigest:string;actorDigest:string;authorityRevision:string;proofRef:string}|null>;
}
interface NativeHistoryBinding {commandId:string;candidateId:string;target:PersonalDataTarget;revision:number;envelopeDigest:string;purpose:'draft'|'run';actor:NativeHistoryActor}
function unavailable(code='history_native_adapter_unavailable'):never{throw personalDataError(code);}
/** Concrete Main adapter. Every draft/run admission uses the EXISTING Supervisor and queue. */
export class NativeHistoryEvolutionService {
  private readonly store:OnePersonalDataStore;private readonly core:OneHistoryEvolutionService;private readonly provenanceStops=new Map<string,()=>void>();
  constructor(private readonly ports:NativeHistoryEvolutionPorts){
    this.store=new OnePersonalDataStore(ports.db);ports.db.exec(`CREATE TABLE IF NOT EXISTS one_history_native_bindings(command_id TEXT PRIMARY KEY,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_history_native_candidates(candidate_id TEXT PRIMARY KEY,actor_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_history_native_feedback(candidate_id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL,receipt_json TEXT NOT NULL);`);
    const workspace=createAgentWorkspaceHistoryEvolutionAssets({...ports.agentWorkspace,collectGeneratedChange:async input=>{
      this.assertCommand(input.commandId);const exact=await ports.exactManifest(input.target,input.commandId);this.assertCommand(input.commandId);if(!exact)unavailable('history_native_exact_manifest_required');
      this.verifyExact(input.commandId,exact);const generated=await ports.producedAgentChange({...input,exact});this.assertCommand(input.commandId);return generated;}});
    const assetPort=(d:HistoryEvolutionDraft)=>d.producer==='agent-workspace'?workspace:ports.otherAssets??unavailable('history_native_asset_adapter_required');
    const policy:HistoryEvolutionPorts['policy']={current:target=>{this.assertTarget(target);return ports.policy.current(target);},check:input=>{
      this.assertTarget(input.target);if(input.candidateId){const row=ports.db.prepare('SELECT actor_json FROM one_history_native_candidates WHERE candidate_id=?').get(input.candidateId) as {actor_json:string}|undefined;
        if(!row&&ports.db.prepare('SELECT 1 FROM one_history_evolution_candidates WHERE candidate_id=?').get(input.candidateId))unavailable('history_native_candidate_actor_required');
        if(row&&personalDataHash(JSON.parse(row.actor_json))!==personalDataHash(ports.actor()))unavailable('history_native_session_changed');}return ports.policy.check(input);}};
    this.core=new OneHistoryEvolutionService({store:this.store,deploymentId:ports.actor().hostId,oneId:()=>ports.actor().oneId,
      get organizationAuthorityConnected(){return ports.organizationAuthorityConnected();},policy,history:{assertCurrent:(target,o)=>{this.assertTarget(target);ports.history.assertCurrent(target,o);},observe:async(target,max)=>{const before=structuredClone(ports.actor());this.assertTarget(target);const observations=await ports.history.observe(target,max);this.assertTarget(target);if(personalDataHash(before)!==personalDataHash(ports.actor()))unavailable('history_native_session_changed');return observations;}},
      supervisor:{...ports.supervisor,bindExecution:input=>{const binding:NativeHistoryBinding={...input,actor:structuredClone(ports.actor())};const json=JSON.stringify(binding);
        const prior=ports.db.prepare('SELECT value_json FROM one_history_native_bindings WHERE command_id=?').get(input.commandId) as {value_json:string}|undefined;
        if(prior&&prior.value_json!==json)unavailable('history_native_command_conflict');ports.db.prepare('INSERT OR IGNORE INTO one_history_native_bindings VALUES(?,?)').run(input.commandId,json);}},
      evaluator:{oracle:()=>ports.evaluator?.oracle()??unavailable('history_native_frozen_oracle_required'),evaluate:i=>ports.evaluator?.evaluate(i)??unavailable('history_native_frozen_oracle_required')},
      assets:{collectExactDraft:async i=>{const d=await workspace.collectExactDraft(i);return d??await ports.otherAssets?.collectExactDraft(i)??null;},assertCurrentDraft:i=>assetPort(i.draft).assertCurrentDraft(i),
        consumeApproval:i=>ports.agentWorkspace.consumeOwnerApproval(i),applyReviewed:i=>assetPort(i.draft).applyReviewed(i),restoreAsNewDraft:i=>{const d=this.candidate(i.target,i.candidateId).draft;return d?assetPort(d).restoreAsNewDraft(i):workspace.restoreAsNewDraft(i);}},
      pages:{writeExactFeedback:async i=>{this.assertCommand(i.commandId);const row=ports.db.prepare('SELECT receipt_json FROM one_history_native_feedback WHERE candidate_id=?').get(i.candidateId) as {receipt_json:string}|undefined;
        if(!row)unavailable('history_native_feedback_review_required');const receipt=JSON.parse(row.receipt_json) as PersonalDataWriteReceipt;
        const page=this.store.page(i.target);if(!page||page.revision!==receipt.revision||page.digest!==receipt.digest||page.acceptedAnchor?.commandId!==i.commandId)unavailable('history_native_feedback_revision_changed');
        return {anchor:page.acceptedAnchor,receipt};}}});
  }
  private assertTarget(t:PersonalDataTarget):void{const a=this.ports.actor();if(t.oneId!==a.oneId||t.deploymentId!==a.hostId)unavailable('history_native_target_mismatch');this.ports.assertTarget(t,a);}
  private candidate(target:PersonalDataTarget,id:string,terminal=false):HistoryEvolutionCandidate{this.assertTarget(target);const row=this.ports.db.prepare('SELECT target_key,value_json FROM one_history_evolution_candidates WHERE candidate_id=?').get(personalDataId(id)) as {target_key:string;value_json:string}|undefined;
    if(!row||row.target_key!==this.store.key(target))unavailable('history_native_candidate_missing');const actor=this.ports.db.prepare('SELECT actor_json FROM one_history_native_candidates WHERE candidate_id=?').get(id) as {actor_json:string}|undefined;
    if(!actor)unavailable('history_native_session_changed');const original=JSON.parse(actor.actor_json) as NativeHistoryActor,current=this.ports.actor();
    if(personalDataHash(terminal?{...original,sessionId:''}:original)!==personalDataHash(terminal?{...current,sessionId:''}:current))unavailable('history_native_session_changed');return JSON.parse(row.value_json) as HistoryEvolutionCandidate;}
  private authority(c:HistoryEvolutionCandidate,action:'accept'|'run'):string{this.assertTarget(c.target);const p=this.ports.policy.check({target:c.target,candidateId:c.candidateId,action,sourceRefs:c.observations.map(o=>o.sourceRef),envelopeDigest:personalDataHash(c.envelope)});if(p.decision!=='allow'||!p.revision)unavailable('history_native_current_policy_required');return p.revision;}
  private binding(commandId:string):NativeHistoryBinding{const row=this.ports.db.prepare('SELECT value_json FROM one_history_native_bindings WHERE command_id=?').get(personalDataId(commandId)) as {value_json:string}|undefined;if(!row)unavailable('history_native_original_command_required');return JSON.parse(row.value_json) as NativeHistoryBinding;}
  assertCommand(commandId:string):void{const b=this.binding(commandId);if(personalDataHash(b.actor)!==personalDataHash(this.ports.actor()))unavailable('history_native_session_changed');this.assertTarget(b.target);this.core.assertExecutionAuthority(b);}
  readBoundObservations(input:{commandId:string;taskId:string;runId:string;chatId:string}){this.ports.assertProducerCustody(input);this.assertCommand(input.commandId);const b=this.binding(input.commandId);return this.core.readBoundObservations({target:b.target,candidateId:b.candidateId,commandId:b.commandId});}
  snapshot(input:{target:PersonalDataTarget}){return this.core.snapshot(input);}
  async observe(input:{target:PersonalDataTarget;predecessorId?:string}):Promise<HistoryEvolutionCandidate>{const before=structuredClone(this.ports.actor());if(input.predecessorId)this.candidate(input.target,input.predecessorId);const c=await this.core.observe(input);
    if(personalDataHash(before)!==personalDataHash(this.ports.actor()))unavailable('history_native_session_changed');this.ports.db.prepare('INSERT OR IGNORE INTO one_history_native_candidates VALUES(?,?)').run(c.candidateId,JSON.stringify(before));this.candidate(c.target,c.candidateId);return c;}
  draft(input:Parameters<OneHistoryEvolutionService['draft']>[0]){this.candidate(input.target,input.candidateId);return this.core.draft(input);}
  collectDraft(input:Parameters<OneHistoryEvolutionService['collectDraft']>[0]){this.candidate(input.target,input.candidateId);return this.core.collectDraft(input);}
  evaluate(input:Parameters<OneHistoryEvolutionService['evaluate']>[0]){this.candidate(input.target,input.candidateId);return this.core.evaluate(input);}
  async acceptNative(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number}):Promise<HistoryEvolutionCandidate>{const c=this.candidate(input.target,input.candidateId),a=structuredClone(this.ports.actor()),reviewedHash=historyEvolutionReviewHash(c),revision=this.authority(c,'accept');
    if(c.revision!==input.expectedRevision||c.status!=='evaluated')unavailable('history_native_review_revision_conflict');const approval=await this.ports.reviewNative({actor:a,candidate:structuredClone(c),reviewedHash,authorityRevision:revision});
    this.candidate(input.target,input.candidateId);if(!approval||approval.candidateId!==c.candidateId||approval.revision!==c.revision||approval.reviewedHash!==reviewedHash||approval.actorDigest!==personalDataHash(this.ports.actor())
      ||approval.authorityRevision!==revision||this.authority(c,'accept')!==revision)unavailable('history_native_approval_required');return this.core.accept({...input,reviewedHash,approvalId:approval.approvalId});}
  run(input:Parameters<OneHistoryEvolutionService['run']>[0]){this.candidate(input.target,input.candidateId);return this.core.run(input);}
  private verifyExact(commandId:string,exact:NativeHistoryExactManifest):void{const b=this.binding(commandId),r=this.ports.supervisor.receipt({oneId:b.target.oneId,commandId});
    if(!r?.taskId||!r.runId||exact.commandId!==commandId||exact.taskId!==r.taskId||exact.runId!==r.runId||exact.manifest.taskId!==r.taskId||exact.manifestDigest!==personalDataHash(exact.manifest)||!exact.chatId||!exact.controlVersion)unavailable('history_native_exact_manifest_required');}
  private ensureProvenance(c:HistoryEvolutionCandidate):{bindings:PersonalDataSourceBinding[];provenance:PersonalDataProvenance}{
    if(!c.runCommandId||!c.observations.length)unavailable('history_native_provenance_required');
    const binding:PersonalDataSourceBinding={sourceId:`he-source:${personalDataHash([c.target,c.candidateId])}`,connectorId:`he-source:${personalDataHash([c.target,c.candidateId])}`,
      accountRef:`history-account:${personalDataHash(this.ports.actor())}`,permissionRevision:personalDataHash(c.observations.map(o=>[o.sourceRef,o.permissionRevision,o.consentRevision,o.environmentRevision])),
      credentialGeneration:`history-consent:${personalDataHash([this.ports.actor(),c.observations.map(o=>o.consentRevision)])}`,purpose:'permitted-history-evolution-feedback',coverage:'bounded-search'};
    const sourceRevision=`history-evidence:${personalDataHash(c.observations)}`,check=(target:PersonalDataTarget)=>{if(personalDataHash(target)!==personalDataHash(c.target))unavailable('history_native_target_mismatch');const current=this.candidate(target,c.candidateId);
      if(['paused','revoked','deleted','unknown'].includes(current.status))unavailable('history_native_source_not_active');const observations=this.core.readBoundObservations({target,candidateId:c.candidateId,commandId:c.runCommandId!});
      if(personalDataHash(observations)!==personalDataHash(c.observations))unavailable('history_native_source_changed');return binding;};
    check(c.target);let registered=false;
    if(!this.provenanceStops.has(binding.connectorId)){const stop=this.ports.registerProvenance(binding.connectorId,{label:'History · exact permitted result provenance',port:{schema:'agentlas.personal-source-port.v1',binding:check,
      read:async()=>unavailable('history_native_provenance_read_disabled')},assertConsent:target=>{check(target);return personalDataHash([binding,c.envelope]);}});this.provenanceStops.set(binding.connectorId,stop);registered=true;}
    try {const existing=this.store.source(c.target,binding.sourceId);if(existing){if(personalDataHash(existing.binding)!==personalDataHash(binding)||existing.sourceRevision!==sourceRevision)unavailable('history_native_source_changed');}
      else this.store.setSource({target:c.target,binding,cursor:null,sourceRevision,observedAt:c.observations[0].observedAt,status:'ready',revision:0,reason:'native_history_observation_receipt'},0,c.observations.map(o=>({id:o.sourceRef,revision:o.revision,sourceRef:o.sourceRef,text:o.summary,deleted:false})));
    }catch(e){if(registered){this.provenanceStops.get(binding.connectorId)?.();this.provenanceStops.delete(binding.connectorId);}throw e;}
    return {bindings:[binding],provenance:{occurrenceId:c.candidateId,sourceRevision,observedAt:c.observations[0].observedAt,binding}};
  }
  /** Explicit native Page-read route restores its durable provenance ports through CURRENT grants, without History/provider reads. */
  restorePageProvenance(target:PersonalDataTarget):number{const snapshot=this.core.snapshot({target});let count=0;for(const c of snapshot.candidates)if(c.runCommandId&&c.observations.length&&['running','feedback'].includes(c.status)){this.ensureProvenance(c);count++;}return count;}
  close():void{for(const stop of this.provenanceStops.values())stop();this.provenanceStops.clear();}
  async proposeFeedback(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number}):Promise<PersonalDataProposal>{const c=this.candidate(input.target,input.candidateId);
    if(c.revision!==input.expectedRevision||c.status!=='running'||!c.runCommandId||!c.draft)unavailable('history_native_review_revision_conflict');this.assertCommand(c.runCommandId);
    const revision=this.authority(c,'run'),exact=await this.ports.exactManifest(c.target,c.runCommandId);this.assertCommand(c.runCommandId);if(!exact)unavailable('history_native_exact_manifest_required');this.verifyExact(c.runCommandId,exact);
    const artifact=await this.ports.materialize(c.target,exact)??unavailable('history_native_artifact_materializer_required');this.assertCommand(c.runCommandId);
    if(this.authority(c,'run')!==revision||artifact.readBackVerified!==true||artifact.anchor.commandId!==exact.commandId||artifact.anchor.taskId!==exact.taskId||artifact.anchor.runId!==exact.runId||artifact.anchor.chatId!==exact.chatId||artifact.anchor.controlVersion!==exact.controlVersion||artifact.anchor.artifactRevision!==exact.manifest.manifestId||artifact.anchor.artifactDigest!==createHash('sha256').update(exact.text,'utf8').digest('hex'))unavailable('history_native_feedback_anchor_mismatch');
    return this.store.atomic(()=>{this.assertCommand(c.runCommandId!);const page=this.store.page(c.target);if(!page)unavailable('history_native_page_required');const proposalId=`he-feedback:${personalDataHash([c.candidateId,c.revision,page.revision,artifact.anchor])}`;
      const evidence=this.ensureProvenance(c),prior=this.store.proposal(c.target,proposalId);if(prior)return prior;return this.store.putProposal({proposalId,target:c.target,baseRevision:page.revision,blocks:[{id:`he-block:${c.candidateId}`,kind:'inference',text:exact.text,sourceRefs:c.observations.map(o=>o.sourceRef),provenance:evidence.provenance}],anchor:artifact.anchor,sourceBindings:evidence.bindings,status:'pending',createdAt:new Date().toISOString(),acceptedRevision:null});});}
  async acceptFeedbackNative(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;proposalId:string;expectedPageRevision:number;commandId:string}):Promise<HistoryEvolutionCandidate>{const c=this.candidate(input.target,input.candidateId),p=this.store.proposal(c.target,input.proposalId);
    if(c.revision!==input.expectedRevision||!c.runCommandId||p?.status!=='pending'||p.baseRevision!==input.expectedPageRevision||p.anchor.commandId!==c.runCommandId)unavailable('history_native_review_revision_conflict');
    this.assertCommand(c.runCommandId);const revision=this.authority(c,'run'),actor=structuredClone(this.ports.actor()),approval=await this.ports.reviewFeedbackNative({actor,candidate:structuredClone(c),proposal:structuredClone(p),authorityRevision:revision});
    this.assertCommand(c.runCommandId);if(!approval||approval.proposalId!==p.proposalId||approval.proposalDigest!==personalDataHash(p)||approval.actorDigest!==personalDataHash(this.ports.actor())||approval.authorityRevision!==revision||!approval.proofRef||this.authority(c,'run')!==revision)unavailable('history_native_feedback_approval_required');
    const exact=await this.ports.exactManifest(c.target,c.runCommandId);this.assertCommand(c.runCommandId);if(!exact)unavailable('history_native_exact_manifest_required');this.verifyExact(c.runCommandId,exact);
    const artifact=await this.ports.materialize(c.target,exact)??unavailable('history_native_artifact_materializer_required');this.assertCommand(c.runCommandId);
    if(personalDataHash(artifact.anchor)!==personalDataHash(p.anchor)||this.authority(c,'run')!==revision)unavailable('history_native_feedback_anchor_mismatch');
    this.store.atomic(()=>{this.assertCommand(c.runCommandId!);const page=this.store.page(c.target);if(!page||page.revision!==input.expectedPageRevision||this.store.proposal(c.target,p.proposalId)?.status!=='pending')unavailable('history_native_feedback_revision_changed');
      const receipt=this.store.write({commandId:input.commandId,target:c.target,expectedRevision:page.revision,title:page.title,blocks:[...page.blocks.filter(b=>!p.blocks.some(x=>x.id===b.id)),...p.blocks],origin:'proposal',anchor:p.anchor,intent:{...input,proposalDigest:personalDataHash(p)}});
      this.store.putProposal({...p,status:'accepted',acceptedRevision:receipt.revision});this.ports.db.prepare('INSERT INTO one_history_native_feedback VALUES(?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET proposal_id=excluded.proposal_id,receipt_json=excluded.receipt_json').run(c.candidateId,p.proposalId,JSON.stringify(receipt));});
    return this.core.feedback({target:c.target,candidateId:c.candidateId,expectedRevision:c.revision});}
  reconcileFeedback(input:Parameters<OneHistoryEvolutionService['feedback']>[0]){this.candidate(input.target,input.candidateId);return this.core.feedback(input);}
  async control(input:Parameters<OneHistoryEvolutionService['control']>[0]){const terminal=input.action!=='resume';this.candidate(input.target,input.candidateId,terminal);const c=await this.core.control(input);
    // Stopping remains independent of source/session grants; terminal replies carry no revoked source bytes.
    return terminal?{...c,observations:[],draft:null,evaluation:null,feedback:null,anchor:null,envelope:{...c.envelope,sourceIds:[],toolRefs:[],resourceRefs:[]}}:c;}
  async restore(input:Parameters<OneHistoryEvolutionService['restore']>[0]){this.candidate(input.target,input.candidateId);const c=await this.core.restore(input);this.ports.db.prepare('INSERT INTO one_history_native_candidates VALUES(?,?)').run(c.candidateId,JSON.stringify(this.ports.actor()));return c;}
  /** Worker-only reuse of actual existing builder interfaces, inside its original One invocation. */
  async withBoundBuilders<T>(input:{commandId:string;taskId:string;runId:string;chatId:string},execute:(ports:{plugin:Pick<typeof import('../plugins/builder'),'startPluginBuilder'|'draftPluginBuilder'>;toolchain:Pick<typeof import('../toolchains/generalizer'),'generateToolchain'>;agent:Pick<typeof import('../hephaestus/builder'),'runHephaestusBuild'>;assertCurrent():void})=>Promise<T>):Promise<T>{
    this.ports.assertProducerCustody(input);this.assertCommand(input.commandId);const b=this.binding(input.commandId),r=this.ports.supervisor.receipt({oneId:b.target.oneId,commandId:b.commandId});if(r?.taskId!==input.taskId||r?.runId!==input.runId||b.purpose!=='draft')unavailable('history_native_original_command_required');
    const [plugin,toolchain,agent,pluginStore]=await Promise.all([import('../plugins/builder'),import('../toolchains/generalizer'),import('../hephaestus/builder'),import('../store/plugin-builder')]);
    const fence=()=>{this.ports.assertProducerCustody(input);this.assertCommand(input.commandId);};fence();
    const scope=(kind:'skill'|'toolchain'|'agent',request:unknown)=>{fence();const envelope=this.candidate(b.target,b.candidateId).envelope;if(!envelope.allowedKinds.includes(kind))unavailable('history_native_asset_outside_envelope');if(b.target.organizationId!==null)unavailable('history_native_scoped_builder_adapter_required');this.ports.assertProducerAssetScope({kind,request,envelope});};
    const bound={plugin:{startPluginBuilder:async(i:Parameters<typeof plugin.startPluginBuilder>[0])=>{if(i.chatId!==input.chatId)unavailable('history_native_original_command_required');scope('skill',i);const v=await plugin.startPluginBuilder(i);fence();return v;},
      draftPluginBuilder:async(i:Parameters<typeof plugin.draftPluginBuilder>[0])=>{if(pluginStore.getPluginBuilderSession(i.sessionId)?.chatId!==input.chatId)unavailable('history_native_original_command_required');scope('skill',i);const v=await plugin.draftPluginBuilder(i);fence();return v;}},
      toolchain:{generateToolchain:async(i:Parameters<typeof toolchain.generateToolchain>[0],a:Parameters<typeof toolchain.generateToolchain>[1]={})=>{if(i.requestId!==input.commandId||(i.projectId??null)!==b.target.projectId)unavailable('history_native_original_command_required');scope('toolchain',i);const v=await toolchain.generateToolchain(i,{...a,callerChatId:input.chatId,assertCurrent:fence});fence();return v;}},
      agent:{runHephaestusBuild:async(...args:Parameters<typeof agent.runHephaestusBuild>)=>{if(args[0]!==input.runId)unavailable('history_native_original_command_required');scope('agent',args[1]);await agent.runHephaestusBuild(...args);fence();}},assertCurrent:fence};
    const result=await execute(bound);fence();return result;
  }
}

export interface NativeHistoryEvolutionOptions extends Pick<NativeHistoryEvolutionPorts,'evaluator'|'assertProducerCustody'|'assertProducerAssetScope'|'materialize'|'agentWorkspace'|'producedAgentChange'|'otherAssets'|'reviewNative'|'reviewFeedbackNative'> {
  envelope(target:PersonalDataTarget):EvolutionEnvelope;personalAuthority:OneActionAuthorityPort;
  /** Same native Supervisor budget instance/admission proof. Missing bound-run proof is deny. */
  nativeBudgetForCommand?(input:NativeHistoryBudgetRequest):NativeHistoryBudgetProof|null;
  scopedHistory?:HistoryEvolutionPorts['history'];
  historyConsent:Parameters<typeof createComputerHistoryEvolutionSource>[0]['current'];redactHistory(summary:string):string;sourceId:string;
}
/** No History/provider/ERP read at construction. All current Business policy remains synchronous and unbound is unknown. */
export async function createNativeHistoryEvolution(options:NativeHistoryEvolutionOptions):Promise<NativeHistoryEvolutionService>{const [store,auth,profile,host,supervisor,tasks,events,surface,presentation,authority,personalRuntime]=await Promise.all([import('../store/db'),import('../auth'),import('../store/one-profile'),import('./host-identity'),import('./supervisor'),import('../store/tasks'),import('../store/run-events'),import('../store/one-surface-results'),import('./supervisor-presentation'),import('./action-authority'),import('./personal-data-runtime')]);
  const db=store.getDb(),actor=():NativeHistoryActor=>{const s=auth.getAuthenticatedSessionBinding();if(!s||s.expiresAt!==null&&s.expiresAt<=Date.now())unavailable('history_native_sign_in_required');return {principalId:s.userId,sessionId:s.sessionId,workspaceId:s.workspaceId,oneId:profile.getOneProfile().oneId,hostId:host.oneNativeHostIdentity().hostId};};
  const assertTarget=(target:PersonalDataTarget,a:NativeHistoryActor)=>{const row=db.prepare('SELECT principal_id FROM one_personal_data_acl WHERE target_key=?').get(personalDataHash(target)) as {principal_id:string}|undefined;if(row?.principal_id!==a.principalId)unavailable('history_native_target_acl_denied');};
  const policy:HistoryEvolutionPorts['policy']={current:options.envelope,check:i=>{const a=actor(),e=options.envelope(i.target);assertTarget(i.target,a);const budget=supervisor.oneSupervisor().budgets({oneId:a.oneId,budgetId:e.budgetId})[0];if(!budget)return {decision:'deny',revision:''};
    const candidateId=i.candidateId==='pending'&&i.action==='observe'&&i.sourceRefs.length===0?undefined:i.candidateId;const candidateRow=candidateId?db.prepare('SELECT target_key,value_json FROM one_history_evolution_candidates WHERE candidate_id=?').get(candidateId) as {target_key:string;value_json:string}|undefined:undefined;
    if(candidateId&&!candidateRow&&i.action!=='observe')return {decision:'deny',revision:''};const c=candidateRow?JSON.parse(candidateRow.value_json) as HistoryEvolutionCandidate:null;
    if(c&&(candidateRow!.target_key!==personalDataHash(i.target)||personalDataHash(c.target)!==personalDataHash(i.target)||personalDataHash(c.envelope)!==personalDataHash(e)))return {decision:'deny',revision:''};
    const newAdmission=i.action==='draft'&&c?.status==='observed'||i.action==='run'&&c?.status==='accepted';
    if(newAdmission){if(budget.limitUsd!==null&&(budget.availableUsd??0)<budget.reserveUsd)return {decision:'deny',revision:''};}
    else if(c){const commandId=c.runCommandId??c.generationCommandId;if(commandId){const row=db.prepare('SELECT * FROM one_supervisor_requests WHERE command_id=? AND one_id=?').get(commandId,a.oneId) as SupervisorRequestRow|undefined;
      if(!row||row.task_id===null||row.run_id===null)return {decision:'deny',revision:''};
      const nativeBinding=db.prepare('SELECT value_json FROM one_history_native_bindings WHERE command_id=?').get(commandId) as {value_json:string}|undefined;if(!nativeBinding)return {decision:'deny',revision:''};
      const b=JSON.parse(nativeBinding.value_json) as NativeHistoryBinding;if(b.candidateId!==c.candidateId||personalDataHash(b.target)!==personalDataHash(i.target)||personalDataHash(b.actor)!==personalDataHash(a))return {decision:'deny',revision:''};
      // Before original queue admission there is no attempted reservation yet.
      if(row.state==='stored'){if(budget.limitUsd!==null&&(budget.availableUsd??0)<budget.reserveUsd)return {decision:'deny',revision:''};}
      else try{const request:NativeHistoryBudgetRequest={request:row,budgetId:e.budgetId,purpose:row.state==='completed'?'publication':'execution'};if(options.nativeBudgetForCommand){const proof=options.nativeBudgetForCommand(request);assertNativeHistoryBudgetProof(request,proof);if(proof!.policy.revision!==budget.revision)return {decision:'deny',revision:''};}
        else {const admitted=supervisor.currentOneNativeWorkBudget(row.command_id,e.budgetId);if(admitted?.admitted!==true||admitted.revision!==budget.revision)return {decision:'deny',revision:''};}}catch{return {decision:'deny',revision:''};}}}
    const request:OneActionAuthorityRequest={principalId:a.principalId,sessionId:a.sessionId,workspaceId:a.workspaceId,oneId:a.oneId,hostId:a.hostId,scope:i.target.scope,organizationId:i.target.organizationId,projectId:i.target.projectId,resourceId:`${i.target.spaceId}:${i.target.pageId}`,purpose:'permitted-history-evolution',payerId:a.principalId,action:`history-${i.action}`,taskId:null,runId:null,controlVersion:null,permissionRevision:e.policyRevision,credentialGeneration:null,sourceRefs:i.sourceRefs,audience:i.target.audience};return authority.currentOneActionAuthority(request,options.personalAuthority);}};
  return new NativeHistoryEvolutionService({...options,db,actor,assertTarget,policy,registerProvenance:personalRuntime.registerOnePersonalSource,organizationAuthorityConnected:authority.oneBusinessAuthorityConnected,
    history:options.scopedHistory??createComputerHistoryEvolutionSource({sourceId:options.sourceId,current:target=>{if(target.organizationId!==null)unavailable('history_native_scoped_source_adapter_required');return options.historyConsent(target);},redact:options.redactHistory}),supervisor:{startWork:i=>supervisor.oneSupervisor().startWork(i),control:i=>supervisor.oneSupervisor().control(i),receipt:i=>supervisor.oneSupervisor().receipt(i)},
    exactManifest:async(target,commandId)=>{assertTarget(target,actor());const row=db.prepare('SELECT * FROM one_supervisor_requests WHERE command_id=? AND one_id=?').get(commandId,target.oneId) as SupervisorRequestRow|undefined;
      if(!row?.task_id||!row.run_id)return null;const task=tasks.getCanonicalTask(row.task_id),receipt=events.getInvocationRunReceipt(row.run_id);
      if(!task?.originChatId||task.status!=='completed'||receipt?.status!=='completed'||receipt.chatId!==task.originChatId||!tasks.hasPassedTaskForceExecutionVerification(row.run_id))return null;
      const controlVersion=supervisor.currentOneNativeWorkControl(row,'result');if(!controlVersion)return null;
      const durable=surface.getDurableOneSurfaceResult({taskId:task.id,chatId:task.originChatId,runId:row.run_id}),text=presentation.supervisorExactResult(db,task.originChatId,row.run_id)?.text;if(!durable||!text)return null;
      return {commandId,taskId:task.id,runId:row.run_id,chatId:task.originChatId,controlVersion,manifest:durable.manifest,manifestDigest:personalDataHash(durable.manifest),text};}});
}
