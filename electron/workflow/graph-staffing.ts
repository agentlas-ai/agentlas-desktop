/**
 * 그래프 슬롯 편성 — 단계가 선언한 **역할**을 실제 에이전트로 채운다.
 *
 * 왜 이게 있나: 자연어로 그래프를 만들면 모든 단계가 자동화 기본 에이전트 하나로 돌았다.
 * "게임 규칙 설계"와 "코드 작성"과 "밸런스 수정"은 성격이 다른 일인데 같은 일꾼이 했다.
 *
 * ★규율은 그래프 전체와 같다: **모델은 역할만 말하고, 실물은 코드가 채운다.**
 *   모델이 에이전트 slug를 직접 쓰면 없는 것을 지어내고, 그 그래프는 실행 때 죽는다.
 *   여기서는 코드가 **실제 인벤토리(설치본 + Hub)를 검색**해서 매핑하므로 지어낼 수 없다.
 *
 * 기본은 Hub다 — 생태계가 돌아야 하고, 로컬·클라우드로 바꾸는 것은 사람이 캔버스에서 한다.
 * 못 찾으면 **비워 둔다**. 아무거나 꽂는 것이 가장 나쁘다(사람은 꽂힌 대로 돌 거라 믿는다).
 */
import type { WorkflowGraph, WorkflowNode, MarketplaceListing } from "../../shared/types";

export interface StaffingCandidateSource {
  /** 설치된 에이전트 — 이미 있으면 공짜이고 즉시 돈다. */
  installed: Array<{ id: string; name: string; tagline?: string }>;
  /** Hub 검색 — 역할 문구로 실제 공개 에이전트를 찾는다. */
  searchHub: (query: string) => Promise<MarketplaceListing[]>;
}

export interface StaffedSlot {
  nodeId: string;
  role: string;
  /** 못 찾았으면 null — 지어내지 않는다. */
  ref: string | null;
  targetType: "agent" | "hub" | null;
  /** Hub는 어느 릴리스인지 봉인해야 나중에 다른 게 실행되지 않는다. */
  targetVersion?: string;
  label?: string;
  source: "installed" | "hub" | "unresolved";
}

/** 역할 문구를 검색 질의로. 사람 말 그대로 던지면 잡음이 많아 앞부분만 쓴다. */
function queryFor(role: string): string {
  return role.trim().replace(/\s+/g, " ").slice(0, 80);
}

/**
 * 설치본 중에 역할과 맞는 것이 있나 — 이름·소개에 역할 단어가 겹치는지로만 본다.
 * ★의미 판단을 여기서 하지 않는다. 애매하면 안 고르고 Hub로 넘긴다.
 */
function matchInstalled(
  role: string,
  installed: StaffingCandidateSource["installed"],
): { id: string; name: string } | null {
  const words = role.toLowerCase().split(/[^a-z0-9가-힣]+/).filter((w) => w.length >= 2);
  if (words.length === 0) return null;
  let best: { id: string; name: string; hits: number } | null = null;
  for (const agent of installed) {
    const hay = `${agent.name} ${agent.tagline ?? ""}`.toLowerCase();
    const hits = words.filter((w) => hay.includes(w)).length;
    if (hits === 0) continue;
    if (!best || hits > best.hits) best = { id: agent.id, name: agent.name, hits };
  }
  // 한 단어만 겹치는 것은 우연일 수 있다 — 두 개 이상일 때만 인정한다.
  return best && best.hits >= 2 ? { id: best.id, name: best.name } : null;
}

/** Hub 결과 중 **실제로 부를 수 있는** 것만. 설치 전용은 지금 못 돌린다. */
function pickHub(rows: MarketplaceListing[]): MarketplaceListing | null {
  const callable = rows.filter((r) => r.callable === true || r.kind === "cloud-callable");
  const pool = callable.length ? callable : [];
  if (pool.length === 0) return null;
  // 신뢰 등급 우선, 그다음 설치 수. 둘 다 같으면 먼저 온 것.
  const grade = (g: string | undefined) => (g === "A" ? 3 : g === "B" ? 2 : g === "C" ? 1 : 0);
  return [...pool].sort((a, b) =>
    grade(b.trustGrade) - grade(a.trustGrade) || (b.installCount ?? 0) - (a.installCount ?? 0))[0] ?? null;
}

/**
 * 그래프의 역할 선언들을 실물로 채운다. 그래프를 바꾸지 않고 **결정만** 돌려준다 —
 * 적용은 호출부가 하고, 사람은 저장 확인 화면에서 그 결정을 본다.
 */
export async function staffGraph(
  graph: WorkflowGraph,
  source: StaffingCandidateSource,
): Promise<StaffedSlot[]> {
  const slots: StaffedSlot[] = [];
  const seen = new Map<string, StaffedSlot>();
  for (const node of graph.nodes) {
    if (node.type !== "agent" && node.type !== "action") continue;
    const role = typeof node.config?.role === "string" ? node.config.role.trim() : "";
    if (!role) continue;
    // 같은 역할은 같은 에이전트로 — 한 그래프 안에서 역할이 갈리면 사람이 이해할 수 없다.
    const cached = seen.get(role);
    if (cached) {
      slots.push({ ...cached, nodeId: node.id });
      continue;
    }
    const local = matchInstalled(role, source.installed);
    let slot: StaffedSlot;
    if (local) {
      slot = { nodeId: node.id, role, ref: local.id, targetType: "agent", label: local.name, source: "installed" };
    } else {
      let rows: MarketplaceListing[] = [];
      try {
        rows = await source.searchHub(queryFor(role));
      } catch {
        rows = []; // 검색 실패는 편성 실패지 그래프 실패가 아니다 — 비워 두고 넘어간다.
      }
      const hub = pickHub(rows);
      slot = hub
        ? {
          nodeId: node.id, role, ref: hub.slug, targetType: "hub",
          ...(hub.packageHash ? { targetVersion: hub.packageHash } : {}),
          label: hub.name, source: "hub",
        }
        : { nodeId: node.id, role, ref: null, targetType: null, source: "unresolved" };
    }
    seen.set(role, slot);
    slots.push(slot);
  }
  return slots;
}

/** 편성 결정을 그래프에 적용한다. 못 찾은 슬롯(ref: null)은 **건드리지 않는다**. */
export function applyStaffing(graph: WorkflowGraph, slots: StaffedSlot[]): WorkflowGraph {
  const byNode = new Map(slots.filter((s) => s.ref).map((s) => [s.nodeId, s]));
  if (byNode.size === 0) return graph;
  const nodes: WorkflowNode[] = graph.nodes.map((node) => {
    const slot = byNode.get(node.id);
    if (!slot?.ref) return node;
    return {
      ...node,
      config: {
        ...node.config,
        ref: slot.ref,
        ...(slot.targetType ? { targetType: slot.targetType } : {}),
        // ★Hub는 릴리스를 봉인한다 — 안 하면 어느 날 다른 판이 실행된다.
        ...(slot.targetVersion ? { targetVersion: slot.targetVersion } : {}),
      },
    };
  });
  return { ...graph, nodes };
}
