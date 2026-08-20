import { nodeCanChangeTheOutsideWorld } from "../../shared/graph-node-protocol";
// Graph Architect 패치 계약 — 자연어로 그래프를 고칠 때 **모델이 그래프를 직접 쓰지 못하게** 막는다.
//
// 계약(설계 D8): 모델은 GraphPatch를 *제안*만 한다. 코드가 (1) 형태를 검증하고,
// (2) 어떤 위험이 걸린 변경인지 분류하고, (3) 위험 변경은 사람의 승인 없이는 적용하지 않는다.
//
// 여기서 지키는 두 줄:
//  · 모르는 연산은 조용히 건너뛰지 않고 **패치 전체를 거절**한다. 변경 계약에서 "일부만 적용"은
//    사용자가 승인한 적 없는 그래프를 만든다.
//  · 위험 표식을 모르면 안전한 쪽이 아니라 **승인 필요 쪽**으로 판정한다. 위험을 몰라서
//    통과시키는 방향의 오류는 되돌릴 수 없다.
import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from "../../shared/types";

export type GraphPatchOpKind =
  | "addNode" | "editNode" | "removeNode"
  | "addEdge" | "removeEdge"
  | "setPolicy" | "setTrigger";

/** 사람의 승인이 필요한 이유. 이 목록에 없는 값이 오면 승인 필요로 간주한다. */
export type GraphPatchRisk =
  | "mutation" | "vault" | "cron" | "publish" | "delete" | "endpoint" | "budget";

export interface GraphPatchOp {
  op: GraphPatchOpKind;
  nodeId?: string;
  edgeId?: string;
  node?: WorkflowNode;
  edge?: WorkflowEdge;
  config?: Record<string, unknown>;
}

export interface GraphPatch {
  ops: GraphPatchOp[];
  rationale?: string;
}

export type GraphPatchDecision =
  | { ok: false; code: string; reason: string; nextAction: string }
  | {
    ok: true;
    /** 적용해도 되는 결과 그래프(승인이 필요하면 아직 적용하지 않는다). */
    next: WorkflowGraph;
    /** 사람이 승인해야 하는 이유들. 비어 있으면 바로 적용해도 되는 변경이다. */
    risks: GraphPatchRisk[];
    /** 사용자에게 보여줄 변경 요약 — 무엇이 늘고 줄고 바뀌는가. */
    summary: { added: string[]; removed: string[]; changed: string[] };
  };

const OP_KINDS = new Set<string>([
  "addNode", "editNode", "removeNode", "addEdge", "removeEdge", "setPolicy", "setTrigger",
]);

const ENDPOINT_KEYS = ["apiEndpoint", "url", "webhookUrl"];
const VAULT_KEY_RE = /(token|secret|password|apikey|api_key|credential|vault)/i;

/**
 * 이 단계가 어떤 위험을 걸고 있는가. 모르는 형태는 위험 없음으로 치지 않는다.
 *
 * ★`config.effect === "mutation"` 만 보던 자리였다. 그런데 emitter 가 만드는 출력 노드는
 *   그 칸을 아예 안 쓰고, 그 노드의 기본값이 "바깥으로 나감"이다. 그래서 **발행 단계를
 *   추가하는 패치가 위험 없음으로 읽혀 승인 없이 적용**됐다. 판정은 정본 하나를 쓴다.
 *   타입을 못 받는 시그니처가 사본을 강제하고 있었으므로 시그니처부터 고친다.
 */
function risksOfNode(
  node: { type?: string; config?: Record<string, unknown> | undefined } | undefined,
): GraphPatchRisk[] {
  const config = node?.config;
  if (!config && !node?.type) return [];
  const risks: GraphPatchRisk[] = [];
  if (nodeCanChangeTheOutsideWorld({ type: node?.type, config })) risks.push("mutation");
  if (!config) return risks;
  if (Object.keys(config).some((key) => VAULT_KEY_RE.test(key))) risks.push("vault");
  if (ENDPOINT_KEYS.some((key) => typeof config[key] === "string" && config[key])) risks.push("endpoint");
  if (config.maxTokens !== undefined) risks.push("budget");
  return risks;
}

function fail(code: string, reason: string, nextAction: string): GraphPatchDecision {
  return { ok: false, code, reason, nextAction };
}

/**
 * 제안된 패치를 검증하고, 적용 결과와 승인이 필요한 이유를 돌려준다.
 * **적용은 하지 않는다** — 호출부가 승인을 받은 뒤에 next를 저장한다.
 */
export function evaluateGraphPatch(graph: WorkflowGraph, patch: GraphPatch): GraphPatchDecision {
  if (!patch || !Array.isArray(patch.ops) || patch.ops.length === 0) {
    return fail(
      "PATCH_EMPTY",
      "고칠 내용을 만들지 못했습니다.",
      "무엇을 바꾸고 싶은지 조금 더 구체적으로 말씀해 주세요.",
    );
  }
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const edges = graph.edges.map((edge) => ({ ...edge }));
  const risks = new Set<GraphPatchRisk>();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const op of patch.ops) {
    if (!op || !OP_KINDS.has(op.op)) {
      // 모르는 연산을 건너뛰고 나머지를 적용하면, 사용자가 승인한 적 없는 그래프가 된다.
      return fail(
        "PATCH_OP_UNKNOWN",
        `이 버전이 알 수 없는 변경 방식("${op?.op ?? "이름 없음"}")이 포함돼 있어 전체를 적용하지 않았습니다.`,
        "Agentlas를 최신 버전으로 업데이트하거나, 요청을 더 단순하게 다시 말씀해 주세요.",
      );
    }
    if (op.op === "addNode") {
      if (!op.node?.id || nodes.some((n) => n.id === op.node!.id)) {
        return fail("PATCH_NODE_CONFLICT", "이미 있는 단계와 같은 이름으로 추가하려 했습니다.", "다른 이름으로 다시 시도해 주세요.");
      }
      nodes.push(op.node);
      added.push(op.node.label || op.node.id);
      for (const risk of risksOfNode(op.node)) risks.add(risk);
    } else if (op.op === "editNode") {
      const index = nodes.findIndex((n) => n.id === op.nodeId);
      if (index < 0) return fail("PATCH_NODE_MISSING", `고치려는 단계 "${op.nodeId}"를 찾지 못했습니다.`, "화면을 새로고침한 뒤 다시 시도해 주세요.");
      const merged = { ...nodes[index], config: { ...(nodes[index].config ?? {}), ...(op.config ?? {}) } };
      // 이미 갖고 있던 위험은 이 패치가 새로 거는 것이 아니다 — **늘어난 것만** 센다.
      // (안 그러면 발송 단계의 문구 한 줄 고치는 데도 승인이 뜬다.)
      const before = new Set(risksOfNode(nodes[index]));
      nodes[index] = merged;
      changed.push(merged.label || merged.id);
      for (const risk of risksOfNode(merged)) if (!before.has(risk)) risks.add(risk);
    } else if (op.op === "removeNode") {
      const index = nodes.findIndex((n) => n.id === op.nodeId);
      if (index < 0) return fail("PATCH_NODE_MISSING", `지우려는 단계 "${op.nodeId}"를 찾지 못했습니다.`, "화면을 새로고침한 뒤 다시 시도해 주세요.");
      removed.push(nodes[index].label || nodes[index].id);
      nodes.splice(index, 1);
      for (let i = edges.length - 1; i >= 0; i -= 1) {
        if (edges[i].source === op.nodeId || edges[i].target === op.nodeId) edges.splice(i, 1);
      }
      risks.add("delete");
    } else if (op.op === "addEdge") {
      if (!op.edge?.id || edges.some((e) => e.id === op.edge!.id)) {
        return fail("PATCH_EDGE_CONFLICT", "이미 있는 연결과 같은 이름으로 추가하려 했습니다.", "다시 시도해 주세요.");
      }
      if (!nodes.some((n) => n.id === op.edge!.source) || !nodes.some((n) => n.id === op.edge!.target)) {
        return fail("PATCH_EDGE_DANGLING", "존재하지 않는 단계를 잇는 연결이 포함돼 있습니다.", "연결할 단계를 먼저 만들도록 다시 요청해 주세요.");
      }
      edges.push(op.edge);
      changed.push(`${op.edge.source} → ${op.edge.target}`);
    } else if (op.op === "removeEdge") {
      const index = edges.findIndex((e) => e.id === op.edgeId);
      if (index < 0) return fail("PATCH_EDGE_MISSING", "지우려는 연결을 찾지 못했습니다.", "화면을 새로고침한 뒤 다시 시도해 주세요.");
      edges.splice(index, 1);
      changed.push("연결 제거");
    } else if (op.op === "setTrigger") {
      risks.add("cron");
      const index = nodes.findIndex((n) => n.type === "trigger");
      if (index < 0) return fail("PATCH_NODE_MISSING", "시작 지점을 찾지 못했습니다.", "화면을 새로고침한 뒤 다시 시도해 주세요.");
      nodes[index] = { ...nodes[index], config: { ...(nodes[index].config ?? {}), ...(op.config ?? {}) } };
      changed.push("실행 시점");
    } else {
      // setPolicy
      const index = nodes.findIndex((n) => n.id === op.nodeId);
      if (index < 0) return fail("PATCH_NODE_MISSING", `설정을 바꾸려는 단계 "${op.nodeId}"를 찾지 못했습니다.`, "화면을 새로고침한 뒤 다시 시도해 주세요.");
      const policyBefore = new Set(risksOfNode(nodes[index]));
      nodes[index] = { ...nodes[index], config: { ...(nodes[index].config ?? {}), ...(op.config ?? {}) } };
      changed.push(nodes[index].label || nodes[index].id);
      for (const risk of risksOfNode(nodes[index])) if (!policyBefore.has(risk)) risks.add(risk);
      // 승인 등급을 낮추는 변경은 그 자체가 승인받아야 하는 변경이다.
      if (op.config?.approval === "auto") risks.add("mutation");
    }
  }

  // ── 저장 시점 구조 검사 ──────────────────────────────────────────────────
  // ★청사진 경로는 저장하는 자리(validateBlueprint)에서 막는데, 패치 경로는 여태
  //   실행할 때까지 통과시켰다. 그러면 AI가 만든 반복·갈림길이 "저장은 되고 실행에서
  //   거절"되는 모양이 된다 — 사람은 승인까지 해 놓고 왜 안 도는지 알 수 없다.
  //   같은 결함을 같은 자리(저장 시점)에서 막는다.
  //
  // ★단, **이 패치가 만든 것만** 검사한다. 그래프에 이미 있던 결함까지 검사하면
  //   사람이 안 건드린 연결 때문에 무관한 변경이 거절된다 — "당신의 변경을 거절합니다.
  //   이유: 당신이 안 만든 연결" 은 원인을 찾을 수 없는 문장이다.
  //   기존 결함은 캔버스 검증기(workflow-validate)의 몫이다.
  const priorEdgeIds = new Set(graph.edges.map((e) => e.id));
  const touchedNodeIds = new Set<string>();
  for (const op of patch.ops) {
    if (op.op === "addNode" && op.node?.id) touchedNodeIds.add(op.node.id);
    if ((op.op === "editNode" || op.op === "setPolicy") && op.nodeId) touchedNodeIds.add(op.nodeId);
  }

  // 1. 이 패치가 추가한 갈림길 연결은 참/거짓을 선언해야 한다 (EDGE_CONDITION_UNRESOLVED 예방)
  const conditionIds = new Set(nodes.filter((n) => n.type === "condition").map((n) => n.id));
  for (const edge of edges) {
    if (priorEdgeIds.has(edge.id)) continue;
    if (!conditionIds.has(edge.source)) continue;
    if (edge.sourceHandle === "true" || edge.sourceHandle === "false") continue;
    return fail(
      "PATCH_EDGE_HANDLE_MISSING",
      `갈림길에서 나가는 연결(${edge.source} → ${edge.target})이 참일 때인지 거짓일 때인지 정하지 않았습니다.`,
      "이 변경은 적용하지 않았습니다. 참/거짓 어느 쪽인지 함께 말씀해 주세요.",
    );
  }

  // 2. 이 패치로 **새로 생긴** 상한 없는 반복은 거절한다 (LOOP_BOUND_UNDECLARED 예방)
  //    ★DFS 색칠 — 커널 findBackEdges·캔버스와 같은 방식, 같은 시작점 규칙(들어오는
  //    연결이 없는 노드부터). 시작점이 다르면 여기서는 A→B를 반복이라 하고 커널은
  //    B→A를 요구해, 검사가 서로 다른 엣지에 상한을 물어보게 된다.
  //    "새로 생긴"의 판정은 전/후 back-edge 집합의 차이다 — 패치가 추가한 연결이
  //    기존 연결을 back-edge로 만드는 경우(옛 연결이 반복이 되는 경우)도 이 패치가
  //    만든 반복이므로 잡아야 한다.
  {
    type E = (typeof edges)[number];
    const findBack = (ns: { id: string }[], es: E[]): E[] => {
      const adjacency = new Map<string, { to: string; edge: E }[]>();
      for (const e of es) {
        if (!adjacency.has(e.source)) adjacency.set(e.source, []);
        adjacency.get(e.source)!.push({ to: e.target, edge: e });
      }
      const color = new Map<string, "gray" | "black">();
      const back: E[] = [];
      const visit = (id: string): void => {
        color.set(id, "gray");
        for (const out of adjacency.get(id) ?? []) {
          const c = color.get(out.to);
          if (c === "gray") back.push(out.edge);
          else if (c === undefined) visit(out.to);
        }
        color.set(id, "black");
      };
      const hasIncoming = new Set(es.map((e) => e.target));
      for (const n of ns) if (!hasIncoming.has(n.id) && !color.has(n.id)) visit(n.id);
      for (const n of ns) if (!color.has(n.id)) visit(n.id);
      return back;
    };
    const priorBackIds = new Set(findBack(graph.nodes, graph.edges as E[]).map((e) => e.id));
    for (const backEdge of findBack(nodes, edges)) {
      if (priorBackIds.has(backEdge.id)) continue; // 원래부터 반복이던 것 — 이 패치 탓이 아니다
      const bound = backEdge.maxIterations;
      if (typeof bound === "number" && Number.isFinite(bound) && bound >= 1) continue;
      return fail(
        "PATCH_LOOP_BOUND_MISSING",
        `되돌아가는 연결(${backEdge.source} → ${backEdge.target})에 반복 상한이 없습니다.`,
        "이 변경은 적용하지 않았습니다. 몇 바퀴까지 반복할지(maxIterations)를 함께 말씀해 주세요.",
      );
    }
  }

  // 3. 이 패치가 추가·수정한 코드 단계는 스크립트가 있어야 한다 (CODE_NODE_EMPTY 예방)
  for (const node of nodes) {
    if (node.type !== "code") continue;
    if (!touchedNodeIds.has(node.id)) continue;
    const codeText = typeof node.config?.code === "string" ? node.config.code.trim() : "";
    if (!codeText) {
      return fail(
        "PATCH_CODE_EMPTY",
        `코드 단계 "${node.label || node.id}"에 실행할 스크립트가 없습니다.`,
        "이 변경은 적용하지 않았습니다. 그 단계가 무엇을 계산할지 말씀해 주시면 스크립트까지 채워 다시 제안합니다.",
      );
    }
  }

  return {
    ok: true,
    next: { ...graph, nodes, edges },
    risks: [...risks].sort(),
    summary: { added, removed, changed },
  };
}

/**
 * 이 패치를 사람의 승인 없이 적용해도 되는가.
 * 위험이 하나라도 있으면 안 된다 — 되돌리기 어려운 쪽의 오류를 막는 것이 목적이다.
 */
export function graphPatchNeedsApproval(decision: GraphPatchDecision): boolean {
  return decision.ok ? decision.risks.length > 0 : true;
}
