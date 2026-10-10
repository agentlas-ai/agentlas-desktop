import { BUSINESS_EVOLUTION_SCHEMA, type BusinessHistoryPolicy, type BusinessMinimizedObservation, type BusinessWorkObservation } from '../../shared/business/evolution';
import { businessOnlyKeys, isBusinessId, isBusinessResource, isBusinessRevision, sameBusinessResource, snapshotBusinessQuery, type BusinessDecision, type BusinessQuery } from '../../shared/business/context';
import { DesktopBusinessSession } from './session';
import { DesktopBusinessPolicyAdapter } from './policy-adapter';

export interface BusinessHistoryPolicyPort {
  readCurrent(query: BusinessQuery): Promise<BusinessHistoryPolicy | null>;
}
export interface BusinessObservationAdmission {
  status: 'accepted' | 'denied' | 'unknown';
  reason: 'accepted' | 'authority_unavailable' | 'policy_unavailable' | 'observation_denied' | 'authority_changed';
  observation: BusinessMinimizedObservation | null;
  decision: BusinessDecision;
  /** Existing collector/One owner must recheck before using the admitted features later. */
  stillCurrent(): Promise<boolean>;
}
const SENSITIVE_FIELD = /(?:password|passwd|secret|token|credential|authorization|cookie|private.?key|ssn|resident.?id|personal.?id|bank.?account|card.?number|email|phone|address|salary)/i;
const STEP_ACTIONS = ['read', 'calculate', 'filter', 'write', 'approve', 'manual'];
/** Only schema/workflow features cross this boundary. Actual history remains with its existing collector owner. */
export function minimizeBusinessObservation(input: BusinessWorkObservation, policy: BusinessHistoryPolicy, now = Date.now()): BusinessMinimizedObservation | null {
  if (!input || !policy || policy.collectionEnabled !== true || policy.analysisEnabled !== true || policy.tombstoned !== false || input.sensitive !== false
    || !isBusinessResource(input.source) || !isBusinessResource(policy.source) || !Array.isArray(policy.allowedApplications)
    || !Array.isArray(policy.allowedDomains) || !Array.isArray(policy.allowedFields)
    || !sameBusinessResource(input.source, policy.source) || input.principalId !== policy.principalId || input.hostId !== policy.hostId
    || ![input.eventId, input.applicationId, policy.purpose].every(isBusinessId) || !isBusinessRevision(policy.revision)
    || !policy.allowedApplications.includes(input.applicationId) || (input.domain !== null && !policy.allowedDomains.includes(input.domain))
    || !Number.isSafeInteger(policy.retentionMs) || policy.retentionMs < 1 || policy.retentionMs > 365 * 24 * 60 * 60_000
    || !isBusinessRevision(input.observedAt) || input.observedAt > now || input.observedAt + policy.retentionMs <= now
    || !['demonstration', 'workflow', 'feedback', 'tool-schema'].includes(input.kind) || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 64) return null;
  const steps: BusinessWorkObservation['steps'] = [];
  for (const step of input.steps) {
    if (!businessOnlyKeys(step, ['action', 'toolRef', 'fieldNames', 'outcome']) || !STEP_ACTIONS.includes(step.action)
      || (step.toolRef !== null && !isBusinessId(step.toolRef)) || !['success', 'failure', 'unknown'].includes(step.outcome)
      || !Array.isArray(step.fieldNames) || step.fieldNames.length > 64) return null;
    const fields = step.fieldNames.filter(field => isBusinessId(field) && policy.allowedFields.includes(field) && !SENSITIVE_FIELD.test(field));
    steps.push({ action: step.action, toolRef: step.toolRef, fieldNames: [...new Set(fields)], outcome: step.outcome });
  }
  return { schema: BUSINESS_EVOLUTION_SCHEMA, eventId: input.eventId, source: { ...input.source, scope: { ...input.source.scope } },
    policyRevision: policy.revision, purpose: policy.purpose, observedAt: input.observedAt, expiresAt: input.observedAt + policy.retentionMs,
    kind: input.kind, applicationId: input.applicationId, steps, redacted: true };
}
export class DesktopBusinessHistoryAdapter {
  constructor(private readonly sessions: DesktopBusinessSession, private readonly policy: DesktopBusinessPolicyAdapter,
    private readonly historyPolicy: BusinessHistoryPolicyPort | null, private readonly now: () => number = Date.now) {}

  async admit(query: BusinessQuery, observation: BusinessWorkObservation): Promise<BusinessObservationAdmission> {
    const frozenQuery = snapshotBusinessQuery(query);
    if (frozenQuery) query = frozenQuery;
    // Project only values used by minimization. Never read/copy fields, pixels or other raw payloads.
    const copy: BusinessWorkObservation = { eventId: observation.eventId, source: { ...observation.source, scope: { ...observation.source.scope } },
      principalId: observation.principalId, hostId: observation.hostId, applicationId: observation.applicationId, domain: observation.domain,
      observedAt: observation.observedAt, kind: observation.kind, sensitive: observation.sensitive,
      steps: Array.isArray(observation.steps) ? observation.steps.map(step => ({ action: step.action, toolRef: step.toolRef, fieldNames: [...step.fieldNames], outcome: step.outcome })) : [] };
    const decision = await this.policy.currentDecision(query);
    const reject = (status: 'denied' | 'unknown', reason: BusinessObservationAdmission['reason']): BusinessObservationAdmission => ({ status, reason, observation: null, decision,
      stillCurrent: async () => false });
    if (decision.verdict !== 'allow' || !decision.epoch) return reject(decision.verdict === 'deny' ? 'denied' : 'unknown', 'authority_unavailable');
    if (query.action !== 'history.observe' || !this.historyPolicy) return reject('unknown', 'policy_unavailable');
    try {
      const session = await this.sessions.current();
      const history = await this.historyPolicy.readCurrent(JSON.parse(JSON.stringify(query)));
      if (!session || !history || history.principalId !== session.principalId || history.hostId !== session.hostId || history.purpose !== query.purpose
        || !query.resources.some(ref => sameBusinessResource(ref, history.source))) return reject('denied', 'observation_denied');
      const minimized = minimizeBusinessObservation(copy, history, this.now());
      if (!minimized) return reject('denied', 'observation_denied');
      const epoch = decision.epoch;
      const stillCurrent = async (): Promise<boolean> => {
        try {
          const current = await this.historyPolicy!.readCurrent(query);
          if (!current || current.revision !== history.revision || current.principalId !== history.principalId || current.hostId !== history.hostId
            || current.purpose !== query.purpose || !sameBusinessResource(current.source, history.source)) return false;
          const expected = minimizeBusinessObservation(copy, current, this.now());
          return expected !== null && JSON.stringify(expected) === JSON.stringify(minimized) && await this.policy.stillCurrent(epoch);
        } catch { return false; }
      };
      if (!(await stillCurrent())) return reject('denied', 'authority_changed');
      return { status: 'accepted', reason: 'accepted', observation: minimized, decision, stillCurrent };
    } catch { return reject('unknown', 'policy_unavailable'); }
  }
}
