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
