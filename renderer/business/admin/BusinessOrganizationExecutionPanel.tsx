'use client';

import { useEffect, useRef, useState } from 'react';
import type { BusinessSession } from '../../../shared/business/context';
import { BUSINESS_ORGANIZATION_EXECUTION_ACTIONS, businessOrganizationExecutionContextMatches, businessOrganizationExecutionPendingKey,
  businessOrganizationExecutionResultMatches, freezeBusinessOrganizationExecutionMetadata, isBusinessOrganizationExecutionSnapshot,
  type BusinessOrganizationExecutionAction, type BusinessOrganizationExecutionLookup, type BusinessOrganizationExecutionPanelPort,
  type BusinessOrganizationExecutionResult, type BusinessOrganizationExecutionRow, type BusinessOrganizationExecutionSnapshot,
  type BusinessOrganizationExecutionState } from '../../../shared/business/organization-execution';

const actionLabels: Record<BusinessOrganizationExecutionAction, string> = { pause: '일시중지', revoke: '권한 회수', stop: '원래 실행 중지' };
const stateLabels: Record<BusinessOrganizationExecutionState, string> = { candidate: '개선 후보', generating: '초안 준비 중', draft: '초안',
  evaluating: '검증 중', 'review-required': '검토 필요', applying: '적용 중', active: '사용 중', paused: '일시중지', revoked: '회수됨',
  'source-stale': '자료 확인 필요', blocked: '연결 확인 필요', unknown: '상태 미확인', restoring: '복원안 준비 중' };
function contextKey(snapshot: BusinessOrganizationExecutionSnapshot): string { return JSON.stringify(snapshot.context); }
function lookupKey(lookup: BusinessOrganizationExecutionLookup): string { return JSON.stringify([lookup.candidateId, lookup.action, lookup.expectedRevision]); }
function current(snapshot: BusinessOrganizationExecutionSnapshot | null, expected: BusinessSession | null | undefined): snapshot is BusinessOrganizationExecutionSnapshot {
  try { return isBusinessOrganizationExecutionSnapshot(snapshot) && (expected === undefined
    || expected !== null && businessOrganizationExecutionContextMatches(snapshot.context, expected)); } catch { return false; }
}
function outcome(result: BusinessOrganizationExecutionResult): string {
  if (result.effectState === 'unreconciled') return result.stopReceipt?.acknowledgement === 'delivered'
    ? '중지 요청이 전달됐습니다. 실제 작업 중단은 확인이 필요합니다.' : '원래 중지 요청의 처리 상태를 확인해야 합니다.';
  if (result.stateWrite === 'unknown') return '처리 결과가 아직 확인되지 않았습니다. 같은 요청을 다시 보내지 마세요.';
  if (result.stateWrite === 'conflict') return '대상이 변경됐습니다. 현재 상태를 다시 확인하세요.';
  return '조직 제어 기록을 확인했습니다. 현재 상태를 다시 확인하세요.';
}
/** Organization metadata only. Self History/learning content and native controls are
 * never substituted for registered target owners. Missing callbacks supply no rows. */
export function BusinessOrganizationExecutionPanel({ port, expectedSession }: {
  port: BusinessOrganizationExecutionPanelPort | null; expectedSession?: BusinessSession | null;
}) {
  const [snapshot, setSnapshot] = useState<BusinessOrganizationExecutionSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rowLimit, setRowLimit] = useState(20), [receiptLimit, setReceiptLimit] = useState(20);
  const [, redraw] = useState(0);
  const generation = useRef(0), readRequest = useRef(0);
  const active = useRef(new Set<string>());
  // These are display holds, never commands or authority. The adapter/server keep
  // the original claim across refresh or remount. No mutation is automatically retried.
  const controls = useRef(new Map<string, { context: string; lookup: BusinessOrganizationExecutionLookup; pending: boolean }>());
  const snapshotRef = useRef<BusinessOrganizationExecutionSnapshot | null>(null);
  const expectedKey = expectedSession === undefined ? 'owner-current-session' : JSON.stringify(expectedSession);
  const clear = (message: string) => {
    generation.current++; readRequest.current++; snapshotRef.current = null; setSnapshot(null); setLoading(false); setNotice(message);
  };
  async function reload() {
    if (!port) return;
    const stamp = generation.current, request = ++readRequest.current;
    setLoading(true); setNotice(null);
    try {
      const value = await port.read();
      if (stamp !== generation.current || request !== readRequest.current) return;
      if (!current(value, expectedSession)) throw Error('invalid_current_organization_metadata');
      const copy = freezeBusinessOrganizationExecutionMetadata(value);
      if (!current(copy, expectedSession)) throw Error('expired_current_organization_metadata');
      snapshotRef.current = copy; setSnapshot(copy);
    } catch {
      if (stamp === generation.current && request === readRequest.current) {
        snapshotRef.current = null; setSnapshot(null); setNotice('현재 조직의 실행 목록을 확인할 수 없습니다. 연결과 권한을 확인하세요.');
      }
    } finally { if (stamp === generation.current && request === readRequest.current) setLoading(false); }
  }
  useEffect(() => {
    generation.current++; readRequest.current++; snapshotRef.current = null; setSnapshot(null); setNotice(null); setRowLimit(20); setReceiptLimit(20);
    // Port replacement changes the producer. Its own durable pending projection must
    // supply original holds; do not mix metadata from the previous owner into it.
    controls.current.clear();
    if (!port) { setLoading(false); setNotice('조직 실행 관리 연결이 필요합니다.'); return () => { generation.current++; }; }
    let off: (() => void) | undefined;
    try { off = port.subscribeInvalidation?.(() => clear('계정 또는 조직 권한이 바뀌어 실행 목록을 닫았습니다.')); }
    catch { clear('현재 조직의 실행 목록을 확인할 수 없습니다.'); }
    void reload();
    return () => { generation.current++; readRequest.current++; try { off?.(); } catch { /* Teardown cannot dispatch a control. */ } };
  }, [port, expectedKey]);
  useEffect(() => {
    if (!snapshot) return;
    const expiresAt = Date.parse(snapshot.context.expiresAt); let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (expiresAt > Date.now()) timer = setTimeout(check, Math.min(2147483647, expiresAt - Date.now()));
      else clear('조직 표시가 만료됐습니다. 현재 상태를 다시 확인하세요.');
    };
    timer = setTimeout(check, Math.max(0, Math.min(2147483647, expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [snapshot?.context.expiresAt]);

  function pendingFor(row: BusinessOrganizationExecutionRow, scope: string): BusinessOrganizationExecutionLookup[] {
    const original = new Map(row.pendingControls.map(value => [businessOrganizationExecutionPendingKey(value), { candidateId: row.candidateId, ...value }]));
    for (const value of controls.current.values()) if (value.pending && value.context === scope && value.lookup.candidateId === row.candidateId)
      original.set(businessOrganizationExecutionPendingKey(value.lookup), value.lookup);
    return [...original.values()];
  }
  async function act(row: BusinessOrganizationExecutionRow, action: BusinessOrganizationExecutionAction, original?: BusinessOrganizationExecutionLookup) {
    const view = snapshotRef.current;
    if (!port || !current(view, expectedSession)) return;
    const scope = contextKey(view);
    const lookup = freezeBusinessOrganizationExecutionMetadata(original ?? { candidateId: row.candidateId, action, expectedRevision: row.revision });
    const id = lookupKey(lookup), workKey = `${scope}:${original ? 'receipt' : 'control'}:${id}`;
    if (active.current.has(workKey)) return;
    if (!original && (!row.allowedActions.includes(action) || !row.readyActions.includes(action)
      || pendingFor(row, scope).some(value => value.action === action) || controls.current.has(`${scope}:${id}`))) return;
    const stamp = generation.current;
    if (!original) controls.current.set(`${scope}:${id}`, { context: scope, lookup, pending: true });
    active.current.add(workKey); redraw(value => value + 1); setNotice(null);
    try {
      const result = await (original ? port.receipt(lookup) : port.control(lookup));
      if (stamp !== generation.current || !current(snapshotRef.current, expectedSession) || contextKey(snapshotRef.current) !== scope) return;
      if (!businessOrganizationExecutionResultMatches(result, lookup, row.ownerPrincipalId)) throw Error('invalid_original_control_receipt');
      const record = controls.current.get(`${scope}:${id}`);
      if (record) record.pending = result.stateWrite === 'unknown' || result.effectState === 'unreconciled';
      setNotice(outcome(result));
    } catch {
      if (stamp === generation.current && current(snapshotRef.current, expectedSession) && contextKey(snapshotRef.current) === scope)
        setNotice(original ? '원래 처리 기록을 확인하지 못했습니다. 같은 제어를 다시 보내지 마세요.' : '처리 결과를 확인하지 못했습니다. 원래 처리 기록을 확인하세요.');
    } finally { active.current.delete(workKey); redraw(value => value + 1); }
  }
  const visible = current(snapshot, expectedSession) ? snapshot : null;
  const scope = visible ? contextKey(visible) : '';
  const pending = visible ? visible.rows.flatMap(row => pendingFor(row, scope).map(lookup => ({ row, lookup }))) : [];
  return <section className="business-organization-execution-panel" aria-labelledby="business-organization-execution-heading">
    <div className="business-section-header"><div><h2 id="business-organization-execution-heading">조직 실행 관리</h2>
      <p>허용된 조직 실행의 상태와 원래 처리 기록을 확인합니다.</p></div>
      <button type="button" disabled={!port || loading} onClick={() => void reload()}>현재 상태 확인</button></div>
    {!port && <p role="status">조직 실행 관리 연결 필요 · 목록과 제어를 사용할 수 없습니다.</p>}
    {loading && <p role="status">현재 조직 상태를 확인하고 있습니다.</p>}
    {visible && <p>조직 {visible.context.organizationId} · 관리자 계정 {visible.context.principalId}</p>}
    {visible && visible.rows.length === 0 && <p>현재 권한으로 확인할 수 있는 실행이 없습니다.</p>}
    {visible && <div aria-label="허용된 조직 실행">{visible.rows.slice(0, rowLimit).map(row => <article key={row.candidateId}>
      <h3>실행 {row.candidateId}</h3><p>소유자 {row.ownerPrincipalId} · 프로젝트 {row.projectId} · {stateLabels[row.state]} · revision {row.revision}</p>
      <div>{BUSINESS_ORGANIZATION_EXECUTION_ACTIONS.map(action => {
        const lookup = { candidateId: row.candidateId, action, expectedRevision: row.revision };
        const id = lookupKey(lookup);
        const permitted = row.allowedActions.includes(action), prepared = row.readyActions.includes(action);
        const disabled = !permitted || !prepared || pendingFor(row, scope).some(value => value.action === action)
          || controls.current.has(`${scope}:${id}`) || active.current.has(`${scope}:control:${id}`);
        return <button key={action} type="button" disabled={disabled} aria-label={`${row.candidateId} ${actionLabels[action]}`}
          title={!permitted ? '현재 권한이 필요합니다.' : !prepared ? '원래 실행의 제어 연결이 필요합니다.' : undefined}
          onClick={() => void act(row, action)}>{actionLabels[action]}</button>;
      })}</div></article>)}</div>}
    {visible && visible.rows.length > rowLimit && <button type="button" onClick={() => setRowLimit(value => Math.min(64, value + 20))}>실행 더 보기</button>}
    {pending.length > 0 && <section aria-labelledby="business-organization-pending-heading"><h3 id="business-organization-pending-heading">처리 확인 필요</h3>
      <p>같은 요청을 다시 보내지 않고 원래 영수증만 확인합니다.</p><ul>{pending.slice(0, receiptLimit).map(({ row, lookup }) => {
        const id = lookupKey(lookup);
        return <li key={id}>{lookup.candidateId} · {actionLabels[lookup.action]} · 원래 revision {lookup.expectedRevision}{' '}
          <button type="button" disabled={active.current.has(`${scope}:receipt:${id}`)} aria-label={`${lookup.candidateId} ${actionLabels[lookup.action]} revision ${lookup.expectedRevision} 처리 기록 확인`}
            onClick={() => void act(row, lookup.action, lookup)}>처리 기록 확인</button></li>;
      })}</ul>{pending.length > receiptLimit && <button type="button" onClick={() => setReceiptLimit(value => Math.min(4096, value + 20))}>처리 기록 더 보기</button>}</section>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
