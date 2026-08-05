// Graph Architect — 사용자의 한 문장을 그래프 변경 **제안**으로 바꾼다.
//
// 이 모듈은 모델을 부르지 않는다. 프롬프트를 만들고, 모델이 돌려준 텍스트를 엄격하게
// 읽는 두 가지만 한다. 모델 호출은 호출부가 주입한다 — 그래야 파서를 모델 없이 전부 시험할 수 있고,
// 파서가 느슨해서 생기는 사고(형태가 어긋난 출력이 패치로 둔갑)를 게이트로 막을 수 있다.
//
// 읽기 규칙은 하나다: **모르는 모양이면 거절한다.** 고쳐 읽거나 일부만 살리지 않는다.
// 변경 제안에서 "대충 읽어 살린 부분"은 사용자가 승인한 적 없는 변경이 된다.
import type { WorkflowGraph } from "../../shared/types";
import type { GraphPatch, GraphPatchOp } from "./graph-patch";

const MAX_OPS = 24;

export type GraphPatchProposalParse =
  | { ok: true; patch: GraphPatch }
  | { ok: false; code: string; reason: string; nextAction: string };

/**
 * 모델에게 보낼 지시. 그래프의 현재 모양을 **값까지** 함께 준다.
 *
 * ★예전에는 `configKeys`(칸 이름만)를 줬다. 그러면 모델은 "이 노드를 이렇게 고쳐줘"를
 *   받아도 지금 뭐가 적혀 있는지 모른 채 고친다 — 프롬프트 본문도, 판정 기준도,
 *   갈림길의 조건값도 못 본다. "이게 무슨 그래프인지" 알 단서가 라벨뿐이었다.
 *   사람이 노드에 달아 둔 주석(config.note)도 여기 실려 모델의 지시가 된다.
 */
export function buildGraphArchitectPrompt(graph: WorkflowGraph, goal?: string | null): string {
  const shape = {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label ?? null,
      config: node.config ?? {},
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(typeof edge.maxIterations === "number" ? { maxIterations: edge.maxIterations } : {}),
    })),
  };
  return [
    "You edit an automation graph by PROPOSING a change. You never apply anything.",
    "Return ONLY compact JSON: {\"ops\":[...],\"rationale\":\"<one short sentence>\"}.",
    "Allowed op values: addNode, editNode, removeNode, addEdge, removeEdge, setPolicy, setTrigger.",
    "addNode needs `node` ({id,type,label,config}); editNode/setPolicy need `nodeId` and `config`;",
    "removeNode needs `nodeId`; addEdge needs `edge` ({id,source,target[,sourceHandle][,maxIterations]});",
    "removeEdge needs `edgeId`; setTrigger needs `config`.",
    "Node types: trigger, agent, tool, action, condition, transform, output, eval, subgraph, code.",
    "  · eval judges an upstream value: config {subject:\"<var name>\", produces:\"<one word>\",",
    "    items:[{text:\"<atomic, checkable>\", kind:\"must\"|\"mustNot\"}]} — it writes",
    "    \"pass\"/\"fail\" and <produces>_reason. Propose 2-5 must items (what must exist)",
    "    plus 1-3 mustNot items (common failure modes: invented numbers, placeholder text).",
    "    Items must be atomic — 'The CSV has a numeric price column', not 'The data looks good'.",
    "    To add verification to a graph: eval after the step, then a condition on its verdict,",
    "    with a bounded edge back to the step (maxIterations) and a forward edge onward.",
    "  · code runs a script YOU write for EXACT computation or data-shaping a chat model would get",
    "    quietly wrong (number math, parsing, spreadsheets): config {code:\"<script>\",",
    "    codeLang:\"python\"|\"js\", note:\"<what it does>\"}. Upstream values arrive as `vars`;",
    "    set `result` to what the next step reads. Never propose a code node with empty code.",
    "  · subgraph calls another automation: config {graphRef:\"<automation id>\", input:\"...\"}.",
    "A step that changes something outside must declare config.effect = \"mutation\".",
    "Every edge leaving a condition node must set sourceHandle to \"true\" or \"false\".",
    "An edge that loops back to an earlier step must set maxIterations (a number >= 1) —",
    "  unbounded repetition is rejected at run time, so a loop without it is a broken proposal.",
    "Nodes may carry config.note — a comment the person wrote on that node. Treat it as their",
    "  instruction for that step; when they ask for changes, notes tell you what they meant.",
    "Do not invent ids that are not in the graph below, and do not reuse an existing id for a new node.",
    "If the request cannot be expressed as these ops, return {\"ops\":[]} — do not approximate.",
    "",
    ...(goal?.trim() ? [`This automation exists to: ${goal.trim()}`] : []),
    `Current graph: ${JSON.stringify(shape)}`,
  ].join("\n");
}

function firstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

const OP_REQUIREMENTS: Record<string, (op: Record<string, unknown>) => boolean> = {
  addNode: (op) => !!op.node && typeof op.node === "object" && typeof (op.node as { id?: unknown }).id === "string",
  editNode: (op) => typeof op.nodeId === "string" && !!op.config && typeof op.config === "object",
  setPolicy: (op) => typeof op.nodeId === "string" && !!op.config && typeof op.config === "object",
  removeNode: (op) => typeof op.nodeId === "string",
  addEdge: (op) => !!op.edge && typeof op.edge === "object" &&
    typeof (op.edge as { id?: unknown }).id === "string" &&
    typeof (op.edge as { source?: unknown }).source === "string" &&
    typeof (op.edge as { target?: unknown }).target === "string",
  removeEdge: (op) => typeof op.edgeId === "string",
  setTrigger: (op) => !!op.config && typeof op.config === "object",
};

const reject = (code: string, reason: string, nextAction: string): GraphPatchProposalParse => ({
  ok: false, code, reason, nextAction,
});

/**
 * 모델 출력에서 제안을 읽는다. 형태가 조금이라도 어긋나면 거절한다.
 * 여기서 관대하면, 승인 화면에는 사용자가 요청한 적 없는 변경이 떠 있게 된다.
 */
export function parseGraphPatchProposal(text: string | null | undefined): GraphPatchProposalParse {
  const raw = firstJsonObject(String(text ?? ""));
  if (!raw) {
    return reject(
      "ARCHITECT_OUTPUT_UNREADABLE",
      "고칠 내용을 만들지 못했습니다.",
      "무엇을 어떻게 바꾸고 싶은지 한 문장으로 다시 말씀해 주세요.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject(
      "ARCHITECT_OUTPUT_UNREADABLE",
      "고칠 내용을 만들지 못했습니다.",
      "무엇을 어떻게 바꾸고 싶은지 한 문장으로 다시 말씀해 주세요.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reject("ARCHITECT_OUTPUT_UNREADABLE", "고칠 내용을 만들지 못했습니다.", "다시 한 문장으로 말씀해 주세요.");
  }
  const ops = (parsed as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) {
    return reject("ARCHITECT_OUTPUT_UNREADABLE", "고칠 내용을 만들지 못했습니다.", "다시 한 문장으로 말씀해 주세요.");
  }
  if (ops.length === 0) {
    // 모델이 "이 요청은 이 연산들로 표현할 수 없다"고 말한 경우. 억지로 근사하지 않은 것이므로
    // 실패가 아니라 정직한 빈 제안이며, 사용자에게는 다르게 물어보라고 안내한다.
    return reject(
      "ARCHITECT_NO_CHANGE",
      "요청을 그래프 변경으로 옮기지 못했습니다.",
      "어떤 단계를 추가·수정·삭제할지 구체적으로 말씀해 주시면 다시 시도합니다.",
    );
  }
  if (ops.length > MAX_OPS) {
    return reject(
      "ARCHITECT_OUTPUT_TOO_LARGE",
      `한 번에 ${ops.length}개를 바꾸려 합니다. 사람이 확인하기 어려운 크기입니다.`,
      "요청을 몇 단계로 나눠서 말씀해 주세요.",
    );
  }
  const cleaned: GraphPatchOp[] = [];
  for (const candidate of ops) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return reject("ARCHITECT_OUTPUT_MALFORMED", "변경 항목 하나의 형태가 어긋났습니다.", "다시 시도해 주세요.");
    }
    const op = candidate as Record<string, unknown>;
    const kind = typeof op.op === "string" ? op.op : null;
    const check = kind ? OP_REQUIREMENTS[kind] : undefined;
    if (!kind || !check) {
      // 모르는 연산은 여기서 버리지 않고 그대로 통과시킨다 — 어떤 연산이 왔는지는
      // 패치 계약(evaluateGraphPatch)이 사용자에게 이름과 함께 보고해야 하기 때문이다.
      cleaned.push({ op: kind as GraphPatchOp["op"] });
      continue;
    }
    if (!check(op)) {
      return reject(
        "ARCHITECT_OUTPUT_MALFORMED",
        `변경 항목 "${kind}"에 필요한 값이 빠졌습니다.`,
        "다시 시도하거나, 요청을 조금 더 구체적으로 말씀해 주세요.",
      );
    }
    cleaned.push(op as unknown as GraphPatchOp);
  }
  const rationale = (parsed as { rationale?: unknown }).rationale;
  return {
    ok: true,
    patch: {
      ops: cleaned,
      ...(typeof rationale === "string" && rationale.trim() ? { rationale: rationale.trim().slice(0, 400) } : {}),
    },
  };
}
