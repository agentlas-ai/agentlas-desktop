// Firm CRUD — 설치된 회사 레지스트리. 다국어(name_en, tagline_en) 지원.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { installAgent, getAgentById, uninstallAgent } from "../mcp/registry";
import { getSource as getMarketSource } from "../marketplace";
import type { FirmOrgNode, InstalledFirm } from "../../shared/types";

interface FirmRow {
  id: string;
  slug: string;
  name: string;
  name_en: string;
  tagline: string;
  tagline_en: string;
  persona: string;
  ceo_agent_id: string;
  org_chart_json: string;
  installed_at: string;
}

function toFirm(row: FirmRow): InstalledFirm {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameEn: row.name_en || row.name,
    tagline: row.tagline,
    taglineEn: row.tagline_en || row.tagline,
    persona: row.persona,
    ceoAgentId: row.ceo_agent_id,
    orgChart: JSON.parse(row.org_chart_json) as Array<FirmOrgNode & { agentId: string }>,
    installedAt: row.installed_at,
  };
}

export function listFirms(): InstalledFirm[] {
  const rows = getDb()
    .prepare("SELECT * FROM firms ORDER BY installed_at DESC")
    .all() as FirmRow[];
  return rows.map(toFirm);
}

export function getFirm(id: string): InstalledFirm | null {
  const row = getDb()
    .prepare("SELECT * FROM firms WHERE id = ?")
    .get(id) as FirmRow | undefined;
  return row ? toFirm(row) : null;
}

export function getFirmBySlug(slug: string): InstalledFirm | null {
  const row = getDb()
    .prepare("SELECT * FROM firms WHERE slug = ?")
    .get(slug) as FirmRow | undefined;
  return row ? toFirm(row) : null;
}

export async function installFirm(slug: string): Promise<InstalledFirm> {
  const seed = await getMarketSource().getFirmBySlug(slug);
  if (!seed) throw new Error(`Unknown firm slug: ${slug}`);

  const existing = getFirmBySlug(slug);
  if (existing) return existing;

  const slugToAgentId: Record<string, string> = {};
  for (const agentSlug of seed.agentSlugs) {
    const agent = await installAgent(agentSlug);
    slugToAgentId[agentSlug] = agent.id;
  }

  const resolvedChart: Array<FirmOrgNode & { agentId: string }> = seed.orgChart.map(
    (node) => {
      const agentId = slugToAgentId[node.agentSlug];
      if (!agentId)
        throw new Error(`Firm ${slug}의 orgChart에서 slug ${node.agentSlug}가 의존 목록에 없습니다`);
      return { ...node, agentId };
    },
  );

  const ceoAgentId = slugToAgentId[seed.ceoSlug];
  if (!ceoAgentId)
    throw new Error(`Firm ${slug}의 CEO slug ${seed.ceoSlug}가 의존 목록에 없습니다`);

  const id = randomUUID();
  const installedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO firms (id, slug, name, name_en, tagline, tagline_en, persona,
                          ceo_agent_id, org_chart_json, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      slug,
      seed.name,
      seed.nameEn,
      seed.tagline,
      seed.taglineEn,
      seed.persona,
      ceoAgentId,
      JSON.stringify(resolvedChart),
      installedAt,
    );

  if (!getAgentById(ceoAgentId)) {
    throw new Error("CEO 에이전트 설치 후 조회 실패 (registry inconsistency)");
  }

  return getFirm(id) as InstalledFirm;
}

export function uninstallFirm(id: string): void {
  const db = getDb();
  const firm = getFirm(id);
  if (firm) {
    // 조직을 지우면 이 조직에만 속한 멤버 에이전트 행(루트 + 하위)까지 정리한다.
    // 예전엔 firm 행만 지워서 멤버 에이전트가 좀비로 남아 "팀 에이전트"로 오표시됐다.
    // 다른 조직/조합에서도 참조되거나 builtin(아키텍처) 에이전트는 보존한다.
    const referencedElsewhere = new Set<string>();
    for (const row of db.prepare("SELECT org_chart_json FROM firms WHERE id != ?").all(id) as Array<{
      org_chart_json: string;
    }>) {
      try {
        for (const node of JSON.parse(row.org_chart_json) as Array<{ agentId: string }>) {
          referencedElsewhere.add(node.agentId);
        }
      } catch {
        /* 손상된 orgChart는 무시 */
      }
    }
    for (const row of db.prepare("SELECT members_json FROM agent_groups").all() as Array<{
      members_json: string;
    }>) {
      try {
        for (const member of JSON.parse(row.members_json) as Array<{ agentId?: string }>) {
          if (member.agentId) referencedElsewhere.add(member.agentId);
        }
      } catch {
        /* 무시 */
      }
    }
    for (const node of firm.orgChart) {
      if (referencedElsewhere.has(node.agentId)) continue;
      const meta = db
        .prepare("SELECT builtin FROM installed_agents WHERE id = ?")
        .get(node.agentId) as { builtin: number } | undefined;
      if (meta?.builtin === 1) continue; // 아키텍처 에이전트는 보존(시드가 재생성)
      uninstallAgent(node.agentId); // 행 + 로컬 route 정리 (원본 폴더는 안 건드림)
    }
  }
  db.prepare("DELETE FROM firms WHERE id = ?").run(id);
}

/**
 * 로컬에서 임포트한 "팀" 폴더를 회사(firm)로 등록 — slug 기준 멱등.
 * 마켓 설치(installFirm)와 달리 의존 에이전트를 따로 설치하지 않는다(CEO = 임포트된 팀 에이전트,
 * 부서 노드는 정보용). 같은 폴더를 다시 임포트하면 기존 firm을 갱신한다.
 */
export function upsertLocalTeamFirm(input: {
  slug: string;
  name: string;
  nameEn?: string;
  tagline: string;
  persona?: string;
  ceoAgentId: string;
  orgChart: Array<FirmOrgNode & { agentId: string }>;
}): InstalledFirm {
  const existing = getFirmBySlug(input.slug);
  const chartJson = JSON.stringify(input.orgChart);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE firms SET name = ?, name_en = ?, tagline = ?, tagline_en = ?, persona = ?,
                          ceo_agent_id = ?, org_chart_json = ? WHERE id = ?`,
      )
      .run(
        input.name,
        input.nameEn ?? input.name,
        input.tagline,
        input.tagline,
        input.persona ?? "",
        input.ceoAgentId,
        chartJson,
        existing.id,
      );
    return getFirm(existing.id) as InstalledFirm;
  }
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO firms (id, slug, name, name_en, tagline, tagline_en, persona,
                          ceo_agent_id, org_chart_json, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.slug,
      input.name,
      input.nameEn ?? input.name,
      input.tagline,
      input.tagline,
      input.persona ?? "",
      input.ceoAgentId,
      chartJson,
      new Date().toISOString(),
    );
  return getFirm(id) as InstalledFirm;
}
