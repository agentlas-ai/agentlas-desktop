import type { KeyObject } from 'node:crypto';
import { ONE_VAULT_SCHEMA, OneVaultError, type OneVaultRequest, type OneVaultEnvelope, type OneVaultReceipt, type OneVaultStatusQuery, type OneVaultErrorCode, type OneVaultCancelQuery, type OneVaultCancelReceipt } from '../../shared/one-vault';
import { authenticateOneVaultEnvelope, oneVaultDigest, oneVaultPublicPoint, openOneVault, signOneVault, validateOneVaultRequest, validateOneVaultStatus, validateOneVaultCancel, verifyOneVault } from './one-vault-crypto';
import { OneVaultJournal, type OneVaultOperation } from './one-vault-journal';
/** Populated only by independently authenticated native approval/enrollment. Existing relay
 * bearer/pairing token is insufficient. No lazy TOFU, relay supplied key, or default identity. */
export interface OneVaultTrust {
  hostId:string; hostKeyId:string; hostSigningKey:KeyObject; recipientKeyId:string; recipientPrivateKey:KeyObject;
  senderId:string; senderKeyId:string; senderPublicKey:string; generation:number;
}
export interface OneVaultAuthorityLease {
  /** Must compare current authoritative epoch synchronously, including logout/grant/control changes. */
  stillCurrent():boolean;
}
export interface OneVaultBrokerPorts {
  journal:OneVaultJournal;
  /** Read the SAME persisted Supervisor ActionRequest. Never accept caller-authored metadata. */
  request(requestId:string):OneVaultRequest|null;
  trust(request:OneVaultRequest):OneVaultTrust|null;
  authorize(request:OneVaultRequest,phase:'decrypt'|'store'|'commit'|'reconcile'):Promise<OneVaultAuthorityLease>;
  /** Existing setSecret/readSecret/deleteSecret wrappers, isolated scoped refs only. No global env.
   * Reads MUST refresh uncertain native outcomes (retryCredentialReadFromUser for reconciliation),
   * not return a cached absence while an old native writer might still finish. */
  vault:{setSecret(ref:string,value:string):Promise<void>;readSecret(ref:string):Promise<string|null>;deleteSecret(ref:string):Promise<void>};
  /** Synchronous generation invalidation; provider use ALSO compares journal generation each dispatch. */
  invalidateProviderReadiness(slotId:string,generation:number):void;
  /** Must prove sole Supervisor custody, including restart fencing against another live writer. */
  exclusiveHost():boolean;
  /** Exact current principal/sender/native request cancellation only. Must synchronously mark
   * authoritative request terminal and invalidate live admission; never provider/login gated. */
  cancelRequest?(request:OneVaultRequest):void;
  now?:()=>number;
}
interface StoredRecord {schema:'agentlas.one-vault-record.v1';operationId:string;requestDigest:string;generation:number;value:string}
/** One Main sink; caller-facing methods accept ciphertext or signed value-free status only. */
export class OneVaultBroker {
  private readonly inflight=new Map<string,{digest:string;promise:Promise<OneVaultReceipt>}>();
  constructor(private readonly p:OneVaultBrokerPorts) {}
  private now():number{return this.p.now?.()??Date.now();}
  private trusted(r:OneVaultRequest):OneVaultTrust {
    if(!this.p.exclusiveHost()) throw new OneVaultError('secure_route_unavailable');
    const t=this.p.trust(r);
    if(!t) throw new OneVaultError('secure_route_unavailable');
    if(t.hostId!==r.binding.hostId || t.hostKeyId!==r.hostKeyId || t.recipientKeyId!==r.recipientKeyId || t.senderId!==r.binding.senderId || t.generation!==r.binding.trustGeneration || oneVaultPublicPoint(t.recipientPrivateKey)!==r.recipientPublicKey || !verifyOneVault('request',r,oneVaultPublicPoint(t.hostSigningKey))) throw new OneVaultError('host_mismatch');
    return t;
  }
  private request(id:string,allowExpired=false):OneVaultRequest {
    const r=this.p.request(id); if(!r || r.binding.requestId!==id) throw new OneVaultError('not_found');
    validateOneVaultRequest(r,this.now(),allowExpired); return structuredClone(r);
  }
  private current(r:OneVaultRequest,t:OneVaultTrust,lease:OneVaultAuthorityLease,allowExpired=false):void {
    const live=this.request(r.binding.requestId,allowExpired),trust=this.trusted(live);
    if(oneVaultDigest(live)!==oneVaultDigest(r) || trust.senderKeyId!==t.senderKeyId || trust.senderPublicKey!==t.senderPublicKey || !lease.stillCurrent()) throw new OneVaultError('revision_changed');
  }
  private async authority(r:OneVaultRequest,phase:Parameters<OneVaultBrokerPorts['authorize']>[1]):Promise<OneVaultAuthorityLease> {
    try {const lease=await this.p.authorize(r,phase); if(!lease.stillCurrent()) throw new OneVaultError('authority_denied'); return lease;}
    catch(e) {if(e instanceof OneVaultError) throw e; throw new OneVaultError('authority_unavailable');}
  }
  private receipt(r:OneVaultRequest,t:OneVaultTrust,op:OneVaultOperation,responseNonce:string|null=null):OneVaultReceipt {
    const state=op.state==='reserved'?'store_unknown':op.state;
    if(state==='saved'||state==='deleted') {
      const current=this.p.journal.current(op.slotId);
      if(current.generation!==op.generation || current.pendingOperation!==null || current.credentialRef!==(state==='saved'?op.credentialRef:null)) throw new OneVaultError('revision_changed');
    }
    const receipt:OneVaultReceipt={schema:ONE_VAULT_SCHEMA,hostId:r.binding.hostId,hostKeyId:t.hostKeyId,requestDigest:op.requestDigest,operationId:op.operationId,envelopeDigest:op.envelopeDigest,requestId:r.binding.requestId,requestRevision:r.binding.requestRevision,state,credentialRef:state==='saved'?op.credentialRef:null,generation:state==='saved'||state==='deleted'?op.generation:op.expectedGeneration,providerState:'unverified',errorCode:state==='store_unknown'?'store_unknown':op.errorCode as OneVaultErrorCode|null,observedAt:this.now(),responseNonce,signature:''};
    return signOneVault('receipt',receipt,t.hostSigningKey);
  }
  async submit(requestId:string,envelope:OneVaultEnvelope):Promise<OneVaultReceipt> {
    // Clone before any await so caller mutation cannot swap a signed intent mid-flight.
    const e=structuredClone(envelope),r=this.request(requestId),t=this.trusted(r);
    if(e.senderKeyId!==t.senderKeyId) throw new OneVaultError('sender_untrusted');
    authenticateOneVaultEnvelope(r,e,t.senderPublicKey);
    const running=this.inflight.get(e.operationId);
    if(running) {if(running.digest!==oneVaultDigest(e)) throw new OneVaultError('replay_conflict'); return running.promise;}
    const work=this.store(r,t,e); this.inflight.set(e.operationId,{digest:oneVaultDigest(e),promise:work});
    try{return await work;}finally{if(this.inflight.get(e.operationId)?.promise===work)this.inflight.delete(e.operationId);}
  }
  private async store(r:OneVaultRequest,t:OneVaultTrust,e:OneVaultEnvelope):Promise<OneVaultReceipt> {
    let value:Buffer|null=null,op:OneVaultOperation|undefined,writeAttempted=false;
    try {
      let lease=await this.authority(r,'decrypt'); this.current(r,t,lease);
      value=openOneVault(r,e,t.senderPublicKey,t.recipientPrivateKey);
      lease=await this.authority(r,'store'); this.current(r,t,lease);
      const reserved=this.p.journal.reserve(r,e); op=reserved.operation;
      if(reserved.duplicate)return this.receipt(r,t,op);
      this.p.invalidateProviderReadiness(op.slotId,op.expectedGeneration);
      this.current(r,t,lease);
      writeAttempted=true;
      if(e.action==='store') {
        const record:StoredRecord={schema:'agentlas.one-vault-record.v1',operationId:op.operationId,requestDigest:op.requestDigest,generation:op.generation,value:value!.toString('utf8')};
        await this.p.vault.setSecret(op.credentialRef,JSON.stringify(record));
        this.current(r,t,lease);
        if(op.previousRef) await this.p.vault.deleteSecret(op.previousRef);
      } else if(op.previousRef) await this.p.vault.deleteSecret(op.previousRef);
      lease=await this.authority(r,'commit'); this.current(r,t,lease);
      // Read-back confirms the exact immutable operation, never just key presence.
      if(!await this.observed(op))return this.receipt(r,t,this.p.journal.unknown(op.operationId));
      this.current(r,t,lease);
      op=this.p.journal.finish(op.operationId,e.action==='store'?'saved':'deleted');
      this.p.invalidateProviderReadiness(op.slotId,op.generation);
      return this.receipt(r,t,op);
    } catch(error) {
      if(op) {
        // A throw after native dispatch is uncertain, even if a storage adapter says timeout.
        // Keep the generation reservation locked; reconciliation never resends the raw value.
        const final=writeAttempted?this.p.journal.unknown(op.operationId):this.p.journal.finish(op.operationId,'failed',error instanceof OneVaultError?error.code:'store_failed');
        return this.receipt(r,t,final);
      }
      if(error instanceof OneVaultError)throw error;
      throw new OneVaultError('store_failed');
    } finally {value?.fill(0);}
  }
  private async observed(op:OneVaultOperation):Promise<boolean> {
    if(op.action==='delete')return op.previousRef===null || await this.p.vault.readSecret(op.previousRef)===null;
    if(op.previousRef && await this.p.vault.readSecret(op.previousRef)!==null)return false;
    return this.observedRecord(op);
  }
  private async observedRecord(op:OneVaultOperation):Promise<boolean> {
    const raw=await this.p.vault.readSecret(op.credentialRef); if(!raw)return false;
    try {const v=JSON.parse(raw) as StoredRecord; return v.schema==='agentlas.one-vault-record.v1' && v.operationId===op.operationId && v.requestDigest===op.requestDigest && v.generation===op.generation && typeof v.value==='string' && v.value.length>0;}
    catch{return false;}
  }
  async reconcile(requestId:string,query:OneVaultStatusQuery,options:{observeOnly?:boolean}={}):Promise<OneVaultReceipt> {
    const q=structuredClone(query),r=this.request(requestId,true),t=this.trusted(r);
    if(q.senderKeyId!==t.senderKeyId)throw new OneVaultError('sender_untrusted');
    validateOneVaultStatus(q,r,t.senderPublicKey,this.now());
    this.p.journal.consumeStatusNonce(q.nonce,q.expiresAt,this.now());
    const lease=await this.authority(r,'reconcile');this.current(r,t,lease,true);
    let op=this.p.journal.get(q.operationId);
    if(!op || op.requestDigest!==oneVaultDigest(r))throw new OneVaultError('not_found');
    if(!this.inflight.has(q.operationId) && ['reserved','store_unknown'].includes(op.state)) {
      try {
        if(!options.observeOnly && op.action==='store' && op.previousRef && await this.observedRecord(op)) {
          this.current(r,t,lease,true);
          await this.p.vault.deleteSecret(op.previousRef);
          this.current(r,t,lease,true);
        }
        if(await this.observed(op)) {
          this.current(r,t,lease,true);
          op=this.p.journal.finish(op.operationId,op.action==='store'?'saved':'deleted');
          this.p.invalidateProviderReadiness(op.slotId,op.generation);
        } else op=this.p.journal.unknown(op.operationId);
      } catch {op=this.p.journal.unknown(op.operationId);}
    }
    return this.receipt(r,t,op,q.nonce);
  }
  cancel(requestId:string,query:OneVaultCancelQuery):OneVaultCancelReceipt {
    const q=structuredClone(query),r=this.request(requestId,true),t=this.trusted(r);
    if(q.senderKeyId!==t.senderKeyId)throw new OneVaultError('sender_untrusted');
    validateOneVaultCancel(q,r,t.senderPublicKey,this.now());
    if(!this.p.cancelRequest)throw new OneVaultError('secure_route_unavailable');
    this.p.journal.consumeStatusNonce(q.nonce,q.expiresAt,this.now());
    this.p.cancelRequest(r);
    const op=this.p.journal.forRequest(oneVaultDigest(r));
    const state=op&&['reserved','store_unknown'].includes(op.state)?'effect_pending':op&&['saved','deleted'].includes(op.state)?'effect_completed':'cancelled';
    return signOneVault('cancel-receipt',{schema:'agentlas.one-vault-cancel-receipt.v1',hostId:r.binding.hostId,hostKeyId:t.hostKeyId,requestDigest:oneVaultDigest(r),requestId:r.binding.requestId,requestRevision:r.binding.requestRevision,operationId:op?.operationId??null,envelopeDigest:op?.envelopeDigest??null,state,generation:op&&['saved','deleted'].includes(op.state)?op.generation:r.binding.expectedGeneration,responseNonce:q.nonce,observedAt:this.now(),signature:''},t.hostSigningKey);
  }

}
