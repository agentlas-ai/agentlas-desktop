import { BUSINESS_HISTORY_CANDIDATE_STATUSES, BUSINESS_HISTORY_DELETE_PROTOCOL, BUSINESS_HISTORY_ONE_WIRE_SCHEMA, BUSINESS_HISTORY_SEARCH_SCHEMA, BUSINESS_HISTORY_VIEW_SCHEMA,
  filterBusinessHistoryTimeline, isBusinessHistoryFilter, type BusinessHistoryEvidenceCitation, type BusinessHistorySearchRequest, type BusinessHistorySearchResult,
  type BusinessHistoryCandidateStatus, type BusinessHistoryCandidateView, type BusinessHistoryControlReceipt, type BusinessHistoryOneReadPort, type BusinessHistoryTarget,
  type BusinessHistoryDeleteCommit, type BusinessHistoryDeleteIntent, type BusinessHistoryDeleteReceipt, type BusinessHistoryDeleteReference, type BusinessHistoryDeleteRequest,
  type BusinessHistoryPanelPort, type BusinessHistoryTimelineEntry, type BusinessHistoryViewBinding,
  type BusinessHistoryViewCapability, type BusinessHistoryViewContext, type BusinessHistoryViewSnapshot } from '../../shared/business/history-view';
import { BUSINESS_AUTHORITY_SCHEMA, businessOnlyKeys, isBusinessEpoch, isBusinessId, isBusinessQuery, isBusinessResource, isBusinessRevision, isBusinessScope,
  isBusinessSession, sameBusinessResource, sameBusinessScope, sameBusinessSession, type BusinessAuthority, type BusinessEpoch } from '../../shared/business/context';
import { isBusinessNativeArray } from '../../shared/business/native-registry';
import { looksSecret, redactSecrets } from '../../shared/secret-patterns';
import type { ComputerHistoryDraftPrompt, ComputerHistoryState } from '../../shared/computer-history';
import { businessNativeActionMetadataDigest, isBusinessNativeDataActionRequest, type createBusinessNativeActionComposition } from './native-action-composition';
import { desktopBusinessQueryDigest } from './policy-adapter';

type NativeAuthority = Pick<ReturnType<typeof createBusinessNativeActionComposition>, 'prepareCurrentAction' | 'actionAuthority'>;
export interface BusinessHistoryViewOwnerPort {
  current(): Promise<BusinessHistoryViewBinding | null>;
  /** Actual full scope/session/source/policy registry check; no cached role allow. */
  stillCurrent(binding: Readonly<BusinessHistoryViewBinding>): Promise<boolean>;
  /** Existing session/grant/source invalidation events erase displayed content only.
   * Events are never treated as an executable allow cache. */
  subscribeInvalidation?(listener: () => void): () => void;
}
/** Genuine source privacy owner. This protocol is distinct from history read or
 * source-control. commit must atomically revalidate the registered ORIGINAL
 * intent, current session/scope/policy/filter/collection CAS and history.delete
 * authority in the SAME source authority serialization as tombstones/deletion
 * and its durable idempotent receipt. Async checks here do not replace that check. */
export interface BusinessHistoryPrivacyDeletePort {
  readonly protocol: typeof BUSINESS_HISTORY_DELETE_PROTOCOL;
  readonly authority: BusinessAuthority;
  /** Metadata-only current session/policy registry, independent of source-read
   * grants and collection consent. It must never return a cached allow. */
  currentContext(): Promise<BusinessHistoryViewContext | null>;
  /** No delete effect. Identical request maps to the SAME durable intent/key. */
  prepare(request: BusinessHistoryDeleteRequest): Promise<BusinessHistoryDeleteIntent | null>;
  stillCurrent(intent: BusinessHistoryDeleteIntent): Promise<boolean>;
  commit(input: BusinessHistoryDeleteCommit): Promise<BusinessHistoryDeleteReceipt>;
  /** Read the original durable receipt only; never repeat the effect. */
  receipt(input: { request: BusinessHistoryDeleteRequest; originalIntent: BusinessHistoryDeleteReference }): Promise<BusinessHistoryDeleteReceipt>;
}
export interface BusinessHistoryViewAdapterPorts {
  readonly owner: BusinessHistoryViewOwnerPort | null;
  readonly authority: NativeAuthority | null;
  /** Existing local Computer History API is PERSONAL ONLY. Never used for organization scope. */
  readonly personalHistory: { get(): Promise<ComputerHistoryState>; prepareDraft?(id: string, locale: 'ko' | 'en'): Promise<ComputerHistoryDraftPrompt> } | null;
  readonly organizationHistory: { read(binding: Readonly<BusinessHistoryViewBinding>): Promise<ComputerHistoryState> } | null;
  readonly one: BusinessHistoryOneReadPort | null;
  readonly controls: {
    /** Exact bounded stop must not depend on a successful Business/read permission call. */
    pause(input: { context: BusinessHistoryViewContext; expectedPolicyRevision: number }): Promise<BusinessHistoryControlReceipt>;
  } | null;
  readonly privacyDelete: BusinessHistoryPrivacyDeletePort | null;
  readonly review: { open(input: { context: BusinessHistoryViewContext; draft: ComputerHistoryDraftPrompt }): Promise<void> } | null;
  readonly navigation: {
    openPage?(input: { context: BusinessHistoryViewContext }): Promise<void>;
    openCandidate?(input: { context: BusinessHistoryViewContext; candidateId: string; expectedRevision: number }): Promise<void>;
  } | null;
}
function freeze<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(visit); Object.freeze(item); } };
  visit(copy); return copy;
}
function targetValid(value: unknown): value is BusinessHistoryTarget {
  if (!businessOnlyKeys(value, ['deploymentId', 'oneId', 'scope', 'organizationId', 'projectId', 'spaceId', 'pageId', 'audience'])) return false;
  if (![value.deploymentId, value.oneId, value.spaceId, value.pageId].every(isBusinessId)
    || ![value.organizationId, value.projectId].every(v => v === null || isBusinessId(v))
    || !['personal', 'project', 'organization'].includes(value.scope as string) || !['owner', 'organization'].includes(value.audience as string)) return false;
  return !(value.scope === 'personal' && (value.organizationId !== null || value.projectId !== null || value.audience !== 'owner'))
    && !(value.scope === 'project' && value.projectId === null) && !(value.scope === 'organization' && value.organizationId === null)
    && !(value.audience === 'organization' && value.organizationId === null);
}
export function isBusinessHistoryViewContext(value: unknown, now = Date.now()): value is BusinessHistoryViewContext {
  try {
    if (!businessOnlyKeys(value, ['session', 'scope', 'target', 'bindingKey', 'revision', 'policyRevision', 'nativePolicyRevision', 'expiresAt'])
      || !isBusinessSession(value.session) || !isBusinessScope(value.scope) || ![value.bindingKey, value.revision].every(isBusinessId)
      || (value.policyRevision !== null && !isBusinessRevision(value.policyRevision)) || (value.nativePolicyRevision !== null && !isBusinessId(value.nativePolicyRevision))
      || !isBusinessRevision(value.expiresAt) || value.expiresAt <= now || value.expiresAt > Date.parse(value.session.expiresAt)
      || Date.parse(value.session.expiresAt) <= now || (value.target !== null && !targetValid(value.target))) return false;
    const c = value as unknown as BusinessHistoryViewContext;
    if (c.scope.kind === 'personal' ? c.scope.principalId !== c.session.principalId : c.scope.organizationId !== c.session.organizationId) return false;
    return c.target === null || c.target.deploymentId === c.session.deploymentId
      && (c.scope.kind === 'personal' ? c.target.organizationId === null : c.target.organizationId === c.scope.organizationId);
  } catch { return false; }
}
function validBinding(value: unknown, now: number): value is BusinessHistoryViewBinding {
  try {
    if (!businessOnlyKeys(value, ['context', 'readRequest', 'entries', 'collection', 'analysis', 'retentionMs']) || !isBusinessHistoryViewContext(value.context, now)
      || !isBusinessNativeDataActionRequest(value.readRequest) || value.readRequest.action !== 'history-read' || !isBusinessNativeArray(value.entries, 160)
      || !['on', 'paused', 'off', 'unknown'].includes(value.collection as string) || !['on', 'paused', 'off', 'unknown'].includes(value.analysis as string)
      || (value.retentionMs !== null && (!isBusinessRevision(value.retentionMs) || value.retentionMs < 1 || value.retentionMs > 365 * 86400_000))) return false;
    const { context: c, readRequest: q } = value;
    if (q.principalId !== c.session.principalId || q.sessionId !== c.session.sessionId || q.hostId !== c.session.hostId
      || (c.scope.kind === 'personal' ? q.organizationId !== null : q.organizationId !== c.scope.organizationId)
      || (c.nativePolicyRevision !== null && q.permissionRevision !== c.nativePolicyRevision)
      || (c.target !== null && (q.oneId !== c.target.oneId || q.resourceId !== `${c.target.spaceId}:${c.target.pageId}` || q.projectId !== c.target.projectId || q.audience !== c.target.audience))) return false;
    const ids = new Set<string>();
    for (const entry of value.entries) {
      if (!businessOnlyKeys(entry, ['entryId', 'sourceRef', 'revision']) || !isBusinessId(entry.entryId) || !isBusinessId(entry.sourceRef) || !isBusinessId(entry.revision)
        || ids.has(entry.entryId) || !q.sourceRefs.includes(entry.sourceRef)) return false;
      ids.add(entry.entryId);
    }
    return true;
  } catch { return false; }
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return redactSecrets(value).replace(/(?:\/Users\/[^\s]+|\/home\/[^\s]+|[A-Za-z]:\\Users\\[^\s]+)/g, '[로컬 경로]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
    .replace(/\b(?:\+?82[- ]?)?0?1[016789][- ]?\d{3,4}[- ]?\d{4}\b/g, '[전화번호]')
    .replace(/\b\d{6}[- ]?[1-8]\d{6}\b/g, '[민감 번호]').replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function projectBusinessHistoryTimeline(state: ComputerHistoryState, binding: BusinessHistoryViewBinding): readonly BusinessHistoryTimelineEntry[] {
  if (!businessOnlyKeys(state, ['schemaVersion', 'consent', 'entries', 'generatedAt']) || state.schemaVersion !== 1 || !['on', 'off'].includes(state.consent)
    || !isBusinessNativeArray(state.entries, 160) || state.consent !== 'on') return [];
  const allowed = new Map(binding.entries.map(entry => [entry.entryId, entry]));
  const seen = new Set<string>(); const output: BusinessHistoryTimelineEntry[] = [];
  for (const entry of state.entries) {
    if (!businessOnlyKeys(entry, ['id', 'occurredAt', 'title', 'body', 'apps', 'source', 'recommendation']) || !isBusinessId(entry.id)
      || !allowed.has(entry.id) || seen.has(entry.id) || typeof entry.occurredAt !== 'string' || !Number.isFinite(Date.parse(entry.occurredAt))
      || !isBusinessNativeArray(entry.apps, 32) || !['10min', '6h'].includes(entry.source)) continue;
    seen.add(entry.id);
    let recommendation: BusinessHistoryTimelineEntry['recommendation'] = null;
    const rec = entry.recommendation;
    if (rec && businessOnlyKeys(rec, ['id', 'kind', 'title', 'body', 'evidence', 'status']) && isBusinessId(rec.id)
      && ['agent', 'plugin', 'graph'].includes(rec.kind) && ['draft', 'dismissed', 'accepted'].includes(rec.status)
      && isBusinessNativeArray(rec.evidence, 64) && rec.evidence.length > 0
      && rec.evidence.every(e => businessOnlyKeys(e, ['entryId', 'label', 'occurredAt', 'source']) && isBusinessId(e.entryId) && allowed.has(e.entryId))) {
      recommendation = { id: rec.id, kind: rec.kind, title: text(rec.title, 160), summary: text(rec.body, 480), evidenceCount: rec.evidence.length, status: rec.status };
    }
    output.push({ id: entry.id, revision: allowed.get(entry.id)!.revision, occurredAt: entry.occurredAt, title: text(entry.title, 160), summary: text(entry.body, 480),
      applications: [...new Set(entry.apps.filter(isBusinessId))], bucket: entry.source, recommendation });
  }
  return freeze(output.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)));
}
function candidateStatus(value: unknown): value is BusinessHistoryCandidateStatus {
  return typeof value === 'string' && BUSINESS_HISTORY_CANDIDATE_STATUSES.includes(value as BusinessHistoryCandidateStatus);
}
function candidateKind(value: unknown): value is Exclude<BusinessHistoryCandidateView['kind'], null> {
  return typeof value === 'string' && ['skill', 'toolchain', 'agent'].includes(value);
}
export function projectBusinessHistoryCandidates(snapshot: unknown, b: BusinessHistoryViewBinding): readonly BusinessHistoryCandidateView[] {
  if (!businessOnlyKeys(snapshot, ['schema', 'target', 'candidates']) || snapshot.schema !== BUSINESS_HISTORY_ONE_WIRE_SCHEMA
    || businessNativeActionMetadataDigest(snapshot.target) !== businessNativeActionMetadataDigest(b.context.target) || !isBusinessNativeArray(snapshot.candidates, 160)) return [];
  const output: BusinessHistoryCandidateView[] = [];
  const ids = new Set<string>();
  for (const c of snapshot.candidates) {
    if (!businessOnlyKeys(c, ['schema', 'candidateId', 'target', 'revision', 'status', 'observations', 'envelope', 'draft', 'evaluation', 'generationCommandId', 'runCommandId', 'anchor', 'feedback', 'predecessorId', 'createdAt', 'reason'])
      || c.schema !== BUSINESS_HISTORY_ONE_WIRE_SCHEMA || !isBusinessId(c.candidateId) || !isBusinessRevision(c.revision) || ids.has(c.candidateId) || !candidateStatus(c.status)
      || !targetValid(c.target) || businessNativeActionMetadataDigest(c.target) !== businessNativeActionMetadataDigest(b.context.target)
      || !isBusinessNativeArray(c.observations, 160)) continue;
    const sourceRefs: string[] = [];
    for (const o of c.observations) {
      if (!businessOnlyKeys(o, ['id', 'revision', 'sourceId', 'sourceRef', 'observedAt', 'permissionRevision', 'consentRevision', 'environmentRevision', 'interface', 'summary', 'sensitiveFieldsRemoved'])
        || !isBusinessId(o.sourceRef) || !b.readRequest.sourceRefs.includes(o.sourceRef) || o.sensitiveFieldsRemoved !== true) break;
      sourceRefs.push(o.sourceRef);
    }
    if (sourceRefs.length !== c.observations.length) continue;
    ids.add(c.candidateId);
    const draft = c.draft && businessOnlyKeys(c.draft, ['kind', 'assetId', 'versionId', 'digest', 'producer', 'proposalRef', 'process', 'toolRefs', 'resourceRefs', 'changeRefs'])
      && candidateKind(c.draft.kind) && isBusinessId(c.draft.versionId) && typeof c.draft.digest === 'string' && /^[a-f0-9]{64}$/.test(c.draft.digest) ? c.draft : null;
    const evaluation = c.evaluation && businessOnlyKeys(c.evaluation, ['draftDigest', 'envelopeDigest', 'oracleId', 'oracleRevision', 'fixtureDigest', 'resultDigest', 'passed', 'isolated', 'networkAccess', 'providerCalls']) ? c.evaluation : null;
    const envelope = businessOnlyKeys(c.envelope, ['policyRevision', 'sourceIds', 'toolRefs', 'resourceRefs', 'budgetId', 'maxObservations', 'retentionMs', 'allowedKinds', 'automaticPromotion'])
      && isBusinessId(c.envelope.policyRevision) && [c.envelope.sourceIds, c.envelope.toolRefs, c.envelope.resourceRefs, c.envelope.allowedKinds].every(v => isBusinessNativeArray(v))
      && c.envelope.automaticPromotion === false ? c.envelope : null;
    const exactEvaluation = draft && envelope && evaluation && evaluation.envelopeDigest === businessNativeActionMetadataDigest(envelope)
      && evaluation.draftDigest === draft.digest && evaluation.isolated === true
      && evaluation.networkAccess === false && evaluation.providerCalls === 0 && typeof evaluation.passed === 'boolean';
    output.push({ id: c.candidateId, revision: c.revision, status: c.status, kind: draft && candidateKind(draft.kind) ? draft.kind : null,
      proposalVersion: draft && isBusinessId(draft.versionId) ? draft.versionId : null, proposalDigest: draft && typeof draft.digest === 'string' ? draft.digest : null,
      evaluation: exactEvaluation ? evaluation!.passed ? 'passed' : 'failed' : 'unknown', observationCount: sourceRefs.length, sourceRefs });
  }
  return freeze(output);
}
const capabilityKeys: BusinessHistoryViewCapability[] = ['timeline', 'search', 'evolution', 'reviewRecommendation', 'pauseCollection', 'deleteHistory', 'openPage', 'openCandidate'];
const unavailableSnapshot = (reason: BusinessHistoryViewSnapshot['reason']): BusinessHistoryViewSnapshot => freeze({ schema: BUSINESS_HISTORY_VIEW_SCHEMA, context: null,
  status: reason === 'current_context_required' || reason === 'native_authority_unbound' ? 'blocked' : 'unknown', reason,
  availability: Object.fromEntries(capabilityKeys.map(key => [key, false])) as Record<BusinessHistoryViewCapability, boolean>,
  collection: 'unknown', analysis: 'unknown', retentionMs: null, entries: [], candidates: [], unavailable: [] });
export function isBusinessHistorySearchRequest(value: unknown, now = Date.now()): value is BusinessHistorySearchRequest {
  try {
    if (!businessOnlyKeys(value, ['context', 'expectedHistoryRevision', 'entryRevisions', 'query', 'filter'])
      || !isBusinessHistoryViewContext(value.context, now) || value.expectedHistoryRevision !== value.context.revision
      || !isBusinessId(value.expectedHistoryRevision) || typeof value.query !== 'string' || value.query.trim().length < 1 || value.query.length > 200
      || /[\u0000-\u001f\u007f]/.test(value.query) || looksSecret(value.query) || redactSecrets(value.query) !== value.query
      || value.query.trim().split(/\s+/u).length > 16 || !isBusinessHistoryFilter(value.filter, now) || !isBusinessNativeArray(value.entryRevisions, 160)) return false;
    const ids = new Set<string>();
    for (const entry of value.entryRevisions) {
      if (!businessOnlyKeys(entry, ['entryId', 'revision']) || !isBusinessId(entry.entryId) || !isBusinessId(entry.revision) || ids.has(entry.entryId)) return false;
      ids.add(entry.entryId);
    }
    return true;
  } catch { return false; }
}
const blockedSearch = (): BusinessHistorySearchResult => freeze({ schema: BUSINESS_HISTORY_SEARCH_SCHEMA, state: 'blocked',
  context: null, historyRevision: null, filter: null, citations: [] });
export function isBusinessHistoryDeleteRequest(value: unknown, now = Date.now()): value is BusinessHistoryDeleteRequest {
  try {
    if (!businessOnlyKeys(value, ['context', 'expectedHistoryRevision', 'expectedPolicyRevision', 'filter'])
      || !isBusinessHistoryViewContext(value.context, now) || !isBusinessId(value.expectedHistoryRevision)
      || value.expectedHistoryRevision !== value.context.revision || !isBusinessRevision(value.expectedPolicyRevision)
      || value.expectedPolicyRevision !== value.context.policyRevision || !businessOnlyKeys(value.filter, ['kind', 'before'])) return false;
    const f = value.filter;
    return f.kind === 'scope' ? f.before === null : f.kind === 'before' && typeof f.before === 'string'
      && f.before.length <= 40 && Number.isFinite(Date.parse(f.before)) && Date.parse(f.before) <= now
      && new Date(f.before).toISOString() === f.before;
  } catch { return false; }
}
function deleteReference(value: unknown): value is BusinessHistoryDeleteReference {
  return businessOnlyKeys(value, ['intentId', 'intentRevision', 'idempotencyKey', 'requestDigest'])
    && [value.intentId, value.intentRevision, value.idempotencyKey].every(isBusinessId)
    && typeof value.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(value.requestDigest);
}
function validDeleteIntent(value: unknown, request: BusinessHistoryDeleteRequest, now: number): value is BusinessHistoryDeleteIntent {
  try {
    if (!businessOnlyKeys(value, ['protocol', 'originalIntent', 'request', 'collection', 'query']) || value.protocol !== BUSINESS_HISTORY_DELETE_PROTOCOL
      || !deleteReference(value.originalIntent) || !isBusinessHistoryDeleteRequest(value.request, now) || !isBusinessResource(value.collection)
      || !businessOnlyKeys(value.query, ['schema', 'deploymentId', 'organizationId', 'hostId', 'action', 'purpose', 'projectId', 'taskId', 'runId', 'controlVersion', 'occurrenceId', 'resources', 'providerBindingId', 'operationId', 'region', 'credentialRef', 'credentialGeneration', 'charge'])
      || !isBusinessNativeArray(value.query.resources, 64) || !isBusinessQuery(value.query) || businessNativeActionMetadataDigest(value.request) !== businessNativeActionMetadataDigest(request)
      || value.originalIntent.requestDigest !== businessNativeActionMetadataDigest(request)) return false;
    const { query: q, collection, request: r } = value;
    return q.action === 'history.delete' && q.purpose === 'history-privacy-delete' && q.deploymentId === r.context.session.deploymentId
      && q.organizationId === r.context.session.organizationId && q.hostId === r.context.session.hostId
      && q.projectId === (r.context.target?.projectId ?? undefined) && sameBusinessScope(collection.scope, r.context.scope)
      && q.resources.length === 1 && sameBusinessResource(q.resources[0], collection)
      && q.providerBindingId === undefined && q.operationId === undefined && q.region === undefined
      && q.credentialRef === undefined && q.credentialGeneration === undefined && q.charge === undefined;
  } catch { return false; }
}
function deleteEpoch(epoch: unknown, intent: BusinessHistoryDeleteIntent, now: number): epoch is BusinessEpoch {
  if (!isBusinessEpoch(epoch)) return false;
  const s = intent.request.context.session;
  return epoch.queryDigest === desktopBusinessQueryDigest(intent.query) && epoch.principalId === s.principalId && epoch.sessionId === s.sessionId
    && epoch.sessionRevision === s.sessionRevision && epoch.authEpoch === s.authEpoch && epoch.identityAuthorityId === s.identityAuthorityId
    && epoch.deploymentId === s.deploymentId && epoch.organizationId === s.organizationId && epoch.hostId === s.hostId
    && Date.parse(epoch.expiresAt) > now && Date.parse(epoch.expiresAt) <= Date.parse(s.expiresAt);
}
function deleteFallback(request: BusinessHistoryDeleteRequest | null, originalIntent: BusinessHistoryDeleteReference | null,
  state: BusinessHistoryDeleteReceipt['state']): BusinessHistoryDeleteReceipt {
  const safe = businessOnlyKeys(request, ['context', 'expectedHistoryRevision', 'expectedPolicyRevision', 'filter']) ? request : null;
  const c = safe?.context;
  return freeze({ protocol: BUSINESS_HISTORY_DELETE_PROTOCOL, state, originalIntent,
    contextRevision: c && businessOnlyKeys(c, ['session', 'scope', 'target', 'bindingKey', 'revision', 'policyRevision', 'nativePolicyRevision', 'expiresAt']) && isBusinessId(c.revision) ? c.revision : 'invalid-context',
    previousHistoryRevision: isBusinessId(safe?.expectedHistoryRevision) ? safe!.expectedHistoryRevision : 'invalid-history',
    previousPolicyRevision: isBusinessRevision(safe?.expectedPolicyRevision) ? safe!.expectedPolicyRevision : 0,
    historyRevision: null, policyRevision: null, deletedCount: null });
}
function deleteReceipt(value: unknown, request: BusinessHistoryDeleteRequest, original: BusinessHistoryDeleteReference): BusinessHistoryDeleteReceipt {
  const fallback = (): BusinessHistoryDeleteReceipt => deleteFallback(request, original, 'unknown');
  if (!businessOnlyKeys(value, ['protocol', 'state', 'originalIntent', 'contextRevision', 'previousHistoryRevision', 'previousPolicyRevision', 'historyRevision', 'policyRevision', 'deletedCount'])
    || value.protocol !== BUSINESS_HISTORY_DELETE_PROTOCOL || !deleteReference(value.originalIntent)
    || businessNativeActionMetadataDigest(value.originalIntent) !== businessNativeActionMetadataDigest(original)
    || value.contextRevision !== request.context.revision || value.previousHistoryRevision !== request.expectedHistoryRevision
    || value.previousPolicyRevision !== request.expectedPolicyRevision || !['applied', 'denied', 'unknown'].includes(value.state as string)) return fallback();
  if (value.state === 'applied' ? !isBusinessId(value.historyRevision) || !isBusinessRevision(value.policyRevision)
    || value.policyRevision < request.expectedPolicyRevision || !isBusinessRevision(value.deletedCount)
    || value.deletedCount > 0 && value.historyRevision === request.expectedHistoryRevision
    : value.historyRevision !== null || value.policyRevision !== null || value.deletedCount !== null) return fallback();
  return freeze(value as unknown as BusinessHistoryDeleteReceipt);
}

/** Reuses actual read APIs. No collection activation, raw history store, fixture fallback,
 * authority minting, new queue or native registrar is implemented here. */
export function createBusinessHistoryViewAdapter(input: BusinessHistoryViewAdapterPorts, now: () => number = Date.now): BusinessHistoryPanelPort {
  const ports = Object.freeze({ ...input });
  const privacy = ports.privacyDelete?.protocol === BUSINESS_HISTORY_DELETE_PROTOCOL && ['currentContext', 'prepare', 'stillCurrent', 'commit', 'receipt'].every(key =>
    typeof ports.privacyDelete?.[key as 'currentContext'] === 'function') && typeof ports.privacyDelete.authority?.currentDecision === 'function'
    && typeof ports.privacyDelete.authority.stillCurrent === 'function' ? ports.privacyDelete : null;
  async function privacyContext(expected?: BusinessHistoryViewContext): Promise<BusinessHistoryViewContext | null> {
    try {
      const current = await privacy?.currentContext();
      if (!isBusinessHistoryViewContext(current, now()) || current.policyRevision === null) return null;
      const exact = freeze(current);
      return !expected || businessNativeActionMetadataDigest(exact) === businessNativeActionMetadataDigest(expected) ? exact : null;
    } catch { return null; }
  }
  async function blockedRead(reason: BusinessHistoryViewSnapshot['reason']): Promise<BusinessHistoryViewSnapshot> {
    const context = await privacyContext();
    const base = unavailableSnapshot(reason);
    // Deletion metadata can remain available after source-read revocation. No
    // contents, read grant, or collector consent are inferred from this port.
    return freeze({ ...base, context, availability: { ...base.availability, deleteHistory: !!context }, unavailable: privacy ? [] : ['privacy_delete'] });
  }
  interface DeleteRecord { request: BusinessHistoryDeleteRequest; original: BusinessHistoryDeleteReference | null; receipt: BusinessHistoryDeleteReceipt | null; pending: Promise<BusinessHistoryDeleteReceipt> | null }
  // Bounded, value-only pending/uncertain operation metadata. Durable idempotency
  // is the source owner's responsibility; these records never cache an allow.
  const deletions = new Map<string, DeleteRecord>();
  async function deleteHistory(action: BusinessHistoryDeleteRequest): Promise<BusinessHistoryDeleteReceipt> {
    if (!isBusinessHistoryDeleteRequest(action, now()) || !privacy) return deleteFallback(action, null, 'denied');
    const request = freeze(action); const key = businessNativeActionMetadataDigest(request);
    const previous = deletions.get(key);
    if (previous) return previous.pending ?? previous.receipt ?? deleteFallback(request, previous.original, 'unknown');
    if (deletions.size >= 128) return deleteFallback(request, null, 'denied');
    const record: DeleteRecord = { request, original: null, receipt: null, pending: null };
    deletions.set(key, record);
    record.pending = (async () => {
      let effectStarted = false;
      try {
        if (!await privacyContext(request.context)) return deleteFallback(request, null, 'denied');
        const issued = await privacy.prepare(request);
        if (!validDeleteIntent(issued, request, now())) return deleteFallback(request, null, 'denied');
        const intent = freeze(issued); record.original = intent.originalIntent;
        if (await privacy.stillCurrent(intent) !== true || !await privacyContext(request.context)) return deleteFallback(request, record.original, 'denied');
        const decision = await privacy.authority.currentDecision(intent.query, request.context.session);
        if (!businessOnlyKeys(decision, ['schema', 'verdict', 'reason', 'epoch', 'expiresAt']) || decision.schema !== BUSINESS_AUTHORITY_SCHEMA
          || decision.verdict !== 'allow' || decision.reason !== 'allowed' || !deleteEpoch(decision.epoch, intent, now())
          || decision.expiresAt !== decision.epoch.expiresAt) return deleteFallback(request, record.original, 'denied');
        const epoch = freeze(decision.epoch);
        if (await privacy.authority.stillCurrent(epoch) !== true || await privacy.stillCurrent(intent) !== true
          || !await privacyContext(request.context) || !isBusinessHistoryDeleteRequest(request, now())) return deleteFallback(request, record.original, 'denied');
        // The source owner MUST repeat all these bindings atomically with the
        // effect. Passing an async allow above cannot substitute for that domain.
        effectStarted = true;
        return deleteReceipt(await privacy.commit(freeze({ protocol: BUSINESS_HISTORY_DELETE_PROTOCOL, intent, epoch })), request, intent.originalIntent);
      } catch { return deleteFallback(request, record.original, effectStarted ? 'unknown' : 'denied'); }
    })();
    record.receipt = await record.pending; record.pending = null;
    return record.receipt;
  }
  async function reconcileDelete(action: { request: BusinessHistoryDeleteRequest; originalIntent: BusinessHistoryDeleteReference }): Promise<BusinessHistoryDeleteReceipt> {
    if (!businessOnlyKeys(action, ['request', 'originalIntent'])) return deleteFallback(null, null, 'denied');
    if (!isBusinessHistoryDeleteRequest(action.request, 0) || !deleteReference(action.originalIntent) || !privacy) return deleteFallback(action.request, null, 'denied');
    const exact = freeze(action); const key = businessNativeActionMetadataDigest(exact.request);
    if (exact.originalIntent.requestDigest !== key) return deleteFallback(exact.request, null, 'denied');
    // Current session/scope verification is independent of the old read grant.
    // Allow a changed history/policy revision after deletion, but not a new actor,
    // deployment, identity authority, organization, host or target.
    const current = await privacyContext(); const before = exact.request.context;
    if (!current || !sameBusinessSession(current.session, before.session) || !sameBusinessScope(current.scope, before.scope)
      || current.bindingKey !== before.bindingKey || businessNativeActionMetadataDigest(current.target) !== businessNativeActionMetadataDigest(before.target)) return deleteFallback(exact.request, exact.originalIntent, 'unknown');
    const record = deletions.get(key);
    if (record?.original && businessNativeActionMetadataDigest(record.original) !== businessNativeActionMetadataDigest(exact.originalIntent)) return deleteFallback(exact.request, null, 'denied');
    if (record?.pending) return record.pending;
    try {
      const receipt = deleteReceipt(await privacy.receipt(exact), exact.request, exact.originalIntent);
      if (record) record.receipt = receipt;
      return receipt;
    } catch { return deleteFallback(exact.request, exact.originalIntent, 'unknown'); }
  }
  async function binding(expected?: BusinessHistoryViewContext): Promise<BusinessHistoryViewBinding | null> {
    const read = await ports.owner?.current();
    if (!validBinding(read, now())) return null;
    const exact = freeze(read);
    if (expected && (businessNativeActionMetadataDigest(exact.context) !== businessNativeActionMetadataDigest(expected)
      || !sameBusinessSession(exact.context.session, expected.session) || !sameBusinessScope(exact.context.scope, expected.scope))) return null;
    return await ports.owner!.stillCurrent(exact) === true ? exact : null;
  }
  async function permitted<T>(b: BusinessHistoryViewBinding, operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    if (!ports.authority || await ports.owner!.stillCurrent(b) !== true) throw Error('business_history_current_required');
    const grant = await ports.authority.prepareCurrentAction(b.readRequest);
    const current = (): boolean => grant.decision === 'allow' && grant.stillCurrent() === true && ports.authority!.actionAuthority.current(b.readRequest).decision === 'allow';
    const assertCurrent = (): void => { if (!current()) throw Error('business_history_permission_changed'); };
    try {
      if (!current() || await ports.owner!.stillCurrent(b) !== true || !current()) throw Error('business_history_permission_changed');
      const value = await operation(assertCurrent);
      if (!current() || await ports.owner!.stillCurrent(b) !== true || !current()) throw Error('business_history_permission_changed');
      return value;
    } finally { grant.release(); }
  }
  async function search(action: BusinessHistorySearchRequest): Promise<BusinessHistorySearchResult> {
    if (!isBusinessHistorySearchRequest(action, now()) || !ports.owner || !ports.authority) return blockedSearch();
    const request = freeze(action);
    try {
      const b = await binding(request.context); if (!b) return blockedSearch();
      const source = b.context.scope.kind === 'personal' ? ports.personalHistory ? () => ports.personalHistory!.get() : null
        : ports.organizationHistory ? () => ports.organizationHistory!.read(b) : null;
      if (!source) return blockedSearch();
      return await permitted(b, async assertCurrent => {
        const state = await source(); assertCurrent();
        const entries = projectBusinessHistoryTimeline(state, b);
        const revisions = [...entries].map(entry => ({ entryId: entry.id, revision: entry.revision })).sort((a, z) => a.entryId.localeCompare(z.entryId));
        const expected = [...request.entryRevisions].sort((a, z) => a.entryId.localeCompare(z.entryId));
        if (businessNativeActionMetadataDigest(revisions) !== businessNativeActionMetadataDigest(expected)) throw Error('business_history_entries_changed');
        const terms = request.query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u);
        const citations: BusinessHistoryEvidenceCitation[] = [];
        // Search only the already redacted display title/summary. Draft prompts,
        // raw observations, private diffs and inference/provider APIs are absent.
        for (const entry of filterBusinessHistoryTimeline(entries, request.filter, now())) {
          const display = `${entry.title} ${entry.summary}`;
          const normalized = display.normalize('NFKC').toLocaleLowerCase();
          if (!terms.every(term => normalized.includes(term))) continue;
          const at = normalized.indexOf(terms[0]); const start = Math.max(0, at - 64);
          citations.push({ entryId: entry.id, entryRevision: entry.revision, occurredAt: entry.occurredAt, title: entry.title,
            excerpt: text(`${start ? '…' : ''}${display.slice(start, start + 256)}${start + 256 < display.length ? '…' : ''}`, 280) });
          if (citations.length >= 20) break;
        }
        const final = await binding(request.context);
        if (!final || businessNativeActionMetadataDigest(final) !== businessNativeActionMetadataDigest(b)
          || !isBusinessHistorySearchRequest(request, now())) throw Error('business_history_permission_changed');
        assertCurrent();
        return freeze({ schema: BUSINESS_HISTORY_SEARCH_SCHEMA, state: citations.length ? 'matched' : 'no-evidence', context: b.context,
          historyRevision: b.context.revision, filter: request.filter, citations } as BusinessHistorySearchResult);
      });
    } catch { return blockedSearch(); }
  }
  async function read(): Promise<BusinessHistoryViewSnapshot> {
    if (!ports.owner) return blockedRead('current_context_required');
    if (!ports.authority) return blockedRead('native_authority_unbound');
    try {
      const b = await binding(); if (!b) return blockedRead('current_context_required');
      const unavailable: BusinessHistoryViewSnapshot['unavailable'][number][] = [];
      let entries: readonly BusinessHistoryTimelineEntry[] = []; let candidates: readonly BusinessHistoryCandidateView[] = [];
      let timeline = false; let evolution = false;
      const source = b.context.scope.kind === 'personal' ? ports.personalHistory ? () => ports.personalHistory!.get() : null
        : ports.organizationHistory ? () => ports.organizationHistory!.read(b) : null;
      if (source) {
        try { entries = projectBusinessHistoryTimeline(await permitted(b, source), b); timeline = true; }
        catch { unavailable.push(b.context.scope.kind === 'personal' ? 'personal_timeline' : 'organization_timeline'); }
      }
      else unavailable.push(b.context.scope.kind === 'personal' ? 'personal_timeline' : 'organization_timeline');
      if (ports.one && b.context.target) {
        try {
        const snapshot = await permitted(b, async assertCurrent => {
          const before = await ports.one!.bootstrap();
          if (before.state !== 'ready' || before.bindingKey !== b.context.bindingKey || businessNativeActionMetadataDigest(before.target) !== businessNativeActionMetadataDigest(b.context.target)) throw Error('business_history_target_changed');
          assertCurrent();
          const value = await ports.one!.historySnapshot({ target: b.context.target! });
          assertCurrent();
          const after = await ports.one!.bootstrap();
          if (!businessOnlyKeys(value, ['schema', 'target', 'candidates']) || value.schema !== BUSINESS_HISTORY_ONE_WIRE_SCHEMA
            || after.state !== 'ready' || after.bindingKey !== b.context.bindingKey || businessNativeActionMetadataDigest(after.target) !== businessNativeActionMetadataDigest(b.context.target)
            || businessNativeActionMetadataDigest(value.target) !== businessNativeActionMetadataDigest(b.context.target)) throw Error('business_history_target_changed');
          return value;
        });
        candidates = projectBusinessHistoryCandidates(snapshot, b);
        evolution = true;
        } catch { unavailable.push('one_history'); }
      } else unavailable.push('one_history');
      if (!ports.controls) unavailable.push('owner_controls');
      const deletionContext = await privacyContext(b.context);
      if (!deletionContext) unavailable.push('privacy_delete');
      if (!ports.review || !ports.personalHistory?.prepareDraft) unavailable.push('native_review');
      if (await ports.owner.stillCurrent(b) !== true) return blockedRead('permission_changed');
      return freeze({ schema: BUSINESS_HISTORY_VIEW_SCHEMA, context: b.context, status: timeline || evolution ? 'current' : 'blocked', reason: timeline || evolution ? 'current' : 'read_unavailable',
        availability: { timeline, search: timeline, evolution, reviewRecommendation: timeline && b.context.scope.kind === 'personal' && !!ports.personalHistory?.prepareDraft && !!ports.review,
          pauseCollection: b.context.policyRevision !== null && !!ports.controls, deleteHistory: !!deletionContext,
          openPage: !!b.context.target && !!ports.navigation?.openPage, openCandidate: evolution && !!ports.navigation?.openCandidate },
        collection: b.collection, analysis: b.analysis, retentionMs: b.retentionMs, entries, candidates, unavailable });
    } catch { return blockedRead('read_unavailable'); }
  }
  const refusedControl = (context: BusinessHistoryViewContext, revision: number): BusinessHistoryControlReceipt => freeze({ state: 'denied',
    contextRevision: context && businessOnlyKeys(context, ['session', 'scope', 'target', 'bindingKey', 'revision', 'policyRevision', 'nativePolicyRevision', 'expiresAt']) && isBusinessId(context.revision) ? context.revision : 'invalid-context',
    previousPolicyRevision: isBusinessRevision(revision) ? revision : 0, policyRevision: null });
  function controlReceipt(value: BusinessHistoryControlReceipt, c: BusinessHistoryViewContext, expected: number): BusinessHistoryControlReceipt {
    if (!businessOnlyKeys(value, ['state', 'contextRevision', 'previousPolicyRevision', 'policyRevision']) || value.contextRevision !== c.revision
      || value.previousPolicyRevision !== expected || !['applied', 'denied', 'unknown'].includes(value.state)
      || (value.state === 'applied' ? !isBusinessRevision(value.policyRevision) || value.policyRevision <= expected : value.policyRevision !== null)) {
      return freeze({ ...refusedControl(c, expected), state: 'unknown' });
    }
    return freeze(value);
  }
  return Object.freeze({ read, search: ports.owner && ports.authority ? search : undefined,
    subscribeInvalidation: ports.owner?.subscribeInvalidation ? (listener: () => void) => ports.owner!.subscribeInvalidation!(listener) : undefined,
    async reviewRecommendation(action) {
      const b = await binding(action.context);
      if (!b || b.context.scope.kind !== 'personal' || !ports.personalHistory?.prepareDraft || !ports.review
        || !b.entries.some(e => e.entryId === action.entryId && e.revision === action.expectedEntryRevision) || !isBusinessId(action.recommendationId)) throw Error('business_history_review_unavailable');
      await permitted(b, async assertCurrent => {
        const state = await ports.personalHistory!.get();
        const visible = projectBusinessHistoryTimeline(state, b).find(e => e.id === action.entryId);
        if (visible?.recommendation?.id !== action.recommendationId) throw Error('business_history_recommendation_changed');
        assertCurrent();
        const draft = await ports.personalHistory!.prepareDraft!(action.recommendationId, 'ko');
        if (!businessOnlyKeys(draft, ['recommendationId', 'recommendationKind', 'prompt', 'evidenceCount']) || draft.recommendationId !== action.recommendationId
          || draft.recommendationKind !== visible.recommendation.kind || typeof draft.prompt !== 'string' || draft.prompt.length > 100000
          || !isBusinessRevision(draft.evidenceCount)) throw Error('business_history_recommendation_changed');
        if (await ports.owner!.stillCurrent(b) !== true) throw Error('business_history_permission_changed');
        assertCurrent();
        await ports.review!.open({ context: b.context, draft: freeze({ ...draft, prompt: redactSecrets(draft.prompt) }) });
      });
    },
    async pauseCollection(action) {
      // Only the actual owner stop callback can implement this exact bounded control.
      // Forward it independently of read/grant readiness; do not call global setConsent.
      if (!ports.controls || !isBusinessHistoryViewContext(action.context, 0) || !isBusinessRevision(action.expectedPolicyRevision)
        || action.context.policyRevision !== action.expectedPolicyRevision) return refusedControl(action.context, action.expectedPolicyRevision);
      try { return controlReceipt(await ports.controls.pause(freeze(action)), action.context, action.expectedPolicyRevision); }
      catch { return freeze({ ...refusedControl(action.context, action.expectedPolicyRevision), state: 'unknown' }); }
    },
    deleteHistory, reconcileDelete,
    async openPage(action) {
      const b = await binding(action.context); if (!b || !b.context.target || !ports.navigation?.openPage) throw Error('business_history_page_unavailable');
      await permitted(b, () => ports.navigation!.openPage!({ context: b.context }));
    },
    async openCandidate(action) {
      const b = await binding(action.context); if (!b || !ports.one || !b.context.target || !ports.navigation?.openCandidate || !isBusinessId(action.candidateId) || !isBusinessRevision(action.expectedRevision)) throw Error('business_history_candidate_unavailable');
      await permitted(b, async assertCurrent => {
        const snapshot = await ports.one!.historySnapshot({ target: b.context.target! });
        if (!projectBusinessHistoryCandidates(snapshot, b).some(c => c.id === action.candidateId && c.revision === action.expectedRevision)) throw Error('business_history_candidate_changed');
        if (await ports.owner!.stillCurrent(b) !== true) throw Error('business_history_permission_changed');
        assertCurrent();
        await ports.navigation!.openCandidate!(freeze(action));
      });
    },
  } satisfies BusinessHistoryPanelPort);
}
