import { createHash } from 'node:crypto';
import { isBusinessId, isBusinessResource, isBusinessRevision, sameBusinessResource, sameBusinessScope, snapshotBusinessQuery,
  type BusinessDecision, type BusinessEpoch, type BusinessQuery } from '../../shared/business/context';
import type { BusinessEvolutionSnapshot, BusinessEvolutionStage } from '../../shared/business/evolution';
import { DesktopBusinessPolicyAdapter } from './policy-adapter';

export interface BusinessEvolutionStatePort {
  /** Current authoritative projection, including source deletion and admin control revisions. */
  readCurrent(query: BusinessQuery, candidateId: string): Promise<BusinessEvolutionSnapshot | null>;
}
export interface BusinessEvolutionAdmissionInput {
  query: BusinessQuery;
  stage: BusinessEvolutionStage;
  candidateId: string;
  candidateRevision: number;
  envelopeRevision: number;
  controlRevision: number;
  baseRevision: number;
}
export interface BusinessEvolutionPermit {
  status: 'admitted' | 'denied' | 'unknown';
  reason: 'admitted' | 'authority_unavailable' | 'evolution_unavailable' | 'envelope_denied' | 'evaluation_required' | 'review_required' | 'authority_changed';
  decision: BusinessDecision;
  snapshot: BusinessEvolutionSnapshot | null;
  /** Existing owner calls immediately before Builder, Workspace CAS or runtime/effect boundaries. */
  stillCurrent(): Promise<boolean>;
  authorityStillCurrent(): Promise<boolean>;
}
function hex(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function safeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 && !value.includes('\\') && !value.startsWith('/')
    && value.split('/').every(part => !!part && part !== '.' && part !== '..')
    && !/(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx))$/i.test(value);
}
function sameResources(left: readonly import('../../shared/business/context').BusinessResourceRef[], right: readonly import('../../shared/business/context').BusinessResourceRef[]): boolean {
  return left.length === right.length && left.every(ref => right.some(other => sameBusinessResource(ref, other)))
    && new Set(left.map(ref => ref.resourceId)).size === left.length;
}
function snapshotDigest(snapshot: BusinessEvolutionSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
const STAGE_STATES: Record<BusinessEvolutionStage, BusinessEvolutionSnapshot['state'][]> = {
  observe: ['candidate'], generate: ['candidate'], build: ['draft'], evaluate: ['draft'], review: ['review-ready'],
  promote: ['review-ready'], restore: ['review-ready'], execute: ['active'], feedback: ['active'],
};
export function businessEvolutionBound(input: BusinessEvolutionAdmissionInput, snapshot: BusinessEvolutionSnapshot, now = Date.now()): boolean {
  const { query, stage } = input;
  const { envelope: e, candidate: c } = snapshot;
  if (!STAGE_STATES[stage]?.includes(snapshot.state) || e.paused !== false || e.revoked !== false || c.tombstoned !== false
    || !isBusinessId(e.id) || !isBusinessId(c.id) || c.id !== input.candidateId || c.revision !== input.candidateRevision
    || e.revision !== input.envelopeRevision || snapshot.controlRevision !== input.controlRevision || c.baseRevision !== input.baseRevision
    || c.envelopeId !== e.id || c.envelopeRevision !== e.revision || !isBusinessRevision(c.revision) || !isBusinessRevision(e.revision)
    || !isBusinessRevision(snapshot.controlRevision) || !isBusinessRevision(snapshot.liveAssetRevision)
    || !isBusinessResource(c.asset) || !sameBusinessScope(c.asset.scope, e.scope) || e.deploymentId !== query.deploymentId || e.hostId !== query.hostId
    || e.purpose !== query.purpose || (e.scope.kind === 'organization' && e.scope.organizationId !== query.organizationId)
    || (e.scope.kind === 'personal' && e.scope.principalId !== e.principalId)
    || !isBusinessRevision(e.expiresAt) || e.expiresAt <= now || !Array.isArray(e.stages) || !e.stages.includes(stage)
    || query.action !== (stage === 'observe' ? 'history.observe' : `evolution.${stage}`)
    || c.expandsPermissions !== false || c.changesEvaluator !== false || c.changesApprovalPolicy !== false
    || !isBusinessRevision(e.maxAttempts) || e.maxAttempts < 1 || !isBusinessRevision(e.usedAttempts) || e.usedAttempts > e.maxAttempts
    || !isBusinessRevision(e.usedMinor) || !query.charge || query.charge.payerId !== e.budget.payerId || query.charge.currency !== e.budget.currency
    || query.charge.budgetRevision !== e.budget.budgetRevision || query.charge.maxMinor > e.budget.maxMinor - e.usedMinor
    || !isBusinessId(e.evaluatorRef) || !isBusinessRevision(e.evaluatorRevision) || !isBusinessRevision(e.approvalPolicyRevision)) return false;
  if (!['observe', 'generate'].includes(stage) && (!hex(c.proposalDigest) || !hex(c.packageDigest) || !isBusinessRevision(c.proposedRevision))) return false;
  if (['generate', 'build', 'evaluate', 'execute'].includes(stage) && e.usedAttempts >= e.maxAttempts) return false;
  if (!Array.isArray(c.sources) || !Array.isArray(e.sources) || !sameResources(c.sources, e.sources) || c.sources.some(ref => !isBusinessResource(ref)
    || !query.resources.some(q => sameBusinessResource(q, ref))) || !query.resources.some(ref => sameBusinessResource(ref, c.asset))) return false;
  if (!Array.isArray(c.toolRefs) || !Array.isArray(e.tools) || c.toolRefs.some(tool => !isBusinessId(tool) || !e.tools.includes(tool))) return false;
  if (!Array.isArray(c.changedPaths) || !Array.isArray(e.editablePaths) || c.changedPaths.some(path => !safeRelativePath(path) || !e.editablePaths.includes(path))) return false;
  if (['promote', 'restore'].includes(stage) && (snapshot.liveAssetRevision !== c.baseRevision || c.asset.revision !== c.baseRevision)) return false;
  return true;
}
function evaluationPassed(snapshot: BusinessEvolutionSnapshot, candidateRevision = snapshot.candidate.revision): boolean {
  const { evaluation: v, envelope: e, candidate: c } = snapshot;
  return !!v && v.synthetic === true && v.candidateId === c.id && v.candidateRevision === candidateRevision && v.proposalDigest === c.proposalDigest && v.packageDigest === c.packageDigest
    && v.evaluatorRef === e.evaluatorRef && v.evaluatorRevision === e.evaluatorRevision && hex(v.fixtureDigest)
    && v.before !== 'unknown' && v.after === 'pass' && v.heldOut === 'pass' && v.negativeCases === 'pass';
}
function reviewIssued(snapshot: BusinessEvolutionSnapshot, now: number): boolean {
  const { review: r, candidate: c, envelope: e } = snapshot;
  // Bounded automatic policy does not silently synthesize an exact Workspace review receipt.
  return !!r && r.state === 'issued' && isBusinessId(r.receiptId) && r.expiresAt > now && r.candidateId === c.id
    && r.candidateRevision === c.revision && r.proposalDigest === c.proposalDigest && r.packageDigest === c.packageDigest && r.baseRevision === c.baseRevision
    && r.evaluatorRevision === e.evaluatorRevision && r.policyRevision === e.approvalPolicyRevision && r.envelopeRevision === e.revision
    && sameResources(r.sourceRevisions, c.sources);
}
function releasePinned(snapshot: BusinessEvolutionSnapshot): boolean {
  const { release: p, review: r, candidate: c } = snapshot;
  return !!p && !!r && isBusinessId(p.id) && p.candidateId === c.id && isBusinessRevision(p.candidateRevision) && p.candidateRevision <= c.revision
    && isBusinessResource(p.asset) && sameBusinessResource(p.asset, c.asset) && p.asset.revision === snapshot.liveAssetRevision
    && p.asset.revision === c.proposedRevision && p.proposalDigest === c.proposalDigest && p.packageDigest === c.packageDigest
    && p.reviewReceiptId === r.receiptId && r.state === 'consumed' && r.candidateRevision === p.candidateRevision
    && r.proposalDigest === p.proposalDigest && r.packageDigest === p.packageDigest && r.baseRevision === c.baseRevision
    && sameResources(p.sourceRevisions, c.sources) && sameResources(r.sourceRevisions, c.sources)
    && !!p.applyReceipt && isBusinessId(p.applyReceipt.operationId) && p.applyReceipt.state === 'applied'
    && p.applyReceipt.previousRevision === c.baseRevision && p.applyReceipt.revision === p.asset.revision
    && p.applyReceipt.readBackDigest === p.packageDigest && evaluationPassed(snapshot, p.candidateRevision);
}
export class DesktopBusinessEvolutionPolicyAdapter {
  constructor(private readonly policy: DesktopBusinessPolicyAdapter, private readonly state: BusinessEvolutionStatePort | null,
    private readonly now: () => number = Date.now) {}

  async admit(input: BusinessEvolutionAdmissionInput): Promise<BusinessEvolutionPermit> {
    const query = snapshotBusinessQuery(input.query);
    const frozenInput = query ? Object.freeze({ ...input, query }) : input;
    const decision = await this.policy.currentDecision(frozenInput.query);
    const reject = (status: 'denied' | 'unknown', reason: BusinessEvolutionPermit['reason']): BusinessEvolutionPermit => ({ status, reason, decision, snapshot: null,
      stillCurrent: async () => false, authorityStillCurrent: async () => false });
    if (decision.verdict !== 'allow' || !decision.epoch) return reject(decision.verdict === 'deny' ? 'denied' : 'unknown', 'authority_unavailable');
    if (!this.state || !isBusinessId(input.candidateId)) return reject('unknown', 'evolution_unavailable');
    try {
      const snapshot = await this.state.readCurrent(frozenInput.query, frozenInput.candidateId);
      if (!snapshot || snapshot.envelope.principalId !== decision.epoch.principalId || !businessEvolutionBound(frozenInput, snapshot, this.now())) return reject('denied', 'envelope_denied');
      if (['review', 'promote', 'restore'].includes(frozenInput.stage) && !evaluationPassed(snapshot)) return reject('denied', 'evaluation_required');
      if (['promote', 'restore'].includes(frozenInput.stage) && !reviewIssued(snapshot, this.now())) return reject('denied', 'review_required');
      if (['execute', 'feedback'].includes(frozenInput.stage) && !releasePinned(snapshot)) return reject('denied', 'review_required');
      const copy: BusinessEvolutionSnapshot = freezeSnapshot(JSON.parse(JSON.stringify(snapshot)));
      const epoch: BusinessEpoch = decision.epoch;
      const expectedDigest = snapshotDigest(copy);
      const stillCurrent = async (): Promise<boolean> => {
        try {
          const current = await this.state!.readCurrent(frozenInput.query, frozenInput.candidateId);
          return !!current && snapshotDigest(current) === expectedDigest && businessEvolutionBound(frozenInput, current, this.now())
            && (!['promote', 'restore'].includes(frozenInput.stage) || (evaluationPassed(current) && reviewIssued(current, this.now())))
            && (!['execute', 'feedback'].includes(frozenInput.stage) || releasePinned(current))
            && await this.policy.stillCurrent(epoch);
        } catch { return false; }
      };
      if (!(await stillCurrent())) return reject('denied', 'authority_changed');
      return { status: 'admitted', reason: 'admitted', decision, snapshot: copy, stillCurrent,
        authorityStillCurrent: () => this.policy.stillCurrent(epoch) };
    } catch { return reject('unknown', 'evolution_unavailable'); }
  }
}
