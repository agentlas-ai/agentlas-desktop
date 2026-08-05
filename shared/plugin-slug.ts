// 플러그인 식별자 정규화 — Hub와 Desktop 카탈로그가 **같은 도구를 다른 이름으로** 부른다.
//
// 실측(2026-08-05): 겹치는 9개 중 3개가 접미사만 다르다.
//   hub:github-mcp        ↔ desktop:github
//   hub:playwright-mcp    ↔ desktop:playwright
//   hub:brave-search-mcp  ↔ desktop:brave-search
//
// 어느 쪽 데이터를 바꿔 이름을 맞추는 것은 안전하지 않다. Desktop 카탈로그 id를 바꾸면
// 이미 설치된 행의 catalog_id가 고아가 되고, Hub slug를 바꾸면 installCli/detailUrl 같은
// 바깥 참조가 깨진다. 그래서 저장된 값은 그대로 두고 **비교할 때만** 정규화한다.
//
// 이 규칙은 표시용이다. 실제 중복 설치 방지는 slug가 아니라 연결 정보(url 또는
// command+args)로 판정한다(hub-plugin-bridge의 findEquivalentServer). 이름이 같아도
// 다른 서버일 수 있고, 이름이 달라도 같은 서버일 수 있기 때문이다.

/** 흔한 MCP 접두/접미사를 떼고 비교용 키를 만든다. */
export function normalizePluginSlug(slug: string): string {
  return String(slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/^mcp[-_]/, "")
    .replace(/[-_]mcp$/, "")
    .replace(/[-_]server$/, "");
}

/** 두 식별자가 같은 도구를 가리키는가(표시 판정). */
export function isSamePluginSlug(a: string, b: string): boolean {
  const left = normalizePluginSlug(a);
  const right = normalizePluginSlug(b);
  return left.length > 0 && left === right;
}

/**
 * 설치된 MCP 서버가 이 Hub 플러그인 slug에 해당하는가.
 *
 * 두 경로를 모두 본다:
 *  · Desktop 카탈로그로 설치된 행 — catalogId가 카탈로그 id를 담는다.
 *  · Hub 브리지가 등록한 행 — 이름이 `<slug>:<서버이름>` 형식이다.
 */
export function installedServerMatchesPluginSlug(
  server: { catalogId?: string | null; name?: string | null },
  pluginSlug: string,
): boolean {
  if (server.catalogId && isSamePluginSlug(server.catalogId, pluginSlug)) return true;
  const name = String(server.name ?? "");
  const bridgePrefix = name.includes(":") ? name.slice(0, name.indexOf(":")) : "";
  return bridgePrefix.length > 0 && isSamePluginSlug(bridgePrefix, pluginSlug);
}
