import { createHash } from 'node:crypto';
import { isOneProfile, type OneProfile } from '../../shared/one-profile';
import { isOneMemoryState, type OneMemoryAsset } from '../../shared/one-memory';
import type { HistoryEvolutionDraft, HistoryEvolutionEvaluation } from '../../shared/one-history-evolution';
import { isBusinessEpoch, isBusinessId, isBusinessQuery, isBusinessSession, sameBusinessResource, sameBusinessSession,
  type BusinessEpoch, type BusinessQuery, type BusinessSession } from '../../shared/business/context';
import { businessRevisionMappingMatchesRequest, isBusinessNativeArray, isBusinessNativeWork, isBusinessRevisionMapping,
  type BusinessNativeWork, type BusinessRevisionMapping } from '../../shared/business/native-registry';
import { BUSINESS_EMPLOYEE_AGENT_REPORT_SCHEMA, businessEmployeeAgentOnly, businessEmployeeAgentHex,
  isBusinessEmployeeAgentBinding, isBusinessEmployeeAgentReport, isBusinessEmployeeAgentReportRequest,
  type BusinessEmployeeAgentBinding, type BusinessEmployeeAgentReport, type BusinessEmployeeAgentSource,
  type BusinessEmployeeAgentReportRequest, type BusinessEmployeeAgentPersona,
  type BusinessEmployeeAgentSkill, type BusinessEmployeeAgentMemory, type BusinessEmployeeAgentArtifact } from '../../shared/business/employee-agent-report';
import { businessNativeStartupMatchesShared, type BusinessNativeStartupBindings, type BusinessNativeStartupSharedPorts } from './native-startup';
import { desktopBusinessQueryDigest } from './policy-adapter';

export const BUSINESS_EMPLOYEE_AGENT_NATIVE_PROJECTION_PROTOCOL = 'agentlas.business.serialized-employee-agent-projection.v1' as const;
type NativeKind = 'profile' | 'skill' | 'toolchain' | 'agent' | 'memory' | 'page' | 'space' | 'file';
/** Explicit existing native-record to reviewed organization-source correspondence.
 * This value is not registration, employee ownership, a receipt or a current grant. */
export interface BusinessEmployeeAgentNativeOrigin {
  readonly kind: NativeKind; readonly recordId: string; readonly versionId: string; readonly digest: string;
}
interface NativeSelection {
  readonly original: BusinessEmployeeAgentNativeOrigin; readonly source: BusinessEmployeeAgentSource;
  readonly label: string; readonly summary: string;
}
export interface BusinessEmployeeAgentNativeSnapshot {
  readonly binding: BusinessEmployeeAgentBinding; readonly producedAt: string; readonly expiresAt: string;
  readonly audiencePrincipalIds: readonly string[];
  /** The original profile stays in-process. profileContext, private principles, paths,
   * locale and device preferences are never copied, hashed or returned by this adapter. */
  readonly persona: { readonly profile: OneProfile; readonly fields: readonly ('displayName' | 'role')[];
    readonly summary: string; readonly original: BusinessEmployeeAgentNativeOrigin; readonly source: BusinessEmployeeAgentSource };
  readonly skills: readonly (NativeSelection & { readonly draft: HistoryEvolutionDraft; readonly evaluation: HistoryEvolutionEvaluation })[];
  readonly memory: readonly (NativeSelection & { readonly kind: BusinessEmployeeAgentMemory['kind']; readonly asset: OneMemoryAsset })[];
  /** Exact original owner read-back references only. No local paths, file bytes or
   * arbitrary file enumeration. Genuine Main/domain ownership is checked by the owner. */
  readonly artifacts: readonly (NativeSelection & { readonly reference: { readonly kind: 'page' | 'space' | 'file';
    readonly recordId: string; readonly versionId: string; readonly digest: string; readonly receiptId: string;
    readonly readBackVersionId: string; readonly readBackDigest: string } })[];
}
export interface BusinessEmployeeAgentProjection {
  readonly report: BusinessEmployeeAgentReport; readonly digest: string;
}
export interface BusinessEmployeeAgentNativeScope {
  readonly session: BusinessSession; readonly request: BusinessEmployeeAgentReportRequest;
  /** The original owner issues agent.report through the existing authority. This
   * addition creates no role, grant, default actor, authority or Supervisor task. */
  readonly query: Omit<BusinessQuery, 'action'> & { readonly action: 'agent.report' };
  readonly epoch: BusinessEpoch; readonly work: BusinessNativeWork; readonly mapping: BusinessRevisionMapping;
  readonly snapshot: BusinessEmployeeAgentNativeSnapshot;
  /** Authority-owned serialized exclusion over original command, employee mapping,
   * profile/version, registered source/tombstone, sharing receipt and current audience. */
  current(): boolean;
}
export interface BusinessEmployeeAgentNativeProjectionOwner {
  readonly protocol: typeof BUSINESS_EMPLOYEE_AGENT_NATIVE_PROJECTION_PROTOCOL;
  readonly authority: BusinessNativeStartupSharedPorts['authority']; readonly registry: BusinessNativeStartupSharedPorts['registry'];
  /** DB-only original owner operation. Invoke derive INSIDE the genuine existing
   * current authority serialization, never after an async allow/separate SQL snapshot.
   * The callback prepares a report; publication must still verify these sources and
   * employee/source/audience revisions in Root's SAME report-CAS admission. */
  withCurrentProjection(input: Readonly<{ session: BusinessSession; request: BusinessEmployeeAgentReportRequest }>,
    derive: (scope: Readonly<BusinessEmployeeAgentNativeScope>) => BusinessEmployeeAgentProjection): Promise<BusinessEmployeeAgentProjection | null>;
  /** Separate current read authority for this exact original projection result.
   * Do not reopen the consumed execution epoch or return a generic cached allow. */
  currentResult(input: Readonly<{ session: BusinessSession; request: BusinessEmployeeAgentReportRequest }>,
    result: Readonly<BusinessEmployeeAgentProjection>): boolean;
}
function denied(code = 'employee_agent_native_projection_denied'): never { throw Error(code); }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return denied();
}
export function businessEmployeeAgentNativeDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
/** Byte-compatible with the Web helper; the approval digest is checked, never issued. */
export function businessEmployeeAgentSummaryDigest(part: BusinessEmployeeAgentPersona | BusinessEmployeeAgentSkill | BusinessEmployeeAgentMemory | BusinessEmployeeAgentArtifact): string {
  const { approval: _approval, ...source } = part.source;
  return businessEmployeeAgentNativeDigest({ ...part, source });
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function plain(value: unknown): boolean {
  const stack = new Set<object>(); let nodes = 25_000;
  const visit = (v: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 20) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'string') return v.length <= 16_384;
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0;
    if (!v || typeof v !== 'object' || stack.has(v)) return false;
    if (Array.isArray(v) ? !isBusinessNativeArray(v, 256) : Object.getPrototypeOf(v) !== Object.prototype) return false;
    stack.add(v);
    try {
      return Reflect.ownKeys(v).every(key => typeof key === 'string' && (Array.isArray(v) && key === 'length'
        || Object.hasOwn(Object.getOwnPropertyDescriptor(v, key)!, 'value') && visit(Object.getOwnPropertyDescriptor(v, key)!.value, depth + 1)));
    } finally { stack.delete(v); }
  };
  try { return visit(value, 0); } catch { return false; }
}
function original(value: BusinessEmployeeAgentNativeOrigin, kind: NativeKind, recordId: string, versionId: string, digest: string): boolean {
  return businessEmployeeAgentOnly(value, ['kind', 'recordId', 'versionId', 'digest']) && value.kind === kind
    && value.recordId === recordId && value.versionId === versionId && [recordId, versionId].every(isBusinessId)
    && value.digest === digest && businessEmployeeAgentHex(digest);
}
function approved<T extends BusinessEmployeeAgentPersona | BusinessEmployeeAgentSkill | BusinessEmployeeAgentMemory | BusinessEmployeeAgentArtifact>(part: T): T {
  if (!businessEmployeeAgentOnly(part.source, ['authorityId', 'recordId', 'revision', 'resource', 'versionId', 'digest', 'audiencePrincipalIds', 'approval'])
    || !businessEmployeeAgentOnly(part.source.approval, ['receiptId', 'revision', 'contentDigest', 'approvedByPrincipalId', 'audiencePrincipalIds', 'expiresAt'])
    || part.source.approval.contentDigest !== businessEmployeeAgentSummaryDigest(part)) return denied('employee_agent_exact_sharing_review_required');
  return part;
}

/** Actual synchronous projection of existing native contracts. Call only from the
 * original source owner's admitted reducer; a returned DTO carries no permission.
 * No profile/memory/history/DB getter, builder, network or publisher is called. */
export function projectBusinessEmployeeAgentNativeSnapshot(raw: BusinessEmployeeAgentNativeSnapshot,
  session: BusinessSession, request: BusinessEmployeeAgentReportRequest, now = Date.now()): BusinessEmployeeAgentProjection {
  if (!isBusinessSession(session) || Date.parse(session.expiresAt) <= now || !isBusinessEmployeeAgentReportRequest(request) || !plain(raw)
    || !businessEmployeeAgentOnly(raw, ['binding', 'producedAt', 'expiresAt', 'audiencePrincipalIds', 'persona', 'skills', 'memory', 'artifacts'])
    || !isBusinessEmployeeAgentBinding(raw.binding, session) || raw.binding.agentResource.resourceId !== request.agentResourceId
    || raw.binding.reportId !== request.ownerReportId || raw.binding.employeePrincipalId !== session.principalId
    || raw.binding.employeeAuthEpoch !== session.authEpoch) return denied();
  const { persona } = raw;
  if (!businessEmployeeAgentOnly(persona, ['profile', 'fields', 'summary', 'original', 'source']) || !isOneProfile(persona.profile)
    || !isBusinessNativeArray(persona.fields, 2) || !persona.fields.includes('displayName')
    || !persona.fields.every(field => field === 'displayName' || field === 'role') || new Set(persona.fields).size !== persona.fields.length
    || raw.binding.agentId !== persona.profile.oneId || raw.binding.profileRevision !== String(persona.profile.version)) return denied();
  const selected = { oneId: persona.profile.oneId, version: persona.profile.version, displayName: persona.profile.displayName,
    role: persona.fields.includes('role') ? persona.profile.role : '' };
  if (!original(persona.original, 'profile', selected.oneId, String(selected.version), businessEmployeeAgentNativeDigest(selected))) return denied();
  const profile = approved({ displayName: selected.displayName, role: selected.role, summary: persona.summary, source: persona.source });
  if (!isBusinessNativeArray(raw.skills, 16) || !isBusinessNativeArray(raw.memory, 16) || !isBusinessNativeArray(raw.artifacts, 16)) return denied();
  const skills: BusinessEmployeeAgentSkill[] = raw.skills.map(row => {
    if (!businessEmployeeAgentOnly(row, ['original', 'source', 'label', 'summary', 'draft', 'evaluation'])) return denied();
    const d = row.draft, e = row.evaluation;
    if (!d || typeof d !== 'object' || !['skill', 'toolchain', 'agent'].includes(d.kind) || !original(row.original, d.kind, d.assetId, d.versionId, d.digest)
      || !businessEmployeeAgentOnly(e, ['draftDigest', 'envelopeDigest', 'oracleId', 'oracleRevision', 'fixtureDigest', 'resultDigest', 'passed', 'isolated', 'networkAccess', 'providerCalls'])
      || e.draftDigest !== d.digest || ![e.envelopeDigest, e.fixtureDigest, e.resultDigest].every(businessEmployeeAgentHex)
      || ![e.oracleId, e.oracleRevision].every(isBusinessId)
      || e.passed !== true || e.isolated !== true || e.networkAccess !== false || e.providerCalls !== 0) return denied('employee_agent_frozen_evaluation_required');
    return approved({ id: d.assetId, kind: d.kind, label: row.label, summary: row.summary, source: row.source });
  });
  const memory: BusinessEmployeeAgentMemory[] = raw.memory.map(row => {
    if (!businessEmployeeAgentOnly(row, ['original', 'source', 'label', 'summary', 'kind', 'asset'])) return denied();
    const m = row.asset;
    if (!m || typeof m !== 'object') return denied('employee_agent_approved_memory_required');
    const local = { contractVersion: '1.0.0', version: m.version, candidates: [], memories: [m], suppressions: [], createdAt: m.createdAt, updatedAt: m.updatedAt };
    if (!isOneMemoryState(local) || m.provenanceStatus !== 'verified' || !m.enabled || m.approvalSource !== 'explicit_user'
      || !original(row.original, 'memory', m.id, String(m.version), businessEmployeeAgentNativeDigest(m))) return denied('employee_agent_approved_memory_required');
    return approved({ id: m.id, kind: row.kind, label: row.label, summary: row.summary, source: row.source });
  });
  const artifacts: BusinessEmployeeAgentArtifact[] = raw.artifacts.map(row => {
    if (!businessEmployeeAgentOnly(row, ['original', 'source', 'label', 'summary', 'reference'])) return denied();
    const r = row.reference;
    if (!businessEmployeeAgentOnly(r, ['kind', 'recordId', 'versionId', 'digest', 'receiptId', 'readBackVersionId', 'readBackDigest'])
      || !['page', 'space', 'file'].includes(r.kind) || r.readBackVersionId !== r.versionId || r.readBackDigest !== r.digest
      || !isBusinessId(r.receiptId) || !original(row.original, r.kind, r.recordId, r.versionId, r.digest)) return denied('employee_agent_exact_artifact_readback_required');
    return approved({ id: r.recordId, kind: r.kind, label: row.label, summary: row.summary, source: row.source });
  });
  const report = { ...raw.binding, schema: BUSINESS_EMPLOYEE_AGENT_REPORT_SCHEMA, producedAt: raw.producedAt, expiresAt: raw.expiresAt,
    audiencePrincipalIds: [...raw.audiencePrincipalIds], persona: profile, skills, memory, artifacts };
  if (!isBusinessEmployeeAgentReport(report, session, now)) return denied();
  // Only the minimized report is copied/frozen; raw personal snapshots never escape.
  const result = frozen(structuredClone(report));
  return frozen({ report: result, digest: businessEmployeeAgentNativeDigest(result) });
}

/** Inert production consumer. Existing sole Main owner supplies the original startup
 * and a genuine serialization port. No default registry, profile enumeration, account
 * linking, grant, queue, collector, DB connection or network publication is created. */
export function createBusinessEmployeeAgentReportAdapter(input: { readonly shared: Readonly<BusinessNativeStartupSharedPorts>;
  readonly originalBusiness: BusinessNativeStartupBindings | null; readonly owner: BusinessEmployeeAgentNativeProjectionOwner | null }, now: () => number = Date.now) {
  const shared = Object.freeze({ ...input.shared }), startup = input.originalBusiness, owner = input.owner;
  const references = [shared.sessions, shared.identity, shared.authority, shared.registry, owner?.withCurrentProjection, owner?.currentResult];
  let generation = 0;
  function blocker(): string | null {
    if (!startup || !businessNativeStartupMatchesShared(startup, shared)) return 'employee_agent_original_startup_unbound';
    if (!shared.identity || !shared.authority || !shared.registry) return 'employee_agent_current_authority_unbound';
    if (!owner || owner.protocol !== BUSINESS_EMPLOYEE_AGENT_NATIVE_PROJECTION_PROTOCOL || owner.authority !== shared.authority
      || owner.registry !== shared.registry || typeof owner.withCurrentProjection !== 'function' || typeof owner.currentResult !== 'function')
      return 'employee_agent_original_projection_owner_unbound';
    if ([input.shared.sessions, input.shared.identity, input.shared.authority, input.shared.registry,
      owner.withCurrentProjection, owner.currentResult].some((value, i) => value !== references[i])) return 'employee_agent_owner_changed';
    return null;
  }
  function current(session: BusinessSession, stamp: number): boolean {
    try { const actor = shared.identity?.current(); return stamp === generation && !blocker() && isBusinessSession(actor)
      && Date.parse(actor.expiresAt) > now() && sameBusinessSession(actor, session); } catch { return false; }
  }
  return Object.freeze({ blocker, invalidate() { generation++; },
    async prepare(raw: BusinessEmployeeAgentReportRequest): Promise<{ state: 'prepared' | 'denied' | 'unknown' | 'unavailable'; projection: BusinessEmployeeAgentProjection | null }> {
      if (!isBusinessEmployeeAgentReportRequest(raw)) return { state: 'denied', projection: null };
      const request = frozen({ ...raw }), stamp = generation;
      if (blocker()) return { state: 'unavailable', projection: null };
      try {
        const session = await shared.sessions.current(); if (!session || !current(session, stamp)) return { state: 'denied', projection: null };
        const exact = frozen({ session: { ...session }, request }); let produced: BusinessEmployeeAgentProjection | null = null;
        let projecting = true; let result: BusinessEmployeeAgentProjection | null;
        try { result = await owner!.withCurrentProjection(exact, scope => {
          if (!projecting || !businessEmployeeAgentOnly(scope, ['session', 'request', 'query', 'epoch', 'work', 'mapping', 'snapshot', 'current'])
            || typeof scope.current !== 'function' || ![scope.session, scope.request, scope.query, scope.epoch, scope.work, scope.mapping, scope.snapshot].every(plain)
            || !current(session, stamp) || !isBusinessSession(scope.session) || !sameBusinessSession(scope.session, session)
            || !isBusinessEmployeeAgentReportRequest(scope.request) || businessEmployeeAgentNativeDigest(scope.request) !== businessEmployeeAgentNativeDigest(request)
            || scope.query.action !== 'agent.report' || !isBusinessQuery(scope.query)
            || scope.query.deploymentId !== session.deploymentId || scope.query.organizationId !== session.organizationId || scope.query.hostId !== session.hostId
            || !isBusinessEpoch(scope.epoch) || scope.epoch.queryDigest !== desktopBusinessQueryDigest(scope.query)
            || !(['principalId', 'sessionId', 'identityAuthorityId', 'sessionRevision', 'authEpoch', 'deploymentId', 'organizationId', 'hostId'] as const)
              .every(key => scope.epoch[key] === session[key])
            || Date.parse(scope.epoch.expiresAt) <= now() || Date.parse(scope.epoch.expiresAt) > Date.parse(session.expiresAt)
            || !isBusinessNativeWork(scope.work) || !isBusinessRevisionMapping(scope.mapping)
            || !businessRevisionMappingMatchesRequest(scope.mapping, { session, work: scope.work, sources: scope.mapping.resources.map(pair => pair.opaque) }, now())
            || scope.query.taskId !== scope.work.taskId || scope.query.runId !== scope.work.runId || scope.query.occurrenceId !== scope.work.occurrenceId
            || scope.query.controlVersion !== scope.mapping.canonicalControlRevision || shared.registry!.current(scope.mapping) !== true
            || scope.current() !== true) return denied('employee_agent_original_admission_required');
          const value = projectBusinessEmployeeAgentNativeSnapshot(scope.snapshot, session, request, now());
          const sources = [value.report.persona.source, ...value.report.skills.map(row => row.source),
            ...value.report.memory.map(row => row.source), ...value.report.artifacts.map(row => row.source)];
          const resources = [value.report.agentResource, ...sources.map(source => source.resource)];
          if (!resources.every(ref => scope.query.resources.some(admitted => sameBusinessResource(ref, admitted)))
            || !sources.every(source => scope.mapping.resources.some(pair => sameBusinessResource(source.resource, pair.canonical)
              && pair.opaque.sourceAuthorityId === source.authorityId && pair.opaque.revision === source.revision))
            || scope.query.resources.length !== scope.mapping.resources.length
            || !scope.query.resources.every(ref => scope.mapping.resources.some(pair => sameBusinessResource(ref, pair.canonical)))
            || !current(session, stamp) || scope.current() !== true) return denied('employee_agent_original_sources_changed');
          produced = value; return value;
        }); } finally { projecting = false; }
        // The old scope is consumed. Exact independently-current result authorization
        // is mandatory; a copied result or fabricated publisher response is rejected.
        if (!result || result !== produced || !current(session, stamp) || owner!.currentResult(exact, result) !== true
          || !current(session, stamp)) return { state: 'unknown', projection: null };
        return { state: 'prepared', projection: result };
      } catch { return { state: 'unknown', projection: null }; }
    },
  });
}
