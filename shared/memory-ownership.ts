/**
 * 기억의 주인을 정하는 규칙 한 벌.
 *
 * ★오너 정본 2026-08-26
 *   Team   agentId = agt_team_…  — 팀이라는 사실이 id 안에 낙인으로 박힌다.
 *          orchestrator/HQ 는 에이전트가 아니다. 조직 구분 + 훅·규칙·루프일 뿐이고,
 *          조직 안에서 공유하는 기억은 개인 칸이 아니라 **팀 공유 칸**에 쌓인다.
 *   Single agent { agentId, agentId_version }
 *
 *   → 경험칩·자가진화·개인 기억은 **`agt_team_` 낙인이 없는 신원에만** 쌓인다.
 *     팀 자체에는 쌓지 않는다.
 *
 * ★왜 낙인을 id 안에 두는가
 *   모든 표면이 스키마를 읽지 않고 같은 답을 내게 하려고. 엔진(Python)이 발급하고
 *   여기(TS)와 웹이 같은 접두로 판정한다. 정본 상수는 엔진에도 같은 값으로 있다:
 *   `Agentlas-OS/agentlas_cloud/runtime.py` 의 `AGENT_ID_TEAM_MARKER` / `is_team_agent_id`.
 *   두 값이 어긋나면 같은 id 를 한쪽은 팀, 한쪽은 개인으로 읽는다 —
 *   `scripts/test-memory-ownership.cjs` 가 값으로 대조한다.
 *
 * ★이 파일이 푸는 실제 고장 (실측 2026-08-26)
 *   조직 노드에 설치된 에이전트가 없으면 `node.agentId ?? node.id` 가 **노드 id 를 그대로
 *   기억 주인**으로 삼았다. 그렇게 생긴 행은 정리기가 `getAgentById()` 로 주인을 찾다
 *   실패해 조용히 건너뛴다 — 쌓이기만 하고 영원히 정리되지 않는다.
 *   주인이 개별 에이전트가 아니면 팀 공유로 보내는 것이 옳다: 조직도가 바뀌면 그 노드는
 *   사라지지만, 그 자리에서 배운 것은 팀의 것으로 남아야 한다.
 */

/** 팀 신원 낙인. 엔진 `AGENT_ID_TEAM_MARKER` 와 같은 값이어야 한다. */
export const AGENT_ID_TEAM_MARKER = "agt_team_";

/** 이 신원이 개별 에이전트가 아니라 팀인가. */
export function isTeamAgentId(agentId: string | null | undefined): boolean {
  return String(agentId ?? "").trim().startsWith(AGENT_ID_TEAM_MARKER);
}

/**
 * 기억을 이 신원의 개인 칸에 쌓아도 되는가.
 * 팀 낙인이 있거나 신원 자체가 없으면 개인 칸이 없다.
 */
export function canOwnPersonalMemory(agentId: string | null | undefined): boolean {
  const id = String(agentId ?? "").trim();
  return id.length > 0 && !isTeamAgentId(id);
}

/**
 * 기억 주인으로 쓸 값. 개별 에이전트면 그 id, 아니면 `null`(= 팀 공유 칸).
 *
 * 회수와 저장이 **같은 함수**를 거쳐야 대칭이 맞는다. 저장만 팀 공유로 보내고 회수는
 * 노드 id 로 찾으면 방금 쓴 것을 못 읽는다.
 */
export function memoryOwnerAgentId(agentId: string | null | undefined): string | null {
  const id = String(agentId ?? "").trim();
  return canOwnPersonalMemory(id) ? id : null;
}

/** 개인 칸을 못 가지는 주인에게 향한 개인 기억을 팀 공유 칸으로 되돌린다. */
export function normalizeMemoryOwnership<S extends string>(
  scope: S,
  agentId: string | null | undefined,
  personalScope: S,
  sharedScope: S,
): { scope: S; agentId: string | null } {
  if (scope !== personalScope) return { scope, agentId: memoryOwnerAgentId(agentId) };
  const owner = memoryOwnerAgentId(agentId);
  if (owner) return { scope, agentId: owner };
  return { scope: sharedScope, agentId: null };
}
