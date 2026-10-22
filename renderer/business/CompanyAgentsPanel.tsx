'use client';
import { useEffect, useRef, useState } from 'react';
import type { BusinessSession } from '../../shared/business/context';
import type { CompanyWorkPolicy, CompanyWorkReview } from '../../shared/business/company-work';
import { COMPANY_WORK_BYOK_BACKENDS, isCompanyWorkByokBackend, isCompanyWorkPolicy } from '../../shared/business/company-work';
import type { RuntimeBackend, RuntimeSelection, RuntimeStatus } from '../../shared/types';
import { ipc } from '../lib/ipc';
import { IconRefresh } from '../components/Icon';
import { CompanyNativeConnection } from './CompanyNativeConnection';
import { BusinessEmployeeAgentTransfer } from './BusinessEmployeeAgentTransfer';
import { OsButton, OsCard, OsDangerZone, OsDisclosure, OsField, OsInput, OsNotice, OsPill, OsRoot, OsSelect, OsTracker, osStyles as os } from './org-share-kit';
import type { OsStepState, OsTone } from './org-share-kit';
import { useBusinessCopy } from './use-business-copy';

const providerKey = (runtime: RuntimeStatus) => JSON.stringify([runtime.kind, runtime.backend, runtime.source]);
const companyProvider = (runtime: RuntimeStatus) => !runtime.signInRequired
  && (runtime.kind === 'byok' && isCompanyWorkByokBackend(runtime.backend) || runtime.kind === 'claude-code');
const providerNames: Partial<Record<RuntimeBackend, string>> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google',
  glm: 'GLM', kimi: 'Kimi', deepseek: 'DeepSeek', minimax: 'MiniMax', xai: 'xAI', openrouter: 'OpenRouter', upstage: 'Upstage', custom: 'Custom OpenAI' };
/** Selectors and reviewed metadata only. Main owns each provider consent,
 * original company asset and policy. Activation never starts inference. */
export function CompanyAgentsPanel({ session }: { session: BusinessSession | null }) {
  const { copy, locale } = useBusinessCopy();
  const [agents, setAgents] = useState<Array<{ agentId: string; displayName: string }>>([]), [agentId, setAgentId] = useState('');
  const [providers, setProviders] = useState<RuntimeStatus[]>([]), [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]), [model, setModel] = useState('');
  const [review, setReview] = useState<CompanyWorkReview | null>(null), [policies, setPolicies] = useState<readonly CompanyWorkPolicy[]>([]), [policyId, setPolicyId] = useState('');
  const [active, setActive] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<'' | 'loaded' | 'reviewed' | 'active' | 'stopped' | 'error'>('');
  const [connectionBackend, setConnectionBackend] = useState<RuntimeBackend>('custom'), [draftKey, setDraftKey] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState(''), [savedBaseUrl, setSavedBaseUrl] = useState('');
  const [savedKey, setSavedKey] = useState<boolean | null>(null), [connectionMessage, setConnectionMessage] = useState<'' | 'loaded' | 'saved' | 'error'>('');
  const identity = JSON.stringify(session), generation = useRef(0), acting = useRef(false), actingToken = useRef(0);
  const api = ipc()?.businessCompanyWork;
  useEffect(() => { generation.current++; setAgents([]); setAgentId(''); setProviders([]); setProviderId(''); setModels([]); setModel(''); setReview(null); setPolicies([]); setPolicyId(''); setActive(false); setMessage(''); setDraftKey(''); setDraftBaseUrl(''); setSavedBaseUrl(''); setSavedKey(null); setConnectionMessage(''); return () => { generation.current++; }; }, [identity]);
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
    const available = (await ipc()!.runtime.detect()).filter(companyProvider);
    const status = await api!.status();
    if (stamp !== generation.current) return;
    setAgents(rows.map(row => ({ agentId: row.agentId, displayName: row.displayName })));
    setAgentId(old => rows.some(row => row.agentId === old) ? old : rows[0]?.agentId ?? '');
    setProviders(available); setActive(status.state === 'active' && status.organizationId === session!.organizationId); setMessage('loaded');
  }
  function chooseConnection(value: string) {
    if (busy || active || !isCompanyWorkByokBackend(value)) return;
    generation.current++; setConnectionBackend(value); setDraftKey(''); setDraftBaseUrl(''); setSavedBaseUrl(''); setSavedKey(null); setConnectionMessage('');
  }
  async function readConnection() {
    const stamp = generation.current, local = ipc()!;
    try {
      const [hasKey, baseUrl] = await Promise.all([local.secrets.hasApiKey(connectionBackend),
        connectionBackend === 'custom' ? local.config.getCustomBaseUrl() : Promise.resolve('')]);
      if (stamp !== generation.current) return;
      if (typeof hasKey !== 'boolean' || typeof baseUrl !== 'string') throw Error('company_provider_read_invalid');
      setSavedKey(hasKey); setSavedBaseUrl(baseUrl); setDraftBaseUrl(baseUrl); setConnectionMessage('loaded');
    } catch { if (stamp === generation.current) { setSavedKey(null); setConnectionMessage('error'); } }
  }
  async function saveConnection() {
    if (active || savedKey === null) return;
    const stamp = generation.current, local = ipc()!, backend = connectionBackend, key = draftKey.trim(), url = draftBaseUrl.trim();
    setReview(null); setPolicies([]); setPolicyId(''); setProviderId(''); setModels([]); setModel(''); setConnectionMessage('');
    try {
      // The original Main handlers validate the URL and own the vault. A blank
      // draft never overwrites or deletes an existing key.
      if (backend === 'custom' && url !== savedBaseUrl) await local.config.setCustomBaseUrl(url);
      if (stamp !== generation.current) return;
      if (key) await local.secrets.saveApiKey(backend, key);
      if (stamp !== generation.current) return;
      const [hasKey, baseUrl, detected] = await Promise.all([local.secrets.hasApiKey(backend),
        backend === 'custom' ? local.config.getCustomBaseUrl() : Promise.resolve(''), local.runtime.detect()]);
      if (stamp !== generation.current) return;
      if (typeof hasKey !== 'boolean' || typeof baseUrl !== 'string' || key && !hasKey || backend === 'custom' && baseUrl !== url) throw Error('company_provider_save_unconfirmed');
      setSavedKey(hasKey); setSavedBaseUrl(baseUrl); setDraftBaseUrl(baseUrl); setDraftKey('');
      setProviders(detected.filter(companyProvider)); setProviderId(''); setModels([]); setModel(''); setReview(null); setPolicies([]); setPolicyId('');
      setConnectionMessage('saved');
    } catch { if (stamp === generation.current) { setDraftKey(''); setSavedKey(null); setConnectionMessage('error'); } }
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
  if (!session) return <OsRoot><OsNotice tone="info">{copy('먼저 현재 회사 계정을 연결하세요.', 'Connect your current company account first.')}</OsNotice></OsRoot>;
  const ko = locale === 'ko';
  const workSteps: { label: string; state: OsStepState }[] = [
    { label: copy('기기 검토', 'Device review'), state: review ? 'done' : 'current' },
    { label: copy('회사 승인', 'Company approval'), state: active || policies.length > 0 ? 'done' : review ? 'current' : 'todo' },
    { label: copy('업무 연결', 'Connect work'), state: active ? 'done' : policies.length > 0 ? 'current' : 'todo' },
  ];
  const reviewHint = !agentId ? copy('먼저 ‘에이전트·모델 확인’을 누르고 회사 에이전트를 선택하세요.', 'Press “Load agents and models” first, then choose a company agent.') : !providerId ? copy('제공자를 선택하세요.', 'Choose a provider.') : !model ? copy('모델을 선택하세요.', 'Choose a model.') : copy('기기에서 검토한 뒤 관리자 승인을 받습니다.', 'You review it on this device, then your manager approves it.');
  const messageTone: OsTone = message === 'error' ? 'danger' : message === 'active' ? 'ok' : 'info';
  const connectionTone: OsTone = connectionMessage === 'error' ? 'danger' : connectionMessage === 'saved' ? 'ok' : 'info';
  return <OsRoot>
    <div className={os.page}><h2 className={os.pageTitle}>{copy('회사 에이전트', 'Company agents')}</h2><p className={os.pageDesc}>{copy('기기를 연결하고, 회사 자료로 에이전트를 준비한 뒤 업무를 시작하세요.', 'Connect this device, prepare an agent with company files, then start work.')}</p></div>
    <CompanyNativeConnection session={session} />
    <OsCard step={2} busy={busy} done={active} tone={active ? 'ok' : 'idle'} status={active ? copy('업무 연결됨', 'Work connected') : copy('연결 전', 'Not connected')} title={copy('메일을 받아 일하는 에이전트', 'An agent that works from your mail')} description={copy('회사 에이전트와 모델을 선택해 기기에서 검토하세요. 관리자가 승인한 범위로만 내부메일 업무를 실행합니다.', 'Choose a company agent and model for device review. Work runs within the scope approved by your company manager.')}>
      <OsTracker ko={ko} steps={workSteps} />
      <OsDisclosure title={copy('모델 연결 설정', 'Model connection settings')} onToggle={open => { if (open && !busy && !active && savedKey === null) void run(readConnection); }}>
        <p className={os.hint}>{copy('이 기기에서 사용할 제공자를 연결하세요. 저장한 API 키는 다시 표시하지 않습니다.', 'Connect a provider for this device. Saved API keys are never displayed again.')}</p>
        <fieldset className={os.fields} disabled={busy || active}>
          <OsField label={copy('연결할 제공자', 'Provider to connect')}><OsSelect value={connectionBackend} onChange={event => chooseConnection(event.target.value)}>{COMPANY_WORK_BYOK_BACKENDS.map(backend => <option key={backend} value={backend}>{providerNames[backend] ?? backend}</option>)}</OsSelect></OsField>
          <OsField label={copy('새 API 키', 'New API key')}><OsInput type="password" autoComplete="new-password" value={draftKey} onChange={event => setDraftKey(event.target.value)} placeholder={copy('기존 키를 유지하려면 비워 두세요', 'Leave blank to keep the current key')} /></OsField>
          {connectionBackend === 'custom' && <OsField label="Base URL"><OsInput type="url" mono value={draftBaseUrl} onChange={event => setDraftBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></OsField>}
        </fieldset>
        <div className={os.actions} data-split="true">
          <span>{savedKey !== null && <OsPill tone={savedKey ? 'ok' : 'idle'}>{savedKey ? copy('API 키 저장됨', 'API key saved') : copy('API 키 없음', 'No saved API key')}</OsPill>}</span>
          <span className={os.actions}>
            <OsButton variant="secondary" disabled={busy || active} onClick={() => void run(readConnection)}>{copy('현재 연결 확인', 'Check current connection')}</OsButton>
            <OsButton variant="primary" disabled={busy || active || savedKey === null || !draftKey.trim() && (connectionBackend !== 'custom' || draftBaseUrl.trim() === savedBaseUrl)} onClick={() => void run(saveConnection)}>{copy('연결 저장', 'Save connection')}</OsButton>
          </span>
        </div>
        {connectionMessage && <OsNotice tone={connectionTone} role={connectionMessage === 'error' ? 'alert' : 'status'}>{connectionMessage === 'saved' ? copy('연결을 저장하고 현재 값을 확인했습니다. 에이전트와 모델을 선택해 업무를 검토하세요.', 'Connection saved and checked. Choose an agent and model for work review.') : connectionMessage === 'error' ? copy('저장 상태를 확인하지 못했습니다. 현재 연결을 다시 확인해 주세요.', 'The saved state could not be confirmed. Check the current connection again.') : copy('현재 저장된 연결을 확인했습니다.', 'Current saved connection checked.')}</OsNotice>}
      </OsDisclosure>
      <div className={os.group}>
        <div className={os.groupHead}><span className={os.groupTitle}>{copy('에이전트와 모델', 'Agent and model')}</span><OsButton variant="secondary" icon={<IconRefresh size={16} />} disabled={busy || !api} onClick={() => void run(load)}>{copy('에이전트·모델 확인', 'Load agents and models')}</OsButton></div>
        <fieldset className={os.fields} disabled={busy || active}>
          <OsField label={copy('회사 에이전트', 'Company agent')}><OsSelect value={agentId} onChange={event => { setAgentId(event.target.value); setReview(null); setPolicies([]); setPolicyId(''); }}><option value="">{copy('에이전트 선택', 'Choose agent')}</option>{agents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}</option>)}</OsSelect></OsField>
          <OsField label={copy('제공자', 'Provider')}><OsSelect value={providerId} onChange={event => void chooseProvider(event.target.value)}><option value="">{copy('제공자 선택', 'Choose provider')}</option>{providers.map(provider => <option key={providerKey(provider)} value={providerKey(provider)}>{provider.label || (provider.kind === 'claude-code' ? 'Claude Code' : provider.backend)}</option>)}</OsSelect></OsField>
          <OsField label={copy('모델', 'Model')}><OsSelect value={model} onChange={event => { setModel(event.target.value); setReview(null); setPolicies([]); setPolicyId(''); }}><option value="">{copy('모델 선택', 'Choose model')}</option>{models.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</OsSelect></OsField>
        </fieldset>
      </div>
      <div className={os.footRow}><p className={os.hint}>{reviewHint}</p><OsButton variant="primary" disabled={busy || active || !api || !agentId || !providerId || !model} onClick={() => void run(prepare)}>{copy('이 기기에서 검토', 'Review on this device')}</OsButton></div>
      {review && <div className={os.inset}>
        <div className={os.insetHead}><strong className={os.insetTitle}>{copy('회사 승인', 'Company approval')}</strong><OsButton variant="secondary" icon={<IconRefresh size={16} />} disabled={busy} onClick={() => void run(refreshPolicies)}>{copy('승인 상태 확인', 'Check approval')}</OsButton></div>
        <p className={os.hint}>{copy('검토한 회사 에이전트와 모델을 관리자에게 보냈습니다. 승인 상태를 확인한 뒤 연결하세요.', 'Your reviewed company agent and model were sent to your manager. Check approval, then connect.')}</p>
        {policies.length > 0 && <OsField label={copy('승인된 업무 범위', 'Approved work scope')} action={<OsButton variant="primary" disabled={busy || active || !policyId} onClick={() => void run(activate)}>{copy('이 업무 연결', 'Connect this work')}</OsButton>}><OsSelect value={policyId} onChange={event => setPolicyId(event.target.value)}>{policies.map(policy => <option key={policy.policyId} value={policy.policyId}>{policy.maxRuns}{copy('회', ' runs')} · {policy.host.runtime.model} · {new Date(policy.expiresAt).toLocaleTimeString(locale === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' })}</option>)}</OsSelect></OsField>}
      </div>}
      {message && <OsNotice tone={messageTone} role={message === 'error' ? 'alert' : 'status'}>{message === 'active' ? copy('업무를 연결했습니다. 내부메일에서 맡길 메일을 선택하세요.', 'Work is connected. Choose a message in Internal mail to delegate.') : message === 'reviewed' ? copy('기기 검토를 마쳤습니다. 회사 승인을 기다리고 있습니다.', 'Device review is complete. Waiting for company approval.') : message === 'stopped' ? copy('업무 연결을 중지했습니다.', 'The work connection is stopped.') : message === 'error' ? copy('현재 회사 연결과 승인 결과를 확인해 주세요.', 'Check your current company connection and approval result.') : copy('현재 에이전트와 모델을 확인했습니다.', 'Current agents and models loaded.')}</OsNotice>}
      <OsDangerZone bare ko={ko} title={copy('업무 연결 중지', 'Stop work connection')} description={copy('이 기기의 내부메일 업무 연결을 중지합니다.', 'Stop internal-mail work on this device.')} actionLabel={copy('업무 연결 중지', 'Stop work connection')} confirmTitle={copy('업무 연결을 중지할까요?', 'Stop the work connection?')} consequence={copy('중지하면 이 기기는 내부메일 업무를 더 실행하지 않습니다. 다시 하려면 검토와 회사 승인을 거쳐 연결해야 합니다.', 'This device stops running internal-mail work. To resume, review and connect again with company approval.')} confirmLabel={copy('연결 중지', 'Stop connection')} disabled={!api} onConfirm={() => void stop()} />
    </OsCard>
    <BusinessEmployeeAgentTransfer key={identity} locale={locale} step={3} />
  </OsRoot>;
}
