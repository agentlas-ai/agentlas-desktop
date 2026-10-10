import { createHash } from 'node:crypto';
import { BUSINESS_AUTHORITY_SCHEMA, businessOnlyKeys, isBusinessEpoch, isBusinessId, isBusinessQuery, isBusinessRevision,
  sameBusinessSession, snapshotBusinessQuery, type BusinessAuthority, type BusinessDecision, type BusinessEpoch, type BusinessExactStop,
  type BusinessQuery, type BusinessReason, type BusinessSession, type BusinessStopReceipt } from '../../shared/business/context';
import { DesktopBusinessSession } from './session';

/** Matches the fixed-shape digest of Web access.ts; this binds a fence, never issues one. */
export function desktopBusinessQueryDigest(query: BusinessQuery): string {
  const shape = {
    schema: query.schema, deploymentId: query.deploymentId, organizationId: query.organizationId, hostId: query.hostId,
    action: query.action, purpose: query.purpose, projectId: query.projectId ?? null,
    taskId: query.taskId, runId: query.runId, controlVersion: query.controlVersion, occurrenceId: query.occurrenceId,
    resources: [...query.resources].sort((a, b) => a.resourceId.localeCompare(b.resourceId)).map(ref => ({
      resourceId: ref.resourceId, revision: ref.revision, aclRevision: ref.aclRevision,
      scope: ref.scope.kind === 'organization' ? { kind: ref.scope.kind, organizationId: ref.scope.organizationId } : { kind: ref.scope.kind, principalId: ref.scope.principalId },
    })), providerBindingId: query.providerBindingId ?? null, operationId: query.operationId ?? null,
    region: query.region ?? null, credentialRef: query.credentialRef ?? null, credentialGeneration: query.credentialGeneration ?? null,
    charge: query.charge ? { payerId: query.charge.payerId, currency: query.charge.currency, maxMinor: query.charge.maxMinor, budgetRevision: query.charge.budgetRevision } : null,
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}
function refusal(verdict: 'deny' | 'unknown', reason: BusinessReason): BusinessDecision {
  return Object.freeze({ schema: BUSINESS_AUTHORITY_SCHEMA, verdict, reason, epoch: null, expiresAt: null });
}
interface FenceRecord { epoch: BusinessEpoch; session: BusinessSession }
export class DesktopBusinessPolicyAdapter {
  private readonly fences = new Map<string, FenceRecord>();
  private generation = 0;
  constructor(
    private readonly sessions: DesktopBusinessSession,
    private readonly repository: BusinessAuthority | null,
    private readonly exactStopPort: ((input: BusinessExactStop) => Promise<BusinessStopReceipt>) | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  async currentDecision(query: BusinessQuery): Promise<BusinessDecision> {
    const generation = this.generation;
    const frozenQuery = snapshotBusinessQuery(query);
    if (!frozenQuery) return refusal('deny', 'invalid_request');
    const session = await this.sessions.current();
    if (!session) return refusal('unknown', 'authority_unavailable');
    if (frozenQuery.hostId !== session.hostId) return refusal('deny', 'host_untrusted');
    if (frozenQuery.deploymentId !== session.deploymentId || frozenQuery.organizationId !== session.organizationId) return refusal('deny', 'organization_mismatch');
    if (frozenQuery.resources.some(ref => ref.scope.kind === 'personal' && ref.scope.principalId !== session.principalId)) return refusal('deny', 'resource_denied');
    if (!this.repository) return refusal('unknown', 'repository_unavailable');
    // Caller mutation during a remote read cannot retarget an issued fence.
    const digest = desktopBusinessQueryDigest(frozenQuery);
    try {
      const result = await this.repository.currentDecision(frozenQuery, session);
      if (generation !== this.generation) return refusal('deny', 'authority_stale');
      if (!businessOnlyKeys(result, ['schema', 'verdict', 'reason', 'epoch', 'expiresAt']) || result.schema !== BUSINESS_AUTHORITY_SCHEMA
        || !['allow', 'deny', 'unknown'].includes(result.verdict) || !isBusinessId(result.reason)) return refusal('unknown', 'authority_unavailable');
      if (result.verdict !== 'allow') return refusal(result.verdict, result.reason);
      const epoch = result.epoch;
      if (result.reason !== 'allowed' || !isBusinessEpoch(epoch) || epoch.queryDigest !== digest
        || epoch.principalId !== session.principalId || epoch.sessionId !== session.sessionId || epoch.identityAuthorityId !== session.identityAuthorityId || epoch.sessionRevision !== session.sessionRevision
        || epoch.authEpoch !== session.authEpoch || epoch.deploymentId !== session.deploymentId || epoch.organizationId !== session.organizationId
        || epoch.hostId !== session.hostId || result.expiresAt !== epoch.expiresAt || Date.parse(epoch.expiresAt) <= this.now()
        || Date.parse(epoch.expiresAt) > Date.parse(session.expiresAt) || !(await this.sessions.stillCurrent(session))
        || generation !== this.generation) return refusal('deny', 'authority_stale');
      this.prune();
      while (this.fences.size >= 256) this.fences.delete(this.fences.keys().next().value!);
      const copy = Object.freeze({ ...epoch });
      const previous = this.fences.get(copy.fenceId);
      if (previous && JSON.stringify(previous.epoch) !== JSON.stringify(copy)) return refusal('deny', 'conflict');
      this.fences.set(copy.fenceId, { epoch: copy, session });
      return Object.freeze({ schema: BUSINESS_AUTHORITY_SCHEMA, verdict: 'allow', reason: 'allowed', epoch: copy, expiresAt: copy.expiresAt });
    } catch { return refusal('unknown', 'repository_unavailable'); }
  }

  /** Calls the authority again; an expiry or a previously allowed fence is never sufficient. */
  async stillCurrent(epoch: BusinessEpoch): Promise<boolean> {
    if (!isBusinessEpoch(epoch) || !this.repository || Date.parse(epoch.expiresAt) <= this.now()) return false;
    const expected = Object.freeze({ ...epoch });
    const generation = this.generation;
    const record = this.fences.get(expected.fenceId);
    if (!record || JSON.stringify(record.epoch) !== JSON.stringify(expected) || !(await this.sessions.stillCurrent(record.session))
      || generation !== this.generation || this.fences.get(expected.fenceId) !== record) return false;
    try {
      const valid = await this.repository.stillCurrent(record.epoch);
      const current = await this.sessions.current();
      if (valid !== true || !current || !sameBusinessSession(current, record.session) || Date.parse(expected.expiresAt) <= this.now()
        || generation !== this.generation || this.fences.get(expected.fenceId) !== record) {
        if (this.fences.get(expected.fenceId) === record) this.fences.delete(expected.fenceId);
        return false;
      }
      return true;
    } catch { return false; }
  }

  /** Forward bounded exact control even when session/provider/policy services are unavailable. */
  async stop(input: BusinessExactStop): Promise<BusinessStopReceipt> {
    const fallback: BusinessStopReceipt = { taskId: input.taskId, runId: input.runId, controlVersion: input.controlVersion,
      state: 'unknown', externalEffects: 'uncertain' };
    if (!businessOnlyKeys(input, ['hostId', 'taskId', 'runId', 'controlVersion', 'commandId', 'occurrenceId'])
      || input.hostId !== this.sessions.hostId || ![input.hostId, input.taskId, input.runId, input.commandId, input.occurrenceId].every(isBusinessId)
      || !isBusinessRevision(input.controlVersion)) return { ...fallback, state: 'failed' };
    if (!this.exactStopPort) return fallback;
    try {
      const result = await this.exactStopPort(Object.freeze({ ...input }));
      if (!businessOnlyKeys(result, ['taskId', 'runId', 'controlVersion', 'state', 'externalEffects'])
        || result.taskId !== input.taskId || result.runId !== input.runId || result.controlVersion !== input.controlVersion
        || !['accepted', 'settled', 'unknown', 'failed'].includes(result.state) || !['settled', 'pending', 'uncertain'].includes(result.externalEffects)) return fallback;
      return Object.freeze({ ...result });
    } catch { return fallback; }
  }

  invalidate(): void { this.generation++; this.fences.clear(); }
  private prune(): void {
    for (const [id, record] of this.fences) if (Date.parse(record.epoch.expiresAt) <= this.now()) this.fences.delete(id);
  }
}
