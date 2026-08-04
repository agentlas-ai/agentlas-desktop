// ⚠️ 생성된 파일입니다. 손으로 고치지 마세요 — 다음 생성에서 사라집니다.
//
// 정본: shared/graph-registry/*.json
// 생성: node scripts/gen-graph-registry.cjs
// 검사: node scripts/gen-graph-registry.cjs --check  (게이트가 이걸 부릅니다)
//
// 왜 생성하는가 (06 §2.1 WP-R4 "사본 금지"):
//   같은 어휘를 두 곳에 손으로 쓰면 반드시 갈라진다. 이 저장소는 그 사고를
//   여러 번 겪었다 — 스펙은 정본대로인데 코드는 자기 이름을 쓰고 있었다.
//   선언은 한 곳(레지스트리)이고 코드는 여기서 나온다.

/** 이 계층의 네임스페이스. 미지 major는 fail-closed. */
export const GRAPH_WIRE = "graph/1" as const;

/** 제품이 실제로 내는 오류 코드 전부. 여기 없는 코드를 내면 적합성 게이트가 실패한다. */
export const GRAPH_ERROR_CODES = [
  "APPROVAL_REJECTED",
  "APPROVAL_REQUIRED",
  "ARCHITECT_NO_REQUEST",
  "ARCHITECT_UNAVAILABLE",
  "AUTOMATION_NOT_CONNECTED",
  "BUDGET_EXHAUSTED",
  "CREATE_INPUT_INVALID",
  "EDGE_CONDITION_UNRESOLVED",
  "EVAL_INCOMPLETE",
  "EVAL_UNAVAILABLE",
  "INTERVIEW_BLUEPRINT_INVALID",
  "INTERVIEW_MODEL_UNAVAILABLE",
  "INTERVIEW_STATE_INVALID",
  "LOOP_BOUND_INVALID",
  "LOOP_BOUND_UNDECLARED",
  "LOOP_LIMIT_REACHED",
  "LOOP_WITHOUT_EXIT",
  "MUTATION_UNVERIFIED",
  "NODE_FAILED",
  "NODE_INPUT_MISSING",
  "NODE_NEVER_REACHED",
  "NODE_NO_RESULT",
  "NODE_TIMEOUT",
  "NODE_TYPE_UNSUPPORTED",
  "NO_MATCHING_EDGE",
  "PATCH_NO_GRAPH",
  "REDUCER_MERGE_CONFLICT",
  "REDUCER_WRITE_CONFLICT",
  "RESUME_CONFLICT",
  "SWAP_CAPABILITY_MISMATCH",
  "SWAP_HUB_RELEASE_UNPINNED",
  "SWAP_NODE_NOT_FOUND",
  "SWAP_NOT_AGENT_NODE",
  "SWAP_NO_MATCH",
  "SWAP_UNKNOWN_PROVIDER",
  "TOOL_NODE_UNATTACHED",
  "TOOL_NODE_UNCONFIGURED",
] as const;
export type GraphErrorCode = (typeof GRAPH_ERROR_CODES)[number];

/** 저널 종류. 06 §7 — 전부 uiKey 또는 no-ui를 갖는다. */
export const GRAPH_JOURNAL_KINDS = [
  "blob_externalized",
  "node_failed",
  "node_intent",
  "node_reserved",
  "node_retry",
  "node_routed",
  "node_settled",
  "resumed",
  "run_completed",
  "run_created",
  "run_failed",
  "run_validated",
  "suspended",
] as const;
export type GraphJournalKindGenerated = (typeof GRAPH_JOURNAL_KINDS)[number];

/** 노드 종류. 반복(loop)은 노드가 아니라 그래프의 성질이라 여기 없다. */
export const GRAPH_NODE_KINDS = [
  "action",
  "agent",
  "condition",
  "eval",
  "output",
  "tool",
  "transform",
  "trigger",
] as const;
export type GraphNodeKindGenerated = (typeof GRAPH_NODE_KINDS)[number];

/**
 * 오류 코드 → 화면 카드 매핑 **1벌** (06 §8.2).
 * 손으로 쓴 두 번째 매핑 표가 발견되면 게이트 실패다.
 */
export const GRAPH_ERROR_CARDS: Record<string, { cardKey: string; nextActions: string[] }> = {
  APPROVAL_REJECTED: { cardKey: "approval_rejected", nextActions: ["edit_graph"] },
  APPROVAL_REQUIRED: { cardKey: "approval_required", nextActions: ["approve", "reject"] },
  ARCHITECT_UNAVAILABLE: { cardKey: "architect_unavailable", nextActions: ["retry"] },
  AUTOMATION_NOT_CONNECTED: { cardKey: "not_connected", nextActions: ["open_connections"] },
  BLOB_UNRESOLVED: { cardKey: "blob_unresolved", nextActions: ["open_session"] },
  BUDGET_EXHAUSTED: { cardKey: "budget_exceeded", nextActions: ["raise_budget", "open_session"] },
  EDGE_CONDITION_UNRESOLVED: { cardKey: "condition_unresolved", nextActions: ["edit_graph"] },
  EVAL_INCOMPLETE: { cardKey: "eval_incomplete", nextActions: ["edit_node"] },
  EVAL_UNAVAILABLE: { cardKey: "eval_unavailable", nextActions: ["rerun"] },
  INPUT_MAPPING_INVALID: { cardKey: "input_mapping_invalid", nextActions: ["edit_graph"] },
  INTERVIEW_MODEL_UNAVAILABLE: { cardKey: "interview_unavailable", nextActions: ["retry"] },
  LOOP_BOUND_INVALID: { cardKey: "loop_bound_missing", nextActions: ["set_loop_bound"] },
  LOOP_BOUND_UNDECLARED: { cardKey: "loop_bound_missing", nextActions: ["set_loop_bound"] },
  LOOP_LIMIT_REACHED: { cardKey: "loop_limit", nextActions: ["raise_loop_bound", "open_session"] },
  LOOP_WITHOUT_EXIT: { cardKey: "loop_no_exit", nextActions: ["edit_graph"] },
  MUTATION_UNVERIFIED: { cardKey: "mutation_unverified", nextActions: ["reconcile_nodes"] },
  NODE_FAILED: { cardKey: "node_failed", nextActions: ["open_session", "rerun"] },
  NODE_INPUT_MISSING: { cardKey: "node_input_missing", nextActions: ["edit_graph"] },
  NODE_NEVER_REACHED: { cardKey: "node_never_reached", nextActions: ["edit_graph"] },
  NODE_NO_RESULT: { cardKey: "node_no_result", nextActions: ["edit_node_prompt", "rerun"] },
  NODE_TIMEOUT: { cardKey: "node_timeout", nextActions: ["rerun", "raise_timeout"] },
  NO_MATCHING_EDGE: { cardKey: "no_matching_edge", nextActions: ["edit_graph"] },
  PORT_SCHEMA_VIOLATION: { cardKey: "port_schema_violation", nextActions: ["edit_graph"] },
  REDUCER_MERGE_CONFLICT: { cardKey: "reducer_conflict", nextActions: ["change_reducer", "add_transform"] },
  REDUCER_WRITE_CONFLICT: { cardKey: "reducer_conflict", nextActions: ["rename_output", "use_append"] },
  RESUME_CONFLICT: { cardKey: "resume_conflict", nextActions: ["reload"] },
  SCHEMA_UNSUPPORTED_MAJOR: { cardKey: "update_required", nextActions: ["update_app"] },
  TOOL_NODE_UNATTACHED: { cardKey: "tool_node_unattached", nextActions: ["edit_graph"] },
  TOOL_NODE_UNCONFIGURED: { cardKey: "tool_node_unconfigured", nextActions: ["edit_node"] },
};

/**
 * 카드 어휘가 없는 코드 — **원문 그대로** 노출한다(제목=코드, 본문=사유).
 * 조용한 삼킴 금지: 매핑이 없다고 오류를 안 보여주는 것이 가장 나쁘다.
 */
export const GRAPH_VERBATIM_CODES = [
  "ARCHITECT_NO_REQUEST",
  "CONFORMANCE_GATE_FAILED",
  "CREATE_INPUT_INVALID",
  "INTERVIEW_BLUEPRINT_INVALID",
  "INTERVIEW_STATE_INVALID",
  "NODE_TYPE_UNSUPPORTED",
  "PATCH_NO_GRAPH",
  "PATH_ROOT_UNKNOWN",
  "SWAP_CAPABILITY_MISMATCH",
  "SWAP_HUB_RELEASE_UNPINNED",
  "SWAP_NODE_NOT_FOUND",
  "SWAP_NOT_AGENT_NODE",
  "SWAP_NO_MATCH",
  "SWAP_UNKNOWN_PROVIDER",
  "WIRE_KIND_UNKNOWN",
] as const;

/**
 * 필드 등급 (06 §2.3). 모르는 값을 만났을 때 어떻게 할지가 여기서 나온다:
 *   critical   → 거절 + 코드 (fail-closed)
 *   degradable → 그 항목만 강등, 나머지는 정상 처리
 *   extension  → must-ignore 하되 버리지 말고 통과
 */
export const GRAPH_FIELD_GRADES: Record<string, "critical" | "degradable" | "extension"> = {
  "$blob": "critical",
  "approval": "critical",
  "catalog": "critical",
  "criteria": "critical",
  "effect": "critical",
  "ext": "extension",
  "from": "critical",
  "id": "critical",
  "idempotencyKey": "critical",
  "label": "degradable",
  "maxIterations": "critical",
  "maxTokens": "degradable",
  "mode": "critical",
  "needs": "critical",
  "op": "critical",
  "pattern": "degradable",
  "produces": "degradable",
  "prompt": "critical",
  "reducer": "critical",
  "ref": "critical",
  "repeatOn": "critical",
  "retries": "critical",
  "runtime": "degradable",
  "sourceHandle": "critical",
  "subject": "critical",
  "targetType": "critical",
  "targetVersion": "critical",
  "template": "degradable",
  "text": "degradable",
  "timeoutSeconds": "degradable",
  "to": "critical",
  "type": "critical",
  "value": "degradable",
  "var": "critical",
  "wire": "critical",
};

/** 이 코드를 사람에게 어떻게 보여줄지. 매핑이 없으면 원문 노출이 정답이다. */
export function graphErrorPresentation(code: string): {
  cardKey: string | null;
  nextActions: string[];
  verbatim: boolean;
} {
  const mapped = GRAPH_ERROR_CARDS[code];
  if (mapped) return { cardKey: mapped.cardKey, nextActions: mapped.nextActions, verbatim: false };
  return { cardKey: null, nextActions: [], verbatim: true };
}
