import { businessOnlyKeys, isBusinessId, isBusinessResource, isBusinessRevision, sameBusinessResource, snapshotBusinessQuery,
  type BusinessDecision, type BusinessQuery, type BusinessResourceRef, type BusinessTaskAnchor } from '../../shared/business/context';
import { DesktopBusinessPolicyAdapter } from './policy-adapter';

/** Main-authored metadata from the existing result/receipt owner. No result text or raw credentials. */
export interface BusinessWorkResultReceipt {
  anchor: BusinessTaskAnchor;
  artifact: BusinessResourceRef;
  artifactDigest: string;
  sources: BusinessResourceRef[];
  readBack: { artifact: BusinessResourceRef; digest: string } | null;
  effect: { state: 'settled' | 'pending' | 'uncertain'; receiptId: string | null };
  providerState: 'not-requested' | 'unverified' | 'verified' | 'valid-audio' | 'failed' | 'unknown';
}
export interface BusinessWorkResultProjection {
  status: 'verified' | 'partial' | 'denied' | 'unknown';
  result: BusinessWorkResultReceipt | null;
  decision: BusinessDecision;
}
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
export function businessResultMatches(query: BusinessQuery, commandId: string, result: BusinessWorkResultReceipt): boolean {
  if (!businessOnlyKeys(result, ['anchor', 'artifact', 'artifactDigest', 'sources', 'readBack', 'effect', 'providerState'])
    || !businessOnlyKeys(result.anchor, ['taskId', 'runId', 'controlVersion', 'commandId', 'occurrenceId'])
    || !isBusinessId(commandId) || result.anchor.commandId !== commandId || result.anchor.taskId !== query.taskId
    || result.anchor.runId !== query.runId || result.anchor.controlVersion !== query.controlVersion || result.anchor.occurrenceId !== query.occurrenceId
    || !isBusinessRevision(result.anchor.controlVersion) || !isBusinessResource(result.artifact) || !digest(result.artifactDigest)
    || !query.resources.some(ref => sameBusinessResource(ref, result.artifact)) || !Array.isArray(result.sources) || result.sources.length > 64
    || result.sources.some(ref => !isBusinessResource(ref) || !query.resources.some(r => sameBusinessResource(r, ref)))) return false;
  if (result.readBack !== null && (!businessOnlyKeys(result.readBack, ['artifact', 'digest']) || !isBusinessResource(result.readBack.artifact)
    || !sameBusinessResource(result.artifact, result.readBack.artifact) || result.artifactDigest !== result.readBack.digest)) return false;
  return businessOnlyKeys(result.effect, ['state', 'receiptId']) && ['settled', 'pending', 'uncertain'].includes(result.effect.state)
    && (result.effect.receiptId === null || isBusinessId(result.effect.receiptId))
    && ['not-requested', 'unverified', 'verified', 'valid-audio', 'failed', 'unknown'].includes(result.providerState);
}
export class DesktopBusinessWorkResultAdapter {
  constructor(private readonly policy: DesktopBusinessPolicyAdapter) {}

  async observe(query: BusinessQuery, expectedCommandId: string, receipt: BusinessWorkResultReceipt): Promise<BusinessWorkResultProjection> {
    const frozenQuery = snapshotBusinessQuery(query);
    if (frozenQuery) query = frozenQuery;
    const copy = businessResultMatches(query, expectedCommandId, receipt) ? JSON.parse(JSON.stringify(receipt)) as BusinessWorkResultReceipt : null;
    const decision = await this.policy.currentDecision(query);
    if (decision.verdict !== 'allow' || !decision.epoch) return { status: decision.verdict === 'deny' ? 'denied' : 'unknown', result: null, decision };
    if (query.action !== 'resource.read' || !copy) return { status: 'denied', result: null, decision };
    if (!(await this.policy.stillCurrent(decision.epoch))) return { status: 'denied', result: null, decision };
    // External effect uncertainty and missing exact read-back remain visible; neither becomes a successful Page write.
    return { status: copy.readBack !== null && copy.effect.state === 'settled' ? 'verified' : 'partial', result: copy, decision };
  }
}
