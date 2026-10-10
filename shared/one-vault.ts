/** Value-free protocol only. The existing Supervisor remains request authority. */
export const ONE_VAULT_SCHEMA = 'agentlas.one-vault.v1' as const;
export const ONE_VAULT_SUITE = 'P256-HKDF-SHA256-A256GCM-ES256-P1363' as const;
export type OneVaultErrorCode = 'secure_route_unavailable' | 'invalid_request' | 'invalid_envelope' | 'sender_untrusted' | 'host_mismatch' | 'request_expired' | 'authority_denied' | 'authority_unavailable' | 'revision_changed' | 'replay_conflict' | 'generation_conflict' | 'store_failed' | 'store_unknown' | 'request_consumed' | 'not_found';
export class OneVaultError extends Error { constructor(readonly code: OneVaultErrorCode) { super(code); this.name = 'OneVaultError'; } }
export interface OneVaultBinding {
  requestId: string; requestRevision: number; commandId: string; intentDigest: string;
  principalId: string; sessionId: string; scope: 'personal' | 'organization'; organizationId: string | null;
  workspaceId: string; resourceId: string; purpose: string; payerId: string;
  taskId: string; runId: string; controlVersion: string | null; authorityRevision: string;
  provider: string; providerWorkspace: string; region: string; endpoint: string; operations: string[];
  permissionRevision: string; storage: 'os-vault'; expectedGeneration: number;
  cost: { currency: string; maxMinor: number; consentRevision: string } | null;
  hostId: string; senderId: string; trustGeneration: number;
}
export interface OneVaultRequest {
  schema: typeof ONE_VAULT_SCHEMA; suite: typeof ONE_VAULT_SUITE;
  binding: OneVaultBinding; nonce: string; issuedAt: number; expiresAt: number;
  hostKeyId: string; recipientKeyId: string;
  /** Uncompressed SEC1 P-256 point (65 bytes), base64url without padding. */
  recipientPublicKey: string;
  /** 64-byte P1363 ECDSA signature, base64url. Host key must already be pinned. */
  signature: string;
}
export interface OneVaultEnvelope {
  schema: typeof ONE_VAULT_SCHEMA; suite: typeof ONE_VAULT_SUITE;
  requestDigest: string; operationId: string; action: 'store' | 'delete'; senderKeyId: string;
  ephemeralPublicKey: string; iv: string; ciphertext: string; tag: string; signature: string;
}
export interface OneVaultReceipt {
  schema: typeof ONE_VAULT_SCHEMA; hostId: string; hostKeyId: string; requestDigest: string;
  operationId: string; envelopeDigest: string; requestId: string; requestRevision: number;
  state: 'saved' | 'deleted' | 'store_unknown' | 'failed';
  credentialRef: string | null; generation: number; providerState: 'unverified';
  errorCode: OneVaultErrorCode | null; observedAt: number; responseNonce: string | null; signature: string;
}
export interface OneVaultStatusQuery {
  schema: typeof ONE_VAULT_SCHEMA; requestDigest: string; operationId: string;
  senderKeyId: string; nonce: string; expiresAt: number; signature: string;
}
export interface OneVaultWindowBootstrap {
  state:'register-required'|'entry-ready'|'blocked';request:OneVaultRequest|null;recovery:OneVaultRecoveryDescriptor|null;
  pinnedHost:{hostId:string;hostKeyId:string;publicKey:string;trustGeneration:number}|null;
  sender:{senderId:string;keyId:string;challengeNonce:string;challengeExpiresAt:number;requestId:string;requestRevision:number}|null;
  accountLabel:string;bindingKey:string;sensitiveSurfaceReady:boolean;errorCode:OneVaultErrorCode|null;
}
export interface OneVaultWindowBridge {
  bootstrap():Promise<OneVaultWindowBootstrap>;
  registerSender(input:{publicKey:string;challengeNonce:string;proof:string}):Promise<OneVaultWindowBootstrap>;
  submit(requestId:string,envelope:OneVaultEnvelope):Promise<OneVaultReceipt>;
  reconcile(requestId:string,query:OneVaultStatusQuery):Promise<OneVaultReceipt>;
  cancel(requestId:string|null,reason:'cancelled'|'expired'|'background'):Promise<void>;
  onChanged(listener:()=>void):()=>void;
}
/** General conversation UI can launch an original request; no key input exists on this port. */
export interface OneVaultNativeAPI {
  openRunKeyRequest(input:{runId:string;toolId:string;keyName:string}):Promise<{state:'opened'|'blocked';errorCode:OneVaultErrorCode|null}>;
  runKeyStatus(input:{runId:string}):Promise<{state:'pending'|'saved'|'store_unknown'|'unavailable';errorCode:OneVaultErrorCode|null}>;
  recoverableOperations():Promise<Array<{operationId:string;commandId:string;state:'reserved'|'store_unknown';provider:string;scope:'personal'|'organization'}>>;
  openStoredOperation(input:{operationId:string}):Promise<{state:'opened'|'blocked';errorCode:OneVaultErrorCode|null}>;
  reviewHostTrust(input:{mode:'initialize-or-rotate'|'reconcile'|'reauthorize'}):Promise<{state:'active'|'unknown'}>;
}
/** Sorted-key JSON over this ASCII-key schema. Numbers are nonnegative safe integers.
 * No optional fields: null is explicit. Transport must reject unknown fields. */
export function oneVaultCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (Array.isArray(value)) return '[' + value.map(oneVaultCanonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + oneVaultCanonical((value as Record<string, unknown>)[k])).join(',') + '}';
  throw new OneVaultError('invalid_request');
}
export function oneVaultUnsigned<T extends { signature: string }>(value: T): Omit<T, 'signature'> {
  const { signature: _signature, ...unsigned } = value; return unsigned;
}
/** Request.signature signs UTF8(canonical(["request", unsignedRequest])).
 * Envelope.signature signs UTF8(canonical(["envelope", unsignedEnvelope])).
 * Receipt/status use "receipt"/"status" identically. Digest = SHA256(canonical(full object)).
 * AES AAD = canonical(["aad",requestDigest,operationId,action,senderKeyId,ephemeralPublicKey,iv]).
 * HKDF salt = decoded request.nonce (32 bytes); info = UTF8(AAD); IKM = P256 ECDH raw X (32 bytes).
 * Cipher plaintext = UTF8(canonical({action,value})); delete uses value:null. AES tag = 16 bytes.
 */

/** Native-approved status-only sender rebind. The original request/envelope stay immutable. */
export interface OneVaultRecoveryDescriptor {
 schema:'agentlas.one-vault-recovery.v1';hostId:string;hostKeyId:string;requestDigest:string;
 operationId:string;envelopeDigest:string;action:'store'|'delete';expectedGeneration:number;
 senderKeyId:string;currentAuthorityDigest:string;issuedAt:number;expiresAt:number;signature:string;
}
/** Authenticated value-free form cancellation; never a credential deletion or provider revocation. */
export interface OneVaultCancelQuery {
 schema:'agentlas.one-vault-cancel.v1';requestDigest:string;senderKeyId:string;
 nonce:string;expiresAt:number;reason:'cancelled'|'expired'|'background';signature:string;
}
export interface OneVaultCancelReceipt {
 schema:'agentlas.one-vault-cancel-receipt.v1';hostId:string;hostKeyId:string;requestDigest:string;
 requestId:string;requestRevision:number;operationId:string|null;envelopeDigest:string|null;
 state:'cancelled'|'effect_pending'|'effect_completed';generation:number;responseNonce:string;observedAt:number;signature:string;
}
