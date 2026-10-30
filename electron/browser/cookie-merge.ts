/*
 * 쿠키 가져오기의 "누적" 규칙 — 순수 판정만 모아 둔 곳.
 *
 * 왜 따로 떼었나 (오너 신고 2026-09-14: "가져올 때마다 초기화해서 덮어쓴다"):
 * 가져오기는 **합치기**여야 한다. 같은 쿠키를 두 번 가져오면 한 줄, 다른 쿠키를 가져오면
 * 둘 다 남아야 한다. 그런데 이 판정이 SQL 문자열 사이에 흩어져 있으면 아무도 값으로
 * 확인할 수 없고, 문장 대조 게이트는 제품이 나아질 때 거짓말을 한다. 그래서 결정만
 * 여기로 꺼내고, DB 쪽은 그 결정을 실행만 한다. 이 파일은 아무것도 import 하지 않는다.
 */

/** Chromium 쿠키 행의 진짜 고유키 후보 — 이 조합이 저장소의 UNIQUE 제약이다. */
export const COOKIE_IDENTITY_COLUMNS = [
  "host_key",
  "top_frame_site_key",
  "name",
  "path",
  "source_scheme",
  "source_port",
] as const;

export type CookieWriteAction = "insert" | "replace" | "keep";

/**
 * 목적지에서 한 쿠키 줄을 찾고 지울 때 쓸 **고유키**.
 *
 * ★(host_key, name, path) 만 쓰면 안 된다: 파티션된 쿠키(top_frame_site_key)나 포트·스킴이
 *   다른 형제 줄까지 한꺼번에 지우고 한 줄만 다시 넣게 되어, 가져오기 한 번이 남의 쿠키를
 *   지운다. 실제로 옮길 수 있는 칸(=원본과 목적지의 교집합)만 키로 삼는다.
 */
export function cookieIdentityColumns(sharedColumns: readonly string[]): string[] {
  return COOKIE_IDENTITY_COLUMNS.filter((column) => sharedColumns.includes(column));
}

/** A persistent expiry (any unit). Session cookies (none, 0, negative) and unreadable values are null: nothing to compare. */
export function persistentCookieExpiry(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The expiry of a Chromium cookie-store row, in the store's own unit (Chrome-epoch microseconds); null for a session
 * cookie. This is the ONLY freshness input the SQL store gives the comparison, exactly as the partition and the
 * dedicated-browser feed give their `expirationDate` / `expires`. The old input was max(expires_utc, last_update_utc):
 * a destination session cookie updated an hour ago (expires_utc 0, last_update_utc "now") then lost to a source
 * persistent cookie that was set ten days ago, while the other two paths kept it. last_update_utc says when a row was
 * written, not how long the login lives, so it no longer takes part.
 */
export function cookieStoreExpiry(row: Record<string, unknown> | null | undefined): number | null {
  if (!row) return null;
  return persistentCookieExpiry(Number(row.expires_utc ?? (row as { expiresUtc?: unknown }).expiresUtc));
}

/**
 * May the source refresh the destination's copy of the same cookie? The cookie freshness comparison, written once.
 *
 * Cookies move along three paths (the Electron partition, the dedicated browser over CDP, the SQL store) and a
 * comparison written per path drifts apart: the partition path once kept anything it held and so refreshed least,
 * and the SQL path ordered by a different number than the other two. Every path asks this function, through
 * decideCookieRefresh, with the cookie's expiry.
 *
 *  - True only when the source expires STRICTLY later. The same expiry or a fresher destination is false: the
 *    destination may have rotated a live token since, and an older copy must not roll it back.
 *  - A session cookie (no expiry), a missing value or a broken one on EITHER side cannot be ordered, so the answer is
 *    false. Without this guard a persistent source "beat" a destination session cookie, because a missing expiry read
 *    as 0.
 *  - The unit is the caller's (seconds or microseconds); gap is in the same unit. It keeps the rounding of one move
 *    (microsecond integer <-> float seconds) from reading as "fresher": COOKIE_EXPIRY_TOLERANCE_SECONDS, or
 *    COOKIE_STORE_EXPIRY_TOLERANCE for the store's microseconds.
 */
export function isSourceCookieFresher(
  incoming: number | null | undefined,
  existing: number | null | undefined,
  gap = 0,
): boolean {
  const source = persistentCookieExpiry(incoming);
  const destination = persistentCookieExpiry(existing);
  if (source === null || destination === null) return false;
  return source > destination + gap;
}

/** The smallest difference, read in seconds, that counts as "a different expiry". */
export const COOKIE_EXPIRY_TOLERANCE_SECONDS = 1;

/** The same tolerance in the cookie store's microseconds, so the SQL path is judged by the same second as the others. */
export const COOKIE_STORE_EXPIRY_TOLERANCE = COOKIE_EXPIRY_TOLERANCE_SECONDS * 1_000_000;

export type CookieRefreshDecision = "add" | "refresh" | "keep";

/**
 * What to do with one cookie row, whichever path carries it. decideCookieWrite (SQL store), decideNativeCookieWrite
 * (partition) and decideRuntimeCookieFeed (dedicated browser) only translate their own words and unit into this
 * and back; none of them compares anything itself.
 *   - nothing in the destination: add
 *   - the user just pressed import: the source wins (refresh)
 *   - otherwise refresh only when the source is strictly fresher (isSourceCookieFresher), else keep
 */
export function decideCookieRefresh(input: {
  hasExisting: boolean;
  explicitImport?: boolean;
  incomingExpires: number | null | undefined;
  existingExpires: number | null | undefined;
  /** Tolerance in the unit of the two expiries. */
  gap: number;
}): CookieRefreshDecision {
  if (!input.hasExisting) return "add";
  if (input.explicitImport === true) return "refresh";
  return isSourceCookieFresher(input.incomingExpires, input.existingExpires, input.gap) ? "refresh" : "keep";
}

/**
 * 한 쿠키 줄을 어떻게 쓸 것인가.
 *
 *  - 목적지에 없으면 넣는다(insert) — 다른 사이트·다른 이름의 쿠키는 서로를 지우지 않는다.
 *  - 목적지 암호문을 전용 런타임이 못 읽으면 교체한다(replace) — 못 읽는 줄을 "이미 있음"으로
 *    남기면 화면은 "연결됨"인데 로그인은 안 되는 상태가 영원히 굳는다.
 *  - 신선도를 비교할 칸(expires_utc)이 아예 없는 저장소 형식이면 건드리지 않는다(keep).
 *  - 원본이 만료를 **엄격히** 더 늦게 가질 때만 교체한다(replace). 로그인 쿠키는 회전하므로 갱신이 곧 이전이다.
 *    비교는 decideCookieRefresh 한 곳이고(세 길이 같은 규칙), 입력은 cookieStoreExpiry — 세션 쿠키는 null 이라 비교하지 않는다.
 * Expiries are the store's microseconds; the tolerance is the same one second the other two paths use.
 */
export function decideCookieWrite(input: {
  hasExisting: boolean;
  destinationReadable: boolean;
  hasFreshnessColumns: boolean;
  /** cookieStoreExpiry of the source row (microseconds), null for a session cookie. */
  incomingExpires: number | null;
  /** cookieStoreExpiry of the destination row (microseconds), null for a session cookie. */
  existingExpires: number | null;
}): CookieWriteAction {
  if (!input.hasExisting) return "insert";
  if (!input.destinationReadable) return "replace";
  if (!input.hasFreshnessColumns) return "keep";
  return decideCookieRefresh({
    hasExisting: true,
    incomingExpires: input.incomingExpires,
    existingExpires: input.existingExpires,
    gap: COOKIE_STORE_EXPIRY_TOLERANCE,
  }) === "refresh" ? "replace" : "keep";
}

export type CookieStoreLayout = "legacy" | "network";

/**
 * 전용 프로필의 **어느** 쿠키 파일에 쓸 것인가.
 *
 * ★예전에는 원본 프로필의 모양(Network/ 유무)을 그대로 따라갔다. 그래서 신형 배치의
 *   브라우저에서 한 번, 구형 배치의 브라우저에서 한 번 가져오면 같은 전용 프로필 안의
 *   **서로 다른 파일 두 개**에 나뉘어 쌓이고, 전용 브라우저는 그중 하나만 읽는다 —
 *   사용자 눈에는 "방금 가져온 쿠키가 없어짐"이다. 목적지에 이미 쿠키가 있으면 그 파일을
 *   계속 쓰고, 목적지가 완전히 비어 있을 때만 원본 모양을 따른다.
 */
export function resolveCookieStoreLayout(input: {
  /** 목적지의 구형(Default/Cookies) 행 수. 파일이 없으면 null. */
  legacyRows: number | null;
  /** 목적지의 신형(Default/Network/Cookies) 행 수. 파일이 없으면 null. */
  networkRows: number | null;
  /** 원본이 신형 배치인가. */
  sourceUsesNetworkDir: boolean;
}): CookieStoreLayout {
  const legacy = input.legacyRows ?? 0;
  const network = input.networkRows ?? 0;
  if (legacy > 0 || network > 0) {
    if (legacy === network) return input.sourceUsesNetworkDir ? "network" : "legacy";
    return network > legacy ? "network" : "legacy";
  }
  // 둘 다 비었지만 파일이 이미 있다면 그 파일을 쓴다(전용 브라우저가 만들어 둔 쪽).
  if (input.networkRows !== null && input.legacyRows === null) return "network";
  if (input.legacyRows !== null && input.networkRows === null) return "legacy";
  return input.sourceUsesNetworkDir ? "network" : "legacy";
}

/**
 * One/Work 세션(Electron 파티션)으로 옮길 때의 판정.
 *
 * 자동 갱신은 이미 살아 있는 세션을 함부로 덮지 않는다(사용자가 그 창에서 직접 로그인했을 수 있다).
 * 그러나 **원본이 더 늦게 만료되는**(더 새로 발급된) 쿠키는 갱신한다 — 예전에는 "있으면 보존"만 봐서
 * 평소 크롬이 회전시킨 로그인 쿠키가 파티션에 영영 닿지 않았다. 신선도 비교는 전용 브라우저(CDP)·SQL 길과
 * 같은 decideCookieRefresh 하나로 한다. 목적지가 같거나 더 새것이면 절대 덮지 않는다.
 * 어느 한쪽이 세션 쿠키(만료 없음)면 신선도를 비교할 수 없으므로 보존한다.
 * **사용자가 방금 "가져오기"를 누른 경우**에는 가져온 값이 이겨야 한다 — 그러지 않으면
 * 낡은 쿠키가 남아 "가져왔는데 여전히 로그아웃"이 된다.
 */
export function decideNativeCookieWrite(input: {
  hasExisting: boolean;
  explicitImport: boolean;
  /** 원본 쿠키의 만료(초). 세션 쿠키·모르면 null/undefined — 비교하지 않는다. */
  incomingExpires?: number | null;
  /** 파티션에 이미 있는 같은 쿠키의 만료(초). 세션 쿠키·모르면 null/undefined — 비교하지 않는다. */
  existingExpires?: number | null;
}): "write" | "preserve" {
  return decideCookieRefresh({
    hasExisting: input.hasExisting,
    explicitImport: input.explicitImport,
    incomingExpires: input.incomingExpires,
    existingExpires: input.existingExpires,
    gap: COOKIE_EXPIRY_TOLERANCE_SECONDS,
  }) === "keep" ? "preserve" : "write";
}

/**
 * 자동 갱신이 전용 브라우저(CDP)에 쿠키를 **다시 넣을지** 판정한다.
 *
 * ★오너 신고 2026-09-28 "왜 자꾸 로그아웃되냐 — 크롬 본판이나 브라우저나 다".
 *   macOS 경로는 SQL 병합 판정(decideCookieWrite)을 거친 뒤에도 CDP `addCookies` 로 원본의
 *   **모든** 쿠키를 무조건 덮었다. 전용 브라우저가 그 사이 회전시킨 로그인 토큰(구글 PSIDTS 등)이
 *   평소 크롬의 낡은 값으로 되돌아가고, 같은 세션이 두 브라우저에서 엇갈린 토큰으로 쓰인다 —
 *   사이트의 세션 도용 방어가 반응할 수 있는 모양이다(사이트 쪽 판정은 미확인). 자동 갱신은 전용 브라우저에 **없거나**, 원본이
 *   **더 늦게 만료되는**(더 새로 발급된) 쿠키만 넣는다. 사용자가 방금 누른 가져오기는 원본이 이긴다.
 *
 * 만료 값은 초 단위이며 세션 쿠키는 없음(undefined) 또는 음수다.
 */
export function decideRuntimeCookieFeed(input: {
  explicitImport: boolean;
  /** 전용 브라우저에 같은 (domain, name, path) 쿠키가 없으면 null. */
  existingExpires: number | null;
  incomingExpires: number | undefined;
}): "feed" | "keep" {
  // existingExpires === null means the runtime holds no such cookie; a session cookie there arrives as -1.
  return decideCookieRefresh({
    hasExisting: input.existingExpires !== null,
    explicitImport: input.explicitImport,
    incomingExpires: input.incomingExpires,
    existingExpires: input.existingExpires,
    gap: COOKIE_EXPIRY_TOLERANCE_SECONDS,
  }) === "keep" ? "keep" : "feed";
}

/**
 * 한 번에 넣을 쿠키를 **로그인 묶음 단위로** 고른다(자동 갱신 전용 판정, 사용자가 누른 가져오기는
 * 원본이 전부 이긴다).
 *
 * ★오너 신고 "왜 자꾸 로그아웃되냐" (09-27~) — 실측 2026-09-29(오너 기기, 이름·도메인·시각만):
 *   전용 크롬의 .youtube.com 에는 __Secure-3PSID·3PAPISID·1PSIDTS·3PSIDTS·3PSIDCC 만 있고
 *   SID·HSID·SSID·APISID·SAPISID·__Secure-1PSID·1PAPISID·LOGIN_INFO 가 **없었다**. 평소 크롬(원본)에는
 *   전부 있다. 같은 저장소의 .google.com 은 __Secure-1PSID 가 21:27:30 발급, SID·HSID·PSIDTS 는
 *   21:45:18 투입 — 한 로그인의 쿠키가 두 세대로 섞여 있다. 자동화가 선 로그인 벽 9건은 전부
 *   youtube.com/signin → accounts.google.com accountchooser 였다(run_events 09-27~29).
 *   원인은 쿠키 **한 줄씩** 내리던 판정(decideRuntimeCookieFeed·decideNativeCookieWrite): 목적지에
 *   묶음 일부만 남아 있으면 "있는 줄은 지키고 없는 줄만 넣기" 가 되어 두 세션을 섞거나, 반쪽 묶음을
 *   "살아 있는 세션"으로 여겨 영영 채우지 않는다. 섞인·반쪽 로그인은 사이트가 로그인으로 받지 않는다.
 *
 * 규칙(로그인 쿠키 이름을 아는 묶음만; 모르는 사이트는 perCookie 그대로):
 *   - 원본에 그 묶음의 로그인 쿠키가 없으면 → 줄 단위 판정(옮길 로그인이 없다).
 *   - 목적지가 원본이 가진 로그인 쿠키 이름을 **모두** 갖고 있으면 → 묶음 전체를 지킨다(아무것도
 *     넣지 않는다). 목적지 쪽이 그 사이 회전한 살아 있는 세션일 수 있다 — 섞지 않는다.
 *   - 하나라도 빠졌으면 → 목적지에 로그인 흔적이 없을 때만 원본 묶음을 넣는다. 일부 로그인이나
 *     회전 쿠키가 남아 있으면 다른 계정과 섞이지 않도록 전체를 보존한다.
 *   - 온전히 있어도 **원본이 더 새것이면** 묶음 전체를 갱신한다(compareSessionGroupFreshness): 묶음 안에서
 *     양쪽에 모두 만료가 있는 같은 쿠키를 견줘, 원본이 더 늦게 만료하는 줄이 있고 목적지가 더 늦은 줄은
 *     하나도 없을 때만이다. 일부 줄만 바꾸지 않고 묶음을 통째로 넣는 원칙은 그대로다(부분 교체는 두 세대를
 *     섞는다). 목적지가 더 새것인 줄이 하나라도 있으면(원본 일부만 새것인 경합 포함) 지킨다 — 목적지가 그
 *     사이 회전시킨 세션을 되돌리지 않는다. 세션 쿠키(만료 없음)는 비교하지 않는다.
 *   - Refresh only the SAME login (compareSessionGroupIdentity). A later expiry means "issued more recently", not "the
 *     same account": if the owner signed into account B directly in the partition while the everyday browser holds
 *     account A, A's rotated cookies (PSIDTS ...) make A's group expire later everywhere and B's whole login would be
 *     replaced by A's. So the group is refreshed only when the cookies whose value is fixed per sign-in
 *     (login-wall.ts sessionCookieIdentityNamesFor: SID, __Secure-1PSID ..., never a rotating token) hold EQUAL values
 *     in the source and the destination. A different value is another login, and no evidence (the site's fixed
 *     cookies are unknown, or absent on one side) is unproven; both keep the destination.
 *     Trade-off: a genuine re-login in the everyday browser changes those fixed values too and reads as "another
 *     login", so the partition keeps its still-valid older login until the login-wall re-import (the targeted
 *     re-import of that site's domains) fires.
 * 묶음 = 로그인을 함께 발급하는 등록 가능 도메인들(youtube.com + google.com 은 한 묶음).
 */
export interface SessionGroupCookie {
  domain: string;
  name: string;
  path: string;
  /** 만료(초). 세션 쿠키·모르면 없음(null/undefined/≤0) — 묶음 신선도 비교에서 빠진다. */
  expires?: number | null;
  /**
   * The value, read only to tell whether two copies are the same login (compareSessionGroupIdentity). It is compared in
   * memory and never logged, returned or stored by this module. Absent/empty = no evidence.
   */
  value?: string | null;
}

export type SessionGroupFreshness = "source-fresher" | "destination-fresher" | "conflict" | "same-or-unknown";

/**
 * 로그인 묶음 하나의 신선도. incoming 은 그 묶음에 속한 원본 쿠키만 준다.
 * 같은 (호스트, 이름, 경로)를 양쪽에서 찾아 만료가 모두 있는 것만 견준다(isSourceCookieFresher 와 같은 규칙).
 *   - source-fresher: 원본이 더 늦은 줄이 있고, 목적지가 더 늦은 줄은 없다 → 묶음 갱신.
 *   - destination-fresher / conflict: 목적지가 더 늦은 줄이 있다(원본도 더 늦은 줄이 있으면 conflict) → 지킨다.
 *   - same-or-unknown: 같거나 비교할 줄이 없다 → 지킨다.
 */
export function compareSessionGroupFreshness(
  incoming: readonly SessionGroupCookie[],
  existing: readonly SessionGroupCookie[],
): SessionGroupFreshness {
  const host = (value: string) => value.replace(/^\./u, "").toLowerCase();
  const key = (cookie: SessionGroupCookie) => `${host(cookie.domain)}\u0000${cookie.name}\u0000${cookie.path}`;
  // 목적지에 같은 줄이 둘이면(호스트 전용/도메인 쿠키) 더 늦은 쪽으로 견줘 되돌림을 막는다.
  const destination = new Map<string, number>();
  for (const cookie of existing) {
    const expires = persistentCookieExpiry(cookie.expires);
    if (expires === null) continue;
    destination.set(key(cookie), Math.max(destination.get(key(cookie)) ?? 0, expires));
  }
  let sourceFresher = 0;
  let destinationFresher = 0;
  for (const cookie of incoming) {
    const incomingExpires = persistentCookieExpiry(cookie.expires);
    const existingExpires = destination.get(key(cookie));
    if (incomingExpires === null || existingExpires === undefined) continue;
    if (isSourceCookieFresher(incomingExpires, existingExpires, COOKIE_EXPIRY_TOLERANCE_SECONDS)) sourceFresher += 1;
    else if (isSourceCookieFresher(existingExpires, incomingExpires, COOKIE_EXPIRY_TOLERANCE_SECONDS)) destinationFresher += 1;
  }
  if (destinationFresher > 0) return sourceFresher > 0 ? "conflict" : "destination-fresher";
  return sourceFresher > 0 ? "source-fresher" : "same-or-unknown";
}

export type SessionGroupIdentity = "same" | "different" | "unproven";

/**
 * Do the source and the destination hold the SAME sign-in of one login group? incoming and existing are the group's
 * cookies on each side. Only the cookies whose value is fixed per sign-in count (identityNamesFor, login-wall.ts);
 * a rotating token never takes part, because a rotated value is expected to differ.
 *   - same: at least one such cookie sits on both sides (same host, name, path) and EVERY one that does holds the
 *     same value. This is the evidence that the source is a later copy of the destination's own login.
 *   - different: a fixed cookie held on both sides has another value. Another sign-in (another account, or a fresh
 *     login), whatever the expiry says.
 *   - unproven: no fixed cookie is held on both sides (unknown site, absent, or no value), so nothing says it is the
 *     same login.
 * Values are compared in memory only; nothing is returned, logged or stored.
 */
export function compareSessionGroupIdentity(
  incoming: readonly SessionGroupCookie[],
  existing: readonly SessionGroupCookie[],
  identityNamesFor: (host: string) => readonly string[] | null,
): SessionGroupIdentity {
  const host = (value: string) => value.replace(/^\./u, "").toLowerCase();
  const key = (cookie: SessionGroupCookie) => `${host(cookie.domain)}\u0000${cookie.name}\u0000${cookie.path}`;
  // A host-only and a domain cookie of one name may both exist; a pair is the same only when the value sets are equal.
  const valuesOf = (cookies: readonly SessionGroupCookie[]) => {
    const byKey = new Map<string, Set<string>>();
    for (const cookie of cookies) {
      if (!identityNamesFor(host(cookie.domain))?.includes(cookie.name)) continue;
      if (typeof cookie.value !== "string" || cookie.value === "") continue;
      const values = byKey.get(key(cookie)) ?? new Set<string>();
      values.add(cookie.value);
      byKey.set(key(cookie), values);
    }
    return byKey;
  };
  const destination = valuesOf(existing);
  let same = 0;
  let different = 0;
  for (const [cookieKey, sourceValues] of valuesOf(incoming)) {
    const held = destination.get(cookieKey);
    if (!held) continue;
    if (held.size === sourceValues.size && [...sourceValues].every((value) => held.has(value))) same += 1;
    else different += 1;
  }
  if (different > 0) return "different";
  return same > 0 ? "same" : "unproven";
}

/**
 * The counts of one plan's freshness verdicts for a log line, or null when the plan decided nothing worth a line.
 * Counts only: a group, domain, cookie name or value never reaches a log through here.
 */
export function groupFreshnessLogCounts(plan: {
  refreshedGroups: readonly string[];
  conflictGroups: readonly string[];
  otherLoginGroups: readonly string[];
  unprovenLoginGroups: readonly string[];
}): { refreshedGroups: number; conflictKeptGroups: number; otherLoginKeptGroups: number; unprovenLoginKeptGroups: number } | null {
  const counts = {
    refreshedGroups: plan.refreshedGroups.length,
    conflictKeptGroups: plan.conflictGroups.length,
    otherLoginKeptGroups: plan.otherLoginGroups.length,
    unprovenLoginKeptGroups: plan.unprovenLoginGroups.length,
  };
  return Object.values(counts).some((count) => count > 0) ? counts : null;
}

export function planSessionGroupFeed<T extends SessionGroupCookie>(input: {
  explicitImport: boolean;
  incoming: readonly T[];
  /** 목적지에 지금 있는(만료 안 된) 쿠키. */
  existing: readonly SessionGroupCookie[];
  /** 쿠키 호스트 → 로그인 묶음 키와 그 호스트의 사이트(등록 가능 도메인). 로그인 쿠키 이름을 모르는 사이트는 null. */
  groupOf: (host: string) => { group: string; site: string } | null;
  /** 쿠키 호스트 → 그 사이트의 로그인 쿠키 이름들(모르면 null). */
  sessionNamesFor: (host: string) => readonly string[] | null;
  /** 묶음 밖(모르는 사이트)이거나 원본에 로그인이 없는 묶음의 줄 단위 판정. */
  perCookie: (cookie: T) => "feed" | "keep";
  /**
   * 묶음 신선도를 견줄 때 쓸 원본 쿠키 전체. 호출이 등록 가능 도메인별로 쪼개져 들어오면(google.com 한 번,
   * youtube.com 한 번) 한 묶음이 도메인마다 따로 판정돼 한쪽만 갱신되는 두 세대가 생긴다 — 같은 묶음의 다른
   * 도메인 줄까지 함께 보고 한 번에 판정한다. 없으면 incoming 만 본다. 무엇을 넣을지는 여전히 incoming 만이다.
   */
  freshnessContext?: readonly SessionGroupCookie[];
  /**
   * Host -> the names of that site's cookies whose value is fixed per sign-in (login-wall.ts sessionCookieIdentityNamesFor),
   * null when unknown. A complete group is refreshed only when these hold the same values on both sides. Left out, no
   * site has any, so no complete group is ever refreshed: leaving it out can only suppress a refresh, never swap a login.
   */
  identityNamesFor?: (host: string) => readonly string[] | null;
  /** Partial sign-in/companion cookies whose presence prevents automatic replacement. */
  protectionNamesFor?: (host: string) => readonly string[] | null;
}): {
  feed: T[]; keptGroups: string[]; replacedGroups: string[]; refreshedGroups: string[]; conflictGroups: string[];
  /** Groups whose refresh was refused because the fixed sign-in cookies hold other values (another login). */
  otherLoginGroups: string[];
  /** Groups whose refresh was refused because nothing evidences the same login. */
  unprovenLoginGroups: string[];
} {
  if (input.explicitImport) {
    return { feed: [...input.incoming], keptGroups: [], replacedGroups: [], refreshedGroups: [], conflictGroups: [], otherLoginGroups: [], unprovenLoginGroups: [] };
  }
  const host = (value: string) => value.replace(/^\./u, "").toLowerCase();
  const loginNames = (cookies: readonly SessionGroupCookie[], group: string) => {
    const names = new Set<string>();
    for (const cookie of cookies) {
      const h = host(cookie.domain);
      const at = input.groupOf(h);
      if (at?.group !== group) continue;
      const known = input.sessionNamesFor(h);
      if (known?.includes(cookie.name)) names.add(`${at.site}\u0000${cookie.name}`);
    }
    return names;
  };
  const inGroup = (cookies: readonly SessionGroupCookie[], group: string) => cookies.filter((cookie) => input.groupOf(host(cookie.domain))?.group === group);
  const decision = new Map<string, "keep-group" | "replace-group" | "refresh-group" | "per-cookie">();
  const conflicts = new Set<string>();
  const otherLogin = new Set<string>();
  const unprovenLogin = new Set<string>();
  const identityNamesFor = input.identityNamesFor ?? (() => null);
  for (const cookie of input.incoming) {
    const group = input.groupOf(host(cookie.domain))?.group;
    if (!group || decision.has(group)) continue;
    const source = loginNames(input.freshnessContext ?? input.incoming, group);
    const scopeAll = inGroup(input.freshnessContext ?? input.incoming, group), heldAll = inGroup(input.existing, group);
    const protectedNamesFor = input.protectionNamesFor ?? input.sessionNamesFor;
    const hasProtectedLogin = heldAll.some((row) => protectedNamesFor(host(row.domain))?.includes(row.name));
    if (source.size === 0) {
      decision.set(group, hasProtectedLogin ? "keep-group" : "per-cookie");
      continue;
    }
    const destination = loginNames(input.existing, group);
    if (![...source].every((name) => destination.has(name))) {
      // A partial login can still belong to another account; companion cookies are not
      // evidence of logout. Only a destination with no protected sign-in may be seeded.
      if (hasProtectedLogin) {
        const identity = compareSessionGroupIdentity(scopeAll, heldAll, identityNamesFor);
        if (identity === "different") otherLogin.add(group);
        else if (identity === "unproven") unprovenLogin.add(group);
        decision.set(group, "keep-group"); continue;
      }
      decision.set(group, "replace-group"); continue;
    }
    // A complete group is refreshed whole when the source is fresher AND is the same login; the destination is
    // kept when it is fresher on any row or when the source may be another sign-in.
    const scope = inGroup(input.freshnessContext ?? input.incoming, group);
    const held = inGroup(input.existing, group);
    const freshness = compareSessionGroupFreshness(scope, held);
    if (freshness === "conflict") conflicts.add(group);
    if (freshness !== "source-fresher") { decision.set(group, "keep-group"); continue; }
    const identity = compareSessionGroupIdentity(scope, held, identityNamesFor);
    if (identity === "same") { decision.set(group, "refresh-group"); continue; }
    (identity === "different" ? otherLogin : unprovenLogin).add(group);
    decision.set(group, "keep-group");
  }
  const feed: T[] = [];
  for (const cookie of input.incoming) {
    const group = input.groupOf(host(cookie.domain))?.group;
    const verdict = group ? decision.get(group) : undefined;
    if (verdict === "keep-group") continue;
    if (verdict === "replace-group" || verdict === "refresh-group") { feed.push(cookie); continue; }
    if (input.perCookie(cookie) === "feed") feed.push(cookie);
  }
  const groups = (wanted: string) => [...decision].filter(([, verdict]) => verdict === wanted).map(([group]) => group).sort();
  return {
    feed,
    keptGroups: groups("keep-group"),
    replacedGroups: groups("replace-group"),
    refreshedGroups: groups("refresh-group"),
    conflictGroups: [...conflicts].sort(),
    otherLoginGroups: [...otherLogin].sort(),
    unprovenLoginGroups: [...unprovenLogin].sort(),
  };
}
