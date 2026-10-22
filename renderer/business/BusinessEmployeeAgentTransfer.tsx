'use client';
import { useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { EmployeeAgentTransferInbox } from '@shared/business/employee-agent-transfer';
import { IconChevronRight, IconRefresh, IconUsers } from '../components/Icon';
import { OsButton, OsCard, OsCount, OsDisclosure, OsEmpty, OsField, OsInput, OsNotice, OsPickCard, OsPill, OsSelect, OsTracker, osStyles as os } from './org-share-kit';
import type { OsStepState, OsTone } from './org-share-kit';
type Outcome = [OsTone, string];
/** Selector metadata is refreshed explicitly. Native owns actual file bodies,
 * focused consent, signature and effects; pending cards cannot mint authority.
 * 화면: 진행 트래커(자료 준비 → 내용 확인·전달 → 사본 설치) · 요청 선택 카드 · 선택한 요청의 사실 · 주 동작은 하나. */
export function BusinessEmployeeAgentTransfer({ locale, step = 3 }: { locale: string; step?: number }) {
  const ko = locale === 'ko', t = (kr: string, en: string) => ko ? kr : en;
  const [inbox, setInbox] = useState<EmployeeAgentTransferInbox | null>(null), [source, setSource] = useState(''), [selected, setSelected] = useState(''),
    [agentName,setAgentName]=useState(''),[agentRole,setAgentRole]=useState(''),[manual, setManual] = useState(''), [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ tone: OsTone; text: string } | null>(null);
  const version = useRef(0), attempt = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  function api() { const value = ipc()?.businessNative; if (!value) throw Error('unavailable'); return value; }
  async function refresh() {
    const epoch = version.current, result = await api().transferInbox();
    if (epoch !== version.current) return;
    setInbox(result); setSource(old => result.sources.some(v => v.resourceId === old) ? old : result.sources[0]?.resourceId ?? '');
    setSelected(old => result.transfers.some(v => v.transferId === old) ? old : result.transfers[0]?.transferId ?? '');
    return result;
  }
  async function run(action: () => Promise<Outcome>) {
    const epoch = version.current, own = ++attempt.current; setBusy(true); setMsg(null);
    try { const [tone, text] = await action(); if (version.current === epoch) setMsg({ tone, text }); }
    catch { if (version.current === epoch) setMsg({ tone: 'danger', text: t('현재 회사 권한과 요청을 확인하지 못했습니다. 새로고침해 원래 요청의 상태를 확인해 주세요.', 'Current company permission or request could not be verified. Refresh to check the original request.') }); }
    finally { if (attempt.current === own) setBusy(false); }
  }
  function transferStatus(value: EmployeeAgentTransferInbox['transfers'][number]) {
    if (value.state === 'revoked') return t('취소됨', 'Revoked');
    if (value.state !== 'committed') return t('자료 검토 대기', 'Awaiting review');
    return value.installation?.state === 'confirmed' ? t('설치 확인 완료', 'Installation confirmed') : t('조직 수신 완료', 'Received by company');
  }
  function statusTone(value: EmployeeAgentTransferInbox['transfers'][number]): OsTone {
    if (value.state === 'revoked') return 'danger';
    if (value.state !== 'committed') return 'warn';
    return value.installation?.state === 'confirmed' ? 'ok' : 'info';
  }
  const current = inbox?.transfers.find(v => v.transferId === selected), id = current?.transferId ?? manual.trim(),
    counts = (['definition', 'skill', 'company-memory', 'work-artifact'] as const).map(kind => current?.files.filter(f => f.kind === kind).length ?? 0),
    prepared = !!current || !!inbox?.snapshots.some(v => v.sourceAgentResourceId === source), sent = current?.state === 'committed',
    installed = sent && current?.installation?.state === 'confirmed';
  const steps: { label: string; state: OsStepState }[] = [
    { label: t('자료 준비', 'Prepare files'), state: prepared ? 'done' : 'current' },
    { label: t('내용 확인·전달', 'Review and send'), state: sent ? 'done' : prepared ? 'current' : 'todo' },
    { label: t('사본 설치', 'Install copy'), state: installed ? 'done' : sent ? 'current' : 'todo' },
  ];
  const loadLabel = t('새로고침', 'Refresh');
  const load = () => void run(async () => { await refresh(); return ['ok', t('현재 회사 요청을 확인했습니다.', 'Current company requests loaded.')]; });
  return <OsCard step={step} busy={busy} done={installed} tone={installed ? 'ok' : sent || prepared ? 'info' : 'idle'} status={installed ? t('설치 완료', 'Installed') : sent ? t('전달됨', 'Sent') : prepared ? t('자료 준비됨', 'Files ready') : t('준비 전', 'Not started')}
    title={t('회사 에이전트 전달', 'Company agent handoff')} description={t('선택한 정의·스킬·회사 기억·업무 자료를 새 담당자에게 전달합니다.', 'Pass selected definitions, skills, company memory and work to a new owner.')}
    end={<OsButton variant="quiet" icon={<IconRefresh size={16} />} disabled={busy} onClick={load}>{loadLabel}</OsButton>}>
    <OsTracker ko={ko} steps={steps} />
    <OsDisclosure title={t('새 회사 에이전트 등록', 'Register company agent')}>
      <OsField label={t('에이전트 이름', 'Agent name')}><OsInput value={agentName} maxLength={100} disabled={busy} onChange={e => setAgentName(e.target.value)} /></OsField>
      <OsField label={t('담당 업무', 'Responsibility')}><OsInput value={agentRole} maxLength={100} disabled={busy} onChange={e => setAgentRole(e.target.value)} /></OsField>
      <div className={os.actions}><OsButton variant="secondary" disabled={busy || !agentName.trim()} onClick={() => void run(async () => { const result = await api().registerCompanyAgent({ displayName: agentName.trim(), role: agentRole.trim() }); if (result.state === 'pending') { setAgentName(''); setAgentRole(''); } return result.state === 'pending' ? ['info', t('회사 자료 검토 완료 · 조직 관리자의 등록 승인을 기다립니다.', 'Company files reviewed · Waiting for organization approval.')] : ['warn', t('등록 확인 대기 · 새로고침으로 원래 요청을 확인하세요.', 'Registration pending · Refresh to check the original request.')]; })}>{t('자료 검토', 'Review files')}</OsButton></div>
    </OsDisclosure>
    {inbox === null
      ? <OsEmpty icon={<IconUsers size={20} />} title={t('아직 불러오지 않았습니다', 'Not loaded yet')} body={t('불러오면 현재 연결된 회사의 에이전트와 전달 요청을 확인합니다.', 'Load to see the agents and handoff requests of your connected company.')} action={<OsButton variant="secondary" icon={<IconRefresh size={16} />} disabled={busy} onClick={load}>{t('불러오기', 'Load')}</OsButton>} />
      : inbox.sources.length === 0 && inbox.transfers.length === 0
        ? <OsEmpty icon={<IconUsers size={20} />} title={t('전달할 회사 에이전트가 없습니다', 'No company agents to hand off')} body={t('위의 ‘새 회사 에이전트 등록’으로 에이전트를 등록하면, 관리자 요청과 함께 여기에 나타납니다.', 'Register an agent with “Register company agent” above; it appears here together with manager requests.')} />
      : <>
        {inbox.sources.length > 0
          ? <OsField label={t('내 회사 에이전트', 'My company agent')} action={<OsButton variant={current ? 'secondary' : 'primary'} disabled={busy || !source} onClick={() => void run(async () => { const result = await api().prepareAgentSnapshot({ sourceAgentResourceId: source }); await refresh(); return result.state === 'prepared'
              ? ['ok', t(`${result.fileCount}개 회사 자료를 준비했습니다. 조직 관리자가 받는 직원과 복제·인계를 선택할 수 있습니다.`, `${result.fileCount} company files are ready. Your manager can choose the recipient and transfer type.`)]
              : ['warn', t('자료 접수를 아직 확인하지 못했습니다. 다시 만들기 전에 새로고침해 주세요.', 'Snapshot receipt is unconfirmed. Refresh before preparing it again.')]; })}>{t('자료 선택', 'Choose files')}</OsButton>}>
            <OsSelect value={source} disabled={busy} onChange={e => { version.current++; setSource(e.target.value); setMsg(null); }}>{inbox.sources.map(v => <option key={v.resourceId} value={v.resourceId}>{v.displayName}{v.role ? ` · ${v.role}` : ''}</option>)}</OsSelect>
          </OsField>
          : <OsEmpty icon={<IconUsers size={20} />} title={t('등록된 회사 에이전트가 없습니다', 'No company agents registered')} body={t('위의 ‘새 회사 에이전트 등록’으로 먼저 에이전트를 등록하세요.', 'Register an agent first with “Register company agent” above.')} />}
        {prepared && !current && <OsNotice tone="info">{t('자료 준비 완료 · 관리자 요청을 기다리고 있습니다.', 'Files ready · Waiting for your manager’s request.')}</OsNotice>}
        <div className={os.group}>
          <div className={os.groupHead}><span className={os.groupTitle}>{t('현재 요청', 'Current requests')}{inbox.transfers.length > 0 && <OsCount>{inbox.transfers.length}</OsCount>}</span></div>
          {inbox.transfers.length === 0
            ? <OsEmpty title={t('진행 중인 요청이 없습니다', 'No pending requests')} body={t('관리자가 준비된 자료와 받는 직원을 선택하면 여기에 나타납니다.', 'They appear here after your manager chooses the prepared files and recipient.')} />
            : <div className={os.choices}>{inbox.transfers.map(v => <OsPickCard key={v.transferId} pressed={selected === v.transferId} disabled={busy} onClick={() => { version.current++; setSelected(v.transferId); setMsg(null); }}>
              <span className={os.tags}><OsPill tone="plain">{v.mode === 'clone' ? t('복제', 'Copy') : t('후임자 인계', 'Succession')}</OsPill><OsPill tone="plain">{v.direction === 'incoming' ? t('받는 요청', 'Incoming') : t('보내는 요청', 'Outgoing')}</OsPill><OsPill tone={statusTone(v)}>{transferStatus(v)}</OsPill></span>
              <span className={os.route}><span className={os.kv}><span className={os.kvLabel}>{t('원본', 'Source')}</span><span className={os.kvValue}>{v.sourceName}</span></span><IconChevronRight size={16} /><span className={os.kv}><span className={os.kvLabel}>{t('새 에이전트', 'New agent')}</span><span className={os.kvValue}>{v.targetName}</span></span></span>
            </OsPickCard>)}</div>}
        </div>
        {current?.direction === 'incoming' && <OsNotice tone="info">{t('받은 사본에서 바로 다시 복제·인계하는 기능은 아직 지원하지 않습니다.', 'Direct copying or handoff from a received copy is not available yet.')}</OsNotice>}
        {current && <>
          <div className={os.facts}>{[t('정의', 'Definition'), t('스킬', 'Skills'), t('회사 기억', 'Company memory'), t('업무 자료', 'Work files')].map((label, i) => <div key={label} className={os.fact}><span className={os.factValue}>{counts[i]}</span><span className={os.factLabel}>{label}</span></div>)}</div>
          <OsDisclosure title={t('선택한 파일 확인', 'View selected files')}><ul className={os.files}>{current.files.map(f => <li key={f.path}>{f.path}</li>)}</ul></OsDisclosure>
        </>}
      </>}
    {(current || manual.trim()) && <div className={os.actions}>
      <OsButton variant="secondary" disabled={busy || !id} onClick={() => void run(async () => {
        const receipt = await api().transferReceipt({ transferId: id }), latest = await refresh();
        if (receipt?.state === 'recipient-renewal-required') return ['danger', t('받는 직원의 읽기 권한이 만료되었거나 철회되었습니다. 조직 관리자에게 기존 설치 에이전트의 읽기 권한 갱신을 요청하세요. 자료를 다시 보내거나 설치하지 마세요.', 'Recipient read access expired or was revoked. Ask your company administrator to renew access to the installed agent. Do not send or install the package again.')];
        if (receipt?.state !== 'committed') return ['warn', t('조직의 수신은 아직 확인되지 않았습니다.', 'Company receipt is not yet confirmed.')];
        if (latest?.transfers.find(v => v.transferId === id)?.installation?.state === 'confirmed') return ['ok', t('설치 확인 완료 · 회사가 받는 직원의 사본 설치 확인을 접수했습니다.', 'Installation confirmed · Your company received the recipient’s installation confirmation.')];
        return ['info', t('조직 수신이 확인됐습니다. 기기 설치는 받는 직원이 확인합니다.', 'Company receipt is confirmed. The recipient confirms installation.')];
      })}>{t('상태 확인', 'Check status')}</OsButton>
      {(current?.direction === 'outgoing' || !current) && <OsButton variant="primary" disabled={busy || !id || current?.state === 'committed'} onClick={() => void run(async () => { const result = await api().exportAgent({ transferId: id }); await refresh(); return result.state === 'exported'
        ? ['ok', t('조직 수신 완료. 받는 직원이 사본을 설치할 수 있습니다.', 'Your company received the files. The recipient can install the copy.')] : ['warn', t('수신 확인 대기. 다시 보내지 말고 상태를 확인해 주세요.', 'Receipt pending. Check status before sending again.')]; })}>{t('검토·전달', 'Review and send')}</OsButton>}
      {(current?.direction === 'incoming' || !current) && <OsButton variant="primary" disabled={busy || !id || current?.state !== 'committed' && !!current} onClick={() => void run(async () => { const result = await api().importAgent({ transferId: id }); await refresh(); return result.localState === 'installed'
        ? result.installationState==='confirmed'?['ok', t(`설치 확인 완료 · 회사에서 새 에이전트의 파일 ${result.fileCount}개 설치를 확인했습니다.`, `Installation confirmed · Your company received confirmation for ${result.fileCount} files.`)]:['warn', t('기기 설치 완료 · 회사의 설치 확인 접수는 대기 중입니다. 상태를 다시 확인해 주세요.','Installed on this device · Company installation confirmation is pending. Check the original receipt again.')] : ['warn', t('설치 상태를 확인하지 못했습니다.', 'Installation could not be confirmed.')]; })}>{t('검토·설치', 'Review and install')}</OsButton>}
    </div>}
    <OsDisclosure title={t('요청 코드로 찾기', 'Find by request code')}><OsInput aria-label={t('요청 코드', 'Request code')} mono value={manual} maxLength={160} disabled={busy} onChange={e => { version.current++; setSelected(''); setManual(e.target.value); setMsg(null); }} /></OsDisclosure>
    {msg && <OsNotice tone={msg.tone}>{msg.text}</OsNotice>}
  </OsCard>;
}
