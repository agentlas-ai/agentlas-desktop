'use client';
import { useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { CompanyNativeAPI, CompanyNativeStatus } from '../../shared/business/company-native';
import type { BusinessSession } from '../../shared/business/context';
import { IconMonitor } from '../components/Icon';
import { OsButton, OsCard, OsDangerZone, OsNotice, osStyles as os } from './org-share-kit';
import { useBusinessCopy } from './use-business-copy';

/** The renderer sees status and invokes a focused Main review. Device keys,
 * PKCE verifier and the company-only credential never cross this interface.
 * 연결됨이면 주 버튼 없이 상태 + (인라인 확인이 붙은) 연결 해제, 연결 전이면 주 버튼 하나. */
export function CompanyNativeConnection({ session }: { session: BusinessSession | null }) {
  const { copy, locale } = useBusinessCopy();
  const [status, setStatus] = useState<CompanyNativeStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const api = (ipc() as unknown as { companyNative?: CompanyNativeAPI } | null)?.companyNative;
  const sessionKey = JSON.stringify(session), generation = useRef(0);
  useEffect(() => { let active = true; const stamp = ++generation.current; setStatus(null); setError(false); if (session && api) void api.status().then(value => { if (active && stamp === generation.current) setStatus(value); }).catch(() => { if (active && stamp === generation.current) setError(true); }); return () => { active = false; generation.current++; }; }, [api, sessionKey]);
  useEffect(() => { if (!status || !session) return; const expiry = Math.min(Date.parse(status.expiresAt), Date.parse(session.expiresAt));
    const timer = setTimeout(() => setStatus(null), Math.max(0, Math.min(2147483647, expiry - Date.now()))); return () => clearTimeout(timer);
  }, [status, sessionKey]);
  const exact = status && session && status.organizationId === session.organizationId && status.principalId === session.principalId && Date.parse(status.expiresAt) > Date.now();
  async function connect() { if (!api || !session || busy) return; const stamp = generation.current; setBusy(true); setError(false);
    try { const value = await api.connect(); if (stamp === generation.current) setStatus(value); }
    catch { if (stamp === generation.current) setError(true); } finally { setBusy(false); }
  }
  async function disconnect() { if (!api) return; const stamp = ++generation.current; setStatus(null); setBusy(false); setError(false);
    try { await api.disconnect(); } catch { if (stamp === generation.current) setError(true); }
  }
  const until = exact && status && session ? new Date(Math.min(Date.parse(status.expiresAt), Date.parse(session.expiresAt))).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return <OsCard step={1} busy={busy} done={!!exact} tone={error ? 'danger' : exact ? 'ok' : busy ? 'info' : 'idle'} status={error ? copy('확인 필요', 'Needs check') : busy ? copy('확인 중…', 'Checking…') : exact ? copy('연결됨', 'Connected') : copy('연결 전', 'Not connected')}
    title={copy('회사 기기 연결', 'Company device connection')}
    description={exact ? copy('현재 회사 계정으로 이 기기가 연결되어 있습니다.', 'This device is connected to the current company account.') : copy('회사 SSO로 로그인한 뒤 이 기기를 연결하세요.', 'Sign in with company SSO, then connect this device.')}>
    {exact
      ? <OsDangerZone bare ko={locale === 'ko'} title={copy('연결 유지 중', 'Connection active')} description={copy(`이 연결은 ${until}까지 유지됩니다.`, `This connection stays active until ${until}.`)} actionLabel={copy('기기 연결 해제', 'Disconnect device')} confirmTitle={copy('이 기기의 연결을 해제할까요?', 'Disconnect this device?')} consequence={copy('해제하면 이 기기는 회사 계정과 연결이 끊어집니다. 다시 쓰려면 이 기기를 다시 연결해야 합니다.', 'This device is disconnected from the company account. Connect it again to keep using company work.')} confirmLabel={copy('연결 해제', 'Disconnect')} disabled={!api} onConfirm={() => void disconnect()} />
      : <div className={os.actions} data-align="start">
        <OsButton variant="primary" icon={<IconMonitor size={16} />} disabled={busy || !api || !session || Date.parse(session.expiresAt) <= Date.now()} onClick={() => void connect()}>{busy ? copy('확인 중…', 'Checking…') : copy('이 기기 연결', 'Connect this device')}</OsButton>
        <OsButton variant="quiet" disabled={!api} onClick={() => void disconnect()}>{copy('기기 연결 해제', 'Disconnect device')}</OsButton>
      </div>}
    {error && <OsNotice tone="danger">{copy('현재 회사 세션과 기기 연결을 확인해 주세요. 연결은 새 승인 후 다시 시도할 수 있습니다.', 'Check the current company session and device connection. You can retry with a new approval.')}</OsNotice>}
  </OsCard>;
}
