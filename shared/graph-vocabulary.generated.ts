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
  "APPROVAL_TIMED_OUT",
  "ARCHITECT_NO_CHANGE",
  "ARCHITECT_NO_REQUEST",
  "ARCHITECT_OUTPUT_MALFORMED",
  "ARCHITECT_OUTPUT_TOO_LARGE",
  "ARCHITECT_OUTPUT_UNREADABLE",
  "ARCHITECT_UNAVAILABLE",
  "AUTOMATION_NOT_CONNECTED",
  "BUDGET_EXHAUSTED",
  "CODE_DEPENDENCY_MISSING",
  "CODE_NODE_EMPTY",
  "CODE_STEP_FAILED",
  "CREATE_INPUT_INVALID",
  "EDGE_CONDITION_UNRESOLVED",
  "EVAL_INCOMPLETE",
  "EVAL_STUCK",
  "EVAL_UNAVAILABLE",
  "INTERVIEW_MODEL_UNAVAILABLE",
  "INTERVIEW_OUTPUT_UNREADABLE",
  "INTERVIEW_REPEATED_QUESTIONS",
  "INTERVIEW_SELF_CORRECTION_EXHAUSTED",
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
  "OUTPUT_NODE_EMPTY",
  "PATCH_CODE_EMPTY",
  "PATCH_EDGE_CONFLICT",
  "PATCH_EDGE_DANGLING",
  "PATCH_EDGE_HANDLE_MISSING",
  "PATCH_EDGE_MISSING",
  "PATCH_EMPTY",
  "PATCH_LOOP_BOUND_MISSING",
  "PATCH_NODE_CONFLICT",
  "PATCH_NODE_MISSING",
  "PATCH_NO_GRAPH",
  "PATCH_OP_UNKNOWN",
  "REDUCER_MERGE_CONFLICT",
  "REDUCER_WRITE_CONFLICT",
  "RESUME_CONFLICT",
  "RUN_REQUEST_DISABLED",
  "RUN_REQUEST_INPUT_REQUIRED",
  "RUN_REQUEST_NOT_FOUND",
  "RUN_REQUEST_QUEUE_UNAVAILABLE",
  "RUN_REQUEST_REF_AMBIGUOUS",
  "RUN_REQUEST_REF_MISSING",
  "SUBGRAPH_DEPTH_EXCEEDED",
  "SUBGRAPH_FAILED",
  "SUBGRAPH_NOT_FOUND",
  "SUBGRAPH_NO_RESULT",
  "SUBGRAPH_SELF_CALL",
  "SWAP_CAPABILITY_MISMATCH",
  "SWAP_HUB_RELEASE_UNPINNED",
  "SWAP_NODE_NOT_FOUND",
  "SWAP_NOT_AGENT_NODE",
  "SWAP_NO_MATCH",
  "SWAP_UNKNOWN_PROVIDER",
  "TOOL_BROKER_CALL_UNREADABLE",
  "TOOL_BROKER_MUTATION_IN_SIMULATION",
  "TOOL_BROKER_PLAN_UNREADABLE",
  "TOOL_BROKER_TOOL_NOT_DECLARED",
  "TOOL_NODE_UNATTACHED",
  "TOOL_NODE_UNCONFIGURED",
  "TRANSFORM_MODE_UNKNOWN",
  "TRANSFORM_NODE_UNCONFIGURED",
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
  "code",
  "condition",
  "eval",
  "output",
  "subgraph",
  "tool",
  "transform",
  "trigger",
] as const;
export type GraphNodeKindGenerated = (typeof GRAPH_NODE_KINDS)[number];

/**
 * 블록별 화면 배치 — 팔레트·게이트가 이걸 읽는다. 손으로 쓴 두 번째 목록 금지.
 *   section: "flow"(팔레트에서 그대로 놓음) | "actions" | "inventory"(설치된 것 중 고름) | "none"
 *   placeable: 사람이 팔레트에서 놓을 수 있는가. false면 placeReason(사유)이 반드시 있다.
 */
export const GRAPH_BLOCK_UI = {
  "trigger": {
    "section": "none",
    "placeable": false,
    "placeReason": "그래프마다 하나뿐이고 처음 만들 때 함께 지어진다"
  },
  "agent": {
    "section": "inventory",
    "placeable": true
  },
  "eval": {
    "section": "flow",
    "placeable": true
  },
  "condition": {
    "section": "flow",
    "placeable": true
  },
  "transform": {
    "section": "flow",
    "placeable": true
  },
  "code": {
    "section": "flow",
    "placeable": true
  },
  "tool": {
    "section": "inventory",
    "placeable": true
  },
  "action": {
    "section": "actions",
    "placeable": true
  },
  "output": {
    "section": "flow",
    "placeable": true
  },
  "loop": {
    "section": "none",
    "placeable": false,
    "placeReason": "노드가 아니라 되돌아가는 연결의 성질이다 — 엣지를 이어서 만든다"
  },
  "subgraph": {
    "section": "flow",
    "placeable": true
  }
} as const;
export type GraphBlockUiKind = keyof typeof GRAPH_BLOCK_UI;

/**
 * 오류 코드 → 화면 카드 매핑 **1벌** (06 §8.2).
 * 손으로 쓴 두 번째 매핑 표가 발견되면 게이트 실패다.
 */
export const GRAPH_ERROR_CARDS: Record<string, { cardKey: string; nextActions: string[] }> = {
  APPROVAL_REJECTED: { cardKey: "approval_rejected", nextActions: ["edit_graph"] },
  APPROVAL_REQUIRED: { cardKey: "approval_required", nextActions: ["approve", "reject"] },
  APPROVAL_TIMED_OUT: { cardKey: "approval_timed_out", nextActions: ["approve", "reject", "edit_graph"] },
  ARCHITECT_UNAVAILABLE: { cardKey: "architect_unavailable", nextActions: ["retry"] },
  AUTOMATION_NOT_CONNECTED: { cardKey: "not_connected", nextActions: ["open_connections"] },
  BLOB_UNRESOLVED: { cardKey: "blob_unresolved", nextActions: ["open_session"] },
  BUDGET_EXHAUSTED: { cardKey: "budget_exceeded", nextActions: ["raise_budget", "open_session"] },
  EDGE_CONDITION_UNRESOLVED: { cardKey: "condition_unresolved", nextActions: ["edit_graph"] },
  EVAL_INCOMPLETE: { cardKey: "eval_incomplete", nextActions: ["edit_node"] },
  EVAL_UNAVAILABLE: { cardKey: "eval_unavailable", nextActions: ["rerun"] },
  INPUT_MAPPING_INVALID: { cardKey: "input_mapping_invalid", nextActions: ["edit_graph"] },
  INTERVIEW_MODEL_UNAVAILABLE: { cardKey: "interview_unavailable", nextActions: ["retry"] },
  INTERVIEW_OUTPUT_UNREADABLE: { cardKey: "interview_unreadable", nextActions: ["retry"] },
  INTERVIEW_REPEATED_QUESTIONS: { cardKey: "interview_repeated", nextActions: ["retry", "rephrase"] },
  INTERVIEW_SELF_CORRECTION_EXHAUSTED: { cardKey: "interview_stuck", nextActions: ["rephrase", "open_canvas"] },
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
  RUN_REQUEST_DISABLED: { cardKey: "run_request_disabled", nextActions: ["enable_automation"] },
  RUN_REQUEST_INPUT_REQUIRED: { cardKey: "run_request_input", nextActions: ["provide_input"] },
  SCHEMA_UNSUPPORTED_MAJOR: { cardKey: "update_required", nextActions: ["update_app"] },
  SUBGRAPH_DEPTH_EXCEEDED: { cardKey: "subgraph_depth", nextActions: ["edit_graph"] },
  SUBGRAPH_FAILED: { cardKey: "subgraph_failed", nextActions: ["open_inner_run", "rerun"] },
  SUBGRAPH_NOT_FOUND: { cardKey: "subgraph_not_found", nextActions: ["edit_node"] },
  SUBGRAPH_SELF_CALL: { cardKey: "subgraph_self", nextActions: ["edit_node"] },
  TOOL_NODE_UNATTACHED: { cardKey: "tool_node_unattached", nextActions: ["edit_graph"] },
  TOOL_NODE_UNCONFIGURED: { cardKey: "tool_node_unconfigured", nextActions: ["edit_node"] },
};

/**
 * 카드 어휘가 없는 코드 — **원문 그대로** 노출한다(제목=코드, 본문=사유).
 * 조용한 삼킴 금지: 매핑이 없다고 오류를 안 보여주는 것이 가장 나쁘다.
 */
export const GRAPH_VERBATIM_CODES = [
  "ARCHITECT_NO_CHANGE",
  "ARCHITECT_NO_REQUEST",
  "ARCHITECT_OUTPUT_MALFORMED",
  "ARCHITECT_OUTPUT_TOO_LARGE",
  "ARCHITECT_OUTPUT_UNREADABLE",
  "CODE_DEPENDENCY_MISSING",
  "CODE_NODE_EMPTY",
  "CODE_STEP_FAILED",
  "CONFORMANCE_GATE_FAILED",
  "CREATE_INPUT_INVALID",
  "EVAL_STUCK",
  "INTERVIEW_BLUEPRINT_INVALID",
  "INTERVIEW_STATE_INVALID",
  "NODE_TYPE_UNSUPPORTED",
  "OUTPUT_NODE_EMPTY",
  "PATCH_CODE_EMPTY",
  "PATCH_EDGE_CONFLICT",
  "PATCH_EDGE_DANGLING",
  "PATCH_EDGE_HANDLE_MISSING",
  "PATCH_EDGE_MISSING",
  "PATCH_EMPTY",
  "PATCH_LOOP_BOUND_MISSING",
  "PATCH_NODE_CONFLICT",
  "PATCH_NODE_MISSING",
  "PATCH_NO_GRAPH",
  "PATCH_OP_UNKNOWN",
  "PATH_ROOT_UNKNOWN",
  "RUN_REQUEST_NOT_FOUND",
  "RUN_REQUEST_QUEUE_UNAVAILABLE",
  "RUN_REQUEST_REF_AMBIGUOUS",
  "RUN_REQUEST_REF_MISSING",
  "SUBGRAPH_NO_RESULT",
  "SWAP_CAPABILITY_MISMATCH",
  "SWAP_HUB_RELEASE_UNPINNED",
  "SWAP_NODE_NOT_FOUND",
  "SWAP_NOT_AGENT_NODE",
  "SWAP_NO_MATCH",
  "SWAP_UNKNOWN_PROVIDER",
  "TOOL_BROKER_CALL_UNREADABLE",
  "TOOL_BROKER_MUTATION_IN_SIMULATION",
  "TOOL_BROKER_PLAN_UNREADABLE",
  "TOOL_BROKER_TOOL_NOT_DECLARED",
  "TRANSFORM_MODE_UNKNOWN",
  "TRANSFORM_NODE_UNCONFIGURED",
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
  "approvalWaitHours": "degradable",
  "catalog": "critical",
  "code": "critical",
  "codeLang": "degradable",
  "consumes": "degradable",
  "criteria": "critical",
  "effect": "critical",
  "evidence": "degradable",
  "ext": "extension",
  "from": "critical",
  "graphRef": "critical",
  "id": "critical",
  "idempotencyKey": "critical",
  "input": "critical",
  "items": "degradable",
  "kind": "critical",
  "label": "degradable",
  "maxIterations": "critical",
  "maxTokens": "degradable",
  "mode": "critical",
  "needs": "critical",
  "note": "degradable",
  "op": "critical",
  "packages": "degradable",
  "pattern": "degradable",
  "produces": "degradable",
  "prompt": "critical",
  "promptLabel": "degradable",
  "recommendQuery": "degradable",
  "reducer": "critical",
  "ref": "critical",
  "repeatOn": "critical",
  "retries": "critical",
  "role": "degradable",
  "roleEn": "degradable",
  "runtime": "critical",
  "scheduleSpec": "critical",
  "sourceHandle": "critical",
  "stability": "degradable",
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
  "waitForResult": "critical",
  "wire": "critical",
};

/**
 * ★모르는 값을 만났을 때 **그 항목만** 강등한다 (06 §2.3 degradable / §2.5).
 *
 * 이 함수가 있는 이유: 이 플랫폼은 "닫힌 열거형에 클라이언트가 모르는 값 1개가 오자
 * **후보집합을 통째로 폐기**한" 사고를 겪었다. 런타임 구버전은 코드 23개만 알고
 * 신버전은 33개를 보내는데, 구버전이 모르는 1개를 만나면 전부 버렸다.
 *
 * 표면끼리 판이 다른 것은 정상이다(데스크탑이 스키마 정본이고 터미널은 뒤따라온다).
 * 그러니 모르는 값은 **원문을 보존한 채** 항목 단위로 강등하고 나머지는 정상 처리한다.
 * 집합 폐기·스트림 절단·에러 승격은 전부 금지.
 */
export type Degradable<T extends string> = { known: T } | { unknown: string };

export function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): Degradable<T> {
  const text = typeof value === "string" ? value : String(value ?? "");
  return (allowed as readonly string[]).includes(text)
    ? { known: text as T }
    : { unknown: text };
}

/** 강등된 항목을 사람에게 보여줄 문구. **원문을 지우지 않는다.** */
export function degradedLabel(value: Degradable<string>, locale: "ko" | "en" = "ko"): string {
  if ("known" in value) return value.known;
  return locale === "ko"
    ? `알 수 없음 (원문: ${value.unknown})`
    : `unknown (raw: ${value.unknown})`;
}

/** 목록에서 모르는 항목만 강등하고 **아무것도 버리지 않는다**. */
export function readEnumList<T extends string>(
  values: readonly unknown[],
  allowed: readonly T[],
): Degradable<T>[] {
  return values.map((value) => readEnum(value, allowed));
}

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
