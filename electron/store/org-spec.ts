// 정규화된 3-tier 조직 스펙 — 저장/조회 + orgChart 파생.
// 시드 firm은 orgChart(reportsTo 트리)에서 즉시 파생되고(실 agentId 보유),
// 임포트/임의 팀은 LLM 리졸버(Phase 6)가 생성해 여기에 저장한다.
// 오케스트레이터는 이 ResolvedOrg만 보고 실행하므로 소스와 분리된다.
import type {
  InstalledFirm,
  ResolvedDivision,
  ResolvedNode,
  ResolvedOrg,
} from "../../shared/types";
import { getAgentById } from "../mcp/registry";
import { getMeta, setMeta } from "./meta";

const key = (firmId: string) => `orgspec:${firmId}`;

/** firm.orgChart(reportsTo 트리)를 3-tier ResolvedOrg로 파생.
 *  CEO(reportsTo null) → 본부(reportsTo CEO) → 전문가(reportsTo 본부). */
export function resolveFromOrgChart(firm: InstalledFirm): ResolvedOrg {
  const nodes = firm.orgChart;
  const toNode = (n: (typeof nodes)[number]): ResolvedNode => {
    const agent = n.agentId ? getAgentById(n.agentId) : null;
    const name = agent?.name || n.role;
    return {
      id: n.agentId || n.agentSlug,
      name,
      role: n.role,
      agentId: n.agentId || undefined,
      // Runtime prompt authority belongs to the agent package's canonical file.
      // A derived org node contributes only its current organizational role;
      // copying the registry fallback here would append stale prompt bytes after
      // buildEffectiveAgentSystemPrompt() has already loaded the canonical file.
      prompt: `You are ${name}, serving as ${n.role} in this firm. Apply the agent's canonical instructions within this organizational role.`,
    };
  };

  const ceoNode = nodes.find((n) => n.reportsTo === null) ?? nodes[0];
  const ceo: ResolvedNode = ceoNode
    ? toNode(ceoNode)
    : { id: firm.ceoAgentId, name: firm.name, role: "CEO", agentId: firm.ceoAgentId };

  const divisions: ResolvedDivision[] = nodes
    .filter((n) => ceoNode != null && n.reportsTo === ceoNode.agentSlug)
    .map((d) => ({
      ...toNode(d),
      specialists: nodes.filter((s) => s.reportsTo === d.agentSlug).map(toNode),
    }));

  return { source: "orgchart", ceo, divisions };
}

// Identity for matching resolver/blueprint nodes to installed-agent cells.
// MUST be script-agnostic: `[^a-z0-9]` erased every Korean role/name/id to "" so
// Korean teams (the majority) collapsed to empty keys and mis-bound. `\p{L}\p{N}`
// keeps letters+digits across scripts and drops only separators/punctuation.
const orgIdentity = (value: string | undefined): string =>
  (value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Bind resolver/blueprint nodes to the installed-agent cells committed with the firm. */
export function bindResolvedOrgAgentIds(
  firm: InstalledFirm,
  divisions: ResolvedDivision[],
): ResolvedDivision[] {
  const ceo = firm.orgChart.find((node) => node.reportsTo === null) ?? firm.orgChart[0];
  if (!ceo) return divisions;

  const claimed = new Set<string>();
  const match = (
    node: ResolvedNode,
    candidates: typeof firm.orgChart,
  ): (typeof firm.orgChart)[number] | undefined => {
    const id = orgIdentity(node.id);
    const role = orgIdentity(node.role);
    const name = orgIdentity(node.name);
    const ranked = candidates
      .filter((candidate) => !claimed.has(candidate.agentSlug))
      .map((candidate) => {
        const slug = orgIdentity(candidate.agentSlug);
        const candidateRole = orgIdentity(candidate.role);
        let score = 0;
        if (candidate.agentSlug === node.id) score = 100;
        else if (id && slug.endsWith(id)) score = 90;
        else if (role && candidateRole === role) score = 80;
        else if (name && candidateRole === name) score = 70;
        else if (role && slug.includes(role)) score = 60;
        else if (name && slug.includes(name)) score = 50;
        return { candidate, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.candidate.agentSlug.localeCompare(b.candidate.agentSlug));
    const selected = ranked[0]?.candidate;
    if (selected) claimed.add(selected.agentSlug);
    return selected;
  };

  const directReports = firm.orgChart.filter((node) => node.reportsTo === ceo.agentSlug);
  return divisions.map((division) => {
    const divisionRow = match(division, directReports);
    const specialistRows = divisionRow
      ? firm.orgChart.filter((node) => node.reportsTo === divisionRow.agentSlug)
      : [];
    const specialists = division.specialists.map((specialist) => {
      const row = match(specialist, specialistRows);
      return row?.agentId ? { ...specialist, agentId: row.agentId } : specialist;
    });
    return {
      ...division,
      ...(divisionRow?.agentId ? { agentId: divisionRow.agentId } : {}),
      specialists,
    };
  });
}

/** 저장된 스펙(리졸버 산출물)이 있으면 그것을, 없으면 orgChart 파생을 반환. */
export function getResolvedOrg(firm: InstalledFirm): ResolvedOrg {
  const raw = getMeta(key(firm.id));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ResolvedOrg;
      if (parsed && parsed.ceo) return parsed;
    } catch {
      // 손상된 캐시 — orgChart 파생으로 폴백
    }
  }
  return resolveFromOrgChart(firm);
}

/** 리졸버/업그레이드가 생성한 스펙을 영속화 (app config). .agentlas sidecar는 Phase 6. */
export function saveResolvedOrg(firmId: string, org: ResolvedOrg): void {
  setMeta(key(firmId), JSON.stringify(org));
}

/** 저장된 스펙 제거 (재-resolve 강제). */
export function clearResolvedOrg(firmId: string): void {
  try {
    setMeta(key(firmId), "");
  } catch {
    // ignore
  }
}
