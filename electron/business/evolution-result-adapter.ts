import { businessOnlyKeys, isBusinessId, isBusinessResource, isBusinessRevision, sameBusinessResource, snapshotBusinessQuery,
  type BusinessEpoch, type BusinessQuery } from '../../shared/business/context';
import type { BusinessEvolutionFeedback } from '../../shared/business/evolution';
import { DesktopBusinessEvolutionPolicyAdapter, type BusinessEvolutionAdmissionInput } from './evolution-policy-adapter';

export interface BusinessEvolutionFeedbackPort {
  /** Existing evolution repository transaction must recheck permit + source/control revisions in its CAS. */
  append(input: { feedback: BusinessEvolutionFeedback; expectedCandidateRevision: number; expectedControlRevision: number;
    epoch: BusinessEpoch; envelopeRevision: number; sourceRevisions: BusinessEvolutionFeedback['sourceRevisions'];
    stillCurrent: () => Promise<boolean> }): Promise<{ revision: number; readBack: BusinessEvolutionFeedback } | null>;
}
function exactFeedback(query: BusinessQuery, expectedCommandId: string, f: BusinessEvolutionFeedback): boolean {
  return businessOnlyKeys(f, ['taskId', 'runId', 'controlVersion', 'commandId', 'occurrenceId', 'candidateId', 'candidateRevision', 'assetRevision', 'envelopeRevision',
    'sourceRevisions', 'result', 'resultDigest', 'readBackDigest', 'effect', 'outcome'])
    && f.taskId === query.taskId && f.runId === query.runId && f.controlVersion === query.controlVersion && f.occurrenceId === query.occurrenceId
    && isBusinessId(expectedCommandId) && f.commandId === expectedCommandId && isBusinessId(f.candidateId)
    && [f.candidateRevision, f.assetRevision, f.envelopeRevision].every(isBusinessRevision) && isBusinessResource(f.result)
    && query.resources.some(ref => sameBusinessResource(ref, f.result)) && /^[a-f0-9]{64}$/.test(f.resultDigest) && f.resultDigest === f.readBackDigest
    && Array.isArray(f.sourceRevisions) && f.sourceRevisions.length <= 64 && f.sourceRevisions.every(source => isBusinessResource(source)
      && query.resources.some(ref => sameBusinessResource(ref, source)))
    && ['settled', 'pending', 'uncertain'].includes(f.effect) && ['pass', 'fail', 'unknown'].includes(f.outcome)
    && (f.outcome !== 'pass' || f.effect === 'settled');
}
export class DesktopBusinessEvolutionResultAdapter {
  constructor(private readonly policy: DesktopBusinessEvolutionPolicyAdapter, private readonly port: BusinessEvolutionFeedbackPort | null) {}

  async append(input: BusinessEvolutionAdmissionInput, expectedCommandId: string, feedback: BusinessEvolutionFeedback): Promise<{
    status: 'recorded' | 'denied' | 'unknown'; revision: number | null;
  }> {
    const query = snapshotBusinessQuery(input.query);
    if (query) input = Object.freeze({ ...input, query });
    if (input.stage !== 'feedback' || !exactFeedback(input.query, expectedCommandId, feedback)) return { status: 'denied', revision: null };
    const copy: BusinessEvolutionFeedback = JSON.parse(JSON.stringify(feedback));
    const permit = await this.policy.admit(input);
    if (permit.status !== 'admitted' || !permit.snapshot) return { status: permit.status === 'denied' ? 'denied' : 'unknown', revision: null };
    const { candidate, envelope } = permit.snapshot;
    if (copy.candidateId !== candidate.id || copy.candidateRevision !== candidate.revision || copy.assetRevision !== candidate.asset.revision
      || copy.envelopeRevision !== envelope.revision || copy.sourceRevisions.length !== candidate.sources.length
      || candidate.sources.some(source => !copy.sourceRevisions.some(ref => sameBusinessResource(source, ref)))) return { status: 'denied', revision: null };
    if (!this.port) return { status: 'unknown', revision: null };
    try {
      if (!(await permit.stillCurrent())) return { status: 'denied', revision: null };
      const result = await this.port.append({ feedback: copy, expectedCandidateRevision: candidate.revision,
        expectedControlRevision: permit.snapshot.controlRevision, epoch: permit.decision.epoch!, envelopeRevision: envelope.revision,
        sourceRevisions: candidate.sources, stillCurrent: permit.stillCurrent });
      if (!result || !isBusinessRevision(result.revision) || result.revision !== candidate.revision + 1 || JSON.stringify(result.readBack) !== JSON.stringify(copy)) {
        return { status: 'unknown', revision: null };
      }
      if (!(await permit.authorityStillCurrent())) return { status: 'unknown', revision: null };
      return { status: 'recorded', revision: result.revision };
    } catch { return { status: 'unknown', revision: null }; }
  }
}
