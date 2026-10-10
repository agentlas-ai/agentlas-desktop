import type { BusinessAction, BusinessCharge, BusinessEpoch, BusinessQuery, BusinessSession } from './context';
import type { BusinessNativeWork, BusinessOpaqueSource, BusinessRevisionMapping } from './native-registry';

export const BUSINESS_NATIVE_ADMISSION_PROTOCOL = 'agentlas.business.serialized-native-admission.v1' as const;
export const BUSINESS_VAULT_PHASES = ['decrypt', 'store', 'commit', 'reconcile', 'provider-read', 'provider-dispatch', 'provider-publish'] as const;
export type BusinessVaultPhase = typeof BUSINESS_VAULT_PHASES[number];
/** Structurally matches OneVaultBinding without importing uncommitted One runtime modules. */
export interface BusinessNativeVaultBinding {
  requestId: string; requestRevision: number; commandId: string; intentDigest: string;
  principalId: string; sessionId: string; scope: 'personal' | 'organization'; organizationId: string | null;
  workspaceId: string; resourceId: string; purpose: string; payerId: string;
  taskId: string; runId: string; controlVersion: string | null; authorityRevision: string;
  provider: string; providerWorkspace: string; region: string; endpoint: string; operations: string[];
  permissionRevision: string; storage: 'os-vault'; expectedGeneration: number;
  cost: { currency: string; maxMinor: number; consentRevision: string } | null;
  hostId: string; senderId: string; trustGeneration: number;
}
/** Same metadata shape accepted by the existing synchronous OneActionAuthorityPort. */
export interface BusinessNativeActionRequest {
  principalId: string; sessionId: string; oneId: string; hostId: string;
  scope: 'personal' | 'project' | 'organization'; organizationId: string | null;
  workspaceId: string; projectId: string | null; resourceId: string; purpose: string; payerId: string;
  action: string; taskId: string | null; runId: string | null; controlVersion: string | null;
  permissionRevision: string; credentialGeneration: string | null;
  sourceRefs: string[]; audience: 'owner' | 'organization';
}
export interface BusinessNativeActionDecision { decision: 'allow' | 'deny' | 'unknown'; revision: string; reason: string }
export interface BusinessNativeVaultGrant {
  decision: 'allow' | 'deny' | 'unknown'; revision: string; reason: string;
  stillCurrent(): boolean;
}
/** Native identity mirror is only an identity/current-generation check, never a role allow.
 * The existing authenticated Main owns this port. Renderer JSON cannot implement it. */
export interface BusinessNativeIdentityPort { current(): BusinessSession | null }
export interface BusinessNativeGrantContext {
  bindingDigest: string; phase: BusinessVaultPhase; work: BusinessNativeWork;
  sources: BusinessOpaqueSource[]; actionRequest: BusinessNativeActionRequest;
  /** Issued opaque string, native synchronous decision string, and numeric Business revision
   * are separate registries. None is inferred by stringifying another or minting a hash. */
  issuedAuthorityRevision: string; nativeDecisionRevision: string; businessAuthorityRevision: number;
  action: BusinessAction; providerBindingId: string | null; operationId: string | null;
  region: string | null; credentialRef: string | null; credentialGeneration: number | null;
  charge: BusinessCharge | null; expiresAt: number;
}
export interface BusinessNativeIntentPort {
  resolve(binding: Readonly<BusinessNativeVaultBinding>, phase: BusinessVaultPhase, session: BusinessSession): Promise<BusinessNativeGrantContext | null>;
  /** Exact current native command/intent/reply registry, not cached Business permissions. */
  current(context: Readonly<BusinessNativeGrantContext>): boolean;
}
export interface BusinessNativeAdmissionInput {
  session: BusinessSession; query: BusinessQuery; epoch: BusinessEpoch;
  mapping: BusinessRevisionMapping; context: BusinessNativeGrantContext;
}
export interface BusinessNativeAdmissionLease {
  protocol: typeof BUSINESS_NATIVE_ADMISSION_PROTOCOL;
  proofDigest: string; sequence: number; expiresAt: number;
  /** An authority-owned synchronous native admission/exclusion check. A websocket notification
   * cache or TTL alone is insufficient. Revocation cannot commit ahead of this boundary;
   * already-started OS/provider effects retain their uncertain/reconciliation semantics. */
  current(): boolean;
  release(): void;
}
export type BusinessNativeInvalidation = 'revoked' | 'disconnected' | 'sequence-gap' | 'authority-changed';
export interface BusinessNativeAdmissionPort {
  /** Atomically validate the issued epoch AND establish the revocation/native-admission
   * serialization before returning a lease. Deliver invalidation before acknowledging
   * revoke; disconnect/gaps close irreversibly. No production fallback is implemented here. */
  pin(input: Readonly<BusinessNativeAdmissionInput>, invalidate: (reason: BusinessNativeInvalidation) => void): Promise<BusinessNativeAdmissionLease | null>;
}
