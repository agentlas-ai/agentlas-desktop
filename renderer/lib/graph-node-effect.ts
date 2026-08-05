// 커널(`shared/graph-node-protocol.ts`)의 기본 효과 규칙을 화면이 그대로 쓴다.
// 렌더러는 shared를 직접 import하지 않으므로 얇은 재노출만 둔다 — 규칙을 두 벌 쓰면
// 화면과 실행이 다른 노드를 보게 된다(실측: "조회"로 보이는데 시뮬레이션이 차단).
export { defaultNodeEffect } from "../../shared/graph-node-protocol";
