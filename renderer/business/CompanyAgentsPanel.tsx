'use client';
import { useEffect, useRef, useState } from 'react';
import type { BusinessSession } from '../../shared/business/context';
import type { CompanyWorkPolicy, CompanyWorkReview } from '../../shared/business/company-work';
import { isCompanyWorkPolicy } from '../../shared/business/company-work';
import type { RuntimeSelection, RuntimeStatus } from '../../shared/types';
import { ipc } from '../lib/ipc';
import { CompanyNativeConnection } from './CompanyNativeConnection';
import { BusinessEmployeeAgentTransfer } from './BusinessEmployeeAgentTransfer';
import { useBusinessCopy } from './use-business-copy';
import styles from './CompanyAgentsPanel.module.css';

const SUPPORTED = new Set(['anthropic', 'openai', 'google', 'glm', 'kimi', 'deepseek', 'minimax', 'xai', 'openrouter', 'upstage']);
const providerKey = (runtime: RuntimeStatus) => JSON.stringify([runtime.kind, runtime.backend, runtime.source]);
/** Selectors and reviewed metadata only. Main owns each provider consent,
 * original company asset and policy. Activation never starts inference. */
export function CompanyAgentsPanel({ session }: { session: BusinessSession | null }) {
  const { copy, locale } = useBusinessCopy();
  const [agents, setAgents] = useState<Array<{ agentId: string; displayName: string }>>([]), [agentId, setAgentId] = useState('');
  const [providers, setProviders] = useState<RuntimeStatus[]>([]), [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]), [model, setModel] = useState('');
  const [review, setReview] = useState<CompanyWorkReview | null>(null), [policies, setPolicies] = useState<readonly CompanyWorkPolicy[]>([]), [policyId, setPolicyId] = useState('');
  const [active, setActive] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<'' | 'loaded' | 'reviewed' | 'active' | 'stopped' | 'error'>('');
  const identity = JSON.stringify(session), generation = useRef(0), acting = useRef(false), actingToken = useRef(0);
  const api = ipc()?.businessCompanyWork;
  useEffect(() => { generation.current++; setAgents([]); setAgentId(''); setProviders([]); setProviderId(''); setModels([]); setModel(''); setReview(null); setPolicies([]); setPolicyId(''); setActive(false); setMessage(''); return () => { generation.current++; }; }, [identity]);
  async function run(action: () => Promise<void>) {
    if (!session || acting.current || !api) return;
    const stamp = ++generation.current, token = ++actingToken.current; acting.current = true; setBusy(true); setMessage('');
    try { await action(); } catch { if (stamp === generation.current) setMessage('error'); }
    finally { if (token === actingToken.current) { acting.current = false; setBusy(false); } }
  }
  async function load() {
    const stamp = generation.current, connection = await ipc()?.companyNative?.status();
    if (!connection || connection.organizationId !== session?.organizationId || connection.principalId !== session.principalId) throw Error('company_connection_required');
    const inbox = await ipc()!.businessNative.transferInbox();
    const rows = 'workAgents' in inbox && Array.isArray(inbox.workAgents) ? inbox.workAgents as Array<{ agentId: string; displayName: string }> : inbox.sources;
    const available = (await ipc()!.runtime.detect()).filter(row => !row.signInRequired && (row.kind === 'byok' && SUPPORTED.has(row.backend) || row.kind === 'claude-code'));
    const status = await api!.status();
    if (stamp !== generation.current) return;
    setAgents(rows.map(row => ({ agentId: row.agentId, displayName: row.displayName })));
    setAgentId(old => rows.some(row => row.agentId === old) ? old : rows[0]?.agentId ?? '');
    setProviders(available); setActive(status.state === 'active' && status.organizationId === session!.organizationId); setMessage('loaded');
  }
  async function chooseProvider(value: string) {
    if (busy) return;
    generation.current++; setProviderId(value); setModels([]); setModel(''); setReview(null); setPolicies([]); setPolicyId('');
    const provider = providers.find(row => providerKey(row) === value);
    if (!provider) return;
    const stamp = generation.current; setBusy(true);
    try { const rows = await ipc()!.runtime.listModels({ kind: provider.kind, backend: provider.backend, availableModels: provider.availableModels }); if (stamp !== generation.current) return; setModels(rows); }
    catch { if (stamp === generation.current) setMessage('error'); }
    finally { if (stamp === generation.current) setBusy(false); }
  }
  async function prepare() {
    const provider = providers.find(row => providerKey(row) === providerId);
    if (!agentId || !provider || !model) return;
    const stamp = generation.current, runtime: RuntimeSelection = { kind: provider.kind, backend: provider.backend, source: provider.source, model };
    const value = await api!.review({ agentId, runtime });
    if (stamp !== generation.current || value.organizationId !== session!.organizationId || value.asset.agentId !== agentId) throw Error('company_review_changed');
    setReview(value); setPolicies([]); setPolicyId(''); setMessage('reviewed');
  }
  async function refreshPolicies() {
    if (!review) return;
    const stamp = generation.current, value = await api!.choices({ reviewId: review.reviewId });
    const exact = value.policies.filter(policy => isCompanyWorkPolicy(policy) && policy.organizationId === session!.organizationId && policy.employeePrincipalId === session!.principalId && policy.agentId === review.asset.agentId && policy.associationId === review.associationId && policy.state === 'active' && Date.parse(policy.expiresAt) > Date.now());
    if (stamp !== generation.current) return;
    setPolicies(exact); setPolicyId(old => exact.some(policy => policy.policyId === old) ? old : exact[0]?.policyId ?? '');
  }
  async function activate() {
    if (!review || !policyId) return;
    const stamp = generation.current, result = await api!.activate({ reviewId: review.reviewId, policyId });
    if (stamp !== generation.current || result.policyId !== policyId || result.state !== 'active') throw Error('company_activation_unconfirmed');
    setActive(true); setMessage('active');
  }
  async function stop() {
    if (!api) return;
    const stamp = ++generation.current; actingToken.current++; acting.current = false; setBusy(false);
    try { await api.stop(); if (stamp === generation.current) { setActive(false); setReview(null); setPolicies([]); setPolicyId(''); setMessage('stopped'); } }
    catch { if (stamp === generation.current) setMessage('error'); }
  }
  if (!session) return <p role="status">{copy('먼저 현재 회사 계정을 연결하세요.', 'Connect your current company account first.')}</p>;
  return <div className={styles.layout}>
    <div className={styles.intro}><span className={styles.eyebrow}>{copy('나의 회사 업무', 'My company work')}</span><h2>{copy('회사 에이전트', 'Company agents')}</h2><p>{copy('기기를 연결하고, 회사 자료로 에이전트를 준비한 뒤 업무를 시작하세요.', 'Connect this device, prepare an agent with company files, then start work.')}</p></div>
    <div className={styles.connection}><CompanyNativeConnection session={session} /></div>
    <section className={styles.work} aria-label={copy('내부메일 업무 실행 설정', 'Internal mail work setup')}>
      <header><div><span className={styles.eyebrow}>{copy('업무 실행', 'Work execution')}</span><h3>{copy('메일을 받아 일하는 에이전트', 'An agent that works from your mail')}</h3></div><span className={styles.state} data-active={active}>{active ? copy('업무 연결됨', 'Work connected') : copy('연결 전', 'Not connected')}</span></header>
      <p>{copy('회사 에이전트와 모델을 선택해 기기에서 검토하세요. 관리자가 승인한 범위로만 내부메일 업무를 실행합니다.', 'Choose a company agent and model for device review. Work runs within the scope approved by your company manager.')}</p>
      <button type="button" disabled={busy || !api} onClick={() => void run(load)}>{copy('에이전트·모델 확인', 'Load agents and models')}</button>
      <fieldset className={styles.fields} disabled={busy || active}>
        <label>{copy('회사 에이전트', 'Company agent')}<select value={agentId} onChange={event => { setAgentId(event.target.value); setReview(null); setPolicies([]); setPolicyId(''); }}><option value="">{copy('에이전트 선택', 'Choose agent')}</option>{agents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}</option>)}</select></label>
        <label>{copy('제공자', 'Provider')}<select value={providerId} onChange={event => void chooseProvider(event.target.value)}><option value="">{copy('제공자 선택', 'Choose provider')}</option>{providers.map(provider => <option key={providerKey(provider)} value={providerKey(provider)}>{provider.label || (provider.kind === 'claude-code' ? 'Claude Code' : provider.backend)}</option>)}</select></label>
        <label>{copy('모델', 'Model')}<select value={model} onChange={event => { setModel(event.target.value); setReview(null); setPolicies([]); setPolicyId(''); }}><option value="">{copy('모델 선택', 'Choose model')}</option>{models.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
      </fieldset>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || active || !api || !agentId || !providerId || !model} onClick={() => void run(prepare)}>{copy('이 기기에서 검토', 'Review on this device')}</button><button type="button" disabled={!api} onClick={() => void stop()}>{copy('업무 연결 중지', 'Stop work connection')}</button></div>
      {review && <div className={styles.approval}><strong>{copy('회사 승인', 'Company approval')}</strong><p>{copy('검토한 회사 에이전트와 모델을 관리자에게 보냈습니다. 승인 상태를 확인한 뒤 연결하세요.', 'Your reviewed company agent and model were sent to your manager. Check approval, then connect.')}</p><button type="button" disabled={busy} onClick={() => void run(refreshPolicies)}>{copy('승인 상태 확인', 'Check approval')}</button>{policies.length > 0 && <div className={styles.actions}><label>{copy('승인된 업무 범위', 'Approved work scope')}<select value={policyId} onChange={event => setPolicyId(event.target.value)}>{policies.map(policy => <option key={policy.policyId} value={policy.policyId}>{policy.maxRuns}{copy('회', ' runs')} · {policy.host.runtime.model} · {new Date(policy.expiresAt).toLocaleTimeString(locale === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' })}</option>)}</select></label><button type="button" className={styles.primary} disabled={busy || active || !policyId} onClick={() => void run(activate)}>{copy('이 업무 연결', 'Connect this work')}</button></div>}</div>}
      {message && <p role={message === 'error' ? 'alert' : 'status'} className={styles.notice}>{message === 'active' ? copy('업무를 연결했습니다. 내부메일에서 맡길 메일을 선택하세요.', 'Work is connected. Choose a message in Internal mail to delegate.') : message === 'reviewed' ? copy('기기 검토를 마쳤습니다. 회사 승인을 기다리고 있습니다.', 'Device review is complete. Waiting for company approval.') : message === 'stopped' ? copy('업무 연결을 중지했습니다.', 'The work connection is stopped.') : message === 'error' ? copy('현재 회사 연결과 승인 결과를 확인해 주세요.', 'Check your current company connection and approval result.') : copy('현재 에이전트와 모델을 확인했습니다.', 'Current agents and models loaded.')}</p>}
    </section>
    <BusinessEmployeeAgentTransfer key={identity} locale={locale} />
  </div>;
}
