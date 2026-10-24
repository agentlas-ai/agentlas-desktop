'use client';
import { useRouter } from 'next/navigation';
import { IconBuilding } from '../components/Icon';
import { useBusinessCopy } from './use-business-copy';
import { useBusinessEligibility } from './use-business-eligibility';
import { useOrganizationUiVisibility } from './organization-visibility';

export function BusinessEntryButton({ onOpen, className, menu = false, locale: suppliedLocale }: {
  onOpen?(): void; className?: string; menu?: boolean; locale?: 'ko' | 'en';
}) {
  const router = useRouter();
  const { locale: appLocale } = useBusinessCopy();
  const locale = suppliedLocale ?? appLocale;
  const access = useBusinessEligibility();
  // 조직 계정이 아니고 회사 링크도 연 적 없는 사용자에게는 이 항목 자체를 그리지 않는다(규칙은 shared/business/visibility.ts 한 곳).
  const visibility = useOrganizationUiVisibility({ eligible: access.eligibility ? access.eligible : null });
  if (!visibility.entry) return null;
  const label = visibility.management ? (locale === 'ko' ? '조직 설정' : 'Organization settings')
    : (locale === 'ko' ? '회사 계정 로그인' : 'Company account sign-in');
  return <button type="button" role={menu ? 'menuitem' : undefined} className={className} data-business-entry="true"
    data-business-management={visibility.management ? 'true' : 'false'}
    style={menu ? { display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 44, padding: '8px 10px', background: 'transparent', border: 'none', borderRadius: 6, fontSize: 12, color: 'var(--ink)', cursor: 'pointer', textAlign: 'left' } : undefined}
    onClick={() => { onOpen?.(); router.push('/business'); }}>
    <IconBuilding size={16} /><span>{label}</span>
  </button>;
}
