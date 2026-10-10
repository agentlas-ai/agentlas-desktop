/** Scoped mirror of the Business authority wire DTO; no secret values or executable grants. */
import { looksSecret } from '../secret-patterns';

export const BUSINESS_AUTHORITY_SCHEMA = 'agentlas.business.authority.v1' as const;
export const BUSINESS_ACTIONS = [
  'organization.read', 'member.read', 'member.manage', 'grant.read', 'grant.manage',
  'provider.read', 'provider.manage', 'provider.call', 'catalog.read', 'catalog.manage',
  'audit.read', 'overview.read', 'resource.read', 'page.write', 'space.write',
  'credential.store', 'credential.verify', 'credential.replace', 'credential.revoke',
  'audio.generate', 'work.execute', 'work.stop', 'history.observe', 'history.read',
  'history.manage', 'history.pause', 'history.delete', 'evolution.read', 'evolution.generate',
  'evolution.build', 'evolution.evaluate', 'evolution.review', 'evolution.promote',
  'evolution.execute', 'evolution.feedback', 'evolution.pause', 'evolution.stop',
  'evolution.revoke', 'evolution.restore',
  'toolchain.report', 'toolchain.passive-notice', 'toolchain.report-read', 'toolchain.repair-draft',
] as const;
export type BusinessAction = typeof BUSINESS_ACTIONS[number];
export type BusinessScope =
  | { readonly kind: 'organization'; readonly organizationId: string }
  | { readonly kind: 'personal'; readonly principalId: string };
export interface BusinessSession {
  readonly principalId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly authEpoch: number;
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly identityAuthorityId: string;
  readonly hostId: string;
  readonly expiresAt: string;
}
export interface BusinessResourceRef {
  readonly resourceId: string;
  readonly revision: number;
  readonly aclRevision: number;
  readonly scope: BusinessScope;
}
export interface BusinessCharge {
  readonly payerId: string;
  readonly currency: string;
  readonly maxMinor: number;
  readonly budgetRevision: number;
}
export interface BusinessQuery {
  readonly schema: typeof BUSINESS_AUTHORITY_SCHEMA;
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly hostId: string;
  readonly action: BusinessAction;
  readonly purpose: string;
  readonly projectId?: string;
  readonly taskId: string;
  readonly runId: string;
  readonly controlVersion: number;
  readonly occurrenceId: string;
  readonly resources: readonly BusinessResourceRef[];
  readonly providerBindingId?: string;
  readonly operationId?: string;
  readonly region?: string;
  readonly credentialRef?: string;
  readonly credentialGeneration?: number;
  readonly charge?: BusinessCharge;
}
export type BusinessReason =
  | 'allowed' | 'repository_unavailable' | 'invalid_request' | 'authority_unavailable'
  | 'session_revoked' | 'session_expired' | 'session_mismatch' | 'organization_disabled'
  | 'organization_mismatch' | 'membership_inactive' | 'host_untrusted' | 'purpose_denied'
  | 'grant_missing' | 'grant_revoked' | 'resource_denied' | 'resource_stale'
  | 'resource_deleted' | 'provider_disabled' | 'operation_denied' | 'region_denied'
  | 'credential_unavailable' | 'credential_stale' | 'payer_denied' | 'budget_exceeded'
  | 'budget_stale' | 'authority_stale' | 'audit_unavailable' | 'conflict'
  | 'approval_required' | 'not_found' | 'sso_unavailable' | 'sso_invalid'
  | 'sso_replayed' | 'identity_conflict' | 'invite_invalid' | 'effect_unknown';
export interface BusinessEpoch {
  readonly schema: typeof BUSINESS_AUTHORITY_SCHEMA;
  readonly fenceId: string;
  readonly queryDigest: string;
  readonly authorityRevision: number;
  readonly principalId: string;
  readonly sessionId: string;
  readonly identityAuthorityId: string;
  readonly sessionRevision: number;
  readonly authEpoch: number;
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly hostId: string;
  readonly expiresAt: string;
}
export interface BusinessDecision {
  readonly schema: typeof BUSINESS_AUTHORITY_SCHEMA;
  readonly verdict: 'allow' | 'deny' | 'unknown';
  readonly reason: BusinessReason;
  readonly epoch: BusinessEpoch | null;
  readonly expiresAt: string | null;
}
/** Implemented by the authoritative service; never a cached role reader. */
export interface BusinessAuthority {
  currentDecision(query: BusinessQuery, trustedSession: BusinessSession): Promise<BusinessDecision>;
  stillCurrent(epoch: BusinessEpoch): Promise<boolean>;
}
export interface DesktopBusinessAuthority {
  currentDecision(query: BusinessQuery): Promise<BusinessDecision>;
  stillCurrent(epoch: BusinessEpoch): Promise<boolean>;
}
export interface BusinessTaskAnchor {
  taskId: string; runId: string; controlVersion: number; commandId: string; occurrenceId: string;
}
export interface BusinessExactStop extends BusinessTaskAnchor { hostId: string }
export interface BusinessStopReceipt {
  taskId: string; runId: string; controlVersion: number;
  state: 'accepted' | 'settled' | 'unknown' | 'failed';
  externalEffects: 'settled' | 'pending' | 'uncertain';
}
export function isBusinessId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) && !looksSecret(value);
}
export function isBusinessRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function businessOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
      && Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
export function isBusinessScope(value: unknown): value is BusinessScope {
  if (!businessOnlyKeys(value, ['kind', 'organizationId', 'principalId'])) return false;
  return (value.kind === 'personal' && businessOnlyKeys(value, ['kind', 'principalId']) && isBusinessId(value.principalId))
    || (value.kind === 'organization' && businessOnlyKeys(value, ['kind', 'organizationId']) && isBusinessId(value.organizationId));
}
export function isBusinessResource(value: unknown): value is BusinessResourceRef {
  return businessOnlyKeys(value, ['resourceId', 'revision', 'aclRevision', 'scope'])
    && isBusinessId(value.resourceId) && isBusinessRevision(value.revision) && isBusinessRevision(value.aclRevision) && isBusinessScope(value.scope);
}
function validExpiry(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
export function isBusinessSession(value: unknown): value is BusinessSession {
  if (!businessOnlyKeys(value, ['principalId', 'sessionId', 'sessionRevision', 'authEpoch', 'deploymentId', 'organizationId', 'identityAuthorityId', 'hostId', 'expiresAt'])) return false;
  return [value.principalId, value.sessionId, value.deploymentId, value.organizationId, value.identityAuthorityId, value.hostId].every(isBusinessId)
    && isBusinessRevision(value.sessionRevision) && isBusinessRevision(value.authEpoch) && validExpiry(value.expiresAt);
}
export function isBusinessQuery(value: unknown): value is BusinessQuery {
  if (!businessOnlyKeys(value, ['schema', 'deploymentId', 'organizationId', 'hostId', 'action', 'purpose', 'projectId', 'taskId', 'runId', 'controlVersion', 'occurrenceId', 'resources', 'providerBindingId', 'operationId', 'region', 'credentialRef', 'credentialGeneration', 'charge'])) return false;
  if (value.schema !== BUSINESS_AUTHORITY_SCHEMA || !BUSINESS_ACTIONS.includes(value.action as BusinessAction)
    || ![value.deploymentId, value.organizationId, value.hostId, value.taskId, value.runId, value.occurrenceId, value.purpose].every(isBusinessId)
    || !isBusinessRevision(value.controlVersion)) return false;
  if ([value.projectId, value.providerBindingId, value.operationId, value.region, value.credentialRef].some(v => v !== undefined && !isBusinessId(v))) return false;
  if ((value.providerBindingId === undefined) !== (value.operationId === undefined)
    || (value.credentialRef === undefined) !== (value.credentialGeneration === undefined)
    || (value.credentialGeneration !== undefined && !isBusinessRevision(value.credentialGeneration))) return false;
  if (!Array.isArray(value.resources) || !value.resources.length || value.resources.length > 64) return false;
  const ids = new Set<string>();
  for (const resource of value.resources) {
    if (!isBusinessResource(resource) || ids.has(resource.resourceId)) return false;
    if (resource.scope.kind === 'organization' && resource.scope.organizationId !== value.organizationId) return false;
    ids.add(resource.resourceId);
  }
  if (value.charge !== undefined) {
    if (!businessOnlyKeys(value.charge, ['payerId', 'currency', 'maxMinor', 'budgetRevision']) || !isBusinessId(value.charge.payerId)
      || typeof value.charge.currency !== 'string' || !/^[A-Z]{3}$/.test(value.charge.currency)
      || !isBusinessRevision(value.charge.maxMinor) || !isBusinessRevision(value.charge.budgetRevision)) return false;
  }
  return true;
}
export function isBusinessEpoch(value: unknown): value is BusinessEpoch {
  if (!businessOnlyKeys(value, ['schema', 'fenceId', 'queryDigest', 'authorityRevision', 'principalId', 'sessionId', 'identityAuthorityId', 'sessionRevision', 'authEpoch', 'deploymentId', 'organizationId', 'hostId', 'expiresAt'])) return false;
  return value.schema === BUSINESS_AUTHORITY_SCHEMA && isBusinessId(value.fenceId)
    && typeof value.queryDigest === 'string' && /^[a-f0-9]{64}$/.test(value.queryDigest)
    && [value.principalId, value.sessionId, value.identityAuthorityId, value.deploymentId, value.organizationId, value.hostId].every(isBusinessId)
    && [value.authorityRevision, value.sessionRevision, value.authEpoch].every(isBusinessRevision) && validExpiry(value.expiresAt);
}
/** Freeze before the first await; untrusted callers cannot change a queued decision's target. */
export function snapshotBusinessQuery(query: BusinessQuery): BusinessQuery | null {
  if (!isBusinessQuery(query)) return null;
  const resources = Object.freeze(query.resources.map(ref => Object.freeze({ resourceId: ref.resourceId, revision: ref.revision,
    aclRevision: ref.aclRevision, scope: Object.freeze({ ...ref.scope }) })));
  const copy: BusinessQuery = { ...query, resources, ...(query.charge ? { charge: Object.freeze({ ...query.charge }) } : {}) };
  return Object.freeze(copy);
}
export function sameBusinessScope(a: BusinessScope, b: BusinessScope): boolean {
  return a.kind === b.kind && (a.kind === 'organization' ? a.organizationId === (b as { organizationId: string }).organizationId : a.principalId === (b as { principalId: string }).principalId);
}
export function sameBusinessResource(a: BusinessResourceRef, b: BusinessResourceRef): boolean {
  return a.resourceId === b.resourceId && a.revision === b.revision && a.aclRevision === b.aclRevision && sameBusinessScope(a.scope, b.scope);
}
export function sameBusinessSession(a: BusinessSession, b: BusinessSession): boolean {
  return a.principalId === b.principalId && a.sessionId === b.sessionId && a.sessionRevision === b.sessionRevision && a.authEpoch === b.authEpoch
    && a.deploymentId === b.deploymentId && a.organizationId === b.organizationId && a.identityAuthorityId === b.identityAuthorityId && a.hostId === b.hostId && a.expiresAt === b.expiresAt;
}
/** Desktop cache isolation additionally binds principal and exact host, unlike a server namespace. */
export function businessNamespace(session: BusinessSession, scope: BusinessScope): string {
  if (!isBusinessSession(session) || !isBusinessScope(scope)) throw new Error('invalid_request');
  if ((scope.kind === 'organization' && scope.organizationId !== session.organizationId)
    || (scope.kind === 'personal' && scope.principalId !== session.principalId)) throw new Error('organization_mismatch');
  return ['business', session.deploymentId, session.identityAuthorityId, scope.kind, scope.kind === 'organization' ? scope.organizationId : scope.principalId,
    'desktop', session.principalId, session.hostId].map(encodeURIComponent).join('/');
}
