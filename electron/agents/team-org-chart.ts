import type { FirmOrgNode, ResolvedOrg } from "../../shared/types";
import { type ScanMember } from "./folder-scan";

function deptLabel(name: string): string {
  return name.replace(/[-_]+/g, " ").split(" ").filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** The same declared organization projection for local and restored team packages. */
export function buildLocalTeamOrgChart(
  agentId: string, slug: string, divisions?: ResolvedOrg["divisions"],
  scanMembers?: ScanMember[], departments: string[] = [],
): Array<FirmOrgNode & { agentId: string }> {
  let orgChart: Array<FirmOrgNode & { agentId: string }>;
  if (divisions && divisions.length > 0) {
    orgChart = [{ agentSlug: slug, agentId, role: "CEO", reportsTo: null }];
    for (const d of divisions) {
      const dSlug = `${slug}-${d.id}`;
      orgChart.push({ agentSlug: dSlug, agentId: "", role: d.role || d.name, reportsTo: slug });
      for (const s of d.specialists ?? []) {
        orgChart.push({ agentSlug: `${dSlug}-${s.id}`, agentId: "", role: s.role || s.name, reportsTo: dSlug });
      }
    }
  } else if (scanMembers && scanMembers.length > 0) {
    // 결정적 스캐너가 찾은 구성원 — LLM 없이도 조직도에 구성원이 반드시 들어간다.
    orgChart = [
      { agentSlug: slug, agentId, role: "CEO", reportsTo: null },
      ...scanMembers.map((m) => ({ agentSlug: `${slug}-${m.id}`, agentId: "", role: m.role || m.name, reportsTo: slug })),
    ];
  } else {
    const depts = departments;
    orgChart = [
      { agentSlug: slug, agentId, role: "CEO", reportsTo: null },
      ...depts.map((d) => ({ agentSlug: `${slug}-${d}`, agentId: "", role: deptLabel(d), reportsTo: slug })),
    ];
  }
  return orgChart;
}
