import { isBusinessSession, sameBusinessSession, type BusinessSession } from '../../shared/business/context';
import { businessOrganizationExecutionContextMatches, businessOrganizationExecutionPendingKey, businessOrganizationExecutionResultMatches,
  freezeBusinessOrganizationExecutionMetadata, isBusinessOrganizationExecutionLookup, isBusinessOrganizationExecutionResult,
  isBusinessOrganizationExecutionSnapshot, type BusinessOrganizationExecutionLookup, type BusinessOrganizationExecutionPanelPort,
  type BusinessOrganizationExecutionResult, type BusinessOrganizationExecutionSnapshot } from '../../shared/business/organization-execution';

/** Existing authenticated ingress/registry owner only. These callbacks create no
 * identity, transport, authority, native action phase, admission lease or queue. */
export interface BusinessOrganizationExecutionOwner {
  authenticatedSession(): BusinessSession | null;
  read(session: BusinessSession): Promise<unknown>;
  control(lookup: Readonly<BusinessOrganizationExecutionLookup>, session: BusinessSession): Promise<unknown>;
  receipt(lookup: Readonly<BusinessOrganizationExecutionLookup>, session: BusinessSession): Promise<unknown>;
  /** Actual CURRENT resource metadata grants; a cached role or TTL is insufficient. */
  currentMetadata(session: BusinessSession, snapshot: Readonly<BusinessOrganizationExecutionSnapshot>): boolean;
  /** Receipt mode reads the exact original claim. It cannot grant redispatch. */
  currentTarget(session: BusinessSession, lookup: Readonly<BusinessOrganizationExecutionLookup>, mode: 'control' | 'receipt'): boolean;
  /** Separate fresh result/receipt read authority for this ORIGINAL selector,
   * immutable target owner and settled revision. Never reuse dispatch permission. */
  currentResult(session: BusinessSession, lookup: Readonly<BusinessOrganizationExecutionLookup>, result: Readonly<BusinessOrganizationExecutionResult>): boolean;
  subscribeInvalidation?(listener: () => void): () => void;
}
export interface BusinessOrganizationExecutionOwners {
  readonly identity: { current(): BusinessSession | null } | null;
  readonly owner: BusinessOrganizationExecutionOwner | null;
}
export interface BusinessOrganizationExecutionAdapter extends BusinessOrganizationExecutionPanelPort {
  invalidate(): void;
  blocker(): string | null;
}
export class BusinessOrganizationExecutionError extends Error {
  constructor(readonly code: 'organization_execution_owner_unbound' | 'organization_execution_context_changed' | 'organization_execution_unavailable'
    | 'organization_execution_invalid_request' | 'organization_execution_target_unavailable' | 'organization_execution_original_receipt_required'
    | 'organization_execution_unknown', readonly uncertain = false) { super(code); }
}
function method<T extends (...args: never[]) => unknown>(owner: unknown, key: string): T | null {
  try {
    if (!owner || typeof owner !== 'object') return null;
    let cursor: object | null = owner;
    for (let depth = 0; cursor && depth < 4; depth++, cursor = Object.getPrototypeOf(cursor) as object | null) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor) return typeof descriptor.value === 'function' ? descriptor.value.bind(owner) as T : null;
    }
  } catch { /* Never execute an accessor or propagate owner diagnostics. */ }
  return null;
}
export function createBusinessOrganizationExecutionAdapter(owners: BusinessOrganizationExecutionOwners,
  now: () => number = Date.now): BusinessOrganizationExecutionAdapter {
  const identity = method<() => BusinessSession | null>(owners.identity, 'current');
  const ingress = method<BusinessOrganizationExecutionOwner['authenticatedSession']>(owners.owner, 'authenticatedSession');
  const readOwner = method<BusinessOrganizationExecutionOwner['read']>(owners.owner, 'read');
  const controlOwner = method<BusinessOrganizationExecutionOwner['control']>(owners.owner, 'control');
  const receiptOwner = method<BusinessOrganizationExecutionOwner['receipt']>(owners.owner, 'receipt');
  const metadataCurrent = method<BusinessOrganizationExecutionOwner['currentMetadata']>(owners.owner, 'currentMetadata');
  const targetCurrent = method<BusinessOrganizationExecutionOwner['currentTarget']>(owners.owner, 'currentTarget');
  const resultCurrent = method<BusinessOrganizationExecutionOwner['currentResult']>(owners.owner, 'currentResult');
  const subscribe = method<NonNullable<BusinessOrganizationExecutionOwner['subscribeInvalidation']>>(owners.owner, 'subscribeInvalidation');
  let generation = 0, reads = 0;
  const listeners = new Set<() => void>();
  // Original selector metadata only. No permission, payload, result or executable
  // command is cached; the server's durable original claim owns restart deduplication.
  const attempted = new Map<string, { namespace: string; lookup: BusinessOrganizationExecutionLookup; pending: boolean }>();
  const knownOwners = new Map<string, string>();
  const blocker = () => !identity || !ingress || !readOwner || !controlOwner || !receiptOwner || !metadataCurrent || !targetCurrent || !resultCurrent
    ? 'organization_execution_owner_unbound' : null;
  const namespace = (session: BusinessSession) => JSON.stringify([session.deploymentId, session.identityAuthorityId, session.organizationId, session.principalId, session.hostId]);
  const candidateKey = (session: BusinessSession, candidateId: string) => JSON.stringify([namespace(session), candidateId]);
  const originalKey = (session: BusinessSession, lookup: BusinessOrganizationExecutionLookup) => JSON.stringify([namespace(session), lookup.candidateId, lookup.action, lookup.expectedRevision]);
  function current(session: BusinessSession, stamp: number): boolean {
    try {
      if (blocker() || generation !== stamp || !isBusinessSession(session) || Date.parse(session.expiresAt) <= now()) return false;
      const native = identity!(), authenticated = ingress!();
      return isBusinessSession(native) && isBusinessSession(authenticated) && sameBusinessSession(native, session) && sameBusinessSession(authenticated, session);
    } catch { return false; }
  }
  function actor(): BusinessSession {
    if (blocker()) throw new BusinessOrganizationExecutionError('organization_execution_owner_unbound');
    try { const value = identity!(); if (isBusinessSession(value)) { const copy = freezeBusinessOrganizationExecutionMetadata(value); if (current(copy, generation)) return copy; } } catch { /* Closed below. */ }
    throw new BusinessOrganizationExecutionError('organization_execution_context_changed');
  }
  const liveMetadata = (session: BusinessSession, snapshot: BusinessOrganizationExecutionSnapshot) => {
    try { return metadataCurrent!(session, snapshot) === true; } catch { return false; }
  };
  const liveTarget = (session: BusinessSession, lookup: BusinessOrganizationExecutionLookup, mode: 'control' | 'receipt') => {
    try { return targetCurrent!(session, lookup, mode) === true; } catch { return false; }
  };
  async function readExact(session: BusinessSession, stamp: number): Promise<BusinessOrganizationExecutionSnapshot> {
    if (!current(session, stamp) || reads >= 64) throw new BusinessOrganizationExecutionError('organization_execution_unavailable');
    reads++;
    try {
      const raw = await readOwner!(session);
      if (!current(session, stamp) || !isBusinessOrganizationExecutionSnapshot(raw, now())) throw new BusinessOrganizationExecutionError('organization_execution_context_changed');
      const snapshot = freezeBusinessOrganizationExecutionMetadata(raw);
      if (!businessOrganizationExecutionContextMatches(snapshot.context, session, now()) || !liveMetadata(session, snapshot) || !current(session, stamp))
        throw new BusinessOrganizationExecutionError('organization_execution_context_changed');
      for (const row of snapshot.rows) {
        if (knownOwners.size >= 4096 && !knownOwners.has(candidateKey(session, row.candidateId))) throw new BusinessOrganizationExecutionError('organization_execution_unavailable');
        knownOwners.set(candidateKey(session, row.candidateId), row.ownerPrincipalId);
      }
      return snapshot;
    } catch { throw new BusinessOrganizationExecutionError('organization_execution_unavailable'); }
    finally { reads--; }
  }
  async function read(): Promise<BusinessOrganizationExecutionSnapshot> {
    const session = actor(), stamp = generation;
    const snapshot = await readExact(session, stamp);
    const scope = namespace(session);
    const rows = snapshot.rows.map(row => {
      const controls = new Map(row.pendingControls.map(item => [businessOrganizationExecutionPendingKey(item), item]));
      for (const record of attempted.values()) if (record.pending && record.namespace === scope && record.lookup.candidateId === row.candidateId)
        controls.set(businessOrganizationExecutionPendingKey(record.lookup), { action: record.lookup.action, expectedRevision: record.lookup.expectedRevision });
      if (controls.size > 64) throw new BusinessOrganizationExecutionError('organization_execution_unavailable');
      return { ...row, pendingControls: [...controls.values()] };
    });
    const view = freezeBusinessOrganizationExecutionMetadata({ ...snapshot, rows });
    // Validate grants on the original server metadata, not locally added holds.
    if (!current(session, stamp) || !liveMetadata(session, snapshot) || !current(session, stamp)) throw new BusinessOrganizationExecutionError('organization_execution_context_changed');
    return view;
  }
  async function invoke(raw: BusinessOrganizationExecutionLookup, receiptOnly: boolean): Promise<BusinessOrganizationExecutionResult> {
    if (!isBusinessOrganizationExecutionLookup(raw)) throw new BusinessOrganizationExecutionError('organization_execution_invalid_request');
    const lookup = freezeBusinessOrganizationExecutionMetadata(raw), session = actor(), stamp = generation;
    const key = originalKey(session, lookup); let started = false;
    if (!receiptOnly && attempted.has(key)) throw new BusinessOrganizationExecutionError('organization_execution_original_receipt_required');
    try {
      let ownerPrincipalId = knownOwners.get(candidateKey(session, lookup.candidateId));
      if (!receiptOnly) {
        const snapshot = await readExact(session, stamp);
        const row = snapshot.rows.find(value => value.candidateId === lookup.candidateId);
        if (!row || row.revision !== lookup.expectedRevision || !row.allowedActions.includes(lookup.action) || !row.readyActions.includes(lookup.action)
          || row.pendingControls.some(value => value.action === lookup.action)) throw new BusinessOrganizationExecutionError('organization_execution_target_unavailable');
        ownerPrincipalId = row.ownerPrincipalId;
      }
      if (!ownerPrincipalId || !current(session, stamp) || !liveTarget(session, lookup, receiptOnly ? 'receipt' : 'control') || !current(session, stamp))
        throw new BusinessOrganizationExecutionError('organization_execution_target_unavailable');
      if (!receiptOnly) {
        // Two preparations can await discovery concurrently; reserve at the final
        // synchronous send boundary and check again, never queue another original.
        if (attempted.has(key)) throw new BusinessOrganizationExecutionError('organization_execution_original_receipt_required');
        if (attempted.size >= 256) throw new BusinessOrganizationExecutionError('organization_execution_unavailable');
        attempted.set(key, { namespace: namespace(session), lookup, pending: true });
      }
      started = true;
      const rawResult = await (receiptOnly ? receiptOwner!(lookup, session) : controlOwner!(lookup, session));
      if (!current(session, stamp) || !isBusinessOrganizationExecutionResult(rawResult)) throw new BusinessOrganizationExecutionError('organization_execution_unknown', !receiptOnly);
      const result = freezeBusinessOrganizationExecutionMetadata(rawResult);
      if (!businessOrganizationExecutionResultMatches(result, lookup, ownerPrincipalId)
        || receiptOnly && !liveTarget(session, lookup, 'receipt')
        || resultCurrent!(session, lookup, result) !== true || !current(session, stamp)) throw new BusinessOrganizationExecutionError('organization_execution_unknown', !receiptOnly);
      const record = attempted.get(key);
      if (record) record.pending = result.stateWrite === 'unknown' || result.effectState === 'unreconciled';
      return result;
    } catch (error) {
      if (started) throw new BusinessOrganizationExecutionError('organization_execution_unknown', !receiptOnly);
      if (error instanceof BusinessOrganizationExecutionError) throw error;
      throw new BusinessOrganizationExecutionError('organization_execution_unavailable');
    }
  }
  function invalidate(): void {
    generation++;
    for (const listener of [...listeners]) try { listener(); } catch { /* Close every display independently. */ }
  }
  return Object.freeze({ read, control: (lookup: BusinessOrganizationExecutionLookup) => invoke(lookup, false),
    receipt: (lookup: BusinessOrganizationExecutionLookup) => invoke(lookup, true), invalidate, blocker,
    subscribeInvalidation(listener: () => void): () => void {
      listeners.add(listener); let off: (() => void) | null = null;
      try { off = subscribe?.(invalidate) ?? null; } catch { invalidate(); }
      return () => { listeners.delete(listener); try { off?.(); } catch { /* Unsubscribe cannot grant or dispatch. */ } };
    },
  } satisfies BusinessOrganizationExecutionAdapter);
}
