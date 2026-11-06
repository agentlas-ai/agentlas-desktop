import type { FinanceExperienceState } from '../../shared/finance-experience';
import { managedOneAuthentication } from '../managed-one/auth';
import type { FinanceScope } from './store';

type Access = FinanceExperienceState['access'];
const unavailable = (): Access => ({ plan: null, monitoringAllowed: false, status: 'unavailable' });
const endpoint = '/api/managed-one/host/finance-access';

/** Fresh, account- and generation-bound authority. No cookie fallback or cached grant. */
export async function managedFinanceMonitoringAccess(scope: FinanceScope): Promise<Access> {
  scope.assertCurrent();
  const captured = managedOneAuthentication();
  if (!captured || captured.workspaceId !== scope.workspaceId || captured.userId !== scope.userId) return unavailable();
  const current = (): boolean => {
    scope.assertCurrent();
    const value = managedOneAuthentication();
    return !!value && value.hostId === captured.hostId && value.generation === captured.generation
      && value.workspaceId === captured.workspaceId && value.userId === captured.userId
      && value.webBaseUrl === captured.webBaseUrl && value.expiresAt === captured.expiresAt
      && value.credentials.control === captured.credentials.control;
  };

  // One deadline for both attempts: the second runs only while time is left, so the whole check stays within it.
  const deadline = AbortSignal.timeout(8_000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!current() || deadline.aborted) return unavailable();
    let response: Response;
    try {
      response = await fetch(`${captured.webBaseUrl}${endpoint}`, {
        method: 'GET', headers: { authorization: `Bearer ${captured.credentials.control}`, 'x-agentlas-managed-one': '1' },
        redirect: 'error', cache: 'no-store', signal: deadline,
      });
    } catch {
      if (!current()) return unavailable();
      continue;
    }
    if (!current()) return unavailable();
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) continue;
      return unavailable();
    }
    let raw: unknown;
    try {
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > 8192) return unavailable();
      raw = JSON.parse(body);
    } catch {
      if (!current()) return unavailable();
      return unavailable();
    }
    if (!current() || !raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable();
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'allowed,generation,hostId,plan,schemaVersion,source,userId,validUntil,workspaceId'
      || value.schemaVersion !== 'agentlas.finance-monitoring-access.v1'
      || value.hostId !== captured.hostId || value.generation !== captured.generation
      || value.workspaceId !== captured.workspaceId || value.userId !== captured.userId
      || !Number.isSafeInteger(value.validUntil) || Number(value.validUntil) <= Date.now()
      || Number(value.validUntil) > Date.now() + 15 * 60_000) return unavailable();
    if (value.allowed === true && value.source === 'subscription' && typeof value.plan === 'string'
      && ['pro', 'max', 'wow'].includes(value.plan)) {
      return { plan: value.plan, monitoringAllowed: true, status: 'verified' };
    }
    if (value.allowed === true && value.source === 'invite' && value.plan === null) {
      return { plan: null, monitoringAllowed: true, status: 'verified' };
    }
    if (value.allowed === false && value.source === 'none' && value.plan === null) {
      return { plan: null, monitoringAllowed: false, status: 'verified' };
    }
    return unavailable();
  }
  return unavailable();
}
