import { businessNamespace, businessOnlyKeys, isBusinessId, isBusinessRevision, type BusinessScope, type BusinessSession } from '../../shared/business/context';

export interface BusinessConnectionMetadata {
  resourceId: string;
  providerId: string;
  credentialRef: string | null;
  generation: number;
  revision: number;
  state: 'unconfigured' | 'stored-unverified' | 'verified' | 'disabled' | 'expired' | 'unknown';
  observedAt: number;
}
interface CacheEntry {
  namespace: string;
  deploymentId: string;
  identityAuthorityId: string;
  principalId: string;
  hostId: string;
  sessionId: string;
  sessionRevision: number;
  authEpoch: number;
  scope: BusinessScope;
  expiresAt: number;
  value: BusinessConnectionMetadata;
}
/** Display-only, bounded and in-memory. It cannot authorize a provider or survive logout. */
export class BusinessOrgMetadataCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly now: () => number = Date.now, private readonly maxEntries = 256) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) throw new Error('invalid_request');
  }

  put(session: BusinessSession, scope: BusinessScope, value: BusinessConnectionMetadata, ttlMs = 60_000): void {
    const namespace = businessNamespace(session, scope);
    if (!businessOnlyKeys(value, ['resourceId', 'providerId', 'credentialRef', 'generation', 'revision', 'state', 'observedAt'])
      || ![value.resourceId, value.providerId].every(isBusinessId)
      || (value.credentialRef !== null && !isBusinessId(value.credentialRef))
      || !isBusinessRevision(value.generation) || !isBusinessRevision(value.revision) || !isBusinessRevision(value.observedAt)
      || !['unconfigured', 'stored-unverified', 'verified', 'disabled', 'expired', 'unknown'].includes(value.state)
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000 || Date.parse(session.expiresAt) <= this.now()) throw new Error('invalid_request');
    this.prune();
    const key = JSON.stringify([namespace, value.resourceId]);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { namespace, deploymentId: session.deploymentId, identityAuthorityId: session.identityAuthorityId, principalId: session.principalId, hostId: session.hostId,
      sessionId: session.sessionId, sessionRevision: session.sessionRevision, authEpoch: session.authEpoch,
      scope: { ...scope }, expiresAt: Math.min(this.now() + ttlMs, Date.parse(session.expiresAt)), value: Object.freeze({ ...value }) });
  }

  get(session: BusinessSession, scope: BusinessScope, resourceId: string): BusinessConnectionMetadata | null {
    const namespace = businessNamespace(session, scope);
    this.prune();
    const entry = this.entries.get(JSON.stringify([namespace, resourceId]));
    if (!entry || Date.parse(session.expiresAt) <= this.now()) return null;
    if (entry.sessionId !== session.sessionId || entry.sessionRevision !== session.sessionRevision || entry.authEpoch !== session.authEpoch) {
      this.entries.delete(JSON.stringify([namespace, resourceId])); return null;
    }
    return { ...entry.value };
  }

  clearOrganization(binding: { deploymentId: string; identityAuthorityId?: string; principalId: string; hostId: string; organizationId: string }): void {
    for (const [key, value] of this.entries) if (value.deploymentId === binding.deploymentId && value.principalId === binding.principalId
      && value.hostId === binding.hostId && (binding.identityAuthorityId === undefined || value.identityAuthorityId === binding.identityAuthorityId)
      && value.scope.kind === 'organization' && value.scope.organizationId === binding.organizationId) this.entries.delete(key);
  }
  clearPrincipal(binding: { deploymentId: string; principalId: string; hostId: string }): void {
    for (const [key, value] of this.entries) if (value.deploymentId === binding.deploymentId && value.principalId === binding.principalId
      && value.hostId === binding.hostId) this.entries.delete(key);
  }
  private prune(): void {
    for (const [key, value] of this.entries) if (value.expiresAt <= this.now()) this.entries.delete(key);
  }
}
