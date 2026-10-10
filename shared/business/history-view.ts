import { businessOnlyKeys, isBusinessId, sameBusinessScope, sameBusinessSession, type BusinessEpoch, type BusinessQuery, type BusinessResourceRef, type BusinessScope, type BusinessSession } from './context';
import type { BusinessNativeActionRequest } from './native-action-ports';
import { isBusinessNativeArray } from './native-registry';

export const BUSINESS_HISTORY_VIEW_SCHEMA = 'agentlas.business.history-view.v1' as const;
/** Read-only consumer contract for the existing One wire protocol. These values
 * do not create a native target, candidate, registry, grant or execution owner. */
export const BUSINESS_HISTORY_ONE_WIRE_SCHEMA = 'agentlas.one-history-evolution.v1' as const;
export interface BusinessHistoryTarget {
  readonly deploymentId: string;
  readonly oneId: string;
  readonly scope: 'personal' | 'project' | 'organization';
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly spaceId: string;
  readonly pageId: string;
  readonly audience: 'owner' | 'organization';
}
export const BUSINESS_HISTORY_CANDIDATE_STATUSES = ['observed', 'drafting', 'draft', 'evaluated', 'accepted', 'running', 'feedback', 'paused', 'revoked', 'deleted', 'unknown'] as const;
export type BusinessHistoryCandidateStatus = typeof BUSINESS_HISTORY_CANDIDATE_STATUSES[number];
/** Only consumed bootstrap metadata is declared. Snapshot bytes are untrusted
 * until the adapter validates the original schema/target/source/evaluation. */
export interface BusinessHistoryOneReadPort {
  bootstrap(): Promise<{ readonly state: 'ready' | 'blocked'; readonly target: BusinessHistoryTarget | null; readonly bindingKey: string }>;
  historySnapshot(input: { target: BusinessHistoryTarget }): Promise<unknown>;
}
/** Current native owner supplies the exact mapping. Native policy strings and
 * canonical Business policy revisions are distinct and are never coerced. */
export interface BusinessHistoryViewContext {
  readonly session: BusinessSession;
  readonly scope: BusinessScope;
  readonly target: BusinessHistoryTarget | null;
  readonly bindingKey: string;
  readonly revision: string;
  readonly policyRevision: number | null;
  readonly nativePolicyRevision: string | null;
  readonly expiresAt: number;
}
export function sameBusinessHistoryViewContext(a: BusinessHistoryViewContext, b: BusinessHistoryViewContext): boolean {
  return sameBusinessSession(a.session, b.session) && sameBusinessScope(a.scope, b.scope) && a.bindingKey === b.bindingKey && a.revision === b.revision
    && a.policyRevision === b.policyRevision && a.nativePolicyRevision === b.nativePolicyRevision && a.expiresAt === b.expiresAt
    && (a.target === null || b.target === null ? a.target === b.target : a.target.deploymentId === b.target.deploymentId
      && a.target.oneId === b.target.oneId && a.target.scope === b.target.scope && a.target.organizationId === b.target.organizationId
      && a.target.projectId === b.target.projectId && a.target.spaceId === b.target.spaceId && a.target.pageId === b.target.pageId && a.target.audience === b.target.audience);
}
export interface BusinessHistoryViewBinding {
  readonly context: BusinessHistoryViewContext;
  readonly readRequest: BusinessNativeActionRequest;
  /** Existing owner enumerates exact current permitted entries/source revisions.
   * Admin status and organization membership do not populate this list. */
  readonly entries: readonly { readonly entryId: string; readonly sourceRef: string; readonly revision: string }[];
  readonly collection: 'on' | 'paused' | 'off' | 'unknown';
  readonly analysis: 'on' | 'paused' | 'off' | 'unknown';
  readonly retentionMs: number | null;
}
export interface BusinessHistoryTimelineEntry {
  readonly id: string;
  readonly revision: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly summary: string;
  readonly applications: readonly string[];
  readonly bucket: '10min' | '6h';
  readonly recommendation: {
    readonly id: string;
    readonly kind: 'agent' | 'plugin' | 'graph';
    readonly title: string;
    readonly summary: string;
    readonly evidenceCount: number;
    readonly status: 'draft' | 'dismissed' | 'accepted';
  } | null;
}
export interface BusinessHistoryCandidateView {
  readonly id: string;
  readonly revision: number;
  readonly status: BusinessHistoryCandidateStatus;
  readonly kind: 'skill' | 'toolchain' | 'agent' | null;
  readonly proposalVersion: string | null;
  readonly proposalDigest: string | null;
  readonly evaluation: 'passed' | 'failed' | 'unknown';
  readonly observationCount: number;
  readonly sourceRefs: readonly string[];
}
export type BusinessHistoryViewCapability = 'timeline' | 'search' | 'evolution' | 'reviewRecommendation' | 'pauseCollection' | 'deleteHistory' | 'openPage' | 'openCandidate';
export interface BusinessHistoryViewSnapshot {
  readonly schema: typeof BUSINESS_HISTORY_VIEW_SCHEMA;
  readonly context: BusinessHistoryViewContext | null;
  readonly status: 'current' | 'blocked' | 'unknown';
  readonly reason: 'current' | 'current_context_required' | 'native_authority_unbound' | 'permission_changed' | 'read_unavailable';
  readonly availability: Readonly<Record<BusinessHistoryViewCapability, boolean>>;
  readonly collection: BusinessHistoryViewBinding['collection'];
  readonly analysis: BusinessHistoryViewBinding['analysis'];
  readonly retentionMs: number | null;
  readonly entries: readonly BusinessHistoryTimelineEntry[];
  readonly candidates: readonly BusinessHistoryCandidateView[];
  readonly unavailable: readonly ('personal_timeline' | 'organization_timeline' | 'one_history' | 'owner_controls' | 'privacy_delete' | 'native_review')[];
}
export interface BusinessHistoryControlReceipt {
  readonly state: 'applied' | 'denied' | 'unknown';
  readonly contextRevision: string;
  readonly previousPolicyRevision: number;
  readonly policyRevision: number | null;
}
export const BUSINESS_HISTORY_SEARCH_SCHEMA = 'agentlas.business.history-evidence-search.v1' as const;
export interface BusinessHistoryFilter {
  readonly from: string;
  readonly to: string;
  /** Empty means all apps in the already permitted metadata; otherwise any-of. */
  readonly applications: readonly string[];
}
/** Pure display bounds, not permission or authority. */
export function isBusinessHistoryFilter(value: unknown, now = Date.now()): value is BusinessHistoryFilter {
  try {
    if (!businessOnlyKeys(value, ['from', 'to', 'applications']) || typeof value.from !== 'string' || typeof value.to !== 'string'
      || value.from.length > 40 || value.to.length > 40 || !isBusinessNativeArray(value.applications, 16)) return false;
    const from = Date.parse(value.from), to = Date.parse(value.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to > now || to - from > 31 * 86400_000
      || new Date(from).toISOString() !== value.from || new Date(to).toISOString() !== value.to) return false;
    const apps = new Set<string>();
    for (const app of value.applications) { if (!isBusinessId(app) || apps.has(app)) return false; apps.add(app); }
    return true;
  } catch { return false; }
}
/** Caller must first obtain current permitted/redacted timeline entries. */
export function filterBusinessHistoryTimeline(entries: readonly BusinessHistoryTimelineEntry[], filter: BusinessHistoryFilter, now = Date.now()): readonly BusinessHistoryTimelineEntry[] {
  if (!isBusinessHistoryFilter(filter, now)) return [];
  const from = Date.parse(filter.from), to = Date.parse(filter.to);
  return entries.filter(entry => Date.parse(entry.occurredAt) >= from && Date.parse(entry.occurredAt) <= to
    && (!filter.applications.length || entry.applications.some(app => filter.applications.includes(app))));
}
export interface BusinessHistorySearchRequest {
  readonly context: BusinessHistoryViewContext;
  readonly expectedHistoryRevision: string;
  readonly entryRevisions: readonly { readonly entryId: string; readonly revision: string }[];
  readonly query: string;
  readonly filter: BusinessHistoryFilter;
}
export interface BusinessHistoryEvidenceCitation {
  readonly entryId: string;
  readonly entryRevision: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly excerpt: string;
}
export interface BusinessHistorySearchResult {
  readonly schema: typeof BUSINESS_HISTORY_SEARCH_SCHEMA;
  readonly state: 'matched' | 'no-evidence' | 'blocked';
  readonly context: BusinessHistoryViewContext | null;
  readonly historyRevision: string | null;
  readonly filter: BusinessHistoryFilter | null;
  readonly citations: readonly BusinessHistoryEvidenceCitation[];
}
export const BUSINESS_HISTORY_DELETE_PROTOCOL = 'agentlas.business.history-privacy-delete.v1' as const;
export type BusinessHistoryDeleteFilter =
  | { readonly kind: 'scope'; readonly before: null }
  | { readonly kind: 'before'; readonly before: string };
/** Explicit privacy action; it grants no ability to read the deleted contents. */
export interface BusinessHistoryDeleteRequest {
  readonly context: BusinessHistoryViewContext;
  readonly expectedHistoryRevision: string;
  readonly expectedPolicyRevision: number;
  readonly filter: BusinessHistoryDeleteFilter;
}
export interface BusinessHistoryDeleteReference {
  readonly intentId: string;
  readonly intentRevision: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}
/** Registered by the source privacy owner from an existing command/intent. The
 * adapter never invents work, canonical revisions, or an idempotency key. */
export interface BusinessHistoryDeleteIntent {
  readonly protocol: typeof BUSINESS_HISTORY_DELETE_PROTOCOL;
  readonly originalIntent: BusinessHistoryDeleteReference;
  readonly request: BusinessHistoryDeleteRequest;
  readonly collection: BusinessResourceRef;
  readonly query: BusinessQuery;
}
export interface BusinessHistoryDeleteCommit {
  readonly protocol: typeof BUSINESS_HISTORY_DELETE_PROTOCOL;
  readonly intent: BusinessHistoryDeleteIntent;
  readonly epoch: BusinessEpoch;
}
export interface BusinessHistoryDeleteReceipt {
  readonly protocol: typeof BUSINESS_HISTORY_DELETE_PROTOCOL;
  readonly state: 'applied' | 'denied' | 'unknown';
  readonly originalIntent: BusinessHistoryDeleteReference | null;
  readonly contextRevision: string;
  readonly previousHistoryRevision: string;
  readonly previousPolicyRevision: number;
  readonly historyRevision: string | null;
  readonly policyRevision: number | null;
  readonly deletedCount: number | null;
}
export interface BusinessHistoryPanelPort {
  read(): Promise<BusinessHistoryViewSnapshot>;
  /** Local search over CURRENT permitted display metadata only; no inference or new collection. */
  search?(input: BusinessHistorySearchRequest): Promise<BusinessHistorySearchResult>;
  subscribeInvalidation?(listener: () => void): () => void;
  reviewRecommendation?(input: { context: BusinessHistoryViewContext; recommendationId: string; entryId: string; expectedEntryRevision: string }): Promise<void>;
  pauseCollection?(input: { context: BusinessHistoryViewContext; expectedPolicyRevision: number }): Promise<BusinessHistoryControlReceipt>;
  deleteHistory?(input: BusinessHistoryDeleteRequest): Promise<BusinessHistoryDeleteReceipt>;
  /** Passive receipt query for the ORIGINAL intent; never redispatches deletion. */
  reconcileDelete?(input: { request: BusinessHistoryDeleteRequest; originalIntent: BusinessHistoryDeleteReference }): Promise<BusinessHistoryDeleteReceipt>;
  openPage?(input: { context: BusinessHistoryViewContext }): Promise<void>;
  openCandidate?(input: { context: BusinessHistoryViewContext; candidateId: string; expectedRevision: number }): Promise<void>;
}
