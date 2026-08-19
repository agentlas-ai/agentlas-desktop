#!/usr/bin/env node
// "알릴 것이 없는 날마다 실패하는" 그래프를 찾아내고 고칠 수 있는지 지킨다.
//
// 배경(2026-08-19~20 실측). 임계값 감시 자동화가 조용한 날마다 죽었다. 계산은 매번
// 정확했고 결과도 옳았는데 실행은 실패로 남았다. 원인은 모양이었다 — 갈림길이
// "alertline 이 비어 있을 수 있다"고 보고 갈라지는데, 그 **앞의** 검증이
// "alertline 은 비어 있으면 안 된다"고 했다. 임계값을 안 넘은 날(=대부분의 날)
// 그 검증이 실행을 죽였다.
//
// 저작 시점 규칙(graph-blueprint.ts)은 새 그래프만 지킨다. 규칙보다 먼저 지어진
// 그래프는 아무도 다시 보지 않아 그 사람의 자동화는 계속 실패한다. 그래서 저장된
// 모양에서도 같은 사실을 보고, 검증을 값이 있는 쪽 가지 안으로 **옮긴다**.
//
// 이 게이트가 지키는 것:
//  1) 그 모양을 실제로 찾아낸다(못 찾으면 아무도 구제되지 않는다 — 첫 판이 라이브
//     그래프 10개에서 0건을 잡았다. 저장된 갈림길이 문장이 아니라 {var, op} 였다).
//  2) 고치면 모순이 사라진다.
//  3) 이미 옳은 모양(갈림길 뒤에 놓인 검증)은 건드리지 않는다 — 오폭은 사람의 검증을
//     망가뜨린다.
import { findGraphContradictions, repairGraphContradictions } from "../dist/shared/graph-contradictions.js";

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) failures.push(`${name}: ${detail}`);
}

const node = (id, type, config, label) => ({ id, type, position: { x: 0, y: 0 }, config, label: label || id });
const edge = (source, target, sourceHandle) => ({ id: `${source}->${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });

// 검증이 갈림길 **앞**에 있는 그래프 — 조용한 날마다 죽는 모양.
const broken = {
  version: 1,
  nodes: [
    node("make", "code", { produces: "alertline" }, "알림 줄 만들기"),
    node("verify", "eval", { subject: "alertline", criteria: "비어있지 않다", produces: "ok" }, "검증"),
    node("branch", "condition", { var: "alertline", op: "truthy" }, "값이 있나?"),
    node("append", "code", { consumes: "alertline" }, "붙이기"),
    node("done", "output", { effect: "read", text: "끝" }, "마무리"),
  ],
  edges: [edge("make", "verify"), edge("verify", "branch"), edge("branch", "append", "true"), edge("branch", "done", "false"), edge("append", "done")],
};

const found = findGraphContradictions(broken);
check(
  "finds-the-shape-that-fails-on-quiet-days",
  found.length === 1 && found[0].subject === "alertline",
  `조용한 날마다 실패하는 모양을 못 찾았습니다(${found.length}건). 못 찾으면 그 사람의 자동화는 계속 실패합니다.`,
);

const repaired = repairGraphContradictions(broken);
check(
  "repair-clears-it",
  repaired.changed && findGraphContradictions(repaired.graph).length === 0,
  "고쳤다고 하는데 모순이 남아 있습니다 — 반쯤 옮긴 그래프가 가장 나쁩니다.",
);
check(
  "repair-moves-instead-of-deleting",
  repaired.graph?.nodes.some((n) => n.id === "verify"),
  "검증을 지웠습니다. 사람이 걸어 둔 검증은 자리만 틀렸을 뿐이고, 지우면 값이 있는 날의 확인까지 사라집니다.",
);
check(
  "repaired-verify-sits-on-the-value-side",
  repaired.graph?.edges.some((e) => e.source === "branch" && e.target === "verify" && String(e.sourceHandle) === "true"),
  "옮긴 검증이 값이 있는 쪽 가지에 없습니다.",
);

// 이미 옳은 모양 — 갈림길 뒤, 값이 있는 쪽에 검증이 있다. 건드리면 안 된다.
const healthy = {
  version: 1,
  nodes: broken.nodes,
  edges: [edge("make", "branch"), edge("branch", "verify", "true"), edge("verify", "append"), edge("branch", "done", "false"), edge("append", "done")],
};
check(
  "leaves-correct-graphs-alone",
  findGraphContradictions(healthy).length === 0 && !repairGraphContradictions(healthy).changed,
  "이미 옳은 모양을 문제로 봅니다 — 오폭은 사람의 검증을 망가뜨립니다.",
);

// 자기 자신으로 돌아오는 연결 — 실측 2026-08-20, 체스 게임 생성 자동화가 이것으로
// LOOP_WITHOUT_EXIT 로 죽었다. 되돌아갈 앞 단계가 없으므로 어떤 뜻으로도 읽히지 않는다.
const selfLooped = {
  version: 1,
  nodes: [node("a", "agent", {}, "만들기"), node("save", "action", {}, "저장하기")],
  edges: [edge("a", "save"), { id: "save->save", source: "save", target: "save", maxIterations: 1 }],
};
const loopFound = findGraphContradictions(selfLooped);
check(
  "finds-self-loop",
  loopFound.some((f) => f.code === "SELF_LOOP_EDGE" && f.nodeId === "save"),
  "자기 자신으로 되돌아가는 연결을 못 찾았습니다 — 그 자동화는 실행할 때마다 멈춥니다.",
);
const loopRepaired = repairGraphContradictions(selfLooped);
check(
  "repair-drops-only-the-self-loop",
  loopRepaired.changed
  && !loopRepaired.graph.edges.some((e) => e.source === e.target)
  && loopRepaired.graph.edges.some((e) => e.source === "a" && e.target === "save"),
  "자기루프를 못 지웠거나, 멀쩡한 연결까지 지웠습니다.",
);

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
if (failures.length > 0) {
  console.error("\ngraph-contradictions 게이트 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
