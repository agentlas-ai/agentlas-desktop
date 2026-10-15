import { isBusinessId, isBusinessRevision, isBusinessSession, sameBusinessResource, sameBusinessSession,
  type BusinessResourceRef, type BusinessSession } from '../../shared/business/context';
import { isBusinessNativeArray, type BusinessRevisionMapping } from '../../shared/business/native-registry';
import { businessEmployeeAgentOnly, businessEmployeeAgentHex, BUSINESS_EMPLOYEE_AGENT_RECEIPT_SCHEMA,
  isBusinessEmployeeAgentReport, isBusinessEmployeeAgentReportRequest,
  type BusinessEmployeeAgentOrigin, type BusinessEmployeeAgentReport, type BusinessEmployeeAgentReceipt,
  type BusinessEmployeeAgentReportRequest } from '../../shared/business/employee-agent-report';
import { businessNativeStartupMatchesShared, type BusinessNativeStartupBindings, type BusinessNativeStartupSharedPorts } from './native-startup';
import { businessEmployeeAgentNativeDigest, createBusinessEmployeeAgentReportAdapter,
  BUSINESS_EMPLOYEE_AGENT_NATIVE_PROJECTION_PROTOCOL,
  type BusinessEmployeeAgentNativeProjectionOwner, type BusinessEmployeeAgentNativeScope } from './employee-agent-report-adapter';

export const BUSINESS_EMPLOYEE_AGENT_PRODUCER_PROTOCOL = 'agentlas.business.original-employee-report-producer.v1' as const;
export const BUSINESS_EMPLOYEE_AGENT_JOURNAL_PROTOCOL = 'agentlas.business.original-employee-report-journal.v1' as const;
export const BUSINESS_EMPLOYEE_AGENT_PUBLISHER_PROTOCOL = 'agentlas.business.original-employee-report-publisher.v1' as const;
export const BUSINESS_EMPLOYEE_AGENT_APPROVED_PACKET_SCHEMA = 'agentlas.business.employee-agent-approved-packet.v1' as const;
export type BusinessEmployeeAgentProducerState = 'published' | 'unchanged' | 'unknown' | 'paused' | 'revoked' | 'denied' | 'unavailable';
export interface BusinessEmployeeAgentProducerResult {
  readonly state: BusinessEmployeeAgentProducerState; readonly reason: string; readonly receipt: BusinessEmployeeAgentReceipt | null;
}
/** Actual native identity remains distinct from the Root organization session. No
 * caller/session/profile/email association is inferred or minted by this consumer. */
export interface BusinessEmployeeAgentNativeActor {
  readonly principalId: string; readonly sessionId: string; readonly workspaceId: string; readonly oneId: string; readonly hostId: string;
}
export interface BusinessEmployeeAgentNativeAssociation {
  readonly origin: BusinessEmployeeAgentOrigin; readonly consent: BusinessEmployeeAgentOrigin;
  readonly organizationSession: BusinessSession; readonly nativeActor: BusinessEmployeeAgentNativeActor;
  readonly agentResource: BusinessResourceRef;
}
/** Exact Web approved-packet metadata contract. Only the genuine source owner
 * selects these existing IDs/revisions; this adapter derives none from a body,
 * report hash, local profile, org UUID or timestamp. */
export interface BusinessEmployeeAgentApprovedNativeOriginal {
  readonly authorityId: string; readonly recordId: string; readonly revision: string;
  readonly nativeAccountId: string; readonly nativeSessionId: string; readonly nativeSessionRevision: string;
  readonly nativeHostId: string; readonly oneId: string; readonly profileRevision: string; readonly enrollment: BusinessEmployeeAgentOrigin;
  readonly work: { readonly taskId: string; readonly runId: string; readonly commandId: string; readonly occurrenceId: string;
    readonly controlVersion: string; readonly canonicalControlRevision: number; readonly invocationLeaseId: string;
    readonly inputRef: string; readonly inputRevision: string; readonly inputDigest: string };
  readonly acceptedReceiptId: string; readonly acceptedDigest: string;
}
/** Metadata from the genuine original accepted command/result owner, not from a
 * renderer body. Completed results require separate current result-read custody. */
export interface BusinessEmployeeAgentNativeAcceptedOriginal {
  readonly event: BusinessEmployeeAgentOrigin; readonly association: BusinessEmployeeAgentNativeAssociation;
  readonly original: { readonly actor: BusinessEmployeeAgentNativeActor; readonly commandId: string; readonly taskId: string;
    readonly runId: string; readonly controlVersion: string; readonly chatId: string; readonly originChatId: string;
    readonly leaseId: string; readonly payloadHash: string; readonly nativeInputDigest: string };
  readonly acceptedReceipt: BusinessEmployeeAgentOrigin;
  readonly sourcePacket: { readonly selector: { readonly packetId: string; readonly packetRevision: string };
    readonly original: BusinessEmployeeAgentApprovedNativeOriginal };
}
export interface BusinessEmployeeAgentNativePacket {
  readonly schema: typeof BUSINESS_EMPLOYEE_AGENT_PRODUCER_PROTOCOL;
  readonly original: BusinessEmployeeAgentNativeAcceptedOriginal; readonly request: BusinessEmployeeAgentReportRequest;
  readonly report: BusinessEmployeeAgentReport; readonly reportDigest: string; readonly contentDigest: string;
  readonly approved: { readonly schema: typeof BUSINESS_EMPLOYEE_AGENT_APPROVED_PACKET_SCHEMA;
    readonly selector: BusinessEmployeeAgentNativeAcceptedOriginal['sourcePacket']['selector'];
    readonly original: BusinessEmployeeAgentApprovedNativeOriginal; readonly report: BusinessEmployeeAgentReport };
  /** Metadata of the consumed projection, NEVER a dispatch capability or cached allow. */
  readonly admission: { readonly fenceId: string; readonly authorityRevision: number; readonly queryDigest: string };
  readonly registry: Pick<BusinessRevisionMapping, 'bindingId' | 'canonicalControlRevision' | 'resources'>;
}
export type BusinessEmployeeAgentNativeCheckpoint =
  | { readonly state: 'delivery'; readonly handle: object }
  | { readonly state: 'absent' | 'unchanged' | 'paused' | 'revoked' | 'unknown' | 'denied' };
export interface BusinessEmployeeAgentNativeDelivery {
  readonly packet: BusinessEmployeeAgentNativePacket; readonly packetDigest: string;
  readonly status: 'ready' | 'attempted' | 'unknown' | 'settled'; readonly receipt: BusinessEmployeeAgentReceipt | null;
}
export interface BusinessEmployeeAgentAcceptedChangeOwner {
  readonly protocol: typeof BUSINESS_EMPLOYEE_AGENT_PRODUCER_PROTOCOL;
  /** Existing owner callback/capability registry only. A store-change notification
   * or its IDs alone are not an accepted event, original caller or sharing grant. */
  subscribeAccepted(listener: (capability: object) => void): () => void;
  currentStatus(capability: object): 'active' | 'paused' | 'revoked' | 'unknown';
  /** Called synchronously INSIDE the original withCurrentProjection reducer.
   * Verify the exact opaque capability, authenticated enrollment association,
   * original accepted command/caller and current source/consent/audience there.
   * Returning metadata does not create authority or register a source. */
  captureCurrent(capability: object, scope: Readonly<BusinessEmployeeAgentNativeScope>): BusinessEmployeeAgentNativeAcceptedOriginal | null;
  resolveRequest(capability: object): BusinessEmployeeAgentReportRequest | null;
}
export interface BusinessEmployeeAgentNativeJournal {
  readonly protocol: typeof BUSINESS_EMPLOYEE_AGENT_JOURNAL_PROTOCOL;
  /** Durable original delivery/effect receipts, NOT an execution queue. lookup
   * proves current original event identity, association and exact stored pins;
   * absent is an authoritative empty state. Errors/uncertainty are not absent. */
  lookupCurrent(capability: object): Promise<BusinessEmployeeAgentNativeCheckpoint>;
  /** SAME existing source-owner serialized reducer/CAS lease; no independent SQL
   * snapshot or grant. Dedupe by original event and compare approved content AND
   * source/consent/audience versions before returning unchanged. Never overwrite
   * an attempted/unknown original delivery or synthesize an effect receipt. */
  checkpointCurrent(capability: object, scope: Readonly<BusinessEmployeeAgentNativeScope>, packet: Readonly<BusinessEmployeeAgentNativePacket>): BusinessEmployeeAgentNativeCheckpoint;
  inspectCurrent(capability: object, handle: object): Promise<BusinessEmployeeAgentNativeDelivery | null>;
  /** Atomically mark first dispatch in the ORIGINAL durable journal BEFORE submit.
   * Verify current enrollment/source/consent/status in the owner's serialization.
   * No attempted/unknown record may claim again, including another process. */
  beginAttemptCurrent(capability: object, handle: object, packetDigest: string): Promise<boolean>;
  holdUnknown(capability: object, handle: object): Promise<void>;
  /** Current original result-read authorization and exact receipt/CAS identity;
   * settlement grants no dispatch and must not reopen the projection epoch. */
  settleCurrent(capability: object, handle: object, packetDigest: string, receipt: Readonly<BusinessEmployeeAgentReceipt>): Promise<boolean>;
}
/** Exact public service get() projection. The full original report stays in packet;
 * immutable stored-state digest includes report, revision, state, audience and null
 * nativeControl for an active report. No personal source snapshot is read back. */
export type BusinessEmployeeAgentNativeReadBack = Pick<BusinessEmployeeAgentReport,
  'schema' | 'agentId' | 'employeePrincipalId' | 'profileRevision' | 'reportId' | 'reportRevision' | 'producedAt' | 'expiresAt'
  | 'persona' | 'skills' | 'memory' | 'artifacts' | 'audiencePrincipalIds'> & {
    readonly agentResourceId: string; readonly revision: number; readonly state: 'reported'; readonly reportDigest: string;
  };
export type BusinessEmployeeAgentNativePublication =
  | { readonly state: 'confirmed'; readonly receipt: BusinessEmployeeAgentReceipt; readonly readBack: BusinessEmployeeAgentNativeReadBack }
  | { readonly state: 'unknown' | 'missing' | 'denied' | 'paused' | 'revoked' };
export interface BusinessEmployeeAgentNativePublisher {
  readonly protocol: typeof BUSINESS_EMPLOYEE_AGENT_PUBLISHER_PROTOCOL;
  /** Genuine registered native ingress/source receiver and Root SAME Mongo report
   * admission. The report API accepts packet.request selector only; approved packet
   * enters only the trusted original source registry, never browser-authored proof.
   * This callback performs no new login, token, source, key or collector setup. */
  submitOriginal(handle: object, packet: Readonly<BusinessEmployeeAgentNativePacket>): Promise<BusinessEmployeeAgentNativePublication>;
  /** Read-only exact original full-selector receipt lookup; missing is held unknown,
   * never a reason to resend a possibly committed publication. */
  lookupOriginal(handle: object, packet: Readonly<BusinessEmployeeAgentNativePacket>): Promise<BusinessEmployeeAgentNativePublication>;
  /** Independent current original receipt/read-back + source/audience ACL authority.
   * Do not use the old execution epoch, generic read grant or cached allowed reply. */
  currentResult(handle: object, packet: Readonly<BusinessEmployeeAgentNativePacket>, result: Readonly<BusinessEmployeeAgentNativePublication>): boolean;
}
function refuse(): never { throw Error('employee_agent_original_report_binding_required'); }
function origin(v: unknown): v is BusinessEmployeeAgentOrigin {
  return businessEmployeeAgentOnly(v, ['authorityId', 'recordId', 'revision']) && [v.authorityId, v.recordId, v.revision].every(isBusinessId);
}
function actor(v: unknown): v is BusinessEmployeeAgentNativeActor {
  return businessEmployeeAgentOnly(v, ['principalId', 'sessionId', 'workspaceId', 'oneId', 'hostId']) && Object.values(v).every(isBusinessId);
}
function clone<T>(v: T): T {
  const copy = structuredClone(v);
  const freeze = (value: unknown): void => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
  freeze(copy); return copy;
}
function data(v: unknown): boolean {
  const seen = new Set<object>(); let remaining = 50_000;
  const visit = (value: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 25) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 16_384;
    if (typeof value === 'number') return isBusinessRevision(value);
    if (!value || typeof value !== 'object' || seen.has(value)
      || (Array.isArray(value) ? !isBusinessNativeArray(value, 128) : Object.getPrototypeOf(value) !== Object.prototype)) return false;
    seen.add(value);
    try { return Reflect.ownKeys(value).every(key => typeof key === 'string' && (Array.isArray(value) && key === 'length'
      || Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value') && visit(Object.getOwnPropertyDescriptor(value, key)!.value, depth + 1))); }
    finally { seen.delete(value); }
  };
  try { return visit(v, 0); } catch { return false; }
}
function equal(a: unknown, b: unknown): boolean { return businessEmployeeAgentNativeDigest(a) === businessEmployeeAgentNativeDigest(b); }
/** Sessions/transport timestamps do not change approved content. Enrollment and
 * consent revisions plus exact native/canonical identity, sources and audience do. */
export function businessEmployeeAgentReportContentDigest(original: BusinessEmployeeAgentNativeAcceptedOriginal, report: BusinessEmployeeAgentReport): string {
  const a = original.association, s = a.organizationSession, n = a.nativeActor;
  return businessEmployeeAgentNativeDigest({ enrollment: a.origin, consent: a.consent,
    organizationIdentity: { deploymentId: s.deploymentId, identityAuthorityId: s.identityAuthorityId, organizationId: s.organizationId, principalId: s.principalId, hostId: s.hostId },
    nativeIdentity: { principalId: n.principalId, workspaceId: n.workspaceId, oneId: n.oneId, hostId: n.hostId },
    profileRevision: report.profileRevision, origin: report.origin, agentResource: report.agentResource,
    persona: report.persona, skills: report.skills, memory: report.memory, artifacts: report.artifacts, audiencePrincipalIds: report.audiencePrincipalIds });
}
function packet(original: BusinessEmployeeAgentNativeAcceptedOriginal, scope: Readonly<BusinessEmployeeAgentNativeScope>, report: BusinessEmployeeAgentReport): BusinessEmployeeAgentNativePacket {
  if (!data(original) || !businessEmployeeAgentOnly(original, ['event', 'association', 'original', 'acceptedReceipt', 'sourcePacket']) || !origin(original.event)
    || !origin(original.acceptedReceipt) || !businessEmployeeAgentOnly(original.association, ['origin', 'consent', 'organizationSession', 'nativeActor', 'agentResource'])
    || !origin(original.association.origin) || !origin(original.association.consent) || !actor(original.association.nativeActor)
    || !isBusinessSession(original.association.organizationSession) || !sameBusinessSession(original.association.organizationSession, scope.session)
    || !sameBusinessResource(original.association.agentResource, report.agentResource)) return refuse();
  const work = original.original, native = original.association.nativeActor;
  if (!businessEmployeeAgentOnly(work, ['actor', 'commandId', 'taskId', 'runId', 'controlVersion', 'chatId', 'originChatId', 'leaseId', 'payloadHash', 'nativeInputDigest'])
    || !actor(work.actor) || !equal(work.actor, native) || native.oneId !== report.agentId || native.hostId !== scope.session.hostId
    || ![work.commandId, work.taskId, work.runId, work.controlVersion, work.chatId, work.originChatId, work.leaseId].every(isBusinessId)
    || !businessEmployeeAgentHex(work.payloadHash) || !businessEmployeeAgentHex(work.nativeInputDigest)
    || scope.work.kind !== 'task' || work.commandId !== scope.work.commandId || work.taskId !== scope.work.taskId
    || work.runId !== scope.work.runId || work.controlVersion !== scope.work.controlVersion) return refuse();
  const sourcePacket = original.sourcePacket, accepted = sourcePacket.original, acceptedWork = accepted.work;
  if (!businessEmployeeAgentOnly(sourcePacket, ['selector', 'original']) || !businessEmployeeAgentOnly(sourcePacket.selector, ['packetId', 'packetRevision'])
    || !Object.values(sourcePacket.selector).every(isBusinessId)
    || !businessEmployeeAgentOnly(accepted, ['authorityId', 'recordId', 'revision', 'nativeAccountId', 'nativeSessionId', 'nativeSessionRevision', 'nativeHostId',
      'oneId', 'profileRevision', 'enrollment', 'work', 'acceptedReceiptId', 'acceptedDigest'])
    || ![accepted.authorityId, accepted.recordId, accepted.revision, accepted.nativeAccountId, accepted.nativeSessionId, accepted.nativeSessionRevision,
      accepted.nativeHostId, accepted.oneId, accepted.profileRevision, accepted.acceptedReceiptId].every(isBusinessId)
    || accepted.authorityId !== original.event.authorityId || accepted.recordId !== original.event.recordId || accepted.revision !== original.event.revision
    || accepted.nativeAccountId !== native.principalId || accepted.nativeSessionId !== native.sessionId || accepted.nativeHostId !== native.hostId
    || accepted.oneId !== report.agentId || accepted.profileRevision !== report.profileRevision
    || !origin(accepted.enrollment) || !equal(accepted.enrollment, original.association.origin)
    || accepted.acceptedReceiptId !== original.acceptedReceipt.recordId || !businessEmployeeAgentHex(accepted.acceptedDigest)
    || !businessEmployeeAgentOnly(acceptedWork, ['taskId', 'runId', 'commandId', 'occurrenceId', 'controlVersion', 'canonicalControlRevision', 'invocationLeaseId', 'inputRef', 'inputRevision', 'inputDigest'])
    || ![acceptedWork.taskId, acceptedWork.runId, acceptedWork.commandId, acceptedWork.occurrenceId, acceptedWork.controlVersion,
      acceptedWork.invocationLeaseId, acceptedWork.inputRef, acceptedWork.inputRevision].every(isBusinessId)
    || acceptedWork.taskId.startsWith('session:') || acceptedWork.runId.startsWith('session:')
    || acceptedWork.taskId !== work.taskId || acceptedWork.runId !== work.runId || acceptedWork.commandId !== work.commandId
    || acceptedWork.occurrenceId !== scope.work.occurrenceId || acceptedWork.controlVersion !== work.controlVersion
    || acceptedWork.canonicalControlRevision !== scope.mapping.canonicalControlRevision || acceptedWork.invocationLeaseId !== work.leaseId
    || !isBusinessRevision(acceptedWork.canonicalControlRevision) || acceptedWork.inputDigest !== work.nativeInputDigest) return refuse();
  // Native actor.sessionId may differ from organizationSession.sessionId. Their
  // EXACT current authenticated association is supplied by the original owner.
  const contentDigest = businessEmployeeAgentReportContentDigest(original, report);
  return clone({ schema: BUSINESS_EMPLOYEE_AGENT_PRODUCER_PROTOCOL, original, request: scope.request, report,
    reportDigest: businessEmployeeAgentNativeDigest(report), contentDigest,
    approved: { schema: BUSINESS_EMPLOYEE_AGENT_APPROVED_PACKET_SCHEMA, selector: sourcePacket.selector, original: accepted, report },
    admission: { fenceId: scope.epoch.fenceId, authorityRevision: scope.epoch.authorityRevision, queryDigest: scope.epoch.queryDigest },
    registry: { bindingId: scope.mapping.bindingId, canonicalControlRevision: scope.mapping.canonicalControlRevision, resources: scope.mapping.resources } });
}
function confirmed(packet: BusinessEmployeeAgentNativePacket, result: BusinessEmployeeAgentNativePublication): result is Extract<BusinessEmployeeAgentNativePublication, { state: 'confirmed' }> {
  if (!data(result) || !businessEmployeeAgentOnly(result, ['state', 'receipt', 'readBack']) || result.state !== 'confirmed') return false;
  const r = result.receipt, p = packet.report;
  if (!businessEmployeeAgentOnly(r, ['schema', 'receiptId', 'agentResourceId', 'agentId', 'employeePrincipalId', 'kind', 'revision', 'reportDigest', 'readBackDigest', 'state', 'nativeReceiptId', 'replayed'])
    || r.schema !== BUSINESS_EMPLOYEE_AGENT_RECEIPT_SCHEMA || !isBusinessId(r.receiptId) || r.agentResourceId !== p.agentResource.resourceId
    || r.agentId !== p.agentId || r.employeePrincipalId !== p.employeePrincipalId || r.kind !== 'report' || r.state !== 'reported'
    || r.nativeReceiptId !== null || typeof r.replayed !== 'boolean' || !isBusinessRevision(r.revision)
    || r.revision !== (packet.request.expectedRevision === null ? 0 : packet.request.expectedRevision + 1)
    || r.reportDigest !== packet.reportDigest || !businessEmployeeAgentHex(r.readBackDigest)) return false;
  const expected = { schema: p.schema, agentResourceId: p.agentResource.resourceId, agentId: p.agentId,
    employeePrincipalId: p.employeePrincipalId, revision: r.revision, state: 'reported', profileRevision: p.profileRevision,
    reportId: p.reportId, reportRevision: p.reportRevision, reportDigest: packet.reportDigest, producedAt: p.producedAt, expiresAt: p.expiresAt,
    audiencePrincipalIds: p.audiencePrincipalIds, persona: p.persona, skills: p.skills, memory: p.memory, artifacts: p.artifacts };
  if (!businessEmployeeAgentOnly(result.readBack, Object.keys(expected)) || !equal(result.readBack, expected)) return false;
  return r.readBackDigest === businessEmployeeAgentNativeDigest({ report: p, reportDigest: packet.reportDigest, revision: r.revision,
    state: 'reported', audiencePrincipalIds: p.audiencePrincipalIds, nativeControl: null });
}

/** Inert substantive receiver/producer. All source/checkpoint/permission operations
 * remain with their ORIGINAL supplied owners. No DB, event queue, Supervisor work,
 * timer, profile enumeration, observation, Builder, model or transport is created. */
export function createBusinessEmployeeAgentReportProducer(input: {
  readonly shared: Readonly<BusinessNativeStartupSharedPorts>; readonly originalBusiness: BusinessNativeStartupBindings | null;
  readonly projection: BusinessEmployeeAgentNativeProjectionOwner | null; readonly source: BusinessEmployeeAgentAcceptedChangeOwner | null;
  readonly journal: BusinessEmployeeAgentNativeJournal | null; readonly publisher: BusinessEmployeeAgentNativePublisher | null;
  readonly lifetime: { readonly signal: AbortSignal; current(): boolean } | null;
}, now: () => number = Date.now) {
  const { shared, originalBusiness, projection, source, journal, publisher, lifetime } = input;
  const refs = () => [input.shared, input.originalBusiness, input.projection, input.source, input.journal, input.publisher, input.lifetime,
    shared.sessions, shared.identity, shared.authority, shared.registry, projection?.withCurrentProjection, projection?.currentResult,
    shared.sessions.current, shared.identity?.current, shared.authority?.currentDecision, shared.authority?.stillCurrent, shared.registry?.current,
    projection?.protocol, projection?.authority, projection?.registry, source?.protocol, journal?.protocol, publisher?.protocol,
    source?.subscribeAccepted, source?.currentStatus, source?.captureCurrent, source?.resolveRequest,
    journal?.lookupCurrent, journal?.checkpointCurrent, journal?.inspectCurrent, journal?.beginAttemptCurrent, journal?.holdUnknown, journal?.settleCurrent,
    publisher?.submitOriginal, publisher?.lookupOriginal, publisher?.currentResult, lifetime?.signal, lifetime?.current];
  const originalRefs = refs(); let generation = 0, closed = false, invalidated = false, attached = false, cleanupUnknown = false, stop: (() => void) | null = null;
  const active = new WeakMap<object, Promise<BusinessEmployeeAgentProducerResult>>(); let activeCount = 0;
  function result(state: BusinessEmployeeAgentProducerState, reason: string, receipt: BusinessEmployeeAgentReceipt | null = null): BusinessEmployeeAgentProducerResult {
    return Object.freeze({ state, reason, receipt });
  }
  function blocker(): string | null {
    if (closed || invalidated || cleanupUnknown || refs().some((v, i) => v !== originalRefs[i])) return 'employee_agent_producer_lifetime_unavailable';
    if (!originalBusiness || !businessNativeStartupMatchesShared(originalBusiness, shared)) return 'employee_agent_original_startup_unbound';
    if (!projection || projection.protocol !== BUSINESS_EMPLOYEE_AGENT_NATIVE_PROJECTION_PROTOCOL
      || projection.authority !== shared.authority || projection.registry !== shared.registry
      || typeof projection.withCurrentProjection !== 'function' || typeof projection.currentResult !== 'function'
      || !source || source.protocol !== BUSINESS_EMPLOYEE_AGENT_PRODUCER_PROTOCOL
      || ['subscribeAccepted', 'currentStatus', 'captureCurrent', 'resolveRequest'].some(k => typeof (source as unknown as Record<string, unknown>)[k] !== 'function')) return 'employee_agent_accepted_source_unbound';
    if (!journal || journal.protocol !== BUSINESS_EMPLOYEE_AGENT_JOURNAL_PROTOCOL
      || ['lookupCurrent', 'checkpointCurrent', 'inspectCurrent', 'beginAttemptCurrent', 'holdUnknown', 'settleCurrent'].some(k => typeof (journal as unknown as Record<string, unknown>)[k] !== 'function')) return 'employee_agent_durable_delivery_journal_unbound';
    if (!publisher || publisher.protocol !== BUSINESS_EMPLOYEE_AGENT_PUBLISHER_PROTOCOL
      || ['submitOriginal', 'lookupOriginal', 'currentResult'].some(k => typeof (publisher as unknown as Record<string, unknown>)[k] !== 'function')) return 'employee_agent_original_publisher_unbound';
    if (!lifetime || typeof lifetime.current !== 'function' || lifetime.signal.aborted) return 'employee_agent_original_lifetime_unbound';
    return null;
  }
  function gate(capability: object, stamp: number, p?: BusinessEmployeeAgentNativePacket): BusinessEmployeeAgentProducerState | null {
    try {
      if (stamp !== generation || blocker() || lifetime!.signal.aborted || lifetime!.current() !== true) return 'unavailable';
      const identity = shared.identity?.current();
      if (!isBusinessSession(identity) || Date.parse(identity.expiresAt) <= now()
        || p && !sameBusinessSession(identity, p.original.association.organizationSession)) return 'denied';
      const status = source!.currentStatus(capability);
      return status === 'active' ? null : status === 'paused' || status === 'revoked' ? status : 'unknown';
    } catch { return 'unknown'; }
  }
  function checkpoint(value: unknown): value is BusinessEmployeeAgentNativeCheckpoint {
    return (businessEmployeeAgentOnly(value, ['state', 'handle']) || businessEmployeeAgentOnly(value, ['state']))
      && (value.state === 'delivery' ? !!value.handle && typeof value.handle === 'object'
        : ['absent', 'unchanged', 'paused', 'revoked', 'unknown', 'denied'].includes(value.state as string));
  }
  const interrupted = (state: BusinessEmployeeAgentProducerState) => result(state, 'employee_agent_original_delivery_held');
  async function hold(capability: object, handle: object): Promise<BusinessEmployeeAgentProducerResult> {
    try { await journal!.holdUnknown(capability, handle); } catch { /* Original uncertainty remains held; never submit again. */ }
    return result('unknown', 'employee_agent_original_receipt_unconfirmed');
  }
  async function deliver(capability: object, handle: object, stamp: number): Promise<BusinessEmployeeAgentProducerResult> {
    let blocked = gate(capability, stamp); if (blocked) return interrupted(blocked);
    const d = await journal!.inspectCurrent(capability, handle);
    if (!data(d) || !businessEmployeeAgentOnly(d, ['packet', 'packetDigest', 'status', 'receipt']) || !d
      || !businessEmployeeAgentHex(d.packetDigest) || d.packetDigest !== businessEmployeeAgentNativeDigest(d.packet)
      || !['ready', 'attempted', 'unknown', 'settled'].includes(d.status)) return result('unknown', 'employee_agent_original_journal_record_unconfirmed');
    const p = clone(d.packet);
    if (!businessEmployeeAgentOnly(p, ['schema', 'original', 'request', 'report', 'reportDigest', 'contentDigest', 'approved', 'admission', 'registry'])
      || p.schema !== BUSINESS_EMPLOYEE_AGENT_PRODUCER_PROTOCOL || p.reportDigest !== businessEmployeeAgentNativeDigest(p.report)
      || !isBusinessEmployeeAgentReportRequest(p.request) || !isBusinessEmployeeAgentReport(p.report, p.original.association.organizationSession, now())
      || p.request.agentResourceId !== p.report.agentResource.resourceId || p.request.ownerReportId !== p.report.reportId
      || p.contentDigest !== businessEmployeeAgentReportContentDigest(p.original, p.report)
      || !businessEmployeeAgentOnly(p.approved, ['schema', 'selector', 'original', 'report']) || p.approved.schema !== BUSINESS_EMPLOYEE_AGENT_APPROVED_PACKET_SCHEMA
      || !equal(p.approved.report, p.report) || !equal(p.approved.selector, p.original.sourcePacket.selector) || !equal(p.approved.original, p.original.sourcePacket.original)
      || !isBusinessNativeArray(p.registry.resources, 64) || p.report.employeePrincipalId !== p.original.association.organizationSession.principalId)
      return result('unknown', 'employee_agent_original_journal_record_unconfirmed');
    blocked = gate(capability, stamp, p); if (blocked) return interrupted(blocked);
    let response: BusinessEmployeeAgentNativePublication;
    try {
      if (d.status === 'ready') {
        const first = await journal!.beginAttemptCurrent(capability, handle, d.packetDigest);
        if (!first) { await hold(capability, handle); return result('unknown', 'employee_agent_original_attempt_already_claimed'); }
        blocked = gate(capability, stamp, p); if (blocked) { await hold(capability, handle); return interrupted(blocked); }
        response = await publisher!.submitOriginal(handle, p);
      } else {
        // An attempted/unknown/settled original is NEVER dispatched again.
        response = await publisher!.lookupOriginal(handle, p);
      }
    } catch { return hold(capability, handle); }
    blocked = gate(capability, stamp, p); if (blocked) { await hold(capability, handle); return interrupted(blocked); }
    if (!confirmed(p, response) || publisher!.currentResult(handle, p, response) !== true) return hold(capability, handle);
    if (d.status === 'settled' && !d.receipt || d.receipt && !equal({ ...d.receipt, replayed: false }, { ...response.receipt, replayed: false })) return hold(capability, handle);
    if (!await journal!.settleCurrent(capability, handle, d.packetDigest, clone(response.receipt))) return hold(capability, handle);
    blocked = gate(capability, stamp, p); if (blocked) return interrupted(blocked);
    if (publisher!.currentResult(handle, p, response) !== true) return result('unknown', 'employee_agent_current_receipt_read_required');
    return result('published', 'employee_agent_original_report_confirmed', clone(response.receipt));
  }
  async function receiveOriginal(capability: object): Promise<BusinessEmployeeAgentProducerResult> {
    const stamp = generation; let blocked = gate(capability, stamp); if (blocked) return interrupted(blocked);
    try {
      const saved = await journal!.lookupCurrent(capability);
      if (!checkpoint(saved)) return result('unknown', 'employee_agent_original_journal_lookup_unknown');
      blocked = gate(capability, stamp); if (blocked) return interrupted(blocked);
      if (saved.state === 'delivery') return deliver(capability, saved.handle, stamp);
      if (saved.state !== 'absent') return interrupted(saved.state);
      const request = source!.resolveRequest(capability); if (!request) return result('denied', 'employee_agent_original_request_unbound');
      let written: BusinessEmployeeAgentNativeCheckpoint | null = null, attempts = 0;
      const consumer: BusinessEmployeeAgentNativeProjectionOwner = { protocol: projection!.protocol, authority: projection!.authority, registry: projection!.registry,
        withCurrentProjection: (i, derive) => projection!.withCurrentProjection(i, scope => {
          if (++attempts !== 1 || gate(capability, stamp)) return refuse();
          // The committed adapter validates the REAL original epoch/query/work and
          // closes escaped reducers before this source owner can be consulted.
          const value = derive(scope);
          const original = source!.captureCurrent(capability, scope); if (!original) return refuse();
          const p = packet(original, scope, value.report);
          if (scope.current() !== true || gate(capability, stamp, p)) return refuse();
          written = journal!.checkpointCurrent(capability, scope, p);
          if (!checkpoint(written) || written.state === 'absent' || scope.current() !== true || gate(capability, stamp, p)) return refuse();
          return value;
        }), currentResult: (i, value) => projection!.currentResult(i, value), };
      const adapter = createBusinessEmployeeAgentReportAdapter({ shared, originalBusiness, owner: consumer }, now);
      const prepared = await adapter.prepare(request); blocked = gate(capability, stamp); if (blocked) return interrupted(blocked);
      const outcome = written as BusinessEmployeeAgentNativeCheckpoint | null;
      if (prepared.state !== 'prepared' || !prepared.projection || !outcome || attempts !== 1) return result('unknown', 'employee_agent_original_projection_unconfirmed');
      return outcome.state === 'delivery' ? deliver(capability, outcome.handle, stamp) : interrupted(outcome.state === 'absent' ? 'unknown' : outcome.state);
    } catch { return result('unknown', 'employee_agent_original_delivery_unconfirmed'); }
  }
  function receive(capability: object): Promise<BusinessEmployeeAgentProducerResult> {
    if (!capability || typeof capability !== 'object') return Promise.resolve(result('denied', 'employee_agent_original_capability_required'));
    const prior = active.get(capability); if (prior) return prior;
    if (activeCount >= 16) return Promise.resolve(result('unknown', 'employee_agent_delivery_consumer_busy'));
    activeCount++; const pending = receiveOriginal(capability).catch(() => result('unknown', 'employee_agent_original_delivery_unconfirmed'))
      .finally(() => { active.delete(capability); activeCount--; });
    active.set(capability, pending); return pending;
  }
  function invalidate() {
    generation++; invalidated = true; if (stop) { const release = stop; stop = null; try { release(); } catch { cleanupUnknown = true; } }
  }
  return Object.freeze({ blocker, receive,
    /** Once-only original source callback; absence never starts a collector. */
    attach() {
      if (attached) return !blocker(); if (blocker()) return false;
      try { const release = source!.subscribeAccepted(cap => { void receive(cap); });
        if (typeof release !== 'function') { cleanupUnknown = true; return false; } stop = release; attached = true;
        lifetime!.signal.addEventListener('abort', invalidate, { once: true }); return true;
      } catch { cleanupUnknown = true; return false; }
    },
    invalidate,
    close() { closed = true; invalidate(); },
  });
}
