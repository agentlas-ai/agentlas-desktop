import { businessOnlyKeys, isBusinessId, isBusinessRevision, isBusinessSession, type BusinessSession } from './context';
import { isBusinessNativeArray } from './native-registry';
import { looksSecret } from '../secret-patterns';

export const BUSINESS_ORGANIZATION_EXECUTIONS_SCHEMA = 'agentlas.business.organization-executions.v1' as const;
export const BUSINESS_ORGANIZATION_EXECUTION_CONTROL_SCHEMA = 'agentlas.business.evolution-target-control.v1' as const;
export const BUSINESS_ORGANIZATION_EXECUTION_ACTIONS = ['pause', 'revoke', 'stop'] as const;
export const BUSINESS_ORGANIZATION_EXECUTION_STATES = ['candidate', 'generating', 'draft', 'evaluating', 'review-required', 'applying',
  'active', 'paused', 'revoked', 'source-stale', 'blocked', 'unknown', 'restoring'] as const;
export type BusinessOrganizationExecutionAction = typeof BUSINESS_ORGANIZATION_EXECUTION_ACTIONS[number];
export type BusinessOrganizationExecutionState = typeof BUSINESS_ORGANIZATION_EXECUTION_STATES[number];
export interface BusinessOrganizationExecutionContext {
  readonly principalId: string; readonly organizationId: string; readonly hostId: string;
  readonly sessionRevision: number; readonly expiresAt: string;
}
export interface BusinessOrganizationExecutionPending {
  readonly action: BusinessOrganizationExecutionAction; readonly expectedRevision: number;
}
export interface BusinessOrganizationExecutionRow {
  readonly candidateId: string; readonly ownerPrincipalId: string; readonly projectId: string;
  readonly revision: number; readonly state: BusinessOrganizationExecutionState;
  /** Permissions and actual original-command readiness are independent owner results. */
  readonly allowedActions: readonly BusinessOrganizationExecutionAction[];
  readonly readyActions: readonly BusinessOrganizationExecutionAction[];
  readonly pendingControls: readonly BusinessOrganizationExecutionPending[];
}
export interface BusinessOrganizationExecutionSnapshot {
  readonly schema: typeof BUSINESS_ORGANIZATION_EXECUTIONS_SCHEMA;
  readonly context: BusinessOrganizationExecutionContext;
  readonly rows: readonly BusinessOrganizationExecutionRow[];
}
export interface BusinessOrganizationExecutionLookup extends BusinessOrganizationExecutionPending { readonly candidateId: string }
export interface BusinessOrganizationExecutionResult {
  readonly schema: typeof BUSINESS_ORGANIZATION_EXECUTION_CONTROL_SCHEMA;
  readonly candidateId: string; readonly ownerPrincipalId: string;
  readonly stateWrite: 'committed' | 'conflict' | 'unknown';
  readonly revision: number | null; readonly state: BusinessOrganizationExecutionState | null;
  readonly receiptId: string | null; readonly replayed: boolean;
  readonly effectState: 'not_attempted' | 'unreconciled';
  readonly stopReceipt: { readonly receiptId: string; readonly acknowledgement: 'delivered' | 'settled' | 'unknown' } | null;
}
/** Metadata callbacks only. Original identity, grants, commands, exclusion and effects
 * remain with the existing authenticated owner; a renderer cannot supply them. */
export interface BusinessOrganizationExecutionPanelPort {
  read(): Promise<BusinessOrganizationExecutionSnapshot>;
  control(lookup: BusinessOrganizationExecutionLookup): Promise<BusinessOrganizationExecutionResult>;
  receipt(lookup: BusinessOrganizationExecutionLookup): Promise<BusinessOrganizationExecutionResult>;
  subscribeInvalidation?(listener: () => void): () => void;
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return businessOnlyKeys(value, keys) && Reflect.ownKeys(value).length === keys.length;
}
export function isBusinessOrganizationExecutionAction(value: unknown): value is BusinessOrganizationExecutionAction {
  return BUSINESS_ORGANIZATION_EXECUTION_ACTIONS.includes(value as BusinessOrganizationExecutionAction);
}
function state(value: unknown): value is BusinessOrganizationExecutionState {
  return BUSINESS_ORGANIZATION_EXECUTION_STATES.includes(value as BusinessOrganizationExecutionState);
}
function revision(value: unknown): value is number { return isBusinessRevision(value) && value < Number.MAX_SAFE_INTEGER; }
/** Descriptor validation precedes any cloning or owner-field reads. Only bounded
 * plain display metadata is accepted; no payload, SQL object or callback enters it. */
export function isBusinessOrganizationExecutionMetadata(raw: unknown): boolean {
  let remaining = 32768; const stack = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 12) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return isBusinessRevision(value);
    if (typeof value === 'string') return value.length <= 512 && !looksSecret(value) && !/[\u0000-\u001f\u007f]/.test(value);
    if (!value || typeof value !== 'object' || stack.has(value)) return false;
    const array = Array.isArray(value);
    if (array ? !isBusinessNativeArray(value, 256) : Object.getPrototypeOf(value) !== Object.prototype) return false;
    stack.add(value);
    try {
      for (const key of Reflect.ownKeys(value)) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || key.length > 80) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    } finally { stack.delete(value); }
  };
  try { return visit(raw, 0); } catch { return false; }
}
export function isBusinessOrganizationExecutionContext(raw: unknown): raw is BusinessOrganizationExecutionContext {
  return exact(raw, ['principalId', 'organizationId', 'hostId', 'sessionRevision', 'expiresAt'])
    && [raw.principalId, raw.organizationId, raw.hostId].every(isBusinessId) && isBusinessRevision(raw.sessionRevision)
    && typeof raw.expiresAt === 'string' && raw.expiresAt.length <= 40 && Number.isFinite(Date.parse(raw.expiresAt));
}
function pending(raw: unknown): raw is BusinessOrganizationExecutionPending {
  return exact(raw, ['action', 'expectedRevision']) && isBusinessOrganizationExecutionAction(raw.action) && revision(raw.expectedRevision);
}
export function businessOrganizationExecutionPendingKey(value: BusinessOrganizationExecutionPending): string {
  return JSON.stringify([value.action, value.expectedRevision]);
}
export function isBusinessOrganizationExecutionLookup(raw: unknown): raw is BusinessOrganizationExecutionLookup {
  return isBusinessOrganizationExecutionMetadata(raw) && exact(raw, ['candidateId', 'action', 'expectedRevision'])
    && isBusinessId(raw.candidateId) && isBusinessOrganizationExecutionAction(raw.action) && revision(raw.expectedRevision);
}
export function isBusinessOrganizationExecutionSnapshot(raw: unknown, now = Date.now()): raw is BusinessOrganizationExecutionSnapshot {
  if (!isBusinessOrganizationExecutionMetadata(raw) || !exact(raw, ['schema', 'context', 'rows'])
    || raw.schema !== BUSINESS_ORGANIZATION_EXECUTIONS_SCHEMA || !isBusinessOrganizationExecutionContext(raw.context)
    || Date.parse(raw.context.expiresAt) <= now || !isBusinessNativeArray(raw.rows, 64)) return false;
  const actions = (value: unknown): value is readonly BusinessOrganizationExecutionAction[] => isBusinessNativeArray(value, 3)
    && value.every(isBusinessOrganizationExecutionAction) && new Set(value).size === value.length;
  return raw.rows.every(row => exact(row, ['candidateId', 'ownerPrincipalId', 'projectId', 'revision', 'state', 'allowedActions', 'readyActions', 'pendingControls'])
    && [row.candidateId, row.ownerPrincipalId, row.projectId].every(isBusinessId) && revision(row.revision) && state(row.state)
    && actions(row.allowedActions) && actions(row.readyActions) && row.readyActions.every(action => (row.allowedActions as readonly string[]).includes(action))
    && isBusinessNativeArray(row.pendingControls, 64) && row.pendingControls.every(pending)
    && new Set(row.pendingControls.map(item => businessOrganizationExecutionPendingKey(item as BusinessOrganizationExecutionPending))).size === row.pendingControls.length)
    && new Set(raw.rows.map(row => (row as BusinessOrganizationExecutionRow).candidateId)).size === raw.rows.length;
}
export function businessOrganizationExecutionContextMatches(context: BusinessOrganizationExecutionContext, session: BusinessSession, now = Date.now()): boolean {
  return isBusinessOrganizationExecutionContext(context) && isBusinessSession(session) && Date.parse(session.expiresAt) > now
    && context.principalId === session.principalId && context.organizationId === session.organizationId && context.hostId === session.hostId
    && context.sessionRevision === session.sessionRevision && context.expiresAt === session.expiresAt;
}
export function isBusinessOrganizationExecutionResult(raw: unknown): raw is BusinessOrganizationExecutionResult {
  if (!isBusinessOrganizationExecutionMetadata(raw) || !exact(raw, ['schema', 'candidateId', 'ownerPrincipalId', 'stateWrite', 'revision', 'state', 'receiptId', 'replayed', 'effectState', 'stopReceipt'])
    || raw.schema !== BUSINESS_ORGANIZATION_EXECUTION_CONTROL_SCHEMA || ![raw.candidateId, raw.ownerPrincipalId].every(isBusinessId)
    || !['committed', 'conflict', 'unknown'].includes(raw.stateWrite as string) || typeof raw.replayed !== 'boolean'
    || !['not_attempted', 'unreconciled'].includes(raw.effectState as string) || (raw.receiptId !== null && !isBusinessId(raw.receiptId))) return false;
  if (raw.stateWrite === 'committed' ? !isBusinessRevision(raw.revision) || !state(raw.state) || !isBusinessId(raw.receiptId)
    : raw.revision !== null || raw.state !== null) return false;
  return raw.stopReceipt === null || exact(raw.stopReceipt, ['receiptId', 'acknowledgement']) && isBusinessId(raw.stopReceipt.receiptId)
    && ['delivered', 'settled', 'unknown'].includes(raw.stopReceipt.acknowledgement as string);
}
export function businessOrganizationExecutionResultMatches(result: BusinessOrganizationExecutionResult,
  lookup: BusinessOrganizationExecutionLookup, ownerPrincipalId: string): boolean {
  if (!isBusinessOrganizationExecutionResult(result) || !isBusinessOrganizationExecutionLookup(lookup) || !isBusinessId(ownerPrincipalId)
    || result.candidateId !== lookup.candidateId || result.ownerPrincipalId !== ownerPrincipalId) return false;
  if (result.stateWrite === 'committed' && (result.revision !== lookup.expectedRevision + 1
    || (lookup.action === 'revoke' ? result.state !== 'revoked' : !['paused', 'revoked'].includes(result.state!)))) return false;
  if (lookup.action !== 'stop') return result.effectState === 'not_attempted' && result.stopReceipt === null
    && (result.stateWrite !== 'conflict' || result.receiptId === null);
  return result.effectState === (result.receiptId === null ? 'not_attempted' : 'unreconciled')
    && (result.stopReceipt === null || result.receiptId !== null && result.effectState === 'unreconciled');
}
export function freezeBusinessOrganizationExecutionMetadata<T>(value: T): T {
  const result = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(result); return result;
}
