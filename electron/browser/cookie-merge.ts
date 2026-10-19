









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

/** Chrome 은 만료·갱신 시각을 마이크로초 정수로 둔다. 있는 것 중 큰 값이 신선도다. */
export function cookieFreshness(row: Record<string, unknown> | null | undefined): number {
  if (!row) return 0;
  const expires = Number(row.expires_utc ?? (row as { expiresUtc?: unknown }).expiresUtc ?? 0);
  const updated = Number(row.last_update_utc ?? (row as { updatedUtc?: unknown }).updatedUtc ?? 0);
  return Math.max(Number.isFinite(expires) ? expires : 0, Number.isFinite(updated) ? updated : 0);
}

/**













 */
export function isSourceCookieFresher(
  incoming: number | null | undefined,
  existing: number | null | undefined,
  gap = 0,
): boolean {
  const known = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return known(incoming) > known(existing) + gap;
}

/** 초 단위로 읽은 만료 시각을 "다르다"고 보는 최소 차이. 같은 쿠키의 옮김 반올림을 갱신으로 읽지 않는다. */
export const COOKIE_EXPIRY_TOLERANCE_SECONDS = 1;

/** 초 단위 만료 시각. 세션 쿠키(없음·0·음수)와 깨진 값은 null — 신선도를 비교할 수 없다. */
export function persistentCookieExpiry(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 한 쿠키 줄을 어떻게 쓸 것인가.
 *
 *  - 목적지에 없으면 넣는다(insert) — 다른 사이트·다른 이름의 쿠키는 서로를 지우지 않는다.
 *  - 목적지 암호문을 전용 런타임이 못 읽으면 교체한다(replace) — 못 읽는 줄을 "이미 있음"으로
 *    남기면 화면은 "연결됨"인데 로그인은 안 되는 상태가 영원히 굳는다.
 *  - 신선도를 비교할 칸이 아예 없는 저장소 형식이면 건드리지 않는다(keep).
 *  - 원본이 더 새것일 때만 교체한다(replace). 로그인 쿠키는 회전하므로 갱신이 곧 이전이다.
 */
export function decideCookieWrite(input: {
  hasExisting: boolean;
  destinationReadable: boolean;
  hasFreshnessColumns: boolean;
  incomingFreshness: number;
  existingFreshness: number;
}): CookieWriteAction {
  if (!input.hasExisting) return "insert";
  if (!input.destinationReadable) return "replace";
  if (!input.hasFreshnessColumns) return "keep";
  return isSourceCookieFresher(input.incomingFreshness, input.existingFreshness) ? "replace" : "keep";
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
 * 같은 isSourceCookieFresher 하나로 한다. 목적지가 같거나 더 새것이면 절대 덮지 않는다.
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
  if (!input.hasExisting) return "write";
  if (input.explicitImport) return "write";
  const incoming = persistentCookieExpiry(input.incomingExpires);
  const existing = persistentCookieExpiry(input.existingExpires);
  if (incoming === null || existing === null) return "preserve";
  return isSourceCookieFresher(incoming, existing, COOKIE_EXPIRY_TOLERANCE_SECONDS) ? "write" : "preserve";
}

/**










 */
export function decideRuntimeCookieFeed(input: {
  explicitImport: boolean;
  /** 전용 브라우저에 같은 (domain, name, path) 쿠키가 없으면 null. */
  existingExpires: number | null;
  incomingExpires: number | undefined;
}): "feed" | "keep" {
  if (input.explicitImport) return "feed";
  if (input.existingExpires === null) return "feed";
  // An existing session/unknown expiry cannot be ordered against a persistent source.
  const incoming = persistentCookieExpiry(input.incomingExpires);
  const existing = persistentCookieExpiry(input.existingExpires);
  if (incoming === null || existing === null) return "keep";
  return isSourceCookieFresher(incoming, existing, COOKIE_EXPIRY_TOLERANCE_SECONDS) ? "feed" : "keep";
}

/**
























 */
export interface SessionGroupCookie {
  domain: string;
  name: string;
  path: string;
  /** 만료(초). 세션 쿠키·모르면 없음(null/undefined/≤0) — 묶음 신선도 비교에서 빠진다. */
  expires?: number | null;
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
}): { feed: T[]; keptGroups: string[]; replacedGroups: string[]; refreshedGroups: string[]; conflictGroups: string[] } {
  if (input.explicitImport) return { feed: [...input.incoming], keptGroups: [], replacedGroups: [], refreshedGroups: [], conflictGroups: [] };
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
  for (const cookie of input.incoming) {
    const group = input.groupOf(host(cookie.domain))?.group;
    if (!group || decision.has(group)) continue;
    const source = loginNames(input.freshnessContext ?? input.incoming, group);
    if (source.size === 0) { decision.set(group, "per-cookie"); continue; }
    const destination = loginNames(input.existing, group);
    if (![...source].every((name) => destination.has(name))) { decision.set(group, "replace-group"); continue; }
    // 온전한 묶음도 원본이 더 새것이면 통째로 갱신한다. 목적지가 더 새것인 줄이 있으면 지킨다.
    const freshness = compareSessionGroupFreshness(inGroup(input.freshnessContext ?? input.incoming, group), inGroup(input.existing, group));
    if (freshness === "conflict") conflicts.add(group);
    decision.set(group, freshness === "source-fresher" ? "refresh-group" : "keep-group");
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
  };
}
