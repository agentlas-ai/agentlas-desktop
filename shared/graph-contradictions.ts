import { nodeCanChangeTheOutsideWorld } from "./graph-node-protocol";
/**
 * 이미 **저장된** 그래프에서 "평상시마다 실패하는 모양"을 찾아낸다.
 *
 * 배경(2026-08-19~20 실측). 임계값 감시 자동화에서 빌더가 `alertline` 에
 * "비어있지 않고 채워졌다" 검증을 걸고 **바로 다음에** `alertline` 에 값이 있는지로
 * 분기했다. 임계값을 안 넘은 날(=대부분의 날) alertline 은 정당하게 비고, 검증이
 * 그 값을 못 찾아 실행이 죽는다. 계산은 정확했고 결과도 옳았는데 자동화는 실패로 남았다.
 *
 * 저작 시점의 같은 규칙은 `graph-blueprint.ts` 에 있고 **새 그래프**를 지킨다.
 * 그런데 규칙보다 먼저 지어진 그래프는 아무도 다시 보지 않는다 — 그 사람의 자동화는
 * 규칙이 생긴 뒤에도 매일 실패한다. 그래서 저장된 모양에서도 같은 사실을 본다.
 *
 * ★고치지 않는다. 사람의 자동화를 말없이 바꾸면, 멈춰 있는 실행의 재개가 digest 불일치로
 *   거부되고(always-allow 사고와 같은 기전), 무엇이 바뀌었는지 아무도 모른다.
 *   여기서는 **무엇이 왜 틀렸고 어디로 옮기면 되는지**까지만 말한다.
 */

import type { WorkflowGraph, WorkflowNode } from "./types";

export type GraphContradiction = {
  code: "EMPTY_ALLOWED_BUT_VERIFIED_NONEMPTY" | "SELF_LOOP_EDGE" | "LOOP_TAIL_NOT_A_BRANCH";
  nodeId: string;
  nodeLabel: string;
  /** 문제의 값 이름(검증 대상이자 갈림길의 판단 대상). */
  subject: string;
  branchNodeId: string;
  reason: string;
  fix: string;
};

function str(config: Record<string, unknown> | undefined, key: string): string {
  const value = config?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** `{{name}}` 안의 이름들. 갈림길이 무엇을 보고 정하는지는 조건식에 적혀 있다. */
function referencedVars(text: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * 갈림길이 "이 값이 비어 있을 수 있다"고 말하는가.
 *
 * 존재/비어있음만 보는 조건이어야 한다 — `{{x}} > 5` 처럼 내용을 비교하는 조건은
 * 비어 있어도 된다는 뜻이 아니므로 대상이 아니다.
 */
function emptinessTestedVar(node: WorkflowNode): string | null {
  if (node.type !== "condition") return null;
  /*
   * ★저장된 갈림길은 문장이 아니라 **구조**다: `{ var, op }`. 실측 2026-08-20: 처음에
   *   `expression` 같은 문장 필드를 찾다가 라이브 그래프 10개에서 0건을 잡았다 — 결함이
   *   있는 그래프를 눈앞에 두고도 못 봤다. 저장된 모양을 먼저 열어 보고 맞춘다.
   */
  const structuredVar = str(node.config, "var");
  const op = str(node.config, "op").toLowerCase();
  if (structuredVar && (op === "truthy" || op === "falsy")) return structuredVar;

  const expr = str(node.config, "expression") || str(node.config, "condition") || str(node.config, "text");
  if (!expr) return null;
  const names = referencedVars(expr);
  if (names.length !== 1) return null;
  // "값이 있으면 / 비어있지 않으면" 계열만. 내용 비교(>, <, ==, contains …)는 제외한다.
  const bare = expr.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, "").trim();
  const looksLikeEmptinessTest = bare === ""
    || /^(has a value|is not empty|비어\s*있지\s*않|값이\s*있|is empty|비어\s*있)/i.test(bare)
    || /^(truthy|falsy)$/i.test(bare);
  return looksLikeEmptinessTest ? names[0] : null;
}

/**
 * 되돌아가는 연결(back edge)을 실제로 판정한다 — DFS 로 지금 내려온 길 위의 노드를
 * 다시 가리키는 연결만 세운다.
 *
 * ★배열 순서로 "뒤로 감"을 판정하면 안 된다. 노드가 저장된 순서는 그릴 때의 순서일 뿐
 *   실행 순서가 아니어서, 멀쩡한 앞으로 가는 연결을 반복으로 오폭한다. 오폭은 "당신의
 *   자동화가 고장났다"고 거짓으로 말하는 것이라 못 잡는 것보다 나쁠 수 있다.
 */
function findBackEdgeIds(graph: WorkflowGraph): Set<string> {
  const out = new Set<string>();
  const outgoing = new Map<string, { id: string; target: string }[]>();
  for (const node of graph.nodes) outgoing.set(node.id, []);
  for (const edge of graph.edges) outgoing.get(edge.source)?.push({ id: edge.id, target: edge.target });

  const state = new Map<string, 0 | 1 | 2>(); // 0=미방문 1=내려가는 중 2=끝
  const walk = (id: string): void => {
    state.set(id, 1);
    for (const next of outgoing.get(id) ?? []) {
      const seen = state.get(next.target) ?? 0;
      if (seen === 1) out.add(next.id); // 지금 내려온 길 위 → 되돌아가는 연결
      else if (seen === 0) walk(next.target);
    }
    state.set(id, 2);
  };
  for (const node of graph.nodes) if ((state.get(node.id) ?? 0) === 0) walk(node.id);
  return out;
}

/** 앞뒤 관계 — 엣지를 따라 from 에서 to 에 닿는가(반복 엣지도 그대로 따른다). */
function reaches(graph: WorkflowGraph, from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    for (const edge of graph.edges) {
      if (edge.source !== at || seen.has(edge.target)) continue;
      if (edge.target === to) return true;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }
  return false;
}

/**
 * 이 그래프가 "알릴 것이 없는 날"에 실패하는가.
 *
 * 잡는 모양은 하나다: 갈림길이 비어 있어도 된다고 말한 값에, **그 갈림길이 정하기 전에**
 * 도는 검증이 "비어 있으면 안 된다"고 말한다.
 */
/**
 * 커널의 되돌이 판정. `shared/` 가 `electron/` 을 직접 import 하면 순환이 되므로 주입받는다.
 * 안 주면 아래의 자체 판정으로 내려가지만, 그건 **사본**이라 커널과 어긋날 수 있다 —
 * 부르는 쪽은 되도록 커널 것을 넘긴다(electron/workflow/run-graph 의 planGraphLoops).
 */
export type LoopPlanner = (graph: WorkflowGraph) =>
  | { ok: true }
  | { ok: false; nodeId: string; failure: { code: string; reason: string; nextAction: string } };

export function findGraphContradictions(
  graph: WorkflowGraph | null | undefined,
  planLoops?: LoopPlanner,
): GraphContradiction[] {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return [];
  const found: GraphContradiction[] = [];

  /*
   * ★자기 자신으로 돌아오는 연결. 실측 2026-08-20: 체스 게임 생성 자동화에
   *   `step2 → step2` 가 있어 실행이 LOOP_WITHOUT_EXIT 로 죽었다. 한 단계가 자기
   *   다음으로 자기를 가리키는 것은 어떤 뜻으로도 읽히지 않는다 — 되돌아갈 앞 단계가
   *   없으므로 다시 할 일도 없다. 애매하지 않으니 지우는 것이 안전하다.
   */
  for (const edge of graph.edges) {
    if (edge.source !== edge.target) continue;
    const node = graph.nodes.find((n) => n.id === edge.source);
    const label = node?.label || edge.source;
    found.push({
      code: "SELF_LOOP_EDGE",
      nodeId: edge.source,
      nodeLabel: label,
      subject: "",
      branchNodeId: edge.source,
      reason: `"${label}"가 자기 자신으로 되돌아가는 연결을 갖고 있습니다. 되돌아갈 앞 단계가 없어 실행이 여기서 멈춥니다.`,
      fix: `"${label}"에서 자기 자신으로 가는 연결을 지우세요. 다시 해야 할 앞 단계가 있다면 그 단계로 연결하세요.`,
    });
  }

  /*
   * ★되돌아가는 연결의 꼬리는 갈림길이어야 한다(커널 계약, planGraphLoops). 액션이나
   *   검증에서 곧장 되돌아가면 커널이 실행 자체를 거부한다 — 사람은 자동화를 켜 두고
   *   있다가 실행할 때가 되어서야 안다. 실측 2026-08-20: 체스 게임 생성 자동화가 여기에
   *   걸려 있었다(빌더의 지금 모델은 되돌이를 갈림길에만 붙이므로 그 이전 모양이다).
   *
   *   ★고치지 않는다. "무엇을 보고 다시 할지"는 사람이 정할 일이고, 여기서 지어내면
   *     같은 것을 계속 다시 하는 반복이 되거나 사람이 원한 재시도가 사라진다.
   *     미리 이름으로 말해 주는 데까지가 여기 몫이다.
   */
  const nodeIndex = new Map(graph.nodes.map((n) => [n.id, n] as const));
  /*
   * ★규칙을 베끼지 않고 **커널에게 묻는다.**
   *
   *   첫 판은 `tail.type === "condition"` 를 여기 손으로 다시 적었다. 그러면 같은 사실을
   *   아는 곳이 세 곳이 된다 — 커널(planGraphLoops), 여기, 청사진. 실측 2026-08-20:
   *   이미 세 곳이 각자 알고 있었고, 실행을 실제로 거부하는 권위는 **커널 하나뿐**이다.
   *   나머지가 베낀 사본이면 커널이 규칙을 바꾸는 날 조용히 어긋난다.
   *
   *   이 저장소가 반복해서 앓은 병이 정확히 이것이라("구현 두 벌"), 판정은 커널의 답을
   *   그대로 옮긴다. 여기 몫은 **그 거부를 실행 전에 미리 말해 주는 것**뿐이다.
   */
  const loopPlan = planLoops ? planLoops(graph) : null;
  if (loopPlan && loopPlan.ok === false && loopPlan.failure?.code === "LOOP_WITHOUT_EXIT") {
    const tail = nodeIndex.get(loopPlan.nodeId);
    const head = graph.edges.find((e) => e.source === loopPlan.nodeId && e.target !== e.source);
    found.push({
      code: "LOOP_TAIL_NOT_A_BRANCH",
      nodeId: loopPlan.nodeId,
      nodeLabel: tail?.label || loopPlan.nodeId,
      subject: "",
      branchNodeId: head?.target ?? loopPlan.nodeId,
      // 커널이 이미 사람 말로 적어 둔 사유를 그대로 쓴다 — 두 번째 문장을 짓지 않는다.
      reason: loopPlan.failure.reason,
      fix: loopPlan.failure.nextAction,
    });
  }
  const backEdges = findBackEdgeIds(graph);
  for (const edge of loopPlan ? [] : graph.edges) {
    if (edge.source === edge.target) continue; // 자기루프는 위에서 이미 말했다
    if (!backEdges.has(edge.id)) continue;
    const tail = nodeIndex.get(edge.source);
    const head = nodeIndex.get(edge.target);
    if (!tail || !head || tail.type === "condition") continue;
    found.push({
      code: "LOOP_TAIL_NOT_A_BRANCH",
      nodeId: tail.id,
      nodeLabel: tail.label || tail.id,
      subject: "",
      branchNodeId: head.id,
      reason:
        `"${tail.label || tail.id}"에서 "${head.label || head.id}"(으)로 되돌아가는데, 되돌아갈지 말지를 `
        + "정하는 갈림길이 없습니다. 이 자동화는 실행할 때마다 시작 전에 거부됩니다.",
      fix:
        `"${tail.label || tail.id}" 뒤에 갈림길 단계를 넣고, 참·거짓 중 한쪽만 `
        + `"${head.label || head.id}"(으)로 되돌아가게 이으세요. 무엇을 보고 다시 할지는 `
        + "그 자동화를 만든 사람만 정할 수 있어 자동으로 고치지 않습니다.",
    });
  }

  const branches = graph.nodes
    .map((node) => ({ node, subject: emptinessTestedVar(node) }))
    .filter((row): row is { node: WorkflowNode; subject: string } => Boolean(row.subject));
  if (branches.length === 0) return found;

  for (const node of graph.nodes) {
    if (node.type !== "eval") continue;
    const subject = str(node.config, "subject");
    if (!subject) continue;
    const branch = branches.find((b) => b.subject === subject);
    if (!branch) continue;
    // ★위치를 본다. 갈림길이 정한 **뒤**(값이 있는 쪽)에 놓인 검증은 비어 있는 날 아예 돌지
    //   않으므로 문제가 아니다 — 그게 우리가 안내하는 바로 그 모양이다.
    if (!reaches(graph, node.id, branch.node.id)) continue;
    found.push({
      code: "EMPTY_ALLOWED_BUT_VERIFIED_NONEMPTY",
      nodeId: node.id,
      nodeLabel: node.label || node.id,
      subject,
      branchNodeId: branch.node.id,
      reason:
        `"${branch.node.label || branch.node.id}"는 "${subject}"가 비어 있을 수 있다고 보고 갈라지는데, `
        + `그 앞의 "${node.label || node.id}"는 "${subject}"가 비어 있으면 안 된다고 봅니다. `
        + "알릴 것이 없는 날이 정상인 자동화에서는 그 정상인 날마다 실행이 실패합니다.",
      fix:
        `"${node.label || node.id}" 검증을 "${branch.node.label || branch.node.id}"의 `
        + "**값이 있는 쪽 가지 안으로** 옮기세요. 그러면 값이 있는 날에만 검증이 돌고, "
        + "비어 있는 날은 갈림길이 조용히 지나갑니다.",
    });
  }
  return found;
}

/**
 * 찾은 모순을 **실제로** 고친다 — 검증을 갈림길의 "값이 있는 쪽" 가지 안으로 옮긴다.
 *
 * 옮기기는 엣지 세 줄의 수술이다:
 *   (앞) → 검증 → (갈림길)      을
 *   (앞) → 갈림길 ─yes→ 검증 → (원래 yes 였던 곳)   으로 바꾼다.
 *
 * ★지우지 않는다. 사람이 걸어 둔 검증은 그 사람이 원한 것이고, 자리만 틀렸다.
 *   지워 버리면 값이 있는 날의 확인까지 같이 사라진다.
 * ★고칠 수 없는 모양이면 **아무것도 바꾸지 않는다**(changed=false). 반쯤 옮긴 그래프가
 *   가장 나쁘다.
 */
export function repairGraphContradictions(
  graph: WorkflowGraph | null | undefined,
): { changed: boolean; graph: WorkflowGraph | null; movedNodeIds: string[] } {
  const items = findGraphContradictions(graph);
  if (!graph || items.length === 0) return { changed: false, graph: graph ?? null, movedNodeIds: [] };

  const next: WorkflowGraph = JSON.parse(JSON.stringify(graph)) as WorkflowGraph;
  const moved: string[] = [];

  for (const item of items) {
    if (item.code === "SELF_LOOP_EDGE") {
      const before = next.edges.length;
      next.edges = next.edges.filter((e) => !(e.source === item.nodeId && e.target === item.nodeId));
      if (next.edges.length !== before) moved.push(item.nodeId);
      continue;
    }
    if (item.code === "LOOP_TAIL_NOT_A_BRANCH") {
      /*
       * ★무엇을 보고 다시 할지는 **되돌아가는 그 단계 자신이 말해 준다.** 되돌아갈 곳이
       *   판정 단계이고 그 판정이 값을 만든다면(`produces`), 그 값이 곧 "다시 할까"의 근거다.
       *   커널이 스스로 안내하는 모양이 정확히 이것이다 — "갈림길 단계를 넣고, 참·거짓 중
       *   한쪽만 되돌아가게 이으세요"(planGraphLoops 의 nextAction).
       *
       *   근거가 없으면(판정이 아니거나 값을 안 만들면) **고치지 않는다.** 그때는 지어내는
       *   것이 되고, 사람이 원한 재시도가 사라지거나 같은 것을 계속 다시 하는 반복이 된다.
       */
      const head = next.nodes.find((n) => n.id === item.branchNodeId);
      const verdict = head && head.type === "eval" ? str(head.config, "produces") : "";
      if (!head || !verdict) continue;
      const backEdge = next.edges.find((e) => e.source === item.nodeId && e.target === head.id);
      if (!backEdge) continue;

      const gateId = `${item.nodeId}-gate`;
      if (next.nodes.some((n) => n.id === gateId)) continue;
      const tail = next.nodes.find((n) => n.id === item.nodeId);
      /*
       * ★갈림길에는 **양쪽 갈 곳**이 있어야 한다. 커널은 출구가 아예 없는 갈림길은
       *   허용하지만(거기서 끝), 한쪽만 있으면 NO_MATCHING_EDGE 로 죽인다.
       *   실측 2026-08-20: 첫 판이 되돌아가는 쪽(거짓)만 잇고 통과하는 쪽(참)을 비워 둬,
       *   고친 그래프가 "통과했는데 갈 곳이 없다"로 죽었다 — 수리가 새 결함을 만들었다.
       *
       *   통과했을 때 갈 곳은 그 단계의 원래 다음 단계다. 그런데 되돌아가는 연결이
       *   그 단계의 **유일한** 출구라면(=거기서 끝나는 그래프) 통과 쪽에 이을 곳이 없다.
       *   그때는 갈림길을 만들지 않고 되돌아가는 연결만 걷어낸다 — 돌아가 봐야 아무것도
       *   달라지지 않는 자리이고, 남겨 두면 그 자동화는 아예 실행되지 않는다.
       */
      const forward = next.edges.find((e) => e.source === item.nodeId && e.target !== head.id);
      if (!forward) {
        next.edges = next.edges.filter((e) => e !== backEdge);
        moved.push(item.nodeId);
        continue;
      }
      next.nodes.push({
        id: gateId,
        type: "condition",
        position: { x: (tail?.position.x ?? 0) + 220, y: tail?.position.y ?? 0 },
        config: { var: verdict, op: "truthy" },
        label: `${head.label || head.id} 통과했나?`,
      });
      // 되돌아가던 연결을 갈림길 뒤로 옮긴다 — 통과 못 했을 때만 되돌아간다.
      backEdge.target = gateId;
      backEdge.sourceHandle = undefined;
      delete (backEdge as { maxIterations?: number }).maxIterations;
      const rounds = typeof backEdge.maxIterations === "number" ? backEdge.maxIterations : 1;
      next.edges.push({
        id: `${gateId}-retry`,
        source: gateId,
        target: head.id,
        sourceHandle: "false",
        maxIterations: rounds,
      });
      // 통과하면 원래 가던 곳으로 — 갈림길에 한쪽만 이으면 커널이 거절한다.
      next.edges.push({
        id: `${gateId}-pass`,
        source: gateId,
        target: forward.target,
        sourceHandle: "true",
      });
      next.edges = next.edges.filter((e) => e !== forward);
      moved.push(gateId);
      continue;
    }
    // 나머지 자동 수리는 "비어도 되는 값에 걸린 검증" 하나뿐이다.
    if (item.code !== "EMPTY_ALLOWED_BUT_VERIFIED_NONEMPTY") continue;
    const evalId = item.nodeId;
    const branchId = item.branchNodeId;
    const incoming = next.edges.filter((e) => e.target === evalId);
    const outgoing = next.edges.filter((e) => e.source === evalId);
    // 갈림길의 "값이 있는 쪽" 가지. 핸들 이름이 없으면 어디로 옮길지 정할 수 없다.
    const yesEdge = next.edges.find(
      (e) => e.source === branchId && String(e.sourceHandle ?? "").toLowerCase() === "true",
    );
    // 단순한 한 줄짜리 자리만 옮긴다 — 갈라지거나 합쳐지는 자리는 사람이 봐야 한다.
    if (!yesEdge || incoming.length !== 1 || outgoing.length !== 1) continue;

    const before = incoming[0];
    const after = outgoing[0];
    // (앞) → 검증 을 (앞) → (검증 다음) 으로 이어 붙여 검증을 줄에서 뺀다.
    before.target = after.target;
    next.edges = next.edges.filter((e) => e !== after);
    // 갈림길의 yes 가 검증을 먼저 거치게 한다.
    const yesTarget = yesEdge.target;
    yesEdge.target = evalId;
    next.edges.push({
      id: `${evalId}-to-${yesTarget}`,
      source: evalId,
      target: yesTarget,
    });
    moved.push(evalId);
  }

  if (moved.length === 0) return { changed: false, graph, movedNodeIds: [] };
  return { changed: true, graph: next, movedNodeIds: moved };
}

/**
 * 이 자동화가 **자기 권한 때문에** 구조적으로 실패하는가.
 *
 * 실측 2026-08-20: 저장된 자동화 10개 중 3개가 `execution_permission = "read"` 인데
 * 그래프에 "바깥을 바꾼다"고 선언된 단계를 갖고 있었다(주간 요약의 이메일 전송,
 * 해커뉴스의 파일 저장 등). 읽기 권한은 쓰기 도구를 이름으로 막으므로, 그 단계는
 * **부를 수 있는 도구가 하나도 없는 상태**로 실행된다. 그리고 실패 문구는 모델을
 * 탓한다 — "도구를 한 번도 호출하지 않았습니다".
 *
 * 사람에게 실행 중에 물어서 풀 일이 아니다. 필요한 권한은 **시작할 때 한 번** 받아
 * 저장해 두면 그 뒤로는 묻지 않는다(오너 지시 2026-08-20: 승인은 최소한으로,
 * 필요한 것은 그래프 시작에서 항상허용으로).
 *
 * 돌려주는 것: 필요한 권한과 그 근거가 되는 단계들. 없으면 null.
 */
export function requiredPermissionFor(
  graph: WorkflowGraph | null | undefined,
  current: string | null | undefined,
): { needs: "write"; current: string; because: string[] } | null {
  const now = String(current ?? "").trim().toLowerCase();
  if (now !== "read") return null; // write·full 은 이미 충분하다
  if (!graph || !Array.isArray(graph.nodes)) return null;
  const because = graph.nodes
    .filter((n) => nodeCanChangeTheOutsideWorld(n as { type?: string; config?: Record<string, unknown> }))
    .map((n) => n.label || n.id);
  if (because.length === 0) return null;
  return { needs: "write", current: now, because };
}

/** 사람이 읽는 한 화면. 무엇이 왜 틀렸고 어디로 옮기면 되는지까지 말한다. */
export function renderGraphContradictions(name: string, items: GraphContradiction[]): string {
  if (items.length === 0) return `${name}: 평상시 실패로 이어지는 모양은 없습니다.`;
  const lines = [`${name}: ${items.length}건`];
  for (const item of items) {
    lines.push(`  ✗ ${item.nodeLabel} — ${item.reason}`);
    lines.push(`    고치는 법: ${item.fix}`);
  }
  return lines.join("\n");
}
