// Connect의 "브라우저 자격증명 가져오기" 계약 — 렌더러와 메인이 공유한다.
//
// 왜 있는가: 지금까지 사용자는 Connect에서 사이트 주소를 손으로 치고 전용 창에서 하나씩
// 로그인했다. 평소 쓰는 Chrome에는 이미 그 로그인이 다 있는데도. 이 계약은 "평소 Chrome에서
// 로그인된 도메인을 목록으로 보여주고, 고른 것만 전용 프로필로 가져온다"를 표현한다.
//
// 경계: 값은 절대 복호화하지 않는다. 쿠키는 암호화된 채로 옮기고, 저장된 비밀번호(Login Data)와
// 결제수단(Web Data)은 **아예 건드리지 않는다**. 화면에 나가는 것은 도메인·표시이름·개수뿐이다.

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

/** 한 프로필에서 발견한, 로그인 흔적이 있는 도메인 하나. */
export interface DiscoveredCredentialDomain {
  /** 등록 가능 도메인(호스트에서 선행 점 제거). 예: "x.com". */
  domain: string;
  /**
   * 사람이 알아보는 페이지 이름. 방문 기록의 제목에서 가장 자주 쓰인 것을 고른다.
   * 없으면 null — 그때 화면은 도메인만 보여준다(지어내지 않는다).
   */
  title: string | null;
  /** 이 도메인에 딸린 쿠키 행 수. 값은 읽지 않는다. */
  cookieCount: number;
  /** 세션 지속에 쓰이는 만료 있는 쿠키가 있는가 — "로그인된 것 같다"의 근거. */
  hasPersistentCookie: boolean;
  /** 이미 Connect 목록에 있는 사이트인가. 화면에서 '연동됨'으로 표시. */
  alreadyLinked: boolean;
}

export interface BrowserCredentialScanResult {
  ok: boolean;
  profiles: DiscoveredBrowserProfile[];
  /** 요청한 프로필의 도메인 목록. 프로필 미지정 스캔이면 비어 있다. */
  domains: DiscoveredCredentialDomain[];
  /** 스캔 대상이었던 프로필 id. */
  profileId: string | null;
  error?: string;
}

export interface BrowserCredentialImportRequest {
  profileId: string;
  /** 사용자가 체크한 도메인. 빈 배열이면 아무것도 하지 않는다. */
  domains: string[];
}

export interface BrowserCredentialImportResult {
  ok: boolean;
  /** 전용 프로필로 새로 들어간 쿠키 행 수. 이미 있던 행은 건드리지 않는다(merge). */
  cookiesAdded: number;
  /** Connect 목록에 등록된 사이트. */
  linkedSites: string[];
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
