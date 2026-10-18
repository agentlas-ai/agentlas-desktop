'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ipc } from '../lib/ipc';
import { BusinessConsole } from './BusinessConsole';
import { useBusinessEligibility } from './use-business-eligibility';
import { isBusinessEligibility, type BusinessEligibility } from '../../shared/business/eligibility';
import { IconBuilding, IconRefresh } from '../components/Icon';
import styles from './BusinessConsole.module.css';
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
  const currentAccess = useRef<BusinessEligibility | null>(null);
  currentAccess.current = access.eligibility;
  const [signingIn, setSigningIn] = useState(false);
  const [binding, setBinding] = useState<BusinessRendererSnapshot | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [displayClosed, setDisplayClosed] = useState(false);
  const generation = useRef(0), latest = useRef<BusinessRendererSnapshot | null>(null), closed = useRef(new Set<string>());
  const key = (value: BusinessRendererSnapshot) => JSON.stringify([value.context, value.organizationSession]);
  const closeDisplay = useCallback(() => {
    generation.current++; if (latest.current) closed.current.add(key(latest.current));
    latest.current = null; setDisplayClosed(true);
  }, []);
  const reload = useCallback(async () => {
    const stamp = ++generation.current;
    const eligibility = currentAccess.current;
    if (!isBusinessEligibility(eligibility) || eligibility.eligible !== true) { latest.current = null; setBinding(null); setDisplayClosed(true); return; }
    if (!bridge) { latest.current = null; setBinding(null); setDisplayClosed(true); setNotice(copy("Desktop 관리 연결 필요", "Connect Desktop management")); return; }
    setNotice(null);
    try {
      const value = await bridge.snapshot();
      if (stamp !== generation.current) return;
      if (currentAccess.current !== eligibility || !isBusinessEligibility(eligibility)) throw Error('business_eligibility_changed');
      if (!isBusinessRendererSnapshot(value)) throw Error('invalid_business_context');
      const exact = structuredClone(value);
      if (exact.organizationSession && (exact.organizationSession.principalId !== eligibility.principalId
        || !eligibility.organizations.some(row => row.organizationId === exact.organizationSession!.organizationId)
        || eligibility.activeOrganizationId !== exact.organizationSession.organizationId)) throw Error('business_eligibility_context_mismatch');
      // A fresh account-only read carries no native content or execution port.
      // Navigation may invalidate its display without changing the server session.
      // Original native contexts still require a genuinely different revision.
      const accountOnly = exact.context === null && exact.availability.account === true
        && exact.availability.history === false && exact.availability.learning === false
        && exact.availability.organizationExecution === false;
      if (!isBusinessRendererSnapshot(exact) || !accountOnly && closed.current.has(key(exact))) throw Error('stale_business_context');
      latest.current = exact; setBinding(exact); setDisplayClosed(false);
    } catch { if (stamp === generation.current) { latest.current = null; setDisplayClosed(true); setNotice(copy("현재 조직 연결 확인 필요", "Check the current organization connection")); } }
  }, [bridge, copy]);
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
  if (!access.eligible) return <section className={styles.console} aria-label={copy("회사 계정 로그인", "Company account sign-in")}>
    <header className={styles.header}><h1>{copy("회사 계정 로그인", "Company account sign-in")}</h1></header>
    <div className={styles.content}>
      <button type="button" disabled={signingIn} onClick={() => void companySignIn()}><IconBuilding size={16} />{copy("회사 계정으로 로그인", "Sign in with a company account")}</button>
      <button type="button" className="business-icon-button" disabled={signingIn} aria-label={copy("회사 계정 이용 자격 다시 확인", "Check company account access again")} onClick={() => void access.refresh()}><IconRefresh size={16} /></button>
      <button type="button" onClick={() => router.push('/one')}>{copy("앱으로 돌아가기", "Back to the app")}</button>
      {notice && <p role="status">{notice}</p>}
    </div>
  </section>;
  const matchesEligibility = !binding?.organizationSession || !!access.eligibility
    && binding.organizationSession.principalId === access.eligibility.principalId
    && access.eligibility.organizations.some(row => row.organizationId === binding.organizationSession!.organizationId)
    && access.eligibility.activeOrganizationId === binding.organizationSession.organizationId;
  if (!matchesEligibility) return <section className={styles.console} aria-label={copy('현재 조직 확인 중', 'Checking organization')}>
    <header className={styles.header}><h1>{copy('현재 조직 확인 중', 'Checking organization')}</h1></header>
    <p role="status">{copy('현재 계정과 조직을 다시 확인하고 있습니다.', 'Checking the current account and organization.')}</p>
    <button type="button" onClick={() => void access.refresh()}>{copy('현재 상태 확인', 'Check current status')}</button>
    <button type="button" onClick={() => router.push('/one')}>{copy('앱으로 돌아가기', 'Back to the app')}</button>
  </section>;
  return <BusinessConsole context={binding?.context ?? null}
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
