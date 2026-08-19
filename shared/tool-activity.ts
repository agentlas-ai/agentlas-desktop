// "이 도구 호출이 바깥 세상을 실제로 건드린 일인가"를 한 곳에서 판단한다.
//
// 왜 정본이 필요한가 (2026-08-19 실측):
// X 자동화 실행이 `ok` 로 끝났고 판정은 "계획한 답글 3건을 모두 게시했고, **실제 도구 활동이
// 그 주장을 뒷받침한다**"고 적었다. 그런데 X 에는 아무것도 올라가지 않았고, 그 실행이 남긴
// 도구 이벤트는 정확히 6건 — 전부 Agentlas 자신의 플러그인 조회였다:
//   Agentlas Plugins · universe / auto-select / Hub bridge (각 2회)
// 브라우저 조작은 0건. 즉 "도구를 썼으니 일했다"는 근거가 **제품 자신의 예비 조회**로 충족돼,
// 거짓 성공을 오히려 보증해 줬다.
//
// 같은 규칙이 이미 두 곳에 손코딩돼 있었는데(run-graph 의 replay-safe 판정, invocation/service 의
// task 승격 판정) 정작 완주 판정만 그 지식을 못 봤다. 한 곳에서 판단하고 셋이 같이 쓴다.

/** 호스트가 실행 전에 스스로 부르는 조회들의 접두사. 사용자 작업이 아니다. */
const HOST_PREFLIGHT_PREFIX = "Agentlas Plugins";

/** 편성 감사용 읽기 전용 호출 — 바깥을 바꾸지 않는다. */
const READ_ONLY_WORKFORCE_TOOLS = /^workforce\.(?:search_candidates|validate_selection)\b/i;

/**
 * 이 도구 이름이 **호스트의 예비 조회**인가.
 * 참이면 "일이 실제로 일어났다"의 근거로 세면 안 된다.
 */
export function isHostPreflightTool(toolName: string | null | undefined): boolean {
  const name = String(toolName ?? "").trim();
  if (!name) return false;
  if (name.toLowerCase().startsWith(HOST_PREFLIGHT_PREFIX.toLowerCase())) return true;
  return READ_ONLY_WORKFORCE_TOOLS.test(name);
}

/**
 * 널리 쓰이는 **읽기 전용** 도구들. 부른 것이 이것뿐이면 바깥은 그대로다.
 *
 * 실측 2026-08-20: "요약을 파일로 저장" 단계를 가진 자동화가 `ok:true` 로 끝났는데
 * 파일은 만들어지지 않았다. 그 단계는 바깥을 바꾼다고 선언돼 있었고, 커널은 "도구를
 * 한 번이라도 불렀는가"만 봤다 — 그 실행이 부른 것은 웹 조회뿐이었다. 읽기만 하고
 * "저장했다"고 적은 답이 관측으로 보증받은 셈이다.
 *
 * ★모르는 이름은 **바꿨을 수 있는 것**으로 둔다. 여기 목록은 좁게 유지한다 —
 *   넓히면 진짜로 일한 실행을 거짓 실패로 만든다. 못 잡는 쪽이 오폭보다 낫다.
 */
const WELL_KNOWN_READ_ONLY_TOOLS = new Set([
  "read", "grep", "glob", "ls", "notebookread",
  "webfetch", "websearch", "todoread", "listmcpresources", "readmcpresource",
]);

/** 이 도구 호출이 바깥을 바꿨을 수 있는가. 모르면 "그렇다"(보수적). */
export function couldHaveChangedTheOutsideWorld(toolName: string | null | undefined): boolean {
  const name = String(toolName ?? "").trim();
  if (!name) return false;
  if (isHostPreflightTool(name)) return false;
  // MCP 도구는 `서버 · 도구` / `mcp__서버__도구` 처럼 접두사가 붙는다 — 마지막 조각으로 본다.
  const leaf = name.split(/__|·|\//).pop()?.trim().toLowerCase() ?? "";
  return !WELL_KNOWN_READ_ONLY_TOOLS.has(leaf) && !WELL_KNOWN_READ_ONLY_TOOLS.has(name.toLowerCase());
}

/**
 * 실행이 남긴 도구 이름들 중 **바깥을 건드렸을 수 있는 것만** 남긴다.
 * 이름이 없는 이벤트(상태 표시 등)도 근거가 아니므로 버린다 — 근거는 이름이 있어야 한다.
 */
export function externalToolNames(names: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    if (isHostPreflightTool(name)) continue;
    out.push(name);
  }
  return out;
}
