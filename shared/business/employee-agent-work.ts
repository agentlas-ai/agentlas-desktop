import { employeeAgentChangeCanonical, employeeAgentChangeObject, employeeAgentChangeArray } from './employee-agent-change';

export const EMPLOYEE_AGENT_WORK_PURPOSE = 'organization.employee-agent-workspace-change' as const;
export const EMPLOYEE_AGENT_WORK_SCHEMA = 'agentlas.business.declarative-work.v1' as const;
export type WorkValue = number | boolean | string;
export type WorkField = { id: string; type: 'integer' | 'boolean' | 'enum'; values: string[] };
export type WorkNode = { id: string; op: 'copy'; from: string }
  | { id: string; op: 'add'; left: string; right: string }
  | { id: string; op: 'scale'; from: string; numerator: number; denominator: number; rounding: 'exact' | 'half-even' }
  | { id: string; op: 'equal'; left: string; right: string }
  | { id: string; op: 'choose'; condition: string; yes: string; no: string };
/** All executable semantics are in this bounded declaration. Descriptive prose,
 * arbitrary expressions and external tool execution are unsupported. */
export interface WorkProgram {
  schema: typeof EMPLOYEE_AGENT_WORK_SCHEMA;
  inputs: WorkField[]; outputs: Array<WorkField & { from: string }>;
  nodes: WorkNode[];
  capabilities: { network: false; filesystem: false; providers: false; tools: []; sources: []; environment: [] };
}
export interface WorkOracle {
  schema: 'agentlas.business.work-oracle.v1'; oracleId: string; revision: string;
  cases: Array<{ id: string; partition: 'normal' | 'heldout' | 'negative'; input: Record<string, WorkValue>;
    expected: { kind: 'output'; value: Record<string, WorkValue> } | { kind: 'reject'; code: string } }>;
}
export interface WorkAssociationPins {
  purpose: typeof EMPLOYEE_AGENT_WORK_PURPOSE; associationId: string; revision: string;
  organizationId: string; principalId: string; nativeSessionId: string; nativeWorkspaceId: string;
  hostId: string; custodyGeneration: string; installationGeneration: number; consentRevision: string; sourceRevision: string;
}
export interface WorkMaterializationReceipt {
  schema: 'agentlas.business.work-materialization.v1'; kind: 'explicit-work-materialization-acceptance';
  acceptanceId: string; intentId: string; assetId: string; assetRootId: string;
  sourceAgentId: string; sourceDigest: string; approvedPaths: string[];
  revisionId: string; treeDigest: string; reviewReceiptId: string; association: WorkAssociationPins;
  /** Neither local materialization nor local apply is a Root publication ACK. */
  nativeState: 'accepted'; rootRecording: 'not-submitted';
}
export class EmployeeAgentWorkError extends Error { constructor(readonly code: string) { super(code); this.name = 'EmployeeAgentWorkError'; } }
export function workFail(code: string): never { throw new EmployeeAgentWorkError(`employee_agent_work_${code}`); }
export const workObject = employeeAgentChangeObject;
export const workArray = employeeAgentChangeArray;
export const workId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v)
  && !['__proto__', 'prototype', 'constructor'].includes(v);
/** Getter-free canonicalization precedes parsing, iteration and persistence. */
export function workSnapshot<T>(input: T): T {
  const seen=new WeakSet<object>();let nodes=0,bytes=0;
  function walk(v:unknown,depth:number):void{
    if(++nodes>8192||depth>16)workFail('data_limit');
    if(typeof v==='string'){bytes+=v.length;if(bytes>1_000_000)workFail('data_limit');return}
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
    if(typeof v!=='object'||seen.has(v))workFail('data_invalid');seen.add(v);
    if(workArray(v,512)){for(const item of v)walk(item,depth+1)}
    else if(workObject(v)){const keys=Object.keys(v);if(keys.length>128)workFail('data_limit');for(const key of keys){bytes+=key.length;walk(v[key],depth+1)}}
    else workFail('data_invalid');seen.delete(v);
  }
  walk(input,0);
  let text: string; try { text = employeeAgentChangeCanonical(input); } catch { return workFail('data_invalid'); }
  if (text.length > 1_000_000) workFail('data_limit'); return JSON.parse(text);
}
export function assertWorkAssociation(v: unknown): asserts v is WorkAssociationPins {
  const keys = ['purpose','associationId','revision','organizationId','principalId','nativeSessionId','nativeWorkspaceId','hostId','custodyGeneration','installationGeneration','consentRevision','sourceRevision'];
  if (!workObject(v, keys) || v.purpose !== EMPLOYEE_AGENT_WORK_PURPOSE || !Number.isSafeInteger(v.installationGeneration)
    || (v.installationGeneration as number) < 0 || keys.filter(k => k !== 'installationGeneration').some(k => typeof v[k] !== 'string' || !v[k] || (v[k] as string).length > 256)) workFail('association_required');
}

/** Native custody only. Root CAS supplies any later canonical target/revision. */
export type WorkLocalChangeRequest = {kind:'edit';path:string;currentContent:string;proposedContent:string}
 | {kind:'restore';historicalRevisionId:string};
export interface WorkLocalAppliedReceipt {
 schema:'agentlas.business.work-native-applied.v1';nativeState:'native-applied';rootRecording:'not-submitted';
 operationId:string;acceptanceId:string;assetId:string;materializationAcceptanceId:string;nativeSourceRevision:number;
 commandId:string;taskId:string;runId:string;controlVersion:string;requestDigest:string;
 proposalId:string;proposalDigest:string;baseRevisionId:string;newRevisionId:string;treeDigest:string;
 approvalReceiptId:string;nativeReviewReceiptId:string;semanticArtifactId:string;evaluationArtifactId:string;
 association:WorkAssociationPins;
}
