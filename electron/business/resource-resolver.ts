import { businessOnlyKeys, isBusinessId, isBusinessResource, sameBusinessResource, snapshotBusinessQuery,
  type BusinessDecision, type BusinessQuery, type BusinessResourceRef, type BusinessSession } from '../../shared/business/context';
import { DesktopBusinessSession } from './session';
import { DesktopBusinessPolicyAdapter } from './policy-adapter';

export interface BusinessResourceDescriptor {
  ref: BusinessResourceRef;
  kind: 'source' | 'history' | 'page' | 'space' | 'agent' | 'skill' | 'toolchain' | 'provider' | 'tool' | 'credential';
  brokerRef: string;
  mutable: boolean;
  tombstoned: boolean;
}
/** Resolves only opaque namespace references. Domain ACL/write/CAS stays with the Page/One owner. */
export interface BusinessResourceDirectoryPort {
  resolve(input: { session: BusinessSession; resource: BusinessResourceRef; query: BusinessQuery }): Promise<BusinessResourceDescriptor | null>;
}
export interface BusinessResourceResolution {
  status: 'resolved' | 'denied' | 'unknown';
  resource: BusinessResourceDescriptor | null;
  decision: BusinessDecision;
}
export class DesktopBusinessResourceResolver {
  constructor(private readonly sessions: DesktopBusinessSession, private readonly policy: DesktopBusinessPolicyAdapter,
    private readonly directory: BusinessResourceDirectoryPort | null) {}

  async resolve(query: BusinessQuery, resource: BusinessResourceRef): Promise<BusinessResourceResolution> {
    const frozenQuery = snapshotBusinessQuery(query);
    const frozenResource = isBusinessResource(resource) ? { ...resource, scope: { ...resource.scope } } : null;
    if (frozenQuery) query = frozenQuery;
    const decision = await this.policy.currentDecision(query);
    if (decision.verdict !== 'allow' || !decision.epoch) return { status: decision.verdict === 'deny' ? 'denied' : 'unknown', resource: null, decision };
    if (!frozenResource || !query.resources.some(ref => sameBusinessResource(ref, frozenResource))) return { status: 'denied', resource: null, decision };
    resource = frozenResource;
    const session = await this.sessions.current();
    if (!session || !this.directory) return { status: 'unknown', resource: null, decision };
    try {
      const resolved = await this.directory.resolve({ session, resource: JSON.parse(JSON.stringify(resource)), query: JSON.parse(JSON.stringify(query)) });
      if (!resolved || !businessOnlyKeys(resolved, ['ref', 'kind', 'brokerRef', 'mutable', 'tombstoned'])
        || !isBusinessResource(resolved.ref) || !sameBusinessResource(resolved.ref, resource) || !isBusinessId(resolved.brokerRef)
        || !['source', 'history', 'page', 'space', 'agent', 'skill', 'toolchain', 'provider', 'tool', 'credential'].includes(resolved.kind)
        || typeof resolved.mutable !== 'boolean' || resolved.tombstoned !== false || !(await this.policy.stillCurrent(decision.epoch))) {
        return { status: 'denied', resource: null, decision };
      }
      return { status: 'resolved', resource: { ...resolved, ref: { ...resolved.ref, scope: { ...resolved.ref.scope } } }, decision };
    } catch { return { status: 'unknown', resource: null, decision }; }
  }
}
