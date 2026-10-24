import { isBusinessId, isBusinessSession, isBusinessRevision as isRevision, type BusinessSession } from "./context";
import { businessEmployeeAgentHex as employeeAgentHex, businessEmployeeAgentIds, businessEmployeeAgentOnly as employeeAgentOnly } from "./employee-agent-report";
const employeeAgentIds=(v:unknown,limit:number,nonempty:boolean)=>businessEmployeeAgentIds(v,nonempty)&&v.length<=limit;

export const BUSINESS_NATIVE_SHARING_SCHEMA = "agentlas.business.native-sharing.v1" as const;
export const BUSINESS_NATIVE_SHARING_PURPOSE = "organization.employee-agent-report" as const;
export interface BusinessNativeIdentity {
  readonly nativeAccountId: string; readonly nativeWorkspaceId: string; readonly nativeSessionId: string;
  readonly nativeSessionRevision: string; readonly nativeHostId: string; readonly oneId: string;
  readonly hostKeyId: string; readonly hostPublicKey: string; readonly custodyGeneration: string;
  readonly installationGeneration: number; readonly trustGeneration: number;
}
export interface BusinessNativeChallenge {
  readonly schema: typeof BUSINESS_NATIVE_SHARING_SCHEMA; readonly challengeId: string; readonly nonce: string;
  readonly orgSession: BusinessSession; readonly native: BusinessNativeIdentity;
  readonly purpose: typeof BUSINESS_NATIVE_SHARING_PURPOSE; readonly audiencePrincipalIds: readonly string[];
  readonly sourceAuthorityId: string; readonly commandAuthorityId: string;
  readonly issuedAt: number; readonly expiresAt: number;
}
export interface BusinessNativeApproval {
  readonly challenge: BusinessNativeChallenge; readonly approvedAt: number; readonly approvalReceiptId: string; readonly signature: string;
}
export interface BusinessNativeAssociation {
  readonly associationId: string; readonly associationRevision: number; readonly orgSession: BusinessSession;
  readonly native: BusinessNativeIdentity; readonly nativeAccountAuthEpoch: number;
  readonly purpose: typeof BUSINESS_NATIVE_SHARING_PURPOSE; readonly audiencePrincipalIds: readonly string[];
  readonly sourceAuthorityId: string; readonly commandAuthorityId: string;
  readonly consentRevision: number; readonly sourceRevision: number; readonly state: "active" | "revoked"; readonly expiresAt: string;
}
export interface BusinessNativeRequestPayload {
  readonly associationId: string; readonly associationRevision: number; readonly native: BusinessNativeIdentity;
  readonly nativeAccountAuthEpoch: number; readonly method: string; readonly url: string; readonly bodyDigest: string;
  readonly nonce: string; readonly sequence: number; readonly issuedAt: number; readonly expiresAt: number;
}
export interface BusinessNativeRequestProof { readonly payload: BusinessNativeRequestPayload; readonly signature: string }
export interface BusinessNativeCustodyReceipt {
  readonly schema: typeof BUSINESS_NATIVE_SHARING_SCHEMA; readonly receiptId: string; readonly associationId: string;
  readonly idempotencyKey: string; readonly kind: "packet" | "revoke"; readonly packetDigest: string | null; readonly nativePacketDigest: string | null;
  readonly sourceRevision: number; readonly consentRevision: number; readonly replayed: boolean;
}
/** Original Root durable proof that this exact report intent was not dispatched.
 * It grants no publication permission; continuation rechecks current enrollment. */
export interface BusinessNativePublicationDeferral {
 readonly schema:'agentlas.business.native-publication-deferral.v1';
 readonly state:'not-executed';readonly reason:'enrollment-required'|'publication-not-dispatched';readonly receiptId:string;
 readonly associationId:string;readonly associationRevision:number;readonly sourceRevision:number;readonly consentRevision:number;
 readonly request:import('./employee-agent-report').BusinessEmployeeAgentReportRequest;
 readonly nativePacketDigest:string;
}
export function isBusinessNativePublicationDeferral(v:unknown):v is BusinessNativePublicationDeferral {
 if(!employeeAgentOnly(v,['schema','state','reason','receiptId','associationId','associationRevision','sourceRevision','consentRevision','request','nativePacketDigest']))return false;
 const request=v.request;
 return v.schema==='agentlas.business.native-publication-deferral.v1'&&v.state==='not-executed'&&(v.reason==='enrollment-required'||v.reason==='publication-not-dispatched')
  &&isBusinessId(v.receiptId)&&isBusinessId(v.associationId)&&[v.associationRevision,v.sourceRevision,v.consentRevision].every(isRevision)&&employeeAgentHex(v.nativePacketDigest)
  &&employeeAgentOnly(request,['kind','agentResourceId','ownerReportId','expectedRevision','idempotencyKey'])&&request.kind==='report'
  &&[request.agentResourceId,request.ownerReportId,request.idempotencyKey].every(isBusinessId)&&(request.expectedRevision===null||isRevision(request.expectedRevision));
}
/** A distinct, current Root CAS receipt fences a lost old continuation. It is
 * not a report receipt and cannot grant an enrollment or agent permission. */
export interface BusinessNativePublicationRecovery {
 readonly schema:'agentlas.business.native-publication-recovery.v1';readonly state:'recoverable';
 readonly recoveryReceiptId:string;readonly deferralReceiptId:string;
 readonly associationId:string;readonly associationRevision:number;readonly sourceRevision:number;readonly consentRevision:number;
 readonly request:import('./employee-agent-report').BusinessEmployeeAgentReportRequest;readonly nativePacketDigest:string;
}
export function isBusinessNativePublicationRecovery(v:unknown):v is BusinessNativePublicationRecovery {
 if(!employeeAgentOnly(v,['schema','state','recoveryReceiptId','deferralReceiptId','associationId','associationRevision','sourceRevision','consentRevision','request','nativePacketDigest']))return false;
 const r=v as unknown as BusinessNativePublicationRecovery;
 return r.schema==='agentlas.business.native-publication-recovery.v1'&&r.state==='recoverable'
  &&[r.recoveryReceiptId,r.deferralReceiptId,r.associationId].every(isBusinessId)
  &&[r.associationRevision,r.sourceRevision,r.consentRevision].every(isRevision)
  &&employeeAgentHex(r.nativePacketDigest)
  &&isBusinessNativePublicationDeferral({schema:'agentlas.business.native-publication-deferral.v1',state:'not-executed',reason:'enrollment-required',
    receiptId:r.deferralReceiptId,associationId:r.associationId,associationRevision:r.associationRevision,
    sourceRevision:r.sourceRevision,consentRevision:r.consentRevision,request:r.request,nativePacketDigest:r.nativePacketDigest});
}
/** Cross-runtime signature encoding. No getters, sparse arrays, undefined, secrets,
 * floats or coercions enter signed bytes. Object keys sort; array order is retained. */
export function businessNativeCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (isRevision(value)) return String(value);
  if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(k => typeof k === "string" && (k === "length" || /^(0|[1-9][0-9]*)$/.test(k)) && Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,"value")))
    return "[" + value.map(businessNativeCanonical).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(k => typeof k === "string" && Object.getOwnPropertyDescriptor(value, k)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, k)!, "value")))
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + businessNativeCanonical((value as Record<string, unknown>)[k])).join(",") + "}";
  throw new Error("business_native_invalid_canonical");
}
function decode(v:unknown,size:number):boolean{
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 return typeof v==='string'&&((size===65&&/^[A-Za-z0-9_-]{87}$/.test(v)&&alphabet.indexOf(v.at(-1)!)%4===0)||(size===64&&/^[A-Za-z0-9_-]{86}$/.test(v)&&alphabet.indexOf(v.at(-1)!)%16===0));
}
export const businessNativeSigningText=(domain:'association-approve'|'request'|'device-register',payload:unknown):string=>businessNativeCanonical([BUSINESS_NATIVE_SHARING_SCHEMA,domain,payload]);
export function isBusinessNativeIdentity(v: unknown): v is BusinessNativeIdentity {
  return employeeAgentOnly(v, ["nativeAccountId", "nativeWorkspaceId", "nativeSessionId", "nativeSessionRevision", "nativeHostId", "oneId",
    "hostKeyId", "hostPublicKey", "custodyGeneration", "installationGeneration", "trustGeneration"])
    && [v.nativeAccountId, v.nativeWorkspaceId, v.nativeSessionId, v.nativeSessionRevision, v.nativeHostId, v.oneId, v.hostKeyId, v.custodyGeneration].every(isBusinessId)
    && isRevision(v.installationGeneration) && isRevision(v.trustGeneration) && !!decode(v.hostPublicKey, 65);
}
export function isBusinessNativeChallenge(v: unknown): v is BusinessNativeChallenge {
  return employeeAgentOnly(v, ["schema", "challengeId", "nonce", "orgSession", "native", "purpose", "audiencePrincipalIds", "sourceAuthorityId", "commandAuthorityId", "issuedAt", "expiresAt"])
    && v.schema === BUSINESS_NATIVE_SHARING_SCHEMA && [v.challengeId, v.nonce, v.sourceAuthorityId, v.commandAuthorityId].every(isBusinessId)
    && isBusinessSession(v.orgSession) && isBusinessNativeIdentity(v.native) && v.purpose === BUSINESS_NATIVE_SHARING_PURPOSE
    && employeeAgentIds(v.audiencePrincipalIds, 64, true) && (v.audiencePrincipalIds as readonly string[]).includes(v.orgSession.principalId)
    && isRevision(v.issuedAt) && isRevision(v.expiresAt) && v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 300000;
}
export function isBusinessNativeRequestProof(v: unknown): v is BusinessNativeRequestProof {
  if (!employeeAgentOnly(v, ["payload", "signature"]) || !decode(v.signature, 64)) return false;
  const p = v.payload;
  return employeeAgentOnly(p, ["associationId", "associationRevision", "native", "nativeAccountAuthEpoch", "method", "url", "bodyDigest", "nonce", "sequence", "issuedAt", "expiresAt"])
    && [p.associationId, p.nonce].every(isBusinessId) && isBusinessNativeIdentity(p.native)
    && [p.associationRevision, p.nativeAccountAuthEpoch, p.sequence, p.issuedAt, p.expiresAt].every(isRevision)
    && ["GET", "POST", "PATCH", "DELETE"].includes(p.method as string) && typeof p.url === "string" && p.url.length <= 2048
    && employeeAgentHex(p.bodyDigest) && (p.expiresAt as number) > (p.issuedAt as number) && (p.expiresAt as number) - (p.issuedAt as number) <= 60000;
}
