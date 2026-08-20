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
import { findGraphContradictions, repairGraphContradictions, requiredPermissionFor } from "../dist/shared/graph-contradictions.js";

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

// 읽기 전용으로 저장됐는데 바깥을 바꾸는 단계가 있는 자동화 — 부를 수 있는 도구가 없는
// 상태로 매번 실행된다. 실측 2026-08-20: 저장된 10개 중 3개가 이 상태였고, 실패 문구는
// 모델을 탓하고 있었다. 실행 중에 물을 일이 아니라 시작에서 한 번 받아 둘 일이다.
const mutatingGraph = {
  version: 1,
  nodes: [node("write", "action", { effect: "mutation" }, "파일로 저장"), node("say", "agent", { effect: "read" }, "요약")],
  edges: [edge("say", "write")],
};
const gap = requiredPermissionFor(mutatingGraph, "read");
check(
  "read-only-with-a-mutating-step-is-named",
  gap?.needs === "write" && gap.because.includes("파일로 저장"),
  "읽기 전용인데 바깥을 바꾸는 단계가 있는 자동화를 못 찾았습니다 — 그 자동화는 매번 실패하고, "
  + "사람은 모델 탓이라는 문구만 봅니다.",
);
check(
  "sufficient-permission-is-not-nagged",
  requiredPermissionFor(mutatingGraph, "write") === null
  && requiredPermissionFor({ version: 1, nodes: [node("say", "agent", { effect: "read" })], edges: [] }, "read") === null,
  "이미 충분한 권한이나, 바깥을 바꾸지 않는 자동화에까지 허용을 요구합니다 — 승인은 최소한이어야 합니다.",
);

// 갈림길 없는 되돌이 — 되돌아갈 곳이 판정이고 그 판정이 값을 만들 때만 고친다.
// ★고친 결과가 **또 죽으면 안 된다.** 실측 2026-08-20: 첫 판이 되돌아가는 쪽만 잇고
//   통과하는 쪽을 비워 둬, 고친 그래프가 NO_MATCHING_EDGE 로 죽었다. 커널은 출구가 아예
//   없는 갈림길은 허용하지만 한쪽만 있으면 거절한다.
const loopNoBranch = {
  version: 1,
  nodes: [
    node("gen", "agent", { produces: "html" }, "만들기"),
    node("chk", "eval", { subject: "html", produces: "verdict" }, "검증"),
    node("save", "action", {}, "저장"),
    node("tell", "output", { effect: "read", text: "끝" }, "알리기"),
  ],
  edges: [edge("gen", "chk"), edge("chk", "save"), edge("save", "tell"),
    { id: "save->chk", source: "save", target: "chk", maxIterations: 1 }],
};
const loopFixed = repairGraphContradictions(loopNoBranch);
const gateOut = loopFixed.graph.edges.filter((e) => e.source === "save-gate");
check(
  "loop-repair-wires-both-sides",
  loopFixed.changed
  && gateOut.some((e) => String(e.sourceHandle) === "false" && e.target === "chk")
  && gateOut.some((e) => String(e.sourceHandle) === "true" && e.target === "tell"),
  "고친 갈림길에 한쪽 길만 있습니다 — 그 판정이 나오면 실행이 NO_MATCHING_EDGE 로 죽습니다.",
);
check(
  "loop-repair-clears-it",
  findGraphContradictions(loopFixed.graph).length === 0,
  "고쳤다는데 같은 모순이 남아 있습니다.",
);

// 되돌아가는 연결이 그 단계의 유일한 출구면(=거기서 끝나는 그래프) 통과 쪽에 이을 곳이
// 없다. 그때는 갈림길을 만들지 않고 되돌아가는 연결만 걷어낸다.
const loopAtTheEnd = {
  version: 1,
  nodes: [node("gen", "agent", { produces: "html" }, "만들기"), node("chk", "eval", { subject: "html", produces: "verdict" }, "검증"), node("save", "action", {}, "저장")],
  edges: [edge("gen", "chk"), edge("chk", "save"), { id: "save->chk", source: "save", target: "chk", maxIterations: 1 }],
};
const endFixed = repairGraphContradictions(loopAtTheEnd);
check(
  "a-loop-with-nowhere-to-pass-to-is-simply-removed",
  endFixed.changed
  && !endFixed.graph.nodes.some((n) => n.id === "save-gate")
  && !endFixed.graph.edges.some((e) => e.source === "save" && e.target === "chk"),
  "이을 곳이 없는데 갈림길을 만들었습니다 — 통과 쪽이 비어 실행이 죽습니다.",
);

/*
 * ★규칙은 한 벌이어야 한다 — "되돌이가 옳은가"를 아는 곳이 늘면 조용히 갈린다.
 *
 * 실측 2026-08-20: 같은 사실을 **세 곳**이 각자 손으로 알고 있었다.
 *   · 커널 run-graph.planGraphLoops  ← 실행을 실제로 거부하는 유일한 권위
 *   · 이 판정기(저장된 그래프를 미리 봄)
 *   · 청사진 graph-blueprint(만들 때)
 * 나머지 둘이 커널을 베낀 사본이면, 커널이 규칙을 바꾸는 날 아무도 모르게 어긋난다.
 * 이 저장소가 반복해서 앓은 "구현 두 벌"이 정확히 이것이다.
 *
 * 그래서 판정기는 커널의 답을 **그대로 옮기고**, 그 배선이 살아 있는지 여기서 지킨다.
 */
{
  const { planGraphLoops } = await import("../dist/electron/workflow/run-graph.js");
  const loopy = {
    version: 1,
    nodes: [
      node("gen", "agent", { produces: "html" }, "만들기"),
      node("chk", "eval", { subject: "html", produces: "verdict" }, "검증"),
      node("save", "action", {}, "저장"),
    ],
    edges: [edge("gen", "chk"), edge("chk", "save"),
      { id: "save->chk", source: "save", target: "chk", maxIterations: 1 }],
  };
  const kernelSaid = planGraphLoops(loopy);
  const viaKernel = findGraphContradictions(loopy, planGraphLoops);
  check(
    "the-kernel-is-the-single-authority-on-loops",
    kernelSaid.ok === false
    && viaKernel.some((f) => f.code === "LOOP_TAIL_NOT_A_BRANCH" && f.reason === kernelSaid.failure.reason),
    "되돌이 판정이 커널의 답을 그대로 옮기지 않습니다 — 규칙 사본이 생겼다는 뜻이고, "
    + "커널이 규칙을 바꾸는 날 조용히 어긋납니다.",
  );
}

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
if (failures.length > 0) {
  console.error("\ngraph-contradictions 게이트 실패:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nRESULT: ${checks.length} checks passed`);
