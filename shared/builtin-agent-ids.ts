/**
 * 앱에 구워진 에이전트의 신원 — **한 곳에서만 적는다.**
 *
 * 이 값들은 `installed_agents.id` 이고, 기억·경험·상주 원장이 전부 이것으로 조회한다.
 * 그런데 같은 리터럴이 세 파일에 각각 적혀 있었다(`one/memory-map.ts`,
 * `memory/one-import.ts`, `runtime/agent-residency.ts`). 한 곳만 고치면 나머지가
 * 조용히 어긋나는데, 어긋난 결과는 오류가 아니라 **빈 조회**로 나타난다 —
 * `memory-map.ts:253` 의 catch 가 실패를 삼켜 "기억이 없다"로 보이게 만든다.
 *
 * 값을 바꾸는 것은 마이그레이션이다. 여기서 바꾸고 끝날 일이 아니다
 * (오너 결정: 빌트인 slug 는 영구 DB id 로 승격되므로 임의로 바꾸지 않는다).
 */
export const BUILTIN_ONE_AGENT_ID = "builtin-agentlas-one";
export const BUILTIN_ORCHESTRATOR_AGENT_ID = "builtin-agentlas-orchestrator";
