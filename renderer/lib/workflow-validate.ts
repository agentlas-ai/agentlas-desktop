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
    | "condition-branch-undeclared" // condition에서 나가는 연결이 참/거짓을 선언하지 않음(커널이 실행 거부)
    | "loop-bound-missing" // 되돌아가는 연결에 반복 상한이 없음(커널이 실행 거부)
    | "transform-unconfigured" // 값 가공 단계에 무엇을 가공할지가 없음(커널이 실행 거부)
    | "error-var-without-error-edge"; // 실패 사유를 쓰는데 그 단계의 실패 연결이 없음
  /** 사람이 읽는 요약(영문 기본, UI가 code로 재번역 가능). */
  message: string;
  /** unknown-variable일 때 문제의 변수명. */
  variable?: string;
  /** loop-bound-missing일 때 문제의 엣지 id — UI가 그 연결을 골라 줄 수 있게. */
  edgeId?: string;
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
export function validateWorkflow(graph: WorkflowGraph, locale: "ko" | "en" = "ko"): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  // ★문구는 **제품 언어 하나로만** 나간다. 절반은 영어, 절반은 한국어로 섞여 나가던 것이
  //   실측 항목 4다 — 같은 화면에서 언어가 섞이면 어느 쪽 사용자도 못 읽는다.
  const t = (ko: string, en: string) => (locale === "ko" ? ko : en);

  // 트리거 존재 여부.
  const hasTrigger = graph.nodes.some((n) => n.type === "trigger");
  if (!hasTrigger && graph.nodes.length > 0) {
    issues.push({ severity: "warning", code: "no-trigger", message: t("시작(트리거) 단계가 없습니다 — \"지금 실행\"으로만 돌릴 수 있습니다.", "No trigger step — this flow runs only when you press Run now.") });
  }

  // 엣지가 없는 노드 id를 가리키는지.
  for (const e of graph.edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      issues.push({
        severity: "error",
        code: "edge-missing-node",
        nodeId: nodeIds.has(e.source) ? e.source : e.target,
        message: t("이미 지워진 단계로 이어지는 연결이 남아 있습니다. 그 연결을 지워 주세요.", "A connection still points at a step that no longer exists. Delete that connection."),
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
        message: t(`"${n.label ?? n.type}" 단계로 들어오는 연결이 없어 실행되지 않습니다. 앞 단계 출구에서 이 단계로 선을 이어 주세요.`, `"${n.label ?? n.type}" has no incoming connection, so it will never run. Draw a line into it from an earlier step.`),
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
          message: t(`"${n.label ?? n.type}" 단계는 시작점에서 닿지 않아 실행되지 않습니다.`, `"${n.label ?? n.type}" cannot be reached from the trigger, so it will not run.`),
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
        message: t(`"${n.label ?? n.type}" 갈림길에 참/거짓 어느 쪽 연결도 없습니다.`, `Condition "${n.label ?? n.type}" has no true/false branch wired.`),
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
        message: t(
          `"${n.label ?? n.type}" 갈림길에서 나가는 연결 ${undeclared.length}개가 참/거짓을 정하지 않았습니다. 그 연결을 지우고 참·거짓 출구에서 다시 이어 주세요.`,
          `Condition "${n.label ?? n.type}" has ${undeclared.length} outgoing connection(s) that do not declare the true or false side. Delete them and reconnect from the true/false outputs.`,
        ),
      });
    }
  }

  // ★실패 사유(`<노드>_error_reason`)를 쓰는데 그 단계에 **실패 출구가 아예 없으면** 알린다.
  //
  //   처음에는 "실패 연결로만 들어와야 한다"까지 요구했는데, 그건 멀쩡한 그래프를 무더기로
  //   막았다: 실패 경로가 2단계인 그래프(A -error→ 정리 → 알림), 실패 사유로 다시 갈라 보는
  //   그래프(A -error→ 조건 -참→ 알림), 정리 엣지를 함께 받는 알림 노드. 전부 정상이다 —
  //   변수는 실행 전체에서 살아 있으니 몇 단계를 건너도 읽힌다.
  //   그래서 **확실히 참인 것만** 말한다: 그 단계에 실패 출구가 하나도 없으면 그 사유는
  //   어떤 실행에서도 생기지 않는다. 그리고 severity는 warning이다 — 저장을 막을 만큼
  //   확신할 수 있는 판단이 아니다.
  {
    const errorVar = /^(.+?)_error(_reason)?$/;
    for (const node of graph.nodes) {
      const cfg = (node.config ?? {}) as Record<string, unknown>;
      const text = [cfg.prompt, cfg.text, cfg.template].filter((v): v is string => typeof v === "string").join(" ");
      for (const ref of referencedVars(text)) {
        const m = errorVar.exec(ref);
        if (!m) continue;
        const sourceId = m[1];
        if (!graph.nodes.some((n) => n.id === sourceId)) continue;
        // 다른 노드가 이 이름을 실제로 만들어 낸다면 업무 변수다 — 건드리지 않는다.
        if (graph.nodes.some((n) => (n.config as { produces?: unknown } | undefined)?.produces === ref)) continue;
        const hasErrorExit = graph.edges.some((e) => e.source === sourceId
          && (e.sourceHandle === "error" || e.sourceHandle === "timeout"));
        if (hasErrorExit) continue;
        issues.push({
          severity: "warning",
          code: "error-var-without-error-edge",
          nodeId: node.id,
          variable: ref,
          message: t(
            `"${node.label ?? node.type}"이(가) 실패 사유 {{${ref}}}를 쓰는데, "${sourceId}"에 실패 출구로 나가는 연결이 하나도 없습니다. 그 값은 만들어지지 않습니다.`,
            `"${node.label ?? node.type}" reads the failure reason {{${ref}}}, but "${sourceId}" has no failure exit wired — that value will never exist.`,
          ),
        });
      }
    }
  }

  // ★값 가공 단계는 팔레트에서 **빈 설정으로** 놓인다. 예전 커널은 설정이 없으면 조용히
  //   아무것도 안 하고 성공으로 남겼기 때문에, 그렇게 저장된 그래프가 실제로 존재한다.
  //   이제 커널이 실패시키므로, 저장 전에 여기서 먼저 말해 줘야 "어제까지 되던 게 갑자기
  //   실행에서만 죽는" 상태가 안 된다.
  for (const node of graph.nodes) {
    if (node.type !== "transform") continue;
    const cfg = (node.config ?? {}) as Record<string, unknown>;
    // ★커널보다 엄격하면 **멀쩡한 그래프의 저장을 막는다.** 커널은 `to`가 없으면 `from`으로
    //   폴백하므로 제자리 가공(`{from:"summary", mode:"extract"}`)은 정상 실행된다.
    //   요구할 것은 `from` 하나뿐이다.
    const hasFrom = typeof cfg.from === "string" && cfg.from.trim();
    if (hasFrom) continue;
    const hasConsumes = typeof cfg.consumes === "string" && cfg.consumes.trim();
    issues.push({
      severity: "error",
      code: "transform-unconfigured",
      nodeId: node.id,
      message: t(
        `"${node.label ?? node.type}" 값 가공 단계에 가져올 값이 없습니다.`
          + (hasConsumes ? ` 받는 값이 "${cfg.consumes}"이니 그 이름을 적으면 됩니다.` : "")
          + " 채우지 않으면 실행되지 않습니다.",
        `"${node.label ?? node.type}" transform step has no value to pull.`
          + (hasConsumes ? ` It receives "${cfg.consumes}" — put that name in.` : "")
          + " It will not run until this is filled.",
      ),
    });
  }

  // ★되돌아가는 연결에는 상한이 있어야 한다 — 저장할 때 말해야지, 실행에서 처음 알면
  //   사람은 이미 만들기를 끝냈다고 믿은 뒤다. 실측으로 정확히 그 상태가 났다:
  //   저장은 통과, 실행만 LOOP_BOUND_UNDECLARED로 거절, 그리고 상한을 넣을 화면이 없어
  //   빠져나올 방법도 없었다.
  {
    // ★되돌아가는 연결은 **DFS 색칠**로 찾는다(커널 findBackEdges와 같은 방식).
    //   전위 번호로 `to <= from`을 보는 휴리스틱은 사이클이 하나도 없는 다이아몬드
    //   (A→B, A→X, B→Z, X→Y, Y→Z)에서 Y→Z를 반복으로 오인해 저장을 막는다.
    const adjacency = new Map<string, { to: string; edgeId: string }[]>();
    for (const e of graph.edges) {
      if (!adjacency.has(e.source)) adjacency.set(e.source, []);
      adjacency.get(e.source)!.push({ to: e.target, edgeId: e.id });
    }
    const color = new Map<string, "gray" | "black">();
    const backEdges = new Set<string>();
    const visit = (id: string): void => {
      color.set(id, "gray");
      for (const out of adjacency.get(id) ?? []) {
        const c = color.get(out.to);
        if (c === "gray") backEdges.add(out.edgeId);
        else if (c === undefined) visit(out.to);
      }
      color.set(id, "black");
    };
    // ★커널 findBackEdges와 **같은 시작점 규칙**: 들어오는 연결이 없는 노드부터 돈다.
    //   DFS 색칠에서 어느 엣지가 되돌아가는 연결이 되는지는 시작점에 달려 있다.
    //   순서가 다르면 화면은 A→B에 상한을 물어보고 커널은 B→A를 요구해, 저장은 통과하는데
    //   실행만 거절되고 상한을 넣을 자리는 없는 상태로 되돌아간다.
    const hasIncoming = new Set(graph.edges.map((e) => e.target));
    for (const n of graph.nodes) if (!hasIncoming.has(n.id) && !color.has(n.id)) visit(n.id);
    for (const n of graph.nodes) if (!color.has(n.id)) visit(n.id);

    for (const e of graph.edges) {
      if (!backEdges.has(e.id)) continue;
      const onEdge = (e as { maxIterations?: unknown }).maxIterations;
      const headNode = graph.nodes.find((n) => n.id === e.target);
      const onNode = (headNode?.config as { maxIterations?: unknown } | undefined)?.maxIterations;
      if (typeof onEdge === "number" || typeof onNode === "number") continue;
      issues.push({
        severity: "error",
        code: "loop-bound-missing",
        nodeId: e.source,
        edgeId: e.id,
        message: t(
          `"${headNode?.label ?? e.target}"(으)로 되돌아가는 연결에 반복 횟수가 정해져 있지 않습니다. 그 연결을 눌러 최대 반복 횟수를 정해 주세요 — 정하지 않으면 실행되지 않습니다.`,
          `The connection looping back to "${headNode?.label ?? e.target}" has no iteration limit. Click that connection and set a maximum — it will not run without one.`,
        ),
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
          message: t(
            `"${node.label ?? node.type}" 단계가 {{${v}}} 값을 읽는데, 앞의 어느 단계도 그 값을 만들지 않습니다.`,
            `"${node.label ?? node.type}" reads {{${v}}}, but no earlier step produces it.`,
          ),
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
