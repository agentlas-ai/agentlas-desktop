'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BusinessSession } from '../../shared/business/context';
import type { BusinessHistoryPanelPort, BusinessHistoryViewContext } from '../../shared/business/history-view';
import type { BusinessOrganizationExecutionPanelPort } from '../../shared/business/organization-execution';
import { BusinessAccountPanel, type BusinessAccountPanelPort } from './BusinessAccountPanel';
import { BusinessLearningPanel, type BusinessLearningPanelPort } from './learning/BusinessLearningPanel';
import { BusinessHistoryPanel } from './history/BusinessHistoryPanel';
import { BusinessOrganizationExecutionPanel } from './admin/BusinessOrganizationExecutionPanel';
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
  initialTab?: 'account' | 'history' | 'learning' | 'organization-execution';
}
/** One's existing owner mounts this surface and supplies actual current callbacks.
 * This component creates no transport, registrar, collector, account or queue. */
export function BusinessConsole({ context, account, history, learning, organizationExecution = null, organizationExecutionSession, onClose, onSessionChanged, initialTab = 'history' }: BusinessConsoleProps) {
  const [tab, setTab] = useState(initialTab);
  const contextKey = JSON.stringify(context);
  const fence = useMemo<DisplayFence>(() => ({ closed: false, listeners: new Set() }), [contextKey]);
  const organizationSessionKey = JSON.stringify(organizationExecutionSession ?? null);
  const organizationFence = useMemo<DisplayFence>(() => ({ closed: false, listeners: new Set() }), [organizationSessionKey]);
  const [, invalidateDisplay] = useState(0);
  const currentHistory = useMemo(() => historyDisplayPort(history, fence), [history, fence]);
  const currentLearning = useMemo(() => learningDisplayPort(learning, fence), [learning, fence]);
  const currentOrganizationExecution = useMemo(() => organizationExecutionDisplayPort(organizationExecution, organizationFence), [organizationExecution, organizationFence]);
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
  const visibleContext = !fence.closed && !expired && context && context.expiresAt > Date.now() && Date.parse(context.session.expiresAt) > Date.now() ? context : null;
  const scope = visibleContext?.scope.kind === 'personal' ? '개인 공간' : visibleContext?.scope.kind === 'organization' ? `조직 ${visibleContext.scope.organizationId}` : '현재 범위 연결 필요';
  return <section className={styles.console} aria-labelledby="business-console-heading">
    <header className={styles.header}><div><small>Agentlas Business</small><h1 id="business-console-heading">업무와 조직 관리</h1><p>{scope}</p></div>
      {onClose && <button type="button" onClick={onClose}>닫기</button>}</header>
    {visibleContext && <div className={styles.identity} aria-label="현재 업무 범위"><span>계정 {visibleContext.session.principalId}</span><span>Desktop {visibleContext.session.hostId}</span>
      <span>세션 revision {visibleContext.session.sessionRevision}</span><span>기록 revision {visibleContext.revision}</span></div>}
    <nav className={styles.tabs} aria-label="Business 관리"><button type="button" aria-pressed={tab === 'account'} onClick={() => setTab('account')}>계정과 조직</button>
      <button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}>컴퓨터 기록</button>
      <button type="button" aria-pressed={tab === 'learning'} onClick={() => setTab('learning')}>학습과 개선</button>
      <button type="button" aria-pressed={tab === 'organization-execution'} onClick={() => setTab('organization-execution')}>조직 실행 관리</button></nav>
    <div className={styles.content} key={contextKey}>
      {tab === 'account' && <BusinessAccountPanel port={account} expectedSession={context?.session ?? organizationExecutionSession} onSessionChanged={sessionChanged} />}
      {tab === 'history' && <BusinessHistoryPanel port={currentHistory} expectedContext={context} />}
      {tab === 'learning' && <BusinessLearningPanel port={currentLearning} expectedContext={context} />}
      {tab === 'organization-execution' && <BusinessOrganizationExecutionPanel port={currentOrganizationExecution} expectedSession={organizationExecutionSession} />}
    </div>
  </section>;
}
