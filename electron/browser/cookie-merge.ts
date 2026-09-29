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

/** Chrome 은 만료·갱신 시각을 마이크로초 정수로 둔다. 있는 것 중 큰 값이 신선도다. */
export function cookieFreshness(row: Record<string, unknown> | null | undefined): number {
  if (!row) return 0;
  const expires = Number(row.expires_utc ?? (row as { expiresUtc?: unknown }).expiresUtc ?? 0);
  const updated = Number(row.last_update_utc ?? (row as { updatedUtc?: unknown }).updatedUtc ?? 0);
  return Math.max(Number.isFinite(expires) ? expires : 0, Number.isFinite(updated) ? updated : 0);
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
  return input.incomingFreshness > input.existingFreshness ? "replace" : "keep";
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
 * 자동 갱신은 이미 살아 있는 세션을 덮지 않는다(사용자가 그 창에서 직접 로그인했을 수 있다).
 * 그러나 **사용자가 방금 "가져오기"를 누른 경우**에는 가져온 값이 이겨야 한다 — 그러지 않으면
 * 낡은 쿠키가 남아 "가져왔는데 여전히 로그아웃"이 된다.
 */
export function decideNativeCookieWrite(input: {
  hasExisting: boolean;
  explicitImport: boolean;
}): "write" | "preserve" {
  if (!input.hasExisting) return "write";
  return input.explicitImport ? "write" : "preserve";
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
  if (input.explicitImport) return "feed";
  if (input.existingExpires === null) return "feed";
  const incoming = typeof input.incomingExpires === "number" && input.incomingExpires > 0 ? input.incomingExpires : 0;
  const existing = input.existingExpires > 0 ? input.existingExpires : 0;
  // 세션 쿠키(0)끼리이거나 전용 쪽이 같거나 더 새것이면 살아 있는 쪽을 지킨다.
  return incoming > existing ? "feed" : "keep";
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
 *   - 하나라도 빠졌으면(반쪽·없음) → 원본의 그 묶음 쿠키를 **전부** 넣는다(한 세대로 맞춘다).
 * 묶음 = 로그인을 함께 발급하는 등록 가능 도메인들(youtube.com + google.com 은 한 묶음).
 */
export interface SessionGroupCookie {
  domain: string;
  name: string;
  path: string;
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
}): { feed: T[]; keptGroups: string[]; replacedGroups: string[] } {
  if (input.explicitImport) return { feed: [...input.incoming], keptGroups: [], replacedGroups: [] };
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
  const decision = new Map<string, "keep-group" | "replace-group" | "per-cookie">();
  for (const cookie of input.incoming) {
    const group = input.groupOf(host(cookie.domain))?.group;
    if (!group || decision.has(group)) continue;
    const source = loginNames(input.incoming, group);
    if (source.size === 0) { decision.set(group, "per-cookie"); continue; }
    const destination = loginNames(input.existing, group);
    decision.set(group, [...source].every((name) => destination.has(name)) ? "keep-group" : "replace-group");
  }
  const feed: T[] = [];
  for (const cookie of input.incoming) {
    const group = input.groupOf(host(cookie.domain))?.group;
    const verdict = group ? decision.get(group) : undefined;
    if (verdict === "keep-group") continue;
    if (verdict === "replace-group") { feed.push(cookie); continue; }
    if (input.perCookie(cookie) === "feed") feed.push(cookie);
  }
  const groups = (wanted: string) => [...decision].filter(([, verdict]) => verdict === wanted).map(([group]) => group).sort();
  return { feed, keptGroups: groups("keep-group"), replacedGroups: groups("replace-group") };
}
