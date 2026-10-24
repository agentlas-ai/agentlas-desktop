'use client';
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../lib/ipc';
import {
  isCompanyEntryKey, isEligibilityMemo, newCompanyEntryKey, newEligibilityMemo, organizationUiVisibility,
  type CompanyEntryKey, type EligibilityMemo, type OrganizationUiVisibility,
} from '../../shared/business/visibility';

/**
 * 조직 계정 화면의 표시 규칙(`shared/business/visibility.ts`)을 렌더러에 붙이는 곳. 조직 진입점·관리 화면은 모두 여기 훅 하나만 읽는다.
 *
 * 저장: 회사 링크의 흔적(`agentlas.business.company-entry.v1`)과 같은 계정이 마지막으로 서버에서 읽힌 적격성(`…eligibility-memo.v1`)은
 * 이 프로필의 localStorage 에 둔다. 둘 다 표시 판단용일 뿐 권한이 아니고, 읽을 때마다 닫힌 형식·만료·계정 일치를 다시 검사한다.
 * 개인 계정에게는 어떤 서버 호출도 더하지 않는다 — 서버를 읽는 것은 기존에 읽던 자리(계정 메뉴·제품 메뉴·/business)에서만이고,
 * 이 훅은 그 결과를 받아 기억할 뿐이다.
 */
const ENTRY_KEY = 'agentlas.business.company-entry.v1';
const MEMO_KEY = 'agentlas.business.eligibility-memo.v1';
const CHANGED_EVENT = 'agentlas:org-visibility-changed';
/** 같은 값을 매번 다시 쓰지 않는다(읽기마다 저장하면 다른 창의 storage 이벤트가 끝없이 돈다). */
const MEMO_REFRESH_MS = 60 * 60 * 1000;

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
function readJson(key: string): unknown {
  try { const raw = storage()?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeJson(key: string, value: unknown): void {
  try { storage()?.setItem(key, JSON.stringify(value)); } catch { /* 저장 불가(용량·프라이빗 모드)면 기억 없이 그 세션만 숨김/표시를 정한다 */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function readCompanyEntryKey(now: number = Date.now()): CompanyEntryKey | null {
  const value = readJson(ENTRY_KEY);
  return isCompanyEntryKey(value, now) ? value : null;
}
/** 회사 링크(`agentlas://company/…`)가 이 앱을 연 흔적을 남긴다. 링크 내용은 어디에도 저장하지 않는다. */
export function rememberCompanyEntry(now: number = Date.now()): void { writeJson(ENTRY_KEY, newCompanyEntryKey(now)); }
export function forgetCompanyEntry(): void {
  try { storage()?.removeItem(ENTRY_KEY); } catch { /* 지울 수 없으면 만료가 지운다 */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED_EVENT));
}
export function readEligibilityMemo(now: number = Date.now()): EligibilityMemo | null {
  const value = readJson(MEMO_KEY);
  return isEligibilityMemo(value, now) ? value : null;
}
function rememberEligibility(account: string, eligible: boolean, now: number = Date.now()): void {
  const current = readEligibilityMemo(now);
  if (current && current.account === account.toLowerCase() && current.eligible === eligible && now - Date.parse(current.seenAt) < MEMO_REFRESH_MS) return;
  try { writeJson(MEMO_KEY, newEligibilityMemo(account, eligible, now)); } catch { /* 지문이 형식에 맞지 않으면 기억하지 않는다 */ }
}

/** 현재 로그인한 계정의 지문(로그인하지 않았으면 null). 세션이 바뀌면 따라 바뀐다. */
function useAccountFingerprint(): string | null {
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const apply = (session: { signedIn?: boolean; accountFingerprint?: string } | null | undefined) => {
      if (alive) setAccount(session?.signedIn === true && typeof session.accountFingerprint === 'string' && session.accountFingerprint ? session.accountFingerprint.toLowerCase() : null);
    };
    let off: (() => void) | undefined;
    try {
      void ipc()?.auth.getSession().then(apply).catch(() => apply(null));
      off = ipc()?.auth.onSessionChanged?.(apply);
    } catch { apply(null); }
    return () => { alive = false; try { off?.(); } catch { /* 해제 실패는 표시에 영향이 없다 */ } };
  }, []);
  return account;
}

function useStoredVisibilityInputs(): { entryKey: CompanyEntryKey | null; memo: EligibilityMemo | null } {
  // 첫 렌더는 항상 '없음'이다 — 정적으로 내보낸 화면과 같아야 하고, 개인 계정에서 조직 화면이 깜빡이지 않아야 한다.
  const [stored, setStored] = useState<{ entryKey: CompanyEntryKey | null; memo: EligibilityMemo | null }>({ entryKey: null, memo: null });
  useEffect(() => {
    const read = () => setStored({ entryKey: readCompanyEntryKey(), memo: readEligibilityMemo() });
    read();
    window.addEventListener(CHANGED_EVENT, read);
    window.addEventListener('storage', read);
    // 만료는 시각이 지나야 일어난다 — 오래 켜 둔 창이 만료된 흔적을 계속 쓰지 않게 가끔 다시 읽는다.
    const timer = setInterval(read, 5 * 60 * 1000);
    return () => { window.removeEventListener(CHANGED_EVENT, read); window.removeEventListener('storage', read); clearInterval(timer); };
  }, []);
  return stored;
}

/**
 * 조직 화면을 보일지. `eligible` 은 호출한 쪽이 이미 가진 서버 적격성이다(`useBusinessEligibility` 결과: 값이 있으면 true/false, 아직 없으면 null).
 * 서버를 읽지 않는 자리(첫 실행 로그인·설정 목록)는 null 을 넘긴다 — 같은 계정의 기억과 회사 링크의 흔적으로만 정한다.
 */
export function useOrganizationUiVisibility({ eligible }: { eligible: boolean | null }): OrganizationUiVisibility & { account: string | null } {
  const account = useAccountFingerprint();
  const { entryKey, memo } = useStoredVisibilityInputs();
  useEffect(() => { if (eligible !== null && account !== null) rememberEligibility(account, eligible); }, [eligible, account]);
  const visibility = useMemo(() => organizationUiVisibility({ eligible, account, memo, entryKey }), [eligible, account, memo, entryKey]);
  return { ...visibility, account };
}
