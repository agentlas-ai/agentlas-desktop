import { employeeAgentChangeObject as object, employeeAgentChangeHex as hex, employeeAgentChangeId as id,
  employeeAgentChangeCanonical as canonical, isEmployeeAgentChangeBinding, isEmployeeAgentChangeReceipt,
  EMPLOYEE_AGENT_CHANGE_EFFECT_KIND, BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA,
  type EmployeeAgentChangeClaim, type EmployeeAgentChangeReceipt, type EmployeeAgentChangeStage } from '../../shared/business/employee-agent-change';
import { employeeAgentChangeDigest as digest, type EmployeeAgentChangeRegistration, type EmployeeAgentChangeJournal } from './employee-agent-change-adapter';
import { looksSecret } from '../../shared/secret-patterns';

/** A nonterminal audit event in the EXISTING run_events ledger. Never accepted work,
 * command status, One history, a queue, role grant, evaluator or source publication. */
export const EMPLOYEE_AGENT_CHANGE_AUDIT_KIND = 'business_employee_agent_change_audit';
type Db = { readonly inTransaction: boolean; prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
type Ledger = { getDb(): Db; recordRunEvent(input: {
  runId: string; kind: string; chatId: string; agentId: null; sourceEventId: string;
  evidencePhase: 'observed'; correlation: { taskId: string }; payload: Record<string, unknown>;
}): { id: string }; redactRunEventSensitiveText(value: string): string };
export interface EmployeeAgentChangeJournalOwner {
  /** Genuine original serialized lease held ACROSS separately committed audit appends.
   * SQL transaction alone is insufficient; the journal never creates this authority. */
  assertHeldCurrent(scope: object, registration: EmployeeAgentChangeRegistration): boolean;
  originalOperation(scope: object, registration: EmployeeAgentChangeRegistration): Readonly<{
    commandId: string; taskId: string; runId: string; controlVersion: string; originChatId: string; commandPayloadHash: string;
    operationId: string; requestDigest: string;
  }>;
  originalDatabase(scope: object, registration: EmployeeAgentChangeRegistration): object;
}
export interface EmployeeAgentChangeJournalOptions {
  owner: EmployeeAgentChangeJournalOwner; ledger?: () => Ledger;
}
export interface EmployeeAgentChangeJournalWithEvidence extends EmployeeAgentChangeJournal {
  readOriginalClaim(operationId: string, stage: EmployeeAgentChangeStage): Readonly<{
    claim: EmployeeAgentChangeClaim; claimId: string; claimDigest: string; state: 'claimed' | 'settled' | 'unknown';
  }> | null;
}
type Audit = { schema: 'agentlas.business.employee-agent-change.audit.v1'; kind: 'claim' | 'settle' | 'unknown';
  operationId: string; stage: EmployeeAgentChangeStage; claimId: string; claimDigest: string; claim: EmployeeAgentChangeClaim;
  commandId: string; commandPayloadHash: string; originChatId: string; receipt: EmployeeAgentChangeReceipt | null };
const stages: EmployeeAgentChangeStage[] = ['prepare', 'evaluate', 'approve', 'apply'];
function fail(s: string): never { throw new Error(`employee_agent_change_journal_${s}`); }
function value(o: unknown, k: string): unknown { const d = o && (typeof o === 'object' || typeof o === 'function')
  ? Object.getOwnPropertyDescriptor(o, k) : undefined; return d && Object.hasOwn(d, 'value') ? d.value : undefined; }
function fn<T extends (...args: any[]) => any>(o: unknown, k: string): T { const f = value(o, k);
  if (typeof f !== 'function') fail('owner_unavailable'); return f.bind(o) as T; }
function clone<T>(v: T): T { return JSON.parse(canonical(v)); }
function validClaim(c: unknown): c is EmployeeAgentChangeClaim {
  return object(c, ['schema', 'operationId', 'stage', 'effectKind', 'inputDigest', 'requestDigest', 'bindingDigest', 'binding'])
    && c.schema === BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA && id(c.operationId) && stages.includes(c.stage as EmployeeAgentChangeStage)
    && c.effectKind === EMPLOYEE_AGENT_CHANGE_EFFECT_KIND[c.stage as EmployeeAgentChangeStage] && hex(c.inputDigest) && hex(c.requestDigest)
    && isEmployeeAgentChangeBinding(c.binding) && c.bindingDigest === digest(c.binding)
    && c.inputDigest === digest({ stage: c.stage, requestDigest: c.requestDigest, bindingDigest: c.bindingDigest });
}
function sameClaim(a: EmployeeAgentChangeClaim, b: EmployeeAgentChangeClaim): boolean { return digest(a) === digest(b); }
function bound(receipt: unknown, c: EmployeeAgentChangeClaim): receipt is EmployeeAgentChangeReceipt {
  if (!isEmployeeAgentChangeReceipt(receipt)) return false; const b = c.binding;
  return receipt.operationId === c.operationId && receipt.stage === c.stage && receipt.effectKind === c.effectKind
    && receipt.inputDigest === c.inputDigest && receipt.requestDigest === c.requestDigest && receipt.bindingDigest === c.bindingDigest
    && receipt.requesterPrincipalId === b.requester.principalId && receipt.employeePrincipalId === b.employeePrincipalId
    && receipt.organizationId === b.requester.organizationId && receipt.assetId === b.assetId && receipt.assetKind === b.assetKind
    && receipt.taskId === b.taskId && receipt.runId === b.runId && receipt.controlVersion === b.controlVersion
    && receipt.sourceAuthorityId === b.sourceAuthorityId && receipt.sourceRecordId === b.sourceRecordId && receipt.sourceRevision === b.sourceRevision
    && receipt.baseVersionId === b.currentVersionId && receipt.baseDigest === b.currentDigest && digest(receipt.target) === digest(b.target)
    && receipt.historicalVersionId === (b.historical?.versionId ?? null) && receipt.historicalDigest === (b.historical?.digest ?? null)
    && receipt.changedPaths.every(p => b.assetPaths.includes(p));
}

/** Uses actual recordRunEvent idempotent source identity and verifies committed rows,
 * since that primitive returns old content on repeated source IDs. Full JSON is split
 * into bounded hex scalar strings to survive existing safePayload's 800-character
 * bound and diagnostic redaction of noncredential protocol session identities.
 * Audit chunks contain validated metadata only, never file content/root/capabilities. */
export function createEmployeeAgentChangeJournal(options: EmployeeAgentChangeJournalOptions) {
  const owner = value(options, 'owner') as EmployeeAgentChangeJournalOwner, keys = ['assertHeldCurrent', 'originalOperation', 'originalDatabase'] as const;
  const refs = keys.map(k => value(owner, k)); if (refs.some(v => typeof v !== 'function')) fail('owner_unavailable');
  const held = fn<EmployeeAgentChangeJournalOwner['assertHeldCurrent']>(owner, 'assertHeldCurrent');
  const operation = fn<EmployeeAgentChangeJournalOwner['originalOperation']>(owner, 'originalOperation');
  const originalDb = fn<EmployeeAgentChangeJournalOwner['originalDatabase']>(owner, 'originalDatabase');
  const supplied = value(options, 'ledger'); if (supplied !== undefined && typeof supplied !== 'function') fail('ledger_unavailable');
  let namespace: Ledger | null = null, methods: unknown[] = [], db: Db | null = null;
  function source(scope: object, r: EmployeeAgentChangeRegistration) {
    if (keys.some((k, i) => value(owner, k) !== refs[i]) || value(options, 'ledger') !== supplied
      || !held(scope, r) || !isEmployeeAgentChangeBinding(value(r, 'binding'))) fail('original_exclusion_required');
    const op = operation(scope, r);
    if (!object(op, ['commandId', 'taskId', 'runId', 'controlVersion', 'originChatId', 'commandPayloadHash', 'operationId', 'requestDigest'])
      || !id(op.commandId) || !id(op.originChatId) || !id(op.operationId) || !hex(op.requestDigest) || !hex(op.commandPayloadHash) || op.taskId !== r.binding.taskId
      || op.runId !== r.binding.runId || op.controlVersion !== r.binding.controlVersion) fail('original_operation_required');
    const actual: Ledger = supplied ? (supplied as () => Ledger)() : namespace ?? { getDb: require('../store/db').getDb,
      recordRunEvent: require('../store/run-events').recordRunEvent, redactRunEventSensitiveText: require('../store/run-events').redactRunEventSensitiveText };
    if (!namespace) { namespace = actual; methods = [value(actual, 'getDb'), value(actual, 'recordRunEvent'), value(actual, 'redactRunEventSensitiveText')]; }
    if (actual !== namespace || [value(actual, 'getDb'), value(actual, 'recordRunEvent'), value(actual, 'redactRunEventSensitiveText')]
      .some((v, i) => v !== methods[i] || typeof v !== 'function')) fail('ledger_changed');
    const d = actual.getDb(); if (db && db !== d || d !== originalDb(scope, r)) fail('original_database_required'); db = d;
    // An outer transaction can erase a claim after an irreversible FS effect.
    if (d.inTransaction !== false) fail('rollbackable_transaction');
    const row = d.prepare('SELECT command_id, one_id, task_id, run_id, origin_chat_id, payload_hash, state FROM one_supervisor_requests WHERE command_id = ?').get(op.commandId);
    if (!object(row, ['command_id', 'one_id', 'task_id', 'run_id', 'origin_chat_id', 'payload_hash', 'state'])
      || row.command_id !== op.commandId || row.one_id !== r.binding.oneId || row.task_id !== op.taskId || row.run_id !== op.runId
      || row.origin_chat_id !== op.originChatId || row.payload_hash !== op.commandPayloadHash || !['accepted', 'completed'].includes(row.state as string)) fail('original_command_changed');
    if (!held(scope, r)) fail('original_exclusion_required'); return { ledger: actual, db: d, op };
  }
  return Object.freeze({
    forHeldScope(scope: object, registration: EmployeeAgentChangeRegistration): EmployeeAgentChangeJournalWithEvidence {
      // No captured boolean allow: every operation rechecks the original held lease.
      source(scope, registration);
      function assertPublicMetadata(v: unknown, ledger: Ledger, parts: string[] = []): void {
        if (typeof v === 'string') {
          // Native auth.ts:905 emits only native-session:<generation>. This exact
          // noncredential identity allowance applies to TWO locked protocol fields.
          const name = parts.join('.'), nativeIdentity = ['claim.binding.nativeSessionId', 'receipt.employeeReview.nativeSessionId'].includes(name)
            && /^native-session:(?:0|[1-9][0-9]{0,15})$/.test(v) && v === registration.binding.nativeSessionId;
          if (looksSecret(v) || !nativeIdentity && ledger.redactRunEventSensitiveText(v) !== v
            || /(?:^|[:=])\/+|[A-Za-z]:[\\/]/.test(v)) fail('private_metadata');
        } else if (Array.isArray(v)) v.forEach((x, i) => assertPublicMetadata(x, ledger, [...parts, String(i)]));
        else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => assertPublicMetadata(x, ledger, [...parts, k]));
      }
      function rows(operationId: string): Audit[] {
        if (!id(operationId)) fail('selector_invalid'); const { db: d, op } = source(scope, registration);
        if (operationId !== op.operationId) fail('original_operation_required');
        const result = d.prepare("SELECT id, run_id, kind, chat_id, payload_json FROM run_events WHERE run_id = ? AND kind = ? AND json_extract(payload_json, '$.r13OperationId') = ? ORDER BY seq LIMIT 17")
          .all(op.runId, EMPLOYEE_AGENT_CHANGE_AUDIT_KIND, operationId);
        if (result.length > 12) fail('audit_limit');
        return result.map(row => {
          if (!object(row, ['id', 'run_id', 'kind', 'chat_id', 'payload_json']) || row.run_id !== op.runId || row.kind !== EMPLOYEE_AGENT_CHANGE_AUDIT_KIND
            || row.chat_id !== op.originChatId || typeof row.payload_json !== 'string' || row.payload_json.length > 300000) fail('audit_invalid');
          let p: any; try { p = JSON.parse(row.payload_json); } catch { fail('audit_invalid'); }
          if (!p || p.r13Schema !== 'agentlas.business.employee-agent-change.audit.v1' || p.r13Encoding !== 'hex-utf8' || p.r13OperationId !== operationId
            || !Number.isSafeInteger(p.r13ChunkCount) || p.r13ChunkCount < 1 || p.r13ChunkCount > 384 || !hex(p.r13Digest)) fail('audit_invalid');
          const evidence = p.runtimeEvidence;
          if (!object(evidence, ['schemaVersion', 'sourceEventId', 'phase', 'correlation']) || evidence.schemaVersion !== 'agentlas.runtime-evidence.v1'
            || evidence.phase !== 'observed' || evidence.sourceEventId !== `r13:${operationId}:${p.r13Stage}:${p.r13Kind}`
            || !object(evidence.correlation) || evidence.correlation.invocationRunId !== op.runId || evidence.correlation.taskId !== op.taskId) fail('audit_original_evidence');
          const fields = ['r13Schema', 'r13Encoding', 'r13OperationId', 'r13ClaimId', 'r13Stage', 'r13Kind', 'r13ChunkCount', 'r13Digest', 'runtimeEvidence'];
          if (Object.keys(p).length !== fields.length + p.r13ChunkCount
            || Object.keys(p).some(k => !fields.includes(k) && !/^r13Chunk\d{3}$/.test(k))) fail('audit_chunks');
          let encoded = ''; for (let i = 0; i < p.r13ChunkCount; i++) { const chunk = p[`r13Chunk${String(i).padStart(3, '0')}`];
            if (typeof chunk !== 'string' || !/^[a-f0-9]+$/.test(chunk) || chunk.length > 700 || i < p.r13ChunkCount - 1 && chunk.length !== 700) fail('audit_chunks'); encoded += chunk; }
          const data = Buffer.from(encoded, 'hex'), text = data.toString('utf8');
          if (data.toString('hex') !== encoded || Buffer.from(text).toString('hex') !== encoded || looksSecret(text)) fail('audit_chunks');
          let a: any; try { a = JSON.parse(text); } catch { fail('audit_invalid'); }
          if (!object(a, ['schema', 'kind', 'operationId', 'stage', 'claimId', 'claimDigest', 'claim', 'commandId', 'commandPayloadHash', 'originChatId', 'receipt'])
            || canonical(a) !== text || digest(a) !== p.r13Digest || a.schema !== p.r13Schema || !['claim', 'settle', 'unknown'].includes(a.kind as string)
            || !validClaim(a.claim) || a.operationId !== operationId || a.operationId !== a.claim.operationId || a.stage !== a.claim.stage
            || a.claimDigest !== digest(a.claim) || a.claimId !== `r13_${a.claimDigest}` || a.commandId !== op.commandId
            || a.commandPayloadHash !== op.commandPayloadHash || a.originChatId !== op.originChatId || a.claim.requestDigest !== op.requestDigest
            || a.claim.bindingDigest !== digest(registration.binding) || p.r13ClaimId !== a.claimId || p.r13Stage !== a.stage || p.r13Kind !== a.kind
            || (a.kind === 'settle' ? !bound(a.receipt, a.claim) : a.receipt !== null)) fail('audit_binding');
          assertPublicMetadata(a, source(scope, registration).ledger);
          return a as Audit;
        });
      }
      function stageRecords(operationId: string, stage: EmployeeAgentChangeStage) {
        if (!stages.includes(stage)) fail('selector_invalid'); const all = rows(operationId), selected = all.filter(a => a.stage === stage);
        for (const kind of ['claim', 'settle', 'unknown']) if (selected.filter(a => a.kind === kind).length > 1) fail('audit_duplicate');
        const c = selected.find(a => a.kind === 'claim'), settled = selected.find(a => a.kind === 'settle'), uncertain = selected.find(a => a.kind === 'unknown');
        if ((settled || uncertain) && !c || settled && uncertain || selected.some(a => c && !sameClaim(a.claim, c.claim))) fail('audit_conflict');
        return { all, c, settled, uncertain };
      }
      function append(a: Audit): void {
        const { ledger, db: d, op } = source(scope, registration), text = canonical(a);
        if (looksSecret(text)) fail('private_metadata');
        assertPublicMetadata(a, ledger);
        const encoded = Buffer.from(text, 'utf8').toString('hex'), count = Math.ceil(encoded.length / 700);
        if (count > 384) fail('metadata_limit');
        const payload: Record<string, unknown> = { r13Schema: a.schema, r13Encoding: 'hex-utf8', r13OperationId: a.operationId, r13ClaimId: a.claimId,
          r13Stage: a.stage, r13Kind: a.kind, r13ChunkCount: count, r13Digest: digest(a) };
        for (let i = 0; i < count; i++) payload[`r13Chunk${String(i).padStart(3, '0')}`] = encoded.slice(i * 700, (i + 1) * 700);
        ledger.recordRunEvent({ runId: op.runId, kind: EMPLOYEE_AGENT_CHANGE_AUDIT_KIND, chatId: op.originChatId, agentId: null,
          sourceEventId: `r13:${a.operationId}:${a.stage}:${a.kind}`, evidencePhase: 'observed', correlation: { taskId: op.taskId }, payload });
        if (d.inTransaction || !held(scope, registration)) fail('durability_unknown');
        const persisted = rows(a.operationId).filter(v => v.kind === a.kind && v.stage === a.stage);
        if (persisted.length !== 1 || digest(persisted[0]) !== digest(a)) fail('durability_unknown');
      }
      function audit(c: EmployeeAgentChangeClaim, kind: Audit['kind'], receipt: Audit['receipt']): Audit {
        const { op } = source(scope, registration); return { schema: 'agentlas.business.employee-agent-change.audit.v1', kind,
          operationId: c.operationId, stage: c.stage, claimId: `r13_${digest(c)}`, claimDigest: digest(c), claim: clone(c),
          commandId: op.commandId, commandPayloadHash: op.commandPayloadHash, originChatId: op.originChatId, receipt };
      }
      const journal: EmployeeAgentChangeJournalWithEvidence = {
        readOriginalClaim(operationId, stage) {
          const { c, settled, uncertain } = stageRecords(operationId, stage);
          return c ? clone({ claim: c.claim, claimId: c.claimId, claimDigest: c.claimDigest,
            state: uncertain ? 'unknown' : settled ? 'settled' : 'claimed' }) : null;
        },
        claim(c) {
          if (!validClaim(c) || c.bindingDigest !== digest(registration.binding)) fail('claim_invalid');
          const original = source(scope, registration).op;
          if (c.operationId !== original.operationId || c.requestDigest !== original.requestDigest) fail('original_operation_required');
          const { all, c: existing } = stageRecords(c.operationId, c.stage);
          if (all.some(a => a.claim.requestDigest !== c.requestDigest || a.claim.bindingDigest !== c.bindingDigest)) fail('operation_conflict');
          if (existing) { if (!sameClaim(existing.claim, c)) fail('claim_conflict'); return { claimId: existing.claimId, claimDigest: existing.claimDigest, state: 'existing' }; }
          const index = stages.indexOf(c.stage);
          if (index && !all.some(a => a.stage === stages[index - 1] && a.kind === 'settle' && a.receipt?.state !== 'unknown')
            || all.some(a => stages.indexOf(a.stage) > index || a.kind === 'unknown')) fail('predecessor_required');
          const a = audit(c, 'claim', null); append(a); return { claimId: a.claimId, claimDigest: a.claimDigest, state: 'claimed' };
        },
        read(operationId, stage) { const { settled } = stageRecords(operationId, stage); return settled ? clone(settled.receipt) : null; },
        settle(claimId, raw) {
          if (!object(raw, Object.keys(raw)) || !id(raw.operationId) || !stages.includes(raw.stage)) fail('receipt_invalid');
          const { c, settled, uncertain } = stageRecords(raw.operationId, raw.stage);
          if (!c || c.claimId !== claimId || uncertain) fail('claim_required');
          const receipt = { ...clone(raw), receiptId: `r13_receipt_${digest({ claimId, value: raw })}` };
          if (!bound(receipt, c.claim)) fail('receipt_invalid');
          if (settled) { if (digest(settled.receipt) !== digest(receipt)) fail('settlement_conflict'); return clone(settled.receipt!); }
          append(audit(c.claim, 'settle', receipt)); return clone(receipt);
        },
        unknown(claimId) {
          if (!id(claimId)) fail('claim_invalid'); source(scope, registration);
          digestForClaimId(claimId);
          const d = source(scope, registration), candidates = d.db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = ? AND json_extract(payload_json, '$.r13ClaimId') = ? AND json_extract(payload_json, '$.r13Kind') = 'claim' LIMIT 2")
            .all(d.op.runId, EMPLOYEE_AGENT_CHANGE_AUDIT_KIND, claimId);
          if (candidates.length !== 1 || !object(candidates[0], ['payload_json']) || typeof candidates[0].payload_json !== 'string') fail('original_claim_lookup_required');
          let hint: any; try { hint = JSON.parse(candidates[0].payload_json); } catch { fail('audit_invalid'); }
          const found = { operationId: hint.r13OperationId, stage: hint.r13Stage };
          const { c, settled, uncertain } = stageRecords(found.operationId, found.stage);
          if (!c || c.claimId !== claimId || settled) fail('claim_required'); if (!uncertain) append(audit(c.claim, 'unknown', null));
        },
      };
      return Object.freeze(journal);
    },
  });
}
function digestForClaimId(claimId: string): string { if (!/^r13_[a-f0-9]{64}$/.test(claimId)) fail('claim_invalid'); return claimId.slice(4); }
