// 공개 Hub 카드 중 "호출 전용"(소스 지시문 비공개) 에이전트 판별.
// 이런 에이전트는 로컬 프롬프트로 실행하면 안 되고, 실행은 항상 Hub borrow 경로
// (OrchestrationTarget {source:"hub", slug} → borrowed-task-force)로 가야 한다.
// 판별 근거는 별도 플래그가 아니라 사실 그 자체다: hub 자산인데 로컬 지시문이 비어 있다.
export function isCallOnlyHubAgent(agent: { assetSource?: string | null; systemPrompt?: string | null }): boolean {
  return agent.assetSource === "hub" && !(agent.systemPrompt ?? "").trim();
}
