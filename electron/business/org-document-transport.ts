import { createHash } from 'node:crypto';
import { isBusinessId, isBusinessRevision, isBusinessSession, sameBusinessSession, type BusinessSession } from '../../shared/business/context';
import { BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL, type BusinessNativeActionAdmissionProof,
  type BusinessNativeActionDocumentAdmission, type BusinessNativeActionDocumentPort, type BusinessNativeActionDocumentReceipt,
  type BusinessNativeIdentityPort } from '../../shared/business/native-action-ports';
import { BUSINESS_ORGANIZATION_DOCUMENT_COMMIT_PATH, BUSINESS_ORGANIZATION_DOCUMENT_RECEIPT_PATH, BUSINESS_ORGANIZATION_DOCUMENT_READ_PATH, BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT,
  businessOrganizationDocumentCanonicalValue, isBusinessOrganizationDocumentCommitFrame, isBusinessOrganizationDocumentRecoveryFrame,
  isBusinessOrganizationDocumentResponse, isBusinessOrganizationDocumentReadFrame, isBusinessOrganizationDocumentReadResponse,
  isBusinessOrganizationDocumentOriginalAdmission,
  type BusinessOrganizationDocumentRecoveryFrame, type BusinessOrganizationDocumentReadFrame, type BusinessOrganizationDocumentReadResult,
  type BusinessOrganizationDocumentNativeAdmission, type BusinessOrganizationDocumentNativeAdmissionInput,
  type BusinessOrganizationDocumentResponse, type BusinessOrganizationDocumentReadResponse,
  type BusinessOrganizationDocumentFrame, type BusinessOrganizationDocumentPath, type BusinessOrganizationDocumentTrustedTransport } from '../../shared/business/org-document-transport';
import { desktopBusinessQueryDigest } from './policy-adapter';

export interface BusinessOrganizationDocumentTransportOwners {
  readonly identity: BusinessNativeIdentityPort | null;
  readonly transport: BusinessOrganizationDocumentTrustedTransport | null;
}
export interface BusinessOrganizationDocumentTransportAdapter extends BusinessNativeActionDocumentPort {
  /** Passive original receipt lookup with separately registered current read admission. */
  readReceipt(frame: Readonly<BusinessOrganizationDocumentRecoveryFrame>): Promise<BusinessNativeActionDocumentReceipt>;
  /** Exact currently authorized Page revision; never silently follows latest. */
  readDocument(frame: Readonly<BusinessOrganizationDocumentReadFrame>): Promise<BusinessOrganizationDocumentReadResult>;
  /** Suppress late replies unconditionally. Existing native composition owns leases. */
  invalidate(): void;
  blocker(): string | null;
}
function value(owner: unknown, key: string): unknown {
  try { return owner && typeof owner === 'object' ? Object.getOwnPropertyDescriptor(owner, key)?.value : undefined; }
  catch { return undefined; }
}
function method<T extends (...args: never[]) => unknown>(owner: unknown, key: string): T | null {
  if (!owner || typeof owner !== 'object') return null;
  try {
    let cursor: object | null = owner;
    for (let depth = 0; cursor && depth < 4; depth++, cursor = Object.getPrototypeOf(cursor) as object | null) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor) return typeof descriptor.value === 'function' ? descriptor.value.bind(owner) as T : null;
    }
  } catch { /* Untrusted or unavailable owner is closed. */ }
  return null;
}
function digest(metadata: unknown): string {
  return createHash('sha256').update(businessOrganizationDocumentCanonicalValue(metadata)).digest('hex');
}
function frozen<T>(metadata: T): T {
  const copy = structuredClone(metadata);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
  };
  freeze(copy); return copy;
}
function fallback(raw: unknown, state: 'denied' | 'unknown'): BusinessNativeActionDocumentReceipt {
  const document = value(raw, 'document'); const target = value(document, 'target');
  const operationId = value(document, 'operationId'); const targetId = value(target, 'resourceId'); const previousRevision = value(target, 'revision');
  return Object.freeze({ operationId: isBusinessId(operationId) ? operationId : 'invalid-operation',
    targetId: isBusinessId(targetId) ? targetId : 'invalid-target', previousRevision: isBusinessRevision(previousRevision) ? previousRevision : 0,
    state, revision: null, digest: null, readBackRevision: null, readBackDigest: null });
}
function boundDigests(input: BusinessOrganizationDocumentNativeAdmissionInput, proof: BusinessNativeActionAdmissionProof): boolean {
  return input.context.requestDigest === digest(input.context.request)
    && input.epoch.queryDigest === desktopBusinessQueryDigest(input.query) && proof.proofDigest === digest(input);
}
function originalDigests(admission: BusinessOrganizationDocumentNativeAdmission): boolean {
  return boundDigests(admission.admissionInput, admission.admissionProof)
    && admission.document.epoch.queryDigest === desktopBusinessQueryDigest(admission.document.query);
}
function readFallback(raw: unknown, state: 'denied' | 'unknown'): BusinessOrganizationDocumentReadResult {
  const targetId = value(value(raw, 'target'), 'resourceId');
  return Object.freeze({ state, targetId: isBusinessId(targetId) ? targetId : 'invalid-target', revision: null, digest: null, content: null });
}

/** Real production adapter, inactive until One supplies genuine authenticated ingress.
 * No network/client/token/environment/DB is created here. Transporting proof metadata
 * cannot replace the server's SAME current-owner admission/CAS/receipt transaction.
 * No function, body bytes or key values are included in either wire frame. */
export function createBusinessOrganizationDocumentTransport(
  owners: BusinessOrganizationDocumentTransportOwners,
  now: () => number = Date.now,
): BusinessOrganizationDocumentTransportAdapter {
  const identityOwner = owners.identity; const transportOwner = owners.transport;
  const identity = method<() => BusinessSession | null>(identityOwner, 'current');
  const ingress = method<() => BusinessSession | null>(transportOwner, 'authenticatedSession');
  const admissionCurrent = method<BusinessOrganizationDocumentTrustedTransport['currentAdmission']>(transportOwner, 'currentAdmission');
  const resultCurrent = method<BusinessOrganizationDocumentTrustedTransport['currentResult']>(transportOwner, 'currentResult');
  const post = method<(path: BusinessOrganizationDocumentPath, frame: Readonly<BusinessOrganizationDocumentFrame>) => Promise<unknown>>(transportOwner, 'post');
  let generation = 0; let pendingReads = 0;
  // Digest-only effect admission bookkeeping, not a grant/result cache. Never evict an
  // uncertain operation to make room for a retry; durable/restart dedupe is the owner.
  const attempted = new Map<string, string>();
  function blocker(): string | null {
    if (!identity) return 'business_document_identity_unbound';
    if (!post || !ingress || value(transportOwner, 'protocol') !== BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT) return 'business_document_transport_unbound';
    if (!admissionCurrent || !resultCurrent) return 'business_document_native_delivery_unbound';
    return null;
  }
  function liveAdmission(path: BusinessOrganizationDocumentPath, frame: BusinessOrganizationDocumentFrame): boolean {
    try { return admissionCurrent!(path, frame) === true; } catch { return false; }
  }
  function liveResult(path: BusinessOrganizationDocumentPath, frame: BusinessOrganizationDocumentFrame,
    response: BusinessOrganizationDocumentResponse | BusinessOrganizationDocumentReadResponse): boolean {
    try { return resultCurrent!(path, frame, response) === true; } catch { return false; }
  }
  function current(actor: BusinessSession): boolean {
    try {
      if (blocker() || !isBusinessSession(actor) || Date.parse(actor.expiresAt) <= now()) return false;
      const native = identity!(); const authenticated = ingress!();
      return isBusinessSession(native) && isBusinessSession(authenticated) && Date.parse(native.expiresAt) > now()
        && Date.parse(authenticated.expiresAt) > now() && sameBusinessSession(native, actor) && sameBusinessSession(authenticated, actor);
    } catch { return false; }
  }
  function originalKey(admission: BusinessOrganizationDocumentNativeAdmission): string {
    const s = admission.document.session;
    return digest([s.deploymentId, s.identityAuthorityId, s.organizationId, s.principalId, s.hostId, admission.document.operationId]);
  }
  async function commit(raw: Readonly<BusinessNativeActionDocumentAdmission>): Promise<BusinessNativeActionDocumentReceipt> {
    let original: BusinessOrganizationDocumentNativeAdmission | null = null; let started = false;
    try {
      if (!isBusinessOrganizationDocumentOriginalAdmission(raw) || !originalDigests(raw)) return fallback(raw, 'denied');
      const frame = frozen({ schema: BUSINESS_ORGANIZATION_DOCUMENT_TRANSPORT, admission: raw }); original = frame.admission;
      const stamp = generation; const actor = original.document.session;
      const key = originalKey(original); const frameDigest = digest(frame);
      const prior = attempted.get(key);
      if (prior !== undefined) return fallback(original, prior === frameDigest ? 'unknown' : 'denied');
      if (!isBusinessOrganizationDocumentCommitFrame(frame, now())) return fallback(original, 'denied');
      if (blocker()) return fallback(original, 'unknown');
      if (!current(actor) || !liveAdmission(BUSINESS_ORGANIZATION_DOCUMENT_COMMIT_PATH, frame)
        || stamp !== generation || !current(actor)) return fallback(original, 'denied');
      if (attempted.size >= 256) return fallback(original, 'unknown');
      // Mark immediately before the only potentially effective send. A lost response,
      // timeout, invalidate or duplicate never causes another commit in this factory.
      attempted.set(key, frameDigest); started = true;
      const result = await post!(BUSINESS_ORGANIZATION_DOCUMENT_COMMIT_PATH, frame);
      if (stamp !== generation || !current(actor) || !isBusinessOrganizationDocumentResponse(result)) return fallback(original, 'unknown');
      const response = frozen(result); const receipt = response.receipt;
      if (receipt.operationId !== original.document.operationId || receipt.targetId !== original.document.target.resourceId
        || receipt.previousRevision !== original.document.target.revision) return fallback(original, 'unknown');
      // The write CAS consumes its execution epoch. Only the existing owner's separate
      // CURRENT settled-result read authority may publish this new revision receipt.
      return liveResult(BUSINESS_ORGANIZATION_DOCUMENT_COMMIT_PATH, frame, response) && stamp === generation && current(actor)
        ? receipt : fallback(original, 'unknown');
    } catch { return fallback(original ?? raw, started ? 'unknown' : 'denied'); }
  }
  async function readReceipt(raw: Readonly<BusinessOrganizationDocumentRecoveryFrame>): Promise<BusinessNativeActionDocumentReceipt> {
    let original: BusinessOrganizationDocumentNativeAdmission | null = null; let started = false;
    try {
      if (!isBusinessOrganizationDocumentRecoveryFrame(raw, now()) || !originalDigests(raw.originalAdmission)
        || !boundDigests(raw.readAdmission.admissionInput, raw.readAdmission.admissionProof)) return fallback(value(raw, 'originalAdmission'), 'denied');
      const frame = frozen(raw); original = frame.originalAdmission;
      const stamp = generation; const actor = frame.readAdmission.admissionInput.session;
      if (blocker()) return fallback(original, 'unknown');
      if (!current(actor) || !liveAdmission(BUSINESS_ORGANIZATION_DOCUMENT_RECEIPT_PATH, frame)
        || stamp !== generation || !current(actor)) return fallback(original, 'denied');
      if (pendingReads >= 64) return fallback(original, 'unknown');
      pendingReads++; started = true;
      // Receipt path reads only the exact durable original intent/effect; even a valid
      // old write epoch is never sent to commit or treated as a current execution grant.
      const result = await post!(BUSINESS_ORGANIZATION_DOCUMENT_RECEIPT_PATH, frame);
      if (stamp !== generation || !current(actor) || !isBusinessOrganizationDocumentRecoveryFrame(frame, now())
        || !liveAdmission(BUSINESS_ORGANIZATION_DOCUMENT_RECEIPT_PATH, frame) || !isBusinessOrganizationDocumentResponse(result)) return fallback(original, 'unknown');
      const response = frozen(result); const receipt = response.receipt;
      if (receipt.operationId !== original.document.operationId || receipt.targetId !== original.document.target.resourceId
        || receipt.previousRevision !== original.document.target.revision) return fallback(original, 'unknown');
      return liveResult(BUSINESS_ORGANIZATION_DOCUMENT_RECEIPT_PATH, frame, response) && stamp === generation && current(actor)
        && isBusinessOrganizationDocumentRecoveryFrame(frame, now()) ? receipt : fallback(original, 'unknown');
    } catch { return fallback(original ?? value(raw, 'originalAdmission'), started ? 'unknown' : 'denied'); }
    finally { if (started) pendingReads--; }
  }
  async function readDocument(raw: Readonly<BusinessOrganizationDocumentReadFrame>): Promise<BusinessOrganizationDocumentReadResult> {
    let frame: BusinessOrganizationDocumentReadFrame | null = null; let started = false;
    try {
      if (!isBusinessOrganizationDocumentReadFrame(raw, now()) || !boundDigests(raw.readAdmission.admissionInput, raw.readAdmission.admissionProof)) return readFallback(raw, 'denied');
      frame = frozen(raw);
      const stamp = generation; const actor = frame.readAdmission.admissionInput.session;
      if (blocker()) return readFallback(frame, 'unknown');
      if (!current(actor) || !liveAdmission(BUSINESS_ORGANIZATION_DOCUMENT_READ_PATH, frame)
        || stamp !== generation || !current(actor)) return readFallback(frame, 'denied');
      if (pendingReads >= 64) return readFallback(frame, 'unknown');
      pendingReads++; started = true;
      const result = await post!(BUSINESS_ORGANIZATION_DOCUMENT_READ_PATH, frame);
      if (stamp !== generation || !current(actor) || !isBusinessOrganizationDocumentReadFrame(frame, now())
        || !liveAdmission(BUSINESS_ORGANIZATION_DOCUMENT_READ_PATH, frame) || !isBusinessOrganizationDocumentReadResponse(result, frame)) return readFallback(frame, 'unknown');
      if (result.result.state === 'read' && digest(result.result.content) !== result.result.digest) return readFallback(frame, 'unknown');
      const response = frozen(result);
      // Content validation/hash/copy can be large. Check current identity again at the
      // actual return boundary; no bytes are retained on expiry/revoke/invalidation.
      return liveResult(BUSINESS_ORGANIZATION_DOCUMENT_READ_PATH, frame, response) && stamp === generation && current(actor)
        && isBusinessOrganizationDocumentReadFrame(frame, now()) ? response.result : readFallback(frame, 'unknown');
    } catch { return readFallback(frame ?? raw, started ? 'unknown' : 'denied'); }
    finally { if (started) pendingReads--; }
  }
  return Object.freeze({ protocol: BUSINESS_NATIVE_ACTION_DOCUMENT_PROTOCOL, commit, readReceipt, readDocument, blocker,
    invalidate(): void { generation++; } } satisfies BusinessOrganizationDocumentTransportAdapter);
}
