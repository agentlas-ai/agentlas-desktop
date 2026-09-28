/*
 * 로그인 벽 판정 — 순수 함수만. 이 파일은 registrable-domain 외에 아무것도 import 하지 않는다.
 *
 * 왜 (오너 2026-09-28 "쿠키 가져왔는데 로그인이 안 되는 게 말이 안 됨. 1회 안 되면 다른 방법"):
 *   에이전트가 로그인 벽에 서면 그것 자체가 결함이다. 그런데 벽을 "모델이 쓴 문장"으로 알아채면
 *   ("로그인이 필요합니다" …) 언어·사이트마다 새고, 모델이 벽을 못 알아보면 아무 일도 안 일어난다.
 *   그래서 판정은 두 가지 구조적 사실로만 한다:
 *     1) 에이전트가 실제로 도착한 **주소**가 그 사이트의 알려진 로그인 경로이거나 신원 제공자(IdP)다.
 *     2) 에이전트가 **실제로 쓴 저장소**에 그 사이트의 세션 쿠키가 있는가(이름·만료만, 값은 안 본다).
 *   (2)는 벽 여부가 아니라 "왜 벽인가"를 가른다 — 쿠키가 있는데도 벽이면 서버가 그 세션을 버린 것이다
 *   (실측 2026-09-27T21:52Z: 전용 크롬에 21:45 에 새로 넣은 구글 SID 가 있었는데도 accountchooser).
 *
 * 표는 **데이터**다(어느 호스트·경로가 로그인 화면인가, 어느 쿠키 이름이 세션인가). 의도 판정이 아니다.
 */
import { registrableDomain } from "../../shared/registrable-domain";

export type BrowserCookieSurface = "native-partition" | "cdp-profile";

export type LoginWallRule =
  | "identity-provider"
  | "site-sign-in-path";

/** 쿠키 한 줄의 메타데이터. 값은 이 모듈에 절대 들어오지 않는다. */
export interface CookieMetadata {
  /** host_key 그대로(".google.com" 등). */
  domain: string;
  name: string;
  /** 초 단위 만료. 세션 쿠키는 null. */
  expires: number | null;
  /** 초 단위 마지막 갱신(알 수 있을 때만). */
  updatedAt?: number | null;
}

export type SessionCookieEvidence = "present" | "absent" | "unknown";

export type LoginWallDetection =
  | { kind: "not-web" }
  | { kind: "clear"; host: string }
  | {
    kind: "login-wall";
    rule: LoginWallRule;
    /** 벽이 서 있는 호스트(accounts.google.com 등). */
    wallHost: string;
    /** 에이전트가 가려던 사이트(등록 가능 도메인). 알 수 없으면 벽 호스트의 도메인. */
    site: string;
    /** 그 사이트의 로그인을 발급하는 도메인들(youtube.com → google.com). */
    identityDomains: string[];
    /** 되살릴 도메인 전체(site + identityDomains, 중복 제거·정렬). */
    targetDomains: string[];
    /** 에이전트가 쓴 저장소 기준. 저장소를 모르면 unknown. */
    sessionCookies: SessionCookieEvidence;
  };

interface IdentityProviderRule {
  host: RegExp;
  path: RegExp;
  /** 이 제공자가 발급하는 등록 가능 도메인. */
  domain: string;
  /** 원래 가려던 곳을 싣는 쿼리 이름들. */
  returnParams: string[];
  /** 쿼리로 못 찾을 때 service= 값으로 사이트를 고르는 표. */
  serviceSites?: Record<string, string>;
}

const IDENTITY_PROVIDERS: IdentityProviderRule[] = [
  {
    host: /^accounts\.google\.com$/u,
    path: /^\/(?:v\d+\/)?(?:signin|ServiceLogin|AccountChooser|InteractiveLogin|o\/oauth2\/auth(?:chooser)?|CheckCookie)(?:[/?#]|$)/iu,
    domain: "google.com",
    returnParams: ["continue", "followup", "next", "redirect_uri"],
    serviceSites: { youtube: "youtube.com", mail: "google.com", cl: "google.com", wise: "google.com" },
  },
  { host: /^login\.(?:microsoftonline|live)\.com$/u, path: /^\//u, domain: "microsoftonline.com", returnParams: ["redirect_uri", "wreply", "ru"] },
  { host: /^appleid\.apple\.com$/u, path: /^\/(?:auth|sign-in)/iu, domain: "apple.com", returnParams: ["redirect_uri"] },
  { host: /^nid\.naver\.com$/u, path: /^\/nidlogin\.login/iu, domain: "naver.com", returnParams: ["url"] },
  { host: /^accounts\.kakao\.com$/u, path: /^\/login/iu, domain: "kakao.com", returnParams: ["continue"] },
  { host: /^auth\.openai\.com$/u, path: /^\/(?:log-in|authorize|u\/login)/iu, domain: "openai.com", returnParams: ["redirect_uri"] },
];

/** 사이트 자체의 로그인 경로(등록 가능 도메인 → 경로). */
const SITE_SIGN_IN_PATHS: Record<string, RegExp> = {
  "x.com": /^\/(?:i\/flow\/login|login)(?:[/?#]|$)/iu,
  "twitter.com": /^\/(?:i\/flow\/login|login)(?:[/?#]|$)/iu,
  "github.com": /^\/(?:login|session)(?:[/?#]|$)/iu,
  "instagram.com": /^\/accounts\/login(?:[/?#]|$)/iu,
  "threads.com": /^\/login(?:[/?#]|$)/iu,
  "threads.net": /^\/login(?:[/?#]|$)/iu,
  "facebook.com": /^\/(?:login(?:\.php)?|checkpoint)(?:[/?#]|$)/iu,
  "linkedin.com": /^\/(?:login|uas\/login|checkpoint\/lg)(?:[/?#]|$)/iu,
  "reddit.com": /^\/login(?:[/?#]|$)/iu,
  "tiktok.com": /^\/login(?:[/?#]|$)/iu,
  "youtube.com": /^\/signin(?:[/?#]|$)/iu,
};

/** 표에 없는 사이트에도 흔한 로그인 경로. 첫 경로 조각만 본다. */
const GENERIC_SIGN_IN_PATH = /^\/(?:login|log-in|signin|sign-in|sign_in|auth\/login|accounts\/login|users\/sign_in|session\/new)(?:[/?#]|$)/iu;

/** 그 사이트의 로그인을 다른 도메인이 발급하는 경우. */
const SITE_IDENTITY_DOMAINS: Record<string, string[]> = {
  "youtube.com": ["google.com"],
  "google.co.kr": ["google.com"],
  "threads.com": ["instagram.com"],
  "threads.net": ["instagram.com"],
  "x.com": ["twitter.com"],
  "twitter.com": ["x.com"],
  "chatgpt.com": ["openai.com"],
};

/**
 * 세션(로그인)임을 말해 주는 쿠키 이름. 이름만이며 값은 절대 보지 않는다.
 * 표에 없는 도메인은 "unknown" 으로 둔다 — 추측으로 present/absent 를 만들지 않는다.
 */
const SESSION_COOKIE_NAMES: Record<string, readonly string[]> = {
  "google.com": ["SID", "__Secure-1PSID", "__Secure-3PSID", "SAPISID"],
  "youtube.com": ["LOGIN_INFO", "SID", "__Secure-1PSID", "__Secure-3PSID"],
  "x.com": ["auth_token"],
  "twitter.com": ["auth_token"],
  "github.com": ["user_session", "__Host-user_session_same_site"],
  "instagram.com": ["sessionid"],
  "threads.com": ["sessionid"],
  "threads.net": ["sessionid"],
  "facebook.com": ["c_user", "xs"],
  "linkedin.com": ["li_at"],
  "naver.com": ["NID_AUT", "NID_SES"],
  "reddit.com": ["reddit_session", "token_v2"],
  "openai.com": ["__Secure-next-auth.session-token"],
  "chatgpt.com": ["__Secure-next-auth.session-token"],
};

export function sessionCookieNamesFor(domain: string): readonly string[] | null {
  return SESSION_COOKIE_NAMES[registrableDomain(domain)] ?? null;
}

export function identityDomainsFor(site: string): string[] {
  const root = registrableDomain(site);
  return [...(SITE_IDENTITY_DOMAINS[root] ?? [])];
}

function parseHttpUrl(value: string | null | undefined): URL | null {
  if (!value || typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** IdP 주소에서 원래 가려던 사이트를 찾는다. continue 안의 next 처럼 두 겹까지 따라간다. */
function returnSiteOf(url: URL, rule: IdentityProviderRule): string | null {
  const seen = new Set<string>();
  const walk = (current: URL, depth: number): string | null => {
    for (const name of rule.returnParams.concat(depth > 0 ? ["next", "continue", "url"] : [])) {
      const raw = current.searchParams.get(name);
      const inner = parseHttpUrl(raw);
      if (!inner || seen.has(inner.href)) continue;
      seen.add(inner.href);
      const innerDomain = registrableDomain(inner.hostname);
      // 가려던 곳이 또 같은 IdP 이거나 그 사이트의 중간 로그인 경로면 한 겹 더 들어간다.
      if (depth < 2) {
        const deeper = walk(inner, depth + 1);
        if (deeper && deeper !== rule.domain) return deeper;
      }
      if (innerDomain && innerDomain !== rule.domain) return innerDomain;
    }
    return null;
  };
  const found = walk(url, 0);
  if (found) return found;
  const service = url.searchParams.get("service");
  return service && rule.serviceSites?.[service] ? rule.serviceSites[service] : null;
}

/**
 * 한 도메인 묶음에 대해 저장소가 세션 쿠키를 갖고 있는가.
 *  - 표에 이름이 있는 도메인마다 만료 안 된 세션 쿠키가 하나라도 있으면 present.
 *  - 표에 있는 도메인 중 하나라도 없으면 absent(그 도메인이 벽의 원인일 수 있다).
 *  - 표에 있는 도메인이 하나도 없으면 unknown.
 */
export function evaluateSessionCookies(
  cookies: readonly CookieMetadata[] | null | undefined,
  domains: readonly string[],
  nowSeconds: number,
): SessionCookieEvidence {
  if (!cookies) return "unknown";
  let known = 0;
  for (const domain of domains) {
    const names = sessionCookieNamesFor(domain);
    if (!names) continue;
    known += 1;
    const root = registrableDomain(domain);
    const live = cookies.some((cookie) => {
      const host = cookie.domain.replace(/^\./u, "").toLowerCase();
      if (registrableDomain(host) !== root) return false;
      if (!names.includes(cookie.name)) return false;
      return cookie.expires === null || cookie.expires > nowSeconds;
    });
    if (!live) return "absent";
  }
  return known === 0 ? "unknown" : "present";
}

/**
 * 원본(평소 크롬)의 로그인 상태 — 같은 규칙, 결과 이름만 다르다.
 *  missing: 표에 있는 세션 쿠키 이름이 한 줄도 없다(로그아웃).
 *  expired: 줄은 있지만 전부 만료됐다.
 *  present: 살아 있는 세션 쿠키가 있다.
 *  unknown: 표에 없는 사이트라 판단하지 않는다.
 */
export type SourceSessionState = "present" | "expired" | "missing" | "unknown";

export function evaluateSourceSession(
  cookies: readonly CookieMetadata[] | null | undefined,
  domains: readonly string[],
  nowSeconds: number,
): SourceSessionState {
  if (!cookies) return "unknown";
  let known = 0;
  let sawExpired = false;
  for (const domain of domains) {
    const names = sessionCookieNamesFor(domain);
    if (!names) continue;
    known += 1;
    const root = registrableDomain(domain);
    const rows = cookies.filter((cookie) => registrableDomain(cookie.domain.replace(/^\./u, "").toLowerCase()) === root
      && names.includes(cookie.name));
    if (rows.length === 0) return "missing";
    if (!rows.some((cookie) => cookie.expires === null || cookie.expires > nowSeconds)) sawExpired = true;
  }
  if (known === 0) return "unknown";
  return sawExpired ? "expired" : "present";
}

/**
 * 에이전트가 도착한 주소가 로그인 벽인가. 주소는 호출자가 **브라우저에서 직접** 읽은 값이어야 한다
 * (CDP 대상 목록·Electron webContents.getURL). 모델이 쓴 문장에서 주소를 뽑지 않는다.
 */
export function detectLoginWall(input: {
  url: string | null | undefined;
  /** 에이전트가 실제로 쓴 저장소의 쿠키 메타데이터. 모르면 생략. */
  storeCookies?: readonly CookieMetadata[] | null;
  nowSeconds?: number;
}): LoginWallDetection {
  const url = parseHttpUrl(input.url);
  if (!url) return { kind: "not-web" };
  const host = url.hostname.toLowerCase();
  const path = url.pathname || "/";
  const now = input.nowSeconds ?? Date.now() / 1_000;
  const build = (rule: LoginWallRule, site: string, extraIdentity: string[]): LoginWallDetection => {
    const identityDomains = [...new Set([...extraIdentity, ...identityDomainsFor(site)])].filter((d) => d && d !== site).sort();
    const targetDomains = [...new Set([site, ...identityDomains])].sort();
    return {
      kind: "login-wall",
      rule,
      wallHost: host,
      site,
      identityDomains,
      targetDomains,
      sessionCookies: evaluateSessionCookies(input.storeCookies, targetDomains, now),
    };
  };

  for (const rule of IDENTITY_PROVIDERS) {
    if (!rule.host.test(host) || !rule.path.test(path)) continue;
    const site = returnSiteOf(url, rule) ?? rule.domain;
    return build("identity-provider", site, [rule.domain]);
  }

  const site = registrableDomain(host);
  if (!site) return { kind: "clear", host };
  const sitePath = SITE_SIGN_IN_PATHS[site];
  if (sitePath ? sitePath.test(path) : GENERIC_SIGN_IN_PATH.test(path)) {
    return build("site-sign-in-path", site, []);
  }
  return { kind: "clear", host };
}

/** 오너 카드가 여는 로그인 주소. 되돌아갈 곳이 있으면 그리로 돌아오게 한다. */
export function signInUrlFor(site: string, returnUrl?: string | null): string {
  const root = registrableDomain(site);
  const back = parseHttpUrl(returnUrl);
  if (root === "youtube.com" || root === "google.com" || root === "google.co.kr") {
    const target = back && registrableDomain(back.hostname) !== "google.com" ? back.href : `https://www.${root}/`;
    return `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(target)}`;
  }
  if (root === "x.com" || root === "twitter.com") return "https://x.com/i/flow/login";
  if (root === "github.com") return "https://github.com/login";
  if (root === "naver.com") return "https://nid.naver.com/nidlogin.login";
  return back?.href ?? `https://${root}/`;
}

/** 카드 문구에 쓸 사람 이름. 표에 없으면 도메인 그대로. */
export function siteDisplayName(site: string): string {
  const root = registrableDomain(site);
  const names: Record<string, string> = {
    "youtube.com": "YouTube(Google)",
    "google.com": "Google",
    "x.com": "X",
    "twitter.com": "X",
    "github.com": "GitHub",
    "instagram.com": "Instagram",
    "threads.com": "Threads",
    "naver.com": "네이버",
    "linkedin.com": "LinkedIn",
  };
  return names[root] ?? root;
}
