// 워크플로우 그래프 러너 — 기존 runMcpInvocation dispatch 위의 얇은 위상 워커(설계 §4.4).
// 각 노드는 엔진이 이미 실행하는 무언가로 컴파일된다: agent 노드는 McpInvocationRequest,
// tool 노드는 인접 agent 런타임에 붙는 MCP 설정, action/output/condition/transform는 인러너.
// per-run 변수 백 Record<string,unknown>이 위상 워크를 관통하며 {{var}} 치환을 구동한다
// (promptTemplate이 늘 약속했던 파라미터화, 설계 한계 #12).
//
// 실행 엔진은 손대지 않는다 — 러너는 "어떤 요청을 어떤 순서로 runMcpInvocation에 넘길지"만 결정.
import type {
  Automation,
  WorkflowGraph,
  WorkflowNode,
  McpInvocationEvent,
  WorkflowNodeRunState,
} from "../../shared/types";
import { runMcpInvocation } from "../mcp/client";
import { getOrCreateAutomationSession } from "../store/chats";
import { startGraphRun, updateGraphRunNode, finishGraphRun } from "../store/automations";
import { getAgentById } from "../mcp/registry";
import { getFirm } from "../store/firms";
import { getAgentGroup } from "../store/agent-groups";
import { getAgentConcurrency } from "../store/concurrency";

type EventSink = (ev: McpInvocationEvent) => void;

export interface RunGraphOptions {
  sink?: EventSink;
  signal?: AbortSignal;
  /** 이 실행의 안정 id — automation_runs 스냅샷 키(라이브 오버레이 재하이드레이트). */
  runId?: string;
}

export interface RunGraphResult {
  ok: boolean;
  /** 노드 id → 최종 텍스트 출력. */
  outputs: Record<string, string>;
  /** produces 이름 → 값(변수 백 스냅샷). */
  vars: Record<string, unknown>;
  error?: string;
}

/** {{var}} 치환 — 변수 백에서 값을 읽어 문자열에 삽입. 미정의는 빈 문자열. */
function substitute(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v == null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

/** config에서 문자열 필드 안전 추출. */
function str(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * 위상 정렬 — edges의 source→target DAG를 Kahn 알고리즘으로 정렬. 사이클/고아는 안전하게
 * 뒤에 붙인다(무한 루프 방지). 결정적 순서를 위해 원본 노드 배열 순서를 tie-break로 쓴다.
 */
function topoSort(graph: WorkflowGraph): WorkflowNode[] {
  const nodes = graph.nodes;
  const indexOf = new Map<string, number>(nodes.map((n, i) => [n.id, i]));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    if (!indexOf.has(e.source) || !indexOf.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const ready = nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .sort((a, b) => (indexOf.get(a.id)! - indexOf.get(b.id)!))
    .map((n) => n.id);
  const order: string[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    const outs = (adj.get(id) ?? []).slice().sort((a, b) => (indexOf.get(a)! - indexOf.get(b)!));
    for (const t of outs) {
      indegree.set(t, (indegree.get(t) ?? 0) - 1);
      if ((indegree.get(t) ?? 0) <= 0 && !seen.has(t)) ready.push(t);
    }
  }
  // 사이클/미도달 노드는 원 순서로 뒤에 붙인다.
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/** condition 노드 평가 — 변수 백을 읽어 true/false 반환. 단순 op만 지원(P0). */
function evalCondition(node: WorkflowNode, vars: Record<string, unknown>): boolean {
  const cfg = node.config;
  const left = str(cfg, "var") ? vars[str(cfg, "var")!] : undefined;
  const op = str(cfg, "op") ?? "truthy";
  const right = cfg.value;
  switch (op) {
    case "truthy":
      return Boolean(left);
    case "falsy":
      return !left;
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "gt":
      return Number(left) > Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "contains":
      return typeof left === "string" && typeof right === "string" && left.includes(right);
    default:
      return Boolean(left);
  }
}

/** transform 노드 — 변수 백을 순수 함수로 reshape(extract/format/json). */
function applyTransform(node: WorkflowNode, vars: Record<string, unknown>): void {
  const cfg = node.config;
  const from = str(cfg, "from");
  const to = str(cfg, "to") ?? from;
  if (!from || !to) return;
  const source = vars[from];
  const mode = str(cfg, "mode") ?? "identity";
  switch (mode) {
    case "json":
      try {
        vars[to] = typeof source === "string" ? JSON.parse(source) : source;
      } catch {
        vars[to] = source;
      }
      break;
    case "format": {
      const tmpl = str(cfg, "template") ?? "{{" + from + "}}";
      vars[to] = substitute(tmpl, vars);
      break;
    }
    case "extract": {
      const pattern = str(cfg, "pattern");
      if (pattern && typeof source === "string") {
        try {
          const m = source.match(new RegExp(pattern));
          vars[to] = m ? (m[1] ?? m[0]) : "";
        } catch {
          vars[to] = source;
        }
      } else {
        vars[to] = source;
      }
      break;
    }
    default:
      vars[to] = source;
  }
}

/**
 * 그래프를 실행한다. 백그라운드 division 챗 + permissions:"write" 패턴을 재사용한다
 * (automation-scheduler.ts와 동일). agent 노드마다 runMcpInvocation을 호출하고, produces를
 * 변수 백에 기록, condition/transform은 인러너로 처리한다.
 *
 * 분기(condition)는 엣지 단위로 처리한다: condition이 drop한 핸들의 엣지를 "blocked"로 표시하고,
 * 각 노드는 자기 inbound 엣지가 전부 blocked이거나 skipped 부모에서 올 때만 skipped가 된다.
 * 이렇게 하면 diamond/join(살아있는 다른 부모가 있으면 노드는 실행)이 올바르게 처리된다 —
 * 서브트리를 통째로 pre-collect하면 join 뒤 노드를 잘못 스킵할 수 있어 엣지 단위로 판정한다.
 */
export async function runGraph(
  automation: Automation,
  graph: WorkflowGraph,
  opts: RunGraphOptions = {},
): Promise<RunGraphResult> {
  const sink: EventSink = opts.sink ?? (() => {});
  const vars: Record<string, unknown> = {};
  const outputs: Record<string, string> = {};
  const runId = opts.runId ?? `run-${automation.id}-${Date.now()}`;

  // per-node 라이브 상태 — sink로 emit하고 automation_runs에 영속화(새로고침 후 재하이드레이트).
  const emitNodeState = (nodeId: string, state: WorkflowNodeRunState): void => {
    try {
      updateGraphRunNode(runId, nodeId, state);
    } catch {
      /* 영속화 실패는 무시(라이브 emit이 우선) */
    }
    sink({ kind: "partial", nodeId, nodeState: state, agentId: nodeId });
  };

  const chat = getOrCreateAutomationSession({
    automationId: automation.id,
    ...(automation.targetType === "firm"
      ? { firmId: automation.targetId }
      : { agentId: automation.targetId }),
  });

  // 노드별 타깃 세션 — agent 노드의 config.ref(에이전트/회사/그룹 id)를 그 타깃에 바인딩된
  // division 세션으로 실행한다(설계 §4.4: agent(agent)→agent.id). ref 없음/미해석이면 자동화
  // 기본 타깃으로 폴백(dangling 방지). automationId 마커에 타깃 키를 붙여 타깃별로 세션 재사용.
  const nodeChatCache = new Map<string, typeof chat>();
  const chatForNode = (node: WorkflowNode): typeof chat => {
    const ref = str(node.config, "ref");
    if (!ref) return chat;
    const cached = nodeChatCache.get(ref);
    if (cached) return cached;
    let resolved = chat;
    if (getAgentById(ref)) {
      resolved = getOrCreateAutomationSession({ automationId: `${automation.id}::a:${ref}`, agentId: ref });
    } else if (getFirm(ref)) {
      resolved = getOrCreateAutomationSession({ automationId: `${automation.id}::f:${ref}`, firmId: ref });
    } else if (getAgentGroup(ref)) {
      resolved = getOrCreateAutomationSession({ automationId: `${automation.id}::g:${ref}`, agentGroupId: ref });
    }
    nodeChatCache.set(ref, resolved);
    return resolved;
  };

  const ordered = topoSort(graph);
  try {
    startGraphRun({ runId, automationId: automation.id, nodeIds: graph.nodes.map((n) => n.id) });
  } catch {
    /* 스냅샷 시작 실패는 무시 */
  }

  // skipped: 실행하지 않기로 확정된 노드. blockedEdges: condition이 drop한 엣지 id.
  const skipped = new Set<string>();
  const blockedEdges = new Set<string>();
  // 노드별 inbound 엣지(엣지 id + source) — 스킵 전파 판정용.
  const inbound = new Map<string, { edgeId: string; source: string }[]>();
  for (const e of graph.edges) {
    if (!inbound.has(e.target)) inbound.set(e.target, []);
    inbound.get(e.target)!.push({ edgeId: e.id, source: e.source });
  }
  // condition 노드의 소스 엣지(핸들별) — drop 판정용.
  const outByNode = new Map<string, { edgeId: string; handle?: string }[]>();
  for (const e of graph.edges) {
    if (!outByNode.has(e.source)) outByNode.set(e.source, []);
    outByNode.get(e.source)!.push({ edgeId: e.id, handle: e.sourceHandle });
  }

  /**
   * 노드가 스킵돼야 하는가? inbound 엣지가 하나도 없으면(트리거/시작점) 스킵 아님.
   * inbound 엣지가 있으면, 모든 엣지가 blocked이거나 skipped 부모에서 올 때만 스킵
   * (살아있는 부모가 하나라도 있으면 실행 — join 보호).
   */
  const shouldSkip = (nodeId: string): boolean => {
    const ins = inbound.get(nodeId) ?? [];
    if (ins.length === 0) return false;
    return ins.every((i) => blockedEdges.has(i.edgeId) || skipped.has(i.source));
  };

  // 노드 상태 — 슬롯 기반 동시 스케줄러(스웜 엔진과 동일 패턴)로 의존성이 충족된 노드를
  // 동시성 한도(getAgentConcurrency = 사용자 슬라이더)만큼 병렬 실행한다. 독립 분기는 실제로
  // 동시에 돌고, 의존 있는 노드는 상류가 끝난 뒤에만 시작한다("상황에 따라 병렬").
  type NodeStatus = "pending" | "running" | "done" | "skipped" | "failed";
  const status = new Map<string, NodeStatus>();
  for (const n of ordered) status.set(n.id, "pending");
  const settled = (id: string): boolean => {
    const s = status.get(id);
    return s === "done" || s === "skipped" || s === "failed";
  };
  // 노드가 실행 가능한가? 모든 inbound 엣지가 blocked이거나 그 source가 settled여야(상류 완료).
  const inboundResolved = (nodeId: string): boolean =>
    (inbound.get(nodeId) ?? []).every((i) => blockedEdges.has(i.edgeId) || settled(i.source));

  let ok = true;
  let error: string | undefined;

  const runNode = async (node: (typeof ordered)[number]): Promise<void> => {
    switch (node.type) {
      case "trigger":
        emitNodeState(node.id, "done");
        status.set(node.id, "done");
        return;
      case "condition": {
        emitNodeState(node.id, "running");
        const result = evalCondition(node, vars);
        const drop = result ? "false" : "true";
        for (const edge of outByNode.get(node.id) ?? []) {
          if (edge.handle === drop) blockedEdges.add(edge.edgeId);
        }
        emitNodeState(node.id, "done");
        status.set(node.id, "done");
        return;
      }
      case "transform":
        emitNodeState(node.id, "running");
        applyTransform(node, vars);
        emitNodeState(node.id, "done");
        status.set(node.id, "done");
        return;
      case "tool":
        // 툴은 러너가 직접 호출하지 않는다 — 인접 agent 런타임 선언(설계 §4.4).
        emitNodeState(node.id, "done");
        status.set(node.id, "done");
        return;
      case "agent":
      case "action":
      case "output": {
        const rawPrompt = str(node.config, "prompt") ?? str(node.config, "text") ?? automation.promptTemplate;
        const prompt = substitute(rawPrompt, vars);
        if (!prompt.trim()) {
          emitNodeState(node.id, "done");
          status.set(node.id, "done");
          return;
        }
        emitNodeState(node.id, "running");
        try {
          // agent 노드는 config.ref가 가리키는 에이전트/회사 세션에서 실행(멀티에이전트 그래프).
          const nodeChat = node.type === "agent" ? chatForNode(node) : chat;
          const result = await runMcpInvocation(
            { chatId: nodeChat.id, userPrompt: prompt, permissions: "write" },
            (ev) => sink({ ...ev, agentId: ev.agentId ?? node.id, nodeId: node.id }),
            opts.signal,
          );
          const text = result.finalText ?? "";
          outputs[node.id] = text;
          const produces = str(node.config, "produces");
          if (produces) vars[produces] = text; // 병렬 노드는 서로 독립(deps로 분리)이라 vars 경합 없음
          emitNodeState(node.id, "done");
          status.set(node.id, "done");
        } catch (nodeErr) {
          emitNodeState(node.id, "failed");
          status.set(node.id, "failed");
          if (error === undefined) error = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
          ok = false;
        }
        return;
      }
      default:
        emitNodeState(node.id, "done");
        status.set(node.id, "done");
        return;
    }
  };

  const concurrency = Math.max(1, Math.floor(getAgentConcurrency()));
  const running = new Map<string, Promise<void>>();
  for (;;) {
    if (opts.signal?.aborted) {
      ok = false;
      error = error ?? "aborted";
      break;
    }
    // 스킵 전파(고정점): inbound가 전부 blocked/skipped인 노드는 실행 없이 skip.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of ordered) {
        if (status.get(node.id) === "pending" && inboundResolved(node.id) && shouldSkip(node.id)) {
          status.set(node.id, "skipped");
          skipped.add(node.id);
          emitNodeState(node.id, "skipped");
          changed = true;
        }
      }
    }
    // 첫 실패가 나면 새 노드는 더 안 띄운다(fail-stop) — 진행 중인 것만 마무리.
    if (!ok) break;
    const ready = ordered.filter(
      (n) => status.get(n.id) === "pending" && inboundResolved(n.id) && !shouldSkip(n.id),
    );
    const slots = Math.max(0, concurrency - running.size);
    for (const node of ready.slice(0, slots)) {
      status.set(node.id, "running");
      const p = runNode(node).finally(() => running.delete(node.id));
      running.set(node.id, p);
    }
    if (running.size === 0) {
      const stillPending = ordered.some((n) => status.get(n.id) === "pending");
      if (!stillPending) break; // 정상 수렴
      // pending인데 실행도 준비도 안 됨(사이클 등) → 실패 처리하고 종료(무한루프 방지).
      for (const n of ordered) {
        if (status.get(n.id) === "pending") {
          status.set(n.id, "failed");
          emitNodeState(n.id, "failed");
        }
      }
      ok = false;
      error = error ?? "graph did not converge (cycle or unreachable node)";
      break;
    }
    await Promise.race(running.values());
    await Promise.resolve(); // 마이크로태스크 flush — 완료 노드의 finally(running.delete) 반영
  }
  // 남은 실행 정리(취소/조기종료 시).
  if (running.size > 0) await Promise.allSettled(running.values());

  try {
    finishGraphRun(runId, ok ? "ok" : "error");
  } catch {
    /* 스냅샷 종료 실패 무시 */
  }
  return ok ? { ok: true, outputs, vars } : { ok: false, outputs, vars, error };
}
