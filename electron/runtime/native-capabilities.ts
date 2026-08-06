/**
 * 런타임이 **내장으로** 제공하는 graph capability — 사실의 목록(카탈로그)이지 케이스 분기가 아니다.
 *
 * graph-tool-binding의 PROVIDER_CATALOG와 같은 지위다: 제공자 목록에 실행 런타임을
 * 더한 것. capability 해소(requirementStatus)는 이 목록을 "연결된 제공자" 중 하나로
 * 열거한다 — 특정 MCP 하나에 capability를 고정하지 않기 위한 조각이다.
 *
 * 항목을 더할 때는 실측 근거를 적을 것. (셋 다 자체 웹 검색 도구를 내장한다 —
 * claude-code: WebSearch 도구 · codex: web search · gemini: GoogleSearch. 실측 2026-08-06.)
 */
export const RUNTIME_NATIVE_CAPABILITIES: Record<string, string[]> = {
  "claude-code": ["web.search"],
  codex: ["web.search"],
  gemini: ["web.search"],
};
