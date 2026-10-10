import type { BusinessEpoch, BusinessQuery, BusinessResourceRef, BusinessScope, BusinessSession } from './context';
import type { BusinessNativeActionDecision, BusinessNativeActionRequest, BusinessNativeIdentityPort } from './native-ports';
import type { BusinessNativeWork, BusinessOpaqueSource, BusinessRevisionMapping } from './native-registry';

export type { BusinessNativeActionDecision, BusinessNativeActionRequest, BusinessNativeIdentityPort } from './native-ports';

export const BUSINESS_NATIVE_ACTION_CONTEXT_SCHEMA = 'agentlas.business.native-action-context.v1' as const;
export const BUSINESS_NATIVE_ACTION_ADMISSION_PROTOCOL = 'agentlas.business.serialized-native-action-admission.v1' as const;
export const BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL = 'agentlas.business.native-action-document-admission.v1' as const;
/** These are the existing One Page/source/History operations. Vault and provider phases
 * deliberately use their separate protocol and cannot enter this composition. */
export const BUSINESS_NATIVE_DATA_ACTIONS = [
  'source-read', 'inference', 'page-read', 'page-write', 'follow-up', 'source-control',
  'history-observe', 'history-draft', 'history-evaluate', 'history-accept',
  'history-run', 'history-read', 'history-restore',
] as const;
export type BusinessNativeDataAction = typeof BUSINESS_NATIVE_DATA_ACTIONS[number];

/** A native ref need not be a canonical resource id. Its owner supplies the exact
 * correspondence, consent, credential and tombstone revisions; no hashes are converted
 * to generations or used as Business permission revisions by the adapter. */
export interface BusinessNativeActionSourceBinding {
  readonly sourceRef: string;
  readonly resourceId: string;
  readonly permissionRevision: string;
  readonly credentialGeneration: string | null;
  readonly consentRevision: string;
  readonly tombstoneRevision: string;
}
export interface BusinessNativeActionIntent {
  readonly revision: string;
  readonly bodyDigest: string | null;
  readonly consentRevision: string;
  readonly permissionRevision: string;
  readonly credentialRevision: string | null;
  readonly payerRevision: string;
  readonly budgetRevision: string | null;
  readonly targetAclRevision: string;
  readonly audienceRevision: string;
}
export interface BusinessNativeActionDocument {
  readonly operationId: string;
  readonly artifactResourceId: string;
  readonly targetResourceId: string;
  readonly audienceResourceIds: readonly string[];
  readonly bodyDigest: string;
}
/** Produced ONLY by the existing trusted native command/intent owner. The request can
 * have null task/run before inference, but work must identify an ACTUAL existing task
 * or independently registered native reply. Missing work is unavailable, never minted.
 * query is a sealed canonical owner decision, including its canonical purpose/resources/
 * payer/budget/provider generation. A raw native phrase is not made into a purpose id.
 * current(context) must check the full registered vector including request/body/consent/
 * ACL/budget/credential/tombstone state, not a notification cache or an expiry alone. */
export interface BusinessNativeActionOwnerContext {
  readonly schema: typeof BUSINESS_NATIVE_ACTION_CONTEXT_SCHEMA;
  readonly contextId: string;
  readonly contextRevision: string;
  readonly requestDigest: string;
  readonly request: BusinessNativeActionRequest;
  readonly session: BusinessSession;
  readonly work: BusinessNativeWork;
  readonly sources: readonly BusinessOpaqueSource[];
  readonly sourceBindings: readonly BusinessNativeActionSourceBinding[];
  readonly intent: BusinessNativeActionIntent;
  readonly query: BusinessQuery;
  readonly document: BusinessNativeActionDocument | null;
  readonly issuedAuthorityRevision: string;
  readonly nativeDecisionRevision: string;
  readonly businessAuthorityRevision: number;
  readonly expiresAt: number;
}
export interface BusinessNativeActionContextPort {
  resolve(request: Readonly<BusinessNativeActionRequest>, session: Readonly<BusinessSession>): Promise<BusinessNativeActionOwnerContext | null>;
  current(context: Readonly<BusinessNativeActionOwnerContext>): boolean;
}
export interface BusinessNativeActionAdmissionInput {
  readonly session: BusinessSession;
  readonly query: BusinessQuery;
  readonly epoch: BusinessEpoch;
  readonly mapping: BusinessRevisionMapping;
  readonly context: BusinessNativeActionOwnerContext;
}
export type BusinessNativeActionInvalidation = 'revoked' | 'disconnected' | 'sequence-gap' | 'authority-changed';
export interface BusinessNativeActionAdmissionLease {
  readonly protocol: typeof BUSINESS_NATIVE_ACTION_ADMISSION_PROTOCOL;
  readonly proofDigest: string;
  readonly sequence: number;
  readonly expiresAt: number;
  /** Same authority-owned serialization/exclusion boundary as native effect admission.
   * Revoke cannot acknowledge ahead of invalidation; disconnect/gaps close permanently.
   * This is not a cached grant/TTL and cannot be implemented by a relay subscription. */
  current(): boolean;
  release(): void;
}
export interface BusinessNativeActionAdmissionPort {
  pin(input: Readonly<BusinessNativeActionAdmissionInput>, invalidate: (reason: BusinessNativeActionInvalidation) => void): Promise<BusinessNativeActionAdmissionLease | null>;
}
export interface BusinessNativeActionAdmissionProof {
  readonly protocol: typeof BUSINESS_NATIVE_ACTION_ADMISSION_PROTOCOL;
  readonly proofDigest: string;
  readonly sequence: number;
  readonly expiresAt: number;
}
/** Value-only structural mirror of the existing conditional organization writer input.
 * It has no document bytes, key value, SQL handle or executable allow callback. */
export interface BusinessNativeActionConditionalDocumentInput {
  readonly session: BusinessSession;
  readonly query: BusinessQuery;
  readonly epoch: BusinessEpoch;
  readonly operationId: string;
  readonly purpose: string;
  readonly artifact: BusinessResourceRef;
  readonly target: BusinessResourceRef;
  readonly audienceResourceIds: readonly string[];
  readonly revisionMapping: BusinessRevisionMapping;
}
export interface BusinessNativeActionDocumentReceipt {
  readonly operationId: string;
  readonly targetId: string;
  readonly previousRevision: number;
  readonly state: 'written' | 'conflict' | 'denied' | 'unknown';
  readonly revision: number | null;
  readonly digest: string | null;
  readonly readBackRevision: number | null;
  readonly readBackDigest: string | null;
}
export interface BusinessNativeActionDocumentAdmission {
  readonly protocol: typeof BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL;
  readonly document: BusinessNativeActionConditionalDocumentInput;
  readonly context: BusinessNativeActionOwnerContext;
  readonly admissionInput: BusinessNativeActionAdmissionInput;
  readonly admissionProof: BusinessNativeActionAdmissionProof;
}
/** The actual organization document authority MUST resolve its registered admission
 * from proofDigest/sequence and validate both issued epochs, native context/operation/body,
 * consent/tombstones/source/target/audience ACL and payer/budget/credential/control revisions
 * inside the SAME revocation/admission/CAS transaction before writing and durable exact
 * read-back. Caller proof metadata, an earlier async allow or local SQL is insufficient.
 * The basic conditional writer port alone does not implement this native protocol. */
export interface BusinessNativeActionDocumentPort {
  readonly protocol: typeof BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL;
  commit(input: Readonly<BusinessNativeActionDocumentAdmission>): Promise<BusinessNativeActionDocumentReceipt>;
}
export interface BusinessPreparedNativeAction extends BusinessNativeActionDecision {
  stillCurrent(): boolean;
  release(): void;
}

/** Toolchain asset effects are a separate family, never Vault or History aliases. */
export const BUSINESS_TOOLCHAIN_REQUEST_SCHEMA = 'agentlas.business.toolchain-native-request.v1' as const;
export const BUSINESS_TOOLCHAIN_CONTEXT_SCHEMA = 'agentlas.business.toolchain-native-context.v1' as const;
export const BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL = 'agentlas.business.serialized-toolchain-effect.v1' as const;
export const BUSINESS_TOOLCHAIN_PHASES = ['report', 'passive-notice', 'report-read', 'repair-draft'] as const;
export type BusinessToolchainPhase = typeof BUSINESS_TOOLCHAIN_PHASES[number];

/** Produced by authenticated One command custody. Body content is not transported here.
 * originalWorkRef identifies an existing accepted command, not a caller-created task.
 * The owner must look up the stored call; these values alone confer no authority. */
export interface BusinessToolchainNativeRequest {
  readonly schema: typeof BUSINESS_TOOLCHAIN_REQUEST_SCHEMA;
  readonly phase: BusinessToolchainPhase;
  readonly principalId: string;
  readonly sessionId: string;
  readonly hostId: string;
  readonly organizationId: string;
  readonly scope: BusinessScope;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly originalWorkRef: string;
  readonly callerChatId: string;
  /** Caller of the retained SOURCE call, distinct from a new maker read/repair caller. */
  readonly sourceCallCallerChatId: string;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly assetContentHash: string;
  readonly callerCallId: string;
  readonly callerInputHash: string;
  readonly callerParentRunId: string;
  readonly callerCallRunId: string;
  readonly reportId: string;
  readonly reportRevision: string | null;
  readonly recipientChatId: string | null;
  readonly bodyDigest: string;
  readonly purpose: string;
  readonly payerId: string;
}
export interface BusinessToolchainConversationBinding {
  readonly chatId: string;
  readonly principalId: string;
  readonly resourceId: string;
  readonly permissionRevision: string;
  readonly audienceRevision: string;
}
export interface BusinessToolchainSourceBinding {
  readonly sourceRef: string;
  readonly resourceId: string;
  readonly permissionRevision: string;
  readonly consentRevision: string;
  readonly tombstoneRevision: string;
  readonly audienceRevision: string;
  readonly audiencePrincipalIds: readonly string[];
}
/** Original owner-stored effect identity, independent of request digests/idempotency keys. */
export interface BusinessToolchainEffectIdentity {
  readonly authorityId: string;
  readonly domainId: string;
  readonly effectId: string;
  readonly revision: string;
}
export interface BusinessToolchainCallBinding {
  readonly id: string;
  readonly revision: string;
  readonly resourceId: string;
  readonly callerChatId: string;
  readonly parentRunId: string;
  readonly runId: string;
  readonly inputHash: string;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly assetContentHash: string;
}
/** Registered retained source custody, not a reusable historical execution grant.
 * The genuine owner must resolve this vector from the accepted source command and
 * stored call, and verify it for the CURRENT reader/repair actor under admission. */
export interface BusinessToolchainSourceCallProof {
  readonly registrationId: string;
  readonly authorityId: string;
  readonly domainId: string;
  readonly revision: string;
  readonly originalWorkRef: string;
  readonly commandRevision: string;
  readonly scope: BusinessScope;
  readonly identity: Omit<BusinessSession, 'expiresAt'>;
  readonly work: BusinessNativeWork;
  readonly caller: BusinessToolchainConversationBinding;
  readonly call: BusinessToolchainCallBinding;
  readonly custody: { readonly id: string; readonly revision: string };
  readonly admission: { readonly id: string; readonly revision: string; readonly issuedAuthorityRevision: string };
  readonly sources: readonly BusinessOpaqueSource[];
  readonly sourceBindings: readonly BusinessToolchainSourceBinding[];
}
export interface BusinessToolchainOwnerContext {
  readonly schema: typeof BUSINESS_TOOLCHAIN_CONTEXT_SCHEMA;
  readonly contextId: string;
  readonly contextRevision: string;
  readonly requestDigest: string;
  readonly request: BusinessToolchainNativeRequest;
  readonly session: BusinessSession;
  readonly ownerAuthorityId: string;
  readonly ownerDomainId: string;
  readonly original: { readonly workRef: string; readonly commandId: string; readonly commandRevision: string; readonly callerChatId: string };
  readonly work: BusinessNativeWork;
  readonly predecessor: BusinessToolchainSourceCallProof;
  readonly asset: { readonly id: string; readonly version: number; readonly contentHash: string; readonly resourceId: string; readonly revision: string };
  readonly call: BusinessToolchainCallBinding;
  readonly report: { readonly id: string; readonly revision: string | null; readonly resourceId: string };
  readonly caller: BusinessToolchainConversationBinding;
  readonly recipient: BusinessToolchainConversationBinding | null;
  readonly audience: readonly BusinessToolchainConversationBinding[];
  readonly sources: readonly BusinessOpaqueSource[];
  readonly sourceBindings: readonly BusinessToolchainSourceBinding[];
  readonly intent: { readonly revision: string; readonly bodyDigest: string; readonly payerId: string; readonly payerRevision: string;
    readonly budgetRevision: string | null; readonly permissionRevision: string; readonly consentRevision: string;
    readonly tombstoneRevision: string; readonly audienceRevision: string };
  readonly effect: BusinessToolchainEffectIdentity;
  readonly query: BusinessQuery;
  readonly issuedAuthorityRevision: string;
  readonly nativeDecisionRevision: string;
  readonly businessAuthorityRevision: number;
  readonly expiresAt: number;
}
export interface BusinessToolchainContextPort {
  /** Existing genuine One owner resolves immutable asset/call and original command records. */
  resolve(request: Readonly<BusinessToolchainNativeRequest>, session: BusinessSession): Promise<BusinessToolchainOwnerContext | null>;
  /** Live lookup over the entire original-work/asset/call/source/audience vector. */
  current(context: Readonly<BusinessToolchainOwnerContext>): boolean;
  /** Actual registered source call/custody lookup, including current actor audience,
   * source consent/tombstone and revocation. Prior execution permission is not reused. */
  currentSourceCall(predecessor: Readonly<BusinessToolchainSourceCallProof>, current: Readonly<BusinessToolchainOwnerContext>): boolean;
}
export interface BusinessToolchainAdmissionInput {
  readonly session: BusinessSession;
  readonly query: BusinessQuery;
  readonly epoch: BusinessEpoch;
  readonly mapping: BusinessRevisionMapping;
  readonly context: BusinessToolchainOwnerContext;
}
export interface BusinessToolchainAdmissionPort {
  /** Authority-owned exclusion across grant/session/command/control/asset/source/audience.
   * Revoke acknowledgement must wait for invalidation or exclusion of the owner effect.
   * A relay subscription, time limit or last allowed HTTP reply is insufficient. */
  pin(input: Readonly<BusinessToolchainAdmissionInput>, invalidate: (reason: BusinessNativeActionInvalidation) => void): Promise<BusinessNativeActionAdmissionLease | null>;
}
export interface BusinessToolchainRegisteredAdmission {
  readonly input: BusinessToolchainAdmissionInput;
  /** EXACT ORIGINAL registered object returned from pin; a value clone is rejected. */
  readonly lease: BusinessNativeActionAdmissionLease;
}
export interface BusinessToolchainEffectExclusion {
  readonly protocol: typeof BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL;
  readonly effect: BusinessToolchainEffectIdentity;
  readonly admissions: readonly BusinessToolchainRegisteredAdmission[];
  current(): boolean;
}
export interface BusinessToolchainEffectPort {
  readonly protocol: typeof BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL;
  /** Resolve every original lease by object identity in the actual owner registry, then
   * run reducer synchronously under the SAME authority/effect-domain IMMEDIATE/CAS.
   * Recheck the original command, native mapping, phase/body/asset/call/source/audience,
   * current grants, tombstones and repair budget there. Strict true means committed.
   * Report + passive notice may share one reducer/transaction, preserving owner dedupe
   * and retention. It creates no model turn, repair job, grant, DB, authority or queue.
   * Reducer throw/Promise must roll back. Unknown acknowledgement must never retry.
   * A protocol marker/value receipt alone does not prove this serialization contract. */
  withCurrentExclusion(input: Readonly<{ protocol: typeof BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL;
    effect: BusinessToolchainEffectIdentity; admissions: readonly BusinessToolchainRegisteredAdmission[] }>,
    reducer: (exclusion: Readonly<BusinessToolchainEffectExclusion>) => unknown): Promise<boolean>;
}
export interface BusinessToolchainEffectResult<T> {
  readonly state: 'committed' | 'denied' | 'unknown';
  readonly reason: string;
  readonly value: T | null;
}
