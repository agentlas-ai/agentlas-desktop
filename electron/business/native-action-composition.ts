import { createHash } from 'node:crypto';
import { looksSecret } from '../../shared/secret-patterns';
import { BUSINESS_AUTHORITY_SCHEMA, businessOnlyKeys, isBusinessEpoch, isBusinessId, isBusinessQuery, isBusinessScope,
  isBusinessRevision, isBusinessSession, sameBusinessResource, sameBusinessScope, sameBusinessSession, snapshotBusinessQuery,
  type BusinessAction, type BusinessAuthority, type BusinessDecision, type BusinessEpoch,
  type BusinessQuery, type BusinessSession } from '../../shared/business/context';
import { BUSINESS_NATIVE_ACTION_ADMISSION_PROTOCOL, BUSINESS_NATIVE_ACTION_CONTEXT_SCHEMA, BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL, BUSINESS_NATIVE_DATA_ACTIONS,
  type BusinessNativeActionAdmissionInput, type BusinessNativeActionAdmissionLease, type BusinessNativeActionAdmissionPort,
  type BusinessNativeActionAdmissionProof, type BusinessNativeActionDocumentPort,
  type BusinessNativeActionContextPort, type BusinessNativeActionDecision, type BusinessNativeActionOwnerContext,
  type BusinessNativeActionRequest, type BusinessNativeDataAction, type BusinessNativeIdentityPort,
  type BusinessPreparedNativeAction, BUSINESS_TOOLCHAIN_CONTEXT_SCHEMA, BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL,
  BUSINESS_TOOLCHAIN_PHASES, BUSINESS_TOOLCHAIN_REQUEST_SCHEMA, type BusinessToolchainNativeRequest,
  type BusinessToolchainOwnerContext, type BusinessToolchainContextPort, type BusinessToolchainAdmissionPort,
  type BusinessToolchainAdmissionInput, type BusinessToolchainEffectPort, type BusinessToolchainEffectExclusion,
  type BusinessToolchainEffectResult, type BusinessToolchainRegisteredAdmission,
  type BusinessToolchainConversationBinding } from '../../shared/business/native-action-ports';
import { businessRevisionMappingCurrent, businessRevisionMappingMatchesRequest, createBusinessRevisionResolver, sameBusinessNativeWork, sameBusinessOpaqueSource,
  isBusinessNativeArray, isBusinessNativeWork, isBusinessOpaqueSource,
  type BusinessRevisionMapping, type BusinessRevisionRegistryPort } from '../../shared/business/native-registry';
import { createBusinessConditionalDocumentWriter, type BusinessConditionalDocumentInput, type BusinessConditionalDocumentPort,
  type BusinessConditionalDocumentReceipt, type BusinessConditionalDocumentRequest } from './native-document-adapter';
import { DesktopBusinessPolicyAdapter, desktopBusinessQueryDigest } from './policy-adapter';
import { DesktopBusinessSession } from './session';

/** Digest binds already validated value-only metadata; it never issues an authority revision. */
export function businessNativeActionMetadataDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function hex(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function nativeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) && !looksSecret(value);
}
function nativePurpose(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value) && !looksSecret(value);
}
function immutable<T>(value: T): T {
  const copied = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  };
  freeze(copied); return copied;
}
function ownedValue(value: object, key: string): unknown { return Object.getOwnPropertyDescriptor(value, key)?.value; }
function callback(value: object, key: string): ((...args: unknown[]) => unknown) | null {
  let owner: object | null = value;
  for (let i = 0; owner && i < 4; i++, owner = Object.getPrototypeOf(owner) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return typeof descriptor.value === 'function' ? descriptor.value.bind(value) : null;
  }
  return null;
}
export function isBusinessNativeDataActionRequest(value: unknown): value is BusinessNativeActionRequest {
  try {
    const keys = ['principalId', 'sessionId', 'oneId', 'hostId', 'scope', 'organizationId', 'workspaceId', 'projectId', 'resourceId',
      'purpose', 'payerId', 'action', 'taskId', 'runId', 'controlVersion', 'permissionRevision', 'credentialGeneration', 'sourceRefs', 'audience'];
    if (!businessOnlyKeys(value, keys) || Object.keys(value).length !== keys.length) return false;
    const q = value as unknown as BusinessNativeActionRequest;
    if (![q.principalId, q.sessionId, q.oneId, q.hostId, q.workspaceId, q.resourceId, q.payerId, q.permissionRevision].every(nativeId)
      || !nativePurpose(q.purpose) || !BUSINESS_NATIVE_DATA_ACTIONS.includes(q.action as BusinessNativeDataAction)
      || ![q.organizationId, q.projectId, q.taskId, q.runId, q.controlVersion, q.credentialGeneration].every(v => v === null || nativeId(v))
      || !['personal', 'project', 'organization'].includes(q.scope) || !['owner', 'organization'].includes(q.audience)
      || !isBusinessNativeArray(q.sourceRefs) || !q.sourceRefs.every(nativeId)
      || new Set(q.sourceRefs).size !== q.sourceRefs.length
      || (q.taskId === null) !== (q.runId === null) || (q.controlVersion !== null && q.taskId === null)) return false;
    if (q.scope === 'personal' && (q.organizationId !== null || q.projectId !== null || q.audience !== 'owner')) return false;
    return !(q.scope === 'project' && q.projectId === null) && !(q.scope === 'organization' && q.organizationId === null)
      && !(q.audience === 'organization' && q.organizationId === null);
  } catch { return false; }
}
const actions: Readonly<Record<BusinessNativeDataAction, BusinessAction>> = Object.freeze({
  'source-read': 'resource.read', inference: 'work.execute', 'page-read': 'resource.read', 'page-write': 'page.write',
  'follow-up': 'work.execute', 'source-control': 'history.manage', 'history-observe': 'history.observe',
  'history-draft': 'evolution.generate', 'history-evaluate': 'evolution.evaluate', 'history-accept': 'evolution.promote',
  'history-run': 'evolution.execute', 'history-read': 'evolution.read', 'history-restore': 'evolution.restore',
});
function validContext(value: unknown, request: BusinessNativeActionRequest, session: BusinessSession, now: number): value is BusinessNativeActionOwnerContext {
  try {
    const keys = ['schema', 'contextId', 'contextRevision', 'requestDigest', 'request', 'session', 'work', 'sources', 'sourceBindings',
      'intent', 'query', 'document', 'issuedAuthorityRevision', 'nativeDecisionRevision', 'businessAuthorityRevision', 'expiresAt'];
    if (!businessOnlyKeys(value, keys) || Object.keys(value).length !== keys.length) return false;
    const c = value as unknown as BusinessNativeActionOwnerContext;
    if (c.schema !== BUSINESS_NATIVE_ACTION_CONTEXT_SCHEMA || ![c.contextId, c.contextRevision, c.issuedAuthorityRevision, c.nativeDecisionRevision].every(isBusinessId)
      || !hex(c.requestDigest) || c.requestDigest !== businessNativeActionMetadataDigest(request)
      || !isBusinessNativeDataActionRequest(c.request) || businessNativeActionMetadataDigest(c.request) !== c.requestDigest
      || !isBusinessSession(c.session) || !sameBusinessSession(c.session, session) || !isBusinessNativeWork(c.work)
      || !isBusinessRevision(c.businessAuthorityRevision) || !isBusinessRevision(c.expiresAt) || c.expiresAt <= now
      || c.expiresAt > Date.parse(session.expiresAt) || !isBusinessNativeArray(c.sources) || !c.sources.length || !c.sources.every(isBusinessOpaqueSource)
      || new Set(c.sources.map(s => s.resourceId)).size !== c.sources.length
      || !isBusinessNativeArray(c.sourceBindings) || c.sourceBindings.length !== request.sourceRefs.length) return false;
    if (request.taskId !== null && (request.taskId !== c.work.taskId || request.runId !== c.work.runId || request.controlVersion !== c.work.controlVersion)) return false;
    for (let i = 0; i < c.sourceBindings.length; i++) {
      const b = c.sourceBindings[i];
      if (!businessOnlyKeys(b, ['sourceRef', 'resourceId', 'permissionRevision', 'credentialGeneration', 'consentRevision', 'tombstoneRevision'])
        || ![b.sourceRef, b.permissionRevision, b.consentRevision, b.tombstoneRevision].every(nativeId) || !isBusinessId(b.resourceId)
        || (b.credentialGeneration !== null && !nativeId(b.credentialGeneration)) || b.sourceRef !== request.sourceRefs[i]
        || !c.sources.some(s => s.resourceId === b.resourceId)) return false;
    }
    const intent = c.intent;
    if (!businessOnlyKeys(intent, ['revision', 'bodyDigest', 'consentRevision', 'permissionRevision', 'credentialRevision', 'payerRevision', 'budgetRevision', 'targetAclRevision', 'audienceRevision'])
      || ![intent.revision, intent.consentRevision, intent.permissionRevision, intent.payerRevision, intent.targetAclRevision, intent.audienceRevision].every(nativeId)
      || (intent.bodyDigest !== null && !hex(intent.bodyDigest)) || (intent.budgetRevision !== null && !nativeId(intent.budgetRevision))
      || intent.permissionRevision !== request.permissionRevision || intent.credentialRevision !== request.credentialGeneration
      || (request.credentialGeneration === null ? c.sourceBindings.some(b => b.credentialGeneration !== null)
        : !c.sourceBindings.length || c.sourceBindings.some(b => b.credentialGeneration === null))) return false;
    const query = c.query;
    if (!businessOnlyKeys(query, ['schema', 'deploymentId', 'organizationId', 'hostId', 'action', 'purpose', 'projectId', 'taskId', 'runId', 'controlVersion', 'occurrenceId', 'resources',
      'providerBindingId', 'operationId', 'region', 'credentialRef', 'credentialGeneration', 'charge'])
      || !isBusinessNativeArray(query.resources) || !isBusinessQuery(query) || query.action !== actions[request.action as BusinessNativeDataAction]
      || query.deploymentId !== session.deploymentId || query.organizationId !== session.organizationId || query.hostId !== session.hostId
      || query.taskId !== c.work.taskId || query.runId !== c.work.runId || query.occurrenceId !== c.work.occurrenceId
      || (query.projectId ?? null) !== request.projectId || query.resources.length !== c.sources.length
      || !query.resources.every(ref => c.sources.some(s => s.resourceId === ref.resourceId))
      || !query.resources.some(ref => ref.resourceId === request.resourceId)
      || (query.charge !== undefined && (query.charge.payerId !== request.payerId || intent.budgetRevision === null))
      || (query.credentialRef !== undefined && intent.credentialRevision === null)) return false;
    if (['inference', 'follow-up', 'history-draft', 'history-run'].includes(request.action) && (!query.charge || intent.budgetRevision === null || intent.bodyDigest === null)) return false;
    const target = query.resources.find(ref => ref.resourceId === request.resourceId)!;
    if (request.organizationId === null ? target.scope.kind !== 'personal' || target.scope.principalId !== session.principalId
      : request.organizationId !== session.organizationId || target.scope.kind !== 'organization' || target.scope.organizationId !== request.organizationId) return false;
    if (c.document === null) return request.action !== 'page-write';
    const document = c.document;
    return request.action === 'page-write' && businessOnlyKeys(document, ['operationId', 'artifactResourceId', 'targetResourceId', 'audienceResourceIds', 'bodyDigest'])
      && [document.operationId, document.artifactResourceId, document.targetResourceId].every(isBusinessId)
      && document.targetResourceId === request.resourceId && hex(document.bodyDigest) && document.bodyDigest === intent.bodyDigest
      && isBusinessNativeArray(document.audienceResourceIds) && document.audienceResourceIds.every(isBusinessId)
      && new Set(document.audienceResourceIds).size === document.audienceResourceIds.length
      && [document.artifactResourceId, ...document.audienceResourceIds].every(id => query.resources.some(ref => ref.resourceId === id))
      && (request.audience !== 'organization' || document.audienceResourceIds.length > 0);
  } catch { return false; }
}
interface PreparedAction {
  readonly requestDigest: string;
  readonly nativeRevision: string;
  readonly session: BusinessSession;
  readonly context: BusinessNativeActionOwnerContext;
  readonly mapping: BusinessRevisionMapping;
  readonly admissionInput: BusinessNativeActionAdmissionInput;
  readonly admissionProof: BusinessNativeActionAdmissionProof;
  current(): boolean;
  close(): void;
}
export interface BusinessNativeActionCompositionPorts {
  readonly sessions: DesktopBusinessSession;
  readonly identity: BusinessNativeIdentityPort | null;
  readonly authority: BusinessAuthority | null;
  readonly registry: BusinessRevisionRegistryPort | null;
  readonly contexts: BusinessNativeActionContextPort | null;
  readonly admission: BusinessNativeActionAdmissionPort | null;
  readonly documents: BusinessNativeActionDocumentPort | null;
}
/** Composition only. No collectors, local SQL, key access, invented work, grant cache or queue. */
export function createBusinessNativeActionComposition(input: BusinessNativeActionCompositionPorts, now: () => number = Date.now) {
  const ports = Object.freeze({ ...input });
  const policy = new DesktopBusinessPolicyAdapter(ports.sessions, ports.authority, null, now);
  const resolve = createBusinessRevisionResolver(ports.registry, now);
  const prepared = new Map<string, PreparedAction>();
  const attempts = new Map<string, symbol>();
  const pending = new Map<string, { attempt: symbol; close(): void }>();
  const documentInFlight = new Set<string>();
  let generation = 0;
  const refused = (decision: 'deny' | 'unknown', reason: string): BusinessPreparedNativeAction => Object.freeze({
    decision, revision: '', reason, stillCurrent: () => false, release: () => {},
  });
  const blocker = (): string | null => !ports.identity ? 'business_native_identity_unbound' : !ports.authority ? 'business_authenticated_authority_transport_unbound'
    : !ports.registry ? 'business_native_revision_registry_unbound' : !ports.contexts ? 'business_native_action_context_unbound'
      : !ports.admission ? 'business_serialized_native_action_admission_unbound' : null;
  const documentReady = (): boolean => {
    try { return !!ports.documents && ownedValue(ports.documents, 'protocol') === BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL && !!callback(ports.documents, 'commit'); }
    catch { return false; }
  };
  const documentBlocker = (): string | null => blocker() ?? (!documentReady() ? 'business_organization_document_atomic_port_unbound' : null);
  async function prepareCurrentAction(raw: Readonly<BusinessNativeActionRequest>): Promise<BusinessPreparedNativeAction> {
    let lease: BusinessNativeActionAdmissionLease | null = null; let releaseOwned: (() => unknown) | null = null; let closed = false; let released = false;
    let key: string | null = null; let attempt: symbol | null = null; let published = false;
    const startedGeneration = generation;
    const close = (): void => {
      closed = true;
      // Invalidation can precede an async pin response. Release the eventual lease once.
      if (releaseOwned && !released) { released = true; try { releaseOwned(); } catch { /* Closure remains terminal. */ } }
    };
    const superseded = (): boolean => closed || generation !== startedGeneration || (key !== null && attempts.get(key) !== attempt);
    try {
      if (!isBusinessNativeDataActionRequest(raw)) return refused('deny', 'invalid_native_data_action');
      const request = immutable(raw);
      const absent = blocker(); if (absent) return refused('unknown', absent);
      if (request.organizationId !== null && request.action === 'page-write' && !documentReady()) return refused('unknown', 'business_organization_document_atomic_port_unbound');
      key = businessNativeActionMetadataDigest(request);
      pending.get(key)?.close(); prepared.get(key)?.close(); prepared.delete(key);
      if (!pending.has(key) && pending.size >= 128) return refused('unknown', 'native_action_admission_capacity');
      attempt = Symbol('native-action-admission'); attempts.set(key, attempt); pending.set(key, { attempt, close });
      const session = await ports.sessions.current();
      if (superseded()) return refused('deny', 'native_action_admission_superseded');
      const identity = ports.identity!.current();
      if (!session || !identity || !isBusinessSession(identity) || !sameBusinessSession(identity, session)
        || request.principalId !== session.principalId || request.sessionId !== session.sessionId || request.hostId !== session.hostId
        || (request.organizationId !== null && request.organizationId !== session.organizationId)) return refused('deny', 'native_session_changed');
      const read = await ports.contexts!.resolve(request, session);
      if (superseded()) return refused('deny', 'native_action_admission_superseded');
      if (!validContext(read, request, session, now())) return refused('deny', 'native_action_context_changed');
      const context = immutable(read);
      if (ports.contexts!.current(context) !== true) return refused('deny', 'native_action_context_changed');
      const mapping = await resolve({ session, work: context.work, sources: context.sources });
      if (superseded()) return refused('deny', 'native_action_admission_superseded');
      if (!mapping) return refused('unknown', 'native_revision_mapping_unavailable');
      const query = snapshotBusinessQuery(context.query);
      if (!query || query.controlVersion !== mapping.canonicalControlRevision || query.resources.length !== mapping.resources.length
        || !query.resources.every(ref => mapping.resources.some(pair => sameBusinessResource(ref, pair.canonical)))) return refused('deny', 'native_canonical_query_changed');
      const decision = await policy.currentDecision(query);
      if (superseded()) return refused('deny', 'native_action_admission_superseded');
      if (decision.verdict !== 'allow' || !decision.epoch) return refused(decision.verdict === 'unknown' ? 'unknown' : 'deny', decision.reason);
      if (decision.epoch.authorityRevision !== context.businessAuthorityRevision) return refused('deny', 'issued_business_authority_changed');
      const watch = immutable({ session, query, epoch: decision.epoch, mapping, context } satisfies BusinessNativeActionAdmissionInput);
      const issued = await ports.admission!.pin(watch, close);
      // Capture release independently: even a malformed current/protocol must release a
      // native reservation, including invalidation before the async response arrives.
      if (issued && typeof issued === 'object') {
        releaseOwned = callback(issued, 'release');
        const currentOwned = callback(issued, 'current');
        if (releaseOwned && currentOwned) lease = Object.freeze({
          protocol: ownedValue(issued, 'protocol') as BusinessNativeActionAdmissionLease['protocol'],
          proofDigest: ownedValue(issued, 'proofDigest') as string, sequence: ownedValue(issued, 'sequence') as number,
          expiresAt: ownedValue(issued, 'expiresAt') as number,
          current: () => currentOwned() === true, release: () => { releaseOwned!(); },
        });
      }
      if (!lease || lease.protocol !== BUSINESS_NATIVE_ACTION_ADMISSION_PROTOCOL || lease.proofDigest !== businessNativeActionMetadataDigest(watch)
        || !isBusinessRevision(lease.sequence) || !isBusinessRevision(lease.expiresAt) || lease.expiresAt <= now()
        || lease.expiresAt > Math.min(context.expiresAt, Date.parse(session.expiresAt), Date.parse(decision.epoch.expiresAt), Date.parse(mapping.expiresAt))) {
        close(); return refused('unknown', 'serialized_native_action_admission_unavailable');
      }
      if (superseded()) { close(); return refused('deny', 'native_action_authority_invalidated'); }
      const current = (): boolean => {
        if (superseded()) { close(); return false; }
        try {
          const identity = ports.identity!.current();
          if (now() >= lease!.expiresAt || !identity || !isBusinessSession(identity) || !sameBusinessSession(identity, session)
            || !businessRevisionMappingCurrent(ports.registry, mapping, now()) || ports.contexts!.current(context) !== true || lease!.current() !== true) {
            close(); return false;
          }
          return true;
        } catch { close(); return false; }
      };
      if (await policy.stillCurrent(decision.epoch) !== true || await ports.registry!.stillCurrent(mapping) !== true || !current()) {
        close(); return refused('deny', 'native_action_authority_changed');
      }
      const admissionProof = Object.freeze({ protocol: lease.protocol, proofDigest: lease.proofDigest, sequence: lease.sequence, expiresAt: lease.expiresAt });
      const entry: PreparedAction = { requestDigest: key, nativeRevision: context.nativeDecisionRevision, session, context, mapping,
        admissionInput: watch, admissionProof, current, close };
      for (const [id, old] of prepared) if (!old.current()) { old.close(); prepared.delete(id); attempts.delete(id); }
      while (prepared.size >= 128) { const id = prepared.keys().next().value!; prepared.get(id)?.close(); prepared.delete(id); attempts.delete(id); }
      prepared.set(key, entry); published = true;
      return Object.freeze({ decision: 'allow', revision: entry.nativeRevision, reason: 'allowed', stillCurrent: current, release: close });
    } catch { close(); return refused('unknown', 'business_native_action_authority_unavailable'); }
    finally {
      if (key !== null && pending.get(key)?.attempt === attempt) pending.delete(key);
      if (!published) { close(); if (key !== null && attempts.get(key) === attempt) attempts.delete(key); }
    }
  }
  const exactEntry = (request: BusinessNativeActionRequest): PreparedAction | null => {
    const entry = prepared.get(businessNativeActionMetadataDigest(request));
    return entry && entry.current() ? entry : null;
  };
  const actionAuthority = Object.freeze({ current(request: Readonly<BusinessNativeActionRequest>): BusinessNativeActionDecision {
    if (!isBusinessNativeDataActionRequest(request)) return { decision: 'deny', revision: '', reason: 'invalid_native_data_action' };
    const entry = exactEntry(request);
    return entry ? { decision: 'allow', revision: entry.nativeRevision, reason: 'allowed' }
      : { decision: 'unknown', revision: '', reason: 'exact_native_action_admission_not_prepared' };
  } });
  const receipt = (entry: PreparedAction | null, state: 'denied' | 'unknown' = 'denied'): BusinessConditionalDocumentReceipt => Object.freeze({
    operationId: entry?.context.document?.operationId ?? 'invalid-operation', targetId: entry?.context.document?.targetResourceId ?? 'invalid-target',
    previousRevision: entry?.context.query.resources.find(ref => ref.resourceId === entry.context.document?.targetResourceId)?.revision ?? 0,
    state, revision: null, digest: null, readBackRevision: null, readBackDigest: null,
  });
  async function writeConditionalDocument(raw: Readonly<BusinessNativeActionRequest>): Promise<BusinessConditionalDocumentReceipt> {
    if (!isBusinessNativeDataActionRequest(raw)) return receipt(null);
    // The caller provides only the exact native request. Intent/body/target/audience are
    // selected from the frozen native owner context, never renderer-supplied write data.
    const request = immutable(raw);
    const entry = exactEntry(request);
    if (!entry || request.organizationId === null || !entry.context.document || documentBlocker()) return receipt(entry);
    const document = entry.context.document;
    const operationKey = businessNativeActionMetadataDigest([entry.session, document.operationId]);
    if (documentInFlight.has(operationKey)) return receipt(entry, 'unknown');
    documentInFlight.add(operationKey);
    try {
      const target = entry.context.query.resources.find(ref => ref.resourceId === document.targetResourceId)!;
      const artifact = entry.context.query.resources.find(ref => ref.resourceId === document.artifactResourceId)!;
      const exact = immutable({ session: entry.session, query: entry.context.query, operationId: document.operationId,
        purpose: entry.context.query.purpose, artifact, target, audienceResourceIds: document.audienceResourceIds,
        revisionMapping: entry.mapping } satisfies BusinessConditionalDocumentRequest);
      const identityCurrent = (): boolean => {
        try { const identity = ports.identity!.current(); return !!identity && isBusinessSession(identity) && sameBusinessSession(identity, entry.session); }
        catch { return false; }
      };
      const unknownDecision = (): BusinessDecision => ({ schema: BUSINESS_AUTHORITY_SCHEMA, verdict: 'unknown', reason: 'authority_stale', epoch: null, expiresAt: null });
      const authority: BusinessAuthority = {
        async currentDecision(query: BusinessQuery, session: BusinessSession): Promise<BusinessDecision> {
          if (!sameBusinessSession(session, entry.session) || !identityCurrent() || !await ports.sessions.stillCurrent(entry.session)) return unknownDecision();
          const decision = await ports.authority!.currentDecision(query, session);
          return identityCurrent() && await ports.sessions.stillCurrent(entry.session) ? decision : unknownDecision();
        },
        async stillCurrent(epoch: BusinessEpoch): Promise<boolean> {
          return isBusinessEpoch(epoch) && identityCurrent() && await ports.sessions.stillCurrent(entry.session)
            && await ports.authority!.stillCurrent(epoch) === true && identityCurrent() && await ports.sessions.stillCurrent(entry.session);
        },
      };
      const atomic: BusinessConditionalDocumentPort = { async commit(value: Readonly<BusinessConditionalDocumentInput>) {
        // This callback still delegates to the organization document authority's actual
        // SAME serialization/CAS/receipt/read-back domain. The admission context also
        // binds its registered operation/body digest. Local SQL is not a substitute.
        if (!entry.current() || !await ports.sessions.stillCurrent(entry.session) || !entry.current()
          || value.operationId !== document.operationId || value.purpose !== entry.context.query.purpose
          || desktopBusinessQueryDigest(value.query) !== desktopBusinessQueryDigest(entry.context.query)
          || value.epoch.authorityRevision !== entry.context.businessAuthorityRevision
          || !sameBusinessResource(value.artifact, artifact) || !sameBusinessResource(value.target, target)
          || businessNativeActionMetadataDigest(value.audienceResourceIds) !== businessNativeActionMetadataDigest(document.audienceResourceIds)
          || !businessRevisionMappingMatchesRequest(value.revisionMapping, { session: entry.session, work: entry.context.work, sources: entry.context.sources }, now())) return receipt(entry);
        const commit = callback(ports.documents!, 'commit');
        if (!documentReady() || !commit) return receipt(entry);
        // Preserve the ORIGINAL registered pin and its value-only proof, alongside the
        // newly reauthorized document input. A different fence id is never fabricated
        // into the earlier proof. The domain validates both under its own transaction.
        const native = immutable({ protocol: BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL, document: value,
          context: entry.context, admissionInput: entry.admissionInput, admissionProof: entry.admissionProof });
        try { return await commit(native) as BusinessConditionalDocumentReceipt; }
        finally { entry.close(); }
      } };
      return await createBusinessConditionalDocumentWriter(authority, atomic, ports.registry, now)(exact);
    } catch { return receipt(entry, 'unknown'); }
    finally { entry.close(); documentInFlight.delete(operationKey); }
  }
  return Object.freeze({
    prepareCurrentAction, actionAuthority, writeConditionalDocument, blocker, documentBlocker,
    /** Terminal invalidation/release needs no successful auth/provider/Business call. */
    invalidate(): void {
      generation++; for (const value of pending.values()) value.close(); for (const value of prepared.values()) value.close();
      pending.clear(); attempts.clear(); prepared.clear(); policy.invalidate();
    },
  });
}

function exactMetadata(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return businessOnlyKeys(value, keys) && Object.keys(value).length === keys.length;
}
export function isBusinessToolchainNativeRequest(value: unknown): value is BusinessToolchainNativeRequest {
  try {
    const keys = ['schema', 'phase', 'principalId', 'sessionId', 'hostId', 'organizationId', 'scope', 'workspaceId', 'projectId',
      'originalWorkRef', 'callerChatId', 'sourceCallCallerChatId', 'assetId', 'assetVersion', 'assetContentHash', 'callerCallId', 'callerInputHash',
      'callerParentRunId', 'callerCallRunId', 'reportId', 'reportRevision', 'recipientChatId', 'bodyDigest', 'purpose', 'payerId'];
    if (!exactMetadata(value, keys)) return false;
    const r = value as unknown as BusinessToolchainNativeRequest;
    return r.schema === BUSINESS_TOOLCHAIN_REQUEST_SCHEMA && BUSINESS_TOOLCHAIN_PHASES.includes(r.phase)
      && [r.principalId, r.sessionId, r.hostId, r.organizationId, r.workspaceId, r.originalWorkRef, r.callerChatId, r.sourceCallCallerChatId,
        r.assetId, r.callerCallId, r.callerParentRunId, r.callerCallRunId, r.reportId, r.purpose, r.payerId].every(isBusinessId)
      && [r.projectId, r.reportRevision, r.recipientChatId].every(v => v === null || isBusinessId(v))
      && isBusinessRevision(r.assetVersion) && r.assetVersion > 0 && [r.assetContentHash, r.callerInputHash, r.bodyDigest].every(hex)
      && isBusinessScope(r.scope) && (r.scope.kind === 'personal' ? r.scope.principalId === r.principalId : r.scope.organizationId === r.organizationId)
      && (!['report-read', 'repair-draft'].includes(r.phase) || r.reportRevision !== null) && (r.phase !== 'passive-notice' || r.recipientChatId !== null);
  } catch { return false; }
}
function validConversation(value: unknown): value is BusinessToolchainConversationBinding {
  return exactMetadata(value, ['chatId', 'principalId', 'resourceId', 'permissionRevision', 'audienceRevision'])
    && Object.values(value).every(isBusinessId);
}
function validToolchainContext(value: unknown, request: BusinessToolchainNativeRequest, session: BusinessSession, now: number): value is BusinessToolchainOwnerContext {
  try {
    if (!exactMetadata(value, ['schema', 'contextId', 'contextRevision', 'requestDigest', 'request', 'session', 'ownerAuthorityId', 'ownerDomainId',
      'original', 'work', 'predecessor', 'asset', 'call', 'report', 'caller', 'recipient', 'audience', 'sources', 'sourceBindings', 'intent', 'effect', 'query',
      'issuedAuthorityRevision', 'nativeDecisionRevision', 'businessAuthorityRevision', 'expiresAt'])) return false;
    const c = value as unknown as BusinessToolchainOwnerContext;
    if (c.schema !== BUSINESS_TOOLCHAIN_CONTEXT_SCHEMA || ![c.contextId, c.contextRevision, c.ownerAuthorityId, c.ownerDomainId,
      c.issuedAuthorityRevision, c.nativeDecisionRevision].every(isBusinessId) || !hex(c.requestDigest)
      || c.requestDigest !== businessNativeActionMetadataDigest(request) || !isBusinessToolchainNativeRequest(c.request)
      || businessNativeActionMetadataDigest(c.request) !== c.requestDigest || !isBusinessSession(c.session)
      || !sameBusinessSession(c.session, session) || !isBusinessNativeWork(c.work)
      || !isBusinessRevision(c.businessAuthorityRevision) || !isBusinessRevision(c.expiresAt) || c.expiresAt <= now
      || c.expiresAt > Date.parse(session.expiresAt)) return false;
    if (!exactMetadata(c.original, ['workRef', 'commandId', 'commandRevision', 'callerChatId']) || !Object.values(c.original).every(isBusinessId)
      || c.original.workRef !== request.originalWorkRef || c.original.commandId !== c.work.commandId || c.original.callerChatId !== request.callerChatId) return false;
    if (!exactMetadata(c.asset, ['id', 'version', 'contentHash', 'resourceId', 'revision']) || ![c.asset.id, c.asset.resourceId, c.asset.revision].every(isBusinessId)
      || c.asset.id !== request.assetId || c.asset.version !== request.assetVersion || c.asset.contentHash !== request.assetContentHash) return false;
    if (!exactMetadata(c.call, ['id', 'revision', 'resourceId', 'callerChatId', 'parentRunId', 'runId', 'inputHash', 'assetId', 'assetVersion', 'assetContentHash'])
      || ![c.call.id, c.call.revision, c.call.resourceId, c.call.callerChatId, c.call.parentRunId, c.call.runId, c.call.assetId].every(isBusinessId)
      || c.call.id !== request.callerCallId || c.call.callerChatId !== request.sourceCallCallerChatId || c.call.parentRunId !== request.callerParentRunId
      || c.call.runId !== request.callerCallRunId || c.call.inputHash !== request.callerInputHash || c.call.assetId !== c.asset.id
      || c.call.assetVersion !== c.asset.version || c.call.assetContentHash !== c.asset.contentHash) return false;
    if (!exactMetadata(c.report, ['id', 'revision', 'resourceId']) || ![c.report.id, c.report.resourceId].every(isBusinessId)
      || c.report.id !== request.reportId || c.report.revision !== request.reportRevision) return false;
    if (!validConversation(c.caller) || c.caller.chatId !== request.callerChatId || c.caller.principalId !== session.principalId
      || (c.recipient === null ? request.recipientChatId !== null : !validConversation(c.recipient) || c.recipient.chatId !== request.recipientChatId)
      || !isBusinessNativeArray(c.audience) || !c.audience.length || !c.audience.every(validConversation)
      || new Set(c.audience.map(a => a.chatId)).size !== c.audience.length
      || new Set(c.audience.map(a => a.resourceId)).size !== c.audience.length
      || !c.audience.some(a => businessNativeActionMetadataDigest(a) === businessNativeActionMetadataDigest(c.caller))
      || (c.recipient !== null && !c.audience.some(a => businessNativeActionMetadataDigest(a) === businessNativeActionMetadataDigest(c.recipient)))) return false;
    if (!isBusinessNativeArray(c.sources) || !c.sources.length || !c.sources.every(isBusinessOpaqueSource)
      || new Set(c.sources.map(s => s.resourceId)).size !== c.sources.length
      || !isBusinessNativeArray(c.sourceBindings) || c.sourceBindings.length !== c.sources.length) return false;
    const boundIds = new Set<string>(); const boundRefs = new Set<string>();
    for (const b of c.sourceBindings) {
      if (!exactMetadata(b, ['sourceRef', 'resourceId', 'permissionRevision', 'consentRevision', 'tombstoneRevision', 'audienceRevision', 'audiencePrincipalIds'])
        || ![b.sourceRef, b.resourceId, b.permissionRevision, b.consentRevision, b.tombstoneRevision, b.audienceRevision].every(isBusinessId)
        || boundIds.has(b.resourceId) || boundRefs.has(b.sourceRef) || !c.sources.some(s => s.resourceId === b.resourceId)
        || !isBusinessNativeArray(b.audiencePrincipalIds) || !b.audiencePrincipalIds.length || !b.audiencePrincipalIds.every(isBusinessId)
        || new Set(b.audiencePrincipalIds).size !== b.audiencePrincipalIds.length || !b.audiencePrincipalIds.includes(session.principalId)
        || (c.recipient !== null && !b.audiencePrincipalIds.includes(c.recipient.principalId))) return false;
      boundIds.add(b.resourceId); boundRefs.add(b.sourceRef);
    }
    const assetSource = c.sources.find(s => s.resourceId === c.asset.resourceId);
    const callSource = c.sources.find(s => s.resourceId === c.call.resourceId);
    const reportSource = c.sources.find(s => s.resourceId === c.report.resourceId);
    if (assetSource?.revision !== c.asset.revision || callSource?.revision !== c.call.revision || !reportSource
      || (c.report.revision !== null && reportSource.revision !== c.report.revision)) return false;
    if (c.audience.some(a => !c.sourceBindings.some(b => b.resourceId === a.resourceId && b.permissionRevision === a.permissionRevision
      && b.audienceRevision === a.audienceRevision))) return false;
    const p = c.predecessor;
    if (!exactMetadata(p, ['registrationId', 'authorityId', 'domainId', 'revision', 'originalWorkRef', 'commandRevision', 'scope', 'identity',
      'work', 'caller', 'call', 'custody', 'admission', 'sources', 'sourceBindings'])
      || ![p.registrationId, p.authorityId, p.domainId, p.revision, p.originalWorkRef, p.commandRevision].every(isBusinessId)
      || p.authorityId !== c.ownerAuthorityId || p.domainId !== c.ownerDomainId || !isBusinessScope(p.scope) || !sameBusinessScope(p.scope, request.scope)
      || !exactMetadata(p.identity, ['principalId', 'sessionId', 'sessionRevision', 'authEpoch', 'deploymentId', 'organizationId', 'identityAuthorityId', 'hostId'])
      || ![p.identity.principalId, p.identity.sessionId, p.identity.deploymentId, p.identity.organizationId, p.identity.identityAuthorityId, p.identity.hostId].every(isBusinessId)
      || !isBusinessRevision(p.identity.sessionRevision) || !isBusinessRevision(p.identity.authEpoch)
      || p.identity.deploymentId !== session.deploymentId || p.identity.organizationId !== session.organizationId || p.identity.identityAuthorityId !== session.identityAuthorityId
      || (p.scope.kind === 'personal' && p.scope.principalId !== p.identity.principalId)
      || !isBusinessNativeWork(p.work) || p.work.runId !== request.callerParentRunId || !validConversation(p.caller)
      || p.caller.chatId !== request.sourceCallCallerChatId || p.caller.principalId !== p.identity.principalId
      || !exactMetadata(p.call, ['id', 'revision', 'resourceId', 'callerChatId', 'parentRunId', 'runId', 'inputHash', 'assetId', 'assetVersion', 'assetContentHash'])
      || ![p.call.id, p.call.revision, p.call.resourceId, p.call.callerChatId, p.call.parentRunId, p.call.runId, p.call.assetId].every(isBusinessId)
      || !isBusinessRevision(p.call.assetVersion) || !hex(p.call.inputHash) || !hex(p.call.assetContentHash)
      || businessNativeActionMetadataDigest(p.call) !== businessNativeActionMetadataDigest(c.call)
      || !exactMetadata(p.custody, ['id', 'revision']) || !Object.values(p.custody).every(isBusinessId)
      || !exactMetadata(p.admission, ['id', 'revision', 'issuedAuthorityRevision']) || !Object.values(p.admission).every(isBusinessId)
      || !isBusinessNativeArray(p.sources) || !p.sources.length || !p.sources.every(isBusinessOpaqueSource)
      || new Set(p.sources.map(s => s.resourceId)).size !== p.sources.length
      || ![c.asset.resourceId, c.call.resourceId, p.caller.resourceId].every(id => p.sources.some(s => s.resourceId === id))
      || !p.sources.every(source => c.sources.some(current => sameBusinessOpaqueSource(source, current)))
      || !isBusinessNativeArray(p.sourceBindings) || p.sourceBindings.length !== p.sources.length
      || new Set(p.sourceBindings.map(b => b.resourceId)).size !== p.sourceBindings.length
      || !p.sourceBindings.every(b => exactMetadata(b, ['sourceRef', 'resourceId', 'permissionRevision', 'consentRevision', 'tombstoneRevision', 'audienceRevision', 'audiencePrincipalIds'])
        && [b.sourceRef, b.resourceId, b.permissionRevision, b.consentRevision, b.tombstoneRevision, b.audienceRevision].every(isBusinessId)
        && isBusinessNativeArray(b.audiencePrincipalIds) && b.audiencePrincipalIds.every(isBusinessId)
        && p.sources.some(source => source.resourceId === b.resourceId)
        && c.sourceBindings.some(current => businessNativeActionMetadataDigest(b) === businessNativeActionMetadataDigest(current)))
      || !p.sourceBindings.some(b => b.resourceId === p.caller.resourceId && b.permissionRevision === p.caller.permissionRevision
        && b.audienceRevision === p.caller.audienceRevision)) return false;
    // New maker read/repair work remains CURRENT. The retained call has its own source
    // command/custody vector, never treated as a historical grant for the maker.
    const { expiresAt: _expiry, ...currentIdentity } = session;
    if (request.phase === 'report' && (request.sourceCallCallerChatId !== request.callerChatId
      || p.originalWorkRef !== c.original.workRef || p.commandRevision !== c.original.commandRevision || !sameBusinessNativeWork(p.work, c.work)
      || businessNativeActionMetadataDigest(p.identity) !== businessNativeActionMetadataDigest(currentIdentity)
      || businessNativeActionMetadataDigest(p.caller) !== businessNativeActionMetadataDigest(c.caller))) return false;
    // A repair maker can receive its own budget/status notice under its CURRENT work.
    // The current notice caller must be the verified recipient or the retained requester.
    // The source call keeps its independent original custody and current source checks.
    if (request.phase === 'passive-notice' && (c.recipient === null
      || ![c.recipient, p.caller].some(caller =>
        businessNativeActionMetadataDigest(caller) === businessNativeActionMetadataDigest(c.caller)))) return false;
    if (!exactMetadata(c.intent, ['revision', 'bodyDigest', 'payerId', 'payerRevision', 'budgetRevision', 'permissionRevision', 'consentRevision', 'tombstoneRevision', 'audienceRevision'])
      || ![c.intent.revision, c.intent.payerId, c.intent.payerRevision, c.intent.permissionRevision, c.intent.consentRevision,
        c.intent.tombstoneRevision, c.intent.audienceRevision].every(isBusinessId) || c.intent.bodyDigest !== request.bodyDigest
      || c.intent.payerId !== request.payerId || (c.intent.budgetRevision !== null && !isBusinessId(c.intent.budgetRevision))) return false;
    if (!exactMetadata(c.effect, ['authorityId', 'domainId', 'effectId', 'revision']) || !Object.values(c.effect).every(isBusinessId)
      || c.effect.authorityId !== c.ownerAuthorityId || c.effect.domainId !== c.ownerDomainId) return false;
    const query = c.query;
    if (!isBusinessNativeArray(query.resources) || !isBusinessQuery(query) || query.action !== `toolchain.${request.phase}`
      || query.deploymentId !== session.deploymentId || query.organizationId !== session.organizationId || query.hostId !== session.hostId
      || query.purpose !== request.purpose || (query.projectId ?? null) !== request.projectId || query.taskId !== c.work.taskId
      || query.runId !== c.work.runId || query.occurrenceId !== c.work.occurrenceId || query.resources.length !== c.sources.length
      || !query.resources.every(ref => c.sources.some(s => s.resourceId === ref.resourceId) && sameBusinessScope(ref.scope, request.scope))
      || ![c.asset.resourceId, c.call.resourceId, c.report.resourceId, ...c.audience.map(a => a.resourceId)].every(id => query.resources.some(ref => ref.resourceId === id))
      || (query.charge !== undefined && (query.charge.payerId !== request.payerId || c.intent.budgetRevision === null))) return false;
    // Repair custody includes the actual existing budget; this composition never calls
    // a provider, replaces the stable version or authorizes a validation/publish action.
    return request.phase === 'repair-draft' ? !!query.charge && c.intent.budgetRevision !== null
      : query.providerBindingId === undefined && query.credentialRef === undefined && query.charge === undefined;
  } catch { return false; }
}
interface PreparedToolchainAction {
  readonly requestDigest: string;
  readonly nativeRevision: string;
  readonly context: BusinessToolchainOwnerContext;
  readonly registered: BusinessToolchainRegisteredAdmission;
  current(): boolean;
  closed(): boolean;
  close(): void;
}
export interface BusinessToolchainNativeCompositionPorts extends Pick<BusinessNativeActionCompositionPorts, 'sessions' | 'identity' | 'authority' | 'registry'> {
  readonly contexts: BusinessToolchainContextPort | null;
  readonly admission: BusinessToolchainAdmissionPort | null;
  readonly effects: BusinessToolchainEffectPort | null;
}
/** Existing owner composition only. Genuine source/command/lease lookup and SAME-domain
 * serialization remain mandatory supplied ports; there is no alternate SQL authority. */
export function createBusinessToolchainNativeActionComposition(input: BusinessToolchainNativeCompositionPorts, now: () => number = Date.now) {
  const ports = Object.freeze({ ...input });
  const policy = new DesktopBusinessPolicyAdapter(ports.sessions, ports.authority, null, now);
  const resolve = createBusinessRevisionResolver(ports.registry, now);
  const prepared = new Map<string, PreparedToolchainAction>();
  const pending = new Map<string, { token: symbol; close(): void; settled(): boolean; pinUnsettled(): boolean; cleanupUnknown(): boolean;
    original(): BusinessToolchainRegisteredAdmission | null }>();
  const effectsInFlight = new Set<string>();
  // Local deny guards only, never a replacement for the owner's durable effect ledger.
  // Unknown invocations stay held for this composition's lifetime, including invalidate().
  // No TTL/session refresh or capacity eviction establishes a reconciled original receipt.
  const unresolvedEffects = new Set<string>();
  const capacity = 128;
  const effectIdentityKey = (context: BusinessToolchainOwnerContext): string => businessNativeActionMetadataDigest({
    authorityId: context.effect.authorityId, domainId: context.effect.domainId, effectId: context.effect.effectId,
    deploymentId: context.session.deploymentId, identityAuthorityId: context.session.identityAuthorityId,
    principalId: context.session.principalId, organizationId: context.session.organizationId, hostId: context.session.hostId,
    scope: context.request.scope,
  });
  let generation = 0;
  const refused = (decision: 'deny' | 'unknown', reason: string): BusinessPreparedNativeAction => Object.freeze({ decision, revision: '', reason,
    stillCurrent: () => false, release: () => {} });
  const unconfirmedCleanup = (release: () => void): BusinessPreparedNativeAction => Object.freeze({ decision: 'unknown', revision: '',
    reason: 'toolchain_lease_cleanup_unconfirmed', stillCurrent: () => false, release });
  const closeConfirmed = (entry: { close(): void }): boolean => { try { entry.close(); return true; } catch { return false; } };
  const prunePrepared = (): void => {
    for (const [id, entry] of prepared) if (!effectsInFlight.has(effectIdentityKey(entry.context)) && !entry.current()
      && closeConfirmed(entry)) prepared.delete(id);
  };
  const effectsReady = (): boolean => {
    try { return !!ports.effects && ownedValue(ports.effects, 'protocol') === BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL && !!callback(ports.effects, 'withCurrentExclusion'); }
    catch { return false; }
  };
  const sourceCallReady = (): boolean => {
    try { return !!ports.contexts && !!callback(ports.contexts, 'currentSourceCall'); } catch { return false; }
  };
  const blocker = (): string | null => !ports.identity ? 'business_native_identity_unbound' : !ports.authority ? 'business_authenticated_authority_transport_unbound'
    : !ports.registry ? 'business_native_revision_registry_unbound' : !ports.contexts ? 'business_toolchain_native_context_unbound'
      : !sourceCallReady() ? 'business_toolchain_source_call_registry_unbound' : !ports.admission ? 'business_toolchain_serialized_admission_unbound'
        : !effectsReady() ? 'business_toolchain_owner_effect_domain_unbound' : null;
  async function prepareCurrentAction(raw: Readonly<BusinessToolchainNativeRequest>): Promise<BusinessPreparedNativeAction> {
    let releaseOwned: (() => unknown) | null = null; let closed = false; let released = false; let published = false;
    let settled = false; let cleanupUnknown = false; let cleanupEffectKey: string | null = null;
    let releaseInProgress = false; let pinInProgress = false;
    let originalRegistration: BusinessToolchainRegisteredAdmission | null = null;
    let key: string | null = null; let token: symbol | null = null;
    const started = generation;
    const close = (): void => {
      closed = true;
      // A synchronous reentrant observer cannot acknowledge a release whose owner
      // has not returned. Preserve custody if that observer prunes/invalidates.
      if (releaseInProgress) cleanupUnknown = true;
      if (originalRegistration && !releaseOwned) cleanupUnknown = true;
      if (releaseOwned && !released) {
        released = true; releaseInProgress = true;
        try { releaseOwned(); } catch { cleanupUnknown = true; }
        finally { releaseInProgress = false; }
      }
      // The original release is attempted once. Every later observer sees the same
      // unconfirmed cleanup; closing local authority does not confirm owner cleanup.
      if (cleanupUnknown) {
        if (cleanupEffectKey !== null) unresolvedEffects.add(cleanupEffectKey);
        throw new Error('toolchain_lease_cleanup_unconfirmed');
      }
    };
    const closeLocally = (): void => { closeConfirmed({ close }); };
    const superseded = (): boolean => closed || generation !== started || (key !== null && pending.get(key)?.token !== token && !published);
    try {
      if (!isBusinessToolchainNativeRequest(raw)) return refused('deny', 'invalid_toolchain_native_request');
      const request = immutable(raw); const absent = blocker(); if (absent) return refused('unknown', absent);
      key = businessNativeActionMetadataDigest(request);
      if (pending.has(key)) return refused('unknown', 'toolchain_admission_in_flight');
      const existing = prepared.get(key);
      if (existing && effectsInFlight.has(effectIdentityKey(existing.context))) return refused('unknown', 'toolchain_effect_in_flight');
      if (existing?.current()) return refused('unknown', 'toolchain_admission_already_prepared');
      if (existing && !closeConfirmed(existing)) return unconfirmedCleanup(existing.close);
      prepared.delete(key); prunePrepared();
      if (pending.size + prepared.size >= capacity) return refused('unknown', 'toolchain_admission_capacity');
      token = Symbol('toolchain-native-admission'); pending.set(key, { token, close, settled: () => settled,
        pinUnsettled: () => pinInProgress, cleanupUnknown: () => cleanupUnknown, original: () => originalRegistration });
      const session = await ports.sessions.current();
      if (superseded()) return refused('deny', 'toolchain_admission_superseded');
      const identity = ports.identity!.current();
      if (!session || !identity || !isBusinessSession(identity) || !sameBusinessSession(identity, session)
        || request.principalId !== session.principalId || request.sessionId !== session.sessionId || request.hostId !== session.hostId
        || request.organizationId !== session.organizationId) return refused('deny', 'native_session_changed');
      if (await ports.sessions.stillCurrent(session) !== true || superseded()) return refused('deny', 'native_session_changed');
      const found = await ports.contexts!.resolve(request, session);
      if (superseded()) return refused('deny', 'toolchain_admission_superseded');
      if (!validToolchainContext(found, request, session, now())) return refused('deny', 'toolchain_native_context_changed');
      const context = immutable(found);
      if (ports.contexts!.current(context) !== true || ports.contexts!.currentSourceCall(context.predecessor, context) !== true) return refused('deny', 'toolchain_native_context_changed');
      const effectKey = effectIdentityKey(context);
      cleanupEffectKey = effectKey;
      if (unresolvedEffects.has(effectKey)) return refused('unknown', 'toolchain_effect_reconciliation_required');
      if (effectsInFlight.has(effectKey)) return refused('unknown', 'toolchain_effect_in_flight');
      if (unresolvedEffects.size >= capacity) return refused('unknown', 'toolchain_unresolved_effect_capacity');
      const mapping = await resolve({ session, work: context.work, sources: context.sources });
      if (superseded()) return refused('deny', 'toolchain_admission_superseded');
      if (!mapping) return refused('unknown', 'native_revision_mapping_unavailable');
      const query = snapshotBusinessQuery(context.query);
      if (!query || query.controlVersion !== mapping.canonicalControlRevision || query.resources.length !== mapping.resources.length
        || !query.resources.every(ref => mapping.resources.some(pair => sameBusinessResource(ref, pair.canonical)))) return refused('deny', 'native_canonical_query_changed');
      const decision = await policy.currentDecision(query);
      if (superseded()) return refused('deny', 'toolchain_admission_superseded');
      if (decision.verdict !== 'allow' || !decision.epoch) return refused(decision.verdict === 'unknown' ? 'unknown' : 'deny', decision.reason);
      if (decision.epoch.authorityRevision !== context.businessAuthorityRevision) return refused('deny', 'issued_business_authority_changed');
      const admissionInput = immutable({ session, query, epoch: decision.epoch, mapping, context } satisfies BusinessToolchainAdmissionInput);
      let original: BusinessNativeActionAdmissionLease | null;
      pinInProgress = true;
      try { original = await ports.admission!.pin(admissionInput, close); }
      finally { pinInProgress = false; }
      if (original) originalRegistration = Object.freeze({ input: admissionInput, lease: original });
      let currentOwned: (() => unknown) | null = null;
      if (original && typeof original === 'object') { releaseOwned = callback(original, 'release'); currentOwned = callback(original, 'current'); }
      const expiresAt = original ? ownedValue(original, 'expiresAt') : null;
      const proofDigest = original ? ownedValue(original, 'proofDigest') : null;
      const sequence = original ? ownedValue(original, 'sequence') : null;
      if (!original || !releaseOwned || !currentOwned || ownedValue(original, 'protocol') !== BUSINESS_NATIVE_ACTION_ADMISSION_PROTOCOL
        || proofDigest !== businessNativeActionMetadataDigest(admissionInput) || !isBusinessRevision(sequence)
        || !isBusinessRevision(expiresAt) || expiresAt <= now()
        || expiresAt > Math.min(context.expiresAt, Date.parse(session.expiresAt), Date.parse(decision.epoch.expiresAt), Date.parse(mapping.expiresAt))) {
        close(); return refused('unknown', 'toolchain_serialized_admission_unavailable');
      }
      const current = (): boolean => {
        if (superseded()) { closeLocally(); return false; }
        try {
          const identity = ports.identity!.current();
          if (ownedValue(original, 'protocol') !== BUSINESS_NATIVE_ACTION_ADMISSION_PROTOCOL || ownedValue(original, 'proofDigest') !== proofDigest
            || ownedValue(original, 'sequence') !== sequence || ownedValue(original, 'expiresAt') !== expiresAt
            || now() >= expiresAt || !identity || !isBusinessSession(identity) || !sameBusinessSession(identity, session)
            || !businessRevisionMappingCurrent(ports.registry, mapping, now()) || ports.contexts!.current(context) !== true
            || !sourceCallReady() || ports.contexts!.currentSourceCall(context.predecessor, context) !== true || currentOwned!() !== true) {
            closeLocally(); return false;
          }
          return !superseded();
        } catch { closeLocally(); return false; }
      };
      if (await ports.sessions.stillCurrent(session) !== true || await policy.stillCurrent(decision.epoch) !== true
        || await ports.registry!.stillCurrent(mapping) !== true || !current()) {
        close(); return refused('deny', 'toolchain_native_authority_changed');
      }
      // A parallel phase may have invoked this original effect while pin() was pending.
      if (unresolvedEffects.has(effectKey)) { close(); return refused('unknown', 'toolchain_effect_reconciliation_required'); }
      if (effectsInFlight.has(effectKey)) { close(); return refused('unknown', 'toolchain_effect_in_flight'); }
      // Do not clone/freeze the owner's registered lease. Object identity is part of the
      // live registry contract, including its independent invalidate/release lifecycle.
      const registered = originalRegistration!;
      const entry: PreparedToolchainAction = { requestDigest: key, nativeRevision: context.nativeDecisionRevision, context, registered,
        current, closed: () => closed, close };
      prunePrepared();
      // Pruning invokes another owner's release, which may synchronously invalidate
      // this pending admission. Never publish an already closed/uncertain pin.
      if (!current()) { close(); return refused('deny', 'toolchain_native_authority_changed'); }
      if (prepared.size >= capacity) { close(); return refused('unknown', 'toolchain_admission_capacity'); }
      prepared.set(key, entry); published = true;
      return Object.freeze({ decision: 'allow', revision: entry.nativeRevision, reason: 'allowed', stillCurrent: current, release: close });
    } catch {
      closeLocally();
      return cleanupUnknown ? unconfirmedCleanup(close) : refused('unknown', 'business_toolchain_authority_unavailable');
    } finally {
      if (!published) closeLocally();
      settled = true;
      // Pending late pins remain bounded and owned until settled. A failed release
      // retains its ORIGINAL input/lease, including failures before publication.
      if (key !== null && pending.get(key)?.token === token && !cleanupUnknown) pending.delete(key);
    }
  }
  const exactEntry = (request: BusinessToolchainNativeRequest): PreparedToolchainAction | null => {
    const entry = prepared.get(businessNativeActionMetadataDigest(request)); return entry?.current() ? entry : null;
  };
  const actionAuthority = Object.freeze({ current(request: Readonly<BusinessToolchainNativeRequest>): BusinessNativeActionDecision {
    if (!isBusinessToolchainNativeRequest(request)) return { decision: 'deny', revision: '', reason: 'invalid_toolchain_native_request' };
    const entry = exactEntry(request);
    return entry ? { decision: 'allow', revision: entry.nativeRevision, reason: 'allowed' }
      : { decision: 'unknown', revision: '', reason: 'exact_toolchain_admission_not_prepared' };
  } });
  const groupVector = (c: BusinessToolchainOwnerContext): string => businessNativeActionMetadataDigest({
    session: c.session, original: c.original, work: c.work, predecessor: c.predecessor, asset: c.asset, call: c.call, report: c.report, caller: c.caller, recipient: c.recipient,
    audience: c.audience, sources: c.sources, sourceBindings: c.sourceBindings, effect: c.effect,
    issuedAuthorityRevision: c.issuedAuthorityRevision, businessAuthorityRevision: c.businessAuthorityRevision,
    scope: c.request.scope, workspaceId: c.request.workspaceId, projectId: c.request.projectId, purpose: c.request.purpose,
    intent: { payerId: c.intent.payerId, payerRevision: c.intent.payerRevision, budgetRevision: c.intent.budgetRevision,
      permissionRevision: c.intent.permissionRevision, consentRevision: c.intent.consentRevision,
      tombstoneRevision: c.intent.tombstoneRevision, audienceRevision: c.intent.audienceRevision },
    resources: c.query.resources,
  });
  async function withCurrentExclusion<T>(raw: Readonly<BusinessToolchainNativeRequest> | readonly Readonly<BusinessToolchainNativeRequest>[],
    reducer: (exclusion: Readonly<BusinessToolchainEffectExclusion>) => T): Promise<BusinessToolchainEffectResult<T>> {
    const result = (state: 'denied' | 'unknown', reason: string): BusinessToolchainEffectResult<T> => Object.freeze({ state, reason, value: null });
    let entries: PreparedToolchainAction[] = []; let effectKey: string | null = null; let ownsEffect = false;
    let entered = false; let produced = false; let invokedOwner = false; let confirmed = false; let value: T | null = null;
    let invocationAttempts = 0; let invocationFault = false;
    const perform = async (): Promise<BusinessToolchainEffectResult<T>> => {
      try {
        if (typeof reducer !== 'function' || ['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'].includes(Object.getPrototypeOf(reducer)?.constructor?.name)) return result('denied', 'toolchain_reducer_must_be_synchronous');
        const list = Array.isArray(raw) ? raw : [raw];
        if (!isBusinessNativeArray(list, 2) || !list.length || !list.every(isBusinessToolchainNativeRequest)
          || (list.length === 2 && (list[0].phase !== 'report' || list[1].phase !== 'passive-notice'))) return result('denied', 'invalid_toolchain_effect_group');
        if (list.length === 1 && list[0].phase === 'passive-notice' && list[0].reportRevision === null) return result('denied', 'toolchain_report_notice_requires_atomic_pair');
        const requests = immutable(list as readonly BusinessToolchainNativeRequest[]);
        if (blocker()) return result('unknown', 'business_toolchain_owner_effect_domain_unbound');
        for (const request of requests) { const entry = exactEntry(request); if (!entry) return result('denied', 'exact_toolchain_admission_not_prepared'); entries.push(entry); }
        if (entries.length === 2 && groupVector(entries[0].context) !== groupVector(entries[1].context)) return result('denied', 'toolchain_atomic_vector_mismatch');
        const effect = entries[0].context.effect;
        effectKey = effectIdentityKey(entries[0].context);
        if (effectsInFlight.has(effectKey)) { entries = []; return result('unknown', 'toolchain_effect_in_flight'); }
        if (unresolvedEffects.has(effectKey)) return result('unknown', 'toolchain_effect_reconciliation_required');
        if (effectsInFlight.size + unresolvedEffects.size >= capacity) return result('unknown', 'toolchain_unresolved_effect_capacity');
        effectsInFlight.add(effectKey); ownsEffect = true;
        // These remote checks are preliminary only. The supplied owner must serialize the
        // current authority lookup with the ORIGINAL effect, not open unrelated local SQL.
        for (const entry of entries) {
          if (await ports.sessions.stillCurrent(entry.registered.input.session) !== true || await policy.stillCurrent(entry.registered.input.epoch) !== true
            || await ports.registry!.stillCurrent(entry.registered.input.mapping) !== true || !entry.current()) return result('denied', 'toolchain_authority_changed');
        }
        const admissions = Object.freeze(entries.map(entry => entry.registered));
        const exact = Object.freeze({ protocol: BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL, effect, admissions });
        const commit = callback(ports.effects!, 'withCurrentExclusion');
        if (!effectsReady() || !commit) return result('unknown', 'business_toolchain_owner_effect_domain_unbound');
        invokedOwner = true;
        const settled = await commit(exact, (scope: unknown): unknown => {
          // Keep a rejected attempt sticky even if the owner suppresses the throw.
          if (++invocationAttempts !== 1) { invocationFault = true; throw new Error('toolchain_owner_reducer_repeated'); }
          entered = true;
          if (!exactMetadata(scope, ['protocol', 'effect', 'admissions', 'current']) || scope.protocol !== BUSINESS_TOOLCHAIN_EFFECT_PROTOCOL
            || !exactMetadata(scope.effect, ['authorityId', 'domainId', 'effectId', 'revision']) || !Object.values(scope.effect).every(isBusinessId)
            || businessNativeActionMetadataDigest(scope.effect) !== businessNativeActionMetadataDigest(effect)
            || !isBusinessNativeArray(scope.admissions, 2) || scope.admissions.length !== admissions.length
            || !scope.admissions.every((registration, i) => exactMetadata(registration, ['input', 'lease'])
              && registration.input === admissions[i].input && registration.lease === admissions[i].lease)
            || typeof scope.current !== 'function' || scope.current() !== true || entries.some(entry => !entry.current())) throw new Error('toolchain_owner_exclusion_changed');
          const returned = reducer(scope as unknown as BusinessToolchainEffectExclusion);
          // An async DB callback may already have scheduled effects; reject it so the
          // actual owner transaction rolls back. Never await a reducer under this lease.
          if (returned && (typeof returned === 'object' || typeof returned === 'function') && 'then' in returned) throw new Error('toolchain_reducer_unsettled');
          if (scope.current() !== true || entries.some(entry => !entry.current())) throw new Error('toolchain_owner_exclusion_changed');
          value = returned; produced = true; return returned;
        });
        confirmed = settled === true && invocationAttempts === 1 && !invocationFault && entered && produced && entries.every(entry => !entry.closed());
        return confirmed
          ? Object.freeze({ state: 'committed', reason: 'allowed', value }) : result('unknown', 'toolchain_effect_unconfirmed');
      } catch { return result('unknown', entered ? 'toolchain_effect_unconfirmed' : 'business_toolchain_effect_unavailable'); }
    };
    const outcome = await perform();
    let cleanupUnknown = false;
    // A malformed/unprepared group cannot close another in-flight original lease.
    // Attempt every owned close, retaining each fault without retrying its release.
    for (const entry of entries) if (ownsEffect || !effectsInFlight.has(effectIdentityKey(entry.context))) {
      if (!closeConfirmed(entry)) cleanupUnknown = true;
    }
    if (effectKey !== null && ownsEffect) {
      if (invokedOwner && (!confirmed || cleanupUnknown)) unresolvedEffects.add(effectKey);
      effectsInFlight.delete(effectKey);
    }
    // Owner SQL may already be committed. Cleanup uncertainty hides the result and
    // holds that SAME effect for receipt reconciliation; it never authorizes resend.
    return cleanupUnknown ? result('unknown', 'toolchain_lease_cleanup_unconfirmed') : outcome;
  }
  return Object.freeze({ prepareCurrentAction, actionAuthority, withCurrentExclusion, blocker,
    invalidate(): void {
      generation++;
      let cleanupUnknown = false;
      for (const [id, entry] of pending) {
        if (entry.pinUnsettled()) cleanupUnknown = true;
        if (!closeConfirmed(entry)) cleanupUnknown = true;
        if (entry.settled() && !entry.cleanupUnknown()) pending.delete(id);
      }
      for (const [id, entry] of prepared) {
        if (closeConfirmed(entry)) prepared.delete(id); else cleanupUnknown = true;
      }
      policy.invalidate();
      if (cleanupUnknown) throw new Error('toolchain_lease_cleanup_unconfirmed');
    },
  });
}
