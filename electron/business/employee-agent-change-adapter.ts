import { createHash } from 'node:crypto';
import type { AgentWorkspaceDiff, AgentWorkspaceProposal } from '../../shared/agent-workspace';
import type { AgentWorkspaceAppliedReadback, AgentWorkspaceMutationLease } from '../agents/workspace-service';
import type { HistoryEvolutionEvaluation } from '../../shared/one-history-evolution';
import {
  BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA, BUSINESS_EMPLOYEE_AGENT_CHANGE_OWNER_PROTOCOL, EMPLOYEE_AGENT_CHANGE_EFFECT_KIND,
  employeeAgentChangeObject as object, employeeAgentChangeArray as array, employeeAgentChangeId as id,
  employeeAgentChangeHex as hex, employeeAgentChangePath as path, employeeAgentChangeCanonical as canonical,
  isEmployeeAgentChangeBinding, isEmployeeAgentChangeRequest, isEmployeeAgentChangeReceipt,
  isEmployeeAgentChangeEvaluation, isEmployeeAgentChangeReview, isEmployeeAgentChangeTarget,
  type EmployeeAgentChangeBinding, type EmployeeAgentChangeRequest, type EmployeeAgentChangeClaim,
  type EmployeeAgentChangeReceipt, type EmployeeAgentChangeReview, type EmployeeAgentChangeStage,
} from '../../shared/business/employee-agent-change';

type Workspace = Pick<typeof import('../agents/workspace-service'), 'prepareAgentWorkspaceFileChange' | 'prepareAgentWorkspaceRollback'
  | 'getAgentWorkspaceDiff' | 'issueAgentWorkspaceApprovalReceipt' | 'applyAgentWorkspaceProposal'>;
export interface EmployeeAgentChangeRegistration {
  readonly commandCapability: object; readonly assetCapability: object;
  readonly authority: object; readonly registry: object; readonly association: object;
  readonly binding: EmployeeAgentChangeBinding;
}
export interface EmployeeAgentChangeJournal {
  /** Original DB/call-ledger insert-and-claim. Must serialize stage order and uncertain
   * predecessor claims across processes. An existing claim MUST NOT be redispatched. */
  claim(input: Readonly<EmployeeAgentChangeClaim>): { readonly claimId: string; readonly claimDigest: string; readonly state: 'claimed' | 'existing' };
  read(operationId: string, stage: EmployeeAgentChangeStage): EmployeeAgentChangeReceipt | null;
  /** Durable original receipt append/CAS; a returned DTO alone is not settlement. */
  settle(claimId: string, value: Omit<EmployeeAgentChangeReceipt, 'receiptId'>): EmployeeAgentChangeReceipt;
  unknown(claimId: string): void;
}
export interface EmployeeAgentChangeExclusion {
  readonly registration: EmployeeAgentChangeRegistration;
  current(): boolean;
  /** Genuine canonical requester manage/content grant AND employee consent/source ACL,
   * target ACL/tombstones/budget/native association under the SAME original exclusion.
   * Proves the entire current/historical WORK root AND workspace ledger are exclusively
   * organization shared, text-only, and have NO private-memory association. Workspace
   * helpers internally enumerate all proposals/memories: personal One is unsupported. */
  assertWorkspaceCustody(binding: Readonly<EmployeeAgentChangeBinding>): boolean;
  readonly journal: EmployeeAgentChangeJournal;
  /** Consume original focused native EMPLOYEE approval, never requester/admin approval.
   * The opaque capability is resolved/one-use checked by its actual original owner. */
  consumeEmployeeApproval(capability: object, review: Readonly<EmployeeAgentChangeReview>): boolean;
  /** Original exact native approval checkpoint is still live for this receipt at APPLY;
   * consumption at approve does not extend focus/session/proof expiry or source grants. */
  employeeApprovalCurrent(receipt: Readonly<EmployeeAgentChangeReceipt>): boolean;
  /** Original fixed-agent held lease readback. No generic workspace view, recovery,
   * baseline creation or private memory enumeration may implement this port. */
  readAppliedWorkspace: AgentWorkspaceMutationLease['readAppliedSnapshot'];
  /** DB/call-ledger reducer under this lease. Verify actual persisted workspace proposal,
   * NEW revision/readback and original task/run/control before the accepted checkpoint.
   * No callback fanout, second task/queue, mirrored authority or publisher ACK. */
  acceptedWorkspaceResult(input: Readonly<{ claim: EmployeeAgentChangeClaim; workspace: Workspace;
    proposal: AgentWorkspaceProposal; snapshot: AgentWorkspaceAppliedReadback }>): {
      readonly receiptId: string; readonly newSourceRevision: string;
      readonly claimDigest: string; readonly proposalId: string; readonly newVersionId: string; readonly newDigest: string;
      readonly target: EmployeeAgentChangeBinding['target'];
    };
}
export interface EmployeeAgentChangeReadScope {
  readonly claim: EmployeeAgentChangeClaim;
  current(): boolean;
  /** Lookup the ORIGINAL durable receipt only. Pending/lost replies remain unknown;
   * this reducer must never prepare, approve, apply, recover or repeat a native effect. */
  receipt(): EmployeeAgentChangeReceipt | null;
}
export interface EmployeeAgentChangeOwner {
  readonly protocol: typeof BUSINESS_EMPLOYEE_AGENT_CHANGE_OWNER_PROTOCOL;
  readonly authority: object; readonly registry: object; readonly association: object;
  /** Original capability Map/registry lookup. A copied DTO or identity is not a capability. */
  resolveOriginal(commandCapability: object, assetCapability: object): EmployeeAgentChangeRegistration | null;
  /** Execute reducer synchronously INSIDE actual authority/native admission lease and
   * serialized original source/workspace exclusion. Preserve original object identity.
   * May return null on refusal. Never await the reducer or replace it with pre/post allow. */
  withCurrentExclusion<T>(registration: EmployeeAgentChangeRegistration, claim: Readonly<EmployeeAgentChangeClaim>,
    reducer: (scope: Readonly<EmployeeAgentChangeExclusion>) => T): Promise<T | null>;
  /** A separately issued current read capability, not the consumed execution token. */
  withCurrentRead<T>(readCapability: object, operationId: string, stage: EmployeeAgentChangeStage,
    reducer: (scope: Readonly<EmployeeAgentChangeReadScope>) => T): Promise<T | null>;
  /** Original owner marks an already durable claim uncertain if the exclusion/reply is
   * lost. DB-only, no new execution authorization and no workspace retries. */
  markOriginalUnknown(registration: EmployeeAgentChangeRegistration, claim: Readonly<EmployeeAgentChangeClaim>): Promise<void>;
  readonly evaluator: {
    oracle(): { readonly id: string; readonly revision: string; readonly fixtureDigest: string };
    evaluate(input: Readonly<{ registration: EmployeeAgentChangeRegistration; claim: EmployeeAgentChangeClaim;
      proposal: AgentWorkspaceDiff; oracle: { readonly id: string; readonly revision: string; readonly fixtureDigest: string } }>): Promise<HistoryEvolutionEvaluation>;
  };
  readonly review: {
    /** Real native focused employee channel; no renderer approved flag or shell receipt. */
    request(input: Readonly<{ registration: EmployeeAgentChangeRegistration; claim: EmployeeAgentChangeClaim;
      proposal: AgentWorkspaceDiff; evaluation: HistoryEvolutionEvaluation }>): Promise<{
        readonly capability: object; readonly metadata: EmployeeAgentChangeReview;
      } | null>;
  };
}
export interface EmployeeAgentChangeAdapterOptions {
  readonly owner: EmployeeAgentChangeOwner;
  /** Dedicated existing workspace namespace supplier. Namespace and all five original
   * functions are pinned. Default loads the actual headless service ONLY inside an effect. */
  readonly workspace?: () => Workspace;
}
export interface EmployeeAgentChangeCommand {
  readonly commandCapability: object; readonly assetCapability: object; readonly request: EmployeeAgentChangeRequest;
}
export class EmployeeAgentChangeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EmployeeAgentChangeError'; }
}
function fail(suffix: string): never { throw new EmployeeAgentChangeError(`employee_agent_change_${suffix}`); }
export const employeeAgentChangeDigest = (v: unknown): string => createHash('sha256').update(canonical(v), 'utf8').digest('hex');
const clone = <T>(v: T): T => JSON.parse(canonical(v)) as T;
function frozen<T>(v: T): T {
  const result = clone(v);
  const freeze = (x: unknown): void => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } };
  freeze(result); return result;
}
/** No accessor is invoked while capturing original capability methods. */
function value(o: unknown, k: string): unknown {
  if (!o || typeof o !== 'object' && typeof o !== 'function') return undefined;
  for (let at: object | null = o as object, depth = 0; at && depth < 8; at = Object.getPrototypeOf(at), depth++) {
    const d = Object.getOwnPropertyDescriptor(at, k); if (d) return Object.hasOwn(d, 'value') ? d.value : undefined;
  }
  return undefined;
}
function callback<T extends (...args: any[]) => any>(o: unknown, k: string): T {
  const fn = value(o, k); if (typeof fn !== 'function') fail('owner_unavailable'); return fn.bind(o) as T;
}
const workspaceMethods = ['prepareAgentWorkspaceFileChange', 'prepareAgentWorkspaceRollback', 'getAgentWorkspaceDiff',
  'issueAgentWorkspaceApprovalReceipt', 'applyAgentWorkspaceProposal'] as const;
const same = (a: unknown, b: unknown): boolean => employeeAgentChangeDigest(a) === employeeAgentChangeDigest(b);
const opaque = (v: unknown): v is object => v !== null && typeof v === 'object';
const stages: readonly EmployeeAgentChangeStage[] = ['prepare', 'evaluate', 'approve', 'apply'];

/** Callable original consumer, with no default actor/grant/source/history/native owner,
 * collection, timer, provider, network, private profile or private-memory fallback. */
export function createBusinessEmployeeAgentChangeAdapter(options: EmployeeAgentChangeAdapterOptions) {
  const owner = value(options, 'owner') as EmployeeAgentChangeOwner | undefined;
  if (!owner || value(owner, 'protocol') !== BUSINESS_EMPLOYEE_AGENT_CHANGE_OWNER_PROTOCOL) fail('owner_unavailable');
  const refs = ['authority', 'registry', 'association', 'resolveOriginal', 'withCurrentExclusion', 'withCurrentRead', 'markOriginalUnknown', 'evaluator', 'review'] as const;
  const originals = refs.map(k => value(owner, k));
  if (originals.slice(0, 3).some(v => !opaque(v))) fail('owner_unavailable');
  const resolve = callback<EmployeeAgentChangeOwner['resolveOriginal']>(owner, 'resolveOriginal');
  const exclude = callback<EmployeeAgentChangeOwner['withCurrentExclusion']>(owner, 'withCurrentExclusion');
  const read = callback<EmployeeAgentChangeOwner['withCurrentRead']>(owner, 'withCurrentRead');
  const unknown = callback<EmployeeAgentChangeOwner['markOriginalUnknown']>(owner, 'markOriginalUnknown');
  const evaluator = value(owner, 'evaluator'), reviewOwner = value(owner, 'review');
  const oracle = callback<EmployeeAgentChangeOwner['evaluator']['oracle']>(evaluator, 'oracle');
  const evaluate = callback<EmployeeAgentChangeOwner['evaluator']['evaluate']>(evaluator, 'evaluate');
  const review = callback<EmployeeAgentChangeOwner['review']['request']>(reviewOwner, 'request');
  const innerReferences = [value(evaluator, 'oracle'), value(evaluator, 'evaluate'), value(reviewOwner, 'request')];
  const supplied = value(options, 'workspace');
  if (supplied !== undefined && typeof supplied !== 'function') fail('workspace_unavailable');
  const supplier = supplied as (() => Workspace) | undefined;
  let namespace: Workspace | null = null, namespaceMethods: unknown[] = [];
  let journal: EmployeeAgentChangeJournal | null = null, journalReferences: unknown[] = [];
  const journals = ['claim', 'read', 'settle', 'unknown'] as const;
  let closed = false;
  const assertOwner = (): void => {
    if (closed || refs.some((k, i) => value(owner, k) !== originals[i])
      || innerReferences.some((fn, i) => fn !== [value(evaluator, 'oracle'), value(evaluator, 'evaluate'), value(reviewOwner, 'request')][i])
      || value(options, 'workspace') !== supplied) fail('owner_changed');
  };
  const workspace = (): Workspace => {
    assertOwner();
    const actual = supplier ? supplier() : require('../agents/workspace-service') as Workspace;
    if (!actual || workspaceMethods.some(k => typeof value(actual, k) !== 'function')) fail('workspace_unavailable');
    if (!namespace) { namespace = actual; namespaceMethods = workspaceMethods.map(k => value(actual, k)); }
    if (actual !== namespace || workspaceMethods.some((k, i) => value(actual, k) !== namespaceMethods[i])) fail('workspace_changed');
    return actual;
  };
  function original(input: EmployeeAgentChangeCommand): { registration: EmployeeAgentChangeRegistration; request: EmployeeAgentChangeRequest } {
    assertOwner();
    if (!object(input, ['commandCapability', 'assetCapability', 'request']) || !opaque(input.commandCapability) || !opaque(input.assetCapability)
      || !isEmployeeAgentChangeRequest(input.request)) fail('invalid_request');
    const request = frozen(input.request), r = resolve(input.commandCapability, input.assetCapability);
    if (!object(r, ['commandCapability', 'assetCapability', 'authority', 'registry', 'association', 'binding'])
      || r.commandCapability !== input.commandCapability || r.assetCapability !== input.assetCapability
      || r.authority !== originals[0] || r.registry !== originals[1] || r.association !== originals[2] || !isEmployeeAgentChangeBinding(r.binding)) fail('original_required');
    const b = r.binding as EmployeeAgentChangeBinding;
    if (Date.parse(b.requester.expiresAt) <= Date.now() || employeeAgentChangeDigest(b) !== request.bindingDigest
      || b.currentVersionId !== request.expectedVersionId || b.currentDigest !== request.expectedDigest) fail('binding_changed');
    if (request.kind === 'edit' ? b.historical !== null || !b.assetPaths.includes(request.path) : !b.historical || b.historical.versionId !== request.historicalVersionId
      || b.historical.digest !== request.historicalDigest) fail('source_scope_required');
    if (request.kind === 'restore') {
      for (const name of b.approvedPaths.filter(p => !b.assetPaths.includes(p))) {
        const current = b.currentFiles.find(f => f.path === name), historical = b.historical!.files.find(f => f.path === name);
        if (!current || !historical || current.digest !== historical.digest || current.executable !== historical.executable) fail('restore_scope_required');
      }
    }
    return { registration: r as unknown as EmployeeAgentChangeRegistration, request };
  }
  function claim(r: EmployeeAgentChangeRegistration, request: EmployeeAgentChangeRequest, stage: EmployeeAgentChangeStage): EmployeeAgentChangeClaim {
    const requestDigest = employeeAgentChangeDigest(request);
    return frozen({ schema: BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA, operationId: request.operationId, stage,
      effectKind: EMPLOYEE_AGENT_CHANGE_EFFECT_KIND[stage],
      inputDigest: employeeAgentChangeDigest({ stage, requestDigest, bindingDigest: request.bindingDigest }), requestDigest,
      bindingDigest: request.bindingDigest, binding: r.binding });
  }
  function boundReceipt(raw: unknown, c: EmployeeAgentChangeClaim, stage: EmployeeAgentChangeStage): EmployeeAgentChangeReceipt {
    if (!isEmployeeAgentChangeReceipt(raw) || raw.operationId !== c.operationId || raw.stage !== stage || raw.bindingDigest !== c.bindingDigest
      || raw.requestDigest !== c.requestDigest || raw.inputDigest !== employeeAgentChangeDigest({ stage, requestDigest: c.requestDigest, bindingDigest: c.bindingDigest })
      || raw.requesterPrincipalId !== c.binding.requester.principalId || raw.employeePrincipalId !== c.binding.employeePrincipalId
      || raw.organizationId !== c.binding.requester.organizationId || raw.assetId !== c.binding.assetId || raw.assetKind !== c.binding.assetKind
      || raw.taskId !== c.binding.taskId || raw.runId !== c.binding.runId || raw.controlVersion !== c.binding.controlVersion
      || raw.sourceAuthorityId !== c.binding.sourceAuthorityId || raw.sourceRecordId !== c.binding.sourceRecordId
      || raw.sourceRevision !== c.binding.sourceRevision || raw.baseVersionId !== c.binding.currentVersionId || raw.baseDigest !== c.binding.currentDigest
      || !same(raw.target, c.binding.target) || raw.changedPaths.some(p => !c.binding.assetPaths.includes(p))
      || raw.evaluation && (raw.evaluation.draftDigest !== raw.proposedDigest || raw.evaluation.envelopeDigest !== c.binding.envelopeDigest)
      || raw.employeeReview && (raw.employeeReview.employeePrincipalId !== c.binding.employeePrincipalId
        || raw.employeeReview.nativePrincipalId !== c.binding.nativePrincipalId || raw.employeeReview.nativeSessionId !== c.binding.nativeSessionId
        || raw.employeeReview.operationId !== c.operationId || raw.employeeReview.bindingDigest !== c.bindingDigest
        || raw.employeeReview.proposalId !== raw.proposalId || raw.employeeReview.reviewedHash !== raw.proposalDigest
        || raw.employeeReview.evaluationDigest !== employeeAgentChangeDigest(raw.evaluation)
        || raw.employeeReview.authorityRevision !== c.binding.authorityRevision)
      || (c.binding.historical ? raw.historicalVersionId !== c.binding.historical.versionId || raw.historicalDigest !== c.binding.historical.digest
        : raw.historicalVersionId !== null || raw.historicalDigest !== null)) fail('receipt_invalid');
    return frozen(raw);
  }
  function predecessor(scope: EmployeeAgentChangeExclusion, c: EmployeeAgentChangeClaim): EmployeeAgentChangeReceipt | null {
    const index = stages.indexOf(c.stage); if (!index) return null;
    const prior = boundReceipt(scope.journal.read(c.operationId, stages[index - 1]), c, stages[index - 1]);
    if (prior.state === 'unknown') fail('receipt_lookup_required');
    return prior;
  }
  function draft(ws: Workspace, c: EmployeeAgentChangeClaim, prior: EmployeeAgentChangeReceipt): AgentWorkspaceDiff {
    const p = ws.getAgentWorkspaceDiff(prior.proposalId!); validateProposal(p, c);
    if (p.proposalDigest !== prior.proposalDigest || p.proposedTreeDigest !== prior.proposedDigest || p.status !== 'review_ready'
      || !same(p.changes.map(x => x.path), prior.changedPaths)) fail('proposal_changed');
    return frozen(p);
  }
  function validateProposal(p: AgentWorkspaceProposal, c: EmployeeAgentChangeClaim): void {
    if (!object(p) || !id(p.id) || p.agentId !== c.binding.assetId || p.baseRevisionId !== c.binding.currentVersionId
      || p.baseTreeDigest !== c.binding.currentDigest || !hex(p.proposedTreeDigest) || !hex(p.proposalDigest)
      || !array(p.memoryEntryIds) || p.memoryEntryIds.length || !array(p.changes) || !p.changes.length
      || p.changes.some(x => !object(x) || !path(x.path) || !c.binding.assetPaths.includes(x.path) || x.binary === true
        || !['create', 'modify', 'delete'].includes(x.operation) || typeof x.beforeContent !== 'string' || typeof x.afterContent !== 'string'
        || x.beforeHash !== null && !hex(x.beforeHash) || x.afterHash !== null && !hex(x.afterHash))
      || new Set(p.changes.map(x => x.path.toLowerCase())).size !== p.changes.length) fail('proposal_scope_changed');
  }
  function result(c: EmployeeAgentChangeClaim, prior: EmployeeAgentChangeReceipt | null, state: EmployeeAgentChangeReceipt['state']): Omit<EmployeeAgentChangeReceipt, 'receiptId'> {
    const b = c.binding;
    return { schema: BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA, operationId: c.operationId, stage: c.stage, effectKind: c.effectKind, state, inputDigest: c.inputDigest, requestDigest: c.requestDigest, bindingDigest: c.bindingDigest,
      requesterPrincipalId: b.requester.principalId, employeePrincipalId: b.employeePrincipalId, organizationId: b.requester.organizationId,
      assetId: b.assetId, assetKind: b.assetKind, taskId: b.taskId, runId: b.runId, controlVersion: b.controlVersion,
      sourceAuthorityId: b.sourceAuthorityId, sourceRecordId: b.sourceRecordId, sourceRevision: b.sourceRevision,
      baseVersionId: b.currentVersionId, baseDigest: b.currentDigest, historicalVersionId: b.historical?.versionId ?? null, historicalDigest: b.historical?.digest ?? null,
      proposalId: prior?.proposalId ?? null, proposalDigest: prior?.proposalDigest ?? null, proposedDigest: prior?.proposedDigest ?? null,
      changedPaths: prior?.changedPaths ?? [], evaluation: prior?.evaluation ?? null, employeeReview: prior?.employeeReview ?? null, approvalReceiptId: prior?.approvalReceiptId ?? null,
      acceptedReceiptId: null, newVersionId: null, newDigest: null, newSourceRevision: null, target: b.target, newTarget: null, reason: null };
  }
  async function excluded<T>(r: EmployeeAgentChangeRegistration, c: EmployeeAgentChangeClaim, fn: (scope: EmployeeAgentChangeExclusion, check: () => void) => T): Promise<T> {
    let produced: T | undefined, called = false, active = true;
    try {
      const returned = await exclude(r, c, scope => {
        if (!active || called) fail('exclusion_invalid'); called = true;
        if (!object(scope, ['registration', 'current', 'assertWorkspaceCustody', 'journal', 'consumeEmployeeApproval', 'employeeApprovalCurrent', 'readAppliedWorkspace', 'acceptedWorkspaceResult'])
          || scope.registration !== r || ['current', 'assertWorkspaceCustody', 'consumeEmployeeApproval', 'employeeApprovalCurrent', 'readAppliedWorkspace', 'acceptedWorkspaceResult']
            .some(k => typeof value(scope, k) !== 'function')) fail('original_exclusion_required');
        const current = callback<() => boolean>(scope, 'current'), custody = callback<EmployeeAgentChangeExclusion['assertWorkspaceCustody']>(scope, 'assertWorkspaceCustody');
        const check = (): void => { assertOwner(); if (employeeAgentChangeDigest(r.binding) !== c.bindingDigest || Date.parse(r.binding.requester.expiresAt) <= Date.now()
          || current() !== true || custody(c.binding) !== true) fail('authority_changed'); };
        check();
        const j = value(scope, 'journal') as EmployeeAgentChangeJournal;
        if (!j || journals.some(k => typeof value(j, k) !== 'function')) fail('journal_unavailable');
        if (!journal) { journal = j; journalReferences = journals.map(k => value(j, k)); }
        if (journal !== j || journals.some((k, i) => value(j, k) !== journalReferences[i])) fail('journal_changed');
        produced = fn(scope, check);
        if (produced && typeof produced === 'object' && typeof value(produced, 'then') === 'function') fail('async_effect_forbidden');
        check(); return produced;
      });
      if (!called || returned === null || returned !== produced) fail('exclusion_unconfirmed');
      return returned;
    } finally { active = false; }
  }
  async function begin<T>(r: EmployeeAgentChangeRegistration, c: EmployeeAgentChangeClaim,
    effect: (scope: EmployeeAgentChangeExclusion, check: () => void, claimId: string, prior: EmployeeAgentChangeReceipt | null) => T): Promise<T> {
    let attempted = false;
    try { return await excluded(r, c, (scope, check) => {
      const prior = predecessor(scope, c);
      const claimResult = scope.journal.claim(c);
      if (!object(claimResult, ['claimId', 'claimDigest', 'state']) || !id(claimResult.claimId)
        || claimResult.claimDigest !== employeeAgentChangeDigest(c) || !['claimed', 'existing'].includes(claimResult.state)) fail('durable_claim_required');
      if (claimResult.state === 'existing') fail('receipt_lookup_required');
      attempted = true; check();
      try { return effect(scope, check, claimResult.claimId, prior); }
      catch { scope.journal.unknown(claimResult.claimId); fail('effect_unknown'); }
    }); } catch (error) {
      if (attempted) { try { await unknown(r, c); } catch { /* Original durable pending claim remains held. */ } fail('effect_unknown'); }
      throw error;
    }
  }
  function settle(scope: EmployeeAgentChangeExclusion, c: EmployeeAgentChangeClaim, claimId: string,
    raw: Omit<EmployeeAgentChangeReceipt, 'receiptId'>): EmployeeAgentChangeReceipt {
    const receipt = scope.journal.settle(claimId, frozen(raw));
    const checked = boundReceipt(receipt, c, c.stage);
    const { receiptId: _id, ...body } = checked;
    if (!same(body, raw) || receipt.inputDigest !== c.inputDigest) fail('receipt_unconfirmed'); return receipt;
  }
  async function prepare(input: EmployeeAgentChangeCommand): Promise<EmployeeAgentChangeReceipt> {
    const { registration: r, request } = original(input), c = claim(r, request, 'prepare');
    return begin(r, c, (scope, check, claimId) => {
      const ws = workspace(); check();
      const p = request.kind === 'edit' ? ws.prepareAgentWorkspaceFileChange({ agentId: r.binding.assetId, targetPath: request.path,
        currentContent: request.currentContent, proposedContent: request.proposedContent })
        : ws.prepareAgentWorkspaceRollback({ agentId: r.binding.assetId, revisionId: request.historicalVersionId });
      check(); validateProposal(p, c);
      if (request.kind === 'edit' && (p.changes.length !== 1 || p.changes[0].path !== request.path
        || p.changes[0].beforeContent !== request.currentContent || p.changes[0].afterContent !== request.proposedContent)) fail('proposal_scope_changed');
      const diff = ws.getAgentWorkspaceDiff(p.id); validateProposal(diff, c);
      if (diff.status !== 'review_ready' || diff.reviewedHash !== p.proposalDigest || diff.proposalDigest !== p.proposalDigest
        || diff.proposedTreeDigest !== p.proposedTreeDigest) fail('proposal_changed');
      check(); return settle(scope, c, claimId, { ...result(c, null, 'prepared'), proposalId: diff.id,
        proposalDigest: diff.proposalDigest, proposedDigest: diff.proposedTreeDigest, changedPaths: diff.changes.map(x => x.path) });
    });
  }
  async function evaluated(input: EmployeeAgentChangeCommand): Promise<EmployeeAgentChangeReceipt> {
    const { registration: r, request } = original(input), c = claim(r, request, 'evaluate');
    const pending = await begin(r, c, (scope, check, claimId, prior) => {
      const p = draft(workspace(), c, prior!); const o = oracle();
      if (!object(o, ['id', 'revision', 'fixtureDigest']) || !id(o.id) || !id(o.revision) || !hex(o.fixtureDigest)) fail('frozen_oracle_required');
      check(); return { claimId, prior: prior!, proposal: p, oracle: frozen(o) };
    });
    try {
      const e = await evaluate({ registration: r, claim: c, proposal: pending.proposal, oracle: pending.oracle });
      if (!isEmployeeAgentChangeEvaluation(e) || e.draftDigest !== pending.proposal.proposedTreeDigest || e.envelopeDigest !== c.binding.envelopeDigest
        || e.oracleId !== pending.oracle.id || e.oracleRevision !== pending.oracle.revision || e.fixtureDigest !== pending.oracle.fixtureDigest) fail('evaluation_invalid');
      return await excluded(r, c, (scope, check) => {
        const prior = predecessor(scope, c); draft(workspace(), c, prior!);
        if (!same(prior, pending.prior) || !same(oracle(), pending.oracle)) fail('evaluation_changed');
        check(); return settle(scope, c, pending.claimId, { ...result(c, prior, 'evaluated'), evaluation: frozen(e) });
      });
    } catch { try { await unknown(r, c); } catch { /* pending original claim */ } fail('effect_unknown'); }
  }
  async function approve(input: EmployeeAgentChangeCommand): Promise<EmployeeAgentChangeReceipt> {
    const { registration: r, request } = original(input), c = claim(r, request, 'approve');
    const pending = await begin(r, c, (scope, check, claimId, prior) => {
      const p = draft(workspace(), c, prior!); check();
      if (!prior!.evaluation || !same(oracle(), { id: prior!.evaluation.oracleId, revision: prior!.evaluation.oracleRevision, fixtureDigest: prior!.evaluation.fixtureDigest })) fail('evaluation_changed');
      return { claimId, prior: prior!, proposal: p };
    });
    try {
      const reviewed = await review({ registration: r, claim: c, proposal: pending.proposal, evaluation: pending.prior.evaluation! });
      if (!object(reviewed, ['capability', 'metadata']) || !opaque(reviewed.capability) || !isEmployeeAgentChangeReview(reviewed.metadata)) fail('native_employee_approval_required');
      const proof = frozen(reviewed.metadata);
      if (proof.employeePrincipalId !== c.binding.employeePrincipalId || proof.nativePrincipalId !== c.binding.nativePrincipalId
        || proof.nativeSessionId !== c.binding.nativeSessionId || proof.operationId !== c.operationId || proof.bindingDigest !== c.bindingDigest
        || proof.proposalId !== pending.proposal.id || proof.reviewedHash !== pending.proposal.proposalDigest
        || proof.evaluationDigest !== employeeAgentChangeDigest(pending.prior.evaluation) || proof.authorityRevision !== c.binding.authorityRevision
        || proof.expiresAt <= Date.now() || proof.expiresAt > Date.parse(c.binding.requester.expiresAt)) fail('native_employee_approval_required');
      return await excluded(r, c, (scope, check) => {
        const prior = predecessor(scope, c), ws = workspace(), p = draft(ws, c, prior!);
        if (!same(prior, pending.prior) || !same(oracle(), { id: prior!.evaluation!.oracleId, revision: prior!.evaluation!.oracleRevision, fixtureDigest: prior!.evaluation!.fixtureDigest })) fail('evaluation_changed');
        if (callback<EmployeeAgentChangeExclusion['consumeEmployeeApproval']>(scope, 'consumeEmployeeApproval')(reviewed.capability, proof) !== true) fail('native_employee_approval_required');
        check(); const approvalReceiptId = ws.issueAgentWorkspaceApprovalReceipt(p.id, p.proposalDigest);
        if (!id(approvalReceiptId)) fail('approval_unconfirmed');
        check(); return settle(scope, c, pending.claimId, { ...result(c, prior, 'approved'), approvalReceiptId, employeeReview: proof });
      });
    } catch { try { await unknown(r, c); } catch { /* pending original claim */ } fail('effect_unknown'); }
  }
  async function apply(input: EmployeeAgentChangeCommand): Promise<EmployeeAgentChangeReceipt> {
    const { registration: r, request } = original(input), c = claim(r, request, 'apply');
    return begin(r, c, (scope, check, claimId, prior) => {
      if (!prior!.employeeReview || prior!.employeeReview.expiresAt <= Date.now()
        || callback<EmployeeAgentChangeExclusion['employeeApprovalCurrent']>(scope, 'employeeApprovalCurrent')(prior!) !== true) fail('native_employee_approval_required');
      const ws = workspace(), p = draft(ws, c, prior!);
      if (!prior!.evaluation || !prior!.approvalReceiptId || !same(oracle(), { id: prior!.evaluation.oracleId, revision: prior!.evaluation.oracleRevision, fixtureDigest: prior!.evaluation.fixtureDigest })) fail('evaluation_changed');
      // Before any write, capture the actual owner accepted reducer. Missing port
      // must not cause a workspace write followed by an invented publisher ACK.
      const accepted = callback<EmployeeAgentChangeExclusion['acceptedWorkspaceResult']>(scope, 'acceptedWorkspaceResult');
      const readback = callback<EmployeeAgentChangeExclusion['readAppliedWorkspace']>(scope, 'readAppliedWorkspace');
      check(); const applied = ws.applyAgentWorkspaceProposal({ proposalId: p.id, reviewedHash: p.proposalDigest, approvalReceiptId: prior!.approvalReceiptId });
      check(); validateProposal(applied, c);
      if (applied.status !== 'applied' || !id(applied.appliedRevisionId) || applied.appliedRevisionId === c.binding.currentVersionId
        || applied.appliedRevisionId === c.binding.historical?.versionId) fail('new_revision_required');
      // Retain the same original mutation lease through exact applied readback and
      // accepted checkpoint. A general workspace view may recover or create state.
      const snapshot = readback({ proposalId: p.id, reviewedHash: p.proposalDigest, approvalReceiptId: prior!.approvalReceiptId });
      if (!object(snapshot) || snapshot.agentId !== r.binding.assetId || snapshot.currentRevisionId !== applied.appliedRevisionId
        || snapshot.treeDigest !== p.proposedTreeDigest || snapshot.activation !== 'ready' || !array(snapshot.memoryCandidates) || snapshot.memoryCandidates.length
        || !array(snapshot.files) || snapshot.files.some(f => !object(f) || !path(f.path) || !c.binding.approvedPaths.includes(f.path) || f.binary === true)
        || new Set(snapshot.files.map(f => f.path)).size !== snapshot.files.length) fail('readback_unknown');
      const resultingPaths = request.kind === 'restore' ? c.binding.historical!.paths
        : [...new Set([...c.binding.currentPaths, request.path])];
      if (!same([...snapshot.files.map(f => f.path)].sort(), [...resultingPaths].sort())) fail('readback_scope_changed');
      check(); const checkpoint = accepted({ claim: c, workspace: ws, proposal: applied, snapshot });
      if (!object(checkpoint, ['receiptId', 'newSourceRevision', 'claimDigest', 'proposalId', 'newVersionId', 'newDigest', 'target'])
        || checkpoint.claimDigest !== employeeAgentChangeDigest(c) || checkpoint.proposalId !== applied.id
        || checkpoint.newVersionId !== snapshot.currentRevisionId || checkpoint.newDigest !== snapshot.treeDigest
        || !id(checkpoint.receiptId) || !id(checkpoint.newSourceRevision)
        || checkpoint.newSourceRevision === c.binding.sourceRevision || !isEmployeeAgentChangeTarget(checkpoint.target)
        || checkpoint.target.resourceId !== c.binding.target.resourceId || checkpoint.target.scope.kind !== 'organization'
        || checkpoint.target.scope.organizationId !== c.binding.requester.organizationId
        || checkpoint.target.revision <= c.binding.target.revision || checkpoint.target.aclRevision !== c.binding.target.aclRevision) fail('accepted_result_unconfirmed');
      check(); return settle(scope, c, claimId, { ...result(c, prior, 'applied'), acceptedReceiptId: checkpoint.receiptId,
        newVersionId: snapshot.currentRevisionId, newDigest: snapshot.treeDigest, newSourceRevision: checkpoint.newSourceRevision, newTarget: checkpoint.target });
    });
  }
  async function lookup(input: { readonly readCapability: object; readonly operationId: string; readonly stage: EmployeeAgentChangeStage }): Promise<EmployeeAgentChangeReceipt | null> {
    assertOwner(); if (!object(input, ['readCapability', 'operationId', 'stage']) || !opaque(input.readCapability) || !id(input.operationId) || !stages.includes(input.stage)) fail('invalid_request');
    let called = false, active = true, produced: EmployeeAgentChangeReceipt | null = null;
    try {
      const returned = await read(input.readCapability, input.operationId, input.stage, scope => {
        if (!active || called || !object(scope, ['claim', 'current', 'receipt'])) fail('read_capability_required'); called = true;
        const current = callback<() => boolean>(scope, 'current');
        const c = scope.claim;
        if (!object(c, ['schema', 'operationId', 'stage', 'effectKind', 'inputDigest', 'requestDigest', 'bindingDigest', 'binding']) || c.schema !== BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA
          || c.operationId !== input.operationId || c.stage !== input.stage || !hex(c.inputDigest) || !hex(c.requestDigest) || !hex(c.bindingDigest)
          || c.effectKind !== EMPLOYEE_AGENT_CHANGE_EFFECT_KIND[c.stage]
          || c.inputDigest !== employeeAgentChangeDigest({ stage: c.stage, requestDigest: c.requestDigest, bindingDigest: c.bindingDigest })
          || !isEmployeeAgentChangeBinding(c.binding) || employeeAgentChangeDigest(c.binding) !== c.bindingDigest || current() !== true) fail('read_capability_required');
        const receipt = callback<EmployeeAgentChangeReadScope['receipt']>(scope, 'receipt')();
        if (receipt !== null) { produced = boundReceipt(receipt, c, input.stage); if (produced.inputDigest !== c.inputDigest) fail('receipt_invalid'); }
        assertOwner(); if (current() !== true) fail('read_authority_changed'); return produced;
      });
      if (!called || returned !== produced) fail('read_unconfirmed'); return produced;
    } finally { active = false; }
  }
  return Object.freeze({ prepare, evaluate: evaluated, approve, apply, lookup, close: () => { closed = true; } });
}
