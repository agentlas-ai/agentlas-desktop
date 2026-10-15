import type { BusinessResourceRef, BusinessSession } from './context';
import type { HistoryEvolutionEvaluation } from '../one-history-evolution';

export const BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA = 'agentlas.business.employee-agent-change.v1' as const;
export const BUSINESS_EMPLOYEE_AGENT_CHANGE_OWNER_PROTOCOL = 'agentlas.business.original-employee-agent-change.v1' as const;
export type EmployeeAgentChangeStage = 'prepare' | 'evaluate' | 'approve' | 'apply';
export type EmployeeAgentChangeEffectKind = 'workspace-proposal' | 'frozen-evaluation' | 'workspace-approval' | 'workspace-apply';
export const EMPLOYEE_AGENT_CHANGE_EFFECT_KIND: Readonly<Record<EmployeeAgentChangeStage, EmployeeAgentChangeEffectKind>> = Object.freeze({
  prepare: 'workspace-proposal', evaluate: 'frozen-evaluation', approve: 'workspace-approval', apply: 'workspace-apply',
});
export type EmployeeAgentChangeKind = 'work-persona' | 'skill';
export interface EmployeeAgentChangeFile { readonly path: string; readonly digest: string; readonly executable: boolean }

/** Metadata of the original canonical WORK asset. Neither this DTO nor a requester
 * role is employee consent, a native association, a grant, or a registered capability.
 * The original owner must prove the whole current AND historical workspace is shared,
 * private-memory-free and locked before the workspace service can enumerate it. */
export interface EmployeeAgentChangeBinding {
  readonly requester: BusinessSession;
  readonly employeePrincipalId: string; readonly employeeAuthEpoch: number;
  readonly employeeOrganizationSessionId: string;
  readonly nativePrincipalId: string; readonly nativeSessionId: string; readonly nativeWorkspaceId: string;
  readonly oneId: string; readonly hostId: string; readonly agentResourceId: string;
  readonly assetId: string; readonly assetKind: EmployeeAgentChangeKind; readonly assetRootId: string;
  readonly taskId: string; readonly runId: string; readonly controlVersion: string;
  readonly sourceAuthorityId: string; readonly sourceRecordId: string; readonly sourceRevision: string;
  readonly permissionRevision: string; readonly consentRevision: string; readonly audienceRevision: string;
  readonly authorityRevision: string; readonly budgetRevision: string; readonly payerId: string;
  readonly envelopeDigest: string;
  readonly target: BusinessResourceRef;
  readonly currentVersionId: string; readonly currentDigest: string;
  readonly currentPaths: readonly string[]; readonly approvedPaths: readonly string[];
  /** Semantic target paths differ from whole-root read coverage. A skill restore must
   * never roll back another shared persona, sibling skill or unrelated manifest. */
  readonly assetPaths: readonly string[]; readonly currentFiles: readonly EmployeeAgentChangeFile[];
  readonly historical: null | { readonly versionId: string; readonly digest: string;
    readonly rootId: string; readonly paths: readonly string[]; readonly files: readonly EmployeeAgentChangeFile[] };
}
export type EmployeeAgentChangeRequest =
  | { readonly kind: 'edit'; readonly operationId: string; readonly bindingDigest: string;
      readonly expectedVersionId: string; readonly expectedDigest: string;
      readonly path: string; readonly currentContent: string; readonly proposedContent: string }
  | { readonly kind: 'restore'; readonly operationId: string; readonly bindingDigest: string;
      readonly expectedVersionId: string; readonly expectedDigest: string;
      readonly historicalVersionId: string; readonly historicalDigest: string };
export interface EmployeeAgentChangeClaim {
  readonly schema: typeof BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA;
  readonly operationId: string; readonly stage: EmployeeAgentChangeStage;
  readonly effectKind: EmployeeAgentChangeEffectKind;
  readonly inputDigest: string; readonly requestDigest: string; readonly bindingDigest: string;
  readonly binding: EmployeeAgentChangeBinding;
}
/** Receipts contain no file content, private profile, memory, root path or execution
 * capability. registryRevision/publicationRevision are deliberately absent. */
export interface EmployeeAgentChangeReceipt {
  readonly schema: typeof BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA;
  readonly receiptId: string; readonly operationId: string; readonly stage: EmployeeAgentChangeStage;
  readonly effectKind: EmployeeAgentChangeEffectKind;
  readonly state: 'prepared' | 'evaluated' | 'approved' | 'applied' | 'unknown';
  readonly inputDigest: string; readonly requestDigest: string; readonly bindingDigest: string;
  readonly requesterPrincipalId: string; readonly employeePrincipalId: string; readonly organizationId: string;
  readonly assetId: string; readonly assetKind: EmployeeAgentChangeKind;
  readonly taskId: string; readonly runId: string; readonly controlVersion: string;
  readonly sourceAuthorityId: string; readonly sourceRecordId: string; readonly sourceRevision: string;
  readonly baseVersionId: string; readonly baseDigest: string;
  readonly historicalVersionId: string | null; readonly historicalDigest: string | null;
  readonly proposalId: string | null; readonly proposalDigest: string | null; readonly proposedDigest: string | null;
  readonly changedPaths: readonly string[];
  readonly evaluation: HistoryEvolutionEvaluation | null;
  readonly employeeReview: EmployeeAgentChangeReview | null;
  readonly approvalReceiptId: string | null; readonly acceptedReceiptId: string | null;
  readonly newVersionId: string | null; readonly newDigest: string | null; readonly newSourceRevision: string | null;
  readonly target: BusinessResourceRef; readonly newTarget: BusinessResourceRef | null;
  readonly reason: string | null;
}
export interface EmployeeAgentChangeReview {
  readonly employeePrincipalId: string; readonly nativePrincipalId: string; readonly nativeSessionId: string;
  readonly operationId: string; readonly bindingDigest: string; readonly proposalId: string;
  readonly reviewedHash: string; readonly evaluationDigest: string;
  readonly authorityRevision: string; readonly expiresAt: number;
}

/** Getter-free JSON validation is also used before hashing. Opaque capabilities are
 * NEVER traversed with these helpers; the original owner's registry resolves them. */
export function employeeAgentChangeObject(v: unknown, keys?: readonly string[]): v is Record<string, unknown> {
  try {
    if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
    const own = Reflect.ownKeys(v);
    return own.every(k => typeof k === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'))
      && (!keys || own.length === keys.length && own.every(k => keys.includes(k as string)));
  } catch { return false; }
}
export function employeeAgentChangeArray(v: unknown, max = 512): v is readonly unknown[] {
  try { return Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype && v.length <= max
    && Reflect.ownKeys(v).length === v.length + 1 && Array.from({ length: v.length }, (_, i) => i)
      .every(i => Object.hasOwn(Object.getOwnPropertyDescriptor(v, String(i)) ?? {}, 'value')); } catch { return false; }
}
export const employeeAgentChangeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(v);
export const employeeAgentChangeHex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** Relative portable path. Private native persona/memory and credentials are never
 * work assets, even when an administrator includes their names in approvedPaths. */
export function employeeAgentChangePath(v: unknown): v is string {
  if (typeof v !== 'string' || !v || v.length > 512 || v.normalize('NFC') !== v || /[\\\x00-\x1f\x7f:*?<>|"]/.test(v)) return false;
  const parts = v.split('/');
  return parts.every(p => !!p && p !== '.' && p !== '..' && !/[. ]$/.test(p)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
    && !/^(?:SOUL(?:\.[^/]*)?|memory(?:\.[^/]*)?|memories(?:\.[^/]*)?|profile(?:\.[^/]*)?|private(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|\.agentlas|\.git|\.env.*)$/i.test(p))
    && !/\.(?:sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx|log)$/i.test(v);
}
function paths(v: unknown): v is readonly string[] {
  return employeeAgentChangeArray(v) && v.length > 0 && v.every(employeeAgentChangePath)
    && new Set(v.map(p => (p as string).toLowerCase())).size === v.length;
}
export function isEmployeeAgentChangeTarget(v: unknown): v is BusinessResourceRef {
  return employeeAgentChangeObject(v, ['resourceId', 'revision', 'aclRevision', 'scope']) && employeeAgentChangeId(v.resourceId)
    && revision(v.revision) && revision(v.aclRevision)
    && employeeAgentChangeObject(v.scope, ['kind', 'organizationId']) && v.scope.kind === 'organization' && employeeAgentChangeId(v.scope.organizationId);
}
function session(v: unknown): v is BusinessSession {
  return employeeAgentChangeObject(v, ['principalId', 'sessionId', 'sessionRevision', 'authEpoch', 'deploymentId', 'organizationId', 'identityAuthorityId', 'hostId', 'expiresAt'])
    && ['principalId', 'sessionId', 'deploymentId', 'organizationId', 'identityAuthorityId', 'hostId'].every(k => employeeAgentChangeId(v[k]))
    && revision(v.sessionRevision) && revision(v.authEpoch) && typeof v.expiresAt === 'string' && Number.isFinite(Date.parse(v.expiresAt));
}
const bindingKeys = ['requester', 'employeePrincipalId', 'employeeAuthEpoch', 'employeeOrganizationSessionId', 'nativePrincipalId', 'nativeSessionId',
  'nativeWorkspaceId', 'oneId', 'hostId', 'agentResourceId', 'assetId', 'assetKind', 'assetRootId', 'taskId', 'runId', 'controlVersion',
  'sourceAuthorityId', 'sourceRecordId', 'sourceRevision', 'permissionRevision', 'consentRevision', 'audienceRevision', 'authorityRevision',
  'budgetRevision', 'payerId', 'envelopeDigest', 'target', 'currentVersionId', 'currentDigest', 'currentPaths', 'approvedPaths', 'assetPaths', 'currentFiles', 'historical'] as const;
function files(v: unknown, names: readonly string[]): v is readonly EmployeeAgentChangeFile[] {
  return employeeAgentChangeArray(v) && v.length === names.length && v.every(f => employeeAgentChangeObject(f, ['path', 'digest', 'executable'])
    && employeeAgentChangePath(f.path) && names.includes(f.path) && employeeAgentChangeHex(f.digest) && typeof f.executable === 'boolean')
    && new Set(v.map(f => (f as EmployeeAgentChangeFile).path)).size === names.length;
}
export function isEmployeeAgentChangeBinding(v: unknown): v is EmployeeAgentChangeBinding {
  if (!employeeAgentChangeObject(v, bindingKeys) || !session(v.requester) || !revision(v.employeeAuthEpoch)
    || !['work-persona', 'skill'].includes(v.assetKind as string) || !employeeAgentChangeHex(v.envelopeDigest) || !employeeAgentChangeHex(v.currentDigest)
    || !isEmployeeAgentChangeTarget(v.target) || v.target.scope.kind !== 'organization' || v.target.scope.organizationId !== v.requester.organizationId
    || !paths(v.currentPaths) || !paths(v.approvedPaths) || !paths(v.assetPaths)
    || !v.assetPaths.every(p => (v.approvedPaths as readonly string[]).includes(p)) || !files(v.currentFiles, v.currentPaths)) return false;
  const ids = bindingKeys.filter(k => !['requester', 'employeeAuthEpoch', 'assetKind', 'envelopeDigest', 'target', 'currentDigest', 'currentPaths', 'approvedPaths', 'assetPaths', 'currentFiles', 'historical'].includes(k));
  if (!ids.every(k => employeeAgentChangeId(v[k]))) return false;
  if (v.historical !== null && (!employeeAgentChangeObject(v.historical, ['versionId', 'digest', 'rootId', 'paths', 'files'])
    || !employeeAgentChangeId(v.historical.versionId) || !employeeAgentChangeHex(v.historical.digest)
    || v.historical.rootId !== v.assetRootId || !paths(v.historical.paths) || !files(v.historical.files, v.historical.paths))) return false;
  const covered = new Set([...v.currentPaths, ...(v.historical ? v.historical.paths as string[] : [])]);
  return covered.size === v.approvedPaths.length && v.approvedPaths.every(p => covered.has(p));
}
export function isEmployeeAgentChangeRequest(v: unknown): v is EmployeeAgentChangeRequest {
  if (!employeeAgentChangeObject(v) || !['edit', 'restore'].includes(v.kind as string)) return false;
  const keys = ['kind', 'operationId', 'bindingDigest', 'expectedVersionId', 'expectedDigest', ...(v.kind === 'edit'
    ? ['path', 'currentContent', 'proposedContent'] : ['historicalVersionId', 'historicalDigest'])];
  if (!employeeAgentChangeObject(v, keys) || !employeeAgentChangeId(v.operationId) || !employeeAgentChangeId(v.expectedVersionId)
    || !employeeAgentChangeHex(v.bindingDigest) || !employeeAgentChangeHex(v.expectedDigest)) return false;
  return v.kind === 'edit' ? employeeAgentChangePath(v.path) && [v.currentContent, v.proposedContent].every(x => typeof x === 'string' && x.length <= 1_000_000 && !x.includes('\0'))
    : employeeAgentChangeId(v.historicalVersionId) && employeeAgentChangeHex(v.historicalDigest);
}
export function isEmployeeAgentChangeEvaluation(v: unknown): v is HistoryEvolutionEvaluation {
  return employeeAgentChangeObject(v, ['draftDigest', 'envelopeDigest', 'oracleId', 'oracleRevision', 'fixtureDigest', 'resultDigest', 'passed', 'isolated', 'networkAccess', 'providerCalls'])
    && ['draftDigest', 'envelopeDigest', 'fixtureDigest', 'resultDigest'].every(k => employeeAgentChangeHex(v[k]))
    && employeeAgentChangeId(v.oracleId) && employeeAgentChangeId(v.oracleRevision)
    && v.passed === true && v.isolated === true && v.networkAccess === false && v.providerCalls === 0;
}
export function isEmployeeAgentChangeReview(v: unknown): v is EmployeeAgentChangeReview {
  return employeeAgentChangeObject(v, ['employeePrincipalId', 'nativePrincipalId', 'nativeSessionId', 'operationId', 'bindingDigest', 'proposalId', 'reviewedHash', 'evaluationDigest', 'authorityRevision', 'expiresAt'])
    && ['employeePrincipalId', 'nativePrincipalId', 'nativeSessionId', 'operationId', 'proposalId', 'authorityRevision'].every(k => employeeAgentChangeId(v[k]))
    && ['bindingDigest', 'reviewedHash', 'evaluationDigest'].every(k => employeeAgentChangeHex(v[k])) && Number.isSafeInteger(v.expiresAt) && (v.expiresAt as number) > 0;
}
const receiptKeys = ['schema', 'receiptId', 'operationId', 'stage', 'effectKind', 'state', 'inputDigest', 'requestDigest', 'bindingDigest', 'requesterPrincipalId', 'employeePrincipalId',
  'organizationId', 'assetId', 'assetKind', 'taskId', 'runId', 'controlVersion', 'sourceAuthorityId', 'sourceRecordId', 'sourceRevision', 'baseVersionId', 'baseDigest',
  'historicalVersionId', 'historicalDigest', 'proposalId', 'proposalDigest', 'proposedDigest', 'changedPaths', 'evaluation', 'employeeReview', 'approvalReceiptId',
  'acceptedReceiptId', 'newVersionId', 'newDigest', 'newSourceRevision', 'target', 'newTarget', 'reason'] as const;
export function isEmployeeAgentChangeReceipt(v: unknown): v is EmployeeAgentChangeReceipt {
  if (!employeeAgentChangeObject(v, receiptKeys) || v.schema !== BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA
    || !['prepare', 'evaluate', 'approve', 'apply'].includes(v.stage as string) || !['prepared', 'evaluated', 'approved', 'applied', 'unknown'].includes(v.state as string)
    || v.effectKind !== EMPLOYEE_AGENT_CHANGE_EFFECT_KIND[v.stage as EmployeeAgentChangeStage]
    || !['work-persona', 'skill'].includes(v.assetKind as string) || !isEmployeeAgentChangeTarget(v.target)
    || !['receiptId', 'operationId', 'requesterPrincipalId', 'employeePrincipalId', 'organizationId', 'assetId', 'taskId', 'runId', 'controlVersion', 'sourceAuthorityId', 'sourceRecordId', 'sourceRevision', 'baseVersionId'].every(k => employeeAgentChangeId(v[k]))
    || !['inputDigest', 'requestDigest', 'bindingDigest', 'baseDigest'].every(k => employeeAgentChangeHex(v[k]))
    || !['historicalVersionId', 'proposalId', 'approvalReceiptId', 'acceptedReceiptId', 'newVersionId', 'newSourceRevision'].every(k => v[k] === null || employeeAgentChangeId(v[k]))
    || !['historicalDigest', 'proposalDigest', 'proposedDigest', 'newDigest'].every(k => v[k] === null || employeeAgentChangeHex(v[k]))
    || !employeeAgentChangeArray(v.changedPaths) || !v.changedPaths.every(employeeAgentChangePath)
    || new Set(v.changedPaths.map(p => (p as string).toLowerCase())).size !== v.changedPaths.length || (v.evaluation !== null && !isEmployeeAgentChangeEvaluation(v.evaluation))
    || (v.employeeReview !== null && !isEmployeeAgentChangeReview(v.employeeReview))
    || (v.newTarget !== null && !isEmployeeAgentChangeTarget(v.newTarget))
    || !(v.reason === null || typeof v.reason === 'string' && /^employee_agent_change_[a-z_]{1,80}$/.test(v.reason))) return false;
  if ((v.historicalVersionId === null) !== (v.historicalDigest === null)) return false;
  if (v.state === 'unknown') return v.reason !== null;
  if (v.state !== ({ prepare: 'prepared', evaluate: 'evaluated', approve: 'approved', apply: 'applied' } as Record<string, string>)[v.stage as string]
    || v.reason !== null || !v.proposalId || !v.proposalDigest || !v.proposedDigest || !v.changedPaths.length) return false;
  if (v.stage !== 'prepare' && !v.evaluation || ['approve', 'apply'].includes(v.stage as string) && !v.approvalReceiptId) return false;
  if (v.stage === 'prepare' && (v.evaluation !== null || v.approvalReceiptId !== null)
    || v.stage === 'evaluate' && v.approvalReceiptId !== null) return false;
  if (['prepare', 'evaluate'].includes(v.stage as string) ? v.employeeReview !== null : v.employeeReview === null) return false;
  return v.stage === 'apply' ? !!v.acceptedReceiptId && !!v.newVersionId && v.newVersionId !== v.baseVersionId
    && v.newVersionId !== v.historicalVersionId && v.newDigest === v.proposedDigest && !!v.newSourceRevision && !!v.newTarget
    : v.acceptedReceiptId === null && v.newVersionId === null && v.newDigest === null && v.newSourceRevision === null && v.newTarget === null;
}
/** Canonical JSON only, with no getters, symbols, sparse arrays, undefined, cycles or
 * non-finite numbers. Digesting metadata never resolves an opaque capability. */
export function employeeAgentChangeCanonical(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (employeeAgentChangeArray(v, 4096)) return '[' + v.map(employeeAgentChangeCanonical).join(',') + ']';
  if (employeeAgentChangeObject(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + employeeAgentChangeCanonical(v[k])).join(',') + '}';
  throw new TypeError('employee_agent_change_invalid_metadata');
}
