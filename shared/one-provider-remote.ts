import type {OneProviderResourceReadGrant} from './one-provider-read';
import type {OneVaultBinding} from './one-vault';
import type {OneProviderBootstrap} from './one-provider-native';
import type {OneProviderAudio} from './one-provider';
export const ONE_PROVIDER_REMOTE_QUERY='agentlas.one-provider-remote-query.v1' as const;
export const ONE_PROVIDER_REMOTE_PROJECTION='agentlas.one-provider-remote-projection.v1' as const;
export const ONE_PROVIDER_REMOTE_AUDIO='agentlas.one-provider-remote-audio-acquisition.v1' as const;
/** Both sides already know this native-admitted scope. No caller field grants authority. */
export interface OneProviderRemoteQuery {
 schema:typeof ONE_PROVIDER_REMOTE_QUERY;kind:'projection'|'status'|'audio-acquisition';
 hostId:string;hostKeyId:string;trustGeneration:number;senderId:string;senderKeyId:string;
 channelId:string;channelEpoch:string;oneId:string;binding:OneVaultBinding;projectionRevision:string;
 operationId:string|null;receiptDigest:string|null;artifactDigest:string|null;
 nonce:string;issuedAt:number;expiresAt:number;signature:string;
}
/** Existing native bootstrap/prepared/effect receipt stay intact and are signed together here.
 * The fresh wrapper does not rewrite the immutable effect's observedAt or its signature. */
export interface OneProviderRemoteProjection {
 schema:typeof ONE_PROVIDER_REMOTE_PROJECTION;hostId:string;hostKeyId:string;trustGeneration:number;
 senderId:string;senderKeyId:string;channelId:string;channelEpoch:string;oneId:string;
 binding:OneVaultBinding;projectionRevision:string;queryDigest:string;responseNonce:string;
 allowedOperations:Array<'projection'|'status'|'audio-acquisition'>;
 resourceGrant:OneProviderResourceReadGrant|null;projection:OneProviderBootstrap;projectionDigest:string;preparedDigest:string|null;receiptDigest:string|null;
 observedAt:number;expiresAt:number;signature:string;
}
/** Authorizes an exact artifact, never claims transfer or playback. No file path, URL or bytes.
 * A separately approved native transfer must consume this receipt once, recheck current ACL,
 * and encrypt the exact bytes for this independently approved recipient. */
export interface OneProviderRemoteAudioAcquisition {
 schema:typeof ONE_PROVIDER_REMOTE_AUDIO;state:'artifact-verified-for-acquisition';
 hostId:string;hostKeyId:string;trustGeneration:number;senderId:string;senderKeyId:string;
 channelId:string;channelEpoch:string;oneId:string;binding:OneVaultBinding;projectionRevision:string;
 resourceGrant:OneProviderResourceReadGrant;acquisitionId:string;queryDigest:string;responseNonce:string;operationId:string;actionDigest:string;
 preparedDigest:string;receiptDigest:string;artifact:OneProviderAudio;
 allowedOperation:'audio-acquisition';maxUses:1;observedAt:number;expiresAt:number;signature:string;
}
export type OneProviderRemoteErrorCode='remote_route_unavailable'|'remote_sender_untrusted'|'remote_query_invalid'|'remote_replay'|'remote_scope_changed'|'remote_artifact_invalid';
export class OneProviderRemoteError extends Error {constructor(readonly code:OneProviderRemoteErrorCode){super(code);this.name='OneProviderRemoteError';}}
/** UTF8(oneVaultCanonical(['status', oneVaultUnsigned(query)])); host wrappers use 'receipt'.
 * Existing P-256 ES256/P1363 public points and unpadded base64url; nonce is 32 random bytes.
 * Consumers must verify the pinned host key + exact queryDigest/nonce/scope/time before display.
 * Relay authentication is transport only and is never key material or sender approval. */
