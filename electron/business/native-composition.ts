import { createHash } from 'node:crypto';
import { businessOnlyKeys, isBusinessId, isBusinessRevision, sameBusinessSession, snapshotBusinessQuery,
  type BusinessAuthority, type BusinessSession, type BusinessQuery } from '../../shared/business/context';
import { createBusinessRevisionResolver, businessRevisionMappingCurrent, isBusinessNativeArray, isBusinessNativeWork, isBusinessOpaqueSource,
  type BusinessRevisionRegistryPort } from '../../shared/business/native-registry';
import { BUSINESS_NATIVE_ADMISSION_PROTOCOL, BUSINESS_VAULT_PHASES, type BusinessVaultPhase,
  type BusinessNativeVaultBinding, type BusinessNativeActionRequest, type BusinessNativeActionDecision,
  type BusinessNativeVaultGrant, type BusinessNativeIdentityPort, type BusinessNativeIntentPort,
  type BusinessNativeGrantContext, type BusinessNativeAdmissionInput, type BusinessNativeAdmissionPort,
  type BusinessNativeAdmissionLease } from '../../shared/business/native-ports';
import { DesktopBusinessSession } from './session';
import { DesktopBusinessPolicyAdapter } from './policy-adapter';

/** Deterministic metadata-only fingerprint. Never call this with a key, token or text payload. */
export function businessNativeMetadataDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (isBusinessRevision(v)) return String(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
    throw new Error('invalid_native_metadata');
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(copy); return copy;
}
function validBinding(value: unknown): value is BusinessNativeVaultBinding {
  const keys = ['requestId', 'requestRevision', 'commandId', 'intentDigest', 'principalId', 'sessionId', 'scope', 'organizationId',
    'workspaceId', 'resourceId', 'purpose', 'payerId', 'taskId', 'runId', 'controlVersion', 'authorityRevision', 'provider',
    'providerWorkspace', 'region', 'endpoint', 'operations', 'permissionRevision', 'storage', 'expectedGeneration', 'cost', 'hostId', 'senderId', 'trustGeneration'];
  if (!businessOnlyKeys(value, keys) || Object.keys(value).length !== keys.length) return false;
  const v = value as unknown as BusinessNativeVaultBinding;
  if (![v.requestId, v.commandId, v.principalId, v.sessionId, v.workspaceId, v.resourceId, v.purpose, v.payerId, v.taskId, v.runId,
    v.authorityRevision, v.provider, v.providerWorkspace, v.region, v.permissionRevision, v.hostId, v.senderId].every(isBusinessId)
    || ![v.requestRevision, v.expectedGeneration, v.trustGeneration].every(isBusinessRevision) || v.storage !== 'os-vault'
    || typeof v.intentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.intentDigest) || (v.controlVersion !== null && !isBusinessId(v.controlVersion))
    || !['personal', 'organization'].includes(v.scope) || (v.scope === 'personal' ? v.organizationId !== null : !isBusinessId(v.organizationId))
    || !isBusinessNativeArray(v.operations) || !v.operations.length || !v.operations.every(isBusinessId)
    || new Set(v.operations).size !== v.operations.length) return false;
  if (typeof v.endpoint !== 'string') return false;
  try { const u = new URL(v.endpoint); if (v.endpoint.length > 512 || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return false; } catch { return false; }
  return v.cost === null || (businessOnlyKeys(v.cost, ['currency', 'maxMinor', 'consentRevision'])
    && Object.keys(v.cost).length === 3 && typeof v.cost.currency === 'string' && /^[A-Z]{3}$/.test(v.cost.currency)
    && isBusinessRevision(v.cost.maxMinor) && isBusinessId(v.cost.consentRevision));
}
function validActionRequest(v: unknown): v is BusinessNativeActionRequest {
  const keys = ['principalId', 'sessionId', 'oneId', 'hostId', 'scope', 'organizationId', 'workspaceId', 'projectId', 'resourceId',
    'purpose', 'payerId', 'action', 'taskId', 'runId', 'controlVersion', 'permissionRevision', 'credentialGeneration', 'sourceRefs', 'audience'];
  if (!businessOnlyKeys(v, keys) || Object.keys(v).length !== keys.length) return false;
  const q = v as unknown as BusinessNativeActionRequest;
  return [q.principalId, q.sessionId, q.oneId, q.hostId, q.workspaceId, q.resourceId, q.purpose, q.payerId, q.action, q.permissionRevision].every(isBusinessId)
    && [q.organizationId, q.projectId, q.taskId, q.runId, q.controlVersion, q.credentialGeneration].every(x => x === null || isBusinessId(x))
    && ['personal', 'organization', 'project'].includes(q.scope) && ['owner', 'organization'].includes(q.audience)
    && isBusinessNativeArray(q.sourceRefs) && q.sourceRefs.length === 3 && q.sourceRefs.every(isBusinessId);
}
function validContext(c: BusinessNativeGrantContext, b: BusinessNativeVaultBinding, phase: BusinessVaultPhase, session: BusinessSession, now: number): boolean {
  const keys = ['bindingDigest', 'phase', 'work', 'sources', 'actionRequest', 'issuedAuthorityRevision', 'nativeDecisionRevision',
    'businessAuthorityRevision', 'action', 'providerBindingId', 'operationId', 'region', 'credentialRef', 'credentialGeneration', 'charge', 'expiresAt'];
  if (!businessOnlyKeys(c, keys) || Object.keys(c).length !== keys.length || c.bindingDigest !== businessNativeMetadataDigest(b)
    || c.phase !== phase || c.issuedAuthorityRevision !== b.authorityRevision || !isBusinessId(c.nativeDecisionRevision)
    || !isBusinessRevision(c.businessAuthorityRevision) || !isBusinessRevision(c.expiresAt) || c.expiresAt <= now
    || c.expiresAt > Date.parse(session.expiresAt) || !validActionRequest(c.actionRequest)
    || !isBusinessNativeArray(c.sources) || !c.sources.length || !c.sources.every(isBusinessOpaqueSource)) return false;
  if (!isBusinessNativeWork(c.work) || c.work.commandId !== b.commandId || c.work.taskId !== b.taskId || c.work.runId !== b.runId || c.work.controlVersion !== b.controlVersion
    || (b.controlVersion === null ? c.work.kind !== 'reply' || !isBusinessId(c.work.replyAuthorityRevision) : c.work.kind !== 'task' || c.work.replyAuthorityRevision !== null)) return false;
  const q = c.actionRequest;
  if (q.principalId !== b.principalId || q.sessionId !== b.sessionId || q.hostId !== b.hostId || q.scope !== b.scope
    || q.organizationId !== b.organizationId || q.workspaceId !== b.workspaceId || q.projectId !== null || q.resourceId !== b.resourceId
    || q.purpose !== b.purpose || q.payerId !== b.payerId || q.taskId !== b.taskId || q.runId !== b.runId || q.controlVersion !== b.controlVersion
    || q.permissionRevision !== b.permissionRevision || q.credentialGeneration !== String(b.expectedGeneration)
    || q.action !== (phase.startsWith('provider-') ? phase : 'vault-' + phase) || q.sourceRefs[0] !== b.commandId
    || !/^[a-f0-9]{64}$/.test(q.sourceRefs[1]) || q.sourceRefs[2] !== b.intentDigest
    || q.audience !== (b.scope === 'organization' ? 'organization' : 'owner')) return false;
  const allowed = phase.startsWith('provider-') ? ['credential.verify', 'audio.generate']
    : phase === 'reconcile' ? ['resource.read', 'credential.store', 'credential.replace', 'credential.revoke']
      : ['credential.store', 'credential.replace', 'credential.revoke'];
  if (!allowed.includes(c.action) || (c.providerBindingId === null) !== (c.operationId === null)
    || (c.credentialRef === null) !== (c.credentialGeneration === null)
    || [c.providerBindingId, c.operationId, c.region, c.credentialRef].some(v => v !== null && !isBusinessId(v))
    || (c.credentialGeneration !== null && (!isBusinessRevision(c.credentialGeneration) || c.credentialGeneration !== b.expectedGeneration))) return false;
  if (phase.startsWith('provider-') && (!c.providerBindingId || !c.operationId || c.region !== b.region || !c.credentialRef)) return false;
  if (c.region !== null && c.region !== b.region) return false;
  if (b.cost === null ? c.charge !== null : !c.charge || c.charge.payerId !== b.payerId || c.charge.currency !== b.cost.currency || c.charge.maxMinor !== b.cost.maxMinor) return false;
  return c.sources.some(s => s.resourceId === b.resourceId);
}
interface PreparedGrant { requestDigest: string; nativeRevision: string; revision: string; current(): boolean; close(): void }
/** Capture the original native lease receiver without invoking accessor methods. */
interface LeaseMethod { original: unknown; call(): unknown }
function leaseMethod(lease: BusinessNativeAdmissionLease, name: 'current' | 'release'): LeaseMethod | null {
  try {
    for (let owner: object | null = lease, depth = 0; owner && depth < 8; owner = Object.getPrototypeOf(owner), depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        ? { original: descriptor.value, call: descriptor.value.bind(lease) } : null;
    }
  } catch { /* Unknown owner methods cannot provide an admission or cleanup acknowledgment. */ }
  return null;
}
export interface BusinessNativeCompositionPorts {
  sessions: DesktopBusinessSession;
  identity: BusinessNativeIdentityPort | null;
  authority: BusinessAuthority | null;
  registry: BusinessRevisionRegistryPort | null;
  intents: BusinessNativeIntentPort | null;
  admission: BusinessNativeAdmissionPort | null;
}
/** Composition only: no native transport/role cache, key access, SQL writes or Supervisor. */
export function createBusinessNativeComposition(input: BusinessNativeCompositionPorts, now: () => number = Date.now) {
  const ports = Object.freeze({ ...input });
  const policy = new DesktopBusinessPolicyAdapter(ports.sessions, ports.authority, null, now);
  const resolve = createBusinessRevisionResolver(ports.registry, now);
  const prepared = new Map<string, PreparedGrant>();
  const attempts = new Map<string, symbol>();
  const pending = new Map<string, { attempt: symbol; close(): void }>();
  let generation = 0;
  let cleanupUnknown = false;
  const refused = (decision: 'deny' | 'unknown', reason: string): BusinessNativeVaultGrant => ({ decision, revision: '', reason, stillCurrent: () => false });
  const missing = (): string | null => cleanupUnknown ? 'business_native_cleanup_unconfirmed' : !ports.identity ? 'business_native_identity_unbound' : !ports.authority ? 'business_authenticated_authority_transport_unbound'
    : !ports.registry ? 'business_native_revision_registry_unbound' : !ports.intents ? 'business_native_intent_registry_unbound'
      : !ports.admission ? 'business_serialized_native_admission_unbound' : null;
  async function prepareVaultAuthority(binding: Readonly<BusinessNativeVaultBinding>, phase: BusinessVaultPhase): Promise<BusinessNativeVaultGrant> {
    let lease: BusinessNativeAdmissionLease | null = null; let closed = false; let released = false;
    let releaseLease: LeaseMethod | null = null; let leaseCurrent: LeaseMethod | null = null; let leaseExpiresAt = 0;
    let key: string | null = null; let attempt: symbol | null = null; let published = false;
    const startedGeneration = generation;
    const close = (): void => {
      closed = true;
      // Invalidation may arrive before pin resolves. Release its eventual lease once.
      if (lease && !released) {
        released = true;
        try {
          const result = releaseLease?.call();
          if (!releaseLease || result !== undefined) { cleanupUnknown = true; if (result instanceof Promise) void result.catch(() => {}); }
        }
        catch { cleanupUnknown = true; }
      }
    };
    const superseded = (): boolean => closed || generation !== startedGeneration || (key !== null && attempts.get(key) !== attempt);
    try {
      const absent = missing(); if (absent) return refused('unknown', absent);
      if (!BUSINESS_VAULT_PHASES.includes(phase) || !validBinding(binding)) return refused('deny', 'invalid_native_vault_binding');
      const b = immutable(binding); key = businessNativeMetadataDigest([b, phase]);
      // Every requested phase reauthorizes. Prepared entries are only issued native fences.
      pending.get(key)?.close();
      prepared.get(key)?.close(); prepared.delete(key);
      attempt = Symbol('native-admission-attempt'); attempts.set(key, attempt); pending.set(key, { attempt, close });
      const session = await ports.sessions.current();
      if (superseded()) return refused('deny', 'native_admission_superseded');
      const identity = ports.identity!.current();
      if (!session || !identity || b.principalId !== session.principalId || b.sessionId !== session.sessionId || b.hostId !== session.hostId
        || (b.scope === 'organization' && b.organizationId !== session.organizationId)
        || !sameBusinessSession(identity, session)) return refused('deny', 'native_session_changed');
      const read = await ports.intents!.resolve(b, phase, session);
      if (superseded()) return refused('deny', 'native_admission_superseded');
      if (!read || !validContext(read, b, phase, session, now())) return refused('deny', 'native_intent_binding_changed');
      const context = immutable(read);
      const mapping = await resolve({ session, work: context.work, sources: context.sources });
      if (superseded()) return refused('deny', 'native_admission_superseded');
      if (!mapping) return refused('unknown', 'native_revision_mapping_unavailable');
      const target = mapping.resources.find(r => r.canonical.resourceId === b.resourceId)?.canonical;
      if (!target || (b.scope === 'personal' ? target.scope.kind !== 'personal' || target.scope.principalId !== session.principalId
        : target.scope.kind !== 'organization' || target.scope.organizationId !== b.organizationId)) return refused('deny', 'native_resource_scope_changed');
      const query = snapshotBusinessQuery({ schema: 'agentlas.business.authority.v1', deploymentId: session.deploymentId,
        organizationId: session.organizationId, hostId: session.hostId, action: context.action, purpose: b.purpose,
        taskId: context.work.taskId, runId: context.work.runId, occurrenceId: context.work.occurrenceId,
        controlVersion: mapping.canonicalControlRevision, resources: mapping.resources.map(r => r.canonical),
        ...(context.providerBindingId !== null ? { providerBindingId: context.providerBindingId!, operationId: context.operationId! } : {}),
        ...(context.region !== null ? { region: context.region } : {}),
        ...(context.credentialRef !== null ? { credentialRef: context.credentialRef!, credentialGeneration: context.credentialGeneration! } : {}),
        ...(context.charge !== null ? { charge: context.charge } : {}),
      } as BusinessQuery);
      if (!query) return refused('deny', 'native_query_binding_invalid');
      const decision = await policy.currentDecision(query);
      if (superseded()) return refused('deny', 'native_admission_superseded');
      if (decision.verdict !== 'allow' || !decision.epoch) return refused(decision.verdict === 'unknown' ? 'unknown' : 'deny', decision.reason);
      if (decision.epoch.authorityRevision !== context.businessAuthorityRevision) return refused('deny', 'issued_authority_revision_changed');
      const watch = immutable({ session, query, epoch: decision.epoch, mapping, context } satisfies BusinessNativeAdmissionInput);
      lease = await ports.admission!.pin(watch, close);
      if (lease) { releaseLease = leaseMethod(lease, 'release'); leaseCurrent = leaseMethod(lease, 'current'); }
      if (!lease || !releaseLease || !leaseCurrent || lease.protocol !== BUSINESS_NATIVE_ADMISSION_PROTOCOL || lease.proofDigest !== businessNativeMetadataDigest(watch)
        || !isBusinessRevision(lease.sequence) || !isBusinessRevision(lease.expiresAt) || lease.expiresAt <= now()
        || lease.expiresAt > Math.min(context.expiresAt, Date.parse(session.expiresAt), Date.parse(decision.epoch.expiresAt), Date.parse(mapping.expiresAt))) {
        close(); return refused('unknown', 'serialized_native_admission_unavailable');
      }
      leaseExpiresAt = lease.expiresAt;
      if (superseded()) { close(); return refused('deny', 'native_authority_invalidated'); }
      const current = (): boolean => {
        if (superseded()) { close(); return false; }
        try {
          const identity = ports.identity!.current();
          if (now() >= leaseExpiresAt || !identity || !sameBusinessSession(identity, session)
            || cleanupUnknown || !businessRevisionMappingCurrent(ports.registry, mapping, now()) || ports.intents!.current(context) !== true
            || leaseMethod(lease!, 'current')?.original !== leaseCurrent!.original || leaseCurrent!.call() !== true) { close(); return false; }
          return true;
        } catch { close(); return false; }
      };
      if (await policy.stillCurrent(decision.epoch) !== true || await ports.registry!.stillCurrent(mapping) !== true || !current()) {
        close(); return refused('deny', 'native_authority_changed');
      }
      const entry: PreparedGrant = { requestDigest: businessNativeMetadataDigest(context.actionRequest),
        nativeRevision: context.nativeDecisionRevision, revision: context.issuedAuthorityRevision, current, close };
      for (const [id, value] of prepared) if (!value.current()) { value.close(); prepared.delete(id); attempts.delete(id); }
      while (prepared.size >= 128) { const id = prepared.keys().next().value!; prepared.get(id)?.close(); prepared.delete(id); attempts.delete(id); }
      prepared.set(key, entry);
      published = true;
      return Object.freeze({ decision: 'allow', revision: entry.revision, reason: 'allowed', stillCurrent: current });
    } catch { close(); return refused('unknown', 'business_native_authority_unavailable'); }
    finally {
      if (key !== null && pending.get(key)?.attempt === attempt) pending.delete(key);
      if (!published) { close(); if (key !== null && attempts.get(key) === attempt) attempts.delete(key); }
    }
  }
  const actionAuthority = Object.freeze({ current(request: Readonly<BusinessNativeActionRequest>): BusinessNativeActionDecision {
    if (!validActionRequest(request)) return { decision: 'deny', revision: '', reason: 'invalid_native_action' };
    const digest = businessNativeMetadataDigest(request);
    const matches = [...prepared.values()].filter(v => v.requestDigest === digest && v.current());
    if (matches.length !== 1) return { decision: 'unknown', revision: '', reason: 'exact_native_admission_not_prepared' };
    return { decision: 'allow', revision: matches[0].nativeRevision, reason: 'allowed' };
  } });
  return Object.freeze({
    prepareVaultAuthority,
    // One calls synchronous action authority BEFORE currentGrant; its owner must await prepare
    // before EACH phase's native sync check, not just once at window open. This method
    // always performs a fresh async grant check.
    currentVaultGrant: prepareVaultAuthority,
    actionAuthority,
    invalidate(): void {
      generation++; for (const value of pending.values()) value.close(); for (const value of prepared.values()) value.close();
      pending.clear(); attempts.clear(); prepared.clear(); policy.invalidate();
      if (cleanupUnknown) throw new Error('business_native_cleanup_unconfirmed');
    },
    blocker: missing,
  });
}
