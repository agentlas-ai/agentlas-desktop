import { isBusinessId, isBusinessRevision } from './context';
import { employeeAgentChangeObject as object, employeeAgentChangeArray as array, employeeAgentChangePath as portable,
  employeeAgentChangeHex as hex, employeeAgentChangeCanonical } from './employee-agent-change';
import { looksSecret, redactSecrets } from '../secret-patterns';

/** Transfer content is company-owned, individually approved material. A package
 * contains no native/organization session, grant, invocation handle or provider
 * configuration. Report-sharing consent never authorizes this purpose. */
export const EMPLOYEE_AGENT_TRANSFER_PURPOSE = 'organization.employee-agent-transfer' as const;
export const EMPLOYEE_AGENT_TRANSFER_SCHEMA = 'agentlas.business.employee-agent-transfer.v1' as const;
export const EMPLOYEE_AGENT_TRANSFER_MAX_FILES = 64;
export const EMPLOYEE_AGENT_TRANSFER_MAX_BYTES = 196608;
export type EmployeeAgentTransferKind = 'definition' | 'skill' | 'company-memory' | 'work-artifact';
export interface EmployeeAgentTransferFile {
  readonly path: string; readonly kind: EmployeeAgentTransferKind; readonly digest: string; readonly bytes: number;
  readonly source: { readonly authorityId: string; readonly recordId: string; readonly revision: string; readonly approvalReceiptId: string };
}
/** Issued by current organization authority after source/target enrollment and
 * resource authorization. A copied ticket is data, never local admission. */
export interface EmployeeAgentTransferTicket {
  readonly schema: typeof EMPLOYEE_AGENT_TRANSFER_SCHEMA;
  readonly purpose: typeof EMPLOYEE_AGENT_TRANSFER_PURPOSE;
  readonly transferId: string; readonly snapshotId: string; readonly idempotencyKey: string; readonly mode: 'clone' | 'succession';
  readonly organizationId: string; readonly deploymentId: string; readonly identityAuthorityId: string;
  readonly requesterPrincipalId: string;
  readonly source: { readonly employeePrincipalId: string; readonly agentResourceId: string; readonly agentId: string; readonly displayName: string; readonly revision: number };
  readonly target: { readonly employeePrincipalId: string; readonly agentResourceId: string; readonly agentId: string; readonly displayName: string };
  readonly association: { readonly associationId: string; readonly associationRevision: number; readonly sourceRevision: number; readonly consentRevision: number };
  readonly authorityRevision: number; readonly issuedAt: number; readonly expiresAt: number;
  readonly files: readonly EmployeeAgentTransferFile[];
}
export interface EmployeeAgentTransferPackage {
  readonly schema: typeof EMPLOYEE_AGENT_TRANSFER_SCHEMA;
  readonly ticket: EmployeeAgentTransferTicket;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}
export interface EmployeeAgentTransferAcceptance {
  readonly schema: typeof EMPLOYEE_AGENT_TRANSFER_SCHEMA;
  readonly transferId: string; readonly idempotencyKey: string;
  readonly ticketDigest: string; readonly packageDigest: string;
  readonly nativeReviewReceiptId: string; readonly approvedAt: number;
}
/** Authority CAS receipt. Native export/import and company assignment are
 * separate effects. Only state=committed can authorize target materialization. */
export interface EmployeeAgentTransferReceipt {
  readonly schema: typeof EMPLOYEE_AGENT_TRANSFER_SCHEMA;
  readonly transferId: string; readonly idempotencyKey: string; readonly receiptId: string;
  readonly organizationId: string; readonly packageDigest: string; readonly ticketDigest: string;
  readonly sourceAgentId: string; readonly targetAgentId: string; readonly targetEmployeePrincipalId: string;
  readonly mode: 'clone' | 'succession'; readonly sourceRevision: number; readonly targetRevision: number;
  readonly state: 'committed' | 'revoked' | 'unknown'; readonly replayed: boolean;
}
export interface EmployeeAgentTransferLocalReceipt {
  readonly transferId: string; readonly packageDigest: string; readonly agentId: string;
  readonly localState: 'installed' | 'unknown'; readonly companyState: 'committed';
  readonly fileCount: number;
  readonly installationState: 'confirmed' | 'unknown'; readonly installationReceiptId: string | null;
}
export const EMPLOYEE_AGENT_INSTALLATION_SCHEMA = 'agentlas.business.employee-agent-installation.v1' as const;
export interface EmployeeAgentInstallationAck {
  readonly schema: typeof EMPLOYEE_AGENT_INSTALLATION_SCHEMA;
  readonly transferId: string; readonly packageDigest: string; readonly agentId: string; readonly manifestDigest: string;
  readonly fileCount: number; readonly localReceiptId: string; readonly installedAt: number;
  readonly associationId: string; readonly associationRevision: number;
}
export interface EmployeeAgentInstallationReceipt extends EmployeeAgentInstallationAck {
  readonly receiptId: string; readonly receivedAt: number; readonly nativeHostId: string;
  readonly employeePrincipalId: string; readonly state: 'confirmed'; readonly replayed: boolean;
}
export function isEmployeeAgentInstallationAck(v: unknown): v is EmployeeAgentInstallationAck {
  return object(v, ['schema','transferId','packageDigest','agentId','manifestDigest','fileCount','localReceiptId','installedAt','associationId','associationRevision'])
    && v.schema === EMPLOYEE_AGENT_INSTALLATION_SCHEMA && [v.transferId,v.agentId,v.localReceiptId,v.associationId].every(isBusinessId)
    && hex(v.packageDigest) && hex(v.manifestDigest) && isBusinessRevision(v.fileCount) && v.fileCount >= 1 && v.fileCount <= EMPLOYEE_AGENT_TRANSFER_MAX_FILES
    && isBusinessRevision(v.installedAt) && isBusinessRevision(v.associationRevision);
}
export function isEmployeeAgentInstallationReceipt(v: unknown): v is EmployeeAgentInstallationReceipt {
  if (!object(v, ['schema','transferId','packageDigest','agentId','manifestDigest','fileCount','localReceiptId','installedAt','associationId','associationRevision',
    'receiptId','receivedAt','nativeHostId','employeePrincipalId','state','replayed'])) return false;
  const {receiptId,receivedAt,nativeHostId,employeePrincipalId,state,replayed,...ack}=v;
  return isEmployeeAgentInstallationAck(ack) && [receiptId,nativeHostId,employeePrincipalId].every(isBusinessId)
    && isBusinessRevision(receivedAt) && state === 'confirmed' && typeof replayed === 'boolean';
}
export interface EmployeeAgentTransferPrepareRequest {
  readonly transferId: string;
}
export interface EmployeeAgentTransferInbox {
  readonly workAgents:readonly {agentId:string;displayName:string;sourceKind:'company-source'|'transfer'}[];
  readonly sources: readonly { resourceId: string; agentId: string; displayName: string; role: string }[];
  readonly snapshots: readonly { snapshotId: string; sourceAgentResourceId: string; fileCount: number; expiresAt: number }[];
  readonly transfers: readonly { transferId: string; sourceName: string; targetName: string; mode: 'clone' | 'succession';
    direction: 'outgoing' | 'incoming'; state: 'prepared' | 'committed' | 'revoked';
    /** Historical company installation receipt for display; never execution authority. */
    installation?: { readonly state: 'confirmed'; readonly receiptId: string; readonly installedAt: number; readonly agentId: string } | null;
    files: readonly { path: string; kind: EmployeeAgentTransferKind; bytes: number }[] }[];
}
export interface EmployeeAgentTransferAPI {
  registerCompanyAgent(input:{displayName:string;role:string}):Promise<{registrationId:string;agentId:string;state:'pending'|'active'|'unknown'}>;
  prepareAgentSnapshot(input: { sourceAgentResourceId: string }): Promise<{ snapshotId: string; fileCount: number; state: 'prepared' | 'unknown' }>;
  transferInbox(): Promise<EmployeeAgentTransferInbox>;
  /** Employee opens the exact organization-issued request; Main opens a native
   * folder picker and shows every selected body before independent acceptance. */
  exportAgent(input: EmployeeAgentTransferPrepareRequest): Promise<{ acceptanceId: string; transferId: string; state: 'exported' | 'unknown' }>;
  transferReceipt(input: { transferId: string }): Promise<EmployeeAgentTransferReceipt | null>;
  importAgent(input: { transferId: string }): Promise<EmployeeAgentTransferLocalReceipt>;
}
export function employeeAgentTransferPath(value: unknown, kind: EmployeeAgentTransferKind): value is string {
  if (!portable(value) || value.length > 240 || /(?:^|\/)[.]/.test(value)
    || /(?:^|\/)(?:transcripts?|conversations?|chats?|sessions?|providers?|tokens?|auth|keys?|signing|node_modules|hooks)(?:[/.]|$)/i.test(value)
    || /\.(?:exe|dll|so|dylib|zip|gz|tar|bin|wasm)$/i.test(value)) return false;
  if (kind === 'definition') return /^(?:AGENT|agent|system-prompt)\.md$/.test(value);
  if (kind === 'skill') return /^skills\/[^/]+\/(?:[^/]+\/)*[^/]+\.(?:md|txt|json|py|js|ts|sh)$/i.test(value);
  if (kind === 'company-memory') return /^company-memory\/(?:[^/]+\/)*[^/]+\.(?:md|txt|json)$/i.test(value);
  return kind === 'work-artifact' && /^work\/(?:[^/]+\/)*[^/]+\.(?:md|txt|json|csv|html|css|js|ts|py|sh)$/i.test(value);
}
export function employeeAgentTransferSafeText(v: unknown): v is string {
  return typeof v === 'string' && v.length <= EMPLOYEE_AGENT_TRANSFER_MAX_BYTES && !/[\x00\u202a-\u202e\u2066-\u2069]/.test(v)
    && !looksSecret(v) && redactSecrets(v) === v
    && !/\b(?:Authorization\s*:\s*Bearer|Bearer)\s+[A-Za-z0-9._~+\/=-]{4,}/i.test(v)
    && !/\b(?:nativeSessionId|sessionId|invocationLeaseId|signingKeyRef|credentialRef|accessToken|refreshToken|apiKey|cookieValue|hostPrivateKey)\s*["']?\s*[:=]/i.test(v)
    && !/\b(?:https?|wss?):\/\/[^\s/]+:[^\s/]+@/i.test(v);
}
export function isEmployeeAgentTransferFile(v: unknown): v is EmployeeAgentTransferFile {
  return object(v, ['path', 'kind', 'digest', 'bytes', 'source'])
    && ['definition', 'skill', 'company-memory', 'work-artifact'].includes(v.kind as string)
    && employeeAgentTransferPath(v.path, v.kind as EmployeeAgentTransferKind) && hex(v.digest)
    && isBusinessRevision(v.bytes) && v.bytes <= EMPLOYEE_AGENT_TRANSFER_MAX_BYTES
    && object(v.source, ['authorityId', 'recordId', 'revision', 'approvalReceiptId']) && Object.values(v.source).every(isBusinessId);
}
export function isEmployeeAgentTransferTicket(v: unknown): v is EmployeeAgentTransferTicket {
  try {
    if (!object(v, ['schema', 'purpose', 'transferId', 'snapshotId', 'idempotencyKey', 'mode', 'organizationId', 'deploymentId', 'identityAuthorityId',
      'requesterPrincipalId', 'source', 'target', 'association', 'authorityRevision', 'issuedAt', 'expiresAt', 'files'])
      || v.schema !== EMPLOYEE_AGENT_TRANSFER_SCHEMA || v.purpose !== EMPLOYEE_AGENT_TRANSFER_PURPOSE
      || !['clone', 'succession'].includes(v.mode as string)
      || !['transferId', 'snapshotId', 'idempotencyKey', 'organizationId', 'deploymentId', 'identityAuthorityId', 'requesterPrincipalId'].every(k => isBusinessId(v[k]))
      || !object(v.source, ['employeePrincipalId', 'agentResourceId', 'agentId', 'displayName', 'revision'])
      || !['employeePrincipalId', 'agentResourceId', 'agentId'].every(k => isBusinessId((v.source as Record<string, unknown>)[k])) || !isBusinessRevision(v.source.revision)
      || !employeeAgentTransferSafeText(v.source.displayName) || !v.source.displayName.trim() || v.source.displayName.length > 100
      || !object(v.target, ['employeePrincipalId', 'agentResourceId', 'agentId', 'displayName'])
      || !['employeePrincipalId', 'agentResourceId', 'agentId'].every(k => isBusinessId((v.target as Record<string, unknown>)[k]))
      || !/^agt_[A-Za-z0-9_.-]{4,120}$/.test(v.target.agentId as string) || v.target.agentId === v.source.agentId
      || v.target.agentResourceId === v.source.agentResourceId
      || !employeeAgentTransferSafeText(v.target.displayName) || !v.target.displayName.trim() || v.target.displayName.length > 100
      || !object(v.association, ['associationId', 'associationRevision', 'sourceRevision', 'consentRevision'])
      || !isBusinessId(v.association.associationId) || ![v.association.associationRevision, v.association.sourceRevision, v.association.consentRevision,
        v.authorityRevision, v.issuedAt, v.expiresAt].every(isBusinessRevision) || (v.expiresAt as number) <= (v.issuedAt as number) || (v.expiresAt as number) - (v.issuedAt as number) > 600000
      || !array(v.files, EMPLOYEE_AGENT_TRANSFER_MAX_FILES) || !v.files.length || !v.files.every(isEmployeeAgentTransferFile)) return false;
    const rows = v.files as unknown as EmployeeAgentTransferFile[];
    return rows.filter(f => f.kind === 'definition').length === 1 && new Set(rows.map(f => f.path.toLowerCase())).size === rows.length
      && rows.reduce((n, f) => n + f.bytes, 0) <= EMPLOYEE_AGENT_TRANSFER_MAX_BYTES;
  } catch { return false; }
}
export function isEmployeeAgentTransferPackage(v: unknown): v is EmployeeAgentTransferPackage {
  return object(v, ['schema', 'ticket', 'files']) && v.schema === EMPLOYEE_AGENT_TRANSFER_SCHEMA && isEmployeeAgentTransferTicket(v.ticket)
    && array(v.files, EMPLOYEE_AGENT_TRANSFER_MAX_FILES) && v.files.length === v.ticket.files.length
    && v.files.every((f, i) => object(f, ['path', 'content']) && f.path === (v.ticket as unknown as EmployeeAgentTransferTicket).files[i].path && employeeAgentTransferSafeText(f.content));
}
export function isEmployeeAgentTransferReceipt(v: unknown): v is EmployeeAgentTransferReceipt {
  return object(v, ['schema', 'transferId', 'idempotencyKey', 'receiptId', 'organizationId', 'packageDigest', 'ticketDigest', 'sourceAgentId',
    'targetAgentId', 'targetEmployeePrincipalId', 'mode', 'sourceRevision', 'targetRevision', 'state', 'replayed'])
    && v.schema === EMPLOYEE_AGENT_TRANSFER_SCHEMA && ['transferId', 'idempotencyKey', 'receiptId', 'organizationId', 'sourceAgentId', 'targetAgentId',
      'targetEmployeePrincipalId'].every(k => isBusinessId(v[k])) && hex(v.packageDigest) && hex(v.ticketDigest)
    && v.sourceAgentId !== v.targetAgentId && ['clone', 'succession'].includes(v.mode as string)
    && [v.sourceRevision, v.targetRevision].every(isBusinessRevision) && ['committed', 'revoked', 'unknown'].includes(v.state as string) && typeof v.replayed === 'boolean';
}
export const employeeAgentTransferCanonical = employeeAgentChangeCanonical;
