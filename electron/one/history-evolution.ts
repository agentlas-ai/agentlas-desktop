import type { PersonalDataTarget, PersonalDataWriteReceipt, PersonalDataTaskAnchor } from "../../shared/one-personal-data";
import { ONE_HISTORY_EVOLUTION_SCHEMA } from "../../shared/one-history-evolution";
import type { HistoryEvolutionObservation, EvolutionEnvelope, HistoryEvolutionCandidate, HistoryEvolutionDraft, HistoryEvolutionEvaluation, HistoryEvolutionSnapshot } from "../../shared/one-history-evolution";
import type { SupervisorCommandReceipt, SupervisorWorkInput, SupervisorControlInput } from "../../shared/one-supervisor";
import { OnePersonalDataStore, personalDataError, personalDataHash, personalDataId, personalDataTarget, personalDataText } from "./personal-data-store";

export interface HistoryEvolutionPorts {
  store:OnePersonalDataStore; deploymentId:string; oneId():string; organizationAuthorityConnected?:boolean;
  policy:{current(target:PersonalDataTarget):EvolutionEnvelope;check(input:{target:PersonalDataTarget;action:"observe"|"draft"|"evaluate"|"accept"|"run"|"read"|"restore";candidateId?:string;sourceRefs:string[];envelopeDigest:string}):{decision:"allow"|"deny"|"unknown";revision:string}};
  history:{observe(target:PersonalDataTarget,max:number):Promise<HistoryEvolutionObservation[]>;assertCurrent(target:PersonalDataTarget,observation:HistoryEvolutionObservation):void};
  /** Existing native Supervisor/queue and OneBudgetRuntime, with current execution fence at claim/dispatch. */
  supervisor:{startWork(input:SupervisorWorkInput):SupervisorCommandReceipt;control(input:SupervisorControlInput):SupervisorCommandReceipt|Promise<SupervisorCommandReceipt>;
    receipt(input:{oneId:string;commandId:string}):SupervisorCommandReceipt|null;
    bindExecution(input:{commandId:string;candidateId:string;target:PersonalDataTarget;revision:number;envelopeDigest:string;purpose:"draft"|"run"}):void};
  /** Existing plugin Builder, agent workspace and learner produce exact private drafts; never invent versions. */
  assets:{collectExactDraft(input:{target:PersonalDataTarget;commandId:string;candidateId:string}):Promise<HistoryEvolutionDraft|null>;
    assertCurrentDraft(input:{target:PersonalDataTarget;draft:HistoryEvolutionDraft}):void;
    consumeApproval(input:{candidateId:string;reviewedHash:string;approvalId:string;revision:number}):void;
    applyReviewed(input:{target:PersonalDataTarget;candidateId:string;draft:HistoryEvolutionDraft;reviewedHash:string;approvalId:string}):Promise<{state:"applied"|"unknown";versionId:string;digest:string}>;
    restoreAsNewDraft(input:{target:PersonalDataTarget;candidateId:string;versionId:string;envelope:EvolutionEnvelope}):Promise<HistoryEvolutionDraft>};
  evaluator:{oracle():{id:string;revision:string;fixtureDigest:string};evaluate(input:{candidateId:string;draft:HistoryEvolutionDraft;envelopeDigest:string;oracle:{id:string;revision:string;fixtureDigest:string};signal:AbortSignal}):Promise<HistoryEvolutionEvaluation>};
  pages:{writeExactFeedback(input:{target:PersonalDataTarget;candidateId:string;commandId:string;draft:HistoryEvolutionDraft}):Promise<{anchor:PersonalDataTaskAnchor;receipt:PersonalDataWriteReceipt}>};
  now?:()=>string;
}
export function historyEvolutionReviewHash(c:HistoryEvolutionCandidate):string{return personalDataHash([c.target,c.candidateId,c.revision,c.observations,c.envelope,c.draft,c.evaluation]);}
function frozen<T>(value:T):T {const copy=JSON.parse(JSON.stringify(value));const freeze=(v:unknown):void=>{if(v&&typeof v==="object"){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(copy);return copy;}
function ids(values:string[]):string[]{if(!Array.isArray(values)||values.length>128)throw personalDataError("history_evolution_limits_invalid");return [...new Set(values.map(personalDataId))];}
function envelope(raw:EvolutionEnvelope):EvolutionEnvelope {
  if(raw.automaticPromotion!==false||!Number.isSafeInteger(raw.maxObservations)||raw.maxObservations<1||raw.maxObservations>100
    ||!Number.isSafeInteger(raw.retentionMs)||raw.retentionMs<60_000||raw.retentionMs>90*86400000
    ||!Array.isArray(raw.allowedKinds)||!raw.allowedKinds.length||raw.allowedKinds.some(k=>!["skill","toolchain","agent"].includes(k)))throw personalDataError("history_evolution_envelope_invalid");
  return {...raw,policyRevision:personalDataId(raw.policyRevision),sourceIds:ids(raw.sourceIds),toolRefs:ids(raw.toolRefs),resourceRefs:ids(raw.resourceRefs),budgetId:personalDataId(raw.budgetId)};
}

/** Persistent provenance/review journal only. All generation and execution use One's existing Supervisor queue. */
export class OneHistoryEvolutionService {
  private readonly controllers=new Map<string,AbortController>();
  constructor(private readonly ports:HistoryEvolutionPorts){ports.store.db.exec(`CREATE TABLE IF NOT EXISTS one_history_evolution_candidates(candidate_id TEXT PRIMARY KEY,target_key TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS one_history_evolution_tombstones(target_key TEXT NOT NULL,source_ref TEXT NOT NULL,PRIMARY KEY(target_key,source_ref));
    CREATE TABLE IF NOT EXISTS one_history_evolution_operations(operation_id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,kind TEXT NOT NULL,intent_hash TEXT NOT NULL,phase TEXT NOT NULL);`);}
  private now():string{return this.ports.now?.()??new Date().toISOString();}
  private privacyKey(t:PersonalDataTarget):string{return personalDataHash([t.deploymentId,t.oneId,t.scope,t.organizationId,t.projectId,t.audience]);}
  private target(raw:PersonalDataTarget):PersonalDataTarget {const t=personalDataTarget(raw);if(t.deploymentId!==this.ports.deploymentId||t.oneId!==this.ports.oneId())throw personalDataError("history_evolution_identity_changed");return t;}
  private get(target:PersonalDataTarget,id:string):HistoryEvolutionCandidate {
    const r=this.ports.store.db.prepare("SELECT value_json FROM one_history_evolution_candidates WHERE target_key=? AND candidate_id=?").get(this.ports.store.key(target),personalDataId(id)) as {value_json:string}|undefined;
    if(!r)throw personalDataError("history_evolution_candidate_missing");return JSON.parse(r.value_json);
  }
  private save(c:HistoryEvolutionCandidate,expectedRevision:number):HistoryEvolutionCandidate {
    return this.ports.store.atomic(()=>{
      const prior=this.ports.store.db.prepare("SELECT target_key,revision FROM one_history_evolution_candidates WHERE candidate_id=?").get(c.candidateId) as {target_key:string;revision:number}|undefined;
      if((prior?.revision??0)!==expectedRevision||prior&&prior.target_key!==this.ports.store.key(c.target))throw personalDataError("history_evolution_revision_conflict");
      const next={...c,revision:expectedRevision+1};
      this.ports.store.db.prepare("INSERT INTO one_history_evolution_candidates VALUES(?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json")
        .run(c.candidateId,this.ports.store.key(c.target),next.revision,JSON.stringify(next));return next;
    });
  }
  private current(c:HistoryEvolutionCandidate,action:Parameters<HistoryEvolutionPorts["policy"]["check"]>[0]["action"]):string {
    this.target(c.target);
    if(c.target.organizationId!==null&&!this.ports.organizationAuthorityConnected)throw personalDataError("history_evolution_organization_policy_required");
    if(["paused","revoked","deleted","unknown"].includes(c.status)&&action!=="read")throw personalDataError("history_evolution_not_active");
    const e=envelope(this.ports.policy.current(c.target)),digest=personalDataHash(e);
    if(digest!==personalDataHash(c.envelope))throw personalDataError("history_evolution_policy_changed");
    for(const o of c.observations){
      if(this.ports.store.db.prepare("SELECT 1 FROM one_history_evolution_tombstones WHERE target_key=? AND source_ref=?").get(this.privacyKey(c.target),o.sourceRef))throw personalDataError("history_evolution_source_deleted");
      if(Date.parse(this.now())-Date.parse(o.observedAt)>e.retentionMs)throw personalDataError("history_evolution_retention_expired");
      this.ports.history.assertCurrent(c.target,o);
    }
    const decision=this.ports.policy.check({target:c.target,action,candidateId:c.candidateId,sourceRefs:c.observations.map(o=>o.sourceRef),envelopeDigest:digest});
    if(c.draft&&(action==="accept"||action==="run"))this.ports.assets.assertCurrentDraft({target:c.target,draft:c.draft});
    if(decision.decision!=="allow"||!decision.revision)throw personalDataError(decision.decision==="unknown"?"history_evolution_authority_unknown":"history_evolution_authority_denied");return decision.revision;
  }
  snapshot(input:{target:PersonalDataTarget}):HistoryEvolutionSnapshot {
    const target=this.target(input.target);
    if(target.organizationId!==null&&!this.ports.organizationAuthorityConnected)throw personalDataError("history_evolution_organization_policy_required");
    const e=envelope(this.ports.policy.current(target)),decision=this.ports.policy.check({target,action:"read",sourceRefs:[],envelopeDigest:personalDataHash(e)});
    if(decision.decision!=="allow"||!decision.revision)throw personalDataError("history_evolution_authority_denied");
    const candidates=(this.ports.store.db.prepare("SELECT value_json FROM one_history_evolution_candidates WHERE target_key=? ORDER BY rowid DESC LIMIT 100").all(this.ports.store.key(target)) as Array<{value_json:string}>).map(r=>JSON.parse(r.value_json) as HistoryEvolutionCandidate);
    for(const c of candidates)this.current(c,"read");return {schema:ONE_HISTORY_EVOLUTION_SCHEMA,target,candidates};
  }
  /** Host-triggered permitted observation. No model or renderer may author observation/permission receipts. */
  async observe(input:{target:PersonalDataTarget;predecessorId?:string}):Promise<HistoryEvolutionCandidate> {
    const target=this.target(input.target),e=envelope(this.ports.policy.current(target));
    const seed:HistoryEvolutionCandidate={schema:ONE_HISTORY_EVOLUTION_SCHEMA,candidateId:"pending",target,revision:0,status:"observed",observations:[],envelope:e,draft:null,evaluation:null,generationCommandId:null,runCommandId:null,anchor:null,feedback:null,predecessorId:input.predecessorId??null,createdAt:this.now(),reason:null};
    const authority=this.current(seed,"observe"),items=await this.ports.history.observe(target,e.maxObservations);
    if(this.current(seed,"observe")!==authority||!Array.isArray(items)||!items.length||items.length>e.maxObservations)throw personalDataError("history_evolution_observation_invalid");
    const observations=items.map(o=>{
      if(o.sensitiveFieldsRemoved!==true||!e.sourceIds.includes(o.sourceId)||!Number.isFinite(Date.parse(o.observedAt))||Date.parse(o.observedAt)>Date.parse(this.now())+30_000
        ||!["work-session","application","erp-api","erp-ui"].includes(o.interface))throw personalDataError("history_evolution_observation_invalid");
      return {...o,id:personalDataId(o.id),revision:personalDataId(o.revision),sourceId:personalDataId(o.sourceId),sourceRef:personalDataId(o.sourceRef),
        permissionRevision:personalDataId(o.permissionRevision),consentRevision:personalDataId(o.consentRevision),environmentRevision:personalDataId(o.environmentRevision),summary:personalDataText(o.summary,4000)};
    });
    const candidateId=`he:${personalDataHash([target,observations,e,input.predecessorId??null])}`;
    const existing=this.ports.store.db.prepare("SELECT 1 FROM one_history_evolution_candidates WHERE candidate_id=?").get(candidateId);
    if(existing){const prior=this.get(target,candidateId);this.current(prior,"observe");return prior;}
    const c={...seed,candidateId,observations};this.current(c,"observe");return this.save(c,0);
  }
  draft(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;commandId:string}):HistoryEvolutionCandidate {
    const target=this.target(input.target),c=this.get(target,input.candidateId);
    return this.ports.store.atomic(()=>{
      this.current(c,"draft");if(c.revision!==input.expectedRevision||c.status!=="observed")throw personalDataError("history_evolution_revision_conflict");
      const commandId=personalDataId(input.commandId);
      this.ports.supervisor.bindExecution({commandId,candidateId:c.candidateId,target,revision:c.revision+1,envelopeDigest:personalDataHash(c.envelope),purpose:"draft"});
      const receipt=this.ports.supervisor.startWork({commandId,oneId:target.oneId,permissions:"read",budgetId:c.envelope.budgetId,...(target.projectId?{projectId:target.projectId}:{}),
        text:`Prepare a private Skill/Toolchain/Agent draft for history candidate ${c.candidateId}. Read only its bound redacted observations. Record ProcessBinding preconditions, input/output, manual judgments, result checks and exact environment/source revisions. Reuse existing assets before generating; use the existing plugin Builder, agent workspace diff or Toolchain learner. No install, approval, policy change or promotion.`});
      if(!receipt.taskId||!receipt.runId||["failed","cancelled"].includes(receipt.state))throw personalDataError("history_evolution_supervisor_not_admitted");
      return this.save({...c,status:"drafting",generationCommandId:commandId},c.revision);
    });
  }
  private validateDraft(c:HistoryEvolutionCandidate,d:HistoryEvolutionDraft):void {
    if(!c.envelope.allowedKinds.includes(d.kind)||!/^[a-f0-9]{64}$/.test(d.digest)||!["plugin-builder","agent-workspace","toolchain-learner"].includes(d.producer)
      ||d.toolRefs.some(r=>!c.envelope.toolRefs.includes(r))||d.resourceRefs.some(r=>!c.envelope.resourceRefs.includes(r))
      ||d.process.schema!=="agentlas.process-binding.v1"||!d.process.checks.length||!d.process.preconditions.length
      ||d.process.toolRefs.some(r=>!c.envelope.toolRefs.includes(r))||d.process.resourceRefs.some(r=>!c.envelope.resourceRefs.includes(r)))throw personalDataError("history_evolution_draft_outside_envelope");
    personalDataId(d.assetId);personalDataId(d.versionId);ids(d.toolRefs);ids(d.resourceRefs);ids(d.changeRefs);
    if(!c.observations.some(o=>o.environmentRevision===d.process.environmentRevision&&o.interface===d.process.interface))throw personalDataError("history_evolution_environment_changed");
    for(const source of d.process.sourceRevisions)if(!c.observations.some(o=>o.sourceRef===source.sourceRef&&o.revision===source.revision))throw personalDataError("history_evolution_source_revision_changed");
    if(!d.process.sourceRevisions.length)throw personalDataError("history_evolution_source_revision_changed");
  }
  async collectDraft(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number}):Promise<HistoryEvolutionCandidate> {
    const target=this.target(input.target),c=this.get(target,input.candidateId);
    if(c.revision!==input.expectedRevision||c.status!=="drafting"||!c.generationCommandId)throw personalDataError("history_evolution_revision_conflict");
    const auth=this.current(c,"draft"),draft=await this.ports.assets.collectExactDraft({target,candidateId:c.candidateId,commandId:c.generationCommandId});
    if(!draft)throw personalDataError("history_evolution_exact_draft_missing");
    if(this.current(c,"draft")!==auth)throw personalDataError("history_evolution_authority_changed");this.validateDraft(c,draft);
    return this.save({...c,status:"draft",draft},c.revision);
  }
  async evaluate(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number}):Promise<HistoryEvolutionCandidate> {
    const target=this.target(input.target),c=this.get(target,input.candidateId);
    if(c.revision!==input.expectedRevision||c.status!=="draft"||!c.draft)throw personalDataError("history_evolution_revision_conflict");
    const auth=this.current(c,"evaluate"),oracle=this.ports.evaluator.oracle(),controller=new AbortController();
    if(this.controllers.has(c.candidateId))throw personalDataError("history_evolution_evaluation_in_progress");this.controllers.set(c.candidateId,controller);
    try{const evaluation=await this.ports.evaluator.evaluate({candidateId:c.candidateId,draft:frozen(c.draft),envelopeDigest:personalDataHash(c.envelope),oracle:frozen(oracle),signal:controller.signal});
      if(controller.signal.aborted)throw personalDataError("history_evolution_cancelled");
      if(this.current(c,"evaluate")!==auth||personalDataHash(this.ports.evaluator.oracle())!==personalDataHash(oracle))throw personalDataError("history_evolution_frozen_oracle_changed");
      if(evaluation.draftDigest!==c.draft.digest||evaluation.envelopeDigest!==personalDataHash(c.envelope)||evaluation.oracleId!==oracle.id||evaluation.oracleRevision!==oracle.revision||evaluation.fixtureDigest!==oracle.fixtureDigest
        ||evaluation.isolated!==true||evaluation.networkAccess!==false||evaluation.providerCalls!==0||!/^[a-f0-9]{64}$/.test(evaluation.resultDigest))throw personalDataError("history_evolution_evaluation_invalid");
      return this.save({...c,status:"evaluated",evaluation},c.revision);
    }finally{if(this.controllers.get(c.candidateId)===controller)this.controllers.delete(c.candidateId);}
  }
  async accept(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;reviewedHash:string;approvalId:string}):Promise<HistoryEvolutionCandidate> {
    const target=this.target(input.target),c=this.get(target,input.candidateId);
    if(c.revision!==input.expectedRevision||c.status!=="evaluated"||!c.draft||!c.evaluation?.passed||historyEvolutionReviewHash(c)!==input.reviewedHash)throw personalDataError("history_evolution_review_mismatch");
    const auth=this.current(c,"accept");
    const oracle=this.ports.evaluator.oracle();if(oracle.id!==c.evaluation.oracleId||oracle.revision!==c.evaluation.oracleRevision||oracle.fixtureDigest!==c.evaluation.fixtureDigest)throw personalDataError("history_evolution_frozen_oracle_changed");
    const operationId=`he-accept:${personalDataHash([c.candidateId,input.reviewedHash,input.approvalId])}`;
    const pending=this.ports.store.atomic(()=>{
      if(this.get(target,c.candidateId).revision!==c.revision)throw personalDataError("history_evolution_revision_conflict");
      const prior=this.ports.store.db.prepare("SELECT phase FROM one_history_evolution_operations WHERE operation_id=?").get(operationId);
      if(prior)throw personalDataError("history_evolution_apply_outcome_unknown");
      this.current(c,"accept");this.ports.assets.consumeApproval({candidateId:c.candidateId,reviewedHash:input.reviewedHash,approvalId:input.approvalId,revision:c.revision});
      this.ports.store.db.prepare("INSERT INTO one_history_evolution_operations VALUES(?,?,?,?,?)").run(operationId,c.candidateId,"accept",input.reviewedHash,"attempted");
      return this.save({...c,status:"unknown",reason:"apply_pending"},c.revision);
    });
    try{const receipt=await this.ports.assets.applyReviewed({target,candidateId:c.candidateId,draft:frozen(c.draft),reviewedHash:input.reviewedHash,approvalId:input.approvalId});
      if(this.current(c,"accept")!==auth||receipt.state!=="applied"||receipt.digest!==c.draft.digest)throw personalDataError("history_evolution_apply_outcome_unknown");
      // Existing workspace apply issues a NEW actual revision ID after exact digest read-back.
      const appliedDraft={...c.draft,versionId:personalDataId(receipt.versionId)};
      const saved=this.save({...pending,status:"accepted",draft:appliedDraft,reason:null},pending.revision);this.ports.store.db.prepare("UPDATE one_history_evolution_operations SET phase='settled' WHERE operation_id=?").run(operationId);return saved;
    }catch(error){const latest=this.get(target,c.candidateId);if(latest.revision===pending.revision)this.save({...latest,status:"unknown",reason:"apply_outcome_unknown"},latest.revision);throw error;}
  }
  run(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;commandId:string}):HistoryEvolutionCandidate {
    const target=this.target(input.target),c=this.get(target,input.candidateId);
    return this.ports.store.atomic(()=>{
      this.current(c,"run");if(c.revision!==input.expectedRevision||c.status!=="accepted"||!c.draft||!c.evaluation?.passed)throw personalDataError("history_evolution_revision_conflict");
      const commandId=personalDataId(input.commandId);
      this.ports.supervisor.bindExecution({commandId,candidateId:c.candidateId,target,revision:c.revision+1,envelopeDigest:personalDataHash(c.envelope),purpose:"run"});
      const receipt=this.ports.supervisor.startWork({commandId,oneId:target.oneId,permissions:"read",budgetId:c.envelope.budgetId,...(target.projectId?{projectId:target.projectId}:{}),
        text:`Execute only accepted asset ${c.draft.assetId} version ${c.draft.versionId} digest ${c.draft.digest}, candidate ${c.candidateId}. Use the bound ProcessBinding and current allowed tools/resources. Stop for unknown ERP rules, changed schema or manual judgments. Save a proposal to exact Page ${target.pageId}; external writes require separate currently permitted tool grants.`});
      if(!receipt.taskId||!receipt.runId||["failed","cancelled"].includes(receipt.state))throw personalDataError("history_evolution_supervisor_not_admitted");return this.save({...c,status:"running",runCommandId:commandId},c.revision);
    });
  }
  /** Parent invokes at queue claim, before every provider/tool call and result publication. */
  assertExecutionAuthority(input:{target:PersonalDataTarget;candidateId:string;commandId:string;revision:number;envelopeDigest:string;purpose:"draft"|"run"}):void {
    const c=this.get(this.target(input.target),input.candidateId);
    if(c.revision!==input.revision||personalDataHash(c.envelope)!==input.envelopeDigest||(input.purpose==="draft"?c.generationCommandId:c.runCommandId)!==input.commandId)throw personalDataError("history_evolution_execution_binding_changed");
    this.current(c,input.purpose==="draft"?"draft":"run");
  }
  readBoundObservations(input:{target:PersonalDataTarget;candidateId:string;commandId:string}):HistoryEvolutionObservation[] {
    const c=this.get(this.target(input.target),input.candidateId);
    if(c.generationCommandId!==input.commandId&&c.runCommandId!==input.commandId)throw personalDataError("history_evolution_execution_binding_changed");this.current(c,"read");return c.observations;
  }
  async feedback(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number}):Promise<HistoryEvolutionCandidate> {
    const target=this.target(input.target),c=this.get(target,input.candidateId);
    if(c.revision!==input.expectedRevision||c.status!=="running"||!c.draft||!c.runCommandId)throw personalDataError("history_evolution_revision_conflict");
    const auth=this.current(c,"run"),result=await this.ports.pages.writeExactFeedback({target,candidateId:c.candidateId,commandId:c.runCommandId,draft:c.draft});
    if(this.current(c,"run")!==auth||result.anchor.commandId!==c.runCommandId||result.receipt.readBackVerified!==true||personalDataHash(result.receipt.target)!==personalDataHash(target)
      ||result.receipt.revision!==result.receipt.page.revision||result.receipt.digest!==result.receipt.page.digest||personalDataHash(result.receipt.page.acceptedAnchor)!==personalDataHash(result.anchor))throw personalDataError("history_evolution_feedback_anchor_mismatch");
    return this.save({...c,status:"feedback",anchor:result.anchor,feedback:result.receipt},c.revision);
  }
  async control(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;action:"pause"|"resume"|"revoke"|"delete";commandId?:string;expectedControlVersion?:string}):Promise<HistoryEvolutionCandidate> {
    const target=this.target(input.target),c=this.get(target,input.candidateId);this.controllers.get(c.candidateId)?.abort();
    if(c.revision!==input.expectedRevision)throw personalDataError("history_evolution_revision_conflict");
    if(!["pause","resume","revoke","delete"].includes(input.action))throw personalDataError("history_evolution_control_invalid");
    if(input.action==="resume"){
      if(c.status!=="paused")throw personalDataError("history_evolution_not_active");
      const next={...c,status:"observed" as const,draft:null,evaluation:null,generationCommandId:null,runCommandId:null};this.current(next,"observe");return this.save(next,c.revision);
    }
    // Persist the fence BEFORE native Stop. Unknown control delivery must never prevent pause/revoke/delete.
    const fenced=this.ports.store.atomic(()=>{
      if(input.action==="delete")for(const o of c.observations)this.ports.store.db.prepare("INSERT OR IGNORE INTO one_history_evolution_tombstones VALUES(?,?)").run(this.privacyKey(target),o.sourceRef);
      return this.save({...c,status:input.action==="delete"?"deleted":input.action==="revoke"?"revoked":"paused",reason:input.action,...(input.action==="delete"?{observations:[],draft:null,evaluation:null,feedback:null}: {})},c.revision);
    });
    // A current grant is not a prerequisite for stopping. Exact native controls still own run/control CAS.
    if((c.status==="running"||c.status==="drafting")&&input.commandId&&input.expectedControlVersion){
      const originCommand=c.status==="running"?c.runCommandId:c.generationCommandId;
      const original=originCommand?this.ports.supervisor.receipt({oneId:target.oneId,commandId:originCommand}):null;
      try{
        if(!original?.taskId||!original.runId)throw personalDataError("history_evolution_exact_run_missing");
        const receipt=await this.ports.supervisor.control({commandId:personalDataId(input.commandId),oneId:target.oneId,taskId:original.taskId,runId:original.runId,expectedVersion:input.expectedControlVersion,action:"cancel"});
        if(receipt.acknowledgement==="unknown")return this.save({...fenced,reason:"stop_outcome_unknown"},fenced.revision);
      }catch{return this.save({...fenced,reason:"stop_outcome_unknown"},fenced.revision);}
    }
    return fenced;
  }
  async restore(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;versionId:string}):Promise<HistoryEvolutionCandidate> {
    const target=this.target(input.target),c=this.get(target,input.candidateId);
    if(c.revision!==input.expectedRevision||["deleted","revoked","unknown"].includes(c.status))throw personalDataError("history_evolution_not_active");
    const auth=this.current(c,"restore"),draft=await this.ports.assets.restoreAsNewDraft({target,candidateId:c.candidateId,versionId:personalDataId(input.versionId),envelope:c.envelope});
    if(this.current(c,"restore")!==auth||draft.versionId===input.versionId)throw personalDataError("history_evolution_restore_must_be_new_revision");this.validateDraft(c,draft);
    return this.save({...c,candidateId:`he-restore:${personalDataHash([c.candidateId,input.versionId,draft.versionId])}`,revision:0,status:"draft",draft,evaluation:null,generationCommandId:null,runCommandId:null,anchor:null,feedback:null,predecessorId:c.candidateId,createdAt:this.now()},0);
  }
}

/** Actual Computer History source reuse. Parent's consent/ACL adapter must authorize before calling observe. */
export function createComputerHistoryEvolutionSource(options:{sourceId:string;current(target:PersonalDataTarget):{consentRevision:string;permissionRevision:string;environmentRevision:string;allowed:boolean};redact(summary:string):string;read?:()=>Promise<import("../../shared/computer-history").ComputerHistoryState>}):HistoryEvolutionPorts["history"] {
  const current=(target:PersonalDataTarget)=>{const c=options.current(target);if(!c.allowed)throw personalDataError("history_evolution_history_not_permitted");return c;};
  return {assertCurrent(target,o){const c=current(target);if(o.consentRevision!==c.consentRevision||o.permissionRevision!==c.permissionRevision||o.environmentRevision!==c.environmentRevision)throw personalDataError("history_evolution_history_revision_changed");},async observe(target,max){
    const before=current(target),state=options.read?await options.read():(await import("./computer-history")).getComputerHistoryState();
    if(personalDataHash(before)!==personalDataHash(current(target))||state.consent==="off")throw personalDataError("history_evolution_history_not_permitted");
    return state.entries.slice(0,max).map(e=>({id:personalDataId(e.id),revision:personalDataHash([e.id,e.occurredAt,e.title,e.body]),sourceId:options.sourceId,sourceRef:`history:${personalDataHash(e.id)}`,observedAt:e.occurredAt,
      permissionRevision:before.permissionRevision,consentRevision:before.consentRevision,environmentRevision:before.environmentRevision,interface:"application" as const,summary:options.redact(`${e.title}\n${e.body}`),sensitiveFieldsRemoved:true as const}));
  }};
}

/** Concrete reuse of existing reviewed agent/skill file domains; no new installer or approval ledger. */
export function createAgentWorkspaceHistoryEvolutionAssets(options:{
  collectGeneratedChange(input:{target:PersonalDataTarget;commandId:string;candidateId:string}):Promise<{agentId:string;targetPath:string;currentContent:string;proposedContent:string;kind:"skill"|"agent";process:HistoryEvolutionDraft["process"];toolRefs:string[];resourceRefs:string[]}|null>;
  consumeOwnerApproval(input:{candidateId:string;reviewedHash:string;approvalId:string;revision:number}):void;
  /** Maps the current Main owner approval to the existing exact workspace approval receipt. */
  workspaceApprovalId(input:{target:PersonalDataTarget;candidateId:string;approvalId:string;proposalId:string;proposalDigest:string}):string;
  assertCurrent(target:PersonalDataTarget,assetId:string):void;
  resolveVersion(input:{target:PersonalDataTarget;candidateId:string;versionId:string}):Pick<HistoryEvolutionDraft,"assetId"|"kind"|"process"|"toolRefs"|"resourceRefs">;
}):HistoryEvolutionPorts["assets"] {
  const draft=(p:import("../../shared/agent-workspace").AgentWorkspaceProposal,meta:Pick<HistoryEvolutionDraft,"kind"|"process"|"toolRefs"|"resourceRefs">):HistoryEvolutionDraft=>({kind:meta.kind,process:meta.process,toolRefs:meta.toolRefs,resourceRefs:meta.resourceRefs,assetId:p.agentId,versionId:p.id,proposalRef:p.id,digest:p.proposedTreeDigest,producer:"agent-workspace",changeRefs:p.changes.map(c=>`change:${personalDataHash([c.path,c.beforeHash,c.afterHash])}`)});
  return {
    async collectExactDraft(input){
      const generated=await options.collectGeneratedChange(input);if(!generated)return null;
      options.assertCurrent(input.target,generated.agentId);
      const workspace=await import("../agents/workspace-service");
      const proposal=workspace.prepareAgentWorkspaceFileChange({agentId:generated.agentId,targetPath:generated.targetPath,currentContent:generated.currentContent,proposedContent:generated.proposedContent});
      options.assertCurrent(input.target,generated.agentId);
      return draft(proposal,generated);
    },
    assertCurrentDraft(input){
      options.assertCurrent(input.target,input.draft.assetId);
      // This synchronous import is lazy: no real agent store is touched during adapter construction.
      const workspace=require("../agents/workspace-service") as typeof import("../agents/workspace-service");
      if(input.draft.proposalRef){const p=workspace.getAgentWorkspaceDiff(input.draft.proposalRef);
        if(p.agentId!==input.draft.assetId||p.proposedTreeDigest!==input.draft.digest||!["review_ready","applied"].includes(p.status))throw personalDataError("history_evolution_asset_changed");}
      const snapshot=workspace.getAgentWorkspace(input.draft.assetId);
      if(input.draft.proposalRef!==input.draft.versionId&&(snapshot.currentRevisionId!==input.draft.versionId||snapshot.treeDigest!==input.draft.digest))throw personalDataError("history_evolution_asset_changed");
    },
    consumeApproval(input){options.consumeOwnerApproval(input);},
    async applyReviewed(input){
      options.assertCurrent(input.target,input.draft.assetId);
      if(!input.draft.proposalRef)throw personalDataError("history_evolution_exact_draft_missing");
      const workspace=await import("../agents/workspace-service"),diff=workspace.getAgentWorkspaceDiff(input.draft.proposalRef);
      if(diff.agentId!==input.draft.assetId||diff.proposedTreeDigest!==input.draft.digest)throw personalDataError("history_evolution_asset_changed");
      const approvalReceiptId=options.workspaceApprovalId({target:input.target,candidateId:input.candidateId,approvalId:input.approvalId,proposalId:diff.id,proposalDigest:diff.reviewedHash});
      const applied=workspace.applyAgentWorkspaceProposal({proposalId:diff.id,reviewedHash:diff.reviewedHash,approvalReceiptId});
      options.assertCurrent(input.target,input.draft.assetId);
      const exact=workspace.getAgentWorkspace(input.draft.assetId);
      if(applied.status!=="applied"||!applied.appliedRevisionId||exact.currentRevisionId!==applied.appliedRevisionId||exact.treeDigest!==input.draft.digest)return {state:"unknown",versionId:applied.appliedRevisionId??input.draft.versionId,digest:exact.treeDigest};
      return {state:"applied",versionId:exact.currentRevisionId,digest:exact.treeDigest};
    },
    async restoreAsNewDraft(input){
      const meta=options.resolveVersion(input);options.assertCurrent(input.target,meta.assetId);
      const workspace=await import("../agents/workspace-service");
      const proposal=workspace.prepareAgentWorkspaceRollback({agentId:meta.assetId,revisionId:input.versionId});
      options.assertCurrent(input.target,meta.assetId);return draft(proposal,meta);
    }
  };
}
