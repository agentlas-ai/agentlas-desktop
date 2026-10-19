'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BusinessSession } from '../../shared/business/context';
import type { BusinessHistoryPanelPort, BusinessHistoryViewContext } from '../../shared/business/history-view';
import type { BusinessOrganizationExecutionPanelPort } from '../../shared/business/organization-execution';
import { BusinessAccountPanel, type BusinessAccountPanelPort } from './BusinessAccountPanel';
import { CompanyAgentsPanel } from './CompanyAgentsPanel';
import { BusinessCompanyMail } from './BusinessCompanyMail';
import { BusinessLearningPanel, type BusinessLearningPanelPort } from './learning/BusinessLearningPanel';
import { BusinessHistoryPanel } from './history/BusinessHistoryPanel';
import { BusinessOrganizationExecutionPanel } from './admin/BusinessOrganizationExecutionPanel';
import { IconMail, IconArrowLeft, IconBuilding, IconUsers, IconShield, IconKey, IconLibrary, IconBrain, IconClock, IconBolt, IconLayers, IconRefresh, IconExpand } from '../components/Icon';
import type { BusinessDashboardView } from './renderer-bridge';
import styles from './BusinessConsole.module.css';
import { useBusinessCopy } from './use-business-copy';

interface DisplayFence { closed: boolean; listeners: Set<() => void> }
async function displayRead<T>(fence: DisplayFence, read: () => Promise<T>): Promise<T> {
  if (fence.closed) throw Error('business_display_context_invalidated');
  const value = await read();
  if (fence.closed) throw Error('business_display_context_invalidated');
  return value;
}
function displaySubscription(fence: DisplayFence, subscribe: ((listener: () => void) => () => void) | undefined, listener: () => void): () => void {
  fence.listeners.add(listener);
  const off = subscribe?.(listener);
  return () => { fence.listeners.delete(listener); off?.(); };
}
/** UI display invalidation only. All controls retain the actual owner's receiver
 * and permissions; an account notification supplies no native authority. */
function historyDisplayPort(owner: BusinessHistoryPanelPort | null, fence: DisplayFence): BusinessHistoryPanelPort | null {
  return owner && {
    read: () => displayRead(fence, () => owner.read()),
    subscribeInvalidation: listener => displaySubscription(fence, owner.subscribeInvalidation?.bind(owner), listener),
    search: owner.search ? input => displayRead(fence, () => owner.search!(input)) : undefined,
    reviewRecommendation: owner.reviewRecommendation ? input => owner.reviewRecommendation!(input) : undefined,
    pauseCollection: owner.pauseCollection ? input => owner.pauseCollection!(input) : undefined,
    deleteHistory: owner.deleteHistory ? input => owner.deleteHistory!(input) : undefined,
    reconcileDelete: owner.reconcileDelete ? input => owner.reconcileDelete!(input) : undefined,
    openPage: owner.openPage ? input => owner.openPage!(input) : undefined,
    openCandidate: owner.openCandidate ? input => owner.openCandidate!(input) : undefined,
  };
}
function learningDisplayPort(owner: BusinessLearningPanelPort | null, fence: DisplayFence): BusinessLearningPanelPort | null {
  return owner && {
    read: () => displayRead(fence, () => owner.read()),
    subscribeInvalidation: listener => displaySubscription(fence, owner.subscribeInvalidation?.bind(owner), listener),
    compare: input => displayRead(fence, () => owner.compare(input)),
    approve: input => owner.approve(input), pause: input => owner.pause(input), revoke: input => owner.revoke(input),
    restoreProposal: input => owner.restoreProposal(input), pauseCollection: input => owner.pauseCollection(input),
    stop: input => owner.stop(input), openAudit: input => owner.openAudit(input),
  };
}
function organizationExecutionDisplayPort(owner: BusinessOrganizationExecutionPanelPort | null, fence: DisplayFence): BusinessOrganizationExecutionPanelPort | null {
  return owner && {
    read: () => displayRead(fence, () => owner.read()),
    subscribeInvalidation: listener => displaySubscription(fence, owner.subscribeInvalidation?.bind(owner), listener),
    // Actual current target owners retain every control/receipt boundary. A UI
    // display fence cannot fabricate or replace the original registered stop.
    control: input => owner.control(input), receipt: input => displayRead(fence, () => owner.receipt(input)),
  };
}

export interface BusinessConsoleProps {
  context: BusinessHistoryViewContext | null;
  account: BusinessAccountPanelPort | null;
  history: BusinessHistoryPanelPort | null;
  learning: BusinessLearningPanelPort | null;
  organizationExecution?: BusinessOrganizationExecutionPanelPort | null;
  /** Genuine current organization identity, independent of self History context.
   * After account changes, the owner supplies a different current session key. */
  organizationExecutionSession?: BusinessSession | null;
  onClose?(): void;
  onSelectPersonal?(): void;
  /** Account transitions request an owner reload; they never manufacture history authority. */
  onSessionChanged?(session: BusinessSession | null): void;
  onOpenDashboard?(input: { view: BusinessDashboardView }): Promise<void>;
  onReload?(): void;
  notice?: string | null;
  /** Closes display/read only; retain the same original terminal owner and metadata. */
  displayClosed?: boolean;
  showCompanyAgents?: boolean;
  initialTab?: 'account' | 'history' | 'learning' | 'organization-execution' | 'company-agents' | 'company-mail';
}
/** One's existing owner mounts this surface and supplies actual current callbacks.
 * This component creates no transport, registrar, collector, account or queue. */
export function BusinessConsole({ context, account, history, learning, organizationExecution = null, organizationExecutionSession, onClose, onSelectPersonal, onSessionChanged,
  onOpenDashboard, onReload, notice = null, displayClosed = false, showCompanyAgents = false, initialTab = 'history' }: BusinessConsoleProps) {
  const { copy } = useBusinessCopy();
  const [tab, setTab] = useState(initialTab);
  const [opening, setOpening] = useState(false), [navigationNotice, setNavigationNotice] = useState<string | null>(null);
  const contextKey = JSON.stringify(context);
  const fence = useMemo<DisplayFence>(() => ({ closed: false, listeners: new Set() }), [contextKey]);
  const organizationSessionKey = JSON.stringify(organizationExecutionSession ?? null);
  const organizationFence = useMemo<DisplayFence>(() => ({ closed: false, listeners: new Set() }), [organizationSessionKey]);
  const [, invalidateDisplay] = useState(0);
  const currentHistory = useMemo(() => historyDisplayPort(history, fence), [history, fence]);
  const currentLearning = useMemo(() => learningDisplayPort(learning, fence), [learning, fence]);
  const currentOrganizationExecution = useMemo(() => organizationExecutionDisplayPort(organizationExecution, organizationFence), [organizationExecution, organizationFence]);
  if (displayClosed) { fence.closed = true; organizationFence.closed = true; }
  function sessionChanged(session: BusinessSession | null) {
    fence.closed = true; organizationFence.closed = true; invalidateDisplay(value => value + 1);
    for (const listener of [...fence.listeners, ...organizationFence.listeners]) { try { listener(); } catch { /* Close every mounted display even if one owner listener fails. */ } }
    onSessionChanged?.(session);
  }
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const expiry = context ? Math.min(context.expiresAt, Date.parse(context.session.expiresAt)) : 0;
    setExpired(!!context && expiry <= Date.now());
    if (!context) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => { if (expiry > Date.now()) timer = setTimeout(check, Math.min(2147483647, expiry - Date.now())); else setExpired(true); };
    timer = setTimeout(check, Math.max(0, Math.min(2147483647, expiry - Date.now())));
    return () => clearTimeout(timer);
  }, [contextKey]);
  const visibleContext = !displayClosed && !fence.closed && !expired && context && context.expiresAt > Date.now() && Date.parse(context.session.expiresAt) > Date.now() ? context : null;
  const scope = visibleContext?.scope.kind === 'personal' ? copy("개인 공간", "Personal space") : visibleContext?.scope.kind === 'organization' ? copy(`조직 ${visibleContext.scope.organizationId}`, `Organization ${visibleContext.scope.organizationId}`) : copy("현재 범위 연결 필요", "Connect the current scope");
  async function openDashboard(view: BusinessDashboardView) {
    if (!onOpenDashboard || opening) return;
    setOpening(true); setNavigationNotice(null);
    try { await onOpenDashboard({ view }); setNavigationNotice(copy("웹 관리 열기를 요청했습니다.", "Requested Web management.")); }
    catch { setNavigationNotice(copy("웹 관리 연결 확인 필요", "Check the Web management connection")); }
    finally { setOpening(false); }
  }
  const nativeLinks = [
    { id: 'account' as const, label: copy("계정과 조직", "Account and organization"), icon: IconBuilding },
    ...(showCompanyAgents ? [{ id: 'company-agents' as const, label: copy("내 회사 에이전트", "My company agents"), icon: IconUsers }, { id: 'company-mail' as const, label: copy("내부메일", "Internal mail"), icon: IconMail }] : []),
    { id: 'history' as const, label: copy("컴퓨터 기록", "Computer history"), icon: IconClock },
    { id: 'learning' as const, label: copy("학습과 개선", "Learning and improvements"), icon: IconBrain },
    { id: 'organization-execution' as const, label: copy("조직 실행 관리", "Organization execution"), icon: IconBolt },
  ];
  const webLinks = [
    { id: 'overview' as const, label: copy("분석", "Analysis"), icon: IconLayers, group: copy("조직", "Organization") },
    { id: 'members' as const, label: copy("멤버", "Members"), icon: IconUsers, group: copy("조직", "Organization") },
    { id: 'roles' as const, label: copy("역할", "Roles"), icon: IconShield, group: copy("조직", "Organization") },
    { id: 'grants' as const, label: copy("접근 권한", "Access permissions"), icon: IconKey, group: copy("조직", "Organization") },
    { id: 'providers' as const, label: copy("제공자", "Providers"), icon: IconBolt, group: copy("연결", "Connections") },
    { id: 'catalog' as const, label: copy("공유 자산", "Shared assets"), icon: IconLibrary, group: copy("연결", "Connections") },
    { id: 'audit' as const, label: copy("관리 기록", "Management activity"), icon: IconShield, group: copy("조직", "Organization") },
  ];
  const nativeAvailable = { 'company-mail': showCompanyAgents, 'company-agents': showCompanyAgents, account: !!account, history: !!history, learning: !!learning, 'organization-execution': !!organizationExecution };
  return <section className={styles.console} aria-labelledby="business-console-heading">
    <a className={styles.skip} href="#business-desktop-content">{copy("본문으로 이동", "Skip to content")}</a>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><strong>Agentlas</strong><span>Business</span></div>
      <BusinessAccountPanel port={account} variant="selector" displayClosed={displayClosed} expectedSession={context?.session ?? organizationExecutionSession} onSessionChanged={sessionChanged} onSelectPersonal={onSelectPersonal} />
      <nav className={styles.tabs} aria-label={copy("Business 관리", "Business management")}><div className={styles.navGroup}><small>{copy("내 작업 · Desktop", "My work · Desktop")}</small>
        {nativeLinks.map(item => <button key={item.id} type="button" aria-pressed={tab === item.id} aria-current={tab === item.id ? 'page' : undefined} disabled={item.id !== 'account' && !nativeAvailable[item.id] && (!onOpenDashboard || opening)}
          onClick={() => { if (item.id === 'account' || item.id === 'company-agents' || item.id === 'company-mail' || nativeAvailable[item.id]) setTab(item.id); else void openDashboard(item.id); }}>
          <item.icon size={17} /><span>{item.label}</span>{item.id !== 'account' && !nativeAvailable[item.id] && <IconExpand size={12} />}</button>)}</div>
        {[copy("조직", "Organization"), copy("연결", "Connections")].map(group => <div className={styles.navGroup} key={group}><small>{group}{copy(" · 웹 관리", " · Web management")}</small>
          {webLinks.filter(item => item.group === group).map(item => <button key={item.id} type="button" disabled={!onOpenDashboard || opening} onClick={() => void openDashboard(item.id)}>
            <item.icon size={17} /><span>{item.label}</span><IconExpand size={12} /></button>)}</div>)}
      </nav>
      <span className={styles.scope} title={scope}><IconShield size={14} />{scope}</span>
      {visibleContext && <details className={styles.identity}><summary>{copy("현재 범위", "Current scope")}</summary><dl><dt>{copy("계정", "Account")}</dt><dd>{visibleContext.session.principalId}</dd><dt>Desktop</dt><dd>{visibleContext.session.hostId}</dd>
        <dt>{copy("세션 revision", "Session revision")}</dt><dd>{visibleContext.session.sessionRevision}</dd><dt>{copy("기록 revision", "History revision")}</dt><dd>{visibleContext.revision}</dd></dl></details>}
    </aside>
    <div className={styles.layout}>
      <header className={styles.header}>
        {onClose && <button type="button" className={styles.back} onClick={onClose} title={copy("앱으로 돌아가기", "Back to the app")}><IconArrowLeft size={16} /><span>{copy("앱으로 돌아가기", "Back to the app")}</span></button>}
        <span className={styles.breadcrumb}>Business <span>/</span> {copy("조직", "Organization")}</span>
        <div className={styles.headerActions}>
          {onReload && <button type="button" className={styles.iconButton} title={copy("연결 새로 확인", "Refresh connection")} aria-label={copy("연결 새로 확인", "Refresh connection")} onClick={onReload}><IconRefresh size={17} /></button>}
          <button type="button" className={styles.primaryAction} disabled={!onOpenDashboard || opening} title={copy("웹 관리 열기", "Open Web management")} aria-label={copy("웹 관리 열기", "Open Web management")} onClick={() => void openDashboard('overview')}><IconExpand size={15} /><span>{copy("웹 관리", "Web management")}</span></button>
        </div>
      </header>
      {(notice || navigationNotice) && <p className={styles.message} role="status">{notice ?? navigationNotice}</p>}
      <div id="business-desktop-content" className={styles.content} key={contextKey} tabIndex={-1}>
        <div className={styles.pageHeading}><span className={styles.eyebrow}>Business</span><h1 id="business-console-heading">{copy("조직 설정", "Organization settings")}</h1></div>
        {tab === 'account' && <BusinessAccountPanel port={account} displayClosed={displayClosed} expectedSession={context?.session ?? organizationExecutionSession} onSessionChanged={sessionChanged} onSelectPersonal={onSelectPersonal} />}
        {tab === 'company-mail' && showCompanyAgents && <BusinessCompanyMail key={organizationSessionKey} session={!displayClosed && !organizationFence.closed ? organizationExecutionSession ?? null : null} />}
        {tab === 'company-agents' && showCompanyAgents && <CompanyAgentsPanel key={organizationSessionKey} session={!displayClosed && !organizationFence.closed ? organizationExecutionSession ?? null : null} />}
        {tab === 'history' && <BusinessHistoryPanel port={currentHistory} displayClosed={displayClosed} expectedContext={context} />}
        {tab === 'learning' && <BusinessLearningPanel port={currentLearning} displayClosed={displayClosed} expectedContext={context} />}
        {tab === 'organization-execution' && <BusinessOrganizationExecutionPanel port={currentOrganizationExecution} displayClosed={displayClosed} expectedSession={organizationExecutionSession} />}
      </div>
    </div>
  </section>;
}
