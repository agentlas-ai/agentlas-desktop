import { businessOnlyKeys, isBusinessEpoch, isBusinessId, isBusinessQuery, isBusinessResource, isBusinessRevision,
  isBusinessSession, sameBusinessResource, sameBusinessSession, type BusinessEpoch, type BusinessQuery,
  type BusinessResourceRef, type BusinessSession } from './context';
import { BUSINESS_NATIVE_ACTION_ADMISSION_PROTOCOL, BUSINESS_NATIVE_ACTION_CONTEXT_SCHEMA, BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL,
  type BusinessNativeActionAdmissionInput, type BusinessNativeActionAdmissionProof, type BusinessNativeActionDocumentAdmission,
  type BusinessNativeActionDocumentReceipt, type BusinessNativeActionOwnerContext, type BusinessNativeActionRequest } from './native-action-ports';
import { businessRevisionMappingMatchesRequest, isBusinessNativeArray, isBusinessNativeWork, isBusinessOpaqueSource,
  isBusinessRevisionMapping } from './native-registry';
import { looksSecret } from '../secret-patterns';

export const BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT = 'agentlas.business.organization-document-transport.v1' as const;
export const BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT_SCHEMA = BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT;
export const BUSINESS_ORGANIZATION_DOCUMENT_COMMIT_PATH = '/api/business/documents/commit' as const;
export const BUSINESS_ORGANIZATION_DOCUMENT_RECEIPT_PATH = '/api/business/documents/receipt' as const;
export const BUSINESS_ORGANIZATION_DOCUMENT_READ_PATH = '/api/business/documents/read' as const;
export const BUSINESS_ORGANIZATION_DOCUMENT_CONTENT_SCHEMA = 'agentlas.business.organization-document-content.v1' as const;
/** Readonly wire narrowing after validation, preserving every existing native field. */
export type BusinessOrganizationDocumentNativeRequest = Omit<BusinessNativeActionRequest, 'scope' | 'organizationId' | 'sourceRefs'> & {
  readonly scope: 'organization'; readonly organizationId: string; readonly sourceRefs: readonly string[];
};
export type BusinessOrganizationDocumentNativeContext = Omit<BusinessNativeActionOwnerContext, 'request'> & {
  readonly request: BusinessOrganizationDocumentNativeRequest;
};
export type BusinessOrganizationDocumentNativeAdmissionInput = Omit<BusinessNativeActionAdmissionInput, 'context'> & {
  readonly context: BusinessOrganizationDocumentNativeContext;
};
export type BusinessOrganizationDocumentNativeAdmission = Omit<BusinessNativeActionDocumentAdmission, 'context' | 'admissionInput'> & {
  readonly context: BusinessOrganizationDocumentNativeContext;
  readonly admissionInput: BusinessOrganizationDocumentNativeAdmissionInput;
};
export interface BusinessOrganizationDocumentCommitFrame {
  readonly schema: typeof BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT;
  readonly admission: BusinessOrganizationDocumentNativeAdmission;
}
export interface BusinessOrganizationDocumentReadAdmission {
  readonly admissionInput: BusinessOrganizationDocumentNativeAdmissionInput;
  readonly admissionProof: BusinessNativeActionAdmissionProof;
}
export interface BusinessOrganizationDocumentRecoveryFrame {
  readonly schema: typeof BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT;
  /** Historical original effect identity, never a redispatch grant. */
  readonly originalAdmission: BusinessOrganizationDocumentNativeAdmission;
  readonly readAdmission: BusinessOrganizationDocumentReadAdmission;
}
export interface BusinessOrganizationDocumentResponse {
  readonly schema: typeof BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT;
  readonly receipt: BusinessNativeActionDocumentReceipt;
}
export type BusinessOrganizationDocumentContent =
  | { readonly schema: typeof BUSINESS_ORGANIZATION_DOCUMENT_CONTENT_SCHEMA; readonly kind: 'page'; readonly title: string;
    readonly blocks: readonly { readonly id: string; readonly kind: 'manual' | 'inference'; readonly text: string; readonly sourceResourceIds: readonly string[] }[] }
  | { readonly schema: typeof BUSINESS_ORGANIZATION_DOCUMENT_CONTENT_SCHEMA; readonly kind: 'space';
    readonly links: readonly { readonly kind: 'page' | 'conversation' | 'file'; readonly resourceId: string; readonly label: string }[] };
export interface BusinessOrganizationDocumentReadFrame {
  readonly schema: typeof BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT;
  readonly readAdmission: BusinessOrganizationDocumentReadAdmission;
  readonly target: BusinessResourceRef;
}
export interface BusinessOrganizationDocumentReadResult {
  readonly state: 'read' | 'denied' | 'unknown' | 'conflict';
  readonly targetId: string;
  readonly revision: number | null;
  readonly digest: string | null;
  readonly content: BusinessOrganizationDocumentContent | null;
}
export interface BusinessOrganizationDocumentReadResponse {
  readonly schema: typeof BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT;
  readonly result: BusinessOrganizationDocumentReadResult;
}
export type BusinessOrganizationDocumentFrame = BusinessOrganizationDocumentCommitFrame | BusinessOrganizationDocumentRecoveryFrame | BusinessOrganizationDocumentReadFrame;
export type BusinessOrganizationDocumentPath = typeof BUSINESS_ORGANIZATION_DOCUMENT_COMMIT_PATH | typeof BUSINESS_ORGANIZATION_DOCUMENT_RECEIPT_PATH | typeof BUSINESS_ORGANIZATION_DOCUMENT_READ_PATH;

/** Implemented only by the existing authenticated Main ingress owner. The transport
 * derives authentication independently and sends no caller-authored actor headers.
 * Protocol metadata is not a credential or evidence of serialized admission. */
export interface BusinessOrganizationDocumentTrustedTransport {
  readonly protocol: typeof BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT;
  authenticatedSession(): BusinessSession | null;
  /** Live original registered native admission/lease/current registry, under the
   * existing authority exclusion. A TTL, notification or SQL mirror is insufficient. */
  currentAdmission(path: BusinessOrganizationDocumentPath, frame: Readonly<BusinessOrganizationDocumentFrame>): boolean;
  /** Separate CURRENT read authority for the exact settled ORIGINAL effect/receipt
   * or exact content revision/source/audience. A consumed write admission must not
   * become a result grant or authorize dispatch. No result permission is cached here. */
  currentResult(path: BusinessOrganizationDocumentPath, frame: Readonly<BusinessOrganizationDocumentFrame>,
    response: Readonly<BusinessOrganizationDocumentResponse | BusinessOrganizationDocumentReadResponse>): boolean;
  post(path: BusinessOrganizationDocumentPath, frame: Readonly<BusinessOrganizationDocumentFrame>): Promise<unknown>;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return businessOnlyKeys(value, keys) && Object.keys(value).length === keys.length;
}
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nativeId = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) && !looksSecret(value);
function ids(value: unknown): value is readonly string[] {
  return isBusinessNativeArray(value) && value.every(isBusinessId) && new Set(value).size === value.length;
}

/** A frame contains only bounded plain JSON metadata. Validate descriptors before
 * reading values: accessors, functions, SQL handles, buffers, sparse arrays and cycles
 * never reach copying or the authenticated transport. Shared aliases are harmless. */
export function isBusinessOrganizationDocumentMetadata(value: unknown): boolean {
  const stack = new Set<object>(); const budget = { nodes: 32768, bytes: 1024 * 1024 };
  const encoder = new TextEncoder();
  const spend = (bytes: number): boolean => (budget.bytes -= bytes) >= 0;
  const stringBytes = (text: string): number => encoder.encode(JSON.stringify(text)).byteLength;
  const visit = (item: unknown, depth: number): boolean => {
    if (--budget.nodes < 0 || depth > 20) return false;
    if (item === null) return spend(4);
    if (typeof item === 'boolean') return spend(item ? 4 : 5);
    if (typeof item === 'number') return isBusinessRevision(item) && spend(JSON.stringify(item).length);
    if (typeof item === 'string') {
      return item.length <= 512 && !looksSecret(item) && !/[\u0000-\u001f\u007f]/.test(item) && spend(stringBytes(item));
    }
    if (!item || typeof item !== 'object' || stack.has(item)) return false;
    const array = Array.isArray(item);
    if (array ? !isBusinessNativeArray(item, 256) : Object.getPrototypeOf(item) !== Object.prototype) return false;
    stack.add(item);
    try {
      if (!spend(2)) return false; // Opening and closing object/array delimiters.
      let entries = 0;
      for (const key of Reflect.ownKeys(item)) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || key.length > 80) return false;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return false;
        if (entries++ > 0 && !spend(1)) return false; // Comma between emitted values.
        if (!array && !spend(stringBytes(key) + 1)) return false; // JSON key and colon.
        if (!visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    } finally { stack.delete(item); }
  };
  try { return visit(value, 0); } catch { return false; }
}

/** Only call on already validated metadata. This compares value identity, not grants. */
export function businessOrganizationDocumentCanonicalValue(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, ordered(child)])) : item;
  return JSON.stringify(ordered(value));
}
const equal = (a: unknown, b: unknown): boolean => businessOrganizationDocumentCanonicalValue(a) === businessOrganizationDocumentCanonicalValue(b);
function session(value: unknown): value is BusinessSession {
  return exact(value, ['principalId', 'sessionId', 'sessionRevision', 'authEpoch', 'deploymentId', 'organizationId', 'identityAuthorityId', 'hostId', 'expiresAt'])
    && isBusinessSession(value);
}
function resource(value: unknown, actor: BusinessSession): value is BusinessResourceRef {
  return exact(value, ['resourceId', 'revision', 'aclRevision', 'scope']) && isBusinessResource(value)
    && (value.scope.kind === 'organization' ? exact(value.scope, ['kind', 'organizationId']) && value.scope.organizationId === actor.organizationId
      : exact(value.scope, ['kind', 'principalId']) && value.scope.principalId === actor.principalId);
}
function query(value: unknown, actor: BusinessSession): value is BusinessQuery {
  return isBusinessQuery(value) && isBusinessNativeArray(value.resources) && value.resources.every(ref => resource(ref, actor))
    && value.deploymentId === actor.deploymentId && value.organizationId === actor.organizationId && value.hostId === actor.hostId;
}
function epoch(value: unknown, q: BusinessQuery, actor: BusinessSession, clock: number | null): value is BusinessEpoch {
  return isBusinessEpoch(value) && ['principalId', 'sessionId', 'sessionRevision', 'authEpoch', 'deploymentId', 'organizationId', 'identityAuthorityId', 'hostId']
    .every(key => value[key as keyof BusinessEpoch] === actor[key as keyof BusinessSession])
    && Date.parse(value.expiresAt) <= Date.parse(actor.expiresAt) && (clock === null || Date.parse(value.expiresAt) > clock)
    && q.deploymentId === value.deploymentId && q.organizationId === value.organizationId && q.hostId === value.hostId;
}
function resourcesEqual(a: readonly BusinessResourceRef[], b: readonly BusinessResourceRef[]): boolean {
  return a.length === b.length && a.every(ref => b.some(other => sameBusinessResource(ref, other)));
}
function currentBounds(c: BusinessNativeActionOwnerContext, clock: number | null): boolean {
  return c.expiresAt <= Date.parse(c.session.expiresAt) && (clock === null || c.expiresAt > clock && Date.parse(c.session.expiresAt) > clock);
}
function context(value: unknown, action: 'page-write' | 'page-read', clock: number | null): value is BusinessNativeActionOwnerContext {
  if (!exact(value, ['schema', 'contextId', 'contextRevision', 'requestDigest', 'request', 'session', 'work', 'sources', 'sourceBindings',
    'intent', 'query', 'document', 'issuedAuthorityRevision', 'nativeDecisionRevision', 'businessAuthorityRevision', 'expiresAt'])) return false;
  const c = value as unknown as BusinessNativeActionOwnerContext;
  if (c.schema !== BUSINESS_NATIVE_ACTION_CONTEXT_SCHEMA || ![c.contextId, c.contextRevision, c.issuedAuthorityRevision, c.nativeDecisionRevision].every(isBusinessId)
    || !hex(c.requestDigest) || !session(c.session) || !isBusinessNativeWork(c.work) || !isBusinessRevision(c.businessAuthorityRevision)
    || !isBusinessRevision(c.expiresAt) || !currentBounds(c, clock) || !isBusinessNativeArray(c.sources) || !c.sources.length
    || !c.sources.every(isBusinessOpaqueSource) || new Set(c.sources.map(s => s.resourceId)).size !== c.sources.length) return false;
  const r = c.request;
  if (!exact(r, ['principalId', 'sessionId', 'oneId', 'hostId', 'scope', 'organizationId', 'workspaceId', 'projectId', 'resourceId', 'purpose', 'payerId',
    'action', 'taskId', 'runId', 'controlVersion', 'permissionRevision', 'credentialGeneration', 'sourceRefs', 'audience'])
    || ![r.principalId, r.sessionId, r.oneId, r.hostId, r.workspaceId, r.resourceId, r.payerId, r.permissionRevision].every(nativeId)
    || typeof r.purpose !== 'string' || !r.purpose.length || r.purpose.trim() !== r.purpose || r.action !== action || r.scope !== 'organization'
    || r.organizationId !== c.session.organizationId || r.principalId !== c.session.principalId || r.sessionId !== c.session.sessionId || r.hostId !== c.session.hostId
    || !['owner', 'organization'].includes(r.audience) || ![r.projectId, r.taskId, r.runId, r.controlVersion, r.credentialGeneration].every(v => v === null || nativeId(v))
    || !isBusinessNativeArray(r.sourceRefs) || !r.sourceRefs.every(nativeId) || new Set(r.sourceRefs).size !== r.sourceRefs.length
    || (r.taskId === null) !== (r.runId === null) || r.taskId === null && r.controlVersion !== null
    || r.taskId !== null && (r.taskId !== c.work.taskId || r.runId !== c.work.runId || r.controlVersion !== c.work.controlVersion)) return false;
  if (!isBusinessNativeArray(c.sourceBindings) || c.sourceBindings.length !== r.sourceRefs.length) return false;
  for (let i = 0; i < c.sourceBindings.length; i++) {
    const b = c.sourceBindings[i];
    if (!exact(b, ['sourceRef', 'resourceId', 'permissionRevision', 'credentialGeneration', 'consentRevision', 'tombstoneRevision'])
      || ![b.sourceRef, b.permissionRevision, b.consentRevision, b.tombstoneRevision].every(nativeId) || !isBusinessId(b.resourceId)
      || b.sourceRef !== r.sourceRefs[i] || !c.sources.some(s => s.resourceId === b.resourceId)
      || !(b.credentialGeneration === null || nativeId(b.credentialGeneration))) return false;
  }
  const i = c.intent;
  if (!exact(i, ['revision', 'bodyDigest', 'consentRevision', 'permissionRevision', 'credentialRevision', 'payerRevision', 'budgetRevision', 'targetAclRevision', 'audienceRevision'])
    || ![i.revision, i.consentRevision, i.permissionRevision, i.payerRevision, i.targetAclRevision, i.audienceRevision].every(nativeId)
    || !(i.bodyDigest === null || hex(i.bodyDigest)) || !(i.budgetRevision === null || nativeId(i.budgetRevision))
    || i.permissionRevision !== r.permissionRevision || i.credentialRevision !== r.credentialGeneration
    || (r.credentialGeneration === null ? c.sourceBindings.some(b => b.credentialGeneration !== null)
      : !c.sourceBindings.length || c.sourceBindings.some(b => b.credentialGeneration === null))) return false;
  const q = c.query;
  if (!query(q, c.session) || q.action !== (action === 'page-write' ? 'page.write' : 'resource.read')
    || q.taskId !== c.work.taskId || q.runId !== c.work.runId || q.occurrenceId !== c.work.occurrenceId || (q.projectId ?? null) !== r.projectId
    || q.resources.length !== c.sources.length || !q.resources.every(ref => c.sources.some(s => s.resourceId === ref.resourceId))
    || !q.resources.some(ref => ref.resourceId === r.resourceId && ref.scope.kind === 'organization' && ref.scope.organizationId === c.session.organizationId)
    || q.charge !== undefined && (q.charge.payerId !== r.payerId || i.budgetRevision === null)
    || q.credentialRef !== undefined && i.credentialRevision === null) return false;
  if (action === 'page-read') return c.document === null && q.charge === undefined && q.providerBindingId === undefined && q.operationId === undefined
    && q.region === undefined && q.credentialRef === undefined && q.credentialGeneration === undefined;
  const d = c.document;
  return exact(d, ['operationId', 'artifactResourceId', 'targetResourceId', 'audienceResourceIds', 'bodyDigest'])
    && [d.operationId, d.artifactResourceId, d.targetResourceId].every(isBusinessId) && d.targetResourceId === r.resourceId
    && hex(d.bodyDigest) && d.bodyDigest === i.bodyDigest && ids(d.audienceResourceIds)
    && [d.artifactResourceId, ...d.audienceResourceIds].every(id => q.resources.some(ref => ref.resourceId === id))
    && (r.audience !== 'organization' || d.audienceResourceIds.length > 0);
}
function input(value: unknown, action: 'page-write' | 'page-read', clock: number | null): value is BusinessNativeActionAdmissionInput {
  if (!exact(value, ['session', 'query', 'epoch', 'mapping', 'context']) || !context(value.context, action, clock)) return false;
  const a = value as unknown as BusinessNativeActionAdmissionInput; const c = a.context;
  if (!session(a.session) || !sameBusinessSession(a.session, c.session) || !query(a.query, a.session) || !equal(a.query, c.query)
    || !epoch(a.epoch, a.query, a.session, clock) || a.epoch.authorityRevision !== c.businessAuthorityRevision || !isBusinessRevisionMapping(a.mapping)) return false;
  // Historical reconciliation checks exact structure/namespace/work/source correspondence;
  // expiration is deliberately not promoted into an old write grant.
  const at = clock ?? Math.min(Date.parse(a.mapping.expiresAt), Date.parse(a.session.expiresAt)) - 1;
  return businessRevisionMappingMatchesRequest(a.mapping, { session: a.session, work: c.work, sources: c.sources }, at)
    && a.query.controlVersion === a.mapping.canonicalControlRevision && resourcesEqual(a.query.resources, a.mapping.resources.map(p => p.canonical));
}
function proof(value: unknown, a: BusinessNativeActionAdmissionInput, clock: number | null): value is BusinessNativeActionAdmissionProof {
  return exact(value, ['protocol', 'proofDigest', 'sequence', 'expiresAt']) && value.protocol === BUSINESS_NATIVE_ACTION_ADMISSION_PROTOCOL
    && hex(value.proofDigest) && isBusinessRevision(value.sequence) && isBusinessRevision(value.expiresAt)
    && value.expiresAt <= a.context.expiresAt && value.expiresAt <= Date.parse(a.epoch.expiresAt) && value.expiresAt <= Date.parse(a.mapping.expiresAt)
    && (clock === null || value.expiresAt > clock);
}
function admission(value: unknown, clock: number | null): value is BusinessNativeActionDocumentAdmission {
  if (!exact(value, ['protocol', 'document', 'context', 'admissionInput', 'admissionProof']) || value.protocol !== BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL
    || !input(value.admissionInput, 'page-write', clock) || !equal(value.context, value.admissionInput.context)
    || !proof(value.admissionProof, value.admissionInput, clock)) return false;
  const a = value as unknown as BusinessNativeActionDocumentAdmission; const c = a.context; const d = a.document;
  if (!exact(d, ['session', 'query', 'epoch', 'operationId', 'purpose', 'artifact', 'target', 'audienceResourceIds', 'revisionMapping'])
    || !session(d.session) || !sameBusinessSession(d.session, c.session) || !query(d.query, d.session) || !equal(d.query, c.query)
    || !epoch(d.epoch, d.query, d.session, clock) || d.epoch.authorityRevision !== c.businessAuthorityRevision || d.purpose !== d.query.purpose
    || !resource(d.artifact, d.session) || !resource(d.target, d.session) || d.target.scope.kind !== 'organization'
    || d.artifact.resourceId === d.target.resourceId
    || !ids(d.audienceResourceIds) || !isBusinessRevisionMapping(d.revisionMapping) || !c.document
    || d.operationId !== c.document.operationId || d.artifact.resourceId !== c.document.artifactResourceId || d.target.resourceId !== c.document.targetResourceId
    || !equal(d.audienceResourceIds, c.document.audienceResourceIds)
    || ![d.artifact, d.target].every(ref => d.query.resources.some(q => sameBusinessResource(ref, q)))
    || !d.audienceResourceIds.every(id => d.query.resources.some(q => q.resourceId === id))) return false;
  const at = clock ?? Math.min(Date.parse(d.revisionMapping.expiresAt), Date.parse(d.session.expiresAt)) - 1;
  return businessRevisionMappingMatchesRequest(d.revisionMapping, { session: d.session, work: c.work, sources: c.sources }, at)
    && d.query.controlVersion === d.revisionMapping.canonicalControlRevision
    && resourcesEqual(d.query.resources, d.revisionMapping.resources.map(p => p.canonical));
}
export function isBusinessOrganizationDocumentCommitFrame(value: unknown, now = Date.now()): value is BusinessOrganizationDocumentCommitFrame {
  try { return isBusinessOrganizationDocumentMetadata(value) && exact(value, ['schema', 'admission'])
    && value.schema === BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT && admission(value.admission, now); } catch { return false; }
}
/** Structural ORIGINAL operation lookup only; never a current commit admission. */
export function isBusinessOrganizationDocumentOriginalAdmission(value: unknown): value is BusinessOrganizationDocumentNativeAdmission {
  try { return isBusinessOrganizationDocumentMetadata(value) && admission(value, null); } catch { return false; }
}
export function sameBusinessOrganizationDocumentNamespace(a: BusinessSession, b: BusinessSession): boolean {
  return ['deploymentId', 'identityAuthorityId', 'organizationId', 'principalId', 'hostId']
    .every(key => a[key as keyof BusinessSession] === b[key as keyof BusinessSession]);
}
export function isBusinessOrganizationDocumentRecoveryFrame(value: unknown, now = Date.now()): value is BusinessOrganizationDocumentRecoveryFrame {
  try {
    if (!isBusinessOrganizationDocumentMetadata(value) || !exact(value, ['schema', 'originalAdmission', 'readAdmission'])
      || value.schema !== BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT || !admission(value.originalAdmission, null)
      || !exact(value.readAdmission, ['admissionInput', 'admissionProof']) || !input(value.readAdmission.admissionInput, 'page-read', now)
      || !proof(value.readAdmission.admissionProof, value.readAdmission.admissionInput, now)) return false;
    const o = value.originalAdmission.document; const r = value.readAdmission.admissionInput;
    return sameBusinessOrganizationDocumentNamespace(o.session, r.session) && r.context.request.resourceId === o.target.resourceId
      && [o.artifact.resourceId, o.target.resourceId, ...o.audienceResourceIds].every(id => r.query.resources.some(ref => ref.resourceId === id))
      && r.query.resources.some(ref => ref.resourceId === o.target.resourceId && ref.scope.kind === 'organization'
        && ref.scope.organizationId === o.session.organizationId && ref.revision >= o.target.revision);
  } catch { return false; }
}
export function isBusinessOrganizationDocumentResponse(value: unknown): value is BusinessOrganizationDocumentResponse {
  try {
    if (!isBusinessOrganizationDocumentMetadata(value) || !exact(value, ['schema', 'receipt']) || value.schema !== BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT
      || !exact(value.receipt, ['operationId', 'targetId', 'previousRevision', 'state', 'revision', 'digest', 'readBackRevision', 'readBackDigest'])) return false;
    const r = value.receipt;
    if (![r.operationId, r.targetId].every(isBusinessId) || !isBusinessRevision(r.previousRevision) || !['written', 'conflict', 'denied', 'unknown'].includes(r.state as string)) return false;
    return r.state === 'written' ? isBusinessRevision(r.revision) && r.revision > r.previousRevision && hex(r.digest)
      && r.readBackRevision === r.revision && r.readBackDigest === r.digest
      : r.revision === null && r.digest === null && r.readBackRevision === null && r.readBackDigest === null;
  } catch { return false; }
}

export function isBusinessOrganizationDocumentReadFrame(value: unknown, now = Date.now()): value is BusinessOrganizationDocumentReadFrame {
  try {
    if (!isBusinessOrganizationDocumentMetadata(value) || !exact(value, ['schema', 'readAdmission', 'target'])
      || value.schema !== BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT || !exact(value.readAdmission, ['admissionInput', 'admissionProof'])
      || !input(value.readAdmission.admissionInput, 'page-read', now) || !proof(value.readAdmission.admissionProof, value.readAdmission.admissionInput, now)) return false;
    const read = value.readAdmission.admissionInput;
    if (!resource(value.target, read.session)) return false;
    const target = value.target;
    return target.scope.kind === 'organization' && read.context.request.resourceId === target.resourceId
      && read.query.resources.some(ref => sameBusinessResource(ref, target));
  } catch { return false; }
}
function readablePageContent(value: unknown, frame: BusinessOrganizationDocumentReadFrame): value is BusinessOrganizationDocumentContent {
  if (!exact(value, ['schema', 'kind', 'title', 'blocks']) || value.schema !== BUSINESS_ORGANIZATION_DOCUMENT_CONTENT_SCHEMA || value.kind !== 'page') return false;
  let characters = 0;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !looksSecret(v)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) && (characters += v.length) <= 1_000_000;
  if (!text(value.title, 500) || !isBusinessNativeArray(value.blocks, 128)) return false;
  const seen = new Set<string>();
  for (const b of value.blocks) {
    if (!exact(b, ['id', 'kind', 'text', 'sourceResourceIds']) || !isBusinessId(b.id) || seen.has(b.id)
      || !['manual', 'inference'].includes(b.kind as string) || !text(b.text, 100_000) || !ids(b.sourceResourceIds)
      || b.kind === 'inference' && b.sourceResourceIds.length === 0
      || b.sourceResourceIds.some(id => id === frame.target.resourceId || !frame.readAdmission.admissionInput.query.resources.some(ref => ref.resourceId === id))) return false;
    seen.add(b.id);
  }
  return true;
}
/** Authorized document bytes appear only in this response. They are never an input,
 * a metadata cache, a prompt, a diagnostic payload or an execution grant. Existing
 * native Page read is supported; the Space DTO is retained without inventing a phase. */
export function isBusinessOrganizationDocumentReadResponse(value: unknown, frame: BusinessOrganizationDocumentReadFrame): value is BusinessOrganizationDocumentReadResponse {
  try {
    if (!exact(value, ['schema', 'result']) || value.schema !== BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT
      || !exact(value.result, ['state', 'targetId', 'revision', 'digest', 'content'])) return false;
    const r = value.result;
    if (!['read', 'denied', 'unknown', 'conflict'].includes(r.state as string) || r.targetId !== frame.target.resourceId) return false;
    return r.state === 'read' ? isBusinessRevision(r.revision) && r.revision === frame.target.revision && hex(r.digest) && readablePageContent(r.content, frame)
      : r.revision === null && r.digest === null && r.content === null;
  } catch { return false; }
}
