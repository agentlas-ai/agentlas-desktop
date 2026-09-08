import type { NativeBrowserCookieImportResult } from "./types";
// Connect의 "브라우저 자격증명 가져오기" 계약 — 렌더러와 메인이 공유한다.
//
// 왜 있는가: 지금까지 사용자는 Connect에서 사이트 주소를 손으로 치고 전용 창에서 하나씩
// 로그인했다. 평소 쓰는 Chrome에는 이미 그 로그인이 다 있는데도. 이 계약은 "평소 Chrome에서
// 로그인된 도메인을 목록으로 보여주고, 고른 것만 전용 프로필로 가져온다"를 표현한다.
//
// 경계: 값은 절대 복호화하지 않는다. 쿠키는 암호화된 채로 옮기고, 저장된 비밀번호(Login Data)와
// 결제수단(Web Data)은 **아예 건드리지 않는다**. 화면에 나가는 것은 도메인·표시이름과
// 쿠키의 개수·플래그 집계뿐이다(이름도 값도 나가지 않는다).

/** 사용자의 평소 Chrome 계열 브라우저에서 발견한 프로필 하나. */
export interface DiscoveredBrowserProfile {
  /** 안정 식별자 — browser(=chrome|edge|brave…) + 프로필 디렉터리명. */
  id: string;
  /** 사람이 읽는 브라우저 이름. 예: "Google Chrome". */
  browser: string;
  /** 프로필 디렉터리명. 예: "Default", "Profile 2". */
  profileKey: string;
  /** Chrome이 아는 프로필 표시 이름. 예: "Mason". */
  displayName: string;
  /** 그 프로필에 로그인된 계정 이메일(있을 때만). 표시용. */
  accountEmail: string | null;
  /** 프로필 디렉터리 절대경로. */
  path: string;
  /** 쿠키 저장소를 실제로 읽을 수 있었는가. false면 reason이 온다. */
  readable: boolean;
  reason?: string;
}

/**
 * 목록의 한 줄 = **사이트 하나**(등록 가능 도메인).
 *
 * ★한 줄은 호스트가 아니라 사이트다. `.mongodb.com`(쿠키 19, 로그인 후보 0)과
 * `auth.mongodb.com`(4, 4)을 따로 두면 로그인 쿠키 필터가 쿠키 대부분을 가진 줄을
 * 떨어뜨리고, 그걸 고른 사용자는 반쯤만 복사된 채 로그인에 실패한다(2026-08-20 실측).
 *
 * ★화면이 렌더하는 것은 `title`(없으면 `domain`)과 `domain` **둘뿐**이다.
 * 아래 숫자 세 개는 순서와 필터를 정하는 내부 신호이고, UI 에 찍지 않는다(오너 결정).
 */
export interface DiscoveredCredentialDomain {
  /**
   * 등록 가능 도메인(eTLD+1). 예: "x.com", "mongodb.com", "fastcampus.co.kr".
   * 이 줄을 고르면 이 사이트의 **모든** 호스트 쿠키가 복사된다 — 로그인 쿠키만 골라 옮기면
   * x.com 의 `ct0`(CSRF, httpOnly 아님) 같은 필수 쿠키가 빠져 로그인이 반쯤 깨진다.
   */
  domain: string;
  /**
   * 사람이 알아보는 사이트 이름. 방문 기록에서 가장 많이 방문한 페이지의 제목을 쓴다.
   * 없으면 null — 그때 화면은 도메인만 보여준다(지어내지 않는다).
   */
  title: string | null;
  /**
   * 이 사이트(모든 하위 호스트 합)의 쿠키 행 수. 값은 읽지 않는다.
   * ★UI 에 렌더 금지, 정렬 키로도 쓰지 않는다. 쿠키가 많은 곳은 로그인한 곳이 아니라
   * 광고·분석 도메인이다(www.googleadservices.com 23개 실측). 진단·게이트용으로만 남긴다.
   */
  cookieCount: number;
  /**
   * 로그인 쿠키 후보 수 — `is_httponly = 1 AND is_secure = 1` 인 행의 수(사이트 합계).
   * 세션 쿠키는 JS 에서 못 읽게(httpOnly) https 로만 보내게(secure) 하는 것이 관행이라,
   * 이 둘을 함께 만족하는 행은 "여기 로그인돼 있다"의 실질적 근거다. 이름·플래그만 세고
   * 값은 절대 읽지 않는다. 0이면 목록에서 제외된다(단 폴백 참조).
   * ★필터·정렬 전용 — UI 에 렌더 금지.
   */
  loginCookieCount: number;
  /**
   * 방문 기록(History)의 이 사이트 visit_count 합. 1순위 정렬 키.
   * ★정렬 전용 — UI 에 렌더 금지.
   */
  visitCount: number;
  /** 세션 지속에 쓰이는 만료 있는 쿠키가 있는가. 정렬 보조 신호 — UI 에 렌더 금지. */
  hasPersistentCookie: boolean;
  /** 이미 Connect 목록에 있는 사이트인가. 화면은 배지 대신 흐리게+선택 불가로만 표현한다. */
  alreadyLinked: boolean;
}

export interface BrowserCredentialScanResult {
  ok: boolean;
  suppressionReason?: "development_effect_policy_disabled";
  profiles: DiscoveredBrowserProfile[];
  /** 요청한 프로필의 도메인 목록. 프로필 미지정 스캔이면 비어 있다. */
  domains: DiscoveredCredentialDomain[];
  /** 스캔 대상이었던 프로필 id. */
  profileId: string | null;
  /**
   * "로그인 쿠키가 있는 사이트"만 남기는 필터가 너무 세서 목록이 거의 비었을 때 true.
   * 그때 domains 는 필터를 푼 전체 목록이며, 화면은 "적게 잡혀서 전부 보여준다"고 말해야 한다.
   * 조용히 빈 목록을 내놓는 것보다 이유를 말하는 쪽이 낫다.
   */
  loginFilterRelaxed?: boolean;
  error?: string;
}

export interface BrowserCredentialImportRequest {
  profileId: string;
  /** 사용자가 체크한 도메인. 빈 배열이면 아무것도 하지 않는다. */
  domains: string[];
}

export interface BrowserCredentialImportResult {
  /** Separate destination receipt; source import success is not native-session proof. */
  nativeSession?: NativeBrowserCookieImportResult;
  ok: boolean;
  suppressionReason?: "development_effect_policy_disabled";
  /** 전용 프로필에 추가되거나 더 최신/읽을 수 있는 암호문으로 교체된 쿠키 행 수. */
  cookiesAdded: number;
  /** Connect 목록에 등록된 사이트. */
  linkedSites: string[];
  /**
   * 원본 브라우저가 앱 경로에 묶어 암호화해 직접 이전할 수 없는 사이트.
   * 실패가 아니다. 사이트는 전용 프로필에 등록되며, 사용자는 해당 사이트의 실제
   * 로그인 화면에서 한 번만 로그인하면 이후 모든 Agentlas 실행이 그 세션을 재사용한다.
   */
  requiresLoginSites?: string[];
  /** 가져오지 못한 도메인과 이유 — 조용히 성공으로 위장하지 않는다. */
  skipped: Array<{ domain: string; reason: string }>;
  error?: string;
}

/** 사용자가 한 번 승인하면 이후 자동 갱신에 쓰이는 동의 기록. */
export interface BrowserCredentialConsent {
  granted: boolean;
  grantedAt: string | null;
  /** 승인 당시 고른 도메인 — 자동 갱신은 이 집합만 다시 가져온다(범위 확대 금지). */
  domains: string[];
  /** 마지막 자동 갱신 시각. */
  lastSyncedAt: string | null;
  /** 승인에 쓰인 소스 프로필. */
  profileId: string | null;
}

export const BROWSER_CREDENTIAL_CONSENT_KEY = "browser.credentialImport.consent.v1";
