'use client';

import { useEffect, useRef, useState } from 'react';
import { businessOnlyKeys, isBusinessId, isBusinessRevision, isBusinessSession, sameBusinessSession, type BusinessSession } from '../../shared/business/context';
import { isBusinessNativeArray } from '../../shared/business/native-registry';
import { looksSecret } from '../../shared/secret-patterns';

export interface BusinessAccountSnapshot {
  session: BusinessSession | null;
  organizations: Array<{ id: string; label: string; membership: 'active' | 'invited' | 'suspended'; roles: string[] }>;
  providers: Array<{ id: string; label: string; state: 'unconfigured' | 'stored-unverified' | 'verified' | 'disabled' | 'expired' | 'unknown'; generation: number }>;
  /** Display readiness only. Main still performs the current action/resource check. */
  adminViews: Array<'members' | 'providers' | 'tools' | 'audit'>;
  status: 'current' | 'offline' | 'unknown';
}
export interface BusinessAccountPanelPort {
  read(): Promise<BusinessAccountSnapshot>;
  subscribeInvalidation?(listener: () => void): () => void;
  signIn(): Promise<BusinessAccountSnapshot>;
  joinOrganization(input: { organizationId: string; expectedSessionRevision: number }): Promise<BusinessAccountSnapshot>;
  selectOrganization(input: { organizationId: string; expectedSessionRevision: number; expectedAuthEpoch: number }): Promise<BusinessAccountSnapshot>;
  logout(input: { sessionId: string; expectedSessionRevision: number }): Promise<{ snapshot: BusinessAccountSnapshot; remote: 'confirmed' | 'unknown' }>;
  openAdmin(input: { organizationId: string; view: BusinessAccountSnapshot['adminViews'][number]; expectedSessionRevision: number }): Promise<void>;
  selectPersonal(): Promise<void>;
}
const viewLabels = { members: '구성원과 권한', providers: '공용 연결', tools: '공용 도구', audit: '감사 기록' } as const;
const providerLabels = { unconfigured: '연결 필요', 'stored-unverified': '저장됨 · 연결 확인 필요', verified: '연결 확인됨', disabled: '사용 중지', expired: '만료됨', unknown: '상태 확인 필요' } as const;
export function isBusinessAccountSnapshot(value: unknown): value is BusinessAccountSnapshot {
  const label = (v: unknown): v is string => typeof v === 'string' && v.length <= 200 && !looksSecret(v) && !/[\u0000-\u001f\u007f]/.test(v);
  try {
    return businessOnlyKeys(value, ['session', 'organizations', 'providers', 'adminViews', 'status'])
      && (value.session === null || isBusinessSession(value.session)) && ['current', 'offline', 'unknown'].includes(value.status as string)
      && isBusinessNativeArray(value.organizations, 256)
      && value.organizations.every(v => businessOnlyKeys(v, ['id', 'label', 'membership', 'roles']) && isBusinessId(v.id) && label(v.label)
        && ['active', 'invited', 'suspended'].includes(v.membership as string) && isBusinessNativeArray(v.roles, 32) && v.roles.every(isBusinessId))
      && new Set(value.organizations.map(v => (v as { id: string }).id)).size === value.organizations.length
      && isBusinessNativeArray(value.providers, 256)
      && value.providers.every(v => businessOnlyKeys(v, ['id', 'label', 'state', 'generation']) && isBusinessId(v.id) && label(v.label)
        && Object.hasOwn(providerLabels, v.state as string) && isBusinessRevision(v.generation))
      && new Set(value.providers.map(v => (v as { id: string }).id)).size === value.providers.length
      && isBusinessNativeArray(value.adminViews, 4) && value.adminViews.every(v => Object.hasOwn(viewLabels, v as string))
      && new Set(value.adminViews).size === value.adminViews.length;
  } catch { return false; }
}

/** Port-bound account surface. No credentials, cached grant or new One window is created here. */
export function BusinessAccountPanel({ port, expectedSession, initialSnapshot = null, onSessionChanged }: { port: BusinessAccountPanelPort | null; expectedSession?: BusinessSession | null; initialSnapshot?: BusinessAccountSnapshot | null;
  /** Notification only. The owner must reload its actual current scope/resource context. */
  onSessionChanged?(session: BusinessSession | null): void }) {
  const [snapshot, setSnapshot] = useState<BusinessAccountSnapshot | null>(port ? initialSnapshot : null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const logoutTarget = useRef<BusinessSession | null>(null);
  const logoutPending = useRef(false);
  const expectedKey = expectedSession === undefined ? 'account-only' : JSON.stringify(expectedSession);
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
    if (expectedSession === undefined || exact.session === null || expectedSession === null || !sameBusinessSession(exact.session, expectedSession)) notifySessionChanged(exact.session);
  }
  useEffect(() => {
    const expected = ++generation.current;
    setSnapshot(port ? initialSnapshot : null); setConfirmed(false); setBusy(false); setNotice(null); logoutTarget.current = null;
    if (!port) { setNotice('조직 계정과 관리 도구 연결이 필요합니다.'); return () => { generation.current++; }; }
    const off = port.subscribeInvalidation?.(() => {
      generation.current++; setSnapshot(null); setConfirmed(false); setBusy(false); setNotice('계정 또는 조직 권한이 바뀌었습니다.');
    });
    void port.read().then(value => { if (generation.current === expected) {
      try { accept(value); } catch { setSnapshot(null); setConfirmed(false); setNotice('현재 계정 상태를 확인할 수 없습니다.'); }
    } }, () => {
      if (generation.current === expected) { setSnapshot(null); setNotice('현재 계정 상태를 확인할 수 없습니다.'); }
    });
    return () => { generation.current++; off?.(); };
  }, [port, expectedKey]);
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
    if (changesSession) { setSnapshot(null); setConfirmed(false); notifySessionChanged(null); }
    try {
      const next = await operation();
      if (generation.current !== expected) return;
      if (next) accept(next);
      if (completion) setNotice(completion);
    } catch {
      if (generation.current === expected) { setSnapshot(null); setConfirmed(false); setNotice('요청을 확인하지 못했습니다. 현재 상태를 다시 확인해 주세요.'); }
    } finally { if (generation.current === expected) setBusy(false); }
  }
  async function logout() {
    const target = logoutTarget.current;
    if (!target || !port || logoutPending.current) return;
    logoutPending.current = true;
    const expected = ++generation.current;
    setBusy(true); setNotice(null); setSnapshot(null); setConfirmed(false); logoutTarget.current = null; notifySessionChanged(null);
    try {
      const result = await port.logout({ sessionId: target.sessionId, expectedSessionRevision: target.sessionRevision });
      if (generation.current === expected) {
        setNotice(result.remote === 'confirmed' ? '로그아웃했습니다.' : '계정 표시를 닫았습니다. 서버 로그아웃 확인이 필요합니다.');
      }
    } catch { if (generation.current === expected) setNotice('로그아웃 결과를 확인해야 합니다.'); }
    finally { logoutPending.current = false; if (generation.current === expected) setBusy(false); }
  }
  const matches = expectedSession === undefined || snapshot?.session !== null && snapshot?.session !== undefined && expectedSession !== null && sameBusinessSession(snapshot.session, expectedSession);
  const visible = snapshot && isBusinessAccountSnapshot(snapshot) && matches && snapshot.status === 'current'
    && (snapshot.session === null || Date.parse(snapshot.session.expiresAt) > Date.now()) ? snapshot : null;
  const session = visible?.session ?? null;
  const current = port !== null && confirmed && visible !== null && session !== null;
  return (
    <section aria-labelledby="business-account-heading" className="business-account-panel">
      <h2 id="business-account-heading">계정과 조직</h2>
      <p>{session ? `현재 조직: ${visible?.organizations.find(org => org.id === session.organizationId)?.label ?? session.organizationId}` : '조직 계정 상태를 확인하세요.'}</p>
      {session && <p>연결된 Desktop: {session.hostId} · 계정 revision {session.sessionRevision}</p>}
      {!port && <p role="status">계정 관리 연결 필요 · 로그인과 관리 기능을 사용할 수 없습니다.</p>}
      {!visible && <p role="status">현재 권한을 확인해야 업무를 시작할 수 있습니다.</p>}
      <label>
        조직 선택
        <select aria-label="조직 선택" value={session?.organizationId ?? ''} disabled={busy || !current}
          onChange={event => {
            const organizationId = event.currentTarget.value;
            if (session && port && current) void act(() => port.selectOrganization({ organizationId, expectedSessionRevision: session.sessionRevision, expectedAuthEpoch: session.authEpoch }), undefined, true);
          }}>
          {!session && <option value="">조직을 선택하세요</option>}
          {session && visible?.organizations.map(org => <option key={org.id} value={org.id} disabled={org.membership !== 'active'}>{org.label}{org.membership === 'active' ? '' : org.membership === 'invited' ? ' · 가입 필요' : ' · 사용 중지'}</option>)}
        </select>
      </label>
      <div>
        {!session && <button type="button" disabled={busy || !port} onClick={() => { if (port) void act(() => port.signIn(), undefined, true); }}>회사 계정으로 로그인</button>}
        <button type="button" onClick={() => { if (port) void act(() => port.selectPersonal(), undefined, true); }} disabled={busy || !port}>개인 공간으로 이동</button>
        <button type="button" onClick={() => { if (port) void act(() => port.read()); }} disabled={busy || !port}>현재 상태 확인</button>
        <button type="button" disabled={!logoutTarget.current || !port || logoutPending.current} onClick={() => void logout()}>조직 로그아웃</button>
      </div>
      {session && visible?.organizations.filter(org => org.membership === 'invited').map(org => <button key={org.id} type="button" disabled={busy || !current}
        onClick={() => { if (port && current) void act(() => port.joinOrganization({ organizationId: org.id, expectedSessionRevision: session.sessionRevision }), undefined, true); }}>{org.label} 가입</button>)}
      {session && visible && visible.providers.length > 0 && (
        <ul aria-label="조직 공용 연결">
          {visible.providers.map(provider => <li key={provider.id}>{provider.label} — {providerLabels[provider.state]} · 버전 {provider.generation}</li>)}
        </ul>
      )}
      {session && visible && <nav aria-label="조직 관리">
        {visible.adminViews.map(view => <button key={view} type="button" disabled={busy || !current} onClick={() => { if (port && current) void act(() => port.openAdmin({ organizationId: session.organizationId, view, expectedSessionRevision: session.sessionRevision })); }}>{viewLabels[view]}</button>)}
      </nav>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
