'use client';

import { useEffect, useRef, useState } from 'react';
import { useBusinessCopy } from '../use-business-copy';
import { IconRefresh } from '../../components/Icon';
import type { BusinessSession } from '../../../shared/business/context';
import { BUSINESS_ORGANIZATION_EXECUTION_ACTIONS, businessOrganizationExecutionContextMatches, businessOrganizationExecutionPendingKey,
  businessOrganizationExecutionResultMatches, freezeBusinessOrganizationExecutionMetadata, isBusinessOrganizationExecutionSnapshot,
  type BusinessOrganizationExecutionAction, type BusinessOrganizationExecutionLookup, type BusinessOrganizationExecutionPanelPort,
  type BusinessOrganizationExecutionResult, type BusinessOrganizationExecutionRow, type BusinessOrganizationExecutionSnapshot,
  type BusinessOrganizationExecutionState } from '../../../shared/business/organization-execution';

function contextKey(snapshot: BusinessOrganizationExecutionSnapshot): string { return JSON.stringify(snapshot.context); }
function lookupKey(lookup: BusinessOrganizationExecutionLookup): string { return JSON.stringify([lookup.candidateId, lookup.action, lookup.expectedRevision]); }
interface OriginalDisplayControl {
  readonly lookup: BusinessOrganizationExecutionLookup;
  readonly ownerPrincipalId: string | null;
  readonly closed?: boolean;
}
function current(snapshot: BusinessOrganizationExecutionSnapshot | null, expected: BusinessSession | null | undefined): snapshot is BusinessOrganizationExecutionSnapshot {
  try { return isBusinessOrganizationExecutionSnapshot(snapshot) && (expected === undefined
    || expected !== null && businessOrganizationExecutionContextMatches(snapshot.context, expected)); } catch { return false; }
}
function outcome(result: BusinessOrganizationExecutionResult, copy: (ko: string, en: string) => string): string {
  if (result.effectState === 'unreconciled') return result.stopReceipt?.acknowledgement === 'delivered'
    ? copy("중지 요청이 전달됐습니다. 실제 작업 중단은 확인이 필요합니다.", "Stop request delivered. Verify that work has stopped.") : copy("원래 중지 요청의 처리 상태를 확인해야 합니다.", "Check the original stop request status.");
  if (result.stateWrite === 'unknown') return copy("처리 결과가 아직 확인되지 않았습니다. 같은 요청을 다시 보내지 마세요.", "Result unconfirmed. Do not send the same request again.");
  if (result.stateWrite === 'conflict') return copy("대상이 변경됐습니다. 현재 상태를 다시 확인하세요.", "The target changed. Check current status again.");
  return copy("조직 제어 기록을 확인했습니다. 현재 상태를 다시 확인하세요.", "Organization control record verified. Check current status again.");
}
/** Organization metadata only. Self History/learning content and native controls are
 * never substituted for registered target owners. Missing callbacks supply no rows. */
export function BusinessOrganizationExecutionPanel({ port, expectedSession, displayClosed = false }: {
  port: BusinessOrganizationExecutionPanelPort | null; expectedSession?: BusinessSession | null; displayClosed?: boolean;
}) {
  const { copy } = useBusinessCopy();
  const actionLabels: Record<BusinessOrganizationExecutionAction, string> = { pause: copy("일시중지", "Pause"), revoke: copy("권한 회수", "Revoke permissions"), stop: copy("원래 실행 중지", "Stop original execution") };
  const stateLabels: Record<BusinessOrganizationExecutionState, string> = { candidate: copy("개선 후보", "Improvement candidates"), generating: copy("초안 준비 중", "Preparing draft"), draft: copy("초안", "Draft"),
  evaluating: copy("검증 중", "Evaluating"), 'review-required': copy("검토 필요", "Review required"), applying: copy("적용 중", "Applying"), active: copy("사용 중", "Active"), paused: copy("일시중지", "Pause"), revoked: copy("회수됨", "Revoked"),
  'source-stale': copy("자료 확인 필요", "Check source"), blocked: copy("연결 확인 필요", "Check connection"), unknown: copy("상태 미확인", "Status unknown"), restoring: copy("복원안 준비 중", "Preparing restore") };
  const [snapshot, setSnapshot] = useState<BusinessOrganizationExecutionSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rowLimit, setRowLimit] = useState(20), [receiptLimit, setReceiptLimit] = useState(20);
  const [, redraw] = useState(0);
  const generation = useRef(0), readRequest = useRef(0);
  const active = useRef(new Set<string>());
  // These are display holds, never commands or authority. The adapter/server keep
  // the original claim across refresh or remount. No mutation is automatically retried.
  const controls = useRef(new Map<string, { context: string; original: Readonly<OriginalDisplayControl>; pending: boolean }>());
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
        snapshotRef.current = null; setSnapshot(null); setNotice(copy("현재 조직의 실행 목록을 확인할 수 없습니다. 연결과 권한을 확인하세요.", "Could not verify organization executions. Check connection and permissions."));
      }
    } finally { if (stamp === generation.current && request === readRequest.current) setLoading(false); }
  }
  useEffect(() => {
    generation.current++; readRequest.current++; snapshotRef.current = null; setSnapshot(null); setNotice(null); setRowLimit(20); setReceiptLimit(20);
    // Port replacement changes the producer. Its own durable pending projection must
    // supply original holds; do not mix metadata from the previous owner into it.
    controls.current.clear();
    if (!port) { setLoading(false); setNotice(copy("조직 실행 관리 연결이 필요합니다.", "Connect organization execution management.")); return () => { generation.current++; }; }
    let off: (() => void) | undefined;
    try { off = port.subscribeInvalidation?.(() => clear(copy("계정 또는 조직 권한이 바뀌어 실행 목록을 닫았습니다.", "Account or organization permissions changed and the execution list closed."))); }
    catch { clear(copy("현재 조직의 실행 목록을 확인할 수 없습니다.", "Could not verify current organization executions.")); }
    if (!displayClosed) void reload();
    return () => { generation.current++; readRequest.current++; try { off?.(); } catch { /* Teardown cannot dispatch a control. */ } };
  }, [port, expectedKey]);
  useEffect(() => { if (displayClosed) clear(copy("현재 조직 연결 확인 필요", "Check the current organization connection")); }, [displayClosed]);
  useEffect(() => {
    if (!snapshot) return;
    const expiresAt = Date.parse(snapshot.context.expiresAt); let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (expiresAt > Date.now()) timer = setTimeout(check, Math.min(2147483647, expiresAt - Date.now()));
      else clear(copy("조직 표시가 만료됐습니다. 현재 상태를 다시 확인하세요.", "Organization display expired. Check current status again."));
    };
    timer = setTimeout(check, Math.max(0, Math.min(2147483647, expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [snapshot?.context.expiresAt]);

  function pendingFor(row: BusinessOrganizationExecutionRow, scope: string): OriginalDisplayControl[] {
    const original = new Map<string, OriginalDisplayControl>(row.pendingControls.map(value => [businessOrganizationExecutionPendingKey(value), {
      lookup: { candidateId: row.candidateId, action: value.action, expectedRevision: value.expectedRevision },
      ownerPrincipalId: value.originalOwnerPrincipalId ?? null, closed: value.originalOwnerPrincipalId === null }]));
    for (const value of controls.current.values()) if (value.pending && value.context === scope && value.original.lookup.candidateId === row.candidateId) {
      const key = businessOrganizationExecutionPendingKey(value.original.lookup), remote = original.get(key);
      original.set(key, remote?.closed || remote?.ownerPrincipalId != null && remote.ownerPrincipalId !== value.original.ownerPrincipalId
        ? { lookup: value.original.lookup, ownerPrincipalId: null } : value.original);
    }
    return [...original.values()];
  }
  async function act(row: BusinessOrganizationExecutionRow, action: BusinessOrganizationExecutionAction, original?: OriginalDisplayControl) {
    const view = snapshotRef.current;
    if (!port || !current(view, expectedSession)) return;
    const scope = contextKey(view);
    const ownerPrincipalId = original ? original.ownerPrincipalId : row.ownerPrincipalId;
    if (ownerPrincipalId === null) return;
    const lookup = freezeBusinessOrganizationExecutionMetadata(original?.lookup ?? { candidateId: row.candidateId, action, expectedRevision: row.revision });
    const id = lookupKey(lookup), workKey = `${scope}:${original ? 'receipt' : 'control'}:${id}`;
    if (active.current.has(workKey)) return;
    if (!original && (!row.allowedActions.includes(action) || !row.readyActions.includes(action)
      || pendingFor(row, scope).some(value => value.lookup.action === action) || controls.current.has(`${scope}:${id}`))) return;
    const stamp = generation.current;
    if (!original) controls.current.set(`${scope}:${id}`, { context: scope, original: Object.freeze({ lookup, ownerPrincipalId }), pending: true });
    active.current.add(workKey); redraw(value => value + 1); setNotice(null);
    try {
      const result = await (original ? port.receipt(lookup) : port.control(lookup));
      if (stamp !== generation.current || !current(snapshotRef.current, expectedSession) || contextKey(snapshotRef.current) !== scope) return;
      if (!businessOrganizationExecutionResultMatches(result, lookup, ownerPrincipalId)) throw Error('invalid_original_control_receipt');
      const record = controls.current.get(`${scope}:${id}`);
      if (record) record.pending = result.stateWrite === 'unknown' || result.effectState === 'unreconciled';
      setNotice(outcome(result, copy));
    } catch {
      if (stamp === generation.current && current(snapshotRef.current, expectedSession) && contextKey(snapshotRef.current) === scope)
        setNotice(original ? copy("원래 처리 기록을 확인하지 못했습니다. 같은 제어를 다시 보내지 마세요.", "Original request unconfirmed. Do not send the same control again.") : copy("처리 결과를 확인하지 못했습니다. 원래 처리 기록을 확인하세요.", "Result unconfirmed. Check the original request record."));
    } finally { active.current.delete(workKey); redraw(value => value + 1); }
  }
  const visible = !displayClosed && current(snapshot, expectedSession) ? snapshot : null;
  const scope = visible ? contextKey(visible) : '';
  const pending = visible ? visible.rows.flatMap(row => pendingFor(row, scope).map(original => ({ row, original }))) : [];
  return <section className="business-organization-execution-panel" aria-labelledby="business-organization-execution-heading">
    <div className="business-section-header"><h2 id="business-organization-execution-heading">{copy("조직 실행 관리", "Organization execution")}</h2>
      <button type="button" className="business-icon-button" title={copy("현재 상태 확인", "Check current status")} aria-label={copy("현재 상태 확인", "Check current status")} disabled={displayClosed || !port || loading} onClick={() => void reload()}><IconRefresh size={16} /></button></div>
    {!port && <span role="status" className="business-status">{copy("조직 실행 연결 필요", "Organization execution connection required")}</span>}
    {loading && <p role="status">{copy("현재 조직 상태를 확인하고 있습니다.", "Checking the current organization.")}</p>}
    {visible && <details className="business-details"><summary>{copy("조직 ", "Organization ")}{visible.context.organizationId}</summary>{copy("관리자 계정 ", "Administrator account ")}{visible.context.principalId}</details>}
    {visible && visible.rows.length === 0 && <p>{copy("현재 권한으로 확인할 수 있는 실행이 없습니다.", "No executions are available with current permissions.")}</p>}
    {visible && <div aria-label={copy("허용된 조직 실행", "Permitted organization executions")}>{visible.rows.slice(0, rowLimit).map(row => <article key={row.candidateId}>
      <div className="business-setting-row"><h3>{copy("실행 ", "Execution ")}{row.candidateId}</h3><span className="business-status" data-state={row.state}>{stateLabels[row.state]}</span><small>revision {row.revision}</small></div>
      <details className="business-details"><summary>{copy("실행 범위", "Execution scope")}</summary>{copy("소유자 ", "Owner ")}{row.ownerPrincipalId}{copy(" · 프로젝트 ", " · Project ")}{row.projectId}</details>
      <div className="business-actions">{BUSINESS_ORGANIZATION_EXECUTION_ACTIONS.map(action => {
        const lookup = { candidateId: row.candidateId, action, expectedRevision: row.revision };
        const id = lookupKey(lookup);
        const permitted = row.allowedActions.includes(action), prepared = row.readyActions.includes(action);
        const disabled = !permitted || !prepared || pendingFor(row, scope).some(value => value.lookup.action === action)
          || controls.current.has(`${scope}:${id}`) || active.current.has(`${scope}:control:${id}`);
        return <button key={action} type="button" disabled={disabled} aria-label={`${row.candidateId} ${actionLabels[action]}`}
          title={!permitted ? copy("현재 권한이 필요합니다.", "Current permissions are required.") : !prepared ? copy("원래 실행의 제어 연결이 필요합니다.", "Connect the original execution controls.") : undefined}
          onClick={() => void act(row, action)}>{actionLabels[action]}</button>;
      })}</div></article>)}</div>}
    {visible && visible.rows.length > rowLimit && <button type="button" onClick={() => setRowLimit(value => Math.min(64, value + 20))}>{copy("실행 더 보기", "Show more executions")}</button>}
    {pending.length > 0 && <section aria-labelledby="business-organization-pending-heading"><h3 id="business-organization-pending-heading">{copy("처리 확인 필요", "Requests to verify")}</h3>
      <ul className="business-receipt-list">{pending.slice(0, receiptLimit).map(({ row, original }) => {
        const lookup = original.lookup;
        const id = lookupKey(lookup);
        return <li key={id}><span>{lookup.candidateId} · {actionLabels[lookup.action]}{copy(" · 원래 revision ", " · Original revision ")}{lookup.expectedRevision}</span>
          <button type="button" disabled={original.ownerPrincipalId === null || active.current.has(`${scope}:receipt:${id}`)} aria-label={copy(`${lookup.candidateId} ${actionLabels[lookup.action]} revision ${lookup.expectedRevision} 처리 기록 확인`, `${lookup.candidateId} ${actionLabels[lookup.action]} revision ${lookup.expectedRevision} Check request record`)}
            onClick={() => void act(row, lookup.action, original)}>{copy("처리 기록 확인", "Check request record")}</button></li>;
      })}</ul>{pending.length > receiptLimit && <button type="button" onClick={() => setReceiptLimit(value => Math.min(4096, value + 20))}>{copy("처리 기록 더 보기", "Show more request records")}</button>}</section>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
