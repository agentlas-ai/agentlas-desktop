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
 * 한 줄기(strip)에 넣을 **행** 수 — 전체 단계 수에서 결정적으로 계산한다.
 *
 * ★배치는 위→아래가 기본이다(오너 결정 2026-08-06). 사람이 순서를 읽는 방향이고,
 * 화면은 세로로 스크롤하기 때문에 가로로 늘어지는 것보다 훨씬 잘 읽힌다.
 * 긴 사슬은 접어서 대략 정사각형에 가깝게 만든다 — 위→아래로 흐르다 한 줄기가
 * 다 차면 오른쪽 줄기로 옮겨 다시 위→아래(다음 줄기는 아래→위로 접어 이웃이 붙는다).
 */
export function rowsPerStrip(totalRows: number): number {
  if (totalRows <= 5) return totalRows; // 짧으면 접을 이유가 없다
  return Math.max(5, Math.ceil(Math.sqrt(totalRows * 2)));
}

/** @deprecated 가로 배치 시절 이름. 세로 배치의 `rowsPerStrip`을 쓴다. */
export const columnsPerBand = rowsPerStrip;

/**
 * 그래프를 결정적 **세로 사행(蛇行)** 레이아웃으로 재배치한 새 노드 배열을 반환한다.
 * 위상 깊이가 행이 되어 위→아래로 흐르고, 같은 깊이의 여러 노드는 좌우로 균등 분산한다.
 * 사슬이 길면 줄기를 접어 오른쪽으로 넘긴다.
 */
export function layoutGraph(graph: WorkflowGraph): WorkflowNode[] {
  const depth = computeDepths(graph);
  // 깊이별 노드 그룹 — 이제 깊이는 **행**이다.
  const byRow = new Map<number, WorkflowNode[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!byRow.has(d)) byRow.set(d, []);
    byRow.get(d)!.push(n);
  }
  // 행 인덱스를 0..N-1로 압축(중간이 빈 깊이가 있어도 접기 계산이 일그러지지 않게).
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  const rowOrder = new Map(rows.map((r, i) => [r, i]));
  const totalRows = rows.length;
  const perStrip = rowsPerStrip(totalRows);

  // 줄기별 너비 = 그 줄기에서 가장 붐비는 행의 노드 수. 줄기 사이는 한 칸 더 띈다
  // (되돌아가는 선이 지나갈 자리).
  const stripCount = Math.ceil(totalRows / perStrip);
  const stripWidth: number[] = [];
  for (let b = 0; b < stripCount; b += 1) {
    let maxCols = 1;
    for (const [r, i] of rowOrder) {
      if (Math.floor(i / perStrip) === b) maxCols = Math.max(maxCols, byRow.get(r)!.length);
    }
    stripWidth.push(maxCols * COL_W + COL_W);
  }
  const stripLeft: number[] = [];
  let acc = 0;
  for (let b = 0; b < stripCount; b += 1) { stripLeft.push(acc); acc += stripWidth[b]; }

  const out: WorkflowNode[] = [];
  for (const [row, nodes] of byRow) {
    const i = rowOrder.get(row) ?? 0;
    const strip = Math.floor(i / perStrip);
    let r = i % perStrip;
    // 홀수 줄기는 아래→위 — 접힌 자리에서 이웃 단계가 서로 붙어 있게(뱀 모양).
    if (strip % 2 === 1) r = perStrip - 1 - r;
    const count = nodes.length;
    nodes.forEach((n, col) => {
      // 행 중앙 기준으로 좌우 분산.
      const offset = (col - (count - 1) / 2) * COL_W;
      out.push({
        ...n,
        position: {
          x: NODE_ORIGIN_X + stripLeft[strip] + (stripWidth[strip] - COL_W) / 2 + offset,
          y: NODE_ORIGIN_Y + r * ROW_H,
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
/** 노드 카드의 실측 크기 — 이보다 가까우면 화면에서 겹쳐 글자를 못 읽는다. */
const NODE_W = 230;
const NODE_H = 90;

export function needsLayout(graph: WorkflowGraph): boolean {
  if (graph.nodes.length <= 1) return false;
  // ★예전에는 좌표가 **완전히 같을 때만** 재배치했다. 그래서 청사진이 검증을 +70,
  //   갈림길을 +140만 띄워 놓은 그래프(노드 폭 230)는 "다른 좌표"라 통과했고,
  //   사용자는 카드가 서로 겹쳐 글자를 못 읽는 캔버스를 봤다(실측 2026-08-05).
  //   이제 **실제로 겹치는가**로 판단한다.
  const placed = graph.nodes.map((n) => ({
    x: Math.round(n.position?.x ?? 0),
    y: Math.round(n.position?.y ?? 0),
  }));
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      if (Math.abs(placed[i].x - placed[j].x) < NODE_W
        && Math.abs(placed[i].y - placed[j].y) < NODE_H) return true;
    }
  }
  return false;
}
