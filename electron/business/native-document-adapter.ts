import { BUSINESS_AUTHORITY_SCHEMA, businessOnlyKeys, isBusinessEpoch, isBusinessId, isBusinessQuery, isBusinessResource,
  isBusinessRevision, isBusinessSession, sameBusinessResource, snapshotBusinessQuery,
  type BusinessAuthority, type BusinessDecision, type BusinessEpoch, type BusinessQuery,
  type BusinessResourceRef, type BusinessSession } from '../../shared/business/context';
import { businessRevisionMappingCurrent, businessRevisionMappingMatchesRequest, createBusinessRevisionResolver,
  isBusinessNativeArray, snapshotBusinessRevisionMapping, type BusinessRevisionMapping,
  type BusinessRevisionRegistryPort } from '../../shared/business/native-registry';
import { desktopBusinessQueryDigest } from './policy-adapter';

export interface BusinessConditionalDocumentInput {
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
export type BusinessConditionalDocumentRequest = Omit<BusinessConditionalDocumentInput, 'epoch'>;
export interface BusinessConditionalDocumentReceipt {
  readonly operationId: string;
  readonly targetId: string;
  readonly previousRevision: number;
  readonly state: 'written' | 'conflict' | 'denied' | 'unknown';
  readonly revision: number | null;
  readonly digest: string | null;
  readonly readBackRevision: number | null;
  readonly readBackDigest: string | null;
}
/** Organization document authority must, in the SAME serialization/transaction:
 * consume the issued exact session/action/purpose/query/epoch + native revision binding,
 * serialize membership/grant/tombstone/native-control revocation, check all source/target/
 * audience ACL and target CAS, commit an idempotent receipt and read that exact revision.
 * A local SQL transaction plus an earlier async allow cannot implement this port.
 * Response loss is reconciled by this domain's durable operation receipt; never blind retry.
 */
export interface BusinessConditionalDocumentPort {
  commit(input: Readonly<BusinessConditionalDocumentInput>): Promise<BusinessConditionalDocumentReceipt>;
}
function hex(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function safeFallback(input: unknown): BusinessConditionalDocumentReceipt {
  let operationId = 'invalid-operation'; let targetId = 'invalid-target'; let previousRevision = 0;
  try {
    if (businessOnlyKeys(input, ['session', 'query', 'operationId', 'purpose', 'artifact', 'target', 'audienceResourceIds', 'revisionMapping'])) {
      if (isBusinessId(input.operationId)) operationId = input.operationId;
      if (isBusinessResource(input.target)) { targetId = input.target.resourceId; previousRevision = input.target.revision; }
    }
  } catch { /* Invalid/raw payloads are never echoed. */ }
  return Object.freeze({ operationId, targetId, previousRevision, state: 'denied', revision: null, digest: null,
    readBackRevision: null, readBackDigest: null });
}
export function isBusinessConditionalDocumentRequest(value: unknown, now = Date.now()): value is BusinessConditionalDocumentRequest {
  try {
    if (!businessOnlyKeys(value, ['session', 'query', 'operationId', 'purpose', 'artifact', 'target', 'audienceResourceIds', 'revisionMapping'])
      || !isBusinessSession(value.session) || !isBusinessQuery(value.query) || !isBusinessResource(value.artifact) || !isBusinessResource(value.target)
      || !isBusinessId(value.operationId) || !isBusinessId(value.purpose) || value.purpose !== value.query.purpose
      || !['page.write', 'space.write'].includes(value.query.action) || !isBusinessNativeArray(value.audienceResourceIds)
      || !value.audienceResourceIds.every(isBusinessId) || new Set(value.audienceResourceIds).size !== value.audienceResourceIds.length) return false;
    const { session, query, artifact, target } = value;
    const mapping = snapshotBusinessRevisionMapping(value.revisionMapping as BusinessRevisionMapping);
    if (!mapping || Date.parse(session.expiresAt) <= now || query.deploymentId !== session.deploymentId || query.organizationId !== session.organizationId
      || query.hostId !== session.hostId || target.scope.kind !== 'organization' || target.scope.organizationId !== session.organizationId
      || (artifact.scope.kind === 'personal' && artifact.scope.principalId !== session.principalId)
      || query.taskId !== mapping.work.taskId || query.runId !== mapping.work.runId || query.occurrenceId !== mapping.work.occurrenceId
      || query.controlVersion !== mapping.canonicalControlRevision || query.resources.length !== mapping.resources.length
      || !query.resources.every(ref => mapping.resources.some(pair => sameBusinessResource(ref, pair.canonical)))
      || !query.resources.some(ref => sameBusinessResource(ref, artifact)) || !query.resources.some(ref => sameBusinessResource(ref, target))
      || !value.audienceResourceIds.every(id => query.resources.some(ref => ref.resourceId === id))) return false;
    return businessRevisionMappingMatchesRequest(mapping, { session, work: mapping.work, sources: mapping.resources.map(pair => pair.opaque) }, now);
  } catch { return false; }
}
function snapshotRequest(value: BusinessConditionalDocumentRequest, now: number): BusinessConditionalDocumentRequest | null {
  if (!isBusinessConditionalDocumentRequest(value, now)) return null;
  const query = snapshotBusinessQuery(value.query);
  const revisionMapping = snapshotBusinessRevisionMapping(value.revisionMapping);
  if (!query || !revisionMapping) return null;
  return freeze({ session: { ...value.session }, query, operationId: value.operationId, purpose: value.purpose,
    artifact: { ...value.artifact, scope: { ...value.artifact.scope } }, target: { ...value.target, scope: { ...value.target.scope } },
    audienceResourceIds: [...value.audienceResourceIds], revisionMapping });
}
function authorizedEpoch(decision: BusinessDecision, query: BusinessQuery, session: BusinessSession, now: number): BusinessEpoch | null {
  if (!businessOnlyKeys(decision, ['schema', 'verdict', 'reason', 'epoch', 'expiresAt']) || decision.schema !== BUSINESS_AUTHORITY_SCHEMA
    || decision.verdict !== 'allow' || decision.reason !== 'allowed' || !isBusinessEpoch(decision.epoch)) return null;
  const epoch = decision.epoch;
  if (epoch.queryDigest !== desktopBusinessQueryDigest(query) || epoch.principalId !== session.principalId || epoch.sessionId !== session.sessionId
    || epoch.identityAuthorityId !== session.identityAuthorityId || epoch.sessionRevision !== session.sessionRevision || epoch.authEpoch !== session.authEpoch
    || epoch.deploymentId !== session.deploymentId || epoch.organizationId !== session.organizationId || epoch.hostId !== session.hostId
    || decision.expiresAt !== epoch.expiresAt || Date.parse(epoch.expiresAt) <= now || Date.parse(epoch.expiresAt) > Date.parse(session.expiresAt)) return null;
  return Object.freeze({ ...epoch });
}
export function isBusinessConditionalDocumentReceipt(value: unknown): value is BusinessConditionalDocumentReceipt {
  try {
    if (!businessOnlyKeys(value, ['operationId', 'targetId', 'previousRevision', 'state', 'revision', 'digest', 'readBackRevision', 'readBackDigest'])
      || !isBusinessId(value.operationId) || !isBusinessId(value.targetId) || !isBusinessRevision(value.previousRevision)) return false;
    if (value.state === 'written') return isBusinessRevision(value.revision) && value.revision > value.previousRevision && hex(value.digest)
      && value.readBackRevision === value.revision && value.readBackDigest === value.digest;
    return ['conflict', 'denied', 'unknown'].includes(value.state as string) && value.revision === null && value.digest === null
      && value.readBackRevision === null && value.readBackDigest === null;
  } catch { return false; }
}
export function createBusinessConditionalDocumentWriter(
  authority: BusinessAuthority | null,
  port: BusinessConditionalDocumentPort | null,
  registry: BusinessRevisionRegistryPort | null,
  now: () => number = Date.now,
) {
  const resolve = createBusinessRevisionResolver(registry, now);
  return async (input: BusinessConditionalDocumentRequest): Promise<BusinessConditionalDocumentReceipt> => {
    const fallback = safeFallback(input);
    try {
      // All intent metadata is validated and frozen before the first await.
      const exact = snapshotRequest(input, now());
      if (!authority || !port || !registry || !exact || !businessRevisionMappingCurrent(registry, exact.revisionMapping, now())) return fallback;
      const mapping = await resolve({ session: exact.session, work: exact.revisionMapping.work,
        sources: exact.revisionMapping.resources.map(pair => pair.opaque) });
      if (!mapping || mapping.canonicalControlRevision !== exact.query.controlVersion
        || mapping.resources.some(pair => !exact.query.resources.some(ref => sameBusinessResource(ref, pair.canonical)))) return fallback;
      const issued = await authority.currentDecision(exact.query, exact.session);
      const epoch = authorizedEpoch(issued, exact.query, exact.session, now());
      if (!epoch || await authority.stillCurrent(epoch) !== true || !businessRevisionMappingCurrent(registry, mapping, now())) return fallback;
      const raw = await port.commit(freeze({ ...exact, revisionMapping: mapping, epoch }));
      if (!isBusinessConditionalDocumentReceipt(raw) || raw.operationId !== exact.operationId || raw.targetId !== exact.target.resourceId
        || raw.previousRevision !== exact.target.revision) return Object.freeze({ ...fallback, state: 'unknown' });
      const receipt = Object.freeze({ ...raw });
      if (receipt.state !== 'written') return receipt;

      // Only the intended target changed. Re-resolve the identical native work and all
      // unchanged sources; the old target mapping must not fence every successful CAS.
      const current = await resolve({ session: exact.session, work: mapping.work,
        sources: mapping.resources.filter(pair => pair.canonical.resourceId !== exact.target.resourceId).map(pair => pair.opaque) });
      if (!current || current.resources.some(pair => !exact.query.resources.some(ref => sameBusinessResource(ref, pair.canonical)))) {
        return Object.freeze({ ...fallback, state: 'unknown' });
      }
      const { charge: _charge, providerBindingId: _provider, operationId: _operation, region: _region,
        credentialRef: _credential, credentialGeneration: _generation, ...readBase } = exact.query;
      const readQuery = snapshotBusinessQuery({ ...readBase, action: 'resource.read', controlVersion: current.canonicalControlRevision,
        resources: readBase.resources.map(ref => ref.resourceId === exact.target.resourceId ? { ...ref, revision: receipt.revision! } : ref) });
      if (!readQuery) return Object.freeze({ ...fallback, state: 'unknown' });
      const readable = await authority.currentDecision(readQuery, exact.session);
      const readEpoch = authorizedEpoch(readable, readQuery, exact.session, now());
      if (!readEpoch || await authority.stillCurrent(readEpoch) !== true || !businessRevisionMappingCurrent(registry, current, now())) {
        return Object.freeze({ ...fallback, state: 'unknown' });
      }
      return receipt;
    } catch { return Object.freeze({ ...fallback, state: 'unknown' }); }
  };
}
