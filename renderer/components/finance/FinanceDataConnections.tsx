"use client";
import { useEffect, useRef, useState } from 'react';
import { navigate } from '@/lib/navigation';
import { ipc } from '@/lib/ipc';
import styles from './FinanceWorkspace.module.css';
import local from './FinanceDataConnections.module.css';

export function FinanceDataConnections({ ko }: { ko: boolean }) {
  const l = (a: string, b: string) => ko ? a : b;
  const [request, setRequest] = useState('');
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <section className={styles.importPanel} aria-label={l('데이터 소스 추가', 'Add a data source')}>
    <details className={local.group}><summary>{l('원하는 데이터 소스 요청하기', 'Request a data source')}</summary>
      <form onSubmit={event=>{
        event.preventDefault();const tools=ipc()?.toolchains;if(!request.trim()||creating||!tools)return;
        setCreating(true);setCreationError('');
        void tools.generateAsset({request:request.trim(),requestId:crypto.randomUUID(),purpose:'finance-source'}).then(generated=>{
          if(!mounted.current)return;
          navigate(`/library/toolchains?asset=${encodeURIComponent(generated.asset.id)}&version=${generated.version}`);
        }).catch(()=>{if(mounted.current)setCreationError(l('요청을 처리하지 못했습니다. 내용을 확인한 뒤 다시 시도하세요.', 'Couldn\'t process the request. Check what you wrote and try again.'));}).finally(()=>{if(mounted.current)setCreating(false);});
      }}>
        <label className={styles.label}>{l('필요한 자료와 출처', 'Data and source you need')}<textarea className={`${styles.input} ${styles.textarea}`} rows={3} maxLength={8000} value={request} disabled={creating} placeholder={l('예: 관심 종목의 가격·이력을 무료 공개 사이트에서 가져오기', 'Example: get watchlist prices and history from a free public site')} onChange={event=>setRequest(event.target.value)}/></label>
        <p className={styles.muted}>{l('만들어지면 내용을 확인하고 사용을 시작하세요.', 'When it is ready, review it and start using it.')}</p>
        <button type="submit" className={styles.button} disabled={creating||!request.trim()||!ipc()?.toolchains} title={!request.trim()?l('필요한 자료를 먼저 적어 주세요','Describe the data you need first'):!ipc()?.toolchains?l('이 앱에서는 사용할 수 없습니다','Unavailable in this app'):undefined}>{creating?l('만드는 중…', 'Working on it…'):l('AI에게 요청하기', 'Ask the AI')}</button>
        {creationError&&<p className={styles.muted} role="alert">{creationError}</p>}
      </form>
    </details>
  </section>;
}
