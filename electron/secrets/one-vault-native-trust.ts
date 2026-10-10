import {oneMobileEnrollmentSas,verifyOneMobileEnrollment,validateOneMobileEnrollmentCandidate,type OneMobileEnrollmentCandidate,type OneMobileEnrollmentChallenge} from './one-mobile-enrollment';
import {randomUUID,randomBytes,createPrivateKey} from 'node:crypto';
import {OneVaultError} from '../../shared/one-vault';
import {generateOneVaultKey,oneVaultDigest,oneVaultPublicPoint} from './one-vault-crypto';
import type {OneVaultSqlite} from './one-vault-journal';
import type {OneVaultApprovedHostMetadata,OneVaultApprovedSenderMetadata,OneVaultExistingOsVault,OneVaultNativeTrustPort} from './one-vault-service';
/** Main-only opaque native interaction. A renderer's boolean/serialized object cannot authorize setup. */
export interface OneVaultNativeOwnerAction {readonly __oneVaultNativeOwnerAction?:never}
export interface OneVaultNativeOwner {
 hostId:string;principalId:string;sessionId:string;workspaceId:string;custodyGeneration:string;
}
export interface OneVaultHostTrustDisclosure {
 schema:'agentlas.one-vault-native-approval.v1';operation:'initialize'|'rotate'|'reconcile'|'reauthorize';operationId:string;
 owner:OneVaultNativeOwner;generation:number;storage:'os-vault';charge:'none';
 signingPublicKey:string;recipientPublicKey:string;
}
export interface OneVaultSenderTrustDisclosure {
 schema:'agentlas.one-vault-native-approval.v1';operation:'enroll-sender';operationId:string;
 owner:OneVaultNativeOwner;generation:number;storage:'os-vault';charge:'none';
 challenge:OneMobileEnrollmentChallenge;sas:string;mobileInteractionId:string;
}
export type OneVaultTrustDisclosure=OneVaultHostTrustDisclosure|OneVaultSenderTrustDisclosure;
export interface OneVaultNativeTrustPorts {
 db:OneVaultSqlite;vault:OneVaultExistingOsVault;
 /** Resolve only the runtime-owned opaque action carrying a native enrollment capability. */
 senderEnrollment?(action:OneVaultNativeOwnerAction):OneMobileEnrollmentCandidate|null;
 /** Derived from oneNativeHostIdentity + getAuthenticatedSessionBinding + live sole Supervisor owner. */
 currentOwner():OneVaultNativeOwner|null;
 /** Must check actual trusted focused native owner action, show exact disclosure, and return only a native receipt. */
 approve(action:OneVaultNativeOwnerAction,disclosure:Readonly<OneVaultTrustDisclosure>):Promise<{approved:boolean;interactionId:string}>;
 /** Checks revocation/logout of the recorded native approval, not a provider grant or bearer. */
 approvalStillValid(interactionId:string,owner:Readonly<OneVaultNativeOwner>,metadataDigest:string):boolean;
 audit(event:{operationId:string;hostId:string;principalId:string;generation:number;state:'active'|'unknown'|'revoked';metadataDigest:string}):void;
 now?:()=>number;
}
interface TrustRecord {id:string;owner:OneVaultNativeOwner;metadata:OneVaultApprovedHostMetadata;metadataDigest:string;interactionId:string;state:'writing'|'unknown'|'active'|'revoked';createdAt:number}
/** Same DB, value-free native security-effect ledger. No request engine/work queue or PEM in SQL. */
export class OneVaultNativeTrustLedger implements OneVaultNativeTrustPort {
 private opening=false;
 constructor(private readonly p:OneVaultNativeTrustPorts){
  p.db.exec(`CREATE TABLE IF NOT EXISTS one_vault_native_trust(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(host_id,generation));
   CREATE TABLE IF NOT EXISTS one_vault_native_sender_trust(sender_id TEXT PRIMARY KEY,record_json TEXT NOT NULL,approval_owner_json TEXT NOT NULL,interaction_id TEXT NOT NULL);`);
 }
 private now(){return this.p.now?.()??Date.now();}
 private owner():OneVaultNativeOwner {const o=this.p.currentOwner();if(!o||Object.values(o).some(v=>typeof v!=='string'||!v||v.length>256))throw new OneVaultError('authority_denied');return structuredClone(o);}
 private sameOwner(owner:OneVaultNativeOwner):boolean{return oneVaultDigest(this.p.currentOwner())===oneVaultDigest(owner);}
 private latest(hostId:string):TrustRecord|null{const r=this.p.db.prepare('SELECT record_json FROM one_vault_native_trust WHERE host_id=? ORDER BY generation DESC LIMIT 1').get(hostId) as {record_json:string}|undefined;if(!r)return null;try{return JSON.parse(r.record_json) as TrustRecord;}catch{throw new OneVaultError('secure_route_unavailable');}}
 private save(record:TrustRecord,previousState:TrustRecord['state']):void{const n=this.p.db.prepare('UPDATE one_vault_native_trust SET state=?,record_json=? WHERE id=? AND state=?').run(record.state,JSON.stringify(record),record.id,previousState);if(Number(n.changes)!==1)throw new OneVaultError('generation_conflict');}
 private audit(r:TrustRecord):void{try{this.p.audit({operationId:r.id,hostId:r.owner.hostId,principalId:r.owner.principalId,generation:r.metadata.generation,state:r.state==='active'?'active':r.state==='revoked'?'revoked':'unknown',metadataDigest:r.metadataDigest});}catch{/* Audit transport must never leak a key or alter an already stored effect. */}}
 private valid(r:TrustRecord):boolean{return r.state==='active'&&this.sameOwner(r.owner)&&r.metadataDigest===oneVaultDigest(r.metadata)&&this.p.approvalStillValid(r.interactionId,Object.freeze(structuredClone(r.owner)),r.metadataDigest);}
 currentHostMetadata():OneVaultApprovedHostMetadata|null {
  try{const owner=this.owner(),r=this.latest(owner.hostId);return r&&this.valid(r)?structuredClone(r.metadata):null;}catch{return null;}
 }
 async approvedHost():Promise<OneVaultApprovedHostMetadata|null>{return this.currentHostMetadata();}
 nativeApprovalValid(receiptId:string,metadataDigest:string):boolean {
  try{const owner=this.owner(),r=this.latest(owner.hostId);if(r&&r.metadata.approvedNativeReceiptId===receiptId&&r.metadataDigest===metadataDigest)return this.valid(r);
   const row=this.p.db.prepare('SELECT record_json,approval_owner_json,interaction_id FROM one_vault_native_sender_trust WHERE json_extract(record_json,\'$.approvedNativeReceiptId\')=?').get(receiptId) as {record_json:string;approval_owner_json:string;interaction_id:string}|undefined;
   if(!row)return false;const m=JSON.parse(row.record_json) as OneVaultApprovedSenderMetadata,o=JSON.parse(row.approval_owner_json) as OneVaultNativeOwner;
   return m.revokedAt===null&&oneVaultDigest(m)===metadataDigest&&this.sameOwner(o)&&this.p.approvalStillValid(row.interaction_id,o,metadataDigest);
  }catch{return false;}
 }
 approvedMobileSender(senderId:string):OneVaultApprovedSenderMetadata|null {
  try{const row=this.p.db.prepare('SELECT record_json FROM one_vault_native_sender_trust WHERE sender_id=?').get(senderId) as {record_json:string}|undefined;if(!row)return null;const m=JSON.parse(row.record_json) as OneVaultApprovedSenderMetadata;const host=this.currentHostMetadata();return host&&host.hostId===m.hostId&&host.generation===m.generation&&this.nativeApprovalValid(m.approvedNativeReceiptId,oneVaultDigest(m))?m:null;}catch{return null;}
 }
 /** Explicit separately approved Mobile interaction and focused native owner approval.
  * Uses only the existing sender ledger and approval journal; writes no OS secret. */
 async enrollMobileSender(action:OneVaultNativeOwnerAction):Promise<{state:'active'|'unknown';metadata:OneVaultApprovedSenderMetadata|null;approvalId:string}> {
  if(this.opening)throw new OneVaultError('generation_conflict');this.opening=true;
  try{
   const candidate=this.p.senderEnrollment?.(action);if(!candidate)throw new OneVaultError('secure_route_unavailable');
   validateOneMobileEnrollmentCandidate(candidate);
   const {stillCurrent,confirm,...raw}=candidate,c=structuredClone(raw),owner=this.owner(),host=this.currentHostMetadata();
   const candidateDigest=oneVaultDigest(c);
   const current=()=>{try{const now=this.now(),next=this.p.senderEnrollment?.(action);if(next!==candidate)return false;const {stillCurrent:_,confirm:__,...latest}=next;return now<c.expiresAt&&stillCurrent.call(candidate)&&oneVaultDigest(latest)===candidateDigest&&this.sameOwner(owner)&&oneVaultDigest(this.currentHostMetadata())===oneVaultDigest(host)}catch{return false}};
   if(!host||!current()||c.expiresAt>this.now()+120000||c.hostId!==owner.hostId||c.principalId!==owner.principalId||c.workspaceId!==owner.workspaceId)throw new OneVaultError('authority_denied');
   const prior=this.p.db.prepare('SELECT * FROM one_vault_native_sender_trust WHERE sender_id=?').get(c.senderId) as {sender_id:string;record_json:string;approval_owner_json:string;interaction_id:string}|undefined;
   if((prior?oneVaultDigest(JSON.parse(prior.record_json)):null)!==c.expectedSenderDigest)throw new OneVaultError('generation_conflict');
   const challenge:OneMobileEnrollmentChallenge={schema:'agentlas.one-mobile-enrollment.v1',operationId:randomUUID(),nonce:randomBytes(32).toString('base64url'),expiresAt:c.expiresAt,owner,hostKeyId:host.hostKeyId,hostPublicKey:host.signingPublicKey,generation:host.generation,senderId:c.senderId,senderKeyId:c.senderKeyId,publicKey:c.publicKey,organizationId:c.organizationId,deviceId:c.deviceId,channelId:c.channelId,channelEpoch:c.channelEpoch,revision:c.revision,expectedSenderDigest:c.expectedSenderDigest,permissions:['credential-submit'],storage:'os-vault',charge:'none'};
   Object.freeze(challenge.owner);Object.freeze(challenge.permissions);Object.freeze(challenge);
   const sas=oneMobileEnrollmentSas(challenge),proof=await confirm.call(candidate,challenge,sas);
   if(!current()||!proof||typeof proof.interactionId!=='string'||!proof.interactionId||proof.interactionId.length>256||!verifyOneMobileEnrollment(challenge,proof.signature))throw new OneVaultError('authority_denied');
   const disclosure:OneVaultSenderTrustDisclosure={schema:'agentlas.one-vault-native-approval.v1',operation:'enroll-sender',operationId:challenge.operationId,owner,generation:host.generation,storage:'os-vault',charge:'none',challenge,sas,mobileInteractionId:proof.interactionId};
   const approval=await this.p.approve(action,Object.freeze(disclosure));
   // approve consumes the opaque action. Validate the retained independent native source,
   // exact host/custody and immutable candidate again without reviving that action.
   const after=()=>{try{const {stillCurrent:_,confirm:__,...latest}=candidate;return this.now()<c.expiresAt&&stillCurrent.call(candidate)&&oneVaultDigest(latest)===candidateDigest&&this.sameOwner(owner)&&oneVaultDigest(this.currentHostMetadata())===oneVaultDigest(host)}catch{return false}};
   if(!approval.approved||!approval.interactionId||!after())throw new OneVaultError('authority_denied');
   const metadata:OneVaultApprovedSenderMetadata={hostId:owner.hostId,senderId:c.senderId,senderKeyId:c.senderKeyId,publicKey:c.publicKey,generation:host.generation,principalId:owner.principalId,workspaceId:owner.workspaceId,organizationId:c.organizationId,approvedNativeReceiptId:approval.interactionId,revokedAt:null};
   const json=JSON.stringify(metadata),metadataDigest=oneVaultDigest(metadata);
   const audit=(state:'active'|'unknown')=>{try{this.p.audit({operationId:challenge.operationId,hostId:owner.hostId,principalId:owner.principalId,generation:host.generation,state,metadataDigest})}catch{/* Safe audit transport does not alter a committed effect. */}};
   if(!this.p.approvalStillValid(approval.interactionId,owner,metadataDigest))throw new OneVaultError('authority_denied');
   try{this.p.db.transaction(()=>{
    if(!after()||!this.p.approvalStillValid(approval.interactionId,owner,metadataDigest))throw new OneVaultError('authority_denied');
    const latest=this.p.db.prepare('SELECT * FROM one_vault_native_sender_trust WHERE sender_id=?').get(c.senderId);
    if(oneVaultDigest(latest?{...latest}:null)!==oneVaultDigest(prior?{...prior}:null))throw new OneVaultError('generation_conflict');
    if(prior){const n=this.p.db.prepare('UPDATE one_vault_native_sender_trust SET record_json=?,approval_owner_json=?,interaction_id=? WHERE sender_id=? AND record_json=? AND approval_owner_json=? AND interaction_id=?').run(json,JSON.stringify(owner),approval.interactionId,c.senderId,prior.record_json,prior.approval_owner_json,prior.interaction_id);if(Number(n.changes)!==1)throw new OneVaultError('generation_conflict');}
    else this.p.db.prepare('INSERT INTO one_vault_native_sender_trust VALUES(?,?,?,?)').run(c.senderId,json,JSON.stringify(owner),approval.interactionId);
    const read=this.p.db.prepare('SELECT record_json FROM one_vault_native_sender_trust WHERE sender_id=?').get(c.senderId) as {record_json:string}|undefined;
    if(read?.record_json!==json||!after())throw new OneVaultError('generation_conflict');
   }).immediate();}catch(e){if(e instanceof OneVaultError)throw e;audit('unknown');return{state:'unknown',metadata:null,approvalId:approval.interactionId};}
   audit('active');return{state:'active',metadata:structuredClone(metadata),approvalId:approval.interactionId};
  }finally{this.opening=false;}
 }
 /** Read the exact uncertain enrollment effect; never generates a challenge or replays approval. */
 senderEnrollmentStatus(senderId:string,approvalId:string):OneVaultApprovedSenderMetadata|null {const m=this.approvedMobileSender(senderId);return m?.approvedNativeReceiptId===approvalId?m:null;}
 /** Explicit owner native approval only. Never call from bootstrap/presence/relay or configure. */
 async initializeOrRotate(action:OneVaultNativeOwnerAction):Promise<{state:'active'|'unknown';metadata:OneVaultApprovedHostMetadata|null}> {
  if(this.opening)throw new OneVaultError('generation_conflict');this.opening=true;
  try{
   const owner=this.owner(),prior=this.latest(owner.hostId);
   if(prior&&['writing','unknown'].includes(prior.state))throw new OneVaultError('store_unknown');
   const generation=(prior?.metadata.generation??0)+1,id=randomUUID(),signing=generateOneVaultKey(),recipient=generateOneVaultKey();
   const disclosure:OneVaultTrustDisclosure={schema:'agentlas.one-vault-native-approval.v1',operation:prior?'rotate':'initialize',operationId:id,owner,generation,storage:'os-vault',charge:'none',signingPublicKey:oneVaultPublicPoint(signing.publicKey),recipientPublicKey:oneVaultPublicPoint(recipient.publicKey)};
   const approval=await this.p.approve(action,Object.freeze(structuredClone(disclosure)));
   if(!approval.approved||!approval.interactionId||!this.sameOwner(owner))throw new OneVaultError('authority_denied');
   const metadata:OneVaultApprovedHostMetadata={hostId:owner.hostId,hostKeyId:`native-sign:${id}`,signingKeyRef:`one-vault-trust:${id}:signing`,signingPublicKey:disclosure.signingPublicKey,recipientKeyId:`native-seal:${id}`,recipientKeyRef:`one-vault-trust:${id}:recipient`,recipientPublicKey:disclosure.recipientPublicKey,generation,approvedNativeReceiptId:approval.interactionId,revokedAt:null};
   const record:TrustRecord={id,owner,metadata,metadataDigest:oneVaultDigest(metadata),interactionId:approval.interactionId,state:'writing',createdAt:this.now()};
   if(!this.p.approvalStillValid(approval.interactionId,owner,record.metadataDigest))throw new OneVaultError('authority_denied');
   this.p.db.transaction(()=>{const current=this.latest(owner.hostId);if((current?.id??null)!==(prior?.id??null))throw new OneVaultError('generation_conflict');this.p.db.prepare('INSERT INTO one_vault_native_trust VALUES(?,?,?,?,?)').run(id,owner.hostId,generation,record.state,JSON.stringify(record));}).immediate();
   // Persist intent before native effect. Private PEMs exist only in Main memory and approved OS custody.
   try{
    await this.p.vault.setSecret(metadata.signingKeyRef,signing.privateKey.export({format:'pem',type:'pkcs8'}).toString());
    if(!this.sameOwner(owner)||!this.p.approvalStillValid(approval.interactionId,owner,record.metadataDigest))throw new OneVaultError('authority_denied');
    await this.p.vault.setSecret(metadata.recipientKeyRef,recipient.privateKey.export({format:'pem',type:'pkcs8'}).toString());
    return await this.reconcileRecord(record);
   }catch{
    const current=this.latest(owner.hostId);if(current?.id===record.id&&current.state==='writing'){current.state='unknown';this.save(current,'writing');this.audit(current);}
    return {state:'unknown',metadata:null};
   }
  }finally{this.opening=false;}
 }
 private unknown(r:TrustRecord):{state:'unknown';metadata:null}{const current=this.latest(r.owner.hostId);if(current?.id===r.id&&current.state!=='revoked'){const old=current.state;current.state='unknown';this.save(current,old);this.audit(current);}return{state:'unknown',metadata:null};}
 private async reconcileRecord(r:TrustRecord):Promise<{state:'active'|'unknown';metadata:OneVaultApprovedHostMetadata|null}> {
  if(!this.sameOwner(r.owner)||!this.p.approvalStillValid(r.interactionId,r.owner,r.metadataDigest))return this.unknown(r);
  const expectedRecord=JSON.stringify(r),points:string[]=[];
  try{for(const ref of [r.metadata.signingKeyRef,r.metadata.recipientKeyRef]){await this.p.vault.retryCredentialReadFromUser('secret',ref);const raw=await this.p.vault.readSecret(ref);if(!raw)throw new OneVaultError('store_unknown');points.push(oneVaultPublicPoint(createPrivateKey(raw)));}}
  catch{return this.unknown(r);}
  if(points[0]!==r.metadata.signingPublicKey||points[1]!==r.metadata.recipientPublicKey||!this.sameOwner(r.owner)||!this.p.approvalStillValid(r.interactionId,r.owner,r.metadataDigest))return this.unknown(r);
  r.state='active';const changed=this.p.db.prepare('UPDATE one_vault_native_trust SET state=?,record_json=? WHERE id=? AND record_json=?').run('active',JSON.stringify(r),r.id,expectedRecord);if(Number(changed.changes)!==1)throw new OneVaultError('generation_conflict');this.audit(r);return {state:'active',metadata:structuredClone(r.metadata)};
 }
 /** Explicit native status action; no generation or key creation, even when one ref is missing. */
 async reconcile(action:OneVaultNativeOwnerAction):Promise<{state:'active'|'unknown';metadata:OneVaultApprovedHostMetadata|null}> {
  if(this.opening)throw new OneVaultError('store_unknown');
  const owner=this.owner(),r=this.latest(owner.hostId);if(!r||!this.sameOwner(r.owner))throw new OneVaultError('secure_route_unavailable');
  // Native interaction validation is repeated for sensitive read retry, with the exact recorded disclosure.
  const approval=await this.p.approve(action,Object.freeze({schema:'agentlas.one-vault-native-approval.v1',operation:'reconcile',operationId:r.id,owner:r.owner,generation:r.metadata.generation,storage:'os-vault',charge:'none',signingPublicKey:r.metadata.signingPublicKey,recipientPublicKey:r.metadata.recipientPublicKey}));
  if(!approval.approved||!this.sameOwner(owner))throw new OneVaultError('authority_denied');
  if(r.state==='revoked')throw new OneVaultError('secure_route_unavailable');
  return this.reconcileRecord(r);
 }
 /** Explicit restart/session renewal of the SAME keys. Never rotates or retransmits a PEM.
  * Stable host/principal/workspace must match; native current owner approves the exact points.
  * New owner/receipt intent is CAS-persisted before readback; failure stays unknown and locked. */
 async reauthorizeExisting(action:OneVaultNativeOwnerAction):Promise<{state:'active'|'unknown';metadata:OneVaultApprovedHostMetadata|null}> {
  if(this.opening)throw new OneVaultError('store_unknown');this.opening=true;
  try{const owner=this.owner(),r=this.latest(owner.hostId);if(!r||r.state==='revoked'||r.owner.hostId!==owner.hostId||r.owner.principalId!==owner.principalId||r.owner.workspaceId!==owner.workspaceId)throw new OneVaultError('secure_route_unavailable');
   const previous=JSON.stringify(r),approval=await this.p.approve(action,Object.freeze({schema:'agentlas.one-vault-native-approval.v1',operation:'reauthorize',operationId:r.id,owner,generation:r.metadata.generation,storage:'os-vault',charge:'none',signingPublicKey:r.metadata.signingPublicKey,recipientPublicKey:r.metadata.recipientPublicKey}));
   if(!approval.approved||!approval.interactionId||!this.sameOwner(owner))throw new OneVaultError('authority_denied');
   const metadata={...r.metadata,approvedNativeReceiptId:approval.interactionId},next:TrustRecord={...r,owner,metadata,metadataDigest:oneVaultDigest(metadata),interactionId:approval.interactionId,state:'unknown'};
   if(!this.p.approvalStillValid(approval.interactionId,owner,next.metadataDigest))throw new OneVaultError('authority_denied');
   const changed=this.p.db.prepare('UPDATE one_vault_native_trust SET state=?,record_json=? WHERE id=? AND record_json=? AND state<>?').run('unknown',JSON.stringify(next),r.id,previous,'revoked');
   if(Number(changed.changes)!==1)throw new OneVaultError('generation_conflict');this.audit(next);return this.reconcileRecord(next);
  }finally{this.opening=false;}
 }
 /** Current owner logout/principal/custody changes already make reads fail closed; explicit revocation
  * records metadata only and makes no claim of provider/device/OS key deletion. */
 revokeCurrent():void{const owner=this.owner(),r=this.latest(owner.hostId);if(!r)return;const previous=r.state;r.state='revoked';r.metadata.revokedAt=this.now();r.metadataDigest=oneVaultDigest(r.metadata);this.save(r,previous);this.audit(r);}
}
let nativeTrust:OneVaultNativeTrustLedger|null=null;
export function configureOneVaultNativePorts(ports:OneVaultNativeTrustPorts):OneVaultNativeTrustLedger {
 if(nativeTrust)throw new OneVaultError('secure_route_unavailable');nativeTrust=new OneVaultNativeTrustLedger(ports);return nativeTrust;
}
export function currentOneVaultNativeTrust():OneVaultNativeTrustLedger|null{return nativeTrust;}
