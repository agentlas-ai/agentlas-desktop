import type { OneActionAuthorityDecision, OneActionAuthorityPort, OneActionAuthorityRequest } from '../../shared/one-authority';
import { getAuthenticatedSessionBinding } from '../auth';
import { getOneProfile } from '../store/one-profile';
import { oneNativeHostIdentity } from './host-identity';

let business: OneActionAuthorityPort | null = null;
/** Business installs its current decision adapter once; no cached role or caller principal. */
export function configureOneBusinessAuthority(port: OneActionAuthorityPort): void {
  if (business && business !== port) throw new Error('one_authority_adapter_already_configured');
  business = port;
}
export function oneBusinessAuthorityConnected(): boolean { return business !== null; }
export function currentOneActionAuthority(request: OneActionAuthorityRequest, personal: OneActionAuthorityPort): OneActionAuthorityDecision {
  const session = getAuthenticatedSessionBinding();
  if (!session || session.expiresAt !== null && session.expiresAt <= Date.now()
    || request.principalId !== session.userId || request.sessionId !== session.sessionId
    || request.workspaceId !== session.workspaceId || request.oneId !== getOneProfile().oneId
    || request.hostId !== oneNativeHostIdentity().hostId) {
    return { decision: 'deny', revision: '', reason: 'one_authority_session_changed' };
  }
  const port = request.organizationId !== null ? business : personal;
  if (!port) return { decision: 'unknown', revision: '', reason: 'one_authority_organization_adapter_required' };
  try {
    const decision = port.current(Object.freeze(structuredClone(request)));
    if (!decision || !['allow', 'deny', 'unknown'].includes(decision.decision) || typeof decision.revision !== 'string'
      || decision.decision === 'allow' && !decision.revision) {
      return { decision: 'unknown', revision: '', reason: 'one_authority_invalid_decision' };
    }
    return decision;
  } catch { return { decision: 'unknown', revision: '', reason: 'one_authority_unavailable' }; }
}
