'use client';
import { useRouter } from 'next/navigation';
import { IconBuilding } from '../components/Icon';
import { useBusinessCopy } from './use-business-copy';
import { useBusinessEligibility } from './use-business-eligibility';

export function BusinessEntryButton({ onOpen, className, menu = false, locale: suppliedLocale }: {
  onOpen?(): void; className?: string; menu?: boolean; locale?: 'ko' | 'en';
}) {
  const router = useRouter();
  const { locale: appLocale } = useBusinessCopy();
  const locale = suppliedLocale ?? appLocale;
  const access = useBusinessEligibility();
  const label = access.eligible ? (locale === 'ko' ? '조직 설정' : 'Organization settings')
    : (locale === 'ko' ? '회사 계정 로그인' : 'Company account sign-in');
  return <button type="button" role={menu ? 'menuitem' : undefined} className={className} data-business-entry="true"
    data-business-management={access.eligible ? 'true' : 'false'}
    style={menu ? { display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 44, padding: '8px 10px', background: 'transparent', border: 'none', borderRadius: 6, fontSize: 12, color: 'var(--ink)', cursor: 'pointer', textAlign: 'left' } : undefined}
    onClick={() => { onOpen?.(); router.push('/business'); }}>
    <IconBuilding size={16} /><span>{label}</span>
  </button>;
}
