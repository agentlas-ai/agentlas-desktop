import { businessOnlyKeys, isBusinessId, isBusinessRevision, type BusinessResourceRef, type BusinessSession } from './context';
import { isBusinessNativeArray } from './native-registry';
import { unsafeOneMemoryTextReason } from '../one-memory';

/** Value-only mirror of the Web employee-agent report. This DTO grants no access,
 * registers no employee/agent and must never replace the original source owner. */
export const BUSINESS_EMPLOYEE_AGENT_REPORT_SCHEMA = 'agentlas.business.employee-agent-report.v1' as const;
export const BUSINESS_EMPLOYEE_AGENT_RECEIPT_SCHEMA = 'agentlas.business.employee-agent-receipt.v1' as const;
export interface BusinessEmployeeAgentApproval {
  readonly receiptId: string; readonly revision: number; readonly contentDigest: string;
  readonly approvedByPrincipalId: string; readonly audiencePrincipalIds: readonly string[]; readonly expiresAt: string;
}
export interface BusinessEmployeeAgentSource {
  readonly authorityId: string; readonly recordId: string; readonly revision: string;
  readonly resource: BusinessResourceRef; readonly versionId: string; readonly digest: string;
  readonly audiencePrincipalIds: readonly string[]; readonly approval: BusinessEmployeeAgentApproval;
}
export interface BusinessEmployeeAgentOrigin { readonly authorityId: string; readonly recordId: string; readonly revision: string }
export interface BusinessEmployeeAgentBinding {
  readonly deploymentId: string; readonly identityAuthorityId: string; readonly organizationId: string;
  readonly agentResource: BusinessResourceRef; readonly agentId: string; readonly employeePrincipalId: string;
  readonly employeeAuthEpoch: number; readonly profileRevision: string; readonly reportId: string;
  readonly reportRevision: string; readonly origin: BusinessEmployeeAgentOrigin;
}
export interface BusinessEmployeeAgentPersona {
  readonly displayName: string; readonly role: string; readonly summary: string; readonly source: BusinessEmployeeAgentSource;
}
export interface BusinessEmployeeAgentSkill {
  readonly id: string; readonly kind: 'skill' | 'toolchain' | 'agent'; readonly label: string; readonly summary: string;
  readonly source: BusinessEmployeeAgentSource;
}
export interface BusinessEmployeeAgentMemory {
  readonly id: string; readonly kind: 'fact' | 'decision' | 'preference' | 'procedure'; readonly label: string; readonly summary: string;
  readonly source: BusinessEmployeeAgentSource;
}
export interface BusinessEmployeeAgentArtifact {
  readonly id: string; readonly kind: 'page' | 'space' | 'file'; readonly label: string; readonly summary: string;
  readonly source: BusinessEmployeeAgentSource;
}
export interface BusinessEmployeeAgentReport extends BusinessEmployeeAgentBinding {
  readonly schema: typeof BUSINESS_EMPLOYEE_AGENT_REPORT_SCHEMA; readonly producedAt: string; readonly expiresAt: string;
  readonly audiencePrincipalIds: readonly string[]; readonly persona: BusinessEmployeeAgentPersona;
  readonly skills: readonly BusinessEmployeeAgentSkill[]; readonly memory: readonly BusinessEmployeeAgentMemory[];
  readonly artifacts: readonly BusinessEmployeeAgentArtifact[];
}
export interface BusinessEmployeeAgentReportRequest {
  readonly kind: 'report'; readonly agentResourceId: string; readonly ownerReportId: string;
  readonly expectedRevision: number | null; readonly idempotencyKey: string;
}
export interface BusinessEmployeeAgentReceipt {
  readonly schema: typeof BUSINESS_EMPLOYEE_AGENT_RECEIPT_SCHEMA; readonly receiptId: string;
  readonly agentResourceId: string; readonly agentId: string; readonly employeePrincipalId: string;
  readonly kind: 'report' | 'share' | 'pause' | 'revoke'; readonly revision: number;
  readonly reportDigest: string; readonly readBackDigest: string; readonly state: 'reported' | 'shared' | 'paused' | 'revoked';
  readonly nativeReceiptId: string | null; readonly replayed: boolean;
}
export function businessEmployeeAgentOnly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return businessOnlyKeys(value, keys) && Reflect.ownKeys(value).length === keys.length
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => d.enumerable === true);
}
export function businessEmployeeAgentHex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function businessEmployeeAgentIds(value: unknown, nonempty = false): value is readonly string[] {
  return isBusinessNativeArray(value, 64) && (!nonempty || value.length > 0) && value.every(isBusinessId)
    && new Set(value).size === value.length;
}
export function businessEmployeeAgentText(value: unknown, max = 600, nonempty = true): value is string {
  return typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0) && value === value.trim()
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)
    && unsafeOneMemoryTextReason(value) === null
    && !/(?:https?:\/\/|file:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:sk-|AIza|github_pat_|xox[baprs]-))/i.test(value);
}
function expiry(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
export function isBusinessEmployeeAgentResource(value: unknown, organizationId: string): value is BusinessResourceRef {
  return businessEmployeeAgentOnly(value, ['resourceId', 'revision', 'aclRevision', 'scope'])
    && isBusinessId(value.resourceId) && value.resourceId !== organizationId
    && isBusinessRevision(value.revision) && isBusinessRevision(value.aclRevision)
    && businessEmployeeAgentOnly(value.scope, ['kind', 'organizationId'])
    && value.scope.kind === 'organization' && value.scope.organizationId === organizationId;
}
export function isBusinessEmployeeAgentBinding(value: unknown, session: BusinessSession): value is BusinessEmployeeAgentBinding {
  return businessEmployeeAgentOnly(value, ['deploymentId', 'identityAuthorityId', 'organizationId', 'agentResource', 'agentId',
    'employeePrincipalId', 'employeeAuthEpoch', 'profileRevision', 'reportId', 'reportRevision', 'origin'])
    && value.deploymentId === session.deploymentId && value.identityAuthorityId === session.identityAuthorityId
    && value.organizationId === session.organizationId && isBusinessEmployeeAgentResource(value.agentResource, session.organizationId)
    && [value.agentId, value.employeePrincipalId, value.profileRevision, value.reportId, value.reportRevision].every(isBusinessId)
    && isBusinessRevision(value.employeeAuthEpoch) && businessEmployeeAgentOnly(value.origin, ['authorityId', 'recordId', 'revision'])
    && Object.values(value.origin).every(isBusinessId);
}
export function isBusinessEmployeeAgentSource(value: unknown, binding: BusinessEmployeeAgentBinding,
  audience: readonly string[], reportExpiresAt: string): value is BusinessEmployeeAgentSource {
  return businessEmployeeAgentOnly(value, ['authorityId', 'recordId', 'revision', 'resource', 'versionId', 'digest', 'audiencePrincipalIds', 'approval'])
    && [value.authorityId, value.recordId, value.revision, value.versionId].every(isBusinessId) && businessEmployeeAgentHex(value.digest)
    && isBusinessEmployeeAgentResource(value.resource, binding.organizationId) && businessEmployeeAgentIds(value.audiencePrincipalIds, true)
    && audience.every(id => (value.audiencePrincipalIds as readonly string[]).includes(id))
    && businessEmployeeAgentOnly(value.approval, ['receiptId', 'revision', 'contentDigest', 'approvedByPrincipalId', 'audiencePrincipalIds', 'expiresAt'])
    && isBusinessId(value.approval.receiptId) && isBusinessRevision(value.approval.revision) && businessEmployeeAgentHex(value.approval.contentDigest)
    && value.approval.approvedByPrincipalId === binding.employeePrincipalId && expiry(value.approval.expiresAt)
    && Date.parse(value.approval.expiresAt) >= Date.parse(reportExpiresAt)
    && businessEmployeeAgentIds(value.approval.audiencePrincipalIds, true)
    && value.approval.audiencePrincipalIds.length === value.audiencePrincipalIds.length
    && value.approval.audiencePrincipalIds.every(id => (value.audiencePrincipalIds as readonly string[]).includes(id));
}
export function isBusinessEmployeeAgentReport(value: unknown, session: BusinessSession, now = Date.now()): value is BusinessEmployeeAgentReport {
  try {
    const bindings = ['deploymentId', 'identityAuthorityId', 'organizationId', 'agentResource', 'agentId', 'employeePrincipalId',
      'employeeAuthEpoch', 'profileRevision', 'reportId', 'reportRevision', 'origin'];
    if (!businessEmployeeAgentOnly(value, [...bindings, 'schema', 'producedAt', 'expiresAt', 'audiencePrincipalIds', 'persona', 'skills', 'memory', 'artifacts'])
      || !isBusinessEmployeeAgentBinding(Object.fromEntries(bindings.map(key => [key, value[key]])), session)
      || value.schema !== BUSINESS_EMPLOYEE_AGENT_REPORT_SCHEMA || !expiry(value.producedAt) || !expiry(value.expiresAt)
      || Date.parse(value.producedAt) > now || Date.parse(value.producedAt) >= Date.parse(value.expiresAt) || Date.parse(value.expiresAt) <= now
      || !businessEmployeeAgentIds(value.audiencePrincipalIds, true) || !value.audiencePrincipalIds.includes(value.employeePrincipalId as string)) return false;
    const binding = value as unknown as BusinessEmployeeAgentBinding, audience = value.audiencePrincipalIds;
    if (!businessEmployeeAgentOnly(value.persona, ['displayName', 'role', 'summary', 'source'])
      || !businessEmployeeAgentText(value.persona.displayName, 80) || !businessEmployeeAgentText(value.persona.role, 120, false)
      || !businessEmployeeAgentText(value.persona.summary) || !isBusinessEmployeeAgentSource(value.persona.source, binding, audience, value.expiresAt)) return false;
    const ids = new Set<string>();
    for (const [key, kinds] of [['skills', ['skill', 'toolchain', 'agent']], ['memory', ['fact', 'decision', 'preference', 'procedure']],
      ['artifacts', ['page', 'space', 'file']]] as const) {
      const rows = value[key]; if (!isBusinessNativeArray(rows, 16)) return false;
      for (const row of rows) {
        if (!businessEmployeeAgentOnly(row, ['id', 'kind', 'label', 'summary', 'source']) || !isBusinessId(row.id) || ids.has(row.id)
          || !(kinds as readonly unknown[]).includes(row.kind) || !businessEmployeeAgentText(row.label, 120) || !businessEmployeeAgentText(row.summary)
          || !isBusinessEmployeeAgentSource(row.source, binding, audience, value.expiresAt)) return false;
        ids.add(row.id);
      }
    }
    return true;
  } catch { return false; }
}
export function isBusinessEmployeeAgentReportRequest(value: unknown): value is BusinessEmployeeAgentReportRequest {
  try {
    return businessEmployeeAgentOnly(value, ['kind', 'agentResourceId', 'ownerReportId', 'expectedRevision', 'idempotencyKey'])
      && value.kind === 'report' && [value.agentResourceId, value.ownerReportId, value.idempotencyKey].every(isBusinessId)
      && (value.expectedRevision === null || isBusinessRevision(value.expectedRevision) && value.expectedRevision < Number.MAX_SAFE_INTEGER);
  } catch { return false; }
}
