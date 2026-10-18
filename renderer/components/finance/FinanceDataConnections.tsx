"use client";
import { useEffect, useRef, useState } from 'react';
import type { FinanceDataConnectionRequest, FinanceDataConnectionResult } from '@shared/finance';
import { navigate } from '@/lib/navigation';
import { FinanceMessage } from './FinanceMessage';
import styles from './FinanceWorkspace.module.css';

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
  const presence = result?.credential === 'present' ? l('키 있음 · 권한은 별도 확인', 'Key present · access requires a test') : result?.credential === 'missing' ? l('키 없음', 'No configured key') : l('키 보관 상태 미확인', 'Credential presence unknown');
  const access = result?.access === 'available' ? l('일별 시세 접속 확인', 'Daily quote access verified') : result?.access === 'unavailable' ? l('접속 권한·한도 확인 필요', 'Check access and request limits') : result?.access === 'error' ? l('접속 검사 실패', 'Connection test failed') : l('접속 검사 전', 'Access not tested');
  return <section className={styles.importPanel} aria-label={l('데이터 도구', 'Data tools')}>
    <div className={styles.cardHead}><h3>{l('데이터 도구', 'Data tools')}</h3><button type="button" className={styles.button} onClick={() => navigate('/library/toolchains')}>{l('도구 관리', 'Manage tools')}</button></div>
    <p className={styles.muted}>{l('사용할 도구와 플러그인을 관리하세요.', 'Manage the tools and plugins you want to use.')}</p>
    {(onInspect || onConnect) && <details style={{ marginTop: 16 }}><summary>{l('추가 연결', 'Additional connections')}</summary>
    <div className={styles.cardHead}><h4>Alpha Vantage</h4></div>
    <div className={styles.evidenceChips} role="status" aria-live="polite"><span className={styles.badge}>{presence}</span><span className={styles.badge}>{access}</span></div>
    <p className={styles.muted}>{l('검사는 저장된 키로 IBM 일별 시세를 1회 조회하며 호출 한도를 사용합니다. 다른 자료·시장·재배포 권한은 별도 확인이 필요합니다.', 'The test requests one IBM daily quote using the configured key and consumes quota. Other data, markets and redistribution rights require separate verification.')}</p>
    {result?.checkedAt && <p className={styles.muted}>{l('검사 시각', 'Checked at')}: {result.checkedAt}{result.probe ? ` · ${l('관측일', 'Observation date')}: ${result.probe.asOf} · IBM` : ''}</p>}
    {result?.errorCode && <FinanceMessage value={result.errorCode} ko={ko}/>}
    {onInspect && <div className={styles.actions}><button type="button" className={styles.button} disabled={busy || saving} onClick={() => { void inspect('status'); }}>{l('키 보관 상태 확인', 'Check credential presence')}</button><button type="button" className={styles.button} disabled={busy || saving} onClick={() => { void inspect('test'); }}>{busy ? l('확인 중…', 'Checking…') : l('접속 검사 · 1회 호출', 'Test access · one request')}</button></div>}
    {onConnect && <details style={{ marginTop: 16 }}><summary>{l('공급자 키 저장·교체', 'Save or replace provider key')}</summary><p><a className={styles.link} href="https://www.alphavantage.co/" target="_blank" rel="noopener noreferrer">{l('Alpha Vantage 공식 안내', 'Alpha Vantage official information')}</a></p><form onSubmit={event => {
      event.preventDefault(); if (!key.trim() || saving || busy) return;
      const value = key.trim(); setSaving(true); setMessage(''); epoch.current++; setResult(null);
      void onConnect(value).then(async () => {
        if (!mounted.current) return;
        setKey(''); setMessage(l('키를 저장했습니다. 접속 검사를 실행해 실제 접근 여부를 확인하세요.', 'Key saved. Run the access test to verify provider access.'));
        if (onInspect) { const current = epoch.current; const next = await onInspect({ action: 'status' }); if (mounted.current && epoch.current === current) setResult(next); }
      }).catch(() => { if (mounted.current) setMessage(l('키 저장 또는 상태 확인을 완료하지 못했습니다. 보관 상태를 확인한 뒤 다시 시도하세요.', 'Could not finish saving or checking the key. Inspect credential presence before retrying.')); }).finally(() => { if (mounted.current) { setKey(''); setSaving(false); } });
    }}><label className={styles.label}>{l('API 키 · 화면에만 임시 보관', 'API key · temporary input only')}<input className={styles.input} type="password" autoComplete="new-password" spellCheck={false} maxLength={512} value={key} onChange={event => setKey(event.target.value)} disabled={saving || busy}/></label><button className={styles.button} disabled={saving || busy || !key.trim()} style={{ marginTop: 12 }}>{saving ? l('저장 중…', 'Saving…') : l('키 저장', 'Save key')}</button></form><p className={styles.muted}>{l('기존 키는 표시하지 않습니다. 키는 작업 문서·AI 요청·내보내기에 포함하지 않습니다.', 'Existing keys are never displayed. Keys are excluded from workspace documents, AI requests and exports.')}</p></details>}
    {message && <p className={styles.muted} role="status">{message}</p>}
    </details>}
  </section>;
}
