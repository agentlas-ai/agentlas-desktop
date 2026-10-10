import type {OneVaultBinding} from './one-vault';
import type {OneProviderBootstrap,OneProviderPrepared} from './one-provider-native';
import type {OneProviderReceipt} from './one-provider';
/** Current native read authority, distinct from the immutable dispatch-time action.
 * This value is authenticated only inside the host-signed fresh remote response. */
export interface OneProviderResourceReadGrant {
 schema:'agentlas.one-provider-resource-read.v1';oneId:string;commandId:string;operationId:string;
 actionDigest:string;receiptDigest:string;currentBinding:OneVaultBinding;
 revision:string;purpose:'status'|'audio-acquisition';issuedAt:number;expiresAt:number;
}
export interface OneProviderReadSnapshot {
 prepared:OneProviderPrepared;receipt:OneProviderReceipt;resourceGrant:OneProviderResourceReadGrant;
}

export interface OneProviderReadProjection {projection:OneProviderBootstrap;resourceGrant:OneProviderResourceReadGrant|null}
