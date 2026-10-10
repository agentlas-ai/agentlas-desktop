import {createHash,verify} from 'node:crypto';
import {OneVaultError,oneVaultCanonical} from '../../shared/one-vault';
import {decodeOneVaultBase64,oneVaultPublicKey} from './one-vault-crypto';
import type {OneVaultNativeOwner} from './one-vault-native-trust';
/** Opaque handle belongs to the independently authenticated native enrollment producer.
 * The resolver MUST reject JSON/copies and bearer/device-id-only candidates. */
export interface OneMobileEnrollmentHandle {readonly __nativeMobileEnrollment?:never}
export interface OneMobileEnrollmentCandidate {
 hostId:string;principalId:string;workspaceId:string;organizationId:string|null;
 senderId:string;senderKeyId:string;publicKey:string;deviceId:string;channelId:string;channelEpoch:string;
 revision:string;expectedSenderDigest:string|null;expiresAt:number;
 /** Bound to current native Mobile user interaction, owner/source grant and exact channel. */
 stillCurrent():boolean;
 /** Native Mobile comparison of exact host/account/permissions/SAS, then P256 proof.
  * No ordinary relay acknowledgment/renderer boolean may implement this method. */
 confirm(challenge:Readonly<OneMobileEnrollmentChallenge>,sas:string):Promise<{interactionId:string;signature:string}|null>;
}
export interface OneMobileEnrollmentChallenge {
 schema:'agentlas.one-mobile-enrollment.v1';operationId:string;nonce:string;expiresAt:number;
 owner:OneVaultNativeOwner;hostKeyId:string;hostPublicKey:string;generation:number;
 senderId:string;senderKeyId:string;publicKey:string;organizationId:string|null;
 deviceId:string;channelId:string;channelEpoch:string;revision:string;expectedSenderDigest:string|null;
 permissions:readonly ['credential-submit'];storage:'os-vault';charge:'none';
}
export function oneMobileEnrollmentTranscript(challenge:OneMobileEnrollmentChallenge):Buffer {
 return Buffer.from(oneVaultCanonical(['agentlas.one-mobile-enrollment-proof.v1',challenge]),'utf8');
}
/** 96-bit human comparison code, derived only from the canonical public-key challenge. */
export function oneMobileEnrollmentSas(challenge:OneMobileEnrollmentChallenge):string {
 return createHash('sha256').update(oneMobileEnrollmentTranscript(challenge)).digest('hex').slice(0,24).match(/.{4}/g)!.join('-');
}
export function verifyOneMobileEnrollment(challenge:OneMobileEnrollmentChallenge,signature:string):boolean {
 try{return verify('sha256',oneMobileEnrollmentTranscript(challenge),{key:oneVaultPublicKey(challenge.publicKey),dsaEncoding:'ieee-p1363'},decodeOneVaultBase64(signature,64));}catch{return false;}
}
export function validateOneMobileEnrollmentCandidate(c:OneMobileEnrollmentCandidate):void {
 for(const v of [c.hostId,c.principalId,c.workspaceId,c.senderId,c.senderKeyId,c.channelId,c.channelEpoch,c.revision])if(typeof v!=='string'||!v||v.length>256||/[\u0000-\u001f]/.test(v))throw new OneVaultError('authority_denied');
 if(!/^device_[a-f0-9]{32}$/.test(c.deviceId)||c.organizationId!==null&&(typeof c.organizationId!=='string'||!c.organizationId||c.organizationId.length>256)||c.expectedSenderDigest!==null&&!/^[a-f0-9]{64}$/.test(c.expectedSenderDigest)||!Number.isSafeInteger(c.expiresAt))throw new OneVaultError('authority_denied');
 oneVaultPublicKey(c.publicKey);
}
