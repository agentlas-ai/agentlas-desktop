// 워크플로우 그래프 검증(설계 §4.3 "검증", §5 P2) — 편집기가 저장 전/편집 중 표면화한다.
// 두 부류를 본다:
//   (1) dangling — 비-트리거 노드에 inbound 엣지가 없거나, 엣지가 없는 노드 id를 가리키거나,
//       트리거에서 도달 불가능한 섬(island). "이 노드는 절대 실행되지 않는다"를 잡는다.
//   (2) variable-match — 노드가 {{var}}를 소비하는데(prompt/text/consumes/condition.var/transform.from)
//       상류에 그 변수를 생산(produces/transform.to)하는 노드가 없으면 빈 값으로 흐른다.
//
// 순수 함수 — DOM/IPC 없음. 렌더러 편집기가 결과를 노드별 배지/경고로 그린다.
import type { WorkflowGraph, WorkflowNode } from "./types";

export type WorkflowIssueSeverity = "error" | "warning";

export interface WorkflowIssue {
  severity: WorkflowIssueSeverity;
  /** 이슈가 걸린 노드 id(엣지 이슈는 source/target 중 관련 노드). */
  nodeId?: string;
  /** 이슈 코드 — UI가 i18n 메시지 매핑에 사용. */
  code:
    | "dangling-node" // 비-트리거인데 inbound 엣지 없음
    | "edge-missing-node" // 엣지가 존재하지 않는 노드 id를 가리킴
    | "unreachable" // 트리거에서 도달 불가(고립 섬)
    | "no-trigger" // 트리거 노드가 하나도 없음
    | "unknown-variable" // {{var}} 소비하는데 상류 생산자 없음
    | "condition-missing-branch" // condition 노드에 true/false 엣지가 부족
    | "condition-branch-undeclared"; // condition에서 나가는 연결이 참/거짓을 선언하지 않음(커널이 실행 거부)
  /** 사람이 읽는 요약(영문 기본, UI가 code로 재번역 가능). */
  message: string;
  /** unknown-variable일 때 문제의 변수명. */
  variable?: string;
}

/** config에서 문자열 필드 안전 추출. */
function str(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** 문자열에서 {{var}} 이름을 모두 뽑는다. */
function referencedVars(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  const re = /\{\{\s*([\w.-]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}

/** 이 노드가 소비하는 변수명 집합(prompt/text/consumes/condition.var/transform.from + {{}}참조). */
function consumedVars(node: WorkflowNode): Set<string> {
  const cfg = node.config ?? {};
  const set = new Set<string>();
  for (const v of referencedVars(str(cfg, "prompt"))) set.add(v);
  for (const v of referencedVars(str(cfg, "text"))) set.add(v);
  for (const v of referencedVars(str(cfg, "template"))) set.add(v);
  const consumes = str(cfg, "consumes");
  if (consumes) set.add(consumes);
  if (node.type === "condition") {
    const v = str(cfg, "var");
    if (v) set.add(v);
  }
  if (node.type === "transform") {
    const from = str(cfg, "from");
    if (from) set.add(from);
  }
  return set;
}

/** 이 노드가 생산하는 변수명(produces / transform.to). */
function producedVar(node: WorkflowNode): string | undefined {
  const cfg = node.config ?? {};
  if (node.type === "transform") return str(cfg, "to") ?? str(cfg, "from");
  return str(cfg, "produces");
}

/**
 * 위상 순서로 노드를 정렬(Kahn). 사이클/고아는 뒤에 붙인다. 변수 상류 판정에 쓴다.
 * layoutGraph의 depth 계산과 같은 아이디어지만 여기선 순서 배열만 필요.
 */
function topoOrder(graph: WorkflowGraph): WorkflowNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const indeg = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const order: WorkflowNode[] = [];
  const seen = new Set<string>();
  const queue = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(byId.get(id)!);
    for (const t of adj.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 0) - 1);
      if ((indeg.get(t) ?? 0) <= 0 && !seen.has(t)) queue.push(t);
    }
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) order.push(n);
  return order;
}

/** 트리거 노드에서 엣지로 도달 가능한 노드 집합(BFS). */
function reachableFromTriggers(graph: WorkflowGraph): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const reached = new Set<string>();
  const queue = graph.nodes.filter((n) => n.type === "trigger").map((n) => n.id);
  for (const id of queue) reached.add(id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of adj.get(id) ?? []) {
      if (!reached.has(t)) {
        reached.add(t);
        queue.push(t);
      }
    }
  }
  return reached;
}

/**
 * 그래프를 검증해 이슈 배열을 반환한다(빈 배열 = 문제 없음). error는 저장/활성 차단 후보,
 * warning은 안내용. 편집기가 severity로 색을 나눈다.
 */
export function validateWorkflow(graph: WorkflowGraph): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  // 트리거 존재 여부.
  const hasTrigger = graph.nodes.some((n) => n.type === "trigger");
  if (!hasTrigger && graph.nodes.length > 0) {
    issues.push({ severity: "warning", code: "no-trigger", message: "No trigger node — this flow fires only via Run now." });
  }

  // 엣지가 없는 노드 id를 가리키는지.
  for (const e of graph.edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      issues.push({
        severity: "error",
        code: "edge-missing-node",
        nodeId: nodeIds.has(e.source) ? e.source : e.target,
        message: `Edge ${e.id} points to a node that no longer exists.`,
      });
    }
  }

  // inbound 엣지 맵.
  const inbound = new Map<string, number>();
  for (const n of graph.nodes) inbound.set(n.id, 0);
  for (const e of graph.edges) {
    if (nodeIds.has(e.target)) inbound.set(e.target, (inbound.get(e.target) ?? 0) + 1);
  }

  // dangling: 비-트리거 노드에 inbound 엣지 없음.
  for (const n of graph.nodes) {
    if (n.type === "trigger") continue;
    if ((inbound.get(n.id) ?? 0) === 0) {
      issues.push({
        severity: "error",
        code: "dangling-node",
        nodeId: n.id,
        message: `Node "${n.label ?? n.type}" has no incoming connection and will never run.`,
      });
    }
  }

  // 도달 불가 섬(트리거가 있을 때만 의미 있음).
  if (hasTrigger) {
    const reached = reachableFromTriggers(graph);
    for (const n of graph.nodes) {
      if (n.type === "trigger") continue;
      if (!reached.has(n.id) && (inbound.get(n.id) ?? 0) > 0) {
        // inbound는 있으나 트리거로부터 도달 불가 → 고립 섬.
        issues.push({
          severity: "warning",
          code: "unreachable",
          nodeId: n.id,
          message: `Node "${n.label ?? n.type}" is not reachable from any trigger.`,
        });
      }
    }
  }

  // condition 노드는 true/false 두 분기 엣지가 있어야 의미가 있다(둘 다 없으면 경고).
  // 그리고 참/거짓을 선언하지 않은 연결은 **오류**다: 커널은 어느 쪽으로도 판정할 수 없어
  // 실행을 멈춘다(EDGE_CONDITION_UNRESOLVED). 실행하고 나서 알게 하지 않는다.
  for (const n of graph.nodes) {
    if (n.type !== "condition") continue;
    const outgoing = graph.edges.filter((e) => e.source === n.id);
    const handles = new Set(outgoing.map((e) => e.sourceHandle ?? ""));
    if (!handles.has("true") && !handles.has("false")) {
      issues.push({
        severity: "warning",
        code: "condition-missing-branch",
        nodeId: n.id,
        message: `Condition "${n.label ?? n.type}" has no true/false branch wired.`,
      });
    }
    const undeclared = outgoing.filter(
      (e) => e.sourceHandle !== "true" && e.sourceHandle !== "false",
    );
    if (undeclared.length > 0) {
      issues.push({
        severity: "error",
        code: "condition-branch-undeclared",
        nodeId: n.id,
        message:
          `Condition "${n.label ?? n.type}" has ${undeclared.length} outgoing connection(s) that do not declare the true or false side. ` +
          "Delete them and reconnect from the condition's true/false outputs.",
      });
    }
  }

  // variable-match: 위상 순서로 상류 생산자 집합을 누적하며, 각 노드의 소비 변수가 이미
  // 생산됐는지 확인. 아직 안 나온 변수를 소비하면 unknown-variable.
  const produced = new Set<string>();
  for (const node of topoOrder(graph)) {
    for (const v of consumedVars(node)) {
      if (!produced.has(v)) {
        issues.push({
          severity: "warning",
          code: "unknown-variable",
          nodeId: node.id,
          variable: v,
          message: `Node "${node.label ?? node.type}" uses {{${v}}} but no upstream node produces it.`,
        });
      }
    }
    const out = producedVar(node);
    if (out) produced.add(out);
  }

  return issues;
}

/** 노드 id → 이슈 배열 맵(편집기가 노드별 배지 렌더에 쓰기 좋게). */
export function issuesByNode(issues: WorkflowIssue[]): Map<string, WorkflowIssue[]> {
  const map = new Map<string, WorkflowIssue[]>();
  for (const iss of issues) {
    if (!iss.nodeId) continue;
    if (!map.has(iss.nodeId)) map.set(iss.nodeId, []);
    map.get(iss.nodeId)!.push(iss);
  }
  return map;
}
