/** Main/renderer value-only console contract. Metadata never grants execution.
 * No UI, browser, network, session producer, native registration or queue dependency. */
import { businessOnlyKeys, isBusinessId, isBusinessRevision, isBusinessSession, sameBusinessSession, type BusinessSession, type BusinessExactStop } from './context';
import type { BusinessHistoryPanelPort, BusinessHistoryViewContext } from './history-view';
import type { BusinessOrganizationExecutionPanelPort } from './organization-execution';
import { isBusinessNativeArray } from './native-registry';
import { looksSecret } from '../secret-patterns';
import type { BusinessEligibility } from './eligibility';

export interface BusinessAccountSnapshot {
  session: BusinessSession | null;
  organizations: Array<{ id: string; label: string; membership: 'active' | 'invited' | 'suspended'; roles: string[] }>;
  providers: Array<{ id: string; label: string; state: 'unconfigured' | 'stored-unverified' | 'verified' | 'disabled' | 'expired' | 'unknown'; generation: number }>;
  /** Display readiness only. Main still performs the current action/resource check. */
  adminViews: Array<'members' | 'providers' | 'tools' | 'audit'>;
  status: 'current' | 'offline' | 'unknown';
}
export interface BusinessAccountPanelPort {
  read(): Promise<BusinessAccountSnapshot>;
  subscribeInvalidation?(listener: () => void): () => void;
  signIn(): Promise<BusinessAccountSnapshot>;
  joinOrganization(input: { organizationId: string; expectedSessionId: string; expectedSessionRevision: number }): Promise<BusinessAccountSnapshot>;
  selectOrganization(input: { organizationId: string; expectedSessionId: string; expectedSessionRevision: number; expectedAuthEpoch: number }): Promise<BusinessAccountSnapshot>;
  logout(input: { sessionId: string; expectedSessionRevision: number }): Promise<{ snapshot: BusinessAccountSnapshot; remote: 'confirmed' | 'unknown' }>;
  openAdmin(input: { organizationId: string; view: BusinessAccountSnapshot['adminViews'][number]; expectedSessionId: string; expectedSessionRevision: number }): Promise<void>;
  selectPersonal(): Promise<void>;
}

export function isBusinessAccountSnapshot(value: unknown): value is BusinessAccountSnapshot {
  const label = (v: unknown): v is string => typeof v === 'string' && v.length <= 200 && !looksSecret(v) && !/[\u0000-\u001f\u007f]/.test(v);
  try {
    return isBusinessConsoleMetadata(value) && businessOnlyKeys(value, ['session', 'organizations', 'providers', 'adminViews', 'status'])
      && (value.session === null || isBusinessSession(value.session)) && ['current', 'offline', 'unknown'].includes(value.status as string)
      && isBusinessNativeArray(value.organizations, 256)
      && value.organizations.every(v => businessOnlyKeys(v, ['id', 'label', 'membership', 'roles']) && isBusinessId(v.id) && label(v.label)
        && ['active', 'invited', 'suspended'].includes(v.membership as string) && isBusinessNativeArray(v.roles, 32) && v.roles.every(isBusinessId))
      && new Set(value.organizations.map(v => (v as { id: string }).id)).size === value.organizations.length
      && isBusinessNativeArray(value.providers, 256)
      && value.providers.every(v => businessOnlyKeys(v, ['id', 'label', 'state', 'generation']) && isBusinessId(v.id) && label(v.label)
        && ['unconfigured', 'stored-unverified', 'verified', 'disabled', 'expired', 'unknown'].includes(v.state as string) && isBusinessRevision(v.generation))
      && new Set(value.providers.map(v => (v as { id: string }).id)).size === value.providers.length
      && isBusinessNativeArray(value.adminViews, 4) && value.adminViews.every(v => ['members', 'providers', 'tools', 'audit'].includes(v as string))
      && new Set(value.adminViews).size === value.adminViews.length;
  } catch { return false; }
}


/** Canonical numeric revisions and opaque owner revisions are distinct exact values. */
export type BusinessLearningBaseRevision = number | string;
export function isBusinessLearningBaseRevision(value: unknown): value is BusinessLearningBaseRevision {
  return isBusinessRevision(value) || isBusinessId(value);
}
export interface BusinessLearningCandidateView {
  id: string;
  revision: number;
  controlRevision: number;
  label: string;
  currentVersion: string | null;
  baseRevision: BusinessLearningBaseRevision;
  proposalDigest: string | null;
  state: 'candidate' | 'draft' | 'review-ready' | 'active' | 'paused' | 'revoked' | 'unknown';
  validation: 'passed' | 'failed' | 'unknown';
  sourceStatus: 'allowed' | 'paused' | 'revoked' | 'unknown';
  stopTarget: Pick<BusinessExactStop, 'hostId' | 'taskId' | 'runId' | 'controlVersion'> | null;
  restoreVersion: string | null;
}
export interface BusinessLearningReviewView {
  candidateId: string;
  candidateRevision: number;
  baseRevision: BusinessLearningBaseRevision;
  proposalDigest: string;
  reviewReceiptId: string;
  reviewedHash: string;
  expiresAt: number;
  /** Native trusted reviewer supplies current content authorization after loading the exact diff. */
  trustedOwner: boolean;
  contentAuthorized: boolean;
  actualDiffLoaded: boolean;
  changes: Array<{ path: string; before: string; after: string }>;
}
export interface BusinessLearningSnapshot {
  context?: BusinessHistoryViewContext | null;
  scopeLabel: string;
  status: 'current' | 'unknown';
  sources: Array<{ id: string; label: string; policyRevision: number; collection: 'on' | 'paused' | 'off'; analysis: 'on' | 'paused' | 'off' }>;
  candidates: BusinessLearningCandidateView[];
}
export interface BusinessLearningCandidateAction { candidateId: string; expectedRevision: number; expectedControlRevision: number }
export interface BusinessLearningPanelPort {
  read(): Promise<BusinessLearningSnapshot>;
  subscribeInvalidation?(listener: () => void): () => void;
  compare(input: BusinessLearningCandidateAction): Promise<BusinessLearningReviewView | null>;
  approve(input: BusinessLearningCandidateAction & { baseRevision: BusinessLearningBaseRevision; proposalDigest: string; reviewReceiptId: string; reviewedHash: string }): Promise<BusinessLearningSnapshot>;
  pause(input: BusinessLearningCandidateAction): Promise<BusinessLearningSnapshot>;
  revoke(input: BusinessLearningCandidateAction): Promise<BusinessLearningSnapshot>;
  restoreProposal(input: BusinessLearningCandidateAction & { version: string; expectedBaseRevision: BusinessLearningBaseRevision }): Promise<BusinessLearningSnapshot>;
  pauseCollection(input: { sourceId: string; expectedPolicyRevision: number }): Promise<BusinessLearningSnapshot>;
  /** Exact safe stop is independent of content, authority-service readiness and other pending mutations. */
  stop(input: BusinessLearningCandidateAction & { target: NonNullable<BusinessLearningCandidateView['stopTarget']> }): Promise<{ state: 'accepted' | 'settled' | 'unknown' | 'failed' }>;
  openAudit(input: { candidateId: string }): Promise<void>;
}
export function businessReviewMatches(candidate: BusinessLearningCandidateView, review: BusinessLearningReviewView | null, now = Date.now()): boolean {
  if (!isBusinessConsoleMetadata(candidate) || !isBusinessConsoleMetadata(review)) return false;
  let characters = 0;
  const content = (text: unknown): text is string => typeof text === 'string' && text.length <= 100000 && !looksSecret(text)
    && (characters += text.length) <= 1000000;
  return candidate.sourceStatus === 'allowed' && !!review
    && businessOnlyKeys(review, ['candidateId', 'candidateRevision', 'baseRevision', 'proposalDigest', 'reviewReceiptId', 'reviewedHash', 'expiresAt', 'trustedOwner', 'contentAuthorized', 'actualDiffLoaded', 'changes'])
    && review.trustedOwner === true && review.contentAuthorized === true && review.actualDiffLoaded === true
    && isBusinessLearningBaseRevision(candidate.baseRevision) && isBusinessLearningBaseRevision(review.baseRevision)
    && review.candidateId === candidate.id && review.candidateRevision === candidate.revision && review.baseRevision === candidate.baseRevision
    && candidate.proposalDigest !== null && review.proposalDigest === candidate.proposalDigest && review.reviewedHash === review.proposalDigest
    && /^[a-f0-9]{64}$/.test(review.proposalDigest) && isBusinessId(review.reviewReceiptId) && isBusinessRevision(review.expiresAt)
    && review.expiresAt > now && isBusinessNativeArray(review.changes, 128) && review.changes.length > 0
    && review.changes.every(change => businessOnlyKeys(change, ['path', 'before', 'after']) && typeof change.path === 'string'
      && change.path.length <= 240 && !change.path.startsWith('/') && !change.path.includes('\\') && !/[\u0000-\u001f\u007f]/.test(change.path)
      && change.path.split('/').every(part => !!part && part !== '.' && part !== '..') && content(change.before) && content(change.after))
    && new Set(review.changes.map(change => change.path)).size === review.changes.length;
}
export function businessReviewReady(candidate: BusinessLearningCandidateView, review: BusinessLearningReviewView | null, now = Date.now()): boolean {
  return candidate.state === 'review-ready' && candidate.validation === 'passed' && businessReviewMatches(candidate, review, now);
}
export function isBusinessLearningSnapshot(value: unknown): value is BusinessLearningSnapshot {
  const label = (text: unknown): text is string => typeof text === 'string' && text.length <= 200 && !looksSecret(text) && !/[\u0000-\u001f\u007f]/.test(text);
  try {
    return isBusinessConsoleMetadata(value) && businessOnlyKeys(value, ['context', 'scopeLabel', 'status', 'sources', 'candidates']) && label(value.scopeLabel)
      && ['current', 'unknown'].includes(value.status as string) && isBusinessNativeArray(value.sources, 160)
      && value.sources.every(source => businessOnlyKeys(source, ['id', 'label', 'policyRevision', 'collection', 'analysis'])
        && isBusinessId(source.id) && label(source.label) && isBusinessRevision(source.policyRevision)
        && ['on', 'paused', 'off'].includes(source.collection as string) && ['on', 'paused', 'off'].includes(source.analysis as string))
      && new Set(value.sources.map(source => (source as { id: string }).id)).size === value.sources.length
      && isBusinessNativeArray(value.candidates, 160) && value.candidates.every(candidate =>
        businessOnlyKeys(candidate, ['id', 'revision', 'controlRevision', 'label', 'currentVersion', 'baseRevision', 'proposalDigest', 'state', 'validation', 'sourceStatus', 'stopTarget', 'restoreVersion'])
        && isBusinessId(candidate.id) && label(candidate.label) && (candidate.currentVersion === null || isBusinessId(candidate.currentVersion))
        && [candidate.revision, candidate.controlRevision].every(isBusinessRevision) && isBusinessLearningBaseRevision(candidate.baseRevision)
        && (candidate.proposalDigest === null || typeof candidate.proposalDigest === 'string' && /^[a-f0-9]{64}$/.test(candidate.proposalDigest))
        && ['candidate', 'draft', 'review-ready', 'active', 'paused', 'revoked', 'unknown'].includes(candidate.state as string) && ['passed', 'failed', 'unknown'].includes(candidate.validation as string)
        && ['allowed', 'paused', 'revoked', 'unknown'].includes(candidate.sourceStatus as string)
        && (candidate.restoreVersion === null || isBusinessId(candidate.restoreVersion))
        && (candidate.stopTarget === null || businessOnlyKeys(candidate.stopTarget, ['hostId', 'taskId', 'runId', 'controlVersion'])
          && [candidate.stopTarget.hostId, candidate.stopTarget.taskId, candidate.stopTarget.runId].every(isBusinessId) && isBusinessRevision(candidate.stopTarget.controlVersion)))
      && new Set(value.candidates.map(v => (v as { id: string }).id)).size === value.candidates.length;
  } catch { return false; }
}

export const BUSINESS_DESKTOP_CONSOLE_SCHEMA = 'agentlas.business.desktop-console.v1' as const;
export const BUSINESS_DASHBOARD_VIEWS = ['overview', 'members', 'roles', 'grants', 'audit', 'providers', 'catalog', 'organization-execution', 'history', 'learning'] as const;
export type BusinessDashboardView = typeof BUSINESS_DASHBOARD_VIEWS[number];
export interface BusinessRendererSnapshot {
  readonly schema: typeof BUSINESS_DESKTOP_CONSOLE_SCHEMA;
  readonly context: BusinessHistoryViewContext | null;
  readonly organizationSession: BusinessSession | null;
  /** Availability only. Every actual operation is checked by its existing owner. */
  readonly availability: Readonly<{ account: boolean; history: boolean; learning: boolean; organizationExecution: boolean }>;
}
/** Main's existing authenticated owner supplies this namespace through preload.
 * Renderer does not manufacture an actor, session, native request or HTTP header. */
export interface BusinessRendererBridge {
  snapshot(): Promise<BusinessRendererSnapshot>;
  /** Current server-owned organization license/member display decision only. */
  readEligibility?(): Promise<BusinessEligibility | null>;
  account?: BusinessAccountPanelPort | null;
  history?: BusinessHistoryPanelPort | null;
  learning?: BusinessLearningPanelPort | null;
  organizationExecution?: BusinessOrganizationExecutionPanelPort | null;
  openDashboard?(input: { view: BusinessDashboardView }): Promise<void>;
  onInvalidated?(listener: () => void): () => void;
}
export function captureBusinessConsoleMethod<T>(owner: unknown, key: string): T | null {
  try {
    if (!owner || typeof owner !== 'object') return null;
    let cursor: object | null = owner;
    for (let depth = 0; cursor && depth < 4; depth++, cursor = Object.getPrototypeOf(cursor) as object | null) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor) return typeof descriptor.value === 'function' ? descriptor.value.bind(owner) as T : null;
    }
  } catch { /* Accessors and owner diagnostics are never used as a bridge. */ }
  return null;
}
function field(owner: unknown, key: string): unknown {
  try { return owner && typeof owner === 'object' ? Object.getOwnPropertyDescriptor(owner, key)?.value : undefined; } catch { return undefined; }
}
function port<T>(owner: unknown, required: readonly string[], optional: readonly string[] = []): T | null {
  const value: Record<string, unknown> = Object.create(null);
  for (const name of required) { const fn = captureBusinessConsoleMethod(owner, name); if (!fn) return null; value[name] = fn; }
  for (const name of optional) { const fn = captureBusinessConsoleMethod(owner, name); if (fn) value[name] = fn; }
  return Object.freeze(value) as T;
}
export function isBusinessRendererContext(value: unknown, now = Date.now()): value is BusinessHistoryViewContext {
  try {
    if (!isBusinessConsoleMetadata(value) || !businessOnlyKeys(value, ['session', 'scope', 'target', 'bindingKey', 'revision', 'policyRevision', 'nativePolicyRevision', 'expiresAt'])
      || !isBusinessSession(value.session) || !isBusinessId(value.bindingKey) || !isBusinessId(value.revision)
      || !(value.policyRevision === null || isBusinessRevision(value.policyRevision))
      || !(value.nativePolicyRevision === null || isBusinessId(value.nativePolicyRevision))
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= now
      || value.expiresAt > Date.parse(value.session.expiresAt)) return false;
    const scope = value.scope;
    if (!(businessOnlyKeys(scope, ['kind', 'principalId']) && scope.kind === 'personal' && scope.principalId === value.session.principalId
      || businessOnlyKeys(scope, ['kind', 'organizationId']) && scope.kind === 'organization' && scope.organizationId === value.session.organizationId)) return false;
    if (value.target === null) return true;
    const target = value.target;
    return businessOnlyKeys(target, ['deploymentId', 'oneId', 'scope', 'organizationId', 'projectId', 'spaceId', 'pageId', 'audience'])
      && [target.deploymentId, target.oneId, target.spaceId, target.pageId].every(isBusinessId)
      && target.deploymentId === value.session.deploymentId
      && (target.projectId === null || isBusinessId(target.projectId))
      && (scope.kind === 'personal' ? target.scope === 'personal' && target.organizationId === null && target.projectId === null && target.audience === 'owner'
        : target.organizationId === scope.organizationId && target.audience === 'organization'
          && (target.scope === 'organization' && target.projectId === null || target.scope === 'project' && isBusinessId(target.projectId)));
  } catch { return false; }
}
export function isBusinessRendererSnapshot(value: unknown, now = Date.now()): value is BusinessRendererSnapshot {
  try {
    if (!isBusinessConsoleMetadata(value) || !businessOnlyKeys(value, ['schema', 'context', 'organizationSession', 'availability']) || value.schema !== BUSINESS_DESKTOP_CONSOLE_SCHEMA
      || !(value.context === null || isBusinessRendererContext(value.context, now))
      || !(value.organizationSession === null || isBusinessSession(value.organizationSession) && Date.parse(value.organizationSession.expiresAt) > now)
      || !businessOnlyKeys(value.availability, ['account', 'history', 'learning', 'organizationExecution'])) return false;
    const availability = value.availability;
    if (!['account', 'history', 'learning', 'organizationExecution'].every(key => typeof availability[key] === 'boolean')) return false;
    return value.context === null || value.organizationSession === null || sameBusinessSession(value.context.session, value.organizationSession);
  } catch { return false; }
}
/** Captures genuine supplied receivers. Import/construction sends no IPC/network request. */
export function captureBusinessRendererBridge(owner: unknown): BusinessRendererBridge | null {
  const snapshot = captureBusinessConsoleMethod<BusinessRendererBridge['snapshot']>(owner, 'snapshot');
  if (!snapshot) return null;
  return Object.freeze({ snapshot,
    readEligibility: captureBusinessConsoleMethod<NonNullable<BusinessRendererBridge['readEligibility']>>(owner, 'readEligibility') ?? undefined,
    account: captureBusinessAccountPanelPort(field(owner, 'account')),
    history: port<BusinessHistoryPanelPort>(field(owner, 'history'), ['read'], ['subscribeInvalidation', 'search', 'reviewRecommendation', 'pauseCollection', 'deleteHistory', 'reconcileDelete', 'openPage', 'openCandidate']),
    learning: captureBusinessLearningPanelPort(field(owner, 'learning')),
    organizationExecution: port<BusinessOrganizationExecutionPanelPort>(field(owner, 'organizationExecution'), ['read', 'control', 'receipt'], ['subscribeInvalidation']),
    openDashboard: captureBusinessConsoleMethod<NonNullable<BusinessRendererBridge['openDashboard']>>(owner, 'openDashboard') ?? undefined,
    onInvalidated: captureBusinessConsoleMethod<NonNullable<BusinessRendererBridge['onInvalidated']>>(owner, 'onInvalidated') ?? undefined,
  });
}

export function captureBusinessAccountPanelPort(owner: unknown): BusinessAccountPanelPort | null {
  return port<BusinessAccountPanelPort>(owner, ['read', 'signIn', 'joinOrganization', 'selectOrganization', 'logout', 'openAdmin', 'selectPersonal'], ['subscribeInvalidation']);
}
export function captureBusinessLearningPanelPort(owner: unknown): BusinessLearningPanelPort | null {
  return port<BusinessLearningPanelPort>(owner, ['read', 'compare', 'approve', 'pause', 'revoke', 'restoreProposal', 'pauseCollection', 'stop', 'openAudit'], ['subscribeInvalidation']);
}
/** Validate descriptors before cloning. No accessor, cycle, callback, SQL/DB object,
 * secret or unbounded data can enter the console composition's metadata records. */
export function isBusinessConsoleMetadata(raw: unknown): boolean {
  let nodes = 32768, characters = 2000000;
  const stack = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 20) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return isBusinessRevision(value);
    if (typeof value === 'string') return value.length <= 100000 && (characters -= value.length) >= 0 && !looksSecret(value);
    if (!value || typeof value !== 'object' || stack.has(value)) return false;
    const array = Array.isArray(value);
    if (array ? !isBusinessNativeArray(value, 4096) : Object.getPrototypeOf(value) !== Object.prototype) return false;
    stack.add(value);
    try {
      for (const key of Reflect.ownKeys(value)) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || key.length > 240) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true || !visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    } finally { stack.delete(value); }
  };
  try { return visit(raw, 0); } catch { return false; }
}
export function freezeBusinessConsoleMetadata<T>(raw: T): T {
  if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_metadata_invalid');
  const value = structuredClone(raw);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
  };
  freeze(value); return value;
}
