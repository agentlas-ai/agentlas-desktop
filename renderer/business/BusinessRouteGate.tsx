'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useBusinessCopy } from './use-business-copy';
import { useBusinessEligibility } from './use-business-eligibility';
import { rememberCompanyEntry, useOrganizationUiVisibility } from './organization-visibility';

/** 서버 적격성을 끝내 읽지 못했을 때(오프라인·조직 기능이 꺼진 서버) 숨기기로 정하기까지 기다리는 시간. */
const SETTLE_MS = 10_000;

/**
 * `/business`(회사 계정 로그인·조직 화면)로 들어가는 유일한 문. 조직 계정이거나 회사 링크로 이 앱을 연 사람에게만 화면을 그리고,
 * 그 밖에는 개인 화면으로 돌려보낸다(규칙: shared/business/visibility.ts). 앱 안의 어떤 진입점도 이 문을 우회하지 않는다.
 *
 * 회사 링크(`agentlas://company/join`)는 Main 이 `/business?entry=link` 경로로 넘긴다. 여기서 그 신호를 한 번 받아 흔적을 남기고 주소에서 지운다 —
 * 링크 내용은 어디에도 남기지 않는다.
 */
export function BusinessRouteGate() {
  const router = useRouter();
  const { copy } = useBusinessCopy();
  const [linkChecked, setLinkChecked] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('entry') === 'link') {
        rememberCompanyEntry();
        url.searchParams.delete('entry');
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
      }
    } catch { /* 주소를 읽지 못하면 흔적 없이 규칙대로 정한다 */ }
    setLinkChecked(true);
  }, []);
  const access = useBusinessEligibility({ enabled: linkChecked });
  const visibility = useOrganizationUiVisibility({ eligible: access.eligibility ? access.eligible : null });
  useEffect(() => {
    if (!linkChecked) return;
    const timer = setTimeout(() => setTimedOut(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [linkChecked]);
  // 서버가 방금 답했거나(true/false) 오래 기다렸는데도 못 읽었으면 더 기다리지 않는다.
  const settled = linkChecked && (access.eligibility !== null || timedOut);
  const denied = settled && !visibility.entry;
  useEffect(() => { if (denied) router.replace('/'); }, [denied, router]);
  // 2026-10-28: the company-server (NAS) Business is gone; teams live in the web console (agentlas.cloud/business) and team keys
  // reach this Desktop through the seat sync (electron/org-seat). The old screens are no longer reachable from here.
  if (visibility.entry) return <BusinessMovedNotice onBack={() => router.replace('/')} copy={copy} />;
  return <div role="status" aria-live="polite" data-organization-gate={denied ? 'redirecting' : 'checking'}
    style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--black)', color: 'var(--white-soft)', fontSize: 13 }}>
    {copy('확인 중…', 'Checking…')}
  </div>;
}

export const TEAM_CONSOLE_URL = 'https://agentlas.cloud/business';

function BusinessMovedNotice({ onBack, copy }: { onBack(): void; copy(ko: string, en: string): string }) {
  return <div data-organization-gate="moved" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--black)', color: 'var(--white-soft)' }}>
    <div style={{ maxWidth: 420, padding: 24, textAlign: 'center', display: 'grid', gap: 12 }}>
      <strong style={{ fontSize: 16 }}>{copy('팀 관리는 웹으로 옮겼습니다', 'Team management moved to the web')}</strong>
      <span style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.85 }}>{copy(
        '회사 서버 연결은 더 이상 쓰지 않습니다. 관리자는 웹 팀 콘솔에서 멤버·AI 키·결제를 관리하고, 팀원은 이 앱에 같은 계정으로 로그인하면 팀 키가 자동으로 들어옵니다.',
        'Company servers are no longer used. Admins manage members, AI keys and billing in the web team console; members just sign in to this app with the same account and team keys arrive automatically.')}</span>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => window.open(TEAM_CONSOLE_URL, '_blank', 'noopener,noreferrer')}
          style={{ minHeight: 40, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--white-soft)', color: 'var(--black)', cursor: 'pointer', fontWeight: 600 }}>
          {copy('웹 팀 콘솔 열기', 'Open the team console')}</button>
        <button type="button" onClick={onBack}
          style={{ minHeight: 40, padding: '0 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,.3)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
          {copy('돌아가기', 'Back')}</button>
      </div>
    </div>
  </div>;
}
