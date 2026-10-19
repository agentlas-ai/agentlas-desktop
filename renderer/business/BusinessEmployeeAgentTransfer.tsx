'use client';
import { useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { EmployeeAgentTransferInbox } from '@shared/business/employee-agent-transfer';
import styles from './BusinessEmployeeAgentTransfer.module.css';
/** Selector metadata is refreshed explicitly. Native owns actual file bodies,
 * focused consent, signature and effects; pending cards cannot mint authority. */
export function BusinessEmployeeAgentTransfer({ locale }: { locale: string }) {
  const ko = locale === 'ko', t = (kr: string, en: string) => ko ? kr : en;
  const [inbox, setInbox] = useState<EmployeeAgentTransferInbox | null>(null), [source, setSource] = useState(''), [selected, setSelected] = useState(''),
    [agentName,setAgentName]=useState(''),[agentRole,setAgentRole]=useState(''),[manual, setManual] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
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
  async function run(action: () => Promise<string>) {
    const epoch = version.current, own = ++attempt.current; setBusy(true); setNotice('');
    try { const message = await action(); if (version.current === epoch) setNotice(message); }
    catch { if (version.current === epoch) setNotice(t('현재 회사 권한과 요청을 확인하지 못했습니다. 새로고침해 원래 요청의 상태를 확인해 주세요.', 'Current company permission or request could not be verified. Refresh to check the original request.')); }
    finally { if (attempt.current === own) setBusy(false); }
  }
  function transferStatus(value: EmployeeAgentTransferInbox['transfers'][number]) {
    if (value.state === 'revoked') return t('취소됨', 'Revoked');
    if (value.state !== 'committed') return t('자료 검토 대기', 'Awaiting review');
    return value.installation?.state === 'confirmed' ? t('설치 확인 완료', 'Installation confirmed') : t('조직 수신 완료', 'Received by company');
  }
  const current = inbox?.transfers.find(v => v.transferId === selected), id = current?.transferId ?? manual.trim(),
    counts = (['definition', 'skill', 'company-memory', 'work-artifact'] as const).map(kind => current?.files.filter(f => f.kind === kind).length ?? 0),
    prepared = !!current || !!inbox?.snapshots.some(v => v.sourceAgentResourceId === source), sent = current?.state === 'committed',
    installed = sent && current?.installation?.state === 'confirmed';
  return <section className={styles.panel} aria-label={t('직원 에이전트 복제·인계', 'Employee agent copy and handoff')}>
    <div className={styles.header}><div><h3>{t('회사 에이전트 전달', 'Company agent handoff')}</h3><p>{t('선택한 정의·스킬·회사 기억·업무 자료를 새 담당자에게 전달합니다.', 'Pass selected definitions, skills, company memory and work to a new owner.')}</p></div>
      <button className={styles.button} disabled={busy} onClick={() => void run(async () => { await refresh(); return t('현재 회사 요청을 확인했습니다.', 'Current company requests loaded.'); })}>{t('새로고침', 'Refresh')}</button></div>
    <ol className={styles.steps}><li data-done={prepared}><span>01</span><strong>{t('자료 준비', 'Prepare files')}</strong></li><li data-done={sent}><span>02</span><strong>{t('내용 확인·전달', 'Review and send')}</strong></li><li data-done={installed}><span>03</span><strong>{t('사본 설치', 'Install copy')}</strong></li></ol>
    <details className={styles.manifest}><summary>{t('새 회사 에이전트 등록','Register company agent')}</summary><div className={styles.source}>
      <label>{t('에이전트 이름','Agent name')}<input value={agentName} maxLength={100} disabled={busy} onChange={e=>setAgentName(e.target.value)} /></label>
      <label>{t('담당 업무','Responsibility')}<input value={agentRole} maxLength={100} disabled={busy} onChange={e=>setAgentRole(e.target.value)} /></label>
      <button className={styles.button} disabled={busy||!agentName.trim()} onClick={()=>void run(async()=>{const result=await api().registerCompanyAgent({displayName:agentName.trim(),role:agentRole.trim()});if(result.state==='pending'){setAgentName('');setAgentRole('');}return result.state==='pending'?t('회사 자료 검토 완료 · 조직 관리자의 등록 승인을 기다립니다.','Company files reviewed · Waiting for organization approval.'):t('등록 확인 대기 · 새로고침으로 원래 요청을 확인하세요.','Registration pending · Refresh to check the original request.');})}>{t('자료 검토','Review files')}</button>
    </div></details>
    {inbox === null ? <p className={styles.empty}>{t('새로고침하면 현재 연결된 회사의 에이전트와 요청을 확인합니다.', 'Refresh to see agents and requests from your connected company.')}</p> : <div className={styles.body}>
      {inbox.sources.length > 0 && <div className={styles.source}><label>{t('내 회사 에이전트', 'My company agent')}<select value={source} disabled={busy} onChange={e => { version.current++; setSource(e.target.value); setNotice(''); }}>{inbox.sources.map(v => <option key={v.resourceId} value={v.resourceId}>{v.displayName}{v.role ? ` · ${v.role}` : ''}</option>)}</select></label>
        <button className={`${styles.button} ${styles.primary}`} disabled={busy || !source} onClick={() => void run(async () => { const result = await api().prepareAgentSnapshot({ sourceAgentResourceId: source }); await refresh(); return result.state === 'prepared'
          ? t(`${result.fileCount}개 회사 자료를 준비했습니다. 조직 관리자가 받는 직원과 복제·인계를 선택할 수 있습니다.`, `${result.fileCount} company files are ready. Your manager can choose the recipient and transfer type.`)
          : t('자료 접수를 아직 확인하지 못했습니다. 다시 만들기 전에 새로고침해 주세요.', 'Snapshot receipt is unconfirmed. Refresh before preparing it again.'); })}>{t('자료 선택', 'Choose files')}</button></div>}
      {prepared && !current && <p className={styles.notice}>{t('자료 준비 완료 · 관리자 요청을 기다리고 있습니다.', 'Files ready · Waiting for your manager’s request.')}</p>}
      <h4 className={styles.sectionTitle}>{t('현재 요청', 'Current requests')}</h4>
      {inbox.transfers.length === 0 ? <p className={styles.empty}>{t('진행 중인 요청이 없습니다. 관리자가 준비된 자료와 받는 직원을 선택하면 여기에 나타납니다.', 'No pending requests. They appear here after your manager chooses the prepared files and recipient.')}</p>
        : <div className={styles.requests}>{inbox.transfers.map(v => <button key={v.transferId} className={styles.request} disabled={busy} aria-pressed={selected === v.transferId} onClick={() => { version.current++; setSelected(v.transferId); setNotice(''); }}>
          <div className={styles.tags}><span className={styles.tag}>{v.mode === 'clone' ? t('복제', 'Copy') : t('후임자 인계', 'Succession')}</span><span className={styles.tag}>{v.direction === 'incoming' ? t('받는 요청', 'Incoming') : t('보내는 요청', 'Outgoing')}</span><span className={styles.tag}>{transferStatus(v)}</span></div>
          <div className={styles.route}><span><small>{t('원본', 'Source')}</small><strong>{v.sourceName}</strong></span><span aria-hidden="true">→</span><span><small>{t('새 에이전트', 'New agent')}</small><strong>{v.targetName}</strong></span></div></button>)}</div>}
      {current?.direction==='incoming'&&<p className={styles.notice}>{t('받은 사본에서 바로 다시 복제·인계하는 기능은 아직 지원하지 않습니다.','Direct copying or handoff from a received copy is not available yet.')}</p>}
      {current && <><div className={styles.counts}>{[t('정의', 'Definition'), t('스킬', 'Skills'), t('회사 기억', 'Company memory'), t('업무 자료', 'Work files')].map((label, i) => <div key={label}><strong>{counts[i]}</strong><span>{label}</span></div>)}</div>
        <details className={styles.manifest}><summary>{t('선택한 파일 확인', 'View selected files')}</summary><ul>{current.files.map(f => <li key={f.path}>{f.path}</li>)}</ul></details></>}
    </div>}
    {(current || manual.trim()) && <div className={styles.actions}>
      {(current?.direction === 'outgoing' || !current) && <button className={`${styles.button} ${styles.primary}`} disabled={busy || !id || current?.state === 'committed'} onClick={() => void run(async () => { const result = await api().exportAgent({ transferId: id }); await refresh(); return result.state === 'exported'
        ? t('조직 수신 완료. 받는 직원이 사본을 설치할 수 있습니다.', 'Your company received the files. The recipient can install the copy.') : t('수신 확인 대기. 다시 보내지 말고 상태를 확인해 주세요.', 'Receipt pending. Check status before sending again.'); })}>{t('검토·전달', 'Review and send')}</button>}
      {(current?.direction === 'incoming' || !current) && <button className={`${styles.button} ${styles.primary}`} disabled={busy || !id || current?.state !== 'committed' && !!current} onClick={() => void run(async () => { const result = await api().importAgent({ transferId: id }); await refresh(); return result.localState === 'installed'
        ? result.installationState==='confirmed'?t(`설치 확인 완료 · 회사에서 새 에이전트의 파일 ${result.fileCount}개 설치를 확인했습니다.`, `Installation confirmed · Your company received confirmation for ${result.fileCount} files.`):t('기기 설치 완료 · 회사의 설치 확인 접수는 대기 중입니다. 상태를 다시 확인해 주세요.','Installed on this device · Company installation confirmation is pending. Check the original receipt again.') : t('설치 상태를 확인하지 못했습니다.', 'Installation could not be confirmed.'); })}>{t('검토·설치', 'Review and install')}</button>}
      <button className={styles.button} disabled={busy || !id} onClick={() => void run(async () => {
        const receipt = await api().transferReceipt({ transferId: id }), latest = await refresh();
        if (receipt?.state !== 'committed') return t('조직의 수신은 아직 확인되지 않았습니다.', 'Company receipt is not yet confirmed.');
        if (latest?.transfers.find(v => v.transferId === id)?.installation?.state === 'confirmed') return t('설치 확인 완료 · 회사가 받는 직원의 사본 설치 확인을 접수했습니다.', 'Installation confirmed · Your company received the recipient’s installation confirmation.');
        return t('조직 수신이 확인됐습니다. 기기 설치는 받는 직원이 확인합니다.', 'Company receipt is confirmed. The recipient confirms installation.');
      })}>{t('상태 확인', 'Check status')}</button>
    </div>}
    <details className={styles.manual}><summary>{t('요청 코드로 찾기', 'Find by request code')}</summary><input aria-label={t('요청 코드', 'Request code')} value={manual} maxLength={160} autoComplete="off" disabled={busy} onChange={e => { version.current++; setSelected(''); setManual(e.target.value); setNotice(''); }} /></details>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
  </section>;
}
