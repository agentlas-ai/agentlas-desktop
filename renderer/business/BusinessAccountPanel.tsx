'use client';

import { useEffect, useRef, useState } from 'react';
import { businessOnlyKeys, isBusinessId, isBusinessRevision, isBusinessSession, sameBusinessSession, type BusinessSession } from '../../shared/business/context';
import { isBusinessAccountSnapshot, type BusinessAccountPanelPort, type BusinessAccountSnapshot } from '../../shared/business/console-contracts';
export { isBusinessAccountSnapshot, type BusinessAccountPanelPort, type BusinessAccountSnapshot } from '../../shared/business/console-contracts';
import { IconBuilding, IconRefresh, IconLogOut, IconShield } from '../components/Icon';

const viewLabels = { members: '구성원과 권한', providers: '공용 연결', tools: '공용 도구', audit: '감사 기록' } as const;
const providerLabels = { unconfigured: '연결 필요', 'stored-unverified': '저장됨 · 연결 확인 필요', verified: '연결 확인됨', disabled: '사용 중지', expired: '만료됨', unknown: '상태 확인 필요' } as const;
/** Port-bound account surface. No credentials, cached grant or new One window is created here. */
export function BusinessAccountPanel({ port, expectedSession, initialSnapshot = null, onSessionChanged, variant = 'panel', displayClosed = false }: { port: BusinessAccountPanelPort | null; expectedSession?: BusinessSession | null; initialSnapshot?: BusinessAccountSnapshot | null; variant?: 'panel' | 'selector'; displayClosed?: boolean;
  /** Notification only. The owner must reload its actual current scope/resource context. */
  onSessionChanged?(session: BusinessSession | null): void }) {
  const [snapshot, setSnapshot] = useState<BusinessAccountSnapshot | null>(port ? initialSnapshot : null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const logoutTarget = useRef<BusinessSession | null>(null);
  const logoutPending = useRef(false);
  const logoutReceiptGeneration = useRef(0);
  const mounted = useRef(false);
  const sessionTransition = useRef(false);
  const wasDisplayClosed = useRef(displayClosed);
  const expectedKey = expectedSession === undefined ? 'account-only' : JSON.stringify(expectedSession);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; logoutReceiptGeneration.current++; };
  }, []);
  function notifySessionChanged(session: BusinessSession | null) {
    try { onSessionChanged?.(session); } catch { /* A display notification cannot gate a terminal account action. */ }
  }
  function accept(value: BusinessAccountSnapshot) {
    if (!isBusinessAccountSnapshot(value)) throw Error('invalid_account_snapshot');
    if (value.session && Date.parse(value.session.expiresAt) <= Date.now()) throw Error('expired_account_snapshot');
    const exact = structuredClone(value);
    if (!isBusinessAccountSnapshot(exact)) throw Error('invalid_account_snapshot');
    setSnapshot(exact); setConfirmed(true);
    logoutTarget.current = exact.session;
    if (expectedSession === undefined || (exact.session === null ? expectedSession !== null : expectedSession === null || !sameBusinessSession(exact.session, expectedSession))) notifySessionChanged(exact.session);
  }
  useEffect(() => {
    const expected = ++generation.current;
    setSnapshot(port ? initialSnapshot : null); setConfirmed(false); setBusy(false); setNotice(null); logoutTarget.current = null;
    if (!port) { setNotice('조직 계정과 관리 도구 연결이 필요합니다.'); return () => { generation.current++; }; }
    const off = port.subscribeInvalidation?.(() => {
      generation.current++; setSnapshot(null); setConfirmed(false); setBusy(false); setNotice('계정 또는 조직 권한이 바뀌었습니다.');
    });
    if (!displayClosed) void port.read().then(value => { if (generation.current === expected) {
      try { accept(value); } catch { setSnapshot(null); setConfirmed(false); setNotice('현재 계정 상태를 확인할 수 없습니다.'); }
    } }, () => {
      if (generation.current === expected) { setSnapshot(null); setNotice('현재 계정 상태를 확인할 수 없습니다.'); }
    });
    return () => { generation.current++; off?.(); };
  }, [port, expectedKey]);
  useEffect(() => {
    if (displayClosed) {
      if (!sessionTransition.current && !logoutPending.current) generation.current++;
      setSnapshot(null); setConfirmed(false); if (!sessionTransition.current && !logoutPending.current) setBusy(false);
    }
    // The original logout target remains callable independently of display authority.
  }, [displayClosed]);
  useEffect(() => {
    const wasClosed = wasDisplayClosed.current;
    wasDisplayClosed.current = displayClosed;
    if (!wasClosed || displayClosed || !port || sessionTransition.current || logoutPending.current) return;
    // Reopening the same authenticated metadata session needs a fresh read too.
    // Preserve its original terminal logout target while display authority is checked.
    const expected = ++generation.current;
    void port.read().then(value => {
      if (generation.current !== expected) return;
      try { accept(value); setNotice(null); }
      catch { setSnapshot(null); setConfirmed(false); setNotice('현재 계정 상태를 확인할 수 없습니다.'); }
    }, () => {
      if (generation.current === expected) { setSnapshot(null); setConfirmed(false); setNotice('현재 계정 상태를 확인할 수 없습니다.'); }
    });
    return () => { if (generation.current === expected) generation.current++; };
  }, [displayClosed, port, expectedKey]);
  useEffect(() => {
    if (!snapshot?.session) return;
    const expiresAt = Date.parse(snapshot.session.expiresAt); let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (expiresAt > Date.now()) { timer = setTimeout(expire, Math.min(2147483647, expiresAt - Date.now())); return; }
      generation.current++; setSnapshot(null); setConfirmed(false); setBusy(false); setNotice('계정 표시가 만료됐습니다. 현재 상태를 다시 확인해 주세요.');
    };
    timer = setTimeout(expire, Math.max(0, Math.min(2147483647, expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [snapshot?.session]);

  async function act(operation: () => Promise<BusinessAccountSnapshot | void>, completion?: string, changesSession = false) {
    if (!port) return;
    const expected = ++generation.current;
    setBusy(true); setNotice(null);
    if (changesSession) { sessionTransition.current = true; setSnapshot(null); setConfirmed(false); notifySessionChanged(null); }
    try {
      const next = await operation();
      if (generation.current !== expected) return;
      if (next) accept(next);
      if (completion) setNotice(completion);
    } catch {
      if (generation.current === expected) { setSnapshot(null); setConfirmed(false); setNotice('요청을 확인하지 못했습니다. 현재 상태를 다시 확인해 주세요.'); }
    } finally { if (changesSession) sessionTransition.current = false; if (generation.current === expected) setBusy(false); }
  }
  async function logout() {
    const target = logoutTarget.current;
    if (!target || !port || logoutPending.current) return;
    logoutPending.current = true;
    // Original logout receipt metadata survives display/read invalidation. It
    // cannot restore account content or revoke a replacement authenticated session.
    const receiptTicket = ++logoutReceiptGeneration.current;
    const expected = ++generation.current;
    setBusy(true); setNotice(null); setSnapshot(null); setConfirmed(false); logoutTarget.current = null; notifySessionChanged(null);
    try {
      const result = await port.logout({ sessionId: target.sessionId, expectedSessionRevision: target.sessionRevision });
      if (mounted.current && logoutReceiptGeneration.current === receiptTicket) {
        setNotice(result.remote === 'confirmed' ? '로그아웃했습니다.' : '계정 표시를 닫았습니다. 서버 로그아웃 확인이 필요합니다.');
      }
    } catch { if (mounted.current && logoutReceiptGeneration.current === receiptTicket) setNotice('로그아웃 결과를 확인해야 합니다.'); }
    finally { logoutPending.current = false; if (generation.current === expected) setBusy(false); }
  }
  const matches = expectedSession === undefined || snapshot?.session !== null && snapshot?.session !== undefined && expectedSession !== null && sameBusinessSession(snapshot.session, expectedSession);
  const visible = !displayClosed && snapshot && isBusinessAccountSnapshot(snapshot) && matches && snapshot.status === 'current'
    && (snapshot.session === null || Date.parse(snapshot.session.expiresAt) > Date.now()) ? snapshot : null;
  const session = visible?.session ?? null;
  const current = port !== null && confirmed && visible !== null && session !== null;
  const selector = <select aria-label="조직 선택" value={session?.organizationId ?? ''} disabled={busy || !current}
    onChange={event => { const organizationId = event.currentTarget.value;
      if (session && port && current) void act(() => port.selectOrganization({ organizationId, expectedSessionId: session.sessionId, expectedSessionRevision: session.sessionRevision, expectedAuthEpoch: session.authEpoch }), undefined, true);
    }}>
    {!session && <option value="">조직 선택</option>}
    {session && visible?.organizations.map(org => <option key={org.id} value={org.id} disabled={org.membership !== 'active'}>{org.label}{org.membership === 'active' ? '' : org.membership === 'invited' ? ' · 가입 필요' : ' · 사용 중지'}</option>)}
  </select>;
  if (variant === 'selector') return <div className="business-organization-selector"><IconBuilding size={16} />{selector}
    <button type="button" className="business-icon-button" title="조직 상태 확인" aria-label="조직 상태 확인" disabled={displayClosed || busy || !port} onClick={() => { if (port) void act(() => port.read()); }}><IconRefresh size={14} /></button>
  </div>;
  return (
    <section aria-labelledby="business-account-heading" className="business-account-panel">
      <h2 id="business-account-heading">계정과 조직</h2>
      {!port && <span role="status" className="business-status" data-state="unknown">계정 연결 필요</span>}
      {port && !visible && <span role="status" className="business-status" data-state="unknown">현재 계정 확인 필요</span>}
      <label className="business-field">조직{selector}</label>
      <div className="business-actions">
        {!session && <button type="button" disabled={busy || !port} onClick={() => { if (port) void act(() => port.signIn(), undefined, true); }}>회사 계정으로 로그인</button>}
        <button type="button" onClick={() => { if (port) void act(() => port.selectPersonal(), undefined, true); }} disabled={busy || !port}>개인 공간으로 이동</button>
        <button type="button" title="현재 상태 확인" aria-label="현재 상태 확인" onClick={() => { if (port) void act(() => port.read()); }} disabled={displayClosed || busy || !port}><IconRefresh size={16} /></button>
        <button type="button" disabled={!logoutTarget.current || !port || logoutPending.current} onClick={() => void logout()}><IconLogOut size={16} />조직 로그아웃</button>
      </div>
      {session && visible?.organizations.filter(org => org.membership === 'invited').map(org => <button key={org.id} type="button" disabled={busy || !current}
        onClick={() => { if (port && current) void act(() => port.joinOrganization({ organizationId: org.id, expectedSessionId: session.sessionId, expectedSessionRevision: session.sessionRevision }), undefined, true); }}>{org.label} 가입</button>)}
      {session && visible && visible.providers.length > 0 && (
        <ul aria-label="조직 공용 연결">
          {visible.providers.map(provider => <li className="business-setting-row" key={provider.id}><span>{provider.label}</span><span className="business-status" data-state={provider.state}>{providerLabels[provider.state]}</span><small title="credential generation">v{provider.generation}</small></li>)}
        </ul>
      )}
      {session && visible && <nav aria-label="조직 관리">
        {visible.adminViews.map(view => <button key={view} type="button" disabled={busy || !current} onClick={() => { if (port && current) void act(() => port.openAdmin({ organizationId: session.organizationId, view, expectedSessionId: session.sessionId, expectedSessionRevision: session.sessionRevision })); }}><IconShield size={15} />{viewLabels[view]}</button>)}
      </nav>}
      {session && <details className="business-details"><summary>연결 정보</summary><dl><dt>계정 연결</dt><dd>{session.hostId}</dd><dt>세션 버전</dt><dd>{session.sessionRevision}</dd></dl></details>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
