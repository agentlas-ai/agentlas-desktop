/**
 * 조직 계정 화면(회사 로그인 진입·조직 설정/공유/업무 변경·회사 에이전트 등)을 누구에게 보일지 정하는 단 하나의 규칙.
 *
 * 오너 결정(2026-10-21): 조직계정 코드는 일반 릴리스에 들어가지만, 조직 계정이 아닌 사용자(개인·무료·유료 개인 플랜)에게는
 * 조직 관련 메뉴·패널·시트·팝업·설정 항목·화면이 하나도 보이면 안 되고, 개인 계정의 동작은 바뀌면 안 된다.
 * 렌더러의 모든 조직 진입점은 이 규칙만 읽는다 — 화면마다 따로 조건을 두지 않는다(새 진입점이 가드 없이 생기는 것을 막는 게이트가 이 파일을 기준으로 본다).
 *
 * 보이는 단계는 둘이다.
 *   management — 서버가 확인한 조직 계정이다(`BusinessEligibility.eligible`: 활성 멤버십이 있는 계정). 조직 설정·공유·업무 변경 같은 관리 화면.
 *   entry      — management 이거나, 이 설치가 회사 링크(`agentlas://company/…`)로 열린 적이 있고 아직 만료되지 않았다(`CompanyEntryKey`).
 *                회사 계정 로그인 진입점(계정 메뉴 항목·첫 실행 로그인 버튼·/business 화면). 회사 직원이 처음 들어오는 길이라 적격성이 생기기 전에도 열려 있어야 한다.
 *
 * 이 규칙은 **보이는 것만** 정한다. 조직 동작 하나하나의 권한은 여전히 각 작업의 현재 소유자(서버 발급 세션·챌린지·연결)가 정한다.
 * 표시 판단에 쓰는 값(링크를 열었다는 흔적, 마지막으로 본 적격성)은 비밀이 아니고 권한이 되지도 않는다.
 *
 * 순수 함수만 둔다 — Electron·DOM·저장소를 가져오지 않아 Main·렌더러·게이트가 같은 판정을 쓴다.
 */

/** 회사 링크가 이 설치를 연 뒤 진입점이 열려 있는 기간. 지나면 적격성(또는 새 링크)이 있어야 한다. */
export const COMPANY_ENTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** 마지막으로 본 적격성(조직 계정이었다/아니었다)을 서버를 다시 읽기 전 표시에 쓸 수 있는 기간. */
export const ELIGIBILITY_MEMO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;

export const COMPANY_ENTRY_KEY_SCHEMA = 'agentlas.business.company-entry.v1' as const;
export const ELIGIBILITY_MEMO_SCHEMA = 'agentlas.business.eligibility-memo.v1' as const;

/** 이 설치가 회사 링크로 열렸다는 흔적. 링크의 내용·초대 번호·조직 이름은 담지 않는다. */
export interface CompanyEntryKey {
  readonly schema: typeof COMPANY_ENTRY_KEY_SCHEMA;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
/** 같은 계정이 마지막으로 서버에서 읽힌 적격성. 계정이 바뀌면(account 지문이 다르면) 쓰지 않는다. */
export interface EligibilityMemo {
  readonly schema: typeof ELIGIBILITY_MEMO_SCHEMA;
  /** 렌더러가 보는 계정 지문(`AuthSession.accountFingerprint`). 로그아웃 상태에서는 기록하지 않는다. */
  readonly account: string;
  readonly eligible: boolean;
  readonly seenAt: string;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => own.includes(key)) && own.every(key => typeof key === 'string');
}
function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function validClock(now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0 && now < 8_640_000_000_000_000 - COMPANY_ENTRY_TTL_MS - ELIGIBILITY_MEMO_TTL_MS;
}

export function newCompanyEntryKey(now: number = Date.now()): CompanyEntryKey {
  if (!validClock(now)) throw new Error('company_entry_clock_invalid');
  return Object.freeze({ schema: COMPANY_ENTRY_KEY_SCHEMA, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + COMPANY_ENTRY_TTL_MS).toISOString() });
}
/** 닫힌 키 집합·정확한 만료 길이·아직 만료되지 않음·미래에서 온 것이 아님. 저장소에서 읽은 값은 언제나 이 검사를 거친다. */
export function isCompanyEntryKey(value: unknown, now: number = Date.now()): value is CompanyEntryKey {
  try {
    if (!validClock(now) || !exactKeys(value, ['schema', 'issuedAt', 'expiresAt']) || value.schema !== COMPANY_ENTRY_KEY_SCHEMA
      || !canonicalIso(value.issuedAt) || !canonicalIso(value.expiresAt)) return false;
    const issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
    return expires - issued === COMPANY_ENTRY_TTL_MS && issued <= now + CLOCK_SKEW_MS && expires > now;
  } catch { return false; }
}

export function newEligibilityMemo(account: string, eligible: boolean, now: number = Date.now()): EligibilityMemo {
  if (!validClock(now) || typeof account !== 'string' || !/^[0-9a-f]{16,64}$/i.test(account)) throw new Error('eligibility_memo_invalid');
  return Object.freeze({ schema: ELIGIBILITY_MEMO_SCHEMA, account: account.toLowerCase(), eligible, seenAt: new Date(now).toISOString() });
}
export function isEligibilityMemo(value: unknown, now: number = Date.now()): value is EligibilityMemo {
  try {
    if (!validClock(now) || !exactKeys(value, ['schema', 'account', 'eligible', 'seenAt']) || value.schema !== ELIGIBILITY_MEMO_SCHEMA
      || typeof value.account !== 'string' || !/^[0-9a-f]{16,64}$/.test(value.account) || typeof value.eligible !== 'boolean'
      || !canonicalIso(value.seenAt)) return false;
    const seen = Date.parse(value.seenAt);
    return seen <= now + CLOCK_SKEW_MS && now - seen < ELIGIBILITY_MEMO_TTL_MS;
  } catch { return false; }
}

export interface OrganizationUiInput {
  /** 이번 읽기에서 서버가 말한 적격성. 아직 읽지 못했거나 읽기에 실패했으면 null(= 모른다). */
  readonly eligible: boolean | null;
  /** 현재 계정 지문(로그인하지 않았으면 null). 기억(memo)은 이 지문과 같을 때만 쓴다. */
  readonly account: string | null;
  readonly memo: unknown;
  readonly entryKey: unknown;
  readonly now?: number;
}
export interface OrganizationUiVisibility {
  /** 조직 관리 화면(설정·공유·업무 변경·회사 에이전트)을 보인다. */
  readonly management: boolean;
  /** 회사 계정 로그인 진입점을 보인다(management 를 포함한다). */
  readonly entry: boolean;
  /** 왜 그렇게 정했는가 — 게이트·진단용이다. */
  readonly via: 'eligibility' | 'memo' | 'entry-key' | 'none';
}

/**
 * 규칙 한 줄 요약: 서버가 방금 "조직 계정"이라고 했거나(없으면 같은 계정의 마지막 기억이 그랬거나) 회사 링크의 흔적이 살아 있을 때만 보인다.
 * 서버가 방금 "아니다"라고 하면 기억은 무시한다(조직에서 나간 계정이 낡은 기억으로 계속 보이지 않게). 읽지 못했을 때(오프라인·재시작 직후)는
 * 같은 계정의 기억이 조직 계정 직원의 화면을 지키되, 기억이 없으면 숨긴다 — 개인 계정이 깜빡이며 보이는 일이 없게 기본은 숨김이다.
 */
export function organizationUiVisibility(input: OrganizationUiInput): OrganizationUiVisibility {
  const now = input.now ?? Date.now();
  const entryKeyAlive = isCompanyEntryKey(input.entryKey, now);
  if (input.eligible === true) return { management: true, entry: true, via: 'eligibility' };
  if (input.eligible === false) return entryKeyAlive ? { management: false, entry: true, via: 'entry-key' } : { management: false, entry: false, via: 'none' };
  const memo = isEligibilityMemo(input.memo, now) && input.account !== null && input.memo.account === input.account.toLowerCase() ? input.memo : null;
  if (memo?.eligible === true) return { management: true, entry: true, via: 'memo' };
  return entryKeyAlive ? { management: false, entry: true, via: 'entry-key' } : { management: false, entry: false, via: 'none' };
}

/**
 * OS 가 앱에 넘기는 회사 링크의 모양. `agentlas://company/join` 또는 `agentlas://company/enter`(뒤에 작은 질의 문자열이 올 수 있다).
 * 링크는 항해가 아니라 신호로만 쓴다 — 내용은 해석하지 않고 모양이 맞는지만 본다(바깥 입력이 임의 경로를 열 수 없다).
 */
export const COMPANY_DEEP_LINK_RE = /^agentlas:\/\/company\/(?:join|enter)\/?(?:\?[A-Za-z0-9._~%=&+-]{0,256})?$/i;
export function isCompanyDeepLink(raw: unknown): boolean {
  return typeof raw === 'string' && raw.length <= 320 && COMPANY_DEEP_LINK_RE.test(raw.trim());
}
/** 회사 링크가 열었을 때 렌더러가 받는 경로. 링크 자체는 렌더러로 보내지 않는다. */
export const COMPANY_ENTRY_ROUTE = '/business?entry=link' as const;
