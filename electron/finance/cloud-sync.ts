import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAuthenticatedSessionBinding, getSessionCookieHeader, onAuthSessionOwnershipChanged, webBaseUrl } from '../auth';
import { managedOneAuthentication, managedOneHeaders, wasManagedOneConfigured } from '../managed-one/auth';
import { validateFinanceWorkspace } from '../../shared/finance';
import type { FinanceScope, FinanceStore } from './store';

const asset = z.object({ id:z.string().min(1).max(200), symbol:z.string().min(1).max(80), name:z.string().min(1).max(300),
  exchange:z.string().max(80), currency:z.string().regex(/^[A-Z]{3}$/),
  kind:z.enum(['stock','etf','fund','bond','crypto','commodity','other']) }).strict();
const record = z.object({ revision:z.number().int().nonnegative(), deleted:z.boolean(), assets:z.array(asset).max(1000),
  lastOperationId:z.string(), lastOperationDigest:z.string() }).strict();
const envelope = z.object({ schemaVersion:z.literal('agentlas.finance-watchlist-sync.v1'),
  result:z.union([record, z.object({status:z.enum(['applied','replayed']), record}).strict(), z.null()]) }).strict();

/** Invoked only after an owner-facing confirmation; no background import or merge. */
export async function transferFinanceWatchlist(scope: FinanceScope, store: FinanceStore, direction: 'upload'|'download'): Promise<void> {
  const binding = getAuthenticatedSessionBinding();
  if (!binding) throw new Error('finance_sign_in_required');
  const managed = managedOneAuthentication();
  const managedProcess = wasManagedOneConfigured();
  const cookie = managedProcess ? null : getSessionCookieHeader();
  const headers = managedProcess ? managedOneHeaders('control') : cookie ? {cookie} : null;
  if (!headers || (managedProcess && !managed)) throw new Error('finance_sign_in_required');
  const base = webBaseUrl();
  let ownershipChanged = false;
  const unsubscribe = onAuthSessionOwnershipChanged(() => {
    try {
      const active = getAuthenticatedSessionBinding();
      if (!active || active.sessionId !== binding.sessionId || active.userId !== binding.userId || active.workspaceId !== binding.workspaceId) {
        ownershipChanged = true;
      }
    } catch { ownershipChanged = true; }
  });
  try {
    const assertCurrent = () => {
      scope.assertCurrent();
      const active = getAuthenticatedSessionBinding();
      if (ownershipChanged || !active || active.sessionId !== binding.sessionId || active.userId !== binding.userId || active.workspaceId !== binding.workspaceId ||
          (managedProcess ? managedOneAuthentication() !== managed : wasManagedOneConfigured() || getSessionCookieHeader() !== cookie)) {
        throw new Error('finance_account_changed');
      }
    };
    async function request(method:'GET'|'POST', body?:unknown) {
      const response = await fetch(`${base}/api/finance/watchlist-sync`, { method, headers:{...headers, ...(body ? {'content-type':'application/json', origin:base} : {})},
        ...(body ? {body:JSON.stringify(body)} : {}), redirect:'error', signal:AbortSignal.timeout(15000) });
      assertCurrent();
      if (!response.ok) throw new Error(`finance_cloud_http_${response.status}`);
      const parsed = envelope.parse(await response.json());
      assertCurrent();
      return parsed.result;
    }
    // Capture before the remote request, so edits made while it is in flight
    // cannot be mistaken for the state the owner agreed to replace.
    const before = direction === 'download' ? await store.load(scope) : null;
    assertCurrent();
    const beforeDigest = before ? createHash('sha256').update(JSON.stringify(before)).digest('hex') : null;
    const remote = await request('GET');
    if (remote && 'status' in remote) throw new Error('finance_cloud_response_invalid');
    if (direction === 'download') {
      if (!remote || remote.deleted) throw new Error('finance_cloud_watchlist_unavailable');
      // Existing holdings, quotes and widgets must remain valid; transaction's
      // full workspace validation refuses a destructive replacement otherwise.
      if (!before || !beforeDigest) throw new Error('finance_cloud_response_invalid');
      // The full auth check also runs immediately before the store's rename,
      // including managed credential replacement within the same host epoch.
      await store.transaction({ ...scope, assertCurrent }, before.revision, current => {
        assertCurrent();
        if (current.ownerScope !== before.ownerScope || createHash('sha256').update(JSON.stringify(current)).digest('hex') !== beforeDigest) {
          throw new Error('finance_revision_conflict');
        }
        return validateFinanceWorkspace({...current, watchlist:remote.assets});
      });
      assertCurrent();
      return;
    }
    if (remote?.deleted) throw new Error('finance_cloud_watchlist_deleted');
    const local = await store.load(scope); assertCurrent();
    if (local.watchlist.length > 1000) throw new Error('finance_cloud_watchlist_count_limit');
    if (Buffer.byteLength(JSON.stringify(local.watchlist), 'utf8') > 256 * 1024) throw new Error('finance_cloud_watchlist_size_limit');
    const result = await request('POST', {operationId:randomUUID(), expectedRevision:remote?.revision ?? 0,
      action:remote ? 'replace' : 'enable', assets:local.watchlist});
    if (!result || !('status' in result) || result.record.deleted) throw new Error('finance_cloud_response_invalid');
    assertCurrent();
  } finally { unsubscribe(); }
}
