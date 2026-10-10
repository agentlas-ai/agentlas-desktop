import { businessOnlyKeys, isBusinessId, isBusinessResource, isBusinessRevision, isBusinessSession,
  type BusinessResourceRef, type BusinessSession } from './context';

export interface BusinessOpaqueSource {
  readonly resourceId: string;
  readonly revision: string;
  readonly sourceAuthorityId: string;
}
export interface BusinessNativeWork {
  readonly kind: 'task' | 'reply';
  readonly taskId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly occurrenceId: string;
  readonly controlVersion: string | null;
  readonly replyAuthorityRevision: string | null;
}
export interface BusinessRevisionRequest {
  readonly session: BusinessSession;
  readonly work: BusinessNativeWork;
  readonly sources: readonly BusinessOpaqueSource[];
}
export interface BusinessRevisionMapping {
  readonly bindingId: string;
  readonly identityAuthorityId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly authEpoch: number;
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly hostId: string;
  readonly work: BusinessNativeWork;
  readonly canonicalControlRevision: number;
  readonly resources: readonly { readonly opaque: BusinessOpaqueSource; readonly canonical: BusinessResourceRef }[];
  readonly expiresAt: string;
}
/** Only existing native/source owners populate this registry. No revisions are minted here.
 * current is a live synchronous native registry predicate, never a cached grant decision.
 * It must match the entire binding/session/work/source vector against current owner state.
 */
export interface BusinessRevisionRegistryPort {
  resolve(request: BusinessRevisionRequest): Promise<BusinessRevisionMapping | null>;
  stillCurrent(mapping: BusinessRevisionMapping): Promise<boolean>;
  current(mapping: BusinessRevisionMapping): boolean;
}

/** Reject accessors, sparse/subclass arrays and custom payload fields before copying metadata. */
export function isBusinessNativeArray(value: unknown, limit = 64): value is readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit) return false;
    return Reflect.ownKeys(value).length === value.length + 1 && Reflect.ownKeys(value).every(key =>
      typeof key === 'string' && (key === 'length' || /^(0|[1-9][0-9]*)$/.test(key))
      && Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'));
  } catch { return false; }
}
export function isBusinessNativeWork(value: unknown): value is BusinessNativeWork {
  try {
    return businessOnlyKeys(value, ['kind', 'taskId', 'runId', 'commandId', 'occurrenceId', 'controlVersion', 'replyAuthorityRevision'])
      && [value.taskId, value.runId, value.commandId, value.occurrenceId].every(isBusinessId)
      && ((value.kind === 'task' && isBusinessId(value.controlVersion) && value.replyAuthorityRevision === null)
        || (value.kind === 'reply' && value.controlVersion === null && isBusinessId(value.replyAuthorityRevision)));
  } catch { return false; }
}
export function isBusinessOpaqueSource(value: unknown): value is BusinessOpaqueSource {
  try {
    return businessOnlyKeys(value, ['resourceId', 'revision', 'sourceAuthorityId'])
      && [value.resourceId, value.revision, value.sourceAuthorityId].every(isBusinessId);
  } catch { return false; }
}
export function sameBusinessNativeWork(a: BusinessNativeWork, b: BusinessNativeWork): boolean {
  return a.kind === b.kind && a.taskId === b.taskId && a.runId === b.runId && a.commandId === b.commandId
    && a.occurrenceId === b.occurrenceId && a.controlVersion === b.controlVersion && a.replyAuthorityRevision === b.replyAuthorityRevision;
}
export function sameBusinessOpaqueSource(a: BusinessOpaqueSource, b: BusinessOpaqueSource): boolean {
  return a.resourceId === b.resourceId && a.revision === b.revision && a.sourceAuthorityId === b.sourceAuthorityId;
}
export function isBusinessRevisionRequest(value: unknown): value is BusinessRevisionRequest {
  try {
    if (!businessOnlyKeys(value, ['session', 'work', 'sources']) || !isBusinessSession(value.session)
      || !isBusinessNativeWork(value.work) || !isBusinessNativeArray(value.sources) || !value.sources.every(isBusinessOpaqueSource)) return false;
    // An empty source vector is a control-only fence, not a resource/permission grant.
    return new Set(value.sources.map(source => source.resourceId)).size === value.sources.length;
  } catch { return false; }
}
export function isBusinessRevisionMapping(value: unknown): value is BusinessRevisionMapping {
  try {
    if (!businessOnlyKeys(value, ['bindingId', 'identityAuthorityId', 'sessionId', 'sessionRevision', 'authEpoch', 'deploymentId',
      'organizationId', 'principalId', 'hostId', 'work', 'canonicalControlRevision', 'resources', 'expiresAt'])
      || ![value.bindingId, value.identityAuthorityId, value.sessionId, value.deploymentId, value.organizationId, value.principalId, value.hostId].every(isBusinessId)
      || ![value.sessionRevision, value.authEpoch, value.canonicalControlRevision].every(isBusinessRevision)
      || !isBusinessNativeWork(value.work) || !isBusinessNativeArray(value.resources)
      || typeof value.expiresAt !== 'string' || value.expiresAt.length > 40 || !Number.isFinite(Date.parse(value.expiresAt))) return false;
    const ids = new Set<string>();
    for (const pair of value.resources) {
      if (!businessOnlyKeys(pair, ['opaque', 'canonical']) || !isBusinessOpaqueSource(pair.opaque) || !isBusinessResource(pair.canonical)
        || pair.opaque.resourceId !== pair.canonical.resourceId || ids.has(pair.canonical.resourceId)) return false;
      if ((pair.canonical.scope.kind === 'organization' && pair.canonical.scope.organizationId !== value.organizationId)
        || (pair.canonical.scope.kind === 'personal' && pair.canonical.scope.principalId !== value.principalId)) return false;
      ids.add(pair.canonical.resourceId);
    }
    return true;
  } catch { return false; }
}
export function businessRevisionMappingMatchesRequest(mapping: BusinessRevisionMapping, request: BusinessRevisionRequest, now = Date.now()): boolean {
  if (!isBusinessRevisionRequest(request) || !isBusinessRevisionMapping(mapping)) return false;
  const session = request.session;
  return mapping.identityAuthorityId === session.identityAuthorityId && mapping.sessionId === session.sessionId
    && mapping.sessionRevision === session.sessionRevision && mapping.authEpoch === session.authEpoch && mapping.deploymentId === session.deploymentId
    && mapping.organizationId === session.organizationId && mapping.principalId === session.principalId && mapping.hostId === session.hostId
    && sameBusinessNativeWork(mapping.work, request.work) && Date.parse(mapping.expiresAt) > now
    && Date.parse(mapping.expiresAt) <= Date.parse(session.expiresAt) && mapping.resources.length === request.sources.length
    && request.sources.every(source => mapping.resources.some(pair => sameBusinessOpaqueSource(pair.opaque, source)));
}
function freezeMetadata<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}
export function snapshotBusinessRevisionRequest(value: BusinessRevisionRequest): BusinessRevisionRequest | null {
  if (!isBusinessRevisionRequest(value)) return null;
  return freezeMetadata({ session: { ...value.session }, work: { ...value.work }, sources: value.sources.map(source => ({ ...source })) });
}
export function snapshotBusinessRevisionMapping(value: BusinessRevisionMapping): BusinessRevisionMapping | null {
  if (!isBusinessRevisionMapping(value)) return null;
  return freezeMetadata({ ...value, work: { ...value.work }, resources: value.resources.map(pair => ({ opaque: { ...pair.opaque },
    canonical: { ...pair.canonical, scope: { ...pair.canonical.scope } } })) });
}
export function businessRevisionMappingCurrent(port: BusinessRevisionRegistryPort | null, mapping: BusinessRevisionMapping, now = Date.now()): boolean {
  try {
    return !!port && typeof port.current === 'function' && isBusinessRevisionMapping(mapping) && Date.parse(mapping.expiresAt) > now
      && port.current(mapping) === true;
  } catch { return false; }
}
export function createBusinessRevisionResolver(port: BusinessRevisionRegistryPort | null, now: () => number = Date.now) {
  return async (request: BusinessRevisionRequest): Promise<BusinessRevisionMapping | null> => {
    try {
      const exact = snapshotBusinessRevisionRequest(request);
      if (!port || !exact || typeof port.current !== 'function' || Date.parse(exact.session.expiresAt) <= now()) return null;
      const resolved = await port.resolve(exact);
      const mapping = resolved ? snapshotBusinessRevisionMapping(resolved) : null;
      if (!mapping || !businessRevisionMappingMatchesRequest(mapping, exact, now()) || !businessRevisionMappingCurrent(port, mapping, now())) return null;
      if (await port.stillCurrent(mapping) !== true || !businessRevisionMappingCurrent(port, mapping, now())) return null;
      return mapping;
    } catch { return null; }
  };
}
