'use client';

import { useEffect, useRef, useState } from 'react';
import { failureCode } from '../lib/invocation-failure';
import { businessOnlyKeys, isBusinessId, isBusinessRevision, isBusinessSession, sameBusinessSession, type BusinessSession } from '../../shared/business/context';
import { isBusinessAccountSnapshot, type BusinessAccountPanelPort, type BusinessAccountSnapshot } from '../../shared/business/console-contracts';
export { isBusinessAccountSnapshot, type BusinessAccountPanelPort, type BusinessAccountSnapshot } from '../../shared/business/console-contracts';
import { useBusinessCopy } from './use-business-copy';
import { IconBuilding, IconRefresh, IconShield, IconExpand, IconUsers, IconBolt, IconLibrary, IconUser } from '../components/Icon';
import { OsBusy, OsButton, OsCard, OsDangerZone, OsDisclosure, OsEmpty, OsNotice, OsPill, OsRoot, osStyles as os } from './org-share-kit';
import type { OsTone } from './org-share-kit';

/** Port-bound account surface. No credentials, cached grant or new One window is created here. */
export function BusinessAccountPanel({ port, expectedSession, initialSnapshot = null, onSessionChanged, onSelectPersonal, variant = 'panel', displayClosed = false, organizationNames }: { port: BusinessAccountPanelPort | null; expectedSession?: BusinessSession | null; initialSnapshot?: BusinessAccountSnapshot | null; variant?: 'panel' | 'selector'; displayClosed?: boolean;
  /** Validated display names only; IDs and current account authority stay unchanged. */
  organizationNames?: ReadonlyMap<string, string>;
  /** Explicit personal navigation runs only after its original account action succeeds. */
  onSelectPersonal?(): void;
  /** Notification only. The owner must reload its actual current scope/resource context. */
  onSessionChanged?(session: BusinessSession | null): void }) {
  const { copy, locale } = useBusinessCopy();
  const viewLabels = { members: copy("구성원과 권한", "Members and permissions"), providers: copy("공용 연결", "Shared connections"), tools: copy("공용 도구", "Shared tools"), audit: copy("감사 기록", "Audit activity") } as const;
  const providerLabels = { unconfigured: copy("연결 필요", "Connection required"), 'stored-unverified': copy("저장됨 · 연결 확인 필요", "Saved · verification required"), verified: copy("연결 확인됨", "Connection verified"), disabled: copy("사용 중지", "Disabled"), expired: copy("만료됨", "Expired"), unknown: copy("상태 확인 필요", "Check status") } as const;
  /** Every notice this panel can show, so the tone of a notice follows its text instead of being guessed from it. */
  const say = {
    connect: copy("조직 계정과 관리 도구 연결이 필요합니다.", "Connect your organization account and management tools."),
    changed: copy("계정 또는 조직 권한이 바뀌었습니다.", "Your account or organization permissions changed."),
    unverified: copy("현재 계정 상태를 확인할 수 없습니다.", "Could not verify the current account."),
    expired: copy("계정 표시가 만료됐습니다. 현재 상태를 다시 확인해 주세요.", "Account display expired. Check the current status again."),
    requestFailed: copy("요청을 확인하지 못했습니다. 현재 상태를 다시 확인해 주세요.", "Could not verify the request. Check the current status again."),
    signedOut: copy("로그아웃했습니다.", "Signed out."),
    signedOutLocal: copy("계정 표시를 닫았습니다. 서버 로그아웃 확인이 필요합니다.", "Account display closed. Server sign-out needs verification."),
    logoutUnknown: copy("로그아웃 결과를 확인해야 합니다.", "Verify the sign-out result."),
  } as const;
  function requestFailure(error: unknown): string {
    switch (failureCode(error)) {
      case 'business_join_requires_sso':
        return copy("대상 조직의 회사 계정 로그인이 필요합니다. 회사 계정 로그인 화면에서 해당 조직에 먼저 로그인한 뒤 현재 상태를 확인해 주세요.", "Sign in with the target organization's company account first, then check the current status.");
      case 'business_current_session_unavailable':
        return copy("현재 로그인을 확인할 수 없습니다. 회사 계정으로 다시 로그인한 뒤 현재 상태를 확인해 주세요.", "The current sign-in could not be verified. Sign in with your company account again, then check the current status.");
      case 'business_organization_unavailable':
        return copy("대상 조직의 참여 상태를 확인할 수 없습니다. 조직 관리자에게 현재 멤버십과 조직 상태를 확인해 달라고 요청해 주세요.", "Membership in the target organization could not be verified. Ask your organization administrator to check your current membership and the organization status.");
      case 'business_original_mutation_rejected':
        return copy("조직 전환 요청이 거절되었습니다. 현재 상태를 확인하고 조직 관리자에게 대상 조직의 참여 상태를 문의해 주세요.", "The organization switch was rejected. Check the current status and ask your organization administrator about membership in the target organization.");
      case 'business_original_mutation_unknown':
        return copy("요청 결과를 확인하지 못했습니다. 같은 요청을 반복하지 말고 현재 상태를 먼저 확인해 주세요.", "The request outcome is unconfirmed. Check the current status before repeating the request.");
      default: return say.requestFailed;
    }
  }
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
    if (!port) { setNotice(say.connect); return () => { generation.current++; }; }
    const off = port.subscribeInvalidation?.(() => {
      generation.current++; setSnapshot(null); setConfirmed(false); setBusy(false); setNotice(say.changed);
    });
    if (!displayClosed) void port.read().then(value => { if (generation.current === expected) {
      try { accept(value); } catch { setSnapshot(null); setConfirmed(false); setNotice(say.unverified); }
    } }, () => {
      if (generation.current === expected) { setSnapshot(null); setNotice(say.unverified); }
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
      catch { setSnapshot(null); setConfirmed(false); setNotice(say.unverified); }
    }, () => {
      if (generation.current === expected) { setSnapshot(null); setConfirmed(false); setNotice(say.unverified); }
    });
    return () => { if (generation.current === expected) generation.current++; };
  }, [displayClosed, port, expectedKey]);
  useEffect(() => {
    if (!snapshot?.session) return;
    const expiresAt = Date.parse(snapshot.session.expiresAt); let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (expiresAt > Date.now()) { timer = setTimeout(expire, Math.min(2147483647, expiresAt - Date.now())); return; }
      generation.current++; setSnapshot(null); setConfirmed(false); setBusy(false); setNotice(say.expired);
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
      // The operation may invalidate its display while committing a new session.
      // Request a fresh owner read after success, even if that closed this display.
      if (changesSession && next && isBusinessAccountSnapshot(next)) notifySessionChanged(next.session);
      if (generation.current !== expected) return;
      if (next) accept(next);
      if (completion) setNotice(completion);
    } catch (error) {
      if (generation.current === expected) { setSnapshot(null); setConfirmed(false); setNotice(requestFailure(error)); }
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
        setNotice(result.remote === 'confirmed' ? say.signedOut : say.signedOutLocal);
      }
    } catch { if (mounted.current && logoutReceiptGeneration.current === receiptTicket) setNotice(say.logoutUnknown); }
    finally { logoutPending.current = false; if (generation.current === expected) setBusy(false); }
  }
  const matches = expectedSession === undefined || snapshot?.session !== null && snapshot?.session !== undefined && expectedSession !== null && sameBusinessSession(snapshot.session, expectedSession);
  const visible = !displayClosed && snapshot && isBusinessAccountSnapshot(snapshot) && matches && snapshot.status === 'current'
    && (snapshot.session === null || Date.parse(snapshot.session.expiresAt) > Date.now()) ? snapshot : null;
  const session = visible?.session ?? null;
  const current = port !== null && confirmed && visible !== null && session !== null;
  const organizationLabel = (org: BusinessAccountSnapshot['organizations'][number]) => organizationNames?.get(org.id) ?? org.label;
  const noticeTone: OsTone = notice === say.signedOut ? 'ok' : notice === say.connect ? 'info' : notice === say.requestFailed ? 'danger' : 'warn';
  const selector = <select aria-label={copy("조직 선택", "Select organization")} value={session?.organizationId ?? ''} disabled={busy || !current}
    onChange={event => { const organizationId = event.currentTarget.value;
      if (session && port && current) void act(() => port.selectOrganization({ organizationId, expectedSessionId: session.sessionId, expectedSessionRevision: session.sessionRevision, expectedAuthEpoch: session.authEpoch }), undefined, true);
    }}>
    {!session && <option value="">{copy("조직 선택", "Select organization")}</option>}
    {session && visible?.organizations.map(org => <option key={org.id} value={org.id} disabled={org.membership !== 'active'}>{organizationLabel(org)}{org.membership === 'active' ? '' : org.membership === 'invited' ? copy(" · 가입 필요", " · Join required") : copy(" · 사용 중지", " · Disabled")}</option>)}
  </select>;
  if (variant === 'selector') return <OsRoot><div className="business-organization-selector"><IconBuilding size={16} />{selector}
    <button type="button" className="business-icon-button" title={copy("조직 상태 확인", "Check organization status")} aria-label={copy("조직 상태 확인", "Check organization status")} disabled={displayClosed || busy || !port} onClick={() => { if (port) void act(() => port.read()); }}><IconRefresh size={14} /></button>
  </div>
    {notice && (port || notice !== say.connect) && <OsNotice tone={noticeTone}>{notice}</OsNotice>}
  </OsRoot>;
  const selectedOrganization = session && visible?.organizations.find(org => org.id === session.organizationId);
  /** A verified, current account with no session: the person is simply signed out (not "the account could not be verified"). */
  const signedOut = port !== null && !displayClosed && confirmed && snapshot !== null && snapshot.session === null && snapshot.status === 'current';
  const checking = port !== null && !displayClosed && snapshot === null && notice === null;
  const roleText = (roles: readonly string[]) => roles.map(role => role === 'admin' ? copy("관리자", "Administrator") : role === 'member' ? copy("멤버", "Member") : role).join(', ');
  const membershipText = (membership: 'active' | 'invited' | 'suspended') => membership === 'active' ? copy("사용 중", "Active") : membership === 'invited' ? copy("가입 필요", "Join required") : copy("사용 중지", "Disabled");
  const providerTone = (state: keyof typeof providerLabels): OsTone => state === 'verified' ? 'ok' : state === 'stored-unverified' ? 'warn' : state === 'expired' || state === 'disabled' ? 'danger' : 'idle';
  const adminIcons = { members: IconUsers, providers: IconBolt, tools: IconLibrary, audit: IconShield } as const;
  const signIn = () => { if (port) void act(() => port.signIn(), undefined, true); };
  const readAgain = () => { if (port) void act(() => port.read()); };
  return (
    <section aria-labelledby="business-account-heading" className="business-account-panel">
      <OsRoot>
        <OsBusy active={busy} />
        <div className={os.page}>
          <h2 id="business-account-heading" className={os.pageTitle}>{copy("계정과 조직", "Account and organization")}</h2>
          <p className={os.pageDesc}>{copy("현재 조직 연결을 확인하고, 조직을 바꾸거나 로그아웃합니다.", "Check the current organization connection, switch organizations, or sign out.")}</p>
        </div>
        {notice && (port || notice !== say.connect) && <OsNotice tone={noticeTone}>{notice}</OsNotice>}
        {!port
          ? <OsEmpty icon={<IconBuilding size={20} />} title={copy("계정 연결이 필요합니다", "Account connection required")} body={copy("Desktop에 조직 계정과 관리 도구를 연결하면 이곳에서 조직을 확인할 수 있습니다.", "Connect your organization account and management tools to Desktop to see your organizations here.")} />
          : visible && session ? <>
            <OsCard icon={<IconBuilding size={16} />} tone="ok" status={copy("현재 연결", "Connected")} title={selectedOrganization ? organizationLabel(selectedOrganization) : copy("현재 조직", "Current organization")}
              description={selectedOrganization && selectedOrganization.roles.length > 0 ? `${copy("내 역할", "My roles")} · ${roleText(selectedOrganization.roles)}` : copy("현재 연결된 조직입니다.", "The organization you are connected to.")}
              end={<OsButton variant="quiet" iconOnly icon={<IconRefresh size={16} />} title={copy("현재 상태 확인", "Check current status")} aria-label={copy("현재 상태 확인", "Check current status")} disabled={displayClosed || busy || !port} onClick={readAgain} />}>
              <OsDisclosure title={copy("연결 정보", "Connection details")}>
                <div className={os.kvGrid}>
                  <div className={os.kv}><span className={os.kvLabel}>{copy("계정 연결", "Account connection")}</span><span className={`${os.kvValue} ${os.mono}`}>{session.hostId}</span></div>
                  <div className={os.kv}><span className={os.kvLabel}>{copy("세션 버전", "Session version")}</span><span className={os.kvValue}>{session.sessionRevision}</span></div>
                </div>
              </OsDisclosure>
            </OsCard>
            {visible.organizations.length > 0 && <OsCard icon={<IconUsers size={16} />} busy={busy} title={copy("내 조직", "My organizations")} description={copy("전환하거나 가입할 조직을 고르세요.", "Choose an organization to switch to or join.")}>
              <ul className={os.rows} aria-label={copy("연결된 조직", "Connected organizations")}>
                {visible.organizations.map(org => <li key={org.id} className={os.row} data-current={session.organizationId === org.id}>
                  <span className={os.tile} aria-hidden="true"><IconBuilding size={16} /></span>
                  <div className={os.rowCopy}><strong className={os.rowName}>{organizationLabel(org)}</strong><span className={os.rowMeta}>{membershipText(org.membership)}{org.roles.length > 0 ? ` · ${roleText(org.roles)}` : ''}</span></div>
                  <div className={os.rowEnd}>
                    {session.organizationId === org.id ? <OsPill tone="ok">{copy("현재 조직", "Current organization")}</OsPill>
                      : org.membership === 'active' ? <OsButton variant="secondary" disabled={busy || !current} aria-label={`${copy("조직 전환", "Switch organization")}: ${organizationLabel(org)}`}
                        onClick={() => { if (port && current) void act(() => port.selectOrganization({ organizationId: org.id, expectedSessionId: session.sessionId, expectedSessionRevision: session.sessionRevision, expectedAuthEpoch: session.authEpoch }), undefined, true); }}>{copy("이 조직으로 전환", "Switch to this organization")}</OsButton>
                      : org.membership === 'invited' ? <OsButton variant="primary" disabled={busy || !current} aria-label={`${organizationLabel(org)}${copy(" 가입", " Join")}`}
                        onClick={() => { if (port && current) void act(() => port.joinOrganization({ organizationId: org.id, expectedSessionId: session.sessionId, expectedSessionRevision: session.sessionRevision }), undefined, true); }}>{copy("가입", "Join")}</OsButton>
                      : <OsPill tone="plain">{copy("사용 중지", "Disabled")}</OsPill>}
                  </div>
                </li>)}
              </ul>
            </OsCard>}
            {visible.providers.length > 0 && <OsCard icon={<IconBolt size={16} />} title={copy("조직 공용 연결", "Shared organization connections")} description={copy("조직이 공용으로 쓰는 연결의 상태입니다. 설정은 웹 관리에서 합니다.", "Status of the connections your organization shares. Manage them in Web management.")}>
              <ul className={os.rows} aria-label={copy("조직 공용 연결", "Shared organization connections")}>
                {visible.providers.map(provider => <li key={provider.id} className={os.row}>
                  <div className={os.rowCopy}><span className={os.rowName}>{provider.label}</span></div>
                  <div className={os.rowEnd}><OsPill tone={providerTone(provider.state)}>{providerLabels[provider.state]}</OsPill><span className={os.mono} title="credential generation">v{provider.generation}</span></div>
                </li>)}
              </ul>
            </OsCard>}
            {visible.adminViews.length > 0 && <OsCard icon={<IconShield size={16} />} title={copy("조직 관리", "Organization management")} description={copy("웹 관리 화면에서 열립니다.", "Opens in Web management.")}>
              <nav className={os.linkGrid} aria-label={copy("조직 관리", "Organization management")}>
                {visible.adminViews.map(view => { const Icon = adminIcons[view]; return <OsButton key={view} variant="secondary" className={os.linkBtn} icon={<Icon size={15} />} disabled={busy || !current}
                  onClick={() => { if (port && current) void act(() => port.openAdmin({ organizationId: session.organizationId, view, expectedSessionId: session.sessionId, expectedSessionRevision: session.sessionRevision })); }}><span>{viewLabels[view]}</span><IconExpand size={12} /></OsButton>; })}
              </nav>
            </OsCard>}
          </>
          : signedOut
            ? <OsCard icon={<IconBuilding size={16} />} tone="idle" status={copy("로그아웃됨", "Signed out")} title={copy("로그인이 필요합니다", "Sign-in required")}
                description={copy("회사 계정으로 로그인하면 조직을 고르고 회사 에이전트와 내부메일을 쓸 수 있습니다.", "Sign in with a company account to choose an organization and use company agents and internal mail.")}>
                <div className={os.actions} data-align="start"><OsButton variant="primary" icon={<IconBuilding size={16} />} disabled={busy || !port} onClick={signIn}>{copy("회사 계정으로 로그인", "Sign in with a company account")}</OsButton></div>
              </OsCard>
            : <OsCard icon={<IconShield size={16} />} busy={checking || busy} tone={checking ? 'info' : 'warn'} status={checking ? copy("확인 중", "Checking") : copy("확인 필요", "Needs a check")}
                title={checking ? copy("현재 계정 상태를 확인하고 있습니다", "Checking the current account") : copy("현재 계정 상태를 확인해야 합니다", "Check the current account")}
                description={copy("확인이 끝나기 전에는 조직 정보를 보여 주지 않습니다.", "Organization details stay hidden until the account is verified.")}>
                <div className={os.actions} data-align="start">
                  <OsButton variant="primary" icon={<IconRefresh size={16} />} disabled={displayClosed || busy || !port} onClick={readAgain}>{copy("현재 상태 확인", "Check current status")}</OsButton>
                  <OsButton variant="secondary" disabled={busy || !port} onClick={signIn}>{copy("회사 계정으로 로그인", "Sign in with a company account")}</OsButton>
                </div>
              </OsCard>}
        <div className={os.actions} data-align="start">
          <OsButton variant="secondary" icon={<IconUser size={16} />} disabled={busy || !port} onClick={() => { if (port) void act(async () => { await port.selectPersonal(); onSelectPersonal?.(); }, undefined, true); }}>{copy("개인 공간으로 이동", "Go to personal space")}</OsButton>
        </div>
        {port && logoutTarget.current && <OsDangerZone ko={locale === 'ko'} title={copy("조직 로그아웃", "Sign out of organization")} description={copy("이 기기의 현재 조직 세션을 끝냅니다.", "End the current organization session on this device.")}
          actionLabel={copy("조직 로그아웃", "Sign out of organization")} confirmTitle={copy("조직에서 로그아웃할까요?", "Sign out of this organization?")}
          consequence={copy("현재 조직 세션이 끝납니다. 계속 쓰려면 회사 계정으로 다시 로그인해야 합니다.", "The current organization session ends. You will need to sign in with a company account again to keep using it.")}
          confirmLabel={copy("로그아웃", "Sign out")} disabled={!logoutTarget.current || !port || logoutPending.current} onConfirm={() => void logout()} />}
      </OsRoot>
    </section>
  );
}
