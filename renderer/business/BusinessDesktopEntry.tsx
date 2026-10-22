'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ipc } from '../lib/ipc';
import { BusinessConsole } from './BusinessConsole';
import { useBusinessEligibility } from './use-business-eligibility';
import { isBusinessEligibility, type BusinessEligibility } from '../../shared/business/eligibility';
import { IconBuilding, IconRefresh, IconArrowLeft } from '../components/Icon';
import styles from './BusinessConsole.module.css';
import { OsButton, OsCard, OsNotice, OsRoot, osStyles as os } from './org-share-kit';
import { useBusinessCopy } from './use-business-copy';
import { captureBusinessRendererBridge, currentBusinessRendererBridge, isBusinessRendererSnapshot, openBusinessCloudDashboard,
  type BusinessRendererBridge, type BusinessRendererSnapshot } from './renderer-bridge';

/** Actual shipping route consumer. Explicit test injection supplies owner callbacks;
 * product execution uses only the genuine preload namespace and never fixture data. */
export function BusinessDesktopEntry({ suppliedBridge }: { suppliedBridge?: BusinessRendererBridge | null }) {
  const router = useRouter();
  const { copy } = useBusinessCopy();
  const bridge = useMemo(() => suppliedBridge === undefined ? currentBusinessRendererBridge() : captureBusinessRendererBridge(suppliedBridge), [suppliedBridge]);
  const access = useBusinessEligibility({ suppliedBridge: bridge });
  const organizationNames = useMemo(() => new Map(access.eligibility?.organizations.map(row => [row.organizationId, row.name])), [access.eligibility]);
  const currentAccess = useRef<BusinessEligibility | null>(null);
  currentAccess.current = access.eligibility;
  const [signingIn, setSigningIn] = useState(false);
  const [binding, setBinding] = useState<BusinessRendererSnapshot | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [displayClosed, setDisplayClosed] = useState(false);
  const generation = useRef(0), latest = useRef<BusinessRendererSnapshot | null>(null), closed = useRef(new Set<string>());
  const pendingReload = useRef<{ bridge: BusinessRendererBridge; principalId: string | null; organizationId: string | null;
    promise: Promise<void> } | null>(null);
  const key = (value: BusinessRendererSnapshot) => JSON.stringify([value.context, value.organizationSession]);
  const closeDisplay = useCallback(() => {
    generation.current++; if (latest.current) closed.current.add(key(latest.current));
    pendingReload.current = null;
    latest.current = null; setDisplayClosed(true);
  }, []);
  const reload = useCallback(async () => {
    const eligibility = currentAccess.current;
    if (!isBusinessEligibility(eligibility) || eligibility.eligible !== true) { closeDisplay(); setBinding(null); return; }
    if (!bridge) { closeDisplay(); setBinding(null); setNotice(copy("Desktop 관리 연결 필요", "Connect Desktop management")); return; }
    const pending = pendingReload.current;
    if (pending?.bridge === bridge && pending.principalId === eligibility.principalId
      && pending.organizationId === eligibility.activeOrganizationId) return pending.promise;
    const stamp = ++generation.current;
    setNotice(null);
    const request = (async () => {
      try {
        const value = await bridge.snapshot();
        if (stamp !== generation.current) return;
        const current = currentAccess.current;
        if (!isBusinessEligibility(current) || current.eligible !== true
          || current.principalId !== eligibility.principalId
          || current.activeOrganizationId !== eligibility.activeOrganizationId) throw Error('business_eligibility_changed');
        if (!isBusinessRendererSnapshot(value)) throw Error('invalid_business_context');
        const exact = structuredClone(value);
        if (exact.organizationSession && (exact.organizationSession.principalId !== current.principalId
          || !current.organizations.some(row => row.organizationId === exact.organizationSession!.organizationId)
          || current.activeOrganizationId !== exact.organizationSession.organizationId)) throw Error('business_eligibility_context_mismatch');
        // A fresh account-only read carries no native content or execution port.
        // Navigation may invalidate its display without changing the server session.
        // Original native contexts still require a genuinely different revision.
        const accountOnly = exact.context === null && exact.availability.account === true
          && exact.availability.history === false && exact.availability.learning === false
          && exact.availability.organizationExecution === false;
        if (!isBusinessRendererSnapshot(exact) || !accountOnly && closed.current.has(key(exact))) throw Error('stale_business_context');
        latest.current = exact; setBinding(exact); setDisplayClosed(false);
      } catch { if (stamp === generation.current) { latest.current = null; setDisplayClosed(true); setNotice(copy("현재 조직 연결 확인 필요", "Check the current organization connection")); } }
    })();
    pendingReload.current = { bridge, principalId: eligibility.principalId,
      organizationId: eligibility.activeOrganizationId, promise: request };
    void request.then(() => { if (pendingReload.current?.promise === request) pendingReload.current = null; });
    return request;
  }, [bridge, closeDisplay, copy]);
  useEffect(() => {
    closed.current.clear();
    const invalidate = () => { closeDisplay(); setNotice(copy("현재 계정·조직 확인 필요", "Check your current account and organization")); };
    let off: (() => void) | undefined, authOff: (() => void) | undefined;
    try { off = bridge?.onInvalidated?.(invalidate); authOff = ipc()?.auth.onSessionChanged?.(invalidate); }
    catch { invalidate(); }
    return () => { generation.current++; try { off?.(); } catch { /* Display teardown sends no operation. */ } try { authOff?.(); } catch { /* Same original owner remains authoritative. */ } };
  }, [bridge, closeDisplay, reload, copy]);
  useEffect(() => {
    if (access.eligible) void reload();
    else { closeDisplay(); setBinding(null); }
  }, [access.eligible, access.eligibility, closeDisplay, reload]);
  useEffect(() => {
    if (!binding) return;
    const expiry = Math.min(binding.context?.expiresAt ?? Infinity, binding.organizationSession ? Date.parse(binding.organizationSession.expiresAt) : Infinity);
    if (!Number.isFinite(expiry)) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => { if (expiry > Date.now()) timer = setTimeout(check, Math.min(2147483647, expiry - Date.now())); else { closeDisplay(); setNotice(copy("현재 조직 연결 확인 필요", "Check the current organization connection")); } };
    timer = setTimeout(check, Math.max(0, Math.min(2147483647, expiry - Date.now())));
    return () => clearTimeout(timer);
  }, [binding, closeDisplay, copy]);
  async function companySignIn() {
    if (signingIn) return;
    setSigningIn(true); closeDisplay(); setNotice(null);
    try {
      if (bridge?.account) await bridge.account.signIn();
      else await (bridge?.openDashboard ?? openBusinessCloudDashboard)({ view: 'overview' });
      await access.refresh();
    } catch { setNotice(copy("회사 계정 연결을 확인해 주세요.", "Check your company account connection.")); }
    finally { setSigningIn(false); }
  }
  /** The company window before a company account is connected: same shell as the console, one card for the one thing to do. */
  const entry = (label: string, heading: string, content: ReactNode) => <section className={styles.console} aria-label={label}>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><strong>Agentlas</strong><span>Business</span></div>
      <span className={styles.entryNavigation}><IconBuilding size={18} />{copy("회사 계정", "Company account")}</span>
      <button type="button" className={styles.sidebarBack} onClick={() => router.push('/one')}><IconArrowLeft size={16} />{copy("앱으로 돌아가기", "Back to the app")}</button>
    </aside>
    <div className={styles.layout}>
      <header className={styles.header}><span className={styles.breadcrumb}>Business <span>/</span> {copy("회사 계정", "Company account")}</span></header>
      <div className={`${styles.content} ${styles.entryContent}`}>
        <div className={styles.pageHeading}><span className={styles.eyebrow}>Business</span><h1>{heading}</h1></div>
        <OsRoot>{content}</OsRoot>
      </div>
    </div>
  </section>;
  const checkingCard = (withSignIn: boolean) => <OsCard icon={<IconBuilding size={16} />} busy tone="info" status={copy("확인 중", "Checking")} title={copy("현재 계정과 조직을 확인하고 있습니다", "Checking your account and organization")}
    description={<span role="status">{copy('현재 계정과 조직을 다시 확인하고 있습니다.', 'Checking the current account and organization.')}</span>}>
    <div className={os.actions} data-align="start">
      {withSignIn && <OsButton variant="primary" icon={<IconBuilding size={16} />} disabled>{copy("회사 계정으로 로그인", "Sign in with a company account")}</OsButton>}
      <OsButton variant={withSignIn ? 'secondary' : 'primary'} icon={<IconRefresh size={16} />} disabled={withSignIn} onClick={() => void access.refresh()}
        {...(withSignIn ? { 'aria-label': copy("회사 계정 이용 자격 다시 확인", "Check company account access again") } : {})}>{withSignIn ? copy("이용 자격 다시 확인", "Check access again") : copy("현재 상태 확인", "Check current status")}</OsButton>
    </div>
  </OsCard>;
  if (!access.eligible) return entry(copy("회사 계정 로그인", "Company account sign-in"), access.checking ? copy('현재 조직 확인 중', 'Checking organization') : copy("회사 계정 로그인", "Company account sign-in"),
    access.checking ? checkingCard(true) : <>
      <OsCard icon={<IconBuilding size={16} />} busy={signingIn} tone="idle" status={copy("로그인 필요", "Sign-in required")} title={copy("웹에서 연결한 회사 계정으로 로그인", "Sign in with the company account you connected on the Web")}
        description={copy("조직 계정과 초대를 웹에서 연결하세요. 로그인하면 이 앱에서 조직을 고르고 회사 에이전트와 내부메일을 쓸 수 있습니다.", "Connect your organization account and invitations on the Web. After you sign in, choose an organization and use company agents and internal mail here.")}>
        <div className={os.actions} data-align="start">
          <OsButton variant="primary" icon={<IconBuilding size={16} />} disabled={signingIn} onClick={() => void companySignIn()}>{copy("회사 계정으로 로그인", "Sign in with a company account")}</OsButton>
          <OsButton variant="secondary" icon={<IconRefresh size={16} />} disabled={signingIn} aria-label={copy("회사 계정 이용 자격 다시 확인", "Check company account access again")} onClick={() => void access.refresh()}>{copy("이용 자격 다시 확인", "Check access again")}</OsButton>
        </div>
      </OsCard>
      {notice && <OsNotice tone="warn">{notice}</OsNotice>}
    </>);
  const matchesEligibility = !binding?.organizationSession || !!access.eligibility
    && binding.organizationSession.principalId === access.eligibility.principalId
    && access.eligibility.organizations.some(row => row.organizationId === binding.organizationSession!.organizationId)
    && access.eligibility.activeOrganizationId === binding.organizationSession.organizationId;
  if (!matchesEligibility) return entry(copy('현재 조직 확인 중', 'Checking organization'), copy('현재 조직 확인 중', 'Checking organization'), checkingCard(false));
  return <BusinessConsole showCompanyAgents context={binding?.context ?? null}
    organizationNames={organizationNames}
    displayClosed={displayClosed || !matchesEligibility}
    account={binding?.availability.account ? bridge?.account ?? null : null}
    history={binding?.availability.history ? bridge?.history ?? null : null}
    learning={binding?.availability.learning ? bridge?.learning ?? null : null}
    organizationExecution={binding?.availability.organizationExecution ? bridge?.organizationExecution ?? null : null}
    organizationExecutionSession={binding?.organizationSession ?? null}
    onSelectPersonal={() => router.push('/one')}
    onSessionChanged={() => { closeDisplay(); void access.refresh(); }} onReload={() => void access.refresh()}
    onOpenDashboard={bridge?.openDashboard ?? openBusinessCloudDashboard} notice={notice} onClose={() => router.push('/one')}
    initialTab="account" />;
}
