// 결정적 위상 정렬 → {x,y} 레이아웃. 백엔드 stepsToGraph(x=i*280, y=120)의 렌더러 미러.
//
// 저장된 그래프에는 이미 position이 박혀 있으므로 그대로 존중한다. 이 헬퍼는:
//  (a) position이 없거나 (0,0)으로 뭉친 그래프를 클라이언트에서 재배치할 때,
//  (b) 챗이 만든 그래프를 확인 전 미리보기로 다시 펼칠 때 사용한다.
//
// 알고리즘: Kahn 위상 정렬로 노드를 레인(column) 인덱스로 배치. 같은 레인의 노드는
// y를 세로로 분산(condition fan-out 등). 백엔드와 동일한 상수(COL_W=280, ROW_H=120)를 쓴다.
import type { WorkflowGraph, WorkflowNode } from "./types";

export const COL_W = 280;
export const ROW_H = 120;
const NODE_ORIGIN_X = 0;
const NODE_ORIGIN_Y = 120;

/**
 * 위상 순서로 각 노드에 컬럼 depth를 매긴다(진입 엣지 없는 노드 = depth 0).
 * 사이클이 있으면(방어적) 남은 노드를 마지막 컬럼에 몰아넣는다.
 */
function computeDepths(graph: WorkflowGraph): Map<string, number> {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (!indeg.has(e.target) || !adj.has(e.source)) continue; // dangling edge 방어
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }
  const depth = new Map<string, number>();
  // 진입 0 노드로 시작.
  let frontier = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const id of frontier) depth.set(id, 0);
  const remaining = new Map(indeg);
  const queue = [...frontier];
  while (queue.length) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const next of adj.get(id) ?? []) {
      const nextDepth = Math.max(depth.get(next) ?? 0, d + 1);
      depth.set(next, nextDepth);
      const left = (remaining.get(next) ?? 1) - 1;
      remaining.set(next, left);
      if (left <= 0) queue.push(next);
    }
  }
  // 사이클 등으로 depth 미할당된 노드는 순서 인덱스로 폴백.
  graph.nodes.forEach((n, i) => {
    if (!depth.has(n.id)) depth.set(n.id, i);
  });
  return depth;
}

/**
 * 그래프를 결정적 좌→우 레이아웃으로 재배치한 새 노드 배열을 반환한다.
 * 같은 컬럼에 여러 노드가 있으면 세로로 균등 분산(중앙 정렬).
 */
export function layoutGraph(graph: WorkflowGraph): WorkflowNode[] {
  const depth = computeDepths(graph);
  // 컬럼별 노드 그룹.
  const byCol = new Map<number, WorkflowNode[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!byCol.has(d)) byCol.set(d, []);
    byCol.get(d)!.push(n);
  }
  const out: WorkflowNode[] = [];
  for (const [col, nodes] of byCol) {
    const count = nodes.length;
    nodes.forEach((n, row) => {
      // 컬럼 중앙 기준으로 위아래 분산.
      const offset = (row - (count - 1) / 2) * ROW_H;
      out.push({
        ...n,
        position: {
          x: NODE_ORIGIN_X + col * COL_W,
          y: NODE_ORIGIN_Y + offset,
        },
      });
    });
  }
  // 원래 순서 보존(React Flow key 안정).
  const orderIndex = new Map(graph.nodes.map((n, i) => [n.id, i]));
  out.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
  return out;
}

/**
 * 저장된 그래프가 유효한 position을 이미 가졌는지 판정.
 * 모든 노드가 (0,0)이거나 겹쳐 있으면 재배치가 필요하다고 본다.
 */
export function needsLayout(graph: WorkflowGraph): boolean {
  if (graph.nodes.length <= 1) return false;
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    const key = `${Math.round(n.position?.x ?? 0)}:${Math.round(n.position?.y ?? 0)}`;
    if (seen.has(key)) return true; // 겹침 → 재배치.
    seen.add(key);
  }
  return false;
}
