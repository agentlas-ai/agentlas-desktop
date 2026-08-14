// Firm CRUD — 설치된 회사 레지스트리. 다국어(name_en, tagline_en) 지원.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import { installAgent, getAgentById, uninstallAgent } from "../mcp/registry";
import { getSource as getMarketSource } from "../marketplace";
import type { FirmOrgNode, InstalledFirm } from "../../shared/types";
import { materializeTeamMemberCells } from "./team-member-cells";
import { dedupeLocalInstalledAgents } from "./agent-dedupe";

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
  try {
    // Agent and firm lists can be requested in parallel by the dashboard. Run
    // the same idempotent local-repair gate here too, so a stale firm snapshot
    // cannot expose duplicate organizations when the agent list wins the race.
    dedupeLocalInstalledAgents();
  } catch (error) {
    console.error("[firms] local duplicate repair failed", error);
  }
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

  const firm = getFirm(id) as InstalledFirm;
  emitDesktopStoreChange({ entity: "firm", id });
  return firm;
}

export function uninstallFirm(id: string): void {
  const db = getDb();
  // UI contract: removing a firm removes only the organization relationship.
  // Its installed agents and every conversation remain user-owned. The
  // chats.firm_id FK detaches former firm chats with ON DELETE SET NULL.
  db.transaction(() => {
    const before = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM installed_agents) AS agents,
           (SELECT COUNT(*) FROM chats) AS chats,
           (SELECT COUNT(*) FROM chat_messages) AS messages`,
      )
      .get() as { agents: number; chats: number; messages: number };
    db.prepare("DELETE FROM firms WHERE id = ?").run(id);
    const after = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM installed_agents) AS agents,
           (SELECT COUNT(*) FROM chats) AS chats,
           (SELECT COUNT(*) FROM chat_messages) AS messages`,
      )
      .get() as { agents: number; chats: number; messages: number };
    if (
      after.agents !== before.agents ||
      after.chats !== before.chats ||
      after.messages !== before.messages
    ) {
      throw new Error("Firm removal tried to delete an installed agent or conversation; rolled back.");
    }
  })();
  emitDesktopStoreChange({ entity: "firm", id });
  // ON DELETE SET NULL changes the projected target of former firm chats.
  emitDesktopStoreChange({ entity: "chat" });
}

/**
 * Organization-chart removal. The old uninstallFirm contract intentionally
 * removed only the relationship; the visible X action is an explicit stronger
 * operation that also removes materialized member rows. Conversations and
 * project references follow their existing SQLite FK contracts.
 */
export function removeFirmFromRoster(id: string): { removedAgentIds: string[]; retainedAgentIds: string[] } {
  const firm = getFirm(id);
  if (!firm) return { removedAgentIds: [], retainedAgentIds: [] };
  const db = getDb();
  const agentIds = [...new Set([firm.ceoAgentId, ...firm.orgChart.map((node) => node.agentId)].filter(Boolean))];
  uninstallFirm(id);
  const removedAgentIds: string[] = [];
  const retainedAgentIds: string[] = [];

  const remainingFirmForAgent = (agentId: string): string | null => {
    const rows = db
      .prepare("SELECT id, ceo_agent_id, org_chart_json FROM firms")
      .all() as Array<{ id: string; ceo_agent_id: string; org_chart_json: string }>;
    for (const row of rows) {
      if (row.ceo_agent_id === agentId) return row.id;
      try {
        const chart = JSON.parse(row.org_chart_json) as Array<{ agentId?: string }>;
        if (chart.some((node) => node.agentId === agentId)) return row.id;
      } catch {
        // A malformed unrelated firm must not prevent the selected team from
        // being removed; the normal firm read path already reports that data.
      }
    }
    return null;
  };

  for (const agentId of agentIds) {
    try {
      uninstallAgent(agentId);
      removedAgentIds.push(agentId);
    } catch (error) {
      const remainingFirmId = remainingFirmForAgent(agentId);
      if (!remainingFirmId) throw error;
      // A shared agent can still belong to another installed firm. Keep it
      // installed and move its materialized ownership pointer to the firm
      // that still owns it; leaving the deleted firm id here makes the agent
      // disappear from the surviving team's roster and misroutes memory.
      db.prepare("UPDATE installed_agents SET parent_team_id = ? WHERE id = ?")
        .run(remainingFirmId, agentId);
      emitDesktopStoreChange({ entity: "agent", id: agentId });
      retainedAgentIds.push(agentId);
    }
  }
  return { removedAgentIds, retainedAgentIds };
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
  const db = getDb();
  const existing = getFirmBySlug(input.slug);
  const id = existing?.id ?? randomUUID();
  const installedAt = existing?.installedAt ?? new Date().toISOString();
  const commit = db.transaction(() => {
    const orgChart = materializeTeamMemberCells(db, {
      firmId: id,
      firmSlug: input.slug,
      ceoAgentId: input.ceoAgentId,
      installedAt,
      orgChart: input.orgChart,
    });
    const chartJson = JSON.stringify(orgChart);
    if (existing) {
      db.prepare(
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
      return;
    }
    db.prepare(
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
        installedAt,
      );
  });
  commit();
  if (existing) {
    const firm = getFirm(existing.id) as InstalledFirm;
    emitDesktopStoreChange({ entity: "firm", id: existing.id });
    return firm;
  }
  const firm = getFirm(id) as InstalledFirm;
  emitDesktopStoreChange({ entity: "firm", id });
  return firm;
}
