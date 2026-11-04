"use client";
import { useEffect, useRef, useState } from 'react';
import type { FinanceDataConnectionRequest, FinanceDataConnectionResult } from '@shared/finance';
import { navigate } from '@/lib/navigation';
import { ipc } from '@/lib/ipc';
import styles from './FinanceWorkspace.module.css';
import local from './FinanceDataConnections.module.css';

export function FinanceDataConnections({ ko, onInspect, onConnect }: {
  ko: boolean;
  onInspect?: (request: FinanceDataConnectionRequest) => Promise<FinanceDataConnectionResult>;
  onConnect?: (key: string) => Promise<void>;
}) {
  const l = (a: string, b: string) => ko ? a : b;
  const [result, setResult] = useState<FinanceDataConnectionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [request, setRequest] = useState('');
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState('');
  const epoch = useRef(0);
  const mounted = useRef(true);
  const inspect = async (action: FinanceDataConnectionRequest['action']) => {
    if (!onInspect) return;
    const generation = ++epoch.current;
    setBusy(true); setMessage('');
    try {
      const next = await onInspect({ action });
      if (mounted.current && epoch.current === generation) setResult(next);
    } catch {
      if (mounted.current && epoch.current === generation) setMessage(l('연결 상태를 확인하지 못했습니다. 현재 계정과 앱 연결을 확인하세요.', 'Could not inspect the connection. Check the current account and app connection.'));
    } finally { if (mounted.current && epoch.current === generation) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    void inspect('status');
    return () => { mounted.current = false; epoch.current++; };
    // A parent account transition unmounts this view. Presence discovery performs no network or secret read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onInspect]);
  const keyState = result?.credential === 'present' ? l('키 저장됨', 'Key saved') : result?.credential === 'missing' ? l('키 없음', 'No key') : l('키 상태 확인 전', 'Key status unknown');
  const accessState = result?.access === 'available' ? l('연결됨', 'Connected') : result?.access === 'unavailable' ? l('연결 안 됨', 'Not connected') : result?.access === 'error' ? l('확인 실패', 'Check failed') : l('연결 확인 전', 'Not tested yet');
  const problem = result?.access === 'unavailable'
    ? l('Alpha Vantage에 연결하지 못했습니다. 키와 일일 요청 한도를 확인하세요.', 'Could not connect to Alpha Vantage. Check the key and your daily request limit.')
    : result?.access === 'error' || result?.errorCode
      ? l('연결을 확인하는 중 문제가 생겼습니다. 잠시 뒤 다시 시도하세요.', 'Something went wrong while testing the connection. Try again in a moment.')
      : '';
  return <section className={styles.importPanel} aria-label={l('추가 데이터 연결', 'Additional data connections')}>
    <details className={local.group}><summary>{l('데이터 도구 만들기', 'Create a data tool')}</summary>
      <form onSubmit={event=>{
        event.preventDefault();const tools=ipc()?.toolchains;if(!request.trim()||creating||!tools)return;
        setCreating(true);setCreationError('');
        void tools.generateAsset({request:request.trim(),requestId:crypto.randomUUID(),purpose:'finance-source'}).then(generated=>{
          if(!mounted.current)return;
          navigate(`/library/toolchains?asset=${encodeURIComponent(generated.asset.id)}&version=${generated.version}`);
        }).catch(()=>{if(mounted.current)setCreationError(l('도구 초안을 만들지 못했습니다. 요청과 앱 연결을 확인한 뒤 다시 시도하세요.', 'Could not create the tool draft. Check your request and app connection, then retry.'));}).finally(()=>{if(mounted.current)setCreating(false);});
      }}>
        <label className={styles.label}>{l('필요한 자료와 출처', 'Data and source you need')}<textarea className={`${styles.input} ${styles.textarea}`} rows={3} maxLength={8000} value={request} disabled={creating} placeholder={l('예: 관심 종목의 가격·이력을 무료 공개 소스에서 가져오는 로컬 도구', 'Example: a local tool for watchlist prices and history from a free public source')} onChange={event=>setRequest(event.target.value)}/></label>
        <p className={styles.muted}>{l('만든 뒤 도구 화면에서 검토하고 게시하세요.', 'After creating it, review and publish it in Tools.')}</p>
        <button type="submit" className={styles.button} disabled={creating||!request.trim()||!ipc()?.toolchains} title={!request.trim()?l('필요한 자료를 먼저 적어 주세요','Describe the data you need first'):!ipc()?.toolchains?l('이 앱에서는 사용할 수 없습니다','Unavailable in this app'):undefined}>{creating?l('도구 초안을 만드는 중…', 'Creating tool draft…'):l('AI로 도구 만들기', 'Create tool with AI')}</button>
        {creationError&&<p className={styles.muted} role="alert">{creationError}</p>}
      </form>
    </details>
    {(onInspect || onConnect) && <details className={local.group}><summary>{l('추가 연결', 'Additional connections')}</summary>
    <details className={local.group}><summary>Alpha Vantage</summary>
    <p className={styles.muted}>{l('Alpha Vantage 키를 등록하면 일별 시세를 추가로 받을 수 있습니다.', 'Add an Alpha Vantage key to get extra daily quotes.')}</p>
    <div className={styles.evidenceChips} role="status" aria-live="polite"><span className={styles.badge}>{keyState}</span><span className={styles.badge}>{accessState}</span></div>
    {result?.checkedAt && <p className={styles.muted}>{l('마지막 확인', 'Last checked')}: {result.checkedAt}</p>}
    {problem && <div role="alert"><p className={styles.muted}>{problem}</p>{result?.errorCode && <details><summary>{l('자세히', 'Details')}</summary><p className={local.raw}>{result.errorCode}</p></details>}</div>}
    {onInspect && <div className={styles.actions}>
      <button type="button" className={styles.button} disabled={busy || saving || result?.credential === 'missing'} title={result?.credential === 'missing' ? l('먼저 아래에서 키를 저장하세요', 'Save a key below first') : l('요청 1회를 사용해 연결을 확인합니다', 'Uses 1 request to check the connection')} onClick={() => { void inspect('test'); }}>{busy ? l('확인 중…', 'Checking…') : l('연결 확인 (요청 1회 사용)', 'Test connection (uses 1 request)')}</button>
      {!result && <button type="button" className={styles.button} disabled={busy || saving} onClick={() => { void inspect('status'); }}>{l('상태 다시 확인', 'Check status again')}</button>}
    </div>}
    {result?.credential === 'missing' && <p className={styles.muted}>{l('키를 저장하면 연결을 확인할 수 있습니다.', 'Save a key to enable the connection test.')}</p>}
    {result?.probe && <details><summary>{l('자세히', 'Details')}</summary><p className={styles.muted}>{l('IBM 일별 시세를 1회 조회해 확인했습니다. 다른 시장·재배포 권한은 따로 확인해야 합니다.', 'Checked with one IBM daily quote. Other markets and redistribution rights need separate verification.')} {l('관측일', 'Observation date')}: {result.probe.asOf}</p></details>}
    {onConnect && <form onSubmit={event => {
      event.preventDefault(); if (!key.trim() || saving || busy) return;
      const value = key.trim(); setSaving(true); setMessage(''); epoch.current++; setResult(null);
      void onConnect(value).then(async () => {
        if (!mounted.current) return;
        setKey(''); setMessage(l('키를 저장했습니다. 연결 확인을 눌러 실제로 연결되는지 확인하세요.', 'Key saved. Press Test connection to confirm it works.'));
        if (onInspect) { const current = epoch.current; const next = await onInspect({ action: 'status' }); if (mounted.current && epoch.current === current) setResult(next); }
      }).catch(() => { if (mounted.current) setMessage(l('키를 저장하지 못했습니다. 잠시 뒤 다시 시도하세요.', 'Could not save the key. Try again in a moment.')); }).finally(() => { if (mounted.current) { setKey(''); setSaving(false); } });
    }}><label className={styles.label}>{result?.credential === 'present' ? l('API 키 바꾸기', 'Replace API key') : l('API 키', 'API key')}<input className={styles.input} type="password" autoComplete="new-password" spellCheck={false} maxLength={512} value={key} onChange={event => setKey(event.target.value)} disabled={saving || busy}/></label><button className={`${styles.button} ${local.submit}`} disabled={saving || busy || !key.trim()} title={!key.trim() ? l('키를 입력하세요', 'Enter a key first') : undefined}>{saving ? l('저장 중…', 'Saving…') : l('키 저장', 'Save key')}</button>
      <p className={styles.muted}>{l('저장한 키는 다시 표시되지 않습니다.', 'A saved key is never shown again.')} <a className={styles.link} href="https://www.alphavantage.co/" target="_blank" rel="noopener noreferrer">{l('Alpha Vantage 홈페이지', 'Alpha Vantage website')}</a></p></form>}
    {message && <p className={styles.muted} role="status">{message}</p>}
    </details>
    </details>}
  </section>;
}
