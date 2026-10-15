'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BusinessSession } from '../../shared/business/context';
import type { BusinessHistoryPanelPort, BusinessHistoryViewContext } from '../../shared/business/history-view';
import type { BusinessOrganizationExecutionPanelPort } from '../../shared/business/organization-execution';
import { BusinessAccountPanel, type BusinessAccountPanelPort } from './BusinessAccountPanel';
import { BusinessLearningPanel, type BusinessLearningPanelPort } from './learning/BusinessLearningPanel';
import { BusinessHistoryPanel } from './history/BusinessHistoryPanel';
import { BusinessOrganizationExecutionPanel } from './admin/BusinessOrganizationExecutionPanel';
import { IconArrowLeft, IconBuilding, IconUsers, IconShield, IconKey, IconLibrary, IconBrain, IconClock, IconBolt, IconLayers, IconRefresh, IconExpand } from '../components/Icon';
import type { BusinessDashboardView } from './renderer-bridge';
import styles from './BusinessConsole.module.css';

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
  /** Account transitions request an owner reload; they never manufacture history authority. */
  onSessionChanged?(session: BusinessSession | null): void;
  onOpenDashboard?(input: { view: BusinessDashboardView }): Promise<void>;
  onReload?(): void;
  notice?: string | null;
  /** Closes display/read only; retain the same original terminal owner and metadata. */
  displayClosed?: boolean;
  initialTab?: 'account' | 'history' | 'learning' | 'organization-execution';
}
/** One's existing owner mounts this surface and supplies actual current callbacks.
 * This component creates no transport, registrar, collector, account or queue. */
export function BusinessConsole({ context, account, history, learning, organizationExecution = null, organizationExecutionSession, onClose, onSessionChanged,
  onOpenDashboard, onReload, notice = null, displayClosed = false, initialTab = 'history' }: BusinessConsoleProps) {
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
  const scope = visibleContext?.scope.kind === 'personal' ? '개인 공간' : visibleContext?.scope.kind === 'organization' ? `조직 ${visibleContext.scope.organizationId}` : '현재 범위 연결 필요';
  async function openDashboard(view: BusinessDashboardView) {
    if (!onOpenDashboard || opening) return;
    setOpening(true); setNavigationNotice(null);
    try { await onOpenDashboard({ view }); setNavigationNotice('웹 관리 열기를 요청했습니다.'); }
    catch { setNavigationNotice('웹 관리 연결 확인 필요'); }
    finally { setOpening(false); }
  }
  const nativeLinks = [
    { id: 'account' as const, label: '계정과 조직', icon: IconBuilding },
    { id: 'history' as const, label: '컴퓨터 기록', icon: IconClock },
    { id: 'learning' as const, label: '학습과 개선', icon: IconBrain },
    { id: 'organization-execution' as const, label: '조직 실행 관리', icon: IconBolt },
  ];
  const webLinks = [
    { id: 'overview' as const, label: '분석', icon: IconLayers, group: '조직' },
    { id: 'members' as const, label: '멤버', icon: IconUsers, group: '조직' },
    { id: 'roles' as const, label: '역할', icon: IconShield, group: '조직' },
    { id: 'grants' as const, label: '접근 권한', icon: IconKey, group: '조직' },
    { id: 'providers' as const, label: '제공자', icon: IconBolt, group: '연결' },
    { id: 'catalog' as const, label: '공유 자산', icon: IconLibrary, group: '연결' },
    { id: 'audit' as const, label: '관리 기록', icon: IconShield, group: '조직' },
  ];
  return <section className={styles.console} aria-labelledby="business-console-heading">
    <a className={styles.skip} href="#business-desktop-content">본문으로 이동</a>
    <header className={styles.header}>
      {onClose ? <button type="button" className={styles.back} onClick={onClose}><IconArrowLeft size={16} /><span>앱으로 돌아가기</span></button> : <small>Agentlas Business</small>}
      <h1 id="business-console-heading">조직 설정</h1><div className={styles.headerActions}>
        {onReload && <button type="button" className={styles.iconButton} title="연결 새로 확인" aria-label="연결 새로 확인" onClick={onReload}><IconRefresh size={17} /></button>}
        <button type="button" disabled={!onOpenDashboard || opening} title="웹 관리 열기" aria-label="웹 관리 열기" onClick={() => void openDashboard('overview')}><IconExpand size={15} /><span>웹 관리</span></button>
      </div></header>
    {(notice || navigationNotice) && <p className={styles.message} role="status">{notice ?? navigationNotice}</p>}
    <div className={styles.layout}><aside className={styles.sidebar}>
      <BusinessAccountPanel port={account} variant="selector" displayClosed={displayClosed} expectedSession={context?.session ?? organizationExecutionSession} onSessionChanged={sessionChanged} />
      <nav className={styles.tabs} aria-label="Business 관리"><div className={styles.navGroup}><small>내 작업 · Desktop</small>
        {nativeLinks.map(item => <button key={item.id} type="button" aria-pressed={tab === item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>
          <item.icon size={17} /><span>{item.label}</span></button>)}</div>
        {['조직', '연결'].map(group => <div className={styles.navGroup} key={group}><small>{group} · 웹 관리</small>
          {webLinks.filter(item => item.group === group).map(item => <button key={item.id} type="button" disabled={!onOpenDashboard || opening} onClick={() => void openDashboard(item.id)}>
            <item.icon size={17} /><span>{item.label}</span><IconExpand size={12} /></button>)}</div>)}
      </nav>
      <span className={styles.scope} title={scope}><IconShield size={14} />{scope}</span>
      {visibleContext && <details className={styles.identity}><summary>현재 범위</summary><dl><dt>계정</dt><dd>{visibleContext.session.principalId}</dd><dt>Desktop</dt><dd>{visibleContext.session.hostId}</dd>
        <dt>세션 revision</dt><dd>{visibleContext.session.sessionRevision}</dd><dt>기록 revision</dt><dd>{visibleContext.revision}</dd></dl></details>}
    </aside><div id="business-desktop-content" className={styles.content} key={contextKey} tabIndex={-1}>
      {tab === 'account' && <BusinessAccountPanel port={account} displayClosed={displayClosed} expectedSession={context?.session ?? organizationExecutionSession} onSessionChanged={sessionChanged} />}
      {tab === 'history' && <BusinessHistoryPanel port={currentHistory} displayClosed={displayClosed} expectedContext={context} />}
      {tab === 'learning' && <BusinessLearningPanel port={currentLearning} displayClosed={displayClosed} expectedContext={context} />}
      {tab === 'organization-execution' && <BusinessOrganizationExecutionPanel port={currentOrganizationExecution} displayClosed={displayClosed} expectedSession={organizationExecutionSession} />}
    </div></div>
  </section>;
}
