import { ONE_PERSONAL_DATA_SCHEMA } from "../../shared/one-personal-data";
import type { PersonalDataTarget, PersonalDataSourceBinding, PersonalDataSourceState, PersonalDataTaskAnchor, PersonalDataSnapshot, PersonalDataCreateInput, PersonalDataEditInput, PersonalDataCollectInput, PersonalDataAcceptInput, PersonalDataFollowUpInput, PersonalDataCollectionReceipt, PersonalDataWriteReceipt, PersonalDataProposal, PersonalDataSourceItem } from "../../shared/one-personal-data";
import type { SupervisorCommandReceipt, SupervisorWorkInput, SupervisorFollowUpInput, SupervisorControlInput } from "../../shared/one-supervisor";
import { OnePersonalDataStore, personalDataBlocks, personalDataError, personalDataHash, personalDataId, personalDataTarget, personalDataText } from "./personal-data-store";
import { OnePersonalDataConnectorRegistry, PersonalDataConnectorError, validatePersonalDataBatch, validatePersonalDataBinding } from "./personal-data-connector";

export type PersonalDataAction = "source-read" | "inference" | "page-read" | "page-write" | "follow-up" | "source-control";
export interface PersonalDataAuthorityRequest { target: PersonalDataTarget; action: PersonalDataAction; sources: PersonalDataSourceBinding[]; anchor?: PersonalDataTaskAnchor; budgetId?: string }
/** Supplied by trusted Main. Cached renderer identity, admin status and unknown grants are never allow. */
export interface PersonalDataAuthorityPort { check(request: PersonalDataAuthorityRequest): { decision: "allow" | "deny" | "unknown"; revision: string; reason?: string } }
export interface PersonalDataExactResult { anchor: PersonalDataTaskAnchor; text: string; verified: true; state: "completed"; chatId: string }
export interface PersonalDataSupervisorPort {
  startWork(input: SupervisorWorkInput): SupervisorCommandReceipt;
  followUp(input: SupervisorFollowUpInput): SupervisorCommandReceipt;
  control(input: SupervisorControlInput): SupervisorCommandReceipt | Promise<SupervisorCommandReceipt>;
  receipt(input: {oneId:string;commandId:string}): SupervisorCommandReceipt | null;
  /** Resolve from native task/run/control/result manifests; never trust a renderer witness. */
  exactResult(target: PersonalDataTarget, commandId: string): PersonalDataExactResult | null;
  /** Queue claim/provider dispatch MUST call the current authority fence supplied by bindOccurrence. */
  bindOccurrence(input: { commandId: string; target: PersonalDataTarget; sourceBindings: PersonalDataSourceBinding[]; sourceRevision: number; budgetId: string }): void;
}
export interface OnePersonalDataDependencies {
  store: OnePersonalDataStore; connectors: OnePersonalDataConnectorRegistry;
  authority: PersonalDataAuthorityPort; supervisor: PersonalDataSupervisorPort;
  /** Exact host deployment is configured by Main, never a renderer choice. */
  deploymentId: string; oneId(): string; now?: () => string;
  /** Only set after connecting Business's authoritative current source/audience/organization ACL adapter. */
  organizationAuthorityConnected?: boolean;
}
function safeFailureCode(error:unknown):string {
  if(error instanceof PersonalDataConnectorError && ["invalid_cursor","disconnected","permission_changed","partial_failure","unavailable"].includes(error.code))return `personal_data_${error.code}`;
  const code=(error as {code?:unknown})?.code;
  return typeof code==="string" && /^(?:personal_data|supervisor_budget)_[a-z0-9_]{1,80}$/.test(code)?code:"personal_data_connector_unavailable";
}
/** Incremental intake delegates inference to the existing One Supervisor/queue and budget runtime. */
export class OnePersonalDataService {
  private readonly active = new Map<string,AbortController>();
  constructor(private readonly deps: OnePersonalDataDependencies) {}
  private now(): string { return this.deps.now?.() ?? new Date().toISOString(); }
  private target(raw: PersonalDataTarget): PersonalDataTarget {
    const t=personalDataTarget(raw);
    if(t.deploymentId!==this.deps.deploymentId || t.oneId!==this.deps.oneId())throw personalDataError("personal_data_identity_changed");
    return t;
  }
  private authorize(target: PersonalDataTarget, action: PersonalDataAction, sources: PersonalDataSourceBinding[] = [], anchor?: PersonalDataTaskAnchor, budgetId?: string): string {
    this.target(target);
    if(target.organizationId!==null && !this.deps.organizationAuthorityConnected)throw personalDataError("personal_data_organization_policy_required");
    const d=this.deps.authority.check({target,action,sources,...(anchor?{anchor}:{}),...(budgetId?{budgetId}:{})});
    if(d.decision!=="allow" || !d.revision)throw personalDataError(d.decision==="unknown"?"personal_data_authority_unknown":"personal_data_authority_denied");
    return d.revision;
  }
  private source(target: PersonalDataTarget, sourceId: string): PersonalDataSourceState {
    const s=this.deps.store.source(target,personalDataId(sourceId));if(!s)throw personalDataError("personal_data_source_missing");return s;
  }
  /** Host-only registration resolves a permitted installed connector; it never marks a connection ready. */
  registerSource(targetRaw: PersonalDataTarget, connectorId: string, expectedRevision=0): PersonalDataSourceState {
    const target=this.target(targetRaw), port=this.deps.connectors.get(connectorId), binding=validatePersonalDataBinding(port.binding(target));
    if(binding.connectorId!==connectorId)throw personalDataError("personal_data_binding_invalid");
    this.authorize(target,"source-read",[binding]);
    return this.deps.store.atomic(()=>{
      this.authorize(target,"source-read",[binding]);
      return this.deps.store.setSource({target,binding,cursor:null,sourceRevision:null,observedAt:null,status:"unread",revision:0,reason:null},expectedRevision,[]);
    });
  }
  snapshot(input: {target: PersonalDataTarget}): PersonalDataSnapshot {
    const target=this.target(input.target);this.authorize(target,"page-read");
    const sources=this.deps.store.sources(target);
    // Existing Page provenance can contain private source refs: authorize before returning its bytes.
    const page=this.deps.store.page(target),proposals=this.deps.store.proposals(target);
    const provenance=page?.blocks.flatMap(block=>block.provenance?[block.provenance.binding]:[])??[];
    // A replacement/narrower source grant cannot reauthorize older accepted or proposed bytes.
    this.authorize(target,"page-read",[...sources.map(s=>s.binding),...provenance,...proposals.flatMap(p=>p.sourceBindings)]);
    return {schema:ONE_PERSONAL_DATA_SCHEMA,target,page,space:this.deps.store.space(target),sources,proposals};
  }
  create(input: PersonalDataCreateInput): PersonalDataWriteReceipt {
    const target=this.target(input.target);personalDataId(input.commandId);personalDataText(input.text);personalDataText(input.title,500);
    return this.deps.store.atomic(()=>{this.authorize(target,"page-write");return this.deps.store.write({commandId:input.commandId,target,expectedRevision:0,title:input.title,
      blocks:[{id:"manual",kind:"manual",text:input.text,sourceRefs:[]}],origin:"create",intent:input});});
  }
  edit(input: PersonalDataEditInput): PersonalDataWriteReceipt {
    const target=this.target(input.target);personalDataId(input.commandId);personalDataText(input.text);personalDataText(input.title,500);
    return this.deps.store.atomic(()=>{this.authorize(target,"page-write",this.deps.store.sources(target).map(s=>s.binding));
      const page=this.deps.store.page(target);
      this.authorize(target,"page-write",page?.blocks.flatMap(block=>block.provenance?[block.provenance.binding]:[])??[]);
      if(!page)throw personalDataError("personal_data_page_missing");
      // Manual editor preserves the immutable inference blocks and their source provenance.
      return this.deps.store.write({commandId:input.commandId,target,expectedRevision:input.expectedRevision,title:input.title,
        blocks:[{id:"manual",kind:"manual",text:input.text,sourceRefs:[]},...page.blocks.filter(b=>b.kind==="inference")],origin:"manual",anchor:page.acceptedAnchor??undefined,intent:input});});
  }
  sourceControl(input: {target:PersonalDataTarget;sourceId:string;action:"pause"|"resume"|"disconnect"|"reset-cursor";expectedRevision:number}): PersonalDataSourceState {
    const target=this.target(input.target), source=this.source(target,input.sourceId);
    if(!["pause","resume","disconnect","reset-cursor"].includes(input.action))throw personalDataError("personal_data_control_invalid");
    // Abort is unconditional. Revoked authority must not prevent stopping an in-flight read.
    if(input.action==="pause"||input.action==="disconnect")this.active.get(`${this.deps.store.key(target)}:${input.sourceId}`)?.abort();
    return this.deps.store.atomic(()=>{
      if(input.action==="resume"||input.action==="reset-cursor")this.authorize(target,"source-control",[source.binding]);
      const next=input.action==="pause"?"paused":input.action==="disconnect"?"disconnected":"unread";
      return this.deps.store.setSource({...source,status:next,cursor:input.action==="reset-cursor"?null:source.cursor,reason:input.action},input.expectedRevision);
    });
  }
  async collect(input: PersonalDataCollectInput): Promise<PersonalDataCollectionReceipt> {
    const target=this.target(input.target), source=this.source(target,input.sourceId), budgetId=personalDataId(input.budgetId);
    if(["paused","disconnected","invalid_cursor","permission_changed"].includes(source.status))throw personalDataError("personal_data_source_not_active");
    if(!this.deps.store.page(target))throw personalDataError("personal_data_page_missing");
    const port=this.deps.connectors.get(source.binding.connectorId), current=validatePersonalDataBinding(port.binding(target));
    if(personalDataHash(current)!==personalDataHash(source.binding)) {
      this.deps.store.setSource({...source,status:"permission_changed",reason:"binding_changed"},source.revision);
      throw personalDataError("personal_data_permission_changed");
    }
    const authority=this.authorize(target,"source-read",[current]);this.authorize(target,"inference",[current],undefined,budgetId);
    const key=`${this.deps.store.key(target)}:${input.sourceId}`;
    if(this.active.has(key))throw personalDataError("personal_data_collection_in_progress");
    const controller=new AbortController();this.active.set(key,controller);
    try {
      const batch=validatePersonalDataBatch(await port.read({target,cursor:source.cursor,maxItems:100,signal:controller.signal}),100,Date.parse(this.now()));
      if(controller.signal.aborted)throw personalDataError("personal_data_collection_cancelled");
      if(this.authorize(target,"source-read",[current])!==authority || personalDataHash(validatePersonalDataBinding(port.binding(target)))!==personalDataHash(current)
        || batch.permissionRevision!==current.permissionRevision || batch.credentialGeneration!==current.credentialGeneration)throw personalDataError("personal_data_permission_changed");
      if(batch.cursor!==source.cursor)throw personalDataError("personal_data_cursor_mismatch");
      if(!batch.complete && (batch.nextCursor===null || batch.nextCursor===batch.cursor))throw personalDataError("personal_data_partial_cursor_invalid");
      const occurrenceId=`pd:${personalDataHash([target,current,batch.sourceRevision,batch.items.map(i=>[i.id,i.revision,i.deleted]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))])}`;
      return this.deps.store.atomic(()=>{
        this.authorize(target,"source-read",[current]);this.authorize(target,"inference",[current],undefined,budgetId);
        const latest=this.source(target,input.sourceId);
        if(latest.revision!==source.revision)throw personalDataError("personal_data_source_revision_conflict");
        const prior=this.deps.store.occurrence(occurrenceId,target);
        if(prior) return {occurrenceId,source:this.deps.store.applyBatch(latest,batch),supervisor:this.deps.supervisor.receipt({oneId:target.oneId,commandId:prior.commandId})??prior.receipt};
        if(batch.items.length===0 && batch.sourceRevision===latest.sourceRevision)return {occurrenceId:null,source:this.deps.store.applyBatch(latest,batch),supervisor:null};
        // Snapshot + existing Supervisor receipt are durable before advancing the cursor, in ONE DB transaction.
        const staged=this.deps.store.setSource({...source,sourceRevision:batch.sourceRevision,observedAt:batch.observedAt,status:batch.complete?"ready":"partial",reason:null},source.revision,
          (()=>{const m=new Map(this.deps.store.items(target,input.sourceId).map(i=>[i.id,i]));batch.items.forEach(i=>m.set(i.id,i));if(m.size>10_000)throw personalDataError("personal_data_retention_limit");return [...m.values()];})());
        const commandId=`pd-work:${personalDataHash([occurrenceId,budgetId])}`;
        this.deps.supervisor.bindOccurrence({commandId,target,sourceBindings:[current],sourceRevision:staged.revision,budgetId});
        const receipt=this.deps.supervisor.startWork({commandId,oneId:target.oneId,budgetId,permissions:"read",...(target.projectId?{projectId:target.projectId}:{}),
          text:`Prepare an editable Page proposal from permitted personal-source occurrence ${occurrenceId}. Target Space ${target.spaceId}, Page ${target.pageId}. Source ${current.sourceId}, revision ${batch.sourceRevision}; purpose: ${current.purpose}. Use the bound personal-data source read tool; do not modify the Page or expand source grants.`});
        if(!receipt.taskId||!receipt.runId||["failed","cancelled"].includes(receipt.state))throw personalDataError("personal_data_supervisor_not_admitted");
        this.deps.store.putOccurrence({occurrenceId,target,sourceId:input.sourceId,sourceRevision:staged.revision,commandId,baseRevision:this.deps.store.page(target)!.revision,sourceSnapshotRevision:batch.sourceRevision,observedAt:batch.observedAt,sourceBinding:current,items:this.deps.store.items(target,input.sourceId),receipt});
        const advanced=this.deps.store.setSource({...staged,cursor:batch.nextCursor},staged.revision);
        return {occurrenceId,source:advanced,supervisor:receipt};
      });
    } catch(error) {
      const latest=this.deps.store.source(target,input.sourceId);
      if(latest?.revision===source.revision && !controller.signal.aborted) {
        const reason=safeFailureCode(error);
        const status=reason==="personal_data_invalid_cursor"?"invalid_cursor":reason==="personal_data_disconnected"?"disconnected":reason==="personal_data_permission_changed"?"permission_changed":"blocked";
        this.deps.store.setSource({...latest,status,reason},latest.revision);
      }
      throw personalDataError(controller.signal.aborted?"personal_data_collection_cancelled":safeFailureCode(error));
    } finally {if(this.active.get(key)===controller)this.active.delete(key);}
  }
  /** Called by the existing queue's claim and native dispatch boundaries, not just collection time. */
  assertOccurrenceAuthority(input: {commandId:string;target:PersonalDataTarget;sourceBindings:PersonalDataSourceBinding[];sourceRevision:number;budgetId:string}): void {
    const target=this.target(input.target);
    for(const binding of input.sourceBindings){const state=this.source(target,binding.sourceId);
      if(!["ready","partial"].includes(state.status)||state.revision<input.sourceRevision||personalDataHash(state.binding)!==personalDataHash(binding))throw personalDataError("personal_data_source_not_active");
      if(personalDataHash(validatePersonalDataBinding(this.deps.connectors.get(binding.connectorId).binding(target)))!==personalDataHash(binding))throw personalDataError("personal_data_permission_changed");}
    this.authorize(target,"source-read",input.sourceBindings);this.authorize(target,"inference",input.sourceBindings,undefined,input.budgetId);
  }
  /** Native inference reads exact occurrence snapshot, not a later moving source cache. */
  readSource(targetRaw: PersonalDataTarget, occurrenceId: string): PersonalDataSourceItem[] {
    const target=this.target(targetRaw), occurrence=this.deps.store.occurrence(occurrenceId,target);
    if(!occurrence)throw personalDataError("personal_data_occurrence_missing");
    const state=this.source(target,occurrence.sourceId);
    if(!["ready","partial"].includes(state.status))throw personalDataError("personal_data_source_not_active");
    if(personalDataHash(state.binding)!==personalDataHash(occurrence.sourceBinding))throw personalDataError("personal_data_permission_changed");
    const current=validatePersonalDataBinding(this.deps.connectors.get(state.binding.connectorId).binding(target));
    if(personalDataHash(current)!==personalDataHash(state.binding))throw personalDataError("personal_data_permission_changed");
    this.authorize(target,"source-read",[occurrence.sourceBinding]);
    const tombstones=new Set(this.deps.store.items(target,occurrence.sourceId).filter(i=>i.deleted).map(i=>i.id));
    if(occurrence.items.some(i=>!i.deleted&&tombstones.has(i.id)))throw personalDataError("personal_data_source_deleted");
    return occurrence.items.filter(i=>!i.deleted);
  }
  /** Host-only: exact verified native output is the only proposal text source. */
  proposeFromResult(input: {target:PersonalDataTarget;occurrenceId:string}): PersonalDataProposal {
    const target=this.target(input.target), occurrence=this.deps.store.occurrence(input.occurrenceId,target);
    if(!occurrence)throw personalDataError("personal_data_occurrence_missing");
    const state=this.source(target,occurrence.sourceId), result=this.deps.supervisor.exactResult(target,occurrence.commandId), page=this.deps.store.page(target);
    if(!result||result.verified!==true||result.state!=="completed"||!page||result.anchor.commandId!==occurrence.commandId||result.anchor.taskId!==occurrence.receipt?.taskId||result.anchor.runId!==occurrence.receipt?.runId
      || !/^[a-f0-9]{64}$/.test(result.anchor.artifactDigest)||!result.text.trim())throw personalDataError("personal_data_exact_result_missing");
    if(!["ready","partial"].includes(state.status))throw personalDataError("personal_data_source_not_active");
    const anchor={...result.anchor,chatId:personalDataId(result.chatId)};
    this.authorize(target,"page-write",[state.binding],anchor);
    const blocks=personalDataBlocks([{id:`inference:${personalDataHash(input.occurrenceId).slice(0,32)}`,kind:"inference",text:result.text,sourceRefs:this.readSource(target,input.occurrenceId).map(i=>i.sourceRef).slice(0,128),
      provenance:{occurrenceId:input.occurrenceId,sourceRevision:occurrence.sourceSnapshotRevision,observedAt:occurrence.observedAt,binding:occurrence.sourceBinding}}]);
    const proposalId=`pd-proposal:${personalDataHash([input.occurrenceId,anchor])}`;
    const prior=this.deps.store.proposal(target,proposalId);if(prior)return prior;
    return this.deps.store.putProposal({proposalId,target,baseRevision:occurrence.baseRevision,blocks,anchor,sourceBindings:[occurrence.sourceBinding],status:"pending",createdAt:this.now(),acceptedRevision:null});
  }
  accept(input: PersonalDataAcceptInput): PersonalDataWriteReceipt {
    const target=this.target(input.target);
    return this.deps.store.atomic(()=>{
      const proposal=this.deps.store.proposal(target,input.proposalId), page=this.deps.store.page(target);
      if(!proposal||!page)throw personalDataError("personal_data_proposal_missing");
      this.assertProposalAuthority(proposal,"page-write");
      const prior=this.deps.store.priorWrite(input.commandId,target,input);if(prior)return prior;
      if(proposal.status!=="pending"||proposal.baseRevision!==input.expectedRevision||page.revision!==input.expectedRevision)throw personalDataError("personal_data_revision_conflict");
      if(proposal.blocks.some(b=>page.blocks.some(p=>p.id===b.id&&p.kind==="manual")))throw personalDataError("personal_data_manual_block_protected");
      const receipt=this.deps.store.write({commandId:input.commandId,target,expectedRevision:input.expectedRevision,title:page.title,
        blocks:[...page.blocks.filter(b=>!proposal.blocks.some(p=>p.id===b.id)),...proposal.blocks],origin:"proposal",anchor:proposal.anchor,intent:input});
      this.deps.store.putProposal({...proposal,status:"accepted",acceptedRevision:receipt.revision});
      this.authorize(target,"page-read",proposal.sourceBindings,proposal.anchor);
      const exact=this.deps.store.page(target,receipt.revision);
      if(exact?.digest!==receipt.digest)throw personalDataError("personal_data_readback_mismatch");
      return receipt;
    });
  }
  private assertProposalAuthority(proposal: PersonalDataProposal, action: PersonalDataAction): void {
    for(const binding of proposal.sourceBindings){const current=this.source(proposal.target,binding.sourceId);
      if(!["ready","partial"].includes(current.status)||personalDataHash(current.binding)!==personalDataHash(binding))throw personalDataError("personal_data_source_not_active");
      if(personalDataHash(validatePersonalDataBinding(this.deps.connectors.get(binding.connectorId).binding(proposal.target)))!==personalDataHash(binding))throw personalDataError("personal_data_permission_changed");}
    this.authorize(proposal.target,action,proposal.sourceBindings,proposal.anchor);
    const exact=this.deps.supervisor.exactResult(proposal.target,proposal.anchor.commandId);
    if(!exact||personalDataHash({...exact.anchor,chatId:exact.chatId})!==personalDataHash(proposal.anchor))throw personalDataError("personal_data_result_anchor_changed");
  }
  cancelProposal(input: {target:PersonalDataTarget;proposalId:string}): PersonalDataProposal {
    const target=this.target(input.target), p=this.deps.store.proposal(target,input.proposalId);
    if(!p)throw personalDataError("personal_data_proposal_missing");
    if(p.status==="accepted")throw personalDataError("personal_data_proposal_already_accepted");
    const cancelled=this.deps.store.putProposal({...p,status:"cancelled"});
    // Stop remains available after source revocation; its receipt does not disclose old derived content.
    return {...cancelled,blocks:[],sourceBindings:[]};
  }
  /** Explicit owner rebase creates a new proposal; accepting never overwrites a concurrent manual edit. */
  rebaseProposal(input: {target:PersonalDataTarget;proposalId:string;expectedRevision:number}): PersonalDataProposal {
    const target=this.target(input.target);
    return this.deps.store.atomic(()=>{
      const proposal=this.deps.store.proposal(target,input.proposalId),page=this.deps.store.page(target);
      if(!proposal||proposal.status!=="pending"||!page||page.revision!==input.expectedRevision)throw personalDataError("personal_data_revision_conflict");
      this.assertProposalAuthority(proposal,"page-write");
      const proposalId=`pd-rebase:${personalDataHash([proposal.proposalId,page.revision,page.digest])}`;
      const prior=this.deps.store.proposal(target,proposalId);if(prior)return prior;
      return this.deps.store.putProposal({...proposal,proposalId,baseRevision:page.revision,createdAt:this.now()});
    });
  }
  async cancelInference(input:{commandId:string;target:PersonalDataTarget;occurrenceId:string;runId:string;expectedControlVersion:string}):Promise<SupervisorCommandReceipt> {
    const target=this.target(input.target),occurrence=this.deps.store.occurrence(input.occurrenceId,target);
    if(!occurrence?.receipt?.taskId||occurrence.receipt.runId!==input.runId)throw personalDataError("personal_data_follow_up_anchor_mismatch");
    // Exact Supervisor control remains available after grant revocation; it verifies current run/control CAS.
    return this.deps.supervisor.control({commandId:personalDataId(input.commandId),oneId:target.oneId,taskId:occurrence.receipt.taskId,
      runId:personalDataId(input.runId),expectedVersion:personalDataText(input.expectedControlVersion,200),action:"cancel"});
  }
  followUp(input: PersonalDataFollowUpInput): SupervisorCommandReceipt {
    const target=this.target(input.target), page=this.deps.store.page(target);
    if(!page||page.revision!==input.expectedRevision||!page.acceptedAnchor||personalDataHash(page.acceptedAnchor)!==personalDataHash(input.anchor))throw personalDataError("personal_data_follow_up_anchor_mismatch");
    const proposal=this.deps.store.proposals(target).find(p=>p.status==="accepted"&&p.acceptedRevision!==null&&p.acceptedRevision<=page.revision&&personalDataHash(p.anchor)===personalDataHash(input.anchor));
    if(!proposal)throw personalDataError("personal_data_proposal_missing");
    this.assertProposalAuthority(proposal,"follow-up");
    return this.deps.supervisor.followUp({commandId:personalDataId(input.commandId),oneId:target.oneId,taskId:input.anchor.taskId,
      text:personalDataText(`Exact accepted Page ${target.pageId} revision ${page.revision}, digest ${page.digest}; artifact ${input.anchor.artifactId} revision ${input.anchor.artifactRevision}, digest ${input.anchor.artifactDigest}. ${personalDataText(input.text,7000)}`,8000)});
  }
}
