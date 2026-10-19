'use client';
import { useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { CompanyNativeAPI, CompanyNativeStatus } from '../../shared/business/company-native';
import type { BusinessSession } from '../../shared/business/context';
import { useBusinessCopy } from './use-business-copy';

/** The renderer sees status and invokes a focused Main review. Device keys,
 * PKCE verifier and the company-only credential never cross this interface. */
export function CompanyNativeConnection({ session }: { session: BusinessSession | null }) {
  const { copy } = useBusinessCopy();
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
  return <section aria-label={copy('회사 기기 연결', 'Company device connection')}>
    <h2>{copy('회사 기기 연결', 'Company device connection')}</h2>
    <p>{exact ? copy('현재 회사 계정으로 이 기기가 연결되어 있습니다.', 'This device is connected to the current company account.') : copy('회사 SSO로 로그인한 뒤 이 기기를 연결하세요.', 'Sign in with company SSO, then connect this device.')}</p>
    <button type="button" disabled={busy || !!exact || !api || !session || Date.parse(session.expiresAt) <= Date.now()} onClick={() => void connect()}>{busy ? copy('확인 중…', 'Checking…') : copy('이 기기 연결', 'Connect this device')}</button>
    <button type="button" disabled={!api} onClick={() => void disconnect()}>{copy('기기 연결 해제', 'Disconnect device')}</button>
    {error && <p role="alert">{copy('현재 회사 세션과 기기 연결을 확인해 주세요. 연결은 새 승인 후 다시 시도할 수 있습니다.', 'Check the current company session and device connection. You can retry with a new approval.')}</p>}
  </section>;
}
