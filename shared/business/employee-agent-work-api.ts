import { businessNativeCanonical, isBusinessNativeIdentity, type BusinessNativeIdentity, type BusinessNativeRequestPayload } from './native-sharing-wire';
import { isBusinessId, isBusinessRevision, isBusinessSession, type BusinessResourceRef, type BusinessSession } from './context';
import { EMPLOYEE_AGENT_WORK_PURPOSE, workObject, type WorkLocalAppliedReceipt, type WorkMaterializationReceipt } from './employee-agent-work';
/** Dedicated WORK wire. Sharing/report enrollment is never WORK consent. */
export const WORK_NATIVE_WIRE = 'agentlas.business.work-native.v2' as const;
export const WORK_NATIVE_BASE = '/api/business/native/workspaces/' as const;
export const workSigningText = (domain:'association-approve'|'request',payload:unknown):string => businessNativeCanonical([WORK_NATIVE_WIRE,domain,payload]);
export interface WorkNativeChallenge {
 schema:typeof WORK_NATIVE_WIRE;challengeId:string;nonce:string;organizationLabel:string;orgSession:BusinessSession;native:BusinessNativeIdentity;
 purpose:typeof EMPLOYEE_AGENT_WORK_PURPOSE;issuedAt:number;expiresAt:number;
}
export interface WorkNativeApproval {challenge:WorkNativeChallenge;approvedAt:number;approvalReceiptId:string;signature:string}
export interface WorkNativeAssociation {
 schema:typeof WORK_NATIVE_WIRE;associationId:string;associationRevision:number;orgSession:BusinessSession;native:BusinessNativeIdentity;
 nativeAccountAuthEpoch:number;purpose:typeof EMPLOYEE_AGENT_WORK_PURPOSE;consentRevision:number;sourceRevision:number;
 state:'active'|'expired'|'revoked';expiresAt:number;
}
export interface WorkNativeProof {payload:BusinessNativeRequestPayload;signature:string}
export interface WorkOracleProof {artifactId:string;artifactDigest:string;oracleId:string;oracleRevision:string;fixtureDigest:string;reviewReceiptId:string}
export interface WorkRegistrationSubmission {
 schema:'agentlas.business.work-registration.v2';idempotencyKey:string;associationId:string;associationRevision:number;
 priorRegistration:{registrationId:string;registrationRevision:number}|null;
 receipt:WorkMaterializationReceipt;oracle:WorkOracleProof;evaluator:{version:string;digest:string};programs:Array<{path:string;programDigest:string}>;
}
export interface WorkRegistrationReceipt {
 schema:'agentlas.business.work-registration-receipt.v2';state:'approval-required'|'registered'|'expired'|'revoked'|'unknown';receiptId:string;
 associationId:string;associationRevision:number;registrationId:string;registrationRevision:number;assetId:string;
 materializationAcceptanceId:string;oracleAcceptanceId:string;resource:BusinessResourceRef|null;
}
export interface WorkIntentRequest {
 schema:'agentlas.business.work-intent-request.v2';idempotencyKey:string;registrationId:string;expectedRegistrationRevision:number;
 requestDigest:string;action:'edit'|'restore';oracleAcceptanceId:string;nativeSourceRevision:number;
}
/** Remote admission observation only; no serialized local grant/epoch. */
export interface WorkRootIntent extends WorkIntentRequest {
 schema:'agentlas.business.work-intent-request.v2';intentId:string;associationId:string;associationRevision:number;
 consentRevision:number;sourceRevision:number;state:'admitted'|'expired'|'revoked'|'unknown';issuedAt:number;expiresAt:number;
}
export interface WorkSemanticProof {artifactId:string;artifactDigest:string;beforeProgramDigest:string;afterProgramDigest:string;proposalDigest:string;requestDigest:string}
export interface WorkEvaluationProof {
 artifactId:string;artifactDigest:string;evaluatorVersion:string;evaluatorDigest:string;oracleAcceptanceId:string;fixtureDigest:string;
 before:{passed:number;total:number;costMinor:0};after:{passed:number;total:number;costMinor:0};passed:boolean;heldoutPassed:boolean;negativePassed:boolean;resultDigest:string;
}
export interface WorkNativeResult {
 schema:'agentlas.business.work-native-result.v2';associationId:string;associationRevision:number;intentId:string;registrationId:string;idempotencyKey:string;
 receipt:WorkLocalAppliedReceipt;execution:{chatId:string;leaseId:string;ownerId:string;inputDigest:string;inputRevision:string;sourceProofDigest:string};
 semantic:WorkSemanticProof;evaluation:WorkEvaluationProof;oracle:WorkOracleProof;
}
/** Only Root's actual final CAS can produce newTarget. A local apply is retained
 * when final recording fails; no implicit rollback or effect replay. */
export interface WorkFinalizationReceipt {
 schema:'agentlas.business.work-finalization.v2';receiptId:string;associationId:string;associationRevision:number;intentId:string;
 nativeAcceptanceId:string;nativeState:'native-applied';rootRecording:'finalized'|'rejected'|'unknown'|'expired'|'revoked';
 registrationId:string;registrationRevision:number;newTarget:BusinessResourceRef|null;reason:string|null;
}
export function isWorkChallenge(v:unknown):v is WorkNativeChallenge {
 return workObject(v,['schema','challengeId','nonce','organizationLabel','orgSession','native','purpose','issuedAt','expiresAt'])&&v.schema===WORK_NATIVE_WIRE&&v.purpose===EMPLOYEE_AGENT_WORK_PURPOSE
  &&typeof v.organizationLabel==='string'&&v.organizationLabel.trim()===v.organizationLabel&&v.organizationLabel.length>0&&v.organizationLabel.length<=160&&!/[\u0000-\u001f\u007f]/.test(v.organizationLabel)&&isBusinessId(v.challengeId)&&isBusinessId(v.nonce)&&isBusinessSession(v.orgSession)&&isBusinessNativeIdentity(v.native)&&isBusinessRevision(v.issuedAt)&&isBusinessRevision(v.expiresAt)&&v.expiresAt>v.issuedAt&&v.expiresAt-v.issuedAt<=300000;
}
export function isWorkAssociation(v:unknown):v is WorkNativeAssociation {
 return workObject(v,['schema','associationId','associationRevision','orgSession','native','nativeAccountAuthEpoch','purpose','consentRevision','sourceRevision','state','expiresAt'])&&v.schema===WORK_NATIVE_WIRE&&v.purpose===EMPLOYEE_AGENT_WORK_PURPOSE
  &&isBusinessId(v.associationId)&&isBusinessSession(v.orgSession)&&isBusinessNativeIdentity(v.native)&&[v.associationRevision,v.nativeAccountAuthEpoch,v.consentRevision,v.sourceRevision,v.expiresAt].every(isBusinessRevision)&&['active','expired','revoked'].includes(v.state as string);
}
export interface WorkChoice {id:string;label:string;paths?:string[]}
export interface WorkUiStatus {state:'disconnected'|'associated'|'native-registered'|'approval-required'|'registered'|'preparing'|'review-required'|'native-applied'|'finalized'|'rejected'|'unknown'|'expired'|'revoked'|'original-execution-unavailable';label?:string;reason?:string;selection?:string;registrationId?:string}
/** Renderer selects original records; it cannot choose execution tuples or grants. */
export interface EmployeeAgentWorkAPI {
 identity():Promise<BusinessNativeIdentity>;
 approveAssociation(input:{challengeId:string}):Promise<WorkUiStatus>;
 reconcile(input:{selection:string}):Promise<WorkUiStatus>;
 sources():Promise<WorkChoice[]>;
 files(input:{sourceId:string}):Promise<string[]>;
 register(input:{sourceId:string;paths:string[]}):Promise<WorkUiStatus>;
 oracle(input:{selection:string}):Promise<WorkUiStatus>;
 workspaces():Promise<WorkChoice[]>;
 prepare(input:{selection:string;path:string;action:'edit'|'restore';revision?:string}):Promise<WorkUiStatus>;
 review(input:{selection:string}):Promise<WorkUiStatus>;
 receipt(input:{selection:string}):Promise<WorkUiStatus>;
 revoke():Promise<WorkUiStatus>;
 cancel(input:{selection:string}):Promise<WorkUiStatus>;
}
